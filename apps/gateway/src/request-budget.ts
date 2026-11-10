/**
 * 请求输出上限(step-139 O4,口径对齐 ZCode):
 * ZCode 的口径是「正常请求输出默认 32K」——autoCompact 的 outputReserve(min(maxOutputTokens ?? 32000, 21000))
 * 只有在这个前提成立时才是同一把尺。此前本仓 provider 的 max_tokens 直接吃 model meta(实测 384000),
 * 输出预留却按 21k 封顶 → 请求预算与压缩窗口按两套常量计算(step-137 轨迹:峰值 133k 不压缩)。
 *
 * 规则:
 *  ① model meta 里的 maxTokens 只当**上限**,不得抬高默认值 → 默认 = min(meta ?? 32000, 32000);
 *  ② config 显式设置(轨级/角色级 maxTokens)才覆盖(保留用户值,即使 >32000);
 *  ③ 显式值 > 32000 时打一条可见 warning(reserve 仍按 21000 封顶,输入预算可能逼近窗口);
 *  ④ 显式值 > 当前模型 meta 上限时**钳制到 meta**(2026-10-21 实锤:面板切模型把 deepseek 的
 *     maxTokens=384000 写进轨级配置,pill 快切只改 model 不清轨级值 → GLM-5.3 端点(上限 131072)
 *     每次请求 400 [1210] max_tokens 参数非法。模型上限是服务端硬约束,不归用户显式值管)。
 */
export const DEFAULT_REQUEST_MAX_TOKENS = 32_000;

export interface RequestMaxTokensResult {
  value: number;
  /** 显式值超过默认 32k / 被模型上限钳制的提示(调用方打到日志/面板;非错误)。 */
  warning?: string;
}

/** 解析本次请求的 max_tokens。explicit=config 显式值(轨级或角色级);meta=model 条目元数据。 */
export function resolveRequestMaxTokens(explicit: number | undefined, meta: number | undefined): RequestMaxTokensResult {
  const pos = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
  const ex = pos(explicit);
  const m = pos(meta);
  if (ex !== undefined) {
    // ④ 模型上限钳制优先于「显式值保留」:残留/跨模型复制的显式值不得打穿端点硬上限。
    if (m !== undefined && ex > m) {
      return {
        value: m,
        warning: `请求 max_tokens=${ex} 超过当前模型上限 ${m},已钳制到 ${m}(轨级残留值防护;可在配置中把 maxTokens 调至 ≤${m} 消除本提示)`,
      };
    }
    return ex > DEFAULT_REQUEST_MAX_TOKENS
      ? {
        value: ex,
        warning: `请求 max_tokens=${ex} 超过默认 ${DEFAULT_REQUEST_MAX_TOKENS}(ZCode 口径的自动压缩预留按 min(maxOutputTokens,21000) 封顶)——输入预算可能逼近上下文窗口,压缩会偏晚`,
      }
      : { value: ex };
  }
  return { value: Math.min(m ?? DEFAULT_REQUEST_MAX_TOKENS, DEFAULT_REQUEST_MAX_TOKENS) };
}