/**
 * 办公文档可寻址契约(office-anchor)的纯逻辑测试。
 * 断言只依赖模块导出的公开口径:
 * - 归一:NFKC + 去标点/空白 + 小写 + CJK 部首折叠(24 组)+ 中文数字折叠;
 * - 锚点:一律 1-based,0/负数/非数字/超长 → INVALID;
 * - 文本解析:exact → prefix → contains 三层,打分并列 → AMBIGUOUS;
 * - TOC:三形态解析 + missing/extra/order/duplicate/out-of-range/off-by-one;
 * - 所有函数不 throw、不可变、同输入同输出。
 */
import { describe, expect, it } from "vitest";
import {
  ANCHOR_CODES,
  CJK_RADICAL_MAP,
  MAX_ANCHOR_INDEX,
  OFFICE_ANCHOR_VERSION,
  extractHeadings,
  normalizeHeading,
  parseAnchor,
  parseToc,
  parseTocDocument,
  resolveAnchor,
  validateToc,
} from "../src/agent/office-anchor.ts";
import type { HeadingRef, TocEntry } from "../src/agent/office-anchor.ts";

const headingsOf = (...texts: string[]): HeadingRef[] =>
  texts.map((text, i) => ({ text, index: i + 1 }));

const tocOf = (pairs: [number, string][]): TocEntry[] =>
  pairs.map(([index, title]) => ({ index, title, raw: `${index}. ${title}`, form: "ordered" as const }));

describe("normalizeHeading", () => {
  it("NFKC 把全角字母数字折成半角", () => {
    expect(normalizeHeading("ＡＢＣ　１２３")).toBe("abc123");
  });

  it("去中文标点与内部空白", () => {
    expect(normalizeHeading("第三章 数据流。")).toBe("第3章数据流");
    expect(normalizeHeading("第 3 章　数据流")).toBe("第3章数据流");
  });

  it("全角空格与半角空格同口径", () => {
    expect(normalizeHeading("a b")).toBe(normalizeHeading("a　b"));
  });

  it("大小写不敏感", () => {
    expect(normalizeHeading("Agent Harness")).toBe("agentharness");
  });

  it("CJK 部首折叠:氵/扌/忄/讠/钅/纟/阝", () => {
    expect(normalizeHeading("氵流")).toBe("水流");
    expect(normalizeHeading("扌法")).toBe("手法");
    expect(normalizeHeading("忄情")).toBe("心情");
    expect(normalizeHeading("讠论")).toBe("言论");
    expect(normalizeHeading("钅属")).toBe("金属");
    expect(normalizeHeading("纟线")).toBe("糸线");
    expect(normalizeHeading("阝部")).toBe("阜部");
  });

  it("CJK 部首折叠表至少 20 组", () => {
    expect(Object.keys(CJK_RADICAL_MAP).length).toBeGreaterThanOrEqual(20);
  });

  it("王字旁折叠为玉", () => {
    expect(normalizeHeading("王字旁")).toBe("玉字旁");
  });

  it("中文数字折叠:第三章 ≡ 第3章", () => {
    expect(normalizeHeading("第一章")).toBe("第1章");
    expect(normalizeHeading("第十二章")).toBe("第12章");
    expect(normalizeHeading("第二十章")).toBe("第20章");
    expect(normalizeHeading("第 3 章")).toBe(normalizeHeading("第三章"));
  });

  it("中英标点、符号、emoji 全部剥离", () => {
    expect(normalizeHeading("Hello, World! 【重点】🚀")).toBe("helloworld重点");
  });

  it("空串与纯标点归为空", () => {
    expect(normalizeHeading("")).toBe("");
    expect(normalizeHeading("　 。，、!? ")).toBe("");
  });

  it("幂等:再跑一次结果不变", () => {
    const once = normalizeHeading("第三章 数据流。");
    expect(normalizeHeading(once)).toBe(once);
  });
});

describe("parseAnchor", () => {
  const expectPage = (raw: string, index: number): void => {
    const parsed = parseAnchor(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.code).toBe("OK");
    expect(parsed.kind).toBe("page");
    expect(parsed.index).toBe(index);
    expect(parsed.raw).toBe(raw);
  };
  const expectSlide = (raw: string, index: number): void => {
    const parsed = parseAnchor(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe("slide");
    expect(parsed.index).toBe(index);
  };

  it("裸数字按 1-based 页码", () => {
    expectPage("3", 3);
  });

  it("p3 / P3", () => {
    expectPage("p3", 3);
    expectPage("P3", 3);
  });

  it("page 3 / Page3", () => {
    expectPage("page 3", 3);
    expectPage("Page3", 3);
  });

  it("第3页 / 第 3 页", () => {
    expectPage("第3页", 3);
    expectPage("第 3 页", 3);
  });

  it("slide 3 → slide", () => {
    expectSlide("slide 3", 3);
  });

  it("幻灯片3 / 幻灯片 3 → slide", () => {
    expectSlide("幻灯片3", 3);
    expectSlide("幻灯片 3", 3);
  });

  it("第3张 → slide", () => {
    expectSlide("第3张", 3);
  });

  it("全角数字经 NFKC 接受", () => {
    expectPage("ｐ３", 3);
  });

  it("0 拒绝", () => {
    expect(parseAnchor("0").code).toBe("INVALID");
    expect(parseAnchor("p0").code).toBe("INVALID");
    expect(parseAnchor("第0页").code).toBe("INVALID");
  });

  it("负数拒绝", () => {
    expect(parseAnchor("-3").code).toBe("INVALID");
    expect(parseAnchor("page -1").code).toBe("INVALID");
    expect(parseAnchor("第-2页").code).toBe("INVALID");
  });

  it("非数字拒绝", () => {
    expect(parseAnchor("abc").code).toBe("INVALID");
    expect(parseAnchor("第三页").code).toBe("INVALID");
    expect(parseAnchor("").code).toBe("INVALID");
  });

  it("超长输入拒绝", () => {
    expect(parseAnchor("1".repeat(40)).code).toBe("INVALID");
  });

  it("超出上限拒绝", () => {
    expect(parseAnchor(String(MAX_ANCHOR_INDEX + 1)).code).toBe("INVALID");
  });

  it("边界值 MAX_ANCHOR_INDEX 接受", () => {
    expect(parseAnchor(String(MAX_ANCHOR_INDEX)).index).toBe(MAX_ANCHOR_INDEX);
  });
});

describe("resolveAnchor", () => {
  it("数字锚点直接命中 1-based index", () => {
    const result = resolveAnchor(headingsOf("第一章", "第二章", "第三章"), "p3");
    expect(result.code).toBe("OK");
    expect(result.index).toBe(3);
    expect(result.candidates[0]?.match).toBe("index");
  });

  it("裸数字同样按 1-based index", () => {
    expect(resolveAnchor(headingsOf("甲", "乙"), "2").index).toBe(2);
  });

  it("数字越界 → NOT_FOUND", () => {
    expect(resolveAnchor(headingsOf("甲", "乙"), "p9").code).toBe("NOT_FOUND");
  });

  it("非法数字锚点 → INVALID", () => {
    expect(resolveAnchor(headingsOf("甲", "乙"), "0").code).toBe("INVALID");
    expect(resolveAnchor(headingsOf("甲", "乙"), "第0页").code).toBe("INVALID");
  });

  it("标点差异走 exact 命中", () => {
    const result = resolveAnchor(headingsOf("第三章 数据流"), "第三章 数据流。");
    expect(result.code).toBe("OK");
    expect(result.index).toBe(1);
    expect(result.candidates[0]?.match).toBe("exact");
  });

  it("中文数字变体走 exact:「第 3 章 数据流」命中「第三章 数据流」", () => {
    const result = resolveAnchor(headingsOf("第三章 数据流"), "第 3 章 数据流");
    expect(result.code).toBe("OK");
    expect(result.index).toBe(1);
  });

  it("前缀命中:「第3章」命中「第三章 数据流:全景」", () => {
    const result = resolveAnchor(headingsOf("第三章 数据流:全景"), "第3章");
    expect(result.code).toBe("OK");
    expect(result.candidates[0]?.match).toBe("prefix");
  });

  it("包含命中:标题不以查询开头时用 contains", () => {
    const result = resolveAnchor(headingsOf("全景:数据流"), "数据流");
    expect(result.code).toBe("OK");
    expect(result.candidates[0]?.match).toBe("contains");
  });

  it("两个归一后同名且长度相同的标题 → AMBIGUOUS 带候选", () => {
    const result = resolveAnchor(headingsOf("数据流", "数据流"), "数据流");
    expect(result.code).toBe("AMBIGUOUS");
    expect(result.ok).toBe(false);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.index)).toEqual([1, 2]);
  });

  it("归一后同名但原始长度不同 → 原始长度差更小者优先(仍 OK)", () => {
    const result = resolveAnchor(headingsOf("数据流", "数据流。"), "数据流");
    expect(result.code).toBe("OK");
    expect(result.index).toBe(1);
  });

  it("包含层得分并列 → AMBIGUOUS", () => {
    const result = resolveAnchor(headingsOf("概览数据流", "回顾数据流"), "数据流");
    expect(result.code).toBe("AMBIGUOUS");
    expect(result.candidates).toHaveLength(2);
  });

  it("完全找不到 → NOT_FOUND", () => {
    expect(resolveAnchor(headingsOf("第一章"), "数据流").code).toBe("NOT_FOUND");
  });

  it("打分:归一长度差更小者优先", () => {
    const result = resolveAnchor(headingsOf("数据流总览", "数据流"), "数据流");
    expect(result.code).toBe("OK");
    expect(result.index).toBe(2);
  });

  it("不改动输入标题数组(不可变)", () => {
    const headings = Object.freeze([
      Object.freeze({ text: "第三章 数据流", index: 1 }),
      Object.freeze({ text: "第四章", index: 2 }),
    ]);
    expect(() => resolveAnchor(headings, "第3章")).not.toThrow();
    expect(headings[0]?.text).toBe("第三章 数据流");
  });

  it("同输入同输出(确定性)", () => {
    const headings = headingsOf("甲", "乙", "丙");
    expect(resolveAnchor(headings, "乙")).toEqual(resolveAnchor(headings, "乙"));
  });
});

describe("parseToc", () => {
  const md = [
    "## 目录",
    "1. 第一章 开场",
    "- [第二章 模块地图](#第二章)",
    "| 3 | 第三章 旅程 |",
    "",
    "## 第一章 开场",
    "正文",
    "1. 这条不是目录",
  ].join("\n");

  it("解析三种形态:ordered / link / table", () => {
    const entries = parseToc(md);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.form)).toEqual(["ordered", "link", "table"]);
  });

  it("条目序号与标题正确", () => {
    const entries = parseToc(md);
    expect(entries.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.title)).toEqual(["第一章 开场", "第二章 模块地图", "第三章 旅程"]);
  });

  it("目录节在下一个同级标题处结束", () => {
    expect(parseToc(md).some((e) => e.title === "这条不是目录")).toBe(false);
  });

  it("无目录节时声明为未声明且前置区有序列表仍可识别", () => {
    const doc = parseTocDocument("# 标题\n\n1. 甲\n2. 乙\n\n## 正文\n1. 正文列表");
    expect(doc.declared).toBe(false);
    expect(doc.entries.map((e) => e.title)).toEqual(["甲", "乙"]);
  });

  it("完全无目录 → 0 条", () => {
    const doc = parseTocDocument("# 标题\n\n总评:没有目录。\n\n## 正文\n正文内容");
    expect(doc.declared).toBe(false);
    expect(doc.entries).toHaveLength(0);
  });

  it("代码围栏里的目录标题不算目录节", () => {
    const doc = parseTocDocument("```\n## 目录\n1. 假条目\n```\n\n## 正文");
    expect(doc.declared).toBe(false);
    expect(doc.entries).toHaveLength(0);
  });

  it("link 形态缺省序号按出现顺序 1-based", () => {
    const doc = parseTocDocument("## 目录\n- [甲](#a)\n- [乙](#b)");
    expect(doc.entries.map((e) => e.index)).toEqual([1, 2]);
  });
});

describe("validateToc", () => {
  it("完全一致 → ok", () => {
    const result = validateToc(
      tocOf([
        [1, "第一章 开场"],
        [2, "第二章 模块地图"],
      ]),
      headingsOf("第一章 开场", "第二章 模块地图"),
    );
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.matched).toHaveLength(2);
    expect(result.offByOne).toBeNull();
  });

  it("标题标点/空白差异仍算匹配", () => {
    const result = validateToc(tocOf([[1, "第一章 开场。"]]), headingsOf("第一章  开场"));
    expect(result.ok).toBe(true);
  });

  it("缺正文标题 → TOC_DRIFT(missing)", () => {
    const result = validateToc(
      tocOf([
        [1, "第一章 开场"],
        [2, "并不存在的章节"],
      ]),
      headingsOf("第一章 开场"),
    );
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === "TOC_DRIFT" && i.kind === "missing");
    expect(issue?.title).toBe("并不存在的章节");
  });

  it("正文有而目录无 → TOC_DRIFT(extra)", () => {
    const result = validateToc(tocOf([[1, "第一章 开场"]]), headingsOf("第一章 开场", "漏掉的章节"));
    const issue = result.issues.find((i) => i.code === "TOC_DRIFT" && i.kind === "extra");
    expect(issue?.title).toBe("漏掉的章节");
    expect(issue?.actual).toBe(2);
  });

  it("顺序不一致 → TOC_ORDER", () => {
    const result = validateToc(
      tocOf([
        [1, "甲"],
        [3, "丙"],
        [2, "乙"],
      ]),
      headingsOf("甲", "乙", "丙"),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "TOC_ORDER")).toBe(true);
  });

  it("目录重复列同一标题 → TOC_DUPLICATE", () => {
    const result = validateToc(
      tocOf([
        [1, "甲"],
        [2, "乙"],
        [3, "甲"],
      ]),
      headingsOf("甲", "乙"),
    );
    expect(result.issues.some((i) => i.code === "TOC_DUPLICATE")).toBe(true);
  });

  it("序号越界 → TOC_OUT_OF_RANGE", () => {
    const result = validateToc(tocOf([[9, "甲"]]), headingsOf("甲"));
    expect(result.issues.some((i) => i.code === "TOC_OUT_OF_RANGE")).toBe(true);
  });

  it("目录序号整体 0-based → off-by-one + 修正建议", () => {
    const result = validateToc(
      tocOf([
        [0, "甲"],
        [1, "乙"],
        [2, "丙"],
      ]),
      headingsOf("甲", "乙", "丙"),
    );
    expect(result.offByOne).toBe(1);
    const issue = result.issues.find((i) => i.code === "TOC_DRIFT" && i.kind === "off-by-one");
    expect(issue?.suggestion).toContain("+1");
    expect(result.issues.some((i) => i.code === "TOC_OUT_OF_RANGE")).toBe(false);
  });

  it("目录序号整体偏大 1 → off-by-one(-1 建议)", () => {
    const result = validateToc(
      tocOf([
        [2, "甲"],
        [3, "乙"],
        [4, "丙"],
      ]),
      headingsOf("甲", "乙", "丙"),
    );
    expect(result.offByOne).toBe(-1);
    const issue = result.issues.find((i) => i.kind === "off-by-one");
    expect(issue?.suggestion).toContain("-1");
  });

  it("空目录默认放行(未声明目录)", () => {
    const result = validateToc([], headingsOf("甲", "乙"));
    expect(result.ok).toBe(true);
    expect(result.tocEntries).toBe(0);
  });

  it("requireToc=true 时空目录 → missing-toc", () => {
    const result = validateToc([], headingsOf("甲"), { requireToc: true });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.kind).toBe("missing-toc");
  });

  it("matched 给出条目→标题的配对", () => {
    const result = validateToc(tocOf([[2, "乙"]]), headingsOf("甲", "乙"));
    expect(result.matched).toEqual([{ entryIndex: 2, headingIndex: 2, title: "乙" }]);
  });

  it("不改动输入(toc / headings)", () => {
    const toc = Object.freeze(tocOf([[1, "甲"]]));
    const headings = Object.freeze(headingsOf("甲"));
    expect(() => validateToc(toc, headings)).not.toThrow();
    expect(toc[0]?.title).toBe("甲");
    expect(headings[0]?.text).toBe("甲");
  });

  it("同输入同输出(确定性)", () => {
    const toc = tocOf([
      [1, "甲"],
      [3, "丙"],
    ]);
    const headings = headingsOf("甲", "乙", "丙");
    expect(validateToc(toc, headings)).toEqual(validateToc(toc, headings));
  });
});

describe("extractHeadings", () => {
  const md = [
    "# 主标题",
    "",
    "## 第二章",
    "### 页一",
    "```",
    "## 假标题",
    "```",
    "## 第三章",
  ].join("\n");

  it("默认取 level 2/3 并跳过代码围栏", () => {
    const headings = extractHeadings(md);
    expect(headings.map((h) => h.text)).toEqual(["第二章", "页一", "第三章"]);
    expect(headings.map((h) => h.index)).toEqual([1, 2, 3]);
  });

  it("行号指回原文(1-based)", () => {
    const headings = extractHeadings(md);
    expect(headings.map((h) => h.line)).toEqual([3, 4, 8]);
  });

  it("自定义 levels 只取指定层级", () => {
    expect(extractHeadings(md, { levels: [3] }).map((h) => h.text)).toEqual(["页一"]);
  });

  it("标题尾部 # 被剥离", () => {
    expect(extractHeadings("## 标题 ##").map((h) => h.text)).toEqual(["标题"]);
  });

  it("目录节标题不计入正文标题,序号不偏移", () => {
    const headings = extractHeadings("# 主标题\n\n## 目录\n\n1. 第一章\n\n## 第一章\n");
    expect(headings.map((h) => h.text)).toEqual(["第一章"]);
    expect(headings[0]?.index).toBe(1);
  });
});

describe("契约元数据", () => {
  it("版本号是稳定字符串", () => {
    expect(OFFICE_ANCHOR_VERSION).toBe("1.0.0");
  });

  it("稳定码全集齐备", () => {
    expect(ANCHOR_CODES).toHaveLength(8);
    for (const code of [
      "OK",
      "INVALID",
      "NOT_FOUND",
      "AMBIGUOUS",
      "TOC_DRIFT",
      "TOC_DUPLICATE",
      "TOC_ORDER",
      "TOC_OUT_OF_RANGE",
    ]) {
      expect(ANCHOR_CODES).toContain(code);
    }
  });
});
