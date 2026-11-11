/**
 * 工作流运行护栏(RunGuard)。
 * 定位:journal-first 重放解决的是「同一脚本重跑结果一致」,但不解决「一条 run 本身失控」——
 * 脚本写出几十个并发 ask、或在循环里持续派发,会打爆子代理池,并让 run 永远不返回。
 * 本模块只做三件事:并发闸(acquire/release)、总派发预算(recordDispatch)、fatal 收敛
 * (abortAll + settleOrder)。
 * 纪律:纯逻辑、零 IO——时间(now)与中止信号(signal)全部由调用方注入,便于确定性测试;
 * 所有公开方法都不 throw(acquire 用 rejected Promise 表达失败,settleOrder 永不 reject)。
 */

import { SeatPool } from "@lampgenie/runtime/concurrency/seat-pool";

/** 护栏状态码(回执 / 统计 / journal 共用同一套词)。
 * CONCURRENCY_EXCEEDED 保留给非阻塞调用方:acquire 的语义是「排队等待」而不是拒绝,
 * 所以并发超限本身不产生这个码;真正需要「立即失败」的场景才用它。 */
export const RUN_GUARD_CODES = ["OK", "CONCURRENCY_EXCEEDED", "TOTAL_EXCEEDED", "FATAL", "ABORTED"] as const;
export type RunGuardCode = (typeof RUN_GUARD_CODES)[number];

/** 可以判定「整条 run 必须中止」的错误码。
 * TOTAL_EXCEEDED 之所以算 fatal:总派发预算耗尽后,后续每次 ask 都必然失败,
 * 继续跑只会产出半截结果并继续消耗子代理,唯一正确处置是中止排队、等在飞收敛、整条 run partial 收尾。 */
export const FATAL_CODES: readonly string[] = ["TOTAL_EXCEEDED", "FATAL", "SCRIPT_FATAL"];

/** 护栏抛出的错误:带 code,可选 fatal 标记(供 isFatalWorkflowError 统一判定)。 */
export class WorkflowRunError extends Error {
  readonly code: string;
  readonly fatal: boolean;
  constructor(code: string, message: string, opts: { fatal?: boolean } = {}) {
    super(message);
    this.name = "WorkflowRunError";
    this.code = code;
    this.fatal = opts.fatal ?? false;
  }
}

/** err 是否必须中止整条 run:fatal===true,或 code 命中 FATAL_CODES。 */
export function isFatalWorkflowError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { fatal?: unknown; code?: unknown };
  if (e.fatal === true) return true;
  return typeof e.code === "string" && FATAL_CODES.includes(e.code);
}

export interface RunGuardOptions {
 /** 并发上限(缺省 8,与引擎既有缺省并发一致);非法值回落到缺省。 */
  maxConcurrent?: number;
 /** 单 run 总派发上限(缺省 200);0 表示一律拒绝。 */
  maxTotal?: number;
 /** 时间源(缺省 Date.now);注入后 abortInfo 可确定性断言。 */
  now?: () => number;
}

export interface RunGuardStats {
  inFlight: number;
  queued: number;
  total: number;
  maxConcurrent: number;
  maxTotal: number;
  aborted: boolean;
}

function normalizeInt(raw: unknown, fallback: number, min: number): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= min ? raw : fallback;
}

export class RunGuard {
  readonly maxConcurrent: number;
  readonly maxTotal: number;
  private readonly now: () => number;
  private total = 0;
  private aborted = false;
  private abortReason: string | undefined;
  private abortAt: number | undefined;
 /** 并发座位池:容量=maxConcurrent,超出容量的 acquire 在池里排队(park)。
 * 座位 = run 界,不是 provider 界——provider 界(AIMD/ceiling)在 governor 里,两界取 min
 * 由 ceiling.ts 的 doubleBoundConcurrency 统一。 */
  private readonly pool: SeatPool;
 /** 座位占有者标识:只为观测/排障区分等待者,不参与调度(同 owner 也不插队)。 */
  private ownerSeq = 0;

  constructor(opts: RunGuardOptions = {}) {
    this.maxConcurrent = normalizeInt(opts.maxConcurrent, 8, 1);
    this.maxTotal = normalizeInt(opts.maxTotal, 200, 0);
    this.now = opts.now ?? (() => Date.now());
    this.pool = new SeatPool({ capacity: this.maxConcurrent, maxQueue: 256, now: this.now });
  }

 /** 取一个并发槽:有空位立即给 release;否则按 FIFO 排队(返回的 Promise 在拿到槽时 resolve)。
 * 实现上=向座位池借一张座位,归还即 release(幂等:重复调用不会多放槽)。 */
  acquire(opts: { signal?: AbortSignal } = {}): Promise<() => void> {
    if (this.aborted) return Promise.reject(this.abortedError());
    const ownerId = `guard-${++this.ownerSeq}`;
    return this.pool.acquire(ownerId, { signal: opts.signal }).then(
      (seat) => {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.pool.release(seat.seatId);
        };
      },
      (err: unknown) => {
        throw this.mapSeatError(err);
      },
    );
  }

 /** 占一个总派发预算:到上限后返回 TOTAL_EXCEEDED 且不递增(预算耗尽不可逆,不能靠重试恢复)。 */
  recordDispatch(): { ok: boolean; code: RunGuardCode } {
    if (this.total >= this.maxTotal) return { ok: false, code: "TOTAL_EXCEEDED" };
    this.total++;
    return { ok: true, code: "OK" };
  }

 /** 中止护栏:拒绝全部排队者(ABORTED)并标记 aborted(此后 acquire 直接拒)。
 * 已在飞的槽不回收——它们的收尾由调用方用 settleOrder 等。
 * 重复调用保留首次原因(第一次中止才是真正原因,后续 run-ended 只是收尾)。 */
  abortAll(reason: string): void {
    const why = String(reason || "aborted");
    if (!this.aborted) {
      this.aborted = true;
      this.abortReason = why;
      this.abortAt = this.now();
    }
 // 座位池中止:拒绝全部排队者(ABORTED),在飞座位不回收——它们的收尾由调用方用 settleOrder 等
    this.pool.abortAll(why);
  }

 /** 中止原因快照(观测/测试用):未中止时为空对象。 */
  abortInfo(): { reason?: string; at?: number } {
    if (!this.aborted) return {};
    return this.abortReason === undefined ? {} : { reason: this.abortReason, at: this.abortAt };
  }

  stats(): RunGuardStats {
    const s = this.pool.stats();
    return {
      inFlight: s.inUse,
      queued: s.parked,
      total: this.total,
      maxConcurrent: this.maxConcurrent,
      maxTotal: this.maxTotal,
      aborted: this.aborted,
    };
  }

 /** 座位池错误 → 护栏错误码:ABORTED 保留 code(信号中止/池已中止),队列满映射为
 * CONCURRENCY_EXCEEDED(这个码本就是给「非阻塞调用方立即失败」用的)。 */
  private mapSeatError(err: unknown): unknown {
    const code = (err as { code?: unknown } | null | undefined)?.code;
    if (code === "ABORTED" && this.aborted) return this.abortedError();
    if (code === "INVALID") {
      return new WorkflowRunError("CONCURRENCY_EXCEEDED", "运行护栏:并发等待队列已满", { fatal: false });
    }
    return err;
  }

  private abortedError(): WorkflowRunError {
    return new WorkflowRunError("ABORTED", `运行护栏已中止(${this.abortReason ?? "aborted"})`, { fatal: false });
  }
}

/** 等一批 Promise 全部落定(成功/失败都算落定),超时未落定者计入 pending。
 * 绝不 reject、绝不 throw:这是 run 收尾路径上的最后一道闸,自己再抛错会把 run 的终态吞掉。
 * 「失败也算 settled」的理由:这里关心的是「还会不会有人晚于 run 返回写 journal」,不是错误本身。 */
export async function settleOrder(
  tasks: ReadonlyArray<Promise<unknown>>,
  opts: { timeoutMs?: number } = {},
): Promise<{ settled: number; pending: number }> {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const totalCount = list.length;
  if (totalCount === 0) return { settled: 0, pending: 0 };
  const timeoutMs = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(0, opts.timeoutMs) : 5_000;
  let settled = 0;
  const tracked = list.map((p) =>
    Promise.resolve(p).then(
      () => { settled++; },
      () => { settled++; },
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((res) => {
    timer = setTimeout(res, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([Promise.all(tracked).then(() => undefined), timeout]);
  if (timer) clearTimeout(timer);
  return { settled, pending: totalCount - settled };
}
