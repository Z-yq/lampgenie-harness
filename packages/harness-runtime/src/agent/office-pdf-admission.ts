/**
 * Office → PDF 转换的共享准入层(纯逻辑,零 IO,2026-11 #182)。
 * 为什么需要它:同一个源文件常被多个消费者同时要 PDF(面板预览、导出、agent 附件),
 * 而 LibreOffice 转换是重活(单实例吃几百 MB、串行排队)。若不设闸门,一次批量导出就能
 * 把机器拖垮;若各调用方各自去转,同一份内容会被重复转 N 次。于是把「要不要转、能不能
 * 复用、卡在哪个上限」抽象成一次准入裁决:本模块只回答结论,落盘与真转换都在上层
 * (apps/gateway/src/office-pdf-store.ts)。
 * 四个概念:
 * - contentKey = 转换器代号 + 扩展名 + 源字节 sha256:*内容*相同的请求天然合并,
 *   不依赖路径/文件名(同一份文档改名后仍命中)。
 * - alias(sourceVersion + 路径):给人看的稳定入口。同一路径内容变了(sourceVersion 变)
 *   就换 alias,不复用旧缓存(旧缓存保留,可能还有别人在等),结论带 SOURCE_CHANGED。
 * - inflight:正在转的 key + 读这一份结果的读者集合。第二个请求 = 加一个读者(JOINED),
 *   不重复转换。读者全撤 = 转换作废(CANCELLED 并退还字节额度)。
 * - queue:被上限挡住时的登记簿。排队**不占**读者/转换额度,只占 maxQueuedMetadata 元数据位。
 * 关键不变量:
 * 1. 所有导出函数都不修改入参 state;返回新 state(结构不可变,便于调用方做快照比对决定是否落盘)。
 * 2. 零 IO、不 throw:非法入参折叠成 OFFICEPDF_INVALID,状态不允许折叠成 OFFICEPDF_REJECTED。
 * 3. ready 命中不占读者槽(readers 不增),只有 inflight 才计读者。
 * 4. 账簿守恒:activeBytes 只在 start 时 +inflight.size,在 complete/cancel 时 -同一份 size,
 *    所以 activeBytes 恒等于「各 inflight.size 之和」。
 * 5. 输出校验不过 = 硬失败:清掉 inflight、退额度、**不写 ready**(缓存只承载可信产物)。
 * 6. disposed 之后一切请求一律拒绝(DISPOSED),不可复活。
 * 依赖纪律:node:crypto(sha256)是本模块唯一 import;不读文件/环境/网络/时间(now 全部由入参给)。
 * 码表顺序固定(便于自动化按码断言)。
 */
import { createHash } from "node:crypto";

/** 账本 schema 版本:字段语义变化时递增。 */
export const OFFICEPDF_VERSION = 1;

/** 稳定码:准入/结算的全部判断结论(字符串常量,便于落盘与断言)。 */
export const OFFICEPDF_INVALID = "OFFICEPDF_INVALID" as const;
export const OFFICEPDF_REUSED = "OFFICEPDF_REUSED" as const;
export const OFFICEPDF_JOINED = "OFFICEPDF_JOINED" as const;
export const OFFICEPDF_STARTED = "OFFICEPDF_STARTED" as const;
export const OFFICEPDF_QUEUED = "OFFICEPDF_QUEUED" as const;
export const OFFICEPDF_REJECTED = "OFFICEPDF_REJECTED" as const;
export const OFFICEPDF_SOURCE_CHANGED = "OFFICEPDF_SOURCE_CHANGED" as const;
export const OFFICEPDF_READY = "OFFICEPDF_READY" as const;
export const OFFICEPDF_INVALID_OUTPUT = "OFFICEPDF_INVALID_OUTPUT" as const;
export const OFFICEPDF_CANCELLED = "OFFICEPDF_CANCELLED" as const;
export const OFFICEPDF_EVICTED = "OFFICEPDF_EVICTED" as const;
export const OFFICEPDF_DISPOSED = "OFFICEPDF_DISPOSED" as const;

/** 全部稳定码(固定顺序)。 */
export const OFFICEPDF_CODES = [
  OFFICEPDF_INVALID,
  OFFICEPDF_REUSED,
  OFFICEPDF_JOINED,
  OFFICEPDF_STARTED,
  OFFICEPDF_QUEUED,
  OFFICEPDF_REJECTED,
  OFFICEPDF_SOURCE_CHANGED,
  OFFICEPDF_READY,
  OFFICEPDF_INVALID_OUTPUT,
  OFFICEPDF_CANCELLED,
  OFFICEPDF_EVICTED,
  OFFICEPDF_DISPOSED,
] as const;

export type OfficePdfCode = (typeof OFFICEPDF_CODES)[number];

/** 请求优先级:前台(交互等着看)、后台(可以延后/可以排队)。 */
export const PRIORITIES = ["foreground", "background"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** 输出大小缺省上限(256MB):单份 PDF 超过它视为异常产物。 */
export const OFFICEPDF_DEFAULT_MAX_OUTPUT_BYTES = 268_435_456;

/** 缓存键:转换器代号 + 小写扩展名 + 源字节 sha256。 */
export interface CacheKey {
  converterGeneration: string;
  extension: string;
  sha256: string;
}

/** 一次转换请求(自足:只靠它就能裁决,不回头读文件)。 */
export interface ConvertRequest {
  /** 请求/读者 id(同一 id 在一个 key 的读者集合里只出现一次)。 */
  id: string;
  /** 源扩展名(大小写不敏感,内部按小写归一)。 */
  extension: string;
  /** 转换器代号(LibreOffice 升级换代 = 换 key,不复用旧产物)。 */
  converterGeneration: string;
  /** 源字节 sha256(给了就不必再算 bytes)。 */
  digest?: string;
  /** 源字节数(用于字节额度;缺省按 bytes 长度)。 */
  size?: number;
  /** 源字节(给了且没给 digest 时用来算 sha256)。 */
  bytes?: Uint8Array | string;
  /** 前台/后台。 */
  priority: Priority;
  /** 源版本(建议 `size:mtimeMs`):同一 alias 的版本变了就不复用。 */
  sourceVersion: string;
  /** 源路径/文件名(给了才建 alias)。 */
  name?: string;
  /** 裁决时刻(epoch ms;本模块不读时钟)。 */
  now: number;
}

/** 准入门限。 */
export interface AdmissionLimits {
  /** 同时持有结果的读者总数上限。 */
  maxReaders: number;
  /** 同时在转的源字节总量上限。 */
  maxActiveBytes: number;
  /** 同时进行的转换数上限。 */
  maxConversions: number;
  /** 排队登记簿长度上限(只存元数据,不存字节)。 */
  maxQueuedMetadata: number;
  /** 同时进行的后台转换数上限。 */
  backgroundMax: number;
}

/** 一份可信产物(只记元数据;path 为空表示调用方不关心落点)。 */
export interface CacheEntry {
  status: "ready" | "failed";
  path: string;
  size: number;
  /** 指向本 key 的 alias 列表(便于反查清理)。 */
  aliases: string[];
  lastUsed: number;
  /** failed 的原因(不可复用的产物只留证据)。 */
  reason?: string;
}

/** 正在转换的一份内容 + 它的读者。 */
export interface InflightEntry {
  readers: string[];
  priority: Priority;
  startedAt: number;
  digest: string;
  extension: string;
  size: number;
}

/** 排队登记项(元数据)。 */
export interface QueueEntry {
  id: string;
  key: string;
  priority: Priority;
  now: number;
}

/** 准入状态(整账本;纯数据,可直接 JSON 落盘)。 */
export interface AdmissionState {
  cache: Record<string, CacheEntry>;
  inflight: Record<string, InflightEntry>;
  queue: QueueEntry[];
  aliases: Record<string, string>;
  activeBytes: number;
  conversions: number;
  disposed: boolean;
  /** 变更序号:每次状态推进 +1(便于断言「确实变过」)。 */
  seq: number;
}

/** admit 结论。 */
export interface AdmitResult {
  state: AdmissionState;
  action: "reuse" | "join-inflight" | "start" | "queued" | "reject";
  codes: string[];
  key?: string;
  entry?: CacheEntry;
  /** 本次裁决后该 key 上的读者数(reuse/queued/reject 恒 0)。 */
  readers: number;
}

/** 产物事实(由上层 stat + 读首尾得到,本模块只做判定)。 */
export interface OutputFacts {
  isRegular: boolean;
  noFollow: boolean;
  size: number;
  head: Uint8Array | string;
  lastBytes: Uint8Array | string;
}

/** complete 结论。 */
export interface CompleteResult {
  state: AdmissionState;
  ok: boolean;
  codes: string[];
  entry?: CacheEntry;
  /** 退还的字节额度(= 该 inflight 的 size)。 */
  releasedBytes: number;
  /** 失败原因(便于上层解释;不改 code)。 */
  reasons?: string[];
}

/** cancelReader 结论。 */
export interface CancelResult {
  state: AdmissionState;
  codes: string[];
  /** 是否作废了一次转换(最后一个读者也撤了)。 */
  aborted: boolean;
  /** 该 key 上剩余读者数(未命中任何一条时给全账簿读者总数)。 */
  remaining: number;
  /** 顺带退掉的排队登记数。 */
  queueRemoved?: number;
  releasedBytes?: number;
}

/** evictLru 结论。 */
export interface EvictResult {
  state: AdmissionState;
  codes: string[];
  evicted: string[];
}

/** dispose 结论。 */
export interface DisposeResult {
  state: AdmissionState;
  codes: string[];
  /** 被丢弃的读者 id(调用方要逐个告知「转换没了」)。 */
  unavailable: string[];
}

const ALIAS_SEP = "\u0000";

// ---------------------------------------------------------------- 基础工具

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPriority(value: unknown): value is Priority {
  return typeof value === "string" && (PRIORITIES as readonly string[]).includes(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Uint8Array → 文本(逐字节 charCode;只用于比对 %PDF / %%EOF 这类 ASCII 哨兵)。 */
function asText(bytes: Uint8Array | string): string {
  if (typeof bytes === "string") return bytes;
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

/** 字符串的 utf8 字节数(与把 string 交给 sha256 的 utf8 语义保持一致)。 */
function utf8Length(text: string): number {
  let total = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) total += 1;
    else if (code < 0x800) total += 2;
    else if (code < 0x10000) total += 3;
    else total += 4;
  }
  return total;
}

function bytesLength(bytes: Uint8Array | string): number {
  return typeof bytes === "string" ? utf8Length(bytes) : bytes.length;
}

function uniquePush(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

// ---------------------------------------------------------------- 键与门限

/** 源字节 sha256(hex);string 按 utf8 计入。 */
export function digestOf(bytes: Uint8Array | string): string {
  if (typeof bytes !== "string" && !(bytes instanceof Uint8Array)) return "";
  return createHash("sha256").update(bytes).digest("hex");
}

/** 缓存键:转换器代号 + 小写扩展名 + 源字节 sha256。 */
export function contentKey(input: { converterGeneration: string; extension: string; bytes?: Uint8Array | string; digest?: string }): CacheKey {
  const sha256 = nonEmpty(input?.digest) ? input.digest : digestOf(input?.bytes ?? "");
  return {
    converterGeneration: typeof input?.converterGeneration === "string" ? input.converterGeneration : "",
    extension: typeof input?.extension === "string" ? input.extension.trim().toLowerCase() : "",
    sha256,
  };
}

/** 把 CacheKey 压成账本里的一维字符串键。 */
export function cacheKeyString(key: CacheKey): string {
  return `${key.converterGeneration}::${key.extension}::${key.sha256}`;
}

/** 拆分 cacheKeyString(账本读回/上层展示用)。 */
export function parseCacheKey(key: string): CacheKey | undefined {
  if (typeof key !== "string") return undefined;
  const parts = key.split("::");
  if (parts.length !== 3) return undefined;
  const [converterGeneration, extension, sha256] = parts;
  if (converterGeneration === undefined || extension === undefined || sha256 === undefined) return undefined;
  return { converterGeneration, extension, sha256 };
}

/** alias 键:源版本 + 路径(同一路径换版本 = 换 alias)。 */
export function aliasKey(sourceVersion: string, path: string): string {
  return `${typeof sourceVersion === "string" ? sourceVersion : ""}${ALIAS_SEP}${typeof path === "string" ? path : ""}`;
}

/** 门限缺省:8 读者 / 256MB / 2 并发转换 / 32 条排队 / 1 后台。 */
export function defaultLimits(): AdmissionLimits {
  return {
    maxReaders: 8,
    maxActiveBytes: OFFICEPDF_DEFAULT_MAX_OUTPUT_BYTES,
    maxConversions: 2,
    maxQueuedMetadata: 32,
    backgroundMax: 1,
  };
}

/** 空状态。 */
export function emptyAdmissionState(): AdmissionState {
  return { cache: {}, inflight: {}, queue: [], aliases: {}, activeBytes: 0, conversions: 0, disposed: false, seq: 0 };
}

/** 入参 state 形状校验(不 throw;坏形状一律折叠成 INVALID)。 */
export function isAdmissionState(value: unknown): value is AdmissionState {
  if (!isRecord(value)) return false;
  if (!isRecord(value["cache"]) || !isRecord(value["inflight"]) || !isRecord(value["aliases"])) return false;
  if (!Array.isArray(value["queue"])) return false;
  if (!nonNegative(value["activeBytes"]) || !nonNegative(value["conversions"]) || !nonNegative(value["seq"])) return false;
  if (typeof value["disposed"] !== "boolean") return false;
  return true;
}

/**
 * 从任意 JSON 读回态恢复成合法状态(坏条目丢弃并点名,不 throw)。
 * 持久层用它把「能认多少认多少」与「坏账本」区分开。
 */
export function sanitizeAdmissionState(raw: unknown): { state: AdmissionState; dropped: string[] } {
  const state = emptyAdmissionState();
  const dropped: string[] = [];
  if (!isRecord(raw)) {
    dropped.push("root");
    return { state, dropped };
  }
  const cache = isRecord(raw["cache"]) ? raw["cache"] : {};
  for (const [key, value] of Object.entries(cache)) {
    if (!isRecord(value)) {
      dropped.push(`cache:${key}`);
      continue;
    }
    const status = value["status"];
    if (status !== "ready" && status !== "failed") {
      dropped.push(`cache:${key}`);
      continue;
    }
    const aliases = Array.isArray(value["aliases"]) ? value["aliases"].filter((a): a is string => typeof a === "string") : [];
    const entry: CacheEntry = {
      status,
      path: typeof value["path"] === "string" ? value["path"] : "",
      size: nonNegative(value["size"]) ? value["size"] : 0,
      aliases,
      lastUsed: nonNegative(value["lastUsed"]) ? value["lastUsed"] : 0,
    };
    if (typeof value["reason"] === "string") entry.reason = value["reason"];
    state.cache[key] = entry;
  }
  const inflight = isRecord(raw["inflight"]) ? raw["inflight"] : {};
  for (const [key, value] of Object.entries(inflight)) {
    if (!isRecord(value)) {
      dropped.push(`inflight:${key}`);
      continue;
    }
    const readers = Array.isArray(value["readers"]) ? value["readers"].filter((r): r is string => nonEmpty(r)) : [];
    if (readers.length === 0) {
      dropped.push(`inflight:${key}`);
      continue;
    }
    state.inflight[key] = {
      readers,
      priority: isPriority(value["priority"]) ? value["priority"] : "foreground",
      startedAt: nonNegative(value["startedAt"]) ? value["startedAt"] : 0,
      digest: typeof value["digest"] === "string" ? value["digest"] : "",
      extension: typeof value["extension"] === "string" ? value["extension"] : "",
      size: nonNegative(value["size"]) ? value["size"] : 0,
    };
  }
  const queue = Array.isArray(raw["queue"]) ? raw["queue"] : [];
  for (const item of queue) {
    if (!isRecord(item) || !nonEmpty(item["id"]) || !nonEmpty(item["key"])) {
      dropped.push("queue");
      continue;
    }
    state.queue.push({
      id: item["id"],
      key: item["key"],
      priority: isPriority(item["priority"]) ? item["priority"] : "background",
      now: nonNegative(item["now"]) ? item["now"] : 0,
    });
  }
  const aliases = isRecord(raw["aliases"]) ? raw["aliases"] : {};
  for (const [key, value] of Object.entries(aliases)) {
    if (typeof value !== "string" || value === "") {
      dropped.push(`alias:${key}`);
      continue;
    }
    state.aliases[key] = value;
  }
  state.activeBytes = nonNegative(raw["activeBytes"]) ? raw["activeBytes"] : 0;
  state.conversions = nonNegative(raw["conversions"]) ? raw["conversions"] : 0;
  state.disposed = raw["disposed"] === true;
  state.seq = nonNegative(raw["seq"]) ? raw["seq"] : 0;
  return { state, dropped };
}

// ---------------------------------------------------------------- 内部小工具

function totalReaders(state: AdmissionState): number {
  let total = 0;
  for (const entry of Object.values(state.inflight)) total += entry.readers.length;
  return total;
}

function backgroundRunning(state: AdmissionState): number {
  let total = 0;
  for (const entry of Object.values(state.inflight)) if (entry.priority === "background") total += 1;
  return total;
}

function withCacheEntry(state: AdmissionState, key: string, entry: CacheEntry): AdmissionState {
  return { ...state, cache: { ...state.cache, [key]: entry }, seq: state.seq + 1 };
}

function queuedResult(state: AdmissionState, req: ConvertRequest, key: string, position: "head" | "tail", codes: string[]): AdmitResult {
  const entry: QueueEntry = { id: req.id, key, priority: req.priority, now: req.now };
  const queue = state.queue.slice();
  if (position === "head") queue.unshift(entry);
  else queue.push(entry);
  return { state: { ...state, queue, seq: state.seq + 1 }, action: "queued", codes, key, readers: 0 };
}

function joinResult(state: AdmissionState, req: ConvertRequest, key: string, entry: InflightEntry, codes: string[]): AdmitResult {
  const readers = entry.readers.slice();
  uniquePush(readers, req.id);
  const priority: Priority = req.priority === "foreground" ? "foreground" : entry.priority;
  const next: AdmissionState = {
    ...state,
    inflight: { ...state.inflight, [key]: { ...entry, readers, priority } },
    seq: state.seq + 1,
  };
  return { state: next, action: "join-inflight", codes, key, readers: readers.length };
}

function reuseResult(state: AdmissionState, key: string, entry: CacheEntry, req: ConvertRequest, alias?: string): AdmitResult {
  const aliases = entry.aliases.slice();
  if (alias !== undefined) uniquePush(aliases, alias);
  const next = withCacheEntry(state, key, { ...entry, aliases, lastUsed: req.now });
  const cacheAliases = { ...state.aliases };
  if (alias !== undefined) cacheAliases[alias] = key;
  return {
    state: { ...next, aliases: cacheAliases },
    action: "reuse",
    codes: [OFFICEPDF_REUSED],
    key,
    entry: next.cache[key],
    readers: 0,
  };
}

/** 同一 name 是否已有「另一个源版本」的活 alias(活 = 指向 ready 产物或在转)。 */
function detectSourceChanged(state: AdmissionState, name: string | undefined, sourceVersion: string): boolean {
  if (name === undefined) return false;
  for (const [alias, target] of Object.entries(state.aliases)) {
    const sep = alias.indexOf(ALIAS_SEP);
    if (sep < 0) continue;
    const version = alias.slice(0, sep);
    const path = alias.slice(sep + 1);
    if (path !== name || version === sourceVersion) continue;
    const cached = state.cache[target];
    const live = (cached !== undefined && cached.status === "ready") || state.inflight[target] !== undefined;
    if (live) return true;
  }
  return false;
}

// ---------------------------------------------------------------- admit

/**
 * 裁决一次请求:reuse / join-inflight / start / queued / reject。
 * 裁决顺序(新 key):读者上限 → 转换上限 → 后台/留槽 → 字节额度 → 排队元数据 → start。
 */
export function admit(state: AdmissionState, req: ConvertRequest, limits: AdmissionLimits = defaultLimits()): AdmitResult {
  const reject = (codes: string[], key?: string): AdmitResult => ({ state, action: "reject", codes, key, readers: 0 });
  if (!isAdmissionState(state) || !isRecord(req)) return reject([OFFICEPDF_INVALID]);
  if (!nonEmpty(req.id) || !nonEmpty(req.extension) || !nonEmpty(req.converterGeneration)) return reject([OFFICEPDF_INVALID]);
  if (!isPriority(req.priority) || !nonNegative(req.now)) return reject([OFFICEPDF_INVALID]);
  if (req.size !== undefined && !nonNegative(req.size)) return reject([OFFICEPDF_INVALID]);
  const sha256 = nonEmpty(req.digest) ? req.digest : req.bytes === undefined ? "" : digestOf(req.bytes);
  if (sha256 === "") return reject([OFFICEPDF_INVALID]);
  const lim = isRecord(limits) ? normalizeLimits(limits) : defaultLimits();
  if (lim === undefined) return reject([OFFICEPDF_INVALID]);

  const key = cacheKeyString({ converterGeneration: req.converterGeneration, extension: req.extension.trim().toLowerCase(), sha256 });
  if (state.disposed) return reject([OFFICEPDF_DISPOSED], key);

  // (b) alias 命中:同路径同版本 → 该 alias 指向的产物/转换才是「这次要的」
  const alias = nonEmpty(req.name) ? aliasKey(req.sourceVersion, req.name) : undefined;
  if (alias !== undefined) {
    const target = state.aliases[alias];
    if (target !== undefined) {
      const cached = state.cache[target];
      if (cached !== undefined && cached.status === "ready") return reuseResult(state, target, cached, req, alias);
      const running = state.inflight[target];
      if (running !== undefined) return joinResult(state, req, target, running, [OFFICEPDF_JOINED]);
    }
  }

  // (c) 内容键命中 ready
  const cached = state.cache[key];
  if (cached !== undefined && cached.status === "ready") return reuseResult(state, key, cached, req, alias);

  // (d) 内容键在进行中
  const running = state.inflight[key];
  if (running !== undefined) return joinResult(state, req, key, running, [OFFICEPDF_JOINED]);

  // (b') 同 name 换版本:不复用旧缓存,但继续走新转换(旧缓存保留)
  const base = detectSourceChanged(state, req.name, req.sourceVersion) ? [OFFICEPDF_SOURCE_CHANGED] : [];
  const size = req.size ?? (req.bytes === undefined ? 0 : bytesLength(req.bytes));

  // (e) ① 读者上限
  if (totalReaders(state) >= lim.maxReaders) {
    if (req.priority === "background") return queuedResult(state, req, key, "tail", [...base, OFFICEPDF_QUEUED]);
    return reject([...base, OFFICEPDF_REJECTED], key);
  }
  // (e) ② 转换上限:前台插队首,后台队尾
  if (state.conversions >= lim.maxConversions) {
    return queuedResult(state, req, key, req.priority === "foreground" ? "head" : "tail", [...base, OFFICEPDF_QUEUED]);
  }
  // (e) ③ 后台让路:后台在跑已满,或只剩最后一个转换槽(留给前台)
  if (req.priority === "background" && (backgroundRunning(state) >= lim.backgroundMax || state.conversions >= lim.maxConversions - 1)) {
    return queuedResult(state, req, key, "tail", [...base, OFFICEPDF_QUEUED]);
  }
  // (e) ④ 字节额度
  if (state.activeBytes + size > lim.maxActiveBytes) return reject([...base, OFFICEPDF_REJECTED], key);
  // (e) ⑤ 排队元数据位
  if (state.queue.length >= lim.maxQueuedMetadata) return reject([...base, OFFICEPDF_REJECTED], key);

  // (e) ⑥ start
  const aliases = { ...state.aliases };
  if (alias !== undefined) aliases[alias] = key;
  const next: AdmissionState = {
    ...state,
    inflight: {
      ...state.inflight,
      [key]: {
        readers: [req.id],
        priority: req.priority,
        startedAt: req.now,
        digest: sha256,
        extension: req.extension.trim().toLowerCase(),
        size,
      },
    },
    aliases,
    activeBytes: state.activeBytes + size,
    conversions: state.conversions + 1,
    seq: state.seq + 1,
  };
  return { state: next, action: "start", codes: [...base, OFFICEPDF_STARTED], key, readers: 1 };
}

/** 门限归一化:缺字段用缺省值补齐;非法值 → undefined(折叠成 INVALID)。 */
function normalizeLimits(raw: Record<string, unknown>): AdmissionLimits | undefined {
  const base = defaultLimits();
  const pick = (field: keyof AdmissionLimits): number | undefined => {
    const value = raw[field];
    if (value === undefined) return base[field];
    return nonNegative(value) ? value : undefined;
  };
  const maxReaders = pick("maxReaders");
  const maxActiveBytes = pick("maxActiveBytes");
  const maxConversions = pick("maxConversions");
  const maxQueuedMetadata = pick("maxQueuedMetadata");
  const backgroundMax = pick("backgroundMax");
  if (
    maxReaders === undefined ||
    maxActiveBytes === undefined ||
    maxConversions === undefined ||
    maxQueuedMetadata === undefined ||
    backgroundMax === undefined
  ) {
    return undefined;
  }
  return { maxReaders, maxActiveBytes, maxConversions, maxQueuedMetadata, backgroundMax };
}

// ---------------------------------------------------------------- complete

/**
 * 结算一次转换:产物不合格 → 清 inflight、退额度、不写 ready(INVALID_OUTPUT);
 * 合格 → 写 ready + alias(READY)。key 不在 inflight → INVALID(状态不变)。
 */
export function complete(
  state: AdmissionState,
  key: string,
  output: OutputFacts,
  opts: { maxBytes?: number; expectedSize?: number; now?: number; path?: string; sourceVersion?: string; name?: string } = {},
): CompleteResult {
  if (!isAdmissionState(state) || !nonEmpty(key) || !isRecord(output)) {
    return { state, ok: false, codes: [OFFICEPDF_INVALID], releasedBytes: 0 };
  }
  const running = state.inflight[key];
  if (running === undefined) return { state, ok: false, codes: [OFFICEPDF_INVALID], releasedBytes: 0 };
  const now = nonNegative(opts.now) ? opts.now : 0;
  const maxBytes = nonNegative(opts.maxBytes) ? opts.maxBytes : OFFICEPDF_DEFAULT_MAX_OUTPUT_BYTES;
  const size = output.size;

  const reasons: string[] = [];
  if (output.isRegular !== true) reasons.push("not-regular");
  if (output.noFollow !== true) reasons.push("followed-symlink");
  if (!asText(output.head ?? "").startsWith("%PDF")) reasons.push("bad-head");
  if (!asText(output.lastBytes ?? "").trimEnd().endsWith("%%EOF")) reasons.push("bad-tail");
  if (!(typeof size === "number" && Number.isFinite(size) && size > 0)) reasons.push("bad-size");
  else if (size > maxBytes) reasons.push("too-large");
  if (opts.expectedSize !== undefined && size !== opts.expectedSize) reasons.push("expected-size-mismatch");

  const inflight = { ...state.inflight };
  delete inflight[key];
  const released: AdmissionState = {
    ...state,
    inflight,
    conversions: Math.max(0, state.conversions - 1),
    activeBytes: Math.max(0, state.activeBytes - running.size),
    seq: state.seq + 1,
  };

  if (reasons.length > 0) {
    return { state: released, ok: false, codes: [OFFICEPDF_INVALID_OUTPUT], releasedBytes: running.size, reasons };
  }

  const aliases = { ...state.aliases };
  const entryAliases: string[] = [];
  for (const [alias, target] of Object.entries(state.aliases)) if (target === key) uniquePush(entryAliases, alias);
  if (nonEmpty(opts.sourceVersion) && nonEmpty(opts.name)) {
    const alias = aliasKey(opts.sourceVersion, opts.name);
    aliases[alias] = key;
    uniquePush(entryAliases, alias);
  }
  const entry: CacheEntry = {
    status: "ready",
    path: typeof opts.path === "string" ? opts.path : "",
    size,
    aliases: entryAliases,
    lastUsed: now,
  };
  return {
    state: { ...released, cache: { ...state.cache, [key]: entry }, aliases, seq: state.seq + 1 },
    ok: true,
    codes: [OFFICEPDF_READY],
    entry,
    releasedBytes: running.size,
  };
}

// ---------------------------------------------------------------- cancelReader

/** 撤一个读者:读者清空 → 转换作废并退额度(CANCELLED);还有人就只退这个读者。 */
export function cancelReader(state: AdmissionState, arg: { id: string; key?: string }): CancelResult {
  if (!isAdmissionState(state) || !isRecord(arg) || !nonEmpty(arg.id)) {
    return { state, codes: [OFFICEPDF_INVALID], aborted: false, remaining: 0 };
  }
  const id = arg.id;
  const keys = nonEmpty(arg.key) ? [arg.key] : Object.keys(state.inflight);
  const inflight = { ...state.inflight };
  let conversions = state.conversions;
  let activeBytes = state.activeBytes;
  let aborted = false;
  let releasedBytes = 0;
  let remaining = 0;
  let touched = false;
  for (const key of keys) {
    const entry = inflight[key];
    if (entry === undefined || !entry.readers.includes(id)) continue;
    touched = true;
    const readers = entry.readers.filter((reader) => reader !== id);
    if (readers.length === 0) {
      delete inflight[key];
      conversions = Math.max(0, conversions - 1);
      activeBytes = Math.max(0, activeBytes - entry.size);
      releasedBytes += entry.size;
      aborted = true;
    } else {
      inflight[key] = { ...entry, readers };
      remaining += readers.length;
    }
  }
  const queue = state.queue.filter((item) => item.id !== id);
  const queueRemoved = state.queue.length - queue.length;
  if (!touched && queueRemoved === 0) {
    return { state, codes: [OFFICEPDF_INVALID], aborted: false, remaining: totalReaders(state) };
  }
  const codes = aborted ? [OFFICEPDF_CANCELLED] : [];
  const next: AdmissionState = {
    ...state,
    inflight,
    queue,
    conversions,
    activeBytes,
    seq: state.seq + 1,
  };
  return { state: next, codes, aborted, remaining, queueRemoved, releasedBytes };
}

// ---------------------------------------------------------------- evictLru

/** 按 lastUsed 升序淘汰到 ≤ maxEntries;指向被淘汰 key 的 alias 一并剔除。 */
export function evictLru(state: AdmissionState, arg: { maxEntries: number; now?: number }): EvictResult {
  if (!isAdmissionState(state) || !isRecord(arg) || !nonNegative(arg.maxEntries)) {
    return { state, codes: [OFFICEPDF_INVALID], evicted: [] };
  }
  const maxEntries = Math.floor(arg.maxEntries);
  const keys = Object.keys(state.cache);
  if (keys.length <= maxEntries) return { state, codes: [], evicted: [] };
  const ordered = keys.slice().sort((a, b) => {
    const la = state.cache[a]?.lastUsed ?? 0;
    const lb = state.cache[b]?.lastUsed ?? 0;
    if (la !== lb) return la - lb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const drop = new Set(ordered.slice(0, keys.length - maxEntries));
  const cache: Record<string, CacheEntry> = {};
  for (const [key, entry] of Object.entries(state.cache)) if (!drop.has(key)) cache[key] = entry;
  const aliases: Record<string, string> = {};
  for (const [alias, target] of Object.entries(state.aliases)) if (!drop.has(target)) aliases[alias] = target;
  return {
    state: { ...state, cache, aliases, seq: state.seq + 1 },
    codes: [OFFICEPDF_EVICTED],
    evicted: [...drop].sort(),
  };
}

// ---------------------------------------------------------------- dispose

/** 关停:清掉所有在转与排队,读者名单交回调用方;之后一切请求拒绝。 */
export function dispose(state: AdmissionState): DisposeResult {
  if (!isAdmissionState(state)) return { state, codes: [OFFICEPDF_INVALID], unavailable: [] };
  const unavailable: string[] = [];
  for (const entry of Object.values(state.inflight)) for (const reader of entry.readers) uniquePush(unavailable, reader);
  return {
    state: { ...state, disposed: true, inflight: {}, queue: [], conversions: 0, activeBytes: 0, seq: state.seq + 1 },
    codes: [OFFICEPDF_DISPOSED],
    unavailable,
  };
}

// ---------------------------------------------------------------- 报告

/** 摘要(全数字,便于面板/日志直接吐)。 */
export function summarizeAdmission(state: AdmissionState): Record<string, number> {
  if (!isAdmissionState(state)) {
    return { cache: 0, ready: 0, failed: 0, inflight: 0, readers: 0, conversions: 0, activeBytes: 0, queue: 0, aliases: 0, disposed: 0, seq: 0 };
  }
  let ready = 0;
  let failed = 0;
  for (const entry of Object.values(state.cache)) {
    if (entry.status === "ready") ready += 1;
    else failed += 1;
  }
  return {
    cache: Object.keys(state.cache).length,
    ready,
    failed,
    inflight: Object.keys(state.inflight).length,
    readers: totalReaders(state),
    conversions: state.conversions,
    activeBytes: state.activeBytes,
    queue: state.queue.length,
    aliases: Object.keys(state.aliases).length,
    disposed: state.disposed ? 1 : 0,
    seq: state.seq,
  };
}
