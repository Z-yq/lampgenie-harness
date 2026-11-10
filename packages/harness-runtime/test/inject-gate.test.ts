/**
 * 注入闸(J1,2026-11 token 轮):ephemeral 注入的 ≥10k token 间隔契约。
 * 硬规则=相同提示词同 key 两次注入间隔 ≥10k token(按 usage 累计,不是步数)。
 */
import { describe, it, expect } from "vitest";
import { createInjectGate, INJECT_INTERVAL_TOKENS } from "../src/agent/inject-gate";

describe("createInjectGate", () => {
  it("默认间隔 10k:9_999 拒", () => {
    const gate = createInjectGate();
    expect(INJECT_INTERVAL_TOKENS).toBe(10_000);
    expect(gate.check("k", 0)).toBe(true); // 无记录→放行并记水位
    expect(gate.check("k", 9_999)).toBe(false); // 差 1 token 也算不够
    expect(gate.lastTokens("k")).toBe(0); // 被拒不改水位
  });

  it("10_000 放行并抬水位", () => {
    const gate = createInjectGate();
    gate.check("k", 1_000);
    expect(gate.check("k", 11_000)).toBe(true);
    expect(gate.lastTokens("k")).toBe(11_000);
    expect(gate.check("k", 20_999)).toBe(false);
  });

  it("不同 key 互不影响", () => {
    const gate = createInjectGate();
    gate.check("a", 0);
    expect(gate.check("a", 1_000)).toBe(false);
    expect(gate.check("b", 1_000)).toBe(true); // b 无记录
    expect(gate.lastTokens("a")).toBe(0);
    expect(gate.lastTokens("b")).toBe(1_000);
  });

  it("reset 后全部放行", () => {
    const gate = createInjectGate();
    gate.check("k", 0);
    expect(gate.check("k", 100)).toBe(false);
    gate.reset();
    expect(gate.lastTokens("k")).toBeUndefined();
    expect(gate.check("k", 100)).toBe(true);
  });

  it("自定义 minTokens 生效(逐次覆盖 + 构造默认)", () => {
    const gate = createInjectGate(5_000);
    gate.check("k", 0);
    expect(gate.check("k", 4_999)).toBe(false);
    expect(gate.check("k", 5_000)).toBe(true);
    // 单次调用覆盖默认值(装配方可按提示词类别定不同节奏)
    expect(gate.check("k", 6_000, 1_000)).toBe(true);
    expect(gate.check("k", 6_500, 1_000)).toBe(false);
  });

  it("水位回退=新一轮计数 → 放行并重置该 key", () => {
    const gate = createInjectGate();
    gate.check("k", 50_000);
    expect(gate.check("k", 51_000)).toBe(false);
    expect(gate.check("k", 0)).toBe(true); // runTurn 起点 tokensSpent 清零
    expect(gate.lastTokens("k")).toBe(0);
    expect(gate.check("k", 9_000)).toBe(false);
  });

  it("无计量(水位未前进,如 provider 不回 usage) → fail-open 放行,防永久断供", () => {
    const gate = createInjectGate();
    expect(gate.check("k", 0)).toBe(true);
    expect(gate.check("k", 0)).toBe(true); // 计数器一步未动＝无法计量间隔,不许拦死到达性
    expect(gate.check("k", 0)).toBe(true);
    expect(gate.check("k", 3_000)).toBe(false); // 一旦有真实增量,间隔规则照常生效
  });
});
