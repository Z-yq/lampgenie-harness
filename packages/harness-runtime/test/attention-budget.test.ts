/**
 * 注意力预算与静默优先:词口径 / 长度预算 / 去重窗口 / 结构化提问 / 接线薄包装。
 * 纯函数直测;接线部分用假 askUser 证明「被拒时不触底、合法时放行」。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OUTBOUND_WORD_LIMITS,
  DEFAULT_DEDUPE_WINDOW_MS,
  countWords,
  validateOutbound,
  validateStructuredQuestion,
  truncateToBudget,
  truncateToWords,
  resetAttentionDedupe,
  guardAskUserPayload,
  guardRouteNote,
  guardTerminalNotice,
  hashOutboundText,
  looksStructured,
} from "../src/agent/attention-budget.ts";

const words = (n: number, prefix = "w") => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
const cjk = (n: number) => "甲".repeat(n);

afterEach(() => resetAttentionDedupe());

describe("词口径 countWords", () => {
  it("CJK 每字 1 词;拉丁按空白;数字串 1 词;中英混排", () => {
    expect(countWords("你好")).toBe(2);
    expect(countWords("hello world")).toBe(2);
    expect(countWords("你好 world 123")).toBe(4);
    expect(countWords("Release 2026-11-09 已上线")).toBe(5); // Release + 数字串 + 已上线 三字
    expect(countWords("你好,世界")).toBe(4); // 标点不单独计词
    expect(countWords("   ")).toBe(0);
    expect(countWords("")).toBe(0);
  });

  it("CJK 标点与 emoji 不计词", () => {
    expect(countWords("好?！…")).toBe(1);
  });
});

describe("长度预算 validateOutbound", () => {
  it("缺用途/未知用途 → OUTBOUND_NO_PURPOSE", () => {
    const a = validateOutbound({ kind: "chat", text: "hi" });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe("OUTBOUND_NO_PURPOSE");
    const b = validateOutbound({ kind: "chat", purpose: "spam", text: "hi" });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe("OUTBOUND_NO_PURPOSE");
  });

  it("空文本 → OUTBOUND_EMPTY", () => {
    const r = validateOutbound({ kind: "chat", purpose: "result", text: "   " });
    expect(r).toMatchObject({ ok: false, code: "OUTBOUND_EMPTY" });
  });

  it("confirm 40 词通过、41 词拒绝", () => {
    expect(OUTBOUND_WORD_LIMITS.confirm).toBe(40);
    expect(validateOutbound({ kind: "confirm", purpose: "confirm", text: words(40) }).ok).toBe(true);
    const r = validateOutbound({ kind: "confirm", purpose: "confirm", text: words(41) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("OUTBOUND_TOO_LONG");
      expect(r.words).toBe(41);
      expect(r.limit).toBe(40);
    }
  });

  it("chat 101 词拒绝;route-note 31 词拒绝;cross-ticket-note 101 词拒绝", () => {
    expect(validateOutbound({ kind: "chat", purpose: "result", text: words(101) })).toMatchObject({ ok: false, code: "OUTBOUND_TOO_LONG", limit: 100 });
    expect(validateOutbound({ kind: "route-note", purpose: "decision", text: words(31), windowMs: 0 })).toMatchObject({ ok: false, code: "OUTBOUND_TOO_LONG", limit: 30 });
    expect(validateOutbound({ kind: "cross-ticket-note", purpose: "result", text: words(101) })).toMatchObject({ ok: false, code: "OUTBOUND_TOO_LONG", limit: 100 });
  });

  it("超长附 truncated,截断到 limit 且带省略号", () => {
    const r = validateOutbound({ kind: "chat", purpose: "result", text: words(150) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("OUTBOUND_TOO_LONG");
      expect(r.truncated?.endsWith("…")).toBe(true);
      expect(countWords(r.truncated!)).toBe(100);
    }
  });

  it("truncateToBudget 未超预算原样返回;超预算带省略号", () => {
    expect(truncateToBudget("短消息", "chat")).toBe("短消息");
    const t = truncateToBudget(cjk(120), "chat");
    expect(t.endsWith("…")).toBe(true);
    expect(countWords(t)).toBe(100);
    expect(truncateToWords("one two three", 2)).toBe("one two…");
  });
});

describe("去重窗口", () => {
  it("同文两次第二次 DUPLICATE;窗口外放行;reset 生效", () => {
    const text = "同一段外发消息";
    const first = validateOutbound({ kind: "chat", purpose: "result", text, now: 0 });
    expect(first.ok).toBe(true);
    const second = validateOutbound({ kind: "chat", purpose: "result", text, now: 1000 });
    expect(second).toMatchObject({ ok: false, code: "OUTBOUND_DUPLICATE" });
    const outside = validateOutbound({ kind: "chat", purpose: "result", text, now: DEFAULT_DEDUPE_WINDOW_MS });
    expect(outside.ok).toBe(true);

    resetAttentionDedupe();
    expect(validateOutbound({ kind: "chat", purpose: "result", text, now: 2000 }).ok).toBe(true);
  });

  it("规范化后同文(空白/大小写不同)视为重复;hash 稳定", () => {
    const a = validateOutbound({ kind: "chat", purpose: "result", text: "Hello   World", now: 0 });
    expect(a.ok).toBe(true);
    const b = validateOutbound({ kind: "chat", purpose: "result", text: " hello world ", now: 1 });
    expect(b).toMatchObject({ ok: false, code: "OUTBOUND_DUPLICATE" });
    expect(hashOutboundText("Hello  World")).toBe(hashOutboundText("hello world"));
  });

  it("windowMs<=0 关闭去重(route note 不跨请求去重)", () => {
    const text = "批准:构建资源够用";
    expect(validateOutbound({ kind: "route-note", purpose: "decision", text, windowMs: 0 }).ok).toBe(true);
    expect(validateOutbound({ kind: "route-note", purpose: "decision", text, windowMs: 0 }).ok).toBe(true);
  });
});

describe("结构化提问 validateStructuredQuestion", () => {
  it("0 个问号 / 2 个问号 → ASK_MULTIPLE_QUESTIONS", () => {
    expect(validateStructuredQuestion("1. 选项甲 2. 选项乙")).toMatchObject({ ok: false, code: "ASK_MULTIPLE_QUESTIONS" });
    expect(validateStructuredQuestion("选哪个?都改吗?\n1. 是 2. 否")).toMatchObject({ ok: false, code: "ASK_MULTIPLE_QUESTIONS" });
  });

  it("无选项无字段 → ASK_NOT_STRUCTURED", () => {
    expect(validateStructuredQuestion("要不要都改?")).toMatchObject({ ok: false, code: "ASK_NOT_STRUCTURED" });
    expect(looksStructured("要不要都改?")).toBe(false);
  });

  it("编号选项 / A. 选项 / 「字段:」填空均可", () => {
    expect(validateStructuredQuestion("选哪个?\n1. 全量\n2. 只做字面")).toMatchObject({ ok: true });
    expect(validateStructuredQuestion("选哪个?\nA. 全量\nB. 只做字面")).toMatchObject({ ok: true });
    expect(validateStructuredQuestion("新模块叫什么?\n模块名: ____")).toMatchObject({ ok: true });
    expect(validateStructuredQuestion("范围如何?\n选项: 全量 / 字面")).toMatchObject({ ok: true });
  });

  it("超 120 词 → OUTBOUND_TOO_LONG", () => {
    const q = "1. 选项 " + cjk(121) + "?";
    const r = validateStructuredQuestion(q);
    expect(r).toMatchObject({ ok: false, code: "OUTBOUND_TOO_LONG", limit: 120 });
    if (!r.ok) {
      expect(r.truncated?.endsWith("…")).toBe(true);
      expect(countWords(r.truncated!)).toBe(120);
    }
  });
});

/** 复刻接线语义(与 agent-wiring.askUserTool 内联的三行同构):门失败不触底。 */
function askThroughGuard(
  askFn: (sid: string, p: { question: string; options?: string[]; context?: string }) => Promise<string | null>,
  payload: { question: string; options?: string[]; context?: string },
): Promise<string> {
  const g = guardAskUserPayload(payload);
  if (!g.ok) return Promise.resolve(g.message);
  return askFn("s1", { question: g.question, options: g.options, context: g.context }).then((v) => v ?? "(未答复)");
}

describe("接线薄包装(假 askUser)", () => {
  it("无结构提问被拒且不调用底层", async () => {
    const ask = vi.fn(async () => "x");
    const out = await askThroughGuard(ask, { question: "要不要都改?" });
    expect(out).toContain("ASK_NOT_STRUCTURED");
    expect(out).toContain("一次只问一个具体问题");
    expect(ask).not.toHaveBeenCalled();
  });

  it("多问号提问被拒且不调用底层", async () => {
    const ask = vi.fn(async () => "x");
    const out = await askThroughGuard(ask, { question: "改哪些?怎么改?\n1. 全量\n2. 字面" });
    expect(out).toContain("ASK_MULTIPLE_QUESTIONS");
    expect(ask).not.toHaveBeenCalled();
  });

  it("合法提问放行(options 即结构化选择项)", async () => {
    const ask = vi.fn(async () => "全量");
    const out = await askThroughGuard(ask, { question: "选哪个方案?", options: ["全量", "只做字面"] });
    expect(out).toBe("全量");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[1]).toMatchObject({ question: "选哪个方案?", options: ["全量", "只做字面"] });
  });

  it("长交付被截断且任务不失败(guardTerminalNotice)", () => {
    const g = guardTerminalNotice(cjk(200));
    expect(g.text.endsWith("…")).toBe(true);
    expect(countWords(g.text)).toBeLessThanOrEqual(100);
    expect(g.blocked).toMatchObject({ code: "OUTBOUND_TOO_LONG", kind: "chat" });
  });

  it("route note 40 词截到 30 词,批准语义不丢", () => {
    const g = guardRouteNote(words(40, "ok") + " 批准");
    expect(countWords(g.text)).toBeLessThanOrEqual(30);
    expect(g.text.endsWith("…")).toBe(true);
    expect(g.blocked?.kind).toBe("route-note");
    expect(guardRouteNote("批准:资源够用").blocked).toBeUndefined();
  });
});
