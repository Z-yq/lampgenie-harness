/**
 * 整仓 code flow(code2flow 画图语义移植到整仓尺度)。
 * 背景:已有图面都是「局部」的——symbol --graph 是单符号邻域、file --graph 是单文件、
 * modules --graph 是模块矩阵;没有一张「整个项目从哪进来、主流程怎么走、谁依赖谁」的图。
 * code2flow(code2flow)的答案是:全仓函数图 + 每文件 root 节点 + File/Class 分组 +
 * trunk/leaf/regular 三色 + 默认裁掉零连接节点 + graphviz 出图。但直接照搬到 9k 符号/
 * 12 万边的仓会得到不可读的一团,所以本模块做**分层聚合**(module/file/function),
 * 每层都保留 code2flow 的四个关键语义:
 *   ① root 节点:`<file>#<module>` 模块级语句/启动器调用(组合根)是流程起点;
 *   ② 分类:trunk=入度 0(没人调用)/leaf=出度 0(不调别人)/regular=其余;
 *   ③ 分组:module→顶层目录,file→模块组,function→File + Class(嵌套子图);
 * ④ 裁剪:默认去掉零连接节点;超预算按「入口可达优先 + 调用量」保留,并如用户反馈省略数。
 * 额外两件事(超出 code2flow 的整仓适配):
 *   - 分层:BFS 距最近入口的跳数(depth),渲染按层排序,人读图有方向;
 *   - 桥边:索引里的跨语言 HTTP 桥(file 级)在 module/file 图上以虚线接入,
 *     否则前端/后端两张图永远不相连。
 * 数据面与图面分离( §9):buildCodeFlow 产结构化对象(agent/JSON 消费),
 * render* 只负责画。默认排除测试与非产品路径(…),--all 放开。
 */
import { isNonProductPath, isTestPath } from "../path-filter";
import type { C2fEdge, C2fIndex, C2fNode } from "./c2f";
import type { ProcessEntry } from "../sensing/procentries";
import { MODULE_CALLER } from "./engine";
import { moduleGroupOf } from "./modview";

export type FlowLevel = "module" | "file" | "function";
export type FlowDirection = "LR" | "TD";
export type FlowNodeKind = "trunk" | "leaf" | "regular" | "isolated" | "root";
export type FlowEntryKind = "process" | "module-root" | "trunk";

export interface FlowOptions {
  /** 缺省 auto:模块数≥6 走 module,文件数≥6 走 file,否则 function。 */
  level?: FlowLevel | "auto";
  /** 目录/文件前缀(只保留该子树)。 */
  scope?: string;
  /** 路径正则(白名单/黑名单,作用于相对路径)。 */
  include?: string;
  exclude?: string;
  maxNodes?: number;
  maxEdges?: number;
  keepIsolated?: boolean;
  /** 默认 false:测试文件不进流程图(测试对模块的调用会淹没主干)。 */
  includeTests?: boolean;
 /** 默认 false: 等非产品路径不进图。 */
  includeNonProduct?: boolean;
  /** 目标子图(code2flow --target-function):按节点 key/名字/file/module 定向。 */
  target?: string;
  upstream?: number;
  downstream?: number;
  /** module/file 层默认接入跨语言桥边。 */
  bridges?: boolean;
  /** 进程入口(调用方用 scanProcessEntriesSync 得到;缺省=只靠 root/trunk 推)。 */
  processEntries?: ProcessEntry[];
  direction?: FlowDirection;
}

export interface FlowNode {
  id: string;
  label: string;
  group: string;
  parentGroup?: string;
  file?: string;
  line?: number;
  kind: FlowNodeKind;
  entry: boolean;
  entryKind?: FlowEntryKind;
  entryLabel?: string;
  /** 距最近入口的跳数;-1=从入口不可达。 */
  depth: number;
  out: number;
  in: number;
  outCalls: number;
  inCalls: number;
  internalCalls: number;
  unresolved: number;
  symbols?: number;
  files?: number;
  cls?: string;
}

export interface FlowEdge {
  from: string;
  to: string;
  count: number;
  kinds: Partial<Record<C2fEdge["kind"] | "bridge", number>>;
  bridge?: boolean;
  label?: string;
}

export interface FlowGroup {
  id: string;
  label: string;
  parent?: string;
}

export interface FlowStats {
  nodesTotal: number;
  edgesTotal: number;
  nodesShown: number;
  edgesShown: number;
  nodesOmitted: number;
  edgesOmitted: number;
  isolatedDropped: number;
  budgetNodesDropped: number;
  budgetEdgesDropped: number;
  unresolvedCalls: number;
  internalCalls: number;
  bridgeEdges: number;
  classEdgesDropped: number;
  lexicalExcluded: number;
  sourceFiles: number;
  sourceSymbols: number;
  sourceEdges: number;
  truncated: boolean;
}

export interface CodeFlow {
  level: FlowLevel;
  root: string;
  direction: FlowDirection;
  nodes: FlowNode[];
  edges: FlowEdge[];
  groups: FlowGroup[];
  entries: string[];
  center?: string;
  stats: FlowStats;
  notes: string[];
  /** 模块级图:模块/节点 label → 一句话作用(画在节点旁;来源由 module-notes 提供)。 */
  annotations?: Record<string, string>;
}

interface WorkNode {
  key: string;
  label: string;
  group: string;
  parentGroup?: string;
  file?: string;
  line?: number;
  cls?: string;
  entryKind?: FlowEntryKind;
  entryLabel?: string;
  filesSet?: Set<string>;
  outSet: Set<string>;
  inSet: Set<string>;
  outCalls: number;
  inCalls: number;
  internalCalls: number;
  unresolved: number;
}

interface WorkEdge {
  from: string;
  to: string;
  count: number;
  kinds: Partial<Record<C2fEdge["kind"] | "bridge", number>>;
  bridge?: boolean;
  label?: string;
}

/** 缺省 0=不设上限,全量画出;
 * maxNodes/maxEdges 只作为用户显式收窄的 opt-in(--max-nodes N),省略数仍如用户反馈。 */
const DEFAULT_MAX_NODES: Record<FlowLevel, number> = { module: 0, file: 0, function: 0 };
const DEFAULT_MAX_EDGES: Record<FlowLevel, number> = { module: 0, file: 0, function: 0 };

function safeRe(src: string | undefined): { re: RegExp | null; error?: string } {
  if (!src) return { re: null };
  try {
    return { re: new RegExp(src) };
  } catch (err) {
    return { re: null, error: `正则无效(${String(err instanceof Error ? err.message : err)}): ${src}` };
  }
}

function normScope(scope: string | undefined): string | null {
  if (!scope) return null;
  const s = scope.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return s || null;
}

function fileOfId(index: C2fIndex, byId: Map<string, C2fNode>, id: string): string {
  const n = byId.get(id);
  if (n) return n.file;
  const hash = id.lastIndexOf("#");
  return hash >= 0 ? id.slice(0, hash) : id;
}

function callableNode(n: C2fNode): boolean {
  if (n.proto) return false;
  if (n.tier === "lexical") return false;
  const k = n.symKind;
  if (!k) return true; // function / method
  return k === "function" || k === "method" || k === "arrow" || k === "inline-js";
}

function weightOf(n: WorkNode): number {
  return n.outCalls + n.inCalls;
}

/** 大类分组(file 层):模块组;根文件/浅文件归 ".". */
function dirOf(file: string): string {
  const g = moduleGroupOf(file);
  return g === file ? "." : g;
}

/** 自动分层:模块数≥6 看模块,否则文件数≥6 看文件,再否则看函数。 */
function autoLevel(index: C2fIndex, allow: (file: string) => boolean): FlowLevel {
  const modules = new Set<string>();
  const files = new Set<string>();
  for (const file of Object.keys(index.byFile)) {
    if (!allow(file) || !(index.byFile[file]?.length)) continue;
    files.add(file);
    modules.add(moduleGroupOf(file));
  }
  if (modules.size >= 6) return "module";
  if (files.size >= 6) return "file";
  return "function";
}

export class FlowTargetError extends Error {
  constructor(message: string, readonly candidates: string[] = []) {
    super(message);
  }
}

export function buildCodeFlow(index: C2fIndex, opts: FlowOptions = {}): CodeFlow {
  const notes: string[] = [];
  const inc = safeRe(opts.include);
  const exc = safeRe(opts.exclude);
  if (inc.error) notes.push(inc.error);
  if (exc.error) notes.push(exc.error);
  const scope = normScope(opts.scope);
  const includeTests = opts.includeTests === true;
  const includeNonProduct = opts.includeNonProduct === true;

  const allow = (file: string): boolean => {
    const f = file.replace(/\\/g, "/");
    if (scope && f !== scope && !f.startsWith(scope + "/")) return false;
    if (!includeNonProduct && isNonProductPath(f)) return false;
    if (!includeTests && isTestPath(f)) return false;
    if (inc.re && !inc.re.test(f)) return false;
    if (exc.re && exc.re.test(f)) return false;
    return true;
  };

  const level: FlowLevel = !opts.level || opts.level === "auto" ? autoLevel(index, allow) : opts.level;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES[level];
  const maxEdges = opts.maxEdges ?? DEFAULT_MAX_EDGES[level];
  const keepIsolated = opts.keepIsolated === true;
  const direction: FlowDirection = opts.direction ?? "LR";
  const withBridges = opts.bridges !== false && level !== "function";

  const byId = new Map(index.nodes.map((n) => [n.id, n]));
  const callableByFile = new Map<string, C2fNode[]>();
  for (const n of index.nodes) {
    if (!callableNode(n)) continue;
    const list = callableByFile.get(n.file) ?? [];
    list.push(n);
    callableByFile.set(n.file, list);
  }

  // ---- 节点宇宙 ----
  const work = new Map<string, WorkNode>();
  const groupDefs = new Map<string, { label: string; parent?: string }>();
  const symKey = new Map<string, string>(); // function 层:符号 id → 节点 key
  let lexicalExcluded = 0;

  const ensure = (key: string, init: Omit<WorkNode, "outSet" | "inSet" | "outCalls" | "inCalls" | "internalCalls" | "unresolved">): WorkNode => {
    const hit = work.get(key);
    if (hit) return hit;
    const n: WorkNode = { ...init, outSet: new Set(), inSet: new Set(), outCalls: 0, inCalls: 0, internalCalls: 0, unresolved: 0 };
    work.set(key, n);
    return n;
  };

  const fileKey = (file: string): string => {
    const g = dirOf(file);
    if (!groupDefs.has(g)) groupDefs.set(g, { label: g === "." ? "root files" : g });
    const key = "f:" + file;
    ensure(key, {
      key, label: file, group: g, file,
    });
    return key;
  };
  const moduleKey = (file: string): string => {
    const g = moduleGroupOf(file);
    const top = g.includes("/") ? g.slice(0, g.indexOf("/")) : ".";
    const groupKey = "top:" + top;
    if (!groupDefs.has(groupKey)) groupDefs.set(groupKey, { label: top === "." ? "root files" : top });
    const key = "m:" + g;
    const n = ensure(key, {
      key, label: g, group: groupKey, filesSet: new Set(),
    });
    n.filesSet!.add(file);
    return key;
  };
  const mapFile = (file: string): string => (level === "module" ? moduleKey(file) : fileKey(file));

  if (level === "function") {
    const fileGroups = new Set<string>();
    for (const n of index.nodes) {
      if (n.tier === "lexical") { lexicalExcluded++; continue; }
      if (!callableNode(n) || !allow(n.file)) continue;
      const key = "s:" + n.id;
      symKey.set(n.id, key);
      const groupKey = "file:" + n.file;
      if (!fileGroups.has(groupKey)) {
        fileGroups.add(groupKey);
        groupDefs.set(groupKey, { label: `File: ${n.file}` });
      }
      let parentGroup: string | undefined;
      if (n.container) {
        parentGroup = "cls:" + n.file + "#" + n.container;
        if (!groupDefs.has(parentGroup)) groupDefs.set(parentGroup, { label: `Class: ${n.container}`, parent: groupKey });
      }
      ensure(key, {
        key, label: n.name, group: groupKey, parentGroup, file: n.file, line: n.line, cls: n.container,
      });
    }
  } else {
    for (const file of Object.keys(index.byFile)) {
      if (!allow(file) || !(callableByFile.get(file)?.length)) continue;
      mapFile(file);
    }
  }

  const rootKey = (file: string): string => {
    const key = "r:" + file;
    const groupKey = "file:" + file;
    if (!groupDefs.has(groupKey)) groupDefs.set(groupKey, { label: `File: ${file}` });
    ensure(key, { key, label: `<module>`, group: groupKey, file });
    return key;
  };

  // 目标符号是类时,把 new Class() 连到构造器节点(code2flow 把类当分组,不当节点)。
  const classConstructorKey = (classId: string): string | null => {
    const cls = byId.get(classId);
    if (!cls || cls.symKind !== "class") return null;
    const ids = index.byFile[cls.file] ?? [];
    const pref = classId + ".";
    for (const suffix of ["constructor", "__init__", "init"]) {
      const hit = ids.find((id) => id === pref + suffix);
      const key = hit ? symKey.get(hit) : null;
      if (key) return key;
    }
    return null;
  };

  // ---- 边聚合 ----
  const edgeMap = new Map<string, WorkEdge>();
  const entries = new Map<string, { kind: FlowEntryKind; label?: string }>();
  let unresolvedCalls = 0;
  let internalCalls = 0;
  let classEdgesDropped = 0;

  const addEdge = (from: string, to: string, kind: C2fEdge["kind"], bridge?: { label: string }): void => {
    if (from === to) {
      const n = work.get(from);
      if (n) n.internalCalls++;
      internalCalls++;
      return;
    }
    const key = from + "\u0000" + to + (bridge ? "\u0000B" : "");
    let e = edgeMap.get(key);
    if (!e) {
      e = { from, to, count: 0, kinds: {}, ...(bridge ? { bridge: true, label: bridge.label } : {}) };
      edgeMap.set(key, e);
    }
    e.count++;
    const k = bridge ? "bridge" : kind;
    e.kinds[k] = (e.kinds[k] ?? 0) + 1;
    const a = work.get(from)!;
    const b = work.get(to)!;
    a.outSet.add(to);
    b.inSet.add(from);
    a.outCalls++;
    b.inCalls++;
  };

  for (const e of index.edges) {
    const fromFile = fileOfId(index, byId, e.from);
    if (!allow(fromFile)) continue;
    const isRootCall = e.from.endsWith("#" + MODULE_CALLER);
    let fromKey: string | null;
    if (level === "function") {
      fromKey = isRootCall ? rootKey(fromFile) : symKey.get(e.from) ?? null;
    } else {
      fromKey = mapFile(fromFile);
    }
    if (!fromKey) continue;
    if (!e.to) {
      unresolvedCalls++;
      work.get(fromKey)!.unresolved++;
      continue;
    }
    const toFile = fileOfId(index, byId, e.to);
    if (!allow(toFile)) continue;
    let toKey: string | null;
    if (level === "function") {
      toKey = symKey.get(e.to) ?? classConstructorKey(e.to);
      if (!toKey) {
        if (byId.get(e.to)?.symKind === "class") classEdgesDropped++;
        continue;
      }
    } else {
      toKey = mapFile(toFile);
    }
    addEdge(fromKey, toKey, e.kind);
    // 组合根判定:模块级语句调用**另一个文件**的代码=真实启动链(同文件/同聚合内部的
    // 顶层调用不把整个模块吹成入口——否则 19 个模块 17 个入口,入口节失去意义)。
    if (isRootCall && (level === "function" || toFile !== fromFile)) {
      if (!entries.has(fromKey) || entries.get(fromKey)!.kind === "trunk") {
        entries.set(fromKey, { kind: "module-root", label: `模块级调用 ${fromFile}` });
      }
    }
  }

  // 跨语言桥边(module/file 层):端点不是符号,只按 file 归属接入。
  let bridgeEdges = 0;
  if (withBridges && index.bridge?.edges?.length) {
    for (const b of index.bridge.edges) {
      const fromFile = b.from.file.replace(/\\/g, "/");
      const toFile = b.to.file.replace(/\\/g, "/");
      if (!allow(fromFile) || !allow(toFile) || fromFile === toFile) continue;
      const fromKey = mapFile(fromFile);
      const toKey = mapFile(toFile);
      addEdge(fromKey, toKey, "unresolved", { label: `HTTP ${b.to.method} ${b.to.path}` });
      bridgeEdges++;
      if (!entries.has(fromKey) && level === "file") {
        // 前端入口文件(有 fetch 调用点)天然是流程起点;只标不覆盖已有 entry。
        const n = work.get(fromKey);
        if (n && n.entryKind === undefined) entries.set(fromKey, { kind: "module-root", label: `前端调用 ${b.from.literal}` });
      }
    }
  }

  // ---- 进程入口 ----
  for (const pe of opts.processEntries ?? []) {
    const file = pe.file.replace(/\\/g, "/");
    if (file === "package.json" || !allow(file)) continue;
    if (level === "function") {
      let marked = false;
      for (const name of pe.calls) {
        for (const id of index.byName[name] ?? []) {
          if (fileOfId(index, byId, id) !== file) continue;
          const key = symKey.get(id);
          if (key && !entries.has(key)) {
            entries.set(key, { kind: "process", label: pe.label });
            marked = true;
          }
        }
      }
      const rk = work.has("r:" + file) ? "r:" + file : null;
      if (rk && !entries.has(rk)) entries.set(rk, { kind: "process", label: pe.label });
      if (!marked && !rk) {
        const best = [...work.values()]
          .filter((n) => n.file === file && n.outSet.size > 0)
          .sort((a, b) => weightOf(b) - weightOf(a))[0];
        if (best) entries.set(best.key, { kind: "process", label: pe.label });
      }
    } else {
      const key = mapFile(file);
      if (!entries.has(key)) entries.set(key, { kind: "process", label: pe.label });
    }
  }

  // 「被别的模块调用的库内启动代码」不是项目入口(它属于上层流程):例如 harness-runtime
  // 的模块级初始化会调用别的包,但 79 条入边说明它是库不是启动器。进程入口(真实 bin/__main__
  // 守卫)不受此限——多进程系统里子进程文件也可能被上层 import。
  // 另一个清理:模块级代码只调本模块内部(外部出边 0)的包——它是自包含子系统,不是全仓
  // 流程起点(否则 packages/harness-lsp / test-support / eval-scratch 这些 0/0 节点也占入口位)。
  for (const [key, info] of [...entries]) {
    if (info.kind !== "module-root") continue;
    const n = work.get(key);
    if (!n) { entries.delete(key); continue; }
    if (n.inSet.size > 0) entries.delete(key);
    else if (n.outSet.size === 0) entries.delete(key);
  }

  // function 层:每个有顶层调用的文件都会造一个 <module> root(code2flow 语义),全仓规模下
 // 动辄上百个——它们不能全部当「项目入口」占预算(经验证 40 节点全是 <module>/0 边)。
  // 只保留进程入口对应的 root + 出边最大的 8 个组合根;其余 root 仍是节点(kind=root),只是不标入口。
  if (level === "function") {
    const rootEntries = [...entries]
      .filter(([key, info]) => key.startsWith("r:") && info.kind !== "process")
      .sort((a, b) => weightOf(work.get(b[0])!) - weightOf(work.get(a[0])!));
    const keepRoots = new Set(rootEntries.slice(0, 8).map(([key]) => key));
    for (const [key, info] of rootEntries) {
      if (info.kind === "module-root" && !keepRoots.has(key)) entries.delete(key);
    }
  }

  // ---- 分类 + 入口兜底 ----
  if (entries.size === 0) {
    const trunks = [...work.values()]
      .filter((n) => n.inSet.size === 0 && n.outSet.size > 0)
      .sort((a, b) => weightOf(b) - weightOf(a))
      .slice(0, 8);
    for (const n of trunks) entries.set(n.key, { kind: "trunk" });
    if (trunks.length > 0) notes.push("未识别到进程入口,按「入度 0 + 扇出最大」取 Top 8 作为流程起点(trunk 兜底)");
  }

  // ---- 方向邻接 + 入口 BFS 分层 ----
  const adj = new Map<string, string[]>();
  const radj = new Map<string, string[]>();
  for (const e of edgeMap.values()) {
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    (radj.get(e.to) ?? radj.set(e.to, []).get(e.to)!).push(e.from);
  }
  const depth = new Map<string, number>();
  {
    const queue: string[] = [];
    for (const key of entries.keys()) {
      if (!work.has(key) || depth.has(key)) continue;
      depth.set(key, 0);
      queue.push(key);
    }
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i]!;
      const d = depth.get(cur)!;
      for (const nxt of adj.get(cur) ?? []) {
        if (depth.has(nxt)) continue;
        depth.set(nxt, d + 1);
        queue.push(nxt);
      }
    }
  }

  // ---- 目标子图(code2flow --target-function --upstream-depth/--downstream-depth) ----
  let center: string | undefined;
  let targetKeep: Set<string> | null = null;
  let targetDist: Map<string, number> | null = null;
  if (opts.target && opts.target.trim()) {
    const target = opts.target.trim();
    const hit = resolveFlowTarget(work, level, target);
    if (!hit) {
      const cands = suggestFlowTargets(work, level, target);
      throw new FlowTargetError(
        `未找到 flow 目标: ${target}(${level} 层可用目标示例: ${cands.slice(0, 5).join(", ") || "无"})`,
        cands);
    }
    center = hit;
    targetKeep = new Set([hit]);
    targetDist = new Map([[hit, 0]]);
    const up = Math.max(0, opts.upstream ?? 2);
    const down = Math.max(0, opts.downstream ?? 2);
    if (up === 0 && down === 0) notes.push("upstream/downstream 均为 0:只输出目标节点本身");
    for (let d = 1; d <= up; d++) {
      const frontier = [...targetDist.entries()].filter(([, v]) => v === d - 1).map(([k]) => k);
      for (const k of frontier) for (const prev of radj.get(k) ?? []) if (!targetDist.has(prev)) targetDist.set(prev, d);
    }
    for (let d = 1; d <= down; d++) {
      const frontier = [...targetDist.entries()].filter(([, v]) => v === d - 1).map(([k]) => k);
      for (const k of frontier) for (const nxt of adj.get(k) ?? []) if (!targetDist.has(nxt)) targetDist.set(nxt, d);
    }
    targetKeep = new Set(targetDist.keys());
  }

  // ---- 裁剪(孤立) + 预算 ----
  const nodesTotal = work.size;
  const edgesTotal = edgeMap.size;
  let kept = new Map(work);
  let isolatedDropped = 0;
  if (!keepIsolated) {
    for (const [key, n] of work) {
      if (entries.has(key) || key === center) continue;
      if (n.inSet.size === 0 && n.outSet.size === 0 && n.internalCalls === 0) {
        kept.delete(key);
        isolatedDropped++;
      }
    }
  }
  if (targetKeep) {
    for (const key of [...kept.keys()]) if (!targetKeep.has(key)) kept.delete(key);
  }

  let budgetNodesDropped = 0;
  const limitNodes = maxNodes > 0 ? maxNodes : Number.POSITIVE_INFINITY;
  if (kept.size > limitNodes) {
    const ranked = [...kept.values()].sort((a, b) => {
      if (targetDist) {
        const da = targetDist.get(a.key) ?? 1e9;
        const db = targetDist.get(b.key) ?? 1e9;
        if (da !== db) return da - db;
      } else {
        // 入口不是「绝对先占」:权重加成(500)让网关这类大入口先留,同时让 1 条出边的
        // 小启动脚本给 200 条入边的枢纽让位——否则 file 层 29 个入口会把 60 的预算吃满。
        const ra = (depth.get(a.key) ?? -1) >= 0 ? 0 : 1;
        const rb = (depth.get(b.key) ?? -1) >= 0 ? 0 : 1;
        if (ra !== rb) return ra - rb;
        const sa = weightOf(a) + (entries.has(a.key) ? 500 : 0);
        const sb = weightOf(b) + (entries.has(b.key) ? 500 : 0);
        if (sa !== sb) return sb - sa;
      }
      return weightOf(b) - weightOf(a) || a.key.localeCompare(b.key);
    });
    const keepSet = new Set(ranked.slice(0, limitNodes).map((n) => n.key));
    for (const key of [...kept.keys()]) if (!keepSet.has(key)) { kept.delete(key); budgetNodesDropped++; }
  }

  const keptEdges = [...edgeMap.values()].filter((e) => kept.has(e.from) && kept.has(e.to));
  let budgetEdgesDropped = 0;
  const edgeCap = maxEdges > 0 ? maxEdges : Number.POSITIVE_INFINITY;
  if (keptEdges.length > edgeCap) {
    keptEdges.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    budgetEdgesDropped = keptEdges.length - edgeCap;
    keptEdges.length = edgeCap;
  }
  // 预算砍掉邻居后可能出现「悬空节点」:非入口/非目标且零可见边 → 一并移除(有 entry 的保留)。
  let recheck = true;
  while (recheck) {
    recheck = false;
    const visible = new Set<string>();
    for (const e of keptEdges) { visible.add(e.from); visible.add(e.to); }
    for (const [key, n] of kept) {
      if (entries.has(key) || key === center) continue;
      if (!visible.has(key) && n.inSet.size + n.outSet.size > 0) {
        kept.delete(key);
        budgetNodesDropped++;
        recheck = true;
      }
    }
    if (recheck) {
      for (let i = keptEdges.length - 1; i >= 0; i--) {
        const e = keptEdges[i]!;
        if (!kept.has(e.from) || !kept.has(e.to)) keptEdges.splice(i, 1);
      }
    }
  }

  // ---- 输出节点/分组 ----
  const groupMinDepth = new Map<string, number>();
  const outNodes: FlowNode[] = [];
  for (const n of kept.values()) {
    const d = depth.get(n.key) ?? -1;
    const inC = n.inSet.size;
    const outC = n.outSet.size;
    let kind: FlowNodeKind;
    if (n.entryKind === "process" || n.entryKind === "module-root") kind = inC === 0 ? "trunk" : "regular";
    else if (inC === 0 && outC === 0) kind = n.internalCalls > 0 ? "leaf" : "isolated";
    else if (inC === 0) kind = "trunk";
    else if (outC === 0) kind = "leaf";
    else kind = "regular";
    if (n.key.startsWith("r:") && !n.entryKind) kind = "root";
    const entryInfo = entries.get(n.key);
    const rootLike = n.key.startsWith("r:");
    const dForSort = entryInfo || rootLike ? 0 : d;
    const gm = groupMinDepth.get(n.group);
    if (gm === undefined || dForSort < gm) groupMinDepth.set(n.group, dForSort);
    const files = n.filesSet?.size;
    const symbols = level === "function"
      ? 1
      : n.filesSet
        ? [...n.filesSet].reduce((sum, f) => sum + (callableByFile.get(f)?.length ?? 0), 0)
        : (callableByFile.get(n.file ?? "")?.length ?? 0);
    outNodes.push({
      id: n.key,
      label: n.label,
      group: n.group,
      ...(n.parentGroup ? { parentGroup: n.parentGroup } : {}),
      ...(n.file ? { file: n.file } : {}),
      ...(n.line ? { line: n.line } : {}),
      kind,
      entry: entries.has(n.key),
      ...(entryInfo ? { entryKind: entryInfo.kind, ...(entryInfo.label ? { entryLabel: entryInfo.label } : {}) } : {}),
      depth: dForSort,
      out: outC,
      in: inC,
      outCalls: n.outCalls,
      inCalls: n.inCalls,
      internalCalls: n.internalCalls,
      unresolved: n.unresolved,
      symbols,
      ...(files !== undefined ? { files } : {}),
      ...(n.cls ? { cls: n.cls } : {}),
    });
  }
  outNodes.sort((a, b) => {
    const ga = groupMinDepth.get(a.group) ?? Number.MAX_SAFE_INTEGER;
    const gb = groupMinDepth.get(b.group) ?? Number.MAX_SAFE_INTEGER;
    if (ga !== gb) return ga - gb;
    if (a.group !== b.group) return a.group.localeCompare(b.group);
    if (a.entry !== b.entry) return a.entry ? -1 : 1;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return (b.outCalls + b.inCalls) - (a.outCalls + a.inCalls) || a.label.localeCompare(b.label);
  });

  // 目标子图:分层改为「距目标的跳数」(上游/下游合并),否则 text 的 d0.. 仍按整仓入口算,会误导。
  if (targetDist) {
    for (const n of outNodes) n.depth = targetDist.get(n.id) ?? -1;
    notes.push("目标子图:depth=距目标跳数(上游/下游合并);入口节仍列整仓入口,便于回到主线");
  }

  const groups: FlowGroup[] = [];
  const groupSeen = new Set<string>();
  for (const n of outNodes) {
    if (!groupSeen.has(n.group)) {
      groupSeen.add(n.group);
      const def = groupDefs.get(n.group);
      groups.push({ id: n.group, label: def?.label ?? n.group });
    }
    if (n.parentGroup && !groupSeen.has(n.parentGroup)) {
      groupSeen.add(n.parentGroup);
      const def = groupDefs.get(n.parentGroup);
      groups.push({ id: n.parentGroup, label: def?.label ?? n.parentGroup, parent: n.group });
    }
  }
  // 父分组先于子分组(渲染器按序展开)
  groups.sort((a, b) => {
    const pa = a.parent ? 1 : 0;
    const pb = b.parent ? 1 : 0;
    if (pa !== pb) return pa - pb;
    const da = groupMinDepth.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const db = groupMinDepth.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    return a.label.localeCompare(b.label);
  });

  outNodes.sort((a, b) => {
    const ia = groups.findIndex((g) => g.id === (a.parentGroup ?? a.group));
    const ib = groups.findIndex((g) => g.id === (b.parentGroup ?? b.group));
    if (ia !== ib) return ia - ib;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return (b.outCalls + b.inCalls) - (a.outCalls + a.inCalls) || a.label.localeCompare(b.label);
  });

  const outEdges: FlowEdge[] = keptEdges
    .map((e) => ({ ...e }))
    .sort((a, b) => {
      const da = (depth.get(a.from) ?? 999) - (depth.get(b.from) ?? 999);
      if (da !== 0) return da;
      return b.count - a.count || a.from.localeCompare(b.from);
    });

  const stats: FlowStats = {
    nodesTotal,
    edgesTotal,
    nodesShown: outNodes.length,
    edgesShown: outEdges.length,
    nodesOmitted: nodesTotal - outNodes.length,
    edgesOmitted: edgesTotal - outEdges.length,
    isolatedDropped,
    budgetNodesDropped,
    budgetEdgesDropped,
    unresolvedCalls,
    internalCalls,
    bridgeEdges,
    classEdgesDropped,
    lexicalExcluded,
    sourceFiles: level === "function" ? new Set(index.nodes.filter((n) => allow(n.file)).map((n) => n.file)).size : Object.keys(index.byFile).filter(allow).length,
    sourceSymbols: index.nodes.filter((n) => callableNode(n) && allow(n.file)).length,
    sourceEdges: index.edges.filter((e) => allow(fileOfId(index, byId, e.from))).length,
    truncated: nodesTotal > outNodes.length || edgesTotal > outEdges.length,
  };

  if (level === "function" && stats.sourceSymbols > outNodes.length) {
    notes.push(`函数级全仓 ${stats.sourceSymbols} 个可调用符号;本次显式收窄保留 ${outNodes.length} 个(--max-nodes;缺省 0=全量)`);
  }
  if (stats.classEdgesDropped > 0) notes.push(`${stats.classEdgesDropped} 条「实例化类」边未入图(类在 function 层是分组;构造器不具名时无法落点)`);
  if (lexicalExcluded > 0) notes.push(`${lexicalExcluded} 个词法兜底档符号未入图(零调用边的结构覆盖产物)`);

  return {
    level,
    root: index.root,
    direction,
    nodes: outNodes,
    edges: outEdges,
    groups,
    entries: [...entries.keys()].filter((k) => kept.has(k)),
    ...(center ? { center } : {}),
    stats,
    notes,
  };
}

function resolveFlowTarget(work: Map<string, WorkNode>, level: FlowLevel, target: string): string | null {
  const t = target.replace(/\\/g, "/");
  const vals = [...work.values()];
  if (level === "function") {
    const exact = vals.find((n) => n.label === t);
    if (exact) return exact.key;
    const suffix = vals.filter((n) => n.label.endsWith("." + t));
    if (suffix.length === 1) return suffix[0]!.key;
    return null;
  }
  if (level === "file") {
    const exact = vals.find((n) => n.file === t);
    if (exact) return exact.key;
    const suffix = vals.filter((n) => n.file?.endsWith("/" + t));
    if (suffix.length === 1) return suffix[0]!.key;
    return null;
  }
  const exact = vals.find((n) => n.label === t);
  if (exact) return exact.key;
  const suffix = vals.filter((n) => n.label.endsWith("/" + t));
  if (suffix.length === 1) return suffix[0]!.key;
  const viaPath = vals.find((n) => n.key === "m:" + moduleGroupOf(t));
  return viaPath?.key ?? null;
}

function suggestFlowTargets(work: Map<string, WorkNode>, level: FlowLevel, target: string): string[] {
  const t = target.toLowerCase();
  const vals = [...work.values()];
  const labelOf = (n: WorkNode): string => (level === "file" ? n.file ?? n.label : n.label);
  const scored = vals
    .map((n) => ({ n, s: labelOf(n).toLowerCase() }))
    .filter(({ s }) => s.includes(t) || t.includes(s))
    .sort((a, b) => (b.n.outCalls + b.n.inCalls) - (a.n.outCalls + a.n.inCalls));
  if (scored.length > 0) return scored.slice(0, 10).map(({ n }) => labelOf(n));
  return vals
    .sort((a, b) => (b.outCalls + b.inCalls) - (a.outCalls + a.inCalls))
    .slice(0, 10)
    .map(labelOf);
}

// ---- 渲染 ----

/** 子图抽取:按节点集合裁一张 flow(保留内部边/分组/入口/center)。
 * 用于代码档案里的「单功能线」图:从整仓图上剪下游模块子集,不重新扫索引。 */
export function filterCodeFlow(flow: CodeFlow, keep: Set<string>): CodeFlow {
  const nodes = flow.nodes.filter((n) => keep.has(n.id));
  const ids = new Set(nodes.map((n) => n.id));
  const groups: FlowGroup[] = [];
  const needed = new Set<string>();
  for (const n of nodes) {
    needed.add(n.group);
    if (n.parentGroup) needed.add(n.parentGroup);
  }
  // 父分组闭包(子分组渲染需要父分组在前)
  const byId = new Map(flow.groups.map((g) => [g.id, g]));
  for (const id of [...needed]) {
    let cur = byId.get(id);
    while (cur?.parent && !needed.has(cur.parent)) {
      needed.add(cur.parent);
      cur = byId.get(cur.parent);
    }
  }
  for (const g of flow.groups) if (needed.has(g.id)) groups.push(g);
  const edges = flow.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const stats: FlowStats = {
    ...flow.stats,
    nodesTotal: nodes.length,
    edgesTotal: edges.length,
    nodesShown: nodes.length,
    edgesShown: edges.length,
    nodesOmitted: 0,
    edgesOmitted: 0,
    isolatedDropped: 0,
    budgetNodesDropped: 0,
    budgetEdgesDropped: 0,
    truncated: false,
  };
  return {
    ...flow,
    nodes,
    edges,
    groups,
    entries: flow.entries.filter((id) => ids.has(id)),
    ...(flow.center && ids.has(flow.center) ? { center: flow.center } : {}),
    stats,
  };
}

function escMermaid(s: string): string {
  // 标签在 mermaid 里会再过一层 HTML;引号/尖括号/竖线是最常见的断图源。
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "'")
    .replace(/</g, "(")
    .replace(/>/g, ")")
    .replace(/\|/g, "/")
    .replace(/\n/g, " ");
}

/** 模块作用斜体注释:≤46 字符,超过 24 字优先在空格/标点处折行(别把 Electron 劈成 Electr/on)。 */
function noteHtml(annotation: string | undefined): string {
  if (!annotation) return "";
  const t = annotation.length > 46 ? annotation.slice(0, 45) + "…" : annotation;
  let parts: string[] = [t];
  if (t.length > 24) {
    let cut = -1;
    for (const sep of [" ", "(", ")", "，", ",", ";", "；", "、", ":", "："]) {
      const at = t.lastIndexOf(sep, 24);
      if (at > cut) cut = at;
    }
    const at = cut >= 12 ? cut + 1 : 24;
    parts = [t.slice(0, at).trim(), t.slice(at).trim()].filter(Boolean);
  }
  return `<br/><i>${parts.map(escMermaid).join("<br/>")}</i>`;
}

function mermaidLabel(n: FlowNode, level: FlowLevel, annotation?: string): string {
  const icon = n.kind === "trunk" ? "▼" : n.kind === "leaf" ? "●" : n.kind === "root" ? "◆" : n.kind === "isolated" ? "◇" : "○";
  const star = n.entry ? "▶ " : "";
  if (n.label === "<module>") return `${star}◆ <module><br/>${escMermaid((n.file ?? "").split("/").pop() ?? "")}`;
  if (level === "function") {
    if (n.cls && n.label.startsWith(n.cls + ".")) {
      const rest = n.label.slice(n.cls.length + 1);
      return `${star}${icon} ${escMermaid(rest)}<br/>${escMermaid((n.file ?? "").split("/").pop() ?? "")}:${n.line ?? 0}`;
    }
    return `${star}${icon} ${escMermaid(n.label)}<br/>${escMermaid((n.file ?? "").split("/").pop() ?? "")}:${n.line ?? 0}`;
  }
  const meta: string[] = [];
  if (level === "module" && n.files !== undefined) meta.push(`${n.files} 文件`);
  if (n.symbols !== undefined && (level === "module" || n.symbols > 0)) meta.push(`${n.symbols} 符号`);
  if (n.internalCalls > 0) meta.push(`内部 ${n.internalCalls}`);
  return `${star}${icon} ${escMermaid(n.label)}${meta.length ? "<br/>" + escMermaid(meta.join(" · ")) : ""}${noteHtml(annotation)}`;
}

function dominantEdgeColor(e: FlowEdge): string {
  if (e.bridge) return "#d08a3a";
  const kinds = Object.entries(e.kinds).filter(([k]) => k !== "bridge") as [C2fEdge["kind"], number][];
  kinds.sort((a, b) => b[1] - a[1]);
  const kind = kinds[0]?.[0] ?? "unique";
  return kind === "this" ? "#c98f45" : kind === "import" ? "#5b8ec9" : kind === "unresolved" ? "#6b5c4a" : "#5aa06a";
}

/** code2flow 风格 mermaid:flowchart + 分组子图 + trunk/leaf/regular 三色 + 边按调用类型着色。
 * 图给人看;结构化数据走 buildCodeFlow 的 JSON。 */
export function renderCodeFlowMermaid(flow: CodeFlow, opts: { legend?: boolean; annotations?: Record<string, string> } = {}): string {
  const legend = opts.legend !== false;
  const anns = opts.annotations ?? flow.annotations;
  const lines: string[] = [`flowchart ${flow.direction}`];
  const idOf = new Map<string, string>();
  let seq = 0;
  const nid = (id: string): string => {
    if (!idOf.has(id)) idOf.set(id, "n" + seq++);
    return idOf.get(id)!;
  };
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const groupNodes = new Map<string, FlowNode[]>();
  for (const n of flow.nodes) {
    const gid = n.parentGroup ?? n.group;
    const list = groupNodes.get(gid) ?? [];
    list.push(n);
    groupNodes.set(gid, list);
  }
  const children = new Map<string | undefined, FlowGroup[]>();
  for (const g of flow.groups) {
    const list = children.get(g.parent) ?? [];
    list.push(g);
    children.set(g.parent, list);
  }
  const gidOf = new Map(flow.groups.map((g, i) => [g.id, "g" + i]));
  const emitGroup = (g: FlowGroup, indent: string): void => {
    lines.push(`${indent}subgraph ${gidOf.get(g.id) ?? "gx"}["${escMermaid(g.label)}"]`);
    for (const n of groupNodes.get(g.id) ?? []) lines.push(`${indent}  ${nid(n.id)}["${mermaidLabel(n, flow.level, anns?.[n.label])}"]`);
    for (const c of children.get(g.id) ?? []) emitGroup(c, indent + "  ");
    lines.push(`${indent}end`);
  };
  for (const g of children.get(undefined) ?? []) emitGroup(g, "  ");
  // 没有分组归属的节点(理论不发生,防御)
  for (const n of flow.nodes) {
    const gid = n.parentGroup ?? n.group;
    if (!groupNodes.has(gid) && !flow.groups.some((g) => g.id === gid)) lines.push(`  ${nid(n.id)}["${mermaidLabel(n, flow.level, anns?.[n.label])}"]`);
  }

  const linkColors = new Map<string, number[]>();
  const bridgeIdx: number[] = [];
  flow.edges.forEach((e, i) => {
    const from = nid(e.from);
    const to = nid(e.to);
    if (e.bridge) {
      lines.push(`  ${from} -.->|${escMermaid(e.label ?? "bridge")}| ${to}`);
      bridgeIdx.push(i);
      return;
    }
    const kinds = Object.entries(e.kinds).filter(([k]) => k !== "bridge") as [C2fEdge["kind"], number][];
    kinds.sort((a, b) => b[1] - a[1]);
    const kind = kinds[0]?.[0] ?? "unique";
    const color = kind === "this" ? "#c98f45" : kind === "import" ? "#5b8ec9" : kind === "unresolved" ? "#6b5c4a" : "#5aa06a";
    const arr = linkColors.get(color) ?? [];
    arr.push(i);
    linkColors.set(color, arr);
    lines.push(`  ${from} -->${e.count > 1 ? `|×${e.count}|` : ""} ${to}`);
  });

  lines.push("  classDef fTrunk fill:#8a5a2a,stroke:#c98f45,color:#fff;");
  lines.push("  classDef fLeaf fill:#5aa06a,stroke:#7ec98f,color:#08240f;");
  lines.push("  classDef fRegular fill:#4a4440,stroke:#8a7a5a,color:#ece1d1;");
  lines.push("  classDef fIsolated fill:#2a2420,stroke:#6b5c4a,color:#a89480,stroke-dasharray:4 3;");
  lines.push("  classDef fRoot fill:#6a4a8a,stroke:#b08ad0,color:#fff;");
  const classes: Record<string, string[]> = { fTrunk: [], fLeaf: [], fRegular: [], fIsolated: [], fRoot: [] };
  for (const n of flow.nodes) {
    const cls = n.kind === "trunk" ? "fTrunk" : n.kind === "leaf" ? "fLeaf" : n.kind === "root" ? "fRoot" : n.kind === "isolated" ? "fIsolated" : "fRegular";
    classes[cls]!.push(nid(n.id));
  }
  for (const [cls, ids] of Object.entries(classes)) if (ids.length) lines.push(`  class ${ids.join(",")} ${cls};`);
  for (const [color, idxs] of linkColors) lines.push(`  linkStyle ${idxs.join(",")} stroke:${color},stroke-width:2px;`);
  if (bridgeIdx.length) lines.push(`  linkStyle ${bridgeIdx.join(",")} stroke:#d08a3a,stroke-width:2px,stroke-dasharray:4 3;`);
  for (const n of flow.nodes) if (n.entry) lines.push(`  style ${nid(n.id)} stroke:#ffd27f,stroke-width:3px`);
  if (flow.center) lines.push(`  style ${nid(flow.center)} fill:#c98f45,stroke:#ece1d1,color:#0b0806,font-weight:bold`);

  if (legend) {
    lines.push('  subgraph lg["图例"]');
    lines.push('    lg0["▼ 入口/trunk(无人调用)"]');
    lines.push('    lg1["● leaf(不调他人)"]');
    lines.push('    lg2["○ regular"]');
    lines.push('    lg3["⇢ 跨语言 HTTP 桥"]');
    lines.push("  end");
    lines.push("  class lg0 fTrunk;");
    lines.push("  class lg1 fLeaf;");
    lines.push("  class lg2 fRegular;");
    lines.push("  class lg3 fIsolated;");
  }
  return lines.join("\n");
}

/** graphviz DOT(与 code2flow 的写盘形态同族:rankdir/splines/cluster/三色节点)。 */
export function renderCodeFlowDot(flow: CodeFlow, opts: { legend?: boolean; annotations?: Record<string, string> } = {}): string {
  const legend = opts.legend !== false;
  const anns = opts.annotations ?? flow.annotations;
  const idOf = new Map<string, string>();
  let seq = 0;
  const nid = (id: string): string => {
    if (!idOf.has(id)) idOf.set(id, "n" + seq++);
    return idOf.get(id)!;
  };
  const esc = (s: string): string => s.replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
  const lines: string[] = ["digraph code_flow {"];
  lines.push(`  graph [rankdir="${flow.direction}", splines="ortho", concentrate=true, fontname="Helvetica", fontsize=10, bgcolor="transparent"];`);
  lines.push('  node [shape="box", style="rounded,filled", fontname="Helvetica", fontsize=10, color="#8a7a5a"];');
  lines.push('  edge [color="#8a7a5a", fontname="Helvetica", fontsize=9];');
  const byGroup = new Map<string, FlowNode[]>();
  for (const n of flow.nodes) {
    const gid = n.parentGroup ?? n.group;
    const list = byGroup.get(gid) ?? [];
    list.push(n);
    byGroup.set(gid, list);
  }
  const children = new Map<string | undefined, FlowGroup[]>();
  for (const g of flow.groups) {
    const list = children.get(g.parent) ?? [];
    list.push(g);
    children.set(g.parent, list);
  }
  const gidOf = new Map(flow.groups.map((g, i) => [g.id, "cluster_g" + i]));
  const nodeLine = (n: FlowNode): string => {
    const meta: string[] = [];
    if (flow.level === "module") {
      if (n.files !== undefined) meta.push(`${n.files} 文件`);
      if (n.symbols !== undefined) meta.push(`${n.symbols} 符号`);
    } else if (flow.level === "file") {
      if (n.symbols !== undefined) meta.push(`${n.symbols} 符号`);
    } else if (n.line) {
      meta.push(`:${n.line}`);
    }
    if (n.internalCalls > 0) meta.push(`内部 ${n.internalCalls}`);
    const ann = flow.level === "module" ? anns?.[n.label] : undefined;
    const annClip = ann ? (ann.length > 46 ? ann.slice(0, 45) + "…" : ann) : "";
    const label = n.label === "<module>"
      ? `◆ <module>\n${(n.file ?? "").split("/").pop() ?? ""}`
      : `${n.entry ? "▶ " : ""}${n.label}${meta.length ? "\n" + meta.join(" · ") : ""}${annClip ? "\n" + annClip : ""}`;
    const fill = n.kind === "trunk" ? "#966F33" : n.kind === "leaf" ? "#6db33f" : n.kind === "root" ? "#6a4a8a" : n.kind === "isolated" ? "#2a2420" : "#cccccc";
    const font = n.kind === "leaf" || n.kind === "regular" ? "#0b0806" : "#ffffff";
    const extra = n.entry ? ', peripheries=2, penwidth=2, color="#ffd27f"' : "";
    return `    ${nid(n.id)} [label="${esc(label)}", fillcolor="${fill}", fontcolor="${font}"${extra}];`;
  };
  const emitGroup = (g: FlowGroup): void => {
    lines.push(`  subgraph ${gidOf.get(g.id) ?? "cluster_x"} {`);
    lines.push(`    label="${esc(g.label)}";`);
    lines.push('    style="dotted";');
    for (const n of byGroup.get(g.id) ?? []) lines.push(nodeLine(n));
    for (const c of children.get(g.id) ?? []) emitGroup(c);
    lines.push("  }");
  };
  for (const g of children.get(undefined) ?? []) emitGroup(g);
  for (const n of flow.nodes) if (!byGroup.has(n.parentGroup ?? n.group)) lines.push(nodeLine(n));
  for (const e of flow.edges) {
    const color = dominantEdgeColor(e);
    const style = e.bridge ? ', style="dashed"' : "";
    const label = e.bridge ? (e.label ?? "bridge") : e.count > 1 ? "×" + e.count : "";
    lines.push(`  ${nid(e.from)} -> ${nid(e.to)} [${label ? `label="${esc(label)}", ` : ""}color="${color}", penwidth="2"${style}];`);
  }
  if (legend) {
    lines.push('  subgraph cluster_legend {');
    lines.push('    label="图例"; style="dotted";');
    lines.push('    lg0 [label="▼ 入口/trunk(无人调用)", fillcolor="#966F33", fontcolor="#ffffff"];');
    lines.push('    lg1 [label="● leaf(不调他人)", fillcolor="#6db33f", fontcolor="#0b0806"];');
    lines.push('    lg2 [label="○ regular", fillcolor="#cccccc", fontcolor="#0b0806"];');
    lines.push('    lg3 [label="⇢ 跨语言 HTTP 桥", fillcolor="#2a2420", fontcolor="#a89480"];');
    lines.push("  }");
  }
  lines.push("}");
  return lines.join("\n");
}

function nodeTitle(n: FlowNode): string {
  if (n.label === "<module>") return `<module> @ ${n.file ?? "?"}`;
  return `${n.label}${n.file ? ` @ ${n.file}${n.line ? ":" + n.line : ""}` : ""}`;
}

/** 人类面短标签:function 层的 root 节点都叫 <module>,必须带文件区分(否则入口表/边全是同名)。 */
function displayLabel(n: FlowNode | undefined, fallback: string): string {
  if (!n) return fallback;
  if (n.label === "<module>") return `<module>@${n.file ?? "?"}`;
  return n.label;
}

/** 人类/agent 文本面:入口、主干路径、分层、枢纽、裁剪口径。 */
export function renderCodeFlowText(flow: CodeFlow, opts: { maxEdges?: number; maxLayers?: number } = {}): string {
  const maxEdges = opts.maxEdges ?? 12;
  const maxLayers = opts.maxLayers ?? 6;
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const st = flow.stats;
  const lines: string[] = [];
  const levelName = flow.level === "module" ? "模块级" : flow.level === "file" ? "文件级" : "函数级";
  lines.push(`整仓代码流 · ${levelName} · ${st.nodesShown} 节点 / ${st.edgesShown} 边 · 入口 ${flow.entries.length}${st.nodesOmitted || st.edgesOmitted ? ` · 省略 ${st.nodesOmitted} 节点 / ${st.edgesOmitted} 边` : ""}`);
  lines.push(`根: ${flow.root}`);

  const entryNodes = flow.nodes.filter((n) => n.entry);
  lines.push("");
  lines.push("入口(流程起点):");
  if (entryNodes.length === 0) lines.push("  (无:本图没有可识别的入口)");
  for (const n of entryNodes.slice(0, 10)) {
    const why = n.entryKind === "process" ? `进程入口${n.entryLabel ? " " + n.entryLabel : ""}` : n.entryKind === "module-root" ? (n.entryLabel ?? "模块级启动调用") : "入度 0(trunk)";
    lines.push(`  ▶ ${displayLabel(n, n.label)} — ${why} · 出 ${n.outCalls}/入 ${n.inCalls}`);
  }
  if (entryNodes.length > 10) lines.push(`  …还有 ${entryNodes.length - 10} 个入口`);

  // 主干路径:从每个入口按调用量贪心走,避开环。
  const outgoing = new Map<string, FlowEdge[]>();
  for (const e of flow.edges) (outgoing.get(e.from) ?? outgoing.set(e.from, []).get(e.from)!).push(e);
  for (const list of outgoing.values()) list.sort((a, b) => b.count - a.count);
  const paths: string[] = [];
  for (const entry of entryNodes.slice(0, 3)) {
    const walk: string[] = [displayLabel(entry, entry.label)];
    const seen = new Set<string>([entry.id]);
    let cur = entry.id;
    for (let hop = 0; hop < 4; hop++) {
      const next = (outgoing.get(cur) ?? []).find((e) => !seen.has(e.to));
      if (!next) break;
      const n = byId.get(next.to);
      if (!n) break;
      walk.push(displayLabel(n, n.label));
      seen.add(next.to);
      cur = next.to;
    }
    if (walk.length > 1) paths.push(walk.join(" → "));
  }
  if (paths.length > 0) {
    lines.push("");
    lines.push("主干路径(入口按调用量贪心,≤4 跳):");
    for (const p of paths) lines.push(`  ${p}`);
  }

  lines.push("");
  lines.push(`主要流(边 Top ${Math.min(maxEdges, flow.edges.length)},×N=调用点数):`);
  if (flow.edges.length === 0) lines.push("  (无:索引里没有解析到跨节点调用)");
  for (const e of flow.edges.slice(0, maxEdges)) {
    const a = displayLabel(byId.get(e.from), e.from);
    const b = displayLabel(byId.get(e.to), e.to);
    lines.push(`  ${a} → ${b} ×${e.count}${e.bridge ? " [HTTP 桥]" : ""}`);
  }

  const layers = new Map<number, FlowNode[]>();
  for (const n of flow.nodes) {
    if (n.depth < 0) continue;
    const list = layers.get(n.depth) ?? [];
    list.push(n);
    layers.set(n.depth, list);
  }
  if (layers.size > 0) {
    lines.push("");
    lines.push(`分层(距最近入口跳数,d0=入口):`);
    const depthKeys = [...layers.keys()].sort((a, b) => a - b).slice(0, maxLayers);
    for (const d of depthKeys) {
      const list = layers.get(d)!.sort((a, b) => (b.outCalls + b.inCalls) - (a.outCalls + a.inCalls));
      const names = list.slice(0, 8).map((n) => displayLabel(n, n.label));
      lines.push(`  d${d}: ${names.join(", ")}${list.length > 8 ? ` …+${list.length - 8}` : ""}`);
    }
    const unreachable = flow.nodes.filter((n) => n.depth < 0).length;
    if (unreachable > 0) lines.push(`  不可达: ${unreachable} 个节点(没有从入口出发的调用路径)`);
  }

  const hubs = flow.nodes.filter((n) => n.in > 0).sort((a, b) => b.inCalls - a.inCalls).slice(0, 6);
  if (hubs.length > 0) {
    lines.push("");
    lines.push("枢纽(被依赖最多):");
    for (const n of hubs) lines.push(`  ${displayLabel(n, n.label)} — 入边 ${n.inCalls} / 上游 ${n.in}`);
  }

  // 模块作用/角色:有 package.json/README/docstring 用原文;≈=名称/拓扑推断(来源见 --json)
  if (flow.level === "module" && flow.annotations) {
    const items = flow.nodes.map((n) => ({ label: n.label, note: flow.annotations![n.label] })).filter((x) => x.note);
    if (items.length > 0) {
      lines.push("");
      lines.push("模块作用/角色(斜体=文档/README/注释;≈=名称/拓扑推断):");
      for (const it of items) lines.push(`  ${it.label} — ${it.note}`);
    }
  }

  const notes: string[] = [];
  if (st.isolatedDropped > 0) notes.push(`已裁掉 ${st.isolatedDropped} 个零连接节点(code2flow 默认口径;--keep-isolated 保留)`);
  if (st.budgetNodesDropped || st.budgetEdgesDropped) notes.push(`预算裁剪:节点 -${st.budgetNodesDropped} / 边 -${st.budgetEdgesDropped}(--max-nodes / --max-edges 调整)`);
  if (st.unresolvedCalls > 0) notes.push(`${st.unresolvedCalls} 条调用未解析目标(外部库/动态形态),只计入脚下不画边`);
  if (st.internalCalls > 0) notes.push(`${st.internalCalls} 条组内调用(同文件/同模块内部,图上不画)`);
  if (st.bridgeEdges > 0) notes.push(`已接入 ${st.bridgeEdges} 条跨语言 HTTP 桥边(虚线)`);
  if (st.classEdgesDropped > 0) notes.push(`${st.classEdgesDropped} 条 new Class() 边未落点(类在 function 层是分组)`);
  notes.push(...flow.notes);
  if (notes.length > 0) {
    lines.push("");
    lines.push("口径:");
    for (const n of notes) lines.push(`  - ${n}`);
  }
  return lines.join("\n");
}

/** JSON 面:供 agent/外部工具消费(与文本/图同源,不裁字段)。 */
export function codeFlowJson(flow: CodeFlow): Record<string, unknown> {
  return {
    level: flow.level,
    root: flow.root,
    direction: flow.direction,
    stats: flow.stats,
    entries: flow.entries.map((id) => {
      const n = flow.nodes.find((x) => x.id === id);
      return { id, label: n?.label ?? id, entryKind: n?.entryKind, entryLabel: n?.entryLabel };
    }),
    ...(flow.center ? { center: flow.center } : {}),
    ...(flow.annotations ? { annotations: flow.annotations } : {}),
    groups: flow.groups,
    nodes: flow.nodes,
    edges: flow.edges,
    notes: flow.notes,
  };
}

/** 从 JSON 面重建节点标题(给 CLI --out 的 markdown 头/日志用)。 */
export function flowNodeTitle(n: FlowNode): string {
  return nodeTitle(n);
}