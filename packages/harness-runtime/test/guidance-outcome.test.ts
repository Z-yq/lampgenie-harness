/**
 *  指导可度量·结果指标(guidance-outcome。
 * A. computeGuidanceOutcome:四率口径(含分母 0)、reworkCalls、重复读去重与 path 归一、
 * wastedTokens(失败/空 usage)、经验基线(可注入)、探针 A/B/C/D/G;
 * B. stratifyOutcomes:分层 key(缺项目/模型用 "-")、样本聚合与简单平均;
 * C. compareOutcomes:better/worse/flat、|delta|<0.01 平坦、sampleLow(<3);
 * D. toExperimentSample:metric/stratum/note 形状,可并入实验账本;
 * E. 确定性 / 不可变 / 不 throw。
 */
import { describe, it, expect } from "vitest";
import {
  OUTCOME_FLAT_EPSILON,
  TASK_CLASS_BASELINE_STEPS,
  baselineStepsOf,
  compareOutcomes,
  computeGuidanceOutcome,
  normalizeReadPath,
  stratifyOutcomes,
  toExperimentSample,
  type GuidanceOutcome,
  type GuidanceOutcomeEvent,
} from "../src/agent/guidance-outcome";

let seq = 0;
const ev = (kind: string, payload?: Record<string, unknown>, s?: number): GuidanceOutcomeEvent =>
  ({ seq: s ?? ++seq, kind, payload });
const reset = () => { seq = 0; };

const steps = (n: number, from = 0): GuidanceOutcomeEvent[] =>
  Array.from({ length: n }, () => ev("step.start", { turn: 1, step: from++ }));
const toolCall = (name: string, args: Record<string, unknown> = {}): GuidanceOutcomeEvent =>
  ev("tool.call", { name, arguments: JSON.stringify(args), turn: 1, step: 0 });
const readCall = (path: string): GuidanceOutcomeEvent => toolCall("read_file", { path });
const result = (content: string, error?: unknown): GuidanceOutcomeEvent =>
  ev("tool.result", { content, ...(error === undefined ? {} : { error }) });
const trace = (totalTokens?: number, error?: unknown): GuidanceOutcomeEvent =>
  ev("llm.trace", { ...(totalTokens === undefined ? {} : { usage: { totalTokens } }), ...(error === undefined ? {} : { error }) });

const make = (events: GuidanceOutcomeEvent[], taskClass = "coding", extra: Record<string, unknown> = {}): GuidanceOutcome =>
  computeGuidanceOutcome(events, { taskClass, ...extra });

describe("computeGuidanceOutcome 计数与四率", () => {
  it("G: 空事件全 0,基线取经验值(qa 8),不 throw", () => {
    reset();
    const o = computeGuidanceOutcome([], { taskClass: "qa" });
    expect(o).toEqual({
      taskClass: "qa",
      toolCalls: 0, steps: 0, reworkCalls: 0, repeatedReads: 0, uniqueReads: 0,
      wastedTokens: 0, totalTokens: 0, baselineSteps: 8,
      avoidableErrorRate: 0, inefficientDecisionRate: 0, repeatedExplorationRate: 0, wasteTokenRate: 0,
    });
  });

  it("steps 只数 step.start", () => {
    reset();
    const o = make([...steps(3), ev("step.end", {}), ...steps(2, 3)]);
    expect(o.steps).toBe(5);
  });

  it("toolCalls 数 tool.call(其它 kind 不计)", () => {
    reset();
    const o = make([toolCall("read_file"), toolCall("grep"), ev("tip.injected", { keys: ["a"] })]);
    expect(o.toolCalls).toBe(2);
  });

  it("reworkCalls: tool.result 带 error 字段", () => {
    reset();
    const o = make([result("ok"), result("", true), result("x", "boom")]);
    expect(o.reworkCalls).toBe(2);
  });

  it("reworkCalls: content 以「错误」开头(含前后空白),其余文案不计", () => {
    reset();
    const o = make([result("  错误: 文件不存在"), result("正常: 错误码 0"), result("工具执行超时")]);
    expect(o.reworkCalls).toBe(1);
  });

  it("A: 10 次调用 2 次错误 → avoidableErrorRate=0.2", () => {
    reset();
    const evs: GuidanceOutcomeEvent[] = [];
    for (let i = 0; i < 10; i += 1) evs.push(toolCall("read_file", { path: `f${i}.ts` }));
    evs.push(result("错误: x"), result("错误: y"));
    const o = make(evs);
    expect(o.toolCalls).toBe(10);
    expect(o.reworkCalls).toBe(2);
    expect(o.avoidableErrorRate).toBeCloseTo(0.2, 10);
  });

  it("avoidableErrorRate 分母 0 → 0(有错误结果但无 tool.call 也是 0)", () => {
    reset();
    const o = make([result("错误: x")]);
    expect(o.toolCalls).toBe(0);
    expect(o.avoidableErrorRate).toBe(0);
  });

  it("B: 8 步 vs 基线 8 → 低效 0;16 步 → 1.0", () => {
    reset();
    expect(make(steps(8), "qa").inefficientDecisionRate).toBe(0);
    expect(make(steps(16), "qa").inefficientDecisionRate).toBeCloseTo(1, 10);
  });

  it("baselineSteps 注入覆盖经验基线", () => {
    reset();
    const o = make(steps(10), "coding", { baselineSteps: 5 });
    expect(o.baselineSteps).toBe(5);
    expect(o.inefficientDecisionRate).toBeCloseTo(1, 10);
  });

  it("baselineSteps 非法(0/-3/NaN)回落经验值", () => {
    reset();
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const o = make(steps(4), "coding", { baselineSteps: bad });
      expect(o.baselineSteps, String(bad)).toBe(40);
      expect(o.inefficientDecisionRate, String(bad)).toBe(0);
    }
  });

  it("经验基线:qa 8 / office 20 / coding 40,未知类按 coding", () => {
    expect(TASK_CLASS_BASELINE_STEPS).toEqual({ qa: 8, office: 20, coding: 40 });
    expect(baselineStepsOf("qa")).toBe(8);
    expect(baselineStepsOf("office")).toBe(20);
    expect(baselineStepsOf("coding")).toBe(40);
    expect(baselineStepsOf("unknown-class")).toBe(40);
  });

  it("C: 同 path 读 3 次 → repeatedReads=2、uniqueReads=1、率 2(按公式不 clamp)", () => {
    reset();
    const o = make([readCall("a.ts"), readCall("a.ts"), readCall("a.ts")]);
    expect(o.uniqueReads).toBe(1);
    expect(o.repeatedReads).toBe(2);
    expect(o.repeatedExplorationRate).toBeCloseTo(2, 10);
  });

  it("path 归一:反斜杠/重复斜杠/尾部斜杠/前导 ./ 视为同一 path", () => {
    reset();
    const o = make([readCall("src\\a\\b.ts"), readCall("./src//a/b.ts/"), readCall(" src/a/b.ts ")]);
    expect(o.uniqueReads).toBe(1);
    expect(o.repeatedReads).toBe(2);
    expect(normalizeReadPath("  .\\src\\\\a.ts/ ")).toBe("src/a.ts");
  });

  it("不同 path 不产生重复读;file_path 别名同样归一", () => {
    reset();
    const o = make([
      toolCall("read_file", { file_path: "x.ts" }),
      toolCall("read_file", { path: "x.ts" }),
      readCall("y.ts"),
    ]);
    expect(o.uniqueReads).toBe(2);
    expect(o.repeatedReads).toBe(1);
  });

  it("read_file 无 path/arguments 非法 → 不计去重,不 throw", () => {
    reset();
    const o = make([
      ev("tool.call", { name: "read_file" }),
      ev("tool.call", { name: "read_file", arguments: "{not json" }),
      ev("tool.call", { name: "read_file", arguments: '{"path":"   "}' }),
    ]);
    expect(o.toolCalls).toBe(3);
    expect(o.uniqueReads).toBe(0);
    expect(o.repeatedExplorationRate).toBe(0);
  });

  it("D: 失败的调用 usage 计入 wastedTokens(同时计入 totalTokens)", () => {
    reset();
    const o = make([trace(100, "upstream 500"), trace(300)]);
    expect(o.totalTokens).toBe(400);
    expect(o.wastedTokens).toBe(100);
    expect(o.wasteTokenRate).toBeCloseTo(0.25, 10);
  });

  it("空 usage(缺失或没有 totalTokens)的调用计为浪费,但 token 缺失不计", () => {
    reset();
    const o = make([trace(undefined), ev("llm.trace", { usage: {} }), trace(50)]);
    expect(o.totalTokens).toBe(50);
    expect(o.wastedTokens).toBe(0);
    expect(o.wasteTokenRate).toBe(0);
  });

  it("wasteTokenRate 分母 0 → 0", () => {
    reset();
    const o = make([ev("llm.trace", { error: "x" })]);
    expect(o.totalTokens).toBe(0);
    expect(o.wastedTokens).toBe(0);
    expect(o.wasteTokenRate).toBe(0);
  });

  it("model/projectId 透传;缺失时字段不出现", () => {
    reset();
    const withMeta = make([], "coding", { model: "m1", projectId: "p1" });
    expect(withMeta.model).toBe("m1");
    expect(withMeta.projectId).toBe("p1");
    const bare = make([]);
    expect(bare.model).toBeUndefined();
    expect(bare.projectId).toBeUndefined();
    expect("model" in bare).toBe(false);
  });

  it("options 缺省/畸形(undefined/null)按 coding 处理,不 throw", () => {
    reset();
    expect(computeGuidanceOutcome(undefined, undefined).taskClass).toBe("coding");
    expect(computeGuidanceOutcome([], null as never).baselineSteps).toBe(40);
  });
});

describe("stratifyOutcomes 分层", () => {
  it("E: 分层 key=projectId|model|taskClass,缺项目/模型用 \"-\"", () => {
    reset();
    const a = make(steps(2), "coding", { model: "m1", projectId: "p1" });
    const b = make(steps(2), "qa");
    const m = stratifyOutcomes([a, b]);
    expect([...m.keys()]).toEqual(["p1|m1|coding", "-|-|qa"]);
  });

  it("同 key 聚合:samples/avg(简单平均)/sums", () => {
    reset();
    const a: GuidanceOutcome = { ...make(steps(8), "coding"), toolCalls: 10, reworkCalls: 2, avoidableErrorRate: 0.2, totalTokens: 100, wastedTokens: 10, wasteTokenRate: 0.1 };
    const b: GuidanceOutcome = { ...make(steps(16), "coding"), toolCalls: 10, reworkCalls: 4, avoidableErrorRate: 0.4, totalTokens: 300, wastedTokens: 30, wasteTokenRate: 0.1 };
    const g = stratifyOutcomes([a, b]).get("-|-|coding")!;
    expect(g.samples).toBe(2);
    expect(g.avg.avoidableErrorRate).toBeCloseTo(0.3, 10);
    expect(g.avg.wasteTokenRate).toBeCloseTo(0.1, 10);
    expect(g.sums.toolCalls).toBe(20);
    expect(g.sums.steps).toBe(24);
    expect(g.sums.reworkCalls).toBe(6);
    expect(g.sums.totalTokens).toBe(400);
  });

  it("空输入/非数组 → 空 Map", () => {
    expect(stratifyOutcomes([]).size).toBe(0);
    expect(stratifyOutcomes(undefined).size).toBe(0);
    expect(stratifyOutcomes("nope" as never).size).toBe(0);
  });
});

describe("compareOutcomes 前后对照", () => {
  const withRate = (r: Partial<Record<"avoidableErrorRate" | "inefficientDecisionRate" | "repeatedExplorationRate" | "wasteTokenRate", number>>): GuidanceOutcome =>
    ({ ...make([]), avoidableErrorRate: 0, inefficientDecisionRate: 0, repeatedExplorationRate: 0, wasteTokenRate: 0, ...r });

  it("F: 率降 → better,delta 为负", () => {
    const c = compareOutcomes(withRate({ avoidableErrorRate: 0.3 }), withRate({ avoidableErrorRate: 0.1 }));
    expect(c.direction).toBe("better");
    expect(c.delta.avoidableErrorRate).toBeCloseTo(-0.2, 10);
  });

  it("F: 率升 → worse,delta 为正", () => {
    const c = compareOutcomes(withRate({ avoidableErrorRate: 0.1 }), withRate({ avoidableErrorRate: 0.25 }));
    expect(c.direction).toBe("worse");
    expect(c.delta.avoidableErrorRate).toBeCloseTo(0.15, 10);
  });

  it("F: |delta|<0.01 → flat", () => {
    const c = compareOutcomes(withRate({ avoidableErrorRate: 0.2 }), withRate({ avoidableErrorRate: 0.2 + OUTCOME_FLAT_EPSILON / 2 }));
    expect(c.direction).toBe("flat");
  });

  it("主指标平坦时按固定顺序找第一个非平坦率", () => {
    const c = compareOutcomes(
      withRate({ avoidableErrorRate: 0.2, repeatedExplorationRate: 1 }),
      withRate({ avoidableErrorRate: 0.2, repeatedExplorationRate: 0.5 }),
    );
    expect(c.primary).toBe("repeatedExplorationRate");
    expect(c.direction).toBe("better");
    expect(c.delta.repeatedExplorationRate).toBeCloseTo(-0.5, 10);
  });

  it("显式 primaryMetric 优先", () => {
    const c = compareOutcomes(
      withRate({ avoidableErrorRate: 0.1, wasteTokenRate: 0.5 }),
      withRate({ avoidableErrorRate: 0.3, wasteTokenRate: 0.1 }),
      "wasteTokenRate",
    );
    expect(c.primary).toBe("wasteTokenRate");
    expect(c.direction).toBe("better");
  });

  it("样本 <3 → sampleLow=true;≥3 两侧 → false;direction 仍算", () => {
    const s = (r: number): GuidanceOutcome => withRate({ avoidableErrorRate: r });
    const low = compareOutcomes([s(0.3)], [s(0.3), s(0.3)]);
    expect(low.sample).toEqual({ before: 1, after: 2 });
    expect(low.sampleLow).toBe(true);
    expect(low.direction).toBe("flat");
    const enough = compareOutcomes([s(0.3), s(0.3), s(0.3)], [s(0.1), s(0.1), s(0.1)]);
    expect(enough.sampleLow).toBe(false);
    expect(enough.direction).toBe("better");
  });

  it("样本数组取各率均值后再比较", () => {
    const s = (r: number): GuidanceOutcome => withRate({ avoidableErrorRate: r });
    const c = compareOutcomes([s(0.1), s(0.2), s(0.3)], [s(0.1), s(0.1), s(0.1)]);
    expect(c.before.avoidableErrorRate).toBeCloseTo(0.2, 10);
    expect(c.after.avoidableErrorRate).toBeCloseTo(0.1, 10);
    expect(c.delta.avoidableErrorRate).toBeCloseTo(-0.1, 10);
  });

  it("空数组/undefined 两侧 → flat,样本 0,sampleLow", () => {
    const c = compareOutcomes([], undefined);
    expect(c.direction).toBe("flat");
    expect(c.sample).toEqual({ before: 0, after: 0 });
    expect(c.sampleLow).toBe(true);
    expect(c.delta.avoidableErrorRate).toBe(0);
  });
});

describe("toExperimentSample 实验账本样本", () => {
  reset();
  const o = make(steps(10), "coding", { model: "m1", projectId: "p1", baselineSteps: 8 });

  it("缺省指标 = avoidableErrorRate;stratum 对齐项目/模型/任务类;note 可读", () => {
    const s = toExperimentSample(o, { intervention: "tip", ref: "dyn:verify-stop" });
    expect(s.metric.name).toBe("avoidableErrorRate");
    expect(s.metric.value).toBe(o.avoidableErrorRate);
    expect("baseline" in s.metric).toBe(false);
    expect(s.stratum).toEqual({ project: "p1", model: "m1", taskClass: "coding" });
    expect(s.note).toContain("dyn:verify-stop");
    expect(s.note).toContain("coding");
  });

  it("指定 metric + baseline 透传;缺项目/模型用 \"-\"", () => {
    const bare = make(steps(16), "qa");
    const s = toExperimentSample(bare, { intervention: "prompt", ref: "sop:plan", metric: "inefficientDecisionRate", baseline: 0 });
    expect(s.metric).toEqual({ name: "inefficientDecisionRate", value: 1, baseline: 0 });
    expect(s.stratum).toEqual({ project: "-", model: "-", taskClass: "qa" });
  });

  it("非法 metric 名回落 avoidableErrorRate;不改 outcome", () => {
    const before = { ...o };
    const s = toExperimentSample(o, { intervention: "x", ref: "y", metric: "nope" as never });
    expect(s.metric.name).toBe("avoidableErrorRate");
    expect(o).toEqual(before);
  });

  it("outcome 为空/畸形不 throw", () => {
    const s = toExperimentSample(undefined, undefined);
    expect(s.metric.value).toBe(0);
    expect(s.stratum.taskClass).toBe("-");
  });
});

describe("确定性 / 不可变", () => {
  it("同输入两次深相等", () => {
    reset();
    const evs = [...steps(3), readCall("a.ts"), readCall("a.ts"), result("错误: x"), trace(120, "e")];
    expect(make(evs)).toEqual(make(evs));
    expect(compareOutcomes(make(evs), make(evs))).toEqual(compareOutcomes(make(evs), make(evs)));
  });

  it("不修改入参数组与事件对象(内部排序副本)", () => {
    const evs: GuidanceOutcomeEvent[] = [ev("tool.call", { name: "read_file", arguments: '{"path":"a.ts"}' }, 9), ev("step.start", {}, 1)];
    const order = evs.map((e) => e.seq);
    const snapshot = JSON.stringify(evs);
    computeGuidanceOutcome(evs, { taskClass: "coding" });
    expect(evs.map((e) => e.seq)).toEqual(order);
    expect(JSON.stringify(evs)).toBe(snapshot);
  });

  it("返回值与内部结构冻结(不可变)", () => {
    reset();
    const o = make([readCall("a.ts"), readCall("a.ts")]);
    expect(Object.isFrozen(o)).toBe(true);
    const g = stratifyOutcomes([o]).get("-|-|coding")!;
    expect(Object.isFrozen(g)).toBe(true);
    expect(Object.isFrozen(g.avg)).toBe(true);
    expect(Object.isFrozen(g.sums)).toBe(true);
    const c = compareOutcomes([o], [o]);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.delta)).toBe(true);
  });

  it("畸形事件(payload 非对象/kind 缺失/seq 非数字)不 throw", () => {
    reset();
    const junk = [
      { seq: "x", kind: "tool.call", payload: "oops" },
      { seq: 2, kind: "llm.trace", payload: { usage: "bad" } },
      { seq: 3, kind: "", payload: null },
      null as never,
      undefined as never,
    ];
    const o = computeGuidanceOutcome(junk as never, { taskClass: "coding" });
    expect(o.toolCalls).toBe(1);
    expect(o.totalTokens).toBe(0);
    expect(o.avoidableErrorRate).toBe(0);
  });
});
