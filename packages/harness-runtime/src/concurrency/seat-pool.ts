/**
 * 座位池(SeatPool):run 界并发的「座位」实现。
 * **座位 = run 界,不是 provider 界。** 两道界必须分清:
 * - provider 界(governor 的 AIMD / ceiling)管「同时有多少个请求打向某家 provider」,
 * 跨 run 共享、按响应动态调;
 * - 座位管「单条 run 允许多少个派发同时在飞」,上界是该 run 自己的 maxConcurrency。
 * 两者取 min 才是实际生效的并发(见 ceiling.ts 的 doubleBoundConcurrency)。
 * 座位池可以复用给任何 run:池子的容量由调用方给,池子不认识 run、不认识 provider。
 * 核心语义:**超容量不是失败,是排队(park)**。排到座位才 resolve;唯一能让排队 Promise
 * 落定的是 release / abortAll / signal abort —— 不做定时轮询、不靠事件循环副作用。
 * 纪律:纯逻辑、零 IO——时间(now)与中止信号(signal)全部由调用方注入,便于确定性测试;
 * 所有公开方法都不 throw,acquire 的失败用 rejected Promise 表达(错误带 SEAT_CODES 的 code)。
 */

/** 座位事件/错误码(回执、日志、错误对象共用同一套词)。 */
export const SEAT_CODES = ["ACQUIRED", "PARKED", "ABORTED", "RELEASED", "INVALID"] as const;
export type SeatCode = (typeof SEAT_CODES)[number];

/** 座位池抛出的错误:带 code(acquire 只 reject,不 throw 同步异常)。 */
export class SeatError extends Error {
  readonly code: SeatCode;
  constructor(code: SeatCode, message: string) {
    super(message);
    this.name = "SeatError";
    this.code = code;
  }
}

export interface Seat {
  seatId: string;
  ownerId: string;
 /** 排队时长(毫秒);只有「先 PARKED 后被唤醒」的座位带这个字段,立即拿到的座位没有。 */
  queuedMs?: number;
}

export interface SeatPoolOptions {
 /** 座位容量(同时在飞上限);非有限/非正数一律归一到 1。 */
  capacity: number;
 /** 排队上限(缺省 256);排满后新的 acquire 以 INVALID 拒绝,而不是无限挂起。 */
  maxQueue?: number;
 /** 时间源(缺省 Date.now),注入后 queuedMs 可确定性断言。 */
  now?: () => number;
}

export interface SeatPoolStats {
  capacity: number;
  inUse: number;
  parked: number;
  totalAcquired: number;
  totalParked: number;
}

export interface SeatAcquireOptions {
  signal?: AbortSignal;
 /** 观测钩子:入队时回调本次排队的位次(1-based);钩子异常不影响排队。 */
  onParked?: (position: number) => void;
}

/** 排队项:resolve/reject 只由 pump(释放唤醒)与 abort(信号/中止池)触发。 */
interface ParkedEntry {
  ownerId: string;
 /** 入队时定格的排队位次(1-based):先前的人被摘掉后不回填,位次只表达「你来时排第几」。 */
  position: number;
  parkedAt: number;
  onAbort?: () => void;
  resolve: (seat: Seat) => void;
  reject: (err: unknown) => void;
}

const DEFAULT_MAX_QUEUE = 256;
const ABSOLUTE_MIN_CAPACITY = 1;

function normalizeCapacity(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return ABSOLUTE_MIN_CAPACITY;
  return Math.max(ABSOLUTE_MIN_CAPACITY, Math.floor(raw));
}

function normalizeMaxQueue(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_QUEUE;
  return Math.max(0, Math.floor(raw));
}

export class SeatPool {
  private capacityValue: number;
  private readonly maxQueue: number;
  private readonly now: () => number;
 /** 在飞座位:seatId → 占有者。用 Map 而不是计数,是为了 release 能识别未知/重复的 seatId。 */
  private readonly seats = new Map<string, { ownerId: string; grantedAt: number }>();
 /** FIFO 队列:数组头就是下一个该被唤醒的人(同 owner 也不插队)。 */
  private queue: ParkedEntry[] = [];
  private seq = 0;
  private totalAcquired = 0;
  private totalParked = 0;
  private aborted = false;
  private abortReason: string | undefined;

  constructor(opts: SeatPoolOptions) {
    this.capacityValue = normalizeCapacity(opts.capacity);
    this.maxQueue = normalizeMaxQueue(opts.maxQueue);
    this.now = opts.now ?? (() => Date.now());
  }

 /**
 * 取一个座位:有空位立即 resolve;否则入队 PARKED(记录排队位次),等到 release 唤醒。
 * 失败只走 rejected Promise:池已中止 / 信号已中止 → ABORTED;队列满 → INVALID。
 */
  acquire(ownerId: string, opts: SeatAcquireOptions = {}): Promise<Seat> {
    const signal = opts.signal;
    if (this.aborted) {
      return Promise.reject(new SeatError("ABORTED", `座位池已中止(${this.abortReason ?? "aborted"})`));
    }
    if (signal?.aborted) {
 // 已中止的等待必然作废:排进队列只会拖慢 release 后的唤醒口径
      return Promise.reject(new SeatError("ABORTED", "座位池:调用方信号已中止"));
    }
 // 有空位且没人排队才立即给:队列非空时新来者必须排队,否则会插到已在等的人前面
    if (this.queue.length === 0 && this.seats.size < this.capacityValue) {
      return Promise.resolve(this.grant(ownerId));
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new SeatError("INVALID", `座位池队列已满(${this.maxQueue})`));
    }
    return new Promise<Seat>((resolve, reject) => {
      const entry: ParkedEntry = {
        ownerId,
        position: this.queue.length + 1,
        parkedAt: this.now(),
        resolve,
        reject,
      };
      if (signal) {
        const onAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx < 0) return; // 已被释放或已被 abortAll 处理:不重复结算
          this.queue.splice(idx, 1);
          entry.onAbort = undefined;
          reject(new SeatError("ABORTED", "座位池:排队等待时信号中止"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.onAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.queue.push(entry);
      this.totalParked++;
      try {
        opts.onParked?.(entry.position);
      } catch { /* 观测面异常不能打断排队 */ }
    });
  }

 /**
 * 归还座位并唤醒队首(FIFO)。返回 released=false 表示未知/已释放的 seatId(幂等,不抛)。
 * granted 是本次释放唤醒的队首座位(有排队者时才出现)。
 */
  release(seatId: string): { released: boolean; granted?: Seat } {
    const seat = this.seats.get(seatId);
    if (!seat) return { released: false };
    this.seats.delete(seatId);
    const granted = this.pump();
    return granted ? { released: true, granted } : { released: true };
  }

 /**
 * 调整容量:缩容只影响后续 acquire(在飞座位不打断);
 * 扩容也不主动追发座位——排队 Promise 只由 release/abort 落定(保证确定性,不引入新时序)。
 */
  setCapacity(n: number): void {
    this.capacityValue = normalizeCapacity(n);
  }

 /**
 * 中止池:拒绝全部排队者(ABORTED),此后 acquire 一律拒绝;在飞座位不受影响(照常 release)。
 * 重复调用保留首次原因(第一次中止才是真正原因)。
 */
  abortAll(reason = "aborted"): void {
    const why = String(reason || "aborted");
    if (!this.aborted) {
      this.aborted = true;
      this.abortReason = why;
    }
    const queued = this.queue.splice(0, this.queue.length);
    for (const entry of queued) {
      entry.onAbort?.(); // 先摘 signal 监听再拒绝,避免 abort 事件二次结算
      entry.onAbort = undefined;
      entry.reject(new SeatError("ABORTED", `座位池已中止(${why})`));
    }
  }

  stats(): SeatPoolStats {
    return {
      capacity: this.capacityValue,
      inUse: this.seats.size,
      parked: this.queue.length,
      totalAcquired: this.totalAcquired,
      totalParked: this.totalParked,
    };
  }

 /** 发座:登记在飞并累计发放数(只由 acquire 立即路径与 pump 调用)。 */
  private grant(ownerId: string): Seat {
    const seatId = `seat-${++this.seq}`;
    this.seats.set(seatId, { ownerId, grantedAt: this.now() });
    this.totalAcquired++;
    return { seatId, ownerId };
  }

 /** 按 FIFO 补齐空位:先摘 signal 监听再 resolve,保证拿到座位的不会再被 abort 事件二次拒绝。 */
  private pump(): Seat | undefined {
    let granted: Seat | undefined;
    while (this.seats.size < this.capacityValue && this.queue.length > 0) {
      const head = this.queue.shift();
      if (!head) break;
      head.onAbort?.();
      head.onAbort = undefined;
      const seat = this.grant(head.ownerId);
      seat.queuedMs = Math.max(0, this.now() - head.parkedAt);
      head.resolve(seat);
      if (!granted) granted = seat;
    }
    return granted;
  }
}
