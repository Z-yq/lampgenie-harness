/**
 * journal 存储维护协议。
 * 背景:文件式 journal(.genie/journals = global.jsonl + sessions/<sid>.jsonl)无归档面,
 * 冷启动逐文件 load,经验证 178 个会话文件 / 813MB 让 boot 从 ~8s 退化到 ~6min。
 * 协议(对应 mechanisms #123 存储维护):
 *   ① 快照:snapshotJournal 枚举 global.jsonl + sessions/*.jsonl 的 dev/ino/size/mtimeMs;
 *   ② 活 writer 保护:listHolders 读 gateway.pid / gateway.lock / session-workers/*.run.json 的 pid,
 *      判活成功即 live;活 writer 下 apply 拒跑(STORAGE_BUSY_HOLDERS),plan/dryRun 只读放行;
 *   ③ 计划:planArchive 按 mtime 阈值 + keepNewest 淘汰 + maxFiles/maxBytes 预算(大文件优先);
 *   ④ 执行:applyArchive 逐候选 pre stat 对快照 → sha256 → rename 到 archiveDir → post 复核,
 *      发生 stat 漂移(=归档窗口内被写)立即 abort 后续候选,已归档项标 drift;manifest + durable cursor;
 *   ⑤ 校验/恢复:verifyArchive 逐条重算 sha256;restoreArchive 校验后 rename 回 sessions/(目标存在拒)。
 * 纪律:本模块所有 IO 失败都不抛(回报 skipped/aborted),只由 CLI 决定退出码;
 *      不做活 writer 下的自动维护(自动维护只会 skip,不 force)。
 * 注:本文件不 import 任何相对模块——scripts/journal-maintenance.mts 需能被裸 node --experimental-strip-types
 *     直接跑(相对 .js 说明符在裸 node 下不可解析)。
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const DEFAULT_OLDER_THAN_DAYS = 7;
export const DEFAULT_MAX_FILES = 20;
export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
export const DEFAULT_KEEP_NEWEST = 10;
export const ARCHIVE_DIR_NAME = "sessions-archive";
export const MANIFEST_FILE_NAME = "manifest.jsonl";
export const CURSOR_FILE_NAME = "archive-cursor.json";

/** 归档目录路径(相对 journal 目录):<journalDir>/sessions-archive。 */
export function journalArchiveDirOf(journalDir: string): string {
  return join(journalDir, ARCHIVE_DIR_NAME);
}

// ── ① 快照 ───────────────────────────────────────────────────────────────────

export interface JournalFileStat {
  file: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

/** 枚举 global.jsonl + sessions/*.jsonl 的静态指纹(归档前快照,用于 apply 的 pre 复核)。 */
export function snapshotJournal(journalDir: string): JournalFileStat[] {
  const files: string[] = [join(journalDir, "global.jsonl")];
  const sessionsDir = join(journalDir, "sessions");
  try {
    for (const name of readdirSync(sessionsDir).sort()) {
      if (name.endsWith(".jsonl")) files.push(join(sessionsDir, name));
    }
  } catch {
    /* sessions 目录不存在=无会话分文件(空态) */
  }
  const out: JournalFileStat[] = [];
  for (const file of files) {
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      out.push({ file, dev: Number(st.dev), ino: Number(st.ino), size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* 不存在/不可读:不进快照 */
    }
  }
  return out;
}

// ── ② 活 writer 探测器 ───────────────────────────────────────────────────────

export interface HolderProbeDeps {
  /** kill 注入(测试用);缺省 process.kill。 */
  kill?: (pid: number, signal: number) => void;
}

export interface Holders {
  /** .genie/gateway.pid(纯 pid 文本;兼容 JSON {pid})。 */
  gatewayPid?: number;
  /** .genie/journals/gateway.lock(JSON {pid,start,at};兼容纯 pid)。 */
  lockPid?: number;
  /** .genie/session-workers/*.run.json 里的 pid。 */
  workerPids: number[];
  /** 判定为存活的 pid 集合。 */
  alivePids: number[];
  /** 任一持有者存活 = 活 writer(维护须 fail-closed 拒跑,自动维护只 skip)。 */
  live: boolean;
}

function readPidFile(path: string): number | undefined {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return undefined;
    if (raw.startsWith("{")) {
      const obj = JSON.parse(raw) as { pid?: unknown };
      const pid = Number(obj.pid);
      return Number.isFinite(pid) && pid > 0 ? pid : undefined;
    }
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * pid 是否存活:kill(pid,0) 成功(且非僵尸)=活;ESRCH=死;
 * EPERM/其它未知 errno = 不可判活 → 保守当活(维护缺省 fail-closed)。
 */
export function pidLooksAlive(pid: number, kill: (pid: number, signal: number) => void = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ESRCH") return false;
    // EPERM=存在但无权限;EINVAL/未知=不可判活 → 当活(拒跑)
    return true;
  }
  // Linux 僵尸态 kill(pid,0) 仍成功,业务上已死
  try {
    const st = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const close = st.lastIndexOf(")");
    const state = close >= 0 ? st.slice(close + 1).trim().charAt(0) : "";
    if (state === "Z" || state === "X" || state === "x") return false;
  } catch {
    /* 无 /proc(Windows/裁剪系统):kill 成功即当活 */
  }
  return true;
}

/** 枚举当前可能写 journal 的进程(gateway + session workers),按 kill(pid,0) 判活。 */
export function listHolders(root: string, deps: HolderProbeDeps = {}): Holders {
  const kill = deps.kill ?? ((pid: number, signal: number) => process.kill(pid, signal));
  const gatewayPid = readPidFile(join(root, ".genie", "gateway.pid"));
  const lockPid = readPidFile(join(root, ".genie", "journals", "gateway.lock"));
  const workerPids: number[] = [];
  const workerDir = join(root, ".genie", "session-workers");
  try {
    for (const name of readdirSync(workerDir).sort()) {
      if (!name.endsWith(".run.json")) continue;
      const pid = readPidFile(join(workerDir, name));
      if (pid !== undefined) workerPids.push(pid);
    }
  } catch {
    /* 无 worker 目录=无会话子进程 */
  }
  const all = [gatewayPid, lockPid, ...workerPids].filter((p): p is number => p !== undefined);
  const alivePids = [...new Set(all.filter((pid) => pidLooksAlive(pid, kill)))];
  return {
    ...(gatewayPid !== undefined ? { gatewayPid } : {}),
    ...(lockPid !== undefined ? { lockPid } : {}),
    workerPids,
    alivePids,
    live: alivePids.length > 0,
  };
}

/** 活 writer 门:live && !force && !dryRun → 拒跑;plan/dryRun 只读不禁。 */
export function archiveGate(
  holders: Holders,
  opts: { force?: boolean; dryRun?: boolean } = {},
): { ok: boolean; code?: "STORAGE_BUSY_HOLDERS"; holders: Holders } {
  if (holders.live && !opts.force && !opts.dryRun) {
    return { ok: false, code: "STORAGE_BUSY_HOLDERS", holders };
  }
  return { ok: true, holders };
}

// ── ③ 计划 ───────────────────────────────────────────────────────────────────

export interface PlanArchiveOptions {
  journalDir: string;
  /** 缺省 = <journalDir>/sessions-archive。 */
  archiveDir?: string;
  olderThanDays?: number;
  maxFiles?: number;
  maxBytes?: number;
  keepNewest?: number;
  /** 时钟注入(测试用);缺省 Date.now()。 */
  now?: number;
}

export type SkipReason =
  | "keep-newest"
  | "fresh"
  | "budget"
  | "max-files"
  | "missing"
  | "already-archived"
  | "target-exists"
  | "rename-failed"
  | "error";

export interface ArchiveCandidate {
  file: string;
  sid: string;
  bytes: number;
  mtime: number;
}

export interface ArchiveSkipped {
  file: string;
  bytes: number;
  reason: SkipReason;
  detail?: string;
}

export interface ArchivePlan {
  mode: "plan";
  journalDir: string;
  archiveDir: string;
  generatedAt: number;
  threshold: number;
  olderThanDays: number;
  maxFiles: number;
  maxBytes: number;
  keepNewest: number;
  sessionsFiles: number;
  candidates: ArchiveCandidate[];
  totalBytes: number;
  skipped: ArchiveSkipped[];
}

/**
 * 候选 = sessions/*.jsonl 中 mtime 早于阈值且不在最新 keepNewest 个;
 * 按 size 降序受 maxFiles/maxBytes 预算(greedy:装得下就装,装不下记 skipped 继续看更小的)。
 */
export function planArchive(opts: PlanArchiveOptions): ArchivePlan {
  const now = opts.now ?? Date.now();
  const olderThanDays = opts.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const keepNewest = opts.keepNewest ?? DEFAULT_KEEP_NEWEST;
  const journalDir = opts.journalDir;
  const archiveDir = opts.archiveDir ?? journalArchiveDirOf(journalDir);
  const threshold = now - olderThanDays * 86_400_000;
  const sessionsDir = join(journalDir, "sessions");

  const infos: ArchiveCandidate[] = [];
  try {
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(sessionsDir, name);
      const sid = basename(name, ".jsonl");
      try {
        const st = statSync(file);
        if (!st.isFile()) continue;
        infos.push({ file, sid, bytes: st.size, mtime: st.mtimeMs });
      } catch {
        infos.push({ file, sid, bytes: 0, mtime: 0 }); // 读不到 stat:按最旧处理,apply 会再判 missing
      }
    }
  } catch {
    /* sessions 目录不存在=空候选 */
  }

  const skipped: ArchiveSkipped[] = [];
  // keepNewest 口径:按 mtime 降序取最新 N(同 mtime 按 sid 降序,近似「后建的会话更新」)。
  const newest = [...infos].sort((a, b) => b.mtime - a.mtime || b.sid.localeCompare(a.sid));
  const keepSet = new Set(newest.slice(0, Math.max(0, keepNewest)).map((i) => i.file));
  const eligible: ArchiveCandidate[] = [];
  for (const info of infos) {
    if (keepSet.has(info.file)) {
      skipped.push({ file: info.file, bytes: info.bytes, reason: "keep-newest" });
      continue;
    }
    if (!(info.mtime < threshold)) {
      skipped.push({ file: info.file, bytes: info.bytes, reason: "fresh" });
      continue;
    }
    eligible.push(info);
  }

  eligible.sort((a, b) => b.bytes - a.bytes || a.sid.localeCompare(b.sid));
  const candidates: ArchiveCandidate[] = [];
  let totalBytes = 0;
  for (const info of eligible) {
    if (candidates.length >= maxFiles) {
      skipped.push({ file: info.file, bytes: info.bytes, reason: "max-files" });
      continue;
    }
    if (totalBytes + info.bytes > maxBytes) {
      skipped.push({ file: info.file, bytes: info.bytes, reason: "budget" });
      continue;
    }
    candidates.push(info);
    totalBytes += info.bytes;
  }

  return {
    mode: "plan",
    journalDir,
    archiveDir,
    generatedAt: now,
    threshold,
    olderThanDays,
    maxFiles,
    maxBytes,
    keepNewest,
    sessionsFiles: infos.length,
    candidates,
    totalBytes,
    skipped,
  };
}

// ── ④ 执行 ───────────────────────────────────────────────────────────────────

export interface ApplyArchiveHooks {
  /** rename 之前(pre 复核之后)调用;测试用它改写文件以制造 snapshot-drift。 */
  beforeRename?: (candidate: ArchiveCandidate) => void;
  afterRename?: (candidate: ArchiveCandidate, target: string) => void;
}

export interface ApplyArchiveOptions {
  snapshotBefore?: JournalFileStat[];
  dryRun?: boolean;
  hooks?: ApplyArchiveHooks;
  now?: number;
}

export interface ArchivedEntry {
  sid: string;
  /** 归档前的原路径(sessions/<sid>.jsonl)。 */
  file: string;
  /** 归档后的路径(archiveDir/<sid>.jsonl)。 */
  target: string;
  bytes: number;
  sha256: string;
  archivedAt: number;
  /** 归档窗口内被写(漂移)导致 abort 时,已归档项标 true。 */
  drift?: boolean;
}

export interface ApplyAbort {
  code: "SNAPSHOT_DRIFT";
  file: string;
  stage: "pre" | "post";
  detail?: string;
}

export interface ApplyResult {
  ok: boolean;
  mode: "apply";
  dryRun: boolean;
  archived: ArchivedEntry[];
  skipped: ArchiveSkipped[];
  /** dryRun 时的候选预览(非 dryRun 为空)。 */
  wouldArchive: ArchiveCandidate[];
  aborted?: ApplyAbort;
  manifestPath: string;
  cursorPath: string;
}

interface ArchiveCursor {
  updatedAt: number;
  journalDir: string;
  archiveDir: string;
  lastCompleted?: string;
  completed: number;
  totalCandidates: number;
  aborted?: ApplyAbort;
}

function sha256Of(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function appendManifest(manifestPath: string, record: Record<string, unknown>): void {
  mkdirSync(dirname(manifestPath), { recursive: true });
  appendFileSync(manifestPath, `${JSON.stringify(record)}\n`, "utf-8");
}

function writeCursor(cursorPath: string, cursor: ArchiveCursor): void {
  mkdirSync(dirname(cursorPath), { recursive: true });
  writeFileSync(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, "utf-8");
}

function readCursor(cursorPath: string): ArchiveCursor | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cursorPath, "utf-8")) as Partial<ArchiveCursor>;
    return typeof parsed === "object" && parsed !== null ? (parsed as ArchiveCursor) : undefined;
  } catch {
    return undefined;
  }
}

/** 快照 vs 当前 stat 是否一致(dev/ino/size/mtimeMs 全等)。返回不一致描述。 */
function statDrift(snap: JournalFileStat, current: { dev: number; ino: number; size: number; mtimeMs: number }): string | undefined {
  const diffs: string[] = [];
  if (snap.dev !== Number(current.dev)) diffs.push(`dev ${snap.dev}→${current.dev}`);
  if (snap.ino !== Number(current.ino)) diffs.push(`ino ${snap.ino}→${current.ino}`);
  if (snap.size !== current.size) diffs.push(`size ${snap.size}→${current.size}`);
  if (snap.mtimeMs !== current.mtimeMs) diffs.push(`mtime ${snap.mtimeMs}→${current.mtimeMs}`);
  return diffs.length > 0 ? diffs.join(",") : undefined;
}

/**
 * 逐候选归档。任何失败都降级为 skipped(不抛);stat 漂移 = abort 全部后续,
 * 已归档项保留并标 drift(manifest 追加 abort 记录)。dryRun 零写入。
 */
export function applyArchive(plan: ArchivePlan, opts: ApplyArchiveOptions = {}): ApplyResult {
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun === true;
  const manifestPath = join(plan.archiveDir, MANIFEST_FILE_NAME);
  const cursorPath = join(plan.journalDir, CURSOR_FILE_NAME);
  const base: ApplyResult = {
    ok: true,
    mode: "apply",
    dryRun,
    archived: [],
    skipped: [],
    wouldArchive: dryRun ? plan.candidates : [],
    manifestPath,
    cursorPath,
  };
  if (dryRun) return base;

  const snapshot = new Map((opts.snapshotBefore ?? snapshotJournal(plan.journalDir)).map((s) => [s.file, s]));
  const cursor = readCursor(cursorPath);
  let startIndex = 0;
  if (cursor?.lastCompleted) {
    const doneIdx = plan.candidates.findIndex((c) => c.file === cursor.lastCompleted);
    // cursor 续跑只跳过「确实已搬走」的前序候选;文件又回到 sessions(=restore 过)时从头处理。
    if (doneIdx >= 0 && !existsSync(cursor.lastCompleted)) startIndex = doneIdx + 1;
  }
  const result: ApplyResult = base;
  const finishAbort = (abort: ApplyAbort): ApplyResult => {
    result.ok = false;
    result.aborted = abort;
    for (const entry of result.archived) entry.drift = true;
    try {
      appendManifest(manifestPath, {
        type: "abort",
        code: abort.code,
        file: abort.file,
        stage: abort.stage,
        detail: abort.detail,
        archived: result.archived.map((a) => a.file),
        at: now,
      });
    } catch {
      /* manifest 故障不掩盖 abort 结论 */
    }
    try {
      writeCursor(cursorPath, {
        updatedAt: now,
        journalDir: plan.journalDir,
        archiveDir: plan.archiveDir,
        ...(result.archived.length > 0 ? { lastCompleted: result.archived[result.archived.length - 1]!.file } : {}),
        completed: result.archived.length,
        totalCandidates: plan.candidates.length,
        aborted: abort,
      });
    } catch {
      /* cursor 故障同上 */
    }
    return result;
  };

  for (let i = startIndex; i < plan.candidates.length; i++) {
    const candidate = plan.candidates[i];
    if (!candidate) continue;
    try {
      if (!existsSync(candidate.file)) {
        result.skipped.push({ file: candidate.file, bytes: candidate.bytes, reason: "already-archived" });
        continue;
      }
      const snap = snapshot.get(candidate.file);
      let pre: ReturnType<typeof statSync>;
      try {
        pre = statSync(candidate.file);
      } catch {
        result.skipped.push({ file: candidate.file, bytes: candidate.bytes, reason: "missing" });
        continue;
      }
      if (snap) {
        const drift = statDrift(snap, pre);
        if (drift) return finishAbort({ code: "SNAPSHOT_DRIFT", file: candidate.file, stage: "pre", detail: drift });
      }
      opts.hooks?.beforeRename?.(candidate);
      // beforeRename 之后的第二次 pre stat:注入写(或并发写)在这里被确定性地发现。
      let pre2: ReturnType<typeof statSync>;
      try {
        pre2 = statSync(candidate.file);
      } catch {
        result.skipped.push({ file: candidate.file, bytes: candidate.bytes, reason: "missing" });
        continue;
      }
      if (snap) {
        const drift = statDrift(snap, pre2);
        if (drift) return finishAbort({ code: "SNAPSHOT_DRIFT", file: candidate.file, stage: "pre", detail: `written-after-snapshot:${drift}` });
      }
      let sha256: string;
      try {
        sha256 = sha256Of(candidate.file);
      } catch (err) {
        result.skipped.push({ file: candidate.file, bytes: candidate.bytes, reason: "error", detail: String(err).slice(0, 160) });
        continue;
      }
      const target = join(plan.archiveDir, basename(candidate.file));
      if (existsSync(target)) {
        result.skipped.push({ file: candidate.file, bytes: candidate.bytes, reason: "target-exists" });
        continue;
      }
      try {
        mkdirSync(plan.archiveDir, { recursive: true });
        renameSync(candidate.file, target); // 原子移动(同文件系统)
      } catch (err) {
        result.skipped.push({ file: candidate.file, bytes: candidate.bytes, reason: "rename-failed", detail: String(err).slice(0, 160) });
        continue;
      }
      opts.hooks?.afterRename?.(candidate, target);
      const entry: ArchivedEntry = {
        sid: candidate.sid,
        file: candidate.file,
        target,
        bytes: candidate.bytes,
        sha256,
        archivedAt: now,
      };
      result.archived.push(entry);
      try {
        appendManifest(manifestPath, {
          sid: entry.sid,
          file: entry.file,
          bytes: entry.bytes,
          sha256: entry.sha256,
          archivedAt: entry.archivedAt,
        });
      } catch (err) {
        result.skipped.push({ file: candidate.file, bytes: candidate.bytes, reason: "error", detail: `manifest:${String(err).slice(0, 120)}` });
      }
      try {
        writeCursor(cursorPath, {
          updatedAt: now,
          journalDir: plan.journalDir,
          archiveDir: plan.archiveDir,
          lastCompleted: candidate.file,
          completed: result.archived.length,
          totalCandidates: plan.candidates.length,
        });
      } catch {
        /* cursor 写失败不撤销已完成的归档 */
      }
      // post 复核:源路径不应再存在;存在且指纹变了 = 归档窗口内被写(已归档,仍需 abort 后续)。
      if (existsSync(candidate.file)) {
        try {
          const post = statSync(candidate.file);
          if (post.size !== pre2.size || post.mtimeMs !== pre2.mtimeMs || Number(post.ino) !== Number(pre2.ino)) {
            return finishAbort({ code: "SNAPSHOT_DRIFT", file: candidate.file, stage: "post", detail: "source recreated/changed after rename" });
          }
        } catch {
          /* 刚消失/不可读:视作正常(rename 后并发 unlink) */
        }
      }
    } catch (err) {
      result.skipped.push({ file: candidate.file, bytes: candidate.bytes, reason: "error", detail: String(err).slice(0, 160) });
    }
  }
  return result;
}

// ── ⑤ 校验 / 恢复 ────────────────────────────────────────────────────────────

export type VerifyFailureCode = "MANIFEST_MISSING" | "BAD_RECORD" | "MISSING" | "HASH_MISMATCH";

export interface VerifyFailure {
  /** 原始日志路径(manifest 坏行时为 "manifest.jsonl:<行号>")。 */
  file: string;
  sid?: string;
  code: VerifyFailureCode;
  expected?: string;
  actual?: string;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  failures: VerifyFailure[];
  manifestPath: string;
}

export interface ArchiveManifestRecord {
  type?: string;
  sid?: string;
  file?: string;
  bytes?: number;
  sha256?: string;
  archivedAt?: number;
}

/** 逐条重算归档文件 sha256 与 manifest 比对;manifest 坏行计入 failures 不抛。
 *  已 restore 回迁的归档记录不再算「应存在于归档」——按文件名配对 archive/restore 记录,只有
 *  「归档次数 > 回迁次数」的文件才校验(archive→restore→再 archive 会重新入账)。 */
export function verifyArchive(archiveDir: string): VerifyResult {
  const manifestPath = join(archiveDir, MANIFEST_FILE_NAME);
  const failures: VerifyFailure[] = [];
  if (!existsSync(manifestPath)) {
    return { ok: false, checked: 0, failures: [{ file: manifestPath, code: "MANIFEST_MISSING" }], manifestPath };
  }
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch (err) {
    return {
      ok: false,
      checked: 0,
      failures: [{ file: manifestPath, code: "MANIFEST_MISSING", actual: String(err).slice(0, 160) }],
      manifestPath,
    };
  }
  interface Parsed {
    record: ArchiveManifestRecord;
    line: number;
  }
  const parsed: Parsed[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (!line) continue;
    try {
      parsed.push({ record: JSON.parse(line) as ArchiveManifestRecord, line: i + 1 });
    } catch {
      failures.push({ file: `${MANIFEST_FILE_NAME}:${i + 1}`, code: "BAD_RECORD" });
    }
  }
  const restoredCount = new Map<string, number>();
  const archiveCount = new Map<string, number>();
  const lastRecord = new Map<string, ArchiveManifestRecord>();
  for (const { record, line } of parsed) {
    const key = typeof record.file === "string" && record.file ? basename(record.file) : "";
    if (record.type === "restore") {
      if (key) restoredCount.set(key, (restoredCount.get(key) ?? 0) + 1);
      continue;
    }
    if (record.type === "abort") continue; // 事件记录:无 sha 可比
    if (!record.file || !record.sha256) {
      failures.push({ file: `${MANIFEST_FILE_NAME}:${line}`, code: "BAD_RECORD", ...(record.sid ? { sid: record.sid } : {}) });
      continue;
    }
    archiveCount.set(key, (archiveCount.get(key) ?? 0) + 1);
    lastRecord.set(key, record);
  }
  let checked = 0;
  for (const [key, count] of archiveCount) {
    if (count <= (restoredCount.get(key) ?? 0)) continue; // 已被 restore 回迁:不在归档里是正常态
    const record = lastRecord.get(key);
    if (!record?.sha256) continue;
    checked++;
    const archivedFile = join(archiveDir, key);
    if (!existsSync(archivedFile)) {
      failures.push({ file: record.file ?? key, code: "MISSING", ...(record.sid ? { sid: record.sid } : {}), expected: record.sha256 });
      continue;
    }
    let actual: string;
    try {
      actual = sha256Of(archivedFile);
    } catch (err) {
      failures.push({ file: record.file ?? key, code: "MISSING", ...(record.sid ? { sid: record.sid } : {}), actual: String(err).slice(0, 160) });
      continue;
    }
    if (actual !== record.sha256) {
      failures.push({ file: record.file ?? key, code: "HASH_MISMATCH", ...(record.sid ? { sid: record.sid } : {}), expected: record.sha256, actual });
    }
  }
  return { ok: failures.length === 0, checked, failures, manifestPath };
}

export interface RestoreOptions {
  archiveDir: string;
  journalDir: string;
  sid: string;
}

export type RestoreFailureCode =
  | "ARCHIVE_NOT_FOUND"
  | "ARCHIVE_FILE_MISSING"
  | "RESTORE_TARGET_EXISTS"
  | "RESTORE_HASH_MISMATCH"
  | "RESTORE_IO_ERROR";

export type RestoreResult =
  | { ok: true; sid: string; restored: string }
  | { ok: false; code: RestoreFailureCode; detail?: string; target?: string; expected?: string; actual?: string };

/** sha256 校验后 rename 回 sessions/<sid>.jsonl;目标已存在 → RESTORE_TARGET_EXISTS(绝不覆盖)。 */
export function restoreArchive(opts: RestoreOptions): RestoreResult {
  const manifestPath = join(opts.archiveDir, MANIFEST_FILE_NAME);
  const sid = String(opts.sid);
  let records: ArchiveManifestRecord[] = [];
  try {
    records = readFileSync(manifestPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ArchiveManifestRecord);
  } catch (err) {
    return { ok: false, code: "ARCHIVE_NOT_FOUND", detail: String(err).slice(0, 160) };
  }
  const record = [...records].reverse().find((r) => r.sid === sid && typeof r.sha256 === "string" && !r.type);
  if (!record || !record.file || !record.sha256) {
    return { ok: false, code: "ARCHIVE_NOT_FOUND", detail: `manifest 无 sid=${sid} 的归档记录` };
  }
  const archivedFile = join(opts.archiveDir, basename(record.file));
  const target = join(opts.journalDir, "sessions", basename(record.file));
  if (existsSync(target)) return { ok: false, code: "RESTORE_TARGET_EXISTS", target };
  if (!existsSync(archivedFile)) return { ok: false, code: "ARCHIVE_FILE_MISSING", detail: archivedFile };
  let actual: string;
  try {
    actual = sha256Of(archivedFile);
  } catch (err) {
    return { ok: false, code: "RESTORE_IO_ERROR", detail: String(err).slice(0, 160) };
  }
  if (actual !== record.sha256) {
    return { ok: false, code: "RESTORE_HASH_MISMATCH", expected: record.sha256, actual };
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(archivedFile, target);
  } catch (err) {
    return { ok: false, code: "RESTORE_IO_ERROR", detail: String(err).slice(0, 160) };
  }
  try {
    appendManifest(manifestPath, { type: "restore", sid, file: record.file, restoredAt: Date.now() });
  } catch {
    /* 回迁已完成:留痕失败不撤销结果 */
  }
  return { ok: true, sid, restored: target };
}
