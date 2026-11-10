import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, type AgentStreamEvent, type LlmProvider, type Tool, type Message, type LlmDeltaChunk } from "../src/agent/loop";

/** Mock LLM(流式形态):第一轮增量输出+工具调用,第二轮增量输出终稿。 */
function streamingLlm(): LlmProvider {
  let round = 0;
  return {
    async chat(_messages: Message[], _tools: Tool[], _signal?: AbortSignal, onDelta?: (d: LlmDeltaChunk) => void) {
      round++;
      if (round === 1) {
        onDelta?.({ text: "我先" });
        onDelta?.({ text: "查时间" });
        onDelta?.({ reasoning: "用户问时间,调工具" });
        return { content: "我先查时间", toolCalls: [{ id: "call-1", name: "getTime", arguments: "{}" }] };
      }
      onDelta?.({ text: "现在是" });
      onDelta?.({ text: "20:00" });
      return { content: "现在是20:00" };
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

describe("AgentLoop 流式旁路", () => {
  it("onStream 事件序:llm-begin→delta→llm-end→tool-begin/end;不落 journal", async () => {
    const journal = new MemoryJournal();
    const events: AgentStreamEvent[] = [];
    const loop = new AgentLoop({
      journal, sessionId: "s1", system: "你是助手", llm: streamingLlm(), tools: [getTime],
      onStream: (e) => events.push(e),
    });
    const out = await loop.runTurn("几点了?");
    expect(out).toBe("现在是20:00");
    const types = events.map((e) => e.type);
    // 两个 step 各一组 llm-begin/delta/end,中间夹工具起止
    expect(types).toEqual([
      "llm-begin", "llm-delta", "llm-delta", "llm-delta", "llm-end",
      "tool-begin", "tool-end",
      "llm-begin", "llm-delta", "llm-delta", "llm-end",
    ]);
    // llm-end 携带聚合终稿(面板终稿替换依据)
    const ends = events.filter((e) => e.type === "llm-end") as { type: "llm-end"; text: string }[];
    expect(ends[0]!.text).toBe("我先查时间");
    expect(ends[1]!.text).toBe("现在是20:00");
    // delta 内容透传
    const deltas = events.filter((e) => e.type === "llm-delta") as { type: "llm-delta"; text?: string; reasoning?: string }[];
    expect(deltas.map((d) => d.text ?? d.reasoning)).toEqual(["我先", "查时间", "用户问时间,调工具", "现在是", "20:00"]);
    // 工具起止配对
    const tb = events.find((e) => e.type === "tool-begin") as { type: "tool-begin"; callId: string; name: string };
    const te = events.find((e) => e.type === "tool-end") as { type: "tool-end"; callId: string; name: string; durationMs: number };
    expect(tb.callId).toBe(te.callId);
    expect(te.name).toBe("getTime");
    // 旁路不落 journal:持久层事件种类不含流事件
    expect(journal.readAll().every((e) => !String(e.kind).startsWith("llm."))).toBe(true);
  });

  it("onStream 缺省(未注入)时 provider 的 onDelta 不炸、照常完成", async () => {
    const journal = new MemoryJournal();
    const loop = new AgentLoop({ journal, sessionId: "s2", system: "s", llm: streamingLlm(), tools: [getTime] });
    const out = await loop.runTurn("几点了?");
    expect(out).toBe("现在是20:00");
  });
});
