/**
 * M29 流中断安全锚点恢复:纯函数层 + loop 接线(10 次上限 / 冷恢复过滤)。
 * 口径见 src/agent/stream-anchor.ts 文件头。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import {
  classifyStreamRetry,
  filterDiscarded,
  findSafeAnchor,
  isRetryableStreamError,
  markDiscard,
  STREAM_DISCARD_WHAT,
  STREAM_REOPEN_MAX,
} from "../src/agent/stream-anchor";
import { AgentLoop, deriveMessages, type LlmProvider } from "../src/agent/loop";

let seq = 0;
const ev = (kind: string, payload: Record<string, unknown> = {}) => ({ seq: ++seq, time: 0, sessionId: "s", kind, payload });

describe("findSafeAnchor", () => {
  it("有完整 tool batch:锚点=最后一个 tool 结果", () => {
    const events = [
      ev("message.user", { text: "q1" }),
      ev("message.agent", { text: "", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] }),
      ev("tool.result", { toolCallId: "c1", content: "ok" }),
      ev("step.start", { step: 2 }),
    ];
    const a = findSafeAnchor(events);
    expect(a).toMatchObject({ kind: "tool-batch", complete: true, index: 2 });
    expect(a!.seq).toBe(events[2]!.seq);
  });

  it("无 tool batch:锚点=最后一个 message.user", () => {
    const events = [ev("message.user", { text: "q1" }), ev("message.agent", { text: "答" }), ev("message.user", { text: "q2" })];
    const a = findSafeAnchor(events);
    expect(a).toMatchObject({ kind: "user", complete: true, index: 2 });
  });

  it("toolCalls 缺结果=锚点不完整(不猜)", () => {
    const events = [
      ev("message.user", { text: "q1" }),
      ev("message.agent", { text: "", toolCalls: [{ id: "c1" }, { id: "c2" }] }),
      ev("tool.result", { toolCallId: "c1", content: "ok" }),
    ];
    const a = findSafeAnchor(events);
    expect(a).toMatchObject({ kind: "tool-batch", complete: false });
    expect(a!.reason).toContain("c2");
  });

  it("Message[] 形态同样可算(无 seq 时 seq=index);全空=null", () => {
    const a = findSafeAnchor([
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1" }] },
      { role: "tool", toolCallId: "c1", content: "ok" },
    ]);
    expect(a).toMatchObject({ kind: "tool-batch", complete: true, index: 2 });
    expect(findSafeAnchor([])).toBeNull();
  });
});

describe("classifyStreamRetry / isRetryableStreamError", () => {
  it("5xx / 网络断流 / 超时 / EPIPE / provider abort → 可重试", () => {
    for (const msg of [
      "LLM 500: upstream reset",
      "socket hang up",
      "read ECONNRESET",
      "connect EPIPE",
      "MODEL_STREAM_IDLE_TIMEOUT",
      "stream timeout",
      "Inference engine abort. Finish reason: [UNKNOWN].",
    ]) {
      expect(isRetryableStreamError(new Error(msg)), msg).toBe(true);
    }
    expect(classifyStreamRetry(new Error("LLM 502: bad gateway")).reason).toBe("http-502");
  });

  it("4xx(参数/鉴权/policy)与取消 → 不可重试", () => {
    for (const msg of ["LLM 400: invalid tool schema", "LLM 401: bad key", "HTTP 403 forbidden", "HTTP 422 unprocessable"]) {
      expect(isRetryableStreamError(new Error(msg)), msg).toBe(false);
    }
    expect(classifyStreamRetry(new Error("cancelled:write-barrier")).retryable).toBe(false);
    // policy 面(结构化 decision)优先于文本
    expect(classifyStreamRetry({ retryable: false, kind: "invalid_request", message: "LLM 500: fake" })).toMatchObject({
      retryable: false,
      reason: "policy:invalid_request",
    });
  });

  it("未知错误 → 可重试但 reason 记 unknown(留痕可追)", () => {
    const d = classifyStreamRetry(new Error("weird thing happened"));
    expect(d.retryable).toBe(true);
    expect(d.reason).toContain("unknown:");
  });
});

describe("markDiscard / filterDiscarded", () => {
  it("落账形状正确,同 attemptId 幂等", () => {
    const journal = new MemoryJournal();
    const anchor = { index: 1, seq: 7, kind: "tool-batch" as const, complete: true };
    const input = { attemptId: "a1", turn: 1, step: 2, anchor, reason: "http-500: boom", partialChars: 12 };
    expect(markDiscard(journal, "s", input)).toBe(true);
    expect(markDiscard(journal, "s", input)).toBe(false);
    const marked = journal.readSession("s").filter((e) => e.kind === "custom");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.payload).toMatchObject({
      what: STREAM_DISCARD_WHAT,
      attemptId: "a1",
      turn: 1,
      step: 2,
      anchorSeq: 7,
      anchorKind: "tool-batch",
      reason: "http-500: boom",
      partialChars: 12,
    });
  });

  it("被作废 attempt 的 message.agent 与 stream 增量被剔除,tool.result 保留;无标记时原样返回", () => {
    const events = [
      ev("message.user", { text: "q" }),
      ev("message.agent", { text: "半截", attemptId: "dead" }),
      ev("custom", { what: "stream.delta", attemptId: "dead", text: "半截" }),
      ev("tool.result", { toolCallId: "c1", content: "ok" }),
      ev("message.agent", { text: "好", attemptId: "live" }),
    ];
    expect(filterDiscarded(events)).toHaveLength(5); // 无作废标记:零变化
    const marked = [...events, ev("custom", { what: STREAM_DISCARD_WHAT, attemptId: "dead" })];
    const kept = filterDiscarded(marked);
    expect(kept.some((e) => e.kind === "message.agent" && (e.payload as { text: string }).text === "半截")).toBe(false);
    expect(kept.some((e) => e.kind === "custom" && (e.payload as { what: string }).what === "stream.delta")).toBe(false);
    expect(kept.some((e) => e.kind === "tool.result")).toBe(true);
    expect(kept.some((e) => e.kind === "message.agent" && (e.payload as { text: string }).text === "好")).toBe(true);
  });

  it("deriveMessages:作废 message.agent 不进上下文,tool.result 保留,未作废会话零变化", () => {
    const journal = new MemoryJournal();
    journal.append({ kind: "message.user", sessionId: "s1", payload: { text: "q" } });
    journal.append({ kind: "message.agent", sessionId: "s1", payload: { text: "半截", attemptId: "a1" } });
    journal.append({ kind: "message.agent", sessionId: "s1", payload: { text: "", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }], attemptId: "a2" } });
    journal.append({ kind: "tool.result", sessionId: "s1", payload: { toolCallId: "c1", content: "工具结果" } });
    journal.append({ kind: "message.agent", sessionId: "s1", payload: { text: "最终答复", attemptId: "a3" } });
    journal.append({ kind: "message.user", sessionId: "s2", payload: { text: "别的会话" } });
    journal.append({ kind: "message.agent", sessionId: "s2", payload: { text: "别的答复", attemptId: "b1" } });

    const before2 = deriveMessages(journal, "s2");
    markDiscard(journal, "s1", { attemptId: "a1", turn: 1, step: 1, anchor: null, reason: "http-500", partialChars: 2 });

    const s1 = deriveMessages(journal, "s1");
    expect(s1.some((m) => m.role === "assistant" && m.content === "半截")).toBe(false);
    expect(s1.some((m) => m.role === "assistant" && m.content === "最终答复")).toBe(true);
    expect(s1.some((m) => m.role === "tool" && m.content === "工具结果")).toBe(true);
    expect(deriveMessages(journal, "s2")).toEqual(before2); // 别的会话零变化
  });
});

describe("AgentLoop 流中断重开", () => {
  it("首次流错误 → 作废 1 条并从锚点重开,成功消息只落一次", async () => {
    const journal = new MemoryJournal();
    let calls = 0;
    const llm: LlmProvider = {
      async chat() {
        calls++;
        if (calls === 1) throw new Error("socket hang up");
        return { content: "第二段", attemptId: "s9:1:1:2" };
      },
    };
    const loop = new AgentLoop({ journal, sessionId: "s9", system: "sys", llm, tools: [] });
    await expect(loop.runTurn("hi")).resolves.toBe("第二段");
    expect(calls).toBe(2);
    const discarded = journal.readSession("s9").filter((e) => e.kind === "custom" && (e.payload as { what?: string }).what === STREAM_DISCARD_WHAT);
    expect(discarded).toHaveLength(1);
    expect(discarded[0]!.payload).toMatchObject({ reason: expect.stringContaining("network"), anchorKind: "user" });
    const agents = journal.readSession("s9").filter((e) => e.kind === "message.agent");
    expect(agents).toHaveLength(1);
    expect((agents[0]!.payload as { attemptId?: string }).attemptId).toBe("s9:1:1:2");
    expect(deriveMessages(journal, "s9").map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("连续 11 次 500:抛错且 discarded 恰好 10 条(每轮上限)", async () => {
    const journal = new MemoryJournal();
    let calls = 0;
    const llm: LlmProvider = {
      async chat() {
        calls++;
        throw new Error("LLM 500: stream broken");
      },
    };
    const loop = new AgentLoop({ journal, sessionId: "s10", system: "sys", llm, tools: [] });
    await expect(loop.runTurn("hi")).rejects.toThrow(/LLM 500/);
    expect(calls).toBe(STREAM_REOPEN_MAX + 1);
    const discarded = journal.readSession("s10").filter((e) => e.kind === "custom" && (e.payload as { what?: string }).what === STREAM_DISCARD_WHAT);
    expect(discarded).toHaveLength(STREAM_REOPEN_MAX);
  });
});
