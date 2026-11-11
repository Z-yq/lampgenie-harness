/**
 * 错误→请求自修复(纯逻辑:零 IO、无状态、确定性、不可变)。
 * 要治的病:模型请求错误此前只有「分类 → 停/重试」两档——invalid_request(400/422)一类
 * 往往只是请求多带了字段(reasoning / max_tokens 越界 / 端点不认的参数),却直接终态失败。
 * 本模块给出三件事:
 * 1) repairPlan:reason → 一次性动作计划。REPAIR_TABLE 是封闭表(9 个 reason / 固定动作集合),
 * 只有 invalid_request 的动作是「请求改写」;context_exceeded 只上报(provider 层不压缩,
 * 交 loop 处理);transient/rate_limited 走既有退避重试;auth/quota 等永久错误无动作。
 * 2) applyRepair:对 {messages,tools,extra} 的浅拷贝执行改写,返回全新对象(绝不改入参)。
 * 改写集合是白名单:剥 assistant.reasoning / extra.reasoningEffort、夹 maxTokens、
 * 丢 extra 里的 response_format/parallel_tool_calls/logprobs——只删这三个键,不猜其它键。
 * 3) detectFake200:HTTP 200 但 body 是 error / 无 choices 的「伪 200」识别(网关/代理层故障
 * 常见形态),调用方据此按错误处理,不把空成功当作正常响应。
 * 为什么每个 reason 每个请求只修一次:
 * - applyRepair 的动作是确定性的——同一请求改写一次与改写两次得到逐字相同的 body;
 * - 改写后仍被拒绝说明错误不在这些可改写面上,再改只剩成本且会无限循环;
 * - 于是「同 reason 一次修复 + 第二次失败即终态」把可修复与不可修复在两次请求内分开,
 * 调用方用 attemptedRepairs(每次请求局部 Set)记住已试过的 reason。
 */

import { extractErrorCode } from "./model-error-policy";

/** 计划结果码(封闭五值)。 */
export const REPAIR_CODES = ["OK", "NOT_REPAIRABLE", "ALREADY_ATTEMPTED", "FAKE_200", "INVALID"] as const;
export type RepairCode = (typeof REPAIR_CODES)[number];

/** 修复动作(封闭集合)。 */
export type RepairAction =
  | "report-context-exceeded"
  | "strip-reasoning"
  | "clamp-max-tokens"
  | "drop-unsupported-params"
  | "retry-backoff"
  | "none";

/** 修复表覆盖的 reason(model-error-policy 的 ModelErrorKind 全集)。 */
export type RepairReason =
  | "context_exceeded"
  | "invalid_request"
  | "transient"
  | "rate_limited"
  | "auth"
  | "not_configured"
  | "model_unavailable"
  | "quota"
  | "cancelled";

const freezeActions = (actions: RepairAction[]): readonly RepairAction[] => Object.freeze(actions);

/**
 * reason → 动作表(封闭:9 个 reason,不允许表外键)。
 * provider 层只对含「请求改写动作」的 reason 真正应用;其它动作是语义标注。
 */
export const REPAIR_TABLE: Readonly<Record<RepairReason, readonly RepairAction[]>> = Object.freeze({
 // 上下文超限:provider 层没有压缩能力,只上报,压缩/裁剪交 loop 层。
  context_exceeded: freezeActions(["report-context-exceeded"]),
 // 唯一可请求改写的一类:剥 reasoning / 夹 max_tokens / 丢端点不认的参数。
  invalid_request: freezeActions(["strip-reasoning", "clamp-max-tokens", "drop-unsupported-params"]),
 // 既有退避重试语义(不是请求改写)。
  transient: freezeActions(["retry-backoff"]),
  rate_limited: freezeActions(["retry-backoff"]),
 // 永久错误:无动作。
  auth: freezeActions(["none"]),
  not_configured: freezeActions(["none"]),
  model_unavailable: freezeActions(["none"]),
  quota: freezeActions(["none"]),
  cancelled: freezeActions(["none"]),
});

/** max_tokens 夹取的上下限与缺省值。 */
export const MIN_MAX_TOKENS = 256;
export const MAX_MAX_TOKENS = 4096;
export const DEFAULT_MAX_TOKENS = 2048;

/** drop-unsupported-params 的白名单(只删这三个键,绝不猜其它键)。 */
export const DROP_UNSUPPORTED_KEYS = ["response_format", "parallel_tool_calls", "logprobs"] as const;
export type DropUnsupportedKey = (typeof DROP_UNSUPPORTED_KEYS)[number];

const APPLY_ACTIONS: ReadonlySet<RepairAction> = new Set<RepairAction>([
  "strip-reasoning",
  "clamp-max-tokens",
  "drop-unsupported-params",
]);

function isRepairReason(code: string): code is RepairReason {
  return Object.prototype.hasOwnProperty.call(REPAIR_TABLE, code);
}

function isRepairable(actions: readonly RepairAction[]): boolean {
  return actions.some((a) => APPLY_ACTIONS.has(a));
}

export interface RepairRequestFacts {
 /** 请求里是否存在 assistant.reasoning(显式 false 才过滤 strip-reasoning)。 */
  hasReasoning?: boolean;
 /** 当前请求级 max_tokens。 */
  maxTokens?: number;
 /** 请求体里存在的待丢参数键(显式空数组才过滤 drop-unsupported-params)。 */
  paramKeys?: string[];
}

export interface RepairPlanInput {
 /** classifyModelError 给出的 kind。 */
  code: string;
 /** 同 reason 已经试过的次数(调用方按请求维护);>0 → ALREADY_ATTEMPTED。 */
  attempt?: number;
  requestFacts?: RepairRequestFacts;
}

export interface RepairPlan {
  ok: boolean;
  code: RepairCode;
  actions: RepairAction[];
 /** `${code}:${attempt}`:调用方按「请求 + reason」去重时的稳定键。 */
  onceKey: string;
}

/** facts 显式给出时过滤无效动作;缺省(undefined)按表全量返回。 */
function filterActions(actions: readonly RepairAction[], facts: RepairRequestFacts | undefined): RepairAction[] {
  if (!facts) return [...actions];
  return actions.filter((a) => {
    if (a === "strip-reasoning") return facts.hasReasoning !== false;
    if (a === "drop-unsupported-params") return facts.paramKeys === undefined || facts.paramKeys.length > 0;
    return true;
  });
}

/**
 * reason → 一次性修复计划。
 * 顺序:表外 reason → INVALID;表内不可修 → NOT_REPAIRABLE;attempt>0 → ALREADY_ATTEMPTED;否则 OK。
 * 不抛异常、不读写外部状态。
 */
export function repairPlan(input: RepairPlanInput): RepairPlan {
  const code = typeof input?.code === "string" ? input.code : "";
  const attempt = input?.attempt ?? 0;
  if (!Number.isInteger(attempt) || attempt < 0) return { ok: false, code: "INVALID", actions: [], onceKey: "" };
  const onceKey = `${code}:${attempt}`;
  if (!isRepairReason(code)) return { ok: false, code: "INVALID", actions: [], onceKey };
  const tableActions = REPAIR_TABLE[code];
  if (!isRepairable(tableActions)) {
    return { ok: false, code: "NOT_REPAIRABLE", actions: [...tableActions], onceKey };
  }
  if (attempt > 0) return { ok: false, code: "ALREADY_ATTEMPTED", actions: [], onceKey };
  const actions = filterActions(tableActions, input.requestFacts);
  if (actions.length === 0) return { ok: false, code: "NOT_REPAIRABLE", actions: [], onceKey };
  return { ok: true, code: "OK", actions, onceKey };
}

/** 请求侧最小形态(不依赖 loop 的类型;调用方传自己的 messages/tools/extra 副本)。 */
export interface RepairMessage {
  role?: string;
  reasoning?: unknown;
  [key: string]: unknown;
}

export interface RepairRequestInput {
  messages: readonly RepairMessage[];
  tools?: readonly unknown[];
  extra?: Record<string, unknown>;
}

export interface RepairRequestState {
  messages: RepairMessage[];
  tools: unknown[];
  extra: Record<string, unknown>;
}

const clampMaxTokens = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(value)));
};

/**
 * 执行修复动作,返回**全新**请求对象与真实执行的动作列表(白名单外的动作字符串忽略)。
 * 入参(readonly)永不被修改;同一输入 + 同一动作 → 逐字相同输出(确定性)。
 */
export function applyRepair(
  request: RepairRequestInput,
  actions: readonly string[],
): { request: RepairRequestState; applied: RepairAction[] } {
  const messages: RepairMessage[] = Array.isArray(request.messages)
    ? request.messages.map((m) => ({ ...(m as Record<string, unknown>) }))
    : [];
  const extra: Record<string, unknown> = { ...(request.extra ?? {}) };
  const tools: unknown[] = Array.isArray(request.tools) ? [...request.tools] : [];
  const applied: RepairAction[] = [];
  const seen = new Set<string>();

  for (const raw of Array.isArray(actions) ? actions : []) {
    if (typeof raw !== "string" || seen.has(raw)) continue;
    seen.add(raw);
    if (raw === "strip-reasoning") {
      for (const m of messages) {
        if (m.role === "assistant") delete m.reasoning;
      }
      delete extra.reasoningEffort;
      applied.push("strip-reasoning");
    } else if (raw === "clamp-max-tokens") {
      const current = typeof extra.maxTokens === "number" && Number.isFinite(extra.maxTokens) ? extra.maxTokens : undefined;
      extra.maxTokens = clampMaxTokens(current);
      applied.push("clamp-max-tokens");
    } else if (raw === "drop-unsupported-params") {
      for (const key of DROP_UNSUPPORTED_KEYS) delete extra[key];
      applied.push("drop-unsupported-params");
    }
 // report-context-exceeded / retry-backoff / none 不是请求改写动作,不落到 applied。
  }
  return { request: { messages, tools, extra }, applied };
}

// =============================================================================
// Provider 请求体修复(M122b:anthropic Messages / OpenAI Responses 的非流式入口)
// =============================================================================
/**
 * chat/completions 走 applyRepair(messages/extra 形态);anthropic 与 responses 的请求体
 * 是各自协议的 JSON(wire 形态),无法复用上面的 RepairRequestState,故单列一个按 provider
 * 白名单改写的纯函数:只碰「多带/越界」的少数顶层字段,绝不改 messages/tools 内容。
 */

/** provider 请求体的修复口径(封闭两值)。 */
export type ProviderRepairKind = "anthropic" | "responses";

export interface ProviderBodyRepair {
 /** 改写后的**新**对象(浅拷贝);非对象/未知 provider 原样返回。 */
  body: unknown;
 /** 真实改写过的字段名(空数组=无可改)。 */
  applied: string[];
}

/** Anthropic metadata 的协议内已知键:只含其余(未知)键时整个 metadata 视为多带参数。
 * user_id 是协议内唯一常用键,删它可能改变服务端去重/审计语义,故保留。 */
const ANTHROPIC_KNOWN_METADATA_KEYS: readonly string[] = ["user_id"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 夹取 token 预算:>4096→4096、<256→256;非数字/NaN 不动(返回 undefined)。 */
function clampTokenBudget(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(value)));
}

/**
 * 按 provider 请求体做**受限**改写,返回新对象与真实改写的字段名。
 * - anthropic:max_tokens 夹到 [256,4096];删 thinking;删「只含未知键」的 metadata。
 * - responses:max_output_tokens 同上夹取;删 reasoning。**不删 truncation**(删它会改响应完整性语义)。
 * 不认识的 body / 非对象 → 原样返回 applied=[];不 throw;入参永不被修改(浅拷贝)。
 */
export function repairProviderBody(body: unknown, provider: ProviderRepairKind): ProviderBodyRepair {
  if (!isPlainObject(body)) return { body, applied: [] };
  const next: Record<string, unknown> = { ...body };
  const applied: string[] = [];
  if (provider === "anthropic") {
    const clamped = clampTokenBudget(next.max_tokens);
    if (clamped !== undefined && clamped !== next.max_tokens) {
      next.max_tokens = clamped;
      applied.push("max_tokens");
    }
    if ("thinking" in next) {
      delete next.thinking;
      applied.push("thinking");
    }
    const metadata = next.metadata;
    if (isPlainObject(metadata) && Object.keys(metadata).every((k) => !ANTHROPIC_KNOWN_METADATA_KEYS.includes(k))) {
      delete next.metadata;
      applied.push("metadata");
    }
  } else if (provider === "responses") {
    const clamped = clampTokenBudget(next.max_output_tokens);
    if (clamped !== undefined && clamped !== next.max_output_tokens) {
      next.max_output_tokens = clamped;
      applied.push("max_output_tokens");
    }
    if ("reasoning" in next) {
      delete next.reasoning;
      applied.push("reasoning");
    }
  }
  return { body: next, applied };
}

export interface Fake200Verdict {
  fake: boolean;
 /** 机器可路由码:error.code → error.type → "fake-200"。 */
  code?: string;
}

/** 伪 200 的错误关键词(无 choices/output/content 时才据此判伪)。 */
const ERROR_KEYWORD_RE = /\b(error|errors|failed|failure|invalid|denied|unauthorized|forbidden)\b|错误|失败|异常/i;

/**
 * 识别「伪 200」:HTTP 状态 200,但 body 是错误信封(顶层 error 对象),
 * 或既无 choices / output / content 又含 error 关键词。
 * 非 200 一律 fake=false(交给 classifyModelError 按状态码分类)。
 */
export function detectFake200(status: number, bodyText: string): Fake200Verdict {
  if (status !== 200) return { fake: false };
  const text = typeof bodyText === "string" ? bodyText.trim() : "";
  if (!text) return { fake: false };
  let parsed: unknown;
  let isJson = true;
  try {
    parsed = JSON.parse(text);
  } catch {
    isJson = false;
  }
  if (isJson) {
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const err = obj.error;
      if (err && typeof err === "object") {
        return { fake: true, code: extractErrorCode(text) ?? "fake-200" };
      }
      const hasChoices = Array.isArray(obj.choices) && obj.choices.length > 0;
      const hasOutput = obj.output !== undefined && obj.output !== null && !(Array.isArray(obj.output) && obj.output.length === 0);
      const hasContent = typeof obj.content === "string" && obj.content.length > 0;
      if (!hasChoices && !hasOutput && !hasContent && ERROR_KEYWORD_RE.test(text)) {
        return { fake: true, code: extractErrorCode(text) ?? "fake-200" };
      }
      return { fake: false };
    }
    return { fake: false };
  }
 // 非 JSON 文本:没有 choices 可言,只在带错误关键词时判伪(如代理返回 "upstream error" 纯文本)。
  return ERROR_KEYWORD_RE.test(text) ? { fake: true, code: "fake-200" } : { fake: false };
}

/** 伪 200 是否应按错误处理(调用方统一入口,避免各处判 fake 字段)。 */
export function shouldTreatAsError(fake: Fake200Verdict | boolean): boolean {
  return typeof fake === "boolean" ? fake : fake.fake === true;
}
