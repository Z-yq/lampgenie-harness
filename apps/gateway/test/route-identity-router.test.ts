/**
 * gate 接入事件级冻结路由身份。
 * 三条口径:
 * ① 不传 opts.routeIdentity = 旧行为逐字不变(主体仍取 trigger.identity);
 * ② 传了但身份不可用 = fail-closed,reason=route-identity:<code>,任何放宽门都捞不回来;
 * ③ 传了且可用 = 主体只读冻结快照,不从 trigger.identity 重算。
 */
import { describe, expect, it } from "vitest";
import type { MandateLike } from "@lampgenie/runtime/agent/mandate-lifecycle";
import { freezeRouteIdentity, type RouteIdentity } from "@lampgenie/runtime/router/route-identity";
import { DEFAULT_POLICY_CONFIG, gate, type PolicyConfig } from "../src/router/policy.js";

const T0 = 1_700_000_000_000;
const TK = "session:m120";
const EMPTY_SUBS = new Map<string, boolean>();

function configOf(over: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    ...DEFAULT_POLICY_CONFIG,
    mode: "observe",
    allowlist: [],
    sources: [{ name: "panel", listened: true }, { name: "im", listened: true }],
    ...over,
  };
}

function triggerOf(
  over: Partial<{ source: string; threadKey: string; identity?: string; addressed?: boolean; idempotencyKey?: string }> = {},
) {
  return { source: "im", threadKey: TK, ...over };
}

function frozen(over: Partial<Parameters<typeof freezeRouteIdentity>[1]> = {}): RouteIdentity {
  const r = freezeRouteIdentity({}, {
    tenantId: "t-acme",
    sourceKind: "dm",
    subjectId: "u-1",
    threadId: "th-1",
    generation: 1,
    frozenAt: T0,
    allowedTenants: ["t-acme"],
    ...over,
  });
  if (!r.ok) throw new Error(`冻结失败:${r.code}`);
  return r.identity;
}

describe("不传 routeIdentity:旧行为逐字不变", () => {
  it("panel → explicit", () => {
    expect(gate(triggerOf({ source: "panel" }), configOf(), EMPTY_SUBS)).toMatchObject({
      admissible: true,
      strength: "explicit",
    });
  });

  it("im 未点名 → observed(would_accept)", () => {
    expect(gate(triggerOf(), configOf(), EMPTY_SUBS)).toMatchObject({
      admissible: false,
      reason: "observed",
      would_accept: true,
    });
  });

  it("trigger.identity 命中白名单 → explicit(旧链保留)", () => {
    expect(gate(triggerOf({ identity: "u-1" }), configOf({ allowlist: ["u-1"] }), EMPTY_SUBS)).toMatchObject({
      admissible: true,
      strength: "explicit",
    });
  });

  it("来源未监听仍走 not_listened", () => {
    expect(gate(triggerOf(), configOf({ sources: [{ name: "panel", listened: true }] }), EMPTY_SUBS)).toMatchObject({
      admissible: false,
      reason: "not_listened",
    });
  });
});

describe("传可用 routeIdentity:主体只读冻结快照", () => {
  it("冻结 subject 命中白名单 → explicit", () => {
    expect(gate(triggerOf(), configOf({ allowlist: ["u-1"] }), EMPTY_SUBS, { routeIdentity: frozen() })).toMatchObject({
      admissible: true,
      strength: "explicit",
    });
  });

  it("冻结 subject 不在白名单,而 trigger.identity 在白名单 → 仍 observed(不从 trigger 重算)", () => {
    expect(gate(
      triggerOf({ identity: "u-1" }),
      configOf({ allowlist: ["u-1"] }),
      EMPTY_SUBS,
      { routeIdentity: frozen({ subjectId: "u-9" }) },
    )).toMatchObject({ admissible: false, reason: "observed", would_accept: true });
  });

  it("人显式点名(addressed)在身份可用时照旧生效", () => {
    expect(gate(triggerOf({ addressed: true }), configOf(), EMPTY_SUBS, { routeIdentity: frozen() })).toMatchObject({
      admissible: true,
      strength: "explicit",
    });
  });

  it("身份可用时来源未监听仍 not_listened(身份不放宽其它门)", () => {
    expect(gate(
      triggerOf(),
      configOf({ sources: [{ name: "panel", listened: true }] }),
      EMPTY_SUBS,
      { routeIdentity: frozen() },
    )).toMatchObject({ admissible: false, reason: "not_listened" });
  });

  it("身份可用时 mandate 失效仍拒(reason 以 mandate: 开头)", () => {
    const mandate: MandateLike = {
      id: "md-1",
      policyVersion: "stale-version",
      status: "active",
      issuedAt: T0 - 60_000,
      expiresAt: T0 + 60_000,
      ticketIds: ["tk-1"],
    };
    const r = gate(triggerOf(), configOf(), EMPTY_SUBS, { routeIdentity: frozen(), mandate, now: T0 });
    expect(r.admissible).toBe(false);
    expect(r.reason?.startsWith("mandate:")).toBe(true);
  });

  it("矩阵判定与等价的 trigger.identity 结果一致(冻结身份不另立口径)", () => {
    const cfg = configOf({ allowlist: ["u-1"] });
    const viaTrigger = gate(triggerOf({ identity: "u-1" }), cfg, EMPTY_SUBS, { matrix: { mode: "observe" } });
    const viaFrozen = gate(triggerOf(), cfg, EMPTY_SUBS, {
      matrix: { mode: "observe" },
      routeIdentity: frozen(),
    });
    expect({
      admissible: viaFrozen.admissible,
      strength: viaFrozen.strength,
      reason: viaFrozen.reason,
    }).toEqual({
      admissible: viaTrigger.admissible,
      strength: viaTrigger.strength,
      reason: viaTrigger.reason,
    });
  });

  it("冻结快照本身不可变(Object.isFrozen)", () => {
    expect(Object.isFrozen(frozen())).toBe(true);
  });
});

describe("传不可用 routeIdentity:fail-closed", () => {
  it("null → route-identity:INVALID,且不带强度", () => {
    const r = gate(triggerOf(), configOf(), EMPTY_SUBS, { routeIdentity: null as unknown as RouteIdentity });
    expect(r.admissible).toBe(false);
    expect(r.reason).toBe("route-identity:INVALID");
    expect(r.strength).toBeUndefined();
    expect(r.would_accept).toBeUndefined();
  });

  it("缺 key 的结构坏身份 → INVALID", () => {
    const bad = { ...frozen() } as Record<string, unknown>;
    delete bad.key;
    const r = gate(triggerOf(), configOf(), EMPTY_SUBS, { routeIdentity: bad as unknown as RouteIdentity });
    expect(r.reason).toBe("route-identity:INVALID");
  });

  it("代际不一致 → route-identity:STALE_GENERATION", () => {
    const r = gate(triggerOf(), configOf(), EMPTY_SUBS, {
      routeIdentity: frozen({ generation: 1 }),
      currentGeneration: 2,
    });
    expect(r.admissible).toBe(false);
    expect(r.reason).toBe("route-identity:STALE_GENERATION");
  });

  it("坏身份压过一切放宽门:panel 来源 + 白名单也不放行", () => {
    const r = gate(
      triggerOf({ source: "panel" }),
      configOf({ allowlist: ["u-1"] }),
      EMPTY_SUBS,
      { routeIdentity: null as unknown as RouteIdentity },
    );
    expect(r.admissible).toBe(false);
    expect(r.reason).toContain("route-identity:");
  });

  it("身份不可用时订阅直通也失效(校验先于订阅)", () => {
    const subs = [{
      id: "sub-1",
      threadKey: TK,
      kind: "route",
      wakePolicy: "always",
      until: T0 + 60_000,
      superseded: false,
      generation: 1,
    }];
    const r = gate(triggerOf(), configOf(), EMPTY_SUBS, {
      subscriptions: subs as never,
      routeIdentity: null as unknown as RouteIdentity,
      now: T0,
    });
    expect(r.admissible).toBe(false);
    expect(r.reason).toBe("route-identity:INVALID");
  });

  it("代际一致则原判定照常(explicit)", () => {
    expect(gate(triggerOf({ source: "panel" }), configOf(), EMPTY_SUBS, {
      routeIdentity: frozen({ generation: 3 }),
      currentGeneration: 3,
    })).toMatchObject({ admissible: true, strength: "explicit" });
  });
});
