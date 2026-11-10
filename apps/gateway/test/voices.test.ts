/**
 * 音色清单单测(2026-10-20 音色选择+试听):
 * voicesForModel 按模型分组返回官方清单;未知模型=空表(自定义 id 兜底)。
 * 真源:help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list / qwen-tts-voice-list。
 */
import { describe, it, expect } from "vitest";
import { voicesForModel } from "../src/voices.js";

describe("voicesForModel", () => {
  it("qwen-audio-3.1-tts-flash:分组清单,含用户在用的 longanhuan_v3.1", () => {
    const vs = voicesForModel("qwen-audio-3.1-tts-flash");
    expect(vs.length).toBeGreaterThan(30);
    const ids = vs.map((v) => v.id);
    expect(ids).toContain("longanhuan_v3.1");
    expect(ids).toContain("longanlingxin_v3.1");
    expect(ids).toContain("xunanchuan_v3.1");
    expect(ids).toContain("Emily_v3.1"); // 精品英文(大小写敏感)
    // 每条都有 group(前端分组渲染依赖)
    expect(vs.every((v) => v.group && v.name && v.id)).toBe(true);
  });

  it("大小写敏感锚:Emily_v3.1 与 Emily 不是同一 id(官方口径 voice 区分大小写)", () => {
    const vs31 = voicesForModel("qwen-audio-3.1-tts-flash");
    expect(vs31.some((v) => v.id === "Emily_v3.1")).toBe(true);
    const vs3tts = voicesForModel("qwen3-tts-flash");
    // qwen3-tts 的英文音色是单词 id(Cherry 等),不带 _v3.1 后缀
    expect(vs3tts.some((v) => v.id === "Cherry")).toBe(true);
    expect(vs3tts.some((v) => v.id === "Emily_v3.1")).toBe(false);
  });

  it("3.0 模型族:plus 与 flash 清单不同(跨模型不能混用)", () => {
    const plus = voicesForModel("qwen-audio-3.0-tts-plus").map((v) => v.id);
    const flash = voicesForModel("qwen-audio-3.0-tts-flash").map((v) => v.id);
    expect(plus).toContain("longanlingxin");
    expect(flash).toContain("longanfengyue");
    expect(plus).not.toContain("longanfengyue");
  });

  it("qwen3-tts 含方言组(上海话/粤语等)", () => {
    const vs = voicesForModel("qwen3-tts-flash");
    expect(vs.some((v) => v.group.includes("方言") && v.id === "Rocky")).toBe(true);
    expect(vs.length).toBeGreaterThan(40);
  });

  it("未知模型(cosyvoice/minimax/空)=空表——不瞎给清单", () => {
    expect(voicesForModel("cosyvoice-v3-flash")).toEqual([]);
    expect(voicesForModel("")).toEqual([]);
    expect(voicesForModel("MiniMax/speech-2.8-hd")).toEqual([]);
  });

  it("id 无重复(选择/勾选按 id 判等)", () => {
    for (const model of ["qwen-audio-3.1-tts-flash", "qwen-audio-3.0-tts-plus", "qwen-audio-3.0-tts-flash", "qwen3-tts-flash"]) {
      const ids = voicesForModel(model).map((v) => v.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
