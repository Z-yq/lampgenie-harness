/**
 * spawn journal toolPolicy 快照直测锚(step-069,step-061 遗留③④):
 * ①四形态(有白名单/无白名单兜底/deny-only/MCP 显式开)直测 buildSubagentToolPolicy 纯函数;
 * ②池外工具名 warnings 观测面(不改行为只补观测):声明与工具池零命中的 token → warnings 非空;
 * ③journal 级集成锚:createGatewayApp 真链 spawn,读 gateway.jsonl 断言 subagent.spawn.toolPolicy
 *   载荷真实落盘(declared/fallback/deny-only/池外 warnings 四事件)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { buildSubagentToolPolicy, resolveSubagentCapability } from "../src/agent-wiring.js";
import { BUILTIN_AGENT_PROFILES, loadAgentProfiles } from "@lampgenie/runtime/agent/agent-profiles";

// env 互斥(2026-10-20):threads pool 共享 process.env,动 GENIE_PERMISSION_RULES 等进程级开关的
// 测试文件必须串行,否则并行文件互相拆 env=间歇假红。
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
beforeAll(async () => { await acquireEnvLock("spawn-tool-policy"); }, 240_000); // 等锁可能长(hook 默认 10s 会假红)
afterAll(() => { releaseEnvLock("spawn-tool-policy"); });

const mk = () => mkdtempSync(join(tmpdir(), "s069tp-"));

/** 探针工具池(与 agent-wiring 装配同构:读四+写三+注入面+一个假 MCP 工具)。 */
const POOL = [
  "read_file", "glob", "grep", "list_dir",
  "write_file", "edit_file", "run_cmd",
  "code_sense", "skill_view",
  "mcp__demo__lookup",
];

describe("buildSubagentToolPolicy 四形态(直测锚)", () => {
  it("①有白名单(explore 声明):declared+whitelist 原样 tokens,无 permission 无 warnings", () => {
    const cap = resolveSubagentCapability(BUILTIN_AGENT_PROFILES, "explore");
    const policy = buildSubagentToolPolicy(cap, "explore", POOL);
    expect(policy).toEqual({ source: "declared", role: "explore", whitelist: ["read", "code_sense", "skill_view"] });
    expect(policy.permission).toBeUndefined();
    expect(policy.warnings).toBeUndefined();
  });

  it("②无白名单兜底(未知类型):fallback 且无 whitelist/permission/warnings", () => {
    // 未知类型:profile 缺席→fallback(general 不在 BUILTIN 四型内)
    const unknown = buildSubagentToolPolicy(resolveSubagentCapability(BUILTIN_AGENT_PROFILES, "general"), "general", POOL);
    expect(unknown).toEqual({ source: "fallback", role: "general" });
    expect(unknown.whitelist).toBeUndefined();
    expect(unknown.warnings).toBeUndefined();
  });

  it("③deny-only(strict 声明):whitelist 在场+permission=deny-only", () => {
    const dir = mk();
    mkdirSync(join(dir, ".genie", "agents"), { recursive: true });
    writeFileSync(join(dir, ".genie", "agents", "strict.md"),
      "---\nname: strict\ndescription: deny-only 权限档\ntools: read, write\npermission: deny-only\n---\n提示词。\n");
    const profiles = loadAgentProfiles(dir);
    const cap = resolveSubagentCapability(profiles, "strict");
    const policy = buildSubagentToolPolicy(cap, "strict", POOL);
    expect(policy.source).toBe("declared");
    expect(policy.whitelist).toEqual(["read", "write"]);
    expect(policy.permission).toBe("deny-only");
    expect(policy.warnings).toBeUndefined(); // 池内声明不产生 warnings
  });

  it("④MCP 显式开(mcp__demo 前缀):whitelist 含声明 token 且对池命中→无 warnings;未命中→warnings", () => {
    const dir = mk();
    mkdirSync(join(dir, ".genie", "agents"), { recursive: true });
    writeFileSync(join(dir, ".genie", "agents", "mcp-writer.md"),
      "---\nname: mcp-writer\ndescription: 带 MCP\ntools: read, mcp__demo\n---\n提示词。\n");
    writeFileSync(join(dir, ".genie", "agents", "mcp-bogus.md"),
      "---\nname: mcp-bogus\ndescription: MCP server 不存在\ntools: read, mcp__nosuch\n---\n提示词。\n");
    const profiles = loadAgentProfiles(dir);
    const okPolicy = buildSubagentToolPolicy(resolveSubagentCapability(profiles, "mcp-writer"), "mcp-writer", POOL);
    expect(okPolicy.whitelist).toContain("mcp__demo");
    expect(okPolicy.warnings).toBeUndefined(); // mcp__demo 前缀命中池内 mcp__demo__lookup
    const badPolicy = buildSubagentToolPolicy(resolveSubagentCapability(profiles, "mcp-bogus"), "mcp-bogus", POOL);
    expect(badPolicy.warnings?.join(" ")).toContain("mcp__nosuch");
  });
});

describe("池外工具名 warnings(step-061 遗留④:静默不生效→journal 可观测)", () => {
  it("声明池外工具(code_review)→ warnings 非空且点名;行为面(装配)不受影响", () => {
    const dir = mk();
    mkdirSync(join(dir, ".genie", "agents"), { recursive: true });
    writeFileSync(join(dir, ".genie", "agents", "outer.md"),
      "---\nname: outer\ndescription: 池外声明\ntools: read, code_review\n---\n提示词。\n");
    const profiles = loadAgentProfiles(dir);
    const policy = buildSubagentToolPolicy(resolveSubagentCapability(profiles, "outer"), "outer", POOL);
    expect(policy.source).toBe("declared");
    expect(policy.whitelist).toEqual(["read", "code_review"]); // 原样声明照录(观测面)
    expect(policy.warnings).toHaveLength(1);
    expect(policy.warnings![0]).toContain("code_review");
    expect(policy.warnings![0]).toContain("不生效");
    // worker 声明 "*":匹配一切,不产生 warnings
    const worker = buildSubagentToolPolicy(resolveSubagentCapability(BUILTIN_AGENT_PROFILES, "worker"), "worker", POOL);
    expect(worker.warnings).toBeUndefined();
  });
});

describe("spawn journal toolPolicy(journal 级集成锚:createGatewayApp 真链)", () => {
  it("subagent.spawn 载荷四事件落 gateway.jsonl:declared/fallback/deny-only/池外 warnings", async () => {
    const realRoot = process.env.GENIE_REPO_ROOT;
    const realRules = process.env.GENIE_PERMISSION_RULES;
    const realOrient = process.env.GENIE_SENSE_ORIENT;
    const repo = mk();
    const journalDir = mk();
    try {
      mkdirSync(join(repo, ".genie", "agents"), { recursive: true });
      writeFileSync(join(repo, ".genie", "agents", "strict.md"),
        "---\nname: strict\ndescription: deny-only\ntools: read, write\npermission: deny-only\n---\n提示词。\n");
      writeFileSync(join(repo, ".genie", "agents", "outer.md"),
        "---\nname: outer\ndescription: 池外声明\ntools: read, code_review\n---\n提示词。\n");
      process.env.GENIE_REPO_ROOT = repo;
      process.env.GENIE_SENSE_ORIENT = "off";
      process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
      let cur = "";
      let spawnedForCur = false;
      let seq = 0;
      const app = createGatewayApp({
        port: 0,
        journalDir,
        useExternalHttp: true,
        executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
        llm: {
          async chat(_m: unknown) {
            const s = JSON.stringify(_m);
            if (s.includes("【任务书】")) return { content: "子任务完成" }; // 子 loop 收尾
            if (!spawnedForCur) {
              spawnedForCur = true;
              return { content: "", toolCalls: [{ id: "c" + (++seq), name: "spawn_subagent", arguments: JSON.stringify({ instructions: "帮我探针", agentType: cur }) }] };
            }
            return { content: "主线完成" };
          },
        } as never,
      });
      const runTask = async (sessionId: string, agentType: string) => {
        cur = agentType;
        spawnedForCur = false;
        app.taskManager.submit("user", sessionId, "探针任务(不包含任务书标记)");
        // plan-gate(2026-10-20):general 为写角色,预落合规板放行(本测试焦点是 toolPolicy 载荷,
        // 闸门行为由 plan-gate.test 覆盖);taskRoot=GENIE_REPO_ROOT=repo。
        if (agentType === "general") {
          const t0 = app.taskManager.list().find((x) => x.sessionId === sessionId);
          if (t0) {
            const d = join(repo, ".genie", "boards", sessionId);
            mkdirSync(d, { recursive: true });
            writeFileSync(join(d, `${t0.id}.json`), JSON.stringify({ version: 1, taskId: t0.id, sessionId, title: "探针板", status: "draft", rev: 1, nodes: [{ id: "n1", kind: "module", label: "探针", summary: "toolPolicy 测试" }], edges: [] }), "utf-8");
          }
        }
        for (let i = 0; i < 200; i++) {
          const t = app.taskManager.list().find((x) => x.sessionId === sessionId);
          if (t && (t.state === "done" || t.state === "failed")) return t.state;
          await new Promise((r) => setTimeout(r, 100));
        }
        return "timeout";
      };
      expect(await runTask("s-tp-explore", "explore")).toBe("done");
      expect(await runTask("s-tp-general", "general")).toBe("done");
      expect(await runTask("s-tp-strict", "strict")).toBe("done");
      expect(await runTask("s-tp-outer", "outer")).toBe("done");
      // journal 直读:四个 spawn 事件的 toolPolicy 载荷逐一断言。
      // 2026-10-21 sharded journal(app.ts write-behind+按会话分文件)后旧 gateway.jsonl 冻结不再写入,
      // 内存事件表是权威源(BaseJournal.events),关停前读取(不依赖分片落盘时序)。
      const spawns = app.journal.readAll()
        .map((e) => e as { kind: string; sessionId: string; payload: { toolPolicy?: Record<string, unknown> } })
        .filter((e) => e.kind === "subagent.spawn");
      await app.close();
      expect(spawns).toHaveLength(4);
      const bySession = Object.fromEntries(spawns.map((e) => [e.sessionId, e.payload.toolPolicy]));
      expect(bySession["s-tp-explore"]).toEqual({ source: "declared", role: "explore", whitelist: ["read", "code_sense", "skill_view"] });
      expect(bySession["s-tp-general"]).toEqual({ source: "fallback", role: "general" });
      expect(bySession["s-tp-strict"]).toEqual({ source: "declared", role: "strict", whitelist: ["read", "write"], permission: "deny-only" });
      expect(bySession["s-tp-outer"]).toMatchObject({ source: "declared", role: "outer", whitelist: ["read", "code_review"] });
      expect(String((bySession["s-tp-outer"] as { warnings?: string[] }).warnings?.[0])).toContain("code_review");
    } finally {
      if (realRoot === undefined) delete process.env.GENIE_REPO_ROOT; else process.env.GENIE_REPO_ROOT = realRoot;
      if (realRules === undefined) delete process.env.GENIE_PERMISSION_RULES; else process.env.GENIE_PERMISSION_RULES = realRules;
      if (realOrient === undefined) delete process.env.GENIE_SENSE_ORIENT; else process.env.GENIE_SENSE_ORIENT = realOrient;
    }
  }, 120_000);
});
