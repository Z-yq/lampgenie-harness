import { describe, it, expect } from "vitest";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { NodeRegistry } from "../src/nodes.js";
import { MemoryJournal } from "@lampgenie/core";
import WebSocket from "ws";

/** 起一个 gateway + ws,返回 { inbox, send, waitFor, close }(脚手架照 session-status.test.ts)。 */
async function boot(port: number) {
  const journal = new MemoryJournal();
  const srv = startGatewayServer({ port, taskManager: new TaskSupervisor(), journal, nodes: new NodeRegistry() });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: Record<string, unknown>[] = [];
  ws.on("message", (r) => inbox.push(JSON.parse(r.toString()) as Record<string, unknown>));
  await new Promise((r) => ws.on("open", r));
  const waitFor = (type: string, timeoutMs = 5_000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${type} 超时`)), timeoutMs);
      const p = setInterval(() => {
        const m = inbox.find((x) => x.type === type);
        if (m) { clearTimeout(t); clearInterval(p); resolve(m); }
      }, 30);
    });
  const send = (msg: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, ...msg }));
  const close = async () => { ws.close(); await srv.close(); };
  return { journal, ws, inbox, waitFor, send, close };
}

describe("trace.query 命令(txa6/txa7/txa8)", () => {
  it("事件过滤+投影+聚合经 WS 回 trace.query.result", async () => {
    const port = 7866;
    const env = await boot(port);
    const j = env.journal;
    j.append({ kind: "turn.start", sessionId: "tq", payload: { turn: 1 } });
    j.append({ kind: "message.agent", sessionId: "tq", payload: { text: "hi", turn: 1, llmMs: 300 } });
    j.append({ kind: "tool.result", sessionId: "tq", payload: { toolCallId: "c1", name: "bash", content: "ok", durationMs: 120 } });
    // 新形态错误(结构化 error.origin)
    j.append({ kind: "tool.result", sessionId: "tq", payload: { toolCallId: "c2", name: "read", content: "", durationMs: 40, error: { origin: "timeout", message: "超时" } } });
    j.append({ kind: "turn.end", sessionId: "tq", payload: { turn: 1, reason: "completed" } });

    env.send({ type: "trace.query", sessionId: "tq" });
    const res = await env.waitFor("trace.query.result");
    expect(res.sessionId).toBe("tq");
    const summary = res.summary as {
      matched: number; returned: number; kindCounts: Record<string, number>;
      llmCalls: number; llmFailures: number; toolErrors: { name: string; count: number }[];
    };
    expect(summary.matched).toBe(5);
    expect(summary.returned).toBe(5);
    // 与构造的事件逐 kind 一致
    expect(summary.kindCounts).toEqual({
      "turn.start": 1, "message.agent": 1, "tool.result": 2, "turn.end": 1,
    });
    expect((res.events as unknown[]).length).toBe(5);
    expect(summary.llmCalls).toBe(1);
    expect(summary.llmFailures).toBe(0);
    expect(summary.toolErrors).toEqual([{ name: "read", count: 1, origins: { timeout: 1 } }]);
    await env.close();
  }, 20_000);

  it("未知 session → 零值 summary,连接仍可用", async () => {
    const port = 7867;
    const env = await boot(port);
    env.journal.append({ kind: "turn.start", sessionId: "other", payload: { turn: 1 } });

    env.send({ type: "trace.query", sessionId: "no-such-session" });
    const res = await env.waitFor("trace.query.result");
    expect(res.events).toEqual([]);
    expect(res.summary).toMatchObject({
      matched: 0, returned: 0, kindCounts: {},
      slowestTools: [], toolErrors: [], llmCalls: 0, llmFailures: 0,
      firstSeq: null, lastSeq: null,
    });

    // 连接未断:同一 ws 还能继续收其它回包
    env.send({ type: "ping" });
    const pong = await env.waitFor("pong");
    expect(typeof pong.time).toBe("number");
    await env.close();
  }, 20_000);

  it("filter.onlyErrors=true 只回错误事件(新旧两形态都认)", async () => {
    const port = 7868;
    const env = await boot(port);
    const j = env.journal;
    j.append({ kind: "tool.result", sessionId: "tqe", payload: { toolCallId: "ok1", name: "bash", content: "fine", durationMs: 10 } });
    // 旧形态:无 error 键,content 以「错误:」开头
    j.append({ kind: "tool.result", sessionId: "tqe", payload: { toolCallId: "old", name: "bash", content: "错误: 命令失败", durationMs: 20 } });
    // 新形态:结构化 error
    j.append({ kind: "tool.result", sessionId: "tqe", payload: { toolCallId: "new", name: "grep", content: "", durationMs: 30, error: { origin: "unknown-tool", message: "未知工具" } } });

    env.send({ type: "trace.query", sessionId: "tqe", filter: { onlyErrors: true } });
    const res = await env.waitFor("trace.query.result");
    const events = res.events as { seq: number; payload: { toolCallId?: string } }[];
    expect(events.map((e) => e.payload.toolCallId)).toEqual(["old", "new"]);
    const summary = res.summary as { matched: number; returned: number; toolErrors: { name: string; count: number }[] };
    expect(summary.matched).toBe(2);
    expect(summary.returned).toBe(2);
    expect(summary.toolErrors.map((t) => [t.name, t.count])).toEqual([["bash", 1], ["grep", 1]]);
    await env.close();
  }, 20_000);

  it("images 不透传 base64,长 content 截断", async () => {
    const port = 7869;
    const env = await boot(port);
    const big = "x".repeat(5000);
    env.journal.append({
      kind: "tool.result", sessionId: "tqi",
      payload: { toolCallId: "c1", name: "view_image", content: big, durationMs: 5, images: ["data:image/png;base64,AAAA"] },
    });
    env.send({ type: "trace.query", sessionId: "tqi" });
    const res = await env.waitFor("trace.query.result");
    const ev = (res.events as { payload: { content: string; images: string[]; truncated?: boolean } }[])[0]!;
    expect(ev.payload.content.length).toBeLessThanOrEqual(2064);
    expect(ev.payload.truncated).toBe(true);
    expect(ev.payload.images).toEqual(["(image omitted)"]);
    expect(JSON.stringify(res)).not.toContain("base64");
    await env.close();
  }, 20_000);
});
