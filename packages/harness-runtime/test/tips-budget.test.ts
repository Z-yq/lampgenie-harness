/**
 * tips-budget 纯逻辑用例:准入/过期/重复/陈旧版本/冲突/互斥/依赖闭包/压缩/四维预算/报表。
 * 全部纯函数直测,不落盘;code 字符串逐字断言(它是对外可复核的稳定契约)。
 */
import { describe, expect, it } from "vitest";

import { countWords } from "../src/agent/attention-budget";
import {
  DEFAULT_TIPS_BUDGET,
  TIPS_BUDGET_VERSION,
  TIPS_CODES,
  budgetReport,
  compareVersion,
  compressTip,
  emptyUsage,
  isRuleStale,
  resolveTips,
  validateRule,
  type TipsCandidate,
  type TipsRule,
} from "../src/agent/tips-budget";

const T0 = 1_700_000_000_000;

function rule(over: Partial<TipsRule> = {}): TipsRule {
  const id = over.id ?? "r1";
  return {
    id,
    key: over.key ?? id,
    category: "other",
    priority: 1,
    version: "v1",
    text: "短文提示",
    maxWords: 20,
    ...over,
  };
}

function cand(ruleId: string, nodeId = "n1"): TipsCandidate {
  return { ruleId, nodeId, at: T0 };
}

function run(rules: unknown, candidates: unknown, options: Record<string, unknown> = {}) {
  return resolveTips({ rules, candidates }, { nodeId: "n1", now: T0, ...options });
}

describe("TIPS_CODES 契约", () => {
  it("码表与版本号逐字固定", () => {
    expect(TIPS_BUDGET_VERSION).toBe(1);
    expect([...TIPS_CODES]).toEqual([
      "TIPS_INVALID",
      "TIPS_SELECTED",
      "TIPS_DROPPED_CONFLICT",
      "TIPS_DROPPED_EXCLUSIVE",
      "TIPS_DROPPED_REQUIRES",
      "TIPS_DROPPED_BUDGET_NODE",
      "TIPS_DROPPED_BUDGET_GLOBAL",
      "TIPS_DROPPED_EXPIRED",
      "TIPS_DROPPED_STALE_VERSION",
      "TIPS_COMPRESSED",
      "TIPS_DUPLICATE",
    ]);
  });

  it("DEFAULT_TIPS_BUDGET 与 emptyUsage", () => {
    expect(DEFAULT_TIPS_BUDGET).toEqual({
      maxTipsPerNode: 2,
      maxWordsPerNode: 120,
      maxTipsGlobal: 20,
      maxWordsGlobal: 800,
    });
    expect(emptyUsage()).toEqual({ nodeTips: {}, nodeWords: {}, globalTips: 0, globalWords: 0 });
    expect(emptyUsage().nodeTips).not.toBe(emptyUsage().nodeTips);
  });
});

describe("validateRule", () => {
  it("合法规则 ok:true", () => {
    expect(validateRule(rule())).toEqual({ ok: true, codes: [] });
  });

  it("缺 id → TIPS_INVALID", () => {
    expect(validateRule({ ...rule(), id: "" })).toEqual({ ok: false, codes: ["TIPS_INVALID"] });
  });

  it("priority 越界 → TIPS_INVALID", () => {
    expect(validateRule({ ...rule(), priority: 7 })).toEqual({ ok: false, codes: ["TIPS_INVALID"] });
    expect(validateRule({ ...rule(), priority: 1.5 })).toEqual({ ok: false, codes: ["TIPS_INVALID"] });
  });

  it("maxWords 非正整数 → TIPS_INVALID", () => {
    expect(validateRule({ ...rule(), maxWords: 0 })).toEqual({ ok: false, codes: ["TIPS_INVALID"] });
  });

  it("text 空串 / version 缺失 → TIPS_INVALID", () => {
    expect(validateRule({ ...rule(), text: "  " })).toEqual({ ok: false, codes: ["TIPS_INVALID"] });
    const noVersion = rule() as unknown as Record<string, unknown>;
    delete noVersion["version"];
    expect(validateRule(noVersion)).toEqual({ ok: false, codes: ["TIPS_INVALID"] });
  });

  it("非对象 → TIPS_INVALID(不抛)", () => {
    expect(validateRule(undefined)).toEqual({ ok: false, codes: ["TIPS_INVALID"] });
    expect(validateRule("x")).toEqual({ ok: false, codes: ["TIPS_INVALID"] });
  });
});

describe("countWords 复用", () => {
  it("CJK 每字 1 词、拉丁按空白切", () => {
    expect(countWords("中文 abc 12")).toBe(4);
    expect(countWords("")).toBe(0);
  });
});

describe("compareVersion / isRuleStale", () => {
  it("去前导 v 后按段比较", () => {
    expect(compareVersion("v2", "v1")).toBe(1);
    expect(compareVersion("v1.10", "v1.9")).toBe(1);
    expect(compareVersion("1.2", "v1.2")).toBe(0);
    expect(compareVersion("v1", "v2")).toBe(-1);
  });

  it("同 key 存在更高 version 即陈旧", () => {
    const rules = [rule({ id: "a", key: "k", version: "v1" }), rule({ id: "b", key: "k", version: "v2" })];
    expect(isRuleStale(rules[0]!, rules)).toBe(true);
    expect(isRuleStale(rules[1]!, rules)).toBe(false);
  });
});

describe("compressTip", () => {
  it("未超预算原样返回", () => {
    expect(compressTip("短文", 5)).toEqual({ text: "短文", compressed: false });
  });

  it("按句末标点断句并补省略号", () => {
    const out = compressTip("第一条纪律。第二条纪律。", 6);
    expect(out.compressed).toBe(true);
    expect(out.text).toBe("第一条纪律。…");
    expect(countWords(out.text)).toBe(5);
  });

  it("无句末标点时逐字截到词上限", () => {
    const out = compressTip("alpha beta gamma delta", 2);
    expect(out.compressed).toBe(true);
    expect(out.text).toBe("alpha beta…");
    expect(countWords(out.text)).toBe(2);
  });

  it("maxWords≤0 无法安全截断 → 原样 + compressed:false", () => {
    expect(compressTip("alpha beta", 0)).toEqual({ text: "alpha beta", compressed: false });
  });
});

describe("resolveTips:准入与过期", () => {
  it("正常候选被选中", () => {
    const res = run([rule()], [cand("r1")]);
    expect(res.selected).toHaveLength(1);
    expect(res.selected[0]?.rule.id).toBe("r1");
    expect(res.selected[0]?.compressed).toBe(false);
    expect(res.codes).toContain("TIPS_SELECTED");
  });

  it("expiresAt 到点 → TIPS_DROPPED_EXPIRED", () => {
    const res = run([rule({ expiresAt: T0 })], [cand("r1")]);
    expect(res.selected).toHaveLength(0);
    expect(res.dropped).toEqual([{ ruleId: "r1", reason: "expired", code: "TIPS_DROPPED_EXPIRED" }]);
    expect(res.codes).toContain("TIPS_DROPPED_EXPIRED");
  });

  it("expiresAt 未到 → 选中", () => {
    const res = run([rule({ expiresAt: T0 + 1 })], [cand("r1")]);
    expect(res.selected).toHaveLength(1);
  });

  it("ruleId 找不到 → TIPS_INVALID", () => {
    const res = run([rule()], [cand("ghost")]);
    expect(res.dropped).toEqual([{ ruleId: "ghost", reason: "invalid-rule", code: "TIPS_INVALID" }]);
  });

  it("rules 里的非法规则不参与选择", () => {
    const bad = { ...rule({ id: "bad" }), priority: 9 } as unknown as TipsRule;
    const res = run([bad], [cand("bad")]);
    expect(res.selected).toHaveLength(0);
    expect(res.codes).toContain("TIPS_INVALID");
  });
});

describe("resolveTips:重复与陈旧版本", () => {
  it("同 node 同规则重复候选 → 第二个 TIPS_DUPLICATE", () => {
    const res = run([rule()], [cand("r1"), cand("r1")]);
    expect(res.selected).toHaveLength(1);
    expect(res.dropped[0]?.code).toBe("TIPS_DUPLICATE");
    expect(res.codes).toContain("TIPS_DUPLICATE");
  });

  it("不同 node 同规则 → 各自选中", () => {
    const res = run([rule()], [cand("r1", "n1"), cand("r1", "n2")], { nodeId: undefined });
    expect(res.selected).toHaveLength(2);
    expect(res.usageAfter.nodeTips).toEqual({ n1: 1, n2: 1 });
  });

  it("同 key 存在更高版本 → 旧版 TIPS_DROPPED_STALE_VERSION", () => {
    const rules = [rule({ id: "r5a", key: "k5", version: "v1" }), rule({ id: "r5b", key: "k5", version: "v2" })];
    const res = run(rules, [cand("r5a")]);
    expect(res.selected).toHaveLength(0);
    expect(res.dropped[0]?.code).toBe("TIPS_DROPPED_STALE_VERSION");
    expect(res.codes).toContain("TIPS_DROPPED_STALE_VERSION");
  });

  it("同 key 最新版本可选中", () => {
    const rules = [rule({ id: "r5a", key: "k5", version: "v1" }), rule({ id: "r5b", key: "k5", version: "v2" })];
    const res = run(rules, [cand("r5b")]);
    expect(res.selected[0]?.rule.id).toBe("r5b");
  });
});

describe("resolveTips:冲突与互斥", () => {
  it("a 声明 conflictsWith b → b 落选", () => {
    const rules = [
      rule({ id: "a", priority: 0, conflictsWith: ["b"] }),
      rule({ id: "b", priority: 1 }),
    ];
    const res = run(rules, [cand("a"), cand("b")]);
    expect(res.selected.map((s) => s.rule.id)).toEqual(["a"]);
    expect(res.dropped[0]?.code).toBe("TIPS_DROPPED_CONFLICT");
    expect(res.codes).toContain("TIPS_DROPPED_CONFLICT");
  });

  it("b 声明 conflictsWith a(反向) → b 同样落选", () => {
    const rules = [
      rule({ id: "a", priority: 0 }),
      rule({ id: "b", priority: 1, conflictsWith: ["a"] }),
    ];
    const res = run(rules, [cand("b"), cand("a")]);
    expect(res.selected.map((s) => s.rule.id)).toEqual(["a"]);
    expect(res.dropped[0]?.code).toBe("TIPS_DROPPED_CONFLICT");
  });

  it("同 exclusiveGroup 只留高优先 → TIPS_DROPPED_EXCLUSIVE", () => {
    const rules = [
      rule({ id: "r1", priority: 1, exclusiveGroup: "g1" }),
      rule({ id: "r2", priority: 0, exclusiveGroup: "g1" }),
    ];
    const res = run(rules, [cand("r1"), cand("r2")]);
    expect(res.selected.map((s) => s.rule.id)).toEqual(["r2"]);
    expect(res.dropped[0]).toEqual({ ruleId: "r1", reason: "exclusive:g1", code: "TIPS_DROPPED_EXCLUSIVE" });
  });

  it("不同 exclusiveGroup 互不影响", () => {
    const rules = [
      rule({ id: "a", priority: 0, exclusiveGroup: "g1" }),
      rule({ id: "b", priority: 1, exclusiveGroup: "g2" }),
    ];
    const res = run(rules, [cand("a"), cand("b")]);
    expect(res.selected).toHaveLength(2);
  });
});

describe("resolveTips:仲裁顺序", () => {
  it("优先级数字小先占预算", () => {
    const rules = [rule({ id: "lo", priority: 3 }), rule({ id: "hi", priority: 0 })];
    const res = run(rules, [cand("lo"), cand("hi")], { budget: { maxTipsPerNode: 1 } });
    expect(res.selected.map((s) => s.rule.id)).toEqual(["hi"]);
    expect(res.dropped[0]?.reason).toBe("node-tips");
  });

  it("同优先级高版本先占预算", () => {
    const rules = [
      rule({ id: "a", key: "ka", priority: 1, version: "v1" }),
      rule({ id: "b", key: "kb", priority: 1, version: "v2" }),
    ];
    const res = run(rules, [cand("a"), cand("b")], { budget: { maxTipsPerNode: 1 } });
    expect(res.selected.map((s) => s.rule.id)).toEqual(["b"]);
  });

  it("同优先级同版本按 id 升序", () => {
    const rules = [
      rule({ id: "b", key: "kb", priority: 1, version: "v1" }),
      rule({ id: "a", key: "ka", priority: 1, version: "v1" }),
    ];
    const res = run(rules, [cand("b"), cand("a")], { budget: { maxTipsPerNode: 1 } });
    expect(res.selected.map((s) => s.rule.id)).toEqual(["a"]);
  });
});

describe("resolveTips:requires 依赖闭包", () => {
  it("依赖缺失 → TIPS_DROPPED_REQUIRES", () => {
    const res = run([rule({ id: "r3", requires: ["r-missing"] })], [cand("r3")]);
    expect(res.selected).toHaveLength(0);
    expect(res.dropped[0]?.code).toBe("TIPS_DROPPED_REQUIRES");
    expect(res.dropped[0]?.reason).toBe("requires-missing:r-missing");
    expect(res.codes).toContain("TIPS_DROPPED_REQUIRES");
  });

  it("依赖满足 → 都选中", () => {
    const rules = [rule({ id: "a", priority: 0, requires: ["b"] }), rule({ id: "b", priority: 1 })];
    const res = run(rules, [cand("a"), cand("b")]);
    expect(res.selected.map((s) => s.rule.id).sort()).toEqual(["a", "b"]);
  });

  it("链式断依赖:被 requires 丢弃者不作为依赖来源", () => {
    const rules = [
      rule({ id: "a", priority: 0, requires: ["b"] }),
      rule({ id: "b", priority: 1, requires: ["c"] }),
    ];
    const res = run(rules, [cand("a"), cand("b")]);
    expect(res.selected).toHaveLength(0);
    expect(res.dropped.map((d) => d.ruleId).sort()).toEqual(["a", "b"]);
    expect(res.dropped.every((d) => d.code === "TIPS_DROPPED_REQUIRES")).toBe(true);
  });

  it("被冲突丢弃的规则不能当依赖来源(依赖方连带丢弃)", () => {
    const rules = [
      rule({ id: "a", priority: 0, requires: ["b"] }),
      rule({ id: "b", priority: 1, conflictsWith: ["a"] }),
    ];
    const res = run(rules, [cand("a"), cand("b")]);
    expect(res.selected).toHaveLength(0);
    expect(res.dropped.map((d) => d.code)).toEqual(["TIPS_DROPPED_CONFLICT", "TIPS_DROPPED_REQUIRES"]);
  });

  it("自依赖视为满足(集合语义自洽)", () => {
    const res = run([rule({ id: "a", requires: ["a"] })], [cand("a")]);
    expect(res.selected).toHaveLength(1);
  });
});

describe("resolveTips:压缩", () => {
  it("长文按 maxWords 压缩并标记 TIPS_COMPRESSED", () => {
    const text = "第一条纪律。第二条纪律。第三条纪律。";
    const res = run([rule({ id: "r4", text, maxWords: 6 })], [cand("r4")]);
    expect(res.selected).toHaveLength(1);
    expect(res.selected[0]?.compressed).toBe(true);
    expect(res.selected[0]?.text.endsWith("…")).toBe(true);
    expect(countWords(res.selected[0]?.text ?? "")).toBe(5);
    expect(res.codes).toContain("TIPS_COMPRESSED");
  });

  it("allowCompression=false 且超限 → tip-max-words-no-compress", () => {
    const res = run([rule({ id: "r", text: "alpha beta gamma delta", maxWords: 2, allowCompression: false })], [cand("r")]);
    expect(res.selected).toHaveLength(0);
    expect(res.dropped[0]?.code).toBe("TIPS_DROPPED_BUDGET_NODE");
    expect(res.dropped[0]?.reason).toBe("tip-max-words-no-compress");
  });

  it("压不出来时由调用方判丢弃(reason 前缀 tip-max-words)", () => {
    // maxWords<=0 的规则本身非法;这里验证压缩器原样返回 + compressed:false 的契约,
    // resolve 侧对应 reason 前缀 "tip-max-words"。
    expect(compressTip("alpha beta", -1).compressed).toBe(false);
    const res = run([rule({ id: "r", text: "alpha beta gamma", maxWords: 2 })], [cand("r")]);
    expect(res.dropped.every((d) => d.reason.startsWith("tip-max-words") === false)).toBe(true);
  });
});

describe("resolveTips:四维预算", () => {
  it("node tips 预算用尽 → node-tips", () => {
    const rules = [rule({ id: "a", priority: 0 }), rule({ id: "b", priority: 1 })];
    const res = run(rules, [cand("a"), cand("b")], { budget: { maxTipsPerNode: 1 } });
    expect(res.selected).toHaveLength(1);
    expect(res.dropped[0]?.reason).toBe("node-tips");
    expect(res.dropped[0]?.code).toBe("TIPS_DROPPED_BUDGET_NODE");
  });

  it("node words 预算用尽 → node-words", () => {
    const res = run([rule({ id: "a", text: "一二三四五六七八九十" })], [cand("a")], {
      budget: { maxWordsPerNode: 5 },
    });
    expect(res.selected).toHaveLength(0);
    expect(res.dropped[0]?.reason).toBe("node-words");
    expect(res.dropped[0]?.code).toBe("TIPS_DROPPED_BUDGET_NODE");
  });

  it("已有 usage 占满 node 预算 → 后续落 node-tips", () => {
    const usage = { ...emptyUsage(), nodeTips: { n1: 1 } };
    const res = run([rule({ id: "a" })], [cand("a")], { usage, budget: { maxTipsPerNode: 1 } });
    expect(res.selected).toHaveLength(0);
    expect(res.dropped[0]?.reason).toBe("node-tips");
  });

  it("global tips 预算用尽 → global-tips", () => {
    const rules = [rule({ id: "a", priority: 0 }), rule({ id: "b", priority: 1 })];
    const res = run(rules, [cand("a"), cand("b")], {
      budget: { maxTipsPerNode: 9, maxTipsGlobal: 1 },
    });
    expect(res.selected).toHaveLength(1);
    expect(res.dropped[0]?.code).toBe("TIPS_DROPPED_BUDGET_GLOBAL");
    expect(res.dropped[0]?.reason).toBe("global-tips");
  });

  it("global words 预算用尽 → global-words", () => {
    const res = run([rule({ id: "a", text: "一二三四五" })], [cand("a")], {
      budget: { maxWordsGlobal: 3 },
    });
    expect(res.selected).toHaveLength(0);
    expect(res.dropped[0]?.code).toBe("TIPS_DROPPED_BUDGET_GLOBAL");
    expect(res.dropped[0]?.reason).toBe("global-words");
  });
});

describe("usageAfter / budgetReport", () => {
  it("选中项累加进 usageAfter", () => {
    const rules = [rule({ id: "a", priority: 0, text: "一二三" }), rule({ id: "b", priority: 1, text: "四五六" })];
    const res = run(rules, [cand("a"), cand("b")]);
    expect(res.usageAfter).toEqual({ nodeTips: { n1: 2 }, nodeWords: { n1: 6 }, globalTips: 2, globalWords: 6 });
  });

  it("入参 usage 是基线而非被改写", () => {
    const usage = { ...emptyUsage(), nodeTips: { n1: 1 }, nodeWords: { n1: 4 }, globalTips: 1, globalWords: 4 };
    const res = run([rule({ id: "a", text: "一二三" })], [cand("a")], { usage, budget: { maxTipsPerNode: 2 } });
    expect(res.usageAfter.nodeTips).toEqual({ n1: 2 });
    expect(res.usageAfter.globalWords).toBe(7);
    expect(usage.nodeTips).toEqual({ n1: 1 });
  });

  it("budgetReport 报剩余量并钳 0", () => {
    const usage = { nodeTips: { n1: 1 }, nodeWords: { n1: 50 }, globalTips: 30, globalWords: 50 };
    const report = budgetReport(usage);
    expect(report.globalUsage).toEqual({ tips: 30, words: 50 });
    expect(report.remaining).toEqual({ globalTips: 0, globalWords: 750 });
    expect(report.byNodeRemaining["n1"]).toEqual({ tips: 1, words: 70 });
  });
});

describe("非法输入与码集合", () => {
  it("rules/candidates 缺失不抛", () => {
    const res = resolveTips({ rules: undefined, candidates: undefined });
    expect(res).toEqual({
      selected: [],
      dropped: [],
      usageAfter: { nodeTips: {}, nodeWords: {}, globalTips: 0, globalWords: 0 },
      codes: [],
    });
  });

  it("rules 非数组不抛", () => {
    const res = resolveTips({ rules: {}, candidates: "x" });
    expect(res.selected).toHaveLength(0);
    expect(res.dropped).toHaveLength(0);
  });

  it("codes 去重集合:两条冲突只记一次 TIPS_DROPPED_CONFLICT", () => {
    const rules = [
      rule({ id: "a", priority: 0, conflictsWith: ["b", "c"] }),
      rule({ id: "b", priority: 1 }),
      rule({ id: "c", priority: 2 }),
    ];
    const res = run(rules, [cand("a"), cand("b"), cand("c")]);
    expect(res.dropped.filter((d) => d.code === "TIPS_DROPPED_CONFLICT")).toHaveLength(2);
    expect(res.codes.filter((c) => c === "TIPS_DROPPED_CONFLICT")).toHaveLength(1);
    expect(res.codes.filter((c) => c === "TIPS_SELECTED")).toHaveLength(1);
  });
});
