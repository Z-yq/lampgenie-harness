/**
 * voice.tts 播报链单测(step-014 二期收口):qwen-tts 客户端构造/请求形态/URL 取音频;
 * 未配置=undefined(诚实降级);brief 级改写器走 voice 包 rewriteForSpeech。
 */
import { describe, it, expect, afterEach } from "vitest";
import { buildTtsFromConfig } from "../src/factory.js";
import { rewriteForSpeech } from "@lampgenie/runtime/voice/panel";
import type { Config } from "@lampgenie/core";

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function cfgWith(over: Record<string, unknown> = {}): Config {
  return {
    audio: { tts: { baseUrl: "https://tts.test", model: "qwen3-tts-flash", apiKeyEnv: "GENIE_TTS_TEST_KEY", ...over } },
  } as unknown as Config;
}

describe("buildTtsFromConfig", () => {
  it("未配置=undefined(不假做)", () => {
    expect(buildTtsFromConfig({ audio: { tts: {} } } as unknown as Config, "/tmp")).toBeUndefined();
  });

  it("凭证缺失抛错(fail-visible)", () => {
    delete process.env.GENIE_TTS_TEST_KEY;
    expect(() => buildTtsFromConfig(cfgWith(), "/tmp")).toThrow(/凭证不可解析/);
  });

  it("speak:POST 形态(qwen-tts)→OSS URL 取音频→base64 回传", async () => {
    process.env.GENIE_TTS_TEST_KEY = "sk-tts-test";
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/services/audio/tts")) {
        return new Response(JSON.stringify({ output: { audio: { url: "https://oss.test/a.wav" } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/wav" } });
    }) as typeof fetch;
    const tts = buildTtsFromConfig(cfgWith(), "/tmp")!;
    const out = await tts.speak("你好");
    expect(out.mime).toBe("audio/wav");
    expect(Buffer.from(out.base64, "base64")).toEqual(Buffer.from([1, 2, 3, 4]));
    const req = JSON.parse(String(calls[0]!.init!.body)) as { model: string; input: { text: string } };
    expect(req.model).toBe("qwen3-tts-flash");
    expect(req.input.text).toBe("你好");
    expect(calls[0]!.init!.headers && (calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer sk-tts-test");
    expect(calls[1]!.url).toBe("https://oss.test/a.wav");
    delete process.env.GENIE_TTS_TEST_KEY;
  });

  it("HTTP 错误抛错(消息不含凭证)", async () => {
    process.env.GENIE_TTS_TEST_KEY = "sk-tts-test";
    globalThis.fetch = (async () => new Response("denied", { status: 403 })) as typeof fetch;
    const tts = buildTtsFromConfig(cfgWith(), "/tmp")!;
    await expect(tts.speak("x")).rejects.toThrow(/tts 403/);
    delete process.env.GENIE_TTS_TEST_KEY;
  });

  it("config.voice 进请求体;URL=SpeechSynthesizer 路径(2026-10-13 音色生效锚)", async () => {
    process.env.GENIE_TTS_TEST_KEY = "sk-tts-test";
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ output: { audio: { data: "AAAA", mime: "audio/wav" } } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const tts = buildTtsFromConfig(cfgWith({ voice: "longanhuan_v3.1" }), "/tmp")!;
    await tts.speak("测试");
    expect(calls[0]!.url).toBe("https://tts.test/api/v1/services/audio/tts/SpeechSynthesizer");
    const req = JSON.parse(String(calls[0]!.init!.body)) as { input: { voice?: string; format?: string } };
    expect(req.input.voice).toBe("longanhuan_v3.1");
    expect(req.input.format).toBe("wav");
    delete process.env.GENIE_TTS_TEST_KEY;
  });

  it("speak 单次 voice 覆盖(2026-10-20 试听):该次请求生效、后续请求回落配置音色", async () => {
    process.env.GENIE_TTS_TEST_KEY = "sk-tts-test";
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init!.body));
      return new Response(JSON.stringify({ output: { audio: { data: "AAAA", mime: "audio/wav" } } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const tts = buildTtsFromConfig(cfgWith({ voice: "longanhuan_v3.1" }), "/tmp")!;
    await tts.speak("试听", { voice: "Emily_v3.1" });
    await tts.speak("正常播报");
    const r1 = JSON.parse(bodies[0]!) as { input: { voice?: string } };
    const r2 = JSON.parse(bodies[1]!) as { input: { voice?: string } };
    expect(r1.input.voice).toBe("Emily_v3.1"); // 覆盖值进该次请求
    expect(r2.input.voice).toBe("longanhuan_v3.1"); // 不落配置,回落 config.voice
    delete process.env.GENIE_TTS_TEST_KEY;
  });

  it("配置无 voice 时,覆盖值仍生效;无覆盖时请求体不带 voice(端点默认)", async () => {
    process.env.GENIE_TTS_TEST_KEY = "sk-tts-test";
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init!.body));
      return new Response(JSON.stringify({ output: { audio: { data: "AAAA", mime: "audio/wav" } } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const tts = buildTtsFromConfig(cfgWith(), "/tmp")!;
    await tts.speak("带覆盖", { voice: "Cherry" });
    await tts.speak("不带覆盖");
    const r1 = JSON.parse(bodies[0]!) as { input: { voice?: string } };
    const r2 = JSON.parse(bodies[1]!) as { input: { voice?: string } };
    expect(r1.input.voice).toBe("Cherry");
    expect(r2.input.voice).toBeUndefined();
    delete process.env.GENIE_TTS_TEST_KEY;
  });

  it("假 RIFF 头就地修复(声明长度=真实数据长度,2026-10-13)", async () => {
    process.env.GENIE_TTS_TEST_KEY = "sk-tts-test";
    // 构造假 RIFF:RIFF 块长与 data 块长都写垃圾值(0xFFFFFFFF),实际 payload 6 字节
    const payload = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    const wav = Buffer.concat([
      Buffer.from("RIFF", "ascii"), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from("WAVE", "ascii"),
      Buffer.from("fmt ", "ascii"), Buffer.from([0x10, 0, 0, 0]), Buffer.alloc(16),
      Buffer.from("data", "ascii"), Buffer.from([0xff, 0xff, 0xff, 0xff]), payload,
    ]);
    globalThis.fetch = (async () => {
      if ((globalThis as { __ttsSecond?: boolean }).__ttsSecond) return new Response(new Uint8Array(wav), { status: 200, headers: { "content-type": "audio/wav" } });
      (globalThis as { __ttsSecond?: boolean }).__ttsSecond = true;
      return new Response(JSON.stringify({ output: { audio: { url: "https://oss.test/fake.wav" } } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const tts = buildTtsFromConfig(cfgWith(), "/tmp")!;
    const out = await tts.speak("修复");
    const buf = Buffer.from(out.base64, "base64");
    expect(buf.readUInt32LE(4)).toBe(buf.length - 8); // RIFF 总长
    const dataOff = buf.indexOf("data", 12, "ascii");
    expect(buf.readUInt32LE(dataOff + 4)).toBe(buf.length - dataOff - 8); // data 块长
    delete (globalThis as { __ttsSecond?: boolean }).__ttsSecond;
    delete process.env.GENIE_TTS_TEST_KEY;
  });
});

describe("rewriteForSpeech(brief 级改写器,voice 包入主链的锚)", () => {
  it("代码块→占位、去 markdown 符号、限长", () => {
    const out = rewriteForSpeech("# 标题\n```js\nconsole.log(1);\n```\n做完了", 30);
    expect(out).toContain("代码已就绪");
    expect(out).not.toContain("console");
    expect(out).not.toContain("#");
    expect(out.length).toBeLessThanOrEqual(30);
  });
});
