/**
 *  用户停止语义专项。
 * 锚定:
 * ① 用户停止(task.cancel / user-stop)→ 工具结果固定文案「[用户已停止]…」,模型不再收到 [aborted];
 * ② 内部取消/测试 cancel/超时 → 旧 [aborted] / 超时错误框语义一字不变;
 * ③ 判定通道两条:signal.reason 关键词 + loop 实例 cancel 记账(工具没拿 signal 时)。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, USER_STOPPED_TOOL_TEXT, isUserStopAbort, type LlmProvider, type Tool, type ToolCall } from "../src/agent/loop";

const ABORTED_TEXT = "[aborted] 执行被取消";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 执行中阻塞、直到 signal 被 abort 后抛错的工具(模拟「工具正在跑,用户点停止」)。 */
function blockingTool(onStart: () => void): Tool {
  return {
    name: "slow",
    description: "慢工具",
    parameters: { type: "object", properties: {} },
    async execute(_args, signal) {
      onStart();
      for (let i = 0; i < 200; i++) {
        if (signal?.aborted) throw new Error("aborted");
        await sleep(5);
      }
      return "done";
    },
  };
}

function llmOnce(calls: ToolCall[]): LlmProvider {
  let round = 0;
  return {
    async chat() {
      round++;
      if (round === 1) return { content: "调工具", toolCalls: calls };
      return { content: "结束" };
    },
  };
}

describe(" isUserStopAbort(取消原因判定)", () => {
  it("task.cancel / user-stop 判为用户停止;测试 cancel / 内部 abort 不算", () => {
    const a = new AbortController();
    a.abort(new Error("cancelled:task.cancel"));
    expect(isUserStopAbort(a.signal)).toBe(true);
    const b = new AbortController();
    b.abort(new Error("cancelled:user-stop"));
    expect(isUserStopAbort(b.signal)).toBe(true);
    const c = new AbortController();
    c.abort(new Error("cancelled:test-cancel"));
    expect(isUserStopAbort(c.signal)).toBe(false);
    const d = new AbortController();
    expect(isUserStopAbort(d.signal)).toBe(false); // 未 abort
    d.abort();
    expect(isUserStopAbort(d.signal)).toBe(false); // 裸 abort 无 reason
  });
});

describe(" 工具结果文案", () => {
  it("用户停止(task.cancel):tool.result 固定停止文案,origin 仍 aborted", async () => {
    const journal = new MemoryJournal();
    let started!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    const loop = new AgentLoop({
      journal, sessionId: "m34-a", system: "s",
      llm: llmOnce([{ id: "c1", name: "slow", arguments: "{}" }]),
      tools: [blockingTool(started)],
      maxSteps: 2,
      writeBarrier: "off",
    });
    const p = loop.runTurn("跑");
    await startedP;
    loop.cancel("task.cancel");
    await p;
    const res = journal.readAll().find((e) => e.kind === "tool.result")!;
    const payload = res.payload as { content: string; error?: { origin: string } };
    expect(payload.content).toBe(USER_STOPPED_TOOL_TEXT);
    expect(payload.content).toContain("不要继续执行");
    expect(payload.content).toContain("不要重试");
    expect(payload.content).not.toContain("[aborted]");
    expect(payload.error?.origin).toBe("aborted");
    // 模型侧历史同样只看到停止文案
    const llmMsgs = journal.readAll().filter((e) => e.kind === "message.agent");
    expect(llmMsgs.length).toBe(1); // 取消后不再发起第二次 LLM 请求
  });

  it("普通取消(cancel 缺省 reason):仍是 [aborted] 旧语义", async () => {
    const journal = new MemoryJournal();
    let started!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    const loop = new AgentLoop({
      journal, sessionId: "m34-b", system: "s",
      llm: llmOnce([{ id: "c1", name: "slow", arguments: "{}" }]),
      tools: [blockingTool(started)],
      maxSteps: 2,
      writeBarrier: "off",
    });
    const p = loop.runTurn("跑");
    await startedP;
    loop.cancel();
    await p;
    const payload = journal.readAll().find((e) => e.kind === "tool.result")!.payload as { content: string };
    expect(payload.content).toBe(ABORTED_TEXT);
  });

  it("工具超时不是用户停止:保持超时错误框语义", async () => {
    const journal = new MemoryJournal();
    const slow: Tool = {
      name: "tick",
      description: "超过时间帽",
      parameters: { type: "object", properties: {} },
      timeoutMs: 20,
      async execute() { await sleep(120); return "done"; },
    };
    const loop = new AgentLoop({
      journal, sessionId: "m34-c", system: "s",
      llm: llmOnce([{ id: "c1", name: "tick", arguments: "{}" }]),
      tools: [slow],
      maxSteps: 2,
      writeBarrier: "off",
    });
    await loop.runTurn("跑");
    const payload = journal.readAll().find((e) => e.kind === "tool.result")!.payload as { content: string; error?: { origin: string } };
    expect(payload.content).toContain("错误:工具执行超时");
    expect(payload.error?.origin).toBe("timeout");
    expect(payload.content).not.toBe(USER_STOPPED_TOOL_TEXT);
  });
});
