/**
 *  一次性流票据(mechanisms「WebView 直连 WS 的一次性票据鉴权」)。
 * 问题:WebView / 移动端直连 WS 时带不了 Basic Auth;把长期密码拼进 URL 参数会随日志、
 * 历史、代理缓存外泄,并且换终端、换工作目录后仍然有效(重放面很大)。
 * 口径:
 *  - 普通鉴权(带路径)先换一张一次性 ticket(UUID,默认 TTL 60s),WS 握手只带 ticket;
 *  - ticket **绑定** ptyId + directory + workspaceId 三元组:三者任一与打开 WS 的会话不符
 *    → TICKET_BINDING_MISMATCH 且**不消费**(票仍可用,便于纠正后重试);
 *  - **原子消费**:一张票只能成功换一次流;成功即置 consumedAt,同票再来即 TICKET_REPLAY;
 *  - 过期票(now > expiresAt)即使没用过也一次性作废并标记 consumedAt,避免"过期后又复活";
 *    now === expiresAt 仍算有效(闭区间,避免边界抖动);
 *  - pruneExpired 只清「过期且从未消费」的票;已消费票保留(可回答 replay 而不是 not-found,
 *    也符合"过期票也被标记"的口径);
 *  - stats.active 只是「consumedAt === undefined」的计数,**不判 TTL**(纯视图,不是可用性判定)。
 * 本文件全是纯逻辑:无 IO、不取 Date.now(),时间一律由参数 now 传入,便于单测与回放。
 * store 一律不可变更新:每次写入都复制 tickets 记录(既有 ticket 对象不被原地改写),
 * 入参 binding 也先复制再落库。
 */
import { randomUUID } from "node:crypto";

/** 票据绑定的上下文:换票时的会话三元组,消费时必须逐字相等。 */
export interface TicketBinding {
  ptyId: string;
  directory: string;
  workspaceId: string;
}

/** 一张一次性票据。consumedAt 一旦存在即视为已用(TTL 内外都不可再次放行)。 */
export interface StreamTicket {
  id: string;
  binding: TicketBinding;
  issuedAt: number;
  expiresAt: number;
  consumedAt?: number;
}

/** 票据库(可由上层持久化到 registry / 内存;本文件只做纯写账)。 */
export interface TicketStore {
  tickets: Record<string, StreamTicket>;
}

/** 票据缺省有效期:60 秒(够一次 WS 握手,不够一次重放窗口)。 */
export const STREAM_TICKET_TTL_MS = 60_000;

/** 票据机制的全部结果码(便于上层穷举/断言,不散字符串)。 */
export const TICKET_CODES = [
  "TICKET_INVALID",
  "TICKET_ISSUED",
  "TICKET_CONSUMED",
  "TICKET_REPLAY",
  "TICKET_EXPIRED",
  "TICKET_NOT_FOUND",
  "TICKET_BINDING_MISMATCH",
  "TICKET_NO_TICKET",
  "TICKET_PRUNED",
] as const;

export type TicketCode = (typeof TICKET_CODES)[number];

export interface IssueTicketOptions {
  binding: TicketBinding;
  now: number;
  ttlMs?: number;
  idFactory?: () => string;
}

export type IssueTicketResult =
  | { ok: true; code: "TICKET_ISSUED"; ticket: StreamTicket }
  | { ok: false; code: "TICKET_INVALID"; reason: string };

export interface ConsumeTicketOptions {
  ticketId: string;
  binding: TicketBinding;
  now: number;
}

export interface ConsumeTicketResult {
  ok: boolean;
  code: TicketCode;
  ticketId: string;
  ticket?: StreamTicket;
  reason?: string;
}

export interface AllowUrlTicketOptions {
  url: string;
  store: TicketStore;
  now: number;
  /** 打开 WS 的真实会话上下文(pty/dir/ws)。给了就以它为准;缺省回退到 url 的 query。 */
  binding?: TicketBinding;
}

export interface AllowUrlTicketResult {
  allowed: boolean;
  code: TicketCode;
  ticketId: string;
  ticket?: StreamTicket;
  reason?: string;
}

export interface PruneExpiredResult {
  code: "TICKET_PRUNED";
  pruned: string[];
}

export interface TicketStats {
  total: number;
  active: number;
  consumed: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * binding 判别:三个字段都必须是非空字符串。
 * undefined / null / 缺字段 / 空串 / 纯空白 一律不合法。
 */
export function isTicketBinding(value: unknown): value is TicketBinding {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isNonEmptyString(v.ptyId) &&
    isNonEmptyString(v.directory) &&
    isNonEmptyString(v.workspaceId)
  );
}

function sameBinding(a: TicketBinding, b: unknown): b is TicketBinding {
  if (!isTicketBinding(b)) return false;
  return a.ptyId === b.ptyId && a.directory === b.directory && a.workspaceId === b.workspaceId;
}

/** 生成/复制一个新 store 记录(不可变更新:既有 ticket 对象保持原样)。 */
function writeTicket(store: TicketStore, ticket: StreamTicket): void {
  store.tickets = { ...store.tickets, [ticket.id]: ticket };
}

/**
 * 换票:普通鉴权通过后调用。
 * 非法 binding / 非法 ttl / 非法 now → TICKET_INVALID,且**不写 store**(不留半张票)。
 */
export function issueTicket(
  store: TicketStore,
  options: IssueTicketOptions): IssueTicketResult {
  const { binding, now, ttlMs, idFactory } = options ?? ({} as IssueTicketOptions);

  if (!isTicketBinding(binding)) {
    return {
      ok: false,
      code: "TICKET_INVALID",
      reason: "binding 非法:ptyId/directory/workspaceId 必须都是非空字符串",
    };
  }

  const ttl = ttlMs === undefined ? STREAM_TICKET_TTL_MS : ttlMs;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) {
    return { ok: false, code: "TICKET_INVALID", reason: "ttlMs 必须是有限正数" };
  }

  if (typeof now !== "number" || !Number.isFinite(now)) {
    return { ok: false, code: "TICKET_INVALID", reason: "now 必须是有限数字" };
  }

  const id = idFactory === undefined ? randomUUID() : idFactory();
  if (!isNonEmptyString(id)) {
    return { ok: false, code: "TICKET_INVALID", reason: "票据 id 必须是非空字符串" };
  }

  const ticket: StreamTicket = {
    id,
    // 复制入参,避免调用方后续改写 binding 影响已发出的票。
    binding: {
      ptyId: binding.ptyId,
      directory: binding.directory,
      workspaceId: binding.workspaceId,
    },
    issuedAt: now,
    expiresAt: now + ttl,
  };

  writeTicket(store, ticket);
  return { ok: true, code: "TICKET_ISSUED", ticket };
}

/**
 * 原子消费:一张票只能成功换一次流。
 * 判定顺序固定(先存在 → 已消费 → 过期 → 绑定 → 成功),任一步不通过都不进入下一步:
 *  ① 无此票 → TICKET_NOT_FOUND
 *  ② consumedAt 已存在 → TICKET_REPLAY(不重复置位)
 *  ③ now > expiresAt → 置 consumedAt=now 后返回 TICKET_EXPIRED(过期票也被标记)
 *  ④ binding 三字段任一不等 → TICKET_BINDING_MISMATCH 且**不消费**
 *  ⑤ 匹配 → 置 consumedAt=now 返回 ok:true / TICKET_CONSUMED
 */
export function consumeTicket(
  store: TicketStore,
  options: ConsumeTicketOptions): ConsumeTicketResult {
  const { ticketId, binding, now } = options ?? ({} as ConsumeTicketOptions);
  const id = typeof ticketId === "string" ? ticketId : "";

  const existing = store.tickets[id];
  if (existing === undefined) {
    return { ok: false, code: "TICKET_NOT_FOUND", ticketId: id, reason: "票据不存在" };
  }

  if (existing.consumedAt !== undefined) {
    return {
      ok: false,
      code: "TICKET_REPLAY",
      ticketId: id,
      ticket: existing,
      reason: "票据已被消费",
    };
  }

  const consumed: StreamTicket = { ...existing, consumedAt: now };

  if (now > existing.expiresAt) {
    writeTicket(store, consumed);
    return {
      ok: false,
      code: "TICKET_EXPIRED",
      ticketId: id,
      ticket: consumed,
      reason: "票据已过期",
    };
  }

  if (!sameBinding(existing.binding, binding)) {
    return {
      ok: false,
      code: "TICKET_BINDING_MISMATCH",
      ticketId: id,
      ticket: existing,
      reason: "票据绑定与请求会话不匹配",
    };
  }

  writeTicket(store, consumed);
  return { ok: true, code: "TICKET_CONSUMED", ticketId: id, ticket: consumed };
}

/**
 * WS 握手/查询串放行判定:从 url 的 `ticket` 查询参数取票并原子消费。
 * url 允许绝对地址也允许相对路径(以 http://ticket.local 为基),解析失败 → TICKET_INVALID;
 * 缺参/空参 → TICKET_NO_TICKET(不消费任何票);只有 code === TICKET_CONSUMED 才 allowed。
 * 绑定上下文优先用调用方给的真实会话三元组(binding),缺省才回退到 url 的 query
 * (CLI/手测方便;真实 handler 必须传 binding,不能信 URL 自报的上下文)。
 */
export function allowUrlTicket(options: AllowUrlTicketOptions): AllowUrlTicketResult {
  const { url, store, now, binding } = options ?? ({} as AllowUrlTicketOptions);

  if (typeof url !== "string") {
    return { allowed: false, code: "TICKET_INVALID", ticketId: "", reason: "url 必须是字符串" };
  }

  let parsed: URL;
  try {
    parsed = new URL(url, "http://ticket.local");
  } catch {
    return { allowed: false, code: "TICKET_INVALID", ticketId: "", reason: "url 无法解析" };
  }

  const raw = parsed.searchParams.get("ticket");
  if (raw === null || raw.trim().length === 0) {
    return { allowed: false, code: "TICKET_NO_TICKET", ticketId: "", reason: "url 未带 ticket" };
  }

  const result = consumeTicket(store, {
    ticketId: raw.trim(),
    binding: isTicketBinding(binding) ? binding : bindingFromUrl(parsed),
    now,
  });
  return {
    allowed: result.code === "TICKET_CONSUMED",
    code: result.code,
    ticketId: result.ticketId,
    ...(result.ticket === undefined ? {} : { ticket: result.ticket }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}

/**
 * 从 url 里取绑定上下文(query: ptyId / directory / workspaceId),缺项留空串,
 * 由 consumeTicket 的绑定比对给出 TICKET_BINDING_MISMATCH(不在这里另造错误码)。
 */
function bindingFromUrl(parsed: URL): TicketBinding {
  return {
    ptyId: parsed.searchParams.get("ptyId") ?? "",
    directory: parsed.searchParams.get("directory") ?? "",
    workspaceId: parsed.searchParams.get("workspaceId") ?? "",
  };
}

/**
 * 清理「过期且从未消费」的票(已消费票保留,便于回答 replay 而非 not-found)。
 * 幂等:同一 now 连调两次,第二次 pruned 为空。
 */
export function pruneExpired(store: TicketStore, now: number): PruneExpiredResult {
  const pruned: string[] = [];
  const next: Record<string, StreamTicket> = {};

  for (const [id, ticket] of Object.entries(store.tickets)) {
    if (now > ticket.expiresAt && ticket.consumedAt === undefined) {
      pruned.push(id);
      continue;
    }
    next[id] = ticket;
  }

  store.tickets = next;
  return { code: "TICKET_PRUNED", pruned };
}

/**
 * 票据库视图计数。active 只数 consumedAt === undefined,**不判 TTL**
 * (过期未消费的票在 pruneExpired 之前仍计入 active)。
 */
export function stats(store: TicketStore): TicketStats {
  const entries = Object.values(store.tickets);
  const consumed = entries.filter((t) => t.consumedAt !== undefined).length;
  return { total: entries.length, active: entries.length - consumed, consumed };
}
