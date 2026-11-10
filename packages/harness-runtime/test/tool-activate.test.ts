/**
 * 工具回执激活标记(2026-10-30 board_read 死锁)单测:
 * 回执文本携带 [[activate-tool:<name>]] → loop 把该工具点亮进广告面(activatedTools),
 * 标记从模型可见文本剥离并换「下一步直接调用」提示;未知工具名静默忽略。
 * 背景:plan-gate 拒绝指路 board_upsert 而它 deferred 不在 wire 面——受约束的函数名采样
 * 把「写板」意图掰成 board_read,38 步同参死循环(会话 web-1793329725963)。
 */
import { describe, it, expect } from "vitest";
import { AgentLoop, type Tool } from "../src/agent/loop.js";
import { MemoryJournal } from "@lampgenie/core";

const mk = (name: string, ret: string, extra: Partial<Tool> = {}): Tool => ({
  name,
  description: "d",
  parameters: { type: "object", properties: {} },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute() { return ret; },
  ...extra,
});

function resultsOf(journal: MemoryJournal, sid: string): string[] {
  return journal.readSession(sid).filter((e) => e.kind === "tool.result").map((e) => String((e.payload as { content?: string }).content ?? ""));
}

describe("激活标记 [[activate-tool:]]", () => {
  it("标记剥离+延迟工具点亮+可见提示;下一步可直接调用", async () => {
    let n = 0;
    const journal = new MemoryJournal();
    const gate = mk("gate_tool", "被拦。board_upsert 可用。\n[[activate-tool:board_upsert]]");
    const deferred = mk("board_upsert", "W", { deferred: true });
    const loop = new AgentLoop({
      journal,
      sessionId: "t-act1",
      system: "s",
      llm: {
        async chat() {
          n++;
          if (n === 1) return { content: "", toolCalls: [{ id: "c1", name: "gate_tool", arguments: "{}" }] } as never;
          if (n === 2) return { content: "", toolCalls: [{ id: "c2", name: "board_upsert", arguments: "{}" }] } as never;
          return { content: "fin", toolCalls: [] } as never;
        },
      } as never,
      tools: [gate, deferred],
      maxSteps: 6,
    });
    const adv = (loop as unknown as { advertisedTools: () => Tool[] });
    expect(adv.advertisedTools().map((t) => t.name)).not.toContain("board_upsert"); // 延迟且未激活
    const out = await loop.runTurn("go");
    expect(String(out)).toBe("fin");
    const rs = resultsOf(journal, "t-act1");
    expect(rs[0]).not.toContain("[[activate-tool:"); // 标记已剥离(防模型模仿语法)
    expect(rs[0]).toContain("[工具面更新]");
    expect(rs[0]).toContain("board_upsert");
    expect(rs[0]).toContain("现在就能按名调用"); // 新文案:激活即可调,schema 下轮刷新
    expect(rs[1]).toBe("W"); // 点亮后真实执行面照常
    await loop.runTurn("again"); // 下 turn 才进 schema 广告面(一轮一冻)
    expect(adv.advertisedTools().map((t) => t.name)).toContain("board_upsert"); // 进了广告面
  });

  it("未知工具名:标记剥离但静默忽略,不产生提示", async () => {
    let n = 0;
    const journal = new MemoryJournal();
    const gate = mk("gate_tool", "指路一个不存在的工具\n[[activate-tool:nonexistent_tool]]");
    const loop = new AgentLoop({
      journal,
      sessionId: "t-act2",
      system: "s",
      llm: {
        async chat() {
          n++;
          if (n === 1) return { content: "", toolCalls: [{ id: "c1", name: "gate_tool", arguments: "{}" }] } as never;
          return { content: "fin", toolCalls: [] } as never;
        },
      } as never,
      tools: [gate],
      maxSteps: 4,
    });
    await loop.runTurn("go");
    const rs = resultsOf(journal, "t-act2");
    expect(rs[0]).not.toContain("[[activate-tool:");
    expect(rs[0]).not.toContain("[工具面更新]");
    expect(rs[0]).toContain("指路一个不存在的工具");
  });

  it("重复标记同一工具:只提示一次(已激活不重复公告)", async () => {
    let n = 0;
    const journal = new MemoryJournal();
    const gate = mk("gate_tool", "拦\n[[activate-tool:board_upsert]]");
    const deferred = mk("board_upsert", "W", { deferred: true });
    const loop = new AgentLoop({
      journal,
      sessionId: "t-act3",
      system: "s",
      llm: {
        async chat() {
          n++;
          if (n <= 2) return { content: "", toolCalls: [{ id: "c" + n, name: "gate_tool", arguments: "{}" }] } as never;
          return { content: "fin", toolCalls: [] } as never;
        },
      } as never,
      tools: [gate, deferred],
      maxSteps: 5,
    });
    await loop.runTurn("go");
    const rs = resultsOf(journal, "t-act3");
    expect(rs[0]).toContain("[工具面更新]"); // 第一次:公告
    expect(rs[1]).not.toContain("[工具面更新]"); // 第二次:已激活,静默
    expect(rs[1]).not.toContain("[[activate-tool:");
  });
});

describe("空响应防抖(2026-10-30:上游 200 返回零内容零工具不得直接终态)", () => {
  it("首次空响应=empty-retry 重试;第二次有内容=正常完成", async () => {
    let n = 0;
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal,
      sessionId: "t-empty1",
      system: "s",
      llm: {
        async chat() {
          n++;
          if (n === 1) return { content: "", toolCalls: [] } as never; // 上游挂流空响应
          return { content: "拿到结果", toolCalls: [] } as never;
        },
      } as never,
      tools: [],
      maxSteps: 6,
    });
    const out = await loop.runTurn("go");
    expect(String(out)).toBe("拿到结果");
    const steps = journal.readSession("t-empty1").filter((e) => e.kind === "step.end").map((e) => String((e.payload as { reason?: string }).reason ?? ""));
    expect(steps).toContain("empty-retry");
    expect(steps[steps.length - 1]).toBe("completed");
  });

  it("连续两次空响应:重试一次后接受空终态(不再无限重试)", async () => {
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal,
      sessionId: "t-empty2",
      system: "s",
      llm: { async chat() { return { content: "", toolCalls: [] } as never; } } as never,
      tools: [],
      maxSteps: 6,
    });
    const out = await loop.runTurn("go");
    expect(String(out)).toBe("");
    const steps = journal.readSession("t-empty2").filter((e) => e.kind === "step.end").map((e) => String((e.payload as { reason?: string }).reason ?? ""));
    const retries = steps.filter((s) => s === "empty-retry").length;
    expect(retries).toBe(1); // 只重试一次
    expect(steps[steps.length - 1]).toBe("completed");
  });

  it("有内容的正常收尾不受影响(零重试)", async () => {
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal,
      sessionId: "t-empty3",
      system: "s",
      llm: { async chat() { return { content: "直接回答", toolCalls: [] } as never; } } as never,
      tools: [],
      maxSteps: 4,
    });
    const out = await loop.runTurn("go");
    expect(String(out)).toBe("直接回答");
    const steps = journal.readSession("t-empty3").filter((e) => e.kind === "step.end").map((e) => String((e.payload as { reason?: string }).reason ?? ""));
    expect(steps.some((s) => s === "empty-retry")).toBe(false);
  });
});
