/**
 * tool-settlement:工具 Promise 的显式结算面(eager fork / 并发上限 / 观察标记 / 排空 / 竞速 / 超时 / 批量)。
 * 背景:工具调用一旦 `void` 掉 Promise,失败就变成 unhandledRejection,而「谁观察过这次失败」在
 * 事后完全不可知——日志里只剩一条无人认领的栈。本模块把「fork → 观察 → 排空」变成显式的三步:
 * ①eagerFork 立刻为每个 task 生成一个句柄(带 AbortController 与 id)并按并发上限调度;
 * ②awaitHandle 观察(置 observed、记 AWAITED),drain 只对「从未被观察的 rejected 句柄」出诊断;
 * ③raceSettle / withTimeout / settleBatch / cancelAll 负责中断其余句柄并**等它们真的停下**。
 * 口径:
 * - 句柄 promise 只创建一次,run 只执行一次(排队中被 abort 的句柄 run 永不执行);
 * - 内部对每个句柄 promise 挂一个吞异常的 `.catch`,不再依赖调用方兜底;
 * - 每个句柄状态机 pending → fulfilled | rejected | aborted,aborted 后原 run 的迟到结算被忽略;
 * - 诊断时间戳走注入的 `env.now`(缺省 Date.now),便于确定性断言,不依赖真实时钟;
 * - 所有工具函数纯进程内,不读写 journal/文件。
 */

/** 结算码:所有可判别的原因都编码成稳定字符串,便于日志/断言。 */
export const SETTLE_CODES = {
  INVALID: "SETTLE_INVALID",
  FORKED: "SETTLE_FORKED",
  AWAITED: "SETTLE_AWAITED",
  DRAINED: "SETTLE_DRAINED",
  UNOBSERVED_REJECTION: "SETTLE_UNOBSERVED_REJECTION",
  RACE_WON: "SETTLE_RACE_WON",
  RACE_ABORTED: "SETTLE_RACE_ABORTED",
  TIMEOUT_ABORTED: "SETTLE_TIMEOUT_ABORTED",
  CANCELLED: "SETTLE_CANCELLED",
  DOUBLE_AWAIT_IDEMPOTENT: "SETTLE_DOUBLE_AWAIT_IDEMPOTENT",
} as const;

export type SettleCode = (typeof SETTLE_CODES)[keyof typeof SETTLE_CODES];

/** 结算错误:code 是唯一的判别依据,message 只做人读补充。 */
export class SettleError extends Error {
  readonly code: SettleCode;

  constructor(code: SettleCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options);
    this.name = "SettleError";
    this.code = code;
  }
}

export type SettleState = "pending" | "fulfilled" | "rejected" | "aborted";

export interface SettleHandle<T = unknown> {
  readonly id: string;
  state: SettleState;
  readonly promise: Promise<T>;
  observed: boolean;
  result?: T;
  error?: unknown;
  readonly controller: AbortController;
  readonly codes: SettleCode[];
  awaitCount: number;
}

export interface SettleTaskContext {
  readonly signal: AbortSignal;
  readonly id: string;
}

export interface SettleTask<T = unknown> {
  id?: string;
  run(ctx: SettleTaskContext): Promise<T> | T;
}

export interface SettleEnv {
  maxConcurrency?: number;
  now?: () => number;
}

export interface UnobservedRejectionDiagnostic {
  kind: "unobserved-rejection";
  handleId: string;
  error: unknown;
  at: number;
}

export interface SettlementLog {
  handles: SettleHandle[];
  diagnostics: UnobservedRejectionDiagnostic[];
}

/** 句柄内部簿记:同步结算回调 + 底层 run 真正停下的信号。 */
interface Internals {
  started: boolean;
  readonly runDone: Promise<void>;
  readonly markRunDone: () => void;
  readonly listeners: Array<(h: SettleHandle) => void>;
  /** 句柄 promise 的拒绝端:abort 需要它让 promise 立刻以 SettleError 拒绝。 */
  readonly rejectOuter: (error: unknown) => void;
}

const INTERNALS = new WeakMap<object, Internals>();

/** 缺省并发上限。 */
export const DEFAULT_MAX_CONCURRENCY = 8;

interface HandleKit<T> {
  readonly handle: SettleHandle<T>;
  fulfill(value: T): void;
  reject(error: unknown): void;
}

/** 码去重追加:同一原因多次发生只留一条,保证 codes 可断言。 */
function pushCode(h: SettleHandle, code: SettleCode): void {
  if (!h.codes.includes(code)) h.codes.push(code);
}

function createHandle<T>(id: string): HandleKit<T> {
  const controller = new AbortController();
  let resolveOuter!: (value: T) => void;
  let rejectOuter!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolveOuter = res;
    rejectOuter = rej;
  });
  // 内部吞异常:句柄的拒绝永远不依赖调用方兜底(否则就是 unhandledRejection)。
  void promise.catch(() => {});

  let markRunDone!: () => void;
  const runDone = new Promise<void>((res) => {
    markRunDone = res;
  });

  const handle: SettleHandle<T> = {
    id,
    state: "pending",
    promise,
    observed: false,
    controller,
    codes: [SETTLE_CODES.FORKED],
    awaitCount: 0,
  };

  const internals: Internals = { started: false, runDone, markRunDone, listeners: [], rejectOuter };
  INTERNALS.set(handle, internals);

  const notify = (): void => {
    for (const listener of internals.listeners) listener(handle);
  };

  return {
    handle,
    fulfill(value: T): void {
      if (handle.state !== "pending") return;
      handle.state = "fulfilled";
      handle.result = value;
      resolveOuter(value);
      notify();
    },
    reject(error: unknown): void {
      if (handle.state !== "pending") return;
      handle.state = "rejected";
      handle.error = error;
      rejectOuter(error);
      notify();
    },
  };
}

/** 在句柄同步结算时回调(仅本模块 fork 出来的句柄有同步通道)。 */
function onSettleSync(h: SettleHandle, cb: (h: SettleHandle) => void): boolean {
  const internals = INTERNALS.get(h);
  if (!internals) return false;
  internals.listeners.push(cb);
  return true;
}

/** 等某个句柄底层 run 真正停下(未启动即已停)。 */
function runDoneOf(h: SettleHandle): Promise<void> {
  const internals = INTERNALS.get(h);
  if (internals) return internals.runDone;
  return h.promise.then(
    () => undefined,
    () => undefined);
}

/**
 * 立刻分离式启动一组任务:eager 生成句柄并按 maxConcurrency 调度,超出排队。
 * 返回的 drain 会等全部结算并给出未观察拒绝诊断(不再抛)。
 */
export function eagerFork<T>(
  tasks: ReadonlyArray<SettleTask<T>>,
  opts: { env?: SettleEnv; onStart?: (h: SettleHandle<T>, index: number) => void } = {},
): { handles: SettleHandle<T>[]; drain: () => Promise<SettlementLog> } {
  const env = opts.env ?? {};
  const maxConcurrency = env.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  if (typeof maxConcurrency !== "number" || !Number.isInteger(maxConcurrency) || maxConcurrency <= 0) {
    throw new SettleError(SETTLE_CODES.INVALID, `maxConcurrency 必须是正整数,收到 ${String(maxConcurrency)}`);
  }
  const now = env.now ?? Date.now;

  const kits = tasks.map((task, index) => ({
    task,
    index,
    kit: createHandle<T>(task.id ?? `h${index + 1}`),
  }));
  const handles = kits.map((entry) => entry.kit.handle);

  let running = 0;
  let cursor = 0;

  const pump = (): void => {
    while (running < maxConcurrency && cursor < kits.length) {
      const entry = kits[cursor];
      cursor += 1;
      if (!entry) continue;
      // 排队中被 abort 的句柄永不执行。
      if (entry.kit.handle.state !== "pending") continue;
      start(entry);
    }
  };

  const start = (entry: { task: SettleTask<T>; index: number; kit: HandleKit<T> }): void => {
    const { handle } = entry.kit;
    const internals = INTERNALS.get(handle);
    if (internals) internals.started = true;
    running += 1;
    const ctx: SettleTaskContext = { signal: handle.controller.signal, id: handle.id };
    const settleSlot = (): void => {
      running -= 1;
      if (internals) internals.markRunDone();
      pump();
    };
    let raw: Promise<T> | T;
    try {
      raw = entry.task.run(ctx);
    } catch (error) {
      entry.kit.reject(error);
      settleSlot();
      return;
    }
    opts.onStart?.(handle, entry.index);
    Promise.resolve(raw).then(
      (value) => {
        entry.kit.fulfill(value);
        settleSlot();
      },
      (error: unknown) => {
        entry.kit.reject(error);
        settleSlot();
      },
    );
  };

  pump();

  return {
    handles,
    drain: () => drainInternals(handles, now),
  };
}

/** 观察句柄:置 observed、记 AWAITED/DOUBLE_AWAIT_IDEMPOTENT,返回缓存 promise(值/错都原样)。 */
export function awaitHandle<T>(h: SettleHandle<T>): Promise<T> {
  h.observed = true;
  h.awaitCount += 1;
  if (h.awaitCount > 1) pushCode(h, SETTLE_CODES.DOUBLE_AWAIT_IDEMPOTENT);
  pushCode(h, SETTLE_CODES.AWAITED);
  return h.promise;
}

/**
 * 中断句柄:pending → aborted,error 为 SettleError(code),controller.abort()。
 * 对已结算句柄是 no-op(不抛、不改状态)。run 的迟到结算被忽略。
 */
export function abortHandle(h: SettleHandle, code: SettleCode = SETTLE_CODES.CANCELLED): void {
  if (h.state !== "pending") return;
  const internals = INTERNALS.get(h);
  h.state = "aborted";
  const error = new SettleError(code, `句柄 ${h.id} 被中断(${code})`);
  h.error = error;
  pushCode(h, code);
  try {
    h.controller.abort(error);
  } catch {
    // 自定义 abort reason 不被某些宿主接受时退化为无 reason 的中断。
    h.controller.abort();
  }
  const rejectOuter = internals?.rejectOuter;
  if (rejectOuter) rejectOuter(error);
  for (const listener of internals?.listeners ?? []) listener(h);
  if (internals && !internals.started) internals.markRunDone();
}

async function drainInternals(
  handles: ReadonlyArray<SettleHandle>,
  now: () => number): Promise<SettlementLog> {
  await Promise.all(
    handles.map((h) =>
      h.promise.then(
        () => undefined,
        () => undefined),
    ),
  );
  const diagnostics: UnobservedRejectionDiagnostic[] = [];
  for (const h of handles) {
    if (h.observed) continue;
    if (h.state !== "rejected") continue;
    diagnostics.push({ kind: "unobserved-rejection", handleId: h.id, error: h.error, at: now() });
  }
  return { handles: [...handles], diagnostics };
}

/** 等全部句柄结算(不再抛),并对未观察的拒绝给出诊断。 */
export function drain(handles: ReadonlyArray<SettleHandle>): Promise<SettlementLog> {
  return drainInternals(handles, Date.now);
}

/**
 * 竞速:首个结算者胜(RACE_WON + observed),其余 pending 者一律 abort(RACE_ABORTED),
 * 并等它们的 run 真正停下(返回时 loser.state 已是 aborted、run 的 finally 已跑完)。
 */
export function raceSettle<T>(
  handles: ReadonlyArray<SettleHandle<T>>,
): Promise<{ winner: SettleHandle<T>; aborted: string[]; log: SettlementLog }> {
  if (handles.length === 0) {
    throw new SettleError(SETTLE_CODES.INVALID, "raceSettle 至少需要一个句柄");
  }
  const list = [...handles];
  return (async () => {
    const winner = await new Promise<SettleHandle<T>>((res) => {
      for (const h of list) {
        void h.promise.then(
          () => res(h),
          () => res(h),
        );
      }
    });
    winner.observed = true;
    pushCode(winner, SETTLE_CODES.RACE_WON);

    const aborted: string[] = [];
    const waits: Promise<void>[] = [];
    for (const h of list) {
      if (h === winner) continue;
      if (h.state === "pending") {
        abortHandle(h, SETTLE_CODES.RACE_ABORTED);
        aborted.push(h.id);
      }
      waits.push(runDoneOf(h));
    }
    await Promise.all(waits);
    const log = await drainInternals(list, Date.now);
    return { winner, aborted, log };
  })();
}

/**
 * 超时闸:ms 内全部结算 → completed;否则 abort 全部未结算句柄(TIMEOUT_ABORTED)并等它们停下。
 * ms 必须是有限正数,否则 INVALID。
 */
export function withTimeout(
  handles: ReadonlyArray<SettleHandle>,
  ms: number): Promise<
  { status: "completed"; log: SettlementLog } | { status: "timeout"; code: "SETTLE_TIMEOUT_ABORTED"; aborted: string[] }
> {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    throw new SettleError(SETTLE_CODES.INVALID, `超时毫秒必须是有限正数,收到 ${String(ms)}`);
  }
  const list = [...handles];
  return (async () => {
    const allSettled = drainInternals(list, Date.now);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutSignal = new Promise<"timeout">((res) => {
      timer = setTimeout(() => res("timeout"), ms);
    });
    const outcome = await Promise.race<string>([allSettled.then(() => "completed" as const), timeoutSignal]);
    if (timer !== undefined) clearTimeout(timer);

    if (outcome === "completed") {
      const log = await allSettled;
      return { status: "completed" as const, log };
    }

    const aborted: string[] = [];
    for (const h of list) {
      if (h.state !== "pending") continue;
      abortHandle(h, SETTLE_CODES.TIMEOUT_ABORTED);
      aborted.push(h.id);
    }
    await Promise.all(list.map((h) => runDoneOf(h)));
    return { status: "timeout" as const, code: SETTLE_CODES.TIMEOUT_ABORTED, aborted };
  })();
}

/**
 * 批量结算:policy 默认 "abort-rest"——首个失败即 aborts 其余(排队未启动者永不执行);
 * "wait-all" 则跑完全部再返回首错。
 */
export function settleBatch<T>(
  handles: ReadonlyArray<SettleHandle<T>>,
  opts: { policy?: "abort-rest" | "wait-all" } = {},
): Promise<{ log: SettlementLog; firstError?: unknown }> {
  const policy = opts.policy ?? "abort-rest";
  const list = [...handles];
  if (policy !== "abort-rest" && policy !== "wait-all") {
    throw new SettleError(SETTLE_CODES.INVALID, `未知 policy ${String(policy)}`);
  }
  return (async () => {
    const allSettled = drainInternals(list, Date.now);

    if (policy === "abort-rest") {
      let failed = false;
      let firstError: unknown;
      const trip = (h: SettleHandle): void => {
        if (failed || h.state !== "rejected") return;
        failed = true;
        firstError = h.error;
        for (const other of list) {
          if (other === h || other.state !== "pending") continue;
          abortHandle(other, SETTLE_CODES.CANCELLED);
        }
      };
      for (const h of list) {
        onSettleSync(h, trip);
        void h.promise.then(
          () => {},
          () => trip(h),
        );
      }
      const log = await allSettled;
      return failed ? { log, firstError } : { log };
    }

    const log = await allSettled;
    const first = list.find((h) => h.state === "rejected");
    return first ? { log, firstError: first.error } : { log };
  })();
}

/** 批量中断:code 缺省 CANCELLED;返回后所有句柄 state 均为 aborted(已结算者不变)。 */
export function cancelAll(handles: ReadonlyArray<SettleHandle>, code: SettleCode = SETTLE_CODES.CANCELLED): void {
  for (const h of handles) abortHandle(h, code);
}
