/**
 * LLM 请求在飞上限(派发失败根因配套)。
 * 注意:10 路子代理同时首调智谱 anthropic 端点 → 8 路 `TypeError: fetch failed`
 * (cause=ConnectTimeoutError, connect timeout 10s);同 Key 低并发(3/6)全部 200。
 * 端点/链路吃不住瞬间建连洪峰,而既有 workflow governor 的 observer 是「立即放行、
 * 只记 inFlight」——不排队,起不到限制作用。
 * 这里按端点(baseUrl)做进程级信号量:每个 providerKey 最多 cap 个真实在飞请求,
 * 其余排队(取消信号可出队)。原始 governor admission 仍被保留用于 AIMD 观测。
 */
import type {
  RequestAdmission,
  AdmissionTicket,
} from "@lampgenie/runtime/concurrency/admission";

const DEFAULT_CAP = 2;
const MAX_CAP = 64;

/** 解析在飞上限:GENIE_LLM_MAX_INFLIGHT,缺省 2;`0`/`off`=不限(回退 governor observer)。
 * 缺省取 2 的经验证依据:该端点对**新建 TCP 连接**的突发很敏感——顺序请求 8/8 成功,
 * 并发 4 已出现 UND_ERR_CONNECT_TIMEOUT,并发 8 时 4 路超时;连接建成后 keep-alive
 * 复用则稳定。信号量把小规模建连摊开,后续请求复用连接池。 */
export function resolveInflightCap(raw: string | undefined = process.env.GENIE_LLM_MAX_INFLIGHT): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CAP;
  const t = raw.trim().toLowerCase();
  if (t === "0" || t === "off" || t === "false") return 0;
  const n = Math.floor(Number(t));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CAP;
  return Math.min(n, MAX_CAP);
}

interface Waiter {
  resolve: (ticket: AdmissionTicket) => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** 极简 FIFO 信号量(ticket.release 幂等)。 */
export class InflightSemaphore {
  #active = 0;
  readonly #waiters: Waiter[] = [];
  constructor(private readonly cap: number) {}

  get active(): number { return this.#active; }
  get queued(): number { return this.#waiters.length; }
  get capacity(): number { return this.cap; }

  take(signal?: AbortSignal): Promise<AdmissionTicket> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.#active < this.cap && this.#waiters.length === 0) return Promise.resolve(this.#grant());
    return new Promise<AdmissionTicket>((resolve, reject) => {
      const w: Waiter = { resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          const i = this.#waiters.indexOf(w);
          if (i >= 0) this.#waiters.splice(i, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", w.onAbort, { once: true });
      }
      this.#waiters.push(w);
    });
  }

  #grant(): AdmissionTicket {
    this.#active++;
    let released = false;
    return {
      emit: () => { /* 状态事件由 governor observer ticket 承接 */ },
      release: () => {
        if (released) return;
        released = true;
        this.#active--;
        this.#drain();
      },
    };
  }

  #drain(): void {
    while (this.#active < this.cap && this.#waiters.length > 0) {
      const w = this.#waiters.shift()!;
      if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
      if (w.signal?.aborted) { w.reject(abortReason(w.signal)); continue; }
      w.resolve(this.#grant());
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new Error("llm request admission aborted");
}

/**
 * 组合 admission:先排队拿在飞槽,再向原 observer 取观测票据(AIMD 信号源不丢);
 * 释放时两者一起归还。
 */
export function composeInflightAdmission(
  limiter: InflightSemaphore | undefined,
  observer: RequestAdmission | undefined): RequestAdmission | undefined {
  if (!limiter) return observer;
  if (!observer) return { async take(input) { return limiter.take(input.signal); } };
  return {
    async take(input) {
      const slot = await limiter.take(input.signal);
      let inner: AdmissionTicket;
      try {
        inner = await observer.take(input);
      } catch (err) {
        slot.release();
        throw err;
      }
      return {
        emit: (e) => inner.emit(e),
        ...(inner.emitFailure ? { emitFailure: (e, err) => inner.emitFailure!(e, err) } : {}),
        release: () => {
          inner.release();
          slot.release();
        },
      };
    },
  };
}

const limiters = new Map<string, InflightSemaphore>();
const composed = new Map<string, RequestAdmission>();

/** 每个端点一个信号量(同 baseUrl 的主/角色/子代理共享配额)。cap<=0=不限。 */
export function inflightAdmissionFor(
  endpointKey: string,
  observer: RequestAdmission | undefined,
  cap: number = resolveInflightCap(),
): RequestAdmission | undefined {
  const key = endpointKey.replace(/\/+$/, "");
  if (cap <= 0) return observer;
  const cached = composed.get(key);
  if (cached) return cached;
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = new InflightSemaphore(cap);
    limiters.set(key, limiter);
  }
  const admission = composeInflightAdmission(limiter, observer)!;
  composed.set(key, admission);
  return admission;
}

/** 观测面(测试/状态展示):当前在飞与排队数。 */
export function inflightStats(endpointKey: string): { active: number; queued: number; cap: number } | undefined {
  const l = limiters.get(endpointKey.replace(/\/+$/, ""));
  if (!l) return undefined;
  return { active: l.active, queued: l.queued, cap: l.capacity };
}