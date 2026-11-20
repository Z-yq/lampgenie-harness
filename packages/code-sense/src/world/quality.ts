/**
 * 项目世界模型的确定性质量门(2026-11 加性;零 LLM 自评)。
 * 指标全部可从静态索引 `C2fIndex`(nodes/edges)算出并复现:同一份索引两跑数值全等
 * (`builtAt` 取索引构建时间,不吃 `Date.now`;列表排序一律「主键 + id/名字典序」)。
 * 五个面(= 图漏不漏边 / 有没有孤儿 / 入口是否可达 / 契约是否配对 / 文档行号是否真):
 * ① 入口可达率:从 trunk 入口沿「已解析且 to 非空」的 call 边 BFS 可达节点 / 总节点;
 * ② 未解析边比例:kind="unresolved" 或 to 为空的边 / 总边;
 * ③ 孤儿节点:inCount=0 且非 trunk(索引里没有 export 字段——口径如实标注,不假装判过导出);
 * ④ 不可达子图:非可达节点按 inCount 降序 Top-40(另给 total);
 * ⑤ 文档引用:docText 里的 `路径:行号` / `路径:12-34` 逐条 fs 校验(默认不校验,不假绿);
 * ⑥ 契约配对(仅 opts.withSurface):按索引节点路径分类(classifySurfaceHit)统计
 * 各类契约面的产出文件数与被引用文件数——**不跑** scanSurface 的全仓 grep 扫描
 * (它需要概念清单且代价高,默认关闭),本文件的 withSurface 只做索引可算的配对对账。
 * 纪律:不调 LLM、不猜语义、缺席的检查项在报告里显式写「未校验/未扫描」并给出 note,
 * 阈值可注入(默认 entryReachMin=95 / unresolvedMax=5 / docOkRatio=1)。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { C2fIndex, C2fNode } from "../callgraph/c2f.js";
import { SURFACE_CATEGORIES, classifySurfaceHit } from "../surface/index.js";
import { listWorldModules, readWorldModulePage, readWorldSkeleton } from "./store.js";

/** 质量门阈值(可注入,注入值覆盖默认)。 */
export interface QualityThresholds {
 /** 入口可达率下限(百分比,含等号)。 */
  entryReachMin: number;
 /** 未解析边比例上限(百分比,含等号)。 */
  unresolvedMax: number;
 /** 文档引用通过率下限(0~1,含等号)。 */
  docOkRatio: number;
}

export interface QualityOrphan {
  id: string;
  name: string;
  file: string;
  line: number;
}

export interface QualityUnreachable {
  id: string;
  name: string;
  file: string;
  inCount: number;
}

export interface ContractDiff {
  category: string;
 /** 该契约面上的产出文件数(索引节点路径分类口径)。 */
  producers: number;
 /** 引用这些产出文件的其它文件数(索引边口径)。 */
  consumers: number;
  note: string;
}

export interface DocRefBad {
  ref: string;
  reason: string;
}

export interface DocRefsReport {
  total: number;
  ok: number;
  bad: DocRefBad[];
 /** 是否真的校验过(缺 docText=false:total=0 且 pass.docRefs=true 仅代表「未校验」)。 */
  checked: boolean;
  note: string;
}

export interface QualityReport {
 /** 入口可达率(百分比,1 位小数)。 */
  entryReachPct: number;
  reachable: number;
  total: number;
 /** 未解析边比例(百分比,1 位小数)。 */
  unresolvedRatePct: number;
  unresolvedEdges: number;
  totalEdges: number;
  orphans: QualityOrphan[];
 /** 孤儿总数(orphans 可能被截断)。 */
  orphansTotal: number;
  unreachable: QualityUnreachable[];
 /** 不可达节点总数(unreachable 封顶 40)。 */
  unreachableTotal: number;
  contractDiffs: ContractDiff[];
  docRefs: DocRefsReport;
  thresholds: QualityThresholds;
  pass: { entryReach: boolean; unresolved: boolean; docRefs: boolean; all: boolean };
 /** 索引构建时间(=索引身份,不吃 Date.now:同索引两跑全等)。 */
  builtAt: number;
  root: string;
 /** 口径说明/降级说明(每条都是「这一项怎么算的」或「这一项为什么没算」)。 */
  notes: string[];
}

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  entryReachMin: 95,
  unresolvedMax: 5,
  docOkRatio: 1,
};

/** 孤儿/不可达清单 JSON 侧封顶(报告要可读;总数另给)。 */
const ORPHANS_CAP = 200;
const UNREACHABLE_CAP = 40;
const DOC_BAD_CAP = 100;

export interface QualityOptions {
 /** 契约配对对账(默认关:代价/噪声;开启也只走索引可算口径,不跑 scanSurface)。 */
  withSurface?: boolean;
 /** 文档正文:提供时才做 `路径:行号` 存在性校验。 */
  docText?: string;
 /** 文档引用可解析的根前缀(相对索引 root;缺省 [""] 即仓根)。 */
  docRoots?: string[];
 /** 参与 BFS 的入口(trunk)数上限(缺省全部;按 outCount 降序取,确定性)。 */
  entryLimit?: number;
  threshold?: Partial<QualityThresholds>;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** 行数(末尾换行不算一行;空文件=0 行)。 */
function countLines(text: string): number {
  if (text === "") return 0;
  const parts = text.split("\n");
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

/** `路径:行号` / `路径:12-34` 引用抽取(确定性正则,不做语义判断)。 */
const DOC_REF_RE = /(?:^|[^\w./@-])((?:[A-Za-z0-9_@.+-]+\/)*[A-Za-z0-9_@.+-]*\.[A-Za-z][A-Za-z0-9]{0,9}):(\d+)(?:-(\d+))?/g;

interface ParsedDocRef {
  ref: string;
  path: string;
  line: number;
  end?: number;
}

function parseDocRefs(docText: string): ParsedDocRef[] {
  const out: ParsedDocRef[] = [];
  const seen = new Set<string>();
  DOC_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DOC_REF_RE.exec(docText)) !== null) {
    const p = m[1]!;
    const line = Number(m[2]);
    const end = m[3] === undefined ? undefined : Number(m[3]);
    if (!Number.isFinite(line) || line < 1) continue;
    const ref = m[3] === undefined ? `${p}:${m[2]}` : `${p}:${m[2]}-${m[3]}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(end === undefined ? { ref, path: p, line } : { ref, path: p, line, end });
  }
  return out;
}

/** 在容舍根前缀里解析一条文档引用的真实路径(找不到=null)。 */
function resolveDocPath(root: string, rel: string, docRoots: string[]): string | null {
  const cleaned = rel.replace(/^\.\//, "");
  const prefixes = [""];
  for (const r of docRoots) {
    const p = r.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!prefixes.includes(p)) prefixes.push(p);
  }
  for (const p of prefixes) {
    const abs = p ? join(root, p, cleaned) : join(root, cleaned);
    if (existsSync(abs)) return abs;
  }
  return null;
}

function computeDocRefs(root: string, opts: QualityOptions): DocRefsReport {
  const docText = opts.docText;
  if (typeof docText !== "string") {
    return {
      total: 0,
      ok: 0,
      bad: [],
      checked: false,
      note: "未校验:未提供 docText(本项 pass=true 仅表示「没有可校验的输入」,不代表文档行号正确)",
    };
  }
  const docRoots = opts.docRoots ?? [];
  const refs = parseDocRefs(docText);
  let ok = 0;
  const bad: DocRefBad[] = [];
  for (const r of refs) {
    const abs = resolveDocPath(root, r.path, docRoots);
    if (!abs) {
      if (bad.length < DOC_BAD_CAP) bad.push({ ref: r.ref, reason: "文件不存在(相对仓根/docRoots 均未命中)" });
      continue;
    }
    let lines: number;
    try {
      lines = countLines(readFileSync(abs, "utf-8"));
    } catch {
      if (bad.length < DOC_BAD_CAP) bad.push({ ref: r.ref, reason: "文件不可读" });
      continue;
    }
    const hi = r.end ?? r.line;
    if (r.line > lines || hi > lines) {
      if (bad.length < DOC_BAD_CAP) bad.push({ ref: r.ref, reason: `行号越界(文件共 ${lines} 行)` });
      continue;
    }
    ok++;
  }
  const badShown = bad.length;
  return {
    total: refs.length,
    ok,
    bad,
    checked: true,
    note: `确定性校验:文件存在 + 行号 ≤ 文件行数(共 ${refs.length} 条引用,失败 ${refs.length - ok} 条${
      refs.length - ok > badShown ? `,清单截 ${DOC_BAD_CAP}` : ""
    })`,
  };
}

/** 产物锚点校验失败条(比 DocRefBad 多 file/line 两个机器可读字段)。 */
export interface ArtifactRefBad {
  ref: string;
  file: string;
  line: number;
  reason: string;
}

export interface ArtifactRefsReport {
 /** 抽出的锚点总数(跨 skeleton+模块页按 ref 去重,与 parseDocRefs 同口径)。 */
  total: number;
 /** 是否真的读到产物并校验过(无产物=false:total=0 且 pass=true 仅代表「没有可校验的输入」)。 */
  checked: boolean;
 /** 坏锚点清单(封顶 ARTIFACT_BAD_CAP;真实坏总数见 notes)。 */
  bad: ArtifactRefBad[];
  pass: boolean;
  notes: string[];
}

/** 产物坏锚点清单封顶(报告要可读;总数在 notes 里如实给)。 */
const ARTIFACT_BAD_CAP = 40;

/**
 * 产物锚点校验(质量门补面):读常驻产物 skeleton.md + 全部模块页文本,复用 parseDocRefs
 * 同口径抽 `路径:行号` / `路径:12-34` 锚点,逐条校「文件相对 root 存在 + 行号 ≤ 文件行数」。
 * **零索引加载**(只走 store 的产物读函数);纯函数可单测;同一份产物两跑结果全等(不吃 Date.now)。
 */
export function computeArtifactRefs(root: string): ArtifactRefsReport {
  const skel = readWorldSkeleton(root);
  const texts: string[] = [];
  if (skel.text !== null) texts.push(skel.text);
  let pageCount = 0;
  for (const m of listWorldModules(root)) {
    const page = readWorldModulePage(root, m);
    if (page) {
      texts.push(page.text);
      pageCount++;
    }
  }
  if (texts.length === 0) {
    return {
      total: 0,
      checked: false,
      bad: [],
      pass: true,
      notes: ["未校验:无世界模型产物(skeleton.md 与模块页均缺席;pass=true 仅表示「没有可校验的输入」,不代表锚点正确)"],
    };
  }
  const refs = parseDocRefs(texts.join("\n"));
  const lineCache = new Map<string, number | null>();
  const linesOf = (abs: string): number | null => {
    const cached = lineCache.get(abs);
    if (cached !== undefined) return cached;
    let n: number | null = null;
    try {
      n = countLines(readFileSync(abs, "utf-8"));
    } catch {
      n = null;
    }
    lineCache.set(abs, n);
    return n;
  };
  let badTotal = 0;
  const bad: ArtifactRefBad[] = [];
  const pushBad = (r: ParsedDocRef, reason: string): void => {
    badTotal++;
    if (bad.length < ARTIFACT_BAD_CAP) bad.push({ ref: r.ref, file: r.path, line: r.line, reason });
  };
  for (const r of refs) {
    const abs = resolveDocPath(root, r.path, []);
    if (!abs) {
      pushBad(r, "文件不存在(相对仓根)");
      continue;
    }
    const lines = linesOf(abs);
    if (lines === null) {
      pushBad(r, "文件不可读");
      continue;
    }
    const hi = r.end ?? r.line;
    if (r.line > lines || hi > lines) {
      pushBad(r, `行号越界(文件共 ${lines} 行)`);
      continue;
    }
  }
  return {
    total: refs.length,
    checked: true,
    bad,
    pass: badTotal === 0,
    notes: [
      `零索引加载:读 skeleton.md${skel.text === null ? "(缺席)" : ""} + ${pageCount} 个模块页,锚点按 ref 去重(parseDocRefs 同口径)`,
      `确定性校验:文件相对 root 存在 + 行号 ≤ 文件行数(共 ${refs.length} 条锚点,坏 ${badTotal} 条${
        badTotal > bad.length ? `,清单截 ${ARTIFACT_BAD_CAP}` : ""
      })`,
    ],
  };
}

/** 契约面配对对账(索引可算口径:路径分类 + 索引边;不跑 scanSurface)。 */
function computeContractDiffs(idx: C2fIndex): ContractDiff[] {
  const byId = new Map<string, C2fNode>();
  for (const n of idx.nodes) byId.set(n.id, n);
  const producers = new Map<string, Set<string>>();
  for (const n of idx.nodes) {
    const cat = classifySurfaceHit(n.file, "");
    let set = producers.get(cat);
    if (!set) {
      set = new Set<string>();
      producers.set(cat, set);
    }
    set.add(n.file);
  }
  const consumers = new Map<string, Set<string>>();
  for (const e of idx.edges) {
    if (e.kind === "unresolved" || !e.to) continue;
    const target = byId.get(e.to);
    if (!target) continue;
    const cat = classifySurfaceHit(target.file, "");
    const prod = producers.get(cat);
    if (!prod || !prod.has(target.file)) continue;
    if (prod.has(e.file)) continue; // 同类内部调用不算跨面配对
    let set = consumers.get(cat);
    if (!set) {
      set = new Set<string>();
      consumers.set(cat, set);
    }
    set.add(e.file);
  }
  const out: ContractDiff[] = [];
  for (const cat of SURFACE_CATEGORIES) {
    const p = producers.get(cat)?.size ?? 0;
    const c = consumers.get(cat)?.size ?? 0;
    if (p === 0 && c === 0) continue;
    const note = p === 0
      ? "无产出方:只有消费面命中,分类口径可疑"
      : c === 0
        ? "无消费方:契约疑似单侧(索引未捕获引用或该面文件未被调用)"
        : `消费方 ${c} 个文件引用产出方 ${p} 个文件`;
    out.push({ category: cat, producers: p, consumers: c, note });
  }
  return out;
}

/**
 * 算质量报告:纯函数(唯一副作用=docRefs 校验时读文档引用的目标文件)。
 * 同一份 idx + 同 opts 两跑数值全等。
 */
export function computeQuality(idx: C2fIndex, opts: QualityOptions = {}): QualityReport {
  const thresholds: QualityThresholds = { ...DEFAULT_QUALITY_THRESHOLDS, ...(opts.threshold ?? {}) };
  const notes: string[] = [];
  const nodes = idx.nodes ?? [];
  const edges = idx.edges ?? [];
  const total = nodes.length;
  const byId = new Map<string, C2fNode>();
  for (const n of nodes) byId.set(n.id, n);

 // ---- 边分流:未解析(to 空或 kind=unresolved)vs 可走 ---- //
  let unresolvedEdges = 0;
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind === "unresolved" || !e.to) {
      unresolvedEdges++;
      continue;
    }
    if (!byId.has(e.to)) continue; // 指向索引外的边不算可达通道(目标无节点)
    let list = adj.get(e.from);
    if (!list) {
      list = [];
      adj.set(e.from, list);
    }
    list.push(e.to);
  }
 // 邻接去重 + 字典序(确定性)
  for (const [k, v] of adj) adj.set(k, [...new Set(v)].sort((a, b) => a.localeCompare(b)));

 // ---- 入口 BFS ---- //
  const allTrunk = nodes
    .filter((n) => n.kind === "trunk")
    .sort((a, b) => b.outCount - a.outCount || a.id.localeCompare(b.id));
  const seedLimit = opts.entryLimit === undefined ? allTrunk.length : Math.max(0, opts.entryLimit);
  const seeds = allTrunk.slice(0, seedLimit);
  if (seedLimit < allTrunk.length) notes.push(`入口 BFS 只用了 ${seedLimit}/${allTrunk.length} 个 trunk(outCount 降序,entryLimit 截断)`);
  const reached = new Set<string>();
  const queue: string[] = [];
  for (const n of seeds) {
    if (!reached.has(n.id)) {
      reached.add(n.id);
      queue.push(n.id);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!;
    for (const nxt of adj.get(cur) ?? []) {
      if (reached.has(nxt)) continue;
      reached.add(nxt);
      queue.push(nxt);
    }
  }
  const reachable = reached.size;
  const entryReachPct = total === 0 ? 0 : round1((reachable / total) * 100);
  const unresolvedRatePct = edges.length === 0 ? 0 : round1((unresolvedEdges / edges.length) * 100);

 // ---- 孤儿(索引无 export 字段:口径 = inCount=0 且非 trunk) ---- //
  const orphanAll = nodes
    .filter((n) => n.inCount === 0 && n.kind !== "trunk")
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id));
  const orphans = orphanAll.slice(0, ORPHANS_CAP).map((n) => ({ id: n.id, name: n.name, file: n.file, line: n.line }));
  if (orphanAll.length > 0) {
    notes.push(
      `孤儿口径:inCount=0 且 kind!=="trunk";索引不含 export 字段,无法排除「被外部/未索引代码使用」与「导出但未被调用」——本项是提示面,不进硬门`,
    );
  }
  if (orphanAll.length > orphans.length) notes.push(`孤儿清单截 ${ORPHANS_CAP}(共 ${orphanAll.length} 个)`);

 // ---- 不可达子图 ---- //
  const unreachableAll = nodes
    .filter((n) => !reached.has(n.id))
    .sort((a, b) => b.inCount - a.inCount || a.id.localeCompare(b.id));
  const unreachable = unreachableAll
    .slice(0, UNREACHABLE_CAP)
    .map((n) => ({ id: n.id, name: n.name, file: n.file, inCount: n.inCount }));
  if (unreachableAll.length > unreachable.length) {
    notes.push(`不可达清单封顶 ${UNREACHABLE_CAP}(共 ${unreachableAll.length} 个)`);
  }
  if (allTrunk.length === 0 && total > 0) notes.push("索引里没有 trunk 入口:入口可达率按 0 处理(不可达=全图)");

 // ---- 契约面配对(仅 withSurface) ---- //
  const contractDiffs = opts.withSurface ? computeContractDiffs(idx) : [];
  notes.push(
    opts.withSurface
      ? "契约配对口径:索引节点路径分类(classifySurfaceHit)+ 索引边;未跑 scanSurface 全仓 grep 扫描(该扫描需概念清单且代价高)"
      : "契约面未扫描(--surface 开启才做,且只走索引可算口径;本项不进硬门)",
  );

 // ---- 文档引用 ---- //
  const docRefs = computeDocRefs(idx.root, opts);
  const docRatio = docRefs.total === 0 ? 1 : docRefs.ok / docRefs.total;
  notes.push(docRefs.note);

  const passEntryReach = entryReachPct >= thresholds.entryReachMin;
  const passUnresolved = unresolvedRatePct <= thresholds.unresolvedMax;
  const passDocRefs = !docRefs.checked ? true : docRatio >= thresholds.docOkRatio;

  return {
    entryReachPct,
    reachable,
    total,
    unresolvedRatePct,
    unresolvedEdges,
    totalEdges: edges.length,
    orphans,
    orphansTotal: orphanAll.length,
    unreachable,
    unreachableTotal: unreachableAll.length,
    contractDiffs,
    docRefs,
    thresholds,
    pass: {
      entryReach: passEntryReach,
      unresolved: passUnresolved,
      docRefs: passDocRefs,
      all: passEntryReach && passUnresolved && passDocRefs,
    },
    builtAt: idx.builtAt,
    root: idx.root,
    notes,
  };
}

function mark(v: boolean): string {
  return v ? "✓" : "✗";
}

function truncateList<T>(items: T[], max: number): { shown: T[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}

const LIST_PREVIEW = 20;

/** 人读 markdown:五行指标 + 孤儿/不可达清单(各截断并写 +N)+ 阈值判定。 */
export function renderQualityReport(r: QualityReport): string {
  const L: string[] = [];
  L.push("# 质量门报告(确定性,零 LLM)");
  L.push("");
  L.push(`- 根: \`${r.root}\``);
  L.push(`- 索引构建时间: ${new Date(r.builtAt).toISOString()}(报告数值按此索引复现)`);
  L.push(`- 规模: 节点 ${r.total} / 边 ${r.totalEdges}`);
  L.push("");
  L.push("## 指标");
  L.push("");
  L.push("| # | 指标 | 值 | 阈值 | 判定 |");
  L.push("|---|---|---|---|---|");
  L.push(
    `| 1 | 入口可达率 | ${r.entryReachPct}% (${r.reachable}/${r.total}) | ≥ ${r.thresholds.entryReachMin}% | ${mark(r.pass.entryReach)} |`,
  );
  L.push(
    `| 2 | 未解析边比例 | ${r.unresolvedRatePct}% (${r.unresolvedEdges}/${r.totalEdges}) | ≤ ${r.thresholds.unresolvedMax}% | ${mark(r.pass.unresolved)} |`,
  );
  L.push(`| 3 | 孤儿节点 | ${r.orphansTotal} 个(inCount=0 且非 trunk) | — | 提示面 |`);
  L.push(`| 4 | 不可达节点 | ${r.unreachableTotal} 个(自 trunk 入口不可达) | — | 提示面 |`);
  const docLine = r.docRefs.checked
    ? `${r.docRefs.ok}/${r.docRefs.total} 条引用通过(${r.docRefs.bad.length} 条失败)`
    : "未校验(未提供 docText;不代表通过)";
  L.push(
    `| 5 | 文档引用 | ${docLine} | ≥ ${Math.round(r.thresholds.docOkRatio * 100)}% | ${r.docRefs.checked ? mark(r.pass.docRefs) : "— 未校验"} |`,
  );
  L.push("");

  const orphanView = truncateList(r.orphans, LIST_PREVIEW);
  L.push(`## 孤儿节点(共 ${r.orphansTotal} 个)`);
  if (orphanView.shown.length === 0) L.push("- 无");
  else {
    for (const o of orphanView.shown) L.push(`- \`${o.file}:${o.line}\` ${o.name}`);
    if (orphanView.more > 0) L.push(`- +${orphanView.more} 个未列出`);
  }
  L.push("");

  const unreachView = truncateList(r.unreachable, LIST_PREVIEW);
  L.push(`## 不可达节点(共 ${r.unreachableTotal} 个,按入边降序)`);
  if (unreachView.shown.length === 0) L.push("- 无");
  else {
    for (const u of unreachView.shown) L.push(`- \`${u.file}\` ${u.name}(入边 ${u.inCount})`);
    if (unreachView.more > 0) L.push(`- +${unreachView.more} 个未列出`);
  }
  L.push("");

  if (r.contractDiffs.length > 0) {
    L.push("## 契约面配对");
    L.push("");
    for (const c of r.contractDiffs) {
      L.push(`- ${c.category}: 产出 ${c.producers} / 消费 ${c.consumers} — ${c.note}`);
    }
    L.push("");
  }

  if (r.docRefs.checked && r.docRefs.bad.length > 0) {
    L.push("## 文档引用失败");
    L.push("");
    const badView = truncateList(r.docRefs.bad, LIST_PREVIEW);
    for (const b of badView.shown) L.push(`- \`${b.ref}\` — ${b.reason}`);
    if (badView.more > 0) L.push(`- +${badView.more} 条未列出`);
    L.push("");
  }

  L.push("## 阈值判定");
  L.push("");
  L.push(
    `- 入口可达 ${mark(r.pass.entryReach)} · 未解析边 ${mark(r.pass.unresolved)} · 文档引用 ${
      r.docRefs.checked ? mark(r.pass.docRefs) : "— 未校验"
    }`,
  );
  L.push(`- 结论: **${r.pass.all ? "PASS" : "FAIL"}**`);
  L.push("");
  L.push("## 口径说明");
  L.push("");
  for (const n of r.notes) L.push(`- ${n}`);
  return L.join("\n") + "\n";
}
