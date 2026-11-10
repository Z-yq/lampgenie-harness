/**
 * 模型错误策略表(M33,对齐 docs/mechanisms.md #33)。
 *
 * 要治的病:永久错误(鉴权/配额/模型未配置)被当限流无限重试;quota 429 被当 throttle
 * 冻结共享桶;未知 provider code 无限重试;全部子代理 backoff 时 run 无进展也无提示。
 *
 * 本模块是纯函数层(无 IO、无状态副作用),两件事:
 *  1) classifyModelError 把 {status, body, err, signalAborted, headers} 归类成
 *     cancelled/quota/auth/not_configured/model_unavailable/context_exceeded/
 *     invalid_request/rate_limited/transient/unknown,并给出 retryable/stop/退避/resetAt/可操作文案;
 *  2) UnknownErrorBudget 对同一 model/provider 的连续 unknown 计数,达 10 次停止;其它任何分类
 *     (含 cancelled——用户取消不应延长「未知错误」的连续计数)清零。
 * 接线在 openai-provider.ts(postWithRetry / chatStreamedWithRetry)。
 */

export type ModelErrorKind =
  | "cancelled"
  | "quota"
  | "auth"
  | "not_configured"
  | "model_unavailable"
  | "context_exceeded"
  | "invalid_request"
  | "rate_limited"
  | "transient"
  | "unknown";

/** 未知错误码连续次数上限(机制 #33:未知连续 10 次停)。 */
export const UNKNOWN_ERROR_STOP_COUNT = 10;

export interface ModelErrorInput {
  /** HTTP 状态码(流中途错误没有)。 */
  status?: number;
  /** 响应体(或流内 error.message)。分类只看关键词,调用方截断到合理长度即可。 */
  body?: string;
  /** 网络层异常(fetch 抛出的 TypeError 等)或流内错误对象。 */
  err?: unknown;
  /** 调用方已确认 signal 处于 aborted(取消优先于一切分类)。 */
  signalAborted?: boolean;
  /** 响应头:retry-after / x-ratelimit-reset-* 用于 resetAt。 */
  headers?: Headers | Record<string, string | undefined>;
}

export interface ModelErrorDecision {
  kind: ModelErrorKind;
  /** 调用方可以退避重试。 */
  retryable: boolean;
  /** 必须立即停止(永久错误 / 取消 / 预算耗尽),不再重试。 */
  stop: boolean;
  /** rate_limited / transient 的建议等待。 */
  retryAfterMs?: number;
  /** quota:额度恢复时间(毫秒时间戳),解析自 retry-after / x-ratelimit-reset-*。 */
  resetAt?: number;
  /** 可操作文案(给用户/面板看)。 */
  action: string;
  /** 错误正文摘要(≤200 字),拼进错误 message。 */
  detail: string;
}

const ACTION: Record<ModelErrorKind, string> = {
  cancelled: "请求已取消,不再重试",
  quota: "配额/额度用尽:充值或换模型;恢复后可继续",
  auth: "检查 API Key/凭证",
  not_configured: "检查模型名/Provider 配置",
  model_unavailable: "检查模型名/Provider 配置,或换可用模型",
  context_exceeded: "先压缩/减少上下文再重试",
  invalid_request: "检查请求参数(见 body 摘要)",
  rate_limited: "被限流:按 retryAfter 退避重试",
  transient: "服务端/网络抖动:退避重试",
  unknown: `未知错误码:连续 ${UNKNOWN_ERROR_STOP_COUNT} 次将停止重试`,
};

const DETAIL_MAX = 200;

/** 从响应体/异常取摘要:JSON 里优先 error.type/code/message,否则原文前 200 字。 */
export function extractErrorDetail(body?: string | null, err?: unknown): string {
  const raw = typeof body === "string" && body ? body : errText(err);
  if (!raw) return "";
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed) as { error?: { type?: string; code?: string; message?: string }; message?: string };
      const e = j.error;
      if (e && typeof e === "object") {
        const parts = [e.type, e.code, e.message].filter((x): x is string => typeof x === "string" && x.length > 0);
        if (parts.length) {
          // 形态与 provider-apitypes.errorText 同构(type: message / code: message),
          // 旧调用方按 `LLM <status>: <detail>` 的断言因此保持兼容。
          if (e.type && e.message) return `${e.type}: ${e.message}`.slice(0, DETAIL_MAX);
          if (e.code && e.message) return `${e.code}: ${e.message}`.slice(0, DETAIL_MAX);
          return parts[parts.length - 1]!.slice(0, DETAIL_MAX);
        }
      }
      if (typeof j.message === "string" && j.message) return j.message.slice(0, DETAIL_MAX);
    } catch {
      /* 非 JSON:原文透传 */
    }
  }
  return trimmed.slice(0, DETAIL_MAX);
}

function errText(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  const e = err as { message?: unknown; cause?: { code?: unknown; message?: unknown }; name?: unknown };
  const parts: string[] = [];
  if (typeof e?.name === "string") parts.push(e.name);
  if (typeof e?.message === "string") parts.push(e.message);
  const c = e?.cause;
  if (c) {
    if (typeof c.code === "string") parts.push(c.code);
    if (typeof c.message === "string") parts.push(c.message);
  }
  return parts.join(" ");
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: unknown; message?: unknown };
  if (e.name === "AbortError") return true;
  return typeof e.message === "string" && /\baborted\b/i.test(e.message);
}

function headerValue(headers: ModelErrorInput["headers"], name: string): string | undefined {
  if (!headers) return undefined;
  const get = (headers as Headers).get;
  if (typeof get === "function") return (headers as Headers).get(name) ?? undefined;
  const rec = headers as Record<string, string | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  return key ? rec[key] ?? undefined : undefined;
}

/** retry-after:秒数(可带小数)或 HTTP-date → 毫秒等待时长。 */
export function parseRetryAfter(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  if (/^\d+(?:[.,]\d+)?$/.test(s)) {
    const sec = Number(s.replace(",", "."));
    return Number.isFinite(sec) && sec >= 0 ? Math.round(sec * 1000) : undefined;
  }
  const at = Date.parse(s);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return parseDuration(s);
}

/** 时长串("6m0s"/"1s"/"250ms"/"1h30m")→ 毫秒。 */
export function parseDuration(raw: string): number | undefined {
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let m: RegExpExecArray | null;
  let total = 0;
  let hits = 0;
  while ((m = re.exec(raw))) {
    const n = Number(m[1]);
    const unit = m[2]!;
    total += unit === "ms" ? n : unit === "h" ? n * 3_600_000 : unit === "m" ? n * 60_000 : n * 1000;
    hits++;
  }
  return hits > 0 ? Math.round(total) : undefined;
}

/** x-ratelimit-reset-*:epoch 秒/毫秒、ISO 时间或时长串 → 毫秒时间戳。 */
export function parseResetAt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n >= 1e12 ? Math.round(n) : Math.round(n * 1000);
  }
  const at = Date.parse(s);
  if (!Number.isNaN(at)) return at;
  const dur = parseDuration(s);
  return dur === undefined ? undefined : Date.now() + dur;
}

/** 响应体里的 reset 线索(部分网关把 reset_at/retry_after 放在 error 对象里)。 */
function bodyResetAt(body: string | undefined): number | undefined {
  if (!body) return undefined;
  try {
    const j = JSON.parse(body) as { error?: Record<string, unknown>; reset_at?: unknown; retry_after?: unknown };
    const src = (j.error && typeof j.error === "object" ? j.error : j) as Record<string, unknown>;
    const resetAt = src.reset_at ?? src.resetAt;
    if (typeof resetAt === "number") return resetAt >= 1e12 ? resetAt : resetAt * 1000;
    if (typeof resetAt === "string") return parseResetAt(resetAt);
    const after = src.retry_after ?? src.retryAfter;
    if (typeof after === "number" && after > 0) return Date.now() + after * 1000;
    if (typeof after === "string") {
      const asAt = parseResetAt(after);
      if (asAt !== undefined) return asAt;
      const dur = parseDuration(after);
      return dur === undefined ? undefined : Date.now() + dur;
    }
  } catch {
    /* 非 JSON */
  }
  return undefined;
}

const QUOTA_RE = /quota|insufficient_quota|billing|余额|额度|配额/;
const AUTH_RE = /invalid api key|invalid_api_key|invalid x-api-key|unauthorized|authentication|unauthenticated|invalid token|api key/i;
const AUTH_STRONG_RE = /invalid api key|invalid_api_key|invalid x-api-key|unauthorized|unauthenticated|api key/i;
const MODEL_RE = /model_not_found|model .*not exist|does not exist|no such model|unknown model|model_not_available|模型不存在/;
const CONTEXT_RE = /context length|maximum context|context_length_exceeded|too many tokens|prompt is too long|reduce the length|上下文长度/;
const NETWORK_RE = /fetch failed|terminated|econnreset|econnrefused|econnaborted|enotfound|etimedout|epipe|eai_again|socket hang up|network error|networkerror|other side closed/i;

function decide(kind: ModelErrorKind, opts: Partial<Pick<ModelErrorDecision, "retryable" | "stop" | "retryAfterMs" | "resetAt">> & { detail?: string } = {}): ModelErrorDecision {
  const retryable = opts.retryable ?? false;
  return {
    kind,
    retryable,
    stop: opts.stop ?? !retryable,
    ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
    ...(opts.resetAt !== undefined ? { resetAt: opts.resetAt } : {}),
    action: ACTION[kind],
    detail: opts.detail ?? "",
  };
}

/**
 * 错误分类纯函数。判定顺序即优先级:
 * 取消 > 鉴权(401/403/文案) > 配额/限流(429/402) > 模型缺失(404/文案) > 上下文超限 >
 * 其它 400/422 > 5xx/网络层 > 未知。
 */
export function classifyModelError(input: ModelErrorInput): ModelErrorDecision {
  const { status, body, err, signalAborted, headers } = input;
  const detail = extractErrorDetail(body, err);
  const text = `${body ?? ""} ${errText(err)}`;

  if (signalAborted || isAbortError(err)) return decide("cancelled", { stop: true, detail });

  if (status === 401 || status === 403) return decide("auth", { stop: true, detail });
  if (status !== undefined && status < 500 && AUTH_RE.test(text)) {
    return decide("auth", { stop: true, detail });
  }
  // 流中途(无 status)只认强特征,避免把普通文案里的 "authentication" 误判成鉴权。
  if (status === undefined && AUTH_STRONG_RE.test(text)) return decide("auth", { stop: true, detail });

  if (status === 429 || (status === 402 && QUOTA_RE.test(text)) || (status === undefined && QUOTA_RE.test(text))) {
    if (QUOTA_RE.test(text)) {
      return decide("quota", { stop: true, resetAt: quotaResetAt(headers, body, detail), detail });
    }
    const retryAfterMs = parseRetryAfter(headerValue(headers, "retry-after"));
    return decide("rate_limited", { retryable: true, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), detail });
  }

  if (status === 404 && MODEL_RE.test(text)) return decide("not_configured", { stop: true, detail });
  if (status === 404) return decide("model_unavailable", { stop: true, detail });
  if (status !== undefined && status < 500 && MODEL_RE.test(text)) {
    return decide("not_configured", { stop: true, detail });
  }

  if (CONTEXT_RE.test(text)) return decide("context_exceeded", { stop: true, detail });

  if (status === 400 || status === 422) return decide("invalid_request", { stop: true, detail });

  if (status !== undefined && status >= 500) {
    const retryAfterMs = parseRetryAfter(headerValue(headers, "retry-after"));
    return decide("transient", { retryable: true, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), detail });
  }
  if (NETWORK_RE.test(text)) return decide("transient", { retryable: true, detail });

  return decide("unknown", { retryable: true, detail });
}

function quotaResetAt(headers: ModelErrorInput["headers"], body: string | undefined, detail: string): number | undefined {
  for (const name of [
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "x-ratelimit-reset",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-reset",
    "ratelimit-reset",
  ]) {
    const at = parseResetAt(headerValue(headers, name));
    if (at !== undefined) return at;
  }
  const ra = parseRetryAfter(headerValue(headers, "retry-after"));
  if (ra !== undefined) return Date.now() + ra;
  return bodyResetAt(body) ?? bodyResetAt(detail);
}

/**
 * 未知错误连续预算(机制 #33)。键 = provider/model(调用方拼)。
 * 规则:kind === "unknown" 时 +1;其它任何分类(含 cancelled)清零——用户取消或确定性失败
 * 不应延长「未知错误」的连续计数。
 */
export class UnknownErrorBudget {
  private readonly counts = new Map<string, number>();
  constructor(readonly limit: number = UNKNOWN_ERROR_STOP_COUNT) {}

  record(key: string, kind: ModelErrorKind): { count: number; stop: boolean } {
    if (kind !== "unknown") {
      this.counts.delete(key);
      return { count: 0, stop: false };
    }
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return { count, stop: count >= this.limit };
  }

  countOf(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  reset(key?: string): void {
    if (key === undefined) this.counts.clear();
    else this.counts.delete(key);
  }
}

/** 错误 message 组装:`LLM <status>: <detail> | <action>`(无 status 时 `LLM 调用失败: …`)。 */
export function modelErrorMessage(decision: ModelErrorDecision, status?: number, detail?: string): string {
  const d = (detail ?? decision.detail).slice(0, DETAIL_MAX);
  const head = status !== undefined ? `LLM ${status}${d ? `: ${d}` : ""}` : `LLM 调用失败${d ? `: ${d}` : ""}`;
  const extra = decision.kind === "quota" && decision.resetAt !== undefined ? `(resetAt=${new Date(decision.resetAt).toISOString()})` : "";
  return `${head} | ${decision.action}${extra}`;
}

/** 可抛出的分类错误(机器可路由字段齐全;重试决策在抛出之前已做完)。 */
export class ModelRequestError extends Error {
  readonly kind: ModelErrorKind;
  readonly retryable: boolean;
  readonly stop: boolean;
  readonly retryAfterMs?: number;
  readonly resetAt?: number;
  readonly action: string;
  readonly status?: number;
  readonly detail: string;

  constructor(decision: ModelErrorDecision, opts: { status?: number; detail?: string; cause?: unknown; message?: string } = {}) {
    super(opts.message ?? modelErrorMessage(decision, opts.status, opts.detail), opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ModelRequestError";
    this.kind = decision.kind;
    this.retryable = decision.retryable;
    this.stop = decision.stop;
    this.retryAfterMs = decision.retryAfterMs;
    this.resetAt = decision.resetAt;
    this.action = decision.action;
    this.status = opts.status;
    this.detail = (opts.detail ?? decision.detail).slice(0, DETAIL_MAX);
  }
}
