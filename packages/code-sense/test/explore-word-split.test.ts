/**
 * explore 短语分词(用户用户反馈:「code_sense explore 'tts voice audio chat' → 零命中」)。
 * 根因:normalizeQuery 只做 camel↔snake 变换,空格多词短语原样进 grep——代码里永远没有
 * "tts voice audio chat" 这个字面量,必然零命中;而拆词后 tts|audio 命中大量真行。
 * 契约:≥2 个英文词的短语 → 词根组(any 命中)+ ≥4 字符单词单列;单词/camelCase 查询零影响。
 */
import { describe, it, expect } from "vitest";
import { normalizeQuery } from "../src/search";

describe("normalizeQuery 短语分词", () => {
  it("多词英文短语:整句保留 + 词根组 + 高特异单词单列", () => {
    const v = normalizeQuery("tts voice audio chat");
    expect(v).toContain("tts voice audio chat");
    expect(v).toContain("tts|voice|audio|chat");
    expect(v).toContain("audio");
    expect(v).toContain("voice");
    expect(v).toContain("chat");
    expect(v).not.toContain("tts"); // <4 字符不单列(会洪泛),只在词根组里
  });

  it("单词/camelCase 查询零影响(不变换出词根组)", () => {
    expect(normalizeQuery("tts")).toEqual(["tts"]);
    expect(normalizeQuery("buildTtsClient")).toEqual(["buildTtsClient", "build_tts_client", "build-tts-client"]);
    expect(normalizeQuery("buildTtsClient")).not.toContain("buildTtsClient|build_tts_client");
  });

  it("中文混合短语不带英文词时不拆", () => {
    const v = normalizeQuery("语音合成");
    expect(v.some((x) => x.includes("|"))).toBe(false);
  });
});
