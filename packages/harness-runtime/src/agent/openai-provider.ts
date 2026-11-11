/**
 * OpenAI 兼容 LLM provider(coding 轨)。
 * 凭证从 keyRef 解析(引用名,值不过日志)。
 */

/** 请求体诊断 dump(排查「工具未配置」观测;默认关):GENIE_LLM_DUMP_DIR 在场时
 * 把每次 chat 的 OpenAI 请求体落 <dir>/<序号>-<模型名>.json(只含 body;headers 带 apiKey 永不落盘,
 * 请求体本身无凭证字段)。排查面开关,非业务逻辑;目录不可写=静默跳过(dump 失败不影响主链)。
 * export:apiType 协议适配器(provider-apitypes.ts)同享诊断出口。 */
export function dumpRequestBody(model: string, body: Record<string, unknown>): void {
  const dir = process.env.GENIE_LLM_DUMP_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const seqHolder = dumpRequestBody as { seq?: number };
    seqHolder.seq = (seqHolder.seq ?? 0) + 1;
    const tools = Array.isArray(body.tools) ? (body.tools as { function?: { name?: string } }[]).map((t) => t.function?.name ?? "?") : null;
    const summary = {
      model,
      messageCount: Array.isArray(body.messages) ? (body.messages as unknown[]).length : 0,
      toolCount: tools?.length ?? 0,
      tools,
    };
    writeFileSync(
      join(dir, `${String(seqHolder.seq!).padStart(3, "0")}-${model.replace(/[^a-z0-9._-]/gi, "_")}.json`),
      JSON.stringify({ summary, body }, null, 2),
      "utf-8",
    );
  } catch {
    // dump 失败不影响主链
  }
}
import { classifyModelError, ModelRequestError, UnknownErrorBudget, type ModelErrorDecision } from "./model-error-policy";
import {
  applyRepair,
  detectFake200,
  repairPlan,
  shouldTreatAsError,
  DROP_UNSUPPORTED_KEYS,
  type RepairMessage,
} from "./error-repair";
import type { LlmChatOptions, LlmProvider, LlmResponse, Message, ToolSpec } from "../agent/loop";
import type { RequestAdmission, AdmissionTicket, ModelLifecycleEvent } from "../concurrency/admission";
import { anthropicChat, responsesChat } from "./provider-apitypes";
import { pcm16B64ToWavDataUrl } from "./audio-wav";
import { modelFamilyOf, normalizeToolsForProvider } from "./provider-schema";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
 /** 接口协议分派(ZCode provider api.type 对齐):缺省/chat=OpenAI
   * chat/completions(现状路径,wire 逐字节不变);anthropic=Anthropic Messages
   * /v1/messages(x-api-key 头+系统分离+内容块流式);responses=OpenAI Responses
   * POST /v1/responses(input 数组+function_call 形态)。协议适配在 provider-apitypes.ts。 */
  apiType?: "chat" | "responses" | "anthropic";
 /** 模型族路由标识(api.id,如 openai-gpt):构造期固定,update 不改。
 * 只用于请求体层的族判定(工具名/schema 归一/风格提示),不上 wire。缺省=按 model 判族。 */
  apiId?: string;
  /** 请求超时。 */
  timeoutMs?: number;
  /** 请求级 max_tokens;缺省=端点默认。 */
  maxTokens?: number;
 /** 思考力度:low/medium/high;未设不发送该参数(端点默认,多为关)。 */
  reasoningEffort?: string;
 /** 429/502/503/504 自动重试次数(二期;缺省 2,0=关)。
   * Retry-After 头优先(封顶 15s),否则指数退避(0.5s 起,封顶 8s)。 */
  retry?: number;
 /** 模型请求准入(二期):注入协调器 passthrough 准入时,每次尝试
   * 取票(计入在飞)、状态经票据喂 AIMD(429→throttled 降 cap),finally release。
   * 缺省=不设闸(行为与旧版一致)。 */
  admission?: RequestAdmission;
  /** 网络状态旁路观察(不参与 AIMD;调试/水位展示用)。 */
  onNetworkStatus?: (e: ModelLifecycleEvent) => void;
}

/** 把我们的 Message 翻译成 OpenAI chat.completions 格式。 */
/** usage 提取(兼容 OpenAI(prompt_tokens_details.cached_tokens)/DeepSeek(prompt_cache_hit_tokens)/realtime(input_tokens+input_token_details) 三形态) */
export function extractUsage(u: Record<string, unknown> | undefined | null): LlmResponse["usage"] | undefined {
  if (!u || typeof u !== "object") return undefined;
  const details = (u.prompt_tokens_details ?? u.input_token_details ?? {}) as { cached_tokens?: number };
  const cached = Number(details.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0) || 0;
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const output = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  if (!input && !output) return undefined;
  const total = u.total_tokens !== undefined ? Number(u.total_tokens) : input + output;
  return { inputTokens: input, outputTokens: output, totalTokens: total, ...(cached > 0 ? { cachedTokens: cached } : {}) };
}

/** 清洗孤立 UTF-16 代理码元(替换为 U+FFFD)。孤立代理经 JSON.stringify 变成 \ud83c 形态转义后,
 * 上游 serde_json 系解析器(DeepSeek/OpenAI)在高位代理后找 \uXXXX 低位代理落空即 400
 * "unexpected end of hex escape"(注意:grep 行截断切在 🎙 代理对中间)。
 * 这是 provider 出口的最后防线——任何工具层截断/拼接 bug 产生的孤立代理都在此拦下。
 * 快路径:文本不含任何代理码元时原样返回,零开销。 */
export function sanitizeLoneSurrogates(s: string): string {
  if (!/[\uD800-\uDFFF]/.test(s)) return s;
  let out = "";
  let seg = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { i++; continue; }
    if (c >= 0xd800 && c <= 0xdfff) { out += s.slice(seg, i) + "\uFFFD"; seg = i + 1; }
  }
  return out + s.slice(seg);
}

function toOpenAi(messages: Message[], tools: ToolSpec[], ctx: { apiId?: string; model?: string } = {}) {
 // 模型族适配:改的只是请求体这一层的 tools 副本(注册表本体不动,见 provider-schema.ts 头注)。
 // 未知族(generic:apiId 与 model 都判不出)时零变化 —— 猜错归一语义的代价高于原样透传。
  const family = modelFamilyOf(ctx.apiId ?? ctx.model);
  const providerTools = family === "generic" ? [...tools] : normalizeToolsForProvider(tools, ctx);
  return {
    model: undefined as unknown as string, // 由调用处填
    max_tokens: undefined as unknown as number, // 请求级上限,由调用处填(缺省=端点默认)
    messages: messages.map((m) => {
      if (m.role === "tool") {
        return { role: "tool", tool_call_id: m.toolCallId, content: sanitizeLoneSurrogates(m.content) };
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "assistant",
          content: (m.content && sanitizeLoneSurrogates(m.content)) || null,
 // thinking 模式续跑必须回传 reasoning_content,否则端点 400。
          // 只在实际有值时才带字段:空串会撞「不支持该字段」的思考关闭模型/未知字段校验。
          ...(m.reasoning && sanitizeLoneSurrogates(m.reasoning) ? { reasoning_content: sanitizeLoneSurrogates(m.reasoning) } : {}),
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: sanitizeLoneSurrogates(c.arguments) },
          })),
        };
      }
 // 多模态:user 消息带 images(data URL 数组)→ OpenAI content 数组(text+image_url)。
 // 音频直入( omni-query 形态,qwen3.8-omni* 一次 query 口径):audio → input_audio
 // 内容件,pcm16 裸流自动包 WAV 容器(omni 接口实测验证:data URL + format:"wav")。
      if (m.role === "user" && ((m as { images?: string[] }).images?.length || (m as { audio?: unknown }).audio)) {
        const parts: Record<string, unknown>[] = [{ type: "text", text: sanitizeLoneSurrogates(m.content) }];
        for (const img of (m as { images?: string[] }).images?.slice(0, 4) ?? []) parts.push({ type: "image_url", image_url: { url: img } });
        const audio = (m as { audio?: { data: string; format?: "wav" | "mp3" | "pcm16"; rate?: number } }).audio;
        if (audio?.data) {
          const format = audio.format ?? "pcm16";
          parts.push(format === "pcm16"
            ? { type: "input_audio", input_audio: { data: pcm16B64ToWavDataUrl(audio.data, audio.rate ?? 16_000), format: "wav" } }
            : { type: "input_audio", input_audio: { data: `data:audio/${format};base64,${audio.data}`, format } });
        }
        return { role: "user", content: parts };
      }
      if (m.role === "assistant" && m.reasoning) {
        // thinking 模式历史回传(同 toolCalls 分支):无 reasoning 的 assistant 不带该字段。
        return { role: "assistant", content: sanitizeLoneSurrogates(m.content), reasoning_content: m.reasoning };
      }
      return { role: m.role, content: sanitizeLoneSurrogates(m.content) };
    }),
    ...(providerTools.length > 0
      ? {
          tools: providerTools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
  };
}

type ChatJson = {
  choices: { finish_reason?: string | null; message: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

/** OpenAI finish_reason → LlmResponse.finishReason()。未知/缺失一律 undefined(不触发任何行为)。 */
export function mapOpenAiFinishReason(raw: unknown): LlmResponse["finishReason"] {
  if (typeof raw !== "string") return undefined;
  switch (raw) {
    case "stop": return "stop";
    case "length": return "length";
    case "tool_calls":
    case "function_call": // 旧版 function calling 口径
      return "tool_calls";
    case "content_filter": return "content_filter";
    case "": return undefined;
    default: return "other";
  }
}

/** 未知错误预算的模块级缺省实例(调用方未注入实例时共用;键按 budgetKey 分开)。 */
const defaultUnknownBudget = new UnknownErrorBudget();

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")); }, { once: true });
});

/** 网络状态旁路(缺省 no-op)。 */
type StatusEmit = (e: ModelLifecycleEvent) => void;

/** fetch 错误摘要:Node 只给 "TypeError: fetch failed",真正原因在 err.cause
 * (ConnectTimeoutError/ECONNRESET/ENOTFOUND…)。拼进 message,面板/子代理结果才可诊断。 */
export function describeFetchError(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  const base = e?.message ? String(e.message) : String(err);
  const c = e?.cause;
  const cause = c ? [c.code, c.message].filter((x) => typeof x === "string" && x).join(": ") : "";
  return cause && !base.includes(cause) ? `${base} (${cause})` : base;
}

/** 指数退避 + ±25% 抖动:固定退避会让一批同时失败的请求在同一毫秒一起重试,
 * 撞上同一个拥塞窗口(经验证 10 路首调 8 路建连超时)。抖动把重试摊开。 */
function backoffWithJitter(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 8_000);
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.max(100, Math.round(base * jitter));
}

/** 建连类错误(与普通网络抖动区分):端点对突发新建 TCP 连接敏感时,短退避的重试会
 * 连续撞在同一限流窗口里(经验证 10 路首调 8 路 ConnectTimeout,3 次尝试全失败)。 */
function isConnectError(err: unknown): boolean {
  const code = String((err as { cause?: { code?: string } })?.cause?.code ?? "");
  return /CONNECT_TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|UND_ERR/i.test(code);
}

/** 建连退避:起点更高、上限更长(2s→4s→8s→16s,±25% 抖动),给端点限流窗留出恢复时间。 */
function connectBackoffWithJitter(attempt: number): number {
  const base = Math.min(2000 * 2 ** attempt, 20_000);
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.max(500, Math.round(base * jitter));
}

/** 带重试的 POST(二期):429/5xx 按 Retry-After/指数退避重试;
 * 网络层异常(建连超时/连接重置)同样重试——建连类错误额外多给 2 次机会 + 更长退避。
 * 每次重试发 model_retry_scheduled(governor AIMD 的降 cap 信号源,此前零生产者)。
 * export:anthropic/responses 协议适配器(provider-apitypes.ts)复用同一
 * 重试/AIMD 语义,不复制漂移。 */
export interface PostRetryOptions {
  retry: number;
  signal: AbortSignal;
  emit: StatusEmit;
  /** 未知错误连续预算(provider 实例级注入);缺省模块级共享实例。 */
  budget?: UnknownErrorBudget;
  /** 预算键(provider/model)。 */
  budgetKey?: string;
 /** :可修复请求错误(invalid_request)的改写入口,由调用方注入。
 * 返回非空动作数组=已改写并应重发一次(不占既有 retry 预算);null=不修。 */
  repair?: (input: { decision: ModelErrorDecision; status?: number; attempt: number }) => string[] | null;
}

/** :请求修复生命周期事件({type:"model_repair", code, actions})。
 * 已登记进 admission.ts 的 ModelLifecycleEvent 联合(ModelRepairEvent),观测者按 event.type 消费。 */
function emitModelRepair(emit: StatusEmit, code: string, actions: readonly string[]): void {
  try {
    emit({ type: "model_repair", code, actions: [...actions], at: Date.now() });
  } catch {
 /* 观察者异常不影响主链 */
  }
}

/** 非 ok 响应体预览:clone 后读文本(不消费原响应体,调用方仍可 errorText/res.text())。 */
async function peekBody(res: Response): Promise<string> {
  try {
    return (await res.clone().text()).slice(0, 600);
  } catch {
    return "";
  }
}

export async function postWithRetry(
  post: () => Promise<Response>,
  opts: PostRetryOptions): Promise<Response> {
  const budget = opts.budget ?? defaultUnknownBudget;
  const budgetKey = opts.budgetKey ?? "default";
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await post();
    } catch (err) {
 // 网络层异常(非 HTTP 状态):按  分类决定重试/停止。
      const decision = classifyModelError({ err, signalAborted: opts.signal.aborted });
      const detail = describeFetchError(err);
      // 取消直抛(上游 abort / AbortError)。
      if (decision.kind === "cancelled") throw err;
      if (decision.kind === "transient") {
        const connect = isConnectError(err);
        const maxRetry = opts.retry + (connect ? 2 : 0);
        if (attempt >= maxRetry) {
          // 终败:把 cause 带进 message(旧实现只剩 "TypeError: fetch failed",无法定位)。
          throw new Error(`LLM 网络错误(已重试 ${attempt} 次${connect ? ",建连类" : ""}): ${detail}`, { cause: err instanceof Error ? err : undefined });
        }
        const delayMs = connect ? connectBackoffWithJitter(attempt) : backoffWithJitter(attempt);
        opts.emit({ type: "model_request_failed", code: "network_error", reason: detail.slice(0, 160), retryable: true, at: Date.now() });
        opts.emit({ type: "model_retry_scheduled", reason: connect ? "connect_error" : "network_error", delayMs, at: Date.now() });
        await sleep(delayMs, opts.signal);
        continue;
      }
      const rec = budget.record(budgetKey, decision.kind);
      if (decision.stop || rec.stop) throw new ModelRequestError({ ...decision, stop: true, retryable: false }, { detail, cause: err });
      if (attempt >= opts.retry) throw new ModelRequestError(decision, { detail, cause: err });
      const delayMs = Math.min(decision.retryAfterMs ?? backoffWithJitter(attempt), 15_000);
      opts.emit({ type: "model_request_failed", code: decision.kind, reason: detail.slice(0, 160), retryable: true, at: Date.now() });
      opts.emit({ type: "model_retry_scheduled", reason: decision.kind, delayMs, at: Date.now() });
      await sleep(delayMs, opts.signal);
      continue;
    }
    if (res.ok) {
      budget.reset(budgetKey); // 成功=进展,未知连续计数清零
      return res;
    }
    const raw = await peekBody(res);
    const decision = classifyModelError({ status: res.status, body: raw, headers: res.headers });
    const rec = budget.record(budgetKey, decision.kind);
    // 永久错误 / 未知预算耗尽:立即抛,不再按 RETRYABLE_STATUSES 盲重试。
    if (decision.stop || rec.stop) {
 // invalid_request(400/422)先做一次性请求改写并立即重发;不占既有 retry 预算。
 // 同一 reason 是否已修过由调用方的 attemptedRepairs(每次请求局部 Set)判定。
      if (decision.kind === "invalid_request" && opts.repair) {
        const actions = opts.repair({ decision, status: res.status, attempt });
        if (actions && actions.length > 0) {
          emitModelRepair(opts.emit, decision.kind, actions);
          attempt--; // 抵掉 for 的 ++:改写后的这次重发不消耗既有重试预算
          continue;
        }
      }
      const stopDecision: ModelErrorDecision = decision.stop ? decision : { ...decision, stop: true, retryable: false, action: `${decision.action}(连续 ${rec.count} 次)` };
      opts.emit({
        type: "model_request_failed",
        code: decision.kind,
        reason: `HTTP ${res.status}`,
        retryable: false,
        ...(decision.resetAt !== undefined ? { resetAt: decision.resetAt } : {}),
        at: Date.now(),
      });
      throw new ModelRequestError(stopDecision, { status: res.status });
    }
    if (attempt >= opts.retry) throw new ModelRequestError(decision, { status: res.status });
    const delayMs = Math.min(decision.retryAfterMs ?? backoffWithJitter(attempt), 15_000);
    // 事件码兼容(旧口径):429 → rate_limited、5xx → provider_overloaded;其它用 kind。
    const code = decision.kind === "rate_limited" ? "rate_limited" : res.status >= 500 ? "provider_overloaded" : decision.kind;
    opts.emit({ type: "model_request_failed", code, reason: `HTTP ${res.status}`, retryable: true, retryAfterMs: delayMs, at: Date.now() });
    opts.emit({ type: "model_retry_scheduled", reason: code === "rate_limited" ? "rate_limited" : "provider_overloaded", delayMs, retryAfterMs: delayMs, at: Date.now() });
    await sleep(delayMs, opts.signal);
  }
}

/** 准入票据生命周期:admission 注入时取票→started→(成功 completed|终败 failed)→release。 */
async function withAdmission<T>(
  admission: RequestAdmission | undefined,
  modelId: string,
  signal: AbortSignal,
  emit: StatusEmit,
  fn: (ticket: AdmissionTicket | undefined) => Promise<T>,
): Promise<T> {
  if (!admission) return fn(undefined);
  const ticket = await admission.take({ model: { providerId: "openai-compat", modelId }, signal });
  ticket.emit({ type: "model_request_started", at: Date.now() });
  emit({ type: "model_request_started", at: Date.now() });
  try {
    const out = await fn(ticket);
    ticket.emit({ type: "model_request_completed", at: Date.now() });
    emit({ type: "model_request_completed", at: Date.now() });
    return out;
  } catch (err) {
    ticket.emit({ type: "model_request_failed", code: "request_failed", reason: String(err).slice(0, 120), retryable: false, at: Date.now() });
    emit({ type: "model_request_failed", code: "request_failed", reason: String(err).slice(0, 120), retryable: false, at: Date.now() });
    throw err;
  } finally {
    ticket.release();
  }
}

/** 流空闲超时守卫:语义=任意 SSE chunk 到达即重置计时,空闲窗超时才 abort
 * (原因 MODEL_STREAM_IDLE_TIMEOUT)。window = max(30s, cur.timeoutMs ?? 600s)——与 chat 流式
 * 分支(chatStreamed)同源,anthropic/responses 适配器共用同一实现,避免语义漂移。
 * 为什么不是整体墙钟:大上下文(1M 窗口全量历史)prefill 可达数分钟,墙钟会杀死健康慢流。 */
export const STREAM_IDLE_FLOOR_MS = 30_000;
export const STREAM_IDLE_DEFAULT_MS = 600_000;
export const STREAM_IDLE_TIMEOUT_REASON = "MODEL_STREAM_IDLE_TIMEOUT";
export function createStreamIdleGuard(timeoutMs: number | undefined, abort: (reason?: unknown) => void) {
  const idleMs = Math.max(STREAM_IDLE_FLOOR_MS, timeoutMs ?? STREAM_IDLE_DEFAULT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => abort(new Error(STREAM_IDLE_TIMEOUT_REASON)), idleMs);
  };
  const dispose = () => { if (timer) { clearTimeout(timer); timer = undefined; } };
  return { idleMs, arm, dispose };
}

/**
 * chat 端点归一(fix S137-1:桌面预设写入的 baseUrl 常自带 /v1)。
 * 旧实现无条件拼 `/v1/chat/completions`,遇到 `…/compatible-mode/v1` 这种 baseUrl 会拼成
 * `/v1/v1/chat/completions` → 端点 404,任务全部失败(实机复现:阿里云百炼 compatible-mode/v1)。
 * 归一规则与 provider-apitypes.versionedUrl 同构:剥尾斜杠与尾 /v1 再拼协议路径,
 * 因此「带 /v1」「不带 /v1」「带尾斜杠」三形态都命中。
 */
export function chatCompletionsUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/chat/completions";
}

/** 流中途错误(SSE data 里带 error 对象,如 "Inference engine abort. Finish reason: [UNKNOWN]")。
 * 注意:服务端推理引擎瞬时 abort,HTTP 层是 200(postWithRetry 重试不到),
 * 旧实现直接 throw → 整个任务 task.fail。这类错误与 5xx 同类(服务端过载/抖动),应当重试。 */
class StreamMidFlightError extends Error {}
/** 流式重试上下文:重试/预算之外, 追加同源修复入口(与非流式 postWithRetry 同一套机制)。
 * body 用 getter:修复改写会重建请求体,重发必须取最新体(不能是调用时的快照)。 */
interface StreamRetryCtx {
  retry: number;
  emit: StatusEmit;
  budget?: UnknownErrorBudget;
  budgetKey?: string;
 /** :invalid_request 的一次性改写入口(absent=不修复,如 anthropic/responses 适配器)。 */
  repair?: PostRetryOptions["repair"];
 /** :本次请求是否已执行过改写(第二次失败时据此注明「修复后仍失败」)。 */
  repairAttempted?: () => boolean;
}

/** 流中断重试(区分于 HTTP 状态码重试):mid-flight SSE 错误/断流最多 N 次,指数退避。
 * onDelta 已发过增量的场合,重试会重复发增量(面板打字机可能有轻微回跳,终稿以聚合结果为准)。 */
async function chatStreamedWithRetry(
  cur: { baseUrl: string; apiKey: string; timeoutMs?: number },
  body: () => Record<string, unknown>,
  signal: AbortSignal,
  onDelta: (d: { text?: string; reasoning?: string }) => void,
  retryCtx: StreamRetryCtx,
  ctrl: { abort: (reason?: unknown) => void },
  opts: LlmChatOptions = {},
): Promise<LlmResponse> {
  // postWithRetry 同语义:retry=N = 原始 1 次 + 最多 N 次重试;封顶 4 次(mid-flight 错误抖动场景再多无益)。 */
  const attempts = Math.max(1, Math.min(retryCtx.retry + 1, 4));
 /** :每次流式 attempt 的独立 id——首个=调用方给的 base,重试=base#n。
   *  只有成功的那次会回填到 LlmResponse(→message.agent),被作废的半截 attempt 永不与已提交消息撞 id,
   *  冷恢复按 discarded 标记剔除时不会误删成功消息。 */
  const attemptIdOf = (attempt: number) =>
    opts.attemptId ? (attempt === 0 ? opts.attemptId : `${opts.attemptId}#${attempt}`) : undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
 // :半截累加器(content/reasoning/toolAcc)在 chatStreamed 内**每次 attempt 新建**——
    // 重试必然从空开始,不会把新增量接在失败 attempt 的尾巴后面。progress 只用于作废留痕的 partialChars。
    const progress = { chars: 0 };
    try {
      const res = await chatStreamed(cur, body, signal, onDelta, retryCtx, ctrl, progress);
      const id = attemptIdOf(attempt);
      return id ? { ...res, attemptId: id } : res;
    } catch (err) {
      lastErr = err;
      // HTTP 层已分类并抛出的错误(含永久错误/预算耗尽):原样上抛,不再重试。
      if (err instanceof ModelRequestError) {
 // 流式 invalid_request 已做过一次性请求改写还失败=改写面救不了,上抛并注明(不盲修)。
        if (err.kind === "invalid_request" && retryCtx.repairAttempted?.()) {
          const repaired: ModelErrorDecision = {
            kind: err.kind,
            retryable: false,
            stop: true,
            action: `${err.action}(修复后仍失败)`,
            detail: err.detail,
          };
          throw new ModelRequestError(repaired, {
            message: `${err.message} | 修复后仍失败(已做一次性请求改写)`,
            detail: err.detail,
            cause: err,
          });
        }
        throw err;
      }
      const midFlight = err instanceof StreamMidFlightError;
      const decision = classifyModelError({
        err,
        ...(signal.aborted ? { signalAborted: true } : {}),
        ...(err instanceof Error ? { body: err.message } : {}),
      });
      // 取消(外层 abort / 空闲超时 abort):直抛原错误,保留 MODEL_STREAM_IDLE_TIMEOUT 等原文供上游识别。
      if (decision.kind === "cancelled") throw err;
      const rec = retryCtx.budget?.record(retryCtx.budgetKey ?? "default", decision.kind) ?? { count: 0, stop: false };
      if (decision.stop || rec.stop) {
        const stopDecision: ModelErrorDecision = decision.stop ? decision : { ...decision, stop: true, retryable: false, action: `${decision.action}(连续 ${rec.count} 次)` };
        retryCtx.emit({ type: "model_request_failed", code: decision.kind, reason: String(err).slice(0, 120), retryable: false, at: Date.now() });
        throw new ModelRequestError(stopDecision, { detail: decision.detail, cause: err });
      }
      if (attempt === attempts - 1) break;
 // :将重试 → 先告知调用方「这次 attempt 已作废」(attemptId + 已吐出的半截字符数),再退避重开。
      // 回调异常吞掉:留痕失败只告警,绝不改变重试/恢复结果。
      const deadId = attemptIdOf(attempt);
      if (deadId) {
        try {
          opts.onAttemptDiscarded?.({
            attemptId: deadId,
            attempt,
            reason: `stream-attempt-failed: ${String(err instanceof Error ? err.message : err).slice(0, 160)}`,
            partialChars: progress.chars,
          });
        } catch { /* 观察者异常不影响重试 */ }
      }
      const delayMs = Math.min(decision.retryAfterMs ?? 500 * 2 ** attempt, 4_000);
      const code = midFlight ? "provider_overloaded" : decision.kind;
      retryCtx.emit({ type: "model_request_failed", code, reason: String(err).slice(0, 120), retryable: true, retryAfterMs: delayMs, at: Date.now() });
      retryCtx.emit({ type: "model_retry_scheduled", reason: code === "rate_limited" ? "rate_limited" : "provider_overloaded", delayMs, retryAfterMs: delayMs, at: Date.now() });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  const finalErr = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  if (attempts > 1) {
    // 重试预算耗尽:按原错误上抛,消息注明尝试次数(便于区分「一次就失败」与「重试后仍失败」)。
    const wrapped = new Error(`${finalErr.message}(流式尝试 ${attempts} 次均失败)`);
    (wrapped as Error & { cause?: unknown }).cause = finalErr;
    throw wrapped;
  }
  throw finalErr;
}

/** 流式 chat(SSE)聚合:content/reasoning/tool_calls/usage 与非流式同构;增量经 onDelta 透出。 */
async function chatStreamed(
  cur: { baseUrl: string; apiKey: string; timeoutMs?: number },
  body: () => Record<string, unknown>,
  signal: AbortSignal,
  onDelta: (d: { text?: string; reasoning?: string }) => void,
  retryCtx: StreamRetryCtx,
  ctrl: { abort: (reason?: unknown) => void },
  progress: { chars: number },
): Promise<LlmResponse> {
  const post = (payload: Record<string, unknown>) => fetch(chatCompletionsUrl(cur.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cur.apiKey}` },
    body: JSON.stringify(payload),
    signal,
  });
  const retryOpts: PostRetryOptions = {
    retry: retryCtx.retry,
    signal,
    emit: retryCtx.emit,
    ...(retryCtx.budget ? { budget: retryCtx.budget } : {}),
    ...(retryCtx.budgetKey ? { budgetKey: retryCtx.budgetKey } : {}),
 // 流式 fetch 的 400/422 invalid_request 走与非流式同一套一次性修复(postWithRetry 内改写后重发)。
    ...(retryCtx.repair ? { repair: retryCtx.repair } : {}),
  };
  let res: Response;
  try {
 // body 每次重发前现取:修复改写重建 body 后,postWithRetry 的这次重发必须用新体。
    res = await postWithRetry(() => post({ ...body(), stream: true, stream_options: { include_usage: true } }), retryOpts);
  } catch (err) {
    // 端点兼容:stream_options 不被支持(400 且报文点名)→ 去掉该参数重试一次。
    if (err instanceof ModelRequestError && err.kind === "invalid_request" && /stream_options/i.test(err.detail)) {
      res = await postWithRetry(() => post({ ...body(), stream: true }), retryOpts);
    } else throw err;
  }
  // 非 SSE 响应(个别网关忽略 stream 标志):按整包 JSON 解析,增量无从谈起,聚合结果照常返回。
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("event-stream")) {
 // 非 SSE 的整包 JSON 同样先识别伪 200(HTTP 200 但 body 是错误),按错误处理。
    const rawText = await res.text();
    const fake200 = detectFake200(res.status, rawText);
    if (shouldTreatAsError(fake200)) {
      const decision = classifyModelError({ status: res.status, body: rawText });
      retryCtx.emit({ type: "model_request_failed", code: fake200.code ?? decision.kind, reason: "fake-200", retryable: false, at: Date.now() });
      throw new ModelRequestError(
        { ...decision, stop: true, retryable: false, action: `${decision.action}(伪 200:响应体为错误)` },
        { status: res.status, detail: decision.detail },
      );
    }
    const data = JSON.parse(rawText) as ChatJson;
    const msg = data.choices[0]?.message ?? {};
    const rs = msg.reasoning_content ?? msg.reasoning ?? undefined;
    const finish = mapOpenAiFinishReason(data.choices[0]?.finish_reason);
    return {
      content: msg.content ?? "",
      ...(rs ? { reasoning: rs } : {}),
      ...(finish ? { finishReason: finish } : {}),
      ...(msg.tool_calls?.length ? { toolCalls: msg.tool_calls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })) } : {}),
      ...(data.usage ? { usage: { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0, totalTokens: data.usage.total_tokens } } : {}),
    } satisfies LlmResponse;
  }
  // SSE 逐行解析:data: {...} / [DONE];usage 在末包(stream_options.include_usage)。
  let content = "";
  let reasoning = "";
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: LlmResponse["usage"];
  let finishReason: LlmResponse["finishReason"]; // 取最后一个非空 finish_reason(M28)
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const emit = (d: { text?: string; reasoning?: string }) => { try { onDelta(d); } catch { /* 回调异常不断流 */ } };
 // 用户用户反馈+对照 ZCode:超时语义从「整体墙钟」改为「流空闲超时」——大上下文(1M 窗口
  // 全量历史)的 prefill 可达数分钟,墙钟 abort 会杀死健康的慢流(observe3 AbortError 根因)。
  // ZCode:DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS=600s,重试每轮+30s。这里 timeoutMs 即空闲窗:
  // 首个 chunk 前与 chunk 间隔超窗才 abort;chunk 持续到达时永不超时。
  const idle = createStreamIdleGuard(cur.timeoutMs, ctrl.abort);
  idle.arm();
  try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    idle.arm(); // 收到任意网络 chunk=流活着,重置空闲窗
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let j: Record<string, unknown>;
      try { j = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
      const err = j.error as { message?: string } | undefined;
      if (err) throw new StreamMidFlightError(String(err.message ?? JSON.stringify(err)).slice(0, 200));
      const choices = j.choices as { finish_reason?: string | null; delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] | undefined;
      const fr = choices?.[0]?.finish_reason;
      if (typeof fr === "string" && fr) finishReason = mapOpenAiFinishReason(fr);
      const ch = choices?.[0]?.delta;
      if (ch) {
        const rs = ch.reasoning_content ?? ch.reasoning;
        if (typeof rs === "string" && rs) { reasoning += rs; progress.chars += rs.length; emit({ reasoning: rs }); }
        if (typeof ch.content === "string" && ch.content) { content += ch.content; progress.chars += ch.content.length; emit({ text: ch.content }); }
        if (Array.isArray(ch.tool_calls)) {
          for (const tc of ch.tool_calls) {
            const idx = Number(tc.index ?? 0);
            const acc = toolAcc.get(idx) ?? { id: "", name: "", arguments: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            toolAcc.set(idx, acc);
          }
        }
      }
      if (j.usage) usage = extractUsage(j.usage as Record<string, unknown>);
    }
  }
  } finally {
    idle.dispose();
  }
  const toolCalls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).filter((v) => v.name);
  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  } satisfies LlmResponse;
}

export function createOpenAiCompatProvider(opts: OpenAiCompatOptions): LlmProvider & { update(patch: Partial<OpenAiCompatOptions>): void; readonly modelName: string; describe(): Record<string, unknown> } {
  const cur = { ...opts };
 //  未知错误预算:实例级(provider 实例)= 一个 provider/model 组合的连续计数;
  // 热切换模型后键随 cur.model 变,旧键不污染新模型。与模块级缺省实例分开,避免多 provider 串扰。
  const unknownBudget = new UnknownErrorBudget();
  const budgetKey = () => `${cur.baseUrl}|${cur.model}`;
  return {
 /** 模型名读数(子代理目录):registry/面板展示用;getter=热更新(update)后读到新值。 */
    get modelName() { return cur.model; },
 /** 参数面读数(轨迹扩容):复现 wire 请求所需的全部端点/参数;apiKey 永不出。 */
    describe() {
      return {
        baseUrl: cur.baseUrl, apiType: cur.apiType ?? "chat", model: cur.model,
        apiId: cur.apiId,
        maxTokens: cur.maxTokens, reasoningEffort: cur.reasoningEffort, timeoutMs: cur.timeoutMs, retry: cur.retry,
      };
    },
    /** 热更新(cfg.set llm.model/llm.timeoutMs):改完下一个请求即用新值,无需重启。 */
    update(patch) {
      if (patch.model !== undefined) cur.model = patch.model;
      if (patch.baseUrl !== undefined) cur.baseUrl = patch.baseUrl;
      if (patch.apiKey !== undefined) cur.apiKey = patch.apiKey;
      if (patch.timeoutMs !== undefined) cur.timeoutMs = patch.timeoutMs;
      if (patch.maxTokens !== undefined) cur.maxTokens = patch.maxTokens;
      if (patch.reasoningEffort !== undefined) cur.reasoningEffort = patch.reasoningEffort || undefined;
      if (patch.retry !== undefined) cur.retry = patch.retry;
      if (patch.apiType !== undefined) cur.apiType = patch.apiType;
      if (patch.admission !== undefined) cur.admission = patch.admission;
      if (patch.onNetworkStatus !== undefined) cur.onNetworkStatus = patch.onNetworkStatus;
    },
    async chat(messages, tools, signal, onDelta, opts) {
      const controller = new AbortController();
 // 整体墙钟改 30 分钟宽松上限(流式空闲超时在每个流式分支内接管,语义=timeoutMs:
      // chatStreamed 与 anthropic/responses 适配器共用 createStreamIdleGuard)——大上下文 prefill 不再被墙钟误杀;
      // 仅非流式路径仍以 timeoutMs 原语义为实际超时窗。
      const timer = setTimeout(() => controller.abort(), Math.max(cur.timeoutMs ?? 60_000, 1_800_000));
 // 泄漏修复:外部 signal(任务级 AbortController,长生命周期)上的 abort listener
 // 每请求累积(MaxListenersExceededWarning 注意)——请求结束必须摘除。
      const onOuterAbort = () => controller.abort();
      if (signal) signal.addEventListener("abort", onOuterAbort);
      const retryCtx = { retry: cur.retry ?? 2, emit: (e: ModelLifecycleEvent) => { try { cur.onNetworkStatus?.(e); } catch { /* 观察者异常不影响主链 */ } } };
      try {
 // 准入+重试(二期):票据状态喂 AIMD;信号贯通(controller.signal)。
        return await withAdmission(cur.admission, cur.model, controller.signal, retryCtx.emit, async (ticket) => {
          const emit: StatusEmit = ticket ? (e) => { ticket.emit(e); retryCtx.emit(e); } : retryCtx.emit;
          const rctx = { retry: retryCtx.retry, emit, budget: unknownBudget, budgetKey: budgetKey() };
 // apiType 协议分派:anthropic/responses 走 provider-apitypes 适配层
          // (消息转换/凭证头/SSE 解析在适配器内消化,归一出口与本 provider chat 同构);
          // 缺省/chat 落回下方现有路径(wire 逐字节不变)。onDelta 在场即流式(两协议同语义)。
          if (cur.apiType === "anthropic") {
            return await anthropicChat(cur, messages, tools, controller.signal, onDelta, rctx);
          }
          if (cur.apiType === "responses") {
            return await responsesChat(cur, messages, tools, controller.signal, onDelta, rctx);
          }
 // 每次请求一套修复尝试集(局部),messages/tools/extra 用本次请求副本。
          const attemptedRepairs = new Set<string>();
          let reqMessages = messages as unknown as RepairMessage[];
          let reqTools = tools as unknown as readonly unknown[];
          const reqExtra: Record<string, unknown> = {};
          if (cur.reasoningEffort) reqExtra.reasoningEffort = cur.reasoningEffort;
          if (cur.maxTokens !== undefined && cur.maxTokens > 0) reqExtra.maxTokens = cur.maxTokens;
 // body 由 reqMessages/reqExtra 派生:repair 改写后重建即可(不触碰调用方入参)。
          const buildBody = (): Record<string, unknown> => {
            const b = toOpenAi(reqMessages as unknown as Message[], reqTools as unknown as ToolSpec[], { apiId: cur.apiId, model: cur.model }) as unknown as Record<string, unknown>;
            b.model = cur.model;
            const maxTokens = typeof reqExtra.maxTokens === "number" ? reqExtra.maxTokens : undefined;
            if (maxTokens !== undefined && maxTokens > 0) b.max_tokens = maxTokens;
 // 思考力度:OpenAI o 系/GLM reasoning_effort;空串=显式关(不发)。
            if (typeof reqExtra.reasoningEffort === "string" && reqExtra.reasoningEffort) b.reasoning_effort = reqExtra.reasoningEffort;
 // 白名单参数(repair 的 drop-unsupported-params 目标):只回填请求里真实存在的键。
            for (const key of DROP_UNSUPPORTED_KEYS) if (key in reqExtra) b[key] = reqExtra[key];
            return b;
          };
          let body = buildBody();
 // 请求体诊断 dump(GENIE_LLM_DUMP_DIR 门控,缺省零开销)。
          dumpRequestBody(cur.model, body);
 // invalid_request 的一次性请求改写(同 reason 每请求只修一次;第二次失败即终态)。
          const repairBody = (decision: ModelErrorDecision): string[] | null => {
            if (attemptedRepairs.has(decision.kind)) return null;
            const plan = repairPlan({
              code: decision.kind,
              attempt: 0,
              requestFacts: {
                hasReasoning: reqMessages.some((m) => m.role === "assistant" && typeof m.reasoning === "string" && m.reasoning.length > 0),
                ...(typeof reqExtra.maxTokens === "number" ? { maxTokens: reqExtra.maxTokens } : {}),
                paramKeys: DROP_UNSUPPORTED_KEYS.filter((k) => k in reqExtra),
              },
            });
            if (!plan.ok) return null;
            const repaired = applyRepair({ messages: reqMessages, tools: reqTools, extra: reqExtra }, plan.actions);
            if (repaired.applied.length === 0) return null;
            attemptedRepairs.add(decision.kind);
            reqMessages = repaired.request.messages;
            reqTools = repaired.request.tools;
            for (const key of Object.keys(reqExtra)) delete reqExtra[key];
            Object.assign(reqExtra, repaired.request.extra);
            body = buildBody();
            return repaired.applied;
          };
 // 流式分支(ZCode 流式消息展示):onDelta 在场才启用——压缩/评审/导读等
          // 内部调用保持非流式旧路径零风险;流式下增量经 onDelta 透出,聚合结果与非流式同构。
 // 流式路径接同一套一次性修复(与非流式共享本次请求的 attemptedRepairs;
 // body 以 getter 传入,修复重建后的新体才是重发体)。
          if (onDelta) {
            return await chatStreamedWithRetry(
              cur,
              () => body,
              controller.signal,
              onDelta,
              {
                ...rctx,
                repair: ({ decision }: { decision: ModelErrorDecision }) => repairBody(decision),
                repairAttempted: () => attemptedRepairs.size > 0,
              },
              controller,
              opts);
          }
          const res = await postWithRetry(() => fetch(chatCompletionsUrl(cur.baseUrl), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${cur.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          }), {
            retry: rctx.retry,
            signal: controller.signal,
            emit,
            budget: unknownBudget,
            budgetKey: rctx.budgetKey,
 // 仅 chat/completions 路径注入改写入口(anthropic/responses 适配器语义不动)。
            repair: ({ decision }: { decision: ModelErrorDecision }) => repairBody(decision),
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
          }
 // 解析前识别伪 200(HTTP 200 但 body 是错误信封/无 choices),按错误处理而非空成功。
          const rawText = await res.text();
          const fake200 = detectFake200(res.status, rawText);
          if (shouldTreatAsError(fake200)) {
            const decision = classifyModelError({ status: res.status, body: rawText });
            emit({ type: "model_request_failed", code: fake200.code ?? decision.kind, reason: "fake-200", retryable: false, at: Date.now() });
            throw new ModelRequestError(
              { ...decision, stop: true, retryable: false, action: `${decision.action}(伪 200:响应体为错误)` },
              { status: res.status, detail: decision.detail },
            );
          }
        const data = JSON.parse(rawText) as {
          choices: { finish_reason?: string | null; message: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
 /** OpenAI 兼容 usage(追踪:此前被丢弃);字段缺失按 0 并保留 total 原值。 */
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        const msg = data.choices[0]?.message ?? {};
        const reasoning = msg.reasoning_content ?? msg.reasoning ?? undefined;
        const finish = mapOpenAiFinishReason(data.choices[0]?.finish_reason);
        return {
          content: msg.content ?? "",
          ...(reasoning ? { reasoning } : {}),
          ...(finish ? { finishReason: finish } : {}),
          toolCalls: msg.tool_calls?.map((c) => ({
            id: c.id,
            name: c.function.name,
            arguments: c.function.arguments,
          })),
          usage: extractUsage((data as { usage?: Record<string, unknown> }).usage), // 拍板修复:原顶层展开使 usage 从未进 r.usage(smoke 验证非流式无 usage);嵌套契约与流式/两新协议一致
        } satisfies LlmResponse;
        });
      } finally {
        if (signal) signal.removeEventListener("abort", onOuterAbort);
        clearTimeout(timer);
      }
    },
  };
}
