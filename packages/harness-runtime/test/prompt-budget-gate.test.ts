import { describe, expect, it } from "vitest";
import { buildFootprint, type FootprintInput } from "../src/agent/prompt-footprint";
import {
  PROMPT_BUDGET_CODES,
  PROMPT_BUDGET_GATE_VERSION,
  evaluateBudget,
  evaluateDelta,
  negativeReturnPrunes,
  type PromptBudget,
} from "../src/agent/prompt-budget-gate";

/** 固定夹具:中英文混排,避免依赖真实 provider 分词细则(全部对照 buildFootprint 取期望值)。 */
function fixture(): FootprintInput {
  return {
    sections: [
      { id: "sys-core", category: "stable", text: "系统提示词:你是本地数字人管家,先做代码感知再动手。" },
      { id: "mem-1", category: "memory", text: "记忆:用户偏好中文回复,关注 LLM 调用成本。" },
      { id: "skill:coding/tdd", category: "skills_index", text: "tdd: 测试驱动开发,红-绿-重构循环。" },
      { id: "prompt:review", category: "context", text: "评审口径:blocker/high 必修。" },
    ],
    tools: [
      { name: "read_file", description: "读取项目内文本文件", parameters: { path: { type: "string" } } },
      { name: "grep", description: "正则检索", parameters: { pattern: { type: "string" } } },
    ],
    toolset: [{ name: "core", hint: "基础文件工具" }],
  };
}

function snapshot(value: unknown): string {
  return JSON.stringify(value);
}

function categoryUsed(input: FootprintInput, category: keyof ReturnType<typeof buildFootprint>["byCategory"]): number {
  return buildFootprint(input).byCategory[category].tokensEstimate;
}

function totalUsed(input: FootprintInput, column: "tokensEstimate" | "tokensRaw" = "tokensEstimate"): number {
  return buildFootprint(input).total[column];
}

describe(" 预算闸常量与契约", () => {
  it("PROMPT_BUDGET_GATE_VERSION 是三段式版本串", () => {
    expect(PROMPT_BUDGET_GATE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("PROMPT_BUDGET_CODES 覆盖任务要求的 7 个稳定码", () => {
    expect(Object.keys(PROMPT_BUDGET_CODES).sort()).toEqual(
      ["CATEGORY_OVER", "DELTA_OVER", "INVALID", "MANIFEST_INVALID", "NO_BASELINE", "OK", "TOTAL_OVER"].sort(),
    );
  });

  it("稳定码的键与值逐字一致且无重复", () => {
    for (const [key, value] of Object.entries(PROMPT_BUDGET_CODES)) expect(value).toBe(key);
    expect(new Set(Object.values(PROMPT_BUDGET_CODES)).size).toBe(7);
  });
});

describe("evaluateBudget 总量与类别判定", () => {
  it("无预算配置 → OK,不产生任何 check", () => {
    const out = evaluateBudget(fixture(), undefined);
    expect(out.code).toBe("OK");
    expect(out.verdict).toBe("ok");
    expect(out.checks).toEqual([]);
    expect(out.breaches).toEqual([]);
  });

  it("总量 used === limit 属 borderline,算通过", () => {
    const used = totalUsed(fixture());
    const out = evaluateBudget(fixture(), { totalTokens: { estimate: used } });
    expect(out.verdict).toBe("ok");
    expect(out.checks).toHaveLength(1);
    expect(out.checks[0]!.used).toBe(used);
    expect(out.checks[0]!.overBy).toBe(0);
  });

  it("总量超 1 即 TOTAL_OVER 并给出 overBy", () => {
    const used = totalUsed(fixture());
    const out = evaluateBudget(fixture(), { totalTokens: { estimate: used - 1 } });
    expect(out.code).toBe(PROMPT_BUDGET_CODES.TOTAL_OVER);
    expect(out.verdict).toBe("over");
    expect(out.breaches).toHaveLength(1);
    expect(out.breaches[0]!.overBy).toBe(1);
    expect(out.breaches[0]!.scope).toBe("total");
  });

  it("unit=raw 时用 tokensRaw 判定,两列不混用", () => {
    const raw = totalUsed(fixture(), "tokensRaw");
    const estimate = totalUsed(fixture(), "tokensEstimate");
    const out = evaluateBudget(fixture(), { totalTokens: { estimate, raw }, unit: "raw" });
    expect(out.unit).toBe("raw");
    expect(out.checks[0]!.used).toBe(raw);
    expect(out.verdict).toBe("ok");
  });

  it("unit=raw 但配置缺 raw 列时回落 estimate 列", () => {
    const estimate = totalUsed(fixture());
    const out = evaluateBudget(fixture(), { totalTokens: { estimate }, unit: "raw" });
    expect(out.checks[0]!.limit).toBe(estimate);
  });

  it("单类别超限 → CATEGORY_OVER,其它类别不误报", () => {
    const memUsed = categoryUsed(fixture(), "memory");
    const out = evaluateBudget(fixture(), { categories: { memory: { estimate: memUsed - 1 } } });
    expect(out.code).toBe(PROMPT_BUDGET_CODES.CATEGORY_OVER);
    expect(out.breaches).toHaveLength(1);
    expect(out.breaches[0]!.category).toBe("memory");
    expect(out.checks).toHaveLength(1);
  });

  it("单类别 used === limit 通过", () => {
    const memUsed = categoryUsed(fixture(), "memory");
    const out = evaluateBudget(fixture(), { categories: { memory: { estimate: memUsed } } });
    expect(out.verdict).toBe("ok");
    expect(out.breaches).toEqual([]);
  });

  it("只配置的维度才产生 check,未配置类别跳过", () => {
    const out = evaluateBudget(fixture(), { totalTokens: { estimate: 10_000 } });
    expect(out.checks).toHaveLength(1);
    expect(out.checks.every((c) => c.scope === "total")).toBe(true);
  });

  it("total 与 category 同时超限时两条 breach,total 在前", () => {
    const used = totalUsed(fixture());
    const out = evaluateBudget(fixture(), {
      totalTokens: { estimate: 1 },
      categories: { stable: { estimate: 1 } },
    });
    expect(out.breaches.map((b) => b.code)).toEqual(["TOTAL_OVER", "CATEGORY_OVER"]);
    expect(used).toBeGreaterThan(1);
  });

  it("负数上限 → INVALID 且不输出半截 checks", () => {
    const out = evaluateBudget(fixture(), { totalTokens: { estimate: -1 } });
    expect(out.code).toBe(PROMPT_BUDGET_CODES.INVALID);
    expect(out.verdict).toBe("invalid");
    expect(out.checks).toEqual([]);
    expect(out.breaches[0]!.message).toContain("totalTokens");
  });

  it("非有限上限 → INVALID", () => {
    const out = evaluateBudget(fixture(), { categories: { memory: { estimate: Number.NaN } } });
    expect(out.code).toBe(PROMPT_BUDGET_CODES.INVALID);
  });

  it("categories 非对象时视为未配置,不报 breach", () => {
    const out = evaluateBudget(fixture(), { categories: "bad" as unknown as PromptBudget["categories"] });
    expect(out.verdict).toBe("ok");
    expect(out.checks).toEqual([]);
  });

  it("输入为 null → MANIFEST_INVALID 且给空报表", () => {
    const out = evaluateBudget(null, { totalTokens: { estimate: 1 } });
    expect(out.code).toBe(PROMPT_BUDGET_CODES.MANIFEST_INVALID);
    expect(out.report.total.tokensEstimate).toBe(0);
    expect(out.breaches[0]!.message).toContain("manifest");
  });

  it("输入可接受 JSON 字符串(复用 parseFootprintManifest)", () => {
    const out = evaluateBudget(JSON.stringify(fixture()), undefined);
    expect(out.report.total.tokensEstimate).toBe(totalUsed(fixture()));
  });

  it("坏 JSON 字符串 → MANIFEST_INVALID", () => {
    const out = evaluateBudget("{not json", undefined);
    expect(out.code).toBe(PROMPT_BUDGET_CODES.MANIFEST_INVALID);
    expect(out.breaches[0]!.message).toContain("JSON");
  });

  it("确定性:同输入两次输出逐字一致", () => {
    const budget: PromptBudget = { totalTokens: { estimate: 3 }, categories: { memory: { estimate: 1 } } };
    expect(snapshot(evaluateBudget(fixture(), budget))).toBe(snapshot(evaluateBudget(fixture(), budget)));
  });

  it("不可变:输入 manifest 与预算对象在调用后字节不变", () => {
    const input = fixture();
    const budget: PromptBudget = { totalTokens: { estimate: 1 }, categories: { memory: { estimate: 1 } } };
    const beforeInput = snapshot(input);
    const beforeBudget = snapshot(budget);
    evaluateBudget(input, budget);
    expect(snapshot(input)).toBe(beforeInput);
    expect(snapshot(budget)).toBe(beforeBudget);
  });

  it("checks 的 used 与报表同源", () => {
    const input = fixture();
    const memUsed = categoryUsed(input, "memory");
    const out = evaluateBudget(input, { categories: { memory: { estimate: memUsed } } });
    expect(out.checks[0]!.used).toBe(out.report.byCategory.memory.tokensEstimate);
  });
});

describe("evaluateDelta 增量与字节断言", () => {
  it("缺基线 → NO_BASELINE", () => {
    const out = evaluateDelta(undefined, fixture());
    expect(out.code).toBe(PROMPT_BUDGET_CODES.NO_BASELINE);
    expect(out.verdict).toBe("no-baseline");
  });

  it("完全相同 → OK,delta 0", () => {
    const out = evaluateDelta(fixture(), fixture(), { maxDeltaTokens: 0 });
    expect(out.code).toBe("OK");
    expect(out.totalDelta).toBe(0);
    expect(out.checks.find((c) => c.kind === "bytes")!.ok).toBe(true);
  });

  it("增长等于 maxDeltaTokens 通过(边界)", () => {
    const base = fixture();
    const next = fixture();
    next.sections!.find((s) => s.id === "mem-1")!.text += "追加一句";
    const growth = buildFootprint(next).total.tokensEstimate - buildFootprint(base).total.tokensEstimate;
    const out = evaluateDelta(base, next, { allowChangedIds: ["mem-1"], maxDeltaTokens: growth });
    expect(growth).toBeGreaterThan(0);
    expect(out.verdict).toBe("ok");
  });

  it("增长超 maxDeltaTokens → DELTA_OVER 且点名 overBy", () => {
    const base = fixture();
    const next = fixture();
    next.sections!.find((s) => s.id === "mem-1")!.text += "追加一句更长的说明用于越界";
    const growth = buildFootprint(next).total.tokensEstimate - buildFootprint(base).total.tokensEstimate;
    const out = evaluateDelta(base, next, { allowChangedIds: ["mem-1"], maxDeltaTokens: growth - 1 });
    expect(out.code).toBe(PROMPT_BUDGET_CODES.DELTA_OVER);
    expect(out.breaches[0]!.overBy).toBe(1);
  });

  it("缩小不触发 breach", () => {
    const base = fixture();
    const next = fixture();
    next.sections!.find((s) => s.id === "mem-1")!.text = "短";
    const out = evaluateDelta(base, next, { allowChangedIds: ["mem-1"], maxDeltaTokens: 0 });
    expect(out.totalDelta).toBeLessThan(0);
    expect(out.verdict).toBe("ok");
  });

  it("增长比例超限 → DELTA_OVER(ratio check)", () => {
    const base = fixture();
    const next = fixture();
    next.sections!.find((s) => s.id === "mem-1")!.text += "追加一句用于拉高比例";
    const out = evaluateDelta(base, next, { allowChangedIds: ["mem-1"], maxDeltaRatio: 0.0001 });
    expect(out.verdict).toBe("over");
    expect(out.checks.some((c) => c.kind === "ratio" && !c.ok)).toBe(true);
  });

  it("增长比例在限内 → OK", () => {
    const base = fixture();
    const next = fixture();
    next.sections!.find((s) => s.id === "mem-1")!.text += "追加";
    const out = evaluateDelta(base, next, { allowChangedIds: ["mem-1"], maxDeltaRatio: 1 });
    expect(out.verdict).toBe("ok");
  });

  it("changedIds 之外改字节 → DELTA_OVER 并点名分块", () => {
    const base = fixture();
    const next = fixture();
    next.sections!.find((s) => s.id === "sys-core")!.text += "偷偷改";
    const out = evaluateDelta(base, next, { allowChangedIds: [], maxDeltaTokens: 1000 });
    expect(out.code).toBe(PROMPT_BUDGET_CODES.DELTA_OVER);
    expect(out.unrelated).toContain("sys-core");
    expect(out.breaches[0]!.message).toContain("sys-core");
  });

  it("changedIds 声明后同一处变化 → OK 并列出 changed", () => {
    const base = fixture();
    const next = fixture();
    next.sections!.find((s) => s.id === "sys-core")!.text += "允许改";
    const out = evaluateDelta(base, next, { allowChangedIds: ["sys-core"], maxDeltaTokens: 1000 });
    expect(out.verdict).toBe("ok");
    expect(out.changed).toEqual(["sys-core"]);
  });

  it("新增未声明分块不算字节越界,但计入增长", () => {
    const base = fixture();
    const next = fixture();
    next.sections!.push({ id: "extra", category: "context", text: "新增上下文" });
    const out = evaluateDelta(base, next, { maxDeltaTokens: 1000 });
    expect(out.verdict).toBe("ok");
    expect(out.added).toEqual(["extra"]);
    expect(out.totalDelta).toBeGreaterThan(0);
  });

  it("新增分块超增量上限 → DELTA_OVER", () => {
    const base = fixture();
    const next = fixture();
    next.sections!.push({ id: "extra", category: "context", text: "新增上下文" });
    const growth = buildFootprint(next).total.tokensEstimate - buildFootprint(base).total.tokensEstimate;
    const out = evaluateDelta(base, next, { maxDeltaTokens: growth - 1 });
    expect(out.code).toBe(PROMPT_BUDGET_CODES.DELTA_OVER);
  });

  it("每个类别给出 before→after→delta", () => {
    const base = fixture();
    const next = fixture();
    next.sections!.find((s) => s.id === "mem-1")!.text += "追加一句";
    const out = evaluateDelta(base, next, { allowChangedIds: ["mem-1"] });
    const memory = out.categories.find((c) => c.category === "memory")!;
    expect(memory.before).toBe(categoryUsed(base, "memory"));
    expect(memory.after).toBe(categoryUsed(next, "memory"));
    expect(memory.delta).toBe(memory.after - memory.before);
    expect(out.categories).toHaveLength(9);
  });

  it("基线为 0 而 next 有增长时比例视为无穷 → DELTA_OVER", () => {
    const empty: FootprintInput = { sections: [] };
    const out = evaluateDelta(empty, fixture(), { maxDeltaRatio: 1 });
    expect(out.verdict).toBe("over");
    expect(out.breaches[0]!.message).toContain("无穷");
  });

  it("负的 maxDeltaTokens → INVALID", () => {
    const out = evaluateDelta(fixture(), fixture(), { maxDeltaTokens: -1 });
    expect(out.code).toBe(PROMPT_BUDGET_CODES.INVALID);
  });

  it("基线坏 JSON → MANIFEST_INVALID", () => {
    const out = evaluateDelta("{bad", fixture());
    expect(out.code).toBe(PROMPT_BUDGET_CODES.MANIFEST_INVALID);
    expect(out.breaches[0]!.message).toContain("baseline");
  });

  it("next 坏 JSON → MANIFEST_INVALID", () => {
    const out = evaluateDelta(fixture(), "{bad");
    expect(out.code).toBe(PROMPT_BUDGET_CODES.MANIFEST_INVALID);
    expect(out.breaches[0]!.message).toContain("next");
  });

  it("确定性:同输入两次输出逐字一致", () => {
    const base = fixture();
    const next = fixture();
    next.sections!.find((s) => s.id === "mem-1")!.text += "追加";
    const opts = { allowChangedIds: ["mem-1"], maxDeltaTokens: 3 };
    expect(snapshot(evaluateDelta(base, next, opts))).toBe(snapshot(evaluateDelta(base, next, opts)));
  });

  it("不可变:两个 manifest 在调用后字节不变", () => {
    const base = fixture();
    const next = fixture();
    next.sections!.find((s) => s.id === "mem-1")!.text += "追加";
    const beforeBase = snapshot(base);
    const beforeNext = snapshot(next);
    evaluateDelta(base, next, { allowChangedIds: ["mem-1"] });
    expect(snapshot(base)).toBe(beforeBase);
    expect(snapshot(next)).toBe(beforeNext);
  });
});

describe("negativeReturnPrunes 负收益剪枝", () => {
  it("reject + tip 按 section.id 映射", () => {
    const out = negativeReturnPrunes(
      [{ experimentId: "e1", decision: "reject", intervention: { surface: "tip", ref: "mem-1" } }],
      fixture(),
    );
    expect(out.code).toBe("OK");
    expect(out.prunes).toHaveLength(1);
    expect(out.prunes[0]!.sections).toEqual(["mem-1"]);
    expect(out.prunes[0]!.surface).toBe("tip");
  });

  it("rollback + tool 按 tools[].name 映射到 tool:<name> 分块", () => {
    const out = negativeReturnPrunes(
      [{ experimentId: "e2", decision: "rollback", intervention: { surface: "tool", ref: "read_file" } }],
      fixture(),
    );
    expect(out.prunes).toHaveLength(1);
    expect(out.prunes[0]!.sections).toEqual(["tool:read_file"]);
  });

  it("skill 支持前缀 id(如 skill:coding/tdd)", () => {
    const out = negativeReturnPrunes(
      [{ experimentId: "e3", decision: "reject", intervention: { surface: "skill", ref: "coding/tdd" } }],
      fixture(),
    );
    expect(out.prunes[0]!.sections).toEqual(["skill:coding/tdd"]);
  });

  it("prompt 支持精确 id 命中", () => {
    const out = negativeReturnPrunes(
      [{ experimentId: "e4", decision: "reject", intervention: { surface: "prompt", ref: "prompt:review" } }],
      fixture(),
    );
    expect(out.prunes[0]!.sections).toEqual(["prompt:review"]);
  });

  it("adopt 不剪、也不进 unattributed", () => {
    const out = negativeReturnPrunes(
      [{ experimentId: "e5", decision: "adopt", intervention: { surface: "tip", ref: "mem-1" } }],
      fixture(),
    );
    expect(out.prunes).toEqual([]);
    expect(out.unattributed).toEqual([]);
  });

  it("iterate 不剪、也不进 unattributed", () => {
    const out = negativeReturnPrunes(
      [{ experimentId: "e6", decision: "iterate", intervention: { surface: "tip", ref: "mem-1" } }],
      fixture(),
    );
    expect(out.prunes).toEqual([]);
    expect(out.unattributed).toEqual([]);
  });

  it("ref 无匹配分块 → unattributed(no-matching-section)", () => {
    const out = negativeReturnPrunes(
      [{ experimentId: "e7", decision: "reject", intervention: { surface: "tip", ref: "不存在" } }],
      fixture(),
    );
    expect(out.prunes).toEqual([]);
    expect(out.unattributed).toHaveLength(1);
    expect(out.unattributed[0]!.reason).toContain("no-matching-section");
  });

  it("surface 不在 tip/tool/prompt/skill → unattributed", () => {
    const out = negativeReturnPrunes(
      [{ experimentId: "e8", decision: "reject", intervention: { surface: "toolset", ref: "core" } }],
      fixture(),
    );
    expect(out.unattributed[0]!.reason).toContain("unsupported-surface");
  });

  it("缺 ref → unattributed(missing-ref)", () => {
    const out = negativeReturnPrunes(
      [{ experimentId: "e9", decision: "rollback", intervention: { surface: "tip" } }],
      fixture(),
    );
    expect(out.unattributed[0]!.reason).toBe("missing-ref");
  });

  it("token 单位的 success 指标差值优先作为节省量", () => {
    const out = negativeReturnPrunes(
      [
        {
          experimentId: "e10",
          decision: "reject",
          intervention: { surface: "tip", ref: "mem-1" },
          metrics: [{ role: "success", unit: "tokens", baseline: 900, result: 640 }],
        },
      ],
      fixture(),
    );
    expect(out.prunes[0]!.savedFrom).toBe("metric");
    expect(out.prunes[0]!.estimatedTokensSaved).toBe(260);
  });

  it("success 嵌在 metric.success 里也能取到", () => {
    const out = negativeReturnPrunes(
      [
        {
          experimentId: "e11",
          decision: "reject",
          intervention: { surface: "tip", ref: "mem-1" },
          metrics: [{ role: "success", success: { baseline: 500, result: 400, unit: "tokensEstimate" } }],
        },
      ],
      fixture(),
    );
    expect(out.prunes[0]!.estimatedTokensSaved).toBe(100);
  });

  it("非 token 单位指标不算节省量,回落该分块 tokensEstimate", () => {
    const expected = buildFootprint(fixture()).entries.find((e) => e.id === "mem-1")!.tokensEstimate;
    const out = negativeReturnPrunes(
      [
        {
          experimentId: "e12",
          decision: "reject",
          intervention: { surface: "tip", ref: "mem-1" },
          metrics: [{ role: "success", unit: "%", baseline: 0.9, result: 0.8 }],
        },
      ],
      fixture(),
    );
    expect(out.prunes[0]!.savedFrom).toBe("estimator");
    expect(out.prunes[0]!.estimatedTokensSaved).toBe(expected);
  });

  it("无指标时用该分块当前 tokensEstimate", () => {
    const expected = buildFootprint(fixture()).entries.find((e) => e.id === "sys-core")!.tokensEstimate;
    const out = negativeReturnPrunes(
      [{ experimentId: "e13", decision: "rollback", intervention: { surface: "tip", ref: "sys-core" } }],
      fixture(),
    );
    expect(out.prunes[0]!.estimatedTokensSaved).toBe(expected);
  });

  it("支持 {experiments:[...]} 包装形状", () => {
    const out = negativeReturnPrunes(
      { experiments: [{ experimentId: "e14", decision: "reject", intervention: { surface: "tip", ref: "mem-1" } }] },
      fixture(),
    );
    expect(out.prunes).toHaveLength(1);
  });

  it("账本不是数组也不是包装对象 → INVALID", () => {
    const out = negativeReturnPrunes("nope", fixture());
    expect(out.code).toBe(PROMPT_BUDGET_CODES.INVALID);
    expect(out.prunes).toEqual([]);
  });

  it("空账本 → OK 且两列表都空", () => {
    const out = negativeReturnPrunes([], fixture());
    expect(out.code).toBe("OK");
    expect(out.prunes).toEqual([]);
    expect(out.unattributed).toEqual([]);
  });

  it("manifest 坏 → MANIFEST_INVALID", () => {
    const out = negativeReturnPrunes([], null);
    expect(out.code).toBe(PROMPT_BUDGET_CODES.MANIFEST_INVALID);
  });

  it("多条结果排序稳定(experimentId → surface → ref)", () => {
    const out = negativeReturnPrunes(
      [
        { experimentId: "b", decision: "reject", intervention: { surface: "tip", ref: "mem-1" } },
        { experimentId: "a", decision: "reject", intervention: { surface: "tool", ref: "read_file" } },
        { experimentId: "a", decision: "rollback", intervention: { surface: "prompt", ref: "prompt:review" } },
      ],
      fixture(),
    );
    expect(out.prunes.map((p) => `${p.experimentId}/${p.surface}/${p.ref}`)).toEqual([
      "a/prompt/prompt:review",
      "a/tool/read_file",
      "b/tip/mem-1",
    ]);
  });

  it("确定性:同输入两次输出逐字一致", () => {
    const ledger = [
      { experimentId: "e15", decision: "reject", intervention: { surface: "tip", ref: "mem-1" } },
      { experimentId: "e16", decision: "reject", intervention: { surface: "tip", ref: "missing" } },
    ];
    expect(snapshot(negativeReturnPrunes(ledger, fixture()))).toBe(snapshot(negativeReturnPrunes(ledger, fixture())));
  });

  it("不可变:账本与 manifest 在调用后字节不变", () => {
    const ledger = [
      { experimentId: "e17", decision: "reject", intervention: { surface: "tip", ref: "mem-1" } },
    ];
    const input = fixture();
    const beforeLedger = snapshot(ledger);
    const beforeInput = snapshot(input);
    negativeReturnPrunes(ledger, input);
    expect(snapshot(ledger)).toBe(beforeLedger);
    expect(snapshot(input)).toBe(beforeInput);
  });

  it("混合账本:3 条负收益可剪 + 1 条 adopt 不列", () => {
    const out = negativeReturnPrunes(
      [
        { experimentId: "r1", decision: "reject", intervention: { surface: "tip", ref: "mem-1" } },
        { experimentId: "r2", decision: "rollback", intervention: { surface: "tool", ref: "read_file" } },
        { experimentId: "r3", decision: "reject", intervention: { surface: "skill", ref: "coding/tdd" } },
        { experimentId: "r4", decision: "adopt", intervention: { surface: "tip", ref: "sys-core" } },
      ],
      fixture(),
    );
    expect(out.prunes).toHaveLength(3);
    expect(out.prunes.map((p) => p.experimentId)).toEqual(["r1", "r2", "r3"]);
    expect(out.unattributed).toEqual([]);
  });
});

describe("组合与报表一致性", () => {
  it("报表总量等于各类别之和(estimate)", () => {
    const report = buildFootprint(fixture());
    const sum = (Object.values(report.byCategory) as Array<{ tokensEstimate: number }>).reduce(
      (acc, stat) => acc + stat.tokensEstimate,
      0);
    expect(report.total.tokensEstimate).toBe(sum);
  });

  it("预算评估直接复用既有报表口径(不重写分词)", () => {
    const out = evaluateBudget(fixture(), undefined);
    const report = buildFootprint(fixture());
    expect(out.report.total).toEqual(report.total);
    expect(out.report.entries).toHaveLength(report.entries.length);
  });

  it("剪枝节省量与 estimator 列同源(tokensEstimate)", () => {
    const entry = buildFootprint(fixture()).entries.find((e) => e.id === "tool:grep")!;
    const out = negativeReturnPrunes(
      [{ experimentId: "e18", decision: "rollback", intervention: { surface: "tool", ref: "grep" } }],
      fixture(),
    );
    expect(out.prunes[0]!.estimatedTokensSaved).toBe(entry.tokensEstimate);
  });

  it("预算与剪枝共用同一份 manifest 时互不改写", () => {
    const input = fixture();
    const before = snapshot(input);
    evaluateBudget(input, { totalTokens: { estimate: 1 } });
    negativeReturnPrunes(
      [{ experimentId: "e19", decision: "reject", intervention: { surface: "tip", ref: "mem-1" } }],
      input);
    expect(snapshot(input)).toBe(before);
  });
});
