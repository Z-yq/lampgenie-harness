/**
 * 前缀缓存命中率健康判定(设计稿 docs/design/02-context-economy.md §4.6; 落地)。
 * 定位:§4.6 的硬指标是「前缀缓存命中率 ≥98.5%」。此前代码里只有**度量**(usage.cachedTokens 落
 * journal、trace-stats 聚合、面板算 cacheHitRate),**没有阈值、没有判定、没有告警**——机制齐备、
 * 判定缺位。本模块只补判定这一层,不碰请求装配:输入是已经聚合好的 usage,输出是 verdict 与可读
 * 告警行;是否落 journal / 是否打日志由调用方决定(见 gateway computeTraceStats)。
 * 口径(§4.6.1):
 * - **provider 口径** `cachedTokens / inputTokens` 是判定主口径(与账单一致);
 * - **本地公共前缀口径** `estimatedCachedTokens / estimatedInputTokens` 是护栏,只随结果返回,
 * 不单独升降 verdict(它要求工具面逐字相同,跨 provider 不可比;断崖当次即可见,用于归因)。
 * 数据三档诚实边界:98.5% 是 用户拍板的**设计目标**,不是本仓经验证基线——现有 journal
 * 尚未做过达标采样,所以判定只回答「这一步测出来的数有没有达标」,不宣称「指标已达成」。
 * 纯函数:不读时钟、不写 journal、不改任何请求前缀(告警只读 trace 聚合值)。
 */

/** 设计目标(用户拍板):session 累计命中率 ≥98.5%。 */
export const PREFIX_CACHE_HIT_TARGET = 0.985;
/** 阻断级(<95% 说明前缀被系统性改写,§4.6.1 告警口径)。 */
export const PREFIX_CACHE_HIT_BLOCK = 0.95;
/** 最小样本:冷启动首调天然不命中(provider 缓存未建立),样本 <3 次不判定。 */
export const PREFIX_CACHE_MIN_CALLS = 3;
/** 阈值覆盖用的 env 键(缺省 0.985;非法值回落缺省,不抛错)。 */
export const PREFIX_CACHE_HIT_TARGET_ENV = "GENIE_PREFIX_CACHE_HIT_TARGET";

export type PrefixCacheVerdict = "ok" | "warn" | "block" | "insufficient";

export interface PrefixCacheSample {
 /** session 累计 LLM 调用次数。 */
  calls: number;
 /** provider 口径输入 token 合计(usage.inputTokens 求和)。 */
  inputTokens: number;
 /** provider 口径命中 token 合计(cache_read / prompt cache hit)。 */
  cachedTokens: number;
 /** 本地公共前缀口径输入 token 合计(llm.trace.estimatedInputTokens 求和;缺省=不判本地腿)。 */
  estimatedInputTokens?: number;
 /** 本地公共前缀口径命中 token 合计(estimatedCachedTokens 求和)。 */
  estimatedCachedTokens?: number;
}

export interface PrefixCacheHealth {
  verdict: PrefixCacheVerdict;
 /** provider 口径命中率;undefined=无可用样本(input=0 或 calls<minCalls)。 */
  hitRate?: number;
 /** 本地公共前缀口径命中率(有样本才出现)。 */
  localHitRate?: number;
  target: number;
  block: number;
  calls: number;
  inputTokens: number;
  cachedTokens: number;
 /** 人类可读判定依据(面板/日志/回执共用)。 */
  reason: string;
}

function defaultEnv(): Record<string, string | undefined> {
  try {
    return (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;
  } catch {
    return {};
  }
}

/** 命中率 = cached / input;input 非正数时 undefined(不造 0,0 会被误读成「全没命中」)。 */
export function cacheHitRateOf(cachedTokens: number, inputTokens: number): number | undefined {
  if (!Number.isFinite(cachedTokens) || !Number.isFinite(inputTokens) || inputTokens <= 0) return undefined;
  return cachedTokens / inputTokens;
}

/** 阈值解析顺序:显式参数 > env(GENIE_PREFIX_CACHE_HIT_TARGET) > 缺省 0.985。 */
export function prefixCacheTargetFromEnv(env: Record<string, string | undefined> = defaultEnv()): number {
  const raw = env[PREFIX_CACHE_HIT_TARGET_ENV];
  if (raw === undefined || raw.trim() === "") return PREFIX_CACHE_HIT_TARGET;
  const n = Number(raw.trim().replace(/%$/, ""));
 // 百分比写法(98.5)与小数写法(0.985)都收:1<n≤100 按百分数换算;其余越界值一律回落缺省。
  const norm = Number.isFinite(n) ? (n > 1 ? (n <= 100 ? n / 100 : NaN) : n) : NaN;
  return Number.isFinite(norm) && norm > 0 && norm <= 1 ? norm : PREFIX_CACHE_HIT_TARGET;
}

/**
 * 判定一次 session 累计样本。
 * verdict 只由 provider 口径决定(本地口径是护栏,仅随结果返回);样本不足一律 insufficient。
 */
export function judgePrefixCacheHealth(
  sample: PrefixCacheSample,
  opts: { target?: number; block?: number; minCalls?: number } = {},
): PrefixCacheHealth {
  const envTarget = opts.target ?? prefixCacheTargetFromEnv();
  const target = Number.isFinite(envTarget) && envTarget > 0 && envTarget <= 1 ? envTarget : PREFIX_CACHE_HIT_TARGET;
 // 阻断线不得高于目标(阈值被调低时不会出现「达标 yet block」的自相矛盾)。
  const rawBlock = opts.block ?? PREFIX_CACHE_HIT_BLOCK;
  const block = Number.isFinite(rawBlock) && rawBlock > 0 && rawBlock <= 1 ? Math.min(rawBlock, target) : Math.min(PREFIX_CACHE_HIT_BLOCK, target);
  const minCalls = Number.isFinite(opts.minCalls) ? Math.max(1, Math.floor(opts.minCalls as number)) : PREFIX_CACHE_MIN_CALLS;

  const calls = Number.isFinite(sample.calls) ? Math.max(0, Math.floor(sample.calls)) : 0;
  const inputTokens = Number.isFinite(sample.inputTokens) ? Math.max(0, sample.inputTokens) : 0;
  const cachedTokens = Number.isFinite(sample.cachedTokens) ? Math.max(0, sample.cachedTokens) : 0;
  const localHitRate =
    sample.estimatedInputTokens !== undefined && sample.estimatedCachedTokens !== undefined
      ? cacheHitRateOf(sample.estimatedCachedTokens, sample.estimatedInputTokens)
      : undefined;

  const base = { target, block, calls, inputTokens, cachedTokens, ...(localHitRate !== undefined ? { localHitRate } : {}) };
  const hitRate = cacheHitRateOf(cachedTokens, inputTokens);

  if (hitRate === undefined || calls < minCalls) {
    const why =
      inputTokens <= 0
        ? "provider 未上报输入 token(input=0)"
        : `样本不足(calls=${calls} < ${minCalls};冷启动首调天然不命中)`;
    return { ...base, verdict: "insufficient", reason: `${why},不作判定` };
  }

  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  if (hitRate >= target) {
    return { ...base, hitRate, verdict: "ok", reason: `命中率 ${pct(hitRate)} ≥ 目标 ${pct(target)}` };
  }
  if (hitRate < block) {
    return {
      ...base,
      hitRate,
      verdict: "block",
      reason: `命中率 ${pct(hitRate)} < 阻断线 ${pct(block)}(目标 ${pct(target)}):前缀被系统性改写`,
    };
  }
  return {
    ...base,
    hitRate,
    verdict: "warn",
    reason: `命中率 ${pct(hitRate)} < 目标 ${pct(target)}(≥阻断线 ${pct(block)})`,
  };
}

/** 一行可读结论(日志/面板/回执共用;不含任何写副作用)。 */
export function prefixCacheHealthLineOf(h: PrefixCacheHealth): string {
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  if (h.verdict === "insufficient") return `[前缀缓存] 未判定:${h.reason}`;
  const local = h.localHitRate !== undefined ? `,本地公共前缀口径 ${pct(h.localHitRate)}` : "";
  return `[前缀缓存] ${h.verdict.toUpperCase()}:命中率 ${pct(h.hitRate ?? 0)} = cached ${h.cachedTokens} / input ${h.inputTokens}(${h.calls} 次调用)${local};目标 ${pct(h.target)}${h.verdict === "block" ? `,阻断线 ${pct(h.block)}` : ""}`;
}