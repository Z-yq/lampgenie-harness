/**
 *  消息步进边界纯逻辑测试:码表 / 未闭合 tool batch / 未闭合 step / 首条输入 /
 * turn 未开始 / 准入冻结 / 边界码 / 确定性 / 不可变 / 多会话隔离。
 * gateway 侧源码接线断言见 apps/gateway/test/turn-boundary-wiring.test.ts。
 */
import { describe, it, expect } from "vitest";
import {
  BOUNDARY_CODES,
  openToolCalls,
  isToolBatchOpen,
  freezeAdmission,
  readFrozenAdmission,
  injectionVerdict,
  nextTurnAdmission,
  type FrozenAdmissionEvent,
} from "../src/session/turn-boundary.ts";

const SID = "sess-1";
const AT = 1_700_000_000_000;

/** 构造 journal 形状的事件(seq 显式给,保证测试确定性)。 */
const ev = (seq: number, kind: string, payload: Record<string, unknown> = {}, sessionId = SID) => ({
  seq,
  kind,
  sessionId,
  time: AT + seq,
  payload,
});

const turnStart = (seq: number, turn = 1) => ev(seq, "turn.start", { turn });
const stepStart = (seq: number, turn = 1, step = 1) => ev(seq, "step.start", { turn, step });
const stepEnd = (seq: number, turn = 1, step = 1) => ev(seq, "step.end", { turn, step, reason: "tools-done" });
const call = (seq: number, id = "call_a", sessionId = SID) => ev(seq, "tool.call", { toolCallId: id, name: "read_file", arguments: "{}" }, sessionId);
const result = (seq: number, id = "call_a", sessionId = SID) => ev(seq, "tool.result", { toolCallId: id, name: "read_file", content: "ok", durationMs: 1 }, sessionId);
const frozen = (seq: number, turn: number, cutoffSeq: number, sessionId = SID) => ({
  seq,
  kind: "custom",
  sessionId,
  time: AT + seq,
  payload: { type: "turn.admission.frozen", sessionId, turn, cutoffSeq, at: AT + seq },
});

describe("BOUNDARY_CODES(稳定码表)", () => {
  it("逐字包含五个值且顺序固定", () => {
    expect(BOUNDARY_CODES).toEqual(["OK", "TOOL_BATCH_OPEN", "TURN_NOT_STARTED", "ADMISSION_FROZEN", "INVALID"]);
  });

  it("码表本身不可变(调用方改不了共享常量)", () => {
    expect(Object.isFrozen(BOUNDARY_CODES)).toBe(true);
  });
});

describe("openToolCalls(未配对 tool.call)", () => {
  it("tool.call 无配对 tool.result → 返回该 callId", () => {
    const events = [turnStart(1), call(2, "c1")];
    expect(openToolCalls(events, SID)).toEqual(new Set(["c1"]));
  });

  it("同 id 的 tool.result 到达后闭合 → 空集", () => {
    const events = [turnStart(1), call(2, "c1"), result(3, "c1")];
    expect(openToolCalls(events, SID).size).toBe(0);
  });

  it("只看最后 turn:上一 turn 的未配对调用不算", () => {
    const events = [turnStart(1), call(2, "old"), turnStart(3, 2)];
    expect(openToolCalls(events, SID).size).toBe(0);
  });

  it("缺 toolCallId 的旧账本 → 合成键保守计入(不冒充真实 id)", () => {
    const events = [turnStart(1), ev(2, "tool.call", { name: "legacy" })];
    expect(openToolCalls(events, SID)).toEqual(new Set(["missing-call-2"]));
  });

  it("无 id 的 tool.result 不配对任何调用", () => {
    const events = [turnStart(1), call(2, "c1"), ev(3, "tool.result", { content: "x" })];
    expect(openToolCalls(events, SID)).toEqual(new Set(["c1"]));
  });

  it("多会话隔离:别会话的未配对调用不串入", () => {
    const events = [turnStart(1), call(2, "mine"), call(3, "other", "sess-2")];
    expect(openToolCalls(events, SID)).toEqual(new Set(["mine"]));
  });
});

describe("isToolBatchOpen(批内判定)", () => {
  it("未配对 tool.call → open", () => {
    expect(isToolBatchOpen([turnStart(1), call(2)], SID)).toBe(true);
  });

  it("call/result 全部配对 → 不 open", () => {
    expect(isToolBatchOpen([turnStart(1), call(2), result(3)], SID)).toBe(false);
  });

  it("有 step.start 无 step.end → open(保守)", () => {
    expect(isToolBatchOpen([turnStart(1), stepStart(2)], SID)).toBe(true);
  });

  it("step.start + step.end 配对 → 不 open", () => {
    expect(isToolBatchOpen([turnStart(1), stepStart(2), stepEnd(3)], SID)).toBe(false);
  });

  it("空账本 → 不 open", () => {
    expect(isToolBatchOpen([], SID)).toBe(false);
  });

  it("上一 turn 未闭合的 step 不阻塞当前 turn", () => {
    const events = [turnStart(1), stepStart(2, 1, 1), turnStart(3, 2), stepStart(4, 2, 1), stepEnd(5, 2, 1)];
    expect(isToolBatchOpen(events, SID)).toBe(false);
  });

  it("只有 turn.start/turn.end(无 step)→ 不 open", () => {
    const events = [turnStart(1), ev(2, "turn.end", { turn: 1, reason: "stop" })];
    expect(isToolBatchOpen(events, SID)).toBe(false);
  });
});

describe("freezeAdmission / readFrozenAdmission(准入冻结)", () => {
  it("产出稳定 custom 事件(形状逐字段固定)", () => {
    const e = freezeAdmission({ sessionId: SID, turn: 2, cutoffSeq: 7, at: AT });
    expect(e).toEqual({
      kind: "custom",
      sessionId: SID,
      time: AT,
      payload: { type: "turn.admission.frozen", sessionId: SID, turn: 2, cutoffSeq: 7, at: AT },
    });
  });

  it("非法入参不 throw(turn/cutoff/at 兜底 0)", () => {
    const e = freezeAdmission({} as never);
    expect(e.payload.turn).toBe(0);
    expect(e.payload.cutoffSeq).toBe(0);
    expect(e.payload.at).toBe(0);
    expect(e.sessionId).toBe("");
  });

  it("返回事件与 payload 深冻结(不可变)", () => {
    const e = freezeAdmission({ sessionId: SID, turn: 1, cutoffSeq: 3, at: AT });
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(e.payload)).toBe(true);
  });

  it("read 取最近一条冻结", () => {
    const events = [frozen(5, 1, 5), frozen(9, 2, 9), turnStart(10, 3)];
    expect(readFrozenAdmission(events, SID)).toEqual({ sessionId: SID, turn: 2, cutoffSeq: 9, at: AT + 9 });
  });

  it("无冻结 → null", () => {
    expect(readFrozenAdmission([turnStart(1)], SID)).toBeNull();
    expect(readFrozenAdmission([], SID)).toBeNull();
  });

  it("读出的快照同样冻结", () => {
    const admission = readFrozenAdmission([frozen(5, 1, 5)], SID);
    expect(admission).not.toBeNull();
    expect(Object.isFrozen(admission)).toBe(true);
  });

  it("多会话隔离:别会话的冻结不返回", () => {
    expect(readFrozenAdmission([frozen(5, 1, 5, "sess-2")], SID)).toBeNull();
  });
});

describe("injectionVerdict(注入判定)", () => {
  it("探针 A:空账本 + user → OK(首条输入)", () => {
    const v = injectionVerdict({ events: [], sessionId: SID, kind: "user" });
    expect(v).toMatchObject({ ok: true, code: "OK" });
  });

  it("探针 B:无 turn.start + steer → TURN_NOT_STARTED", () => {
    const v = injectionVerdict({ events: [], sessionId: SID, kind: "steer" });
    expect(v).toMatchObject({ ok: false, code: "TURN_NOT_STARTED" });
  });

  it("无 turn.start + retry → TURN_NOT_STARTED", () => {
    const v = injectionVerdict({ events: [], sessionId: SID, kind: "retry" });
    expect(v).toMatchObject({ ok: false, code: "TURN_NOT_STARTED" });
  });

  it("探针 C:未配对 tool.call → TOOL_BATCH_OPEN", () => {
    const events = [turnStart(1), call(2, "c1")];
    const v = injectionVerdict({ events, sessionId: SID, kind: "user" });
    expect(v).toMatchObject({ ok: false, code: "TOOL_BATCH_OPEN" });
  });

  it("未闭合 step.start → TOOL_BATCH_OPEN", () => {
    const events = [turnStart(1), stepStart(2)];
    const v = injectionVerdict({ events, sessionId: SID, kind: "steer" });
    expect(v).toMatchObject({ ok: false, code: "TOOL_BATCH_OPEN" });
  });

  it("探针 D:配对完成后 → OK", () => {
    const events = [turnStart(1), call(2, "c1"), result(3, "c1")];
    const v = injectionVerdict({ events, sessionId: SID, kind: "user" });
    expect(v).toMatchObject({ ok: true, code: "OK" });
  });

  it("探针 E:冻结后 admittedSeq 超界 → ADMISSION_FROZEN", () => {
    const events = [turnStart(1), frozen(2, 1, 5)];
    const v = injectionVerdict({ events, sessionId: SID, kind: "steer", admittedSeq: 6 });
    expect(v).toMatchObject({ ok: false, code: "ADMISSION_FROZEN" });
  });

  it("冻结后 admittedSeq 不超界(<=cutoff)→ OK", () => {
    const events = [turnStart(1), frozen(2, 1, 5)];
    const v = injectionVerdict({ events, sessionId: SID, kind: "steer", admittedSeq: 5 });
    expect(v).toMatchObject({ ok: true, code: "OK" });
  });

  it("user 输入同样受冻结(排队即可)", () => {
    const events = [turnStart(1), frozen(2, 1, 5)];
    const v = injectionVerdict({ events, sessionId: SID, kind: "user", admittedSeq: 9 });
    expect(v).toMatchObject({ ok: false, code: "ADMISSION_FROZEN" });
  });

  it("admittedSeq 缺省 → 不参与冻结比较(OK)", () => {
    const events = [turnStart(1), frozen(2, 1, 5)];
    const v = injectionVerdict({ events, sessionId: SID, kind: "user" });
    expect(v).toMatchObject({ ok: true, code: "OK" });
  });

  it("批内优先于冻结:TOOL_BATCH_OPEN 不被 ADMISSION_FROZEN 覆盖", () => {
    const events = [turnStart(1), frozen(2, 1, 5), call(3, "c1")];
    const v = injectionVerdict({ events, sessionId: SID, kind: "user", admittedSeq: 99 });
    expect(v.code).toBe("TOOL_BATCH_OPEN");
  });

  it("非法 sessionId → INVALID(不 throw)", () => {
    expect(() => injectionVerdict({ events: [], sessionId: "", kind: "user" })).not.toThrow();
    expect(injectionVerdict({ events: [], sessionId: "", kind: "user" })).toMatchObject({ ok: false, code: "INVALID" });
    expect(injectionVerdict({ events: [], sessionId: 42, kind: "user" })).toMatchObject({ code: "INVALID" });
  });

  it("非法 kind → INVALID", () => {
    const v = injectionVerdict({ events: [], sessionId: SID, kind: "weird" });
    expect(v).toMatchObject({ ok: false, code: "INVALID" });
  });

  it("events 非数组 → INVALID(不 throw)", () => {
    expect(() => injectionVerdict({ events: undefined, sessionId: SID, kind: "user" })).not.toThrow();
    expect(injectionVerdict({ events: undefined, sessionId: SID, kind: "user" })).toMatchObject({ code: "INVALID" });
    expect(injectionVerdict({ events: { seq: 1 }, sessionId: SID, kind: "user" })).toMatchObject({ code: "INVALID" });
  });

  it("所有判定码都落在 BOUNDARY_CODES 内", () => {
    const cases = [
      injectionVerdict({ events: [], sessionId: SID, kind: "user" }),
      injectionVerdict({ events: [], sessionId: SID, kind: "steer" }),
      injectionVerdict({ events: [turnStart(1), call(2)], sessionId: SID, kind: "user" }),
      injectionVerdict({ events: [turnStart(1), frozen(2, 1, 5)], sessionId: SID, kind: "user", admittedSeq: 9 }),
      injectionVerdict({ events: [], sessionId: "", kind: "user" }),
    ];
    for (const v of cases) expect(BOUNDARY_CODES).toContain(v.code);
  });
});

describe("nextTurnAdmission(下一 turn 冻结截止)", () => {
  it("返回该会话当前最大 seq", () => {
    expect(nextTurnAdmission([turnStart(5), call(7)], SID)).toBe(7);
  });

  it("空账本 → 0", () => {
    expect(nextTurnAdmission([], SID)).toBe(0);
  });

  it("多会话隔离:别会话更大的 seq 不计入", () => {
    expect(nextTurnAdmission([turnStart(5), call(99, "x", "sess-2")], SID)).toBe(5);
  });
});

describe("确定性与不可变", () => {
  it("同输入两次判定完全相同", () => {
    const events = [turnStart(1), call(2), result(3), frozen(4, 1, 2)];
    const a = injectionVerdict({ events, sessionId: SID, kind: "user", admittedSeq: 9 });
    const b = injectionVerdict({ events, sessionId: SID, kind: "user", admittedSeq: 9 });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("判定不修改入参数组(调用前后快照一致)", () => {
    const events = [turnStart(1), call(2, "c1"), frozen(3, 1, 2)];
    const before = JSON.stringify(events);
    injectionVerdict({ events, sessionId: SID, kind: "user", admittedSeq: 9 });
    isToolBatchOpen(events, SID);
    openToolCalls(events, SID);
    nextTurnAdmission(events, SID);
    expect(JSON.stringify(events)).toBe(before);
  });

  it("判定对象冻结且 reason 非空", () => {
    const v = injectionVerdict({ events: [], sessionId: SID, kind: "user" });
    expect(Object.isFrozen(v)).toBe(true);
    expect(v.reason.length).toBeGreaterThan(0);
  });

  it("freezeAdmission 对同一输入稳定(可安全重放)", () => {
    const a: FrozenAdmissionEvent = freezeAdmission({ sessionId: SID, turn: 1, cutoffSeq: 2, at: AT });
    const b: FrozenAdmissionEvent = freezeAdmission({ sessionId: SID, turn: 1, cutoffSeq: 2, at: AT });
    expect(a).toEqual(b);
  });
});
