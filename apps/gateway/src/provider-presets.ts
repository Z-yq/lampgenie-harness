/**
 * Coding 模型产品化:服务商预设目录(单一出处,UI 通过 JSON 注入到面板)。
 * 真源:
 * - ZCode/config/provider/zcode-builtin.json(providerConfigRules.templateRules:真实 baseUrl/模型 ID)
 * - ZCode/config/provider/zcode-builtin.json(modelConfigRules.modelRules:contextWindow/maxTokens)
 * - 仓内 genie.config.json(qwen3-coder-flash 等既有模型 ID)
 * - SiliconFlow 官方端点 https://api.siliconflow.cn/v1(官方模型目录 vendor/model 格式)
 * - 本地服务官方默认端口(Ollama 11434 / LM Studio 1234 / vLLM 8000)
 * 红线:这里只放服务商公开 URL/公开模型 ID/本地凭证引用名,不放任何 Key 值。
 * 模型条目:有 contextWindow 元数据的用对象形态,没有规则的保持字符串(不编造)。
 */

export type PresetApiType = "chat" | "responses" | "anthropic";
export type PresetModel = string | { name: string; contextWindow?: number; maxTokens?: number };

export interface PresetMode {
  baseUrl: string;
  apiKeyEnv: string;
  /** 缺省=chat(当前运行时唯一可执行协议);anthropic/responses=配置预留。 */
  apiType?: PresetApiType;
  models: PresetModel[];
  /** UI 展示用的模式说明(可选)。 */
  note?: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  docsUrl?: string;
  keyUrl?: string;
  /** 本地服务:无 Key、允许 http://。 */
  local?: boolean;
  /** 自定义服务商:所有字段手填。 */
  custom?: boolean;
  modes: {
    api?: PresetMode;
    "token-plan"?: PresetMode;
  };
  /** 无套餐说明(该服务商只有按量 API)。 */
  planNote?: string;
}

/** 模型条目构造:有元数据才写对象(避免把未知当默认值)。 */
const m = (name: string, contextWindow?: number, maxTokens?: number): PresetModel =>
  contextWindow || maxTokens
    ? { name, ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}) }
    : name;

/** 智谱 GLM 系列 API 目录(ref providerConfigRules.bigmodel-standard-api / zai-standard-api)。 */
const GLM_API_MODELS: PresetModel[] = [
  m("GLM-5.3", 1_000_000, 128_000),
  m("GLM-5.3-Flash", 1_000_000, 128_000),
  m("GLM-5V-Turbo", 200_000, 131_072),
  m("GLM-5.1", 200_000, 64_000),
  m("GLM-5.1-Highspeed", 200_000, 64_000),
  m("GLM-5", 200_000, 64_000),
  m("GLM-5-Turbo", 200_000, 64_000),
  m("GLM-4.7", 200_000, 131_072),
  m("GLM-4.7-FlashX", 200_000, 131_072),
  m("GLM-4.7-Flash", 200_000, 131_072),
  m("GLM-4.6", 200_000, 131_072),
  m("GLM-4.5-Air", 131_072, 98_304),
  m("GLM-4.5", 131_072, 98_304),
  m("GLM-4.6V", 131_072, 32_768),
  m("GLM-4.6V-Flash", 131_072, 32_768),
  m("GLM-4.6V-FlashX", 131_072, 32_768),
  m("GLM-4.1V-Thinking-FlashX", 65_536, 32_768),
  m("GLM-4.1V-Thinking-Flash", 65_536, 32_768),
  m("GLM-4-FlashX-250414", 131_072, 16_384),
  m("GLM-4-Flash-250414", 131_072, 16_384),
  m("GLM-4V-Flash", 16_384, 1_024),
  "codegeex-4",
  m("charglm-4", 8_192, 4_096),
  "emohaa",
];

const GLM_PLAN_MODELS: PresetModel[] = [m("GLM-5.3", 1_000_000, 128_000), m("GLM-5.3-Flash", 1_000_000, 128_000)];

/** OpenRouter 目录(ref providerConfigRules.templateRules[openrouter].builtinModelIds 全量)。 */
const OPENROUTER_MODELS: PresetModel[] = [
  m("anthropic/claude-fable-5.1", 1_000_000, 128_000),
  m("openai/gpt-6-astra", 1_050_000, 128_000),
  m("openai/gpt-5.6-sol", 1_050_000, 128_000),
  m("anthropic/claude-opus-5", 1_000_000, 128_000),
  m("deepseek/deepseek-v4-pro", 1_000_000, 384_000),
  m("moonshotai/kimi-k3", 1_048_576, 131_072),
  m("z-ai/glm-5.3", 1_000_000, 128_000),
  m("qwen/qwen3.8-max", 1_000_000, 131_072),
  m("minimax/minimax-m3", 1_000_000, 32_000),
  "xiaomi/mimo-v2.5-pro",
  m("x-ai/grok-4.6", 500_000, 128_000),
  m("deepseek/deepseek-v4.1-flash", 1_000_000, 384_000),
  m("qwen/qwen3.8-max-0902", 1_000_000, 131_072),
  m("openai/gpt-5.6-terra", 1_050_000, 128_000),
  m("openai/gpt-5.6-luna", 1_050_000, 128_000),
  m("openai/gpt-5.6", 1_050_000, 128_000),
  m("openai/gpt-5.4", 1_050_000, 128_000),
  m("openai/gpt-5.4-pro", 1_050_000, 128_000),
  m("openai/gpt-5.4-mini", 400_000, 128_000),
  m("openai/gpt-5.4-nano", 400_000, 128_000),
  m("openai/gpt-5.3-codex", 400_000, 128_000),
  m("anthropic/claude-sonnet-5", 1_000_000, 128_000),
  m("anthropic/claude-haiku-4.5", 200_000, 64_000),
  "anthropic/claude-opus-4.8",
  "anthropic/claude-opus-4.7",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4.5",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4.5",
  m("deepseek/deepseek-v4-flash", 1_000_000, 384_000),
  m("moonshotai/kimi-k2.7-code", 262_144, 98_304),
  m("moonshotai/kimi-k2.6", 262_144, 98_304),
  m("moonshotai/kimi-k2.5", 262_144, 98_304),
  m("z-ai/glm-5.3-flash", 1_000_000, 128_000),
  m("z-ai/glm-5.2", 1_000_000, 128_000),
  m("z-ai/glm-5.1", 200_000, 64_000),
  m("z-ai/glm-5v-turbo", 200_000, 131_072),
  m("z-ai/glm-5", 200_000, 64_000),
  m("z-ai/glm-5-turbo", 200_000, 64_000),
  m("z-ai/glm-4.7", 200_000, 131_072),
  m("z-ai/glm-4.7-flash", 200_000, 131_072),
  m("z-ai/glm-4.6", 200_000, 131_072),
  m("z-ai/glm-4.6v", 131_072, 32_768),
  m("z-ai/glm-4.5-air", 131_072, 98_304),
  m("z-ai/glm-4.5", 131_072, 98_304),
  m("qwen/qwen3.8-flash", 1_000_000, 131_072),
  m("qwen/qwen3.7-max", 1_000_000, 131_072),
  m("qwen/qwen3.7-plus", 1_000_000, 131_072),
  m("qwen/qwen3.7-flash", 1_000_000, 131_072),
  m("qwen/qwen3.6-plus", 1_000_000, 65_536),
  m("qwen/qwen3.6-flash", 1_000_000, 65_536),
  m("qwen/qwen3.5-plus-20260420", 1_000_000, 65_536),
  m("qwen/qwen3-vl-plus", 262_144, 32_768),
  "qwen/qwen3-vl-flash",
  m("minimax/minimax-m2.7", 204_800, 32_000),
  m("minimax/minimax-m2.5", 204_800, 32_000),
  "xiaomi/mimo-v2.5",
  m("x-ai/grok-build-0.1", 256_000, 128_000),
  m("x-ai/grok-4.3", 1_000_000, 128_000),
];

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "dashscope",
    name: "阿里云百炼 · 中国",
    docsUrl: "https://bailian.console.aliyun.com/",
    keyUrl: "https://bailian.console.aliyun.com/",
    modes: {
      api: {
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKeyEnv: "DASHSCOPE_API_KEY",
        models: [
          m("qwen3.8-max", 1_000_000, 131_072),
          m("qwen3.8-flash", 1_000_000, 131_072),
          m("qwen3.7-max", 1_000_000, 131_072),
          m("qwen3.7-plus", 1_000_000, 131_072),
          m("qwen3.7-flash", 1_000_000, 131_072),
          m("qwen3.6-plus", 1_000_000, 65_536),
          m("qwen3.6-flash", 1_000_000, 65_536),
          m("qwen3.5-plus", 1_000_000, 65_536),
          m("qwen3.5-flash", 1_000_000, 65_536),
          m("qwen3-max", 262_144, 65_536),
          m("qwen-plus", 1_000_000, 32_768),
          m("qwen-flash", 1_000_000, 32_768),
          m("qwen3-vl-plus", 262_144, 32_768),
          "qwen3-coder-flash",
        ],
      },
    },
    planNote: "无套餐;ZCode 内置目录未提供 DashScope Coding 套餐端点,按量 API 接入。",
  },
  {
    id: "dashscope-intl",
    name: "阿里云百炼 · 国际",
    docsUrl: "https://modelstudio.console.aliyun.com/",
    keyUrl: "https://modelstudio.console.aliyun.com/",
    modes: {
      api: {
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        apiKeyEnv: "DASHSCOPE_INTL_API_KEY",
        models: [
          m("qwen3.8-max", 1_000_000, 131_072),
          m("qwen3.8-flash", 1_000_000, 131_072),
          m("qwen3.8-omni-flash", 65_536, 16_384),
          m("qwen3.7-max", 1_000_000, 131_072),
          m("qwen3.7-plus", 1_000_000, 131_072),
          m("qwen3.7-flash", 1_000_000, 131_072),
          m("qwen3.6-plus", 1_000_000, 65_536),
          m("qwen3.6-flash", 1_000_000, 65_536),
          m("qwen3.5-plus", 1_000_000, 65_536),
          m("qwen3.5-flash", 1_000_000, 65_536),
          m("qwen3-max", 262_144, 65_536),
          m("qwen-plus", 1_000_000, 32_768),
          m("qwen-flash", 1_000_000, 32_768),
          m("qwen3-vl-plus", 262_144, 32_768),
        ],
      },
    },
    planNote: "无套餐;ZCode 内置目录未提供 DashScope Coding 套餐端点,按量 API 接入。",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    docsUrl: "https://platform.deepseek.com/",
    keyUrl: "https://platform.deepseek.com/api_keys",
    modes: {
      api: {
        baseUrl: "https://api.deepseek.com",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        models: [m("deepseek-flash", 1_000_000, 384_000), m("deepseek-v4-pro", 1_000_000, 384_000)],
      },
    },
    planNote: "DeepSeek 为按量 API,无 Coding 套餐端点。",
  },
  {
    id: "moonshot",
    name: "Kimi(Moonshot)",
    docsUrl: "https://platform.moonshot.cn/",
    keyUrl: "https://platform.kimi.com/console/api-keys",
    modes: {
      api: {
        baseUrl: "https://api.moonshot.cn/v1",
        apiKeyEnv: "MOONSHOT_API_KEY",
        models: [
          m("kimi-k3", 1_048_576, 131_072),
          m("kimi-k2.7-code", 262_144, 98_304),
          m("kimi-k2.6", 262_144, 98_304),
          "kimi-k2.7-code-highspeed",
          "k3",
          "k3-256k",
        ],
      },
    },
    planNote: "按量 API 接入,未发现 Coding 套餐端点。",
  },
  {
    id: "zai",
    name: "Z.ai",
    docsUrl: "https://z.ai/",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    modes: {
      api: {
        baseUrl: "https://api.z.ai/api/paas/v4",
        apiKeyEnv: "ZAI_API_KEY",
        models: GLM_API_MODELS,
      },
      "token-plan": {
        baseUrl: "https://api.z.ai/api/anthropic",
        apiKeyEnv: "ZAI_CODING_PLAN_API_KEY",
        apiType: "anthropic",
        models: GLM_PLAN_MODELS,
        note: "Coding Plan 走 Anthropic Messages;当前运行时适配中,配置可先保存。",
      },
    },
  },
  {
    id: "bigmodel",
    name: "智谱 BigModel",
    docsUrl: "https://bigmodel.cn/",
    keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    modes: {
      api: {
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        apiKeyEnv: "BIGMODEL_API_KEY",
        models: GLM_API_MODELS,
      },
      "token-plan": {
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        apiKeyEnv: "BIGMODEL_CODING_PLAN_API_KEY",
        apiType: "anthropic",
        models: GLM_PLAN_MODELS,
        note: "Coding Plan 走 Anthropic Messages;当前运行时适配中,配置可先保存。",
      },
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    docsUrl: "https://openrouter.ai/",
    keyUrl: "https://openrouter.ai/keys",
    modes: {
      api: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
        models: OPENROUTER_MODELS,
      },
    },
    planNote: "聚合按量 API,无 Coding 套餐。",
  },
  {
    id: "openai",
    name: "OpenAI",
    docsUrl: "https://platform.openai.com/",
    keyUrl: "https://platform.openai.com/api-keys",
    modes: {
      api: {
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        models: [
          m("gpt-6-astra", 1_050_000, 128_000),
          m("gpt-5.6-sol", 1_050_000, 128_000),
          m("gpt-5.6-terra", 1_050_000, 128_000),
          m("gpt-5.6-luna", 1_050_000, 128_000),
          m("gpt-5.6", 1_050_000, 128_000),
          m("gpt-5.4", 1_050_000, 128_000),
          m("gpt-5.4-pro", 1_050_000, 128_000),
          m("gpt-5.4-mini", 400_000, 128_000),
          m("gpt-5.4-nano", 400_000, 128_000),
          m("gpt-5.3-codex", 400_000, 128_000),
        ],
      },
    },
    planNote: "按量 API,无 Coding 套餐。",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    docsUrl: "https://console.anthropic.com/",
    keyUrl: "https://console.anthropic.com/settings/keys",
    modes: {
      api: {
        baseUrl: "https://api.anthropic.com/v1",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        apiType: "anthropic",
        models: [
          m("claude-fable-5-1", 1_000_000, 128_000),
          m("claude-fable-5", 1_000_000, 128_000),
          m("claude-opus-5", 1_000_000, 128_000),
          m("claude-sonnet-5", 1_000_000, 128_000),
          m("claude-haiku-4-5-20251001", 200_000, 64_000),
        ],
        note: "Anthropic Messages 协议;当前运行时适配中,配置可先保存。",
      },
    },
    planNote: "按量 API,无 Coding 套餐。",
  },
  {
    id: "xai",
    name: "xAI",
    docsUrl: "https://console.x.ai/",
    keyUrl: "https://console.x.ai/",
    modes: {
      api: {
        baseUrl: "https://api.x.ai/v1",
        apiKeyEnv: "XAI_API_KEY",
        models: [m("grok-4.6", 500_000, 128_000), m("grok-build-0.1", 256_000, 128_000), m("grok-4.3", 1_000_000, 128_000)],
      },
    },
    planNote: "按量 API,无 Coding 套餐。",
  },
  {
    id: "minimax",
    name: "MiniMax",
    docsUrl: "https://platform.minimaxi.com/",
    keyUrl: "https://platform.minimaxi.com/console/access?tab=api-keys",
    modes: {
      api: {
        baseUrl: "https://api.minimax.chat/v1",
        apiKeyEnv: "MINIMAX_API_KEY",
        models: [
          m("MiniMax-M3", 1_000_000, 32_000),
          m("MiniMax-M2.7", 204_800, 32_000),
          m("MiniMax-M2.7-highspeed", 204_800, 32_000),
          m("MiniMax-M2.5", 204_800, 32_000),
          m("MiniMax-M2.5-highspeed", 204_800, 32_000),
          m("MiniMax-M2.1", 204_800, 32_000),
          m("MiniMax-M2.1-highspeed", 204_800, 32_000),
          m("MiniMax-M2", 204_800, 131_072),
        ],
      },
    },
    planNote: "按量 API,未发现 Coding 套餐端点。",
  },
  {
    id: "siliconflow",
    name: "硅基流动 SiliconFlow",
    docsUrl: "https://siliconflow.cn/",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    modes: {
      api: {
        baseUrl: "https://api.siliconflow.cn/v1",
        apiKeyEnv: "SILICONFLOW_API_KEY",
        models: ["deepseek-ai/DeepSeek-V3.2", "Qwen/Qwen3-8B", "zai-org/GLM-5.2", "deepseek-ai/DeepSeek-R1"],
      },
    },
    planNote: "按量 API,无 Coding 套餐。",
  },
  {
    id: "ollama",
    name: "Ollama(本地)",
    local: true,
    modes: {
      api: {
        baseUrl: "http://localhost:11434/v1",
        apiKeyEnv: "",
        models: [],
        note: "本地服务无需 Key;模型来自本机已拉取列表,点「拉取模型列表」。",
      },
    },
    planNote: "本地服务,无套餐。",
  },
  {
    id: "lmstudio",
    name: "LM Studio(本地)",
    local: true,
    modes: {
      api: {
        baseUrl: "http://localhost:1234/v1",
        apiKeyEnv: "",
        models: [],
        note: "本地服务无需 Key;模型来自本机已加载列表,点「拉取模型列表」。",
      },
    },
    planNote: "本地服务,无套餐。",
  },
  {
    id: "vllm",
    name: "vLLM(本地)",
    local: true,
    modes: {
      api: {
        baseUrl: "http://localhost:8000/v1",
        apiKeyEnv: "",
        models: [],
        note: "本地服务无需 Key;模型来自 vLLM 服务端,点「拉取模型列表」。",
      },
    },
    planNote: "本地服务,无套餐。",
  },
  {
    id: "custom",
    name: "自定义服务商",
    custom: true,
    modes: {
      api: {
        baseUrl: "",
        apiKeyEnv: "CUSTOM_API_KEY",
        models: [],
        note: "手填 baseUrl / API Key / 模型,适配私有网关或未收录服务商。",
      },
    },
    planNote: "自定义渠道无预设套餐。",
  },
];
