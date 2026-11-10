import { describe, it, expect, vi } from "vitest";
import { createStreamRelay } from "../src/stream-relay.js";

describe("stream-relay(step-050)", () => {
  it("llm-delta 合批(80ms 窗内多块→一条);控制事件先冲刷待发增量再直发(保序)", async () => {
    vi.useFakeTimers();
    const sent: Record<string, unknown>[] = [];
    const relay = createStreamRelay((m) => sent.push(m));
    relay.push("s1", { type: "llm-begin" });
    relay.push("s1", { type: "llm-delta", text: "你" });
    relay.push("s1", { type: "llm-delta", text: "好" });
    relay.push("s1", { type: "llm-delta", reasoning: "想" });
    // 定时器未到:begin 已直发,delta 仍在合批窗内
    expect(sent).toEqual([{ v: 1, type: "stream", sessionId: "s1", ev: { type: "llm-begin" } }]);
    // 控制事件(tool-begin)到达→先冲刷聚合 delta 再发控制,顺序不乱
    relay.push("s1", { type: "tool-begin", callId: "c1", name: "getTime" });
    expect(sent).toEqual([
      { v: 1, type: "stream", sessionId: "s1", ev: { type: "llm-begin" } },
      { v: 1, type: "stream", sessionId: "s1", ev: { type: "llm-delta", text: "你好", reasoning: "想" } },
      { v: 1, type: "stream", sessionId: "s1", ev: { type: "tool-begin", callId: "c1", name: "getTime" } },
    ]);
    // 窗到时:无残留不再发
    vi.advanceTimersByTime(120);
    expect(sent).toHaveLength(3);
    relay.close();
    vi.useRealTimers();
  });

  it("窗到自动冲刷;会话间互不串扰", async () => {
    vi.useFakeTimers();
    const sent: Record<string, unknown>[] = [];
    const relay = createStreamRelay((m) => sent.push(m));
    relay.push("sA", { type: "llm-delta", text: "A" });
    relay.push("sB", { type: "llm-delta", text: "B" });
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([
      { v: 1, type: "stream", sessionId: "sA", ev: { type: "llm-delta", text: "A" } },
      { v: 1, type: "stream", sessionId: "sB", ev: { type: "llm-delta", text: "B" } },
    ]);
    relay.close();
    vi.useRealTimers();
  });
});
