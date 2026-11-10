/**
 * byModel 归集口径补齐:
 * ① 失败调用(llm.trace 带非空 error)也进 byModel:calls +1、token 全 0、不污染任何 ms/平均延迟字段;
 * ② 失败事件无 model 时**不建桶**(刻意不复用 message.agent 的 "?" 兜底,避免脏桶);
 * ③ 成功 llm.trace 仍不进 byModel(成功由 message.agent 计入,防重复);
 * ④ subagents[].model = 内层 message.agent 首值,后续换模型不覆盖。
 */
import { describe, it, expect } from "vitest";
import { deriveTraceStats } from "../src/agent/trace-stats";

const ev = (kind: string, payload: unknown, time?: number) => ({ kind, payload, ...(time !== undefined ? { time } : {}) });

describe("byModel:失败调用入账(无 token)", () => {
  it("带 error 的 llm.trace(model=m1)→ m1.calls=1、tokens 全 0;llmFailures/failedLlmMs 仍正确", () => {
    const s = deriveTraceStats([
      ev("llm.trace", { turn: 1, step: 1, model: "m1", ms: 1200, error: "fetch failed" }),
    ]);
    expect(s.llmFailures).toBe(1);
    expect(s.failedLlmMs).toBe(1200);
    expect(s.byModel).toHaveLength(1);
    expect(s.byModel[0]).toEqual({ model: "m1", calls: 1, input: 0, output: 0, total: 0, cached: 0, cacheWrite: 0 });
    // 失败耗时不得进任何 token/ms 口径
    expect(s.llmMs).toBe(0);
    expect(s.llmCalls).toBe(0);
    expect(s.tokens).toEqual({ input: 0, output: 0, total: 0, cached: 0 });
  });

  it("负面:带 error 但无 model → 不新增空桶/占位桶", () => {
    const s = deriveTraceStats([
      ev("llm.trace", { turn: 1, step: 1, ms: 800, error: "boom" }),
    ]);
    expect(s.llmFailures).toBe(1);
    expect(s.failedLlmMs).toBe(800);
    expect(s.byModel).toEqual([]); // 无 "?"/"unknown" 之类占位
  });

  it("负面:无 error 的 llm.trace 不进 byModel(成功由 message.agent 计)", () => {
    const s = deriveTraceStats([
      ev("llm.trace", { turn: 1, step: 1, model: "m1", ms: 500 }),
    ]);
    expect(s.llmFailures).toBe(0);
    expect(s.byModel).toEqual([]);
  });

  it("失败 + 成功同一模型:同一桶累加 calls=2,token 只来自成功那次", () => {
    const s = deriveTraceStats([
      ev("llm.trace", { turn: 1, step: 1, model: "m1", ms: 900, error: "fetch failed" }),
      ev("message.agent", { text: "ok", turn: 1, step: 2, llmMs: 100, model: "m1", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    ]);
    expect(s.llmFailures).toBe(1);
    expect(s.byModel).toHaveLength(1);
    expect(s.byModel[0]).toMatchObject({ model: "m1", calls: 2, input: 10, output: 5, total: 15 });
  });
});

describe("subagents[].model(首次出现的值)", () => {
  it("内层 message.agent 带 model → agents[0].model 等于该值", () => {
    const s = deriveTraceStats([
      ev("subagent.spawn", { agentId: "a1", taskId: "t1", title: "子任务" }, 100),
      ev("subagent.event", { agentId: "a1", kind: "message.agent", model: "sub-model", llmMs: 10, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }, 110),
    ]);
    expect(s.subagents.agents).toHaveLength(1);
    expect(s.subagents.agents[0]!.model).toBe("sub-model");
    expect(s.subagents.agents[0]!.calls).toBe(1);
  });

  it("负面:同一子代理后续换模型,仍是首次值", () => {
    const s = deriveTraceStats([
      ev("subagent.event", { agentId: "a1", kind: "message.agent", model: "first-model", llmMs: 10, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }, 110),
      ev("subagent.event", { agentId: "a1", kind: "message.agent", model: "second-model", llmMs: 10, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }, 120),
    ]);
    expect(s.subagents.agents[0]!.model).toBe("first-model");
    expect(s.subagents.agents[0]!.calls).toBe(2); // calls 累加逻辑未被改动
  });

  it("负面:内层无 model 时不留 model 字段", () => {
    const s = deriveTraceStats([
      ev("subagent.event", { agentId: "a1", kind: "message.agent", llmMs: 10, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }, 110),
    ]);
    expect("model" in s.subagents.agents[0]!).toBe(false);
  });
});
