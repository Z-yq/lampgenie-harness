import { describe, expect, it } from "vitest";
import { confirmDowngrade, resetModelScoringCache } from "../src/agent/model-scoring.js";

const okJevBody = (keep: string, conf: number) => ({
  result_x1: { label: keep, confidence: conf, probabilities: { true: keep === "true" ? 0.97 : 0.03 } },
});

describe("jev-150m 降级确认器(缺口#28)", () => {
  it("off 模式直接 undefined(不联网)", async () => {
    const r = await confirmDowngrade(undefined, { id: "x1", role: "tool", preview: "abc" }, "goal");
    expect(r).toBeUndefined();
  });
  it("shadow 语义:高置信 keep → keepResult=true;结论不改消息(函数零副作用)", async () => {
    resetModelScoringCache();
    const cfg = {
      mode: "shadow" as const,
      providerUrl: "http://127.0.0.1:8105",
      fetchImpl: (async () => new Response(JSON.stringify(okJevBody("true", 0.95)), { status: 200 })) as typeof fetch,
    };
    const r = await confirmDowngrade(cfg, { id: "x1", role: "assistant", preview: "正在重构 loop" }, "goal");
    expect(r?.keepResult).toBe(true);
  });
  it("低置信/报错 → undefined(fail-soft 回落结构信号)", async () => {
    resetModelScoringCache();
    const cfg = {
      mode: "shadow" as const,
      providerUrl: "http://127.0.0.1:8105",
      fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch,
    };
    const r = await confirmDowngrade(cfg, { id: "x1", role: "user", preview: "继续" }, "goal");
    expect(r?.keepResult).toBeUndefined();
    expect(r?.error).toBeTruthy();
  });
});
