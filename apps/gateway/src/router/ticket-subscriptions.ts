/**
 * 生产 dispatch 的正式订阅表合成(纯逻辑,零 IO)。
 * 为什么需要这一层:
 * thread-subscription 模型把「跟读」与「投递资格」拆开了,但生产 dispatch 之前只传
 * 旧的 liveSubscriptions 布尔表,gate 因此一直走旧分支——新订阅机制没有默认生效。
 * 这里把现有事实源(open Ticket + liveSubscriptions)合成为 route 订阅表,交给 gate;
 * 不改任何持久化形状,也不引入新的授权口径:
 * - phase="open" 且 threadKey 非空的 Ticket → 一条 route 订阅(承接任务即 owner lane);
 * - liveSubscriptions 里为 true 且未被 Ticket 覆盖的 threadKey → 合成一条 live route 订阅。
 * 纪律:零 import(除类型)、不 throw、不可变、确定性(同输入同输出,输出按 threadKey 排序)。
 */
import type { Ticket } from "./model.js";
import type { ThreadSubscription } from "@lampgenie/runtime/agent/thread-subscription";

export interface TicketSubscriptionOptions {
 /** 缺省 0(与 gate 的 now 兜底口径一致);仅用于 createdAt 缺失时的 since/createdAt 与 live 条目时间。 */
  now?: number;
}

const TICKET_ID_PREFIX = "ticket:";
const LIVE_ID_PREFIX = "live:";
const LIVE_SUBSCRIBER = "live";

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 兼容 Map 与普通可迭代集合;非法输入折叠成空表(不 throw)。 */
function ticketValues(src: Iterable<Ticket> | ReadonlyMap<string, Ticket | undefined> | null | undefined): Ticket[] {
  if (src === null || src === undefined) return [];
  const valuesFn = (src as { values?: unknown }).values;
  if (typeof valuesFn === "function") {
    const out: Ticket[] = [];
    for (const t of (src as ReadonlyMap<string, Ticket | undefined>).values()) {
      if (t !== undefined) out.push(t);
    }
    return out;
  }
  const iter = (src as Iterable<Ticket>)[Symbol.iterator];
  if (typeof iter !== "function") return [];
  return [...(src as Iterable<Ticket>)];
}

/** 兼容 Map 与 plain object(Record<string, boolean>);非法输入折叠成空表(不 throw)。 */
function liveEntries(src: ReadonlyMap<string, boolean> | Record<string, boolean> | null | undefined): Array<[string, boolean]> {
  if (src === null || src === undefined) return [];
  const entriesFn = (src as { entries?: unknown }).entries;
  if (typeof entriesFn === "function") return [...(src as ReadonlyMap<string, boolean>).entries()];
  return Object.entries(src as Record<string, boolean>);
}

/** 确定性比较:按 threadKey → id 升序(不依赖 locale)。 */
function compareSubscriptions(a: ThreadSubscription, b: ThreadSubscription): number {
  if (a.threadKey !== b.threadKey) return a.threadKey < b.threadKey ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * 合成 route 订阅表:open Ticket 优先(同 threadKey 取 ticketId 字典序最小,确定性),
 * 未被覆盖的 liveSubscriptions=true 再补一条 live 条目;输出按 threadKey 排序。
 */
export function subscriptionsFromTickets(
  tickets: Iterable<Ticket> | ReadonlyMap<string, Ticket | undefined> | null | undefined,
  liveSubscriptions?: ReadonlyMap<string, boolean> | Record<string, boolean> | null,
  opts?: TicketSubscriptionOptions): ThreadSubscription[] {
  const at = isFiniteNumber(opts?.now) ? opts!.now! : 0;

 // threadKey → 选中的 Ticket(同键多 Ticket 取 ticketId 字典序最小)
  const picked = new Map<string, Ticket>();
  for (const ticket of ticketValues(tickets)) {
    if (ticket === null || typeof ticket !== "object") continue;
    if (ticket.phase !== "open") continue;
    if (!isNonEmptyString(ticket.threadKey)) continue;
    if (!isNonEmptyString(ticket.ticketId)) continue;
    const prev = picked.get(ticket.threadKey);
    if (prev === undefined || ticket.ticketId < prev.ticketId) picked.set(ticket.threadKey, ticket);
  }

  const out: ThreadSubscription[] = [];
  for (const ticket of picked.values()) {
    const since = isFiniteNumber(ticket.createdAt) ? ticket.createdAt : at;
    out.push({
      id: `${TICKET_ID_PREFIX}${ticket.ticketId}`,
      threadKey: ticket.threadKey,
      subscriber: typeof ticket.sessionId === "string" ? ticket.sessionId : LIVE_SUBSCRIBER,
      mode: "route",
      wakePolicy: "immediate",
      since,
      createdAt: since,
      generation: 1,
      decisionHistory: [],
    });
  }

  for (const [threadKey, live] of liveEntries(liveSubscriptions)) {
    if (live !== true) continue;
    if (!isNonEmptyString(threadKey)) continue;
    if (picked.has(threadKey)) continue;
    out.push({
      id: `${LIVE_ID_PREFIX}${threadKey}`,
      threadKey,
      subscriber: LIVE_SUBSCRIBER,
      mode: "route",
      wakePolicy: "immediate",
      since: at,
      createdAt: at,
      generation: 1,
      decisionHistory: [],
    });
  }

  return out.sort(compareSubscriptions);
}

/** 一行摘要(诊断用,≤160 字;不 throw)。 */
export function describeSubscription(sub: ThreadSubscription | null | undefined): string {
  if (sub === null || sub === undefined || typeof sub !== "object") return "(invalid subscription)";
  const parts: string[] = [
    String(sub.id ?? "?"),
    String(sub.threadKey ?? "?"),
    `${String(sub.mode ?? "?")}/${String(sub.wakePolicy ?? "?")}`,
    `since=${String(sub.since ?? "?")}`,
    `gen=${String(sub.generation ?? "?")}`,
  ];
  if (sub.until !== undefined) parts.push(`until=${String(sub.until)}`);
  if (sub.superseded === true) parts.push("superseded");
  const line = parts.join(" ");
  return line.length <= 160 ? line : `${line.slice(0, 157)}...`;
}
