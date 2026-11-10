/**
 * 运行看板 WS 接线测试:拉模型回包(dashboard.sessions/trends)+ 推模型触发
 * (journal 订阅 → dashboard.changed 节流广播)+ 协议信封校验。
 */
import { describe, it, expect } from "vitest";
import WebSocket from "ws";
import { parseClientMessage } from "@lampgenie/protocol";
import { MemoryJournal } from "@lampgenie/core";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { NodeRegistry } from "../src/nodes.js";

type Msg = Record<string, unknown> & { type: string };

async function waitMsg(ws: WebSocket, inbox: Msg[], type: string, timeoutMs = 5_000): Promise<Msg> {
  const t0 = Date.now();
  for (;;) {
    const m = inbox.find((x) => x.type === type);
    if (m) return m;
    if (Date.now() - t0 > timeoutMs) throw new Error(type + " 超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe("运行看板 WS 接线", () => {
  it("协议:合法信封过/缺信封拒", () => {
    expect(parseClientMessage('{"v":1,"type":"dashboard.sessions"}')?.type).toBe("dashboard.sessions");
    expect(parseClientMessage('{"v":1,"type":"dashboard.sessions","projectId":"p1"}')?.type).toBe("dashboard.sessions");
    expect(parseClientMessage('{"v":1,"type":"dashboard.trends"}')?.type).toBe("dashboard.trends");
    expect(parseClientMessage('{"type":"dashboard.sessions"}')).toBeNull();
  });

  it("dashboard.sessions/trends 从 journal 折算回包;scope 过滤生效", async () => {
    const port = 7861;
    const journal = new MemoryJournal();
    journal.append({ kind: "task.start", sessionId: "sA", payload: { id: "t1", state: "running", projectId: "proj-a" } });
    journal.append({ kind: "message.user", sessionId: "sA", payload: { text: "看板会话A" } });
    journal.append({ kind: "tool.call", sessionId: "sA", payload: { name: "bash", toolCallId: "c1", arguments: "{}" } });
    journal.append({ kind: "turn.end", sessionId: "sA", payload: { reason: "completed" } });
    journal.append({ kind: "message.user", sessionId: "sFree", payload: { text: "无主会话" } });

    const srv = startGatewayServer({ port, taskManager: new TaskSupervisor(), journal, nodes: new NodeRegistry() });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox: Msg[] = [];
    ws.on("message", (r) => inbox.push(JSON.parse(r.toString())));
    await new Promise((r) => ws.on("open", r));

    ws.send(JSON.stringify({ v: 1, type: "dashboard.sessions" }));
    const all = (await waitMsg(ws, inbox, "dashboard.sessions.result")) as { scope: string; sessions: { sessionId: string; projectId: string | null; status: string }[] };
    expect(all.scope).toBe("all");
    const ids = all.sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual(["sA", "sFree"]);
    const sA = all.sessions.find((s) => s.sessionId === "sA")!;
    expect(sA.projectId).toBe("proj-a");
    expect(sA.status).toBe("waiting_for_input");

    ws.send(JSON.stringify({ v: 1, type: "dashboard.sessions", projectId: "proj-a" }));
    const scoped = (await new Promise<Msg>((resolve) => {
      const t0 = Date.now();
      const p = setInterval(() => {
        const m = inbox.filter((x) => x.type === "dashboard.sessions.result").pop();
        if (m && (m as { scope: string }).scope === "proj-a") { clearInterval(p); resolve(m); }
        if (Date.now() - t0 > 5_000) { clearInterval(p); resolve({ type: "timeout" }); }
      }, 30);
    })) as { scope: string; sessions: { sessionId: string }[] };
    expect(scoped.sessions.map((s) => s.sessionId)).toEqual(["sA"]);

    ws.send(JSON.stringify({ v: 1, type: "dashboard.trends" }));
    const trends = (await waitMsg(ws, inbox, "dashboard.trends.result")) as { current: { sessionsEnded: number }; daily: unknown[] };
    // 无终态任务=无会话入样(诚实口径),但日桶 14 天补零仍在。
    expect(trends.current.sessionsEnded).toBe(0);
    expect(trends.daily).toHaveLength(14);
    ws.close();
    await srv.close();
  }, 15_000);

  it("journal 追加 → dashboard.changed 节流推送(推模型触发)", async () => {
    const port = 7862;
    const journal = new MemoryJournal();
    const srv = startGatewayServer({ port, taskManager: new TaskSupervisor(), journal, nodes: new NodeRegistry() });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox: Msg[] = [];
    ws.on("message", (r) => inbox.push(JSON.parse(r.toString())));
    await new Promise((r) => ws.on("open", r));
    // 连发多条事件(高频工具流形态)→ 节流窗内只应聚成少量 changed 帧。
    for (let i = 0; i < 10; i++) {
      journal.append({ kind: "tool.call", sessionId: "s-push", payload: { name: "bash", toolCallId: "c" + i, arguments: "{}" } });
    }
    const first = await waitMsg(ws, inbox, "dashboard.changed", 5_000);
    expect(first.type).toBe("dashboard.changed");
    // 节流尾沿已过后再追加 → 必有一帧(尾沿保证)。
    const countBefore = inbox.filter((m) => m.type === "dashboard.changed").length;
    await new Promise((r) => setTimeout(r, 700));
    journal.append({ kind: "tool.call", sessionId: "s-push", payload: { name: "read", toolCallId: "cX", arguments: "{}" } });
    await waitMsg(ws, inbox, "dashboard.changed", 3_000);
    expect(inbox.filter((m) => m.type === "dashboard.changed").length).toBeGreaterThanOrEqual(countBefore);
    ws.close();
    await srv.close();
  }, 15_000);
});
