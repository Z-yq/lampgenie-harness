/**
 * sanitizeLoneSurrogates 单测:孤立 UTF-16 代理码元清洗。
 * 事故链:grep content 行截断 .slice(0,200) 切在 🎙(U+1F399=D83C DF99)中间 →
 * 消息 content 带孤立高位 D83C → JSON.stringify 输出 \ud83c → DeepSeek(serde_json)
 * 高位代理后找 \uXXXX 低位代理落空 → 400 "unexpected end of hex escape"。
 */
import { describe, it, expect } from "vitest";
import { sanitizeLoneSurrogates } from "../src/agent/openai-provider.js";

const hasLone = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const n = s.charCodeAt(i + 1); if (!(n >= 0xdc00 && n <= 0xdfff)) return true; }
    else if (c >= 0xdc00 && c <= 0xdfff) { const p = s.charCodeAt(i - 1); if (!(p >= 0xd800 && p <= 0xdbff)) return true; }
  }
  return false;
};

describe("sanitizeLoneSurrogates", () => {
  it("无代理码元的文本原样返回(同一引用,零拷贝快路径)", () => {
    const s = "普通中文 English 123\n\t{json:\"文本\"}";
    expect(sanitizeLoneSurrogates(s)).toBe(s);
  });

  it("完整代理对(emoji)原样保留", () => {
    const s = "小按钮 🎙 删除";
    const out = sanitizeLoneSurrogates(s);
    expect(out).toBe(s);
    expect(hasLone(out)).toBe(false);
  });

  it("孤立高位/孤立低位各替换为 U+FFFD", () => {
    const loneHigh = "小按钮 \uD83C\nnext"; // 事故形态:高位后直接换行
    expect(sanitizeLoneSurrogates(loneHigh)).toBe("小按钮 \uFFFD\nnext");
    const loneLow = "a\u{1F399}".slice(0, 2) + "b"; // 人造:低位开头
    expect(hasLone(sanitizeLoneSurrogates(loneLow))).toBe(false);
    expect(sanitizeLoneSurrogates("x\uDC99y")).toBe("x\uFFFDy");
  });

  it("连续多代理混合(成对+孤立交错)逐码元正确处理", () => {
    const s = "\uD83C\uDF99 a \uD83C b \uDC99 c \uD83C\uDF99";
    const out = sanitizeLoneSurrogates(s);
    expect(hasLone(out)).toBe(false);
    expect(out).toBe("\uD83C\uDF99 a \uFFFD b \uFFFD c \uD83C\uDF99");
  });

  it("序列化往返:清洗后的文本 stringify 产物不含高位代理后非低位代理的转义", () => {
    const dirty = "lampgenie-harness/AGENTS.md:152: 框呼吸);小按钮 \uD83C\nlampgenie-harness/AGENTS.md:153: -";
    const clean = sanitizeLoneSurrogates(dirty);
    const wire = JSON.stringify({ content: clean });
    // serde_json 事故判定:解析时高位代理转义后必须紧跟 \uXXXX 低位代理转义
    const escRe = /\\u(d[89ab][0-9a-f]{2})/gi;
    let m: RegExpExecArray | null;
    while ((m = escRe.exec(wire)) !== null) {
      const next = wire.slice(m.index + m[0].length, m.index + m[0].length + 2);
      expect(next.toLowerCase()).toMatch(/^\\u(d[cdef][0-9a-f]{2})/);
    }
    expect(hasLone(clean)).toBe(false);
  });

  it("尾部孤立高位(截断最常见形态)清洗后可安全截短", () => {
    expect(hasLone(sanitizeLoneSurrogates("abc\uD83C"))).toBe(false);
  });
});
