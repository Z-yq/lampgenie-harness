/**
 * M151 审批对象=执行对象:纯函数(canonical hash/deepFreeze/verify/受控改参)+
 * 三处接线(executor 子代理 ask、worker permission.ask RPC、agent-wiring parent-ask 两处)。
 *
 * 核心断言语义:批准的是 A、执行的是 B 时按 denied/object-changed 处理(fail-closed),
 * asked/decided 的 objectHash 成对一致。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  applyInputAdjustments,
  approvalObjectHash,
  deepFreeze,
  snapshotApprovalObject,
  verifyApprovalObject,
} from "../src/approval-object.js";
import { MemoryJournal } from "@lampgenie/core";
import type { SubagentBackend, SubagentEvent, SubagentHandle, TaskSpec } from "@lampgenie/executors";
import { PermissionBroker } from "../src/permission-broker.js";
import { askPermissionWithApprovalObject } from "../src/session-worker-host.js";
import { buildMainLoopPermission, makeSubagentPermissionAsker } from "../src/agent-wiring.js";
import { setPermissionMode } from "../src/permission-mode.js";

// env 互斥(与 permission-broker/wiring 同纪律):动 GENIE_PERMISSION_RULES 等进程级开关必须串行。
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
beforeAll(async () => { await acquireEnvLock("approval-object"); }, 240_000);
afterAll(() => { releaseEnvLock("approval-object"); });

describe("canonical hash", () => {
  it("键序不同同 hash;数组序不同不同 hash;undefined/函数忽略", () => {
    expect(approvalObjectHash({ a: 1, b: 2 })).toBe(approvalObjectHash({ b: 2, a: 1 }));
    expect(approvalObjectHash({ a: [1, 2] })).not.toBe(approvalObjectHash({ a: [2, 1] }));
    expect(approvalObjectHash({ a: 1, b: undefined })).toBe(approvalObjectHash({ a: 1 }));
    expect(approvalObjectHash({ a: 1, fn: () => 1 })).toBe(approvalObjectHash({ a: 1 }));
    expect(approvalObjectHash({ nested: { y: 1, x: 2 } })).toBe(approvalObjectHash({ nested: { x: 2, y: 1 } }));
  });

  it("hash 为 sha256 前 16 位十六进制(定长)", () => {
    expect(approvalObjectHash({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("snapshot / deepFreeze", () => {
  it("嵌套对象冻结;严格模式下外部 mutation 抛错;冻结件与入参解耦", () => {
    const input = { spec: { instructions: "run", tools: ["a", "b"] } };
    const snap = snapshotApprovalObject(input);
    expect(snap.ok).toBe(true);
    if (!snap.ok) throw new Error("snapshot 应成功");
    expect(Object.isFrozen(snap.frozen)).toBe(true);
    expect(Object.isFrozen((snap.frozen as { spec: unknown }).spec)).toBe(true);
    expect(() => { (snap.frozen as { spec: { instructions: string } }).spec.instructions = "changed"; }).toThrow();
    // 原入参不受冻结影响(是深拷贝)
    input.spec.instructions = "later";
    expect((snap.frozen as { spec: { instructions: string } }).spec.instructions).toBe("run");
  });

  it("循环引用→APPROVAL_OBJECT_CYCLE;bigint→NOT_SERIALIZABLE", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const r = snapshotApprovalObject(cyclic);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("APPROVAL_OBJECT_CYCLE");
    const b = snapshotApprovalObject({ n: 1n });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe("APPROVAL_OBJECT_NOT_SERIALIZABLE");
  });

  it("deepFreeze 幂等且可冻结普通对象", () => {
    const o = deepFreeze({ a: { b: 1 } });
    expect(Object.isFrozen(o)).toBe(true);
    expect(Object.isFrozen(o.a)).toBe(true);
    expect(deepFreeze(o)).toBe(o);
  });
});

describe("verifyApprovalObject", () => {
  it("未改→ok;改一字段→PERMISSION_OBJECT_CHANGED 带双 hash", () => {
    const obj = { tool: "bash", args: { cmd: "rm -rf /tmp/a" } };
    const snap = snapshotApprovalObject(obj);
    if (!snap.ok) throw new Error("snapshot 应成功");
    expect(verifyApprovalObject(snap.frozen, { tool: "bash", args: { cmd: "rm -rf /tmp/a" } })).toEqual({ ok: true });
    const v = verifyApprovalObject(snap.frozen, { tool: "bash", args: { cmd: "rm -rf /" } });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("PERMISSION_OBJECT_CHANGED");
      expect(v.beforeHash).toBe(snap.hash);
      expect(v.afterHash).not.toBe(snap.hash);
    }
  });

  it("frozen 被克隆丢标记/未真冻结→PERMISSION_OBJECT_TAMPERED", () => {
    const snap = snapshotApprovalObject({ a: 1 });
    if (!snap.ok) throw new Error("snapshot 应成功");
    // spread 克隆:非枚举标记丢失
    const spread = { ...(snap.frozen as Record<string, unknown>) };
    const v1 = verifyApprovalObject(spread, { a: 1 });
    expect(v1.ok).toBe(false);
    if (!v1.ok) expect(v1.code).toBe("PERMISSION_OBJECT_TAMPERED");
    // JSON 克隆后手工冻结:值相同但无审批标记
    const clone = JSON.parse(JSON.stringify(snap.frozen)) as Record<string, unknown>;
    deepFreeze(clone);
    const v2 = verifyApprovalObject(clone, { a: 1 });
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.code).toBe("PERMISSION_OBJECT_TAMPERED");
  });
});

describe("applyInputAdjustments(受控改参)", () => {
  it("allowlist 内改→changed+applied+rejudgeRequired;值不变→changed=false", () => {
    const input = { workdir: "/a", summary: "s" };
    const r = applyInputAdjustments(input, { workdir: "/b" }, ["workdir"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.applied).toEqual(["workdir"]);
      expect(r.changed).toBe(true);
      expect(r.rejudgeRequired).toBe(true);
      expect(r.value.workdir).toBe("/b");
      expect(input.workdir).toBe("/a"); // 原对象不被改
    }
    const same = applyInputAdjustments(input, { workdir: "/a" }, ["workdir"]);
    expect(same.ok).toBe(true);
    if (same.ok) {
      expect(same.changed).toBe(false);
      expect(same.rejudgeRequired).toBe(false);
    }
  });

  it("越权字段→ADJUSTMENT_NOT_ALLOWED(不静默丢弃)", () => {
    const r = applyInputAdjustments({ a: 1 }, { b: 2 }, ["a"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("ADJUSTMENT_NOT_ALLOWED");
      expect(r.field).toBe("b");
    }
  });
});

/** 可编程 fake backend:事件对象可被外部替换(spawn 后再改=典型 TOCTOU)。 */
class MutableAskBackend implements SubagentBackend {
  readonly kind = "approval-object-fake";
  event: SubagentEvent;
  responds: { requestId: string; decision: string }[] = [];
  constructor(event: SubagentEvent) { this.event = event; }
  async spawn(spec: TaskSpec, onEvent: (e: SubagentEvent) => void): Promise<SubagentHandle> {
    onEvent(this.event);
    const responds = this.responds;
    return {
      taskId: spec.taskId,
      async cancel() {},
      async steer() { return true; },
      async respondPermission(requestId, decision) { responds.push({ requestId, decision }); },
    };
  }
}

function gatesOf(journal: MemoryJournal): Record<string, unknown>[] {
  return journal.readAll().filter((e) => e.kind === "permission.gate").map((e) => e.payload as Record<string, unknown>);
}

describe("executor-wiring 接线(子代理 ask)", () => {
  beforeEach(() => {
    process.env.GENIE_PERMISSION_RULES = "[]";
    process.env.GENIE_CHECKPOINT = "off";
    delete process.env.GENIE_SUBAGENT_ASK;
  });
  afterEach(() => {
    delete process.env.GENIE_PERMISSION_RULES;
    delete process.env.GENIE_CHECKPOINT;
    delete process.env.GENIE_SUBAGENT_ASK;
  });

  async function runCase(mutate: boolean) {
    const { TaskSupervisor } = await import("../src/task-manager.js");
    const { wireExecutor } = await import("../src/executor-wiring.js");
    const tm = new TaskSupervisor();
    const journal = new MemoryJournal();
    const backend = new MutableAskBackend({ type: "permission-ask", requestId: "rq1", summary: "rm -rf /tmp/x", risk: "high" });
    const broker = new PermissionBroker(3000);
    broker.online = true;
    const askSeen = new Promise<void>((resolve) => {
      broker.attach((m) => { if (m.type === "permission.ask") resolve(); });
    });
    wireExecutor(tm, journal, backend, undefined, undefined, undefined, broker);
    tm.submit("user", "approval-obj", "危险活");
    await askSeen;
    if (mutate) (backend.event as { summary: string }).summary = "rm -rf /"; // 同一对象被改写(闭包仍持有引用)
    broker.respond("rq1", "allow-once");
    await new Promise((r) => setTimeout(r, 200));
    return { journal, backend };
  }

  it("ask 后事件对象被替换→object-changed + denied,回包 reject;asked/decided hash 一致", async () => {
    const { journal, backend } = await runCase(true);
    const gates = gatesOf(journal);
    const asked = gates.find((g) => g.effect === "asked");
    const changed = gates.find((g) => g.effect === "object-changed");
    const denied = gates.find((g) => g.effect === "denied");
    expect(asked).toBeTruthy();
    expect(typeof asked!.objectHash).toBe("string");
    expect(changed).toBeTruthy();
    expect(changed!.code).toBe("PERMISSION_OBJECT_CHANGED");
    expect(typeof changed!.beforeHash).toBe("string");
    expect(changed!.afterHash).not.toBe(changed!.beforeHash);
    expect(denied!.by).toBe("object-changed");
    expect(denied!.objectHash).toBe(asked!.objectHash);
    expect(backend.responds).toEqual([{ requestId: "rq1", decision: "reject" }]);
    expect(gates.some((g) => g.effect === "allowed")).toBe(false);
  }, 10_000);

  it("未改参→原路径通过(allowed + allow-once),无 object-changed", async () => {
    const { journal, backend } = await runCase(false);
    const gates = gatesOf(journal);
    const asked = gates.find((g) => g.effect === "asked");
    const allowed = gates.find((g) => g.effect === "allowed");
    expect(gates.some((g) => g.effect === "object-changed")).toBe(false);
    expect(allowed).toBeTruthy();
    expect(allowed!.objectHash).toBe(asked!.objectHash);
    expect(backend.responds).toEqual([{ requestId: "rq1", decision: "allow-once" }]);
  }, 10_000);
});

describe("session-worker-host permission.ask RPC", () => {
  it("ask 后 payload.args 被改→{decision:reject} + object-changed 审计", async () => {
    const payload = { sessionId: "s1", tool: "bash", summary: "rm -rf /tmp/x", args: { cmd: "rm -rf /tmp/x" } };
    const broker = {
      async ask() {
        (payload.args as { cmd: string }).cmd = "rm -rf /"; // 确认窗内被替换
        return { decision: "allow-once" as const, by: "panel" as const };
      },
    } as unknown as PermissionBroker;
    const journal = new MemoryJournal();
    const out = await askPermissionWithApprovalObject(broker, journal, "w-r1-1", payload);
    expect(out).toEqual({ decision: "reject", by: "object-changed" });
    const gate = gatesOf(journal).find((g) => g.effect === "object-changed");
    expect(gate).toBeTruthy();
    expect(gate!.code).toBe("PERMISSION_OBJECT_CHANGED");
  });

  it("未改参→原样返回 allow-once,不落 object-changed", async () => {
    const broker = {
      async ask() { return { decision: "allow-once" as const, by: "panel" as const }; },
    } as unknown as PermissionBroker;
    const journal = new MemoryJournal();
    const out = await askPermissionWithApprovalObject(broker, journal, "w-r2-1", { sessionId: "s2", tool: "bash", summary: "ls" });
    expect(out).toEqual({ decision: "allow-once", by: "panel" });
    expect(gatesOf(journal).some((g) => g.effect === "object-changed")).toBe(false);
  });
});

describe("agent-wiring parent-ask(两处)", () => {
  beforeEach(() => {
    process.env.GENIE_PERMISSION_RULES = "[]";
    delete process.env.GENIE_PERM_ASK_MODE;
    delete process.env.GENIE_SUBAGENT_ASK;
    setPermissionMode("ask");
  });
  afterEach(() => {
    delete process.env.GENIE_PERMISSION_RULES;
    delete process.env.GENIE_PERM_ASK_MODE;
    delete process.env.GENIE_SUBAGENT_ASK;
    setPermissionMode("ask");
  });

  it("makeSubagentPermissionAsker:ask 后请求对象被改→denied/object-changed", async () => {
    const journal = new MemoryJournal();
    const broker = {
      async ask(input: { summary: string }) {
        input.summary = input.summary + "(被改)";
        return { decision: "allow-once" as const, by: "panel" };
      },
    };
    const asker = makeSubagentPermissionAsker({ sessionId: "s3", journal, broker, rulesRoot: "/nonexistent-approval-object" });
    expect(await asker("write_file", "写 /tmp/a")).toBe(false);
    const gates = gatesOf(journal);
    expect(gates.some((g) => g.effect === "object-changed")).toBe(true);
    const denied = gates.find((g) => g.effect === "denied");
    expect(denied).toBeTruthy();
    expect(denied!.by).toBe("object-changed");
    expect(typeof denied!.objectHash).toBe("string");
  });

  it("makeSubagentPermissionAsker:未改参→allowed/panel-approved 且带 objectHash", async () => {
    const journal = new MemoryJournal();
    const broker = { async ask() { return { decision: "allow-once" as const, by: "panel" }; } };
    const asker = makeSubagentPermissionAsker({ sessionId: "s4", journal, broker, rulesRoot: "/nonexistent-approval-object" });
    expect(await asker("write_file", "写 /tmp/b")).toBe(true);
    const allowed = gatesOf(journal).find((g) => g.effect === "allowed");
    expect(allowed).toBeTruthy();
    expect(allowed!.by).toBe("panel-approved");
    expect(typeof allowed!.objectHash).toBe("string");
  });

  it("buildMainLoopPermission.onAsk:ask 后 arguments 被改→返回 false(按拒绝执行)", async () => {
    const journal = new MemoryJournal();
    const execCall = { name: "write_file", arguments: "{\"path\":\"/tmp/a\"}" };
    const broker = {
      async ask() {
        execCall.arguments = "{\"path\":\"/etc/passwd\"}"; // 同一调用对象被替换
        return { decision: "allow-once" as const, by: "panel" };
      },
    };
    const perm = buildMainLoopPermission([], broker as never, { sessionId: "s5", journal });
    const onAsk = perm.onAsk;
    expect(onAsk).toBeTruthy();
    expect(await onAsk!(execCall)).toBe(false);
    const gates = gatesOf(journal);
    expect(gates.some((g) => g.effect === "object-changed")).toBe(true);
    expect(gates.find((g) => g.effect === "denied")!.by).toBe("object-changed");
  });
});
