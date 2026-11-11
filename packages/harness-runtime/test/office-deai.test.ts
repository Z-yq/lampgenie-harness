/**
 * 办公输出「去 AI 味」审计(office-deai)的纯逻辑测试。
 * 断言只依赖模块导出的接口与文档里写明的口径:
 * - 规则表 31 条、七类各 ≥2、zh 15 / en 14(emoji 两条双语);
 * - score = 100 * (1 - e^(-加权命中/千字 / 20)) + 结构惩罚,截断到 0..100 取整;
 * - 单条规则最多按 6 次命中计分;缺省阈值 warn=40 / fail=60。
 * 阈值类用例都先用真实分数 S 探一次,再用 S 构造显式阈值,避免把实现的常数抄进断言。
 */
import { describe, expect, it } from "vitest";
import {
  DEAI_CATEGORIES,
  DEAI_CODES,
  DEAI_RULES,
  DEAI_RULES_VERSION,
  analyzeDocument,
  applyExemptions,
  deaiRuleCatalog,
  mergeReports,
  normalizeExcerpt,
} from "../src/agent/office-deai.ts";
import type {
  DeaiCategory,
  DeaiExemption,
  DeaiFinding,
  DeaiKind,
  DeaiResult,
  DeaiVerdict,
} from "../src/agent/office-deai.ts";

// ── 文档口径的独立实现:用来核对实现没有偷偷改公式 ────────────────────
const SATURATION = 20;
const SCORE_HITS_CAP = 6;

function densityOf(weightedHits: number, chars: number): number {
  const perKilo = chars > 0 ? (weightedHits * 1000) / chars : 0;
  return 100 * (1 - Math.exp(-perKilo / SATURATION));
}

function expectedScoreOf(result: DeaiResult): number {
  const weightOf = new Map<string, number>();
  for (const rule of DEAI_RULES) weightOf.set(rule.id, rule.weight);
  const counts = new Map<string, number>();
  for (const finding of result.findings) counts.set(finding.ruleId, (counts.get(finding.ruleId) ?? 0) + 1);
  let weightedHits = 0;
  for (const [ruleId, count] of counts) weightedHits += Math.min(count, SCORE_HITS_CAP) * (weightOf.get(ruleId) ?? 0);
  const raw = densityOf(weightedHits, result.stats.chars) + result.audit.bulletPenalty;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

// ── 固定文本(不变),用于各处断言 ─────────────────────────────────────
/** 干净中文段落:没有任何规则命中。 */
const CLEAN_ZH =
  "上周三的评审会上,我们决定把订单服务的缓存从本地换成共享集群。改完之后 P95 从 800ms 降到 210ms,错误率维持在 0.3%。下一步是把回滚脚本补上,负责人是李工,截止 6 月 12 日。";

/** 满篇黑话 + 模板开场收尾:必然 fail。 */
const JARGON_ZH = [
  "在当今这个数字化时代,随着人工智能技术的不断发展,办公流程需要重新设计。",
  "作为AI语言模型,我将全方位、多维度地赋能团队,打造世界级的闭环生态。",
  "首先,我们要抓住抓手;其次,我们要形成组合拳;最后,我们要实现降本增效。",
  "综上所述,希望本文能给大家带来启发。感谢大家的阅读。",
].join("\n");

/** 78 字里只有一个 weight=1 的命中(也许):落进缺省 warn 档(40..59)。 */
const WARN_ZH =
  "评审结论:这个方案也许能省下一些机器,但还没有压测数据。真正的决定要等到下周的容量评估会议,届时会给出具体的机器台数与成本区间,以及回滚方案的责任人和时间点。";

/** 60 字,两条命中(赋能/也许):豁免其中一条后 residual 落在中间档,便于验证阈值切换。 */
const RESIDUAL_ZH =
  "我们要赋能业务,这周先落地缓存改造。另外,迁移时间也许要往后挪一周,压测还没跑完,数据组在补历史样本,下周才能给出结论。";

/** 6 条等长列表:结构惩罚打满(bulletUniformity≈0.96)。 */
const BULLET_ZH = [
  "本周完成事项如下:",
  "- 完成订单接口的缓存改造工作",
  "- 补齐库存接口的幂等测试用例",
  "- 更新发布流程的回滚脚本说明",
  "- 调整监控告警的阈值配置项",
  "- 梳理值班表的轮换规则文档",
  "- 修复对账任务的时区处理问题",
].join("\n");

const BULLET_ZH_PLAIN = BULLET_ZH.replace(/^- /gm, "");

const EN_DIRTY = "We leverage synergy to empower teams, and unlock robust seamless outcomes.";

// ── 小工具 ────────────────────────────────────────────────────────────
function fakeFinding(ruleId: string, category: DeaiCategory, offset = 0): DeaiFinding {
  return { ruleId, category, severity: "medium", excerpt: "x", offset, length: 1, hint: "hint" };
}

function fakeResult(
  score: number,
  verdict: DeaiVerdict,
  findings: DeaiFinding[] = [],
  category: DeaiCategory = "puffery",
): DeaiResult {
  return {
    ok: true,
    codes: ["DEAI_OK"],
    score,
    verdict,
    findings: findings.map((finding, index) => ({ ...finding, offset: finding.offset + index })),
    stats: {} as DeaiResult["stats"],
    audit: {} as DeaiResult["audit"],
    category,
  } as unknown as DeaiResult;
}

describe("DEAI_RULES 规则表不变量", () => {
  it("DEAI_RULES 规则表共 31 条", () => {
    expect(DEAI_RULES).toHaveLength(31);
    expect(new Set(DEAI_RULES).size).toBe(31);
  });

  it("DEAI_RULES 七类每类至少 2 条", () => {
    expect(DEAI_CATEGORIES).toHaveLength(7);
    for (const category of DEAI_CATEGORIES) {
      const count = DEAI_RULES.filter((rule) => rule.category === category).length;
      expect(count, `类别 ${category} 的规则数`).toBeGreaterThanOrEqual(2);
    }
 // 类别是封闭集合:规则里的 category 必须都出现在 DEAI_CATEGORIES
    for (const rule of DEAI_RULES) expect(DEAI_CATEGORIES).toContain(rule.category);
  });

  it("DEAI_RULES zh 与 en 各至少 8 条(单语言 zh 15 / en 14,含双语则 17 / 16)", () => {
    const zh = DEAI_RULES.filter((rule) => rule.locales.includes("zh")).length;
    const en = DEAI_RULES.filter((rule) => rule.locales.includes("en")).length;
    expect(zh).toBeGreaterThanOrEqual(8);
    expect(en).toBeGreaterThanOrEqual(8);
 // 两条 emoji 规则双语,所以「含 zh」是 15+2、「含 en」是 14+2
    expect(zh).toBe(17);
    expect(en).toBe(16);
    expect(DEAI_RULES.filter((rule) => rule.locales.length === 1 && rule.locales[0] === "zh")).toHaveLength(15);
    expect(DEAI_RULES.filter((rule) => rule.locales.length === 1 && rule.locales[0] === "en")).toHaveLength(14);
 // 每条规则至少声明一个 locale,且只可能是 zh/en
    for (const rule of DEAI_RULES) {
      expect(rule.locales.length).toBeGreaterThanOrEqual(1);
      for (const locale of rule.locales) expect(["zh", "en"]).toContain(locale);
    }
  });

  it("DEAI_RULES rule id 唯一且非空", () => {
    const ids = DEAI_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(0);
      expect(id).toBe(id.trim());
    }
  });

  it("DEAI_RULES 每条 weight 为正数", () => {
    for (const rule of DEAI_RULES) {
      expect(typeof rule.weight, `${rule.id} 的 weight 类型`).toBe("number");
      expect(rule.weight, `${rule.id} 的 weight`).toBeGreaterThan(0);
      expect(Number.isFinite(rule.weight)).toBe(true);
    }
  });

  it("DEAI_RULES 每条 patterns 能被 new RegExp 编译且非空", () => {
    for (const rule of DEAI_RULES) {
      expect(rule.patterns.length, `${rule.id} 的 patterns`).toBeGreaterThanOrEqual(1);
      for (const pattern of rule.patterns) {
        expect(pattern.source.length).toBeGreaterThan(0);
        expect(() => new RegExp(pattern.source, pattern.flags)).not.toThrow();
 // 不带 g 的实例会让 matchAll 抛错,实现会自动补 g,这里确认补出来的也合法
        expect(() => new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)).not.toThrow();
      }
    }
  });

  it("DEAI_RULES 每条规则 hint 非空且 severity 合法", () => {
    for (const rule of DEAI_RULES) {
      expect(rule.hint.trim().length, `${rule.id} 的 hint`).toBeGreaterThan(0);
      expect(["low", "medium", "high"]).toContain(rule.severity);
    }
  });

  it("DEAI_RULES DEAI_CODES 七个码与 DEAI_CATEGORIES 七个类别齐全", () => {
    expect(DEAI_CODES).toHaveLength(7);
    for (const code of [
      "DEAI_OK",
      "DEAI_EMPTY",
      "DEAI_INVALID",
      "DEAI_EXEMPTION_INVALID",
      "DEAI_EXEMPTION_UNUSED",
      "DEAI_THRESHOLD_FAIL",
      "DEAI_THRESHOLD_WARN",
    ]) {
      expect(DEAI_CODES).toContain(code);
    }
    expect(DEAI_CATEGORIES).toEqual(["puffery", "hedging", "template", "connector", "meta", "emoji", "symmetry"]);
  });

  it("DEAI_RULES emoji 两条规则同时声明 zh 与 en", () => {
    const emojiRules = DEAI_RULES.filter((rule) => rule.category === "emoji");
    expect(emojiRules).toHaveLength(2);
    for (const rule of emojiRules) {
      expect(rule.locales).toContain("zh");
      expect(rule.locales).toContain("en");
    }
  });

  it("DEAI_RULES deaiRuleCatalog 是深拷贝,改它不动 DEAI_RULES", () => {
    const catalog = deaiRuleCatalog();
    expect(catalog).not.toBe(DEAI_RULES);
    expect(catalog).toHaveLength(DEAI_RULES.length);
    expect(catalog[0]).not.toBe(DEAI_RULES[0]);

    catalog[0].weight = 999;
    catalog[0].hint = "被改坏了";
    catalog[0].patterns[0].source = "被改坏了";
    catalog[0].locales.push("en");

    expect(DEAI_RULES[0].weight).toBe(2);
    expect(DEAI_RULES[0].hint).not.toBe("被改坏了");
    expect(DEAI_RULES[0].patterns[0].source).not.toBe("被改坏了");
    expect(DEAI_RULES[0].locales).toEqual(["zh"]);

 // 每次调用都拿到新的副本(上次的改动不会泄漏到下一次)
    const again = deaiRuleCatalog();
    expect(again[0].weight).toBe(2);
    expect(again[0].patterns[0].source).not.toBe("被改坏了");
  });

  it("DEAI_RULES DEAI_RULES_VERSION 是 semver 版本号", () => {
    expect(typeof DEAI_RULES_VERSION).toBe("string");
    expect(DEAI_RULES_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(analyzeDocument({ text: CLEAN_ZH }).audit.rulesVersion).toBe(DEAI_RULES_VERSION);
  });
});

describe("analyzeDocument 打分与阈值", () => {
  it("analyzeDocument 干净中文段落 pass 且分数很低", () => {
    const result = analyzeDocument({ text: CLEAN_ZH });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.score).toBe(0);
    expect(result.verdict).toBe("pass");
    expect(result.codes).toEqual(["DEAI_OK"]);
    expect(result.score).toBeLessThanOrEqual(20);
  });

  it("analyzeDocument 满篇黑话模板文 fail 且带 DEAI_THRESHOLD_FAIL", () => {
    const result = analyzeDocument({ text: JARGON_ZH });
    expect(result.ok).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.verdict).toBe("fail");
    expect(result.codes).toContain("DEAI_THRESHOLD_FAIL");
    expect(result.stats.findings).toBe(result.findings.length);
    expect(result.findings.length).toBeGreaterThan(10);
 // 命中来自多类(黑话/模板/连接词/自我指涉都在里面)
    const categories = new Set(result.findings.map((finding) => finding.category));
    expect(categories.size).toBeGreaterThanOrEqual(4);
    expect(categories).toContain("puffery");
    expect(categories).toContain("meta");
  });

  it("analyzeDocument 阈值边界:同一个分数 S 在 fail/warn/pass 三档之间切换", () => {
    const base = analyzeDocument({ text: WARN_ZH });
    const S = base.score;
    expect(S).toBeGreaterThan(0);
    expect(S).toBeLessThan(99);

    const asFail = analyzeDocument({ text: WARN_ZH }, { failThreshold: S, warnThreshold: S - 1 });
    expect(asFail.score).toBe(S);
    expect(asFail.verdict).toBe("fail");
    expect(asFail.codes).toContain("DEAI_THRESHOLD_FAIL");

    const asWarn = analyzeDocument({ text: WARN_ZH }, { failThreshold: S + 1, warnThreshold: S });
    expect(asWarn.score).toBe(S);
    expect(asWarn.verdict).toBe("warn");
    expect(asWarn.codes).toContain("DEAI_THRESHOLD_WARN");

    const asPass = analyzeDocument({ text: WARN_ZH }, { failThreshold: S + 2, warnThreshold: S + 1 });
    expect(asPass.score).toBe(S);
    expect(asPass.verdict).toBe("pass");
    expect(asPass.codes).toEqual(["DEAI_OK"]);
    expect(asPass.audit.warnThreshold).toBe(S + 1);
    expect(asPass.audit.failThreshold).toBe(S + 2);
  });

  it("analyzeDocument 缺省阈值 40 命中 warn 档", () => {
    const result = analyzeDocument({ text: WARN_ZH });
    expect(result.audit.warnThreshold).toBe(40);
    expect(result.audit.failThreshold).toBe(60);
    expect(result.score).toBeGreaterThanOrEqual(40);
    expect(result.score).toBeLessThan(60);
    expect(result.verdict).toBe("warn");
    expect(result.codes).toContain("DEAI_THRESHOLD_WARN");
    expect(result.codes).not.toContain("DEAI_THRESHOLD_FAIL");
  });

  it("analyzeDocument 缺省阈值 60 命中 fail 档", () => {
    const result = analyzeDocument({ text: JARGON_ZH });
    expect(result.audit.warnThreshold).toBe(40);
    expect(result.audit.failThreshold).toBe(60);
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.verdict).toBe("fail");
  });

  it("analyzeDocument 确定性:同输入两次 JSON 完全相等", () => {
    const a = analyzeDocument({ text: JARGON_ZH });
    const b = analyzeDocument({ text: JARGON_ZH });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).not.toBe(b);
 // 同一条规则的多个模式不会因为 g 标志的 lastIndex 残留漏检
    const first = analyzeDocument({ text: "赋能赋能" });
    analyzeDocument({ text: "赋能赋能" });
    const third = analyzeDocument({ text: "赋能赋能" });
    expect(JSON.stringify(first)).toBe(JSON.stringify(third));
  });

  it("analyzeDocument md 剥代码块:代码里的 leverage 不计分,同文本按 txt 会命中", () => {
    const text = [
      "本次改动只调整了缓存读取路径。",
      "",
      "```ts",
      "const leverage = await leverageSynergy();",
      "const holistic = empower(bestInClass);",
      "```",
      "",
    ].join("\n");

    const md = analyzeDocument({ text, kind: "md" });
    expect(md.stats.codeBlocksStripped).toBe(1);
    expect(md.findings).toEqual([]);
    expect(md.score).toBe(0);
    expect(md.verdict).toBe("pass");

    const txt = analyzeDocument({ text, kind: "txt" });
    expect(txt.stats.codeBlocksStripped).toBe(0);
    expect(txt.findings.length).toBeGreaterThan(0);
    expect(txt.score).toBeGreaterThan(0);
    expect(txt.findings.every((finding) => finding.ruleId === "en-puffery-buzzword")).toBe(true);
  });

  it("analyzeDocument md 未闭合围栏按到结尾都是代码处理", () => {
    const text = "本次改动只调整了缓存读取路径。\n```js\nleverage synergy everywhere\n";
    const md = analyzeDocument({ text, kind: "md" });
    expect(md.stats.codeBlocksStripped).toBe(1);
    expect(md.findings).toEqual([]);
    expect(md.score).toBe(0);
 // 非 md 类别不做剥离,同样的代码段会被当正文计分
    const docx = analyzeDocument({ text, kind: "docx" });
    expect(docx.stats.codeBlocksStripped).toBe(0);
    expect(docx.findings.length).toBeGreaterThan(0);
  });

  it("analyzeDocument 全是代码块的 md:chars 为 0、score 为 0 且剥离块数如实留痕", () => {
    const result = analyzeDocument({ text: "```\nleverage synergy\n```\n", kind: "md" });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["DEAI_OK"]);
    expect(result.score).toBe(0);
    expect(result.verdict).toBe("pass");
    expect(result.stats.chars).toBeLessThanOrEqual(1); // 剥完只剩一个换行
    expect(result.stats.findings).toBe(0);
    expect(result.stats.codeBlocksStripped).toBe(1);
  });

  it("analyzeDocument 空文本 DEAI_EMPTY 且 ok 为 true、score 为 0", () => {
    const result = analyzeDocument({ text: "" });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["DEAI_EMPTY"]);
    expect(result.score).toBe(0);
    expect(result.verdict).toBe("pass");
    expect(result.findings).toEqual([]);
    expect(result.stats.chars).toBe(0);
    expect(result.audit.warnThreshold).toBe(40);
    expect(result.audit.failThreshold).toBe(60);
  });

  it("analyzeDocument 非对象或缺 text 时 DEAI_INVALID、ok 为 false 且不抛", () => {
    const cases: unknown[] = [undefined, null, {}, { text: 42 }, { text: null }, [], "赋能", 7];
    for (const input of cases) {
      expect(() => analyzeDocument(input as never), `输入 ${JSON.stringify(input)} 不应抛`).not.toThrow();
      const result = analyzeDocument(input as never);
      expect(result.ok, `输入 ${JSON.stringify(input)} 的 ok`).toBe(false);
      expect(result.codes).toContain("DEAI_INVALID");
      expect(result.score).toBe(0);
      expect(result.findings).toEqual([]);
    }
  });

  it("analyzeDocument warn>=fail 的非法阈值带 DEAI_INVALID 并回退缺省 40/60", () => {
    for (const opts of [
      { warnThreshold: 70, failThreshold: 60 },
      { warnThreshold: 60, failThreshold: 60 },
      { warnThreshold: -1, failThreshold: 60 },
      { warnThreshold: 40, failThreshold: 140 },
    ]) {
      const result = analyzeDocument({ text: CLEAN_ZH }, opts);
      expect(result.codes, `阈值 ${JSON.stringify(opts)}`).toContain("DEAI_INVALID");
      expect(result.audit.warnThreshold).toBe(40);
      expect(result.audit.failThreshold).toBe(60);
    }
  });

  it("analyzeDocument NaN 阈值不抛:非有限数被当作未提供,回退缺省", () => {
    const result = analyzeDocument({ text: CLEAN_ZH }, { warnThreshold: Number.NaN, failThreshold: Number.NaN });
    expect(result.ok).toBe(true);
    expect(result.audit.warnThreshold).toBe(40);
    expect(result.audit.failThreshold).toBe(60);
    expect(result.codes).toEqual(["DEAI_OK"]);
 // NaN 与越界同时出现时才落到 DEAI_INVALID 分支
    const mixed = analyzeDocument({ text: CLEAN_ZH }, { warnThreshold: Number.NaN, failThreshold: 30 });
    expect(mixed.codes).toContain("DEAI_INVALID");
    expect(mixed.audit.warnThreshold).toBe(40);
    expect(mixed.audit.failThreshold).toBe(60);
  });

  it("analyzeDocument 非法 kind 带 DEAI_INVALID 但仍按 txt 分析", () => {
    const result = analyzeDocument({ text: CLEAN_ZH, kind: "pdf" as unknown as DeaiKind });
    expect(result.codes).toContain("DEAI_INVALID");
    expect(result.ok).toBe(true);
    expect(result.audit.kind).toBe("txt");
    expect(result.score).toBe(0);
  });

  it("analyzeDocument emoji 成串命中 emoji-cluster", () => {
    const result = analyzeDocument({ text: "状态:🚀🚀🚀 请查收。" });
    const ruleIds = result.findings.map((finding) => finding.ruleId);
    expect(ruleIds).toContain("emoji-cluster");
    const cluster = result.findings.find((finding) => finding.ruleId === "emoji-cluster");
    expect(cluster?.category).toBe("emoji");
    expect(cluster?.excerpt).toBe("🚀🚀🚀");
    expect(result.stats.emojiDensity).toBeGreaterThan(0);
  });

  it("analyzeDocument bullet 同构率抬高结构惩罚,分数高于去掉列表标记的同文本", () => {
    const withBullets = analyzeDocument({ text: BULLET_ZH });
    const withoutBullets = analyzeDocument({ text: BULLET_ZH_PLAIN });

    expect(withBullets.stats.bullets).toBe(6);
    expect(withoutBullets.stats.bullets).toBe(0);
    expect(withBullets.stats.bulletUniformity).toBeGreaterThanOrEqual(0.9);
    expect(withoutBullets.stats.bulletUniformity).toBe(0);
    expect(withBullets.audit.bulletPenalty).toBe(12);
    expect(withoutBullets.audit.bulletPenalty).toBe(0);
    expect(withBullets.score).toBe(12);
    expect(withBullets.score).toBeGreaterThan(withoutBullets.score);
    expect(withBullets.findings).toEqual([]);
  });

  it("analyzeDocument 句长统计精确(3 句 17 字)", () => {
    const text = "第一句。第二句很短!第三句也不长?";
    const result = analyzeDocument({ text });
    expect(result.stats.chars).toBe(17);
    expect(result.stats.sentences).toBe(3);
 // 句长 [3,5,6]:均值 14/3=4.6667 → 4.67;方差 1.5556 → 标准差 1.2472 → 1.25
    expect(result.stats.avgSentenceLength).toBe(4.67);
    expect(result.stats.sentenceLengthStdDev).toBe(1.25);
  });

  it("analyzeDocument 同规则同位置只记一次(ruleId@offset 唯一)", () => {
    const result = analyzeDocument({ text: "赋能赋能赋能" });
    const keys = result.findings.map((finding) => `${finding.ruleId}@${finding.offset}`);
    expect(result.findings).toHaveLength(3);
    expect(new Set(keys).size).toBe(keys.length);
    expect(result.findings.map((finding) => finding.offset)).toEqual([0, 2, 4]);
    expect(result.stats.densityPerKilo).toBeGreaterThan(0);
  });

  it("analyzeDocument maxFindings 截断命中列表", () => {
    const many = "赋能".repeat(150);
    expect(analyzeDocument({ text: many }).findings).toHaveLength(150);
    const capped = analyzeDocument({ text: many }, { maxFindings: 4 });
    expect(capped.findings).toHaveLength(4);
 // 截断只影响 findings 列表,ok/字段结构仍然完整
    expect(capped.ok).toBe(true);
    expect(capped.stats.findings).toBe(4);
  });

  it("analyzeDocument maxHitsPerRuleForScore 限制单规则计分次数并标记 cappedRules", () => {
    const many = "赋能".repeat(150);
    const base = analyzeDocument({ text: many });
    const capped = analyzeDocument({ text: many }, { maxHitsPerRuleForScore: 2 });

    expect(base.findings.length).toBe(capped.findings.length);
    expect(base.audit.weightedHits).toBe(12); // min(150,6) * weight 2
    expect(capped.audit.weightedHits).toBe(4); // min(150,2) * weight 2
    expect(base.audit.cappedRules).toBe(1);
    expect(capped.audit.cappedRules).toBe(1);
    expect(capped.score).toBeLessThan(base.score);
  });

  it("analyzeDocument 输出可 JSON 序列化且往返后分数一致", () => {
    const result = analyzeDocument({ text: JARGON_ZH });
    let json = "";
    expect(() => {
      json = JSON.stringify(result);
    }).not.toThrow();
    const roundTrip = JSON.parse(json) as DeaiResult;
    expect(roundTrip.score).toBe(result.score);
    expect(roundTrip.verdict).toBe(result.verdict);
    expect(roundTrip.findings).toEqual(result.findings);
    expect(roundTrip).toEqual(result);
  });

  it("analyzeDocument zh 文本按中文规则命中", () => {
    const result = analyzeDocument({ text: "这个方案可复现,但据说下周会调整。" });
    const ruleIds = result.findings.map((finding) => finding.ruleId);
    expect(ruleIds).toContain("zh-hedging-vague-source");
    const finding = result.findings.find((item) => item.ruleId === "zh-hedging-vague-source");
    expect(finding?.category).toBe("hedging");
    expect(finding?.excerpt).toBe("据说");
    expect(finding?.hint.length).toBeGreaterThan(0);
  });

  it("analyzeDocument en 文本按英文规则命中且大小写不敏感", () => {
    const result = analyzeDocument({ text: EN_DIRTY });
    const ruleIds = result.findings.map((finding) => finding.ruleId);
    expect(ruleIds).toContain("en-puffery-buzzword");
    expect(ruleIds).toContain("en-puffery-hype");
    const buzzwords = result.findings.filter((finding) => finding.ruleId === "en-puffery-buzzword");
    expect(buzzwords.length).toBeGreaterThanOrEqual(2);
 // excerpt 已归一化为小写
    for (const finding of buzzwords) expect(finding.excerpt).toBe(finding.excerpt.toLowerCase());
    expect(result.score).toBeGreaterThan(0);
  });

  it("analyzeDocument 分数与文档口径的饱和公式一致(独立实现核对)", () => {
    for (const text of [WARN_ZH, JARGON_ZH, RESIDUAL_ZH, EN_DIRTY]) {
      const result = analyzeDocument({ text });
      expect(expectedScoreOf(result), `文本 ${text.slice(0, 12)}… 的分数`).toBe(result.score);
      expect(result.audit.formula).toBe("deai-sat-v1");
      expect(result.audit.saturation).toBe(20);
      expect(result.audit.exemptionsApplied).toBe(0);
      expect(result.audit.densityScore).toBeCloseTo(densityOf(result.audit.weightedHits, result.stats.chars), 2);
    }
  });
});

describe("applyExemptions 豁免与 residual", () => {
 /** 3 处「赋能」命中,权重 2,score 打满。 */
  const base = analyzeDocument({ text: "我们要赋能业务,赋能团队,赋能客户。" });
  const EXEMPT: DeaiExemption = { ruleId: "zh-puffery-core", excerpt: "赋能", reason: "团队内部术语" };

  it("applyExemptions applied 精确匹配规则+excerpt 并清空残留命中", () => {
    expect(base.findings).toHaveLength(3);
    const outcome = applyExemptions(base, [EXEMPT]);
    expect(outcome.exemptions.applied).toHaveLength(1);
    expect(outcome.exemptions.applied[0].reason).toBe("团队内部术语");
    expect(outcome.exemptions.unused).toEqual([]);
    expect(outcome.exemptions.invalid).toEqual([]);
    expect(outcome.residualFindings).toEqual([]);
    expect(outcome.residualScore).toBe(0);
    expect(outcome.residualVerdict).toBe("pass");
    expect(outcome.codes).toEqual(["DEAI_OK"]);
    expect(outcome.stats.findings).toBe(0);
    expect(outcome.audit.exemptionsApplied).toBe(1);
  });

  it("applyExemptions reason 少于 4 字记为 invalid 且不影响 residual", () => {
    const outcome = applyExemptions(base, [{ ruleId: "zh-puffery-core", excerpt: "赋能", reason: "术语" }]);
    expect(outcome.exemptions.invalid).toHaveLength(1);
    expect(outcome.exemptions.invalid[0].ruleId).toBe("zh-puffery-core");
    expect(outcome.exemptions.applied).toEqual([]);
    expect(outcome.codes).toContain("DEAI_EXEMPTION_INVALID");
    expect(outcome.exemptions.appliedFindings).toBe(0);
    expect(outcome.residualFindings).toHaveLength(3);
    expect(outcome.residualScore).toBe(base.score);
  });

  it("applyExemptions excerpt 为空(或全空白)记为 invalid,ruleId 缺失也一样", () => {
    const outcome = applyExemptions(base, [
      { ruleId: "zh-puffery-core", excerpt: "   ", reason: "理由写得足够长" },
      { ruleId: "zh-puffery-core", excerpt: "", reason: "理由写得足够长" },
      { ruleId: "  ", excerpt: "赋能", reason: "理由写得足够长" },
    ]);
    expect(outcome.exemptions.invalid).toHaveLength(3);
    expect(outcome.exemptions.appliedFindings).toBe(0);
    expect(outcome.residualFindings).toHaveLength(3);
    expect(outcome.codes).toContain("DEAI_EXEMPTION_INVALID");
  });

  it("applyExemptions 无命中记为 unused 并带 DEAI_EXEMPTION_UNUSED", () => {
    const outcome = applyExemptions(base, [{ ruleId: "zh-puffery-core", excerpt: "闭环", reason: "行业术语复核" }]);
    expect(outcome.exemptions.unused).toHaveLength(1);
    expect(outcome.exemptions.unused[0].excerpt).toBe("闭环");
    expect(outcome.exemptions.applied).toEqual([]);
    expect(outcome.exemptions.appliedFindings).toBe(0);
    expect(outcome.codes).toContain("DEAI_EXEMPTION_UNUSED");
    expect(outcome.residualScore).toBe(base.score);
  });

  it("applyExemptions 要求 excerpt 精确相等(包含关系不算命中)", () => {
    const outcome = applyExemptions(base, [{ ruleId: "zh-puffery-core", excerpt: "赋能业务", reason: "行业术语复核" }]);
    expect(outcome.exemptions.applied).toEqual([]);
    expect(outcome.exemptions.unused).toHaveLength(1);
    expect(outcome.residualFindings).toHaveLength(3);
  });

  it("applyExemptions 不改写入参:result 与 exemptions 前后 JSON 一致", () => {
    const exemptions: DeaiExemption[] = [{ ...EXEMPT }];
    const before = JSON.stringify(base);
    const beforeExemptions = JSON.stringify(exemptions);
    const outcome = applyExemptions(base, exemptions);
    expect(JSON.stringify(base)).toBe(before);
    expect(JSON.stringify(exemptions)).toBe(beforeExemptions);
    expect(outcome).not.toBe(base);
    expect(outcome.findings).toBe(base.findings);
    expect(outcome.score).toBe(base.score);
    expect(outcome.verdict).toBe(base.verdict);
  });

  it("applyExemptions residualScore 严格小于原 score", () => {
    const outcome = applyExemptions(base, [EXEMPT]);
    expect(base.score).toBeGreaterThan(0);
    expect(outcome.residualScore).toBeLessThan(base.score);
    expect(outcome.residualFindings.length).toBeLessThan(base.findings.length);
    expect(outcome.audit.weightedHits).toBeLessThan(base.audit.weightedHits);
  });

  it("applyExemptions 一次豁免消费同一 ruleId+excerpt 的全部命中(appliedFindings 计数)", () => {
    const outcome = applyExemptions(base, [EXEMPT]);
    expect(outcome.exemptions.appliedFindings).toBe(3);
    expect(outcome.residualFindings).toEqual([]);
 // 多条豁免:appliedFindings 是各条消费的命中数之和
    const two = applyExemptions(analyzeDocument({ text: RESIDUAL_ZH }), [
      { ruleId: "zh-puffery-core", excerpt: "赋能", reason: "团队内部术语" },
      { ruleId: "zh-hedging-maybe", excerpt: "也许", reason: "未验证的风险提示" },
    ]);
    expect(two.exemptions.applied).toHaveLength(2);
    expect(two.exemptions.appliedFindings).toBe(2);
    expect(two.residualFindings).toEqual([]);
    expect(two.residualScore).toBe(0);
  });

  it("applyExemptions residualVerdict 随阈值变化(fail/warn/pass)", () => {
    const probe = applyExemptions(analyzeDocument({ text: RESIDUAL_ZH }), [
      { ruleId: "zh-puffery-core", excerpt: "赋能", reason: "团队内部术语" },
    ]);
    const S = probe.residualScore;
    expect(S).toBeGreaterThan(0);
    expect(S).toBeLessThan(98);
    const exemptions: DeaiExemption[] = [{ ruleId: "zh-puffery-core", excerpt: "赋能", reason: "团队内部术语" }];

    const asFail = applyExemptions(analyzeDocument({ text: RESIDUAL_ZH }, { failThreshold: S, warnThreshold: S - 1 }), exemptions);
    expect(asFail.residualScore).toBe(S);
    expect(asFail.residualVerdict).toBe("fail");
    expect(asFail.codes).toContain("DEAI_THRESHOLD_FAIL");

    const asWarn = applyExemptions(
      analyzeDocument({ text: RESIDUAL_ZH }, { failThreshold: S + 1, warnThreshold: S }),
      exemptions);
    expect(asWarn.residualScore).toBe(S);
    expect(asWarn.residualVerdict).toBe("warn");
    expect(asWarn.codes).toContain("DEAI_THRESHOLD_WARN");

    const asPass = applyExemptions(
      analyzeDocument({ text: RESIDUAL_ZH }, { failThreshold: S + 2, warnThreshold: S + 1 }),
      exemptions);
    expect(asPass.residualScore).toBe(S);
    expect(asPass.residualVerdict).toBe("pass");
    expect(asPass.codes).toEqual(["DEAI_OK"]);
  });

  it("applyExemptions 对 excerpt 做归一化比较(空白折叠 + 英文小写)", () => {
    const en = analyzeDocument({ text: EN_DIRTY });
    const leverage = en.findings.find((finding) => finding.excerpt === "leverage");
    expect(leverage).toBeDefined();
    const outcome = applyExemptions(en, [
      { ruleId: "en-puffery-buzzword", excerpt: "  LEVERAGE  ", reason: "quoted from a customer deck" },
    ]);
    expect(outcome.exemptions.applied).toHaveLength(1);
    expect(outcome.exemptions.appliedFindings).toBeGreaterThanOrEqual(1);
    expect(outcome.residualFindings.some((finding) => finding.excerpt === "leverage")).toBe(false);
 // 同规则的其他 excerpt 不受影响
    expect(outcome.residualFindings.some((finding) => finding.ruleId === "en-puffery-buzzword")).toBe(true);
  });

  it("applyExemptions 非对象 result 返回 DEAI_INVALID 且不抛,空对象则按空命中降级", () => {
    for (const broken of [undefined, null, "赋能", 42]) {
      expect(() => applyExemptions(broken as DeaiResult, [EXEMPT])).not.toThrow();
      const outcome = applyExemptions(broken as DeaiResult, [EXEMPT]);
      expect(outcome.ok).toBe(false);
      expect(outcome.codes).toContain("DEAI_INVALID");
      expect(outcome.residualFindings).toEqual([]);
      expect(outcome.residualScore).toBe(0);
    }
 // 空对象不抛:按「没有命中」降级,豁免全部记 unused
    const empty = applyExemptions({} as DeaiResult, [EXEMPT]);
    expect(empty.residualFindings).toEqual([]);
    expect(empty.exemptions.unused).toHaveLength(1);
    expect(empty.exemptions.appliedFindings).toBe(0);
    expect(empty.codes).toContain("DEAI_EXEMPTION_UNUSED");
    expect(empty.residualVerdict).toBe("pass");
  });

  it("applyExemptions 非数组 exemptions 当成空列表,残留命中不变", () => {
    const outcome = applyExemptions(base, "not-an-array" as unknown as DeaiExemption[]);
    expect(outcome.exemptions.applied).toEqual([]);
    expect(outcome.exemptions.unused).toEqual([]);
    expect(outcome.exemptions.invalid).toEqual([]);
    expect(outcome.exemptions.appliedFindings).toBe(0);
    expect(outcome.residualFindings).toHaveLength(3);
    expect(outcome.residualScore).toBe(base.score);
    expect(outcome.residualVerdict).toBe("fail");
  });
});

describe("mergeReports 多文档合并", () => {
  it("mergeReports 取最差 verdict 并统计各档数量", () => {
    const report = mergeReports([
      fakeResult(10, "pass"),
      fakeResult(50, "warn"),
      fakeResult(80, "fail"),
      fakeResult(20, "pass"),
    ]);
    expect(report.ok).toBe(true);
    expect(report.codes).toEqual(["DEAI_OK"]);
    expect(report.docs).toBe(4);
    expect(report.worstVerdict).toBe("fail");
    expect(report.verdicts).toEqual({ pass: 2, warn: 1, fail: 1 });
    expect(report.rulesVersion).toBe(DEAI_RULES_VERSION);
  });

  it("mergeReports 最差 verdict:warn 不会被更干净的文档抹平", () => {
    const report = mergeReports([fakeResult(5, "pass"), fakeResult(45, "warn")]);
    expect(report.worstVerdict).toBe("warn");
    expect(report.verdicts).toEqual({ pass: 1, warn: 1, fail: 0 });
  });

  it("mergeReports 平均分取整(四舍五入并截断到 0..100)", () => {
    expect(mergeReports([fakeResult(61, "pass"), fakeResult(62, "pass")]).averageScore).toBe(62);
    expect(mergeReports([fakeResult(90, "pass"), fakeResult(95, "pass")]).averageScore).toBe(93);
    expect(mergeReports([fakeResult(10, "pass"), fakeResult(50, "warn"), fakeResult(80, "fail")]).averageScore).toBe(47);
    expect(mergeReports([fakeResult(100, "fail"), fakeResult(100, "fail")]).averageScore).toBe(100);
  });

  it("mergeReports ruleHits 按 count 降序、同 count 按 ruleId 升序且计数正确", () => {
    const report = mergeReports([
      fakeResult(30, "pass", [
        fakeFinding("zh-puffery-core", "puffery"),
        fakeFinding("zh-puffery-core", "puffery"),
        fakeFinding("zh-puffery-core", "puffery"),
        fakeFinding("zh-hedging-maybe", "hedging"),
      ]),
      fakeResult(70, "fail", [
        fakeFinding("zh-connector-summary", "connector"),
        fakeFinding("zh-connector-summary", "connector"),
        fakeFinding("zh-connector-summary", "connector"),
        fakeFinding("zh-hedging-maybe", "hedging"),
      ]),
    ]);
    expect(report.ruleHits.map((hit) => hit.ruleId)).toEqual([
      "zh-connector-summary",
      "zh-puffery-core",
      "zh-hedging-maybe",
    ]);
    expect(report.ruleHits.map((hit) => hit.count)).toEqual([3, 3, 2]);
    expect(report.ruleHits[2].category).toBe("hedging");
    expect(report.ruleHits[0].category).toBe("connector");
  });

  it("mergeReports 空数组返回 DEAI_EMPTY", () => {
    const report = mergeReports([]);
    expect(report.ok).toBe(false);
    expect(report.codes).toEqual(["DEAI_EMPTY"]);
    expect(report.docs).toBe(0);
    expect(report.averageScore).toBe(0);
    expect(report.worstVerdict).toBe("pass");
    expect(report.verdicts).toEqual({ pass: 0, warn: 0, fail: 0 });
    expect(report.ruleHits).toEqual([]);
  });

  it("mergeReports 非数组返回 DEAI_INVALID 且不抛", () => {
    for (const broken of [undefined, null, "docs", 42, {}]) {
      expect(() => mergeReports(broken as never)).not.toThrow();
      const report = mergeReports(broken as never);
      expect(report.ok).toBe(false);
      expect(report.codes).toEqual(["DEAI_INVALID"]);
      expect(report.docs).toBe(0);
    }
  });

  it("mergeReports 可直接吃 analyzeDocument 的 DeaiResult 数组", () => {
    const report = mergeReports([analyzeDocument({ text: CLEAN_ZH }), analyzeDocument({ text: JARGON_ZH })]);
    expect(report.ok).toBe(true);
    expect(report.docs).toBe(2);
    expect(report.worstVerdict).toBe("fail");
    expect(report.verdicts).toEqual({ pass: 1, warn: 0, fail: 1 });
    expect(report.ruleHits.length).toBeGreaterThan(0);
    expect(report.ruleHits.every((hit) => hit.count > 0)).toBe(true);
  });

  it("mergeReports 接受 {result} 包装并与裸 DeaiResult 混用", () => {
    const wrapped = mergeReports([{ id: "a.docx", result: fakeResult(30, "warn") }, fakeResult(10, "pass")]);
    expect(wrapped.ok).toBe(true);
    expect(wrapped.docs).toBe(2);
    expect(wrapped.worstVerdict).toBe("warn");

    const onlyWrapped = mergeReports([{ id: "a.docx", result: fakeResult(30, "warn") }]);
    expect(onlyWrapped.docs).toBe(1);
    expect(onlyWrapped.averageScore).toBe(30);
  });

  it("mergeReports 跳过认不出的条目,只统计合法结果", () => {
    const report = mergeReports([
      fakeResult(20, "pass"),
      "not-a-result" as unknown as DeaiResult,
      { foo: 1 } as unknown as DeaiResult,
      { result: "nope" } as unknown as DeaiResult,
    ]);
    expect(report.ok).toBe(true);
    expect(report.docs).toBe(1);
    expect(report.averageScore).toBe(20);
  });
});

describe("normalizeExcerpt 归一化", () => {
  it("normalizeExcerpt 折叠空白、去首尾并转小写", () => {
    expect(normalizeExcerpt("  We \n\n LEVERAGE\tTeams  ")).toBe("we leverage teams");
    expect(normalizeExcerpt("赋能  闭环")).toBe("赋能 闭环");
  });

  it("normalizeExcerpt 对非字符串输入返回空串", () => {
    for (const input of [undefined, null, 42, {}, []]) {
      expect(normalizeExcerpt(input as unknown as string)).toBe("");
    }
  });

  it("normalizeExcerpt 全空白返回空串,已是归一化的输入保持不变", () => {
    expect(normalizeExcerpt("   \n\t  ")).toBe("");
    expect(normalizeExcerpt("据说明天上线")).toBe("据说明天上线");
  });
});
