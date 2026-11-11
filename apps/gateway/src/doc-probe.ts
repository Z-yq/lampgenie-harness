/**
 * 富文件输入探测(任务)。
 * 为什么单独一层:办公/富文件解析前要先看清"这份文件到底能不能安全解"——
 * 加密、损坏、zip 炸弹、超大、不安全外链,任何一项都不该等解析器崩了才发现。
 * 本模块是纯逻辑:只吃 bytes + ext,零文件 IO、零网络、不 throw、确定性输出。
 * 为什么解压前必须判总大小:zip 的 uncompressedSize 在中央目录里就能读到,
 * 不需要真解压;若等解压后才发现超限,炸弹已经吃满内存/磁盘,进程先挂,守卫形同虚设。
 * 因此这里只读中央目录求和,绝不整体 inflate(rels 文本除外,单条有独立上限)。
 */
import { inflateRawSync } from "node:zlib";

/** 探测结论码(顺序即契约,测试会逐字比对)。 */
export const DOC_PROBE_CODES = [
  "OK",
  "ENCRYPTED",
  "CORRUPT",
  "ZIP_BOMB",
  "TOO_LARGE",
  "UNSUPPORTED",
] as const;

export type DocProbeCode = (typeof DOC_PROBE_CODES)[number];

export type DocProbeKind = "pdf" | "docx" | "pptx" | "xlsx" | "other";

export interface DocProbeExternalLink {
  target: string;
  allowed: boolean;
  reason?: string;
}

export interface DocProbeResult {
  code: DocProbeCode;
  kind: DocProbeKind;
  bytes: number;
  pages?: number;
  encrypted?: boolean;
  corrupt?: boolean;
  zipUncompressedBytes?: number;
  externalLinks: DocProbeExternalLink[];
  warnings: string[];
}

export interface DocProbeOptions {
 /** 原始字节上限,默认 64MiB。 */
  maxBytes?: number;
 /** zip 解压总量上限,默认 512MiB。 */
  maxUncompressed?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_UNCOMPRESSED = 512 * 1024 * 1024;
/** rels 文本只做协议扫描,单条设独立上限,避免被超大 XML 反噬。 */
const MAX_RELS_ENTRIES = 256;
const MAX_RELS_COMPRESSED = 4 * 1024 * 1024;
const MAX_RELS_UNCOMPRESSED = 16 * 1024 * 1024;
/** 外链最多记录多少条(统计的是丢弃数,记录本身只需样例)。 */
const MAX_RECORDED_LINKS = 100;

const OOXML_EXT = new Set(["docx", "pptx", "xlsx"]);

function normExt(ext: string): string {
  return String(ext ?? "").trim().toLowerCase().replace(/^\.+/, "");
}

function kindOf(ext: string): DocProbeKind {
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "pptx") return "pptx";
  if (ext === "xlsx") return "xlsx";
  return "other";
}

function limitOf(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

function latin1(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message || e.name || "unknown";
  return String(e);
}

// ───────────────────────── 协议白名单 ─────────────────────────

/**
 * OOXML 外链目标协议判定:只放行 http/https。
 * 为什么必须白名单而不是黑名单:黑名单永远漏(大小写、空白、编码变体),白名单只认两种协议,
 * javascript:/data:/file:/vbscript: 等一律拒绝并给出 reason 供审计。
 */
export function sanitizeExternalTarget(target: string): {
  allowed: boolean;
  protocol?: string;
  reason?: string;
} {
  const raw = String(target ?? "").trim();
  if (!raw) return { allowed: false, reason: "空目标" };
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(raw);
  if (!m) return { allowed: false, reason: "相对路径或缺少协议头" };
  const protocol = (m[1] ?? "").toLowerCase();
  if (protocol === "http" || protocol === "https") {
    const rest = raw.slice(m[0].length);
    if (!rest.startsWith("//") || rest.length <= 2) {
      return { allowed: false, protocol, reason: "缺少主机名" };
    }
    return { allowed: true, protocol };
  }
  const dangerous = new Set(["javascript", "data", "file", "vbscript", "blob", "about"]);
  if (dangerous.has(protocol)) return { allowed: false, protocol, reason: `危险协议 ${protocol}:` };
  return { allowed: false, protocol, reason: `不支持的协议 ${protocol}:` };
}

// ───────────────────────── 路径归一(realpath 语义的纯字符串版) ─────────────────────────

function isWindowsStyle(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

function normalizePath(p: string): string {
  let s = String(p ?? "").trim().replace(/\\/g, "/");
  const win = isWindowsStyle(s);
  let rootPrefix = "";
  if (/^[A-Za-z]:\//.test(s)) {
    rootPrefix = s.slice(0, 2);
    s = s.slice(2);
  } else if (s.startsWith("//")) {
    rootPrefix = "//";
    s = s.slice(2);
  } else if (s.startsWith("/")) {
    rootPrefix = "/";
    s = s.slice(1);
  }
  const segs: string[] = [];
  for (const seg of s.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (segs.length) segs.pop();
 // 绝对根之上无法再回退;相对路径保留 ".." 供后续判越界
      else if (!rootPrefix) segs.push("..");
      continue;
    }
    segs.push(seg);
  }
  let out: string;
  if (rootPrefix === "//") out = "//" + segs.join("/");
  else if (rootPrefix === "/") out = "/" + segs.join("/");
  else if (rootPrefix) out = rootPrefix + "/" + segs.join("/");
  else out = segs.join("/");
 // 大小写不敏感只在 Windows 语义路径下生效(盘符/UNC),POSIX 路径保持大小写敏感
  if (win) out = out.toLowerCase();
  return out;
}

/**
 * candidate 是否落在 root 之内(纯字符串归一,不碰文件系统)。
 * 分隔符统一、`.`/`..` 归一、Windows 盘符/UNC 大小写不敏感;越界返回 false。
 */
export function isPathWithinRoot(candidate: string, root: string): boolean {
  const c = normalizePath(candidate);
  const r = normalizePath(root);
  if (c === r) return true;
  const base = r.endsWith("/") ? r : r + "/";
  return c.startsWith(base);
}

// ───────────────────────── 错误码映射 ─────────────────────────

/** 探测结论 → 上层专门错误码;OK 无错误码(返回 undefined)。 */
export function probeVerdictToErrorCode(code: DocProbeCode): string | undefined {
  switch (code) {
    case "ENCRYPTED":
      return "DOC_ENCRYPTED";
    case "CORRUPT":
      return "DOC_CORRUPT";
    case "ZIP_BOMB":
      return "DOC_ZIP_BOMB";
    case "TOO_LARGE":
      return "DOC_TOO_LARGE";
    case "UNSUPPORTED":
      return "DOC_UNSUPPORTED";
    default:
      return undefined;
  }
}

// ───────────────────────── PDF ─────────────────────────

function countPdfPages(src: string): number {
 // /Type /Page 是页对象,/Type /Pages 是页树,不能混计
  const re = /\/Type\s*\/Page(?!s)/g;
  let n = 0;
  for (const _ of src.matchAll(re)) n++;
  return n;
}

function probePdf(bytes: Uint8Array, maxBytes: number): DocProbeResult {
  const result: DocProbeResult = {
    code: "OK",
    kind: "pdf",
    bytes: bytes.length,
    externalLinks: [],
    warnings: [],
  };
  if (bytes.length > maxBytes) {
    return { ...result, code: "TOO_LARGE", warnings: ["文件超过字节上限"] };
  }
  const headLen = Math.min(bytes.length, 1024);
  const head = latin1(bytes.subarray(0, headLen));
  if (head.indexOf("%PDF-") < 0) {
    return { ...result, code: "CORRUPT", corrupt: true, warnings: ["缺少 %PDF- 文件头"] };
  }
  const tailStart = Math.max(0, bytes.length - 4096);
  const tail = latin1(bytes.subarray(tailStart));
 // 结束标记二选一:规范 PDF 应有 startxref;极简/部分生成器只留 %%EOF。
 // 两者都缺才算损坏(否则会把能解析的最小 PDF 误杀)。
  const hasStartxref = tail.indexOf("startxref") >= 0;
  const hasEof = tail.indexOf("%%EOF") >= 0;
  if (!hasStartxref && !hasEof) {
    return {
      ...result,
      code: "CORRUPT",
      corrupt: true,
      warnings: ["缺少 startxref/%%EOF(文件尾损坏或未完整下载)"],
    };
  }
  const warnings = hasStartxref ? [] : ["缺少 startxref,但存在 %%EOF,仍尝试解析"];
  const full = latin1(bytes);
  const pages = countPdfPages(full);
  if (/\/Encrypt\b/.test(full)) {
    return { ...result, code: "ENCRYPTED", encrypted: true, pages, warnings: [...warnings, "PDF 含 /Encrypt,已加密"] };
  }
  return { ...result, pages, warnings };
}

// ───────────────────────── OOXML(zip 中央目录 + rels 外链) ─────────────────────────

interface ZipEntry {
  flags: number;
  method: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
  name: string;
}

function u16(dv: DataView, off: number): number {
  return dv.getUint16(off, true);
}
function u32(dv: DataView, off: number): number {
  return dv.getUint32(off, true);
}

function findEocd(bytes: Uint8Array, dv: DataView): number {
  const first = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= first; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      const commentLen = u16(dv, i + 20);
      if (i + 22 + commentLen === bytes.length) return i;
    }
  }
  return -1;
}

/** 只读中央目录,不 inflate:条目名、压缩/解压大小、加密标志。 */
function parseZip(bytes: Uint8Array): { entries: ZipEntry[] } | null {
  if (bytes.length < 22) return null;
  const isLocal = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const isEmpty = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x05 && bytes[3] === 0x06;
  if (!isLocal && !isEmpty) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes, dv);
  if (eocd < 0) return null;
  const total = u16(dv, eocd + 10);
  const cdOffset = u32(dv, eocd + 16);
  if (cdOffset >= bytes.length) return null;
  let p = cdOffset;
  const entries: ZipEntry[] = [];
  for (let n = 0; n < total; n++) {
    if (p + 46 > bytes.length) return null;
    if (u32(dv, p) !== 0x02014b50) return null;
    const flags = u16(dv, p + 8);
    const method = u16(dv, p + 10);
    const compSize = u32(dv, p + 20);
    const uncompSize = u32(dv, p + 24);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const commentLen = u16(dv, p + 32);
    const localOffset = u32(dv, p + 42);
    const nameEnd = p + 46 + nameLen;
    if (nameEnd > bytes.length) return null;
    const name = new TextDecoder().decode(bytes.subarray(p + 46, nameEnd));
    entries.push({ flags, method, compSize, uncompSize, localOffset, name });
    p = nameEnd + extraLen + commentLen;
  }
  return { entries };
}

function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array | null {
  if (entry.compSize > MAX_RELS_COMPRESSED || entry.uncompSize > MAX_RELS_UNCOMPRESSED) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const off = entry.localOffset;
  if (off + 30 > bytes.length) return null;
  if (u32(dv, off) !== 0x04034b50) return null;
  const nameLen = u16(dv, off + 26);
  const extraLen = u16(dv, off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compSize;
  if (dataEnd > bytes.length) return null;
  const raw = bytes.subarray(dataStart, dataEnd);
  try {
    if (entry.method === 0) return raw;
    if (entry.method === 8) return new Uint8Array(inflateRawSync(raw));
    return null;
  } catch {
    return null;
  }
}

function attrValue(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? m[1] ?? m[2] : undefined;
}

function collectExternalLinks(xml: string, out: DocProbeExternalLink[]): void {
  const re = /<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*?\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const mode = attrValue(tag, "TargetMode");
    if (!mode || mode.toLowerCase() !== "external") continue;
    const target = attrValue(tag, "Target");
    if (!target) continue;
    const verdict = sanitizeExternalTarget(target);
    out.push({ target, allowed: verdict.allowed, ...(verdict.reason ? { reason: verdict.reason } : {}) });
    if (out.length >= MAX_RECORDED_LINKS) return;
  }
}

function probeOoxml(
  bytes: Uint8Array,
  kind: DocProbeKind,
  maxBytes: number,
  maxUncompressed: number): DocProbeResult {
  const result: DocProbeResult = { code: "OK", kind, bytes: bytes.length, externalLinks: [], warnings: [] };
  if (bytes.length > maxBytes) {
    return { ...result, code: "TOO_LARGE", warnings: ["文件超过字节上限"] };
  }
  const zip = parseZip(bytes);
  if (!zip) {
    return { ...result, code: "CORRUPT", corrupt: true, warnings: ["不是有效的 zip/OOXML 文件"] };
  }
  if (zip.entries.some((e) => (e.flags & 0x1) !== 0)) {
    return { ...result, code: "ENCRYPTED", encrypted: true, warnings: ["zip 条目已加密"] };
  }
  let total = 0;
  for (const e of zip.entries) {
 // zip64 标记(0xFFFFFFFF)本身就是巨物,直接按上界计
    total += e.uncompSize === 0xffffffff ? 0xffffffff : e.uncompSize;
  }
  if (total > maxUncompressed) {
    return {
      ...result,
      code: "ZIP_BOMB",
      zipUncompressedBytes: total,
      warnings: [`解压总量 ${total} 字节超过上限 ${maxUncompressed}`],
    };
  }
  const externalLinks: DocProbeExternalLink[] = [];
  let scanned = 0;
  for (const e of zip.entries) {
    if (scanned >= MAX_RELS_ENTRIES) break;
    if (!/_rels\/[^/]+\.(?:rels|xml)$/i.test(e.name)) continue;
    scanned++;
    const data = readZipEntry(bytes, e);
    if (!data) continue;
    collectExternalLinks(latin1(data), externalLinks);
  }
  const denied = externalLinks.filter((l) => !l.allowed).length;
  const warnings = denied > 0 ? [`已丢弃 ${denied} 个不安全外链`] : [];
  return { ...result, zipUncompressedBytes: total, externalLinks, warnings };
}

// ───────────────────────── 入口 ─────────────────────────

/**
 * 探测一份输入字节。永不抛错:任何异常都收敛成 CORRUPT(带 warnings 说明)。
 * 文本类(md/txt/...)由 doc-text 自己处理,不走本探针,视为 UNSUPPORTED。
 */
export function probeDocument(bytes: Uint8Array, ext: string, opts?: DocProbeOptions): DocProbeResult {
  const safe = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  const e = normExt(ext);
  const maxBytes = limitOf(opts?.maxBytes, DEFAULT_MAX_BYTES);
  const maxUncompressed = limitOf(opts?.maxUncompressed, DEFAULT_MAX_UNCOMPRESSED);
  try {
    if (e === "pdf") return probePdf(safe, maxBytes);
    if (OOXML_EXT.has(e)) return probeOoxml(safe, kindOf(e), maxBytes, maxUncompressed);
    return {
      code: "UNSUPPORTED",
      kind: "other",
      bytes: safe.length,
      externalLinks: [],
      warnings: [`不支持探测的类型:${e || "(无扩展名)"}`],
    };
  } catch (err) {
    return {
      code: "CORRUPT",
      kind: kindOf(e),
      bytes: safe.length,
      corrupt: true,
      externalLinks: [],
      warnings: [`探测异常:${errMsg(err)}`],
    };
  }
}
