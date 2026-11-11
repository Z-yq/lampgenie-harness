/**
 *  消息步进边界(turn boundary)——纯逻辑、零 IO、不 throw。
 * 目标:用户输入 / steer / 重试的注入有确定性边界——
 * 1. tool batch 未闭合(有 tool.call 无同 toolCallId 的 tool.result,或有 step.start 无
 * 配对的 step.end)期间禁止插入;
 * 2. turn 未开始时按 initial 规则(首条 user 输入允许;steer/retry 必须先有 turn 上下文);
 * 3. 准入集在 turn 开始冻结(turn.admission.frozen 记 cutoffSeq),本 turn 内不再扩增;
 * 4. 边界不成立时调用方保持排队,并用稳定码(BOUNDARY_CODES)解释原因。
 * 为什么 batch 中间插 user 会截断 tool 配对:provider 协议要求同一轮 assistant(tool_calls)
 * 与其 tool 结果**原样相邻**。若在 tool.call 与 tool.result 之间插入一条 user 消息,历史不再是
 * [assistant(tool_calls) … tool(result)],而是被切成两段——结果会被判「缺失」或错配到别的调用,
 * 轻则 400 整轮失败、重则上下文不可恢复。故批内注入必须排队到下一个完整边界。
 * 纪律:非法入参返回 INVALID(绝不 throw);同输入同输出(确定性);返回对象冻结(不可变)。
 */

/** 边界稳定码(调用方面板/日志只认这五个值,不解析 reason 文本)。 */
export const BOUNDARY_CODES = Object.freeze([
  "OK",
  "TOOL_BATCH_OPEN",
  "TURN_NOT_STARTED",
  "ADMISSION_FROZEN",
  "INVALID",
] as const);

export type BoundaryCode = (typeof BOUNDARY_CODES)[number];

/** 注入类型:user=用户输入(队列泵),steer=中途转向,retry=重试。 */
export type InjectionKind = "user" | "steer" | "retry";

/**
 * 结构化事件的最小读面(与 journal 的 JournalEvent 结构兼容,但不 import 任何模块)。
 * 字段全部可选:null/历史账本/手工构造的测试都能安全读,坏形状一律按「读不到」处理。
 */
export interface BoundaryEvent {
  seq?: number;
  kind?: string;
  sessionId?: string;
  time?: number;
  payload?: unknown;
}

/** 冻结准入快照(turn.admission.frozen 的 payload 形状)。 */
export interface FrozenAdmission {
  sessionId: string;
  turn: number;
  cutoffSeq: number;
  at: number;
}

export interface FreezeAdmissionInput {
  sessionId: string;
  turn: number;
  cutoffSeq: number;
  at: number;
}

/** freezeAdmission 产出的 journal 事件(可直接交给 journal.append,纯构造零 IO)。 */
export interface FrozenAdmissionEvent {
  kind: "custom";
  sessionId: string;
  time: number;
  payload: FrozenAdmission & { type: "turn.admission.frozen" };
}

export interface InjectionVerdictInput {
  events?: unknown;
  sessionId?: unknown;
  kind?: unknown;
  admittedSeq?: unknown;
}

export interface InjectionVerdict {
  ok: boolean;
  code: BoundaryCode;
  reason: string;
}

/** 深冻结:让调用方拿到的是不可变快照(改不了共享状态,也就不存在跨调用污染)。 */
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) freezeDeep(v);
    Object.freeze(value);
  }
  return value;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function payloadOf(ev: BoundaryEvent): Record<string, unknown> {
  const p = ev.payload;
  return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

/** 只保留属于该会话的事件(按入参顺序;坏的条目直接跳过)。 */
function sessionEvents(events: unknown, sessionId: string): BoundaryEvent[] {
  if (!Array.isArray(events) || !sessionId) return [];
  const out: BoundaryEvent[] = [];
  for (const entry of events) {
    if (!entry || typeof entry !== "object") continue;
    const ev = entry as BoundaryEvent;
    if (ev.sessionId !== sessionId) continue;
    out.push(ev);
  }
  return out;
}

/**
 * 只看最后 turn:从最后一个 turn.start 起到账本尾部。
 * 没有 turn.start(首条输入前/旧账本)时整段视为当前(唯一)窗口——保守,不假装更早的
 * 未闭合调用已经结束。
 */
function tailOfLastTurn(events: BoundaryEvent[]): BoundaryEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === "turn.start") return events.slice(i);
  }
  return events;
}

/**
 * 未配对的 toolCallId 集合(只看最后 turn)。
 * 配对规则:同 toolCallId 的 tool.call 与 tool.result 各一处即闭合。
 * 缺 toolCallId 的旧账本无法配对 → 用合成键 `missing-call-<seq>` 保守计入(不冒充真实 id)。
 */
export function openToolCalls(events: unknown, sessionId: string): ReadonlySet<string> {
  const sid = textOf(sessionId);
  const tail = tailOfLastTurn(sessionEvents(events, sid));
  const open = new Set<string>();
  let fallback = 0;
  for (const ev of tail) {
    if (ev.kind !== "tool.call" && ev.kind !== "tool.result") continue;
    const id = textOf(payloadOf(ev).toolCallId);
    if (ev.kind === "tool.call") {
      if (id) open.add(id);
      else open.add(`missing-call-${typeof ev.seq === "number" && ev.seq >= 0 ? ev.seq : fallback++}`);
    } else if (id) {
 // 无 id 的 tool.result 无法配对任何调用(保守:不关闭任何未闭合入口)。
      open.delete(id);
    }
  }
  return open;
}

/**
 * tool batch 是否未闭合:
 * - 有未配对 tool.call → true;
 * - 有未闭合 step.start(无同 (turn, step) 的 step.end)→ true(保守:step 级也算批内);
 * - 空账本 / 全部闭合 → false。
 */
export function isToolBatchOpen(events: unknown, sessionId: string): boolean {
  const sid = textOf(sessionId);
  const all = sessionEvents(events, sid);
  if (openToolCalls(all, sid).size > 0) return true;
  const tail = tailOfLastTurn(all);
  const openSteps = new Set<string>();
  let fallback = 0;
  for (const ev of tail) {
    if (ev.kind !== "step.start" && ev.kind !== "step.end") continue;
    const p = payloadOf(ev);
    const turn = typeof p.turn === "number" && Number.isFinite(p.turn) ? p.turn : undefined;
    const step = typeof p.step === "number" && Number.isFinite(p.step) ? p.step : undefined;
    const key =
      turn !== undefined && step !== undefined
        ? `t${turn}s${step}`
        : `missing-step-${typeof ev.seq === "number" && ev.seq >= 0 ? ev.seq : fallback++}`;
    if (ev.kind === "step.start") openSteps.add(key);
    else openSteps.delete(key);
  }
  return openSteps.size > 0;
}

/**
 * 构造「本轮准入冻结」事件(稳定形状,可直接 append)。
 * 语义:turn 开始时把当前最大 seq 记为 cutoffSeq;此后 admittedSeq > cutoffSeq 的输入
 * 属于「本 turn 已开始时才受理」,本 turn 内不再扩增——排队到下一 turn。
 */
export function freezeAdmission(input: FreezeAdmissionInput): FrozenAdmissionEvent {
  const sessionId = textOf(input?.sessionId);
  const turn = numOf(input?.turn, 0);
  const cutoffSeq = numOf(input?.cutoffSeq, 0);
  const at = numOf(input?.at, 0);
  const payload = freezeDeep({
    type: "turn.admission.frozen" as const,
    sessionId,
    turn,
    cutoffSeq,
    at,
  });
  return freezeDeep({ kind: "custom" as const, sessionId, time: at, payload });
}

/**
 * 读最近的冻结准入(无则 null)。只认 custom 且 payload.type=turn.admission.frozen。
 * 形状坏的字段按 0/空串兜底(诚实降级,不 throw)。
 */
export function readFrozenAdmission(events: unknown, sessionId: string): FrozenAdmission | null {
  const sid = textOf(sessionId);
  const all = sessionEvents(events, sid);
  for (let i = all.length - 1; i >= 0; i--) {
    const ev = all[i]!;
    if (ev.kind !== "custom") continue;
    const p = payloadOf(ev);
    if (p.type !== "turn.admission.frozen") continue;
    return freezeDeep({
      sessionId: textOf(p.sessionId) || sid,
      turn: numOf(p.turn, 0),
      cutoffSeq: numOf(p.cutoffSeq, 0),
      at: numOf(p.at, typeof ev.time === "number" ? ev.time : 0),
    });
  }
  return null;
}

/** 下一 turn 的冻结截止 = 该会话当前最大 seq(无事件 = 0)。 */
export function nextTurnAdmission(events: unknown, sessionId: string): number {
  const sid = textOf(sessionId);
  let max = 0;
  for (const ev of sessionEvents(events, sid)) {
    const seq = typeof ev.seq === "number" && Number.isFinite(ev.seq) ? ev.seq : 0;
    if (seq > max) max = seq;
  }
  return max;
}

function verdict(code: BoundaryCode, reason: string): InjectionVerdict {
  return freezeDeep({ ok: code === "OK", code, reason });
}

/**
 * 注入判定(唯一入口)。判定顺序与规格一致:
 * 1. 账本无 turn.start:user → OK(首条输入);steer/retry → TURN_NOT_STARTED;
 * 2. tool batch 未闭合 → TOOL_BATCH_OPEN(优先于冻结:批内注入必截断配对);
 * 3. 有冻结准入且 admittedSeq > cutoffSeq → ADMISSION_FROZEN(user 同样受冻结,排队即可);
 * 4. 否则 OK。
 * admittedSeq 缺省(旧调用方)不参与冻结比较——没有水位就无从判超界。
 */
export function injectionVerdict(input: InjectionVerdictInput): InjectionVerdict {
  const sessionId = textOf(input?.sessionId);
  if (!sessionId) return verdict("INVALID", "sessionId 缺失或为空");
  const kind = input?.kind;
  if (kind !== "user" && kind !== "steer" && kind !== "retry") {
    return verdict("INVALID", `未知注入类型:${String(kind)}`);
  }
  if (!Array.isArray(input?.events)) return verdict("INVALID", "events 不是数组");

  const all = sessionEvents(input.events, sessionId);
  if (!all.some((ev) => ev.kind === "turn.start")) {
    if (kind === "user") return verdict("OK", "首条输入(账本尚无 turn.start):允许注入");
    return verdict("TURN_NOT_STARTED", `${kind} 注入要求先有 turn 上下文(当前账本无 turn.start)`);
  }

  if (isToolBatchOpen(all, sessionId)) {
    return verdict(
      "TOOL_BATCH_OPEN",
      "tool batch 未闭合(tool.call 无配对 tool.result,或 step.start 无 step.end):此时注入会截断 tool 配对,保持排队",
    );
  }

  const admission = readFrozenAdmission(all, sessionId);
  const admittedSeq =
    typeof input?.admittedSeq === "number" && Number.isFinite(input.admittedSeq)
      ? input.admittedSeq
      : undefined;
  if (admission && admittedSeq !== undefined && admittedSeq > admission.cutoffSeq) {
    return verdict(
      "ADMISSION_FROZEN",
      `输入在 turn ${admission.turn} 开始后受理(admittedSeq ${admittedSeq} > cutoff ${admission.cutoffSeq}):本 turn 准入已冻结,排队到下一 turn`,
    );
  }

  return verdict("OK", "边界成立:可注入");
}
