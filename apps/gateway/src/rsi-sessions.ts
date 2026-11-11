/**
 * RSI 会话候选池 + 已分析账本( RSI-SESSION-COST)。
 * 职责:回答「近 3 日里哪些会话还没被任何机制分析过」并给出候选名单,以及记录「某个机制运行
 * 到底分析了哪些会话」。数据同源:候选来自 journal 目录的**文件 mtime**(与 nightly 选会话同口径),
 * 已分析账本来自本模块 append 的 JSONL——不猜、不补、不按 0 假装。
 * 磁盘布局:
 * <journalDir>/sessions/<sid>.jsonl 会话事件文件(只读 mtime,不解析内容)
 * <root>/.genie/rsi/analyzed-sessions.jsonl 已分析账本(append-only,逐行 JSON)
 * 纪律:
 * - RSI 自身会话(id 固定 "rsi")永不进候选:它只装机制任务,分析自己没有意义。
 * - 候选上限 12(单次运行能真正读的会话数有界,避免一次派单把全会话拖进来)。
 * - journalDir 缺失 / 目录不可读 → 空候选(诚实降级,不 throw);坏行忽略(一行坏不整账本失效)。
 * - 账本按 sessionId 幂等:重复标记无害,读侧去重即可(append-only 不回溯改写历史)。
 */
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 分析窗口:近 3 日。 */
export const RSI_ANALYSIS_WINDOW_MS = 3 * 24 * 3600 * 1000;

/** 单次运行最多带多少个候选(有界,避免一次派单读几十个会话)。 */
export const RSI_ANALYSIS_MAX_CANDIDATES = 12;

/** RSI 自身固定会话 id(与 rsi-agent-runner 的 RSI_SESSION_ID 同值;本模块不 import 它,避免环)。 */
export const RSI_SELF_SESSION_ID = "rsi";

export interface RsiRecentSession {
  sessionId: string;
 /** 会话文件最后修改时刻(ms epoch)=「最后活动」。 */
  lastActiveAt: number;
}

/** 窗口内单个会话文件的可读状态(供 listRecentSessions 内部与诊断用)。 */
interface SessionFileInfo {
  sessionId: string;
  mtimeMs: number;
}

/**
 * 枚举 `<journalDir>/sessions/*.jsonl`,只留 mtime 落在 `[nowMs - windowMs, nowMs]` 的会话,
 * 按 mtime 降序(最新在前),并排除 RSI 自身会话。
 * 刻意不解析 jsonl 内容:mtime 就是「最后活动」的持久事实,解析 30MB 会话只为取时间戳不划算。
 */
export async function listRecentSessions(
  journalDir: string,
  nowMs: number,
  windowMs: number = RSI_ANALYSIS_WINDOW_MS): Promise<RsiRecentSession[]> {
  const dir = typeof journalDir === "string" ? journalDir.trim() : "";
  if (dir === "") return [];
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  const span = typeof windowMs === "number" && Number.isFinite(windowMs) && windowMs > 0 ? windowMs : RSI_ANALYSIS_WINDOW_MS;
  const from = now - span;

  const sessionsDir = join(dir, "sessions");
  let names: string[] = [];
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => entry.name);
  } catch {
    return [];
  }

  const out: SessionFileInfo[] = [];
  for (const name of names) {
    const sessionId = name.replace(/\.jsonl$/, "");
    if (sessionId === "" || sessionId === RSI_SELF_SESSION_ID) continue;
    let mtimeMs = 0;
    try {
      const info = await stat(join(sessionsDir, name));
      if (!info.isFile()) continue;
      mtimeMs = info.mtimeMs;
    } catch {
      continue;
    }
    if (!Number.isFinite(mtimeMs) || mtimeMs < from || mtimeMs > now) continue;
    out.push({ sessionId, mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId));
  return out.map((info) => ({ sessionId: info.sessionId, lastActiveAt: info.mtimeMs }));
}

/** 已分析账本路径:`<root>/.genie/rsi/analyzed-sessions.jsonl`。 */
export function analyzedSessionsPath(root: string): string {
  return join(root, ".genie", "rsi", "analyzed-sessions.jsonl");
}

export interface RsiAnalyzedEntry {
  sessionId: string;
  projectId?: string;
  mechanismId: string;
  runId: string;
  at: number;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 读已分析账本 → sessionId 集合(读侧去重:同 id 多行只算一次;坏行/缺字段行忽略)。
 * 文件不存在=空集合(第一次运行必然如此)。
 */
export async function loadAnalyzedIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>();
  if (typeof root !== "string" || root.trim() === "") return ids;
  let text = "";
  try {
    text = await readFile(analyzedSessionsPath(root), "utf8");
  } catch {
    return ids;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const sessionId = asString((parsed as { sessionId?: unknown }).sessionId);
    if (sessionId !== undefined) ids.add(sessionId);
  }
  return ids;
}

/**
 * 读已分析账本 → 明细(同 sessionId 取**最后**一条:最新的机制/运行具有解释权)。
 * 面板与诊断需要「谁在哪个 run 里分析的」时用这个;判「是否已分析过」用 loadAnalyzedIds。
 */
export async function loadAnalyzedEntries(root: string): Promise<RsiAnalyzedEntry[]> {
  if (typeof root !== "string" || root.trim() === "") return [];
  let text = "";
  try {
    text = await readFile(analyzedSessionsPath(root), "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, RsiAnalyzedEntry>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const rec = parsed as Record<string, unknown>;
    const sessionId = asString(rec.sessionId);
    if (sessionId === undefined) continue;
    const entry: RsiAnalyzedEntry = {
      sessionId,
      mechanismId: asString(rec.mechanismId) ?? "",
      runId: asString(rec.runId) ?? "",
      at: asNumber(rec.at) ?? 0,
    };
    const projectId = asString(rec.projectId);
    if (projectId !== undefined) entry.projectId = projectId;
    byId.set(sessionId, entry);
  }
  return [...byId.values()];
}

/**
 * 记账(append 写)。空数组不写、无 sessionId 的条目跳过——宁可少记一行也不写坏行。
 * 幂等口径:同 sessionId 重复标记不报错(读侧去重),append-only 不改历史。
 */
export async function markAnalyzed(root: string, entries: readonly RsiAnalyzedEntry[]): Promise<number> {
  if (typeof root !== "string" || root.trim() === "") return 0;
  const rows: string[] = [];
  for (const entry of entries ?? []) {
    const sessionId = asString(entry?.sessionId);
    if (sessionId === undefined) continue;
    const line: Record<string, unknown> = {
      sessionId,
      mechanismId: asString(entry.mechanismId) ?? "",
      runId: asString(entry.runId) ?? "",
      at: asNumber(entry.at) ?? Date.now(),
    };
    const projectId = asString(entry.projectId);
    if (projectId !== undefined) line.projectId = projectId;
    rows.push(JSON.stringify(line));
  }
  if (rows.length === 0) return 0;
  const file = analyzedSessionsPath(root);
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${rows.join("\n")}\n`, "utf8");
  } catch {
    return 0;
  }
  return rows.length;
}

export interface RsiAnalysisCandidate {
  sessionId: string;
 /** 归属项目(来自调用方 projectOf;取不到就不填,不编造)。 */
  projectId?: string;
  lastActiveAt: number;
}

export interface RsiAnalysisPlan {
  windowDays: number;
 /** 窗口内扫到的会话数(已排除 RSI 自身)。 */
  scanned: number;
 /** 其中已在账本里(被任一次运行分析过)的数量。 */
  alreadyAnalyzed: number;
 /** 本次候选(未分析过、按最后活动降序,上限 limit)。 */
  candidates: RsiAnalysisCandidate[];
}

export interface BuildAnalysisPlanOptions {
 /** journal 目录(网关级单一目录;缺省=空候选)。 */
  journalDir?: string;
 /** 仓库根(账本在 `<root>/.genie/rsi/`)。 */
  root: string;
  nowMs?: number;
  windowMs?: number;
  limit?: number;
 /** 会话→项目归属(server.ts 注入 sessionOwnerProjectId ?? sessionBindProjectId);缺省不填 projectId。 */
  projectOf?: (sessionId: string) => string | undefined;
}

/**
 * 组一次运行的候选计划:窗口内会话 − 已分析账本 = 候选(上限 limit)。
 * 纯读:不写账本、不改会话文件。任何一步失败都退化成空候选(诚实降级)。
 */
export async function buildAnalysisPlan(opts: BuildAnalysisPlanOptions): Promise<RsiAnalysisPlan> {
  const windowMs = typeof opts?.windowMs === "number" && opts.windowMs > 0 ? opts.windowMs : RSI_ANALYSIS_WINDOW_MS;
  const windowDays = Math.round(windowMs / (24 * 3600 * 1000));
  const limit = typeof opts?.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
    ? Math.floor(opts.limit)
    : RSI_ANALYSIS_MAX_CANDIDATES;
  const root = typeof opts?.root === "string" ? opts.root : "";
  const recent = await listRecentSessions(opts?.journalDir ?? "", opts?.nowMs ?? Date.now(), windowMs);
  let analyzed: Set<string>;
  try {
    analyzed = root === "" ? new Set<string>() : await loadAnalyzedIds(root);
  } catch {
    analyzed = new Set<string>();
  }
  const candidates: RsiAnalysisCandidate[] = [];
  let already = 0;
  for (const session of recent) {
    if (analyzed.has(session.sessionId)) {
      already += 1;
      continue;
    }
    if (candidates.length >= limit) break;
    const candidate: RsiAnalysisCandidate = { sessionId: session.sessionId, lastActiveAt: session.lastActiveAt };
    if (opts?.projectOf !== undefined) {
      let projectId: string | undefined;
      try {
        projectId = opts.projectOf(session.sessionId);
      } catch {
        projectId = undefined;
      }
      if (typeof projectId === "string" && projectId !== "") candidate.projectId = projectId;
    }
    candidates.push(candidate);
  }
  return { windowDays, scanned: recent.length, alreadyAnalyzed: already, candidates };
}
