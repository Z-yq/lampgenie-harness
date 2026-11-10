/**
 * audio.chat 形态分派直测(2026-10-21 音频链路优化,genie-voice 两口径):
 * - resolveAudioChatMode:显式 chatMode > 显式 protocol > 模型名推断(qwen3.8-omni*→omni-query;
 *   qwen-audio-3.1-realtime*→realtime-plus);
 * - omni-query 装配面:一次 query 里音频作为输入内容(input_audio 内容件,pcm16 自动包 WAV data URL);
 * - realtime-plus 装配面:走 realtime WS provider(realtime provider 无 describe 面——与 openai-compat 区分)。
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { buildAudioChatFromConfig, resolveAudioChatMode } from "../src/factory.js";
import type { Config } from "@lampgenie/core";

const origFetch = globalThis.fetch;
beforeEach(() => { process.env.GENIE_LLM_API_KEY = "test-key-not-real"; });
afterEach(() => { globalThis.fetch = origFetch; });

describe("resolveAudioChatMode(缺省按模型名推断)", () => {
  it("显式 chatMode 最优先;显式 protocol 次之;模型名 /realtime/i → realtime-plus;其余 → omni-query", () => {
    // 显式 chatMode 压过一切
    expect(resolveAudioChatMode({ model: "qwen-audio-3.1-realtime-plus", chatMode: "omni-query" })).toBe("omni-query");
    expect(resolveAudioChatMode({ model: "qwen3.8-omni-flash", chatMode: "realtime-plus" })).toBe("realtime-plus");
    // 显式 protocol
    expect(resolveAudioChatMode({ model: "whatever", protocol: "chat" })).toBe("omni-query");
    expect(resolveAudioChatMode({ model: "whatever", protocol: "realtime" })).toBe("realtime-plus");
    // 模型名推断(两口径)
    expect(resolveAudioChatMode({ model: "qwen3.8-omni-flash" })).toBe("omni-query");
    expect(resolveAudioChatMode({ model: "qwen-audio-3.1-realtime-plus" })).toBe("realtime-plus");
    // 其余(文本模型/未配置形态)=omni-query(一次 query,文本出+tts)
    expect(resolveAudioChatMode({ model: "glm-5.3" })).toBe("omni-query");
    expect(resolveAudioChatMode({})).toBe("omni-query");
  });
});

/** audio.chat 直挂 baseUrl 的最小配置(model 可换)。 */
const audioCfg = (model: string, extra: Record<string, unknown> = {}) => ({
  audio: { chat: { baseUrl: "https://llm.test", model, apiKeyEnv: "GENIE_LLM_API_KEY", ...extra }, asr: {}, tts: {} },
  coding: { llm: { providerId: "p1", model: "m1" }, models: {}, disabledModels: [] },
  providers: [{ id: "p1", name: "", baseUrl: "https://llm.test", apiKeyEnv: "K", models: [] }],
  executor: { kind: "echo" },
  gateway: { port: 7700, panel: true },
} as unknown as Config);

function capture() {
  const state = { url: undefined as string | undefined, body: {} as Record<string, unknown> };
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    state.url = String(url);
    state.body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return state;
}

describe("buildAudioChatFromConfig 形态分派", () => {
  it("omni-query(qwen3.8-omni*):一次 query——音频作为输入内容直接进 chat(input_audio/WAV data URL),文本出", async () => {
    const st = capture();
    const llm = buildAudioChatFromConfig(audioCfg("qwen3.8-omni-flash"), "/tmp")!;
    const r = await llm.chat([{ role: "user", content: "(语音输入)", audio: { data: Buffer.from("pcm16!").toString("base64"), format: "pcm16" } }], []);
    expect(r.content).toBe("ok");
    expect(st.url).toBe("https://llm.test/v1/chat/completions");
    // 内容件:text + input_audio(pcm16 裸流自动包 WAV 容器,genie-voice omni 实证形态)
    const content = (st.body.messages as { content: unknown }[])[0]!.content as { type: string; input_audio?: { data: string; format: string } }[];
    expect(content[0]).toEqual({ type: "text", text: "(语音输入)" });
    expect(content[1]!.type).toBe("input_audio");
    expect(content[1]!.input_audio!.format).toBe("wav");
    expect(content[1]!.input_audio!.data.startsWith("data:audio/wav;base64,UklGR")).toBe(true);
  });

  it("realtime-plus(qwen-audio-3.1-realtime*):装配 realtime WS provider(无 describe 面=openai-compat 才有)", () => {
    const llm = buildAudioChatFromConfig(audioCfg("qwen-audio-3.1-realtime-plus"), "/tmp")!;
    expect(llm).toBeDefined();
    expect(typeof llm.chat).toBe("function");
    expect((llm as unknown as { describe?: unknown }).describe).toBeUndefined();
    expect((llm as { modelName?: string }).modelName).toBe("qwen-audio-3.1-realtime-plus");
  });

  it("显式 chatMode=omni-query 压过 realtime 模型名(回退一次 query 口径)", async () => {
    const st = capture();
    const llm = buildAudioChatFromConfig(audioCfg("qwen-audio-3.1-realtime-plus", { chatMode: "omni-query", protocol: "chat" }), "/tmp")!;
    await llm.chat([{ role: "user", content: "hi" }], []);
    expect(st.url).toBe("https://llm.test/v1/chat/completions");
  });
});
