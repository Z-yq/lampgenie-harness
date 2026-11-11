/**
 *  指导可度量·结果指标接入(apps/gateway。
 * A. 源码面:guidance-metrics.ts 仍导出既有计数层(computeGuidanceMetrics/renderGuidanceSummary),
 * 且新增 buildGuidanceOutcome 与 toExperimentSample 透传;
 * B. 纯路径:buildGuidanceOutcome 在空事件/旧 journal 下全 0 且不 throw;有事件时与计数层同源;
 * C. 出口:分层/对照/实验样本可直接从 gateway 模块取到并被消费。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildGuidanceOutcome,
  compareOutcomes,
  computeGuidanceMetrics,
  renderGuidanceSummary,
  stratifyOutcomes,
  toExperimentSample,
  type GuidanceMetricsEvent,
} from "../src/guidance-metrics.js";

const SRC = readFileSync(new URL("../src/guidance-metrics.ts", import.meta.url), "utf8");

let seq = 0;
const ev = (kind: string, payload?: Record<string, unknown>): GuidanceMetricsEvent => ({ seq: ++seq, kind, payload });
const toolCall = (name: string, args: Record<string, unknown> = {}): GuidanceMetricsEvent =>
  ev("tool.call", { name, arguments: JSON.stringify(args), turn: 1, step: 0 });
const result = (content: string, error?: unknown): GuidanceMetricsEvent =>
  ev("tool.result", { content, ...(error === undefined ? {} : { error }) });

describe("guidance-metrics 源码面", () => {
  it("既有计数层导出逐字保留", () => {
    expect(SRC).toContain("export function computeGuidanceMetrics");
    expect(SRC).toContain("export function renderGuidanceSummary");
    expect(SRC).toContain("export function tipMetricOf");
  });

  it("新增 buildGuidanceOutcome 与 toExperimentSample 透传", () => {
    expect(SRC).toContain("export function buildGuidanceOutcome");
    expect(SRC).toMatch(/export \{[^}]*toExperimentSample/);
    expect(SRC).toContain('from "@lampgenie/runtime/agent/guidance-outcome"');
  });
});

describe("buildGuidanceOutcome 纯路径", () => {
  it("无事件 → 全 0(率也为 0),基线取 taskClass 经验值", () => {
    const o = buildGuidanceOutcome({ events: [], taskClass: "qa" });
    expect(o).toMatchObject({
      taskClass: "qa", toolCalls: 0, steps: 0, reworkCalls: 0, repeatedReads: 0,
      uniqueReads: 0, wastedTokens: 0, totalTokens: 0, baselineSteps: 8,
      avoidableErrorRate: 0, inefficientDecisionRate: 0, repeatedExplorationRate: 0, wasteTokenRate: 0,
    });
  });

  it("旧 journal(非数组/缺 taskClass)不 throw,按 coding 兜底", () => {
    expect(() => buildGuidanceOutcome({ events: null as never, taskClass: "" })).not.toThrow();
    const o = buildGuidanceOutcome({ events: "oops" as never, taskClass: undefined as never });
    expect(o.taskClass).toBe("coding");
    expect(o.baselineSteps).toBe(40);
  });

  it("有事件时与计数层同源(toolCalls/steps/reworkCalls 一致)", () => {
    seq = 0;
    const evs: GuidanceMetricsEvent[] = [
      ev("step.start", { turn: 1, step: 0 }),
      toolCall("read_file", { path: "a.ts" }),
      toolCall("read_file", { path: "a.ts" }),
      toolCall("grep", { pattern: "x" }),
      result("错误: 不存在"),
      result("ok"),
      ev("llm.trace", { usage: { totalTokens: 100 } }),
      ev("llm.trace", { usage: { totalTokens: 100 }, error: "boom" }),
      ev("step.end", { turn: 1, step: 0 }),
    ];
    const counts = computeGuidanceMetrics(evs);
    const o = buildGuidanceOutcome({ events: evs, taskClass: "coding", model: "m1", projectId: "p1" });
    expect(o.toolCalls).toBe(counts.counters.toolCalls);
    expect(o.steps).toBe(counts.counters.steps);
    expect(o.reworkCalls).toBe(counts.counters.reworkCalls);
    expect(o.avoidableErrorRate).toBeCloseTo(1 / 3, 10);
    expect(o.repeatedReads).toBe(1);
    expect(o.wastedTokens).toBe(100);
    expect(o.wasteTokenRate).toBeCloseTo(0.5, 10);
  });

  it("baselineSteps 注入覆盖经验值", () => {
    seq = 0;
    const evs = Array.from({ length: 16 }, () => ev("step.start", { turn: 1, step: 0 }));
    expect(buildGuidanceOutcome({ events: evs, taskClass: "coding", baselineSteps: 8 }).inefficientDecisionRate).toBeCloseTo(1, 10);
    expect(buildGuidanceOutcome({ events: evs, taskClass: "coding" }).inefficientDecisionRate).toBe(0);
  });
});

describe("结果层出口(分层/对照/样本)", () => {
  const mk = (rate: number, projectId?: string, model?: string) => {
    const o = buildGuidanceOutcome({ events: [], taskClass: "coding", projectId, model });
    return { ...o, avoidableErrorRate: rate, toolCalls: 10, reworkCalls: Math.round(rate * 10) };
  };

  it("分层 key 与样本聚合可用", () => {
    const m = stratifyOutcomes([mk(0.2, "p1", "m1"), mk(0.4, "p1", "m1"), mk(0.1)]);
    expect([...m.keys()]).toEqual(["p1|m1|coding", "-|-|coding"]);
    expect(m.get("p1|m1|coding")!.samples).toBe(2);
    expect(m.get("p1|m1|coding")!.avg.avoidableErrorRate).toBeCloseTo(0.3, 10);
  });

  it("前后对照:率降 better、样本 3 vs 3 不告样本不足", () => {
    const before = [mk(0.4), mk(0.4), mk(0.4)];
    const after = [mk(0.1), mk(0.1), mk(0.1)];
    const c = compareOutcomes(before, after);
    expect(c.direction).toBe("better");
    expect(c.sample).toEqual({ before: 3, after: 3 });
    expect(c.sampleLow).toBe(false);
    expect(c.delta.avoidableErrorRate).toBeCloseTo(-0.3, 10);
  });

  it("toExperimentSample 透传:metric/stratum/note 齐备,可并入账本记录", () => {
    const o = mk(0.2, "p1", "m1");
    const s = toExperimentSample(o, { intervention: "tip", ref: "dyn:verify-stop", baseline: 0.3 });
    expect(s.metric).toEqual({ name: "avoidableErrorRate", value: 0.2, baseline: 0.3 });
    expect(s.stratum).toEqual({ project: "p1", model: "m1", taskClass: "coding" });
    expect(s.note).toContain("dyn:verify-stop");
  });

  it("确定性:同输入两次结果相等", () => {
    seq = 0;
    const evs = [toolCall("read_file", { path: "a.ts" }), result("错误: x")];
    expect(buildGuidanceOutcome({ events: evs, taskClass: "coding" })).toEqual(buildGuidanceOutcome({ events: evs, taskClass: "coding" }));
  });

  it("既有摘要渲染不受新导出影响", () => {
    seq = 0;
    const evs = [ev("step.start", { turn: 1, step: 0 }), toolCall("grep", { pattern: "x" })];
    const text = renderGuidanceSummary(computeGuidanceMetrics(evs));
    expect(text.startsWith("[指导度量]")).toBe(true);
    expect(text).toContain("工具 1");
  });
});
