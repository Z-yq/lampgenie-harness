import { describe, it, expect, vi, afterEach } from "vitest";
import { createOpenAiCompatProvider } from "../src/agent/openai-provider";

/** SSE body 构造:一段一 chunk(data: 行)。 */
function sseBody(chunks: unknown[], opts: { done?: boolean } = {}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const lines = chunks.map((c) => "data: " + JSON.stringify(c)).join("\n\n") + (opts.done === false ? "" : "\n\ndata: [DONE]\n\n");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(lines));
      controller.close();
    },
  });
}

function sseResponse(stream: ReadableStream<Uint8Array>) {
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const streamFetch = vi.fn();

afterEach(() => {
  streamFetch.mockReset();
  (globalThis as { fetch?: unknown }).fetch = undefined;
});

function installFetch() {
  (globalThis as { fetch?: unknown }).fetch = streamFetch;
}

describe("openai-compat 流式分支", () => {
  it("content/reasoning/tool_calls/usage 聚合与非流式同构;onDelta 逐块透出", async () => {
    installFetch();
    streamFetch.mockResolvedValue(sseResponse(sseBody([
      { choices: [{ delta: { reasoning_content: "想一" } }] },
      { choices: [{ delta: { reasoning_content: "下" } }] },
      { choices: [{ delta: { content: "你好" } }] },
      { choices: [{ delta: { content: ",", tool_calls: [{ index: 0, id: "call-1", function: { name: "getTime", arguments: "{}" } }] } }] },
      { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ])));
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1" });
    const deltas: { text?: string; reasoning?: string }[] = [];
    const r = await p.chat([{ role: "user", content: "hi" }], [], undefined, (d) => deltas.push(d));
    expect(r.content).toBe("你好,");
    expect(r.reasoning).toBe("想一下");
    expect(r.toolCalls).toEqual([{ id: "call-1", name: "getTime", arguments: "{}" }]);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(deltas).toEqual([{ reasoning: "想一" }, { reasoning: "下" }, { text: "你好" }, { text: "," }]);
    // 请求形态:stream 开启 + usage 请求
    const body = JSON.parse(streamFetch.mock.calls[0]![1]!.body as string);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("流中 error 对象转异常;非 JSON 行忽略不炸", async () => {
    installFetch();
    const enc = new TextEncoder();
    const raw = "data: not-json\n\ndata: " + JSON.stringify({ error: { message: "quota" } }) + "\n\n";
    const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode(raw)); c.close(); } });
    streamFetch.mockResolvedValue(sseResponse(stream));
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1" });
    await expect(p.chat([{ role: "user", content: "x" }], [], undefined, () => {})).rejects.toThrow("quota");
  });

  it("stream_options 不被支持(400 点名)→去参重试一次", async () => {
    installFetch();
    streamFetch
      .mockResolvedValueOnce(new Response("stream_options not supported", { status: 400 }))
      .mockResolvedValueOnce(sseResponse(sseBody([{ choices: [{ delta: { content: "ok" } }] }])));
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1" });
    const r = await p.chat([{ role: "user", content: "x" }], [], undefined, () => {});
    expect(r.content).toBe("ok");
    expect(JSON.parse(streamFetch.mock.calls[1]![1]!.body as string).stream_options).toBeUndefined();
  });

  it("非 SSE 响应(网关忽略 stream)→整包 JSON 兜底解析", async () => {
    installFetch();
    streamFetch.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "整包", tool_calls: [{ id: "c1", function: { name: "t", arguments: "{}" } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1" });
    const r = await p.chat([{ role: "user", content: "x" }], [], undefined, () => {});
    expect(r.content).toBe("整包");
    expect(r.toolCalls).toEqual([{ id: "c1", name: "t", arguments: "{}" }]);
    expect(r.usage?.totalTokens).toBe(3);
  });

  it("onDelta 缺省→走非流式旧路径(不带 stream 标志)", async () => {
    installFetch();
    streamFetch.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "旧路径" } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1" });
    const r = await p.chat([{ role: "user", content: "x" }], []);
    expect(r.content).toBe("旧路径");
    const body = JSON.parse(streamFetch.mock.calls[0]![1]!.body as string);
    expect(body.stream).toBeUndefined();
  });

  it("finish_reason 归一:流式取最后一个非空值;非流式读 choices[0].finish_reason", async () => {
    installFetch();
    // 流式:length 在末包(其后带 usage 的包无 finish_reason,不得覆盖)
    streamFetch.mockResolvedValueOnce(sseResponse(sseBody([
      { choices: [{ delta: { content: "半截" } }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
      { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
    ])));
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1" });
    const r1 = await p.chat([{ role: "user", content: "x" }], [], undefined, () => {});
    expect(r1.finishReason).toBe("length");
    // 非流式
    streamFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: { content: "整包半截" } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const r2 = await p.chat([{ role: "user", content: "x" }], []);
    expect(r2.finishReason).toBe("length");
    // 缺省 finish_reason = 不设字段(不触发续写)
    streamFetch.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "无" } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const r3 = await p.chat([{ role: "user", content: "x" }], []);
    expect(r3.finishReason).toBeUndefined();
  });
});
