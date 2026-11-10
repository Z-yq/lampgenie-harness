/**
 * 任务图持久层:原子写 / 缺文件空图 / 坏文件容忍 / 坏边冻结 / 配额跨进程持久化 /
 * critic 重开限额落盘 / replay 跳过 / 报告。全部用例只写 os.tmpdir(),绝不碰仓库 .genie。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PlannerOutput, TaskGraph } from "@lampgenie/runtime/agent/task-graph-extension";
import {
  TASK_GRAPH_STORE_CODES,
  apply,
  criticReopen,
  init,
  loadTaskGraph,
  report,
  replay,
  shouldRun,
  taskGraphPath,
  writeTaskGraphAtomic,
} from "../src/task-graph-store";

const tempDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-task-graph-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function node(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, kind: "exec", status: "pending", reopens: 0, stage: "exec", ...over };
}

function plan(nodes: Record<string, unknown>[], over: Partial<PlannerOutput> = {}): PlannerOutput {
  return { nodes: nodes as PlannerOutput["nodes"], edges: [], collectionNodeIds: [], ...over };
}

const EMPTY_PLAN = plan([]);

async function readGraphFile(root: string): Promise<{ v: number; graph: TaskGraph }> {
  return JSON.parse(await readFile(taskGraphPath(root), "utf8")) as { v: number; graph: TaskGraph };
}

describe("init / load", () => {
  it("init 落盘到 .genie/rsi/task-graph.json,load 回环一致", async () => {
    const root = await tmpRoot();
    const res = init(root, { nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b" }] });
    expect(res.ok).toBe(true);
    expect(res.path).toBe(taskGraphPath(root));
    const loaded = loadTaskGraph(root);
    expect(loaded.ok).toBe(true);
    expect(loaded.found).toBe(true);
    expect(loaded.graph.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(loaded.graph.edges).toEqual([{ from: "a", to: "b" }]);
  });

  it("缺文件 = 空图(found=false),不报错", async () => {
    const root = await tmpRoot();
    const loaded = loadTaskGraph(root);
    expect(loaded.ok).toBe(true);
    expect(loaded.found).toBe(false);
    expect(loaded.graph.nodes).toEqual([]);
  });

  it("坏 JSON → INVALID 且不 throw", async () => {
    const root = await tmpRoot();
    const path = taskGraphPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not json", "utf8");
    const loaded = loadTaskGraph(root);
    expect(loaded.ok).toBe(false);
    expect(loaded.code).toBe("TASKGRAPH_INVALID");
  });

  it("合法 JSON 但结构坏 → INVALID", async () => {
    const root = await tmpRoot();
    const path = taskGraphPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ v: 1, graph: { nodes: "nope" } }), "utf8");
    expect(loadTaskGraph(root).code).toBe("TASKGRAPH_INVALID");
  });

  it("init 结构坏 → INVALID,不写文件", async () => {
    const root = await tmpRoot();
    const res = init(root, { nodes: "bad" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("TASKGRAPH_INVALID");
    expect(loadTaskGraph(root).found).toBe(false);
  });

  it("原子写不残留 .tmp,文件带版本头", async () => {
    const root = await tmpRoot();
    init(root, { nodes: [node("a")] });
    const files = await readdir(join(root, ".genie", "rsi"));
    expect(files).toEqual(["task-graph.json"]);
    const doc = await readGraphFile(root);
    expect(doc.v).toBe(1);
    expect(doc.graph.nodes[0]?.id).toBe("a");
  });
});

describe("shouldRun", () => {
  it("frontier 不足 → PLANNER_REQUIRED", async () => {
    const root = await tmpRoot();
    init(root, { nodes: [node("c", { kind: "collection", status: "completed" })] });
    const res = shouldRun(root, { targetCollection: 2 });
    expect(res.ok).toBe(true);
    expect(res.run).toBe(true);
    expect(res.code).toBe("TASKGRAPH_PLANNER_REQUIRED");
    expect(res.frontier).toBe(1);
  });

  it("frontier 达标且都看过 → PLANNER_SKIPPED", async () => {
    const root = await tmpRoot();
    init(root, {
      nodes: [node("c", { kind: "collection", status: "completed" })],
      analyzedNodeIds: ["c"],
    });
    const res = shouldRun(root, { targetCollection: 1 });
    expect(res.run).toBe(false);
    expect(res.code).toBe("TASKGRAPH_PLANNER_SKIPPED");
  });

  it("坏文件时 shouldRun 返回 INVALID(不伪造空图)", async () => {
    const root = await tmpRoot();
    const path = taskGraphPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "broken", "utf8");
    expect(shouldRun(root, { targetCollection: 1 }).code).toBe("TASKGRAPH_INVALID");
  });
});

describe("apply(扩展 + 配额持久化)", () => {
  it("合法扩展 → EXTENDED 并落盘", async () => {
    const root = await tmpRoot();
    init(root, { nodes: [node("a")], edges: [] });
    const res = apply(root, plan([node("b")], { edges: [{ from: "a", to: "b" }] }));
    expect(res.ok).toBe(true);
    expect(res.code).toBe("TASKGRAPH_EXTENDED");
    const reloaded = loadTaskGraph(root);
    expect(reloaded.graph.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(reloaded.graph.plannerRuns).toBe(1);
  });

  it("坏边 → BAD_EDGE,节点/边不变但错误计数落盘", async () => {
    const root = await tmpRoot();
    init(root, { nodes: [node("a")] });
    const before = await readGraphFile(root);
    const res = apply(root, plan([], { edges: [{ from: "a", to: "a" }] }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe("TASKGRAPH_BAD_EDGE");
    const after = await readGraphFile(root);
    expect(after.graph.nodes.map((n) => n.id)).toEqual(before.graph.nodes.map((n) => n.id));
    expect(after.graph.edges).toEqual([]);
    expect(after.graph.plannerRuns).toBe(1);
    expect(after.graph.consecutiveErrors).toBe(1);
  });

  it("plannerRuns 跨进程累计:init runs=4 → 第 5 次 EXTENDED → 第 6 次 EXHAUSTED", async () => {
    const root = await tmpRoot();
    init(root, { nodes: [node("a")], plannerRuns: 4 });
    const fifth = apply(root, EMPTY_PLAN);
    expect(fifth.code).toBe("TASKGRAPH_EXTENDED");
    const sixth = apply(root, EMPTY_PLAN);
    expect(sixth.code).toBe("TASKGRAPH_EXHAUSTED");
    expect(sixth.exhausted).toBe(true);
    expect((await readGraphFile(root)).graph.exhausted).toBe(true);
  });

  it("连续错误达上限 → EXHAUSTED 落盘(不是 failed)", async () => {
    const root = await tmpRoot();
    init(root, { nodes: [node("a")], consecutiveErrors: 2 });
    const res = apply(root, plan([], { edges: [{ from: "a", to: "ghost" }] }));
    expect(res.code).toBe("TASKGRAPH_EXHAUSTED");
    const persisted = await readGraphFile(root);
    expect(persisted.graph.exhausted).toBe(true);
    expect(persisted.graph.consecutiveErrors).toBe(3);
  });
});

describe("criticReopen(限额落盘)", () => {
  it("completed 节点重开 → REOPENED 并落盘", async () => {
    const root = await tmpRoot();
    init(root, { nodes: [node("a", { status: "completed", stage: "critic" })] });
    const res = criticReopen(root, { nodeId: "a", round: 1 });
    expect(res.ok).toBe(true);
    expect(res.code).toBe("TASKGRAPH_REOPENED");
    const reloaded = loadTaskGraph(root);
    expect(reloaded.graph.nodes[0]).toMatchObject({ status: "pending", stage: "exec", reopens: 1 });
  });

  it("重开 2 次后第 3 次 → REOPEN_LIMIT,文件不变", async () => {
    const root = await tmpRoot();
    init(root, { nodes: [node("a", { status: "completed" })] });
    expect(criticReopen(root, { nodeId: "a", round: 1 }).code).toBe("TASKGRAPH_REOPENED");
    // 模拟执行完成再来一次
    const state = loadTaskGraph(root);
    state.graph.nodes[0]!.status = "completed";
    writeTaskGraphAtomic(root, state.graph);
    expect(criticReopen(root, { nodeId: "a", round: 1 }).code).toBe("TASKGRAPH_REOPENED");
    const before = await readFile(taskGraphPath(root), "utf8");
    const third = criticReopen(root, { nodeId: "a", round: 1 });
    expect(third.code).toBe("TASKGRAPH_REOPEN_LIMIT");
    expect(await readFile(taskGraphPath(root), "utf8")).toBe(before);
  });

  it("round 4 → CRITIC_ROUND_LIMIT", async () => {
    const root = await tmpRoot();
    init(root, { nodes: [node("a", { status: "completed" })] });
    expect(criticReopen(root, { nodeId: "a", round: 4 }).code).toBe("TASKGRAPH_CRITIC_ROUND_LIMIT");
  });

  it("pending 节点不可重开 → INVALID", async () => {
    const root = await tmpRoot();
    init(root, { nodes: [node("a")] });
    expect(criticReopen(root, { nodeId: "a", round: 1 }).code).toBe("TASKGRAPH_INVALID");
  });
});

describe("replay / report", () => {
  it("replay 跳过 completed,其余待跑", async () => {
    const root = await tmpRoot();
    init(root, { nodes: [node("a", { status: "completed" }), node("b")] });
    const res = replay(root);
    expect(res.ok).toBe(true);
    expect(res.code).toBe("TASKGRAPH_REPLAY_SKIPPED");
    expect(res.skipped).toEqual(["a"]);
    expect(res.executed).toEqual(["b"]);
  });

  it("历史 completedIds 里的 pending 节点也跳过", async () => {
    const root = await tmpRoot();
    init(root, { nodes: [node("a"), node("b")] });
    const res = replay(root, ["a"]);
    expect(res.skipped).toEqual(["a"]);
    expect(res.executed).toEqual(["b"]);
  });

  it("report 汇总节点/边/状态/配额/前沿", async () => {
    const root = await tmpRoot();
    init(root, {
      nodes: [node("a", { status: "completed" }), node("c", { kind: "collection", status: "completed" }), node("d")],
      edges: [{ from: "a", to: "d" }],
      analyzedNodeIds: ["a"],
      plannerRuns: 2,
      consecutiveErrors: 1,
    });
    const rep = report(root);
    expect(rep.ok).toBe(true);
    expect(rep.nodes).toBe(3);
    expect(rep.edges).toBe(1);
    expect(rep.byKind).toEqual({ exec: 2, collection: 1 });
    expect(rep.byStatus).toEqual({ completed: 2, pending: 1 });
    expect(rep.plannerRuns).toBe(2);
    expect(rep.frontier).toBe(1);
    expect(rep.unseenCompletions).toEqual(["c"]);
  });

  it("空 root 的 report:found=false、全零", async () => {
    const root = await tmpRoot();
    const rep = report(root);
    expect(rep.ok).toBe(true);
    expect(rep.found).toBe(false);
    expect(rep.nodes).toBe(0);
  });

  it("store 码表导出完整", () => {
    expect([...TASK_GRAPH_STORE_CODES]).toEqual(["TASKGRAPH_STORE_WRITE_FAILED", "TASKGRAPH_STORE_ERROR"]);
  });
});
