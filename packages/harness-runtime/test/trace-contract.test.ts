import { describe, it, expect } from "vitest";
import {
  TRACE_CONTRACT_VERSION,
  extractTraceBatch,
  traceBatchKey,
  type DecisionTraceEvent,
  type PhaseTraceEvent,
  type StepTraceEvent,
  type TokenTraceEvent,
  type ToolTraceEvent,
} from "../src/agent/trace-contract";

const SID = "s1";

/** 原始 journal 事件(只保留契约消费的字段)。 */
function ev(seq: number, kind: string, payload: Record<string, unknown> = {}, sessionId = SID) {
  return { seq, time: 1000 + seq, kind, sessionId, payload };
}

describe("trace-contract:来源 kind → 轨迹事件映射", () => {
  it("task.trajectory→step(优先)、tool.call/result 配对→tool、llm.trace→token、telemetry.phase→phase、permission.gate/plan.gate→decision", () => {
    const raw = [
      ev(1, "task.trajectory", { steps: 3, calls: 5, tokensSpent: 900, phase: "implement", turn: 1, step: 2 }),
      ev(2, "step.start", { turn: 1, step: 1 }), // 已有 trajectory → 二选一未选用,进 unmapped
      ev(3, "tool.call", { toolCallId: "c1", name: "read_file", arguments: '{"path":"a.ts"}', turn: 1, step: 1 }),
      ev(4, "tool.result", { toolCallId: "c1", name: "read_file", content: "hello", durationMs: 12, turn: 1, step: 1 }),
      ev(5, "llm.trace", { model: "m1", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedTokens: 30 } }),
      ev(6, "custom", { what: "telemetry.phase", spans: [{ name: "llm", ms: 100, status: "ok" }], quality: "good" }),
      ev(7, "permission.gate", { tool: "terminal", effect: "denied" }),
      ev(8, "custom", { type: "plan.gate", effect: "board-present", tool: "board_upsert" }),
      ev(9, "message.agent", { text: "hi" }),
    ];

    const batch = extractTraceBatch(raw, { ruleVersion: "r1" });

    expect(batch.version).toBe(TRACE_CONTRACT_VERSION);
    expect(batch.ruleVersion).toBe("r1");
    expect(batch.events.map((e) => e.kind)).toEqual(["step", "tool", "token", "phase", "decision", "decision"]);

    const step = batch.events[0] as StepTraceEvent;
    expect(step).toMatchObject({ steps: 3, calls: 5, tokensSpent: 900, phase: "implement" });
    expect(step.dimension).toMatchObject({ sessionId: SID, turn: 1, step: 2 });

    const tool = batch.events[1] as ToolTraceEvent;
    expect(tool).toMatchObject({ name: "read_file", ok: true, durationMs: 12, resultChars: 5 });
    expect(tool.argsChars).toBe('{"path":"a.ts"}'.length); // 只落长度,不落参数原文

    const token = batch.events[2] as TokenTraceEvent;
    expect(token).toMatchObject({ input: 100, output: 20, total: 120, cached: 30 });
    expect(token.dimension.model).toBe("m1");

    const phase = batch.events[3] as PhaseTraceEvent;
    expect(phase.spans).toEqual([{ name: "llm", ms: 100, status: "ok" }]);
    expect(phase.quality).toBe("good");

    expect(batch.events[4] as DecisionTraceEvent).toMatchObject({ what: "permission.gate", effect: "denied", tool: "terminal" });
    expect(batch.events[5] as DecisionTraceEvent).toMatchObject({ what: "plan.gate", effect: "board-present", tool: "board_upsert" });

    // 覆盖率:inputEvents 9 / 映射 7(step.start 与 message.agent 未映射)/ 未映射按 kind 计数
    expect(batch.coverage).toMatchObject({ inputEvents: 9, duplicateSeqs: 0, mappedEvents: 7 });
    expect(batch.coverage.unmappedByKind).toEqual({ "step.start": 1, "message.agent": 1 });
    expect(batch.coverage.coverageRate).toBeCloseTo(7 / 9, 6);
    expect(batch.batchKey).toBe(
      traceBatchKey({ sessionId: SID, seqStart: 1, seqEnd: 9, ruleVersion: "r1", contractVersion: TRACE_CONTRACT_VERSION }),
    );
  });

  it("无 task.trajectory 时 step.start 担纲(计数缺省 0,不推断);step.end 未映射", () => {
    const batch = extractTraceBatch(
      [ev(1, "step.start", { turn: 1, step: 1 }), ev(2, "step.end", { turn: 1, step: 1, reason: "tools-done" })],
      { ruleVersion: "r1" },
    );
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({ kind: "step", steps: 1, calls: 0, tokensSpent: 0 });
    expect(batch.coverage.unmappedByKind).toEqual({ "step.end": 1 });
  });

  it("llm.trace 缺 usage 不产 token 事件(不推断)", () => {
    const batch = extractTraceBatch([ev(1, "llm.trace", { model: "m1" })], { ruleVersion: "r1" });
    expect(batch.events).toHaveLength(0);
    expect(batch.coverage.unmappedByKind).toEqual({ "llm.trace": 1 });
    expect(batch.coverage.coverageRate).toBe(0);
  });

  it("board_upsert 工具调用额外产 decision;只有 call 没有 result 的记 ok=false", () => {
    const batch = extractTraceBatch(
      [ev(1, "tool.call", { toolCallId: "b1", name: "board_upsert", arguments: "{}" })],
      { ruleVersion: "r1" },
    );
    expect(batch.events.map((e) => e.kind)).toEqual(["decision", "tool"]);
    expect(batch.events[0]).toMatchObject({ what: "board_upsert", tool: "board_upsert" });
    expect(batch.events[1]).toMatchObject({ name: "board_upsert", ok: false, resultChars: 0 });
  });
});

describe("trace-contract:去重与摊平", () => {
  it("同 (sessionId, seq) 重复行计数后丢弃(双写残留)", () => {
    const row = ev(1, "task.trajectory", { steps: 1 });
    const batch = extractTraceBatch([row, { ...row }, row], { ruleVersion: "r1" });
    expect(batch.coverage.inputEvents).toBe(3);
    expect(batch.coverage.duplicateSeqs).toBe(2);
    expect(batch.coverage.mappedEvents).toBe(1);
    expect(batch.events).toHaveLength(1);
    expect(batch.coverage.coverageRate).toBe(1); // 1 / (3-2)
  });

  it("不同会话同 seq 不互相去重", () => {
    const batch = extractTraceBatch(
      [ev(1, "step.start", {}, "a"), ev(1, "step.start", {}, "b")],
      { ruleVersion: "r1" },
    );
    expect(batch.coverage.duplicateSeqs).toBe(0);
    expect(batch.events).toHaveLength(2);
  });

  it("subagent.event 摊平:继承外层 sessionId/seq,带 agentId,内层字段可用", () => {
    const raw = [
      {
        seq: 10,
        time: 1010,
        sessionId: "main",
        kind: "subagent.event",
        payload: { agentId: "sa1", taskId: "t1", parentTaskId: "p1", kind: "tool.call", toolCallId: "k1", name: "grep", arguments: "abc" },
      },
      {
        seq: 11,
        time: 1011,
        sessionId: "main",
        kind: "subagent.event",
        payload: { agentId: "sa1", taskId: "t1", parentTaskId: "p1", kind: "tool.result", toolCallId: "k1", name: "grep", content: "xy" },
      },
    ];
    const batch = extractTraceBatch(raw, { ruleVersion: "r1" });
    expect(batch.events).toHaveLength(1);
    const tool = batch.events[0] as ToolTraceEvent;
    expect(tool).toMatchObject({ kind: "tool", name: "grep", ok: true, argsChars: 3, resultChars: 2, agentId: "sa1", seq: 11 });
    expect(tool.dimension).toMatchObject({ sessionId: "main", taskId: "t1" });
  });

  it("未知 kind 只计数,不抛", () => {
    const batch = extractTraceBatch(
      [ev(1, "brand.new.kind", { a: 1 }), ev(2, "another.kind"), null, 42],
      { ruleVersion: "r1" },
    );
    expect(batch.events).toHaveLength(0);
    expect(batch.coverage.unmappedByKind).toEqual({ "brand.new.kind": 1, "another.kind": 1, "<invalid>": 2 });
    expect(batch.coverage.coverageRate).toBe(0);
    expect(Number.isNaN(batch.coverage.coverageRate)).toBe(false);
  });
});

describe("trace-contract:脱敏与丢弃口径", () => {
  it("主脱敏(redactText/scrubSecrets)命中的字段保留为占位符,不算丢弃", () => {
    const batch = extractTraceBatch(
      [ev(1, "permission.gate", { tool: "terminal", effect: "token=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123" })],
      { ruleVersion: "r1" },
    );
    const decision = batch.events[0] as DecisionTraceEvent;
    expect(decision.effect).toBe("token=<redacted:sk>"); // sk 规则先命中(密文段被替换,键名前缀保留)
    expect(batch.dropped.count).toBe(0);
  });

  it("窄判据复检命中 → 整字段丢弃并按 reason/field 计数(不用 hasSensitiveText)", () => {
    const batch = extractTraceBatch(
      [ev(1, "permission.gate", { tool: "terminal", effect: "Bearer abcdefghij" })], // 12 位:主脱敏规则要求 16+
      { ruleVersion: "r1" },
    );
    const decision = batch.events[0] as DecisionTraceEvent;
    expect(decision.effect).toBeUndefined(); // 字段被丢弃
    expect(decision).toMatchObject({ what: "permission.gate", tool: "terminal" });
    expect(batch.dropped).toEqual({
      count: 1,
      byReason: { "redaction-failed": 1 },
      byField: { effect: 1 },
    });
  });

  it("长 base64 文本不被误杀(hasSensitiveText 会误杀的样本)", () => {
    const base64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5QUJDREVGR0g=";
    const batch = extractTraceBatch([ev(1, "permission.gate", { effect: base64, tool: "terminal" })], {
      ruleVersion: "r1",
    });
    expect((batch.events[0] as DecisionTraceEvent).effect).toBe(base64);
    expect(batch.dropped.count).toBe(0);
  });
});

describe("trace-contract:批次键与覆盖口径", () => {
  const keyOf = (ruleVersion: string, contractVersion: number) =>
    traceBatchKey({ sessionId: "s1", seqStart: 1, seqEnd: 9, ruleVersion, contractVersion });

  it("同输入稳定(可 JSON 复现);ruleVersion 或 contractVersion 变 → 键变", () => {
    expect(keyOf("r1", 1)).toBe(keyOf("r1", 1));
    expect(keyOf("r1", 1)).toMatch(/^[0-9a-f]{64}$/);
    expect(keyOf("r2", 1)).not.toBe(keyOf("r1", 1));
    expect(keyOf("r1", 2)).not.toBe(keyOf("r1", 1));
  });

  it("extractTraceBatch 的 batchKey 随 ruleVersion 变化", () => {
    const raw = [ev(1, "task.trajectory", { steps: 1 })];
    const a = extractTraceBatch(raw, { ruleVersion: "r1" });
    const b = extractTraceBatch(raw, { ruleVersion: "r2" });
    expect(a.batchKey).not.toBe(b.batchKey);
    expect(a.events).toEqual(b.events); // 事件面与键解耦
  });

  it("空输入:coverageRate=0 而非 NaN", () => {
    const batch = extractTraceBatch([], { ruleVersion: "r1" });
    expect(batch.events).toHaveLength(0);
    expect(batch.coverage).toMatchObject({ inputEvents: 0, duplicateSeqs: 0, mappedEvents: 0, coverageRate: 0 });
    expect(Number.isNaN(batch.coverage.coverageRate)).toBe(false);
  });

  it("seq 区间缺省取输入 min/max;显式覆盖生效", () => {
    const raw = [ev(5, "step.start"), ev(9, "step.start")];
    const auto = extractTraceBatch(raw, { ruleVersion: "r1" });
    expect(auto.batchKey).toBe(traceBatchKey({ sessionId: SID, seqStart: 5, seqEnd: 9, ruleVersion: "r1", contractVersion: 1 }));
    const forced = extractTraceBatch(raw, { ruleVersion: "r1", seqStart: 1, seqEnd: 100 });
    expect(forced.batchKey).toBe(traceBatchKey({ sessionId: SID, seqStart: 1, seqEnd: 100, ruleVersion: "r1", contractVersion: 1 }));
  });
});
