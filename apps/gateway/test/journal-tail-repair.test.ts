/**
 *  崩溃尾部修复(机制 #25)单测:
 * journal 尾部「有 tool.call 无 tool.result / 有 step.start 无 step.end」时,resume 前补合成终态。
 * 覆盖:计划形状与顺序 / time 复用会话末事件 / seq 连续 / 幂等 / 已闭合不动 /
 *       未开始执行不伪造工具结果 / 续跑文案注入 / 跨 session 不混入。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal, type JournalEvent } from "@lampgenie/core";
import {
  planTailRepair,
  applyTailRepair,
  repairTailBeforeResume,
  tailRepairNote,
  TAIL_REPAIR_TOOL_MESSAGE,
} from "../src/journal-tail-repair.js";

const SID = "sess-m25";
const T0 = 1_700_000_000_000;

/** 构造一条会话事件流:turn1 完整闭合 + turn2 崩溃(参数控制崩溃点)。 */
function buildJournal(opts: {
  withToolResult?: boolean;
  withToolCall?: boolean;
  extraSessions?: boolean;
} = {}): MemoryJournal {
  const j = new MemoryJournal();
  const add = (kind: string, payload: Record<string, unknown>, t: number, sessionId = SID) =>
    j.append({ kind: kind as never, sessionId, time: t, payload });
  // turn 1:完整闭合(修复不应碰它)
  add("turn.start", { turn: 1 }, T0);
  add("step.start", { turn: 1, step: 0 }, T0 + 1);
  add("tool.call", { toolCallId: "c-old", name: "read_file", arguments: {}, turn: 1, step: 0 }, T0 + 2);
  add("tool.result", { toolCallId: "c-old", name: "read_file", content: "ok", turn: 1, step: 0, durationMs: 3 }, T0 + 3);
  add("step.end", { turn: 1, step: 0, reason: "tools-done" }, T0 + 4);
  add("turn.end", { turn: 1, reason: "completed" }, T0 + 5);
  // turn 2:崩在工具执行期间
  add("turn.start", { turn: 2 }, T0 + 10);
  add("step.start", { turn: 2, step: 0 }, T0 + 11);
  if (opts.withToolCall !== false) {
    add("tool.call", { toolCallId: "c-crash", name: "write_file", arguments: {}, turn: 2, step: 0 }, T0 + 12);
  }
  if (opts.withToolResult) {
    add("tool.result", { toolCallId: "c-crash", name: "write_file", content: "done", turn: 2, step: 0, durationMs: 5 }, T0 + 13);
  }
  if (opts.extraSessions) {
    // 别的会话的未闭合尾部:不得混入本会话的修复计划
    add("turn.start", { turn: 9 }, T0 + 20, "sess-other");
    add("step.start", { turn: 9, step: 0 }, T0 + 21, "sess-other");
    add("tool.call", { toolCallId: "c-other", name: "exec", arguments: {}, turn: 9, step: 0 }, T0 + 22, "sess-other");
    // 本会话最后一条仍是 T0+12(上面已写)——补一条本会话尾事件定 time 基准时另测
  }
  return j;
}

describe(" planTailRepair:未闭合 turn/step/tool.call", () => {
  it("未闭合三件套 → 1 tool.result + 1 step.end + 1 turn.end,顺序与文案正确", () => {
    const j = buildJournal();
    const events = j.readSession(SID);
    const plan = planTailRepair(events);
    expect(plan.toolResults).toBe(1);
    expect(plan.stepEnds).toBe(1);
    expect(plan.turnEnds).toBe(1);
    expect(plan.events.map((e) => e.kind)).toEqual(["tool.result", "step.end", "turn.end"]);
    const [tr, se, te] = plan.events;
    const p = tr.payload as Record<string, unknown>;
    expect(p.toolCallId).toBe("c-crash");
    expect(p.name).toBe("write_file");
    expect(p.content).toBe(TAIL_REPAIR_TOOL_MESSAGE);
    expect(p.content).toContain("TOOL_OUTCOME_UNKNOWN");
    expect(p.content).toContain("只读/幂等");
    expect(p.synthetic).toBe(true);
    expect(p.repair).toBe("tail-repair");
    expect(p.outcome).toBe("unknown");
    const crashCall = events.find((e) => e.kind === "tool.call" && (e.payload as { toolCallId?: string }).toolCallId === "c-crash")!;
    expect(p.repairOfSeq).toBe(crashCall.seq);
    expect(se.payload).toEqual({ turn: 2, step: 0, reason: "tail-repair", synthetic: true });
    expect(te.payload).toEqual({ turn: 2, reason: "tail-repair", synthetic: true });
    // time 复用会话最后一条事件(不是真实当前时间)
    const lastTime = events[events.length - 1].time;
    for (const e of plan.events) expect(e.time).toBe(lastTime);
    // 幂等键形状
    expect(tr.idempotencyKey).toBe(`tail-repair:${SID}:tool.result:2:c-crash`);
    expect(se.idempotencyKey).toBe(`tail-repair:${SID}:step.end:2:0`);
    expect(te.idempotencyKey).toBe(`tail-repair:${SID}:turn.end:2`);
  });

  it("已有 tool.result 的 call 不重复合成;已闭合 turn 完全不动", () => {
    const j = buildJournal({ withToolResult: true });
    const plan = planTailRepair(j.readSession(SID));
    expect(plan.toolResults).toBe(0);
    expect(plan.events.map((e) => e.kind)).toEqual(["step.end", "turn.end"]);
    // turn 1 已闭合:计划里没有任何 turn:1 的合成事件
    expect(plan.events.some((e) => (e.payload as { turn?: number }).turn === 1)).toBe(false);
  });

  it("未开始执行(无 tool.call)→ 只补 step.end/turn.end,不伪造工具结果", () => {
    const j = buildJournal({ withToolCall: false });
    const plan = planTailRepair(j.readSession(SID));
    expect(plan.toolResults).toBe(0);
    expect(plan.events.map((e) => [e.kind, (e.payload as { reason?: string }).reason])).toEqual([
      ["step.end", "tail-repair"],
      ["turn.end", "tail-repair"],
    ]);
  });

  it("末 turn 已闭合 → 空计划(历史不动)", () => {
    const j = new MemoryJournal();
    j.append({ kind: "turn.start", sessionId: SID, time: T0, payload: { turn: 1 } });
    j.append({ kind: "step.start", sessionId: SID, time: T0 + 1, payload: { turn: 1, step: 0 } });
    j.append({ kind: "step.end", sessionId: SID, time: T0 + 2, payload: { turn: 1, step: 0, reason: "completed" } });
    j.append({ kind: "turn.end", sessionId: SID, time: T0 + 3, payload: { turn: 1, reason: "completed" } });
    const plan = planTailRepair(j.readSession(SID));
    expect(plan.events).toEqual([]);
    expect(plan.toolResults + plan.stepEnds + plan.turnEnds).toBe(0);
  });

  it("非该 session 事件不混入(读别的会话得到的计划只含它自己的 id)", () => {
    const j = buildJournal({ extraSessions: true });
    const other = planTailRepair(j.readSession("sess-other"));
    expect(other.toolResults).toBe(1);
    expect(other.events.every((e) => e.sessionId === "sess-other")).toBe(true);
    expect((other.events[0].payload as { toolCallId?: string }).toolCallId).toBe("c-other");
    // 混合事件里只有一个会话被处理(最后一个 turn.start 的会话),不把两边的缺口拼一起
    const mixed = planTailRepair([...j.readSession(SID), ...j.readSession("sess-other")]);
    expect(new Set(mixed.events.map((e) => e.sessionId)).size).toBe(1);
    // 本会话自己的计划仍只含本会话事件
    const mine = planTailRepair(j.readSession(SID));
    expect(mine.toolResults).toBe(1);
    expect(mine.events.every((e) => e.sessionId === SID)).toBe(true);
  });
});

describe(" applyTailRepair:落账与幂等", () => {
  it("append 后 seq 连续、二次调用全 0", () => {
    const j = buildJournal();
    const before: JournalEvent[] = j.readSession(SID);
    const maxSeq = Math.max(...before.map((e) => e.seq));
    const r1 = applyTailRepair(j, SID);
    expect(r1).toEqual({ toolResults: 1, stepEnds: 1, turnEnds: 1, skipped: false });
    const after = j.readSession(SID);
    const added = after.filter((e) => e.seq > maxSeq);
    expect(added.map((e) => e.kind)).toEqual(["tool.result", "step.end", "turn.end"]);
    // seq 连续(由 journal 分配,不跳号)
    for (let i = 1; i < added.length; i++) expect(added[i].seq).toBe(added[i - 1].seq + 1);
    // 二次调用:尾部已闭合 → 全 0,不再写事件
    const r2 = applyTailRepair(j, SID);
    expect(r2).toEqual({ toolResults: 0, stepEnds: 0, turnEnds: 0, skipped: true });
    expect(j.readSession(SID).length).toBe(after.length);
  });

  it("修复后的会话可被 derive 语义消费:合成 tool.result 带 toolCallId", () => {
    const j = buildJournal();
    applyTailRepair(j, SID);
    const results = j.readSession(SID).filter((e) => e.kind === "tool.result");
    const crash = results.find((e) => (e.payload as { toolCallId?: string }).toolCallId === "c-crash")!;
    expect(crash).toBeDefined();
    expect((crash.payload as { synthetic?: boolean }).synthetic).toBe(true);
  });
});

describe(" 续跑口径:修复计数注入指令", () => {
  it("buildInstruction 文案带修复计数(tailRepairNote)", () => {
    const note = tailRepairNote(2);
    expect(note).toContain("[尾部修复]");
    expect(note).toContain("2 个工具调用未闭合");
    expect(note).toContain("TOOL_OUTCOME_UNKNOWN");
    expect(note).toContain("只读/幂等才可重试");
    // 无工具结果只有结构修复
    expect(tailRepairNote(0, 2)).toContain("2 处未闭合的步骤/turn");
    // 零修复 → 空串(续跑指令逐字不变)
    expect(tailRepairNote(0, 0)).toBe("");
  });

  it("repairTailBeforeResume:有修复时先落账再返回说明;二次调用返回空串", () => {
    const j = buildJournal();
    const note = repairTailBeforeResume(j, SID);
    expect(note).toContain("1 个工具调用未闭合");
    expect(j.readSession(SID).some((e) => e.kind === "turn.end" && (e.payload as { reason?: string }).reason === "tail-repair")).toBe(true);
    expect(repairTailBeforeResume(j, SID)).toBe("");
    // 无 journal / 无 sessionId → 空串(不抛)
    expect(repairTailBeforeResume(undefined, SID)).toBe("");
    expect(repairTailBeforeResume(j, undefined)).toBe("");
  });
});
