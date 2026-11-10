/**
 * F1 会话投影归约器:单一纯函数 todo/subagent/workflow/压缩/消息行(单时钟纪律)。
 */
import { describe, it, expect } from "vitest";
import { projectSession, type SessionEventLike } from "../src/session/projection.js";

const ev = (kind: string, payload: unknown = {}, sessionId = "s"): SessionEventLike & { sessionId: string } => ({ kind, payload, sessionId });

describe("projectSession(F1 归约器)", () => {
  it("todo 最后写赢;completed/total 派生", () => {
    const p = projectSession([
      ev("todo.updated", { items: [{ content: "a", status: "pending" }] }),
      ev("todo.updated", { items: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "weird" }] }),
    ]);
    expect(p.todo?.total).toBe(3);
    expect(p.todo?.completed).toBe(1);
    expect(p.todo?.items[1]?.status).toBe("in_progress");
    expect(p.todo?.items[2]?.status).toBe("pending"); // 未知态夹紧为 pending
  });

  it("subagent 计数:spawn/result/running", () => {
    const p = projectSession([ev("subagent.spawn"), ev("subagent.spawn"), ev("subagent.result", { event: { type: "result" } })]);
    expect(p.subagents).toEqual({ spawnCount: 2, resultCount: 1, running: 1 });
  });

  it("workflow:start/done/ask 跨会话关联(ask 落在 wfId 会话,旧行为同口径)", () => {
    const all = [
      ev("workflow.run.start", { wfId: "wf-1" }),
      ev("workflow.ask", {}, "wf-1"),
      ev("workflow.ask", {}, "wf-1"),
      ev("workflow.run.start", { wfId: "wf-2" }),
      ev("workflow.run.done", { wfId: "wf-2", ok: true }),
    ];
    const p = projectSession(all.filter((e) => e.sessionId === "s"), all);
    expect(p.workflows).toEqual([
      { wfId: "wf-1", asks: 2, done: false },
      { wfId: "wf-2", asks: 0, done: true },
    ]);
  });

  it("压缩边界:start/done 配对成标记;孤 start 不计", () => {
    const p = projectSession([
      { kind: "compact.start", payload: { tokens: 9000 }, time: 100 },
      { kind: "compact.done", payload: { summaryChars: 500 }, time: 105 },
      { kind: "compact.start", payload: {}, time: 200 }, // 未完成
    ]);
    expect(p.compactions).toEqual([{ at: 100, tokens: 9000, summaryChars: 500 }]);
  });

  it("消息行:user/agent 文本入行;工具/系统事件不入行", () => {
    const p = projectSession([
      ev("message.user", { text: "干个活" }),
      ev("subagent.spawn"),
      ev("message.agent", { text: "干完了" }),
      ev("task.done", { id: "t" }),
    ]);
    expect(p.rows).toEqual([
      { kind: "user", text: "干个活" },
      { kind: "agent", text: "干完了" },
    ]);
  });
});

// 2026-11-04 有界化(网关 OOM 根因):rows 尾部窗口 50 + 单行 200 字 + rowCount 总数。
// 实锤:巨型会话投影含数千条全文消息,session.status 每 3s 轮询全量序列化,4GB 堆被打穿
// (崩溃栈=JsonStringify);而面板状态条只消费 todo/subagents/workflows/compactions。
it("rows 有界:尾部 50 条窗口 + 单行 200 字截断 + rowCount=真实总数", () => {
  const events: { kind: string; payload: Record<string, unknown> }[] = [];
  for (let i = 0; i < 120; i++) {
    events.push({ kind: "message.agent", payload: { text: "m" + i + "-" + "x".repeat(300) } });
  }
  const p = projectSession(events, []);
  expect(p.rows.length).toBe(50); // 尾部窗口
  expect(p.rowCount).toBe(120); // 真实总数
  expect(p.rows[0]!.text.startsWith("m70-")).toBe(true); // 窗口起点=第 71 条
  expect(p.rows[0]!.text.length).toBeLessThanOrEqual(200 + 20); // 截断+标注
  expect(p.rows[0]!.text).toContain("行截断");
});
