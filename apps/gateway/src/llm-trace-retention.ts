/**
 * llm-trace 保留策略(轨迹追踪 P1-A,; 增钉扎)。
 * 背景:`llm-trace.ts` 每次 chat 落一个文件,内含**全量 request.messages**(会话越长越肥,
 * O(steps²) 近重复);此前全仓无任何清理/轮转 → .genie/llm-trace 无界增长。
 * 两级保留:
 *  ① 每 session 目录最近 **N=200** 份(env `GENIE_LLM_TRACE_KEEP_PER_SESSION`,按文件名里的
 * epochMs 倒序——llm-trace 文件名 `call-<seq>-<turn>s<step>-<ms>.json`,ms 即写盘时刻);
 *  ② 全树总量上限 **512MB**(env `GENIE_LLM_TRACE_MAX_BYTES`),超限从**最老的**文件开始删,
 *     直到回落到上限的 90%(留头部空间,避免每次写盘都触发一轮删除)。
 *  增补:两级保留只管「空间」,不管「价值」。可选 `shouldPin` 判定的文件(pin)——
 * RSI 夜间挖掘窗口内的轨迹、被证据图谱(EvidenceSource.sessionId)引用的轨迹——**永不删除**:
 * 既不参与份数淘汰,也不参与总量淘汰;即使 pinned 自己就超上限,也只通过 `onPinStats` 回调
 * 告警给上层,不改变「不删」的决定。不传 `shouldPin` 时行为与旧实现逐字一致(返回结构不新增键)。
 * 纪律(与 llm-trace.ts 头注释记录的 196s 冻结事故直接相关):
 * - **全异步**(fs.promises)且旁路:清理是优化,不是主链——任何异常静默吞掉,绝不让
 *   LLM 调用失败、绝不同步阻塞事件循环(9p 上 writeFileSync 大文件曾把 worker 冻 196s)。
 * - **绝不删当前正在写的那个文件**(opts.protectPath):写完前删掉=刚落的轨迹凭空消失。
 * - **绝不删 pin 的文件**:判定回调抛错时按「已 pin」处理(宁可不删,不静默删掉可能被引用的现场)。
 * - 同一进程内串行化(pruning 标志):节流已限制频率,再加一道「上一轮没跑完就跳过」。
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";

/** pin 判定回调:返回 pin=true 的文件永不删除(可带原因,用于上层日志/统计)。 */
export type ShouldPinFn = (f: { path: string; sessionId: string; epoch: number }) => { pin: boolean; reason?: string };

/** 钉扎统计:migrated 由调用方(迁移方)填写,retention 自身恒给 0。 */
export interface PinStats {
  pinned: number;
  dropped: number;
  migrated: number;
 /** pinned 文件自身字节数已超总量上限(仍不删,只告警)。 */
  pinnedOverBudget?: boolean;
}

export interface PruneLlmTraceOptions {
  /** 每 session 目录保留份数(缺省 env GENIE_LLM_TRACE_KEEP_PER_SESSION / 200)。 */
  keepPerSession?: number;
  /** 全树字节上限(缺省 env GENIE_LLM_TRACE_MAX_BYTES / 512MB)。 */
  maxBytes?: number;
  /** 超限后回落目标比例(缺省 0.9:删到上限的 90%,留余量)。 */
  targetRatio?: number;
  /** 保护路径:当前正在写的文件,永不删除。 */
  protectPath?: string;
 /** 钉扎判定(证据引用 / 挖掘窗口):为真的文件永不删除。不传=旧行为。 */
  shouldPin?: ShouldPinFn;
 /** 钉扎统计回调(旁路:回调抛错静默,不影响清理)。 */
  onPinStats?: (s: PinStats) => void;
}

export interface PruneLlmTraceResult {
  removed: number;
  kept: number;
 /** 钉扎数;仅在传了 shouldPin 时出现(不传时返回结构与旧实现逐字一致)。 */
  pinned?: number;
}

export const DEFAULT_KEEP_PER_SESSION = 200;
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_TARGET_RATIO = 0.9;

/** 轨迹文件名(调用方迁移/枚举复用同一口径,避免两处正则漂移)。 */
export const TRACE_FILE_RE = /^call-.*-(\d+)\.json$/;

/** 从文件名取 epochMs(取不到回退 mtime;都取不到=0,视为最老)。 */
function epochOf(name: string, mtimeMs: number): number {
  const m = TRACE_FILE_RE.exec(name);
  const fromName = m ? Number(m[1]) : NaN;
  return Number.isFinite(fromName) && fromName > 0 ? fromName : mtimeMs;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env?.[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

interface TraceFile {
  path: string;
  epoch: number;
  size: number;
}

/** 钉扎判定包装:回调抛错 → 保守视为 pin(清理是旁路,不因判定失败而删掉可能被引用的现场)。 */
function pinOf(shouldPin: ShouldPinFn | undefined, sessionId: string, f: TraceFile): boolean {
  if (!shouldPin) return false;
  try {
    return shouldPin({ path: f.path, sessionId, epoch: f.epoch }).pin === true;
  } catch {
    return true;
  }
}

/**
 * 删除超限轨迹文件。返回 { removed, kept[, pinned] }:
 * - removed=本次删除的文件数;kept=清理后仍保留的文件数;pinned=钉扎数(仅传 shouldPin 时给)。
 * - 目录不存在/不可读/任何 fs 异常 → 静默返回已删计数(调用方靠 catch 兜底,绝不抛)。
 */
export async function pruneLlmTrace(dir: string, opts: PruneLlmTraceOptions = {}): Promise<PruneLlmTraceResult> {
  const keepPerSession = opts.keepPerSession ?? envInt("GENIE_LLM_TRACE_KEEP_PER_SESSION", DEFAULT_KEEP_PER_SESSION);
  const maxBytes = opts.maxBytes ?? envInt("GENIE_LLM_TRACE_MAX_BYTES", DEFAULT_MAX_BYTES);
  const targetRatio = opts.targetRatio ?? DEFAULT_TARGET_RATIO;
  const protect = opts.protectPath;
  const shouldPin = opts.shouldPin;

  let removed = 0;
  const survivors: TraceFile[] = [];
  const protectedOnes: TraceFile[] = [];
  const pinnedPaths = new Set<string>();
  let pinnedCount = 0;

  let dirs: string[] = [];
  try {
    dirs = await fsp.readdir(dir);
  } catch {
    /* 轨迹清理是旁路优化:目录不存在/权限不足/正在被删——静默返回,任何异常不得打断主链 */
    return { removed: 0, kept: 0, ...(shouldPin ? { pinned: 0 } : {}) };
  }

  for (const name of dirs) {
    const sessionDir = join(dir, name);
    let files: string[] = [];
    try {
      files = await fsp.readdir(sessionDir);
    } catch {
      /* 不是目录/读不动:跳过本项,继续清其余 session(旁路,不抛) */
      continue;
    }
    const entries: TraceFile[] = [];
    for (const f of files) {
      if (!TRACE_FILE_RE.test(f)) continue;
      const p = join(sessionDir, f);
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = await fsp.stat(p);
        if (!st.isFile()) continue;
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        continue; // 刚被别处删掉/统计失败:跳过(旁路)
      }
      entries.push({ path: p, epoch: epochOf(f, mtimeMs), size });
    }
 // 先分流:pin 的单独进 survivors(不占份数配额),其余按旧口径淘汰。
    const pinnedHere: TraceFile[] = [];
    const rest: TraceFile[] = [];
    for (const e of entries) {
      if (pinOf(shouldPin, name, e)) {
        pinnedHere.push(e);
        pinnedPaths.add(e.path);
      } else {
        rest.push(e);
      }
    }
    // ① 每 session 保留最近 N 份(epoch 倒序;同 epoch 按路径稳定排序保证幂等)
    rest.sort((a, b) => b.epoch - a.epoch || (a.path < b.path ? 1 : a.path > b.path ? -1 : 0));
    for (let i = 0; i < rest.length; i++) {
      const e = rest[i]!;
      if (i < keepPerSession || (protect && e.path === protect)) survivors.push(e);
      else if (await unlinkQuiet(e.path)) removed++;
    }
    for (const e of pinnedHere) {
      survivors.push(e);
      pinnedCount++;
    }
  }

  // ② 全树总量上限:超限从最老的开始删,直到回落至 maxBytes*targetRatio
  for (const e of survivors) protectedOnes.push(e);
  let total = survivors.reduce((s, e) => s + e.size, 0);
  const pinnedBytes = survivors.reduce((s, e) => s + (pinnedPaths.has(e.path) ? e.size : 0), 0);
  const pinnedOverBudget = pinnedBytes > maxBytes;
  const report = (): void => {
    if (!opts.onPinStats) return;
    try {
      opts.onPinStats({ pinned: pinnedCount, dropped: removed, migrated: 0, ...(pinnedOverBudget ? { pinnedOverBudget: true } : {}) });
    } catch {
 /* 统计回调也是旁路:上层回调出问题不得影响清理结果 */
    }
  };
  const withPinned = (result: { removed: number; kept: number }): PruneLlmTraceResult =>
    shouldPin ? { ...result, pinned: pinnedCount } : result;

  if (total > maxBytes) {
    const limit = Math.floor(maxBytes * targetRatio);
    const asc = [...survivors].sort((a, b) => a.epoch - b.epoch);
    const kept = new Set(survivors.map((e) => e.path));
    for (const e of asc) {
      if (total <= limit) break;
      if (protect && e.path === protect) continue; // 当前在写的文件永不删
      if (pinnedPaths.has(e.path)) continue; // 钉扎文件永不删(即使总量超限)
      if (await unlinkQuiet(e.path)) {
        kept.delete(e.path);
        total -= e.size;
        removed++;
      }
    }
    report();
    return withPinned({ removed, kept: kept.size });
  }
  report();
  return withPinned({ removed, kept: protectedOnes.length });
}

/** 删除单个文件;失败(不存在/占用/权限)静默 false——旁路纪律。 */
async function unlinkQuiet(path: string): Promise<boolean> {
  try {
    await fsp.unlink(path);
    return true;
  } catch {
    /* 轨迹清理是旁路优化:删不掉(占用/权限/已不存在)也不影响主链,不记日志不抛 */
    return false;
  }
}
