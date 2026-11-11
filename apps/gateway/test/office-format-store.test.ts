import { describe, it, expect, afterAll } from "vitest";
import JSZip from "jszip";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkAll,
  parseDimension,
  type DocxFacts,
  type PptxFacts,
  type XlsxFacts,
} from "@lampgenie/runtime/agent/office-format-rules";

import {
  docxFactsOf,
  extractFacts,
  OFFICE_FORMAT_RELATIVE_DIR,
  parseXmlLite,
  pdfFactsOf,
  readFormatLedger,
  resolveFormat,
  resolveSafeRoot,
  runFormatCheck,
  sha256Hex,
} from "../src/office-format-store.js";

/** 抽取层单测:夹具全部在 test 里用 jszip 现场造(只写 /tmp),不往仓里塞二进制。
 * 真实件只有两个:docs/review/harness-intro.pptx 与 soffice 转出的 /tmp/m102-fixtures/good.pdf
 * (后者不存在时相关用例 skip,不伪装通过)。
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REAL_PPTX = join(REPO_ROOT, "docs/review/harness-intro.pptx");
const REAL_PDF = "/tmp/m102-fixtures/good.pdf";

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const roots: string[] = [];

/** 临时根(全部在 /tmp 下;测试结束统一删)。 */
function tmpRoot(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `m102-${tag}-`));
  roots.push(dir);
  return dir;
}

/** 把一组 part 打成 zip 字节(OOXML 夹具的最小骨架)。 */
async function makeZip(parts: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(parts)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** 写一份夹具到 /tmp 并返回路径。 */
async function writeFixture(dir: string, name: string, bytes: Buffer): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

// ------------------------------- docx 夹具 -------------------------------

interface DocxOpts {
  rows: number;
  headerRepeat: boolean;
  cantSplit: boolean;
  imageDescr?: string;
  headings?: number;
}

/** 盖一个 docx:一张 rows×2 的表格 + 一张图片 + headings 个 Heading1 段落。 */
async function buildDocx(opts: DocxOpts): Promise<Buffer> {
  const trs: string[] = [];
  for (let r = 0; r < opts.rows; r += 1) {
    const pr: string[] = [];
    if (opts.headerRepeat && r === 0) pr.push("<w:tblHeader/>");
    if (opts.cantSplit) pr.push("<w:cantSplit/>");
    const trPr = pr.length > 0 ? `<w:trPr>${pr.join("")}</w:trPr>` : "";
    const cells = ["甲", "乙"]
      .map((_, c) => `<w:tc><w:tcPr/><w:p><w:r><w:t>R${r}C${c}</w:t></w:r></w:p></w:tc>`)
      .join("");
    trs.push(`<w:tr>${trPr}${cells}</w:tr>`);
  }
  const descr =
    opts.imageDescr === undefined ? "" : ` descr="${opts.imageDescr}"`;
  const drawing =
    '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/>' +
    `<wp:docPr id="1" name="图片 1"${descr}/>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  const heading =
    `<w:p><w:pPr><w:pStyle w:val="Heading${1}"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>`;
  const headings = (opts.headings ?? 0) > 0 ? heading.repeat(opts.headings ?? 0) : "";
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document ${W_NS}><w:body>` +
    `<w:tbl><w:tblPr/>${trs.join("")}</w:tbl>` +
    drawing +
    headings +
    "</w:body></w:document>";
  return makeZip({
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    "word/document.xml": documentXml,
  });
}

// ------------------------------- xlsx 夹具 -------------------------------

interface SheetOpts {
  dimension?: string;
  cells: string;
  freezeY?: number;
  freezeX?: number;
}

function buildXlsx(sheets: SheetOpts[], sheetNames: string[], printTitles: boolean): Promise<Buffer> {
  const parts: Record<string, string> = {
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  };
  const sheetTags = sheetNames
    .map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");
  const definedName = printTitles
    ? '<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">Sheet1!$1:$1</definedName></definedNames>'
    : "";
  parts["xl/workbook.xml"] =
    '<?xml version="1.0"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheetTags}</sheets>${definedName}</workbook>`;
  sheets.forEach((sheet, i) => {
    const dim = sheet.dimension === undefined ? "" : `<dimension ref="${sheet.dimension}"/>`;
    const paneParts: string[] = [];
    if (sheet.freezeX !== undefined) paneParts.push(`xSplit="${sheet.freezeX}"`);
    if (sheet.freezeY !== undefined) paneParts.push(`ySplit="${sheet.freezeY}"`);
    const pane = paneParts.length > 0 ? `<pane ${paneParts.join(" ")} topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` : "";
    parts[`xl/worksheets/sheet${i + 1}.xml`] =
      '<?xml version="1.0"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `${dim}<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
      `<sheetData>${sheet.cells}</sheetData></worksheet>`;
  });
  return makeZip(parts);
}

// ------------------------------- pptx 夹具 -------------------------------

interface SlideOpts {
  titleType?: "title" | "ctrTitle";
  pictures: { descr?: string }[];
  hiddenShape?: boolean;
}

function slideXml(opts: SlideOpts): string {
  const title =
    opts.titleType === undefined
      ? ""
      : '<p:sp><p:nvSpPr><p:cNvPr id="2" name="标题 1"/><p:cNvSpPr/><p:nvPr>' +
        `<p:ph type="${opts.titleType}"/></p:nvPr></p:nvSpPr><p:spPr/>` +
        "<p:txBody><a:bodyPr/><a:p><a:r><a:t>标题文本</a:t></a:r></a:p></p:txBody></p:sp>";
  const pics = opts.pictures
    .map((pic, i) => {
      const descr = pic.descr === undefined ? "" : ` descr="${pic.descr}"`;
      return (
        '<p:pic><p:nvPicPr>' +
        `<p:cNvPr id="${10 + i}" name="图片 ${i + 1}"${descr}/>` +
        '<p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>'
      );
    })
    .join("");
  const hidden = opts.hiddenShape
    ? '<p:sp><p:nvSpPr><p:cNvPr id="90" name="隐藏形状" hidden="1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>'
    : "";
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<p:sld ${P_NS}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    `${title}${pics}${hidden}` +
    "</p:spTree></p:cSld></p:sld>"
  );
}

function buildPptx(slides: SlideOpts[]): Promise<Buffer> {
  const parts: Record<string, string> = {
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  };
  const sldIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("");
  parts["ppt/presentation.xml"] =
    '<?xml version="1.0"?>' +
    `<p:presentation ${P_NS}><p:sldIdLst>${sldIds}</p:sldIdLst></p:presentation>`;
  const rels = slides
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
    )
    .join("");
  parts["ppt/_rels/presentation.xml.rels"] =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `${rels}</Relationships>`;
  slides.forEach((slide, i) => {
    parts[`ppt/slides/slide${i + 1}.xml`] = slideXml(slide);
  });
  return makeZip(parts);
}

// ------------------------------- pdf 夹具 -------------------------------

/** 最小可解析的 pdf 字节(2 页,/Type /Page 出现两次)。 */
function pdfBytes(pages = 2): Buffer {
  const body = Array.from({ length: pages }, (_, i) => `${i + 1} 0 obj<</Type /Page/Parent 9 0 R>>endobj\n`).join("");
  return Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type /Catalog/Pages 9 0 R>>endobj\n" +
      "9 0 obj<</Type /Pages/Count " +
      String(pages) +
      ">>endobj\n" +
      body +
      "trailer<</Root 1 0 R>>\n%%EOF\n",
    "latin1",
  );
}

const realPdfExists = existsSync(REAL_PDF);
const itRealPdf = realPdfExists ? it : it.skip;

afterAll(() => {
  for (const dir of roots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
 /* 清理失败不影响结论 */
    }
  }
});

// ===========================================================================
// docx
// ===========================================================================

describe("docx 抽取与裁决", () => {
  it("bad.docx:表格行数/列数/cantSplit 行数/首行文本抽得出来", async () => {
    const dir = tmpRoot("docx");
    const path = await writeFixture(dir, "bad.docx", await buildDocx({ rows: 6, headerRepeat: false, cantSplit: false, headings: 2 }));
    const bytes = readFileSync(path);
    const out = await extractFacts(path, bytes);
    expect(out.format).toBe("docx");
    const facts = out.facts as DocxFacts;
    expect(facts.tables).toHaveLength(1);
    expect(facts.tables[0]?.rows).toBe(6);
    expect(facts.tables[0]?.cols).toBe(2);
    expect(facts.tables[0]?.firstRowHeaderRepeat).toBe(false);
    expect(facts.tables[0]?.cantSplitRows).toBe(0);
    expect(facts.tables[0]?.headerText).toBe("R0C0 | R0C1");
  });

  it("bad.docx:图片无 descr → altText undefined;Heading1 段落计数正确", async () => {
    const dir = tmpRoot("docx");
    const path = await writeFixture(dir, "bad.docx", await buildDocx({ rows: 3, headerRepeat: false, cantSplit: false, headings: 2 }));
    const facts = (await extractFacts(path, readFileSync(path))).facts as DocxFacts;
    expect(facts.images).toHaveLength(1);
    expect(facts.images[0]?.altText).toBeUndefined();
    expect(facts.headings).toBe(2);
  });

  it("bad.docx:checkAll 命中表头重复行 + 行不跨页 + 图片 alt 三条", async () => {
    const dir = tmpRoot("docx");
    const path = await writeFixture(dir, "bad.docx", await buildDocx({ rows: 6, headerRepeat: false, cantSplit: false }));
    const facts = (await extractFacts(path, readFileSync(path))).facts;
    const report = checkAll({ docx: facts });
    const ids = report.issues.map((i) => i.ruleId);
    expect(ids).toContain("FMT_DOCX_TBL_HEADER_REPEAT");
    expect(ids).toContain("FMT_DOCX_ROW_CANT_SPLIT");
    expect(ids).toContain("FMT_DOCX_IMAGE_ALT");
    expect(report.verdict).toBe("warn");
    expect(report.ok).toBe(true);
  });

  it("good.docx:首行 tblHeader + 每行 cantSplit + 图片 descr 全部抽到", async () => {
    const dir = tmpRoot("docx");
    const path = await writeFixture(
      dir,
      "good.docx",
      await buildDocx({ rows: 5, headerRepeat: true, cantSplit: true, imageDescr: "架构示意:三层结构" }),
    );
    const facts = (await extractFacts(path, readFileSync(path))).facts as DocxFacts;
    expect(facts.tables[0]?.firstRowHeaderRepeat).toBe(true);
    expect(facts.tables[0]?.cantSplitRows).toBe(facts.tables[0]?.rows);
    expect(facts.images[0]?.altText).toBe("架构示意:三层结构");
  });

  it("good.docx:docx 裁决零 issue(pass)", async () => {
    const dir = tmpRoot("docx");
    const path = await writeFixture(
      dir,
      "good.docx",
      await buildDocx({ rows: 5, headerRepeat: true, cantSplit: true, imageDescr: "图 1" }),
    );
    const facts = (await extractFacts(path, readFileSync(path))).facts;
    const report = checkAll({ docx: facts });
    expect(report.issues).toEqual([]);
    expect(report.verdict).toBe("pass");
    expect(report.code).toBe("FORMAT_OK");
  });

  it("docxFactsOf 直接吃 XML 树:可复用于其它调用方", () => {
    const xml =
      '<?xml version="1.0"?>' +
      `<w:document ${W_NS}><w:body><w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr>` +
      "<w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>";
    const facts = docxFactsOf(parseXmlLite(xml));
    expect(facts.tables[0]?.firstRowHeaderRepeat).toBe(true);
    expect(facts.tables[0]?.headerText).toBe("A");
  });
});

// ===========================================================================
// xlsx
// ===========================================================================

describe("xlsx 抽取与裁决", () => {
  it("bad.xlsx:公式单元格无 <v> → formulaCells=1 / cached=0", async () => {
    const dir = tmpRoot("xlsx");
    const path = await writeFixture(
      dir,
      "bad.xlsx",
      await buildXlsx([{ dimension: "A1:C10", cells: '<row r="1"><c r="A1"><f>1+1</f></c></row>' }], ["Sheet1"], false),
    );
    const facts = (await extractFacts(path, readFileSync(path))).facts as XlsxFacts;
    expect(facts.sheets[0]?.formulaCells).toBe(1);
    expect(facts.sheets[0]?.cachedFormulaCells).toBe(0);
    const ids = checkAll({ xlsx: facts }).issues.map((i) => i.ruleId);
    expect(ids).toContain("FMT_XLSX_FORMULA_CACHED");
  });

  it("good.xlsx:公式带 <v> 缓存值 → 不命中 FMT_XLSX_FORMULA_CACHED", async () => {
    const dir = tmpRoot("xlsx");
    const path = await writeFixture(
      dir,
      "good.xlsx",
      await buildXlsx(
        [{ dimension: "A1:C3", freezeY: 1, cells: '<row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row>' }],
        ["Sheet1"],
        true),
    );
    const facts = (await extractFacts(path, readFileSync(path))).facts as XlsxFacts;
    expect(facts.sheets[0]?.formulaCells).toBe(1);
    expect(facts.sheets[0]?.cachedFormulaCells).toBe(1);
    const ids = checkAll({ xlsx: facts }).issues.map((i) => i.ruleId);
    expect(ids).not.toContain("FMT_XLSX_FORMULA_CACHED");
  });

  it("dimension 抽取 A1:H42 且 parseDimension 得 rows=42/cols=8", async () => {
    const dir = tmpRoot("xlsx");
    const path = await writeFixture(
      dir,
      "dim.xlsx",
      await buildXlsx([{ dimension: "A1:H42", cells: "" }], ["Sheet1"], false),
    );
    const facts = (await extractFacts(path, readFileSync(path))).facts as XlsxFacts;
    expect(facts.sheets[0]?.dimension).toBe("A1:H42");
    expect(parseDimension(facts.sheets[0]?.dimension)).toEqual({ rows: 42, cols: 8 });
  });

  it("freezePane:ySplit 或 xSplit 都算冻结,无 pane 为 false", async () => {
    const dir = tmpRoot("xlsx");
    const y = await writeFixture(dir, "y.xlsx", await buildXlsx([{ cells: "", freezeY: 1 }], ["S"], false));
    const x = await writeFixture(dir, "x.xlsx", await buildXlsx([{ cells: "", freezeX: 2 }], ["S"], false));
    const none = await writeFixture(dir, "n.xlsx", await buildXlsx([{ cells: "" }], ["S"], false));
    expect(((await extractFacts(y, readFileSync(y))).facts as XlsxFacts).sheets[0]?.freezePane).toBe(true);
    expect(((await extractFacts(x, readFileSync(x))).facts as XlsxFacts).sheets[0]?.freezePane).toBe(true);
    expect(((await extractFacts(none, readFileSync(none))).facts as XlsxFacts).sheets[0]?.freezePane).toBe(false);
  });

  it("printTitles 只看 workbook.xml 的 _xlnm.Print_Titles", async () => {
    const dir = tmpRoot("xlsx");
    const on = await writeFixture(dir, "on.xlsx", await buildXlsx([{ cells: "" }], ["Sheet1"], true));
    const off = await writeFixture(dir, "off.xlsx", await buildXlsx([{ cells: "" }], ["Sheet1"], false));
    expect(((await extractFacts(on, readFileSync(on))).facts as XlsxFacts).sheets[0]?.printTitles).toBe(true);
    expect(((await extractFacts(off, readFileSync(off))).facts as XlsxFacts).sheets[0]?.printTitles).toBe(false);
  });

  it("宽表(42 行 8 列)无冻结无打印标题 → p2 两条", async () => {
    const dir = tmpRoot("xlsx");
    const path = await writeFixture(dir, "wide.xlsx", await buildXlsx([{ dimension: "A1:H42", cells: "" }], ["Sheet1"], false));
    const facts = (await extractFacts(path, readFileSync(path))).facts;
    const report = checkAll({ xlsx: facts });
    const ids = report.issues.map((i) => i.ruleId);
    expect(ids).toContain("FMT_XLSX_FREEZE_PANE");
    expect(ids).toContain("FMT_XLSX_PRINT_TITLES");
    expect(report.verdict).toBe("warn");
    expect(report.counts.p2).toBe(2);
  });

  it("多工作表:名称取自 workbook.xml 且顺序稳定", async () => {
    const dir = tmpRoot("xlsx");
    const path = await writeFixture(
      dir,
      "multi.xlsx",
      await buildXlsx([{ cells: "" }, { cells: '<row r="1"><c r="A1"><f>SUM(A1:A2)</f></c></row>' }], ["总览", "明细"], false),
    );
    const facts = (await extractFacts(path, readFileSync(path))).facts as XlsxFacts;
    expect(facts.sheets.map((s) => s.name)).toEqual(["总览", "明细"]);
    expect(facts.sheets[1]?.formulaCells).toBe(1);
  });
});

// ===========================================================================
// pptx
// ===========================================================================

describe("pptx 抽取与裁决", () => {
  it("真实 docs/review/harness-intro.pptx:抽出 slides 与每页结构字段", async () => {
    expect(existsSync(REAL_PPTX)).toBe(true);
    const facts = (await extractFacts(REAL_PPTX, readFileSync(REAL_PPTX))).facts as PptxFacts;
    expect(facts.slides.length).toBeGreaterThan(0);
    const first = facts.slides[0];
    expect(typeof first?.hasTitle).toBe("boolean");
    expect(Array.isArray(first?.pictures)).toBe(true);
    expect(typeof first?.visibleShapes).toBe("number");
    expect(first?.visibleShapes).toBeGreaterThan(0);
  });

  it("真实 pptx:checkAll 不吃 FORMAT_INVALID(抽取层与 rules 契约对齐)", async () => {
    const facts = (await extractFacts(REAL_PPTX, readFileSync(REAL_PPTX))).facts;
    const report = checkAll({ pptx: facts });
    expect(report.code).not.toBe("FORMAT_INVALID");
    expect(report.ruleVersion).toBe(1);
  });

  it("合成 pptx:第 2 页无 title + 图片无 descr → 两条 p1", async () => {
    const dir = tmpRoot("pptx");
    const path = await writeFixture(
      dir,
      "bad.pptx",
      await buildPptx([
        { titleType: "ctrTitle", pictures: [] },
        { pictures: [{}, { descr: "有替代文本" }] },
      ]),
    );
    const facts = (await extractFacts(path, readFileSync(path))).facts as PptxFacts;
    expect(facts.slides).toHaveLength(2);
    expect(facts.slides[0]?.hasTitle).toBe(true);
    expect(facts.slides[1]?.hasTitle).toBe(false);
    const report = checkAll({ pptx: facts });
    const ids = report.issues.map((i) => i.ruleId);
    expect(ids).toContain("FMT_PPTX_TITLE_MISSING");
    expect(ids).toContain("FMT_PPTX_ALT_TEXT");
    expect(report.counts.p1).toBe(2);
  });

  it("合成 pptx:descr 齐全时不命中 alt;hidden 形状不计入 visibleShapes", async () => {
    const dir = tmpRoot("pptx");
    const path = await writeFixture(
      dir,
      "good.pptx",
      await buildPptx([
        { titleType: "ctrTitle", pictures: [{ descr: "封面图" }], hiddenShape: true },
        { titleType: "title", pictures: [{ descr: "流程图" }], hiddenShape: true },
      ]),
    );
    const facts = (await extractFacts(path, readFileSync(path))).facts as PptxFacts;
    expect(facts.slides[0]?.pictures[0]?.altText).toBe("封面图");
 // 封面:title 形状 + 1 张图;隐藏形状被排除。
    expect(facts.slides[0]?.visibleShapes).toBe(2);
    expect(facts.slides[1]?.visibleShapes).toBe(2);
    const ids = checkAll({ pptx: facts }).issues.map((i) => i.ruleId);
    expect(ids).not.toContain("FMT_PPTX_ALT_TEXT");
    expect(ids).not.toContain("FMT_PPTX_TITLE_MISSING");
  });
});

// ===========================================================================
// pdf
// ===========================================================================

describe("pdf 抽取与裁决", () => {
  itRealPdf("真实 soffice 产物:/tmp/m102-fixtures/good.pdf → headerOk/eofOk/pageCount>0", () => {
    const facts = pdfFactsOf(readFileSync(REAL_PDF));
    expect(facts.headerOk).toBe(true);
    expect(facts.eofOk).toBe(true);
    expect(facts.pageCount).toBeGreaterThan(0);
    expect(facts.encrypted).toBe(false);
    expect(checkAll({ pdf: facts }).issues).toEqual([]);
  });

  it("截掉尾部 %%EOF → FMT_PDF_TRUNCATED(p0)", () => {
    const full = pdfBytes();
    const tailCut = full.subarray(0, full.length - 10);
    const facts = pdfFactsOf(tailCut);
    expect(facts.headerOk).toBe(true);
    expect(facts.eofOk).toBe(false);
    const report = checkAll({ pdf: facts });
    expect(report.issues.map((i) => i.ruleId)).toContain("FMT_PDF_TRUNCATED");
    expect(report.verdict).toBe("fail");
  });

  it("砍掉 %PDF- 头 → headerOk=false 且命中 FMT_PDF_TRUNCATED", () => {
    const facts = pdfFactsOf(pdfBytes().subarray(8));
    expect(facts.headerOk).toBe(false);
    expect(checkAll({ pdf: facts }).issues.map((i) => i.ruleId)).toContain("FMT_PDF_TRUNCATED");
  });

  it("含 /Encrypt 的字节 → FMT_PDF_ENCRYPTED(p0)", () => {
    const encrypted = Buffer.concat([pdfBytes(1), Buffer.from("trailer<</Encrypt 7 0 R>>\n%%EOF\n", "latin1")]);
    const facts = pdfFactsOf(encrypted);
    expect(facts.encrypted).toBe(true);
    expect(checkAll({ pdf: facts }).issues.map((i) => i.ruleId)).toContain("FMT_PDF_ENCRYPTED");
  });

  it("压缩对象流(无 /Type /Page、有 /ObjStm)→ pageCount=-1 + FMT_PDF_PAGE_SCAN_UNKNOWN", () => {
    const compressed = Buffer.from(
      "%PDF-1.5\n1 0 obj<</Type /ObjStm/N 12/First 84/Filter /FlateDecode/Length 132>>stream\nxx\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
      "latin1",
    );
    const facts = pdfFactsOf(compressed);
    expect(facts.pageCount).toBe(-1);
    expect(checkAll({ pdf: facts }).issues.map((i) => i.ruleId)).toContain("FMT_PDF_PAGE_SCAN_UNKNOWN");
  });

  it("零页且非压缩 → pageCount=0 + FMT_PDF_NO_PAGES", () => {
    const empty = Buffer.from("%PDF-1.4\n1 0 obj<</Type /Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");
    const facts = pdfFactsOf(empty);
    expect(facts.pageCount).toBe(0);
    expect(checkAll({ pdf: facts }).issues.map((i) => i.ruleId)).toContain("FMT_PDF_NO_PAGES");
  });

  it("pdfFactsOf 不猜页数:多页字节数得准", () => {
    expect(pdfFactsOf(pdfBytes(3)).pageCount).toBe(3);
  });
});

// ===========================================================================
// 抽取失败(不 throw,交 FORMAT_INVALID)
// ===========================================================================

describe("抽取失败路径", () => {
  it("非 zip 字节 → facts=null + reason,不 throw", async () => {
    const out = await extractFacts("/tmp/not-a-zip.docx", Buffer.from("这不是 zip", "utf8"));
    expect(out.format).toBe("docx");
    expect(out.facts).toBeNull();
    expect(out.reason).toBeDefined();
    expect(checkAll({ docx: out.facts }).code).toBe("FORMAT_INVALID");
  });

  it("zip 缺 word/document.xml → facts=null", async () => {
    const bytes = await makeZip({ "[Content_Types].xml": "<Types/>" });
    const out = await extractFacts("/tmp/no-doc.docx", bytes);
    expect(out.facts).toBeNull();
    expect(out.reason).toContain("word/document.xml");
  });

  it("OLE/加密包(非 zip)→ facts=null", async () => {
    const ole = Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(64, 0)]);
    const out = await extractFacts("/tmp/enc.docx", ole);
    expect(out.facts).toBeNull();
  });

  it("未知扩展名 → resolveFormat=null / extractFacts format=null", async () => {
    expect(resolveFormat("/tmp/a.txt")).toBeNull();
    expect(resolveFormat("/tmp/a.PDF")).toBe("pdf");
    const out = await extractFacts("/tmp/a.txt", Buffer.from("x"));
    expect(out.format).toBeNull();
    expect(out.facts).toBeNull();
  });

  it("未知扩展名走 runFormatCheck → FORMAT_INVALID / exit 2", async () => {
    const root = tmpRoot("unknown");
    const dir = tmpRoot("unknown-file");
    const path = await writeFixture(dir, "notes.txt", Buffer.from("hello", "utf8"));
    const out = await runFormatCheck({ root, files: [path] });
    expect(out.code).toBe("FORMAT_INVALID");
    expect(out.exitCode).toBe(2);
    expect(out.results[0]?.format).toBeNull();
  });
});

// ===========================================================================
// 落盘:原子写 / 幂等 / root 安全闸 / 确定性
// ===========================================================================

describe("落盘与安全闸", () => {
  it("产物 json 与账本各就其位,内容可解析", async () => {
    const root = tmpRoot("store");
    const dir = tmpRoot("store-file");
    const path = await writeFixture(dir, "good.docx", await buildDocx({ rows: 5, headerRepeat: true, cantSplit: true, imageDescr: "图" }));
    const out = await runFormatCheck({ root, files: [path] });
    expect(out.exitCode).toBe(0);
    const artifactPath = join(root, OFFICE_FORMAT_RELATIVE_DIR, `${sha256Hex(readFileSync(path)).slice(0, 12)}.json`);
    expect(existsSync(artifactPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      v: number;
      sha256: string;
      format: string;
      report: { code: string };
      facts: unknown;
      at: string;
    };
    expect(artifact.v).toBe(1);
    expect(artifact.sha256).toBe(sha256Hex(readFileSync(path)));
    expect(artifact.format).toBe("docx");
    expect(artifact.report.code).toBe("FORMAT_OK");
    expect(artifact.facts).not.toBeNull();
    expect(typeof artifact.at).toBe("string");
    expect(readFormatLedger(root)).toHaveLength(1);
  });

  it("连跑两次:账本行数不变、产物字节不变(幂等)", async () => {
    const root = tmpRoot("idem");
    const dir = tmpRoot("idem-file");
    const path = await writeFixture(dir, "bad.xlsx", await buildXlsx([{ cells: '<row r="1"><c r="A1"><f>1</f></c></row>' }], ["S"], false));
    await runFormatCheck({ root, files: [path] });
    const ledgerPath = join(root, OFFICE_FORMAT_RELATIVE_DIR, "ledger.jsonl");
    const artifactPath = join(root, OFFICE_FORMAT_RELATIVE_DIR, `${sha256Hex(readFileSync(path)).slice(0, 12)}.json`);
    const before = readFileSync(ledgerPath, "utf8");
    const artifactBefore = readFileSync(artifactPath, "utf8");
    await runFormatCheck({ root, files: [path] });
    expect(readFileSync(ledgerPath, "utf8")).toBe(before);
    expect(readFileSync(artifactPath, "utf8")).toBe(artifactBefore);
    expect(readFormatLedger(root)).toHaveLength(1);
  });

  it("同一批里重复传同一文件 → 账本只记一条", async () => {
    const root = tmpRoot("dup");
    const dir = tmpRoot("dup-file");
    const path = await writeFixture(dir, "a.pdf", pdfBytes(1));
    const out = await runFormatCheck({ root, files: [path, path] });
    expect(out.results).toHaveLength(2);
    expect(readFormatLedger(root)).toHaveLength(1);
  });

  it("root 不在 /tmp(/var/tmp/m102)→ 拒绝且不建目录", async () => {
    const dir = tmpRoot("unsafe-file");
    const path = await writeFixture(dir, "a.pdf", pdfBytes(1));
    const out = await runFormatCheck({ root: "/var/tmp/m102", files: [path] });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("OFFICE_FORMAT_ROOT_UNSAFE");
    expect(out.exitCode).toBe(1);
    expect(existsSync("/var/tmp/m102")).toBe(false);
    expect(existsSync(join("/var/tmp/m102", OFFICE_FORMAT_RELATIVE_DIR))).toBe(false);
  });

  it("root 相对路径 → resolveSafeRoot 拒绝", () => {
    expect(resolveSafeRoot(".genie").ok).toBe(false);
    expect(resolveSafeRoot("").ok).toBe(false);
    const underTmp = tmpRoot("safe");
    const ok = resolveSafeRoot(underTmp);
    expect(ok.ok).toBe(true);
  });

  it("文件不存在 → OFFICE_FORMAT_FILE_UNREADABLE / exit 1 且不落盘", async () => {
    const root = tmpRoot("missing");
    const out = await runFormatCheck({ root, files: [join(root, "nope.docx")] });
    expect(out.code).toBe("OFFICE_FORMAT_FILE_UNREADABLE");
    expect(out.exitCode).toBe(1);
    expect(existsSync(join(root, OFFICE_FORMAT_RELATIVE_DIR))).toBe(false);
  });

  it("空文件 → exit 1(不产生零字节账本)", async () => {
    const root = tmpRoot("empty");
    const dir = tmpRoot("empty-file");
    const path = await writeFixture(dir, "empty.pdf", Buffer.alloc(0));
    const out = await runFormatCheck({ root, files: [path] });
    expect(out.exitCode).toBe(1);
    expect(out.code).toBe("OFFICE_FORMAT_FILE_UNREADABLE");
  });

  it("空文件列表 → OFFICE_FORMAT_INPUT_EMPTY", async () => {
    const root = tmpRoot("nofiles");
    const out = await runFormatCheck({ root, files: [] });
    expect(out.code).toBe("OFFICE_FORMAT_INPUT_EMPTY");
    expect(out.exitCode).toBe(1);
  });

  it("确定性:同一 buffer 抽两次 facts 逐字相等", async () => {
    const dir = tmpRoot("det");
    const path = await writeFixture(dir, "det.pptx", await buildPptx([{ titleType: "ctrTitle", pictures: [{ descr: "x" }] }, { pictures: [{}] }]));
    const bytes = readFileSync(path);
    const a = JSON.stringify((await extractFacts(path, bytes)).facts);
    const b = JSON.stringify((await extractFacts(path, Buffer.from(bytes))).facts);
    expect(a).toBe(b);
  });

  it("多文件混合:任一 p0 → 整体 exit 2,逐文件结论各自保留", async () => {
    const root = tmpRoot("mixed");
    const dir = tmpRoot("mixed-file");
    const good = await writeFixture(dir, "good.docx", await buildDocx({ rows: 2, headerRepeat: true, cantSplit: true, imageDescr: "图" }));
    const bad = await writeFixture(dir, "bad.xlsx", await buildXlsx([{ cells: '<row r="1"><c r="A1"><f>1</f></c></row>' }], ["S"], false));
    const out = await runFormatCheck({ root, files: [good, bad] });
    expect(out.exitCode).toBe(2);
    expect(out.code).toBe("FORMAT_FAIL");
    expect(out.results).toHaveLength(2);
    expect(out.results[0]?.report.verdict).toBe("pass");
    expect(out.results[1]?.report.verdict).toBe("fail");
    expect(readFormatLedger(root)).toHaveLength(2);
  });
});
