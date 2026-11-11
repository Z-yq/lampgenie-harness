/**
 * 错误→请求自修复验收:REPAIR_TABLE / repairPlan 一次性 / applyRepair 白名单改写 /
 * detectFake200 伪 200 / provider 三处接线(探针 A-G,假 fetch 不真连网)。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  REPAIR_CODES,
  REPAIR_TABLE,
  repairPlan,
  applyRepair,
  detectFake200,
  shouldTreatAsError,
  MIN_MAX_TOKENS,
  MAX_MAX_TOKENS,
  DEFAULT_MAX_TOKENS,
  DROP_UNSUPPORTED_KEYS,
  repairProviderBody,
} from "../src/agent/error-repair";
import { ModelRequestError } from "../src/agent/model-error-policy";
import { createOpenAiCompatProvider } from "../src/agent/openai-provider";

const ALL_REASONS = [
  "context_exceeded",
  "invalid_request",
  "transient",
  "rate_limited",
  "auth",
  "not_configured",
  "model_unavailable",
  "quota",
  "cancelled",
];

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const okBody = { choices: [{ finish_reason: "stop", message: { content: "ok" } }] };
const providerMessages = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "", reasoning: "思考" },
  { role: "user", content: "go" },
] as never;

function providerWith(events: unknown[], extra: Record<string, unknown> = {}) {
  return createOpenAiCompatProvider({
    baseUrl: "https://llm.test/v1",
    apiKey: "k",
    model: "m1",
    retry: 2,
    onNetworkStatus: (e: unknown) => events.push(e),
    ...extra,
  } as never);
}

describe("REPAIR_CODES / REPAIR_TABLE(封闭表)", () => {
  it("REPAIR_CODES 为封闭五值且顺序固定", () => {
    expect(REPAIR_CODES).toEqual(["OK", "NOT_REPAIRABLE", "ALREADY_ATTEMPTED", "FAKE_200", "INVALID"]);
  });

  it("REPAIR_TABLE 恰覆盖 9 个 reason(表外无键)", () => {
    expect(Object.keys(REPAIR_TABLE).sort()).toEqual([...ALL_REASONS].sort());
  });

  it("invalid_request → 三个请求改写动作", () => {
    expect(REPAIR_TABLE.invalid_request).toEqual(["strip-reasoning", "clamp-max-tokens", "drop-unsupported-params"]);
  });

  it("context_exceeded 只上报(provider 不压缩)", () => {
    expect(REPAIR_TABLE.context_exceeded).toEqual(["report-context-exceeded"]);
  });

  it("transient / rate_limited 沿用既有退避重试", () => {
    expect(REPAIR_TABLE.transient).toEqual(["retry-backoff"]);
    expect(REPAIR_TABLE.rate_limited).toEqual(["retry-backoff"]);
  });

  it("auth / not_configured / model_unavailable / quota / cancelled 无动作", () => {
    for (const reason of ["auth", "not_configured", "model_unavailable", "quota", "cancelled"] as const) {
      expect(REPAIR_TABLE[reason]).toEqual(["none"]);
    }
  });

  it("表与动作数组冻结(不可被就地改写)", () => {
    expect(Object.isFrozen(REPAIR_TABLE)).toBe(true);
    for (const reason of ALL_REASONS as (keyof typeof REPAIR_TABLE)[]) {
      expect(Object.isFrozen(REPAIR_TABLE[reason])).toBe(true);
    }
  });
});

describe("repairPlan(一次性计划 / can_apply)", () => {
  it("探针 A:invalid_request 首次 → OK 三动作 + onceKey=invalid_request:0", () => {
    const plan = repairPlan({
      code: "invalid_request",
      attempt: 0,
      requestFacts: { hasReasoning: true, maxTokens: 8192, paramKeys: ["response_format"] },
    });
    expect(plan.ok).toBe(true);
    expect(plan.code).toBe("OK");
    expect(plan.actions).toEqual(["strip-reasoning", "clamp-max-tokens", "drop-unsupported-params"]);
    expect(plan.onceKey).toBe("invalid_request:0");
  });

  it("缺省 requestFacts 时仍返回三动作(表全量)", () => {
    expect(repairPlan({ code: "invalid_request" }).actions).toEqual([
      "strip-reasoning",
      "clamp-max-tokens",
      "drop-unsupported-params",
    ]);
  });

  it("探针 B:同 reason attempt>0 → ALREADY_ATTEMPTED 且无动作", () => {
    const plan = repairPlan({ code: "invalid_request", attempt: 1 });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe("ALREADY_ATTEMPTED");
    expect(plan.actions).toEqual([]);
    expect(plan.onceKey).toBe("invalid_request:1");
  });

  it("探针 C:auth → NOT_REPAIRABLE(永久错误不进入改写)", () => {
    const plan = repairPlan({ code: "auth" });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe("NOT_REPAIRABLE");
    expect(plan.actions).toEqual(["none"]);
  });

  it("context_exceeded → NOT_REPAIRABLE,但动作里带 report-context-exceeded", () => {
    const plan = repairPlan({ code: "context_exceeded" });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe("NOT_REPAIRABLE");
    expect(plan.actions).toEqual(["report-context-exceeded"]);
  });

  it("transient → NOT_REPAIRABLE(retry-backoff 由既有重试承担)", () => {
    const plan = repairPlan({ code: "transient" });
    expect(plan.code).toBe("NOT_REPAIRABLE");
    expect(plan.actions).toEqual(["retry-backoff"]);
  });

  it("表外 reason → INVALID", () => {
    const plan = repairPlan({ code: "weird_error" });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe("INVALID");
    expect(plan.actions).toEqual([]);
  });

  it("非法 attempt(负数/非整数)→ INVALID", () => {
    expect(repairPlan({ code: "invalid_request", attempt: -1 }).code).toBe("INVALID");
    expect(repairPlan({ code: "invalid_request", attempt: 1.5 }).code).toBe("INVALID");
  });

  it("facts 显式 false / 空 paramKeys 时过滤对应动作", () => {
    const plan = repairPlan({
      code: "invalid_request",
      requestFacts: { hasReasoning: false, paramKeys: [] },
    });
    expect(plan.actions).toEqual(["clamp-max-tokens"]);
  });

  it("确定性:同输入两次调用 deepEqual,且返回值互不共享", () => {
    const input = { code: "invalid_request", attempt: 0 } as const;
    const a = repairPlan(input);
    const b = repairPlan(input);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.actions).not.toBe(b.actions);
  });

  it("onceKey 稳定格式 code:attempt", () => {
    expect(repairPlan({ code: "rate_limited", attempt: 3 }).onceKey).toBe("rate_limited:3");
  });
});

describe("applyRepair(浅拷贝 / 白名单改写)", () => {
  const baseRequest = () => ({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "想", reasoning: "思考内容" },
    ],
    tools: [{ type: "function" }],
    extra: {
      reasoningEffort: "high",
      maxTokens: 8192,
      response_format: { type: "json_object" },
      parallel_tool_calls: true,
      logprobs: true,
      keep_me: 1,
    },
  });

  it("探针 D:返回全新对象,入参逐字不变", () => {
    const input = baseRequest();
    const out = applyRepair(input, ["strip-reasoning", "clamp-max-tokens", "drop-unsupported-params"]);
    expect(out.request).not.toBe(input as never);
    expect(out.request.messages).not.toBe(input.messages);
    expect(out.request.extra).not.toBe(input.extra);
    expect(out.request.messages[1]).not.toBe(input.messages[1]);
 // 入参未被改
    expect(input.messages[1]!.reasoning).toBe("思考内容");
    expect(input.extra.reasoningEffort).toBe("high");
    expect(input.extra.maxTokens).toBe(8192);
    expect(input.extra.response_format).toEqual({ type: "json_object" });
  });

  it("strip-reasoning:删 assistant.reasoning 与 extra.reasoningEffort,其它消息保留", () => {
    const out = applyRepair(baseRequest(), ["strip-reasoning"]);
    expect("reasoning" in out.request.messages[1]!).toBe(false);
    expect(out.request.messages[0]).toEqual({ role: "user", content: "hi" });
    expect("reasoningEffort" in out.request.extra).toBe(false);
    expect(out.applied).toEqual(["strip-reasoning"]);
  });

  it("clamp-max-tokens:8192→4096,100→256,缺省→2048", () => {
    expect(applyRepair({ messages: [], extra: { maxTokens: 8192 } }, ["clamp-max-tokens"]).request.extra.maxTokens).toBe(MAX_MAX_TOKENS);
    expect(applyRepair({ messages: [], extra: { maxTokens: 100 } }, ["clamp-max-tokens"]).request.extra.maxTokens).toBe(MIN_MAX_TOKENS);
    expect(applyRepair({ messages: [], extra: {} }, ["clamp-max-tokens"]).request.extra.maxTokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it("clamp-max-tokens:小数四舍五入", () => {
    expect(applyRepair({ messages: [], extra: { maxTokens: 1234.6 } }, ["clamp-max-tokens"]).request.extra.maxTokens).toBe(1235);
  });

  it("drop-unsupported-params:只删白名单三键,其它键保留", () => {
    const out = applyRepair(baseRequest(), ["drop-unsupported-params"]);
    for (const key of DROP_UNSUPPORTED_KEYS) expect(key in out.request.extra).toBe(false);
    expect(out.request.extra.keep_me).toBe(1);
    expect(out.applied).toEqual(["drop-unsupported-params"]);
  });

  it("三动作一次应用:applied 顺序=动作顺序,extra 结果符合白名单", () => {
    const out = applyRepair(baseRequest(), ["strip-reasoning", "clamp-max-tokens", "drop-unsupported-params"]);
    expect(out.applied).toEqual(["strip-reasoning", "clamp-max-tokens", "drop-unsupported-params"]);
    expect(out.request.extra).toEqual({ maxTokens: 4096, keep_me: 1 });
  });

  it("未知动作字符串被忽略,不进入 applied", () => {
    const out = applyRepair({ messages: [] }, ["nope", "clamp-max-tokens", "clamp-max-tokens"]);
    expect(out.applied).toEqual(["clamp-max-tokens"]);
  });

  it("确定性:同输入同动作 → 逐字相同输出", () => {
    const input = baseRequest();
    const a = applyRepair(input, ["strip-reasoning", "clamp-max-tokens", "drop-unsupported-params"]);
    const b = applyRepair(input, ["strip-reasoning", "clamp-max-tokens", "drop-unsupported-params"]);
    expect(a).toEqual(b);
  });

  it("tools 浅拷贝:返回数组与入参不是同一引用", () => {
    const input = baseRequest();
    const out = applyRepair(input, []);
    expect(out.request.tools).toEqual(input.tools);
    expect(out.request.tools).not.toBe(input.tools as never);
    expect(out.applied).toEqual([]);
  });
});

describe("detectFake200 / shouldTreatAsError", () => {
  it("探针 E:200 + 顶层 error(code)→ fake 且 code 取 error.code", () => {
    expect(detectFake200(200, JSON.stringify({ error: { code: "upstream_timeout", message: "gateway" } }))).toEqual({
      fake: true,
      code: "upstream_timeout",
    });
  });

  it("error 只有 type 时 code 取 type", () => {
    expect(detectFake200(200, JSON.stringify({ error: { type: "invalid_request_error" } }))).toEqual({
      fake: true,
      code: "invalid_request_error",
    });
  });

  it("error 对象无 code/type → code=fake-200", () => {
    expect(detectFake200(200, JSON.stringify({ error: { message: "boom" } }))).toEqual({ fake: true, code: "fake-200" });
  });

  it("探针 F:200 正常 choices → fake=false", () => {
    expect(detectFake200(200, JSON.stringify(okBody))).toEqual({ fake: false });
  });

  it("200 无 choices/output/content 且含 error 关键词 → fake", () => {
    expect(detectFake200(200, JSON.stringify({ message: "internal failure" }))).toEqual({ fake: true, code: "fake-200" });
  });

  it("200 非 JSON 纯文本含 error 关键词 → fake", () => {
    expect(detectFake200(200, "upstream error: reset")).toEqual({ fake: true, code: "fake-200" });
  });

  it("200 无 choices 但无 error 关键词 → 不判伪(交解析层处理)", () => {
    expect(detectFake200(200, JSON.stringify({ result: "ok" }))).toEqual({ fake: false });
  });

  it("200 空 body / 有 content / 有 output → 不判伪", () => {
    expect(detectFake200(200, "")).toEqual({ fake: false });
    expect(detectFake200(200, JSON.stringify({ content: "hello" }))).toEqual({ fake: false });
    expect(detectFake200(200, JSON.stringify({ output: [{ type: "message" }] }))).toEqual({ fake: false });
  });

  it("非 200 一律 fake=false(交给 classifyModelError 按状态码分类)", () => {
    expect(detectFake200(500, JSON.stringify({ error: { message: "boom" } }))).toEqual({ fake: false });
    expect(detectFake200(400, "invalid request")).toEqual({ fake: false });
  });

  it("shouldTreatAsError 统一入口", () => {
    expect(shouldTreatAsError({ fake: true, code: "x" })).toBe(true);
    expect(shouldTreatAsError({ fake: false })).toBe(false);
    expect(shouldTreatAsError(true)).toBe(true);
    expect(shouldTreatAsError(false)).toBe(false);
  });
});

describe("openai-provider 接线(假 fetch)", () => {
  it("探针 G:首发 400 invalid_request → 改写后第二次成功,emit model_repair", async () => {
    const events: Array<Record<string, unknown>> = [];
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        call++;
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        if (call === 1) return jsonResponse({ error: { message: "invalid request: unsupported field" } }, 400);
        return jsonResponse(okBody);
      }),
    );
    const p = providerWith(events, { maxTokens: 8192 });
    const out = await p.chat(providerMessages, []);
    expect(out.content).toBe("ok");
    expect(call).toBe(2);
    expect(bodies[0]!.max_tokens).toBe(8192);
    expect(bodies[1]!.max_tokens).toBe(4096); // clamp-max-tokens 生效
    const repairs = events.filter((e) => e.type === "model_repair");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.code).toBe("invalid_request");
    expect(repairs[0]!.actions).toContain("strip-reasoning");
    expect(repairs[0]!.actions).toContain("clamp-max-tokens");
  });

  it("同 reason 第二次 400 → 只修一次,恰好 2 次请求后抛 ModelRequestError", async () => {
    const events: Array<Record<string, unknown>> = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        return jsonResponse({ error: { message: "invalid request: unsupported field" } }, 400);
      }),
    );
    const p = providerWith(events, { maxTokens: 8192 });
    await expect(p.chat(providerMessages, [])).rejects.toBeInstanceOf(ModelRequestError);
    expect(call).toBe(2);
    expect(events.filter((e) => e.type === "model_repair")).toHaveLength(1);
  });

  it("auth 401 → 1 次请求即抛,不发 model_repair", async () => {
    const events: Array<Record<string, unknown>> = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        return jsonResponse({ error: { message: "invalid api key" } }, 401);
      }),
    );
    const p = providerWith(events);
    const err = await p.chat(providerMessages, []).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRequestError);
    expect((err as ModelRequestError).kind).toBe("auth");
    expect(call).toBe(1);
    expect(events.filter((e) => e.type === "model_repair")).toHaveLength(0);
  });

  it("伪 200(200 + error body)按错误处理,不改当成功", async () => {
    const events: Array<Record<string, unknown>> = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        return jsonResponse({ error: { code: "upstream_timeout", message: "gateway error" } }, 200);
      }),
    );
    const p = providerWith(events);
    const err = await p.chat(providerMessages, []).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRequestError);
    expect((err as Error).message).toContain("伪 200");
    expect(call).toBe(1);
    expect(events.some((e) => e.type === "model_request_failed" && e.code === "upstream_timeout")).toBe(true);
  });

  it("200 正常 choices 路径零变化:成功返回且无 model_repair", async () => {
    const events: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(okBody)));
    const p = providerWith(events);
    const out = await p.chat(providerMessages, []);
    expect(out.content).toBe("ok");
    expect(events.filter((e) => e.type === "model_repair")).toHaveLength(0);
  });

  it("attemptedRepairs 是每次请求局部:第二次 chat 可再次修复一次", async () => {
    const events: Array<Record<string, unknown>> = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1 || call === 3) return jsonResponse({ error: { message: "invalid request: unsupported field" } }, 400);
        return jsonResponse(okBody);
      }),
    );
    const p = providerWith(events, { maxTokens: 8192 });
    expect((await p.chat(providerMessages, [])).content).toBe("ok");
    expect((await p.chat(providerMessages, [])).content).toBe("ok");
    expect(call).toBe(4);
    expect(events.filter((e) => e.type === "model_repair")).toHaveLength(2);
  });
});

// =============================================================================
// M122b:anthropic / responses 的 provider 请求体白名单改写(纯函数层)
// =============================================================================
describe("repairProviderBody:anthropic", () => {
  it("max_tokens>4096 → 夹到 4096,applied 记字段名", () => {
    const rp = repairProviderBody({ model: "m", max_tokens: 8192, messages: [] }, "anthropic");
    expect((rp.body as Record<string, unknown>).max_tokens).toBe(4096);
    expect(rp.applied).toEqual(["max_tokens"]);
  });

  it("max_tokens<256 → 抬到 256", () => {
    const rp = repairProviderBody({ max_tokens: 100 }, "anthropic");
    expect((rp.body as Record<string, unknown>).max_tokens).toBe(MIN_MAX_TOKENS);
    expect(rp.applied).toEqual(["max_tokens"]);
  });

  it("max_tokens 在区间内 → 不改、不记 applied", () => {
    const rp = repairProviderBody({ max_tokens: 2048 }, "anthropic");
    expect((rp.body as Record<string, unknown>).max_tokens).toBe(2048);
    expect(rp.applied).toEqual([]);
  });

  it("删 thinking(不认识的顶层字段之外一律不碰)", () => {
    const rp = repairProviderBody({ max_tokens: 2048, thinking: { type: "enabled", budget_tokens: 1024 }, temperature: 0.3 }, "anthropic");
    const body = rp.body as Record<string, unknown>;
    expect("thinking" in body).toBe(false);
    expect(body.temperature).toBe(0.3);
    expect(rp.applied).toEqual(["thinking"]);
  });

  it("metadata 只含未知键 → 删;含协议内已知键 user_id → 保留", () => {
    const unknownOnly = repairProviderBody({ metadata: { trace_id: "t" } }, "anthropic");
    expect("metadata" in (unknownOnly.body as Record<string, unknown>)).toBe(false);
    expect(unknownOnly.applied).toEqual(["metadata"]);

    const withKnown = repairProviderBody({ metadata: { user_id: "u", trace_id: "t" } }, "anthropic");
    expect((withKnown.body as Record<string, unknown>).metadata).toEqual({ user_id: "u", trace_id: "t" });
    expect(withKnown.applied).toEqual([]);
  });

  it("不可变:入参逐字不变,返回是新对象且 messages/tools 保持同一引用(内容不重写)", () => {
    const input = {
      max_tokens: 9999,
      thinking: { type: "enabled" },
      metadata: { trace_id: "t" },
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "getTime" }],
    };
    const snapshot = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    const rp = repairProviderBody(input, "anthropic");
    expect(input).toEqual(snapshot); // 入参未被修改
    expect(rp.body).not.toBe(input); // 浅拷贝新对象
    const body = rp.body as Record<string, unknown>;
    expect(body.messages).toBe(input.messages); // messages 内容原样(只改顶层白名单字段)
    expect(body.tools).toBe(input.tools);
    expect(rp.applied).toEqual(["max_tokens", "thinking", "metadata"]);
  });
});

describe("repairProviderBody:responses", () => {
  it("max_output_tokens 同上夹取,applied 记字段名", () => {
    const rp = repairProviderBody({ model: "m", max_output_tokens: 8192 }, "responses");
    expect((rp.body as Record<string, unknown>).max_output_tokens).toBe(MAX_MAX_TOKENS);
    expect(rp.applied).toEqual(["max_output_tokens"]);
  });

  it("删 reasoning;truncation 保留(删它会改响应完整性语义)", () => {
    const rp = repairProviderBody({ max_output_tokens: 100, reasoning: { effort: "high" }, truncation: "auto" }, "responses");
    const body = rp.body as Record<string, unknown>;
    expect(body.max_output_tokens).toBe(MIN_MAX_TOKENS);
    expect("reasoning" in body).toBe(false);
    expect(body.truncation).toBe("auto");
    expect(rp.applied).toEqual(["max_output_tokens", "reasoning"]);
  });

  it("不可变:入参逐字不变", () => {
    const input = { max_output_tokens: 8192, reasoning: { effort: "high" }, input: [{ role: "user", content: "x" }] };
    const snapshot = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    const rp = repairProviderBody(input, "responses");
    expect(input).toEqual(snapshot);
    expect(rp.body).not.toBe(input);
    expect((rp.body as Record<string, unknown>).input).toBe(input.input);
  });

  it("不认识的字段一律不删(只认白名单)", () => {
    const rp = repairProviderBody({ max_output_tokens: 1000, prompt_cache_key: "c", service_tier: "auto" }, "responses");
    const body = rp.body as Record<string, unknown>;
    expect(body.prompt_cache_key).toBe("c");
    expect(body.service_tier).toBe("auto");
    expect(rp.applied).toEqual([]);
  });
});

describe("repairProviderBody:异常/空态", () => {
  it("非对象 body → 原样返回 applied=[];不 throw", () => {
    for (const value of [null, undefined, "raw", 42, ["a"], true] as unknown[]) {
      const rp = repairProviderBody(value, "anthropic");
      expect(rp.body).toBe(value);
      expect(rp.applied).toEqual([]);
    }
  });

  it("空对象 → 无可改字段(applied=[]),返回等价新对象", () => {
    const rp = repairProviderBody({}, "responses");
    expect(rp.body).toEqual({});
    expect(rp.applied).toEqual([]);
  });
});
