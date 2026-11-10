/**
 * surface 链路图(chain):把「按类别的命中行清单」升级成「节点 + 上下游边 + 建议改动顺序」。
 * 解决什么:清单只回答「这个词出现在哪」,不回答「谁牵动谁、先改哪个、改完这块会不会顺手
 * 漏掉下游」。全链路一致性靠三类确定性边:
 *   flow   同文件跨类别命中按层序串成流——改 protocol 必然牵动 journal/config;
 *   verify tests/docs 与它覆盖的源码连边——改完源码必须回改测试与文档;
 *   call   symbol 命中经静态索引挂上真实调用链——upstream=谁调用它 / downstream=它调用谁。
 * 另有一类 consumes:源码行里出现资源/部署/i18n 文件名 → 「谁在引用这个落点」
 * (删 dh-video.mp4 时,内容通道只看到文件名命中,看不到引用方)。
 * 确定性纪律:
 *  - 边全部由确定性规则生成(同文件层序、路径 stem、静态索引查询),不为「图好看」编造边;
 *  - 两跑完全一致:节点/边/order 全按稳定键排序,不含时间与随机;
 *  - 索引缺失/过期/查询异常 → 不抛错,降级为字面量层并把原因写进 knownLimits(不静默)。
 */
import { loadIndexAsync, querySymbol, indexStale, samplingNote } from "../callgraph/c2f.js";
import type { C2fIndex } from "../callgraph/c2f.js";
import { IMPACT_DEFAULT_DEPTH, queryImpact } from "../callgraph/impact.js";
import { classifySurfaceHit } from "./index.js";
import type { SurfaceCategory, SurfaceHit, SurfaceReport } from "./index.js";

/**
 * 改动依赖顺序(与 SURFACE_CATEGORIES 同源,空层不输出)。
 * 顺序理由:定义与数据源头在前(protocol/db/journal/config),代码在中,资源与部署在外围,
 * 测试与文档最后——回改测试与文档的前提是源码已定稿。
 */
export const SURFACE_LAYER_ORDER: readonly SurfaceCategory[] = [
  "protocol", "db", "journal", "config", "symbol", "ui", "assets", "deploy", "i18n", "tests", "docs",
];

export interface SurfaceChainNode {
  /** 复用 SurfaceHit.id(字面量层)或索引节点 id(调用链层),两跑稳定。 */
  id: string;
  category: SurfaceCategory;
  file: string;
  line?: number;
  label: string;
  concept: string;
  via?: "literal" | "impact";
}

export interface SurfaceChainEdge {
  from: string;
  to: string;
  kind: "flow" | "call" | "verify" | "consumes";
  label?: string;
}

export interface SurfaceChainMap {
  root: string;
  /**
   * 本次扫描的输入概念(与 SurfaceReport.concepts 同序同源)。
   * 为什么放在这:零命中时 nodes 为空,标题若只从 nodes 反推就丢掉「扫的是哪个词」;
   * 链路图必须能自证扫描口径,供 agent 核对。
   */
  concepts: string[];
  layers: { category: SurfaceCategory; hits: number; files: string[] }[];
  nodes: SurfaceChainNode[];
  edges: SurfaceChainEdge[];
  /** 建议改动顺序(层序展开,同层 file:line;同样输入两跑逐字一致)。 */
  order: string[];
  stats: { layers: number; nodes: number; edges: number; impactNodes: number; withCallChain: boolean };
  knownLimits: string[];
}

const EDGE_KIND_ORDER: Record<SurfaceChainEdge["kind"], number> = { flow: 0, call: 1, verify: 2, consumes: 3 };
/** 边总量上限:图是给人读的,超量级说明概念太泛;截断如实写进 knownLimits。 */
const MAX_EDGES = 800;
/** consumes 只在文件名足够长时才认(短名误伤面大于收益)。 */
const CONSUMES_MIN_NAME = 4;

function toPosix(p: string): string {
  return (p ?? "").split("\\").join("/");
}

function shortFile(file: string): string {
  const parts = toPosix(file).split("/");
  return parts[parts.length - 1] ?? "";
}

function compact(text: string, max = 48): string {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** 节点标题:`短文件名:行 + 命中文本截断`;路径名命中(line=0)没有正文,如实写「路径名命中」。 */
function labelOf(file: string, line: number | undefined, text: string): string {
  const base = shortFile(file) || toPosix(file);
  if (!line) return `${base} — 路径名命中`;
  const body = compact(text);
  return body ? `${base}:${line} ${body}` : `${base}:${line}`;
}

function layerIndex(category: SurfaceCategory): number {
  const i = SURFACE_LAYER_ORDER.indexOf(category);
  return i < 0 ? SURFACE_LAYER_ORDER.length : i;
}

/** 源码 stem(去掉扩展名与 .test/.spec 中缀):verify 边按它配对测试与源码。 */
function stemOf(file: string): string {
  const base = shortFile(file).toLowerCase();
  const noExt = base.replace(/\.[^.]+$/, "");
  return noExt.replace(/\.(test|spec|e2e|stories|bench)$/i, "");
}

/** 字面量层节点:直接来自 SurfaceHit(不改写 id,审计仍能按 id 对账)。 */
function literalNode(h: SurfaceHit): SurfaceChainNode {
  return {
    id: h.id,
    category: h.category,
    file: h.file,
    ...(h.line > 0 ? { line: h.line } : {}),
    label: labelOf(h.file, h.line, h.text),
    concept: h.concept,
    via: "literal",
  };
}

/** 索引节点 → 链路节点。文件为空(模块级虚调用方 `path#<module>` 之类)的引用不入图:
 *  没有文件就没有改动落点,画上去只会误导。 */
function impactNode(id: string, name: string, file: string, line: number, concept: string): SurfaceChainNode | null {
  if (!file) return null;
  const category = classifySurfaceHit(file, "");
  return {
    id,
    category,
    file,
    ...(line > 0 ? { line } : {}),
    label: labelOf(file, line, name),
    concept,
    via: "impact",
  };
}

interface CallChainResult {
  nodes: SurfaceChainNode[];
  edges: SurfaceChainEdge[];
  limits: string[];
  /** 成功取到真实调用链节点(仅此时 stats.withCallChain 才为 true)。 */
  ok: boolean;
}

/**
 * 调用链通道:concept 能当符号名查到定义时,用 queryImpact 的 definitions[].callers/callees
 * 作为 upstream/downstream 边。
 * 为什么用 callers/callees 而不是 files[]:ImpactFileRef 只有 viaCall/viaImport/minDepth,
 * 没有方向信息,拿它标上下游就是编造方向。
 */
async function callChain(root: string, hits: SurfaceHit[], concepts: string[], depth: number): Promise<CallChainResult> {
  const nodes = new Map<string, SurfaceChainNode>();
  const edges: SurfaceChainEdge[] = [];
  const limits: string[] = [];
  let index: C2fIndex | null = null;
  try {
    index = await loadIndexAsync(root);
  } catch (err) {
    limits.push(`未含调用链:索引读取失败(${err instanceof Error ? err.message : String(err)}),只有字面量层`);
    return { nodes: [], edges, limits, ok: false };
  }
  if (!index) {
    limits.push("未含调用链:索引不可用(先 codesense index 构建),只有字面量层");
    return { nodes: [], edges, limits, ok: false };
  }
  if (indexStale(root, index)) {
    limits.push("索引可能过期(indexStale):新改动里的调用关系可能不在图上,零调用方不得当作可删依据。");
  }
  const sampled = samplingNote(index);
  if (sampled) limits.push(`调用链基于${sampled}:符号计数与覆盖口径不同,只作方向参考。`);

  // 候选符号名 = symbol 类命中的 concept ∪ 用户 concept 本身。
  // 为什么并上后者:字面量通道只收引号串/对象键/宏等语境,源码里的裸标识符
  // (`function foo(` / 调用 `foo()`)不产 symbol 行——只靠命中行永远拿不到调用链,
  // 而「重命名这个函数」恰恰最需要 upstream/downstream。
  const names = new Set<string>();
  for (const h of hits) {
    if (h.category !== "symbol" || !h.concept) continue;
    for (const part of h.concept.split(",")) names.add(part.trim());
  }
  for (const c of concepts) names.add(c.trim());
  const candidates = [...names]
    .filter((n) => /^[A-Za-z_$][\w$.]*$/.test(n))
    .sort();

  let droppedRefs = 0;
  let impactTruncated = false;
  for (const name of candidates) {
    let impact;
    try {
      if (querySymbol(index, name).length === 0) continue;
      impact = queryImpact(index, name, { depth });
    } catch {
      limits.push(`调用链查询失败(${name}):该符号降级为字面量节点,不上调用边。`);
      continue;
    }
    if (impact.truncated) impactTruncated = true;
    for (const def of impact.definitions) {
      // 锚点=定义节点本身:边挂到真实索引 id 才能保证不悬空(挂了 concept:<name>
      // 这种虚拟 id,边就指向图里不存在的节点,渲染出来两端对不上)。
      const anchor = impactNode(def.symbol.id, def.symbol.name, def.symbol.file, def.symbol.line, name);
      if (!anchor) continue;
      nodes.set(anchor.id, anchor);
      for (const ref of def.callers) {
        const n = impactNode(ref.id, ref.name, ref.file, ref.line, name);
        if (!n) { droppedRefs++; continue; }
        nodes.set(n.id, n);
        edges.push({ from: n.id, to: anchor.id, kind: "call", label: "upstream" });
      }
      for (const ref of def.callees) {
        const n = impactNode(ref.id, ref.name, ref.file, ref.line, name);
        if (!n) { droppedRefs++; continue; }
        nodes.set(n.id, n);
        edges.push({ from: anchor.id, to: n.id, kind: "call", label: "downstream" });
      }
    }
  }
  if (impactTruncated) {
    limits.push(`调用链按 depth=${depth} 截断(深层每层封顶),更外围的调用方未入图。`);
  }
  if (droppedRefs > 0) {
    limits.push(`有 ${droppedRefs} 条索引引用无文件落点(模块级虚调用方),未入图。`);
  }
  if (nodes.size === 0) {
    limits.push("未含调用链:命中概念都不是可查的符号名(或索引里无定义),只有字面量层");
  }
  return { nodes: [...nodes.values()], edges, limits, ok: nodes.size > 0 };
}

/**
 * 构建链路图。纯读:不动文件、不调 LLM。
 * opts.depth 传给 queryImpact(缺省 2,与 impact 命令同口径)。
 */
export async function buildSurfaceChainMap(
  root: string,
  report: SurfaceReport,
  opts: { depth?: number } = {},
): Promise<SurfaceChainMap> {
  const depth = Math.max(1, Math.floor(opts.depth ?? IMPACT_DEFAULT_DEPTH));
  const limits: string[] = [];
  const hits = report.hits;

  if (hits.length === 0) {
    limits.push("零命中:没有节点可连(概念未出现或被排除目录过滤,先确认扫描口径)。");
    return {
      root, concepts: [...report.concepts], layers: [], nodes: [], edges: [], order: [],
      stats: { layers: 0, nodes: 0, edges: 0, impactNodes: 0, withCallChain: false },
      knownLimits: limits,
    };
  }

  // ---- 层分组(按改动依赖顺序,空层不输出) ----
  const layerFiles = new Map<SurfaceCategory, Set<string>>();
  const layerHits = new Map<SurfaceCategory, number>();
  for (const h of hits) {
    const files = layerFiles.get(h.category) ?? new Set<string>();
    files.add(h.file);
    layerFiles.set(h.category, files);
    layerHits.set(h.category, (layerHits.get(h.category) ?? 0) + 1);
  }
  const layers = SURFACE_LAYER_ORDER
    .filter((c) => (layerHits.get(c) ?? 0) > 0)
    .map((c) => ({ category: c, hits: layerHits.get(c) ?? 0, files: [...(layerFiles.get(c) ?? [])].sort() }));
  // 层序外的类别(理论上不存在)不静默丢:补在末尾并注明。
  const unknown = [...layerHits.keys()].filter((c) => !SURFACE_LAYER_ORDER.includes(c)).sort();
  for (const c of unknown) {
    layers.push({ category: c, hits: layerHits.get(c) ?? 0, files: [...(layerFiles.get(c) ?? [])].sort() });
    limits.push(`类别 ${c} 不在缺省层序里,已按末位层输出(层序表需补)。`);
  }

  const nodes = new Map<string, SurfaceChainNode>();
  for (const h of hits) nodes.set(h.id, literalNode(h));

  const edges: SurfaceChainEdge[] = [];
  const seenEdge = new Set<string>();
  const addEdge = (from: string, to: string, kind: SurfaceChainEdge["kind"], label?: string): void => {
    if (!from || !to || from === to) return;
    const key = `${kind}|${from}|${to}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push(label ? { from, to, kind, label } : { from, to, kind });
  };

  // ---- a. 同文件跨类别 flow 边(按层序:层序在前的先改,连向后者) ----
  const byFile = new Map<string, SurfaceHit[]>();
  for (const h of hits) {
    const list = byFile.get(h.file) ?? [];
    list.push(h);
    byFile.set(h.file, list);
  }
  for (const file of [...byFile.keys()].sort()) {
    const sorted = [...byFile.get(file)!].sort((a, b) =>
      layerIndex(a.category) - layerIndex(b.category)
      || a.line - b.line
      || a.id.localeCompare(b.id));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (prev.category === cur.category) continue;
      addEdge(prev.id, cur.id, "flow", cur.category);
    }
  }

  // ---- b. tests/docs → 源码 verify 边(路径 stem 相等或文件名互相包含) ----
  const verifyCandidates = hits.filter((h) => h.category === "tests" || h.category === "docs");
  const sourceHits = hits.filter((h) => h.category !== "tests" && h.category !== "docs" && h.category !== "assets");
  for (const t of verifyCandidates) {
    const ts = stemOf(t.file);
    if (!ts) continue;
    for (const s of sourceHits) {
      if (s.file === t.file) continue;
      const ss = stemOf(s.file);
      if (!ss) continue;
      const matched = ts === ss
        || (ts.length >= 4 && ss.includes(ts))
        || (ss.length >= 4 && ts.includes(ss));
      if (matched) addEdge(t.id, s.id, "verify", "covers");
    }
  }

  // ---- c. 调用链边(静态索引;失败/缺索引降级,不抛错) ----
  const chain = await callChain(root, hits, report.concepts, depth);
  for (const n of chain.nodes) {
    // 索引节点标题占位:同名索引节点可能被多次产生,后到不覆盖已入图(确定性)。
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  }
  for (const e of chain.edges) addEdge(e.from, e.to, e.kind, e.label);
  limits.push(...chain.limits);

  // ---- d. consumes:源码行里出现资源/部署/i18n 文件名 → 谁在引用它 ----
  const pathNodes = hits.filter((h) => h.line === 0 && (h.category === "assets" || h.category === "deploy" || h.category === "i18n"));
  for (const p of pathNodes) {
    const name = shortFile(p.file).toLowerCase();
    if (name.length < CONSUMES_MIN_NAME) continue;
    for (const h of hits) {
      if (h.id === p.id) continue;
      if (!h.text.toLowerCase().includes(name)) continue;
      addEdge(h.id, p.id, "consumes", "引用");
    }
  }

  // ---- 稳定排序 + 截断 ----
  const nodeList = [...nodes.values()].sort((a, b) =>
    layerIndex(a.category) - layerIndex(b.category)
    || a.file.localeCompare(b.file)
    || (a.line ?? 0) - (b.line ?? 0)
    || a.id.localeCompare(b.id));
  edges.sort((a, b) =>
    EDGE_KIND_ORDER[a.kind] - EDGE_KIND_ORDER[b.kind]
    || a.from.localeCompare(b.from)
    || a.to.localeCompare(b.to));
  let keptEdges = edges;
  if (edges.length > MAX_EDGES) {
    keptEdges = edges.slice(0, MAX_EDGES);
    limits.push(`边总数 ${edges.length} 超上限,已截断到 ${MAX_EDGES}(概念过泛时先收窄词表)。`);
  }

  const impactNodes = nodeList.filter((n) => n.via === "impact").length;
  limits.push(
    "flow 边只连同文件内的跨类别命中:跨文件的「改 A 必改 B」没有静态依据,本图不猜。",
    "verify 边按路径 stem 配对(相等或文件名互相包含),命名不规范的测试配对不上。",
    "consumes 边只认「行文本里出现文件名」,经变量拼接出的资源路径不识别。",
  );
  if (report.truncated) limits.push("扫描已截断(命中达上限),链路图只覆盖截断后的命中集。");
  if (report.knownLimits.length > 0) limits.push(...report.knownLimits);

  return {
    root,
    concepts: [...report.concepts],
    layers,
    nodes: nodeList,
    edges: keptEdges,
    order: nodeList.map((n) => n.id),
    stats: {
      layers: layers.length,
      nodes: nodeList.length,
      edges: keptEdges.length,
      impactNodes,
      withCallChain: chain.ok,
    },
    knownLimits: limits,
  };
}

/** markdown 渲染:分层表 + 建议改动顺序 + 边清单(按 kind 分组)+ 已知边界。给 agent 直接读。 */
export function renderSurfaceChainMarkdown(map: SurfaceChainMap): string {
  const lines: string[] = [];
  const declared = (map.concepts ?? []).filter(Boolean);
  const concepts = declared.length > 0
    ? declared
    : [...new Set(map.nodes.map((n) => n.concept).filter(Boolean))];
  lines.push(`### 概念链路图 chain — ${concepts.join(", ") || "(无 concept)"}`);
  lines.push("");
  lines.push(`root: ${map.root}`);
  lines.push(
    `层 ${map.stats.layers} / 节点 ${map.stats.nodes}(调用链节点 ${map.stats.impactNodes}) / 边 ${map.stats.edges}`
    + ` · 调用链: ${map.stats.withCallChain ? "有" : "无(降级为字面量层,见已知边界)"}`,
  );
  if (map.nodes.length === 0) {
    lines.push("");
    lines.push(`(零节点:概念「${concepts.join(", ") || "(无 concept)"}」未出现或被过滤;见已知边界)`);
  } else {
    lines.push("");
    lines.push("分层(改动依赖顺序,空层不输出):");
    lines.push("| 层 | 命中 | 文件 |");
    lines.push("| --- | --- | --- |");
    for (const l of map.layers) {
      const files = l.files.slice(0, 4).join(", ") + (l.files.length > 4 ? ` …(+${l.files.length - 4})` : "");
      lines.push(`| ${l.category} | ${l.hits} | ${files} |`);
    }

    const byId = new Map(map.nodes.map((n) => [n.id, n]));
    lines.push("");
    lines.push(`建议改动顺序(${map.order.length} 步,层序展开,同层按 file:line):`);
    map.order.forEach((id, i) => {
      const n = byId.get(id);
      if (!n) return;
      lines.push(`${i + 1}. [${n.category}] ${n.file}${n.line ? `:${n.line}` : ""} — ${n.label}`);
    });

    lines.push("");
    lines.push("边清单:");
    if (map.edges.length === 0) {
      lines.push("- (无确定性边:同文件无跨类别命中、测试未按 stem 配对、索引未提供调用链)");
    } else {
      for (const kind of ["flow", "call", "verify", "consumes"] as const) {
        const group = map.edges.filter((e) => e.kind === kind);
        if (group.length === 0) continue;
        lines.push(`${kind} ${group.length}:`);
        for (const e of group) {
          const from = byId.get(e.from)?.label ?? e.from;
          const to = byId.get(e.to)?.label ?? e.to;
          lines.push(`- ${from} → ${to}${e.label ? ` :${e.label}` : ""}`);
        }
      }
    }
  }
  if (map.knownLimits.length > 0) {
    lines.push("");
    lines.push("已知边界:");
    for (const l of map.knownLimits) lines.push(`- ${l}`);
  }
  return lines.join("\n");
}
