/**
 * 一次通过率与缺陷逃逸度量(RSI #212):纯逻辑,零 IO。
 * 断言全部按 cohort-metrics.ts 的真实行为:显式优先关联、隐式窗口、分桶(含 signature)、
 * 五项指标公式、前后对比判据、复审清单与审计行。
 */
import { describe, expect, it } from "vitest";
import {
  COHORT_CODES,
  COHORT_DEFECT_CLASSES,
  COHORT_DISCOVERY_STAGES,
  COHORT_VERSION,
  compareBeforeAfter,
  computeCohortMetrics,
  linkFixes,
  reviewList,
  toAuditRows,
} from "../src/agent/cohort-metrics.ts";
import type {
  CohortKey,
  CohortMetrics,
  DeliveryRecord,
  FixRecord,
} from "../src/agent/cohort-metrics.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

function delivery(over: Partial<DeliveryRecord> & { id: string }): DeliveryRecord {
  return {
    taskId: `task-${over.id}`,
    module: "mod-a",
    taskClass: "feat",
    boardType: "code",
    at: T0,
    ...over,
  };
}

function fix(over: Partial<FixRecord> & { id: string }): FixRecord {
  return {
    taskId: `task-${over.id}`,
    module: "mod-a",
    at: T0 + DAY,
    foundAt: "ci",
    ...over,
  };
}

/** 手工拼一个桶(前后对比 / 复审清单 / 审计行用例用,不依赖 compute)。 */
function cohort(
  over: Omit<Partial<CohortMetrics>, "key"> & { key?: Partial<CohortKey> } = {},
): CohortMetrics {
  const key: CohortKey = { module: "mod-a", taskClass: "feat", boardType: "code", ...(over.key ?? {}) };
  const base: CohortMetrics = {
    key,
    deliveries: 5,
    escapes: 0,
    firstPassRate: 0.6,
    escapeRate: 0.4,
    escapeClasses: {},
    fanoutReworkRate: null,
    discoveryDelay: { medianDays: null, byStage: {} },
    sampleSufficient: true,
  };
  return { ...base, ...over, key };
}

function keyOf(metrics: CohortMetrics): string {
  return [
    metrics.key.module,
    metrics.key.taskClass,
    metrics.key.boardType,
    metrics.key.signature ?? "",
  ].join("/");
}

describe("linkFixes", () => {
  it("显式 relatedDeliveryId 命中即关联,即使远在窗口外", () => {
    const result = linkFixes({
      deliveries: [delivery({ id: "d1", at: T0 })],
      fixes: [fix({ id: "f1", at: T0 + 400 * DAY, relatedDeliveryId: "d1" })],
    });
    expect(result.linked).toHaveLength(1);
    expect(result.linked[0]!.delivery.id).toBe("d1");
    expect(result.linked[0]!.fix.id).toBe("f1");
    expect(result.unlinked).toHaveLength(0);
  });

  it("显式 id 查不到时退回隐式:同 module 窗口内仍有交付则仍关联", () => {
    const result = linkFixes({
      deliveries: [delivery({ id: "d1", at: T0 })],
      fixes: [fix({ id: "f1", at: T0 + 3 * DAY, relatedDeliveryId: "missing-id" })],
    });
    expect(result.linked).toHaveLength(1);
    expect(result.linked[0]!.delivery.id).toBe("d1");
    expect(result.unlinked).toHaveLength(0);
  });

  it("隐式边界:fix.at 恰为 delivery.at + windowDays 仍关联", () => {
    const result = linkFixes({
      deliveries: [delivery({ id: "d1", at: T0 })],
      fixes: [fix({ id: "f1", at: T0 + 7 * DAY })],
    }, { windowDays: 7 });
    expect(result.linked).toHaveLength(1);
    expect(result.linked[0]!.delivery.id).toBe("d1");
    expect(result.unlinked).toHaveLength(0);
  });

  it("超窗一天(> windowDays)不关联,记进 unlinked", () => {
    const result = linkFixes({
      deliveries: [delivery({ id: "d1", at: T0 })],
      fixes: [fix({ id: "f1", at: T0 + 7 * DAY + 1 })],
    }, { windowDays: 7 });
    expect(result.linked).toHaveLength(0);
    expect(result.unlinked).toHaveLength(1);
    expect(result.unlinked[0]!.id).toBe("f1");
    expect(result.codes).toContain("COHORT_UNLINKED_FIX");
  });

  it("跨 module 不关联", () => {
    const result = linkFixes({
      deliveries: [delivery({ id: "d1", module: "mod-a", at: T0 })],
      fixes: [fix({ id: "f1", module: "mod-b", at: T0 + 1 * DAY })],
    });
    expect(result.linked).toHaveLength(0);
    expect(result.unlinked).toHaveLength(1);
  });

  it("同 module 多条候选取最近一次交付", () => {
    const result = linkFixes({
      deliveries: [
        delivery({ id: "d-old", at: T0 }),
        delivery({ id: "d-new", at: T0 + 5 * DAY }),
        delivery({ id: "d-future", at: T0 + 20 * DAY }),
      ],
      fixes: [fix({ id: "f1", at: T0 + 10 * DAY })],
    });
    expect(result.linked).toHaveLength(1);
    expect(result.linked[0]!.delivery.id).toBe("d-new");
  });

  it("同一 fix 只归一个 delivery:结果唯一且 fix 只出现一次", () => {
    const result = linkFixes({
      deliveries: [
        delivery({ id: "d1", at: T0 }),
        delivery({ id: "d2", at: T0 + DAY }),
        delivery({ id: "d3", at: T0 + 2 * DAY }),
      ],
      fixes: [fix({ id: "f1", at: T0 + 3 * DAY }), fix({ id: "f2", at: T0 + 4 * DAY })],
    }, { windowDays: 14 });
    expect(result.linked).toHaveLength(2);
    const fixIds = result.linked.map((pair) => pair.fix.id);
    expect(new Set(fixIds).size).toBe(2);
    expect(result.linked.find((pair) => pair.fix.id === "f1")!.delivery.id).toBe("d3");
    expect(result.unlinked).toHaveLength(0);
  });

  it("非法记录(缺 id / at / module)计数进 skipped 且不抛", () => {
    const bad = [
      { taskId: "t", module: "mod-a", at: T0 },
      { id: "d2", taskId: "t", module: "mod-a" },
      { id: "d3", taskId: "t", at: T0 },
      { id: "d4", taskId: "t", module: "mod-a", at: "not-a-number" },
    ];
    let result: ReturnType<typeof linkFixes> | undefined;
    expect(() => {
      result = linkFixes({
        deliveries: [delivery({ id: "d1", at: T0 }), ...bad],
        fixes: [{ id: "" }, { at: T0, module: "mod-a" }],
      });
    }).not.toThrow();
    expect(result!.skipped).toBe(6);
    expect(result!.linked).toHaveLength(0);
  });

  it("codes 同时含 COHORT_ESCAPE_LINKED 与 COHORT_UNLINKED_FIX", () => {
    const result = linkFixes({
      deliveries: [delivery({ id: "d1", module: "mod-a", at: T0 })],
      fixes: [
        fix({ id: "f1", module: "mod-a", at: T0 + DAY, relatedDeliveryId: "d1" }),
        fix({ id: "f2", module: "mod-z", at: T0 + DAY }),
      ],
    });
    expect(result.linked).toHaveLength(1);
    expect(result.unlinked).toHaveLength(1);
    expect(result.codes).toContain("COHORT_ESCAPE_LINKED");
    expect(result.codes).toContain("COHORT_UNLINKED_FIX");
    // 固定顺序:COHORT_ESCAPE_LINKED 先于 COHORT_UNLINKED_FIX
    expect(result.codes.indexOf("COHORT_ESCAPE_LINKED")).toBeLessThan(
      result.codes.indexOf("COHORT_UNLINKED_FIX"),
    );
  });

  it("无任何记录时 codes 归一为 COHORT_OK", () => {
    const result = linkFixes({});
    expect(result.linked).toHaveLength(0);
    expect(result.unlinked).toHaveLength(0);
    expect(result.skipped).toBe(0);
    expect(result.codes).toEqual(["COHORT_OK"]);
  });
});

describe("computeCohortMetrics", () => {
  it("按 module+taskClass+boardType 分桶:不同 taskClass 分两桶", () => {
    const result = computeCohortMetrics({
      deliveries: [
        delivery({ id: "d1", taskClass: "feat" }),
        delivery({ id: "d2", taskClass: "fix" }),
      ],
    });
    expect(result.cohorts).toHaveLength(2);
    expect(result.cohorts.map((c) => c.key.taskClass)).toEqual(["feat", "fix"]);
    expect(result.cohorts.every((c) => c.deliveries === 1)).toBe(true);
  });

  it("signature 参与分桶:不同 signature 两桶,且无条件桶与带签名桶不混", () => {
    const result = computeCohortMetrics({
      deliveries: [
        delivery({ id: "d1", signature: "s1" }),
        delivery({ id: "d2", signature: "s2" }),
        delivery({ id: "d3" }),
      ],
    });
    expect(result.cohorts).toHaveLength(3);
    expect(result.cohorts.map((c) => c.key.signature ?? "")).toEqual(["", "s1", "s2"]);
    expect(result.cohorts.map((c) => c.deliveries)).toEqual([1, 1, 1]);
  });

  it("firstPassRate 与 escapeRate:4 交付 1 逃逸 → 0.75 / 0.25", () => {
    const result = computeCohortMetrics({
      deliveries: [
        delivery({ id: "d1", at: T0 }),
        delivery({ id: "d2", at: T0 + 30 * DAY }),
        delivery({ id: "d3", at: T0 + 60 * DAY }),
        delivery({ id: "d4", at: T0 + 90 * DAY }),
      ],
      fixes: [fix({ id: "f1", at: T0 + DAY, relatedDeliveryId: "d1" })],
    });
    const only = result.cohorts[0]!;
    expect(only.deliveries).toBe(4);
    expect(only.escapes).toBe(1);
    expect(only.firstPassRate).toBe(0.75);
    expect(only.escapeRate).toBe(0.25);
  });

  it("同一交付被 2 条 fix 关联 → escapes=2、escapeRate=0.5", () => {
    const result = computeCohortMetrics({
      deliveries: [
        delivery({ id: "d1", at: T0 }),
        delivery({ id: "d2", at: T0 + 30 * DAY }),
        delivery({ id: "d3", at: T0 + 60 * DAY }),
        delivery({ id: "d4", at: T0 + 90 * DAY }),
      ],
      fixes: [
        fix({ id: "f1", at: T0 + DAY, relatedDeliveryId: "d1" }),
        fix({ id: "f2", at: T0 + 2 * DAY, relatedDeliveryId: "d1" }),
      ],
    });
    const only = result.cohorts[0]!;
    expect(only.escapes).toBe(2);
    expect(only.escapeRate).toBe(0.5);
    expect(only.firstPassRate).toBe(0.5);
  });

  it("escapeClasses 按 defectClass 计数,缺 defectClass 记 other", () => {
    const result = computeCohortMetrics({
      deliveries: [
        delivery({ id: "d1", at: T0 }),
        delivery({ id: "d2", at: T0 + 30 * DAY }),
      ],
      fixes: [
        fix({ id: "f1", at: T0 + DAY, relatedDeliveryId: "d1", defectClass: "plan-coverage" }),
        fix({ id: "f2", at: T0 + 2 * DAY, relatedDeliveryId: "d1", defectClass: "plan-coverage" }),
        fix({ id: "f3", at: T0 + 3 * DAY, relatedDeliveryId: "d1" }),
      ],
    });
    expect(result.cohorts[0]!.escapeClasses).toEqual({ "plan-coverage": 2, other: 1 });
  });

  it("fanoutReworkRate = Σfix.changeNodes / Σdelivery.changeNodes(2/4 = 0.5)", () => {
    const result = computeCohortMetrics({
      deliveries: [
        delivery({ id: "d1", at: T0, changeNodes: 2 }),
        delivery({ id: "d2", at: T0 + 30 * DAY, changeNodes: 2 }),
      ],
      fixes: [fix({ id: "f1", at: T0 + DAY, relatedDeliveryId: "d1", changeNodes: 2 })],
    });
    expect(result.cohorts[0]!.fanoutReworkRate).toBe(0.5);
  });

  it("所有交付都缺 changeNodes → fanoutReworkRate === null(不是 NaN/Infinity)", () => {
    const result = computeCohortMetrics({
      deliveries: [
        delivery({ id: "d1", at: T0 }),
        delivery({ id: "d2", at: T0 + 30 * DAY }),
      ],
      fixes: [fix({ id: "f1", at: T0 + DAY, relatedDeliveryId: "d1" })],
    });
    const value = result.cohorts[0]!.fanoutReworkRate;
    expect(value).toBeNull();
    expect(Number.isFinite(value as number)).toBe(false);
  });

  it("discoveryDelay.medianDays 奇数样本取中位数(1/3/5 天 → 3)", () => {
    const result = computeCohortMetrics({
      deliveries: [
        delivery({ id: "d1", at: T0 }),
        delivery({ id: "d2", at: T0 + 100 * DAY }),
        delivery({ id: "d3", at: T0 + 200 * DAY }),
      ],
      fixes: [
        fix({ id: "f1", at: T0 + 1 * DAY, relatedDeliveryId: "d1" }),
        fix({ id: "f2", at: T0 + 103 * DAY, relatedDeliveryId: "d2" }),
        fix({ id: "f3", at: T0 + 205 * DAY, relatedDeliveryId: "d3" }),
      ],
    });
    expect(result.cohorts[0]!.discoveryDelay.medianDays).toBe(3);
  });

  it("discoveryDelay.medianDays 偶数样本取中间两数平均(1/2/3/4 天 → 2.5)", () => {
    const result = computeCohortMetrics({
      deliveries: [
        delivery({ id: "d1", at: T0 }),
        delivery({ id: "d2", at: T0 + 100 * DAY }),
        delivery({ id: "d3", at: T0 + 200 * DAY }),
        delivery({ id: "d4", at: T0 + 300 * DAY }),
      ],
      fixes: [
        fix({ id: "f1", at: T0 + 1 * DAY, relatedDeliveryId: "d1" }),
        fix({ id: "f2", at: T0 + 102 * DAY, relatedDeliveryId: "d2" }),
        fix({ id: "f3", at: T0 + 203 * DAY, relatedDeliveryId: "d3" }),
        fix({ id: "f4", at: T0 + 304 * DAY, relatedDeliveryId: "d4" }),
      ],
    });
    expect(result.cohorts[0]!.discoveryDelay.medianDays).toBe(2.5);
  });

  it("byStage 按 foundAt 分档计数,含 user-report,未知档位记 unknown", () => {
    const result = computeCohortMetrics({
      deliveries: [
        delivery({ id: "d1", at: T0 }),
        delivery({ id: "d2", at: T0 + 100 * DAY }),
        delivery({ id: "d3", at: T0 + 200 * DAY }),
        delivery({ id: "d4", at: T0 + 300 * DAY }),
      ],
      fixes: [
        { id: "f1", taskId: "t1", module: "mod-a", at: T0 + DAY, relatedDeliveryId: "d1", foundAt: "ci" },
        { id: "f2", taskId: "t2", module: "mod-a", at: T0 + 101 * DAY, relatedDeliveryId: "d2", foundAt: "ci" },
        { id: "f3", taskId: "t3", module: "mod-a", at: T0 + 201 * DAY, relatedDeliveryId: "d3", foundAt: "user-report" },
        { id: "f4", taskId: "t4", module: "mod-a", at: T0 + 301 * DAY, relatedDeliveryId: "d4", foundAt: "nope" },
      ],
    });
    expect(result.cohorts[0]!.discoveryDelay.byStage).toEqual({ ci: 2, "user-report": 1, unknown: 1 });
  });

  it("deliveries < minDeliveries → sampleSufficient=false 且 codes 含 COHORT_SAMPLE_LOW", () => {
    const result = computeCohortMetrics({
      deliveries: [
        delivery({ id: "d1", at: T0 }),
        delivery({ id: "d2", at: T0 + 30 * DAY }),
        delivery({ id: "d3", at: T0 + 60 * DAY }),
        delivery({ id: "d4", at: T0 + 90 * DAY }),
      ],
    });
    expect(result.cohorts[0]!.deliveries).toBe(4);
    expect(result.cohorts[0]!.sampleSufficient).toBe(false);
    expect(result.codes).toContain("COHORT_SAMPLE_LOW");
  });

  it("deliveries === minDeliveries(自定义 2)→ sampleSufficient=true 且无 COHORT_SAMPLE_LOW", () => {
    const result = computeCohortMetrics({
      deliveries: [
        delivery({ id: "d1", at: T0 }),
        delivery({ id: "d2", at: T0 + 30 * DAY }),
      ],
    }, { minDeliveries: 2 });
    expect(result.cohorts[0]!.deliveries).toBe(2);
    expect(result.cohorts[0]!.sampleSufficient).toBe(true);
    expect(result.codes).not.toContain("COHORT_SAMPLE_LOW");
  });

  it("cohorts 按 module/taskClass/boardType/signature 字典序稳定排序", () => {
    const result = computeCohortMetrics({
      deliveries: [
        delivery({ id: "d6", module: "zeta", taskClass: "b", boardType: "x" }),
        delivery({ id: "d5", module: "alpha", taskClass: "b", boardType: "y" }),
        delivery({ id: "d3", module: "alpha", taskClass: "b", boardType: "x", signature: "zz" }),
        delivery({ id: "d2", module: "alpha", taskClass: "b", boardType: "x", signature: "aa" }),
        delivery({ id: "d4", module: "alpha", taskClass: "b", boardType: "x" }),
        delivery({ id: "d1", module: "alpha", taskClass: "a", boardType: "x" }),
      ],
    });
    expect(result.cohorts.map(keyOf)).toEqual([
      "alpha/a/x/",
      "alpha/b/x/",
      "alpha/b/x/aa",
      "alpha/b/x/zz",
      "alpha/b/y/",
      "zeta/b/x/",
    ]);
  });

  it("缺 taskClass / boardType 给默认 unknown", () => {
    const result = computeCohortMetrics({
      deliveries: [
        { id: "d1", taskId: "t1", module: "mod-a", at: T0 },
        { id: "d2", taskId: "t2", module: "mod-a", at: T0 + 30 * DAY, taskClass: "  ", boardType: null },
      ],
    });
    expect(result.cohorts).toHaveLength(1);
    expect(result.cohorts[0]!.key.taskClass).toBe("unknown");
    expect(result.cohorts[0]!.key.boardType).toBe("unknown");
    expect(result.cohorts[0]!.deliveries).toBe(2);
  });

  it("未关联的 fix 不进 escapes,但 codes 含 COHORT_UNLINKED_FIX", () => {
    const result = computeCohortMetrics({
      deliveries: [delivery({ id: "d1", module: "mod-a", at: T0 })],
      fixes: [fix({ id: "f1", module: "mod-z", at: T0 + DAY })],
    });
    expect(result.cohorts[0]!.escapes).toBe(0);
    expect(result.cohorts[0]!.escapeRate).toBe(0);
    expect(result.unlinked).toHaveLength(1);
    expect(result.codes).toContain("COHORT_UNLINKED_FIX");
  });

  it("非法记录只计 skipped,不抛异常", () => {
    let result: ReturnType<typeof computeCohortMetrics> | undefined;
    expect(() => {
      result = computeCohortMetrics({
        deliveries: [
          { id: "d1", taskId: "t1", module: "mod-a", at: T0 },
          { module: "mod-a", at: T0 },
          null,
          "junk",
        ],
        fixes: [{ id: "f1" }],
      });
    }).not.toThrow();
    expect(result!.cohorts).toHaveLength(1);
    expect(result!.skipped).toBe(4);
  });
});

describe("compareBeforeAfter", () => {
  it("提升 10 个百分点 → improved,且不出现 COHORT_REVIEW_REQUIRED / COHORT_OK", () => {
    const result = compareBeforeAfter({
      before: cohort({ firstPassRate: 0.6 }),
      after: cohort({ firstPassRate: 0.7 }),
    });
    expect(result.verdict).toBe("improved");
    expect(result.deltaPct).toBe(10);
    expect(result.codes).toContain("COHORT_IMPROVED");
    expect(result.codes).not.toContain("COHORT_REVIEW_REQUIRED");
    expect(result.codes).not.toContain("COHORT_OK");
  });

  it("恰好 +2 → improved(边界:magnitude >= minDeltaPct)", () => {
    const result = compareBeforeAfter({
      before: cohort({ firstPassRate: 0.5 }),
      after: cohort({ firstPassRate: 0.52 }),
    });
    expect(result.deltaPct).toBe(2);
    expect(result.verdict).toBe("improved");
    expect(result.codes).toContain("COHORT_IMPROVED");
  });

  it("+1.99 → flat + COHORT_REVIEW_REQUIRED", () => {
    const result = compareBeforeAfter({
      before: cohort({ firstPassRate: 0.5 }),
      after: cohort({ firstPassRate: 0.5199 }),
    });
    expect(result.deltaPct).toBe(1.99);
    expect(result.verdict).toBe("flat");
    expect(result.codes).toContain("COHORT_REVIEW_REQUIRED");
    expect(result.codes).not.toContain("COHORT_IMPROVED");
  });

  it("下降 → declined + COHORT_REVIEW_REQUIRED", () => {
    const result = compareBeforeAfter({
      before: cohort({ firstPassRate: 0.8 }),
      after: cohort({ firstPassRate: 0.6 }),
    });
    expect(result.verdict).toBe("declined");
    expect(result.deltaPct).toBe(-20);
    expect(result.codes).toContain("COHORT_REVIEW_REQUIRED");
    expect(result.codes).not.toContain("COHORT_IMPROVED");
  });

  it("自定义 minDeltaPct:5 时 +3 → flat", () => {
    const result = compareBeforeAfter({
      before: cohort({ firstPassRate: 0.5 }),
      after: cohort({ firstPassRate: 0.53 }),
    }, { minDeltaPct: 5 });
    expect(result.deltaPct).toBe(3);
    expect(result.verdict).toBe("flat");
    expect(result.codes).toContain("COHORT_REVIEW_REQUIRED");
  });

  it("before.sampleSufficient=false → codes 含 COHORT_NO_BASELINE", () => {
    const result = compareBeforeAfter({
      before: cohort({ firstPassRate: 0.5, deliveries: 2, sampleSufficient: false }),
      after: cohort({ firstPassRate: 0.5 }),
    });
    expect(result.verdict).toBe("flat");
    expect(result.codes).toContain("COHORT_NO_BASELINE");
  });
});

describe("reviewList", () => {
  it("improved 不进清单", () => {
    const items = reviewList([
      {
        before: cohort({ firstPassRate: 0.6 }),
        after: cohort({ firstPassRate: 0.7 }),
      },
    ]);
    expect(items).toHaveLength(0);
  });

  it("flat / declined 进清单,带前后样本数与原因(含「持平」/「下降」)", () => {
    const items = reviewList([
      {
        before: cohort({ firstPassRate: 0.6, deliveries: 6 }),
        after: cohort({ firstPassRate: 0.6, deliveries: 7 }),
      },
      {
        before: cohort({ firstPassRate: 0.8, deliveries: 8 }),
        after: cohort({ firstPassRate: 0.5, deliveries: 9 }),
      },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]!.verdict).toBe("flat");
    expect(items[0]!.beforeDeliveries).toBe(6);
    expect(items[0]!.afterDeliveries).toBe(7);
    expect(items[0]!.reason).toContain("持平");
    expect(items[1]!.verdict).toBe("declined");
    expect(items[1]!.beforeDeliveries).toBe(8);
    expect(items[1]!.afterDeliveries).toBe(9);
    expect(items[1]!.reason).toContain("下降");
  });

  it("signature 从 after / before key 带上", () => {
    const items = reviewList([
      {
        before: cohort({ key: { signature: "before-sig" }, firstPassRate: 0.6 }),
        after: cohort({ firstPassRate: 0.6 }),
      },
      {
        before: cohort({ firstPassRate: 0.6 }),
        after: cohort({ key: { signature: "after-sig" }, firstPassRate: 0.6 }),
      },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]!.signature).toBe("before-sig");
    expect(items[1]!.signature).toBe("after-sig");
  });
});

describe("toAuditRows", () => {
  it("字段齐全:module/taskClass/boardType/deliveries/escapes/四项比率/中位延迟/样本是否充分", () => {
    const computed = computeCohortMetrics({
      deliveries: [
        delivery({ id: "d1", at: T0, changeNodes: 2 }),
        delivery({ id: "d2", at: T0 + 30 * DAY, changeNodes: 2 }),
      ],
      fixes: [
        fix({ id: "f1", at: T0 + 2 * DAY, relatedDeliveryId: "d1", changeNodes: 1, foundAt: "ci" }),
      ],
    }, { minDeliveries: 2 });
    const rows = toAuditRows(computed.cohorts);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.module).toBe("mod-a");
    expect(row.taskClass).toBe("feat");
    expect(row.boardType).toBe("code");
    expect(row.deliveries).toBe(2);
    expect(row.escapes).toBe(1);
    expect(row.firstPassRate).toBe(0.5);
    expect(row.escapeRate).toBe(0.5);
    expect(row.fanoutReworkRate).toBe(0.25);
    expect(row.medianDiscoveryDays).toBe(2);
    expect(row.sampleSufficient).toBe(true);
  });

  it("signature 可选:有则出现,无则字段不存在", () => {
    const withSig = toAuditRows([
      cohort({ key: { signature: "sig-1" } }),
    ]);
    expect("signature" in withSig[0]!).toBe(true);
    expect(withSig[0]!.signature).toBe("sig-1");

    const withoutSig = toAuditRows([cohort()]);
    expect("signature" in withoutSig[0]!).toBe(false);

    const computed = toAuditRows(
      computeCohortMetrics({ deliveries: [delivery({ id: "d1" })] }).cohorts,
    );
    expect("signature" in computed[0]!).toBe(false);
  });

  it("defectClass 可选:有则出现,无则字段不存在", () => {
    const withClass = toAuditRows([cohort({ key: { defectClass: "other" } })]);
    expect("defectClass" in withClass[0]!).toBe(true);
    expect(withClass[0]!.defectClass).toBe("other");

    const plain = toAuditRows([cohort()]);
    expect("defectClass" in plain[0]!).toBe(false);
  });
});

describe("cohort-metrics 模块契约", () => {
  it("COHORT_VERSION === 1", () => {
    expect(COHORT_VERSION).toBe(1);
  });

  it("导出常量表与数据契约一致", () => {
    expect(COHORT_CODES).toContain("COHORT_OK");
    expect(COHORT_CODES).toContain("COHORT_NO_BASELINE");
    expect(COHORT_DEFECT_CLASSES).toContain("other");
    expect(COHORT_DISCOVERY_STAGES).toContain("user-report");
  });

  it("非法输入不抛:computeCohortMetrics({deliveries:'x'}) 返回空 cohorts", () => {
    let result: ReturnType<typeof computeCohortMetrics> | undefined;
    expect(() => {
      result = computeCohortMetrics({ deliveries: "x" });
    }).not.toThrow();
    expect(result!.cohorts).toEqual([]);
    expect(result!.codes).toEqual(["COHORT_OK"]);
    expect(result!.skipped).toBe(1);
  });
});
