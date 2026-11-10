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

/** queue.jsonl 的单行形状(append-only,每行一个 JSON)。 */
export interface NightlyQueueLine {
  queuedAt: string;
  runId: string;
  projectId: string;
  date: string;
  candidate: NightlyCandidate;
}

/** 单个会话的统计(pull-traces 产物,也是 mine 的输入)。 */
export interface NightlySessionStats {
  sessionId: string;
  eventsRead: number;
  eventsSkipped: number;
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

/** `<date>.selection.json` 的文件形状:选中集合是 run 落盘时的快照,后续步骤只读它。 */
export interface NightlySelectionFile {
  runId: string;
  projectId: string;
  date: string;
  selectedAt: string;
  sessions: NightlySelectionEntry[];
  lastSessionId?: string;
  lastMtimeMs?: number;
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
function parseSessionFile(filePath: string, sessionId: string): NightlySessionStats {
  const tools: Record<string, number> = {};
  const groups = new Map<string, number>();
  const calls: CallRecord[] = [];
  const callIndex = new Map<string, number>();
  let eventsRead = 0;
  let eventsSkipped = 0;
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
    tools[toolName] = (tools[toolName] ?? 0) + 1;
    const argsKey = typeof args === "string" ? args : JSON.stringify(args ?? "");
    const groupKey = `${toolName}\u0000${argsKey}`;
    groups.set(groupKey, (groups.get(groupKey) ?? 0) + 1);
    if (EDIT_TOOL_NAMES.has(toolName)) filesEdited += 1;
    if (toolName === "spawn_subagent") fanoutEdges += 1;
    const callId = asString(id);
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
    eventsRead += 1;
    const event = asRecord(parsed);
    if (!event) continue;
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
  const next = recordCoverage(run, {
    coverage: { sessionsProcessed: sessions.length, eventsRead, eventsSkipped },
    at: ctx.at,
  });
  return {
    run: next,
    codes: [],
    tokens: eventsRead,
    artifactRef: artifactRef(run.projectId, run.date, ".session-stats.json"),
    note: `sessions=${sessions.length} events=${eventsRead} badLines=${eventsSkipped}`,
  };
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
  return {
    run: ctx.run,
    codes: [],
    tokens: 1,
    artifactRef: artifactRef(run.projectId, run.date, ".evidence-pending.json"),
    note: `pendingReview=${candidates.length}`,
  };
}

function stepGenerateCandidates(ctx: StepContext): StepOutcome {
  const { paths, run } = ctx;
  const evidence = readJson<NightlyEvidencePendingFile>(paths.evidenceFile);
  const incoming = Array.isArray(evidence?.candidates) ? evidence.candidates : [];
  const added = addCandidates(run, incoming);
  return {
    run: added.run,
    codes: added.codes,
    tokens: 0,
    artifactRef: artifactRef(run.projectId, run.date, ".session-stats.json"),
    note: `candidates=${added.run.candidates.length}`,
  };
}

/** 只入队不 adopt;按 (runId, candidate.id) 去重,重跑本步不产生重复行。 */
function appendQueue(queueFile: string, run: NightlyRun, at: number): number {
  mkdirSync(dirname(queueFile), { recursive: true });
  const seen = new Set<string>();
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

  const config: NightlyConfig = { ...(options.config ?? {}) };
  if (options.onlineBusy === true) config.onlineBusy = true;
  const started = startRun({ date: options.date, projectId: options.projectId.trim(), now, config });
  if (!started.run) return { run: null, codes: started.codes };
  if (started.run.status === "skipped") return { run: started.run, codes: started.codes };

  const last = lastEntry(selected);
  let run = recordCoverage(started.run, { coverage: { sessionsTotal: selected.length }, at: now });
  run = { ...run, cursor: last ? { lastSessionId: last.sessionId, lastMtimeMs: last.mtimeMs } : {} };

  const selection: NightlySelectionFile = {
    runId: run.runId,
    projectId: run.projectId,
    date: run.date,
    selectedAt: iso(now),
    sessions: selected,
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
    // 报告在收尾后重算一次:finalize 之前 run.status 还是 running,直接取会给已完成的 run 留下
    // `status: running` 的失真审计行。
    const finalized = finalizeRun(run, { at: at + 1, report: buildRunReport(run) });
    if (finalized.codes.includes(NIGHTLY_CODES.NIGHTLY_FINALIZED)) {
      run = {
        ...finalized.run,
        report: [
          ...buildRunReport(finalized.run),
          `window: ${finalized.run.window.from} ~ ${finalized.run.window.to}`,
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
