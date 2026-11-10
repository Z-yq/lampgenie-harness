/**
 * RSI #224 熔断器(Circuit Breaker,纯逻辑零 IO)。
 *
 * 为什么需要熔断器:自我改进循环(RSI)能改工具/提示/图谱,但「连续变差」往往不是单点事故,
 * 而是方向性错误(假设错、评测口径漂移、上下文被污染)。这时最贵的动作不是继续试,而是**停下**:
 * 暂停夜间改进与实验投放、把已投放实验隔离回滚、用基线还原现场。本模块把这套判断做成纯函数:
 * - evaluateBreaker:两组硬信号给出「该不该停」——末尾连续负收益 streak(够长即停)+ 守卫指标越界
 *   (direction 是「好方向」:increase 越高越好 → value<threshold 越界;decrease 越低越好 → value>threshold 越界)。
 *   码表顺序固定(守卫在前、streak 在后),便于自动化按码断言。
 * - pause / resume:暂停与恢复都要留痕(by / reason / at),恢复只接受人类(human),代理不可自解;
 *   纯函数产新 state,入参 state 不回写。
 * - isBlocked:暂停范围(all / nightly / experiments / injection)到动作的放行矩阵;observe 恒放行
 *   (只读观测永远不该被熔断挡住,否则事故期间失去眼睛)。
 * - takeBaseline / diffBaselines / planRollback / verifyRollback:基线快照(稳定 hash)+ 差异 +
 *   固定顺序的回滚计划(隔离实验 → 还原五个面 → 校验基线)。回滚计划不执行、只描述,执行由上层负责。
 *
 * 依赖纪律:只 import node:crypto(基线 hash);不读写文件/网络/环境,不引 agent loop 与 gateway。
 * canonical JSON 内联一份(键升序、数组保序、undefined 键省略),与 experiment-ledger 的 canonicalJSON 同语义;
 * 本模块不 import 台账,避免熔断器被台账改动波及。
 */

import { createHash } from "node:crypto";

/** 熔断器 schema 版本:字段语义变化时递增,读取方据此迁移。 */
export const RSI_BREAKER_VERSION = 1;

/** 暂停范围:all(全局停) / nightly(夜间改进) / experiments(实验投放) / injection(注入面)。 */
export type BreakerScope = "all" | "nightly" | "experiments" | "injection";

/** 全部合法范围(固定顺序,用于校验与输出)。 */
export const RSI_SCOPES = ["all", "nightly", "experiments", "injection"] as const;

/** 触发者:手动 / 连续负收益自停 / 守卫越界自停 / 人工报告触发。 */
export type BreakerTrigger = "manual" | "auto-negative-streak" | "auto-guardrail" | "manual-report";

/** 全部合法触发者(固定顺序)。 */
export const RSI_TRIGGERS = ["manual", "auto-negative-streak", "auto-guardrail", "manual-report"] as const;

/** 熔断状态:唯一可变的是上层持有它的方式,本模块只产新对象。 */
export interface BreakerState {
  paused: boolean;
  pausedAt?: string;
  reason?: string;
  scope: BreakerScope;
  trigger?: BreakerTrigger;
  by?: string;
  recoveredAt?: string;
  lastEvaluation?: unknown;
}

/**
 * 守卫指标:direction 是「好方向」——increase=越大越好,decrease=越小越好。
 * 越界 = 朝坏方向越过阈值(increase → value < threshold;decrease → value > threshold)。
 */
export interface Guardrail {
  metric: string;
  direction: "increase" | "decrease";
  threshold: number;
}

/** 熔断策略:连续负收益阈值 + 守卫指标表 + 是否只允许人类恢复。 */
export interface BreakerPolicy {
  minNegativeStreak: number;
  guardrails: Guardrail[];
  requireHumanRecovery: boolean;
}

/** 实验决策:adopt 正 / reject、rollback 负 / iterate、pending 中性(无显式 netReturn 时的归一依据)。 */
export type ExperimentDecision = "adopt" | "reject" | "iterate" | "rollback" | "pending";

/** 一条实验结局:decision 必需;netReturn 显式给定时优先(含 0);metrics 留着做守卫取数。 */
export interface ExperimentOutcome {
  id: string;
  decision: ExperimentDecision;
  netReturn?: number;
  metrics?: Record<string, number>;
}

/** 一处守卫越界:记录实际值、阈值与方向,便于回放时复算。 */
export interface Breach {
  metric: string;
  value: number;
  threshold: number;
  direction: "increase" | "decrease";
}

/** 评估结论:shouldPause=true 才带 trigger;code 顺序固定(守卫 → streak)。 */
export interface BreakerEvaluation {
  shouldPause: boolean;
  trigger?: BreakerTrigger;
  scope: BreakerScope;
  codes: string[];
  streak: number;
  breaches: Breach[];
}

/** 基线快照:五个可还原面(tools/tips/prompts/wiki/graph)的版本 + 指标 + 稳定 hash。 */
export interface BaselineSnapshot {
  id: string;
  at: string;
  label?: string;
  versions: { tools: string; tips: string; prompts: string; wiki: string; graph: string };
  metrics: Record<string, number>;
  hash: string;
}

/** 回滚步骤名:隔离实验 → 还原五个面 → 校验基线(顺序即执行顺序)。 */
export type RollbackStepName =
  | "quarantine-experiments"
  | "restore-tools"
  | "restore-tips"
  | "restore-prompts"
  | "restore-wiki"
  | "restore-graph"
  | "verify-baseline";

/** 一步回滚:step 名 + 引用(ref:实验 id 逗号串 / 版本引用 / 基线 hash)+ 说明。 */
export interface RollbackStep {
  step: RollbackStepName;
  ref: string;
  note: string;
}

/** 回滚计划:ok=false 时 steps 为空并给出码;requeueExperiments 是待重新排队的实验 id。 */
export interface RollbackPlan {
  ok: boolean;
  codes: string[];
  steps: RollbackStep[];
  requeueExperiments: string[];
}

/** 稳定码(逐个导出,便于按码断言而不是比字符串字面量)。 */
export const RSI_BREAKER_PAUSED = "RSI_BREAKER_PAUSED";
export const RSI_BREAKER_NOT_PAUSED = "RSI_BREAKER_NOT_PAUSED";
export const RSI_NEGATIVE_STREAK = "RSI_NEGATIVE_STREAK";
export const RSI_GUARDRAIL_BREACH = "RSI_GUARDRAIL_BREACH";
export const RSI_SCOPE_INVALID = "RSI_SCOPE_INVALID";
export const RSI_RESUME_NOT_HUMAN = "RSI_RESUME_NOT_HUMAN";
export const RSI_RESUME_REASON_REQUIRED = "RSI_RESUME_REASON_REQUIRED";
export const RSI_BASELINE_MISSING = "RSI_BASELINE_MISSING";
export const RSI_ROLLBACK_TARGET_MISMATCH = "RSI_ROLLBACK_TARGET_MISMATCH";
export const RSI_ROLLBACK_VERIFIED = "RSI_ROLLBACK_VERIFIED";

/** 码表只读对象(冻结):上游按名取码,不写字面量。 */
export const RSI_CODES = Object.freeze({
  RSI_BREAKER_PAUSED,
  RSI_BREAKER_NOT_PAUSED,
  RSI_NEGATIVE_STREAK,
  RSI_GUARDRAIL_BREACH,
  RSI_SCOPE_INVALID,
  RSI_RESUME_NOT_HUMAN,
  RSI_RESUME_REASON_REQUIRED,
  RSI_BASELINE_MISSING,
  RSI_ROLLBACK_TARGET_MISMATCH,
  RSI_ROLLBACK_VERIFIED,
} as const);

/** 五个可还原面(固定顺序即 diff/回滚顺序)。 */
const BASELINE_SURFACES = ["tools", "tips", "prompts", "wiki", "graph"] as const;

type BaselineSurface = (typeof BASELINE_SURFACES)[number];

/** 缺省策略:连续 3 个负收益即停、不配守卫、恢复必须人类。 */
export function defaultBreakerPolicy(): BreakerPolicy {
  return { minNegativeStreak: 3, guardrails: [], requireHumanRecovery: true };
}

/** 本地 canonical JSON:键升序、数组保序、undefined 键省略、非有限数按 null。 */
function canonicalJSON(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJSON(v)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(",")}}`;
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  return "null";
}

/** sha256 hex(64 位)。 */
function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function nowISO(): string {
  return new Date().toISOString();
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** 策略补全:缺省字段回落 defaultBreakerPolicy,guardrails 逐项浅拷贝(不改入参)。 */
export function resolvePolicy(p?: Partial<BreakerPolicy>): BreakerPolicy {
  const fallback = defaultBreakerPolicy();
  const minNegativeStreak =
    typeof p?.minNegativeStreak === "number" && Number.isFinite(p.minNegativeStreak)
      ? p.minNegativeStreak
      : fallback.minNegativeStreak;
  const guardrails = Array.isArray(p?.guardrails)
    ? p.guardrails.map((g) => ({ metric: g.metric, direction: g.direction, threshold: g.threshold }))
    : [];
  const requireHumanRecovery =
    typeof p?.requireHumanRecovery === "boolean" ? p.requireHumanRecovery : fallback.requireHumanRecovery;
  return { minNegativeStreak, guardrails, requireHumanRecovery };
}

/** 决策 → 归一收益(仅在后一条规则里被用到:显式 netReturn 优先)。 */
const DECISION_NET_RETURN: Record<ExperimentDecision, number> = {
  adopt: 1,
  reject: -1,
  rollback: -1,
  iterate: 0,
  pending: 0,
};

/** 单条实验的归一收益:显式 netReturn(含 0)优先;否则按 decision 映射。 */
function netReturnOf(outcome: ExperimentOutcome): number {
  if (typeof outcome?.netReturn === "number" && Number.isFinite(outcome.netReturn)) return outcome.netReturn;
  return DECISION_NET_RETURN[outcome?.decision as ExperimentDecision] ?? 0;
}

/** 末尾连续负收益个数(遇 >=0 即停)。 */
function negativeStreakOf(outcomes: ExperimentOutcome[]): number {
  let streak = 0;
  for (let i = outcomes.length - 1; i >= 0; i -= 1) {
    const item = outcomes[i];
    if (item === undefined) break;
    if (netReturnOf(item) < 0) streak += 1;
    else break;
  }
  return streak;
}

/**
 * 评估是否该熔断。纯函数:不改入参。
 * - streak >= policy.minNegativeStreak → RSI_NEGATIVE_STREAK。
 * - guardMetrics 中每个与 guardrails 同名的指标按「好方向」判越界(increase=越高越好 → value<threshold
 *   为越界;decrease=越低越好 → value>threshold 为越界),越界项全部进 breaches,
 *   只加一次 RSI_GUARDRAIL_BREACH。
 * - codes 顺序固定:RSI_GUARDRAIL_BREACH → RSI_NEGATIVE_STREAK。
 * - 不该停时 codes/breaches 归空、trigger 省略(避免下游把「看过」误读成「命中过」)。
 */
export function evaluateBreaker(
  input: { outcomes: ExperimentOutcome[]; guardMetrics?: Record<string, number> },
  policy?: Partial<BreakerPolicy>,
): BreakerEvaluation {
  const resolved = resolvePolicy(policy);
  const outcomes = Array.isArray(input?.outcomes) ? input.outcomes : [];
  const streak = negativeStreakOf(outcomes);

  const breaches: Breach[] = [];
  const guardMetrics = input?.guardMetrics;
  if (guardMetrics && typeof guardMetrics === "object") {
    for (const metric of Object.keys(guardMetrics)) {
      const value = guardMetrics[metric];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const rule = resolved.guardrails.find((g) => g.metric === metric);
      if (!rule) continue;
      // direction 表示「哪个方向是好的」:increase=越高越好 → 越界是跌到阈值之下;
      // decrease=越低越好 → 越界是涨到阈值之上。相等不算越界。
      const breached = rule.direction === "increase" ? value < rule.threshold : value > rule.threshold;
      if (breached) breaches.push({ metric, value, threshold: rule.threshold, direction: rule.direction });
    }
  }

  const streakHit = streak >= resolved.minNegativeStreak;
  const guardHit = breaches.length > 0;
  if (!streakHit && !guardHit) {
    return { shouldPause: false, scope: "all", codes: [], streak, breaches: [] };
  }

  const codes: string[] = [];
  if (guardHit) codes.push(RSI_GUARDRAIL_BREACH);
  if (streakHit) codes.push(RSI_NEGATIVE_STREAK);

  return {
    shouldPause: true,
    trigger: guardHit ? "auto-guardrail" : "auto-negative-streak",
    scope: "all",
    codes,
    streak,
    breaches,
  };
}

/**
 * 暂停:scope 非法 → RSI_SCOPE_INVALID;reason 空白 → RSI_RESUME_REASON_REQUIRED(与恢复共用「必须写理由」)。
 * 成功产新 state(paused=true / pausedAt / reason / scope / trigger / by),lastEvaluation 保留,
 * 上一轮的 recoveredAt 一并清掉(重新暂停后「已恢复」不再成立)。纯函数:入参 state 不回写。
 */
export function pause(
  state: BreakerState,
  opts: { by: string; reason: string; scope?: BreakerScope; trigger?: BreakerTrigger; at?: string },
): { ok: true; state: BreakerState } | { ok: false; codes: string[] } {
  const scope = (opts?.scope ?? "all") as BreakerScope;
  if (!(RSI_SCOPES as readonly string[]).includes(scope)) {
    return { ok: false, codes: [RSI_SCOPE_INVALID] };
  }
  if (!nonEmpty(opts?.reason)) {
    return { ok: false, codes: [RSI_RESUME_REASON_REQUIRED] };
  }
  const next: BreakerState = {
    paused: true,
    pausedAt: nonEmpty(opts.at) ? String(opts.at) : nowISO(),
    reason: opts.reason,
    scope,
    trigger: opts.trigger ?? "manual",
    by: opts.by,
  };
  if (state && state.lastEvaluation !== undefined) next.lastEvaluation = state.lastEvaluation;
  return { ok: true, state: next };
}

/**
 * 恢复:只接受 human(代理不可自己解开熔断)→ 否则 RSI_RESUME_NOT_HUMAN;
 * reason 空白 → RSI_RESUME_REASON_REQUIRED。成功产新 state(paused=false,scope 保持,
 * recoveredAt / reason / by),lastEvaluation 保留;pausedAt 与 trigger 属于上一轮的暂停事实,不带到新一轮。
 */
export function resume(
  state: BreakerState,
  opts: { by: string; kind: "human" | "agent"; reason: string; at?: string },
): { ok: true; state: BreakerState } | { ok: false; codes: string[] } {
  if (opts?.kind !== "human") {
    return { ok: false, codes: [RSI_RESUME_NOT_HUMAN] };
  }
  if (!nonEmpty(opts?.reason)) {
    return { ok: false, codes: [RSI_RESUME_REASON_REQUIRED] };
  }
  const next: BreakerState = {
    paused: false,
    recoveredAt: nonEmpty(opts.at) ? String(opts.at) : nowISO(),
    reason: opts.reason,
    scope: state?.scope ?? "all",
    by: opts.by,
  };
  if (state && state.lastEvaluation !== undefined) next.lastEvaluation = state.lastEvaluation;
  return { ok: true, state: next };
}

/**
 * 放行矩阵:observe 恒放行(事故期间也要能看);未暂停全放行;
 * 暂停时 scope="all" 全挡,否则只挡与 scope 同名的动作(experiment 对应 experiments)。
 */
export function isBlocked(state: BreakerState, action: "nightly" | "experiment" | "injection" | "observe"): boolean {
  if (action === "observe") return false;
  if (!state?.paused) return false;
  if (state.scope === "all") return true;
  const scopeForAction: BreakerScope = action === "experiment" ? "experiments" : action;
  return state.scope === scopeForAction;
}

/** 基线 hash:只吃 {versions, metrics},与 id/at/label 无关(同一现场任何时候同 hash)。 */
function baselineHashOf(versions: BaselineSnapshot["versions"], metrics: Record<string, number>): string {
  const payload = canonicalJSON({ versions, metrics });
  return `sha256:${sha256hex(payload)}`;
}

/**
 * 拍基线:metrics 缺省 {}、at 缺省当前时刻;hash 由 {versions, metrics} 确定性规范化后 sha256 得出。
 * 纯函数:不改入参(versions/metrics 浅拷贝进快照)。
 */
export function takeBaseline(input: {
  id: string;
  at?: string;
  label?: string;
  versions: BaselineSnapshot["versions"];
  metrics?: Record<string, number>;
}): BaselineSnapshot {
  const versions: BaselineSnapshot["versions"] = {
    tools: input?.versions?.tools,
    tips: input?.versions?.tips,
    prompts: input?.versions?.prompts,
    wiki: input?.versions?.wiki,
    graph: input?.versions?.graph,
  };
  const metrics: Record<string, number> = { ...(input?.metrics ?? {}) };
  const snapshot: BaselineSnapshot = {
    id: input.id,
    at: nonEmpty(input.at) ? String(input.at) : nowISO(),
    versions,
    metrics,
    hash: baselineHashOf(versions, metrics),
  };
  if (nonEmpty(input.label)) snapshot.label = String(input.label);
  return snapshot;
}

/**
 * 两份基线的差异:五个面按固定顺序(tools,tips,prompts,wiki,graph)比字符串;
 * metrics 只比两侧都存在的键(单侧新增/删除不构成回滚证据),值不同才列出,delta = to - from。
 */
export function diffBaselines(
  prev: BaselineSnapshot,
  next: BaselineSnapshot,
): { changed: BaselineSurface[]; metrics: Array<{ metric: string; from: number; to: number; delta: number }> } {
  const changed: BaselineSurface[] = [];
  for (const surface of BASELINE_SURFACES) {
    if (prev?.versions?.[surface] !== next?.versions?.[surface]) changed.push(surface);
  }
  const metrics: Array<{ metric: string; from: number; to: number; delta: number }> = [];
  const prevMetrics = prev?.metrics ?? {};
  const nextMetrics = next?.metrics ?? {};
  for (const metric of Object.keys(prevMetrics).sort()) {
    if (!Object.prototype.hasOwnProperty.call(nextMetrics, metric)) continue;
    const from = prevMetrics[metric];
    const to = nextMetrics[metric];
    if (typeof from !== "number" || typeof to !== "number") continue;
    if (from !== to) metrics.push({ metric, from, to, delta: to - from });
  }
  return { changed, metrics };
}

/**
 * 回滚计划:target 为空即无从还原 → RSI_BASELINE_MISSING(不做任何猜测性回滚)。
 * 否则固定 7 步:quarantine-experiments → restore-tools → restore-tips → restore-prompts →
 * restore-wiki → restore-graph → verify-baseline。计划只描述不执行;restore 取 target 的版本引用,
 * verify 比对 target.hash;当前快照 current 仅用于说明「从哪个现场回退」。
 */
export function planRollback(
  target: BaselineSnapshot | undefined | null,
  current: BaselineSnapshot,
  opts?: { affectedExperiments?: string[] },
): RollbackPlan {
  if (!target) {
    return { ok: false, codes: [RSI_BASELINE_MISSING], steps: [], requeueExperiments: [] };
  }
  const affected = opts?.affectedExperiments ?? [];
  const quarantineRef = affected.join(",");
  const targetLabel = nonEmpty(target.id) ? target.id : target.hash;
  const steps: RollbackStep[] = [
    {
      step: "quarantine-experiments",
      ref: quarantineRef,
      note: `隔离 ${affected.length} 个待复核实验,恢复到基线 ${targetLabel}`,
    },
    {
      step: "restore-tools",
      ref: target.versions.tools,
      note: `还原工具面到基线 ${targetLabel}(当前 ${current?.versions?.tools ?? "<缺失>"})`,
    },
    { step: "restore-tips", ref: target.versions.tips, note: `还原 tips 到基线 ${targetLabel}` },
    { step: "restore-prompts", ref: target.versions.prompts, note: `还原提示面到基线 ${targetLabel}` },
    { step: "restore-wiki", ref: target.versions.wiki, note: `还原 wiki 到基线 ${targetLabel}` },
    { step: "restore-graph", ref: target.versions.graph, note: `还原证据图谱到基线 ${targetLabel}` },
    {
      step: "verify-baseline",
      ref: target.hash,
      note: "重拍基线并比对 hash,不一致则中止并上报",
    },
  ];
  return { ok: true, codes: [], steps, requeueExperiments: [...affected] };
}

/** 回滚校验:hash 一致 → RSI_ROLLBACK_VERIFIED,否则 RSI_ROLLBACK_TARGET_MISMATCH。 */
export function verifyRollback(
  current: BaselineSnapshot,
  target: BaselineSnapshot,
): { ok: boolean; codes: string[] } {
  const same = typeof current?.hash === "string" && current.hash === target?.hash;
  return same ? { ok: true, codes: [RSI_ROLLBACK_VERIFIED] } : { ok: false, codes: [RSI_ROLLBACK_TARGET_MISMATCH] };
}
