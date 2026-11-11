/**
 * apiType 协议适配层:anthropic(Anthropic Messages /v1/messages)与
 * responses(OpenAI Responses POST /v1/responses)两个运行时分支。
 * chat 分支留在 openai-provider.ts 本体(逐字节不变);本模块只承载两种新协议的
 * 消息格式转换/请求组装/流式 SSE 解析/响应归一——归一出口与 chat 同构(LlmResponse:
 * content/toolCalls/usage/reasoning,onDelta 增量透出)。
 * 共享基础设施(postWithRetry 429/5xx 退避+AIMD、dumpRequestBody 诊断)从 openai-provider
 * 复用不复制——两协议与 chat 同享重试/准入语义。模块互 import:两侧均为 function 声明
 * (hoisted),ESM live binding 循环安全,加载序无关。
 * wire 形态对齐 opencode packages/llm/src/protocols/{anthropic-messages,openai-responses}.ts。
 */
import type { LlmDeltaChunk, LlmResponse, Message, ToolSpec } from "./loop";
import type { ModelLifecycleEvent } from "../concurrency/admission";
import type { UnknownErrorBudget } from "./model-error-policy";
import { dumpRequestBody, postWithRetry, createStreamIdleGuard, sanitizeLoneSurrogates } from "./openai-provider";
import { declaredPromptHints, normalizeToolsForProvider } from "./provider-schema";
import { repairProviderBody, type ProviderRepairKind } from "./error-repair";

/** 适配器运行参数(openai-provider.chat() 分派时从 cur 派生)。 */
export interface ApiTypeAdapterCur {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  reasoningEffort?: string;
 /** 流空闲窗(与 chat 流式分支同语义:timeoutMs 即空闲窗,下限 30s,缺省 600s。 */
  timeoutMs?: number;
 /** 模型族路由标识(api.id):由 provider 构造参数携带,只影响请求体副本(归一族判定/风格提示)。 */
  apiId?: string;
}

export type ApiTypeRetryCtx = { retry: number; emit: (e: ModelLifecycleEvent) => void; budget?: UnknownErrorBudget; budgetKey?: string };

/** SSE 逐行读取(data: 行 JSON 反序列化;event: 行与 [DONE] 哨兵忽略——anthropic/responses
 * 的 data 载荷自带 type 字段,无需 event: 行;非 JSON 行忽略不断流,与 chat SSE 解析同语义)。
 * 传入 signal/idle 时:任意 chunk 到达即重置空闲计时,空闲窗超窗经 ctrl.abort 打断本读取
 * (——适配器此前只有外层整体墙钟,大上下文 prefill 会被误杀;慢而活着的流不再被杀)。 */
async function* sseJson(res: Response, signal?: AbortSignal, idle?: { arm: () => void; dispose: () => void }): AsyncGenerator<Record<string, unknown>> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  // 流被 abort(=空闲超窗/外层取消)时,底层 reader 在部分实现下不立即 reject——靠 signal 竞速把 await
  // 打断,保证超窗能真正终止(否则 idle 计时器形同虚设)。signal 缺省=不竞速(旧行为)。
  let onAbort: (() => void) | null = null;
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    })
    : null;
  try {
    for (;;) {
      const { done, value } = await (abortPromise ? Promise.race([reader.read(), abortPromise]) : reader.read());
      if (done) break;
      if (idle) idle.arm(); // 收到任意网络 chunk=流活着,重置空闲窗
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
        yield j;
      }
    }
  } finally {
    if (idle) idle.dispose();
    if (signal && onAbort) signal.removeEventListener("abort", onAbort); // 防监听累积(同 adapterAbortLink 纪律)
    if (abortPromise) reader.cancel().catch(() => { /* 已释放/已关闭:尽力收尾 */ });
  }
}

/** baseUrl 归一:剥尾斜杠与尾 /v1 再拼协议路径——官方预设(https://api.anthropic.com/v1,
 * 带版本)与 Z.ai/智谱套餐(https://api.z.ai/api/anthropic,无版本;官方文档端点
 * =…/api/anthropic/v1/messages)两形态都命中。 */
function versionedUrl(baseUrl: string, path: "/v1/messages" | "/v1/responses"): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + path;
}

/** 适配器请求级中止链:外层 signal(任务级,长生命周期)→ 本地 controller。
 * 空闲超时经本地 controller.abort(Error("MODEL_STREAM_IDLE_TIMEOUT")) 触发——与 chat 流式分支
 * 同语义;本地 signal 同时喂 fetch 与 sseJson 的竞速,保证超窗能真正打断停滞流。dispose 必须摘除外层
 * 监听(防长生命周期 signal 上 listener 逐请求累积,同 openai-provider 的 MaxListenersExceededWarning 修复纪律)。 */
function adapterAbortLink(outer: AbortSignal) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(outer.reason);
  if (outer.aborted) onAbort();
  else outer.addEventListener("abort", onAbort, { once: true });
  return { ctrl, dispose: () => outer.removeEventListener("abort", onAbort) };
}

/** 非流式/流式共用错误正文归一:JSON 可解析时抽 error(anthropic 另拼 error.type 前缀、
 * responses 拼 error.code 前缀),否则原文前 200 字——出口形态与 chat 分支 `LLM <status>: …`
 * 前缀同构(上层调用方看到的错误形状不分协议)。 */
async function errorText(res: Response, style: "anthropic" | "openai"): Promise<string> {
  const raw = await res.text();
  try {
    const j = JSON.parse(raw) as { error?: { type?: string; code?: string; message?: string } };
    const e = j.error;
    if (e) {
      if (style === "anthropic" && e.type && e.message) return `${e.type}: ${e.message}`;
      if (style === "openai" && e.code && e.message) return `${e.code}: ${e.message}`;
      if (e.message) return e.message;
      if (e.code) return e.code;
      if (e.type) return e.type;
    }
  } catch { /* 非 JSON 原文透传 */ }
  return raw.slice(0, 200);
}

// =============================================================================
// Anthropic Messages(/v1/messages)
// =============================================================================
/** Anthropic 凭证头:x-api-key + anthropic-version(Anthropic SDK 形态;Z.ai/智谱
 * anthropic 兼容端点同形态)。不发 Authorization Bearer。 */
function anthropicHeaders(apiKey: string): Record<string, string> {
  return { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
}

/** data: URL → Anthropic base64 image source;http(s) → url source。 */
function anthropicImage(img: string): Record<string, unknown> {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(img);
  if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
  return { type: "image", source: { type: "url", url: img } };
}

/** 前缀缓存断点值(Anthropic cache_control):官方缺省 5 分钟 ephemeral 档——不用 ttl 扩展档
 * (ZCode opencode 的 1h 档是显式配置项,本适配器无该配置面,不猜)。 */
const CACHE_CONTROL_EPHEMERAL = { type: "ephemeral" } as const;

/** Anthropic prompt cache 单请求断点上限(官方口径 4)。超出**不是**降级警告而是端点 400,
 * 所以预算是硬上限:计划层保证永不超,打标层不再二次判断。 */
export const ANTHROPIC_CACHE_BREAKPOINT_LIMIT = 4;

/** 断点优先级表(固定序,不随请求形态/环境变化)。预算不够就按此序从后往前舍弃。
 * 为什么是 system > tools > messages-tail-2 > messages-tail-1:
 * ① system/tools 是跨请求逐字节稳定的静态前缀,断在这里命中率最高且不受消息增长影响;
 * ② 两条消息断点里「倒数第二条」优先于「末条」——追加式对话中倒数第二条是上一轮的增量末尾,
 * 下一次请求里它仍逐字节存在,断点立刻可复用;末条是本轮新写内容,只有下一轮继续追加才命中
 * (一问一答即结束的会话上属于只写不读)。预算不足时先舍弃末条。
 * 表里的 message 项按「尾随偏移」命名(1=末条,2=倒数第二条),真实下标由 messageCount 现算。 */
export const ANTHROPIC_CACHE_BREAKPOINT_PRIORITY = ["system", "tools", "messages-tail-2", "messages-tail-1"] as const;

export type CacheBreakpointKind = "tools" | "system" | "message";

export interface CacheBreakpointSlot {
  kind: CacheBreakpointKind;
 /** 仅 kind=message 有意义:目标消息在 Anthropic 请求体 messages 数组里的下标(0 基)。 */
  index?: number;
}

export interface CacheBreakpointSkip extends CacheBreakpointSlot {
 /** unavailable=该位置本身不存在(无 tools/无 system/消息数不足);
 * pre-marked=块已自带 cache_control,占配额但不新增打标;
 * budget-exhausted=配额(上限 4)已用尽。 */
  reason: "unavailable" | "pre-marked" | "budget-exhausted";
}

export interface CacheBreakpointPlan {
 /** 需要**新打标**的槽位(按优先级排序,长度 ≤ ANTHROPIC_CACHE_BREAKPOINT_LIMIT)。 */
  slots: CacheBreakpointSlot[];
 /** 本请求实际携带的断点总数 = slots.length + 被认领的 preMarked(恒 ≤ 上限)。 */
  used: number;
 /** 没进 slots 的候选:空位置、已有标记、或预算用尽——跳过也要记账,否则「为什么没打在这」无从排查。 */
  skipped: CacheBreakpointSkip[];
}

/**
 * 规划本请求的缓存断点(纯函数:无 IO、无随机、不读时钟、不修改入参;同输入必同输出)。
 * 断点语义(Anthropic prompt cache):断点标记「缓存到这里为止」,命中条件=该位置之前的全部
 * 字节与上次请求逐字节相同。因此断点必须跟着**前缀末尾**走,而不是跟着「最新内容」走:
 * 只追加尾部的请求里,tools/system/倒数第二条消息的位置不漂移,断点便能持续命中——
 * 「稳定切分」= 切点相对固定历史定位,而不是相对消息总长的偏移(那样每轮都整体位移,永不命中)。
 * 预算固定 ANTHROPIC_CACHE_BREAKPOINT_LIMIT(4),按 ANTHROPIC_CACHE_BREAKPOINT_PRIORITY 认领。
 * preMarked 是调用方声明「这些位置已经有 cache_control」:它们**占配额**,对应候选不再进 slots
 * (已带标记的块重复打标=白白浪费一个配额)。数组允许重复——同一 kind 出现多次=多处已有断点,
 * 按优先级逐个认领,认领不到的记 budget-exhausted。
 */
export function planCacheBreakpoints(input: {
  hasTools: boolean;
  hasSystem: boolean;
 /** Anthropic 请求体 messages 数组长度(system 已分离、tool 结果已合并后的条数)。 */
  messageCount: number;
  preMarked?: CacheBreakpointKind[];
}): CacheBreakpointPlan {
  const count = Number.isFinite(input.messageCount) ? Math.max(0, Math.floor(input.messageCount)) : 0;
 // 候选表 = 优先级表逐项实例化(次序即优先级,勿随意重排:硬预算是靠这个顺序取舍的)。
  const table: { slot: CacheBreakpointSlot; available: boolean }[] = [
    { slot: { kind: "system" }, available: input.hasSystem },
    { slot: { kind: "tools" }, available: input.hasTools },
    { slot: count >= 2 ? { kind: "message", index: count - 2 } : { kind: "message" }, available: count >= 2 },
    { slot: count >= 1 ? { kind: "message", index: count - 1 } : { kind: "message" }, available: count >= 1 },
  ];
  const budget = ANTHROPIC_CACHE_BREAKPOINT_LIMIT;
  const pending = new Map<CacheBreakpointKind, number>();
  for (const kind of input.preMarked ?? []) pending.set(kind, (pending.get(kind) ?? 0) + 1);
  const slots: CacheBreakpointSlot[] = [];
  const skipped: CacheBreakpointSkip[] = [];
  let used = 0;
  for (const { slot, available } of table) {
    if (!available) { skipped.push({ ...slot, reason: "unavailable" }); continue; }
    const claimed = pending.get(slot.kind) ?? 0;
    if (claimed > 0) {
      if (claimed === 1) pending.delete(slot.kind); else pending.set(slot.kind, claimed - 1);
 // 已有断点占配额但不新增槽位;配额已满说明调用方自己超限了,如实记账交给上层判断。
      if (used < budget) { used += 1; skipped.push({ ...slot, reason: "pre-marked" }); }
      else skipped.push({ ...slot, reason: "budget-exhausted" });
      continue;
    }
    if (used >= budget) { skipped.push({ ...slot, reason: "budget-exhausted" }); continue; }
    slots.push(slot);
    used += 1;
  }
 // 剩余 preMarked:候选表里没有对应位置(如无 tools 却声明 preMarked tools)→ 仍占配额。
  for (const [kind, n] of pending) {
    for (let i = 0; i < n; i++) {
      if (used < budget) { used += 1; skipped.push({ kind, reason: "pre-marked" }); }
      else skipped.push({ kind, reason: "budget-exhausted" });
    }
  }
  return { slots, used, skipped };
}

/** 给单个内容块打缓存断点(Anthropic prompt cache:命中率=前缀逐字节相同)。
 * 保持语义(ZCode anthropic-stream-compat 注释同款):块已自带 cache_control 时**保持原样**
 * 不覆盖(含 ttl 等扩展字段)、不重复打标——断点是配额(官方单请求上限 4,超即 400),
 * 重复=浪费一个配额。无块(undefined)=空态,原样返回 false。返回是否真打了标,便于调用层断言。 */
export function markCacheBreakpoint(block: Record<string, unknown> | undefined): boolean {
  if (!block || block.cache_control !== undefined) return false;
  block.cache_control = { ...CACHE_CONTROL_EPHEMERAL };
  return true;
}

/** Message[] → Anthropic 请求体:system 分离到顶层(blocks 形态);tool 结果归 user tool_result 块;
 * tools 用扁平 input_schema 形态;max_tokens 协议必填(未配置兜底 8192)。
 * 缓存断点按 planCacheBreakpoints 的预算计划落在「前缀末尾」(前缀序 tools → system → messages,
 * 断点即「缓存到这里为止」):① 最后一个 tool 定义(Anthropic 支持 tool 定义级 cache_control)
 * ② system 末块(=静态系统提示前缀末尾)③ 倒数第二条消息末块 ④ 末条消息末块,合计 ≤ 官方上限 4。
 * 稳定切分:断点跟随前缀末尾而非「最新内容」——只追加尾部消息时,tools/system/倒数第二条的
 * 位置与内容不漂移,缓存命中=该断点之前的前缀逐字节相同。 */
function toAnthropicBody(cur: ApiTypeAdapterCur, messages: Message[], tools: ToolSpec[], stream: boolean): Record<string, unknown> {
  messages = messages.map((m) => ({ ...m, content: sanitizeLoneSurrogates(m.content) })); // 孤立代理防线(见 sanitizeLoneSurrogates)
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).filter(Boolean).join("\n\n");
 // 模型族适配:只改 provider-facing copy(请求体这一层的副本),注册表本体逐字不动,
 // 理由见 provider-schema.ts 头注;apiId 由 provider 构造参数携带(缺省=按 model 判族)。
  const normCtx = { apiId: cur.apiId, model: cur.model };
  const providerTools = normalizeToolsForProvider(tools, normCtx);
  const hints = declaredPromptHints(normCtx);
  const systemText = system && hints ? `${system}\n\n${hints}` : system; // 无 system 时不强造
  const out: Record<string, unknown>[] = [];
  /** 上一条源消息是否 tool(=同一 assistant 那批调用的一部分;用于把 tool_result 合并进同一条 user)。 */
  let lastWasTool = false;
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      const blocks: Record<string, unknown>[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const img of (m as { images?: string[] }).images?.slice(0, 4) ?? []) blocks.push(anthropicImage(img));
      out.push({ role: "user", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
      continue;
    }
    if (m.role === "assistant") {
      const blocks: Record<string, unknown>[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        let input: unknown;
        try { input = JSON.parse(c.arguments); } catch { input = {}; }
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
      continue;
    }
    // tool 结果:Anthropic 无 tool 角色 → user 消息 tool_result 块。
    // **必须合并**:同一 assistant 的多个 tool_use,其 tool_result 要出现在**紧随其后的一条**
    // user 消息里(可含多个块)。旧的「每条 push 一条 user」会产出一条只含部分结果的 user,
    // 严格端点直接 400:`tool_use ids were found without tool_result blocks immediately after`
 // ( deepseek-flash 经验证;bigmodel GLM 宽容未报,但协议上一直是错的)。
    if (m.role === "tool") {
      const lastUser = out[out.length - 1];
      const continuing = lastWasTool && lastUser?.role === "user" && Array.isArray(lastUser.content)
        && (lastUser.content as Record<string, unknown>[])[0]?.type === "tool_result";
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      if (continuing) (lastUser.content as Record<string, unknown>[]).push(block);
      else out.push({ role: "user", content: [block] });
      lastWasTool = true;
      continue;
    }
    lastWasTool = false;
  }
  const toolDefs: Record<string, unknown>[] = providerTools.length > 0
    ? providerTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    : [];
  const systemBlocks: Record<string, unknown>[] = systemText ? [{ type: "text", text: systemText }] : [];
 // 断点按预算计划落位(决策在纯函数里、副作用在这里):本适配器不预置 cache_control,
 // 故 preMarked 缺省为空;若将来上游块自带标记,把它传进 preMarked 即可自动让出配额。
  const plan = planCacheBreakpoints({
    hasTools: toolDefs.length > 0,
    hasSystem: systemBlocks.length > 0,
    messageCount: out.length,
  });
  for (const slot of plan.slots) {
    if (slot.kind === "tools") { markCacheBreakpoint(toolDefs[toolDefs.length - 1]); continue; } // ③ 工具定义前缀末尾
    if (slot.kind === "system") { markCacheBreakpoint(systemBlocks[systemBlocks.length - 1]); continue; } // ② 静态系统提示末尾
    const blocks = out[slot.index ?? -1]?.content;
    if (Array.isArray(blocks)) markCacheBreakpoint(blocks[blocks.length - 1] as Record<string, unknown> | undefined); // ④/⑤ 对话历史尾部两条
  }
  return {
    model: cur.model,
    ...(systemBlocks.length ? { system: systemBlocks } : {}),
    messages: out,
    ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
    max_tokens: cur.maxTokens && cur.maxTokens > 0 ? cur.maxTokens : 8192,
    ...(stream ? { stream: true } : {}),
  };
}

type AnthropicContentBlock = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };

/** Anthropic usage 原生拆分(opencode mapUsage 同口径):input_tokens 是「非缓存」计数,
 * 缓存读写另列,三者求和为总输入。**兼容形态**:部分 anthropic 兼容网关按 OpenAI 形态回 usage
 * (prompt_tokens_details.cached_tokens / input_token_details.cached_tokens),此时 input_tokens 口径
 * 已含缓存,不能再次求和(会重复计)——按 nativeCache 标志二选一。 */
interface AnthropicUsageParts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** OpenAI 兼容缓存键(命中语义同 cache_read)。 */
  compatCached: number;
  /** 出现任一原生缓存键=原生 Anthropic 口径(input 为非缓存计数)。 */
  nativeCache: boolean;
}

function readAnthropicUsage(u: Record<string, unknown> | undefined | null): AnthropicUsageParts {
  const o = (u ?? {}) as Record<string, unknown>;
  // 兼容缓存键三形态:chat 形态 prompt_tokens_details.cached_tokens(openai-provider.extractUsage 同款)、
  // realtime 形态 input_token_details / Responses 形态 input_tokens_details(带 s——review 抓出的漏键)。
  const details = (o.prompt_tokens_details ?? o.input_token_details ?? o.input_tokens_details ?? {}) as { cached_tokens?: number };
  return {
    input: Number(o.input_tokens ?? o.prompt_tokens ?? 0) || 0,
    output: Number(o.output_tokens ?? o.completion_tokens ?? 0) || 0,
    cacheRead: Number(o.cache_read_input_tokens ?? 0) || 0,
    cacheWrite: Number(o.cache_creation_input_tokens ?? 0) || 0,
    compatCached: Number(details.cached_tokens ?? 0) || 0,
    nativeCache: o.cache_read_input_tokens !== undefined || o.cache_creation_input_tokens !== undefined,
  };
}

/** 右偏合并(message_start 种子 + message_delta 终值——终值权威,缺字段保留种子值)。 */
function mergeAnthropicUsage(left: AnthropicUsageParts, right: AnthropicUsageParts): AnthropicUsageParts {
  return {
    input: right.input || left.input,
    output: right.output || left.output,
    cacheRead: right.cacheRead || left.cacheRead,
    cacheWrite: right.cacheWrite || left.cacheWrite,
    compatCached: right.compatCached || left.compatCached,
    // 原生标志一旦出现即保持(终值可能省略缓存键不回退种子)
    nativeCache: left.nativeCache || right.nativeCache,
  };
}

/** parts → LlmResponse.usage:inputTokens=input+read+write(原生)/ input(兼容,已含);
 * cachedTokens=命中量=Anthropic cache_read(即 OpenAI 兼容字段 prompt_tokens_details.cached_tokens
 * 的同义量,消费方 trace-stats/面板命中率用这一平铺字段,不另造嵌套形态);
 * cacheCreationTokens=缓存写入量(原生 cache_creation_input_tokens,缺省不下发)。 */
function anthropicUsageOut(p: AnthropicUsageParts): LlmResponse["usage"] | undefined {
  const cached = p.nativeCache ? p.cacheRead : p.compatCached;
  // 兼容形态:input_tokens/prompt_tokens 已含缓存部分,直接取用(不求和);缺 input 时退化为命中量。
  const inAll = p.nativeCache ? p.input + p.cacheRead + p.cacheWrite : (p.input || p.compatCached);
  if (!inAll && !p.output) return undefined;
  return {
    inputTokens: inAll,
    outputTokens: p.output,
    totalTokens: inAll + p.output,
 // 修计量歧义:原生口径下 provider 明确报了 cache_read_input_tokens(哪怕值是 0)
    // 就显式下发 cachedTokens=0,让「provider 说这次没命中」与「provider 根本没报这个字段」可区分。
    // 旧实现 `cached > 0 ? {...} : {}` 把两者压成同一个「无字段」,导致命中率分析无法判断
 // 冷启动首调到底是真未命中,还是计量缺失(经验证 cold run 的 step0/step1 都无此字段,歧义两周)。
    // 兼容口径(prompt_tokens_details)保持原样:字段缺席时我们确实不知道,不能伪造成 0。
    ...(p.nativeCache ? { cachedTokens: cached } : cached > 0 ? { cachedTokens: cached } : {}),
    ...(p.nativeCache && p.cacheWrite > 0 ? { cacheCreationTokens: p.cacheWrite } : {}),
  };
}

function anthropicUsage(u: Record<string, unknown> | undefined): LlmResponse["usage"] | undefined {
  return anthropicUsageOut(readAnthropicUsage(u));
}

/** Anthropic stop_reason → LlmResponse.finishReason():max_tokens→length(截断)、
 * end_turn/stop_sequence→stop、tool_use→tool_calls;其它非空值→other;缺省省略(不触发续写)。 */
function anthropicFinish(stop: unknown): LlmResponse["finishReason"] {
  if (typeof stop !== "string" || !stop) return undefined;
  if (stop === "max_tokens") return "length";
  if (stop === "end_turn" || stop === "stop_sequence") return "stop";
  if (stop === "tool_use") return "tool_calls";
  return "other";
}

/** 非流式响应归一:content[] 块 → text 拼接/thinking 拼接进 reasoning/tool_use 进 toolCalls
 * (arguments=JSON.stringify(input),回到我们的字符串形态);与 chat 分支输出同构。 */
function fromAnthropicResponse(data: { content?: AnthropicContentBlock[]; stop_reason?: string | null; usage?: Record<string, unknown> }): LlmResponse {
  let content = "";
  let reasoning = "";
  const toolCalls: { id: string; name: string; arguments: string }[] = [];
  for (const b of data.content ?? []) {
    if (b.type === "text" && typeof b.text === "string") content += b.text;
    else if (b.type === "thinking" && typeof b.thinking === "string") reasoning += b.thinking;
    else if (b.type === "tool_use" && b.id && b.name) toolCalls.push({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
  }
  const usage = anthropicUsage(data.usage);
  const finishReason = anthropicFinish(data.stop_reason);
  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  } satisfies LlmResponse;
}

/** 流式 SSE 聚合:message_start 种子 usage.input → content_block_start(tool_use 按 index
 * 登记)→ content_block_delta(text_delta/thinking_delta/input_json_delta 累积)→
 * message_delta(usage.output 终值)→ message_stop;error 事件抛错(形态同 chat 流错误)。
 * 超时语义=流空闲超时(与 chatStreamed 对齐):timeoutMs 即空闲窗,不再有整体墙钟。 */
async function anthropicStreamed(
  cur: ApiTypeAdapterCur,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onDelta: (d: LlmDeltaChunk) => void,
  retryCtx: ApiTypeRetryCtx): Promise<LlmResponse> {
  const link = adapterAbortLink(signal);
  let idle: ReturnType<typeof createStreamIdleGuard> | null = null;
  try {
    const res = await postWithRetry(
      () => fetch(versionedUrl(cur.baseUrl, "/v1/messages"), {
        method: "POST",
        headers: anthropicHeaders(cur.apiKey),
        body: JSON.stringify({ ...body, stream: true }),
        signal: link.ctrl.signal,
      }),
      { retry: retryCtx.retry, signal: link.ctrl.signal, emit: retryCtx.emit, ...(retryCtx.budget ? { budget: retryCtx.budget } : {}), ...(retryCtx.budgetKey ? { budgetKey: retryCtx.budgetKey } : {}) },
    );
    if (!res.ok) throw new Error(`LLM ${res.status}: ${await errorText(res, "anthropic")}`);
    let content = "";
    let reasoning = "";
    const tools = new Map<number, { id: string; name: string; arguments: string }>();
    let parts = readAnthropicUsage(undefined); // message_start 种子 + message_delta 终值右偏合并
    let finishReason: LlmResponse["finishReason"]; // message_delta.delta.stop_reason(M28)
    const emit = (d: LlmDeltaChunk) => { try { onDelta(d); } catch { /* 回调异常不断流 */ } };
    idle = createStreamIdleGuard(cur.timeoutMs, (r) => link.ctrl.abort(r)); // 响应头已回:空闲窗接管超时
    idle.arm();
    for await (const j of sseJson(res, link.ctrl.signal, idle)) {
      const type = String(j.type ?? "");
      if (type === "error") {
        const e = j.error as { type?: string; message?: string } | undefined;
        const msg = e?.type && e?.message ? `${e.type}: ${e.message}` : String(e?.message ?? JSON.stringify(e ?? j)).slice(0, 200);
        throw new Error(`LLM stream: ${msg}`);
      }
    if (type === "message_start") {
      const u = (j.message as { usage?: Record<string, unknown> } | undefined)?.usage;
      parts = mergeAnthropicUsage(parts, readAnthropicUsage(u));
      continue;
    }
    if (type === "content_block_start") {
      const idx = Number(j.index ?? 0);
      const b = j.content_block as { type?: string; id?: string; name?: string } | undefined;
      if (b?.type === "tool_use") tools.set(idx, { id: b.id ?? `toolu_${idx}`, name: b.name ?? "", arguments: "" });
      continue;
    }
    if (type === "content_block_delta") {
      const idx = Number(j.index ?? 0);
      const d = j.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined;
      if (d?.type === "text_delta" && d.text) { content += d.text; emit({ text: d.text }); }
      else if (d?.type === "thinking_delta" && d.thinking) { reasoning += d.thinking; emit({ reasoning: d.thinking }); }
      else if (d?.type === "input_json_delta" && d.partial_json) {
        const acc = tools.get(idx);
        if (acc) acc.arguments += d.partial_json;
      }
      continue;
    }
    if (type === "message_delta") {
      const u = j.usage as Record<string, unknown> | undefined;
      if (u) parts = mergeAnthropicUsage(parts, readAnthropicUsage(u)); // 终值权威(右偏)
      // 结束原因在 delta.stop_reason(与 usage 同一事件);空值(流中早发)不覆盖。
      const sr = (j.delta as { stop_reason?: string | null } | undefined)?.stop_reason;
      const f = anthropicFinish(sr);
      if (f) finishReason = f;
      continue;
    }
    // message_stop / ping / content_block_stop:无需处理(块内累积已闭环)
    }
    const usage = anthropicUsageOut(parts);
    const toolCalls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).filter((v) => v.name);
    return {
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(usage ? { usage } : {}),
    } satisfies LlmResponse;
  } finally {
    if (idle) idle.dispose();
    link.dispose(); // 摘除外层 signal 监听(防逐请求累积)
  }
}

/** 参数类 400/422 报文的特征词(M122b):只有报文点名参数/字段问题才改写请求体——
 * 同一状态码下的鉴权 / 额度 / 路由类报文不该被当成「body 多带了字段」。 */
const REPAIRABLE_BODY_RE = /invalid_request|invalid request|unsupported|unrecognized|unknown|not supported|extra (?:field|param)/i;

/**
 * 非流式 POST(M122b):400/422 且报文点名参数类错误 → repairProviderBody 改写请求体一次并立即重发。
 * 复用 postWithRetry 的 repair 钩子:emit model_repair(code=invalid_request, actions=applied),
 * 且这次重发不占既有 retry 预算(attempt-- 后 continue)。
 * 一次性语义由本函数局部 attemptedRepair 布尔保证(每次 chat 调用一个);第二次仍失败则
 * postWithRetry 走原 stop 分支抛 ModelRequestError(与接入前同形态)。
 * 流式路径**不**经过本函数:stream 请求体逐字不变(旧行为)。
 */
async function postJsonWithBodyRepair(
  url: string,
  headers: Record<string, string>,
  initialBody: Record<string, unknown>,
  signal: AbortSignal,
  retryCtx: ApiTypeRetryCtx,
  kind: ProviderRepairKind): Promise<Response> {
  let body = initialBody;
  let attemptedRepair = false;
  let errorBody = ""; // fetch 包装里预读的非 ok 报文(peek 副本,不消费原响应体)
  return postWithRetry(
    async () => {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
      if (!res.ok) {
        try {
          errorBody = (await res.clone().text()).slice(0, 600);
        } catch {
          errorBody = "";
        }
      }
      return res;
    },
    {
      retry: retryCtx.retry,
      signal,
      emit: retryCtx.emit,
      ...(retryCtx.budget ? { budget: retryCtx.budget } : {}),
      ...(retryCtx.budgetKey ? { budgetKey: retryCtx.budgetKey } : {}),
      repair: ({ status }) => {
        if (attemptedRepair) return null;
        if (status !== 400 && status !== 422) return null;
        if (!REPAIRABLE_BODY_RE.test(errorBody)) return null;
        const rp = repairProviderBody(body, kind);
        if (rp.applied.length === 0) return null; // 没有可改字段:不虚报动作、不重发
        attemptedRepair = true;
        body = rp.body as Record<string, unknown>;
        return rp.applied;
      },
    },
  );
}

/** Anthropic Messages 入口(openai-provider.chat() 在 apiType=anthropic 时分派到此)。 */
export async function anthropicChat(
  cur: ApiTypeAdapterCur,
  messages: Message[],
  tools: ToolSpec[],
  signal: AbortSignal,
  onDelta: ((d: LlmDeltaChunk) => void) | undefined,
  retryCtx: ApiTypeRetryCtx): Promise<LlmResponse> {
  const body = toAnthropicBody(cur, messages, tools, Boolean(onDelta));
  dumpRequestBody(cur.model, body);
  if (onDelta) return anthropicStreamed(cur, body, signal, onDelta, retryCtx);
  const res = await postJsonWithBodyRepair(
    versionedUrl(cur.baseUrl, "/v1/messages"),
    anthropicHeaders(cur.apiKey),
    body,
    signal,
    retryCtx,
    "anthropic",
  );
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await errorText(res, "anthropic")}`);
  return fromAnthropicResponse((await res.json()) as { content?: AnthropicContentBlock[]; usage?: Record<string, unknown> });
}

// =============================================================================
// OpenAI Responses(POST /v1/responses)
// =============================================================================
/** Message[] → Responses 请求体:input 数组(system/user/assistant 角色 +
 * function_call/function_call_output 项);tools 扁平形态;store:false(无服务端会话,
 * 每次全量重放——opencode route 默认同款);maxTokens→max_output_tokens(可不带)。 */
function toResponsesBody(cur: ApiTypeAdapterCur, messages: Message[], tools: ToolSpec[], stream: boolean): Record<string, unknown> {
  messages = messages.map((m) => ({ ...m, content: sanitizeLoneSurrogates(m.content) })); // 孤立代理防线(见 sanitizeLoneSurrogates)
 // 模型族适配:归一派生的 tools 副本 + 风格提示(只影响请求体,注册表本体不动);apiId 由 provider 携带。
  const normCtx = { apiId: cur.apiId, model: cur.model };
  const providerTools = normalizeToolsForProvider(tools, normCtx);
  const hints = declaredPromptHints(normCtx);
  const input: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") { input.push({ role: "system", content: m.content }); continue; }
    if (m.role === "user") {
      const content: Record<string, unknown>[] = [];
      if (m.content) content.push({ type: "input_text", text: m.content });
      for (const img of (m as { images?: string[] }).images?.slice(0, 4) ?? []) content.push({ type: "input_image", image_url: img });
      input.push({ role: "user", content: content.length ? content : [{ type: "input_text", text: "" }] });
      continue;
    }
    if (m.role === "assistant") {
      if (m.content) input.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
      for (const c of m.toolCalls ?? []) input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments });
      continue;
    }
    input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
  }
 // 风格提示并入**最后一条** system 消息(无 system 时不强造,与 anthropic 分支同口径)。
  if (hints) {
    for (let i = input.length - 1; i >= 0; i -= 1) {
      const item = input[i];
      if (item?.["role"] === "system") {
        input[i] = { ...item, content: `${String(item["content"] ?? "")}\n\n${hints}` };
        break;
      }
    }
  }
  return {
    model: cur.model,
    input,
    ...(providerTools.length > 0
      ? { tools: providerTools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })) }
      : {}),
    store: false,
    ...(cur.maxTokens && cur.maxTokens > 0 ? { max_output_tokens: cur.maxTokens } : {}),
    ...(cur.reasoningEffort ? { reasoning: { effort: cur.reasoningEffort } } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

/** Responses usage 归一:input_tokens(含缓存)/input_tokens_details.cached_tokens(Responses
 * 专属键,chat 的 extractUsage 不认)/output_tokens/total_tokens。 */
function responsesUsage(u: Record<string, unknown> | undefined | null): LlmResponse["usage"] | undefined {
  if (!u || typeof u !== "object") return undefined;
  const details = (u.input_tokens_details ?? {}) as { cached_tokens?: number };
  const cached = Number(details.cached_tokens ?? 0) || 0;
  const input = Number(u.input_tokens ?? 0) || 0;
  const output = Number(u.output_tokens ?? 0) || 0;
  if (!input && !output) return undefined;
  const total = u.total_tokens !== undefined ? Number(u.total_tokens) : input + output;
  return { inputTokens: input, outputTokens: output, totalTokens: total, ...(cached > 0 ? { cachedTokens: cached } : {}) };
}

/** Responses 结束原因 → LlmResponse.finishReason():只认 Responses 自己的口径——
 * incomplete_details.reason=max_output_tokens→length(输出截断)、content_filter→content_filter、
 * 其它 incomplete 原因→other;status=completed→stop;拿不到则省略(不触发续写)。 */
function responsesFinish(data: { status?: unknown; incomplete_details?: unknown }): LlmResponse["finishReason"] {
  const reason = (data.incomplete_details as { reason?: unknown } | null | undefined)?.reason;
  if (typeof reason === "string" && reason) {
    if (reason === "max_output_tokens") return "length";
    if (reason === "content_filter") return "content_filter";
    return "other";
  }
  if (data.status === "completed") return "stop";
  return undefined;
}

/** 非流式响应归一:output[] 项——message.content[].output_text→content;
 * function_call→toolCalls(id=call_id);reasoning.summary[].text→reasoning(摘要尽力归一)。 */
function fromResponsesResponse(data: { output?: unknown; status?: unknown; incomplete_details?: unknown; usage?: Record<string, unknown> }): LlmResponse {
  let content = "";
  let reasoning = "";
  const toolCalls: { id: string; name: string; arguments: string }[] = [];
  for (const item of Array.isArray(data.output) ? (data.output as Record<string, unknown>[]) : []) {
    const t = String(item.type ?? "");
    if (t === "message") {
      for (const c of Array.isArray(item.content) ? (item.content as { type?: string; text?: string }[]) : []) {
        if (c.type === "output_text" && typeof c.text === "string") content += c.text;
      }
    } else if (t === "function_call") {
      if (typeof item.call_id === "string" && typeof item.name === "string") {
        toolCalls.push({
          id: item.call_id,
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        });
      }
    } else if (t === "reasoning") {
      for (const s of Array.isArray(item.summary) ? (item.summary as { text?: string }[]) : []) {
        if (typeof s.text === "string") reasoning += s.text;
      }
    }
  }
  const usage = responsesUsage(data.usage);
  const finishReason = responsesFinish(data);
  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  } satisfies LlmResponse;
}

/** 流式 SSE 聚合:output_text.delta→text 增量;reasoning_text/summary_text.delta→reasoning
 * 增量;output_item.added(function_call 按 item.id 登记)→function_call_arguments.delta
 * 累积→output_item.done(function_call 终值覆写,容忍无 delta 直发 done 的网关);
 * response.completed/incomplete→usage;response.failed/error→抛错。
 * 超时语义=流空闲超时(与 chatStreamed 对齐):timeoutMs 即空闲窗,不再有整体墙钟。 */
async function responsesStreamed(
  cur: ApiTypeAdapterCur,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onDelta: (d: LlmDeltaChunk) => void,
  retryCtx: ApiTypeRetryCtx): Promise<LlmResponse> {
  const link = adapterAbortLink(signal);
  let idle: ReturnType<typeof createStreamIdleGuard> | null = null;
  try {
    const res = await postWithRetry(
      () => fetch(versionedUrl(cur.baseUrl, "/v1/responses"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cur.apiKey}` },
        body: JSON.stringify({ ...body, stream: true }),
        signal: link.ctrl.signal,
      }),
      { retry: retryCtx.retry, signal: link.ctrl.signal, emit: retryCtx.emit, ...(retryCtx.budget ? { budget: retryCtx.budget } : {}), ...(retryCtx.budgetKey ? { budgetKey: retryCtx.budgetKey } : {}) },
    );
    if (!res.ok) throw new Error(`LLM ${res.status}: ${await errorText(res, "openai")}`);
    let content = "";
    let reasoning = "";
    const tools = new Map<string, { id: string; name: string; arguments: string }>();
    let usage: LlmResponse["usage"];
    let finishReason: LlmResponse["finishReason"]; // response.completed/incomplete 的 status/incomplete_details(M28)
    const emit = (d: LlmDeltaChunk) => { try { onDelta(d); } catch { /* 回调异常不断流 */ } };
    idle = createStreamIdleGuard(cur.timeoutMs, (r) => link.ctrl.abort(r)); // 响应头已回:空闲窗接管超时
    idle.arm();
    for await (const j of sseJson(res, link.ctrl.signal, idle)) {
      const type = String(j.type ?? "");
      if (type === "error" || type === "response.failed") {
        const nested = (j.response as { error?: { code?: string; message?: string } } | undefined)?.error;
        const msg = j.message ?? nested?.message ?? nested?.code ?? j.code;
        throw new Error(`LLM stream: ${String(msg ?? JSON.stringify(j)).slice(0, 200)}`);
      }
      if (type === "response.output_text.delta") {
        if (typeof j.delta === "string" && j.delta) { content += j.delta; emit({ text: j.delta }); }
        continue;
      }
      if (type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta" || type === "response.reasoning_summary.delta") {
        if (typeof j.delta === "string" && j.delta) { reasoning += j.delta; emit({ reasoning: j.delta }); }
        continue;
      }
      if (type === "response.function_call_arguments.delta") {
        const acc = tools.get(String(j.item_id ?? ""));
        if (acc && typeof j.delta === "string") acc.arguments += j.delta;
        continue;
      }
      if (type === "response.output_item.added") {
        const item = j.item as { type?: string; id?: string; call_id?: string; name?: string } | undefined;
        if (item?.type === "function_call" && item.id) tools.set(item.id, { id: item.call_id ?? item.id, name: item.name ?? "", arguments: "" });
        continue;
      }
      if (type === "response.output_item.done") {
        const item = j.item as { type?: string; id?: string; call_id?: string; name?: string; arguments?: string } | undefined;
        if (item?.type === "function_call" && item.id) {
          tools.set(item.id, { id: item.call_id ?? item.id, name: item.name ?? "", arguments: typeof item.arguments === "string" ? item.arguments : "" });
        }
        continue;
      }
      if (type === "response.completed" || type === "response.incomplete") {
        const r = j.response as { usage?: Record<string, unknown>; status?: unknown; incomplete_details?: unknown } | undefined;
        const u = responsesUsage(r?.usage);
        if (u) usage = u;
        const f = responsesFinish(r ?? {});
        if (f) finishReason = f;
        continue;
      }
      // 其余事件(created/content_part 等)无需处理
    }
    const toolCalls = [...tools.values()].filter((v) => v.name);
    return {
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(usage ? { usage } : {}),
    } satisfies LlmResponse;
  } finally {
    if (idle) idle.dispose();
    link.dispose(); // 摘除外层 signal 监听(防逐请求累积)
  }
}

/** OpenAI Responses 入口(openai-provider.chat() 在 apiType=responses 时分派到此)。 */
export async function responsesChat(
  cur: ApiTypeAdapterCur,
  messages: Message[],
  tools: ToolSpec[],
  signal: AbortSignal,
  onDelta: ((d: LlmDeltaChunk) => void) | undefined,
  retryCtx: ApiTypeRetryCtx): Promise<LlmResponse> {
  const body = toResponsesBody(cur, messages, tools, Boolean(onDelta));
  dumpRequestBody(cur.model, body);
  if (onDelta) return responsesStreamed(cur, body, signal, onDelta, retryCtx);
  const res = await postJsonWithBodyRepair(
    versionedUrl(cur.baseUrl, "/v1/responses"),
    { "content-type": "application/json", authorization: `Bearer ${cur.apiKey}` },
    body,
    signal,
    retryCtx,
    "responses",
  );
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await errorText(res, "openai")}`);
  return fromResponsesResponse((await res.json()) as { output?: unknown; status?: unknown; incomplete_details?: unknown; usage?: Record<string, unknown> });
}
