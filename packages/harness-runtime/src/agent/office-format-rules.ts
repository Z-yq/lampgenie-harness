/**
 * Office 格式级业务规则检查(纯逻辑,零 IO,2026-11 #)。
 * 为什么需要它:「内容对不对」由既有内容检查回答,但「格式能不能交付」是另一类确定性事实——
 * docx 长表格翻页后首行不重复表头、表格行被拦腰截断、图片没有替代文本(读屏/归档都读不到);
 * xlsx 公式没有缓存值(用 data_only 读出来是空)、宽表没有冻结窗格与打印标题(打印出来没法看);
 * pptx 除封面外的页没有标题占位符(大纲/跳转/自动目录全失效)、图片没有替代文本;
 * pdf 被加密(离线导出不可编辑)、文件被截断(缺头/缺 EOF)、页数为零。
 * 这些都能在本地由**结构事实**确定性判定,不需要网络、不需要模型。于是把它们抽成一次纯逻辑裁决:
 * 本模块只吃「已经抽取好的结构事实」,不碰 XML、不读文件(抽取在 apps/gateway/src/office-format-store.ts)。
 * 关键不变量:
 * 1. 零 IO、不 throw:非法输入折叠成 FORMAT_INVALID(带一条 p0 issue),绝不让调用方崩在类型上。
 * 2. 同输入同结果:输出不含时间/随机数,同一 facts 调两次 JSON 逐字相等(便于落账与断言)。
 * 3. 不修改入参:只读 facts,返回全新 issues 数组与 counts 对象(调用方可 deepFreeze 后放心调用)。
 * 4. 未知就诚实:PDF 页数扫描不出(压缩对象流)时报 pageCount=-1 并给 p2 的
 * FMT_PDF_PAGE_SCAN_UNKNOWN,绝不猜一个页数(猜出来的页数会进交付结论,等于伪造证据)。
 * 5. 判定只看 issues:fail = 任一 p0;warn = 只有 p1/p2;pass = 零 issue。
 * FORMAT_INVALID 不是文档缺陷而是调用契约问题,优先于 FAIL 上报,但同样是 fail 结局。
 * 事实模型刻意与 OOXML 解耦:DocxFacts/XlsxFacts/PptxFacts/PdfFacts 都是「已抽取、已归一」的
 * 数字与布尔,不含 XML 字符串。这样规则可以脱离 jszip 单测(夹具就是普通对象),也不会因为
 * 某天换了解析器而全量重写规则。
 */

/** 规则表 schema 版本:规则语义(阈值/严重度)变化时递增。 */
export const FORMAT_RULES_VERSION = 1;

/** 稳定码:一次检查的总体结局(字符串常量,便于落盘、CLI 退出码与断言)。 */
export const FORMAT_OK = "FORMAT_OK" as const;
export const FORMAT_INVALID = "FORMAT_INVALID" as const;
export const FORMAT_FAIL = "FORMAT_FAIL" as const;
export const FORMAT_WARN = "FORMAT_WARN" as const;

/** 全部稳定码(固定顺序)。 */
export const FORMAT_CODES = [FORMAT_OK, FORMAT_INVALID, FORMAT_FAIL, FORMAT_WARN] as const;

export type FormatCode = (typeof FORMAT_CODES)[number];

/** 严重度:p0 阻断交付、p1 应修、p2 建议修。 */
export type FormatSeverity = "p0" | "p1" | "p2";

/** 一条规则元数据:严重度 + 一句话标题 + 修法提示。 */
export interface FormatRuleMeta {
  severity: FormatSeverity;
  title: string;
  fixHint: string;
}

/**
 * 规则表(固定顺序):ruleId 是稳定码,severity 是唯一权威(单条 issue 不带自定义严重度)。
 * 阈值也写在这里的 title 里,避免规则实现与文档各写一套数。
 */
export const FORMAT_RULES = {
  FMT_DOCX_TBL_HEADER_REPEAT: {
    severity: "p1",
    title: "多行表格首行未设「重复标题行」",
    fixHint: "在 Word 中选中首行 → 表格属性 → 行 → 勾选「在各页顶端以标题行形式重复出现」(OOXML: w:tblHeader)",
  },
  FMT_DOCX_ROW_CANT_SPLIT: {
    severity: "p2",
    title: "表格行未设「允许跨页断行=否」",
    fixHint: "表格属性 → 行 → 取消「允许跨页断行」(OOXML: w:cantSplit),避免一行被页边界拦腰截断",
  },
  FMT_DOCX_IMAGE_ALT: {
    severity: "p1",
    title: "图片缺少替代文本(alt)",
    fixHint: "右键图片 → 设置图片格式 → 可访问性 → 描述(OOXML: w:drawing/docPr@descr),供读屏与归档检索",
  },
  FMT_XLSX_FORMULA_CACHED: {
    severity: "p0",
    title: "公式单元格缺少缓存值",
    fixHint: "用 Excel/LibreOffice 打开并保存一次(或重新计算后保存),让每个公式单元格带 <v> 缓存值;否则 data_only 读取为空白",
  },
  FMT_XLSX_FREEZE_PANE: {
    severity: "p2",
    title: "宽表未冻结窗格",
    fixHint: "视图 → 冻结窗格(OOXML: sheetView/pane@ySplit),滚动时保留表头",
  },
  FMT_XLSX_PRINT_TITLES: {
    severity: "p2",
    title: "打印未设置标题行/列",
    fixHint: "页面布局 → 打印标题(OOXML: workbook.xml 的 definedName _xlnm.Print_Titles),每页打印都带表头",
  },
  FMT_PPTX_TITLE_MISSING: {
    severity: "p1",
    title: "非封面页缺少标题占位符",
    fixHint: "给该页套用带标题的版式并填写标题(OOXML: sp/p:nvSpPr/p:nvPr/p:ph@type=title|ctrTitle)",
  },
  FMT_PPTX_ALT_TEXT: {
    severity: "p1",
    title: "幻灯片图片缺少替代文本(alt)",
    fixHint: "右键图片 → 编辑替代文字(OOXML: pic/nvPicPr/cNvPr@descr)",
  },
  FMT_PDF_ENCRYPTED: {
    severity: "p0",
    title: "PDF 已加密(含 /Encrypt)",
    fixHint: "导出时关闭权限/文档加密,否则下游无法无损编辑与抽取文本",
  },
  FMT_PDF_TRUNCATED: {
    severity: "p0",
    title: "PDF 文件不完整(缺头或缺 %%EOF)",
    fixHint: "重新导出/重新下载:缺 %PDF- 头或缺 %%EOF 尾标的文件通常是被截断的半成品",
  },
  FMT_PDF_NO_PAGES: {
    severity: "p0",
    title: "PDF 页数为零",
    fixHint: "确认导出源非空且导出流程完整;零页 PDF 无法交付",
  },
  FMT_PDF_PAGE_SCAN_UNKNOWN: {
    severity: "p2",
    title: "PDF 页数无法确定(对象流压缩)",
    fixHint: "用 PDF 解析库或 pdfinfo 复核页数;本检查器不猜页数,只如实报告未知",
  },
} as const satisfies Record<string, FormatRuleMeta>;

export type FormatRuleId = keyof typeof FORMAT_RULES;

/** 全部 ruleId(固定顺序,与 FORMAT_RULES 同序)。 */
export const FORMAT_RULE_IDS = Object.keys(FORMAT_RULES) as FormatRuleId[];

/** 一条检查结论:ruleId/严重度/人读描述/修法/定位。 */
export interface FormatIssue {
  ruleId: string;
  severity: FormatSeverity;
  message: string;
  fixHint: string;
 /** 人可读定位,如 docx.table[1]、xlsx.sheet[Sheet1]、pdf.bytes。 */
  location: string;
}

/** 按严重度计数。 */
export interface FormatCounts {
  p0: number;
  p1: number;
  p2: number;
}

export type FormatVerdict = "pass" | "warn" | "fail";

/** 一次检查结果(自足:结论 + 明细 + 计数 + 规则版本)。 */
export interface FormatReport {
  code: FormatCode;
 /** 无 p0 即 true(与 code 的 fail/invalid 区分:invalid 也是 false)。 */
  ok: boolean;
  verdict: FormatVerdict;
  ruleVersion: number;
  counts: FormatCounts;
  issues: FormatIssue[];
}

// ---------------------------------------------------------------------------
// 结构事实模型(runtime 不碰 XML,只吃抽取层归一后的事实)
// ---------------------------------------------------------------------------

/** docx 表格事实:行列数 + 首行是否重复表头 + 已设 cantSplit 的行数。 */
export interface DocxTableFacts {
  index: number;
  rows: number;
  cols: number;
  firstRowHeaderRepeat: boolean;
 /** 已设 w:cantSplit 的行数(0..rows)。 */
  cantSplitRows: number;
  headerText?: string;
}

/** docx 图片事实:altText 缺失或空串都视为缺失。 */
export interface DocxImageFacts {
  index: number;
  altText?: string;
}

/** docx 结构事实。 */
export interface DocxFacts {
  tables: DocxTableFacts[];
  images: DocxImageFacts[];
  headings: number;
}

/** xlsx 工作表事实:公式数/缓存值数/冻结/打印标题/维度(如 A1:H42)。 */
export interface XlsxSheetFacts {
  name: string;
  formulaCells: number;
  cachedFormulaCells: number;
  freezePane: boolean;
  printTitles: boolean;
  dimension?: string;
}

/** xlsx 结构事实。 */
export interface XlsxFacts {
  sheets: XlsxSheetFacts[];
}

/** pptx 图片事实。 */
export interface PptxPictureFacts {
  index: number;
  altText?: string;
}

/** pptx 幻灯片事实:hasTitle 看是否带 title/ctrTitle 占位符。 */
export interface PptxSlideFacts {
  index: number;
  hasTitle: boolean;
  pictures: PptxPictureFacts[];
  visibleShapes: number;
}

/** pptx 结构事实。 */
export interface PptxFacts {
  slides: PptxSlideFacts[];
}

/** pdf 结构事实:页数 -1 表示「扫描不出,不猜」。 */
export interface PdfFacts {
  headerOk: boolean;
  eofOk: boolean;
  encrypted: boolean;
  pageCount: number;
}

/** checkAll 的部件入参:缺省 = 不检查该部件。 */
export interface FormatParts {
  docx?: unknown;
  xlsx?: unknown;
  pptx?: unknown;
  pdf?: unknown;
}

// ---------------------------------------------------------------------------
// 内部工具(全部无副作用)
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/** 非负整数(计数类字段不接受负数/小数;页数单独校验允许 -1)。 */
const isCount = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0;

const isStr = (v: unknown): v is string => typeof v === "string";

/** altText 缺失判定:undefined / 空串 / 纯空白都算缺(纯空白对读屏等同没有)。 */
const altMissing = (v: unknown): boolean => !isStr(v) || v.trim() === "";

/** 规则构造:严重度与修法由规则表唯一提供,调用方只给定位与描述。 */
function issue(ruleId: FormatRuleId, location: string, message: string): FormatIssue {
  const meta: FormatRuleMeta = FORMAT_RULES[ruleId];
  return {
    ruleId,
    severity: meta.severity,
    message,
    fixHint: meta.fixHint,
    location,
  };
}

/** 非法入参的固定结局(不 throw):一条 p0 的 FORMAT_INVALID。 */
function invalid(message: string, location: string): FormatReport {
  return {
    code: FORMAT_INVALID,
    ok: false,
    verdict: "fail",
    ruleVersion: FORMAT_RULES_VERSION,
    counts: { p0: 1, p1: 0, p2: 0 },
    issues: [
      {
        ruleId: FORMAT_INVALID,
        severity: "p0",
        message,
        fixHint: "按 rules 模块导出的 Facts 契约传参(数组字段不能缺,计数必须是非负整数)",
        location,
      },
    ],
  };
}

/** 汇总:issues → counts/verdict/code(纯函数,返回全新对象)。 */
function summarize(issues: FormatIssue[], code?: FormatCode): FormatReport {
  let p0 = 0;
  let p1 = 0;
  let p2 = 0;
  for (const it of issues) {
    if (it.severity === "p0") p0 += 1;
    else if (it.severity === "p1") p1 += 1;
    else p2 += 1;
  }
  const verdict: FormatVerdict = p0 > 0 ? "fail" : issues.length > 0 ? "warn" : "pass";
  const resolved: FormatCode =
    code ?? (verdict === "fail" ? FORMAT_FAIL : verdict === "warn" ? FORMAT_WARN : FORMAT_OK);
  return {
    code: resolved,
    ok: p0 === 0,
    verdict,
    ruleVersion: FORMAT_RULES_VERSION,
    counts: { p0, p1, p2 },
    issues,
  };
}

/** 解析 xlsx 维度(如 "A1:H42"):rows/cols 取两端最大值;解析不出返回 undefined(不猜行列数)。 */
export function parseDimension(dimension: unknown): { rows: number; cols: number } | undefined {
  if (!isStr(dimension)) return undefined;
  const text = dimension.trim().toUpperCase();
  if (text === "") return undefined;
  const cell = (raw: string): { row: number; col: number } | undefined => {
    const m = /^([A-Z]{1,3})([0-9]{1,7})$/.exec(raw.trim());
    if (!m) return undefined;
    const letters = m[1] ?? "";
    const digits = m[2] ?? "";
    let col = 0;
    for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { row: Number(digits), col };
  };
  const parts = text.split(":");
  const first = cell(parts[0] ?? "");
  const last = cell(parts[1] ?? parts[0] ?? "");
  if (!first || !last) return undefined;
  return { rows: Math.max(first.row, last.row), cols: Math.max(first.col, last.col) };
}

// ---------------------------------------------------------------------------
// facts 校验(逐字段,非法即 undefined)
// ---------------------------------------------------------------------------

function asDocxFacts(input: unknown): DocxFacts | undefined {
  if (!isObj(input)) return undefined;
  const { tables, images, headings } = input;
  if (!Array.isArray(tables) || !Array.isArray(images) || !isCount(headings)) return undefined;
  const okTables: DocxTableFacts[] = [];
  for (const t of tables) {
    if (!isObj(t)) return undefined;
    const { index, rows, cols, firstRowHeaderRepeat, cantSplitRows, headerText } = t;
    if (!isCount(index) || !isCount(rows) || !isCount(cols)) return undefined;
    if (!isBool(firstRowHeaderRepeat) || !isCount(cantSplitRows)) return undefined;
 // cantSplitRows 不能超过 rows:超过说明抽取层算错了,宁可判非法也不静默接受。
    if (cantSplitRows > rows) return undefined;
    if (headerText !== undefined && !isStr(headerText)) return undefined;
    okTables.push({
      index,
      rows,
      cols,
      firstRowHeaderRepeat,
      cantSplitRows,
      ...(headerText === undefined ? {} : { headerText }),
    });
  }
  const okImages: DocxImageFacts[] = [];
  for (const im of images) {
    if (!isObj(im)) return undefined;
    const { index, altText } = im;
    if (!isCount(index)) return undefined;
    if (altText !== undefined && !isStr(altText)) return undefined;
    okImages.push({ index, ...(altText === undefined ? {} : { altText }) });
  }
  return { tables: okTables, images: okImages, headings };
}

function asXlsxFacts(input: unknown): XlsxFacts | undefined {
  if (!isObj(input)) return undefined;
  const { sheets } = input;
  if (!Array.isArray(sheets)) return undefined;
  const ok: XlsxSheetFacts[] = [];
  for (const s of sheets) {
    if (!isObj(s)) return undefined;
    const { name, formulaCells, cachedFormulaCells, freezePane, printTitles, dimension } = s;
    if (!isStr(name) || name.trim() === "") return undefined;
    if (!isCount(formulaCells) || !isCount(cachedFormulaCells)) return undefined;
 // 缓存值不能多于公式数:超过说明抽取层把非公式单元格也算进来了。
    if (cachedFormulaCells > formulaCells) return undefined;
    if (!isBool(freezePane) || !isBool(printTitles)) return undefined;
    if (dimension !== undefined && !isStr(dimension)) return undefined;
    ok.push({
      name,
      formulaCells,
      cachedFormulaCells,
      freezePane,
      printTitles,
      ...(dimension === undefined ? {} : { dimension }),
    });
  }
  return { sheets: ok };
}

function asPptxFacts(input: unknown): PptxFacts | undefined {
  if (!isObj(input)) return undefined;
  const { slides } = input;
  if (!Array.isArray(slides)) return undefined;
  const ok: PptxSlideFacts[] = [];
  for (const s of slides) {
    if (!isObj(s)) return undefined;
    const { index, hasTitle, pictures, visibleShapes } = s;
    if (!isCount(index) || !isBool(hasTitle) || !isCount(visibleShapes)) return undefined;
    if (!Array.isArray(pictures)) return undefined;
    const pics: PptxPictureFacts[] = [];
    for (const p of pictures) {
      if (!isObj(p)) return undefined;
      const { index: pi, altText } = p;
      if (!isCount(pi)) return undefined;
      if (altText !== undefined && !isStr(altText)) return undefined;
      pics.push({ index: pi, ...(altText === undefined ? {} : { altText }) });
    }
    ok.push({ index, hasTitle, pictures: pics, visibleShapes });
  }
  return { slides: ok };
}

function asPdfFacts(input: unknown): PdfFacts | undefined {
  if (!isObj(input)) return undefined;
  const { headerOk, eofOk, encrypted, pageCount } = input;
  if (!isBool(headerOk) || !isBool(eofOk) || !isBool(encrypted)) return undefined;
 // 页数只允许非负整数或 -1(未知);其它负值/小数一律判非法。
  const pageOk = isCount(pageCount) || pageCount === -1;
  if (!pageOk) return undefined;
  return { headerOk, eofOk, encrypted, pageCount };
}

// ---------------------------------------------------------------------------
// 四个格式检查 + 汇总检查
// ---------------------------------------------------------------------------

/**
 * docx 规则:长表格首行重复表头(p1)、大表格行不跨页(p2)、图片 alt(p1)。
 * 只有一行的表格没有「跨页重复表头」的意义,不报 header 规则;rows≥5 才谈 cantSplit。
 */
export function checkDocx(input: unknown): FormatReport {
  const facts = asDocxFacts(input);
  if (!facts) {
    return invalid("DocxFacts 非法:tables/images/headings 缺失或字段类型不符", "docx");
  }
  const issues: FormatIssue[] = [];
  for (const t of facts.tables) {
    const loc = `docx.table[${t.index}]`;
    if (t.rows > 1 && !t.firstRowHeaderRepeat) {
      issues.push(
        issue(
          "FMT_DOCX_TBL_HEADER_REPEAT",
          loc,
          `表格 ${t.index} 有 ${t.rows} 行、${t.cols} 列,首行未设为重复标题行;翻页后读者看不到表头`,
        ),
      );
    }
    if (t.rows >= 5 && t.cantSplitRows < t.rows) {
      issues.push(
        issue(
          "FMT_DOCX_ROW_CANT_SPLIT",
          loc,
          `表格 ${t.index} 有 ${t.rows} 行,其中 ${t.rows - t.cantSplitRows} 行未禁止跨页断行;单行可能被页边界截断`,
        ),
      );
    }
  }
  for (const im of facts.images) {
    if (altMissing(im.altText)) {
      issues.push(
        issue("FMT_DOCX_IMAGE_ALT", `docx.image[${im.index}]`, `第 ${im.index} 张图片没有替代文本;读屏与归档检索都无法获取它的含义`),
      );
    }
  }
  return summarize(issues);
}

/**
 * xlsx 规则:公式无缓存值(p0)、宽表未冻结窗格(p2)、宽表未设打印标题(p2)。
 * 行列数只从 dimension 推:dimension 缺失时不能凭空判定「行数>30」,两条 p2 规则跳过而非猜。
 */
export function checkXlsx(input: unknown): FormatReport {
  const facts = asXlsxFacts(input);
  if (!facts) {
    return invalid("XlsxFacts 非法:sheets 缺失或 name/计数/布尔字段类型不符", "xlsx");
  }
  const issues: FormatIssue[] = [];
  for (const s of facts.sheets) {
    const loc = `xlsx.sheet[${s.name}]`;
    if (s.formulaCells > 0 && s.cachedFormulaCells < s.formulaCells) {
      issues.push(
        issue(
          "FMT_XLSX_FORMULA_CACHED",
          loc,
          `工作表 ${s.name} 有 ${s.formulaCells} 个公式单元格,其中 ${s.cachedFormulaCells} 个带缓存值;` +
            `缺缓存的 ${s.formulaCells - s.cachedFormulaCells} 个用 data_only 读出来是空白`,
        ),
      );
    }
    const dim = parseDimension(s.dimension);
    if (!dim) continue;
    if (!s.freezePane && dim.rows > 30) {
      issues.push(
        issue("FMT_XLSX_FREEZE_PANE", loc, `工作表 ${s.name} 有 ${dim.rows} 行且未冻结窗格;向下滚动后表头离开视野`),
      );
    }
    if (!s.printTitles && dim.cols > 6) {
      issues.push(
        issue("FMT_XLSX_PRINT_TITLES", loc, `工作表 ${s.name} 有 ${dim.cols} 列且未设置打印标题;打印时后续页没有表头`),
      );
    }
  }
  return summarize(issues);
}

/**
 * pptx 规则:非封面页缺标题占位符(p1)、图片缺 alt(p1)。
 * 封面按「数组第一张」判定,与 index 的 0/1 基无关(抽取层给 0 基还是 1 基都不会误报封面)。
 */
export function checkPptx(input: unknown): FormatReport {
  const facts = asPptxFacts(input);
  if (!facts) {
    return invalid("PptxFacts 非法:slides 缺失或 index/hasTitle/visibleShapes 类型不符", "pptx");
  }
  const issues: FormatIssue[] = [];
  facts.slides.forEach((s, i) => {
    const loc = `pptx.slide[${s.index}]`;
    if (i > 0 && !s.hasTitle) {
      issues.push(
        issue("FMT_PPTX_TITLE_MISSING", loc, `第 ${s.index} 页(第 ${i + 1} 张,非封面)没有标题占位符;大纲/跳转/自动目录都缺入口`),
      );
    }
    for (const p of s.pictures) {
      if (altMissing(p.altText)) {
        issues.push(
          issue("FMT_PPTX_ALT_TEXT", `${loc}.picture[${p.index}]`, `第 ${s.index} 页第 ${p.index} 张图片没有替代文本`),
        );
      }
    }
  });
  return summarize(issues);
}

/**
 * pdf 规则:加密(p0)、截断(p0)、零页(p0)、页数未知(p2)。
 * 页数未知是「诚实缺口」而不是通过:单独一条 p2 让调用方知道本次没覆盖页数事实。
 */
export function checkPdf(input: unknown): FormatReport {
  const facts = asPdfFacts(input);
  if (!facts) {
    return invalid("PdfFacts 非法:headerOk/eofOk/encrypted 必须是布尔,pageCount 必须是非负整数或 -1", "pdf");
  }
  const issues: FormatIssue[] = [];
  if (!facts.headerOk || !facts.eofOk) {
    const missing: string[] = [];
    if (!facts.headerOk) missing.push("%PDF- 头");
    if (!facts.eofOk) missing.push("%%EOF 尾标");
    issues.push(
      issue("FMT_PDF_TRUNCATED", "pdf.bytes", `PDF 文件不完整:缺少${missing.join("与")};通常是被截断的半成品`),
    );
  }
  if (facts.encrypted) {
    issues.push(issue("FMT_PDF_ENCRYPTED", "pdf.trailer", "PDF 含 /Encrypt(已加密);离线导出后无法无损编辑与抽取文本"));
  }
  if (facts.pageCount === 0) {
    issues.push(issue("FMT_PDF_NO_PAGES", "pdf.pages", "PDF 页数为 0;零页文件无法交付"));
  } else if (facts.pageCount === -1) {
    issues.push(
      issue("FMT_PDF_PAGE_SCAN_UNKNOWN", "pdf.pages", "PDF 页数无法确定(对象流压缩);本次检查不猜测页数,页数事实未覆盖"),
    );
  }
  return summarize(issues);
}

/**
 * 汇总检查:按 docx → xlsx → pptx → pdf 固定顺序合并(顺序稳定 = 输出稳定)。
 * 任一部件非法 → 整体 code=FORMAT_INVALID(契约问题优先级最高),verdict 仍是 fail。
 * 未传的部件不检查({} 是合法的「什么都没检查」,返回 pass)。
 */
export function checkAll(parts: unknown): FormatReport {
  if (!isObj(parts)) {
    return invalid("checkAll 入参必须是 {docx?,xlsx?,pptx?,pdf?} 对象", "input");
  }
  const p = parts as FormatParts;
  const issues: FormatIssue[] = [];
  let anyInvalid = false;
  const take = (report: FormatReport): void => {
    for (const it of report.issues) issues.push(it);
    if (report.code === FORMAT_INVALID) anyInvalid = true;
  };
  if (p.docx !== undefined) take(checkDocx(p.docx));
  if (p.xlsx !== undefined) take(checkXlsx(p.xlsx));
  if (p.pptx !== undefined) take(checkPptx(p.pptx));
  if (p.pdf !== undefined) take(checkPdf(p.pdf));
  const report = summarize(issues);
  if (!anyInvalid) return report;
  return { ...report, code: FORMAT_INVALID, ok: false, verdict: "fail" };
}
