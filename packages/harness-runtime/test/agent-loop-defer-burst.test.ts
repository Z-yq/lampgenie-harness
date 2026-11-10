/**
 * 延迟工具「一次性放量」(2026-11 token 优化轮 01):
 * 契约:①零激活时广告面与改前逐字一致(不广告任何 deferred);
 * ②任一 deferred 工具被激活后,**所有** deferred 工具一次性进广告面,后续每一步的广告面
 *   JSON 逐字节相同(否则 tool_view 每激活一个就改一次 tools schema,提示缓存整块失效——
 * 经验证单次 196k uncached);③tool_view 参数不可解析(坏 JSON)不算激活,不得误触发 burst。
 */
import { describe, it, expect } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import { MemoryJournal } from "@lampgenie/core";
import type { LlmProvider, LlmResponse, Tool } from "../src/agent/loop";

const mkTool = (name: string, deferred?: boolean): Tool => ({
  name, description: `desc-${name}`, parameters: { type: "object", properties: { x: { type: "string" } } },
  ...(deferred ? { deferred: true } : {}),
  isConcurrencySafe: () => true,
  async execute() { return `${name}-ok`; },
});

describe("AgentLoop 延迟工具一次性放量(burst)", () => {
  it("零激活:广告面只含未打标工具 + tool_view,不广告任何 deferred(与改前逐字一致)", async () => {
    const faces: string[] = [];
    let n = 0;
    const llm: LlmProvider = {
      async chat(_messages, tools): Promise<LlmResponse> {
        faces.push(JSON.stringify(tools));
        n++;
        if (n === 1) return { content: "", toolCalls: [{ id: "c1", name: "small", arguments: "{}" }] };
        return { content: "done" };
      },
    };
    const loop = new AgentLoop({
      journal: new MemoryJournal(), sessionId: "burst-0", system: "s", llm,
      tools: [mkTool("tool_view"), mkTool("big", true), mkTool("big2", true), mkTool("small")],
    });
    await loop.runTurn("go");
    const first = JSON.parse(faces[0]!) as { name: string }[];
    expect(first.map((t) => t.name)).toEqual(["tool_view", "small"]); // 零激活=不广告 deferred
    expect(faces[1]).toBe(faces[0]); // 只调未打标工具 → 广告面不变
  });

  it("激活 deferred 工具后:本 turn 广告面冻结不变,下一 turn 才整体放量(schema 一轮一冻)", async () => {
    const faces: string[] = [];
    let n = 0;
    const llm: LlmProvider = {
      async chat(_messages, tools): Promise<LlmResponse> {
        faces.push(JSON.stringify(tools));
        n++;
        if (n === 1) return { content: "", toolCalls: [{ id: "c1", name: "tool_view", arguments: '{"name":"big"}' }] };
        if (n === 2) return { content: "", toolCalls: [{ id: "c2", name: "small2", arguments: "{}" }] };
        if (n === 3) return { content: "done" };
        if (n === 4) return { content: "", toolCalls: [{ id: "c4", name: "small2", arguments: "{}" }] };
        return { content: "done" };
      },
    };
    const loop = new AgentLoop({
      journal: new MemoryJournal(), sessionId: "burst-1", system: "s", llm,
      tools: [mkTool("tool_view"), mkTool("big", true), mkTool("big2", true), mkTool("small2")],
    });
    await loop.runTurn("go");
    expect(faces).toHaveLength(3);
    const names = (f: string) => (JSON.parse(f) as { name: string }[]).map((t) => t.name);
    expect(names(faces[0]!)).toEqual(["tool_view", "small2"]); // 首步:零激活
    // 本 turn 内激活 big 也不改 schema(旧版这里会翻转):三步逐字节相同
    expect(faces[1]).toBe(faces[0]);
    expect(faces[2]).toBe(faces[0]);

    // 下一 turn(同 loop 或新 loop,激活集已持久化):全部 deferred 一次性放量
    await loop.runTurn("again");
    const nextTurn = faces[3]!;
    expect(names(nextTurn)).toEqual(["tool_view", "big", "big2", "small2"]);
    expect(faces[4]).toBe(nextTurn); // 该 turn 内继续冻结
  });

  it("tool_view 参数不可解析(坏 JSON):不算激活,不得触发 burst", async () => {
    const faces: string[] = [];
    let n = 0;
    const llm: LlmProvider = {
      async chat(_messages, tools): Promise<LlmResponse> {
        faces.push(JSON.stringify(tools));
        n++;
        if (n === 1) return { content: "", toolCalls: [{ id: "c1", name: "tool_view", arguments: "{not-json" }] };
        if (n === 2) return { content: "", toolCalls: [{ id: "c2", name: "tool_view", arguments: '{"name":"' }] };
        return { content: "done" };
      },
    };
    const loop = new AgentLoop({
      journal: new MemoryJournal(), sessionId: "burst-2", system: "s", llm,
      tools: [mkTool("tool_view"), mkTool("big", true), mkTool("big2", true)],
    });
    await loop.runTurn("go");
    expect(faces).toHaveLength(3);
    expect(faces[1]).toBe(faces[0]); // 坏 JSON → 不激活 → 不放量
    expect(faces[2]).toBe(faces[0]);
    const names = (JSON.parse(faces[2]!) as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["tool_view"]); // 零 deferred 广告(逐字同改前)
  });
});
