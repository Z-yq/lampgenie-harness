/**
 * 会话检索缓存的 fail-open 支撑(fail-open:派生索引不得成为单点故障)。
 * 为什么派生索引必须 fail-open:
 * - 检索缓存(倒排/会话元数据)是**派生数据**,journal 才是唯一事实源。缓存损坏、版本漂移、
 * 磁盘半写、rename 失败都不代表「会话内容不存在」,只代表「这份加速副本过期/残缺」。
 * 若把缓存校验失败直接抛成检索不可用,等于让加速副本反向决定事实源的可读性——可用性倒挂。
 * - 因此这里做三层兜底:①主缓存 + 影子缓存双读(主坏读影,任一份可用即不重建);
 * ②两份都坏才全量重建;③连构建/读盘都抛异常时,上层退化为 journal 线性扫描(scanJournalFallback)。
 * 任何一层都不向外抛错,只记录 breadcrumb(降级溯源)与 reason。
 * - 写盘同理双写 + 原子 rename:一份写失败不影响另一份,两份都失败才报告失败(此时保留旧 breadcrumb,
 * 避免把「其实没写成功」误记成一次成功重建)。breadcrumb 是纯观测数据,写不出来也不影响检索。
 * 本文件是纯函数集合(无状态、不可变入参),不 import search.ts,避免循环依赖。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JournalEvent } from "@lampgenie/core";

/** 缓存读取来源:主缓存 / 影子缓存 / 全量重建 / 线性扫描兜底。 */
export type SearchCacheSource = "primary" | "shadow" | "rebuild" | "fallback";

/** 缓存校验失败原因(与读取来源共同组成 reasons 元素 `"<primary|shadow>:<json|shape|stale>"`)。 */
export type SearchCacheFailReason = "json" | "shape" | "stale";

/** 降级溯源面包屑:回答「这次检索的索引到底从哪来的」。 */
export interface SearchCacheBreadcrumb {
  v: 1;
  at: number;
  source: SearchCacheSource;
  reason?: string;
  docs?: number;
  sessions?: number;
  lastSeq?: number;
}

/** 主/影双读结果。都失败时 source=null 且 payload 缺省,reasons 记录每份的失败原因。 */
export interface ShadowReadResult<T> {
  payload?: T;
  source: "primary" | "shadow" | null;
  reasons: string[];
}

/** 写盘结果:至少一份成功才 ok=true;written 标明实际写成的副本。 */
export interface ShadowWriteResult {
  ok: boolean;
  written: Array<"primary" | "shadow">;
  breadcrumb?: SearchCacheBreadcrumb;
}

/** validate 契约:true=可用;false=形状不符;{ok:false,reason}=自带更精确原因。 */
export type ShadowValidate<T> = (payload: T) => boolean | { ok: boolean; reason?: string };

export interface ShadowWriteMeta {
  source?: SearchCacheSource;
  docs?: number;
  sessions?: number;
  lastSeq?: number;
  reason?: string;
  now?: () => number;
}

/** 线性扫描命中(文档粒度,与缓存 docs 一一对应)。 */
export interface JournalScanHit {
  sessionId: string;
  seq: number;
  kind: string;
  text: string;
  snippet: string;
}

export interface JournalScanResult {
  hits: JournalScanHit[];
  scanned: number;
  tookMs: number;
}

const SNIPPET_RADIUS = 40;
const DEFAULT_MAX_DOCS = 2000;

function normalizeReason(raw: unknown): SearchCacheFailReason {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return text === "json" || text === "shape" || text === "stale" ? text : "shape";
}

/** 单份读取:JSON 解析失败 → json;validate 否决 → shape/stale;validate 抛错 → 取其 message 归类。 */
function readOne<T>(path: string, validate: ShadowValidate<T>): { payload?: T; reason?: SearchCacheFailReason } {
  let payload: T;
  try {
    payload = JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return { reason: "json" };
  }
  try {
    const verdict = validate(payload);
    if (verdict === true) return { payload };
    if (verdict === false) return { reason: "shape" };
    if (verdict && typeof verdict === "object" && verdict.ok === true) return { payload };
    return { reason: normalizeReason(verdict && typeof verdict === "object" ? verdict.reason : undefined) };
  } catch (error) {
 // validate 自己抛错也只当作「这份不可用」,绝不向上冒泡。
    return { reason: normalizeReason(error instanceof Error ? error.message : undefined) };
  }
}

/**
 * 主 → 影双读。主成功即返回,不再碰影子(避免无谓 IO 与「影子更旧」的误判)。
 * 都失败返回 {source:null, reasons},由调用方决定重建。
 */
export function readShadowPair<T>(primaryPath: string, shadowPath: string, validate: ShadowValidate<T>): ShadowReadResult<T> {
  const reasons: string[] = [];
  const primary = readOne<T>(primaryPath, validate);
  if (primary.payload !== undefined) return { payload: primary.payload, source: "primary", reasons };
  reasons.push(`primary:${primary.reason ?? "shape"}`);
  const shadow = readOne<T>(shadowPath, validate);
  if (shadow.payload !== undefined) return { payload: shadow.payload, source: "shadow", reasons };
  reasons.push(`shadow:${shadow.reason ?? "shape"}`);
  return { source: null, reasons };
}

/** 原子写单文件:tmp + rename;rename 失败(跨卷/目标被占)回退直写,与既有 flush 语义一致。 */
function writeAtomic(path: string, body: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, body, "utf-8");
    try {
      renameSync(tmp, path);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
 /* tmp 清理失败不致命:主路径直写仍可能成功 */
      }
      writeFileSync(path, body, "utf-8");
    }
    return true;
  } catch {
    return false;
  }
}

function payloadArrayLength(payload: unknown, key: string): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.length : undefined;
}

function payloadNumber(payload: unknown, key: string): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 主 + 影双写,两份互不影响(best-effort)。至少一份成功才写 breadcrumb:
 * 两份都失败时保留旧 breadcrumb,避免把「没写成」记成一次成功落盘。
 */
export function writeShadowPair(
  primaryPath: string,
  shadowPath: string,
  breadcrumbPath: string | null | undefined,
  payload: unknown,
  meta: ShadowWriteMeta = {},
): ShadowWriteResult {
  const body = JSON.stringify(payload);
  const written: Array<"primary" | "shadow"> = [];
  if (writeAtomic(primaryPath, body)) written.push("primary");
  if (writeAtomic(shadowPath, body)) written.push("shadow");
  if (written.length === 0) return { ok: false, written: [] };
  if (!breadcrumbPath) return { ok: true, written };
  const crumb: SearchCacheBreadcrumb = {
    v: 1,
    at: meta.now?.() ?? Date.now(),
    source: meta.source ?? "rebuild",
    ...(meta.reason ? { reason: meta.reason } : {}),
  };
  const docs = meta.docs ?? payloadArrayLength(payload, "docs");
  const sessions = meta.sessions ?? payloadArrayLength(payload, "sessions");
  const lastSeq = meta.lastSeq ?? payloadNumber(payload, "lastSeq");
  if (docs !== undefined) crumb.docs = docs;
  if (sessions !== undefined) crumb.sessions = sessions;
  if (lastSeq !== undefined) crumb.lastSeq = lastSeq;
  if (writeAtomic(breadcrumbPath, JSON.stringify(crumb))) return { ok: true, written, breadcrumb: crumb };
  return { ok: true, written };
}

/** 独立写 breadcrumb(best-effort):构建期/降级期留痕用,不额外复制影子。 */
export function writeBreadcrumbFile(
  path: string | null | undefined,
  breadcrumb: SearchCacheBreadcrumb): boolean {
  if (!path) return false;
  return writeAtomic(path, JSON.stringify(breadcrumb));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function joinText(parts: unknown[]): string {
  return parts
    .map((part) => asText(part))
    .filter((part) => part.length > 0)
    .join(" ");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * 精简版事件文本抽取(与 search.ts 的完整抽取对齐到「够线性扫描用」,但不 import 它)。
 * payload.text / payload.content(tool.* 拼 name)/ payload.instruction+result / 其它 JSON 串兜底。
 */
export function shadowEventText(event: JournalEvent): string {
  const kind = String(event.kind ?? "");
  const payload = asRecord(event.payload);
  if (kind.startsWith("tool.")) {
    return joinText([payload.name, kind === "tool.result" ? payload.content : payload.arguments]);
  }
  const direct = asText(payload.text) || asText(payload.content);
  if (direct) return direct;
  const instruction = joinText([payload.instruction, payload.result]);
  if (instruction) return instruction;
  return safeJson(event.payload);
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 命中片段:前后各 40 字,保留原文命中词,空白归一,越界安全。 */
function makeSnippet(text: string, query: string): string {
  const flat = flatten(text);
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, SNIPPET_RADIUS * 2 + query.length);
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(flat.length, at + query.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** 匹配:英文大小写不敏感(includes),中文按原子串(小写化不改变汉字)。 */
function matches(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle);
}

/**
 * 线性扫描兜底(LIKE 兜底等价物):索引不可用时的最后一道防线。
 * 纯函数 + 全量只读,空 query / 空事件返回安全空态(不抛、不耗时)。
 */
export function scanJournalFallback(
  events: readonly JournalEvent[],
  query: string,
  opts: { maxDocs?: number; now?: () => number } = {},
): JournalScanResult {
  const now = opts.now ?? (() => Date.now());
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle || events.length === 0) return { hits: [], scanned: 0, tookMs: 0 };
  const maxDocs = Math.max(1, Math.trunc(opts.maxDocs ?? DEFAULT_MAX_DOCS));
  const started = now();
  const hits: JournalScanHit[] = [];
  let scanned = 0;
  for (const event of events) {
    if (hits.length >= maxDocs) break;
    scanned += 1;
    const sessionId = String(event.sessionId ?? "");
    if (!sessionId) continue;
    const text = shadowEventText(event);
    if (!text || !matches(text, needle)) continue;
    hits.push({
      sessionId,
      seq: event.seq,
      kind: String(event.kind ?? ""),
      text,
      snippet: makeSnippet(text, needle),
    });
  }
  return { hits, scanned, tookMs: Math.max(0, now() - started) };
}
