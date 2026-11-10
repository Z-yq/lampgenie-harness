/**
 * 实验台账:稳定 id / 采纳闸 11 个稳定码 / 两路 z 检验 / 决策不改入参 / 冲突识别 /
 * 确定性灰度 / 分层过滤。全部用纯数据 + 固定时间戳,不碰文件与真实时钟。
 */
import { describe, expect, it } from "vitest";
import {
  EXPERIMENT_SCHEMA_VERSION,
  experimentIdOf,
  evaluateAdoptGate,
  findConflicts,
  decideExperiment,
  planCanary,
  filterByStratum,
  normalizeClaim,
  canonicalJSON,
} from "../src/agent/experiment-ledger.ts";
import type { Experiment, ExperimentMetric } from "../src/agent/experiment-ledger.ts";

const T0 = 1_700_000_000_000;
const T1 = 1_700_000_100_000;

/** 一条默认即可过闸的指标(比例口径 + stddev 都在)。 */
function metric(partial: Partial<ExperimentMetric> = {}): ExperimentMetric {
  return {
    name: "retry_rate",
    unit: "ratio",
    kind: "rate",
    direction: "decrease",
    baseline: { value: 0.2, sample: 400, stddev: 0.01 },
    result: { value: 0.1, sample: 400, stddev: 0.01 },
    thresholds: { minSample: 100, minEffectPct: 5 },
    ...partial,
  };
}

function buildExperiment(partial: Partial<Experiment> = {}): Experiment {
  return {
    id: "exp-base0000000000",
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    hypothesis: { claim: "retry hint cuts retries", expectedEffect: "retries -10%" },
    intervention: { surface: "tip", ref: "tips/retry-hint", variant: "v2" },
    guardrails: [],
    canary: { scope: "session", sessions: 5, status: "done" },
    strata: [{ projectId: "p1", taskClass: "bugfix", model: "gpt-x" }],
    metrics: [metric()],
    traceBatchKeys: [],
    rollbackPoint: { kind: "flag", ref: "flag/retry-hint" },
    decision: { kind: "pending" },
    createdAt: T0,
    updatedAt: T0,
    ...partial,
  };
}

/** guardrail 角色指标:1000→1050ms,允许 10% 回退,无 stddev、非比例口径。 */
function guardrailMetric(partial: Partial<ExperimentMetric> = {}): ExperimentMetric {
  return metric({
    name: "p95_latency_ms",
    unit: "ms",
    kind: "mean",
    role: "guardrail",
    direction: "decrease",
    baseline: { value: 1000, sample: 200 },
    result: { value: 1050, sample: 200 },
    thresholds: { minSample: 100, minEffectPct: 1 },
    ...partial,
  });
}

/** 成功指标:rate 0.5→0.65(n=200),z≈3.03、rel +30%。 */
function successMetric(partial: Partial<ExperimentMetric> = {}): ExperimentMetric {
  return metric({
    name: "first_pass_rate",
    unit: "ratio",
    kind: "rate",
    direction: "increase",
    baseline: { value: 0.5, sample: 200 },
    result: { value: 0.65, sample: 200 },
    thresholds: { minSample: 100, minEffectPct: 5 },
    ...partial,
  });
}

describe("规范化与稳定 JSON", () => {
  it("claim 折叠空白 + 小写;canonicalJSON 键序无关", () => {
    expect(normalizeClaim("  Retry   Hint  CUTS ")).toBe("retry hint cuts");
    expect(canonicalJSON({ b: 1, a: 2 })).toBe(canonicalJSON({ a: 2, b: 1 }));
    expect(canonicalJSON({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("experimentIdOf 幂等", () => {
  it("claim 多空格/大小写 + strata 顺序颠倒 → 同 id", () => {
    const a = buildExperiment({
      hypothesis: { claim: "Retry   Hint  Cuts   Retries", expectedEffect: "x" },
      strata: [
        { projectId: "p1", taskClass: "bugfix", model: "gpt-x" },
        { projectId: "p2", taskClass: "feature", model: "gpt-y", window: { from: "2024-01-01", to: "2024-02-01" } },
      ],
    });
    const b = buildExperiment({
      hypothesis: { claim: "  retry hint cuts retries ", expectedEffect: "x" },
      strata: [
        { projectId: "p2", taskClass: "feature", model: "gpt-y", window: { from: "2024-01-01", to: "2024-02-01" } },
        { projectId: "p1", taskClass: "bugfix", model: "gpt-x" },
      ],
    });
    expect(experimentIdOf(a)).toBe(experimentIdOf(b));
    expect(experimentIdOf(a)).toMatch(/^exp-[0-9a-f]{16}$/);
  });

  it("intervention.ref 不同 → id 不同", () => {
    const a = buildExperiment();
    const b = buildExperiment({ intervention: { surface: "tip", ref: "tips/other-hint", variant: "v2" } });
    expect(experimentIdOf(a)).not.toBe(experimentIdOf(b));
  });
});

const gateCases: Array<{
  code: string;
  exp: () => Experiment;
  policy?: { minZ?: number; conflicts?: Array<{ id: string }> };
}> = [
  {
    code: "EXP_HYPOTHESIS_EMPTY",
    exp: () => buildExperiment({ hypothesis: { claim: "   ", expectedEffect: "x" } }),
  },
  {
    code: "EXP_INTERVENTION_MISSING",
    exp: () => buildExperiment({ intervention: { surface: "tip", ref: "  ", variant: "v2" } }),
  },
  {
    code: "EXP_ROLLBACK_MISSING",
    exp: () => buildExperiment({ rollbackPoint: { kind: "flag", ref: "   " } }),
  },
  {
    code: "EXP_CANARY_INCOMPLETE",
    exp: () => buildExperiment({ canary: { scope: "session", sessions: 5, status: "running" } }),
  },
  {
    code: "EXP_BASELINE_SAMPLE_LOW",
    exp: () => buildExperiment({ metrics: [metric({ baseline: { value: 0.2, sample: 50, stddev: 0.01 } })] }),
  },
  {
    code: "EXP_RESULT_SAMPLE_LOW",
    exp: () => buildExperiment({ metrics: [] }),
  },
  {
    code: "EXP_NOT_SIGNIFICANT",
    exp: () =>
      buildExperiment({
        metrics: [
          metric({
            name: "latency_index",
            unit: "ms",
            kind: "mean",
            direction: "decrease",
            baseline: { value: 2.0, sample: 400 },
            result: { value: 2.5, sample: 400 },
          }),
        ],
      }),
  },
  {
    code: "EXP_EFFECT_BELOW_MIN",
    exp: () =>
      buildExperiment({
        metrics: [
          metric({
            name: "latency_ms",
            unit: "ms",
            kind: "mean",
            direction: "decrease",
            baseline: { value: 100, sample: 400, stddev: 20 },
            result: { value: 99, sample: 400, stddev: 20 },
            thresholds: { minSample: 100, minEffectPct: 5 },
          }),
        ],
      }),
  },
  {
    code: "EXP_DIRECTION_UNMET",
    exp: () =>
      buildExperiment({
        metrics: [
          metric({
            name: "latency_ms",
            unit: "ms",
            kind: "mean",
            direction: "decrease",
            baseline: { value: 100, sample: 400, stddev: 20 },
            result: { value: 130, sample: 400, stddev: 20 },
            thresholds: { minSample: 100, minEffectPct: 5 },
          }),
        ],
      }),
  },
  {
    code: "EXP_GUARDRAIL_BREACH",
    exp: () => buildExperiment({ guardrails: [{ metric: "crash_rate", maxRegressionPct: 2 }] }),
  },
  {
    code: "EXP_CONFLICTING_ADOPTED",
    exp: () => buildExperiment(),
    policy: { conflicts: [{ id: "exp-other00000000" }] },
  },
];

describe("evaluateAdoptGate 稳定码", () => {
  it("干净实验过闸", () => {
    const gate = evaluateAdoptGate(buildExperiment());
    expect(gate.ok).toBe(true);
    expect(gate.codes).toEqual([]);
  });

  for (const { code, exp, policy } of gateCases) {
    it(`命中 ${code}`, () => {
      const gate = evaluateAdoptGate(exp(), policy);
      expect(gate.ok).toBe(false);
      expect(gate.codes.includes(code)).toBe(true);
      expect(gate.details.length).toBeGreaterThan(0);
    });
  }

  it("codes 去重且顺序稳定", () => {
    const exp = buildExperiment({ hypothesis: { claim: " ", expectedEffect: "x" }, canary: { scope: "percent", percent: 0, status: "pending" } });
    const a = evaluateAdoptGate(exp);
    const b = evaluateAdoptGate(exp);
    expect(a.codes).toEqual(b.codes);
    expect(new Set(a.codes).size).toBe(a.codes.length);
    expect(a.codes[0]).toBe("EXP_HYPOTHESIS_EMPTY");
    expect(a.codes.includes("EXP_CANARY_INCOMPLETE")).toBe(true);
  });

  it("conflicts 里同 id 的自身不计", () => {
    const exp = buildExperiment();
    expect(evaluateAdoptGate(exp, { conflicts: [{ id: exp.id }] }).ok).toBe(true);
  });

  it("percent 越界 / project 未给 projects / session 未给 sessions 都算灰度未完成", () => {
    expect(evaluateAdoptGate(buildExperiment({ canary: { scope: "percent", percent: 120, status: "done" } })).codes.includes("EXP_CANARY_INCOMPLETE")).toBe(true);
    expect(evaluateAdoptGate(buildExperiment({ canary: { scope: "project", status: "done" } })).codes.includes("EXP_CANARY_INCOMPLETE")).toBe(true);
    expect(evaluateAdoptGate(buildExperiment({ canary: { scope: "session", sessions: 0, status: "done" } })).codes.includes("EXP_CANARY_INCOMPLETE")).toBe(true);
    expect(evaluateAdoptGate(buildExperiment({ canary: { scope: "percent", percent: 10, status: "done" } })).ok).toBe(true);
  });

  it("警戒线:同名指标回退超限 → BREACH;不超限则通过", () => {
    // decrease 指标(越小越好)从 .2 升到 .3 = 回退 50% > 10%
    const breached = buildExperiment({
      guardrails: [{ metric: "retry_rate", maxRegressionPct: 10 }],
      metrics: [metric({ direction: "decrease", result: { value: 0.3, sample: 400, stddev: 0.01 } })],
    });
    const gate = evaluateAdoptGate(breached);
    expect(gate.codes.includes("EXP_GUARDRAIL_BREACH")).toBe(true);
    const safe = buildExperiment({ guardrails: [{ metric: "retry_rate", maxRegressionPct: 10 }] });
    expect(evaluateAdoptGate(safe).codes.includes("EXP_GUARDRAIL_BREACH")).toBe(false);
  });

  it("警戒线按 direction 判:increase 指标上升是改善不算回归,decrease 指标上升才算", () => {
    // increase 指标 .2 → .3 是改善,即使幅 50% 也不能算回退
    const improved = buildExperiment({
      guardrails: [{ metric: "retry_rate", maxRegressionPct: 10 }],
      metrics: [metric({ direction: "increase", result: { value: 0.3, sample: 400, stddev: 0.01 } })],
    });
    expect(evaluateAdoptGate(improved).codes.includes("EXP_GUARDRAIL_BREACH")).toBe(false);
    // increase 指标 .3 → .2 才是回退
    const regressed = buildExperiment({
      guardrails: [{ metric: "retry_rate", maxRegressionPct: 10 }],
      metrics: [metric({ direction: "increase", baseline: { value: 0.3, sample: 400, stddev: 0.01 }, result: { value: 0.2, sample: 400, stddev: 0.01 } })],
    });
    expect(evaluateAdoptGate(regressed).codes.includes("EXP_GUARDRAIL_BREACH")).toBe(true);
  });

  it("guardrail role:+5% 在允许 10% 内(无 stddev、非比例)→ 可 adopt", () => {
    const exp = buildExperiment({
      guardrails: [{ metric: "p95_latency_ms", maxRegressionPct: 10 }],
      metrics: [successMetric(), guardrailMetric()],
    });
    const gate = evaluateAdoptGate(exp);
    expect(gate.ok).toBe(true);
    expect(gate.codes).toEqual([]);
  });

  it("guardrail role:回退 +30% 只出 EXP_GUARDRAIL_BREACH,不再出 NOT_SIGNIFICANT/DIRECTION_UNMET", () => {
    const exp = buildExperiment({
      guardrails: [{ metric: "p95_latency_ms", maxRegressionPct: 10 }],
      metrics: [successMetric(), guardrailMetric({ result: { value: 1300, sample: 200 } })],
    });
    const gate = evaluateAdoptGate(exp);
    expect(gate.ok).toBe(false);
    expect(gate.codes).toEqual(["EXP_GUARDRAIL_BREACH"]);
  });

  it("guardrail role 缺 result → EXP_GUARDRAIL_BREACH", () => {
    const exp = buildExperiment({
      guardrails: [{ metric: "p95_latency_ms", maxRegressionPct: 10 }],
      metrics: [successMetric(), { ...guardrailMetric(), result: undefined }],
    });
    const gate = evaluateAdoptGate(exp);
    expect(gate.ok).toBe(false);
    expect(gate.codes.includes("EXP_GUARDRAIL_BREACH")).toBe(true);
  });

  it("role 缺省仍按 success 严格判(同数据不标 role 会被显著性与方向拦)", () => {
    const strict = buildExperiment({
      guardrails: [{ metric: "p95_latency_ms", maxRegressionPct: 10 }],
      metrics: [successMetric(), { ...guardrailMetric(), role: undefined }],
    });
    const gate = evaluateAdoptGate(strict);
    expect(gate.ok).toBe(false);
    expect(gate.codes.includes("EXP_NOT_SIGNIFICANT")).toBe(true);
    expect(gate.codes.includes("EXP_DIRECTION_UNMET")).toBe(true);
  });

  it("minZ 可被 metric.thresholds 与 policy 覆盖", () => {
    const weak = buildExperiment({
      metrics: [
        metric({
          name: "retry_rate",
          unit: "ratio",
          kind: "rate",
          baseline: { value: 0.2, sample: 400 },
          result: { value: 0.1, sample: 400 },
          thresholds: { minSample: 100, minEffectPct: 5 },
        }),
      ],
    });
    expect(evaluateAdoptGate(weak).ok).toBe(true);
    expect(evaluateAdoptGate(weak, { minZ: 6 }).codes.includes("EXP_NOT_SIGNIFICANT")).toBe(true);
  });
});

describe("两路 z 检验", () => {
  it("① stddev 标准误:100→90(n=400, sd=20)显著且效应达标", () => {
    const gate = evaluateAdoptGate(
      buildExperiment({
        metrics: [
          metric({
            name: "latency_ms",
            unit: "ms",
            kind: "mean",
            direction: "decrease",
            baseline: { value: 100, sample: 400, stddev: 20 },
            result: { value: 90, sample: 400, stddev: 20 },
            thresholds: { minSample: 100, minEffectPct: 5 },
          }),
        ],
      }),
    );
    expect(gate.ok).toBe(true);
    expect(gate.details.join(" ")).toContain("stddev 标准误");
  });

  it("② 二项标准误:.10→.16(n=400, 无 stddev)判显著", () => {
    const gate = evaluateAdoptGate(
      buildExperiment({
        metrics: [
          metric({
            name: "click_rate",
            unit: "ratio",
            kind: "rate",
            direction: "increase",
            baseline: { value: 0.1, sample: 400 },
            result: { value: 0.16, sample: 400 },
            thresholds: { minSample: 100, minEffectPct: 5 },
          }),
        ],
      }),
    );
    expect(gate.ok).toBe(true);
    expect(gate.details.join(" ")).toContain("二项标准误");
  });

  it("③ 两路都不可算(2.0→2.5,无 stddev 非比例)→ EXP_NOT_SIGNIFICANT", () => {
    const gate = evaluateAdoptGate(
      buildExperiment({
        metrics: [
          metric({
            name: "latency_index",
            unit: "ms",
            kind: "mean",
            direction: "increase",
            baseline: { value: 2.0, sample: 400 },
            result: { value: 2.5, sample: 400 },
            thresholds: { minSample: 100, minEffectPct: 5 },
          }),
        ],
      }),
    );
    expect(gate.codes.includes("EXP_NOT_SIGNIFICANT")).toBe(true);
    expect(gate.details.join(" ")).toContain("证据不足");
    expect(gate.codes.includes("EXP_EFFECT_BELOW_MIN")).toBe(false);
  });

  it("比例口径识别:unit/kind/name/[0,1] 兜底", () => {
    const base = metric();
    expect(evaluateAdoptGate(buildExperiment({ metrics: [{ ...base, unit: "pct", kind: "mean" }] }), {}).ok).toBe(true);
    const byName = metric({ name: "conversion_ratio_pct", unit: undefined, kind: "mean", direction: "increase", baseline: { value: 0.1, sample: 400, stddev: undefined }, result: { value: 0.16, sample: 400, stddev: undefined } });
    expect(evaluateAdoptGate(buildExperiment({ metrics: [byName] })).ok).toBe(true);
    const byRange = metric({ name: "score", unit: undefined, kind: "mean", direction: "increase", baseline: { value: 0.1, sample: 400 }, result: { value: 0.16, sample: 400 } });
    expect(evaluateAdoptGate(buildExperiment({ metrics: [byRange] })).details.join(" ")).toContain("二项标准误");
  });

  it("baseline.value 为 0 走绝对差口径", () => {
    const gate = evaluateAdoptGate(
      buildExperiment({
        metrics: [
          metric({
            name: "spill_count",
            unit: "count",
            kind: "mean",
            direction: "decrease",
            baseline: { value: 0, sample: 400, stddev: 1 },
            result: { value: -6, sample: 400, stddev: 1 },
            thresholds: { minSample: 100, minEffectPct: 5 },
          }),
        ],
      }),
    );
    expect(gate.ok).toBe(true);
  });
});

describe("decideExperiment", () => {
  it("adopt 被拒 → 只回 codes,无 experiment,入参仍 pending", () => {
    const exp = buildExperiment({ canary: { scope: "session", sessions: 5, status: "running" } });
    const res = decideExperiment(exp, "adopt", { by: "tester", at: T1 });
    expect(res.ok).toBe(false);
    expect(res.codes.includes("EXP_CANARY_INCOMPLETE")).toBe(true);
    expect(res.experiment).toBeUndefined();
    expect(exp.decision.kind).toBe("pending");
  });

  it("adopt 成功 → 新对象 decision.kind=adopt,原对象仍 pending", () => {
    const exp = buildExperiment();
    const res = decideExperiment(exp, "adopt", { by: "tester", reason: "达标", at: T1 });
    expect(res.ok).toBe(true);
    expect(res.experiment).toBeDefined();
    const next = res.experiment as Experiment;
    expect(next.decision).toEqual({ kind: "adopt", at: T1, by: "tester", reason: "达标" });
    expect(next.updatedAt).toBe(T1);
    expect(next).not.toBe(exp);
    expect(exp.decision.kind).toBe("pending");
    expect(exp.updatedAt).toBe(T0);
  });

  it("resultMetrics 存在则替换指标后再过闸", () => {
    const exp = buildExperiment({ metrics: [] });
    expect(decideExperiment(exp, "adopt", { at: T1 }).codes.includes("EXP_RESULT_SAMPLE_LOW")).toBe(true);
    const good = decideExperiment(exp, "adopt", { at: T1, resultMetrics: [metric()] });
    expect(good.ok).toBe(true);
    expect(exp.metrics).toEqual([]);
  });

  it("resultMetrics 不带 role 时按指标名沿用原记录 role(guardrail 不被降级)", () => {
    const exp = buildExperiment({
      guardrails: [{ metric: "p95_latency_ms", maxRegressionPct: 10 }],
      metrics: [
        successMetric(),
        metric({
          name: "p95_latency_ms",
          unit: "ms",
          kind: "mean",
          role: "guardrail",
          direction: "decrease",
          baseline: { value: 1000, sample: 200 },
          thresholds: { minSample: 100, minEffectPct: 1 },
        }),
      ],
    });
    // 结果文件只带数值,不带 role。
    const res = decideExperiment(exp, "adopt", {
      at: T1,
      resultMetrics: [
        successMetric(),
        metric({
          name: "p95_latency_ms",
          unit: "ms",
          kind: "mean",
          direction: "decrease",
          baseline: { value: 1000, sample: 200 },
          result: { value: 1050, sample: 200 },
          thresholds: { minSample: 100, minEffectPct: 1 },
        }),
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.experiment?.metrics.find((m) => m.name === "p95_latency_ms")?.role).toBe("guardrail");
  });

  it("adopt 带上 conflicts 时被冲突挡住", () => {
    const res = decideExperiment(buildExperiment(), "adopt", { at: T1, conflicts: [{ id: "exp-other00000000" }] });
    expect(res.ok).toBe(false);
    expect(res.codes.includes("EXP_CONFLICTING_ADOPTED")).toBe(true);
  });

  it("reject 缺 reason → EXP_REASON_REQUIRED,不做任何改动", () => {
    const exp = buildExperiment();
    const res = decideExperiment(exp, "reject", { by: "tester", at: T1 });
    expect(res.ok).toBe(false);
    expect(res.codes).toEqual(["EXP_REASON_REQUIRED"]);
    expect(res.experiment).toBeUndefined();
    expect(exp.decision.kind).toBe("pending");
  });

  it("rollback/iterate 带 reason 成功", () => {
    const rollback = decideExperiment(buildExperiment(), "rollback", { reason: "指标回归", at: T1 });
    expect(rollback.ok).toBe(true);
    expect((rollback.experiment as Experiment).decision.kind).toBe("rollback");
    expect((rollback.experiment as Experiment).decision.reason).toBe("指标回归");
    const iterate = decideExperiment(buildExperiment(), "iterate", { reason: "样本不够", at: T1 });
    expect(iterate.ok).toBe(true);
    expect((iterate.experiment as Experiment).decision.kind).toBe("iterate");
  });
});

describe("findConflicts", () => {
  const adopted = (partial: Partial<Experiment> = {}): Experiment =>
    buildExperiment({ decision: { kind: "adopt", at: T0, by: "tester", reason: "ok" }, ...partial });

  it("同 surface+ref、已 adopt、窗口重叠 → 命中", () => {
    const candidate = buildExperiment({ strata: [{ projectId: "p1", window: { from: "2024-03-01", to: "2024-04-01" } }] });
    const existing = adopted({ id: "exp-a1", strata: [{ projectId: "p2", window: { from: "2024-02-01", to: "2024-03-15" } }] });
    expect(findConflicts(candidate, [existing]).map((x) => x.id)).toEqual(["exp-a1"]);
  });

  it("窗口不重叠 → 不命中", () => {
    const candidate = buildExperiment({ strata: [{ window: { from: "2024-01-01", to: "2024-02-01" } }] });
    const existing = adopted({ id: "exp-a2", strata: [{ window: { from: "2024-05-01", to: "2024-06-01" } }] });
    expect(findConflicts(candidate, [existing])).toEqual([]);
  });

  it("任一方 window 缺失 → 视为重叠", () => {
    const candidate = buildExperiment({ strata: [{ projectId: "p1" }] });
    const existing = adopted({ id: "exp-a3", strata: [{ window: { from: "2024-05-01", to: "2024-06-01" } }] });
    expect(findConflicts(candidate, [existing]).map((x) => x.id)).toEqual(["exp-a3"]);
  });

  it("未 adopt / ref 不同 / id 相同 → 不命中", () => {
    const candidate = buildExperiment();
    expect(findConflicts(candidate, [buildExperiment({ id: "exp-b1" })])).toEqual([]);
    expect(findConflicts(candidate, [adopted({ id: "exp-b2", intervention: { surface: "tip", ref: "tips/x", variant: "v2" } })])).toEqual([]);
    expect(findConflicts(candidate, [adopted({ id: candidate.id })])).toEqual([]);
  });
});

describe("planCanary", () => {
  const keys = ["b1", "b0", "b3", "b2", "b9"];
  const exp = (partial: Partial<Experiment> = {}): Experiment => buildExperiment({ traceBatchKeys: keys, ...partial });

  it("同输入两次 picks 全等且确定性排序", () => {
    const a = planCanary(exp({ canary: { scope: "session", sessions: 3, status: "done" } }));
    const b = planCanary(exp({ canary: { scope: "session", sessions: 3, status: "done" } }));
    expect(a.picks).toEqual(b.picks);
    expect(a.size).toBe(3);
    expect(a.picks.every((k) => keys.includes(k))).toBe(true);
    expect(new Set(a.picks).size).toBe(a.picks.length);
    expect(a.rule).toContain("确定性无随机");
  });

  it("size 超过候选长度时截断", () => {
    const plan = planCanary(exp({ canary: { scope: "project", projects: 99, status: "done" } }));
    expect(plan.size).toBe(keys.length);
    expect(plan.picks.slice().sort()).toEqual(keys.slice().sort());
  });

  it("percent 口径按 total 计算,越界取 0", () => {
    const pct = planCanary(exp({ canary: { scope: "percent", percent: 50, status: "done" } }), 4);
    expect(pct.size).toBe(2);
    const over = planCanary(exp({ canary: { scope: "percent", percent: 150, status: "done" } }));
    expect(over.size).toBe(0);
    expect(over.picks).toEqual([]);
    expect(over.rule).toContain("越界");
  });

  it("picks ⊆ traceBatchKeys;无 traceBatchKeys 时为空", () => {
    expect(planCanary(exp()).picks.every((k) => keys.includes(k))).toBe(true);
    expect(planCanary(buildExperiment({ traceBatchKeys: undefined })).size).toBe(0);
  });
});

describe("filterByStratum", () => {
  const strataA = [{ projectId: "p1", taskClass: "bugfix", model: "gpt-x", window: { from: "2024-01-01", to: "2024-06-30" } }];
  const strataB = [{ projectId: "p2", taskClass: "feature", model: "gpt-y", window: { from: "2024-07-01", to: "2024-12-31" } }];
  const list: Experiment[] = [
    buildExperiment({ id: "exp-1", strata: strataA }),
    buildExperiment({ id: "exp-2", strata: strataB }),
  ];

  it("无过滤键原样返回(同一引用)", () => {
    expect(filterByStratum(list, {})).toBe(list);
  });

  it("projectId / taskClass / model 各命中", () => {
    expect(filterByStratum(list, { projectId: "p2" }).map((x) => x.id)).toEqual(["exp-2"]);
    expect(filterByStratum(list, { taskClass: "bugfix" }).map((x) => x.id)).toEqual(["exp-1"]);
    expect(filterByStratum(list, { model: "gpt-y" }).map((x) => x.id)).toEqual(["exp-2"]);
  });

  it("window 重叠即匹配,不重叠排除", () => {
    expect(filterByStratum(list, { window: { from: "2024-03-01", to: "2024-08-01" } }).map((x) => x.id)).toEqual(["exp-1", "exp-2"]);
    expect(filterByStratum(list, { window: { from: "2025-01-01", to: "2025-02-01" } })).toEqual([]);
  });

  it("stratum 缺省字段即通配", () => {
    const wild = [buildExperiment({ id: "exp-3", strata: [{}] })];
    expect(filterByStratum(wild, { projectId: "p9", model: "nope" }).map((x) => x.id)).toEqual(["exp-3"]);
  });
});
