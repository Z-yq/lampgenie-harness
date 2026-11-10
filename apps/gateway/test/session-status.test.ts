import { describe, it, expect } from "vitest";
import { parseClientMessage } from "@lampgenie/protocol";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { NodeRegistry } from "../src/nodes.js";
import { MemoryJournal } from "@lampgenie/core";
import { todoTool, reapOrphanSubagents } from "../src/agent-wiring.js";
import WebSocket from "ws";

describe("协议:session.status(D1)", () => {
  it("合法消息过/缺信封拒", () => {
    expect(parseClientMessage('{"v":1,"type":"session.status","sessionId":"s1"}')?.type).toBe("session.status");
    expect(parseClientMessage('{"type":"session.status","sessionId":"s1"}')).toBeNull();
  });
});

describe("todo_write 工具(D2)", () => {
  it("合法整表落 journal todo.updated(严格校验:空 content/非法状态直接失败)", async () => {
    const journal = new MemoryJournal();
    const tool = todoTool(journal, "s-todo");
    const out = await tool.execute({ items: [
      { content: "定位问题", status: "completed" },
      { content: "修复并补测试", status: "in_progress" },
      { content: "回归", status: "pending" },
    ] });
    expect(out).toContain("已记录计划 3 项");
    const ev = journal.readAll().find((e) => e.kind === "todo.updated");
    expect(ev?.sessionId).toBe("s-todo");
    const items = (ev?.payload as { items: { content: string; status: string }[] }).items;
    expect(items.length).toBe(3);
    expect(items[2]).toEqual({ content: "回归", status: "pending" });
    expect(await tool.execute({ items: [] })).toContain("[todo_write] items 不能为空");
  });
});

describe("session.status 聚合(D3)", () => {
  it("todo/subagent/workflow 投影从 journal 正确派生", async () => {
    const port = 7851;
    const journal = new MemoryJournal();
    const tm = new TaskSupervisor();
    journal.append({ kind: "todo.updated", sessionId: "s-agg", payload: { items: [
      { content: "步骤一", status: "completed" },
      { content: "步骤二", status: "in_progress" },
      { content: "步骤三", status: "pending" },
    ] } });
    journal.append({ kind: "subagent.spawn", sessionId: "s-agg", payload: { taskId: "t1", backend: "echo-child" } });
    journal.append({ kind: "subagent.spawn", sessionId: "s-agg", payload: { taskId: "t2", backend: "echo-child" } });
    journal.append({ kind: "subagent.result", sessionId: "s-agg", payload: { taskId: "t1", event: { type: "result" } } });
    journal.append({ kind: "workflow.run.start", sessionId: "s-agg", payload: { wfId: "wf-1" } });
    journal.append({ kind: "workflow.ask", sessionId: "wf-1", payload: { actor: "a", seq: 1 } });
    journal.append({ kind: "workflow.ask", sessionId: "wf-1", payload: { actor: "b", seq: 2 } });
    journal.append({ kind: "workflow.run.start", sessionId: "s-agg", payload: { wfId: "wf-2" } });
    journal.append({ kind: "workflow.run.done", sessionId: "s-agg", payload: { wfId: "wf-2", ok: true } });
    const task = tm.submit("user", "s-agg", "聚合测试任务");
    const srv = startGatewayServer({ port, taskManager: tm, journal, nodes: new NodeRegistry() });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox: { type: string; status?: Record<string, never> }[] = [];
    ws.on("message", (r) => inbox.push(JSON.parse(r.toString())));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ v: 1, type: "session.status", sessionId: "s-agg" }));
    const res = (await new Promise<{ type: string; status?: never }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("session.status 超时")), 5_000);
      const p = setInterval(() => {
        const m = inbox.find((x) => x.type === "session.status.result");
        if (m) { clearTimeout(t); clearInterval(p); resolve(m as never); }
      }, 30);
    })).status as unknown as {
      task: { id: string; state: string };
      todo: { items: { status: string }[]; completed: number; total: number };
      subagents: { spawnCount: number; resultCount: number; running: number };
      workflows: { wfId: string; asks: number; done: boolean }[];
    };
    expect(res.task.id).toBe(task.id);
    expect(res.todo.completed).toBe(1);
    expect(res.todo.total).toBe(3);
    expect(res.todo.items[1]!.status).toBe("in_progress");
    expect(res.subagents).toEqual({ spawnCount: 2, resultCount: 2, running: 0 });
 // 启动僵尸清算(机制4)改变了投影基线:t2 的 spawn 是无 result 的上进程遗留 →
    // server 启动即补一条 ok:false 终态(网关重启,子代理随进程终止);t1 的 spawn 已有 result
    // (无 agentId 旧形态按 FIFO 配对)不被重收。故 resultCount 1→2、running 1→0。
    const reapCount = () => (journal.readAll().filter((e) => e.kind === "subagent.result")).length;
    expect(reapCount(), "t2 补了 1 条终态;t1 不双计").toBe(2);
    expect(reapOrphanSubagents(journal), "二次清算幂等:补过终态即非孤儿").toEqual([]);
    expect(reapCount(), "幂等:终态计数不再增长").toBe(2);
    expect(res.workflows).toContainEqual({ wfId: "wf-1", asks: 2, done: false });
    expect(res.workflows).toContainEqual({ wfId: "wf-2", asks: 0, done: true });
    ws.close();
    await srv.close();
  }, 10_000);
});

describe("trace.stats 命令( D3)", () => {
  it("预置 loop 追踪事件 → WS 聚合返回", async () => {
    const { parseClientMessage: parse } = await import("@lampgenie/protocol");
    expect(parse('{"v":1,"type":"trace.stats","sessionId":"s"}')?.type).toBe("trace.stats");
    expect(parse('{"type":"trace.stats","sessionId":"s"}')).toBeNull();

    const port = 7852;
    const journal = new MemoryJournal();
    journal.append({ kind: "turn.start", sessionId: "ts", payload: { turn: 1 } });
    journal.append({ kind: "step.start", sessionId: "ts", payload: { turn: 1, step: 0 } });
    journal.append({ kind: "message.agent", sessionId: "ts", payload: { text: "hi", turn: 1, step: 0, llmMs: 1200, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } });
 // 子代理消耗(子 loop 事件以 subagent.event 入主 journal,内层 kind=message.agent)
    journal.append({ kind: "subagent.spawn", sessionId: "ts", payload: { agentId: "sa1", taskId: "sub-1", title: "子任务" } });
    journal.append({ kind: "subagent.event", sessionId: "ts", payload: { agentId: "sa1", taskId: "sub-1", kind: "message.agent", llmMs: 800, usage: { inputTokens: 2000, outputTokens: 300, totalTokens: 2300, cachedTokens: 1500 } } });
    journal.append({ kind: "step.end", sessionId: "ts", payload: { turn: 1, step: 0, reason: "completed" } });
    journal.append({ kind: "turn.end", sessionId: "ts", payload: { turn: 1, reason: "completed" } });
    const srv = startGatewayServer({ port, taskManager: new TaskSupervisor(), journal, nodes: new NodeRegistry() });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox: { type: string; stats?: never }[] = [];
    ws.on("message", (r) => inbox.push(JSON.parse(r.toString())));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ v: 1, type: "trace.stats", sessionId: "ts" }));
    const res = (await new Promise<{ stats?: never }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("trace.stats 超时")), 5_000);
      const p = setInterval(() => {
        const m = inbox.find((x) => x.type === "trace.stats.result");
        if (m) { clearTimeout(t); clearInterval(p); resolve(m); }
      }, 30);
    })).stats as unknown as { turns: number; steps: number; llmMs: number; tokens: { total: number }; subagents?: { spawned: number; totals: { calls: number; input: number; output: number; total: number; cached: number } } };
    expect(res.turns).toBe(1);
    expect(res.steps).toBe(1);
    expect(res.llmMs).toBe(1200);
    expect(res.tokens.total).toBe(15);
    // 子代理 token 单独一区(不并入 tokens.total)
    expect(res.subagents?.spawned).toBe(1);
    expect(res.subagents?.totals).toEqual({ calls: 1, input: 2000, output: 300, total: 2300, cached: 1500, llmMs: 800 });
    ws.close();
    await srv.close();
  }, 10_000);
});
