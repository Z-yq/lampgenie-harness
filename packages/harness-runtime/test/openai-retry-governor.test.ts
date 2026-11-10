/**
 * 429 自动重试+governor AIMD 信号源专项(step-008 二期收口)。
 * 此前 governor/AIMD 全链存在但零生产者(model_retry_scheduled 无人发)——本套件锚定:
 * 429→retry(Retry-After/退避)→model_retry_scheduled 经票据喂 AIMD(throttled 降 cap)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { createOpenAiCompatProvider } from "../src/agent/openai-provider";
import type { ModelLifecycleEvent, RequestAdmission, AdmissionTicket } from "../src/concurrency/admission";

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("openai-provider 429 重试", () => {
  it("429 两次后成功:重试生效,Retry-After 优先,retry_scheduled 事件发出", async () => {
    let calls = 0;
    const events: ModelLifecycleEvent[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls++;
      if (calls <= 2) return jsonRes({ error: { message: "rate limited" } }, 429, { "retry-after": "0.01" });
      return jsonRes({ choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    const p = createOpenAiCompatProvider({
      baseUrl: "https://llm.test", apiKey: "k", model: "m1", retry: 3,
      onNetworkStatus: (e) => events.push(e),
    });
    const out = await p.chat([{ role: "user", content: "hi" }], []);
    expect(out.content).toBe("ok");
    expect(calls).toBe(3);
    const scheduled = events.filter((e) => e.type === "model_retry_scheduled");
    expect(scheduled).toHaveLength(2);
    expect((scheduled[0] as { reason: string }).reason).toBe("rate_limited");
    expect((scheduled[0] as { delayMs: number }).delayMs).toBeLessThanOrEqual(15_000);
  });

  it("重试耗尽仍 429:抛错且终态 failed 不带 retryable", async () => {
    let calls = 0;
    const events: ModelLifecycleEvent[] = [];
    globalThis.fetch = (async () => { calls++; return jsonRes({ error: { message: "still limited" } }, 429); }) as typeof fetch;
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1", retry: 1, onNetworkStatus: (e) => events.push(e) });
    await expect(p.chat([{ role: "user", content: "hi" }], [])).rejects.toThrow(/LLM 429/);
    expect(calls).toBe(2);
    expect(events.filter((e) => e.type === "model_retry_scheduled")).toHaveLength(1);
  });

  it("retry=0 关闭重试:一次即抛", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return jsonRes({ error: {} }, 503); }) as typeof fetch;
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1", retry: 0 });
    await expect(p.chat([{ role: "user", content: "hi" }], [])).rejects.toThrow(/LLM 503/);
    expect(calls).toBe(1);
  });
});

describe("openai-provider admission( governor passthrough )接线", () => {
  it("take→started→completed→release 生命周期;release 恰一次", async () => {
    const lifecycle: string[] = [];
    let released = 0;
    const ticket: AdmissionTicket = {
      emit: (e) => lifecycle.push(e.type),
      release: () => { released++; },
    };
    const admission: RequestAdmission = {
      async take() { lifecycle.push("acquired"); return ticket; },
    };
    globalThis.fetch = (async () => jsonRes({ choices: [{ message: { content: "ok" } }] })) as typeof fetch;
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1", admission });
    await p.chat([{ role: "user", content: "hi" }], []);
    expect(lifecycle).toEqual(["acquired", "model_request_started", "model_request_completed"]);
    expect(released).toBe(1);
  });

  it("请求失败:failed(retryable:false) 也 release(finally 保证)", async () => {
    let released = 0;
    const lifecycle: string[] = [];
    const ticket: AdmissionTicket = {
      emit: (e) => lifecycle.push(e.type),
      release: () => { released++; },
    };
    const admission: RequestAdmission = { async take() { return ticket; } };
    globalThis.fetch = (async () => jsonRes({ error: {} }, 500)) as typeof fetch;
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1", admission, retry: 0 });
    await expect(p.chat([{ role: "user", content: "hi" }], [])).rejects.toThrow(/LLM 500/);
    expect(lifecycle).toContain("model_request_failed");
    expect(released).toBe(1);
  });
});

describe("网络层错误重试(2026-10-20 子代理 8 路 fetch failed 回归)", () => {
  const connectTimeout = () => {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = {
      code: "ConnectTimeoutError",
      message: "Connect Timeout Error (attempted address: open.bigmodel.cn:443, timeout: 10000ms)",
    };
    return err;
  };

  it("建连超时一次后成功:自动重试,重试事件带 network_error", async () => {
    let calls = 0;
    const events: ModelLifecycleEvent[] = [];
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw connectTimeout();
      return jsonRes({ choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1", retry: 2, onNetworkStatus: (e) => events.push(e) });
    const out = await p.chat([{ role: "user", content: "hi" }], []);
    expect(out.content).toBe("ok");
    expect(calls).toBe(2);
    const sched = events.filter((e) => e.type === "model_retry_scheduled") as { reason: string; delayMs?: number }[];
    expect(sched[0]?.reason).toBe("network_error");
    expect(sched[0]?.delayMs).toBeGreaterThan(0);
  });

  it("重试耗尽:错误消息带 err.cause 摘要(不再只有 fetch failed)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw connectTimeout(); }) as typeof fetch;
    const p = createOpenAiCompatProvider({ baseUrl: "https://llm.test", apiKey: "k", model: "m1", retry: 1 });
    await expect(p.chat([{ role: "user", content: "hi" }], [])).rejects.toThrow(/LLM 网络错误.*ConnectTimeoutError.*open\.bigmodel\.cn/);
    expect(calls).toBe(2);
  });
});
