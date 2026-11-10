/**
 * models.list 错误分类(2026-10-25 step-1002E:自 host 模型目录错误码可操作化)。
 *
 * 旧行为:main.ts 的 listModels 抛 `new Error("端点未配置"/"凭证不可解析"/"模型列表失败…")`,
 * server.ts 一律回 `models-list-failed` —— 面板只能显示「模型列表拉取失败」,用户不知道是
 * 没配 Provider、缺 Key、还是上游 401。这里把失败面拆成可编程错误码(protocol ErrorCode),
 * message 保持人话+下一步动作;成功路径与旧回包完全不变。
 *
 * 分派口径:
 *   models-not-implemented  → 网关装配里没有 listModels(生产入口 main.ts 才有;测试壳)
 *   models-no-provider      → providerId 未知 / 一个 Provider 都没配
 *   models-not-configured   → Provider 存在但 coding 轨端点 baseUrl 为空
 *   models-no-credential    → 端点/Key 引用解析不到凭证(secrets/env 都没有)
 *   models-upstream-failed  → 请求超时/不可达/HTTP 非 2xx/响应不是 JSON
 *   models-list-failed      → 兜底(未预期异常,保持旧码不炸老调用点)
 */
import { ErrorCode } from "@lampgenie/protocol";

/** 带 protocol 错误码的模型目录异常;server.ts 用 modelsErrorOf 原样映射到 error 帧。 */
export class ModelsListError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ModelsListError";
    this.code = code;
  }
}

/** providerId 指定但配置里找不到。 */
export function modelsUnknownProvider(providerId: string): ModelsListError {
  return new ModelsListError(
    ErrorCode.ModelsNoProvider,
    `未知 provider「${providerId}」:设置页刷新供应商列表,或先「+ 添加供应商」再拉取`,
  );
}

/** 端点缺失:一个 Provider 都没有 vs 有 Provider 但 coding 轨没端点。 */
export function modelsEndpointMissing(input: { providerCount: number; providerId?: string }): ModelsListError {
  if (input.providerCount === 0) {
    return new ModelsListError(
      ErrorCode.ModelsNoProvider,
      "还没有任何模型供应商:到设置页「+ 添加供应商」填接口地址与 API Key,或配置 coding.llm.baseUrl",
    );
  }
  const scope = input.providerId ? `Provider「${input.providerId}」` : "coding 轨";
  return new ModelsListError(
    ErrorCode.ModelsNotConfigured,
    `${scope}端点未配置:在设置页填写 baseUrl(如 https://open.bigmodel.cn/api/anthropic),保存后重试`,
  );
}

/** 凭证解析失败(apiKeyEnv 可能为空 → 按 GENIE_LLM_API_KEY 兜底展示)。 */
export function modelsCredentialMissing(apiKeyEnv?: string): ModelsListError {
  const name = apiKeyEnv || "GENIE_LLM_API_KEY";
  return new ModelsListError(
    ErrorCode.ModelsNoCredential,
    `凭证不可解析:「${name}」在进程环境与 .genie/secrets.json 里都没有值;到设置页填 API Key(只写 secrets)后重试`,
  );
}

/** 上游失败(HTTP 非 2xx / 网络错误 / 超时 / 非 JSON)。detail 只放脱敏摘要(不含 apiKey)。 */
export function modelsUpstreamFailure(input: { baseUrl: string; detail: string }): ModelsListError {
  return new ModelsListError(
    ErrorCode.ModelsUpstreamFailed,
    `模型列表拉取失败:端点 ${input.baseUrl} ${input.detail}`,
  );
}

/** 任意异常 → 可下发 error 帧的 { code, message };未分类异常保持 models-list-failed 旧码。 */
export function modelsErrorOf(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof ModelsListError) {
    return { code: err.code, message: err.message.slice(0, 240) };
  }
  return { code: ErrorCode.ModelsListFailed, message: String(err).slice(0, 200) };
}
