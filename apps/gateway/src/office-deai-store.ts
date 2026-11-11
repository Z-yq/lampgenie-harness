/**
 * 办公文档「去 AI 味」审计的持久层(gateway 侧):把 office-deai 的纯逻辑接到磁盘上。
 * 为什么分成「抽取 / 判定 / 落盘」三层而不是一个大函数:
 * - 抽取只负责把 md/txt/docx/pptx/xlsx 变成本文,判定复用 runtime 的纯函数(可复现),
 * 落盘只负责 artifact + ledger。三层各自失败各有稳定码,排查时不用猜是哪层坏了。
 * - 判定零 IO、落盘零规则知识:改规则不会碰到写盘代码,改写入策略不会改历史分数。
 * 为什么 ledger 必须幂等(同 hash 不追加):审计台账一旦重复计数,「这份文档被判了几次」
 * 就成了噪声;hash 是文件内容的指纹,同内容再跑一次只刷新 artifact,不动台账。
 * 为什么写入必须原子(写 tmp 再 rename):ledger 是 append-only 的历史,写到一半被 kill 会得到
 * 一个半行 JSON,整份台账从此 parse 失败(等于丢全部历史)。rename 在同文件系统上原子,
 * 写后重读比对让「写成功了吗」成为可复核断言;失败一律清理 tmp,目录里不留脏文件。
 * 为什么 root 必须白名单(tmpdir 下):审计会在 root 里建 `.genie/office/deai` 目录并写文件,
 * 手滑把 `--root .` 指到仓库就会污染工作树。prefix 判定要按路径分隔符做边界,否则 /tmpfoo 也算 /tmp。
 * 依赖纪律:runtime 与 workflow-hole-store 同一套路(两跳惰性解析):① development 条件走包源入口;
 * ② 回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097)。类型侧允许静态 import type
 * (types 条件指向 src,与 dist 是否 build 无关);值侧一律惰性。
 * 除「调用方参数错」外不 throw:IO/解析失败折叠成稳定码。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import JSZip from "jszip";

/** 裁定档位(与 runtime 同集合)。 */
export type DeaiVerdict = "pass" | "warn" | "fail";

/**
 * runtime 结果的最小结构面。刻意**不**静态 import runtime 的类型:
 * 包导出 types 条件指向 `packages/harness-runtime/src/agent/office-deai.ts`,
 * 静态 import 会把这个跨包源文件拖进 gateway 的 tsc 程序,让 `tsc --noEmit` 报上游文件的错。
 * 这里按契约结构声明,值侧仍走两跳惰性解析(见文件头依赖纪律)。
 */
interface DeaiFindingLike {
  ruleId: string;
  excerpt: string;
  category?: string;
  severity?: string;
  offset?: number;
  length?: number;
  hint?: string;
}

interface DeaiExemptionLike {
  ruleId: string;
  excerpt: string;
  reason: string;
  owner?: string;
}

interface DeaiResultLike {
  ok: boolean;
  codes: readonly string[];
  score: number;
  verdict: DeaiVerdict;
  findings: readonly DeaiFindingLike[];
  stats?: unknown;
  audit?: unknown;
}

interface DeaiExemptedResultLike extends DeaiResultLike {
  residualFindings?: readonly DeaiFindingLike[];
  residualScore?: number;
  residualVerdict?: DeaiVerdict;
  exemptions?: unknown;
}

/** store 层的稳定码(CLI 按码分流,不解析文案)。 */
export const DEAI_STORE_CODES: readonly string[] = [
  "DEAI_OK",
  "DEAI_INVALID",
  "DEAI_ROOT_UNSAFE",
  "DEAI_READ_FAILED",
  "DEAI_PARSE_FAILED",
  "DEAI_STORE_FAILED",
  "DEAI_UNSUPPORTED_KIND",
];

/** artifact/ledger schema 版本:字段语义变化时递增。 */
export const DEAI_STORE_VERSION = 1;

export type DeaiKind = "md" | "txt" | "docx" | "pptx" | "xlsx";

export interface ExtractedDoc {
  ok: boolean;
  code: string;
  file: string;
  kind: DeaiKind;
  text: string;
  chars: number;
  hash: string;
  reason?: string;
}

export interface DeaiTopRule {
  ruleId: string;
  count: number;
}

export interface DeaiCheckOutcome {
  ok: boolean;
  code: string;
  codes: string[];
  file: string;
  kind: DeaiKind;
  hash: string;
  score: number;
  verdict: DeaiVerdict;
  residualScore?: number;
  residualVerdict?: DeaiVerdict;
  findings: number;
  topRules: DeaiTopRule[];
  chars: number;
  artifactPath?: string;
  appended?: boolean;
  parseError?: string;
}

export interface DeaiLedgerEntry {
  v: number;
  at: number;
  hash: string;
  file: string;
  kind: string;
  chars: number;
  score: number;
  verdict: string;
  residualScore?: number;
  residualVerdict?: string;
  findings: number;
  topRules: DeaiTopRule[];
  codes: string[];
  rulesVersion: string;
  warnThreshold: number;
  failThreshold: number;
}

export interface DeaiReport {
  ok: boolean;
  code?: string;
  files: number;
  scores: number[];
  verdicts: { pass: number; warn: number; fail: number };
  topRules: DeaiTopRule[];
  parseErrors: number;
  rulesVersion: string;
}

/** runtime 面(只声明用到的部分,避免把整个模块的类型拖进来)。 */
interface DeaiRuntime {
  DEAI_RULES_VERSION: string;
  analyzeDocument(
    input: { text: string; kind?: string } | undefined,
    opts?: { warnThreshold?: number; failThreshold?: number },
  ): DeaiResultLike;
  applyExemptions(result: DeaiResultLike, exemptions: readonly DeaiExemptionLike[] | undefined): DeaiExemptedResultLike;
}

let deaiRuntime: DeaiRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadDeaiRuntime(): Promise<DeaiRuntime> {
  if (deaiRuntime) return deaiRuntime;
  const spec = "@lampgenie/runtime/agent/office-deai";
  try {
    deaiRuntime = (await import(spec)) as unknown as DeaiRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/office-deai.ts", import.meta.url).href;
    deaiRuntime = (await import(srcUrl)) as unknown as DeaiRuntime;
  }
  return deaiRuntime;
}

/** runtime 面(顶层 await:导出函数保持既有 gateway store 的同步/异步签名)。 */
const rt = await loadDeaiRuntime();

/** artifact 目录:`<root>/.genie/office/deai`。 */
export function deaiDir(root: string): string {
  return join(root, ".genie", "office", "deai");
}

/** 单文档审计报告路径。 */
export function artifactPathOf(root: string, hash: string): string {
  return join(deaiDir(root), `${hash}.json`);
}

/** 审计台账路径(append-only JSONL)。 */
export function ledgerPathOf(root: string): string {
  return join(deaiDir(root), "ledger.jsonl");
}

const KINDS: readonly DeaiKind[] = ["md", "txt", "docx", "pptx", "xlsx"];

/** 扩展名 → 文档类别;不认识的返回 undefined(上层给 DEAI_UNSUPPORTED_KIND)。 */
function kindOf(file: string): DeaiKind | undefined {
  const lower = file.toLowerCase();
  if (lower.endsWith(".md")) return "md";
  if (lower.endsWith(".txt")) return "txt";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".pptx")) return "pptx";
  if (lower.endsWith(".xlsx")) return "xlsx";
  return undefined;
}

/** sha256(bytes) 前 12 位 hex:内容指纹,artifact 与 ledger 都以它为键。 */
function hashOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

/** XML 实体解码(单趟替换,避免 `&amp;lt;` 被二次解码成 `<`)。 */
function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        break;
    }
    const code = body.startsWith("#x") ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
    try {
      return String.fromCodePoint(code);
    } catch {
      return whole;
    }
  });
}

/** 段落式抽取(docx 的 w:t / pptx 的 a:t 共用):按出现顺序取文本,段结束补换行。 */
function extractParagraphs(xml: string, prefix: "w" | "a"): string {
  const token = new RegExp(
    `<${prefix}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${prefix}:t>` +
      `|<${prefix}:br(?:\\s[^>]*)?/>` +
      `|</${prefix}:p>` +
      `|<${prefix}:p(?:\\s[^>]*)?/>`,
    "g",
  );
  const lines: string[] = [];
  let current = "";
  let match: RegExpExecArray | null = token.exec(xml);
  while (match !== null) {
    const raw = match[0];
    if (match[1] !== undefined) current += decodeXmlEntities(match[1]);
    else if (raw.startsWith("</" + prefix + ":p") || raw.startsWith("<" + prefix + ":br")) {
      lines.push(current);
      current = "";
    } else if (raw.startsWith("<" + prefix + ":p")) {
      lines.push(""); // 空段落仍占一行(否则「空行分段」在抽取后就消失了)
    }
    match = token.exec(xml);
  }
  if (current !== "") lines.push(current);
  return lines.join("\n");
}

/** 数字升序比较 slide1/sheet2 这类 part 名(字典序会把 slide10 排到 slide2 前面)。 */
function numericOrder(a: { num: number; part: string }, b: { num: number; part: string }): number {
  return a.num === b.num ? a.part.localeCompare(b.part) : a.num - b.num;
}

/** 按正则收集 zip 里的部件,并按名字里的数字升序返回。 */
function partsOf(zip: JSZip, re: RegExp): string[] {
  const found: { num: number; part: string }[] = [];
  for (const part of Object.keys(zip.files)) {
    const match = re.exec(part);
    if (match === null) continue;
    found.push({ num: Number.parseInt(match[1] ?? "0", 10), part });
  }
  return found.sort(numericOrder).map((entry) => entry.part);
}

const DOCX_PART = "word/document.xml";
const PPTX_SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const XLSX_SHEET_RE = /^xl\/worksheets\/sheet(\d+)\.xml$/;

/** ZIP 部件读取(async-jszip):缺部件返回 undefined。 */
async function readPart(zip: JSZip, part: string): Promise<string | undefined> {
  const entry = zip.file(part);
  if (entry === null) return undefined;
  try {
    return await entry.async("string");
  } catch {
    return undefined;
  }
}

/** docx 抽取:document.xml 按出现顺序取 w:t(表格里的 w:t 天然在正确位置,不单独排序)。 */
async function extractDocx(zip: JSZip): Promise<{ ok: boolean; text?: string; reason?: string }> {
  const xml = await readPart(zip, DOCX_PART);
  if (xml === undefined) return { ok: false, reason: `缺 ${DOCX_PART}` };
  return { ok: true, text: extractParagraphs(xml, "w") };
}

/** pptx 抽取:slideN 按数字升序,片内 a:t 按出现序,片间换行。 */
async function extractPptx(zip: JSZip): Promise<{ ok: boolean; text?: string; reason?: string }> {
  const slides = partsOf(zip, PPTX_SLIDE_RE);
  if (slides.length === 0) return { ok: false, reason: "缺 ppt/slides/slideN.xml" };
  const chunks: string[] = [];
  for (const part of slides) {
    const xml = await readPart(zip, part);
    if (xml === undefined) return { ok: false, reason: `读 ${part} 失败` };
    const text = extractParagraphs(xml, "a");
    if (text !== "") chunks.push(text);
  }
  return { ok: true, text: chunks.join("\n") };
}

/** sharedStrings.xml → si 文本数组(缺失时返回空数组:字符串单元格退化成空,不影响抽取)。 */
async function readSharedStrings(zip: JSZip): Promise<string[]> {
  const xml = await readPart(zip, "xl/sharedStrings.xml");
  if (xml === undefined) return [];
  const out: string[] = [];
  const siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let si = siRe.exec(xml);
  while (si !== null) {
    const body = si[1] ?? "";
    let text = "";
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t = tRe.exec(body);
    while (t !== null) {
      text += decodeXmlEntities(t[1] ?? "");
      t = tRe.exec(body);
    }
    out.push(text);
    si = siRe.exec(xml);
  }
  return out;
}

/** 单元格取值:共享串 / 内联串 / 直写字符串 / 数字。 */
function cellValue(attrs: string, body: string, shared: string[]): string {
  const typeMatch = /\bt\s*=\s*"([^"]*)"/.exec(attrs);
  const type = typeMatch?.[1] ?? "";
  if (type === "inlineStr") {
    const isMatch = /<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/.exec(body);
    const target = isMatch === null ? body : (isMatch[1] ?? "");
    let text = "";
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t = tRe.exec(target);
    while (t !== null) {
      text += decodeXmlEntities(t[1] ?? "");
      t = tRe.exec(target);
    }
    return text;
  }
  const valueMatch = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
  const raw = valueMatch === null ? "" : decodeXmlEntities(valueMatch[1] ?? "");
  if (type === "s") {
    const index = Number.parseInt(raw, 10);
    if (!Number.isFinite(index)) return "";
    return shared[index] ?? "";
  }
  return raw;
}

/** xlsx 抽取:sheetN 按数字升序,行内单元格按出现序(制表符分隔),行间换行。 */
async function extractXlsx(zip: JSZip): Promise<{ ok: boolean; text?: string; reason?: string }> {
  const sheets = partsOf(zip, XLSX_SHEET_RE);
  if (sheets.length === 0) return { ok: false, reason: "缺 xl/worksheets/sheetN.xml" };
  const shared = await readSharedStrings(zip);
  const sheetTexts: string[] = [];
  for (const part of sheets) {
    const xml = await readPart(zip, part);
    if (xml === undefined) return { ok: false, reason: `读 ${part} 失败` };
    const rows: string[] = [];
    const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g;
    let row = rowRe.exec(xml);
    while (row !== null) {
      const body = row[1] ?? "";
      const cells: string[] = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cell = cellRe.exec(body);
      while (cell !== null) {
        cells.push(cellValue(cell[1] ?? "", cell[2] ?? "", shared));
        cell = cellRe.exec(body);
      }
      rows.push(cells.join("\t"));
      row = rowRe.exec(xml);
    }
    if (rows.length > 0) sheetTexts.push(rows.join("\n"));
  }
  return { ok: true, text: sheetTexts.join("\n") };
}

/**
 * 抽取文档文本(只读:不修改输入文件)。
 * 扩展名不认识 → DEAI_UNSUPPORTED_KIND;读失败 → DEAI_READ_FAILED;zip/关键部件坏 → DEAI_PARSE_FAILED。
 * 任何失败都不 throw。
 */
export async function extractDocument(file: string): Promise<ExtractedDoc> {
  const kind = kindOf(file);
  if (kind === undefined) {
    return {
      ok: false,
      code: "DEAI_UNSUPPORTED_KIND",
      file,
      kind: "txt",
      text: "",
      chars: 0,
      hash: "",
      reason: "不支持的文档类别",
    };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    return {
      ok: false,
      code: "DEAI_READ_FAILED",
      file,
      kind,
      text: "",
      chars: 0,
      hash: "",
      reason: `读取失败:${String((error as { code?: string }).code ?? error)}`,
    };
  }
  const hash = hashOf(bytes);
  if (kind === "md" || kind === "txt") {
    const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
    return { ok: true, code: "DEAI_OK", file, kind, text, chars: text.length, hash };
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return {
      ok: false,
      code: "DEAI_PARSE_FAILED",
      file,
      kind,
      text: "",
      chars: 0,
      hash,
      reason: "不是有效的 OOXML(zip 解包失败)",
    };
  }
  const parsed =
    kind === "docx" ? await extractDocx(zip) : kind === "pptx" ? await extractPptx(zip) : await extractXlsx(zip);
  if (!parsed.ok || parsed.text === undefined) {
    return {
      ok: false,
      code: "DEAI_PARSE_FAILED",
      file,
      kind,
      text: "",
      chars: 0,
      hash,
      reason: parsed.reason ?? "缺关键部件",
    };
  }
  return { ok: true, code: "DEAI_OK", file, kind, text: parsed.text, chars: parsed.text.length, hash };
}

/** 安全根:解析后必须落在 os.tmpdir 或 /tmp 之内(按分隔符做边界,/tmpfoo 不算 /tmp)。 */
export function checkRoot(root: string): { ok: boolean; code?: string; reason?: string; resolved: string } {
  if (typeof root !== "string" || root.trim() === "") {
    return { ok: false, code: "DEAI_INVALID", reason: "root 为空", resolved: "" };
  }
  const resolved = resolve(root);
  const bases: string[] = [];
  for (const base of [tmpdir(), "/tmp"]) {
    if (typeof base === "string" && base.trim() !== "") bases.push(resolve(base));
  }
  const inside = bases.some((base) => {
    const prefix = base.endsWith("/") || base.endsWith("\\") ? base : `${base}/`;
    return resolved === base || resolved.startsWith(prefix);
  });
  if (inside) return { ok: true, resolved };
  return {
    ok: false,
    code: "DEAI_ROOT_UNSAFE",
    reason: `root 必须位于临时目录内(当前 ${resolved})`,
    resolved,
  };
}

/** 一次 ledger 读取的结果。 */
interface LedgerRead {
  ok: boolean;
  entries: DeaiLedgerEntry[];
  parseErrors: number;
  code?: string;
}

/** 极简形状校验:能安全参与后续运算即可(不引 zod)。 */
function isLedgerEntry(value: unknown): value is DeaiLedgerEntry {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<DeaiLedgerEntry>;
  return (
    typeof candidate.hash === "string" &&
    typeof candidate.file === "string" &&
    typeof candidate.score === "number" &&
    typeof candidate.verdict === "string" &&
    typeof candidate.at === "number"
  );
}

/** 读台账:坏行只计数不整份失效(不 throw)。 */
export async function readLedger(root: string): Promise<{ ok: boolean; entries: DeaiLedgerEntry[]; parseErrors: number; code?: string }> {
  const rootCheck = checkRoot(root);
  if (!rootCheck.ok) return { ok: false, entries: [], parseErrors: 0, code: rootCheck.code };
  let text: string;
  try {
    text = readFileSync(ledgerPathOf(rootCheck.resolved), "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { ok: true, entries: [], parseErrors: 0 };
    return { ok: false, entries: [], parseErrors: 0, code: "DEAI_READ_FAILED" };
  }
  const entries: DeaiLedgerEntry[] = [];
  let parseErrors = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      parseErrors += 1;
      continue;
    }
    if (isLedgerEntry(parsed)) entries.push(parsed);
    else parseErrors += 1;
  }
  return { ok: true, entries, parseErrors };
}

/** 原子写:先写 `<file>.tmp-<pid>-<rand>` 再 rename;失败清理 tmp;写后重读比对。 */
function writeAtomic(file: string, content: string): { ok: boolean; reason?: string } {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, file);
  } catch (error) {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
 /* 清理失败不掩盖原始错误 */
    }
    return { ok: false, reason: `写 ${file} 失败:${String((error as { code?: string }).code ?? error)}` };
  }
  try {
    if (readFileSync(file, "utf8") !== content) return { ok: false, reason: `写后重读不一致:${file}` };
  } catch (error) {
    return { ok: false, reason: `写后重读失败:${String((error as { code?: string }).code ?? error)}` };
  }
  return { ok: true };
}

/** 命中项 → topRules(按次数降序,同次数按 ruleId 升序,最多 5 条)。 */
function topRulesOf(findings: readonly DeaiFindingLike[], limit = 5): DeaiTopRule[] {
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.ruleId, (counts.get(finding.ruleId) ?? 0) + 1);
  return [...counts.entries()]
    .map(([ruleId, count]) => ({ ruleId, count }))
    .sort((a, b) => (b.count === a.count ? a.ruleId.localeCompare(b.ruleId) : b.count - a.count))
    .slice(0, limit);
}

/** 阈值:threshold 覆盖 failThreshold;warn 固定 40,若 warn>=fail 则压到 max(0, fail-20) 且保证 warn<fail。 */
function resolveThresholds(threshold: number | undefined): { warn: number; fail: number } {
  const fail = typeof threshold === "number" && Number.isFinite(threshold) ? threshold : 60;
  let warn = 40;
  if (warn >= fail) {
    warn = Math.max(0, fail - 20);
    if (warn >= fail) warn = Math.max(0, fail - 1);
  }
  return { warn, fail };
}

/**
 * 审计一个文档并落盘(artifact 重写、ledger 幂等追加)。
 * root 不合规时不写任何文件,直接返回 ok:false + DEAI_ROOT_UNSAFE。
 */
export async function checkDocument(
  root: string,
  file: string,
  opts?: { threshold?: number; exemptions?: unknown[] },
): Promise<DeaiCheckOutcome> {
  const rootCheck = checkRoot(root);
  const base = (over: Partial<DeaiCheckOutcome> & { kind?: DeaiKind }): DeaiCheckOutcome => ({
    ok: false,
    code: "DEAI_INVALID",
    codes: [],
    file,
    kind: over.kind ?? "txt",
    hash: "",
    score: 0,
    verdict: "fail",
    findings: 0,
    topRules: [],
    chars: 0,
    ...over,
  });
  if (!rootCheck.ok) {
    return base({ code: rootCheck.code ?? "DEAI_ROOT_UNSAFE", kind: kindOf(file) ?? "txt" });
  }
  const resolvedRoot = rootCheck.resolved;

  const extracted = await extractDocument(file);
  if (!extracted.ok) {
    return base({
      code: extracted.code,
      codes: [extracted.code],
      kind: extracted.kind,
      hash: extracted.hash,
    });
  }

  const { warn, fail } = resolveThresholds(opts?.threshold);
  const analyzed = rt.analyzeDocument({ text: extracted.text, kind: extracted.kind }, {
    warnThreshold: warn,
    failThreshold: fail,
  });
  const exemptions = Array.isArray(opts?.exemptions) ? opts.exemptions : [];
  const withExemptions = exemptions.length > 0;
  const judged: DeaiExemptedResultLike | DeaiResultLike = withExemptions
    ? rt.applyExemptions(analyzed, exemptions as DeaiExemptionLike[])
    : analyzed;

  const findings = Array.isArray(judged.findings) ? judged.findings : [];
  const residualFindings = withExemptions ? (judged as DeaiExemptedResultLike).residualFindings : undefined;
  const score = typeof judged.score === "number" ? judged.score : 0;
  const verdict = (judged.verdict ?? "fail") as DeaiVerdict;
  const residualScore = withExemptions
    ? typeof (judged as DeaiExemptedResultLike).residualScore === "number"
      ? (judged as DeaiExemptedResultLike).residualScore
      : score
    : undefined;
  const residualVerdict = withExemptions
    ? ((judged as DeaiExemptedResultLike).residualVerdict ?? verdict)
    : undefined;
  const reportedVerdict = withExemptions ? (residualVerdict ?? verdict) : verdict;

  const codes = Array.isArray(judged.codes) ? judged.codes.map(String) : [];
  const artifactPath = artifactPathOf(resolvedRoot, extracted.hash);
  const artifact = {
    v: DEAI_STORE_VERSION,
    at: Date.now(),
    file,
    kind: extracted.kind,
    hash: extracted.hash,
    chars: extracted.chars,
    score,
    verdict,
    residualScore,
    residualVerdict,
    findings,
    residualFindings,
    stats: judged.stats,
    audit: judged.audit,
    exemptions: withExemptions ? (judged as DeaiExemptedResultLike).exemptions : undefined,
    codes,
    rulesVersion: rt.DEAI_RULES_VERSION,
    warnThreshold: warn,
    failThreshold: fail,
  };
  const artifactWrite = writeAtomic(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  if (!artifactWrite.ok) {
    return base({
      code: "DEAI_STORE_FAILED",
      codes: [...codes, "DEAI_STORE_FAILED"],
      kind: extracted.kind,
      hash: extracted.hash,
      chars: extracted.chars,
      score,
      verdict: reportedVerdict,
      findings: findings.length,
      topRules: topRulesOf(findings),
      artifactPath,
      parseError: artifactWrite.reason,
    });
  }

  const entry: DeaiLedgerEntry = {
    v: DEAI_STORE_VERSION,
    at: artifact.at,
    hash: extracted.hash,
    file,
    kind: extracted.kind,
    chars: extracted.chars,
    score,
    verdict,
    ...(withExemptions ? { residualScore: residualScore ?? score, residualVerdict: residualVerdict ?? verdict } : {}),
    findings: findings.length,
    topRules: topRulesOf(findings),
    codes,
    rulesVersion: rt.DEAI_RULES_VERSION,
    warnThreshold: warn,
    failThreshold: fail,
  };

  const ledgerRead = await readLedger(resolvedRoot);
  const existing = ledgerRead.entries;
  const duplicated = existing.some((candidate) => candidate.hash === extracted.hash);
  if (duplicated) {
    return {
      ok: true,
      code: "DEAI_OK",
      codes,
      file,
      kind: extracted.kind,
      hash: extracted.hash,
      score,
      verdict: reportedVerdict,
      residualScore,
      residualVerdict,
      findings: findings.length,
      topRules: topRulesOf(findings),
      chars: extracted.chars,
      artifactPath,
      appended: false,
    };
  }

  const ledgerLine = `${JSON.stringify(entry)}\n`;
  const ledgerWrite = writeAtomic(ledgerPathOf(resolvedRoot), `${readLedgerRaw(resolvedRoot)}${ledgerLine}`);
  if (!ledgerWrite.ok) {
    return {
      ok: false,
      code: "DEAI_STORE_FAILED",
      codes: [...codes, "DEAI_STORE_FAILED"],
      file,
      kind: extracted.kind,
      hash: extracted.hash,
      score,
      verdict: reportedVerdict,
      residualScore,
      residualVerdict,
      findings: findings.length,
      topRules: topRulesOf(findings),
      chars: extracted.chars,
      artifactPath,
      appended: false,
      parseError: ledgerWrite.reason,
    };
  }
  return {
    ok: true,
    code: "DEAI_OK",
    codes,
    file,
    kind: extracted.kind,
    hash: extracted.hash,
    score,
    verdict: reportedVerdict,
    residualScore,
    residualVerdict,
    findings: findings.length,
    topRules: topRulesOf(findings),
    chars: extracted.chars,
    artifactPath,
    appended: true,
  };
}

/** 原样读台账文本(不存在 → 空串);写路径要保留历史字节,不能靠解析后重建。 */
function readLedgerRaw(root: string): string {
  try {
    const text = readFileSync(ledgerPathOf(root), "utf8");
    return text === "" || text.endsWith("\n") ? text : `${text}\n`;
  } catch {
    return "";
  }
}

/** 汇总报表:按台账行数/分数/裁定/规则命中共计(不重算文档,台账即事实)。 */
export async function buildReport(root: string): Promise<DeaiReport> {
  const ledger = await readLedger(root);
  const verdicts = { pass: 0, warn: 0, fail: 0 };
  if (!ledger.ok) {
    return {
      ok: false,
      code: ledger.code ?? "DEAI_READ_FAILED",
      files: 0,
      scores: [],
      verdicts,
      topRules: [],
      parseErrors: ledger.parseErrors,
      rulesVersion: rt.DEAI_RULES_VERSION,
    };
  }
  const scores: number[] = [];
  const counts = new Map<string, number>();
  for (const entry of ledger.entries) {
    scores.push(entry.score);
    const verdict = entry.verdict === "pass" || entry.verdict === "warn" || entry.verdict === "fail" ? entry.verdict : "fail";
    verdicts[verdict] += 1;
    for (const hit of Array.isArray(entry.topRules) ? entry.topRules : []) {
      if (typeof hit?.ruleId !== "string") continue;
      counts.set(hit.ruleId, (counts.get(hit.ruleId) ?? 0) + (typeof hit.count === "number" ? hit.count : 0));
    }
  }
  const topRules: DeaiTopRule[] = [...counts.entries()]
    .map(([ruleId, count]) => ({ ruleId, count }))
    .sort((a, b) => (b.count === a.count ? a.ruleId.localeCompare(b.ruleId) : b.count - a.count))
    .slice(0, 5);
  return {
    ok: true,
    files: ledger.entries.length,
    scores,
    verdicts,
    topRules,
    parseErrors: ledger.parseErrors,
    rulesVersion: rt.DEAI_RULES_VERSION,
  };
}

/** 供 CLI 展示/校验用的类别表(与 runtime 的 kind 集合同口径)。 */
export const DEAI_STORE_KINDS: readonly DeaiKind[] = KINDS;
