/**
 * 工具注册身份治理接线(main agent 装配侧):governToolIdentity 只剔除冲突工具并留一条
 * journal 证据(custom payload.type="tool.identity"),无冲突时零事件(不污染回放)。
 */
import { describe, it, expect } from "vitest";
import { governToolIdentity } from "../src/agent-wiring";
import { MemoryJournal } from "@lampgenie/core";
import type { Tool } from "@lampgenie/runtime/agent/loop";

function mkTool(name: string): Tool {
  return { name, description: `${name} 测试工具`, parameters: { type: "object", properties: {} }, execute: async () => "ok" };
}

function identityEvents(journal: MemoryJournal): Record<string, unknown>[] {
  return journal
    .readAll()
    .filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "tool.identity")
    .map((e) => e.payload as Record<string, unknown>);
}

describe("governToolIdentity", () => {
  it("正常工具面(builtin + mcp__)原样保留,不落身份事件", () => {
    const journal = new MemoryJournal();
    const tools = [mkTool("read_file"), mkTool("glob"), mkTool("mcp__x")];
    const out = governToolIdentity(tools, journal, "s1");
    expect(out).toHaveLength(3);
    expect(out.map((t) => t.name)).toEqual(["read_file", "glob", "mcp__x"]);
    expect(identityEvents(journal)).toHaveLength(0);
  });

  it("两个同名工具 shadow_tool → 只留一个,恰一条身份事件且 removed 含 shadow_tool", () => {
    const journal = new MemoryJournal();
    const first = mkTool("shadow_tool");
    const second = mkTool("shadow_tool");
    const out = governToolIdentity([first, mkTool("read_file"), second], journal, "s1");
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(first); // 先登记者胜,顺序保持
    const events = identityEvents(journal);
    expect(events).toHaveLength(1);
    expect(events[0]!.removed).toEqual(["shadow_tool"]);
    expect(events[0]!.duplicates).toEqual(["shadow_tool"]);
    expect(events[0]!.aliases).toEqual([]);
    expect(events[0]!.at).toBeTypeOf("number");
  });

  it("mcp__ 前缀工具在 duplicates/aliases 为空时不误报", () => {
    const journal = new MemoryJournal();
    const out = governToolIdentity([mkTool("mcp__a"), mkTool("mcp__b"), mkTool("terminal")], journal, "s1");
    expect(out).toHaveLength(3);
    expect(identityEvents(journal)).toHaveLength(0);
  });
});
