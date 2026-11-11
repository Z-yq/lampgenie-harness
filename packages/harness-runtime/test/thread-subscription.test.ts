/**
 * thread 订阅纯逻辑:context/route 分离、generation 替换、决策史上限、过期标记、唤醒计划。
 * 全纯函数直测,不触 IO。
 */
import { describe, expect, it } from "vitest";
import {
  addSubscription,
  cloneSubscriptions,
  contextFanout,
  DECISION_HISTORY_LIMIT,
  DECISION_KINDS,
  decideSubscription,
  DIGEST_HOUR_MS,
  expireSubscriptions,
  isThreadSubExpired,
  recordDecision,
  routeSubscriptions,
  SUB_MODES,
  summarizeThread,
  THREAD_SUB_CODES,
  THREAD_SUB_CONTEXT_ONLY,
  THREAD_SUB_DUPLICATE,
  THREAD_SUB_EXPIRED,
  THREAD_SUB_INVALID,
  THREAD_SUB_OK,
  THREAD_SUB_ROUTE_DENIED,
  THREAD_SUB_VERSION,
  WAKE_POLICIES,
  wakePlan,
  type AddSubscriptionInput,
  type ThreadSubscription,
} from "../src/agent/thread-subscription.ts";

const T0 = 1_700_000_000_000;

/** 造一条订阅(走 addSubscription,保持与生产路径同源)。 */
function make(over: Partial<AddSubscriptionInput> = {}): ThreadSubscription {
  const r = addSubscription([], { threadKey: "session:s1", subscriber: "agent-a", createdAt: T0, ...over });
  if (r.subscription === undefined) throw new Error(`造订阅失败:${r.code}`);
  return r.subscription;
}

/** 在同一条链上连续追加,返回最终表。 */
function chain(...inputs: AddSubscriptionInput[]): ThreadSubscription[] {
  let list: ThreadSubscription[] = [];
  for (const input of inputs) list = addSubscription(list, input).list;
  return list;
}

describe("码表与常量", () => {
  it("THREAD_SUB_CODES:6 条、唯一、固定顺序", () => {
    expect(THREAD_SUB_CODES).toHaveLength(6);
    expect(new Set(THREAD_SUB_CODES).size).toBe(6);
    expect(THREAD_SUB_CODES[0]).toBe("OK");
    expect(THREAD_SUB_CODES).toContain("ROUTE_DENIED");
    expect(THREAD_SUB_CODES).toContain("CONTEXT_ONLY");
  });

  it("模式/唤醒/决策枚举与版本号", () => {
    expect(THREAD_SUB_VERSION).toBe(1);
    expect([...SUB_MODES]).toEqual(["context", "route"]);
    expect([...WAKE_POLICIES]).toEqual(["immediate", "digest", "silent"]);
    expect([...DECISION_KINDS]).toEqual(["routed", "context-only", "denied"]);
    expect(DECISION_HISTORY_LIMIT).toBe(50);
    expect(DIGEST_HOUR_MS).toBe(3_600_000);
  });

  it("THREAD_SUB_OK 是字符串常量且与稳定码表同源", () => {
    expect(typeof THREAD_SUB_OK).toBe("string");
    expect(THREAD_SUB_CODES).toContain(THREAD_SUB_OK);
  });
});

describe("addSubscription:必填与缺省", () => {
  it("缺 threadKey → INVALID 且表不变", () => {
    const base = chain({ threadKey: "session:s1", subscriber: "a", createdAt: T0 });
    const r = addSubscription(base, { threadKey: "", subscriber: "b", createdAt: T0 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(THREAD_SUB_INVALID);
    expect(r.list).toHaveLength(1);
  });

  it("缺 subscriber → INVALID", () => {
    const r = addSubscription([], { threadKey: "session:s1", subscriber: "", createdAt: T0 });
    expect(r.code).toBe(THREAD_SUB_INVALID);
    expect(r.reason).toBe("subscriber");
  });

  it("mode 缺省 context、wakePolicy 缺省 immediate、generation=1、id 可派生", () => {
    const sub = make();
    expect(sub.mode).toBe("context");
    expect(sub.wakePolicy).toBe("immediate");
    expect(sub.generation).toBe(1);
    expect(sub.id).toBe("session:s1:agent-a:context:g1");
    expect(sub.decisionHistory).toEqual([]);
  });

  it("非法 mode / 非法 wakePolicy → INVALID", () => {
    expect(addSubscription([], { threadKey: "k", subscriber: "a", mode: "owner" as never }).code).toBe(THREAD_SUB_INVALID);
    expect(addSubscription([], { threadKey: "k", subscriber: "a", wakePolicy: "lazy" as never }).code).toBe(THREAD_SUB_INVALID);
  });

  it("until<=now → EXPIRED 且不加入", () => {
    const r = addSubscription([], { threadKey: "k", subscriber: "a", createdAt: T0, until: T0, now: T0 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(THREAD_SUB_EXPIRED);
    expect(r.list).toEqual([]);
  });

  it("until>now → 正常加入且保留 until", () => {
    const sub = make({ until: T0 + 60_000, now: T0 });
    expect(sub.until).toBe(T0 + 60_000);
    expect(isThreadSubExpired(sub, T0)).toBe(false);
    expect(isThreadSubExpired(sub, T0 + 60_000)).toBe(true);
  });
});

describe("addSubscription:DUPLICATE 幂等与 generation 替换", () => {
  it("同 (threadKey,subscriber,mode) 活跃重复 → DUPLICATE 幂等返回既有", () => {
    const base = chain({ threadKey: "k", subscriber: "a", createdAt: T0 });
    const r = addSubscription(base, { threadKey: "k", subscriber: "a", createdAt: T0 + 1, now: T0 + 1 });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(THREAD_SUB_DUPLICATE);
    expect(r.list).toHaveLength(1);
    expect(r.subscription?.id).toBe(base[0]?.id);
    expect(r.list[0]).toEqual(base[0]);
  });

  it("同键旧订阅过期后新增 → generation+1,旧代标 superseded 但不物理删", () => {
    const first = make({ threadKey: "k", until: T0 + 1_000, now: T0 });
    const r = addSubscription([first], { threadKey: "k", subscriber: "agent-a", createdAt: T0 + 5_000, now: T0 + 5_000 });
    expect(r.code).toBe(THREAD_SUB_OK);
    expect(r.subscription?.generation).toBe(2);
    expect(r.list).toHaveLength(2);
    expect(r.list[0]?.superseded).toBe(true);
    expect(r.list[0]?.id).toBe(first.id);
    expect(r.list[1]?.superseded).toBeUndefined();
  });

  it("不同 mode 可共存(context 与 route 各一条)", () => {
    const list = chain(
      { threadKey: "k", subscriber: "a", createdAt: T0 },
      { threadKey: "k", subscriber: "a", mode: "route", createdAt: T0 },
    );
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.mode)).toEqual(["context", "route"]);
  });

  it("入参不被就地修改", () => {
    const base = chain({ threadKey: "k", subscriber: "a", createdAt: T0 });
    const snapshot = JSON.stringify(base);
    const ref0 = base[0];
    addSubscription(base, { threadKey: "k", subscriber: "a", createdAt: T0 + 1, now: T0 + 1 });
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(base[0]).toBe(ref0);
  });
});

describe("routeSubscriptions:route 独占投递资格", () => {
  it("只返回 route 订阅,context 永不出现", () => {
    const list = chain(
      { threadKey: "k", subscriber: "ctx", createdAt: T0 },
      { threadKey: "k", subscriber: "own", mode: "route", createdAt: T0 },
    );
    const route = routeSubscriptions(list, "k", T0);
    expect(route.map((s) => s.subscriber)).toEqual(["own"]);
  });

  it("silent route 不直投", () => {
    const list = chain({ threadKey: "k", subscriber: "own", mode: "route", wakePolicy: "silent", createdAt: T0 });
    expect(routeSubscriptions(list, "k", T0)).toEqual([]);
  });

  it("过期 route 不直投", () => {
    const list = chain({ threadKey: "k", subscriber: "own", mode: "route", until: T0 + 10, createdAt: T0, now: T0 });
    expect(routeSubscriptions(list, "k", T0 + 10)).toEqual([]);
    expect(routeSubscriptions(list, "k", T0 + 9)).toHaveLength(1);
  });

  it("superseded route 不直投", () => {
    const list = chain(
      { threadKey: "k", subscriber: "own", mode: "route", until: T0 + 1, createdAt: T0, now: T0 },
      { threadKey: "k", subscriber: "own", mode: "route", createdAt: T0 + 10, now: T0 + 10 },
    );
    const route = routeSubscriptions(list, "k", T0 + 10);
    expect(route).toHaveLength(1);
    expect(route[0]?.generation).toBe(2);
  });

  it("空 threadKey → [] 且不改输入", () => {
    const list = chain({ threadKey: "k", subscriber: "own", mode: "route", createdAt: T0 });
    const snapshot = JSON.stringify(list);
    expect(routeSubscriptions(list, "", T0)).toEqual([]);
    expect(JSON.stringify(list)).toBe(snapshot);
  });
});

describe("contextFanout:与路由结果彻底分离", () => {
  it("含 silent 与 digest 的 context 全部扇出", () => {
    const list = chain(
      { threadKey: "k", subscriber: "c1", wakePolicy: "silent", createdAt: T0 },
      { threadKey: "k", subscriber: "c2", wakePolicy: "digest", createdAt: T0 },
    );
    expect(contextFanout(list, "k", T0).map((s) => s.subscriber)).toEqual(["c1", "c2"]);
  });

  it("route 订阅不进上下文扇出", () => {
    const list = chain({ threadKey: "k", subscriber: "own", mode: "route", createdAt: T0 });
    expect(contextFanout(list, "k", T0)).toEqual([]);
  });

  it("过期 context 不再扇出", () => {
    const list = chain({ threadKey: "k", subscriber: "c1", until: T0 + 5, createdAt: T0, now: T0 });
    expect(contextFanout(list, "k", T0 + 5)).toEqual([]);
    expect(contextFanout(list, "k", T0 + 4)).toHaveLength(1);
  });

  it("同一张表里 route 与扇出结果不相交", () => {
    const list = chain(
      { threadKey: "k", subscriber: "c1", createdAt: T0 },
      { threadKey: "k", subscriber: "own", mode: "route", createdAt: T0 },
    );
    const routeIds = new Set(routeSubscriptions(list, "k", T0).map((s) => s.id));
    for (const sub of contextFanout(list, "k", T0)) expect(routeIds.has(sub.id)).toBe(false);
  });
});

describe("decideSubscription:routed > context-only > denied", () => {
  it("有 route → routed 且带命中 id", () => {
    const list = chain({ threadKey: "k", subscriber: "own", mode: "route", createdAt: T0 });
    const d = decideSubscription(list, "k", T0);
    expect(d.decision).toBe("routed");
    expect(d.code).toBe(THREAD_SUB_OK);
    expect(d.subscriptionIds).toEqual([list[0]?.id]);
  });

  it("只有 context → context-only(CONTEXT_ONLY 码)", () => {
    const list = chain({ threadKey: "k", subscriber: "c1", createdAt: T0 });
    const d = decideSubscription(list, "k", T0);
    expect(d.decision).toBe("context-only");
    expect(d.code).toBe(THREAD_SUB_CONTEXT_ONLY);
    expect(d.subscriptionIds).toHaveLength(1);
  });

  it("无订阅 → denied(ROUTE_DENIED 码)", () => {
    const d = decideSubscription([], "k", T0);
    expect(d.decision).toBe("denied");
    expect(d.code).toBe(THREAD_SUB_ROUTE_DENIED);
    expect(d.subscriptionIds).toEqual([]);
  });

  it("只有 silent route → denied(沉睡不直投)", () => {
    const list = chain({ threadKey: "k", subscriber: "own", mode: "route", wakePolicy: "silent", createdAt: T0 });
    expect(decideSubscription(list, "k", T0).decision).toBe("denied");
  });
});

describe("recordDecision:决策史与上限", () => {
  it("写到该 threadKey 的所有未取代订阅,其他 threadKey 不受影响", () => {
    const list = chain(
      { threadKey: "k", subscriber: "c1", createdAt: T0 },
      { threadKey: "k", subscriber: "own", mode: "route", createdAt: T0 },
      { threadKey: "other", subscriber: "x", createdAt: T0 },
    );
    const r = recordDecision(list, { threadKey: "k", triggerId: "t1", decision: "context-only", reason: "no-route", at: T0 + 1 });
    expect(r.ok).toBe(true);
    expect(r.recorded).toBe(2);
    expect(r.list[0]?.decisionHistory).toHaveLength(1);
    expect(r.list[1]?.decisionHistory[0]).toMatchObject({ triggerId: "t1", decision: "context-only", reason: "no-route", at: T0 + 1 });
    expect(r.list[2]?.decisionHistory).toEqual([]);
  });

  it("上限 50 条:保留最近,最旧被挤出", () => {
    let list = chain({ threadKey: "k", subscriber: "c1", createdAt: T0 });
    for (let i = 1; i <= 60; i += 1) {
      list = recordDecision(list, { threadKey: "k", triggerId: `t-${i}`, decision: "routed", at: T0 + i }).list;
    }
    const hist = list[0]?.decisionHistory ?? [];
    expect(hist).toHaveLength(DECISION_HISTORY_LIMIT);
    expect(hist[0]?.triggerId).toBe("t-11");
    expect(hist.at(-1)?.triggerId).toBe("t-60");
  });

  it("非法 decision / 缺 triggerId → INVALID 且表不变", () => {
    const list = chain({ threadKey: "k", subscriber: "c1", createdAt: T0 });
    expect(recordDecision(list, { threadKey: "k", triggerId: "t1", decision: "maybe" as never }).code).toBe(THREAD_SUB_INVALID);
    expect(recordDecision(list, { threadKey: "k", triggerId: "", decision: "denied" }).code).toBe(THREAD_SUB_INVALID);
    expect(list[0]?.decisionHistory).toEqual([]);
  });

  it("superseded 订阅不再收新决策", () => {
    const list = chain(
      { threadKey: "k", subscriber: "a", until: T0 + 1, createdAt: T0, now: T0 },
      { threadKey: "k", subscriber: "a", createdAt: T0 + 10, now: T0 + 10 },
    );
    const r = recordDecision(list, { threadKey: "k", triggerId: "t9", decision: "denied", at: T0 + 20 });
    expect(r.recorded).toBe(1);
    expect(r.list[0]?.decisionHistory).toEqual([]);
    expect(r.list[1]?.decisionHistory).toHaveLength(1);
  });

  it("不可变:原表决策史不被就地追加", () => {
    const list = chain({ threadKey: "k", subscriber: "c1", createdAt: T0 });
    recordDecision(list, { threadKey: "k", triggerId: "t1", decision: "denied", at: T0 });
    expect(list[0]?.decisionHistory).toEqual([]);
  });
});

describe("expireSubscriptions:只标记不删", () => {
  it("按 until 标记 expired/expiredAt,条目数不变", () => {
    const list = chain(
      { threadKey: "k", subscriber: "c1", until: T0 + 10, createdAt: T0, now: T0 },
      { threadKey: "k", subscriber: "c2", createdAt: T0 },
    );
    const r = expireSubscriptions(list, T0 + 10);
    expect(r.code).toBe(THREAD_SUB_EXPIRED);
    expect(r.expiredCount).toBe(1);
    expect(r.list).toHaveLength(2);
    expect(r.list[0]?.expired).toBe(true);
    expect(r.list[0]?.expiredAt).toBe(T0 + 10);
    expect(r.list[1]?.expired).toBeUndefined();
  });

  it("幂等:第二次 expiredCount=0 且 code=OK", () => {
    const list = chain({ threadKey: "k", subscriber: "c1", until: T0 + 10, createdAt: T0, now: T0 });
    const once = expireSubscriptions(list, T0 + 10);
    const twice = expireSubscriptions(once.list, T0 + 10);
    expect(twice.code).toBe(THREAD_SUB_OK);
    expect(twice.expiredCount).toBe(0);
    expect(twice.list[0]?.expiredAt).toBe(T0 + 10);
  });

  it("未到 until 不标记", () => {
    const list = chain({ threadKey: "k", subscriber: "c1", until: T0 + 10, createdAt: T0, now: T0 });
    const r = expireSubscriptions(list, T0 + 9);
    expect(r.expiredCount).toBe(0);
    expect(r.list[0]?.expired).toBeUndefined();
  });
});

describe("wakePlan:immediate / digest / silent", () => {
  it("immediate → now", () => {
    const sub = make();
    expect(wakePlan(sub, T0)).toEqual({ kind: "immediate", at: T0 });
  });

  it("digest 缺省 → 下一整点", () => {
    const sub = make({ wakePolicy: "digest" });
    const plan = wakePlan(sub, T0);
    expect(plan.kind).toBe("digest");
    expect(plan.at).toBeGreaterThan(T0);
 // T0 距上一整点 800_000ms,故距下一整点 2_800_000ms(独立算数,不复用实现公式)
    expect((plan.kind === "digest" ? plan.at : 0) - T0).toBe(2_800_000);
  });

  it("digest 配 interval → since + k*interval 的下一格", () => {
    const sub = make({ wakePolicy: "digest", digestIntervalMs: 10_000, since: 1_000, createdAt: 1_000 });
    expect(wakePlan(sub, 25_000)).toEqual({ kind: "digest", at: 31_000 });
  });

  it("silent → none", () => {
    expect(wakePlan(make({ wakePolicy: "silent" }), T0)).toEqual({ kind: "none" });
  });

  it("已过期 → none", () => {
    const sub = make({ until: T0 + 10, now: T0 });
    expect(wakePlan(sub, T0 + 10)).toEqual({ kind: "none" });
  });
});

describe("不可变与确定性", () => {
  it("冻结输入不抛,且输出是新引用", () => {
    const sub = Object.freeze({
      ...make(),
      decisionHistory: Object.freeze([]) as never,
    }) as ThreadSubscription;
    const frozen = Object.freeze([sub]) as readonly ThreadSubscription[];
    expect(() => addSubscription(frozen, { threadKey: "k", subscriber: "b", createdAt: T0 })).not.toThrow();
    const cloned = cloneSubscriptions(frozen);
    expect(cloned).not.toBe(frozen);
    expect(cloned[0]).not.toBe(sub);
  });

  it("同输入两次输出完全一致(确定性)", () => {
    const input: AddSubscriptionInput = { threadKey: "k", subscriber: "a", mode: "route", createdAt: T0, wakePolicy: "digest" };
    const a = addSubscription([], input);
    const b = addSubscription([], input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(routeSubscriptions(a.list, "k", T0))).toBe(JSON.stringify(routeSubscriptions(b.list, "k", T0)));
  });
});

describe("summarizeThread:审计快照", () => {
  it("汇总 route/context 两侧与决策", () => {
    const list = chain(
      { threadKey: "k", subscriber: "c1", createdAt: T0 },
      { threadKey: "k", subscriber: "own", mode: "route", wakePolicy: "silent", createdAt: T0 },
    );
    const s = summarizeThread(list, "k", T0);
    expect(s.threadKey).toBe("k");
    expect(s.routeIds).toEqual([]);
    expect(s.contextIds).toHaveLength(1);
    expect(s.decision.decision).toBe("context-only");
  });
});
