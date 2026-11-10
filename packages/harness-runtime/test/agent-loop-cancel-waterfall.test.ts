/**
 * 取消信号链+waterfall 四拦截点专项(step-008 二期收口,designs/14 §1.2/§1.4)。
 * 锚定:cancel 贯通 LLM/工具、ABORTED_BEFORE_DISPATCH 配对、四个拦截点的显式 next() 契约。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, type LlmProvider, type Tool, type Message, type ToolCall } from "../src/agent/loop";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AgentLoop 取消信号链", () => {
  it("LLM 请求进行中 cancel:turn 以 cancelled 收口,不上抛", async () => {
    const journal = new MemoryJournal();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const llm: LlmProvider = {
      async chat(_msgs: Message[], _tools: unknown, signal?: AbortSignal) {
        await gate;
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
        return { content: "不应到达" };
      },
    };
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm });
    const p = loop.runTurn("长任务").catch((e) => { throw new Error(`不应上抛:${String(e)}`); });
    await sleep(10);
    loop.cancel("test");
    release();
    const out = await p;
    expect(out).toBe("");
    const turn = journal.readAll().find((e) => e.kind === "turn.end");
    expect((turn!.payload as { reason: string }).reason).toBe("cancelled");
    const step = journal.readAll().filter((e) => e.kind === "step.end").at(-1);
    expect((step!.payload as { reason: string }).reason).toBe("cancelled");
  });

  it("取消后未派发的独占工具补写 ABORTED_BEFORE_DISPATCH,配对不破", async () => {
    const journal = new MemoryJournal();
    const llm: LlmProvider = {
      async chat() {
        return {
          content: "调两个工具",
          toolCalls: [
            { id: "c1", name: "safeOne", arguments: "{}" },
            { id: "c2", name: "exclusive", arguments: "{}" },
          ] as ToolCall[],
        };
      },
    };
    let cancelSeen = false;
    const exclusive: Tool = {
      name: "exclusive",
      description: "独占工具,监听取消",
      parameters: { type: "object", properties: {} },
      async execute(_args, signal) {
        await sleep(30);
        if (signal?.aborted) { cancelSeen = true; throw new Error("aborted-by-test"); }
        return "done";
      },
    };
    const safeOne: Tool = {
      name: "safeOne", description: "安全工具", parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() { return "safe-ok"; },
    };
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "sys", llm, tools: [exclusive, safeOne] });
    const p = loop.runTurn("go");
    await sleep(5);
    loop.cancel();
    await p;
    expect(cancelSeen).toBe(true);
    const results = journal.readAll().filter((e) => e.kind === "tool.result");
    expect(results).toHaveLength(2); // 配对:两个调用都有结果
    const byId = new Map(results.map((e) => [(e.payload as { toolCallId: string }).toolCallId, (e.payload as { content: string }).content]));
    expect(byId.get("c1")).toBe("safe-ok");
    expect(byId.get("c2")).toBe("[aborted] 执行被取消");
    const turn = journal.readAll().find((e) => e.kind === "turn.end");
    expect((turn!.payload as { reason: string }).reason).toBe("cancelled");
  });
});

describe("AgentLoop waterfall 四拦截点(designs/14 §1.2)", () => {
  it("preStep:next(改写) 生效;不 next 即拦截本轮", async () => {
    const journal = new MemoryJournal();
    const llm: LlmProvider = { async chat(msgs: Message[]) { return { content: `收到:${(msgs.find((m) => m.role === "user") as { content: string }).content}` }; } };
    // 改写
    const l1 = new AgentLoop({
      journal, sessionId: "s1", system: "sys", llm,
      waterfall: { preStep: (_ctx, next) => { void next({ userText: "改写后的输入" }); } },
    });
    const out1 = await l1.runTurn("原始输入");
    expect(out1).toContain("改写后的输入");
    // 拦截(不调 next)
    const j2 = new MemoryJournal();
    const l2 = new AgentLoop({
      journal: j2, sessionId: "s2", system: "sys", llm,
      waterfall: { preStep: () => "涉密内容,拒绝处理" },
    });
    const out2 = await l2.runTurn("涉密输入");
    expect(out2).toBe("");
    const end = j2.readAll().find((e) => e.kind === "turn.end");
    expect((end!.payload as { reason: string; detail?: string }).reason).toBe("pre-step-blocked");
    expect((end!.payload as { detail?: string }).detail).toBe("涉密内容,拒绝处理");
    // 拦截轮不产生 LLM 调用与 message.user
    expect(j2.readAll().some((e) => e.kind === "message.user")).toBe(false);
  });

  it("preExecute:不 next 即拦截(工具不执行);next 透传执行", async () => {
    let executed = 0;
    const tool: Tool = { name: "t", description: "t", parameters: { type: "object", properties: {} }, async execute() { executed++; return "real"; } };
    const llm: LlmProvider = { async chat() { return { content: "x", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] }; } };
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "s1", system: "sys", llm, tools: [tool],
      waterfall: { preExecute: (call, next) => call.name === "t" ? "[guard] 高危时段拦截" : next() },
    });
    await loop.runTurn("go");
    expect(executed).toBe(0);
    const r = journal.readAll().find((e) => e.kind === "tool.result");
    expect((r!.payload as { content: string }).content).toBe("[guard] 高危时段拦截");
  });

  it("postExecute:改写工具结果(截断/脱敏挂点)", async () => {
    const tool: Tool = { name: "t", description: "t", parameters: { type: "object", properties: {} }, async execute() { return "secret-key=sk-abc"; } };
    let round = 0;
    const llm: LlmProvider = {
      async chat(msgs: Message[]) {
        round++;
        if (round === 1) return { content: "查一下", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] };
        const tm = msgs.find((m) => m.role === "tool") as { content: string } | undefined;
        return { content: `结果:${tm?.content}` };
      },
    };
    const loop = new AgentLoop({
      journal: new MemoryJournal(), sessionId: "s1", system: "sys", llm, tools: [tool],
      waterfall: { postExecute: (_c, result) => result.replace(/sk-\w+/g, "sk-***") },
    });
    const out = await loop.runTurn("go");
    expect(out).toContain("sk-***");
    expect(out).not.toContain("sk-abc");
  });

  it("turnStopping:stop=true 终止 turn,reason 落 step.end/turn.end", async () => {
    let round = 0;
    const llm: LlmProvider = {
      async chat() {
        round++;
        return { content: `第${round}步`, toolCalls: [{ id: `c${round}`, name: "t", arguments: "{}" }] };
      },
    };
    const tool: Tool = { name: "t", description: "t", parameters: { type: "object", properties: {} }, async execute() { return "ok"; } };
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "s1", system: "sys", llm, tools: [tool], maxSteps: 5,
      waterfall: { turnStopping: ({ step }) => (step >= 1 ? { stop: true, reason: "预算用尽" } : { stop: false }) },
    });
    const out = await loop.runTurn("go");
    expect(out).toBe("第2步");
    // step0 tools-done 放行;step1 stop 拦截
    const stepEnds = journal.readAll().filter((e) => e.kind === "step.end");
    expect((stepEnds[0]!.payload as { reason: string }).reason).toBe("tools-done");
    expect((stepEnds.at(-1)!.payload as { reason: string }).reason).toBe("turn-stopping");
    const turn = journal.readAll().find((e) => e.kind === "turn.end");
    expect((turn!.payload as { reason: string }).reason).toBe("stopped");
  });
});
