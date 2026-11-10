/**
 * 模型名 t0 快照:
 * provider.modelName 是 getter,每次读返回**当前**值(openai-provider.ts:424,update() 热切换在 :435-447)。
 * 旧实现只在 chat() 返回**之后**才读 provider → 调用途中发生热切换(cfg.set llm.model / per-session
 * override 触发 update())时,记下的是「切换后的新模型」,不是本次请求实际用的模型 → journal 假数据。
 * 本测试用具名 getter + chat() 内部改字段来复现该竞态。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, type LlmCallTrace } from "../src/agent/loop";

/** 可变字段 + getter 形态的 provider(模拟 openai-provider 的 modelName getter)。 */
function switchingLlm(opts: { initial: string; during: string; throwInChat?: boolean }) {
  const state = { model: opts.initial };
  return {
    state,
    get modelName() { return state.model; },
    async chat() {
      // 模拟「调用途中热切换」:chat 未返回时模型已被 update() 改掉。
      state.model = opts.during;
      if (opts.throwInChat) throw new Error("fetch failed");
      return { content: "ok" };
    },
  };
}

describe("模型名快照:T1(调用途中热切换不污染 journal)", () => {
  it("message.agent.payload.model 是 t0 快照值,而非 chat() 返回后的新模型", async () => {
    const journal = new MemoryJournal();
    const llm = switchingLlm({ initial: "before-switch", during: "switched-after" });
    const loop = new AgentLoop({ journal, sessionId: "m1", system: "s", llm, tools: [], maxSteps: 2 });
    await loop.runTurn("做事");

    const agentPayload = journal.readAll().find((e) => e.kind === "message.agent")?.payload as { model?: string };
    expect(agentPayload.model).toBe("before-switch");
    expect(llm.state.model).toBe("switched-after"); // 前提成立:provider 确实在调用途中换了
  });

  it("成功 llm.trace 回调的 model 也是快照值", async () => {
    const journal = new MemoryJournal();
    const traces: LlmCallTrace[] = [];
    const llm = switchingLlm({ initial: "before-switch", during: "switched-after" });
    const loop = new AgentLoop({
      journal, sessionId: "m2", system: "s", llm, tools: [], maxSteps: 2,
      llmTrace: (t) => traces.push(t),
    });
    await loop.runTurn("做事");

    expect(traces).toHaveLength(1);
    expect(traces[0]!.model).toBe("before-switch");
    expect(traces[0]!.error).toBeUndefined();
  });

  it("失败路径:旁路 llmTrace 与 durable journal(llm.trace)都记快照值", async () => {
    const journal = new MemoryJournal();
    const traces: LlmCallTrace[] = [];
    const llm = switchingLlm({ initial: "before-switch", during: "switched-after", throwInChat: true });
    const loop = new AgentLoop({
      journal, sessionId: "m3", system: "s", llm, tools: [], maxSteps: 2,
      llmTrace: (t) => traces.push(t),
    });
    await expect(loop.runTurn("做事")).rejects.toThrow("fetch failed");

    // 旁路轨迹(回调)
    expect(traces).toHaveLength(1);
    expect(traces[0]!.model).toBe("before-switch");
    expect(traces[0]!.error).toContain("fetch failed");
    // durable journal 事件
    const durable = journal.readAll().find((e) => e.kind === "llm.trace")?.payload as { model?: string; error?: string };
    expect(durable.error).toContain("fetch failed");
    expect(durable.model).toBe("before-switch");
  });

  it("负面:provider 不暴露 model → payload 不含 model 键(不写 undefined/空串/?)", async () => {
    const journal = new MemoryJournal();
    const llm = { async chat() { return { content: "ok" }; } };
    const loop = new AgentLoop({ journal, sessionId: "m4", system: "s", llm, tools: [], maxSteps: 2 });
    await loop.runTurn("做事");

    const payload = journal.readAll().find((e) => e.kind === "message.agent")?.payload as Record<string, unknown>;
    expect("model" in payload).toBe(false);
  });

  it("负面:modelName 为空串(provider 暴露但空)时同样不写键", async () => {
    const journal = new MemoryJournal();
    const llm = { modelName: "", async chat() { return { content: "ok" }; } };
    const loop = new AgentLoop({ journal, sessionId: "m5", system: "s", llm, tools: [], maxSteps: 2 });
    await loop.runTurn("做事");

    const payload = journal.readAll().find((e) => e.kind === "message.agent")?.payload as Record<string, unknown>;
    expect("model" in payload).toBe(false);
  });
});
