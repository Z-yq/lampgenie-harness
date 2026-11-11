/**
 * router gate × 准入矩阵:传 opts.matrix 时矩阵决定投递资格,不传时旧 allowed 链逐字不变;
 * 订阅直通(route/liveSubscriptions)与 source 监听门仍高于矩阵。
 * 内含真实探针 A-G(逐格实跑打印 admit/strength/reason/ruleId)。
 */
import { describe, expect, it } from "vitest";
import {
  gate,
  DEFAULT_POLICY_CONFIG,
  type GateResult,
  type PolicyConfig,
} from "../src/router/policy.js";
import {
  addSubscription,
  type AddSubscriptionInput,
  type ThreadSubscription,
} from "@lampgenie/runtime/agent/thread-subscription";
import {
  ADMISSION_MATRIX_VERSION,
  ADMISSION_RULE_IDS,
  evaluateAdmission,
  type AdmissionMode,
} from "@lampgenie/runtime/agent/admission-matrix";

const T0 = 1_700_000_000_000;
const TK = "session:m187";

const configOf = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({
  ...DEFAULT_POLICY_CONFIG,
  mode: "observe",
  allowlist: ["ou_ok"],
  sources: [{ name: "panel", listened: true }, { name: "im", listened: true }],
  ...over,
});

const EMPTY_SUBS = new Map<string, boolean>();

/** 连续 add,返回最终订阅表。 */
function subsOf(...inputs: AddSubscriptionInput[]): ThreadSubscription[] {
  let list: ThreadSubscription[] = [];
  for (const input of inputs) list = addSubscription(list, input).list;
  return list;
}

const triggerOf = (over: Partial<{ source: string; identity: string; addressed: boolean; idempotencyKey: string }> = {}) => ({
  source: "im",
  threadKey: TK,
  ...over,
});

describe("不传 matrix:旧 allowed 链逐字不变", () => {
  it("panel 来源 → explicit,无 matrixDecision", () => {
    const r = gate(triggerOf({ source: "panel" }), configOf(), EMPTY_SUBS);
    expect(r).toMatchObject({ admissible: true, strength: "explicit" });
    expect(r.matrixDecision).toBeUndefined();
  });

  it("活 Ticket 订阅命中 threadKey → explicit 直通", () => {
    const r = gate(triggerOf(), configOf(), new Map([[TK, true]]));
    expect(r).toMatchObject({ admissible: true, strength: "explicit" });
    expect(r.matrixDecision).toBeUndefined();
  });

  it("im 未点名未白名单 → observed + would_accept", () => {
    const r = gate(triggerOf({ identity: "ou_other" }), configOf(), EMPTY_SUBS);
    expect(r).toMatchObject({ admissible: false, reason: "observed", would_accept: true });
    expect(r.matrixDecision).toBeUndefined();
  });

  it("来源未监听 → not_listened", () => {
    const r = gate(triggerOf(), configOf({ sources: [{ name: "im", listened: false }] }), EMPTY_SUBS);
    expect(r).toMatchObject({ admissible: false, reason: "not_listened" });
  });

  it("白名单身份在旧链路仍是无条件 explicit(矩阵不介入)", () => {
    const r = gate(triggerOf({ identity: "ou_ok" }), configOf(), EMPTY_SUBS);
    expect(r).toMatchObject({ admissible: true, strength: "explicit" });
    expect(r.matrixDecision).toBeUndefined();
  });
});

describe("传 matrix:矩阵决定投递资格", () => {
  it("A) listed+addressed+observe → admit explicit", () => {
    const r = gate(triggerOf({ identity: "ou_ok", addressed: true }), configOf(), EMPTY_SUBS, { matrix: { mode: "observe" } });
    expect(r.admissible).toBe(true);
    expect(r.strength).toBe("explicit");
    expect(r.matrixDecision?.decision.ruleId).toBe("listed-addressed");
  });

  it("B) listed+unaddressed+observe → observed + would_accept", () => {
    const r = gate(triggerOf({ identity: "ou_ok" }), configOf(), EMPTY_SUBS, { matrix: { mode: "observe" } });
    expect(r).toMatchObject({ admissible: false, reason: "observed", would_accept: true });
    expect(r.strength).toBeUndefined();
    expect(r.matrixDecision?.decision.ruleId).toBe("listed-unaddressed-observe");
  });

  it("C) 同格 auto → inferred", () => {
    const r = gate(triggerOf({ identity: "ou_ok" }), configOf(), EMPTY_SUBS, { matrix: { mode: "auto" } });
    expect(r).toMatchObject({ admissible: true, strength: "inferred" });
    expect(r.matrixDecision?.decision.reason).toBe("mode_auto");
  });

  it("C2) 同格 allow → explicit(配置允许)", () => {
    const r = gate(triggerOf({ identity: "ou_ok" }), configOf(), EMPTY_SUBS, { matrix: { mode: "allow" } });
    expect(r).toMatchObject({ admissible: true, strength: "explicit" });
    expect(r.matrixDecision?.decision.reason).toBe("mode_allow");
  });

  it("D) unlisted+addressed → not admit unlisted(点名绕过不了白名单)", () => {
    const r = gate(triggerOf({ identity: "ou_other", addressed: true }), configOf(), EMPTY_SUBS, { matrix: { mode: "auto" } });
    expect(r).toMatchObject({ admissible: false, reason: "unlisted" });
    expect(r.would_accept).toBeUndefined();
    expect(r.matrixDecision?.decision.ruleId).toBe("unlisted-addressed");
  });

  it("E) explicitGrant(面板来源)+ unlisted → explicit_grant", () => {
    const r = gate(triggerOf({ source: "panel", identity: "ou_other" }), configOf(), EMPTY_SUBS, { matrix: { mode: "observe" } });
    expect(r).toMatchObject({ admissible: true, strength: "explicit" });
    expect(r.matrixDecision?.decision.ruleId).toBe("explicit-grant");
  });

  it("E2) 幂等键=显式授权,同样优先于白名单判定", () => {
    const r = gate(triggerOf({ identity: "ou_other", idempotencyKey: "k-1" }), configOf(), EMPTY_SUBS, { matrix: { mode: "observe" } });
    expect(r.admissible).toBe(true);
    expect(r.matrixDecision?.decision.reason).toBe("explicit_grant");
  });

  it("F) 非法 mode → fail-closed invalid(不派发)", () => {
    const r = gate(triggerOf({ identity: "ou_ok", addressed: true }), configOf(), EMPTY_SUBS, {
      matrix: { mode: "bogus" as unknown as AdmissionMode },
    });
    expect(r).toMatchObject({ admissible: false, reason: "invalid" });
    expect(r.matrixDecision?.decision.strength).toBe("none");
  });

  it("G) matrixDecision 带全量 traces 与口径版本", () => {
    const r = gate(triggerOf({ identity: "ou_ok" }), configOf(), EMPTY_SUBS, { matrix: { mode: "auto" } });
    expect(r.matrixDecision?.traces.map((t) => t.ruleId)).toEqual([...ADMISSION_RULE_IDS]);
    expect(r.matrixDecision?.matrixVersion).toBe(ADMISSION_MATRIX_VERSION);
  });

  it("矩阵不得绕过 source 监听门:未监听 → not_listened 且无 matrixDecision", () => {
    const r = gate(triggerOf({ identity: "ou_ok", addressed: true }), configOf({ sources: [{ name: "im", listened: false }] }), EMPTY_SUBS, {
      matrix: { mode: "allow" },
    });
    expect(r).toMatchObject({ admissible: false, reason: "not_listened" });
    expect(r.matrixDecision).toBeUndefined();
  });

  it("route 订阅直通最高优先:矩阵不参与,结果仍 explicit", () => {
    const list = subsOf({ threadKey: TK, subscriber: "owner", mode: "route", createdAt: T0 });
    const r = gate(triggerOf({ identity: "ou_other" }), configOf(), EMPTY_SUBS, {
      subscriptions: list,
      now: T0,
      matrix: { mode: "observe" },
    });
    expect(r).toMatchObject({ admissible: true, strength: "explicit" });
    expect(r.subscriptionDecision?.decision).toBe("routed");
    expect(r.matrixDecision).toBeUndefined();
  });

  it("旧 liveSubscriptions 直通仍在矩阵之前(传 matrix 也不降级)", () => {
    const r = gate(triggerOf({ identity: "ou_other" }), configOf(), new Map([[TK, true]]), { matrix: { mode: "observe" } });
    expect(r).toMatchObject({ admissible: true, strength: "explicit" });
    expect(r.matrixDecision).toBeUndefined();
  });

  it("context-only 订阅只标 contextOnly,投递资格仍由矩阵判", () => {
    const list = subsOf({ threadKey: TK, subscriber: "watcher", mode: "context", createdAt: T0 });
    const r = gate(triggerOf({ identity: "ou_ok" }), configOf(), EMPTY_SUBS, {
      subscriptions: list,
      now: T0,
      matrix: { mode: "observe" },
    });
    expect(r).toMatchObject({ admissible: false, reason: "observed", contextOnly: true, would_accept: true });
    expect(r.subscriptionDecision?.decision).toBe("context-only");
    expect(r.matrixDecision?.decision.ruleId).toBe("listed-unaddressed-observe");
  });
});

describe("探针 A-G:7 格矩阵实跑打印", () => {
  it("逐格输出 admit/strength/reason/ruleId,并核对矩阵与 gate 一致", () => {
    const matrixMode = "observe" as const;
    const probes: Array<{ tag: string; result: GateResult }> = [
      { tag: "A) listed+addressed observe", result: gate(triggerOf({ identity: "ou_ok", addressed: true }), configOf(), EMPTY_SUBS, { matrix: { mode: matrixMode } }) },
      { tag: "B) listed+unaddressed observe", result: gate(triggerOf({ identity: "ou_ok" }), configOf(), EMPTY_SUBS, { matrix: { mode: matrixMode } }) },
      { tag: "C) listed+unaddressed auto", result: gate(triggerOf({ identity: "ou_ok" }), configOf(), EMPTY_SUBS, { matrix: { mode: "auto" } }) },
      { tag: "C2) listed+unaddressed allow", result: gate(triggerOf({ identity: "ou_ok" }), configOf(), EMPTY_SUBS, { matrix: { mode: "allow" } }) },
      { tag: "D) unlisted+addressed auto", result: gate(triggerOf({ identity: "ou_other", addressed: true }), configOf(), EMPTY_SUBS, { matrix: { mode: "auto" } }) },
      { tag: "E) explicitGrant(panel)+unlisted", result: gate(triggerOf({ source: "panel", identity: "ou_other" }), configOf(), EMPTY_SUBS, { matrix: { mode: matrixMode } }) },
      { tag: "F) unknown mode", result: gate(triggerOf({ identity: "ou_ok" }), configOf(), EMPTY_SUBS, { matrix: { mode: "bogus" as unknown as AdmissionMode } }) },
    ];
    for (const { tag, result } of probes) {
      const d = result.matrixDecision?.decision;
 // eslint-disable-next-line no-console
      console.log(
        `[probe ${tag}] admit=${result.admissible} strength=${result.strength ?? "none"} reason=${result.reason ?? "accepted"}`
        + ` ruleId=${d?.ruleId ?? "-"} wouldAccept=${d?.wouldAccept === true}`,
      );
 // gate 结论必须与矩阵结论同源(不是两套判定各算一遍)
      expect(result.admissible).toBe(d?.admit);
    }
 // G) traces 全量 + 非短路:invalid+explicitGrant 两条规则同时命中
    const g = evaluateAdmission({ listed: false, addressed: false, mode: "bogus" as unknown as AdmissionMode, explicitGrant: true, source: "panel" });
    const matchedIds = g.traces.filter((t) => t.matched).map((t) => t.ruleId);
 // eslint-disable-next-line no-console
    console.log(`[probe G] traces=${g.traces.length} matched=${JSON.stringify(matchedIds)} decision=${g.decision.ruleId}/${g.decision.reason}`);
    expect(g.traces).toHaveLength(ADMISSION_RULE_IDS.length);
    expect(matchedIds).toEqual(expect.arrayContaining(["invalid-input", "explicit-grant"]));
    expect(g.decision.reason).toBe("invalid");
  });
});
