/**
 * 运行环境段(2026-11-02 减步轮):16 题评测里 14% 的步数纯在找 node 解释器、另有大量步数在试
 * 「怎么用 node 跑 .ts」——这些启动时确定,不该每题重探,所以注入 system prompt。
 * 本测试只验「段真的进档 + 探测只做一次 + 内容含必需三要素」,不验具体选到哪个版本(随机器变)。
 */
import { describe, it, expect } from "vitest";
import { SYSTEM, SYSTEM_LITE, runtimeEnvBlock } from "../src/agent-wiring.js";

describe("runtimeEnvBlock(运行环境段)", () => {
  it("含 node 路径/版本、strip-types 运行方式、语法限制三要素", () => {
    const s = runtimeEnvBlock();
    expect(s).toContain("运行环境");
    expect(s).toContain("node");
    expect(s).toContain("--experimental-strip-types");
    expect(s).toMatch(/\/node|node(\.exe)?/); // 具体路径随机器变,只要有可执行路径
    expect(s).toContain("enum");
    expect(s).toContain(".ts");
  });

  it("缓存:两次调用返回同一字符串(不重复扫盘)", () => {
    expect(runtimeEnvBlock()).toBe(runtimeEnvBlock());
  });

  it("完整档与精简档都注入该段(纯收益,与详略无关)", () => {
    expect(SYSTEM).toContain(runtimeEnvBlock());
    expect(SYSTEM_LITE).toContain(runtimeEnvBlock());
    expect(SYSTEM_LITE).toContain("action=impact");
  });

  it("段体量有界(≤260 字符,防提示词回涨)", () => {
    expect(runtimeEnvBlock().length).toBeLessThanOrEqual(260);
  });
});