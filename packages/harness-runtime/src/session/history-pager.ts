/**
 * session.history 分页 + 增量回放(纯逻辑,零 IO、不抛错、不可变、确定性)。
 * 为什么需要 atLogEpoch + delta ring:
 * - 面板长会话翻页/追平时会带上上次回包的 atRevision(会话水位)与 atLogEpoch(网关进程启动时间)。
 * ring 保存最近若干页的行,若客户端水位仍落在 ring 的批次边界内,只需回 seq>atRevision 的增量,
 * 不必重发整页——轮询场景下省掉大量重复历史帧。
 * - epoch 解决「网关重启/journal 重载」:进程换了,ring 是空的,但客户端还拿着旧 revision;
 * 若只看 revision 会误判「可增量」(新进程的 seq 可能从 1 重新分配或日志被 restore 回退),
 * 所以 epoch 不等一律回整页并标 reset,让面板丢弃本地缓存重建。
 */

/** 分页只需要事件的最小字段面(journal JournalEvent 结构兼容)。 */
export interface SessionEventLike {
  seq: number;
  kind?: string;
  time?: number;
  sessionId?: string;
  payload?: unknown;
}

/** 分页行:稳定 rowId = `${sessionId}:${seq}`,前端可据此做 keyed diff。 */
export interface HistoryRow {
  rowId: string;
  seq: number;
  kind: string;
  time: number;
  payload: unknown;
}

export interface PageHistoryOptions {
  sessionId: string;
 /** 单页条数上限,钳到 [1,2000];缺省 500。 */
  limit?: number;
 /** 只取 seq<beforeSeq 的行(向后翻页游标);缺省=取全局最末 limit 条。 */
  beforeSeq?: number;
}

export interface HistoryPage {
 /** 按 seq 升序。 */
  rows: HistoryRow[];
 /** 还有更早行时给出(本页最小 seq);必须严格小于 beforeSeq,否则前端 loop 会死转。 */
  nextBeforeSeq?: number;
 /** 会话当前水位(= 会话内最大 seq;空会话=0),供客户端下次带 atRevision。 */
  atRevision: number;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

/** 稳定行 id:同一会话内 seq 唯一 ⇒ rowId 唯一。 */
export function rowIdOf(sessionId: string, seq: number): string {
  return `${sessionId}:${seq}`;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * 取一页历史行。
 * - 行按 seq 升序;beforeSeq 在场只取 seq<beforeSeq 的尾页;
 * - limit 钳 [1,2000];
 * - atRevision 取会话内最大 seq(空会话=0),与本次翻到哪一页无关——客户端游标始终指向会话最新水位。
 */
export function pageHistory(events: readonly SessionEventLike[], options: PageHistoryOptions): HistoryPage {
  const { sessionId } = options;
  const limit = clampLimit(options.limit);
  const before = typeof options.beforeSeq === "number" && Number.isFinite(options.beforeSeq)
    ? options.beforeSeq
    : Number.POSITIVE_INFINITY;

  const scoped: SessionEventLike[] = [];
  for (const event of events) {
    if (!event || typeof event.seq !== "number" || !Number.isFinite(event.seq)) continue;
    if (sessionId !== undefined && event.sessionId !== sessionId) continue;
    scoped.push(event);
  }
 // 确定性:输入顺序不可信(并发写/合并日志),一律按 seq 升序。
  scoped.sort((a, b) => a.seq - b.seq);
  const atRevision = scoped.length > 0 ? scoped[scoped.length - 1]!.seq : 0;
  const older = scoped.filter((event) => event.seq < before);
  const window = older.slice(Math.max(0, older.length - limit));

  const rows: HistoryRow[] = window.map((event) => ({
    rowId: rowIdOf(sessionId, event.seq),
    seq: event.seq,
    kind: typeof event.kind === "string" ? event.kind : "custom",
    time: typeof event.time === "number" ? event.time : 0,
    payload: event.payload,
  }));

  let nextBeforeSeq: number | undefined;
  if (rows.length > 0 && older.length > rows.length) {
    const minSeq = rows[0]!.seq;
    if (minSeq < before) nextBeforeSeq = minSeq;
  }
  return nextBeforeSeq === undefined ? { rows, atRevision } : { rows, nextBeforeSeq, atRevision };
}

/* --------------------------------------------------------------------------------------------
 * Delta ring:每个会话保存最近若干页的行,并按「批次边界 revision」判定增量可回放性。
 * 客户端上次回包的 atRevision 一定等于某次 push 的 revision;找不到这个边界(被容量淘汰 /
 * 重启后空 ring / revision 已回退)= 不可增量,调用方回整页。
 * ------------------------------------------------------------------------------------------ */

interface RingBatch {
  revision: number;
  rows: HistoryRow[];
}

interface RingSession {
  batches: RingBatch[];
  rowCount: number;
}

export interface DeltaRingStats {
 /** 已登记会话数。 */
  sessions: number;
 /** 存留行数(含跨批次重复的边界行时按实际存储计)。 */
  rows: number;
 /** 每会话行数上限。 */
  maxRows: number;
 /** 存留批次数(每次 push 一个边界)。 */
  revisions: number;
}

/**
 * 有界增量环。容量按「行数」计:超出 maxRows 时从最旧批次开始淘汰,批次的 revision 边界随之消失,
 * 老游标自然落到 ring-miss(回到整页),不会出现「半截增量」。
 */
export class DeltaRing {
  private readonly maxRows: number;
  private readonly sessions = new Map<string, RingSession>();

  constructor(maxRows = 200) {
    this.maxRows = typeof maxRows === "number" && Number.isFinite(maxRows) && maxRows >= 1
      ? Math.floor(maxRows)
      : 200;
  }

 /** 提交一页行。revision 应与 pageHistory 的 atRevision 同源(会话最大 seq)。 */
  push(sessionId: string, rows: readonly HistoryRow[], revision: number): void {
    if (!sessionId || typeof revision !== "number" || !Number.isFinite(revision)) return;
    const incoming: HistoryRow[] = [];
    const seen = new Set<number>();
    for (const row of rows ?? []) {
      if (!row || typeof row.seq !== "number") continue;
      if (seen.has(row.seq)) continue;
      seen.add(row.seq);
      incoming.push(row);
    }
    incoming.sort((a, b) => a.seq - b.seq);

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { batches: [], rowCount: 0 };
      this.sessions.set(sessionId, session);
    }
    const last = session.batches[session.batches.length - 1];
 // 同一 revision 再次 push(翻更早的页)合并进同一批次:边界不变,回放时按 seq>revision 过滤。
    if (last && last.revision === revision) {
      for (const row of incoming) {
        if (last.rows.some((r) => r.seq === row.seq)) continue;
        last.rows.push(row);
        session.rowCount += 1;
      }
      last.rows.sort((a, b) => a.seq - b.seq);
    } else {
      session.batches.push({ revision, rows: incoming });
      session.rowCount += incoming.length;
    }
    this.trim(session);
  }

 /**
 * 回放 revision 之后的行(seq>revision,按 seq 升序)。
 * revision 不是任何存留批次的边界(或已超出当前水位)→ null,表示不可增量。
 */
  replaySince(sessionId: string, revision: number): HistoryRow[] | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.batches.length === 0) return null;
    if (typeof revision !== "number" || !Number.isFinite(revision)) return null;
 // revision 单调不减,同值合并进最后批次;仍按倒序找最近的边界,防止 restore 回退造成的旧值残留。
    let index = -1;
    for (let i = session.batches.length - 1; i >= 0; i -= 1) {
      if (session.batches[i]!.revision === revision) { index = i; break; }
    }
    if (index < 0) return null;
    const latest = session.batches[session.batches.length - 1]!.revision;
    if (revision > latest) return null;
    if (index === session.batches.length - 1) return [];
    const out: HistoryRow[] = [];
    const seen = new Set<number>();
    for (let i = index + 1; i < session.batches.length; i += 1) {
      for (const row of session.batches[i]!.rows) {
        if (row.seq <= revision || seen.has(row.seq)) continue;
        seen.add(row.seq);
        out.push(row);
      }
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

 /** 清空指定会话(缺省=全部);网关删除会话时调用。 */
  reset(sessionId?: string): void {
    if (sessionId === undefined) this.sessions.clear();
    else this.sessions.delete(sessionId);
  }

  stats(): DeltaRingStats {
    let rows = 0;
    let revisions = 0;
    for (const session of this.sessions.values()) {
      rows += session.rowCount;
      revisions += session.batches.length;
    }
    return { sessions: this.sessions.size, rows, maxRows: this.maxRows, revisions };
  }

  private trim(session: RingSession): void {
    while (session.rowCount > this.maxRows && session.batches.length > 1) {
      const dropped = session.batches.shift()!;
      session.rowCount -= dropped.rows.length;
    }
    const sole = session.batches[0];
    if (sole && sole.rows.length > this.maxRows) {
      const cut = sole.rows.length - this.maxRows;
      sole.rows.splice(0, cut);
      session.rowCount -= cut;
    }
  }
}

/* --------------------------------------------------------------------------------------------
 * 游标校验:决定这次回包走「增量」还是「整页(reset)」。
 * ------------------------------------------------------------------------------------------ */

export type CursorMode = "delta" | "full";
export type CursorReason = "no-cursor" | "epoch-mismatch" | "ring-miss" | "ok";

export interface HistoryCursor {
 /** 上次回包的会话水位;缺省=无游标(旧行为)。 */
  atRevision?: number;
 /** 上次回包的网关进程 epoch。 */
  atLogEpoch?: number;
}

export interface CursorContext {
 /** 会话当前水位(本次 pageHistory.atRevision)。 */
  currentRevision: number;
 /** 本进程 epoch(网关启动时取 Date.now)。 */
  currentEpoch: number;
 /** 该 revision 之后能否完整回放(由调用方用 DeltaRing.replaySince 适配)。 */
  canReplay?: (revision: number) => boolean;
}

export interface CursorVerdict {
  mode: CursorMode;
  reason: CursorReason;
}

/**
 * 规则(顺序即优先级):
 * 1) 无 atRevision → full/no-cursor(老客户端逐字不变);
 * 2) 带了 atLogEpoch 且不等于当前 epoch → full/epoch-mismatch(网关重启/journal 重载);
 * 3) atRevision 超过当前水位 → full/ring-miss(日志回退/伪造游标);
 * 4) ring 可覆盖该 revision → delta/ok;
 * 5) 其余 → full/ring-miss。
 */
export function validateHistoryCursor(cursor: HistoryCursor = {}, context: CursorContext): CursorVerdict {
  const raw = cursor?.atRevision;
  const atRevision = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : undefined;
  if (atRevision === undefined) return { mode: "full", reason: "no-cursor" };
  if (cursor.atLogEpoch !== undefined && cursor.atLogEpoch !== context.currentEpoch) {
    return { mode: "full", reason: "epoch-mismatch" };
  }
  if (atRevision > context.currentRevision) return { mode: "full", reason: "ring-miss" };
  if (context.canReplay && context.canReplay(atRevision)) return { mode: "delta", reason: "ok" };
  return { mode: "full", reason: "ring-miss" };
}
