/**
 *  模型错误策略表(纯函数层)分类表逐类锚定。
 * 机制:。
 */
import { describe, it, expect } from "vitest";
import {
  classifyModelError,
  extractErrorDetail,
  ModelRequestError,
  parseRetryAfter,
  parseResetAt,
  UnknownErrorBudget,
  UNKNOWN_ERROR_STOP_COUNT,
} from "../src/agent/model-error-policy";

const jsonErr = (e: Record<string, unknown>) => JSON.stringify({ error: e });

describe("classifyModelError 分类表", () => {
  it("401/403 → auth,stop(不重试)", () => {
    for (const status of [401, 403]) {
      const d = classifyModelError({ status, body: jsonErr({ message: "nope" }) });
      expect(d.kind).toBe("auth");
      expect(d.retryable).toBe(false);
      expect(d.stop).toBe(true);
      expect(d.action).toContain("API Key");
    }
  });

  it("400 + invalid api key 文案 → auth(不落 invalid_request)", () => {
    const d = classifyModelError({ status: 400, body: jsonErr({ message: "Invalid API key provided" }) });
    expect(d.kind).toBe("auth");
    expect(d.stop).toBe(true);
  });

  it("429 + insufficient_quota → quota(stop,带 resetAt,不退避重试)", () => {
    const before = Date.now();
    const d = classifyModelError({
      status: 429,
      body: jsonErr({ code: "insufficient_quota", message: "You exceeded your current quota" }),
      headers: { "retry-after": "30" },
    });
    expect(d.kind).toBe("quota");
    expect(d.stop).toBe(true);
    expect(d.retryable).toBe(false);
    expect(d.resetAt).toBeGreaterThanOrEqual(before + 29_000);
    expect(d.resetAt).toBeLessThan(before + 31_000);
  });

  it("429 + x-ratelimit-reset-* 时长串 → resetAt(6m0s)", () => {
    const before = Date.now();
    const d = classifyModelError({
      status: 429,
      body: jsonErr({ code: "insufficient_quota" }),
      headers: { "x-ratelimit-reset-requests": "6m0s" },
    });
    expect(d.kind).toBe("quota");
    expect(d.resetAt).toBeGreaterThanOrEqual(before + 359_000);
    expect(d.resetAt).toBeLessThan(before + 361_000);
  });

  it("resetAt 支持 retry-after HTTP-date", () => {
    const target = Date.now() + 5_000;
    const d = classifyModelError({
      status: 429,
      body: jsonErr({ code: "insufficient_quota" }),
      headers: { "retry-after": new Date(target).toUTCString() },
    });
    expect(d.resetAt).toBeGreaterThanOrEqual(target - 1_500);
    expect(d.resetAt).toBeLessThanOrEqual(target + 1_500);
  });

  it("429 无 quota 文案 → rate_limited(retryable,retryAfterMs)", () => {
    const d = classifyModelError({ status: 429, body: jsonErr({ message: "rate limit reached" }), headers: { "retry-after": "2" } });
    expect(d.kind).toBe("rate_limited");
    expect(d.retryable).toBe(true);
    expect(d.stop).toBe(false);
    expect(d.retryAfterMs).toBe(2_000);
  });

  it("404 → model_unavailable;404 + model_not_found → not_configured(均 stop)", () => {
    const a = classifyModelError({ status: 404, body: jsonErr({ message: "not here" }) });
    expect(a.kind).toBe("model_unavailable");
    expect(a.stop).toBe(true);
    const b = classifyModelError({ status: 400, body: jsonErr({ code: "model_not_found", message: "The model `x` does not exist" }) });
    expect(b.kind).toBe("not_configured");
    expect(b.stop).toBe(true);
    expect(b.action).toContain("模型名");
  });

  it("400 + context length → context_exceeded(stop,action 先压缩)", () => {
    const d = classifyModelError({ status: 400, body: jsonErr({ message: "This model's maximum context length is 8192 tokens" }) });
    expect(d.kind).toBe("context_exceeded");
    expect(d.stop).toBe(true);
    expect(d.action).toContain("压缩");
  });

  it("其它 400/422 → invalid_request(stop,保留 body 摘要)", () => {
    const d400 = classifyModelError({ status: 400, body: jsonErr({ code: "unknown_parameter", message: "Unknown parameter: 'foo'" }) });
    expect(d400.kind).toBe("invalid_request");
    expect(d400.stop).toBe(true);
    expect(d400.detail).toContain("unknown_parameter");
    const d422 = classifyModelError({ status: 422, body: "unprocessable" });
    expect(d422.kind).toBe("invalid_request");
  });

  it("5xx → transient(retryable)", () => {
    for (const status of [500, 502, 503, 504]) {
      const d = classifyModelError({ status, body: "" });
      expect(d.kind).toBe("transient");
      expect(d.retryable).toBe(true);
      expect(d.stop).toBe(false);
    }
  });

  it("网络层 TypeError: terminated / ECONNRESET → transient", () => {
    const a = classifyModelError({ err: new TypeError("terminated") });
    expect(a.kind).toBe("transient");
    expect(a.retryable).toBe(true);
    const b = classifyModelError({ err: new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }) });
    expect(b.kind).toBe("transient");
  });

  it("AbortError / signalAborted → cancelled(stop,不重试)", () => {
    const a = classifyModelError({ err: Object.assign(new Error("This operation was aborted"), { name: "AbortError" }) });
    expect(a.kind).toBe("cancelled");
    expect(a.stop).toBe(true);
    expect(a.retryable).toBe(false);
    const b = classifyModelError({ status: 500, signalAborted: true });
    expect(b.kind).toBe("cancelled");
  });

  it("未知 4xx → unknown(retryable,由预算控制,action 说明会停)", () => {
    const d = classifyModelError({ status: 418, body: "teapot" });
    expect(d.kind).toBe("unknown");
    expect(d.retryable).toBe(true);
    expect(d.stop).toBe(false);
    expect(d.action).toContain(String(UNKNOWN_ERROR_STOP_COUNT));
  });
});

describe("未知错误连续预算", () => {
  it("连续 10 次 unknown → 第 10 次 stop;中途 auth 清零;清零后可再计数", () => {
    const b = new UnknownErrorBudget();
    for (let i = 1; i < UNKNOWN_ERROR_STOP_COUNT; i++) {
      const r = b.record("openai|m1", "unknown");
      expect(r.count).toBe(i);
      expect(r.stop).toBe(false);
    }
    expect(b.record("openai|m1", "unknown")).toEqual({ count: 10, stop: true });

    // 其它分类失败(含 cancelled)清零
    b.record("openai|m1", "auth");
    expect(b.countOf("openai|m1")).toBe(0);
    b.record("openai|m1", "unknown");
    b.record("openai|m1", "cancelled");
    expect(b.countOf("openai|m1")).toBe(0);
    // 清零后重新数到 10 才停
    for (let i = 1; i < 10; i++) b.record("openai|m1", "unknown");
    expect(b.record("openai|m1", "unknown").stop).toBe(true);
  });

  it("不同键互不影响", () => {
    const b = new UnknownErrorBudget();
    for (let i = 0; i < 9; i++) b.record("a", "unknown");
    expect(b.record("b", "unknown")).toEqual({ count: 1, stop: false });
  });
});

describe("ModelRequestError 与辅助解析", () => {
  it("message 可操作:status 前缀 + detail + action;detail ≤200", () => {
    const big = "x".repeat(500);
    const d = classifyModelError({ status: 401, body: big });
    const err = new ModelRequestError(d, { status: 401 });
    expect(err.message.startsWith("LLM 401: ")).toBe(true);
    expect(err.message).toContain("检查 API Key");
    expect(err.detail.length).toBeLessThanOrEqual(200);
    expect(err.kind).toBe("auth");
    expect(err.stop).toBe(true);
  });

  it("quota message 带 resetAt ISO 串", () => {
    const d = classifyModelError({ status: 429, body: jsonErr({ code: "insufficient_quota" }), headers: { "retry-after": "5" } });
    const err = new ModelRequestError(d, { status: 429 });
    expect(err.resetAt).toBeDefined();
    expect(err.message).toContain("resetAt=");
  });

  it("extractErrorDetail:错误对象形态与 provider-apitypes 同构", () => {
    expect(extractErrorDetail(jsonErr({ type: "authentication_error", message: "bad key" }))).toBe("authentication_error: bad key");
    expect(extractErrorDetail(jsonErr({ code: "unknown_parameter", message: "Unknown parameter: 'foo'" }))).toBe("unknown_parameter: Unknown parameter: 'foo'");
    expect(extractErrorDetail("plain text body")).toBe("plain text body");
  });

  it("parseRetryAfter / parseResetAt 基本形态", () => {
    expect(parseRetryAfter("3")).toBe(3_000);
    expect(parseRetryAfter("0.5")).toBe(500);
    expect(parseResetAt(String(Math.floor((Date.now() + 60_000) / 1000)))).toBeGreaterThan(Date.now());
    expect(parseResetAt(undefined)).toBeUndefined();
  });
});
