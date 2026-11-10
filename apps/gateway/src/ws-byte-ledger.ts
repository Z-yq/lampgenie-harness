/**
 * WS 发送字节账本(g3,2026-11)。
 * 背景:网关五次 heap OOM,崩栈全部指向 JSON.stringify,但一直没有「谁在发大帧」的字节级证据
 * (只有帧数级指标与 bufferedAmount 瞬时值)。本模块给 safeSend 挂一个纯内存账本:
 *  - 每帧只记 type + Buffer.byteLength(UTF-8 实发字节),O(1)、无序列化、无分配风暴;
 *  - 30s 落一次账(journal custom 事件 + 一行 console),窗口内零帧不落(不发空账);
 *  - snapshot 按 bytes 降序给 top 帧型 + 单帧峰值 → 下次 OOM 前能指名道姓是哪个 type。
 * 纯函数/纯内存:不 import 任何 I/O,时钟可注入,可单测(见 test/ws-byte-ledger.test.ts)。
 */
import type { Journal } from "@lampgenie/core";

/** 单帧型的聚合行。 */
export interface WsLedgerTypeRow {
  type: string;
  frames: number;
  bytes: number;
  maxFrameBytes: number;
}

/** 账本快照(窗口内累计;since=窗口起点)。 */
export interface WsLedgerSnapshot {
  totalFrames: number;
  totalBytes: number;
  /** 背压丢帧(未实发):帧数与字节分开计,避免污染 byType 的实发口径。 */
  droppedFrames: number;
  droppedBytes: number;
  byType: WsLedgerTypeRow[];
  peak: { type: string; bytes: number } | null;
  since: number;
}

/** 落账结果(便于单测断言「是否落了」)。 */
export interface WsLedgerFlushResult {
  flushed: boolean;
  at: number;
  snapshot: WsLedgerSnapshot;
}

const UNKNOWN_TYPE = "?";
/** journal 落账的 byType 只带前 N 行(防事件本身变成大帧)。 */
const LEDGER_JOURNAL_TOP = 10;
/** console 摘要只带前 N 行。 */
const LEDGER_LOG_TOP = 5;

function normalizeType(type: unknown): string {
  const t = typeof type === "string" ? type.trim() : "";
  return t.length > 0 ? t : UNKNOWN_TYPE;
}

/** 人类可读字节(日志用;不参与判定)。 */
function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/**
 * WS 发送字节账本:纯内存,caller 负责周期 flush。
 * 非有限/负 bytes 忽略(不计帧、不计字节);type 缺省/空白归一为 "?"。
 */
export class WsByteLedger {
  private rows = new Map<string, WsLedgerTypeRow>();
  private frames = 0;
  private bytes = 0;
  private droppedFrames = 0;
  private droppedBytes = 0;
  private peak: { type: string; bytes: number } | null = null;
  private windowStart: number;

  constructor(private readonly now: () => number = Date.now) {
    this.windowStart = this.now();
  }

  /** 记录一帧。dropped=true 表示背压丢帧(未实发):只进丢帧计数,不进 byType。 */
  record(type: string, bytes: number, dropped = false): void {
    const n = typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : -1;
    if (n < 0) return; // 非有限/负值:忽略(脏数据不能污染峰值与排序)
    const t = normalizeType(type);
    if (dropped) {
      this.droppedFrames += 1;
      this.droppedBytes += n;
      return;
    }
    this.frames += 1;
    this.bytes += n;
    const row = this.rows.get(t);
    if (row) {
      row.frames += 1;
      row.bytes += n;
      if (n > row.maxFrameBytes) row.maxFrameBytes = n;
    } else {
      this.rows.set(t, { type: t, frames: 1, bytes: n, maxFrameBytes: n });
    }
    if (!this.peak || n > this.peak.bytes) this.peak = { type: t, bytes: n };
  }

  /** 快照(byType 按 bytes 降序;bytes 相同按帧数降序,再按 type 字典序,稳定可测)。 */
  snapshot(): WsLedgerSnapshot {
    const byType = [...this.rows.values()]
      .map((r) => ({ ...r }))
      .sort((a, b) => b.bytes - a.bytes || b.frames - a.frames || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
    return {
      totalFrames: this.frames,
      totalBytes: this.bytes,
      droppedFrames: this.droppedFrames,
      droppedBytes: this.droppedBytes,
      byType,
      peak: this.peak ? { ...this.peak } : null,
      since: this.windowStart,
    };
  }

  /** 清空并开启新窗口(since 重置为当前时刻)。 */
  reset(): void {
    this.rows.clear();
    this.frames = 0;
    this.bytes = 0;
    this.droppedFrames = 0;
    this.droppedBytes = 0;
    this.peak = null;
    this.windowStart = this.now();
  }
}

/**
 * 周期落账(可注入,便于单测):窗口内零帧 → 跳过(不回空账、不空转日志);
 * 有帧 → console.log 一行紧凑摘要(top5 by bytes)+ journal append 一条 custom 事件。
 * 落账后 reset,窗口语义 = 相邻两次 flush 之间。
 */
export function flushWsLedger(ledger: WsByteLedger, journal: Journal, nowMs: number): WsLedgerFlushResult {
  const snapshot = ledger.snapshot();
  if (snapshot.totalFrames + snapshot.droppedFrames === 0) {
    return { flushed: false, at: nowMs, snapshot };
  }
  const top = snapshot.byType.slice(0, LEDGER_LOG_TOP);
  const parts = top.map((r) => `${r.type}=${fmtBytes(r.bytes)}/${r.frames}f(max ${fmtBytes(r.maxFrameBytes)})`);
  const peak = snapshot.peak ? `${snapshot.peak.type}@${fmtBytes(snapshot.peak.bytes)}` : "none";
  const dropped = snapshot.droppedFrames > 0 ? ` drop=${snapshot.droppedFrames}f/${fmtBytes(snapshot.droppedBytes)}` : "";
  console.log(
    `[gateway] ws 发送账本 ${Math.max(0, Math.round((nowMs - snapshot.since) / 1000))}s: frames=${snapshot.totalFrames} bytes=${fmtBytes(snapshot.totalBytes)} peak=${peak}${dropped} | ${parts.join(" ")}`,
  );
  try {
    journal.append({
      kind: "custom",
      sessionId: "system",
      payload: {
        type: "ws.ledger",
        totalFrames: snapshot.totalFrames,
        totalBytes: snapshot.totalBytes,
        droppedFrames: snapshot.droppedFrames,
        droppedBytes: snapshot.droppedBytes,
        byType: snapshot.byType.slice(0, LEDGER_JOURNAL_TOP),
        peak: snapshot.peak,
        at: nowMs,
      },
    });
  } catch {
    /* 观测落账失败不影响发送路径 */
  }
  ledger.reset();
  return { flushed: true, at: nowMs, snapshot };
}

/** 落账周期(生产):30s。 */
export const WS_LEDGER_FLUSH_MS = 30_000;
