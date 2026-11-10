/**
 * RSI 成本与 ROI 门(纯逻辑):聚合 / 分摊 / 净值 / 连续负周期门 / 采纳门 / 非法条目。
 * 全纯函数直测,不触 IO。
 */
import { describe, expect, it } from "vitest";
import {
  allocateByMechanism,
  allocateByProject,
  adoptRoiGate,
  cycleReport,
  evaluateRoiGate,
  RSI_COST_VERSION,
  RSI_ROI_ADOPT_BLOCKED,
  RSI_ROI_ADOPT_NO_MEASURED,
  RSI_ROI_CODES,
  RSI_ROI_DOWNSHIFT,
  RSI_ROI_ENTRY_INVALID,
  RSI_ROI_NEGATIVE_STREAK,
  RSI_ROI_OK,
  RSI_ROI_PAUSE,
  RSI_ROI_ZERO_COST,
  RSI_STAGES,
  RSI_UNASSIGNED_KEY,
  ROI_POLICY_DEFAULTS,
  sumCosts,
  sumSavings,
  summarizeCycles,
  type CostEntry,
  type CycleReport,
  type SavingEntry,
} from "../src/agent/rsi-cost-roi.ts";

let seq = 0;

function cost(partial: Partial<CostEntry> & { tokens?: Partial<CostEntry["tokens"]> } = {}): CostEntry {
  seq += 1;
  const input = partial.tokens?.input ?? 100;
  const output = partial.tokens?.output ?? 50;
  return {
    id: partial.id ?? `c${seq}`,
    cycleId: partial.cycleId ?? "cycle-1",
    at: partial.at ?? "2026-11-01T00:00:00.000Z",
    stage: partial.stage ?? "mining",
    mechanismId: partial.mechanismId,
    projectId: partial.projectId,
    model: partial.model,
    tokens: { input, output, total: partial.tokens?.total ?? input + output },
    wallMs: partial.wallMs ?? 1000,
    usd: partial.usd,
  };
}

function saving(partial: Partial<SavingEntry> = {}): SavingEntry {
  seq += 1;
  return {
    id: partial.id ?? `s${seq}`,
    cycleId: partial.cycleId ?? "cycle-1",
    at: partial.at ?? "2026-11-01T00:00:00.000Z",
    mechanismId: partial.mechanismId,
    projectId: partial.projectId,
    tokensSaved: partial.tokensSaved ?? 100,
    wallMsSaved: partial.wallMsSaved,
    usdSaved: partial.usdSaved,
    evidenceRefs: partial.evidenceRefs,
  };
}

function report(cycleId: string, costTokens: number, savingTokens: number, samples = 2): CycleReport {
  return {
    cycleId,
    costTokens,
    savingTokens,
    netTokens: savingTokens - costTokens,
    roi: costTokens > 0 ? savingTokens / costTokens : null,
    costByStage: {},
    costByMechanism: {},
    costByProject: {},
    wallMs: 0,
    entries: { costs: samples, savings: 0 },
    codes: [],
    invalid: 0,
  };
}

describe("const 与码表", () => {
  it("版本号与阶段枚举固定", () => {
    expect(RSI_COST_VERSION).toBe(1);
    expect([...RSI_STAGES]).toEqual(["mining", "attribution", "experiment", "retro", "other"]);
  });

  it("码表含 8 个稳定码且顺序固定", () => {
    expect(RSI_ROI_CODES).toEqual([
      "RSI_ROI_OK",
      "RSI_ROI_NEGATIVE_STREAK",
      "RSI_ROI_DOWNSHIFT",
      "RSI_ROI_PAUSE",
      "RSI_ROI_ENTRY_INVALID",
      "RSI_ROI_ZERO_COST",
      "RSI_ROI_ADOPT_BLOCKED",
      "RSI_ROI_ADOPT_NO_MEASURED",
    ]);
  });

  it("缺省策略:3 降频 / 6 停摆 / 0.5 因子 / 门槛 0.1", () => {
    expect(ROI_POLICY_DEFAULTS).toEqual({
      downshiftAfter: 3,
      pauseAfter: 6,
      downshiftFactor: 0.5,
      minCycleSamples: 1,
      adoptMinRoi: 0.1,
    });
  });
});

describe("sumCosts", () => {
  it("累加 tokens / wallMs / usd", () => {
    const agg = sumCosts([cost({ tokens: { input: 10, output: 5 }, wallMs: 100, usd: 0.2 }), cost({ tokens: { input: 20, output: 7 }, wallMs: 300, usd: 0.4 })]);
    expect(agg.tokens).toEqual({ input: 30, output: 12, total: 42 });
    expect(agg.wallMs).toBe(400);
    expect(agg.usd).toBeCloseTo(0.6, 10);
    expect(agg.valid).toBe(2);
    expect(agg.invalid).toBe(0);
  });

  it("缺 total 时按 input+output 兜底", () => {
    const agg = sumCosts([{ ...cost(), tokens: { input: 3, output: 4 } }]);
    expect(agg.tokens.total).toBe(7);
  });

  it("非法条目只计入 invalid(缺 id / cycleId / at / 坏 stage / 非有限 tokens / 负 wallMs)", () => {
    const good = cost();
    const bad: unknown[] = [
      { ...good, id: "" },
      { ...good, cycleId: undefined },
      { ...good, at: "" },
      { ...good, stage: "unknown-stage" },
      { ...good, tokens: { input: Number.NaN, output: 1, total: 1 } },
      { ...good, wallMs: -1 },
      { ...good, tokens: { input: 1, output: 1, total: Number.POSITIVE_INFINITY } },
      null,
      42,
    ];
    const agg = sumCosts([good, ...bad]);
    expect(agg.valid).toBe(1);
    expect(agg.invalid).toBe(bad.length);
    expect(agg.tokens.total).toBe(150);
  });

  it("空输入 / undefined / 非数组 → 全零", () => {
    for (const input of [[], undefined, null as unknown as unknown[], "x" as unknown as unknown[]]) {
      const agg = sumCosts(input);
      expect(agg.tokens).toEqual({ input: 0, output: 0, total: 0 });
      expect(agg.valid).toBe(0);
      expect(agg.invalid).toBe(0);
    }
  });
});

describe("sumSavings", () => {
  it("tokens 只填 total,input/output 恒 0", () => {
    const agg = sumSavings([saving({ tokensSaved: 30, wallMsSaved: 50, usdSaved: 0.1 }), saving({ tokensSaved: 20 })]);
    expect(agg.tokens).toEqual({ input: 0, output: 0, total: 50 });
    expect(agg.wallMs).toBe(50);
    expect(agg.usd).toBeCloseTo(0.1, 10);
    expect(agg.valid).toBe(2);
  });

  it("非法节省条目计入 invalid(tokensSaved 非有限 / 负 / 缺 cycleId)", () => {
    const bad: unknown[] = [
      { ...saving(), tokensSaved: Number.NaN },
      { ...saving(), tokensSaved: -1 },
      { ...saving(), cycleId: "" },
      { ...saving(), at: undefined },
    ];
    const agg = sumSavings([saving(), ...bad]);
    expect(agg.valid).toBe(1);
    expect(agg.invalid).toBe(4);
  });

  it("空输入全零", () => {
    expect(sumSavings([]).tokens.total).toBe(0);
    expect(sumSavings(undefined).valid).toBe(0);
  });
});

describe("cycleReport", () => {
  it("只取该 cycleId 的条目", () => {
    const costs = [cost({ cycleId: "cycle-1", tokens: { input: 10, output: 10 } }), cost({ cycleId: "cycle-2", tokens: { input: 99, output: 99 } })];
    const savings = [saving({ cycleId: "cycle-1", tokensSaved: 5 }), saving({ cycleId: "cycle-2", tokensSaved: 500 })];
    const r = cycleReport({ cycleId: "cycle-1", costs, savings });
    expect(r.costTokens).toBe(20);
    expect(r.savingTokens).toBe(5);
    expect(r.netTokens).toBe(-15);
    expect(r.roi).toBeCloseTo(0.25, 10);
    expect(r.entries).toEqual({ costs: 1, savings: 1 });
  });

  it("costByStage 覆盖全部阶段键(缺失补 0)", () => {
    const r = cycleReport({
      cycleId: "cycle-1",
      costs: [cost({ stage: "mining", tokens: { input: 10, output: 0 } }), cost({ stage: "retro", tokens: { input: 5, output: 0 } })],
    });
    expect(Object.keys(r.costByStage).sort()).toEqual([...RSI_STAGES].sort());
    expect(r.costByStage["mining"]).toBe(10);
    expect(r.costByStage["retro"]).toBe(5);
    expect(r.costByStage["attribution"]).toBe(0);
  });

  it("按机制与项目分摊(缺省键 (unassigned))", () => {
    const costs = [
      cost({ mechanismId: "m1", projectId: "p1", tokens: { input: 10, output: 0 } }),
      cost({ mechanismId: "m1", projectId: "p2", tokens: { input: 5, output: 0 } }),
      cost({ tokens: { input: 1, output: 0 } }),
    ];
    const r = cycleReport({ cycleId: "cycle-1", costs });
    expect(r.costByMechanism).toEqual({ m1: 15, [RSI_UNASSIGNED_KEY]: 1 });
    expect(r.costByProject).toEqual({ p1: 10, p2: 5, [RSI_UNASSIGNED_KEY]: 1 });
  });

  it("costTokens=0 → roi=null 且 codes 含 RSI_ROI_ZERO_COST(净额照算)", () => {
    const r = cycleReport({ cycleId: "cycle-1", savings: [saving({ tokensSaved: 40 })] });
    expect(r.roi).toBeNull();
    expect(r.netTokens).toBe(40);
    expect(r.codes).toContain(RSI_ROI_ZERO_COST);
  });

  it("非法条目按周期计入 invalid 并带 RSI_ROI_ENTRY_INVALID", () => {
    const costs = [cost({ cycleId: "cycle-1" }), { ...cost({ cycleId: "cycle-1" }), stage: "nope" }, { ...cost({ cycleId: "cycle-2" }), stage: "nope" }];
    const r = cycleReport({ cycleId: "cycle-1", costs });
    expect(r.invalid).toBe(1);
    expect(r.entries.costs).toBe(1);
    expect(r.codes).toContain(RSI_ROI_ENTRY_INVALID);
  });

  it("空周期 → 全零 + roi null", () => {
    const r = cycleReport({ cycleId: "cycle-x", costs: [], savings: [] });
    expect(r.costTokens).toBe(0);
    expect(r.savingTokens).toBe(0);
    expect(r.netTokens).toBe(0);
    expect(r.roi).toBeNull();
    expect(r.entries).toEqual({ costs: 0, savings: 0 });
  });

  it("wallMs = 花费墙钟 + 节省墙钟", () => {
    const r = cycleReport({
      cycleId: "cycle-1",
      costs: [cost({ wallMs: 700 })],
      savings: [saving({ wallMsSaved: 300 })],
    });
    expect(r.wallMs).toBe(1000);
  });

  it("不抛(垃圾输入):非对象条目无法归属周期,有 cycleId 但字段坏的计 invalid", () => {
    const r = cycleReport({
      cycleId: "c",
      costs: [null, 1, "x", { cycleId: "c" }, { cycleId: "c", id: "z", at: "", stage: "mining" }] as unknown[],
      savings: undefined,
    });
    expect(r.cycleId).toBe("c");
    expect(r.invalid).toBe(2);
    expect(r.costTokens).toBe(0);
    const empty = cycleReport({ cycleId: "", costs: [null] as unknown[], savings: [] });
    expect(empty.cycleId).toBe("");
    expect(empty.invalid).toBe(0);
  });
});

describe("summarizeCycles", () => {
  it("按传入顺序出报告并合计", () => {
    const costs = [cost({ cycleId: "a", stage: "mining", tokens: { input: 10, output: 0 } }), cost({ cycleId: "b", stage: "retro", tokens: { input: 20, output: 0 } })];
    const savings = [saving({ cycleId: "a", tokensSaved: 5 }), saving({ cycleId: "b", tokensSaved: 40 })];
    const { reports, total } = summarizeCycles(["a", "b"], costs, savings);
    expect(reports.map((r) => r.cycleId)).toEqual(["a", "b"]);
    expect(total.costTokens).toBe(30);
    expect(total.savingTokens).toBe(45);
    expect(total.netTokens).toBe(15);
    expect(total.roi).toBeCloseTo(1.5, 10);
    expect(total.costByStage["mining"]).toBe(10);
    expect(total.costByStage["retro"]).toBe(20);
  });

  it("total 合并非零机制/项目键", () => {
    const costs = [cost({ cycleId: "a", mechanismId: "m1", projectId: "p1" }), cost({ cycleId: "b", mechanismId: "m1" })];
    const { total } = summarizeCycles(["a", "b"], costs, []);
    expect(total.costByMechanism["m1"]).toBe(300);
    expect(total.costByProject["p1"]).toBe(150);
    expect(total.costByProject[RSI_UNASSIGNED_KEY]).toBe(150);
  });

  it("空周期列表 → 空报告 + 零合计 + roi null", () => {
    const { reports, total } = summarizeCycles([], [], []);
    expect(reports).toEqual([]);
    expect(total.costTokens).toBe(0);
    expect(total.roi).toBeNull();
  });
});

describe("evaluateRoiGate", () => {
  it("0 负周期 → ok", () => {
    const gate = evaluateRoiGate([report("a", 10, 20), report("b", 10, 15)]);
    expect(gate.action).toBe("ok");
    expect(gate.codes).toEqual([RSI_ROI_OK]);
    expect(gate.negativeStreak).toBe(0);
    expect(gate.quota).toEqual({});
  });

  it("连续 3 个负周期 → downshift,两因子 0.5", () => {
    const gate = evaluateRoiGate([report("a", 10, 1), report("b", 10, 2), report("c", 10, 3)]);
    expect(gate.action).toBe("downshift");
    expect(gate.codes).toEqual([RSI_ROI_NEGATIVE_STREAK, RSI_ROI_DOWNSHIFT]);
    expect(gate.negativeStreak).toBe(3);
    expect(gate.quota).toEqual({ nightlyWindowFactor: 0.5, experimentQuotaFactor: 0.5 });
  });

  it("连续 2 个负周期 → 仍 ok", () => {
    const gate = evaluateRoiGate([report("a", 10, 1), report("b", 10, 1)]);
    expect(gate.action).toBe("ok");
    expect(gate.negativeStreak).toBe(2);
  });

  it("第 6 个负周期 → pause 优先,codes 只含 [NEGATIVE_STREAK, PAUSE],配额照给", () => {
    const reports = ["a", "b", "c", "d", "e", "f"].map((id) => report(id, 10, 1));
    const gate = evaluateRoiGate(reports);
    expect(gate.action).toBe("pause");
    expect(gate.codes).toEqual([RSI_ROI_NEGATIVE_STREAK, RSI_ROI_PAUSE]);
    expect(gate.codes).not.toContain(RSI_ROI_DOWNSHIFT);
    expect(gate.negativeStreak).toBe(6);
    expect(gate.quota).toEqual({ nightlyWindowFactor: 0.5, experimentQuotaFactor: 0.5 });
  });

  it("末尾连续语义:中间转正即断开", () => {
    const gate = evaluateRoiGate([report("a", 10, 1), report("b", 10, 1), report("c", 10, 20)]);
    expect(gate.negativeStreak).toBe(0);
    expect(gate.action).toBe("ok");
  });

  it("只有末尾两连负 → streak=2(旧的亏损不算连续)", () => {
    const gate = evaluateRoiGate([report("a", 10, 1), report("b", 10, 30), report("c", 10, 1), report("d", 10, 1)]);
    expect(gate.negativeStreak).toBe(2);
  });

  it("netTokens===0 不算负且中断 streak", () => {
    const gate = evaluateRoiGate([report("a", 10, 1), report("b", 10, 1), report("c", 10, 10), report("d", 10, 1)]);
    expect(gate.negativeStreak).toBe(1);
    expect(gate.action).toBe("ok");
  });

  it("末尾 netTokens=0 直接清零", () => {
    const gate = evaluateRoiGate([report("a", 10, 1), report("b", 10, 1), report("c", 10, 10)]);
    expect(gate.negativeStreak).toBe(0);
  });

  it("自定义策略:downshiftAfter=1 → 单负即降频,因子按策略给", () => {
    const gate = evaluateRoiGate([report("a", 10, 1)], { downshiftAfter: 1, pauseAfter: 2, downshiftFactor: 0.25 });
    expect(gate.action).toBe("downshift");
    expect(gate.quota).toEqual({ nightlyWindowFactor: 0.25, experimentQuotaFactor: 0.25 });
  });

  it("minCycleSamples=2 时样本不足的周期被跳过,不打断 streak", () => {
    const thin = report("thin", 10, 1, 0);
    const gate = evaluateRoiGate([report("a", 10, 1), thin, report("b", 10, 1), report("c", 10, 1)], { minCycleSamples: 2 });
    expect(gate.negativeStreak).toBe(3);
    expect(gate.action).toBe("downshift");
  });

  it("detail 是中文人读串且含 streak 与阈值", () => {
    const gate = evaluateRoiGate([report("a", 10, 1), report("b", 10, 1), report("c", 10, 1)]);
    expect(gate.detail).toContain("3");
    expect(gate.detail).toContain("降频阈值 3");
  });

  it("空报告 / undefined 不抛 → ok", () => {
    expect(evaluateRoiGate([]).action).toBe("ok");
    expect(evaluateRoiGate(undefined).negativeStreak).toBe(0);
  });
});

describe("adoptRoiGate", () => {
  it("缺 measuredRoi → NO_MEASURED", () => {
    const gate = adoptRoiGate({ estimateRoi: 0.5 });
    expect(gate.ok).toBe(false);
    expect(gate.codes).toEqual([RSI_ROI_ADOPT_NO_MEASURED]);
  });

  it("measuredRoi 非有限 → NO_MEASURED", () => {
    const gate = adoptRoiGate({ measuredRoi: Number.NaN });
    expect(gate.codes).toEqual([RSI_ROI_ADOPT_NO_MEASURED]);
  });

  it("measuredRoi < 0.1 → BLOCKED", () => {
    const gate = adoptRoiGate({ measuredRoi: 0.05 });
    expect(gate.ok).toBe(false);
    expect(gate.codes).toEqual([RSI_ROI_ADOPT_BLOCKED]);
  });

  it("estimateRoi 为负(即使实测达标)→ BLOCKED", () => {
    const gate = adoptRoiGate({ estimateRoi: -0.2, measuredRoi: 0.3 });
    expect(gate.ok).toBe(false);
    expect(gate.codes).toEqual([RSI_ROI_ADOPT_BLOCKED]);
  });

  it("两关都过 → ok", () => {
    const gate = adoptRoiGate({ estimateRoi: 0.2, measuredRoi: 0.3 });
    expect(gate.ok).toBe(true);
    expect(gate.codes).toEqual([RSI_ROI_OK]);
  });

  it("自定义 minRoi 生效", () => {
    expect(adoptRoiGate({ measuredRoi: 0.2, minRoi: 0.5 }).codes).toEqual([RSI_ROI_ADOPT_BLOCKED]);
    expect(adoptRoiGate({ measuredRoi: 0.2, minRoi: 0.1 }).ok).toBe(true);
  });

  it("边界:measuredRoi===minRoi 放行", () => {
    expect(adoptRoiGate({ measuredRoi: 0.1 }).ok).toBe(true);
  });
});

describe("allocateByMechanism / allocateByProject", () => {
  const costs = [
    cost({ mechanismId: "m1", projectId: "p1", tokens: { input: 100, output: 0 }, wallMs: 10, usd: 0.1 }),
    cost({ mechanismId: "m1", projectId: "p2", tokens: { input: 50, output: 0 }, wallMs: 5, usd: 0.05 }),
    cost({ mechanismId: "m2", projectId: "p1", tokens: { input: 200, output: 0 }, wallMs: 20, usd: 0.2 }),
  ];
  const savings = [
    saving({ mechanismId: "m1", projectId: "p1", tokensSaved: 400, wallMsSaved: 40, usdSaved: 0.4 }),
    saving({ mechanismId: "m2", projectId: "p1", tokensSaved: 10, wallMsSaved: 1, usdSaved: 0.01 }),
  ];

  it("按机制聚合,net 允许为负", () => {
    const rows = allocateByMechanism(costs, savings);
    const m1 = rows.find((r) => r.key === "m1");
    expect(m1).toMatchObject({ costTokens: 150, savingTokens: 400, netTokens: 250, costWallMs: 15, savingWallMs: 40, entries: 3 });
    const m2 = rows.find((r) => r.key === "m2");
    expect(m2).toMatchObject({ costTokens: 200, savingTokens: 10, netTokens: -190, entries: 2 });
    expect(m2?.usd).toBeCloseTo(0.2, 10);
    expect(m2?.usdSaved).toBeCloseTo(0.01, 10);
  });

  it("costTokens 降序", () => {
    expect(allocateByMechanism(costs, savings).map((r) => r.key)).toEqual(["m2", "m1"]);
  });

  it("同 costTokens 时 key 升序", () => {
    const rows = allocateByMechanism(
      [cost({ mechanismId: "zeta", tokens: { input: 10, output: 0 } }), cost({ mechanismId: "alpha", tokens: { input: 10, output: 0 } })],
      [],
    );
    expect(rows.map((r) => r.key)).toEqual(["alpha", "zeta"]);
  });

  it("缺省键是 (unassigned)", () => {
    const rows = allocateByMechanism([cost({ tokens: { input: 7, output: 0 } })], [saving({ tokensSaved: 3 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(RSI_UNASSIGNED_KEY);
    expect(rows[0].netTokens).toBe(-4);
  });

  it("按项目聚合", () => {
    const rows = allocateByProject(costs, savings);
    expect(rows.map((r) => r.key)).toEqual(["p1", "p2"]);
    expect(rows[0]).toMatchObject({ costTokens: 300, savingTokens: 410, netTokens: 110, entries: 4 });
    expect(rows[1]).toMatchObject({ costTokens: 50, savingTokens: 0, netTokens: -50 });
  });

  it("非法条目被跳过,空输入 → 空数组", () => {
    expect(allocateByMechanism([{ ...cost(), stage: "x" }], [{ ...saving(), tokensSaved: -1 }])).toEqual([]);
    expect(allocateByProject([], [])).toEqual([]);
    expect(allocateByProject(undefined, undefined)).toEqual([]);
  });
});
