import { describe, it, expect } from "vitest";
import {
  APPROVAL_AUDIT_CODES,
  NEVER_ACTION,
  RULE_NEVER_BY,
  auditApprovals,
  decideNever,
  type ApprovalAuditEvent,
  type ApprovalPair,
} from "../src/agent/approval-audit";

const SID = "s1";

/** 造一条 journal 行(真实 journal 行是超集:seq/time/kind/sessionId/payload)。 */
function gate(seq: number, payload: Record<string, unknown>): ApprovalAuditEvent {
  return { seq, time: 1_000 + seq, kind: "permission.gate", sessionId: SID, payload };
}

function asked(seq: number, requestId: unknown, extra: Record<string, unknown> = {}): ApprovalAuditEvent {
  const payload: Record<string, unknown> = { tool: "subagent", effect: "asked", by: "rm -rf /tmp/x", risk: "high", ...extra };
  if (requestId !== undefined) payload.requestId = requestId;
  return gate(seq, payload);
}

function decided(seq: number, requestId: unknown, effect: string, by = "panel-denied", extra: Record<string, unknown> = {}): ApprovalAuditEvent {
  const payload: Record<string, unknown> = { tool: "subagent", effect, by, ...extra };
  if (requestId !== undefined) payload.requestId = requestId;
  return gate(seq, payload);
}

const codes = (r: ReturnType<typeof auditApprovals>) => r.issues.map((i) => i.code);

describe("auditApprovals:成对判定", () => {
  it("A 一对 asked+allowed → ok,1 对,pair 字段齐全", () => {
    const r = auditApprovals([asked(1, "r1"), decided(2, "r1", "allowed", "panel-approved")], {});
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.pairs).toHaveLength(1);
    const p = r.pairs[0] as ApprovalPair;
    expect(p).toMatchObject({ requestId: "r1", askedSeq: 1, decidedSeq: 2, decision: "allowed", by: "panel-approved" });
  });

  it("denied 也成对(by=auto-fail-closed 语义保留)", () => {
    const r = auditApprovals([asked(1, "r1"), decided(2, "r1", "denied", "auto-fail-closed")]);
    expect(r.ok).toBe(true);
    expect(r.pairs[0]!.by).toBe("auto-fail-closed");
  });

  it("rejected 视为 decided(不同名 effect 同语义)", () => {
    const r = auditApprovals([asked(1, "r1"), decided(2, "r1", "rejected", "rule-denied")]);
    expect(r.ok).toBe(true);
    expect(r.pairs[0]!.decision).toBe("rejected");
  });

  it("多请求交错 → 按 asked 顺序出两对", () => {
    const r = auditApprovals([
      asked(1, "r1"),
      asked(2, "r2"),
      decided(3, "r2", "denied"),
      decided(4, "r1", "allowed"),
    ]);
    expect(r.pairs.map((p) => p.requestId)).toEqual(["r1", "r2"]);
    expect(r.pairs.map((p) => p.decidedSeq)).toEqual([4, 3]);
    expect(r.counts).toMatchObject({ events: 4, asked: 2, decided: 2, pairs: 2, issues: 0 });
  });

  it("counts 把 object-changed 记入 ignored,不算 decided", () => {
    const r = auditApprovals([
      asked(1, "r1"),
      gate(2, { tool: "subagent", effect: "object-changed", requestId: "r1", by: "approval-object" }),
      decided(3, "r1", "denied", "object-changed"),
    ]);
    expect(r.ok).toBe(true);
    expect(r.counts).toMatchObject({ events: 3, asked: 1, decided: 1, ignored: 1, pairs: 1 });
    expect(r.pairs[0]!.by).toBe("object-changed");
  });
});

describe("auditApprovals:悬空 / 孤儿 / 重复", () => {
  it("B asked 无 decided → DANGLING_ASKED,ok=false", () => {
    const r = auditApprovals([asked(5, "r1")]);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual([APPROVAL_AUDIT_CODES.DANGLING_ASKED]);
    expect(r.issues[0]).toMatchObject({ requestId: "r1", seq: 5 });
    expect(r.pairs).toHaveLength(0);
  });

  it("allowPendingRequestIds 豁免在跑任务的 asked", () => {
    const r = auditApprovals([asked(5, "r1"), asked(6, "r2")], { allowPendingRequestIds: ["r1", "r2"] });
    expect(r).toMatchObject({ ok: true, pairs: [], issues: [] });
    expect(r.counts.asked).toBe(2);
  });

  it("豁免只对点名的 requestId 生效(其余仍悬空)", () => {
    const r = auditApprovals([asked(1, "r1"), asked(2, "r2")], { allowPendingRequestIds: ["r1"] });
    expect(codes(r)).toEqual([APPROVAL_AUDIT_CODES.DANGLING_ASKED]);
    expect(r.issues[0]!.requestId).toBe("r2");
  });

  it("有 decided 的 requestId 不受豁免影响,仍出 pair", () => {
    const r = auditApprovals([asked(1, "r1"), decided(2, "r1", "allowed")], { allowPendingRequestIds: ["r1"] });
    expect(r.ok).toBe(true);
    expect(r.pairs).toHaveLength(1);
  });

  it("C decided 无 asked → ORPHAN_DECIDED", () => {
    const r = auditApprovals([decided(3, "rx", "allowed")]);
    expect(codes(r)).toEqual([APPROVAL_AUDIT_CODES.ORPHAN_DECIDED]);
    expect(r.issues[0]).toMatchObject({ requestId: "rx", seq: 3 });
    expect(r.counts).toMatchObject({ asked: 0, decided: 1, pairs: 0 });
  });

  it("D 重复 decided → 一条 DUPLICATE_DECIDED,保留首条决定", () => {
    const r = auditApprovals([asked(1, "r1"), decided(2, "r1", "denied"), decided(3, "r1", "allowed")]);
    expect(codes(r)).toEqual([APPROVAL_AUDIT_CODES.DUPLICATE_DECIDED]);
    expect(r.issues[0]).toMatchObject({ requestId: "r1", seq: 3 });
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]!.decision).toBe("denied");
    expect(r.pairs[0]!.decidedSeq).toBe(2);
    expect(r.counts.decided).toBe(2);
  });

  it("三条重复 decided → 两条 DUPLICATE_DECIDED", () => {
    const r = auditApprovals([
      asked(1, "r1"),
      decided(2, "r1", "denied"),
      decided(3, "r1", "allowed"),
      decided(4, "r1", "denied"),
    ]);
    expect(codes(r)).toEqual([APPROVAL_AUDIT_CODES.DUPLICATE_DECIDED, APPROVAL_AUDIT_CODES.DUPLICATE_DECIDED]);
    expect(r.pairs).toHaveLength(1);
  });

  it("只 object-changed 没有 denied → asked 仍悬空", () => {
    const r = auditApprovals([asked(1, "r1"), gate(2, { effect: "object-changed", requestId: "r1" })]);
    expect(codes(r)).toEqual([APPROVAL_AUDIT_CODES.DANGLING_ASKED]);
  });
});

describe("auditApprovals:绑定完整性", () => {
  it("asked 缺 requestId → MISSING_BINDING", () => {
    const r = auditApprovals([asked(1, undefined)]);
    expect(codes(r)).toEqual([APPROVAL_AUDIT_CODES.MISSING_BINDING]);
    expect(r.issues[0]!.detail).toContain("asked");
    expect(r.counts.asked).toBe(1);
  });

  it("asked requestId 为空串/空白 → MISSING_BINDING(不建档)", () => {
    const r = auditApprovals([asked(1, "   "), decided(2, "   ", "denied")]);
    expect(codes(r)).toEqual([APPROVAL_AUDIT_CODES.MISSING_BINDING, APPROVAL_AUDIT_CODES.MISSING_BINDING]);
    expect(r.pairs).toHaveLength(0);
  });

  it("decided 缺 requestId → MISSING_BINDING(而非孤儿)", () => {
    const r = auditApprovals([asked(1, "r1"), decided(2, undefined, "denied")]);
    expect(codes(r)).toEqual([APPROVAL_AUDIT_CODES.MISSING_BINDING, APPROVAL_AUDIT_CODES.DANGLING_ASKED]);
    expect(r.issues[0]!.detail).toContain("decided");
  });

  it("turn/toolCallId 缺失只在 pair.missingBindings 记,不影响 ok", () => {
    const r = auditApprovals([asked(1, "r1"), decided(2, "r1", "allowed")]);
    expect(r.ok).toBe(true);
    expect(r.pairs[0]!.missingBindings).toEqual(["turn", "toolCallId"]);
    expect(r.issues).toEqual([]);
  });

  it("turn/toolCallId 在事件上时透传到 pair", () => {
    const r = auditApprovals([
      asked(1, "r1", { turn: 7 }),
      decided(2, "r1", "allowed", "panel-approved", { toolCallId: "call-9" }),
    ]);
    expect(r.pairs[0]).toMatchObject({ turn: 7, toolCallId: "call-9" });
    expect(r.pairs[0]!.missingBindings).toBeUndefined();
  });

  it("objectHash 两侧任可得即透传(decided 优先)", () => {
    const r = auditApprovals([
      asked(1, "r1", { objectHash: "h-ask" }),
      decided(2, "r1", "allowed", "panel-approved", { objectHash: "h-dec" }),
    ]);
    expect(r.pairs[0]!.objectHash).toBe("h-dec");
    const r2 = auditApprovals([asked(1, "r1", { objectHash: "h-ask" }), decided(2, "r1", "allowed")]);
    expect(r2.pairs[0]!.objectHash).toBe("h-ask");
  });

  it("同 requestId 重复 asked → INVALID", () => {
    const r = auditApprovals([asked(1, "r1"), asked(2, "r1"), decided(3, "r1", "allowed")]);
    expect(codes(r)).toEqual([APPROVAL_AUDIT_CODES.INVALID]);
    expect(r.pairs[0]!.askedSeq).toBe(1);
  });
});

describe("auditApprovals:非法输入与容错(negative)", () => {
  it("非数组输入 → INVALID,不 throw", () => {
    expect(() => auditApprovals(undefined)).not.toThrow();
    expect(codes(auditApprovals(undefined))).toEqual([APPROVAL_AUDIT_CODES.INVALID]);
    expect(codes(auditApprovals("nope"))).toEqual([APPROVAL_AUDIT_CODES.INVALID]);
  });

  it("payload 非对象 / effect 缺失 / 未知 effect → INVALID", () => {
    const r = auditApprovals([
      { seq: 1, kind: "permission.gate", payload: "x" },
      { seq: 2, kind: "permission.gate", payload: { tool: "subagent" } },
      gate(3, { effect: "apologized" }),
    ]);
    expect(codes(r)).toEqual([APPROVAL_AUDIT_CODES.INVALID, APPROVAL_AUDIT_CODES.INVALID, APPROVAL_AUDIT_CODES.INVALID]);
    expect(r.counts).toMatchObject({ events: 3, asked: 0, decided: 0, ignored: 3 });
  });

  it("非 permission.gate 事件静默跳过(可整段 readAll 丢进来)", () => {
    const r = auditApprovals([
      { seq: 1, kind: "message.user", payload: { text: "hi" } },
      asked(2, "r1"),
      { seq: 3, kind: "task.done", payload: { taskId: "t1" } },
      decided(4, "r1", "denied"),
    ]);
    expect(r.ok).toBe(true);
    expect(r.counts).toMatchObject({ events: 2, asked: 1, decided: 1 });
  });

  it("空事件流 → ok(无审批=无需对账)", () => {
    const r = auditApprovals([]);
    expect(r).toMatchObject({ ok: true, pairs: [], issues: [] });
    expect(r.counts.events).toBe(0);
  });

  it("缺 seq 的合成事件退化为下标,不 throw", () => {
    const r = auditApprovals([
      { kind: "permission.gate", payload: { effect: "asked", requestId: "r1" } },
      { kind: "permission.gate", payload: { effect: "allowed", requestId: "r1" } },
    ]);
    expect(r.ok).toBe(true);
    expect(r.pairs[0]).toMatchObject({ askedSeq: 0, decidedSeq: 1 });
  });
});

describe("auditApprovals:不可变与确定性", () => {
  it("返回结果深 freeze,不可被调用方改写", () => {
    const r = auditApprovals([asked(1, "r1"), decided(2, "r1", "allowed")]);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.pairs)).toBe(true);
    expect(Object.isFrozen(r.pairs[0])).toBe(true);
    expect(Object.isFrozen(r.issues)).toBe(true);
    expect(Object.isFrozen(r.counts)).toBe(true);
  });

  it("不修改输入事件(冻结输入仍可审计)", () => {
    const a = Object.freeze(asked(1, "r1")) as ApprovalAuditEvent;
    const b = Object.freeze(decided(2, "r1", "allowed")) as ApprovalAuditEvent;
    const events = Object.freeze([a, b]);
    expect(() => auditApprovals(events)).not.toThrow();
    expect(a).toEqual(asked(1, "r1"));
    expect(b).toEqual(decided(2, "r1", "allowed"));
  });

  it("同输入两次调用结果 deepEqual(确定性)", () => {
    const events = [asked(1, "r1"), asked(2, "r2"), decided(3, "r2", "denied"), gate(4, { effect: "object-changed", requestId: "r1" })];
    expect(auditApprovals(events)).toEqual(auditApprovals(events));
  });
});

describe("decideNever:永久拒绝短路", () => {
  it("E 命中 → {decision:reject, by:rule-never}", () => {
    const out = decideNever("subagent", "rm -rf /tmp/x", [{ permission: "subagent", pattern: "*", action: "never" }]);
    expect(out).toEqual({ decision: "reject", by: RULE_NEVER_BY });
  });

  it("未命中(无规则/其它 action)→ null", () => {
    expect(decideNever("subagent", "rm -rf /tmp/x", [])).toBeNull();
    expect(decideNever("subagent", "rm -rf /tmp/x", [{ permission: "subagent", pattern: "*", action: "allow" }])).toBeNull();
    expect(decideNever("subagent", "rm -rf /tmp/x", [{ permission: "subagent", pattern: "*", action: "deny" }])).toBeNull();
  });

  it("permission 不匹配则跳过(相等或 \"*\" 才算命中)", () => {
    expect(decideNever("file.write", "rm -rf /", [{ permission: "subagent", pattern: "*", action: "never" }])).toBeNull();
    expect(decideNever("subagent", "rm -rf /", [{ permission: "*", pattern: "*", action: "never" }])).not.toBeNull();
  });

  it("pattern 按前缀语义命中(pattern 首个 * 之前是字面量)", () => {
    const rules = [{ permission: "subagent", pattern: "rm -rf *", action: "never" }];
    expect(decideNever("subagent", "rm -rf /tmp", rules)).not.toBeNull();
    expect(decideNever("subagent", "ls -la", rules)).toBeNull();
  });

  it("action 大小写/空白归一(\" NEVER \" 也命中)", () => {
    expect(decideNever("subagent", "x", [{ permission: "subagent", pattern: "*", action: " NEVER " }])).toEqual({
      decision: "reject",
      by: RULE_NEVER_BY,
    });
    expect(NEVER_ACTION).toBe("never");
  });

  it("非法输入不 throw(undefined/非数组/坏行)", () => {
    expect(() => decideNever("subagent", "x", undefined)).not.toThrow();
    expect(decideNever("subagent", "x", undefined)).toBeNull();
    expect(decideNever("subagent", "x", null)).toBeNull();
 // 坏行:数组里混入 null / 字符串,跳过继续
    const rules = [null, "broken", { permission: "subagent", pattern: "*", action: "never" }] as unknown as Parameters<typeof decideNever>[2];
    expect(decideNever("subagent", "x", rules)).not.toBeNull();
  });

  it("返回对象不可变", () => {
    const out = decideNever("subagent", "x", [{ permission: "subagent", pattern: "*", action: "never" }]);
    expect(Object.isFrozen(out)).toBe(true);
  });
});

/**
 * 真实探针(任务要求 A–E):合成事件流跑同一套审计/短路入口,打印 pairs 与 issues。
 * 断言保证输出不是空跑,打印供人看实际结构。
 */
describe("探针 A-E(合成事件流,打印 pairs 与 issues)", () => {
  it("A 一对 / B 悬空 / C 孤儿 / D 重复 / E never 短路", () => {
    const A = auditApprovals([asked(1, "r1"), decided(2, "r1", "allowed", "panel-approved")]);
    const B = auditApprovals([asked(3, "r2")]);
    const C = auditApprovals([decided(4, "r3", "denied", "auto-fail-closed")]);
    const D = auditApprovals([asked(5, "r4"), decided(6, "r4", "denied"), decided(7, "r4", "allowed")]);
    const EHit = decideNever("subagent", "rm -rf /tmp/x", [{ permission: "subagent", pattern: "*", action: "never" }]);
    const EMiss = decideNever("subagent", "ls -la", [{ permission: "subagent", pattern: "rm -rf *", action: "never" }]);

    const dump = { A, B, C, D, E: { hit: EHit, miss: EMiss } };
    console.log("[M73 探针]", JSON.stringify(dump, null, 2));

    expect(A).toMatchObject({ ok: true, counts: { pairs: 1, issues: 0 } });
    expect(B.issues.map((i) => i.code)).toEqual([APPROVAL_AUDIT_CODES.DANGLING_ASKED]);
    expect(C.issues.map((i) => i.code)).toEqual([APPROVAL_AUDIT_CODES.ORPHAN_DECIDED]);
    expect(D.issues.map((i) => i.code)).toEqual([APPROVAL_AUDIT_CODES.DUPLICATE_DECIDED]);
    expect(EHit).toEqual({ decision: "reject", by: RULE_NEVER_BY });
    expect(EMiss).toBeNull();
  });
});
