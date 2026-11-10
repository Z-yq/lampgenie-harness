/**
 * thinking 模式 reasoning_content 回传(2026-11 修复):
 * provider 对缺 reasoning_content 的 assistant 历史直接 400;deriveMessages 必须保留,
 * openai 序列化必须回传。本文件锁死这两处,防回归。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, deriveMessages, type Tool } from "../src/agent/loop";
import { createOpenAiCompatProvider } from "../src/agent/openai-provider";

function jsonResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();
afterEach(() => {
  fetchMock.mockReset();
  (globalThis as { fetch?: unknown }).fetch = undefined;
});

describe("reasoning_content 回传", () => {
  it("deriveMessages 保留 message.agent.payload.reasoning;旧 journal 无字段则不带", () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s", payload: { text: "hi" } });
    j.append({ kind: "message.agent", sessionId: "s", payload: { text: "a1", reasoning: "think-1" } });
    j.append({ kind: "message.agent", sessionId: "s", payload: { text: "a2" } });
    const msgs = deriveMessages(j, "s");
    const assistants = msgs.filter((m) => m.role === "assistant") as { text?: string; content: string; reasoning?: string }[];
    expect(assistants[0]!.reasoning).toBe("think-1");
    expect(assistants[1]!.reasoning).toBeUndefined();
    expect("reasoning" in assistants[1]!).toBe(false);
  });

  it("assistant 带 reasoning → 请求体含 reasoning_content;不带则无该字段", async () => {
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    fetchMock.mockResolvedValue(jsonResponse("ok"));
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1" });
    await p.chat([
      { role: "user", content: "hi" },
      { role: "assistant", content: "a1", reasoning: "think-1" },
      { role: "assistant", content: "a2" },
    ], []);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.messages[1].reasoning_content).toBe("think-1");
    expect("reasoning_content" in body.messages[2]).toBe(false);
  });

  it("assistant + toolCalls 且带 reasoning → 同样回传", async () => {
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    fetchMock.mockResolvedValue(jsonResponse("ok"));
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1" });
    await p.chat([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", reasoning: "think-2", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] },
      { role: "tool", toolCallId: "c1", content: "r" },
    ], []);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.messages[1].reasoning_content).toBe("think-2");
    expect(body.messages[1].tool_calls[0].id).toBe("c1");
  });
});

describe("一轮 loop 续跑(真 provider + fake fetch)", () => {
  const getTime: Tool = {
    name: "getTime",
    description: "取时间",
    parameters: { type: "object", properties: {} },
    isConcurrencySafe: () => true,
    async execute() { return "10:00"; },
  };

  it("首步返回 reasoning + tool_call → 第二次请求的 assistant 带 reasoning_content", async () => {
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const bodies: { messages: Record<string, unknown>[] }[] = [];
    fetchMock.mockImplementation(async (_url: string, init: { body?: string }) => {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) {
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: "tool_calls",
            message: {
              content: null,
              reasoning_content: "先查时间",
              tool_calls: [{ id: "c1", type: "function", function: { name: "getTime", arguments: "{}" } }],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return jsonResponse("现在 10:00");
    });
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "s-loop", system: "sys", tools: [getTime], maxSteps: 3,
      llm: createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1" }),
    });
    const out = await loop.runTurn("几点了");
    expect(out).toContain("10:00");
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    const second = bodies[1]!.messages;
    const asst = second.find((m) => m.role === "assistant")!;
    expect(asst.reasoning_content).toBe("先查时间");
    expect((asst.tool_calls as { id: string }[])[0]!.id).toBe("c1");
    // 零回归:全部消息里没有 reasoning 的那条不带字段(此处只有一条 assistant,带值;
    // 非 thinking 路径的「字段不存在」由上一条用例的 a2 覆盖)。
  });

  it("非 thinking 响应(无 reasoning):续跑请求体不出现 reasoning_content", async () => {
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const bodies: { messages: Record<string, unknown>[] }[] = [];
    fetchMock.mockImplementation(async (_url: string, init: { body?: string }) => {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) {
        return new Response(JSON.stringify({
          choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "getTime", arguments: "{}" } }] } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return jsonResponse("好的");
    });
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "s-nothink", system: "sys", tools: [getTime], maxSteps: 3,
      llm: createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1" }),
    });
    await loop.runTurn("几点了");
    const second = bodies[1]!.messages;
    const asst = second.find((m) => m.role === "assistant")!;
    expect("reasoning_content" in asst).toBe(false);
  });
});