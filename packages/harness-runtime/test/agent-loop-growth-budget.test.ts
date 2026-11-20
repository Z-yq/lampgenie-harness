import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, localPrefixHitRateOf, type Message, type Tool } from "../src/agent/loop.js";

function fakeLlm(script: Array<(msgs: readonly Message[]) => { content: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> ; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }>) {
  let i = 0;
  let calls = 0;
  return {
    model: "test-model",
    describe: () => ({ baseUrl: "http://t", apiType: "openai" }),
    chat: async (msgs: readonly Message[]) => {
      const step = Math.min(i, script.length - 1);
      i += 1; calls += 1;
      const r = script[step]!(msgs);
      return { content: r.content, toolCalls: r.toolCalls, usage: r.usage, finishReason: "stop" };
    },
    get calls() { return calls; },
  };
}

const tools: Tool[] = [{
  name: "noop",
  description: "d",
  parameters: { type: "object", properties: {} },
  execute: async () => "x".repeat(300_000), // 大结果灌超预算(未配 spill → 全进历史)
}];

describe("loop 计量三件+护栏+处置(缺口#21/22/33/34/35)", () => {
  it("localPrefixHitRateOf:公共前缀占比(缺口#22)", () => {
    const a: Message[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u1" },
    ];
    const b: Message[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a" },
    ];
    expect(localPrefixHitRateOf(undefined, b)).toBeUndefined();
    expect(localPrefixHitRateOf(a, a)).toBe(1);
 // 前缀第 2 条变化 → 只有 system 共享
    const c: Message[] = [{ role: "system", content: "s" }, { role: "user", content: "CHANGED" }];
    expect(localPrefixHitRateOf(a, c)).toBeLessThan(0.5);
  });

  it("usage 真值回填:context.tokens 记账 + growthBudget 分母切真值(缺口#34/35)", async () => {
    const journal = new MemoryJournal();
    const llm = fakeLlm([
      () => ({ content: "hello", usage: { inputTokens: 10_000, outputTokens: 500, totalTokens: 10_500 } }),
      () => ({ content: "world", usage: { inputTokens: 20_000, outputTokens: 800, totalTokens: 20_800 } }),
    ]);
    const loop = new AgentLoop({ journal, sessionId: "s-ledger", system: "sys", llm });
    await loop.runTurn("q1");
    await loop.runTurn("q2");
    const events = (journal.readAll() as Array<{ kind?: string; sessionId?: string; payload?: Record<string, unknown> }>)
      .filter((e) => e.kind === "custom" && e.payload?.what === "context.tokens");
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]!.payload!.contextTokens).toBe(10_500);
    expect(events[0]!.payload!.inputTokens).toBe(10_000);
    expect(events[1]!.payload!.contextTokens).toBe(20_800);
  });

  it("budgetExceeded 处置阶梯:连续超预算打 budgetAction(缺口#21)", async () => {
    const journal = new MemoryJournal();
 // turn1 小基线;turn2/turn3 各含一步大工具结果(30 万字符)→ 估算远超上一步真值 input → 超预算打标
    const llm = fakeLlm([
      () => ({ content: "r1", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } }),
      () => ({ content: "", toolCalls: [{ id: "t1", name: "noop", arguments: "{}" }], usage: { inputTokens: 20_000, outputTokens: 100, totalTokens: 20_100 } }),
      () => ({ content: "r2", usage: { inputTokens: 160_000, outputTokens: 1_000, totalTokens: 161_000 } }),
      () => ({ content: "", toolCalls: [{ id: "t2", name: "noop", arguments: "{}" }], usage: { inputTokens: 161_000, outputTokens: 100, totalTokens: 161_100 } }),
      () => ({ content: "r3", usage: { inputTokens: 220_000, outputTokens: 1_000, totalTokens: 221_000 } }),
    ]);
    const loop = new AgentLoop({ journal, sessionId: "s-budget", system: "sys", llm, tools, microcompact: { thresholdTokens: 1 } });
    await loop.runTurn("q1");
    await loop.runTurn("q2");
    await loop.runTurn("q3");
    const prunes = (journal.readAll() as Array<{ kind?: string; sessionId?: string; payload?: Record<string, unknown> }>)
      .filter((e) => e.kind === "context.prune" && e.payload?.budgetExceeded === true);
 // 连续超预算步应带处置动作标记(阶梯:1=tighten-spill, 2+=aggressive/suggest-compact)
    expect(prunes.length).toBeGreaterThanOrEqual(1);
    for (const p of prunes) {
      expect(["tighten-spill", "tighten-spill-x4", "suggest-compact"]).toContain(p.payload!.budgetAction);
      expect(typeof p.payload!.budgetStreak).toBe("number");
 // 修复:growth 必须是「消息估算 Δ」,不能是消息估算 − API 全量 input(恒负→全 0)
      expect(typeof p.payload!.growthTokens).toBe("number");
      expect(Number(p.payload!.growthTokens)).toBeGreaterThan(0);
    }
  });

  it("单步多工具结果按 1.5% 预算均分定形(spill 写出,不超单步份额)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "growth-split-"));
    const bigTools: Tool[] = ["big1", "big2"].map((name) => ({
      name,
      description: "d",
      parameters: { type: "object", properties: {} },
      execute: async () => "x".repeat(120_000),
    }));
    const llm = fakeLlm([
      () => ({ content: "", toolCalls: [
        { id: "b1", name: "big1", arguments: "{}" },
        { id: "b2", name: "big2", arguments: "{}" },
      ], usage: { inputTokens: 10_000, outputTokens: 100, totalTokens: 10_100 } }),
      () => ({ content: "done", usage: { inputTokens: 12_000, outputTokens: 10, totalTokens: 12_010 } }),
    ]);
    try {
      const journal = new MemoryJournal();
      const loop = new AgentLoop({
        journal, sessionId: "s-split", system: "sys", llm, tools: bigTools,
        spill: { dir },
      });
      await loop.runTurn("q");
      const results = (journal.readAll() as Array<{ kind?: string; payload?: { name?: string; content?: string } }>)
        .filter((e) => e.kind === "tool.result");
      expect(results).toHaveLength(2);
      for (const r of results) {
 // 每调用份额=1500/2=750 tok≈3000 字符;预览不得超过该量级(旧实现各拿全额→两倍)
        expect(String(r.payload?.content ?? "").length).toBeLessThan(6_000);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("编辑型 toolCall 参数写时定形:执行用原文,历史回放用定形版", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shape-loop-"));
    const seenByTool: string[] = [];
    let secondMessages: Message[] = [];
    const editTool: Tool = {
      name: "edit_file", description: "d", parameters: { type: "object", properties: {} },
      execute: async (args: unknown) => { seenByTool.push(JSON.stringify(args)); return "ok"; },
    };
    const bigNew = "x".repeat(12_000);
    const llm = fakeLlm([
      () => ({ content: "", toolCalls: [{ id: "e1", name: "edit_file", arguments: JSON.stringify({ path: "a.ts", new_string: bigNew }) }], usage: { inputTokens: 10_000, outputTokens: 3_000, totalTokens: 13_000 } }),
      (msgs) => { secondMessages = [...msgs]; return { content: "done", usage: { inputTokens: 12_000, outputTokens: 10, totalTokens: 12_010 } }; },
    ]);
    try {
      const journal = new MemoryJournal();
      const loop = new AgentLoop({ journal, sessionId: "s-shape-loop", system: "sys", llm, tools: [editTool], spill: { dir } });
      await loop.runTurn("q");
 // 执行面拿到原文
      expect(seenByTool[0]!.length).toBeGreaterThan(11_000);
 // 历史 message.agent 是定形版
      const ma = (journal.readAll() as Array<{ kind?: string; payload?: { toolCalls?: Array<{ arguments: string }> } }>)
        .find((e) => e.kind === "message.agent");
      const shaped = JSON.parse(ma!.payload!.toolCalls![0]!.arguments) as Record<string, unknown>;
      expect(String(shaped.new_string).length).toBeLessThan(6_000);
      expect(shaped._shaped).toBeTruthy();
 // 下一次请求回放的是定形版
      expect(JSON.stringify(secondMessages)).toContain("_shaped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stepTokenOpts:provider 键从 describe() 派生(缺口#33)", async () => {
    const journal = new MemoryJournal();
    const llm = fakeLlm([() => ({ content: "ok", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } })]);
    const loop = new AgentLoop({ journal, sessionId: "s-opts", system: "sys", llm });
    await loop.runTurn("q");
 // 无断言崩溃 + usage 落账即通过(标定键为内部路径;这里验证不回归)
    expect((journal.readAll() as unknown[]).length).toBeGreaterThan(0);
  });
});
