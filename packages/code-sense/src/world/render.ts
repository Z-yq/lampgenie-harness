/**
 * 世界模型渲染器:把静态调用索引(C2fIndex)预渲染成两层小产物——
 * L0(全局骨架,≤2560B)+ L1(每模块一页,≤1024B),供 agent 开工注入。
 * 为什么:「项目世界模型」是开工第一阶段该看到的东西,但它不能是又一份
 * 需要 LLM 现生成的长文——确定性数据(索引)已经全在,缺的是**压缩且不撒谎**的渲染面。
 * 纪律:
 * - 纯渲染,零 LLM、零落盘、零 CLI(落盘/命令面在 code-sense-cli,父层负责);
 * - 确定性硬要求:同一 idx 两次渲染逐字节相同——唯一时间源 = idx.builtAt;
 * 排序一律带名字兜底比较(不用 localeCompare,避免 ICU 环境差异),行尾无空格;
 * - 绝不静默截断:任何裁剪都写显式 `…(+N)` / `超预算` 注记。
 * 数据来源(全是既有确定性面,不新造语义):
 * - 分组/交互/枢纽:callgraph/modview(buildModuleView + moduleGroupOf);
 * - 模块一句话职责:callgraph/module-notes(package.json → README → docstring → 名称/拓扑推断);
 * - 入口:callgraph/c2f(queryEntryPointsMeta);
 * - purpose:project-profile 的盘上画像(缺席=如实写 `(未生成)`,不编造)。
 */
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { C2fIndex, C2fNode } from "../callgraph/c2f.js";
import { queryEntryPointsMeta } from "../callgraph/c2f.js";
import { buildModuleView, moduleGroupOf, type ModuleInfo, type ModuleView } from "../callgraph/modview.js";
import { moduleAnnotationText, moduleNotes, MODULE_NOTE_SOURCE_LABEL, type ModuleNote } from "../callgraph/module-notes.js";
import type { CodeFlow } from "../callgraph/flow.js";
import { loadProjectProfile } from "../project-profile.js";

/** L0 骨架硬预算(字节,UTF-8)。
 * 经验证校准:2560B 装不下 21 个模块行 + 入口/枢纽,超预算时 renderWithBudget 会整节
 * 回滚,导致 L0 只剩「主线 + 模块清单」——入口 trunk 与枢纽这两条最有用的一屏信息全被丢。
 * 改为 4096B(≈1.0–1.6K token),并压小各节条数(入口 12/枢纽 6/模块行 16),
 * 让「模块/入口/枢纽/分层」四节都能活下来;总量仍受 L0+L1 ≤6K token 口径约束。 */
export const WORLD_L0_MAX_BYTES = 4096;
/** L1 单模块页硬预算(字节,UTF-8)。 */
export const WORLD_L1_PAGE_MAX_BYTES = 1024;

export interface WorldRenderOptions {
 /** 入口 trunk 展示条数(缺省 20)。 */
  entryLimit?: number;
 /** 枢纽展示条数(缺省 10)。 */
  hubLimit?: number;
 /** L1 关键文件条数(缺省 5)。 */
  topFiles?: number;
 /** L1 对外符号条数(缺省 12)。 */
  exportLimit?: number;
 /** L0 字节预算(缺省 WORLD_L0_MAX_BYTES)。 */
  maxBytes?: number;
 /** L1 单页字节预算(缺省 WORLD_L1_PAGE_MAX_BYTES)。 */
  pageMaxBytes?: number;
}

const DEFAULT_ENTRY_LIMIT = 12;
const DEFAULT_HUB_LIMIT = 6;
const DEFAULT_TOP_FILES = 5;
const DEFAULT_EXPORT_LIMIT = 12;
/** L0 模块清单行上限(超出即写 `…(+N 模块,…)` 下钻提示;不静默消失)。 */
const MODULE_LINE_CAP = 16;
/** L0 交互主干行上限。 */
const INTERACTION_LINE_CAP = 12;

/** 码元序比较(确定性与 ICU/locale 无关——localeCompare 依环境,渲染要求逐字节复现)。 */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** 唯一时间源 = idx.builtAt(缺省/非法=unknown,不取 now)。 */
function isoOf(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "unknown";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toISOString();
}

function sum(values: Iterable<number>): number {
  let n = 0;
  for (const v of values) n += v;
  return n;
}

/** 单模块聚合面(L0 模块行 + L1 页面共用,避免两处口径漂移)。 */
interface ModAgg {
  name: string;
  files: Set<string>;
  nodes: C2fNode[];
 /** 本模块调用的其他模块 → 边数(下游)。 */
  out: Map<string, number>;
 /** 调用本模块的其他模块 → 边数(上游)。 */
  in: Map<string, number>;
}

interface WorldData {
  view: ModuleView;
  aggs: Map<string, ModAgg>;
 /** 模块清单顺序(文件数降序,同名兜底)——L0 与 L1 共用同一顺序。 */
  order: string[];
  notes: Record<string, ModuleNote>;
  totalFiles: number;
}

function collect(idx: C2fIndex): WorldData {
 // maxModules/maxEdges 拉到足够大:渲染器自己负责裁剪并如实注记,不在取数层被静默截断
  const view = buildModuleView(idx, { maxModules: 100_000, maxEdges: 100_000 });
  const aggs = new Map<string, ModAgg>();
  const ensure = (name: string): ModAgg => {
    let a = aggs.get(name);
    if (!a) {
      a = { name, files: new Set<string>(), nodes: [], out: new Map<string, number>(), in: new Map<string, number>() };
      aggs.set(name, a);
    }
    return a;
  };
  const fileToMod = new Map<string, string>();
  for (const n of idx.nodes) {
    const m = moduleGroupOf(n.file);
    fileToMod.set(n.file, m);
    const a = ensure(m);
    a.files.add(n.file);
    a.nodes.push(n);
  }
  for (const e of view.interactions) {
    if (e.from === e.to) continue;
    const from = ensure(e.from);
    from.out.set(e.to, (from.out.get(e.to) ?? 0) + e.count);
    const to = ensure(e.to);
    to.in.set(e.from, (to.in.get(e.from) ?? 0) + e.count);
  }
 // 只保留被边引用到、但索引里无节点的组(理论上不出现;防御性建组不留空指针)
  const mods = new Map<string, ModuleInfo>();
  for (const m of view.modules) mods.set(m.name, m);
  for (const name of aggs.keys()) if (!mods.has(name)) mods.set(name, { name, files: 0, langs: [] });

  const order = [...mods.keys()].sort((a, b) => {
    const fa = aggs.get(a)?.files.size ?? mods.get(a)!.files;
    const fb = aggs.get(b)?.files.size ?? mods.get(b)!.files;
    return fb - fa || cmpStr(a, b);
  });
  return {
    view,
    aggs,
    order,
    notes: buildNotes(idx, aggs, mods),
    totalFiles: new Set(idx.nodes.map((n) => n.file)).size,
  };
}

/** 一句职责:复用 module-notes 的来源优先级(package.json → README → docstring → 名称 → 拓扑)。 */
function buildNotes(idx: C2fIndex, aggs: Map<string, ModAgg>, mods: Map<string, ModuleInfo>): Record<string, ModuleNote> {
  const nodes = [...mods.keys()].map((name) => {
    const a = aggs.get(name);
    return {
      id: name,
      label: name,
      group: name,
      kind: "module",
      entry: (a?.in.size ?? 0) === 0 && (a?.out.size ?? 0) > 0,
      depth: 0,
      out: a?.out.size ?? 0,
      in: a?.in.size ?? 0,
      outCalls: a ? sum(a.out.values()) : 0,
      inCalls: a ? sum(a.in.values()) : 0,
      internalCalls: 0,
      unresolved: 0,
      files: a?.files.size ?? 0,
    };
  });
 // moduleNotes 只读 label/entry/in/out/outCalls,其余 FlowNode 字段补零即可(形状以 CodeFlow 为准)
  const flow = {
    level: "module",
    root: idx.root,
    direction: "lr",
    nodes,
    edges: [],
    groups: [],
    entries: [],
    notes: [],
    stats: {},
  } as unknown as CodeFlow;
  return moduleNotes(idx.root, flow);
}

/** purpose 面:盘上画像(project-profile)有则用,无则如实 `(未生成)`——绝不现生成、绝不编造。 */
function readPurpose(idx: C2fIndex): string[] {
  const loaded = loadProjectProfile(idx.root);
  if (!loaded) return [`- purpose: (未生成——无 .genie 项目画像;确定性骨架层不编造主旨)`];
  const s = loaded.profile.skeleton;
  const candidate =
    loaded.profile.llm?.purpose ??
    s.purposeCandidates.find((c) => c.source.includes("README") || c.text.startsWith("description="))?.text ??
    s.purposeCandidates[0]?.text;
  const lines: string[] = [];
  if (candidate?.trim()) {
    const src = loaded.profile.llm?.purpose ? "LLM 画像" : (s.purposeCandidates.find((c) => c.text === candidate)?.source ?? "画像");
    lines.push(`- purpose(${src}): ${candidate.trim()}`);
  } else {
    lines.push(`- purpose: (未生成——画像无产品级 purpose 候选)`);
  }
  const caps = loaded.profile.llm?.capabilities ?? [];
  if (caps.length > 0) lines.push(`- 主线能力: ${caps.slice(0, 3).join(";")}`);
  if (s.domain) lines.push(`- 领域(框架指纹): ${s.domain}`);
  if (loaded.stale) lines.push(`- ⚠️ 画像指纹与当前源码不一致(建议重建画像)`);
  return lines;
}

interface Section {
  title: string;
  lines: string[];
}

/**
 * 预算装配:按 section 优先级整块放下,放不下则逐行放,再放不下就记省略——
 * 最后追加一行 `…(超 NB 预算:…)`,任何裁剪都可见(绝不静默)。
 */
function renderWithBudget(head: string[], sections: Section[], maxBytes: number): string {
  const budget = typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : WORLD_L0_MAX_BYTES;
  const noteOf = (omitted: string[]): string => `…(超 ${budget}B 预算:${omitted.join(";")})`;
  const layout = (limit: number): { lines: string[]; omitted: string[] } => {
    const lines: string[] = [...head];
    const omitted: string[] = [];
    for (const sec of sections) {
      if (sec.lines.length === 0) continue;
      const block = ["", `## ${sec.title}`, ...sec.lines];
      if (byteLen([...lines, ...block].join("\n") + "\n") <= limit) {
        lines.push(...block);
        continue;
      }
      let placed = 0;
      for (const line of block) {
        if (byteLen([...lines, line].join("\n") + "\n") > limit) break;
        lines.push(line);
        placed++;
      }
      if (placed < block.length) {
 // 放得下标题却放不下一条内容=只剩空壳标题(读起来像「这节没有数据」)——回滚整节,
 // 由省略注记如实点名(有标题无正文比没有标题更误导)
        if (placed <= 2) {
          lines.length -= placed;
          placed = 0;
        }
        omitted.push(`${sec.title}省略 ${block.length - placed} 行`);
      }
    }
    return { lines, omitted };
  };

  let r = layout(budget);
  if (r.omitted.length === 0) return r.lines.join("\n") + "\n";
  for (let i = 0; i < 3; i++) {
    const reserve = byteLen(noteOf(r.omitted) + "\n");
    r = layout(budget - reserve);
  }
  if (r.omitted.length === 0) return r.lines.join("\n") + "\n";
  const out = [...r.lines, noteOf(r.omitted)];
 // 兜底:注记长度随省略清单微变,超了就丢尾部内容行(注记恒在场=不静默)
  while (byteLen(out.join("\n") + "\n") > budget && out.length > head.length + 1) {
    out.splice(out.length - 2, 1);
  }
  return out.join("\n") + "\n";
}

/** L0:全局骨架一页(头行 + purpose/主线 + 模块清单 + 入口 trunk + 枢纽 + 分层/热区)。 */
export function renderWorldSkeleton(idx: C2fIndex, opts: WorldRenderOptions = {}): string {
  const entryLimit = opts.entryLimit ?? DEFAULT_ENTRY_LIMIT;
  const hubLimit = opts.hubLimit ?? DEFAULT_HUB_LIMIT;
  const data = collect(idx);

  const head = [
    `<!-- world L0 · nodes=${idx.nodes.length} · edges=${idx.edges.length} · builtAt=${isoOf(idx.builtAt)} -->`,
    "# 项目世界 · L0 骨架",
  ];

 // ① 主线
  const overview: string[] = [
    ...readPurpose(idx),
    `- 规模: ${idx.nodes.length} 符号 / ${idx.edges.length} 调用边 / ${data.totalFiles} 文件 / ${data.order.length} 模块`,
  ];

 // ② 模块清单(每模块一行:名 — 一句职责 · 文件/节点数)
  const moduleLines: string[] = [];
  for (const name of data.order.slice(0, MODULE_LINE_CAP)) {
    const a = data.aggs.get(name);
    const note = data.notes[name];
    const duty = note ? moduleAnnotationText(note) : "≈ (无职责线索)";
    moduleLines.push(`- ${name} — ${duty}(文件 ${a?.files.size ?? 0} · 符号 ${a?.nodes.length ?? 0})`);
  }
  if (data.order.length > MODULE_LINE_CAP) {
    moduleLines.push(
      `…(+${data.order.length - MODULE_LINE_CAP} 模块,用 codesense world --module <name> 下钻)`,
    );
  }

 // ③ 入口 trunk
  const totalTrunk = idx.nodes.filter((n) => n.kind === "trunk").length;
  const ep = queryEntryPointsMeta(idx, entryLimit);
  const entryLines: string[] = [];
  if (ep.kept.length === 0) entryLines.push("- (无 trunk 入口:索引内所有符号都有调用方,或索引为空)");
  for (const n of ep.kept) {
    entryLines.push(`- ${n.file}:${n.line} ${n.name} · 出 ${n.outCount} 入 ${n.inCount}`);
  }
  if (ep.filtered > 0) entryLines.push(`- (已过滤非产品路径入口 ${ep.filtered} 条:${ep.samples.join(", ") || "—"};--all 放行)`);
  if (totalTrunk > ep.kept.length + ep.filtered) {
    entryLines.push(`…(+${totalTrunk - ep.kept.length - ep.filtered} 入口未列,限 ${entryLimit} 条)`);
  }

 // ④ 枢纽(按被这些模块依赖的入边数)
  const hubRank = data.order
    .map((name) => {
      const a = data.aggs.get(name);
      return { module: name, sources: a?.in.size ?? 0, inEdges: a ? sum(a.in.values()) : 0 };
    })
    .filter((h) => h.inEdges > 0)
    .sort((a, b) => b.inEdges - a.inEdges || b.sources - a.sources || cmpStr(a.module, b.module));
  const hubLines: string[] = [];
  if (hubRank.length === 0) hubLines.push("- (无跨模块入边:模块间无调用交互,或是单模块仓)");
  for (const h of hubRank.slice(0, hubLimit)) {
    hubLines.push(`- ${h.module} — 被 ${h.sources} 个模块调用(入边 ${h.inEdges})`);
  }
  if (hubRank.length > hubLimit) hubLines.push(`…(+${hubRank.length - hubLimit} 枢纽未列,限 ${hubLimit} 条)`);

 // ⑤ 热区/分层(modview 有交互数据才画)
  const layerLines: string[] = [];
  if (data.view.interactions.length > 0) {
    const entryMods = data.order.filter((n) => (data.aggs.get(n)?.in.size ?? 0) === 0 && (data.aggs.get(n)?.out.size ?? 0) > 0);
    const coreMods = data.order.filter((n) => (data.aggs.get(n)?.in.size ?? 0) > 0 && (data.aggs.get(n)?.out.size ?? 0) > 0);
    const leafMods = data.order.filter((n) => (data.aggs.get(n)?.out.size ?? 0) === 0 && (data.aggs.get(n)?.in.size ?? 0) > 0);
    if (entryMods.length > 0) layerLines.push(`- 入口层(无上游有下游): ${entryMods.slice(0, 6).join(", ")}${entryMods.length > 6 ? ` …(+${entryMods.length - 6})` : ""}`);
    if (coreMods.length > 0) layerLines.push(`- 中枢层(上下游皆有): ${coreMods.slice(0, 6).join(", ")}${coreMods.length > 6 ? ` …(+${coreMods.length - 6})` : ""}`);
    if (leafMods.length > 0) layerLines.push(`- 叶子层(只被调用): ${leafMods.slice(0, 6).join(", ")}${leafMods.length > 6 ? ` …(+${leafMods.length - 6})` : ""}`);
    const hot = data.view.interactions.slice(0, INTERACTION_LINE_CAP).map((e) => `${e.from} → ${e.to} ×${e.count}`);
    if (hot.length > 0) {
      layerLines.push(`- 交互主干: ${hot.join(" | ")}`);
      if (data.view.interactions.length > INTERACTION_LINE_CAP) {
        layerLines.push(`  …(+${data.view.interactions.length - INTERACTION_LINE_CAP} 条交互未列)`);
      }
    }
    const tests = data.view.testLinks;
    if (tests.length > 0) {
      layerLines.push(`- 测试面: ${tests.slice(0, 4).map((t) => `tests → ${t.module} ×${t.edges}`).join(" | ")}${tests.length > 4 ? ` …(+${tests.length - 4})` : ""}`);
    }
  }

  const sections: Section[] = [
    { title: "主线", lines: overview },
    { title: `模块清单(${data.order.length} 组 · 按文件数)`, lines: moduleLines },
    { title: `入口 trunk(Top ${entryLimit} / 共 ${totalTrunk} · 按出度)`, lines: entryLines },
    { title: `枢纽(Top ${hubLimit} · 被依赖最多)`, lines: hubLines },
    { title: "分层与热区(由模块交互数据推出)", lines: layerLines },
  ];
  return renderWithBudget(head, sections, opts.maxBytes ?? WORLD_L0_MAX_BYTES);
}

/** 锚点匹配用的行清洗(与 module-notes.cleanNote 同口径;该函数未导出,这里本地复刻)。 */
function cleanLineForMatch(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Zread 形态(n10):为文档来源的职责定位证据文件锚点。
 * 行号必须真——读证据文件文本定位键/职责原文所在行;定位不到返回 null(调用方保留原来源标签,绝不硬造)。
 * name/topology 是推断来源,没有文件证据,直接 null。
 */
function noteEvidenceAnchor(root: string, module: string, note: ModuleNote): string | null {
  if (note.source !== "package.json" && note.source !== "readme" && note.source !== "docstring") return null;
  const dir = /^\(?root\)?$/i.test(module) ? "" : module;
  const rel = (f: string): string => (dir ? `${dir}/${f}` : f);
  const read = (f: string): string | null => {
    try {
      return readFileSync(join(root, f), "utf-8");
    } catch {
      return null;
    }
  };
  if (note.source === "package.json") {
    const file = rel("package.json");
    const text = read(file);
    if (text === null) return null;
    const i = text.split("\n").findIndex((l) => /"description"\s*:/.test(l));
    return i >= 0 ? `${file}:${i + 1}` : null;
  }
 // readme/docstring:职责文本是 cleanNote+clipNote 后的原文(可能带 … 截尾)——按「清洗后的行包含职责子串」定位
  const needle = note.text.replace(/…$/, "").trim();
  if (!needle) return null;
  const file = note.source === "readme" ? rel("README.md") : rel("__init__.py");
  const text = read(file);
  if (text === null) return null;
 // docstring 短首行会并入第二行(「first;second」)——整串定位不到时退回第一行子串
  const candidates = needle.includes(";") ? [needle, needle.split(";")[0]!] : [needle];
  const lines = text.split("\n");
  const limit = note.source === "readme" ? 60 : 40; // 与 moduleNotes 的读取窗口同口径
  for (let i = 0; i < Math.min(lines.length, limit); i++) {
    const cleaned = cleanLineForMatch(lines[i]!);
    if (candidates.some((c) => c.length > 0 && cleaned.includes(c))) return `${file}:${i + 1}`;
  }
  return null;
}

/** L1:每模块一页(一句职责 + 对外符号 + 上下游模块边 + 关键文件)。顺序与 L0 模块清单一致。 */
export function renderWorldModulePages(
  idx: C2fIndex,
  opts: WorldRenderOptions = {},
): { module: string; markdown: string; bytes: number }[] {
  const exportLimit = opts.exportLimit ?? DEFAULT_EXPORT_LIMIT;
  const topFiles = opts.topFiles ?? DEFAULT_TOP_FILES;
  const pageMaxBytes = opts.pageMaxBytes ?? WORLD_L1_PAGE_MAX_BYTES;
  const data = collect(idx);
  const pages: { module: string; markdown: string; bytes: number }[] = [];
  for (const name of data.order) {
    const a = data.aggs.get(name);
    const note = data.notes[name];
    const head = [
      `<!-- world L1 · module=${name} · builtAt=${isoOf(idx.builtAt)} -->`,
      `# 模块 ${name}`,
    ];
    const duty = note ? moduleAnnotationText(note) : "≈ (无职责线索)";
    const srcLabel = note ? MODULE_NOTE_SOURCE_LABEL[note.source] : "未生成";
 // Zread 形态:文档来源(package.json/README/docstring)带真验证据锚点;定位不到保留原标签
    const anchor = note ? noteEvidenceAnchor(idx.root, name, note) : null;
    const src = anchor ? `${srcLabel} · ${anchor}` : srcLabel;
    const overview: string[] = [
      `- 职责: ${duty}`,
      `- 职责来源: ${src}`,
      `- 规模: 文件 ${a?.files.size ?? 0} · 符号 ${a?.nodes.length ?? 0} · 入边 ${a ? sum(a.in.values()) : 0}(来自 ${a?.in.size ?? 0} 模块)· 出边 ${a ? sum(a.out.values()) : 0}(至 ${a?.out.size ?? 0} 模块)`,
    ];

 // 对外符号:索引无 export 标记,按「被调用数」近似并明说(不冒充导出语义)
    const nodes = a?.nodes ?? [];
    const ranked = [...nodes]
      .filter((n) => n.inCount > 0 || n.outCount > 0)
      .sort((x, y) => y.inCount - x.inCount || y.outCount - x.outCount || cmpStr(x.id, y.id));
    const symLines: string[] = [];
    if (ranked.length === 0) {
      symLines.push("- (无带调用关系的符号:纯声明文件或索引未覆盖调用形态)");
    } else {
      for (const n of ranked.slice(0, exportLimit)) {
        symLines.push(`- ${n.name} · ${n.file}:${n.line} · 被调用 ${n.inCount} · 出 ${n.outCount}`);
      }
      if (ranked.length > exportLimit) symLines.push(`…(+${ranked.length - exportLimit})`);
    }

 // 上下游模块边(方向=依赖方向:A 调 B 即 A → B)
    const edgeLines: string[] = [];
    const downs = [...(a?.out ?? new Map<string, number>()).entries()].sort((x, y) => y[1] - x[1] || cmpStr(x[0], y[0]));
    const ups = [...(a?.in ?? new Map<string, number>()).entries()].sort((x, y) => y[1] - x[1] || cmpStr(x[0], y[0]));
    for (const [to, count] of downs.slice(0, exportLimit)) edgeLines.push(`- 下游 ${name} → ${to} ×${count}`);
    if (downs.length > exportLimit) edgeLines.push(`  …(+${downs.length - exportLimit} 下游模块)`);
    for (const [from, count] of ups.slice(0, exportLimit)) edgeLines.push(`- 上游 ${from} → ${name} ×${count}`);
    if (ups.length > exportLimit) edgeLines.push(`  …(+${ups.length - exportLimit} 上游模块)`);
    if (edgeLines.length === 0) edgeLines.push("- (无跨模块调用边:孤立模块或索引未覆盖跨模块调用)");

 // 关键文件:符号数降序(同数按路径码元序)
    const byFile = new Map<string, number>();
    for (const n of nodes) byFile.set(n.file, (byFile.get(n.file) ?? 0) + 1);
    const files = [...byFile.entries()].sort((x, y) => y[1] - x[1] || cmpStr(x[0], y[0]));
    const fileLines: string[] = [];
    if (files.length === 0) fileLines.push("- (无索引符号文件)");
    for (const [file, count] of files.slice(0, topFiles)) fileLines.push(`- ${file} · 符号 ${count}`);
    if (files.length > topFiles) fileLines.push(`…(+${files.length - topFiles})`);

    const sections: Section[] = [
      { title: "概览", lines: overview },
      { title: `对外符号(Top ${exportLimit} / 共 ${ranked.length} · 索引无 export 标记,按被调用度近似)`, lines: symLines },
      { title: "上下游模块(边数)", lines: edgeLines },
      { title: `关键文件(Top ${topFiles} / 共 ${files.length})`, lines: fileLines },
    ];
    const markdown = renderWithBudget(head, sections, pageMaxBytes);
    pages.push({ module: name, markdown, bytes: byteLen(markdown) });
  }
  return pages;
}
