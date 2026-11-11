/**
 * 会话消息队列持久化(fixI 续作,「重启即丢」根治)。
 * 背景:队列此前是 startGatewayServer 里的内存 Map,gateway 重启后 per-session 排队消息
 * 全部丢失(面板 hello.queue 也随之为空)。本模块把「队列变更落 journal」与「启动回放」
 * 从 server.ts 抽出成纯函数,便于单测;server.ts 只负责在变更出口调用。
 * 事件:kind="queue.sync",payload={sessionId, items}。items=该会话当期**全量**队列快照
 * (不是增量 delta)——回放按「每会话最后一条快照为准」,天然自愈重复/乱序/中间态丢失。
 * 已发送项识别:队列项出队提交时,任务带 idempotencyKey=`queue.<sessionId>.<itemId>`(见
 * queueItemKey)。回放时若 journal 里存在该键的 task.* 事件,说明这条消息已经变成任务
 * (无论当前是终态还是被重启收编),队列里不该再排它,否则重启会二次执行用户消息。
 */
import type { Journal, JournalEvent } from "@lampgenie/core";
import type { QueueItem } from "@lampgenie/protocol";

/**
 * 队列项的可选 inbox 元数据(扩展而非改 protocol——QueueItem 本体零改动)。
 * 旧 journal 没有这些字段时按「pending + 旧行为」逐字恢复,天然向后兼容。
 */
export interface QueueItemInboxFields {
 /** 归属(归属决议见 runtime/session/durable-inbox 的 resolveOwner;缺省 "unowned")。 */
  ownerId?: string;
 /** 调用方幂等键(admit 用;不进任务 idempotencyKey,后者仍是 queue.<sid>.<id>)。 */
  idempotencyKey?: string;
 /** 载荷指纹(同 key 异指纹=冲突)。 */
  fingerprint?: string;
  admittedSeq?: number;
  promotedSeq?: number;
  delivery?: "pending" | "delivered";
}

/** 带 inbox 元数据的队列项(gateway 内部类型;广播帧仍是超级集,zod 读端按未知字段丢弃)。 */
export type QueueItemWithInbox = QueueItem & QueueItemInboxFields;

/** 队列项的幂等键前缀:出队提交时写到任务的 idempotencyKey 上,回放据此识别「已发送」。 */
export const QUEUE_IDEM_PREFIX = "queue.";

/** 某个队列项对应的任务幂等键。带 sessionId 命名空间:itemId 生成的随机性不作为唯一保证,
 * 跨会话同 id(计数器/低熵随机)会让后提交的消息被幂等去重静默丢弃——这是本任务要消灭的失败模式。 */
export function queueItemKey(sessionId: string, itemId: string): string {
  return `${QUEUE_IDEM_PREFIX}${sessionId}.${itemId}`;
}

/** 队列变更落账:写当期全量快照(items 已按队列顺序排列,首项=队头)。 */
export function writeQueueSync(journal: Journal, sessionId: string, items: readonly QueueItemWithInbox[]): void {
  journal.append({
    kind: "queue.sync",
    sessionId,
    payload: { sessionId, items: [...items] },
  });
}

/** 形状校验:回放只信结构完整的项(手改/跨版本残留的坏数据静默丢弃,不猜)。
 * inbox 可选元数据必须显式透传——本函数是白名单式重建,漏一个字段等于
 * 「写进去了但回放读不到」,重启后 owner/水位全部归零(接线测试假绿的经典坑)。 */
function asQueueItem(value: unknown): QueueItemWithInbox | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const id = typeof v.id === "string" ? v.id : "";
  const sessionId = typeof v.sessionId === "string" ? v.sessionId : "";
  const instruction = typeof v.instruction === "string" ? v.instruction : "";
  if (!id || !sessionId || !instruction) return null;
  const num = (x: unknown): number | undefined =>
    typeof x === "number" && Number.isFinite(x) ? x : undefined;
  return {
    id,
    sessionId,
    instruction,
    createdAt: typeof v.createdAt === "number" ? v.createdAt : Date.now(),
    ...(typeof v.projectId === "string" ? { projectId: v.projectId } : {}),
    ...(Array.isArray(v.attachments) ? { attachments: v.attachments as QueueItem["attachments"] } : {}),
    ...(typeof v.ownerId === "string" && v.ownerId ? { ownerId: v.ownerId } : {}),
    ...(typeof v.idempotencyKey === "string" && v.idempotencyKey ? { idempotencyKey: v.idempotencyKey } : {}),
    ...(typeof v.fingerprint === "string" && v.fingerprint ? { fingerprint: v.fingerprint } : {}),
    ...(num(v.admittedSeq) !== undefined ? { admittedSeq: num(v.admittedSeq) } : {}),
    ...(num(v.promotedSeq) !== undefined ? { promotedSeq: num(v.promotedSeq) } : {}),
    ...(v.delivery === "pending" || v.delivery === "delivered" ? { delivery: v.delivery } : {}),
  };
}

/** 已提交判定:该 itemId 的幂等键在 journal 里出现过(任务已存在,含被重启收编的 cancelled)。 */
function collectSubmittedKeys(events: JournalEvent[]): Set<string> {
  const keys = new Set<string>();
  for (const ev of events) {
    if (!ev.kind.startsWith("task.")) continue;
    const p = ev.payload as { idempotencyKey?: unknown } | undefined;
    const key = p && typeof p.idempotencyKey === "string" ? p.idempotencyKey : "";
    if (key.startsWith(QUEUE_IDEM_PREFIX)) keys.add(key);
  }
  return keys;
}

/**
 * 启动回放:重建 per-session 队列。
 * - 快照语义:同会话后写的 queue.sync 覆盖先写的(只保留最后一条)。
 * - 已提交项(任务已存在)与形状非法的项丢弃。
 * - :delivery==="delivered" 的项不恢复(已放行=已交给执行器,重启再排会二次执行);
 * 旧 journal 无该字段则视为 pending,逐字沿用旧行为。
 * - 空队列的会话不收(与运行期 map.delete 语义一致)。
 */
export function restoreQueues(journal: Journal): Map<string, QueueItemWithInbox[]> {
  const events = journal.readAll();
  const snapshots = new Map<string, QueueItemWithInbox[]>();
  for (const ev of events) {
    if (ev.kind !== "queue.sync") continue;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const sessionId = typeof p.sessionId === "string" && p.sessionId ? p.sessionId : ev.sessionId;
    const raw = Array.isArray(p.items) ? p.items : [];
    const items: QueueItemWithInbox[] = [];
    for (const entry of raw) {
      const item = asQueueItem(entry);
      if (item) items.push(item);
    }
    snapshots.set(sessionId, items); // 后写覆盖:最后一条快照为准
  }
  const submitted = collectSubmittedKeys(events);
  const out = new Map<string, QueueItemWithInbox[]>();
  for (const [sessionId, items] of snapshots) {
    const kept = items.filter(
      (it) => it.delivery !== "delivered" && !submitted.has(queueItemKey(it.sessionId, it.id)),
    );
    if (kept.length > 0) out.set(sessionId, kept);
  }
  return out;
}