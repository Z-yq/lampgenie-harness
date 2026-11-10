/**
 * Agent loop(designs/14 §1 定稿):turn/step 循环、journal 驱动、取消配对。
 * 契约参照 dsh agent-loop(仅借鉴,自研实现);journal 用 core 的 Journal。
 */
import type { Journal } from "@lampgenie/core";
// M29 流中断安全锚点恢复:锚点计算 / 可重试判据 / 作废落账 / 冷恢复过滤(纯函数,见 stream-anchor.ts)。
import { classifyStreamRetry, filterDiscarded, findSafeAnchor, markDiscard, STREAM_REOPEN_MAX, type SafeAnchor } from "./stream-anchor";
import {
  microcompactMessages, shouldAggressivePrune, ASCII_TOKENS_PER_CHAR,
  GROWTH_BUDGET_RATIO, GROWTH_BUDGET_MIN_TOKENS,
  type MicrocompactConfig, type MicrocompactPolicyState,
} from "./microcompact";
// token 口径统一见 agent/token-estimate.ts(真分词器 + 标定 ratio)。
import { estimateMessagesTokens as estimateMessagesTokensUnified } from "./token-estimate";
// M145 上下文构成归因(只观测,不参与闸门/压缩决策)。
import { buildContextBreakdown } from "./context-breakdown";
import {
  buildModelDecisionSets,
  collectScoringCandidates,
  goalFromMessages,
  resolveModelScoringConfig,
  scoreContextCandidates,
  scoringSkipReason,
  type ModelDecisionSets,
  type ModelScoringConfig,
  type ModelScoringMode,
} from "./model-scoring";
import { buildReadFilesReminder } from "./read-file-state";
import { createInjectGate, type InjectGate } from "./inject-gate";
import { spillToolResult } from "./tool-result-spill";
import { intakeToolResult, shouldIntake, type BigIntakeConfig, type IntakeMeta } from "./big-intake";
import { normalizeToolArgs, renderToolArgError } from "./tool-args";
// M153 工具注册身份治理:未知工具按「前缀 + 编辑距离」给可达候选(纯函数,零依赖模块)。
import { describeUnknownTool } from "./tool-identity";
import {
  ToolLoopGuard,
  callSignature,
  resultHashOf,
  type GuardKind,
} from "./tool-loop-guard";
import {
  isImageBudgetError,
  offloadImages,
  offloadProjectionPreserved,
  type OffloadedImage,
} from "./image-offload";
// 系统上下文代(M125):三态 reconcile / 单块合成 / 代重开。指纹实现随之迁到该模块,此处 re-export
// 保持既有导入面不变。
import {
  reconcileSystemContext,
  sectionSha,
  TEXT_CODEC,
  type SystemContextSource,
  type SystemContextState,
} from "./system-context-generation";
// M81 阶段遥测(纯逻辑,无 IO):turn 内 llm/tools 阶段 span + 单条 telemetry.phase 汇总。
import { PhaseRecorder, buildTurnTelemetry, createTelemetryClock, type PhaseToken } from "./phase-telemetry";

export { sectionSha };
/** 消息(对齐 dsh llm 词汇表的最小子集)。 */
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: string[]; audio?: AudioInput }
  /** reasoning=thinking 模式思考过程(2026-11):必须随 assistant 消息回传 provider
   *  (DeepSeek 系 thinking 模式对缺 reasoning_content 的历史直接 400)。 */
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; reasoning?: string }
  | { role: "tool"; toolCallId: string; content: string };

/**
 * 视觉工具结果哨兵(2026-10-25 view_image,对齐 ZCode read-image 的"工具结果媒体块"语义):
 * 工具(gateway view_image)返回 `[vision-image]{json:dataUrl,label}` → loop 落账时剥离 dataUrl
 * 进 tool.result payload.images(工具可见文本换确认句),derive 时投影为后置 user 消息(OpenAI 系
 * tool content 不支持图片,后置 user part=ZCode tool-result-media-projection 的同构实现)。
 * 单点常量跨包共享:gateway file-tools 产生、runtime loop 解析。
 */
export const VISION_TOOL_SENTINEL = "[vision-image]";

/**
 * 工具回执激活标记(2026-10-30 board_read 死锁事故):回执文本携带 `[[activate-tool:<name>]]`
 * → loop 把该工具点亮进广告面(activatedTools),标记本身从模型可见文本剥离并换一句可读提示。
 * 背景:plan-gate 拒绝指路 board_upsert,但它 deferred 不在 wire 面——受约束的函数名采样只能
 * 落在名字最接近的可见工具(board_read)上,「写板」意图永远无出口,实测 38 步同参死循环。
 * 原则:硬闸要求什么,工具面就必须给什么;闸门/指引文案提到哪个延迟工具,就附上它的激活标记。
 */
export const ACTIVATE_TOOL_RE = /\[\[activate-tool:([A-Za-z0-9_]+)\]\]/g;

/** 用户语音输入内容(2026-10-21 音频链路优化,omni-query/realtime-plus 两形态共用):
 * data=base64 音频;format 缺省 "pcm16"(浏览器 PTT 的 16kHz 单声道裸 PCM;HTTP query 侧自动包 WAV 容器)。
 * 与 images 同语义:只随 user 消息走,journal 全量落(derive 侧只保留最新一条,防历史回放请求膨胀)。 */
export interface AudioInput {
  data: string;
  format?: "wav" | "mp3" | "pcm16";
  /** pcm16 采样率(缺省 16000,浏览器 PTT 标准);仅包 WAV 容器时使用。 */
  rate?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON 字符串
}

/** 工具失败的结构化归因(txa1/txa2,2026-11 轨迹采集补齐)。
 * 不加新文案:content 仍是模型可读文本(**一字不改**——模型靠它换路,旧面板 /^错误/ 正则靠它),
 * error 只是随 tool.result 落账的结构化旁注,查询侧据此分桶而不必正则猜文案。 */
export interface ToolExecError {
  origin: "unknown-tool" | "timeout" | "threw" | "aborted" | "denied" | "write-barrier" | "guard";
  /** 失败文案(去掉「错误:」前缀;aborted 保留原文),≤600 字符。 */
  message: string;
  /** 工具名(unknown-tool 时=被请求的名字)。 */
  name?: string;
}

/** execOne 的结果形态(content 进模型/历史,durationMs 进 tool.result;error 仅失败时有)。 */
export interface ToolExecOutcome {
  call: ToolCall;
  content: string;
  durationMs: number;
  error?: ToolExecError;
  /** M115 循环护栏:只改「模型可见文本」(结果去重 stub),journal tool.result 仍存 content 原文。 */
  modelContent?: string;
}

/** 工具取消文案(executeTracked 的取消分支以字符串而非抛错返回,execOne 归一时复用同一定义)。 */
const ABORTED_TOOL_TEXT = "[aborted] 执行被取消";
/** M34(2026-11-07)用户停止语义:被**用户**停止时的固定 modelContent。
 *  旧行为一律回 "[aborted] 执行被取消",模型容易当成可重试错误继续干;用户停止必须明确
 *  「不要继续/不要重试/不要换等价操作」。内部超时/模型取消/其它 abort 仍用 ABORTED_TOOL_TEXT。 */
export const USER_STOPPED_TOOL_TEXT = "[用户已停止] 当前任务已被用户停止;不要继续执行、不要重试、不要换等价操作,等待用户新指令。";
/** 用户停止的 abort 原因白名单(区分依据见 isUserStopAbort 注释,不做模糊匹配)。
 *  注意不收录 cancel() 的缺省 reason "user-cancel":缺省值只被测试/内部逃生路径使用,
 *  生产用户停止由网关显式传 "task.cancel"(装配层可传 "user-stop")。 */
const USER_STOP_REASON_KEYS = ["task.cancel", "user-stop", "user_stop"];
function isUserStopReason(reason: unknown): boolean {
  const text = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  if (!text) return false;
  return USER_STOP_REASON_KEYS.some((k) => text.includes(k));
}
/** 取消原因是否「用户停止」(M34)。区分依据只有两条,都不靠猜:
 *  ① AbortSignal.reason —— AgentLoop.cancel(reason) 以 `abort(new Error("cancelled:"+reason))` 落原因,
 *     网关 task.cancel 传 "task.cancel";
 *  ② loop 实例自身的 cancel 记账(AgentLoop.userStopped)——工具没拿 signal 时靠这里判。
 *  超时(工具 deadline 的 race 超时)不走 abort、而是返回超时错误框;模型取消/内部 abort 的
 *  reason 不含上述关键词 → 仍走旧 [aborted] 语义。 */
export function isUserStopAbort(signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false;
  return isUserStopReason(signal.reason);
}
/** 写前持久化屏障(M24)工具侧固定错误框前缀:模型可读文案,error.origin=write-barrier。 */
const WRITE_BARRIER_TOOL_PREFIX = "[写前屏障] journal 落盘失败";
/** 写前屏障阻止工具执行时的固定错误框(原因带在括号里)。 */
function writeBarrierToolText(reason: string): string {
  return `${WRITE_BARRIER_TOOL_PREFIX}(${reason}),已阻止工具执行(副作用无法归因);检查磁盘空间/9p 挂载后重试。`;
}

/** 写前屏障失败导致 turn 中止(M24):runTurn 抛它 → 任务 failed(与取消同型:不重派整轮)。 */
export class WriteBarrierAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteBarrierAbortError";
  }
}
/** 兜底:闸门拒绝(重操作闸 / deny 规则 / 审批未通过)的文案前缀——这三处在
 *  executeWithPermission 内直接 return 字符串,未带结构化字段。将来若闸门侧补结构化字段
 *  (origin 随结果带出)应删掉本兜底。 */
const GATE_DENY_RE = /^错误:(?:命令被判为重操作|工具 .+? 被权限(?:规则|审批)拒绝)/;
/** 兜底:超时文案前缀(executeInner 超时后同样以字符串返回,而非抛错)。 */
const TOOL_TIMEOUT_RE = /^错误:工具执行超时\(/;

/** M28 输出截断续写:固定续写提示(只进续写请求的**临时** user 消息,绝不进 journal/历史)。 */
const OUTPUT_CONTINUATION_PROMPT = "继续。从被截断处紧接着写,不要道歉、不要复述已写内容、不要重新开头。";
/** 续写次数上限:原始请求 1 次 + 续写最多 3 次;第 4 次仍 length 即放弃(不再请求)。 */
const OUTPUT_CONTINUATION_MAX = 3;
/** 续写满 3 次仍被截断时的固定警告(≤120 字,追加到合并文本末尾)。 */
const OUTPUT_CONTINUATION_LIMIT_WARN = "[输出上限] 已续写 3 次仍被截断;请缩小单次输出或分段交付。";

/** usage 累加(M28 续写):缺项按 0 求和;totalTokens 两侧都缺时保持缺省(不伪造 0)。 */
function addUsage(a: LlmResponse["usage"], b: LlmResponse["usage"]): LlmResponse["usage"] {
  if (!a) return b;
  if (!b) return a;
  const add = (x?: number, y?: number) => (x ?? 0) + (y ?? 0);
  const cached = add(a.cachedTokens, b.cachedTokens);
  const created = add(a.cacheCreationTokens, b.cacheCreationTokens);
  return {
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    ...(a.totalTokens !== undefined || b.totalTokens !== undefined ? { totalTokens: add(a.totalTokens, b.totalTokens) } : {}),
    ...(cached > 0 ? { cachedTokens: cached } : {}),
    ...(created > 0 ? { cacheCreationTokens: created } : {}),
  };
}

/** M145:上下文构成归因的频率闸(同一 turn 内每 N 步落一帧;0=关闭;缺省/非法=1 即每请求)。 */
function contextBreakdownEvery(): number {
  const raw = String(process.env["GENIE_CONTEXT_BREAKDOWN_EVERY"] ?? "").trim();
  if (raw === "") return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/** 工具结果归一(txa1):失败结果补结构化 error,成功结果**不带** error 键。
 *  只在前缀确实命中时返回,不做「含错误字样」之类的模糊匹配(避免把正常结果误标失败)。 */
function toolErrorOf(content: string, name: string): ToolExecError | undefined {
  const message = content.replace(/^错误:?/, "").slice(0, 600);
  // M34:用户停止与普通取消同归 aborted 类(文案本身已区分;查询侧可按 content 前缀分桶)。
  if (content === ABORTED_TOOL_TEXT || content === USER_STOPPED_TOOL_TEXT) return { origin: "aborted", message, name };
  if (content.startsWith(WRITE_BARRIER_TOOL_PREFIX)) return { origin: "write-barrier", message, name };
  if (GATE_DENY_RE.test(content)) return { origin: "denied", message, name };
  if (TOOL_TIMEOUT_RE.test(content)) return { origin: "timeout", message, name };
  return undefined;
}

/** M115:ToolExecOutcome → 护栏 kind。只有真失败(threw/timeout/unknown-tool)算失败;
 *  参数错误、权限/重操作拒绝、取消都不算(否则模型自救重试会被当成循环)。 */
const ARG_ERROR_PREFIX = "[工具参数错误]";
function guardKindOfToolOutcome(r: ToolExecOutcome): GuardKind {
  if (!r.error) return r.content.startsWith(ARG_ERROR_PREFIX) ? "arg-error" : "ok";
  switch (r.error.origin) {
    case "aborted": return "aborted";
    case "denied": return "guardrail-refusal";
    case "guard": return "blocked";
    default: return "error"; // threw / timeout / unknown-tool / write-barrier
  }
}

/** LLM 增量(step-050,ZCode 流式消息展示):onDelta 传入时 provider 走流式通道逐块上报。 */
export interface LlmDeltaChunk {
  text?: string;
  reasoning?: string;
}

/** tips 注入返回值(2026-10-22):裸 string=仅注入文本;带 keys=同时留痕分类名给面板。 */
export interface TipInjection {
  text: string;
  /** 本步注入的 tip 类别名(装配方定义,如 code-orient/history-align/dispatch/board-comments)。 */
  keys: string[];
}

/** 流事件(loop→面板的旁路通道;不落 journal,终态仍由 message.agent/tool.result 持久)。 */
export type AgentStreamEvent =
  | { type: "llm-begin" }
  | { type: "llm-delta"; text?: string; reasoning?: string }
  | { type: "llm-end"; text: string }
  | { type: "tool-begin"; callId: string; name: string }
  | { type: "tool-end"; callId: string; name: string; durationMs: number }
  | { type: "tool-progress"; callId: string; name: string; note: string };

/** LLM 抽象:返回一次完整响应;onDelta 在场时以流式实现(增量经回调透出,聚合结果不变)。 */
/** M29 流式 attempt 作废信息:attemptId=被作废的那次流式 attempt(与成功 attempt 不同 id)。 */
export interface LlmChatAttemptInfo {
  attemptId: string;
  /** 0-based attempt 序号(0=首次请求,>=1=provider 内部重试)。 */
  attempt: number;
  reason: string;
  /** 该 attempt 已吐出的正文/思考字符数(作废留痕用)。 */
  partialChars: number;
}

/** chat 第 5 参(M29):调用方给本次 chat 一个 attemptId,provider 内部作废半截时回调。 */
export interface LlmChatOptions {
  attemptId?: string;
  onAttemptDiscarded?: (info: LlmChatAttemptInfo) => void;
}

export interface LlmProvider {
  chat(messages: Message[], tools: ToolSpec[], signal?: AbortSignal, onDelta?: (d: LlmDeltaChunk) => void, opts?: LlmChatOptions): Promise<LlmResponse>;
}

export interface LlmResponse {
  content: string;
  toolCalls?: ToolCall[];
  /** M29:产出该响应的流式 attempt id(provider 内部重试后=base#n;非流式缺省)。
   *  loop 写进 message.agent,冷恢复按 stream.attempt.discarded 的 attemptId 剔除被作废消息。 */
  attemptId?: string;
  /** token 用量(step-031:provider 透传,缺省无);cachedTokens=提示缓存命中(step-048);
   * cacheCreationTokens=提示缓存写入量(step-130 Anthropic cache_creation_input_tokens;仅 Anthropic
   * 原生口径下发)。当前消费方只有 cachedTokens(trace-stats tokens.cached/面板命中率);
   * cacheCreationTokens 为成本核算预留的 additive 面——面板/统计显式接入前不得据此做展示。 */
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number; cachedTokens?: number; cacheCreationTokens?: number };
  /** 思考过程(step-046:OpenAI 兼容端点的 reasoning_content/reasoning 字段;缺省无)。
   * journal 进 message.agent.payload.reasoning,面板渲染「思考 · Xs」折叠卡。 */
  reasoning?: string;
  /** 结束原因(M28,2026-11-07):provider 归一后的同类语义。
   * "length"=输出被 max_tokens 截断 → loop 触发续写(见 OUTPUT_CONTINUATION_*);
   * 缺省=端点没报/适配器拿不到(不触发任何行为,与加本字段前逐字一致)。 */
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | "other";
  /** 模型自带语音(text+audio 直出,realtime-plus 形态;缺省无=纯文本)。
   * mime 恒为可直接 <audio> 播放的容器形态(如 audio/wav);base64=音频正文。
   * 消费方:companion 轨回复广播(audioB64)——该形态下链路不再外挂 tts。 */
  audio?: { mime: string; base64: string };
}

/** LLM 调用轨迹(step-132,2026-10-19 用户口径「每次 llm 调用的 message 和 output 都要记录方便 debug」;
 * 同日扩容「怎么送给 llm 服务的就怎么记录」):每 step 一次 chat 后的完整现场——
 * 请求 messages 全量+**工具完整规格(name/description/parameters schema)**+provider 参数面
 * (baseUrl/apiType/model/maxTokens/reasoningEffort/timeoutMs,复现 wire 请求的全部输入)+
 * 响应全文+耗时/TTFT。loop 只上报不落盘(落盘形态由装配方定);model 从 provider 对象尽力读取。 */
export interface LlmCallTrace {
  sessionId: string;
  turn: number;
  step: number;
  model?: string;
  durationMs: number;
  ttftMs?: number;
  messages: Message[];
  /** 完整工具规格(送进 provider 的原样;wire 请求的 tools 数组由它确定性变换而来)。 */
  tools: ToolSpec[];
  /** 保留旧口径(快速人读);全量在 tools。 */
  toolNames: string[];
  /** provider 参数面(describe() 尽力读;缺省=provider 未暴露)。 */
  provider?: Record<string, unknown>;
  response: LlmResponse;
  /** 失败调用(err.message 摘要;成功缺省)。2026-10-20:失败也落轨迹,不再只留 finalText。 */
  error?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema。 */
  parameters: Record<string, unknown>;
}

/** 工具定义:schema + 执行体。 */
export interface Tool extends ToolSpec {
  /** 延迟加载(2026-10-22 用户口径「工具像 MCP 一样用时再选」):true=未激活前不进 wire 广告面
   * (tools 参数不含它,省下 schema 常驻 token),但**执行面始终可用**——模型凭记忆直接调用照样
   * 执行并按成功调用自动激活(不硬失败)。激活通道:tool_view(name) 或首次直接调用自身。
   * 装配方(tool-view.attachToolView)按 wire 体量打标;缺省 undefined=老行为逐字节一致。 */
  deferred?: boolean;
  /** 并发安全声明(designs/14 §1.3):true 才可与其他安全工具并行。 */
  isConcurrencySafe?(args: unknown): boolean;
  /** 执行 deadline(2026-10-29 冻结治理):本工具单次 execute 的时限(ms)。
   *  缺省=AgentLoopOptions.toolTimeoutMs(装配层统一帽);**0=自管豁免**——工具自身已有
   *  完备超时/等待语义(terminal 的 waitReason=timeout、spawn_subagent 的 deadlineMin、
   *  ask_user 等人),loop 不再包帽。超时≠取消:底层 Promise 继续跑(文件系统停顿不可中断),
   *  loop 返回诚实错误让模型换路——防单工具无限挂死拖住整个 agent。 */
  timeoutMs?: number;
  /** 只读声明:true=该工具无副作用,权限闸门豁免(读类工具在全部权限模式下可用——
   * 只读调查不设闸;写类/执行类不声明此字段,照常过规则/ask 审批链)。 */
  isReadOnly?(args: unknown): boolean;
  /** execute 上下文(step-093):loop 透传调用标识。可选第三参,既有实现(参数更少)不受影响。
   * 用途=工具内部旁路事件(如 tool.tokens)回指 toolCallId,面板零猜测定向关联。 */
  execute(args: unknown, signal?: AbortSignal, ctx?: { callId: string }): Promise<string>;
}

/** system 提示的一个分块(与 `system` 全文对应,只额外保留节名边界)。
 *  装配方(`composeSystemPrompt` 的 sections + 那些裸字符串块)负责产出;loop 只按 name 做 diff。 */
export interface SystemSectionRef {
  name: string;
  content: string;
}

export interface AgentLoopOptions {
  journal: Journal;
  sessionId: string;
  system: string;
  llm: LlmProvider;
  tools?: Tool[];
  /** 单 turn 最大 step 数(防死循环)。 */
  maxSteps?: number;
  /** 写前持久化屏障(M24):off=完全不调 journal.flushStrict(基础设施/测试逃生);hard(缺省)=
   *  工具执行/LLM 请求前 fail-closed。env GENIE_WRITE_BARRIER 优先于本字段;journal 无
   *  flushStrict(旧 MemoryJournal/测试假 journal)时自动 no-op。 */
  writeBarrier?: "off" | "hard";
  /** 工具执行统一帽(2026-10-29 冻结治理,ms):Tool.timeoutMs 缺省时用它;0=关(不设帽)。
   *  装配层设 generous 值+对自管工具逐个 timeoutMs:0 豁免——防「单工具无限挂死拖住整个
   *  agent」(WSL 9p 停顿实测:grep/read_file 同步读冻住事件循环,四个 loop 一起停摆)。 */
  toolTimeoutMs?: number;
  /** 压缩钩子(designs/14 §4.2/R5-C9 修复):每 step 前调用,超阈值由实现方触发 autoCompact。
   * 走注入而非直接 import,避免 loop↔auto-compact 循环依赖(auto-compact 引 deriveMessages)。 */
  compactHook?: (journal: Journal, sessionId: string) => Promise<void>;
  /** microcompact 配置(step-140,对齐 ZCode 阈值触发):thresholdTokens > 0 时启用组清理
   * (保留最近 keepRecent 组,其余清为可重读占位;minSavings 不足回滚);未传=只走超大结果
   * 占位(旧行为,零变化)。阈值由装配方用 autoCompact 阈值推导(buildDefaultMicrocompactThreshold)。
   * cache-aware 批量/滞后策略(2026-11-06)默认开启(loop 每步传 policyState);
   * `cacheAware:false` = 恢复旧的每步增量清(仅用于对照实验)。 */
  microcompact?: MicrocompactConfig;
  /** 写时定形 spill(2026-11 token 优化轮 02,对齐 dsh spill-policy):配置后,工具结果**进历史
   * 之前**超阈即落盘并换成「头+标记+尾+落盘路径+回读指引」,之后永不改写——取代读时改写
   * (microcompact 每步重写历史中段 → 提示前缀逐字变化 → prompt cache 全量失效,实测 uncached
   * 单价是命中的 50 倍)。**可选**:不配置=行为逐字不变(既有构造点/测试零影响)。
   * dir=落盘根(装配方给 `<repo>/.genie/spill`);阈值缺省 8192/头 4096/尾 1024。 */
  spill?: { dir: string; thresholdChars?: number; headChars?: number; tailChars?: number };
  /** 图片 offload(M58,对齐 #58):配置后,LLM 调用抛「图片预算/尺寸」类错误
   *  (isImageBudgetError)且本请求带图时,把 data URL 落盘到 `<root>/.genie/image-offload/…`
   *  并在正文追加 `[image offloaded: …]` 占位,再用新 messages **立即重试一次**(这次重试
   *  不占 provider 重试预算也不增加 visionRepairs 计数);仍失败则抛第二次错误并注明
   *  「图片已 offload,仍失败」。不配置=行为逐字不变(旧构造点/测试零影响)。
   *  impl 仅测试注入(缺省 offloadImages)。 */
  imageOffload?: {
    root: string;
    jobId?: string;
    impl?: (messages: Message[], opts: { root: string; sessionId: string; jobId?: string }) => Promise<{
      messages: Message[];
      offloaded: OffloadedImage[];
      skipped: { messageIndex: number; imageIndex: number; reason: string }[];
    }>;
  };
  /** 大结果「智能入上下文」闸门(step-1029,2026-11-06):工具结果进 journal 之前,超过**本步剩余预算**
   * 且 ≥ 绝对下限(4k tok)时,chunk 切分 + 本地 8105 选块(±小模型四段摘要),全文落盘
   * `.genie/tool-dumps/<callId>.txt`,上下文里只放「选块/摘要 + 全文已落盘指针」。
   * 与 `spill` 的关系:命中闸走闸门,未命中仍走 spill(二者互斥,绝不双写双定形)。
   * 不配置=行为逐字不变;`GENIE_BIG_RESULT=off` 由装配方折算成 `enabled:false`。 */
  bigIntake?: BigIntakeConfig;
  /** 系统提示的**分块视图**(2026-10-29 token 轮 04):与 `system` 同一内容,只是保留了节边界。
   *
   *  为什么需要:system 变更时旧实现把整篇 26~28K 字符全量重发成一条 user 消息
   *  (`[系统提示更新] …`),实测 855 次调用占全部未命中 token 的 **39.5%**(8.3M uncached,
   *  脚本 .genie/tmp/agent-eff/analyze15.py)。其中绝大多数变更只涉及一两节(AGENTS.md 摘要 /
   *  memory revision / 技能索引新增),其余节逐字节相同——重发它们纯属白烧。
   *
   *  给了它之后:变更注入只带**与首版不同的节**(基线=本 loop 首次见到的 sections,跨 turn 保持),
   *  无节变化=零追加。不传(旧构造点/测试)=逐字节退回全文注入,行为不变。 */
  systemSections?: SystemSectionRef[];
  /** 增长突增软阈值(tokens):单步新增 ≥ 此值时,本步改用激进组清理(0/未配置=关闭)。
   * 由装配方按上下文预算配置;纯阈值组清理无法感知「单步突然灌入一大坨」,这是补的速率维度。 */
  growthSpurtTokens?: number;
  /** 增长突增时保留最近 N 组工具结果(缺省 2;仅 growthSpurtTokens 生效时使用)。 */
  aggressiveKeepRecent?: number;
  /** 每步新增预算比例(2026-11-06 用户口径 1~2%,缺省 1.5%):单个工具结果超过
   *  max(比例×上一步上下文, 下限) 即走写时 spill 落盘定形(留短 stub + 文件指针),
   *  **不是**先全量进上下文再靠 prune 减回去。仅在配置了 `spill` 时生效(否则无落盘点,行为不变)。 */
  growthBudgetRatio?: number;
  /** 每步新增预算下限(tokens,缺省 1_500)。 */
  growthBudgetMinTokens?: number;
  /** 上下文模型评分(Phase 1/2):默认本地 150M Jev;shadow 只记录,active 参与剪枝。 */
  modelScoring?: ModelScoringConfig;
  /** todo 提醒节奏(designs/25 ZCode todo reminder):每 N 步向对话注入一次未完成计划提醒(ephemeral 不落 journal);缺省 6,0=关闭。 */
  todoReminderSteps?: number;
  /** step-137 上下文再锚定:每 N 步注入一次「P0 落目标清单+证据覆盖率」提醒(ephemeral 不落 journal)。
   * 文本由装配方注入(运行时层不认识白板存储,保持零依赖);返回 null/空=本步不注入。缺省 0=关闭。 */
  boardReminderSteps?: number;
  boardReminder?: () => string | null | Promise<string | null>;
  /** 待决审批注入(2026-11-03 token 治理):每 step 组装消息时调用,返回非空=作为 ephemeral
   * user 消息注入(不落 journal,与 todo/board 提醒同机制)。旧口径把审批块以 message.user
   * **永久落** journal,deriveMessages 无条件重放 → 已了结的审批块在 172 个请求里重复出现
   * (2.7M token/日,占注入总量 39.6%),还诱导模型对已结束的请求反复应答。改为 ephemeral 后:
   * 待决期间逐步可见(模型随时可应答),了结即消失。缺省 undefined=零注入,旧行为不触发。 */
  pendingQuestions?: () => string | null;
  /** tips 即时信息增强(2026-10-21 用户口径「做哪类事之前再注入,不一股脑开工全塞」):
   * 每 step 组装消息时调用,ctx 带上一步实际执行的工具名清单;返回非空=作为 ephemeral
   * user 消息注入(不落 journal,与 todo/board 提醒同机制)。触发条件/一次为限等策略
   * 全在装配方(运行时层不认识经验库/白板,保持零依赖);异常吞掉绝不打断主链。
   * ctx.compacts=本会话 compact.done 事件计数(真压缩边界;microcompact 不落事件不计)——
   * 装配方据此在 compact 后清空「已注入」状态,允许重注入一次(tip 是 ephemeral,压缩后失忆)。
   * 返回值可为 {text,keys}:keys=本步注入的 tip 类别名(code-orient/history-align/dispatch/…),
   * 供 `tip.injected` 留痕事件分类展示;返回裸 string 等价 keys=[]。
   * 注意:注入仍是 ephemeral——留痕事件只给面板看,deriveMessages 不读(2026-10-22 可见化)。 */
  tips?: (ctx: {
    step: number;
    lastStepTools: string[];
    /** 上一步工具调用涉及的文件夹具参数(path/file_path/file;解析失败吞)。 */
    lastStepFiles: string[];
    /** 本 turn 累计工具错误数(lastStepError 置 true 的次数)。 */
    totalErrors: number;
    compacts: number;
    phase?: string;
    lastStepError?: boolean;
    /** 本 turn 累计 usage tokens(按 provider 返回累加;装配方可用它与 gate 对齐节奏)。 */
    tokensSpent: number;
    /** 注入闸本体(见 inject-gate.ts):装配方按提示词类别当 key 做 ≥10k token 间隔。 */
    gate: InjectGate;
    /** 最近一条轨迹卡的摘要行(≤120 字;未落过=undefined)。 */
    trajectory?: string;
  }) => string | TipInjection | null;
  /** SOP 阶段信号(2026-11 tips SOP 化):每 step 组装 tips ctx 时调用,返回当前阶段 key
   *  (understand/plan/implement/verify/close 等);不传=无阶段信号(旧调用方零行为变化)。
   *  只在 loop 运行时被调,装配方可用闭包读晚期初始化的状态。 */
  tipsPhase?: () => string | undefined;
  /** 轨迹卡节奏(J1,2026-11 token 轮):每 N 步向 journal 旁路落一条 `task.trajectory`
   *  (payload=步/工具类别计数/并行率/错误/重试/tokens/阶段/子目标,不含对话正文)。
   *  缺省 0=关闭(旧调用方零行为变化);phase 变化时立即落一条(不等到第 N 步)。 */
  trajectorySteps?: number;
  /** 轨迹卡的阶段/子目标来源(装配方闭包读 SOP 阶段与当前子目标;缺省=无,subgoal 落 "")。 */
  trajectoryMeta?: () => { phase?: string; subgoal?: string };
  /** 轨迹卡的任务归属(装配方按当前任务书返回 taskId;缺省=不带 taskId 键)。 */
  trajectoryTaskId?: () => string | undefined;
  /** 轨迹卡回调(J1 接线闭环,2026-11):**只在 emitTrajectory 真正 due 的那次**触发
   *  (每 N 步或 phase 切换,不是每步),payload 与 journal 的 task.trajectory 同源。
   *  装配方据此把任务进度(phase/step/note)touch 到 TaskSupervisor;必须自己 try/catch,
   *  loop 侧也包一层——回调抛错不打断主链。缺省不配置=零行为变化。 */
  onTrajectory?: (ev: {
    taskId?: string; step: number; turn: number; phase?: string; subgoal: string;
    tokensSpent: number; errors: number; steps: number; tools: Record<string, number>;
  }) => void;
  /** 流式回调(step-050):LLM 增量与工具起止的旁路通知;不落 journal(持久层语义不变)。 */
  onStream?: (e: AgentStreamEvent) => void;
  /** LLM 调用轨迹回调(step-132):每 step chat 完成后上报 LlmCallTrace(全量 messages+响应);
   * 轨迹是旁路——回调内异常吞掉不碰主链;缺省不配置=零行为变化。 */
  llmTrace?: (info: LlmCallTrace) => void;
  /** 时间盒收敛提醒(2026-10-19,子代理 deadline):epoch ms。剩余 ≤ deadlineWarnMs 时向本步
   * 注入一次临时提醒(ephemeral 不落 journal),强制「先输出结论、别再检索」。实锤:子代理用满
   * 时间盒、76 步、零文本产出,收割时只有「尚无模型文本输出」。 */
  deadlineAt?: number;
  /** 收敛提醒的提前量(ms,缺省 120000)。 */
  deadlineWarnMs?: number;
  /** 权限闸门(step-033):规则在场时每个工具执行前三态判定;
   * undefined=不设闸(行为与旧版一致)。ask 的应答由 askMode 决定(fail-closed 缺省)。 */
  permission?: {
    rules: import("@lampgenie/core").PermissionRule[];
    /** ask 命中的处置:缺省 deny(无人应答按拒绝,dsh fail-closed 纪律)。 */
    askMode?: "deny" | "allow";
    /** ask 命中的审批回调(权限传递收口):提供时 ask 交其裁决(true=放行,拒绝/异常=按拒绝),
     * askMode 不再兜底——主 loop 的面板审批链与子 loop 的父会话审批链都走这里。 */
    onAsk?: (call: ToolCall) => Promise<boolean>;
    /** 重操作闸(step-071 父子 ask-answer):**只给子代理 loop 配**(主 loop 不配=父代理自身
     * 同命令不受闸)。调用方是子代理且工具参数带 command 字符串、判重命中且未豁免时,
     * 绕过 allow 规则强制走 onHeavyAsk(build/install/全量测试类大资源操作必须先经父代理同意);
     * onHeavyAsk 缺省/拒绝/异常=按拒绝(fail-closed)。deny 规则仍是硬顶(本闸在后段规则求值之前,
     * 父批准后 deny 命中照样拦)。缺省不配置=零行为变化。 */
    heavyOp?: {
      callerIsSubagent: boolean;
      /** 判定表(缺省 core DEFAULT_HEAVY_OP_RULES;可注入自定义/收窄)。 */
      rules?: import("@lampgenie/core").HeavyOpRule[];
      /** 豁免模式(缺省 core DEFAULT_HEAVY_OP_EXEMPTS;命中即放行不判重)。 */
      exemptPatterns?: string[];
      /** 强制审批回调:父 agent 决策通道(true=放行)。缺省=拒绝(fail-closed,无人应答按拒绝)。 */
      onHeavyAsk?: (call: ToolCall, match: import("@lampgenie/core").HeavyOpMatch) => Promise<boolean>;
    };
  };
  /** waterfall 拦截链(step-008 二期收口,designs/14 §1.2 四拦截点;全部可选,缺省行为与旧版一致)。
   * 契约:监听器显式调用 next() 才放行——不 next 即拦截(dsh 三域事件对齐)。 */
  waterfall?: {
    /** agent/pre-step:turn 输入进 journal 前调用;next() 放行(可带改写输入),不 next=拦截本轮。 */
    preStep?: (
      ctx: { turn: number; userText: string; images?: string[] },
      next: (rewritten?: { userText: string; images?: string[] }) => Promise<void>,
    ) => Promise<string | undefined>;
    /** tools/pre-execute:权限内层照常生效;next() 执行工具并返回其结果,不 next 返回替代文本=拦截/代答。 */
    preExecute?: (call: ToolCall, next: () => Promise<string>) => Promise<string>;
    /** tools/post-execute:改写/截断/脱敏工具结果;返回新文本(原样返回=透传)。 */
    postExecute?: (call: ToolCall, result: string, meta: { durationMs: number }) => Promise<string> | string;
    /** agent/turn-stopping:每 step 收尾后评估;stop=true 终止 turn(reason 落 step.end/turn.end)。 */
    turnStopping?: (ctx: { turn: number; step: number; finalText: string }) =>
      Promise<{ stop: boolean; reason?: string }> | { stop: boolean; reason?: string };
  };
}

/** 消息 tokens 快估。
 *  2026-11-03 token 轮:assistant 的 `toolCalls[].arguments` **计入**(同系数)——write_file 的整文件
 *  正文全在 arguments 里,旧口径只累加 `content.length`,写文件型膨胀对增长突增/阈值判定完全隐形。
 *  2026-11 token 轮:token 口径统一见 agent/token-estimate.ts(真分词器 + 标定 ratio),
 *  本函数只做转调,不再自带字符系数。 */
export function estimateMessagesTokens(messages: readonly Message[]): number {
  return estimateMessagesTokensUnified(messages);
}

/** system 变更转追加的成本守卫系数(designs/token-opt-round3-p1 §4,U1=A,2026-10-28 code_review 修量纲)。
 *  量纲:**两侧都是 tokens**。左=历史 tokens(`estimateMessagesTokens`),右=一份 system 的 tokens
 *  (`ceil(system.length/4)`)× 本系数。
 *  依据:追加段每步随请求重发,保住的缓存前缀也每步受益,故两者同量纲、直接比较——只有
 *  「历史 tokens ≫ system tokens」时,保住前缀的收益才确定大于多付一份 system 的成本。
 *  系数取 2:产线 system 实测 20.8k~25k 字符(≈5.2k~6.3k tokens),门 ≈10.4k~12.6k tokens 历史;
 *  低于此(典型:任务首轮/短历史)退回旧行为。取 2 而非 1 是给「每步重发 vs 缓存折价」留余量。 */
const SYSTEM_UPDATE_GATE_RATIO = 2;

/** 系统提示变更追加消息的前缀(designs/token-opt-round3-p1 未决问题 U2=A):
 *  user 角色 + `[系统提示更新]` 前缀——与本仓 `[系统提醒]` 中段注入约定一致(OpenAI 兼容端点
 *  对中段 system 的容忍度不一,user 快照最稳);"与此前冲突时以本条为准"给模型明确的覆盖语义。 */
const SYSTEM_UPDATE_PREFIX = "[系统提示更新] 以下为本轮生效的系统提示,与此前冲突时以本条为准:\n";

/** 节级增量注入前缀(token 轮 04):只带**变更过的节**,每节前加 `## <name>` 标明归属。
 *  与全文前缀分开用不同字面,便于从 trace 里直接分辨「这次是增量还是全量」。 */
const SYSTEM_SECTION_UPDATE_PREFIX =
  "[系统提示更新] 以下小节已变更,与此前冲突时以本条为准(未列出的小节保持原样):\n";

/** 节片段渲染规则(标题去重,2026-10-30 修 f2)随 M125 迁到 system-context-generation.ts 的
 *  `renderSection`,与三态 reconcile 同源;loop 侧不再保留本地实现。
 *
 *  规则仍要记住:有些节的内容**自带 markdown 标题**——最典型的是 `dateBlock`,内容本身就是
 *  `\n\n## 当前日期\n2026-10-30(周五)`。固定拼 `## ${name}` 会产出双层标题:
 *  ```
 *  ## date
 *             ← 空行
 *  ## 当前日期
 *  ```
 *  既多花十几个字符,也让模型看到两个标题、不确定哪个才是节名。故内容以 `## ` 开头(允许前导
 *  空白/换行)时不再加节名——节名只是内部 diff 的键,不必暴露给模型。
 */

/** node0 冻结基线(system 提示词 in-history,token 轮 P1 §3 02):
 *  取该 session **第一条** `system.prompt` 快照的 payload.text;没有(旧 journal / 测试直接构造
 *  loop / 首条被截断)→ 返回 undefined,调用方用当轮 system 兜底(行为与改前逐字一致)。
 *  首条即定案:首条若 truncated 就**不再往后找**——往后找会把较晚版本的 system 当 node0,
 *  偏离「冻结首轮」语义(且多快照会话里会让 node0 随会话演进而漂移)。 */
export function headSystemSnapshotOf(journal: Journal, sessionId: string): string | undefined {
  for (const e of journal.readSession(sessionId)) {
    if (e.kind !== "system.prompt") continue;
    const p = e.payload as { text?: unknown; truncated?: unknown };
    if (p.truncated === true) return undefined; // 首条被截断:正文短于真实 system 会静默丢规则,退回 fallback
    if (typeof p.text === "string" && p.text.length > 0) return p.text;
    return undefined; // 首条快照空文本=异常数据,同样退回 fallback(不猜)
  }
  return undefined;
}

/** 节内容指纹(节 diff 用)已随 M125 迁到 system-context-generation.ts 的 `sectionSha`,并在本文件
 *  顶部 re-export(既有导入面不变)。
 *
 *  实现要点仍要记住:**不用 node:crypto** —— 只需「内容变没变」的等价判定,非加密用途;
 *  FNV-1a 32 位足够且零依赖(避免 runtime 为省 token 的旁路功能引入 crypto 依赖)。
 *  碰撞后果可控:撞了=该节变更没被下发,下一次内容变化仍会命中(不同内容几乎不可能持续同 hash)。
 */

/** 节基线事件的落账标记(payload.what;用 custom kind 免改 core 的 EventKind 枚举)。 */
const SECTIONS_BASELINE_WHAT = "system.sections.baseline";

/** 读该 session 的节基线(每节 sha)。无基线=undefined(首见)。
 *
 *  **只存 sha 不存正文**:基线正文与 node0 的 system.prompt 快照重复(那份已有全文),
 *  再存一份只会让 journal 变胖、且是该会话敏感内容的第二处暴露面。 */
export function readSystemSectionsBaseline(journal: Journal, sessionId: string): Map<string, string> | undefined {
  const events = journal.readSession(sessionId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "custom") continue;
    const p = e.payload as { what?: unknown; shaByName?: unknown };
    if (p.what !== SECTIONS_BASELINE_WHAT) continue;
    const rec = p.shaByName as Record<string, unknown> | undefined;
    if (!rec || typeof rec !== "object") return undefined;
    const out = new Map<string, string>();
    for (const [k, v] of Object.entries(rec)) if (typeof v === "string") out.set(k, v);
    return out;
  }
  return undefined;
}

/** 落节基线(**只在没有基线时写一次**;幂等键按 session 固定,永不更新)。
 *
 *  为什么不更新:基线必须恒等于「node0 那一版」。[系统提示更新] 是 ephemeral(不落 journal),
 *  历史里永远没有它;若基线随变更推进,下一轮 diff 就变空 → 模型静默收不到变更。
 *  「基线不可变 + 每轮重算 diff」是唯一自洽的口径:每轮都在把「当前节 vs node0 节」的差重发一遍,
 *  开销 = 变更节大小(几百~几千字符),远低于旧口径整篇 26~28K。 */
export function recordSystemSectionsBaseline(
  journal: Journal, sessionId: string, sections: readonly { name: string; content: string }[],
): void {
  const shaByName: Record<string, string> = {};
  for (const s of sections) shaByName[s.name] = sectionSha(s.content);
  journal.append({
    kind: "custom",
    sessionId,
    payload: { what: SECTIONS_BASELINE_WHAT, shaByName },
    // 幂等键固定:同 session 第二次写被 journal 丢弃(基线不可变由幂等键强制)。
    idempotencyKey: `system.sections.baseline.${sessionId}`,
  });
}

/** 激活集事件的落账标记(payload.what;同节基线用 custom kind 免改 EventKind 枚举)。 */
const ACTIVATED_TOOLS_WHAT = "activated.tools";

/** 读该 session 已激活工具集(无事件=空集;升级兼容:老 journal 无此事件→回落既有重建路径)。
 *  与 readSystemSectionsBaseline 同族(custom kind + payload.what + 按 session 幂等),但语义不同:
 *  激活集是**单调集合**,故按**工具名**幂等落事件(一名字一条,重复激活不新增事件),读取侧取并集。
 *  (不能照抄基线那种「session 级固定幂等键」——那个幂等键=首写生效,后续激活会被 journal 丢弃。)
 *  未知/空名字静默跳过(标记是机制不是指令)。 */
export function readActivatedTools(journal: Journal, sessionId: string): Set<string> {
  const out = new Set<string>();
  let events: ReturnType<Journal["readSession"]>;
  try {
    events = journal.readSession(sessionId);
  } catch {
    return out; // journal 读失败=按空集处理(等价首见),主链不打断
  }
  for (const e of events) {
    if (e.kind !== "custom") continue;
    const p = e.payload as { what?: unknown; names?: unknown };
    if (p.what !== ACTIVATED_TOOLS_WHAT || !Array.isArray(p.names)) continue;
    for (const n of p.names) if (typeof n === "string" && n) out.add(n);
  }
  return out;
}

/** 落激活集(按工具名幂等:同 session 同一名字只落一条,集合单调增长故无需覆盖写)。
 *  事件数上限=该 session 激活过的工具种类数(几十量级),不会随步数膨胀。 */
export function recordActivatedTools(journal: Journal, sessionId: string, names: Iterable<string>): void {
  const list = [...new Set(names)].filter((n) => typeof n === "string" && n).sort();
  for (const name of list) {
    journal.append({
      kind: "custom",
      sessionId,
      payload: { what: ACTIVATED_TOOLS_WHAT, names: [name] },
      idempotencyKey: `activated.tools.${sessionId}.${name}`,
    });
  }
}

/** 节增量([系统提示更新] delta)的落账标记(payload.what;同族 custom kind)。 */
const SYSTEM_DELTA_WHAT = "system.delta";

/** 读该 session **最近一次已落账**的 delta 指纹与 seq(无=undefined)。
 *
 *  为什么 delta 必须落 journal(2026-11 token 轮 P2,产线实测 `web-1793352189337`):
 *  delta 曾是 ephemeral——只拼进本次请求、不落 journal,于是下次 deriveMessages 重建历史时
 *  它根本不存在 → 每步都得再 push 一遍,且位置在历史末尾之后=命中不了缓存,**每步全额 uncached**。
 *  该会话 930 次 LLM 调用里 delta 内容只变过 11 种(11 个 md5),却重发 930 次,
 *  单次 17,306 字符≈7,210 tok,累计≈5,831,843 tok,占每步 uncached 的 69~75%。
 *  落账后 delta 成为**持久历史**的一部分(deriveMessages 重放),内容不变即零重投。
 *
 *  只存 sha+seq 供判定;正文另存 payload.text(derive 需要全文重放)。
 *
 *  **一次倒扫拿齐两个判据**(热路径:每步都调,不能扫两遍):
 *  - `landed` = 最近一条 delta 的 sha 与 seq(无=undefined);
 *  - `hardCompactSeq` = 最近一次真压缩边界的 seq(无=0)。判据与 deriveMessages 逐字一致:
 *    只认 `payload.summary` 非空的 compact.done(旧 microcompact 曾写无摘要占位,derive 已显式
 *    排除,这里也必须排除——否则每次无摘要占位都触发一次无谓重投)。
 *  两者齐备即提前收工(通常 1~3 个事件)。 */
export function readSystemDeltaState(
  journal: Journal, sessionId: string,
): { landed?: { sha: string; seq: number }; hardCompactSeq: number } {
  const events = journal.readSession(sessionId);
  let landed: { sha: string; seq: number } | undefined;
  let hardCompactSeq = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "compact.done") {
      if (hardCompactSeq > 0) continue;
      const s = (e.payload as { summary?: unknown }).summary;
      if (typeof s === "string" && s.trim().length > 0) hardCompactSeq = e.seq;
      continue;
    }
    if (e.kind !== "custom" || landed !== undefined) continue;
    const p = e.payload as { what?: unknown; sha?: unknown };
    if (p.what !== SYSTEM_DELTA_WHAT) continue;
    if (typeof p.sha === "string") landed = { sha: p.sha, seq: e.seq };
  }
  return { landed, hardCompactSeq };
}

/** 落一条 delta(全文 + 指纹)。
 *
 *  幂等键含「已落条数」而非仅 sha:同内容重复落账不新增(正常路径根本不会走到——内容没变
 *  调用方就不落),但**真压缩之后**必须允许同内容再落一条(压缩边界之前的旧事件被
 *  deriveMessages 的 out.length=0 抹掉,不重落=模型静默失忆)。 */
export function recordSystemDelta(journal: Journal, sessionId: string, text: string): number {
  const sha = sectionSha(text);
  let n = 0;
  for (const e of journal.readSession(sessionId)) {
    if (e.kind === "custom" && (e.payload as { what?: unknown }).what === SYSTEM_DELTA_WHAT) n++;
  }
  const ev = journal.append({
    kind: "custom",
    sessionId,
    payload: { what: SYSTEM_DELTA_WHAT, sha, text },
    idempotencyKey: `system.delta.${sessionId}.${sha}.${n}`,
  });
  return ev.seq;
}

/** 该 session 最近一次**真压缩**边界的 seq(无=0)。判据见 readSystemDeltaState(两者同源)。 */
export function latestHardCompactSeq(journal: Journal, sessionId: string): number {
  return readSystemDeltaState(journal, sessionId).hardCompactSeq;
}

/** todo 提醒文本(designs/25,ZCode todo reminder 语义):计划未完时生成 ephemeral 提醒;无待办=空。 */
export function buildTodoReminder(journal: Journal, sessionId: string): string | null {
  const events = journal.readAll();
  let items: { content: string; status: string }[] | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.sessionId === sessionId && e.kind === "todo.updated") {
      items = ((e.payload as { items?: { content: string; status: string }[] }).items ?? []) as { content: string; status: string }[];
      break;
    }
  }
  if (!items || items.length === 0) return null;
  const open = items.filter((i) => i.status !== "completed");
  if (open.length === 0) return null;
  const lines = open.slice(0, 8).map((i) => `- [${i.status === "in_progress" ? "进行中" : "待办"}] ${i.content}`);
  return ["<system-reminder>", "当前工作计划还有未完成项:", ...lines, "进度有变化时用 todo_write 更新状态;全部完成前不要提前收尾。", "</system-reminder>"].join("\n");
}

/** 从 journal 重建消息列表(deriveMessages)。 */
export function deriveMessages(journal: Journal, sessionId: string): Message[] {
  const out: Message[] = [];
  // 音频回放收敛(2026-10-21):journal 全量落音频,但 derive 只保留**最新一条**带音频的 user 消息——
  // 历史轮的音频降级为其文本占位(语音轮的占位即「(语音输入)」),防多轮后全量回放请求被 b64 撑爆。
  const audioIdx: number[] = [];
  // 视觉回放收敛(2026-10-25 view_image;2026-11 token 轮 02 改为 turn 口径):
  // journal 全量落 dataUrl,derive 只回收**上一 turn 及更早**的图——同 turn 内一律保留 dataUrl。
  // 旧口径「只保留最新一张」会在同一 turn 内每新增一张图就重写历史中段(实测放大 132×),
  // 提示缓存整段失效。图→turn 归属按事件序推:落在哪个 `turn.start` 之后就属哪个 turn
  // (message.user / tool.result 的 payload 无 turn 字段,补字段会波及 journal schema 与老 journal 兼容)。
  const visionEntries: { idx: number; turn: number; step: number }[] = [];
  let currentTurn = 0;
  /** 当前 step 号(最近一个 `step.start.payload.step`);vision epoch 回收按它分桶。
   *  缺失(旧 journal 无 step.start)=0,与 currentTurn=0 同款兜底语义。 */
  let currentStep = 0;
  /** 事件流里是否真出现过带数字 turn 的 turn.start。false=旧 journal/缺字段:turn 归属无从判定,
   *  currentTurn 恒 0 会让「turn >= lastTurn」恒真 → 一张图都不回收(静默退化成永不裁剪,
   *  迟早把请求顶到端点上限),见下方回收分支的旧口径兜底。 */
  let sawTurnBoundary = false;
  // M29 冷恢复过滤:被 stream.attempt.discarded 作废的 attemptId 的 message.agent 不进上下文;
  // 已提交的 tool.result 原样保留;无作废标记时 filterDiscarded 原样返回(未作废会话逐字节不变)。
  for (const e of filterDiscarded(journal.readAll())) {
    if (e.sessionId !== sessionId) continue;
    const p = e.payload as Record<string, unknown>;
    switch (e.kind) {
      case "turn.start":
        // 当前 turn 号=最近一个 turn.start 的 payload.turn(loop :561 写入);判断回收只认这个。
        if (typeof p.turn === "number") {
          currentTurn = p.turn;
          sawTurnBoundary = true;
        }
        break;
      case "step.start":
        // vision epoch 分桶用(loop runTurn 写 step.start.payload.step)。缺失=0,同 currentTurn 兜底语义。
        if (typeof p.step === "number") currentStep = p.step;
        break;
      case "message.user": {
        const audio = p.audio as AudioInput | undefined;
        const imgs = Array.isArray(p.images) ? (p.images as string[]) : undefined;
        out.push({
          role: "user",
          content: String(p.text ?? ""),
          ...(imgs?.length ? { images: imgs } : {}),
          ...(audio && typeof audio.data === "string" && audio.data ? { audio } : {}),
        });
        if (imgs?.length) visionEntries.push({ idx: out.length - 1, turn: currentTurn, step: currentStep });
        if (audio && typeof audio.data === "string" && audio.data) audioIdx.push(out.length - 1);
        break;
      }
      case "message.agent":
        out.push({
          role: "assistant",
          content: String(p.text ?? ""),
          toolCalls: p.toolCalls as ToolCall[] | undefined,
          // thinking 模式历史必须回传 reasoning_content(2026-11):旧 journal 无该字段=不带。
          ...(typeof p.reasoning === "string" && p.reasoning ? { reasoning: p.reasoning } : {}),
        });
        break;
      case "tool.result": {
        // M115 循环护栏:模型可见文本优先取 payload.modelContent(结果去重 stub);journal 原文仍在 content。
        out.push({ role: "tool", toolCallId: String(p.toolCallId), content: String(p.modelContent ?? p.content ?? "") });
        // 视觉桥(2026-10-25,对齐 ZCode tool-result-media-projection):view_image 落账的
        // payload.images 投影为后置 user 消息——OpenAI 系 tool content 不支持 image_url,
        // 图片必须走 user 消息多模态 content(工具结果自身保留确认文本)。
        const timgs = Array.isArray(p.images) ? (p.images as string[]) : undefined;
        if (timgs?.length) {
          out.push({ role: "user", content: "[视觉注入] " + String(p.content ?? "图片已注入"), images: timgs });
          visionEntries.push({ idx: out.length - 1, turn: currentTurn, step: currentStep });
        }
        break;
      }
      case "message.system":
        // step-048 审计修复③:会话中部的系统提醒以 user 角色注入(opencode synthetic user part 语义)——
        // OpenAI 兼容端点对中段 system 消息的容忍度不一,部分严格 chat template 会拒/降智。
        out.push({ role: "user", content: "[系统提醒] " + String(p.text ?? "") });
        break;
      case "compact.done":
        // step-048:压缩边界=硬截断——边界前的全部消息丢弃,摘要经随后的 message.system 重注入。
        // 此前不截断=压缩只是「加摘要不减上下文」(容量管理空转)。
        // step-058:只认带摘要的真压缩边界——旧 microcompact 曾写无摘要的 compact.done(占位
        // 机制遗留),被当成边界=恢复旧会话时上下文再次被清空。真压缩恒有摘要,以此区分。
        // 2026-10-22 修「主动 /compact 感觉没运行」②:边界口径=**清空历史 + 重放 tail + 重注入摘要**。
        // 旧实现只清空不重放:autoCompact 声称「最近 N 条原文保留」,但 tail 只活在 compact.done
        // 之前的旧事件里,被 out.length=0 一并抹掉 → 压缩后模型失忆(只剩一句摘要)。
        // 现在 payload.tail 携带可重建消息数组,清空后逐条回放;其后的 message.system 照旧重注入摘要。
        if (typeof p.summary === "string" && (p.summary as string).trim().length > 0) {
          out.length = 0;
          // 压缩边界后旧下标全部失效(消息数组被清空重放)——清空 idx 账,防回收改错消息。
          // audioIdx 必须一起清:漏清时末尾 audioIdx.slice(0,-1) 会拿陈旧下标去删重放后另一条
          // 消息的 audio(索引错位=静默删错,或全长时静默漏删)。
          visionEntries.length = 0;
          audioIdx.length = 0;
          // tail 防御性校验:role 必须三选一、content 必须字符串(坏数据跳过,不污染重放)。
          const tail = Array.isArray(p.tail) ? (p.tail as Record<string, unknown>[]) : [];
          for (const t of tail) {
            const role = t?.role;
            if (role !== "user" && role !== "assistant" && role !== "tool") continue;
            if (typeof t.content !== "string") continue;
            if (role === "tool") {
              if (typeof t.toolCallId !== "string") continue;
              out.push({ role: "tool", toolCallId: t.toolCallId, content: t.content });
            } else if (role === "assistant") {
              const calls = Array.isArray(t.toolCalls) ? (t.toolCalls as ToolCall[]) : undefined;
              out.push({ role: "assistant", content: t.content, ...(calls?.length ? { toolCalls: calls } : {}) });
            } else {
              out.push({ role: "user", content: t.content });
            }
          }
        }
        break;
      case "custom":
        // [系统提示更新] 节增量的重放(token 轮 P2,2026-11-02):delta 从 ephemeral 改为持久历史。
        // 见 readSystemDeltaLanded 注释:旧口径每步重发同一份 delta(产线单会话 930 次调用里内容
        // 只变过 11 种),且位置在历史末尾之后 → 每步全额 uncached(占 uncached 69~75%)。
        // 现在落账一次、按 seq 原位重放一次,后续步骤零重投。
        if (p.what !== SYSTEM_DELTA_WHAT) break; // 其他 custom 事件(基线/激活集等)与上下文无关
        if (typeof p.text === "string" && p.text.length > 0) out.push({ role: "user", content: p.text });
        break;
    }
  }
  if (audioIdx.length > 1) {
    for (const i of audioIdx.slice(0, -1)) delete (out[i] as { audio?: AudioInput }).audio;
  }
  // 视觉回放收敛(turn 边界口径,token 优化轮 02):回收**当前 turn 之前**的图,以及同 turn 内
  // 超过上限的旧图——删 dataUrl、文本换占位(模型仍可再 view_image);保留下来的图 dataUrl 原样,
  // 这样同一 turn 内连续 view_image 时请求前缀逐字节稳定(旧口径每加一张图就重写历史中段,放大 132×)。
  const lastTurn = currentTurn;
  /** 视觉 epoch 桶宽(2026-10-29 token 轮 04,实测归因最大项 48.5%)。
   *
   *  病根(旧口径):回收按「同 turn 只留最新 2 张」——同一 turn 里每看第 3 张图,就把历史
   *  中段的第 1 张改写成占位,请求前缀从该位置起逐字节不同 → 整条历史重新计费。实测 PPT 校对
   *  会话(web-1793246472452)583 次调用里 **479 次**落入这一类,单次 21,368 uncached,
   *  合计 10.2M uncached = 全部未命中 token 的 48.5%(脚本 .genie/tmp/agent-eff/analyze15.py)。
   *
   *  改法:回收粒度从「每张图」放宽到「每 VISION_EPOCH_STEPS 步 + 批量裁剪」——同 epoch 内新增
   *  图只追加、不改写历史;只有候选池超过 MAX_VISION_KEEP 时才一次裁到 MAX_VISION_KEEP_AFTER,
   *  即**每 5 张图才失效一次前缀**(旧口径每张一次)。一张图最长存活 2 个 epoch(≈40 步),容量有界。
   *
   *  为什么用 step 而不是别的维度:step.start 已在 journal 里逐事件可见(loop runTurn 写
   *  payload.step),deriveMessages 本来就在全量扫事件流,加一个计数器零额外 IO。 */
  const VISION_EPOCH_STEPS = 20;
  /** 候选池上限:同 turn + 最近 2 个 epoch 内的图若不超过此数,全部保留(前缀绝对稳定)。
   *  取 8 是容量/频次权衡:8 张图常驻约 12K token(单图 ~1.5K),而一次前缀失效实测代价
   *  21,368 uncached token——宁可多常驻几张,也别反复改写历史。 */
  const MAX_VISION_KEEP = 8;
  /** 超过候选池上限时批量裁剪到的张数。一次删多张、只失效一次前缀;裁到 4 使下次裁剪间隔 ≈5 张
   *  (旧口径间隔 1 张)。 */
  const MAX_VISION_KEEP_AFTER = 4;
  const keepVision = new Set<number>(); // visionEntries 下标(=保 dataUrl 的图)
  if (!sawTurnBoundary) {
    // 兜底(旧 journal):事件流里没有任何带数字 turn 的 turn.start 时,turn 归属无从判定,
    // currentTurn 恒 0 会让「turn >= lastTurn」恒真 → 一张图都不回收,静默退化成永不裁剪。
    // 这里退回 turn 口径引入前的旧行为:只保留最新一张图,更早的全部回收占位。
    if (visionEntries.length > 0) keepVision.add(visionEntries.length - 1);
  } else {
    // epoch 口径(两步):
    // ① 先按「turn=当前 turn 且 epoch ≥ 当前-1」圈定候选——跨 turn 或跨 2 个 epoch 的图一律回收,
    //    这一刀只在 turn 边界/epoch 边界发生,不会因为「又看了一张图」而触发。
    // ② 候选超过 MAX_VISION_KEEP 时才批量回收到 newest MAX_VISION_KEEP_AFTER 张——**一次删多张**
    //    只让前缀失效一次,而不是像旧口径那样每来一张新图就失效一次(1/张 → 1/批)。
    // 上一 epoch 也留在候选里:刚看过、模型可能还在推理的图不该在桶边界一到就立刻失忆。
    const curEpoch = Math.floor(currentStep / VISION_EPOCH_STEPS);
    const cand: number[] = [];
    for (let i = 0; i < visionEntries.length; i++) {
      const v = visionEntries[i]!;
      if (v.turn < lastTurn) continue;
      if (Math.floor(v.step / VISION_EPOCH_STEPS) >= curEpoch - 1) cand.push(i);
    }
    const keepFrom = cand.length > MAX_VISION_KEEP ? cand.slice(cand.length - MAX_VISION_KEEP_AFTER) : cand;
    for (const i of keepFrom) keepVision.add(i);
  }
  for (let i = 0; i < visionEntries.length; i++) {
    if (keepVision.has(i)) continue;
    const m = out[visionEntries[i]!.idx] as { images?: string[]; content: string } | undefined;
    if (!m?.images?.length) continue;
    delete m.images;
    m.content = "[视觉注入] (历史图片已从上下文移除;需要再看用 view_image)";
  }
  return repairToolPairing(out);
}

/**
 * 工具配对自愈(2026-10-19 用户实报「失败一次就一直卡住一直失败」,实锤阿里云 400:
 * "An assistant message with 'tool_calls' must be followed by tool messages responding to
 * each 'tool_call_id'")。
 *
 * 协议硬约束:assistant(tool_calls) 之后必须紧跟其 id 对应的 tool 消息。但 journal 是
 * append-only 事件流——后台子代理完成通知(message.system)等事件可能在主 agent 等待
 * 工具结果期间插入,重放时正好夹在 assistant 与 tool 之间 → 每个后续 turn 首次调用即 400,
 * 坏历史被无限重放(会话永久卡死)。
 *
 * 自愈:①被夹在中间的 tool 结果前移到 assistant 紧随位置(结果间保持原序);
 * ②真缺失的结果补一条显式占位 tool 消息(标注「结果缺失」)——宁可多一条可见占位,
 * 也不让一条坏历史把整个会话永久锁死。
 *
 * 第 0 遍(2026-10-22 生产 400 实锤「insufficient tool messages following tool_calls」):
 * **重复 assistant 去重**——同 toolCallId 集(保首个,删后续重复副本)。来源=ProxyJournal
 * 回声双入(网关落账重赋 time,worker 回声去重键含 time → 永不命中 → 同一 message.agent
 * 在 worker 副本出现两次)。坏形态:[A, t1-3, A'](A'是回声副本)——第一遍会给 A' 补占位,
 * 但第三遍的同 id 去重又把占位删掉(A' 裸奔) → 端点 400 且坏历史被无限重放。去掉重复
 * assistant 是比修补占位更本质的修法:tool 结果总是配在首个副本之后,保首个两种双入
 * 形态([A,A',t*]/[A,t*,A'])都归约为合法的 [A,t*]。签名=toolCallId 全集(call id 由
 * 端点生成全局唯一,签名碰撞≈0;空 toolCalls 的 assistant 不入此遍)。
 */
/**
 * 视觉尺寸 400 自愈(2026-11-05 事故:view_image 注入 10144x1146 PNG → provider 400
 * `messages[55].image[1]: You have uploaded an unsupported image...`;坏 dataUrl 已进 journal,
 * deriveMessages 每轮重放 → 之后每次「继续」都撞同一 400,会话永久卡死)。
 *
 * 只处理**可判定**的错误:文本含 `unsupported image`。其它 400(参数/协议/tool-pairing)返回 null,
 * 调用方原样抛出——绝不能把无关错误当成图片问题吞掉。
 *
 * 下标映射(实现前已核对适配层):
 *  - openai-provider `toOpenAi` 是 `messages.map` 1:1,system 不剥离,user 的 image_url 下标 j
 *    就是该消息 images[j] → `messages[i]` 可直接定位,清该条全部图(不按 j 单张删:线上报错是
 *    wire 侧序号,0/1-based 与 slice(0,4) 都可能让 j 偏一位,单张删会留下同类坏图)。
 *  - anthropic(`toAnthropicBody`:system 提顶层 + tool 结果折进前一条 user)与 responses
 *    (`toResponsesBody`:toolCalls 拆成多条 function_call)都**不同序** → 下标不可信。
 * 故策略:首次尝试用下标(当且仅当该消息确实带图);拿不到/不匹配则退化为「清空本次请求里
 * 全部带图消息」。第二次(attempt=1)无论下标如何都直接横扫 → 修完请求里 images 总数为 0,
 * 若仍报同类 400 即抛原错(调方重试上限 2 次,收敛有保证)。
 *
 * 就地改 messages(该数组每步由 deriveMessages 重建,不跨步复用);返回 null = 无可修内容。
 */
export function repairUnsupportedImage(
  err: unknown,
  messages: Message[],
  attempt = 0,
): { removed: number; at: number | null } | null {
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (!/unsupported image/i.test(text)) return null;
  const m = /messages\[(\d+)\]\.image\[/.exec(text);
  const idx = m ? Number(m[1]) : null;
  const placeholder = (n: number): string =>
    `[视觉注入] (图片 ${n} 因超出模型尺寸限制已从上下文移除;需要时重新渲染/缩小后再 view_image)`;
  if (attempt === 0 && idx !== null && idx >= 0 && idx < messages.length) {
    const t = messages[idx] as { images?: string[]; content: string } | undefined;
    if (t?.images?.length) {
      const n = t.images.length;
      delete t.images;
      t.content = placeholder(n);
      return { removed: n, at: idx };
    }
  }
  let removed = 0;
  for (const mm of messages) {
    const t = mm as { images?: string[]; content: string } | undefined;
    if (!t?.images?.length) continue;
    const n = t.images.length;
    delete t.images;
    t.content = placeholder(n);
    removed += n;
  }
  return removed > 0 ? { removed, at: null } : null;
}

/**
 * 二次失败包装(M58):第一次的图片预算错误在 offload 后仍复现时,给错误追加一句「图片已 offload,
 * 仍失败」——让调用方/面板知道已经换了无图请求,不再重复消耗 provider 重试预算。
 * 未做过 offload 时**逐字返回原错误**(非图片错误行为零变化)。
 */
function withOffloadNote(err: unknown, applied: boolean): unknown {
  if (!applied) return err;
  const note = "(图片已 offload,仍失败:请求里的图片已落盘为占位文本,重试仍未成功)";
  const base = err instanceof Error ? err.message : String(err ?? "");
  const wrapped = new Error(`${base} ${note}`);
  if (err instanceof Error) (wrapped as Error & { cause?: unknown }).cause = err;
  return wrapped;
}

/**
 * 请求里是否真的带图(M58 触发面判定):只有 user 消息(普通用户输入 + view_image 的
 * [视觉注入] 投影)带 images。无图时图片预算错误**不做** offload/重试,直接抛原错。
 */
export function hasUserImages(messages: readonly Message[]): boolean {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const imgs = (m as { images?: unknown }).images;
    if (Array.isArray(imgs) && imgs.length > 0) return true;
  }
  return false;
}

export function repairToolPairing(messages: Message[]): Message[] {
  // 第 0 遍:重复 assistant(同 toolCallId 集)保首个。
  const seenCallSigs = new Set<string>();
  const deduped: Message[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      const sig = m.toolCalls.map((c) => c.id).sort().join("\0");
      if (seenCallSigs.has(sig)) continue; // 回声/双写产生的重复副本:丢弃(首个已配对)
      seenCallSigs.add(sig);
    }
    deduped.push(m);
  }
  const out = [...deduped];
  for (let i = 0; i < out.length; i++) {
    const m = out[i]!;
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    const want = new Set(m.toolCalls.map((c) => c.id));
    const foundIdx: number[] = [];
    let j = i + 1;
    while (j < out.length && out[j]!.role !== "assistant") {
      const n = out[j]!;
      if (n.role === "tool" && want.has(n.toolCallId!)) foundIdx.push(j);
      j++;
    }
    const found = foundIdx.map((k) => out[k]!);
    const missing = m.toolCalls.filter((c) => !found.some((f) => f.role === "tool" && f.toolCallId === c.id));
    const contiguous = missing.length === 0 && foundIdx.every((idx, k) => idx === i + 1 + k);
    if (contiguous) { i += found.length; continue; }
    const synthetic: Message[] = missing.map((c) => ({
      role: "tool" as const,
      toolCallId: c.id,
      content: "[结果缺失] 该工具调用未返回结果(会话恢复补齐;原调用可能被取消/中断)",
    }));
    const block = [...found, ...synthetic];
    const rest = out.filter((_, idx) => !foundIdx.includes(idx));
    const ai = rest.indexOf(m);
    rest.splice(ai + 1, 0, ...block);
    out.splice(0, out.length, ...rest);
    i = ai + block.length;
  }
  // 第二遍(2026-10-21 实锤 LLM 400「role:'tool' must be a response to a preceding message
  // with 'tool_calls'」):孤儿 tool 消息——其 toolCallId 不被「最近的在前 assistant」认领。
  // 历史丢事件(网关双写/重启去重)会留下这种形态:assistant 消息没了,只剩 tool 结果。
  // 孤儿结果没有对应调用,丢弃无损;留着必然 400 且坏历史被无限重放。
  // 第三遍(2026-10-22 实锤同族 400):**重复 toolCallId**——同一 id 出现多条 tool 消息
  // (journal 重放跨重启边界双写/tool.result 重复追加;llm-trace 实测每次 1-2 条 dup)。
  // 严格端点(DeepSeek/OpenAI strict)对重复 tool 响应报同一句「must be a response to a
  // preceding message」;保首条(原结果)丢后续重复,信息无损。
  const cleaned: Message[] = [];
  const seenToolIds = new Set<string>();
  for (const m of out) {
    if (m.role === "tool") {
      let j = cleaned.length - 1;
      let keep = false;
      while (j >= 0) {
        const prev = cleaned[j]!;
        if (prev.role === "assistant") { keep = !!prev.toolCalls?.some((c) => c.id === m.toolCallId); break; }
        if (prev.role === "user") break; // user 之后的 tool 本就非法
        j--;
      }
      if (!keep) continue;
      if (seenToolIds.has(m.toolCallId!)) continue; // 同 id 重复响应:保首条
      seenToolIds.add(m.toolCallId!);
    }
    cleaned.push(m);
  }
  return cleaned;
}

/** 工具→权限类别别名(双候选之外的第二跳):spawn_subagent/task_output 同属 subagent 族,
 * 规则域按类别名(broker ask 写 "subagent")——派发被允许而收割被拦=后台流半途断死。
 * write_file/edit_file 同属 file.write 族(主 agent 文件写工具):一条规则同时覆盖两个写工具。 */
const TASK_OUTPUT_ALIAS: Record<string, string> = { task_output: "subagent", write_file: "file.write", edit_file: "file.write", remote_write: "file.write" };

/** 轨迹卡单轮上限(J1):一轮内最多落 40 条,防「每步一条」在长 turn 里刷爆 journal。 */
const TRAJECTORY_MAX_PER_TURN = 40;

/** djb2 → 8 位 hex(J1 注入闸的正文指纹):用于 pendingQuestions 的「正文未变才拦」判定。
 *  非加密哈希——只需「正文微变即换 key」,不承担安全职责。 */
function djb2Hex(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export class AgentLoop {
  /** 进程内 turn 序号(journal 事件时间序的唯一性由 seq 保证,这里只做人类可读编号)。 */
  private static turnCounter = 0;
  private opts: AgentLoopOptions;
  private tools: Map<string, Tool>;
  private aborted = false;
  /** M34:本 turn 的取消是否来自用户停止(cancel 记账;runTurn 每轮重置)。 */
  private userStopped = false;
  /** 取消信号链(step-008 二期收口,designs/14 §1.4):cancel() abort 当前 turn 的
   * LLM 请求与工具执行;未派发的工具调用补写 ABORTED_BEFORE_DISPATCH 保证配对。 */
  private ac: AbortController | null = null;
  /** 时间盒收敛提醒只注入一次。 */
  private budgetWarned = false;
  /** 上一步实际执行过的工具名(tips 触发依据;step 0 恒为空)。 */
  private lastStepTools: string[] = [];
  /** 上一步工具结果是否带错(tips SOP 排障卡触发依据;判错口径=ToolExecOutcome.error,
   *  与 tool.result 落账的 `...(r?.error ? { error: r.error } : {})` 同源;step 0 恒为 false)。 */
  private lastStepError = false;
  /** 上一步工具调用涉及的文件夹具参数(path/file_path/file;tips 的「文件相关卡」依据)。 */
  private lastStepFiles: string[] = [];
  /** 本 turn 累计 usage tokens(provider 返回 usage 时累加;注入闸的计时基准)。
   *  与上下文估算器 estimateMessagesTokens 无关:这里是**真实计费口径**,闸要的就是它。 */
  private tokensSpent = 0;
  /** 本 turn 累计工具错误数(lastStepError 每次置 true 累加)。 */
  private totalErrors = 0;
  /** 注入闸(J1):ephemeral 提醒的 ≥10k token 间隔控制,跨 step 共享一份水位表。 */
  private gate: InjectGate = createInjectGate();
  /** 轨迹统计(J1;每 turn 起点清零):工具类别计数 / 调用总数 / 并行步数 / 已统计步数 /
   *  重试次数(emptyTurnRetried) / 上次落卡 step / 上次落卡的 phase / 本轮已落条数 / 摘要行。 */
  private trajToolCounts = new Map<string, number>();
  private trajCalls = 0;
  private trajParallelSteps = 0;
  private trajSteps = 0;
  private trajRetries = 0;
  /** 上次落卡的 step(初值 0:step 从 1 起算,「每 N 步」落在第 N/2N… 步,不是 N-1 步——
   *  初值 -1 会让首条落卡提前一步(实测 step 4 而非 5,J1 复验收口)。step 0 另有 step<=0 早退。 */
  private trajLast = 0;
  private trajLastPhase: string | undefined;
  private trajEmitted = 0;
  private lastTrajectoryText: string | undefined;
  /** 当前执行的 turn/step(txa3,2026-11 轨迹采集):tool.call 在 executeTracked 落账,
   *  那里拿不到 runTurn 的局部 turn/step 变量,故由主循环在每步开始写一次。
   *  仅作归属标注用途:循环是串行推进的(同一步内的并发安全批共享同一 turn/step)。 */
  private curTurn = 0;
  private curStep = 0;
  /** 同参重复检测(2026-10-29 board_read 无限循环事故):上一步的调用签名与连击数。 */
  private lastStepCallSig = "";
  private stepCallStreak = 0;
  /** M115 工具循环护栏:随 turn 生灭(runTurn 开头 new 一个),跨 turn 不累积。 */
  private toolGuard: ToolLoopGuard | undefined;
  /** 已读清单上次注入签名(2026-10-24 变化触发;剥离相对时间后的清单文本)。 */
  private lastReadReminderSig?: string;
  /** 上次见到的 compact.done 计数(读清单的失忆自愈锚:压缩后 ephemeral 消失须重注一次)。 */
  private lastReminderCompacts = 0;
  /** 上次组装前 deriveMessages 的估算 tokens——增长突增判定基线。
   * 不用 provider 的 inputTokens:后者含 system/tools schema,会把「消息内容增长」稀释掉。 */
  private lastContextTokens?: number;
  /** 上下文清单上次注入签名(pruned 集合变化才注入,避免每步复读)。 */
  private lastContextManifestSig?: string;
  /** context.prune 上次留痕签名(pruned 集合变化才落 journal,避免每步刷事件)。 */
  private lastPruneLogSig?: string;
  /** cache-aware 前缀稳定策略状态(2026-11-06 v2):clock 每步 +1;
   *  其余字段首次使用时从 journal 末条 context.prune 播种(跨 loop 实例延续——gateway 每 turn 新建 loop)。 */
  private pruneClock = 0;
  /** 冻结区条数 + 边界 toolCallId(前缀稳定器:只有重置才前移)。 */
  private frozenCount = 0;
  private pruneAnchor?: string;
  /** 上次重置的 clock / 上下文估算(冷却判定基线)。 */
  private lastResetClock?: number;
  private lastResetTokens?: number;
  /** M29:流式 attemptId 计数器(sessionId:turn:step:n)。message.agent 与作废留痕共用同一 id。 */
  private attemptSeq = 0;
  /** 本 turn 已重置次数(turn 首步归零,用户口径同 turn ≤1)。 */
  private resetsThisTurn = 0;
  private pruneStateSeeded = false;
  /** 上一步请求的上下文估算 tokens(算每步 growth% 供事件与看板)。 */
  private lastRequestContextTokens?: number;
  /** 本步任务目标(goalFromMessages 口径;大结果闸门判 chunk 相关性用)。 */
  private stepGoal = "";
  /** 已激活的延迟工具(2026-10-22):deferred 工具被 tool_view 查看或被直接调用后进广告面。
   * 会话级(跨 turn 保留)——用过一次的工具后续每步都广告,不再反复激活。
   * **跨 loop 实例也保留**(token 轮 P1-2):gateway 每 turn 新建 AgentLoop,只用实例字段会每 turn
   * 重演「27 → 29 → 27」的 schema 翻转(实测 15 个 run 里 10 次 run-start 翻转=1.47M uncached)。
   * 现落 journal custom 事件持久化(见 readActivatedTools / recordActivatedTools),首次需要时读回 merge。 */
  private activatedTools = new Set<string>();
  /** 本 loop 是否已从 journal 读过激活集(只读一次;之后靠本实例累积增量)。 */
  private activatedLoaded = false;
  /** 本 turn 的广告面缓存:同一 turn 内 tools 数组逐字节恒定(schema 不随 step 漂移)。
   *  runTurn 开头置 undefined → 本 turn 中途激活的 deferred 工具**下 turn** 才进广告面;
   *  执行面不受限(execOne 不看广告面,模型按名直调照旧可用)。 */
  private advertisedThisTurn?: Tool[];
  /** node0 冻结基线缓存(token 轮 P1):会话首条 system.prompt 快照按 sessionId 缓存,
   *  避免每步重扫该会话事件。**只缓存「已确认有快照」的结果**——快照落账后不会变
   *  (同 session 首条即定案,落账方按 sha 幂等),缓存安全;无快照时不缓存,后续任务新落的
   *  首条快照当步即可生效(否则「先跑一段再落快照」的会话会永远读旧 fallback)。 */
  private headSystemCache?: string;
  /** 本 turn 内已确认「该 session 无 system.prompt 快照」(避免每 step 全量扫 journal)。 */
  private headSystemAbsent = false;
  /** 本 turn 的「system 变更转追加」决策(undefined=本 turn 尚未判定)。runTurn 开头清空,
   *  首步定案后整 turn 复用——防止历史上限随 step 增长把 node0 身份中途翻转。 */
  private systemDecision?: boolean;
  /** 节基线的本 loop 缓存(只缓存「已读到」的结果;跨 loop 靠 journal 持久化,见 systemSectionDelta)。
   *  仅避免任务内每步重扫 session 事件;任务间由 journal 兜底,gataway「每任务新建 loop」不会丢基线。 */
  private sectionBaselineCache?: Map<string, string>;
  /** 本轮最终响应自带的模型音频(realtime-plus text+audio 直出;runTurn 开头清零,最终响应覆盖)。
   * 装配方按轮读取(companion 广播 audioB64)——不上 journal(b64 不落事件流),轨迹侧同剥离。 */
  lastAudio: LlmResponse["audio"] = undefined;
  /** 评分节拍计数器(2026-11-05):跨 turn 累加,**构造归零、runTurn 不清**。
   *  旧实现按 `step % scoreEverySteps` 判定,而 step 每 turn 从 0 重数 → 实测今日 108 次评分
   *  有 78 次落在 step 0,scoreEverySteps 实际退化成「每 turn 首步各评一次」。 */
  private scoringTick = 0;
  /** 写前屏障(M24)上次成功 flush 时的 journal 水位:同 step 内无新 append → 不重复落盘。 */
  private lastFlushedSeq = -1;
  /** 本 turn 屏障失败原因(非 null = 本轮已中止:后续工具不再执行,step/turn 以 write-barrier 收口)。 */
  private writeBarrierFailed: string | null = null;

  constructor(opts: AgentLoopOptions) {
    this.opts = opts;
    this.tools = new Map((opts.tools ?? []).map((t) => [t.name, t]));
  }

  /** 写前屏障模式(M24):env GENIE_WRITE_BARRIER > opts.writeBarrier > "hard"。
   *  off=完全不调(基础设施/测试逃生);hard=fail-closed。 */
  private writeBarrierMode(): "off" | "hard" {
    const env = String(process.env["GENIE_WRITE_BARRIER"] ?? "").trim().toLowerCase();
    if (env === "off") return "off";
    if (env === "hard") return "hard";
    return this.opts.writeBarrier === "off" ? "off" : "hard";
  }

  /** 写前持久化屏障(M24,fail-closed):副作用(工具执行/LLM 请求)前先把已记录事件落盘。
   *  - journal 无 flushStrict(旧 MemoryJournal/测试假 journal)→ no-op(零回归);
   *  - 同 step 内 journal.length 未变(上次 flush 后无新 append)→ 跳过;
   *  - flush 前后都查取消信号:已取消返回 cancelled(不执行副作用);
   *  - flushStrict 抛错 → 返回失败原因(调用方阻止副作用),不吞不重试。 */
  private async writeBarrier(kind: "tool" | "llm", signal?: AbortSignal): Promise<{ ok: true } | { ok: false; cancelled?: boolean; reason?: string }> {
    if (this.writeBarrierMode() === "off") return { ok: true };
    const journal = this.opts.journal;
    if (typeof journal.flushStrict !== "function") return { ok: true };
    if (signal?.aborted) return { ok: false, cancelled: true };
    if (journal.length === this.lastFlushedSeq) return { ok: true };
    try {
      // M24 生产态(2026-11-07):worker 侧 ProxyJournal 的 flushStrict 是 async(RPC ack 才返回),
      // await 让 Promise reject 与同步 throw 走同一条错误路径(失败=阻止副作用 + 固定错误框)。
      await journal.flushStrict.call(journal);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // 留痕(自定义 kind 不进上下文):事后可查「哪次屏障挡了什么」。
      try {
        journal.append({ kind: "custom", sessionId: this.opts.sessionId, payload: { what: "write-barrier.fail", where: kind, reason: reason.slice(0, 300) } });
      } catch { /* 留痕失败不掩盖主错误 */ }
      return { ok: false, reason };
    }
    if (signal?.aborted) return { ok: false, cancelled: true };
    this.lastFlushedSeq = journal.length;
    return { ok: true };
  }

  cancel(reason = "user-cancel"): void {
    this.aborted = true;
    // M34:用户停止记账(与 signal.reason 双通道——工具没拿 signal 时靠这里判文案)。
    if (isUserStopReason(reason)) this.userStopped = true;
    this.ac?.abort(new Error(`cancelled:${reason}`));
  }

  /** 本 turn 的取消是否来自用户停止(工具结果文案据此二选一)。 */
  private userStopCancelled(signal?: AbortSignal): boolean {
    return this.userStopped || isUserStopAbort(signal);
  }

  /** 取消时的工具 modelContent(M34):用户停止=固定文案;其它取消=旧 [aborted] 语义。 */
  private cancelledToolText(signal?: AbortSignal): string {
    return this.userStopCancelled(signal) ? USER_STOPPED_TOOL_TEXT : ABORTED_TOOL_TEXT;
  }

  /** 每步新增预算(tokens):用户口径 ≤1~2%,缺省 1.5%,下限 1.5k(小上下文按比例算会误伤早期步)。 */
  private growthBudgetTokens(): number {
    const base = this.lastRequestContextTokens ?? this.lastContextTokens ?? 0;
    const floor = this.opts.growthBudgetMinTokens ?? GROWTH_BUDGET_MIN_TOKENS;
    if (base <= 0) return floor;
    return Math.max(floor, Math.floor(base * (this.opts.growthBudgetRatio ?? GROWTH_BUDGET_RATIO)));
  }

  /** cache-aware 策略状态播种(v2,2026-11-06):从 journal 末条 context.prune 读回
   *  clock / 冻结区 / 锚点 / 冷却基线 —— gateway 每 turn 新建 AgentLoop,不播种就会「每 turn 首步
   *  都当成未压过」而反复重置前缀(与本改动要治的病同族)。 */
  private seedPruneState(journal: Journal, sessionId: string): void {
    let last: Record<string, unknown> | undefined;
    for (const e of journal.readAll()) {
      if (e.sessionId !== sessionId || e.kind !== "context.prune") continue;
      last = e.payload as Record<string, unknown>;
    }
    if (!last) return;
    if (typeof last.clock === "number") this.pruneClock = last.clock;
    if (typeof last.frozenCount === "number") this.frozenCount = last.frozenCount;
    if (typeof last.anchor === "string" && last.anchor) this.pruneAnchor = last.anchor;
    if (typeof last.resetClock === "number") this.lastResetClock = last.resetClock;
    if (typeof last.resetTokens === "number") this.lastResetTokens = last.resetTokens;
    // clock 必须单调:新 loop 实例从 0 起算而 journal 里已是旧实例的值 → 抬到 ≤ 它,
    // 本步 +1 后与历史连续(否则 stepsSince 恒为负,冷却门判断失真)。
    if (typeof last.clock === "number" && last.clock > this.pruneClock) {
      this.pruneClock = last.clock - 1;
    }
  }

  /** node0 冻结基线:该 session 首条 system.prompt 快照(无快照=当轮 system)。
   *  已确认有快照时缓存(见 headSystemCache 注释:首条快照落账后不变,缓存安全)。
   *  **无快照也在本 turn 内缓存**:否则每个 LLM step 都要全量扫该 session 事件(热路径同步读)。
   *  装配方顺序是「建 loop → 落快照 → runTurn」,故 turn 首步查到「无」时本 turn 不会再出现;
   *  跨 turn 清空(runTurn 开头),下一 turn 仍能读到新落的快照。 */
  private headSystemFor(journal: Journal, sessionId: string): string {
    if (this.headSystemCache !== undefined) return this.headSystemCache;
    if (this.headSystemAbsent) return this.opts.system;
    const snap = headSystemSnapshotOf(journal, sessionId);
    if (snap === undefined) {
      this.headSystemAbsent = true; // 本 turn 内不再重扫(见上注释)
      return this.opts.system;
    }
    this.headSystemCache = snap;
    return snap;
  }

  /** 节级增量(system 提示更新用,token 轮 04;M125 起三态判定走 system-context-generation)。
   *
   *  返回 undefined = 调用方没给 systemSections(旧构造点/测试)→ 调用方走全文注入,逐字节不变。
   *  返回 string = 变更节的**单块**文本(按 key 字典序合成);空串 = **无节变化 → 零追加**。
   *
   *  **基线不可变**(2026-10-29 关键修正,别改成「随变更推进」):`[系统提示更新]` 消息是
   *  ephemeral 的——只拼进本次请求,不落 journal,故下一 turn 的历史里没有它。这意味着
   *  ① diff 必须每轮重算;
   *  ② 基线必须是「node0 那一版」而不是「上一轮那版」——若基线随变更推进,第二轮 diff 就变空、
   *    零追加,模型从此再也看不到变更(静默失忆,比多花 token 严重得多)。
   *
   *  **基线必须持久化到 journal**:gateway 是「每任务新建一个 AgentLoop」,实例字段会在每个新任务
   *  被重置 → 每次都当作首见 → 永远全文注入,改动等于没做。故基线落一条 `custom` 事件
   *  (payload.what="system.sections.baseline",只存每节 sha,幂等键按 session 固定),
   *  首次写入后**永不更新**;loop 内加一层内存缓存(避免每步扫 session 事件)。
   *
   *  首见(无基线)= node0 就是当前 system → 零追加并落基线,不白付全文。
   *
   *  **removal 三态(M125)**:判定交给 `reconcileSystemContext`——ok 且 sha 相同=unchanged,
   *  ok 且不同=update,unavailable=保留旧值(**绝不**当删除),absent=明确消失才删。loop 侧
   *  只负责把「装配方给的 sections」翻译成源:当前清单里的一律 `ok`,`基线里有、当前清单没有`的
   *  显式给 `absent`(sections 是**全量**清单,缺席=今天这一版确实没有它,不是「读不到」)。
   *  未出现的源(既不在清单也不在基线)不会被询问,也就不构成删除信号。 */
  private async systemSectionDelta(
    journal: Journal,
    sessionId: string,
    node0IsStale: boolean,
  ): Promise<string | undefined> {
    const sections = this.opts.systemSections;
    if (!sections || sections.length === 0) return undefined;
    let base = this.sectionBaselineCache;
    if (base === undefined) {
      base = readSystemSectionsBaseline(journal, sessionId);
      if (base === undefined) {
        recordSystemSectionsBaseline(journal, sessionId, sections);
        this.sectionBaselineCache = new Map(sections.map((s) => [s.name, sectionSha(s.content)]));
        // 首见:node0 就是当前版 → 零追加;node0 是旧快照(跨任务复用 session)→ 当前节已比 node0 新,
        // 但无从知道具体差在哪,只能全文一次(这一次之后就有基线了)。
        return node0IsStale ? undefined : "";
      }
      this.sectionBaselineCache = base;
    }
    // journal 侧只持久化每节 sha(见 readSystemSectionsBaseline 注释),故 text 为空串——
    // 判定只用 sha;text 只在 openNewGeneration 重开代时才需要。
    const entries: SystemContextState["entries"] = {};
    for (const [key, sha] of base) entries[key] = { text: "", sha };
    const state: SystemContextState = { generation: 0, baselineSeq: 0, entries };
    const sources: SystemContextSource<string>[] = sections.map((s) => ({
      key: s.name,
      codec: TEXT_CODEC,
      load: async () => ({ status: "ok" as const, value: s.content }),
    }));
    // 消失的节必须**显式**告诉模型「这节没了」(2026-10-29):条件块(/goal 清空、plan 模式退出、
    // workspace 切回)消失时,若只发「未列出的小节保持原样」,模型会继续按已失效的旧目标/旧模式
    // 行事——省 token 不能以行为退化为代价。移除通知只有一行,成本可忽略。
    // 三态口径:这里给的是 **absent**(明确不在今天这一版),不是 unavailable(暂时读不到)。
    const present = new Set(sections.map((s) => s.name));
    for (const key of base.keys()) {
      if (present.has(key)) continue;
      sources.push({ key, codec: TEXT_CODEC, load: async () => ({ status: "absent" as const }) });
    }
    const { block } = await reconcileSystemContext(state, sources);
    return block;
  }

  /** Phase 1 shadow / Phase 2 active 共用的模型评分调用;失败只留痕,不抛。
   *  2026-11-05 优化:候选过小(数<3 或总 chars<20k)不发 HTTP 但仍落一条事件;同候选集内容键
   *  命中缓存则复用上次 decisions(cacheHit/durationMs=0);error 一律不写缓存、保持确定性剪枝。 */
  private async runModelScoring(
    derived: Message[],
    step: number,
    sessionId: string,
    journal: Journal,
  ): Promise<ModelDecisionSets | undefined> {
    const config = this.opts.modelScoring;
    if (!config) return undefined;
    const resolved = resolveModelScoringConfig(config);
    if (resolved.mode === "off") return undefined;
    const candidates = collectScoringCandidates(derived, resolved.maxCandidates);
    const goal = goalFromMessages(derived);
    const totalChars = candidates.reduce((n, c) => n + c.chars, 0);
    const skip = scoringSkipReason(candidates, resolved.minCandidates, resolved.minTotalChars);
    const result = skip
      ? undefined
      : await scoreContextCandidates(config, candidates, goal, {
          skipTooSmall: true,
          cache: true,
          sessionId,
        });
    // active 才产出决策集;为避免「评分跑过但没生效」无从查询,把生效集合大小直接落账
    // (2026-11-04 审计:T-E 36h 1271 次评分、零 keep/drop,只能靠复算才看出来)。
    const sets = !result || result.error || resolved.mode !== "active"
      ? undefined
      : buildModelDecisionSets(result.decisions, resolved.minConfidence);
    try {
      journal.append({
        kind: "context.model.score",
        sessionId,
        payload: {
          step,
          mode: resolved.mode,
          providerUrl: resolved.providerUrl,
          model: resolved.model,
          apiType: resolved.apiType,
          // 实际生效阈值落账:审计脚本按事件内阈值复算,避免配置漂移后口径错位。
          minConfidence: resolved.minConfidence,
          effectiveKeep: sets?.keep.size ?? 0,
          effectiveDrop: sets?.drop.size ?? 0,
          candidateCount: candidates.length,
          totalChars,
          ...(skip ? { skipped: skip } : {}),
          ...(result ? { cacheHit: result.cacheHit === true } : {}),
          candidates: candidates.map((c) => ({ id: c.id, tool: c.tool, where: c.where, chars: c.chars })),
          decisions: (result?.decisions ?? []).map((d) => ({
            id: d.id, tool: d.tool, where: d.where,
            keepCall: d.keepCall, keepResult: d.keepResult, confidence: d.confidence,
          })),
          goalChars: goal.length,
          goalHead: goal.slice(0, 120),
          previewChars: candidates.reduce((n, c) => n + c.preview.length, 0),
          questionCount: result?.questionCount ?? 0,
          ...(result?.requestBytes !== undefined ? { requestBytes: result.requestBytes } : {}),
          ...(result?.error ? { error: result.error } : {}),
          durationMs: result?.durationMs ?? 0,
        },
      });
    } catch { /* 遥测落账失败不打断主链 */ }
    if (!result || result.error) return undefined;
    return sets;
  }

  /** 本步评分节拍判定(内部口径,不改 shouldScoreStep 的对外语义):用跨 turn 累加的
   *  `scoringTick` 取代每 turn 归零的 step;返回本步该用的模式,不该评分则 undefined。 */
  private scoringModeThisStep(): Exclude<ModelScoringMode, "off"> | undefined {
    const config = this.opts.modelScoring;
    if (!config) return undefined;
    const resolved = resolveModelScoringConfig(config);
    if (resolved.mode === "off") return undefined;
    const tick = this.scoringTick++;
    if (tick % resolved.scoreEverySteps !== 0) return undefined;
    return resolved.mode;
  }

  /** 轨迹卡落账(J1,2026-11 token 轮):每 N 步或 phase 切换时旁路落一条 `task.trajectory`。
   *  payload 只含计数/比率/子目标(不含任何对话正文)→ deriveMessages 白名单不读,零上下文影响;
   *  `lastTrajectoryText` 是给 tips ctx 的一行摘要(装配方据此写「先看轨迹再动手」类提示)。
   *  同 step 不重复落(trajLast 幂等),单轮 ≤40 条(TRAJECTORY_MAX_PER_TURN)。 */
  private emitTrajectory(sessionId: string, turn: number, step: number): void {
    const every = this.opts.trajectorySteps ?? 0;
    if (every <= 0 || step <= 0) return; // 缺省关闭;step 0 无「上一步」可画像
    const meta = this.opts.trajectoryMeta?.() ?? {};
    const phase = meta.phase;
    const due = (step - this.trajLast >= every || phase !== this.trajLastPhase) && this.trajLast !== step;
    if (!due) return;
    if (this.trajEmitted >= TRAJECTORY_MAX_PER_TURN) return;
    const steps = this.trajSteps;
    const parallelRate = steps > 0 ? Math.round((this.trajParallelSteps / steps) * 100) / 100 : 0;
    const tools: Record<string, number> = {};
    for (const [name, n] of this.trajToolCounts) tools[name] = n;
    let taskId: string | undefined;
    try { taskId = this.opts.trajectoryTaskId?.(); } catch { /* 归属读取故障=不带 taskId */ }
    try {
      this.opts.journal.append({
        kind: "task.trajectory",
        sessionId,
        payload: {
          ...(taskId ? { taskId } : {}),
          step,
          turn,
          steps,
          calls: this.trajCalls,
          tools,
          parallelRate,
          errors: this.totalErrors,
          retries: this.trajRetries,
          tokensSpent: this.tokensSpent,
          ...(phase ? { phase } : {}),
          subgoal: meta.subgoal ?? "",
        },
      });
    } catch { /* 旁路落账失败不打断主链 */ }
    // 装配方回调(J1 接线闭环):只在真正 due 的这次触发,payload 与上面落账同源(字段名/口径一致)。
    // 旁路语义——回调内的异常(写 task.progress 失败等)绝不上抛打断 turn。
    if (this.opts.onTrajectory) {
      try {
        this.opts.onTrajectory({
          ...(taskId ? { taskId } : {}),
          step,
          turn,
          ...(phase ? { phase } : {}),
          subgoal: String(meta.subgoal ?? ""),
          tokensSpent: this.tokensSpent,
          errors: this.totalErrors,
          steps,
          tools,
        });
      } catch { /* 回调故障不打断主链 */ }
    }
    this.trajEmitted += 1;
    this.trajLast = step;
    this.trajLastPhase = phase;
    const subgoal = String(meta.subgoal ?? "");
    const line = `第${step}步 · 工具${Object.keys(tools).length}类 · 并行${Math.round(parallelRate * 100)}% · 错误${this.totalErrors} · ${subgoal}`;
    this.lastTrajectoryText = line.length > 120 ? line.slice(0, 119) + "…" : line;
  }

  /** 跑一个 turn:用户输入 → 模型 → 工具(可多 step)→ 结束。 */
  async runTurn(userText: string, images?: string[], meta?: { displayText?: string; attachments?: unknown[] }, audio?: AudioInput): Promise<string> {
    const { journal, sessionId } = this.opts;
    // 每次 runTurn 重置取消态:上一个 turn 的 cancel 不影响新 turn(gateway 每任务新建 loop,双保险)。
    this.aborted = false;
    this.userStopped = false; // M34:用户停止记账按 turn 重置
    this.lastStepTools = [];
    this.lastStepError = false;
    // J1 每轮重置:token 计时/错误计数/本步文件/轨迹统计归零,注入闸水位随 tokensSpent 归零重来
    // (水位清零后首步提醒必放行,与「无记录→放行」同语义,不会把该有的首步提醒吞掉)。
    this.tokensSpent = 0;
    this.totalErrors = 0;
    this.lastStepFiles = [];
    this.gate.reset();
    this.trajToolCounts = new Map<string, number>();
    this.trajCalls = 0;
    this.trajParallelSteps = 0;
    this.trajSteps = 0;
    this.trajRetries = 0;
    this.trajLast = 0;
    this.trajLastPhase = undefined;
    this.trajEmitted = 0;
    this.lastTrajectoryText = undefined;
    this.lastAudio = undefined; // 语音直出槽随轮清零:上轮模型音频不串进本轮(消费方按轮取)
    this.writeBarrierFailed = null; // 写前屏障失败闩:按 turn 重置(上轮屏障失败不影响新轮)
    this.systemDecision = undefined; // system 追加决策按 turn 重判(见字段注释),整 turn 内冻结
    this.headSystemAbsent = false; // 「无快照」只在本 turn 内缓存:跨 turn 重查(快照可能新落)
    // 广告面按 turn 重置(token 轮 P0-2):广告面一轮一冻 → 本 turn 中途激活的
    // deferred 工具下 turn 才进 schema(避免 turn 内翻转)。
    this.advertisedThisTurn = undefined;
    const ac = new AbortController();
    this.ac = ac;
    // waterfall agent/pre-step(designs/14 §1.2):输入进 journal 前的改写/拦截点。
    let input: { userText: string; images?: string[]; audio?: AudioInput } = { userText, images, ...(audio ? { audio } : {}) };
    if (this.opts.waterfall?.preStep) {
      let ran = false;
      let nextInput = input;
      const blockReason = await this.opts.waterfall.preStep(
        { turn: AgentLoop.turnCounter + 1, userText: input.userText, images: input.images },
        async (rewritten) => {
          ran = true;
          if (rewritten) nextInput = { ...nextInput, ...rewritten, audio: input.audio };
        },
      );
      if (!ran || blockReason !== undefined) {
        const turn = ++AgentLoop.turnCounter;
        journal.append({ kind: "turn.start", sessionId, payload: { turn } });
        journal.append({ kind: "turn.end", sessionId, payload: { turn, reason: "pre-step-blocked", ...(blockReason !== undefined ? { detail: blockReason } : {}) } });
        return "";
      }
      input = nextInput;
    }
    // turn 边界(step-031,dsh turn/start 对应物;reason 落 turn.end)
    const turn = ++AgentLoop.turnCounter;
    // M81 阶段遥测(turn 级,只观测零决策变更):clock/recorder/turnT0 + 汇总累加槽。
    // 每 turn 至多一条 telemetry.phase,任何异常静默(旁路不得打断主链)。
    const phaseClock = createTelemetryClock();
    const phaseRecorder = new PhaseRecorder(phaseClock);
    const turnT0 = phaseClock.now();
    const phaseState = { emitted: false };
    let turnUsage: LlmResponse["usage"];
    let turnTtftMs: number | undefined;
    // M115 循环护栏状态随 turn 重置(跨 turn 不累积:上一轮的连击/配额不带进新任务)。
    this.toolGuard = new ToolLoopGuard(turn);
    journal.append({ kind: "turn.start", sessionId, payload: { turn } });
    journal.append({ kind: "message.user", sessionId, payload: {
      text: input.userText,
      // txa3:归属轮次(用户消息不属于某 step,故只带 turn)。
      turn,
      // step-052:显示与模型分账——displayText=用户原始输入(面板展示);text=注入块合流后的任务书(喂模型)。
      ...(meta?.displayText ? { display: meta.displayText } : {}),
      ...(meta?.attachments?.length ? { attachments: meta.attachments } : {}),
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.audio ? { audio: input.audio } : {}),
    } });

    const maxSteps = this.opts.maxSteps ?? 10;
    let finalText = "";
    let turnReason: "completed" | "max-steps" | "aborted" | "cancelled" | "stopped" = "completed";
    // 空响应防抖(2026-10-30 MB 会话实锤):上游可 200-正常返回「零内容+零工具」(实测 603s 挂流
    // 0 output token 后 resolve)——空终态几乎总是传输/上游抖动而非模型决策,重试一次再接受。
    let emptyTurnRetried = false;

    for (let step = 0; step < maxSteps; step++) {
      if (this.aborted) { turnReason = "cancelled"; break; }
      // txa3:把当前轮/步写进实例字段 —— executeTracked 落 tool.call 时拿不到这两个局部变量。
      this.curTurn = turn;
      this.curStep = step;
      journal.append({ kind: "step.start", sessionId, payload: { turn, step } });
      try {
        // microcompact 不再落 journal compact.* 事件(step-058):占位替换只在本步组装消息时
        // 经 microcompactMessages 读取侧生效;此前每条工具结果写一对无摘要 compact.* 事件,
        // 被 deriveMessages 当真压缩边界硬截断(模型失忆)+面板渲染「上下文已压缩」+闸门清零。
        if (this.opts.compactHook) await this.opts.compactHook(journal, sessionId);
        const derived = deriveMessages(journal, sessionId);
        // 大结果闸门(step-1029):chunk 相关性判断需要一个「当前任务目标」,与 model-scoring 同口径
        // (去掉纪律卡、跳过 [系统提醒]);每步刷新,execOne 里直接用。
        this.stepGoal = goalFromMessages(derived);
        // 增长突增:上一请求实测 tokens 与本次组装前估算的差 ≥ 阈值 → 本步用激进组清理。
        // 这是「膨胀速度」维度;常规阈值组清理只在总量到线时触发,感知不到单步灌入一大坨。
        const rawContextTokens = estimateMessagesTokens(derived);
        const growthSpurt = shouldAggressivePrune(
          rawContextTokens,
          this.lastContextTokens,
          this.opts.growthSpurtTokens,
        );
        if (growthSpurt) {
          try {
            journal.append({
              kind: "context.growth",
              sessionId,
              payload: {
                growth: rawContextTokens - (this.lastContextTokens ?? rawContextTokens),
                rawContextTokens,
                previousContextTokens: this.lastContextTokens,
                keepRecent: this.opts.aggressiveKeepRecent ?? 2,
              },
            });
          } catch { /* 遥测落账失败不打断主链 */ }
        }
        this.lastContextTokens = rawContextTokens;
        // Phase 1 shadow:后台评分只留痕;Phase 2 active:高置信度 keep/drop 参与本步剪枝。
        // 节拍由跨 turn 累加的 scoringTick 决定(step 每 turn 归零,直接 % 会每 turn 首步必评)。
        let modelSets: ModelDecisionSets | undefined;
        const scoringMode = this.scoringModeThisStep();
        if (scoringMode === "active") {
          modelSets = await this.runModelScoring(derived, step, sessionId, journal);
        } else if (scoringMode === "shadow") {
          void this.runModelScoring(derived, step, sessionId, journal).catch(() => { /* shadow 失败不打断主链 */ });
        }
        const baseMicrocompact = growthSpurt
          ? {
              ...(this.opts.microcompact ?? {}),
              thresholdTokens: 1, // 强制本次组清理评估;minSavings 回滚仍生效
              keepRecent: this.opts.aggressiveKeepRecent ?? 2,
            }
          : (this.opts.microcompact ?? {});
        // cache-aware 前缀稳定策略(2026-11-06 v2):clock 每步 +1;turn 首步归零本 turn 重置计数。
        this.pruneClock += 1;
        if (!this.pruneStateSeeded) {
          this.pruneStateSeeded = true;
          this.seedPruneState(journal, sessionId);
        }
        if (step === 0) this.resetsThisTurn = 0;
        const policyState: MicrocompactPolicyState = {
          clock: this.pruneClock,
          turnStart: step === 0,
          frozenCount: this.frozenCount,
          resetsThisTurn: this.resetsThisTurn,
          // 增长突增(装配方显式配置的 growthSpurtTokens 命中):按 keepRecent 清到窗口外。
          ...(growthSpurt ? { force: true } : {}),
          ...(this.lastResetClock !== undefined ? { lastResetClock: this.lastResetClock } : {}),
          ...(this.lastResetTokens !== undefined ? { lastResetTokens: this.lastResetTokens } : {}),
          ...(this.pruneAnchor !== undefined ? { frozenAnchor: this.pruneAnchor } : {}),
        };
        const microcompactConfig: MicrocompactConfig = {
          ...baseMicrocompact,
          policyState,
          ...(modelSets ? { modelKeep: modelSets.keep, modelDrop: modelSets.drop } : {}),
        };
        const compacted = microcompactMessages(derived, microcompactConfig);
        // 重置发生 → 冻结区前移(后续步只重放这个静态区),冷却基线/本 turn 计数同步推进。
        if (compacted.prefixBreak === true) {
          this.frozenCount = compacted.frozenCount ?? this.frozenCount;
          this.lastResetClock = this.pruneClock;
          this.lastResetTokens = compacted.contextTokensAfter ?? rawContextTokens;
          this.resetsThisTurn += 1;
        } else if (compacted.frozenCount !== undefined) {
          this.frozenCount = compacted.frozenCount;
        }
        if (compacted.anchor !== undefined) this.pruneAnchor = compacted.anchor;
        // 每步新增量(用户口径 ≤1~2%):以上一步请求估算为基线;first step 无基线不上报。
        const growthTokens = this.lastRequestContextTokens !== undefined
          ? Math.max(0, rawContextTokens - this.lastRequestContextTokens)
          : undefined;
        const budgetTokens = this.growthBudgetTokens();
        const budgetGrowthPct = growthTokens !== undefined && this.lastRequestContextTokens
          ? (growthTokens / this.lastRequestContextTokens) * 100
          : undefined;
        // system 提示词 in-history(token 轮 P1,designs/token-opt-round3-p1 §3):
        // 改前每步用当轮 system **原地重写** node0 → system 一变(任务类别切换/AGENTS.md 摘要刷新/
        // 技能索引新增/memory revision/计划文件注入,同 session 实测 2~4 个版本)整段前缀缓存从
        // token 0 失效(样本 run 首调用 19 次 = 1.08M uncached,占 uncached 15.2%,每次放大 53.7×)。
        // 改后:node0 = 该 session 首条 system.prompt 快照(冻结,永不重写);system 变更改为在历史
        // 之后追加一条 user 消息(对齐 deepseek-harness systemPromptUpdate:'in-history'),缓存
        // 前缀继续命中。快照缺席(旧 journal / 测试直接构造 loop)→ fallback=当轮 system,逐字同旧行为。
        const headSystem = this.headSystemFor(journal, sessionId);
        // 成本守卫(见 SYSTEM_UPDATE_GATE_RATIO 注释:两侧同量纲=tokens)。
        // **决策按 turn 冻结**(2026-10-28 code_review 修):历史上限随 step 增长,若每步重算,
        // 长 turn 中途会越过门 → node0 突然从「当轮 system」切成「冻结 headSystem」并开始追加,
        // 同一 turn 内 node0 身份翻转=又打碎一次前缀(正是本改动要消除的病)。故首步定案后本 turn 复用。
        if (this.systemDecision === undefined) {
          this.systemDecision = headSystem !== this.opts.system
            && compacted.messages.length > 0
            && estimateMessagesTokens(compacted.messages)
              > Math.ceil((this.opts.system.length / 4) * SYSTEM_UPDATE_GATE_RATIO);
        }
        const appendSystemUpdate = this.systemDecision;
        const messages: Message[] = [
          { role: "system", content: appendSystemUpdate ? headSystem : this.opts.system },
          ...compacted.messages,
        ];
        // 追加消息是 opts 的投影(不落 journal——落账会被 deriveMessages 重放成第二条,二次注入)。
        // 同 turn 内 this.opts.system 固定 → 内容逐字节相同,天然恒 1 条(不是累积 push)。
        // 位置=紧随历史(此后各类 ephemeral 提醒才 push):更新即「历史之后的第一条」,语义上
        // 与 deriveMessages 的 [系统提醒] 中段注入同族;不同步写进 journal,故不参与下次 derive。
        //
        // 增量口径(2026-10-29 token 轮 04):有 sections 时只注入**与首版基线不同的节**——
        // 旧口径整篇 26~28K 字符重发,实测占全部未命中 token 的 39.5%(8.3M uncached);
        // 而绝大多数变更只涉及一两节(agents-md 摘要 / memory revision / skill-index 新增)。
        // 无节变化=零追加(比追加空壳更省,且不破坏前缀)。无 sections(旧构造点/测试)=全文,逐字节不变。
        if (appendSystemUpdate) {
          // node0IsStale = appendSystemUpdate:能走到这里就意味着 headSystem !== 当轮 system,
          // 即 node0 是旧版、当前节比 node0 新 → 若有基线就 diff,无基线只能全文一次。
          const delta = await this.systemSectionDelta(journal, sessionId, true);
          if (delta === undefined) {
            // 旧构造点(无 systemSections):全文注入逐字不变,仍为 ephemeral(不落 journal)。
            messages.push({ role: "user", content: SYSTEM_UPDATE_PREFIX + this.opts.system });
          } else if (delta.length > 0) {
            // 持久化 + 去重(token 轮 P2,2026-11-02):节增量落 journal 成为持久历史,
            // 内容(指纹)没变就不再重投——见 readSystemDeltaLanded 的生产实测注释。
            //
            // **无二次注入**:deriveMessages 在本步开头就已执行(见上方 `const derived = ...`),
            // 故本次 append 不会回流进本步 messages;本步照常 push 一次,下一步 derive 重放它、
            // 指纹命中 → 零 push。二者绝不同时发生(loop.ts:1017-1020 记载的旧坑就是
            // 「既落账又 push」在同一 derive 之后重复计入)。
            //
            // **compact 后必须重落**:真压缩 out.length=0 会抹掉边界之前的 delta 事件
            // (derive 重放不到),此时强制重落一条——静默失忆比多花一次 token 严重得多。
            // M125:delta 已是**单块**文本(reconcile 内按 key 字典序合成),不再逐片段 join。
            const text = SYSTEM_SECTION_UPDATE_PREFIX + delta;
            const sha = sectionSha(text);
            const { landed, hardCompactSeq } = readSystemDeltaState(journal, sessionId);
            const compactAfterDelta = hardCompactSeq > (landed?.seq ?? 0);
            // **二次注入防线**:compact 的 payload.tail 可能恰好保留了这条 delta(user 消息),
            // deriveMessages 已把它重放回历史——此时既不能再 push、也不能再落账(否则同一条出现 2 遍)。
            // tail 单条超 8000 字符会被截断并追加「…(截断)」,故按「正文是本条的前缀」也认作已在历史。
            const alreadyInHistory = compacted.messages.some((m) => {
              if (m.role !== "user" || !m.content.startsWith(SYSTEM_SECTION_UPDATE_PREFIX)) return false;
              if (m.content === text) return true;
              const body = m.content.replace(/\n?…\(截断\)$/, "");
              return body.length > SYSTEM_SECTION_UPDATE_PREFIX.length && text.startsWith(body);
            });
            if (!alreadyInHistory && (landed === undefined || landed.sha !== sha || compactAfterDelta)) {
              try {
                recordSystemDelta(journal, sessionId, text);
              } catch { /* 落账失败:退回旧 ephemeral 行为(本步照推,下步重试) */ }
              messages.push({ role: "user", content: text });
            }
          }
        }
        const pruneSig = (compacted.pruned ?? [])
          .map((item) => `${item.toolCallId}:${item.action}:${item.originalChars}`)
          .join("|");
        // 上下文清单:只在本步折叠集合变化时注入,避免每步复读(ephemeral,不落 journal)。
        if (compacted.manifest && pruneSig !== this.lastContextManifestSig) {
          this.lastContextManifestSig = pruneSig;
          messages.push({ role: "user", content: `[系统提醒] ${compacted.manifest}` });
        }
        // Phase 1 数据面:折叠决策留痕(不落 compact 边界;pruned 集合或策略变化才写,防事件膨胀)。
        // 2026-11-06 v2:append-only 常态也要留一行(policy/budgetGrowthPct),看板才读得出
        // 「这一步为什么动了前缀/为什么没动」;签名含 policy + growth% 以避免逐步刷。
        const budgetPctBucket = budgetGrowthPct === undefined ? "-" : budgetGrowthPct.toFixed(1);
        const policySig = `${compacted.policy ?? "legacy"}:${pruneSig}:${budgetPctBucket}`;
        const shouldLog = (compacted.pruned?.length ?? 0) > 0
          ? pruneSig !== this.lastPruneLogSig
          : compacted.policy !== undefined && policySig !== this.lastPruneLogSig;
        if (shouldLog) {
          try {
            journal.append({
              kind: "context.prune",
              sessionId,
              payload: {
                reason: compacted.reason,
                compacted: compacted.compacted,
                savedTokens: compacted.savedTokens ?? 0,
                growthSpurt,
                items: (compacted.pruned ?? []).slice(0, 20),
                // cache-aware 前缀稳定字段(2026-11-06 v2):看板读这些判断
                // 「这一步为什么动了前缀 / 为什么没动」。
                ...(compacted.policy ? { policy: compacted.policy } : {}),
                planCount: compacted.planCount ?? compacted.compacted,
                prefixBreak: compacted.prefixBreak === true,
                ...(compacted.contextTokensBefore !== undefined
                  ? { contextTokens: compacted.contextTokensBefore }
                  : { contextTokens: rawContextTokens }),
                ...(compacted.contextTokensAfter !== undefined
                  ? { contextTokensAfter: compacted.contextTokensAfter }
                  : {}),
                ...(compacted.frozenCount !== undefined ? { frozenCount: compacted.frozenCount } : {}),
                ...(compacted.cutTokens !== undefined ? { cutTokens: compacted.cutTokens } : {}),
                // 每步新增量与预算(用户口径 1~2%):growthTokens / budgetGrowthPct / budgetTokens。
                ...(growthTokens !== undefined ? { growthTokens } : {}),
                ...(budgetGrowthPct !== undefined ? { budgetGrowthPct } : {}),
                budgetTokens,
                ...(budgetGrowthPct !== undefined && budgetGrowthPct > (this.opts.growthBudgetRatio ?? GROWTH_BUDGET_RATIO) * 100 && !compacted.prefixBreak
                  ? { budgetExceeded: true }
                  : {}),
                // 冷却状态:距离下次允许重置还差多少(看板可显示「还要长 N tok / N 步」)。
                ...(this.lastResetClock !== undefined
                  ? {
                      resetCooldown: {
                        stepsSince: this.pruneClock - this.lastResetClock,
                        growthSince: rawContextTokens - (this.lastResetTokens ?? 0),
                        cooldownSteps: this.opts.microcompact?.resetCooldownSteps,
                        cooldownTokens: this.opts.microcompact?.resetCooldownTokens,
                      },
                      resetClock: this.lastResetClock,
                      ...(this.lastResetTokens !== undefined ? { resetTokens: this.lastResetTokens } : {}),
                    }
                  : {}),
                clock: this.pruneClock,
                turnStart: step === 0,
                resetsThisTurn: this.resetsThisTurn,
                ...(compacted.anchor ? { anchor: compacted.anchor } : {}),
                ...(compacted.skipped ? { skipped: compacted.skipped } : {}),
              },
            });
            this.lastPruneLogSig = policySig; // 落账成功才去重;失败下步重试
          } catch { /* 遥测落账失败不打断主链 */ }
        }
        // todo 提醒(designs/25 ZCode todo reminder):ephemeral 注入不落 journal;todoReminderSteps=0 关闭。
        // J1:周期命中后再过注入闸(同 key ≥10k token 间隔),避免短步连刷同一句未完成计划。
        if (this.opts.todoReminderSteps && step > 0 && step % this.opts.todoReminderSteps === 0) {
          const reminder = buildTodoReminder(journal, sessionId);
          if (reminder && this.gate.check("remind:todo", this.tokensSpent)) messages.push({ role: "user", content: reminder });
        }
        // 已读文件提醒(designs/25「同文件读第二遍」机制层):清单**变化才注入**。
        // 2026-11-05 D4 治理:旧版「+每 10 步刷一次」的周期刷新是 readlist 957 次/7d 的真实触发
        // 路径(tips-inventory 实测)——清单未变的整 10 步复读纯噪音,删周期分支只留签名变化;
        // compact 后 ephemeral 从模型视野消失,由 compact 计数锚重置签名、允许重注一次(失忆自愈)。
        // 变化判定剥离相对时间括号(「刚刚/3 分钟前」本身随时间变,不剥则每步都算「变化」)。
        // ephemeral 不落 journal:每步从注册表现算,microcompact/deriveMessages 主链不受影响。
        let compactsNow = 0;
        try { compactsNow = journal.readSession(sessionId).filter((e) => e.kind === "compact.done").length; } catch { /* 计数失败=0,不改行为 */ }
        if (compactsNow !== this.lastReminderCompacts) {
          this.lastReminderCompacts = compactsNow;
          this.lastReadReminderSig = undefined;
          // J1:真压缩边界=模型失忆,旧水位不再代表「它看过」→ 清空全部 key,允许各提醒重新到达。
          this.gate.reset();
        }
        const readReminderRaw = buildReadFilesReminder(sessionId);
        if (readReminderRaw) {
          const sig = readReminderRaw.replace(/\([^)]*\)/g, "");
          // J1:签名变化只是内因,仍要过闸(清单变得再勤也守 ≥10k token);被闸拒时不更新签名,
          // 下一步仍「算变化」→ 到点即补投,不会永久丢掉这次变化。
          if (sig !== this.lastReadReminderSig) {
            if (this.gate.check("remind:readlist", this.tokensSpent)) {
              this.lastReadReminderSig = sig;
              messages.push({ role: "user", content: readReminderRaw });
            }
          }
        }
        // 落目标再锚定(step-137):每 N 步注入 P0 清单+证据覆盖率(ephemeral 不落 journal)——
        // 实锤教训:长任务跑几十步后「板上写的 P0 验收」彻底脱离注意力,完工时无人核对。
        if (this.opts.boardReminderSteps && step > 0 && step % this.opts.boardReminderSteps === 0) {
          try {
            const br = await this.opts.boardReminder?.();
            if (br && this.gate.check("remind:board", this.tokensSpent)) messages.push({ role: "user", content: br });
          } catch { /* 提醒层故障吞掉,绝不打断主链 */ }
        }
        // 待决审批注入(2026-11-03 token 治理,step-1031 实锤 2.7M token/日):ephemeral
        // 不落 journal——旧口径 message.user 永久落账,已了结的审批块被 deriveMessages 无限重放。
        // 位置=历史末尾(与 todo/board 提醒同族,保前缀稳定,见下方 ephemeral 位置注释)。
        // 2026-11-05 D4 复核定性:待决期间逐步重注是**到达性必需**——ephemeral 块不进历史,
        // 上一步的块下一步模型看不见;不重注=父 agent 丢失 requestId 无法应答(parent-ask-broker.test
        // 「待决步可见并应答」断言即此语义)。4159 次/7d 是积压期的到达性成本,非泄漏;
        // 了结即撤已由 ephemeral 保证(应答后 pendingQuestions 返回 null=零注入)。
        if (this.opts.pendingQuestions) {
          try {
            const pq = this.opts.pendingQuestions();
            if (pq) {
              // J1 审批豁免细则(取舍 + 残余风险,写清在此):
              // key = 正文 djb2 指纹 → **正文一变就是全新 key,闸必放行**;只有「与上一步逐字相同」
              // 的待决块才会被 ≥10k token 的水位拦下。取舍理由:ephemeral 块不进历史,到达性靠重注;
              // 但同一段 requestId 在短步里逐步复读是纯计费(实测 4159 次/7d)。
              // 用 hash 而非固定 key,正是为了让「新请求出现」永远不用等水位——否则父 agent 在窗口内
              // 看不到新 requestId 就无法应答(整条 ask 链卡死)。
              // 残余风险:正文逐字相同但语义更新(如同一 requestId 的等待时长变了)会被拦;
              // 把风险压到最小的办法就是「正文未变才拦」——装配方只要在正文里带上变化量即可放行。
              const key = "remind:pending:" + djb2Hex(pq);
              if (this.gate.check(key, this.tokensSpent)) messages.push({ role: "user", content: pq });
            }
          } catch { /* 注入层故障吞掉,绝不打断主链 */ }
        }
        // ephemeral 块一律**追加在历史末尾**(2026-10-30 核查回滚,勿再前置):
        // 曾试过把它们 splice 到 system 之后(「位置与历史长度解耦」),方向是错的——
        // 块放在历史**之前**时,块一变化/消失就让其后整条历史移位,缓存从该点起全失效;
        // 实测(todoReminderSteps=3 探针)9 步里 5 步公共前缀塌到 1 条、覆盖率 2.4%。
        // 放末尾则失效区域只有「块 + 本步新增」,而块本身仅 45~85 tok。回归门:
        // test/prefix-stability.test.ts(块周期变动时前缀覆盖率必须 ≥90%)。
        // tips 即时信息增强(2026-10-21):按上一步工具动作/装配方策略注入「做这类事之前该知道的事」,
        // ephemeral 不落 journal;tip 为空=本步零注入,异常吞掉不打断主链。
        // ctx.compacts=本会话 compact.done 计数(readSession per-session 切片,不扫全量;
        // microcompact 不落事件不计)——装配方据此在 compact 后清「已注入」状态,重注入一次。
        if (this.opts.tips) {
          try {
            const compacts = compactsNow; // 上方读清单锚已算清(同一步同值;免二次读 journal 切片)
            const tip = this.opts.tips({
              step,
              lastStepTools: this.lastStepTools,
              lastStepFiles: this.lastStepFiles,
              totalErrors: this.totalErrors,
              compacts,
              phase: this.opts.tipsPhase?.(),
              lastStepError: this.lastStepError,
              tokensSpent: this.tokensSpent,
              gate: this.gate,
              ...(this.lastTrajectoryText ? { trajectory: this.lastTrajectoryText } : {}),
            });
            const tipText = typeof tip === "string" ? tip : (tip && tip.text) || "";
            if (tipText) {
              messages.push({ role: "user", content: tipText });
              // 可见化留痕(2026-10-22 用户口径「触发了 tips 机制也要渲染出来,并显示 tips 了什么内容」):
              // 注入仍是 ephemeral(deriveMessages 白名单不读本 kind——上下文零变化),这里只旁路落一条
              // 供面板/回放展示。文本按 8000 字符截断防 journal 膨胀(原文仍在 LLM 请求里,截断只影响展示)。
              const keys = typeof tip === "string" ? [] : (tip?.keys ?? []);
              const TIP_LOG_MAX = 8000;
              journal.append({
                kind: "tip.injected",
                sessionId,
                payload: {
                  keys, turn, step,
                  text: tipText.slice(0, TIP_LOG_MAX),
                  chars: tipText.length,
                  // J1:留痕带当步累计 tokens —— 面板可据此算「注入密度」(每 10k token 注了几条)。
                  tokensSpent: this.tokensSpent,
                  ...(tipText.length > TIP_LOG_MAX ? { truncated: true } : {}),
                },
              });
            }
          } catch { /* tips 层故障吞掉,绝不打断主链 */ }
        }
        // 时间盒收敛提醒(只一次):子代理临到期仍只会发工具调用、从不落结论——到点前强制收口。
        if (this.opts.deadlineAt && !this.budgetWarned) {
          const remainMs = this.opts.deadlineAt - Date.now();
          if (remainMs <= (this.opts.deadlineWarnMs ?? 120_000)) {
            this.budgetWarned = true;
            const remainMin = Math.max(1, Math.round(remainMs / 60_000));
            messages.push({
              role: "user",
              content: "<system-reminder>时间盒仅剩约 " + remainMin + " 分钟:立即停止继续检索/探路,"
                + "基于已获得的信息输出任务书要求的最终结论(事实清单/文件:行号/结论与依据)。"
                + "不要再发起新的搜索;未覆盖到的部分如实标注「未完成」。</system-reminder>",
            });
          }
        }
        const llmT0 = Date.now();
        // TTFT(step-031 流式遗留收口):首个增量到达时刻-发起时刻;非流式/无增量=undefined 不落。
        let ttftMs: number | undefined;
        this.opts.onStream?.({ type: "llm-begin" });
        const llmVendor = this.opts.llm as { model?: string; modelName?: string; describe?: () => Record<string, unknown> };
        /** 模型名 t0 快照(2026-11-03):provider.modelName 是 getter,热切换后读出新值;
         *  必须在发起调用前固定,否则记录的是「切换后的模型」而非「本次请求实际用的模型」。 */
        const modelAtStart = (llmVendor.modelName ?? llmVendor.model) as string | undefined;
        // 本步广告面(2026-10-22 延迟工具):deferred 且未激活的工具不进 wire(省 schema 常驻),
        // 但仍在 this.tools 里可执行——广告与执行解耦。
        const advertised = this.advertisedTools();
        let res: LlmResponse;
        /** M29:本次 chat 的 attemptId(每次 provider 调用一个;provider 内部重试时自身派生 base#n)。 */
        let attemptId = `${sessionId}:${turn}:${step}:${++this.attemptSeq}`;
        /** 成功响应对应的 attemptId(流式响应回填;非流式缺省回落本次请求 id)。 */
        let chatAttemptId: string | undefined;
        /** 本 step 内已从安全锚点重开的次数(上限 STREAM_REOPEN_MAX=10)。 */
        let streamReopens = 0;
        /** 本次 chat 调用已吐出的正文/思考字符数(作废留痕 partialChars;每次 attempt 从零计)。 */
        let partialChars = 0;
        /** 增量透出(流式打字机 + TTFT);续写请求复用同一回调,面板文本连续。 */
        const onChunk = (d: LlmDeltaChunk) => {
          if (ttftMs === undefined && (d.text || d.reasoning)) {
            ttftMs = Date.now() - llmT0;
            if (turnTtftMs === undefined) turnTtftMs = ttftMs; // M81:turn 级首次 TTFT
          }
          partialChars += (d.text?.length ?? 0) + (d.reasoning?.length ?? 0);
          if (d.text || d.reasoning) this.opts.onStream?.({ type: "llm-delta", ...d });
        };
        /** 400 unsupported image 自愈重试计数(2026-11-05):最多 2 次,收敛保证见 repairUnsupportedImage。 */
        let visionRepairs = 0;
        /** 本次请求实际发出的 messages(M58):图片 offload 后换成新数组重试,**不改**本步 messages
         *  (messages 供后续 output 续写与轨迹使用,保持原样)。 */
        let reqMessages: Message[] = messages;
        /** 图片 offload 重试预算(M58):一次为限,且不占 provider 重试预算/visionRepairs 计数。 */
        let imageOffloadRetried = false;
        /** 是否真的做过 offload 并换过请求(只有它为真,第二次失败才附「图片已 offload」。) */
        let imageOffloadApplied = false;
        // M81:本 step 的 llm 阶段(provider 重试/视觉自愈/锚点重开都算同一段,不拆 span)。
        const phaseLlmToken: PhaseToken = phaseRecorder.begin("llm");
        for (;;) {
        // 写前持久化屏障(M24):messages 组装完成、provider 调用前落盘;失败**不发起请求**。
        // 放在重试循环内:每次下游请求(含视觉自愈重试)前都过一道闸;同 step 无新 append 时自动跳过。
        {
          const barrier = await this.writeBarrier("llm", ac.signal);
          if (!barrier.ok) {
            if (barrier.cancelled) throw new Error("cancelled:write-barrier");
            this.writeBarrierFailed = "[写前屏障] journal 落盘失败,已阻止 LLM 请求";
            throw new Error(`${this.writeBarrierFailed}(${barrier.reason ?? "unknown"})`);
          }
        }
        try {
          partialChars = 0; // M29:每次 attempt 从零计数(自愈重试/锚点重开都不累计半截)
          res = await this.opts.llm.chat(
            reqMessages,
            advertised,
            ac.signal,
            onChunk,
            {
              attemptId,
              // provider 内部把半截流作废(将要重试)时立即留痕;持久化失败只告警,不改变恢复结果。
              onAttemptDiscarded: (info) => {
                try {
                  markDiscard(journal, sessionId, {
                    attemptId: info.attemptId,
                    turn,
                    step,
                    anchor: findSafeAnchor(journal.readSession(sessionId)),
                    reason: info.reason,
                    partialChars: info.partialChars,
                  });
                } catch { /* 持久化失败只告警 */ }
              },
            },
          );
          chatAttemptId = res.attemptId ?? attemptId;
          break; // 本次请求成功(含自愈后重试成功):跳出重试循环
        } catch (err) {
          // M58 图片 offload 持久位置(ref #58):provider 报图片预算/尺寸错误时,先把请求里的
          // data URL 落盘 + 正文换占位行,再用新 messages **立即重试一次**——这一次重试不占
          // provider 重试预算、不增加 visionRepairs 计数(否则「重试消耗预算」的老病原样复发)。
          // 触发面严格:只认 isImageBudgetError,且本请求确实带图;其余错误行为逐字不变。
          if (!imageOffloadRetried && this.opts.imageOffload && isImageBudgetError(err) && hasUserImages(reqMessages)) {
            imageOffloadRetried = true;
            const impl = this.opts.imageOffload.impl ?? offloadImages;
            let off: Awaited<ReturnType<typeof offloadImages<Message>>> | null = null;
            try {
              off = await impl(reqMessages, {
                root: this.opts.imageOffload.root,
                sessionId,
                ...(this.opts.imageOffload.jobId ? { jobId: this.opts.imageOffload.jobId } : {}),
              });
            } catch { off = null; } // 写盘失败/异常:不重试,原错误抛出(诚实)
            // 投影校验:offload 前后消息条数与角色序列必须逐位不变,只允许正文追加占位、images 缩短。
            // 不符 = 不重试(诚实),不做「大概没问题」的猜测重试。
            if (off && off.offloaded.length > 0 && offloadProjectionPreserved(reqMessages, off.messages)) {
              reqMessages = off.messages;
              imageOffloadApplied = true;
              try {
                journal.append({
                  kind: "custom",
                  sessionId,
                  payload: {
                    what: "image.offloaded",
                    sessionId,
                    count: off.offloaded.length,
                    files: off.offloaded.map((o) => o.path),
                    reason: "provider-image-budget",
                  },
                });
              } catch { /* 留痕失败不阻塞重试 */ }
              continue;
            }
          }
          // 视觉尺寸 400 自愈(2026-11-05 事故:10144x1146 图注入 → 每轮同样的 400,会话永久卡死)。
          // 只认「unsupported image」类可判定错误;其它 400(参数/协议/tool-pairing)原样抛出。
          if (visionRepairs < 2) {
            const rep = repairUnsupportedImage(err, reqMessages, visionRepairs);
            if (rep) {
              visionRepairs++;
              // 留痕:custom(deriveMessages 白名单不读 → 零上下文影响),可在 journal 检索 what=vision.repair。
              try {
                journal.append({
                  kind: "custom",
                  sessionId,
                  payload: { what: "vision.repair", turn, step, attempt: visionRepairs, removed: rep.removed, at: rep.at, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) },
                });
              } catch { /* 留痕失败不阻塞自愈 */ }
              continue;
            }
          }
          // M29 流中断安全锚点恢复:可重试流错误 → 从最近一次完整 tool batch 重开同一请求(每 step ≤10 次)。
          // 半截 attempt 不提交任何 message.agent(本次 chat 调用根本没成功);已提交 tool.result 原样保留。
          const cls = classifyStreamRetry(err);
          if (cls.retryable && !ac.signal.aborted && streamReopens < STREAM_REOPEN_MAX) {
            let anchor: SafeAnchor | null = null;
            try { anchor = findSafeAnchor(journal.readSession(sessionId)); } catch { anchor = null; }
            if (anchor && anchor.complete) {
              try {
                markDiscard(journal, sessionId, {
                  attemptId, turn, step, anchor,
                  reason: `${cls.reason}: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`,
                  partialChars,
                });
              } catch { /* 持久化失败只告警,不改变恢复结果 */ }
              streamReopens += 1;
              attemptId = `${sessionId}:${turn}:${step}:${++this.attemptSeq}`;
              continue; // 同一请求(reqMessages 原样,含已提交 tool 结果)重开;锚点=「已提交到哪」的哨兵
            }
            // 锚点缺失/不完整:标注 anchor-missing 并按原错误上抛(不猜)。
            try {
              markDiscard(journal, sessionId, {
                attemptId, turn, step, anchor,
                reason: `anchor-missing: ${anchor?.reason ?? "no-anchor"}; ${cls.reason}`,
                partialChars,
              });
            } catch { /* 持久化失败只告警 */ }
          }
          // 2026-10-20:失败调用也落轨迹——旧实现只在成功后上报,子代理 8 路 fetch failed
          // 在轨迹里完全不可见,只剩一句无 cause 的 finalText。
          try {
            this.opts.llmTrace?.({
              sessionId, turn, step,
              ...(modelAtStart ? { model: modelAtStart } : {}),
              durationMs: Date.now() - llmT0,
              ...(ttftMs !== undefined ? { ttftMs } : {}),
              messages,
              ...(llmVendor.describe ? { provider: llmVendor.describe() } : {}),
              tools: advertised.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
              toolNames: advertised.map((t) => t.name),
              response: { content: "" },
              error: (err instanceof Error ? err.message : String(err)).slice(0, 600),
            });
          } catch { /* 轨迹旁路:吞 */ }
          // txa4:失败调用除旁路轨迹外再落一条 **durable** journal 事件——llmTrace 只是回调
          // (装配方决定落不落盘),进程外查询/trace-stats 看不到它;llm.trace 是既有 kind,
          // payload 带非空 error 即「失败调用」(成功路径的 llm.trace 不带 error,统计侧据此区分)。
          // 取消(用户 cancel/超时 abort)不算失败:signal 已 abort 时跳过,交给 turn 的 cancelled 收口。
          // loop 拿不到落盘路径 → 不编造 file 键。journal 自身故障不得吞掉原始 err。
          if (!ac.signal.aborted) {
            try {
              journal.append({
                kind: "llm.trace",
                sessionId,
                payload: {
                  turn, step,
                  ...(modelAtStart ? { model: modelAtStart } : {}),
                  ms: Date.now() - llmT0,
                  error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
                },
              });
            } catch { /* 落账失败:继续抛原始 err */ }
          }
          throw withOffloadNote(err, imageOffloadApplied);
        }
        }
        // M28 输出截断续写(2026-11-07):finish_reason=length 且无工具调用、已写出内容时,
        // 追加一条**临时** user 提示再请求 provider,把后续输出直接拼接回本步——旧实现把截断响应
        // 当完整轮终,长回答静默丢尾。临时提示只存在于续写请求里,**绝不进 messages/journal/历史**;
        // 合并结果作为单条 message.agent 落账(message.agent/step 语义不变)。
        // 有 toolCalls 的 length 不续写:工具调用被截断交给现有配对修复,不猜。
        if (res.finishReason === "length" && !(res.toolCalls && res.toolCalls.length) && String(res.content ?? "").trim()) {
          // 续写请求复用**本次成功请求**的 messages(上面的 reqMessages,局部引用,不污染本步
          // messages):若本步做过图片 offload,续写也必须用无图版本,否则会再次撞同一图片预算错误。
          const parts: string[] = [res.content];
          let usage = res.usage;
          let attempts = 0;
          let stillLength = true;
          let lastFinish: LlmResponse["finishReason"] = res.finishReason;
          while (attempts < OUTPUT_CONTINUATION_MAX) {
            // 取消:每次续写前检查(已取消立即停,由 step 的 catch 收口为 cancelled)。
            if (ac.signal.aborted) break;
            attempts += 1;
            const next = await this.opts.llm.chat(
              [...reqMessages, { role: "user", content: OUTPUT_CONTINUATION_PROMPT }],
              advertised,
              ac.signal,
              onChunk,
              // M29:续写是独立 chat 调用,派生独立 attemptId(不与主请求的已提交 id 撞车)。
              { attemptId: `${attemptId}:cont${attempts}` },
            );
            parts.push(next.content ?? "");
            if (next.usage) usage = addUsage(usage, next.usage);
            if (next.toolCalls && next.toolCalls.length) {
              // 续写请求意外带回工具调用:并入本步,按原路径执行(不再续写)。
              res.toolCalls = [...(res.toolCalls ?? []), ...next.toolCalls];
              stillLength = false;
              lastFinish = next.finishReason;
              break;
            }
            stillLength = next.finishReason === "length";
            lastFinish = next.finishReason;
            if (!stillLength) break;
            if (!String(next.content ?? "").trim()) break; // 续写也空:再请求无益(交给正常收口)
          }
          if (ac.signal.aborted) throw new Error("cancelled:output-continuation");
          res.content = parts.join(""); // 直接拼接,不加分隔符
          if (usage) res.usage = usage;
          // 落账的结束原因取最后一次真实值(续写成功=stop,仍截断=length),不保留「本步首包」的陈旧值。
          if (lastFinish) res.finishReason = lastFinish;
          else delete res.finishReason; // 末次响应没报结束原因:如实省略,不留首包的 length
          // 第 4 次(原始 + 3 次续写)仍 length:停止并追加固定警告,不再请求。
          if (stillLength && attempts >= OUTPUT_CONTINUATION_MAX) res.content += `\n\n${OUTPUT_CONTINUATION_LIMIT_WARN}`;
        }
        // M81:本 step llm 阶段定稿(res 已合并续写);usage/ttft 累到 turn 级。
        phaseRecorder.end(phaseLlmToken);
        if (res.usage) turnUsage = addUsage(turnUsage, res.usage);
        const llmMs = Date.now() - llmT0;
        // J1 token 计时(注入闸基准):usage 存在时累加真实用量。totalTokens 缺省按 input+output 兜底
        // ——各 provider 口径不一,这两项是必填字段,总和即「本次请求烧掉的上下文量」。
        if (res.usage) {
          this.tokensSpent += res.usage.totalTokens ?? ((res.usage.inputTokens ?? 0) + (res.usage.outputTokens ?? 0));
        }
        this.opts.onStream?.({ type: "llm-end", text: res.content });
        this.lastAudio = res.audio; // 每步覆盖;无工具调用的最终响应即本轮直出音频
        // 轨迹降载(2026-10-21):语音 b64(用户输入 audio/模型直出 audio)不进轨迹文件——
        // 只留 format+字节数占位(占位形状非 AudioInput,显式断言),「怎么送的怎么记」保留形态而不再灌几百 KB 正文。
        // 2026-10-25 同策略扩到 images:dataUrl 换 KB 数占位(view_image 注入图不灌轨迹文件)。
        const traceMsgs = messages.map((m): Message => {
          if (m.role === "user" && m.audio)
            return { ...m, audio: { format: m.audio.format ?? "pcm16", bytes: m.audio.data.length } as unknown as AudioInput };
          if (m.role === "user" && m.images?.length)
            return { ...m, images: m.images.map((i) => `(data-url ${Math.round((i.length * 3) / 4 / 1024)}KB omitted)`) };
          return m;
        });

        // step-132:轨迹旁路(全量 messages+响应落装配方);try 包裹=轨迹故障绝不打断 agent 主链。
        try {
          const p = this.opts.llm as { model?: string; modelName?: string; describe?: () => Record<string, unknown> };
          this.opts.llmTrace?.({
            sessionId, turn, step,
            // 模型名用 t0 快照(modelAtStart):provider.modelName 是 getter,调用途中热切换后
            // 再读会变成「切换后的模型」,与本次请求实际用的不符(2026-11-03)。
            ...(modelAtStart ? { model: modelAtStart } : {}),
            durationMs: llmMs,
            ...(ttftMs !== undefined ? { ttftMs } : {}),
            messages: traceMsgs,
            ...(p.describe ? { provider: p.describe() } : {}),
            tools: advertised.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
            toolNames: advertised.map((t) => t.name),
            ...(res.audio ? { response: { ...res, audio: { mime: res.audio.mime, bytes: res.audio.base64.length } } as unknown as LlmResponse } : { response: res }),
          });
        } catch { /* 轨迹旁路:吞 */ }

        journal.append({
          kind: "message.agent",
          sessionId,
          payload: {
            text: res.content, toolCalls: res.toolCalls,
            turn, step, llmMs,
            ...(chatAttemptId ? { attemptId: chatAttemptId } : {}),
            ...(ttftMs !== undefined ? { ttftMs } : {}),
            ...(res.usage ? { usage: res.usage } : {}),
            ...(res.reasoning ? { reasoning: res.reasoning } : {}),
            // 模型名(2026-10-28 成本核算):成本=用量×该模型单价,统计侧必须能按模型分段。
            // 用 t0 快照 modelAtStart(2026-11-03 修):调用途中热切换时,读 provider 会得到新模型。
            ...(typeof modelAtStart === "string" && modelAtStart ? { model: modelAtStart } : {}),
          },
        });
        // M145 上下文构成归因(只观测):请求成功后按固定 8 类记 chars→tokens。
        // 总量/闸门仍只用 provider usage;本事件不参与 compact/microcompact/big-intake 决策,
        // 也不回写任何 loop 状态。落账失败静默——观测绝不打断请求。
        try {
          const every = contextBreakdownEvery();
          if (every > 0 && step % every === 0) {
            const head = messages[0];
            const bd = buildContextBreakdown({
              systemText: head && head.role === "system" ? head.content : this.opts.system,
              toolDefs: advertised,
              messages: messages.slice(1),
            });
            const providerUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
            if (res.usage) {
              if (typeof res.usage.inputTokens === "number") providerUsage.inputTokens = res.usage.inputTokens;
              if (typeof res.usage.outputTokens === "number") providerUsage.outputTokens = res.usage.outputTokens;
              if (typeof res.usage.totalTokens === "number") providerUsage.totalTokens = res.usage.totalTokens;
            }
            journal.append({
              kind: "custom",
              sessionId,
              payload: {
                what: "context.breakdown",
                sessionId, turn, step,
                entries: bd.entries,
                totalChars: bd.total.chars,
                totalTokensEstimate: bd.total.tokensEstimate,
                providerUsage,
                at: Date.now(),
              },
            });
          }
        } catch { /* 留痕失败静默 */ }
        finalText = res.content;

        if (!res.toolCalls || res.toolCalls.length === 0) {
          if (!String(res.content ?? "").trim() && !emptyTurnRetried && step < maxSteps - 1) {
            // 旧实现把空响应当合法轮终 → 任务以空结果 done(用户视角=又挂了)。重试一次;
            // 再空才接受(goal 完成校验对空终态另有拦截)。空 assistant 消息已入 journal,
            // 下次请求的历史含它,绝大多数 provider 接受空 content 的 assistant 轮。
            emptyTurnRetried = true;
            this.trajRetries += 1; // J1:空响应重试计入轨迹 retries
            journal.append({ kind: "step.end", sessionId, payload: { turn, step, reason: "empty-retry" } });
            continue;
          }
          journal.append({ kind: "step.end", sessionId, payload: { turn, step, reason: "completed" } });
          break;
        }

        // 记录本步实际派发的工具名(下一步 tips 的触发依据;含被闸拒绝的调用——动作意图同样算类别)。
        this.lastStepTools = res.toolCalls.map((c) => c.name);
        // J1 轨迹统计(纯旁路,零上下文影响):步数/调用数/工具类别计数/并行步(同一步 ≥2 调用)/
        // 本步涉及的文件夹具参数。arguments 解析失败一律吞——统计缺一项远好于打断主链。
        this.trajSteps += 1;
        this.trajCalls += res.toolCalls.length;
        if (res.toolCalls.length >= 2) this.trajParallelSteps += 1;
        const stepFiles: string[] = [];
        for (const c of res.toolCalls) {
          this.trajToolCounts.set(c.name, (this.trajToolCounts.get(c.name) ?? 0) + 1);
          try {
            const a = JSON.parse(c.arguments || "{}") as { path?: unknown; file_path?: unknown; file?: unknown };
            const p = a?.path ?? a?.file_path ?? a?.file;
            if (typeof p === "string" && p) stepFiles.push(p);
          } catch { /* 参数不可解析=本步无文件(模型可能下一步重试) */ }
        }
        this.lastStepFiles = stepFiles;
        // 延迟工具激活(2026-10-22):①被调用的工具本身(模型凭记忆直接调也算用过——执行面本就
        // 允许,下一步起进广告面);②tool_view(name) 查看即激活该工具(「用时再选」的正规通道)。
        for (const c of res.toolCalls) {
          this.activatedTools.add(c.name);
          if (c.name === "tool_view") {
            try {
              const a = JSON.parse(c.arguments) as { name?: unknown };
              if (typeof a?.name === "string" && a.name) this.activatedTools.add(a.name);
            } catch { /* 参数不可解析=不激活,模型下一步重试 */ }
          }
        }
        // 激活集落 journal(跨 loop 实例持久化:P0-2)。gateway 每 turn 新建 loop,不持久化则每 turn
        // 重演 27→29→27 的 run-start 翻转(实测单会话 10 次 = 1.47M uncached)。
        this.persistActivated();

        // 执行工具:并发安全的一起跑,不安全的独占(designs/14 §1.3)
        const calls = res.toolCalls;
        // 同参重复检测(2026-10-29 无限循环事故:board_read 去重存根+延迟加载的 board_upsert
        // 不在广告面,模型 20+ 步逐字重复同一调用直到人工取消)。连续 ≥3 步同一签名=死循环,
        // 结果尾部注入策略提示逼模型换路。
        const callSig = calls.map((c) => c.name + ":" + c.arguments).sort().join("|");
        this.stepCallStreak = callSig === this.lastStepCallSig ? this.stepCallStreak + 1 : 1;
        this.lastStepCallSig = callSig;
        const repeatNudge = this.stepCallStreak >= 3;
        // M115 循环护栏(执行前):同签名已/将要 stop 或每轮配额用尽 → 该调用**不执行**,直接回固定
        // 工具 error(稳定码 GUARD_STOP / GUARD_QUOTA)。判定用 canonical args 签名,与整步签名无关。
        const guardBlocked = new Map<string, { code: string; text: string }>();
        if (this.toolGuard) {
          for (const c of calls) {
            const block = this.toolGuard.beforeCall(c.name, callSignature(c.name, this.parseArgs(c)));
            if (block) guardBlocked.set(c.id, block);
          }
        }
        const runnable = calls.filter((c) => !guardBlocked.has(c.id));
        const safe = runnable.filter((c) => this.tools.get(c.name)?.isConcurrencySafe?.(this.parseArgs(c)) ?? false);
        const exclusive = runnable.filter((c) => !safe.includes(c));

        // M81:工具批次阶段(护栏拦截 + 安全批并行 + 独占批串行同段)。
        const phaseToolsToken: PhaseToken = phaseRecorder.begin("tools");
        const results: ToolExecOutcome[] = [];
        // 被护栏拦下的调用也落 tool.result(保 tool-pairing),error.origin=guard,模型据此换路。
        for (const c of calls) {
          const block = guardBlocked.get(c.id);
          if (!block) continue;
          results.push({
            call: c,
            content: block.text,
            durationMs: 0,
            error: { origin: "guard", message: block.text.slice(0, 600), name: c.name },
          });
        }
        // 安全批并行
        if (safe.length > 0) {
          for (const c of safe) this.opts.onStream?.({ type: "tool-begin", callId: c.id, name: c.name });
          const rs = await Promise.all(safe.map((c) => this.execOne(c, ac.signal)));
          results.push(...rs);
          for (const c of safe) { const r0 = rs.find((x) => x.call.id === c.id); this.opts.onStream?.({ type: "tool-end", callId: c.id, name: c.name, durationMs: r0?.durationMs ?? 0 }); }
        }
        // 独占批串行(barrier);取消后未派发的调用补写 ABORTED_BEFORE_DISPATCH 保证配对(designs/14 §1.3)
        for (const c of exclusive) {
          this.opts.onStream?.({ type: "tool-begin", callId: c.id, name: c.name });
          const r = ac.signal.aborted
            ? { call: c, content: "[ABORTED_BEFORE_DISPATCH]", durationMs: 0, error: { origin: "aborted" as const, message: "[ABORTED_BEFORE_DISPATCH]", name: c.name } }
            : await this.execOne(c, ac.signal);
          results.push(r);
          this.opts.onStream?.({ type: "tool-end", callId: c.id, name: c.name, durationMs: r.durationMs });
        }
        // 本批工具结果是否带错(下一步 tips 的 SOP 排障卡依据;在安全批+独占批都收集完后记):
        // 口径=ToolExecOutcome.error,与 tool.result 落账 `...(r?.error ? { error } : {})` 同源
        // (闸门拒绝/超时/取消/异常都归一成结构化 error;成功结果不带键)。
        this.lastStepError = results.some((r) => Boolean(r.error));
        if (this.lastStepError) this.totalErrors += 1;
        phaseRecorder.end(phaseToolsToken);
        // M115 循环护栏(执行后):按 calls 顺序记账(并行批的连击计数因此确定)→ notice 前置一行;
        // 只读结果第 2 次逐字相同 → 只把**模型可见文本**换成 stub(journal tool.result 原文不动)。
        if (this.toolGuard) {
          for (const call of calls) {
            const r = results.find((x) => x.call.id === call.id);
            if (!r || guardBlocked.has(call.id)) continue;
            const dec = this.toolGuard.record(
              callSignature(call.name, this.parseArgs(call)),
              resultHashOf(r.content),
              { ok: !r.error, kind: guardKindOfToolOutcome(r) },
            );
            if (dec.notice) r.content = `${dec.notice}\n${r.content}`;
            if (dec.stub) r.modelContent = dec.notice ? `${dec.notice}\n${dec.stub}` : dec.stub;
            if (dec.stop) r.modelContent = dec.stop;
          }
        }
        // J1 轨迹卡:每 N 步 / phase 切换时旁路落一条(同 step 不重复;一轮内 ≤40 条防膨胀)。
        this.emitTrajectory(sessionId, turn, step);
        // 激活标记(2026-10-30):回执携带 [[activate-tool:<name>]] → 点亮延迟工具进下一步广告面。
        // 标记从模型可见文本剥离(防模型模仿标记语法),换一句明确「下一步直接按名调用」的提示;
        // 未知工具名(不在执行面)静默忽略——标记是机制不是指令,指错名不该炸结果文本。
        const activatedNow: string[] = [];
        for (const r of results) {
          if (!r.content.includes("[[activate-tool:")) continue;
          const names = new Set<string>();
          r.content = r.content.replace(ACTIVATE_TOOL_RE, (_m, n: string) => { names.add(n); return ""; });
          for (const n of names) {
            if (this.tools.has(n)) {
              if (!this.activatedTools.has(n)) activatedNow.push(n);
              this.activatedTools.add(n);
            }
          }
          r.content = r.content.replace(/\n{3,}$/, "\n\n").trimEnd();
        }
        if (activatedNow.length) {
          // 文案对齐新语义(工具面一轮一冻):schema 清单下轮才刷新,但**执行面现在就可按名调用**
          // ——这是 `[[activate-tool:]]` 兜底仍有效的关键(历史事故:38 步 board_read 死锁)。
          const note = `\n[工具面更新] ${activatedNow.join("、")} 已激活——现在就能按名调用(工具 schema 清单下轮刷新)。`;
          for (const r of results) r.content += note;
          this.persistActivated();
        }
        if (repeatNudge) {
          for (const r of results) {
            r.content += `\n[重复调用检测] 同一组工具调用已连续 ${this.stepCallStreak} 步逐字重复——重复执行不会带来不同结果(若在等一个不出现的返回,说明你要的工具可能不在清单里:延迟加载工具先调 tool_view(name=\"...\") 激活)。请立即停止重复:换工具/换参数/基于已有结果继续,或直接输出当前进展与最终答案。`;
          }
        }

        // 按原顺序回写 journal(配对纪律;durationMs=工具执行耗时,step-031)。
        // 视觉哨兵解析(2026-10-25;2026-10-30 多图化):view_image 返回 [vision-image]{json} →
        // images 数组进 payload.images(derive 投影后置 user 消息),模型可见文本换确认句——
        // dataUrl 不进工具文本。旧单图形状 {dataUrl,label} 保持兼容(历史 journal 回放)。
        for (const call of calls) {
          const r = results.find((x) => x.call.id === call.id);
          let content = r?.content ?? "";
          let images: string[] | undefined;
          if (content.startsWith(VISION_TOOL_SENTINEL)) {
            try {
              const meta = JSON.parse(content.slice(VISION_TOOL_SENTINEL.length)) as { dataUrl?: string; images?: string[]; label?: string; errors?: string[] };
              let imgs: string[] | undefined;
              if (Array.isArray(meta.images)) imgs = meta.images.filter((u): u is string => typeof u === "string" && u.startsWith("data:image/"));
              else if (typeof meta.dataUrl === "string" && meta.dataUrl.startsWith("data:image/")) imgs = [meta.dataUrl];
              if (imgs && imgs.length > 0) {
                images = imgs;
                const errNote = Array.isArray(meta.errors) && meta.errors.length > 0 ? ";失败:" + meta.errors.join(";") : "";
                content = `图片已注入视觉通道(${imgs.length} 张):` + (meta.label ?? "") + "(下一轮对话直接可见)" + errNote;
              }
            } catch { /* 哨兵后非合法 JSON:按普通工具文本落账(工具侧格式契约被破坏时的诚实回退) */ }
          }
          journal.append({
            kind: "tool.result",
            sessionId,
            payload: {
              toolCallId: call.id, name: call.name, content,
              durationMs: r?.durationMs ?? 0,
              // txa3:归属轮/步(查询侧按步过滤;content 文本一字未改)。
              turn, step,
              ...(images ? { images } : {}),
              // M115:结果去重 stub 只换模型可见文本(deriveMessages 优先取它),原文仍在上面的 content。
              ...(r?.modelContent !== undefined ? { modelContent: r.modelContent } : {}),
              // txa1/txa2:结构化失败归因(仅失败时出现;成功结果的 payload 无 error 键)。
              ...(r?.error ? { error: r.error } : {}),
            },
          });
        }
        // 写前屏障失败出口(M24):工具未执行(错误框已随 tool.result 落账),本 turn 中止。
        // 抛错 = 任务 failed(与取消同型:不再发起后续 LLM 请求/工具,不重派整轮)。
        if (this.writeBarrierFailed) {
          throw new WriteBarrierAbortError(this.writeBarrierFailed);
        }
        // waterfall agent/turn-stopping:step 收尾后评估(designs/14 §1.2 第四拦截点)。
        if (this.opts.waterfall?.turnStopping) {
          const verdict = await this.opts.waterfall.turnStopping({ turn, step, finalText });
          if (verdict.stop) {
            const why = verdict.reason ?? "turn-stopping";
            journal.append({ kind: "step.end", sessionId, payload: { turn, step, reason: "turn-stopping", detail: why } });
            turnReason = "stopped";
            break;
          }
        }
        journal.append({ kind: "step.end", sessionId, payload: { turn, step, reason: step === maxSteps - 1 ? "max-steps" : "tools-done" } });
        if (step === maxSteps - 1) turnReason = "max-steps";
      } catch (err) {
        // 取消语义(designs/14 §1.4):LLM 请求 abort → turn 以 cancelled 收口,不当错误上抛。
        if (ac.signal.aborted) {
          journal.append({ kind: "step.end", sessionId, payload: { turn, step, reason: "cancelled" } });
          this.flushToolLoopGuard();
          journal.append({ kind: "turn.end", sessionId, payload: { turn, reason: "cancelled" } });
          return finalText;
        }
        // 写前屏障失败(M24):provider 未被调用,turn 中止(与取消同型:不再发起后续请求;
        // 抛出=任务 failed,gateway 不重派整轮)。
        if (this.writeBarrierFailed) {
          journal.append({ kind: "step.end", sessionId, payload: { turn, step, reason: "write-barrier", error: this.writeBarrierFailed.slice(0, 300) } });
          journal.append({ kind: "turn.end", sessionId, payload: { turn, reason: "write-barrier" } });
          throw new WriteBarrierAbortError(this.writeBarrierFailed);
        }
        // LLM/压缩钩子/工具执行异常:补 step+turn 边界(唯一出口,防重复)后上抛。
        journal.append({ kind: "step.end", sessionId, payload: { turn, step, reason: "error", error: String(err).slice(0, 300) } });
        // M81:失败出口先收口未 end 的 span(标 interrupted),再落遥测(先于 turn.end)。
        phaseRecorder.closeAll("interrupted");
        this.emitPhaseTelemetry(phaseState, { clock: phaseClock, recorder: phaseRecorder, turn, sessionId, turnT0, usage: turnUsage, ttftMs: turnTtftMs });
        this.flushToolLoopGuard();
        journal.append({ kind: "turn.end", sessionId, payload: { turn, reason: "error" } });
        throw err;
      }
    }
    // M81:成功出口(turn 正常收口)。
    this.emitPhaseTelemetry(phaseState, { clock: phaseClock, recorder: phaseRecorder, turn, sessionId, turnT0, usage: turnUsage, ttftMs: turnTtftMs });
    this.flushToolLoopGuard();
    journal.append({ kind: "turn.end", sessionId, payload: { turn, reason: turnReason } });
    return finalText;
  }

  /** M115:turn 结束时落一条护栏汇总(custom tool.loop.guard);仅在有 stop/notice/stub/quota 时落账。
   *  纯旁路:落账失败不影响 turn 结果。 */
  private flushToolLoopGuard(): void {
    const guard = this.toolGuard;
    if (!guard || !guard.hasActivity()) return;
    try {
      this.opts.journal.append({
        kind: "custom",
        sessionId: this.opts.sessionId,
        payload: { what: "tool.loop.guard", ...guard.stats() },
      });
    } catch { /* 遥测旁路失败不打断主链 */ }
  }

  /** M81:turn 级阶段遥测落账(每 turn 至多一条;任何异常静默)。
   *  纯观测:不改提示词/决策/返回值,也不碰任何其它 journal 事件。 */
  private emitPhaseTelemetry(
    state: { emitted: boolean },
    args: {
      clock: ReturnType<typeof createTelemetryClock>;
      recorder: PhaseRecorder;
      turn: number;
      sessionId: string;
      turnT0: number;
      usage?: LlmResponse["usage"];
      ttftMs?: number;
    },
  ): void {
    if (state.emitted) return;
    state.emitted = true; // 先置位:即便下面抛错也不会二次落账
    try {
      const totalMs = args.clock.now() - args.turnT0;
      const telemetry = buildTurnTelemetry({
        recorder: args.recorder,
        totalMs,
        ...(args.usage ? { usage: args.usage } : {}),
        expectedPhases: ["llm", "tools"],
        ...(args.ttftMs !== undefined ? { ttftMs: args.ttftMs } : {}),
        hasContent: args.ttftMs !== undefined,
        at: Date.now(),
      });
      this.opts.journal.append({
        kind: "custom",
        sessionId: args.sessionId,
        payload: {
          what: "telemetry.phase",
          turn: args.turn,
          spans: telemetry.spans,
          unionMs: telemetry.unionMs,
          unattributedMs: telemetry.unattributedMs,
          quality: telemetry.quality,
          expectedMissing: telemetry.expectedMissing,
          ...(telemetry.usage ? { usage: telemetry.usage } : {}),
          ...(telemetry.ttftMs !== undefined ? { ttftMs: telemetry.ttftMs } : {}),
          ...(telemetry.dropped ? { dropped: telemetry.dropped } : {}),
          at: telemetry.at,
        },
      });
    } catch { /* 遥测旁路失败不打断主链(含 journal 落盘失败) */ }
  }

  private parseArgs(call: ToolCall): unknown {
    try {
      return JSON.parse(call.arguments);
    } catch {
      return {};
    }
  }

  /** 归一层用的参数读取(M150):JSON 解析失败时**返回原字符串**,让 normalizeToolArgs
   *  如实报「JSON 解析失败」,而不是被 parseArgs 吞成 {} 后误报「缺 required」。
   *  只对 object schema 的工具生效——无 schema / 非 object 走 parseArgs 旧路径(零回归)。 */
  private parseArgsForTool(call: ToolCall, parameters: Record<string, unknown>): unknown {
    const schemaIsObject = typeof parameters === "object" && parameters !== null && parameters["type"] === "object";
    if (!schemaIsObject) return this.parseArgs(call);
    try {
      return JSON.parse(call.arguments);
    } catch {
      return call.arguments;
    }
  }

  /** 本步广告面:deferred 且未激活的工具不进 wire(执行面不受限)。
   *  burst 一次性放量(2026-11 token 优化轮 01):任一 deferred 工具被激活后,**所有** deferred
   *  工具一次性进广告面——否则 tool_view 每激活一个工具就把 tools schema 改一次,提示缓存整块失效
   *  (实测单次代价 196k uncached)。零激活时 burst=false,行为与旧版逐字一致(不广告任何 deferred)。 */
  /** 本 turn 广告面:同一 turn 内复用同一数组(tools schema 逐字节恒定,不随中途激活漂移)。
   *  runTurn 开头/结尾清缓存 → 本 turn 激活的 deferred 工具下 turn 才可见(schema 一轮一冻)。
   *  执行面不受限:execOne 只用 this.tools,模型直接按名调用照旧可执行。 */
  private advertisedTools(): Tool[] {
    if (this.advertisedThisTurn !== undefined) return this.advertisedThisTurn;
    // 跨 loop 实例持久化的激活集先在首次使用时读回 merge(老 journal 无该事件=空集,回落既有重建路径)。
    if (!this.activatedLoaded) {
      this.activatedLoaded = true;
      try {
        for (const n of readActivatedTools(this.opts.journal, this.opts.sessionId)) this.activatedTools.add(n);
      } catch { /* 读失败=按空集(等价首见),主链不打断 */ }
    }
    const burst = [...this.tools.values()].some((t) => t.deferred && this.activatedTools.has(t.name));
    const out: Tool[] = [];
    for (const t of this.tools.values()) {
      if (t.deferred && !burst) continue;
      out.push(t);
    }
    this.advertisedThisTurn = out;
    return out;
  }

  /** 激活集变更落 journal(按工具名幂等,集合单调)。失败只吞:激活状态是优化项,
   *  最坏退化为旧行为(下个 loop 重演一次激活),绝不打断工具执行。 */
  private persistActivated(): void {
    try {
      recordActivatedTools(this.opts.journal, this.opts.sessionId, this.activatedTools);
    } catch { /* 落账失败不影响执行面 */ }
  }

  /** 大结果闸门落账(step-1029):看板/回放读这一条判断「这次为什么进上下文的量变小了」。 */
  private recordIntake(tool: string, meta: IntakeMeta): void {
    try {
      this.opts.journal.append({
        kind: "context.intake",
        sessionId: this.opts.sessionId,
        payload: { ...meta, tool: tool || meta.tool },
      });
    } catch { /* 遥测落账失败不打断主链 */ }
  }

  private async execOne(call: ToolCall, signal?: AbortSignal): Promise<ToolExecOutcome> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      // M153:错误框附带可达候选(工具面身份来自 registry,这里只做候选建议,不改工具面)。
      const suggestion = describeUnknownTool(call.name, [...this.tools.keys()]);
      return { call, content: `错误:${suggestion.message}`, durationMs: 0, error: { origin: "unknown-tool", message: suggestion.message, name: call.name } };
    }
    // 写前屏障已在同 step 失败(M24):本 step 剩余调用一律不执行(副作用无法归因),
    // 统一回固定错误框并保留配对(缺 tool.result 会破坏 tool-pairing)。
    if (this.writeBarrierFailed) {
      return { call, content: this.writeBarrierFailed, durationMs: 0, error: { origin: "write-barrier", message: this.writeBarrierFailed.slice(0, 600), name: call.name } };
    }
    // waterfall tools/pre-execute(designs/14 §1.2):guard 挂点;权限闸门在内层,guard 拦截绕不过权限。
    const executeInner = async (): Promise<string> => {
      // 执行 deadline(2026-10-29):超时≠取消(文件系统停顿不可中断,底层 Promise 继续跑完),
      // loop 返回诚实错误让模型换路——防单工具无限挂死拖住整个 agent(冻结治理 P0)。
      // timeoutMs=0 自管豁免(terminal/spawn_subagent/ask_user 等自有超时/等待语义)。
      const capMs = tool.timeoutMs !== undefined ? tool.timeoutMs : this.opts.toolTimeoutMs ?? 0;
      if (!capMs || capMs <= 0) return await this.executeWithPermission(call, tool, signal);
      let timedOut = false;
      const raced = await Promise.race([
        this.executeWithPermission(call, tool, signal).catch((err) => {
          if (timedOut) return ""; // 超时后迟到的异常吞掉(错误已按超时交付)
          throw err;
        }),
        new Promise<{ __timeout: true }>((resolve) => setTimeout(() => resolve({ __timeout: true }), capMs).unref?.()).then((r) => {
          timedOut = true; return r;
        }),
      ]);
      if (raced && typeof raced === "object" && (raced as { __timeout?: boolean }).__timeout) {
        return `错误:工具执行超时(${Math.round(capMs / 1000)}s,${call.name})。可能原因:文件系统停顿(WSL /mnt 挂载 IO)或工具内部阻塞。底层调用未中止——若为写类操作,重试前先核实实际生效状态(重读文件/查状态),避免重复副作用。`;
      }
      return raced as string;
    };
    const t0 = Date.now();
    try {
      let content: string;
      if (this.opts.waterfall?.preExecute) {
        content = await this.opts.waterfall.preExecute(call, executeInner);
      } else {
        content = await executeInner();
      }
      // waterfall tools/post-execute:改写/截断/脱敏(原样返回=透传)。
      if (this.opts.waterfall?.postExecute) {
        content = await this.opts.waterfall.postExecute(call, content, { durationMs: Date.now() - t0 });
      }
      // 大结果闸门(step-1029,2026-11-06):**入口侧**控增量——超过本步预算且 ≥4k tok 的结果,先切块
      // 让本地 8105 判相关性(±小模型四段摘要),全文落盘,上下文只放「选块/摘要 + 全文已落盘指针」。
      // 命中闸 = 不进 spill(两者互斥,绝不双写双定形);未命中 = 走下面既有 spill,行为逐字不变。
      //
      // 取回转义口(result_read,2026-11-08):这是模型/用户**显式发起**的 dump 回读,输出已被工具自身
      // maxChars/grep/limit 约束。再经 big-intake/spill 二次提炼会把 file:line 与原文换成裸 token /
      // 「第 N/M 段」分块标记——digest 的锚点在会话内就无法自查证实,必须绕开闸门另跑小窗口命令。
      // 故 result_read 原样进历史:跳过 big-intake(不产生 context.intake、不改写 content)与 spill
      // (不落二次 dump、不加占位头)。上限由工具自身 maxChars/limit 控制;
      // 其余工具行为与视觉哨兵判断逐字不变。
      const isResultReadBack = call.name === "result_read";
      let intakeDone = false;
      if (this.opts.bigIntake && !isResultReadBack && !content.startsWith(VISION_TOOL_SENTINEL)) {
        const budgetTokens = this.growthBudgetTokens();
        if (shouldIntake(content, budgetTokens, this.opts.bigIntake)) {
          const outcome = await intakeToolResult({
            content,
            callId: call.id,
            toolName: call.name,
            goal: this.stepGoal,
            budgetTokens,
            config: this.opts.bigIntake,
          });
          if (outcome) {
            content = outcome.content;
            intakeDone = true;
            this.recordIntake(call.name, outcome.meta);
          }
        }
      }
      // 写时定形 spill(2026-11 token 轮 02):结果**进 journal/历史之前**定形一次(头+标记+尾+落盘
      // 路径),此后请求前缀逐字节稳定——读侧 microcompact 不会再改写它(标记命中「已是占位」判定)。
      // 未配置 opts.spill=完全不进此分支(行为逐字不变)。视觉哨兵不参与(它本身很小,且会被换成确认句)。
      if (!intakeDone && !isResultReadBack && this.opts.spill && !content.startsWith(VISION_TOOL_SENTINEL)) {
        try {
          // 每步新增预算(2026-11-06 v2 用户口径 1~2%):结果超过本步预算就**提前**落盘定形,
          // 不等 8k 全局阈值——「先进上下文再靠 prune 减回去」正是要治的震荡形态。
          // 预算 tokens → 字符按 ASCII 系数(0.25 tok/char)换算,即 budget×4 字符。
          const budgetChars = Math.max(0, Math.floor(this.growthBudgetTokens() / ASCII_TOKENS_PER_CHAR));
          const spillThreshold = this.opts.spill.thresholdChars !== undefined
            ? Math.min(this.opts.spill.thresholdChars, budgetChars)
            : budgetChars;
          content = await spillToolResult({
            ...this.opts.spill,
            thresholdChars: spillThreshold,
            sessionId: this.opts.sessionId,
            callId: call.id,
            toolName: call.name,
            content,
          });
        } catch {
          // 双层 fail-open:happy path 在 spillToolResult 内已兜底,这里再兜一层——
          // spill 是省 token 的优化,任何异常都不得把**已成功**的工具结果降级成错误串
          // (写/执行类工具此时可能已有副作用,模型会误判失败并重复执行)。
        }
      }
      // 失败归因(txa1/txa2):闸门拒绝/超时/取消都以**字符串**返回(不抛错),故在结果归一处
      // 按内容回判 origin;成功结果不带 error 键('error' in payload === false)。
      const failure = toolErrorOf(content, call.name);
      return { call, content, durationMs: Date.now() - t0, ...(failure ? { error: failure } : {}) };
    } catch (err) {
      if (signal?.aborted) {
        // M34:用户停止→固定停止文案;其它取消仍 [aborted]。
        const text = this.cancelledToolText(signal);
        return { call, content: text, durationMs: Date.now() - t0, error: { origin: "aborted", message: text, name: call.name } };
      }
      const message = String(err);
      return { call, content: `错误:${message}`, durationMs: Date.now() - t0, error: { origin: "threw", message, name: call.name } };
    }
  }

  /** 权限闸门(step-033)+ 工具执行(取消信号贯通:designs/14 §1.4 工具执行中发取消信号)。 */
  private async executeWithPermission(call: ToolCall, tool: Tool, signal?: AbortSignal): Promise<string> {
    // 只读豁免(isReadOnly 声明):无副作用工具在全部权限模式下直通(读类调查不设闸);
    // 写类/执行类不声明该字段,照常过闸。闸门只在规则在场时存在,豁免=与「无闸」同语义。
    if (this.opts.permission && tool.isReadOnly?.(this.parseArgs(call)) === true) {
      return await this.executeTracked(call, tool, signal);
    }
    // 重操作闸(step-071 父子 ask-answer):子代理 + 命令参数判重(未豁免)→ 绕过 allow 规则
    // 强制走 onHeavyAsk 父代理审批。闸在规则求值之前(allow 规则拦不住它),deny 规则在后段
    // 仍是硬顶;无 command 参数的工具(grep/read 等)不进本闸;heavyOp 未配置=零行为变化。
    const heavy = this.opts.permission?.heavyOp;
    if (heavy?.callerIsSubagent) {
      const heavyArgs = this.parseArgs(call) as { command?: unknown };
      if (typeof heavyArgs.command === "string" && heavyArgs.command.trim().length > 0) {
        const { classifyHeavyOp } = await import("@lampgenie/core");
        const match = classifyHeavyOp(heavyArgs.command, heavy.rules, heavy.exemptPatterns);
        if (match) {
          let ok = false;
          try { ok = heavy.onHeavyAsk ? await heavy.onHeavyAsk(call, match) : false; } catch { ok = false; }
          this.opts.journal.append({
            kind: "permission.gate",
            sessionId: this.opts.sessionId,
            payload: {
              tool: call.name,
              effect: ok ? "allowed" : "denied",
              by: ok ? "heavy-op-approved" : "heavy-op-rejected",
              heavy: match,
              command: heavyArgs.command.replace(/\s+/g, " ").slice(0, 200),
            },
          });
          if (!ok) {
            return `错误:命令被判为重操作(${match.category}${match.note ? ":" + match.note : ""}),未获父代理批准,按拒绝处理(fail-closed)。不要用拆分命令/换等价命令等方式绕过该闸;如确需执行,在最终报告里如实说明原因,由父代理重新裁决。`;
          }
        }
      }
    }
    // 权限闸门(step-033):规则在场才设闸;deny/ask(缺省)拒绝时工具不执行。
    if (this.opts.permission) {
      const { evaluatePermission } = await import("@lampgenie/core");
      // 权限域归一(C9,step-057 四期):规则的 permission 域是权限类别名(broker ask 用 "subagent"),
      // 而工具名是 "spawn_subagent"——直接拿工具名匹配恒不中,「总是允许」写的 allow 规则被绕空,
      // 工具全落 ask 兜底(fail-closed)。双候选:精确工具名命中非 ask 即用;否则剥常见动词前缀
      // (spawn_/run_/meeting_)试类别名;摘要 pattern 语义由 broker 链承担。
      // task_output→subagent(权限传递收口):后台子代理收割与派发同族——用户允许了 spawn_subagent
      // (或 subagent 类别)而收割被拦,后台流会半途断死。
      const alias = TASK_OUTPUT_ALIAS[call.name];
      const stripped = call.name.replace(/^(spawn_|run_|meeting_)/, "");
      const candidates = [call.name, ...(alias ? [alias] : []), ...(stripped !== call.name ? [stripped] : [])];
      let rule: import("@lampgenie/core").PermissionRule = { action: "ask", permission: call.name, pattern: "*" };
      for (const candidate of candidates) {
        const r = evaluatePermission(candidate, "*", [this.opts.permission.rules ?? []]);
        if (r.action !== "ask") { rule = r; break; }
      }
      const askFallback = (this.opts.permission.askMode ?? "deny") === "deny" && !this.opts.permission.onAsk;
      if (rule.action === "deny" || (rule.action === "ask" && askFallback)) {
        this.opts.journal.append({
          kind: "permission.gate",
          sessionId: this.opts.sessionId,
          payload: { tool: call.name, effect: "denied", by: rule.action === "deny" ? "rule" : "ask-default", rule },
        });
        return `错误:工具 ${call.name} 被权限规则拒绝(${rule.action === "deny" ? "deny 规则" : "ask 且无人应答,按拒绝处理"})`;
      }
      if (rule.action === "ask") {
        if (this.opts.permission.onAsk) {
          // 审批链(权限传递收口):面板/broker 裁决;异常按拒绝(fail-closed 不因回调故障放宽)。
          let ok = false;
          try { ok = await this.opts.permission.onAsk(call); } catch { ok = false; }
          this.opts.journal.append({
            kind: "permission.gate",
            sessionId: this.opts.sessionId,
            payload: { tool: call.name, effect: ok ? "allowed" : "denied", by: ok ? "ask-approved" : "ask-rejected", rule },
          });
          if (!ok) return `错误:工具 ${call.name} 被权限审批拒绝(审批未通过或超时未批,按拒绝处理;可在弹窗点「总是允许」写规则免重复审批)`;
        } else {
          this.opts.journal.append({
            kind: "permission.gate",
            sessionId: this.opts.sessionId,
            payload: { tool: call.name, effect: "allowed", by: "ask-default-allow", rule },
          });
        }
      }
    }
    return await this.executeTracked(call, tool, signal);
  }

  /** 工具入账与执行(tool.call/tool.result 由 loop 统一记;闸门放行/豁免后的共同尾段)。 */
  private async executeTracked(call: ToolCall, tool: Tool, signal?: AbortSignal): Promise<string> {
    this.opts.journal.append({
      kind: "tool.call",
      sessionId: this.opts.sessionId,
      // txa3:归属轮/步(由主循环每步写入 curTurn/curStep;直调 execOne 的单测为 0/0 占位)。
      payload: { toolCallId: call.id, name: call.name, arguments: call.arguments, turn: this.curTurn, step: this.curStep },
    });
    try {
      // 入参归一(M150):模型常把参数写成「JSON 字符串套一层」「"42"/"true"」「裸标量当数组」
      // 或 provider 化键名(file_path/oldString…)。归一 + 无歧义 coercion 后重试同一调用,
      // 比整轮重派便宜得多;不确定的保留原值交给工具(不猜、不强转)。
      // 校验失败只产出**工具结果**(固定错误框),不抛 turn 失败、不重派整轮——模型看得到
      // path/expected/got 就能自己改。
      const norm = normalizeToolArgs(this.parseArgsForTool(call, tool.parameters), tool.parameters);
      if (norm.renamed.length > 0 || norm.coerced.length > 0) {
        // 轻量旁注(payload ≤300):只记键名,不记值(可能含长正文/敏感内容)。
        try {
          this.opts.journal.append({
            kind: "custom",
            sessionId: this.opts.sessionId,
            payload: {
              what: "tool.args.normalized",
              tool: call.name,
              renamed: norm.renamed.map((r) => `${r.from}->${r.to}`).slice(0, 6).join(","),
              coerced: norm.coerced.map((c) => `${c.path}:${c.from}->${c.to}`).slice(0, 6).join(","),
            },
          });
        } catch { /* 遥测落账失败不打断执行 */ }
      }
      if (!norm.ok) return renderToolArgError(call.name, norm.issues);
      // 写前持久化屏障(M24):参数归一完成、真正执行前先把已记录事件落盘。
      // 失败 = **不执行工具**(副作用无法归因),错误框回给模型,并标记本 turn 中止。
      const barrier = await this.writeBarrier("tool", signal);
      if (!barrier.ok) {
        if (barrier.cancelled) return this.cancelledToolText(signal); // M34:用户停止文案
        this.writeBarrierFailed = writeBarrierToolText(barrier.reason ?? "unknown");
        return this.writeBarrierFailed;
      }
      const content = await tool.execute(norm.value, signal, { callId: call.id });
      return content;
    } catch (err) {
      if (signal?.aborted) return this.cancelledToolText(signal); // M34:用户停止/普通取消二分
      throw err;
    }
  }
}
