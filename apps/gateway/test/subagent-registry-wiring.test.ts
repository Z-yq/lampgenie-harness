import { AGENT_WIRING_SRC } from "./panel-source.js";
/**
 *  子代理控制面接线测试(读源码 + 纯路径)。
 * 契约:
 * 1) agent-wiring 用进程级 SubagentRegistry,spawn 成功登记(parentId=当前 task.id),
 * 后台/前台/收割/watchdog 各终态点同步 update;
 * 2) mainTools 新增 list_agents / stop_agent;stop_agent 只允许本任务后代(fail-closed);
 * 3) 子代理工具池(buildSubagentExtraTools + SUBAGENT_READ/WRITE_TOOLS)结构性不含这两个名字;
 * 4) 纯路径:registry 的后代隔离语义足以支撑「跨任务拒绝」。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SubagentRegistry } from "@lampgenie/runtime/agent/subagent-registry";

const wiring = AGENT_WIRING_SRC;
const loopBackend = readFileSync(new URL("../src/llm-loop-backend.ts", import.meta.url), "utf-8");

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `找不到起点:${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(endMarker, start + startMarker.length);
  expect(end, `找不到终点:${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("registry 接线", () => {
  it("imports runtime SubagentRegistry", () => {
    expect(wiring).toContain('import { SubagentRegistry } from "@lampgenie/runtime/agent/subagent-registry"');
  });
  it("进程级单例挂 globalThis.__subagentRegistry(可供同进程 re-wire 复用)", () => {
    expect(wiring).toContain("__subagentRegistry");
    expect(wiring).toContain("g.__subagentRegistry = reg;");
  });
  it("首次创建从 __bgAgents 镜像 restore", () => {
    const block = between(wiring, "const subagentRegistry: SubagentRegistry = (() => {", "})();");
    expect(block).toContain("reg.restore(");
    expect(block).toContain("__bgAgents");
  });
  it("spawn 成功登记:parentId=当前 task.id + subTaskId/sessionId/spawnedAt", () => {
    const block = between(wiring, "const registerSubagentRecord = (): void => {", "};");
    expect(block).toContain("subagentRegistry.register({");
    expect(block).toContain("agentId: bgAgentId,");
    expect(block).toContain("taskId: subTaskId,");
    expect(block).toContain("parentId: task.id,");
    expect(block).toContain("sessionId: task.sessionId,");
    expect(block).toContain("spawnedAt: spawnStartAt,");
    expect(block).toContain("deadlineAt: spawnStartAt + deadlineMs");
  });
  it("两条 spawn 路径(后台/前台)都调用注册", () => {
    expect(count(wiring, "registerSubagentRecord();")).toBeGreaterThanOrEqual(2);
  });
  it("终态点覆盖 result / deadline 收割 / watchdog(update 调用 ≥4 处)", () => {
    expect(count(wiring, "subagentRegistry.update(")).toBeGreaterThanOrEqual(4);
    expect(wiring).toContain("[watchdog 收割] 超过时间盒+宽限仍无终态");
    expect(wiring).toContain("resultSummary: partial.slice(0, 200)");
  });
  it("cancel 句柄内部先落 interrupt(stop 与面板终止同一条通路)", () => {
    expect(count(wiring, "subagentRegistry.interrupt(bgAgentId)")).toBeGreaterThanOrEqual(3);
  });
  it("父取消监听落 cancelled", () => {
    const block = between(wiring, "const markSubagentCancelled = () => {", "};");
    expect(block).toContain('state: "cancelled"');
    expect(wiring).toContain('signal?.removeEventListener("abort", markSubagentCancelled)');
  });
});

describe("主工具面 list_agents / stop_agent", () => {
  it("两个工具都有定义", () => {
    expect(wiring).toContain('name: "list_agents"');
    expect(wiring).toContain('name: "stop_agent"');
  });
  it("list_agents 只列自身后代并截断摘要 ≤200", () => {
    const block = between(wiring, "const listAgentsTool: Tool = {", "const stopAgentTool: Tool = {");
    expect(block).toContain("parentId: task.id,");
    expect(block).toContain("resultSummary: r.resultSummary.slice(0, 200)");
    expect(block).toContain("elapsedSec");
    expect(block).toContain("deadlineInSec");
  });
  it("stop_agent 描述写明只能停自己的子代理", () => {
    expect(wiring).toContain("只能停自己的子代理");
    expect(wiring).toContain("只能看自己的子代理");
  });
  it("stop_agent fail-closed:非后代/不存在 → FORBIDDEN 且不碰 cancel 句柄", () => {
    const block = between(wiring, "const stopAgentTool: Tool = {", "const mainTools: Tool[]");
    expect(block).toContain("subagentRegistry.descendants(task.id)");
    expect(block).toContain('code: "FORBIDDEN"');
    expect(block).toContain('code: "ALREADY_TERMINAL"');
    expect(block).toContain('bgAgents.get(id)?.cancel');
 // 拒绝分支必须在取 cancel 之前(顺序即隔离语义)
    expect(block.indexOf('code: "FORBIDDEN"')).toBeLessThan(block.indexOf("bgAgents.get(id)?.cancel"));
  });
  it("两个工具挂在 mainTools 数组里", () => {
    const block = between(wiring, "const mainTools: Tool[] =", "//  工具契约按执行上下文投影");
    expect(block).toContain("listAgentsTool");
    expect(block).toContain("stopAgentTool");
  });
  it("TOOL_HINTS 同步登记两工具(单一出处不漂移)", () => {
    const block = between(wiring, "export const TOOL_HINTS: ToolHint[] = [", "];");
    expect(block).toContain('name: "list_agents"');
    expect(block).toContain('name: "stop_agent"');
  });
});

describe("子代理工具池隔离(越权结构性不可达)", () => {
  it("buildSubagentExtraTools 不含 list_agents/stop_agent", () => {
    const block = between(wiring, "export function buildSubagentExtraTools(", "/** 子代理技能索引文本");
    expect(block).not.toContain("list_agents");
    expect(block).not.toContain("stop_agent");
  });
  it("SUBAGENT_READ/WRITE_TOOLS 定义面不含两工具", () => {
    expect(loopBackend).not.toContain("list_agents");
    expect(loopBackend).not.toContain("stop_agent");
  });
});

describe("纯路径:后代隔离支撑跨任务拒绝", () => {
  it("A 任务的后代集不含 B 任务的子代理;list 不含根自身", () => {
    const reg = new SubagentRegistry();
    reg.register({ agentId: "a-child", parentId: "task-A", taskId: "sub-a", sessionId: "sA", state: "running", spawnedAt: 1 });
    reg.register({ agentId: "b-child", parentId: "task-B", taskId: "sub-b", sessionId: "sB", state: "running", spawnedAt: 2 });
    const allowed = new Set(reg.descendants("task-A"));
    expect(allowed.has("a-child")).toBe(true);
    expect(allowed.has("b-child")).toBe(false);
    expect(reg.list({ parentId: "task-A" }).map((r) => r.agentId)).toEqual(["a-child"]);
  });
  it("interrupt 仅改目标:A 中断后 B 子代理仍 running", () => {
    const reg = new SubagentRegistry();
    reg.register({ agentId: "a-child", parentId: "task-A", taskId: "sub-a", sessionId: "sA", state: "running", spawnedAt: 1 });
    reg.register({ agentId: "b-child", parentId: "task-B", taskId: "sub-b", sessionId: "sB", state: "running", spawnedAt: 2 });
    reg.interrupt("a-child");
    expect(reg.get("a-child")?.state).toBe("interrupted");
    expect(reg.get("b-child")?.state).toBe("running");
  });
});
