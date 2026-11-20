/**
 * 前缀缓存命中率判定(设计稿 §4.6 硬指标闭环。
 * 口径:provider 口径 cached/input;98.5% 是设计目标(非经验证基线)。
 */
import { describe, it, expect } from "vitest";
import {
  PREFIX_CACHE_HIT_BLOCK,
  PREFIX_CACHE_HIT_TARGET,
  cacheHitRateOf,
  judgePrefixCacheHealth,
  prefixCacheHealthLineOf,
  prefixCacheTargetFromEnv,
} from "../src/agent/prefix-cache-health";

describe("prefix-cache-health:阈值与口径", () => {
  it("缺省目标 98.5% / 阻断线 95%,且为代码常量", () => {
    expect(PREFIX_CACHE_HIT_TARGET).toBe(0.985);
    expect(PREFIX_CACHE_HIT_BLOCK).toBe(0.95);
    expect(prefixCacheTargetFromEnv({})).toBe(0.985);
  });

  it("env 覆盖:小数与百分数两种写法都收,非法值回落缺省", () => {
    expect(prefixCacheTargetFromEnv({ GENIE_PREFIX_CACHE_HIT_TARGET: "0.99" })).toBe(0.99);
    expect(prefixCacheTargetFromEnv({ GENIE_PREFIX_CACHE_HIT_TARGET: "99.5" })).toBe(0.995);
    expect(prefixCacheTargetFromEnv({ GENIE_PREFIX_CACHE_HIT_TARGET: "99.5%" })).toBe(0.995);
    expect(prefixCacheTargetFromEnv({ GENIE_PREFIX_CACHE_HIT_TARGET: "abc" })).toBe(0.985);
    expect(prefixCacheTargetFromEnv({ GENIE_PREFIX_CACHE_HIT_TARGET: "0" })).toBe(0.985);
 // "2" 按百分数解释=2%(合法但荒谬,交给使用者), "200" 越界回落缺省。
    expect(prefixCacheTargetFromEnv({ GENIE_PREFIX_CACHE_HIT_TARGET: "2" })).toBe(0.02);
    expect(prefixCacheTargetFromEnv({ GENIE_PREFIX_CACHE_HIT_TARGET: "200" })).toBe(0.985);
  });

  it("cacheHitRateOf:input=0 返回 undefined(不造 0,避免被读成『全未命中』)", () => {
    expect(cacheHitRateOf(0, 0)).toBeUndefined();
    expect(cacheHitRateOf(5, -1)).toBeUndefined();
    expect(cacheHitRateOf(985, 1000)).toBeCloseTo(0.985, 6);
  });
});

describe("prefix-cache-health:判定", () => {
  it("≥98.5% → ok(达标边界逐字命中)", () => {
    const h = judgePrefixCacheHealth({ calls: 10, inputTokens: 1000, cachedTokens: 985 });
    expect(h.verdict).toBe("ok");
    expect(h.hitRate).toBeCloseTo(0.985, 6);
    expect(prefixCacheHealthLineOf(h)).toContain("OK");
  });

  it("97%(低于目标、高于阻断线)→ warn", () => {
    const h = judgePrefixCacheHealth({ calls: 10, inputTokens: 1000, cachedTokens: 970 });
    expect(h.verdict).toBe("warn");
    expect(h.reason).toContain("97.00%");
  });

  it("94%(低于阻断线)→ block", () => {
    const h = judgePrefixCacheHealth({ calls: 10, inputTokens: 1000, cachedTokens: 940 });
    expect(h.verdict).toBe("block");
    expect(h.reason).toContain("95.00%");
  });

  it("样本不足(calls<3 或 input=0)→ insufficient,不做达标判定", () => {
    expect(judgePrefixCacheHealth({ calls: 2, inputTokens: 1000, cachedTokens: 1000 }).verdict).toBe("insufficient");
    expect(judgePrefixCacheHealth({ calls: 9, inputTokens: 0, cachedTokens: 0 }).verdict).toBe("insufficient");
  });

  it("阈值可配:target=0.99 时 0.985 判 warn;阻断线随目标下调不会自相矛盾", () => {
    expect(judgePrefixCacheHealth({ calls: 10, inputTokens: 1000, cachedTokens: 985 }, { target: 0.99 }).verdict).toBe("warn");
    const low = judgePrefixCacheHealth({ calls: 10, inputTokens: 1000, cachedTokens: 985 }, { target: 0.9 });
    expect(low.verdict).toBe("ok");
    expect(low.block).toBeLessThanOrEqual(low.target);
  });

  it("本地公共前缀口径作为护栏随结果返回,不单独升降 verdict", () => {
    const h = judgePrefixCacheHealth({
      calls: 10, inputTokens: 1000, cachedTokens: 990,
      estimatedInputTokens: 5000, estimatedCachedTokens: 2500,
    });
    expect(h.verdict).toBe("ok"); // provider 口径达标
    expect(h.localHitRate).toBeCloseTo(0.5); // 护栏塌陷如实暴露
    expect(prefixCacheHealthLineOf(h)).toContain("本地公共前缀口径 50.00%");
  });

  it("纯函数:同一输入重复判定结果稳定(不读时钟/不写副作用)", () => {
    const s = { calls: 5, inputTokens: 2000, cachedTokens: 1900 };
    expect(judgePrefixCacheHealth(s)).toEqual(judgePrefixCacheHealth(s));
  });
});