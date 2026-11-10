/**
 * 工具执行 deadline(冻结治理)单测:
 * execOne 对 Tool.timeoutMs/opts.toolTimeoutMs 的赛跑语义——超时≠取消(底层 Promise 继续),
 * 返回诚实错误让模型换路;timeoutMs=0/帽关=旧行为零变化。
 * 背景:WSL 9p 停顿把同步文件 IO 冻住事件循环,四个 agent loop 一起停摆 35 分钟。
 */
import { describe, it, expect } from "vitest";
import { AgentLoop, type AgentLoopOptions, type Tool } from "../src/agent/loop.js";
import { MemoryJournal } from "@lampgenie/core";

const slowTool = (ms: number): Tool => ({
  name: "slow_tool",
  description: "永不返回的工具(模拟 9p 停顿)",
  parameters: { type: "object", properties: {} },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute() {
    await new Promise((r) => setTimeout(r, ms));
    return "迟到但成功";
  },
});

function loopOf(tools: Tool[], opts: Partial<AgentLoopOptions> = {}): AgentLoop {
  return new AgentLoop({
    journal: new MemoryJournal(),
    sessionId: "t-timeout",
    system: "s",
    // 假 LLM:第一步调 slow_tool,第二步收工具结果后收尾。
    llm: (() => {
      let n = 0;
      return {
        async chat(messages: unknown[]) {
          n++;
          const hasToolResult = messages.some((m) => (m as { role?: string }).role === "tool");
          if (n === 1) return { content: "", toolCalls: [{ id: "c1", name: "slow_tool", arguments: "{}" }] } as never;
          return { content: hasToolResult ? "done" : "no-result", toolCalls: [] } as never;
        },
      } as never;
    })(),
    tools,
    maxSteps: 4,
    ...opts,
  }) as never;
}

describe("工具执行 deadline(execOne 赛跑)", () => {
  it("超时返回诚实错误,不抛异常;底层调用继续跑不炸 unhandled", async () => {
    const loop = loopOf([slowTool(60_000)], { toolTimeoutMs: 60 });
    const out = (await (loop as unknown as { execOne: (c: unknown, s?: AbortSignal) => Promise<{ content: string }> })
      .execOne({ id: "c1", name: "slow_tool", arguments: "{}" })) .content;
    expect(out).toContain("工具执行超时");
    expect(out).toContain("slow_tool");
    expect(out).toContain("重试前先核实"); // 写类操作副作用提示
    await new Promise((r) => setTimeout(r, 80)); // 让迟到的 settle 走完(不产生 unhandled)
  });

  it("成功先于超时:正常结果原样返回", async () => {
    const loop = loopOf([slowTool(10)], { toolTimeoutMs: 5_000 });
    const out = (await (loop as unknown as { execOne: (c: unknown, s?: AbortSignal) => Promise<{ content: string }> })
      .execOne({ id: "c1", name: "slow_tool", arguments: "{}" })).content;
    expect(out).toBe("迟到但成功");
  });

  it("Tool.timeoutMs=0 豁免(自管):帽存在也不包", async () => {
    const t = slowTool(80);
    t.timeoutMs = 0;
    const loop = loopOf([t], { toolTimeoutMs: 30 });
    const out = (await (loop as unknown as { execOne: (c: unknown, s?: AbortSignal) => Promise<{ content: string }> })
      .execOne({ id: "c1", name: "slow_tool", arguments: "{}" })).content;
    expect(out).toBe("迟到但成功");
  });

  it("Tool.timeoutMs 显式值覆盖装配帽", async () => {
    const t = slowTool(20);
    t.timeoutMs = 10_000;
    const loop = loopOf([t], { toolTimeoutMs: 5 });
    const out = (await (loop as unknown as { execOne: (c: unknown, s?: AbortSignal) => Promise<{ content: string }> })
      .execOne({ id: "c1", name: "slow_tool", arguments: "{}" })).content;
    expect(out).toBe("迟到但成功");
  });

  it("帽关(toolTimeoutMs=0/未设)=旧行为,永等也不截断", async () => {
    const loop = loopOf([slowTool(30)], { toolTimeoutMs: 0 });
    const out = (await (loop as unknown as { execOne: (c: unknown, s?: AbortSignal) => Promise<{ content: string }> })
      .execOne({ id: "c1", name: "slow_tool", arguments: "{}" })).content;
    expect(out).toBe("迟到但成功");
  });

  it("整 loop 路径:超时工具结果作为 tool 消息回流,turn 正常收尾不挂死", async () => {
    const loop = loopOf([slowTool(60_000)], { toolTimeoutMs: 50 });
    const final = await loop.runTurn("go");
    expect(String(final)).toBe("done");
  });
});

describe("同参重复检测(2026-10-29 board_read 无限循环)", () => {
  it("连续 3+ 步同一调用签名 → 结果尾部注入策略提示;不同调用即重置", async () => {
    let n = 0;
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal,
      sessionId: "t-repeat",
      system: "s",
      llm: {
        async chat() {
          n++;
          if (n <= 4) return { content: "", toolCalls: [{ id: "c" + n, name: "slow_tool", arguments: "{}" }] } as never;
          if (n === 5) return { content: "", toolCalls: [{ id: "c5", name: "other_tool", arguments: "{}" }] } as never;
          return { content: "fin", toolCalls: [] } as never;
        },
      } as never,
      tools: [
        { name: "slow_tool", description: "d", parameters: { type: "object", properties: {} }, isConcurrencySafe: () => true, isReadOnly: () => true, async execute() { return "R"; } },
        { name: "other_tool", description: "d", parameters: { type: "object", properties: {} }, isConcurrencySafe: () => true, isReadOnly: () => true, async execute() { return "O"; } },
      ],
      maxSteps: 10,
    });
    const out = await loop.runTurn("go");
    expect(String(out)).toBe("fin");
    const toolResults = journal.readSession("t-repeat").filter((e) => e.kind === "tool.result").map((e) => String((e.payload as { content?: string }).content ?? ""));
    expect(toolResults.length).toBeGreaterThanOrEqual(5);
    expect(toolResults[0]).not.toContain("重复调用检测");
    expect(toolResults[1]).not.toContain("重复调用检测");
    expect(toolResults[2]).toContain("重复调用检测");
    expect(toolResults[3]).toContain("重复调用检测");
    expect(toolResults[4]).not.toContain("重复调用检测");
  });
});
