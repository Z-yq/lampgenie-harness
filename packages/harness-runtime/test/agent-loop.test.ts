import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, deriveMessages, type LlmProvider, type Tool, type Message } from "../src/agent/loop";

/** Mock LLM:第一轮要求调工具,第二轮给最终答案。 */
function scriptedLlm(): LlmProvider {
  let round = 0;
  return {
    async chat(messages: Message[]) {
      round++;
      if (round === 1) {
        return {
          content: "我先查一下",
          toolCalls: [{ id: "call-1", name: "getTime", arguments: "{}" }],
        };
      }
      // 第二轮:应能看到工具结果
      const toolMsg = messages.find((m) => m.role === "tool");
      return { content: `时间到了(${toolMsg ? String((toolMsg as { content: string }).content) : "无"})` };
    },
  };
}

const getTime: Tool = {
  name: "getTime",
  description: "获取当前时间",
  parameters: { type: "object", properties: {} },
  isConcurrencySafe: () => true,
  async execute() { return "2026-10-10 20:00"; },
};

describe("AgentLoop", () => {
  it("工具调用全链路:user→assistant(toolCall)→tool.result→assistant(最终)", async () => {
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "s1", system: "你是助手", llm: scriptedLlm(), tools: [getTime],
    });
    const out = await loop.runTurn("现在几点?");
    expect(out).toContain("时间到了");
    expect(out).toContain("2026-10-10 20:00");
    // journal 配对:tool.call 与 tool.result 同 id
    const events = journal.readAll();
    const calls = events.filter((e) => e.kind === "tool.call");
    const results = events.filter((e) => e.kind === "tool.result");
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect((results[0]!.payload as { toolCallId: string }).toolCallId).toBe(
      (calls[0]!.payload as { toolCallId: string }).toolCallId);
    // deriveMessages 重建出完整序列
    const msgs = deriveMessages(journal, "s1");
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("未知工具返回错误消息而不崩", async () => {
    const journal = new MemoryJournal();
    const llm: LlmProvider = {
      async chat() {
        return { content: "调", toolCalls: [{ id: "c1", name: "不存在", arguments: "{}" }] };
      },
    };
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "", llm, tools: [], maxSteps: 2 });
    await loop.runTurn("hi");
    const results = journal.readAll().filter((e) => e.kind === "tool.result");
    expect(String((results[0]!.payload as { content: string }).content)).toContain("未知工具");
 // 错误框带可达候选(tools=[] 时明示「当前无工具」,不让模型瞎猜)
    expect(String((results[0]!.payload as { content: string }).content)).toContain("可达");
    expect(String((results[0]!.payload as { content: string }).content)).toContain("(当前无工具)");
  });

  it("未知工具给出可达候选(身份治理建议)", async () => {
    const journal = new MemoryJournal();
    const llm: LlmProvider = {
      async chat() {
        return { content: "调", toolCalls: [{ id: "c1", name: "getTim", arguments: "{}" }] };
      },
    };
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "", llm, tools: [getTime], maxSteps: 2 });
    await loop.runTurn("hi");
    const content = String((journal.readAll().filter((e) => e.kind === "tool.result")[0]!.payload as { content: string }).content);
    expect(content).toContain("未知工具 getTim");
    expect(content).toContain("可达:");
    expect(content).toContain("getTime");
  });

  it("maxSteps 防死循环", async () => {
    const journal = new MemoryJournal();
    const llm: LlmProvider = {
      async chat() {
        return { content: "再调", toolCalls: [{ id: "c", name: "getTime", arguments: "{}" }] };
      },
    };
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "", llm, tools: [getTime], maxSteps: 3 });
    await loop.runTurn("hi");
 // 末步(step=2)的工具调用被预算收束拦下(**不执行**,只落合成 tool.result),
 // 所以真实执行数 = maxSteps-1,循环仍然被 maxSteps 硬性收住(防死循环意图不变)。
    expect(journal.readAll().filter((e) => e.kind === "tool.call").length).toBe(2);
    expect((journal.readAll().filter((e) => e.kind === "turn.end").at(-1)!.payload as { reason: string }).reason).toBe("budget-exhausted");
  });
});

describe(" 思考链路", () => {
  it("provider 返回 reasoning → journal message.agent 携带 reasoning+llmMs", async () => {
    const journal = new MemoryJournal();
    const llm: LlmProvider = {
      async chat() {
        return { content: "答案", reasoning: "让我想一想……推理过程" };
      },
    };
    const loop = new AgentLoop({ journal, sessionId: "s-think", system: "sys", llm });
    await loop.runTurn("问");
    const ev = journal.readAll().find((e) => e.kind === "message.agent");
    const p = ev!.payload as { reasoning?: string; llmMs?: number };
    expect(p.reasoning).toBe("让我想一想……推理过程");
    expect(typeof p.llmMs).toBe("number");
  });
  it("无 reasoning → payload 不带 reasoning 字段(旧事件兼容)", async () => {
    const journal = new MemoryJournal();
    const llm: LlmProvider = { async chat() { return { content: "直接答" }; } };
    const loop = new AgentLoop({ journal, sessionId: "s-nothink", system: "sys", llm });
    await loop.runTurn("问");
    const ev = journal.readAll().find((e) => e.kind === "message.agent");
    expect((ev!.payload as { reasoning?: string }).reasoning).toBeUndefined();
  });
});

describe("2026-11-13 RSI 机制隔离:freshFromLastUser / freshContext", () => {
  it("deriveMessages(freshFromLastUser):只从最后一条 user 消息起重建", () => {
    const journal = new MemoryJournal();
    journal.append({ kind: "message.user", sessionId: "s1", payload: { text: "task A" } });
    journal.append({ kind: "message.agent", sessionId: "s1", payload: { text: "A done" } });
    journal.append({ kind: "message.user", sessionId: "s1", payload: { text: "task B" } });
    journal.append({ kind: "message.agent", sessionId: "s1", payload: { text: "B start" } });
    expect(deriveMessages(journal, "s1").map((m) => String(m.content))).toEqual(["task A", "A done", "task B", "B start"]);
    expect(deriveMessages(journal, "s1", { freshFromLastUser: true }).map((m) => String(m.content))).toEqual(["task B", "B start"]);
  });

  it("AgentLoop(freshContext):上一个独立任务的对话不进本次请求", async () => {
    const journal = new MemoryJournal();
    journal.append({ kind: "message.user", sessionId: "s1", payload: { text: "OLD TASK" } });
    journal.append({ kind: "message.agent", sessionId: "s1", payload: { text: "OLD ANSWER" } });
    let seen: Message[] = [];
    const llm: LlmProvider = {
      async chat(messages: Message[]) {
        seen = messages;
        return { content: "OK" };
      },
    };
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "", llm, tools: [], maxSteps: 1, freshContext: true });
    await loop.runTurn("NEW TASK");
    expect(seen.some((m) => String(m.content).includes("OLD TASK"))).toBe(false);
    expect(seen.some((m) => String(m.content).includes("OLD ANSWER"))).toBe(false);
    expect(seen.some((m) => String(m.content).includes("NEW TASK"))).toBe(true);
  });
});

describe("2026-11-13 freshFromLastUser:非单调 seq(worker ProxyJournal)", () => {
  it("按数组位置切,不按 seq 切", () => {
 // session-worker 的 ProxyJournal:种子事件保留 gateway seq(大),本地 append 用副本下标(小)。
    const fake = {
      readAll: () => [
        { kind: "message.user", sessionId: "s1", seq: 900, payload: { text: "OLD" } },
        { kind: "message.agent", sessionId: "s1", seq: 901, payload: { text: "A" } },
        { kind: "message.user", sessionId: "s1", seq: 3, payload: { text: "NEW" } },
        { kind: "message.agent", sessionId: "s1", seq: 4, payload: { text: "B" } },
      ],
    } as unknown as import("@lampgenie/core").Journal;
    expect(deriveMessages(fake, "s1", { freshFromLastUser: true }).map((m) => String(m.content))).toEqual(["NEW", "B"]);
  });
});
