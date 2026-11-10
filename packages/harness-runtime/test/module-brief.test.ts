/**
 * 模块简报(module-brief):五章顺序、稳定码、契约摘要、截断与预算、入口形状过滤、
 * 深挖指路。全纯函数直测,不触 IO。
 */
import { describe, expect, it } from "vitest";
import {
  BRIEF_BUILT,
  BRIEF_CONTRACT_MISSING,
  BRIEF_DEP_CONTRACT_MISSING,
  BRIEF_INVALID,
  BRIEF_LAYER_MISSING,
  BRIEF_OWNER_MISSING,
  BRIEF_TOO_LARGE,
  BRIEF_TRUNCATED,
  BRIEF_UNMANAGED,
  MODULE_BRIEF_VERSION,
  assertEntryShape,
  buildBrief,
  expandHint,
  renderBrief,
  summarizeContract,
} from "../src/agent/module-brief";
import type { BriefInput, DepRef, ModuleBrief } from "../src/agent/module-brief";

const SECTION_1 = "① 身份";
const SECTION_2 = "② 契约";
const SECTION_3 = "③ 直接依赖";
const SECTION_4 = "④ 入口";
const SECTION_5 = "⑤ 允许边";

const ENTRY_FILE = "apps/gateway/src/arch-policy.ts";

/** 基线输入:五章全齐、契约就绪、单个依赖、单条入口、一条允许边。 */
function baseInput(): BriefInput {
  return {
    identity: {
      name: "arch-policy",
      path: ENTRY_FILE,
      packageName: "@lampgenie/gateway",
      description: "架构策略装载与裁决",
      owner: "platform",
      layer: "app",
      managed: true,
    },
    contract: { present: true, path: "docs/arch-policy.md", summary: "装载策略并按模块裁决允许边" },
    deps: [{ name: "@lampgenie/core", path: "packages/harness-core", contractPresent: true }],
    entries: [{ file: ENTRY_FILE, line: 12, symbol: "loadArchPolicy", kind: "function" }],
    allowedEdges: [{ from: "arch-policy", to: "core", reason: "只读类型" }],
  };
}

/** 按码取是否存在(逐项断言,便于报错定位)。 */
function has(result: { codes: string[] }, code: string): boolean {
  return result.codes.includes(code);
}

describe("module-brief 常量与版本", () => {
  it("版本常量为 1", () => {
    expect(MODULE_BRIEF_VERSION).toBe(1);
  });

  it("稳定码的值等于其同名标识", () => {
    const codes = [
      BRIEF_INVALID,
      BRIEF_BUILT,
      BRIEF_CONTRACT_MISSING,
      BRIEF_OWNER_MISSING,
      BRIEF_LAYER_MISSING,
      BRIEF_UNMANAGED,
      BRIEF_DEP_CONTRACT_MISSING,
      BRIEF_TRUNCATED,
      BRIEF_TOO_LARGE,
    ];
    for (const code of codes) expect(code).toBe(code.trim());
    expect(codes).toEqual([
      "BRIEF_INVALID",
      "BRIEF_BUILT",
      "BRIEF_CONTRACT_MISSING",
      "BRIEF_OWNER_MISSING",
      "BRIEF_LAYER_MISSING",
      "BRIEF_UNMANAGED",
      "BRIEF_DEP_CONTRACT_MISSING",
      "BRIEF_TRUNCATED",
      "BRIEF_TOO_LARGE",
    ]);
  });
});

describe("buildBrief 五章结构", () => {
  it("成功总带 BRIEF_BUILT", () => {
    const { codes } = buildBrief(baseInput());
    expect(codes).toContain(BRIEF_BUILT);
  });

  it("章节顺序固定 ①<②<③<④<⑤", () => {
    const { brief } = buildBrief(baseInput());
    const text = brief.rendered;
    const positions = [SECTION_1, SECTION_2, SECTION_3, SECTION_4, SECTION_5].map((s) => text.indexOf(s));
    for (const pos of positions) expect(pos).toBeGreaterThanOrEqual(0);
    expect(positions[0]).toBeLessThan(positions[1] as number);
    expect(positions[1]).toBeLessThan(positions[2] as number);
    expect(positions[2]).toBeLessThan(positions[3] as number);
    expect(positions[3]).toBeLessThan(positions[4] as number);
  });

  it("rendered 是 markdown(标题 + 列表)", () => {
    const { brief } = buildBrief(baseInput());
    expect(brief.rendered.startsWith("# 模块简报:arch-policy")).toBe(true);
    expect(brief.rendered).toContain("\n## ");
    expect(brief.rendered.split("\n").some((line) => line.startsWith("- "))).toBe(true);
  });

  it("chars === rendered.length", () => {
    const { brief } = buildBrief(baseInput());
    expect(brief.chars).toBe(brief.rendered.length);
  });

  it("身份章渲染 name/path/owner/layer/managed", () => {
    const { brief } = buildBrief(baseInput());
    expect(brief.rendered).toContain("- name: arch-policy");
    expect(brief.rendered).toContain(`- path: ${ENTRY_FILE}`);
    expect(brief.rendered).toContain("- owner: platform");
    expect(brief.rendered).toContain("- layer: app");
    expect(brief.rendered).toContain("- managed: true");
  });
});

describe("buildBrief 码规则", () => {
  it("契约缺失:码 + rendered 明示缺失", () => {
    const input = baseInput();
    delete input.contract;
    const { brief, codes } = buildBrief(input);
    expect(codes).toContain(BRIEF_CONTRACT_MISSING);
    expect(brief.contract.present).toBe(false);
    expect(brief.rendered).toContain("缺失");
    expect(brief.missing.join("\n")).toContain("契约缺失");
  });

  it("只给契约 text 时自动生成 summary 并视为存在", () => {
    const input = baseInput();
    input.contract = { text: "# 契约\n\n本模块只读策略文件,按分层裁决允许边。" };
    const { brief, codes } = buildBrief(input);
    expect(brief.contract.present).toBe(true);
    expect(brief.contract.summary).toBe("本模块只读策略文件,按分层裁决允许边。");
    expect(codes).not.toContain(BRIEF_CONTRACT_MISSING);
    expect(brief.rendered).toContain("本模块只读策略文件");
  });

  it("契约 text 只有标题时仍判缺失", () => {
    const input = baseInput();
    input.contract = { text: "# 契约\n\n## 细节" };
    const { brief, codes } = buildBrief(input);
    expect(brief.contract.present).toBe(false);
    expect(codes).toContain(BRIEF_CONTRACT_MISSING);
  });

  it("contract.present=false 但 text 有内容 → 生成 summary", () => {
    const input = baseInput();
    input.contract = { present: false, text: "允许边来自策略文件。" };
    const { brief } = buildBrief(input);
    expect(brief.contract.present).toBe(true);
    expect(brief.contract.summary).toBe("允许边来自策略文件。");
  });

  it("owner 缺失:码 + rendered 明示", () => {
    const input = baseInput();
    delete input.identity.owner;
    const { brief, codes } = buildBrief(input);
    expect(codes).toContain(BRIEF_OWNER_MISSING);
    expect(brief.rendered).toContain("- owner: 缺失");
  });

  it("layer 缺失:码 + rendered 明示", () => {
    const input = baseInput();
    delete input.identity.layer;
    const { brief, codes } = buildBrief(input);
    expect(codes).toContain(BRIEF_LAYER_MISSING);
    expect(brief.rendered).toContain("- layer: 缺失");
  });

  it("managed=false → BRIEF_UNMANAGED", () => {
    const input = baseInput();
    input.identity.managed = false;
    const { brief, codes } = buildBrief(input);
    expect(codes).toContain(BRIEF_UNMANAGED);
    expect(brief.identity.managed).toBe(false);
    expect(brief.rendered).toContain("- managed: false");
  });

  it("managed 缺省视为 false → BRIEF_UNMANAGED", () => {
    const input = baseInput();
    delete input.identity.managed;
    const { brief, codes } = buildBrief(input);
    expect(brief.identity.managed).toBe(false);
    expect(codes).toContain(BRIEF_UNMANAGED);
  });

  it("依赖契约缺失:码出现一次 + 每个缺失 dep 一条 missing 文本", () => {
    const input = baseInput();
    input.deps = [
      { name: "dep-a", path: "packages/a", contractPresent: false },
      { name: "dep-b", path: "packages/b", contractPresent: false },
      { name: "dep-c", path: "packages/c", contractPresent: true },
    ];
    const { brief, codes } = buildBrief(input);
    expect(codes.filter((code) => code === BRIEF_DEP_CONTRACT_MISSING)).toHaveLength(1);
    expect(brief.missing).toContain("依赖契约缺失: dep-a");
    expect(brief.missing).toContain("依赖契约缺失: dep-b");
    expect(brief.missing).not.toContain("依赖契约缺失: dep-c");
    expect(brief.rendered).toContain("dep-a @ packages/a — 契约:缺失");
    expect(brief.rendered).toContain("dep-c @ packages/c — 契约:已就绪");
  });
});

describe("buildBrief 入口", () => {
  it("入口行只含 symbol 与 file:line", () => {
    const input = baseInput();
    input.entries = [
      { file: ENTRY_FILE, line: 42, symbol: "resolvePolicy", kind: "function" },
      { file: "apps/gateway/src/other.ts", line: 7, symbol: "POLICY_CACHE", kind: "const" },
    ];
    const { brief } = buildBrief(input);
    expect(brief.rendered).toContain(`- resolvePolicy — ${ENTRY_FILE}:42`);
    expect(brief.rendered).toContain("- POLICY_CACHE — apps/gateway/src/other.ts:7");
    expect(brief.rendered).not.toContain("return");
    expect(brief.rendered).not.toContain("=>");
  });

  it("入口为空时明示「无公开入口或未解析」", () => {
    const input = baseInput();
    input.entries = [];
    const { brief } = buildBrief(input);
    expect(brief.rendered).toContain("无公开入口或未解析");
    expect(brief.entries).toHaveLength(0);
  });

  it("非法入口被过滤并计入 missing", () => {
    const input = baseInput();
    input.entries = [
      { file: ENTRY_FILE, line: 12, symbol: "keepMe", kind: "function" },
      { file: "", line: 12, symbol: "badFile" },
      { file: ENTRY_FILE, line: 0, symbol: "badLine" },
      { file: ENTRY_FILE, line: 3.5, symbol: "fractionLine" },
      { file: ENTRY_FILE, line: 9, symbol: "" },
    ];
    const { brief } = buildBrief(input);
    expect(brief.entries.map((entry) => entry.symbol)).toEqual(["keepMe"]);
    expect(brief.missing).toContain("入口形状非法:badFile");
    expect(brief.missing).toContain("入口形状非法:badLine");
    expect(brief.missing).toContain("入口形状非法:fractionLine");
    expect(brief.missing.join("\n")).toContain("入口形状非法:");
  });

  it("非法入口不抛异常", () => {
    const input = baseInput();
    input.entries = [null as never, 42 as never, { symbol: "onlySymbol" }];
    expect(() => buildBrief(input)).not.toThrow();
    const { brief } = buildBrief(input);
    expect(brief.entries).toHaveLength(0);
    expect(brief.missing).toContain("入口形状非法:onlySymbol");
  });

  it("入口 kind 非法时归一化为 export", () => {
    const input = baseInput();
    input.entries = [{ file: ENTRY_FILE, line: 5, symbol: "mystery", kind: "weird" as never }];
    const { brief } = buildBrief(input);
    expect(brief.entries[0]?.kind).toBe("export");
  });
});

describe("buildBrief 允许边", () => {
  it("允许边渲染 from→to 与 reason", () => {
    const { brief } = buildBrief(baseInput());
    expect(brief.rendered).toContain("- arch-policy → core (只读类型)");
  });

  it("允许边为空时明示无", () => {
    const input = baseInput();
    input.allowedEdges = [];
    const { brief } = buildBrief(input);
    expect(brief.allowedEdges).toHaveLength(0);
    expect(brief.rendered).toContain(`${SECTION_5}\n- 无`);
  });

  it("非法允许边被丢弃", () => {
    const input = baseInput();
    input.allowedEdges = [
      { from: "a", to: "b" },
      { from: "", to: "c" },
      { from: "d", to: "" },
    ];
    const { brief } = buildBrief(input);
    expect(brief.allowedEdges).toEqual([{ from: "a", to: "b" }]);
  });
});

describe("buildBrief 截断与预算", () => {
  it("deps 超 maxDeps 截断并记 BRIEF_TRUNCATED", () => {
    const input = baseInput();
    input.deps = Array.from({ length: 5 }, (_, index) => ({
      name: `dep-${index}`,
      path: `packages/dep-${index}`,
      contractPresent: true,
    }));
    const { brief, codes } = buildBrief(input, { maxDeps: 2 });
    expect(brief.deps).toHaveLength(2);
    expect(codes).toContain(BRIEF_TRUNCATED);
    expect(brief.rendered).toContain("…已截断 3 个依赖(契约状态未知)");
  });

  it("deps 截断保留前 N 条", () => {
    const input = baseInput();
    input.deps = Array.from({ length: 4 }, (_, index) => ({ name: `dep-${index}`, contractPresent: true }));
    const { brief } = buildBrief(input, { maxDeps: 2 });
    expect(brief.deps.map((dep) => dep.name)).toEqual(["dep-0", "dep-1"]);
  });

  it("被截依赖的契约缺失事实保留进 missing", () => {
    const input = baseInput();
    input.deps = [
      { name: "ok-dep", contractPresent: true },
      { name: "broken-dep", contractPresent: false },
    ];
    const { brief } = buildBrief(input, { maxDeps: 1 });
    expect(brief.deps).toHaveLength(1);
    expect(brief.missing.join("\n")).toContain("依赖契约缺失: broken-dep(已截断,契约状态未知)");
  });

  it("entries 超 maxEntries 截断并记 BRIEF_TRUNCATED", () => {
    const input = baseInput();
    input.entries = Array.from({ length: 6 }, (_, index) => ({
      file: ENTRY_FILE,
      line: index + 1,
      symbol: `entry${index}`,
      kind: "export" as const,
    }));
    const { brief, codes } = buildBrief(input, { maxEntries: 3 });
    expect(brief.entries.map((entry) => entry.symbol)).toEqual(["entry0", "entry1", "entry2"]);
    expect(codes).toContain(BRIEF_TRUNCATED);
    expect(brief.rendered).toContain("…已截断 3 个入口");
  });

  it("默认 maxDeps=8 / maxEntries=12", () => {
    const input = baseInput();
    input.deps = Array.from({ length: 10 }, (_, index) => ({ name: `dep-${index}`, contractPresent: true }));
    input.entries = Array.from({ length: 15 }, (_, index) => ({
      file: ENTRY_FILE,
      line: index + 1,
      symbol: `entry${index}`,
      kind: "export" as const,
    }));
    const { brief, codes } = buildBrief(input);
    expect(brief.deps).toHaveLength(8);
    expect(brief.entries).toHaveLength(12);
    expect(codes).toContain(BRIEF_TRUNCATED);
  });

  it("超 maxChars 时先截依赖尾部,入口保持完整", () => {
    const input = baseInput();
    input.deps = Array.from({ length: 6 }, (_, index) => ({
      name: `dependency-number-${index}`,
      path: `packages/dependency-number-${index}`,
      contractPresent: true,
    }));
    input.entries = [
      { file: ENTRY_FILE, line: 12, symbol: "loadArchPolicy", kind: "function" },
      { file: ENTRY_FILE, line: 30, symbol: "resolvePolicy", kind: "function" },
    ];
    const { brief, codes } = buildBrief(input, { maxChars: 760 });
    expect(brief.entries).toHaveLength(2);
    expect(brief.deps.length).toBeLessThan(6);
    expect(brief.chars).toBeLessThanOrEqual(760);
    expect(codes).toContain(BRIEF_TRUNCATED);
  });

  it("预算极紧时仍超 → BRIEF_TOO_LARGE 且 rendered 末尾标注", () => {
    const { brief, codes } = buildBrief(baseInput(), { maxChars: 40 });
    expect(codes).toContain(BRIEF_TOO_LARGE);
    expect(brief.rendered).toContain("已超预算 maxChars=40");
    expect(brief.rendered).toContain(SECTION_1);
    expect(brief.chars).toBe(brief.rendered.length);
  });

  it("截断后 deps/entries 全空也不抛", () => {
    const input = baseInput();
    input.deps = [{ name: "only-dep", contractPresent: true }];
    input.entries = [{ file: ENTRY_FILE, line: 1, symbol: "only", kind: "export" }];
    const { brief } = buildBrief(input, { maxChars: 120, maxDeps: 0, maxEntries: 0 });
    expect(brief.deps).toHaveLength(0);
    expect(brief.entries).toHaveLength(0);
    expect(brief.rendered).toContain("无直接依赖");
    expect(brief.rendered).toContain("无公开入口或未解析");
  });
});

describe("buildBrief 非法输入", () => {
  it("null 输入 → [BRIEF_INVALID] 且不抛", () => {
    let result: { codes: string[]; brief: ModuleBrief } | undefined;
    expect(() => {
      result = buildBrief(null);
    }).not.toThrow();
    expect(result?.codes).toEqual([BRIEF_INVALID]);
    expect(result?.brief.deps).toHaveLength(0);
    expect(result?.brief.entries).toHaveLength(0);
    expect(result?.brief.chars).toBe(result?.brief.rendered.length);
  });

  it("identity 缺 path → [BRIEF_INVALID]", () => {
    const { codes, brief } = buildBrief({ identity: { name: "x" } });
    expect(codes).toEqual([BRIEF_INVALID]);
    expect(brief.identity.managed).toBe(false);
  });

  it("identity 缺 name → [BRIEF_INVALID]", () => {
    const { codes, brief } = buildBrief({ identity: { path: "a/b.ts" } });
    expect(codes).toEqual([BRIEF_INVALID]);
    expect(brief.deps).toEqual([]);
  });

  it("identity 为空串 / 非对象时 → [BRIEF_INVALID]", () => {
    expect(buildBrief({ identity: { name: "", path: "" } }).codes).toEqual([BRIEF_INVALID]);
    expect(buildBrief("not-an-object").codes).toEqual([BRIEF_INVALID]);
    expect(buildBrief({ identity: [] }).codes).toEqual([BRIEF_INVALID]);
  });
});

describe("summarizeContract", () => {
  it("空串 / 纯空白 → undefined", () => {
    expect(summarizeContract("")).toBeUndefined();
    expect(summarizeContract("   \n\t\n")).toBeUndefined();
  });

  it("非字符串 → undefined", () => {
    expect(summarizeContract(undefined)).toBeUndefined();
    expect(summarizeContract(null)).toBeUndefined();
    expect(summarizeContract(42)).toBeUndefined();
  });

  it("纯标题 → undefined", () => {
    expect(summarizeContract("# 只有标题\n## 还是标题\n")).toBeUndefined();
  });

  it("只有 HTML 注释 → undefined", () => {
    expect(summarizeContract("<!-- 占位 -->\n<!-- 另一个 -->")).toBeUndefined();
  });

  it("跳过标题与注释后取首个段落", () => {
    const text = "<!-- 前言 -->\n# 契约\n\n本模块只读策略文件,\n并按分层裁决允许边。\n\n## 细节\n后续内容。";
    expect(summarizeContract(text)).toBe("本模块只读策略文件, 并按分层裁决允许边。");
  });

  it("超 160 字截断并加省略号", () => {
    const long = "甲".repeat(200);
    const summary = summarizeContract(long);
    expect(summary).toBeDefined();
    expect(summary?.length).toBe(161);
    expect(summary?.endsWith("…")).toBe(true);
  });

  it("恰好 160 字不加省略号", () => {
    const exact = "乙".repeat(160);
    expect(summarizeContract(exact)).toBe(exact);
  });
});

describe("assertEntryShape", () => {
  it("合法入口返回 true", () => {
    expect(assertEntryShape({ file: ENTRY_FILE, line: 1, symbol: "a", kind: "function" })).toBe(true);
    expect(assertEntryShape({ file: "x.ts", line: 999999, symbol: "b" })).toBe(true);
  });

  it("非法入口返回 false 且不抛", () => {
    const bads: unknown[] = [
      undefined,
      null,
      "string",
      42,
      [],
      {},
      { file: "", line: 1, symbol: "a" },
      { file: "a.ts", line: 0, symbol: "a" },
      { file: "a.ts", line: -3, symbol: "a" },
      { file: "a.ts", line: 1.5, symbol: "a" },
      { file: "a.ts", line: "1", symbol: "a" },
      { file: "a.ts", line: 1, symbol: "" },
      { file: "a.ts", line: 1, symbol: 7 },
    ];
    for (const bad of bads) {
      expect(() => assertEntryShape(bad)).not.toThrow();
      expect(assertEntryShape(bad)).toBe(false);
    }
  });
});

describe("expandHint", () => {
  const deps: DepRef[] = [
    { name: "@lampgenie/core", path: "packages/harness-core", contractPresent: true },
    { name: "orphan-dep", contractPresent: false },
  ];

  it("已知 dep 且有 path 时用 path", () => {
    const { brief } = buildBrief(baseInput());
    expect(expandHint(brief, "@lampgenie/core")).toBe(
      "如需更深:module-brief --module packages/harness-core",
    );
  });

  it("未知 dep 用原名原文", () => {
    const { brief } = buildBrief({ identity: { name: "m", path: "m.ts" }, deps });
    expect(expandHint(brief, "unknown-dep")).toBe("如需更深:module-brief --module unknown-dep");
  });

  it("已知 dep 但无 path 时用 dep 名", () => {
    const { brief } = buildBrief({ identity: { name: "m", path: "m.ts" }, deps });
    expect(expandHint(brief, "orphan-dep")).toBe("如需更深:module-brief --module orphan-dep");
  });
});

describe("renderBrief 与确定性", () => {
  it("renderBrief(brief) 与 buildBrief 的 rendered 一致", () => {
    const { brief } = buildBrief(baseInput());
    expect(renderBrief(brief)).toBe(brief.rendered);
  });

  it("多次调用 renderBrief 结果完全相等", () => {
    const { brief } = buildBrief(baseInput());
    expect(renderBrief(brief)).toBe(renderBrief(brief));
  });

  it("同一输入多次 buildBrief 结果完全相等(无时间戳/随机)", () => {
    const first = buildBrief(baseInput());
    const second = buildBrief(baseInput());
    expect(second.brief.rendered).toBe(first.brief.rendered);
    expect(second.brief.chars).toBe(first.brief.chars);
    expect(second.codes).toEqual(first.codes);
  });

  it("非法输入的 brief 也能被 renderBrief 渲染", () => {
    const { brief } = buildBrief(undefined);
    expect(renderBrief(brief)).toBe(brief.rendered);
    expect(brief.rendered).toContain(SECTION_1);
  });
});
