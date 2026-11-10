import { describe, it, expect } from "vitest";
import {
  createVoiceParser, parseAudioDataUrl, parseVoiceTranscript, MAX_AUDIO_BYTES,
  VOICE_PARSE_MODEL, VOICE_TRANSCRIBE_PROMPT,
} from "../src/annotate-voice.js";

/** 录音转写(annotate.submit 的口述输入)服务端契约:
 * ①dataURL 形态/格式/8MB 上限;②模型返回的段落解析(JSON 优先,非 JSON 整段);
 * ③HTTP 错误与超时给可读错;④请求形态(text+input_audio)与端点归一(/v1 不重复拼)。 */

/** 最小 Response 替身(mock fetch 返回;避免依赖全局 Response 实现差异)。 */
function res(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const AUDIO = "data:audio/webm;codecs=opus;base64," + Buffer.from("fake-opus-bytes").toString("base64");
const OK_PARSER = { baseUrl: "https://example.test/v1", model: VOICE_PARSE_MODEL, apiKey: "sk-test" };

describe("parseAudioDataUrl", () => {
  it("webm/opus dataURL:字节+format+mime", () => {
    const audio = parseAudioDataUrl(AUDIO);
    expect(audio.format).toBe("webm");
    expect(audio.mime).toBe("audio/webm");
    expect(audio.bytes.toString()).toBe("fake-opus-bytes");
    expect(parseAudioDataUrl("data:audio/mpeg;base64," + Buffer.from("x").toString("base64")).format).toBe("mp3");
    expect(parseAudioDataUrl("data:audio/mp4;base64," + Buffer.from("x").toString("base64")).format).toBe("m4a");
    expect(parseAudioDataUrl("data:audio/wav;base64," + Buffer.from("x").toString("base64")).format).toBe("wav");
  });
  it("非 audio/* dataURL 拒绝", () => {
    expect(() => parseAudioDataUrl("data:image/png;base64,AAAA")).toThrow(/audio/);
    expect(() => parseAudioDataUrl("https://x/a.webm")).toThrow(/dataURL/);
    expect(() => parseAudioDataUrl("data:audio/ogg;base64,AAAA")).toThrow(/格式不支持/);
  });
  it(">8MB 拒绝(可读错带 MB 数)", () => {
    const big = "data:audio/webm;base64," + Buffer.alloc(MAX_AUDIO_BYTES + 1024).toString("base64");
    expect(() => parseAudioDataUrl(big)).toThrow(/8MB/);
  });
  it("空音频拒绝", () => {
    expect(() => parseAudioDataUrl("data:audio/webm;base64,")).toThrow(/空/);
  });
});

describe("parseVoiceTranscript", () => {
  it("JSON 段落:{segments:[{time|at,text}]} → 分行 + 全文", () => {
    const out = parseVoiceTranscript({
      choices: [{ message: { content: JSON.stringify({ segments: [{ time: "0:01", text: "左上角按钮太小" }, { at: "0:05", text: "整体间距偏紧" }] }) } }],
    });
    expect(out.segments).toEqual([{ at: "0:01", text: "左上角按钮太小" }, { at: "0:05", text: "整体间距偏紧" }]);
    expect(out.text).toBe("左上角按钮太小\n整体间距偏紧");
  });
  it("JSON 带 ``` 围栏 + {text} 形态", () => {
    const out = parseVoiceTranscript("```json\n{\"text\":\"就这一句\"}\n```");
    expect(out.text).toBe("就这一句");
    expect(out.segments).toEqual([]);
  });
  it("非 JSON → 整段作文本、segments 为空", () => {
    const out = parseVoiceTranscript({ choices: [{ message: { content: "[左上] 这个按钮太小了\n[中部] 表格挤成一团" } }] });
    expect(out.text).toContain("这个按钮太小了");
    expect(out.segments).toEqual([]);
  });
  it("空返回拒绝", () => {
    expect(() => parseVoiceTranscript({ choices: [{ message: { content: "   " } }] })).toThrow(/为空/);
  });
});

describe("createVoiceParser", () => {
  it("缺 apiKey → 可读错", () => {
    expect(() => createVoiceParser({ ...OK_PARSER, apiKey: "" })).toThrow(/API Key/);
  });
  it("请求形态:端点归一(baseUrl 自带 /v1 不重复拼)+ text/input_audio 两段", async () => {
    const calls: { url: string; body: { messages: { content: { type: string }[] }[] } }[] = [];
    const parser = createVoiceParser({
      ...OK_PARSER,
      fetchImpl: (async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return res({ choices: [{ message: { content: JSON.stringify({ text: "按钮太小" }) } }] });
      }) as unknown as typeof fetch,
    });
    const audio = parseAudioDataUrl(AUDIO);
    const out = await parser(audio.bytes, audio.mime);
    expect(out.text).toBe("按钮太小");
    expect(calls[0].url).toBe("https://example.test/v1/chat/completions");
    const content = calls[0].body.messages[0].content;
    expect(content.map((c) => c.type)).toEqual(["text", "input_audio"]);
    expect(JSON.stringify(content)).toContain(VOICE_TRANSCRIBE_PROMPT.slice(0, 12));
  });
  it("HTTP 500 → 错信息含状态", async () => {
    const parser = createVoiceParser({
      ...OK_PARSER,
      fetchImpl: (async () => res("upstream exploded", 500)) as unknown as typeof fetch,
    });
    const audio = parseAudioDataUrl(AUDIO);
    await expect(parser(audio.bytes, audio.mime)).rejects.toThrow(/HTTP 500/);
  });
  it("超时 → 可读错(默认/显式 timeoutMs)", async () => {
    const parser = createVoiceParser({
      ...OK_PARSER, timeoutMs: 20,
      fetchImpl: ((_url: string, init: { signal?: AbortSignal }) => new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      })) as unknown as typeof fetch,
    });
    const audio = parseAudioDataUrl(AUDIO);
    await expect(parser(audio.bytes, audio.mime)).rejects.toThrow(/超时/);
  });
});
