/**
 * thread 订阅模型(纯逻辑,零 IO,2026-11 #186)。
 * 为什么订阅必须分 context / route:
 * 旧实现把「订阅一个 thread」压成一个布尔量(该 thread 是否有活 Ticket),于是「想跟读上下文」
 * 和「允许把该 thread 的 Trigger 直投 owner worker」被同一张表表达——任何人只要挂上跟读,
 * 就顺带拿到了投递资格。这是最容易被当成便利的越权面:可见性 ≠ 授权。
 * 本模块把两件事拆开:
 * - mode=context:只做上下文扇出(把该 thread 的决策注入看的人),**永不进路由结果**;
 * - mode=route:才是投递资格,router gate 只在「route + 未过期 + 非沉睡(silent)」时直通。
 * 依赖纪律:零 import(不读文件/环境/网络/系统时间),所有导出函数不 throw;
 * 入参非法折叠成 INVALID,过期折叠成 EXPIRED,重复折叠成 DUPLICATE,从不物理删订阅。
 * 全部函数不可变:入参数组与元素一律不写,返回新数组;同输入同输出(确定性)。
 */

/** 订阅账本 schema 版本:字段语义变化时递增。 */
export const THREAD_SUB_VERSION = 1;

/** 稳定码:订阅判定的全部结论(字符串常量,便于落盘与断言)。 */
export const THREAD_SUB_OK = "OK" as const;
export const THREAD_SUB_INVALID = "INVALID" as const;
export const THREAD_SUB_EXPIRED = "EXPIRED" as const;
export const THREAD_SUB_DUPLICATE = "DUPLICATE" as const;
export const THREAD_SUB_ROUTE_DENIED = "ROUTE_DENIED" as const;
export const THREAD_SUB_CONTEXT_ONLY = "CONTEXT_ONLY" as const;

/** 全部稳定码(固定顺序)。 */
export const THREAD_SUB_CODES = [
  THREAD_SUB_OK,
  THREAD_SUB_INVALID,
  THREAD_SUB_EXPIRED,
  THREAD_SUB_DUPLICATE,
  THREAD_SUB_ROUTE_DENIED,
  THREAD_SUB_CONTEXT_ONLY,
] as const;

export type ThreadSubCode = (typeof THREAD_SUB_CODES)[number];

/** 订阅模式:context=只进上下文;route=可直投 owner worker。 */
export const SUB_MODES = ["context", "route"] as const;
export type SubMode = (typeof SUB_MODES)[number];

/** 唤醒策略:immediate=立刻;digest=下一整点(或 since+间隔);silent=沉睡(不唤醒也不直投)。 */
export const WAKE_POLICIES = ["immediate", "digest", "silent"] as const;
export type WakePolicy = (typeof WAKE_POLICIES)[number];

/** 单次决策结论(订阅视角)。 */
export const DECISION_KINDS = ["routed", "context-only", "denied"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** 每订阅决策史上限(保留最近 N 条,供审计回答「当时为什么投/不投」)。 */
export const DECISION_HISTORY_LIMIT = 50;

/** digest 缺省间隔 = 一整点。 */
export const DIGEST_HOUR_MS = 3_600_000;

/** 一条订阅决策留痕。 */
export interface SubDecision {
  triggerId: string;
  decision: DecisionKind;
  reason?: string;
  at: number;
}

/** 一条 thread 订阅。 */
export interface ThreadSubscription {
  id: string;
 /** 订阅的线程键(router 的 threadKey,如 session:s1)。 */
  threadKey: string;
 /** 订阅者(identity / agent 名)。 */
  subscriber: string;
  mode: SubMode;
  wakePolicy: WakePolicy;
 /** 生效起点(epoch ms)。 */
  since: number;
 /** 过期时刻(epoch ms;缺省=长期)。 */
  until?: number;
  createdAt: number;
 /** 同键代数:新订阅 generation = 同键最大 generation + 1。 */
  generation: number;
 /** digest 唤醒间隔(缺省整点;仅 wakePolicy=digest 时有意义)。 */
  digestIntervalMs?: number;
 /** 已被同键新代取代:保留审计,不再路由/扇出(不物理删)。 */
  superseded?: boolean;
 /** 已过期(逻辑标记,不物理删)。 */
  expired?: boolean;
 /** 过期判定时刻(审计用)。 */
  expiredAt?: number;
 /** 该订阅自己的决策史(上限 DECISION_HISTORY_LIMIT)。 */
  decisionHistory: SubDecision[];
}

/** addSubscription 入参(除 threadKey/subscriber 外都可省)。 */
export interface AddSubscriptionInput {
  id?: string;
  threadKey: string;
  subscriber: string;
  mode?: SubMode;
  wakePolicy?: WakePolicy;
  since?: number;
  until?: number;
  createdAt?: number;
 /** 判定「是否已过期」的时刻(缺省回退 since / createdAt;纯函数不读系统时间)。 */
  now?: number;
  digestIntervalMs?: number;
}

/** recordDecision 入参。 */
export interface RecordDecisionInput {
  threadKey: string;
  triggerId: string;
  decision: DecisionKind;
  reason?: string;
  at?: number;
}

/** 变更类函数的统一返回(不可变:list 总是「新的一版」,不含就地修改)。 */
export interface SubMutationResult {
  ok: boolean;
  code: ThreadSubCode;
  list: ThreadSubscription[];
 /** 本次新增/命中的订阅(DUPLICATE 时=既有那条)。 */
  subscription?: ThreadSubscription;
 /** 本次写入的决策条数(recordDecision 用)。 */
  recorded?: number;
 /** 本次标记过期的订阅数(expireSubscriptions 用)。 */
  expiredCount?: number;
  reason?: string;
}

/** 唤醒计划:immediate/digest 带可执行时刻,silent(或已过期/已取代)=none。 */
export type WakePlan =
  | { kind: "immediate"; at: number }
  | { kind: "digest"; at: number }
  | { kind: "none" };

/** 订阅侧决策结论(router gate 直接映射成 GateResult.subscriptionDecision)。 */
export interface SubscriptionDecision {
  decision: DecisionKind;
  code: ThreadSubCode;
 /** 命中的订阅 id:routed=可直投的 route 订阅;context-only=上下文订阅;denied=空。 */
  subscriptionIds: string[];
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const cloneDecision = (d: SubDecision): SubDecision => ({
  triggerId: d.triggerId,
  decision: d.decision,
  ...(d.reason !== undefined ? { reason: d.reason } : {}),
  at: d.at,
});

const cloneSubscription = (s: ThreadSubscription): ThreadSubscription => ({
  ...s,
  decisionHistory: s.decisionHistory.map(cloneDecision),
});

/** 严格深拷贝(供调用方拿独立副本;不参与判定逻辑)。 */
export function cloneSubscriptions(list: readonly ThreadSubscription[]): ThreadSubscription[] {
  return (list ?? []).map(cloneSubscription);
}

/**
 * 过期判定:显式 expired 标记,或 until 已到。
 * 只看订阅自身与传入时刻 —— 纯函数不读系统时间,now 由调用方给。
 */
export function isThreadSubExpired(sub: ThreadSubscription, now: number): boolean {
  if (sub === null || typeof sub !== "object") return true;
  if (sub.expired === true) return true;
  const at = isFiniteNumber(now) ? now : 0;
  return isFiniteNumber(sub.until) && sub.until <= at;
}

/** 仍可用 = 未被取代且未过期。 */
const isLive = (sub: ThreadSubscription, now: number): boolean => sub.superseded !== true && !isThreadSubExpired(sub, now);

const sameKey = (a: ThreadSubscription, threadKey: string, subscriber: string, mode: SubMode): boolean =>
  a.threadKey === threadKey && a.subscriber === subscriber && a.mode === mode;

/**
 * 新增订阅。
 * - threadKey/subscriber 必填,否则 INVALID(不改表);
 * - mode 缺省 context(缺省必须是「不给权限」的那一侧);
 * - until<=now → EXPIRED,不加入;
 * - 同 (threadKey,subscriber,mode) 仍有活订阅 → DUPLICATE(幂等返回既有那条);
 * - 否则 generation = 同键最大 generation+1,同键旧代标记 superseded(不物理删)。
 */
export function addSubscription(
  list: readonly ThreadSubscription[],
  input: AddSubscriptionInput): SubMutationResult {
  const base = list ?? [];
  if (input === null || typeof input !== "object") {
    return { ok: false, code: THREAD_SUB_INVALID, list: [...base], reason: "input" };
  }
  if (!isNonEmptyString(input.threadKey)) {
    return { ok: false, code: THREAD_SUB_INVALID, list: [...base], reason: "threadKey" };
  }
  if (!isNonEmptyString(input.subscriber)) {
    return { ok: false, code: THREAD_SUB_INVALID, list: [...base], reason: "subscriber" };
  }
  const mode = input.mode ?? "context";
  if (!SUB_MODES.includes(mode)) {
    return { ok: false, code: THREAD_SUB_INVALID, list: [...base], reason: "mode" };
  }
  const wakePolicy = input.wakePolicy ?? "immediate";
  if (!WAKE_POLICIES.includes(wakePolicy)) {
    return { ok: false, code: THREAD_SUB_INVALID, list: [...base], reason: "wakePolicy" };
  }
  const createdAt = isFiniteNumber(input.createdAt) ? input.createdAt : 0;
  const since = isFiniteNumber(input.since) ? input.since : createdAt;
  const now = isFiniteNumber(input.now) ? input.now : since;
  if (isFiniteNumber(input.until) && input.until <= now) {
 // 出生即过期:直接拒收,不制造「一落地就是死账」的订阅。
    return { ok: false, code: THREAD_SUB_EXPIRED, list: [...base], reason: "until" };
  }

  const same = base.filter((s) => sameKey(s, input.threadKey, input.subscriber, mode));
  const active = same.find((s) => isLive(s, now));
  if (active !== undefined) {
    return { ok: true, code: THREAD_SUB_DUPLICATE, list: [...base], subscription: active };
  }
  const generation = same.reduce((max, s) => Math.max(max, isFiniteNumber(s.generation) ? s.generation : 0), 0) + 1;
  const sub: ThreadSubscription = {
    id: isNonEmptyString(input.id) ? input.id : `${input.threadKey}:${input.subscriber}:${mode}:g${generation}`,
    threadKey: input.threadKey,
    subscriber: input.subscriber,
    mode,
    wakePolicy,
    since,
    ...(isFiniteNumber(input.until) ? { until: input.until } : {}),
    createdAt,
    generation,
    ...(isFiniteNumber(input.digestIntervalMs) && input.digestIntervalMs > 0 ? { digestIntervalMs: input.digestIntervalMs } : {}),
    decisionHistory: [],
  };
 // 旧代只标 superseded:决策史留着,才能回答「当时是谁在被直投」。
  const next = base.map((s) =>
    sameKey(s, input.threadKey, input.subscriber, mode) && s.superseded !== true
      ? { ...cloneSubscription(s), superseded: true }
      : cloneSubscription(s),
  );
  next.push(sub);
  return { ok: true, code: THREAD_SUB_OK, list: next, subscription: sub };
}

/**
 * 路由结果:**只有** mode=route、未过期、未被取代、且非沉睡(silent)的订阅。
 * context 订阅永不出现在这里 —— 这是「跟读不等于接管」的硬边界。
 */
export function routeSubscriptions(
  list: readonly ThreadSubscription[],
  threadKey: string,
  now: number): ThreadSubscription[] {
  if (!isNonEmptyString(threadKey)) return [];
  const at = isFiniteNumber(now) ? now : 0;
  return (list ?? []).filter(
    (s) => s !== null && typeof s === "object"
      && s.threadKey === threadKey
      && s.mode === "route"
      && s.wakePolicy !== "silent"
      && isLive(s, at),
  );
}

/**
 * 上下文扇出:该 thread 所有 context 订阅(含 silent,沉睡只是不唤醒,不是不可见)。
 * 与路由结果彻底分离:拿到扇出结果不代表拿到投递资格。
 */
export function contextFanout(
  list: readonly ThreadSubscription[],
  threadKey: string,
  now: number): ThreadSubscription[] {
  if (!isNonEmptyString(threadKey)) return [];
  const at = isFiniteNumber(now) ? now : 0;
  return (list ?? []).filter(
    (s) => s !== null && typeof s === "object"
      && s.threadKey === threadKey
      && s.mode === "context"
      && isLive(s, at),
  );
}

/** 订阅侧一次性决策:routed > context-only > denied(供 gate 直接消费)。 */
export function decideSubscription(
  list: readonly ThreadSubscription[],
  threadKey: string,
  now: number): SubscriptionDecision {
  const route = routeSubscriptions(list, threadKey, now);
  if (route.length > 0) {
    return { decision: "routed", code: THREAD_SUB_OK, subscriptionIds: route.map((s) => s.id) };
  }
  const ctx = contextFanout(list, threadKey, now);
  if (ctx.length > 0) {
    return { decision: "context-only", code: THREAD_SUB_CONTEXT_ONLY, subscriptionIds: ctx.map((s) => s.id) };
  }
  return { decision: "denied", code: THREAD_SUB_ROUTE_DENIED, subscriptionIds: [] };
}

/**
 * 记录一次决策:写到该 threadKey 下所有未取代订阅的 decisionHistory(每订阅上限 50)。
 * 未取代的过期订阅也记账 —— 它的历史属于它自己的生命周期。
 */
export function recordDecision(
  list: readonly ThreadSubscription[],
  input: RecordDecisionInput): SubMutationResult {
  const base = list ?? [];
  const invalid = (reason: string): SubMutationResult => ({ ok: false, code: THREAD_SUB_INVALID, list: [...base], recorded: 0, reason });
  if (input === null || typeof input !== "object") return invalid("input");
  if (!isNonEmptyString(input.threadKey)) return invalid("threadKey");
  if (!isNonEmptyString(input.triggerId)) return invalid("triggerId");
  if (!DECISION_KINDS.includes(input.decision)) return invalid("decision");
  const at = isFiniteNumber(input.at) ? input.at : 0;
  const entry: SubDecision = {
    triggerId: input.triggerId,
    decision: input.decision,
    ...(isNonEmptyString(input.reason) ? { reason: input.reason } : {}),
    at,
  };
  let recorded = 0;
  const next = base.map((s) => {
    if (s === null || typeof s !== "object" || s.threadKey !== input.threadKey || s.superseded === true) return cloneSubscription(s);
    recorded += 1;
    const history = [...s.decisionHistory.map(cloneDecision), entry];
    return { ...cloneSubscription(s), decisionHistory: history.slice(-DECISION_HISTORY_LIMIT) };
  });
  return { ok: true, code: THREAD_SUB_OK, list: next, recorded };
}

/** 过期只做逻辑标记(until<=now 或已标记),不物理删;幂等:再跑一次 expiredCount=0。 */
export function expireSubscriptions(
  list: readonly ThreadSubscription[],
  now: number): SubMutationResult {
  const base = list ?? [];
  const at = isFiniteNumber(now) ? now : 0;
  let expiredCount = 0;
  const next = base.map((s) => {
    if (s === null || typeof s !== "object") return cloneSubscription(s);
    if (s.expired === true) return cloneSubscription(s);
    if (!(isFiniteNumber(s.until) && s.until <= at)) return cloneSubscription(s);
    expiredCount += 1;
    return { ...cloneSubscription(s), expired: true, expiredAt: at };
  });
  return {
    ok: true,
    code: expiredCount > 0 ? THREAD_SUB_EXPIRED : THREAD_SUB_OK,
    list: next,
    expiredCount,
  };
}

/**
 * 唤醒计划:
 * - immediate → now;
 * - digest → 下一整点(未配 digestIntervalMs),或 since + k*interval 的下一格;
 * - silent → none;已过期/已取代 → none(沉睡与失效都不该被唤醒)。
 */
export function wakePlan(sub: ThreadSubscription, now: number): WakePlan {
  if (sub === null || typeof sub !== "object") return { kind: "none" };
  const at = isFiniteNumber(now) ? now : 0;
  if (sub.superseded === true || isThreadSubExpired(sub, at)) return { kind: "none" };
  if (sub.wakePolicy === "silent") return { kind: "none" };
  if (sub.wakePolicy === "digest") {
    const interval = isFiniteNumber(sub.digestIntervalMs) && sub.digestIntervalMs > 0 ? sub.digestIntervalMs : DIGEST_HOUR_MS;
    if (interval === DIGEST_HOUR_MS) {
 // 整点对齐:与 since 无关,便于运维按整点批量投递。
      return { kind: "digest", at: (Math.floor(at / DIGEST_HOUR_MS) + 1) * DIGEST_HOUR_MS };
    }
    const since = isFiniteNumber(sub.since) ? sub.since : 0;
    const steps = Math.floor((at - since) / interval) + 1;
    return { kind: "digest", at: since + Math.max(1, steps) * interval };
  }
  return { kind: "immediate", at };
}

/** 订阅表快照(审计/调试用):按 threadKey 汇总 route 与 context 两侧。 */
export function summarizeThread(
  list: readonly ThreadSubscription[],
  threadKey: string,
  now: number): { threadKey: string; decision: SubscriptionDecision; routeIds: string[]; contextIds: string[] } {
  const route = routeSubscriptions(list, threadKey, now);
  const ctx = contextFanout(list, threadKey, now);
  return {
    threadKey,
    decision: decideSubscription(list, threadKey, now),
    routeIds: route.map((s) => s.id),
    contextIds: ctx.map((s) => s.id),
  };
}
