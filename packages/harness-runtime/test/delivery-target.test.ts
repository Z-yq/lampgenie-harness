/**
 * 投递目标归属与能力协商：纯逻辑单测。
 * 跑法：cd packages/harness-runtime && NODE_OPTIONS=--conditions=development npx vitest run test/delivery-target.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  DEAD_TARGET_CAPACITY,
  DELIVERY_CODES,
  DeadTargetTable,
  LEGACY_OPS,
  attestDeliveryTarget,
  classifySendResult,
  negotiateDescriptor,
  sendFrame,
} from "../src/notify/delivery-target.ts";

describe("DELIVERY_CODES 封闭集合", () => {
  it("包含任务要求的 7 个码且不重复", () => {
    expect([...DELIVERY_CODES]).toEqual(["OK", "NOT_ATTESTED", "THREAD_NOT_ATTESTED", "DEAD_TARGET", "DECLINED", "LEGACY", "UNSUPPORTED_OP"]);
    expect(new Set(DELIVERY_CODES).size).toBe(DELIVERY_CODES.length);
  });
});

describe("attestDeliveryTarget：home/directory/session", () => {
  it("home 命中集合 → OK", () => {
    expect(attestDeliveryTarget({ kind: "home", id: "h1" }, { homeIds: new Set(["h1"]) })).toEqual({ ok: true, code: "OK" });
  });
  it("home 未命中 → NOT_ATTESTED", () => {
    expect(attestDeliveryTarget({ kind: "home", id: "h2" }, { homeIds: new Set(["h1"]) })).toEqual({ ok: false, code: "NOT_ATTESTED" });
  });
  it("home 无任何集合 → NOT_ATTESTED（fail-closed）", () => {
    expect(attestDeliveryTarget({ kind: "home", id: "h1" }, {})).toEqual({ ok: false, code: "NOT_ATTESTED" });
  });
  it("directory 用数组形态也可命中 → OK", () => {
    expect(attestDeliveryTarget({ kind: "directory", id: "d1" }, { directoryIds: ["d1", "d2"] })).toEqual({ ok: true, code: "OK" });
  });
  it("directory 未命中 → NOT_ATTESTED", () => {
    expect(attestDeliveryTarget({ kind: "directory", id: "dx" }, { directoryIds: ["d1"] })).toEqual({ ok: false, code: "NOT_ATTESTED" });
  });
  it("session 命中来源集合 → OK", () => {
    expect(attestDeliveryTarget({ kind: "session", id: "s1" }, { sessionOriginIds: new Set(["s1"]) })).toEqual({ ok: true, code: "OK" });
  });
  it("session 未命中 → NOT_ATTESTED", () => {
    expect(attestDeliveryTarget({ kind: "session", id: "s9" }, { sessionOriginIds: ["s1"] })).toEqual({ ok: false, code: "NOT_ATTESTED" });
  });
  it("home 与 directory 集合不互通（id 同形也不能跨类命中）", () => {
    expect(attestDeliveryTarget({ kind: "home", id: "x" }, { directoryIds: ["x"] })).toEqual({ ok: false, code: "NOT_ATTESTED" });
  });
});

describe("attestDeliveryTarget：thread 需父目标 + 单独 attestation", () => {
  const base = { sessionOriginIds: new Set(["s1"]) };
  it("父目标已证实且 threadId 有绑定该目标的 attestation → OK", () => {
    const atts = new Map([["th-1", { attestedId: "s1" }]]);
    expect(attestDeliveryTarget({ kind: "thread", id: "s1", threadId: "th-1" }, { ...base, threadAttestations: atts })).toEqual({ ok: true, code: "OK" });
  });
  it("父目标已证实但缺单独 attestation → THREAD_NOT_ATTESTED", () => {
    expect(attestDeliveryTarget({ kind: "thread", id: "s1", threadId: "th-1" }, { ...base })).toEqual({ ok: false, code: "THREAD_NOT_ATTESTED" });
  });
  it("缺 threadId → THREAD_NOT_ATTESTED", () => {
    const atts = new Map([["th-1", { attestedId: "s1" }]]);
    expect(attestDeliveryTarget({ kind: "thread", id: "s1" }, { ...base, threadAttestations: atts })).toEqual({ ok: false, code: "THREAD_NOT_ATTESTED" });
  });
  it("attestation 绑定的是别的目标 id → THREAD_NOT_ATTESTED（id 在父目标内才唯一）", () => {
    const atts = new Map([["th-1", { attestedId: "s2" }]]);
    expect(attestDeliveryTarget({ kind: "thread", id: "s1", threadId: "th-1" }, { ...base, threadAttestations: atts })).toEqual({ ok: false, code: "THREAD_NOT_ATTESTED" });
  });
  it("父目标未证实 → THREAD_NOT_ATTESTED（即使有 thread attestation）", () => {
    const atts = new Map([["th-1", { attestedId: "s1" }]]);
    expect(attestDeliveryTarget({ kind: "thread", id: "s1", threadId: "th-1" }, { sessionOriginIds: [], threadAttestations: atts })).toEqual({ ok: false, code: "THREAD_NOT_ATTESTED" });
  });
});

describe("attestDeliveryTarget：非法输入不 throw", () => {
  it("null / 空 id / 未知 kind → NOT_ATTESTED", () => {
    expect(attestDeliveryTarget(null)).toEqual({ ok: false, code: "NOT_ATTESTED" });
    expect(attestDeliveryTarget({ kind: "home", id: "" }, { homeIds: [""] })).toEqual({ ok: false, code: "NOT_ATTESTED" });
    expect(attestDeliveryTarget({ kind: "galaxy" as never, id: "g" })).toEqual({ ok: false, code: "NOT_ATTESTED" });
  });
  it("返回值冻结（不可变）", () => {
    const r = attestDeliveryTarget({ kind: "home", id: "h1" }, { homeIds: ["h1"] });
    expect(Object.isFrozen(r)).toBe(true);
  });
});

describe("DeadTargetTable：只有整聊死亡才标死", () => {
  it("reason 含 kicked → 标死成功且 isDead", () => {
    const t = new DeadTargetTable();
    expect(t.markDead("u1", { reason: "peer kicked by owner", at: 100 })).toBe(true);
    expect(t.isDead("u1")).toBe(true);
  });
  it("reason 含 whole-chat / deleted → 标死成功", () => {
    const t = new DeadTargetTable();
    expect(t.markDead("u1", { reason: "whole-chat gone", at: 1 })).toBe(true);
    expect(t.markDead("u2", { reason: "account deleted", at: 2 })).toBe(true);
    expect(t.isDead("u1")).toBe(true);
    expect(t.isDead("u2")).toBe(true);
  });
  it("reason 是暂时态（timeout）→ 返回 false 且不标死", () => {
    const t = new DeadTargetTable();
    expect(t.markDead("u1", { reason: "timeout", at: 1 })).toBe(false);
    expect(t.isDead("u1")).toBe(false);
    expect(t.size).toBe(0);
  });
  it("clear 后 isDead=false，且 clear 未知目标返回 false", () => {
    const t = new DeadTargetTable();
    t.markDead("u1", { reason: "kicked", at: 1 });
    expect(t.clear("u1")).toBe(true);
    expect(t.isDead("u1")).toBe(false);
    expect(t.clear("nobody")).toBe(false);
  });
  it("容量 500 + LRU：第 501 条淘汰最久未用条目", () => {
    const t = new DeadTargetTable();
    for (let i = 0; i < DEAD_TARGET_CAPACITY; i++) t.markDead(`u${i}`, { reason: "kicked", at: i });
    expect(t.size).toBe(DEAD_TARGET_CAPACITY);
    t.markDead("newcomer", { reason: "kicked", at: 999 });
    expect(t.size).toBe(DEAD_TARGET_CAPACITY);
    expect(t.isDead("u0")).toBe(false); // 最旧被淘汰
    expect(t.isDead("newcomer")).toBe(true);
  });
  it("isDead 命中即 touch，LRU 保活", () => {
    const t = new DeadTargetTable(2);
    t.markDead("a", { reason: "kicked", at: 1 });
    t.markDead("b", { reason: "kicked", at: 2 });
    expect(t.isDead("a")).toBe(true); // touch a
    t.markDead("c", { reason: "kicked", at: 3 }); // 应淘汰 b
    expect(t.isDead("b")).toBe(false);
    expect(t.isDead("a")).toBe(true);
    expect(t.isDead("c")).toBe(true);
  });
  it("stats 返回冻结快照且带容量", () => {
    const t = new DeadTargetTable(3);
    t.markDead("a", { reason: "kicked", at: 7 });
    const s = t.stats();
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.entries)).toBe(true);
    expect(s).toMatchObject({ size: 1, capacity: 3, entries: [{ targetId: "a", reason: "kicked", at: 7 }] });
  });
  it("空 id / 非有限 at → 不标死或归一为 0（不 throw）", () => {
    const t = new DeadTargetTable();
    expect(t.markDead("", { reason: "kicked", at: 1 })).toBe(false);
    expect(t.markDead("u1", { reason: "kicked", at: Number.NaN })).toBe(true);
    expect(t.stats().entries[0]?.at).toBe(0);
  });
});

describe("negotiateDescriptor：能力协商", () => {
  it("decline=true → DECLINED 且 ok=false（终态）", () => {
    const r = negotiateDescriptor({ decline: true, supported_ops: ["message"] }, { requiredOps: ["message"] });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("DECLINED");
  });
  it("缺 supported_ops → LEGACY 且 requiredOps 全部视为支持", () => {
    const r = negotiateDescriptor({ contract_version: 1 }, { requiredOps: ["message", "ping"] });
    expect(r.ok).toBe(true);
    expect(r.code).toBe("LEGACY");
    expect([...r.ops]).toEqual([...LEGACY_OPS]);
  });
  it("缺 supported_ops 但要求了 legacy 之外的操作 → UNSUPPORTED_OP", () => {
    const r = negotiateDescriptor({}, { requiredOps: ["threads"] });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("UNSUPPORTED_OP");
  });
  it("未知键丢弃并计入 droppedKeys", () => {
    const r = negotiateDescriptor({ supported_ops: ["message"], supported_opz: ["x"], vendor: { a: 1 } }, { requiredOps: ["message"] });
    expect(r.ok).toBe(true);
    expect([...r.droppedKeys]).toEqual(["supported_opz", "vendor"]);
    expect(r).not.toHaveProperty("supported_opz");
  });
  it("contract_version 非数字 → 不接受并计入 droppedKeys", () => {
    const r = negotiateDescriptor({ contract_version: "1", supported_ops: ["message"] }, { requiredOps: ["message"] });
    expect([...r.droppedKeys]).toEqual(["contract_version"]);
    expect(r.version).toBeUndefined();
    expect(r.ok).toBe(true);
  });
  it("低版本仍可用（code=OK，requiredOps 覆盖判定）", () => {
    const r = negotiateDescriptor({ contract_version: Math.max(0, CONTRACT_VERSION - 1), supported_ops: ["message"] }, { requiredOps: ["message"] });
    expect(r.ok).toBe(true);
    expect(r.code).toBe("OK");
  });
  it("未知高版本按交集判定（requiredOps 都在 → ok；缺 → UNSUPPORTED_OP）", () => {
    const hi = CONTRACT_VERSION + 99;
    const ok = negotiateDescriptor({ contract_version: hi, supported_ops: ["message", "ping"] }, { requiredOps: ["message"] });
    expect(ok.ok).toBe(true);
    expect([...ok.ops]).toEqual(["message", "ping"]);
    const bad = negotiateDescriptor({ contract_version: hi, supported_ops: ["message"] }, { requiredOps: ["message", "relay"] });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("UNSUPPORTED_OP");
  });
  it("supported_ops 里非字符串项被忽略、重复项去重", () => {
    const r = negotiateDescriptor({ supported_ops: ["message", 42, "message", "ping"] }, { requiredOps: ["message"] });
    expect([...r.ops]).toEqual(["message", "ping"]);
  });
  it("descriptor 非对象 → UNSUPPORTED_OP 且不 throw", () => {
    expect(negotiateDescriptor(null).code).toBe("UNSUPPORTED_OP");
    expect(negotiateDescriptor("x" as never).ok).toBe(false);
  });
  it("返回对象冻结", () => {
    expect(Object.isFrozen(negotiateDescriptor({ supported_ops: ["message"] }))).toBe(true);
  });
});

describe("sendFrame：interim/final 互斥", () => {
  it("仅 interim → 无 finish 标记", () => {
    const r = sendFrame({ targetId: "t1", text: "半句", interim: true });
    expect(r.code).toBe("OK");
    expect(r.frame).toEqual({ target: { id: "t1" }, text: "半句" });
    expect(r.markers).toEqual({ interim: true, final: false });
  });
  it("final 帧自带 finish 标记", () => {
    const r = sendFrame({ targetId: "t1", text: "完", final: true });
    expect(r.code).toBe("OK");
    expect(r.frame).toMatchObject({ target: { id: "t1" }, text: "完", finish: true });
    expect(r.markers).toEqual({ interim: false, final: true });
  });
  it("interim 与 final 同时 true → 不产帧且 code=INVALID（不 throw）", () => {
    const r = sendFrame({ targetId: "t1", text: "x", interim: true, final: true });
    expect(r.frame).toBeNull();
    expect(r.code).toBe("INVALID");
  });
  it("空 targetId / 非字符串 text → INVALID", () => {
    expect(sendFrame({ targetId: "", text: "x" }).code).toBe("INVALID");
    expect(sendFrame({ targetId: "t1", text: 5 as never }).code).toBe("INVALID");
    expect(sendFrame(null).code).toBe("INVALID");
  });
  it("结果与帧均冻结（不可变）", () => {
    const r = sendFrame({ targetId: "t1", text: "x", final: true });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.frame)).toBe(true);
    expect(Object.isFrozen(r.frame?.target)).toBe(true);
  });
});

describe("classifySendResult：终态不可被降级", () => {
  it("ok → 不重试、不标死、清死表", () => {
    expect(classifySendResult({ ok: true })).toEqual({ retryable: false, markDead: false, clearDead: true, code: "OK" });
  });
  it("declined → 不可重试且要标死（decline 是终态）", () => {
    const c = classifySendResult({ ok: false, declined: true });
    expect(c.retryable).toBe(false);
    expect(c.markDead).toBe(true);
    expect(c.code).toBe("DECLINED");
  });
  it("deadChat → 不可重试且要标死", () => {
    const c = classifySendResult({ ok: false, deadChat: true });
    expect(c.retryable).toBe(false);
    expect(c.markDead).toBe(true);
    expect(c.code).toBe("DEAD_TARGET");
  });
  it("暂时态（超时/网络）→ 可重试且不标死", () => {
    const c = classifySendResult({ ok: false });
    expect(c).toMatchObject({ retryable: true, markDead: false, clearDead: false, code: "TRANSIENT" });
  });
  it("非法输入按暂时态处理且不 throw；结果冻结", () => {
    const c = classifySendResult(null);
    expect(c.retryable).toBe(true);
    expect(Object.isFrozen(c)).toBe(true);
  });
});

describe("确定性与纯函数", () => {
  it("同输入两次运行结果深相等", () => {
    const input = { kind: "thread" as const, id: "s1", threadId: "th-1" };
    const ctx = { sessionOriginIds: ["s1"], threadAttestations: new Map([["th-1", { attestedId: "s1" }]]) };
    expect(attestDeliveryTarget(input, ctx)).toEqual(attestDeliveryTarget(input, ctx));
    const d = { contract_version: 3, supported_ops: ["message", "ping"], extra: 1 };
    expect(negotiateDescriptor(d, { requiredOps: ["message"] })).toEqual(negotiateDescriptor(d, { requiredOps: ["message"] }));
  });
});
