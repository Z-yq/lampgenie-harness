/**
 * 流中途错误重试(注意:任务因 "Inference engine abort. Finish reason: [UNKNOWN]" 整体失败)。
 * 根因:该错误在 SSE data 的 error 对象里,HTTP 状态是 200——现有 postWithRetry 只重试
 * 429/5xx 状态码,流内错误直达 chat() 调用方 → AgentLoop 抛出 → task.fail。
 * 修复:StreamMidFlightError + chatStreamedWithRetry(指数退避,最多 min(retry,3) 次)。
 * 本测试直接驱动 chatStreamedWithRetry:注入 fake chatStreamed 不可行(模块内函数)——
 * 改为对导出面做行为验证:构造 provider,fake fetch 返回 SSE 流,第一次中途 error、第二次正常。
 */
import { describe, it, expect, vi } from "vitest";

// 通过 mock 全局 fetch 驱动真实 chatStreamed:第一次返回 SSE(先发一点 delta 再发 error),第二次正常 SSE。
function sseRes(chunks: string[]) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }),
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]!) } : { done: true, value: undefined }) }) } as never,
  } as unknown as Response;
}

describe("流中途 error 重试", () => {
  it("第一次流内 Inference engine abort → 自动重试第二次成功", async () => {
    const { createOpenAiCompatProvider } = await import("../src/agent/openai-provider.js");
    let call = 0;
    const events: unknown[] = [];
    const fake = vi.fn(async () => {
      call++;
      if (call === 1) return sseRes([
        'data: {"choices":[{"delta":{"content":"部分"}}]}\n\n',
        'data: {"error":{"message":"An error occurred in model serving, error message is: [Inference engine abort. Finish reason: [UNKNOWN].]"}}\n\n',
      ]);
      return sseRes([
        'data: {"choices":[{"delta":{"content":"完整答复"}}]}\n\n',
        'data: {"choices":[{"delta":{}},{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
        "data: [DONE]\n\n",
      ]);
    });
    vi.stubGlobal("fetch", fake);
    const p = createOpenAiCompatProvider({ baseUrl: "http://x/v1", apiKey: "k", model: "m", retry: 2 });
    const deltas: string[] = [];
    const out = await p.chat([{ role: "user", content: "hi" }], [], undefined, (d) => { if (d.text) deltas.push(d.text); });
    expect(out.content).toBe("完整答复");
    expect(fake).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  }, 20_000);

  it("连续失败到重试上限 → 抛错(不再伪装成功)", async () => {
    const { createOpenAiCompatProvider } = await import("../src/agent/openai-provider.js");
    const fake = vi.fn(async () => sseRes([
      'data: {"error":{"message":"Inference engine abort. Finish reason: [UNKNOWN]."}}\n\n',
    ]));
    vi.stubGlobal("fetch", fake);
    const p = createOpenAiCompatProvider({ baseUrl: "http://x/v1", apiKey: "k", model: "m", retry: 2 });
    await expect(p.chat([{ role: "user", content: "hi" }], [], undefined, () => {})).rejects.toThrow(/Inference engine abort/);
    expect(fake).toHaveBeenCalledTimes(3); // 1 次原始 + 2 次重试(postWithRetry 同语义)
    vi.unstubAllGlobals();
  }, 20_000);
});
