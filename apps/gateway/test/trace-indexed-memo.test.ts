/**
 * 轨迹链路深度优化的正确性回归(2026-11-03)。
 *
 * 背景:
 * - trace.stats / trace.query 曾用 journal.readAll().filter(sid) 全库扫(实测 median 12.2ms@28万条),
 *   现改走 readSession(sid) 的会话索引(O(log n),实测 2.62ms)。
 * - trace.stats 另加水位 memo(照 session.status 范式),事件数不变直接复用上次聚合。
 *
 * 本文件验的是**缓存/索引不会让数据变旧**:同水位复用、追加事件后必须立刻反映新数据、
 * 无此会话时不崩。性能收益本身由 bench 实测证明(见 tasks/step-1029 留痕),这里只管正确性。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import WebSocket from "ws";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { NodeRegistry } from "../src/nodes.js";

/** 起一个 gateway、发一条消息、等指定类型回包。 */
async function withGateway<T>(
  port: number,
  journal: MemoryJournal,
  run: (send: (o: unknown) => void, waitFor: (type: string) => Promise<Record<string, any>>) => Promise<T>,
): Promise<T> {
  const srv = startGatewayServer({ port, taskManager: new TaskSupervisor(), journal, nodes: new NodeRegistry() });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: Record<string, any>[] = [];
  ws.on("message", (r) => inbox.push(JSON.parse(r.toString())));
  await new Promise((r) => ws.on("open", r));
  const send = (o: unknown) => ws.send(JSON.stringify(o));
  const waitFor = async (type: string) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const hit = inbox.find((m) => m.type === type);
      if (hit) { inbox.length = 0; return hit; }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`${type} 超时`);
  };
  try {
    return await run(send, waitFor);
  } finally {
    ws.close();
    await srv.close();
  }
}

/** 造一次 turn 的完整事件(含 usage,便于断言数值变化)。 */
function appendTurn(journal: MemoryJournal, sid: string, turn: number, llmMs: number, totalTok: number) {
  journal.append({ kind: "turn.start", sessionId: sid, payload: { turn } });
  journal.append({ kind: "message.agent", sessionId: sid, payload: { text: "x", turn, step: 0, llmMs, usage: { inputTokens: totalTok, outputTokens: 1, totalTokens: totalTok + 1 } } });
  journal.append({ kind: "turn.end", sessionId: sid, payload: { turn, reason: "completed" } });
}

describe("trace.stats 索引读 + 水位 memo(正确性)", () => {
  it("同水位重复请求:结果稳定(缓存复用不改变语义)", async () => {
    const journal = new MemoryJournal();
    appendTurn(journal, "m1", 1, 1000, 100);
    await withGateway(7881, journal, async (send, waitFor) => {
      send({ v: 1, type: "trace.stats", sessionId: "m1" });
      const a = (await waitFor("trace.stats.result")).stats;
      send({ v: 1, type: "trace.stats", sessionId: "m1" });
      const b = (await waitFor("trace.stats.result")).stats;
      expect(a.turns).toBe(1);
      expect(b.turns).toBe(1);
      expect(b.llmMs).toBe(a.llmMs);
      expect(b.tokens.total).toBe(a.tokens.total);
    });
  });

  it("追加事件后立即反映新数据(水位失效正确)", async () => {
    const journal = new MemoryJournal();
    appendTurn(journal, "m2", 1, 1000, 100);
    await withGateway(7882, journal, async (send, waitFor) => {
      send({ v: 1, type: "trace.stats", sessionId: "m2" });
      const first = (await waitFor("trace.stats.result")).stats;
      expect(first.turns).toBe(1);
      expect(first.llmMs).toBe(1000);

      // 追加第二个 turn —— 缓存必须失效(否则用户会看到永远不变的数字)
      appendTurn(journal, "m2", 2, 2000, 200);
      send({ v: 1, type: "trace.stats", sessionId: "m2" });
      const second = (await waitFor("trace.stats.result")).stats;
      expect(second.turns).toBe(2);
      expect(second.llmMs).toBe(3000);
      expect(second.tokens.total).toBeGreaterThan(first.tokens.total);
    });
  });

  it("负面:不存在的会话 → 零值统计,不抛不断连", async () => {
    const journal = new MemoryJournal();
    appendTurn(journal, "other", 1, 500, 50);
    await withGateway(7883, journal, async (send, waitFor) => {
      send({ v: 1, type: "trace.stats", sessionId: "nope" });
      const s = (await waitFor("trace.stats.result")).stats;
      expect(s.turns).toBe(0);
      expect(s.llmMs).toBe(0);
      // 连接仍可用:再发一条正常请求能拿到回包
      send({ v: 1, type: "trace.stats", sessionId: "other" });
      const s2 = (await waitFor("trace.stats.result")).stats;
      expect(s2.turns).toBe(1);
    });
  });

  it("会话隔离:别的会话的事件不得混入(索引按 sessionId 切片)", async () => {
    const journal = new MemoryJournal();
    appendTurn(journal, "iso-a", 1, 1000, 100);
    appendTurn(journal, "iso-b", 1, 9999, 999);
    appendTurn(journal, "iso-b", 2, 9999, 999);
    await withGateway(7884, journal, async (send, waitFor) => {
      send({ v: 1, type: "trace.stats", sessionId: "iso-a" });
      const a = (await waitFor("trace.stats.result")).stats;
      expect(a.turns).toBe(1);
      expect(a.llmMs).toBe(1000); // 不能是 1000+9999+9999
    });
  });
});

describe("trace.query 索引读(正确性)", () => {
  it("只回本会话事件 + summary 聚合正确", async () => {
    const journal = new MemoryJournal();
    appendTurn(journal, "q1", 1, 1000, 100);
    journal.append({ kind: "tool.result", sessionId: "q1", payload: { toolCallId: "c1", name: "bash", content: "ok", durationMs: 500, turn: 1, step: 0 } });
    appendTurn(journal, "q2", 1, 8888, 888); // 干扰会话
    await withGateway(7885, journal, async (send, waitFor) => {
      send({ v: 1, type: "trace.query", sessionId: "q1" });
      const r = await waitFor("trace.query.result");
      expect(r.summary.kindCounts["turn.start"]).toBe(1);
      expect(r.summary.kindCounts["tool.result"]).toBe(1);
      expect(r.summary.slowestTools[0].name).toBe("bash");
      // 干扰会话的事件不得出现
      expect(r.events.every((e: { sessionId: string }) => e.sessionId === "q1")).toBe(true);
    });
  });

  it("追加事件后立即反映(无脏读)", async () => {
    const journal = new MemoryJournal();
    appendTurn(journal, "q3", 1, 1000, 100);
    await withGateway(7886, journal, async (send, waitFor) => {
      send({ v: 1, type: "trace.query", sessionId: "q3" });
      const first = await waitFor("trace.query.result");
      expect(first.summary.matched).toBe(3);
      appendTurn(journal, "q3", 2, 1000, 100);
      send({ v: 1, type: "trace.query", sessionId: "q3" });
      const second = await waitFor("trace.query.result");
      expect(second.summary.matched).toBe(6);
    });
  });

  it("负面:不存在的会话 → 零值 summary,不抛", async () => {
    const journal = new MemoryJournal();
    await withGateway(7887, journal, async (send, waitFor) => {
      send({ v: 1, type: "trace.query", sessionId: "ghost" });
      const r = await waitFor("trace.query.result");
      expect(r.summary.matched).toBe(0);
      expect(r.events).toEqual([]);
    });
  });
});
