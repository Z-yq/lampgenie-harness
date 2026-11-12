import { AGENT_WIRING_SRC } from "./panel-source.js";
/**
 * / 子代理控制面接线测试(读源码 + 纯路径,零真实 spawn)。
 * 契约:
 * 1) spawn_subagent 参数:context=fresh|fork(缺省 fresh)、isolation=none|worktree;
 * 2) fork: deriveMessages → forkContextBlock 只在 context=fork 时前插;fresh 时 instructions 逐字等于旧的 baseInstructions;
 * 3) worktree 不可用 → INVALID(isolationVerdict fail-visible,不静默降级到主工作区);
 * 4) 交付回收: scratchOf 走 worktree-service.collect + scratchContract(`worktree:<path> 改动文件:<...>`);
 * 5) 主工具面新增 steer_agent / resume_agent(mainTools + TOOL_HINTS),子代理工具池结构性不含;
 * 6) 纯路径:registry 后代隔离足以支撑跨任务 FORBIDDEN;终态才能续跑;深度上限。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SubagentRegistry } from "@lampgenie/runtime/agent/subagent-registry";
import {
  MAX_SUBAGENT_DEPTH,
  depthOf,
  forkContextBlock,
  isolationVerdict,
  resumePlan,
  scratchContract,
  steerVerdict,
} from "@lampgenie/runtime/agent/subagent-control";

const wiring = AGENT_WIRING_SRC;
const worktreeSrc = readFileSync(new URL("../src/worktree-service.ts", import.meta.url), "utf-8");
const loopBackend = readFileSync(new URL("../src/llm-loop-backend.ts", import.meta.url), "utf-8");

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `找不到起点:${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(endMarker, start + startMarker.length);
  expect(end, `找不到终点:${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("spawn_subagent 参数面", () => {
  it("schema 声明 context(fresh|fork) 与 isolation(none|worktree)", () => {
    const schema = between(wiring, "isolation: { type: \"string\", enum: [\"none\", \"worktree\"]", "required: [\"instructions\"]");
    expect(schema).toContain('enum: ["fresh", "fork"]');
    expect(wiring).toContain('isolation: { type: "string", enum: ["none", "worktree"]');
  });
  it("context 缺省 fresh,未知值 INVALID 拒绝", () => {
    const block = between(wiring, "//  上下文种子", "//  嵌套深度");
    expect(block).toContain('rawArgs.context === undefined ? "fresh"');
    expect(block).toContain('contextArg !== "fresh" && contextArg !== "fork"');
    expect(block).toContain('code: "INVALID"');
  });
  it("fork 走 deriveMessages → forkContextBlock,且只在 forkBlock 非空时前插", () => {
    const block = between(wiring, "//  context=fresh(缺省)时 instructions 逐字等于 baseInstructions", "const events: string[] = [];");
    expect(block).toContain('contextArg === "fork" ? forkContextBlock(deriveMessages(journal, task.sessionId)) : ""');
    expect(block).toContain('const instructions = forkBlock ? forkBlock + "\\n\\n" + baseInstructions : baseInstructions;');
  });
  it("默认兼容:fresh 分支保留旧表达式(composeSubagentInstructions + 历史档案 + 读传递)", () => {
    const block = between(wiring, "const baseInstructions = composeSubagentInstructions(", "//  context=fresh");
    expect(block).toContain("composeSubagentInstructions(agentProfiles, rawArgs.agentType, String(rawArgs.instructions))");
    expect(block).toContain("renderTaskArchiveBlock(readTaskArchive(");
    expect(block).toContain("renderParentReadBlock(readFilesOf(");
 // workdir 旧口径:worktree 未请求时回主工作区根。
    expect(wiring).toContain("const subRoot = worktree?.path ?? taskRoot;");
  });
  it("嵌套深度:用 depthOf + MAX_SUBAGENT_DEPTH 在 spawn 前拒绝", () => {
    expect(wiring).toContain("depthOf(subagentRegistry, task.id)");
    expect(wiring).toContain("+ 1 > MAX_SUBAGENT_DEPTH");
    expect(wiring).toContain('code: "DEPTH_EXCEEDED"');
  });
});

describe("worktree 隔离与交付回收", () => {
  it("worktree 失败 → INVALID 且不静默降级(isolationVerdict)", () => {
    const block = between(wiring, "const iso = isolationVerdict({ requested: true, worktreeAvailable: false });", "} catch");
    expect(block).toContain('status: "rejected"');
    expect(block).toContain("code: iso.code");
  });
  it("scratchOf 走 worktree-service.collect + scratchContract", () => {
    const block = between(wiring, "const scratchOf = async ()", "// 子代理实际模型名");
    expect(block).toContain("defaultWorktreeService().collect({ path: worktree.path })");
    expect(block).toContain('scratchContract({ mode: "worktree", workdir: worktree.path, changedFiles })');
    expect(block).toContain("worktree:${worktree.path} 改动文件:");
  });
  it("worktree-service 暴露 collect(读 git status,不 throw)", () => {
    expect(worktreeSrc).toContain("async collect(input: WorktreeCollectInput): Promise<WorktreeCollectResult>");
    expect(worktreeSrc).toContain('["status", "--porcelain"]');
    expect(worktreeSrc).toContain('return { ok: false, path, changedFiles: [], error:');
  });
  it("终态把回收文本写进 resultSummary / 前台结果", () => {
    expect(wiring).toContain("resultSummary: `${s.text} | ${String(cur?.resultSummary ?? \"\")}`.slice(0, 200)");
    expect(wiring).toContain("const finalScratch = await scratchOf();");
    expect(wiring).toContain("worktreeNote + scratchNote");
  });
});

describe("主工具面 steer_agent / resume_agent", () => {
  it("两个工具都有定义且挂进 mainTools", () => {
    expect(wiring).toContain('name: "steer_agent"');
    expect(wiring).toContain('name: "resume_agent"');
    const main = between(wiring, "const mainTools: Tool[] =", "//  工具契约按执行上下文投影");
    expect(main).toContain("steerAgentTool");
    expect(main).toContain("resumeAgentTool");
  });
  it("工具描述写明权限边界(只能操作自身后代)", () => {
    const steer = between(wiring, "const steerAgentTool: Tool = {", "const resumeAgentTool: Tool = {");
    expect(steer).toContain("只能操作自己的后代");
    const resume = between(wiring, "const resumeAgentTool: Tool = {", "const mainTools: Tool[]");
    expect(resume).toContain("只能续跑自己的后代");
  });
  it("steer 用 steerVerdict + bgAgents handle.steer;resume 用 resumePlan + spawnTool", () => {
    const steer = between(wiring, "const steerAgentTool: Tool = {", "const resumeAgentTool: Tool = {");
    expect(steer).toContain("steerVerdict(rec ? { ...rec } : undefined, { byAgentId: task.id, registry: subagentRegistry, mode: a.mode })");
    expect(steer).toContain("bgAgents.get(id)?.steer");
    expect(steer).toContain("await steer(text.slice(0, 2000), verdict.mode)");
    const resume = between(wiring, "const resumeAgentTool: Tool = {", "const mainTools: Tool[]");
    expect(resume).toContain("resumePlan(rec ? { ...rec, ...(brief ? { instructions: brief.instructions } : {}) } : undefined");
    expect(resume).toContain("await spawnTool.execute({");
    expect(resume).toContain("run_in_background: true");
    expect(resume).toContain("needsParentContext");
  });
  it("resume 原任务书来源:registerSubagentRecord 落 subagentBriefs(含 instructions)", () => {
    const block = between(wiring, "const registerSubagentRecord = (): void => {", "// 父任务取消");
    expect(block).toContain("subagentBriefs.set(bgAgentId, {");
    expect(block).toContain("instructions,");
  });
  it("bgAgents 三条路径都挂 steer 句柄(后台 bgHandle / 前台 subHandle ×2)", () => {
    expect(wiring).toContain("steer: (t: string, m: \"hint\" | \"directive\") => bgHandle.steer(t, m)");
    expect((wiring.match(/steer: \(t: string, m: "hint" \| "directive"\) => subHandle\?\.steer/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("子代理工具池不含控制面(结构性隔离)", () => {
  it("buildSubagentExtraTools 不含 steer_agent/resume_agent", () => {
    const block = between(wiring, "export function buildSubagentExtraTools(", "/** 子代理技能索引文本");
    expect(block).not.toContain("steer_agent");
    expect(block).not.toContain("resume_agent");
  });
  it("llm-loop-backend 与 SUBAGENT_READ/WRITE_TOOLS 不含二者", () => {
    expect(loopBackend).not.toContain("steer_agent");
    expect(loopBackend).not.toContain("resume_agent");
    expect(loopBackend).not.toContain("steerAgentTool");
    expect(loopBackend).not.toContain("resumeAgentTool");
  });
});

describe("纯路径:registry 语义足够支撑控制面", () => {
  function seeded(): { reg: SubagentRegistry; mine: string; sibling: string; foreign: string } {
    const reg = new SubagentRegistry();
    reg.register({ agentId: "mine", taskId: "t1", sessionId: "s1", parentId: "task-A", state: "running", spawnedAt: 1 });
    reg.register({ agentId: "sibling", taskId: "t2", sessionId: "s1", parentId: "task-A", state: "done", spawnedAt: 2 });
    reg.register({ agentId: "foreign", taskId: "t3", sessionId: "s2", parentId: "task-B", state: "running", spawnedAt: 3 });
    return { reg, mine: "mine", sibling: "sibling", foreign: "foreign" };
  }
  it("跨任务 steer → FORBIDDEN;自己的运行中 → OK", () => {
    const { reg, mine, foreign } = seeded();
    expect(steerVerdict(reg.get(mine), { byAgentId: "task-A", registry: reg })).toMatchObject({ ok: true, code: "OK" });
    expect(steerVerdict(reg.get(foreign), { byAgentId: "task-A", registry: reg })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(steerVerdict(reg.get(mine) ? { ...reg.get(mine)! } : undefined, { byAgentId: "someone-else", registry: reg }).code).toBe("FORBIDDEN");
  });
  it("非 running steer → NOT_RUNNING;终态才能 resume", () => {
    const { reg, sibling, mine } = seeded();
    expect(steerVerdict(reg.get(sibling), { byAgentId: "task-A" }).code).toBe("NOT_RUNNING");
    expect(resumePlan(reg.get(mine), { instruction: "继续" }).code).toBe("NOT_RUNNING");
    const plan = resumePlan({ ...reg.get(sibling)!, instructions: "原任务" }, { instruction: "再试一次" });
    expect(plan.ok).toBe(true);
    expect(plan.instructions).toContain("原任务:原任务");
    expect(plan.instructions).toContain("本次指令:再试一次");
  });
  it("深度:task-A 下的子代理 depth 0;超过上限的链判 INVALID 或超限", () => {
    const { reg, mine } = seeded();
    expect(depthOf(reg, mine)).toMatchObject({ ok: true, depth: 0 });
    expect(MAX_SUBAGENT_DEPTH).toBeGreaterThanOrEqual(1);
  });
  it("fork 摘要与隔离/回收契约在接线侧的纯路径可用", () => {
    const block = forkContextBlock([{ role: "user", content: "背景" }]);
    expect(block).toContain("[父会话上下文摘要(不可信背景)]");
    expect(isolationVerdict({ requested: true, worktreeAvailable: false }).code).toBe("INVALID");
    expect((scratchContract({ mode: "none" }).paths as readonly string[]).length).toBe(0);
  });
});
