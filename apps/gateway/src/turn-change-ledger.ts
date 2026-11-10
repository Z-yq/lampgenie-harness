/**
 *  轮末变更账本(turn-change-ledger),纯函数 + 异步 git 采集。
 * 口径:任务开工建 git 基线(路径 → XY 状态/mtime/大小),收尾再采一次并与本任务窗口内的
 * 工具触碰路径交叉,产出三态清单:
 *   changed   末态 git status 新增 / XY 变化 / stat 的 mtime 或 size 变化;
 *   unknown   工具触碰过但 git 看不见(被忽略/仓外/stat 失败)——「未知」不等于「未改」;
 *   oversized size 超阈值或缺省 1MB / 二进制文件,单列且不省略(人工需要知道它们);
 * 非 git 根:以工具触碰路径 + mtime 变化判 changed,stat 失败判 unknown。
 * 纪律:
 *  - 全部异步(execFile,禁 execSync),不阻塞事件循环;
 *  - 输出只给 journal/面板/审计,**不进模型上下文**(调用方不得拼进 finalOut);
 *  - 上限 changed 200 / unknown 50,超出只计数并标 truncated,不静默省略。
 */
import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 账本里的一条基线条目(开工时的事实)。 */
export interface BaselineFile {
  /** git status XY 两字符(如 " M"/"??");非 git 模式下为 "exists"。 */
  status: string;
  mtimeMs: number;
  size: number;
}

export type ChangeMode = "git" | "non-git";

export interface ChangeBaseline {
  mode: ChangeMode;
  /** 实际做 stat 的根:git 模式下是仓根(git rev-parse --show-toplevel),非 git 就是入参 root。 */
  statRoot: string;
  /** 开工时 git status 里已经在册的路径(路径相对 statRoot,posix 分隔)。 */
  files: Record<string, BaselineFile>;
}

export interface ChangeEntry {
  path: string;
  /** 末态 git status XY;非 git 模式为 "modified"/"exists"。 */
  status: string;
  size: number;
  oversized: boolean;
}

export interface UnknownEntry {
  path: string;
  reason: string;
}

export interface OversizedEntry {
  path: string;
  size: number;
}

export interface ChangeLedger {
  mode: ChangeMode;
  baselineCount: number;
  changed: ChangeEntry[];
  unknown: UnknownEntry[];
  oversized: OversizedEntry[];
  truncated: { changed: boolean; unknown: boolean; changedTotal: number; unknownTotal: number };
}

/** journal 事件最小面(与 verification-ledger 同形态,测试可直接喂普通对象)。 */
export interface LedgerEvent {
  seq?: number;
  kind: string;
  payload?: unknown;
}

/** 上限:changed 200 / unknown 50(超出计数 + 标 truncated)。 */
export const MAX_CHANGED = 200;
export const MAX_UNKNOWN = 50;
/** 缺省超大阈值:1MB。 */
export const DEFAULT_OVERSIZED_BYTES = 1024 * 1024;

const WRITE_TOOLS = new Set(["edit_file", "write_file", "apply_patch"]);
/** 二进制探测读取的头部字节数。 */
const SNIFF_BYTES = 4096;
/** git 输出上限(大仓 untracked 全列可能很大)。 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

interface GitEntry {
  status: string;
  path: string;
}

/** 跑一条 git 命令(异步);失败(git 缺失/非仓/超时)返回 null,由调用方判 non-git。 */
async function runGit(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
      timeout: 20_000,
      windowsHide: true,
      encoding: "utf8",
    });
    return String(stdout ?? "");
  } catch {
    return null;
  }
}

/**
 * 解析 `git status --porcelain=v1 -z` 的 NUL 分隔输出。
 * 普通条目形如 `XY <path>\0`;R/C(重命名/复制)在 -z 下输出 `XY <新路径>\0<旧路径>\0`
 * (字段顺序被反转),取新路径、跳过旧路径字段。
 */
export function parsePorcelainZ(raw: string): GitEntry[] {
  const fields = String(raw ?? "").split("\0");
  const out: GitEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? "";
    if (field.length < 4) continue; // 至少 "XY <path>"(path ≥1 字符)
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (!path) continue;
    out.push({ status, path });
    const c = status[0] ?? "";
    if (c === "R" || c === "C") i++; // 跳过旧路径字段
  }
  return out;
}

async function statOf(full: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const st = await stat(full);
    if (!st.isFile()) return null;
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** 头部含 NUL 即判二进制(只读 4KB,不整读大文件)。 */
async function sniffBinary(full: string): Promise<boolean> {
  try {
    const fh = await open(full, "r");
    try {
      const buf = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
      return buf.subarray(0, bytesRead).includes(0);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

async function gitStatusOf(root: string): Promise<{ statRoot: string; entries: GitEntry[] } | null> {
  const top = await runGit(root, ["rev-parse", "--show-toplevel"]);
  if (top === null) return null;
  const statRoot = String(top ?? "").trim() || root;
  const raw = await runGit(statRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (raw === null) return null;
  return { statRoot, entries: parsePorcelainZ(raw) };
}

/** 逐条 stat(并发,串行会在大仓上拖到秒级)。 */
async function statAll(statRoot: string, entries: readonly GitEntry[]): Promise<Record<string, BaselineFile>> {
  const files: Record<string, BaselineFile> = {};
  const done = await Promise.all(entries.map(async (e) => ({ e, s: await statOf(join(statRoot, e.path)) })));
  for (const { e, s } of done) {
    if (!s) continue;
    files[e.path] = { status: e.status, mtimeMs: s.mtimeMs, size: s.size };
  }
  return files;
}

/**
 * 开工基线:异步 `git status --porcelain=v1 -z --untracked-files=all` + 每个 path 的 stat。
 * 非 git 根(git 缺失 / 非仓)→ mode=non-git,files 为空,不抛错。
 */
export async function captureBaseline(root: string): Promise<ChangeBaseline> {
  const st = await gitStatusOf(root);
  if (!st) return { mode: "non-git", statRoot: root, files: {} };
  return { mode: "git", statRoot: st.statRoot, files: await statAll(st.statRoot, st.entries) };
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 相对化:root 内的绝对路径 → posix 相对路径;仓外保持原样(留给 unknown 如实登记)。 */
function normalizePath(root: string, p: string): string {
  const raw = p.trim();
  if (!raw) return "";
  if (!isAbsolute(raw)) return raw.split(sep).join("/");
  const r = relative(root, raw);
  if (!r || r.startsWith("..")) return raw;
  return r.split(sep).join("/");
}

/** 本任务窗口内 write 类工具触碰过的路径(去重、保序)。 */
export function collectToolTouched(events: readonly LedgerEvent[], root: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const evs = [...events].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  for (const e of evs) {
    if (e.kind !== "tool.call") continue;
    const p = (e.payload && typeof e.payload === "object" ? e.payload : {}) as Record<string, unknown>;
    if (!WRITE_TOOLS.has(String(p.name ?? ""))) continue;
    const a = parseArgs(p.arguments);
    const path = typeof a.path === "string" ? normalizePath(root, a.path) : "";
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

export interface ComputeChangeLedgerInput {
  root: string;
  baseline: ChangeBaseline;
  /** 本任务窗口内的 journal 事件(调用方用 readSession(sid, taskStartSeq) 切片)。 */
  endEvents: readonly LedgerEvent[];
  oversizedBytes?: number;
}

function entryOf(path: string, status: string, size: number, binary: boolean, limit: number): ChangeEntry {
  return { path, status, size, oversized: binary || size > limit };
}

function emptyLedger(mode: ChangeMode, baselineCount: number, unknown: UnknownEntry[]): ChangeLedger {
  return {
    mode, baselineCount, changed: [], unknown: unknown.slice(0, MAX_UNKNOWN), oversized: [],
    truncated: { changed: false, unknown: unknown.length > MAX_UNKNOWN, changedTotal: 0, unknownTotal: unknown.length },
  };
}

/**
 * 末态对比出账本。git 模式再跑一次 status;非 git 模式用工具触碰 + mtime 变化。
 * 不向上抛错(git/stat 异常都归入 unknown 或空清单),收尾路径不会被账本打断。
 */
export async function computeChangeLedger(input: ComputeChangeLedgerInput): Promise<ChangeLedger> {
  const { root, baseline, endEvents } = input;
  const limit = typeof input.oversizedBytes === "number" && input.oversizedBytes > 0
    ? input.oversizedBytes
    : DEFAULT_OVERSIZED_BYTES;
  const scanRoot = baseline.mode === "git" ? baseline.statRoot || root : root;
  const touched = collectToolTouched(endEvents, scanRoot);
  const unknown: UnknownEntry[] = [];
  const changedAll: ChangeEntry[] = [];
  const baselineCount = Object.keys(baseline.files).length;

  if (baseline.mode === "non-git") {
    for (const path of touched) {
      const full = isAbsolute(path) ? path : join(root, path);
      const s = await statOf(full);
      if (!s) {
        unknown.push({ path, reason: "非 git 根:stat 失败(路径不存在或不可读)" });
        continue;
      }
      const base = baseline.files[path];
      // 非 git 模式基线为空:触碰且存在即算变更(无 git 无从判定内容是否真变)。
      const isNew = !base || base.mtimeMs !== s.mtimeMs || base.size !== s.size;
      if (!isNew) continue;
      changedAll.push(entryOf(path, base ? "modified" : "exists", s.size, await sniffBinary(full), limit));
    }
  } else {
    const st = await gitStatusOf(baseline.statRoot || root);
    if (!st) {
      // 基线在 git 上、末态读不到仓(被删/权限):如实 unknown,不判「未改」。
      for (const path of touched) unknown.push({ path, reason: "末态 git status 失败" });
      return emptyLedger("git", baselineCount, unknown);
    }
    const endStats = await statAll(st.statRoot, st.entries);
    for (const [path, f] of Object.entries(endStats)) {
      const base = baseline.files[path];
      const isNew = !base;
      const statusChanged = base ? base.status !== f.status : false;
      const statChanged = base ? base.mtimeMs !== f.mtimeMs || base.size !== f.size : false;
      if (!isNew && !statusChanged && !statChanged) continue;
      const binary = f.size > 0 ? await sniffBinary(join(st.statRoot, path)) : false;
      changedAll.push(entryOf(path, f.status, f.size, binary, limit));
    }
    for (const path of touched) {
      if (endStats[path]) continue;
      const full = isAbsolute(path) ? path : join(st.statRoot, path);
      const s = await statOf(full);
      unknown.push({
        path,
        reason: s ? "git 不可见(被忽略或仓外路径)" : "stat 失败(路径不存在或不可读)",
      });
    }
  }

  const changed = changedAll.slice(0, MAX_CHANGED);
  const oversized = changedAll.filter((c) => c.oversized).map((c) => ({ path: c.path, size: c.size }));
  return {
    mode: baseline.mode,
    baselineCount,
    changed,
    unknown: unknown.slice(0, MAX_UNKNOWN),
    oversized, // 单列且不省略:人工需要逐个看
    truncated: {
      changed: changedAll.length > MAX_CHANGED,
      unknown: unknown.length > MAX_UNKNOWN,
      changedTotal: changedAll.length,
      unknownTotal: unknown.length,
    },
  };
}
