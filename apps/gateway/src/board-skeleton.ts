/**
 * 白板现状层骨架生成器(纯函数,零 IO):
 * 从 code-sense C2fIndex 快照按符号名清单生成 keep 节点 + 真实 call 边——
 * planner 之后在底版上补变更层(add/modify 带 before),不再手抄 file:line。
 *
 * 设计纪律(与工具侧 action=skeleton 分工):
 * - 本文件只做「索引→节点/边候选」的确定性转换;行号三态核验(linked/moved/broken)在
 *   agent-wiring 的 skeleton 分支用 resolveBoardLinksAsync 复核——生成侧不编造任何索引外事实。
 * - 零命中的符号进 unresolved(绝不编造节点);多候选(重名)全收,按 inCount+outCount 降序;
 * - maxNodes 钳 ≤40(板节点上限 60,给变更层留位);溢出者进 truncated 如实上报;
 * - 边只收两端都在生成节点集内的索引 edges,同向去重,上限=节点数×3;
 * - id=`sk-<符号名消毒>`(只留 [a-zA-Z0-9-]):同符号重复调用得同 id(幂等,mergeBoardNodes 按 id 合并)。
 */
import type { C2fIndex, C2fNode } from "@lampgenie/code-sense";

/** 板节点上限的骨架占用钳(板 60,给 planner 变更层留 20 位)。 */
export const SKELETON_MAX_NODES = 40;
/** symbols 入参上限:超则截断并如实报。 */
export const SKELETON_MAX_SYMBOLS = 20;

export interface SkeletonRequest {
  /** 符号名清单(code_sense 查到的名字;byName 命中)。 */
  symbols: string[];
  /** 可选文件清单:byFile[相对路径] 的符号并入候选(与 symbols 候选并集去重)。 */
  files?: string[];
  /** 节点上限(缺省 40,钳 ≤40)。 */
  maxNodes?: number;
}

export interface SkeletonNode {
  id: string;
  label: string;
  summary: string;
  kind: "module" | "function";
  change: "keep";
  targets: string[];
  symbolRef: { name: string; file: string; line: number };
}

export interface SkeletonEdge {
  from: string;
  to: string;
  kind: "call";
}

export interface SkeletonResult {
  nodes: SkeletonNode[];
  edges: SkeletonEdge[];
  /** 被上限截断的候选(节点或边溢出,如实上报)。 */
  truncated: string[];
  /** 索引里查无此名的符号(绝不编造节点)。 */
  unresolved: string[];
}

/** 请求侧钳制:symbols 去重 ≤20(超截断)、maxNodes 缺省 40 且钳 ≤40。
 * 有效候选 <2(去重后 symbols 与 files 全空/全无效)= 返回错误态由调用方拒。 */
export function normalizeSkeletonRequest(req: SkeletonRequest): {
  ok: true; symbols: string[]; files: string[]; maxNodes: number; truncatedSymbols: string[];
} | { ok: false; reason: string } {
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const raw of Array.isArray(req.symbols) ? req.symbols : []) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (!s || seen.has(s)) continue;
    seen.add(s);
    symbols.push(s);
  }
  const truncatedSymbols = symbols.length > SKELETON_MAX_SYMBOLS ? symbols.splice(SKELETON_MAX_SYMBOLS) : [];
  const files = (Array.isArray(req.files) ? req.files : [])
    .map((f) => (typeof f === "string" ? f.trim().replace(/^\.\//, "") : ""))
    .filter((f) => f !== "");
  const maxNodesRaw = typeof req.maxNodes === "number" && Number.isFinite(req.maxNodes) && req.maxNodes > 0 ? Math.floor(req.maxNodes) : SKELETON_MAX_NODES;
  const maxNodes = Math.min(maxNodesRaw, SKELETON_MAX_NODES);
  if (symbols.length + files.length < 2) {
    return { ok: false, reason: `有效候选不足(<2):symbols ${symbols.length} 个 + files ${files.length} 个——至少给 2 个符号名(或符号+文件)才能生成现状层骨架` };
  }
  return { ok: true, symbols, files, maxNodes, truncatedSymbols };
}

/** 节点 id:符号 id 消毒(只留 [a-zA-Z0-9-]),幂等——同符号重复生成得同 id。 */
function skeletonId(symbolId: string): string {
  const cleaned = symbolId.replace(/[^a-zA-Z0-9-]/g, "");
  return `sk-${cleaned === "" ? "sym" : cleaned}`;
}

/** label:显示名截 ≤14 字(与 LABEL_MAX_CHARS 同口径;超长落板会被截断+corrections,这里先截)。 */
function skeletonLabel(name: string): string {
  const chars = [...name];
  return chars.length <= 14 ? name : chars.slice(0, 14).join("");
}

/** kind 映射:symKind 函数族(function/method/arrow)→function;
 * class/interface/struct/type/typedef/enum(含缺席)→module 之外——缺席按 function(函数是调用图主体)。 */
function skeletonKind(symKind: string | undefined): "function" | "module" {
  if (!symKind) return "function";
  if (symKind === "function" || symKind === "method" || symKind === "arrow") return "function";
  if (symKind === "class" || symKind === "interface" || symKind === "struct" || symKind === "type" || symKind === "typedef" || symKind === "enum") return "module";
  return "function";
}

/** 签名摘要:`(a: T, b?: U) → R`;sig 缺席=「签名未收录」(如实,不猜)。 */
function sigSummary(n: C2fNode): string {
  if (!n.sig) return "签名未收录";
  const params = (n.sig.params ?? []).map((p) => p.name + (p.type ? ": " + p.type : "") + (p.optional ? "?" : "")).join(", ");
  const ret = n.sig.returnType ? " → " + n.sig.returnType : "";
  return `(${params})${ret}`;
}

/**
 * 从 C2fIndex 快照生成现状层骨架(keep 节点 + call 边)。
 * 只读 index,零 IO;所有截断/未命中进 truncated/unresolved 如实返回。
 */
export function buildSkeleton(index: C2fIndex, req: SkeletonRequest): SkeletonResult {
  const norm = normalizeSkeletonRequest(req);
  if (!norm.ok) return { nodes: [], edges: [], truncated: [], unresolved: [norm.reason] };
  const { symbols, files, maxNodes } = norm;
  const byId = new Map<string, C2fNode>();
  for (const n of index.nodes) byId.set(n.id, n);
  const truncated: string[] = [...norm.truncatedSymbols.map((s) => `symbol:${s}`)];
  const unresolved: string[] = [];

  // 候选收集:symbols 名字命中(byName)→ files 文件命中(byFile),按入参序并集去重(节点 id 级)。
  // 多候选(重名)全收,组内按 inCount+outCount 降序(枢纽符号排前,截断时保枢纽)。
  const candidateGroups: C2fNode[][] = [];
  for (const s of symbols) {
    const ids = index.byName[s] ?? [];
    if (ids.length === 0) { unresolved.push(s); continue; }
    const hits = ids.map((id) => byId.get(id)).filter((n): n is C2fNode => !!n);
    if (hits.length === 0) { unresolved.push(s); continue; }
    hits.sort((x, y) => (y.inCount + y.outCount) - (x.inCount + x.outCount));
    candidateGroups.push(hits);
  }
  for (const f of files) {
    const ids = index.byFile[f] ?? [];
    if (ids.length === 0) { truncated.push(`file:${f}`); continue; }
    const hits = ids.map((id) => byId.get(id)).filter((n): n is C2fNode => !!n);
    if (hits.length === 0) { truncated.push(`file:${f}`); continue; }
    hits.sort((x, y) => (y.inCount + y.outCount) - (x.inCount + x.outCount));
    candidateGroups.push(hits);
  }

  // 轮转并集去重:symbols 先、files 后,组间轮转交错(不饿死任何一组的枢纽)。
  const picked: C2fNode[] = [];
  const pickedIds = new Set<string>();
  for (let round = 0; picked.length < maxNodes; round++) {
    let advanced = false;
    for (const g of candidateGroups) {
      if (picked.length >= maxNodes) break;
      const n = g[round];
      if (!n) continue;
      advanced = true;
      if (pickedIds.has(n.id)) continue;
      if (g.length > 1 && round === 0 && pickedIds.has(n.id)) continue;
      pickedIds.add(n.id);
      picked.push(n);
    }
    if (!advanced) break;
  }
  // 溢出者如实报:候选总量(去重后)超过 maxNodes 的部分进 truncated。
  const candidateCount = new Set(candidateGroups.flat().map((n) => n.id)).size;
  if (candidateCount > maxNodes) {
    truncated.push(`candidates:${candidateCount}>maxNodes:${maxNodes}(保留枢纽优先的 ${maxNodes} 个)`);
  }

  const idOf = new Map<string, string>();
  for (const n of picked) idOf.set(n.id, skeletonId(n.id));
  const nodes: SkeletonNode[] = picked.map((n) => ({
    id: idOf.get(n.id)!,
    label: skeletonLabel(n.name),
    kind: skeletonKind(n.symKind),
    change: "keep",
    targets: [n.file],
    symbolRef: { name: n.name, file: n.file, line: n.line },
    summary: `${sigSummary(n)} · 调用 ${n.outCount}/被调 ${n.inCount} · ${n.file}:${n.line}`,
  }));

  // 边:仅收 from/to 两端 id 都在生成节点集内的索引 edges;同向去重;上限=节点数×3。
  const seenEdge = new Set<string>();
  const edges: SkeletonEdge[] = [];
  const edgeCap = nodes.length * 3;
  for (const e of index.edges) {
    if (edges.length >= edgeCap) {
      truncated.push(`edges:cap=${edgeCap}(同向去重后截断)`);
      break;
    }
    const from = idOf.get(e.from);
    const to = idOf.get(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    edges.push({ from, to, kind: "call" });
  }
  return { nodes, edges, truncated, unresolved };
}
