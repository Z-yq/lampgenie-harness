/**
 * 事件日志的读写实现:内存版 + JSONL 文件版。
 * 内存版用于测试;文件版用于 gateway 运行时。
 */
import { appendFileSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile as readFileAsync, readdir as readdirAsync } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JournalEvent, NewEvent, EventListener } from "./types.js";
import { redactEventPayload } from "./redact.js";

/** 热窗默认容量(g2 journal 热窗冷卸,2026-11):最近使用/最近追加的 N 个会话整会话常驻。 */
const DEFAULT_HOT_SESSIONS = 20;
/** 热窗默认字节预算(g2 字节配额,2026-11):产线热窗里 2 个巨型会话文件(23.5MB+41MB)解析成
 *  事件对象后 ≈138MB 堆,单靠「条数」约束(N=20)挡不住单会话巨型文件。默认 64MB,0=不限(旧行为)。 */
const DEFAULT_HOT_BYTES = 64 * 1_048_576;
/** readAll 冷会话 hydration 小缓存容量:防同一批 readAll 反复解同一冷文件。 */
const HYDRATION_CACHE_SIZE = 2;
/** 启动加载期每隔多少条事件做一次热窗淘汰(防逐事件淘汰 = O(n²) 反复过滤 events)。 */
const EVICT_EVERY = 2048;

/** 热窗容量:GENIE_JOURNAL_HOT_SESSIONS 覆盖;0=关闭热窗(行为与旧实现逐字一致);非法值→默认 20。 */
function resolveHotSessions(override?: number): number {
  if (override !== undefined) return Math.max(0, Math.floor(override));
  const raw = process.env.GENIE_JOURNAL_HOT_SESSIONS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_HOT_SESSIONS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_HOT_SESSIONS;
  return Math.floor(n);
}

/** 热窗字节预算:GENIE_JOURNAL_HOT_BYTES 覆盖(单位字节;0=不限,即只按 N 的旧行为);非法值→默认 64MB。
 *  语义:按 mtime 从新到旧累计会话文件字节直到预算用尽;单会话自身超预算 1/2 则整会话不纳入热集合
 *  (它仍可冷回读,功能不受影响),避免一个巨型会话吃掉整个预算。 */
function resolveHotBytes(override?: number): number {
  if (override !== undefined) return Math.max(0, Math.floor(override));
  const raw = process.env.GENIE_JOURNAL_HOT_BYTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_HOT_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_HOT_BYTES;
  return Math.floor(n);
}

/** 恒常驻事件:跨会话 kind(global.jsonl,产线实测约 2.5% 字节)与无 sessionId 事件——永不淘汰。 */
function isAlwaysResident(event: JournalEvent): boolean {
  return !event.sessionId || CROSS_SESSION_KINDS.has(event.kind);
}

/** seq 去重 + 升序排列(同 seq 保留 time 较新者,与 load 端双写去重口径一致)。 */
function dedupeBySeq(events: JournalEvent[]): JournalEvent[] {
  if (events.length <= 1) return events.slice();
  const bySeq = new Map<number, JournalEvent>();
  for (const event of events) {
    const seq = Number(event.seq);
    if (!Number.isFinite(seq)) continue;
    const prev = bySeq.get(seq);
    if (!prev || (event.time ?? 0) >= (prev.time ?? 0)) bySeq.set(seq, event);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * 会话槽(g2 热窗冷卸的核心数据结构)。
 * - 热会话:events 持有本会话**全部**事件(含头部首条;deriveMessages/autoCompactGate 依赖整会话)。
 * - 冷会话(evicted=true):events 只留恒常驻子集(跨会话 kind)+ 冷卸后新追加的尾巴;
 *   会话域历史按需从 files 回读(seq 升序归并,含头部)。
 */
interface SessionSlot {
  events: JournalEvent[];
  evicted: boolean;
  firstSeq: number;
  lastSeq: number;
  /** 冷会话回读的磁盘定位(会话域事件可能分布在 legacy 单文件 + sessions/<sid>.jsonl)。 */
  files: Set<string>;
  /** 冷会话在磁盘上的会话域事件条数(流式加载登记的元数据,仅诊断/统计用)。 */
  count?: number;
}

/** 解析后的来源文件(load 归并用;path 供冷会话回读定位)。 */
interface ParsedSource {
  path: string;
  events: JournalEvent[];
  bytes: number;
}

/** 流式加载的文件角色:global(全量驻留)/legacy(分片前单文件历史)/hot(热会话分文件)/cold(冷会话分文件)。 */
type ScanRole = "global" | "legacy" | "hot" | "cold";

/** 冷会话槽元数据(流式加载:事件对象丢弃,只留回读定位;count 仅诊断)。 */
interface ColdMeta {
  firstSeq: number;
  lastSeq: number;
  count: number;
  files: Set<string>;
  /** 同会话上一条 seq(检测外部改动导致的非单调;非单调只降级读取策略)。 */
  lastSeenSeq: number;
}

/** 单文件扫描产物(流式加载只统计字节/行数,不留事件数组)。 */
interface ScanTally {
  bytes: number;
  lines: number;
}

/** 扫描产物累加。 */
function addTally(into: ScanTally, part: ScanTally | null): void {
  if (!part) return;
  into.bytes += part.bytes;
  into.lines += part.lines;
}

/** 写前持久化屏障(M24)的严格清队失败:消息带 target/bytes,cause 保留底层错误。
 *  与 flush() 的 best-effort 语义互不影响(停机路径仍走 flush,不抛)。 */
export class JournalFlushError extends Error {
  readonly target: string;
  readonly bytes: number;
  constructor(target: string, bytes: number, cause?: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause ?? "");
    super(`journal 落盘失败: target=${target} bytes=${bytes}${reason ? ` (${reason})` : ""}`);
    this.name = "JournalFlushError";
    this.target = target;
    this.bytes = bytes;
  }
}

/** 日志核心:不管存哪,接口一致。 */
export interface Journal {
  /** 追加一条事件,返回分配好 seq/time 的完整事件。 */
  append<T>(event: NewEvent<T>): JournalEvent<T>;
  /** 批量追加:一次落盘,返回本轮实际写入的事件(顺序与入参顺序一致)。 */
  appendMany<T>(events: NewEvent<T>[]): JournalEvent<T>[];
  /** 按顺序读出全部事件(可选从某个 seq 之后)。 */
  readAll(sinceSeq?: number): JournalEvent[];
  /** 读出某会话的事件(per-session 增量索引,不扫全量;可选从某个 seq 之后)。
   * fixF1(2026-10-19 面板卡+重连风暴):session.status 等高频读路径此前走 readAll 全量
   * (产线 30MB/28k 行 × 每次两遍 map),事件循环被同步全扫占死→ws 心跳排队超时→面板判死重连。 */
  readSession(sessionId: string, sinceSeq?: number): JournalEvent[];
  /** 订阅新事件(只在同一进程内有效)。 */
  subscribe(listener: EventListener): () => void;
  /** 写前持久化屏障(M24,fail-closed):把已记录但未落盘的事件同步落盘;失败**抛错**且不清队。
   *  可选——旧实现/测试假 journal 没有它,调用方按 no-op 处理(零回归);flush() 仍是 best-effort。 */
  flushStrict?(): void | Promise<void>;
  /** 当前水位(= 下一个 seq)。消费面把 length 当水位用(server.ts seqBefore、search.ts 增量判定),
   *  g2 热窗后 events[] 不再持有冷会话事件,故水位口径统一为 seqHigh+1(见 BaseJournal.length)。 */
  readonly length: number;
}

abstract class BaseJournal implements Journal {
  /** 常驻事件(seq 升序):热窗关闭=全部;开启=恒常驻(跨会话 kind/无 sessionId)+ 热会话事件。 */
  protected events: JournalEvent[] = [];
  private listeners = new Set<EventListener>();
  protected seenIdempotencyKeys = new Set<string>();
  /** 幂等键 → 事件对象(重复 append 必须返回同一事件;键只占行数约 1%,可接受常驻)。 */
  protected idempotentEvents = new Map<string, JournalEvent>();
  // fixF1: per-session 事件索引(写入/加载时挂链,存引用——与 events 同一对象,每事件≈一个指针):
  // readSession 走索引切片,高频路径不再 readAll 全量扫。同会话 seq 随全局写入序严格递增,
  // 二分可用;加载发现 seq 断档(journal 被外部动过)则退化为线性过滤(正确优先)。
  // g2 热窗:冷会话的槽只留元数据(firstSeq/lastSeq/files)+ 恒常驻子集,不再持有会话域事件对象。
  protected sessionIndex = new Map<string, SessionSlot>();
  protected sessionIndexStrict = true;
  /** 历史最大 seq(2026-10-21 修复):events.length 在存在重复 seq/断档时 ≠ 下一个合法 seq。
   *  旧实现用 events.length 分配 → 与历史 seq 相撞 → 重启按 seq 去重时把新事件当重复丢掉
   *  (实锤:丢失 assistant 消息 → 只剩 tool 结果 → LLM 400 tool_calls 配对错)。 */
  protected seqHigh = -1;
  /** 热窗容量(0=关闭):最近使用/最近追加的 N 个会话常驻,其余会话整会话冷卸。 */
  protected readonly hotSessions: number;
  /** 热窗字节预算(0=不限):启动选热文件时按 mtime 从新到旧累计文件字节直到用尽。 */
  protected readonly hotBytes: number;
  /** 热集合 LRU(Map 插入序 = 热度,尾部最新;淘汰取头部)。 */
  private hotOrder = new Map<string, true>();
  /** readAll 冷会话 hydration 小缓存(LRU,容量 HYDRATION_CACHE_SIZE)。 */
  private hydration = new Map<string, JournalEvent[]>();
  /** 启动批量入账期暂缓淘汰(逐事件淘汰 = 反复 O(n) 过滤 events)。 */
  private suppressEvict = false;

  protected constructor(opts?: { hotSessions?: number; hotBytes?: number }) {
    this.hotSessions = resolveHotSessions(opts?.hotSessions);
    this.hotBytes = resolveHotBytes(opts?.hotBytes);
  }

  /**
   * 水位 = 下一个 seq(g2 热窗登记,2026-11)。
   * 旧实现返回 events.length:热窗启用后 events[] 只是驻留子集,数不出水位;seqHigh 才是权威分配源
   * (append 用 ++seqHigh),故 length=seqHigh+1。无重复 seq/断档时两者相等,现有断言口径不变。
   */
  get length(): number {
    return this.seqHigh + 1;
  }

  /** 下一个 seq 水位(与 length 同口径,给不便用 getter 的调用方)。 */
  journalLength(): number {
    return this.seqHigh + 1;
  }

  append<T>(event: NewEvent<T>): JournalEvent<T> {
    if (event.idempotencyKey && this.seenIdempotencyKeys.has(event.idempotencyKey)) {
      // 幂等命中:返回已有事件,不重复写入。
      const existing = this.idempotentEvents.get(event.idempotencyKey)
        ?? this.findColdIdempotent(event.idempotencyKey)
        ?? this.events.find((e) => e.idempotencyKey === event.idempotencyKey);
      return existing as JournalEvent<T>;
    }
    const full = this.buildEvent(event);
    this.persist(full);
    for (const listener of this.listeners) listener(full);
    return full;
  }

  /**
   * 批量追加:整批合并为一次落盘。
   * - 空数组:立即返回 [],不触发任何 fs 调用。
   * - 幂等键已被占用的条目:跳过(不落盘/不计入返回值/不派发),判定口径与 append 一致。
   * - 其余条目一次 appendFileSync 写入,再按 append 同语义派发。
   */
  appendMany<T>(events: NewEvent<T>[]): JournalEvent<T>[] {
    if (events.length === 0) return [];
    const landed: JournalEvent<T>[] = [];
    for (const event of events) {
      if (event.idempotencyKey && this.seenIdempotencyKeys.has(event.idempotencyKey)) continue;
      landed.push(this.buildEvent(event));
    }
    if (landed.length === 0) return [];
    this.persistMany(landed);
    for (const full of landed) {
      for (const listener of this.listeners) listener(full);
    }
    return landed;
  }

  /**
   * 读出全部事件(g2 热窗,2026-11):热窗关闭时 = events 过滤(旧行为逐字一致);
   * 开启且存在冷会话时,按会话把会话域事件从磁盘补齐(走 HYDRATION_CACHE_SIZE 小缓存,不改热集合),
   * 与常驻事件按 seq 升序归并 —— 语义与今天一致,**不会静默漏掉冷会话事件**。
   * 已知成本:调用涉及冷会话时会解析其来源文件(见报告「readAll 冷会话补齐的 IO 成本」);
   * 返回的临时数组调用结束后可被 GC(缓存只留 HYDRATION_CACHE_SIZE 个会话)。
   */
  readAll(sinceSeq = 0): JournalEvent[] {
    const resident = this.events.filter((e) => e.seq >= sinceSeq);
    if (this.hotSessions <= 0) return resident;
    const cold: Array<[string, SessionSlot]> = [];
    for (const [sid, slot] of this.sessionIndex) {
      if (!slot.evicted) continue;
      if (slot.lastSeq < sinceSeq) continue; // 整会话都在水位下:无需回读
      cold.push([sid, slot]);
    }
    if (cold.length === 0) return resident;
    const out = resident;
    this.beginColdBulkRead();
    try {
      for (const [sid, slot] of cold) {
        for (const e of this.mergeColdEvents(sid, slot).extra) {
          if (e.seq >= sinceSeq) out.push(e);
        }
      }
    } finally {
      this.endColdBulkRead();
    }
    out.sort((a, b) => a.seq - b.seq);
    // 双写历史里同一 seq 可能同时躺在两个会话文件/legacy 里(两个网关进程的独立计数器):
    // 旧实现全量归并时按 seq 全局去重,热窗下跨会话的重复只有在这里才看得见——按相邻 seq 去重,
    // 常驻副本优先(sort 稳定,常驻事件先入数组),与旧口径「一个 seq 一条事件」保持一致。
    let w = 1;
    for (let i = 1; i < out.length; i++) {
      if (out[i]!.seq === out[w - 1]!.seq) continue;
      out[w++] = out[i]!;
    }
    out.length = Math.min(out.length, Math.max(w, 0));
    return out;
  }

  // fixF1: 会话索引切片(二分下界+slice 拷贝,防调用方改索引内数组);索引缺席=[]。
  // g2 热窗:冷会话按需回读 sessions/<sid>.jsonl(含头部首条),读后按 LRU 提升为热(超限再淘汰)。
  readSession(sessionId: string, sinceSeq = 0): JournalEvent[] {
    const slot = this.sessionIndex.get(sessionId);
    if (!slot) return [];
    if (!slot.evicted) {
      this.touchHot(sessionId);
      return this.sliceSession(slot.events, sinceSeq);
    }
    const merged = this.mergeColdEvents(sessionId, slot).merged;
    this.promoteHot(sessionId, slot, merged);
    return this.sliceSession(merged, sinceSeq);
  }

  /** 按 sinceSeq 切会话列表(严格=二分;非单调历史=线性过滤,正确优先)。 */
  private sliceSession(list: JournalEvent[], sinceSeq: number): JournalEvent[] {
    if (!this.sessionIndexStrict) return list.filter((e) => e.seq >= sinceSeq);
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.seq < sinceSeq) lo = mid + 1;
      else hi = mid;
    }
    return list.slice(lo);
  }

  /** 会话索引挂链(buildEvent 与 load/loadChunked 共用的唯一入账点)。
   *  file = 该事件在磁盘上的来源文件(冷会话回读定位;追加路径由子类 diskFileOf 提供)。 */
  protected indexSession(event: JournalEvent, file?: string): void {
    if (!event.sessionId) return; // 无会话归属:只进 events[],不进会话索引
    const key = event.sessionId;
    let slot = this.sessionIndex.get(key);
    if (!slot) {
      slot = { events: [event], evicted: false, firstSeq: event.seq, lastSeq: event.seq, files: new Set<string>() };
      this.sessionIndex.set(key, slot);
    } else {
      slot.events.push(event);
      slot.lastSeq = event.seq;
    }
    const src = file ?? this.diskFileOf(event);
    if (src) slot.files.add(src);
    this.touchHot(key);
  }

  /** 统一入账(append 与启动回放共用):events[] + 会话索引 + 水位 + 幂等键。 */
  protected ingest(event: JournalEvent, file?: string): void {
    this.events.push(event);
    this.indexSession(event, file);
    if (event.seq > this.seqHigh) this.seqHigh = event.seq;
    if (event.idempotencyKey) {
      this.seenIdempotencyKeys.add(event.idempotencyKey);
      this.idempotentEvents.set(event.idempotencyKey, event);
    }
  }

  // ── 热窗冷卸(子类钩子)───────────────────────────────────────────────────────
  /** 是否支持冷会话回读(只有落盘的 FileJournal 支持;内存版永不淘汰)。 */
  protected coldEvictionSupported(): boolean {
    return false;
  }
  /** 追加路径的事件落点(冷会话回读定位);内存版无磁盘=null。 */
  protected diskFileOf(_event: JournalEvent): string | null {
    return null;
  }
  /** 冷会话会话域事件回读(子类实现;按 seq 升序由调用方再归并去重)。 */
  protected readSessionFromDisk(_sessionId: string, _slot: SessionSlot): JournalEvent[] | null {
    return null;
  }
  /** 整会话即将冷卸(子类可先把该会话的 write-behind 队列同步落盘,防回读丢尾巴)。 */
  protected onSessionEvicted(_sessionId: string): void {
    /* 默认无操作 */
  }
  /** readAll 批量冷回读开始/结束(子类可开一次性文件解析缓存,避免同一共享文件被逐会话重复解析)。 */
  protected beginColdBulkRead(): void {
    /* 默认无操作 */
  }
  protected endColdBulkRead(): void {
    /* 默认无操作 */
  }
  /** 幂等键命中但事件对象已随冷会话丢弃(流式加载只留字符串键):子类可从磁盘回读原事件。
   *  默认拿不到(=旧口径:内存版永不淘汰,keys 与对象同生同灭)。 */
  protected findColdIdempotent(_key: string): JournalEvent | undefined {
    return undefined;
  }
  /** 流式加载收尾:按会话最近 seq 重排热集合(尾部最新;已冷卸会话不入热集合)。
   *  保证「mtime 选出来的热文件」在 LRU 里也是热的,不被入账顺序误淘汰。
   *  只收「真持有会话域事件」的槽:只有跨会话 kind 的会话(如仅在 global.jsonl 出现 task.enqueue 的会话)
   *  不属于热窗成员——它们的常驻子集本来就永不淘汰,计进热会话数会让画像/淘汰口径失真。 */
  protected rebuildHotOrder(): void {
    if (this.hotSessions <= 0) return;
    const live = this.hotCandidates();
    this.hotOrder = new Map(live.map(([sid]) => [sid, true] as [string, true]));
  }

  /** 热集合候选:未冷卸且持有会话域事件的槽,按最后活跃 seq 升序(尾部最新)。 */
  protected hotCandidates(): Array<[string, SessionSlot]> {
    return [...this.sessionIndex.entries()]
      .filter(([, slot]) => !slot.evicted && slot.events.some((e) => !isAlwaysResident(e)))
      .sort((a, b) => a[1].lastSeq - b[1].lastSeq);
  }

  /** 流式加载收尾:把不在热集合里的会话整会话冷卸。
   *  启动期是 suppressEvict(不逐事件淘汰),热集合由子类按「热文件」定,这里一次收敛到窗口内——
   *  不能交给 evictOverflow 的入账顺序 LRU 去裁,否则 mtime 选出的热会话会被误淘汰。 */
  protected evictColdSessions(): void {
    if (!this.coldEvictionSupported()) return;
    for (const sid of [...this.sessionIndex.keys()]) {
      if (this.hotOrder.has(sid)) continue;
      const slot = this.sessionIndex.get(sid);
      if (!slot || slot.evicted) continue;
      this.evictSession(sid);
    }
  }

  /** LRU 触碰:标记最近使用/追加,超限则整会话淘汰(不得腰斩单个会话)。 */
  private touchHot(sessionId: string): void {
    if (this.hotSessions <= 0) return;
    this.hotOrder.delete(sessionId);
    this.hotOrder.set(sessionId, true);
    if (!this.suppressEvict) this.evictOverflow();
  }

  /** 超出热窗容量时按 LRU 整会话冷卸(头部与尾巴一起走,读时整段回读)。 */
  private evictOverflow(): void {
    if (!this.coldEvictionSupported()) return;
    while (this.hotOrder.size > this.hotSessions) {
      const oldest = this.hotOrder.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.hotOrder.delete(oldest);
      this.evictSession(oldest);
    }
  }

  /** 整会话冷卸:会话域事件对象全部丢引用,恒常驻子集(跨会话 kind)留下。 */
  private evictSession(sessionId: string): void {
    const slot = this.sessionIndex.get(sessionId);
    if (!slot || slot.evicted) return;
    const keep: JournalEvent[] = [];
    const dropped = new Set<JournalEvent>();
    for (const event of slot.events) {
      if (isAlwaysResident(event)) keep.push(event);
      else dropped.add(event);
    }
    if (dropped.size === 0) return; // 只有恒常驻事件:无可卸(不占热窗)
    this.onSessionEvicted(sessionId); // 先把该会话未落盘的尾巴同步落盘
    slot.events = keep;
    slot.evicted = true;
    this.hydration.delete(sessionId);
    this.events = this.events.filter((e) => !dropped.has(e));
  }

  /** 冷会话提升为热(读完磁盘历史后整会话常驻;超限再淘汰别人)。 */
  private promoteHot(sessionId: string, slot: SessionSlot, merged: JournalEvent[]): void {
    this.insertResident(merged.filter((e) => !isAlwaysResident(e)));
    slot.events = merged;
    slot.evicted = false;
    this.hydration.delete(sessionId);
    this.touchHot(sessionId);
  }

  /** 把一批(按 seq 升序)事件并入常驻数组,保持 events 全局 seq 升序(同 seq 以常驻副本为准)。 */
  private insertResident(extra: JournalEvent[]): void {
    if (extra.length === 0) return;
    const base = this.events;
    const merged: JournalEvent[] = new Array(base.length + extra.length);
    let i = 0;
    let j = 0;
    let k = 0;
    while (i < base.length || j < extra.length) {
      const a = base[i];
      const b = extra[j];
      if (b === undefined || (a !== undefined && a.seq < b.seq)) merged[k++] = a!, i++;
      else if (a === undefined || b.seq < a.seq) merged[k++] = b, j++;
      else merged[k++] = a, i++, j++; // 同 seq:常驻副本权威
    }
    merged.length = k;
    this.events = merged;
  }

  /**
   * 冷会话归并:磁盘会话域事件 + 槽内恒常驻子集/冷卸后尾巴,按 seq 升序去重。
   * extra = 仅磁盘来的那份(供 readAll 追加,避免与常驻事件重复)。
   */
  private mergeColdEvents(sessionId: string, slot: SessionSlot): { merged: JournalEvent[]; extra: JournalEvent[] } {
    const disk = this.hydrateColdSession(sessionId, slot);
    const resident = slot.events;
    const merged: JournalEvent[] = [];
    const extra: JournalEvent[] = [];
    let i = 0;
    let j = 0;
    while (i < disk.length || j < resident.length) {
      const a = i < disk.length ? disk[i]! : undefined;
      const b = j < resident.length ? resident[j]! : undefined;
      if (b === undefined || (a !== undefined && a.seq < b.seq)) {
        merged.push(a!);
        extra.push(a!);
        i++;
      } else if (a === undefined || b.seq < a.seq) {
        merged.push(b);
        j++;
      } else {
        merged.push(b); // 同 seq:常驻副本权威
        i++;
        j++;
      }
    }
    return { merged, extra };
  }

  /** 冷会话磁盘回读(小 LRU 缓存;只取会话域事件,恒常驻子集走内存). */
  private hydrateColdSession(sessionId: string, slot: SessionSlot): JournalEvent[] {
    const cached = this.hydration.get(sessionId);
    if (cached) {
      this.hydration.delete(sessionId);
      this.hydration.set(sessionId, cached);
      return cached;
    }
    let raw: JournalEvent[] | null = null;
    try {
      raw = this.readSessionFromDisk(sessionId, slot);
    } catch (err) {
      console.error(`[journal] 冷会话回读失败 ${sessionId}:`, err);
      raw = null;
    }
    const clean = raw ? dedupeBySeq(raw.filter((e) => !isAlwaysResident(e))) : [];
    this.hydration.set(sessionId, clean);
    while (this.hydration.size > HYDRATION_CACHE_SIZE) {
      const oldest = this.hydration.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.hydration.delete(oldest);
    }
    return clean;
  }

  /** 启动批量入账:暂缓逐事件淘汰,按 EVICT_EVERY 周期性淘汰一次,末尾再收敛一次。 */
  protected beginBulkIngest(): void {
    this.suppressEvict = true;
  }
  protected bulkIngestTick(ingested: number): void {
    if (!this.suppressEvict || this.hotSessions <= 0 || ingested % EVICT_EVERY !== 0) return;
    this.suppressEvict = false;
    this.evictOverflow();
    this.suppressEvict = true;
  }
  protected endBulkIngest(): void {
    this.suppressEvict = false;
    this.evictOverflow();
  }

  /** 热窗诊断(测试/探针):热会话数、已冷卸会话数、驻留事件数、水位、字节预算。 */
  hotWindowStats(): {
    hotLimit: number; hotLimitBytes: number; hotSessions: number; coldSessions: number; residentEvents: number; seqHigh: number;
  } {
    let coldSessions = 0;
    for (const slot of this.sessionIndex.values()) if (slot.evicted) coldSessions++;
    return {
      hotLimit: this.hotSessions,
      hotLimitBytes: this.hotBytes,
      hotSessions: this.hotOrder.size,
      coldSessions,
      residentEvents: this.events.length,
      seqHigh: this.seqHigh,
    };
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 构造完整事件并登记(seq 递增 + 幂等键入账);append 与 appendMany 共用此逻辑。 */
  private buildEvent<T>(event: NewEvent<T>): JournalEvent<T> {
    // 轨迹追踪 P1-B 脱敏切面(2026-10-29):唯一入账点做一次 payload 脱敏,append/appendMany/
    // write-behind/sharded/内存版全部经由本函数 → 一处覆盖全部落盘与派发路径(读旧数据不重写)。
    // 只处理有限键(tool.call.arguments / tool.result.content 等),**idempotencyKey 不碰**;
    // 开关 GENIE_JOURNAL_REDACT=0 全关;失败静默(脱敏绝不能挡住事件落盘)。
    let landed: NewEvent<T> = event;
    try {
      const r = redactEventPayload((event as { payload?: unknown }).payload);
      if (r.redacted) landed = { ...event, payload: r.payload } as NewEvent<T>;
    } catch { /* 脱敏旁路:任何异常都以原文入账,不打断主链 */ }
    const full: JournalEvent<T> = {
      ...landed,
      seq: ++this.seqHigh,
      time: event.time ?? Date.now(),
    };
    this.ingest(full, this.diskFileOf(full) ?? undefined); // 统一入账:events + 会话索引 + 热窗 LRU
    return full;
  }

  /** 子类决定怎么落盘(或不落盘)。 */
  protected abstract persist(event: JournalEvent): void;

  /** 批量落盘:默认逐条 persist;子类可覆写为一次写入。 */
  protected persistMany(events: JournalEvent[]): void {
    for (const event of events) this.persist(event);
  }
}

/** 内存版:测试用,不落盘。 */
export class MemoryJournal extends BaseJournal {
  // 2026-11-05 g2 收尾:基类构造器改 protected 后,MemoryJournal(被 app.ts/llm-loop-backend 直接
  // new)必须显式声明 public 构造器(否则继承 protected 无法实例化——TS2674)。
  constructor(opts?: { hotSessions?: number; hotBytes?: number }) {
    super(opts);
  }
  protected persist(): void {
    // 故意为空。
  }
  /** 写前屏障(M24)内存版:无落盘面,no-op(接口要求在场,语义等价「永远成功」)。 */
  flushStrict(): void {
    // 故意为空。
  }
}

/** 文件版 JSONL:默认单文件追加;可选 writeBehind(异步批量落盘)+ sharded(按会话分文件)。
 *  2026-10-21 卡顿修复:write-behind——逐事件 appendFileSync 同步写 9p 阻塞事件循环(三会话并发
 *  实测消息刷新卡顿)。开启后内存为权威源(readAll/readSession 立即可见),文件只作崩溃恢复:
 *  微任务批合并 + fs.promises.appendFile 异步写;失败回退同步写保数据;进程退出时同步清队列。
 *  2026-10-21 抄 ZCode session-store:sharded——跨会话小 kind 写 global.jsonl,会话肥 kind 写
 *  sessions/<sid>.jsonl;旧 gateway.jsonl 冻结只读。load 端无论模式,只要 global/sessions 在场
 *  就并入归并(seq 全局排序),关掉 sharded 后回写 gateway.jsonl 的新事件同样可读(双向可退)。
 *  内存模型/readAll/readSession/subscribe 语义与单文件完全一致——上层零改动。 */

/** 跨会话 kind(写 global.jsonl):体积画像实测仅 ~2.5% 字节,但被 track/dashboard/subagents/
 *  checkpoint/goal 等跨会话消费点读取;其余(会话肥 kind,~84%)只被单会话读路径消费。 */
const CROSS_SESSION_KINDS = new Set([
  "task.enqueue", "task.start", "task.progress", "task.done", "task.fail", "task.deleted", "task.project.clear",
  "queue.sync", "checkpoint.create", "checkpoint.restore",
  "subagent.spawn", "subagent.result", "subagent.backgrounded",
  "goal.set", "board.update", "workflow.run.start", "workflow.run.done", "workflow.ask",
  "companion.notice", "companion.relay", "super.notice", "super.relay", "review.findings", "automation.run", "custom",
  "model.switch",
  // 板质量遥测(2026-11-05):基线表/看板跨会话读 → global.jsonl。
  "board.audit", "board.skeleton",
]);

/** 会话文件名清洗(与 llm-trace 目录同款口径):路径不安全字符归一为 _。 */
function sessionFileName(sessionId: string): string {
  return String(sessionId).replace(/[^a-zA-Z0-9._:-]/g, "_") + ".jsonl";
}

export class FileJournal extends BaseJournal {
  private filePath: string;
  private wb = false;
  private sharded = false;
  private globalFile: string;
  private sessionDir: string;
  /** M123(2026-11-08)归档目录:已归档的 sessions/<sid>.jsonl 冷读兜底(load 不扫它)。 */
  private archiveDir: string | undefined;
  /** M123 归档冷读开关:缺省 false = boot 期零额外 IO(行为逐字等于未配置 archiveDir);
   *  宿主装配完成后显式开启,只有用户读会话这类显式路径才回读归档副本(实测归档 422MB 后
   *  boot 期内部 readSession 把 29 个归档文件全 parse,6 分钟仍在装配)。 */
  private archiveReadsEnabled = false;

  /** 开启归档冷读(boot 装配完成后由宿主显式调用;未调用前 readSession/冷读兜底都不碰 archiveDir)。 */
  enableArchiveReads(): void {
    this.archiveReadsEnabled = true;
  }
  /** write-behind per-file 队列:目标路径 → 待写字节行。单文件模式下恒只有一项(语义与旧版一致)。 */
  private wbQueues = new Map<string, string[]>();
  private wbFlushScheduled = false;
  /** 同步 load 或 async loadChunked 是否已完成;deferLoad 构造时为 false。 */
  private loaded = false;
  /** legacy 单文件(gateway.jsonl)里出现过的会话:热窗冷卸后回读要把 legacy 一并解析。 */
  private legacySids = new Set<string>();
  /** 冷会话里出现过的幂等键 → 会话 id(流式加载只留键,不留事件对象;命中时按 sid 回盘取原事件)。 */
  private coldIdemKeys = new Map<string, string>();
  /** 流式加载时 mtime 选出的热会话 id(热集合收尾时优先保留它们)。 */
  private streamHotSids = new Set<string>();

  constructor(
    filePath: string,
    opts?: {
      writeBehind?: boolean; sharded?: boolean; deferLoad?: boolean; hotSessions?: number; hotBytes?: number;
      /** M123:归档目录(缺省 undefined = 行为逐字同旧版)。冷启动 load 不扫它,只有冷读兜底会看。 */
      archiveDir?: string;
    },
  ) {
    // g2 热窗:默认 20(env GENIE_JOURNAL_HOT_SESSIONS 覆盖;0=关闭,行为与旧实现逐字一致)。
    // g2 字节配额:默认 64MB(env GENIE_JOURNAL_HOT_BYTES 覆盖;0=不限)。
    super({ hotSessions: opts?.hotSessions, hotBytes: opts?.hotBytes });
    this.filePath = filePath;
    this.wb = opts?.writeBehind === true;
    this.sharded = opts?.sharded === true;
    this.globalFile = join(dirname(filePath), "global.jsonl");
    this.sessionDir = join(dirname(filePath), "sessions");
    this.archiveDir = opts?.archiveDir;
    if (this.wb) {
      process.on("exit", () => this.wbFlushAllSync());
    }
    if (!opts?.deferLoad) this.load();
  }

  /** 事件的目标文件:sharded 关=恒单文件;开=跨会话 kind→global,其余→会话文件(无 sessionId 兜底 global)。 */
  private targetOf(event: JournalEvent): string {
    if (!this.sharded) return this.filePath;
    if (CROSS_SESSION_KINDS.has(event.kind) || !event.sessionId) return this.globalFile;
    return join(this.sessionDir, sessionFileName(String(event.sessionId)));
  }

  // ── g2 热窗冷卸:FileJournal 侧钩子(回读定位/回读/淘汰前落盘)──────────────────
  protected override coldEvictionSupported(): boolean {
    return true;
  }

  protected override diskFileOf(event: JournalEvent): string | null {
    return this.targetOf(event);
  }

  /** 冷会话里的幂等键命中:按登记到的 sid 从磁盘回读原事件(只发生在重复 append 同 key 时,冷路径)。 */
  protected override findColdIdempotent(key: string): JournalEvent | undefined {
    const sid = this.coldIdemKeys.get(key);
    if (sid === undefined) return undefined;
    const hit = this.readSession(sid).find((e) => e.idempotencyKey === key);
    if (hit) this.coldIdemKeys.delete(key); // 回读即转常驻,后续命中走 idempotentEvents
    return hit;
  }

  /** 热集合候选(流式加载口径):**先 mtime 选出来的热文件会话**,再按最后活跃 seq 补齐,
   *  只留前 hotSessions 个 —— 保证热窗成员就是「文件系统上最新的 N 个会话」,不因未归并复写顺序漂移。 */
  protected override hotCandidates(): Array<[string, SessionSlot]> {
    const live = super.hotCandidates();
    if (this.streamHotSids.size === 0) return live;
    const picked = live.filter(([sid]) => this.streamHotSids.has(sid));
    const rest = live.filter(([sid]) => !this.streamHotSids.has(sid));
    return [...picked, ...rest].slice(0, this.hotSessions);
  }

  /** 冷会话回读:只按已知来源文件解析(slot.files,热窗下由 load/append 登记),按 sessionId 过滤。
   *  单文件模式来源=主文件(整文件解析,IO 成本已在报告登记)。 */
  protected override readSessionFromDisk(sessionId: string, slot: SessionSlot): JournalEvent[] | null {
    const sid = String(sessionId);
    const paths = new Set<string>();
    if (this.sharded) {
      const sessionPath = join(this.sessionDir, sessionFileName(sid));
      paths.add(sessionPath);
      // M123(2026-11-08)归档兜底:sessions 下同名文件已被移入 archiveDir 时回读归档副本;
      // 命中顺序 sessions 优先(文件还在 sessions 就不看归档)。
      // M123 冷读门控:未显式开启归档读时,等同未配置 archiveDir(boot 期内部回读零额外 IO)。
      if (this.archiveDir && this.archiveReadsEnabled && !existsSync(sessionPath)) {
        const archivedPath = join(this.archiveDir, sessionFileName(sid));
        if (existsSync(archivedPath)) paths.add(archivedPath);
      }
    } else paths.add(this.filePath);
    for (const f of slot.files) paths.add(f);
    if (this.legacySids.has(sid)) paths.add(this.filePath); // 分片前写入 legacy 的历史事件
    const out: JournalEvent[] = [];
    for (const path of paths) {
      const parsed = this.parsedFile(path);
      if (!parsed) continue;
      for (const event of parsed) {
        if (event.sessionId != null && String(event.sessionId) === sid) out.push(event);
      }
    }
    return out;
  }

  /**
   * 归档冷读(M123,2026-11-08):会话文件已移入 archiveDir 时,boot 不再入账其会话域事件,
   * 读取路径按需从归档补一份(仅当 archiveDir 配置且归档副本存在;不配置 = 逐字旧行为)。
   * 常驻/内存副本优先(同 seq 不重复),结果按 seq 升序。
   */
  override readSession(sessionId: string, sinceSeq = 0): JournalEvent[] {
    const out = super.readSession(sessionId, sinceSeq);
    // M123 冷读门控:未显式开启归档读时,等同未配置 archiveDir。
    if (!this.archiveDir || !this.archiveReadsEnabled) return out;
    const archivedPath = join(this.archiveDir, sessionFileName(String(sessionId)));
    if (!existsSync(archivedPath)) return out;
    const parsed = this.parseFile(archivedPath);
    if (!parsed || parsed.length === 0) return out;
    const sid = String(sessionId);
    const have = new Set(out.map((e) => e.seq));
    const extra = parsed.filter(
      (e) => e.sessionId != null && String(e.sessionId) === sid && e.seq >= sinceSeq && !have.has(e.seq),
    );
    if (extra.length === 0) return out;
    out.push(...extra);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** 冷卸前把该会话文件里还没落盘的 write-behind 队列同步清掉:否则回读会少尾巴(数据丢失)。 */
  protected override onSessionEvicted(sessionId: string): void {
    if (!this.wb) return;
    const target = this.sharded
      ? join(this.sessionDir, sessionFileName(String(sessionId)))
      : this.filePath;
    if ((this.wbQueues.get(target)?.length ?? 0) > 0) this.wbFlushTargetSync(target);
  }

  /** readAll 批量冷回读期:共享文件(legacy 单文件)只解析一次。
   *  产线实测 272 个冷会话里有大量历史会话的事件都在 80MB legacy 里,逐会话重解析 = 21GB IO(239s);
   *  这里只缓存**共享文件**,会话自己的分文件正常一次一解析(缓存全部会等于把整库再钉回堆里)。 */
  protected override beginColdBulkRead(): void {
    this.bulkSharedParse = new Map<string, JournalEvent[]>();
  }
  protected override endColdBulkRead(): void {
    this.bulkSharedParse = null;
  }
  private bulkSharedParse: Map<string, JournalEvent[]> | null = null;

  /** 解析文件(批量冷回读期对共享文件做一次性缓存)。 */
  private parsedFile(path: string): JournalEvent[] | null {
    if (this.bulkSharedParse) {
      const hit = this.bulkSharedParse.get(path);
      if (hit) return hit;
      const events = this.parseFile(path);
      // 共享文件一次性缓存:legacy 单文件(gateway.jsonl,分片前历史)之外,**global.jsonl 也是共享文件**
      // ——它只含跨会话 kind(~24MB)且本就全量驻留,readAll 冷补齐时逐会话重解析它等于重复烧 IO/CPU,
      // 钉住它不会把会话肥数据带回堆(会话域事件在 sessions/<sid>.jsonl 里,仍是一次一解析)。
      if (events && (path === this.filePath || path === this.globalFile)) this.bulkSharedParse.set(path, events);
      return events;
    }
    return this.parseFile(path);
  }

  /** write-behind:进程退出路径(逐文件同步清队列,尽力保最后一批)。 */
  /** 显式同步清队(2026-10-27 优雅停机/测试关闭):close() 后马上重启的场景不能等 exit 钩子——
   *  队列里的事件在下一个进程 load 时还不存在(实锤:任务提交后关闭 → 重启丢任务)。 */
  flush(): void {
    this.wbFlushAllSync();
  }

  /** 写前持久化屏障(M24,fail-closed):逐 target 同步落盘。
   *  与 flush() 的差别只有两点:①失败**抛 JournalFlushError**(不吞、不 console.error);
   *  ②**成功才清队**——失败批原样留在队列里,下次 flushStrict/flush 还能把它写出去(不丢事件)。
   *  已落盘或非 write-behind(每 append 已同步写)时无队列,等价 no-op。 */
  flushStrict(): void {
    for (const target of [...this.wbQueues.keys()]) {
      const queue = this.wbQueues.get(target);
      if (!queue || queue.length === 0) continue;
      const batch = queue.join("");
      const bytes = Buffer.byteLength(batch, "utf-8");
      try {
        mkdirSync(dirname(target), { recursive: true });
        appendFileSync(target, batch, "utf-8");
      } catch (err) {
        // 队列保留原批:本批事件仍在内存(append 已于内存入账),重试/停机 flush 仍可落盘。
        throw new JournalFlushError(target, bytes, err);
      }
      queue.length = 0;
    }
  }

  private wbFlushAllSync(): void {
    for (const target of [...this.wbQueues.keys()]) this.wbFlushTargetSync(target);
  }

  /** 单目标同步清队(冷卸前/退出/优雅停机共用;失败只记日志,与旧路径同丢失面)。 */
  private wbFlushTargetSync(target: string): void {
    const queue = this.wbQueues.get(target);
    if (!queue || queue.length === 0) return;
    const batch = queue.join("");
    queue.length = 0;
    try {
      mkdirSync(dirname(target), { recursive: true });
      appendFileSync(target, batch, "utf-8");
    } catch (err) {
      console.error(`[journal] ${target}: 退出清队失败,丢失 ${batch.length} 字节`, err);
    }
  }

  /** write-behind:异步批冲刷(微任务合并同拍事件;逐文件串行写保顺序)。 */
  private wbScheduleFlush(): void {
    if (this.wbFlushScheduled) return;
    this.wbFlushScheduled = true;
    void Promise.resolve().then(async () => {
      this.wbFlushScheduled = false;
      const fsp = await import("node:fs/promises");
      for (const [target, queue] of this.wbQueues) {
        if (queue.length === 0) continue;
        // M24:先取本批快照,**写成功后才出队**——失败批留在队列里,退出钩子/flushStrict 还能再写一次
        // (旧实现先清队再写:失败即永久丢这一批,屏障的「队列保留」语义会被这里的抢占抹掉)。
        const n = queue.length;
        const batch = queue.join("");
        /** 只移除快照里的那一批(可能与 flushStrict 并发:队首已被同步清掉时不动,重复写由加载期按 seq 去重)。 */
        const takeSnapshot = () => {
          if (queue.length >= n && queue.slice(0, n).join("") === batch) queue.splice(0, n);
        };
        try {
          await fsp.appendFile(target, batch, "utf-8");
          takeSnapshot();
        } catch {
          // 异步写失败(如目录未建):回退同步写一次保数据;再失败保留队列等退出钩子/下次 flush。
          try {
            mkdirSync(dirname(target), { recursive: true });
            appendFileSync(target, batch, "utf-8");
            takeSnapshot();
          } catch (err) {
            console.error(`[journal] ${target}: write-behind 落盘失败,保留 ${n} 条待重试(退出钩子/flush 兜底)`, err);
          }
        }
      }
    });
  }

  /** 单文件解析:逐行 Buffer 切片解码(fixE1),坏行跳过、后续有效行保留(分文件下单会话损坏不污染全局)。
   *  2026-10-21 修复:旧逻辑遇坏行即 break——双写交错时代单个坏行会丢掉该会话文件后半段(数百条
   *  消息),恢复出的历史缺 assistant 只剩 tool 结果 → LLM 400。交错坏行只影响自身,跳过即可。
   *  只解析不 ingest——归并与入账在 load() 统一做。 */
  private parseFile(path: string): JournalEvent[] | null {
    if (!existsSync(path)) return null;
    const buf = readFileSync(path);
    const out: JournalEvent[] = [];
    let lineStart = 0;
    let lineNo = 0;
    let bad = 0;
    let firstBadLineNo = 0;
    while (lineStart < buf.length) {
      const nl = buf.indexOf(0x0a, lineStart);
      const lineEnd = nl === -1 ? buf.length : nl;
      const line = buf.toString("utf-8", lineStart, lineEnd);
      lineStart = lineEnd + 1;
      lineNo++;
      if (line.trim()) {
        try {
          out.push(JSON.parse(line) as JournalEvent);
        } catch {
          bad++;
          if (firstBadLineNo === 0) firstBadLineNo = lineNo;
        }
      }
      if (nl === -1) break;
    }
    if (bad > 0) {
      console.warn(`[journal] ${path}: 跳过 ${bad} 行损坏(首处第 ${firstBadLineNo} 行;双写交错历史残留,其余有效行照常恢复)`);
    }
    return out;
  }

  // fixE1(2026-10-19 产线 P1 启动卡死排查):加载性能+可观测三改——
  // ①逐行 Buffer 切片解码替代「整文件 utf-8 大字符串 + split 行数组」;②seq 断档告警折叠;
  // ③加载耗时/规模打点。2026-10-21 分文件:legacy+global+sessions/* 各自解析后按全局 seq 稳定
  // 归并再入账——全局 seq=数组下标不变量、断档降级、幂等键跨全文件重建,全部沿用既有机制。
  // g2 热窗(2026-11):归并后逐条 ingest,启动期按 EVICT_EVERY 周期性整会话冷卸(稳态只驻 N 个会话);
  // 会话域事件的磁盘定位靠「目标文件确定性 + legacy 单文件侧会话集」,不额外存每事件来源(省内存)。
  private load(): void {
    if (this.loaded) return;
    // 热窗开 + 分片布局 → 流式加载(冷会话事件对象不驻留);其余(热窗=0 或纯单文件)逐字走旧全量路径。
    if (this.hotSessions > 0 && this.hasShardedLayout()) { this.loadStreaming(); return; }
    const started = Date.now();
    const sources: ParsedSource[] = [];
    const take = (path: string, bytes: number): void => {
      const events = this.parseFile(path);
      if (events && events.length) sources.push({ path, events, bytes });
    };
    take(this.filePath, this.fileBytes(this.filePath));
    take(this.globalFile, this.fileBytes(this.globalFile));
    try {
      const names = readdirSync(this.sessionDir).filter((f) => f.endsWith(".jsonl")).sort();
      for (const f of names) {
        const p = join(this.sessionDir, f);
        take(p, this.fileBytes(p));
      }
    } catch { /* sessions 目录不存在=无会话分文件,正常 */ }
    const { merged, dupSeqs, bytes } = this.mergeSources(sources);
    // 归并:各文件内部 seq 升序(单进程全局计数器保证),跨文件按 seq 交错 → 全量稳定排序。
    // 2026-10-21 修复(双写历史):同一 seq 可能在不同文件/不同时刻各出现一次(两个网关进程的
    // 独立计数器)。旧逻辑「先到先得」保留旧事件、丢掉新事件 → 会话历史缺 assistant 消息,
    // 只剩 tool 结果 → LLM 400。现按 seq 去重并**保留 time 较大者**(新事件赢),同刻保留后合并者。
    const total = merged.length;
    // 2026-10-21 修复:去重/分文件后 seq 稀疏是正常态(两个独立计数器各有空档、4455 条重复被折叠),
    // 不能拿 `seq === events.length` 当断档判据——否则几乎每条都误报,还把 readSession 的二分
    // 索引整个降级成线性。readSession 的二分只依赖「同一会话列表内 seq 升序」,与全局下标无关;
    // 只有真非单调(外部改文件)才需要降级。
    let lastSeq = -1;
    const SEQ_WARN_CAP = 10;
    let nonMonotonic = 0;
    let gapCount = 0;
    let gapMissing = 0;
    let ingested = 0;
    this.beginBulkIngest();
    for (const event of merged) {
      if (event.seq <= lastSeq) {
        this.sessionIndexStrict = false;
        nonMonotonic++;
        if (nonMonotonic <= SEQ_WARN_CAP) {
          console.warn(`[journal] seq 非单调 前 ${lastSeq} 当前 ${event.seq}(已降级会话读取为线性过滤)`);
        }
      } else if (lastSeq >= 0 && event.seq > lastSeq + 1) {
        gapCount++;
        gapMissing += event.seq - lastSeq - 1;
      }
      lastSeq = event.seq;
      this.ingest(event);
      this.bulkIngestTick(++ingested);
    }
    this.endBulkIngest();
    merged.length = 0; // 释放合并数组(冷会话事件已从 events 卸掉,不能再被它钉住)
    this.afterLoad(started, total, bytes, dupSeqs, gapCount, gapMissing, nonMonotonic, SEQ_WARN_CAP, "直读+归并");
    this.loaded = true;
  }

  /** 分片异步加载(fault 冷启动修复):fs.promises.readFile + 每 2000 行/每文件 setImmediate 让步,
   *  merge/ingest 每 2000 条让步;网关 main 在 createGatewayApp 前 await 本方法,事件循环不再被
   *  28k+ 行同步重放独占。语义与 load() 一致(seq 去重/断档/sessionIndex/幂等键/热窗冷卸)。 */
  async loadChunked(): Promise<void> {
    if (this.loaded) return;
    // 热窗开 + 分片布局 → 流式加载(逐行解析、冷会话当场丢对象;峰值不再需要「全量 parse + 全量归并」)。
    if (this.hotSessions > 0 && this.hasShardedLayout()) { await this.loadStreamingAsync(); return; }
    const started = Date.now();
    const sources: ParsedSource[] = [];
    const take = async (path: string): Promise<void> => {
      const r = await this.parseFileAsync(path);
      if (r && r.events.length) sources.push({ path, events: r.events, bytes: r.bytes });
    };
    await take(this.filePath);
    await take(this.globalFile);
    try {
      const names = (await readdirAsync(this.sessionDir)).filter((f) => f.endsWith(".jsonl")).sort();
      for (const f of names) {
        await take(join(this.sessionDir, f));
        await new Promise<void>((r) => setImmediate(r));
      }
    } catch { /* sessions 目录不存在=无会话分文件,正常 */ }
    const { merged, dupSeqs, bytes } = this.mergeSources(sources);
    const total = merged.length;
    let lastSeq = -1;
    const SEQ_WARN_CAP = 10;
    let nonMonotonic = 0;
    let gapCount = 0;
    let gapMissing = 0;
    let ingested = 0;
    this.beginBulkIngest();
    for (const event of merged) {
      if (event.seq <= lastSeq) {
        this.sessionIndexStrict = false;
        nonMonotonic++;
        if (nonMonotonic <= SEQ_WARN_CAP) console.warn(`[journal] seq 非单调 前 ${lastSeq} 当前 ${event.seq}(已降级会话读取为线性过滤)`);
      } else if (lastSeq >= 0 && event.seq > lastSeq + 1) {
        gapCount++;
        gapMissing += event.seq - lastSeq - 1;
      }
      lastSeq = event.seq;
      this.ingest(event);
      this.bulkIngestTick(++ingested);
      if (ingested % 2000 === 0) await new Promise<void>((r) => setImmediate(r));
    }
    this.endBulkIngest();
    merged.length = 0;
    this.afterLoad(started, total, bytes, dupSeqs, gapCount, gapMissing, nonMonotonic, SEQ_WARN_CAP, "分片加载");
    this.loaded = true;
  }

  // ── g2 流式加载(2026-11):砍掉 loadChunked 的峰值内存 ──────────────────────────
  // 旧实现:global + legacy + sessions/* 全部先 parse 成 ParsedSource[](528k 事件全成活对象),
  // 再整体归并 → 峰值堆 851MB,淘汰后 RSS 也回不到 300MB 以内(淘汰只丢引用,老年代已撑大)。
  // 现按文件角色流式扫描:热会话/全局事件留对象,冷会话事件 scan 完即丢(只登记槽元数据),
  // events[] 只装 global + 热会话(seq 升序)。热窗=0 或纯单文件布局不走本路径(逐字旧行为)。
  /** 是否分片布局(global.jsonl / sessions/*.jsonl):纯单文件 legacy 没有可判定的「热文件」,
   *  若强行流式会把所有会话判成冷会话(readAll 需逐个回读),故保持全量驻留旧行为。 */
  private hasShardedLayout(): boolean {
    if (this.sharded) return true;
    if (existsSync(this.globalFile)) return true;
    try {
      return readdirSync(this.sessionDir).some((f) => f.endsWith(".jsonl"));
    } catch {
      return false;
    }
  }

  /** 热文件集合:sessions/*.jsonl 按 mtime 取最新 N 个(mtime 相同按文件名降序,近似「后建的会话更热」);
   *  再受字节预算约束(mtime 从新到旧累计文件字节直到用尽;单会话自身超预算 1/2 则整会话不纳入;
   *  至少留最新 1 个,否则空热窗会让活跃会话每步回盘)。
   *  hot=整会话留对象;cold=只登记元数据(仍可冷回读)。hotSessions<=0 时全部算热(=旧全量)。 */
  private selectHotSessionFiles(): { hot: string[]; cold: string[] } {
    let names: string[] = [];
    try {
      names = readdirSync(this.sessionDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return { hot: [], cold: [] }; // sessions 目录不存在=无会话分文件
    }
    if (names.length === 0) return { hot: [], cold: [] };
    const entries = names.map((n) => {
      const p = join(this.sessionDir, n);
      let mtime = 0;
      let bytes = 0;
      try {
        const st = statSync(p);
        mtime = st.mtimeMs;
        bytes = st.size;
      } catch { /* 读不到 stat=按最旧/0 字节处理 */ }
      return { p, mtime, bytes };
    });
    if (this.hotSessions <= 0) return { hot: entries.map((e) => e.p), cold: [] };
    entries.sort((a, b) => (b.mtime - a.mtime) || (a.p < b.p ? 1 : a.p > b.p ? -1 : 0));
    if (this.hotBytes <= 0) {
      // 字节预算关闭(0=不限):逐字回到「只按 mtime 取最新 N 个」的旧行为。
      return {
        hot: entries.slice(0, this.hotSessions).map((e) => e.p),
        cold: entries.slice(this.hotSessions).map((e) => e.p),
      };
    }
    // 字节配额:mtime 从新到旧累计,直到预算用尽;超大单会话(自身 > 预算 1/2)整会话不纳入。
    const half = this.hotBytes / 2;
    const hot: string[] = [];
    const cold: string[] = [];
    let used = 0;
    let exhausted = false;
    for (const entry of entries) {
      const fits = !exhausted && hot.length < this.hotSessions
        && entry.bytes <= half && used + entry.bytes <= this.hotBytes;
      if (fits) {
        hot.push(entry.p);
        used += entry.bytes;
        continue;
      }
      // 预算用尽(该会话本可以纳入,只是剩余额度不够):此后更旧的一律不再纳入。
      if (!exhausted && hot.length < this.hotSessions && entry.bytes <= half) exhausted = true;
      cold.push(entry.p);
    }
    if (hot.length === 0 && entries.length > 0) {
      // 最少 1 个热会话下限:全部超预算时也留最新那个(否则活跃会话每步都要回盘)。
      const newest = entries[0]!;
      hot.push(newest.p);
      const at = cold.indexOf(newest.p);
      if (at >= 0) cold.splice(at, 1);
    }
    return { hot, cold };
  }

  /** 同步流式加载(load()):先热文件(定热会话集合)→ legacy → global → 冷文件。 */
  private loadStreaming(): void {
    const started = Date.now();
    const ing = this.makeStreamIngest();
    const tally: ScanTally = { bytes: 0, lines: 0 };
    const { hot, cold } = this.selectHotSessionFiles();
    // ① 热会话分文件:整会话留对象(顺带确定热会话集合,legacy 侧据此判断哪些会话域事件保留)
    for (const p of hot) addTally(tally, this.scanFileSync(p, (e) => ing.feed(e, "hot", p)));
    // ② 共享文件:legacy(分片前历史,只留热会话的事件)+ global(跨会话 kind,全量驻留)
    addTally(tally, this.scanFileSync(this.filePath, (e) => ing.feed(e, "legacy", this.filePath)));
    addTally(tally, this.scanFileSync(this.globalFile, (e) => ing.feed(e, "global", this.globalFile)));
    // ③ 冷会话分文件:事件对象扫描即弃,只登记槽元数据(firstSeq/lastSeq/count/文件)
    for (const p of cold) addTally(tally, this.scanFileSync(p, (e) => ing.feed(e, "cold", p)));
    ing.finish("流式加载", started, tally);
  }

  /** 异步流式加载(loadChunked():逐行解析 + 定期让出事件循环,语义与 loadStreaming 一致)。 */
  private async loadStreamingAsync(): Promise<void> {
    const started = Date.now();
    const ing = this.makeStreamIngest();
    const tally: ScanTally = { bytes: 0, lines: 0 };
    const { hot, cold } = this.selectHotSessionFiles();
    for (const p of hot) {
      addTally(tally, await this.scanFileAsync(p, (e) => ing.feed(e, "hot", p)));
      await new Promise<void>((r) => setImmediate(r));
    }
    addTally(tally, await this.scanFileAsync(this.filePath, (e) => ing.feed(e, "legacy", this.filePath)));
    addTally(tally, await this.scanFileAsync(this.globalFile, (e) => ing.feed(e, "global", this.globalFile)));
    for (const p of cold) {
      addTally(tally, await this.scanFileAsync(p, (e) => ing.feed(e, "cold", p)));
      await new Promise<void>((r) => setImmediate(r));
    }
    ing.finish("流式加载", started, tally);
  }

  /** 流式入账器(feed 逐事件喂入,finish 收尾入账)。
   *  留对象 = global 全部 + 热会话全部 + 恒常驻(跨会话 kind/无会话;冷文件里偶尔也有);
   *  其余只登记 ColdMeta(sid→firstSeq/lastSeq/count/文件)+ 幂等键(字符串)。 */
  private makeStreamIngest(): {
    feed(event: JournalEvent, role: ScanRole, path: string): void;
    finish(label: string, started: number, tally: ScanTally): void;
  } {
    const resident: JournalEvent[] = [];
    const coldMeta = new Map<string, ColdMeta>();
    const hotSids = this.streamHotSids; // mtime 选出的热会话(收尾时热集合优先保留)
    let total = 0;
    let minSeq = -1;
    let maxSeq = -1;
    let nonMonotonic = 0;

    const feed = (event: JournalEvent, role: ScanRole, path: string): void => {
      const seq = Number(event.seq);
      if (!Number.isFinite(seq)) return;
      total++;
      if (seq > maxSeq) maxSeq = seq;
      if (minSeq < 0 || seq < minSeq) minSeq = seq;
      // 幂等键全量保留(只存字符串,占行数约 1%):冷会话也要,否则重启后重复 append 会重新落盘。
      if (event.idempotencyKey) this.seenIdempotencyKeys.add(event.idempotencyKey);
      const sid = event.sessionId == null ? "" : String(event.sessionId);
      if (role === "hot" && sid !== "") hotSids.add(sid);
      const keep = role === "global" || role === "hot" || isAlwaysResident(event)
        || (role === "legacy" && sid !== "" && hotSids.has(sid));
      if (keep) {
        resident.push(event);
        if (event.idempotencyKey) this.idempotentEvents.set(event.idempotencyKey, event);
        return;
      }
      // ── 冷会话:事件对象到此为止(不进 events[]、不进任何长期 Map),只留元数据 ──
      if (sid === "") return; // 无会话归属必是 isAlwaysResident,理论不可达
      if (event.idempotencyKey) this.coldIdemKeys.set(event.idempotencyKey, sid); // 只记 key→sid(273 条量级)
      let meta = coldMeta.get(sid);
      if (!meta) {
        meta = { firstSeq: seq, lastSeq: seq, count: 0, files: new Set<string>(), lastSeenSeq: -1 };
        coldMeta.set(sid, meta);
      }
      if (seq <= meta.lastSeenSeq) nonMonotonic++; // 同会话 seq 非单调(外部改过文件)→ 降级读取策略
      meta.lastSeenSeq = seq;
      if (seq < meta.firstSeq) meta.firstSeq = seq;
      if (seq > meta.lastSeq) meta.lastSeq = seq;
      meta.count++;
      meta.files.add(path);
    };

    const finish = (label: string, started: number, tally: ScanTally): void => {
      const merged = dedupeBySeq(resident); // seq 去重(同 seq 保留 time 较新者)+ 升序
      const dupSeqs = resident.length - merged.length;
      resident.length = 0; // 释放扫描暂存数组
      this.beginBulkIngest();
      try {
        for (const event of merged) this.ingest(event);
        // 冷会话槽:只登记元数据(evicted=true);恒常驻子集已在上面的 ingest 里进了 slot.events。
        for (const [sid, meta] of coldMeta) {
          const slot = this.sessionIndex.get(sid);
          if (slot) {
            slot.evicted = true;
            if (meta.firstSeq < slot.firstSeq) slot.firstSeq = meta.firstSeq;
            if (meta.lastSeq > slot.lastSeq) slot.lastSeq = meta.lastSeq;
            slot.count = meta.count;
            for (const f of meta.files) slot.files.add(f);
          } else {
            this.sessionIndex.set(sid, {
              events: [], evicted: true, firstSeq: meta.firstSeq, lastSeq: meta.lastSeq, files: meta.files, count: meta.count,
            });
          }
        }
        if (nonMonotonic > 0) this.sessionIndexStrict = false;
        // 热集合 = mtime 选出的热会话(先钉住),再按窗口收敛冷卸其余会话
        this.rebuildHotOrder();
      } finally {
        this.endBulkIngest();
      }
      this.evictColdSessions();
      // 水位 = 全量最大 seq(冷会话事件不驻留,但它们的 seq 也占水位,不能漏)
      if (maxSeq > this.seqHigh) this.seqHigh = maxSeq;
      this.rebuildHotOrder(); // 热集合按会话最近 seq 重排(finish 时 LRU 顺序已无意义)
      const residentCount = merged.length;
      merged.length = 0;
      this.reportStreamLoad(label, started, tally, total, residentCount, minSeq, maxSeq, dupSeqs, nonMonotonic);
      this.loaded = true;
    };

    return { feed, finish };
  }

  /** 流式加载收尾打点(与 afterLoad 同口径的规模/告警,但断档统计对冷会话不再逐 seq 可见)。 */
  private reportStreamLoad(
    label: string, started: number, tally: ScanTally, total: number,
    residentCount: number, minSeq: number, maxSeq: number, dupSeqs: number, nonMonotonic: number,
  ): void {
    if (dupSeqs > 0) {
      console.warn(`[journal] seq 重复 ${dupSeqs} 条已按「保留较新事件」去重(双写历史残留;新事件 seq 从 ${this.seqHigh + 1} 续)`);
    }
    if (nonMonotonic > 0) {
      console.warn(`[journal] seq 非单调 ${nonMonotonic} 条(已降级会话读取为线性过滤)`);
    }
    if (total === 0) return;
    const stats = this.hotWindowStats();
    console.error(
      `[journal] ${dirname(this.filePath)}: ${label}(流式热窗 N=${stats.hotLimit}`
      + `${stats.hotLimitBytes > 0
        ? `,字节预算 ${stats.hotLimitBytes >= 1_048_576 ? `${(stats.hotLimitBytes / 1_048_576).toFixed(0)}MB` : `${Math.round(stats.hotLimitBytes / 1024)}KB`}`
        : ",字节预算不限"}) ${total} 行`
      + `(${(tally.bytes / 1_048_576).toFixed(1)}MB)用时 ${Date.now() - started}ms;`
      + `驻留 ${residentCount} 条(热会话 ${stats.hotSessions}/冷会话 ${stats.coldSessions},seq ${minSeq}..${maxSeq})`,
    );
  }

  /** 逐行扫描(流式:不建数组,事件交给 visit 后即无长期引用;坏行跳过,与 parseFile 同口径)。
   *  注:曾试过分块读(8MB/块)想压 malloc arena,实测 RSS 314MB→314MB 不变而 loadChunked 25s→41s、
   *  readAll 10s→21s(豆文件读+手动切行),故保留整文件读:稳态 RSS 的大头不在文件缓冲。 */
  private scanFileSync(path: string, visit: (event: JournalEvent) => void): ScanTally | null {
    if (!existsSync(path)) return null;
    const buf = readFileSync(path);
    let lineStart = 0;
    let lineNo = 0;
    let bad = 0;
    let firstBadLineNo = 0;
    while (lineStart < buf.length) {
      const nl = buf.indexOf(0x0a, lineStart);
      const lineEnd = nl === -1 ? buf.length : nl;
      const line = buf.toString("utf-8", lineStart, lineEnd);
      lineStart = lineEnd + 1;
      lineNo++;
      if (line.trim()) {
        let event: JournalEvent | undefined;
        try {
          event = JSON.parse(line) as JournalEvent;
        } catch {
          bad++;
          if (firstBadLineNo === 0) firstBadLineNo = lineNo;
        }
        if (event) visit(event);
      }
      if (nl === -1) break;
    }
    if (bad > 0) console.warn(`[journal] ${path}: 跳过 ${bad} 行损坏(首处第 ${firstBadLineNo} 行;其余有效行照常恢复)`);
    return { bytes: buf.length, lines: lineNo };
  }

  /** 异步逐行扫描(每 EVICT_EVERY 行让出事件循环;冷会话事件对象由 feed 丢弃后可回收)。 */
  private async scanFileAsync(path: string, visit: (event: JournalEvent) => void): Promise<ScanTally | null> {
    if (!existsSync(path)) return null;
    const buf = await readFileAsync(path);
    let lineStart = 0;
    let lineNo = 0;
    let bad = 0;
    let firstBadLineNo = 0;
    while (lineStart < buf.length) {
      const nl = buf.indexOf(0x0a, lineStart);
      const lineEnd = nl === -1 ? buf.length : nl;
      const line = buf.toString("utf-8", lineStart, lineEnd);
      lineStart = lineEnd + 1;
      lineNo++;
      if (line.trim()) {
        let event: JournalEvent | undefined;
        try {
          event = JSON.parse(line) as JournalEvent;
        } catch {
          bad++;
          if (firstBadLineNo === 0) firstBadLineNo = lineNo;
        }
        if (event) visit(event);
      }
      if (lineNo % EVICT_EVERY === 0) await new Promise<void>((r) => setImmediate(r));
      if (nl === -1) break;
    }
    if (bad > 0) console.warn(`[journal] ${path}: 跳过 ${bad} 行损坏(首处第 ${firstBadLineNo} 行;其余有效行照常恢复)`);
    return { bytes: buf.length, lines: lineNo };
  }

  /** 归并各来源文件:按 seq 去重(同 seq 保留 time 较新者)+ 升序;每折完一个文件即释放其解析数组。
   *  顺带登记 legacy 单文件里出现过的会话(热窗冷卸时这些会话的会话域事件要连 legacy 一起回读)。 */
  private mergeSources(sources: ParsedSource[]): { merged: JournalEvent[]; dupSeqs: number; bytes: number } {
    const bySeq = new Map<number, JournalEvent>();
    let dupSeqs = 0;
    let bytes = 0;
    for (const source of sources) {
      bytes += source.bytes;
      const isLegacy = source.path === this.filePath;
      for (const event of source.events) {
        const seq = Number.isFinite(event.seq) ? event.seq : NaN;
        if (!Number.isFinite(seq)) continue;
        if (isLegacy && event.sessionId && !isAlwaysResident(event)) this.legacySids.add(String(event.sessionId));
        const prev = bySeq.get(seq);
        if (!prev) { bySeq.set(seq, event); continue; }
        dupSeqs++;
        if ((event.time ?? 0) >= (prev.time ?? 0)) bySeq.set(seq, event);
      }
      source.events.length = 0; // 释放本文件解析数组(对象引用已由 bySeq 持有)
    }
    const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    bySeq.clear();
    return { merged, dupSeqs, bytes };
  }

  /** 加载收尾:告警(重复 seq/稀疏/非单调)+ 规模打点(含热窗驻留画像)。 */
  private afterLoad(
    started: number, total: number, bytes: number, dupSeqs: number,
    gapCount: number, gapMissing: number, nonMonotonic: number, cap: number, label: string,
  ): void {
    if (dupSeqs > 0) {
      console.warn(`[journal] seq 重复 ${dupSeqs} 条已按「保留较新事件」去重(双写历史残留;新事件 seq 从 ${this.seqHigh + 1} 续)`);
    }
    if (gapCount > 0) {
      console.error(`[journal] seq 稀疏 ${gapCount} 处/共缺 ${gapMissing} 个(分文件+双写去重后的正常间隙,水位仍按 seq 单调)`);
    }
    if (nonMonotonic > cap) {
      console.warn(`[journal] 另有 ${nonMonotonic - cap} 条 seq 非单调已折叠`);
    }
    if (total === 0) return;
    const stats = this.hotWindowStats();
    const hotNote = stats.hotLimit > 0
      ? `;热窗 N=${stats.hotLimit} 驻留 ${stats.residentEvents} 行(热会话 ${stats.hotSessions}/冷会话 ${stats.coldSessions})`
      : "";
    console.error(`[journal] ${dirname(this.filePath)}: ${label} ${total} 行(${(bytes / 1_048_576).toFixed(1)}MB)用时 ${Date.now() - started}ms${hotNote}`);
  }

  private fileBytes(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  private async parseFileAsync(path: string): Promise<{ events: JournalEvent[]; bytes: number } | null> {
    if (!existsSync(path)) return null;
    const buf = await readFileAsync(path);
    const out: JournalEvent[] = [];
    let lineStart = 0;
    let lineNo = 0;
    let bad = 0;
    let firstBadLineNo = 0;
    while (lineStart < buf.length) {
      const nl = buf.indexOf(0x0a, lineStart);
      const lineEnd = nl === -1 ? buf.length : nl;
      const line = buf.toString("utf-8", lineStart, lineEnd);
      lineStart = lineEnd + 1;
      lineNo++;
      if (line.trim()) {
        try { out.push(JSON.parse(line) as JournalEvent); }
        catch { bad++; if (firstBadLineNo === 0) firstBadLineNo = lineNo; }
      }
      if (lineNo % 2000 === 0) await new Promise<void>((r) => setImmediate(r));
      if (nl === -1) break;
    }
    if (bad > 0) console.warn(`[journal] ${path}: 跳过 ${bad} 行损坏(首处第 ${firstBadLineNo} 行;其余有效行照常恢复)`);
    return { events: out, bytes: buf.length };
  }

  protected persist(event: JournalEvent): void {
    const target = this.targetOf(event);
    const line = JSON.stringify(event) + "\n";
    if (this.wb) {
      let q = this.wbQueues.get(target);
      if (!q) { q = []; this.wbQueues.set(target, q); }
      q.push(line);
      this.wbScheduleFlush();
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, line, "utf-8");
  }

  /** 整批一次落盘(按目标文件分组,每目标一次写;write-behind=并入各目标队列)。 */
  protected override persistMany(events: JournalEvent[]): void {
    if (events.length === 0) return;
    const byTarget = new Map<string, string[]>();
    for (const event of events) {
      const target = this.targetOf(event);
      let arr = byTarget.get(target);
      if (!arr) { arr = []; byTarget.set(target, arr); }
      arr.push(JSON.stringify(event) + "\n");
    }
    for (const [target, lines] of byTarget) {
      if (this.wb) {
        let q = this.wbQueues.get(target);
        if (!q) { q = []; this.wbQueues.set(target, q); }
        q.push(...lines);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      appendFileSync(target, lines.join(""), "utf-8");
    }
    if (this.wb) this.wbScheduleFlush();
  }
}
