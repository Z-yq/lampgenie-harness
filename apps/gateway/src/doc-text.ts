/**
 * 附件文档解析器(附件链路第一步)。
 * 为什么单独一层:附件(用户在会话里贴进来的 docx/pptx/xlsx/pdf/zip/文本)要走「先变成纯文本 →
 * 再注入上下文」这条路,而不是把二进制塞给模型。这里只负责**文件 → 文本**,不做决策、不做路由
 * (panel / agent-wiring 侧怎么用由各自模块接)。
 * 设计取舍:
 *  - docx/pptx 复用 ./office-ooxml.js 的 parseOffice(已有 AST,不重复解 zip/XML);
 *  - xlsx 走最小可用版(jsszip + 手写 XML 树),不引新依赖;
 *  - pdf 自研最小解压(Flate / ASCII85)+ Tj/TJ 抽取,字符串支持 `(...)` 与 `<...>` 两种写法,
 *    `<...>` 十六进制串按「ToUnicode CMap → UTF-16BE → latin1」顺序解码;拿不到可见正文时
 * 如用户反馈「无文本层/正文过少」,绝不编造内容;
 *  - 任何输入都必须返回 DocParseResult,**绝不抛错**(上层是会话主链路,一抛整轮挂)。
 */
import { readFile } from "node:fs/promises";
import { inflateRawSync, inflateSync } from "node:zlib";
import JSZip from "jszip";
import { parseOffice, parseXmlTree, getExternalLinkStats, type OfficeBlock, type OfficeShape } from "./office-ooxml.js";
import { probeDocument, probeVerdictToErrorCode, isPathWithinRoot, type DocProbeResult } from "./doc-probe.js";

export type DocParseResult =
  | { ok: true; text: string; kind: "docx" | "pptx" | "xlsx" | "pdf" | "zip" | "text"; note?: string; scanSuspected?: boolean }
  | { ok: false; reason: string; kind?: string };

/** 可解析扩展名(小写、不带点)。 */
export const DOC_PARSE_EXT: Set<string> = new Set([
  "docx", "pptx", "xlsx", "pdf", "zip",
  "md", "markdown", "txt", "log", "json", "jsonc", "csv", "tsv", "html", "htm", "xml",
  "yaml", "yml", "ini", "toml", "conf", "sh", "sql", "css", "js", "ts", "py", "go", "rs", "java",
]);

/** 单文件上限:整包读进内存才可解,再大就是内存炸弹(与 office-ooxml 的 128MB 口径各自独立)。 */
export const DOC_MAX_BYTES = 64 * 1024 * 1024;

/** 文本类缺省字符上限(maxChars 可覆盖)。 */
const TEXT_MAX_CHARS = 100_000;
/** 文本类字节上限:超过就只解前 200KB(与字符上限双保险)。 */
const TEXT_MAX_BYTES = 200 * 1024;
/** xlsx 截断口径。 */
const XLSX_MAX_SHEETS = 10;
const XLSX_MAX_ROWS = 500;
const XLSX_MAX_COLS = 40;
/** zip 目录条目上限。 */
const ZIP_MAX_ENTRIES = 500;

function normExt(ext: string): string {
  return String(ext ?? "").trim().toLowerCase().replace(/^\.+/, "");
}

function extOfName(name: string): string {
  const n = String(name ?? "").replace(/\\/g, "/");
  const base = n.split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i < 0 ? "" : normExt(base.slice(i + 1));
}

/** 大小写不敏感,接受带点或不带点("DOCX" / ".docx" / "docx" 都认)。 */
export function isDocExt(ext: string): boolean {
  const e = normExt(ext);
  return e.length > 0 && DOC_PARSE_EXT.has(e);
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message || e.name || "unknown";
  return String(e);
}

// ───────────────────────── 轻量 XML helpers(复用 office-ooxml 的树,不引解析器) ─────────────────────────
type XmlNode = Exclude<ReturnType<typeof parseXmlTree>["kids"][number], string>;

function lname(nm: string): string {
  const i = nm.indexOf(":");
  return i < 0 ? nm : nm.slice(i + 1);
}
function attr(n: XmlNode | undefined, name: string): string | undefined {
  if (!n) return undefined;
  const exact = n.attrs[name];
  if (exact !== undefined) return exact;
  for (const k of Object.keys(n.attrs)) {
    const v = n.attrs[k];
    if (lname(k) === name && v !== undefined) return v;
  }
  return undefined;
}
function childOf(n: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!n) return undefined;
  for (const k of n.kids) if (typeof k !== "string" && lname(k.name) === name) return k;
  return undefined;
}
function kidsOf(n: XmlNode | undefined, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  if (!n) return out;
  for (const k of n.kids) if (typeof k !== "string" && lname(k.name) === name) out.push(k);
  return out;
}
function findAllNodes(n: XmlNode | undefined, name: string, acc: XmlNode[] = []): XmlNode[] {
  if (!n) return acc;
  for (const k of n.kids) {
    if (typeof k === "string") continue;
    if (lname(k.name) === name) acc.push(k);
    findAllNodes(k, name, acc);
  }
  return acc;
}
function textOfNode(n: XmlNode | undefined): string {
  if (!n) return "";
  let s = "";
  for (const k of n.kids) s += typeof k === "string" ? k : textOfNode(k);
  return s;
}

// ───────────────────────── 入口 ─────────────────────────
/** 解析一个附件文件为纯文本。**永不抛错**:失败一律 { ok:false, reason }。 */
export async function parseDocFile(
  path: string,
  opts?: { name?: string; mime?: string; maxChars?: number; roots?: string[] },
): Promise<DocParseResult> {
  const nameHint = String(opts?.name || path || "");
  const ext = extOfName(nameHint) || extOfName(String(path || ""));
 // 路径围栏(:传了 roots 时附件路径必须落在任一允许根内,全不命中直接拒(不读文件);
 // 不传 / 传空数组 = 旧行为逐字不变。
  if (opts?.roots && opts.roots.length > 0) {
    const withinRoot = opts.roots.some((root) => isPathWithinRoot(path, root));
    if (!withinRoot) return { ok: false, reason: "DOC_PATH_OUT_OF_ROOT: 附件路径不在允许根内", kind: ext };
  }
  try {
    let buf: Buffer;
    try {
      const raw = await readFile(path);
      buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    } catch (e) {
      return { ok: false, reason: `读取失败:${errMsg(e)}`, kind: ext || undefined };
    }
    if (buf.length > DOC_MAX_BYTES) return { ok: false, reason: `DOC_TOO_LARGE: 文件过大(>${Math.round(DOC_MAX_BYTES / 1024 / 1024)}MB)`, kind: ext || undefined };
    if (!ext || !DOC_PARSE_EXT.has(ext)) {
      return { ok: false, reason: `不支持解析的类型:${ext || "(无扩展名)"}`, kind: ext };
    }
 // 解析前先探测:加密/损坏/炸弹/超大在解压前就拦下。
 // 为什么必须先探:等解析器崩了才发现损坏/炸弹,进程可能已经吃满内存;
 // 而 0 字符提取如果直接返回 ok:true,上层会把「扫描件没抽到字」当成「文件为空」——这不是成功。
    const probe: DocProbeResult | undefined = PROBED_EXT.has(ext)
      ? probeDocument(buf, ext, { maxBytes: DOC_MAX_BYTES })
      : undefined;
    if (probe && probe.code !== "OK") {
      return { ok: false, reason: probeErrorReason(probe, ext), kind: ext };
    }
    if (ext === "docx" || ext === "pptx") {
      const r = await flattenOffice(buf, ext);
      return finalizeOk(r.text, ext, probe, r.note);
    }
    if (ext === "xlsx") {
      const r = await flattenXlsx(buf);
      return finalizeOk(r.text, "xlsx", probe, r.note);
    }
    if (ext === "pdf") {
      const r = flattenPdf(buf);
      if (!r.text) return { ok: false, reason: "PDF 无文本层(疑似扫描件),请转图片后用 view_image", kind: "pdf" };
      // 3 个字符的成功不算成功:扫描件常能抽到零星可打印残留
      if (countVisibleChars(r.text) < PDF_MIN_VISIBLE_CHARS) {
        return { ok: false, reason: "PDF 正文过少(<8 可见字符),疑似扫描件或无文本层", kind: "pdf" };
      }
      return finalizeOk(r.text, "pdf", probe, r.note);
    }
    if (ext === "zip") {
      const r = await listZip(buf);
      return { ok: true, text: r.text, kind: "zip", ...(r.note ? { note: r.note } : {}) };
    }
    const r = plainText(buf, opts?.maxChars);
    return { ok: true, text: r.text, kind: "text", ...(r.note ? { note: r.note } : {}) };
  } catch (e) {
    return { ok: false, reason: `解析失败:${errMsg(e).slice(0, 120)}`, kind: ext || undefined };
  }
}

// ───────────────────────── 探测接线 ─────────────────────────
/** 走 probeDocument 的扩展名(文本类由 plainText 处理,不探测)。 */
const PROBED_EXT = new Set(["docx", "pptx", "xlsx", "pdf"]);

/** 探测结论 → 带专门错误码前缀的中文原因(上层据此分支/提示)。 */
function probeErrorReason(probe: DocProbeResult, ext: string): string {
  const code = probeVerdictToErrorCode(probe.code) || "DOC_PROBE_FAILED";
  switch (probe.code) {
    case "ENCRYPTED":
      return `${code}: 文件已加密,请先去除密码后再上传`;
    case "CORRUPT":
      return `${code}: 文件结构损坏或不是有效的 ${ext.toUpperCase()} 文件`;
    case "ZIP_BOMB":
      return `${code}: 压缩包解压后体积超过上限(疑似 zip 炸弹)`;
    case "TOO_LARGE":
      return `${code}: 文件过大(>${Math.round(DOC_MAX_BYTES / 1024 / 1024)}MB)`;
    case "UNSUPPORTED":
      return `${code}: 不支持解析的类型`;
    default:
      return `${code}: 探测未通过`;
  }
}

const SCAN_SUSPECTED_NOTE = "疑似扫描件/无文本层,请转图片后用 view_image";

/**
 * ok 分支统一:在既有 note 上追加页数/字符密度、不安全外链丢弃数、扫描件警告。
 * 为什么 <8 可见字符要显式标 scanSuspected:0 字符不是「空文件」,是「没解析出文本层」,
 * 上层应该走 OCR/看图路径,而不是把空字符串当正文喂给模型。
 */
function finalizeOk(
  text: string,
  kind: "docx" | "pptx" | "xlsx" | "pdf",
  probe: DocProbeResult | undefined,
  baseNote?: string): DocParseResult {
  const notes: string[] = [];
  if (baseNote) notes.push(...baseNote.split(";").filter(Boolean));
  if (probe?.pages && probe.pages > 0) {
    const perPage = Math.round(countVisibleChars(text) / probe.pages);
    notes.push(`共 ${probe.pages} 页,约 ${perPage} 字/页`);
  }
  const probeDenied = probe ? probe.externalLinks.filter((l) => !l.allowed).length : 0;
  const officeDenied = kind === "docx" || kind === "pptx" ? getExternalLinkStats().denied : 0;
  const dropped = Math.max(probeDenied, officeDenied);
  if (dropped > 0) notes.push(`已丢弃 ${dropped} 个不安全外链`);
  let scanSuspected = false;
  if (countVisibleChars(text) < PDF_MIN_VISIBLE_CHARS) {
    notes.push(SCAN_SUSPECTED_NOTE);
    scanSuspected = true;
  }
  return {
    ok: true,
    text,
    kind,
    ...(notes.length ? { note: notes.join(";") } : {}),
    ...(scanSuspected ? { scanSuspected: true } : {}),
  };
}

// ───────────────────────── 文本类 ─────────────────────────
function plainText(buf: Buffer, maxChars?: number): { text: string; note?: string } {
  const cap = typeof maxChars === "number" && maxChars > 0 ? Math.floor(maxChars) : TEXT_MAX_CHARS;
  const cut = buf.length > TEXT_MAX_BYTES ? buf.subarray(0, TEXT_MAX_BYTES) : buf;
  let text = cut.toString("utf8");
  const notes: string[] = [];
  if (buf.length > TEXT_MAX_BYTES && !(typeof maxChars === "number" && maxChars > 0)) notes.push("已截断");
  if (text.length > cap) {
    text = text.slice(0, cap);
    if (notes.indexOf("已截断") < 0) notes.push("已截断");
  }
  return { text, ...(notes.length ? { note: notes.join(";") } : {}) };
}

// ───────────────────────── DOCX / PPTX(复用 parseOffice AST) ─────────────────────────
async function flattenOffice(buf: Buffer, ext: "docx" | "pptx"): Promise<{ text: string; note?: string }> {
  const ast = await parseOffice(buf, ext === "docx" ? ".docx" : ".pptx", {});
  if (ast.kind === "pptx") {
    const lines: string[] = [];
    for (const slide of ast.slides) {
      lines.push(`=== 第 ${slide.index} 页 ===`);
      for (const sh of slide.shapes) lines.push(...shapeLines(sh));
      const notes = slideNotes(slide);
      if (notes) lines.push(`[备注] ${notes}`);
    }
    return { text: lines.join("\n") };
  }
  const lines: string[] = [];
  for (const b of ast.blocks) lines.push(...blockLines(b));
  const sections: [string, OfficeBlock[] | undefined][] = [
    ["页眉", ast.headers], ["页脚", ast.footers], ["脚注", ast.footnotes],
  ];
  for (const [label, arr] of sections) {
    if (!arr || !arr.length) continue;
    lines.push(`=== ${label} ===`);
    for (const b of arr) lines.push(...blockLines(b));
  }
  return { text: lines.join("\n") };
}

/** pptx 单 shape → 文本行(表格 rows 用 " | " 连;文本优先 shape.text,回落到 runs)。 */
function shapeLines(sh: OfficeShape): string[] {
  const out: string[] = [];
  if (sh.table) {
    for (const row of sh.table.rows || []) {
      const cells = (row.cells || []).map((c) => String(c.text ?? "").trim());
      const line = cells.join(" | ").trim();
      if (line.replace(/\s|\|/g, "")) out.push(line);
    }
    return out;
  }
  const text = shapeText(sh);
  if (text) out.push(text);
  return out;
}
function shapeText(sh: OfficeShape): string {
  const direct = String(sh.text ?? "").trim();
  if (direct) return direct;
  return (sh.runs || []).map((r) => String(r.text ?? "")).join("").trim();
}
/** notes 不是 OfficeSlide 的既有字段(AST v2),但按契约「若 AST 有则输出」:运行时探测。 */
function slideNotes(slide: unknown): string {
  const raw = (slide as { notes?: unknown } | null)?.notes;
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) return raw.map((x) => String(x ?? "").trim()).filter(Boolean).join(" / ");
  return "";
}

/** docx 单 block → 文本行:heading 加 # 前缀、表格 " | " 连、批注 "[批注] …"。 */
function blockLines(b: OfficeBlock): string[] {
  if (b.type === "table") {
    const rows = b.rows || [];
    const out: string[] = [];
    for (const r of rows) {
      const line = (r || []).map((c) => String(c ?? "").trim()).join(" | ").trim();
      if (line.replace(/\s|\|/g, "")) out.push(line);
    }
    return out;
  }
  if (b.type === "unsupported") return [];
  const text = (b.runs || []).map((r) => String(r.text ?? "")).join("");
  const lvl = headingLevel(b.style);
  const out: string[] = [];
  const body = lvl ? `${"#".repeat(lvl)} ${text.trimStart()}` : text;
  if (body.trim()) out.push(body);
  for (const c of b.comments || []) out.push(`[批注] ${c}`);
  return out;
}
/** 段落样式 → heading 级别;非 heading 样式返回 0(不加前缀);是 heading 但取不到级别 → 2(##)。 */
function headingLevel(style?: string): number {
  const s = String(style || "").trim();
  if (!s) return 0;
  const m = /(?:heading|标题|titre|überschrift)\s*_?-?\s*([1-9])/i.exec(s);
  if (m && m[1]) return Math.min(6, Number(m[1]) || 2);
  if (/^(?:heading|标题)\w*$/i.test(s)) return 2;
  if (/^h[1-6]$/i.test(s)) return Number(s.slice(1));
  if (/^[1-9]$/.test(s)) return Number(s); // Word 中文版内置样式名就是 "1"/"2"
  return 0;
}

// ───────────────────────── XLSX(最小可用版) ─────────────────────────
async function flattenXlsx(buf: Buffer): Promise<{ text: string; note?: string }> {
  const zip = await JSZip.loadAsync(buf);
  const shared = await readSharedStrings(zip);
  const names = await readSheetNames(zip);
  const parts = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => sheetNo(a) - sheetNo(b));
  const notes: string[] = [];
  const lines: string[] = [];
  if (!parts.length) notes.push("未找到工作表(xl/worksheets/sheetN.xml)");
  const useParts = parts.slice(0, XLSX_MAX_SHEETS);
  if (parts.length > XLSX_MAX_SHEETS) notes.push(`工作表 ${parts.length} 张超过上限 ${XLSX_MAX_SHEETS},已截断`);
  for (let k = 0; k < useParts.length; k++) {
    const part = useParts[k] as string;
    const xml = await zip.file(part)?.async("string");
    const label = names[k] || `Sheet${k + 1}`;
    lines.push(`=== Sheet: ${label} ===`);
    if (!xml) continue;
    const rows = findAllNodes(parseXmlTree(xml), "row");
    let cutRows = false;
    let cutCols = false;
    for (let r = 0; r < rows.length; r++) {
      if (r >= XLSX_MAX_ROWS) { cutRows = true; break; }
      const row = rows[r] as XmlNode;
      const cells = kidsOf(row, "c");
      const grid: string[] = [];
      for (let ci = 0; ci < cells.length; ci++) {
        const c = cells[ci] as XmlNode;
        const val = cellText(c, shared);
        if (!val) continue;
        const col = colIndex(attr(c, "r"), ci);
        if (col >= XLSX_MAX_COLS) { cutCols = true; continue; }
        while (grid.length < col) grid.push("");
        grid[col] = val;
      }
      lines.push(trimCells(grid).join("\t"));
    }
    if (cutRows) notes.push(`Sheet ${label} 行数超过 ${XLSX_MAX_ROWS},已截断`);
    if (cutCols) notes.push(`Sheet ${label} 列数超过 ${XLSX_MAX_COLS},已截断`);
  }
  return { text: lines.join("\n"), ...(notes.length ? { note: notes.join(";") } : {}) };
}

function sheetNo(name: string): number {
  const m = /sheet(\d+)\.xml$/.exec(name);
  return m && m[1] ? Number(m[1]) : 0;
}
function trimCells(grid: string[]): string[] {
  const out = grid.slice();
  while (out.length && !String(out[out.length - 1] ?? "").trim()) out.pop();
  return out.map((v) => String(v ?? "").replace(/[\t\r\n]+/g, " ").trim());
}
/** "C5" → 2;取不到 r 属性就按所在顺序 ci。 */
function colIndex(ref: string | undefined, ci: number): number {
  const m = /^([A-Za-z]+)/.exec(String(ref || ""));
  if (!m || !m[1]) return ci;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}
function cellText(c: XmlNode, shared: string[]): string {
  const t = String(attr(c, "t") || "");
  const v = childOf(c, "v");
  if (t === "s") {
    const idx = Number(textOfNode(v).trim());
    const s = isFinite(idx) ? shared[idx] : undefined;
    return String(s ?? "").trim();
  }
  if (t === "inlineStr") return (textOfNode(childOf(c, "is")) || textOfNode(v)).trim();
  if (t === "b") return textOfNode(v).trim() === "1" ? "TRUE" : "FALSE";
  return textOfNode(v).trim();
}
async function readSharedStrings(zip: JSZip): Promise<string[]> {
  const xml = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (!xml) return [];
  const out: string[] = [];
  for (const si of findAllNodes(parseXmlTree(xml), "si")) {
    // 只取 t 节点(跳过 rPh 注音里的 rPr/t 会重复,但最小可用版可接受)
    const ts = findAllNodes(si, "t");
    const s = ts.length ? ts.map((n) => textOfNode(n)).join("") : textOfNode(si);
    out.push(s);
  }
  return out;
}
async function readSheetNames(zip: JSZip): Promise<string[]> {
  const xml = await zip.file("xl/workbook.xml")?.async("string");
  if (!xml) return [];
  const out: string[] = [];
  for (const sh of findAllNodes(parseXmlTree(xml), "sheet")) {
    const nm = String(attr(sh, "name") || "").trim();
    if (nm) out.push(nm);
  }
  return out;
}

// ───────────────────────── PDF(最小抽取:`(...)` 与 `<...>` 双语法 + ToUnicode) ─────────────────────────
/**
 * 口径与上限:
 *  - 单 CMap ≤ 8192 条映射、总 CMap ≤ 32 个,超限截断(防恶意超大 CMap 撑爆内存);
 *  - 可见字符 < 8 一律判 ok:false(「正文过少」):3 个字符不算抽取成功;
 *  - 不引外部依赖:Flate 走 node:zlib,ASCII85 自研,CMap 手工解析。
 * 注意(不要「优化」掉):`/F9 9 Tf … (F0 STSong-Light UniGB-UCS2-H) Tj` 这类**字体标注行是页面
 * 上真实印出来的字**,是正文的一部分,必须照抽。别为了「看起来更像正文」把它过滤掉。
 */
const PDF_CMAP_MAX_MAPPINGS = 8192;
const PDF_CMAP_MAX_FONTS = 32;
/** 正文可见字符下限(见上方口径)。 */
const PDF_MIN_VISIBLE_CHARS = 8;

/** 一份 ToUnicode CMap:code(按 codeLen 字节大端)→ Unicode 串。 */
type PdfCmap = { map: Map<number, string>; codeLen: number };

/** 扫所有 stream…endstream:解压 → 抽 Tj/TJ(字面量与十六进制串都抽)。 */
function flattenPdf(buf: Buffer): { text: string; note?: string } {
  const src = buf.toString("latin1"); // latin1 与字节 1:1,便于按字节偏移切 stream
  const objs = pdfObjectIndex(src);
  const cmaps = pdfFontCMaps(objs);
  const chunks: string[] = [];
  let idx = 0;
  for (;;) {
    const s = src.indexOf("stream", idx);
    if (s < 0) break;
    if (s >= 3 && src.slice(s - 3, s) === "end") { idx = s + 6; continue; }
    let start = s + 6;
    if (src[start] === "\r") start++;
    if (src[start] === "\n") start++;
    const e = src.indexOf("endstream", start);
    if (e < 0) break;
    let end = e;
    if (src[end - 1] === "\n") end--;
    if (src[end - 1] === "\r") end--;
    idx = e + 9;
    if (end <= start) continue;
    const dict = pdfStreamDict(src, s);
    // 图片/嵌入字库/元数据流不是正文,跳过(否则二进制会被当文本抽出来)
    if (/\/Subtype\s*\/(?:Image|Type1C|CIDFontType0C|OpenType|XML)\b/.test(dict)) continue;
    if (/\/FontFile[23]?\b/.test(dict)) continue;
    const content = decodePdfStream(buf.subarray(start, end), dict);
    if (!content) continue;
    // 只认真正绘制文字的流:CMap 里的 <0000> <FFFF> 会被误当正文串
    if (!/BT|Tj|TJ/.test(content) || /begincmap|beginbfchar|beginbfrange/.test(content)) continue;
    const t = pdfContentText(content, cmaps);
    if (t.trim()) chunks.push(t);
  }
  const text = chunks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const notes: string[] = [];
  if (text && hasCjk(text)) {
    notes.push(cmaps.size > 0 ? "已按 ToUnicode 解码" : "PDF 无 ToUnicode,中文可能乱码或缺失");
  }
  return { text, ...(notes.length ? { note: notes.join(";") } : {}) };
}

/** 内容流 → 文本:Tj/TJ 取串(字面量 + 十六进制);Td/TD/T星号/Tm/ET/BT 视为换行;Tf 切当前字体。 */
function pdfContentText(src: string, cmaps: Map<string, PdfCmap>): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let arr: string[] | null = null;
  let last = "";
  let lastName = "";
  let curCmap: PdfCmap | null = null;
  const brk = (): void => { if (out && !out.endsWith("\n")) out += "\n"; };
  const push = (v: string): void => {
    if (!v) return;
    last = v;
    if (arr) arr.push(v);
  };
  while (i < n) {
    const ch = src[i];
    if (ch === "/") { // 资源名:/F0
      let j = i + 1;
      while (j < n && !/[\s/\[\]<>(){}%]/.test(src[j] as string)) j++;
      lastName = src.slice(i + 1, j);
      i = j;
      continue;
    }
    if (ch === "(") {
      const r = readPdfLiteral(src, i);
      push(decodePdfBytes(Buffer.from(r.value, "latin1"), curCmap));
      i = r.end;
      continue;
    }
    if (ch === "<") {
      if (src[i + 1] === "<") { i += 2; continue; } // 内联字典 << >>,不是字符串
      const r = readPdfHex(src, i);
      push(decodePdfBytes(r.bytes, curCmap));
      i = r.end;
      continue;
    }
    if (ch === "[") { arr = []; i++; continue; }
    if (ch === "]") { if (arr) { last = arr.join(""); arr = null; } i++; continue; }
    if (ch !== undefined && /[A-Za-z'"*]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z*'"]/.test(src[j] as string)) j++;
      const op = src.slice(i, j);
      if (op === "Tf") {
        curCmap = (lastName && cmaps.get(lastName)) || null;
      } else if (op === "Tj" || op === "TJ" || op === "'" || op === "\"") {
        if (last) out += last;
        last = "";
        if (op === "'" || op === "\"") brk();
      } else if (op === "Td" || op === "TD" || op === "T*" || op === "Tm" || op === "ET" || op === "BT") {
        brk();
      }
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * 一个 PDF 串(字节)→ 文本。顺序:CMap(该字体有 ToUnicode 时)→ 纯 ASCII 原样 →
 * UTF-16BE(偶数长且每个码元都是可打印/常见 CJK)→ latin1(控制字转空格)。
 * 解出来全是控制字符/空白 → 返回空串(该串判为不可读,跳过)。
 */
function decodePdfBytes(bytes: Buffer, cmap: PdfCmap | null): string {
  if (!bytes.length) return "";
  if (cmap) {
    let s = "";
    const len = Math.max(1, Math.min(4, cmap.codeLen || 2));
    for (let i = 0; i + len <= bytes.length; i += len) {
      let code = 0;
      for (let k = 0; k < len; k++) code = (code << 8) | (bytes[i + k] as number);
      const v = cmap.map.get(code);
      if (v !== undefined) s += v;
    }
    if (s && !isUnreadable(s)) return s; // CMap 覆盖不到任何码位时才回落启发式
  }
  let s: string;
  if (isPlainAscii(bytes)) s = bytes.toString("latin1");
  else if (isUtf16BeText(bytes)) s = utf16BeToStr(bytes.toString("hex"));
  else s = latin1Clean(bytes);
  return isUnreadable(s) ? "" : s;
}

/** 全是 ASCII 可打印(含常见空白)→ 直接 latin1,避免偶数长 ASCII 被误判成 UTF-16BE。 */
function isPlainAscii(bytes: Buffer): boolean {
  for (const b of bytes) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b > 0x7e) return false;
  }
  return true;
}

/** UTF-16BE 可信度判定:偶数长度,且每个 16-bit 码元都可打印或是常见 CJK 区段。 */
function isUtf16BeText(bytes: Buffer): boolean {
  if (bytes.length < 2 || bytes.length % 2 !== 0) return false;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (!isCommonCjkUnit(((bytes[i] as number) << 8) | (bytes[i + 1] as number))) return false;
  }
  return true;
}

function isCommonCjkUnit(u: number): boolean {
  return (u >= 0x20 && u <= 0x7e)
    || (u >= 0x4e00 && u <= 0x9fff)
    || (u >= 0x3000 && u <= 0x303f)
    || (u >= 0xff00 && u <= 0xffef)
    || (u >= 0x2000 && u <= 0x206f)
    || u === 0x09 || u === 0x0a || u === 0x0d;
}

/** 十六进制串(4 位/码元)→ 字符串。 */
function utf16BeToStr(hex: string): string {
  let out = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

/** 逐字节 latin1:可打印保留,控制字转空格。 */
function latin1Clean(bytes: Buffer): string {
  let out = "";
  for (const b of bytes) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) { out += " "; continue; }
    out += (b < 0x20 || (b >= 0x7f && b <= 0x9f)) ? " " : String.fromCharCode(b);
  }
  return out;
}

/** 全是控制字符/空白 → 不可读。 */
function isUnreadable(s: string): boolean {
  if (!s) return true;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c > 0x1f && c !== 0x7f && !(c >= 0x80 && c <= 0x9f) && !/\s/.test(ch)) return false;
  }
  return true;
}

/** 可见字符数(非控制、非空白)。用于「正文过少」闸门。 */
function countVisibleChars(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c > 0x1f && c !== 0x7f && !(c >= 0x80 && c <= 0x9f) && !/\s/.test(ch)) n++;
  }
  return n;
}

function hasCjk(s: string): boolean {
  return /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF60]/.test(s);
}

// ── PDF 对象索引 / 字体 → CMap(不引外部依赖,按 obj 文本粗解析) ──

/** `N 0 obj … endobj` → N → 对象体(重复定义时后者覆盖,兼容增量更新)。 */
function pdfObjectIndex(src: string): Map<number, string> {
  const out = new Map<number, string>();
  const re = /(\d+)\s+0\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const e = src.indexOf("endobj", start);
    out.set(Number(m[1]), src.slice(start, e < 0 ? src.length : e));
  }
  return out;
}

/** 字体资源名(/F0 …)→ ToUnicode CMap。没有 /ToUnicode 的字体不进 map(回落启发式)。 */
function pdfFontCMaps(objs: Map<number, string>): Map<string, PdfCmap> {
  const out = new Map<string, PdfCmap>();
  const dicts: string[] = [];
  const bodies = Array.from(objs.values());
  for (let k = 0; k < bodies.length; k++) {
    const body = bodies[k] as string;
    if (body.indexOf("/Font") < 0) continue;
    const inline = /\/Font\s*<<([\s\S]{0,4000}?)>>/g;
    let m: RegExpExecArray | null;
    while ((m = inline.exec(body))) if (m[1]) dicts.push(m[1]);
    // `/Font 1 0 R`(间接引用一份字体名 → 对象的字典)
    const indirect = /\/Font\s+(\d+)\s+0\s+R/g;
    while ((m = indirect.exec(body))) {
      const sub = objs.get(Number(m[1]));
      if (sub) dicts.push(sub);
    }
  }
  for (let d = 0; d < dicts.length; d++) {
    const pairs = /\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+0\s+R/g;
    let p: RegExpExecArray | null;
    while ((p = pairs.exec(dicts[d] as string))) {
      const name = p[1] as string;
      if (out.has(name)) continue;
      if (out.size >= PDF_CMAP_MAX_FONTS) return out;
      const font = objs.get(Number(p[2]));
      if (!font) continue;
      const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(font);
      if (!tu) continue;
      const cmapObj = objs.get(Number(tu[1]));
      if (!cmapObj) continue;
      const text = pdfObjStreamText(cmapObj);
      if (!text) continue;
      const cmap = parseCmap(text);
      if (cmap.map.size) out.set(name, cmap);
    }
  }
  return out;
}

/** 对象体里的 stream → 解压后文本(CMap 流本身也可能 FlateDecode)。 */
function pdfObjStreamText(body: string): string | null {
  const s = body.indexOf("stream");
  if (s < 0) return null;
  let start = s + 6;
  if (body[start] === "\r") start++;
  if (body[start] === "\n") start++;
  const e = body.indexOf("endstream", start);
  if (e < 0) return null;
  let end = e;
  if (body[end - 1] === "\n") end--;
  if (body[end - 1] === "\r") end--;
  if (end <= start) return null;
  return decodePdfStream(Buffer.from(body.slice(start, end), "latin1"), pdfStreamDict(body, s));
}

/**
 * ToUnicode CMap → map。只认 beginbfchar(`<src> <dst>`)与 beginbfrange
 * (`<lo> <hi> <dst>` / `<lo> <hi> [<d1> <d2> …]`),条数超过上限即截断。
 */
function parseCmap(text: string): PdfCmap {
  const map = new Map<number, string>();
  let codeLen = 2;
  const csr = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (csr && csr[1]) {
    const lo = /<([0-9A-Fa-f]+)>/.exec(csr[1]);
    if (lo && lo[1]) codeLen = Math.max(1, Math.min(4, Math.ceil(lo[1].length / 2)));
  }
  const bc = /beginbfchar([\s\S]*?)endbfchar/g;
  let g: RegExpExecArray | null;
  while ((g = bc.exec(text))) {
    const body = g[1] ?? "";
    const pair = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
    let p: RegExpExecArray | null;
    while ((p = pair.exec(body))) {
      if (map.size >= PDF_CMAP_MAX_MAPPINGS) return { map, codeLen };
      map.set(parseInt(p[1] as string, 16), utf16BeToStr(p[2] ?? ""));
    }
  }
  const br = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((g = br.exec(text))) {
    const body = g[1] ?? "";
    // 数组形式:<lo> <hi> [<d1> <d2> …]
    const arrRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
    let a: RegExpExecArray | null;
    while ((a = arrRe.exec(body))) {
      const lo = parseInt(a[1] as string, 16);
      const hi = parseInt(a[2] as string, 16);
      const items = (a[3] ?? "").match(/<([0-9A-Fa-f]*)>/g) || [];
      for (let k = 0; k < items.length; k++) {
        if (map.size >= PDF_CMAP_MAX_MAPPINGS) return { map, codeLen };
        const code = lo + k;
        if (code > hi) break;
        map.set(code, utf16BeToStr(String(items[k]).replace(/[<>\s]/g, "")));
      }
    }
    // 单目标形式:<lo> <hi> <dst>(dst 是首字符 Unicode,逐个 +1)
    const oneRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let o: RegExpExecArray | null;
    while ((o = oneRe.exec(body))) {
      const lo = parseInt(o[1] as string, 16);
      const hi = parseInt(o[2] as string, 16);
      const dstHex = o[3] as string;
      if (dstHex.length <= 4) {
        const base = parseInt(dstHex, 16);
        for (let code = lo; code <= hi; code++) {
          if (map.size >= PDF_CMAP_MAX_MAPPINGS) return { map, codeLen };
          map.set(code, String.fromCharCode(base + (code - lo)));
        }
      } else if (!map.has(lo)) {
        map.set(lo, utf16BeToStr(dstHex)); // 多码元目标:只能整串给 lo
      }
    }
  }
  return { map, codeLen };
}

// ── 流解压(Flate / ASCII85) ──

/** stream 之前的字典原文(取最近的 `<<`)。 */
function pdfStreamDict(src: string, streamAt: number): string {
  const at = src.lastIndexOf("<<", streamAt);
  if (at < 0 || streamAt - at > 4000) return "";
  return src.slice(at, streamAt);
}

/** 字典里的 /Filter → 过滤器名列表(按应用顺序)。 */
function pdfFilters(dict: string): string[] {
  const m = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict);
  if (!m || !m[1]) return [];
  const out: string[] = [];
  const re = /\/([A-Za-z0-9]+)/g;
  let g: RegExpExecArray | null;
  while ((g = re.exec(m[1]))) if (g[1]) out.push(g[1]);
  return out;
}

/** 按 /Filter 链解压;不支持的过滤器返回 null(宁可少抽,不要抽垃圾)。 */
function decodePdfStream(raw: Buffer, dict: string): string | null {
  const filters = pdfFilters(dict);
  if (!filters.length) {
    if (/\/Filter/.test(dict)) return null; // 有 /Filter 但解不出名字 → 保守跳过
    return raw.toString("latin1"); // 未压缩内容流(最小 PDF 常见)
  }
  let cur: Buffer | null = raw;
  for (const f of filters) {
    if (!cur) return null;
    if (f === "FlateDecode" || f === "Fl") {
      let plain: Buffer | null = null;
      try { plain = inflateSync(cur); } catch { try { plain = inflateRawSync(cur); } catch { plain = null; } }
      cur = plain;
    } else if (f === "ASCII85Decode" || f === "A85") {
      cur = ascii85Decode(cur);
    } else {
      return null; // DCT/JPX/LZW/RunLength 等:不是文本
    }
  }
  return cur ? cur.toString("latin1") : null;
}

/** 最小 ASCII85 解码(PDF 里不带 `<~` 前缀,以 `~>` 结束)。 */
function ascii85Decode(raw: Buffer): Buffer | null {
  const out: number[] = [];
  let i = 0;
  if (raw[0] === 0x3c && raw[1] === 0x7e) i = 2;
  let group: number[] = [];
  for (; i < raw.length; i++) {
    const b = raw[i] as number;
    if (b === 0x7e) break; // ~> 结束
    if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c || b === 0x00) continue;
    if (b === 0x7a) { // 'z' → 四个 0
      if (group.length) return null;
      out.push(0, 0, 0, 0);
      continue;
    }
    if (b < 0x21 || b > 0x75) return null;
    group.push(b - 0x21);
    if (group.length === 5) {
      let v = 0;
      for (let k = 0; k < 5; k++) v = v * 85 + (group[k] as number);
      out.push(Math.floor(v / 16777216) % 256, Math.floor(v / 65536) % 256, Math.floor(v / 256) % 256, v % 256);
      group = [];
    }
  }
  if (group.length === 1) return null;
  if (group.length > 1) {
    const n = group.length;
    let v = 0;
    for (let k = 0; k < 5; k++) v = v * 85 + (k < n ? (group[k] as number) : 84);
    for (let k = 0; k < n - 1; k++) out.push(Math.floor(v / Math.pow(256, 3 - k)) % 256);
  }
  return Buffer.from(out);
}

/** PDF 字面量串(PDFDocEncoding/转义):\( \) \\ \n \t \r \b \f \ddd,行尾续行。 */
function readPdfLiteral(src: string, at: number): { value: string; end: number } {
  let out = "";
  let i = at + 1;
  const n = src.length;
  let depth = 1;
  while (i < n) {
    const ch = src[i] as string;
    if (ch === "\\") {
      const nx = src[i + 1] ?? "";
      if (nx === "n") { out += "\n"; i += 2; continue; }
      if (nx === "r") { out += "\r"; i += 2; continue; }
      if (nx === "t") { out += "\t"; i += 2; continue; }
      if (nx === "b") { out += "\b"; i += 2; continue; }
      if (nx === "f") { out += "\f"; i += 2; continue; }
      if (nx === "\n") { i += 2; continue; }
      if (nx === "\r") { i += src[i + 2] === "\n" ? 3 : 2; continue; }
      if (nx >= "0" && nx <= "7") {
        let oct = "";
        let j = i + 1;
        while (j < n && oct.length < 3 && (src[j] as string) >= "0" && (src[j] as string) <= "7") { oct += src[j]; j++; }
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        i = j;
        continue;
      }
      out += nx;
      i += 2;
      continue;
    }
    if (ch === "(") { depth++; out += ch; i++; continue; }
    if (ch === ")") { depth--; if (depth === 0) { i++; break; } out += ch; i++; continue; }
    out += ch;
    i++;
  }
  return { value: out, end: i };
}

/** PDF 十六进制串 `<5B8B4F53…>` → 字节(忽略空白,奇数尾位补 0)。 */
function readPdfHex(src: string, at: number): { bytes: Buffer; end: number } {
  let hex = "";
  let i = at + 1;
  const n = src.length;
  while (i < n) {
    const ch = src[i] as string;
    if (ch === ">") { i++; break; }
    if (/[0-9A-Fa-f]/.test(ch)) hex += ch;
    i++;
  }
  if (hex.length % 2) hex += "0"; // PDF 规定奇数位尾补 0
  return { bytes: Buffer.from(hex, "hex"), end: i };
}

// ───────────────────────── ZIP(只列目录树) ─────────────────────────
async function listZip(buf: Buffer): Promise<{ text: string; note?: string }> {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).sort();
  const notes: string[] = [];
  const lines: string[] = [`=== 归档目录(${names.length} 条) ===`];
  for (const nm of names.slice(0, ZIP_MAX_ENTRIES)) {
    const f = zip.files[nm] as JSZip.JSZipObject | undefined;
    if (!f) continue;
    const size = f.dir ? 0 : entrySize(f);
    const mt = f.date instanceof Date && !isNaN(f.date.getTime())
      ? f.date.toISOString().replace("T", " ").slice(0, 19)
      : "-";
    lines.push(`${nm}  ${size}  ${mt}`);
  }
  if (names.length > ZIP_MAX_ENTRIES) notes.push(`条目 ${names.length} 条超过上限 ${ZIP_MAX_ENTRIES},已截断`);
  const hint = zipHint(names);
  if (hint) { notes.push(hint); lines.push(hint); }
  return { text: lines.join("\n"), ...(notes.length ? { note: notes.join(";") } : {}) };
}
/** 解压后大小(jszip 内部字段,公开类型没暴露)。取不到退 0。 */
function entrySize(f: JSZip.JSZipObject): number {
  const d = (f as unknown as { _data?: { uncompressedSize?: number; compressedSize?: number } })._data;
  const n = Number(d?.uncompressedSize ?? d?.compressedSize ?? 0);
  return isFinite(n) && n > 0 ? n : 0;
}
function baseOf(p: string): string { return p.split("/").pop() || p; }
function zipHint(names: string[]): string {
  if (names.indexOf("word/document.xml") >= 0) return "这是 docx,后缀改成 .docx 可直接解析";
  if (names.indexOf("ppt/presentation.xml") >= 0) return "这是 pptx,后缀改成 .pptx 可直接解析";
  if (names.indexOf("xl/workbook.xml") >= 0) return "这是 xlsx,后缀改成 .xlsx 可直接解析";
  return "";
}