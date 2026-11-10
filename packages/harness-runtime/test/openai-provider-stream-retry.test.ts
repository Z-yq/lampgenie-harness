/**
 *  openai-provider 流式重试:半截 attempt 作废(attemptId + partialChars)+ 累加器清空。
 * 手法同 stream-midflight-retry.test.ts:stub 全局 fetch 驱动真实 chatStreamed。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { LlmChatAttemptInfo } from "../src/agent/loop";

const enc = new TextEncoder();

/** SSE 响应:按序吐 chunks;chunk 为 Error 时在流中途抛错(模拟断流)。 */
function sseStream(chunks: (string | Error)[]) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= chunks.length) return { done: true, value: undefined };
          const c = chunks[i++]!;
          if (c instanceof Error) throw c;
          return { done: false, value: enc.encode(c) };
        },
      }),
    } as never,
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe(" openai-provider 流式重试", () => {
  it("半截后 500 断流 → 第二次成功:content 只含第二段,作废回调 1 次(reason 含 500)", async () => {
    const { createOpenAiCompatProvider } = await import("../src/agent/openai-provider.js");
    let call = 0;
    const fake = vi.fn(async () => {
      call++;
      if (call === 1) {
        return sseStream([
          'data: {"choices":[{"delta":{"reasoning_content":"思考半截"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n',
          new Error("LLM 500: upstream reset"),
        ]);
      }
      return sseStream([
        'data: {"choices":[{"delta":{"content":"第二段"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"完整思考"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    });
    vi.stubGlobal("fetch", fake);
    const p = createOpenAiCompatProvider({ baseUrl: "http://x/v1", apiKey: "k", model: "m", retry: 1 });
    const discards: LlmChatAttemptInfo[] = [];
    const deltas: string[] = [];
    const out = await p.chat(
      [{ role: "user", content: "hi" }],
      [],
      undefined,
      (d) => { if (d.text) deltas.push(d.text); },
      { attemptId: "s:1:1:1", onAttemptDiscarded: (i) => discards.push(i) },
    );
    expect(out.content).toBe("第二段"); // 不与第一段拼接(累加器每次 attempt 清空)
    expect(out.reasoning).toBe("完整思考"); // reasoning 不重复
    expect(out.attemptId).toBe("s:1:1:1#1"); // 成功的是重试 attempt
    expect(fake).toHaveBeenCalledTimes(2);
    expect(discards).toHaveLength(1);
    expect(discards[0]).toMatchObject({ attemptId: "s:1:1:1", attempt: 0 });
    expect(discards[0]!.reason).toContain("500");
    expect(discards[0]!.partialChars).toBe("思考半截第一段".length);
    expect(deltas).toEqual(["第一段", "第二段"]); // 面板增量按到达序透出,聚合只采信成功 attempt
  }, 20_000);

  it("4xx → 不重试、无作废回调", async () => {
    const { createOpenAiCompatProvider } = await import("../src/agent/openai-provider.js");
    let call = 0;
    const fake = vi.fn(async () => {
      call++;
      return {
        ok: false,
        status: 400,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => '{"error":{"message":"invalid tool schema"}}',
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fake);
    const p = createOpenAiCompatProvider({ baseUrl: "http://x/v1", apiKey: "k", model: "m", retry: 2 });
    const discards: LlmChatAttemptInfo[] = [];
    await expect(
      p.chat([{ role: "user", content: "hi" }], [], undefined, () => {}, { attemptId: "s:1:1:1", onAttemptDiscarded: (i) => discards.push(i) }),
    ).rejects.toThrow(/400|invalid/);
    expect(call).toBe(1);
    expect(discards).toHaveLength(0);
  }, 20_000);

  it("重试耗尽仍失败:错误消息注明尝试次数,每次将重试的 attempt 都留作废", async () => {
    const { createOpenAiCompatProvider } = await import("../src/agent/openai-provider.js");
    const fake = vi.fn(async () => sseStream(['data: {"error":{"message":"Inference engine abort. Finish reason: [UNKNOWN]."}}\n\n']));
    vi.stubGlobal("fetch", fake);
    const p = createOpenAiCompatProvider({ baseUrl: "http://x/v1", apiKey: "k", model: "m", retry: 2 });
    const discards: LlmChatAttemptInfo[] = [];
    await expect(
      p.chat([{ role: "user", content: "hi" }], [], undefined, () => {}, { attemptId: "b", onAttemptDiscarded: (i) => discards.push(i) }),
    ).rejects.toThrow(/Inference engine abort[\s\S]*流式尝试 3 次/);
    expect(fake).toHaveBeenCalledTimes(3); // 1 原始 + 2 重试
    expect(discards.map((d) => d.attemptId)).toEqual(["b", "b#1"]); // 最后一次 attempt 不在 provider 内重试,由 loop 层
  }, 20_000);
});
