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

/** 大结果工具:段闭合定价只收 ≥2000 字符的结果(与组清理口径一致)。 */
const bigRead: Tool = {
 // 必须是 microcompact 可清工具 + 有 path 寻址,才会进入段批候选(与线上准入一致)。
  name: "read_file",
  description: "返回大段内容",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  isConcurrencySafe: () => true,
  async execute() { return "R".repeat(4_000); },
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
      (calls[0]!.payload as { toolCallId: string }).toolCallId,
    );
    // deriveMessages 重建出完整序列
    const msgs = deriveMessages(journal, "s1");
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("观察期:turn 末新闭合不立即 settle,下一 turn 首步到期后才 settle", async () => {
 // §4.1.3②:闭合当步仍在观察期;turn.end 先落账保证闭合可见,但至少过 1 步才取得可裁资格。
    const journal = new MemoryJournal();
    let round = 0;
    const llm: LlmProvider = {
      async chat() {
        round += 1;
        if (round === 1) {
          return { content: "", toolCalls: [{ id: "big-1", name: "read_file", arguments: JSON.stringify({ path: "src/big.ts" }) }] };
        }
        return { content: round === 2 ? "完成" : "继续完成" };
      },
    };
    const loop = new AgentLoop({
      journal, sessionId: "s-seg-settle", system: "", llm, tools: [bigRead], maxSteps: 3,
    });
    await loop.runTurn("读一大段");
    const afterFirst = journal.readAll();
    const firstEnd = afterFirst.findIndex((e) => e.kind === "turn.end");
    expect(firstEnd).toBeGreaterThanOrEqual(0);
    const settleAfterFirst = afterFirst.findIndex(
      (e) => e.kind === "custom" && (e.payload as { what?: string } | undefined)?.what === "context.segment.settle",
    );
    expect(settleAfterFirst).toBe(-1); // 观察期未到期,不当场结算

    await loop.runTurn("继续");
    const events = journal.readAll();
    const secondStart = events.findIndex((e, i) => i > firstEnd && e.kind === "turn.start");
    const settleAt = events.findIndex(
      (e, i) => i > secondStart && e.kind === "custom"
        && (e.payload as { what?: string } | undefined)?.what === "context.segment.settle",
    );
    expect(secondStart).toBeGreaterThan(firstEnd);
    expect(settleAt).toBeGreaterThan(secondStart);
    const settle = events[settleAt]!.payload as { approvedCount: number; priceRatio: number };
 // 4000 字符 → W=1000;W′=40、tail≈段锚+最终回答、r=10、N=上一 turn 2 步 → 经济门批准。
    expect(settle.approvedCount).toBeGreaterThanOrEqual(1);
    expect(settle.priceRatio).toBe(10);
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
