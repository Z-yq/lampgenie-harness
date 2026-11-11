/**
 * 按龄零模型微压缩测试:纯逻辑层(shoudIdleCompact / groupMessages / ageMicrocompact)。
 * 覆盖:idle 边界(=idleMs)、未来/非法时间、tool 链不拆、system 保留、最后 user 保留、
 * keepRecentGroups、256 回滚、不可变、确定性、空消息、脏元素。
 */
import { describe, expect, it } from "vitest";
import {
  AGE_CODES,
  AGE_DEFAULTS,
  AGE_MIN_SAVINGS_TOKENS,
  ageMicrocompact,
  groupMessages,
  shouldIdleCompact,
} from "../src/agent/microcompact-age";
import type { Message } from "../src/agent/loop";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

/** 给消息挂 journal 派生时间旁注(Message 类型无 time 字段,压缩侧按可选旁注读)。 */
function at(m: Message, time?: number): Message {
  return time === undefined ? m : ({ ...m, time } as Message);
}

/** 一组:user → assistant(toolCalls) → tool(结果),每条 ~250 字,链完整。 */
function groupAt(i: number, time?: number, chars = 60): Message[] {
  const pad = "测试内容".repeat(chars);
  const id = `call-${i}`;
  return [
    at({ role: "user", content: `第${i}轮问题 ${pad}` }, time),
    at({ role: "assistant", content: `第${i}轮回答 ${pad}`, toolCalls: [{ id, name: "read_file", arguments: `{"path":"f${i}.ts"}` }] }, time),
    at({ role: "tool", toolCallId: id, content: `第${i}轮结果 ${pad}` }, time),
  ];
}

function history(n: number, opts?: { time?: number; chars?: number }): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) out.push(...groupAt(i, opts?.time, opts?.chars));
  return out;
}

/** 极简三件套(用于「收益不足 256」的回滚用例)。 */
function tinyGroup(i: number): Message[] {
  return [
    { role: "user", content: `u${i}` },
    { role: "assistant", content: `a${i}`, toolCalls: [{ id: `c${i}`, name: "t", arguments: "{}" }] },
    { role: "tool", toolCallId: `c${i}`, content: `r${i}` },
  ];
}

/** 断言:不存在孤儿 tool 结果,也不存在缺结果的 toolCall(=链没被拆)。 */
function expectToolChainsIntact(messages: readonly Message[]): void {
  const calls = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) for (const c of m.toolCalls) calls.add(c.id);
  }
  const results = new Set<string>();
  for (const m of messages) if (m.role === "tool") results.add(m.toolCallId);
  expect([...results].filter((id) => !calls.has(id))).toEqual([]);
  expect([...calls].filter((id) => !results.has(id))).toEqual([]);
}

const idleOpts = { idleMs: 5 * MIN, now: NOW };

describe("shouldIdleCompact", () => {
  it("边界:now - lastEventAt 恰好 = idleMs → 算闲置", () => {
    expect(shouldIdleCompact({ now: NOW, lastEventAt: NOW - 5 * MIN, idleMs: 5 * MIN })).toBe(true);
  });

  it("差 1ms 不足阈值 → 不算闲置", () => {
    expect(shouldIdleCompact({ now: NOW, lastEventAt: NOW - 5 * MIN + 1, idleMs: 5 * MIN })).toBe(false);
  });

  it("lastEventAt 在未来 → false(时钟异常不触发压缩)", () => {
    expect(shouldIdleCompact({ now: NOW, lastEventAt: NOW + 1000, idleMs: 5 * MIN })).toBe(false);
  });

  it("lastEventAt 非有限值/缺失 → false", () => {
    expect(shouldIdleCompact({ now: NOW, lastEventAt: Number.NaN, idleMs: 5 * MIN })).toBe(false);
    expect(shouldIdleCompact({ now: NOW, idleMs: 5 * MIN })).toBe(false);
  });

  it("now 非有限值 → false", () => {
    expect(shouldIdleCompact({ now: Number.POSITIVE_INFINITY, lastEventAt: NOW - MIN, idleMs: 5 * MIN })).toBe(false);
  });

  it("idleMs <= 0 → false(不把非法配置当「立刻闲置」)", () => {
    expect(shouldIdleCompact({ now: NOW, lastEventAt: NOW - MIN, idleMs: 0 })).toBe(false);
  });

  it("缺省 idleMs = AGE_DEFAULTS.idleMs", () => {
    expect(shouldIdleCompact({ now: NOW, lastEventAt: NOW - AGE_DEFAULTS.idleMs })).toBe(true);
    expect(shouldIdleCompact({ now: NOW, lastEventAt: NOW - AGE_DEFAULTS.idleMs + 1 })).toBe(false);
  });
});

describe("groupMessages", () => {
  it("头部 system 单独保留,按 user 分组", () => {
    const msgs: Message[] = [{ role: "system", content: "S0" }, ...history(3)];
    const g = groupMessages(msgs);
    expect(g.system.map((m) => m.content)).toEqual(["S0"]);
    expect(g.groups.length).toBe(3);
    expect(g.groups.every((x) => x.messages[0]!.role === "user")).toBe(true);
  });

  it("12 组的 assistant.toolCalls 与 tool 结果同组", () => {
    const g = groupMessages(history(12));
    expect(g.groups.length).toBe(12);
    for (const grp of g.groups) {
      expect(grp.messages.length).toBe(3);
      expectToolChainsIntact(grp.messages);
    }
  });

  it("中段 system 变成 pinned 组,顺序不变", () => {
    const msgs: Message[] = [
      { role: "system", content: "S0" },
      ...groupAt(0),
      { role: "system", content: "S1" },
      ...groupAt(1),
      ...groupAt(2),
      ...groupAt(3),
    ];
    const g = groupMessages(msgs);
    expect(g.system.map((m) => m.content)).toEqual(["S0"]);
    expect(g.groups.length).toBe(5); // g0 + pinned S1 + g1 + g2 + g3
    const pinned = g.groups.filter((x) => x.pinned);
    expect(pinned.length).toBe(1);
    expect(pinned[0]!.messages.map((m) => m.content)).toEqual(["S1"]);
 // 重建顺序 = 原顺序
    expect([...g.system, ...g.groups.flatMap((x) => x.messages)]).toEqual(msgs);
  });

  it("system 落在「toolCalls 未回填」的组里 → 并入该组,不拆链", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "a", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] },
      { role: "system", content: "Smid" },
      { role: "tool", toolCallId: "c1", content: "r" },
    ];
    const g = groupMessages(msgs);
    expect(g.system).toEqual([]);
    expect(g.groups.length).toBe(1);
    expect(g.groups[0]!.pinned).toBe(false);
    expect(g.groups[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "system", "tool"]);
    expectToolChainsIntact(g.groups[0]!.messages);
  });

  it("首个 user 之前的孤儿 assistant/tool 进 pinned 组", () => {
    const msgs: Message[] = [
      { role: "assistant", content: "orphan", toolCalls: [{ id: "c0", name: "t", arguments: "{}" }] },
      { role: "tool", toolCallId: "c0", content: "r0" },
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ];
    const g = groupMessages(msgs);
    expect(g.groups.length).toBe(2);
    expect(g.groups[0]!.pinned).toBe(true);
    expect(g.groups[0]!.messages.length).toBe(2);
    expect(g.groups[1]!.pinned).toBe(false);
  });

  it("脏元素(null/数字)跳过而不 throw,空数组 → 无组", () => {
    const g = groupMessages([null, 42, { role: "user", content: "q" }] as unknown as Message[]);
    expect(g.groups.length).toBe(1);
    expect(g.system).toEqual([]);
    expect(groupMessages([])).toEqual({ system: [], groups: [] });
  });
});

describe("ageMicrocompact 判定", () => {
  it("未闲置 → SKIPPED_NOT_IDLE 且原样(同一引用)", () => {
    const msgs = history(12);
    const r = ageMicrocompact(msgs, { now: NOW, lastEventAt: NOW - MIN, idleMs: 5 * MIN, maxAgeMs: MIN, keepRecentGroups: 3 });
    expect(r.code).toBe(AGE_CODES.SKIPPED_NOT_IDLE);
    expect(r.messages).toBe(msgs);
    expect(r.prunedGroups).toBe(0);
  });

  it("闲置够久但组未超龄 → SKIPPED_NOT_OLD 且原样", () => {
    const msgs = history(12);
    const r = ageMicrocompact(msgs, { now: NOW, lastEventAt: NOW - 10 * MIN, idleMs: 5 * MIN, maxAgeMs: 60 * MIN, keepRecentGroups: 3 });
    expect(r.code).toBe(AGE_CODES.SKIPPED_NOT_OLD);
    expect(r.messages).toBe(msgs);
  });

  it("lastEventAt 在未来 → 不判闲置(SKIPPED_NOT_IDLE)", () => {
    const msgs = history(4);
    const r = ageMicrocompact(msgs, { now: NOW, lastEventAt: NOW + MIN, idleMs: MIN, maxAgeMs: 0, keepRecentGroups: 1 });
    expect(r.code).toBe(AGE_CODES.SKIPPED_NOT_IDLE);
    expect(r.messages).toBe(msgs);
  });

  it("now 非法 → INVALID 且原样", () => {
    const msgs = history(4);
    const r = ageMicrocompact(msgs, { now: Number.NaN, lastEventAt: NOW - MIN });
    expect(r.code).toBe(AGE_CODES.INVALID);
    expect(r.messages).toBe(msgs);
    expect(r.notes).toContain("time-invalid");
  });

  it("lastEventAt 缺失 → INVALID 且原样", () => {
    const msgs = history(4);
    const r = ageMicrocompact(msgs, { now: NOW });
    expect(r.code).toBe(AGE_CODES.INVALID);
    expect(r.messages).toBe(msgs);
  });

  it("idleMs <= 0 → INVALID", () => {
    const r = ageMicrocompact(history(2), { now: NOW, lastEventAt: NOW - MIN, idleMs: 0 });
    expect(r.code).toBe(AGE_CODES.INVALID);
    expect(r.notes).toContain("idle-ms-invalid");
  });

  it("maxAgeMs / keepRecentGroups / minSavingsTokens 为负 → INVALID", () => {
    const base = { now: NOW, lastEventAt: NOW - 10 * MIN, idleMs: MIN };
    expect(ageMicrocompact(history(2), { ...base, maxAgeMs: -1 }).code).toBe(AGE_CODES.INVALID);
    expect(ageMicrocompact(history(2), { ...base, keepRecentGroups: -1 }).code).toBe(AGE_CODES.INVALID);
    expect(ageMicrocompact(history(2), { ...base, minSavingsTokens: -1 }).code).toBe(AGE_CODES.INVALID);
  });

  it("空消息 → SKIPPED_NOT_OLD,不 throw", () => {
    const r = ageMicrocompact([], { ...idleOpts, lastEventAt: NOW - 10 * MIN, maxAgeMs: MIN });
    expect(r.code).toBe(AGE_CODES.SKIPPED_NOT_OLD);
    expect(r.messages).toEqual([]);
  });

  it("非数组入参 → INVALID,不 throw", () => {
    const r = ageMicrocompact(null as unknown as Message[], { ...idleOpts, lastEventAt: NOW - 10 * MIN });
    expect(r.code).toBe(AGE_CODES.INVALID);
    expect(r.messages).toEqual([]);
  });
});

describe("ageMicrocompact 裁剪", () => {
  it("12 组 + 闲置 + 超龄 + keepRecentGroups=3 → 丢最老 9 组,链完整", () => {
    const msgs = history(12);
    const r = ageMicrocompact(msgs, { now: NOW, lastEventAt: NOW - 10 * MIN, idleMs: 5 * MIN, maxAgeMs: 5 * MIN, keepRecentGroups: 3 });
    expect(r.code).toBe(AGE_CODES.OK);
    expect(r.prunedGroups).toBe(9);
    expect(r.prunedMessages).toBe(27);
    expect(r.messages.length).toBe(9);
    expect(r.savingsTokens).toBeGreaterThanOrEqual(AGE_MIN_SAVINGS_TOKENS);
    expect(r.beforeTokens! - r.afterTokens!).toBe(r.savingsTokens);
    expectToolChainsIntact(r.messages);
 // 保留的是最近三组(第 9/10/11 轮)
    expect((r.messages[0] as { content: string }).content).toContain("第9轮");
    expect((r.messages[8] as { content: string }).content).toContain("第11轮");
  });

  it("keepRecentGroups=0 按 1 处理:最后一条 user 永不丢", () => {
    const msgs = history(5);
    const r = ageMicrocompact(msgs, { now: NOW, lastEventAt: NOW - 10 * MIN, idleMs: 5 * MIN, maxAgeMs: 5 * MIN, keepRecentGroups: 0 });
    expect(r.code).toBe(AGE_CODES.OK);
    expect(r.prunedGroups).toBe(4);
    expect(r.messages.length).toBe(3);
    expect(r.messages.some((m) => m.role === "user" && m.content.includes("第4轮"))).toBe(true);
  });

  it("keepRecentGroups ≥ 组数 → 无候选,SKIPPED_NOT_OLD", () => {
    const msgs = history(3);
    const r = ageMicrocompact(msgs, { now: NOW, lastEventAt: NOW - 10 * MIN, idleMs: 5 * MIN, maxAgeMs: 5 * MIN, keepRecentGroups: 3 });
    expect(r.code).toBe(AGE_CODES.SKIPPED_NOT_OLD);
    expect(r.messages).toBe(msgs);
  });

  it("头部 system 永不丢(裁剪后仍在首位)", () => {
    const msgs: Message[] = [{ role: "system", content: "S0" }, ...history(6)];
    const r = ageMicrocompact(msgs, { now: NOW, lastEventAt: NOW - 10 * MIN, idleMs: 5 * MIN, maxAgeMs: 5 * MIN, keepRecentGroups: 2 });
    expect(r.code).toBe(AGE_CODES.OK);
    expect(r.messages[0]).toEqual({ role: "system", content: "S0" });
  });

  it("中段 system(pinned 组)永不丢,且不因裁剪错位", () => {
    const msgs: Message[] = [
      { role: "system", content: "S0" },
      ...groupAt(0),
      { role: "system", content: "S1" },
      ...groupAt(1),
      ...groupAt(2),
      ...groupAt(3),
    ];
    const r = ageMicrocompact(msgs, { now: NOW, lastEventAt: NOW - 10 * MIN, idleMs: 5 * MIN, maxAgeMs: 5 * MIN, keepRecentGroups: 2 });
    expect(r.code).toBe(AGE_CODES.OK);
    expect(r.prunedGroups).toBe(2); // g0 + g1( pinned S1 与最近 2 组不动)
    expect(r.messages.map((m) => m.content)).toContain("S1");
    expectToolChainsIntact(r.messages);
  });

  it("收益 < 256 token → ROLLED_BACK 且消息原样(同一引用)", () => {
    const msgs: Message[] = [...tinyGroup(0), ...tinyGroup(1), ...tinyGroup(2), ...tinyGroup(3)];
    const r = ageMicrocompact(msgs, { now: NOW, lastEventAt: NOW - 10 * MIN, idleMs: 5 * MIN, maxAgeMs: 5 * MIN, keepRecentGroups: 3 });
    expect(r.code).toBe(AGE_CODES.ROLLED_BACK);
    expect(r.messages).toBe(msgs);
    expect(r.prunedGroups).toBe(0);
    expect(r.savingsTokens).toBeLessThan(AGE_MIN_SAVINGS_TOKENS);
  });

  it("256 边界:收益 = minSavingsTokens → OK;多 1 token → ROLLED_BACK", () => {
    const msgs = history(12);
    const base = { now: NOW, lastEventAt: NOW - 10 * MIN, idleMs: 5 * MIN, maxAgeMs: 5 * MIN, keepRecentGroups: 3 };
    const probe = ageMicrocompact(msgs, { ...base, minSavingsTokens: 0 });
    expect(probe.code).toBe(AGE_CODES.OK);
    const exact = ageMicrocompact(msgs, { ...base, minSavingsTokens: probe.savingsTokens });
    expect(exact.code).toBe(AGE_CODES.OK);
    const above = ageMicrocompact(msgs, { ...base, minSavingsTokens: probe.savingsTokens + 1 });
    expect(above.code).toBe(AGE_CODES.ROLLED_BACK);
    expect(above.messages).toBe(msgs);
  });

  it("不可变:OK 前后入参内容逐字不变,返回新数组", () => {
    const msgs = history(6);
    const snapshot = JSON.stringify(msgs);
    const r = ageMicrocompact(msgs, { now: NOW, lastEventAt: NOW - 10 * MIN, idleMs: 5 * MIN, maxAgeMs: 5 * MIN, keepRecentGroups: 2 });
    expect(r.code).toBe(AGE_CODES.OK);
    expect(JSON.stringify(msgs)).toBe(snapshot);
    expect(r.messages).not.toBe(msgs);
  });

  it("确定性:同入参两次调用结果深等", () => {
    const msgs = history(8);
    const opts = { now: NOW, lastEventAt: NOW - 10 * MIN, idleMs: 5 * MIN, maxAgeMs: 5 * MIN, keepRecentGroups: 3 };
    const a = ageMicrocompact(msgs, opts);
    const b = ageMicrocompact(msgs, opts);
    expect(a).toEqual(b);
    expect(a.code).toBe(AGE_CODES.OK);
  });

  it("组龄按组内最后消息时间(lastMessageTime)判定,比 lastEventAt 下界更准", () => {
    const old = groupAt(0, NOW - 2 * 60 * MIN); // 2 小时前
    const fresh = [...groupAt(1, NOW - 1000), ...groupAt(2, NOW - 1000), ...groupAt(3, NOW - 1000)];
    const msgs: Message[] = [...old, ...fresh];
    const base = { now: NOW, lastEventAt: NOW - 10_000, idleMs: 5000, maxAgeMs: MIN, keepRecentGroups: 3 };
 // 不带时间旁注:只知「最后事件在 10s 前」→ 下界不足 maxAgeMs → 不裁
    const noTime = ageMicrocompact([...groupAt(0), ...groupAt(1), ...groupAt(2), ...groupAt(3)], base);
    expect(noTime.code).toBe(AGE_CODES.SKIPPED_NOT_OLD);
 // 带时间旁注:第 0 组组龄 2h → 超龄,按龄丢掉
    const withTime = ageMicrocompact(msgs, { ...base, groupAgeBy: "lastMessageTime" });
    expect(withTime.code).toBe(AGE_CODES.OK);
    expect(withTime.prunedGroups).toBe(1);
    expect((withTime.messages[0] as { content: string }).content).toContain("第1轮");
  });

  it("组内时间在未来 → 保守不裁(回落 lastEventAt 下界)", () => {
    const msgs: Message[] = [...groupAt(0, NOW + 60 * MIN), ...groupAt(1, NOW + 60 * MIN), ...groupAt(2), ...groupAt(3)];
    const r = ageMicrocompact(msgs, { now: NOW, lastEventAt: NOW - 10_000, idleMs: 5000, maxAgeMs: MIN, keepRecentGroups: 3 });
    expect(r.code).toBe(AGE_CODES.SKIPPED_NOT_OLD);
  });

  it("脏消息混入不 throw,且不影响判定", () => {
    const msgs = [null, ...history(4)] as unknown as Message[];
    const r = ageMicrocompact(msgs, { now: NOW, lastEventAt: NOW - 10 * MIN, idleMs: 5 * MIN, maxAgeMs: 5 * MIN, keepRecentGroups: 1 });
    expect(r.code).toBe(AGE_CODES.OK);
    expectToolChainsIntact(r.messages);
  });
});

describe("常量契约", () => {
  it("AGE_MIN_SAVINGS_TOKENS = 256", () => {
    expect(AGE_MIN_SAVINGS_TOKENS).toBe(256);
  });

  it("AGE_CODES 覆盖五个判定码", () => {
    expect(Object.keys(AGE_CODES).sort()).toEqual(["INVALID", "OK", "ROLLED_BACK", "SKIPPED_NOT_IDLE", "SKIPPED_NOT_OLD"]);
    expect(AGE_CODES.OK).toBe("OK");
  });
});
