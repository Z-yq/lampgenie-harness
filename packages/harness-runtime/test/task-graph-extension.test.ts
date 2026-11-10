/**
 * 任务图扩展:三判据(该不该跑 planner)/ 四查(重复·自环·未知端点·成环)/ 合并去重 /
 * 配额(plannerRuns·consecutiveErrors 超限标 exhausted)/ critic 受控重开 / replay 跳过已完成。
 * 全部纯数据 + 固定输入,不碰文件与真实时钟。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CRITIC_ROUNDS,
  DEFAULT_MAX_CONSECUTIVE_ERRORS,
  DEFAULT_MAX_PLANNER_RUNS,
  DEFAULT_MAX_REOPENS_PER_NODE,
  TASKGRAPH_CODES,
  applyExtension,
  cloneTaskGraph,
  collectionFrontier,
  createTaskGraph,
  criticReopen,
  nodeIdsOf,
  normalizeTaskGraph,
  replaySkip,
  runPlanner,
  shouldRunPlanner,
  unseenCompletions,
  validateExtension,
} from "../src/agent/task-graph-extension.ts";
import type {
  PlannerNode,
  PlannerOutput,
  TaskEdge,
  TaskGraph,
  TaskNode,
  TaskNodeKind,
} from "../src/agent/task-graph-extension.ts";

/** 一个节点(默认 pending/0/exec)。 */
function node(id: string, kind: TaskNodeKind = "exec", over: Partial<TaskNode> = {}): TaskNode {
  return { id, kind, status: "pending", reopens: 0, stage: "exec", ...over };
}

/** 起一张图。 */
function graphOf(nodes: TaskNode[], edges: TaskEdge[] = [], over: Partial<TaskGraph> = {}): TaskGraph {
  return createTaskGraph({ nodes, edges, ...over });
}

/** 一次 planner 输出(默认无边无 collection)。 */
function plan(nodes: PlannerNode[], over: Partial<PlannerOutput> = {}): PlannerOutput {
  return { nodes, edges: [], collectionNodeIds: [], ...over };
}

/** 一条"合法但内容为空"的扩展(用于把 plannerRuns 推上去)。 */
const EMPTY_PLAN = plan([]);

describe("createTaskGraph / normalizeTaskGraph", () => {
  it("空入参给空图,计数从 0 起", () => {
    const graph = createTaskGraph();
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.analyzedNodeIds).toEqual([]);
    expect(graph.plannerRuns).toBe(0);
    expect(graph.consecutiveErrors).toBe(0);
    expect(graph.exhausted).toBeUndefined();
  });

  it("节点缺省补 pending/0/exec,负计数归零,analyzedNodeIds 去重", () => {
    const graph = createTaskGraph({
      nodes: [{ id: "a", kind: "exec" }],
      analyzedNodeIds: ["x", "x", "y"],
      plannerRuns: -3,
      consecutiveErrors: 2.9,
    });
    expect(graph.nodes[0]).toEqual({ id: "a", kind: "exec", status: "pending", reopens: 0, stage: "exec" });
    expect(graph.analyzedNodeIds).toEqual(["x", "y"]);
    expect(graph.plannerRuns).toBe(0);
    expect(graph.consecutiveErrors).toBe(2);
  });

  it("normalizeTaskGraph 吃 {nodes,edges,...} 并可回环;非对象与结构坏给 INVALID", () => {
    const ok = normalizeTaskGraph({ nodes: [{ id: "a", kind: "collection", status: "completed" }], edges: [] });
    expect(ok.ok).toBe(true);
    expect(ok.graph.nodes[0]?.status).toBe("completed");
    expect(normalizeTaskGraph(null).code).toBe(TASKGRAPH_CODES.INVALID);
    expect(normalizeTaskGraph({ nodes: "nope" }).code).toBe(TASKGRAPH_CODES.INVALID);
    expect(normalizeTaskGraph({ nodes: [], edges: [{ from: "a" }] }).code).toBe(TASKGRAPH_CODES.INVALID);
  });

  it("cloneTaskGraph 深拷贝:改副本不影响原图", () => {
    const graph = graphOf([node("a")], [{ from: "a", to: "a" }]);
    const copy = cloneTaskGraph(graph);
    copy.nodes[0]!.status = "completed";
    copy.edges.push({ from: "a", to: "b" });
    copy.analyzedNodeIds.push("a");
    expect(graph.nodes[0]?.status).toBe("pending");
    expect(graph.edges).toHaveLength(1);
    expect(graph.analyzedNodeIds).toEqual([]);
  });

  it("nodeIdsOf / collectionFrontier / unseenCompletions 基础口径", () => {
    const graph = graphOf([
      node("a", "exec", { status: "completed" }),
      node("c1", "collection", { status: "completed" }),
      node("c2", "collection", { status: "running" }),
    ]);
    expect([...nodeIdsOf(graph)].sort()).toEqual(["a", "c1", "c2"]);
    expect(collectionFrontier(graph)).toBe(1);
    expect(unseenCompletions(graph)).toEqual(["a", "c1"]);
  });
});

describe("shouldRunPlanner", () => {
  it("frontier 低于目标 → PLANNER_REQUIRED(frontier-below-target)", () => {
    const graph = graphOf([node("c1", "collection", { status: "completed" })]);
    const res = shouldRunPlanner(graph, { targetCollection: 3 });
    expect(res.run).toBe(true);
    expect(res.code).toBe(TASKGRAPH_CODES.PLANNER_REQUIRED);
    expect(res.reason).toBe("frontier-below-target");
    expect(res.frontier).toBe(1);
  });

  it("frontier 达标但有 unseen completions → PLANNER_REQUIRED(unseen-completions)", () => {
    const graph = graphOf(
      [node("c1", "collection", { status: "completed" }), node("x", "exec", { status: "completed" })],
      [],
      { analyzedNodeIds: ["c1"] },
    );
    const res = shouldRunPlanner(graph, { targetCollection: 1 });
    expect(res.run).toBe(true);
    expect(res.reason).toBe("unseen-completions");
    expect(res.unseenCompletions).toEqual(["x"]);
  });

  it("frontier 达标且完成节点都看过 → PLANNER_SKIPPED(satisfied)", () => {
    const graph = graphOf(
      [node("c1", "collection", { status: "completed" }), node("x", "exec", { status: "completed" })],
      [],
      { analyzedNodeIds: ["c1", "x"] },
    );
    const res = shouldRunPlanner(graph, { targetCollection: 1 });
    expect(res.run).toBe(false);
    expect(res.code).toBe(TASKGRAPH_CODES.PLANNER_SKIPPED);
    expect(res.reason).toBe("satisfied");
  });

  it("exhausted 图不再触发 planner,哪怕 frontier 不足", () => {
    const graph = graphOf([], [], { exhausted: true });
    const res = shouldRunPlanner(graph, { targetCollection: 9 });
    expect(res.run).toBe(false);
    expect(res.code).toBe(TASKGRAPH_CODES.PLANNER_SKIPPED);
    expect(res.reason).toBe("exhausted");
  });

  it("目标非法 → INVALID", () => {
    expect(shouldRunPlanner(createTaskGraph(), { targetCollection: -1 }).code).toBe(TASKGRAPH_CODES.INVALID);
    expect(shouldRunPlanner(createTaskGraph(), { targetCollection: Number.NaN }).code).toBe(TASKGRAPH_CODES.INVALID);
  });

  it("target 缺省口径:0 且无完成节点 → 立即 SKIPPED", () => {
    const res = shouldRunPlanner(createTaskGraph(), { targetCollection: 0 });
    expect(res.run).toBe(false);
    expect(res.reason).toBe("satisfied");
  });
});

describe("validateExtension", () => {
  const base = graphOf([node("a"), node("b")], [{ from: "a", to: "b" }]);

  it("合法扩展:新节点 + 新边 + collection 指向本次节点 → ok", () => {
    const res = validateExtension(
      base,
      plan([{ id: "c", kind: "collection" }], { edges: [{ from: "b", to: "c" }], collectionNodeIds: ["c"] }),
    );
    expect(res.ok).toBe(true);
    expect(res.codes).toEqual([]);
  });

  it("重复 id(本次内重复)→ BAD_EDGE duplicate-id", () => {
    const res = validateExtension(base, plan([{ id: "c", kind: "exec" }, { id: "c", kind: "exec" }]));
    expect(res.ok).toBe(false);
    expect(res.codes).toContain(TASKGRAPH_CODES.BAD_EDGE);
    expect(res.issues.some((i) => i.reason === "duplicate-id")).toBe(true);
  });

  it("重复 id(与已有图撞车)→ BAD_EDGE duplicate-id", () => {
    const res = validateExtension(base, plan([{ id: "a", kind: "exec" }]));
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.reason === "duplicate-id")).toBe(true);
  });

  it("自环 → BAD_EDGE self-loop", () => {
    const res = validateExtension(base, plan([{ id: "c", kind: "exec" }], { edges: [{ from: "c", to: "c" }] }));
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.reason === "self-loop")).toBe(true);
  });

  it("未知端点 → BAD_EDGE unknown-endpoint", () => {
    const res = validateExtension(base, plan([], { edges: [{ from: "b", to: "ghost" }] }));
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.reason === "unknown-endpoint")).toBe(true);
  });

  it("成环(新边 b→a 与既有 a→b 冲突)→ BAD_EDGE cycle", () => {
    const res = validateExtension(base, plan([], { edges: [{ from: "b", to: "a" }] }));
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.reason === "cycle")).toBe(true);
  });

  it("新边 c→a 与 b→c 形成 a→b→c→a → BAD_EDGE cycle", () => {
    const res = validateExtension(base, plan([{ id: "c", kind: "exec" }], { edges: [{ from: "b", to: "c" }, { from: "c", to: "a" }] }));
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.reason === "cycle")).toBe(true);
  });

  it("collectionNodeIds 指向不存在的节点 → BAD_EDGE unknown-collection-node", () => {
    const res = validateExtension(base, plan([], { collectionNodeIds: ["ghost-collection"] }));
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.reason === "unknown-collection-node")).toBe(true);
  });

  it("输出结构坏(缺 nodes)→ INVALID", () => {
    const res = validateExtension(base, { edges: [], collectionNodeIds: [] } as unknown as PlannerOutput);
    expect(res.ok).toBe(false);
    expect(res.codes).toEqual([TASKGRAPH_CODES.INVALID]);
  });
});

describe("applyExtension", () => {
  it("合法扩展:合并节点与边,补缺省状态", () => {
    const base = graphOf([node("a"), node("b")], [{ from: "a", to: "b" }]);
    const res = applyExtension(base, plan([{ id: "c", kind: "exec" }], { edges: [{ from: "b", to: "c" }], collectionNodeIds: ["c"] }));
    expect(res.ok).toBe(true);
    expect(res.code).toBe(TASKGRAPH_CODES.EXTENDED);
    expect(res.added).toEqual({ nodes: ["c"], edges: 1 });
    expect(res.graph.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(res.graph.nodes[2]).toEqual({ id: "c", kind: "exec", status: "pending", reopens: 0, stage: "exec" });
    expect(res.graph.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
  });

  it("重复边去重,边计数如实", () => {
    const base = graphOf([node("a"), node("b")], [{ from: "a", to: "b" }]);
    const res = applyExtension(base, plan([], { edges: [{ from: "a", to: "b" }] }));
    expect(res.ok).toBe(true);
    expect(res.added?.edges).toBe(0);
    expect(res.graph.edges).toHaveLength(1);
  });

  it("坏边冻结原图:节点/边不变且不共享引用", () => {
    const base = graphOf([node("a")], []);
    const res = applyExtension(base, plan([], { edges: [{ from: "a", to: "a" }] }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe(TASKGRAPH_CODES.BAD_EDGE);
    expect(res.graph.nodes).toEqual(base.nodes);
    expect(res.graph.edges).toEqual([]);
    expect(res.graph).not.toBe(base);
  });

  it("已完成节点自动进 analyzedNodeIds,重复应用幂等", () => {
    const base = graphOf([node("a"), node("b", "exec", { status: "completed" })]);
    const first = applyExtension(base, EMPTY_PLAN);
    expect(first.graph.analyzedNodeIds).toEqual(["b"]);
    const second = applyExtension(first.graph, EMPTY_PLAN);
    expect(second.graph.analyzedNodeIds).toEqual(["b"]);
    expect(second.graph.nodes).toHaveLength(2);
  });
});

describe("runPlanner", () => {
  it("合法输出 → EXTENDED,plannerRuns+1、错误清零", () => {
    const base = graphOf([node("a")], [], { plannerRuns: 1, consecutiveErrors: 2 });
    const res = runPlanner(base, plan([{ id: "b", kind: "exec" }], { edges: [{ from: "a", to: "b" }] }));
    expect(res.ok).toBe(true);
    expect(res.code).toBe(TASKGRAPH_CODES.EXTENDED);
    expect(res.graph.plannerRuns).toBe(2);
    expect(res.graph.consecutiveErrors).toBe(0);
  });

  it("plannerRuns 达上限 → exhausted,不是 failed", () => {
    const base = graphOf([], [], { plannerRuns: DEFAULT_MAX_PLANNER_RUNS });
    const res = runPlanner(base, EMPTY_PLAN);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(TASKGRAPH_CODES.EXHAUSTED);
    expect(res.exhausted).toBe(true);
    expect(res.graph.exhausted).toBe(true);
    expect(res.graph.plannerRuns).toBe(DEFAULT_MAX_PLANNER_RUNS);
  });

  it("已 exhausted 幂等返回 EXHAUSTED(不再计数)", () => {
    const base = graphOf([], [], { exhausted: true, plannerRuns: 2 });
    const res = runPlanner(base, EMPTY_PLAN);
    expect(res.code).toBe(TASKGRAPH_CODES.EXHAUSTED);
    expect(res.graph.plannerRuns).toBe(2);
  });

  it("坏边:plannerRuns 与 consecutiveErrors 都累计,图冻结", () => {
    const base = graphOf([node("a")], [], { consecutiveErrors: 0 });
    const res = runPlanner(base, plan([], { edges: [{ from: "a", to: "a" }] }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe(TASKGRAPH_CODES.BAD_EDGE);
    expect(res.exhausted).toBe(false);
    expect(res.graph.plannerRuns).toBe(1);
    expect(res.graph.consecutiveErrors).toBe(1);
    expect(res.graph.nodes).toEqual(base.nodes);
  });

  it("连续错误达 maxConsecutiveErrors → 标 exhausted 并返回 EXHAUSTED", () => {
    let graph = graphOf([node("a")]);
    for (let i = 0; i < DEFAULT_MAX_CONSECUTIVE_ERRORS; i += 1) {
      const res = runPlanner(graph, plan([], { edges: [{ from: "a", to: "ghost" }] }));
      graph = res.graph;
      if (i < DEFAULT_MAX_CONSECUTIVE_ERRORS - 1) expect(res.code).toBe(TASKGRAPH_CODES.BAD_EDGE);
      else {
        expect(res.code).toBe(TASKGRAPH_CODES.EXHAUSTED);
        expect(res.exhausted).toBe(true);
      }
    }
    expect(graph.exhausted).toBe(true);
    expect(graph.consecutiveErrors).toBe(DEFAULT_MAX_CONSECUTIVE_ERRORS);
  });

  it("成功一次即清零错误计数", () => {
    const base = graphOf([node("a")], [], { consecutiveErrors: 2 });
    const res = runPlanner(base, EMPTY_PLAN);
    expect(res.code).toBe(TASKGRAPH_CODES.EXTENDED);
    expect(res.graph.consecutiveErrors).toBe(0);
  });

  it("planner 自报 exhausted → 合并后标 exhausted(EXHAUSTED)", () => {
    const base = graphOf([node("a")]);
    const res = runPlanner(base, plan([{ id: "b", kind: "exec" }], { exhausted: true }));
    expect(res.ok).toBe(true);
    expect(res.code).toBe(TASKGRAPH_CODES.EXHAUSTED);
    expect(res.graph.exhausted).toBe(true);
    expect(res.graph.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(shouldRunPlanner(res.graph, { targetCollection: 5 }).run).toBe(false);
  });

  it("自定义配额按入参生效", () => {
    const base = graphOf([], [], { plannerRuns: 1 });
    const res = runPlanner(base, EMPTY_PLAN, { maxPlannerRuns: 1 });
    expect(res.code).toBe(TASKGRAPH_CODES.EXHAUSTED);
    expect(res.graph.exhausted).toBe(true);
  });
});

describe("criticReopen", () => {
  it("completed 节点重开 → pending/exec/reopens+1,仅重置 exec+critic", () => {
    const base = graphOf([node("a", "critic", { status: "completed", stage: "critic", reopens: 0 })]);
    const res = criticReopen(base, { nodeId: "a", round: 1 });
    expect(res.ok).toBe(true);
    expect(res.code).toBe(TASKGRAPH_CODES.REOPENED);
    expect(res.node).toMatchObject({ status: "pending", stage: "exec", reopens: 1 });
    expect(res.stagesReset).toEqual(["exec", "critic"]);
  });

  it("failed / skipped 也可重开", () => {
    const base = graphOf([node("f", "exec", { status: "failed" }), node("s", "exec", { status: "skipped" })]);
    expect(criticReopen(base, { nodeId: "f", round: 1 }).code).toBe(TASKGRAPH_CODES.REOPENED);
    expect(criticReopen(base, { nodeId: "s", round: 1 }).code).toBe(TASKGRAPH_CODES.REOPENED);
  });

  it("pending / running 不可重开 → INVALID(status-not-reopenable)", () => {
    const base = graphOf([node("p"), node("r", "exec", { status: "running" })]);
    const res = criticReopen(base, { nodeId: "p", round: 1 });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(TASKGRAPH_CODES.INVALID);
    expect(res.reason).toBe("status-not-reopenable");
    expect(criticReopen(base, { nodeId: "r", round: 1 }).code).toBe(TASKGRAPH_CODES.INVALID);
  });

  it("节点不存在 → INVALID(node-not-found)", () => {
    const res = criticReopen(graphOf([node("a")]), { nodeId: "ghost", round: 1 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("node-not-found");
  });

  it("单节点重开 2 次后第 3 次 → REOPEN_LIMIT", () => {
    let graph = graphOf([node("a", "exec", { status: "completed" })]);
    const first = criticReopen(graph, { nodeId: "a", round: 1 });
    expect(first.code).toBe(TASKGRAPH_CODES.REOPENED);
    graph = first.graph;
    graph.nodes[0]!.status = "completed";
    const second = criticReopen(graph, { nodeId: "a", round: 1 });
    expect(second.code).toBe(TASKGRAPH_CODES.REOPENED);
    graph = second.graph;
    expect(graph.nodes[0]!.reopens).toBe(DEFAULT_MAX_REOPENS_PER_NODE);
    const third = criticReopen(graph, { nodeId: "a", round: 1 });
    expect(third.ok).toBe(false);
    expect(third.code).toBe(TASKGRAPH_CODES.REOPEN_LIMIT);
  });

  it("round 超过 3 → CRITIC_ROUND_LIMIT", () => {
    const base = graphOf([node("a", "exec", { status: "completed" })]);
    const res = criticReopen(base, { nodeId: "a", round: DEFAULT_MAX_CRITIC_ROUNDS + 1 });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(TASKGRAPH_CODES.CRITIC_ROUND_LIMIT);
    expect(criticReopen(base, { nodeId: "a", round: DEFAULT_MAX_CRITIC_ROUNDS }).code).toBe(TASKGRAPH_CODES.REOPENED);
  });

  it("round 非法(0/NaN)→ INVALID(invalid-round)", () => {
    const base = graphOf([node("a", "exec", { status: "completed" })]);
    expect(criticReopen(base, { nodeId: "a", round: 0 }).reason).toBe("invalid-round");
    expect(criticReopen(base, { nodeId: "a", round: Number.NaN }).code).toBe(TASKGRAPH_CODES.INVALID);
  });

  it("失败时原图不变(冻结)", () => {
    const base = graphOf([node("a", "exec", { status: "completed", reopens: 2 })]);
    const res = criticReopen(base, { nodeId: "a", round: 1 });
    expect(res.code).toBe(TASKGRAPH_CODES.REOPEN_LIMIT);
    expect(res.graph.nodes[0]).toEqual(base.nodes[0]);
  });
});

describe("replaySkip", () => {
  it("已完成节点跳过,其余待跑", () => {
    const graph = graphOf([
      node("a", "exec", { status: "completed" }),
      node("b", "exec", { status: "pending" }),
      node("c", "exec", { status: "failed" }),
    ]);
    const res = replaySkip(graph);
    expect(res.code).toBe(TASKGRAPH_CODES.REPLAY_SKIPPED);
    expect(res.skipped).toEqual(["a"]);
    expect(res.executed).toEqual(["b", "c"]);
  });

  it("历史 completedIds 里的节点即使当前 pending 也跳过(重开后续跑)", () => {
    const graph = graphOf([node("a", { status: "pending" } as Partial<TaskNode>), node("b")]);
    const res = replaySkip(graph, ["a"]);
    expect(res.skipped).toEqual(["a"]);
    expect(res.executed).toEqual(["b"]);
  });

  it("全完成 → 无待跑节点", () => {
    const graph = graphOf([node("a", "exec", { status: "completed" }), node("b", "exec", { status: "completed" })]);
    const res = replaySkip(graph);
    expect(res.skipped).toEqual(["a", "b"]);
    expect(res.executed).toEqual([]);
  });

  it("不改原图,返回的图是副本", () => {
    const graph = graphOf([node("a", "exec", { status: "completed" })]);
    const res = replaySkip(graph, ["a"]);
    expect(res.graph).not.toBe(graph);
    expect(graph.nodes[0]?.status).toBe("completed");
  });
});

describe("稳定码与常量", () => {
  it("十个稳定码齐备且前缀一致", () => {
    const codes = Object.values(TASKGRAPH_CODES) as string[];
    expect(codes).toHaveLength(10);
    for (const code of codes) expect(code.startsWith("TASKGRAPH_")).toBe(true);
    expect(new Set(codes).size).toBe(10);
  });

  it("缺省配额与规格一致", () => {
    expect(DEFAULT_MAX_PLANNER_RUNS).toBe(5);
    expect(DEFAULT_MAX_CONSECUTIVE_ERRORS).toBe(3);
    expect(DEFAULT_MAX_CRITIC_ROUNDS).toBe(3);
    expect(DEFAULT_MAX_REOPENS_PER_NODE).toBe(2);
  });

  it("所有导出函数对非法输入都不抛异常", () => {
    const graph = createTaskGraph();
    expect(() => validateExtension(graph, {} as PlannerOutput)).not.toThrow();
    expect(() => applyExtension(graph, {} as PlannerOutput)).not.toThrow();
    expect(() => runPlanner(graph, {} as PlannerOutput)).not.toThrow();
    expect(() => criticReopen(graph, { nodeId: "", round: Number.NaN })).not.toThrow();
    expect(() => replaySkip(graph, ["x"])).not.toThrow();
  });
});
