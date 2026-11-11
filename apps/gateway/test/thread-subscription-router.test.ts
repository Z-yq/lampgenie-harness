/**
 * router gate × thread 订阅表:context 只扇出、route 才直通、过期/沉睡回退、旧参数逐字兼容。
 * 真探针 A-D 的 routeSubscriptions / contextFanout / decision 在用例里直接打印。
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
  contextFanout,
  decideSubscription,
  recordDecision,
  routeSubscriptions,
  type AddSubscriptionInput,
  type ThreadSubscription,
} from "@lampgenie/runtime/agent/thread-subscription";

const T0 = 1_700_000_000_000;
const TK = "session:s1";

const configOf = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({ ...DEFAULT_POLICY_CONFIG, ...over });

/** 连续 add,返回最终订阅表。 */
function subsOf(...inputs: AddSubscriptionInput[]): ThreadSubscription[] {
  let list: ThreadSubscription[] = [];
  for (const input of inputs) list = addSubscription(list, input).list;
  return list;
}

/** 探针打印:route / context / decision / gate 四处对照。 */
function probe(tag: string, list: readonly ThreadSubscription[], result: GateResult, now = T0): void {
  const ids = (xs: readonly ThreadSubscription[]) => xs.map((s) => s.id);
 // eslint-disable-next-line no-console
  console.log(
    `[probe ${tag}] routeSubscriptions=${JSON.stringify(ids(routeSubscriptions(list, TK, now)))}`
    + ` contextFanout=${JSON.stringify(ids(contextFanout(list, TK, now)))}`
    + ` decision=${JSON.stringify(decideSubscription(list, TK, now))}`
    + ` gate=${JSON.stringify(result)}`,
  );
}

describe("探针 A:只有 context 订阅 → 不放行,只标 contextOnly", () => {
  it("A) context-only:admissible=false + contextOnly=true + observed;路由结果为空", () => {
    const list = subsOf({ threadKey: TK, subscriber: "watcher", mode: "context", createdAt: T0 });
    const r = gate({ source: "im", threadKey: TK }, configOf(), new Map(), { subscriptions: list, now: T0 });
    probe("A", list, r);
    expect(routeSubscriptions(list, TK, T0)).toEqual([]);
    expect(contextFanout(list, TK, T0)).toHaveLength(1);
    expect(r.admissible).toBe(false);
    expect(r.reason).toBe("observed");
    expect(r.contextOnly).toBe(true);
    expect(r.subscriptionDecision).toEqual({ decision: "context-only", subscriptionIds: [list[0]?.id] });
  });

  it("A2) 来源未监听:reason 如实 not_listened,contextOnly 仍照实标", () => {
    const list = subsOf({ threadKey: TK, subscriber: "watcher", createdAt: T0 });
    const r = gate({ source: "im", threadKey: TK }, configOf({ sources: [{ name: "im", listened: false }] }), new Map(), { subscriptions: list, now: T0 });
    probe("A2", list, r);
    expect(r.admissible).toBe(false);
    expect(r.reason).toBe("not_listened");
    expect(r.contextOnly).toBe(true);
  });

  it("A3) context 订阅不能借面板显式授权改写成 route:contextOnly 与 explicit 同时出现", () => {
    const list = subsOf({ threadKey: TK, subscriber: "watcher", createdAt: T0 });
    const r = gate({ source: "panel", threadKey: TK }, configOf(), new Map(), { subscriptions: list, now: T0 });
 // 面板本身就是显式授权,放行来自授权链而不是订阅表 —— 订阅侧结论必须仍是 context-only。
    expect(r).toMatchObject({ admissible: true, strength: "explicit", contextOnly: true });
    expect(r.subscriptionDecision?.decision).toBe("context-only");
  });
});

describe("探针 B/C/D:route 订阅的直通与回退", () => {
  it("B) 同 threadKey 加 route 订阅 → admissible=true/explicit,routed", () => {
    const list = subsOf(
      { threadKey: TK, subscriber: "watcher", createdAt: T0 },
      { threadKey: TK, subscriber: "owner", mode: "route", createdAt: T0 },
    );
    const r = gate({ source: "im", threadKey: TK }, configOf(), new Map(), { subscriptions: list, now: T0 });
    probe("B", list, r);
    expect(r.admissible).toBe(true);
    expect(r.strength).toBe("explicit");
    expect(r.contextOnly).toBeUndefined();
    expect(r.subscriptionDecision?.decision).toBe("routed");
    expect(r.subscriptionDecision?.subscriptionIds).toEqual([list[1]?.id]);
  });

  it("C) route 订阅过期 → 回退非直通(observed)", () => {
    const list = subsOf({ threadKey: TK, subscriber: "owner", mode: "route", createdAt: T0, until: T0 + 1_000, now: T0 });
    const r = gate({ source: "im", threadKey: TK }, configOf(), new Map(), { subscriptions: list, now: T0 + 2_000 });
    probe("C", list, r, T0 + 2_000);
    expect(r.admissible).toBe(false);
    expect(r.reason).toBe("observed");
    expect(r.contextOnly).toBeUndefined();
    expect(r.subscriptionDecision).toEqual({ decision: "denied", subscriptionIds: [] });
  });

  it("D) silent route 订阅 → 不直通", () => {
    const list = subsOf({ threadKey: TK, subscriber: "owner", mode: "route", wakePolicy: "silent", createdAt: T0 });
    const r = gate({ source: "im", threadKey: TK }, configOf(), new Map(), { subscriptions: list, now: T0 });
    probe("D", list, r);
    expect(r.admissible).toBe(false);
    expect(r.reason).toBe("observed");
    expect(r.subscriptionDecision?.decision).toBe("denied");
  });
});

describe("旧 liveSubscriptions 兼容", () => {
  it("不传 subscriptions:旧语义逐字不变(threadKey 活 Ticket → 直通)", () => {
    const live = new Map([[TK, true]]);
    const r = gate({ source: "im", threadKey: TK }, configOf(), live);
    expect(r).toMatchObject({ admissible: true, strength: "explicit" });
    expect(r.subscriptionDecision).toBeUndefined();
    expect(r.contextOnly).toBeUndefined();
  });

  it("传了 subscriptions:旧表不再参与判定(旧表 true + 新表只有 context → 仍不放行)", () => {
    const list = subsOf({ threadKey: TK, subscriber: "watcher", createdAt: T0 });
    const r = gate({ source: "im", threadKey: TK }, configOf(), new Map([[TK, true]]), { subscriptions: list, now: T0 });
    expect(r.admissible).toBe(false);
    expect(r.reason).toBe("observed");
    expect(r.contextOnly).toBe(true);
  });

  it("不传 subscriptions 且无活 Ticket、无订阅表 → 不出现订阅字段", () => {
    const r = gate({ source: "im", threadKey: TK }, configOf(), new Map());
    expect(r).toEqual({ admissible: false, reason: "observed", would_accept: true });
  });
});

describe("订阅表与授权链的组合边界", () => {
  it("route 订阅也不能绕过 source 监听门", () => {
    const list = subsOf({ threadKey: TK, subscriber: "owner", mode: "route", createdAt: T0 });
    const r = gate({ source: "im", threadKey: TK }, configOf({ sources: [{ name: "panel", listened: true }, { name: "im", listened: false }] }), new Map(), { subscriptions: list, now: T0 });
    expect(r.reason).toBe("not_listened");
    expect(r.admissible).toBe(false);
  });

  it("threadKey 不匹配的 route 订阅不生效", () => {
    const list = subsOf({ threadKey: "session:other", subscriber: "owner", mode: "route", createdAt: T0 });
    const r = gate({ source: "im", threadKey: TK }, configOf(), new Map(), { subscriptions: list, now: T0 });
    expect(r.admissible).toBe(false);
    expect(r.subscriptionDecision?.decision).toBe("denied");
  });

  it("subscribe → gate → recordDecision:决策史落到两条订阅上(gate 不落盘,由调用方记)", () => {
    const list = subsOf(
      { threadKey: TK, subscriber: "watcher", createdAt: T0 },
      { threadKey: TK, subscriber: "owner", mode: "route", createdAt: T0 },
    );
    const r = gate({ source: "im", threadKey: TK }, configOf(), new Map(), { subscriptions: list, now: T0 });
    const recorded = recordDecision(list, { threadKey: TK, triggerId: "trig-1", decision: r.subscriptionDecision?.decision ?? "denied", at: T0 + 1 });
    expect(recorded.recorded).toBe(2);
    expect(recorded.list[0]?.decisionHistory[0]).toMatchObject({ triggerId: "trig-1", decision: "routed" });
 // 不可变:gate/record 都不改原表
    expect(list[0]?.decisionHistory).toEqual([]);
    expect(list[1]?.decisionHistory).toEqual([]);
  });
});
