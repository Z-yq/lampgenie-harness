import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { wireExecutor } from "../src/executor-wiring.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import type { SubagentBackend, SubagentEvent, SubagentHandle, TaskSpec } from "@lampgenie/executors";
import type { PermissionBroker } from "../src/permission-broker.js";
import { APPROVAL_AUDIT_CODES, auditApprovals } from "@lampgenie/runtime/agent/approval-audit";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// env 互斥:本文件动 GENIE_PERMISSION_RULES / GENIE_SUBAGENT_ASK / GENIE_REPO_ROOT 三个进程级开关,
// 与其它动 env 的测试文件串行(否则并行文件互相拆 env = 间歇假红)。
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
beforeAll(async () => { await acquireEnvLock("approval-audit-wiring"); }, 240_000);
afterAll(() => { releaseEnvLock("approval-audit-wiring"); });

/** 可编程 fake backend:发一条 permission-ask,记录 respondPermission。 */
class FakeAskBackend implements SubagentBackend {
  readonly kind = "fake-ask";
  responds: { requestId: string; decision: string }[] = [];
  constructor(private readonly requestId = "r1", private readonly extra: Record<string, unknown> = {}) {}
  async spawn(spec: TaskSpec, onEvent: (e: SubagentEvent) => void): Promise<SubagentHandle> {
    onEvent({ type: "ready" });
 // extra 用于验证「事件带 turn/toolCallId 才透传」;不带就是真实 ndjson backend 的形态。
    onEvent({ type: "permission-ask", requestId: this.requestId, summary: "rm -rf /tmp/x", risk: "high", ...this.extra } as SubagentEvent);
    const self = this;
    return {
      taskId: spec.taskId,
      async cancel() {},
      async steer() { return true; },
      async respondPermission(requestId, decision) { self.responds.push({ requestId, decision }); },
    };
  }
}

/** 面板审批中介替身:只记录是否被咨询(never 路径必须零咨询)。 */
function brokerSpy(): { broker: PermissionBroker; calls: unknown[] } {
  const calls: unknown[] = [];
  const broker = {
    ask: async (input: unknown) => {
      calls.push(input);
      return { decision: "allow-once" as const, by: "panel" as const };
    },
  } as unknown as PermissionBroker;
  return { broker, calls };
}

/** 跑一次完整询问回路:submit → 等决策落 journal → 取 permission.gate 事件与审计结果。 */
async function runAsk(opts: { backend?: FakeAskBackend; broker?: PermissionBroker } = {}) {
  const tm = new TaskSupervisor();
  const journal = new MemoryJournal();
  const backend = opts.backend ?? new FakeAskBackend();
  wireExecutor(tm, journal, backend, undefined, undefined, undefined, opts.broker);
  tm.submit("user", "pw", "危险任务");
  await new Promise((r) => setTimeout(r, 400));
  const all = journal.readAll();
  const gates = all.filter((e) => e.kind === "permission.gate").map((e) => e.payload as Record<string, unknown>);
  return { backend, gates, audit: auditApprovals(all) };
}

/** 构造一个临时「仓根」:让 loadRulesHot(repoRoot) 读到指定的 .genie/permissions.json。 */
function makeRepoRoot(permissions: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-approval-audit-"));
  mkdirSync(join(dir, ".genie", "experiences"), { recursive: true });
  mkdirSync(join(dir, "devlog"), { recursive: true });
  writeFileSync(join(dir, ".genie", "permissions.json"), JSON.stringify(permissions));
  return dir;
}

beforeEach(() => {
 // 规则面显式空集 + 关快照:只测审计绑定与 never 短路(与 permission-wiring 同一套隔离口径)。
  process.env.GENIE_PERMISSION_RULES = "[]";
  process.env.GENIE_CHECKPOINT = "off";
});
afterEach(() => {
  delete process.env.GENIE_PERMISSION_RULES;
  delete process.env.GENIE_CHECKPOINT;
  delete process.env.GENIE_SUBAGENT_ASK;
  delete process.env.GENIE_REPO_ROOT;
});

describe("executor 事件绑定 requestId(审计对)", () => {
  it("缺省 auto-fail-closed:asked 与 denied 都带同一 requestId,审计成对 1 对", async () => {
    const { gates, audit, backend } = await runAsk();
    const ask = gates.find((g) => g.effect === "asked");
    const deny = gates.find((g) => g.effect === "denied");
    expect(ask?.requestId).toBe("r1");
    expect(deny?.requestId).toBe("r1");
 // effect 名不变(旧消费方依赖 allowed/denied 字面量)
    expect(deny?.by).toBe("auto-fail-closed");
    expect(audit.ok).toBe(true);
    expect(audit.pairs).toHaveLength(1);
    expect(audit.pairs[0]).toMatchObject({ requestId: "r1", decision: "denied", by: "auto-fail-closed" });
    expect(backend.responds).toEqual([{ requestId: "r1", decision: "reject" }]);
  });

  it("env 放行:allowed 事件同样带 requestId,审计仍成对", async () => {
    process.env.GENIE_SUBAGENT_ASK = "allow-once";
    const { gates, audit } = await runAsk();
    const allow = gates.find((g) => g.effect === "allowed");
    expect(allow?.requestId).toBe("r1");
    expect(audit.pairs[0]).toMatchObject({ requestId: "r1", decision: "allowed", by: "env-allow-once" });
  });

  it("事件不带 turn/toolCallId 时不伪造:payload 里没有这两个键,审计只记 missingBindings", async () => {
    const { gates, audit } = await runAsk();
    for (const g of gates) {
      expect(Object.prototype.hasOwnProperty.call(g, "turn")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(g, "toolCallId")).toBe(false);
    }
    expect(audit.pairs[0]!.missingBindings).toEqual(["turn", "toolCallId"]);
    expect(audit.ok).toBe(true);
  });

  it("事件带 turn/toolCallId 时透传到 asked 与 decided", async () => {
    const { gates, audit } = await runAsk({ backend: new FakeAskBackend("r7", { turn: 3, toolCallId: "call-42" }) });
    const ask = gates.find((g) => g.effect === "asked");
    const deny = gates.find((g) => g.effect === "denied");
    expect(ask).toMatchObject({ requestId: "r7", turn: 3, toolCallId: "call-42" });
    expect(deny).toMatchObject({ requestId: "r7", turn: 3, toolCallId: "call-42" });
    expect(audit.pairs[0]).toMatchObject({ requestId: "r7", turn: 3, toolCallId: "call-42" });
  });

  it("negative:asked 事件丢 requestId(老 journal 形态)时审计必须 MISSING_BINDING,不静默成对", async () => {
    const { gates } = await runAsk();
 // 模拟历史事件:asked/decided 都没有 requestId 字段
    const legacy = gates.map((g) => {
      const { requestId: _drop, ...rest } = g;
      return { kind: "permission.gate", payload: rest };
    });
    const audit = auditApprovals(legacy);
    expect(audit.ok).toBe(false);
    expect(audit.pairs).toHaveLength(0);
    expect(audit.issues.map((i) => i.code)).toEqual([
      APPROVAL_AUDIT_CODES.MISSING_BINDING,
      APPROVAL_AUDIT_CODES.MISSING_BINDING,
    ]);
  });
});

describe("never 规则短路(命中即拒,不问面板)", () => {
  it("permission=never 命中 → denied by rule-never,broker 零咨询,审计成对", async () => {
    const root = makeRepoRoot({ subagent: { "*": "never" } });
    process.env.GENIE_REPO_ROOT = root;
    delete process.env.GENIE_PERMISSION_RULES; // 让 loadRulesHot 读临时仓根的规则文件
    const { broker, calls } = brokerSpy();
    try {
      const { gates, audit, backend } = await runAsk({ broker });
      const deny = gates.find((g) => g.effect === "denied");
      expect(deny).toMatchObject({ effect: "denied", by: "rule-never", requestId: "r1" });
      expect(calls).toEqual([]); // never 短路:从未走面板
      expect(backend.responds).toEqual([{ requestId: "r1", decision: "reject" }]);
      expect(audit.ok).toBe(true);
      expect(audit.pairs[0]).toMatchObject({ decision: "denied", by: "rule-never" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("非 never 规则不被短路:allow 规则仍走 rule-allowed", async () => {
    const root = makeRepoRoot({ subagent: { "*": "allow" } });
    process.env.GENIE_REPO_ROOT = root;
    delete process.env.GENIE_PERMISSION_RULES;
    try {
      const { gates, audit } = await runAsk();
      const allow = gates.find((g) => g.effect === "allowed");
      expect(allow?.by).toBe("rule-allowed:subagent[*]");
      expect(audit.pairs[0]).toMatchObject({ decision: "allowed" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never 只作用于匹配的工具:其它工具的 never 不拦 subagent", async () => {
    const root = makeRepoRoot({ "file.write": { "*": "never" } });
    process.env.GENIE_REPO_ROOT = root;
    delete process.env.GENIE_PERMISSION_RULES;
    const { broker, calls } = brokerSpy();
    try {
      const { gates } = await runAsk({ broker });
      expect(calls).toHaveLength(1); // 未命中 never → 正常进面板
      expect(gates.find((g) => g.effect === "denied")).toBeUndefined();
      expect(gates.find((g) => g.effect === "allowed")?.by).toBe("panel-approved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
