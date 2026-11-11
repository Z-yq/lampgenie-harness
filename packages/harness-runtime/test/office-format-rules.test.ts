/**
 * Office 格式级业务规则检查(# 纯逻辑):规则表 / 四类 facts 校验 / 每条规则真·假两态 /
 * 计数与 verdict / 非法入参 / 确定性 / 不可变。
 * 全部直测纯函数:不碰文件系统、不读时钟、不读环境(夹具就是普通对象)。
 */
import { describe, expect, it } from "vitest";
import {
  FORMAT_CODES,
  FORMAT_FAIL,
  FORMAT_INVALID,
  FORMAT_OK,
  FORMAT_RULES,
  FORMAT_RULE_IDS,
  FORMAT_RULES_VERSION,
  FORMAT_WARN,
  checkAll,
  checkDocx,
  checkPdf,
  checkPptx,
  checkXlsx,
  parseDimension,
} from "../src/agent/office-format-rules";
import type {
  DocxFacts,
  FormatReport,
  FormatRuleId,
  PdfFacts,
  PptxFacts,
  XlsxFacts,
} from "../src/agent/office-format-rules";

/** 断言辅助:取 issue 的 ruleId 列表。 */
const ids = (r: FormatReport): string[] => r.issues.map((i) => i.ruleId);

/** 断言辅助:某 ruleId 是否命中。 */
const hit = (r: FormatReport, ruleId: string): boolean => ids(r).includes(ruleId);

/** 深度冻结:验证实现不修改入参(冻结后若写入会在严格模式下抛错)。 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

const docxFacts = (patch: Partial<DocxFacts> = {}): DocxFacts => ({
  tables: [],
  images: [],
  headings: 0,
  ...patch,
});

const xlsxFacts = (patch: Partial<XlsxFacts> = {}): XlsxFacts => ({
  sheets: [{ name: "Sheet1", formulaCells: 0, cachedFormulaCells: 0, freezePane: true, printTitles: true }],
  ...patch,
});

const pptxFacts = (patch: Partial<PptxFacts> = {}): PptxFacts => ({ slides: [], ...patch });

const pdfFacts = (patch: Partial<PdfFacts> = {}): PdfFacts => ({
  headerOk: true,
  eofOk: true,
  encrypted: false,
  pageCount: 3,
  ...patch,
});

// ---------------------------------------------------------------------------
// 规则表与稳定码
// ---------------------------------------------------------------------------

describe("规则表与稳定码", () => {
  it("FORMAT_RULES_VERSION 是正整数", () => {
    expect(FORMAT_RULES_VERSION).toBe(1);
  });

  it("FORMAT_CODES 含四个稳定码且顺序固定", () => {
    expect(FORMAT_CODES).toEqual([FORMAT_OK, FORMAT_INVALID, FORMAT_FAIL, FORMAT_WARN]);
  });

  it("FORMAT_RULE_IDS 至少 11 条且无重复", () => {
    expect(FORMAT_RULE_IDS.length).toBeGreaterThanOrEqual(11);
    expect(new Set(FORMAT_RULE_IDS).size).toBe(FORMAT_RULE_IDS.length);
  });

  it("11 条必需规则全部登记", () => {
    const required = [
      "FMT_DOCX_TBL_HEADER_REPEAT",
      "FMT_DOCX_ROW_CANT_SPLIT",
      "FMT_DOCX_IMAGE_ALT",
      "FMT_XLSX_FORMULA_CACHED",
      "FMT_XLSX_FREEZE_PANE",
      "FMT_XLSX_PRINT_TITLES",
      "FMT_PPTX_TITLE_MISSING",
      "FMT_PPTX_ALT_TEXT",
      "FMT_PDF_ENCRYPTED",
      "FMT_PDF_TRUNCATED",
      "FMT_PDF_NO_PAGES",
    ];
    for (const id of required) expect(FORMAT_RULE_IDS).toContain(id as FormatRuleId);
  });

  it("页数未知规则(FMT_PDF_PAGE_SCAN_UNKNOWN)登记为 p2", () => {
    expect(FORMAT_RULE_IDS).toContain("FMT_PDF_PAGE_SCAN_UNKNOWN");
    expect(FORMAT_RULES.FMT_PDF_PAGE_SCAN_UNKNOWN.severity).toBe("p2");
  });

  const EXPECTED_SEVERITY: Record<string, "p0" | "p1" | "p2"> = {
    FMT_DOCX_TBL_HEADER_REPEAT: "p1",
    FMT_DOCX_ROW_CANT_SPLIT: "p2",
    FMT_DOCX_IMAGE_ALT: "p1",
    FMT_XLSX_FORMULA_CACHED: "p0",
    FMT_XLSX_FREEZE_PANE: "p2",
    FMT_XLSX_PRINT_TITLES: "p2",
    FMT_PPTX_TITLE_MISSING: "p1",
    FMT_PPTX_ALT_TEXT: "p1",
    FMT_PDF_ENCRYPTED: "p0",
    FMT_PDF_TRUNCATED: "p0",
    FMT_PDF_NO_PAGES: "p0",
  };
  for (const [ruleId, severity] of Object.entries(EXPECTED_SEVERITY)) {
    it(`规则 ${ruleId} 严重度=${severity}`, () => {
      expect(FORMAT_RULES[ruleId as FormatRuleId].severity).toBe(severity);
    });
  }
});

// ---------------------------------------------------------------------------
// docx
// ---------------------------------------------------------------------------

describe("checkDocx", () => {
  it("多行表格首行未设 tblHeader → 命中 p1", () => {
    const r = checkDocx(docxFacts({ tables: [{ index: 0, rows: 3, cols: 2, firstRowHeaderRepeat: false, cantSplitRows: 3 }] }));
    expect(hit(r, "FMT_DOCX_TBL_HEADER_REPEAT")).toBe(true);
    expect(r.counts).toEqual({ p0: 0, p1: 1, p2: 0 });
    expect(r.verdict).toBe("warn");
    expect(r.code).toBe(FORMAT_WARN);
    expect(r.issues[0]?.location).toBe("docx.table[0]");
  });

  it("多行表格首行已设 tblHeader → 不命中", () => {
    const r = checkDocx(docxFacts({ tables: [{ index: 0, rows: 3, cols: 2, firstRowHeaderRepeat: true, cantSplitRows: 3 }] }));
    expect(hit(r, "FMT_DOCX_TBL_HEADER_REPEAT")).toBe(false);
    expect(r.verdict).toBe("pass");
    expect(r.code).toBe(FORMAT_OK);
  });

  it("单行表格不报 header 规则(没有跨页重复的意义)", () => {
    const r = checkDocx(docxFacts({ tables: [{ index: 0, rows: 1, cols: 2, firstRowHeaderRepeat: false, cantSplitRows: 1 }] }));
    expect(r.issues).toHaveLength(0);
  });

  it("rows=5 且 cantSplitRows=0 → 命中 p2", () => {
    const r = checkDocx(docxFacts({ tables: [{ index: 1, rows: 5, cols: 2, firstRowHeaderRepeat: true, cantSplitRows: 0 }] }));
    expect(hit(r, "FMT_DOCX_ROW_CANT_SPLIT")).toBe(true);
    expect(r.counts).toEqual({ p0: 0, p1: 0, p2: 1 });
    expect(r.issues[0]?.location).toBe("docx.table[1]");
  });

  it("rows=5 且全部 cantSplit → 不命中", () => {
    const r = checkDocx(docxFacts({ tables: [{ index: 0, rows: 5, cols: 2, firstRowHeaderRepeat: true, cantSplitRows: 5 }] }));
    expect(hit(r, "FMT_DOCX_ROW_CANT_SPLIT")).toBe(false);
  });

  it("rows=4 且未设 cantSplit → 不命中(阈值 rows≥5)", () => {
    const r = checkDocx(docxFacts({ tables: [{ index: 0, rows: 4, cols: 2, firstRowHeaderRepeat: true, cantSplitRows: 0 }] }));
    expect(hit(r, "FMT_DOCX_ROW_CANT_SPLIT")).toBe(false);
  });

  it("rows=6 且只设 3 行 cantSplit → 命中且描述缺的行数", () => {
    const r = checkDocx(docxFacts({ tables: [{ index: 0, rows: 6, cols: 2, firstRowHeaderRepeat: true, cantSplitRows: 3 }] }));
    const found = r.issues.find((i) => i.ruleId === "FMT_DOCX_ROW_CANT_SPLIT");
    expect(found).toBeDefined();
    expect(found?.message).toContain("3 行未禁止跨页断行");
  });

  it("同一张表格同时缺 tblHeader 与 cantSplit → 两条 issue", () => {
    const r = checkDocx(docxFacts({ tables: [{ index: 0, rows: 8, cols: 3, firstRowHeaderRepeat: false, cantSplitRows: 0 }] }));
    expect(ids(r)).toEqual(["FMT_DOCX_TBL_HEADER_REPEAT", "FMT_DOCX_ROW_CANT_SPLIT"]);
    expect(r.counts).toEqual({ p0: 0, p1: 1, p2: 1 });
  });

  it("图片缺 altText → 命中 p1", () => {
    const r = checkDocx(docxFacts({ images: [{ index: 2 }] }));
    expect(hit(r, "FMT_DOCX_IMAGE_ALT")).toBe(true);
    expect(r.issues[0]?.location).toBe("docx.image[2]");
  });

  it("图片 altText 为空串 → 视为缺失", () => {
    const r = checkDocx(docxFacts({ images: [{ index: 0, altText: "" }] }));
    expect(hit(r, "FMT_DOCX_IMAGE_ALT")).toBe(true);
  });

  it("图片 altText 为纯空白 → 视为缺失", () => {
    const r = checkDocx(docxFacts({ images: [{ index: 0, altText: "   " }] }));
    expect(hit(r, "FMT_DOCX_IMAGE_ALT")).toBe(true);
  });

  it("图片有 altText → 不命中", () => {
    const r = checkDocx(docxFacts({ images: [{ index: 0, altText: "架构图" }], headings: 4 }));
    expect(r.issues).toHaveLength(0);
    expect(r.verdict).toBe("pass");
  });

  it("空 docx facts → pass / counts 全 0", () => {
    const r = checkDocx(docxFacts());
    expect(r).toMatchObject({ code: FORMAT_OK, ok: true, verdict: "pass" });
    expect(r.counts).toEqual({ p0: 0, p1: 0, p2: 0 });
  });

  it("非法 docx(null) → FORMAT_INVALID 且不 throw", () => {
    expect(() => checkDocx(null)).not.toThrow();
    const r = checkDocx(null);
    expect(r.code).toBe(FORMAT_INVALID);
    expect(r.verdict).toBe("fail");
    expect(r.counts).toEqual({ p0: 1, p1: 0, p2: 0 });
  });

  it("非法 docx(tables 缺失) → FORMAT_INVALID", () => {
    expect(checkDocx({ images: [], headings: 0 }).code).toBe(FORMAT_INVALID);
  });

  it("非法 docx(cantSplitRows > rows) → FORMAT_INVALID", () => {
    const r = checkDocx(docxFacts({ tables: [{ index: 0, rows: 2, cols: 1, firstRowHeaderRepeat: true, cantSplitRows: 3 }] }));
    expect(r.code).toBe(FORMAT_INVALID);
  });

  it("非法 docx(headings 为负) → FORMAT_INVALID", () => {
    expect(checkDocx({ tables: [], images: [], headings: -1 }).code).toBe(FORMAT_INVALID);
  });
});

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------

describe("checkXlsx", () => {
  it("公式无缓存值 → 命中 p0 且 verdict=fail", () => {
    const r = checkXlsx(xlsxFacts({ sheets: [{ name: "S1", formulaCells: 6, cachedFormulaCells: 0, freezePane: true, printTitles: true }] }));
    expect(hit(r, "FMT_XLSX_FORMULA_CACHED")).toBe(true);
    expect(r.verdict).toBe("fail");
    expect(r.code).toBe(FORMAT_FAIL);
    expect(r.ok).toBe(false);
  });

  it("公式全有缓存 → 不命中", () => {
    const r = checkXlsx(xlsxFacts({ sheets: [{ name: "S1", formulaCells: 6, cachedFormulaCells: 6, freezePane: true, printTitles: true }] }));
    expect(r.issues).toHaveLength(0);
  });

  it("没有公式单元格 → 不命中", () => {
    const r = checkXlsx(xlsxFacts({ sheets: [{ name: "S1", formulaCells: 0, cachedFormulaCells: 0, freezePane: true, printTitles: true }] }));
    expect(r.issues).toHaveLength(0);
  });

  it("部分缓存缺失 → 描述给出缺失数量", () => {
    const r = checkXlsx(xlsxFacts({ sheets: [{ name: "S1", formulaCells: 10, cachedFormulaCells: 7, freezePane: true, printTitles: true }] }));
    const found = r.issues.find((i) => i.ruleId === "FMT_XLSX_FORMULA_CACHED");
    expect(found?.message).toContain("3 个");
    expect(found?.location).toBe("xlsx.sheet[S1]");
  });

  it("逐 sheet 计数:两个 sheet 都缺缓存 → 两条 issue", () => {
    const r = checkXlsx({
      sheets: [
        { name: "A", formulaCells: 2, cachedFormulaCells: 0, freezePane: true, printTitles: true },
        { name: "B", formulaCells: 1, cachedFormulaCells: 0, freezePane: true, printTitles: true },
      ],
    });
    expect(ids(r).filter((id) => id === "FMT_XLSX_FORMULA_CACHED")).toHaveLength(2);
    expect(r.counts.p0).toBe(2);
  });

  it("31 行且无冻结窗格 → 命中 p2", () => {
    const r = checkXlsx(xlsxFacts({ sheets: [{ name: "S1", formulaCells: 0, cachedFormulaCells: 0, freezePane: false, printTitles: true, dimension: "A1:C31" }] }));
    expect(hit(r, "FMT_XLSX_FREEZE_PANE")).toBe(true);
    expect(r.counts.p2).toBe(1);
  });

  it("30 行且无冻结窗格 → 不命中(阈值 >30)", () => {
    const r = checkXlsx(xlsxFacts({ sheets: [{ name: "S1", formulaCells: 0, cachedFormulaCells: 0, freezePane: false, printTitles: true, dimension: "A1:C30" }] }));
    expect(hit(r, "FMT_XLSX_FREEZE_PANE")).toBe(false);
  });

  it("31 行但已冻结窗格 → 不命中", () => {
    const r = checkXlsx(xlsxFacts({ sheets: [{ name: "S1", formulaCells: 0, cachedFormulaCells: 0, freezePane: true, printTitles: true, dimension: "A1:C31" }] }));
    expect(hit(r, "FMT_XLSX_FREEZE_PANE")).toBe(false);
  });

  it("7 列且无打印标题 → 命中 p2", () => {
    const r = checkXlsx(xlsxFacts({ sheets: [{ name: "S1", formulaCells: 0, cachedFormulaCells: 0, freezePane: true, printTitles: false, dimension: "A1:G5" }] }));
    expect(hit(r, "FMT_XLSX_PRINT_TITLES")).toBe(true);
  });

  it("6 列且无打印标题 → 不命中(阈值 >6)", () => {
    const r = checkXlsx(xlsxFacts({ sheets: [{ name: "S1", formulaCells: 0, cachedFormulaCells: 0, freezePane: true, printTitles: false, dimension: "A1:F5" }] }));
    expect(hit(r, "FMT_XLSX_PRINT_TITLES")).toBe(false);
  });

  it("dimension 缺失 → 冻结/打印两条都跳过(不猜行列数)", () => {
    const r = checkXlsx(xlsxFacts({ sheets: [{ name: "S1", formulaCells: 0, cachedFormulaCells: 0, freezePane: false, printTitles: false }] }));
    expect(r.issues).toHaveLength(0);
  });

  it("dimension 非法字符串 → 同样跳过而不是判非法", () => {
    const r = checkXlsx(xlsxFacts({ sheets: [{ name: "S1", formulaCells: 0, cachedFormulaCells: 0, freezePane: false, printTitles: false, dimension: "not-a-range" }] }));
    expect(r.code).toBe(FORMAT_OK);
    expect(r.issues).toHaveLength(0);
  });

  it("宽表同时缺冻结与打印标题 → 两条 p2", () => {
    const r = checkXlsx(xlsxFacts({ sheets: [{ name: "S1", formulaCells: 0, cachedFormulaCells: 0, freezePane: false, printTitles: false, dimension: "A1:J40" }] }));
    expect(ids(r)).toEqual(["FMT_XLSX_FREEZE_PANE", "FMT_XLSX_PRINT_TITLES"]);
    expect(r.verdict).toBe("warn");
  });

  it("非法 xlsx(sheets 非数组) → FORMAT_INVALID", () => {
    expect(checkXlsx({ sheets: "x" }).code).toBe(FORMAT_INVALID);
  });

  it("非法 xlsx(缓存值多于公式数) → FORMAT_INVALID", () => {
    const r = checkXlsx(xlsxFacts({ sheets: [{ name: "S1", formulaCells: 1, cachedFormulaCells: 2, freezePane: true, printTitles: true }] }));
    expect(r.code).toBe(FORMAT_INVALID);
  });

  it("非法 xlsx(sheet 名为空) → FORMAT_INVALID", () => {
    expect(checkXlsx({ sheets: [{ name: "  ", formulaCells: 0, cachedFormulaCells: 0, freezePane: true, printTitles: true }] }).code).toBe(FORMAT_INVALID);
  });
});

describe("parseDimension", () => {
  it("A1:H42 → rows=42 cols=8", () => {
    expect(parseDimension("A1:H42")).toEqual({ rows: 42, cols: 8 });
  });

  it("AA1:AB3 → rows=3 cols=28", () => {
    expect(parseDimension("AA1:AB3")).toEqual({ rows: 3, cols: 28 });
  });

  it("单单元格 A1 → rows=1 cols=1", () => {
    expect(parseDimension("A1")).toEqual({ rows: 1, cols: 1 });
  });

  it("小写与两端空格被归一", () => {
    expect(parseDimension(" b2 : d9 ")).toEqual({ rows: 9, cols: 4 });
  });

  it("undefined / 空串 / 垃圾串 → undefined", () => {
    expect(parseDimension(undefined)).toBeUndefined();
    expect(parseDimension("")).toBeUndefined();
    expect(parseDimension("Z")).toBeUndefined();
    expect(parseDimension(42)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pptx
// ---------------------------------------------------------------------------

describe("checkPptx", () => {
  it("非封面页缺标题占位符 → 命中 p1", () => {
    const r = checkPptx(pptxFacts({
      slides: [
        { index: 0, hasTitle: true, pictures: [], visibleShapes: 3 },
        { index: 1, hasTitle: false, pictures: [], visibleShapes: 5 },
      ],
    }));
    expect(hit(r, "FMT_PPTX_TITLE_MISSING")).toBe(true);
    expect(r.issues[0]?.location).toBe("pptx.slide[1]");
    expect(r.counts).toEqual({ p0: 0, p1: 1, p2: 0 });
  });

  it("封面(index 0)缺标题 → 不报(封面允许纯视觉)", () => {
    const r = checkPptx(pptxFacts({ slides: [{ index: 0, hasTitle: false, pictures: [], visibleShapes: 2 }] }));
    expect(hit(r, "FMT_PPTX_TITLE_MISSING")).toBe(false);
  });

  it("所有页都有标题 → pass", () => {
    const r = checkPptx(pptxFacts({
      slides: [
        { index: 0, hasTitle: true, pictures: [], visibleShapes: 2 },
        { index: 1, hasTitle: true, pictures: [], visibleShapes: 4 },
        { index: 2, hasTitle: true, pictures: [], visibleShapes: 4 },
      ],
    }));
    expect(r.verdict).toBe("pass");
  });

  it("1 基 index 时封面同样不误报(按数组第一张判封面)", () => {
    const r = checkPptx(pptxFacts({
      slides: [
        { index: 1, hasTitle: false, pictures: [], visibleShapes: 1 },
        { index: 2, hasTitle: false, pictures: [], visibleShapes: 1 },
      ],
    }));
    expect(ids(r)).toEqual(["FMT_PPTX_TITLE_MISSING"]);
    expect(r.issues[0]?.location).toBe("pptx.slide[2]");
  });

  it("图片缺 alt → 命中 p1", () => {
    const r = checkPptx(pptxFacts({ slides: [{ index: 0, hasTitle: true, pictures: [{ index: 1 }], visibleShapes: 2 }] }));
    expect(hit(r, "FMT_PPTX_ALT_TEXT")).toBe(true);
    expect(r.issues[0]?.location).toBe("pptx.slide[0].picture[1]");
  });

  it("图片有 alt → 不命中", () => {
    const r = checkPptx(pptxFacts({
      slides: [{ index: 0, hasTitle: true, pictures: [{ index: 0, altText: "趋势图" }], visibleShapes: 2 }],
    }));
    expect(r.issues).toHaveLength(0);
  });

  it("同一页缺标题 + 图片缺 alt → 两条 p1", () => {
    const r = checkPptx(pptxFacts({
      slides: [
        { index: 0, hasTitle: true, pictures: [], visibleShapes: 1 },
        { index: 1, hasTitle: false, pictures: [{ index: 2 }, { index: 3, altText: "ok" }], visibleShapes: 3 },
      ],
    }));
    expect(r.counts).toEqual({ p0: 0, p1: 2, p2: 0 });
  });

  it("非法 pptx(slides 缺失) → FORMAT_INVALID", () => {
    expect(checkPptx({}).code).toBe(FORMAT_INVALID);
  });

  it("非法 pptx(visibleShapes 为字符串) → FORMAT_INVALID", () => {
    expect(checkPptx({ slides: [{ index: 0, hasTitle: true, pictures: [], visibleShapes: "3" }] }).code).toBe(FORMAT_INVALID);
  });
});

// ---------------------------------------------------------------------------
// pdf
// ---------------------------------------------------------------------------

describe("checkPdf", () => {
  it("完整未加密 PDF → pass", () => {
    const r = checkPdf(pdfFacts());
    expect(r).toMatchObject({ code: FORMAT_OK, verdict: "pass", ok: true });
  });

  it("缺 %PDF- 头 → 命中 FMT_PDF_TRUNCATED p0", () => {
    const r = checkPdf(pdfFacts({ headerOk: false }));
    expect(hit(r, "FMT_PDF_TRUNCATED")).toBe(true);
    expect(r.issues[0]?.severity).toBe("p0");
    expect(r.verdict).toBe("fail");
  });

  it("缺 %%EOF 尾标 → 命中 FMT_PDF_TRUNCATED", () => {
    const r = checkPdf(pdfFacts({ eofOk: false }));
    expect(hit(r, "FMT_PDF_TRUNCATED")).toBe(true);
  });

  it("头与尾都缺 → 仍是一条 issue,描述同时点出两者", () => {
    const r = checkPdf(pdfFacts({ headerOk: false, eofOk: false }));
    const found = r.issues.filter((i) => i.ruleId === "FMT_PDF_TRUNCATED");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("%PDF- 头");
    expect(found[0]?.message).toContain("%%EOF 尾标");
  });

  it("含 /Encrypt → 命中 p0", () => {
    const r = checkPdf(pdfFacts({ encrypted: true }));
    expect(hit(r, "FMT_PDF_ENCRYPTED")).toBe(true);
    expect(r.code).toBe(FORMAT_FAIL);
  });

  it("pageCount=0 → 命中 FMT_PDF_NO_PAGES p0", () => {
    const r = checkPdf(pdfFacts({ pageCount: 0 }));
    expect(hit(r, "FMT_PDF_NO_PAGES")).toBe(true);
    expect(r.counts.p0).toBe(1);
  });

  it("pageCount=-1(未知) → 只报 p2 的 PAGE_SCAN_UNKNOWN,warn 而不是 pass", () => {
    const r = checkPdf(pdfFacts({ pageCount: -1 }));
    expect(ids(r)).toEqual(["FMT_PDF_PAGE_SCAN_UNKNOWN"]);
    expect(r.verdict).toBe("warn");
    expect(r.code).toBe(FORMAT_WARN);
    expect(hit(r, "FMT_PDF_NO_PAGES")).toBe(false);
  });

  it("加密 + 截断 → 两条 p0,counts 累计", () => {
    const r = checkPdf(pdfFacts({ headerOk: false, encrypted: true }));
    expect(r.counts.p0).toBe(2);
    expect(ids(r)).toEqual(["FMT_PDF_TRUNCATED", "FMT_PDF_ENCRYPTED"]);
  });

  it("非法 pdf(pageCount=-2) → FORMAT_INVALID", () => {
    expect(checkPdf(pdfFacts({ pageCount: -2 })).code).toBe(FORMAT_INVALID);
  });

  it("非法 pdf(pageCount=1.5) → FORMAT_INVALID", () => {
    expect(checkPdf(pdfFacts({ pageCount: 1.5 })).code).toBe(FORMAT_INVALID);
  });

  it("非法 pdf(encrypted 非布尔) → FORMAT_INVALID", () => {
    expect(checkPdf({ headerOk: true, eofOk: true, encrypted: "no", pageCount: 1 }).code).toBe(FORMAT_INVALID);
  });
});

// ---------------------------------------------------------------------------
// checkAll
// ---------------------------------------------------------------------------

describe("checkAll", () => {
  it("空对象 → pass(什么都没检查也是合法输入)", () => {
    const r = checkAll({});
    expect(r).toMatchObject({ code: FORMAT_OK, verdict: "pass", ok: true });
    expect(r.counts).toEqual({ p0: 0, p1: 0, p2: 0 });
  });

  it("四类混合时 issue 按 docx→xlsx→pptx→pdf 固定顺序", () => {
    const r = checkAll({
      docx: docxFacts({ images: [{ index: 0 }] }),
      xlsx: xlsxFacts({ sheets: [{ name: "S1", formulaCells: 2, cachedFormulaCells: 0, freezePane: true, printTitles: true }] }),
      pptx: pptxFacts({ slides: [{ index: 0, hasTitle: true, pictures: [{ index: 0 }], visibleShapes: 1 }] }),
      pdf: pdfFacts({ encrypted: true }),
    });
    expect(ids(r)).toEqual([
      "FMT_DOCX_IMAGE_ALT",
      "FMT_XLSX_FORMULA_CACHED",
      "FMT_PPTX_ALT_TEXT",
      "FMT_PDF_ENCRYPTED",
    ]);
    expect(r.counts).toEqual({ p0: 2, p1: 2, p2: 0 });
    expect(r.verdict).toBe("fail");
  });

  it("未传的部件跳过:只给 pdf → 只报 pdf", () => {
    const r = checkAll({ pdf: pdfFacts({ pageCount: 0 }) });
    expect(ids(r)).toEqual(["FMT_PDF_NO_PAGES"]);
  });

  it("任一部件非法 → 整体 code=FORMAT_INVALID 且 fail", () => {
    const r = checkAll({ docx: null, pdf: pdfFacts() });
    expect(r.code).toBe(FORMAT_INVALID);
    expect(r.verdict).toBe("fail");
    expect(r.counts.p0).toBe(1);
  });

  it("只有 p1 → code=FORMAT_WARN,ok=true", () => {
    const r = checkAll({ docx: docxFacts({ images: [{ index: 0 }] }) });
    expect(r.code).toBe(FORMAT_WARN);
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("warn");
  });

  it("多个 p0 跨部件累计", () => {
    const r = checkAll({
      xlsx: xlsxFacts({ sheets: [{ name: "S1", formulaCells: 1, cachedFormulaCells: 0, freezePane: true, printTitles: true }] }),
      pdf: pdfFacts({ headerOk: false, pageCount: 0 }),
    });
    expect(r.counts.p0).toBe(3);
  });

  it("非对象入参 → FORMAT_INVALID", () => {
    expect(checkAll([]).code).toBe(FORMAT_INVALID);
    expect(checkAll("x").code).toBe(FORMAT_INVALID);
    expect(checkAll(null).code).toBe(FORMAT_INVALID);
  });
});

// ---------------------------------------------------------------------------
// 不变量:不 throw / 确定性 / 不可变 / 返回不共享
// ---------------------------------------------------------------------------

describe("不变量", () => {
  const samples: Array<[string, (v: unknown) => FormatReport]> = [
    ["checkDocx", checkDocx],
    ["checkXlsx", checkXlsx],
    ["checkPptx", checkPptx],
    ["checkPdf", checkPdf],
    ["checkAll", checkAll],
  ];

  it("对一批非法输入逐一调用都不 throw 且返回 FORMAT_INVALID", () => {
 // checkAll 的入参是「部件集合」而不是 facts:{a:1} 对它是合法对象(未传部件 = 不检查),
 // 所以只有它用不含对象的非法列表;四类 facts 检查则把对象也当非法。
    const badFacts = [undefined, null, 0, -1, "", "x", true, [], [1, 2], { a: 1 }];
    const badParts = [undefined, null, 0, -1, "", "x", true, [], [1, 2]];
    for (const [name, fn] of samples) {
      const bad = name === "checkAll" ? badParts : badFacts;
      for (const value of bad) {
        let report: FormatReport | undefined;
        expect(() => {
          report = fn(value);
        }, `${name} 不应 throw`).not.toThrow();
        expect(report?.code).toBe(FORMAT_INVALID);
      }
    }
  });

  it("同输入同结果:两次调用 JSON 逐字相等", () => {
    const parts = {
      docx: docxFacts({
        tables: [{ index: 0, rows: 6, cols: 4, firstRowHeaderRepeat: false, cantSplitRows: 2, headerText: "指标" }],
        images: [{ index: 0 }, { index: 1, altText: "流程图" }],
        headings: 3,
      }),
      xlsx: xlsxFacts({ sheets: [{ name: "S1", formulaCells: 4, cachedFormulaCells: 1, freezePane: false, printTitles: false, dimension: "A1:J35" }] }),
      pptx: pptxFacts({
        slides: [
          { index: 0, hasTitle: true, pictures: [], visibleShapes: 2 },
          { index: 1, hasTitle: false, pictures: [{ index: 0 }], visibleShapes: 4 },
        ],
      }),
      pdf: pdfFacts({ pageCount: -1 }),
    };
    expect(JSON.stringify(checkAll(parts))).toBe(JSON.stringify(checkAll(parts)));
  });

  it("不修改入参:deepFreeze 后调用不 throw 且入参 JSON 不变", () => {
    const facts = deepFreeze(docxFacts({
      tables: [{ index: 0, rows: 6, cols: 2, firstRowHeaderRepeat: false, cantSplitRows: 0 }],
      images: [{ index: 0 }],
      headings: 1,
    }));
    const before = JSON.stringify(facts);
    expect(() => checkDocx(facts)).not.toThrow();
    expect(JSON.stringify(facts)).toBe(before);
  });

  it("返回值不与内部共享:改上一次结果的 issues 不影响下一次调用", () => {
    const facts = docxFacts({ images: [{ index: 0 }] });
    const first = checkDocx(facts);
    first.issues.push({ ruleId: "X", severity: "p0", message: "fake", fixHint: "fake", location: "x" });
    first.counts.p0 = 99;
    const second = checkDocx(facts);
    expect(second.issues).toHaveLength(1);
    expect(second.counts).toEqual({ p0: 0, p1: 1, p2: 0 });
  });

  it("每条 issue 都带非空的 message/fixHint/location", () => {
    const r = checkAll({
      docx: docxFacts({ tables: [{ index: 0, rows: 5, cols: 2, firstRowHeaderRepeat: false, cantSplitRows: 0 }], images: [{ index: 0 }] }),
      xlsx: xlsxFacts({ sheets: [{ name: "S1", formulaCells: 1, cachedFormulaCells: 0, freezePane: false, printTitles: false, dimension: "A1:Z40" }] }),
      pptx: pptxFacts({ slides: [{ index: 0, hasTitle: true, pictures: [], visibleShapes: 1 }, { index: 1, hasTitle: false, pictures: [{ index: 0 }], visibleShapes: 2 }] }),
      pdf: pdfFacts({ encrypted: true, pageCount: -1 }),
    });
    expect(r.issues.length).toBeGreaterThanOrEqual(9);
    for (const it of r.issues) {
      expect(it.ruleId.length).toBeGreaterThan(0);
      expect(it.message.length).toBeGreaterThan(0);
      expect(it.fixHint.length).toBeGreaterThan(0);
      expect(it.location.length).toBeGreaterThan(0);
      expect(["p0", "p1", "p2"]).toContain(it.severity);
    }
  });

  it("severity 与规则表一致(单条 issue 不能自报严重度)", () => {
    const r = checkAll({ pdf: pdfFacts({ pageCount: -1 }), docx: docxFacts({ images: [{ index: 0 }] }) });
    for (const it of r.issues) {
      expect(it.severity).toBe(FORMAT_RULES[it.ruleId as FormatRuleId].severity);
    }
  });

  it("counts 之和恒等于 issues 长度", () => {
    const r = checkAll({
      docx: docxFacts({ tables: [{ index: 0, rows: 7, cols: 3, firstRowHeaderRepeat: false, cantSplitRows: 1 }], images: [{ index: 0 }, { index: 1 }] }),
      xlsx: xlsxFacts({ sheets: [{ name: "S", formulaCells: 3, cachedFormulaCells: 0, freezePane: false, printTitles: false, dimension: "A1:H40" }] }),
      pdf: pdfFacts({ headerOk: false, eofOk: false, pageCount: -1 }),
    });
    expect(r.counts.p0 + r.counts.p1 + r.counts.p2).toBe(r.issues.length);
  });
});
