/**
 * 白板广播 worker→gateway 中继(n5「看板数据不更新」根治)契约测试。
 * 根因:生产默认 agent.sessionWorker=true,agent loop 跑在 session-worker **子进程**,那里的 bus 是
 * 独立实例——agent-wiring 落账后的 bus.emit("board.changed") 只在子进程空转,gateway(server.ts:535
 * 订阅的是自己进程的 bus)收不到 → 面板白板视图永不刷新。修法:host 在 journal.appendMany 落账
 * 成功后按 kind 前缀 board. 中继 board.changed(relayBoardChanged)。
 * 两个层次各钉一遍:
 *  ①纯函数层:relayBoardChanged 的映射/过滤语义(不 fork 进程,毫秒级);
 *  ②真 IPC 层:stub worker(STUB_MODE=board)上行 board.update/board.comment + 一条非 board 事件,
 *    断言 gateway 进程的 bus 确实收到 board.changed 且 payload 带正确 sessionId/taskId,非 board 不误发。
 */
import { describe, it, expect, afterEach } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { MemoryJournal, bus } from "@lampgenie/core";
import { TaskSupervisor } from "../src/task-manager.js";
import { createSessionWorkerHost, relayBoardChanged } from "../src/session-worker-host.js";

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, "fixtures", "session-worker-stub.mjs");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (pred: () => boolean, ms = 8000, step = 50): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await wait(step); }
  return pred();
};

afterEach(() => { delete process.env.STUB_MODE; delete process.env.STUB_HOLD_MS; });

describe("relayBoardChanged(n5:worker 侧 bus 与 gateway 不共享,必须中继)", () => {
  it("board.update → emit board.changed,payload 带 sessionId+taskId;非 board 事件不误发", () => {
    const hits: { topic: string; payload: unknown }[] = [];
    const emit = (topic: string, payload: unknown) => hits.push({ topic, payload });
    relayBoardChanged([
      { kind: "board.update", sessionId: "s-1", payload: { taskId: "t-1", rev: 3 } },
      { kind: "message.agent", sessionId: "s-1", payload: { taskId: "t-1", text: "非板事件" } },
      { kind: "boardy.update", sessionId: "s-1", payload: { taskId: "t-1" } }, // 前缀不算 board.(不是 board. 开头)
      { kind: "task.state", sessionId: "s-1", payload: {} },
    ], emit);
    expect(hits).toEqual([{ topic: "board.changed", payload: { sessionId: "s-1", taskId: "t-1" } }]);
  });

  it("board. 前缀统一补发(update/comment/sense 等写板路径);缺 taskId 时 payload 只带 sessionId", () => {
    const hits: { topic: string; payload: unknown }[] = [];
    relayBoardChanged([
      { kind: "board.comment", sessionId: "s-2", payload: { taskId: "t-2" } },
      { kind: "board.sense", sessionId: "s-2", payload: {} },
      { kind: "board.update", sessionId: "s-2", payload: { taskId: 42 } }, // 非字符串 taskId=不带
    ], (topic, payload) => hits.push({ topic, payload }));
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.topic === "board.changed")).toBe(true);
    expect(hits[0]!.payload).toEqual({ sessionId: "s-2", taskId: "t-2" });
    expect(hits[1]!.payload).toEqual({ sessionId: "s-2" });
    expect(hits[2]!.payload).toEqual({ sessionId: "s-2" });
  });

  it("空数组/异常形态零动作(不抛)", () => {
    let calls = 0;
    const emit = () => { calls++; };
    relayBoardChanged([], emit);
    relayBoardChanged([{ kind: undefined, sessionId: "s" }, {} as { kind?: string }], emit);
    expect(calls).toBe(0);
  });
});

describe("session-worker 上行 board 事件 → gateway bus 中继(真 IPC)", () => {
  it("worker 发 board.update/board.comment → gateway bus 收到 board.changed(sessionId/taskId 正确),非 board 事件不误发", async () => {
    process.env.STUB_MODE = "board";
    const journal = new MemoryJournal();
    const tm = new TaskSupervisor();
    const host = createSessionWorkerHost({
      taskManager: tm,
      journal,
      streamSink: () => {},
      bgAgentsMirror: new Map(),
      repoRoot: mkdtempSync(join(tmpdir(), "swh-board-")),
      browserConfig: { enabled: () => false, allowDomains: () => [] },
      setState: (task, to, result) => tm.setState(task, to, result),
      workerEntry: STUB,
    });
    const hits: { sessionId?: string; taskId?: string }[] = [];
    const off = (p: unknown) => hits.push(p as { sessionId?: string; taskId?: string });
    bus.on("board.changed", off);
    try {
      const task = tm.submit("user", "s-b1", "板中继任务");
      host.dispatch(task);
      // 中继是落账后的同步 emit:等 task done 时两条 board.changed 必已到(非 board 事件不补发)
      expect(await waitUntil(() => tm.list().find((t) => t.id === task.id)?.state === "done")).toBe(true);
      expect(hits).toEqual([
        { sessionId: "s-b1", taskId: "t-board-1" },
        { sessionId: "s-b1", taskId: "t-board-1" },
      ]);
      // 落账本身已持久化(面板回拉必取到),中继与落账同一事务窗
      expect(journal.readSession("s-b1").filter((e) => e.kind === "board.update")).toHaveLength(1);
      expect(await waitUntil(() => host.activeCount === 0)).toBe(true);
    } finally {
      bus.off("board.changed", off);
    }
  }, 20_000);
});
