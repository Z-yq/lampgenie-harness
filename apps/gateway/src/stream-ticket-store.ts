/**
 * 一次性流票据的持久层(M30):把 runtime 的纯逻辑票据库落到单个 JSON 文件。
 *
 * 数据面:`<root>/.genie/rsi/tickets.json`,内容 `{ version: 1, tickets: Record<id, StreamTicket> }`。
 * 为什么是整文件快照而不是 append-only:票据的语义是「现在还能不能用」,消费/过期/prune 都是
 * 对同一张票的状态迁移,历史行反而会让「一张票只能换一次流」的判定变复杂;而一次性票据
 * 的生命周期(60s)也不需要审计留痕。
 *
 * 写纪律:**原子写**(先写 `${path}.tmp-<pid>-<rand>` 再 renameSync 覆盖),目录 mkdirSync recursive;
 * 半截文件永远不会出现在正式路径上,并发读者要么看旧快照要么看新快照。
 *
 * 读纪律:文件不存在 → 空 store(首次使用是正常路径);坏 JSON / 结构不合法 → 折叠成
 * `TICKET_STORE_ERROR`(不 throw、不清空、**不允许写操作覆盖坏文件**——宁可报错也不静默丢票)。
 *
 * 依赖纪律:runtime 纯逻辑模块按 cohort-signature-store 的既有套路两跳惰性解析
 * (① 带 `--conditions=development` 的运行时走包导出 src 入口;② 裸 tsx/dist 缺该文件时回退
 * 到仓内源文件 new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。顶层 await 取到 rt,
 * 所有导出函数保持同步签名。
 *
 * 参数纪律:root 必须是非空字符串,非法 root **抛错**(与 cohort-signature-store 的 assertRoot 一致);
 * 除该参数错误外不 throw,IO/解析失败一律折叠成稳定码。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import type {
  AllowUrlTicketResult,
  ConsumeTicketResult,
  IssueTicketResult,
  StreamTicket,
  TicketBinding,
  TicketCode,
  TicketStore,
} from "@lampgenie/runtime/agent/stream-ticket";

/** runtime 面(只列本文件用到的导出,便于回退解析后仍类型安全)。 */
interface StreamTicketRuntime {
  readonly STREAM_TICKET_TTL_MS: number;
  readonly TICKET_CODES: readonly TicketCode[];
  isTicketBinding(value: unknown): value is TicketBinding;
  issueTicket(
    store: TicketStore,
    options: { binding: TicketBinding; now: number; ttlMs?: number; idFactory?: () => string },
  ): IssueTicketResult;
  consumeTicket(
    store: TicketStore,
    options: { ticketId: string; binding: TicketBinding; now: number },
  ): ConsumeTicketResult;
  allowUrlTicket(options: { url: string; store: TicketStore; now: number }): AllowUrlTicketResult;
  pruneExpired(store: TicketStore, now: number): { code: "TICKET_PRUNED"; pruned: string[] };
}

let streamTicketRuntime: StreamTicketRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadStreamTicketRuntime(): Promise<StreamTicketRuntime> {
  if (streamTicketRuntime) return streamTicketRuntime;
  const spec = "@lampgenie/runtime/agent/stream-ticket";
  try {
    streamTicketRuntime = (await import(spec)) as StreamTicketRuntime;
  } catch {
    const srcUrl = new URL(
      "../../../packages/harness-runtime/src/agent/stream-ticket.ts",
      import.meta.url,
    ).href;
    streamTicketRuntime = (await import(srcUrl)) as StreamTicketRuntime;
  }
  return streamTicketRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadStreamTicketRuntime();

/** 票据缺省有效期(runtime 常量再导出,方便上层不额外 import)。 */
export const STREAM_TICKET_TTL_MS = rt.STREAM_TICKET_TTL_MS;

/** store 稳定码:runtime 的 TICKET_* 之外补一个「存/取失败」码(读写失败统一折叠)。 */
export const STREAM_TICKET_STORE_CODES: readonly (TicketCode | "TICKET_STORE_ERROR")[] = [
  ...rt.TICKET_CODES,
  "TICKET_STORE_ERROR",
];

export type StreamTicketStoreCode = TicketCode | "TICKET_STORE_ERROR";

/** 落盘文件结构。 */
interface TicketsFile {
  version: 1;
  tickets: Record<string, StreamTicket>;
}

export interface LoadTicketsOk {
  ok: true;
  version: 1;
  tickets: TicketStore;
  path: string;
}

export interface LoadTicketsError {
  ok: false;
  code: "TICKET_STORE_ERROR";
  reason: string;
}

export type LoadTicketsResult = LoadTicketsOk | LoadTicketsError;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function assertRoot(root: unknown): string {
  if (typeof root !== "string" || root.trim() === "") throw new Error("root 必须是非空字符串");
  return root;
}

/** 票据台账文件绝对路径:`<root>/.genie/rsi/tickets.json`。 */
export function ticketsPath(root: string): string {
  return join(assertRoot(root), ".genie", "rsi", "tickets.json");
}

function cloneTicket(ticket: StreamTicket): StreamTicket {
  const copy: StreamTicket = {
    id: ticket.id,
    binding: {
      ptyId: ticket.binding.ptyId,
      directory: ticket.binding.directory,
      workspaceId: ticket.binding.workspaceId,
    },
    issuedAt: ticket.issuedAt,
    expiresAt: ticket.expiresAt,
  };
  if (ticket.consumedAt !== undefined) copy.consumedAt = ticket.consumedAt;
  return copy;
}

/** 结构校验:返回 undefined 表示合法,否则返回一段人话原因(折叠进 TICKET_STORE_ERROR)。 */
function validateFile(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return "顶层必须是对象";
  if (parsed.version !== 1) return "version 必须是 1";
  const tickets = parsed.tickets;
  if (!isRecord(tickets)) return "tickets 必须是对象";
  for (const [id, value] of Object.entries(tickets)) {
    if (!isRecord(value)) return `票据 ${id} 必须是对象`;
    if (value.id !== id) return `票据 ${id} 的 id 字段不一致`;
    if (!rt.isTicketBinding(value.binding)) return `票据 ${id} 的 binding 不合法`;
    if (!isFiniteNumber(value.issuedAt)) return `票据 ${id} 的 issuedAt 不合法`;
    if (!isFiniteNumber(value.expiresAt)) return `票据 ${id} 的 expiresAt 不合法`;
    if (value.consumedAt !== undefined && !isFiniteNumber(value.consumedAt)) {
      return `票据 ${id} 的 consumedAt 不合法`;
    }
  }
  return undefined;
}

/**
 * 读整库。文件不存在 → 空 store(正常路径);坏 JSON / 结构非法 / 读失败 → TICKET_STORE_ERROR。
 * 返回值里的 tickets 是深拷贝,调用方可随便改(不会污染磁盘语义)。
 */
export function loadTickets(root: string): LoadTicketsResult {
  const path = ticketsPath(root);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") {
      return { ok: true, version: 1, tickets: { tickets: {} }, path };
    }
    return { ok: false, code: "TICKET_STORE_ERROR", reason: `读取失败:${messageOf(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      code: "TICKET_STORE_ERROR",
      reason: `JSON 解析失败:${messageOf(error)}`,
    };
  }

  const invalid = validateFile(parsed);
  if (invalid !== undefined) return { ok: false, code: "TICKET_STORE_ERROR", reason: invalid };

  const file = parsed as TicketsFile;
  const tickets: Record<string, StreamTicket> = {};
  for (const [id, ticket] of Object.entries(file.tickets)) tickets[id] = cloneTicket(ticket);
  return { ok: true, version: 1, tickets: { tickets }, path };
}

/** 原子写:tmp 文件写完后 rename 覆盖;失败清 tmp 并返回 false(不 throw)。 */
function writeTickets(root: string, tickets: Record<string, StreamTicket>): boolean {
  const path = ticketsPath(root);
  const payload: TicketsFile = { version: 1, tickets };
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 清理失败无所谓:tmp 名带 pid+rand,不会与正式文件混淆。
    }
    return false;
  }
}

const STORE_ERROR = "TICKET_STORE_ERROR" as const;

export type StoreIssueResult =
  | { ok: true; code: "TICKET_ISSUED"; ticket: StreamTicket; persisted: boolean }
  | { ok: false; code: "TICKET_INVALID"; reason: string; persisted: false }
  | { ok: false; code: "TICKET_STORE_ERROR"; reason: string; persisted: false };

export interface StoreIssueOptions {
  binding: TicketBinding;
  now?: number;
  ttlMs?: number;
  idFactory?: () => string;
}

/** 换票:读 → runtime 签发 → 成功才写盘(写失败如实报 persisted:false,票不入库)。 */
export function issue(root: string, options: StoreIssueOptions): StoreIssueResult {
  const base = assertRoot(root);
  const loaded = loadTickets(base);
  if (!loaded.ok) {
    return { ok: false, code: STORE_ERROR, reason: loaded.reason, persisted: false };
  }

  const { binding, ttlMs, idFactory } = options ?? ({} as StoreIssueOptions);
  const now = options?.now === undefined ? Date.now() : options.now;
  const runtimeOptions: {
    binding: TicketBinding;
    now: number;
    ttlMs?: number;
    idFactory?: () => string;
  } = { binding, now };
  if (ttlMs !== undefined) runtimeOptions.ttlMs = ttlMs;
  if (idFactory !== undefined) runtimeOptions.idFactory = idFactory;

  const result = rt.issueTicket(loaded.tickets, runtimeOptions);
  if (!result.ok) {
    return { ok: false, code: "TICKET_INVALID", reason: result.reason, persisted: false };
  }

  const persisted = writeTickets(base, loaded.tickets.tickets);
  return { ok: true, code: "TICKET_ISSUED", ticket: result.ticket, persisted };
}

export interface StoreConsumeOptions {
  ticketId: string;
  binding: TicketBinding;
  now?: number;
}

export type StoreConsumeResult =
  | (ConsumeTicketResult & { persisted: boolean })
  | { ok: false; code: "TICKET_STORE_ERROR"; ticketId: string; reason: string; persisted: false };

/**
 * 消费票:只有**状态发生变化**才写盘。
 * 「变化」= TICKET_CONSUMED(置 consumedAt) 或 TICKET_EXPIRED(过期票也被标记);
 * REPLAY / NOT_FOUND / BINDING_MISMATCH 磁盘一个字节都不动。
 */
export function consume(root: string, options: StoreConsumeOptions): StoreConsumeResult {
  const base = assertRoot(root);
  const ticketId = typeof options?.ticketId === "string" ? options.ticketId : "";
  const loaded = loadTickets(base);
  if (!loaded.ok) {
    return { ok: false, code: STORE_ERROR, ticketId, reason: loaded.reason, persisted: false };
  }

  const now = options?.now === undefined ? Date.now() : options.now;
  const result = rt.consumeTicket(loaded.tickets, {
    ticketId,
    binding: options?.binding,
    now,
  });

  const changed = result.code === "TICKET_CONSUMED" || result.code === "TICKET_EXPIRED";
  const persisted = changed ? writeTickets(base, loaded.tickets.tickets) : false;
  return { ...result, persisted };
}

export interface StoreAllowUrlOptions {
  url: string;
  binding?: TicketBinding;
  now?: number;
}

export type StoreAllowUrlResult =
  | (AllowUrlTicketResult & { persisted: boolean })
  | { allowed: false; code: "TICKET_STORE_ERROR"; ticketId: string; reason: string; persisted: false };

/** 从 url 取 ticket 参数(runtime 的 allowUrlTicket 已支持可选 binding;此处供带 binding 的路径复用)。 */
function ticketIdFromUrl(url: unknown): { code: "TICKET_INVALID" | "TICKET_NO_TICKET" } | { ticketId: string } {
  if (typeof url !== "string") return { code: "TICKET_INVALID" };
  let parsed: URL;
  try {
    parsed = new URL(url, "http://ticket.local");
  } catch {
    return { code: "TICKET_INVALID" };
  }
  const raw = parsed.searchParams.get("ticket");
  if (raw === null || raw.trim() === "") return { code: "TICKET_NO_TICKET" };
  return { ticketId: raw.trim() };
}

/**
 * WS 握手放行:url 的 `ticket` 参数换取放行判定。
 * 给了 binding(真实会话三元组)就以它为准,否则回退到 url 的 query(runtime 的 allowUrlTicket
 * 对 binding 做同一优先级裁决;本层显式传 binding 时走 consumeTicket 以免二次解析 url)。
 */
export function allowUrl(root: string, options: StoreAllowUrlOptions): StoreAllowUrlResult {
  const base = assertRoot(root);
  const loaded = loadTickets(base);
  if (!loaded.ok) {
    return { allowed: false, code: STORE_ERROR, ticketId: "", reason: loaded.reason, persisted: false };
  }

  const now = options?.now === undefined ? Date.now() : options.now;
  const binding = options?.binding;

  let result: AllowUrlTicketResult;
  if (binding !== undefined) {
    const extracted = ticketIdFromUrl(options?.url);
    if (!("ticketId" in extracted)) {
      result = {
        allowed: false,
        code: extracted.code,
        ticketId: "",
        reason: extracted.code === "TICKET_INVALID" ? "url 无法解析" : "url 未带 ticket",
      };
    } else {
      const consumed = rt.consumeTicket(loaded.tickets, {
        ticketId: extracted.ticketId,
        binding,
        now,
      });
      result = {
        allowed: consumed.code === "TICKET_CONSUMED",
        code: consumed.code,
        ticketId: consumed.ticketId,
        ...(consumed.ticket === undefined ? {} : { ticket: consumed.ticket }),
        ...(consumed.reason === undefined ? {} : { reason: consumed.reason }),
      };
    }
  } else {
    result = rt.allowUrlTicket({ url: options?.url, store: loaded.tickets, now });
  }

  const changed = result.code === "TICKET_CONSUMED" || result.code === "TICKET_EXPIRED";
  const persisted = changed ? writeTickets(base, loaded.tickets.tickets) : false;
  return { ...result, persisted };
}

export type StorePruneResult =
  | { code: "TICKET_PRUNED"; pruned: string[]; persisted: boolean }
  | { code: "TICKET_STORE_ERROR"; pruned: string[]; persisted: false; reason: string };

/** 清理过期未消费票:有删除才写盘(幂等,再 prune 返回空数组)。 */
export function prune(root: string, options?: { now?: number }): StorePruneResult {
  const base = assertRoot(root);
  const loaded = loadTickets(base);
  if (!loaded.ok) {
    return { code: STORE_ERROR, pruned: [], persisted: false, reason: loaded.reason };
  }

  const now = options?.now === undefined ? Date.now() : options.now;
  const result = rt.pruneExpired(loaded.tickets, now);
  const persisted = result.pruned.length > 0 ? writeTickets(base, loaded.tickets.tickets) : false;
  return { code: "TICKET_PRUNED", pruned: result.pruned, persisted };
}

export interface TicketReportEntry {
  id: string;
  ptyId: string;
  directory: string;
  workspaceId: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt?: number;
  state: "active" | "consumed" | "expired";
}

export interface TicketsReport {
  version: 1;
  path: string;
  total: number;
  active: number;
  consumed: number;
  expired: number;
  tickets: TicketReportEntry[];
}

export type ReportTicketsResult =
  | TicketsReport
  | { code: "TICKET_STORE_ERROR"; path: string; reason: string };

/**
 * 台账视图(纯读)。state 用 now=Date.now() 判定:
 * 已消费 → consumed(即使已过期也算 consumed);未消费且 now > expiresAt → expired;其余 active。
 */
export function reportTickets(root: string): ReportTicketsResult {
  const path = ticketsPath(root);
  const loaded = loadTickets(root);
  if (!loaded.ok) return { code: STORE_ERROR, path, reason: loaded.reason };

  const now = Date.now();
  const entries: TicketReportEntry[] = [];
  let active = 0;
  let consumed = 0;
  let expired = 0;

  const allTickets: Record<string, StreamTicket> = loaded.tickets.tickets;
  for (const ticket of Object.values(allTickets)) {
    const state: TicketReportEntry["state"] =
      ticket.consumedAt !== undefined ? "consumed" : now > ticket.expiresAt ? "expired" : "active";
    if (state === "consumed") consumed += 1;
    else if (state === "expired") expired += 1;
    else active += 1;

    const entry: TicketReportEntry = {
      id: ticket.id,
      ptyId: ticket.binding.ptyId,
      directory: ticket.binding.directory,
      workspaceId: ticket.binding.workspaceId,
      issuedAt: ticket.issuedAt,
      expiresAt: ticket.expiresAt,
      state,
    };
    if (ticket.consumedAt !== undefined) entry.consumedAt = ticket.consumedAt;
    entries.push(entry);
  }

  entries.sort((a, b) => a.issuedAt - b.issuedAt || a.id.localeCompare(b.id));

  return {
    version: 1,
    path,
    total: entries.length,
    active,
    consumed,
    expired,
    tickets: entries,
  };
}
