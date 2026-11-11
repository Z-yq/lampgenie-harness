/**
 * M122b 验收:anthropic Messages / OpenAI Responses 的**非流式**路径接入一次性请求体修复。
 * 假 fetch(不真连网)覆盖探针:
 * A) anthropic 400 invalid_request → max_tokens 8192 夹到 4096 → 第二次成功,emit model_repair 恰 1 次;
 * B) responses 400 同理(max_output_tokens 夹取 + reasoning 删除);
 * C) 同一请求第二次 400 → 不再修复,恰好 2 次请求后抛错;
 * D) 流式路径(onDelta 分支)不发修复请求,请求体逐字不变;
 * E) 正常 200 请求体不变、无 model_repair。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, ToolSpec } from "../src/agent/loop";
import { anthropicChat, responsesChat } from "../src/agent/provider-apitypes";

type RecordedCall = { url: string; body: Record<string, unknown> };

/** 假 fetch:按调用序号返回不同响应,并记录每次请求体。 */
function stubFetch(handler: (call: RecordedCall, n: number) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      const call: RecordedCall = { url, body: JSON.parse(init.body) as Record<string, unknown> };
      calls.push(call);
      return handler(call, calls.length);
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const messages: Message[] = [{ role: "user", content: "hi" }];
const tools: ToolSpec[] = [];
const signal = new AbortController().signal;

function retryCtx(events: Array<Record<string, unknown>>, retry = 0) {
  return { retry, emit: (e: unknown) => { events.push(e as Record<string, unknown>); } };
}

const anthropicOk = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } };
const responsesOk = { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], status: "completed", usage: { input_tokens: 3, output_tokens: 2 } };
const anthropic400 = { type: "error", error: { type: "invalid_request_error", message: "invalid_request: unsupported field `thinking`" } };
const responses400 = { error: { type: "invalid_request_error", message: "unsupported parameter: reasoning" } };

const callAnthropic = (cur: Record<string, unknown>, onDelta?: (d: unknown) => void, events: Array<Record<string, unknown>> = []) =>
  anthropicChat(
    { baseUrl: "http://fake.local", apiKey: "k", model: "m", ...cur } as never,
    messages,
    tools,
    signal,
    onDelta as never,
    retryCtx(events) as never);

const callResponses = (cur: Record<string, unknown>, onDelta?: (d: unknown) => void, events: Array<Record<string, unknown>> = []) =>
  responsesChat(
    { baseUrl: "http://fake.local", apiKey: "k", model: "m", ...cur } as never,
    messages,
    tools,
    signal,
    onDelta as never,
    retryCtx(events) as never);

describe("anthropic 非流式一次性修复", () => {
  it("探针 A:400 invalid_request → max_tokens 夹到 4096 后第二次成功,emit model_repair 1 次", async () => {
    const events: Array<Record<string, unknown>> = [];
    const calls = stubFetch((_c, n) => (n === 1 ? json(400, anthropic400) : json(200, anthropicOk)));
    const out = await callAnthropic({ maxTokens: 8192 }, undefined, events);

    expect(out.content).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("http://fake.local/v1/messages");
    expect(calls[0]!.body.max_tokens).toBe(8192);
    expect(calls[1]!.body.max_tokens).toBe(4096); // 夹取生效
    expect("thinking" in calls[1]!.body).toBe(false); // 适配器 body 本身不带 thinking,也不允许被加回
    const repairs = events.filter((e) => e.type === "model_repair");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.code).toBe("invalid_request");
    expect(repairs[0]!.actions).toEqual(["max_tokens"]); // 只记真实改写的字段
  });

  it("探针 C:同一请求第二次 400 → 不再修复,恰好 2 次请求后抛错", async () => {
    const events: Array<Record<string, unknown>> = [];
    const calls = stubFetch(() => json(400, anthropic400));
    await expect(callAnthropic({ maxTokens: 8192 }, undefined, events)).rejects.toBeInstanceOf(Error);
    expect(calls).toHaveLength(2);
    expect(events.filter((e) => e.type === "model_repair")).toHaveLength(1);
  });

  it("400 但报文不点名参数类错误(额度类)→ 不修复,1 次请求即抛", async () => {
    const events: Array<Record<string, unknown>> = [];
    const calls = stubFetch(() => json(400, { type: "error", error: { type: "billing_error", message: "insufficient balance" } }));
    await expect(callAnthropic({ maxTokens: 8192 }, undefined, events)).rejects.toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e.type === "model_repair")).toHaveLength(0);
  });

  it("400 但 body 无可改字段(max_tokens 在区间内、无 thinking)→ 不虚报动作、不重发", async () => {
    const events: Array<Record<string, unknown>> = [];
    const calls = stubFetch(() => json(400, anthropic400));
    await expect(callAnthropic({ maxTokens: 2048 }, undefined, events)).rejects.toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e.type === "model_repair")).toHaveLength(0);
  });

  it("401 鉴权错误 → 不修复、1 次请求即抛", async () => {
    const events: Array<Record<string, unknown>> = [];
    const calls = stubFetch(() => json(401, { type: "error", error: { type: "authentication_error", message: "invalid api key" } }));
    await expect(callAnthropic({ maxTokens: 8192 }, undefined, events)).rejects.toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e.type === "model_repair")).toHaveLength(0);
  });

  it("探针 D:流式路径 400 不发修复请求,请求体带 stream:true 逐字不变", async () => {
    const events: Array<Record<string, unknown>> = [];
    const calls = stubFetch(() => json(400, anthropic400));
    await expect(callAnthropic({ maxTokens: 8192 }, () => {}, events)).rejects.toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.max_tokens).toBe(8192); // 未夹取(流式不改写)
    expect(calls[0]!.body.stream).toBe(true);
    expect(events.filter((e) => e.type === "model_repair")).toHaveLength(0);
  });

  it("探针 E:正常 200 → 请求体不变、无 model_repair", async () => {
    const events: Array<Record<string, unknown>> = [];
    const calls = stubFetch(() => json(200, anthropicOk));
    const out = await callAnthropic({ maxTokens: 8192 }, undefined, events);
    expect(out.content).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.max_tokens).toBe(8192);
    expect(events.filter((e) => e.type === "model_repair")).toHaveLength(0);
  });
});

describe("responses 非流式一次性修复", () => {
  it("探针 B:400 invalid_request → max_output_tokens 夹取 + reasoning 删除后成功,emit 1 次", async () => {
    const events: Array<Record<string, unknown>> = [];
    const calls = stubFetch((_c, n) => (n === 1 ? json(400, responses400) : json(200, responsesOk)));
    const out = await callResponses({ maxTokens: 8192, reasoningEffort: "high" }, undefined, events);

    expect(out.content).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("http://fake.local/v1/responses");
    expect(calls[0]!.body.max_output_tokens).toBe(8192);
    expect(calls[0]!.body.reasoning).toEqual({ effort: "high" });
    expect(calls[1]!.body.max_output_tokens).toBe(4096);
    expect("reasoning" in calls[1]!.body).toBe(false);
    const repairs = events.filter((e) => e.type === "model_repair");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.code).toBe("invalid_request");
    expect(repairs[0]!.actions).toEqual(["max_output_tokens", "reasoning"]);
  });

  it("探针 C:responses 第二次 400 → 不再修复,2 次请求后抛错", async () => {
    const events: Array<Record<string, unknown>> = [];
    const calls = stubFetch(() => json(400, responses400));
    await expect(callResponses({ maxTokens: 8192, reasoningEffort: "high" }, undefined, events)).rejects.toBeInstanceOf(Error);
    expect(calls).toHaveLength(2);
    expect(events.filter((e) => e.type === "model_repair")).toHaveLength(1);
  });

  it("400 但无可改字段(无 max_output_tokens / reasoning)→ 不修复、不重发", async () => {
    const events: Array<Record<string, unknown>> = [];
    const calls = stubFetch(() => json(400, responses400));
    await expect(callResponses({}, undefined, events)).rejects.toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e.type === "model_repair")).toHaveLength(0);
  });

  it("探针 D:responses 流式路径 400 不发修复请求,stream:true 不变", async () => {
    const events: Array<Record<string, unknown>> = [];
    const calls = stubFetch(() => json(400, responses400));
    await expect(callResponses({ maxTokens: 8192, reasoningEffort: "high" }, () => {}, events)).rejects.toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.max_output_tokens).toBe(8192);
    expect(calls[0]!.body.stream).toBe(true);
    expect(events.filter((e) => e.type === "model_repair")).toHaveLength(0);
  });

  it("探针 E:responses 正常 200 → 请求体不变、无 model_repair", async () => {
    const events: Array<Record<string, unknown>> = [];
    const calls = stubFetch(() => json(200, responsesOk));
    const out = await callResponses({ maxTokens: 8192, reasoningEffort: "high" }, undefined, events);
    expect(out.content).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.max_output_tokens).toBe(8192);
    expect(calls[0]!.body.reasoning).toEqual({ effort: "high" });
    expect(events.filter((e) => e.type === "model_repair")).toHaveLength(0);
  });
});
