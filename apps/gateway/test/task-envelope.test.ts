/**
 * 任务执行信封(来源签发)。
 * 断言面:
 * ① canonical digest/generation(键序/数组序/undefined 无关,能力目录变=代变);
 * ② verifyEnvelope 四态:digest 篡改 / 能力漂移 / 代漂移 / 策略漂移 + 全等 ok;
 * ③ issueEnvelope 来源签发约束(外部来源不得自带客户端摘要);
 * ④ 外部来源无信封→服务端签发并 journal;内部 user→不走信封闸(零变化);
 * ⑤ deliveryKey 重投→duplicate 同 taskId,不同 key→新建;来源自声明 workspace/permissions→拒;
 * ⑥ 开工接线:信封漂移→任务 failed(403)+ journal task.envelope{ok:false,code};无信封→原路径。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TaskSupervisor } from "../src/task-manager.js";
import { verifyTaskEnvelopeAtStart } from "../src/agent-wiring.js";
import {
  EnvelopeError,
  assertSourceDeclaration,
  canonicalJson,
  currentCapabilitySnapshot,
  deliveryIdOf,
  envelopeDigest,
  externalSourceOf,
  findIssuedEnvelope,
  gateExternalSubmit,
  generationOf,
  issueEnvelope,
  resetCapabilitySurface,
  verifyEnvelope,
  type CapabilitySnapshot,
  type EnvelopePolicy,
  type TaskEnvelope,
} from "../src/task-envelope.js";
import type { Task } from "@lampgenie/core";

const SNAP: CapabilitySnapshot = { toolsets: ["code_sense", "terminal"], commands: ["/help", "/model"] };
const POLICY: EnvelopePolicy = { approval: "ask", maxIterations: 3000 };

function issue(over: Partial<Parameters<typeof issueEnvelope>[0]> = {}) {
  return issueEnvelope({
    taskId: "t1",
    source: { kind: "bot", id: "bot-1" },
    capabilitySnapshot: SNAP,
    policy: POLICY,
    issuedAt: 1_700_000_000_000,
    ...over,
  });
}

interface FakeJournal {
  events: { kind?: string; sessionId?: string; payload?: Record<string, unknown> }[];
  append(e: { kind: "custom"; sessionId: string; payload: Record<string, unknown>; idempotencyKey?: string }): { seq: number };
  readSession(sessionId: string): readonly { kind?: string; payload?: unknown }[];
}

function fakeJournal(): FakeJournal {
  const events: FakeJournal["events"] = [];
  return {
    events,
    append(e) {
      events.push(e);
      return { seq: events.length - 1 };
    },
    readSession() {
      return events;
    },
  };
}

function fakeTaskManager(task: Task) {
  let cur: Task = { ...task };
  return {
    get(id: string) {
      return id === cur.id ? cur : undefined;
    },
    setState(t: Task, to: Task["state"], result?: string) {
      cur = { ...t, state: to, result };
      return cur;
    },
    get current() {
      return cur;
    },
  };
}

const BASE_TASK: Task = { id: "t1", sessionId: "s1", instruction: "external job", state: "running", createdAt: 1, updatedAt: 1 };

beforeEach(() => {
  resetCapabilitySurface();
});

describe("canonical digest / generation", () => {
  it("键序、数组序、undefined 不影响摘要;digest=32 位、generation=16 位", () => {
    const a = issueEnvelope({
      taskId: "t1",
      source: { kind: "bot", id: "bot-1" },
      capabilitySnapshot: { toolsets: ["terminal", "code_sense"], commands: ["/model", "/help"] },
      policy: POLICY,
      issuedAt: 1_700_000_000_000,
    }).envelope;
    const b = issue().envelope;
    expect(a.digest).toBe(b.digest);
    expect(a.generation).toBe(b.generation);
    expect(a.digest).toMatch(/^[0-9a-f]{32}$/);
    expect(a.generation).toMatch(/^[0-9a-f]{16}$/);
    expect(a.generation).toBe(generationOf(SNAP));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: ["z", "a"] })).toBe('{"a":["a","z"]}');
  });

  it("能力目录一变,generation 即变(同目录=同代)", () => {
    const base = generationOf(SNAP);
    expect(generationOf({ ...SNAP, toolsets: [...SNAP.toolsets].reverse() })).toBe(base);
    expect(generationOf({ ...SNAP, toolsets: [...SNAP.toolsets, "browser"] })).not.toBe(base);
    expect(generationOf({ ...SNAP, commands: [...SNAP.commands, "/skill"] })).not.toBe(base);
  });
});

describe("verifyEnvelope 四态", () => {
  it("全等 → ok", () => {
    expect(verifyEnvelope(issue().envelope, { capabilitySnapshot: SNAP, policy: POLICY }).ok).toBe(true);
  });

  it("digest 篡改 → ENVELOPE_DIGEST_MISMATCH(带 expected/actual 短摘要)", () => {
    const env = issue().envelope;
    const tampered: TaskEnvelope = { ...env, digest: "0".repeat(32) };
    const r = verifyEnvelope(tampered, { capabilitySnapshot: SNAP, policy: POLICY });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("ENVELOPE_DIGEST_MISMATCH");
    expect(r.expected?.length).toBe(12);
    expect(r.actual).toBe("0".repeat(12));
  });

  it("能力目录变 → ENVELOPE_CAPABILITY_DRIFT", () => {
    const env = issue().envelope;
    const r = verifyEnvelope(env, {
      capabilitySnapshot: { toolsets: [...SNAP.toolsets, "browser"], commands: SNAP.commands },
      policy: POLICY,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("ENVELOPE_CAPABILITY_DRIFT");
    expect(r.expected).toBe(env.generation);
    expect(r.actual).not.toBe(env.generation);
  });

  it("policy 变 → ENVELOPE_POLICY_DRIFT", () => {
    const env = issue().envelope;
    const r = verifyEnvelope(env, { capabilitySnapshot: SNAP, policy: { approval: "auto", maxIterations: POLICY.maxIterations } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("ENVELOPE_POLICY_DRIFT");
    expect(r.expected).toMatch(/^[0-9a-f]{12}$/);
    expect(r.actual).toMatch(/^[0-9a-f]{12}$/);
  });

  it("generation 被改写(摘要重算合法)→ ENVELOPE_GENERATION_DRIFT", () => {
    const env = issue().envelope;
    const body = { ...env, generation: "f".repeat(16) };
    const resigned: TaskEnvelope = { ...body, digest: envelopeDigest(body) };
    const r = verifyEnvelope(resigned, { capabilitySnapshot: SNAP, policy: POLICY });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("ENVELOPE_GENERATION_DRIFT");
    expect(r.expected).toBe("f".repeat(16));
    expect(r.actual).toBe(env.generation);
  });

  it("结构非法 → ENVELOPE_INVALID(fail-closed)", () => {
    const r = verifyEnvelope({ version: 1 } as TaskEnvelope, { capabilitySnapshot: SNAP, policy: POLICY });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("ENVELOPE_INVALID");
  });
});

describe("issueEnvelope 来源签发", () => {
  it("外部来源不得自带客户端摘要/签名", () => {
    expect(() => issue({ clientDigest: "abc" })).toThrow(EnvelopeError);
    expect(() => issue({ clientSigned: true })).toThrow(/服务端签发/);
  });

  it("缺必填/非法 policy → ENVELOPE_INVALID", () => {
    expect(() => issue({ taskId: "" })).toThrow(/taskId/);
    expect(() => issue({ policy: { approval: "ask", maxIterations: 0 } })).toThrow(/maxIterations/);
    expect(() => issue({ source: { kind: "nope" as never, id: "x" } })).toThrow(/source.kind/);
  });

  it("journal 载荷 type=task.envelope.issued 且带完整信封", () => {
    const { envelope, journalPayload } = issue();
    expect(journalPayload.type).toBe("task.envelope.issued");
    expect(journalPayload.taskId).toBe(envelope.taskId);
    expect(journalPayload.envelope).toEqual(envelope);
    expect(findIssuedEnvelope([{ payload: journalPayload }], envelope.taskId).kind).toBe("ok");
  });
});

describe("外部来源提交闸(server task.submit 主体)", () => {
  it("外部来源无信封 → 服务端签发并 journal task.envelope.issued", () => {
    const tm = new TaskSupervisor();
    const journal = fakeJournal();
    const r = gateExternalSubmit(
      { sessionId: "s1", instruction: "外部任务", source: { kind: "bot", id: "bot-1" }, deliveryKey: "d-1" },
      { taskManager: tm, journal, capabilitySnapshot: () => SNAP, policy: () => POLICY, now: () => 42 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.duplicate).toBe(false);
    expect(r.envelope?.taskId).toBe(r.task.id);
    expect(r.envelope?.source).toEqual({ kind: "bot", id: "bot-1" });
    expect(r.envelope?.issuedAt).toBe(42);
    expect(r.envelope?.generation).toBe(generationOf(SNAP));
    const issued = journal.events.filter((e) => e.payload?.type === "task.envelope.issued");
    expect(issued.length).toBe(1);
    expect(findIssuedEnvelope(journal.events, r.task.id).kind).toBe("ok");
    expect(tm.list().length).toBe(1);
  });

  it("内部 user 来源不走信封闸(不签发,零 journal)", () => {
    const tm = new TaskSupervisor();
    const journal = fakeJournal();
    expect(externalSourceOf({ source: { kind: "user", id: "u1" } })).toBeUndefined();
    expect(externalSourceOf({ owner: "human" })).toBeUndefined();
    const r = gateExternalSubmit(
      { sessionId: "s1", instruction: "面板任务", source: { kind: "user", id: "u1" } },
      { taskManager: tm, journal },
    );
    expect(r.ok).toBe(false);
    expect(journal.events.length).toBe(0);
    expect(tm.list().length).toBe(0);
  });

  it("外部来源自声明 workspace / permissions → 拒(fail-closed,不建任务)", () => {
    const tm = new TaskSupervisor();
    const journal = fakeJournal();
    const deps = { taskManager: tm, journal, capabilitySnapshot: () => SNAP, policy: () => POLICY };
    const w = gateExternalSubmit(
      { sessionId: "s1", instruction: "x", source: { kind: "remote", id: "r1" }, declared: { workspace: "/etc" } },
      deps);
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.code).toBe("SOURCE_SELF_DECLARED_WORKSPACE");
    const p = gateExternalSubmit(
      { sessionId: "s1", instruction: "x", source: { kind: "remote", id: "r1" }, declared: { permissions: { sandbox: "full" } } },
      deps);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.code).toBe("SOURCE_SELF_DECLARED_PERMISSION");
    expect(tm.list().length).toBe(0);
    expect(journal.events.length).toBe(0);
    // 内部来源带同名声明=放行(零变化)
    expect(assertSourceDeclaration({ kind: "user", id: "u1" }, { workspace: "/etc" }).ok).toBe(true);
  });

  it("deliveryKey 重投 → duplicate 同 taskId;不同 key → 新建", () => {
    const tm = new TaskSupervisor();
    const journal = fakeJournal();
    const deps = { taskManager: tm, journal, capabilitySnapshot: () => SNAP, policy: () => POLICY };
    const first = gateExternalSubmit({ sessionId: "s1", instruction: "x", source: { kind: "remote", id: "r1" }, deliveryKey: "k1" }, deps);
    const again = gateExternalSubmit({ sessionId: "s1", instruction: "x", source: { kind: "remote", id: "r1" }, deliveryKey: "k1" }, deps);
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.duplicate).toBe(true);
    expect(again.task.id).toBe(first.task.id);
    expect(again.envelope?.taskId).toBe(first.task.id); // 回查 journal 拿回原信封
    expect(deliveryIdOf(first.envelope!)).toBe("env:remote:r1:k1");
    expect(tm.list().length).toBe(1);
    const other = gateExternalSubmit({ sessionId: "s1", instruction: "x", source: { kind: "remote", id: "r1" }, deliveryKey: "k2" }, deps);
    expect(other.ok).toBe(true);
    expect(tm.list().length).toBe(2);
    // 无 deliveryKey → 不做投递幂等(每次新建)
    const noKey1 = gateExternalSubmit({ sessionId: "s1", instruction: "x", source: { kind: "remote", id: "r1" } }, deps);
    const noKey2 = gateExternalSubmit({ sessionId: "s1", instruction: "x", source: { kind: "remote", id: "r1" } }, deps);
    expect(noKey1.ok && noKey2.ok).toBe(true);
    if (!noKey1.ok || !noKey2.ok) return;
    expect(noKey2.task.id).not.toBe(noKey1.task.id);
    expect(deliveryIdOf(noKey1.envelope!)).toBeUndefined();
  });

  it("客户端带信封且有漂移 → 拒(不建任务)", () => {
    const tm = new TaskSupervisor();
    const journal = fakeJournal();
    const env = issue({ taskId: "t-client" }).envelope;
    const r = gateExternalSubmit(
      { sessionId: "s1", instruction: "x", source: { kind: "bot", id: "bot-1" }, envelope: env },
      { taskManager: tm, journal, capabilitySnapshot: () => ({ ...SNAP, toolsets: [...SNAP.toolsets, "browser"] }), policy: () => POLICY },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ENVELOPE_CAPABILITY_DRIFT");
    expect(tm.list().length).toBe(0);
  });
});

describe("开工接线 verifyTaskEnvelopeAtStart", () => {
  it("信封能力漂移 → 任务 failed(403)+ journal task.envelope {ok:false,code}", () => {
    const journal = fakeJournal();
    journal.append({ kind: "custom", sessionId: "s1", payload: { ...issue().journalPayload } });
    const tm = fakeTaskManager(BASE_TASK);
    const r = verifyTaskEnvelopeAtStart({
      journal,
      taskManager: tm,
      task: BASE_TASK,
      current: { capabilitySnapshot: { toolsets: [...SNAP.toolsets, "browser"], commands: SNAP.commands }, policy: POLICY },
    });
    expect(r?.ok).toBe(false);
    expect(r?.code).toBe("ENVELOPE_CAPABILITY_DRIFT");
    expect(tm.current.state).toBe("failed");
    expect(tm.current.result).toContain("403");
    const gate = journal.events.filter((e) => e.payload?.type === "task.envelope");
    expect(gate.length).toBe(1);
    expect(gate[0].payload).toMatchObject({ taskId: "t1", ok: false, code: "ENVELOPE_CAPABILITY_DRIFT" });
  });

  it("策略漂移同样 fail-closed", () => {
    const journal = fakeJournal();
    journal.append({ kind: "custom", sessionId: "s1", payload: { ...issue().journalPayload } });
    const tm = fakeTaskManager(BASE_TASK);
    const r = verifyTaskEnvelopeAtStart({
      journal, taskManager: tm, task: BASE_TASK,
      current: { capabilitySnapshot: SNAP, policy: { approval: "auto", maxIterations: 3000 } },
    });
    expect(r?.ok).toBe(false);
    expect(r?.code).toBe("ENVELOPE_POLICY_DRIFT");
    expect(tm.current.state).toBe("failed");
  });

  it("无信封 → 原路径零变化(不 failed、不写 journal)", () => {
    const journal = fakeJournal();
    const tm = fakeTaskManager(BASE_TASK);
    const r = verifyTaskEnvelopeAtStart({
      journal, taskManager: tm, task: BASE_TASK,
      current: { capabilitySnapshot: SNAP, policy: POLICY },
    });
    expect(r).toBeUndefined();
    expect(tm.current.state).toBe("running");
    expect(journal.events.length).toBe(0);
  });

  it("信封结构非法 → ENVELOPE_INVALID fail-closed", () => {
    const journal = fakeJournal();
    journal.append({ kind: "custom", sessionId: "s1", payload: { type: "task.envelope.issued", taskId: "t1", envelope: { version: 1 } } });
    const tm = fakeTaskManager(BASE_TASK);
    const r = verifyTaskEnvelopeAtStart({ journal, taskManager: tm, task: BASE_TASK, current: { capabilitySnapshot: SNAP, policy: POLICY } });
    expect(r?.ok).toBe(false);
    expect(r?.code).toBe("ENVELOPE_INVALID");
    expect(tm.current.state).toBe("failed");
  });

  it("全等 → ok(任务保持 running)", () => {
    const journal = fakeJournal();
    journal.append({ kind: "custom", sessionId: "s1", payload: { ...issue().journalPayload } });
    const tm = fakeTaskManager(BASE_TASK);
    const r = verifyTaskEnvelopeAtStart({ journal, taskManager: tm, task: BASE_TASK, current: { capabilitySnapshot: SNAP, policy: POLICY } });
    expect(r?.ok).toBe(true);
    expect(tm.current.state).toBe("running");
    expect(journal.events.some((e) => e.payload?.type === "task.envelope" && e.payload.ok === true)).toBe(true);
  });
});

describe("能力目录登记", () => {
  it("未登记=基线;登记后 currentCapabilitySnapshot 跟随", () => {
    const base = currentCapabilitySnapshot();
    expect(base.toolsets).toEqual([]);
    expect(base.commands.length).toBeGreaterThan(0);
    resetCapabilitySurface();
    expect(currentCapabilitySnapshot().commands).toEqual(base.commands);
  });
});
