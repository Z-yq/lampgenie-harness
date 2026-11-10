/**
 * 情境签名与反事实比较(纯逻辑,零 IO)。
 * 断言全部按 cohort-signature.ts 的真实行为:固定顺序签名键、六维严格/近似匹配、
 * 同桶反事实配对(跨桶不配对、样本不足进 candidates)、两臂三态评估、版本分层与漂移、
 * 混杂因子与幸存者偏差体检、样本集审计,以及脏输入不抛。
 */
import { describe, expect, it } from "vitest";
import {
  CONF_CODES,
  CONTEXT_PRESSURES,
  SAMPLE_STATUSES,
  SIGNATURE_DIMENSIONS,
  SIGNATURE_VERSION,
  assertSampleSet,
  buildBuckets,
  coerceSample,
  coerceSignature,
  confounders,
  counterfactualPairs,
  detectVersionChange,
  evaluateComparison,
  markStale,
  matchSignature,
  signatureKey,
  stratifyByVersion,
  survivorBias,
} from "../src/agent/cohort-signature.ts";
import type {
  SampleStatus,
  SignatureExperiment,
  SignatureSample,
  SituationSignature,
} from "../src/agent/cohort-signature.ts";

const T0 = Date.UTC(2026, 0, 1);

function sig(over: Partial<SituationSignature> = {}): SituationSignature {
  return {
    taskClass: "feat",
    phase: "implement",
    toolSurface: "code",
    contextPressure: "medium",
    modelVersion: "m1",
    providerVersion: "p1",
    ...over,
  };
}

function sample(over: Partial<SignatureSample> & { id: string }): SignatureSample {
  return {
    signature: sig(),
    status: "done",
    outcome: { metric: "turns", value: 2 },
    at: T0,
    ...over,
  };
}

/** 造一个决策臂:同签名 / 同指标 / 同状态的一批样本。 */
function arm(
  decision: string,
  values: number[],
  over: { signature?: SituationSignature; status?: SampleStatus; metric?: string } = {},
): SignatureSample[] {
  const metric = over.metric ?? "turns";
  return values.map((value, index) =>
    sample({
      id: `${decision}-${metric}-${index}`,
      decision,
      status: over.status ?? "done",
      signature: over.signature ?? sig(),
      outcome: { metric, value },
    }),
  );
}

describe("cohort-signature 模块契约", () => {
  it("SIGNATURE_VERSION 为 1,CONF_CODES 是稳定码表", () => {
    expect(SIGNATURE_VERSION).toBe(1);
    expect(CONF_CODES).toHaveLength(9);
    expect(CONF_CODES).toContain("CONF_SURVIVOR_BIAS");
  });

  it("维度/压力档/样本状态表的顺序都是契约的一部分", () => {
    expect([...SIGNATURE_DIMENSIONS]).toEqual([
      "taskClass",
      "phase",
      "toolSurface",
      "contextPressure",
      "modelVersion",
      "providerVersion",
    ]);
    expect([...CONTEXT_PRESSURES]).toEqual(["low", "medium", "high"]);
    expect([...SAMPLE_STATUSES]).toEqual(["done", "failed", "interrupted", "cancelled"]);
  });
});

describe("signatureKey", () => {
  it("固定顺序输出六维分量并 trim 值", () => {
    const key = signatureKey(
      sig({ taskClass: "  feat ", phase: " implement", toolSurface: "code  " }),
    );
    expect(key).toBe("tc=feat|ph=implement|ts=code|cp=medium|mv=m1|pv=p1");
  });

  it("六维各不相同时也逐维落到对应分量上", () => {
    const key = signatureKey({
      taskClass: "a",
      phase: "b",
      toolSurface: "c",
      contextPressure: "high",
      modelVersion: "d",
      providerVersion: "e",
    });
    expect(key).toBe("tc=a|ph=b|ts=c|cp=high|mv=d|pv=e");
  });

  it("缺失或非字符串维度用 ? 占位,键仍可算", () => {
    const key = signatureKey({ taskClass: "feat", phase: 42 } as unknown as SituationSignature);
    expect(key).toBe("tc=feat|ph=?|ts=?|cp=?|mv=?|pv=?");
  });

  it("同一签名(属性顺序不同)得到同一键", () => {
    const a = signatureKey(sig());
    const b = signatureKey({
      providerVersion: "p1",
      modelVersion: "m1",
      contextPressure: "medium",
      toolSurface: "code",
      phase: "implement",
      taskClass: "feat",
    });
    expect(a).toBe(b);
  });

  it("非对象入参不抛,整键退化为占位", () => {
    expect(() => signatureKey(null as unknown as SituationSignature)).not.toThrow();
    expect(signatureKey(null as unknown as SituationSignature)).toBe(
      "tc=?|ph=?|ts=?|cp=?|mv=?|pv=?",
    );
  });
});

describe("coerceSignature / coerceSample", () => {
  it("非对象签名判非法", () => {
    expect(coerceSignature(null)).toBeUndefined();
    expect(coerceSignature("sig")).toBeUndefined();
    expect(coerceSignature(123)).toBeUndefined();
  });

  it("contextPressure 非法回退 medium", () => {
    const got = coerceSignature({ ...sig(), contextPressure: "extreme" });
    expect(got?.contextPressure).toBe("medium");
  });

  it("缺维用 ? 占位而不是丢样本", () => {
    const got = coerceSignature({ taskClass: "feat", modelVersion: "m1" });
    expect(got).toEqual({
      taskClass: "feat",
      phase: "?",
      toolSurface: "?",
      contextPressure: "medium",
      modelVersion: "m1",
      providerVersion: "?",
    });
  });

  it("五维全缺 = 零信息签名,判非法", () => {
    expect(coerceSignature({ contextPressure: "high" })).toBeUndefined();
    expect(coerceSignature({})).toBeUndefined();
  });

  it("合法样本原样读出必填字段", () => {
    const got = coerceSample({
      id: " s1 ",
      signature: sig(),
      status: "failed",
      outcome: { metric: "turns", value: 4.5 },
      at: T0,
    });
    expect(got?.id).toBe("s1");
    expect(got?.status).toBe("failed");
    expect(got?.outcome).toEqual({ metric: "turns", value: 4.5 });
  });

  it("缺 id / 非法 status / 缺 metric / 非有限 value / 非有限 at 一律判非法", () => {
    const base = { signature: sig(), status: "done", outcome: { metric: "turns", value: 2 }, at: T0 };
    expect(coerceSample({ ...base })).toBeUndefined();
    expect(coerceSample({ ...base, id: "s1", status: "skipped" })).toBeUndefined();
    expect(coerceSample({ ...base, id: "s1", outcome: { metric: "", value: 2 } })).toBeUndefined();
    expect(coerceSample({ ...base, id: "s1", outcome: { metric: "turns", value: Number.NaN } })).toBeUndefined();
    expect(coerceSample({ ...base, id: "s1", at: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it("可选字段保留,缺省时不写入", () => {
    const withExtras = coerceSample({
      id: "s1",
      signature: sig(),
      status: "done",
      outcome: { metric: "turns", value: 2 },
      at: T0,
      decision: "after",
      projectId: "proj-a",
      durationMs: 1200,
    });
    expect(withExtras?.decision).toBe("after");
    expect(withExtras?.projectId).toBe("proj-a");
    expect(withExtras?.durationMs).toBe(1200);
    const minimal = coerceSample({
      id: "s1",
      signature: sig(),
      status: "done",
      outcome: { metric: "turns", value: 2 },
      at: T0,
    });
    expect(minimal !== undefined && "decision" in minimal).toBe(false);
  });
});

describe("matchSignature", () => {
  it("六维全等 → matched 且 diffs 为空", () => {
    const result = matchSignature(sig(), sig());
    expect(result).toEqual({ matched: true, diffs: [] });
  });

  it("任一维不同 → 不匹配,并给出 <dim>:<a>≠<b>", () => {
    const result = matchSignature(sig(), sig({ phase: "verify" }));
    expect(result.matched).toBe(false);
    expect(result.diffs).toEqual(["phase:implement≠verify"]);
  });

  it("多维不同 → diffs 按 SIGNATURE_DIMENSIONS 顺序逐维列出", () => {
    const result = matchSignature(sig(), sig({ taskClass: "bug", modelVersion: "m2" }));
    expect(result.diffs).toEqual(["taskClass:feat≠bug", "modelVersion:m1≠m2"]);
  });

  it("近似模式放宽非版本维:phase 不同仍 matched,但 diffs 留痕", () => {
    const result = matchSignature(sig(), sig({ phase: "verify" }), { strict: false });
    expect(result.matched).toBe(true);
    expect(result.diffs).toEqual(["phase:implement≠verify"]);
  });

  it("近似模式:modelVersion 不同仍判 not-matched", () => {
    const result = matchSignature(sig(), sig({ modelVersion: "m2" }), { strict: false });
    expect(result.matched).toBe(false);
    expect(result.diffs).toEqual(["modelVersion:m1≠m2"]);
  });

  it("近似模式:providerVersion 不同仍判 not-matched", () => {
    expect(matchSignature(sig(), sig({ providerVersion: "p2" }), { strict: false }).matched).toBe(
      false,
    );
  });

  it("requireExact 可自定义:把 taskClass 列为强一致维", () => {
    const opts = { strict: false, requireExact: ["taskClass"] } as const;
    expect(matchSignature(sig(), sig({ taskClass: "bug" }), opts).matched).toBe(false);
    expect(matchSignature(sig(), sig({ modelVersion: "m2" }), opts).matched).toBe(true);
  });

  it("strict 显式为 true 时等同于缺省", () => {
    expect(matchSignature(sig(), sig({ phase: "verify" }), { strict: true }).matched).toBe(false);
  });
});

describe("buildBuckets", () => {
  it("桶内按状态计数,failed/interrupted/cancelled 都不丢", () => {
    const buckets = buildBuckets([
      sample({ id: "s1", status: "done" }),
      sample({ id: "s2", status: "failed" }),
      sample({ id: "s3", status: "interrupted" }),
      sample({ id: "s4", status: "cancelled" }),
      sample({ id: "s5", status: "done" }),
    ]);
    const key = signatureKey(sig());
    expect(Object.keys(buckets)).toEqual([key]);
    expect(buckets[key]?.counts).toEqual({ done: 2, failed: 1, interrupted: 1, cancelled: 1 });
    expect(buckets[key]?.samples).toHaveLength(5);
    expect(buckets[key]?.signature).toEqual(sig());
  });

  it("不同签名进不同桶", () => {
    const buckets = buildBuckets([
      sample({ id: "s1" }),
      sample({ id: "s2", signature: sig({ taskClass: "bug" }) }),
    ]);
    expect(Object.keys(buckets)).toHaveLength(2);
    expect(buckets[signatureKey(sig({ taskClass: "bug" }))]?.samples).toHaveLength(1);
  });

  it("非法样本跳过,不抛", () => {
    const dirty = [null, "x", {}, sample({ id: "s1" })] as unknown as SignatureSample[];
    expect(() => buildBuckets(dirty)).not.toThrow();
    const buckets = buildBuckets(dirty);
    const only = Object.keys(buckets);
    expect(only).toHaveLength(1);
    expect(buckets[only[0]!]?.samples).toHaveLength(1);
  });

  it("空数组给空记录", () => {
    expect(buildBuckets([])).toEqual({});
  });
});

describe("counterfactualPairs", () => {
  it("同桶两臂各 3 条 → 一个 pair,delta = meanB - meanA", () => {
    const result = counterfactualPairs([...arm("before", [4, 4, 4]), ...arm("after", [2, 2, 2])]);
    expect(result.candidates).toEqual([]);
    expect(result.pairs).toHaveLength(1);
    const pair = result.pairs[0]!;
    expect(pair.signatureKey).toBe(signatureKey(sig()));
    expect(pair.metric).toBe("turns");
    expect(pair.decisionA).toBe("after");
    expect(pair.decisionB).toBe("before");
    expect([pair.meanA, pair.meanB, pair.delta]).toEqual([2, 4, 2]);
    expect([pair.sampleA, pair.sampleB]).toEqual([3, 3]);
  });

  it("决策臂名排序决定 A/B 方位,delta 符号随之确定", () => {
    const result = counterfactualPairs([...arm("a", [1, 1, 1]), ...arm("z", [3, 3, 3])]);
    expect(result.pairs[0]?.decisionA).toBe("a");
    expect(result.pairs[0]?.delta).toBe(2);
  });

  it("跨桶永不配对", () => {
    const result = counterfactualPairs([
      ...arm("before", [4, 4, 4], { signature: sig({ taskClass: "feat" }) }),
      ...arm("after", [2, 2, 2], { signature: sig({ taskClass: "bug" }) }),
    ]);
    expect(result.pairs).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("每组仅 2 条 < minPerArm → candidates + CONF_INSUFFICIENT_SAMPLES", () => {
    const result = counterfactualPairs([...arm("before", [4, 4]), ...arm("after", [2, 2])]);
    expect(result.pairs).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.codes).toEqual(["CONF_INSUFFICIENT_SAMPLES"]);
    expect(result.candidates[0]?.reason).toContain("minPerArm=3");
    expect(result.codes).toEqual(["CONF_INSUFFICIENT_SAMPLES"]);
  });

  it("minPerArm 可下调,2 条也能配对", () => {
    const result = counterfactualPairs([...arm("before", [4, 4]), ...arm("after", [2, 2])], {
      minPerArm: 2,
    });
    expect(result.candidates).toEqual([]);
    expect(result.pairs).toHaveLength(1);
  });

  it("非 done 样本参与均值,并给该对记 CONF_INCLUDES_FAILURES", () => {
    const result = counterfactualPairs([
      ...arm("before", [2, 2, 2]),
      ...arm("after", [1, 3, 5], { status: "failed" }),
    ]);
    const pair = result.pairs[0]!;
    expect(pair.decisionA).toBe("after");
    expect(pair.meanA).toBe(3);
    expect(pair.meanB).toBe(2);
    expect(pair.codes).toEqual(["CONF_INCLUDES_FAILURES"]);
    expect(result.codes).toEqual(["CONF_MATCHED", "CONF_INCLUDES_FAILURES"]);
  });

  it("无 decision 的样本不参与配对", () => {
    const result = counterfactualPairs([
      ...arm("before", [4, 4, 4]),
      sample({ id: "n1" }),
      sample({ id: "n2" }),
      sample({ id: "n3" }),
    ]);
    expect(result.pairs).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("两臂指标不同则不混算:candidates 指出指标缺样本", () => {
    const result = counterfactualPairs([
      ...arm("before", [4, 4, 4], { metric: "turns" }),
      ...arm("after", [1, 1, 1], { metric: "tokens" }),
    ]);
    expect(result.pairs).toEqual([]);
    expect(result.candidates[0]?.reason).toContain("tokens");
  });
});

describe("evaluateComparison", () => {
  it("签名一致且样本够 → comparable + CONF_MATCHED", () => {
    const result = evaluateComparison(arm("a", [2, 2, 2]), arm("b", [1.5, 1.5, 1.5]));
    expect(result.verdict).toBe("comparable");
    expect(result.codes).toEqual(["CONF_MATCHED"]);
    expect(result.deltas).toEqual([
      { metric: "turns", a: 2, b: 1.5, delta: -0.5, withinTolerance: false },
    ]);
    expect(result.includesFailures).toEqual({ a: 0, b: 0 });
  });

  it("签名不匹配 → not-matched + CONF_NOT_MATCHED", () => {
    const result = evaluateComparison(
      arm("a", [2, 2, 2]),
      arm("b", [2, 2, 2], { signature: sig({ modelVersion: "m2" }) }),
    );
    expect(result.verdict).toBe("not-matched");
    expect(result.codes).toEqual(["CONF_NOT_MATCHED"]);
  });

  it("签名匹配但样本不足 → insufficient + CONF_INSUFFICIENT_SAMPLES", () => {
    const result = evaluateComparison(arm("a", [2, 2]), arm("b", [2, 2, 2]));
    expect(result.verdict).toBe("insufficient");
    expect(result.codes).toEqual(["CONF_INSUFFICIENT_SAMPLES"]);
  });

  it("任一侧含非 done → 两侧都带计数,并记 CONF_INCLUDES_FAILURES", () => {
    const result = evaluateComparison(
      [...arm("a", [2, 2, 2]), ...arm("a-failed", [9], { status: "failed" })],
      [...arm("b", [2, 2, 2]), ...arm("b-cancel", [9], { status: "cancelled" })],
    );
    expect(result.verdict).toBe("comparable");
    expect(result.includesFailures).toEqual({ a: 1, b: 1 });
    expect(result.codes).toEqual(["CONF_MATCHED", "CONF_INCLUDES_FAILURES"]);
  });

  it("metricTolerance 决定 withinTolerance", () => {
    const loose = evaluateComparison(arm("a", [2, 2, 2]), arm("b", [2.5, 2.5, 2.5]), {
      metricTolerance: 0.5,
    });
    expect(loose.deltas[0]?.withinTolerance).toBe(true);
    const tight = evaluateComparison(arm("a", [2, 2, 2]), arm("b", [2.5, 2.5, 2.5]), {
      metricTolerance: 0.1,
    });
    expect(tight.deltas[0]?.withinTolerance).toBe(false);
  });

  it("任一侧无样本 → insufficient(拿不到签名,不默默判可比)", () => {
    const result = evaluateComparison([], arm("b", [2, 2, 2]));
    expect(result.verdict).toBe("insufficient");
    expect(result.codes).toEqual(["CONF_INSUFFICIENT_SAMPLES"]);
    expect(result.deltas).toEqual([]);
  });

  it("strict:false 时放宽非版本维后可比", () => {
    const result = evaluateComparison(
      arm("a", [2, 2, 2]),
      arm("b", [3, 3, 3], { signature: sig({ phase: "verify" }) }),
      { strict: false },
    );
    expect(result.verdict).toBe("comparable");
  });
});

describe("stratifyByVersion", () => {
  it("按 modelVersion 分层,provider 去重排序,均值/计数/状态分布齐备", () => {
    const strata = stratifyByVersion([
      sample({ id: "s1", outcome: { metric: "turns", value: 2 } }),
      sample({ id: "s2", status: "failed", outcome: { metric: "turns", value: 4 } }),
      sample({ id: "s3", signature: sig({ providerVersion: "p2" }), outcome: { metric: "turns", value: 6 } }),
      sample({
        id: "s4",
        signature: sig({ modelVersion: "m2" }),
        status: "interrupted",
        outcome: { metric: "turns", value: 10 },
      }),
    ]);
    expect(Object.keys(strata)).toEqual(["m1", "m2"]);
    expect(strata["m1"]?.providerVersions).toEqual(["p1", "p2"]);
    expect(strata["m1"]?.metrics.mean).toBe(4);
    expect(strata["m1"]?.metrics.count).toBe(3);
    expect(strata["m1"]?.metrics.byStatus).toEqual({
      done: 2,
      failed: 1,
      interrupted: 0,
      cancelled: 0,
    });
    expect(strata["m2"]?.metrics.byStatus.interrupted).toBe(1);
  });

  it("缺 modelVersion → 落 unknown 层;空输入 → 空记录", () => {
    const strata = stratifyByVersion([sample({ id: "s1", signature: sig({ modelVersion: "" }) })]);
    expect(strata["unknown"]?.metrics.count).toBe(1);
    expect(stratifyByVersion([])).toEqual({});
  });
});

describe("detectVersionChange", () => {
  it("版本变化 → changed + 基线重估,旧版本实验标 stale", () => {
    const result = detectVersionChange({
      prev: { modelVersion: "m1", providerVersion: "p1" },
      next: { modelVersion: "m2", providerVersion: "p1" },
      experiments: [
        { id: "e1", signature: sig({ modelVersion: "m1" }) },
        { id: "e2", signature: sig({ modelVersion: "m2" }) },
      ],
    });
    expect(result.changed).toBe(true);
    expect(result.staleExperimentIds).toEqual(["e1"]);
    expect(result.codes).toEqual(["CONF_VERSION_STALE", "CONF_BASELINE_RESTIMATED"]);
  });

  it("版本不变 → changed false,无 stale,无码", () => {
    const result = detectVersionChange({
      prev: { modelVersion: "m1", providerVersion: "p1" },
      next: { modelVersion: "m1", providerVersion: "p1" },
      experiments: [{ id: "e1", signature: sig() }],
    });
    expect(result.changed).toBe(false);
    expect(result.staleExperimentIds).toEqual([]);
    expect(result.codes).toEqual([]);
  });

  it("providerVersion 变化也算基线变动", () => {
    const result = detectVersionChange({
      prev: { modelVersion: "m1", providerVersion: "p1" },
      next: { modelVersion: "m1", providerVersion: "p2" },
    });
    expect(result.changed).toBe(true);
    expect(result.codes).toEqual(["CONF_BASELINE_RESTIMATED"]);
  });

  it("无签名的实验无法核验版本 → 计入 stale,重复 id 只记一次", () => {
    const experiments = [
      { id: "e1" } as unknown as SignatureExperiment,
      { id: "e1", signature: sig({ modelVersion: "m1" }) } as SignatureExperiment,
    ];
    const result = detectVersionChange({
      prev: { modelVersion: "m1", providerVersion: "p1" },
      next: { modelVersion: "m2", providerVersion: "p1" },
      experiments,
    });
    expect(result.staleExperimentIds).toEqual(["e1"]);
  });
});

describe("markStale", () => {
  it("按目标版本切成 stale / active", () => {
    const result = markStale(
      [
        { id: "e1", signature: sig({ modelVersion: "m2" }) },
        { id: "e2", signature: sig({ modelVersion: "m1" }) },
        { id: "e3", signature: sig({ modelVersion: "m2", providerVersion: "p2" }) },
      ],
      { modelVersion: "m2", providerVersion: "p1" },
    );
    expect(result.active).toEqual(["e1"]);
    expect(result.stale).toEqual(["e2", "e3"]);
  });

  it("无签名实验归 stale,脏输入不抛", () => {
    const experiments = [null, { id: "e1" }] as unknown as SignatureExperiment[];
    expect(() => markStale(experiments, { modelVersion: "m1", providerVersion: "p1" })).not.toThrow();
    expect(markStale(experiments, { modelVersion: "m1", providerVersion: "p1" }).stale).toEqual([
      "e1",
    ]);
  });
});

describe("confounders", () => {
  it("四项恒在且顺序固定;单样本不触发任何因子", () => {
    const result = confounders([sample({ id: "s1", durationMs: 1000 })]);
    expect(result.items.map((item) => item.factor)).toEqual([
      "version",
      "project",
      "taskClass",
      "duration",
    ]);
    expect(result.items.every((item) => !item.present)).toBe(true);
    expect(result.items[1]?.detail).toBe("projects=0");
    expect(result.codes).toEqual([]);
  });

  it("model/provider 组合 > 1 → version 混杂", () => {
    const result = confounders([
      sample({ id: "s1" }),
      sample({ id: "s2", signature: sig({ providerVersion: "p2" }) }),
    ]);
    expect(result.items[0]).toMatchObject({ factor: "version", present: true, detail: "versions=2" });
    expect(result.codes).toEqual(["CONF_CONFOUNDERS_PRESENT"]);
  });

  it("多 project / 多 taskClass 各自触发", () => {
    const byProject = confounders([
      sample({ id: "s1", projectId: "proj-a" }),
      sample({ id: "s2", projectId: "proj-b" }),
    ]);
    expect(byProject.items[1]?.present).toBe(true);
    const byClass = confounders([
      sample({ id: "s1" }),
      sample({ id: "s2", signature: sig({ taskClass: "bug" }) }),
    ]);
    expect(byClass.items[2]?.present).toBe(true);
  });

  it("duration max/min > 2 → duration 混杂;比值 ≤ 2 不触发", () => {
    const wide = confounders([
      sample({ id: "s1", durationMs: 1000 }),
      sample({ id: "s2", durationMs: 5000 }),
    ]);
    expect(wide.items[3]).toMatchObject({ factor: "duration", present: true, detail: "durationRatio=5" });
    const narrow = confounders([
      sample({ id: "s1", durationMs: 1000 }),
      sample({ id: "s2", durationMs: 1800 }),
    ]);
    expect(narrow.items[3]?.present).toBe(false);
    expect(narrow.codes).toEqual([]);
  });
});

describe("survivorBias", () => {
  it("有样本但全 done → CONF_SURVIVOR_BIAS", () => {
    const result = survivorBias([sample({ id: "s1" }), sample({ id: "s2" })]);
    expect(result.biased).toBe(true);
    expect(result.excludedCount).toBe(0);
    expect(result.codes).toEqual(["CONF_SURVIVOR_BIAS"]);
  });

  it("含 failed → 不算有偏,并记 CONF_INCLUDES_FAILURES 与排除数", () => {
    const result = survivorBias([
      sample({ id: "s1" }),
      sample({ id: "s2", status: "failed" }),
      sample({ id: "s3", status: "interrupted" }),
    ]);
    expect(result.biased).toBe(false);
    expect(result.excludedCount).toBe(2);
    expect(result.codes).toEqual(["CONF_INCLUDES_FAILURES"]);
  });

  it("opts.excludedCount 叠加到排除数;空集合不判有偏", () => {
    expect(
      survivorBias([sample({ id: "s1" }), sample({ id: "s2", status: "cancelled" })], {
        excludedCount: 4,
      }).excludedCount,
    ).toBe(5);
    expect(survivorBias([]).biased).toBe(false);
  });
});

describe("assertSampleSet", () => {
  it("空集合不可用 + CONF_INVALID", () => {
    expect(assertSampleSet([])).toEqual({
      usable: false,
      accepted: 0,
      invalid: 0,
      codes: ["CONF_INVALID"],
    });
  });

  it("全非法 → 不可用,invalid 计数", () => {
    const dirty = [null, "x", {}] as unknown as SignatureSample[];
    expect(assertSampleSet(dirty)).toEqual({
      usable: false,
      accepted: 0,
      invalid: 3,
      codes: ["CONF_INVALID"],
    });
  });

  it("非 done 计入 accepted 并带 CONF_INCLUDES_FAILURES", () => {
    const result = assertSampleSet([
      sample({ id: "s1" }),
      sample({ id: "s2", status: "failed" }),
    ]);
    expect(result).toEqual({
      usable: true,
      accepted: 2,
      invalid: 0,
      codes: ["CONF_INCLUDES_FAILURES"],
    });
  });

  it("部分脏条 → 可用但带 CONF_INVALID", () => {
    const dirty = [sample({ id: "s1" }), null] as unknown as SignatureSample[];
    expect(assertSampleSet(dirty)).toEqual({
      usable: true,
      accepted: 1,
      invalid: 1,
      codes: ["CONF_INVALID"],
    });
  });
});

describe("脏输入不抛", () => {
  const dirty = [null, "x", 42, {}, { id: "s1" }, sample({ id: "s2" })] as unknown as SignatureSample[];

  it("全函数在脏数组上不抛", () => {
    expect(() => buildBuckets(dirty)).not.toThrow();
    expect(() => counterfactualPairs(dirty)).not.toThrow();
    expect(() => evaluateComparison(dirty, dirty)).not.toThrow();
    expect(() => stratifyByVersion(dirty)).not.toThrow();
    expect(() => confounders(dirty)).not.toThrow();
    expect(() => survivorBias(dirty)).not.toThrow();
    expect(() => assertSampleSet(dirty)).not.toThrow();
  });

  it("非数组入参当空集合处理", () => {
    const notList = null as unknown as SignatureSample[];
    expect(buildBuckets(notList)).toEqual({});
    expect(counterfactualPairs(notList).pairs).toEqual([]);
    expect(evaluateComparison(notList, notList).verdict).toBe("insufficient");
    expect(confounders(notList).items).toHaveLength(4);
  });

  it("同输入两次结果一致(确定性)", () => {
    const samples = [...arm("before", [4, 6, 5]), ...arm("after", [2, 3, 2])];
    expect(counterfactualPairs(samples)).toEqual(counterfactualPairs(samples));
    expect(evaluateComparison(samples, samples)).toEqual(evaluateComparison(samples, samples));
  });
});
