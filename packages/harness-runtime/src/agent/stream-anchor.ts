/**
 * M29 流中断安全锚点恢复(mechanisms「流中断安全锚点恢复」)。
 *
 * 问题:流式请求中途断流时,面板/聚合里已经有半截正文与思考;adapter 重试若把新增量
 * 接在那半截之后,历史自相矛盾,冷恢复也分不清哪个 attempt 该作废。
 * 口径:
 *  - 可重试流错误 → 当前 attempt 标 discarded(附 attemptId),从最近一次**完整 tool batch**
 *    的安全锚点重开;已提交的 tool.result 保留,未提交的 tail 丢弃;
 *  - 冷恢复(deriveMessages)按 discarded 标记剔除被作废的 message.agent;
 *  - 只由可重试流错误触发(4xx 参数/鉴权/policy 与用户取消不触发);
 *  - 每轮重开上限 10;锚点不完整 → 标注 anchor-missing 上抛(不猜)。
 *
 * 本文件全是纯函数/纯写账,不依赖 provider 与 loop,便于单测。
 */
import type { Journal } from "@lampgenie/core";

/** 作废留痕的 custom payload 判别符(journal 检索用 what=stream.attempt.discarded)。 */
export const STREAM_DISCARD_WHAT = "stream.attempt.discarded";
/** 每轮最多从安全锚点重开几次(超过即上抛原错误)。 */
export const STREAM_REOPEN_MAX = 10;

export type AnchorKind = "tool-batch" | "user";

/** 安全锚点:重开时「已提交到哪」的边界。index=输入数组下标,seq=journal seq(消息输入无 seq 时=index)。 */
export interface SafeAnchor {
  index: number;
  seq: number;
  kind: AnchorKind;
  /** false=tool batch 不完整(toolCalls 有调用缺结果),重开必须拒绝(不猜)。 */
  complete: boolean;
  reason?: string;
}

/** findSafeAnchor 的输入归一视图:journal 事件(kind/payload)或 llm Message(role/...)。 */
interface AnchorView {
  role?: string;
  toolCalls?: { id?: string }[];
  toolCallId?: string;
  seq?: number;
}

function viewOf(raw: unknown): AnchorView {
  const r = raw as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== "object") return {};
  // journal 事件形态
  if (typeof r.kind === "string") {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    switch (r.kind) {
      case "message.user":
        return { role: "user", seq: typeof r.seq === "number" ? r.seq : undefined };
      case "message.agent":
        return {
          role: "assistant",
          seq: typeof r.seq === "number" ? r.seq : undefined,
          toolCalls: Array.isArray(p.toolCalls) ? (p.toolCalls as { id?: string }[]) : undefined,
        };
      case "tool.result":
        return { role: "tool", toolCallId: typeof p.toolCallId === "string" ? p.toolCallId : undefined, seq: typeof r.seq === "number" ? r.seq : undefined };
      default:
        return { seq: typeof r.seq === "number" ? r.seq : undefined };
    }
  }
  // Message 形态
  return {
    role: typeof r.role === "string" ? r.role : undefined,
    toolCalls: Array.isArray(r.toolCalls) ? (r.toolCalls as { id?: string }[]) : undefined,
    toolCallId: typeof r.toolCallId === "string" ? r.toolCallId : undefined,
  };
}

/**
 * 返回最近一次「完整 tool batch」的边界;无 tool batch → 最后一个 message.user;两者都无 → null。
 * 完整性判据:最后一个 tool 消息之前的全部 assistant toolCalls(同一 user 边界起)都能找到
 * 对应 tool 结果;有调用缺结果(含「断流在 tool 结果提交前」)→ complete=false。
 */
export function findSafeAnchor(input: readonly unknown[]): SafeAnchor | null {
  const views = input.map(viewOf);
  let lastUser = -1;
  let lastTool = -1;
  for (let i = 0; i < views.length; i++) {
    if (views[i]!.role === "user") lastUser = i;
    else if (views[i]!.role === "tool") lastTool = i;
  }
  const seqOf = (i: number) => views[i]!.seq ?? i;
  if (lastTool >= 0 && lastTool > lastUser) {
    // 同一 user 边界之后:收集全部 toolCalls 与全部 tool 结果
    const calls = new Set<string>();
    const results = new Set<string>();
    for (let i = Math.max(0, lastUser + 1); i <= lastTool; i++) {
      const v = views[i]!;
      if (v.role === "tool" && v.toolCallId) results.add(v.toolCallId);
      if (v.role === "assistant" && v.toolCalls) for (const c of v.toolCalls) if (c?.id) calls.add(c.id);
    }
    const missing = [...calls].filter((id) => !results.has(id));
    if (missing.length > 0) {
      return {
        index: lastTool,
        seq: seqOf(lastTool),
        kind: "tool-batch",
        complete: false,
        reason: `tool-call-without-result:${missing.slice(0, 3).join(",")}`,
      };
    }
    return { index: lastTool, seq: seqOf(lastTool), kind: "tool-batch", complete: true };
  }
  if (lastUser >= 0) return { index: lastUser, seq: seqOf(lastUser), kind: "user", complete: true };
  return null;
}

/** 可重试判据的归一结果(reason 进 stream.attempt.discarded 留痕)。 */
export interface StreamRetryDecision {
  retryable: boolean;
  reason: string;
}

const NETWORK_RE = /ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|other side closed|terminated/i;
const TIMEOUT_RE = /timeout|timed out|MODEL_STREAM_IDLE_TIMEOUT/i;
const PROVIDER_ABORT_RE = /inference engine abort|StreamMidFlightError|provider[^\n]{0,20}abort/i;
const CANCEL_RE = /^(cancelled|canceled)|aborted by user|USER_STOP|USER_CANCELLED|write-barrier/i;

/**
 * 流错误可重试判据:网络断流/5xx/超时/EPIPE/provider 侧 abort → true;
 * 4xx(参数/鉴权/policy)与用户取消 → false;未知 → true 但 reason 记 unknown(留痕可追)。
 * policy 面(policy decision 的 retryable=false/stop=true)优先于文本判据。
 */
export function classifyStreamRetry(err: unknown): StreamRetryDecision {
  if (err && typeof err === "object") {
    const e = err as { retryable?: unknown; stop?: unknown; kind?: unknown };
    if (e.retryable === false || e.stop === true) return { retryable: false, reason: `policy:${String(e.kind ?? "stop")}` };
  }
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (CANCEL_RE.test(msg)) return { retryable: false, reason: "cancelled" };
  // HTTP 状态码:显式 4xx 先判(鉴权/参数/policy 不重开),5xx 可重试。
  const status =
    /\b(?:LLM|HTTP)\s*([45]\d\d)\b/.exec(msg)?.[1] ??
    /\bstatus[:\s]*([45]\d\d)\b/i.exec(msg)?.[1] ??
    /\b([45]\d\d)\b/.exec(msg)?.[1];
  if (status && status.startsWith("4")) return { retryable: false, reason: `http-${status}` };
  if (status && status.startsWith("5")) return { retryable: true, reason: `http-${status}` };
  if (NETWORK_RE.test(msg)) return { retryable: true, reason: "network" };
  if (TIMEOUT_RE.test(msg)) return { retryable: true, reason: "timeout" };
  if (PROVIDER_ABORT_RE.test(msg)) return { retryable: true, reason: "provider-aborted" };
  return { retryable: true, reason: `unknown:${msg.slice(0, 80)}` };
}

export function isRetryableStreamError(err: unknown): boolean {
  return classifyStreamRetry(err).retryable;
}

export interface DiscardInput {
  attemptId: string;
  turn: number;
  step: number;
  anchor: SafeAnchor | null;
  reason: string;
  partialChars: number;
}

/**
 * 落一条作废标记(append custom stream.attempt.discarded);同 attemptId 幂等(重复调用不再追加)。
 * 返回是否真的追加。持久化失败由调用方决定只告警。
 */
export function markDiscard(journal: Journal, sessionId: string, d: DiscardInput): boolean {
  for (const e of journal.readSession(sessionId)) {
    if (e.kind !== "custom") continue;
    const p = e.payload as { what?: unknown; attemptId?: unknown };
    if (p?.what === STREAM_DISCARD_WHAT && p?.attemptId === d.attemptId) return false;
  }
  journal.append({
    kind: "custom",
    sessionId,
    idempotencyKey: `stream.attempt.discarded.${sessionId}.${d.attemptId}`,
    payload: {
      what: STREAM_DISCARD_WHAT,
      attemptId: d.attemptId,
      turn: d.turn,
      step: d.step,
      anchorSeq: d.anchor?.seq ?? 0,
      anchorKind: d.anchor?.kind ?? "missing",
      reason: d.reason,
      partialChars: d.partialChars,
      at: Date.now(),
    },
  });
  return true;
}

/**
 * 冷恢复过滤:被标记 attemptId 的 message.agent 及该 attempt 的 stream 增量事件剔除;
 * 已提交 tool.result 一律保留;无作废标记时逐字节返回原数组(未作废会话零变化)。
 */
export function filterDiscarded<T>(events: readonly T[]): T[] {
  const dead = new Set<string>();
  for (const raw of events) {
    const e = raw as { kind?: string; payload?: unknown };
    if (e?.kind !== "custom") continue;
    const p = e.payload as { what?: unknown; attemptId?: unknown };
    if (p?.what === STREAM_DISCARD_WHAT && typeof p.attemptId === "string") dead.add(p.attemptId);
  }
  if (dead.size === 0) return events as T[];
  return events.filter((raw) => {
    const e = raw as { kind?: string; payload?: unknown };
    const p = e.payload as { what?: unknown; attemptId?: unknown };
    const id = p?.attemptId;
    if (typeof id !== "string" || !dead.has(id)) return true;
    if (e.kind === "message.agent") return false;
    // 流增量类事件(journal 现有实现不落这种事件;保留通用剔除面,防将来落账后冷恢复重复渲染)
    if (e.kind === "custom" && typeof p?.what === "string" && p.what.startsWith("stream.delta")) return false;
    return true;
  });
}
