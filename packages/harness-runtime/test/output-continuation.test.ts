import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, deriveMessages, type LlmProvider, type LlmResponse, type Message, type Tool } from "../src/agent/loop";

/** M28 输出截断续写:假 provider 按调用序返回 finishReason,验证续写/合并/剥离/上限。 */

const PROMPT_HEAD = "继续。从被截断处紧接着写";
const LIMIT_WARN = "[输出上限] 已续写 3 次仍被截断;请缩小单次输出或分段交付。";

/** 按调用序返回预设响应(用尽后重复最后一条);calls 记录每次收到的 messages。 */
function scripted(responses: LlmResponse[]) {
  const calls: Message[][] = [];
  const llm: LlmProvider = {
    async chat(messages) {
      calls.push(messages);
      return responses[Math.min(calls.length - 1, responses.length - 1)]!;
    },
  };
  return { llm, calls };
}

const getTime: Tool = {
  name: "getTime",
  description: "获取当前时间",
  parameters: { type: "object", properties: {} },
  isConcurrencySafe: () => true,
  async execute() { return "2026-11-07 20:00"; },
};

describe("M28 输出截断续写", () => {
  it("length→stop:两段合并、只有一条 assistant 落账、journal 不含续写提示、provider 被调 2 次", async () => {
    const journal = new MemoryJournal();
    const { llm, calls } = scripted([
      { content: "前半段,", finishReason: "length" },
      { content: "后半段。", finishReason: "stop" },
    ]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "你是助手", llm, tools: [] });
    const out = await loop.runTurn("写一段长文");

    expect(out).toBe("前半段,后半段。");
    expect(calls).toHaveLength(2);

    // 续写请求 = 原 messages + 1 条临时 user 消息(固定文案)
    const secondReq = calls[1]!;
    expect(secondReq.length).toBe(calls[0]!.length + 1);
    const lastMsg = secondReq[secondReq.length - 1]!;
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toContain(PROMPT_HEAD);

    // 合并结果作为单条 message.agent 落账
    const agents = journal.readAll().filter((e) => e.kind === "message.agent");
    expect(agents).toHaveLength(1);
    expect((agents[0]!.payload as { text: string }).text).toBe("前半段,后半段。");

    // 续写提示绝不进 journal/历史
    expect(JSON.stringify(journal.readAll())).not.toContain(PROMPT_HEAD);
    expect(deriveMessages(journal, "s1").filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("连续 4 次 length:provider 共 4 次(1+3),text 末尾含 [输出上限],不再第 5 次", async () => {
    const journal = new MemoryJournal();
    const { llm, calls } = scripted(
      Array.from({ length: 4 }, (_, i) => ({ content: `段${i}`, finishReason: "length" as const })),
    );
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "", llm, tools: [] });
    const out = await loop.runTurn("写长文");

    expect(calls).toHaveLength(4);
    expect(out).toBe(`段0段1段2段3\n\n${LIMIT_WARN}`);
    expect(out.endsWith(LIMIT_WARN)).toBe(true);
    // 警告只加一次,且落账文本与返回一致
    const agents = journal.readAll().filter((e) => e.kind === "message.agent");
    expect(agents).toHaveLength(1);
    expect((agents[0]!.payload as { text: string }).text).toBe(out);
  });

  it("有 toolCalls 的 length:不续写、工具照常执行", async () => {
    const journal = new MemoryJournal();
    const { llm, calls } = scripted([
      { content: "我先查", toolCalls: [{ id: "c1", name: "getTime", arguments: "{}" }], finishReason: "length" },
    ]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "", llm, tools: [getTime], maxSteps: 1 });
    await loop.runTurn("现在几点?");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.some((m) => m.content.includes(PROMPT_HEAD))).toBe(false);
    const toolResults = journal.readAll().filter((e) => e.kind === "tool.result");
    expect(toolResults).toHaveLength(1);
    expect(String((toolResults[0]!.payload as { content: string }).content)).toContain("2026-11-07");
  });

  it("空 text + length:不续写(交给现有 empty-retry)", async () => {
    const journal = new MemoryJournal();
    const { llm, calls } = scripted([{ content: "", finishReason: "length" }]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "", llm, tools: [], maxSteps: 1 });
    await loop.runTurn("hi");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.some((m) => m.content.includes(PROMPT_HEAD))).toBe(false);
  });

  it("finishReason 缺省:行为与旧版逐字一致(单次调用、文本原样)", async () => {
    const journal = new MemoryJournal();
    const { llm, calls } = scripted([{ content: "答案" }]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "", llm, tools: [] });
    const out = await loop.runTurn("问");

    expect(out).toBe("答案");
    expect(calls).toHaveLength(1);
    const agents = journal.readAll().filter((e) => e.kind === "message.agent");
    expect(agents).toHaveLength(1);
    expect(agents[0]!.payload).toEqual(expect.objectContaining({ text: "答案" }));
  });

  it("usage 累加(续写请求的用量并入本步)", async () => {
    const journal = new MemoryJournal();
    const { llm } = scripted([
      { content: "a", finishReason: "length", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      { content: "b", finishReason: "stop", usage: { inputTokens: 20, outputTokens: 7, totalTokens: 27 } },
    ]);
    const loop = new AgentLoop({ journal, sessionId: "s1", system: "", llm, tools: [] });
    const out = await loop.runTurn("x");

    expect(out).toBe("ab");
    const agents = journal.readAll().filter((e) => e.kind === "message.agent");
    expect((agents[0]!.payload as { usage: unknown }).usage).toEqual({ inputTokens: 30, outputTokens: 12, totalTokens: 42 });
  });

  it("取消后不再请求续写", async () => {
    const journal = new MemoryJournal();
    const calls: Message[][] = [];
    let loop!: AgentLoop;
    const llm: LlmProvider = {
      async chat(messages) {
        calls.push(messages);
        if (calls.length === 1) {
          loop.cancel();
          return { content: "截断前", finishReason: "length" };
        }
        return { content: "不该发生的续写", finishReason: "stop" };
      },
    };
    loop = new AgentLoop({ journal, sessionId: "s1", system: "", llm, tools: [] });
    await loop.runTurn("x");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.some((m) => m.content.includes(PROMPT_HEAD))).toBe(false);
  });
});
