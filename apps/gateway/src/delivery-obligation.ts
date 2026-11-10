/**
 * M112 网关终态投递义务(delivery obligation)。
 *
 * 问题:任务终态(turn 完成/回复已生成)的帧在发送途中进程死掉或客户端 ACK 丢,
 * 面板永久看不到终态;重启无条件重发又会重复显示。
 *
 * 本模块只负责「义务的状态与持久化」这一层,传输仍在 server.ts:
 *   pending → attempting → delivered / failed
 * 约束:
 * - obligationId = `${taskId}:terminal`,register 幂等(同 id 不新增 journal 事件);
 * - 只对已连接 adapter claim(server 侧判 wss 有 OPEN 连接才 beginAttempt);
 * - attempts ≤ 3 且首投起 ≤ 24h,超限自动 failed;
 * - attempting 重发(attempts>1)的帧带 mayBeDuplicate,下游可去重展示;
 * - 租约:attempting 超过 claimTtlMs 未落 delivered(进程崩/发送挂住)→ sweep 回 pending 待重投。
 *
 * 分片投递(partial)不适用本仓:网关终态帧是单帧广播,没有分片重组语义,
 * 因此不存在「分片部分成功时不得整体重发」的路径;若将来引入分片,须先按分片记录进度再重投。
 *
 * 持久化:journal kind 固定 "delivery.obligation",payload=义务全量快照,后写覆盖前写;
 * 启动回放与任务快照同一遍 readAll 收集(见 app.ts),不额外扫 journal。
 */
import type { Journal } from "@lampgenie/core";

export const DELIVERY_OBLIGATION_KIND = "delivery.obligation" as const;
/** 一次 claim 的有效租约(本仓 gateway 侧无 claimTtlMs 配置,取 60s)。 */
export const DEFAULT_CLAIM_TTL_MS = 60_000;
/** attempts ≤ 3。 */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** 首投起 24h 内必须投递成功。 */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ObligationState = "pending" | "attempting" | "delivered" | "failed";
/** 终态种类:重发时按它重建与首投同形的帧。 */
export type TerminalState = "done" | "failed" | "cancelled";

export interface DeliveryObligation {
  obligationId: string;
  taskId: string;
  sessionId: string;
  state: ObligationState;
  attempts: number;
  firstAttemptAt: number | null;
  lastAttemptAt: number | null;
  /** 仅 attempts > 1(即重发)时为 true。 */
  mayBeDuplicate: boolean;
  terminalState: TerminalState;
  terminalAt: number;
  /** 最后一次未投递成功的说明(attempts 用尽/窗口过期/任务已不存在)。 */
  reason?: string;
}

export interface DeliveryObligationStoreOptions {
  journal: Pick<Journal, "append" | "readAll">;
  /** 启动回放顺序中的义务快照(与任务快照同一遍 readAll 收集);缺省=自读 journal。 */
  seed?: readonly DeliveryObligation[];
  now?: () => number;
  claimTtlMs?: number;
  maxAttempts?: number;
  windowMs?: number;
}

export function obligationIdOf(taskId: string): string {
  return `${taskId}:terminal`;
}

function terminalStateOf(state: string): TerminalState {
  if (state === "cancelled") return "cancelled";
  if (state === "failed") return "failed";
  return "done";
}

/** 终态投递义务表。非线程安全:server 侧单进程单实例使用。 */
export class DeliveryObligationStore {
  private readonly journal: Pick<Journal, "append" | "readAll">;
  private readonly now: () => number;
  private readonly claimTtlMs: number;
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly obligations = new Map<string, DeliveryObligation>();

  constructor(opts: DeliveryObligationStoreOptions) {
    this.journal = opts.journal;
    this.now = opts.now ?? (() => Date.now());
    this.claimTtlMs = opts.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    const seed = opts.seed ?? this.journal.readAll()
      .filter((ev) => ev.kind === DELIVERY_OBLIGATION_KIND)
      .map((ev) => ev.payload as DeliveryObligation);
    for (const ob of seed) {
      if (!ob || typeof ob.obligationId !== "string" || typeof ob.taskId !== "string") continue;
      this.obligations.set(ob.obligationId, { ...ob });
    }
  }

  /** 登记终态义务。同一 taskId 重复登记不新增事件,返回既有义务(幂等)。 */
  register(task: { id: string; sessionId: string; state: string }): DeliveryObligation {
    const obligationId = obligationIdOf(task.id);
    const existing = this.obligations.get(obligationId);
    if (existing) return existing;
    const ob: DeliveryObligation = {
      obligationId,
      taskId: task.id,
      sessionId: task.sessionId,
      state: "pending",
      attempts: 0,
      firstAttemptAt: null,
      lastAttemptAt: null,
      mayBeDuplicate: false,
      terminalState: terminalStateOf(task.state),
      terminalAt: this.now(),
    };
    // journal 侧双保险:幂等键固定,进程内 map 之外的并发写也不会重复落账。
    this.persist(ob, `${DELIVERY_OBLIGATION_KIND}:${obligationId}:registered`);
    return ob;
  }

  get(taskId: string): DeliveryObligation | undefined {
    return this.obligations.get(obligationIdOf(taskId));
  }

  /** 待投递清单(按登记先后,最多 limit 条)。 */
  pending(limit = 100): DeliveryObligation[] {
    const out: DeliveryObligation[] = [];
    for (const ob of this.obligations.values()) {
      if (ob.state !== "pending") continue;
      out.push(ob);
      if (out.length >= limit) break;
    }
    return out;
  }

  list(): DeliveryObligation[] {
    return [...this.obligations.values()];
  }

  /**
   * claim 一次投递尝试:pending/超租约 attempting → attempting,attempts+1。
   * 已 delivered/failed、租约内已在投、或超限(尝试数/时间窗)时返回 undefined。
   */
  beginAttempt(taskId: string): DeliveryObligation | undefined {
    const ob = this.obligations.get(obligationIdOf(taskId));
    if (!ob || ob.state === "delivered" || ob.state === "failed") return undefined;
    const now = this.now();
    const exhausted = this.exhaustedReason(ob, now);
    if (exhausted) {
      this.fail(ob, exhausted);
      return undefined;
    }
    if (ob.state === "attempting" && now - (ob.lastAttemptAt ?? 0) < this.claimTtlMs) return undefined;
    const attempts = ob.attempts + 1;
    const next: DeliveryObligation = {
      ...ob,
      state: "attempting",
      attempts,
      firstAttemptAt: ob.firstAttemptAt ?? now,
      lastAttemptAt: now,
      // 重发才可能与首投重复;首投 attempts=1 不带标记。
      mayBeDuplicate: attempts > 1,
      reason: undefined,
    };
    this.persist(next, `${DELIVERY_OBLIGATION_KIND}:${obligationIdOf(taskId)}:attempt-${attempts}`);
    return next;
  }

  markDelivered(taskId: string): DeliveryObligation | undefined {
    const ob = this.obligations.get(obligationIdOf(taskId));
    if (!ob || ob.state === "delivered") return ob;
    const next: DeliveryObligation = { ...ob, state: "delivered", reason: undefined };
    this.persist(next, `${DELIVERY_OBLIGATION_KIND}:${obligationIdOf(taskId)}:delivered`);
    return next;
  }

  markFailed(taskId: string, reason = "failed"): DeliveryObligation | undefined {
    const ob = this.obligations.get(obligationIdOf(taskId));
    if (!ob || ob.state === "failed") return ob;
    this.fail(ob, reason);
    return this.obligations.get(ob.obligationId);
  }

  /** 发送失败(抛错/无可用连接)→ attempting 回 pending,attempts 已计入(下次重发带 mayBeDuplicate)。 */
  release(taskId: string): DeliveryObligation | undefined {
    const ob = this.obligations.get(obligationIdOf(taskId));
    if (!ob || ob.state !== "attempting") return ob;
    const next: DeliveryObligation = { ...ob, state: "pending" };
    this.persist(next, `${DELIVERY_OBLIGATION_KIND}:${obligationIdOf(taskId)}:released-${ob.attempts}`);
    return next;
  }

  /**
   * 启动/周期 sweep:超租约 attempting 回 pending;超限(attempts≥3 或首投超 24h)→ failed;
   * delivered 保持。返回当前待重投列表(不自动发送——没有连接时不得 claim)。
   */
  sweep(now = this.now()): DeliveryObligation[] {
    for (const ob of [...this.obligations.values()]) {
      if (ob.state === "delivered" || ob.state === "failed") continue;
      const exhausted = this.exhaustedReason(ob, now);
      if (exhausted) { this.fail(ob, exhausted); continue; }
      if (ob.state !== "attempting") continue;
      if (now - (ob.lastAttemptAt ?? 0) < this.claimTtlMs) continue;
      const next: DeliveryObligation = { ...ob, state: "pending" };
      this.persist(next, `${DELIVERY_OBLIGATION_KIND}:${ob.obligationId}:sweep-${ob.attempts}`);
    }
    return this.pending();
  }

  private exhaustedReason(ob: DeliveryObligation, now: number): string | undefined {
    if (ob.attempts >= this.maxAttempts) return "attempts-exhausted";
    if (ob.firstAttemptAt !== null && now - ob.firstAttemptAt >= this.windowMs) return "window-expired";
    return undefined;
  }

  private fail(ob: DeliveryObligation, reason: string): void {
    const next: DeliveryObligation = { ...ob, state: "failed", reason };
    this.persist(next, `${DELIVERY_OBLIGATION_KIND}:${ob.obligationId}:failed`);
  }

  private persist(ob: DeliveryObligation, idempotencyKey: string): void {
    this.obligations.set(ob.obligationId, ob);
    this.journal.append({
      kind: DELIVERY_OBLIGATION_KIND,
      sessionId: ob.sessionId,
      payload: ob,
      idempotencyKey,
    });
  }
}

export function createDeliveryObligationStore(opts: DeliveryObligationStoreOptions): DeliveryObligationStore {
  return new DeliveryObligationStore(opts);
}

/**
 * 单次投递:claim → send。send 返回 true(至少一个连接收到)=delivered;
 * 返回 false/抛错=release 回 pending,下次(新连接/周期 sweep)重发并带 mayBeDuplicate。
 * 无连接时不调用本函数(register 后保持 pending),这是「只对已连接 adapter claim」的落点。
 */
export function attemptDelivery(
  store: DeliveryObligationStore,
  taskId: string,
  send: (ob: DeliveryObligation) => boolean,
): DeliveryObligation | undefined {
  const ob = store.beginAttempt(taskId);
  if (!ob) return undefined;
  let ok = false;
  try { ok = send(ob) === true; } catch { ok = false; }
  return ok ? store.markDelivered(taskId) : store.release(taskId);
}
