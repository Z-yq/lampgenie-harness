/**
 * code_sense 统一入口回归(合并):agent 面只留一个代码认知工具。
 * 断言四件事:
 * ① schema:唯一工具名 code_sense,action(结构面)+ mode(语义面)同场,target/query 各归其位;
 * ② 参数面:action 优先走结构面(impact/symbol/file...),无 action 才走语义 mode(state...);
 *    已删除动作 graph/filegraph/api 给确定性迁移指引(不静默降级);
 * ③ 结构面执行:vars 复用 CLI 实现、wire 与 codesense wire 同源、project 读底座画像——不起 LLM;
 * ④ 工具面:主 agent 装配清单(真 task.progress.tools)与子代理基础池/角色白名单都只有 code_sense,
 *    没有 code_index。主 agent 用脚本化 LLM(纯文本回复)驱动,不跑真实 LLM。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { TOOL_HINTS, buildSubagentExtraTools } from "../src/agent-wiring.js";
import { SENSE_ACTIONS, SENSE_MODES, codeSenseTool, dispatchSenseArgs } from "../src/sense-tool.js";
import { BUILTIN_AGENT_PROFILES, expandToolTokens } from "@lampgenie/runtime/agent/agent-profiles";
import { ExperienceStore } from "@lampgenie/experience";
// 动 GENIE_SENSE_ORIENT/GENIE_CHECKPOINT 进程级开关:与其它测试文件串行(线程池共享 env)。
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";

beforeAll(async () => { await acquireEnvLock("sense-tool-unified"); }, 240_000);
afterAll(() => { releaseEnvLock("sense-tool-unified"); });

const mk = () => mkdtempSync(join(tmpdir(), "sense-unified-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("code_sense schema(唯一入口:action/mode 双面同场)", () => {
  it("工具名=code_sense;properties 含 action/mode/target/query;枚举=10 动作(2026-10-26:+flow)+8 模式", () => {
    const t = codeSenseTool("/tmp/nowhere");
    expect(t.name).toBe("code_sense");
    const params = t.parameters as { properties: Record<string, { enum?: string[] }>; required?: string[] };
    expect(Object.keys(params.properties).sort()).toEqual(["action", "level", "maxNodes", "mode", "query", "root", "target"]);
    expect(params.properties.action!.enum).toEqual([...SENSE_ACTIONS]);
    expect(params.properties.mode!.enum).toEqual([...SENSE_MODES]);
 // action 面:结构动作保留( +branches; +flow; +surface),graph/filegraph/api 已删
    expect(params.properties.action!.enum).toEqual(["symbol", "file", "impact", "entrypoints", "project", "wire", "refs", "surface", "vars", "branches", "flow"]);
    expect(params.properties.action!.enum).not.toContain("api");
    expect(params.properties.action!.enum).not.toContain("graph");
    expect(params.properties.action!.enum).not.toContain("filegraph");
    // 不硬要求 query:结构面 action-only 调用合法(缺项由 execute 用法话术兜住)
    expect(params.required ?? []).toEqual([]);
    expect(t.isReadOnly?.({})).toBe(true);
  });

  it("TOOL_HINTS(code_sense 单条,code_index 已从提示表删除);entrypoints 标注无需手动查", () => {
    const names = TOOL_HINTS.map((h) => h.name);
    expect(names.filter((n) => n === "code_sense")).toHaveLength(1);
    expect(names).not.toContain("code_index");
    const hint = TOOL_HINTS.find((h) => h.name === "code_sense")!.hint;
    expect(hint).toContain("action=impact");
    expect(hint).toContain("mode=debug");
    const desc = codeSenseTool("/tmp/nowhere").description;
    expect(desc).toContain("usually no need to call: already injected in your kickoff context");
  });
});

describe("参数面分派(action 结构面优先,无 action 走语义 mode)", () => {
  it("impact/symbol/file/entrypoints → structural,target 透传", () => {
    expect(dispatchSenseArgs({ action: "impact", target: "loadIndex" })).toEqual({ kind: "structural", action: "impact", target: "loadIndex" });
    expect(dispatchSenseArgs({ action: "symbol", target: "AgentLoop" })).toEqual({ kind: "structural", action: "symbol", target: "AgentLoop" });
    expect(dispatchSenseArgs({ action: "file", target: "apps/gateway/src/agent-wiring.ts" })).toEqual({ kind: "structural", action: "file", target: "apps/gateway/src/agent-wiring.ts" });
    expect(dispatchSenseArgs({ action: "entrypoints" })).toEqual({ kind: "structural", action: "entrypoints", target: "" });
    expect(dispatchSenseArgs({ action: "wire" })).toEqual({ kind: "structural", action: "wire", target: "" });
 // 分支/循环骨架(条件关系)
    expect(dispatchSenseArgs({ action: "branches", target: "modules/asr/qwen_asr.py" })).toEqual({ kind: "structural", action: "branches", target: "modules/asr/qwen_asr.py" });
    // 旧习惯兼容:结构动作把目标写进 query 也按 target 兜住
    expect(dispatchSenseArgs({ action: "symbol", query: "AgentLoop" })).toEqual({ kind: "structural", action: "symbol", target: "AgentLoop" });
  });

  it("action+mode 同时在场 → action 优先(mode 忽略);mode=state 无 action → semantic", () => {
    expect(dispatchSenseArgs({ action: "symbol", target: "x", mode: "state", query: "y" })).toEqual({ kind: "structural", action: "symbol", target: "x" });
    expect(dispatchSenseArgs({ mode: "state", query: "loadIndex" })).toEqual({ kind: "semantic", mode: "state", query: "loadIndex" });
    // 旧 code_sense 调用形态(query-only)兼容:缺省 auto
    expect(dispatchSenseArgs({ query: "AgentLoop" })).toEqual({ kind: "semantic", mode: "auto", query: "AgentLoop" });
  });

  it("已删除动作(graph/filegraph/api)→ 显式迁移指引;未知动作/空参数 → invalid 用法话术", () => {
    const api = dispatchSenseArgs({ action: "api" });
    expect(api.kind).toBe("invalid");
    expect(api.kind === "invalid" ? api.reason : "").toContain("mode=api");
    for (const retired of ["graph", "filegraph"]) {
      const r = dispatchSenseArgs({ action: retired, target: "x" });
      expect(r.kind).toBe("invalid");
      expect(r.kind === "invalid" ? r.reason : "").toContain(`${retired} 已删除`);
    }
    const unknown = dispatchSenseArgs({ action: "bogus" });
    expect(unknown.kind).toBe("invalid");
    expect(unknown.kind === "invalid" ? unknown.reason : "").toContain("未知 action");
    expect(dispatchSenseArgs({})).toMatchObject({ kind: "invalid" });
    expect(dispatchSenseArgs({ query: "   " })).toMatchObject({ kind: "invalid" });
  });
});

describe("结构面执行(sense-tool 实调,不跑 LLM)", () => {
  it("action=project:画像缺席 → 显式引导 codesense project --write(静态 manifest 面)", async () => {
    const d = mk();
    const out = await codeSenseTool(d).execute({ action: "project" });
    expect(out).toContain("项目画像未生成");
  });

  it("action=vars:复用 CLI queryVarsCmd(类型分组清单,缺 target 给用法)", async () => {
    const d = mk();
    writeFileSync(join(d, "sample.ts"), "export const count: number = 1;\nexport const label: string = 'x';\n", "utf-8");
    const out = await codeSenseTool(d).execute({ action: "vars", target: "sample.ts" });
    expect(out).toContain("sample.ts");
    expect(out).toContain("number");
    expect(out).toContain("string");
    expect(String(await codeSenseTool(d).execute({ action: "vars" }))).toContain("需要 target=文件相对路径");
  });

  it("action=wire:与 codesense wire 同源,空根也返回协议表面摘要(不是错误)", async () => {
    const d = mk();
    const out = await codeSenseTool(d).execute({ action: "wire" });
    expect(out).toContain("WS 消息协议表面");
    expect(out).not.toContain("code_sense 错误");
  });

  it("action=impact/symbol/file 缺 target → 前置用法话术(不盲查)", async () => {
    const d = mk();
    expect(String(await codeSenseTool(d).execute({ action: "impact" }))).toContain("需要 target=符号名");
    expect(String(await codeSenseTool(d).execute({ action: "symbol" }))).toContain("需要 target=符号名");
    expect(String(await codeSenseTool(d).execute({ action: "file" }))).toContain("需要 target=文件相对路径");
  });
});

describe("合并后工具面(主 agent + 子代理)", () => {
  it("子代理基础池与内置角色白名单:只有 code_sense,无 code_index", () => {
    const d = mk();
    const names = buildSubagentExtraTools(d, [], new ExperienceStore(d)).map((t) => t.name);
    expect(names).toContain("code_sense");
    expect(names).not.toContain("code_index");
    // 组别名 code_sense=单入口(不再展开出 code_index)
    expect(expandToolTokens(["code_sense"])).toEqual(["code_sense"]);
    for (const p of BUILTIN_AGENT_PROFILES) {
      const granted = p.tools ? expandToolTokens(p.tools) : [];
      expect(granted, `${p.name} 白名单`).not.toContain("code_index");
    }
  });

  it("主 agent 装配面(task.progress.tools):含 code_sense,不含 code_index", async () => {
    const realOrient = process.env.GENIE_SENSE_ORIENT;
    const realCheckpoint = process.env.GENIE_CHECKPOINT;
    process.env.GENIE_SENSE_ORIENT = "off"; // 不开工预扫描(本测试只验工具面)
    process.env.GENIE_CHECKPOINT = "off"; // 跳过 git stash create
    const app = createGatewayApp({
      port: 0,
      useExternalHttp: true,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      // 脚本化 LLM:纯文本回复、不调工具(=不跑真实 LLM,也不产生写盘/派发)
      llm: { async chat() { return { content: "工具面检查完成(不调工具)" }; } } as never,
    });
    try {
      const sessionId = "sense-unified-main";
      app.taskManager.submit("user", sessionId, "报告工具面(此任务由 sense-tool-unified 测试驱动)");
      let manifest: string[] | undefined;
      for (let i = 0; i < 200 && !manifest; i++) {
        const ev = app.journal.readAll().find((e) =>
          e.sessionId === sessionId && e.kind === "task.progress"
          && Array.isArray((e.payload as { tools?: unknown }).tools));
        if (ev) manifest = (ev.payload as { tools: string[] }).tools;
        else await sleep(50);
      }
      expect(manifest, "task.progress.tools 装配快照必须在案").toBeTruthy();
      expect(manifest!).toContain("code_sense");
      expect(manifest!).not.toContain("code_index");
    } finally {
      await app.close();
      if (realOrient === undefined) delete process.env.GENIE_SENSE_ORIENT; else process.env.GENIE_SENSE_ORIENT = realOrient;
      if (realCheckpoint === undefined) delete process.env.GENIE_CHECKPOINT; else process.env.GENIE_CHECKPOINT = realCheckpoint;
    }
  }, 60_000);
});
