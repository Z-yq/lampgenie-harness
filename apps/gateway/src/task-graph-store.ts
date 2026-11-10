/**
 * 任务图持久层(生产侧,#174):把 task-graph-extension 的纯逻辑落到单份 JSON。
 *
 * 数据面:`<root>/.genie/rsi/task-graph.json`,形状 `{ v: 1, graph: TaskGraph }`。
 * 为什么原子写(tmp + rename):plannerRuns / reopens 是跨进程配额计数(CLI 每次都是新进程),
 * 半截文件会让「第 6 次 EXHAUSTED / 第 3 次 REOPEN_LIMIT」直接失真;写后重读校验让「写成功了吗」可断言。
 *
 * 依赖纪律:node:fs / node:path + runtime 纯逻辑;runtime 模块按 evidence-graph-store 的既有套路惰性解析(两跳):
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件(dist 无新模块)时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 除参数错误外不 throw:IO/解析失败一律折叠成稳定码返回。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ExtensionDelta,
  ExtensionIssue,
  PlannerOutput,
  TaskGraph,
  TaskGraphCode,
  TaskNode,
  TaskNodeKind,
  TaskNodeStatus,
  TaskNodeStage,
} from "@lampgenie/runtime/agent/task-graph-extension";

/** store 层自产的失败码(图语义码沿用 runtime 的 TASKGRAPH_CODES)。 */
export const TASK_GRAPH_STORE_CODES = ["TASKGRAPH_STORE_WRITE_FAILED", "TASKGRAPH_STORE_ERROR"] as const;

export type TaskGraphStoreCode = (typeof TASK_GRAPH_STORE_CODES)[number];

/** runtime task-graph-extension 在本文件用到的模块面。 */
interface TaskGraphRuntime {
  readonly TASKGRAPH_CODES: {
    INVALID: string;
    PLANNER_REQUIRED: string;
    PLANNER_SKIPPED: string;
    EXTENDED: string;
    BAD_EDGE: string;
    EXHAUSTED: string;
    REOPENED: string;
    REOPEN_LIMIT: string;
    CRITIC_ROUND_LIMIT: string;
    REPLAY_SKIPPED: string;
  };
  createTaskGraph(init?: Partial<TaskGraph>): TaskGraph;
  normalizeTaskGraph(raw: unknown): { ok: boolean; graph: TaskGraph; code?: string };
  shouldRunPlanner(
    graph: TaskGraph,
    opts: { targetCollection: number },
  ): { run: boolean; code: string; reason: string; frontier: number; unseenCompletions: string[] };
  validateExtension(graph: TaskGraph, output: PlannerOutput): { ok: boolean; codes: string[]; issues: ExtensionIssue[] };
  applyExtension(
    graph: TaskGraph,
    output: PlannerOutput,
  ): { ok: boolean; graph: TaskGraph; code: string; added?: ExtensionDelta; issues?: ExtensionIssue[] };
  runPlanner(
    graph: TaskGraph,
    output: PlannerOutput,
    opts?: { maxPlannerRuns?: number; maxConsecutiveErrors?: number },
  ): { ok: boolean; graph: TaskGraph; code: string; exhausted: boolean; added?: ExtensionDelta; issues?: ExtensionIssue[] };
  criticReopen(
    graph: TaskGraph,
    input: { nodeId: string; round: number },
    opts?: { maxRounds?: number; maxReopensPerNode?: number },
  ): { ok: boolean; graph: TaskGraph; code: string; node?: TaskNode; stagesReset?: TaskNodeStage[]; reason?: string };
  replaySkip(graph: TaskGraph, completedIds?: string[]): { ok: boolean; graph: TaskGraph; code: string; skipped: string[]; executed: string[] };
}

let taskGraphRuntime: TaskGraphRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadTaskGraphRuntime(): Promise<TaskGraphRuntime> {
  if (taskGraphRuntime) return taskGraphRuntime;
  const spec = "@lampgenie/runtime/agent/task-graph-extension";
  try {
    taskGraphRuntime = (await import(spec)) as TaskGraphRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/task-graph-extension.ts", import.meta.url).href;
    taskGraphRuntime = (await import(srcUrl)) as TaskGraphRuntime;
  }
  return taskGraphRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadTaskGraphRuntime();

const CODES = rt.TASKGRAPH_CODES;

/** 写盘版本:字段语义变化时递增。 */
export const TASK_GRAPH_STORE_VERSION = 1;

/** 图文件绝对路径:`<root>/.genie/rsi/task-graph.json`。 */
export function taskGraphPath(root: string): string {
  return join(root, ".genie", "rsi", "task-graph.json");
}

/** 通用结果:ok/code + 图与路径(失败也回图,便于调用方做「图未变」断言)。 */
export interface TaskGraphOpResult {
  ok: boolean;
  code?: string;
  graph: TaskGraph;
  path: string;
  found?: boolean;
  added?: ExtensionDelta;
  exhausted?: boolean;
  issues?: ExtensionIssue[];
  node?: TaskNode;
  stagesReset?: TaskNodeStage[];
  reason?: string;
  run?: boolean;
  frontier?: number;
  unseenCompletions?: string[];
  skipped?: string[];
  executed?: string[];
}

/** 读图:缺文件=空图(found=false);坏 JSON/坏结构 → INVALID(不 throw)。 */
export function loadTaskGraph(root: string): TaskGraphOpResult {
  const path = taskGraphPath(root);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: true, graph: rt.createTaskGraph(), path, found: false };
  }
  try {
    const doc = JSON.parse(text) as unknown;
    const payload =
      typeof doc === "object" && doc !== null && !Array.isArray(doc) && "graph" in doc ? (doc as { graph: unknown }).graph : doc;
    const normalized = rt.normalizeTaskGraph(payload);
    if (!normalized.ok) {
      return { ok: false, code: normalized.code ?? CODES.INVALID, graph: rt.createTaskGraph(), path, found: true };
    }
    return { ok: true, graph: normalized.graph, path, found: true };
  } catch {
    return { ok: false, code: CODES.INVALID, graph: rt.createTaskGraph(), path, found: true };
  }
}

/** 原子写:`{v:1,graph}` → 同目录 tmp → rename;写后重读校验版本与节点数。 */
export function writeTaskGraphAtomic(root: string, graph: TaskGraph): { ok: boolean; code?: string; path: string } {
  const path = taskGraphPath(root);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ v: TASK_GRAPH_STORE_VERSION, graph }, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch {
    return { ok: false, code: TASK_GRAPH_STORE_CODES[0], path };
  }
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { v?: unknown; graph?: { nodes?: unknown } };
    if (doc.v !== TASK_GRAPH_STORE_VERSION || !Array.isArray(doc.graph?.nodes) || doc.graph.nodes.length !== graph.nodes.length) {
      return { ok: false, code: TASK_GRAPH_STORE_CODES[0], path };
    }
  } catch {
    return { ok: false, code: TASK_GRAPH_STORE_CODES[0], path };
  }
  return { ok: true, path };
}

function storeError(root: string, code: string): TaskGraphOpResult {
  return { ok: false, code, graph: rt.createTaskGraph(), path: taskGraphPath(root) };
}

/**
 * 初始化图并落盘(覆盖写)。入参形状 `{nodes?,edges?,analyzedNodeIds?,plannerRuns?,consecutiveErrors?,exhausted?}`。
 * 结构坏 → INVALID 且不写盘。
 */
export function init(root: string, input: unknown = {}): TaskGraphOpResult {
  const normalized = rt.normalizeTaskGraph(input ?? {});
  if (!normalized.ok) {
    return { ok: false, code: normalized.code ?? CODES.INVALID, graph: rt.createTaskGraph(), path: taskGraphPath(root) };
  }
  const written = writeTaskGraphAtomic(root, normalized.graph);
  return {
    ok: written.ok,
    code: written.code,
    graph: normalized.graph,
    path: written.path,
    found: true,
  };
}

/** 该不该跑 planner:frontier<target 或存在 unseen completions → PLANNER_REQUIRED。 */
export function shouldRun(root: string, opts: { targetCollection: number }): TaskGraphOpResult {
  const state = loadTaskGraph(root);
  if (!state.ok) return state;
  const res = rt.shouldRunPlanner(state.graph, opts);
  return {
    ok: res.code !== CODES.INVALID,
    code: res.code,
    graph: state.graph,
    path: state.path,
    found: state.found,
    run: res.run,
    reason: res.reason,
    frontier: res.frontier,
    unseenCompletions: res.unseenCompletions,
  };
}

/**
 * 跑一次 planner(带配额)并落盘:
 * 坏边 → 图冻结(节点/边不变),但 plannerRuns/consecutiveErrors 计数照写;
 * 配额用尽 → 落盘 exhausted 标记,返回 EXHAUSTED。
 */
export function apply(
  root: string,
  output: PlannerOutput,
  opts: { maxPlannerRuns?: number; maxConsecutiveErrors?: number } = {},
): TaskGraphOpResult {
  const state = loadTaskGraph(root);
  if (!state.ok) return state;
  const res = rt.runPlanner(state.graph, output, opts);
  const written = writeTaskGraphAtomic(root, res.graph);
  if (!written.ok) {
    return { ok: false, code: written.code, graph: res.graph, path: written.path, found: state.found };
  }
  return {
    ok: res.ok,
    code: res.code,
    graph: res.graph,
    path: written.path,
    found: state.found,
    added: res.added,
    exhausted: res.exhausted,
    issues: res.issues,
  };
}

/** critic 重开:成功才落盘;限额/轮次/状态不合法返回稳定码且文件不动。 */
export function criticReopen(
  root: string,
  input: { nodeId: string; round: number },
  opts: { maxRounds?: number; maxReopensPerNode?: number } = {},
): TaskGraphOpResult {
  const state = loadTaskGraph(root);
  if (!state.ok) return state;
  const res = rt.criticReopen(state.graph, input, opts);
  if (!res.ok) {
    return { ok: false, code: res.code, graph: res.graph, path: state.path, found: state.found, reason: res.reason };
  }
  const written = writeTaskGraphAtomic(root, res.graph);
  if (!written.ok) {
    return { ok: false, code: written.code, graph: res.graph, path: written.path, found: state.found };
  }
  return {
    ok: true,
    code: res.code,
    graph: res.graph,
    path: written.path,
    found: state.found,
    node: res.node,
    stagesReset: res.stagesReset,
  };
}

/** replay:已完成节点跳过执行(只读,不改盘)。 */
export function replay(root: string, completedIds: string[] = []): TaskGraphOpResult {
  const state = loadTaskGraph(root);
  if (!state.ok) return state;
  const res = rt.replaySkip(state.graph, completedIds);
  return {
    ok: true,
    code: res.code,
    graph: res.graph,
    path: state.path,
    found: state.found,
    skipped: res.skipped,
    executed: res.executed,
  };
}

/** 汇总报告:节点/边/状态分布/配额/前沿。 */
export interface TaskGraphReport {
  ok: boolean;
  code?: string;
  path: string;
  found: boolean;
  nodes: number;
  edges: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  analyzed: number;
  plannerRuns: number;
  consecutiveErrors: number;
  exhausted: boolean;
  frontier: number;
  unseenCompletions: string[];
}

export function report(root: string): TaskGraphReport {
  const state = loadTaskGraph(root);
  const graph = state.graph;
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const node of graph.nodes) {
    byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
    byStatus[node.status] = (byStatus[node.status] ?? 0) + 1;
  }
  return {
    ok: state.ok,
    code: state.code,
    path: state.path,
    found: state.found ?? false,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    byKind,
    byStatus,
    analyzed: graph.analyzedNodeIds.length,
    plannerRuns: graph.plannerRuns,
    consecutiveErrors: graph.consecutiveErrors,
    exhausted: graph.exhausted === true,
    frontier: graph.nodes.filter((node) => node.kind === "collection" && node.status === "completed").length,
    unseenCompletions: graph.nodes
      .filter((node) => node.status === "completed" && !graph.analyzedNodeIds.includes(node.id))
      .map((node) => node.id),
  };
}

/** 图语义码(供调用方 import 断言,不重定义常量值)。 */
export type { TaskGraphCode, TaskNodeKind, TaskNodeStatus, TaskNodeStage };
