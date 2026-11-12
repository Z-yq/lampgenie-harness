import { AGENT_WIRING_SRC } from "./panel-source.js";
/**
 *  后台子代理 idle wake 接线测试(读源码 + 纯路径,零真实 spawn/零真实 submit)。
 * 契约:
 * 1) agent-wiring 引入 runtime idle-wake 纯判定,并在后台子代理终态回调(deadline 收割 + bg result)调用;
 * 2) 判定门:BUSY/NO_PENDING/STALE 一律不 submit;只有 WAKE 才起 system model-only 任务;
 * 3) 提交口径:submit("system", sessionId, prompt, { title:"[唤醒] 后台单元完成", idempotencyKey:"idle-wake:<session>:<ids>" });
 * 4) activeTaskCount 只数 running/queued;lastTurnEndAt 取 journal 最近 turn.end;
 * 5) 同批重复回调不重复 submit(内存 ack + 幂等键);失败只 console.warn,不影响子代理收尾;
 * 6) 纯路径:runtime wakeVerdict 的 busy/idle/stale/批合并逐条成立。
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { wakeVerdict } from "@lampgenie/runtime/task/idle-wake";
import type { PendingNotification } from "@lampgenie/runtime/task/idle-wake";
import { maybeWakeIdleSession } from "../src/agent-wiring.js";

const wiring = AGENT_WIRING_SRC;
const NOW = 5_000_000;

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `找不到起点:${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(endMarker, start + startMarker.length);
  expect(end, `找不到终点:${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

function notice(id: string, at: number, generation = 1, summary = "子代理完成"): PendingNotification {
  return { id, at, generation, kind: "subagent", summary };
}

describe("接线点(读源码)", () => {
  it("引入 runtime idle-wake 判定", () => {
    expect(wiring).toContain('from "@lampgenie/runtime/task/idle-wake"');
    expect(wiring).toContain("wakeVerdict");
    expect(wiring).toContain("generationOfEvent");
  });

  it("只有 verdict.wake 才 submit(BUSY/NO_PENDING/STALE 不动)", () => {
    const body = between(wiring, "export function maybeWakeIdleSession(", "// 后台子代理注册表");
    expect(body).toContain("if (!verdict.wake || !verdict.prompt)");
    expect(body).toContain("submitted: false");
  });

  it("activeTaskCount 只数 running/queued", () => {
    const body = between(wiring, "export function maybeWakeIdleSession(", "// 后台子代理注册表");
    expect(body).toContain('task.state === "running" || task.state === "queued"');
  });

  it("lastTurnEndAt 取 journal 最近 turn.end", () => {
    const body = between(wiring, "export function maybeWakeIdleSession(", "// 后台子代理注册表");
    expect(body).toContain('if (ev.kind !== "turn.end") continue');
    expect(body).toContain("lastTurnEndAt = ev.time");
  });

  it("提交口径 = system + 固定标题 + 幂等键", () => {
    const body = between(wiring, "export function maybeWakeIdleSession(", "// 后台子代理注册表");
    expect(body).toContain('tm.submit("system", sessionId, verdict.prompt');
    expect(body).toContain('title: "[唤醒] 后台单元完成"');
    expect(body).toContain("idempotencyKey");
    expect(body).toContain("`idle-wake:${sessionId}:${verdict.ids.join(\",\")}`");
  });

  it("两个后台终态回调都接上唤醒(deadline 收割 + bg result)", () => {
    const calls = wiring.match(/maybeWakeIdleSession\(journal, task\.sessionId, tm\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("失败只 warn,不影响子代理收尾", () => {
    const body = between(wiring, "export function maybeWakeIdleSession(", "// 后台子代理注册表");
    expect(body).toContain('console.warn("[gateway] idle wake 失败(不影响子代理收尾):"');
  });

  it("旧代通知过滤:显式 generation 不等即丢弃(未带代次视为当前代)", () => {
    const body = between(wiring, "export function maybeWakeIdleSession(", "// 后台子代理注册表");
    expect(body).toContain("explicitGeneration");
    expect(body).toContain("generation: typeof explicitGeneration === \"number\" ? explicitGeneration : currentGeneration");
  });
});

describe("纯路径:wakeVerdict", () => {
  const base = {
    sessionId: "s1",
    now: NOW,
    lastTurnEndAt: NOW - 60_000,
    activeTaskCount: 0,
    pendingNotifications: [notice("a", 1)],
    currentGeneration: 1,
  };

  it("A busy → BUSY,不唤醒", () => {
    const v = wakeVerdict({ ...base, activeTaskCount: 1 });
    expect(v.code).toBe("BUSY");
    expect(v.wake).toBe(false);
  });

  it("B 空闲 + 通知 → WAKE 且 prompt 含 summary", () => {
    const v = wakeVerdict({ ...base, pendingNotifications: [notice("a", 1, 1, "子代理交付了 X")] });
    expect(v.code).toBe("WAKE");
    expect(v.ids).toEqual(["a"]);
    expect(v.prompt).toContain("子代理交付了 X");
  });

  it("C stale generation 全丢 → STALE", () => {
    const v = wakeVerdict({ ...base, pendingNotifications: [notice("old", 1, 9)], currentGeneration: 2 });
    expect(v.code).toBe("STALE");
    expect(v.ids).toEqual([]);
  });

  it("D 同批多条合并一次且按时间序", () => {
    const v = wakeVerdict({ ...base, pendingNotifications: [notice("late", 20, 1, "后"), notice("early", 10, 1, "先")] });
    expect(v.ids).toEqual(["early", "late"]);
    expect(v.prompt!.indexOf("- subagent: 先")).toBeLessThan(v.prompt!.indexOf("- subagent: 后"));
  });
});

describe("纯路径:maybeWakeIdleSession(假 tm/假 journal/真 registry)", () => {
  type BgEntry = { outputFile: string; status: string; sessionId: string; title?: string; lastEventAt?: number; spawnedAt?: number };
  function registry(): Map<string, BgEntry> {
    return (globalThis as unknown as { __bgAgents: Map<string, BgEntry> }).__bgAgents;
  }
  function fakeJournal(turnEndAt: number) {
    return {
      readSession: () => [{ kind: "turn.end", sessionId: "s1", time: turnEndAt, payload: { turn: 3 } }],
      append: () => {},
    } as unknown as Parameters<typeof maybeWakeIdleSession>[0];
  }
  function fakeTm(tasks: { sessionId: string; state: string }[]) {
    const submit = vi.fn(() => ({ id: "wake-task" }));
    return { submit, list: () => tasks, _submit: submit };
  }

  it("空闲父会话 + 终态条目 → 起一次 system model-only 任务,prompt 含标题", () => {
    const session = "m30-idle";
    registry().set("agent-m30-1", { outputFile: "", status: "completed", sessionId: session, title: "后台分析完成", lastEventAt: NOW - 1_000 });
    const tm = fakeTm([]);
    const r = maybeWakeIdleSession(fakeJournal(NOW - 60_000), session, tm as never, { now: NOW });
    expect(r.code).toBe("WAKE");
    expect(r.submitted).toBe(true);
    expect(tm.submit).toHaveBeenCalledTimes(1);
    const [kind, sid, prompt, extra] = tm.submit.mock.calls[0] as unknown as [string, string, string, { title: string; idempotencyKey: string }];
    expect(kind).toBe("system");
    expect(sid).toBe(session);
    expect(prompt).toContain("[后台单元完成]");
    expect(prompt).toContain("后台分析完成");
    expect(extra.title).toBe("[唤醒] 后台单元完成");
    expect(extra.idempotencyKey).toBe(`idle-wake:${session}:agent-m30-1`);
  });

  it("同批重复回调 → 不再 submit(ack + 幂等键)", () => {
    const session = "m30-dedupe";
    registry().set("agent-m30-2", { outputFile: "", status: "failed", sessionId: session, title: "失败单元", lastEventAt: NOW - 1_000 });
    const tm = fakeTm([]);
    const journal = fakeJournal(NOW - 60_000);
    expect(maybeWakeIdleSession(journal, session, tm as never, { now: NOW }).submitted).toBe(true);
    const second = maybeWakeIdleSession(journal, session, tm as never, { now: NOW });
    expect(second.code).toBe("NO_PENDING");
    expect(second.submitted).toBe(false);
    expect(tm.submit).toHaveBeenCalledTimes(1);
  });

  it("父会话有 running 任务 → BUSY 不 submit", () => {
    const session = "m30-busy";
    registry().set("agent-m30-3", { outputFile: "", status: "completed", sessionId: session, title: "X", lastEventAt: NOW - 1_000 });
    const tm = fakeTm([{ sessionId: session, state: "running" }]);
    const r = maybeWakeIdleSession(fakeJournal(NOW - 60_000), session, tm as never, { now: NOW });
    expect(r.code).toBe("BUSY");
    expect(tm.submit).not.toHaveBeenCalled();
  });

  it("上一 turn 刚结束(保护窗内)→ BUSY 不 submit", () => {
    const session = "m30-just-ended";
    registry().set("agent-m30-4", { outputFile: "", status: "completed", sessionId: session, title: "X", lastEventAt: NOW - 1_000 });
    const tm = fakeTm([]);
    const r = maybeWakeIdleSession(fakeJournal(NOW - 100), session, tm as never, { now: NOW });
    expect(r.code).toBe("BUSY");
    expect(tm.submit).not.toHaveBeenCalled();
  });

  it("journal 读失败 → 保守 BUSY,不抛", () => {
    const session = "m30-journal-err";
    registry().set("agent-m30-5", { outputFile: "", status: "completed", sessionId: session, title: "X", lastEventAt: NOW - 1_000 });
    const tm = fakeTm([]);
    const journal = { readSession: () => { throw new Error("boom"); }, append: () => {} } as unknown as Parameters<typeof maybeWakeIdleSession>[0];
    const r = maybeWakeIdleSession(journal, session, tm as never, { now: NOW });
    expect(r.code).toBe("BUSY");
    expect(tm.submit).not.toHaveBeenCalled();
  });
});
