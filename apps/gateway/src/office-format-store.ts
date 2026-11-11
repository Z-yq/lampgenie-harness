/**
 * Office 格式级业务规则检查的**抽取层 + 持久层**(2026-11 #,生产侧)。
 * 分工(与既有 office-pdf-store / office-ooxml 同族):
 * - 纯逻辑裁决在 packages/harness-runtime/src/agent/office-format-rules.ts(零 IO、只吃「已抽取的事实」);
 * - 本模块把 OOXML/PDF 字节抽成那份事实(jszip 解包 + 手写 XML 树,不引 XML 解析器),
 * 再把「事实 + 裁决」原子落盘到 `<root>/.genie/office/format/`。
 * 为什么抽取层不 throw:
 * 抽取失败(不是 zip、缺 document.xml、OLE 加密包、坏 XML)是**文档本身的缺陷**,不是调用方的 bug,
 * 崩在这里会让「检查一份坏文件」变成「检查器不可用」。所以任何失败都折叠成 facts=null,
 * 由 checkAll 的 FORMAT_INVALID 路径统一裁决(exitCode 2),调用方永远拿得到结论。
 * 为什么产物是「一文件一 JSON + 追加式账本」:
 * - 产物 `<sha256 前 12>.json` 是**当下态的完整证据**(版本/sha256/文件/格式/裁决/事实/时间),
 * 同一 sha 重跑不重写(内容与代际都相同),崩溃最多丢掉最后一次未 rename 的写;
 * - `ledger.jsonl` 是**一行一次的归档索引**(sha/file/format/code/counts/at),同一 sha 已存在则不重复追加:
 * 连跑两次行数不变,人可以直接 `wc -l` 看「这台机器检查过多少份不同文件」。
 * 写临时文件 → renameSync 让「读到的永远是某一完整代」成立(与 office-pdf-store 同一套原子写)。
 * root 安全闸:产物必须落在 /tmp 下的绝对路径(realpath 后校验前缀)。检查器会往 root 里建目录写文件,
 * 一个手滑的 `--root /` 或 `--root .` 就会在仓里/系统目录里撒账本,所以闸门放在**一切写之前**:
 * 不合法直接回错误码,连目录都不建(拒收前零副作用)。
 * 依赖纪律:node:fs/node:path/node:crypto + jszip + 自带的轻量 XML 树(见 parseXmlLite 的说明:
 * 不能用同仓 office-ooxml 的 parseXmlTree,否则 node --experimental-strip-types 直跑的 CLI 起不来)
 * + runtime 纯逻辑(经 workspace 子路径导入,与 office-pdf-store 同一写法)。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";

import JSZip from "jszip";

import {
  checkAll,
  FORMAT_FAIL,
  FORMAT_INVALID,
  FORMAT_OK,
  FORMAT_RULES_VERSION,
  FORMAT_WARN,
  type DocxFacts,
  type FormatCode,
  type FormatReport,
  type PdfFacts,
  type PptxFacts,
  type XlsxFacts,
} from "@lampgenie/runtime/agent/office-format-rules";

/** store 层自产的失败码(裁决码沿用 runtime 的 FORMAT_*)。 */
export const OFFICE_FORMAT_STORE_CODES = [
  "OFFICE_FORMAT_ROOT_UNSAFE",
  "OFFICE_FORMAT_INPUT_EMPTY",
  "OFFICE_FORMAT_FILE_UNREADABLE",
] as const;

export type OfficeFormatStoreCode = (typeof OFFICE_FORMAT_STORE_CODES)[number];

/** 相对 root 的产物目录(与 .genie/rsi 同层,便于统一清理)。 */
export const OFFICE_FORMAT_RELATIVE_DIR = ".genie/office/format";
/** 追加式归档索引文件名。 */
export const OFFICE_FORMAT_LEDGER_FILE = "ledger.jsonl";
/** 只接受 /tmp 下的 root(realpath 后校验):产物一定是临时证据,不落仓、不落系统目录。 */
export const OFFICE_FORMAT_TMP_PREFIX = "/tmp/";

/** 支持的四种格式(稳定字符串,进产物与 CLI 输出)。 */
export type OfficeFormat = "docx" | "xlsx" | "pptx" | "pdf";

/** 一次抽取的结果:format=null 表示扩展名/内容都认不出,facts=null 表示抽取失败。 */
export interface OfficeExtract {
  format: OfficeFormat | null;
  facts: DocxFacts | XlsxFacts | PptxFacts | PdfFacts | null;
 /** 抽取失败原因(仅诊断用,不参与裁决;裁决只看 facts=null)。 */
  reason?: string;
}

/** 单文件检查结果(自足:裁决 + 事实 + 内容指纹)。 */
export interface FormatResultItem {
  file: string;
  sha256: string;
  format: OfficeFormat | null;
  report: FormatReport;
  facts: DocxFacts | XlsxFacts | PptxFacts | PdfFacts | null;
}

/** runFormatCheck 的入参:root(产物根)+ files(待检查文件绝对/相对路径)。 */
export interface RunFormatCheckOptions {
  root: string;
  files: readonly string[];
}

/** runFormatCheck 的返回:ok/exitCode 是给 CLI 的唯一权威,results 逐文件。 */
export interface RunFormatCheckOutput {
  ok: boolean;
  code: FormatCode | OfficeFormatStoreCode;
 /** 0 = pass/warn,2 = fail(任一 p0),1 = 参数/读取错误(不落盘)。 */
  exitCode: number;
  root: string;
  results: FormatResultItem[];
  error?: string;
}

/** 落盘产物的形状(稳定字段名,v=规则表版本)。 */
export interface OfficeFormatArtifact {
  v: number;
  sha256: string;
  file: string;
  format: OfficeFormat | null;
  report: FormatReport;
  facts: DocxFacts | XlsxFacts | PptxFacts | PdfFacts | null;
  at: string;
}

/** 账本一行的形状(索引字段,不含 issues)。 */
export interface OfficeFormatLedgerEntry {
  sha256: string;
  file: string;
  format: OfficeFormat | null;
  code: string;
  counts: { p0: number; p1: number; p2: number };
  at: string;
}

// ---------------------------------------------------------------------------
// 路径与安全闸
// ---------------------------------------------------------------------------

let tmpSeq = 0;

/** 产物目录(不落盘,只算路径)。 */
export function officeFormatPaths(root: string): { dir: string; ledger: string } {
  const dir = join(root, OFFICE_FORMAT_RELATIVE_DIR);
  return { dir, ledger: join(dir, OFFICE_FORMAT_LEDGER_FILE) };
}

/**
 * root 安全闸:必须是绝对路径,realpath 后落在 /tmp 下(或就是 /tmp)。
 * root 尚不存在时用 normalize 后的路径判定(建目录由调用方在闸门之后做)。
 */
export function resolveSafeRoot(root: string): { ok: true; root: string } | { ok: false; error: string } {
  if (typeof root !== "string" || root.trim() === "") return { ok: false, error: "root 必须是非空字符串" };
  if (!isAbsolute(root)) return { ok: false, error: `root 必须是绝对路径:${root}` };
  let real = resolvePath(root);
  try {
    if (existsSync(real)) real = realpathSync(real);
  } catch {
 /* realpath 失败(EACCES 等)保留 normalize 后的路径参与判定,不 throw */
  }
  const underTmp = real === "/tmp" || `${real}/`.startsWith(OFFICE_FORMAT_TMP_PREFIX);
  if (!underTmp) return { ok: false, error: `root 必须在 /tmp 下(realpath 后):${real}` };
  return { ok: true, root: real };
}

/** sha256 十六进制(产物文件名取前 12 位)。 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 按扩展名判格式(docm/xlsm/pptm 视作同一族;其它返回 null)。 */
export function resolveFormat(filePath: string): OfficeFormat | null {
  const lower = String(filePath ?? "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot < 0 ? "" : lower.slice(dot + 1);
  if (ext === "docx" || ext === "docm") return "docx";
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  if (ext === "pptx" || ext === "pptm") return "pptx";
  if (ext === "pdf") return "pdf";
  return null;
}

// ---------------------------------------------------------------------------
// 轻量 XML 树(自足实现,20 行够用)
// 为什么不用同仓 office-ooxml 的 parseXmlTree:那是 `.ts` 文件,而本模块会被
// scripts/office-format.mts 用 `node --experimental-strip-types` 直跑 —— 该加载器
// **不做 `.js`→`.ts` 的说明符重写**(经验证 import "./office-ooxml.js" → ERR_MODULE_NOT_FOUND),
// 一旦静态 import 它,CLI 就永远起不来。所以这里保留一份等价的最小实现:
// 只做「标签/属性/文本」三件事,缺字段一律走默认值,绝不 throw。
// ---------------------------------------------------------------------------

/** 轻量 XML 节点(命名空间前缀原样保留,匹配时按本地名)。 */
export interface OfficeXmlNode {
  name: string;
  attrs: Record<string, string>;
  kids: (OfficeXmlNode | string)[];
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** 实体解码(&amp; / &#x4e2d; / &#20013;认不出的原样保留。 */
function decodeXmlEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (all, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const cp = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
    }
    return XML_ENTITIES[body] ?? all;
  });
}

/** 属性解析:双引号与单引号两种写法都认;前缀原样保留。 */
function parseXmlAttrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1] ?? "";
    if (name === "") continue;
    out[name] = decodeXmlEntities(m[2] ?? m[3] ?? "");
  }
  return out;
}

/** 找开标签的 '>'(跳过引号内的 '>')。 */
function findTagEnd(src: string, from: number): number {
  let quote = "";
  for (let i = from; i < src.length; i += 1) {
    const ch = src[i] ?? "";
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

/** 手写 XML → 轻量树(容错:闭合标签不匹配时就近弹出,未闭合节点保留已收集内容)。 */
export function parseXmlLite(src: string): OfficeXmlNode {
  const root: OfficeXmlNode = { name: "#root", attrs: {}, kids: [] };
  const stack: OfficeXmlNode[] = [root];
  const text = String(src ?? "");
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    const top = stack[stack.length - 1] ?? root;
    if (lt < 0) {
      const chunk = text.slice(i);
      if (chunk !== "") top.kids.push(decodeXmlEntities(chunk));
      break;
    }
    if (lt > i) {
      const chunk = text.slice(i, lt);
      if (chunk.trim() !== "") top.kids.push(decodeXmlEntities(chunk));
    }
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      top.kids.push(text.slice(lt + 9, end < 0 ? text.length : end));
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<!", lt) || text.startsWith("<?", lt)) {
      const end = text.indexOf(">", lt + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    const gt = findTagEnd(text, lt + 1);
    if (gt < 0) break;
    const raw = text.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k]?.name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClose = raw.endsWith("/");
    const body = selfClose ? raw.slice(0, -1) : raw;
    const space = body.search(/\s/);
    const name = space < 0 ? body : body.slice(0, space);
    if (name === "") continue;
    const node: OfficeXmlNode = { name, attrs: parseXmlAttrs(space < 0 ? "" : body.slice(space)), kids: [] };
    top.kids.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

// ---------------------------------------------------------------------------
// 树遍历辅助(只读)
// ---------------------------------------------------------------------------

type XNode = OfficeXmlNode;

/** 本地名(去命名空间前缀)。 */
function localOf(name: string): string {
  const i = name.indexOf(":");
  return i < 0 ? name : name.slice(i + 1);
}

function kidsOf(node: XNode | undefined, name: string): XNode[] {
  const out: XNode[] = [];
  if (!node) return out;
  for (const k of node.kids) {
    if (typeof k !== "string" && localOf(k.name) === name) out.push(k);
  }
  return out;
}

function firstOf(node: XNode | undefined, name: string): XNode | undefined {
  if (!node) return undefined;
  for (const k of node.kids) {
    if (typeof k !== "string" && localOf(k.name) === name) return k;
  }
  return undefined;
}

/** 深度优先收集所有同名后代(含间接)。 */
function allOf(node: XNode | undefined, name: string, acc: XNode[] = []): XNode[] {
  if (!node) return acc;
  for (const k of node.kids) {
    if (typeof k === "string") continue;
    if (localOf(k.name) === name) acc.push(k);
    allOf(k, name, acc);
  }
  return acc;
}

/** 属性取值:先精确名,再按本地名匹配(w:val 与 val 等价)。 */
function attrOf(node: XNode | undefined, name: string): string | undefined {
  if (!node) return undefined;
  const exact = node.attrs[name];
  if (exact !== undefined) return exact;
  for (const key of Object.keys(node.attrs)) {
    if (localOf(key) === name) return node.attrs[key];
  }
  return undefined;
}

/** 节点纯文本(含后代文本)。 */
function textOf(node: XNode | undefined): string {
  if (!node) return "";
  let out = "";
  for (const k of node.kids) out += typeof k === "string" ? k : textOf(k);
  return out;
}

/** w:val 形式的布尔开关:tblHeader/cantSplit 带 0/false/off 视为关闭。 */
function flagOn(node: XNode): boolean {
  const val = attrOf(node, "val");
  return !(val === "0" || val === "false" || val === "off");
}

// ---------------------------------------------------------------------------
// docx 抽取
// ---------------------------------------------------------------------------

/** docx:表格(行列/首行重复表头/cantSplit 行数/首行文本)+ 图片 alt + 标题段落数。 */
export function docxFactsOf(root: XNode): DocxFacts {
  const tables = allOf(root, "tbl").map((tbl, index) => {
    const rows = kidsOf(tbl, "tr");
    let cols = 0;
    for (const tr of rows) cols = Math.max(cols, kidsOf(tr, "tc").length);
    const rowFlag = (row: XNode | undefined, name: string): boolean => {
      const pr = firstOf(row, "trPr");
      const flag = firstOf(pr, name);
      return flag !== undefined && flagOn(flag);
    };
 // 首行重复表头只对「有表头行」有意义:rows>=1 且首行 trPr/tblHeader 存在。
    const firstRowHeaderRepeat = rowFlag(rows[0], "tblHeader");
 // cantSplitRows 按行计数(每行最多算一次),天然 <= rows,满足 rules 的字段约束。
    const cantSplitRows = rows.filter((tr) => rowFlag(tr, "cantSplit")).length;
    const headerCells = kidsOf(rows[0], "tc").map((tc) => textOf(tc).trim());
    const headerText = headerCells.filter((t) => t !== "").join(" | ").slice(0, 120);
    return {
      index,
      rows: rows.length,
      cols,
      firstRowHeaderRepeat,
      cantSplitRows,
      ...(headerText === "" ? {} : { headerText }),
    };
  });
 // 图片只认 w:drawing 里的 wp:docPr(descr 是 OOXML 的 alt 描述位)。
  const images: DocxFacts["images"] = [];
  for (const drawing of allOf(root, "drawing")) {
    for (const docPr of allOf(drawing, "docPr")) {
      const descr = (attrOf(docPr, "descr") ?? "").trim();
      images.push({ index: images.length, ...(descr === "" ? {} : { altText: descr }) });
    }
  }
  const headings = allOf(root, "pStyle").filter((node) => {
    const val = (attrOf(node, "val") ?? "").replace(/\s+/g, "");
    return /^heading[1-9]$/i.test(val);
  }).length;
  return { tables, images, headings };
}

// ---------------------------------------------------------------------------
// xlsx 抽取
// ---------------------------------------------------------------------------

/** 工作表文件按序号升序(xl/worksheets/sheet3.xml 排在 sheet12 之前)。 */
function sheetPartNames(parts: string[]): string[] {
  const matched: { part: string; n: number }[] = [];
  for (const part of parts) {
    const m = /^xl\/worksheets\/sheet([0-9]+)\.xml$/.exec(part);
    if (m) matched.push({ part, n: Number(m[1]) });
  }
  matched.sort((a, b) => a.n - b.n);
  return matched.map((x) => x.part);
}

/** xlsx:逐 worksheet 抽公式/缓存/冻结/维度;打印标题来自 workbook.xml 的 definedName。 */
export function xlsxFactsOf(sheets: { name: string; xml: string }[], workbookXml: string | null): XlsxFacts {
  const printTitles =
    workbookXml === null
      ? false
      : allOf(parseXmlLite(workbookXml), "definedName").some((dn) => attrOf(dn, "name") === "_xlnm.Print_Titles");
  const facts = sheets.map(({ name, xml }) => {
    const root = parseXmlLite(xml);
    const dimensionNode = allOf(root, "dimension")[0];
    const dimension = (attrOf(dimensionNode, "ref") ?? "").trim();
    let formulaCells = 0;
    let cachedFormulaCells = 0;
    for (const cell of allOf(root, "c")) {
      const formula = firstOf(cell, "f");
      if (!formula) continue;
      formulaCells += 1;
      if (firstOf(cell, "v")) cachedFormulaCells += 1;
    }
    const freezePane = allOf(root, "sheetView").some((view) => {
      const pane = firstOf(view, "pane");
      if (!pane) return false;
      const ySplit = Number(attrOf(pane, "ySplit") ?? "0");
      const xSplit = Number(attrOf(pane, "xSplit") ?? "0");
      return (Number.isFinite(ySplit) && ySplit > 0) || (Number.isFinite(xSplit) && xSplit > 0);
    });
    return {
      name,
      formulaCells,
      cachedFormulaCells,
      freezePane,
      printTitles,
      ...(dimension === "" ? {} : { dimension }),
    };
  });
  return { sheets: facts };
}

// ---------------------------------------------------------------------------
// pptx 抽取
// ---------------------------------------------------------------------------

/** 幻灯片部件按 presentation.xml 的 sldIdLst 顺序;rels 缺失时退化为数字升序。 */
function slidePartOrder(parts: string[], presentationXml: string | null, relsXml: string | null): string[] {
  const numbered: { part: string; n: number }[] = [];
  for (const part of parts) {
    const m = /^ppt\/slides\/slide([0-9]+)\.xml$/.exec(part);
    if (m) numbered.push({ part, n: Number(m[1]) });
  }
  numbered.sort((a, b) => a.n - b.n);
  const fallback = numbered.map((x) => x.part);
  if (presentationXml === null) return fallback;
  const relTarget = new Map<string, string>();
  if (relsXml !== null) {
    for (const rel of allOf(parseXmlLite(relsXml), "Relationship")) {
      const id = attrOf(rel, "Id") ?? "";
      const target = (attrOf(rel, "Target") ?? "").replace(/^\.\//, "");
      if (id !== "" && target !== "") relTarget.set(id, `ppt/${target}`);
    }
  }
  if (relTarget.size === 0) return fallback;
  const ordered: string[] = [];
  for (const sldId of allOf(parseXmlLite(presentationXml), "sldId")) {
    const id = attrOf(sldId, "id") ?? attrOf(sldId, "r:id");
    const part = id === undefined ? undefined : relTarget.get(id);
    if (part && parts.includes(part) && !ordered.includes(part)) ordered.push(part);
  }
 // 有些包 sldIdLst 缺 rels 或顺序不全:把漏掉的 slide 按数字升序补在末尾,保证不丢页。
  for (const part of fallback) if (!ordered.includes(part)) ordered.push(part);
  return ordered;
}

/** pptx 单页:标题占位符 / 图片 alt / 顶层可见形状数。 */
export function pptxSlideFactsOf(root: XNode, index: number): PptxFacts["slides"][number] {
  const hasTitle = allOf(root, "ph").some((ph) => {
    const type = attrOf(ph, "type");
    return type === "title" || type === "ctrTitle";
  });
  const pictures: PptxFacts["slides"][number]["pictures"] = [];
  for (const pic of allOf(root, "pic")) {
    const cNvPr = allOf(pic, "cNvPr")[0];
    const descr = (attrOf(cNvPr, "descr") ?? "").trim();
    pictures.push({ index: pictures.length, ...(descr === "" ? {} : { altText: descr }) });
  }
  const tree = allOf(root, "spTree")[0];
  let visibleShapes = 0;
  for (const shape of tree ? tree.kids : []) {
    if (typeof shape === "string") continue;
    const kind = localOf(shape.name);
    if (kind !== "sp" && kind !== "pic" && kind !== "graphicFrame") continue;
    const cNvPr = allOf(shape, "cNvPr")[0];
    if (cNvPr && attrOf(cNvPr, "hidden") === "1") continue;
    visibleShapes += 1;
  }
  return { index, hasTitle, pictures, visibleShapes };
}

// ---------------------------------------------------------------------------
// pdf 抽取(直接读字节:零解压、零网络、零依赖)
// ---------------------------------------------------------------------------

/** 页数未知的哨兵(压缩对象流里数不出来;不猜页数,见 rules 的 FMT_PDF_PAGE_SCAN_UNKNOWN)。 */
const PDF_PAGE_UNKNOWN = -1;

const PAGE_TYPE_RE = /\/Type\s*\/Page[^s]/g;

/** pdf:头尾标记 + /Encrypt + 页数扫描(/Type /Page),扫描不出且压缩 → -1。 */
export function pdfFactsOf(bytes: Uint8Array): PdfFacts {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = buf.subarray(0, Math.min(1024, buf.length)).toString("latin1");
  const tail = buf.subarray(Math.max(0, buf.length - 2048)).toString("latin1");
  const text = buf.toString("latin1");
  const headerOk = head.includes("%PDF-");
  const eofOk = tail.includes("%%EOF");
  const encrypted = text.includes("/Encrypt");
  let pageCount = 0;
  PAGE_TYPE_RE.lastIndex = 0;
  while (PAGE_TYPE_RE.exec(text) !== null) pageCount += 1;
  if (pageCount === 0) {
 // 对象流(/Type /ObjStm)或压缩流(/Filter /FlateDecode)且 /Pages 解析不出 → 页数未知。
    const compressed = text.includes("/ObjStm") || (text.includes("/FlateDecode") && !/\/Pages\b/.test(text));
    if (compressed) pageCount = PDF_PAGE_UNKNOWN;
  }
  return { headerOk, eofOk, encrypted, pageCount };
}

// ---------------------------------------------------------------------------
// 抽取入口(永不 throw)
// ---------------------------------------------------------------------------

async function readPartText(zip: JSZip, part: string): Promise<string | null> {
  const file = zip.file(part);
  if (!file) return null;
  try {
    return await file.async("string");
  } catch {
    return null;
  }
}

/**
 * 抽取一份文件的格式事实。永不 throw:
 * - 扩展名认不出 → {format:null, facts:null};
 * - 内容抽取失败(非 zip / 缺 document.xml / OLE 加密包 / 坏 XML)→ facts:null + reason。
 */
export async function extractFacts(filePath: string, bytes: Uint8Array): Promise<OfficeExtract> {
  const format = resolveFormat(filePath);
  if (format === null) return { format: null, facts: null, reason: `无法识别的扩展名:${basename(filePath)}` };
  try {
    if (format === "pdf") return { format, facts: pdfFactsOf(bytes) };
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      return { format, facts: null, reason: "不是有效的 OOXML(zip 解不开,可能是 OLE/加密包或截断)" };
    }
    if (format === "docx") {
      const xml = await readPartText(zip, "word/document.xml");
      if (xml === null) return { format, facts: null, reason: "缺少 word/document.xml" };
      return { format, facts: docxFactsOf(parseXmlLite(xml)) };
    }
    if (format === "xlsx") {
      const parts = Object.keys(zip.files);
      const names = sheetPartNames(parts);
      if (names.length === 0) return { format, facts: null, reason: "没有任何 xl/worksheets/sheetN.xml" };
      const workbookXml = await readPartText(zip, "xl/workbook.xml");
      const declared: string[] = [];
      if (workbookXml !== null) {
        for (const sheet of allOf(parseXmlLite(workbookXml), "sheet")) {
          const name = (attrOf(sheet, "name") ?? "").trim();
          if (name !== "") declared.push(name);
        }
      }
      const sheets: { name: string; xml: string }[] = [];
      for (const part of names) {
        const xml = await readPartText(zip, part);
        if (xml === null) continue;
        const declaredName = declared[sheets.length];
        const name = declaredName ?? basename(part).replace(/\.xml$/i, "");
        sheets.push({ name, xml });
      }
      if (sheets.length === 0) return { format, facts: null, reason: "工作表 XML 全部读不出来" };
      return { format, facts: xlsxFactsOf(sheets, workbookXml) };
    }
 // pptx
    const parts = Object.keys(zip.files);
    const slideParts = parts.filter((p) => /^ppt\/slides\/slide[0-9]+\.xml$/.test(p));
    if (slideParts.length === 0) return { format, facts: null, reason: "没有任何 ppt/slides/slideN.xml" };
    const presentationXml = await readPartText(zip, "ppt/presentation.xml");
    const relsXml = await readPartText(zip, "ppt/_rels/presentation.xml.rels");
    const ordered = slidePartOrder(parts, presentationXml, relsXml);
    const slides: PptxFacts["slides"] = [];
    for (const part of ordered) {
      const xml = await readPartText(zip, part);
      if (xml === null) continue;
      slides.push(pptxSlideFactsOf(parseXmlLite(xml), slides.length));
    }
    if (slides.length === 0) return { format, facts: null, reason: "幻灯片 XML 全部读不出来" };
    return { format, facts: { slides } };
  } catch (err) {
    return { format, facts: null, reason: `抽取异常:${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// 落盘(原子写 + 幂等)
// ---------------------------------------------------------------------------

/** 原子写:先写 pid/序号唯一的 tmp,再 renameSync 覆盖目标(读到的永远是完整一代)。 */
function writeAtomic(filePath: string, content: string): void {
  tmpSeq += 1;
  const tmp = `${filePath}.${process.pid}.${tmpSeq}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

/** 已落盘的账本行(解析失败的坏行直接跳过:坏行不该阻塞新归档,也不该被静默重写掉)。 */
function readLedger(filePath: string): { raw: string; shas: Set<string> } {
  if (!existsSync(filePath)) return { raw: "", shas: new Set() };
  let raw = "";
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { raw: "", shas: new Set() };
  }
  const shas = new Set<string>();
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) {
        const sha = (parsed as { sha256?: unknown }).sha256;
        if (typeof sha === "string" && sha !== "") shas.add(sha);
      }
    } catch {
 /* 坏行跳过 */
    }
  }
  return { raw, shas };
}

/** 同一 sha 的产物若已存在且版本/指纹一致则不重写(幂等:第二次跑产物字节不变)。 */
function artifactIsCurrent(filePath: string, sha256: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const it = parsed as { sha256?: unknown; v?: unknown };
    return it.sha256 === sha256 && it.v === FORMAT_RULES_VERSION;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** facts → checkAll 的部件入参:抽取失败(facts=null)按该格式传 null,命中 FORMAT_INVALID。 */
function partsOf(extract: OfficeExtract): unknown {
  if (extract.format === null) return null; // 连格式都认不出:checkAll(null) → FORMAT_INVALID
  return { [extract.format]: extract.facts };
}

function aggregateCode(results: readonly FormatResultItem[]): FormatCode {
  if (results.some((r) => r.report.code === FORMAT_INVALID)) return FORMAT_INVALID;
  if (results.some((r) => r.report.verdict === "fail")) return FORMAT_FAIL;
  if (results.some((r) => r.report.verdict === "warn")) return FORMAT_WARN;
  return FORMAT_OK;
}

/**
 * 抽 facts → 裁决 → 落盘。永不 throw:
 * - root 不合规 → OFFICE_FORMAT_ROOT_UNSAFE(exit 1,**不建目录、不写盘**);
 * - 未给文件 → OFFICE_FORMAT_INPUT_EMPTY(exit 1);
 * - 文件读不了 → OFFICE_FORMAT_FILE_UNREADABLE(exit 1,前面已处理的文件也不落盘:宁缺勿半);
 * - 否则逐文件落产物 + 追加账本,exit 0(pass/warn)或 2(任一 p0 或抽取失败)。
 */
export async function runFormatCheck(opts: RunFormatCheckOptions): Promise<RunFormatCheckOutput> {
  const rootCheck = resolveSafeRoot(opts?.root);
  if (!rootCheck.ok) {
    return {
      ok: false,
      code: "OFFICE_FORMAT_ROOT_UNSAFE",
      exitCode: 1,
      root: typeof opts?.root === "string" ? opts.root : "",
      results: [],
      error: rootCheck.error,
    };
  }
  const root = rootCheck.root;
  const files = Array.isArray(opts?.files) ? opts.files.filter((f): f is string => typeof f === "string" && f !== "") : [];
  if (files.length === 0) {
    return { ok: false, code: "OFFICE_FORMAT_INPUT_EMPTY", exitCode: 1, root, results: [], error: "至少需要一个待检查文件" };
  }

  const results: FormatResultItem[] = [];
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "OFFICE_FORMAT_FILE_UNREADABLE", exitCode: 1, root, results, error: `无法读取 ${file}:${why}` };
    }
    if (bytes.length === 0) {
      return { ok: false, code: "OFFICE_FORMAT_FILE_UNREADABLE", exitCode: 1, root, results, error: `文件为空:${file}` };
    }
    const extracted = await extractFacts(file, bytes);
    const report = checkAll(partsOf(extracted));
    results.push({ file, sha256: sha256Hex(bytes), format: extracted.format, report, facts: extracted.facts });
  }

  const code = aggregateCode(results);
  const exitCode = code === FORMAT_OK || code === FORMAT_WARN ? 0 : 2;
  const at = new Date().toISOString();
  const { dir, ledger } = officeFormatPaths(root);
  try {
    mkdirSync(dir, { recursive: true });
    for (const item of results) {
      const artifactPath = join(dir, `${item.sha256.slice(0, 12)}.json`);
      if (artifactIsCurrent(artifactPath, item.sha256)) continue;
      const payload: OfficeFormatArtifact = {
        v: FORMAT_RULES_VERSION,
        sha256: item.sha256,
        file: item.file,
        format: item.format,
        report: item.report,
        facts: item.facts,
        at,
      };
      writeAtomic(artifactPath, `${JSON.stringify(payload, null, 2)}\n`);
    }
    const existing = readLedger(ledger);
    const fresh: OfficeFormatLedgerEntry[] = [];
    for (const item of results) {
      if (existing.shas.has(item.sha256)) continue;
      existing.shas.add(item.sha256); // 同一批里重复传同一文件也只追加一次
      fresh.push({
        sha256: item.sha256,
        file: item.file,
        format: item.format,
        code: item.report.code,
        counts: item.report.counts,
        at,
      });
    }
    if (fresh.length > 0) {
      const head = existing.raw === "" || existing.raw.endsWith("\n") ? existing.raw : `${existing.raw}\n`;
      writeAtomic(ledger, `${head}${fresh.map((e) => JSON.stringify(e)).join("\n")}\n`);
    }
  } catch (err) {
 // 落盘失败不改变裁决(事实已经拿到),但必须如实上报,不能装作归档成功。
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "OFFICE_FORMAT_FILE_UNREADABLE", exitCode: 1, root, results, error: `产物写入失败:${why}` };
  }
  return { ok: code === FORMAT_OK || code === FORMAT_WARN, code, exitCode, root, results };
}

/** 只读当前账本(CLI --report 记账规模用;文件不存在返回空数组)。 */
export function readFormatLedger(root: string): OfficeFormatLedgerEntry[] {
  const { ledger } = officeFormatPaths(root);
  if (!existsSync(ledger)) return [];
  const out: OfficeFormatLedgerEntry[] = [];
  let raw = "";
  try {
    raw = readFileSync(ledger, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) out.push(parsed as OfficeFormatLedgerEntry);
    } catch {
 /* 坏行跳过 */
    }
  }
  return out;
}

