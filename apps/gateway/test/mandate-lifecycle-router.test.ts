/**
 * gate 的 mandate 复验接入。
 * 核心口径两条:①不传 opts.mandate = 旧行为逐字不变;②传了 = 只收紧不放宽,
 * 吊销/过期/策略失效一律 reason=mandate:<code>,且必须能拦住订阅直通。
 */
import { describe, expect, it } from "vitest";
import type { MandateLike } from "@lampgenie/runtime/agent/mandate-lifecycle";
import {
  DEFAULT_POLICY_CONFIG,
  gate,
  mandateAdmission,
  policyVersion,
  type PolicyConfig,
} from "../src/router/policy.js";

const T0 = 1_700_000_000_000;
const TK = "session:m188";
/** 当前策略版本:gate 内部按 config 现算,测试用同一 config 派生的版本。 */
const V = policyVersion(DEFAULT_POLICY_CONFIG);

const configOf = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({
  ...DEFAULT_POLICY_CONFIG,
  mode: "observe",
  allowlist: [],
  sources: [{ name: "panel", listened: true }, { name: "im", listened: true }],
  ...over,
});

const mandateOf = (over: Partial<MandateLike> = {}): MandateLike => ({
  id: "md-1",
  policyVersion: V,
  status: "active",
  issuedAt: T0 - 60_000,
  expiresAt: T0 + 60_000,
  ticketIds: ["tk-1"],
  ...over,
});

const triggerOf = (over: Partial<{ source: string; identity: string; addressed: boolean; idempotencyKey: string }> = {}) => ({
  source: "im",
  threadKey: TK,
  ...over,
});

const EMPTY_SUBS = new Map<string, boolean>();

describe("不传 opts.mandate:旧行为逐字不变", () => {
  it("panel → explicit;im 未点名 → observed(would_accept)", () => {
    expect(gate(triggerOf({ source: "panel" }), configOf(), EMPTY_SUBS)).toMatchObject({
      admissible: true,
      strength: "explicit",
    });
    const observed = gate(triggerOf(), configOf(), EMPTY_SUBS);
    expect(observed).toMatchObject({ admissible: false, reason: "observed", would_accept: true });
  });

  it("活 Ticket 订阅直通保留", () => {
    const r = gate(triggerOf(), configOf(), new Map([[TK, true]]));
    expect(r).toMatchObject({ admissible: true, strength: "explicit" });
  });
});

describe("传了 mandate:只收紧不放宽", () => {
  it("active + 同版本 + 未过期 → 继续原判定(panel 仍 explicit)", () => {
    const r = gate(triggerOf({ source: "panel" }), configOf(), EMPTY_SUBS, { mandate: mandateOf(), now: T0 });
    expect(r).toMatchObject({ admissible: true, strength: "explicit" });
    expect(r.reason).toBeUndefined();
  });

  it("有效 mandate 不放宽推断候选:im 未点名仍 observed", () => {
    const r = gate(triggerOf(), configOf(), EMPTY_SUBS, { mandate: mandateOf(), now: T0 });
    expect(r).toMatchObject({ admissible: false, reason: "observed" });
  });

  it("revoce 后 → 拒,reason=mandate:REVOKED,不编造 strength", () => {
    const revoked = mandateOf({ status: "revoked", revokedAt: T0, revokedBy: "u-1", revokeReason: "stop" });
    const r = gate(triggerOf({ source: "panel" }), configOf(), EMPTY_SUBS, { mandate: revoked, now: T0 });
    expect(r.admissible).toBe(false);
    expect(r.reason).toBe("mandate:REVOKED");
    expect(r.strength).toBeUndefined();
  });

  it("expiresAt 到点 → mandate:EXPIRED(边界含等)", () => {
    const r = gate(triggerOf({ source: "panel" }), configOf(), EMPTY_SUBS, {
      mandate: mandateOf({ expiresAt: T0 }),
      now: T0,
    });
    expect(r.reason).toBe("mandate:EXPIRED");
  });

  it("策略版本不一致 → mandate:POLICY_CHANGED", () => {
    const r = gate(triggerOf({ source: "panel" }), configOf(), EMPTY_SUBS, {
      mandate: mandateOf({ policyVersion: "v-old" }),
      now: T0,
    });
    expect(r.admissible).toBe(false);
    expect(r.reason).toBe("mandate:POLICY_CHANGED");
  });

  it("形态非法 → mandate:INVALID(fail-closed)", () => {
    const bad = { id: "x" } as unknown as MandateLike;
    const r = gate(triggerOf({ source: "panel" }), configOf(), EMPTY_SUBS, { mandate: bad, now: T0 });
    expect(r.reason).toBe("mandate:INVALID");
  });

  it("吊销的 mandate 拦住订阅直通(不能只拦普通授权链)", () => {
    const revoked = mandateOf({ status: "revoked", revokedAt: T0, revokedBy: "u-1", revokeReason: "stop" });
    const r = gate(triggerOf(), configOf(), new Map([[TK, true]]), { mandate: revoked, now: T0 });
    expect(r.admissible).toBe(false);
    expect(r.reason).toBe("mandate:REVOKED");
  });

  it("来源未监听优先(监听门在 mandate 之前)", () => {
    const revoked = mandateOf({ status: "revoked", revokedAt: T0, revokedBy: "u-1", revokeReason: "stop" });
    const r = gate(
      triggerOf(),
      configOf({ sources: [{ name: "im", listened: false }, { name: "panel", listened: true }] }),
      EMPTY_SUBS,
      { mandate: revoked, now: T0 },
    );
    expect(r.reason).toBe("not_listened");
  });
});

describe("mandateAdmission 直调", () => {
  it("与 runtime canAdmitWithMandate 同源:ok+code", () => {
    expect(mandateAdmission(mandateOf(), V, T0)).toEqual({ ok: true, code: "OK" });
    expect(mandateAdmission(mandateOf({ policyVersion: "v-old" }), V, T0)).toEqual({
      ok: false,
      code: "POLICY_CHANGED",
    });
    expect(mandateAdmission(null, V, T0)).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});
