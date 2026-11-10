/**
 * 分身目录会话过滤(分身卡只显示当前进度中的 session 的子代理):
 * subagents.list 带 sessionId → running(注册表)与 past(journal 终态)两区都按会话过滤。
 */
import { describe, it, expect } from "vitest";
import WebSocket from "ws";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import type { ProjectRegistry } from "../src/projects.js";

interface Row { agentId?: string; sessionId?: string; title?: string }

describe("WS 面:subagents.list 会话过滤", () => {
  it("带 sessionId 只回该会话的运行/终态;不带回全部(兼容旧客户端)", async () => {
    const port = 7899;
    const journal = new MemoryJournal();
    // 两个会话各一对 spawn/result(跨会话倒灌的旧形态:A 会话用户不该看到 B 会话的终态)
    const mk = (sid: string, aid: string, ok: boolean, at: number) => {
      journal.append({ kind: "subagent.spawn", sessionId: sid, time: at, payload: { agentId: aid, title: "t-" + aid, instructions: "i" } } as never);
      journal.append({ kind: "subagent.result", sessionId: sid, time: at + 1000, payload: { agentId: aid, event: { ok, finalText: "f" } } } as never);
    };
    mk("sess-A", "agent-a1", true, 1000);
    mk("sess-B", "agent-b1", false, 2000);
    // 注册表:A 会话一个真运行中,B 会话一个(应被滤)
    (globalThis as { __bgAgents?: Map<string, object> }).__bgAgents = new Map([
      ["agent-a2", { outputFile: "/tmp/a2", status: "running", sessionId: "sess-A", title: "跑着A" }],
      ["agent-b2", { outputFile: "/tmp/b2", status: "running", sessionId: "sess-B", title: "跑着B" }],
    ]);
    const srv = startGatewayServer({ port, taskManager: new TaskSupervisor(), journal, projects: { activeId: () => "p1", resolveWorkdir: () => "/tmp", list: () => [] } as unknown as ProjectRegistry });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const inbox: Record<string, unknown>[] = [];
      ws.on("message", (r) => inbox.push(JSON.parse(r.toString()) as Record<string, unknown>));
      await new Promise((r) => ws.on("open", r));
      const ask = (body: object) => {
        inbox.length = 0;
        ws.send(JSON.stringify({ v: 1, ...body }));
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("subagents.list.result 超时")), 8000);
          const p = setInterval(() => {
            const m = inbox.find((x) => x.type === "subagents.list.result");
            if (m) { clearTimeout(t); clearInterval(p); resolve(m); }
          }, 25);
        });
      };
      const a = await ask({ type: "subagents.list", sessionId: "sess-A" });
      expect((a.running as Row[]).map((r) => r.agentId)).toEqual(["agent-a2"]);
      expect((a.past as Row[]).map((r) => r.agentId)).toEqual(["agent-a1"]);
      const all = await ask({ type: "subagents.list" });
      expect((all.running as Row[]).length).toBe(2);
      expect((all.past as Row[]).length).toBe(2);
      ws.close();
    } finally {
      delete (globalThis as { __bgAgents?: Map<string, object> }).__bgAgents;
      srv.close();
    }
  });
});
