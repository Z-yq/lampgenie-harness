/**
 * 主轨模型热切的唯一解析件(2026-10-20「最新 session 用 GLM 一直不行」根因收口)。
 *
 * 设计对齐 ZCode 的 Provider Registry:
 *   - 选择 = (providerId, modelId) 对;端点/协议/凭证由拥有该模型的 Provider 派生;
 *   - 切换前先做选择校验(模型目录/凭证可解析),不把半成品写进运行时;
 *   - 解析结果(实际生效的 model/provider/apiType/凭证来源)回给面板,不再用「热生效」空话。
 *
 * 本文件只做纯计算(不写盘、不打网络),main.handleCfgSet 负责持久化与审计;单测直接覆盖。
 */
import {
  modelMetaOf,
  resolveCodingModelRoute,
  resolveTrackApiKeySource,
  type ApiKeySource,
  type Config,
  type ModelApiType,
  type ResolvedModelRoute,
} from "@lampgenie/core";
import { EFFORT_LEVELS, resolveImplementationEffort, resolveRoleEffort } from "./effort-policy.js";
import { resolveRequestMaxTokens } from "./request-budget.js";

/**
 * 会话级 effort 覆盖的合法性判定(m7):取值域 = effort-policy 的 EFFORT_LEVELS;
 * ""=显式关(请求不带 reasoning_effort)。返回 undefined=合法(无提示),否则=可操作错误文案。
 * 校验放在 model-switch(模型切换唯一解析件)而非 api 层,便于其它入口复用同一口径。
 */
export function validateEffortOverride(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined; // 未提供/清除=合法
  if (value === "") return undefined; // 显式关
  if ((EFFORT_LEVELS as readonly string[]).includes(value)) return undefined;
  return `effort 取值非法:「${value}」不在允许范围(${EFFORT_LEVELS.join("/")};空串=显式关闭)——未写入覆盖`;
}

/** 面板可展示的「实际生效选择」(绝不含密钥值)。 */
export interface EffectiveModel {
  model: string;
  providerId?: string;
  baseUrl: string;
  apiKeyEnv: string;
  apiType: ModelApiType;
  /** 凭证实际来源:env/secrets/legacy-*(旧 GENIE_LLM_API_KEY 兜底)。 */
  credentialSource: ApiKeySource;
  /** 模型不在任何 Provider 目录(手填/未验证)。 */
  unverified: boolean;
}

export interface ModelSwitchResolution {
  /** 喂给 provider.update 的具体值(含 apiKey;绝不落日志/审计)。 */
  hotLlm?: Record<string, unknown>;
  effective?: EffectiveModel;
  /** 因「选择即 Registry」而回写到 coding.llm 的路由路径(供 applied/needsRestart 归位)。 */
  reconciled: string[];
  /** 非致命提示(未验证模型 / max_tokens 超默认)。 */
  warning?: string;
  /** 凭据不可解析等硬错误;此时不得热切(运行时保持旧 provider),面板必须 fail-visible。 */
  routeError?: string;
}

/**
 * 把 coding.llm 的路由字段校正到「拥有该模型的 Provider」。
 *
 * 只回写 route 能确定的字段;自定义 baseUrl(不属于任何 Provider 端点)保留,不强行抹掉代理配置。
 * 返回被改动的点路径,调用方据此把路由键归入热应用(provider.update 本次会带上它们)。
 */
export function reconcileCodingRoute(config: Config): { changed: string[]; route: ResolvedModelRoute } {
  const ref = config.coding.llm;
  const route = resolveCodingModelRoute(config, ref);
  const changed: string[] = [];
  if (route.providerId !== ref.providerId) {
    if (route.providerId !== undefined) {
      ref.providerId = route.providerId;
      changed.push("coding.llm.providerId");
    } else if (ref.providerId && !config.providers.some((p) => p.id === ref.providerId)) {
      // provider 已被删除:清掉悬空引用,让 baseUrl 语义回到轨内直配。
      delete (ref as { providerId?: string }).providerId;
      changed.push("coding.llm.providerId");
    }
  }
  if (route.baseUrl !== undefined && route.baseUrl !== ref.baseUrl) {
    ref.baseUrl = route.baseUrl;
    changed.push("coding.llm.baseUrl");
  }
  if (route.apiKeyEnv !== ref.apiKeyEnv) {
    ref.apiKeyEnv = route.apiKeyEnv;
    changed.push("coding.llm.apiKeyEnv");
  }
  return { changed, route };
}

export type RoleName = "compact" | "review" | "subagent" | "digest" | "voice";
// voice=语音任务书(2026-11-08):无 provider 实例(server 每次 voice.draft 现读 live config),
// 但路由归属/reconcile 语义与其它角色同源,进同一张 RoleName 表。

export interface RoleSwitchResolution {
  role: RoleName;
  /** 喂给角色 provider.update 的完整参数(含 apiKey;绝不回传面板)。 */
  hot?: Record<string, unknown>;
  effective?: EffectiveModel;
  reconciled: string[];
  warning?: string;
  routeError?: string;
}

/** 角色选择同样按 Registry 解析:role 只配 model 时,端点/协议/凭证跟随模型拥有者。 */
export function reconcileRoleRoute(config: Config, role: RoleName): { changed: string[]; route: ResolvedModelRoute } | undefined {
  const ref = config.coding.models[role];
  if (!ref?.model) return undefined;
  const merged = { ...config.coding.llm, ...ref, model: ref.model };
  const route = resolveCodingModelRoute(config, merged);
  const changed: string[] = [];
  // 未显式配路由、且模型不在任何目录(手填)→ 保持「继承主轨」语义,不把当前主轨 route 钉死;
  // 否则以后主 Provider 切换时该角色会停在旧端点上。已验证的模型才落 owner 路由。
  const explicitRoute = Boolean(ref.providerId || ref.baseUrl || ref.apiKeyEnv);
  if (!explicitRoute && route.unverified) return { changed, route };
  const prefix = `coding.models.${role}`;
  if (route.providerId !== ref.providerId && route.providerId !== undefined) {
    ref.providerId = route.providerId;
    changed.push(prefix + ".providerId");
  }
  if (route.baseUrl !== undefined && route.baseUrl !== ref.baseUrl) {
    ref.baseUrl = route.baseUrl;
    changed.push(prefix + ".baseUrl");
  }
  if (route.apiKeyEnv !== ref.apiKeyEnv) {
    ref.apiKeyEnv = route.apiKeyEnv;
    changed.push(prefix + ".apiKeyEnv");
  }
  return { changed, route };
}

/** 解析角色热切参数;未配置 model 的角色(compact)=undefined。 */
export function resolveRoleSwitch(
  config: Config,
  repoRoot: string,
  role: RoleName,
  env: NodeJS.ProcessEnv = process.env,
): RoleSwitchResolution | undefined {
  const ref = config.coding.models[role];
  if (!ref?.model) return undefined;
  const merged = { ...config.coding.llm, ...ref, model: ref.model };
  const route = resolveCodingModelRoute(config, merged);
  if (!route.baseUrl) return { role, reconciled: [], routeError: `${role}:端点未配置` };
  const key = resolveTrackApiKeySource("coding", route.apiKeyEnv, { repoRoot, env });
  const effective: EffectiveModel = {
    model: route.model,
    ...(route.providerId ? { providerId: route.providerId } : {}),
    baseUrl: route.baseUrl,
    apiKeyEnv: route.apiKeyEnv,
    apiType: route.apiType ?? "chat",
    credentialSource: key.source,
    unverified: route.unverified,
  };
  if (!key.key) {
    return { role, reconciled: [], effective, routeError: `${role}:凭证不可解析(${route.apiKeyEnv})` };
  }
  const meta = modelMetaOf(config, route.model);
  const budget = resolveRequestMaxTokens(ref.maxTokens, meta?.maxTokens);
  const effort = resolveRoleEffort(ref.reasoningEffort);
  return {
    role,
    hot: {
      model: route.model,
      baseUrl: route.baseUrl,
      apiKey: key.key,
      apiType: effective.apiType,
      maxTokens: budget.value,
      reasoningEffort: effort ?? "",
      ...(typeof merged.timeoutMs === "number" ? { timeoutMs: merged.timeoutMs } : {}),
    },
    effective,
    reconciled: [],
    ...(budget.warning ? { warning: budget.warning } : {}),
    ...(route.unverified ? { warning: (budget.warning ? budget.warning + ";" : "") + `${role}:模型「${route.model}」不在任何 Provider 目录` } : {}),
  };
}

/** 解析本次热切要喂给 provider.update 的完整参数;凭证不可解析=routeError(不热切)。 */
export function resolveModelSwitch(
  config: Config,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelSwitchResolution {
  const ref = config.coding.llm;
  const route = resolveCodingModelRoute(config, ref);
  if (!ref.model) return { reconciled: [], routeError: "未配置模型(coding.llm.model 为空)" };
  if (!route.baseUrl) return { reconciled: [], routeError: "端点未配置(providerId/baseUrl 均无法解析)" };

  const key = resolveTrackApiKeySource("coding", route.apiKeyEnv, { repoRoot, env });
  const effective: EffectiveModel = {
    model: route.model,
    ...(route.providerId ? { providerId: route.providerId } : {}),
    baseUrl: route.baseUrl,
    apiKeyEnv: route.apiKeyEnv,
    apiType: route.apiType ?? "chat",
    credentialSource: key.source,
    unverified: route.unverified,
  };
  if (!key.key) {
    return {
      reconciled: [],
      effective,
      routeError: `凭证不可解析(${route.apiKeyEnv} 不在 env / .genie/secrets.json)——已写入配置,但运行时不会切到该端点`,
    };
  }

  const meta = modelMetaOf(config, route.model);
  const budget = resolveRequestMaxTokens(ref.maxTokens, meta?.maxTokens);
  const effort = resolveImplementationEffort((ref as { implementationEffort?: string }).implementationEffort);
  const warnings: string[] = [];
  if (budget.warning) warnings.push(budget.warning);
  if (route.unverified) warnings.push(`模型「${route.model}」不在任何 Provider 目录(手填/未验证),选它可能 404 model_not_found`);

  return {
    hotLlm: {
      model: route.model,
      baseUrl: route.baseUrl,
      apiKey: key.key,
      // 协议随端点走:anthropic/responses/chat;provider.update 只认非 undefined。
      apiType: effective.apiType,
      maxTokens: budget.value,
      // 主轨 effort 恒携带(implementationEffort 缺省 high;""=显式关 → update 归 undefined)。
      reasoningEffort: effort ?? "",
      ...(typeof ref.timeoutMs === "number" ? { timeoutMs: ref.timeoutMs } : {}),
    },
    effective,
    reconciled: [],
    ...(warnings.length ? { warning: warnings.join(";") } : {}),
  };
}
