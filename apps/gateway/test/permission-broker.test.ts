/**
 * B2 权限审批端到端:ask→面板广播→应答/超时→执行结果分叉。
 * 三级决策语义:env allow-once > 面板审批 > (无 broker/超时)fail-closed。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionBroker } from "../src/permission-broker.js";

// env 互斥:threads pool 共享 process.env,动 GENIE_PERMISSION_RULES 等进程级开关的
// 测试文件必须串行,否则并行文件互相拆 env=间歇假红。
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
beforeAll(async () => { await acquireEnvLock("permission-broker"); }, 240_000); // 等锁可能长(hook 默认 10s 会假红)
afterAll(() => { releaseEnvLock("permission-broker"); });

describe("PermissionBroker 单元", () => {
  it("无在线面板=立即 reject(不广播,fail-closed 同旧语义)", async () => {
    const sent: unknown[] = [];
    const b = new PermissionBroker(50);
    b.attach((m) => sent.push(m));
    b.online = false;
    const d = await b.ask({ requestId: "r1", sessionId: "s", tool: "subagent", summary: "rm -rf" });
    expect(d).toEqual({ decision: "reject", by: "offline" });
    expect(sent).toHaveLength(0);
  });

  it("在线:广播 ask;面板应答 allow → resolve allow-once", async () => {
    const sent: unknown[] = [];
    const b = new PermissionBroker(5000);
    b.attach((m) => sent.push(m));
    b.online = true;
    const p = b.ask({ requestId: "r2", sessionId: "s", tool: "subagent", summary: "写文件" });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    expect((sent[0] as Record<string, unknown>).type).toBe("permission.ask");
    b.respond("r2", "allow-once");
    expect(await p).toEqual({ decision: "allow-once", by: "panel" });
  });

  it("超时无应答=自动 reject;重复应答无效", async () => {
    const b = new PermissionBroker(40);
    b.online = true;
    const p = b.ask({ requestId: "r3", sessionId: "s", tool: "x", summary: "y" });
    const t0 = Date.now();
    expect(await p).toEqual({ decision: "reject", by: "timeout" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(b.respond("r3", "allow-once")).toBe(false); // 已结算
  });
});

describe("执行路径 ask 三级决策(e2e 语义)", () => {
  // 环境隔离(同 permission-wiring):生产根可能有「总是允许」规则文件,无 broker→fail-closed
  // 断言依赖规则缺席;env 空集覆盖,零文件争用。
 // 补:runTask 会做 checkpoint 快照(git-service)+ExperienceStore 扫描——不设
  // GENIE_REPO_ROOT 时全部落在真仓 9p 树上,高峰期单测 10s 超时假红;改指临时空根(与
  // annotate/nodes-gate WS 用例同口径),还原后清理。
  let oldRoot: string | undefined;
  let tmpRoot = "";
  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "perm-broker-e2e-"));
    oldRoot = process.env.GENIE_REPO_ROOT;
    process.env.GENIE_REPO_ROOT = tmpRoot;
  });
  afterAll(() => {
    if (oldRoot === undefined) delete process.env.GENIE_REPO_ROOT;
    else process.env.GENIE_REPO_ROOT = oldRoot;
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  });
  beforeEach(() => { process.env.GENIE_PERMISSION_RULES = "[]"; });
  afterEach(() => { delete process.env.GENIE_PERMISSION_RULES; });
  it("broker 在线+面板拒绝→panel-denied 落 journal;无 broker→auto-fail-closed(并发测试语义不回退)", async () => {
    const { TaskSupervisor } = await import("../src/task-manager.js");
    const { MemoryJournal } = await import("@lampgenie/core");
    const { wireExecutor } = await import("../src/executor-wiring.js");
    type SubagentEvent = { type: string; requestId?: string; summary?: string; risk?: string };

    const mkBackend = () => ({
      kind: "ask-e2e",
      responds: [] as { requestId: string; decision: string }[],
      async spawn(_spec: unknown, onEvent: (e: SubagentEvent) => void) {
        onEvent({ type: "permission-ask", requestId: "rq1", summary: "rm -rf /tmp/x", risk: "high" });
        onEvent({ type: "result", result: { ok: true, finalText: "done" } });
        return {
          taskId: "t",
          cancel: async () => {},
          steer: async () => true,
          respondPermission: async (requestId: string, decision: string) => {
            (this as unknown as { responds: { requestId: string; decision: string }[] }).responds.push({ requestId, decision });
          },
        };
      },
    });

    // A:无 broker(并发 permission-wiring 语义)
    {
      const backend = mkBackend();
      const tm = new TaskSupervisor();
      const j = new MemoryJournal();
      wireExecutor(tm, j, backend as never);
      tm.submit("user", "permA", "危险活");
      await new Promise((r) => setTimeout(r, 300));
      const gates = j.readAll().filter((e) => e.kind === "permission.gate").map((e) => e.payload as { effect: string; by: string });
      expect(gates.some((g) => g.effect === "denied" && g.by === "auto-fail-closed")).toBe(true);
    }
    // B:broker 在线+面板拒绝
    {
      const backend = mkBackend();
      const tm = new TaskSupervisor();
      const j = new MemoryJournal();
      const broker = new PermissionBroker(2000);
      broker.online = true;
      broker.attach(() => {});
      // 面板拒绝:等 ask 后立即 respond reject
      setTimeout(() => broker.respond("rq1", "reject"), 50);
      wireExecutor(tm, j, backend as never, undefined, undefined, undefined, broker);
      tm.submit("user", "permB", "危险活");
      await new Promise((r) => setTimeout(r, 400));
      const gates = j.readAll().filter((e) => e.kind === "permission.gate").map((e) => e.payload as { effect: string; by: string });
      expect(gates.some((g) => g.effect === "denied" && g.by === "panel-denied")).toBe(true);
      expect(gates.some((g) => g.by === "auto-fail-closed")).toBe(false);
    }
  }, 10_000);
});
