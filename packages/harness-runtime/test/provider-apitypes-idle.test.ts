import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createOpenAiCompatProvider,
  createStreamIdleGuard,
  STREAM_IDLE_DEFAULT_MS,
  STREAM_IDLE_FLOOR_MS,
  STREAM_IDLE_TIMEOUT_REASON,
} from "../src/agent/openai-provider";

/**
 * 流空闲超时:anthropic/responses 适配器此前只有外层整体墙钟(chat 里
 * max(timeoutMs, 30min) 的宽松上限),与 chat 流式分支的「空闲窗」语义不一致——大上下文 prefill
 * 数分钟属健康慢流,墙钟误杀(observe3 AbortError 根因)。本文件锁两件事:
 * ① guard 语义(窗口=max(30s, timeoutMs ?? 600s);chunk 到达重置;dispose 取消;abort 原因);
 * ② 两个适配器真的把 guard 接进了 SSE 读循环(停流超窗 abort / 慢流不断流)。
 * 假定时器推进(不真等 30s):流由 setTimeout 驱动 enqueue,与 guard 计时同处假时间轴。
 */

/** SSE 响应:chunk 由假定时器投递;投递完不 close=停滞(真实「流卡住」现场)。 */
function timedSse(plan: { at?: number; chunk?: unknown }[], opts: { closeAfterMs?: number } = {}) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) {
      for (const p of plan) {
        const send = () => c.enqueue(enc.encode("data: " + JSON.stringify(p.chunk) + "\n\n"));
        if (p.at && p.at > 0) setTimeout(send, p.at);
        else send();
      }
      if (opts.closeAfterMs !== undefined) setTimeout(() => c.close(), opts.closeAfterMs);
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const fetchMock = vi.fn();

afterEach(() => {
  fetchMock.mockReset();
  (globalThis as { fetch?: unknown }).fetch = undefined;
  vi.useRealTimers();
});

function installFetch() {
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
}

describe("流空闲超时 guard(与 chatStreamed 同源语义)", () => {
  it("窗口=max(30s, timeoutMs);缺省 600s;arm 重置;超窗 abort 原因 MODEL_STREAM_IDLE_TIMEOUT", async () => {
    vi.useFakeTimers();
    const reasons: unknown[] = [];
    const g = createStreamIdleGuard(undefined, (r) => reasons.push(r));
    expect(g.idleMs).toBe(STREAM_IDLE_DEFAULT_MS);
    g.arm();
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_DEFAULT_MS - 1);
    expect(reasons).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(reasons).toHaveLength(1);
    expect(String((reasons[0] as Error).message)).toBe(STREAM_IDLE_TIMEOUT_REASON);
    g.dispose();
  });

  it("低于下限按 30s 计;dispose 后到点不再 abort", async () => {
    vi.useFakeTimers();
    const reasons: unknown[] = [];
    const g = createStreamIdleGuard(5_000, (r) => reasons.push(r));
    expect(g.idleMs).toBe(STREAM_IDLE_FLOOR_MS); // 下限兜底:窗口不得小于 30s
    g.arm();
    await vi.advanceTimersByTimeAsync(20_000);
    g.arm(); // chunk 到达=重置(已过 20s 仍不超窗)
    await vi.advanceTimersByTimeAsync(29_000);
    expect(reasons).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reasons).toHaveLength(1);
    const g2 = createStreamIdleGuard(30_000, (r) => reasons.push(r));
    g2.arm();
    g2.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reasons).toHaveLength(1); // dispose 取消了计时
  });

  it("显式 timeoutMs 大于下限时按其值(45s 不到点不 abort)", async () => {
    vi.useFakeTimers();
    const reasons: unknown[] = [];
    const g = createStreamIdleGuard(45_000, (r) => reasons.push(r));
    expect(g.idleMs).toBe(45_000);
    g.arm();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reasons).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reasons).toHaveLength(1);
  });
});

describe("anthropic 适配器流空闲超时", () => {
  it("响应头后无 chunk → 空闲窗到点 abort(原因 MODEL_STREAM_IDLE_TIMEOUT)", async () => {
    vi.useFakeTimers();
    installFetch();
    fetchMock.mockResolvedValue(timedSse([], {})); // 建流后一个 chunk 都不发=停滞
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1", apiType: "anthropic", timeoutMs: 30_000 });
    const pending = p.chat([{ role: "user", content: "hi" }], [], undefined, () => {});
    const guarded = pending.then(() => "resolved", (e: Error) => String(e.message));
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(guarded).resolves.toBe(STREAM_IDLE_TIMEOUT_REASON);
  });

  it("chunk 间隔小于窗口 → 慢流不被杀,聚合正常返回", async () => {
    vi.useFakeTimers();
    installFetch();
    fetchMock.mockResolvedValue(timedSse(
      [
        { chunk: { type: "message_start", message: { usage: { input_tokens: 3 } } } },
        { at: 20_000, chunk: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "慢" } } },
        { at: 40_000, chunk: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "流" } } },
        { at: 60_000, chunk: { type: "message_delta", usage: { output_tokens: 2 } } },
      ],
      { closeAfterMs: 60_010 }, // 全程无任何单次停顿超过 30s 窗));
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1", apiType: "anthropic", timeoutMs: 30_000 });
    const deltas: { text?: string }[] = [];
    const pending = p.chat([{ role: "user", content: "hi" }], [], undefined, (d) => deltas.push(d));
    await vi.advanceTimersByTimeAsync(70_000);
    const r = await pending;
    expect(r.content).toBe("慢流");
    expect(deltas).toEqual([{ text: "慢" }, { text: "流" }]);
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  });
});

describe("responses 适配器流空闲超时", () => {
  it("响应头后无 chunk → 空闲窗到点 abort(原因 MODEL_STREAM_IDLE_TIMEOUT)", async () => {
    vi.useFakeTimers();
    installFetch();
    fetchMock.mockResolvedValue(timedSse([], {}));
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1", apiType: "responses", timeoutMs: 30_000 });
    const guarded = p.chat([{ role: "user", content: "hi" }], [], undefined, () => {}).then(() => "resolved", (e: Error) => String(e.message));
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(guarded).resolves.toBe(STREAM_IDLE_TIMEOUT_REASON);
  });

  it("chunk 间隔小于窗口 → 慢流不被杀,聚合正常返回", async () => {
    vi.useFakeTimers();
    installFetch();
    fetchMock.mockResolvedValue(timedSse(
      [
        { chunk: { type: "response.output_text.delta", delta: "慢" } },
        { at: 20_000, chunk: { type: "response.output_text.delta", delta: "流" } },
        { at: 45_000, chunk: { type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } } },
      ],
      { closeAfterMs: 45_010 },
    ));
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1", apiType: "responses", timeoutMs: 30_000 });
    const pending = p.chat([{ role: "user", content: "hi" }], [], undefined, () => {});
    await vi.advanceTimersByTimeAsync(50_000);
    const r = await pending;
    expect(r.content).toBe("慢流");
    expect(r.usage?.totalTokens).toBe(6);
  });
});