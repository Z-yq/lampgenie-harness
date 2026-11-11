import { describe, expect, it } from "vitest";
import {
  VIS_DEFAULT_THRESHOLDS,
  VIS_EMPTY_DECK,
  VIS_FAIL,
  VIS_INVALID,
  VIS_OK,
  VIS_QA_CODES,
  VIS_QA_VERSION,
  VIS_RULES,
  VIS_WARN,
  buildReviewRequest,
  contrastRatio,
  inspectDeck,
  parseColor,
  relativeLuminance,
  type PageGeometry,
  type Shape,
  type VisReport,
} from "../src/agent/office-visual-qa";

const PAGE_W = 960;
const PAGE_H = 540;

function makePage(shapes: Shape[], index = 1, width = PAGE_W, height = PAGE_H): PageGeometry {
  return { index, width, height, shapes };
}

/** 基线页:上半页一块中性灰(留白 50%),下半页一个对齐网格的正文字块 —— 体检应全绿。 */
function baselineShapes(): Shape[] {
  return [
    { kind: "shape", rect: { x: 0, y: 0, w: 960, h: 270 }, fill: "#808080" },
    { kind: "text", rect: { x: 36, y: 300, w: 400, h: 40 }, text: "正文段落", fontSizePt: 14, color: "#000000" },
  ];
}

function deck(...extra: Shape[]): PageGeometry[] {
  return [makePage([...baselineShapes(), ...extra])];
}

function single(...shapes: Shape[]): PageGeometry[] {
  return [makePage(shapes)];
}

function issuesOf(report: VisReport, ruleId: string) {
  return report.issues.filter((i) => i.ruleId === ruleId);
}

/** 对比度探针页:一块填色完全包住一个文本块(其余规则由各用例自行过滤)。 */
function contrastPage(bgFill: string, textOver: Partial<Shape> = {}): PageGeometry[] {
  return single(
    { kind: "shape", rect: { x: 30, y: 295, w: 260, h: 60 }, fill: bgFill },
    { kind: "text", rect: { x: 40, y: 300, w: 240, h: 50 }, text: "对比度", fontSizePt: 14, color: "#000000", ...textOver },
  );
}

describe("VIS 常量与契约", () => {
  it("版本号与稳定码顺序固定", () => {
    expect(VIS_QA_VERSION).toBe(1);
    expect(VIS_QA_CODES).toEqual(["VIS_OK", "VIS_INVALID", "VIS_EMPTY_DECK", "VIS_FAIL", "VIS_WARN"]);
    expect(VIS_OK).toBe("VIS_OK");
    expect(VIS_INVALID).toBe("VIS_INVALID");
    expect(VIS_EMPTY_DECK).toBe("VIS_EMPTY_DECK");
    expect(VIS_FAIL).toBe("VIS_FAIL");
    expect(VIS_WARN).toBe("VIS_WARN");
  });

  it("规则目录 11 条且 id/severity 稳定", () => {
    expect(VIS_RULES).toHaveLength(11);
    expect(VIS_RULES.map((r) => r.id)).toEqual([
      "VIS_EMPTY_PAGE",
      "VIS_OFF_CANVAS",
      "VIS_OVERLAP",
      "VIS_FONT_MIN",
      "VIS_HIERARCHY",
      "VIS_CONTRAST",
      "VIS_ACCENT_SHARE",
      "VIS_WHITESPACE",
      "VIS_IMAGE_DPI",
      "VIS_ALT_MISSING",
      "VIS_GRID_MISALIGN",
    ]);
    expect(VIS_RULES[0]?.severity).toBe("p0");
    expect(VIS_RULES.filter((r) => r.severity === "p2")).toHaveLength(5);
    for (const r of VIS_RULES) expect(r.title.length).toBeGreaterThan(4);
  });

  it("默认阈值与任务书逐项一致且被冻结", () => {
    expect(VIS_DEFAULT_THRESHOLDS).toEqual({
      minFontPt: 12,
      titleRatio: 1.6,
      largeFontPt: 18,
      boldLargeFontPt: 14,
      minContrast: 4.5,
      minContrastLarge: 3.0,
      maxOverlapShare: 0.25,
      offCanvasTolerancePt: 1,
      accentShareMaxPct: 20,
      hueMax: 8,
      whitespaceMaxPct: 85,
      whitespaceMinPct: 8,
      minImageDpi: 120,
      gridIn: 0.1,
      gridToleranceIn: 0.06,
      gridMisalignShareMaxPct: 30,
    });
    expect(Object.isFrozen(VIS_DEFAULT_THRESHOLDS)).toBe(true);
  });
});

describe("parseColor", () => {
  it("#rgb 三位缩写展开", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor("#0f8")).toEqual({ r: 0, g: 255, b: 136 });
  });

  it("#rrggbb 大小写不敏感", () => {
    expect(parseColor("#FF0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseColor("#0a0B0c")).toEqual({ r: 10, g: 11, b: 12 });
  });

  it("不带 # 的 6 位十六进制也接受", () => {
    expect(parseColor("ff8800")).toEqual({ r: 255, g: 136, b: 0 });
    expect(parseColor("001122")).toEqual({ r: 0, g: 17, b: 34 });
  });

  it("rgb() 逗号分隔", () => {
    expect(parseColor("rgb(1,2,3)")).toEqual({ r: 1, g: 2, b: 3 });
    expect(parseColor("RGB( 10 , 20 , 30 )")).toEqual({ r: 10, g: 20, b: 30 });
  });

  it("rgb() 空格分隔", () => {
    expect(parseColor("rgb(1 2 3)")).toEqual({ r: 1, g: 2, b: 3 });
    expect(parseColor("rgb( 255   128 0 )")).toEqual({ r: 255, g: 128, b: 0 });
  });

  it("首尾空白被忽略", () => {
    expect(parseColor("   #000000 ")).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("位数不对的十六进制返回 null", () => {
    expect(parseColor("#12345")).toBeNull();
    expect(parseColor("#1234567")).toBeNull();
    expect(parseColor("#12")).toBeNull();
  });

  it("分量越界或非整数的 rgb() 返回 null", () => {
    expect(parseColor("rgb(300,0,0)")).toBeNull();
    expect(parseColor("rgb(-1,0,0)")).toBeNull();
    expect(parseColor("rgb(1.5,0,0)")).toBeNull();
  });

  it("rgba/命名色/缺括号返回 null", () => {
    expect(parseColor("rgba(0,0,0,0.5)")).toBeNull();
    expect(parseColor("red")).toBeNull();
    expect(parseColor("rgb(1,2,3")).toBeNull();
    expect(parseColor("rgb(1,2)")).toBeNull();
  });

  it("非字符串与空串返回 null", () => {
    expect(parseColor(null)).toBeNull();
    expect(parseColor(undefined)).toBeNull();
    expect(parseColor(42)).toBeNull();
    expect(parseColor({ r: 1, g: 2, b: 3 })).toBeNull();
    expect(parseColor("")).toBeNull();
    expect(parseColor("   ")).toBeNull();
  });
});

describe("WCAG 亮度与对比度", () => {
  it("黑色相对亮度为 0、白色为 1", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 10);
  });

  it("黑白对比恰好 21:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 10);
  });

  it("相同颜色对比为 1,且交换入参结果不变", () => {
    expect(contrastRatio("#3366cc", "#3366cc")).toBeCloseTo(1, 10);
    expect(contrastRatio("#123456", "#fedcba")).toBeCloseTo(contrastRatio("#fedcba", "#123456"), 12);
  });

  it("入参非法时返回 1 而不是抛错", () => {
    expect(contrastRatio("nope", "#fff")).toBe(1);
    expect(contrastRatio("#fff", "rgb(999,0,0)")).toBe(1);
    expect(contrastRatio({ r: Number.NaN, g: 0, b: 0 }, "#fff")).toBe(1);
  });

  it("字符串入参与 RGB 对象入参等价", () => {
    expect(contrastRatio({ r: 0, g: 129, b: 135 }, "#000000")).toBeCloseTo(contrastRatio("#008187", "#000000"), 12);
    expect(contrastRatio("rgb(0,129,135)", "#000000")).toBeCloseTo(contrastRatio("#008187", "#000000"), 12);
  });
});

describe("对比度阈值边界(4.5:1)", () => {
  it("4.49 侧(实际 4.48996)判不合格", () => {
    const ratio = contrastRatio("#000000", "#008187");
    expect(ratio).toBeCloseTo(4.49, 2);
    expect(ratio).toBeLessThan(4.5);
    const report = inspectDeck(contrastPage("#008187"));
    expect(report.metrics.minContrast).toBeCloseTo(4.49, 2);
    expect(issuesOf(report, "VIS_CONTRAST")).toHaveLength(1);
    expect(issuesOf(report, "VIS_CONTRAST")[0]?.detail).toContain("4.5");
  });

  it("4.50 侧(实际 4.500001)判合格", () => {
    const ratio = contrastRatio("#000000", "#018374");
    expect(ratio).toBeCloseTo(4.5, 2);
    expect(ratio).toBeGreaterThan(4.5);
    const report = inspectDeck(contrastPage("#018374"));
    expect(report.metrics.minContrast).toBeCloseTo(4.5, 2);
    expect(issuesOf(report, "VIS_CONTRAST")).toHaveLength(0);
  });

  it("大字阈值 3.0:2.99 侧不合格", () => {
    const ratio = contrastRatio("#000000", "#016369");
    expect(ratio).toBeCloseTo(2.99, 2);
    const report = inspectDeck(contrastPage("#016369", { fontSizePt: 20 }));
    expect(issuesOf(report, "VIS_CONTRAST")).toHaveLength(1);
    expect(issuesOf(report, "VIS_CONTRAST")[0]?.detail).toContain("大字");
  });

  it("大字阈值 3.0:3.01 侧合格", () => {
    const ratio = contrastRatio("#000000", "#016276");
    expect(ratio).toBeCloseTo(3.01, 2);
    expect(issuesOf(inspectDeck(contrastPage("#016276", { fontSizePt: 20 })), "VIS_CONTRAST")).toHaveLength(0);
  });

  it("同一背景下非粗体 14pt 不合格、粗体 14pt(走大字阈值)合格", () => {
    expect(issuesOf(inspectDeck(contrastPage("#016276", { fontSizePt: 14 })), "VIS_CONTRAST")).toHaveLength(1);
    expect(
      issuesOf(inspectDeck(contrastPage("#016276", { fontSizePt: 14, bold: true })), "VIS_CONTRAST"),
    ).toHaveLength(0);
  });

  it("缺省色:前景按 #000000、背景按 #ffffff", () => {
    const report = inspectDeck(single({ kind: "text", rect: { x: 36, y: 300, w: 200, h: 40 }, text: "无颜色" }));
    expect(report.metrics.minContrast).toBeCloseTo(21, 6);
    expect(issuesOf(report, "VIS_CONTRAST")).toHaveLength(0);
  });

  it("浅灰字压白底被判不合格", () => {
    const report = inspectDeck(
      single({ kind: "text", rect: { x: 36, y: 300, w: 200, h: 40 }, text: "浅灰", color: "#cccccc" }),
    );
    expect(issuesOf(report, "VIS_CONTRAST")).toHaveLength(1);
  });

  it("颜色解析失败时跳过该 shape(不报 issue、不写 metrics)", () => {
    const report = inspectDeck(contrastPage("#008187", { color: "深灰" }));
    expect(issuesOf(report, "VIS_CONTRAST")).toHaveLength(0);
    expect(report.metrics.minContrast).toBeNull();
  });
});

describe("inspectDeck 非法入参与空 deck", () => {
  it("非数组入参折叠成 VIS_INVALID 且不抛错", () => {
    for (const bad of [null, undefined, 42, "pages", { pages: [] }]) {
      const report = inspectDeck(bad as unknown as PageGeometry[]);
      expect(report).toEqual({
        ok: false,
        code: VIS_INVALID,
        score: 0,
        verdict: "fail",
        issues: [],
        metrics: {
          pages: 0,
          shapes: 0,
          p0: 0,
          p1: 0,
          p2: 0,
          accentSharePct: 0,
          hueCount: 0,
          whitespacePct: 0,
          minFontPt: null,
          minContrast: null,
          minImageDpi: null,
          textBlocks: 0,
          gridMisalignSharePct: 0,
        },
      });
    }
  });

  it("页面缺 width/height 或形状非法时判 VIS_INVALID", () => {
    const cases: unknown[] = [
      [{}],
      [{ width: 960 }],
      [{ height: 540 }],
      [{ width: "960", height: 540 }],
      [{ width: 0, height: 540 }],
      [{ width: 960, height: -1 }],
      [null],
    ];
    for (const c of cases) {
      expect(inspectDeck(c as PageGeometry[]).code).toBe(VIS_INVALID);
    }
  });

  it("空数组折叠成 VIS_EMPTY_DECK", () => {
    const report = inspectDeck([]);
    expect(report.code).toBe(VIS_EMPTY_DECK);
    expect(report.verdict).toBe("fail");
    expect(report.ok).toBe(false);
    expect(report.score).toBe(0);
    expect(report.issues).toEqual([]);
    expect(report.metrics.pages).toBe(0);
  });

  it("非法入参不会被修改且不 throw", () => {
    const bad = [{ width: 960 }] as unknown as PageGeometry[];
    const snapshot = JSON.stringify(bad);
    expect(() => inspectDeck(bad)).not.toThrow();
    expect(JSON.stringify(bad)).toBe(snapshot);
  });
});

describe("inspectDeck 结论码与分数", () => {
  it("干净页 → VIS_OK / pass / 100 分", () => {
    const report = inspectDeck(deck());
    expect(report.code).toBe(VIS_OK);
    expect(report.verdict).toBe("pass");
    expect(report.ok).toBe(true);
    expect(report.score).toBe(100);
    expect(report.issues).toEqual([]);
    expect(report.metrics.pages).toBe(1);
    expect(report.metrics.shapes).toBe(2);
  });

  it("只有 p2 → VIS_WARN / warn / ok:true", () => {
    const report = inspectDeck(deck({ kind: "text", rect: { x: 36, y: 400, w: 200, h: 40 }, text: "小标题", fontSizePt: 14, color: "#000000", isTitle: true }));
    expect(report.code).toBe(VIS_WARN);
    expect(report.verdict).toBe("warn");
    expect(report.ok).toBe(true);
    expect(report.metrics.p0).toBe(0);
    expect(report.metrics.p1).toBe(0);
    expect(report.metrics.p2).toBeGreaterThan(0);
    expect(report.score).toBe(100 - 3 * report.metrics.p2);
  });

  it("含 p1 → VIS_FAIL / fail / ok:false,每条 p1 扣 8 分", () => {
    const report = inspectDeck(deck({ kind: "shape", rect: { x: 860, y: 100, w: 101.5, h: 100 }, fill: "#808080" }));
    expect(report.code).toBe(VIS_FAIL);
    expect(report.verdict).toBe("fail");
    expect(report.ok).toBe(false);
    expect(report.metrics.p1).toBeGreaterThanOrEqual(1);
    expect(report.score).toBe(100 - 25 * report.metrics.p0 - 8 * report.metrics.p1 - 3 * report.metrics.p2);
  });

  it("含 p0 → VIS_FAIL,空页同时触发留白 p2", () => {
    const report = inspectDeck(single());
    expect(report.code).toBe(VIS_FAIL);
    expect(report.metrics.p0).toBe(1);
    expect(report.metrics.p2).toBe(1);
    expect(report.score).toBe(72);
  });

  it("分数钳到 0..100 的整数区间", () => {
    const pages = [makePage([], 1), makePage([], 2), makePage([], 3), makePage([], 4), makePage([], 5)];
    const report = inspectDeck(pages);
    expect(report.score).toBe(0);
    expect(Number.isInteger(report.score)).toBe(true);
    expect(report.metrics.p0).toBe(5);
  });

  it("issues 排序稳定:page → severity → ruleId → shapeIndex", () => {
    const report = inspectDeck([
      makePage([{ kind: "shape", rect: { x: 860, y: 100, w: 101.5, h: 100 }, fill: "#808080" }], 2),
      makePage([], 1),
    ]);
    const keys = report.issues.map((i) => [i.page, i.severity, i.ruleId, i.shapeIndex ?? -1]);
    const sorted = [...keys].sort((a, b) => {
      if (a[0] !== b[0]) return (a[0] as number) - (b[0] as number);
      const rank: Record<string, number> = { p0: 0, p1: 1, p2: 2 };
      const sa = rank[a[1] as string] ?? 9;
      const sb = rank[b[1] as string] ?? 9;
      if (sa !== sb) return sa - sb;
      if (a[2] !== b[2]) return (a[2] as string) < (b[2] as string) ? -1 : 1;
      return (a[3] as number) - (b[3] as number);
    });
    expect(keys).toEqual(sorted);
  });
});

describe("VIS_EMPTY_PAGE", () => {
  it("没有任何 shape 的页判 p0", () => {
    const report = inspectDeck(single());
    const issues = issuesOf(report, "VIS_EMPTY_PAGE");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("p0");
    expect(issues[0]?.shapeIndex).toBeUndefined();
  });

  it("所有 shape 面积 ≤0 且无文本 → 空页", () => {
    const report = inspectDeck(single({ kind: "shape", rect: { x: 10, y: 10, w: 0, h: 0 } }));
    expect(issuesOf(report, "VIS_EMPTY_PAGE")).toHaveLength(1);
  });

  it("面积 0 但有文本 → 不算空页", () => {
    const report = inspectDeck(single({ kind: "text", rect: { x: 36, y: 300, w: 0, h: 0 }, text: "有字" }));
    expect(issuesOf(report, "VIS_EMPTY_PAGE")).toHaveLength(0);
  });

  it("有可见面积 → 不算空页", () => {
    expect(issuesOf(inspectDeck(deck()), "VIS_EMPTY_PAGE")).toHaveLength(0);
  });
});

describe("VIS_OFF_CANVAS", () => {
  it("恰好压线(超出 0pt)不报", () => {
    const report = inspectDeck(deck({ kind: "shape", rect: { x: 860, y: 100, w: 100, h: 100 }, fill: "#808080" }));
    expect(issuesOf(report, "VIS_OFF_CANVAS")).toHaveLength(0);
  });

  it("超出 1pt 以内(容差内)不报", () => {
    const report = inspectDeck(deck({ kind: "shape", rect: { x: 860, y: 100, w: 101, h: 100 }, fill: "#808080" }));
    expect(issuesOf(report, "VIS_OFF_CANVAS")).toHaveLength(0);
  });

  it("超出 1.5pt 报 p1", () => {
    const report = inspectDeck(deck({ kind: "shape", rect: { x: 860, y: 100, w: 101.5, h: 100 }, fill: "#808080" }));
    const issues = issuesOf(report, "VIS_OFF_CANVAS");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("p1");
    expect(issues[0]?.detail).toContain("右溢");
  });

  it("左侧越界 5pt 报 p1", () => {
    const report = inspectDeck(deck({ kind: "shape", rect: { x: -5, y: 100, w: 100, h: 100 }, fill: "#808080" }));
    const issues = issuesOf(report, "VIS_OFF_CANVAS");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.detail).toContain("左溢");
  });
});

describe("VIS_OVERLAP", () => {
  it("完全包含(含 0 容差相等矩形)不算重叠", () => {
    const report = inspectDeck(
      single(
        { kind: "shape", rect: { x: 100, y: 100, w: 300, h: 200 }, fill: "#808080" },
        { kind: "shape", rect: { x: 100, y: 100, w: 300, h: 200 }, fill: "#909090" },
        { kind: "shape", rect: { x: 150, y: 150, w: 100, h: 100 }, fill: "#707070" },
      ),
    );
    expect(issuesOf(report, "VIS_OVERLAP")).toHaveLength(0);
  });

  it("交叠恰为较小者 25% 不报(严格大于才算)", () => {
    const report = inspectDeck(
      single(
        { kind: "shape", rect: { x: 0, y: 0, w: 100, h: 100 }, fill: "#808080" },
        { kind: "shape", rect: { x: 75, y: 0, w: 100, h: 20 }, fill: "#909090" },
      ),
    );
    expect(issuesOf(report, "VIS_OVERLAP")).toHaveLength(0);
  });

  it("交叠 26% 报 p1", () => {
    const report = inspectDeck(
      single(
        { kind: "shape", rect: { x: 0, y: 0, w: 100, h: 100 }, fill: "#808080" },
        { kind: "shape", rect: { x: 74, y: 0, w: 100, h: 20 }, fill: "#909090" },
      ),
    );
    const issues = issuesOf(report, "VIS_OVERLAP");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("p1");
    expect(issues[0]?.detail).toContain("26%");
  });

  it("文本压图片排在图形压图形之前,且 detail 写明 kind 组合", () => {
    const report = inspectDeck(
      single(
        { kind: "shape", rect: { x: 100, y: 100, w: 100, h: 100 }, fill: "#808080" },
        { kind: "shape", rect: { x: 150, y: 100, w: 100, h: 100 }, fill: "#909090" },
        { kind: "image", rect: { x: 400, y: 100, w: 200, h: 200 }, imagePx: { w: 800, h: 800 }, altText: "示意图" },
        { kind: "text", rect: { x: 450, y: 150, w: 200, h: 100 }, text: "压图", fontSizePt: 14 },
      ),
    );
    const issues = issuesOf(report, "VIS_OVERLAP");
    expect(issues).toHaveLength(2);
    expect(issues[0]?.detail).toContain("(text)");
    expect(issues[0]?.detail).toContain("(image)");
    expect(issues[0]?.shapeIndex).toBe(3);
    expect(issues[1]?.detail).toContain("(shape)");
  });

  it("文本压文本也被判重叠", () => {
    const report = inspectDeck(
      single(
        { kind: "text", rect: { x: 100, y: 100, w: 200, h: 100 }, text: "甲", fontSizePt: 14 },
        { kind: "text", rect: { x: 150, y: 100, w: 200, h: 100 }, text: "乙", fontSizePt: 14 },
      ),
    );
    const issues = issuesOf(report, "VIS_OVERLAP");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.detail).toContain("(text)");
  });
});

describe("VIS_FONT_MIN", () => {
  it("11.9pt 小于下限 12pt → p1", () => {
    const report = inspectDeck(single({ kind: "text", rect: { x: 36, y: 300, w: 200, h: 40 }, text: "小字", fontSizePt: 11.9 }));
    const issues = issuesOf(report, "VIS_FONT_MIN");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("p1");
    expect(issues[0]?.detail).toContain("11.9");
  });

  it("12.1pt 不小于下限 → 不报", () => {
    const report = inspectDeck(single({ kind: "text", rect: { x: 36, y: 300, w: 200, h: 40 }, text: "正文", fontSizePt: 12.1 }));
    expect(issuesOf(report, "VIS_FONT_MIN")).toHaveLength(0);
  });

  it("缺 fontSizePt 的文本不参与(不瞎猜)", () => {
    const report = inspectDeck(single({ kind: "text", rect: { x: 36, y: 300, w: 200, h: 40 }, text: "未知字号" }));
    expect(issuesOf(report, "VIS_FONT_MIN")).toHaveLength(0);
    expect(report.metrics.minFontPt).toBeNull();
  });

  it("metrics.minFontPt 取全稿最小字号", () => {
    const report = inspectDeck(deck({ kind: "text", rect: { x: 36, y: 400, w: 200, h: 40 }, text: "脚注", fontSizePt: 9 }));
    expect(report.metrics.minFontPt).toBe(9);
  });
});

describe("VIS_HIERARCHY", () => {
  it("标题 14pt / 正文中位数 10pt(1.4 倍)→ p2", () => {
    const report = inspectDeck(
      single(
        { kind: "text", rect: { x: 36, y: 40, w: 300, h: 40 }, text: "标题", fontSizePt: 14, isTitle: true },
        { kind: "text", rect: { x: 36, y: 100, w: 300, h: 20 }, text: "段一", fontSizePt: 10 },
        { kind: "text", rect: { x: 36, y: 140, w: 300, h: 20 }, text: "段二", fontSizePt: 10 },
      ),
    );
    const issues = issuesOf(report, "VIS_HIERARCHY");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("p2");
    expect(issues[0]?.shapeIndex).toBe(0);
  });

  it("标题 20pt / 正文 10pt(2 倍)→ 不报", () => {
    const report = inspectDeck(
      single(
        { kind: "text", rect: { x: 36, y: 40, w: 300, h: 40 }, text: "标题", fontSizePt: 20, isTitle: true },
        { kind: "text", rect: { x: 36, y: 100, w: 300, h: 20 }, text: "段一", fontSizePt: 10 },
      ),
    );
    expect(issuesOf(report, "VIS_HIERARCHY")).toHaveLength(0);
  });

  it("正文取中位数(偶数个取中间两值平均)", () => {
    const report = inspectDeck(
      single(
        { kind: "text", rect: { x: 36, y: 40, w: 300, h: 40 }, text: "标题", fontSizePt: 16, isTitle: true },
        { kind: "text", rect: { x: 36, y: 100, w: 300, h: 20 }, text: "a", fontSizePt: 10 },
        { kind: "text", rect: { x: 36, y: 130, w: 300, h: 20 }, text: "b", fontSizePt: 10 },
        { kind: "text", rect: { x: 36, y: 160, w: 300, h: 20 }, text: "c", fontSizePt: 11 },
        { kind: "text", rect: { x: 36, y: 190, w: 300, h: 20 }, text: "d", fontSizePt: 11 },
      ),
    );
 // 中位数 10.5 → 需要 16.8pt,标题 16pt 不合格
    expect(issuesOf(report, "VIS_HIERARCHY")).toHaveLength(1);
  });

  it("没有正文文本时跳过(无从比较)", () => {
    const report = inspectDeck(single({ kind: "text", rect: { x: 36, y: 40, w: 300, h: 40 }, text: "只有标题", fontSizePt: 14, isTitle: true }));
    expect(issuesOf(report, "VIS_HIERARCHY")).toHaveLength(0);
  });

  it("没有 isTitle 时跳过", () => {
    expect(issuesOf(inspectDeck(deck()), "VIS_HIERARCHY")).toHaveLength(0);
  });
});

describe("VIS_ACCENT_SHARE", () => {
  it("高饱和填充覆盖 50% 页面 → p2 且 detail 给出占比", () => {
    const report = inspectDeck(single({ kind: "shape", rect: { x: 0, y: 0, w: 960, h: 270 }, fill: "#ff0000" }));
    const issues = issuesOf(report, "VIS_ACCENT_SHARE");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("p2");
    expect(issues[0]?.detail).toContain("50%");
    expect(report.metrics.accentSharePct).toBeCloseTo(50, 6);
  });

  it("高饱和填充占比在 20% 以内 → 不报", () => {
    const report = inspectDeck(single({ kind: "shape", rect: { x: 0, y: 0, w: 960, h: 80 }, fill: "#ff0000" }));
    expect(issuesOf(report, "VIS_ACCENT_SHARE")).toHaveLength(0);
  });

  it("填充色相桶 9 个(>8)→ p2,metrics.hueCount=9", () => {
    const fills = ["#ff0000", "#ff8000", "#ffff00", "#7fff00", "#00ff00", "#00ff80", "#00ffff", "#007fff", "#0000ff"];
    const shapes: Shape[] = fills.map((fill, i) => ({ kind: "shape", rect: { x: 100, y: 20 + i * 40, w: 60, h: 30 }, fill }));
    const report = inspectDeck(single(...shapes));
    expect(report.metrics.hueCount).toBe(9);
    expect(issuesOf(report, "VIS_ACCENT_SHARE")).toHaveLength(1);
  });

  it("填充色相桶恰好 8 个 → 不报", () => {
    const fills = ["#ff0000", "#ff8000", "#ffff00", "#7fff00", "#00ff00", "#00ff80", "#00ffff", "#007fff"];
    const shapes: Shape[] = fills.map((fill, i) => ({ kind: "shape", rect: { x: 100, y: 20 + i * 40, w: 60, h: 30 }, fill }));
    const report = inspectDeck(single(...shapes));
    expect(report.metrics.hueCount).toBe(8);
    expect(issuesOf(report, "VIS_ACCENT_SHARE")).toHaveLength(0);
  });

  it("中性灰填充既不算强调色也不计入色相桶", () => {
    const report = inspectDeck(deck());
    expect(report.metrics.accentSharePct).toBe(0);
    expect(report.metrics.hueCount).toBe(0);
  });
});

describe("VIS_WHITESPACE", () => {
  it("几乎全空(>85%)→ p2", () => {
    const report = inspectDeck(single({ kind: "shape", rect: { x: 0, y: 0, w: 100, h: 100 }, fill: "#808080" }));
    expect(report.metrics.whitespacePct).toBeGreaterThan(85);
    expect(issuesOf(report, "VIS_WHITESPACE")).toHaveLength(1);
    expect(issuesOf(report, "VIS_WHITESPACE")[0]?.detail).toContain("%");
  });

  it("几乎填满(<8%)→ p2", () => {
    const report = inspectDeck(single({ kind: "shape", rect: { x: 0, y: 0, w: 960, h: 510 }, fill: "#808080" }));
    expect(report.metrics.whitespacePct).toBeLessThan(8);
    expect(issuesOf(report, "VIS_WHITESPACE")).toHaveLength(1);
  });

  it("正常留白不报,metrics 保留两位小数", () => {
    const report = inspectDeck(deck());
    expect(issuesOf(report, "VIS_WHITESPACE")).toHaveLength(0);
    expect(report.metrics.whitespacePct).toBeGreaterThan(8);
    expect(report.metrics.whitespacePct).toBeLessThan(85);
    expect(Math.round(report.metrics.whitespacePct * 100)).toBeCloseTo(report.metrics.whitespacePct * 100, 6);
  });
});

describe("VIS_IMAGE_DPI", () => {
  const image = (imagePx: Shape["imagePx"], rectW = 100): Shape => ({
    kind: "image",
    rect: { x: 36, y: 300, w: rectW, h: 80 },
    imagePx,
    altText: "示意图",
  });

  it("160px / 100pt(1.3889in)= 115dpi → 不合格", () => {
    const report = inspectDeck(single(image({ w: 160, h: 160 })));
    const issues = issuesOf(report, "VIS_IMAGE_DPI");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.detail).toContain("115");
    expect(report.metrics.minImageDpi).toBeCloseTo(115.2, 1);
  });

  it("200px / 100pt = 144dpi → 合格", () => {
    const report = inspectDeck(single(image({ w: 200, h: 200 })));
    expect(issuesOf(report, "VIS_IMAGE_DPI")).toHaveLength(0);
    expect(report.metrics.minImageDpi).toBeCloseTo(144, 1);
  });

  it("缺 imagePx 的图片跳过 DPI 判定", () => {
    const report = inspectDeck(single(image(undefined)));
    expect(issuesOf(report, "VIS_IMAGE_DPI")).toHaveLength(0);
    expect(report.metrics.minImageDpi).toBeNull();
  });
});

describe("VIS_ALT_MISSING", () => {
  it("缺失 altText → p1", () => {
    const report = inspectDeck(single({ kind: "image", rect: { x: 36, y: 300, w: 100, h: 80 }, imagePx: { w: 500, h: 400 } }));
    const issues = issuesOf(report, "VIS_ALT_MISSING");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("p1");
  });

  it("纯空白 altText 也算缺失", () => {
    const report = inspectDeck(
      single({ kind: "image", rect: { x: 36, y: 300, w: 100, h: 80 }, imagePx: { w: 500, h: 400 }, altText: "   " }),
    );
    expect(issuesOf(report, "VIS_ALT_MISSING")).toHaveLength(1);
  });

  it("有 altText → 不报", () => {
    const report = inspectDeck(
      single({ kind: "image", rect: { x: 36, y: 300, w: 100, h: 80 }, imagePx: { w: 500, h: 400 }, altText: "季度趋势" }),
    );
    expect(issuesOf(report, "VIS_ALT_MISSING")).toHaveLength(0);
  });
});

describe("VIS_GRID_MISALIGN", () => {
  const blocks = (xOf: (i: number) => number): Shape[] =>
    Array.from({ length: 10 }, (_, i) => ({
      kind: "text" as const,
      rect: { x: xOf(i), y: 20 + i * 45, w: 100, h: 30 },
      text: `块${i}`,
      fontSizePt: 14,
      color: "#000000",
    }));

 // 默认容差 4.32pt 是半格(3.6pt)的 1.2 倍,默认下任何左边缘都"最近网格";这里收紧到 0.02in 才能测两侧。
  const opts = { thresholds: { gridToleranceIn: 0.02 } };

  it("全部对齐网格 → 不报", () => {
    const report = inspectDeck(single(...blocks(() => 36)), opts);
    expect(issuesOf(report, "VIS_GRID_MISALIGN")).toHaveLength(0);
    expect(report.metrics.gridMisalignSharePct).toBe(0);
  });

  it("偏离 3/10 = 30%(不超上限)→ 不报", () => {
    const report = inspectDeck(single(...blocks((i) => (i < 3 ? 38 : 36))), opts);
    expect(report.metrics.gridMisalignSharePct).toBe(30);
    expect(issuesOf(report, "VIS_GRID_MISALIGN")).toHaveLength(0);
  });

  it("偏离 4/10 = 40%(超上限)→ p2", () => {
    const report = inspectDeck(single(...blocks((i) => (i < 4 ? 38 : 36))), opts);
    expect(report.metrics.gridMisalignSharePct).toBe(40);
    expect(issuesOf(report, "VIS_GRID_MISALIGN")).toHaveLength(1);
    expect(issuesOf(report, "VIS_GRID_MISALIGN")[0]?.detail).toContain("40%");
  });

  it("没有文本块时跳过", () => {
    const report = inspectDeck(single({ kind: "shape", rect: { x: 0, y: 0, w: 960, h: 270 }, fill: "#808080" }), opts);
    expect(issuesOf(report, "VIS_GRID_MISALIGN")).toHaveLength(0);
    expect(report.metrics.textBlocks).toBe(0);
    expect(report.metrics.gridMisalignSharePct).toBe(0);
  });
});

describe("阈值覆盖与确定性", () => {
  it("opts 覆盖 minFontPt 生效", () => {
    const page = single({ kind: "text", rect: { x: 36, y: 300, w: 200, h: 40 }, text: "正文", fontSizePt: 14 });
    expect(issuesOf(inspectDeck(page), "VIS_FONT_MIN")).toHaveLength(0);
    expect(issuesOf(inspectDeck(page, { thresholds: { minFontPt: 20 } }), "VIS_FONT_MIN")).toHaveLength(1);
  });

  it("opts 覆盖 offCanvasTolerancePt 生效", () => {
    const page = deck({ kind: "shape", rect: { x: 860, y: 100, w: 100.5, h: 100 }, fill: "#808080" });
    expect(issuesOf(inspectDeck(page), "VIS_OFF_CANVAS")).toHaveLength(0);
    expect(issuesOf(inspectDeck(page, { thresholds: { offCanvasTolerancePt: 0.1 } }), "VIS_OFF_CANVAS")).toHaveLength(1);
  });

  it("opts 覆盖 maxOverlapShare 生效", () => {
    const page: PageGeometry[] = single(
      { kind: "shape", rect: { x: 0, y: 0, w: 100, h: 100 }, fill: "#808080" },
      { kind: "shape", rect: { x: 74, y: 0, w: 100, h: 20 }, fill: "#909090" },
    );
    expect(issuesOf(inspectDeck(page), "VIS_OVERLAP")).toHaveLength(1);
    expect(issuesOf(inspectDeck(page, { thresholds: { maxOverlapShare: 0.5 } }), "VIS_OVERLAP")).toHaveLength(0);
  });

  it("opts 覆盖 minContrast 与 whitespaceMaxPct 生效", () => {
    const contrast = contrastPage("#018374");
    expect(issuesOf(inspectDeck(contrast, { thresholds: { minContrast: 22 } }), "VIS_CONTRAST")).toHaveLength(1);
    const clean = deck();
    expect(issuesOf(inspectDeck(clean), "VIS_WHITESPACE")).toHaveLength(0);
    expect(issuesOf(inspectDeck(clean, { thresholds: { whitespaceMaxPct: 40 } }), "VIS_WHITESPACE")).toHaveLength(1);
  });

  it("opts 传入非法值时回落默认值", () => {
    const report = inspectDeck(deck(), { thresholds: { minFontPt: Number.NaN, titleRatio: "x" as unknown as number } });
    expect(report.code).toBe(VIS_OK);
  });

  it("同输入跑两次 JSON 深相等", () => {
    const pages = deck(
      { kind: "text", rect: { x: 36, y: 400, w: 200, h: 40 }, text: "标题", fontSizePt: 14, isTitle: true },
      { kind: "image", rect: { x: 36, y: 200, w: 100, h: 80 }, imagePx: { w: 100, h: 100 } },
    );
    expect(JSON.stringify(inspectDeck(pages))).toBe(JSON.stringify(inspectDeck(pages)));
  });

  it("不修改入参(深比较快照不变)", () => {
    const pages = deck({ kind: "shape", rect: { x: 860, y: 100, w: 101.5, h: 100 }, fill: "#ff0000" });
    const snapshot = JSON.stringify(pages);
    inspectDeck(pages);
    expect(JSON.stringify(pages)).toBe(snapshot);
  });
});

describe("buildReviewRequest", () => {
  const pages = [makePage([{ kind: "text", rect: { x: 36, y: 300, w: 200, h: 40 }, text: "甲" }], 7), makePage([], 3)];

  it("逐页出现,page 用 PageGeometry.index,png 有则 ready、无则 pending", () => {
    const req = buildReviewRequest({ pages, pngPaths: ["/tmp/p7.png"] });
    expect(req.perPage).toEqual([
      { page: 7, png: "/tmp/p7.png", status: "ready" },
      { page: 3, status: "pending" },
    ]);
    expect(req.pendingCount).toBe(1);
  });

  it("pngPaths 缺失时全部 pending,绝不假装已评审", () => {
    const req = buildReviewRequest({ pages });
    expect(req.perPage.map((p) => p.status)).toEqual(["pending", "pending"]);
    expect(req.pendingCount).toBe(2);
    expect(req.perPage.every((p) => p.png === undefined)).toBe(true);
  });

  it("空字符串路径按 pending 处理", () => {
    const req = buildReviewRequest({ pages, pngPaths: ["  ", "/tmp/p3.png"] });
    expect(req.perPage[0]?.status).toBe("pending");
    expect(req.perPage[1]?.status).toBe("ready");
    expect(req.pendingCount).toBe(1);
  });

  it("prompt 含固定中文评审要求与缺失页的『未提供 PNG,不要臆测』", () => {
    const req = buildReviewRequest({ pages, pngPaths: ["/tmp/p7.png"] });
    expect(req.prompt).toContain("重叠");
    expect(req.prompt).toContain("越界");
    expect(req.prompt).toContain("对比度");
    expect(req.prompt).toContain("层级");
    expect(req.prompt).toContain("留白");
    expect(req.prompt).toContain("图片质量");
    expect(req.prompt).toContain("未提供 PNG");
    expect(req.prompt).toContain("不要臆测");
    expect(req.prompt).toContain("第 3 页");
  });

  it("全页都有 PNG 时 prompt 明确要求逐页对照", () => {
    const req = buildReviewRequest({ pages, pngPaths: ["/tmp/a.png", "/tmp/b.png"] });
    expect(req.pendingCount).toBe(0);
    expect(req.prompt).toContain("全部页面均已提供 PNG");
    expect(req.prompt).not.toContain("不要臆测");
  });

  it("machineVerdict 为报告时点名机器已报的 ruleId 并给出稳定摘要", () => {
    const report = inspectDeck([makePage([], 1)]);
    const req = buildReviewRequest({ pages, pngPaths: ["/tmp/a.png", "/tmp/b.png"], machineVerdict: report });
    expect(req.prompt).toContain("VIS_EMPTY_PAGE");
    expect(req.prompt).toContain("VIS_WHITESPACE");
    expect(req.machineSummary).toBe("code=VIS_FAIL verdict=fail score=72 p0=1 p1=0 p2=1");
  });

  it("machineVerdict 为字符串时按其码记录摘要", () => {
    const req = buildReviewRequest({ pages, machineVerdict: "VIS_WARN" });
    expect(req.machineSummary).toBe("code=VIS_WARN verdict=n/a score=0 p0=0 p1=0 p2=0");
    expect(req.prompt).toContain("VIS_WARN");
  });

  it("没有 machineVerdict 时给出明确占位而不是编造数字", () => {
    const req = buildReviewRequest({ pages });
    expect(req.machineSummary).toBe("code=VIS_UNKNOWN verdict=n/a score=0 p0=0 p1=0 p2=0");
    expect(req.prompt).toContain("(机器未报具体规则)");
  });

  it("非法入参不 throw、不改入参、同输入同输出", () => {
    expect(() => buildReviewRequest(null as unknown as { pages: PageGeometry[] })).not.toThrow();
    expect(buildReviewRequest(null as unknown as { pages: PageGeometry[] }).perPage).toEqual([]);
    const snapshot = JSON.stringify(pages);
    const a = buildReviewRequest({ pages, pngPaths: ["/tmp/a.png"] });
    const b = buildReviewRequest({ pages, pngPaths: ["/tmp/a.png"] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(pages)).toBe(snapshot);
  });
});

describe("页面底色参与对比度判定", () => {
 /** 显式构造单页(底色只在给值时才写,避免用 undefined 冒充「页面没有底色」)。 */
  function pageWithBg(shapes: Shape[], background?: string): PageGeometry[] {
    const page: PageGeometry = { index: 1, width: 960, height: 540, shapes };
    return [background === undefined ? page : { ...page, background }];
  }
  const lightOnDark = (): Shape[] => [
    { kind: "text", rect: { x: 40, y: 40, w: 400, h: 60 }, text: "深底浅字", fontSizePt: 18, color: "#edeae2" },
  ];

  it("深色页面底色上的浅色字不报 VIS_CONTRAST(白底假设会误判)", () => {
    const report = inspectDeck(pageWithBg(lightOnDark(), "#0e100f"));
    expect(issuesOf(report, "VIS_CONTRAST")).toHaveLength(0);
    expect(report.metrics.minContrast!).toBeGreaterThan(10);
  });

  it("同一几何缺页面底色时按白底判,报 1 条 VIS_CONTRAST(缺省不静默放过)", () => {
    const report = inspectDeck(pageWithBg(lightOnDark()));
    const issues = issuesOf(report, "VIS_CONTRAST");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.detail).toContain("#ffffff");
  });

  it("覆盖该文本的 shape 填充优先于页面底色", () => {
    const shapes: Shape[] = [
      { kind: "shape", rect: { x: 20, y: 20, w: 600, h: 200 }, fill: "#ffffff" },
      ...lightOnDark(),
    ];
    const report = inspectDeck(pageWithBg(shapes, "#0e100f"));
    expect(issuesOf(report, "VIS_CONTRAST")).toHaveLength(1);
    expect(issuesOf(report, "VIS_CONTRAST")[0]?.detail).toContain("#ffffff");
  });

  it("底色为空串/非法色时退回白底假设,不 throw", () => {
    for (const bg of ["", "   ", "nope", "#12"]) {
      const report = inspectDeck(pageWithBg(lightOnDark(), bg));
      expect(report.metrics.pages).toBe(1);
      expect(issuesOf(report, "VIS_CONTRAST")).toHaveLength(1);
    }
  });

  it("带底色的页面同样确定性:两次结果逐字相等", () => {
    const a = inspectDeck(pageWithBg(lightOnDark(), "#0e100f"));
    const b = inspectDeck(pageWithBg(lightOnDark(), "#0e100f"));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
