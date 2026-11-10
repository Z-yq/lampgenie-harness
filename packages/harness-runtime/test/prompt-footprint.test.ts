import { describe, expect, it } from "vitest";
import {
  SECTION_CATEGORIES,
  SKILL_DESCRIPTION_MAX,
  buildFootprint,
  clampSkillDescription,
  diffFootprint,
  normalizeCategory,
  parseFootprintManifest,
} from "../src/agent/prompt-footprint";
import { composeSystemPrompt, skillDescriptionTruncations } from "../src/agent/system-composer";

const CJK = "常驻提示词分块归因:每次改动都要看得见它占到多少 token,不能靠猜。";

describe("M130 clampSkillDescription", () => {
  it("clamp 边界:59/60 不截断,61 截断并加可见省略号", () => {
    const d59 = "a".repeat(59);
    const d60 = "a".repeat(60);
    const d61 = "a".repeat(61);
    const r59 = clampSkillDescription(d59);
    const r60 = clampSkillDescription(d60);
    const r61 = clampSkillDescription(d61);
    expect(r59.truncated).toBe(false);
    expect(r59.text).toBe(d59);
    expect(r60.truncated).toBe(false);
    expect(r60.text).toBe(d60);
    expect(r61.truncated).toBe(true);
    expect(r61.text).toBe(`${"a".repeat(60)}…`);
    expect(r61.originalLength).toBe(61);
    expect(r61.max).toBe(SKILL_DESCRIPTION_MAX);
  });

  it("clamp CJK 与 emoji:按码点截取,不切出孤立代理对", () => {
    const cjk = clampSkillDescription("中".repeat(61));
    expect(cjk.truncated).toBe(true);
    expect(cjk.text).toBe(`${"中".repeat(60)}…`);

    const emoji = clampSkillDescription("😀".repeat(30), 20);
    expect(emoji.truncated).toBe(true);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(loneSurrogate.test(emoji.text)).toBe(false);
    expect([...emoji.text].slice(0, 20).join("")).toBe("😀".repeat(20));
    expect(emoji.text.endsWith("…")).toBe(true);
  });

  it("clamp max 越界钳制到 20..200,非有限数回落 60", () => {
    expect(clampSkillDescription("x".repeat(10), 5).max).toBe(20);
    expect(clampSkillDescription("x".repeat(10), 999).max).toBe(200);
    expect(clampSkillDescription("x".repeat(10), Number.NaN).max).toBe(60);
    const short = clampSkillDescription("x".repeat(10), 5);
    // 10 < 20 → 不截断
    expect(short.truncated).toBe(false);
    expect(short.text).toBe("x".repeat(10));
  });
});

describe("M130 buildFootprint", () => {
  it("footprint 分类/汇总/share/top", () => {
    const report = buildFootprint({
      sections: [
        { id: "identity", category: "stable", text: "你是管家,直接了当。" },
        { id: "agents", category: "context", text: CJK },
        { id: "notes", category: "volatile", text: "当前时间 12:00" },
        { id: "skills", category: "skills_index", text: "- coding/x: 说明" },
        { id: "mem", category: "memory", text: "用户叫小飞" },
        { id: "profile", category: "user_profile", text: "软件开发者" },
        { id: "weird", category: "totally-unknown", text: "未知类别" },
      ],
      tools: [{ name: "read_file", description: "读文件", parameters: { type: "object", properties: {} } }],
      toolset: [{ name: "core", hint: "基础工具集" }],
    });

    expect(report.entries).toHaveLength(9);
    expect(report.byCategory.other.chars).toBe("未知类别".length);
    expect(report.byCategory.tool_schema.chars).toBeGreaterThan(0);
    expect(report.byCategory.toolset.chars).toBeGreaterThan(0);

    // 汇总 = 逐块之和
    const sum = report.entries.reduce(
      (acc, e) => ({ chars: acc.chars + e.chars, raw: acc.raw + e.tokensRaw, est: acc.est + e.tokensEstimate }),
      { chars: 0, raw: 0, est: 0 },
    );
    expect(report.total.chars).toBe(sum.chars);
    expect(report.total.tokensRaw).toBe(sum.raw);
    expect(report.total.tokensEstimate).toBe(sum.est);

    // 每个类别统计 = 该类别逐块之和
    for (const cat of SECTION_CATEGORIES) {
      const inCat = report.entries.filter((e) => e.category === cat);
      expect(report.byCategory[cat].chars).toBe(inCat.reduce((n, e) => n + e.chars, 0));
      expect(report.byCategory[cat].tokensEstimate).toBe(inCat.reduce((n, e) => n + e.tokensEstimate, 0));
    }

    // share 之和 ≈ 1
    const shareSum = SECTION_CATEGORIES.reduce((n, cat) => n + report.byCategory[cat].share, 0);
    expect(Math.abs(shareSum - 1)).toBeLessThanOrEqual(1e-6);

    // top ≤5 且按 tokensEstimate 降序
    expect(report.top.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < report.top.length; i += 1) {
      expect(report.top[i - 1]!.tokensEstimate).toBeGreaterThanOrEqual(report.top[i]!.tokensEstimate);
    }
    expect(report.top[0]!.id).toBe("agents");
  });

  it("no tools:只给 sections 时 tool_schema/toolset 为零且 share 仍 ≈1", () => {
    const report = buildFootprint({ sections: [{ id: "identity", category: "stable", text: CJK }] });
    expect(report.byCategory.tool_schema.chars).toBe(0);
    expect(report.byCategory.tool_schema.share).toBe(0);
    expect(report.byCategory.toolset.tokensEstimate).toBe(0);
    expect(report.byCategory.stable.share).toBeCloseTo(1, 6);
  });

  it("CJK 双 tokenizer 两列都有值且都不等于 chars/4", () => {
    const report = buildFootprint({ sections: [{ id: "agents", category: "context", text: CJK }] });
    const e = report.entries[0]!;
    expect(e.chars).toBe(CJK.length);
    expect(e.tokensRaw).toBeGreaterThan(0);
    expect(e.tokensEstimate).toBeGreaterThan(0);
    expect(e.tokensRaw).not.toBe(CJK.length / 4);
    expect(e.tokensRaw).not.toBe(Math.floor(CJK.length / 4));
    expect(e.tokensEstimate).not.toBe(CJK.length / 4);
    expect(e.tokensEstimate).not.toBe(Math.floor(CJK.length / 4));
    // 两列独立记账,不合成一个数
    expect(Object.keys(e).sort()).toEqual(["category", "chars", "id", "tokensEstimate", "tokensRaw"]);
  });

  it("空输入:total 全 0,share 全 0,top 为空", () => {
    const report = buildFootprint({});
    expect(report.total).toEqual({ chars: 0, tokensRaw: 0, tokensEstimate: 0 });
    expect(report.top).toEqual([]);
    for (const cat of SECTION_CATEGORIES) expect(report.byCategory[cat].share).toBe(0);
  });
});

describe("M130 diffFootprint 字节断言", () => {
  const base = {
    sections: [
      { id: "identity", category: "stable", text: "你是管家。" },
      { id: "agents", category: "context", text: "项目指令 A" },
    ],
  };

  it("diff declared:只改 declared id → ok,增量逐块给出", () => {
    const next = {
      sections: [
        { id: "identity", category: "stable", text: "你是管家。" },
        { id: "agents", category: "context", text: "项目指令 ABCDEF" },
      ],
    };
    const d = diffFootprint(base, next, { changedIds: ["agents"] });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.code).toBe("OK");
    expect(d.changed.map((c) => c.id)).toEqual(["agents"]);
    expect(d.changed[0]!.charsDelta).toBe(5);
    expect(d.changed[0]!.tokensRawDelta).toBeGreaterThan(0);
    expect(d.total.charsDelta).toBe(5);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("diff undeclared:改了未声明 id → PROMPT_UNRELATED_BYTES_CHANGED 并列出 id", () => {
    const next = {
      sections: [
        { id: "identity", category: "stable", text: "你是管家。" },
        { id: "agents", category: "context", text: "项目指令 B" },
      ],
    };
    const d = diffFootprint(base, next, { changedIds: ["identity"] });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("PROMPT_UNRELATED_BYTES_CHANGED");
    expect(d.ids).toEqual(["agents"]);
  });

  it("diff same bytes:声明了但没变 → changed 为空且 ok", () => {
    const d = diffFootprint(base, base, { changedIds: ["agents"] });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.changed).toEqual([]);
    expect(d.total).toEqual({ charsDelta: 0, tokensRawDelta: 0, tokensEstimateDelta: 0 });
  });

  it("diff added/removed section 被列出", () => {
    const next = {
      sections: [
        { id: "identity", category: "stable", text: "你是管家。" },
        { id: "memory", category: "memory", text: "用户叫小飞" },
      ],
    };
    const d = diffFootprint(base, next, { changedIds: ["agents", "memory"] });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.added).toEqual(["memory"]);
    expect(d.removed).toEqual(["agents"]);
    expect(d.total.charsDelta).toBe("用户叫小飞".length - "项目指令 A".length);
  });

  it("diff 覆盖 tool 分块:tool 定义变化同样受字节断言约束", () => {
    const b = { tools: [{ name: "read_file", description: "读文件", parameters: { type: "object" } }] };
    const n = { tools: [{ name: "read_file", description: "读文件(含二进制)", parameters: { type: "object" } }] };
    const blocked = diffFootprint(b, n);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.ids).toEqual(["tool:read_file"]);
    const allowed = diffFootprint(b, n, { changedIds: ["tool:read_file"] });
    expect(allowed.ok).toBe(true);
  });
});

describe("M130 manifest 解析", () => {
  it("manifest 未知 category 归 other,tools/toolset 一并解析", () => {
    const parsed = parseFootprintManifest(
      JSON.stringify({
        sections: [{ id: "x", category: "weird", text: "hi" }],
        tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
        toolset: [{ name: "core", hint: "h" }],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.sections?.[0]?.category).toBe("other");
    expect(parsed.input.tools?.[0]?.name).toBe("t");
    expect(parsed.input.toolset?.[0]?.hint).toBe("h");
    expect(normalizeCategory("skills_index")).toBe("skills_index");
  });

  it("manifest 坏:缺 id / 缺 category → MANIFEST_INVALID,坏 JSON → MANIFEST_JSON_INVALID", () => {
    const noId = parseFootprintManifest({ sections: [{ category: "stable", text: "x" }] });
    expect(noId.ok).toBe(false);
    if (!noId.ok) expect(noId.code).toBe("MANIFEST_INVALID");

    const noCat = parseFootprintManifest({ sections: [{ id: "a", text: "x" }] });
    expect(noCat.ok).toBe(false);
    if (!noCat.ok) expect(noCat.code).toBe("MANIFEST_INVALID");

    const badJson = parseFootprintManifest("{not json");
    expect(badJson.ok).toBe(false);
    if (!badJson.ok) expect(badJson.code).toBe("MANIFEST_JSON_INVALID");

    const notObject = parseFootprintManifest("[]");
    expect(notObject.ok).toBe(false);
  });
});

describe("M130 system-composer 接线:渲染字节不变 + truncations", () => {
  const index = [
    { category: "coding", name: "short", description: "短描述" },
    { category: "coding", name: "edge60", description: "a".repeat(60) },
    { category: "coding", name: "edge61", description: "a".repeat(61) },
    { category: "coding", name: "long-cjk", description: "中".repeat(80) },
  ];

  /** 旧实现(M130 之前)的逐字复刻,作为字节基线。 */
  function legacyRender(idx: { category: string; name: string; description: string }[]): string {
    if (idx.length === 0) return ["# 经验索引", "(当前为空;任务中发现可复用做法或坑,用 experience_fold 沉淀)"].join("\n");
    const lines = ["# 经验索引(需要全文用 skill_view(category,name) 查看;发现经验有误用 experience_fold 修正)"];
    for (const e of idx) {
      const desc = e.description.length > 60 ? `${e.description.slice(0, 60)}…` : e.description;
      lines.push(`- ${e.category}/${e.name}: ${desc}`);
    }
    return lines.join("\n");
  }

  it("byte-identical:composeSystemPrompt 的经验索引节与旧实现逐字节相等", () => {
    const composed = composeSystemPrompt({ base: "", experienceIndex: index });
    expect(composed.text).toBe(legacyRender(index));
    expect(composed.sections.map((s) => s.name)).toEqual(["experience-index"]);
    // 空库也给逐字节一致的引导节
    expect(composeSystemPrompt({ base: "", experienceIndex: [] }).text).toBe(legacyRender([]));
  });

  it("truncations:列出被 60 字硬限截断的条目,不改渲染", () => {
    const list = skillDescriptionTruncations(index);
    expect(list.map((t) => t.name)).toEqual(["edge61", "long-cjk"]);
    expect(list[0]!.originalLength).toBe(61);
    expect(list[1]!.originalLength).toBe(80);
    expect(list[1]!.textLength).toBe(61); // 60 码点 + "…"
    // 渲染侧只保留截断后的文本
    const text = composeSystemPrompt({ base: "", experienceIndex: index }).text;
    expect(text).toContain(`- coding/edge61: ${"a".repeat(60)}…`);
    expect(text).toContain(`- coding/long-cjk: ${"中".repeat(60)}…`);
  });
});
