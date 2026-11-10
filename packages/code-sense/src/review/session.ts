/**
 * review session 落盘/续跑/比较(step-116,参照 open-code-review internal/session):
 * 每次 review 落 `<root>/.genie/reviews/<id>.json`(findings+目标+时间+基线);
 * 两次会话按「发现身份键」做多集匹配,输出四态:
 *   新增(当前有、基线无、更早也没有)/ 已修复(基线有、当前无)/
 *   未变(两边都有)/ 复现(当前有、基线无,但更早会话出现过)。
 *
 * 身份键 = path | 规则位(title 规范化,行号剔除)| 内容指纹(以 anchorText 锚定
 * 当前文件 ±2 行上下文的 sha1 截断;锚定位不到时退化为锚文本自身指纹,前缀区分防碰撞):
 * 行号绝不进指纹(行号只作展示),行号漂移不敏感,
 * 措辞小改可容忍(措辞大改会表现为 resolved+new,与 OCR 同款限制,文档登记)。
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Finding, ReviewTarget } from "./index";
import type { ScanOptions, ScanStats } from "./scan";

export interface SessionCounts { total: number; blocker: number; warning: number; nit: number }

export interface SessionTargetMeta {
  kind: ReviewTarget["kind"];
  /** diff 模式的 target 原文(commit/branch)。 */
  target?: string;
  /** fixG1:任务变更集基线(checkpoint sha;uncommitted+基线=本任务变更集口径)。 */
  baseSha?: string;
  /** scan 模式的配置(paths/include/exclude/预算),供 --resume 继承。 */
  scan?: ScanOptions;
  files: { path: string; status: string }[];
  totalLines: number;
  truncated: boolean;
  scanStats?: ScanStats;
}

export interface ReviewSession {
  version: 1;
  id: string;
  createdAt: string;
  root: string;
  kind: ReviewTarget["kind"];
  target: SessionTargetMeta;
  counts: SessionCounts;
  findings: Finding[];
  summary: string;
  /** --resume/--compare 指定的基线会话。 */
  baseline?: string;
  /** --resume 的血缘(新会话由哪个会话续跑而来)。 */
  resumedFrom?: string;
}

export class ReviewSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSessionError";
  }
}

export function reviewSessionsDir(root: string): string {
  return join(root, ".genie", "reviews");
}

export function countFindings(findings: Finding[]): SessionCounts {
  return {
    total: findings.length,
    blocker: findings.filter((f) => f.severity === "blocker").length,
    warning: findings.filter((f) => f.severity === "warning").length,
    nit: findings.filter((f) => f.severity === "nit").length,
  };
}

function newSessionId(now: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export interface SaveSessionInput {
  kind: ReviewTarget["kind"];
  target: SessionTargetMeta;
  findings: Finding[];
  summary: string;
  baseline?: string;
  resumedFrom?: string;
  now?: Date;
}

/** 落盘(原子写;目录不存在自动建)。返回会话与文件路径。 */
export function saveReviewSession(root: string, input: SaveSessionInput): { session: ReviewSession; path: string } {
  const now = input.now ?? new Date();
  const id = newSessionId(now);
  const session: ReviewSession = {
    version: 1,
    id,
    createdAt: now.toISOString(),
    root,
    kind: input.kind,
    target: input.target,
    counts: countFindings(input.findings),
    findings: input.findings,
    summary: input.summary,
    ...(input.baseline ? { baseline: input.baseline } : {}),
    ...(input.resumedFrom ? { resumedFrom: input.resumedFrom } : {}),
  };
  const dir = reviewSessionsDir(root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  const tmp = join(dir, `.${id}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(session, null, 1));
  renameSync(tmp, path);
  return { session, path };
}

/** 读会话:缺文件/损坏/版本不符 → null(诚实不猜)。 */
export function loadReviewSession(root: string, id: string): ReviewSession | null {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;
  try {
    const raw = JSON.parse(readFileSync(join(reviewSessionsDir(root), `${id}.json`), "utf-8")) as ReviewSession;
    if (raw && raw.version === 1 && typeof raw.id === "string" && Array.isArray(raw.findings) && raw.target) return raw;
  } catch {
    /* 缺文件/损坏 */
  }
  return null;
}

/** 列会话(createdAt 升序;坏文件跳过)。 */
export function listReviewSessions(root: string): ReviewSession[] {
  let names: string[];
  try {
    names = readdirSync(reviewSessionsDir(root)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch {
    return [];
  }
  const out: ReviewSession[] = [];
  for (const n of names) {
    const s = loadReviewSession(root, n.slice(0, -".json".length));
    if (s) out.push(s);
  }
  return out.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeBody(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 400);
}

/** 规则位(title 规范化):折叠空白;剔除 title 里可能携带的行号语义
 * (file.ts:12 / 第12行 / 12行)——同一规则跨会话措辞含行号时仍归并为同键。 */
function normalizeRule(s: string): string {
  return s
    .replace(/\b[\w.-]+:(\d+)\b/g, "<file:line>")
    .replace(/第?\d+\s*行/g, "<line>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function sha1Hex(input: string): string {
  return createHash("sha1").update(input, "utf-8").digest("hex");
}

/** 锚文本:anchorText 优先;缺省从 detail 剥掉「新增行:」类前缀取内容行;再退 title。 */
function anchorOf(f: Finding): string {
  if (f.anchorText?.trim()) return f.anchorText.trim();
  const d = f.detail.replace(/^新增行[:：]\s*/, "").trim();
  if (d) return d;
  return f.title.trim();
}

/** 在文件行序列里定位锚文本(去空白逐行精确匹配;多处命中取第一处)。 */
function locateAnchor(lines: string[], anchor: string): number {
  const keys = anchor.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!keys.length) return -1;
  outer: for (let i = 0; i + keys.length <= lines.length; i++) {
    for (let j = 0; j < keys.length; j++) {
      if (lines[i + j]?.trim() !== keys[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** 内容指纹(行号绝不进指纹):
 *  - 锚文本能在当前文件里定位到 → 取锚 ±2 行上下文 sha1 截断 12 位(前缀 c:);
 *    行号漂移(如顶部插空行)不改变上下文内容 → 指纹稳定。
 *  - 定位不到/文件不可读(内容已删或文件已删)→ 锚文本自身 normalize 后指纹(前缀 t:,
 *    与 c: 前缀隔离防跨形态误配对)。 */
function contentFingerprint(f: Finding, readFile: (file: string) => string | null): string {
  const anchor = anchorOf(f);
  const content = readFile(normalizePath(f.file));
  if (content != null) {
    const lines = content.split(/\r?\n/);
    const at = locateAnchor(lines, anchor);
    if (at >= 0) {
      const keys = anchor.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const ctx = lines.slice(Math.max(0, at - 2), at + keys.length + 2);
      return `c:${sha1Hex(ctx.map((l) => l.trim()).join("\n")).slice(0, 12)}`;
    }
  }
  return `t:${sha1Hex(normalizeBody(anchor)).slice(0, 12)}`;
}

/** 发现身份键(跨轮/跨会话配对用;file + 规则位 + 内容指纹;行号/severity 刻意不参与)。
 * readFile 缺省=不可读:退化为锚文本指纹(t: 形态)。 */
export function findingIdentity(f: Finding, readFile?: (file: string) => string | null): string {
  const fp = contentFingerprint(f, readFile ?? (() => null));
  return `${normalizePath(f.file)}|${normalizeRule(f.title)}|${fp}`;
}

export interface SessionCompare {
  baseline: string;
  current: string;
  counts: { new: number; resolved: number; unchanged: number; reappeared: number };
  new: Finding[];
  resolved: Finding[];
  unchanged: Finding[];
  reappeared: Finding[];
}

function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort((a, b) =>
    a.file === b.file ? (a.line === b.line ? a.title.localeCompare(b.title) : a.line - b.line) : a.file.localeCompare(b.file),
  );
}

/**
 * 四态比较:基线 findings vs 当前 findings。
 * older=更早会话的 findings 列表(用于区分「复现」与真正新增)。
 * readFile=文件内容读取器(join(root,file) 语义;缺省不可读→退化锚文本指纹):
 * 基线与当前两侧的指纹都在「当前文件内容」上计算——行号漂移不改变 ±2 行上下文,
 * 内容真消失则当前侧不再产生该 finding(→已修复),不依赖基线时的行号。
 */
export function compareFindings(
  before: Finding[],
  after: Finding[],
  older: Finding[][] = [],
  readFile?: (file: string) => string | null,
): Omit<SessionCompare, "baseline" | "current"> {
  const id = (f: Finding): string => findingIdentity(f, readFile);
  // 复现判定用宽松键(file|内容指纹,不含规则位):同一问题跨会话措辞/规则名可变,
  // 内容再现即复现(D3 约定);严格键只用于 before↔after 配对(规则+内容都同才算未变)。
  const looseId = (f: Finding): string => {
    const fp = contentFingerprint(f, readFile ?? (() => null));
    return `${normalizePath(f.file)}|${fp}`;
  };
  const pool = new Map<string, Finding[]>();
  for (const f of after) {
    const k = id(f);
    const arr = pool.get(k);
    if (arr) arr.push(f);
    else pool.set(k, [f]);
  }
  // 同键一轮内重复:计数配对按剩余量消耗(不崩溃;多出部分进 新增/复现)。
  const olderKeys = new Set(older.flat().map((f) => looseId(f)));
  const unchanged: Finding[] = [];
  const resolved: Finding[] = [];
  for (const f of before) {
    const k = id(f);
    const arr = pool.get(k);
    if (arr?.length) unchanged.push(arr.shift()!);
    else resolved.push(f);
  }
  const fresh: Finding[] = [];
  const reappeared: Finding[] = [];
  for (const arr of pool.values()) {
    for (const f of arr) (olderKeys.has(looseId(f)) ? reappeared : fresh).push(f);
  }
  return {
    counts: { new: fresh.length, resolved: resolved.length, unchanged: unchanged.length, reappeared: reappeared.length },
    new: sortFindings(fresh),
    resolved: sortFindings(resolved),
    unchanged: sortFindings(unchanged),
    reappeared: sortFindings(reappeared),
  };
}

/** 以会话为单位比较:基线+更早 10 个会话 → 四态。 */
export function compareSessions(root: string, baselineId: string, current: ReviewSession): SessionCompare {
  const baseline = loadReviewSession(root, baselineId);
  if (!baseline) throw new ReviewSessionError(`基线会话不存在: ${baselineId}(用 --sessions 查看本仓会话)`);
  if (baseline.kind !== current.kind) {
    throw new ReviewSessionError(`会话类型不一致: 基线=${baseline.kind}, 当前=${current.kind}(scan 与 diff 的 findings 不可对比)`);
  }
  const all = listReviewSessions(root);
  const idx = all.findIndex((s) => s.id === baseline.id);
  const older = (idx >= 0 ? all.slice(0, idx) : []).slice(-10).map((s) => s.findings);
  // 指纹文件读取器:内容以「当前工作树」为准(缺文件/不可读=空,退化锚文本指纹)。
  const readFile = (file: string): string | null => {
    try {
      return readFileSync(join(root, file), "utf-8");
    } catch {
      return null;
    }
  };
  const cmp = compareFindings(baseline.findings, current.findings, older, readFile);
  return { baseline: baseline.id, current: current.id, ...cmp };
}

export function compareSummaryText(c: SessionCompare): string {
  return `基线 ${c.baseline}: 新增 ${c.counts.new} / 已修复 ${c.counts.resolved} / 未变 ${c.counts.unchanged} / 复现 ${c.counts.reappeared}`;
}
