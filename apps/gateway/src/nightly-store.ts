/**
 * 夜间离线整合 store(IO / 调度 / 流水线执行)。
 * 分层红线:
 * - 纯逻辑(幂等 / 预算 / 状态机 / 候选挖掘)一律调 `@lampgenie/runtime/agent/nightly-run`,
 *   本文件**不重复实现**,只做 IO、时钟、原子落盘与六步编排。
 * - 只读 journalDir(绝不写),只写 `<root>/.genie/rsi/nightly/**`。
 * - 除「参数错误 / run 不存在」外不 throw 到调用方:步骤执行异常会被转成 step failed +
 *   `NIGHTLY_FAILED`,让 run 可 retry。
 * 磁盘布局(全部在 root 下):
 *   .genie/rsi/nightly/<project>/<date>.json                  run 记录(一 run 一文件)
 *   .genie/rsi/nightly/<project>/<date>.selection.json        本轮选中的会话快照(增量边界)
 *   .genie/rsi/nightly/<project>/<date>.session-stats.json    pull-traces / denoise 产物
 *   .genie/rsi/nightly/<project>/<date>.evidence-pending.json update-graph 产物(待人工确认)
 *   .genie/rsi/nightly/queue.jsonl                            append-only 实验队列
 *   .genie/rsi/nightly/cursor.json                            { [projectId]: NightlyCursor }
 * 续跑语义:每步 markStep 后**立即**原子落盘(同目录 .tmp + rename),因此进程在任意两步之间
 * 被杀掉,下一次 runNightly 都能从 `nextStep` 接上。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { applyDecay } from "./evidence-graph-store.js";
import { collectWorkSessions, loadProjectRoots, logicalPathKey, refreshAtlasSnapshot, type AtlasReworkSummary } from "./atlas-harvest.js";
import { recordDelivery, recordFix } from "./cohort-metrics-store.js"; // F:cohort 同批采集器
import { detect } from "./pathology-store.js";
import { detectReworkChains, readReworkChains } from "./rework-chain.js"; // 返工因果链采集(设想灵魂)
import { getAtlas, ingestDefects } from "./direction-atlas-store.js"; // defectGenes 生产者(atlas 机制点名)
import { dirname, join } from "node:path";
import {
  NIGHTLY_CODES,
  addCandidates,
  addUnprocessed,
  buildRunReport,
  finalizeRun,
  markStep,
  mineCandidates,
  nextStep,
  pauseRun,
  recordCoverage,
  resumeRun,
  retryRun,
  runKey,
  shouldSkipCompleted,
  startRun,
} from "@lampgenie/runtime/agent/nightly-run";
import type {
  MineSessionStats,
  NightlyCandidate,
  NightlyCode,
  NightlyConfig,
  NightlyCursor,
  NightlyRun,
  NightlyStepName,
  NightlyUnprocessed,
} from "@lampgenie/runtime/agent/nightly-run";

/** 夜间数据根目录(相对 root)。 */
export const NIGHTLY_DIR = ".genie/rsi/nightly";

/** 单次 start 缺省最多处理会话数(只减量,不做全量历史回扫)。 */
const DEFAULT_MAX_SESSIONS = 200;

/** 计入 filesEdited 的工具名。 */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(["edit_file", "write_file", "multi_edit", "apply_patch"]);

/** journal 里「用户未答复」的文案标记(ask_user 超时的 result content 会带上它)。 */
const UNANSWERED_MARKER = "用户未答复";

const QUEUE_FILE = "queue.jsonl";
const CURSOR_FILE = "cursor.json";
const DONE_STEP_STATUSES: ReadonlySet<string> = new Set(["done", "skipped"]);

/** F:cohort 采集器判定「修复类会话」的标题词表(与 rework-chain 的分类口径对齐)。 */
const FIX_TITLE_RE = /(修复|回归|崩溃|报错|\bfix\b|bugfix)/i;

/** G:已消费候选的去重窗口(窗口内已消费的同 id 候选不再入队)。 */
const QUEUE_CONSUMED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** 返工链 defectClass → cohort 的缺陷类别(两套词表不同口径,映射在此显式列出,未知给 undefined)。 */
function cohortDefectClassOf(
  defectClass: string | undefined): "verification-coverage" | "impact-analysis" | "wrong-assumption" | undefined {
  switch (defectClass) {
    case "missing-test":
      return "verification-coverage";
    case "contract":
    case "concurrency":
      return "impact-analysis";
    case "boundary":
      return "wrong-assumption";
    default:
      return undefined;
  }
}

/** queue.jsonl 的单行形状(append-only,每行一个 JSON)。 */
export interface NightlyQueueLine {
  queuedAt: string;
  runId: string;
  projectId: string;
  date: string;
  candidate: NightlyCandidate;
 /** G:该候选被机制运行消费的时刻(ISO);缺省=未消费。 */
  consumedAt?: string;
 /** 消费方标识(机制 runId / 子代理名)。 */
  consumedBy?: string;
}

/** 单个会话的统计(pull-traces 产物,也是 mine 的输入)。 */
export interface NightlySessionStats {
  sessionId: string;
  eventsRead: number;
  eventsSkipped: number;
 /** 同 (sessionId,seq) 的重复行数(journal 双写残留会污染 eventsRead/工具计数)。 */
  dedupRows?: number;
  tools: Record<string, number>;
  repeatedReads: number;
  unresolvedAsks: number;
  failedSteps: number;
  filesEdited: number;
  fanoutEdges: number;
}

/** `<date>.session-stats.json` 的文件形状。 */
export interface NightlySessionStatsFile {
  generatedAt: string;
  runId: string;
  projectId: string;
  date: string;
  sessions: NightlySessionStats[];
  /** denoise 剔除的噪声会话 id(probe / smoke)。 */
  skipped?: string[];
  /** denoise 判为无内容、需人工补录的会话。 */
  unprocessed?: NightlyUnprocessed[];
}

/** 选中会话的一条快照(用文件名兜底 sessionId)。 */
export interface NightlySelectionEntry {
  sessionId: string;
  file: string;
  mtimeMs: number;
}

/**
 * 夜间证据衰减缺省策略(findings「全图零 decay」——
 * update-graph 之后跑一次 applyDecay 并落 decay 行;schema 早就有,只是流水线没接)。
 */
export const NIGHTLY_DECAY_POLICY = { halfLifeDays: 30, staleBelow: 0.5 } as const;

/** `<date>.selection.json` 的文件形状:选中集合是 run 落盘时的快照,后续步骤只读它。 */
export interface NightlySelectionFile {
  runId: string;
  projectId: string;
  date: string;
  selectedAt: string;
  sessions: NightlySelectionEntry[];
  lastSessionId?: string;
  lastMtimeMs?: number;
 /** 窗口内符合增量条件但被 maxSessions 截断、本轮未读的会话(覆盖口径:诚实入账)。 */
  unselected?: NightlySelectionEntry[];
}

/** `<date>.evidence-pending.json` 的文件形状:只落盘待审候选,不碰任何既有图谱/账本。 */
export interface NightlyEvidencePendingFile {
  generatedAt: string;
  runId: string;
  status: "pending-review";
  note: string;
  candidates: NightlyCandidate[];
}

export interface NightlyPaths {
  base: string;
  projectDir: string;
  runFile: string;
  selectionFile: string;
  statsFile: string;
  evidenceFile: string;
  queueFile: string;
  cursorFile: string;
}

export interface StartNightlyOptions {
  date: string;
  projectId: string;
  journalDir: string;
  /** 夜间窗口内仍有人用:默认不抢资源(不产生 run 文件)。 */
  onlineBusy?: boolean;
  maxSessions?: number;
  config?: NightlyConfig;
  /** epoch ms。 */
  now?: number;
}

export interface StartNightlyResult {
  run: NightlyRun | null;
  codes: NightlyCode[];
}

export interface RunNightlyOptions {
  /** 既有 runId;或直接给 { projectId|project, date }。 */
  runId: string | { projectId?: string; project?: string; date: string };
  journalDir: string;
  maxSessions?: number;
  /** epoch ms(每步在此基础上 +1 递增,便于审计)。 */
  now?: number;
}

export interface RunNightlyResult {
  run: NightlyRun;
  codes: NightlyCode[];
}

export interface RunQuery {
  projectId: string;
  date: string;
}

export interface PauseNightlyOptions extends RunQuery {
  reason?: string;
  now?: number;
}

export interface ResumeNightlyOptions extends RunQuery {
  journalDir: string;
  maxSessions?: number;
  now?: number;
}

export interface FinalizeNightlyOptions extends RunQuery {
  now?: number;
}

export interface NightlyReportOptions {
  projectId?: string;
  date?: string;
}

/** 三个产物路径常量(exports 给 CLI 直用)。 */
export function nightlyPaths(root: string, projectId: string, date: string): NightlyPaths {
  const base = join(root, NIGHTLY_DIR);
  const projectDir = join(base, projectId);
  return {
    base,
    projectDir,
    runFile: join(projectDir, `${date}.json`),
    selectionFile: join(projectDir, `${date}.selection.json`),
    statsFile: join(projectDir, `${date}.session-stats.json`),
    evidenceFile: join(projectDir, `${date}.evidence-pending.json`),
    queueFile: join(base, QUEUE_FILE),
    cursorFile: join(base, CURSOR_FILE),
  };
}

/** artifactRef 用 root 相对路径,便于报告里直接回链(不依赖 cwd)。 */
function artifactRef(projectId: string, date: string, suffix: string): string {
  return `${NIGHTLY_DIR}/${projectId}/${date}${suffix}`;
}

function iso(ms: number): string {
  return new Date(Number.isFinite(ms) ? Math.trunc(ms) : 0).toISOString();
}

function normaliseLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** 原子写:同目录 .tmp 全量写完后 rename,读者永远看不到半截 JSON。 */
function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

type CursorFile = Record<string, NightlyCursor>;

function readCursorFile(file: string): CursorFile {
  const parsed = readJson<CursorFile>(file);
  return parsed && typeof parsed === "object" ? { ...parsed } : {};
}

/** 枚举 `journalDir/sessions/*.jsonl`(不看 sessions-archive),按 mtime 升序。 */
function enumerateSessions(journalDir: string): NightlySelectionEntry[] {
  const dir = join(journalDir, "sessions");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: NightlySelectionEntry[] = [];
  for (const name of names) {
    const full = join(dir, name);
    let mtimeMs = 0;
    try {
      const info = statSync(full);
      if (!info.isFile()) continue;
      mtimeMs = info.mtimeMs;
    } catch {
      continue;
    }
    out.push({ sessionId: name.replace(/\.jsonl$/, ""), file: name, mtimeMs });
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs || a.sessionId.localeCompare(b.sessionId));
  return out;
}

function lastEntry(entries: readonly NightlySelectionEntry[]): NightlySelectionEntry | undefined {
  let best: NightlySelectionEntry | undefined;
  for (const entry of entries) {
    if (!best || entry.mtimeMs >= best.mtimeMs) best = entry;
  }
  return best;
}

interface CallRecord {
  name: string;
  answered: boolean;
  unansweredMarker: boolean;
}

/**
 * 解析一个 session 的 jsonl,产出统计。
 * 坏行(JSON.parse 失败)只计 eventsSkipped,绝不抛。
 */
export function parseSessionFile(filePath: string, sessionId: string): NightlySessionStats {
  const tools: Record<string, number> = {};
  const groups = new Map<string, number>();
  const calls: CallRecord[] = [];
  const callIndex = new Map<string, number>();
  let eventsRead = 0;
  let eventsSkipped = 0;
  let dedupRows = 0;
  const seenSeq = new Set<number>();
  let filesEdited = 0;
  let fanoutEdges = 0;
  let directFailures = 0;

  let raw = "";
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    raw = "";
  }

  const register = (id: unknown, name: unknown, args: unknown): void => {
    const toolName = asString(name);
    if (toolName === "") return;
    const callId = asString(id);
 // nightly 机制注意:同一调用会以 tool.call 与 message.agent.toolCalls 两种事件
 // 各出现一次;重复登记会让前一条 calls 永远 unanswered → failedSteps 虚高成工具调用总数,
 // tools/重复读/filesEdited/fanout 也被双计。同 callId 只认第一次出现。
    if (callId !== "" && callIndex.has(callId)) return;
    tools[toolName] = (tools[toolName] ?? 0) + 1;
    const argsKey = typeof args === "string" ? args : JSON.stringify(args ?? "");
    const groupKey = `${toolName}\u0000${argsKey}`;
    groups.set(groupKey, (groups.get(groupKey) ?? 0) + 1);
    if (EDIT_TOOL_NAMES.has(toolName)) filesEdited += 1;
    if (toolName === "spawn_subagent") fanoutEdges += 1;
    calls.push({ name: toolName, answered: false, unansweredMarker: false });
    if (callId !== "") callIndex.set(callId, calls.length - 1);
  };

  const resolve = (id: unknown, content: unknown): void => {
    const index = callIndex.get(asString(id));
    if (index === undefined) return;
    const call = calls[index];
    if (!call) return;
    call.answered = true;
    if (typeof content === "string" && content.includes(UNANSWERED_MARKER)) call.unansweredMarker = true;
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      eventsSkipped += 1;
      continue;
    }
    const event = asRecord(parsed);
    if (!event) { eventsRead += 1; continue; }
 // 同 seq 只计一次(经验证:super.jsonl 403 行仅 343 个 distinct seq);
 // 保留首次出现,重复行计入 dedupRows,不再污染 eventsRead/工具失败/重复读统计。
    const seq = typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : undefined;
    if (seq !== undefined) {
      if (seenSeq.has(seq)) { dedupRows += 1; continue; }
      seenSeq.add(seq);
    }
    eventsRead += 1;
    const kind = asString(event.kind);
    const lowerKind = kind.toLowerCase();
    const payload = asRecord(event.payload) ?? {};
    const kindFailure = lowerKind.includes("error") || lowerKind.includes("fail");
    const okFlag = payload.ok;
    const errorFlag = payload.error;
    const payloadFailure =
      okFlag === false || (errorFlag !== undefined && errorFlag !== null && errorFlag !== "");
    // ①/② 是同一事件的两个识别口径:命中任一即记一次,同一行不重复计数。
    if (kindFailure || payloadFailure) directFailures += 1;
    if (kind === "tool.call") {
      register(payload.toolCallId, payload.name, payload.arguments);
    } else if (kind === "tool.result") {
      resolve(payload.toolCallId, payload.content);
    } else if (kind === "message.agent") {
      const toolCalls = payload.toolCalls;
      if (Array.isArray(toolCalls)) {
        for (const entry of toolCalls) {
          const call = asRecord(entry) ?? {};
          register(call.id, call.name, call.arguments);
        }
      }
    }
  }

  let repeatedReads = 0;
  for (const count of groups.values()) {
    if (count >= 3) repeatedReads += 1;
  }
  const unanswered = calls.filter((call) => !call.answered).length;
  const unresolvedAsks = calls.filter(
    (call) => call.name === "ask_user" && (!call.answered || call.unansweredMarker),
  ).length;

  return {
    sessionId,
    eventsRead,
    eventsSkipped,
    dedupRows,
    tools,
    repeatedReads,
    unresolvedAsks,
    failedSteps: directFailures + unanswered,
    filesEdited,
    fanoutEdges,
  };
}

function toMineSessions(sessions: readonly NightlySessionStats[]): MineSessionStats[] {
  return sessions.map((session) => ({
    id: session.sessionId,
    tools: { ...session.tools },
    repeatedReads: session.repeatedReads,
    unresolvedAsks: session.unresolvedAsks,
    failedSteps: session.failedSteps,
    filesEdited: session.filesEdited,
    fanoutEdges: session.fanoutEdges,
  }));
}

function readStatsFile(file: string): NightlySessionStatsFile | null {
  const parsed = readJson<NightlySessionStatsFile>(file);
  if (!parsed || !Array.isArray(parsed.sessions)) return null;
  return parsed;
}

function readSelection(
  file: string,
  run: NightlyRun,
  journalDir: string,
  maxSessions: unknown): NightlySelectionFile {
  const stored = readJson<NightlySelectionFile>(file);
  if (stored && Array.isArray(stored.sessions)) return stored;
  // 回退:没有 selection 快照(例如手工塞进来的 run 文件)时按 mtime 取一批。
  const entries = enumerateSessions(journalDir).slice(0, normaliseLimit(maxSessions, DEFAULT_MAX_SESSIONS));
  const last = lastEntry(entries);
  const selection: NightlySelectionFile = {
    runId: run.runId,
    projectId: run.projectId,
    date: run.date,
    selectedAt: run.createdAt,
    sessions: entries,
  };
  if (last) {
    selection.lastSessionId = last.sessionId;
    selection.lastMtimeMs = last.mtimeMs;
  }
  return selection;
}

/** 只有整条 run 成功后游标才前移(否则失败的会话会被跳过)。 */
function advanceCursor(cursorFile: string, projectId: string, selection: NightlySelectionFile): void {
  const last = lastEntry(selection.sessions);
  if (!last) return;
  const cursor = readCursorFile(cursorFile);
  cursor[projectId] = { lastSessionId: last.sessionId, lastMtimeMs: last.mtimeMs };
  writeJsonAtomic(cursorFile, cursor);
}

interface StepContext {
  root: string;
  paths: NightlyPaths;
  run: NightlyRun;
  step: NightlyStepName;
  selection: NightlySelectionFile;
  journalDir: string;
  maxSessions: number;
  at: number;
}

interface StepOutcome {
  run: NightlyRun;
  codes: NightlyCode[];
  tokens: number;
  artifactRef?: string;
  note?: string;
}

function stepPullTraces(ctx: StepContext): StepOutcome {
  const { paths, run, selection, journalDir } = ctx;
  const sessions = selection.sessions.map((entry) =>
    parseSessionFile(join(journalDir, "sessions", entry.file), entry.sessionId),
  );
 // C:基因行 A/B 度量 —— 带 gene.brief.shown 标记的会话 vs 不带的,后续作为
 // 建设者(verdict=preventable)的返工命中对比。只统计,不改任何账本。
  let geneNote = "geneBrief=skipped";
  try {
    const preventableBuilds = new Set(
      readReworkChains(ctx.root).chains
        .filter((c) => c.attribution?.verdict === "preventable")
        .map((c) => c.buildSession),
    );
    let marked = 0;
    let markedHit = 0;
    let unmarked = 0;
    let unmarkedHit = 0;
    for (const entry of selection.sessions) {
      const file = join(journalDir, "sessions", entry.file);
      if (hasGeneBriefMarker(file)) {
        marked += 1;
        if (preventableBuilds.has(entry.sessionId)) markedHit += 1;
      } else {
        unmarked += 1;
        if (preventableBuilds.has(entry.sessionId)) unmarkedHit += 1;
      }
    }
    geneNote = `geneBrief: marked=${marked}(hit=${markedHit}) vs unmarked=${unmarked}(hit=${unmarkedHit})`;
  } catch {
    geneNote = "geneBrief=error(不阻塞本步)";
  }
  const file: NightlySessionStatsFile = {
    generatedAt: iso(ctx.at),
    runId: run.runId,
    projectId: run.projectId,
    date: run.date,
    sessions,
  };
  writeJsonAtomic(paths.statsFile, file);
  const eventsRead = sessions.reduce((sum, session) => sum + session.eventsRead, 0);
  const eventsSkipped = sessions.reduce((sum, session) => sum + session.eventsSkipped, 0);
  const dedupRows = sessions.reduce((sum, session) => sum + (session.dedupRows ?? 0), 0);
  const next = recordCoverage(run, {
    coverage: { sessionsProcessed: sessions.length, eventsRead, eventsSkipped },
    at: ctx.at,
  });
  return {
    run: next,
    codes: [],
 // pull-traces 是纯确定性统计,不烧 LLM;这里的 tokens 是**工作预算**口径
 // (1 事件=1 工作单元,用于 maxTokens 限流),不是 LLM 计费 token——成本看 cost.jsonl。
    tokens: eventsRead,
    artifactRef: artifactRef(run.projectId, run.date, ".session-stats.json"),
    note: `sessions=${sessions.length} events=${eventsRead} badLines=${eventsSkipped} dedupRows=${dedupRows}(tokens=work-units,非LLM计费) ${geneNote}`,
  };
}

/** C:journal 里是否有开工基因行标记(逐行容忍坏行,只在 event.payload.type 上判)。 */
function hasGeneBriefMarker(file: string): boolean {
  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch { return false; }
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parsed = readJsonLine(line);
    const payload = asRecord(asRecord(parsed)?.payload);
    if (asString(payload?.type) === "gene.brief.shown") return true;
  }
  return false;
}

function stepDenoise(ctx: StepContext): StepOutcome {
  const { paths, run } = ctx;
  const stats = readStatsFile(paths.statsFile) ?? {
    generatedAt: iso(ctx.at),
    runId: run.runId,
    projectId: run.projectId,
    date: run.date,
    sessions: [],
  };
  const kept: NightlySessionStats[] = [];
  const skipped: string[] = [];
  const emptyItems: NightlyUnprocessed[] = [];
  for (const session of stats.sessions) {
    const id = session.sessionId.toLowerCase();
    if (id.includes("probe") || id.includes("smoke")) {
      skipped.push(session.sessionId);
      continue;
    }
    if (session.eventsRead === 0) emptyItems.push({ sessionId: session.sessionId, reason: "empty" });
    kept.push(session);
  }
  writeJsonAtomic(paths.statsFile, {
    ...stats,
    generatedAt: iso(ctx.at),
    sessions: kept,
    skipped,
    unprocessed: emptyItems,
  });

  let next = recordCoverage(run, { coverage: { sessionsSkipped: skipped.length }, at: ctx.at });
  const codes: NightlyCode[] = [];
  const known = new Set(next.unprocessed.map((item) => item.sessionId));
  const fresh = emptyItems.filter((item) => !known.has(item.sessionId));
  if (fresh.length > 0) {
    const added = addUnprocessed(next, fresh);
    next = added.run;
    codes.push(...added.codes);
  }
  return {
    run: next,
    codes,
    tokens: 0,
    note: `kept=${kept.length} noise=${skipped.length} empty=${fresh.length}`,
  };
}

function stepMine(ctx: StepContext): StepOutcome {
  const stats = readStatsFile(ctx.paths.statsFile);
  const candidates = mineCandidates({ sessions: toMineSessions(stats?.sessions ?? []) });
  return { run: ctx.run, codes: [], tokens: 1, note: `candidates=${candidates.length}` };
}

function stepUpdateGraph(ctx: StepContext): StepOutcome {
  const { paths, run } = ctx;
  const stats = readStatsFile(paths.statsFile);
  const candidates = mineCandidates({ sessions: toMineSessions(stats?.sessions ?? []) });
  const file: NightlyEvidencePendingFile = {
    generatedAt: iso(ctx.at),
    runId: run.runId,
    status: "pending-review",
    note: "待人工确认后写入缺陷图谱",
    candidates,
  };
  writeJsonAtomic(paths.evidenceFile, file);
 // decay : findings「全图零 decay、validTo 全空」——schema/applyDecay 早就有,
 // 夜间流水线没接。update-graph 之后跑一次衰减(半衰期 30 天、score<0.5 判 stale),有状态变化才落
 // decay 行(applyDecay 内部 updates 为空不写),幂等。
  let decayNote = "decay=skipped";
  try {
    const decayed = applyDecay(ctx.root, NIGHTLY_DECAY_POLICY);
    decayNote = `decay: stale=${decayed.report?.stale ?? 0} archived=${decayed.report?.archived ?? 0}`;
  } catch {
    decayNote = "decay=error(不阻塞本步)";
  }
 // 世界模型生成闭环(mechanisms.md #217「每日更新」):journal 会话 → derived 层
 // (主题/模块活动/返工信号/噪声账)合入 atlas 快照。curated 事件层不动;失败不阻塞本步。
 // 返工因果链(设想灵魂):链识别三路投票 → 分类 → 缺陷定位 → 根因归因(A 决策时
 // 信息可得性)+ 扇出簇;append-only 幂等台账 .genie/rsi/rework-chains.jsonl。失败不阻塞本步。
  let reworkNote = "rework=skipped";
  let reworkSummary: AtlasReworkSummary | undefined;
  try {
    const rework = detectReworkChains(ctx.root, run.projectId, { journalDir: ctx.journalDir, windowDays: 14, now: ctx.at });
    reworkNote = rework.ok
      ? `rework: chains=${rework.chains}(fanout=${rework.fanoutClusters},new=${rework.appended})`
      : "rework=error(不阻塞本步)";
 // defectGenes 生产者(atlas 机制点名「curated 缺陷基因全空与 37 条返工链矛盾」):
 // 新落链里可分类的(boundary/contract/concurrency/missing-test)聚合为 DefectGene 事件进
 // curated 层;只投新链 → 天然幂等。
    const classifiable = rework.freshChains.filter((c) => c.defectClass !== "uncategorized");
 // atlas 机制注意「基因跨批重复累加 1.8 倍」:重测删台账重放会让同批链再次
 // 变「新链」——同 id 已有 count >= 本批 count 的基因不再投(快照聚合视图判)。
    const existingGenes = new Map<string, number>();
    try {
      for (const g of (getAtlas(ctx.root, run.projectId).atlas?.defectGenes ?? [])) {
        existingGenes.set(String(g.id ?? ""), Math.max(existingGenes.get(String(g.id ?? "")) ?? 0, Number(g.count ?? 0)));
      }
    } catch { /* 快照不可读:按无既有处理 */ }
    const worthIngest = classifiable.length > 0;
    if (rework.ok && worthIngest) {
      const genes = new Map<string, { id: string; defectClass: string; module: string; count: number; lastAt: string }>();
      for (const chain of classifiable) {
        const id = `gene-${chain.defectClass}-${chain.logicalKey.replace(/[^\w\u4e00-\u9fff-]+/g, "-").slice(-60)}`;
        const gene = genes.get(id) ?? { id, defectClass: chain.defectClass, module: chain.path, count: 0, lastAt: iso(ctx.at) };
        gene.count += 1;
        genes.set(id, gene);
      }
      const fresh = [...genes.values()].filter((g) => (existingGenes.get(g.id) ?? 0) < g.count);
      if (fresh.length > 0) ingestDefects(ctx.root, run.projectId, fresh, iso(ctx.at));
      reworkNote += ` genes=${genes.size}`;
    }
    const ledger = readReworkChains(ctx.root);
    reworkSummary = {
      chains: ledger.chains.length,
      fanoutClusters: ledger.fanoutClusters.length,
 // atlas 机制注意「slice(-3) 把 6 簇砍半」:按修复数降序取前 5,不藏簇。
      impactNotClosed: [...ledger.fanoutClusters]
        .sort((a, b) => b.fixSessions.length - a.fixSessions.length)
        .slice(0, 5)
        .map((c) => ({ buildSession: c.buildSession, fixes: c.fixSessions.length, units: c.logicalKeys.length })),
    };
  } catch {
    reworkNote = "rework=error(不阻塞本步)";
  }
  let atlasNote = "atlas=skipped";
  try {
    const refreshed = refreshAtlasSnapshot(ctx.root, run.projectId, { journalDir: ctx.journalDir, windowDays: 7, reworkSummary });
    atlasNote = refreshed.ok
      ? `atlas: themes=${refreshed.harvest?.themes.length ?? 0} modules=${refreshed.harvest?.moduleActivity.length ?? 0} rework=${refreshed.harvest?.reworkSignals.length ?? 0} noise=${refreshed.harvest?.noiseSessions ?? 0}`
      : `atlas=${refreshed.code ?? "error"}(不阻塞本步)`;
  } catch {
    atlasNote = "atlas=error(不阻塞本步)";
  }
 // 病理采集闭环:harvest 的工作会话(重入=同文件跨会话再改)+ nightly 统计的
 // fanout 边 → pathology detect 落一行(此前 detect 只有 11-11 首跑一条手工线,
 // pathology 机制读的是死台账)。失败不阻塞本步。
 // F:工作会话视图只采一次(J 兜底:projectRoots 让「外部项目绑定但编辑路径全在本仓」
 // 的会话计入),pathology 与 cohort 共用。
  let workSessions: ReturnType<typeof collectWorkSessions> | null = null;
  try {
    workSessions = collectWorkSessions(ctx.journalDir, {
      windowDays: 7,
      now: ctx.at,
      projectRoots: loadProjectRoots(ctx.journalDir),
    });
  } catch {
    workSessions = null;
  }
 // E:curated 目标层生产者 —— 当日主题簇 → goal 候选,写观察队列 proposed-goals.json;
 // 不直接进 entries.jsonl(curated 层仍只由人审/atlas 机制决定)。
  let goalsNote = "goals=skipped";
  try {
 // DirectionAtlas 类型本身不含 derived(derived 由 refresh 合入快照文件),这里按宽松视图读。
    const snapshot = getAtlas(ctx.root, run.projectId).atlas as unknown as
      | { derived?: { themes?: Array<{ id: string; sessions: number; titles?: string[] }> } }
      | undefined;
    const themes = snapshot?.derived?.themes ?? [];
    const goals = themes
      .filter((t) => t.sessions >= 2)
      .map((t) => {
        const sample = t.titles?.[t.titles.length - 1] ?? "";
        return {
          id: `pg:${run.projectId}:${t.id}`,
          theme: t.id,
          sessions: t.sessions,
          at: iso(ctx.at),
          status: "proposed" as const,
          reason: `主题簇 ${t.sessions} 会话${sample !== "" ? `:${sample}` : ""}`,
        };
      });
    const goalPath = join(ctx.root, ".genie", "rsi", "atlas", "proposed-goals.json");
    mkdirSync(dirname(goalPath), { recursive: true });
    writeJsonAtomic(goalPath, { v: 1, at: iso(ctx.at), runId: run.runId, projectId: run.projectId, goals });
    goalsNote = `goals: proposed=${goals.length}`;
  } catch {
    goalsNote = "goals=error(不阻塞本步)";
  }
 // F:cohort 同批采集器 —— build 类会话登记 delivery、返工链 fixSession 登记 fix;
 // 落盘走 cohort-metrics-store 的既有真源 .genie/rsi/cohort.jsonl;id 确定性 → 重跑幂等(重复 id 拒收)。
  let cohortNote = "cohort=skipped";
  try {
    const ledger = readReworkChains(ctx.root);
    const fixClass = new Map<string, string | undefined>();
    for (const c of ledger.chains) fixClass.set(c.fixSession, c.defectClass);
    let deliveries = 0;
    let fixes = 0;
    let dup = 0;
    for (const session of workSessions?.sessions ?? []) {
      const first = session.editedPaths?.[0];
      if (!first) continue;
      const module = logicalPathKey(first);
      const idBase = `nightly:${run.date}:${session.sessionId}`;
      if (fixClass.has(session.sessionId)) {
        const cls = cohortDefectClassOf(fixClass.get(session.sessionId));
        const r = recordFix(ctx.root, {
          id: `${idBase}:fix`,
          taskId: session.sessionId,
          module,
          at: session.mtimeMs,
          foundAt: "nightly",
          ...(cls !== undefined ? { defectClass: cls } : {}),
        });
        if (r.ok) fixes += 1;
        else if (r.code === "COHORT_DUPLICATE") dup += 1;
      } else if (!FIX_TITLE_RE.test(session.title)) {
        const r = recordDelivery(ctx.root, {
          id: `${idBase}:delivery`,
          taskId: session.sessionId,
          module,
          taskClass: "unknown",
          boardType: "unknown",
          at: session.mtimeMs,
        });
        if (r.ok) deliveries += 1;
        else if (r.code === "COHORT_DUPLICATE") dup += 1;
      }
    }
    cohortNote = `cohort: delivery=${deliveries} fix=${fixes} dup=${dup}`;
  } catch {
    cohortNote = "cohort=error(不阻塞本步)";
  }
  let pathologyNote = "pathology=skipped";
  try {
    const work = workSessions ?? collectWorkSessions(ctx.journalDir, { windowDays: 7, now: ctx.at });
    const stats = readStatsFile(paths.statsFile);
    const changeNodes = (stats?.sessions ?? [])
      .filter((s) => (s.fanoutEdges ?? 0) > 0)
      .map((s) => ({ at: ctx.at, fanoutEdges: s.fanoutEdges ?? 0 }));
    const detected = detect(
      ctx.root,
      {
        sessions: work.sessions.map((s) => ({ id: s.sessionId, files: s.editedPaths })),
        ...(changeNodes.length > 0 ? { changeNodes } : {}),
      },
      { at: ctx.at },
    );
    pathologyNote = `pathology: matched=${detected.matched.length} candidates=${detected.candidates.length}`;
  } catch {
    pathologyNote = "pathology=error(不阻塞本步)";
  }
  return {
    run: ctx.run,
    codes: [],
    tokens: 1,
    artifactRef: artifactRef(run.projectId, run.date, ".evidence-pending.json"),
    note: `pendingReview=${candidates.length} ${decayNote} ${atlasNote} ${goalsNote} ${cohortNote} ${pathologyNote} ${reworkNote}`,
  };
}

function stepGenerateCandidates(ctx: StepContext): StepOutcome {
  const { paths, run } = ctx;
  const evidence = readJson<NightlyEvidencePendingFile>(paths.evidenceFile);
  const all = Array.isArray(evidence?.candidates) ? evidence.candidates : [];
 // G:本日已消费的候选不再进 run.candidates(重复候选不重复入队的前置闸)。
  const consumed = consumedCandidateIds(paths.queueFile, ctx.at);
  const incoming = all.filter((c) => !consumed.has(c.id));
  const added = addCandidates(run, incoming);
  return {
    run: added.run,
    codes: added.codes,
    tokens: 0,
    artifactRef: artifactRef(run.projectId, run.date, ".session-stats.json"),
    note: `candidates=${added.run.candidates.length}`,
  };
}

/** 只入队不 adopt;按 (runId, candidate.id) 去重,重跑本步不产生重复行。
 * G:候选若在 14 天内已被机制消费(consumedAt 在册),不再重复入队。 */
function appendQueue(queueFile: string, run: NightlyRun, at: number): number {
  mkdirSync(dirname(queueFile), { recursive: true });
  const seen = new Set<string>();
  const consumed = consumedCandidateIds(queueFile, at);
  try {
    for (const line of readFileSync(queueFile, "utf8").split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const parsed = asRecord(readJsonLine(line));
      if (!parsed) continue;
      const candidate = asRecord(parsed.candidate);
      const id = asString(candidate?.id);
      if (id !== "") seen.add(`${asString(parsed.runId)}\u0000${id}`);
    }
  } catch {
    // 队列不存在 = 空队列。
  }
  const queuedAt = iso(at);
  const lines: string[] = [];
  for (const candidate of run.candidates) {
    if (consumed.has(candidate.id)) continue; // G:已消费的不重复入队
    const key = `${run.runId}\u0000${candidate.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line: NightlyQueueLine = {
      queuedAt,
      runId: run.runId,
      projectId: run.projectId,
      date: run.date,
      candidate,
    };
    lines.push(JSON.stringify(line));
  }
  if (lines.length > 0) writeFileSync(queueFile, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "a" });
  return lines.length;
}

/** G:窗口内已消费的候选 id 集合(坏行跳过)。 */
function consumedCandidateIds(queueFile: string, at: number): Set<string> {
  const out = new Set<string>();
  let raw = "";
  try { raw = readFileSync(queueFile, "utf8"); } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parsed = asRecord(readJsonLine(line));
    if (!parsed) continue;
    const id = asString(asRecord(parsed.candidate)?.id);
    const consumedAt = asString(parsed.consumedAt);
    if (id === "" || consumedAt === "") continue;
    const t = Date.parse(consumedAt);
    if (Number.isFinite(t) && at - t <= QUEUE_CONSUMED_WINDOW_MS) out.add(id);
  }
  return out;
}

/**
 * G:回写队列消费标记(机制任务收尾/机制生成侧调用)。幂等:已标记的行原样保留;
 * 除目标行外其余行逐字保留(仅重建换行,不改字段)。队列文件不存在时返回全 0。
 */
export function markQueueConsumed(
  root: string,
  ids: string[],
  by: string,
  at: number = Date.now(),
): { marked: number; already: number } {
  const queueFile = join(root, NIGHTLY_DIR, QUEUE_FILE);
  let raw = "";
  try { raw = readFileSync(queueFile, "utf8"); } catch { return { marked: 0, already: 0 }; }
  const wanted = new Set(ids);
  const out: string[] = [];
  let marked = 0;
  let already = 0;
  const atIso = iso(at);
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parsed = asRecord(readJsonLine(line));
    const id = asString(asRecord(parsed?.candidate)?.id);
    if (!parsed || !wanted.has(id)) {
      out.push(line);
      continue;
    }
    if (asString(parsed.consumedAt) !== "") {
      already += 1;
      out.push(line);
      continue;
    }
    out.push(JSON.stringify({ ...parsed, consumedAt: atIso, consumedBy: by }));
    marked += 1;
  }
  if (marked > 0) writeFileSync(queueFile, `${out.join("\n")}\n`, "utf8");
  return { marked, already };
}

function readJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function stepQueueExperiments(ctx: StepContext): StepOutcome {
  const queued = appendQueue(ctx.paths.queueFile, ctx.run, ctx.at);
  return {
    run: ctx.run,
    codes: [],
    tokens: 0,
    artifactRef: `${NIGHTLY_DIR}/${QUEUE_FILE}`,
    note: `queued=${queued}`,
  };
}

function executeStep(ctx: StepContext): StepOutcome {
  switch (ctx.step) {
    case "pull-traces":
      return stepPullTraces(ctx);
    case "denoise":
      return stepDenoise(ctx);
    case "mine":
      return stepMine(ctx);
    case "update-graph":
      return stepUpdateGraph(ctx);
    case "generate-candidates":
      return stepGenerateCandidates(ctx);
    case "queue-experiments":
      return stepQueueExperiments(ctx);
    default:
      throw new Error(`未知夜间步骤: ${String(ctx.step)}`);
  }
}

function allStepsFinished(run: NightlyRun): boolean {
  return run.steps.length > 0 && run.steps.every((step) => DONE_STEP_STATUSES.has(step.status));
}

/** 终局 run 的「相应码」:done/skipped → 不再跑;paused/failed → 交回调用方决定 resume/retry。 */
function terminalCode(run: NightlyRun): NightlyCode | null {
  if (run.status === "done") return NIGHTLY_CODES.NIGHTLY_SKIPPED_DONE;
  if (run.status === "paused") return NIGHTLY_CODES.NIGHTLY_PAUSED;
  if (run.status === "failed") return NIGHTLY_CODES.NIGHTLY_FAILED;
  if (run.status === "skipped") {
    return run.pauseReason === "online-busy"
      ? NIGHTLY_CODES.NIGHTLY_SKIPPED_ONLINE_BUSY
      : NIGHTLY_CODES.NIGHTLY_SKIPPED_DONE;
  }
  return null;
}

function loadRunFromFile(paths: NightlyPaths): NightlyRun | null {
  const run = readJson<NightlyRun>(paths.runFile);
  if (!run || typeof run.runId !== "string" || !Array.isArray(run.steps)) return null;
  return run;
}

interface LocatedRun {
  run: NightlyRun;
  paths: NightlyPaths;
}

function loadRunByRef(root: string, ref: RunNightlyOptions["runId"]): LocatedRun {
  if (typeof ref === "string") {
    const target = ref.trim();
    const found = listRunsDetailed(root).find((entry) => entry.run.runId === target);
    if (!found) throw new Error(`nightly run 不存在: ${target}`);
    return found;
  }
  const projectId = (ref.projectId ?? ref.project ?? "").trim();
  const date = ref.date;
  const paths = nightlyPaths(root, projectId, date);
  const run = loadRunFromFile(paths);
  if (!run) throw new Error(`nightly run 不存在: ${projectId}/${date}`);
  return { run, paths };
}

/**
 * 开一轮夜间 run:幂等(同日完成过就跳过)→ 增量选会话 → startRun → 落 run 与 selection 快照。
 * onlineBusy 时返回 skipped run 但**不落盘**(不产生 run)。
 */
export async function startNightly(root: string, options: StartNightlyOptions): Promise<StartNightlyResult> {
  if (!options || typeof options.projectId !== "string" || options.projectId.trim() === "") {
    throw new Error("startNightly 缺少 projectId");
  }
  if (typeof options.journalDir !== "string" || options.journalDir === "") {
    throw new Error("startNightly 缺少 journalDir");
  }
  const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
  const paths = nightlyPaths(root, options.projectId, options.date);

  const existing = loadRunFromFile(paths);
  if (existing && shouldSkipCompleted([existing], runKey(options.date, options.projectId))) {
    return { run: existing, codes: [NIGHTLY_CODES.NIGHTLY_SKIPPED_DONE] };
  }

  const cursor = readCursorFile(paths.cursorFile)[options.projectId] ?? {};
  const maxSessions = normaliseLimit(options.maxSessions, DEFAULT_MAX_SESSIONS);
  const all = enumerateSessions(options.journalDir);
  const fresh = all.filter((entry) =>
    typeof cursor.lastMtimeMs === "number" ? entry.mtimeMs > cursor.lastMtimeMs : true);
  const selected = fresh.slice(0, maxSessions);
 // 覆盖口径:被 maxSessions 截断的会话不再被「窗口判完成」的报表口径吞掉——
 // 快照进 selection.unselected,收尾时入 unprocessed,报表如实说「尾部未读」。
  const unselected = fresh.slice(maxSessions);

  const config: NightlyConfig = { ...(options.config ?? {}) };
  if (options.onlineBusy === true) config.onlineBusy = true;
  const started = startRun({ date: options.date, projectId: options.projectId.trim(), now, config });
  if (!started.run) return { run: null, codes: started.codes };
  if (started.run.status === "skipped") return { run: started.run, codes: started.codes };

  const last = lastEntry(selected);
 // sessionsTotal=本轮**符合增量条件的会话总数**(不是被截断后的 selected 数):
 // 「14/14 覆盖」只在真读了 14 个时才成立( findings 注意窗口内 3 会话未读却报满)。
  let run = recordCoverage(started.run, { coverage: { sessionsTotal: fresh.length }, at: now });
  run = { ...run, cursor: last ? { lastSessionId: last.sessionId, lastMtimeMs: last.mtimeMs } : {} };

  const selection: NightlySelectionFile = {
    runId: run.runId,
    projectId: run.projectId,
    date: run.date,
    selectedAt: iso(now),
    sessions: selected,
    ...(unselected.length > 0 ? { unselected } : {}),
  };
  if (last) {
    selection.lastSessionId = last.sessionId;
    selection.lastMtimeMs = last.mtimeMs;
  }
  writeJsonAtomic(paths.selectionFile, selection);
  writeJsonAtomic(paths.runFile, run);
  return { run, codes: [...started.codes] };
}

/**
 * 跑剩余步骤:每步执行 → markStep → 立即原子落盘 → 预算/失败即停。
 * 六步全 done/skipped → finalizeRun + 前移 cursor.json。
 */
export async function runNightly(root: string, options: RunNightlyOptions): Promise<RunNightlyResult> {
  if (!options || typeof options.journalDir !== "string" || options.journalDir === "") {
    throw new Error("runNightly 缺少 journalDir");
  }
  const located = loadRunByRef(root, options.runId);
  const paths = located.paths;
  let run = located.run;
  const codes: NightlyCode[] = [];

  const terminal = terminalCode(run);
  if (terminal) return { run, codes: [terminal] };

  const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
  const selection = readSelection(paths.selectionFile, run, options.journalDir, options.maxSessions);
  const maxSessions = normaliseLimit(options.maxSessions, DEFAULT_MAX_SESSIONS);
  let at = now;

  for (;;) {
    const step = nextStep(run);
    if (!step) break;
    at += 1;
    let outcome: StepOutcome;
    try {
      outcome = executeStep({
        root,
        paths,
        run,
        step: step.name,
        selection,
        journalDir: options.journalDir,
        maxSessions,
        at,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = markStep(run, { name: step.name, status: "failed", error: message, at });
      run = failed.run;
      writeJsonAtomic(paths.runFile, run);
      codes.push(...failed.codes);
      break;
    }
    run = outcome.run;
    codes.push(...outcome.codes);
    const marked = markStep(run, {
      name: step.name,
      status: "done",
      tokens: outcome.tokens,
      artifactRef: outcome.artifactRef,
      note: outcome.note,
      at,
    });
    run = marked.run;
    writeJsonAtomic(paths.runFile, run);
    codes.push(...marked.codes);
    if (run.status === "paused" || run.status === "failed") break;
  }

  if (run.status !== "done" && run.status !== "failed" && allStepsFinished(run)) {
 // 覆盖口径收尾对齐( findings「夜报申报 14/14 覆盖但窗口内 3 会话未读」):
 // ①被 maxSessions 截断的会话显式进 unprocessed(不再被「窗口判完成」吞掉);
 // ②window.to 收紧到实际 cursor 时间(报表不再声称覆盖到窗口尾,未读部分如实可见);
 // ③补一行 cursor 说明,下一轮从哪续读一目了然。
    const overflow = Array.isArray(selection.unselected) ? selection.unselected : [];
    if (overflow.length > 0) {
      const known = new Set(run.unprocessed.map((item) => item.sessionId));
      const fresh = overflow
        .filter((entry) => !known.has(entry.sessionId))
        .map((entry) => ({ sessionId: entry.sessionId, reason: "max-sessions 超出,本轮未读(下轮按 cursor 续读)" }));
      if (fresh.length > 0) {
        const added = addUnprocessed(run, fresh);
        run = added.run;
      }
    }
    let cursorLine = "";
    if (typeof selection.lastMtimeMs === "number" && Number.isFinite(selection.lastMtimeMs)) {
      const honestTo = iso(selection.lastMtimeMs);
 // nightly 机制注意:window.from 可能是无时区本地串、to 被 clamp 成 UTC Z 串,
 // 字典序比较会倒挂误判——必须按时间值比较(解析失败的怪格式不动,宁可不收紧)。
      const currentToMs = Date.parse(run.window.to);
      if (Number.isFinite(currentToMs) && Date.parse(honestTo) < currentToMs) {
        run = { ...run, window: { ...run.window, to: honestTo } };
      }
      cursorLine = `cursor: last=${selection.lastSessionId ?? "?"} at=${honestTo}(实际覆盖到此;尾部未读见 unprocessed)`;
    }
    // 报告在收尾后重算一次:finalize 之前 run.status 还是 running,直接取会给已完成的 run 留下
    // `status: running` 的失真审计行。
    const finalized = finalizeRun(run, { at: at + 1, report: buildRunReport(run) });
    if (finalized.codes.includes(NIGHTLY_CODES.NIGHTLY_FINALIZED)) {
      run = {
        ...finalized.run,
        report: [
          ...buildRunReport(finalized.run),
          `window: ${finalized.run.window.from} ~ ${finalized.run.window.to}`,
          ...(cursorLine !== "" ? [cursorLine] : []),
          `artifacts: stats=${artifactRef(finalized.run.projectId, finalized.run.date, ".session-stats.json")} evidence=${artifactRef(finalized.run.projectId, finalized.run.date, ".evidence-pending.json")} queue=${NIGHTLY_DIR}/${QUEUE_FILE}`,
        ],
      };
      writeJsonAtomic(paths.runFile, run);
      codes.push(...finalized.codes);
      advanceCursor(paths.cursorFile, run.projectId, selection);
    }
  }

  return { run, codes };
}

export async function getRun(root: string, query: RunQuery): Promise<NightlyRun | null> {
  return loadRunFromFile(nightlyPaths(root, query.projectId, query.date));
}

interface DetailedRun extends LocatedRun {
  file: string;
}

const RUN_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.json$/;

function listRunsDetailed(root: string): DetailedRun[] {
  const base = join(root, NIGHTLY_DIR);
  let projects: string[] = [];
  try {
    projects = readdirSync(base);
  } catch {
    return [];
  }
  const out: DetailedRun[] = [];
  for (const project of projects) {
    const dir = join(base, project);
    let names: string[] = [];
    try {
      const info = statSync(dir);
      if (!info.isDirectory()) continue;
      names = readdirSync(dir).filter((name) => RUN_FILE_PATTERN.test(name));
    } catch {
      continue;
    }
    for (const name of names) {
      const paths = nightlyPaths(root, project, name.replace(/\.json$/, ""));
      const run = loadRunFromFile(paths);
      if (run) out.push({ run, paths, file: paths.runFile });
    }
  }
  out.sort((a, b) => `${a.run.date}|${a.run.projectId}`.localeCompare(`${b.run.date}|${b.run.projectId}`));
  return out;
}

export async function listRuns(root: string): Promise<NightlyRun[]> {
  return listRunsDetailed(root).map((entry) => entry.run);
}

/** 手工暂停(只对 pending/running 有效,否则原样返回 + NIGHTLY_INVALID)。 */
export async function pauseNightly(
  root: string,
  options: PauseNightlyOptions): Promise<{ run: NightlyRun | null; codes: NightlyCode[] }> {
  const paths = nightlyPaths(root, options.projectId, options.date);
  const run = loadRunFromFile(paths);
  if (!run) return { run: null, codes: [NIGHTLY_CODES.NIGHTLY_INVALID] };
  const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
  const paused = pauseRun(run, { reason: options.reason ?? "manual", at: now });
  if (paused.codes.includes(NIGHTLY_CODES.NIGHTLY_PAUSED)) writeJsonAtomic(paths.runFile, paused.run);
  return { run: paused.run, codes: paused.codes };
}

/**
 * 续跑:先 resumeRun 落盘,再 runNightly 接着跑。
 * 预算暂停的 run 需要「追加预算」才能继续:markStep 是**累计**判定,已超支的 run 不抬上限
 * 会让下一步立即再次暂停(0 token 步骤也一样),因此这里把 maxTokens 抬到
 * max(tokens*2, tokens+1) —— 只动 budget 字段,幂等与状态机仍全部来自 nightly-run。
 */
export async function resumeNightly(root: string, options: ResumeNightlyOptions): Promise<RunNightlyResult> {
  const paths = nightlyPaths(root, options.projectId, options.date);
  const run = loadRunFromFile(paths);
  if (!run) throw new Error(`nightly run 不存在: ${options.projectId}/${options.date}`);
  const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
  const resumed = resumeRun(run, { at: now });
  if (!resumed.codes.includes(NIGHTLY_CODES.NIGHTLY_RESUMED)) return { run: resumed.run, codes: resumed.codes };
  writeJsonAtomic(paths.runFile, withBudgetHeadroom(resumed.run));
  const next = await runNightly(root, {
    runId: { projectId: options.projectId, date: options.date },
    journalDir: options.journalDir,
    maxSessions: options.maxSessions,
    now: now + 1,
  });
  return { run: next.run, codes: [NIGHTLY_CODES.NIGHTLY_RESUMED, ...next.codes] };
}

/** retry 语义同 resume,但只接受 failed(其余状态由 retryRun 判 NIGHTLY_INVALID)。 */
export async function retryNightly(root: string, options: ResumeNightlyOptions): Promise<RunNightlyResult> {
  const paths = nightlyPaths(root, options.projectId, options.date);
  const run = loadRunFromFile(paths);
  if (!run) throw new Error(`nightly run 不存在: ${options.projectId}/${options.date}`);
  const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
  const retried = retryRun(run, { at: now });
  if (!retried.codes.includes(NIGHTLY_CODES.NIGHTLY_RETRIED)) return { run: retried.run, codes: retried.codes };
  writeJsonAtomic(paths.runFile, withBudgetHeadroom(retried.run));
  const next = await runNightly(root, {
    runId: { projectId: options.projectId, date: options.date },
    journalDir: options.journalDir,
    maxSessions: options.maxSessions,
    now: now + 1,
  });
  return { run: next.run, codes: [NIGHTLY_CODES.NIGHTLY_RETRIED, ...next.codes] };
}

/** 越支的 run 续跑前需要抬高上限(理由见 resumeNightly 注释)。 */
function withBudgetHeadroom(run: NightlyRun): NightlyRun {
  const { tokens, maxTokens } = run.budget;
  if (tokens <= maxTokens) return run;
  return { ...run, budget: { tokens, maxTokens: Math.max(tokens * 2, tokens + 1) } };
}

/** 手工收尾(六步都 done/skipped 才允许)。 */
export async function finalizeNightly(
  root: string,
  options: FinalizeNightlyOptions): Promise<{ run: NightlyRun | null; codes: NightlyCode[] }> {
  const paths = nightlyPaths(root, options.projectId, options.date);
  const run = loadRunFromFile(paths);
  if (!run) return { run: null, codes: [NIGHTLY_CODES.NIGHTLY_INVALID] };
  const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
  const finalized = finalizeRun(run, { at: now, report: run.report ?? [...buildRunReport(run)] });
  if (finalized.codes.includes(NIGHTLY_CODES.NIGHTLY_FINALIZED)) writeJsonAtomic(paths.runFile, finalized.run);
  return { run: finalized.run, codes: finalized.codes };
}

/**
 * 人读报告:每个匹配 run 取 run.report(已 finalize)或现算 buildRunReport。
 * 匹配不到给一行占位,便于 CLI 直接打印。
 */
export async function nightlyReport(root: string, options: NightlyReportOptions = {}): Promise<string[]> {
  const runs = (await listRuns(root)).filter(
    (run) =>
      (options.projectId === undefined || run.projectId === options.projectId) &&
      (options.date === undefined || run.date === options.date),
  );
  if (runs.length === 0) return ["nightly: 无匹配 run"];
  const lines: string[] = [];
  runs.forEach((run, index) => {
    if (index > 0) lines.push("");
    lines.push(...(Array.isArray(run.report) && run.report.length > 0 ? run.report : buildRunReport(run)));
  });
  return lines;
}

/** 队列读取入口(CLI / 下游实验调度用):损坏行跳过。 */
export function readQueue(root: string): NightlyQueueLine[] {
  const file = join(root, NIGHTLY_DIR, QUEUE_FILE);
  if (!existsSync(file)) return [];
  const out: NightlyQueueLine[] = [];
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const parsed = asRecord(readJsonLine(line));
      const candidate = asRecord(parsed?.candidate);
      if (!parsed || !candidate || typeof candidate.id !== "string") continue;
      out.push(parsed as unknown as NightlyQueueLine);
    }
  } catch {
    return out;
  }
  return out;
}
