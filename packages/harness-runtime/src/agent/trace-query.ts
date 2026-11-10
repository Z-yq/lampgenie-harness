/**
 * 轨迹查询层(txa6/txa7/txa8 + txa9 聚合面):journal 事件的**过滤 + 投影裁剪 + 聚合**。
 *
 * 纯函数、零 IO——journal 由调用方(gateway 的 trace.query 命令)传入,便于单测与复用。
 * 设计纪律:
 * - **不抛**:空事件 / 非法 filter 一律按默认口径给零值,面板侧「查不到」不该变连接错误。
 * - **不透传大字段**:content/text/arguments 超 2000 字符截断并置 truncated;payload.images
 *   一律换成占位串(base64 图片绝不进 wire,几十 MB 会把 ws 撑爆)。
 * - 聚合只在**匹配集**(过滤后、limit 前)上算,matched 是诚实总数,returned 才是下发条数。
 */

/** 入参事件的最小结构(与 core journal 事件结构兼容,但不反向依赖 core)。 */
export interface TraceQueryEvent {
  seq: number;
  kind: string;
  time?: number;
  sessionId?: string;
  payload?: unknown;
  idempotencyKey?: string;
}

export interface TraceQueryFilter {
  /** 只要这些 kind。 */
  kinds?: string[];
  /** 只要这些工具名(只裁 tool.call/tool.result;非工具事件不受影射)。 */
  tools?: string[];
  /** 只要该 turn(payload.turn;无 turn 字段的事件在给了 turn 时被剔除)。 */
  turn?: number;
  /** 起点 seq(含);按 seq 升序取 >= sinceSeq。 */
  sinceSeq?: number;
  /** 只要错误事件(tool.result 失败 / llm 失败 / payload.error 存在)。 */
  onlyErrors?: boolean;
  /** 返回条数上限:默认 200,硬上限 2000;非法(负/非数/0)按默认。 */
  limit?: number;
}

export interface TraceQuerySummary {
  /** 过滤后的事件总数(不受 limit 影响)。 */
  matched: number;
  /** 实际下发条数。 */
  returned: number;
  kindCounts: Record<string, number>;
  slowestTools: { name: string; toolCallId: string; durationMs: number; errored: boolean }[];
  toolErrors: { name: string; count: number; origins?: Record<string, number> }[];
  llmCalls: number;
  llmFailures: number;
  firstSeq: number | null;
  lastSeq: number | null;
}

export const TRACE_QUERY_DEFAULT_LIMIT = 200;
export const TRACE_QUERY_MAX_LIMIT = 2000;
/** 单字段投影上限(字符)。 */
const FIELD_MAX = 2000;
/** images 元素占位(不透明:绝不把 base64 带上 wire)。 */
const IMAGE_PLACEHOLDER = "(image omitted)";
/** 会被裁剪的字段名(工具结果正文 / 助手文本 / 工具入参)。 */
const TRUNCATABLE_KEYS = new Set(["content", "text", "arguments"]);

/**
 * 工具是否失败。**新旧两形态都认**:
 * 1) 新形态(txa2):payload.error = { origin, message, name? },origin ∈
 *    unknown-tool|timeout|threw|aborted|denied;
 * 2) 旧 journal 回退:无 error 键,失败靠 content 以「错误:」前缀表达(loop 历史写法)。
 * 顺序不能反:旧数据 content 可能合法地以「错误:」开头,但一旦有结构化 error 就以它为准。
 */
export function isToolError(payload: unknown): boolean {
  const p = (payload ?? null) as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return false;
  const err = p.error;
  if (err && typeof err === "object") return true;
  if (typeof err === "string" && err.length > 0) return true;
  // ---- 旧 journal 回退(content 前缀口径;txa2 之前的落盘数据)----
  return typeof p.content === "string" && p.content.startsWith("错误:");
}

/** LLM 调用失败:message.agent 带 error / ok:false(旧数据无此字段=成功)。 */
function isLlmFailure(payload: unknown): boolean {
  const p = (payload ?? null) as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return false;
  if (p.error !== undefined && p.error !== null && p.error !== false) return true;
  return p.ok === false;
}

/** 任意事件层面的错误判定(onlyErrors 口径)。 */
function isErrorEvent(kind: string, payload: unknown): boolean {
  if (kind === "tool.result") return isToolError(payload);
  if (kind === "message.agent") return isLlmFailure(payload);
  const p = (payload ?? null) as Record<string, unknown> | null;
  return !!p && typeof p === "object" && p.error !== undefined && p.error !== null && p.error !== false;
}

/** 单字段截断:超长 → 前缀 + truncated 标记(调用方在 payload 上置 truncated:true)。 */
function clipString(s: string): { value: string; truncated: boolean } {
  if (s.length <= FIELD_MAX) return { value: s, truncated: false };
  return { value: s.slice(0, FIELD_MAX), truncated: true };
}

/**
 * payload 投影裁剪(浅层 + 数组一层,足够覆盖 journal 实际结构):
 * - content/text/arguments 超 2000 字符 → 截断 + payload.truncated = true;
 * - payload.images 元素 → "(image omitted)"。
 * 返回新对象,不改入参(调用方可能复用 journal 缓存对象)。
 */
function projectPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const src = payload as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  let truncated = false;
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (TRUNCATABLE_KEYS.has(k) && typeof v === "string") {
      const r = clipString(v);
      out[k] = r.value;
      if (r.truncated) truncated = true;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      // 一层下钻:挡 tool.result.payload.result.{content,text} 这类嵌套正文
      const nested = v as Record<string, unknown>;
      let child: Record<string, unknown> | undefined;
      for (const ck of Object.keys(nested)) {
        const cv = nested[ck];
        if (TRUNCATABLE_KEYS.has(ck) && typeof cv === "string") {
          const r = clipString(cv);
          child = child ?? { ...nested };
          child[ck] = r.value;
          if (r.truncated) truncated = true;
        }
      }
      if (child) out[k] = child;
    }
  }
  if (Array.isArray(src.images)) {
    out.images = src.images.map(() => IMAGE_PLACEHOLDER);
  }
  if (truncated) out.truncated = true;
  return out;
}

function projectEvent(e: TraceQueryEvent): TraceQueryEvent {
  return {
    seq: e.seq,
    kind: e.kind,
    ...(e.time !== undefined ? { time: e.time } : {}),
    ...(e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
    ...(e.idempotencyKey !== undefined ? { idempotencyKey: e.idempotencyKey } : {}),
    payload: projectPayload(e.payload),
  };
}

/** limit 归一:非数/<=0 → 默认;超上限 → 硬上限。 */
function normalizeLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return TRACE_QUERY_DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n <= 0) return TRACE_QUERY_DEFAULT_LIMIT;
  return Math.min(n, TRACE_QUERY_MAX_LIMIT);
}

function matchesFilter(e: TraceQueryEvent, f: TraceQueryFilter): boolean {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (f.kinds && f.kinds.length > 0 && !f.kinds.includes(e.kind)) return false;
  if (f.turn !== undefined && p.turn !== f.turn) return false;
  if (f.sinceSeq !== undefined && e.seq < f.sinceSeq) return false;
  if (f.tools && f.tools.length > 0 && (e.kind === "tool.call" || e.kind === "tool.result")) {
    const name = typeof p.name === "string" ? p.name : "";
    if (!f.tools.includes(name)) return false;
  }
  if (f.onlyErrors && !isErrorEvent(e.kind, e.payload)) return false;
  return true;
}

function emptySummary(): TraceQuerySummary {
  return {
    matched: 0, returned: 0, kindCounts: {},
    slowestTools: [], toolErrors: [],
    llmCalls: 0, llmFailures: 0,
    firstSeq: null, lastSeq: null,
  };
}

/**
 * 轨迹查询主入口。
 * @returns events=投影后的匹配事件(截断到 limit,按 seq 升序);summary=匹配集上的聚合。
 */
export function queryTrace(
  events: readonly TraceQueryEvent[],
  filter: TraceQueryFilter = {},
): { events: TraceQueryEvent[]; summary: TraceQuerySummary } {
  const f = filter ?? {};
  if (!Array.isArray(events) || events.length === 0) return { events: [], summary: emptySummary() };

  const matched = events.filter((e) => e && matchesFilter(e, f));
  if (matched.length === 0) return { events: [], summary: emptySummary() };

  const summary = emptySummary();
  summary.matched = matched.length;

  const byKind = new Map<string, number>();
  const tools: { name: string; toolCallId: string; durationMs: number; errored: boolean }[] = [];
  const errByName = new Map<string, { name: string; count: number; origins: Record<string, number> }>();
  let firstSeq: number | null = null;
  let lastSeq: number | null = null;

  for (const e of matched) {
    byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
    if (typeof e.seq === "number") {
      firstSeq = firstSeq === null ? e.seq : Math.min(firstSeq, e.seq);
      lastSeq = lastSeq === null ? e.seq : Math.max(lastSeq, e.seq);
    }
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.kind === "message.agent") {
      summary.llmCalls += 1;
      if (isLlmFailure(e.payload)) summary.llmFailures += 1;
    } else if (e.kind === "llm.trace" && isLlmFailure(e.payload)) {
      // 失败调用由 loop 落成 llm.trace 事件(带 error,见 loop.ts 失败分支),不在 message.agent 里;
      // 这里只补失败计数、**不进 llmCalls**——与 trace-stats 口径对齐(llmCalls 只数成功的 message.agent)。
      // 2026-11-03 真实浏览器验证发现:漏了这条分支 → 面板摘要永远显示「失败 0」。
      summary.llmFailures += 1;
    }
    if (e.kind === "tool.result") {
      const name = typeof p.name === "string" ? p.name : "";
      const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : "";
      const durationMs = typeof p.durationMs === "number" && Number.isFinite(p.durationMs) ? p.durationMs : 0;
      const errored = isToolError(e.payload);
      tools.push({ name, toolCallId, durationMs, errored });
      if (errored) {
        const agg = errByName.get(name) ?? { name, count: 0, origins: {} };
        agg.count += 1;
        const err = p.error as { origin?: unknown } | undefined;
        const origin = err && typeof err === "object" && typeof err.origin === "string" ? err.origin : undefined;
        if (origin) agg.origins[origin] = (agg.origins[origin] ?? 0) + 1;
        errByName.set(name, agg);
      }
    }
  }

  summary.kindCounts = Object.fromEntries(byKind);
  // top10 最慢工具(降序;同耗时保原序)
  summary.slowestTools = tools.slice().sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
  summary.toolErrors = [...errByName.values()]
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name))
    .map((a) => (Object.keys(a.origins).length > 0 ? a : { name: a.name, count: a.count }));
  summary.firstSeq = firstSeq;
  summary.lastSeq = lastSeq;

  const limit = normalizeLimit(f.limit);
  const picked = matched
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .slice(0, limit)
    .map(projectEvent);
  summary.returned = picked.length;
  return { events: picked, summary };
}
