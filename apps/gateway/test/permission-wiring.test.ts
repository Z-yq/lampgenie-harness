import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { loadPermissionRules, riskOfTool, LOW_RISK_TOOLS, buildMainLoopPermission } from "../src/agent-wiring.js";
import { setPermissionMode } from "../src/permission-mode.js";
import { setPermissionGuards } from "../src/agent-wiring.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import { wireExecutor } from "../src/executor-wiring.js";
import type { SubagentBackend, SubagentEvent, SubagentHandle, TaskSpec } from "@lampgenie/executors";
import type { Task } from "@lampgenie/core";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// env 互斥:threads pool 共享 process.env,动 GENIE_PERMISSION_RULES 等进程级开关的
// 测试文件必须串行,否则并行文件互相拆 env=间歇假红。
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
beforeAll(async () => { await acquireEnvLock("permission-wiring"); }, 240_000); // 等锁可能长(hook 默认 10s 会假红)
afterAll(() => { releaseEnvLock("permission-wiring"); });

describe("规则装载( F2)", () => {
  let dir: string | null = null;
  const cleanup = () => { delete process.env.GENIE_PERMISSION_RULES; if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } };

  it("env JSON 优先于文件;fromConfig 对象与规则数组双形态;坏 JSON 显式抛错;无源 undefined", () => {
    process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "deny" }]);
    let r = loadPermissionRules("/nonexistent");
    expect(r).toEqual([{ permission: "spawn_subagent", pattern: "*", action: "deny" }]);
    process.env.GENIE_PERMISSION_RULES = JSON.stringify({ code_sense: "ask" });
    r = loadPermissionRules("/nonexistent");
    expect(r).toEqual([{ permission: "code_sense", action: "ask", pattern: "*" }]);
    process.env.GENIE_PERMISSION_RULES = "{broken";
    expect(() => loadPermissionRules("/nonexistent")).toThrow();
    delete process.env.GENIE_PERMISSION_RULES;

    dir = mkdtempSync(join(tmpdir(), "gh-perm-"));
    const genieDir = join(dir, ".genie");
    mkdirSync(genieDir, { recursive: true });
    writeFileSync(join(genieDir, "permissions.json"), JSON.stringify({ board_upsert: "ask" }));
    r = loadPermissionRules(dir);
    expect(r).toEqual([{ permission: "board_upsert", action: "ask", pattern: "*" }]);
    cleanup();
    expect(loadPermissionRules("/nonexistent")).toBeUndefined();
  });
});

/** 可编程 fake backend:按脚本发事件,记录 respondPermission 调用。 */
class FakeAskBackend implements SubagentBackend {
  readonly kind = "fake-ask";
  responds: { requestId: string; decision: string }[] = [];
  async spawn(spec: TaskSpec, onEvent: (e: SubagentEvent) => void): Promise<SubagentHandle> {
    onEvent({ type: "ready" });
    onEvent({ type: "permission-ask", requestId: "r1", summary: "rm -rf /tmp/x", risk: "high" });
    const self = this;
    return {
      taskId: spec.taskId,
      async cancel() {},
      async steer() { return true; },
      async respondPermission(requestId, decision) { self.responds.push({ requestId, decision }); },
    };
  }
}

describe("riskOfTool 集合优先(低风险工具直判)", () => {
  it("LOW_RISK_TOOLS 命中 → low(todo_write 旧正则误判 high 已修)", () => {
    expect(riskOfTool("todo_write")).toBe("low");
    expect(riskOfTool("change_surface")).toBe("low");
    expect(LOW_RISK_TOOLS.has("session_search")).toBe(true);
    expect(LOW_RISK_TOOLS.has("skill_view")).toBe(true);
    expect(LOW_RISK_TOOLS.has("tool_view")).toBe(true);
    expect(LOW_RISK_TOOLS.has("board_read")).toBe(true);
    expect(LOW_RISK_TOOLS.has("list_agents")).toBe(true);
  });
  it("集合外工具走既有正则,行为不变(write_file 仍 high)", () => {
    expect(riskOfTool("write_file")).toBe("high");
    expect(riskOfTool("edit_file")).toBe("high");
    expect(riskOfTool("read_file")).toBe("low");
    expect(riskOfTool("spawn_subagent")).toBe("medium");
  });
});

describe("panelAsk 低风险直批(记账/审计类不占 broker)", () => {
  beforeEach(() => { setPermissionMode("workspace"); setPermissionGuards([]); });
  afterEach(() => { setPermissionMode("ask"); setPermissionGuards([]); });
  it("todo_write:guard abstain 后直批(journal low-risk-auto,broker.ask 0 次)", async () => {
    const journal = new MemoryJournal();
    let brokerCalls = 0;
    const broker = { ask: async () => { brokerCalls += 1; return { decision: "reject" as const, by: "panel" }; } };
    const perm = buildMainLoopPermission([], broker as never, { sessionId: "s-low", journal });
    expect(perm.onAsk).toBeTruthy();
    const ok = await perm.onAsk!({ name: "todo_write", arguments: "{\"todos\":[{\"id\":\"a\",\"status\":\"in_progress\"}]}" });
    expect(ok).toBe(true);
    expect(brokerCalls).toBe(0); // 不咨询 broker
    const gates = journal.readAll().filter((e) => e.kind === "permission.gate").map((e) => e.payload as { tool?: string; effect?: string; by?: string });
    expect(gates.some((g) => g.tool === "todo_write" && g.effect === "allowed" && g.by === "low-risk-auto")).toBe(true);
  });
  it("session_search/tool_view/board_read 同直批;write_file 照旧走 broker", async () => {
    const journal = new MemoryJournal();
    let brokerCalls = 0;
    const broker = { ask: async (input: { tool: string }) => { brokerCalls += 1; return { decision: "allow-once" as const, by: "panel" }; } };
    const perm = buildMainLoopPermission([], broker as never, { sessionId: "s-low2", journal });
    for (const t of ["session_search", "tool_view", "board_read"]) {
      expect(await perm.onAsk!({ name: t, arguments: "{\"q\":\"x\"}" })).toBe(true);
    }
    expect(brokerCalls).toBe(0);
    expect(await perm.onAsk!({ name: "write_file", arguments: "{\"path\":\"a.txt\",\"content\":\"x\"}" })).toBe(true);
    expect(brokerCalls).toBe(1); // 集合外工具照旧咨询
  });
  it("guard deny 优先于低风险直批(收窄不被白名单打回)", async () => {
    setPermissionGuards([{ id: "deny-todo", check: () => ({ verdict: "deny", reason: "禁用" }) }]);
    const journal = new MemoryJournal();
    const broker = { ask: async () => ({ decision: "allow-once" as const, by: "panel" }) };
    const perm = buildMainLoopPermission([], broker as never, { sessionId: "s-low3", journal });
    expect(await perm.onAsk!({ name: "todo_write", arguments: "{}" })).toBe(false);
    const gates = journal.readAll().filter((e) => e.kind === "permission.gate").map((e) => e.payload as { tool?: string; effect?: string; by?: string });
    expect(gates.some((g) => g.tool === "todo_write" && g.effect === "denied" && g.by === "guard-denied")).toBe(true);
  });
});

describe("executor 路径 ask 自动应答( F4)", () => {
  // 环境隔离(C9 修复后补):harness 根 .genie/permissions.json 在生产永远可能存在(「总是允许」产物),
  // 「无规则→auto-fail-closed」断言依赖规则缺席。不用搬文件(与并发测试会话互踩),用 env 显式空集
  // 覆盖(loadPermissionRules env 优先;空 JSON 数组=规则面为空但「在场」→ matchPermissionRule 无命中
  // → auto-fail-closed 路径与无文件一致)。
 // checkpoint 关闭(全量套件经验证):缺省快照在脏工作区+慢盘上跑 git,整测超 5s 超时
  // (单跑必绿=负载敏感非逻辑回归);断言面(journal 双事件+respondPermission)不受影响。
  beforeEach(() => {
    process.env.GENIE_PERMISSION_RULES = "[]";
    process.env.GENIE_CHECKPOINT = "off";
  });
  afterEach(() => {
    delete process.env.GENIE_PERMISSION_RULES;
    delete process.env.GENIE_CHECKPOINT;
  });
  it("permission-ask → journal 双事件 + respondPermission(reject) fail-closed;env 放行时 allow-once", async () => {
    const tm = new TaskSupervisor();
    const journal = new MemoryJournal();
    const backend = new FakeAskBackend();
    wireExecutor(tm, journal, backend);
    const t: Task = tm.submit("user", "pw", "危险任务");
    await new Promise((r) => setTimeout(r, 400));
    const gates = journal.readAll().filter((e) => e.kind === "permission.gate").map((e) => e.payload as { effect: string; by: string });
    expect(gates.some((g) => g.effect === "asked" && g.by.includes("rm -rf"))).toBe(true);
    expect(gates.some((g) => g.effect === "denied" && g.by === "auto-fail-closed")).toBe(true);
    expect(backend.responds).toEqual([{ requestId: "r1", decision: "reject" }]);

    // env 放行形态
    process.env.GENIE_SUBAGENT_ASK = "allow-once";
    const backend2 = new FakeAskBackend();
    const tm2 = new TaskSupervisor();
    const j2 = new MemoryJournal();
    wireExecutor(tm2, j2, backend2);
    tm2.submit("user", "pw2", "再危险一次");
    await new Promise((r) => setTimeout(r, 400));
    expect(backend2.responds[0]!.decision).toBe("allow-once");
    delete process.env.GENIE_SUBAGENT_ASK;
  });
});
