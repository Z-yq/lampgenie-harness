/**
 * 漏点预防路由:常量口径 → 默认分类法 → 选择/路由 → 合并/调权 → 落地/过期/图谱投影。
 * 全部纯数据 + 固定时间戳常量,不碰文件与真实时钟。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TAXONOMY,
  FORM_COST,
  GAP_CATEGORIES,
  GAP_CODES,
  GAP_TAXONOMY_VERSION,
  INJECTION_POINTS,
  PREVENTION_FORMS,
  applyAt,
  bumpConfidence,
  expireEntries,
  isGapCategory,
  mergeRouting,
  recommendForm,
  routeGap,
  selectPrevention,
  toGraphNodes,
} from "../src/agent/gap-taxonomy.ts";
import type { DecisionRecord, PreventionEntry } from "../src/agent/gap-taxonomy.ts";

const T0 = 1_700_000_000_000;
const GARBAGE = [null, undefined, 0, 1, "", "nope", [], {}, () => 0, Symbol("s"), NaN];

function entry(base: Partial<PreventionEntry> = {}): PreventionEntry {
  return {
    id: "e-1",
    gapCategory: "requirement",
    form: "context",
    carrier: "carrier",
    injectionPoint: "pre-requirement",
    guidance: "guidance",
    trigger: {},
    confidence: 0.5,
    overfitRisk: "low",
    sourceDefectIds: [],
    createdAt: T0,
    ...base,
  };
}

function ids(list: PreventionEntry[]): string[] {
  return list.map((item) => item.id);
}

describe("常量口径", () => {
  it("GAP_TAXONOMY_VERSION 为 1", () => {
    expect(GAP_TAXONOMY_VERSION).toBe(1);
  });

  it("GAP_CATEGORIES 逐字覆盖缺陷血缘七类", () => {
    expect(GAP_CATEGORIES).toHaveLength(7);
    expect([...GAP_CATEGORIES]).toEqual([
      "requirement",
      "plan-coverage",
      "verification-coverage",
      "knowledge-gap",
      "tool-gap",
      "wrong-assumption",
      "impact-analysis",
    ]);
    expect([...GAP_CATEGORIES]).not.toContain("none");
  });

  it("PREVENTION_FORMS 按成本递增(context<gate<tool)", () => {
    expect([...PREVENTION_FORMS]).toEqual(["context", "gate", "tool"]);
    expect(FORM_COST.context).toBe(0);
    expect(FORM_COST.context).toBeLessThan(FORM_COST.gate);
    expect(FORM_COST.gate).toBeLessThan(FORM_COST.tool);
  });

  it("INJECTION_POINTS 五个注入点", () => {
    expect([...INJECTION_POINTS]).toEqual(["pre-requirement", "pre-plan", "pre-write", "pre-verify", "pre-close"]);
  });

  it("GAP_CODES 三个稳定码", () => {
    expect(GAP_CODES).toEqual({
      ROUTED: "GAP_ROUTED",
      NO_MATCH: "GAP_NO_MATCH",
      CATEGORY_NONE: "GAP_CATEGORY_NONE",
    });
  });

  it("isGapCategory 只认七类", () => {
    for (const category of GAP_CATEGORIES) expect(isGapCategory(category)).toBe(true);
    for (const value of [...GARBAGE, "none", "Requirement"]) expect(isGapCategory(value)).toBe(false);
  });
});

describe("默认分类法", () => {
  it("共 14 条且 id 唯一", () => {
    expect(DEFAULT_TAXONOMY).toHaveLength(14);
    expect(new Set(ids(DEFAULT_TAXONOMY)).size).toBe(14);
  });

  it("createdAt 统一常量、sourceDefectIds 为空数组", () => {
    for (const item of DEFAULT_TAXONOMY) {
      expect(item.createdAt).toBe(T0);
      expect(item.sourceDefectIds).toEqual([]);
    }
  });

  it.each([...GAP_CATEGORIES])("%s 至少两条默认条目", (category) => {
    expect(DEFAULT_TAXONOMY.filter((item) => item.gapCategory === category).length).toBeGreaterThanOrEqual(2);
  });

  it.each([...GAP_CATEGORIES])("%s 至少一条 context 条目", (category) => {
    expect(
      DEFAULT_TAXONOMY.filter((item) => item.gapCategory === category && item.form === "context").length).toBeGreaterThanOrEqual(1);
  });

  it.each([...GAP_CATEGORIES])("%s 至少一条通配条目(trigger 全空)", (category) => {
    const wildcards = DEFAULT_TAXONOMY.filter(
      (item) =>
        item.gapCategory === category &&
        Object.values(item.trigger).every((value) => value === undefined),
    );
    expect(wildcards.length).toBeGreaterThanOrEqual(1);
  });

  it("形态/注入点/风险枚举都合法", () => {
    for (const item of DEFAULT_TAXONOMY) {
      expect(PREVENTION_FORMS).toContain(item.form);
      expect(INJECTION_POINTS).toContain(item.injectionPoint);
      expect(["low", "medium", "high"]).toContain(item.overfitRisk);
      expect(item.confidence).toBeGreaterThanOrEqual(0);
      expect(item.confidence).toBeLessThanOrEqual(1);
      expect(item.carrier.length).toBeGreaterThan(0);
      expect(item.guidance.length).toBeGreaterThan(0);
    }
  });
});

describe("selectPrevention", () => {
  it("非法 category 返回空数组", () => {
    expect(selectPrevention("none")).toEqual([]);
    expect(selectPrevention("bogus")).toEqual([]);
    expect(selectPrevention("" as unknown as string)).toEqual([]);
  });

  it("按形态成本升序排列", () => {
    for (const category of GAP_CATEGORIES) {
      const costs = selectPrevention(category).map((item) => FORM_COST[item.form]);
      expect(costs).toEqual([...costs].sort((a, b) => a - b));
    }
  });

  it("同形态内按 confidence 降序", () => {
    const low = entry({ id: "a-low", confidence: 0.4 });
    const high = entry({ id: "b-high", confidence: 0.8 });
    const gate = entry({ id: "c-gate", form: "gate", confidence: 0.99 });
    const picked = selectPrevention("requirement", { entries: [low, gate, high] });
    expect(ids(picked)).toEqual(["b-high", "a-low", "c-gate"]);
  });

  it("prefer 把指定形态提到最前,其余顺序不变", () => {
    const ctx = entry({ id: "a-ctx", confidence: 0.9 });
    const gate = entry({ id: "b-gate", form: "gate", confidence: 0.7 });
    const tool = entry({ id: "c-tool", form: "tool", confidence: 0.6 });
    const picked = selectPrevention("requirement", { entries: [ctx, gate, tool], prefer: "tool" });
    expect(ids(picked)).toEqual(["c-tool", "a-ctx", "b-gate"]);
  });

  it("maxEntries 截断,0 返回空", () => {
    expect(selectPrevention("requirement", { maxEntries: 1 })).toHaveLength(1);
    expect(ids(selectPrevention("requirement", { maxEntries: 1 }))).toEqual(["req-context-questions"]);
    expect(selectPrevention("requirement", { maxEntries: 0 })).toEqual([]);
    expect(selectPrevention("requirement", { maxEntries: 99 })).toHaveLength(2);
  });

  it("只返回该 category 的条目", () => {
    for (const item of selectPrevention("tool-gap")) expect(item.gapCategory).toBe("tool-gap");
  });

  it("不修改 DEFAULT_TAXONOMY", () => {
    const before = ids(DEFAULT_TAXONOMY);
    selectPrevention("requirement", { prefer: "tool" });
    expect(ids(DEFAULT_TAXONOMY)).toEqual(before);
  });
});

describe("routeGap", () => {
  it("boardType 命中受约束条目", () => {
    const result = routeGap({ missedLink: "plan-coverage", boardType: "code" });
    expect(result.codes).toEqual([GAP_CODES.ROUTED]);
    expect(ids(result.routed)).toEqual(["plan-context-history", "plan-gate-accept-template"]);
    expect(result.matchReasons[0]).toBe("trigger-hit:plan-context-history:boardType=code");
  });

  it("taskClass 命中受约束条目", () => {
    const result = routeGap({ missedLink: "verification-coverage", taskClass: "coding" });
    expect(ids(result.routed)).toContain("verify-context-musttest");
    expect(result.matchReasons).toContain("trigger-hit:verify-context-musttest:taskClass=coding");
  });

  it("module 命中(自定义条目)", () => {
    const entries = [
      entry({ id: "mod-ctx", trigger: { module: "src/agent" } }),
      entry({ id: "wild", form: "gate" }),
    ];
    const result = routeGap({ missedLink: "requirement", module: "src/agent" }, undefined, entries);
    expect(ids(result.routed)).toEqual(["mod-ctx", "wild"]);
    expect(result.matchReasons[0]).toBe("trigger-hit:mod-ctx:module=src/agent");
  });

  it("decisionNode 命中(自定义条目)", () => {
    const entries = [entry({ id: "dn", gapCategory: "impact-analysis", trigger: { decisionNode: "D-42" } })];
    const result = routeGap({ missedLink: "impact-analysis", decisionNode: "D-42" }, undefined, entries);
    expect(ids(result.routed)).toEqual(["dn"]);
    expect(result.matchReasons[0]).toBe("trigger-hit:dn:decisionNode=D-42");
  });

  it("textPattern 正则命中", () => {
    const entries = [entry({ id: "txt", trigger: { textPattern: "retry|timeout" } })];
    const result = routeGap({ missedLink: "requirement", text: "retry loop double fires" }, undefined, entries);
    expect(ids(result.routed)).toEqual(["txt"]);
    expect(result.matchReasons[0]).toBe("trigger-hit:txt:textPattern=retry|timeout");
  });

  it("非法正则降级为字面 includes", () => {
    const entries = [
      entry({ id: "txt", trigger: { textPattern: "capture[(" } }),
      entry({ id: "wild", form: "gate" }),
    ];
    const hit = routeGap({ missedLink: "requirement", text: "见 capture[( 分支" }, undefined, entries);
    expect(ids(hit.routed)).toEqual(["txt", "wild"]);
    const miss = routeGap({ missedLink: "requirement", text: "无关文本" }, undefined, entries);
    expect(ids(miss.routed)).toEqual(["wild"]);
  });

  it("字段不匹配不命中受约束条目", () => {
    const result = routeGap({ missedLink: "plan-coverage", boardType: "doc" });
    expect(ids(result.routed)).not.toContain("plan-context-history");
    expect(ids(result.routed)).toEqual(["plan-gate-accept-template"]);
    expect(result.matchReasons).toEqual(["generic:plan-gate-accept-template"]);
  });

  it("input 缺字段时受约束条目不命中", () => {
    const result = routeGap({ missedLink: "plan-coverage" });
    expect(ids(result.routed)).toEqual(["plan-gate-accept-template"]);
  });

  it("通配条目兜底命中并标 generic", () => {
    const result = routeGap({ missedLink: "knowledge-gap" });
    expect(result.codes).toEqual([GAP_CODES.ROUTED]);
    expect(ids(result.routed)).toEqual(["knowledge-context-reading-pack", "knowledge-gate-read-first"]);
    expect(result.matchReasons).toEqual([
      "generic:knowledge-context-reading-pack",
      "generic:knowledge-gate-read-first",
    ]);
  });

  it("无任何命中时 generic 回退到该 category 全部条目", () => {
    const entries = [
      entry({ id: "c1", trigger: { module: "m1" } }),
      entry({ id: "c2", form: "gate", trigger: { module: "m2" } }),
    ];
    const result = routeGap({ missedLink: "requirement", module: "m9" }, undefined, entries);
    expect(result.codes).toEqual([GAP_CODES.ROUTED]);
    expect(ids(result.routed)).toEqual(["c1", "c2"]);
    expect(result.matchReasons).toEqual(["generic:c1", "generic:c2"]);
  });

  it("missedLink 为 none → GAP_CATEGORY_NONE", () => {
    const result = routeGap({ missedLink: "none" });
    expect(result.routed).toEqual([]);
    expect(result.codes).toEqual([GAP_CODES.CATEGORY_NONE]);
    expect(result.matchReasons).toEqual(["category-none:none"]);
    expect(result.recommendedForm).toBe("context");
  });

  it("missedLink 非法 → GAP_CATEGORY_NONE", () => {
    const result = routeGap({ missedLink: "requirement-gap" });
    expect(result.codes).toEqual([GAP_CODES.CATEGORY_NONE]);
    expect(result.matchReasons[0]).toContain("category-none:");
    expect(result.routed).toEqual([]);
  });

  it("空 input / 非法 input 不抛且返回 CATEGORY_NONE", () => {
    for (const bad of [undefined, null, {}, 1, "x", []] as unknown as { missedLink: string }[]) {
      const result = routeGap(bad);
      expect(result.codes).toEqual([GAP_CODES.CATEGORY_NONE]);
      expect(result.recommendedForm).toBe("context");
    }
  });

  it("category 没有条目 → GAP_NO_MATCH", () => {
    const result = routeGap({ missedLink: "requirement" }, undefined, []);
    expect(result.routed).toEqual([]);
    expect(result.codes).toEqual([GAP_CODES.NO_MATCH]);
    expect(result.matchReasons).toEqual(["no-entry:requirement"]);
  });

  it("routed 顺序遵守形态成本升序", () => {
    const result = routeGap({ missedLink: "tool-gap" });
    expect(ids(result.routed)).toEqual(["tool-context-foundry", "tool-tool-checker"]);
  });

  it("缺省 recommendedForm 为 context", () => {
    expect(routeGap({ missedLink: "requirement" }).recommendedForm).toBe("context");
  });

  it("传入 decisions 时按历史推荐形态", () => {
    const history: DecisionRecord[] = [{ form: "tool", adopted: true }];
    const result = routeGap({ missedLink: "tool-gap" }, history);
    expect(result.recommendedForm).toBe("tool");
    const reverted: DecisionRecord[] = [
      { form: "gate", reverted: true },
      { form: "gate", reverted: true },
    ];
    expect(routeGap({ missedLink: "requirement" }, reverted).recommendedForm).toBe("context");
  });

  it("不修改 DEFAULT_TAXONOMY", () => {
    const before = JSON.stringify(DEFAULT_TAXONOMY);
    routeGap({ missedLink: "requirement", boardType: "code" });
    expect(JSON.stringify(DEFAULT_TAXONOMY)).toBe(before);
  });
});

describe("mergeRouting", () => {
  it("按 category+form+carrier 去重并保留首条身份", () => {
    const first = entry({ id: "a", injectionPoint: "pre-plan", createdAt: 1 });
    const second = entry({ id: "b", injectionPoint: "pre-verify", createdAt: 2 });
    const merged = mergeRouting([first, second]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("a");
    expect(merged[0]?.injectionPoint).toBe("pre-plan");
    expect(merged[0]?.createdAt).toBe(1);
  });

  it("confidence 取 max、overfitRisk 取高", () => {
    const merged = mergeRouting([
      entry({ id: "a", confidence: 0.5, overfitRisk: "low" }),
      entry({ id: "b", confidence: 0.8, overfitRisk: "high" }),
      entry({ id: "c", confidence: 0.7, overfitRisk: "medium" }),
    ]);
    expect(merged[0]?.confidence).toBe(0.8);
    expect(merged[0]?.overfitRisk).toBe("high");
  });

  it("sourceDefectIds 取并集去重", () => {
    const merged = mergeRouting([
      entry({ id: "a", sourceDefectIds: ["D-1", "D-2"] }),
      entry({ id: "b", sourceDefectIds: ["D-2", "D-3"] }),
    ]);
    expect(merged[0]?.sourceDefectIds).toEqual(["D-1", "D-2", "D-3"]);
  });

  it("expiresAt 都有则取更早", () => {
    const merged = mergeRouting([
      entry({ id: "a", expiresAt: 2_000 }),
      entry({ id: "b", expiresAt: 1_000 }),
    ]);
    expect(merged[0]?.expiresAt).toBe(1_000);
    const onlyLate = mergeRouting([entry({ id: "a" }), entry({ id: "b", expiresAt: 5_000 })]);
    expect(onlyLate[0]?.expiresAt).toBe(5_000);
  });

  it("不同 carrier 不合并", () => {
    const merged = mergeRouting([entry({ id: "a", carrier: "x" }), entry({ id: "b", carrier: "y" })]);
    expect(ids(merged)).toEqual(["a", "b"]);
  });

  it("非数组返回空数组且不改入参", () => {
    expect(mergeRouting(undefined as unknown as PreventionEntry[])).toEqual([]);
    const input = [entry({ id: "a", confidence: 0.5 }), entry({ id: "b", confidence: 0.9 })];
    mergeRouting(input);
    expect(input[0]?.confidence).toBe(0.5);
  });
});

describe("bumpConfidence", () => {
  it("每条佐证缺陷 +0.1", () => {
    expect(bumpConfidence(entry({ confidence: 0.6 }), 0).confidence).toBe(0.6);
    expect(bumpConfidence(entry({ confidence: 0.6 }), 2).confidence).toBe(0.8);
  });

  it("上限 0.9", () => {
    expect(bumpConfidence(entry({ confidence: 0.6 }), 3).confidence).toBe(0.9);
    expect(bumpConfidence(entry({ confidence: 0.85 }), 10).confidence).toBe(0.9);
  });

  it("缺 base 按 0.5", () => {
    const broken = entry({ confidence: undefined as unknown as number });
    expect(bumpConfidence(broken, 2).confidence).toBe(0.7);
    expect(bumpConfidence(entry({ confidence: Number.NaN }), 1).confidence).toBeCloseTo(0.6, 6);
  });

  it("负缺陷数按 0 处理", () => {
    expect(bumpConfidence(entry({ confidence: 0.4 }), -5).confidence).toBe(0.4);
    expect(bumpConfidence(entry({ confidence: 0.4 }), Number.NaN).confidence).toBe(0.4);
  });

  it("返回新对象不改入参", () => {
    const source = entry({ id: "keep", confidence: 0.5, sourceDefectIds: ["D-1"] });
    const bumped = bumpConfidence(source, 2);
    expect(bumped).not.toBe(source);
    expect(source.confidence).toBe(0.5);
    expect(bumped.id).toBe("keep");
    expect(bumped.confidence).toBe(0.7);
  });
});

describe("recommendForm", () => {
  it("缺省 context", () => {
    expect(recommendForm("requirement")).toBe("context");
    expect(recommendForm("requirement", { history: [] })).toBe("context");
    expect(recommendForm("requirement", { history: [{ form: "gate" }] })).toBe("context");
  });

  it("gate 回滚占比 >50%(样本 ≥2)降级 context", () => {
    const history: DecisionRecord[] = [
      { form: "gate", reverted: true },
      { form: "gate", reverted: true },
      { form: "tool", adopted: true },
    ];
    expect(recommendForm("verification-coverage", { history })).toBe("context");
  });

  it("tool adopted 且无高回滚记录时推荐 tool", () => {
    expect(recommendForm("tool-gap", { history: [{ form: "tool", adopted: true }] })).toBe("tool");
    expect(
      recommendForm("tool-gap", {
        history: [{ form: "tool", adopted: true }, { form: "gate", reverted: false }],
      }),
    ).toBe("tool");
  });

  it("tool adopted 但回滚过半 → context", () => {
    const history: DecisionRecord[] = [
      { form: "tool", adopted: true },
      { form: "tool", reverted: true },
      { form: "tool", reverted: true },
    ];
    expect(recommendForm("tool-gap", { history })).toBe("context");
  });
});

describe("applyAt", () => {
  const entries = [
    entry({ id: "1", injectionPoint: "pre-plan", guidance: "A" }),
    entry({ id: "2", injectionPoint: "pre-plan", guidance: "A" }),
    entry({ id: "3", form: "gate", injectionPoint: "pre-plan", guidance: "G" }),
    entry({ id: "4", injectionPoint: "pre-verify", guidance: "X" }),
  ];

  it("按 form 分组", () => {
    const applied = applyAt(entries, "pre-plan");
    expect(applied.contextBlocks).toEqual(["A"]);
    expect(applied.gates).toEqual(["G"]);
    expect(applied.toolChecks).toEqual([]);
  });

  it("guidance 去重保序", () => {
    const more = [
      ...entries,
      entry({ id: "5", injectionPoint: "pre-plan", guidance: "B" }),
      entry({ id: "6", form: "gate", injectionPoint: "pre-plan", guidance: "G" }),
    ];
    const applied = applyAt(more, "pre-plan");
    expect(applied.contextBlocks).toEqual(["A", "B"]);
    expect(applied.gates).toEqual(["G"]);
  });

  it("不混入其它注入点", () => {
    expect(applyAt(entries, "pre-plan").contextBlocks).not.toContain("X");
    expect(applyAt(entries, "pre-verify").contextBlocks).toEqual(["X"]);
  });

  it("非法注入点返回空组", () => {
    expect(applyAt(entries, "pre-nothing" as unknown as "pre-plan")).toEqual({
      contextBlocks: [],
      gates: [],
      toolChecks: [],
    });
    expect(applyAt(undefined as unknown as PreventionEntry[], "pre-plan")).toEqual({
      contextBlocks: [],
      gates: [],
      toolChecks: [],
    });
  });
});

describe("expireEntries", () => {
  it("expiresAt === now 算过期", () => {
    const split = expireEntries([entry({ id: "edge", expiresAt: 1_000 })], 1_000);
    expect(ids(split.expired)).toEqual(["edge"]);
    expect(split.active).toEqual([]);
  });

  it("无 expiresAt 恒 active", () => {
    const split = expireEntries([entry({ id: "forever" })], Number.MAX_SAFE_INTEGER);
    expect(ids(split.active)).toEqual(["forever"]);
    expect(split.expired).toEqual([]);
  });

  it("未来 expiresAt 仍 active", () => {
    const split = expireEntries([entry({ id: "later", expiresAt: 5_000 })], 4_999);
    expect(ids(split.active)).toEqual(["later"]);
    expect(split.expired).toEqual([]);
  });

  it("非数组入参不抛", () => {
    expect(expireEntries(undefined as unknown as PreventionEntry[], 1)).toEqual({ active: [], expired: [] });
  });
});

describe("toGraphNodes", () => {
  it("statement 截断到 120 字符以内", () => {
    const nodes = toGraphNodes([entry({ id: "long", carrier: "载体", guidance: "x".repeat(300) })]);
    expect(nodes[0]?.statement.length).toBeLessThanOrEqual(120);
    expect(nodes[0]?.statement.startsWith("载体:")).toBe(true);
  });

  it("associations 来自 trigger.module / trigger.decisionNode", () => {
    const nodes = toGraphNodes([
      entry({ id: "n1", trigger: { module: "src/agent", decisionNode: "D-1" } }),
      entry({ id: "n2", trigger: {} }),
    ]);
    expect(nodes[0]?.associations).toEqual([
      { type: "module", ref: "src/agent" },
      { type: "decision", ref: "D-1" },
    ]);
    expect(nodes[1]?.associations).toEqual([]);
    expect(nodes.every((node) => node.kind === "direction")).toBe(true);
  });

  it("source.note 含 entry.id", () => {
    const nodes = toGraphNodes([entry({ id: "impact-gate-callers" })]);
    expect(nodes[0]?.source.note).toContain("impact-gate-callers");
  });

  it("按 form 成本 + confidence 顺序输出", () => {
    const nodes = toGraphNodes([
      entry({ id: "b-gate", form: "gate", confidence: 0.9 }),
      entry({ id: "a-ctx-low", confidence: 0.4 }),
      entry({ id: "c-ctx-high", confidence: 0.8 }),
    ]);
    expect(nodes.map((node) => node.source.note)).toEqual([
      "gap-prevention:c-ctx-high",
      "gap-prevention:a-ctx-low",
      "gap-prevention:b-gate",
    ]);
  });

  it("非法入参返回空数组", () => {
    expect(toGraphNodes(undefined as unknown as PreventionEntry[])).toEqual([]);
  });
});

describe("非法输入不抛", () => {
  it("全部导出函数对垃圾入参都不抛", () => {
    for (const bad of GARBAGE) {
      expect(() => selectPrevention(bad as unknown as string)).not.toThrow();
      expect(() => selectPrevention("requirement", { prefer: bad as never, maxEntries: bad as never })).not.toThrow();
      expect(() => routeGap(bad as never)).not.toThrow();
      expect(() => mergeRouting(bad as never)).not.toThrow();
      expect(() => bumpConfidence(bad as never, bad as never)).not.toThrow();
      expect(() => recommendForm(bad as never, { history: bad as never })).not.toThrow();
      expect(() => applyAt(bad as never, bad as never)).not.toThrow();
      expect(() => expireEntries(bad as never, bad as never)).not.toThrow();
      expect(() => toGraphNodes(bad as never)).not.toThrow();
      expect(() => isGapCategory(bad)).not.toThrow();
    }
  });
});
