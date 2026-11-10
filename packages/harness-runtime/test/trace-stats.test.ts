import { describe, it, expect } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import { deriveTraceStats } from "../src/agent/trace-stats";
import { MemoryJournal } from "@lampgenie/core";
import type { Tool } from "../src/agent/loop";

function llm(script: { content: string; toolCalls?: { id: string; name: string; arguments: string }[] }[], usage?: { inputTokens: number; outputTokens: number; totalTokens?: number }) {
  let i = 0;
  return {
    async chat() {
      const r = script[Math.min(i++, script.length - 1)!];
      return { ...r!, ...(usage ? { usage } : {}) };
    },
  };
}

const tool: Tool = {
  name: "t",
  description: "测试工具",
  parameters: { type: "object", properties: {} },
  async execute() { await new Promise((r) => setTimeout(r, 30)); return "ok"; },
};

describe("loop 追踪事件( D1/D2)", () => {
  it("turn/step 边界+llmMs/usage/durationMs 全落盘,投影聚合正确", async () => {
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "tr1", system: "s",
      llm: llm([
        { content: "调工具", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] },
        { content: "完成" },
      ], { inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
      tools: [tool], maxSteps: 4,
    });
    await loop.runTurn("做事");

    const evs = journal.readAll();
    expect(evs.filter((e) => e.kind === "turn.start")).toHaveLength(1);
    const turnEnd = evs.find((e) => e.kind === "turn.end")?.payload as { reason: string };
    expect(turnEnd.reason).toBe("completed");
    expect(evs.filter((e) => e.kind === "step.end")).toHaveLength(2);
    const agentMsg = evs.find((e) => e.kind === "message.agent")?.payload as { llmMs: number; usage?: { totalTokens?: number }; turn: number; step: number };
    expect(agentMsg.llmMs).toBeGreaterThanOrEqual(0);
    expect(agentMsg.usage?.totalTokens).toBe(150);
    expect(agentMsg.turn).toBe(1);
    const toolResult = evs.find((e) => e.kind === "tool.result")?.payload as { durationMs: number };
    expect(toolResult.durationMs).toBeGreaterThanOrEqual(20); // 工具内 sleep 30ms

    const stats = deriveTraceStats(evs.map((e) => ({ kind: e.kind, payload: e.payload })));
    expect(stats).toMatchObject({
      turns: 1, steps: 2, llmCalls: 2, toolCalls: 1,
      tokens: { input: 200, output: 100, total: 300 }, // 每次调用同 usage,2 次聚合
    });
    expect(stats.toolMs).toBeGreaterThanOrEqual(20);
  }, 10_000);

  it("max-steps 路径 turn.end 带原因;LLM 抛错 turn.end=error", async () => {
    const j2 = new MemoryJournal();
    const l2 = new AgentLoop({
      journal: j2, sessionId: "tr2", system: "s",
      llm: llm([{ content: "again", toolCalls: [{ id: "c", name: "t", arguments: "{}" }] }]),
      tools: [tool], maxSteps: 2,
    });
    await l2.runTurn("循环");
    expect((j2.readAll().find((e) => e.kind === "turn.end")?.payload as { reason: string }).reason).toBe("max-steps");

    const j3 = new MemoryJournal();
    const l3 = new AgentLoop({
      journal: j3, sessionId: "tr3", system: "s",
      llm: { async chat() { throw new Error("boom"); } }, tools: [],
    });
    await expect(l3.runTurn("炸")).rejects.toThrow("boom");
    const evs3 = j3.readAll();
    expect((evs3.find((e) => e.kind === "turn.end")?.payload as { reason: string }).reason).toBe("error");
    expect((evs3.filter((e) => e.kind === "step.end").at(-1)?.payload as { reason: string }).reason).toBe("error");
  }, 10_000);

  it("缓存命中聚合:cachedTokens 进 tokens.cached", async () => {
    const { extractUsage } = await import("../src/agent/openai-provider");
    // 三形态:OpenAI prompt_tokens_details / DeepSeek prompt_cache_hit_tokens / realtime input_tokens+details
    expect(extractUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } })).toMatchObject({ inputTokens: 100, outputTokens: 20, cachedTokens: 80 });
    expect(extractUsage({ prompt_cache_hit_tokens: 50, prompt_tokens: 90, completion_tokens: 10 })).toMatchObject({ cachedTokens: 50, inputTokens: 90 });
    expect(extractUsage({ input_tokens: 30, output_tokens: 5, input_token_details: { cached_tokens: 12 } })).toMatchObject({ inputTokens: 30, cachedTokens: 12 });
    expect(extractUsage(undefined)).toBeUndefined();
    expect(extractUsage({})).toBeUndefined();

    const journal = new MemoryJournal();
    journal.append({ kind: "message.agent", sessionId: "ch2", payload: { text: "x", llmMs: 100, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedTokens: 80 } } });
    const st = deriveTraceStats(journal.readAll().map((e) => ({ kind: e.kind, payload: e.payload })));
    expect(st.tokens).toEqual({ input: 100, output: 10, total: 110, cached: 80 });
  });

  it("旧事件(无 llmMs/usage)投影如实为 0 不炸", () => {
    const s = deriveTraceStats([
      { kind: "message.agent", payload: { text: "旧" } },
      { kind: "tool.result", payload: { toolCallId: "x", name: "t", content: "" } },
    ]);
    expect(s.llmMs).toBe(0);
    expect(s.tokens).toEqual({ input: 0, output: 0, total: 0, cached: 0 });
    expect(s.ttftMs).toBe(0);
    expect(s.decodeTps).toBe(0);
 // 无子代理事件时子代理区如实为空(不造数)
    expect(s.subagents).toEqual({ spawned: 0, agents: [], totals: { calls: 0, input: 0, output: 0, total: 0, cached: 0, llmMs: 0 } });
  });

  it("子代理 token 独立聚合(2026-10-22):per-agent 输入/输出/缓存/调用数;不并入主会话 tokens", () => {
    const s = deriveTraceStats([
      // 主会话一次调用
      { kind: "message.agent", payload: { text: "主", llmMs: 100, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } },
      // 两个子代理:spawn 带 title/taskId,event 内层 message.agent 带 usage
      { kind: "subagent.spawn", payload: { agentId: "a1", taskId: "t1", title: "调查A" } },
      { kind: "subagent.spawn", payload: { agentId: "a2", taskId: "t2" } },
      { kind: "subagent.event", payload: { agentId: "a1", taskId: "t1", kind: "message.agent", llmMs: 400, usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cachedTokens: 600 } } },
      { kind: "subagent.event", payload: { agentId: "a1", taskId: "t1", kind: "message.agent", llmMs: 600, usage: { inputTokens: 3000, outputTokens: 300, totalTokens: 3300, cachedTokens: 2400 } } },
      { kind: "subagent.event", payload: { agentId: "a2", taskId: "t2", kind: "message.agent", llmMs: 50, usage: { inputTokens: 500, outputTokens: 50 } } },
      // 工具事件不参与 token 聚合
      { kind: "subagent.event", payload: { agentId: "a1", taskId: "t1", kind: "tool.result", name: "read_file", durationMs: 30 } },
    ]);
    // 主会话 token 不被子代理污染
    expect(s.tokens).toEqual({ input: 10, output: 5, total: 15, cached: 0 });
    expect(s.llmCalls).toBe(1);
    expect(s.subagents.spawned).toBe(2);
    // 按 total 降序:a1(4500) 在 a2(550) 前
    expect(s.subagents.agents.map((a) => a.agentId)).toEqual(["a1", "a2"]);
    expect(s.subagents.agents[0]).toMatchObject({ agentId: "a1", taskId: "t1", title: "调查A", calls: 2, input: 4000, output: 500, total: 4500, cached: 3000, llmMs: 1000 });
    expect(s.subagents.agents[1]).toMatchObject({ agentId: "a2", calls: 1, input: 500, output: 50, total: 550, cached: 0 });
    expect(s.subagents.totals).toEqual({ calls: 3, input: 4500, output: 550, total: 5050, cached: 3000, llmMs: 1050 });
  });

  it("按模型归集(2026-10-28 成本核算):主会话+子代理合并入 byModel,cacheWrite 单列", () => {
    const s = deriveTraceStats([
      { kind: "message.agent", payload: { text: "", llmMs: 10, model: "model-a", usage: { inputTokens: 1_000_000, outputTokens: 1000, cachedTokens: 600_000, cacheCreationTokens: 100_000 } } },
      { kind: "message.agent", payload: { text: "", llmMs: 10, model: "model-b", usage: { inputTokens: 2000, outputTokens: 500 } } },
      { kind: "subagent.event", payload: { agentId: "s1", kind: "message.agent", llmMs: 10, model: "model-a", usage: { inputTokens: 5000, outputTokens: 100, cachedTokens: 4000 } } },
    ]);
    // cacheWrite 只在有值时出现(旧客户端/旧断言零破坏)
    expect(s.tokens.cacheWrite).toBe(100_000);
    expect(s.tokens.input).toBe(1_002_000);
    // 按模型:model-a = 主会话 + 子代理合并,model-b 独立
    const a = s.byModel.find((m) => m.model === "model-a");
    const b = s.byModel.find((m) => m.model === "model-b");
    expect(a).toMatchObject({ calls: 2, input: 1_005_000, cached: 604_000, cacheWrite: 100_000, output: 1100 });
    expect(b).toMatchObject({ calls: 1, input: 2000, cached: 0, cacheWrite: 0 });
    // total 降序:model-a 在前
    expect(s.byModel[0]!.model).toBe("model-a");
  });

  it("子代理仅 spawn 无 usage:出现在明细里但 token 如实 0(外部后端无 loop 事件)", () => {
    const s = deriveTraceStats([
      { kind: "subagent.spawn", payload: { agentId: "x1", taskId: "tx", title: "外部后端" } },
    ]);
    expect(s.subagents.spawned).toBe(1);
    // 派发即登记(诚实:能看出「派了但无 usage 数据」,而不是假装没这个 agent)
    expect(s.subagents.agents).toEqual([{ agentId: "x1", taskId: "tx", title: "外部后端", calls: 0, input: 0, output: 0, total: 0, cached: 0, llmMs: 0 }]);
    expect(s.subagents.totals.calls).toBe(0);
  });

  it("子代理 lastAt(2026-10-24 最近3条排序依据):spawn 兜底、event 刷新取最大", () => {
    // spawn 带 time 即登记;后续 event 取最大;乱序批不倒退
    const s = deriveTraceStats([
      { kind: "subagent.spawn", payload: { agentId: "a1", title: "A" }, time: 100 },
      { kind: "subagent.event", payload: { agentId: "a1", kind: "message.agent", llmMs: 10 }, time: 300 },
      { kind: "subagent.event", payload: { agentId: "a1", kind: "message.agent", llmMs: 10 }, time: 200 }, // 乱序批(更早)
      { kind: "subagent.spawn", payload: { agentId: "b2", title: "B" }, time: 150 },
    ]);
    const byId = Object.fromEntries(s.subagents.agents.map((a) => [a.agentId, a]));
    expect(byId.a1.lastAt).toBe(300); // 取最大,乱序不倒退
    expect(byId.b2.lastAt).toBe(150); // 仅 spawn 也有兜底时间
    // 无 time 的旧事件:lastAt 缺省 0(不推断)
    const s0 = deriveTraceStats([
      { kind: "subagent.spawn", payload: { agentId: "x", title: "旧" } },
      { kind: "subagent.event", payload: { agentId: "x", kind: "message.agent", llmMs: 5 } },
    ]);
    expect(s0.subagents.agents[0].lastAt).toBe(0);
  });

  it("TTFT/解码吞吐(流式收口):流式事件投影均值;非流式(无 ttftMs)=0", () => {
    // 流式:两次调用 ttft 40/60,解码窗口 80ms 输出 16tok → tps 200;160ms 输出 32tok → tps 200 → 均值 200
    const s = deriveTraceStats([
      { kind: "message.agent", payload: { text: "a", llmMs: 120, ttftMs: 40, usage: { inputTokens: 10, outputTokens: 16 } } },
      { kind: "message.agent", payload: { text: "b", llmMs: 220, ttftMs: 60, usage: { inputTokens: 10, outputTokens: 32 } } },
    ]);
    expect(s.ttftMs).toBe(50);
    expect(s.ttftMsMax).toBe(60);
    expect(s.decodeTps).toBe(200);
    // 非流式:usage 在但无 ttftMs → tps 不推断
    const s2 = deriveTraceStats([
      { kind: "message.agent", payload: { text: "x", llmMs: 500, usage: { inputTokens: 1, outputTokens: 100 } } },
    ]);
    expect(s2.ttftMs).toBe(0);
    expect(s2.decodeTps).toBe(0);
  });
});

describe("压缩后上下文占用重算(2026-10-30 修「/compact 后看板不更新」)", () => {
 /** 构造一次真实调用(message.agent 带 usage),让 contextTokens 有经验证锚点。 */
  const callEvent = (inputTokens: number) => ({
    kind: "message.agent", time: 1000,
    payload: { text: "回复", model: "m1", usage: { inputTokens, outputTokens: 10, totalTokens: inputTokens + 10, cachedTokens: 0 } },
  });

  it("compact.done(有摘要)后 contextTokens 下降,且标记 estimated", async () => {
    const { deriveTraceStats } = await import("../src/agent/trace-stats");
    const before = deriveTraceStats([callEvent(80_000)]);
    expect(before.contextTokens).toBe(80_000);
    expect(before.contextEstimated).toBeFalsy(); // 实测值不标估算

    const after = deriveTraceStats([
      callEvent(80_000),
      {
        kind: "compact.done", time: 2000,
        payload: {
          summary: "摘".repeat(1000),      // 1000 字符 ≈ 250 token
          facts: "事".repeat(400),          // 400 ≈ 100
          tail: [{ role: "user", content: "尾".repeat(400) }], // 400 ≈ 100
        },
      },
    ]);
    // 估算 = (1000+400+400)/4 = 450
    expect(after.contextTokens).toBe(450);
    expect(after.contextTokens).toBeLessThan(before.contextTokens);
    expect(after.contextEstimated).toBe(true);
  });

  it("negative 无摘要/空摘要的 compact.done 不改 contextTokens(与 deriveMessages 边界口径一致)", async () => {
    const { deriveTraceStats } = await import("../src/agent/trace-stats");
    for (const payload of [{}, { summary: "" }, { summary: "   " }, { compacted: 2, keepRecent: 5 }]) {
      const s = deriveTraceStats([callEvent(50_000), { kind: "compact.done", time: 2000, payload }]);
      expect(s.contextTokens).toBe(50_000);
      expect(s.contextEstimated).toBeFalsy();
    }
  });

  it("negative 累计量不被压缩削减:tokens.input/cached/llmCalls 在 compact.done 后不变", async () => {
    const { deriveTraceStats } = await import("../src/agent/trace-stats");
    const evs = [callEvent(80_000), callEvent(70_000)];
    const before = deriveTraceStats(evs);
    const after = deriveTraceStats([...evs, {
      kind: "compact.done", time: 3000,
      payload: { summary: "摘".repeat(400), tail: [] },
    }]);
    // 钱已经花掉了,压缩不该把它抹掉
    expect(after.tokens.input).toBe(before.tokens.input);
    expect(after.tokens.cached).toBe(before.tokens.cached);
    expect(after.llmCalls).toBe(before.llmCalls);
    // 只有「当前占用」这一项跟着压缩变
    expect(after.contextTokens).toBeLessThan(before.contextTokens);
  });

  it("negative 压缩后又被真实调用覆盖:contextTokens 回实测、estimated 清掉", async () => {
    const { deriveTraceStats } = await import("../src/agent/trace-stats");
    const s = deriveTraceStats([
      callEvent(80_000),
      { kind: "compact.done", time: 2000, payload: { summary: "摘".repeat(400), tail: [] } },
      callEvent(12_345), // 压缩后的第一次真实调用
    ]);
    expect(s.contextTokens).toBe(12_345);
    expect(s.contextEstimated).toBe(false);
  });

  it("negative 极端长摘要(估算反而更大)时不把占用调大,保留实测", async () => {
    const { deriveTraceStats } = await import("../src/agent/trace-stats");
    const s = deriveTraceStats([
      callEvent(1_000), // 很小的上下文
      { kind: "compact.done", time: 2000, payload: { summary: "摘".repeat(40_000), tail: [] } }, // 估算 10,000
    ]);
    expect(s.contextTokens).toBe(1_000); // 没被调大
    expect(s.contextEstimated).toBeFalsy();
  });
});

describe("LLM 失败统计(txa5)", () => {
  it("两条带 error 的 llm.trace → llmFailures=2、failedLlmMs=ms 之和;成功轨迹(无 error)不计", () => {
    const s = deriveTraceStats([
      { kind: "llm.trace", payload: { turn: 1, step: 0, model: "m", ms: 1200, error: "fetch failed" } },
      { kind: "llm.trace", payload: { turn: 1, step: 1, model: "m", ms: 800, error: "timeout" } },
      // 成功旁路(无 error 或空 error)→ 不计失败
      { kind: "llm.trace", payload: { turn: 1, step: 2, model: "m", ms: 500 } },
      { kind: "llm.trace", payload: { turn: 1, step: 3, model: "m", ms: 500, error: "" } },
    ]);
    expect(s.llmFailures).toBe(2);
    expect(s.failedLlmMs).toBe(2000);
    // 口径不变:llmCalls 仍只由 message.agent 计,llm.trace 不掺进耗时
    expect(s.llmCalls).toBe(0);
    expect(s.llmMs).toBe(0);
  });

  it("旧事件集(无 llm.trace)→ 两值为 0,既有口径不变", () => {
    const legacy = deriveTraceStats([
      { kind: "turn.start", payload: { turn: 1 } },
      { kind: "message.agent", payload: { text: "旧", llmMs: 300, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } },
      { kind: "tool.result", payload: { toolCallId: "x", name: "t", content: "ok", durationMs: 20 } },
    ]);
    expect(legacy.llmFailures).toBe(0);
    expect(legacy.failedLlmMs).toBe(0);
    expect(legacy.llmCalls).toBe(1);
    expect(legacy.llmMs).toBe(300);
  });

  it("失败轨迹缺 ms 时按 0 计(不推断)", () => {
    const s = deriveTraceStats([{ kind: "llm.trace", payload: { turn: 1, step: 0, error: "boom" } }]);
    expect(s.llmFailures).toBe(1);
    expect(s.failedLlmMs).toBe(0);
  });
});

describe("统计归一层(;2026-11 口径:API 实测为主,估算只作旁注)", () => {
  const agentCall = (turn: number, step: number, inputTokens: number, rest: Record<string, unknown> = {}) => ({
    kind: "message.agent", time: 1000,
    payload: { text: "回复", model: "m1", turn, step, llmMs: 100, usage: { inputTokens, outputTokens: 10, totalTokens: inputTokens + 10, cachedTokens: 0 }, ...rest },
  });
  const trace = (turn: number, step: number, payload: Record<string, unknown>) => ({ kind: "llm.trace", time: 1100, payload: { turn, step, model: "m1", ms: 100, ...payload } });

  it("上报 111976 但估算 182000 且 suspect → contextTokens 仍是 API 值,估算进 contextTokensEst,异常旁注透出", () => {
    const s = deriveTraceStats([
      agentCall(1, 0, 111_976),
      trace(1, 0, {
        estimatedInputTokens: 182_000, estimatedCachedTokens: 120_000,
        usageSuspect: true, usageAnomaly: "provider 上报 input=111976 低于估算 182000(疑似缓存/截断计数)",
        usage: { inputTokens: 111_976, cachedTokens: 0, outputTokens: 42, totalTokens: 112_018 },
      }),
    ]);
    expect(s.contextTokens).toBe(111_976);          // 展示主数字 = API 上报值(suspect 不改写)
    expect(s.contextTokensReported).toBe(111_976);  // 旧字段名同值(向后兼容)
    expect(s.contextTokensEst).toBe(182_000);       // 本地估算只作旁注
    expect(s.contextEstimated).toBe(false);          // 有 API 值就不是估算展示
    expect(s.usageSuspect).toBe(true);
    expect(s.usageAnomaly).toContain("疑似缓存");
  });

  it("suspect 只是旁注徽标:cached > 上一步 input 这类「不可能」样本仍按 API 原值展示,不被估算替换", () => {
    const s = deriveTraceStats([
      agentCall(2, 0, 166_159),
      trace(2, 0, {
        estimatedInputTokens: 190_000,
        usageSuspect: true, usageAnomaly: "上报 cached 150528 > 上一步 input 111976",
        usage: { inputTokens: 166_159, cachedTokens: 150_528, outputTokens: 7, totalTokens: 166_166 },
      }),
      // 再补一次正常调用:两次都不许把 contextTokens 改成估算
      agentCall(2, 1, 170_000),
      trace(2, 1, { estimatedInputTokens: 200_000, usage: { inputTokens: 170_000, cachedTokens: 160_000, outputTokens: 9, totalTokens: 170_009 } }),
    ]);
    expect(s.contextTokens).toBe(170_000);       // 最后一条 API 值
    expect(s.contextTokensEst).toBe(200_000);    // 最后一条估算(旁注)
    expect(s.contextEstimated).toBe(false);
    expect(s.usageSuspect).toBe(true);           // 徽标在,数字不动
  });

  it("无 usage 只有估算的 llm.trace → contextTokensEst 在场,contextTokens 不变成估算(旧值 0 保持)", () => {
    const s = deriveTraceStats([
      trace(1, 0, { estimatedInputTokens: 30_000 }),
    ]);
    expect(s.contextTokensEst).toBe(30_000);
    expect(s.contextTokens).toBe(0);       // 没有 API 值 → 不拿估算顶替
    expect(s.contextTokensReported).toBe(0);
    expect(s.contextEstimated).toBeUndefined();
  });

  it("正常一致(估算 42500 / 上报 42000,无 suspect)→ 取 API 值、估算旁注、两套汇总各自独立", () => {
    // 事件序故意把 llm.trace 放在前:预扫描保证不靠先后猜
    const s = deriveTraceStats([
      trace(2, 1, {
        estimatedInputTokens: 42_500, estimatedCachedTokens: 3_000,
        usage: { inputTokens: 42_000, cachedTokens: 2_800, outputTokens: 20, totalTokens: 42_020 },
      }),
      agentCall(2, 1, 42_000),
    ]);
    expect(s.contextTokens).toBe(42_000);          // API 上报值
    expect(s.contextTokensReported).toBe(42_000);
    expect(s.contextTokensEst).toBe(42_500);       // 本地估算
    expect(s.contextEstimated).toBe(false);
    expect(s.usageNormalized).toEqual({ calls: 1, estInput: 42_500, estCached: 3_000, repInput: 42_000, repCached: 2_800, suspectCalls: 0 });
    expect(s.usageSuspect).toBeUndefined();
    expect("usageSuspect" in s).toBe(false);
  });

  it("usageNormalized 按事件累加(est/rep 各自求和、calls=2、suspectCalls=1)", () => {
    const s = deriveTraceStats([
      trace(1, 0, {
        estimatedInputTokens: 10_000, estimatedCachedTokens: 4_000,
        usage: { inputTokens: 9_500, cachedTokens: 3_000, outputTokens: 5, totalTokens: 9_505 },
      }),
      trace(1, 1, {
        estimatedInputTokens: 12_000, estimatedCachedTokens: 5_000,
        usageSuspect: true, usageAnomaly: "input 上报 0(provider 未回填)",
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 5, totalTokens: 5 },
      }),
    ]);
    expect(s.usageNormalized).toEqual({ calls: 2, estInput: 22_000, estCached: 9_000, repInput: 9_500, repCached: 3_000, suspectCalls: 1 });
    expect(s.usageSuspect).toBe(true);
  });

  it("失败调用也计入 usageNormalized(失败也有请求规模)", () => {
    const s = deriveTraceStats([
      trace(1, 0, { estimatedInputTokens: 30_000, error: "fetch failed" }),
    ]);
    expect(s.llmFailures).toBe(1);
    expect(s.usageNormalized).toEqual({ calls: 1, estInput: 30_000, estCached: 0, repInput: 0, repCached: 0, suspectCalls: 0 });
  });

  it("旧 journal(只有 message.agent + usage)→ 取 API 上报值、无估算旁注、无 usageNormalized 键", () => {
    const s = deriveTraceStats([
      { kind: "turn.start", payload: { turn: 1 } },
      agentCall(1, 0, 55_000),
      { kind: "tool.result", payload: { toolCallId: "x", name: "t", content: "ok", durationMs: 10 } },
    ]);
    expect(s.contextTokens).toBe(55_000);
    expect(s.contextTokensReported).toBe(55_000);
    // 2026-11 口径:有 API 值 → contextEstimated 一律 false(旧行为是不写该键;展示语义同「非估算」)
    expect(s.contextEstimated).toBe(false);
    expect(s.contextTokensEst).toBeUndefined(); // 无本地估算就不出现该键
    expect("usageNormalized" in s).toBe(false);
    expect(s.usageSuspect).toBeUndefined();
    expect(s.usageAnomaly).toBeUndefined();
  });
});

describe("压缩边界截断(压缩真正生效)", () => {
  it("compact.done 之后的派生消息只含边界后内容", async () => {
    const { deriveMessages } = await import("../src/agent/loop");
    const journal = new MemoryJournal();
    journal.append({ kind: "message.user", sessionId: "ct", payload: { text: "边界前的旧消息" } });
    journal.append({ kind: "message.agent", sessionId: "ct", payload: { text: "旧回复" } });
    journal.append({ kind: "compact.done", sessionId: "ct", payload: { summary: "旧摘要" } });
    journal.append({ kind: "message.system", sessionId: "ct", payload: { text: "[上下文已压缩] 摘要:XYZ" } });
    journal.append({ kind: "message.user", sessionId: "ct", payload: { text: "边界后的新任务" } });
    const msgs = deriveMessages(journal, "ct");
    expect(msgs).toHaveLength(2); // reminder + 新任务;边界前全丢
    expect(msgs[0]!.content).toContain("[系统提醒]");
    expect(msgs[1]!.content).toBe("边界后的新任务");
    expect(msgs.some((m) => String(m.content).includes("旧消息"))).toBe(false);
  });
});
