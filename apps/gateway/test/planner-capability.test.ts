/**
 * planner 内置子智能体:把「规划逻辑 + 白板使用」抽成独立角色。
 * 契约四点,每点都有断言:
 * ① 声明面:BUILTIN_AGENT_PROFILES 含 planner(工具白名单=读+认知+技能+write_file+白板两件),
 *    写盘围栏 writeGlobs 只到规划稿路径;
 * ② 执行面(toolPolicy 硬件锁):白名单展开后**没有** terminal/run_cmd/edit_file/spawn_subagent/
 *    answer_subagent/task_output/browser/web_*;真实 spawn 时 chat 收到的工具面=上面那个集合;
 * ③ 围栏:planner 角色 write_file 写 成功、写 src/x.ts 被拒(越界拦在写盘层,
 *    不依赖模型自律);
 * ④ 提示词:planner systemPrompt 含需求深挖三问 + accept 要求 + "不写业务代码";主 agent SYSTEM 含
 *    planner 路由纪律(规划类先派 planner / 超时降级内联)。
 * 风格学 subagent-capability.test.ts:真 backend + 真 AgentLoop,替身只在 LLM。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmLoopBackend } from "../src/llm-loop-backend.js";
import { resolveSubagentCapability, buildSubagentExtraTools, buildSubagentToolPolicy, boardReadTool, SYSTEM } from "../src/agent-wiring.js";
import { BUILTIN_AGENT_PROFILES, expandToolTokens } from "@lampgenie/runtime/agent/agent-profiles";
import { ExperienceStore } from "@lampgenie/experience";
import { MemoryJournal } from "@lampgenie/core";
import type { Tool } from "@lampgenie/runtime/agent/loop";

const mk = () => mkdtempSync(join(tmpdir(), "s138planner-"));

/** 装配面探针(与 agent-wiring spawnTool 同映射):记录子代理真实工具名集。 */
async function offeredTools(dir: string, agentType: string, opts: { systemSeen?: (s: string) => void } = {}): Promise<string[]> {
  const cap = resolveSubagentCapability(BUILTIN_AGENT_PROFILES, agentType);
  const journal = new MemoryJournal();
  const planRole = agentType === "planner";
  const extraTools = buildSubagentExtraTools(dir, [], new ExperienceStore(dir), planRole
    ? { journal, sessionId: "s1", owner: "sub-t", planning: true, boardWrite: { taskId: "t1", taskRoot: dir } }
    : undefined);
  const seen: string[] = [];
  const backend = new LlmLoopBackend({
    llm: {
      async chat(messages: { role: string; content: string }[], tools: { name: string }[]) {
        opts.systemSeen?.(String(messages[0]?.content ?? ""));
        for (const t of tools) if (!seen.includes(t.name)) seen.push(t.name);
        return { content: "done" };
      },
    } as never,
    roots: [dir], workdir: dir, role: agentType, stallTimeoutMs: 30_000,
    ...(cap.toolWhitelist ? { toolWhitelist: cap.toolWhitelist, extraTools } : {}),
    ...(cap.writeGlobs ? { writeGlobs: cap.writeGlobs } : {}),
  });
  await backend.spawn({ taskId: "t", instructions: "探针任务", workdir: dir, permissions: "sandbox" }, () => {});
  return seen;
}

/** 脚本 LLM:首步调指定工具一次,次步;返回该工具的真实结果文本。 */
async function runOneTool(dir: string, agentType: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const cap = resolveSubagentCapability(BUILTIN_AGENT_PROFILES, agentType);
  const journal = new MemoryJournal();
  const extraTools = buildSubagentExtraTools(dir, [], new ExperienceStore(dir), { journal, sessionId: "s1", owner: "sub-t", planning: true, boardWrite: { taskId: "t1", taskRoot: dir } });
  let i = 0;
  const results: Record<string, string> = {};
  const backend = new LlmLoopBackend({
    llm: {
      async chat() {
        i++;
        if (i === 1) return { content: "", toolCalls: [{ id: "c1", name: tool, arguments: JSON.stringify(args) }] };
        return { content: "done" };
      },
    } as never,
    roots: [dir], workdir: dir, role: agentType, stallTimeoutMs: 30_000, heartbeatMs: 50,
    ...(cap.toolWhitelist ? { toolWhitelist: cap.toolWhitelist, extraTools } : {}),
    ...(cap.writeGlobs ? { writeGlobs: cap.writeGlobs } : {}),
    onLoopEvent: (e) => { if (e.kind === "tool.result") results[String(e.payload.name)] = String(e.payload.content ?? ""); },
  });
  let done = false;
  await backend.spawn({ taskId: "t", instructions: "探针任务", workdir: dir, permissions: "sandbox" }, (e) => { if (e.type === "result") done = true; });
  for (let t = 0; t < 400 && !done; t++) await new Promise((r) => setTimeout(r, 50));
  return results[tool] ?? "";
}

describe("planner 声明面(agent-profiles)", () => {
  it("内置含 planner:白名单=读+认知+技能+write_file+白板两件;writeGlobs 只到规划稿", () => {
    const p = BUILTIN_AGENT_PROFILES.find((x) => x.name === "planner");
    expect(p).toBeTruthy();
    expect(p!.builtin).toBe(true);
    expect(p!.tools).toEqual(["read", "code_sense", "skill_view", "write_file", "board_upsert", "board_read"]);
    expect(p!.writeGlobs?.some((g) => g.includes("step.md"))).toBe(true);
    // 硬件锁:展开后的白名单结构性不含执行/派发/编辑类
    const granted = expandToolTokens(p!.tools!);
    for (const denied of ["run_cmd", "terminal", "edit_file", "spawn_subagent", "answer_subagent", "task_output", "browser", "web_fetch", "web_search"]) {
      expect(granted).not.toContain(denied);
    }
    expect(granted).toContain("write_file"); // 唯一写工具(且被 writeGlobs 限定)
    expect(granted).toContain("board_upsert");
  });

  it("toolPolicy 快照:source=declared,无 terminal/spawn/run_cmd;池外声明=零 warnings", () => {
    const cap = resolveSubagentCapability(BUILTIN_AGENT_PROFILES, "planner");
    expect(cap.source).toBe("declared");
    expect(cap.writeGlobs?.length).toBeGreaterThan(0);
    const pool = [
      "read_file", "glob", "grep", "list_dir", "write_file", "edit_file", "run_cmd",
      "code_sense", "skill_view", "board_upsert", "board_read",
    ];
    const policy = buildSubagentToolPolicy(cap, "planner", pool);
    expect(policy.source).toBe("declared");
    expect(policy.warnings).toBeUndefined(); // 声明全部落在池内(装配面与声明同源)
    expect(policy.whitelist).toEqual(["read", "code_sense", "skill_view", "write_file", "board_upsert", "board_read"]);
  });

  it("planner 提示词:需求深挖三问 + P0 accept 要求 + 不写业务代码/不跑构建", () => {
    const p = BUILTIN_AGENT_PROFILES.find((x) => x.name === "planner")!;
    const s = p.systemPrompt;
    expect(s).toContain("同类扩展");
    expect(s).toContain("关联传导");
    expect(s).toContain("边界与使用条件");
    expect(s).toContain("第一步半");
    expect(s).toContain('skill_view(category="board"');
    expect(s).toContain("P0");
    expect(s).toContain("accept");
    expect(s).toContain("不写业务代码");
    expect(s).toContain("未决问题");
    expect(s).toContain("DoD");
 // 内容来源层二期:现状节点验证锚 / before 真依据 / 验收带命令。
    expect(s).toContain("内容三问");
    expect(s).toContain("现状从哪来");
    expect(s).toContain("file:line");
    expect(s).toContain("变更前是什么");
    expect(s).toContain("怎么算改对了");
    expect(p.description).toContain("不写业务代码");
  });

  it("planner 提示词:板画现状逻辑,不再要求画「计划」", () => {
    const s = BUILTIN_AGENT_PROFILES.find((x) => x.name === "planner")!.systemPrompt;
    expect(s).toContain("先让人读懂这块代码/内容**现在怎么走**");
    expect(s).toContain("画「现状逻辑」");
    expect(s).not.toContain("画「计划」,不画「进度」");
    expect(s).not.toContain("可执行的计划契约");
    // all-keep 板合格 + 待办不进板 + keep 免 accept
    expect(s).toContain("all-keep");
    expect(s).toContain("改动不是节点,是节点上的标记");
    expect(s).toContain("不得作为节点");
    expect(s).toContain("keep 节点免 accept");
  });
});

describe("planner 执行面(真实 spawn:chat 收到的工具面)", () => {
  it("工具面=读四件+认知两件+skill_view+write_file+board_read(+tool_view 代取延迟的 board_upsert);无 terminal/run_cmd/edit_file/spawn", async () => {
    const dir = mk();
    const got = await offeredTools(dir, "planner").catch((e) => { throw e; });
 // board_upsert 自 起在 CORE_NEVER_DEFER(tool-view.ts:28)——它是 plan-gate 指定出口,
 // 延迟它=闸门要求一个清单里不存在的工具(经验证 38 步同参死循环),所以它常驻 wire 广告面,
    // tool_view 仍保留(其余大 schema 工具按需取)。
 // bridge 三件套恒定追加(tool_view/tool_search/tool_call)
    expect(got.sort()).toEqual([
      "board_read", "board_upsert", "code_sense", "glob", "grep", "list_dir",
      "read_file", "skill_view", "tool_call", "tool_search", "tool_view", "write_file",
    ]);
    // 延迟工具必须能经 tool_view 取到完整说明 —— 这是它「可达」的唯一凭证,不能被静默丢掉
    const dir2 = mk();
    const desc = await runOneTool(dir2, "planner", "tool_view", { name: "board_upsert" });
    expect(desc).toContain("board_upsert");
    expect(desc.length).toBeGreaterThan(500);
    for (const denied of ["terminal", "run_cmd", "edit_file", "spawn_subagent", "answer_subagent", "task_output", "browser", "session_search", "web_fetch", "web_search"]) {
      expect(got).not.toContain(denied);
    }
  }, 30_000);

  it("写盘围栏:规划稿路径可写;业务代码路径被拒且不落盘", async () => {
    const dir = mk();
    mkdirSync(join(dir, "tasks", "-demo"), { recursive: true });
    const ok = await runOneTool(dir, "planner", "write_file", { path: join(dir, "tasks", "-demo", "step.md"), content: "# 规划稿\n" });
    expect(ok).toContain("已写入");
    expect(existsSync(join(dir, "tasks", "-demo", "step.md"))).toBe(true);
    expect(readFileSync(join(dir, "tasks", "-demo", "step.md"), "utf-8")).toContain("规划稿");

    const bad = await runOneTool(dir, "planner", "write_file", { path: join(dir, "src", "evil.ts"), content: "export const x = 1;\n" });
    expect(bad).toContain("写盘越界");
    expect(existsSync(join(dir, "src", "evil.ts"))).toBe(false);
  }, 60_000);

  it("planner 可按需加载板型技能:skill_view(category=board, name=code/collect) 返回分阶段正文", async () => {
    const out = await runOneTool(mk(), "planner", "skill_view", { category: "board", name: "code/collect" });
    expect(out).toContain('<skill_content name="board/code/collect">');
    expect(out).toContain("code_sense");
    expect(out).toContain("impact");
    expect(out).toContain("symbolRef");
    const draw = await runOneTool(mk(), "planner", "skill_view", { category: "board", name: "ui/draw" });
    expect(draw).toContain('<skill_content name="board/ui/draw">');
    expect(draw).toContain("跳转");
  }, 60_000);
});

describe("主链路:planner 落板 → 父 agent board_read 读回并按板引用", () => {
  it("planner 的 board_upsert 落到父会话/父任务 id 的板;父侧 boardReadTool 能读回节点与 P0 accept", async () => {
    const dir = mk();
    const journal = new MemoryJournal();
    const sessionId = "sess-chain";
    const parentTaskId = "t-chain";
    // ① planner 面(与 spawn 装配同映射):board_upsert 绑父会话+父任务 id,storeRoot=临时仓
    const plannerTools = buildSubagentExtraTools(dir, [], new ExperienceStore(dir), {
      journal, sessionId, owner: "sub-x", planning: true, boardWrite: { taskId: parentTaskId, taskRoot: dir, storeRoot: dir },
    });
    const upsert = plannerTools.find((t) => t.name === "board_upsert");
    expect(upsert).toBeTruthy();
    const saved = String(await upsert!.execute({
      title: "链式规划板",
      nodes: [
        { id: "n1", label: "健康检查接口", summary: "GET /healthz 返回 ok/uptimeMs", change: "add", group: "01 接入", phase: "P0", targets: ["apps/gateway/src/server.ts"], accept: [{ cmd: "pnpm vitest run test/healthz.test.ts", expect: "1 passed" }] },
      ],
      edges: [],
    }));
    expect(saved).toContain("设计白板已更新");
    // ② 父 agent 侧 boardReadTool(同会话)读回:节点/accept 原文都在(实施依据=板而非 planner 自述)
    const parentRead = boardReadTool(journal, sessionId, dir);
    const txt = String(await parentRead.execute({ taskId: parentTaskId }));
    expect(txt).toContain("链式规划板");
    expect(txt).toContain("健康检查接口");
    expect(txt).toContain("P0");
    expect(txt).toContain("pnpm vitest run test/healthz.test.ts");
    // ③ planner 自己也能读回(核对闭环)
    const plannerRead = plannerTools.find((t) => t.name === "board_read")!;
    expect(String(await plannerRead.execute({ taskId: parentTaskId }))).toContain("健康检查接口");
  }, 30_000);
});

describe("面板角色显示(planner→「规划」)", () => {
  it("panel 源含 planner 身份色与「规划」显示名,三处渲染都走 subagentRoleName", () => {
    const src = readFileSync(join(process.cwd(), "src", "panel.ts"), "utf-8");
    expect(src).toContain("planner: \"#9b7ad9\""); // 身份色表补一项
    expect(src).toContain("function subagentRoleName(role)");
    expect(src).toContain('role === "planner" ? "规划" : role');
    // 过程卡 / 等待卡 / 子代理目录三处渲染统一走显示名(不直显英文 role)
    expect(src).toContain("esc(subagentRoleName(role))");
    expect(src).toContain("esc(subagentRoleName(en.role))");
  });
});

describe("主 agent 路由纪律(SYSTEM)", () => {
  it("SYSTEM 含 planner 路由段:规划类先派 planner / 任务书三要素 / board_read 按板实施 / 超时降级标注", () => {
    const s = SYSTEM;
    expect(s).toContain("规划委托纪律");
    expect(s).toContain("agentType=\"planner\"");
    expect(s).toContain("board_read");
    expect(s).toContain("降级");
    expect(s).toContain("小修");
  });
});