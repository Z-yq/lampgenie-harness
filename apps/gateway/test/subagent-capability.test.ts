/**
 * 子代理能力一致性对拍(step-061「一处声明、执行面真实生效」):
 * ①profile.tools 声明 × 实际装配对拍——四内置型+自定义 .md 的声明经 resolveSubagentCapability
 *   下发 LlmLoopBackend,真实 spawn(脚本化 LLM 记录 chat 收到的工具面)断言「声明=执行」;
 * ②声明粒度:组别名展开/"*"不含 MCP/MCP 显式开启(默认不下发=爆炸面关);
 * ③权限档:inherit(父规则快照)vs deny-only(只下传父 deny)真实分叉;读类 isReadOnly 豁免
 *   (与主 agent 文件六件套读类对齐);file.write 类别规则覆盖子代理写工具(loop 别名);
 * ④skill_view 语义=查看(读全文+索引注入),非执行;未授予=工具面与索引双双缺席。
 * 风格学 permission-passing.test.ts:真 backend+真 AgentLoop+真闸门,替身只在 LLM。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmLoopBackend } from "../src/llm-loop-backend.js";
import { resolveSubagentCapability, buildSubagentExtraTools, renderSubagentSkillIndex } from "../src/agent-wiring.js";
import { BUILTIN_AGENT_PROFILES, expandToolTokens, toolGrantMatched, resolveProfileTools, loadAgentProfiles } from "@lampgenie/runtime/agent/agent-profiles";
import { ExperienceStore } from "@lampgenie/experience";
import type { Tool } from "@lampgenie/runtime/agent/loop";
import type { PermissionRule } from "@lampgenie/core";

const mk = () => mkdtempSync(join(tmpdir(), "s61cap-"));

/** 按声明装配(与 agent-wiring spawnTool 同映射):cap→backend options;llm 由调用方注入(探针可换间谍)。 */
function backendOptions(profiles: ReturnType<typeof loadAgentProfiles>, agentType: string | undefined, dir: string, opts?: { mcpTools?: Tool[]; store?: ExperienceStore }) {
  const cap = resolveSubagentCapability(profiles, agentType);
  return {
    cap,
    options: {
      roots: [dir], workdir: dir, role: agentType ?? "worker", stallTimeoutMs: 30_000,
      ...(cap.toolWhitelist
        ? { toolWhitelist: cap.toolWhitelist, extraTools: buildSubagentExtraTools(dir, opts?.mcpTools ?? [], opts?.store ?? new ExperienceStore(dir)) }
        : {}),
      ...(cap.toolWhitelist && expandToolTokens(cap.toolWhitelist).includes("skill_view") && opts?.store
        ? { skillIndexText: renderSubagentSkillIndex(opts.store) }
        : {}),
    } as ConstructorParameters<typeof LlmLoopBackend>[0],
  };
}

/** 装配面探针:脚本化 LLM 记录 chat 收到的工具名集(=子代理真实工具面)。 */
async function offeredTools(options: ConstructorParameters<typeof LlmLoopBackend>[0], dir: string): Promise<string[]> {
  const seen: string[] = [];
  const backend = new LlmLoopBackend({
    ...options,
    llm: {
      async chat(_m: unknown, tools: { name: string }[]) {
        for (const t of tools) if (!seen.includes(t.name)) seen.push(t.name);
        return { content: "done" };
      },
    } as never,
  });
  await backend.spawn({ taskId: "t", instructions: "探针任务", workdir: dir, permissions: "sandbox" }, () => {});
  return seen;
}

/** 假 MCP 工具(验证默认不下发/显式开启下发;不真调)。 */
const fakeMcpTool = (name: string): Tool => ({
  name, description: "fake mcp", parameters: { type: "object", properties: {} },
  async execute() { return "mcp-ok"; },
});

describe("声明粒度原语(agent-profiles)", () => {
  it("内置四型声明=最小够用分配(worker=* 不含 MCP;explore=读+认知+技能;judge/analyst=读+认知)", () => {
    const byName = Object.fromEntries(BUILTIN_AGENT_PROFILES.map((p) => [p.name, p.tools]));
    expect(byName.worker).toEqual(["*"]);
    expect(byName.explore).toEqual(["read", "code_sense", "skill_view"]);
    expect(byName.judge).toEqual(["read", "code_sense"]);
    expect(byName["test-analyst"]).toEqual(["read", "code_sense"]);
    // "*" 不含 MCP:toolGrantMatched 对 mcp__ 工具恒 false,除非显式 mcp/mcp__ 前缀 token
    expect(toolGrantMatched("read_file", ["*"])).toBe(true);
    expect(toolGrantMatched("mcp__x__y", ["*"])).toBe(false);
    expect(toolGrantMatched("mcp__x__y", ["mcp"])).toBe(true);
    expect(toolGrantMatched("mcp__x__y", ["mcp__x"])).toBe(true);
    expect(toolGrantMatched("mcp__x__y", ["mcp__x__y"])).toBe(true);
    expect(toolGrantMatched("mcp__x__y", ["mcp__other"])).toBe(false);
    // 组别名展开:read=读四件/write=写两件/exec=run_cmd/code_sense=唯一入口(结构面+语义面)
    expect(expandToolTokens(["read"])).toEqual(["read_file", "glob", "grep", "list_dir"]);
    expect(expandToolTokens(["write"])).toEqual(["write_file", "edit_file"]);
    expect(expandToolTokens(["exec"])).toEqual(["run_cmd"]);
    expect(expandToolTokens(["code_sense"])).toEqual(["code_sense"]);
    // 缺席/空=角色二分兜底
    expect(resolveProfileTools(undefined, ["read_file"])).toEqual({ granted: ["read_file"], source: "fallback" });
    expect(resolveProfileTools([], ["read_file"]).source).toBe("fallback");
    expect(resolveProfileTools(["read"], []).source).toBe("declared");
  });
});

describe("声明×执行对拍(真实 spawn:chat 收到的工具面=声明展开集)", () => {
  const customProfiles = (dir: string) => {
    mkdirSync(join(dir, ".genie", "agents"), { recursive: true });
    writeFileSync(join(dir, ".genie", "agents", "custom-writer.md"),
      "---\nname: custom-writer\ndescription: 自定义写手\ntools: read, write, code_sense\n---\n提示词。\n");
    writeFileSync(join(dir, ".genie", "agents", "mcp-writer.md"),
      "---\nname: mcp-writer\ndescription: 带 MCP 的自定义角色\ntools: read, mcp__demo\n---\n提示词。\n");
    writeFileSync(join(dir, ".genie", "agents", "plain.md"),
      "---\nname: plain\ndescription: 无 tools 声明的自定义角色\n---\n提示词。\n");
    writeFileSync(join(dir, ".genie", "agents", "strict.md"),
      "---\nname: strict\ndescription: deny-only 权限档的自定义角色\ntools: read, write\npermission: deny-only\n---\n提示词。\n");
    return loadAgentProfiles(dir);
  };

  it("worker(*=内置全集,不含 MCP):读四件+写三件+code_sense+skill_view", async () => {
    const dir = mk();
    const { cap, options } = backendOptions(BUILTIN_AGENT_PROFILES, "worker", dir, { mcpTools: [fakeMcpTool("mcp__demo__lookup")] });
    expect(cap.source).toBe("declared");
    const got = await offeredTools(options, dir);
    // tool_view(2026-10-22 工具面契约统一):子代理面与主 loop 同款由 attachToolView 无条件追加
    // (长描述摘要化+大 schema 延迟加载的激活入口),不算声明展开集成员但会出现在 chat 收到的工具面。
    // M128:bridge 三件套(tool_view/tool_search/tool_call)无条件追加,故期望数组含它们
    expect(got.sort()).toEqual(["code_sense", "deliverable", "edit_file", "glob", "grep", "list_dir", "read_file", "run_cmd", "skill_view", "tool_call", "tool_search", "tool_view", "write_file"]);
  }, 20_000);

  it("explore/judge/test-analyst:只读+认知(+explore 独有 skill_view),写类结构性缺席", async () => {
    const dir = mk();
    const explore = await offeredTools(backendOptions(BUILTIN_AGENT_PROFILES, "explore", dir, { store: new ExperienceStore(dir) }).options, dir);
    expect(explore.sort()).toEqual(["code_sense", "glob", "grep", "list_dir", "read_file", "skill_view", "tool_call", "tool_search", "tool_view"]);
    const judge = await offeredTools(backendOptions(BUILTIN_AGENT_PROFILES, "judge", dir).options, dir);
    expect(judge.sort()).toEqual(["code_sense", "glob", "grep", "list_dir", "read_file", "tool_call", "tool_search", "tool_view"]);
    const analyst = await offeredTools(backendOptions(BUILTIN_AGENT_PROFILES, "test-analyst", dir).options, dir);
    expect(analyst.sort()).toEqual(["code_sense", "glob", "grep", "list_dir", "read_file", "tool_call", "tool_search", "tool_view"]);
  }, 30_000);

  it("自定义 .md:tools 声明真实生效(read+write+code_sense 按声明装配);无声明=只读兜底", async () => {
    const dir = mk();
    const profiles = customProfiles(dir);
    const w = await offeredTools(backendOptions(profiles, "custom-writer", dir).options, dir);
    expect(w.sort()).toEqual(["code_sense", "deliverable", "edit_file", "glob", "grep", "list_dir", "read_file", "tool_call", "tool_search", "tool_view", "write_file"]);
    // 无 tools 声明:角色二分兜底(名字不在 writeRole 白名单→只读四件,行为同旧版)
    const p = await offeredTools(backendOptions(profiles, "plain", dir).options, dir);
    expect(p.sort()).toEqual(["glob", "grep", "list_dir", "read_file", "tool_call", "tool_search", "tool_view"]);
    expect(resolveSubagentCapability(profiles, "plain").source).toBe("fallback");
  }, 30_000);

  it("MCP 显式开启:声明 mcp__demo 前缀→该 server 工具下发;未声明(含 *)不下发", async () => {
    const dir = mk();
    const profiles = customProfiles(dir);
    const mcp = await offeredTools(backendOptions(profiles, "mcp-writer", dir, { mcpTools: [fakeMcpTool("mcp__demo__lookup"), fakeMcpTool("mcp__other__tool")] }).options, dir);
    expect(mcp).toContain("mcp__demo__lookup");
    expect(mcp).not.toContain("mcp__other__tool");
    expect(mcp).not.toContain("write_file");
  }, 20_000);

  it("真实调用取证:explore 调 write_file=未知工具;调 code_sense=可执行(声明面=执行面)", async () => {
    const dir = mk();
    writeFileSync(join(dir, "a.txt"), "hello");
    const cap = resolveSubagentCapability(BUILTIN_AGENT_PROFILES, "explore");
    const toolResults: Record<string, string> = {};
    let step = 0;
    const backend = new LlmLoopBackend({
      llm: {
        async chat(_m: unknown, tools: { name: string }[]) {
          step++;
          if (step === 1) return { content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: join(dir, "x.txt"), content: "no" }) }] };
          if (step === 2) return { content: "", toolCalls: [{ id: "c2", name: "code_sense", arguments: JSON.stringify({ query: "架构" }) }] };
          return { content: "done" };
        },
      } as never,
      roots: [dir], workdir: dir, role: "explore", heartbeatMs: 50,
      toolWhitelist: cap.toolWhitelist, extraTools: buildSubagentExtraTools(dir, [], new ExperienceStore(dir)),
      onLoopEvent: (e) => {
        if (e.kind === "tool.result") toolResults[String(e.payload.name)] = String(e.payload.content ?? "");
      },
    });
    let done = false;
    await backend.spawn({ taskId: "t", instructions: "探针任务", workdir: dir, permissions: "sandbox" }, (e) => { if (e.type === "result") done = true; });
    for (let t = 0; t < 400 && !done; t++) await new Promise((r) => setTimeout(r, 50));
    expect(toolResults["write_file"]).toContain("未知工具"); // explore 无 write_file→loop 判未知
    expect(existsSync(join(dir, "x.txt"))).toBe(false);
    expect(toolResults["code_sense"]).not.toContain("未知工具"); // 声明的 code_sense 真实可调(执行报错也算在场)
  }, 20_000);

  it("glob/edit_file 新能力真实执行(worker):glob 命中文件;edit_file 精确替换", async () => {
    const dir = mk();
    writeFileSync(join(dir, "a.txt"), "hello world\n");
    const results: Record<string, string> = {};
    let step = 0;
    const cap = resolveSubagentCapability(BUILTIN_AGENT_PROFILES, "worker");
    const backend = new LlmLoopBackend({
      llm: {
        async chat(_m: unknown, tools: { name: string }[]) {
          step++;
          if (step === 1 && tools.some((t) => t.name === "read_file")) {
            return { content: "", toolCalls: [{ id: "g1", name: "glob", arguments: JSON.stringify({ pattern: "*.txt" }) }] };
          }
          if (step === 2) {
            return { content: "", toolCalls: [{ id: "g2", name: "read_file", arguments: JSON.stringify({ path: join(dir, "a.txt") }) }] };
          }
          if (step === 3) {
            return { content: "", toolCalls: [{ id: "g3", name: "edit_file", arguments: JSON.stringify({ path: join(dir, "a.txt"), old_string: "hello", new_string: "bye" }) }] };
          }
          return { content: "done" };
        },
      } as never,
      roots: [dir], workdir: dir, role: "worker", heartbeatMs: 50,
      toolWhitelist: cap.toolWhitelist,
      onLoopEvent: (e) => {
        if (e.kind === "tool.result") results[String(e.payload.name)] = String(e.payload.content ?? "");
      },
    });
    let done = false;
    await backend.spawn({ taskId: "t", instructions: "探针任务", workdir: dir, permissions: "sandbox" }, (e) => { if (e.type === "result") done = true; });
    for (let t = 0; t < 400 && !done; t++) await new Promise((r) => setTimeout(r, 50));
    expect(results["glob"]).toContain("a.txt");
    expect(results["edit_file"]).toContain("已编辑");
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("bye world\n");
  }, 20_000);
});

describe("skill_view 语义=查看(索引注入+授予才可见)", () => {
  it("授予 skill_view→skillIndexText 进系统提示(chat 首条 system 可见索引);未授予→不注入", async () => {
    const dir = mk();
    const store = new ExperienceStore(dir);
    let sawSystem = "";
    const make = (whitelist: string[] | undefined) => new LlmLoopBackend({
      llm: {
        async chat(messages: { role: string; content: string }[]) {
          if (!sawSystem) sawSystem = messages[0]?.content ?? "";
          return { content: "done" };
        },
      } as never,
      roots: [dir], workdir: dir, role: "explore", stallTimeoutMs: 30_000,
      ...(whitelist ? { toolWhitelist: whitelist, extraTools: buildSubagentExtraTools(dir, [], store) } : {}),
      ...(whitelist && expandToolTokens(whitelist).includes("skill_view") ? { skillIndexText: renderSubagentSkillIndex(store) } : {}),
    });
    await make(["read", "code_sense", "skill_view"]).spawn({ taskId: "t1", instructions: "探针任务", workdir: dir, permissions: "sandbox" }, () => {});
    expect(sawSystem).toContain("skill_view");
    expect(sawSystem).toContain("builtin/"); // 内置技能索引在提示里(模型由此知道可读名字)
    sawSystem = "";
    await make(["read", "code_sense"]).spawn({ taskId: "t2", instructions: "探针任务", workdir: dir, permissions: "sandbox" }, () => {});
    expect(sawSystem).not.toContain("skill_view");
  }, 20_000);
});

describe("权限档:inherit vs deny-only + 读类豁免 + 类别别名", () => {
  /** 脚本 LLM:首步调指定工具,次步收口;onLoopEvent 取该工具的真实结果内容。 */
  const runOnce = async (opts: { dir: string; tool: string; args: Record<string, unknown>; rules?: PermissionRule[]; denyOnly?: boolean; ask?: (t: string, s: string) => Promise<boolean> }) => {
    let i = 0;
    const toolContent: Record<string, string> = {};
    const backend = new LlmLoopBackend({
      llm: {
        async chat() {
          i++;
          if (i === 1) return { content: "", toolCalls: [{ id: "x", name: opts.tool, arguments: JSON.stringify(opts.args) }] };
          return { content: "done" };
        },
      } as never,
      roots: [opts.dir], workdir: opts.dir, role: "worker", stallTimeoutMs: 30_000, heartbeatMs: 50,
      ...(opts.rules ? {
        // deny-only 的派生在 wiring 完成(deriveChildRules);此处按同语义构造后端输入。
        permissionRules: opts.denyOnly ? opts.rules.filter((r) => r.action === "deny").map((r) => ({ ...r })) : opts.rules,
        onPermissionAsk: opts.ask ?? (async () => false),
      } : {}),
      onLoopEvent: (e) => { if (e.kind === "tool.result") toolContent[String(e.payload.name)] = String(e.payload.content ?? ""); },
    });
    let result: { ok: boolean } | undefined;
    await backend.spawn({ taskId: "t", instructions: "探针任务", workdir: opts.dir, permissions: "sandbox" }, (e) => { if (e.type === "result") result = e.result as typeof result; });
    for (let t = 0; t < 400 && !result; t++) await new Promise((r) => setTimeout(r, 50));
    if (!result) throw new Error("20s 未收敛");
    return { ok: result.ok, toolResult: toolContent[opts.tool] ?? "" };
  };

  it("deny-only:父 ask 规则不下传→write_file 无闸直落(对照 inherit:ask→审批链 fail-closed 拒)", async () => {
    const rules: PermissionRule[] = [{ permission: "write_file", pattern: "*", action: "ask" }];
    const inheritDir = mk();
    const inherit = await runOnce({ dir: inheritDir, tool: "write_file", args: { path: join(inheritDir, "w.txt"), content: "x" }, rules });
    expect(inherit.toolResult).toContain("被权限审批拒绝"); // inherit:ask→审批链(无面板=fail-closed)
    expect(existsSync(join(inheritDir, "w.txt"))).toBe(false);
    const strictDir = mk();
    const strict = await runOnce({ dir: strictDir, tool: "write_file", args: { path: join(strictDir, "w.txt"), content: "x" }, rules, denyOnly: true });
    expect(strict.toolResult).toContain("已写入"); // deny-only:ask 不下传,无 deny→无闸
    expect(existsSync(join(strictDir, "w.txt"))).toBe(true);
  }, 30_000);

  it("deny-only 仍下传父 deny:run_cmd 被 deny 规则拦(保守面保留);无 deny 时可执行", async () => {
    const dir = mk();
    const denied = await runOnce({
      dir, tool: "run_cmd", args: { command: "echo hi" },
      rules: [{ permission: "write_file", pattern: "*", action: "ask" }, { permission: "run_cmd", pattern: "*", action: "deny" }],
      denyOnly: true,
    });
    expect(denied.toolResult).toContain("被权限规则拒绝"); // deny 规则命中(loop 闸门)
    const dir2 = mk();
    const allowed = await runOnce({ dir: dir2, tool: "run_cmd", args: { command: "echo hi" }, rules: [{ permission: "write_file", pattern: "*", action: "ask" }], denyOnly: true });
    expect(allowed.toolResult).toBe("hi"); // 无 deny→无闸,真执行
  }, 30_000);

  it("读类 isReadOnly 豁免(与主 agent 六件套对齐):父 deny read_file 不再拦读", async () => {
    const dir = mk();
    writeFileSync(join(dir, "a.txt"), "hello");
    const r = await runOnce({ dir, tool: "read_file", args: { path: join(dir, "a.txt") }, rules: [{ permission: "read_file", pattern: "*", action: "deny" }] });
    expect(r.toolResult).toContain("hello"); // 豁免闸门:deny 不生效(主 agent 读类同语义)
  }, 20_000);

  it("file.write 类别别名覆盖子代理写工具(与主 agent 同规则域)", async () => {
    const dir = mk();
    // 新建文件路径(无编辑保鲜前置);file.write 类别 allow 同时覆盖 write_file/edit_file
    const r = await runOnce({ dir, tool: "write_file", args: { path: join(dir, "new.txt"), content: "x" }, rules: [{ permission: "file.write", pattern: "*", action: "allow" }] });
    expect(r.toolResult).toContain("已写入"); // 别名命中 allow→放行(而非 ask fail-closed)
    expect(existsSync(join(dir, "new.txt"))).toBe(true);
  }, 20_000);
});
