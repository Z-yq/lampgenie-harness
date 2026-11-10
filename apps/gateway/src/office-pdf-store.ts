/**
 * Office→PDF 准入的持久层(#182,生产侧):把 office-pdf-admission 的纯状态机落到单一 JSON 账本。
 *
 * 数据面:`<root>/.genie/rsi/office-pdf.json`
 *   { "v": 1, "state": { cache, inflight, queue, aliases, activeBytes, conversions, disposed, seq } }
 * 产物面:`<root>/.genie/rsi/office-pdf-out/<digest>.pdf`(由注入的 converter 写,本模块只要求它能被 stat)。
 *
 * 为什么是整账本 + 原子替换:
 * 准入状态是**当下态**(谁在等、谁在转、占了多少钱),读时只关心当前结论;追加事件流会让
 * 「还能不能收一个新请求」退化成每次全量折叠。写临时文件 → renameSync 让「读到的永远是某一
 * 完整代」成立:崩溃最多丢掉最后一次未 rename 的写,不会读到半个 inflight。
 *
 * 为什么 converter 是注入的:
 * 本层是准入与账本,不负责 spawn LibreOffice(那是部署/进程管理的事,也不该在单元测试里跑真的)。
 * 注入 converter 后:真环境传真的,测试传假的,准入裁决与产物校验逻辑完全共用一条路径。
 *
 * 失败口径:
 * - 参数错误(TypeError)是唯一 throw 的情形。
 * - 读失败(文件不存在 / JSON 坏 / 顶层形状坏)→ 折叠成 OFFICEPDF_STORE_ERROR,**写操作拒写**:
 *   坏账本上先落库会掩盖原始损坏,宁可停下等人看。
 * - 写后校验(重读比对 cache/inflight/queue 规模)不过 → OFFICEPDF_STORE_WRITE_MISMATCH(不 throw)。
 * - 业务拒绝(REJECTED / INVALID_OUTPUT / SOURCE_CHANGED / INVALID)直接透传 runtime 稳定码,
 *   且**不写盘**(拒收前零副作用)。
 * - store 自产码不写进 runtime 码表(OFFICEPDF_STORE_CODES 只在本层出现)。
 *
 * 依赖纪律:node:fs / node:path + runtime 纯逻辑(经 workspace 子路径导入)。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  admit,
  cancelReader,
  complete,
  dispose,
  emptyAdmissionState,
  evictLru,
  OFFICEPDF_INVALID,
  OFFICEPDF_INVALID_OUTPUT,
  OFFICEPDF_REJECTED,
  OFFICEPDF_SOURCE_CHANGED,
  OFFICEPDF_VERSION,
  sanitizeAdmissionState,
  summarizeAdmission,
  type AdmissionLimits,
  type AdmissionState,
  type CacheEntry,
  type ConvertRequest,
  type InflightEntry,
  type OutputFacts,
  type QueueEntry,
} from "@lampgenie/runtime/agent/office-pdf-admission";

/** store 层自产的失败码(业务拒绝沿用 runtime 的 OFFICEPDF_* 码)。 */
export const OFFICEPDF_STORE_CODES = ["OFFICEPDF_STORE_ERROR", "OFFICEPDF_STORE_WRITE_MISMATCH"] as const;

export type OfficePdfStoreCode = (typeof OFFICEPDF_STORE_CODES)[number];

/** 相对仓库根的账本/产物位置。 */
export const OFFICEPDF_RELATIVE_DIR = ".genie/rsi";
export const OFFICEPDF_FILE = "office-pdf.json";
export const OFFICEPDF_OUT_DIRNAME = "office-pdf-out";

/** 账本与产物目录。 */
export interface OfficePdfPaths {
  dir: string;
  file: string;
  outDir: string;
}

let tmpSeq = 0;

function requireRoot(root: string, who: string): string {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError(`${who}: root 必须是非空字符串`);
  return root;
}

/** 解析账本/产物路径;root 必填。 */
export function officePdfPaths(root: string): OfficePdfPaths {
  const base = requireRoot(root, "officePdfPaths");
  const dir = join(base, OFFICEPDF_RELATIVE_DIR);
  return { dir, file: join(dir, OFFICEPDF_FILE), outDir: join(dir, OFFICEPDF_OUT_DIRNAME) };
}

// ---------------------------------------------------------------- converter

/** 转换器输入:只给定位信息 + 落点 key(转换器自己决定怎么写)。 */
export interface ConverterInput {
  root: string;
  key: string;
  extension: string;
  digest?: string;
  sourcePath?: string;
}

/** 转换器输出:产物事实(全部由转换器如实报告,本层不替它猜)。 */
export interface ConverterOutput {
  ok: boolean;
  path?: string;
  head?: string;
  tail?: string;
  size?: number;
  noFollow?: boolean;
  isRegular?: boolean;
  error?: string;
}

/** 注入式转换器(本模块不 spawn 真 LibreOffice)。 */
export type Converter = (input: ConverterInput) => ConverterOutput;

/** 假转换器:把最小合法 PDF 写进 <root>/.genie/rsi/office-pdf-out/<digest>.pdf 并回报真实 stat。 */
export function writeStubPdf(root: string, input: { key: string; digest?: string; extension?: string }): ConverterOutput {
  const paths = officePdfPaths(root);
  const name = `${(input.digest ?? input.key).replace(/[^0-9a-zA-Z._-]/g, "_")}.pdf`;
  const target = join(paths.outDir, name);
  try {
    mkdirSync(paths.outDir, { recursive: true });
    const body = `%PDF-1.4\n% stub converter ${input.extension ?? ""} key=${input.key}\n1 0 obj<<>>endobj\ntrailer\n%%EOF\n`;
    writeFileSync(target, body, "utf8");
    const info = statSync(target);
    const text = readFileSync(target, "utf8");
    return {
      ok: true,
      path: target,
      head: text.slice(0, 8),
      tail: text.slice(-16),
      size: info.size,
      isRegular: info.isFile(),
      noFollow: true,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------- 账本读写

/** 读账本结果。 */
export interface ReadOfficePdfResult {
  ok: boolean;
  codes: string[];
  state: AdmissionState;
  dropped: string[];
  file: string;
  exists: boolean;
}

/**
 * 读账本并做形状校验。
 * 文件不存在 = 空状态 + ok(首次运行);文件存在但解析/顶层形状失败 = ok:false(调用方必须拒写)。
 */
export function readOfficePdfState(root: string): ReadOfficePdfResult {
  const paths = officePdfPaths(root);
  if (!existsSync(paths.file)) {
    return { ok: true, codes: [], state: emptyAdmissionState(), dropped: [], file: paths.file, exists: false };
  }
  let text: string;
  try {
    text = readFileSync(paths.file, "utf8");
  } catch {
    return { ok: false, codes: ["OFFICEPDF_STORE_ERROR"], state: emptyAdmissionState(), dropped: [], file: paths.file, exists: true };
  }
  if (text.trim() === "") {
    return { ok: true, codes: [], state: emptyAdmissionState(), dropped: [], file: paths.file, exists: true };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, codes: ["OFFICEPDF_STORE_ERROR"], state: emptyAdmissionState(), dropped: [], file: paths.file, exists: true };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, codes: ["OFFICEPDF_STORE_ERROR"], state: emptyAdmissionState(), dropped: [], file: paths.file, exists: true };
  }
  const holder = raw as { v?: unknown; state?: unknown };
  const { state, dropped } = sanitizeAdmissionState(holder.state);
  return { ok: true, codes: [], state, dropped, file: paths.file, exists: true };
}

/** 写账本结果。 */
export interface WriteOfficePdfResult {
  ok: boolean;
  codes: string[];
  file: string;
  cacheCount: number;
}

/** 原子写整账本:临时文件 → rename;写后重读比对规模。 */
export function writeOfficePdfState(root: string, state: AdmissionState): WriteOfficePdfResult {
  const paths = officePdfPaths(root);
  try {
    mkdirSync(dirname(paths.file), { recursive: true });
  } catch {
    return { ok: false, codes: ["OFFICEPDF_STORE_ERROR"], file: paths.file, cacheCount: 0 };
  }
  const payload = { v: OFFICEPDF_VERSION, state };
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
    return { ok: false, codes: ["OFFICEPDF_STORE_ERROR"], file: paths.file, cacheCount: 0 };
  }

  // 写后校验:重新解析落盘内容,规模必须与内存一致。
  try {
    const after = JSON.parse(readFileSync(paths.file, "utf8")) as { v?: unknown; state?: { cache?: unknown; inflight?: unknown; queue?: unknown } };
    const stateAfter = after?.state;
    const cacheCount =
      stateAfter !== null && typeof stateAfter === "object" && typeof stateAfter.cache === "object" && stateAfter.cache !== null
        ? Object.keys(stateAfter.cache as Record<string, unknown>).length
        : -1;
    const inflightCount =
      stateAfter !== null && typeof stateAfter === "object" && typeof stateAfter.inflight === "object" && stateAfter.inflight !== null
        ? Object.keys(stateAfter.inflight as Record<string, unknown>).length
        : -1;
    const queueCount = stateAfter !== null && typeof stateAfter === "object" && Array.isArray(stateAfter.queue) ? stateAfter.queue.length : -1;
    const expectedCache = Object.keys(state.cache).length;
    if (cacheCount !== expectedCache || inflightCount !== Object.keys(state.inflight).length || queueCount !== state.queue.length) {
      return { ok: false, codes: ["OFFICEPDF_STORE_WRITE_MISMATCH"], file: paths.file, cacheCount };
    }
    if (after?.v !== OFFICEPDF_VERSION) {
      return { ok: false, codes: ["OFFICEPDF_STORE_WRITE_MISMATCH"], file: paths.file, cacheCount };
    }
    return { ok: true, codes: [], file: paths.file, cacheCount };
  } catch {
    return { ok: false, codes: ["OFFICEPDF_STORE_WRITE_MISMATCH"], file: paths.file, cacheCount: 0 };
  }
}

// ---------------------------------------------------------------- 读—裁决—写

/** 单个准入动作的落盘结果。 */
export interface OfficePdfOpResult {
  ok: boolean;
  codes: string[];
  action?: string;
  key?: string;
  entry?: CacheEntry;
  readers: number;
  file: string;
  persisted: boolean;
  summary: Record<string, number>;
  detail?: Record<string, unknown>;
}

function summarize(state: AdmissionState): Record<string, number> {
  return summarizeAdmission(state);
}

/**
 * 落盘纪律(各动作函数共用):裁决确实推进了状态才写盘;读失败或零变更都零写入。
 * 注意:裁决为**拒绝**但状态确实变了(如 complete 失败要清 inflight),仍必须落盘,
 * 否则「已判失败」的 inflight 在磁盘上还占着额度,下次还能被 join。
 */

// ---------------------------------------------------------------- 动作

/** admit 的可选参数。 */
export interface AdmitOnDiskOptions {
  limits?: AdmissionLimits;
  /** 源文件路径(只记在结果里,供上层真转换器用)。 */
  sourcePath?: string;
}

/** 准入一次请求:reuse / join-inflight / start / queued / reject(拒绝不写盘)。 */
export function admitOnDisk(root: string, req: ConvertRequest, opts: AdmitOnDiskOptions = {}): OfficePdfOpResult {
  requireRoot(root, "admitOnDisk");
  const read = readOfficePdfState(root);
  if (!read.ok) {
    return {
      ok: false,
      codes: [...read.codes, "OFFICEPDF_STORE_ERROR"],
      readers: 0,
      file: read.file,
      persisted: false,
      summary: summarize(read.state),
      detail: { reason: "unreadable-ledger" },
    };
  }
  const result = admit(read.state, req, opts.limits);
  const mutated = JSON.stringify(result.state) !== JSON.stringify(read.state);
  const write = mutated ? writeOfficePdfState(root, result.state) : undefined;
  const codes = write !== undefined && !write.ok ? [...result.codes, ...write.codes] : result.codes.slice();
  return {
    // 业务拒绝(action==="reject")不算成功;但 DISPOSED 之后也不该写盘(状态没变,自然没写)。
    ok: result.action !== "reject" && (write === undefined || write.ok),
    codes,
    action: result.action,
    key: result.key,
    entry: result.entry,
    readers: result.readers,
    file: write?.file ?? read.file,
    persisted: write?.ok ?? false,
    summary: summarize(result.state),
    detail: {
      sourcePath: opts.sourcePath,
      priority: req.priority,
      queued: result.state.queue.length,
      conversions: result.state.conversions,
      activeBytes: result.state.activeBytes,
    },
  };
}

/** complete 的可选参数。 */
export interface CompleteOnDiskArg {
  key: string;
  /** 覆盖产物首部/尾部(用于模拟坏产物);给 converter 时以 converter 报告为准,这里仅覆盖。 */
  head?: string;
  tail?: string;
  size?: number;
  isRegular?: boolean;
  noFollow?: boolean;
  maxBytes?: number;
  expectedSize?: number;
  now?: number;
  path?: string;
  sourceVersion?: string;
  name?: string;
  /** 注入转换器:提供时先转换再结算。 */
  converter?: Converter;
  sourcePath?: string;
}

/**
 * 结算一次转换。
 * 给 converter → 先转换再按产物事实结算;不给 → 用 arg 里的事实(测试/重放场景)。
 * 产物不合格 → 清 inflight、退额度、不写 ready(INVALID_OUTPUT)。
 */
export function completeOnDisk(root: string, arg: CompleteOnDiskArg): OfficePdfOpResult {
  requireRoot(root, "completeOnDisk");
  if (arg === null || typeof arg !== "object" || typeof arg.key !== "string" || arg.key === "") {
    throw new TypeError("completeOnDisk: 需要非空 key");
  }
  const read = readOfficePdfState(root);
  if (!read.ok) {
    return {
      ok: false,
      codes: [...read.codes, "OFFICEPDF_STORE_ERROR"],
      readers: 0,
      file: read.file,
      persisted: false,
      summary: summarize(read.state),
      key: arg.key,
      detail: { reason: "unreadable-ledger" },
    };
  }
  const running = read.state.inflight[arg.key];
  if (running === undefined) {
    return {
      ok: false,
      codes: [OFFICEPDF_INVALID],
      readers: 0,
      file: read.file,
      persisted: false,
      summary: summarize(read.state),
      key: arg.key,
      detail: { reason: "key-not-inflight" },
    };
  }

  let converted: ConverterOutput | undefined;
  let converterError: string | undefined;
  if (typeof arg.converter === "function") {
    converted = arg.converter({
      root,
      key: arg.key,
      extension: running.extension,
      digest: running.digest,
      sourcePath: arg.sourcePath,
    });
    if (!converted.ok) converterError = converted.error ?? "converter-failed";
  }

  const facts: OutputFacts = {
    isRegular: arg.isRegular ?? converted?.isRegular ?? true,
    noFollow: arg.noFollow ?? converted?.noFollow ?? true,
    size: arg.size ?? converted?.size ?? 0,
    head: arg.head ?? converted?.head ?? "",
    lastBytes: arg.tail ?? converted?.tail ?? "",
  };
  const result = complete(read.state, arg.key, facts, {
    maxBytes: arg.maxBytes,
    expectedSize: arg.expectedSize,
    now: arg.now,
    path: arg.path ?? converted?.path,
    sourceVersion: arg.sourceVersion,
    name: arg.name,
  });
  const mutated = JSON.stringify(result.state) !== JSON.stringify(read.state);
  const write = mutated ? writeOfficePdfState(root, result.state) : undefined;
  const codes = write !== undefined && !write.ok ? [...result.codes, ...write.codes] : result.codes.slice();
  return {
    ok: result.ok && (write === undefined || write.ok),
    codes,
    action: result.ok ? "ready" : "invalid-output",
    key: arg.key,
    entry: result.entry,
    readers: 0,
    file: write?.file ?? read.file,
    persisted: write?.ok ?? false,
    summary: summarize(result.state),
    detail: {
      releasedBytes: result.releasedBytes,
      reasons: converterError === undefined ? (result.reasons ?? []) : [converterError, ...(result.reasons ?? [])],
    },
  };
}

/** cancel 参数。 */
export interface CancelOnDiskArg {
  id: string;
  key?: string;
  now?: number;
}

/** 撤一个读者(最后一个读者撤了 = 转换作废并退额度)。 */
export function cancelOnDisk(root: string, arg: CancelOnDiskArg): OfficePdfOpResult {
  requireRoot(root, "cancelOnDisk");
  if (arg === null || typeof arg !== "object" || typeof arg.id !== "string" || arg.id === "") {
    throw new TypeError("cancelOnDisk: 需要非空读者 id");
  }
  const read = readOfficePdfState(root);
  if (!read.ok) {
    return {
      ok: false,
      codes: [...read.codes, "OFFICEPDF_STORE_ERROR"],
      readers: 0,
      file: read.file,
      persisted: false,
      summary: summarize(read.state),
      detail: { reason: "unreadable-ledger" },
    };
  }
  const result = cancelReader(read.state, { id: arg.id, key: arg.key });
  const mutated = JSON.stringify(result.state) !== JSON.stringify(read.state);
  const write = mutated ? writeOfficePdfState(root, result.state) : undefined;
  const invalid = result.codes.includes(OFFICEPDF_INVALID);
  const codes = write !== undefined && !write.ok ? [...result.codes, ...write.codes] : result.codes.slice();
  return {
    ok: !invalid && (write === undefined || write.ok),
    codes,
    action: result.aborted ? "cancelled" : "cancelled-reader",
    key: arg.key,
    readers: result.remaining,
    file: write?.file ?? read.file,
    persisted: write?.ok ?? false,
    summary: summarize(result.state),
    detail: { aborted: result.aborted, queueRemoved: result.queueRemoved ?? 0, releasedBytes: result.releasedBytes ?? 0 },
  };
}

/** evict 参数。 */
export interface EvictOnDiskArg {
  maxEntries: number;
  now?: number;
}

/** 按 lastUsed 淘汰到 ≤ maxEntries。 */
export function evictOnDisk(root: string, arg: EvictOnDiskArg): OfficePdfOpResult {
  requireRoot(root, "evictOnDisk");
  if (arg === null || typeof arg !== "object" || !Number.isFinite(arg.maxEntries)) {
    throw new TypeError("evictOnDisk: maxEntries 必须是有限数字");
  }
  const read = readOfficePdfState(root);
  if (!read.ok) {
    return {
      ok: false,
      codes: [...read.codes, "OFFICEPDF_STORE_ERROR"],
      readers: 0,
      file: read.file,
      persisted: false,
      summary: summarize(read.state),
      detail: { reason: "unreadable-ledger" },
    };
  }
  const result = evictLru(read.state, { maxEntries: arg.maxEntries, now: arg.now });
  const mutated = JSON.stringify(result.state) !== JSON.stringify(read.state);
  const write = mutated ? writeOfficePdfState(root, result.state) : undefined;
  const codes = write !== undefined && !write.ok ? [...result.codes, ...write.codes] : result.codes.slice();
  return {
    ok: result.codes.includes(OFFICEPDF_INVALID) ? false : write === undefined || write.ok,
    codes,
    action: "evict",
    readers: 0,
    file: write?.file ?? read.file,
    persisted: write?.ok ?? false,
    summary: summarize(result.state),
    detail: { evicted: result.evicted },
  };
}

/** 关停:清在转/排队,读者名单交回;之后一切 admit 拒绝。 */
export function disposeOnDisk(root: string): OfficePdfOpResult {
  requireRoot(root, "disposeOnDisk");
  const read = readOfficePdfState(root);
  if (!read.ok) {
    return {
      ok: false,
      codes: [...read.codes, "OFFICEPDF_STORE_ERROR"],
      readers: 0,
      file: read.file,
      persisted: false,
      summary: summarize(read.state),
      detail: { reason: "unreadable-ledger" },
    };
  }
  const result = dispose(read.state);
  const mutated = JSON.stringify(result.state) !== JSON.stringify(read.state);
  const write = mutated ? writeOfficePdfState(root, result.state) : undefined;
  const codes = write !== undefined && !write.ok ? [...result.codes, ...write.codes] : result.codes.slice();
  return {
    ok: write === undefined || write.ok,
    codes,
    action: "dispose",
    readers: 0,
    file: write?.file ?? read.file,
    persisted: write?.ok ?? false,
    summary: summarize(result.state),
    detail: { unavailable: result.unavailable },
  };
}

// ---------------------------------------------------------------- 报告

/** 报告单条(面板/CLI 直接吐)。 */
export interface OfficePdfReportEntry {
  key: string;
  status: string;
  size: number;
  lastUsed: number;
  path: string;
}

export interface OfficePdfReport {
  ok: boolean;
  codes: string[];
  file: string;
  exists: boolean;
  dropped: string[];
  summary: Record<string, number>;
  cache: OfficePdfReportEntry[];
  inflight: Array<{ key: string; digest: string; extension: string; size: number; readers: number; priority: string; startedAt: number }>;
  queue: QueueEntry[];
  aliases: Record<string, string>;
}

/** 账本报告(只读)。 */
export function reportOfficePdf(root: string): OfficePdfReport {
  requireRoot(root, "reportOfficePdf");
  const read = readOfficePdfState(root);
  const cache: OfficePdfReportEntry[] = Object.entries(read.state.cache)
    .map(([key, entry]) => ({ key, status: entry.status, size: entry.size, lastUsed: entry.lastUsed, path: entry.path }))
    .sort((a, b) => (a.lastUsed === b.lastUsed ? (a.key < b.key ? -1 : 1) : a.lastUsed - b.lastUsed));
  const inflight = Object.entries(read.state.inflight)
    .map(([key, entry]) => inflightRow(key, entry))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  return {
    ok: read.ok,
    codes: read.ok ? [] : [...read.codes, "OFFICEPDF_STORE_ERROR"],
    file: read.file,
    exists: read.exists,
    dropped: read.dropped,
    summary: summarize(read.state),
    cache,
    inflight,
    queue: read.state.queue.slice(),
    aliases: { ...read.state.aliases },
  };
}

function inflightRow(key: string, entry: InflightEntry): OfficePdfReport["inflight"][number] {
  return {
    key,
    digest: entry.digest,
    extension: entry.extension,
    size: entry.size,
    readers: entry.readers.length,
    priority: entry.priority,
    startedAt: entry.startedAt,
  };
}

/** 兜底:业务拒绝码集合(CLI 用来映射 exit 2)。 */
export const OFFICEPDF_REJECTION_CODES = [OFFICEPDF_REJECTED, OFFICEPDF_INVALID_OUTPUT, OFFICEPDF_SOURCE_CHANGED] as const;

export function isOfficePdfRejection(code: string): boolean {
  return (OFFICEPDF_REJECTION_CODES as readonly string[]).includes(code);
}

/** OFFICEPDF_INVALID 的语义重导出(便于 CLI 只依赖 store)。 */
export { OFFICEPDF_INVALID };
