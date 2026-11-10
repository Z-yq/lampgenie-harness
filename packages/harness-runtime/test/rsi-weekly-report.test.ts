/**
 * RSI 周报(纯逻辑):分组/排序 / 指标结算 / 四类待决 / attentionOnly 压制 / 渲染 / 纠错计划 / 待批提醒。
 * 全纯函数直测,不触 IO。
 */
import { describe, expect, it } from "vitest";
import {
  ACTION_HINT_APPROVAL,
  ACTION_HINT_BREAKER,
  ACTION_HINT_CONFLICT,
  ACTION_HINT_NEGATIVE_ROI,
  buildWeeklyReport,
  DECISION_KINDS,
  planCorrection,
  renderWeeklyReportText,
  RSI_WEEKLY_VERSION,
  shouldRemindPending,
  WEEKLY_ATTENTION_DEFAULT_TTL_MS,
  type ChangedItem,
  type BreakerSummary,
  type CostSummary,
  type ExperimentSummary,
  type MetricSummary,
  type WeeklyInput,
  type WeeklyReport,
} from "../src/agent/rsi-weekly-report.js";

const WINDOW = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-08T00:00:00.000Z" };
const NOW_MS = Date.parse("2026-11-08T00:00:00.000Z");
const DAY = 86400000;

function metric(partial: Partial<MetricSummary> & { name: string }): MetricSummary {
  return { direction: "increase", baseline: 100, ...partial };
}

function exp(partial: Partial<ExperimentSummary> & { id: string }): ExperimentSummary {
  return {
    claim: "改动说明",
    surface: "loop",
    ref: "src/agent/loop.ts",
    variant: "v1",
    decision: "adopt",
    ...partial,
  };
}

function cost(partial: Partial<CostSummary> = {}): CostSummary {
  return { costTokens: 1000, savingTokens: 3000, netTokens: 2000, roi: 3, ...partial };
}

/** 只有正净值成本的「健康」输入(无待批/冲突/断路器)。 */
function healthyInput(overrides: Partial<WeeklyInput> = {}): WeeklyInput {
  return { experiments: [], cost: cost(), ...overrides };
}

function report(input: WeeklyInput, extra: Record<string, unknown> = {}): WeeklyReport {
  return buildWeeklyReport(input, { window: WINDOW, now: NOW_MS, ...extra });
}

describe("buildWeeklyReport:三问分组", () => {
  it("按 decision 分五组,byDecision 五键齐全", () => {
    const r = report(
      healthyInput({
        experiments: [
          exp({ id: "a1", decision: "adopt" }),
          exp({ id: "j1", decision: "reject" }),
          exp({ id: "i1", decision: "iterate" }),
          exp({ id: "r1", decision: "rollback" }),
          exp({ id: "p1", decision: "pending" }),
          exp({ id: "a2", decision: "adopt" }),
        ],
      }),
    );
    expect(r.changed.adopted.map((x) => x.id)).toEqual(["a1", "a2"]);
    expect(r.changed.rejected.map((x) => x.id)).toEqual(["j1"]);
    expect(r.changed.iterated.map((x) => x.id)).toEqual(["i1"]);
    expect(r.changed.rolledBack.map((x) => x.id)).toEqual(["r1"]);
    expect(r.changed.pending.map((x) => x.id)).toEqual(["p1"]);
    expect(r.counts.byDecision).toEqual({ adopt: 2, reject: 1, iterate: 1, rollback: 1, pending: 1 });
  });

  it("byDecision 缺 0 也保留五键", () => {
    const r = report(healthyInput());
    expect(Object.keys(r.counts.byDecision).sort()).toEqual([...DECISION_KINDS].sort());
    expect(r.counts.byDecision.rollback).toBe(0);
  });

  it("组内 decidedAt 降序", () => {
    const r = report(
      healthyInput({
        experiments: [
          exp({ id: "old", decidedAt: "2026-11-02T00:00:00.000Z" }),
          exp({ id: "new", decidedAt: "2026-11-07T00:00:00.000Z" }),
          exp({ id: "mid", decidedAt: "2026-11-04T00:00:00.000Z" }),
        ],
      }),
    );
    expect(r.changed.adopted.map((x) => x.id)).toEqual(["new", "mid", "old"]);
  });

  it("缺 decidedAt 排尾", () => {
    const r = report(
      healthyInput({
        experiments: [
          exp({ id: "none" }),
          exp({ id: "ts", decidedAt: "2026-11-03T00:00:00.000Z" }),
          exp({ id: "none2" }),
        ],
      }),
    );
    expect(r.changed.adopted.map((x) => x.id)).toEqual(["ts", "none", "none2"]);
  });

  it("decidedAt 相同时保持输入顺序(稳定排序)", () => {
    const ts = "2026-11-05T00:00:00.000Z";
    const r = report(
      healthyInput({
        experiments: [
          exp({ id: "x1", decidedAt: ts }),
          exp({ id: "x2", decidedAt: ts }),
          exp({ id: "x3", decidedAt: ts }),
        ],
      }),
    );
    expect(r.changed.adopted.map((x) => x.id)).toEqual(["x1", "x2", "x3"]);
  });

  it("毫秒数 decidedAt 归一成 ISO 字符串", () => {
    const r = report(healthyInput({ experiments: [exp({ id: "n1", decidedAt: NOW_MS })] }));
    expect(r.changed.adopted[0]?.decidedAt).toBe(new Date(NOW_MS).toISOString());
  });

  it("非法条目(缺 id / 非对象)静默跳过", () => {
    const r = report(
      healthyInput({
        experiments: [{ claim: "无 id" } as unknown as ExperimentSummary, exp({ id: "ok" })],
      }),
    );
    expect(r.changed.adopted.map((x) => x.id)).toEqual(["ok"]);
  });

  it("evidenceRefs 只保留非空字符串", () => {
    const r = report(
      healthyInput({
        experiments: [exp({ id: "e1", evidenceRefs: ["ev-1", "", 7 as unknown as string] })],
      }),
    );
    expect(r.changed.adopted[0]?.evidenceRefs).toEqual(["ev-1"]);
  });
});

describe("buildWeeklyReport:指标结算", () => {
  it("正 delta:上升说明 + improved", () => {
    const r = report(healthyInput({ experiments: [exp({ id: "e1", metrics: [metric({ name: "hitRate", result: 112.5 })] })] }));
    const m = r.changed.adopted[0]?.metrics[0];
    expect(m?.deltaPct).toBe(12.5);
    expect(m?.settled).toBe(true);
    expect(m?.improved).toBe(true);
    expect(m?.directionNote).toBe("increase: 上升 12.5%(方向偏好上升)");
  });

  it("increase 方向下跌:未改善", () => {
    const r = report(healthyInput({ experiments: [exp({ id: "e1", metrics: [metric({ name: "latency", result: 92 })] })] }));
    const m = r.changed.adopted[0]?.metrics[0];
    expect(m?.deltaPct).toBe(-8);
    expect(m?.improved).toBe(false);
    expect(m?.directionNote).toBe("increase: 下降 8%(方向偏好上升)");
  });

  it("decrease 方向下跌:改善", () => {
    const r = report(
      healthyInput({
        experiments: [exp({ id: "e1", metrics: [metric({ name: "latency", direction: "decrease", result: 80 })] })],
      }),
    );
    const m = r.changed.adopted[0]?.metrics[0];
    expect(m?.deltaPct).toBe(-20);
    expect(m?.improved).toBe(true);
    expect(m?.directionNote).toBe("decrease: 下降 20%(方向偏好下降)");
  });

  it("delta 为 0:写持平且 improved=false", () => {
    const r = report(healthyInput({ experiments: [exp({ id: "e1", metrics: [metric({ name: "hitRate", result: 100 })] })] }));
    const m = r.changed.adopted[0]?.metrics[0];
    expect(m?.deltaPct).toBe(0);
    expect(m?.improved).toBe(false);
    expect(m?.directionNote).toBe("increase: 持平(方向偏好上升)");
  });

  it("零基线:deltaPct=null + metric-baseline-zero 码,improved undefined", () => {
    const r = report(
      healthyInput({ experiments: [exp({ id: "e1", metrics: [metric({ name: "hitRate", baseline: 0, result: 5 })] })] }),
    );
    const m = r.changed.adopted[0]?.metrics[0];
    expect(m?.deltaPct).toBeNull();
    expect(m?.settled).toBe(true);
    expect(m?.improved).toBeUndefined();
    expect(m?.directionNote).toContain("基线为 0");
    expect(r.warnings).toContain("metric-baseline-zero:e1:hitRate");
  });

  it("负基线按绝对值归一", () => {
    const r = report(
      healthyInput({ experiments: [exp({ id: "e1", metrics: [metric({ name: "net", baseline: -100, result: -50 })] })] }),
    );
    expect(r.changed.adopted[0]?.metrics[0]?.deltaPct).toBe(50);
  });

  it("result 缺失:未结算 + missing-result 码", () => {
    const r = report(healthyInput({ experiments: [exp({ id: "e1", metrics: [metric({ name: "hitRate" })] })] }));
    const m = r.changed.adopted[0]?.metrics[0];
    expect(m?.settled).toBe(false);
    expect(m?.deltaPct).toBeNull();
    expect(m?.directionNote).toBe("未结算");
    expect(m?.improved).toBeUndefined();
    expect(r.warnings).toContain("missing-result:e1:hitRate");
  });

  it("result 为 NaN 也按未结算处理", () => {
    const r = report(
      healthyInput({ experiments: [exp({ id: "e1", metrics: [metric({ name: "hitRate", result: Number.NaN })] })] }),
    );
    expect(r.changed.adopted[0]?.metrics[0]?.settled).toBe(false);
  });

  it("缺 metrics:空数组 + missing-metrics 码,不崩", () => {
    const r = report(healthyInput({ experiments: [exp({ id: "e1" }), exp({ id: "e2", metrics: null as unknown as MetricSummary[] })] }));
    expect(r.changed.adopted[0]?.metrics).toEqual([]);
    expect(r.changed.adopted[1]?.metrics).toEqual([]);
    expect(r.warnings).toContain("missing-metrics:e1");
    expect(r.warnings).toContain("missing-metrics:e2");
  });

  it("metricsSettled / metricsUnsettled 计数", () => {
    const r = report(
      healthyInput({
        experiments: [
          exp({ id: "e1", metrics: [metric({ name: "a", result: 110 }), metric({ name: "b" })] }),
          exp({ id: "e2", metrics: [metric({ name: "c", result: 90 })] }),
        ],
      }),
    );
    expect(r.counts.metricsSettled).toBe(2);
    expect(r.counts.metricsUnsettled).toBe(1);
  });

  it("百分比 round2", () => {
    const r = report(
      healthyInput({ experiments: [exp({ id: "e1", metrics: [metric({ name: "hitRate", result: 103.3333 })] })] }),
    );
    expect(r.changed.adopted[0]?.metrics[0]?.deltaPct).toBe(3.33);
  });
});

describe("buildWeeklyReport:needsDecision 四类", () => {
  it("healthy:无待决项", () => {
    const r = report(healthyInput());
    expect(r.needsDecision).toEqual([]);
    expect(r.healthy).toBe(true);
    expect(r.attentionCount).toBe(0);
  });

  it("pending-approval:ref=id,summary 含 kind 与 since", () => {
    const r = report(
      healthyInput({
        pendingApprovals: [{ kind: "injection", id: "ap1", summary: "注入新规则", since: "2026-11-06T00:00:00.000Z" }],
      }),
    );
    expect(r.healthy).toBe(false);
    const item = r.needsDecision[0];
    expect(item?.kind).toBe("pending-approval");
    expect(item?.ref).toBe("ap1");
    expect(item?.summary).toContain("injection");
    expect(item?.summary).toContain("2026-11-06T00:00:00.000Z");
    expect(item?.actionHint).toBe(ACTION_HINT_APPROVAL);
    expect(r.counts.pendingApprovals).toBe(1);
  });

  it("多个 pending-approval 按输入顺序各一条", () => {
    const r = report(
      healthyInput({
        pendingApprovals: [
          { kind: "self-modification", id: "m1", summary: "改 prompt" },
          { kind: "experiment", id: "x1", summary: "上实验" },
        ],
      }),
    );
    expect(r.needsDecision.map((d) => d.ref)).toEqual(["m1", "x1"]);
    expect(r.needsDecision[0]?.summary).toContain("未知时间");
  });

  it("conflict:ref=associationKey,说法用 ' | ' 连接", () => {
    const r = report(
      healthyInput({
        conflicts: [
          { associationKey: "assoc-1", kind: "fact-value", statements: ["命中率 0.5", "命中率 0.6"] },
        ],
      }),
    );
    const item = r.needsDecision[0];
    expect(item?.kind).toBe("conflict");
    expect(item?.ref).toBe("assoc-1");
    expect(item?.summary).toContain(" | ");
    expect(item?.summary).toContain("命中率 0.5");
    expect(item?.actionHint).toBe(ACTION_HINT_CONFLICT);
    expect(r.counts.conflicts).toBe(1);
  });

  it("conflict 摘要总长截断 ≤120 字", () => {
    const r = report(
      healthyInput({
        conflicts: [{ associationKey: "assoc-2", kind: "fact-value", statements: ["甲".repeat(80), "乙".repeat(80)] }],
      }),
    );
    const summary = r.needsDecision[0]?.summary ?? "";
    expect(summary.length).toBeLessThanOrEqual(120);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("多个 conflict 各一条", () => {
    const r = report(
      healthyInput({
        conflicts: [
          { associationKey: "a1", kind: "fact-value", statements: ["p"] },
          { associationKey: "a2", kind: "fact-value", statements: ["q"] },
        ],
      }),
    );
    expect(r.needsDecision.filter((d) => d.kind === "conflict").map((d) => d.ref)).toEqual(["a1", "a2"]);
  });

  it("breaker-paused:ref=scope,summary 含 trigger/reason", () => {
    const r = report(
      healthyInput({
        breaker: {
          paused: true,
          scope: "rsi",
          trigger: "negative-roi-streak",
          reason: "连负 3 周期",
          pausedAt: "2026-11-05T00:00:00.000Z",
        },
      }),
    );
    const item = r.needsDecision[0];
    expect(item?.kind).toBe("breaker-paused");
    expect(item?.ref).toBe("rsi");
    expect(item?.summary).toContain("negative-roi-streak");
    expect(item?.summary).toContain("连负 3 周期");
    expect(item?.actionHint).toBe(ACTION_HINT_BREAKER);
  });

  it("breaker-paused 无 scope:ref 回落 'all'", () => {
    const r = report(healthyInput({ breaker: { paused: true } }));
    expect(r.needsDecision[0]?.ref).toBe("all");
  });

  it("breaker 未暂停不产生待决项", () => {
    const r = report(healthyInput({ breaker: { paused: false, scope: "rsi" } }));
    expect(r.needsDecision.some((d) => d.kind === "breaker-paused")).toBe(false);
  });

  it("negative-roi:净值 < 0 时一条,summary 含 netTokens 与 roi", () => {
    const r = report(healthyInput({ cost: cost({ costTokens: 5000, savingTokens: 1000, netTokens: -4000, roi: 0.2 }) }));
    const item = r.needsDecision[0];
    expect(item?.kind).toBe("negative-roi");
    expect(item?.ref).toBe("cost");
    expect(item?.summary).toContain("-4000");
    expect(item?.summary).toContain("0.2");
    expect(item?.actionHint).toBe(ACTION_HINT_NEGATIVE_ROI);
  });

  it("净值恰为 0 不算负", () => {
    const r = report(healthyInput({ cost: cost({ costTokens: 1000, savingTokens: 1000, netTokens: 0, roi: 1 }) }));
    expect(r.needsDecision.some((d) => d.kind === "negative-roi")).toBe(false);
    expect(r.healthy).toBe(true);
  });

  it("四类同时出现:顺序固定 pending-approval → conflict → breaker-paused → negative-roi", () => {
    const r = report({
      experiments: [],
      cost: cost({ costTokens: 900, savingTokens: 100, netTokens: -800, roi: 0.11 }),
      breaker: { paused: true, scope: "rsi", trigger: "t", reason: "r" },
      pendingApprovals: [{ kind: "experiment", id: "ap", summary: "s" }],
      conflicts: [{ associationKey: "k", kind: "fact-value", statements: ["a", "b"] }],
    });
    expect(r.needsDecision.map((d) => d.kind)).toEqual([
      "pending-approval",
      "conflict",
      "breaker-paused",
      "negative-roi",
    ]);
    expect(r.attentionCount).toBe(4);
    expect(r.healthy).toBe(false);
  });
});

describe("buildWeeklyReport:attentionOnly", () => {
  it("无待决时静默:changed 全空 + 压制段落", () => {
    const r = report(
      healthyInput({
        experiments: [exp({ id: "e1", decision: "adopt" })],
        cost: cost({ byMechanism: { m1: 100 }, byProject: { p1: 50 } }),
      }),
      { attentionOnly: true },
    );
    expect(r.changed).toEqual({ adopted: [], rejected: [], iterated: [], rolledBack: [], pending: [] });
    expect(r.suppressedSections).toEqual(["changed", "savings-breakdown"]);
    expect(r.healthy).toBe(true);
    expect(r.attentionOnly).toBe(true);
  });

  it("有待决:只留 needsDecision + suppressedSections", () => {
    const r = report(
      healthyInput({
        experiments: [exp({ id: "e1", decision: "pending" })],
        pendingApprovals: [{ kind: "experiment", id: "ap1", summary: "上实验" }],
        cost: cost({ byMechanism: { m1: 100 }, byProject: { p1: 50 } }),
      }),
      { attentionOnly: true },
    );
    expect(r.changed.pending).toEqual([]);
    expect(r.changed.adopted).toEqual([]);
    expect(r.needsDecision).toHaveLength(1);
    expect(r.suppressedSections).toEqual(["changed", "savings-breakdown"]);
    // 数字保留,分摊细节去掉
    expect(r.savings.netTokens).toBe(2000);
    expect(r.savings.byMechanism).toBeUndefined();
    expect(r.savings.byProject).toBeUndefined();
    // counts 仍反映真实数据
    expect(r.counts.byDecision.pending).toBe(1);
  });

  it("attentionOnly=false 时 suppressedSections undefined 且保留分摊", () => {
    const r = report(healthyInput({ cost: cost({ byMechanism: { m1: 100 } }) }), { attentionOnly: false });
    expect(r.suppressedSections).toBeUndefined();
    expect(r.savings.byMechanism).toEqual({ m1: 100 });
  });
});

describe("renderWeeklyReportText", () => {
  it("healthy:两行文本", () => {
    const r = report(healthyInput({ cost: cost({ costTokens: 1000, savingTokens: 3000, netTokens: 2000, roi: 3 }) }));
    expect(renderWeeklyReportText(r)).toBe("本周无需要你处理的事项\n净省 2000 tokens(ROI 3)");
  });

  it("healthy 且 roi=null:写 n/a", () => {
    const r = report(healthyInput({ cost: cost({ costTokens: 0, savingTokens: 0, netTokens: 0, roi: null }) }));
    const text = renderWeeklyReportText(r);
    expect(text).toBe("本周无需要你处理的事项\n净省 0 tokens(ROI n/a)");
  });

  it("非 healthy:三段标题逐字", () => {
    const r = report(healthyInput({ pendingApprovals: [{ kind: "experiment", id: "ap1", summary: "上实验" }] }));
    const lines = renderWeeklyReportText(r).split("\n");
    expect(lines).toContain("## 本周改了什么");
    expect(lines).toContain("## 净省了多少");
    expect(lines).toContain("## 需要你决定什么");
    expect(lines.indexOf("## 本周改了什么")).toBeLessThan(lines.indexOf("## 净省了多少"));
    expect(lines.indexOf("## 净省了多少")).toBeLessThan(lines.indexOf("## 需要你决定什么"));
  });

  it("第一段按五类各一行计数 + 指标行格式", () => {
    const r = report(
      healthyInput({
        experiments: [
          exp({ id: "e1", claim: "提高缓存命中", metrics: [metric({ name: "hitRate", baseline: 0.5, result: 0.6 })] }),
          exp({ id: "e2", decision: "reject", claim: "换模型" }),
        ],
        pendingApprovals: [{ kind: "experiment", id: "ap1", summary: "上实验" }],
      }),
    );
    const text = renderWeeklyReportText(r);
    expect(text).toContain("adopt: 1 条");
    expect(text).toContain("reject: 1 条");
    expect(text).toContain("iterate: 0 条");
    expect(text).toContain("rollback: 0 条");
    expect(text).toContain("pending: 0 条");
    expect(text).toContain("e1 · 提高缓存命中 · hitRate 0.5→0.6(20%)");
  });

  it("每类最多渲染 5 条", () => {
    const experiments = [1, 2, 3, 4, 5, 6].map((n) => exp({ id: `e${n}`, claim: `改${n}` }));
    const r = report(healthyInput({ experiments, pendingApprovals: [{ kind: "experiment", id: "ap", summary: "s" }] }));
    const text = renderWeeklyReportText(r);
    expect(text).toContain("e5 · 改5");
    expect(text).not.toContain("e6 · 改6");
    expect(text).toContain("adopt: 6 条");
  });

  it("第三段每条形如 '- [kind] ref — summary → actionHint'", () => {
    const r = report(healthyInput({ pendingApprovals: [{ kind: "injection", id: "ap1", summary: "注入规则" }] }));
    const text = renderWeeklyReportText(r);
    expect(text).toContain(`- [pending-approval] ap1 — `);
    expect(text).toContain(`→ ${ACTION_HINT_APPROVAL}`);
  });

  it("第二段含 net/saving/cost/roi 与 byMechanism 前 3", () => {
    const r = report(
      healthyInput({
        cost: cost({
          costTokens: 1000,
          savingTokens: 3000,
          netTokens: 2000,
          roi: 3,
          byMechanism: { m1: 100, m2: 200, m3: 300, m4: 400 },
        }),
        pendingApprovals: [{ kind: "experiment", id: "ap", summary: "s" }],
      }),
    );
    const lines = renderWeeklyReportText(r).split("\n");
    const idx = lines.indexOf("## 净省了多少");
    const savingsLine = lines[idx + 1] ?? "";
    expect(savingsLine).toContain("net=2000");
    expect(savingsLine).toContain("saving=3000");
    expect(savingsLine).toContain("cost=1000");
    expect(savingsLine).toContain("ROI=3");
    expect(savingsLine).toContain("m4=400, m3=300, m2=200");
    expect(savingsLine).not.toContain("m1=100");
  });

  it("attentionOnly:第一段只一行压制说明,第二段只一行净值", () => {
    const r = report(
      healthyInput({
        experiments: [exp({ id: "e1", decision: "pending" })],
        pendingApprovals: [{ kind: "experiment", id: "ap1", summary: "s" }],
        cost: cost({ byMechanism: { m1: 100 } }),
      }),
      { attentionOnly: true },
    );
    const lines = renderWeeklyReportText(r).split("\n");
    const first = lines.indexOf("## 本周改了什么");
    expect(lines[first + 1]).toBe("(已按注意力预算压制)");
    const net = lines.indexOf("## 净省了多少");
    expect(lines[net + 1]).toBe("净省 2000 tokens(ROI 3)");
    expect(lines[net + 2]).toBe("## 需要你决定什么");
  });

  it("空报告对象也不抛", () => {
    const text = renderWeeklyReportText({} as WeeklyReport);
    expect(text).toBe("本周无需要你处理的事项\n净省 0 tokens(ROI n/a)");
  });
});

describe("planCorrection", () => {
  it("rewrite:产出 graphCorrection.statement", () => {
    const plan = planCorrection({
      kind: "rewrite",
      target: "assoc-1",
      by: "user",
      reason: "口径修正",
      newStatement: "命中率 0.55",
    });
    expect(plan.ok).toBe(true);
    expect(plan.graphCorrection).toEqual({
      id: "assoc-1",
      statement: "命中率 0.55",
      by: "user",
      reason: "口径修正",
    });
    expect(plan.codes).toEqual([]);
  });

  it("rewrite 缺 newStatement:missing-new-statement", () => {
    const plan = planCorrection({ kind: "rewrite", target: "assoc-1", by: "user", reason: "r" });
    expect(plan.ok).toBe(false);
    expect(plan.codes).toEqual(["missing-new-statement"]);
    expect(plan.graphCorrection).toBeUndefined();
  });

  it("disable:graphCorrection.disable=true", () => {
    const plan = planCorrection({ kind: "disable", target: "assoc-2", by: "user", reason: "过期" });
    expect(plan.ok).toBe(true);
    expect(plan.graphCorrection).toEqual({ id: "assoc-2", by: "user", reason: "过期", disable: true });
  });

  it("rollback 且 target 以 ev- 开头:走 graphCorrection", () => {
    const plan = planCorrection({ kind: "rollback", target: "ev-123", by: "user", reason: "指标回退" });
    expect(plan.ok).toBe(true);
    expect(plan.graphCorrection?.id).toBe("ev-123");
    expect(plan.experimentAction).toBeUndefined();
  });

  it("rollback 非 ev- 前缀:走 experimentAction", () => {
    const plan = planCorrection({ kind: "rollback", target: "exp-9", by: "user", reason: "指标回退" });
    expect(plan.ok).toBe(true);
    expect(plan.experimentAction).toEqual({ id: "exp-9", kind: "rollback" });
    expect(plan.graphCorrection).toBeUndefined();
  });

  it("rollback 空 target:missing-target", () => {
    const plan = planCorrection({ kind: "rollback", target: "", by: "user", reason: "r" });
    expect(plan.ok).toBe(false);
    expect(plan.codes).toEqual(["missing-target"]);
  });

  it("非法 kind:invalid-kind", () => {
    const plan = planCorrection({ kind: "nuke" as unknown as "rewrite", target: "x", by: "u", reason: "r" });
    expect(plan.ok).toBe(false);
    expect(plan.codes).toEqual(["invalid-kind"]);
  });

  it("缺 by / 缺 reason:分别给码(有序)", () => {
    expect(planCorrection({ kind: "disable", target: "a", by: "", reason: "r" }).codes).toEqual(["missing-by"]);
    expect(planCorrection({ kind: "disable", target: "a", by: "u", reason: "" }).codes).toEqual(["missing-reason"]);
    expect(planCorrection({ kind: "disable", target: "a", by: "", reason: "" }).codes).toEqual([
      "missing-by",
      "missing-reason",
    ]);
  });

  it("非对象入参不抛", () => {
    const plan = planCorrection(null as unknown as Parameters<typeof planCorrection>[0]);
    expect(plan.ok).toBe(false);
    expect(plan.codes.length).toBeGreaterThan(0);
  });
});

describe("shouldRemindPending", () => {
  function pendingReport(): WeeklyReport {
    return report(healthyInput({ experiments: [exp({ id: "p1", decision: "pending" })] }));
  }

  it("无待批:no-pending", () => {
    const decision = shouldRemindPending(report(healthyInput()), { now: NOW_MS });
    expect(decision.remind).toBe(false);
    expect(decision.reason).toBe("no-pending");
    expect(decision.dueAt).toBeUndefined();
  });

  it("只有非 pending-approval 的待决项也算无待批", () => {
    const r = report(healthyInput({ breaker: { paused: true } }));
    expect(shouldRemindPending(r, { now: NOW_MS }).reason).toBe("no-pending");
  });

  it("changed.pending 计入待批数:never-reminded", () => {
    const decision = shouldRemindPending(pendingReport(), { now: NOW_MS });
    expect(decision.remind).toBe(true);
    expect(decision.reason).toBe("never-reminded");
    expect(decision.dueAt).toBeUndefined();
  });

  it("lastRemindedAt=null:同样 never-reminded", () => {
    const decision = shouldRemindPending(pendingReport(), { lastRemindedAt: null, now: NOW_MS });
    expect(decision.reason).toBe("never-reminded");
  });

  it("pending-approval 也计入待批数", () => {
    const r = report(healthyInput({ pendingApprovals: [{ kind: "experiment", id: "ap", summary: "s" }] }));
    expect(shouldRemindPending(r, { now: NOW_MS }).remind).toBe(true);
  });

  it("超过 TTL:due,并给 dueAt", () => {
    const last = NOW_MS - DAY - 1000;
    const decision = shouldRemindPending(pendingReport(), { lastRemindedAt: last, now: NOW_MS });
    expect(decision.remind).toBe(true);
    expect(decision.reason).toBe("due");
    expect(decision.dueAt).toBe(last + WEEKLY_ATTENTION_DEFAULT_TTL_MS);
  });

  it("边界 now-last === ttl 即 due", () => {
    const last = NOW_MS - DAY;
    const decision = shouldRemindPending(pendingReport(), { lastRemindedAt: last, now: NOW_MS });
    expect(decision.reason).toBe("due");
    expect(decision.dueAt).toBe(last + DAY);
  });

  it("未到 TTL:ttl-suppressed,仍给 dueAt", () => {
    const last = NOW_MS - 1000;
    const decision = shouldRemindPending(pendingReport(), { lastRemindedAt: last, now: NOW_MS });
    expect(decision.remind).toBe(false);
    expect(decision.reason).toBe("ttl-suppressed");
    expect(decision.dueAt).toBe(last + DAY);
  });

  it("自定义 ttlMs 生效", () => {
    const last = NOW_MS - 1000;
    expect(shouldRemindPending(pendingReport(), { lastRemindedAt: last, now: NOW_MS, ttlMs: 500 }).reason).toBe("due");
    expect(shouldRemindPending(pendingReport(), { lastRemindedAt: last, now: NOW_MS, ttlMs: 5000 }).reason).toBe(
      "ttl-suppressed",
    );
  });

  it("非法 ttlMs 回落缺省 24h", () => {
    const last = NOW_MS - 1000;
    const decision = shouldRemindPending(pendingReport(), { lastRemindedAt: last, now: NOW_MS, ttlMs: 0 });
    expect(decision.reason).toBe("ttl-suppressed");
    expect(decision.dueAt).toBe(last + DAY);
  });

  it("ISO 字符串时间也能解析", () => {
    const last = "2026-11-01T00:00:00.000Z";
    const decision = shouldRemindPending(pendingReport(), { lastRemindedAt: last, now: "2026-11-08T00:00:00.000Z" });
    expect(decision.reason).toBe("due");
    expect(decision.dueAt).toBe(Date.parse(last) + DAY);
  });
});

describe("warnings / window / now", () => {
  it("全缺字段:五个容器级码按固定顺序", () => {
    const r = report({});
    expect(r.warnings).toEqual([
      "missing-experiments",
      "missing-cost",
      "missing-breaker",
      "missing-pending",
      "missing-conflicts",
    ]);
    expect(r.savings).toEqual({ costTokens: 0, savingTokens: 0, netTokens: 0, roi: null });
    expect(r.healthy).toBe(true);
  });

  it("warnings 去重(同 id 两次缺 metrics 只留一条)", () => {
    const r = report(
      healthyInput({
        experiments: [exp({ id: "dup" }), exp({ id: "dup" })],
      }),
    );
    expect(r.warnings.filter((w) => w === "missing-metrics:dup")).toEqual(["missing-metrics:dup"]);
  });

  it("warnings 顺序:容器级 → 指标级 → invalid-window", () => {
    const r = buildWeeklyReport(
      { experiments: [exp({ id: "e1" })] },
      { window: { from: "", to: "" } },
    );
    expect(r.warnings).toEqual([
      "missing-cost",
      "missing-breaker",
      "missing-pending",
      "missing-conflicts",
      "missing-metrics:e1",
      "invalid-window",
    ]);
  });

  it("invalid-window:给码且 window 原样回显(缺失字段回落空串)", () => {
    const r = buildWeeklyReport(healthyInput(), { window: { from: "nope", to: "" }, now: NOW_MS });
    expect(r.warnings).toContain("invalid-window");
    expect(r.window).toEqual({ from: "nope", to: "" });
  });

  it("window 原样回显", () => {
    const r = report(healthyInput());
    expect(r.window).toEqual(WINDOW);
  });

  it("now 回显(generatedAt)", () => {
    expect(report(healthyInput()).generatedAt).toBe(new Date(NOW_MS).toISOString());
    const iso = buildWeeklyReport(healthyInput(), { window: WINDOW, now: "2026-11-09T01:02:03.000Z" });
    expect(iso.generatedAt).toBe("2026-11-09T01:02:03.000Z");
  });

  it("now 非法时回落当前时间且不抛", () => {
    const r = buildWeeklyReport(healthyInput(), { window: WINDOW, now: "not-a-date" });
    expect(typeof r.generatedAt).toBe("string");
    expect(Number.isFinite(Date.parse(r.generatedAt))).toBe(true);
  });

  it("版本与 TTL 常量", () => {
    expect(RSI_WEEKLY_VERSION).toBe(1);
    expect(WEEKLY_ATTENTION_DEFAULT_TTL_MS).toBe(86400000);
    expect(report(healthyInput()).version).toBe(1);
  });

  it("cost 数值 round2 + roi 缺省由 saving/cost 推出", () => {
    const r = report(
      healthyInput({
        cost: {
          costTokens: 300,
          savingTokens: 800,
          netTokens: 500,
          roi: null,
          byMechanism: { m: 1.23456 },
        } as unknown as CostSummary,
      }),
    );
    expect(r.savings.roi).toBe(2.67);
    expect(r.savings.byMechanism).toEqual({ m: 1.23 });
  });

  it("非法 entries 集合(非数组)按缺失处理", () => {
    const r = report({
      experiments: "nope" as unknown as ExperimentSummary[],
      cost: 5 as unknown as CostSummary,
      breaker: [] as unknown as BreakerSummary,
      pendingApprovals: {} as unknown as never[],
      conflicts: 0 as unknown as never[],
    });
    expect(r.warnings).toEqual([
      "missing-experiments",
      "missing-cost",
      "missing-breaker",
      "missing-pending",
      "missing-conflicts",
    ]);
    expect(r.healthy).toBe(true);
  });

  it("ChangedItem 字段齐全(decidedAt/rollbackPoint 可选)", () => {
    const r = report(
      healthyInput({ experiments: [exp({ id: "e1", rollbackPoint: "git:abc", decidedAt: NOW_MS })] }),
    );
    const item: ChangedItem | undefined = r.changed.adopted[0];
    expect(item?.rollbackPoint).toBe("git:abc");
    expect(item?.surface).toBe("loop");
    expect(item?.variant).toBe("v1");
    expect(item?.ref).toBe("src/agent/loop.ts");
  });
});
