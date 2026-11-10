/**
 * 生产装配工厂:从 Config(default < user < project < env 多层合并,packages/core/src/config)构造 executor 与 LLM。
 * 凭证只经 resolveLlmApiKey(env > secrets.json),绝不写日志、绝不落配置文件。
 * 旧 env 直读入口(GENIE_EXECUTOR/GENIE_LLM_*)仍有效——loadConfig 的 env 层已覆盖同语义。
 */
import type { SubagentBackend } from "@lampgenie/executors";
import { EchoChildBackend, createCliBackend } from "@lampgenie/executors";
import { resolveTrackApiKey, resolveTrackEndpoint, resolveLlmApiKey, resolveLlmEndpoint, modelMetaOf, resolveCodingModelRoute, type Config } from "@lampgenie/core";
import type { LlmProvider } from "@lampgenie/runtime/agent/loop";
import { DshSdkBackend, resolveDshCliCommand } from "@lampgenie/executors/dsh-sdk-backend";
import { createOpenAiCompatProvider } from "@lampgenie/runtime/agent/openai-provider";
import { createRealtimeProvider } from "@lampgenie/runtime/agent/realtime-provider";
import { getWorkflowConcurrencyCoordinator } from "@lampgenie/runtime/concurrency/governor";
import { resolveImplementationEffort, resolveRoleEffort } from "./effort-policy.js";
import { resolveRequestMaxTokens } from "./request-budget.js";
import { inflightAdmissionFor } from "./llm-inflight.js";

export function buildExecutorFromConfig(config: Config): SubagentBackend | undefined {
  switch (config.executor.kind) {
    case "echo":
      return new EchoChildBackend();
    case "dsh": {
      // dsh 已构建(2026-10-12,~/dsh-build);CLI 产物解析不到仍 fail-visible(凭证/路由由 env 注入)。
      const cli = resolveDshCliCommand(process.env.GENIE_REPO_ROOT ?? process.cwd());
      if (!cli) throw new Error("executor.kind=dsh:未找到 dsh CLI 产物(设 DSH_SDK_CLI 为 JSON 启动命令,如 {\"cmd\":\"node\",\"args\":[\"/path/bin.mjs\"]})");
      const provider = process.env.DSH_SDK_PROVIDER ?? "deepseek-official";
      const model = process.env.DSH_SDK_MODEL ?? "deepseek-chat";
      const env: Record<string, string> = {};
      for (const k of ["DEEPSEEK_API_KEY", "DSH_HOME", "DSH_SDK_PROVIDER", "DSH_SDK_MODEL"]) {
        if (process.env[k]) env[k] = process.env[k]!;
      }
      return new DshSdkBackend({ command: cli, provider, model, env, wallClockMs: Number(process.env.DSH_SDK_WALLCLOCK_MS ?? 600_000) });
    }
    case "zcode":
    case "opencode": {
      // 外部 CLI 一次性后端(step-007 收口):bin 从 env 覆盖(GENIE_ZCODE_BIN/GENIE_OPENCODE_BIN),
      // 缺省 PATH 解析;缺二进制=spawn-failed fail-visible(不静默降级)。
      return createCliBackend(config.executor.kind, {
        bin: process.env[config.executor.kind === "zcode" ? "GENIE_ZCODE_BIN" : "GENIE_OPENCODE_BIN"] ?? undefined,
      });
    }
    case "none":
      return undefined;
  }
}

/** reasoningEffort 显式性判定(step-069 安全修法):仅显式配置进请求体。schema default "high"
 * 是 UI 缺省显示口径(2026-10-13 用户拍板),不代表用户显式选择——直接透传会让全量请求都携带
 * reasoning_effort(step-064 搁置原因)。装配面按 loadConfig 的 sources 层标记判显式:
 * user/project/env 层=显式(携带),"default" 层或来源未知=未配置(不携带);"" 恒不携带(显式关)。 */
export function explicitReasoningEffort(sources: Record<string, string> | undefined, key: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const src = sources?.[key];
  return src && src !== "default" ? value : undefined;
}

/** 按(轨,引用)构建 provider:providerId 继承端点+按轨凭证解析。
 * reasoningEffort=调用方已判定的显式值(见 explicitReasoningEffort);undefined=请求不带该参数。
 * apiType(step-127 运行时适配):从 providers[id] 继承(resolveTrackEndpoint),非 chat 时
 * 透传给 provider→anthropic(/v1/messages)/responses(/v1/responses)协议分支;chat/未声明=现状。 */
function providerFromRef(
  config: Config, repoRoot: string,
  track: "coding" | "audio.chat" | "audio.asr" | "audio.tts",
  ref: { baseUrl?: string; providerId?: string; model?: string; apiKeyEnv?: string; timeoutMs?: number; maxTokens?: number },
  reasoningEffort?: string,
): ReturnType<typeof createOpenAiCompatProvider> | undefined {
  const { baseUrl, apiKeyEnv, apiType } = resolveTrackEndpoint(config, track, ref);
  if (!baseUrl || !ref.model) return undefined;
  const apiKey = resolveTrackApiKey(track, apiKeyEnv, { repoRoot });
  if (!apiKey) throw new Error(`${track} 端点/模型已配置但凭证不可解析(env ${apiKeyEnv} 或 .genie/secrets.json)`);
  // 429 重试+governor 准入(step-008 收口):coding 轨(进程级 provider 桶 AIMD 自适应,
  // 429→model_retry_scheduled→cap 减半;GENIE_LLM_ADMISSION=off 显式关闭)。
  // 2026-10-20:passthrough 只观测不排队,10 路并发首调实测 8 路建连超时——叠加按端点的
  // 在飞信号量(GENIE_LLM_MAX_INFLIGHT,缺省 4),同 baseUrl 的主/角色/子代理共享配额。
  const admission = track === "coding" && process.env.GENIE_LLM_ADMISSION !== "off"
    ? inflightAdmissionFor(baseUrl, getWorkflowConcurrencyCoordinator().passthrough())
    : undefined;
  // step-048 ZCode 模型管理语义:per-model maxTokens 优先(条目元数据),轨级回退。
  // step-139 O4:meta 只作上限(默认收敛 32000),config 显式值才覆盖;超默认值打可见 warning。
  const meta = modelMetaOf(config, ref.model);
  const budget = resolveRequestMaxTokens(ref.maxTokens, meta?.maxTokens);
  if (budget.warning) console.warn("[gateway] " + budget.warning);
  return createOpenAiCompatProvider({ baseUrl, model: ref.model, apiKey, timeoutMs: ref.timeoutMs, maxTokens: budget.value, ...(apiType && apiType !== "chat" ? { apiType } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), retry: Number(process.env.GENIE_LLM_RETRY ?? 2), admission });
}

export function buildLlmFromConfig(config: Config, repoRoot: string, _sources?: Record<string, string>): LlmProvider | undefined {
  // coding 轨(vibe coding);step-139 O2:主实施轨 effort=implementationEffort(缺省 high,唯一权威)。
  // 2026-10-20:选择即 (providerId, model) 对——路由由拥有该模型的 Provider 派生,不信 config 里可能陈旧的
  // baseUrl/apiKeyEnv(「模型新、路由旧」是 401/404 的结构性来源)。
  // 部分配置(无 coding 段,如测试只给 { agent: { planGate } })→ undefined,不抛:
  // 与 buildVlmFromConfig「未配置=undefined」同语义,调用方按无 LLM 降级。
  const ref = config.coding?.llm as { model?: string; implementationEffort?: string } | undefined;
  if (!ref?.model) return undefined;
  const route = resolveCodingModelRoute(config, ref);
  return providerFromRef(config, repoRoot, "coding", { ...ref, ...route },
    resolveImplementationEffort(ref.implementationEffort));
}

/**
 * 视觉兜底模型(2026-10-25;二次定稿=同 provider 语义,coding.vlm 只填 model):
 * 继承 coding.llm 的 baseUrl/providerId/apiKeyEnv/apiType(roleFrom 同款合并+模型路由派生,
 * 防跨 Provider 错配),主模型无视觉时 view_image 用它把图转文字描述;未配置=undefined。
 */
export function buildVlmFromConfig(config: Config, repoRoot: string): LlmProvider | undefined {
  const ref = config.coding.vlm;
  if (!ref?.model) return undefined;
  const merged = { ...config.coding.llm, ...ref, model: ref.model };
  const route = resolveCodingModelRoute(config, merged);
  return providerFromRef(config, repoRoot, "coding", { ...merged, ...route });
}

/** TTS 客户端(designs/07):audio.tts 轨→音频 bytes。凭证各轨各解析;未配置=undefined(调用方诚实降级为无播报)。
 * 2026-10-13:路径/形态按 dashscope SDK 1.27 http_tts 实证收敛——POST {base}/api/v1/services/audio/tts/SpeechSynthesizer,
 * body {model, input:{text, voice, format}}(旧 /services/audio/tts 无后缀路径在 MAAS workspace 返回 url error,
 * 且 config.voice 此前从未被传入请求体=音色恒默认,一并修复);返回假 RIFF 头就地修复(声明长度=真实数据长度)。 */
export interface TtsClient {
  /** 文本→音频(base64);失败抛错(调用方 fail-soft)。opts.voice=单次音色覆盖(试听,不落配置)。 */
  speak(text: string, opts?: { voice?: string }): Promise<{ mime: string; base64: string }>;
}

/** 就地修复假 RIFF 头(qwen TTS OSS wav 的 nframes 恒为垃圾值,前端 <audio> 时长/进度条失真)。 */
function repairRiff(buf: Buffer): Buffer {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return buf;
  const out = Buffer.from(buf);
  out.writeUInt32LE(out.length - 8, 4); // RIFF 块总长
  for (let off = 12; off + 8 <= out.length;) {
    const id = out.toString("ascii", off, off + 4);
    const size = out.readUInt32LE(off + 4);
    if (id === "data") { out.writeUInt32LE(out.length - off - 8, off + 4); break; }
    off += 8 + size + (size % 2);
  }
  return out;
}

export function buildTtsFromConfig(config: Config, repoRoot: string): TtsClient | undefined {
  const tts = config.audio.tts;
  if (!tts.model && !tts.baseUrl && !tts.providerId) return undefined;
  const { baseUrl, apiKeyEnv } = resolveTrackEndpoint(config, "audio.tts", tts);
  if (!tts.model || !baseUrl) return undefined;
  const apiKey = resolveTrackApiKey("audio.tts", apiKeyEnv, { repoRoot });
  if (!apiKey) throw new Error(`audio.tts 端点/模型已配置但凭证不可解析(env ${apiKeyEnv} 或 .genie/secrets.json)`);
  const apiBase = baseUrl.replace(/\/$/, "").replace(/\/api\/v1$/, "");
  const input: Record<string, string> = { text: "", format: "wav", ...(tts.voice ? { voice: tts.voice } : {}) };
  return {
    async speak(text: string, o?: { voice?: string }) {
      input.text = text;
      const res = await fetch(`${apiBase}/api/v1/services/audio/tts/SpeechSynthesizer`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: tts.model, input: { ...input, ...(o?.voice ? { voice: o.voice } : {}) } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const data = (await res.json()) as { output?: { audio?: { url?: string; data?: string; mime?: string } } };
      const url = data.output?.audio?.url;
      if (typeof url === "string" && url) {
        const audio = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!audio.ok) throw new Error(`tts audio ${audio.status}`);
        const buf = repairRiff(Buffer.from(await audio.arrayBuffer()));
        return { mime: audio.headers.get("content-type")?.split(";")[0] ?? "audio/wav", base64: buf.toString("base64") };
      }
      // 端点直返内联数据(OpenAI 兼容语音面)。
      const inline = data.output?.audio?.data;
      if (typeof inline === "string" && inline) {
        return { mime: data.output?.audio?.mime ?? "audio/wav", base64: inline };
      }
      throw new Error("tts 响应无音频(url/data 皆缺)");
    },
  };
}

/** audio.chat 语音链路形态(2026-10-21 音频链路优化,genie-voice 两口径):
 * - omni-query:一次 query 调用(qwen3.8-omni* 口径)——音/视频作为输入内容直接进一次
 *   OpenAI 兼容 chat(多模态 content:input_audio/image_url),文本出,再走既有 audio.tts 外接转语音;
 * - realtime-plus:realtime 会话(qwen-audio-3.1-realtime* 口径,语音输入)——语音直接进 api-ws 会话,
 *   text+audio 直出(模型自带语音,LlmResponse.audio),链路上不再外挂 tts。
 * 推断序:显式 chatMode > 显式 protocol(chat→omni-query;realtime→realtime-plus)>
 * 模型名 /realtime/i(realtime*)→realtime-plus,其余(含 qwen3.8-omni*)→omni-query。
 * 与旧 isRealtime 判定同基(缺省 realtime 模型走 WS 不变),omni/文本模型走 HTTP 不变。 */
export type AudioChatMode = "omni-query" | "realtime-plus";
export function resolveAudioChatMode(chat: { model?: string; protocol?: string; chatMode?: string }): AudioChatMode {
  if (chat.chatMode === "omni-query" || chat.chatMode === "realtime-plus") return chat.chatMode;
  if (chat.protocol === "chat") return "omni-query";
  if (chat.protocol === "realtime" || /realtime/i.test(chat.model ?? "")) return "realtime-plus";
  return "omni-query";
}

/** audio 轨(主 agent):chat 大脑;未配置返回 undefined(调用方显式回退 coding 并打标,不静默混轨)。
 * 形态分派(2026-10-21,resolveAudioChatMode):
 * - realtime-plus → DashScope api-ws WS provider,text+audio 直出(audioOut)+chat.voice 音色
 *   ——回复自带模型语音,上游消费点(companion 广播)不再外挂 tts;
 * - omni-query(缺省)→ OpenAI 兼容 HTTP,音频经 input_audio 内容件直接进一次 query,文本出,再走既有 tts。
 * sources(step-069):OpenAI 兼容路径 reasoningEffort 仅显式配置进请求体(与 coding 轨同语义);
 * realtime WS 路径无该参数(协议面无此字段,不携带)。 */
export function buildAudioChatFromConfig(config: Config, repoRoot: string, sources?: Record<string, string>): LlmProvider | undefined {
  const chat = config.audio.chat;
  if (!chat.model && !chat.baseUrl && !chat.providerId) return undefined;
  const { baseUrl, apiKeyEnv, apiType } = resolveTrackEndpoint(config, "audio.chat", chat);
  if (!chat.model || !baseUrl) return undefined;
  const apiKey = resolveTrackApiKey("audio.chat", apiKeyEnv, { repoRoot });
  if (!apiKey) throw new Error(`audio.chat 端点/模型已配置但凭证不可解析(env ${apiKeyEnv} 或 .genie/secrets.json)`);
  if (resolveAudioChatMode(chat) === "realtime-plus") {
    return createRealtimeProvider({ baseUrl, model: chat.model, apiKey, timeoutMs: chat.timeoutMs, audioOut: true, ...(chat.voice ? { voice: chat.voice } : {}) });
  }
  const effort = explicitReasoningEffort(sources, "audio.chat.reasoningEffort", chat.reasoningEffort);
  return createOpenAiCompatProvider({ baseUrl, model: chat.model, apiKey, timeoutMs: chat.timeoutMs, maxTokens: chat.maxTokens,
    ...(apiType && apiType !== "chat" ? { apiType } : {}), ...(effort ? { reasoningEffort: effort } : {}) });
}

export interface ModelProviders {
  main?: ReturnType<typeof createOpenAiCompatProvider>;
  /** 压缩模型(未配置=undefined,调用方回退主 provider)。 */
  compact?: ReturnType<typeof createOpenAiCompatProvider>;
  /** code_review 深审模型(未配置也按角色 effort 建:继承主模型,effort 缺省 xhigh)。 */
  review?: ReturnType<typeof createOpenAiCompatProvider>;
  /** 子代理模型(2026-10-20 用户口径:子代理默认与主 agent 用相同模型)。
   * 未显式配 models.subagent.model=undefined——调用方回退主 provider(agent-wiring `models?.subagent ?? llm`),
   * 模型/端点/effort 全跟随主轨,主模型热切换天然同步;显式配置才建独立实例(高级用法)。 */
  subagent?: ReturnType<typeof createOpenAiCompatProvider>;
  /** 提炼模型(2026-11 大结果/diff 提炼):未配置=undefined,调用方回退 compact(coalesce 顺序 digest→compact→aux)。 */
  digest?: ReturnType<typeof createOpenAiCompatProvider>;
}

/**
 * 按角色构建模型 provider(step-139 O2 改造):
 * - 主实施轨 effort = implementationEffort(缺省 high);旧 coding.llm.reasoningEffort 对主轨不再生效
 *   (2026-10-20 用户拍板:implementationEffort 是主轨唯一权威)。
 * - review 恒建(不必显式配 models.*:模型/端点/凭证/超时仍继承 coding.llm,只有 effort 按角色),
 *   effort = 显式 coding.models.<role>.reasoningEffort > 缺省 xhigh。
 * - subagent(2026-10-20 用户口径)未显式配 model=undefined 回退主 provider(与主 agent 完全同模型
 *   同档位,主模型热切天然跟随);显式配 model 才按 review 同语义建独立实例。
 * - compact 仍只在显式配置时构建(不配=调用方回退主 provider,消费点在 compact-hook);
 *   配了则 effort 缺省 xhigh,可用 coding.models.compact.reasoningEffort 显式降档。
 */
export function buildModelProviders(config: Config, repoRoot: string, _sources?: Record<string, string>): ModelProviders {
  const implEffort = resolveImplementationEffort((config.coding.llm as { implementationEffort?: string }).implementationEffort);
  // 主轨路由由模型拥有者派生(providerId/model 一致性);roleFrom 同样按 registry 语义解析,
  // 修复「review 配 deepseek 但继承了主轨的智谱端点」这类跨 Provider 模型错配。
  const mainRef = resolveCodingModelRoute(config, config.coding.llm);
  const main = providerFromRef(config, repoRoot, "coding", { ...config.coding.llm, ...mainRef }, implEffort) as ModelProviders["main"];
  if (!main) return {};
  const roleFrom = (
    role: "compact" | "review" | "subagent" | "digest",
    ref: { model?: string; baseUrl?: string; providerId?: string; apiKeyEnv?: string; timeoutMs?: number; maxTokens?: number; reasoningEffort?: string } | undefined,
    /** true=未配置时回退 undefined(compact 旧语义);false=未配置也继承主模型建实例(review/subagent)。 */
    skipWhenUnconfigured: boolean,
  ) => {
    if ((!ref || !ref.model) && skipWhenUnconfigured) return undefined;
    const merged = { ...config.coding.llm, ...(ref ?? {}), model: ref?.model ?? config.coding.llm.model };
    const route = resolveCodingModelRoute(config, merged);
    const effort = resolveRoleEffort(ref?.reasoningEffort);
    return providerFromRef(config, repoRoot, "coding", { ...merged, ...route }, effort);
  };
  return {
    main,
    compact: roleFrom("compact", config.coding.models.compact, true),
    review: roleFrom("review", config.coding.models.review, false),
    // 2026-10-20 用户口径「子 agent 要用和主 agent 相同的模型」:未显式配 model 不再恒建独立实例
    // (旧:继承主模型名但 effort 独立 xhigh——主模型热切后角色实例与主轨漂移,且档位不一致);
    // 直接 undefined 回退主 provider,同实例同模型同 effort。显式配置才独立(高级用法)。
    subagent: config.coding.models.subagent?.model ? roleFrom("subagent", config.coding.models.subagent, true) : undefined,
    // 提炼模型(2026-11):未配 model → undefined(与 compact 同语义),调用方回退 compact。
    digest: roleFrom("digest", config.coding.models.digest, true),
  };
}

/**
 * m1(会话覆盖 → 角色轨):把会话选择(已解析出 model/providerId)应用到 `coding.models.<role>`。
 *
 * 优先级判定(**显式优先**;与 ZCode 的 subagent_model 语义对齐):
 *  1. 全局 `coding.models.<role>.model` **显式非空** → 保留该角色自己的模型端点/凭证(用户明确
 *     指定了「这个角色用别的模型」,会话主模型切换不得静默覆盖它)——**但**若该角色显式配置的
 *     providerId 与会话选中的 providerId 相同,视为「同一端点上的角色档位」,把 model 换成会话模型
 *     (用户意图=端点和主会话一致,只是显式声明了 role 槽位);
 *  2. 该角色未显式配置 model → 跟随会话选择(model/providerId 都换成会话值),即 override > 全局。
 *
 * 返回新 config(不就地改传入对象)+ 判定说明(notes,给 journal/日志用)。
 * 注意:compact 的语义是「未配置=回退主 provider」,故这里只补 model/providerId 字段,
 * 具体实例是否构建仍由 buildModelProviders 的 skipWhenUnconfigured 口径决定。
 */
export function applySessionModelToRoles(
  config: Config,
  selection: { model: string; providerId?: string },
): { config: Config; notes: string[] } {
  const roles = ["compact", "review", "subagent"] as const;
  const notes: string[] = [];
  const models: Record<string, unknown> = { ...config.coding.models };
  for (const role of roles) {
    const ref = models[role] as { model?: string; providerId?: string } | undefined;
    const explicitModel = typeof ref?.model === "string" && ref.model.length > 0;
    const sameProvider = Boolean(selection.providerId) && ref?.providerId === selection.providerId;
    if (explicitModel && !sameProvider) {
      notes.push(`${role}:保留显式配置(${ref?.model}${ref?.providerId ? "@" + ref.providerId : ""})——显式优先,不跟随会话模型`);
      continue;
    }
    if (explicitModel && sameProvider) {
      notes.push(`${role}:显式同 Provider,model 换成会话模型 ${selection.model}`);
    } else {
      notes.push(`${role}:未显式配置 → 跟随会话模型 ${selection.model}${selection.providerId ? "@" + selection.providerId : ""}`);
    }
    models[role] = {
      ...(ref ?? {}),
      model: selection.model,
      ...(selection.providerId ? { providerId: selection.providerId } : {}),
    };
  }
  return { config: { ...config, coding: { ...config.coding, models: models as Config["coding"]["models"] } }, notes };
}

// ---- 兼容旧入口(测试/脚本仍在用;env 直读) ----
export function buildExecutorFromEnv(): SubagentBackend | undefined {
  const kind = process.env.GENIE_EXECUTOR ?? "echo";
  return buildExecutorFromConfig({ executor: { kind: kind as Config["executor"]["kind"] } } as Pick<Config, "executor"> as Config);
}

export function buildLlmFromEnv(): LlmProvider | undefined {
  const baseUrl = process.env.GENIE_LLM_BASE_URL;
  const model = process.env.GENIE_LLM_MODEL;
  const apiKey = process.env.GENIE_LLM_API_KEY;
  if (!baseUrl || !model) return undefined;
  if (!apiKey) throw new Error("GENIE_LLM_BASE_URL/MODEL 已设置但缺 GENIE_LLM_API_KEY");
  // apiType(step-127):env 通道同享协议分派(GENIE_LLM_API_TYPE=anthropic|responses);
  // 未设/非法值=chat 现状。
  const apiType = process.env.GENIE_LLM_API_TYPE;
  return createOpenAiCompatProvider({ baseUrl, model, apiKey, ...(apiType === "anthropic" || apiType === "responses" ? { apiType } : {}) });
}
