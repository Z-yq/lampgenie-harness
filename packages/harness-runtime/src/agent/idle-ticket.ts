/**
 * 闲时算力票据(纯逻辑,零 IO,2026-11 #175)。
 *
 * 为什么需要它:可延后的活(夜间 RSI、批量分析、整理归因)不该挤占交互额度,
 * 也不该因为客户端重试/重复提交被派发多次。于是把「这次闲时执行」抽象成一张票据:
 * 先把票据拿到手(ticket),再落库排期;票据状态机由本模块唯一裁决,调用方只读结论。
 *
 * 双轴:
 * - localStatus(本地/展示轴):queued → schedulable → running → done | failed。
 * - ticketStatus(外部票据轴):queued → ready(带 deadline) → active → expired。
 * 只有 ticketStatus==="ready" 才允许被调度(claim);local 轴只用于展示,不得越权
 * (见 dualAxis:local 显示 schedulable 而票据已过期时,判定仍为不可调度)。
 *
 * 关键不变量:
 * 1. 同会话只允许一个 pending 票据(queued/ready/active 且未结算)。重复提交 = PENDING_EXISTS。
 * 2. 额度不足 = QUOTA_EXHAUSTED,且**不落库**(拒绝前不产生任何副作用)。
 * 3. claim 是原子 CAS:只有 ready 且未过 deadline 才能 → active;过 deadline 的 ready 就地转 expired。
 * 4. settle:ok/4xx 终态(4xx 幂等 ack,重复 ack 不再改状态);5xx 保持 active 等重试(RETRY_PENDING)。
 * 5. reclaimStale:active 超过 maxActiveMs 未结算 → 首次回 queued,再次 → failed(收口)。
 * 6. continueExpired 只能手动触发:仅 expired 且本地仍 queued 的票可续一张新票。
 *
 * 依赖纪律:零 import(不读文件/环境/网络/时间),所有导出函数不 throw;
 * 非法入参折叠成 IDLE_INVALID,状态不允许折叠成 IDLE_NOT_SCHEDULABLE / IDLE_INVALID。
 * 码表顺序固定(便于自动化按码断言)。
 */

/** 票据账本 schema 版本:字段语义变化时递增。 */
export const IDLE_TICKET_VERSION = 1;

/** 稳定码:票据状态机的全部判断结论(字符串常量,便于落盘与断言)。 */
export const IDLE_INVALID = "IDLE_INVALID" as const;
export const IDLE_CREATED = "IDLE_CREATED" as const;
export const IDLE_PENDING_EXISTS = "IDLE_PENDING_EXISTS" as const;
export const IDLE_QUOTA_EXHAUSTED = "IDLE_QUOTA_EXHAUSTED" as const;
export const IDLE_READY = "IDLE_READY" as const;
export const IDLE_CLAIMED = "IDLE_CLAIMED" as const;
export const IDLE_NOT_SCHEDULABLE = "IDLE_NOT_SCHEDULABLE" as const;
export const IDLE_EXPIRED = "IDLE_EXPIRED" as const;
export const IDLE_SETTLED = "IDLE_SETTLED" as const;
export const IDLE_RETRY_PENDING = "IDLE_RETRY_PENDING" as const;
export const IDLE_RECLAIMED = "IDLE_RECLAIMED" as const;
export const IDLE_CONTINUED = "IDLE_CONTINUED" as const;
export const IDLE_POLL_WAIT = "IDLE_POLL_WAIT" as const;
export const IDLE_POLL_DUE = "IDLE_POLL_DUE" as const;
export const IDLE_DISPATCH_REJECTED = "IDLE_DISPATCH_REJECTED" as const;

/** 全部稳定码(固定顺序)。 */
export const IDLE_CODES = [
  IDLE_INVALID,
  IDLE_CREATED,
  IDLE_PENDING_EXISTS,
  IDLE_QUOTA_EXHAUSTED,
  IDLE_READY,
  IDLE_CLAIMED,
  IDLE_NOT_SCHEDULABLE,
  IDLE_EXPIRED,
  IDLE_SETTLED,
  IDLE_RETRY_PENDING,
  IDLE_RECLAIMED,
  IDLE_CONTINUED,
  IDLE_POLL_WAIT,
  IDLE_POLL_DUE,
  IDLE_DISPATCH_REJECTED,
] as const;

export type IdleCode = (typeof IDLE_CODES)[number];

/** 本地/展示轴。 */
export const LOCAL_STATUSES = ["queued", "schedulable", "running", "done", "failed"] as const;
export type LocalStatus = (typeof LOCAL_STATUSES)[number];

/** 外部票据轴。 */
export const TICKET_STATUSES = ["queued", "ready", "active", "expired"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** 结算结果:ok=成功;4xx=永久失败(幂等 ack);5xx=临时失败(留待重试,不算终态)。 */
export const SETTLE_OUTCOMES = ["ok", "4xx", "5xx"] as const;
export type SettleOutcome = (typeof SETTLE_OUTCOMES)[number];

/** 轮询间隔下界(不足 5s 不轮)。 */
export const IDLE_POLL_MIN_MS = 5_000;
/** 轮询间隔上界(超过 5min 视为过点,立即 poll)。 */
export const IDLE_POLL_MAX_MS = 300_000;
/** ready 缺省存活期(10min):票变 ready 后 10min 内没人认领就过期。 */
export const IDLE_DEFAULT_READY_DEADLINE_MS = 600_000;
/** active 缺省租期(10min):认领后 10min 未结算即可回收。 */
export const IDLE_DEFAULT_MAX_ACTIVE_MS = 600_000;

/** pending = 仍占用本会话闲时名额。终态(done/failed/已结算)与 expired 都不算。 */
export function isPending(ticket: IdleTicket): boolean {
  if (ticket.settledAt !== undefined) return false;
  if (ticket.localStatus === "done" || ticket.localStatus === "failed") return false;
  return ticket.ticketStatus === "queued" || ticket.ticketStatus === "ready" || ticket.ticketStatus === "active";
}

/** 一张闲时票据。 */
export interface IdleTicket {
  /** 票据 id(全局唯一)。 */
  id: string;
  /** 所属会话:同会话同时只允许一张 pending。 */
  sessionId: string;
  /** 本地/展示轴(不参与调度裁决)。 */
  localStatus: LocalStatus;
  /** 外部票据轴(调度裁决只看它)。 */
  ticketStatus: TicketStatus;
  /** ready 的最晚被认领时刻(epoch ms)。 */
  readyDeadline?: number;
  /** 被认领(active)的时刻。 */
  claimedAt?: number;
  /** 终态结算时刻;undefined 表示尚未结算。 */
  settledAt?: number;
  /** 结算结果;5xx 不写(留待重试)。 */
  outcome?: SettleOutcome;
  /** 创建时刻。 */
  createdAt: number;
  /** 最近一次变更时刻。 */
  updatedAt: number;
  /** 变更序号:每次状态变更 +1(便于断言状态确实推进过一次)。 */
  revision: number;
  /** 5xx 重试计数(每次 5xx 结算 +1;不参与回收判定)。 */
  attempts: number;
  /** 被回收的次数(与 5xx 重试计数 attempts 分开:重试过不代表回收过)。 */
  reclaims?: number;
  /** 由哪张 expired 票手动续来。 */
  continuedFrom?: string;
  /** 回收自哪张 active 票。 */
  recoveredFrom?: string;
}

/** 票据账本:扁平 id 索引 + 会话索引(会话内按创建顺序保序)。 */
export interface TicketStore {
  tickets: Record<string, IdleTicket>;
  bySession: Record<string, string[]>;
}

/** 操作结果:码 + 变更后票据 + 变更前快照 + 细节。 */
export interface TicketResult {
  ok: boolean;
  code: IdleCode;
  ticket?: IdleTicket;
  prev?: IdleTicket;
  detail?: Record<string, unknown>;
}

/** 空账本。 */
export function emptyTicketStore(): TicketStore {
  return { tickets: {}, bySession: {} };
}

/** 深拷贝一张票据(返回给调用方的一律是副本,避免外部改内部状态)。 */
export function cloneTicket(ticket: IdleTicket): IdleTicket {
  return { ...ticket };
}

/** 会话待定票据(按创建顺序)。 */
export function pendingOf(store: TicketStore, sessionId: string): IdleTicket[] {
  const ids = store.bySession[sessionId] ?? [];
  const out: IdleTicket[] = [];
  for (const id of ids) {
    const ticket = store.tickets[id];
    if (ticket !== undefined && isPending(ticket)) out.push(cloneTicket(ticket));
  }
  return out;
}

/**
 * 双轴合成:schedulable 只由「票据轴已 ready」决定。
 * localStatus 为 schedulable 但票据已 expired 时判不可调度(local 轴不越权)。
 * local 仍是 queued 而票据已 ready 时宽容放行(展示层尚未同步)。
 */
export function dualAxis(ticket: IdleTicket): { schedulable: boolean; reason: string } {
  if (ticket.ticketStatus !== "ready") return { schedulable: false, reason: `ticket-${ticket.ticketStatus}` };
  if (ticket.settledAt !== undefined) return { schedulable: false, reason: "settled" };
  if (ticket.localStatus === "queued" || ticket.localStatus === "schedulable") {
    return { schedulable: true, reason: "ready" };
  }
  return { schedulable: false, reason: `local-${ticket.localStatus}` };
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function invalid(detail: Record<string, unknown>): TicketResult {
  return { ok: false, code: IDLE_INVALID, detail };
}

function reject(code: IdleCode, ticket: IdleTicket | undefined, detail: Record<string, unknown>): TicketResult {
  return { ok: false, code, ticket: ticket === undefined ? undefined : cloneTicket(ticket), detail };
}

function accept(code: IdleCode, prev: IdleTicket | undefined, ticket: IdleTicket, detail?: Record<string, unknown>): TicketResult {
  return {
    ok: true,
    code,
    prev: prev === undefined ? undefined : cloneTicket(prev),
    ticket: cloneTicket(ticket),
    detail,
  };
}

/** 写入一张新票据到索引(内部用)。 */
function insertTicket(store: TicketStore, ticket: IdleTicket): void {
  store.tickets[ticket.id] = ticket;
  const bucket = store.bySession[ticket.sessionId];
  if (bucket === undefined) store.bySession[ticket.sessionId] = [ticket.id];
  else bucket.push(ticket.id);
}

/** 状态迁移:原地替换为副本并推进 revision/updatedAt。 */
function transition(store: TicketStore, prev: IdleTicket, now: number, patch: Partial<IdleTicket>): IdleTicket {
  const next: IdleTicket = {
    ...prev,
    ...patch,
    revision: prev.revision + 1,
    updatedAt: now,
  };
  store.tickets[prev.id] = next;
  return next;
}

/** 缺省 id:`idle-<session>-<n>`,n 从会话票据数递增并跳过撞号。 */
function nextId(store: TicketStore, sessionId: string): string {
  const base = sessionId.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 24) || "s";
  let n = (store.bySession[sessionId]?.length ?? 0) + 1;
  let candidate = `idle-${base}-${n}`;
  while (store.tickets[candidate] !== undefined) {
    n += 1;
    candidate = `idle-${base}-${n}`;
  }
  return candidate;
}

/** createTicket 入参。 */
export interface CreateTicketOptions {
  sessionId: string;
  now: number;
  /** 额度是否充足(缺省 true)。false = QUOTA_EXHAUSTED 且不落库。 */
  budgetOk?: boolean;
  /** 显式 id(测试/迁移用);缺省按会话序号生成。 */
  id?: string;
}

/**
 * 先取票、再落库的第一步:创建一张 queued 票据。
 * 拒绝顺序:非法入参 → 额度不足(不落库) → 同会话 pending 已存在。
 */
export function createTicket(store: TicketStore, opts: CreateTicketOptions): TicketResult {
  if (store === undefined || store === null || typeof store !== "object") return invalid({ reason: "store" });
  if (opts === undefined || opts === null) return invalid({ reason: "opts" });
  const sessionId = typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
  if (sessionId === "" || sessionId.length > 128) return invalid({ reason: "sessionId" });
  if (!isFiniteNonNegative(opts.now)) return invalid({ reason: "now" });
  const now = opts.now;

  // 额度不足:先拒,绝不落库(不留半张票)。
  if (opts.budgetOk === false) return reject(IDLE_QUOTA_EXHAUSTED, undefined, { sessionId });

  const pending = pendingOf(store, sessionId);
  if (pending.length > 0) {
    return reject(IDLE_PENDING_EXISTS, undefined, { sessionId, pendingIds: pending.map((t) => t.id) });
  }

  const explicitId = typeof opts.id === "string" ? opts.id.trim() : "";
  const id = explicitId !== "" ? explicitId : nextId(store, sessionId);
  if (!isNonEmptyId(id)) return invalid({ reason: "id" });
  if (store.tickets[id] !== undefined) return invalid({ reason: "duplicate-id", id });

  const ticket: IdleTicket = {
    id,
    sessionId,
    localStatus: "queued",
    ticketStatus: "queued",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    attempts: 0,
  };
  insertTicket(store, ticket);
  return accept(IDLE_CREATED, undefined, ticket, { sessionId });
}

/** makeReady 入参:queued → ready 并挂 deadline。 */
export interface MakeReadyOptions {
  id: string;
  now: number;
  deadlineMs?: number;
}

/**
 * 票据就绪:queued → ready + deadline(缺省 10min)。
 * 已 ready 且未过期时幂等返回 READY(idempotent=true,不刷新 deadline —— 重复 ready 不得延长存活期)。
 */
export function makeReady(store: TicketStore, opts: MakeReadyOptions): TicketResult {
  if (store === undefined || store === null) return invalid({ reason: "store" });
  if (opts === undefined || opts === null || !isNonEmptyId(opts.id)) return invalid({ reason: "id" });
  if (!isFiniteNonNegative(opts.now)) return invalid({ reason: "now" });
  const { id, now } = opts;
  const prev = store.tickets[id];
  if (prev === undefined) return invalid({ reason: "not-found", id });
  if (prev.ticketStatus === "expired") return reject(IDLE_NOT_SCHEDULABLE, prev, { reason: "expired" });
  if (prev.ticketStatus === "ready") {
    if (prev.readyDeadline !== undefined && now > prev.readyDeadline) {
      const expired = transition(store, prev, now, { ticketStatus: "expired", localStatus: "queued" });
      return reject(IDLE_EXPIRED, expired, { reason: "deadline-passed" });
    }
    return accept(IDLE_READY, prev, prev, { idempotent: true });
  }
  if (prev.ticketStatus !== "queued") return reject(IDLE_NOT_SCHEDULABLE, prev, { status: prev.ticketStatus });
  if (prev.localStatus !== "queued") return reject(IDLE_NOT_SCHEDULABLE, prev, { localStatus: prev.localStatus });

  const deadlineMs = isFiniteNonNegative(opts.deadlineMs) && opts.deadlineMs > 0 ? opts.deadlineMs : IDLE_DEFAULT_READY_DEADLINE_MS;
  const next = transition(store, prev, now, {
    ticketStatus: "ready",
    localStatus: "schedulable",
    readyDeadline: now + deadlineMs,
  });
  return accept(IDLE_READY, prev, next, { readyDeadline: next.readyDeadline });
}

/** claim 入参。 */
export interface ClaimOptions {
  id: string;
  now: number;
  /** 可选 CAS 期望版本:与当前 revision 不符则拒(防并发写者互相覆盖)。 */
  expectRevision?: number;
}

/**
 * 认领(原子 CAS):只有 ready 且未过 deadline 才能 → active。
 * - 过 deadline 的 ready:就地转 expired,返回 EXPIRED(fail-closed,不放过期票)。
 * - queued / expired / 已结算:NOT_SCHEDULABLE(明确不是「暂时不可用」而是「状态错」)。
 */
export function claim(store: TicketStore, opts: ClaimOptions): TicketResult {
  if (store === undefined || store === null) return invalid({ reason: "store" });
  if (opts === undefined || opts === null || !isNonEmptyId(opts.id)) return invalid({ reason: "id" });
  if (!isFiniteNonNegative(opts.now)) return invalid({ reason: "now" });
  const { id, now } = opts;
  const prev = store.tickets[id];
  if (prev === undefined) return invalid({ reason: "not-found", id });
  if (opts.expectRevision !== undefined && opts.expectRevision !== prev.revision) {
    return reject(IDLE_NOT_SCHEDULABLE, prev, { reason: "revision-mismatch", expected: opts.expectRevision, actual: prev.revision });
  }
  if (prev.settledAt !== undefined) return reject(IDLE_NOT_SCHEDULABLE, prev, { reason: "settled" });
  if (prev.ticketStatus !== "ready") {
    return reject(IDLE_NOT_SCHEDULABLE, prev, { status: prev.ticketStatus });
  }
  if (prev.readyDeadline === undefined || now > prev.readyDeadline) {
    const expired = transition(store, prev, now, { ticketStatus: "expired", localStatus: "queued" });
    return reject(IDLE_EXPIRED, expired, { reason: "deadline-passed" });
  }
  const next = transition(store, prev, now, { ticketStatus: "active", localStatus: "running", claimedAt: now });
  return accept(IDLE_CLAIMED, prev, next, { claimedAt: now });
}

/** expire 入参。 */
export interface ExpireOptions {
  id: string;
  now: number;
}

/**
 * 过期收口:ready/queued 过了 deadline → expired(本地轴回 queued,等待手动 Continue)。
 * 已 expired 幂等返回 EXPIRED;其它状态 / 未到 deadline 是 IDLE_INVALID(调用时机错)。
 */
export function expire(store: TicketStore, opts: ExpireOptions): TicketResult {
  if (store === undefined || store === null) return invalid({ reason: "store" });
  if (opts === undefined || opts === null || !isNonEmptyId(opts.id)) return invalid({ reason: "id" });
  if (!isFiniteNonNegative(opts.now)) return invalid({ reason: "now" });
  const { id, now } = opts;
  const prev = store.tickets[id];
  if (prev === undefined) return invalid({ reason: "not-found", id });
  if (prev.ticketStatus === "expired") return accept(IDLE_EXPIRED, prev, prev, { idempotent: true });
  if (prev.ticketStatus !== "ready" && prev.ticketStatus !== "queued") {
    return reject(IDLE_INVALID, prev, { reason: "status", status: prev.ticketStatus });
  }
  if (prev.readyDeadline === undefined) return reject(IDLE_INVALID, prev, { reason: "no-deadline" });
  if (now <= prev.readyDeadline) return reject(IDLE_INVALID, prev, { reason: "not-yet-due", readyDeadline: prev.readyDeadline });
  const next = transition(store, prev, now, { ticketStatus: "expired", localStatus: "queued" });
  return accept(IDLE_EXPIRED, prev, next, { readyDeadline: prev.readyDeadline });
}

/** settle 入参。 */
export interface SettleOptions {
  id: string;
  outcome: SettleOutcome;
  now: number;
}

/**
 * 结算:
 * - ok → 本地 done(终态)+ settledAt;
 * - 4xx → 本地 failed(终态,幂等 ack:同一 outcome 重放不改状态);
 * - 5xx → 保持 active(RETRY_PENDING),只累加 attempts,等下一轮重试 / reclaimStale。
 */
export function settle(store: TicketStore, opts: SettleOptions): TicketResult {
  if (store === undefined || store === null) return invalid({ reason: "store" });
  if (opts === undefined || opts === null || !isNonEmptyId(opts.id)) return invalid({ reason: "id" });
  if (!isFiniteNonNegative(opts.now)) return invalid({ reason: "now" });
  const outcome = opts.outcome;
  if (outcome !== "ok" && outcome !== "4xx" && outcome !== "5xx") return invalid({ reason: "outcome", outcome });
  const { id, now } = opts;
  const prev = store.tickets[id];
  if (prev === undefined) return invalid({ reason: "not-found", id });

  // 幂等重放:已终态的票按原结论再答一次,不改状态。
  if (prev.settledAt !== undefined) {
    if (prev.outcome === outcome) {
      const code = outcome === "5xx" ? IDLE_RETRY_PENDING : IDLE_SETTLED;
      return accept(code, prev, prev, { idempotent: true });
    }
    return reject(IDLE_INVALID, prev, { reason: "already-settled", outcome: prev.outcome });
  }
  if (prev.ticketStatus !== "active") return reject(IDLE_NOT_SCHEDULABLE, prev, { status: prev.ticketStatus });

  if (outcome === "5xx") {
    const retry = transition(store, prev, now, { attempts: prev.attempts + 1 });
    return accept(IDLE_RETRY_PENDING, prev, retry, { attempts: retry.attempts, active: true });
  }
  const next = transition(store, prev, now, {
    localStatus: outcome === "ok" ? "done" : "failed",
    settledAt: now,
    outcome,
  });
  return accept(IDLE_SETTLED, prev, next, { outcome, ack: outcome === "4xx" ? "idempotent" : "final" });
}

/** reclaimStale 入参。 */
export interface ReclaimOptions {
  now: number;
  maxActiveMs?: number;
  /** 只回收该会话(缺省=全量)。 */
  sessionId?: string;
}

/** 回收结果(批量)。 */
export interface ReclaimResult {
  ok: boolean;
  code: IdleCode;
  requeued: IdleTicket[];
  failed: IdleTicket[];
  reclaimed: IdleTicket[];
  detail?: Record<string, unknown>;
}

/**
 * 回收僵尸票:active 且未结算、认领已超 maxActiveMs(缺省 10min)。
 * 首次回收 → 回 queued(可再派发);第二次(attempts>=1)→ failed 收口(防无限空转)。
 */
export function reclaimStale(store: TicketStore, opts: ReclaimOptions): ReclaimResult {
  if (store === undefined || store === null) {
    return { ok: false, code: IDLE_INVALID, requeued: [], failed: [], reclaimed: [], detail: { reason: "store" } };
  }
  if (opts === undefined || opts === null || !isFiniteNonNegative(opts.now)) {
    return { ok: false, code: IDLE_INVALID, requeued: [], failed: [], reclaimed: [], detail: { reason: "now" } };
  }
  const now = opts.now;
  const maxActiveMs = isFiniteNonNegative(opts.maxActiveMs) && opts.maxActiveMs > 0 ? opts.maxActiveMs : IDLE_DEFAULT_MAX_ACTIVE_MS;
  const sessionFilter = typeof opts.sessionId === "string" && opts.sessionId.trim() !== "" ? opts.sessionId.trim() : undefined;

  const requeued: IdleTicket[] = [];
  const failed: IdleTicket[] = [];
  const reclaimed: IdleTicket[] = [];
  for (const id of Object.keys(store.tickets).sort()) {
    const ticket = store.tickets[id];
    if (ticket === undefined) continue;
    if (sessionFilter !== undefined && ticket.sessionId !== sessionFilter) continue;
    if (ticket.ticketStatus !== "active") continue;
    if (ticket.settledAt !== undefined) continue;
    const claimedAt = ticket.claimedAt;
    if (claimedAt === undefined) continue;
    if (now - claimedAt <= maxActiveMs) continue;

    let next: IdleTicket;
    const reclaims = ticket.reclaims ?? 0;
    if (reclaims < 1) {
      next = transition(store, ticket, now, {
        ticketStatus: "queued",
        localStatus: "queued",
        claimedAt: undefined,
        recoveredFrom: ticket.id,
        reclaims: reclaims + 1,
      });
      requeued.push(cloneTicket(next));
    } else {
      next = transition(store, ticket, now, {
        localStatus: "failed",
        settledAt: now,
        outcome: "5xx",
        recoveredFrom: ticket.id,
      });
      failed.push(cloneTicket(next));
    }
    reclaimed.push(cloneTicket(next));
  }

  return {
    ok: true,
    code: IDLE_RECLAIMED,
    requeued,
    failed,
    reclaimed,
    detail: { count: reclaimed.length, maxActiveMs },
  };
}

/** continueExpired 入参。 */
export interface ContinueOptions {
  id: string;
  now: number;
  /** 新票 id(缺省自动生成)。 */
  newId?: string;
}

/**
 * 手动 Continue:仅 expired 且本地仍 queued 的票可续一张新票(补号)。
 * 失败收口(local failed)或仍在 pending 的票不许续 —— 续号必须由人触发,不能被自动重试引爆。
 */
export function continueExpired(store: TicketStore, opts: ContinueOptions): TicketResult {
  if (store === undefined || store === null) return invalid({ reason: "store" });
  if (opts === undefined || opts === null || !isNonEmptyId(opts.id)) return invalid({ reason: "id" });
  if (!isFiniteNonNegative(opts.now)) return invalid({ reason: "now" });
  const { id, now } = opts;
  const prev = store.tickets[id];
  if (prev === undefined) return invalid({ reason: "not-found", id });
  if (prev.ticketStatus !== "expired") return reject(IDLE_NOT_SCHEDULABLE, prev, { reason: "not-expired", status: prev.ticketStatus });
  if (prev.localStatus !== "queued") return reject(IDLE_INVALID, prev, { reason: "local-status", localStatus: prev.localStatus });
  const pending = pendingOf(store, prev.sessionId);
  if (pending.length > 0) return reject(IDLE_PENDING_EXISTS, prev, { pendingIds: pending.map((t) => t.id) });

  const explicit = typeof opts.newId === "string" ? opts.newId.trim() : "";
  const newId = explicit !== "" ? explicit : nextId(store, prev.sessionId);
  if (store.tickets[newId] !== undefined) return invalid({ reason: "duplicate-id", id: newId });

  const created: IdleTicket = {
    id: newId,
    sessionId: prev.sessionId,
    localStatus: "queued",
    ticketStatus: "queued",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    attempts: 0,
    continuedFrom: prev.id,
  };
  insertTicket(store, created);
  return accept(IDLE_CONTINUED, prev, created, { sourceId: prev.id });
}

/** 轮询计划。 */
export interface PollPlan {
  code: IdleCode;
  due: boolean;
  waitMs: number;
  elapsedMs: number;
  overdue: boolean;
  overdueMs: number;
  nextPollAt: number;
}

/**
 * 批量轮询间隔裁决:距上次轮询 < 5s → WAIT;>= 5s → DUE(超过 5min 额外标 overdue)。
 * 没有上次轮询时间(首轮)→ DUE。now 非法 → INVALID。
 */
export function pollPlan(input: { lastPollAt?: number; now: number }): PollPlan {
  const now = input?.now;
  if (!isFiniteNonNegative(now)) {
    return { code: IDLE_INVALID, due: false, waitMs: 0, elapsedMs: 0, overdue: false, overdueMs: 0, nextPollAt: 0 };
  }
  const last = input?.lastPollAt;
  if (!isFiniteNonNegative(last)) {
    return { code: IDLE_POLL_DUE, due: true, waitMs: 0, elapsedMs: 0, overdue: false, overdueMs: 0, nextPollAt: now };
  }
  const elapsed = Math.max(0, now - last);
  if (elapsed < IDLE_POLL_MIN_MS) {
    return {
      code: IDLE_POLL_WAIT,
      due: false,
      waitMs: IDLE_POLL_MIN_MS - elapsed,
      elapsedMs: elapsed,
      overdue: false,
      overdueMs: 0,
      nextPollAt: last + IDLE_POLL_MIN_MS,
    };
  }
  const overdue = elapsed > IDLE_POLL_MAX_MS;
  return {
    code: IDLE_POLL_DUE,
    due: true,
    waitMs: 0,
    elapsedMs: elapsed,
    overdue,
    overdueMs: overdue ? elapsed - IDLE_POLL_MAX_MS : 0,
    nextPollAt: now,
  };
}

/** 派发轮结论。 */
export interface DispatchRound {
  ok: boolean;
  code: IdleCode;
  rejected: boolean;
  blockingIds: string[];
  detail?: Record<string, unknown>;
}

/**
 * 一轮闲时派发开始前的闸门:已有 ready/active(在途)票据 → 拒绝再创建(REJECT_NEW)。
 * 放行时码为 IDLE_CREATED(语义:可以创建新票)。
 */
export function dispatchRound(store: TicketStore): DispatchRound {
  if (store === undefined || store === null) {
    return { ok: false, code: IDLE_INVALID, rejected: false, blockingIds: [], detail: { reason: "store" } };
  }
  const blocking: string[] = [];
  for (const id of Object.keys(store.tickets).sort()) {
    const ticket = store.tickets[id];
    if (ticket === undefined || ticket.settledAt !== undefined) continue;
    if (ticket.ticketStatus === "ready" || ticket.ticketStatus === "active") blocking.push(id);
  }
  if (blocking.length > 0) {
    return { ok: false, code: IDLE_DISPATCH_REJECTED, rejected: true, blockingIds: blocking, detail: { blockingIds: blocking } };
  }
  return { ok: true, code: IDLE_CREATED, rejected: false, blockingIds: [], detail: { reason: "round-open" } };
}

/** 账本摘要(供 store report 与测试断言;纯函数)。 */
export interface TicketSummary {
  total: number;
  pending: number;
  byLocalStatus: Record<LocalStatus, number>;
  byTicketStatus: Record<TicketStatus, number>;
  staleActive: IdleTicket[];
  settled: number;
  sessions: number;
  pendingBySession: Record<string, string[]>;
}

/** 汇总账本:计数 / pending / 僵尸 active(需要 now 判租期)。 */
export function summarizeTickets(store: TicketStore, input: { now: number; maxActiveMs?: number }): TicketSummary {
  const byLocalStatus: Record<LocalStatus, number> = { queued: 0, schedulable: 0, running: 0, done: 0, failed: 0 };
  const byTicketStatus: Record<TicketStatus, number> = { queued: 0, ready: 0, active: 0, expired: 0 };
  const pendingBySession: Record<string, string[]> = {};
  const staleActive: IdleTicket[] = [];
  const maxActiveMs = isFiniteNonNegative(input?.maxActiveMs) && input.maxActiveMs > 0 ? input.maxActiveMs : IDLE_DEFAULT_MAX_ACTIVE_MS;
  const now = isFiniteNonNegative(input?.now) ? input.now : 0;
  let total = 0;
  let pending = 0;
  let settled = 0;

  if (store !== undefined && store !== null) {
    for (const id of Object.keys(store.tickets).sort()) {
      const ticket = store.tickets[id];
      if (ticket === undefined) continue;
      total += 1;
      byLocalStatus[ticket.localStatus] += 1;
      byTicketStatus[ticket.ticketStatus] += 1;
      if (ticket.settledAt !== undefined) settled += 1;
      if (isPending(ticket)) {
        pending += 1;
        const bucket = pendingBySession[ticket.sessionId];
        if (bucket === undefined) pendingBySession[ticket.sessionId] = [ticket.id];
        else bucket.push(ticket.id);
      }
      if (
        ticket.ticketStatus === "active" &&
        ticket.settledAt === undefined &&
        ticket.claimedAt !== undefined &&
        now - ticket.claimedAt > maxActiveMs
      ) {
        staleActive.push(cloneTicket(ticket));
      }
    }
  }

  return {
    total,
    pending,
    byLocalStatus,
    byTicketStatus,
    staleActive,
    settled,
    sessions: Object.keys(store.bySession ?? {}).length,
    pendingBySession,
  };
}

/** 账本形状校验结果。 */
export interface StoreSanitizeResult {
  store: TicketStore;
  dropped: string[];
}

function isLocalStatus(value: unknown): value is LocalStatus {
  return typeof value === "string" && (LOCAL_STATUSES as readonly string[]).includes(value);
}

function isTicketStatus(value: unknown): value is TicketStatus {
  return typeof value === "string" && (TICKET_STATUSES as readonly string[]).includes(value);
}

/** 从任意 JSON 值恢复账本:字段非法/未知状态/缺 session 的票据被丢弃(计入 dropped)。 */
export function sanitizeTicketStore(raw: unknown): StoreSanitizeResult {
  const store = emptyTicketStore();
  const dropped: string[] = [];
  if (raw === undefined || raw === null || typeof raw !== "object") return { store, dropped };
  const record = raw as Record<string, unknown>;
  const ticketsRaw = record["tickets"];
  if (ticketsRaw === undefined || ticketsRaw === null || typeof ticketsRaw !== "object") return { store, dropped };

  for (const [id, value] of Object.entries(ticketsRaw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") {
      dropped.push(id);
      continue;
    }
    const t = value as Record<string, unknown>;
    const sessionId = typeof t["sessionId"] === "string" ? t["sessionId"].trim() : "";
    const createdAt = t["createdAt"];
    const updatedAt = t["updatedAt"];
    if (sessionId === "" || !isFiniteNonNegative(createdAt) || !isFiniteNonNegative(updatedAt)) {
      dropped.push(id);
      continue;
    }
    if (!isLocalStatus(t["localStatus"]) || !isTicketStatus(t["ticketStatus"])) {
      dropped.push(id);
      continue;
    }
    const ticket: IdleTicket = {
      id,
      sessionId,
      localStatus: t["localStatus"],
      ticketStatus: t["ticketStatus"],
      createdAt,
      updatedAt,
      revision: isFiniteNonNegative(t["revision"]) ? t["revision"] : 1,
      attempts: isFiniteNonNegative(t["attempts"]) ? t["attempts"] : 0,
      reclaims: isFiniteNonNegative(t["reclaims"]) ? t["reclaims"] : 0,
    };
    if (isFiniteNonNegative(t["readyDeadline"])) ticket.readyDeadline = t["readyDeadline"];
    if (isFiniteNonNegative(t["claimedAt"])) ticket.claimedAt = t["claimedAt"];
    if (isFiniteNonNegative(t["settledAt"])) ticket.settledAt = t["settledAt"];
    if (t["outcome"] === "ok" || t["outcome"] === "4xx" || t["outcome"] === "5xx") ticket.outcome = t["outcome"];
    if (typeof t["continuedFrom"] === "string" && t["continuedFrom"] !== "") ticket.continuedFrom = t["continuedFrom"];
    if (typeof t["recoveredFrom"] === "string" && t["recoveredFrom"] !== "") ticket.recoveredFrom = t["recoveredFrom"];
    store.tickets[id] = ticket;
    const bucket = store.bySession[sessionId];
    if (bucket === undefined) store.bySession[sessionId] = [id];
    else bucket.push(id);
  }
  // 会话索引按创建时刻保序(便于 pendingOf / nextId 可预期)。
  for (const sessionId of Object.keys(store.bySession)) {
    const ids = store.bySession[sessionId];
    if (ids === undefined) continue;
    ids.sort((a, b) => {
      const ta = store.tickets[a]?.createdAt ?? 0;
      const tb = store.tickets[b]?.createdAt ?? 0;
      if (ta !== tb) return ta - tb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }
  return { store, dropped };
}
