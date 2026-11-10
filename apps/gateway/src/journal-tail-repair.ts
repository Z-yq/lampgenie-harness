/**
 * 崩溃尾部修复(机制 M25,机制矩阵 #25):
 *
 * 网关在工具执行期间死掉时,journal 里会留下「有 tool.call 无 tool.result」「有 step.start 无
 * step.end / 有 turn.start 无 turn.end」的未闭合尾部。resume 后模型看到历史残缺,可能盲目重试
 * 有副作用的工具(文件已写/命令已执行却以为没做)。
 *
 * 解药:resume **之前**用纯函数扫描尾部,补齐合成终态(append-only,不改历史):
 *  - 未闭合 tool.call → tool.result(TOOL_OUTCOME_UNKNOWN,明确「只读/幂等才可重试」);
 *  - 未闭合 step → step.end(reason=tail-repair);
 *  - 未闭合 turn → turn.end(reason=tail-repair)。
 *
 * 纪律:
 *  - 只动**最后一个未闭合 turn**;其后已有 turn.end 的(已闭合历史)完全不动。
 *  - 事件时间复用该会话最后一条事件的 time(不写真实当前时间,避免「修复发生在崩溃之后」的假时序)。
 *  - seq 由 journal.append 分配(连续);幂等键 tail-repair:<sid>:<kind>:<turn>:<step|toolCallId>
 *    保证重复调用零副作用(二次 apply 全 0)。
 *  - 未开始执行的工具(step.start 后立刻崩溃、无 tool.call)不伪造工具结果——只补 step.end/turn.end。
 */
import type { Journal, JournalEvent, NewEvent } from "@lampgenie/core";

/** 合成工具结果正文(写进 LLM 上下文,决定模型敢不敢重试)。 */
export const TAIL_REPAIR_TOOL_MESSAGE =
  "[中断] 工具结果未知(TOOL_OUTCOME_UNKNOWN):网关在工具执行期间中断,副作用可能已发生;" +
  "只有确认该操作只读/幂等才可重试,否则先核对现场。";

/** 续跑指令里的修复说明;无修复 → 空串。 */
export function tailRepairNote(toolResults: number, structural = 0): string {
  if (toolResults > 0) {
    return `[尾部修复] 上次会话有 ${toolResults} 个工具调用未闭合,结果已合成标记 TOOL_OUTCOME_UNKNOWN;` +
      "只读/幂等才可重试,有副作用的先核对现场。\n\n";
  }
  if (structural > 0) {
    return `[尾部修复] 上次会话有 ${structural} 处未闭合的步骤/turn,已补合成终态(synthetic);` +
      "续跑请以工作区现状为准,不要凭历史残缺推断。\n\n";
  }
  return "";
}

export interface TailRepairCounts {
  toolResults: number;
  stepEnds: number;
  turnEnds: number;
}

export interface TailRepairPlan extends TailRepairCounts {
  /** 合成事件(按 append 顺序),不含 seq——由 journal 分配。 */
  events: NewEvent[];
}

export type TailRepairResult = TailRepairCounts & {
  /** true = 本次没有可修的东西(已闭合 / 无未闭合 turn / 已修过)。 */
  skipped: boolean;
};

function emptyPlan(): TailRepairPlan {
  return { events: [], toolResults: 0, stepEnds: 0, turnEnds: 0 };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function payloadOf(e: JournalEvent): Record<string, unknown> {
  return (e.payload ?? {}) as Record<string, unknown>;
}

interface OpenStep {
  turn: number;
  step: number;
  closed: boolean;
  calls: { seq: number; toolCallId: string; name: string }[];
}

/**
 * 纯函数:给出需要补的合成终态。无未闭合尾部 → 空计划(events=[] 且计数全 0)。
 *
 * 只认**最后一个 turn.start** 之后的尾部;其它会话的事件不混入。
 */
export function planTailRepair(input: JournalEvent[]): TailRepairPlan {
  if (!Array.isArray(input) || input.length === 0) return emptyPlan();

  // ① 最后一个 turn.start(其后的 turn.end 决定是否已闭合)
  let lastTurnStart = -1;
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i]?.kind === "turn.start") { lastTurnStart = i; break; }
  }
  if (lastTurnStart < 0) return emptyPlan();
  const anchor = input[lastTurnStart];
  if (!anchor) return emptyPlan();
  const sessionId = anchor.sessionId;
  // 跨会话事件不混入(apply 走 readSession,这里对直接传全量事件也做同款过滤)
  const events = input.filter((e) => e.sessionId === sessionId);
  const turnStartIdx = events.findIndex((e) => e.seq === anchor.seq && e.kind === "turn.start");
  const turnStartEvent = events[turnStartIdx];
  if (!turnStartEvent) return emptyPlan();
  const turn = num(payloadOf(turnStartEvent).turn);
  const tail = events.slice(turnStartIdx + 1);
  // ② 该 turn 已有 turn.end → 已闭合历史,完全不动
  if (tail.some((e) => e.kind === "turn.end" && num(payloadOf(e).turn) === turn)) return emptyPlan();

  // ③ 全局已落账的 tool.result(按 toolCallId)
  const answered = new Set<string>();
  for (const e of events) {
    if (e.kind !== "tool.result") continue;
    const id = payloadOf(e).toolCallId;
    if (typeof id === "string" && id) answered.add(id);
  }

  // ④ 扫尾部:按序配对 step.start/step.end,tool.call 挂到当时打开的 step 上
  const steps: OpenStep[] = [];
  let open: OpenStep | undefined;
  for (const e of tail) {
    const p = payloadOf(e);
    if (e.kind === "step.start") {
      open = { turn: num(p.turn), step: num(p.step), closed: false, calls: [] };
      steps.push(open);
      continue;
    }
    if (e.kind === "step.end") {
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        if (!s || s.closed) continue;
        if (s.turn === num(p.turn) && s.step === num(p.step)) {
          s.closed = true;
          if (open === s) open = undefined;
          break;
        }
      }
      continue;
    }
    if (e.kind === "tool.call") {
      const id = p.toolCallId;
      if (open && !open.closed && typeof id === "string" && id) {
        open.calls.push({ seq: e.seq, toolCallId: id, name: String(p.name ?? "") });
      }
    }
  }
  const openSteps = steps.filter((s) => !s.closed).sort((a, b) => a.step - b.step);
  if (openSteps.length === 0) return emptyPlan();

  // ⑤ 合成事件:time 复用会话最后一条事件(不写真实当前时间)
  const lastEvent = events[events.length - 1];
  if (!lastEvent) return emptyPlan();
  const lastTime = lastEvent.time;
  const plan = emptyPlan();
  const planned = new Set<string>();
  for (const s of openSteps) {
    for (const c of [...s.calls].sort((a, b) => a.seq - b.seq)) {
      if (answered.has(c.toolCallId) || planned.has(c.toolCallId)) continue;
      planned.add(c.toolCallId);
      plan.events.push({
        kind: "tool.result",
        sessionId,
        time: lastTime,
        idempotencyKey: `tail-repair:${sessionId}:tool.result:${s.turn}:${c.toolCallId}`,
        payload: {
          toolCallId: c.toolCallId,
          name: c.name,
          content: TAIL_REPAIR_TOOL_MESSAGE,
          turn: s.turn,
          step: s.step,
          durationMs: 0,
          synthetic: true,
          repair: "tail-repair",
          outcome: "unknown",
          repairOfSeq: c.seq,
        },
      });
      plan.toolResults++;
    }
    plan.events.push({
      kind: "step.end",
      sessionId,
      time: lastTime,
      idempotencyKey: `tail-repair:${sessionId}:step.end:${s.turn}:${s.step}`,
      payload: { turn: s.turn, step: s.step, reason: "tail-repair", synthetic: true },
    });
    plan.stepEnds++;
  }
  plan.events.push({
    kind: "turn.end",
    sessionId,
    time: lastTime,
    idempotencyKey: `tail-repair:${sessionId}:turn.end:${turn}`,
    payload: { turn, reason: "tail-repair", synthetic: true },
  });
  plan.turnEnds++;
  return plan;
}

/**
 * 落账:readSession → plan → append(带 time/idempotencyKey)。
 * 幂等:修过之后尾部已闭合,二次调用计划为空,返回计数全 0(事件也不会重复写)。
 */
export function applyTailRepair(journal: Journal, sessionId: string): TailRepairResult {
  if (!sessionId) return { toolResults: 0, stepEnds: 0, turnEnds: 0, skipped: true };
  const plan = planTailRepair(journal.readSession(sessionId));
  if (plan.events.length === 0) return { toolResults: 0, stepEnds: 0, turnEnds: 0, skipped: true };
  for (const ev of plan.events) journal.append(ev);
  return { toolResults: plan.toolResults, stepEnds: plan.stepEnds, turnEnds: plan.turnEnds, skipped: false };
}

/**
 * 三处 resume 共用的接线段:先修尾,再返回可拼进续跑指令的说明(无修复 → 空串)。
 * 修复事件在调用方 submit 续跑任务之前落账。
 * 失败不阻断续跑(尽力而为:下次 resume 再修)。
 */
export function repairTailBeforeResume(journal: Journal | undefined, sessionId: string | undefined): string {
  if (!journal || !sessionId) return "";
  let r: TailRepairResult;
  try {
    r = applyTailRepair(journal, sessionId);
  } catch {
    return "";
  }
  if (r.skipped) return "";
  return tailRepairNote(r.toolResults, r.stepEnds + r.turnEnds);
}
