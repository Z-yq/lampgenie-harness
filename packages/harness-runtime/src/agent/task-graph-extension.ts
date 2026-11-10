/**
 * 运行时任务图扩展(Task Graph Extension)。
 *
 * 为什么需要它:
 * - 静态计划一次定死:collection 节点的产出可能少于目标,或执行过程中出现计划外的新完成节点,
 *   这时必须能「再问一次 planner」,否则前沿停滞也只能干等到全部结束。
 * - planner 一次返回的扩展可能带坏边(重复 id / 自环 / 指向不存在的节点 / 成环)。把坏边合进图里,
 *   后续所有遍历都会踩在悬空引用或死循环上——所以坏的一律拒收、冻结当前图。
 * - critic 说「这步不过」,但没有受控重开就是死局;无上限重开则是预算黑洞。
 *   因此重开只允许对终态节点(completed/failed/skipped)、每个节点有次数上限、整轮有轮数上限;
 *   重开只重置 exec/critic 两阶段,已完成的其它工作靠 replay 跳过。
 *
 * 纯逻辑:零 IO,不读文件/网络/环境,不依赖真实时钟;所有函数不抛异常——
 * 非法输入返回 { ok: false, code },调用方按稳定码断言,不解析文案。
 */

/** 节点种类:exec=执行步骤,collection=收集/聚合,critic=评审。 */
export type TaskNodeKind = "exec" | "collection" | "critic";

/** 节点状态:只有 completed/failed/skipped 是终态(可被 critic 重开)。 */
export type TaskNodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";

/** 节点阶段:重开只重置 exec 与 critic 两阶段。 */
export type TaskNodeStage = "exec" | "critic";

/** 图里的一个任务节点。reopens 是该节点已被 critic 重开的次数。 */
export interface TaskNode {
  id: string;
  kind: TaskNodeKind;
  status: TaskNodeStatus;
  reopens: number;
  stage: TaskNodeStage;
}

/** 有向边:from → to,表示先做 from 再做 to。 */
export interface TaskEdge {
  from: string;
  to: string;
}

/** 任务图:节点按数组存(顺序即插入序),边单列;analyzedNodeIds 记录已被 planner 看过的完成节点。 */
export interface TaskGraph {
  nodes: TaskNode[];
  edges: TaskEdge[];
  analyzedNodeIds: string[];
  plannerRuns: number;
  consecutiveErrors: number;
  /** planner 已达配额或连续出错超限:不再触发 planner,但不算失败。 */
  exhausted?: boolean;
}

/** planner 返回的新节点:除 id/kind 外都可省,合并时补缺省(pending/0/exec)。 */
export interface PlannerNode {
  id: string;
  kind: TaskNodeKind;
  status?: TaskNodeStatus;
  reopens?: number;
  stage?: TaskNodeStage;
}

/** planner 一次扩展的输出。collectionNodeIds 指向本次声明的 collection 节点(须已存在或在本次 nodes 内)。 */
export interface PlannerOutput {
  nodes: PlannerNode[];
  edges: TaskEdge[];
  collectionNodeIds: string[];
  /** planner 自己说「没有更多可扩展的了」。 */
  exhausted?: boolean;
}

/** 稳定码:调用方按码断言,不解析文案。 */
export const TASKGRAPH_CODES = {
  INVALID: "TASKGRAPH_INVALID",
  PLANNER_REQUIRED: "TASKGRAPH_PLANNER_REQUIRED",
  PLANNER_SKIPPED: "TASKGRAPH_PLANNER_SKIPPED",
  EXTENDED: "TASKGRAPH_EXTENDED",
  BAD_EDGE: "TASKGRAPH_BAD_EDGE",
  EXHAUSTED: "TASKGRAPH_EXHAUSTED",
  REOPENED: "TASKGRAPH_REOPENED",
  REOPEN_LIMIT: "TASKGRAPH_REOPEN_LIMIT",
  CRITIC_ROUND_LIMIT: "TASKGRAPH_CRITIC_ROUND_LIMIT",
  REPLAY_SKIPPED: "TASKGRAPH_REPLAY_SKIPPED",
} as const;

export type TaskGraphCode = (typeof TASKGRAPH_CODES)[keyof typeof TASKGRAPH_CODES];

/** 缺省配额:planner 最多跑 5 次;连续 3 次返回坏边就认命(标 exhausted,不算 failed)。 */
export const DEFAULT_MAX_PLANNER_RUNS = 5;
export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3;

/** critic 最多 3 轮;单节点最多重开 2 次。 */
export const DEFAULT_MAX_CRITIC_ROUNDS = 3;
export const DEFAULT_MAX_REOPENS_PER_NODE = 2;

/** 可被 critic 重开的终态。 */
const REOPENABLE_STATUSES: ReadonlySet<TaskNodeStatus> = new Set<TaskNodeStatus>(["completed", "failed", "skipped"]);

const KINDS: ReadonlySet<string> = new Set<string>(["exec", "collection", "critic"]);
const STATUSES: ReadonlySet<string> = new Set<string>(["pending", "running", "completed", "failed", "skipped"]);
const STAGES: ReadonlySet<string> = new Set<string>(["exec", "critic"]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 归一化单个节点;非法(缺 id)返回 undefined,由调用方决定 INVALID。 */
function normalizeNode(raw: unknown): TaskNode | undefined {
  if (!isRecord(raw)) return undefined;
  const id = raw["id"];
  if (typeof id !== "string" || id.trim() === "") return undefined;
  const kind = typeof raw["kind"] === "string" && KINDS.has(raw["kind"]) ? (raw["kind"] as TaskNodeKind) : "exec";
  const status =
    typeof raw["status"] === "string" && STATUSES.has(raw["status"]) ? (raw["status"] as TaskNodeStatus) : "pending";
  const stage = typeof raw["stage"] === "string" && STAGES.has(raw["stage"]) ? (raw["stage"] as TaskNodeStage) : "exec";
  const reopens =
    typeof raw["reopens"] === "number" && Number.isFinite(raw["reopens"]) && raw["reopens"] > 0 ? Math.floor(raw["reopens"]) : 0;
  return { id: id.trim(), kind, status, reopens, stage };
}

function normalizeNodeList(raw: unknown): TaskNode[] | undefined {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return undefined;
  const out: TaskNode[] = [];
  for (const item of raw) {
    const node = normalizeNode(item);
    if (!node) return undefined;
    out.push(node);
  }
  return out;
}

function normalizeEdges(raw: unknown): TaskEdge[] | undefined {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return undefined;
  const out: TaskEdge[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item) || typeof item["from"] !== "string" || typeof item["to"] !== "string") return undefined;
    const from = item["from"].trim();
    const to = item["to"].trim();
    if (from === "" || to === "") return undefined;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from, to });
  }
  return out;
}

function normalizeCount(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** 深拷贝(调用方拿到的图与入参永不共享引用:冻结/回滚靠不可变语义)。 */
export function cloneTaskGraph(graph: TaskGraph): TaskGraph {
  return {
    nodes: graph.nodes.map((node) => ({ ...node })),
    edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    analyzedNodeIds: [...graph.analyzedNodeIds],
    plannerRuns: graph.plannerRuns,
    consecutiveErrors: graph.consecutiveErrors,
    ...(graph.exhausted ? { exhausted: true } : {}),
  };
}

/** 建图:缺省空图;入参按节点补缺省(pending/0/exec)。 */
export function createTaskGraph(init: Partial<TaskGraph> = {}): TaskGraph {
  const nodes = normalizeNodeList(init.nodes) ?? [];
  const edges = normalizeEdges(init.edges) ?? [];
  const analyzed = Array.isArray(init.analyzedNodeIds)
    ? [...new Set(init.analyzedNodeIds.filter((id): id is string => typeof id === "string" && id !== ""))]
    : [];
  return {
    nodes,
    edges,
    analyzedNodeIds: analyzed,
    plannerRuns: normalizeCount(init.plannerRuns),
    consecutiveErrors: normalizeCount(init.consecutiveErrors),
    ...(init.exhausted ? { exhausted: true } : {}),
  };
}

/** 从落盘/外部输入归一化整张图;结构坏返回 INVALID(不抛)。 */
export function normalizeTaskGraph(raw: unknown): { ok: boolean; graph: TaskGraph; code?: TaskGraphCode } {
  if (!isRecord(raw)) {
    return { ok: false, graph: createTaskGraph(), code: TASKGRAPH_CODES.INVALID };
  }
  const nodes = normalizeNodeList(raw["nodes"]);
  const edges = normalizeEdges(raw["edges"]);
  if (!nodes || !edges) return { ok: false, graph: createTaskGraph(), code: TASKGRAPH_CODES.INVALID };
  const analyzedRaw = raw["analyzedNodeIds"];
  if (analyzedRaw !== undefined && !Array.isArray(analyzedRaw)) {
    return { ok: false, graph: createTaskGraph(), code: TASKGRAPH_CODES.INVALID };
  }
  const graph = createTaskGraph({
    nodes,
    edges,
    analyzedNodeIds: (analyzedRaw as string[] | undefined) ?? [],
    plannerRuns: typeof raw["plannerRuns"] === "number" ? raw["plannerRuns"] : 0,
    consecutiveErrors: typeof raw["consecutiveErrors"] === "number" ? raw["consecutiveErrors"] : 0,
    exhausted: raw["exhausted"] === true,
  });
  return { ok: true, graph };
}

/** 图里所有节点 id(校验/合并用)。 */
export function nodeIdsOf(graph: TaskGraph): Set<string> {
  return new Set(graph.nodes.map((node) => node.id));
}

/** collection frontier:已完成的 collection 节点数(planner 扩到这个目标才停)。 */
export function collectionFrontier(graph: TaskGraph): number {
  let n = 0;
  for (const node of graph.nodes) if (node.kind === "collection" && node.status === "completed") n += 1;
  return n;
}

/** 已完成的节点里,planner 还没看过的那些(有它就值得再跑一次 planner)。 */
export function unseenCompletions(graph: TaskGraph): string[] {
  const analyzed = new Set(graph.analyzedNodeIds);
  return graph.nodes.filter((node) => node.status === "completed" && !analyzed.has(node.id)).map((node) => node.id);
}

/**
 * 是否该跑 planner:
 * - 图已 exhausted → 不跑(SKIPPED);
 * - collection frontier < targetCollection → 跑(REQUIRED);
 * - 或存在 unseen completions → 跑(REQUIRED);
 * - 否则 SKIPPED。
 */
export function shouldRunPlanner(
  graph: TaskGraph,
  opts: { targetCollection: number },
): { run: boolean; code: TaskGraphCode; reason: string; frontier: number; unseenCompletions: string[] } {
  const target = opts.targetCollection;
  const frontier = collectionFrontier(graph);
  if (typeof target !== "number" || !Number.isFinite(target) || target < 0) {
    return { run: false, code: TASKGRAPH_CODES.INVALID, reason: "invalid-target", frontier, unseenCompletions: [] };
  }
  if (graph.exhausted) {
    return { run: false, code: TASKGRAPH_CODES.PLANNER_SKIPPED, reason: "exhausted", frontier, unseenCompletions: [] };
  }
  const unseen = unseenCompletions(graph);
  if (frontier < target) {
    return { run: true, code: TASKGRAPH_CODES.PLANNER_REQUIRED, reason: "frontier-below-target", frontier, unseenCompletions: unseen };
  }
  if (unseen.length > 0) {
    return { run: true, code: TASKGRAPH_CODES.PLANNER_REQUIRED, reason: "unseen-completions", frontier, unseenCompletions: unseen };
  }
  return { run: false, code: TASKGRAPH_CODES.PLANNER_SKIPPED, reason: "satisfied", frontier, unseenCompletions: [] };
}

/** 一条校验问题:稳定码 + 子原因(便于测试与排查),坏的扩展整体拒收。 */
export interface ExtensionIssue {
  code: TaskGraphCode;
  reason: "invalid-output" | "duplicate-id" | "unknown-collection-node" | "self-loop" | "unknown-endpoint" | "cycle";
  detail?: string;
}

/** 在合并后的邻接表上找环(DFS 三色);返回构成环的节点序列(空=无环)。 */
function findCycle(ids: string[], adjacency: Map<string, string[]>): string[] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(ids.map((id) => [id, WHITE]));
  const stack: string[] = [];

  const visit = (id: string): string[] => {
    color.set(id, GRAY);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        const at = stack.indexOf(next);
        return at >= 0 ? [...stack.slice(at), next] : [next];
      }
      if (c === WHITE) {
        const found = visit(next);
        if (found.length > 0) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return [];
  };

  for (const id of ids) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      const found = visit(id);
      if (found.length > 0) return found;
    }
  }
  return [];
}

/**
 * 校验一次扩展:
 * - 输出结构坏 → INVALID;
 * - 重复 node id(本次内重复,或与已有图撞车)→ BAD_EDGE(duplicate-id);
 * - collectionNodeIds 指向不存在的节点 → BAD_EDGE(unknown-collection-node);
 * - 自环 → BAD_EDGE(self-loop);端点不存在 → BAD_EDGE(unknown-endpoint);
 * - 合并后成环 → BAD_EDGE(cycle)。
 * 任何一条不过,调用方须冻结当前图(不合并)。
 */
export function validateExtension(
  graph: TaskGraph,
  output: PlannerOutput,
): { ok: boolean; codes: TaskGraphCode[]; issues: ExtensionIssue[] } {
  const issues: ExtensionIssue[] = [];
  if (!isRecord(output) || !Array.isArray(output.nodes) || !Array.isArray(output.edges) || !Array.isArray(output.collectionNodeIds)) {
    return { ok: false, codes: [TASKGRAPH_CODES.INVALID], issues: [{ code: TASKGRAPH_CODES.INVALID, reason: "invalid-output" }] };
  }

  const existing = nodeIdsOf(graph);
  const declared = new Set<string>();
  for (const raw of output.nodes) {
    const node = normalizeNode(raw);
    if (!node) {
      issues.push({ code: TASKGRAPH_CODES.INVALID, reason: "invalid-output", detail: "bad-node" });
      continue;
    }
    if (declared.has(node.id) || existing.has(node.id)) {
      issues.push({ code: TASKGRAPH_CODES.BAD_EDGE, reason: "duplicate-id", detail: node.id });
    }
    declared.add(node.id);
  }

  for (const rawCollection of output.collectionNodeIds) {
    if (typeof rawCollection !== "string" || rawCollection.trim() === "") {
      issues.push({ code: TASKGRAPH_CODES.INVALID, reason: "invalid-output", detail: "bad-collection-id" });
      continue;
    }
    const id = rawCollection.trim();
    if (!declared.has(id) && !existing.has(id)) {
      issues.push({ code: TASKGRAPH_CODES.BAD_EDGE, reason: "unknown-collection-node", detail: id });
    }
  }

  const allIds = [...existing, ...declared];
  const adjacency = new Map<string, string[]>();
  const addEdge = (from: string, to: string): void => {
    const list = adjacency.get(from);
    if (list) list.push(to);
    else adjacency.set(from, [to]);
  };
  for (const edge of graph.edges) addEdge(edge.from, edge.to);

  for (const rawEdge of output.edges) {
    if (!isRecord(rawEdge) || typeof rawEdge.from !== "string" || typeof rawEdge.to !== "string") {
      issues.push({ code: TASKGRAPH_CODES.INVALID, reason: "invalid-output", detail: "bad-edge" });
      continue;
    }
    const from = rawEdge.from.trim();
    const to = rawEdge.to.trim();
    if (from === "" || to === "") {
      issues.push({ code: TASKGRAPH_CODES.INVALID, reason: "invalid-output", detail: "empty-endpoint" });
      continue;
    }
    if (from === to) {
      issues.push({ code: TASKGRAPH_CODES.BAD_EDGE, reason: "self-loop", detail: from });
      continue;
    }
    const unknown = [from, to].filter((id) => !existing.has(id) && !declared.has(id));
    if (unknown.length > 0) {
      issues.push({ code: TASKGRAPH_CODES.BAD_EDGE, reason: "unknown-endpoint", detail: unknown.join(",") });
      continue;
    }
    addEdge(from, to);
  }

  if (issues.length === 0) {
    const cycle = findCycle(allIds, adjacency);
    if (cycle.length > 0) issues.push({ code: TASKGRAPH_CODES.BAD_EDGE, reason: "cycle", detail: cycle.join("→") });
  }

  const codes = [...new Set(issues.map((issue) => issue.code))];
  return { ok: issues.length === 0, codes, issues };
}

/** 合并成功后的增量统计。 */
export interface ExtensionDelta {
  nodes: string[];
  edges: number;
}

/**
 * 合并一次扩展:先校验,坏边直接返回 BAD_EDGE 且原图原样(冻结,不 shared 引用);
 * 合法则追加新节点(补缺省)与新边(去重),并把已完成节点登记进 analyzedNodeIds(去重)。
 */
export function applyExtension(
  graph: TaskGraph,
  output: PlannerOutput,
): { ok: boolean; graph: TaskGraph; code: TaskGraphCode; added?: ExtensionDelta; issues?: ExtensionIssue[] } {
  const validation = validateExtension(graph, output);
  if (!validation.ok) {
    return { ok: false, graph: cloneTaskGraph(graph), code: TASKGRAPH_CODES.BAD_EDGE, issues: validation.issues };
  }
  const merged = cloneTaskGraph(graph);
  const edgeKeys = new Set(merged.edges.map((edge) => `${edge.from}\u0000${edge.to}`));
  const addedNodes: string[] = [];
  for (const raw of output.nodes) {
    const node = normalizeNode(raw);
    if (!node) continue;
    merged.nodes.push(node);
    addedNodes.push(node.id);
  }
  let addedEdges = 0;
  for (const edge of output.edges) {
    const from = edge.from.trim();
    const to = edge.to.trim();
    const key = `${from}\u0000${to}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    merged.edges.push({ from, to });
    addedEdges += 1;
  }
  const analyzed = new Set(merged.analyzedNodeIds);
  for (const node of merged.nodes) if (node.status === "completed") analyzed.add(node.id);
  merged.analyzedNodeIds = [...analyzed];

  return {
    ok: true,
    graph: merged,
    code: TASKGRAPH_CODES.EXTENDED,
    added: { nodes: addedNodes, edges: addedEdges },
  };
}

/** runPlanner 的结果:exhausted=true 时是「配额用尽」而不是失败。 */
export interface RunPlannerResult {
  ok: boolean;
  graph: TaskGraph;
  code: TaskGraphCode;
  exhausted: boolean;
  added?: ExtensionDelta;
  issues?: ExtensionIssue[];
}

/**
 * 跑一次 planner 并合并输出(纯逻辑,不落盘):
 * - 已 exhausted → 直接 EXHAUSTED(幂等);
 * - plannerRuns 已达 maxPlannerRuns → 标 exhausted,返回 EXHAUSTED(不是 failed);
 * - 输出坏 → plannerRuns+1、consecutiveErrors+1;连续错误达 maxConsecutiveErrors → 标 exhausted 返回 EXHAUSTED,
 *   否则返回 BAD_EDGE 且节点/边保持原样(冻结);
 * - 输出合法 → 合并、plannerRuns+1、consecutiveErrors 清零;output.exhausted 时同时标 exhausted(EXHAUSTED)。
 */
export function runPlanner(
  graph: TaskGraph,
  output: PlannerOutput,
  opts: { maxPlannerRuns?: number; maxConsecutiveErrors?: number } = {},
): RunPlannerResult {
  const maxRuns = opts.maxPlannerRuns ?? DEFAULT_MAX_PLANNER_RUNS;
  const maxErrors = opts.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
  const base = cloneTaskGraph(graph);

  if (base.exhausted) {
    return { ok: false, graph: base, code: TASKGRAPH_CODES.EXHAUSTED, exhausted: true };
  }
  if (base.plannerRuns >= maxRuns) {
    base.exhausted = true;
    return { ok: false, graph: base, code: TASKGRAPH_CODES.EXHAUSTED, exhausted: true };
  }

  base.plannerRuns += 1;
  const validation = validateExtension(graph, output);
  if (!validation.ok) {
    base.consecutiveErrors += 1;
    if (base.consecutiveErrors >= maxErrors) {
      base.exhausted = true;
      return { ok: false, graph: base, code: TASKGRAPH_CODES.EXHAUSTED, exhausted: true, issues: validation.issues };
    }
    return { ok: false, graph: base, code: TASKGRAPH_CODES.BAD_EDGE, exhausted: false, issues: validation.issues };
  }

  const applied = applyExtension(graph, output);
  const merged = applied.graph;
  merged.plannerRuns = base.plannerRuns;
  merged.consecutiveErrors = 0;
  if (output.exhausted === true) {
    merged.exhausted = true;
    return { ok: true, graph: merged, code: TASKGRAPH_CODES.EXHAUSTED, exhausted: true, added: applied.added };
  }
  return { ok: true, graph: merged, code: TASKGRAPH_CODES.EXTENDED, exhausted: false, added: applied.added };
}

/** critic 重开:只对终态节点;单节点 reopens 与整轮 round 双重上限;成功只重置 exec/critic。 */
export interface CriticReopenResult {
  ok: boolean;
  graph: TaskGraph;
  code: TaskGraphCode;
  node?: TaskNode;
  stagesReset?: TaskNodeStage[];
  reason?: string;
}

export function criticReopen(
  graph: TaskGraph,
  input: { nodeId: string; round: number },
  opts: { maxRounds?: number; maxReopensPerNode?: number } = {},
): CriticReopenResult {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_CRITIC_ROUNDS;
  const maxReopens = opts.maxReopensPerNode ?? DEFAULT_MAX_REOPENS_PER_NODE;
  const frozen = cloneTaskGraph(graph);
  const nodeId = typeof input.nodeId === "string" ? input.nodeId.trim() : "";
  if (nodeId === "") {
    return { ok: false, graph: frozen, code: TASKGRAPH_CODES.INVALID, reason: "missing-node-id" };
  }
  const target = frozen.nodes.find((node) => node.id === nodeId);
  if (!target) {
    return { ok: false, graph: frozen, code: TASKGRAPH_CODES.INVALID, reason: "node-not-found" };
  }
  if (target.reopens >= maxReopens) {
    return { ok: false, graph: frozen, code: TASKGRAPH_CODES.REOPEN_LIMIT, reason: "reopen-limit" };
  }
  if (!REOPENABLE_STATUSES.has(target.status)) {
    return { ok: false, graph: frozen, code: TASKGRAPH_CODES.INVALID, reason: "status-not-reopenable" };
  }
  if (typeof input.round !== "number" || !Number.isFinite(input.round) || input.round < 1) {
    return { ok: false, graph: frozen, code: TASKGRAPH_CODES.INVALID, reason: "invalid-round" };
  }
  if (input.round > maxRounds) {
    return { ok: false, graph: frozen, code: TASKGRAPH_CODES.CRITIC_ROUND_LIMIT, reason: "critic-round-limit" };
  }

  target.status = "pending";
  target.stage = "exec";
  target.reopens += 1;
  return {
    ok: true,
    graph: frozen,
    code: TASKGRAPH_CODES.REOPENED,
    node: { ...target },
    stagesReset: ["exec", "critic"],
  };
}

/** replay:已完成(或历史 completedIds 里)的节点跳过执行;其余待跑。图本身不改。 */
export interface ReplayResult {
  ok: boolean;
  graph: TaskGraph;
  code: TaskGraphCode;
  skipped: string[];
  executed: string[];
}

export function replaySkip(graph: TaskGraph, completedIds: string[] = []): ReplayResult {
  const done = new Set([
    ...completedIds.filter((id): id is string => typeof id === "string" && id !== ""),
    ...graph.nodes.filter((node) => node.status === "completed").map((node) => node.id),
  ]);
  const skipped: string[] = [];
  const executed: string[] = [];
  for (const node of graph.nodes) {
    if (node.status === "completed" || done.has(node.id)) skipped.push(node.id);
    else executed.push(node.id);
  }
  return { ok: true, graph: cloneTaskGraph(graph), code: TASKGRAPH_CODES.REPLAY_SKIPPED, skipped, executed };
}
