/**
 * 持久效果队列(stored work)。
 * 问题:relay/launch/delivery/reply 等外部副作用内联执行——进程崩在发送途中就永久丢;
 * 重试没有账本会重复;同类副作用并发执行丢顺序;失败没有健康面。
 * 本模块只做「效果账本 + 调度」这一层:
 *   1) 每个外部动作在事务内先落 effect.enqueued(append + flushStrict 成功后才允许执行);
 *   2) 同 kind 内 oldest-first,后一条必须等前一条 done/deferred/失败退避到期(同类保序);
 *   3) 每 kind 一个 handler,并发上限(缺省 1);失败指数退避;later(ms) 只延后不算失败;
 *   4) 连续失败进 health(degraded),成功一次清零;drain 停取新并保住 pending。
 * 持久面只有 journal(唯一真源):
 *   effect.enqueued {id,kind,key,payload,at,attempts:0,nextAt}
 *   effect.replaced {id,payload,at}                    同 kind+key 等待中:替换 payload、nextAt=now、保 id/顺序
 *   effect.done     {id}
 *   effect.failed   {id,attempts,nextAt,error}
 *   effect.deferred {id,nextAt}
 *   effect.health   {kind,status:"ok"|"degraded",consecutiveFailures}
 * 冷恢复 = foldEffectQueue(readAll 的 effect.* 事件):done 丢弃,replaced/failed/deferred 覆盖,其余保序。
 * 语义边角(与本仓其它模块一致):
 * - 无 sessionId 的 effect 事件落 global.jsonl(sharded journal 的「无 sessionId 兜底」),热窗下恒常驻;
 * - relay 未启用/不可用 → handler 直接返回成功(效果=无外部面),不记失败、不拖 health;
 * - drain 后仍接受 enqueue(先把账落下),但不再调度;重启由 fold 恢复。
 */
import type { Journal } from "@lampgenie/core";

/** effect 事件的 kind 全集(唯一持久面)。 */
export type EffectJournalKind =
  | "effect.enqueued"
  | "effect.replaced"
  | "effect.done"
  | "effect.failed"
  | "effect.deferred"
  | "effect.health";

export interface EffectEnqueuedPayload {
  id: string;
  kind: string;
  key: string;
  payload: unknown;
  at: number;
  attempts: number;
  nextAt: number;
}

export interface EffectReplacedPayload {
  id: string;
  payload: unknown;
  at: number;
}

export interface EffectFailedPayload {
  id: string;
  attempts: number;
  nextAt: number;
  error: string;
}

export interface EffectDeferredPayload {
  id: string;
  nextAt: number;
}

export interface EffectHealthPayload {
  kind: string;
  status: "ok" | "degraded";
  consecutiveFailures: number;
}

/** 折叠后的待执行效果(冷恢复产物;保持原入队顺序)。 */
export interface FoldedEffect {
  id: string;
  kind: string;
  key: string;
  payload: unknown;
  at: number;
  attempts: number;
  nextAt: number;
}

/** 对外可见的 pending 行(观察/测试面)。 */
export interface EffectPendingRow {
  id: string;
  kind: string;
  key: string;
  attempts: number;
  nextAt: number;
  inflight: boolean;
}

export interface EffectHealthRow {
  kind: string;
  status: "ok" | "degraded";
  consecutiveFailures: number;
}

export interface EffectHandlerCtx {
  id: string;
  /** 本次执行的尝试序号(1-based;deferred 重试不增加 attempts,所以仍是 1)。 */
  attempt: number;
  /** 只延后,不算失败:下次在 nextAt=now+ms 再跑(同 kind 后续行等待)。 */
  later(ms: number): void;
}

export type EffectHandler = (payload: unknown, ctx: EffectHandlerCtx) => void | Promise<void>;

/** 持久化面:真 Journal 直接可用;测试可注入假 journal(append/readAll/flushStrict 三件)。 */
export type EffectJournalLike = Pick<Journal, "append" | "readAll"> & {
  flushStrict?: () => void | Promise<void>;
};

export interface EffectQueueOptions {
  journal: EffectJournalLike;
  /** 时钟(缺省 Date.now;测试注入假时钟)。 */
  now?: () => number;
  /** 等待原语(缺省 setTimeout;测试注入「推进假时钟」的立即返回实现)。 */
  sleep?: (ms: number) => Promise<void>;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  /** 每次 journal 写入后的旁路钩子(计数/观测;失败不影响队列)。 */
  persist?: (event: { kind: string; payload: unknown }) => void | Promise<void>;
  /** 冷恢复种子;缺省 = 自读 journal.readAll() 折叠。 */
  seed?: readonly FoldedEffect[];
}

export interface EffectQueue {
  enqueue(input: { kind: string; key: string; payload: unknown }): Promise<{ id: string; deduped: boolean }>;
  register(kind: string, handler: EffectHandler, opts?: { concurrency?: number }): void;
  start(): void;
  /** 停止取新 + await 在飞;pending(nextAt 未到也算)原样保留。 */
  drain(): Promise<void>;
  pending(): EffectPendingRow[];
  /** 当前没有在飞执行,且没有到期可跑的行。 */
  idle(): boolean;
  health(): EffectHealthRow[];
}

export const DEFAULT_BASE_DELAY_MS = 1000;
export const DEFAULT_MAX_DELAY_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

interface Row extends FoldedEffect {
  state: "waiting" | "inflight" | "done";
}

interface Registration {
  handler: EffectHandler;
  concurrency: number;
}

/** 折叠 effect.* 事件流 → 待执行效果(保持入队顺序;done 丢弃)。 */
export function foldEffectQueue(
  events: readonly { kind: string; payload: unknown }[],
): FoldedEffect[] {
  const rows = new Map<string, FoldedEffect>();
  for (const ev of events) {
    const p = ev.payload as Record<string, unknown> | null | undefined;
    if (!p || typeof p !== "object" || typeof p.id !== "string") continue;
    const id = p.id;
    switch (ev.kind) {
      case "effect.enqueued": {
        if (rows.has(id)) break;
        const at = typeof p.at === "number" ? p.at : 0;
        rows.set(id, {
          id,
          kind: typeof p.kind === "string" ? p.kind : "",
          key: typeof p.key === "string" ? p.key : "",
          payload: p.payload,
          at,
          attempts: typeof p.attempts === "number" ? p.attempts : 0,
          nextAt: typeof p.nextAt === "number" ? p.nextAt : at,
        });
        break;
      }
      case "effect.replaced": {
        const row = rows.get(id);
        if (!row) break;
        row.payload = p.payload;
        if (typeof p.at === "number") row.nextAt = p.at;
        break;
      }
      case "effect.failed": {
        const row = rows.get(id);
        if (!row) break;
        if (typeof p.attempts === "number") row.attempts = p.attempts;
        if (typeof p.nextAt === "number") row.nextAt = p.nextAt;
        break;
      }
      case "effect.deferred": {
        const row = rows.get(id);
        if (!row) break;
        if (typeof p.nextAt === "number") row.nextAt = p.nextAt;
        break;
      }
      case "effect.done":
        rows.delete(id);
        break;
      default:
        break;
    }
  }
  return [...rows.values()];
}

class EffectQueueImpl implements EffectQueue {
  private readonly journal: EffectJournalLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;
  private readonly persist?: EffectQueueOptions["persist"];
  private readonly rows: Row[] = [];
  private readonly byId = new Map<string, Row>();
  private readonly registrations = new Map<string, Registration>();
  private readonly healthByKind = new Map<string, { status: "ok" | "degraded"; consecutiveFailures: number }>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private started = false;
  private draining = false;
  private wakePending = false;
  private wakeToken = 0;
  private idSeq = 0;

  constructor(opts: EffectQueueOptions) {
    this.journal = opts.journal;
    this.now = opts.now ?? (() => Date.now());
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.persist = opts.persist;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      (timer as { unref?: () => void }).unref?.();
      this.timers.add(timer);
    }));
    const seed = opts.seed ?? foldEffectQueue(this.journal.readAll());
    for (const item of seed) this.restore(item);
  }

  private restore(item: FoldedEffect): void {
    if (this.byId.has(item.id)) return;
    const row: Row = { ...item, state: "waiting" };
    this.rows.push(row);
    this.byId.set(row.id, row);
    const m = /^ef-(\d+)$/.exec(item.id);
    if (m) this.idSeq = Math.max(this.idSeq, Number(m[1]));
  }

  register(kind: string, handler: EffectHandler, opts?: { concurrency?: number }): void {
    const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? 1));
    this.registrations.set(kind, { handler, concurrency });
  }

  start(): void {
    if (this.started) return;
    this.draining = false;
    this.started = true;
    this.pump();
  }

  async enqueue(input: { kind: string; key: string; payload: unknown }): Promise<{ id: string; deduped: boolean }> {
    const at = this.now();
    // 同 kind+key 仍在等待(未 done、未用尽重试)→ 替换 payload、立即到期、保 id/队列位置。
    const waiting = this.rows.find(
      (r) => r.kind === input.kind && r.key === input.key && r.state === "waiting" && r.attempts < this.maxAttempts);
    if (waiting) {
      waiting.payload = input.payload;
      waiting.nextAt = at;
      await this.write("effect.replaced", { id: waiting.id, payload: input.payload, at } satisfies EffectReplacedPayload);
      this.pump();
      return { id: waiting.id, deduped: true };
    }
    const id = `ef-${++this.idSeq}`;
    const row: Row = {
      id,
      kind: input.kind,
      key: input.key,
      payload: input.payload,
      at,
      attempts: 0,
      nextAt: at,
      state: "waiting",
    };
    this.rows.push(row);
    this.byId.set(id, row);
    // 先落账,flushStrict 成功后才可能被 pump 取到(enqueue 返回 = commit 完成)。
    await this.write("effect.enqueued", {
      id, kind: row.kind, key: row.key, payload: row.payload, at, attempts: 0, nextAt: at,
    } satisfies EffectEnqueuedPayload);
    this.pump();
    return { id, deduped: false };
  }

  async drain(): Promise<void> {
    this.draining = true;
    this.started = false;
    this.wakeToken += 1;
    this.wakePending = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([...this.inflight]);
  }

  pending(): EffectPendingRow[] {
    return this.rows
      .filter((r) => r.state !== "done")
      .map((r) => ({ id: r.id, kind: r.kind, key: r.key, attempts: r.attempts, nextAt: r.nextAt, inflight: r.state === "inflight" }));
  }

  idle(): boolean {
    if (this.inflight.size > 0) return false;
    // 未启动/已 drain = 不会再推进;运行中则还要求没有到期可跑的行。
    if (!this.started || this.draining) return true;
    const now = this.now();
    return !this.rows.some((r) => r.state === "waiting" && r.attempts < this.maxAttempts && r.nextAt <= now);
  }

  health(): EffectHealthRow[] {
    return [...this.healthByKind.entries()].map(([kind, h]) => ({ kind, ...h }));
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private async write(kind: EffectJournalKind, payload: unknown): Promise<void> {
    this.journal.append({ kind, sessionId: "", payload });
    const flush = this.journal.flushStrict;
    if (flush) await flush.call(this.journal);
    if (this.persist) {
      try { await this.persist({ kind, payload }); } catch { /* 观测面失败不影响队列 */ }
    }
  }

  private healthOf(kind: string): { status: "ok" | "degraded"; consecutiveFailures: number } {
    let h = this.healthByKind.get(kind);
    if (!h) {
      h = { status: "ok", consecutiveFailures: 0 };
      this.healthByKind.set(kind, h);
    }
    return h;
  }

  /** 同步派发:每 kind oldest-first,首条未来到期(deferred/退避)占位阻塞同 kind 后续。 */
  private pump(): void {
    if (!this.started || this.draining) return;
    for (const [kind, reg] of this.registrations) {
      let inflightCount = 0;
      for (const row of this.rows) if (row.kind === kind && row.state === "inflight") inflightCount += 1;
      let slots = reg.concurrency - inflightCount;
      if (slots <= 0) continue;
      const now = this.now();
      for (const row of this.rows) {
        if (row.kind !== kind) continue;
        if (row.state !== "waiting") continue;
        if (row.attempts >= this.maxAttempts) continue;
        if (row.nextAt > now) break; // 同类保序:未到期行占位,后续等待
        if (slots <= 0) break;
        slots -= 1;
        this.run(row, reg.handler);
      }
    }
    this.scheduleWake();
  }

  /** 最近一个未来到期行 → sleep 到点再 pump(无未来行则不挂定时器)。 */
  private scheduleWake(): void {
    if (!this.started || this.draining || this.wakePending) return;
    // 同类保序:只看每个 kind 链首的可调度行(后续行被链首阻塞,它们更近的 nextAt 不算数)。
    let nextAt = Number.POSITIVE_INFINITY;
    for (const kind of this.registrations.keys()) {
      for (const row of this.rows) {
        if (row.kind !== kind) continue;
        if (row.state === "done" || row.state === "inflight") continue;
        if (row.attempts >= this.maxAttempts) continue;
        if (row.nextAt < nextAt) nextAt = row.nextAt;
        break;
      }
    }
    if (!Number.isFinite(nextAt)) return;
    const delay = nextAt - this.now();
    if (delay <= 0) return; // 已到期但被并发上限挡住:由在飞完成后的 pump 接手
    this.wakePending = true;
    const token = ++this.wakeToken;
    void this.sleep(delay).then(() => {
      if (token !== this.wakeToken || !this.started || this.draining) return;
      this.wakePending = false;
      this.pump();
    });
  }

  private run(row: Row, handler: EffectHandler): void {
    row.state = "inflight";
    let deferredMs: number | null = null;
    const ctx: EffectHandlerCtx = {
      id: row.id,
      attempt: row.attempts + 1,
      later: (ms: number) => {
        const n = Number(ms);
        deferredMs = Number.isFinite(n) && n > 0 ? n : 0;
      },
    };
    const holder: { task?: Promise<void> } = {};
    const task = (async () => {
      try {
        await handler(row.payload, ctx);
        const now = this.now();
        if (deferredMs !== null) {
          row.state = "waiting";
          row.nextAt = now + deferredMs;
          await this.write("effect.deferred", { id: row.id, nextAt: row.nextAt } satisfies EffectDeferredPayload);
        } else {
          row.state = "done";
          await this.write("effect.done", { id: row.id });
          const h = this.healthOf(row.kind);
          if (h.consecutiveFailures > 0 || h.status !== "ok") {
            h.consecutiveFailures = 0;
            h.status = "ok";
            await this.write("effect.health", { kind: row.kind, status: "ok", consecutiveFailures: 0 } satisfies EffectHealthPayload);
          }
        }
      } catch (err) {
        row.attempts += 1;
        row.state = "waiting";
        const delay = Math.min(this.baseDelayMs * 2 ** (row.attempts - 1), this.maxDelayMs);
        row.nextAt = this.now() + delay;
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        await this.write("effect.failed", {
          id: row.id, attempts: row.attempts, nextAt: row.nextAt, error: message,
        } satisfies EffectFailedPayload);
        const h = this.healthOf(row.kind);
        h.consecutiveFailures += 1;
        if (h.consecutiveFailures >= this.maxAttempts && h.status !== "degraded") {
          h.status = "degraded";
          await this.write("effect.health", {
            kind: row.kind, status: "degraded", consecutiveFailures: h.consecutiveFailures,
          } satisfies EffectHealthPayload);
        }
      } finally {
        if (holder.task) this.inflight.delete(holder.task);
        this.pump();
      }
    })();
    holder.task = task;
    this.inflight.add(task);
  }
}

export function createEffectQueue(opts: EffectQueueOptions): EffectQueue {
  return new EffectQueueImpl(opts);
}

// ── team 活动推送接线(单一真实外部副作用)─────────────────────────────────

export interface TeamActivityPayload {
  projectId: string;
  category: string;
  type: string;
  summary: string;
}

export type TeamActivitySink = {
  notifyActivity(projectId: string, category: string, type: string, summary: string): void;
};

/**
 * relay.activity 的 handler 工厂:执行时才解析 sink(__teamView 由 main.ts 在 app 之后装配)。
 * 无 sink(team 关闭/relay 不可用)= 直接成功:效果就是「无外部面」,不算失败、不拖 health。
 */
export function relayActivityHandler(getSink: () => TeamActivitySink | undefined): EffectHandler {
  return (payload) => {
    const sink = getSink();
    if (!sink) return;
    const p = (payload ?? {}) as Partial<TeamActivityPayload>;
    sink.notifyActivity(
      typeof p.projectId === "string" ? p.projectId : "",
      typeof p.category === "string" ? p.category : "task",
      typeof p.type === "string" ? p.type : "",
      String(p.summary ?? ""),
    );
  };
}
