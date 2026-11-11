/**
 * 时间旅行「只删对话」(session.truncate)对 deriveMessages 的端到端契约:
 * 区间 (boundary, T) 内的**消息类**事件不进上下文,T=截断事件自身 seq;
 * 观测事件(turn.start/step.start/custom)不受影响;无截断事件 = 旧行为逐字不变。
 * 真 MemoryJournal(seq 由 journal 分配,0 起),不 mock——断言一律用 append 返回的 seq,不硬编码。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { deriveMessages } from "../src/agent/loop";

const SID = "trunc-1";

type J = InstanceType<typeof MemoryJournal>;

function user(j: J, text: string, sessionId = SID): number {
  return j.append({ kind: "message.user", sessionId, payload: { text } }).seq;
}

function agent(j: J, text: string, sessionId = SID): number {
  return j.append({ kind: "message.agent", sessionId, payload: { text } }).seq;
}

function truncate(j: J, boundarySeq: number, opts?: { sessionId?: string; key?: string }): number {
  return j.append({
    kind: "custom",
    sessionId: opts?.sessionId ?? SID,
    payload: { type: "session.truncate", boundarySeq, at: 1 },
    ...(opts?.key ? { idempotencyKey: opts.key } : {}),
  }).seq;
}

/** derive 结果的文本序列(user/assistant 消息的 content)。 */
function texts(j: J, sessionId = SID): string[] {
  return deriveMessages(j, sessionId).map((m) => String(m.content));
}

function truncateEvents(j: J): { boundarySeq: number; seq: number }[] {
  return j.readAll()
    .filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "session.truncate")
    .map((e) => ({ boundarySeq: Number((e.payload as { boundarySeq?: number }).boundarySeq), seq: e.seq }));
}

describe("A. 基本截断:boundary 之后的消息被丢弃,T 之后的新消息保留", () => {
  it("前两条 + after,不含 boundary 之后的历史", () => {
    const j = new MemoryJournal();
    user(j, "u1");
    const s2 = agent(j, "a1");
    const s3 = user(j, "u2");
    const s4 = agent(j, "a2");
    const s5 = user(j, "u3");
    const t = truncate(j, s2); // 区间 (a1, T) → 丢 u2/a2/u3
    const s7 = agent(j, "after");
 // 区间右端点 T 必须晚于被丢弃的消息(否则语义不闭合)
    expect([s3, s4, s5].every((s) => s > s2 && s < t)).toBe(true);
    expect(s7).toBeGreaterThan(t);
    expect(texts(j)).toEqual(["u1", "a1", "after"]);
  });

  it("重复 derive 结果一致(幂等读取,不改 journal)", () => {
    const j = new MemoryJournal();
    user(j, "u1");
    const s2 = agent(j, "a1");
    user(j, "u2");
    truncate(j, s2);
    const before = JSON.stringify(j.readAll());
    const first = deriveMessages(j, SID);
    const second = deriveMessages(j, SID);
    expect(first).toEqual(second);
    expect(JSON.stringify(j.readAll())).toBe(before);
    expect(first.map((m) => m.content)).toEqual(["u1", "a1"]);
  });
});

describe("B. 兼容:无 truncate 事件 → 逐字节旧行为", () => {
  it("与「从没出现过 truncate」的 journal 结果深等", () => {
    const withNone = new MemoryJournal();
    const plain = new MemoryJournal();
    for (const j of [withNone, plain]) {
      user(j, "u1");
      agent(j, "a1");
      user(j, "u2");
      agent(j, "a2");
    }
 // 只加与消息无关的 custom 事件(非 session.truncate):同样不改变结果
    withNone.append({ kind: "custom", sessionId: SID, payload: { type: "other.audit", at: 1 } });
    expect(deriveMessages(withNone, SID)).toEqual(deriveMessages(plain, SID));
    expect(texts(plain)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("脏截断事件(boundarySeq=0/负数/NaN/字符串)被忽略,退化为旧行为", () => {
    const j = new MemoryJournal();
    user(j, "u1");
    agent(j, "a1");
    user(j, "u2");
    for (const bad of [0, -1, Number.NaN, "3"]) {
      j.append({ kind: "custom", sessionId: SID, payload: { type: "session.truncate", boundarySeq: bad } });
    }
    expect(texts(j)).toEqual(["u1", "a1", "u2"]);
  });

  it("其它会话的截断事件不影响本会话", () => {
    const j = new MemoryJournal();
    user(j, "u1");
    const s2 = agent(j, "a1");
    user(j, "u2");
    truncate(j, s2, { sessionId: "other" });
    expect(texts(j)).toEqual(["u1", "a1", "u2"]);
  });
});

describe("C. 多条 truncate(不同 boundary):各区间同时生效", () => {
  it("每个区间内的消息都被丢弃,不受「只看最后一条」影响", () => {
    const j = new MemoryJournal();
    user(j, "m1");
    const b1 = user(j, "m2");
    user(j, "m3");
    const b2 = user(j, "m4");
    user(j, "m5");
    const t1 = truncate(j, b1); // 区间 (m2,t1) 丢 m3,m4,m5
    const t2 = truncate(j, b2); // 区间 (m4,t2) 丢 m5
    user(j, "m6"); // 区间外,保留
    expect(truncateEvents(j)).toEqual([{ boundarySeq: b1, seq: t1 }, { boundarySeq: b2, seq: t2 }]);
    expect(texts(j)).toEqual(["m1", "m2", "m6"]);
  });
});

describe("D. 幂等键:重复 append 同一 boundary 只落一条事件,derive 不变", () => {
  it("同 key 两次 append → 一条 custom;结果与只写一次相同", () => {
    const once = new MemoryJournal();
    const twice = new MemoryJournal();
    for (const j of [once, twice]) {
      user(j, "u1");
      const s2 = agent(j, "a1");
      user(j, "u2");
      truncate(j, s2, { key: "truncate:" + SID + ":" + s2 });
    }
    const boundary = truncateEvents(twice)[0]!.boundarySeq;
    truncate(twice, boundary, { key: "truncate:" + SID + ":" + boundary });
    expect(truncateEvents(once)).toHaveLength(1);
    expect(truncateEvents(twice)).toHaveLength(1);
    expect(deriveMessages(twice, SID)).toEqual(deriveMessages(once, SID));
    expect(texts(twice)).toEqual(["u1", "a1"]);
  });
});

describe("E. 观测事件不受影响(turn.start/step.start 仍在 journal,消息照删)", () => {
  it("区间内 message 丢弃,观测事件计数不变", () => {
    const j = new MemoryJournal();
    j.append({ kind: "turn.start", sessionId: SID, payload: { turn: 1 } });
    j.append({ kind: "step.start", sessionId: SID, payload: { turn: 1, step: 1 } });
    const s3 = user(j, "u1");
    agent(j, "a1");
    user(j, "u2");
    truncate(j, s3); // 区间 (u1, T) 丢 a1,u2
    agent(j, "af");
    expect(texts(j)).toEqual(["u1", "af"]);
    const kinds = j.readAll().map((e) => e.kind);
    expect(kinds.filter((k) => k === "turn.start")).toHaveLength(1);
    expect(kinds.filter((k) => k === "step.start")).toHaveLength(1);
 // 观测事件本身没被删除(只是不进消息列表)
    expect(j.readAll().some((e) => (e.payload as { turn?: number }).turn === 1)).toBe(true);
  });
});

describe("F. T 之后的新消息照常保留", () => {
  it("截断后再追加的 user/agent 都进上下文", () => {
    const j = new MemoryJournal();
    user(j, "u1");
    const s2 = agent(j, "a1");
    user(j, "u2");
    truncate(j, s2);
    user(j, "u4");
    agent(j, "a4");
    expect(texts(j)).toEqual(["u1", "a1", "u4", "a4"]);
  });

  it("边界是开区间:boundary 那条消息本身保留", () => {
    const j = new MemoryJournal();
    user(j, "u1");
    const s2 = user(j, "u2");
    truncate(j, s2); // 区间 (u2, T) → 后面没有消息可丢
    expect(texts(j)).toEqual(["u1", "u2"]);
  });
});
