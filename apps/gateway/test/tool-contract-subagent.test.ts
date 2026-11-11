/**
 * :子代理工具面也走上下文投影(主/子一致)。
 * - 源码断言:llm-loop-backend.ts 的 attachToolView 调用带 contract(agentType/availableTools/
 * permissionMode),且工具面装配点仍只有这一处(wire 描述投影,不动工具集合);
 * - 纯路径断言:复用 projectToolsForContext(runtime tool-contract)验投影效果——agentType=worker +
 * plan 模式下写类描述带只读前缀;子代理工具名单里没有 agent 名时委派工具提示「当前无可委派 agent」,
 * 不会把自己列成可委派对象。不重复实现投影逻辑。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { Tool } from "@lampgenie/runtime/agent/loop";
import { NO_DELEGATE_NOTE, READONLY_PREFIX } from "@lampgenie/runtime/agent/tool-contract";
import { attachToolView, projectToolsForContext } from "../src/tool-view.js";

const BACKEND_SRC = readFileSync(new URL("../src/llm-loop-backend.ts", import.meta.url), "utf8");

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

/** 子代理侧 attachToolView 调用块(从 `const wireTools = attachToolView(` 起 600 字符)。 */
function subagentAttachBlock(): string {
  const idx = BACKEND_SRC.indexOf("const wireTools = attachToolView(");
  expect(idx).toBeGreaterThan(0);
  return BACKEND_SRC.slice(idx, idx + 600);
}

describe("接线:llm-loop-backend.ts 子代理工具面", () => {
  it("S1 子代理 attachToolView 调用传入 contract", () => {
    expect(subagentAttachBlock()).toMatch(/attachToolView\(tools,\s*\{\s*contract:\s*\{/);
  });

  it("S2 contract 含 agentType=role 与 availableTools=当前工具名单", () => {
    const block = subagentAttachBlock();
    expect(block).toContain("agentType: role");
    expect(block).toContain("availableTools: tools.map((t) => t.name)");
  });

  it("S3 permissionMode 取本进程权威源(不硬编码模式字符串,不猜)", () => {
    expect(BACKEND_SRC).toContain('import { permissionMode } from "./permission-mode.js"');
    expect(subagentAttachBlock()).toMatch(/permissionMode:\s*permissionMode\(\)/);
 // 不得把某个具体模式写死进子代理 contract
    expect(subagentAttachBlock()).not.toMatch(/permissionMode:\s*"(plan|readonly|auto|ask|workspace)"/);
  });

  it("S4 子代理工具面装配点仍只有一处(只换 wire 描述,不增第二套工具面)", () => {
    expect(BACKEND_SRC.split("attachToolView(").length - 1).toBe(1);
  });
});

describe("纯路径:子代理上下文下的投影效果", () => {
  const writeTool = mkTool("write_file", "把内容写入文件。");
  const delegate = mkTool("spawn_subagent", "派发子任务给子代理。");
 // 子代理真实工具名单形态:读/写工具 + 委派工具名,但没有任何 agent 名。
  const subagentToolNames = ["read_file", "write_file", "spawn_subagent"];

  it("P1 agentType=worker + plan:写类描述带只读前缀", () => {
    const out = projectToolsForContext([writeTool], {
      agentType: "worker",
      permissionMode: "plan",
      availableTools: subagentToolNames,
    });
    expect(out[0]!.description.startsWith(READONLY_PREFIX)).toBe(true);
  });

  it("P2 子代理名单无 agent 名:委派工具提示无可委派,不列自己", () => {
    const out = projectToolsForContext([delegate], {
      agentType: "worker",
      permissionMode: "plan",
      availableTools: subagentToolNames,
    });
    expect(out[0]!.description).toContain(NO_DELEGATE_NOTE);
    expect(out[0]!.description).not.toContain("可用 agent:worker");
  });

  it("P3 同一批工具在子代理 contract 下经 attachToolView 生效(与主面同一投影)", () => {
    const tools = [writeTool, delegate];
    const wire = attachToolView(tools, {
      defer: false,
      contract: { agentType: "worker", permissionMode: "plan", availableTools: tools.map((t) => t.name) },
    });
    const w = wire.find((t) => t.name === "write_file")!;
    const d = wire.find((t) => t.name === "spawn_subagent")!;
    expect(w.description.startsWith(READONLY_PREFIX)).toBe(true);
    expect(d.description).toContain(NO_DELEGATE_NOTE);
 // 注册表原对象不被触碰(投影只派生 wire)
    expect(writeTool.description).toBe("把内容写入文件。");
  });

  it("P4 无 contract 时不投影(既有子代理默认路径逐字不变)", () => {
    const out = attachToolView([writeTool], { defer: false });
    expect(out[0]!.description).toBe("把内容写入文件。");
  });
});
