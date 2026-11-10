/**
 * RSI #224 熔断器:streak / 守卫越界 / 码表顺序 / 放行矩阵 / 暂停恢复 / 基线 hash / 回滚计划。
 * 全纯函数直测,不触 IO(唯一例外:读源码文本断言依赖纪律)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RSI_BASELINE_MISSING,
  RSI_BREAKER_NOT_PAUSED,
  RSI_BREAKER_PAUSED,
  RSI_BREAKER_VERSION,
  RSI_CODES,
  RSI_GUARDRAIL_BREACH,
  RSI_NEGATIVE_STREAK,
  RSI_ROLLBACK_TARGET_MISMATCH,
  RSI_ROLLBACK_VERIFIED,
  RSI_RESUME_NOT_HUMAN,
  RSI_RESUME_REASON_REQUIRED,
  RSI_SCOPE_INVALID,
  defaultBreakerPolicy,
  diffBaselines,
  evaluateBreaker,
  isBlocked,
  pause,
  planRollback,
  resolvePolicy,
  resume,
  takeBaseline,
  verifyRollback,
} from "../src/agent/rsi-circuit-breaker";
import type {
  BaselineSnapshot,
  BreakerPolicy,
  BreakerScope,
  BreakerState,
  ExperimentOutcome,
} from "../src/agent/rsi-circuit-breaker";

const AT = "2026-01-01T00:00:00.000Z";

const VERSIONS: BaselineSnapshot["versions"] = {
  tools: "tools@v10",
  tips: "tips@v7",
  prompts: "prompts@v3",
  wiki: "wiki@v42",
  graph: "graph@v9",
};

function outcome(id: string, decision: ExperimentOutcome["decision"], netReturn?: number): ExperimentOutcome {
  const item: ExperimentOutcome = { id, decision };
  if (netReturn !== undefined) item.netReturn = netReturn;
  return item;
}

function negatives(n: number): ExperimentOutcome[] {
  return Array.from({ length: n }, (_, i) => outcome(`exp-${i + 1}`, "reject"));
}

function baseState(overrides: Partial<BreakerState> = {}): BreakerState {
  return { paused: false, scope: "all", ...overrides };
}

function mustOk(result: { ok: true; state: BreakerState } | { ok: false; codes: string[] }): BreakerState {
  if (!result.ok) throw new Error(`expected ok, got codes: ${result.codes.join(",")}`);
  return result.state;
}

describe("evaluateBreaker:负收益 streak", () => {
  it("连续 3 个负收益 → 暂停,码/trigger/streak 逐字", () => {
    const result = evaluateBreaker({ outcomes: negatives(3) });
    expect(result.shouldPause).toBe(true);
    expect(result.codes).toEqual([RSI_NEGATIVE_STREAK]);
    expect(result.trigger).toBe("auto-negative-streak");
    expect(result.streak).toBe(3);
    expect(result.scope).toBe("all");
    expect(result.breaches).toEqual([]);
  });

  it("连续 2 个负收益不暂停,codes/breaches 为空且 trigger 省略", () => {
    const result = evaluateBreaker({ outcomes: negatives(2) });
    expect(result.shouldPause).toBe(false);
    expect(result.codes).toEqual([]);
    expect(result.streak).toBe(2);
    expect(result.breaches).toEqual([]);
    expect("trigger" in result).toBe(false);
  });

  it("末尾转正后 streak 清零", () => {
    const result = evaluateBreaker({
      outcomes: [outcome("a", "reject"), outcome("b", "reject"), outcome("c", "reject"), outcome("d", "adopt")],
    });
    expect(result.streak).toBe(0);
    expect(result.shouldPause).toBe(false);
    expect(result.codes).toEqual([]);
  });

  it("空 outcomes → streak 0 且不暂停", () => {
    const result = evaluateBreaker({ outcomes: [] });
    expect(result).toEqual({ shouldPause: false, scope: "all", codes: [], streak: 0, breaches: [] });
  });

  it("iterate/pending 记为 0,打断 streak", () => {
    const result = evaluateBreaker({
      outcomes: [outcome("a", "reject"), outcome("b", "reject"), outcome("c", "pending")],
    });
    expect(result.streak).toBe(0);
    expect(result.shouldPause).toBe(false);
  });

  it("rollback 与 reject 同为 -1,混排也累计 streak", () => {
    const result = evaluateBreaker({
      outcomes: [outcome("a", "reject"), outcome("b", "rollback"), outcome("c", "reject")],
    });
    expect(result.streak).toBe(3);
    expect(result.codes).toEqual([RSI_NEGATIVE_STREAK]);
  });
});

describe("evaluateBreaker:netReturn 归一", () => {
  it("显式 netReturn 优先:adopt + netReturn 0 不算负", () => {
    const result = evaluateBreaker({ outcomes: [outcome("a", "adopt", 0)] });
    expect(result.streak).toBe(0);
    expect(result.shouldPause).toBe(false);
  });

  it("显式 netReturn 优先:reject + netReturn 0 不算负,三个也不暂停", () => {
    const result = evaluateBreaker({
      outcomes: [outcome("a", "reject", 0), outcome("b", "reject", 0), outcome("c", "reject", 0)],
    });
    expect(result.streak).toBe(0);
    expect(result.shouldPause).toBe(false);
  });

  it("显式 netReturn 优先:adopt + netReturn -0.5 记为负", () => {
    const result = evaluateBreaker({
      outcomes: [outcome("a", "adopt", -0.5), outcome("b", "adopt", -0.1), outcome("c", "adopt", -2)],
    });
    expect(result.streak).toBe(3);
    expect(result.codes).toEqual([RSI_NEGATIVE_STREAK]);
  });

  it("正 netReturn 打断 streak(即使 decision 是 reject)", () => {
    const result = evaluateBreaker({
      outcomes: [outcome("a", "reject"), outcome("b", "reject"), outcome("c", "reject", 0.2)],
    });
    expect(result.streak).toBe(0);
    expect(result.shouldPause).toBe(false);
  });

  it("自定义 minNegativeStreak=5:4 负不停、5 负才停", () => {
    const policy: Partial<BreakerPolicy> = { minNegativeStreak: 5 };
    expect(evaluateBreaker({ outcomes: negatives(4) }, policy).shouldPause).toBe(false);
    const five = evaluateBreaker({ outcomes: negatives(5) }, policy);
    expect(five.shouldPause).toBe(true);
    expect(five.streak).toBe(5);
    expect(five.codes).toEqual([RSI_NEGATIVE_STREAK]);
  });
});

describe("evaluateBreaker:守卫指标", () => {
  it("increase 方向(越高越好):跌破阈值才是越界 → 码 + trigger + breaches 逐字", () => {
    const result = evaluateBreaker(
      { outcomes: [], guardMetrics: { passRate: 0.7 } },
      { guardrails: [{ metric: "passRate", direction: "increase", threshold: 0.8 }] },
    );
    expect(result.shouldPause).toBe(true);
    expect(result.codes).toEqual([RSI_GUARDRAIL_BREACH]);
    expect(result.trigger).toBe("auto-guardrail");
    expect(result.breaches).toEqual([
      { metric: "passRate", value: 0.7, threshold: 0.8, direction: "increase" },
    ]);
  });

  it("increase 方向高于阈值 = 改善,不熔断", () => {
    const policy: Partial<BreakerPolicy> = {
      guardrails: [{ metric: "passRate", direction: "increase", threshold: 0.8 }],
    };
    const better = evaluateBreaker({ outcomes: [], guardMetrics: { passRate: 0.95 } }, policy);
    expect(better.shouldPause).toBe(false);
    expect(better.codes).toEqual([]);
    expect(better.breaches).toEqual([]);
  });

  it("increase 方向等于阈值不算越界", () => {
    const result = evaluateBreaker(
      { outcomes: [], guardMetrics: { passRate: 0.8 } },
      { guardrails: [{ metric: "passRate", direction: "increase", threshold: 0.8 }] },
    );
    expect(result.shouldPause).toBe(false);
    expect(result.breaches).toEqual([]);
  });

  it("decrease 方向(越低越好):涨过阈值才是越界", () => {
    const result = evaluateBreaker(
      { outcomes: [], guardMetrics: { errorRate: 0.2 } },
      { guardrails: [{ metric: "errorRate", direction: "decrease", threshold: 0.1 }] },
    );
    expect(result.shouldPause).toBe(true);
    expect(result.codes).toEqual([RSI_GUARDRAIL_BREACH]);
    expect(result.breaches).toEqual([
      { metric: "errorRate", value: 0.2, threshold: 0.1, direction: "decrease" },
    ]);
  });

  it("decrease 方向低于阈值 = 改善,不熔断", () => {
    const policy: Partial<BreakerPolicy> = {
      guardrails: [{ metric: "errorRate", direction: "decrease", threshold: 0.1 }],
    };
    const better = evaluateBreaker({ outcomes: [], guardMetrics: { errorRate: 0.05 } }, policy);
    expect(better.shouldPause).toBe(false);
    expect(better.codes).toEqual([]);
    expect(better.breaches).toEqual([]);
  });

  it("decrease 方向等于阈值不算越界", () => {
    const policy: Partial<BreakerPolicy> = {
      guardrails: [{ metric: "errorRate", direction: "decrease", threshold: 0.1 }],
    };
    expect(evaluateBreaker({ outcomes: [], guardMetrics: { errorRate: 0.1 } }, policy).shouldPause).toBe(false);
  });

  it("多守卫混合:两条各自按好方向判越界,breaches 全列、codes 只加一次", () => {
    const policy: Partial<BreakerPolicy> = {
      guardrails: [
        { metric: "errorRate", direction: "decrease", threshold: 0.1 },
        { metric: "passRate", direction: "increase", threshold: 0.9 },
      ],
    };
    const both = evaluateBreaker({ outcomes: [], guardMetrics: { errorRate: 0.5, passRate: 0.1 } }, policy);
    expect(both.breaches).toEqual([
      { metric: "errorRate", value: 0.5, threshold: 0.1, direction: "decrease" },
      { metric: "passRate", value: 0.1, threshold: 0.9, direction: "increase" },
    ]);
    expect(both.codes).toEqual([RSI_GUARDRAIL_BREACH]);
    // 只有一条越界:另一条即便「不好方向」的数值存在也不进 breaches
    const one = evaluateBreaker({ outcomes: [], guardMetrics: { errorRate: 0.5, passRate: 0.95 } }, policy);
    expect(one.breaches).toEqual([
      { metric: "errorRate", value: 0.5, threshold: 0.1, direction: "decrease" },
    ]);
    expect(one.shouldPause).toBe(true);
  });

  it("未配置 guardrails 时 guardMetrics 被完全忽略", () => {
    const result = evaluateBreaker({ outcomes: [], guardMetrics: { errorRate: 0.9, passRate: 0 } });
    expect(result).toEqual({ shouldPause: false, scope: "all", codes: [], streak: 0, breaches: [] });
  });

  it("guardMetrics 里没有同名守卫项 → 忽略该指标", () => {
    const result = evaluateBreaker(
      { outcomes: [], guardMetrics: { latency: 9999 } },
      { guardrails: [{ metric: "errorRate", direction: "increase", threshold: 0.1 }] },
    );
    expect(result.shouldPause).toBe(false);
    expect(result.breaches).toEqual([]);
  });

  it("双码同时命中:顺序 [GUARDRAIL_BREACH, NEGATIVE_STREAK] 且 trigger=auto-guardrail", () => {
    const result = evaluateBreaker(
      { outcomes: negatives(3), guardMetrics: { errorRate: 0.2 } },
      { guardrails: [{ metric: "errorRate", direction: "decrease", threshold: 0.1 }] },
    );
    expect(result.shouldPause).toBe(true);
    expect(result.codes).toEqual([RSI_GUARDRAIL_BREACH, RSI_NEGATIVE_STREAK]);
    expect(result.trigger).toBe("auto-guardrail");
    expect(result.streak).toBe(3);
  });

  it("不改入参 outcomes 与 guardMetrics", () => {
    const outcomes = negatives(3);
    const guardMetrics = { errorRate: 0.2 };
    const snapshot = JSON.parse(JSON.stringify({ outcomes, guardMetrics })) as unknown;
    evaluateBreaker(
      { outcomes, guardMetrics },
      { guardrails: [{ metric: "errorRate", direction: "decrease", threshold: 0.1 }] },
    );
    expect(JSON.parse(JSON.stringify({ outcomes, guardMetrics }))).toEqual(snapshot);
  });

  it("越界口径四例回归(#197):direction=好方向,越界=朝坏方向越过阈值", () => {
    const policy: Partial<BreakerPolicy> = {
      guardrails: [
        { metric: "errorRate", direction: "decrease", threshold: 0.1 },
        { metric: "passRate", direction: "increase", threshold: 0.9 },
      ],
    };
    const probe = (guardMetrics: Record<string, number>) =>
      evaluateBreaker({ outcomes: [], guardMetrics }, policy);

    // 真回归:错误率高于阈值 → 必须熔断
    expect(probe({ errorRate: 0.2 }).codes).toEqual([RSI_GUARDRAIL_BREACH]);
    // 改善:错误率低于阈值 → 不得熔断
    expect(probe({ errorRate: 0.05 }).codes).toEqual([]);
    // 真回归:通过率低于阈值 → 必须熔断
    expect(probe({ passRate: 0.8 }).codes).toEqual([RSI_GUARDRAIL_BREACH]);
    // 改善:通过率高于阈值 → 不得熔断
    expect(probe({ passRate: 0.95 }).codes).toEqual([]);
  });
});

describe("resolvePolicy / defaultBreakerPolicy", () => {
  it("缺省策略逐字:{minNegativeStreak:3, guardrails:[], requireHumanRecovery:true}", () => {
    expect(defaultBreakerPolicy()).toEqual({ minNegativeStreak: 3, guardrails: [], requireHumanRecovery: true });
    expect(RSI_BREAKER_VERSION).toBe(1);
  });

  it("resolvePolicy 无参等价于缺省策略", () => {
    expect(resolvePolicy()).toEqual(defaultBreakerPolicy());
  });

  it("resolvePolicy 合并部分字段,其余回落缺省", () => {
    const policy = resolvePolicy({ minNegativeStreak: 7 });
    expect(policy).toEqual({ minNegativeStreak: 7, guardrails: [], requireHumanRecovery: true });
  });

  it("resolvePolicy 复制 guardrails,不回写入参", () => {
    const input: Partial<BreakerPolicy> = {
      guardrails: [{ metric: "errorRate", direction: "increase", threshold: 0.1 }],
    };
    const resolved = resolvePolicy(input);
    resolved.guardrails.push({ metric: "x", direction: "decrease", threshold: 1 });
    expect(input.guardrails).toEqual([{ metric: "errorRate", direction: "increase", threshold: 0.1 }]);
  });

  it("两次 defaultBreakerPolicy 的 guardrails 不共享引用", () => {
    const a = defaultBreakerPolicy();
    a.guardrails.push({ metric: "errorRate", direction: "increase", threshold: 0.1 });
    expect(defaultBreakerPolicy().guardrails).toEqual([]);
  });
});

describe("isBlocked:放行矩阵", () => {
  it("paused + scope=all:nightly/experiment/injection 全挡", () => {
    const state = baseState({ paused: true, scope: "all" });
    expect(isBlocked(state, "nightly")).toBe(true);
    expect(isBlocked(state, "experiment")).toBe(true);
    expect(isBlocked(state, "injection")).toBe(true);
  });

  it("paused + scope=nightly:只挡 nightly", () => {
    const state = baseState({ paused: true, scope: "nightly" });
    expect(isBlocked(state, "nightly")).toBe(true);
    expect(isBlocked(state, "experiment")).toBe(false);
    expect(isBlocked(state, "injection")).toBe(false);
  });

  it("paused + scope=experiments:只挡 experiment(action 与 scope 名不同)", () => {
    const state = baseState({ paused: true, scope: "experiments" });
    expect(isBlocked(state, "experiment")).toBe(true);
    expect(isBlocked(state, "nightly")).toBe(false);
    expect(isBlocked(state, "injection")).toBe(false);
  });

  it("paused + scope=injection:只挡 injection", () => {
    const state = baseState({ paused: true, scope: "injection" });
    expect(isBlocked(state, "injection")).toBe(true);
    expect(isBlocked(state, "nightly")).toBe(false);
    expect(isBlocked(state, "experiment")).toBe(false);
  });

  it("未暂停:四个动作全放行", () => {
    for (const scope of ["all", "nightly", "experiments", "injection"] as BreakerScope[]) {
      const state = baseState({ paused: false, scope });
      expect(isBlocked(state, "nightly")).toBe(false);
      expect(isBlocked(state, "experiment")).toBe(false);
      expect(isBlocked(state, "injection")).toBe(false);
      expect(isBlocked(state, "observe")).toBe(false);
    }
  });

  it("observe 恒放行(paused + all 也为 false)", () => {
    expect(isBlocked(baseState({ paused: true, scope: "all" }), "observe")).toBe(false);
    expect(isBlocked(baseState({ paused: true, scope: "injection" }), "observe")).toBe(false);
  });
});

describe("pause", () => {
  it("成功:paused/pausedAt/reason/scope/trigger/by 逐字", () => {
    const state = mustOk(pause(baseState(), { by: "owner-1", reason: "错误率飙升", at: AT }));
    expect(state).toEqual({
      paused: true,
      pausedAt: AT,
      reason: "错误率飙升",
      scope: "all",
      trigger: "manual",
      by: "owner-1",
    });
  });

  it("成功:scope 与 trigger 可显式指定", () => {
    const state = mustOk(
      pause(baseState(), { by: "owner-1", reason: "注入面异常", scope: "injection", trigger: "manual-report", at: AT }),
    );
    expect(state.scope).toBe("injection");
    expect(state.trigger).toBe("manual-report");
  });

  it("成功:lastEvaluation 原样保留", () => {
    const lastEvaluation = { shouldPause: true, codes: [RSI_NEGATIVE_STREAK], streak: 3 };
    const state = mustOk(pause(baseState({ lastEvaluation }), { by: "owner-1", reason: "x", at: AT }));
    expect(state.lastEvaluation).toEqual(lastEvaluation);
  });

  it("scope 非法 → codes 恰为 [RSI_SCOPE_INVALID]", () => {
    const result = pause(baseState(), {
      by: "owner-1",
      reason: "x",
      scope: "weekly" as unknown as BreakerScope,
      at: AT,
    });
    expect(result).toEqual({ ok: false, codes: [RSI_SCOPE_INVALID] });
  });

  it("reason 为空白 → codes 恰为 [RSI_RESUME_REASON_REQUIRED]", () => {
    expect(pause(baseState(), { by: "owner-1", reason: "   ", at: AT })).toEqual({
      ok: false,
      codes: [RSI_RESUME_REASON_REQUIRED],
    });
  });

  it("纯函数:不改入参 state", () => {
    const state = baseState({ scope: "nightly", lastEvaluation: { streak: 1 } });
    const before = JSON.parse(JSON.stringify(state)) as BreakerState;
    pause(state, { by: "owner-1", reason: "x", at: AT });
    expect(state).toEqual(before);
  });

  it("重新暂停清掉上一轮 recoveredAt", () => {
    const state = baseState({ recoveredAt: "2025-12-31T00:00:00.000Z", scope: "experiments" });
    const next = mustOk(pause(state, { by: "owner-1", reason: "再次熔断", at: AT }));
    expect(next.recoveredAt).toBeUndefined();
    expect("recoveredAt" in next).toBe(false);
    expect(next.scope).toBe("all");
  });
});

describe("resume", () => {
  it("kind=agent → codes 恰为 [RSI_RESUME_NOT_HUMAN]", () => {
    const state = mustOk(pause(baseState(), { by: "owner-1", reason: "x", at: AT }));
    expect(resume(state, { by: "rsi-1", kind: "agent", reason: "指标恢复了", at: AT })).toEqual({
      ok: false,
      codes: [RSI_RESUME_NOT_HUMAN],
    });
  });

  it("kind=human 成功:paused=false / scope 保持 / recoveredAt", () => {
    const state = mustOk(
      pause(baseState(), { by: "owner-1", reason: "x", scope: "experiments", trigger: "auto-guardrail", at: AT }),
    );
    const next = mustOk(resume(state, { by: "owner-1", kind: "human", reason: "已修复", at: "2026-01-02T00:00:00.000Z" }));
    expect(next).toEqual({
      paused: false,
      recoveredAt: "2026-01-02T00:00:00.000Z",
      reason: "已修复",
      scope: "experiments",
      by: "owner-1",
    });
  });

  it("reason 为空白 → codes 恰为 [RSI_RESUME_REASON_REQUIRED]", () => {
    const state = mustOk(pause(baseState(), { by: "owner-1", reason: "x", at: AT }));
    expect(resume(state, { by: "owner-1", kind: "human", reason: "", at: AT })).toEqual({
      ok: false,
      codes: [RSI_RESUME_REASON_REQUIRED],
    });
  });

  it("成功后 lastEvaluation 保留,且不改入参", () => {
    const lastEvaluation = { streak: 4, codes: [RSI_NEGATIVE_STREAK] };
    const state = mustOk(pause(baseState({ lastEvaluation }), { by: "owner-1", reason: "x", at: AT }));
    const before = JSON.parse(JSON.stringify(state)) as BreakerState;
    const next = mustOk(resume(state, { by: "owner-1", kind: "human", reason: "修好了", at: AT }));
    expect(next.lastEvaluation).toEqual(lastEvaluation);
    expect(state).toEqual(before);
  });

  it("恢复后 isBlocked 全放行", () => {
    const state = mustOk(pause(baseState(), { by: "owner-1", reason: "x", at: AT }));
    const next = mustOk(resume(state, { by: "owner-1", kind: "human", reason: "修好了", at: AT }));
    expect(isBlocked(next, "nightly")).toBe(false);
    expect(isBlocked(next, "injection")).toBe(false);
  });
});

describe("takeBaseline", () => {
  it("同输入同 hash,格式为 sha256:<64hex>", () => {
    const a = takeBaseline({ id: "b1", at: AT, versions: VERSIONS, metrics: { errorRate: 0.01 } });
    const b = takeBaseline({ id: "b2", at: "2026-02-02T00:00:00.000Z", versions: VERSIONS, metrics: { errorRate: 0.01 } });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("metrics key 顺序无关 → 同 hash", () => {
    const a = takeBaseline({ id: "b1", at: AT, versions: VERSIONS, metrics: { errorRate: 0.01, passRate: 0.98 } });
    const b = takeBaseline({ id: "b1", at: AT, versions: VERSIONS, metrics: { passRate: 0.98, errorRate: 0.01 } });
    expect(a.hash).toBe(b.hash);
  });

  it("metrics 不同 → hash 不同", () => {
    const a = takeBaseline({ id: "b1", at: AT, versions: VERSIONS, metrics: { errorRate: 0.01 } });
    const b = takeBaseline({ id: "b1", at: AT, versions: VERSIONS, metrics: { errorRate: 0.02 } });
    expect(a.hash).not.toBe(b.hash);
  });

  it("versions 任一不同 → hash 不同", () => {
    const a = takeBaseline({ id: "b1", at: AT, versions: VERSIONS });
    const b = takeBaseline({ id: "b1", at: AT, versions: { ...VERSIONS, wiki: "wiki@v43" } });
    expect(a.hash).not.toBe(b.hash);
  });

  it("metrics 缺省 {} 与显式空对象等价;label 可选", () => {
    const noMetrics = takeBaseline({ id: "b1", at: AT, versions: VERSIONS });
    const emptyMetrics = takeBaseline({ id: "b1", at: AT, versions: VERSIONS, metrics: {} });
    expect(noMetrics.metrics).toEqual({});
    expect(noMetrics.hash).toBe(emptyMetrics.hash);
    expect("label" in noMetrics).toBe(false);
    expect(takeBaseline({ id: "b1", at: AT, label: "golden", versions: VERSIONS }).label).toBe("golden");
  });

  it("纯函数:不改入参 versions/metrics", () => {
    const versions = { ...VERSIONS };
    const metrics = { errorRate: 0.01 };
    takeBaseline({ id: "b1", at: AT, versions, metrics });
    expect(versions).toEqual(VERSIONS);
    expect(metrics).toEqual({ errorRate: 0.01 });
  });
});

describe("diffBaselines", () => {
  it("完全相同 → changed 与 metrics 都为空", () => {
    const a = takeBaseline({ id: "b1", at: AT, versions: VERSIONS, metrics: { errorRate: 0.01 } });
    expect(diffBaselines(a, a)).toEqual({ changed: [], metrics: [] });
  });

  it("只改 tools → changed 恰为 [\"tools\"]", () => {
    const prev = takeBaseline({ id: "b1", at: AT, versions: VERSIONS });
    const next = takeBaseline({ id: "b2", at: AT, versions: { ...VERSIONS, tools: "tools@v11" } });
    expect(diffBaselines(prev, next).changed).toEqual(["tools"]);
  });

  it("metrics delta = to - from,只列变化项", () => {
    const prev = takeBaseline({ id: "b1", at: AT, versions: VERSIONS, metrics: { errorCount: 10, passRate: 0.98 } });
    const next = takeBaseline({ id: "b2", at: AT, versions: VERSIONS, metrics: { errorCount: 25, passRate: 0.98 } });
    expect(diffBaselines(prev, next).metrics).toEqual([{ metric: "errorCount", from: 10, to: 25, delta: 15 }]);
  });

  it("单侧存在的 metric key 不进结果", () => {
    const prev = takeBaseline({ id: "b1", at: AT, versions: VERSIONS, metrics: { errorRate: 0.01 } });
    const next = takeBaseline({ id: "b2", at: AT, versions: VERSIONS, metrics: { latency: 100 } });
    expect(diffBaselines(prev, next).metrics).toEqual([]);
  });

  it("多个面变化 → 按 tools,tips,prompts,wiki,graph 固定顺序", () => {
    const prev = takeBaseline({ id: "b1", at: AT, versions: VERSIONS });
    const next = takeBaseline({
      id: "b2",
      at: AT,
      versions: { ...VERSIONS, graph: "graph@v10", prompts: "prompts@v4", tools: "tools@v11" },
    });
    expect(diffBaselines(prev, next).changed).toEqual(["tools", "prompts", "graph"]);
  });
});

describe("planRollback", () => {
  const current = takeBaseline({
    id: "cur",
    at: AT,
    versions: { ...VERSIONS, tools: "tools@v99" },
    metrics: { errorRate: 0.5 },
  });
  const target = takeBaseline({ id: "golden", at: AT, versions: VERSIONS, metrics: { errorRate: 0.01 } });

  it("target=undefined → RSI_BASELINE_MISSING 且 steps/requeue 为空", () => {
    expect(planRollback(undefined, current)).toEqual({
      ok: false,
      codes: [RSI_BASELINE_MISSING],
      steps: [],
      requeueExperiments: [],
    });
  });

  it("target=null → 同样 RSI_BASELINE_MISSING", () => {
    expect(planRollback(null, current, { affectedExperiments: ["exp-1"] })).toEqual({
      ok: false,
      codes: [RSI_BASELINE_MISSING],
      steps: [],
      requeueExperiments: [],
    });
  });

  it("正常计划:7 步固定顺序,restore/verify 的 ref 逐字来自 target", () => {
    const plan = planRollback(target, current);
    expect(plan.ok).toBe(true);
    expect(plan.codes).toEqual([]);
    expect(plan.steps.map((s) => s.step)).toEqual([
      "quarantine-experiments",
      "restore-tools",
      "restore-tips",
      "restore-prompts",
      "restore-wiki",
      "restore-graph",
      "verify-baseline",
    ]);
    expect(plan.steps.map((s) => s.ref)).toEqual([
      "",
      target.versions.tools,
      target.versions.tips,
      target.versions.prompts,
      target.versions.wiki,
      target.versions.graph,
      target.hash,
    ]);
  });

  it("affectedExperiments 透传:ref 逗号串、note 带数量、requeue 原样", () => {
    const affected = ["exp-1", "exp-2", "exp-3"];
    const plan = planRollback(target, current, { affectedExperiments: affected });
    expect(plan.requeueExperiments).toEqual(affected);
    expect(plan.steps[0]?.ref).toBe("exp-1,exp-2,exp-3");
    expect(plan.steps[0]?.note).toContain("3");
  });

  it("每个 step 的 note 非空", () => {
    const plan = planRollback(target, current);
    for (const step of plan.steps) expect(step.note.trim().length).toBeGreaterThan(0);
  });
});

describe("verifyRollback", () => {
  it("hash 相等 → ok + [RSI_ROLLBACK_VERIFIED]", () => {
    const a = takeBaseline({ id: "b1", at: AT, versions: VERSIONS, metrics: { errorRate: 0.01 } });
    const b = takeBaseline({ id: "b2", at: "2026-03-03T00:00:00.000Z", versions: VERSIONS, metrics: { errorRate: 0.01 } });
    expect(verifyRollback(a, b)).toEqual({ ok: true, codes: [RSI_ROLLBACK_VERIFIED] });
  });

  it("hash 不等 → 不 ok + [RSI_ROLLBACK_TARGET_MISMATCH]", () => {
    const a = takeBaseline({ id: "b1", at: AT, versions: VERSIONS });
    const b = takeBaseline({ id: "b1", at: AT, versions: { ...VERSIONS, tips: "tips@v8" } });
    expect(verifyRollback(a, b)).toEqual({ ok: false, codes: [RSI_ROLLBACK_TARGET_MISMATCH] });
  });
});

describe("码表与依赖纪律", () => {
  it("RSI_CODES 是冻结对象且键值一致", () => {
    expect(Object.isFrozen(RSI_CODES)).toBe(true);
    for (const [key, value] of Object.entries(RSI_CODES)) expect(key).toBe(value);
    expect(RSI_CODES.RSI_BREAKER_PAUSED).toBe(RSI_BREAKER_PAUSED);
    expect(RSI_CODES.RSI_BREAKER_NOT_PAUSED).toBe(RSI_BREAKER_NOT_PAUSED);
    expect([RSI_SCOPE_INVALID, RSI_RESUME_NOT_HUMAN, RSI_RESUME_REASON_REQUIRED]).toEqual([
      "RSI_SCOPE_INVALID",
      "RSI_RESUME_NOT_HUMAN",
      "RSI_RESUME_REASON_REQUIRED",
    ]);
  });

  it("源码只 import node:crypto(零 IO)", () => {
    const path = fileURLToPath(new URL("../src/agent/rsi-circuit-breaker.ts", import.meta.url));
    const source = readFileSync(path, "utf8");
    const imports = source.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual(['import { createHash } from "node:crypto";']);
    for (const banned of ["node:fs", "node:net", "node:http", "process.env", "fetch("]) {
      expect(source.includes(banned)).toBe(false);
    }
  });
});
