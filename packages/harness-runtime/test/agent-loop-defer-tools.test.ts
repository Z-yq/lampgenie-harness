/**
 * 延迟工具面(2026-10-22 用户口径「工具像 MCP 一样用时再选」):
 * 契约:deferred 工具未激活前不进 wire 广告面,但执行面始终可用;
 * tool_view(name) 查看即激活;直接调用 deferred 工具也自动激活(下一步起进广告面);
 * 未打标工具(老行为)逐字节不变;trace 记录的是实际广告面(怎么送的怎么记)。
 */
import { describe, it, expect } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import { MemoryJournal } from "@lampgenie/core";
import type { LlmProvider, LlmResponse, Tool } from "../src/agent/loop";

const mkTool = (name: string, deferred?: boolean): Tool => ({
  name, description: "d", parameters: { type: "object", properties: {} },
  ...(deferred ? { deferred: true } : {}),
  isConcurrencySafe: () => true,
  async execute() { return `${name}-ok`; },
});

describe("AgentLoop 延迟工具面", () => {
  it("deferred 未激活:不进 chat 的 tools 参数;下 turn 起出现(本 turn 冻结)", async () => {
    const advertised: string[][] = [];
    let n = 0;
    const llm: LlmProvider = {
      async chat(_messages, tools): Promise<LlmResponse> {
        advertised.push(tools.map((t) => t.name));
        n++;
        if (n === 1) return { content: "", toolCalls: [{ id: "c1", name: "tool_view", arguments: '{"name":"big"}' }] };
        if (n === 2) return { content: "done" };
        if (n === 3) return { content: "", toolCalls: [{ id: "c2", name: "big", arguments: "{}" }] };
        return { content: "done" };
      },
    };
    const loop = new AgentLoop({
      journal: new MemoryJournal(), sessionId: "defer-1", system: "s", llm,
      tools: [mkTool("tool_view"), mkTool("big", true), mkTool("small")],
    });
    await loop.runTurn("go");
    expect(advertised[0]).toEqual(["tool_view", "small"]); // big 未广告
    expect(advertised[1]).toEqual(["tool_view", "small"]); // 本 turn 内激活不改 schema(一轮一冻)
    await loop.runTurn("again"); // 下 turn:激活集生效
    expect(advertised[2]).toContain("big");
  });

  it("直接调用尚未广告的 deferred 工具:执行面仍可用(返回真实结果),并自动激活", async () => {
    const results: string[] = [];
    const advertised: string[][] = [];
    let n = 0;
    const llm: LlmProvider = {
      async chat(_messages, tools): Promise<LlmResponse> {
        advertised.push(tools.map((t) => t.name));
        n++;
        if (n === 1) return { content: "", toolCalls: [{ id: "c1", name: "big", arguments: "{}" }] };
        return { content: "done" };
      },
    };
    const loop = new AgentLoop({
      journal: new MemoryJournal(), sessionId: "defer-2", system: "s", llm,
      tools: [mkTool("tool_view"), mkTool("big", true)],
    });
    const out = await loop.runTurn("go");
    expect(out).toBe("done");
    expect(advertised[0]).toEqual(["tool_view"]); // 首步未广告(执行面仍跑通)
    expect(advertised[1]).toEqual(["tool_view"]); // 本 turn 内激活不翻转 schema
    await loop.runTurn("again");
    expect(advertised[2]).toContain("big"); // 下 turn 进广告面
  });

  it("未打标工具:广告面与老行为一致(全量),不因激活逻辑退化", async () => {
    const advertised: string[][] = [];
    const llm: LlmProvider = {
      async chat(_messages, tools): Promise<LlmResponse> {
        advertised.push(tools.map((t) => t.name));
        return { content: "done" };
      },
    };
    const loop = new AgentLoop({
      journal: new MemoryJournal(), sessionId: "defer-3", system: "s", llm,
      tools: [mkTool("a"), mkTool("b")],
    });
    await loop.runTurn("go");
    expect(advertised[0]).toEqual(["a", "b"]);
  });

  it("tool_view 参数不可解析:不激活(不误伤),下一步仍不广告", async () => {
    const advertised: string[][] = [];
    let n = 0;
    const llm: LlmProvider = {
      async chat(_messages, tools): Promise<LlmResponse> {
        advertised.push(tools.map((t) => t.name));
        n++;
        if (n === 1) return { content: "", toolCalls: [{ id: "c1", name: "tool_view", arguments: "not-json" }] };
        return { content: "done" };
      },
    };
    const loop = new AgentLoop({
      journal: new MemoryJournal(), sessionId: "defer-4", system: "s", llm,
      tools: [mkTool("tool_view"), mkTool("big", true)],
    });
    await loop.runTurn("go");
    expect(advertised[1]).toEqual(["tool_view"]);
  });
});

describe("广告面一轮冻结 + 激活集跨 loop 持久化(token 轮 P0-2)", () => {
  it("c) 同 turn 内两次 advertisedTools() 逐字节相同;同 turn 内激活 deferred 后仍不变,重置 turn 缓存后可见", async () => {
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "p02-c", system: "s",
      llm: { async chat(): Promise<LlmResponse> { return { content: "ok" }; } },
      tools: [mkTool("tool_view"), mkTool("big", true), mkTool("small")],
    }) as unknown as {
      advertisedTools: () => { name: string }[];
      activatedTools: Set<string>;
      advertisedThisTurn?: unknown;
      persistActivated: () => void;
    };
    // 同 turn(未 runTurn,缓存空)两次调用:同一数组 → 逐字节相同
    const a1 = loop.advertisedTools().map((t) => t.name);
    const a2 = loop.advertisedTools().map((t) => t.name);
    expect(a2).toEqual(a1);
    expect(JSON.stringify(a2)).toBe(JSON.stringify(a1));
    expect(a1).toEqual(["tool_view", "small"]); // 零激活不广告 deferred

    // 同 turn 内激活 deferred:缓存命中 → 本 turn 不变
    loop.activatedTools.add("big");
    expect(JSON.stringify(loop.advertisedTools().map((t) => t.name))).toBe(JSON.stringify(a1));

    // 重置 turn 缓存(= 下一 turn 开头):激活集生效
    loop.advertisedThisTurn = undefined;
    expect(loop.advertisedTools().map((t) => t.name)).toEqual(["tool_view", "big", "small"]);
  });

  it("d) journal 无 activated.tools 事件 → 回落现有重建路径(不报错)", async () => {
    const journal = new MemoryJournal();
    journal.append({ kind: "message.user", sessionId: "p02-d", payload: { text: "hi" } });
    expect(journal.readSession("p02-d").some((e) => (e.payload as { what?: string }).what === "activated.tools")).toBe(false);
    const advertised: string[][] = [];
    let n = 0;
    const loop = new AgentLoop({
      journal, sessionId: "p02-d", system: "s",
      llm: {
        async chat(_m, tools): Promise<LlmResponse> {
          advertised.push(tools.map((t) => t.name));
          n++;
          if (n === 1) return { content: "", toolCalls: [{ id: "c1", name: "tool_view", arguments: '{"name":"big"}' }] };
          return { content: "done" };
        },
      },
      tools: [mkTool("tool_view"), mkTool("big", true)],
    });
    await loop.runTurn("go");
    expect(advertised[0]).toEqual(["tool_view"]); // 无持久化事件 = 空激活集,行为同改前
    // 激活后落事件(幂等键按 session):下一 loop 实例能读回
    const ev = journal.readSession("p02-d").filter((e) => (e.payload as { what?: string }).what === "activated.tools");
    expect(ev.length).toBeGreaterThan(0);
    // 新 loop(模拟 gateway 每 turn 新建):直接从 journal 读回激活集 → 首步即放量
    const advertised2: string[][] = [];
    const loop2 = new AgentLoop({
      journal, sessionId: "p02-d", system: "s",
      llm: { async chat(_m, tools): Promise<LlmResponse> { advertised2.push(tools.map((t) => t.name)); return { content: "done" }; } },
      tools: [mkTool("tool_view"), mkTool("big", true)],
    });
    await loop2.runTurn("again");
    expect(advertised2[0]).toContain("big");
  });
});
