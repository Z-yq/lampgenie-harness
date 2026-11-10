/**
 * apiType 装配面直测(step-127):providers[].apiType 经 providerId 继承 →
 * buildLlmFromConfig/buildAudioChatFromConfig/buildLlmFromEnv → 请求落到对应协议端点
 * (URL/凭证头)。fetch 桩捕获 URL+headers+body(无网络;协议级端到端见
 * packages/harness-runtime/test/provider-apitypes.test.ts 的真 mock server)。
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { buildAudioChatFromConfig, buildLlmFromConfig, buildLlmFromEnv } from "../src/factory.js";
import type { Config } from "@lampgenie/core";

const origFetch = globalThis.fetch;
const origKey = process.env.GENIE_LLM_API_KEY;
const origApiType = process.env.GENIE_LLM_API_TYPE;
beforeEach(() => { process.env.GENIE_LLM_API_KEY = "test-key-not-real"; });
afterEach(() => {
  globalThis.fetch = origFetch;
  if (origKey === undefined) delete process.env.GENIE_LLM_API_KEY; else process.env.GENIE_LLM_API_KEY = origKey;
  if (origApiType === undefined) delete process.env.GENIE_LLM_API_TYPE; else process.env.GENIE_LLM_API_TYPE = origApiType;
});

/** providers[] 带一个 anthropic/responses 条目 + coding.llm 挂 providerId 的配置。 */
const configWith = (apiType: "chat" | "responses" | "anthropic" | undefined) => ({
  coding: { llm: { providerId: "p1", model: "m1" }, models: {}, disabledModels: [] },
  audio: { chat: { providerId: "p1", model: "a1" }, asr: {}, tts: {} },
  providers: [{ id: "p1", name: "", baseUrl: "https://llm.test", apiKeyEnv: "K", ...(apiType ? { apiType } : {}), models: [] }],
  executor: { kind: "echo" },
  gateway: { port: 7700, panel: true },
} as unknown as Config);

function capture(): { url: string | undefined; headers: Record<string, string>; body: Record<string, unknown> } {
  const state = { url: undefined as string | undefined, headers: {} as Record<string, string>, body: {} as Record<string, unknown> };
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    state.url = String(url);
    state.headers = (init?.headers ?? {}) as Record<string, string>;
    state.body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    // 各协议的最小合法应答(chat/anthropic/responses 三形态共容的字段不存在——按 URL 分派)
    if (String(url).endsWith("/v1/messages")) {
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).endsWith("/v1/responses")) {
      return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return state;
}

describe("apiType 装配面(providerId 继承 → 协议端点)", () => {
  it("providers[].apiType=anthropic → /v1/messages + x-api-key(无 Bearer);system 分离", async () => {
    const st = capture();
    const llm = buildLlmFromConfig(configWith("anthropic"), "/tmp")!;
    const r = await llm.chat([{ role: "system", content: "S" }, { role: "user", content: "hi" }], []);
    expect(r.content).toBe("ok");
    expect(st.url).toBe("https://llm.test/v1/messages");
    expect(st.headers["x-api-key"]).toBe("test-key-not-real");
    expect(st.headers["anthropic-version"]).toBe("2023-06-01");
    expect(st.headers["authorization"]).toBeUndefined();
    expect(st.body.system).toEqual([{ type: "text", text: "S", cache_control: { type: "ephemeral" } }]);
  });

  it("providers[].apiType=responses → /v1/responses + Bearer(无 x-api-key);input 数组", async () => {
    const st = capture();
    const llm = buildLlmFromConfig(configWith("responses"), "/tmp")!;
    const r = await llm.chat([{ role: "system", content: "S" }, { role: "user", content: "hi" }], []);
    expect(r.content).toBe("ok");
    expect(st.url).toBe("https://llm.test/v1/responses");
    expect(st.headers["authorization"]).toBe("Bearer test-key-not-real");
    expect(st.headers["x-api-key"]).toBeUndefined();
    expect(Array.isArray(st.body.input)).toBe(true);
  });

  it("providers 条目未声明 apiType → chat 现状(/v1/chat/completions)", async () => {
    const st = capture();
    const llm = buildLlmFromConfig(configWith(undefined), "/tmp")!;
    await llm.chat([{ role: "user", content: "hi" }], []);
    expect(st.url).toBe("https://llm.test/v1/chat/completions");
    expect(st.headers["authorization"]).toBe("Bearer test-key-not-real");
  });

  it("audio.chat 轨同样经 providerId 继承 apiType(anthropic);凭证按 audio 命名空间(不回落 GENIE_LLM_API_KEY)", async () => {
    // audio 轨不回落 coding 旧直传(双轨红线)——provider 条目 apiKeyEnv=K 必须显式在场
    const origK = process.env.K;
    process.env.K = "test-key-not-real";
    try {
      const st = capture();
      const llm = buildAudioChatFromConfig(configWith("anthropic"), "/tmp")!;
      await llm!.chat([{ role: "user", content: "hi" }], []);
      expect(st.url).toBe("https://llm.test/v1/messages");
      expect(st.headers["x-api-key"]).toBe("test-key-not-real");
    } finally {
      if (origK === undefined) delete process.env.K; else process.env.K = origK;
    }
  });

  it("部分配置无 coding 段 → buildLlmFromConfig 返回 undefined 不抛(与 buildVlmFromConfig 同语义)", () => {
    // 回归:file-tools-e2e 用 { agent: { planGate } } 这类部分配置建 app,曾在此崩(llm 读取 undefined.llm)。
    expect(() => buildLlmFromConfig({ agent: {} } as never, "/tmp")).not.toThrow();
    expect(buildLlmFromConfig({ agent: {} } as never, "/tmp")).toBeUndefined();
    // coding 段在但无 model 也算未配置(不拿空模型去打端点)。
    expect(buildLlmFromConfig({ coding: { llm: {} } } as never, "/tmp")).toBeUndefined();
  });

  it("buildLlmFromEnv:GENIE_LLM_API_TYPE=responses → /v1/responses;未设/非法值=chat", async () => {
    const origBase = process.env.GENIE_LLM_BASE_URL;
    const origModel = process.env.GENIE_LLM_MODEL;
    process.env.GENIE_LLM_BASE_URL = "https://llm.test";
    process.env.GENIE_LLM_MODEL = "m";
    process.env.GENIE_LLM_API_TYPE = "responses";
    let st = capture();
    await buildLlmFromEnv()!.chat([{ role: "user", content: "x" }], []);
    expect(st.url).toBe("https://llm.test/v1/responses");
    delete process.env.GENIE_LLM_API_TYPE;
    st = capture();
    await buildLlmFromEnv()!.chat([{ role: "user", content: "x" }], []);
    expect(st.url).toBe("https://llm.test/v1/chat/completions");
    process.env.GENIE_LLM_API_TYPE = "bogus";
    st = capture();
    await buildLlmFromEnv()!.chat([{ role: "user", content: "x" }], []);
    expect(st.url).toBe("https://llm.test/v1/chat/completions");
    if (origBase === undefined) delete process.env.GENIE_LLM_BASE_URL; else process.env.GENIE_LLM_BASE_URL = origBase;
    if (origModel === undefined) delete process.env.GENIE_LLM_MODEL; else process.env.GENIE_LLM_MODEL = origModel;
  });
});
