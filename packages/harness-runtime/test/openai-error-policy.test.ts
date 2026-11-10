/**
 *  接线验收:postWithRetry / 流中途错误的分类→重试/停止行为(假 fetch,不真连网)。
 * 与 openai-retry-governor.test.ts(429 退避+AIMD)、openai-stream.test.ts 互补:
 * 那两份锚定旧行为不回归,这份锚定新策略表的接线。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createOpenAiCompatProvider } from "../src/agent/openai-provider";
import { ModelRequestError, UnknownErrorBudget } from "../src/agent/model-error-policy";
import type { ModelNetworkStatusEvent } from "../src/concurrency/admission";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.unstubAllGlobals();
});

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const okBody = { choices: [{ message: { content: "ok" } }] };

function provider(extra: Record<string, unknown> = {}) {
  return createOpenAiCompatProvider({
    baseUrl: "https://llm.test",
    apiKey: "k",
    model: "m1",
    retry: 2,
    ...extra,
  } as Parameters<typeof createOpenAiCompatProvider>[0]);
}

async function kindOf(p: Promise<unknown>): Promise<ModelRequestError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ModelRequestError);
    return err as ModelRequestError;
  }
  throw new Error("expected rejection");
}

describe("postWithRetry:永久错误立即停(只调 1 次)", () => {
  it("401 → auth,1 次即抛,不退避重试", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonRes({ error: { message: "Invalid API key" } }, 401);
    }) as typeof fetch;
    const err = await kindOf(provider().chat([{ role: "user", content: "hi" }], []));
    expect(calls).toBe(1);
    expect(err.kind).toBe("auth");
    expect(err.stop).toBe(true);
    expect(err.message).toContain("LLM 401");
    expect(err.message).toContain("检查 API Key");
  });

  it("404 model_not_found → not_configured,1 次即抛", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonRes({ error: { code: "model_not_found", message: "The model `m1` does not exist" } }, 404);
    }) as typeof fetch;
    const err = await kindOf(provider().chat([{ role: "user", content: "hi" }], []));
    expect(calls).toBe(1);
    expect(err.kind).toBe("not_configured");
    expect(err.message).toContain("模型名");
  });

  it("400 context length → context_exceeded,1 次即抛且文案可操作", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonRes({ error: { message: "maximum context length is 8192 tokens" } }, 400);
    }) as typeof fetch;
    const err = await kindOf(provider().chat([{ role: "user", content: "hi" }], []));
    expect(calls).toBe(1);
    expect(err.kind).toBe("context_exceeded");
    expect(err.message).toContain("压缩");
  });
});

describe("postWithRetry:429 quota 不重试并带 resetAt", () => {
  it("insufficient_quota → quota,1 次,事件带 resetAt,message 带 resetAt ISO", async () => {
    let calls = 0;
    const events: ModelNetworkStatusEvent[] = [];
    globalThis.fetch = (async () => {
      calls++;
      return jsonRes({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }, 429, { "retry-after": "20" });
    }) as typeof fetch;
    const err = await kindOf(provider({ onNetworkStatus: (e: ModelNetworkStatusEvent) => events.push(e) }).chat([{ role: "user", content: "hi" }], []));
    expect(calls).toBe(1);
    expect(err.kind).toBe("quota");
    expect(err.stop).toBe(true);
    expect(err.resetAt).toBeGreaterThan(Date.now());
    expect(err.message).toContain("resetAt=");
    const failed = events.filter((e) => e.type === "model_request_failed") as { code?: string; resetAt?: number; retryable?: boolean }[];
    expect(failed).toHaveLength(1);
    expect(failed[0]!.code).toBe("quota");
    expect(failed[0]!.retryable).toBe(false);
    expect(failed[0]!.resetAt).toBeGreaterThan(Date.now());
    // quota 不得伪装成 rate_limited(retry_scheduled 是 AIMD throttle 信号源)
    expect(events.filter((e) => e.type === "model_retry_scheduled")).toHaveLength(0);
  });

  it("429 无 quota 文案 → rate_limited 仍重试(事件码兼容 rate_limited)", async () => {
    let calls = 0;
    const events: ModelNetworkStatusEvent[] = [];
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 2) return jsonRes({ error: { message: "rate limit" } }, 429, { "retry-after": "0.01" });
      return jsonRes(okBody);
    }) as typeof fetch;
    const out = await provider({ onNetworkStatus: (e: ModelNetworkStatusEvent) => events.push(e) }).chat([{ role: "user", content: "hi" }], []);
    expect(out.content).toBe("ok");
    expect(calls).toBe(2);
    const sched = events.filter((e) => e.type === "model_retry_scheduled") as { reason: string }[];
    expect(sched).toHaveLength(1);
    expect(sched[0]!.reason).toBe("rate_limited");
  });
});

describe("postWithRetry:可重试类仍重试", () => {
  it("500 重试到成功;事件 code 兼容 provider_overloaded", async () => {
    let calls = 0;
    const events: ModelNetworkStatusEvent[] = [];
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) return jsonRes({ error: { message: "boom" } }, 500);
      return jsonRes(okBody);
    }) as typeof fetch;
    const out = await provider({ onNetworkStatus: (e: ModelNetworkStatusEvent) => events.push(e) }).chat([{ role: "user", content: "hi" }], []);
    expect(out.content).toBe("ok");
    expect(calls).toBe(3);
    const failed = events.filter((e) => e.type === "model_request_failed") as { code?: string }[];
    expect(failed.map((e) => e.code)).toEqual(["provider_overloaded", "provider_overloaded"]);
  });

  it("TypeError: terminated 走 transient 重试一次后成功", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("terminated");
      return jsonRes(okBody);
    }) as typeof fetch;
    const out = await provider().chat([{ role: "user", content: "hi" }], []);
    expect(out.content).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("postWithRetry:未知错误连续预算", () => {
  it("未知 4xx 在 provider 内重试耗尽即抛 unknown(预算未满)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonRes({ weird: true }, 418);
    }) as typeof fetch;
    const err = await kindOf(provider({ retry: 2 }).chat([{ role: "user", content: "hi" }], []));
    expect(calls).toBe(3); // 1 + 2 次重试
    expect(err.kind).toBe("unknown");
    expect(err.message).toContain("LLM 418");
  });

  it("连续 10 次未知(跨请求、retry=0)→ 第 10 次起停止不再发请求之外的退避", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonRes({ weird: true }, 418);
    }) as typeof fetch;
    const p = provider({ retry: 0 });
    for (let i = 0; i < 9; i++) {
      const err = await kindOf(p.chat([{ role: "user", content: "hi" }], []));
      expect(err.kind).toBe("unknown");
      expect(err.stop).toBe(false);
    }
    const last = await kindOf(p.chat([{ role: "user", content: "hi" }], []));
    expect(calls).toBe(10);
    expect(last.stop).toBe(true);
    expect(last.message).toContain("连续 10 次");
  });

  it("中间一次 auth 清零后,auth 成功隔断可重新累计", async () => {
    const budget = new UnknownErrorBudget();
    for (let i = 0; i < 9; i++) budget.record("k", "unknown");
    budget.record("k", "auth");
    expect(budget.countOf("k")).toBe(0);
  });
});

describe("流中途错误接线", () => {
  function sseRes(chunks: string[]) {
    const enc = new TextEncoder();
    let i = 0;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]!) } : { done: true, value: undefined }) }) } as never,
    } as unknown as Response;
  }

  it("流中 error 带 insufficient_quota → 立即抛 quota(stop),不重试第二次", async () => {
    const fake = vi.fn(async () => sseRes(['data: {"error":{"code":"insufficient_quota","message":"quota exhausted"}}\n\n']));
    vi.stubGlobal("fetch", fake);
    const err = await kindOf(provider({ retry: 3 }).chat([{ role: "user", content: "hi" }], [], undefined, () => {}));
    expect(fake).toHaveBeenCalledTimes(1);
    expect(err.kind).toBe("quota");
    expect(err.stop).toBe(true);
  });

  it("流中 error 带 invalid api key → 立即抛 auth,不重试", async () => {
    const fake = vi.fn(async () => sseRes(['data: {"error":{"message":"invalid api key"}}\n\n']));
    vi.stubGlobal("fetch", fake);
    const err = await kindOf(provider({ retry: 3 }).chat([{ role: "user", content: "hi" }], [], undefined, () => {}));
    expect(fake).toHaveBeenCalledTimes(1);
    expect(err.kind).toBe("auth");
  });

  it("流中未知 error 仍按旧行为重试(transient 语义保留),耗尽后抛原文", async () => {
    const fake = vi.fn(async () => sseRes(['data: {"error":{"message":"Inference engine abort. Finish reason: [UNKNOWN]."}}\n\n']));
    vi.stubGlobal("fetch", fake);
    await expect(provider({ retry: 1 }).chat([{ role: "user", content: "hi" }], [], undefined, () => {})).rejects.toThrow(/Inference engine abort/);
    expect(fake).toHaveBeenCalledTimes(2);
  });
});
