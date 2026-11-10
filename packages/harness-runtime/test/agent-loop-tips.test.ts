/**
 * tips 即时信息增强(2026-10-21 用户口径「做哪类事之前注入对应提示,不一股脑开工全塞」):
 * 契约:每 step 组装消息时调用 opts.tips,ctx 带上一步实际执行的工具名(含被闸拒绝的调用);
 * 返回非空=ephemeral user 消息注入(不落 journal);step 0 恒无上一步工具;tips 异常不打断主链。
 */
import { describe, it, expect } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import { MemoryJournal } from "@lampgenie/core";
import type { LlmProvider, LlmResponse } from "../src/agent/loop";

const echoTool = {
  name: "echo", description: "d", parameters: { type: "object", properties: {} },
  isConcurrencySafe: () => true, async execute() { return "ok"; },
} as never;

describe("AgentLoop tips 注入点", () => {
  it("上一步执行过工具 → tips 收到工具名,返回文本作为 user 消息进入下一步请求", async () => {
    const seen: string[] = [];
    const ctxs: { step: number; lastStepTools: string[] }[] = [];
    let n = 0;
    const llm: LlmProvider = {
      async chat(messages): Promise<LlmResponse> {
        seen.push(messages.map((m) => String(m.content)).join("\n---\n"));
        n++;
        return n <= 1 ? { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: "{}" }] } : { content: "结论:完成" };
      },
    };
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "tip-test", system: "s", llm,
      tools: [echoTool], maxSteps: 4,
      tips: (ctx) => {
        ctxs.push(ctx);
        return ctx.lastStepTools.includes("echo") ? "<system-reminder>tips TIP-ECHO</system-reminder>" : null;
      },
    });
    const out = await loop.runTurn("查一下");
    expect(out).toBe("结论:完成");
    expect(ctxs[0]?.lastStepTools, "step0 无上一步工具").toEqual([]);
    expect(ctxs[1]?.lastStepTools).toEqual(["echo"]);
    expect(seen[1]).toContain("TIP-ECHO");
    expect(seen[0]).not.toContain("TIP-ECHO");
    // 上下文零影响(2026-10-22 可见化改造后的契约):tip 文本不再出现在 journal 的对话事件里,
    // 只旁路落一条 tip.injected 留痕(面板展示用);deriveMessages 白名单不读它 → 下一轮请求不吃回自己。
    const { deriveMessages } = await import("../src/agent/loop");
    expect(JSON.stringify(deriveMessages(journal, "tip-test"))).not.toContain("TIP-ECHO");
    const tipEvs = journal.readAll().filter((e) => e.kind === "tip.injected");
    expect(tipEvs.length, "每步注入一条留痕").toBe(1);
    const tp = tipEvs[0].payload as { text: string; keys: string[]; step: number; chars: number };
    expect(tp.text).toContain("TIP-ECHO");
    expect(tp.step).toBe(1);
    expect(tp.keys).toEqual([]); // 裸 string 返回 = 无分类名
    expect(tp.chars).toBeGreaterThan(0);
  }, 20_000);

  it("tips 返回 {text,keys} → 留痕事件带分类名(面板显示 tips · 类别)", async () => {
    let n = 0;
    const llm: LlmProvider = {
      async chat(): Promise<LlmResponse> {
        n++;
        return n <= 1 ? { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: "{}" }] } : { content: "结论:完成" };
      },
    };
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "tip-keys", system: "s", llm, tools: [echoTool], maxSteps: 3,
      tips: (ctx) => (ctx.lastStepTools.includes("echo") ? { text: "<system-reminder>tips K</system-reminder>", keys: ["code-orient", "dispatch"] } : null),
    });
    await loop.runTurn("x");
    const ev = journal.readAll().find((e) => e.kind === "tip.injected");
    expect((ev?.payload as { keys: string[] }).keys).toEqual(["code-orient", "dispatch"]);
  }, 20_000);

  it("tips 抛异常 → 吞掉不打断主链", async () => {
    let n = 0;
    const llm: LlmProvider = {
      async chat(): Promise<LlmResponse> {
        n++;
        return n <= 1 ? { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: "{}" }] } : { content: "结论:完成" };
      },
    };
    const loop = new AgentLoop({
      journal: new MemoryJournal(), sessionId: "tip-err", system: "s", llm,
      tools: [echoTool], maxSteps: 3,
      tips: () => { throw new Error("tips 炸了"); },
    });
    const out = await loop.runTurn("x");
    expect(out).toBe("结论:完成");
  }, 20_000);

  it("tips 恒空 → 行为与不配置一致", async () => {
    const seen: string[] = [];
    const llm: LlmProvider = {
      async chat(messages): Promise<LlmResponse> { seen.push(messages.map((m) => String(m.content)).join("\n")); return { content: "好" }; },
    };
    const loop = new AgentLoop({
      journal: new MemoryJournal(), sessionId: "tip-null", system: "s", llm, tools: [], maxSteps: 2,
      tips: () => null,
    });
    await loop.runTurn("x");
    expect(seen[0]).not.toContain("tips");
  }, 20_000);

  it("ctx.compacts=本会话 compact.done 计数(真压缩边界);他会话的压缩不计", async () => {
    // compact 后 tip 失忆自愈(2026-10-21):loop 每 step 从 journal 数 compact.done 交给装配方,
    // 装配方据此清「已注入」状态重注入一次。本用例锚 loop 层契约:计数只算本会话。
    const journal = new MemoryJournal();
    journal.append({ kind: "compact.done", sessionId: "tip-compact", payload: { summary: "第一次压缩" } });
    journal.append({ kind: "compact.done", sessionId: "别的会话", payload: { summary: "不相干" } });
    const compacts: number[] = [];
    let n = 0;
    const llm: LlmProvider = {
      async chat(): Promise<LlmResponse> {
        n++;
        return n <= 1 ? { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: "{}" }] } : { content: "结论:完成" };
      },
    };
    const loop = new AgentLoop({
      journal, sessionId: "tip-compact", system: "s", llm, tools: [echoTool], maxSteps: 4,
      tips: (ctx) => { compacts.push(ctx.compacts); return null; },
    });
    await loop.runTurn("x");
    expect(compacts.length).toBeGreaterThanOrEqual(2);
    expect(compacts.every((c) => c === 1), "本会话 1 次压缩,他会话不计").toBe(true);
  }, 20_000);

  it("tips ctx 带 phase(tipsPhase 通道)与 lastStepError(2026-11 SOP 化回归锚)", async () => {
    // 契约:opts.tipsPhase 每 step 被调,返回值作为 ctx.phase 交给 tips(装配方据此做 SOP 卡);
    // lastStepError=上一步工具结果是否带错(与 lastStepTools 同语义=上一步状态,ToolExecOutcome.error 口径)。
    const phases: (string | undefined)[] = [];
    const errors: boolean[] = [];
    let phase = "understand";
    let n = 0;
    const llm: LlmProvider = {
      async chat(): Promise<LlmResponse> {
        n++;
        // 第 1 步调一个必错工具(unknown tool → 结构化 error);第 2 步纯文本收尾
        return n <= 1 ? { content: "", toolCalls: [{ id: "c1", name: "no-such-tool", arguments: "{}" }] } : { content: "结论:完成" };
      },
    };
    const loop = new AgentLoop({
      journal: new MemoryJournal(), sessionId: "tip-phase", system: "s", llm, tools: [], maxSteps: 4,
      tipsPhase: () => phase,
      tips: (ctx) => {
        phases.push(ctx.phase);
        errors.push(Boolean(ctx.lastStepError));
        return null;
      },
    });
    await loop.runTurn("x");
    expect(phases[0], "step0 即带 phase(tipsPhase 首调)").toBe("understand");
    expect(errors[0], "step0 无上一步=无错").toBe(false);
    expect(phases.length).toBeGreaterThanOrEqual(2);
    // 上一步调了未知工具 → execOne 返回结构化 error → lastStepError=true
    expect(errors.some((e) => e === true), "工具带错后 lastStepError=true").toBe(true);
    // phase 变化实时可见(闭包读最新值)
    phase = "plan";
    const seen2: (string | undefined)[] = [];
    const loop2 = new AgentLoop({
      journal: new MemoryJournal(), sessionId: "tip-phase-2", system: "s",
      llm: { async chat(): Promise<LlmResponse> { return { content: "好" }; } }, tools: [], maxSteps: 2,
      tipsPhase: () => phase,
      tips: (ctx) => { seen2.push(ctx.phase); return null; },
    });
    await loop2.runTurn("y");
    expect(seen2[0]).toBe("plan");
  }, 20_000);
});
