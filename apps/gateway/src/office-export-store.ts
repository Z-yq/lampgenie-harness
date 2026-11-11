/**
 * Office 导出(pptx/docx/xlsx/md/html/pdf → pptx/pdf/png/md/html)的**抽取层 + 持久层 + 引擎壳**
 * (2026-11 #-B,生产侧)。
 * 分工(与既有 office-format-store / office-pdf-store / office-ooxml 同族):
 * - 纯裁决在 packages/harness-runtime/src/agent/office-export.ts(零 IO,只吃「已抽取的事实」);
 * - 本模块负责三件事:把字节抽成事实(preflight 的输入)、把厂商 manifest/产物/账本原子落盘、
 * 把 soffice/gs 当作外部引擎 shell 出来(不伪造产物);
 * - CLI 在 scripts/office-export.mts(只做 argv/打印/退出码)。
 * 为什么抽取层 throw(与 office-format-store 的「不 throw」不同):
 * 格式检查面对的是「用户文档可能坏」,坏文件本身就是要被裁决的对象;
 * 导出面对的是「我要把这份文件转出去」,读不出事实就没有可信输入,
 * 返回假事实(空页/0 字符)会让下游把「读失败」误判成「文档本来就是空的」→ 导出空产物。
 * 所以 extractFacts 任何失败都 throw OFFICE_EXPORT_FILE_UNREADABLE,由 CLI 折成 exit 1(非参数错、非内容违规)。
 * 为什么产物是「一 sha 一 JSON + 追加式账本」:
 * - 产物 `<export>/<sha 前 12>.json` 是**当下态的完整证据**(输入指纹/target/裁决码/preflight/产物/引擎/时间),
 * 同 sha + 同 target 且内容等价时重跑不重写(幂等),崩溃最多丢掉最后一次未 rename 的写;
 * - `<dir>/ledger.jsonl` 是**一行一次的归档索引**(sha/target/code/at),同 sha + target 已存在则不重复追加。
 * 硬约束:root 必须是 /tmp 下(realpath 后前缀校验);所有写盘先过 resolveSafeRoot;
 * 不把 base64/凭证写进产物;引擎失败绝不伪造产物。
 * 已知限制:PDF 不做文字内省(PDF 是内容流 + 字体子集,手写解析不可靠),
 * 所以 pdf 输入只给 pageCount 与「每页一个占位 shapes=1」,不产出 texts/placeholders。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

import JSZip from "jszip";

import {
  EXPORT_ENGINE_MISSING,
  EXPORT_MANIFEST_MISSING,
  EXPORT_OK,
  findExternalRefs,
  findPlaceholders,
  preflightExport,
  verifyArtifact,
  verifyVendorManifest,
} from "@lampgenie/runtime/agent/office-export";
import type {
  ArtifactVerdict,
  ExportCode,
  ExportPage,
  InputKind,
  ManifestActual,
  ManifestVerdict,
  PreflightResult,
  Target,
  VendorManifest,
} from "@lampgenie/runtime/agent/office-export";

// ---------------------------------------------------------------------------
// 稳定码与错误
// ---------------------------------------------------------------------------

/** store 层自产的失败码(裁决码沿用 runtime 的 EXPORT_*)。 */
export const OFFICE_EXPORT_STORE_CODES = [
  "OFFICE_EXPORT_ROOT_UNSAFE",
  "OFFICE_EXPORT_FILE_UNREADABLE",
  "OFFICE_EXPORT_RENDER_FAILED",
  "OFFICE_EXPORT_USAGE",
] as const;

export type OfficeExportStoreCode = (typeof OFFICE_EXPORT_STORE_CODES)[number];

/** 相对 root 的产物目录(与 .genie/office/format 同层,便于统一清理)。 */
export const OFFICE_EXPORT_RELATIVE_DIR = ".genie/office";
/** 只接受 /tmp 下的 root(realpath 后校验):导出产物是临时证据,不落仓、不落系统目录。 */
export const OFFICE_EXPORT_TMP_PREFIX = "/tmp/";

/** store 层错误:code 是稳定字符串(要么是 OFFICE_EXPORT_*,要么是 runtime 的 EXPORT_*)。 */
export class OfficeExportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OfficeExportError";
    this.code = code;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function usage(message: string): OfficeExportError {
  return new OfficeExportError("OFFICE_EXPORT_USAGE", message);
}

function unreadable(message: string): OfficeExportError {
  return new OfficeExportError("OFFICE_EXPORT_FILE_UNREADABLE", message);
}

function renderFailed(message: string): OfficeExportError {
  return new OfficeExportError("OFFICE_EXPORT_RENDER_FAILED", message);
}

// ---------------------------------------------------------------------------
// 路径与安全闸
// ---------------------------------------------------------------------------

/** root 安全闸:建目录 → realpath,结果必须以 "/tmp/" 开头(或就是 /tmp),否则 throw。 */
export function resolveSafeRoot(root: string): string {
  if (typeof root !== "string" || root.trim() === "") throw usage("root 必须是非空字符串");
  if (!isAbsolute(root)) throw usage(`root 必须是绝对路径:${root}`);
  try {
    mkdirSync(root, { recursive: true });
  } catch (err) {
    throw new OfficeExportError("OFFICE_EXPORT_ROOT_UNSAFE", `root 建目录失败:${errText(err)}`);
  }
  let real: string;
  try {
    real = realpathSync(root);
  } catch (err) {
    throw new OfficeExportError("OFFICE_EXPORT_ROOT_UNSAFE", `root realpath 失败:${errText(err)}`);
  }
  const underTmp = real === "/tmp" || `${real}/`.startsWith(OFFICE_EXPORT_TMP_PREFIX);
  if (!underTmp) throw new OfficeExportError("OFFICE_EXPORT_ROOT_UNSAFE", `root 必须在 /tmp 下(realpath 后):${real}`);
  return real;
}

/** 产物路径(root 已过安全闸;**不建子目录**,建目录发生在真正写盘时)。 */
export interface OfficeExportPaths {
  dir: string;
  vendorDir: string;
  outDir: string;
  ledgerFile: string;
}

export function officeExportPaths(root: string): OfficeExportPaths {
  const safe = resolveSafeRoot(root);
  const dir = join(safe, OFFICE_EXPORT_RELATIVE_DIR);
  return {
    dir,
    vendorDir: join(dir, "vendor"),
    outDir: join(dir, "export"),
    ledgerFile: join(dir, "ledger.jsonl"),
  };
}

/** sha256 十六进制(产物文件名取前 12 位)。 */
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 按扩展名判输入种类(认不出返回 null,由调用方决定报错口径)。 */
export function inputKindOf(filePath: string): InputKind | null {
  const lower = String(filePath ?? "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot < 0 ? "" : lower.slice(dot + 1);
  if (ext === "pptx" || ext === "pptm") return "pptx";
  if (ext === "docx" || ext === "docm") return "docx";
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "pdf") return "pdf";
  return null;
}

/** 原子写:先写 pid/序号唯一的 tmp,再 renameSync 覆盖目标(读到的永远是完整一代)。 */
let tmpSeq = 0;
function writeFileAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  tmpSeq += 1;
  const tmp = `${filePath}.${process.pid}.${tmpSeq}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// 轻量文本/XML 工具(不引 XML 解析器,与 office-format-store 同口径)
// ---------------------------------------------------------------------------

const ENTITY_MAP: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const mapped = ENTITY_MAP[body.toLowerCase()];
    return mapped ?? whole;
  });
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 取某个标签的全部内文本(`<a:t>…</a:t>`),已解实体,原样保留空白。 */
function tagTexts(xml: string, tag: string): string[] {
  const re = new RegExp(`<${escapeRe(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRe(tag)}>`, "g");
  const out: string[] = [];
  for (const match of xml.matchAll(re)) out.push(decodeEntities(match[1] ?? ""));
  return out;
}

/** 数标签出现次数(`<p:sp` 不会被 `<p:spTree` 误计,靠后一位字符判定)。 */
function countTags(xml: string, tag: string): number {
  const re = new RegExp(`<${escapeRe(tag)}(?=[\\s/>])`, "g");
  let count = 0;
  for (const _ of xml.matchAll(re)) count += 1;
  return count;
}

/** 取标签内某个属性的值(单双引号都吃)。 */
function attrOf(tagText: string, name: string): string | null {
  const re = new RegExp(`\\b${escapeRe(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const match = re.exec(tagText);
  if (match === null) return null;
  return decodeEntities(match[2] ?? match[3] ?? "");
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** 把 runtime 的命中列表折成去重字符串(契约就是 string[];这里只做去重与空串剔除)。 */
function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    if (item !== null && typeof item === "object") {
      const obj = item as { text?: unknown; url?: unknown; target?: unknown; value?: unknown };
      for (const key of ["text", "url", "target", "value"] as const) {
        const candidate = obj[key];
        if (typeof candidate === "string" && candidate !== "") {
          out.push(candidate);
          break;
        }
      }
    }
  }
  return dedupe(out);
}

/** 逐段找占位符(TODO/TBD/FIXME/待补 等口径由 runtime 持有)。 */
function placeholdersIn(text: string, opts?: { ignoreCodeBlocks?: boolean }): string[] {
  return stringsOf(findPlaceholders(text, opts));
}

/** 文本里的外链(runtime 口径)。 */
function externalRefsIn(text: string): string[] {
  return stringsOf(findExternalRefs(text));
}

const EXTERNAL_TARGET_RE = /^(https?:|file:)/i;
const MEDIA_TARGET_RE = /\.(png|jpe?g|gif|bmp|tiff?|emf|wmf|svg|mp4|m4v|mov|webm|avi|mp3|wav|m4a)(?:[?#].*)?$/i;

/** 外链是否指向媒体(决定「媒体是否内嵌」:真外链图片 = 未内嵌)。 */
function isMediaRef(ref: string): boolean {
  return MEDIA_TARGET_RE.test(ref) || /^file:/i.test(ref);
}

/** 从 `*.rels` 里抽 External 目标(http(s)/file),顺带判「有没有外链媒体」。 */
async function relationshipsOf(zip: JSZip, names: readonly string[]): Promise<{ external: string[]; externalMedia: boolean }> {
  const external: string[] = [];
  let externalMedia = false;
  for (const part of names) {
    if (!/\.rels$/i.test(part)) continue;
    const xml = (await readPart(zip, part)) ?? "";
    for (const tag of xml.match(/<Relationship\b[^>]*>/g) ?? []) {
      if (!/TargetMode\s*=\s*["']External["']/i.test(tag)) continue;
      const target = attrOf(tag, "Target");
      if (target === null || !EXTERNAL_TARGET_RE.test(target)) continue;
      external.push(target);
      if (isMediaRef(target)) externalMedia = true;
    }
  }
  return { external: dedupe(external), externalMedia };
}

async function readPart(zip: JSZip, part: string): Promise<string | null> {
  const file = zip.file(part);
  if (file === null) return null;
  try {
    return await file.async("string");
  } catch {
    return null;
  }
}

function pageOf(page: { index: number; text?: string; texts?: string[]; shapes?: number; images?: number }): ExportPage {
  return { ...page } as ExportPage;
}

// ---------------------------------------------------------------------------
// 抽取:ExtractedFacts
// ---------------------------------------------------------------------------

/** 一份输入抽出来的「事实」——preflightExport 的唯一输入(不含任何裁决)。 */
export interface ExtractedFacts {
  inputKind: InputKind;
  pages: ExportPage[];
  fonts: string[];
  externalRefs: string[];
  placeholders: string[];
  mediaEmbedded: boolean;
  pageCount: number;
}

/** 抽取入口:任何失败都 throw(不返回假事实)。 */
export async function extractFacts(filePath: string): Promise<ExtractedFacts> {
  const kind = inputKindOf(filePath);
  if (kind === null) throw unreadable(`无法识别的输入扩展名:${filePath}`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (err) {
    throw unreadable(`读取失败:${filePath}:${errText(err)}`);
  }
  if (bytes.length === 0) throw unreadable(`文件为空:${filePath}`);
  if (kind === "pdf") return pdfFactsOf(bytes);
  if (kind === "md") return markdownFactsOf(bytes.toString("utf8"));
  if (kind === "html") return htmlFactsOf(bytes.toString("utf8"));

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    throw unreadable(`不是有效的 OOXML 压缩包:${filePath}:${errText(err)}`);
  }
  const names = Object.keys(zip.files);
  try {
    if (kind === "pptx") return await pptxFactsOf(zip, names);
    if (kind === "docx") return await docxFactsOf(zip, names);
    return await xlsxFactsOf(zip, names);
  } catch (err) {
    if (err instanceof OfficeExportError) throw err;
    throw unreadable(`抽取异常:${filePath}:${errText(err)}`);
  }
}

function slideIndex(part: string): number {
  const match = /slide([0-9]+)\.xml$/.exec(part);
  return match === null ? 0 : Number.parseInt(match[1] ?? "0", 10);
}

/** `<a:latin typeface="…">` → 去主题占位(+mn-lt/+mj-lt 这类)。 */
function latinTypefacesOf(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(/<a:latin\b[^>]*>/g)) {
    const typeface = attrOf(match[0], "typeface");
    if (typeface === null) continue;
    const trimmed = typeface.trim();
    if (trimmed === "" || trimmed.startsWith("+")) continue;
    out.push(trimmed);
  }
  return out;
}

async function pptxFactsOf(zip: JSZip, names: readonly string[]): Promise<ExtractedFacts> {
  const slideParts = names
    .filter((part) => /^ppt\/slides\/slide[0-9]+\.xml$/.test(part))
    .sort((a, b) => slideIndex(a) - slideIndex(b));
  if (slideParts.length === 0) throw unreadable("pptx 缺 ppt/slides/slideN.xml");

  const pages: ExportPage[] = [];
  const fonts: string[] = [];
  const placeholders: string[] = [];
  const pageTexts: string[] = [];
  for (const part of slideParts) {
    const xml = (await readPart(zip, part)) ?? "";
    const texts = tagTexts(xml, "a:t")
      .map((text) => text.trim())
      .filter((text) => text !== "");
    const shapes = countTags(xml, "p:sp") + countTags(xml, "p:pic") + countTags(xml, "p:graphicFrame");
    const images = countTags(xml, "p:pic");
    const joined = texts.join("\n");
    pages.push(pageOf({ index: pages.length + 1, text: joined, texts, shapes, images }));
    fonts.push(...latinTypefacesOf(xml));
    placeholders.push(...placeholdersIn(joined));
    pageTexts.push(joined);
  }
 // 幻灯片上常常只引用主题字体:主题/母版/版式里的 a:latin 也算「这份输入用到的字体」。
  for (const part of names) {
    if (!/^ppt\/(theme\/theme|slideMasters\/slideMaster|slideLayouts\/slideLayout)[^/]*\.xml$/.test(part)) continue;
    fonts.push(...latinTypefacesOf((await readPart(zip, part)) ?? ""));
  }

  const rels = await relationshipsOf(zip, names);
  const externalRefs = dedupe([...rels.external, ...externalRefsIn(pageTexts.join("\n"))]);
  return {
    inputKind: "pptx",
    pages,
    fonts: dedupe(fonts),
    externalRefs,
    placeholders: dedupe(placeholders),
    mediaEmbedded: !rels.externalMedia,
    pageCount: pages.length,
  };
}

/** 段落文本:`<w:p>` 内所有 `<w:t>` 拼接(`<w:pPr>` 不会被当成段落)。 */
function docxParagraphsOf(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(/<w:p(?=[\s>])[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const inner = match[1] ?? "";
    const text = tagTexts(inner, "w:t").join("");
    out.push(decodeEntities(text).trim());
  }
  return out;
}

async function docxFactsOf(zip: JSZip, names: readonly string[]): Promise<ExtractedFacts> {
  const xml = await readPart(zip, "word/document.xml");
  if (xml === null) throw unreadable("docx 缺 word/document.xml");
  const paragraphs = docxParagraphsOf(xml);
  const texts = paragraphs.filter((text) => text !== "");
  const images = countTags(xml, "a:blip");
  const fonts: string[] = [];
  for (const match of xml.matchAll(/<w:rFonts\b[^>]*>/g)) {
    const ascii = attrOf(match[0], "w:ascii");
    if (ascii !== null) fonts.push(ascii);
  }
  const rels = await relationshipsOf(zip, names);
  const joined = paragraphs.join("\n");
  return {
    inputKind: "docx",
    pages: [pageOf({ index: 1, text: joined, texts, images })],
    fonts: dedupe(fonts),
    externalRefs: dedupe([...rels.external, ...externalRefsIn(joined)]),
    placeholders: placeholdersIn(joined),
    mediaEmbedded: !rels.externalMedia,
    pageCount: 1,
  };
}

/** sharedStrings.xml → 按 `<si>` 顺序的字符串表(供 `t="s"` 单元格回填)。 */
async function sharedStringsOf(zip: JSZip): Promise<string[]> {
  const xml = (await readPart(zip, "xl/sharedStrings.xml")) ?? "";
  const out: string[] = [];
  for (const match of xml.matchAll(/<si(?=[\s>])[^>]*>([\s\S]*?)<\/si>/g)) {
    out.push(tagTexts(match[1] ?? "", "t").join(""));
  }
  return out;
}

/** 一个工作表 XML 里的非空单元格值(sharedStrings 回填 + inlineStr + 数值)。 */
function sheetCellValuesOf(xml: string, shared: readonly string[]): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(/<c(?=[\s>])[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const tagText = match[0].slice(0, match[0].indexOf(">") + 1);
    const inner = match[1] ?? "";
    const type = attrOf(tagText, "t");
    if (type === "inlineStr" || type === "str") {
      const value = tagTexts(inner, "t").join("").trim();
      if (value !== "") out.push(value);
      continue;
    }
    const raw = tagTexts(inner, "v").join("").trim();
    if (raw === "") continue;
    if (type === "s") {
      const index = Number.parseInt(raw, 10);
      const resolved = Number.isFinite(index) ? shared[index] : undefined;
      if (resolved !== undefined && resolved.trim() !== "") out.push(resolved);
      continue;
    }
    out.push(raw);
  }
  return out;
}

async function xlsxFactsOf(zip: JSZip, names: readonly string[]): Promise<ExtractedFacts> {
  const workbookXml = (await readPart(zip, "xl/workbook.xml")) ?? "";
  const declared: string[] = [];
  for (const match of workbookXml.matchAll(/<sheet(?=[\s>])[^>]*>/g)) {
    const name = attrOf(match[0], "name");
    if (name !== null && name.trim() !== "") declared.push(name.trim());
  }
  const sheetParts = names
    .filter((part) => /^xl\/worksheets\/sheet[0-9]+\.xml$/.test(part))
    .sort((a, b) => slideIndex(a) - slideIndex(b));
  if (sheetParts.length === 0) throw unreadable("xlsx 缺 xl/worksheets/sheetN.xml");

  const shared = await sharedStringsOf(zip);
  const pages: ExportPage[] = [];
  const placeholders: string[] = [];
  const pageTexts: string[] = [];
  for (const part of sheetParts) {
    const xml = (await readPart(zip, part)) ?? "";
    const values = sheetCellValuesOf(xml, shared);
    const joined = values.join("\n");
    pages.push(pageOf({ index: pages.length + 1, text: joined, texts: values, images: countTags(xml, "xdr:pic") }));
    placeholders.push(...placeholdersIn(joined));
    pageTexts.push(joined);
  }
  const rels = await relationshipsOf(zip, names);
  return {
    inputKind: "xlsx",
    pages,
 // xlsx 的字体在 styles.xml 的字体表里,不按「用到了哪几款」记账(preflight 不据此判缺失)。
    fonts: [],
    externalRefs: dedupe([...rels.external, ...externalRefsIn(pageTexts.join("\n"))]),
    placeholders: dedupe(placeholders),
    mediaEmbedded: !rels.externalMedia,
    pageCount: declared.length > 0 ? declared.length : pages.length,
  };
}

/** markdown 段落切分(空行分段),只用于给 perPage 提供文本颗粒度。 */
function blocksOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "");
}

function markdownLinkTargetsOf(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)/g)) {
    const target = match[1] ?? "";
    if (EXTERNAL_TARGET_RE.test(target)) out.push(target);
  }
  return out;
}

function markdownFactsOf(text: string): ExtractedFacts {
  const externalRefs = dedupe([...externalRefsIn(text), ...markdownLinkTargetsOf(text)]);
  return {
    inputKind: "md",
    pages: [pageOf({ index: 1, text, texts: blocksOf(text) })],
    fonts: [],
    externalRefs,
    placeholders: placeholdersIn(text, { ignoreCodeBlocks: true }),
    mediaEmbedded: !externalRefs.some(isMediaRef),
    pageCount: 1,
  };
}

/** html → 纯文本(先剔 script/style,再剥标签,最后解实体)。 */
function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  const stripped = withoutScripts.replace(/<[^>]*>/g, " ");
  return decodeEntities(stripped)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function htmlAttributeTargetsOf(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    const target = (match[1] ?? "").trim();
    if (EXTERNAL_TARGET_RE.test(target)) out.push(target);
  }
  return out;
}

function htmlFactsOf(html: string): ExtractedFacts {
  const text = htmlToText(html);
  const externalRefs = dedupe([...htmlAttributeTargetsOf(html), ...externalRefsIn(text)]);
  return {
    inputKind: "html",
    pages: [pageOf({ index: 1, text, texts: blocksOf(text) })],
    fonts: [],
    externalRefs,
    placeholders: placeholdersIn(text, { ignoreCodeBlocks: true }),
    mediaEmbedded: !externalRefs.some(isMediaRef),
    pageCount: 1,
  };
}

/**
 * pdf 事实:**已知限制**——不做文字内省(内容流压缩 + 字体子集编码,手写解析不可靠),
 * 只按 `/Type /Page` 计数并按页给 `shapes:1` 占位,占位符/字体一律取不到。
 * 外链从 `/URI (...)` 里取,够离线闸判断「PDF 里有没有外链」。
 */
function pdfFactsOf(bytes: Buffer): ExtractedFacts {
  const latin = bytes.toString("latin1");
  const pageCount = countPdfPages(latin);
  if (pageCount <= 0) throw unreadable("pdf 里没有 /Type /Page");
  const pages: ExportPage[] = [];
  for (let index = 1; index <= pageCount; index += 1) pages.push(pageOf({ index, shapes: 1 }));
  const external: string[] = [];
  for (const match of latin.matchAll(/\/URI\s*\(([^)]*)\)/g)) {
    const uri = (match[1] ?? "").trim();
    if (EXTERNAL_TARGET_RE.test(uri)) external.push(uri);
  }
  return {
    inputKind: "pdf",
    pages,
    fonts: [],
    externalRefs: dedupe(external),
    placeholders: [],
    mediaEmbedded: true,
    pageCount,
  };
}

function countPdfPages(latin: string): number {
  const matches = latin.match(/\/Type\s*\/Page[^s]/g);
  return matches === null ? 0 : matches.length;
}

/** PDF 页数(读不出来就 throw,不返回 0 假装空文档)。 */
export function pdfPageCount(filePath: string): number {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (err) {
    throw unreadable(`读取失败:${filePath}:${errText(err)}`);
  }
  if (bytes.length === 0) return 0;
  return countPdfPages(bytes.toString("latin1"));
}

// ---------------------------------------------------------------------------
// 厂商 manifest(离线放行名单)
// ---------------------------------------------------------------------------

function assertManifestName(name: string): string {
  const trimmed = String(name ?? "").trim();
  if (trimmed === "") throw usage("manifest name 不能为空");
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw usage(`manifest name 不能含路径分隔符或 ..:${name}`);
  }
  return trimmed;
}

function manifestPathOf(paths: OfficeExportPaths, name: string): string {
  return join(paths.vendorDir, `${name}.manifest.json`);
}

function isEntry(value: unknown): value is { name: string; sha256: string; bytes: number; path?: string } {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.name === "string" && typeof entry.sha256 === "string" && typeof entry.bytes === "number";
}

/**
 * 登记(或刷新)一份厂商 manifest 的单个文件条目。
 * 条目带本地绝对路径(path = resolve(登记时的 filePath)):runtime 的离线校验要求每条都有 path,
 * 不写 path 会让所有离线清单校验必然 OFFLINE_VIOLATION。
 * 同 name 且 sha/bytes/path 完全一致 → reused=true,不重写(幂等,便于 CI 反复跑);
 * 内容同但 path 换了(同 basename 登记自另一目录)→ 以最新 path 为准重写;
 * 否则覆盖该条重写(整份 manifest 原子落盘)。
 */
export function registerManifest(
  root: string,
  name: string,
  filePath: string): { manifest: VendorManifest; path: string; reused: boolean } {
  const paths = officeExportPaths(root);
  const safeName = assertManifestName(name);
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (err) {
    throw unreadable(`读取失败:${filePath}:${errText(err)}`);
  }
  if (bytes.length === 0) throw unreadable(`文件为空:${filePath}`);
  const entry = {
    name: basename(filePath),
    sha256: sha256Hex(bytes),
    bytes: bytes.length,
 // 本地绝对路径:离线校验(runtime)要求每条都有非空 path。
    path: resolvePath(filePath),
  };
  const existing = readManifest(root, safeName);
  if (existing !== null) {
    const same = existing.entries.find((item) => item.name === entry.name);
    if (
      same !== undefined &&
      same.sha256 === entry.sha256 &&
      same.bytes === entry.bytes &&
      same.path === entry.path
    ) {
      return { manifest: existing, path: manifestPathOf(paths, safeName), reused: true };
    }
  }
  const entries = (existing?.entries ?? []).filter((item) => item.name !== entry.name);
  entries.push(entry);
  const manifest: VendorManifest = {
    name: existing?.name ?? safeName,
 // 版本号刻意固定:让「同 sha 重跑不重写」有确定性(内容等价即可复用)。
    version: existing?.version ?? "1",
    entries,
  };
  const target = manifestPathOf(paths, safeName);
  writeFileAtomic(target, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, path: target, reused: false };
}

/** 读 manifest(不存在/坏 JSON/结构不对一律 null,不 throw:缺失由裁决层报 MANIFEST_MISSING)。 */
export function readManifest(root: string, name: string): VendorManifest | null {
  let paths: OfficeExportPaths;
  try {
    paths = officeExportPaths(root);
  } catch {
    return null;
  }
  const target = manifestPathOf(paths, name);
  if (!existsSync(target)) return null;
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== "string" || typeof obj.version !== "string" || !Array.isArray(obj.entries)) return null;
  const entries = obj.entries.filter(isEntry).map((item) => ({
    name: item.name,
    sha256: item.sha256,
    bytes: item.bytes,
    ...(item.path === undefined ? {} : { path: item.path }),
  }));
  return { name: obj.name, version: obj.version, entries };
}

/**
 * 把「磁盘上的实际文件」折成 ManifestActual[],交给 runtime 的 verifyVendorManifest 裁决。
 * 读不出来的文件给 sha256="" / bytes=-1:这一定是 mismatch(不是「跳过」),避免静默放行。
 */
export function verifyManifestFiles(
  root: string,
  name: string,
  files: readonly { path: string; name?: string }[],
  opts?: { offline?: boolean },
): { verdict: ManifestVerdict; actual: ManifestActual[] } {
  const actual: ManifestActual[] = [];
  for (const file of files) {
    const entryName = file.name ?? basename(file.path);
    try {
      const bytes = readFileSync(file.path);
      actual.push({ name: entryName, sha256: sha256Hex(bytes), bytes: bytes.length });
    } catch {
      actual.push({ name: entryName, sha256: "", bytes: -1 });
    }
  }
  const manifest = readManifest(root, name);
  if (manifest === null) {
 // 清单缺失交给 runtime 统一出码(与 list 缺失时的口径一致,不自己编结论)。
    const missing = verifyVendorManifest(null, { ...(opts?.offline === undefined ? {} : { offline: opts.offline }) });
    return { verdict: missing, actual };
  }
  const verdict = verifyVendorManifest(manifest, {
    ...(opts?.offline === undefined ? {} : { offline: opts.offline }),
    actual,
  });
  return { verdict, actual };
}

// ---------------------------------------------------------------------------
// 引擎壳(soffice / gs):只 shell,不伪造
// ---------------------------------------------------------------------------

const ENGINE_TIMEOUT_MS = 180_000;
const ENGINE_MAX_BUFFER = 8 * 1024 * 1024;

export interface RenderResult {
  engine: "soffice" | "gs";
  pdfPath: string | null;
  pngPaths: string[];
  durationMs: number;
  stdout: string;
}

/** spawnSync 的错误形态(code 可能是 ENOENT/EACCES/ENOTDIR)。 */
interface SpawnErrno extends Error {
  code?: string;
}

function spawnEngine(bin: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string; spawnError?: SpawnErrno } {
  const res = spawnSync(bin, args as string[], {
    encoding: "utf8",
    timeout: ENGINE_TIMEOUT_MS,
    maxBuffer: ENGINE_MAX_BUFFER,
  });
  const stdout = typeof res.stdout === "string" ? res.stdout : "";
  const stderr = typeof res.stderr === "string" ? res.stderr : "";
  const err = res.error as SpawnErrno | undefined;
  if (err !== undefined && (err.code === "ENOENT" || err.code === "EACCES" || err.code === "ENOTDIR")) {
    return { status: null, stdout, stderr: `${stderr}${err.message}`, spawnError: err };
  }
  return { status: res.status, stdout, stderr };
}

function isEngineMissing(err: SpawnErrno | undefined): boolean {
  if (err === undefined) return false;
  return err.code === "ENOENT" || err.code === "EACCES" || err.code === "ENOTDIR";
}

/**
 * soffice 转 PDF:`soffice --headless --convert-to pdf --outdir <outDir> <inputPath>`。
 * 引擎不存在 → EXPORT_ENGINE_MISSING;非零退出/无产物/0 字节 → OFFICE_EXPORT_RENDER_FAILED。
 */
export function renderToPdf(inputPath: string, outDir: string, opts?: { bin?: string }): RenderResult {
  const bin = opts?.bin ?? "soffice";
  if (!existsSync(inputPath)) throw unreadable(`输入不存在:${inputPath}`);
  mkdirSync(outDir, { recursive: true });
  const expected = join(outDir, `${basename(inputPath).replace(/\.[^.]+$/, "")}.pdf`);
  const started = Date.now();
  const res = spawnEngine(bin, ["--headless", "--convert-to", "pdf", "--outdir", outDir, inputPath]);
  const durationMs = Date.now() - started;
  if (isEngineMissing(res.spawnError)) {
    throw new OfficeExportError(EXPORT_ENGINE_MISSING, `找不到 PDF 引擎:${bin}`);
  }
  if (res.spawnError !== undefined) throw renderFailed(`执行 ${bin} 失败:${res.spawnError.message}`);
  if (res.status !== 0) throw renderFailed(`${bin} 退出码 ${String(res.status)}:${(res.stderr || res.stdout).slice(0, 500)}`);
  if (!existsSync(expected)) throw renderFailed(`${bin} 未产出 PDF:${expected}`);
  const size = statSync(expected).size;
  if (size <= 0) throw renderFailed(`${bin} 产出的 PDF 为 0 字节:${expected}`);
  return { engine: "soffice", pdfPath: expected, pngPaths: [], durationMs, stdout: res.stdout };
}

/** gs 出 PNG:`gs -sDEVICE=png16m -r110 -o <outDir>/page-%03d.png <pdfPath>`,收集 page-*.png 排序。 */
export function renderToPng(pdfPath: string, outDir: string, opts?: { bin?: string }): RenderResult {
  const bin = opts?.bin ?? "gs";
  if (!existsSync(pdfPath)) throw unreadable(`输入不存在:${pdfPath}`);
  mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  const res = spawnEngine(bin, ["-sDEVICE=png16m", "-r110", "-o", join(outDir, "page-%03d.png"), pdfPath]);
  const durationMs = Date.now() - started;
  if (isEngineMissing(res.spawnError)) {
    throw new OfficeExportError(EXPORT_ENGINE_MISSING, `找不到栅格化引擎:${bin}`);
  }
  if (res.spawnError !== undefined) throw renderFailed(`执行 ${bin} 失败:${res.spawnError.message}`);
  if (res.status !== 0) throw renderFailed(`${bin} 退出码 ${String(res.status)}:${(res.stderr || res.stdout).slice(0, 500)}`);
  const pngPaths = readdirSync(outDir)
    .filter((name) => /^page-[0-9]+\.png$/.test(name))
    .sort()
    .map((name) => join(outDir, name))
    .filter((file) => {
      try {
        return statSync(file).size > 0;
      } catch {
        return false;
      }
    });
  if (pngPaths.length === 0) throw renderFailed(`${bin} 未产出任何 PNG:${outDir}`);
  return { engine: "gs", pdfPath: null, pngPaths, durationMs, stdout: res.stdout };
}

// ---------------------------------------------------------------------------
// 产物 + 账本
// ---------------------------------------------------------------------------

/** 一次导出的完整记录(落盘产物 = 这份 JSON;`at` 不参与「内容等价」判定)。 */
export interface ExportRecord {
  inputPath: string;
  inputSha256: string;
  target: Target;
  code: ExportCode;
  preflight?: PreflightResult;
  artifact?: { path: string; sha256: string; bytes: number; pages: number };
  engine?: string;
  offline?: boolean;
  at: number;
}

export interface ExportLedgerEntry {
  inputSha256: string;
  target: string;
  code: string;
  at: number;
}

function equivalent(a: ExportRecord, b: ExportRecord): boolean {
  try {
    return JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 });
  } catch {
    return false;
  }
}

/**
 * 落盘一次导出:`<outDir>/<sha 前 12>.json`(幂等)+ `ledger.jsonl`(同 sha+target 只一行)。
 * reused=true 表示产物内容等价、没重写;ledgerAppended 表示这次真往账本追了一行。
 */
export function writeExportReport(
  root: string,
  record: ExportRecord): { reportPath: string; ledgerAppended: boolean; reused: boolean } {
  const paths = officeExportPaths(root);
  const reportPath = join(paths.outDir, `${record.inputSha256.slice(0, 12)}.json`);
  let reused = false;
  let skipWrite = false;
  if (existsSync(reportPath)) {
    try {
      const existing = JSON.parse(readFileSync(reportPath, "utf8")) as ExportRecord;
      if (existing !== null && typeof existing === "object" && equivalent(existing, record)) {
        reused = true;
        skipWrite = true;
      }
    } catch {
 /* 坏产物当不存在:覆盖重写更安全 */
    }
  }
  if (!skipWrite) {
    const payload: ExportRecord = { ...record };
    writeFileAtomic(reportPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
  const ledger = readExportLedger(root);
  const already = ledger.some((line) => line.inputSha256 === record.inputSha256 && line.target === record.target);
  if (!already) {
    const line: ExportLedgerEntry = {
      inputSha256: record.inputSha256,
      target: record.target,
      code: record.code,
      at: record.at,
    };
    mkdirSync(dirname(paths.ledgerFile), { recursive: true });
    appendFileSync(paths.ledgerFile, `${JSON.stringify(line)}\n`, "utf8");
  }
  return { reportPath, ledgerAppended: !already, reused };
}

/** 读账本(逐行 JSON;坏行跳过,不 throw:账本是索引,不是权威)。 */
export function readExportLedger(root: string): ExportLedgerEntry[] {
  let paths: OfficeExportPaths;
  try {
    paths = officeExportPaths(root);
  } catch {
    return [];
  }
  if (!existsSync(paths.ledgerFile)) return [];
  let raw: string;
  try {
    raw = readFileSync(paths.ledgerFile, "utf8");
  } catch {
    return [];
  }
  const out: ExportLedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.inputSha256 !== "string" || typeof parsed.target !== "string") continue;
      out.push({
        inputSha256: parsed.inputSha256,
        target: parsed.target,
        code: typeof parsed.code === "string" ? parsed.code : "",
        at: typeof parsed.at === "number" ? parsed.at : 0,
      });
    } catch {
 /* 坏行跳过 */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 退出码
// ---------------------------------------------------------------------------

/** 内容违规/不支持 → 2;其余(参数、引擎缺失、store 自产码)→ 1。 */
const EXIT_TWO_CODES = new Set<string>([
  "EXPORT_UNSUPPORTED",
  "EXPORT_MANIFEST_MISSING",
  "EXPORT_MANIFEST_MISMATCH",
  "EXPORT_EXTERNAL_REF",
  "EXPORT_PLACEHOLDER",
  "EXPORT_EMPTY_PAGE",
  "EXPORT_EMPTY_DECK",
  "EXPORT_OFFLINE_VIOLATION",
  "EXPORT_ARTIFACT_INVALID",
]);

export function exitCodeOf(code: ExportCode | string): 0 | 1 | 2 {
  const value = String(code ?? "");
  if (value === EXPORT_OK || value === "EXPORT_OK") return 0;
  if (EXIT_TWO_CODES.has(value)) return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// 组合流程(preflight / verify)
// ---------------------------------------------------------------------------

/** 产物校验结论(runtime 持有);这里原样转出,避免两份同名类型漂移。 */
export type { ArtifactVerdict };

/** 一次 preflight:抽取事实 → runtime 裁决 → 产物 + 账本落盘。 */
export async function runPreflight(
  root: string,
  filePath: string,
  target: Target,
  opts?: { offline?: boolean; manifest?: string | null },
): Promise<{ facts: ExtractedFacts; preflight: PreflightResult; reportPath: string }> {
  const facts = await extractFacts(filePath);
  const inputSha256 = sha256Hex(readFileSync(filePath));
  const manifestName = opts?.manifest ?? null;
  const manifest = manifestName === null ? null : readManifest(root, manifestName);
  const preflight = preflightExport({
    inputKind: facts.inputKind,
    target,
    pages: facts.pages,
    fonts: facts.fonts,
    externalRefs: facts.externalRefs,
    placeholders: facts.placeholders,
    ...(manifest === null ? {} : { manifest }),
    ...(opts?.offline === undefined ? {} : { offline: opts.offline }),
  });
  const record: ExportRecord = {
    inputPath: filePath,
    inputSha256,
    target,
    code: preflight.code,
    preflight,
    ...(opts?.offline === undefined ? {} : { offline: opts.offline }),
    at: Date.now(),
  };
  const { reportPath } = writeExportReport(root, record);
  return { facts, preflight, reportPath };
}

function targetOfArtifact(artifactPath: string): Target {
  const lower = artifactPath.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".png")) return "png";
  if (lower.endsWith(".md")) return "md";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  return "pptx";
}

/** 产物校验:输入/产物双指纹 + 字节数 + 页数(可给 expectedPages 卡页数)。 */
export function runVerify(
  root: string,
  filePath: string,
  artifactPath: string,
  expectedPages?: number): { verdict: ArtifactVerdict; artifactPages: number; artifactSha256: string; reportPath: string } {
  let inputBytes: Buffer;
  try {
    inputBytes = readFileSync(filePath);
  } catch (err) {
    throw unreadable(`读取失败:${filePath}:${errText(err)}`);
  }
  let artifactBytes: Buffer;
  try {
    artifactBytes = readFileSync(artifactPath);
  } catch (err) {
    throw unreadable(`读取失败:${artifactPath}:${errText(err)}`);
  }
  const artifactSha256 = sha256Hex(artifactBytes);
  const target = targetOfArtifact(artifactPath);
  const artifactPages = target === "pdf" && artifactBytes.length > 0 ? countPdfPages(artifactBytes.toString("latin1")) : 0;
  const verdict = verifyArtifact({
    inputSha256: sha256Hex(inputBytes),
    artifactSha256,
    bytes: artifactBytes.length,
    pages: artifactPages,
    ...(expectedPages === undefined ? {} : { expectedPages }),
  });
  const record: ExportRecord = {
    inputPath: filePath,
    inputSha256: sha256Hex(inputBytes),
    target,
    code: verdict.code,
    artifact: { path: artifactPath, sha256: artifactSha256, bytes: artifactBytes.length, pages: artifactPages },
    at: Date.now(),
  };
  const { reportPath } = writeExportReport(root, record);
  return { verdict, artifactPages, artifactSha256, reportPath };
}
