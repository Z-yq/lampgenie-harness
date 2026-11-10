/**
 * 闲时算力票据持久层(生产侧,#175):把 idle-ticket 的纯状态机落到单一 JSON 账本。
 * 数据面:`<root>/.genie/rsi/idle-tickets.json`
 *   { "v": 1, "tickets": { "<id>": {...} }, "bySession": { "<sessionId>": ["id..."] } }
 * 为什么是单文件整账本(而不是 append-only):
 * 票据是**状态机**(queued→ready→active→expired 外加结算终态),读时只关心每张票的当前状态,
 * 追加事件流会让「当前是否还有 pending」变成每次全量折叠的开销。整账本 + 原子替换
 * (写临时文件 → fsync 由 rename 语义保证 → renameSync)让「读到的永远是某一完整代」成立:
 * 崩溃最多丢掉最后一次未 rename 的写,不会读到半张票。
 * 失败口径:
 * - 参数错误(TypeError)是唯一 throw 的情形。
 * - 读失败(文件不存在 / JSON 坏 / 形状坏到无法恢复)→ 折叠成 IDLE_STORE_ERROR,**写操作拒写**:
 *   坏账本上先落库会掩盖原始损坏,宁可停下等人看。
 * - 写后校验(ticket 数一致)不过 → IDLE_STORE_WRITE_MISMATCH(不 throw,失败可见)。
 * - 状态机拒绝(PENDING_EXISTS / QUOTA_EXHAUSTED / NOT_SCHEDULABLE / EXPIRED / DISPATCH_REJECTED)
 *   直接透传 runtime 稳定码,且不写盘(拒收前零副作用)。
 * 依赖纪律:node:fs / node:path + runtime 纯逻辑(经 workspace 子路径导入)。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  claim,
  continueExpired,
  createTicket,
  dispatchRound,
  emptyTicketStore,
  expire,
  IDLE_INVALID,
  IDLE_TICKET_VERSION,
  makeReady,
  pollPlan,
  reclaimStale,
  sanitizeTicketStore,
  settle,
  summarizeTickets,
  type CreateTicketOptions,
  type IdleCode,
  type IdleTicket,
  type PollPlan,
  type ReclaimResult,
  type SettleOutcome,
  type TicketResult,
  type TicketStore,
  type TicketSummary,
} from "@lampgenie/runtime/agent/idle-ticket";

/** store 层自产的失败码(业务拒绝沿用 runtime 的 IDLE_* 码)。 */
export const IDLE_STORE_CODES = ["IDLE_STORE_ERROR", "IDLE_STORE_WRITE_MISMATCH"] as const;

export type IdleStoreCode = (typeof IDLE_STORE_CODES)[number];

/** 账本路径(目录 + 文件各一份,便于上层建目录/守护)。 */
export interface IdleTicketPaths {
  dir: string;
  file: string;
}

/** 相对仓库根的账本位置。 */
export const IDLE_TICKET_RELATIVE_DIR = ".genie/rsi";
export const IDLE_TICKET_FILE = "idle-tickets.json";

let tmpSeq = 0;

/** 解析账本路径;root 必填。 */
export function idleTicketPaths(root: string): IdleTicketPaths {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError("idleTicketPaths: root 必须是非空字符串");
  const dir = join(root, IDLE_TICKET_RELATIVE_DIR);
  return { dir, file: join(dir, IDLE_TICKET_FILE) };
}

/** 读账本结果。 */
export interface ReadTicketStoreResult {
  ok: boolean;
  codes: string[];
  store: TicketStore;
  dropped: string[];
  file: string;
  /** 文件是否存在(不存在=false 但 ok=true:首次创建场景)。 */
  exists: boolean;
}

/**
 * 读账本并做形状校验。
 * 文件不存在 = 空账本 + ok(首次运行);文件存在但解析/形状失败 = ok:false(调用方必须拒写)。
 */
export function readTicketStore(root: string): ReadTicketStoreResult {
  const paths = idleTicketPaths(root);
  if (!existsSync(paths.file)) {
    return { ok: true, codes: [], store: emptyTicketStore(), dropped: [], file: paths.file, exists: false };
  }
  let text: string;
  try {
    text = readFileSync(paths.file, "utf8");
  } catch (err) {
    return {
      ok: false,
      codes: [`IDLE_STORE_ERROR`],
      store: emptyTicketStore(),
      dropped: [],
      file: paths.file,
      exists: true,
    };
  }
  if (text.trim() === "") {
    return { ok: true, codes: [], store: emptyTicketStore(), dropped: [], file: paths.file, exists: true };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, codes: ["IDLE_STORE_ERROR"], store: emptyTicketStore(), dropped: [], file: paths.file, exists: true };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, codes: ["IDLE_STORE_ERROR"], store: emptyTicketStore(), dropped: [], file: paths.file, exists: true };
  }
  const { store, dropped } = sanitizeTicketStore(raw);
  return { ok: true, codes: [], store, dropped, file: paths.file, exists: true };
}

/** 写账本结果。 */
export interface WriteTicketStoreResult {
  ok: boolean;
  codes: string[];
  file: string;
  ticketCount: number;
}

/** 原子写整账本:临时文件 → rename;写后重读比对票据数。 */
export function writeTicketStore(root: string, store: TicketStore): WriteTicketStoreResult {
  const paths = idleTicketPaths(root);
  try {
    mkdirSync(dirname(paths.file), { recursive: true });
  } catch {
    return { ok: false, codes: ["IDLE_STORE_ERROR"], file: paths.file, ticketCount: 0 };
  }
  const payload = { v: IDLE_TICKET_VERSION, tickets: store.tickets, bySession: store.bySession };
  tmpSeq += 1;
  const tmp = `${paths.file}.tmp-${process.pid}-${tmpSeq}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(tmp, paths.file);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 临时文件清理失败不掩盖主错误 */
    }
    return { ok: false, codes: ["IDLE_STORE_ERROR"], file: paths.file, ticketCount: 0 };
  }

  // 写后校验:重新解析落盘内容,票据数必须与内存一致。
  try {
    const after = JSON.parse(readFileSync(paths.file, "utf8")) as { tickets?: Record<string, unknown> };
    const count = after !== null && typeof after === "object" && after.tickets !== undefined && after.tickets !== null
      ? Object.keys(after.tickets).length
      : 0;
    if (count !== Object.keys(store.tickets).length) {
      return { ok: false, codes: ["IDLE_STORE_WRITE_MISMATCH"], file: paths.file, ticketCount: count };
    }
    return { ok: true, codes: [], file: paths.file, ticketCount: count };
  } catch {
    return { ok: false, codes: ["IDLE_STORE_WRITE_MISMATCH"], file: paths.file, ticketCount: 0 };
  }
}

/** 单票据操作结果(读 → 纯逻辑裁决 → 仅 ok 时写盘)。 */
export interface StoreTicketResult {
  ok: boolean;
  code: IdleCode | IdleStoreCode;
  codes: string[];
  ticket?: IdleTicket;
  prev?: IdleTicket;
  detail?: Record<string, unknown>;
  file: string;
  persisted: boolean;
  ticketCount: number;
}

function opResult(root: string, result: TicketResult, write: WriteTicketStoreResult | undefined): StoreTicketResult {
  const codeList: string[] = [result.code];
  if (write !== undefined && !write.ok) codeList.push(...write.codes);
  return {
    ok: result.ok && (write === undefined || write.ok),
    code: write !== undefined && !write.ok ? (write.codes[0] as IdleStoreCode) : result.code,
    codes: codeList,
    ticket: result.ticket,
    prev: result.prev,
    detail: result.detail,
    file: write?.file ?? idleTicketPaths(root).file,
    persisted: write !== undefined && write.ok,
    ticketCount: write?.ticketCount ?? 0,
  };
}

function storeError(root: string, read: ReadTicketStoreResult, detail: Record<string, unknown>): StoreTicketResult {
  return {
    ok: false,
    code: "IDLE_STORE_ERROR",
    codes: [...read.codes, "IDLE_STORE_ERROR"],
    detail: { reason: "unreadable-ledger", ...detail },
    file: read.file,
    persisted: false,
    ticketCount: 0,
  };
}

/** 通用「读—裁决—写」：裁决 ok 才写盘；读失败或裁决失败都零写入。 */
function withStore(
  root: string,
  act: (store: TicketStore) => TicketResult): StoreTicketResult {
  const read = readTicketStore(root);
  if (!read.ok) return storeError(root, read, {});
  // 变更判定用整账本快照比对(幂等重放不算变更 → 不重写磁盘)。
  // 注意:即使裁决是拒绝(ok:false),只要账本确实被推进(如 claim 发现过期就地转 expired),
  // 也必须落盘 —— 否则「已判死」的票在磁盘上仍是 ready,下次还能被认领。
  const beforeJson = JSON.stringify(read.store);
  const result = act(read.store);
  const mutated = JSON.stringify(read.store) !== beforeJson;
  if (!mutated) {
    return {
      ok: result.ok,
      code: result.code,
      codes: [result.code],
      ticket: result.ticket,
      prev: result.prev,
      detail: result.detail,
      file: read.file,
      persisted: false,
      ticketCount: Object.keys(read.store.tickets).length,
    };
  }
  const write = writeTicketStore(root, read.store);
  return opResult(root, result, write);
}

function requireRoot(root: string): void {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError("idle-ticket-store: root 必须是非空字符串");
}

function defaultNow(now: unknown): number {
  if (typeof now === "number") {
    if (!Number.isFinite(now) || now < 0) throw new TypeError("idle-ticket-store: now 必须是非负有限数");
    return now;
  }
  return Date.now();
}

/** create 入参(now 缺省 = Date.now()）。 */
export interface StoreCreateOptions extends Omit<CreateTicketOptions, "now"> {
  now?: number;
}

/** 先取票再落库:同会话 pending / 额度不足都在写盘前拒。 */
export function createTicketOnDisk(root: string, opts: StoreCreateOptions): StoreTicketResult {
  requireRoot(root);
  const now = defaultNow(opts.now);
  return withStore(root, (store) => createTicket(store, { sessionId: opts.sessionId, now, budgetOk: opts.budgetOk, id: opts.id }));
}

/** queued → ready(deadline 缺省 10min)。 */
export function makeReadyOnDisk(root: string, opts: { id: string; now?: number; deadlineMs?: number }): StoreTicketResult {
  requireRoot(root);
  return withStore(root, (store) => makeReady(store, { id: opts.id, now: defaultNow(opts.now), deadlineMs: opts.deadlineMs }));
}

/** 原子 CAS 认领。 */
export function claimOnDisk(root: string, opts: { id: string; now?: number; expectRevision?: number }): StoreTicketResult {
  requireRoot(root);
  return withStore(root, (store) => claim(store, { id: opts.id, now: defaultNow(opts.now), expectRevision: opts.expectRevision }));
}

/** 过期。 */
export function expireOnDisk(root: string, opts: { id: string; now?: number }): StoreTicketResult {
  requireRoot(root);
  return withStore(root, (store) => expire(store, { id: opts.id, now: defaultNow(opts.now) }));
}

/** 结算。 */
export function settleOnDisk(root: string, opts: { id: string; outcome: SettleOutcome; now?: number }): StoreTicketResult {
  requireRoot(root);
  return withStore(root, (store) => settle(store, { id: opts.id, outcome: opts.outcome, now: defaultNow(opts.now) }));
}

/** 回收僵尸 active(批量)。 */
export interface StoreReclaimResult extends ReclaimResult {
  file: string;
  persisted: boolean;
  ticketCount: number;
}

export function reclaimStaleOnDisk(root: string, opts: { now?: number; maxActiveMs?: number; sessionId?: string } = {}): StoreReclaimResult {
  requireRoot(root);
  const read = readTicketStore(root);
  if (!read.ok) {
    return { ok: false, code: "IDLE_INVALID", requeued: [], failed: [], reclaimed: [], detail: { reason: "unreadable-ledger" }, file: read.file, persisted: false, ticketCount: 0 };
  }
  const result = reclaimStale(read.store, { now: defaultNow(opts.now), maxActiveMs: opts.maxActiveMs, sessionId: opts.sessionId });
  if (!result.ok || result.reclaimed.length === 0) {
    return { ...result, file: read.file, persisted: false, ticketCount: Object.keys(read.store.tickets).length };
  }
  const write = writeTicketStore(root, read.store);
  return {
    ok: result.ok && write.ok,
    code: write.ok ? result.code : "IDLE_INVALID",
    requeued: result.requeued,
    failed: result.failed,
    reclaimed: result.reclaimed,
    detail: { ...(result.detail ?? {}), writeCodes: write.codes },
    file: write.file,
    persisted: write.ok,
    ticketCount: write.ticketCount,
  };
}

/** 手动 Continue 补号。 */
export function continueExpiredOnDisk(root: string, opts: { id: string; now?: number; newId?: string }): StoreTicketResult {
  requireRoot(root);
  return withStore(root, (store) => continueExpired(store, { id: opts.id, now: defaultNow(opts.now), newId: opts.newId }));
}

/** 轮询裁决(只读,不写盘)。 */
export interface StorePollResult extends PollPlan {
  file: string;
  pendingIds: string[];
}

export function pollOnDisk(root: string, opts: { lastPollAt?: number; now?: number } = {}): StorePollResult {
  requireRoot(root);
  const now = defaultNow(opts.now);
  const plan = pollPlan({ lastPollAt: opts.lastPollAt, now });
  const read = readTicketStore(root);
  const pendingIds: string[] = [];
  if (read.ok) {
    for (const ticket of Object.values(read.store.tickets)) {
      if (ticket.localStatus !== "done" && ticket.localStatus !== "failed" && ticket.settledAt === undefined) {
        pendingIds.push(ticket.id);
      }
    }
  }
  pendingIds.sort();
  return { ...plan, file: read.file, pendingIds };
}

/** 派发轮闸门(只读)。 */
export function dispatchRoundOnDisk(root: string): {
  ok: boolean;
  code: IdleCode | IdleStoreCode;
  codes: string[];
  rejected: boolean;
  blockingIds: string[];
  file: string;
  detail?: Record<string, unknown>;
} {
  requireRoot(root);
  const read = readTicketStore(root);
  if (!read.ok) {
    return { ok: false, code: "IDLE_STORE_ERROR", codes: ["IDLE_STORE_ERROR"], rejected: false, blockingIds: [], file: read.file, detail: { reason: "unreadable-ledger" } };
  }
  const round = dispatchRound(read.store);
  return { ok: round.ok, code: round.code, codes: [round.code], rejected: round.rejected, blockingIds: round.blockingIds, file: read.file, detail: round.detail };
}

/** 报告:账本摘要 + 坏条目 + 路径。 */
export interface IdleTicketReport extends TicketSummary {
  ok: boolean;
  codes: string[];
  file: string;
  exists: boolean;
  dropped: string[];
  tickets: IdleTicket[];
}

export function reportTickets(root: string, opts: { now?: number; maxActiveMs?: number } = {}): IdleTicketReport {
  requireRoot(root);
  const read = readTicketStore(root);
  const summary = summarizeTickets(read.store, { now: defaultNow(opts.now), maxActiveMs: opts.maxActiveMs });
  const tickets = Object.values(read.store.tickets).sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return {
    ...summary,
    ok: read.ok,
    codes: read.codes,
    file: read.file,
    exists: read.exists,
    dropped: read.dropped,
    tickets,
  };
}

/** 读一张票(供 CLI/面板点查)。 */
export function getTicketOnDisk(root: string, id: string): { ticket?: IdleTicket; file: string } {
  requireRoot(root);
  const read = readTicketStore(root);
  return { ticket: read.store.tickets[id], file: read.file };
}

/** 兜底:业务拒绝码集合(CLI 用来映射 exit 2)。 */
export const IDLE_REJECTION_CODES = [
  "IDLE_PENDING_EXISTS",
  "IDLE_QUOTA_EXHAUSTED",
  "IDLE_NOT_SCHEDULABLE",
  "IDLE_EXPIRED",
  "IDLE_DISPATCH_REJECTED",
] as const;

export function isIdleRejection(code: string): boolean {
  return (IDLE_REJECTION_CODES as readonly string[]).includes(code);
}

/** IDLE_INVALID 的语义重导出(便于 CLI 只依赖 store)。 */
export { IDLE_INVALID };
