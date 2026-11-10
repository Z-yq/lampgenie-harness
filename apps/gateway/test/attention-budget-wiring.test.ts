/**
 * 接线验证(gateway 侧,假 askUser/broker):
 * a. ask_user 无结构提问 → 工具错误(稳定码+可操作提示),askUser.ask 调用 0 次(不落面板);
 * b. 合法提问(带编号 options)→ 原路径放行;
 * c. answer_subagent 的 reason 超 30 词 → 截断后仍解答(批准语义不丢);
 * d. 终端交付摘要超预算 → 截断交付 + 只多一条 custom attention.blocked,任务不失败。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Journal } from "@lampgenie/core";
import type { Tool } from "@lampgenie/runtime/agent/loop";
import { askUserTool, withAnswerAttentionGuard, deliverFinalNoticeWithAttention } from "../src/agent-wiring.js";
import { resetAttentionDedupe, countWords } from "@lampgenie/runtime/agent/attention-budget";
import { resetSubagentDeliveryStateForTest } from "../src/subagent-result-digest.js";

const words = (n: number, prefix = "w") => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

afterEach(() => {
  resetAttentionDedupe();
  resetSubagentDeliveryStateForTest();
});

function fakeJournal(): { journal: Journal; events: { kind: string; sessionId: string; payload: Record<string, unknown> }[] } {
  const events: { kind: string; sessionId: string; payload: Record<string, unknown> }[] = [];
  const journal = {
    append: (e: { kind: string; sessionId: string; payload: Record<string, unknown> }) => { events.push(e); },
  } as unknown as Journal;
  return { journal, events };
}

describe("ask_user 接线", () => {
  it("无结构提问被拒且不调用底层", async () => {
    const ask = vi.fn(async () => "x");
    const tool = askUserTool("s1", { ask });
    const out = await tool.execute({ question: "要不要都改?" });
    expect(out).toContain("ASK_NOT_STRUCTURED");
    expect(out).toContain("一次只问一个具体问题");
    expect(ask).not.toHaveBeenCalled();
  });

  it("多问号被拒且不调用底层", async () => {
    const ask = vi.fn(async () => "x");
    const tool = askUserTool("s1", { ask });
    const out = await tool.execute({ question: "改哪些?怎么改?\n1. 全量\n2. 字面" });
    expect(out).toContain("ASK_MULTIPLE_QUESTIONS");
    expect(ask).not.toHaveBeenCalled();
  });

  it("合法提问放行(options 即结构化选择项)", async () => {
    const ask = vi.fn(async () => "全量");
    const tool = askUserTool("s1", { ask });
    const out = await tool.execute({ question: "选哪个方案?", options: ["全量", "只做字面"] });
    expect(out).toBe("用户答复:全量");
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe("answer_subagent 接线", () => {
  it("reason 超 30 词被截断,应答照常执行", async () => {
    let seen = "";
    const inner: Tool = {
      name: "answer_subagent",
      description: "fake",
      parameters: { type: "object", properties: {} },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async execute(args: unknown) {
        seen = String((args as { reason?: string }).reason ?? "");
        return "已应答 r1:批准";
      },
    };
    const tool = withAnswerAttentionGuard(inner);
    const out = await tool.execute({ requestId: "r1", approved: true, reason: words(40, "ok") + " 批准" });
    expect(out).toContain("已应答");
    expect(countWords(seen)).toBeLessThanOrEqual(30);
    expect(seen.endsWith("…")).toBe(true);
  });

  it("短 reason 原样透传", async () => {
    let seen = "";
    const inner: Tool = {
      name: "answer_subagent",
      description: "fake",
      parameters: { type: "object", properties: {} },
      async execute(args: unknown) {
        seen = String((args as { reason?: string }).reason ?? "");
        return "ok";
      },
    };
    await withAnswerAttentionGuard(inner).execute({ requestId: "r1", approved: false, reason: "资源紧张" });
    expect(seen).toBe("资源紧张");
  });
});

describe("终端交付接线", () => {
  it("超长摘要被截断且任务不失败,只多一条 attention.blocked", () => {
    const { journal, events } = fakeJournal();
    const ok = deliverFinalNoticeWithAttention(
      journal,
      "s1",
      { agentId: "a1", label: "完成", summary: "甲".repeat(200) },
      { mergeMs: 0 },
    );
    expect(ok).toBe(true);
    const blocked = events.filter((e) => e.kind === "custom" && e.payload["type"] === "attention.blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.payload).toMatchObject({ code: "OUTBOUND_TOO_LONG", kind: "chat", words: 200 });
    const sys = events.find((e) => e.kind === "message.system");
    expect(sys).toBeTruthy();
    const text = String((sys!.payload as { text?: string }).text ?? "");
    expect(text).toContain("甲".repeat(100) + "…"); // 摘要正文截到 100 词
    expect(text).toContain("全文:task_output"); // 截断补指针
  });

  it("正常摘要不产生 attention.blocked", () => {
    const { journal, events } = fakeJournal();
    const ok = deliverFinalNoticeWithAttention(
      journal,
      "s2",
      { agentId: "a2", label: "完成", summary: "任务完成", pointerOnly: true },
      { mergeMs: 0 },
    );
    expect(ok).toBe(true);
    expect(events.some((e) => e.kind === "custom" && e.payload["type"] === "attention.blocked")).toBe(false);
    expect(events.some((e) => e.kind === "message.system")).toBe(true);
  });
});
