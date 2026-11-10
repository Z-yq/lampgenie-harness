/**
 * 管理面单测:自定义命令 / 钩子 / 内置技能禁用 / MCP 客户端 / 统计增强。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandStore } from "../src/commands-store.js";
import { HookStore, runHookEvent } from "../src/hooks.js";
import { disabledBuiltins, setBuiltinDisabled } from "../src/skills-admin.js";
import { McpServerStore, McpClient, McpManager } from "../src/mcp.js";
import { MemoryJournal } from "@lampgenie/core";
import { TaskSupervisor } from "../src/task-manager.js";
import { computeStatsSummary } from "../src/stats.js";

describe("CommandStore(自定义命令)", () => {
  it("upsert/list/remove 往返;名称白名单防路径穿越", () => {
    const dir = mkdtempSync(join(tmpdir(), "gwcmd-"));
    try {
      const st = new CommandStore(join(dir, "commands"));
      const r = st.upsert("deploy", "部署到预发:$ARG");
      expect(r && typeof r === "object" && "name" in r && r.name).toBe("deploy");
      st.upsert("review2", "做代码审查");
      expect(st.list().map((x) => x.name)).toEqual(["deploy", "review2"]);
      expect(st.list()[0].body.trim()).toBe("部署到预发:$ARG");
      // 路径穿越/非法名拒绝
      expect("error" in (st.upsert("../evil", "x") as object)).toBe(true);
      expect("error" in (st.upsert("a/b", "x") as object)).toBe(true);
      expect("error" in (st.upsert("", "x") as object)).toBe(true);
      expect("error" in (st.upsert("ok", "") as object)).toBe(true);
      expect(st.remove("deploy")).toBe(true);
      expect(st.remove("deploy")).toBe(false);
      expect(st.list()).toHaveLength(1);
      // upsert 覆盖(同名更新)
      st.upsert("review2", "新版内容");
      expect(st.list()[0].body).toContain("新版");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("HookStore + runHookEvent(任务生命周期钩子)", () => {
  it("CRUD + 事件过滤执行 + journal hook.run + markRun", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gwhook-"));
    try {
      const store = new HookStore(join(dir, "hooks.json"));
      const h1 = store.add({ name: "开始记录", event: "task.start", command: "echo started-$HOOK_TEST" });
      store.add({ name: "完成通知", event: "task.done", command: "echo done" });
      const bad = store.add({ name: "坏事件", event: "bogus", command: "echo x" });
      expect("error" in (bad as object)).toBe(true);
      expect(store.list()).toHaveLength(2);
      // 停用后不执行
      store.update((h1 as { id: string }).id, { enabled: false });

      const journal = new MemoryJournal();
      const tm = new TaskSupervisor();
      const task = tm.submit("user", "s-hook", "做点事", {});
      // task.start 钩子已停用 → 0 条;done 钩子启用 → 1 条
      const n1 = await runHookEvent(store, journal, "task.start", task, dir);
      expect(n1).toBe(0);
      const n2 = await runHookEvent(store, journal, "task.done", task, dir);
      expect(n2).toBe(1);
      const evs = journal.readAll().filter((e) => e.kind === "hook.run");
      expect(evs).toHaveLength(1);
      const p = evs[0].payload as { ok: boolean; output: string; event: string };
      expect(p.event).toBe("task.done");
      expect(p.ok).toBe(true);
      expect(p.output).toContain("done");
      // markRun 回写持久化
      const reloaded = new HookStore(join(dir, "hooks.json"));
      const doneHook = reloaded.list().find((h) => h.event === "task.done")!;
      expect(doneHook.lastRunAt).toBeGreaterThan(0);
      expect(doneHook.lastOk).toBe(true);
      // 失败命令 → ok=false 但流程不抛
      const h3 = store.add({ name: "会失败", event: "task.fail", command: "exit 3" });
      const n3 = await runHookEvent(store, journal, "task.fail", task, dir);
      expect(n3).toBe(1);
      expect(store.list().find((h) => h.id === (h3 as { id: string }).id)!.lastOk).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("skills-admin(内置技能禁用)", () => {
  it("set/read 往返 + 持久化", () => {
    const dir = mkdtempSync(join(tmpdir(), "gwsk-"));
    try {
      expect(disabledBuiltins(dir)).toEqual([]);
      setBuiltinDisabled(dir, "tdd", true);
      setBuiltinDisabled(dir, "simplify-code", true);
      expect(disabledBuiltins(dir)).toEqual(["simplify-code", "tdd"]);
      setBuiltinDisabled(dir, "tdd", false);
      expect(disabledBuiltins(dir)).toEqual(["simplify-code"]);
      expect(existsSync(join(dir, ".genie", "skills-disabled.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MCP 客户端( stdio JSON-RPC)", () => {
  it("fixture 服务器:initialize → tools/list → tools/call 全链路", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gwmcp-"));
    try {
      // 极简 MCP fixture:响应 initialize/tools/list/tools/call。
      const fixture = join(dir, "fixture.mjs");
      writeFileSync(fixture, [
        "import { createInterface } from 'node:readline';",
        "const rl = createInterface({ input: process.stdin });",
        "rl.on('line', (line) => {",
        "  let m; try { m = JSON.parse(line); } catch { return; }",
        "  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '0' } } }) + '\\n');",
        "  else if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [ { name: 'echo', description: '回显' }, { name: 'sum', description: '求和' } ] } }) + '\\n');",
        "  else if (m.method === 'tools/call') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [ { type: 'text', text: 'echo:' + JSON.stringify(m.params.arguments) } ] } }) + '\\n');",
        "  else if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not found' } }) + '\\n');",
        "});",
      ].join("\n"), "utf-8");

      const st = new McpServerStore(join(dir, "mcp.json"));
      const sv = st.add({ name: "fixture", command: process.execPath, args: [fixture] }) as { id: string };
      expect(sv.id).toBeTruthy();

      const client = new McpClient(st.get(sv.id)!);
      await client.start();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["echo", "sum"]);
      const out = await client.callTool("echo", { hello: "世界" });
      expect(out).toContain("echo:");
      expect(out).toContain("世界");
      client.close();

      // 管理器:tools 缓存 + status + callTool + 面板 test
      const mgr = new McpManager(st);
      const mg = await mgr.tools(sv.id);
      expect(mg).toHaveLength(2);
      expect(mgr.statusOf()[sv.id].ok).toBe(true);
      const called = await mgr.callTool(sv.id, "sum", { a: 1 });
      expect(called).toContain("echo:");
      const t = await mgr.test(sv.id);
      expect(t.ok).toBe(true);
      expect(t.tools).toBe(2);
      // agent 工具桥命名
      const forAgent = await mgr.allToolsForAgent();
      expect(forAgent.length).toBe(2);
      expect(forAgent[0].serverName).toBe("fixture");
      mgr.closeAll();
      // 服务器不存在 → fail-soft
      const missing = await mgr.callTool("nope", "x", {});
      expect(missing).toContain("不存在");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});

describe("stats 增强", () => {
  it("峰值/连续天数/健康度/工具维度", () => {
    const j = new MemoryJournal();
    const tm = new TaskSupervisor();
    const DAY = 86_400_000;
    // 三天连续活动(前天/昨天/今天),今天 1 轮,昨天 2 轮(峰值 token 在昨天)
    j.append({ kind: "turn.start", sessionId: "s", payload: { turn: 1 }, time: Date.now() - 2 * DAY } as never);
    j.append({ kind: "turn.start", sessionId: "s", payload: { turn: 2 }, time: Date.now() - DAY } as never);
    j.append({ kind: "turn.start", sessionId: "s", payload: { turn: 3 }, time: Date.now() - DAY + 1000 } as never);
    j.append({ kind: "message.agent", sessionId: "s", payload: { text: "x", usage: { inputTokens: 10, outputTokens: 90 }, llmMs: 3000 }, time: Date.now() - DAY + 2000 } as never);
    j.append({ kind: "tool.result", sessionId: "s", payload: { toolCallId: "c1", name: "code_sense", content: "" }, time: Date.now() - DAY + 3000 } as never);
    j.append({ kind: "tool.result", sessionId: "s", payload: { toolCallId: "c2", name: "code_sense", content: "" }, time: Date.now() - DAY + 4000 } as never);
    j.append({ kind: "tool.result", sessionId: "s", payload: { toolCallId: "c3", name: "spawn_subagent", content: "" }, time: Date.now() - DAY + 5000 } as never);
    j.append({ kind: "turn.start", sessionId: "s", payload: { turn: 4 }, time: Date.now() } as never);
    const s = computeStatsSummary(j, tm, 30);
    expect(s.activity.currentStreak).toBe(3);
    expect(s.activity.longestStreak).toBe(3);
    expect(s.activity.peakTokens).toBe(100); // 昨天 10+90
    expect(s.byTool[0]).toEqual({ name: "code_sense", calls: 2 });
    expect(s.health.samples).toHaveLength(1);
    expect(s.health.samples[0].tps).toBe(30); // 90 out / 3s
    expect(s.health.avgTps).toBe(30);
  });
  it("断档不算连续", () => {
    const j = new MemoryJournal();
    const tm = new TaskSupervisor();
    const DAY = 86_400_000;
    j.append({ kind: "turn.start", sessionId: "s", payload: { turn: 1 }, time: Date.now() - 5 * DAY } as never);
    j.append({ kind: "turn.start", sessionId: "s", payload: { turn: 2 }, time: Date.now() - 4 * DAY } as never);
    j.append({ kind: "turn.start", sessionId: "s", payload: { turn: 3 }, time: Date.now() } as never);
    const s = computeStatsSummary(j, tm, 30);
    expect(s.activity.longestStreak).toBe(2);
    expect(s.activity.currentStreak).toBe(1);
  });
});
