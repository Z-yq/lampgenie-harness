/**
 * 工具契约投影的两处接线(源码级 + 行为级断言):
 * - tool-view.ts:导出 projectToolsForContext、attachToolView 增 opts.contract、投影只作用于 wire 描述,
 * tool_view 全文分支仍取原始 tools 的完整描述;
 * - agent-wiring.ts:主工具面组装点传真实 ctx(permissionMode/taskClass/agentType/agentProfiles 名列表);
 * - 行为侧:不传 contract 默认逐字不变;传 plan 时写类描述带只读前缀;委派只列真实 agent。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { Tool } from "@lampgenie/runtime/agent/loop";
import { attachToolView, projectToolsForContext } from "../src/tool-view.js";

const TOOL_VIEW_SRC = readFileSync(new URL("../src/tool-view.ts", import.meta.url), "utf8");
const WIRING_SRC = readFileSync(new URL("../src/agent-wiring.ts", import.meta.url), "utf8");

function mkTool(name: string, description: string): Tool {
  return {
    name,
    description,
    parameters: { type: "object", properties: {} },
    async execute() {
      return "ok";
    },
  };
}

describe("接线 1:tool-view.ts", () => {
  it("W1 从 runtime tool-contract 导入并 re-export projectToolsForContext", () => {
    expect(TOOL_VIEW_SRC).toContain('from "@lampgenie/runtime/agent/tool-contract"');
    expect(TOOL_VIEW_SRC).toMatch(/export\s*\{\s*projectToolsForContext\s*\}/);
  });

  it("W2 装配选项带 contract(缺省=不投影)", () => {
    expect(TOOL_VIEW_SRC).toMatch(/interface ToolViewOptions[\s\S]{0,400}?contract\?:\s*ToolContractContext/);
    expect(TOOL_VIEW_SRC).toContain("contract()缺省=不投影");
  });

  it("W3 投影在 wire 侧,且仅在传了 contract 时生效", () => {
    expect(TOOL_VIEW_SRC).toMatch(/opts\?\.contract\s*\?\s*projectToolsForContext\(tools,\s*opts\.contract\)\s*:\s*tools/);
  });

  it("W4 full 说明书仍取原始 tools(不被投影污染)", () => {
    expect(TOOL_VIEW_SRC).toContain("const full = new Map(tools.map((t) => [t.name, t]))");
    expect(TOOL_VIEW_SRC).toContain("fullDocFor(t.name, t.description)");
 // 投影只出现在 wireTools 一处,full 的构造不能引用 wireTools
    expect(TOOL_VIEW_SRC).toMatch(/wireTools\.map/);
    expect(TOOL_VIEW_SRC).not.toMatch(/new Map\(wireTools/);
  });
});

describe("接线 2:agent-wiring.ts", () => {
  it("W5 主工具面组装点传真实 ctx 四个字段", () => {
    const idx = WIRING_SRC.indexOf("const mainTools: Tool[] = attachToolView([");
    expect(idx).toBeGreaterThan(0);
    const tail = WIRING_SRC.slice(idx, idx + 20000);
    const end = tail.indexOf("contract:");
    expect(end).toBeGreaterThan(0);
    const block = tail.slice(end, end + 400);
    expect(block).toContain("permissionMode: permissionMode()");
    expect(block).toContain("taskClass: taskClassState.value");
    expect(block).toContain("availableTools: agentProfiles.map((p) => p.name)");
    expect(block).toContain('agentType: "main"');
  });

  it("W6 只有一处 contract 接线(不重复投影)", () => {
    expect(WIRING_SRC.split("contract: {").length - 1).toBe(1);
  });

  it("W7 接线不硬编码 agent 名单(必须来自 agentProfiles)", () => {
    const idx = WIRING_SRC.indexOf("const mainTools: Tool[] = attachToolView([");
    const tail = WIRING_SRC.slice(idx, idx + 20000);
    const block = tail.slice(tail.indexOf("contract:"), tail.indexOf("contract:") + 400);
    expect(block).not.toMatch(/availableTools:\s*\[/);
  });
});

describe("行为:默认路径与投影效果", () => {
  const writeTool = mkTool("write_file", "把内容写入文件。");
  const readTool = mkTool("read_file", "读取文件内容。");
  const delegate = mkTool("spawn_subagent", "派发子任务给子代理。");
  const tools = [writeTool, readTool, delegate];

  it("B1 不传 contract:描述逐字不变(生产默认行为不变)", () => {
    const out = attachToolView(tools, { defer: false });
    for (const t of tools) {
      const kept = out.find((x) => x.name === t.name)!;
      expect(kept.description).toBe(t.description);
    }
  });

  it("B2 传 plan(short desc 不走摘要):写类描述带只读前缀", () => {
    const out = attachToolView([writeTool], { defer: false, contract: { permissionMode: "plan", availableTools: [] } });
    expect(out[0]!.description.startsWith("当前只读模式,此工具不会执行写操作。")).toBe(true);
  });

  it("B3 同一批工具在投影前后,注册表原对象描述不变", () => {
    const before = writeTool.description;
    attachToolView([writeTool], { defer: false, contract: { permissionMode: "readonly" } });
    expect(writeTool.description).toBe(before);
  });

  it("B4 委派工具只列 availableTools 中真实 agent", () => {
    const out = attachToolView([delegate], { defer: false, contract: { availableTools: ["worker", "planner", "read_file"] } });
    expect(out[0]!.description).toContain("可用 agent:worker, planner。");
    expect(out[0]!.description).not.toContain("explore");
  });

  it("B5 无可用 agent 时追加提示", () => {
    const out = attachToolView([delegate], { defer: false, contract: { availableTools: [] } });
    expect(out[0]!.description).toContain("当前无可委派 agent。");
  });

  it("B6 tool_view 全文仍返回原始描述(投影不进全文)", async () => {
    const out = attachToolView([writeTool], { defer: false, contract: { permissionMode: "plan" } });
    const tv = out.find((x) => x.name === "tool_view")!;
    const text = await tv.execute({ name: "write_file" }, undefined, { callId: "t1" });
    expect(text).toContain("把内容写入文件。");
    expect(text).not.toContain("当前只读模式");
  });

  it("B7 tool-view 转发的 projectToolsForContext 与 runtime 实现同源", () => {
    const out = projectToolsForContext([writeTool], { permissionMode: "plan" });
    expect(out[0]!.description.startsWith("当前只读模式,此工具不会执行写操作。")).toBe(true);
  });
});
