/**
 * 模型选择 → Provider 路由解析(对齐 ZCode 的 registry 语义):
 * 选择是一个 (providerId, modelId) 对,端点/协议/凭证永远由**拥有该模型的 Provider** 派生;
 * 不允许出现「模型来自 A 家、baseUrl/apiKeyEnv 还是 B 家」的半切换。
 * 用户用户反馈「最新的 session 用配置过的 GLM 模型一直不行」根因链:
 * 面板只发 model(或 providerId 与模型不匹配)→ 运行时仍用旧 baseUrl/旧凭证 →
 * 智谱端点收到阿里云 Key → 401「令牌已过期或验证不正确」。本文件把这条链在服务端。
 */
import type { Config } from "./schema.js";

export type ProviderEntry = Config["providers"][number];
export type ModelApiType = "chat" | "responses" | "anthropic";

/** 参与路由解析的最小引用面(coding.llm / coding.models.<role> / 面板补丁同构)。 */
export interface ModelRouteRef {
  model?: string;
  providerId?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

export interface ResolvedModelRoute {
  model: string;
  providerId?: string;
  baseUrl?: string;
  apiKeyEnv: string;
  /** 与 owning provider 一致时才有值;baseUrl 被自定义覆盖时协议未知=undefined。 */
  apiType?: ModelApiType;
  /** true=模型不在任何 Provider 目录(手填/未验证);调用方应提示,但允许选择。 */
  unverified: boolean;
}

const DEFAULT_CODING_KEY = "GENIE_LLM_API_KEY";

function entryName(m: ProviderEntry["models"][number]): string {
  return typeof m === "string" ? m : m.name;
}

function providerHasModel(p: ProviderEntry, model: string): boolean {
  return p.models.some((m) => entryName(m) === model);
}

/**
 * 找到唯一拥有该模型的 Provider。精确匹配优先;仅当精确无命中时才做大小写不敏感匹配,
 * 且必须唯一(同一端点目录里 `glm-5.3` 与 `GLM-5.3` 并存时绝不猜)。
 */
export function findModelProvider(config: Config, model: string | undefined): ProviderEntry | undefined {
  const name = (model ?? "").trim();
  if (!name) return undefined;
  const exact = config.providers.filter((p) => providerHasModel(p, name));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const lower = name.toLowerCase();
  const ci = config.providers.filter((p) => p.models.some((m) => entryName(m).toLowerCase() === lower));
  return ci.length === 1 ? ci[0] : undefined;
}

/**
 * 解析 coding 轨一次完整选择。
 * 规则(按优先级):
 *  1. providerId 指向的 Provider 目录里**确实有**该模型 → 用它;
 *  2. 否则若另一个 Provider 唯一拥有该模型 → 用拥有者(服务端自愈「模型新、路由旧」);
 *  3. 都不命中 → 保留调用方显式给出的 baseUrl/apiKeyEnv(手填模型),标记 unverified。
 * baseUrl 陈旧识别:显式 baseUrl 恰好是**另一个 Provider** 的端点时视为陈旧,改用拥有者端点;
 * 不是任何 Provider 端点的 baseUrl 视为用户自定义覆盖(代理等),保留,且协议不再从 provider 继承。
 * apiKeyEnv 在非自定义覆盖时一律以 Provider 为准——这是「拿对钥匙」的机制保证。
 */
export function resolveCodingModelRoute(config: Config, ref: ModelRouteRef): ResolvedModelRoute {
  const model = (ref.model ?? "").trim();
  const byId = ref.providerId ? config.providers.find((p) => p.id === ref.providerId) : undefined;
  const byIdHas = byId ? providerHasModel(byId, model) : false;
  const owner = findModelProvider(config, model);
  // 显式选中的 Provider 目录里确实有该模型 → 尊重用户选择(同名模型可能在多家目录里);
  // 只有「显式 Provider 不提供该模型」时才用唯一拥有者自愈,避免模型新路由旧。
  const chosen = byId && byIdHas ? byId : (owner ?? byId);

  if (!chosen) {
    return {
      model,
      // 悬空 providerId(条目已删)不保留——让 reconcile 能清掉,避免下次继续按不存在的 Provider 解析。
      providerId: byId ? ref.providerId : undefined,
      baseUrl: ref.baseUrl,
      apiKeyEnv: ref.apiKeyEnv ?? DEFAULT_CODING_KEY,
      unverified: true,
    };
  }

  const providerBaseUrls = new Set(config.providers.map((p) => p.baseUrl).filter(Boolean));
  const explicitBase = ref.baseUrl?.trim() || undefined;
  const explicitKey = ref.apiKeyEnv?.trim() || undefined;
  const staleBase = explicitBase !== undefined && explicitBase !== chosen.baseUrl && providerBaseUrls.has(explicitBase);
  const baseUrl = explicitBase !== undefined && !staleBase ? explicitBase : chosen.baseUrl;
  const customOverride = baseUrl !== chosen.baseUrl;
  const apiKeyEnv = customOverride
    ? explicitKey ?? chosen.apiKeyEnv ?? DEFAULT_CODING_KEY
    : chosen.apiKeyEnv ?? explicitKey ?? DEFAULT_CODING_KEY;

  return {
    model,
    providerId: chosen.id,
    baseUrl,
    apiKeyEnv,
    ...(customOverride ? {} : chosen.apiType ? { apiType: chosen.apiType } : {}),
    unverified: !(byIdHas || owner),
  };
}
