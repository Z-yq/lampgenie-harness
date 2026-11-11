/**
 *  openai-provider 流式重试:半截 attempt 作废(attemptId + partialChars)+ 累加器清空。
 * 手法同 stream-midflight-retry.test.ts:stub 全局 fetch 驱动真实 chatStreamed。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { LlmChatAttemptInfo } from "../src/agent/loop";
import type { ModelLifecycleEvent } from "../src/concurrency/admission.js";

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

/** 非 SSE 的整包 JSON 响应(错误信封/成功体);clone 供 postWithRetry 的 peekBody 预览文本。 */
function jsonResponse(body: unknown, status: number): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => text,
    clone: () => ({ text: async () => text }),
  } as unknown as Response;
}

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

  it("401 → 1 次请求即失败、不修复、无 model_repair", async () => {
    const { createOpenAiCompatProvider } = await import("../src/agent/openai-provider.js");
    let call = 0;
    const fake = vi.fn(async () => {
      call++;
      return jsonResponse({ error: { message: "invalid api key" } }, 401);
    });
    vi.stubGlobal("fetch", fake);
    const events: ModelLifecycleEvent[] = [];
    const p = createOpenAiCompatProvider({ baseUrl: "http://x/v1", apiKey: "k", model: "m", retry: 2, onNetworkStatus: (e) => events.push(e) });
    const discards: LlmChatAttemptInfo[] = [];
    await expect(
      p.chat([{ role: "user", content: "hi" }], [], undefined, () => {}, { attemptId: "s:1:1:1", onAttemptDiscarded: (i) => discards.push(i) }),
    ).rejects.toThrow(/401|invalid/);
    expect(call).toBe(1); // auth 永久错误:不重试、不修复
    expect(discards).toHaveLength(0);
    expect(events.filter((e) => e.type === "model_repair")).toHaveLength(0);
  }, 20_000);

  it("400 invalid_request → 修复(max_tokens 夹)后重试一次成功,emit model_repair;不占 retry 预算", async () => {
    const { createOpenAiCompatProvider } = await import("../src/agent/openai-provider.js");
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    const fake = vi.fn(async (_url: string, init: { body: string }) => {
      call++;
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      if (call === 1) return jsonResponse({ error: { message: "invalid request: max_tokens too large" } }, 400);
      return sseStream([
        'data: {"choices":[{"delta":{"content":"修好了"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    });
    vi.stubGlobal("fetch", fake);
    const events: ModelLifecycleEvent[] = [];
    const p = createOpenAiCompatProvider({
      baseUrl: "http://x/v1", apiKey: "k", model: "m", retry: 0, maxTokens: 8192,
      onNetworkStatus: (e) => events.push(e),
    });
    const deltas: string[] = [];
    const out = await p.chat([{ role: "user", content: "hi" }], [], undefined, (d) => { if (d.text) deltas.push(d.text); }, { attemptId: "r1" });
    expect(out.content).toBe("修好了");
    expect(call).toBe(2); // retry:0 也照样修一次重发——修复重发不占 provider retry 预算
    expect(bodies[0]!.max_tokens).toBe(8192);
    expect(bodies[1]!.max_tokens).toBe(4096); // clamp-max-tokens 生效,重发用修复后的新体
    expect(bodies[1]!.stream).toBe(true);
    const repairs = events.filter((e) => e.type === "model_repair");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ code: "invalid_request" });
    expect(repairs[0]!.actions).toContain("clamp-max-tokens");
  }, 20_000);

  it("连续两次 400 invalid_request → 只修复一次,第二次抛且注明「修复后仍失败」", async () => {
    const { createOpenAiCompatProvider } = await import("../src/agent/openai-provider.js");
    let call = 0;
    const fake = vi.fn(async () => {
      call++;
      return jsonResponse({ error: { message: "invalid request: unsupported field" } }, 400);
    });
    vi.stubGlobal("fetch", fake);
    const events: ModelLifecycleEvent[] = [];
    const p = createOpenAiCompatProvider({
      baseUrl: "http://x/v1", apiKey: "k", model: "m", retry: 2, maxTokens: 8192,
      onNetworkStatus: (e) => events.push(e),
    });
    await expect(
      p.chat([{ role: "user", content: "hi" }], [], undefined, () => {}, { attemptId: "d1" }),
    ).rejects.toThrow(/修复后仍失败/);
    expect(call).toBe(2); // 原始 1 + 修复后重发 1;第二败即终态,不再按 retry 预算重试
    const repairs = events.filter((e) => e.type === "model_repair");
    expect(repairs).toHaveLength(1); // 同 reason 每次请求只修一次
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
