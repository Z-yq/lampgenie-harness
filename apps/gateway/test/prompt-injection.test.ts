import { describe, it, expect, afterEach } from "vitest";
import { wireAgentLoop, soulDisciplinesFor } from "../src/agent-wiring.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { ProjectRegistry } from "../src/projects.js";
import { MemoryJournal } from "@lampgenie/core";
import { deriveMessages } from "@lampgenie/runtime/agent/loop";
import { EchoChildBackend } from "@lampgenie/executors";
import type { LlmProvider } from "@lampgenie/runtime/agent/loop";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function capturingLlm() {
  const seen: { system: string; user: string; tools: string[] }[] = [];
  const llm: LlmProvider = {
    async chat(messages, tools) {
      seen.push({ system: String(messages.find((m) => m.role === "system")?.content ?? ""), user: String(messages.find((m) => m.role === "user")?.content ?? ""), tools: (tools ?? []).map((t) => t.name) });
      return { content: "ok" };
    },
  };
  return { llm, seen };
}

describe("提示词注入修复(审计修复①②④)", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

  it("①AGENTS.md 随任务项目根:项目约定进 system,harness 的不串", async () => {
    dir = mkdtempSync(join(tmpdir(), "gh-agentsproj-"));
    writeFileSync(join(dir, "AGENTS.md"), "PROJECT-CONVENTION-MARKER-9f3: 本项目用 tabs 缩进。");
    const projects = new ProjectRegistry(null);
    const added = projects.add(dir);
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const tm = new TaskSupervisor();
    const journal = new MemoryJournal();
    const { llm, seen } = capturingLlm();
    wireAgentLoop(tm, journal, llm, new EchoChildBackend(), undefined, undefined, undefined, projects);
    const t = tm.submit("user", "agproj", "干活", { projectId: added.project.id });
    await new Promise<void>((res, rej) => {
      const t2 = setTimeout(() => rej(new Error("done 超时")), 15_000);
      const p = setInterval(() => {
        const cur = tm.get(t.id);
        if (cur && ["done", "failed"].includes(cur.state)) { clearTimeout(t2); clearInterval(p); res(); }
      }, 40);
    });
    // orient 预热会先用 llm(user 打头无 system)——取 loop 正式调用(含身份标记)的那次
    const sys = seen.map((x) => x.system).find((x) => x.includes("vibe coding 主 agent")) ?? "";
    expect(sys).toContain("PROJECT-CONVENTION-MARKER-9f3");
    expect(sys).not.toContain("数据同源"); // harness 仓自己的 AGENTS.md 不再串进项目任务
    expect(sys).not.toContain("语音管家的大脑"); // ②身份唯一化:soul 身份行剥离
    expect(sys).toContain("vibe coding 主 agent"); // SYSTEM 为唯一身份
    expect(sys).toContain("行为纪律(soul 继承"); // soul 纪律仍继承
  }, 30_000);

  it("④MCP 工具提级:mcp 提供的工具名进 system 工具清单", async () => {
    const tm = new TaskSupervisor();
    const journal = new MemoryJournal();
    const { llm, seen } = capturingLlm();
    const mcp = { allToolsForAgent: async () => [{ serverId: "s1", serverName: "TestSrv", name: "query_db", description: "查数据库" }], callTool: async () => "ok" };
    wireAgentLoop(tm, journal, llm, new EchoChildBackend(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, mcp as never);
    const t = tm.submit("user", "agmcp", "查一下");
    await new Promise<void>((res) => {
      const p = setInterval(() => { const cur = tm.get(t.id); if (cur && ["done", "failed"].includes(cur.state)) { clearInterval(p); res(); } }, 40);
      setTimeout(() => { clearInterval(p); res(); }, 15_000);
    });
 // system 瘦身:工具清单节不再进 system——MCP 工具经 tools 参数下发(模型可见),
    // system 侧由 tool_view 提供按需查看通道。
    const call = seen.find((x) => x.system.includes("vibe coding 主 agent")) ?? { system: "", user: "", tools: [] as string[] };
    expect(call.tools).toContain("mcp__testsrv__query_db");
    expect(call.system).toContain("tool_view");
  }, 30_000);
});

describe("soul 纪律剥离(修复②)", () => {
  it("剥离首段「你是…」身份行,保留行为纪律;无身份行原样返回", () => {
    const soul = "你是某某管家:与用户交互。\n\n- 直接了当\n- 禁开场白";
    const r = soulDisciplinesFor(soul);
    expect(r).not.toContain("某某管家");
    expect(r).toContain("直接了当");
    expect(r).toContain("禁开场白");
    expect(soulDisciplinesFor("- 纯纪律条目")).toBe("- 纯纪律条目");
  });
});

describe("压缩提醒以 user 角色注入(修复③,opencode synthetic user part)", () => {
  it("message.system → {role:user, [系统提醒] 前缀};首条 system 不受影响", () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "r3", payload: { text: "干活" } });
    j.append({ kind: "message.system", sessionId: "r3", payload: { text: "上下文已压缩,摘要:XYZ" } });
    const msgs = deriveMessages(j, "r3");
    expect(msgs[0]!.role).toBe("user");
    const mid = msgs.find((m) => m.content.includes("上下文已压缩"))!;
    expect(mid.role).toBe("user");
    expect(mid.content).toContain("[系统提醒]");
  });
});
