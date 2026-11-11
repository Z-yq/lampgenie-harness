/**
 * 会话时间旅行:纯逻辑层(零 IO、确定性、不 throw)。
 * 为什么快照必须在工具执行前:
 * - 回滚的目标是「这一步动手之前的世界」。如果先执行 write_file/edit_file 再拍,拍到的已经是
 * 改后的内容,revert 无从恢复;删除同理(删完再拍只能拍到「不存在」)。
 * - 快照只覆盖本步工具**将要触碰**的文件(不是整棵树):成本与面都可控,也不会把 git 忽略的
 * 临时产物卷进恢复面。
 * - 这里只做路径归一/上限/分类等纯计算;读盘、sha、落盘全部由 gateway 侧 store 完成
 * (runtime 层零 fs 依赖,单测可完全确定性跑)。
 */

import path from "node:path";

/** 单个待快照文件(路径为相对 root 的 posix 形式)。 */
export interface SnapshotFile {
  path: string;
 /** 快照时该文件是否存在(store 读盘后回填真实值;计划阶段占位 true=候选)。 */
  existed: boolean;
 /** 内容 sha256(仅 existed=true 且有内容时由 store 回填)。 */
  sha?: string;
 /** 字节数(store 读盘后回填)。 */
  size?: number;
 /** 是否按二进制扩展名判定为二进制(允许快照,只是标记)。 */
  binary?: boolean;
}

export interface SnapshotSkip {
  path: string;
  reason: string;
}

export interface SnapshotPlanResult {
  ok: boolean;
  files: SnapshotFile[];
  skipped: SnapshotSkip[];
}

export interface SnapshotPlanOptions {
  paths: string[];
  root: string;
 /** 最多快照文件数(缺省 50)。 */
  maxFiles?: number;
 /** 单文件字节上限(缺省 2 MiB;需要 sizes 才能判定,无 sizes 时由 store 兜底)。 */
  maxFileBytes?: number;
 /** 总字节上限(缺省 20 MiB;同上)。 */
  maxTotalBytes?: number;
 /** 可选:调用方预先 stat 出的相对路径→字节数(纯函数据此判定上限)。 */
  sizes?: Record<string, number>;
}

export const SNAPSHOT_MAX_FILES = 50;
export const SNAPSHOT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SNAPSHOT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** 常见二进制扩展名:允许快照但打 binary 标记(恢复时按字节写回,不做文本处理)。 */
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svgz",
  ".pdf", ".zip", ".gz", ".tgz", ".tar", ".7z", ".rar", ".jar", ".war",
  ".exe", ".dll", ".so", ".dylib", ".node", ".wasm", ".class", ".bin",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".mov", ".avi",
  ".sqlite", ".db", ".pyc",
]);

/** 路径归一:绝对/相对都接受;越出 root 或指向 root 自身 → null。 */
export function normalizeSnapshotPath(root: string, raw: unknown): { rel: string; abs: string } | null {
  if (typeof root !== "string" || !root.trim()) return null;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.includes("\0")) return null;
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, text);
  if (abs === rootAbs) return null;
  if (!abs.startsWith(rootAbs + path.sep)) return null;
  const rel = path.relative(rootAbs, abs).split(path.sep).join("/");
  if (!rel || rel.startsWith("../") || rel === "..") return null;
  return { rel, abs };
}

function isBinaryPath(rel: string): boolean {
  return BINARY_EXTS.has(path.extname(rel).toLowerCase());
}

/**
 * 计划一次快照:归一/去重/数量与字节上限/二进制分类。
 * 纯函数——sizes 不传就只做路径与数量判定(字节上限留给 store 读盘后兜底)。
 */
export function snapshotPlan(opts: SnapshotPlanOptions): SnapshotPlanResult {
  const out: SnapshotPlanResult = { ok: true, files: [], skipped: [] };
  try {
    if (!opts || !Array.isArray(opts.paths)) return out;
    const root = opts.root;
    const maxFiles = positiveInt(opts.maxFiles, SNAPSHOT_MAX_FILES);
    const maxFileBytes = positiveInt(opts.maxFileBytes, SNAPSHOT_MAX_FILE_BYTES);
    const maxTotalBytes = positiveInt(opts.maxTotalBytes, SNAPSHOT_MAX_TOTAL_BYTES);
    const sizes = opts.sizes && typeof opts.sizes === "object" ? opts.sizes : undefined;
    const seen = new Set<string>();
    let total = 0;
    for (const raw of opts.paths) {
      const norm = normalizeSnapshotPath(root, raw);
      if (!norm) {
        out.skipped.push({ path: String(raw ?? "").slice(0, 300), reason: "outside-root" });
        continue;
      }
      if (seen.has(norm.rel)) continue; // 去重不记为 skip(调用方可能重复传同一文件)
      if (out.files.length >= maxFiles) {
        out.skipped.push({ path: norm.rel, reason: "max-files" });
        continue;
      }
      const size = sizes ? sizes[norm.rel] : undefined;
      if (typeof size === "number" && Number.isFinite(size)) {
        if (size > maxFileBytes) {
          out.skipped.push({ path: norm.rel, reason: "too-large" });
          continue;
        }
        if (total + size > maxTotalBytes) {
          out.skipped.push({ path: norm.rel, reason: "total-budget" });
          continue;
        }
        total += size;
      }
      seen.add(norm.rel);
      out.files.push({
        path: norm.rel,
        existed: true, // 占位:store 读盘后回填真实存在性
        binary: isBinaryPath(norm.rel) || undefined,
        ...(typeof size === "number" && Number.isFinite(size) ? { size } : {}),
      });
    }
    return out;
  } catch {
    return { ok: false, files: [], skipped: [] };
  }
}

function positiveInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/** 事件最小面(与 core JournalEvent 结构兼容;此处独立声明避免 runtime 纯逻辑层耦合)。 */
export interface TimeTravelEvent {
  seq: number;
  kind: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
  time?: number;
}

export interface StepBoundary {
  turn: number;
  step: number;
 /** step.start 事件的 seq。 */
  seq: number;
 /** 该步之后首条 message.agent 的 seq(边界「可用快照」的锚)。 */
  assistantSeq: number;
}

const STEP_ID_RE = /^t(\d+)s(\d+)$/;

/**
 * 找 stepId(形如 t2s5)对应的边界:该步 step.start + 之后首条 message.agent。
 * 不传 stepId = 取该会话最后一个「有 assistant 消息跟随」的 step.start。
 * 找不到任一端 → null。
 */
export function boundaryOfStep(
  events: TimeTravelEvent[] | undefined,
  sessionId: string,
  opts?: { stepId?: string },
): StepBoundary | null {
  try {
    if (!Array.isArray(events) || typeof sessionId !== "string") return null;
    const own = events.filter((e) => e && e.sessionId === sessionId);
    if (own.length === 0) return null;
    const parsed = typeof opts?.stepId === "string" ? STEP_ID_RE.exec(opts.stepId.trim()) : null;
 // 显式给了 stepId 但格式不是 t<turn>s<step> → 判非法(不要静默退回「最近边界」)
    if (typeof opts?.stepId === "string" && !parsed) return null;
    const wantTurn = parsed ? Number(parsed[1]) : undefined;
    const wantStep = parsed ? Number(parsed[2]) : undefined;
    let anchor = -1;
    if (wantTurn !== undefined && wantStep !== undefined) {
      anchor = own.findIndex((e) => e.kind === "step.start"
        && Number((e.payload ?? {}).turn) === wantTurn
        && Number((e.payload ?? {}).step) === wantStep);
    } else {
 // 无 stepId:从后往前找最后一个有 message.agent 跟随的 step.start(最近的可用边界)
      for (let i = own.length - 1; i >= 0; i--) {
        if (own[i]!.kind !== "step.start") continue;
        if (own.slice(i + 1).some((e) => e.kind === "message.agent")) { anchor = i; break; }
      }
    }
    if (anchor < 0) return null;
    const start = own[anchor]!;
    const agent = own.slice(anchor + 1).find((e) => e.kind === "message.agent");
    if (!agent) return null;
    const p = start.payload ?? {};
    const turn = Number(p.turn);
    const step = Number(p.step);
    if (!Number.isFinite(turn) || !Number.isFinite(step)) return null;
    return { turn, step, seq: start.seq, assistantSeq: agent.seq };
  } catch {
    return null;
  }
}

export interface RewindPlan {
 /** existed=true 且有 blob 的文件 → 从快照写回。 */
  restore: SnapshotFile[];
 /** existed=false 且当前存在 → 删除(回滚期间新建的文件)。 */
  delete: string[];
 /** existed=true 但缺 blob 的文件(不写,报告给调用方)。 */
  missingBlobs: string[];
}

/**
 * 回滚计划:existed=true → restore(缺 sha 归 missing);existed=false → 当前存在才 delete。
 * dirExists 缺省按「存在」处理(调用方通常传 fs 探测结果)。
 */
export function rewindPlan(input: {
  snapshot: { files?: SnapshotFile[] } | SnapshotFile[] | null | undefined;
  boundary?: StepBoundary | null;
  dirExists?: (path: string) => boolean;
}): RewindPlan {
  const out: RewindPlan = { restore: [], delete: [], missingBlobs: [] };
  try {
    const snap = input?.snapshot;
    const files = Array.isArray(snap) ? snap : (Array.isArray(snap?.files) ? snap.files : []);
    const dirExists = typeof input?.dirExists === "function" ? input.dirExists : () => true;
    for (const f of files) {
      if (!f || typeof f.path !== "string" || !f.path) continue;
      if (f.existed) {
        if (typeof f.sha === "string" && f.sha.trim()) out.restore.push(f);
        else out.missingBlobs.push(f.path);
      } else {
        let exists = true;
        try { exists = !!dirExists(f.path); } catch { exists = true; }
        if (exists) out.delete.push(f.path);
      }
    }
    return out;
  } catch {
    return out;
  }
}

export interface CompactionRemap {
 /** 保留段内的 compact.done seq(压缩边界本身属于历史,边界前保留)。 */
  keptCompactSeqs: number[];
 /** 被截断的压缩边界所携带 tail 消息数(这部分随边界一起丢弃)。 */
  droppedTailMessages: number;
}

export interface ForkPlanResult {
  events: TimeTravelEvent[];
  dropped: number;
  compactionRemap: CompactionRemap;
}

/**
 * fork 计划:只保留 sessionId 下 seq<=atSeq 的事件。
 * - compact.done 若 seq>atSeq 丢弃;其 payload.tail(压缩边界的最近尾消息)一并丢弃并计数。
 * - 保留段内的 compact.done 记录 seq,供调用方重建压缩水位。
 */
export function forkPlan(
  events: TimeTravelEvent[] | undefined,
  sessionId: string,
  opts: { atSeq: number },
): ForkPlanResult {
  const empty: ForkPlanResult = { events: [], dropped: 0, compactionRemap: { keptCompactSeqs: [], droppedTailMessages: 0 } };
  try {
    if (!Array.isArray(events) || typeof sessionId !== "string") return empty;
    const at = Number(opts?.atSeq);
    const cut = Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
    const own = events.filter((e) => e && e.sessionId === sessionId);
    const kept: TimeTravelEvent[] = [];
    const keptCompactSeqs: number[] = [];
    let dropped = 0;
    let droppedTailMessages = 0;
    for (const e of own) {
      if (e.seq <= cut) {
        kept.push(e); // 不改原对象(不可变)
        if (e.kind === "compact.done") keptCompactSeqs.push(e.seq);
      } else {
        dropped++;
        if (e.kind === "compact.done") {
          const tail = (e.payload ?? {}).tail;
          if (Array.isArray(tail)) droppedTailMessages += tail.length;
        }
      }
    }
    return { events: kept, dropped, compactionRemap: { keptCompactSeqs, droppedTailMessages } };
  } catch {
    return empty;
  }
}

/**
 * 受「只删对话」影响的会话事件 kind(消息类)。
 * 为什么只圈这几类:truncate 的语义是「boundary 之后的**对话**作废」,turn.start/step.start/
 * custom 等观测与审计事件不属于对话面——把它们一起丢会让面板/统计/边界解析出现空洞,
 * 而且 deriveMessages 只是消费方之一(journal 本身不可变)。
 */
export const TRUNCATABLE_MESSAGE_KINDS: ReadonlySet<string> = new Set([
  "message.user",
  "message.agent",
  "message.system",
  "tool.call",
  "tool.result",
  "compact.done",
]);

export type TruncatePlanCode = "OK" | "NO_BOUNDARY" | "INVALID";

export interface TruncatePlanResult {
  ok: boolean;
  boundarySeq: number;
 /** 截断事件自身 seq(必须 > boundarySeq;调用方据此落 custom 事件)。 */
  truncateSeq?: number;
  code: TruncatePlanCode;
}

/**
 * 「只删对话」计划(纯函数、确定性、不 throw)。
 * 判定顺序(先合法性、再是否有事可做):
 * 1) boundarySeq 必须有限、正整数,且不超过事件流最大 seq(空流时任何正 boundary 都超界)→ INVALID。
 * 2) lastMsgSeq = 全流消息类事件的最大 seq(不限 session:seq 全局单调,边界跨会话也安全)。
 * 无消息类事件,或 boundarySeq >= lastMsgSeq → NO_BOUNDARY(没有更晚的对话需要删,无需截断)。
 * 3) 否则 OK,truncateSeq = 全流最大 seq(落盘后该事件成为区间右端点 T)。
 * 为什么右端点取「全流最大 seq」而不是 boundary:区间 (boundary, T) 要覆盖到当前末条消息;
 * 调用方 append 时 T 由 journal 分配(必然更大),区间尾部再没有旧消息,语义闭合。
 */
export function truncatePlan(
  events: TimeTravelEvent[] | undefined,
  opts: { boundarySeq: number },
): TruncatePlanResult {
  const boundarySeq = Number(opts?.boundarySeq);
  try {
    if (!Array.isArray(events)) return { ok: false, boundarySeq, code: "INVALID" };
    if (!Number.isFinite(boundarySeq) || boundarySeq <= 0 || !Number.isInteger(boundarySeq)) {
      return { ok: false, boundarySeq, code: "INVALID" };
    }
    let maxSeq = 0;
    let lastMsgSeq = 0;
    for (const e of events) {
      if (!e || typeof e !== "object") continue;
      const seq = Number(e.seq);
      if (!Number.isFinite(seq)) continue;
      if (seq > maxSeq) maxSeq = seq;
      if (TRUNCATABLE_MESSAGE_KINDS.has(e.kind) && seq > lastMsgSeq) lastMsgSeq = seq;
    }
    if (boundarySeq > maxSeq) return { ok: false, boundarySeq, code: "INVALID" };
    if (lastMsgSeq === 0 || boundarySeq >= lastMsgSeq) return { ok: false, boundarySeq, code: "NO_BOUNDARY" };
    return { ok: true, boundarySeq, truncateSeq: maxSeq, code: "OK" };
  } catch {
    return { ok: false, boundarySeq: Number.isFinite(boundarySeq) ? boundarySeq : 0, code: "INVALID" };
  }
}

export type RewindGuardCode = "OK" | "BACKGROUND_BUSY";

/** 回滚守卫:后台子代理/工作流没收敛时拒绝(回滚会与它们正在写的文件打架)。 */
export function rewindGuard(input: { activeSubagents?: number; workflowRunning?: boolean } | null | undefined): {
  ok: boolean;
  code: RewindGuardCode;
} {
  const n = Number(input?.activeSubagents ?? 0);
  const busy = (Number.isFinite(n) && n > 0) || input?.workflowRunning === true;
  return busy ? { ok: false, code: "BACKGROUND_BUSY" } : { ok: true, code: "OK" };
}
