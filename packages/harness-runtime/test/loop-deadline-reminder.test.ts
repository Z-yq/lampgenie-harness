/**
 * 时间盒收敛提醒(2026-10-19):子代理临到期仍只发工具调用、从不落结论
 * (实锤:两个 explore 用满 9 分钟/76 步/155 次工具调用,零文本产出)。
 * 契约:剩余 ≤ deadlineWarnMs 时向当步注入一次临时提醒,要求先输出结论;只注入一次。
 */
import { describe, it, expect } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import { MemoryJournal } from "@lampgenie/core";
import type { LlmProvider, LlmResponse } from "../src/agent/loop";

describe("AgentLoop deadline 收敛提醒", () => {
  it("剩余 ≤ warn → 当步请求里出现时间盒提醒;只一次", async () => {
    const seen: string[] = [];
    let n = 0;
    const llm: LlmProvider = {
      async chat(messages): Promise<LlmResponse> {
        seen.push(messages.map((m) => String(m.content)).join("\n---\n"));
        n++;
        return n <= 2 ? { content: "", toolCalls: [{ id: "c" + n, name: "echo", arguments: "{}" }] } : { content: "结论:完成" };
      },
    };
    const loop = new AgentLoop({
      journal: new MemoryJournal(), sessionId: "dl-test", system: "s", llm,
      tools: [{ name: "echo", description: "d", parameters: { type: "object", properties: {} }, isConcurrencySafe: () => true, async execute() { return "ok"; } } as never],
      maxSteps: 5,
      deadlineAt: Date.now() + 30_000,
      deadlineWarnMs: 60_000, // 30s 剩余 ≤ 60s 提前量 → 第一 step 就提醒
    });
    const out = await loop.runTurn("查一圈然后给结论");
    expect(out).toBe("结论:完成");
    expect(seen[0]).toContain("时间盒仅剩约");
    expect(seen[0]).toContain("立即停止继续检索");
    // 只注入一次:第二次请求里不再出现提醒(第一次的提醒已进历史,但内容只追加一次)
    const count = seen.filter((s) => s.includes("时间盒仅剩约")).length;
    expect(count).toBe(1);
  }, 20_000);

  it("剩余充裕 → 不注入", async () => {
    const seen: string[] = [];
    const llm: LlmProvider = {
      async chat(messages): Promise<LlmResponse> { seen.push(messages.map((m) => String(m.content)).join("\n")); return { content: "好" }; },
    };
    const loop = new AgentLoop({
      journal: new MemoryJournal(), sessionId: "dl-test2", system: "s", llm, tools: [], maxSteps: 3,
      deadlineAt: Date.now() + 10 * 60_000, deadlineWarnMs: 60_000,
    });
    await loop.runTurn("x");
    expect(seen[0]).not.toContain("时间盒仅剩");
  }, 20_000);
});
