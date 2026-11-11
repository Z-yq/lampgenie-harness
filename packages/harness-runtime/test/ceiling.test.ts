/**
 * ceiling.ts()单测:CPU 天花板推导、run 界钳制、双界取 min 的唯一口径。
 */
import { describe, it, expect } from "vitest";
import {
  clampRunConcurrency,
  deriveWorkflowConcurrencyCeiling,
  doubleBoundConcurrency,
} from "../src/concurrency/ceiling";

describe("deriveWorkflowConcurrencyCeiling", () => {
  it("可用并行度减 2,且不超过硬顶 16", () => {
    expect(deriveWorkflowConcurrencyCeiling(() => 16)).toBe(14);
    expect(deriveWorkflowConcurrencyCeiling(() => 18)).toBe(16);
    expect(deriveWorkflowConcurrencyCeiling(() => 128)).toBe(16);
  });

  it("双核机(parallelism-2=0)地板为 1", () => {
    expect(deriveWorkflowConcurrencyCeiling(() => 2)).toBe(1);
    expect(deriveWorkflowConcurrencyCeiling(() => 1)).toBe(1);
  });
});

describe("clampRunConcurrency(run 界)", () => {
  it("缺席/非有限读作不限制 = 天花板", () => {
    expect(clampRunConcurrency(undefined, 14)).toBe(14);
    expect(clampRunConcurrency(Number.NaN, 14)).toBe(14);
    expect(clampRunConcurrency(Number.POSITIVE_INFINITY, 14)).toBe(14);
  });

  it("超天花板取天花板,非整数向下取整,最小 1", () => {
    expect(clampRunConcurrency(32, 14)).toBe(14);
    expect(clampRunConcurrency(4, 14)).toBe(4);
    expect(clampRunConcurrency(3.7, 14)).toBe(3);
    expect(clampRunConcurrency(0, 14)).toBe(1);
    expect(clampRunConcurrency(-5, 14)).toBe(1);
  });
});

describe("doubleBoundConcurrency(双界取 min)", () => {
  it("探针 D:两界取 min", () => {
    expect(doubleBoundConcurrency({ providerCap: 4, runCap: 32 })).toBe(4);
    expect(doubleBoundConcurrency({ providerCap: 32, runCap: 4 })).toBe(4);
    expect(doubleBoundConcurrency({ providerCap: 6, runCap: 6 })).toBe(6);
  });

  it("天花板参与取 min(caps=32 + ceiling=16 → 16)", () => {
    expect(doubleBoundConcurrency({ providerCap: 64, runCap: 32, ceiling: 16 })).toBe(16);
    expect(doubleBoundConcurrency({ runCap: 32, ceiling: 14 })).toBe(14);
    expect(doubleBoundConcurrency({ providerCap: 4, runCap: 32, ceiling: 16 })).toBe(4);
  });

  it("缺省/非有限一界视作无界,不参与取 min", () => {
    expect(doubleBoundConcurrency({ runCap: 5 })).toBe(5);
    expect(doubleBoundConcurrency({ providerCap: 5 })).toBe(5);
    expect(doubleBoundConcurrency({ providerCap: Number.NaN, runCap: 7, ceiling: 16 })).toBe(7);
    expect(doubleBoundConcurrency({ providerCap: Number.POSITIVE_INFINITY, runCap: 7 })).toBe(7);
    expect(doubleBoundConcurrency({ providerCap: Number.NEGATIVE_INFINITY, runCap: 7 })).toBe(7);
  });

  it("全无界 → ceiling,ceiling 也无界 → 1", () => {
    expect(doubleBoundConcurrency({ ceiling: 16 })).toBe(16);
    expect(doubleBoundConcurrency({})).toBe(1);
    expect(doubleBoundConcurrency({ providerCap: Number.NaN, runCap: Number.NaN, ceiling: Number.NaN })).toBe(1);
  });

  it("非整数向下取整,结果至少 1", () => {
    expect(doubleBoundConcurrency({ providerCap: 3.9, runCap: 32 })).toBe(3);
    expect(doubleBoundConcurrency({ providerCap: 0.5 })).toBe(1);
    expect(doubleBoundConcurrency({ providerCap: 0, runCap: 4 })).toBe(1);
  });

  it("确定性:同一输入重复调用结果一致", () => {
    const input = { providerCap: 7.7, runCap: 32, ceiling: 14 };
    const first = doubleBoundConcurrency(input);
    for (let i = 0; i < 5; i++) expect(doubleBoundConcurrency(input)).toBe(first);
    expect(first).toBe(7);
  });
});
