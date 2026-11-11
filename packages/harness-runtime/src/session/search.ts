/**
 * 会话全文检索(hermes-agent session FTS × deepseek-harness session-query)。
 * 纯 TS 增量倒排索引:journal 是唯一事实源,本模块不写 journal、不引原生 SQLite/embedding。
 *  - 文档 = 一个有文本的 journal 事件(message/tool/task/todo/plan/board/review/subagent)。
 * - 中文按 unigram+bigram、英文/数字按词与复合词( / a1_adapter)切分。
 *  - `readAll()` 冷构建 + `subscribe()` 增量;可选磁盘缓存(身份校验失败即重建)。
 *  - 三形态:discover(跨会话找会话)/ scroll(会话内命中上下文)/ read(会话原文分页)。
 *  - 排序 = 词频 + kind 权重 + 时间衰减 + 来源权重;自动化(auto-*)只降权不排除。
 * 设计稿与验收记录:。
 */
import { readFileSync } from "node:fs";
import type { Journal, JournalEvent } from "@lampgenie/core";
import {
  readShadowPair,
  scanJournalFallback,
  shadowEventText,
  writeBreadcrumbFile,
  writeShadowPair,
  type JournalScanHit,
  type SearchCacheSource,
} from "./search-shadow.js";

export type SessionSource = "user" | "automation" | "subagent" | "companion" | "system";

export interface SessionSearchOptions {
  /** 可选磁盘缓存(建议随 journalDir 隔离,如 .genie/journals/session-search-index.json)。 */
  cacheFile?: string;
 /** 影子缓存(主缓存损坏时的第二份副本;缺省 `${cacheFile}.shadow`)。 */
  shadowFile?: string;
 /** 降级溯源面包屑(缺省 `${cacheFile}.breadcrumb.json`)。 */
  breadcrumbFile?: string;
  /** 时钟注入(测试用)。 */
  now?: () => number;
  /** 单事件入索引文本上限(默认 4000 字)。 */
  maxTextPerEvent?: number;
  /** 缓存写盘 debounce(默认 8s;另有 30s 最小间隔)。 */
  cacheDebounceMs?: number;
}

export interface SessionSearchStats {
  built: boolean;
  buildMs: number;
  builtAt: number;
  docs: number;
  sessions: number;
  tokens: number;
  lastSeq: number;
  cache: {
    file: string | null;
    loaded: boolean;
    hit: boolean;
 /** 本次索引来源:主缓存/影子/重建/线性扫描兜底。 */
    source: SearchCacheSource | null;
 /** 磁盘上的 breadcrumb 原文(没有则 null);解析留给调用方,避免 stats 抛错。 */
    breadcrumb: string | null;
  };
 /** 索引是否已降级(构建/读盘异常 → 三形态走 journal 线性扫描)。 */
  degraded: boolean;
  fallbackReason?: string | null;
}

interface IndexedDoc {
  id: number;
  sessionId: string;
  seq: number;
  kind: string;
  role: string;
  ts: number;
  text: string;
  tool: string | null;
  weight: number;
  subagent: boolean;
}

interface SessionMeta {
  sessionId: string;
  title: string;
  startedAt: number;
  lastAt: number;
  events: number;
  messages: number;
  userMessages: number;
  subagentDocs: number;
  automationSeen: boolean;
  companionSeen: boolean;
  lastText: string;
}

interface SessionSummary {
  sessionId: string;
  title: string;
  when: string;
  lastAt: number;
  source: SessionSource;
  demoted: boolean;
  events: number;
  messages: number;
  indexed: number;
}

export interface DiscoverHit extends SessionSummary {
  score: number;
  hits: number;
  best: { seq: number; kind: string; role: string; snippet: string; ts: number } | null;
}

export interface DiscoverResult {
  mode: "discover" | "browse";
  query: string;
  count: number;
  tookMs: number;
  stats: SessionSearchStats;
  results: DiscoverHit[];
  message?: string;
}

export interface ScrollEvent {
  seq: number;
  kind: string;
  role: string;
  time: number;
  text: string;
  tool?: string;
  truncated?: boolean;
  anchor?: boolean;
}

export interface ScrollResult {
  mode: "scroll";
  sessionId: string;
  session: SessionSummary | null;
  query?: string;
  anchorSeq?: number;
  cursor?: string;
  nextCursor?: string;
  totalMatches?: number;
  events: ScrollEvent[];
  message?: string;
}

export interface ReadResult {
  mode: "read";
  sessionId: string;
  session: SessionSummary | null;
  events: ScrollEvent[];
  fromSeq: number;
  nextSeq: number | null;
  done: boolean;
  total: number;
  message?: string;
}

interface CachePayload {
  v: 1;
  lastSeq: number;
  firstTime: number;
  lastTime: number;
  docs: Array<[string, number, string, string, number, string, string | null, number, number]>;
  sessions: Array<[string, string, number, number, number, number, number, number, number, number, string]>;
  postings: Array<[string, Array<[number, number]>]>;
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CJK_RUN_RE = /[\u3400-\u9fff\uf900-\ufaff]+/g;
const LATIN_COMPOUND_RE = /[a-z0-9]+(?:[-_.][a-z0-9]+)*/g;
const LATIN_PART_RE = /[a-z0-9]+/g;
const CACHE_VERSION = 1;

const KIND_WEIGHT: Record<string, number> = {
  "message.user": 1.25,
  "message.agent": 1,
  "message.system": 0.55,
  "tool.call": 0.55,
  "tool.result": 0.5,
  "task.enqueue": 0.7,
  "task.start": 0.65,
  "task.progress": 0.6,
  "task.done": 0.75,
  "task.fail": 0.75,
  "todo.updated": 0.45,
  "plan.saved": 0.55,
  "board.update": 0.5,
  "review.findings": 0.6,
  "goal.set": 0.5,
  "subagent.spawn": 0.4,
  "subagent.result": 0.35,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function joinText(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part === "number" || typeof part === "boolean") return String(part);
      if (part && typeof part === "object") {
        try {
          return JSON.stringify(part);
        } catch {
          return "";
        }
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeText(text: string): string {
  return text.replace(ANSI_RE, "").normalize("NFKC").toLowerCase();
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** 索引侧分词:中文 unigram+bigram,英文/数字按词 + 复合词。返回 token 频次。 */
export function tokenizeForIndex(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const add = (token: string): void => {
    if (!token) return;
    out.set(token, (out.get(token) ?? 0) + 1);
  };
  const normalized = normalizeText(text);
  for (const match of normalized.matchAll(CJK_RUN_RE)) {
    const run = match[0];
    for (const char of run) add(char);
    for (let i = 0; i + 1 < run.length; i++) add(run.slice(i, i + 2));
  }
  for (const match of normalized.matchAll(LATIN_COMPOUND_RE)) {
    const compound = match[0];
    add(compound);
    if (/[-_.]/.test(compound)) {
      for (const part of compound.match(LATIN_PART_RE) ?? []) add(part);
    }
  }
  return out;
}

interface QueryTerm {
  token: string;
  weight: number;
}

interface QueryPlan {
  terms: QueryTerm[];
  groups: string[][];
  phrase: string;
  needles: string[];
}

/** 查询侧分词:多字中文只取 bigram(避免单字 posting 洪泛),单字才取 unigram。 */
export function planQuery(query: string): QueryPlan {
  const normalized = normalizeText(query).replace(/\s+/g, " ").trim();
  const terms = new Map<string, number>();
  const groups: string[][] = [];
  const add = (token: string, weight: number): void => {
    if (!token) return;
    const prev = terms.get(token);
    if (prev === undefined || weight > prev) terms.set(token, weight);
  };
  for (const match of normalized.matchAll(CJK_RUN_RE)) {
    const run = match[0];
    if (run.length === 1) {
      add(run, 0.4);
      groups.push([run]);
      continue;
    }
    const bigrams: string[] = [];
    for (let i = 0; i + 1 < run.length; i++) {
      const bigram = run.slice(i, i + 2);
      bigrams.push(bigram);
      add(bigram, 1);
    }
    groups.push(bigrams);
  }
  for (const match of normalized.matchAll(LATIN_COMPOUND_RE)) {
    const compound = match[0];
    add(compound, 1.2);
    if (/[-_.]/.test(compound)) {
      for (const part of compound.match(LATIN_PART_RE) ?? []) add(part, 0.75);
    }
    groups.push([compound]);
  }
  const needles = [...terms.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 8);
  return {
    terms: [...terms.entries()].map(([token, weight]) => ({ token, weight })),
    groups: groups.filter((group) => group.length > 0),
    phrase: normalized,
    needles,
  };
}

/** 从 journal 事件抽取可检索文本;纯结构事件返回 null。 */
export function extractSearchDocument(event: {
  kind: string;
  payload?: unknown;
}): { text: string; role: string; tool: string | null; weight: number; subagent: boolean } | null {
  const kind = event.kind;
  const payload = asRecord(event.payload);
  if (kind === "subagent.event") {
    const inner = textOf(payload.kind);
    if (!inner) return null;
    const innerWeight = KIND_WEIGHT[inner] ?? 0;
    if (!innerWeight) return null;
    const text =
      inner === "message.user" || inner === "message.agent"
        ? textOf(payload.text)
        : inner === "tool.call"
          ? joinText([payload.name, payload.arguments])
          : joinText([payload.name, payload.content]);
    if (!text.trim()) return null;
    return {
      text,
      role: inner === "message.user" ? "user" : inner === "message.agent" ? "agent" : "tool",
      tool: inner.startsWith("tool.") ? textOf(payload.name) || null : null,
      weight: innerWeight * 0.3,
      subagent: true,
    };
  }
  const weight = KIND_WEIGHT[kind] ?? 0;
  if (!weight) return null;
  switch (kind) {
    case "message.user":
      return { text: textOf(payload.text), role: "user", tool: null, weight, subagent: false };
    case "message.agent": {
      const calls = Array.isArray(payload.toolCalls) ? payload.toolCalls : [];
      const callText = calls
        .map((call) => {
          const c = asRecord(call);
          return joinText([c.name, c.arguments]);
        })
        .join("\n");
      return { text: joinText([payload.text, clip(callText, 2000)]), role: "agent", tool: null, weight, subagent: false };
    }
    case "message.system":
      return { text: textOf(payload.text), role: "system", tool: null, weight, subagent: false };
    case "tool.call":
    case "tool.result":
      return {
        text: joinText([payload.name, kind === "tool.result" ? payload.content : payload.arguments]),
        role: "tool",
        tool: textOf(payload.name) || null,
        weight,
        subagent: false,
      };
    case "task.enqueue":
    case "task.start":
    case "task.progress":
    case "task.done":
    case "task.fail":
      return {
        text: joinText([payload.instruction, payload.title, payload.result, payload.state]),
        role: "task",
        tool: null,
        weight,
        subagent: false,
      };
    case "todo.updated": {
      const items = Array.isArray(payload.items) ? payload.items : [];
      return {
        text: items.map((item) => joinText([asRecord(item).content, asRecord(item).status])).join("\n"),
        role: "task",
        tool: null,
        weight,
        subagent: false,
      };
    }
    case "plan.saved":
      return { text: joinText([payload.path, payload.taskId]), role: "plan", tool: null, weight, subagent: false };
    case "board.update":
      return { text: joinText([payload.title, payload.path, payload.docKind]), role: "board", tool: null, weight, subagent: false };
    case "review.findings": {
      const findings = Array.isArray(payload.findings) ? payload.findings : [];
      return {
        text: joinText([
          payload.summary,
          ...findings.map((item) => {
            const f = asRecord(item);
            return joinText([f.file, f.title, f.detail, f.severity]);
          }),
        ]),
        role: "review",
        tool: null,
        weight,
        subagent: false,
      };
    }
    case "subagent.spawn":
      return { text: textOf(payload.instructions), role: "subagent", tool: null, weight, subagent: false };
    case "subagent.result":
      return {
        text: joinText([payload.event, payload.note, payload.summary, payload.output]),
        role: "subagent",
        tool: null,
        weight,
        subagent: false,
      };
    case "goal.set":
      return { text: textOf(payload.goal), role: "system", tool: null, weight, subagent: false };
    default:
      return null;
  }
}

function titleFromText(text: string): string {
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return "";
  return first.replace(/^#+\s*/, "").slice(0, 80);
}

function sourceOf(meta: SessionMeta): SessionSource {
  if (meta.automationSeen || meta.sessionId.startsWith("auto-")) return "automation";
  if (meta.companionSeen || meta.sessionId.startsWith("companion:")) return "companion";
  if (meta.userMessages === 0 && meta.subagentDocs > 0) return "subagent";
  if (meta.userMessages === 0 && meta.events > 0 && meta.title === "") return "system";
  return "user";
}

function demotedOf(source: SessionSource): boolean {
  return source === "automation" || source === "subagent";
}

function sourceFactor(source: SessionSource): number {
  return source === "automation" ? 0.35 : source === "subagent" ? 0.5 : source === "companion" ? 0.6 : 1;
}

function parseTimeBound(value: string | number | undefined, now: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value).trim();
  const relative = /^(\d+)\s*(h|d|w)$/i.exec(text);
  if (relative) {
    const n = Number(relative[1]);
    const unit = (relative[2] ?? "d").toLowerCase();
    const seconds = unit === "h" ? 3600 : unit === "d" ? 86400 : 604800;
    return now - n * seconds * 1000;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function uniqueStrings(values: string[] | undefined, cap = 50): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    const v = String(value ?? "").trim();
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

/** 命中片段:最多标 4 处 `«»`,首处周围 ±80/120 字。 */
function makeSnippet(text: string, plan: QueryPlan, maxChars = 260): string {
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const needle of plan.needles) {
    if (!needle) continue;
    let from = 0;
    while (ranges.length < 4) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      const start = at;
      const end = at + needle.length;
      const overlap = ranges.some(([s, e]) => start < e && end > s);
      if (!overlap) ranges.push([start, end]);
      from = end > at ? end : at + 1;
    }
    if (ranges.length >= 4) break;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (!ranges.length) return clip(text.replace(/\s+/g, " ").trim(), maxChars);
  const first = ranges[0]!;
  const last = ranges[ranges.length - 1]!;
  const start = Math.max(0, first[0] - 80);
  const end = Math.min(text.length, last[1] + 120);
  let out = "";
  let cursor = start;
  for (const [s, e] of ranges) {
    if (s < start || e > end) continue;
    out += text.slice(cursor, s) + "«" + text.slice(s, e) + "»";
    cursor = e;
  }
  out += text.slice(cursor, end);
  out = out.replace(/\s+/g, " ").trim();
  if (start > 0) out = "…" + out;
  if (end < text.length) out += "…";
  return clip(out, maxChars);
}

function shapeEvent(doc: IndexedDoc, plan: QueryPlan | null, maxChars: number): ScrollEvent {
  const truncated = doc.text.length > maxChars;
  return {
    seq: doc.seq,
    kind: doc.kind,
    role: doc.role,
    time: doc.ts,
    text: plan ? makeSnippet(doc.text, plan, maxChars) : clip(doc.text.replace(/\s+/g, " ").trim(), maxChars),
    ...(doc.tool ? { tool: doc.tool } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function compareSeq(a: { seq: number }, b: { seq: number }): number {
  return a.seq - b.seq;
}

function flattenText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 降级路径的 role 推导(索引不可用时没有 role 字段,只能由 kind 反推)。 */
function roleOfKind(kind: string): string {
  if (kind === "message.user") return "user";
  if (kind === "message.system") return "system";
  if (kind === "message.agent") return "assistant";
  if (kind.startsWith("tool.")) return "tool";
  if (kind.startsWith("task.") || kind === "todo.updated") return "task";
  if (kind === "plan.saved") return "plan";
  if (kind === "board.update") return "board";
  if (kind.startsWith("review.")) return "review";
  if (kind.startsWith("subagent.")) return "subagent";
  return "assistant";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 降级提示统一文案:让调用方一眼看出「结果是线性扫描来的」,而不是以为索引坏了就没数据。 */
function degradedMessage(reason: string | null): string {
  return `索引降级:使用 journal 线性扫描 (${reason ?? "unknown"})`;
}

/** 降级路径的会话摘要(由事件线性推导,字段与正常索引的 SessionSummary 对齐)。 */
function fallbackSummary(sessionId: string, events: readonly JournalEvent[]): SessionSummary | null {
  const last = events[events.length - 1];
  if (!last) return null;
  return {
    sessionId,
    title: clip(flattenText(shadowEventText(last)), 60) || sessionId,
    when: new Date(last.time).toISOString(),
    lastAt: last.time,
    source: "user",
    demoted: false,
    events: events.length,
    messages: events.length,
    indexed: events.length,
  };
}

/** 降级路径的 ScrollEvent:snippet 非空即命中(anchor=true)。 */
function fallbackScrollEvent(event: JournalEvent, snippet: string | null): ScrollEvent {
  const kind = String(event.kind ?? "");
  return {
    seq: event.seq,
    kind,
    role: roleOfKind(kind),
    time: event.time,
    text: snippet ?? clip(flattenText(shadowEventText(event)), 1500),
    ...(snippet ? { anchor: true } : {}),
  };
}

export interface DiscoverOptions {
  limit?: number;
  after?: string | number;
  before?: string | number;
  source?: string | string[];
  excludeSessionIds?: string[];
}

export interface ScrollOptions {
  query?: string;
  cursor?: string | number;
  seq?: number;
  limit?: number;
  before?: number;
  after?: number;
}

export interface ReadOptions {
  fromSeq?: number;
  limit?: number;
}

/**
 * 会话全文索引。构造不建索引(首次查询懒构建),journal 增量由 subscribe 接管。
 */
export class SessionSearchIndex {
  private readonly journal: Journal;
  private readonly cacheFile: string | null;
  private readonly shadowFile: string | null;
  private readonly breadcrumbFile: string | null;
  private readonly now: () => number;
  private readonly maxTextPerEvent: number;
  private readonly cacheDebounceMs: number;
  private docs: IndexedDoc[] = [];
  private postings = new Map<string, Map<number, number>>();
  private sessions = new Map<string, SessionMeta>();
  private sessionDocs = new Map<string, number[]>();
  private lastSeq = -1;
  private built = false;
  private buildMs = 0;
  private builtAt = 0;
  private cacheLoaded = false;
  private cacheHit = false;
 /** 索引来源(降级可观测性):主缓存/影子/重建/线性扫描兜底。 */
  private cacheSource: SearchCacheSource | null = null;
 /** 磁盘 breadcrumb 原文(便于 stats 直接回显,不做二次解析)。 */
  private breadcrumbText: string | null = null;
 /** 构建期是否已降级(降级后三形态改走 journal 线性扫描,绝不抛)。 */
  private degraded = false;
  private fallbackReason: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCacheWrite = 0;
  private dirty = false;

  constructor(journal: Journal, options: SessionSearchOptions = {}) {
    this.journal = journal;
    this.cacheFile = options.cacheFile ?? null;
    this.shadowFile = options.shadowFile ?? (this.cacheFile ? `${this.cacheFile}.shadow` : null);
    this.breadcrumbFile = options.breadcrumbFile ?? (this.cacheFile ? `${this.cacheFile}.breadcrumb.json` : null);
    this.now = options.now ?? (() => Date.now());
    this.maxTextPerEvent = options.maxTextPerEvent ?? 4000;
    this.cacheDebounceMs = options.cacheDebounceMs ?? 8000;
  }

  /** 懒构建 + 订阅增量。重复调用无副作用。 */
  ensureBuilt(): void {
    if (this.built) return;
    const started = this.now();
    try {
      this.buildIndex();
    } catch (error) {
 // fail-open:缓存/索引是派生数据,journal 才是唯一事实源 —— 构建期异常不许把检索整体打死。
 // 只标记降级,三形态改走 journal 线性扫描;不 reset(避免留下半截脏索引被误当作有效)。
      this.degraded = true;
      this.cacheSource = "fallback";
      this.fallbackReason = error instanceof Error ? error.message : String(error);
      this.unsubscribe = null;
      this.writeBreadcrumb({ source: "fallback", reason: this.fallbackReason });
    }
    this.buildMs = Math.max(0, this.now() - started);
    this.builtAt = this.now();
    this.built = true;
  }

 /**
 * :按 sessionId 取该会话的**原始事件**(供 capsule 摘要使用),只读,不影响倒排索引。
 * 上限 5000 条:超长会话保留「头 1000 + 尾 4000」——头段给 objective(首条 user 文本),
 * 尾段给 nextStep(最后一条 agent 文本),中间中段被丢弃不影响五段语义。
 * 读 journal 失败一律返回空数组(胶囊空态可渲染,不 throw)。
 */
  sessionEvents(sessionId: string, options: { limit?: number } = {}): JournalEvent[] {
    const sid = String(sessionId ?? "").trim();
    if (!sid) return [];
    const limit = Math.max(1, Math.min(5000, Math.trunc(options.limit ?? 5000)));
    try {
      const events = this.journal.readSession(sid, 0);
      if (!Array.isArray(events) || events.length === 0) return [];
      if (events.length <= limit) return events;
      const head = Math.min(1000, limit);
      const tail = limit - head;
      return [...events.slice(0, head), ...events.slice(events.length - tail)];
    } catch {
      return [];
    }
  }

 /** 构建主体:双读主/影缓存 → 增量补齐 → 订阅;失败由 ensureBuilt 兜住。 */
  private buildIndex(): void {
    const events = this.journal.readAll();
    this.reset();
    let source: "primary" | "shadow" | null = null;
    let reasons: string[] = [];
    if (this.cacheFile && this.shadowFile && events.length > 0) {
      const read = readShadowPair<CachePayload>(this.cacheFile, this.shadowFile, (payload) =>
        this.validatePayload(payload, events),
      );
      reasons = read.reasons;
      if (read.payload !== undefined && read.source) {
        try {
          this.applyPayload(read.payload);
          source = read.source;
        } catch {
 // 校验过了但填充仍炸(毒行/字段类型诡异):当缓存不可用,走全量重建。
          this.reset();
          source = null;
        }
      }
    }
    if (source) {
      this.cacheLoaded = true;
      this.cacheHit = true;
      this.cacheSource = source;
      if (source === "shadow") {
 // 主缓存已坏:用影子顶上,并留痕「是谁救的场」。
        this.writeBreadcrumb({ source: "shadow", reason: reasons.join(","), lastSeq: this.lastSeq });
      }
 // 缓存落后:只补 lastSeq 之后的事件(增量,不重建)。
      if (this.lastSeq < this.journal.length - 1) {
        for (const event of this.journal.readAll(this.lastSeq + 1)) this.indexEvent(event);
        if (this.cacheFile) this.dirty = true;
      }
    } else {
      for (const event of events) this.indexEvent(event);
      this.cacheSource = "rebuild";
      if (this.cacheFile) {
        this.dirty = true; // 首次构建/缓存失效:flush 应能落盘
        if (events.length > 0) this.writeBreadcrumb({ source: "rebuild", reason: reasons.join(","), lastSeq: this.lastSeq });
      }
    }
    // 空 journal 也要把 lastSeq 归位(否则首条 append 的 seq=0 会被跳过)。
    if (events.length === 0) this.lastSeq = -1;
    this.readBreadcrumb();
    this.unsubscribe = this.journal.subscribe((event) => {
      this.indexEvent(event);
      this.markDirty();
    });
  }

 /** 缓存校验(只管形状/新鲜度;JSON 解析失败由 readShadowPair 判为 json)。 */
  private validatePayload(payload: CachePayload, events: JournalEvent[]): true | { ok: false; reason: "shape" | "stale" } {
    if (!payload || payload.v !== CACHE_VERSION) return { ok: false, reason: "shape" };
    if (!Array.isArray(payload.docs) || !Array.isArray(payload.postings) || !Array.isArray(payload.sessions)) {
      return { ok: false, reason: "shape" };
    }
    if (typeof payload.lastSeq !== "number" || !Number.isFinite(payload.lastSeq)) return { ok: false, reason: "shape" };
    const first = events[0];
    const last = events[events.length - 1];
    if (!first || !last) return { ok: false, reason: "stale" };
    if (payload.lastSeq > last.seq || payload.lastSeq < -1) return { ok: false, reason: "stale" };
    if (payload.firstTime !== first.time) return { ok: false, reason: "stale" };
    const lastAtCacheSeq = events[payload.lastSeq];
    if (!lastAtCacheSeq || lastAtCacheSeq.time !== payload.lastTime) return { ok: false, reason: "stale" };
    return true;
  }

 /** 把校验通过的 payload 填进内存态(与 loadCache 的填充部分逐字段等价)。 */
  private applyPayload(payload: CachePayload): void {
    this.reset();
    this.docs = payload.docs.map((row, index) => ({
      id: index,
      sessionId: String(row[0] ?? ""),
      seq: Number(row[1] ?? 0),
      kind: String(row[2] ?? ""),
      role: String(row[3] ?? ""),
      ts: Number(row[4] ?? 0),
      text: String(row[5] ?? ""),
      tool: row[6] === null ? null : String(row[6] ?? ""),
      weight: Number(row[7] ?? 0),
      subagent: Boolean(row[8]),
    }));
    this.sessions = new Map(
      payload.sessions.map((row) => [
        String(row[0] ?? ""),
        {
          sessionId: String(row[0] ?? ""),
          title: String(row[1] ?? ""),
          startedAt: Number(row[2] ?? 0),
          lastAt: Number(row[3] ?? 0),
          events: Number(row[4] ?? 0),
          messages: Number(row[5] ?? 0),
          userMessages: Number(row[6] ?? 0),
          subagentDocs: Number(row[7] ?? 0),
          automationSeen: Boolean(row[8]),
          companionSeen: Boolean(row[9]),
          lastText: String(row[10] ?? ""),
        } satisfies SessionMeta,
      ]),
    );
    this.postings = new Map(
      payload.postings.map(([token, entries]) => [
        String(token),
        new Map((entries ?? []).map(([docId, tf]) => [Number(docId), Number(tf)] as const)),
      ]),
    );
    this.sessionDocs = new Map();
    for (const doc of this.docs) {
      const list = this.sessionDocs.get(doc.sessionId);
      if (list) list.push(doc.id);
      else this.sessionDocs.set(doc.sessionId, [doc.id]);
    }
    this.lastSeq = payload.lastSeq;
  }

 /** 写 breadcrumb(best-effort:观测数据写不出来不影响检索)。 */
  private writeBreadcrumb(meta: { source: SearchCacheSource; reason?: string; lastSeq?: number }): void {
    if (!this.breadcrumbFile) return;
    try {
      const ok = writeBreadcrumbFile(this.breadcrumbFile, {
        v: 1,
        at: this.now(),
        source: meta.source,
        ...(meta.reason ? { reason: meta.reason } : {}),
        docs: this.docs.length,
        sessions: this.sessions.size,
        lastSeq: meta.lastSeq ?? this.lastSeq,
      });
      if (ok) this.readBreadcrumb();
    } catch {
 /* breadcrumb 是派生观测数据:写失败不外抛 */
    }
  }

  private readBreadcrumb(): string | null {
    if (!this.breadcrumbFile) {
      this.breadcrumbText = null;
      return null;
    }
    try {
      this.breadcrumbText = readFileSync(this.breadcrumbFile, "utf-8");
    } catch {
      this.breadcrumbText = null;
    }
    return this.breadcrumbText;
  }

  private reset(): void {
    this.docs = [];
    this.postings = new Map();
    this.sessions = new Map();
    this.sessionDocs = new Map();
    this.lastSeq = -1;
  }

  private indexEvent(event: JournalEvent): void {
    if (event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;
    const sessionId = String(event.sessionId ?? "");
    if (!sessionId) return;
    let meta = this.sessions.get(sessionId);
    if (!meta) {
      meta = {
        sessionId,
        title: "",
        startedAt: event.time,
        lastAt: event.time,
        events: 0,
        messages: 0,
        userMessages: 0,
        subagentDocs: 0,
        automationSeen: false,
        companionSeen: false,
        lastText: "",
      };
      this.sessions.set(sessionId, meta);
    }
    meta.events += 1;
    if (event.time < meta.startedAt) meta.startedAt = event.time;
    if (event.time > meta.lastAt) meta.lastAt = event.time;
    if (event.kind === "automation.run") meta.automationSeen = true;
    if (sessionId.startsWith("auto-")) meta.automationSeen = true;
    if (sessionId.startsWith("companion:")) meta.companionSeen = true;
    const extracted = extractSearchDocument(event);
    if (!extracted) return;
    const text = clip(extracted.text, this.maxTextPerEvent);
    if (!text.trim()) return;
    if (extracted.role === "user") meta.userMessages += 1;
    if (extracted.role === "user" || extracted.role === "agent") meta.messages += 1;
    const doc: IndexedDoc = {
      id: this.docs.length,
      sessionId,
      seq: event.seq,
      kind: event.kind,
      role: extracted.role,
      ts: event.time,
      text,
      tool: extracted.tool,
      weight: extracted.weight,
      subagent: extracted.subagent,
    };
    this.docs.push(doc);
    const list = this.sessionDocs.get(sessionId);
    if (list) list.push(doc.id);
    else this.sessionDocs.set(sessionId, [doc.id]);
    if (doc.subagent) meta.subagentDocs += 1;
    if (!meta.title) meta.title = titleFromText(text);
    meta.lastText = clip(text.replace(/\s+/g, " ").trim(), 160);
    for (const [token, tf] of tokenizeForIndex(text)) {
      let posting = this.postings.get(token);
      if (!posting) {
        posting = new Map();
        this.postings.set(token, posting);
      }
      posting.set(doc.id, tf);
    }
  }

  private sessionSummary(meta: SessionMeta): SessionSummary {
    const source = sourceOf(meta);
    return {
      sessionId: meta.sessionId,
      title: meta.title || meta.sessionId,
      when: new Date(meta.lastAt).toISOString(),
      lastAt: meta.lastAt,
      source,
      demoted: demotedOf(source),
      events: meta.events,
      messages: meta.messages,
      indexed: this.sessionDocs.get(meta.sessionId)?.length ?? 0,
    };
  }

  stats(): SessionSearchStats {
    this.ensureBuilt();
    return {
      built: this.built,
      buildMs: this.buildMs,
      builtAt: this.builtAt,
      docs: this.docs.length,
      sessions: this.sessions.size,
      tokens: this.postings.size,
      lastSeq: this.lastSeq,
      cache: {
        file: this.cacheFile,
        loaded: this.cacheLoaded,
        hit: this.cacheHit,
        source: this.cacheSource,
        breadcrumb: this.breadcrumbText,
      },
      degraded: this.degraded,
      fallbackReason: this.fallbackReason,
    };
  }

  discover(query: string, options: DiscoverOptions = {}): DiscoverResult {
    this.ensureBuilt();
    if (this.degraded) return this.degradedDiscover(query, options);
    const started = this.now();
    const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 5)));
    const text = String(query ?? "").trim();
    const excluded = new Set(uniqueStrings(options.excludeSessionIds));
    const sources = new Set(
      (Array.isArray(options.source) ? options.source : String(options.source ?? "").split(","))
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const now = this.now();
    const after = parseTimeBound(options.after, now);
    const before = parseTimeBound(options.before, now);
    if (!text) {
      const results = [...this.sessions.values()]
        .filter((meta) => !excluded.has(meta.sessionId))
        .filter((meta) => this.sourceAllowed(meta, sources))
        .filter((meta) => this.timeAllowed(meta, after, before))
        .sort((a, b) => b.lastAt - a.lastAt)
        .slice(0, limit)
        .map((meta) => {
          const summary = this.sessionSummary(meta);
          const lastDocId = this.sessionDocs.get(meta.sessionId)?.at(-1);
          const lastDoc = lastDocId === undefined ? undefined : this.docs[lastDocId];
          return {
            ...summary,
            score: 0,
            hits: 0,
            best: lastDoc
              ? {
                  seq: lastDoc.seq,
                  kind: lastDoc.kind,
                  role: lastDoc.role,
                  snippet: clip(lastDoc.text.replace(/\s+/g, " ").trim(), 160),
                  ts: lastDoc.ts,
                }
              : meta.lastText
                ? { seq: 0, kind: "last", role: "agent", snippet: meta.lastText, ts: meta.lastAt }
                : null,
          } satisfies DiscoverHit;
        });
      return {
        mode: "browse",
        query: "",
        count: results.length,
        tookMs: Math.max(0, this.now() - started),
        stats: this.stats(),
        results,
        ...(results.length ? {} : { message: "journal 里还没有可浏览的会话" }),
      };
    }
    const plan = planQuery(text);
    if (!plan.terms.length) {
      return {
        mode: "discover",
        query: text,
        count: 0,
        tookMs: Math.max(0, this.now() - started),
        stats: this.stats(),
        results: [],
        message: "查询里没有可检索的字词",
      };
    }
    const docScores = new Map<number, { raw: number; matched: Set<string> }>();
    for (const term of plan.terms) {
      const posting = this.postings.get(term.token);
      if (!posting) continue;
      for (const [docId, tf] of posting) {
        const doc = this.docs[docId];
        if (!doc || excluded.has(doc.sessionId)) continue;
        if (after !== undefined && doc.ts < after) continue;
        if (before !== undefined && doc.ts >= before) continue;
        const meta = this.sessions.get(doc.sessionId);
        if (!meta || !this.sourceAllowed(meta, sources)) continue;
        let entry = docScores.get(docId);
        if (!entry) {
          entry = { raw: 0, matched: new Set() };
          docScores.set(docId, entry);
        }
        entry.raw += (1 + Math.log(tf)) * term.weight;
        entry.matched.add(term.token);
      }
    }
    const grouped = new Map<
      string,
      { bestScore: number; bestDoc: IndexedDoc | null; top: number[]; hits: number }
    >();
    for (const [docId, entry] of docScores) {
      const doc = this.docs[docId];
      if (!doc) continue;
      const phraseBonus = plan.phrase.length >= 2 && doc.text.toLowerCase().includes(plan.phrase) ? 3 : 0;
      const allTerms = plan.groups.length > 0 && plan.groups.every((group) => group.some((token) => entry.matched.has(token)));
      const ageDays = Math.max(0, (now - doc.ts) / 86_400_000);
      const timeDecay = 0.35 + 0.65 * Math.exp(-ageDays / 45);
      const meta = this.sessions.get(doc.sessionId);
      const source = meta ? sourceOf(meta) : "user";
      const score =
        (entry.raw + phraseBonus) * doc.weight * timeDecay * sourceFactor(source) * (allTerms ? 1.35 : 1);
      let bucket = grouped.get(doc.sessionId);
      if (!bucket) {
        bucket = { bestScore: -1, bestDoc: null, top: [], hits: 0 };
        grouped.set(doc.sessionId, bucket);
      }
      bucket.hits += 1;
      if (score > bucket.bestScore) {
        bucket.bestScore = score;
        bucket.bestDoc = doc;
      }
      if (bucket.top.length < 4) {
        bucket.top.push(score);
        bucket.top.sort((a, b) => b - a);
      } else if (score > (bucket.top[bucket.top.length - 1] ?? 0)) {
        bucket.top[bucket.top.length - 1] = score;
        bucket.top.sort((a, b) => b - a);
      }
    }
    const results: DiscoverHit[] = [];
    for (const [sessionId, bucket] of grouped) {
      const meta = this.sessions.get(sessionId);
      if (!meta) continue;
      const others = bucket.top.filter((value) => value !== bucket.bestScore);
      const sessionScore = bucket.bestScore + 0.2 * others.reduce((sum, value) => sum + value, 0) + 0.02 * Math.log(1 + bucket.hits);
      const summary = this.sessionSummary(meta);
      results.push({
        ...summary,
        score: Math.round(sessionScore * 100) / 100,
        hits: bucket.hits,
        best: bucket.bestDoc
          ? {
              seq: bucket.bestDoc.seq,
              kind: bucket.bestDoc.kind,
              role: bucket.bestDoc.role,
              snippet: makeSnippet(bucket.bestDoc.text, plan),
              ts: bucket.bestDoc.ts,
            }
          : null,
      });
    }
    results.sort((a, b) => b.score - a.score || b.lastAt - a.lastAt);
    const sliced = results.slice(0, limit);
    return {
      mode: "discover",
      query: text,
      count: sliced.length,
      tookMs: Math.max(0, this.now() - started),
      stats: this.stats(),
      results: sliced,
      ...(sliced.length ? {} : { message: "没有匹配的会话(试试更短的关键词或去掉过滤条件)" }),
    };
  }

  private sourceAllowed(meta: SessionMeta, sources: Set<string>): boolean {
    return sources.size === 0 || sources.has(sourceOf(meta));
  }

  private timeAllowed(meta: SessionMeta, after: number | undefined, before: number | undefined): boolean {
    if (after !== undefined && meta.lastAt < after) return false;
    if (before !== undefined && meta.lastAt >= before) return false;
    return true;
  }

  scroll(sessionId: string, options: ScrollOptions = {}): ScrollResult {
    this.ensureBuilt();
    if (this.degraded) return this.degradedScroll(sessionId, options);
    const sid = String(sessionId ?? "").trim();
    const meta = this.sessions.get(sid);
    if (!meta) {
      return { mode: "scroll", sessionId: sid, session: null, events: [], message: `会话不存在或没有可检索内容: ${sid}` };
    }
    const limit = Math.max(1, Math.min(20, Math.trunc(options.limit ?? 5)));
    const before = Math.max(0, Math.min(10, Math.trunc(options.before ?? 2)));
    const after = Math.max(0, Math.min(10, Math.trunc(options.after ?? 2)));
    const ids = this.sessionDocs.get(sid) ?? [];
    const summary = this.sessionSummary(meta);
    const query = String(options.query ?? "").trim();
    if (query) {
      const plan = planQuery(query);
      const matchedIds: number[] = [];
      for (const id of ids) {
        const doc = this.docs[id];
        if (!doc) continue;
        const hit = plan.terms.some((term) => (this.postings.get(term.token)?.get(id) ?? 0) > 0);
        if (hit) matchedIds.push(id);
      }
      matchedIds.sort((a, b) => compareSeq(this.docs[a]!, this.docs[b]!));
      const offset = Math.max(0, Math.trunc(Number(options.cursor ?? 0) || 0));
      const slice = matchedIds.slice(offset, offset + limit);
      const events: ScrollEvent[] = [];
      // 输出有界:多命中窗口叠加最多 60 条上下文(防 limit/window 双大时工具结果爆 token)。
      outer: for (const id of slice) {
        const doc = this.docs[id]!;
        const position = ids.indexOf(id);
        const windowStart = Math.max(0, position - before);
        const windowEnd = Math.min(ids.length, position + after + 1);
        for (let i = windowStart; i < windowEnd; i++) {
          const ctx = this.docs[ids[i]!]!;
          if (events.some((event) => event.seq === ctx.seq)) continue;
          if (events.length >= 60) break outer;
          events.push({ ...shapeEvent(ctx, plan, 1500), ...(ctx.id === id ? { anchor: true } : {}) });
        }
      }
      const next = offset + limit;
      return {
        mode: "scroll",
        sessionId: sid,
        session: summary,
        query,
        cursor: String(offset),
        ...(next < matchedIds.length ? { nextCursor: String(next) } : {}),
        totalMatches: matchedIds.length,
        events,
        ...(matchedIds.length ? {} : { message: `会话内没有匹配「${query}」的内容` }),
      };
    }
    if (ids.length === 0) {
      return { mode: "scroll", sessionId: sid, session: summary, events: [], message: "该会话没有可读事件" };
    }
    let anchor = options.seq;
    if (anchor === undefined || !Number.isFinite(anchor)) anchor = this.docs[ids[ids.length - 1]!]?.seq ?? 0;
    let position = ids.findIndex((id) => (this.docs[id]?.seq ?? 0) >= anchor!);
    if (position < 0) position = ids.length - 1;
    const start = Math.max(0, position - before);
    const end = Math.min(ids.length, position + after + 1);
    const events: ScrollEvent[] = [];
    for (let i = start; i < end; i++) {
      const doc = this.docs[ids[i]!]!;
      events.push({ ...shapeEvent(doc, null, 1500), ...(doc.seq === anchor ? { anchor: true } : {}) });
    }
    const first = events[0];
    const last = events[events.length - 1];
    return {
      mode: "scroll",
      sessionId: sid,
      session: summary,
      anchorSeq: anchor,
      events,
      message:
        first && last
          ? `前后翻页:再调 scroll 时 seq=${last.seq}(向后)或 seq=${first.seq}(向前)。`
          : undefined,
    };
  }

  read(sessionId: string, options: ReadOptions = {}): ReadResult {
    this.ensureBuilt();
    if (this.degraded) return this.degradedRead(sessionId, options);
    const sid = String(sessionId ?? "").trim();
    const meta = this.sessions.get(sid);
    if (!meta) {
      return {
        mode: "read",
        sessionId: sid,
        session: null,
        events: [],
        fromSeq: Math.max(0, Math.trunc(options.fromSeq ?? 0)),
        nextSeq: null,
        done: true,
        total: 0,
        message: `会话不存在或没有可检索内容: ${sid}`,
      };
    }
    const ids = this.sessionDocs.get(sid) ?? [];
    const fromSeq = Math.max(0, Math.trunc(options.fromSeq ?? 0));
    const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 20)));
    let position = ids.findIndex((id) => (this.docs[id]?.seq ?? 0) >= fromSeq);
    if (position < 0) position = ids.length;
    const slice = ids.slice(position, position + limit);
    const events = slice.map((id) => shapeEvent(this.docs[id]!, null, 2000));
    const consumed = position + slice.length;
    const nextSeq = consumed < ids.length ? (this.docs[ids[consumed]!]?.seq ?? null) : null;
    return {
      mode: "read",
      sessionId: sid,
      session: this.sessionSummary(meta),
      events,
      fromSeq,
      nextSeq,
      done: nextSeq === null,
      total: ids.length,
      ...(ids.length ? {} : { message: "该会话没有可读事件" }),
    };
  }

 /** 立即写缓存(可选)。返回是否实际写盘(至少一份副本成功)。 */
  flush(): boolean {
    if (!this.cacheFile || !this.built || !this.dirty) return false;
    this.clearCacheTimer();
    try {
      const payload = this.buildPayload();
      const shadowPath = this.shadowFile ?? `${this.cacheFile}.shadow`;
      const result = writeShadowPair(this.cacheFile, shadowPath, this.breadcrumbFile, payload, {
        source: this.cacheSource ?? "rebuild",
        docs: this.docs.length,
        sessions: this.sessions.size,
        lastSeq: this.lastSeq,
        now: this.now,
      });
      if (result.written.length === 0) return false; // 两份都失败:保持 dirty,下轮再试
      this.dirty = false;
      this.lastCacheWrite = this.now();
      this.readBreadcrumb();
      return true;
    } catch {
 // fail-open:缓存写不出去只是「下次重建更慢」,绝不影响检索本身。
      return false;
    }
  }

  private buildPayload(): CachePayload {
    const journalEvents = this.journal.readAll();
    return {
      v: CACHE_VERSION,
      lastSeq: this.lastSeq,
      firstTime: journalEvents[0]?.time ?? 0,
      lastTime: journalEvents[journalEvents.length - 1]?.time ?? 0,
      docs: this.docs.map((doc) => [
        doc.sessionId,
        doc.seq,
        doc.kind,
        doc.role,
        doc.ts,
        doc.text,
        doc.tool,
        doc.weight,
        doc.subagent ? 1 : 0,
      ]),
      sessions: [...this.sessions.values()].map((meta) => [
        meta.sessionId,
        meta.title,
        meta.startedAt,
        meta.lastAt,
        meta.events,
        meta.messages,
        meta.userMessages,
        meta.subagentDocs,
        meta.automationSeen ? 1 : 0,
        meta.companionSeen ? 1 : 0,
        meta.lastText,
      ]),
      postings: [...this.postings.entries()].map(([token, posting]) => [token, [...posting.entries()]]),
    };
  }

  /** 停止订阅/定时器;尽力 flush 缓存。 */
  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearCacheTimer();
    this.flush();
  }

 /* ── 降级路径(fail-open):索引不可用时用 journal 线性扫描兜底,三形态对外绝不抛 ── */

  private degradedDiscover(query: string, options: DiscoverOptions): DiscoverResult {
    this.cacheSource = "fallback";
    const started = this.now();
    const text = String(query ?? "").trim();
    const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 5)));
    try {
      const events = this.journal.readAll();
      const scan = scanJournalFallback(events, text, { now: this.now });
      const timeBySeq = new Map<number, number>(events.map((event) => [event.seq, event.time] as const));
      const grouped = new Map<string, JournalScanHit[]>();
      for (const hit of scan.hits) {
        const bucket = grouped.get(hit.sessionId);
        if (bucket) bucket.push(hit);
        else grouped.set(hit.sessionId, [hit]);
      }
      const results: DiscoverHit[] = [...grouped.entries()]
        .map(([sessionId, hits]) => {
          const firstHit = hits[0]!;
          const lastAt = Math.max(...hits.map((hit) => timeBySeq.get(hit.seq) ?? 0));
          return {
            sessionId,
            title: clip(flattenText(firstHit.text), 60) || sessionId,
            when: new Date(lastAt).toISOString(),
            lastAt,
            source: "user" as const,
            demoted: false,
            events: hits.length,
            messages: hits.length,
            indexed: hits.length,
            score: hits.length,
            hits: hits.length,
            best: {
              seq: firstHit.seq,
              kind: firstHit.kind,
              role: roleOfKind(firstHit.kind),
              snippet: firstHit.snippet,
              ts: timeBySeq.get(firstHit.seq) ?? lastAt,
            },
          } satisfies DiscoverHit;
        })
        .sort((a, b) => b.score - a.score || b.lastAt - a.lastAt)
        .slice(0, limit);
      return {
        mode: "discover",
        query: text,
        count: results.length,
        tookMs: Math.max(0, this.now() - started),
        stats: this.stats(),
        results,
        message: degradedMessage(this.fallbackReason),
      };
    } catch (error) {
      return {
        mode: "discover",
        query: text,
        count: 0,
        tookMs: Math.max(0, this.now() - started),
        stats: this.stats(),
        results: [],
        message: degradedMessage(errorMessage(error)),
      };
    }
  }

  private degradedScroll(sessionId: string, options: ScrollOptions): ScrollResult {
    this.cacheSource = "fallback";
    const sid = String(sessionId ?? "").trim();
    const limit = Math.max(1, Math.min(20, Math.trunc(options.limit ?? 5)));
    const query = String(options.query ?? "").trim();
    try {
      const events = this.journal.readAll().filter((event) => String(event.sessionId ?? "") === sid);
      if (events.length === 0) {
        return { mode: "scroll", sessionId: sid, session: null, events: [], message: `会话不存在或没有可检索内容: ${sid}` };
      }
      const summary = fallbackSummary(sid, events);
      if (!query) {
 // 无 query:线性扫描退化为「该会话前 limit 条」,与正常 scroll 的翻页起点语义一致。
        return {
          mode: "scroll",
          sessionId: sid,
          session: summary,
          events: events.slice(0, limit).map((event) => fallbackScrollEvent(event, null)),
          message: degradedMessage(this.fallbackReason),
        };
      }
      const scan = scanJournalFallback(events, query, { now: this.now });
      const snippetBySeq = new Map<number, string>(scan.hits.map((hit) => [hit.seq, hit.snippet] as const));
      return {
        mode: "scroll",
        sessionId: sid,
        session: summary,
        query,
        totalMatches: scan.hits.length,
        events: events
          .filter((event) => snippetBySeq.has(event.seq))
          .slice(0, limit)
          .map((event) => fallbackScrollEvent(event, snippetBySeq.get(event.seq) ?? null)),
        message: scan.hits.length ? degradedMessage(this.fallbackReason) : `会话内没有匹配「${query}」的内容`,
      };
    } catch (error) {
      return { mode: "scroll", sessionId: sid, session: null, events: [], message: degradedMessage(errorMessage(error)) };
    }
  }

  private degradedRead(sessionId: string, options: ReadOptions): ReadResult {
    this.cacheSource = "fallback";
    const sid = String(sessionId ?? "").trim();
    const fromSeq = Math.max(0, Math.trunc(options.fromSeq ?? 0));
    const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 20)));
    try {
      const events = this.journal.readAll().filter((event) => String(event.sessionId ?? "") === sid);
      if (events.length === 0) {
        return {
          mode: "read",
          sessionId: sid,
          session: null,
          events: [],
          fromSeq,
          nextSeq: null,
          done: true,
          total: 0,
          message: `会话不存在或没有可检索内容: ${sid}`,
        };
      }
      let position = events.findIndex((event) => event.seq >= fromSeq);
      if (position < 0) position = events.length;
      const slice = events.slice(position, position + limit);
      const nextSeq = position + slice.length < events.length ? events[position + slice.length]!.seq : null;
      return {
        mode: "read",
        sessionId: sid,
        session: fallbackSummary(sid, events),
        events: slice.map((event) => fallbackScrollEvent(event, null)),
        fromSeq,
        nextSeq,
        done: nextSeq === null,
        total: events.length,
        message: degradedMessage(this.fallbackReason),
      };
    } catch (error) {
      return {
        mode: "read",
        sessionId: sid,
        session: null,
        events: [],
        fromSeq,
        nextSeq: null,
        done: true,
        total: 0,
        message: degradedMessage(errorMessage(error)),
      };
    }
  }

  private markDirty(): void {
    if (!this.cacheFile) return;
    this.dirty = true;
    if (this.cacheTimer) return;
    const wait = Math.max(this.cacheDebounceMs, this.lastCacheWrite + 30_000 - this.now(), 0);
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = null;
      this.flush();
    }, wait);
    this.cacheTimer.unref?.();
  }

  private clearCacheTimer(): void {
    if (this.cacheTimer) {
      clearTimeout(this.cacheTimer);
      this.cacheTimer = null;
    }
  }
}

/** 便捷构造:已 attach journal 的索引(不立即构建)。 */
export function createSessionSearchIndex(journal: Journal, options: SessionSearchOptions = {}): SessionSearchIndex {
  return new SessionSearchIndex(journal, options);
}
