/**
 * 夜间离线整合 store(IO / 调度 / 流水线执行)。
 * 分层红线:
 * - 纯逻辑(幂等 / 预算 / 状态机 / 候选挖掘)一律调 `@lampgenie/runtime/agent/nightly-run`,
 * 本文件**不重复实现**,只做 IO、时钟、原子落盘与七步编排。
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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { addEvidence, applyDecay } from "./evidence-graph-store.js";
import { basename } from "node:path";
import { collectWorkSessions, groupSessionsByProject, isAllStopwords, loadProjectRegistry, loadProjectRoots, logicalPathKey, refreshAtlasSnapshot, type AtlasReworkSummary } from "./atlas-harvest.js";
import { findDeliveryIdByTaskId, recordDelivery, recordFix } from "./cohort-metrics-store.js"; // F:cohort 同批采集器;P1-③ 回链取数
import { detect } from "./pathology-store.js";
import { runGeneReplay, renderReplayNote } from "./gene-replay.js"; // 回放验证(设想的「挡废话门」)
import type { WriteHunk } from "./diff-semantics.js"; // 设计稿 34:diff 语义缺陷定位

/** 读会话的写工具 hunk(design 34 主路径 A:journal 写参数重放;纯读不 throw)。 */
function readWriteHunksOf(journalDir: string): (sessionId: string) => WriteHunk[] {
  return (sessionId: string) => {
    const out: WriteHunk[] = [];
    try {
      const text = readFileSync(join(journalDir, "sessions", `${sessionId}.jsonl`), "utf8");
      for (const raw of text.split("\n")) {
        if (raw.trim() === "") continue;
        let e: { kind?: unknown; payload?: Record<string, unknown> };
        try {
          e = JSON.parse(raw) as { kind?: unknown; payload?: Record<string, unknown> };
        } catch {
          continue;
        }
        if (e.kind !== "tool.call") continue;
        const p = e.payload ?? {};
        let args: Record<string, unknown> = {};
        try {
          args = typeof p.arguments === "string" ? JSON.parse(p.arguments) as Record<string, unknown> : (p.arguments as Record<string, unknown>) ?? {};
        } catch {
          continue;
        }
        const path = typeof args.path === "string" ? args.path : "";
        if (p.name === "edit_file" && path !== "") {
          out.push({ tool: "edit_file", path, oldText: String(args.old_string ?? ""), newText: String(args.new_string ?? "") });
        } else if (p.name === "write_file" && path !== "") {
          out.push({ tool: "write_file", path, oldText: "", newText: String(args.content ?? args.new_string ?? "") });
        } else if (p.name === "multi_edit" && Array.isArray(args.edits)) {
          for (const edit of args.edits as Array<Record<string, unknown>>) {
            const ePath = typeof edit.path === "string" ? edit.path : path;
            if (ePath !== "") out.push({ tool: "edit_file", path: ePath, oldText: String(edit.old_string ?? ""), newText: String(edit.new_string ?? "") });
          }
        }
      }
    } catch {
      return out; // 会话文件不存在:空 hunk(diff 语义回退标题词表)
    }
    return out;
  };
}
import { detectReworkChains, readReworkChains } from "./rework-chain.js"; // 返工因果链采集(设想灵魂)
import { addGoal, closeGoal, getAtlas, ingestDefects } from "./direction-atlas-store.js"; // defectGenes 生产者(atlas 机制点名); 加 closeGoal(S3 回收)
import { dirname, join } from "node:path";
import {
  NIGHTLY_CODES,
  addCandidates,
  addUnprocessed,
  buildRunReport,
  failRun,
  finalizeRun,
  markStep,
  migrateRunSteps,
  mineCandidates,
  nextStep,
  pauseRun,
  recordCoverage,
  resumeRun,
  resetStalledRun,
  retryRun,
  runKey,
  shouldSkipCompleted,
  startRun,
  DEFAULT_MAX_WORK_UNITS,
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
  defectClass: string | undefined,
): "verification-coverage" | "impact-analysis" | "wrong-assumption" | undefined {
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
 /** 本会话文件里是否含 gene.brief.shown 标记(解析时顺带识别,不再二次全读 global.jsonl)。 */
  geneBriefShown?: boolean;
 /** 对照臂:本会话含 gene.brief.held(gene 命中但被灰度扣住,未注入)。 */
  geneBriefHeld?: boolean;
 /** 本会话 LLM 输入 tokens 合计(llm.trace usage.inputTokens 求和;A/B 节省口径)。 */
  inputTokens?: number;
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
 /** 文件体量(P0-②:选择期体量闸判据;缺省=未探测)。 */
  sizeBytes?: number;
}

/**
 * 选择期噪声规则(P0-②:对齐 atlas-harvest 的噪声口径——内部/测试面会话
 * 不进分析也不消耗 maxSessions 预算(旧实现在 denoise 步才滤,选择期先被挤占;
 * 注意:11-17 强制周期误选最旧 200、含 probe/live-e2e 等内部面把 worker 卡到 15min 超时)。
 */
// 修2(机制发现「Super 指挥台永不复盘」):super 从噪声中移除——它是指挥台
// 的真实工作会话,不应被排除(但 rsi 自身会话仍排,那是机制运行痕迹不是工作)。
const SELECTION_NOISE_RE = /probe|smoke|^rsi$|prompt-live|live-e2e/i;

/** 选择期单会话体量上限:超过则跳过并计数(巨型 journal 会话曾把 pull-traces 卡死)。 */
const MAX_SESSION_BYTES = 32 * 1024 * 1024;

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
 /** P0-②:选择期被噪声规则排除的会话(诚实入账,不静默吞)。 */
  noiseSkipped?: string[];
 /** P0-②:选择期超体量上限跳过的会话(id+体量)。 */
  oversized?: Array<{ sessionId: string; sizeBytes: number }>;
 /** P0-②:本次选择实际使用的游标(取证:11-17 卡位游标未生效疑云,后续可回查)。 */
  cursorUsed?: { lastMtimeMs?: number };
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
 /** 观测钩子:某步已标 running 且**已落盘**之后回调(测试与日志用,管线逻辑不依赖它)。 */
  onStepStart?: (step: NightlyStepName, run: NightlyRun) => void;
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
    let sizeBytes = 0;
    try {
      const info = statSync(full);
      if (!info.isFile()) continue;
      mtimeMs = info.mtimeMs;
      sizeBytes = info.size;
    } catch {
      continue;
    }
    out.push({ sessionId: name.replace(/\.jsonl$/, ""), file: name, mtimeMs, sizeBytes });
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
  let geneBriefShown = false;
  let geneBriefHeld = false;
  let inputTokens = 0;

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
 // 基因行 A/B 度量:gene.brief.shown 正常路由到 global.jsonl,但会话文件里
 // 出现过也算标记(与旧口径「会话文件有标记 → marked」一致)。逐行遍历时顺带识别,零额外 IO。
    if (!geneBriefShown && asString(payload.type) === "gene.brief.shown") geneBriefShown = true;
    if (!geneBriefHeld && asString(payload.type) === "gene.brief.held") geneBriefHeld = true;
 // A/B 节省口径:本会话 LLM 输入 tokens 合计(llm.trace usage.inputTokens)。
    if (kind === "llm.trace") {
      const usage = asRecord(payload["usage"]);
      const inTok = usage !== null && typeof usage["inputTokens"] === "number" && Number.isFinite(usage["inputTokens"])
        ? usage["inputTokens"]
        : 0;
      if (inTok > 0) inputTokens += inTok;
    }
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
    geneBriefShown,
    geneBriefHeld,
    inputTokens,
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
  maxSessions: unknown,
): NightlySelectionFile {
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
 /** 本步工作单元数(分账;pull-traces=事件数,LLM 步=0)。 */
  workUnits?: number;
  artifactRef?: string;
  note?: string;
}

function stepPullTraces(ctx: StepContext): StepOutcome {
  const { paths, run, selection, journalDir } = ctx;
  const sessions = selection.sessions.map((entry) =>
    parseSessionFile(join(journalDir, "sessions", entry.file), entry.sessionId),
  );
  const statsById = new Map(sessions.map((session) => [session.sessionId, session]));
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
    let heldCount = 0;
    let heldHit = 0;
    const geneMarks = readGeneBriefSessions(journalDir);
    for (const entry of selection.sessions) {
      const local = statsById.get(entry.sessionId);
      const localShown = local?.geneBriefShown === true;
      const localHeld = local?.geneBriefHeld === true;
      if (localShown || geneMarks.shown.has(entry.sessionId)) {
        marked += 1;
        if (preventableBuilds.has(entry.sessionId)) markedHit += 1;
      } else if (localHeld || geneMarks.held.has(entry.sessionId)) {
 // 对照臂:gene 命中但被灰度扣住——与 marked 同签名可比,hits 越低越证明注入有效。
        heldCount += 1;
        if (preventableBuilds.has(entry.sessionId)) heldHit += 1;
      } else {
        unmarked += 1;
        if (preventableBuilds.has(entry.sessionId)) unmarkedHit += 1;
      }
    }
    geneNote = `geneBrief: marked=${marked}(hit=${markedHit}) vs unmarked=${unmarked}(hit=${unmarkedHit}) vs held=${heldCount}(hit=${heldHit})`;
  } catch {
    geneNote = "geneBrief=error(不阻塞本步)";
  }
 // P0-1:同日第二程只选中增量会话——stats 按 sessionId 合并(新程覆盖同会话旧
 // 统计,早程其余会话保留),否则续跑会把当日早程的 session-stats 整文件吞掉(结算器/报表丢数据)。
  const prevStats = readStatsFile(paths.statsFile);
  const mergedSessions = new Map<string, NightlySessionStats>();
  for (const s of prevStats?.sessions ?? []) mergedSessions.set(s.sessionId, s);
  for (const s of sessions) mergedSessions.set(s.sessionId, s);
  const file: NightlySessionStatsFile = {
    generatedAt: iso(ctx.at),
    runId: run.runId,
    projectId: run.projectId,
    date: run.date,
    sessions: [...mergedSessions.values()],
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
 // 分账:pull-traces 是纯确定性统计,零 LLM——事件数报 workUnits 轨,
 // tokens 报 0(旧实现把 eventsRead 计入 tokens,219120 事件顶穿 200k 混用上限→1597 paused 1/7)。
  tokens: 0,
  workUnits: eventsRead,
  artifactRef: artifactRef(run.projectId, run.date, ".session-stats.json"),
  note: `sessions=${sessions.length} events=${eventsRead} badLines=${eventsSkipped} dedupRows=${dedupRows}(workUnits=事件数,非LLM计费;token=0) ${geneNote}`,
  };
}

/**
 * C:journal 里哪些会话出现过开工基因行标记。
 * 修正:gene.brief.shown 是 kind=custom → CROSS_SESSION_KINDS 路由到 **global.jsonl**
 * (不写会话文件)。旧实现只读会话文件,永远 false(上轮「ProxyJournal 丢失」误报的根因)。
 * 修正(单步卡 16 分钟的真因):旧实现对**每个会话**都整读一遍 97MB global.jsonl
 * (9p 盘 5-10s × 200 会话)。改为 global.jsonl **只读一遍**,一次提取 sessionId 集合;
 * 会话文件里的标记由 parseSessionFile 顺带识别(geneBriefShown),两者取或即旧口径。
 */
function readGeneBriefSessions(journalDir: string): { shown: Set<string>; held: Set<string> } {
  const shown = new Set<string>();
  const held = new Set<string>();
  try {
    const text = readFileSync(join(journalDir, "global.jsonl"), "utf8");
    for (const line of text.split(/\r?\n/)) {
 // 一遍扫两类标记(shown=处理臂 / held=对照臂;不含任一即跳过。
      const isShown = line.includes("gene.brief.shown");
      const isHeld = !isShown && line.includes("gene.brief.held");
      if (!isShown && !isHeld) continue;
      const event = asRecord(readJsonLine(line));
      const payload = asRecord(event?.payload);
      const type = asString(payload?.type);
      if (type !== "gene.brief.shown" && type !== "gene.brief.held") continue;
      const sessionId = asString(event?.sessionId) !== "" ? asString(event?.sessionId) : asString(payload?.sessionId);
      if (sessionId === "") continue;
      (type === "gene.brief.shown" ? shown : held).add(sessionId);
    }
  } catch { /* global.jsonl 不可读:按无标记处理 */ }
  return { shown, held };
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
  return { run: ctx.run, codes: [], tokens: 0, workUnits: 1, note: `candidates=${candidates.length}` };
}

/**
 * 形态检出 → 候选队列(§11 P1#8 干预路由消费面 v1):
 * pathology 的 matched 此前只落台账/notes,零消费者——检出后不路由=「看见了但不行动」。
 * 本函数把每个形态映射成夜间候选(tip 许可→tip;协调族→gate;其余→tool),交给既有
 * 队列消费器(experiment-settler 能翻译的翻译成实验,翻译不了的留队给 agent 机制)。
 * id 按 formId 稳定:14 天已消费闸天然防重复入队。
 */
export function pathologyRouteCandidates(
  matched: Array<{ formId?: unknown; family?: unknown; carriers?: unknown; tipAllowed?: unknown }>,
  at: number,
): NightlyCandidate[] {
  const out: NightlyCandidate[] = [];
  const seen = new Set<string>();
  const isoAt = new Date(at).toISOString();
  for (const item of matched) {
    const formId = typeof item?.formId === "string" ? item.formId.trim() : "";
    if (formId === "" || seen.has(formId)) continue; // 同表单条(队列按 formId 稳定 id)
    seen.add(formId);
    const family = typeof item?.family === "string" ? item.family.trim() : "unknown";
    const carriers = Array.isArray(item?.carriers)
      ? item.carriers.filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.trim())
      : [];
    const tipAllowed = item?.tipAllowed === true;
    const kind: NightlyCandidate["kind"] = tipAllowed ? "tip" : family === "coordination" ? "gate" : "tool";
    out.push({
      id: `cand-pathology-${formId}`,
      kind,
      ref: formId,
      reason: `形态检出 ${formId}(${family}):协议载体 ${carriers.join("/") || "未列"};注入许可=${tipAllowed ? "是" : "否"}`,
      evidenceRefs: [`pathology:${isoAt}`, `form:${formId}`, ...carriers.map((c) => `carrier:${c}`)],
    });
  }
  return out;
}

function stepUpdateGraph(ctx: StepContext): StepOutcome {
  const { paths, run } = ctx;
  let goalsNote = "goals=skipped"; // 函数级声明(goal 晋升在 refresh 前使用)
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
 // 修4(机制发现「证据图数据源自始为空」「候选滞留无提升路径」):
 // update-graph 只写 pending 文件、graph.jsonl 从未被写入——证据图是一张空表。
 // 现在直接把候选落进 graph(用 addEvidence,幂等:同 kind+statement+observedAt 跳过)。
  let graphNote = "graph=skipped";
  try {
    let added = 0;
    let skipped = 0;
    for (const cand of candidates) {
      const input = {
        kind: "fact" as const,
        statement: `${cand.reason}(候选 ${cand.id})`,
        source: { note: `nightly ${run.runId} 挖掘` },
        observedAt: ctx.at,
        projectId: run.projectId,
      };
      const r = addEvidence(ctx.root, input);
      if (r.ok) added += 1;
      else if (r.code === "EVIDENCE_DUPLICATE") skipped += 1;
    }
    graphNote = `graph: added=${added} dup=${skipped}`;
  } catch {
    graphNote = "graph=error(不阻塞本步)";
  }
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
    const rework = detectReworkChains(ctx.root, run.projectId, { journalDir: ctx.journalDir, windowDays: 14, now: ctx.at, readWriteHunks: readWriteHunksOf(ctx.journalDir) });
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
 // 回放验证:把基因提示放回历史 build 开工时刻,读注入臂精确率(leave-one-out)。
  let replayNote = "geneReplay=skipped";
  try {
    replayNote = renderReplayNote(runGeneReplay(ctx.root, run.projectId, ctx.journalDir));
  } catch {
    replayNote = "geneReplay=error(不阻塞本步)";
  }

  let atlasNote = "atlas=skipped";
  let harvestedThemes: Array<{ id: string; sessions: number; titles?: string[] }> = [];
  try {
    const refreshed = refreshAtlasSnapshot(ctx.root, run.projectId, { journalDir: ctx.journalDir, windowDays: 7, reworkSummary });
    atlasNote = refreshed.ok
      ? `atlas: themes=${refreshed.harvest?.themes.length ?? 0} modules=${refreshed.harvest?.moduleActivity.length ?? 0} rework=${refreshed.harvest?.reworkSignals.length ?? 0} noise=${refreshed.harvest?.noiseSessions ?? 0}`
      : `atlas=${refreshed.code ?? "error"}(不阻塞本步)`;
    harvestedThemes = refreshed.harvest?.themes ?? [];
  } catch {
    atlasNote = "atlas=error(不阻塞本步)";
  }
 // 项目级世界模型:同一批会话按项目归因后,为注册表里的其它项目各写一份 atlas 快照
 // (夜间管线原本只产出安装根一份)。会话只解析一次(returnAll),按 uuid/编辑路径分组;
 // 每个项目快照带自己的主题/热点/返工信号/重复探索,面板「世界模型」抽屉按项目展示。
  let projectsNote = "projects=skipped";
  try {
    const registry = loadProjectRegistry(ctx.journalDir);
    const byKey = new Map<string, { key: string; ids: string[]; root: string }>();
    for (const entry of registry) {
      const key = basename(entry.path.replace(/\\/g, "/").replace(/\/+$/, ""));
      if (key === "") continue;
      const item = byKey.get(key) ?? { key, ids: [], root: entry.path };
      item.ids.push(entry.id);
 // legacy 会话绑定的是 label(生产注意:26 个会话 projectId="harness",注册表 id 是
 // __harness__)——label 也进别名,否则这批会话只能靠路径兜底。
      if (entry.label !== "" && entry.label !== entry.id && !item.ids.includes(entry.label)) item.ids.push(entry.label);
      byKey.set(key, item);
    }
    const allProjects = [...byKey.values()];
    const others = allProjects.filter((p) => p.key !== run.projectId);
    if (allProjects.length > 0) {
      const all = collectWorkSessions(ctx.journalDir, { windowDays: 7, now: ctx.at, returnAll: true, projectRoots: loadProjectRoots(ctx.journalDir) });
 // 分组要拿全量项目(含安装根):相对路径 `lampgenie-harness/apps/...` 既要能按 basename
 // 命中子项目,也要避免落入父目录的存在性锚点(深根优先由 groupSessionsByProject 保证)。
      const grouped = groupSessionsByProject(all.sessions, allProjects, run.projectId);
      const written: string[] = [];
      for (const project of others) {
        const scoped = grouped.get(project.key) ?? [];
        if (scoped.length === 0) continue; // 无该项目的会话:不造假快照(面板显示暂无)
        const refreshed = refreshAtlasSnapshot(ctx.root, project.key, {
          journalDir: ctx.journalDir,
          windowDays: 7,
          sessionsOverride: scoped,
          enrichRoot: project.root,
        });
        if (refreshed.ok) written.push(`${project.key}(${scoped.length})`);
      }
      projectsNote = `projects=${written.length > 0 ? written.join(",") : "0"}`;
    } else {
      projectsNote = "projects=0";
    }
  } catch {
    projectsNote = "projects=error(不阻塞本步)";
  }
 // E:curated 目标层生产者 → proposed-goals.json + 自动晋升(≥5 会话)
  try {
    const themes = harvestedThemes;
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
 // curated 目标层自动晋升:主题簇 ≥5 会话 → 直接 addGoal 进 entries.jsonl
 // (设想「curated 层不该是手播一次就停」;阈值 5 = 单例不成规的最低限,防止噪声主题进图)。
 // 幂等:同 id 的 goal 已在快照里 → 跳过(addGoal 本身也去重)。
    const PROMOTE_MIN_SESSIONS = 5;
    let promoted = 0;
    let existingGoalIds = new Set<string>();
    try {
      const snapForIds = JSON.parse(readFileSync(join(ctx.root, ".genie", "rsi", "atlas", `${run.projectId}.json`), "utf8")) as { goals?: Array<{ id: string }> };
      existingGoalIds = new Set((snapForIds?.goals ?? []).map((g) => g.id));
    } catch { /* 快照不可读 → 空 set */ }
    for (const pg of goals) {
      if (pg.sessions < PROMOTE_MIN_SESSIONS) continue;
      if (existingGoalIds.has(pg.id)) continue;
      try {
        addGoal(ctx.root, run.projectId, {
          id: pg.id,
          title: `主题「${pg.theme}」(${pg.sessions} 会话在近期活跃)`,
          status: "active",
          since: iso(ctx.at),
          evidenceRefs: [`proposed-goals:${pg.id}`],
          detail: `自动晋升:主题簇 ${pg.sessions} 会话(阈值 ${PROMOTE_MIN_SESSIONS})。理由:${pg.reason.slice(0, 120)}`,
        });
        promoted += 1;
      } catch { /* 单条失败不影响其它 */ }
    }
    if (promoted > 0) {
      goalsNote += ` promoted=${promoted}`;
 // 晋升后把新 goal 合入快照(refresh 在前面已跑,快照缺新 goal;
 // 不重 build——直接读快照→追加 goal→写回,保留 derived 层)
      try {
        const snapPath = join(ctx.root, ".genie", "rsi", "atlas", `${run.projectId}.json`);
        const snap = JSON.parse(readFileSync(snapPath, "utf8")) as { goals?: unknown[] };
        const newGoals = goals.filter((pg) => pg.sessions >= PROMOTE_MIN_SESSIONS && !existingGoalIds.has(pg.id))
          .map((pg) => ({ id: pg.id, title: `主题「${pg.theme}」(${pg.sessions} 会话在近期活跃)`, status: "active", since: iso(ctx.at), evidenceRefs: [`proposed-goals:${pg.id}`] }));
        snap.goals = [...(snap.goals ?? []), ...newGoals];
        writeJsonAtomic(snapPath, snap);
      } catch { /* 快照更新失败不影响 */ }
    }
  } catch {
    goalsNote = "goals=error(不阻塞本步)";
  }
 // (S3 种子):STOPWORDS 历史晋升回收(判据与幂等见 demoteStopwordAbsorbedGoals 注释)。
  try {
    const demoted = demoteStopwordAbsorbedGoals(ctx.root, run.projectId);
    if (demoted > 0) goalsNote += ` demoted=${demoted}`;
  } catch { /* 回收失败不阻塞本步 */ }
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
  

 // F:cohort 同批采集器 —— build 类会话登记 delivery、返工链 fixSession 登记 fix;
 // 落盘走 cohort-metrics-store 的既有真源 .genie/rsi/cohort.jsonl;id 确定性 → 重跑幂等(重复 id 拒收)。
  let cohortNote = "cohort=skipped";
  try {
    const ledger = readReworkChains(ctx.root);
    const fixClass = new Map<string, string | undefined>();
 // P1-③:fix 会话 → 源返工链(取 buildSession 做显式回链)。
    const fixChain = new Map<string, { buildSession: string }>();
    for (const c of ledger.chains) {
      fixClass.set(c.fixSession, c.defectClass);
      if (!fixChain.has(c.fixSession)) fixChain.set(c.fixSession, { buildSession: c.buildSession });
    }
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
 // P1-③:补指标字段(changeNodes=编辑面规模)+显式回链——buildSession 的交付 id
 // (机制注意「9 条 fix 无对应 delivery」的解法:显式 relatedDeliveryId 优先于窗口兜底)。
        const chain = fixChain.get(session.sessionId);
        const relatedDeliveryId = chain !== undefined ? findDeliveryIdByTaskId(ctx.root, chain.buildSession) : undefined;
        const r = recordFix(ctx.root, {
          id: `${idBase}:fix`,
          taskId: session.sessionId,
          module,
          at: session.mtimeMs,
          foundAt: "nightly",
          ...(cls !== undefined ? { defectClass: cls } : {}),
          changeNodes: session.editedPaths?.length ?? 0,
          ...(relatedDeliveryId !== undefined ? { relatedDeliveryId } : {}),
        });
        if (r.ok) fixes += 1;
        else if (r.code === "COHORT_DUPLICATE") dup += 1;
      } else if (!FIX_TITLE_RE.test(session.title)) {
 // P1-③:taskClass 用轻量标题启发(不再硬编码 unknown;isQuestion→qa,办公词→office,
 // 其余 coding)+changeNodes(编辑面规模)——机制注意「101 条无指标字段、同批指标算不出」。
        const taskClass = session.isQuestion === true
          ? "qa"
          : /ppt|pptx|表格|xlsx|文档|docx|汇报|报告|pdf/i.test(session.title)
            ? "office"
            : "coding";
        const r = recordDelivery(ctx.root, {
          id: `${idBase}:delivery`,
          taskId: session.sessionId,
          module,
          taskClass,
          boardType: "unknown",
          at: session.mtimeMs,
          changeNodes: session.editedPaths?.length ?? 0,
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
 // P3:rework-chain 的重入会话也喂给 pathology(re-entry 原语的信号源——
 // 同一文件被 build 和 fix 两个会话编辑 = 重入;此前只喂 collectWorkSessions 的编辑面)
    const reworkLedger = readReworkChains(ctx.root);
    const reworkSessions = reworkLedger.chains.map((c) => ({ id: c.fixSession, files: [c.path] }));
    const allSessions = [
      ...work.sessions.map((s) => ({ id: s.sessionId, files: s.editedPaths })),
      ...reworkSessions,
    ];
    const detected = detect(
      ctx.root,
      {
        sessions: allSessions,
        ...(changeNodes.length > 0 ? { changeNodes } : {}),
      },
      { at: ctx.at },
    );
 // 干预路由消费面:形态 → 候选队列;id 按 formId 稳定,14 天已消费闸防重。
    const routed = pathologyRouteCandidates(detected.matched, ctx.at);
    if (routed.length > 0) {
      const merged = addCandidates(ctx.run, routed);
      ctx.run = merged.run;
      appendQueue(paths.queueFile, ctx.run, ctx.at);
    }
    pathologyNote = `pathology: matched=${detected.matched.length} candidates=${detected.candidates.length} re-entry=${detected.primitives["re-entry"]?.count ?? 0} routed=${routed.length}`;
  } catch {
    pathologyNote = "pathology=error(不阻塞本步)";
  }
  return {
    run: ctx.run,
    codes: [],
 // 分账:七步全为确定性步(设计 13-trigger-and-flow §1.1「零 LLM」),
 // 事件/处理量计 workUnits,token 轨恒 0——LLM 成本只看 cost.jsonl 与机制 agent run。
    tokens: 0,
    artifactRef: artifactRef(run.projectId, run.date, ".evidence-pending.json"),
    note: `pendingReview=${candidates.length} ${decayNote} ${atlasNote} ${projectsNote} ${goalsNote} ${cohortNote} ${pathologyNote} ${reworkNote}`,
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

/** distill-experiences(v2 新步, W2):确定性准备蒸馏输入(会话池 + 候选引用),零 LLM。
 * 真正的「可复用做法/坑」提炼由 nightly 机制 agent 按 brief 的经验蒸馏小节执行,
 * settle 收尾时经 rsi-experience-gate 质量门折叠进经验库(每晚 ≤5,幂等恰好一次)。 */
function stepDistillExperiences(ctx: StepContext): StepOutcome {
  const { paths, run, selection } = ctx;
  const sessions = (Array.isArray(selection.sessions) ? selection.sessions : [])
    .map((entry) => entry.sessionId)
    .filter((id): id is string => typeof id === "string" && id !== "");
  const file = join(paths.projectDir, `${run.date}.distill-input.json`);
  writeJsonAtomic(file, {
    runId: run.runId,
    projectId: run.projectId,
    date: run.date,
    at: iso(ctx.at),
    sessions,
    candidateRefs: run.candidates.map((candidate) => candidate.id),
    note: "可复用经验蒸馏由 nightly 机制 agent 按 brief 执行;settle 时质量门折叠入库(每晚 ≤5)。",
  });
  return {
    run: ctx.run,
    codes: [],
    tokens: 0,
    artifactRef: artifactRef(run.projectId, run.date, ".distill-input.json"),
    note: `distill-input sessions=${sessions.length}(委托 nightly 机制 agent + settle 折叠)`,
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
    case "distill-experiences":
      return stepDistillExperiences(ctx);
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
 // v1 六步旧记录兼容加载(v2 七步):缺步补 pending,不 throw、不改已终局状态。
  return migrateRunSteps(run);
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
 // P0-1(机制审计「11-16 记录倒置窗口已 done,真跑会被跳过」):同日 done 不再
 // 无条件跳过——游标之后仍有新会话(当日被提前跑过,如凌晨时区倒置创建的 run)时,以增量
 // 游标续跑本日;已无新会话才真跳过。续跑覆盖单日 run 报表属预期,session-stats 按
 // sessionId 合并不丢早程数据(pull-traces 同批修)。
    const projectId = options.projectId.trim();
    const cursorNow = readCursorFile(paths.cursorFile)[projectId] ?? {};
 // P0-②:hasFresh 用 eligible 口径(噪声/超体量不算「值得续跑的新会话」)。
    const hasFresh = enumerateSessions(options.journalDir).some(
      (entry) =>
        (typeof cursorNow.lastMtimeMs === "number" ? entry.mtimeMs > cursorNow.lastMtimeMs : true) &&
        !SELECTION_NOISE_RE.test(entry.sessionId) &&
        !(typeof entry.sizeBytes === "number" && entry.sizeBytes > MAX_SESSION_BYTES),
    );
    if (!hasFresh) return { run: existing, codes: [NIGHTLY_CODES.NIGHTLY_SKIPPED_DONE] };
  }

  const cursor = readCursorFile(paths.cursorFile)[options.projectId] ?? {};
  const maxSessions = normaliseLimit(options.maxSessions, DEFAULT_MAX_SESSIONS);
  const all = enumerateSessions(options.journalDir);
  const fresh = all.filter((entry) =>
    typeof cursor.lastMtimeMs === "number" ? entry.mtimeMs > cursor.lastMtimeMs : true,
  );
 // P0-②选择期过滤:噪声会话与超大文件不再消耗 maxSessions 预算、不再进
 // pull-traces(旧实现在 denoise 才滤噪声、体量无闸——注意:巨型会话把 worker 卡到超时)。
  const noiseSkipped: string[] = [];
  const oversized: Array<{ sessionId: string; sizeBytes: number }> = [];
  const eligible = fresh.filter((entry) => {
    if (SELECTION_NOISE_RE.test(entry.sessionId)) {
      noiseSkipped.push(entry.sessionId);
      return false;
    }
    if (typeof entry.sizeBytes === "number" && entry.sizeBytes > MAX_SESSION_BYTES) {
      oversized.push({ sessionId: entry.sessionId, sizeBytes: entry.sizeBytes });
      return false;
    }
    return true;
  });
 // 修3(提案「夜间只读最旧200,当日会话全进积压」):选择改**新到旧**——
 // 旧实现升序取前 N=最旧200,当日新会话排到 unselected 里积压。反转后最新200 优先,
 // 游标推进到选中集的最旧(未选的旧会话不会因此永远跳过——maxSessions 截断仍在
 // unselected 诚实入账,只是优先看新的)。
  const newestFirst = [...eligible].reverse();
  const selected = newestFirst.slice(0, maxSessions);
 // 覆盖口径:被 maxSessions 截断的会话不再被「窗口判完成」的报表口径吞掉——
 // 快照进 selection.unselected,收尾时入 unprocessed,报表如实说「尾部未读」。
  const unselected = newestFirst.slice(maxSessions);

  const config: NightlyConfig = { ...(options.config ?? {}) };
  if (options.onlineBusy === true) config.onlineBusy = true;
  const started = startRun({ date: options.date, projectId: options.projectId.trim(), now, config });
  if (!started.run) return { run: null, codes: started.codes };
  if (started.run.status === "skipped") return { run: started.run, codes: started.codes };

  const last = lastEntry(selected);
 // sessionsTotal=本轮**符合增量条件的会话总数**(不是被截断后的 selected 数):
 // 「14/14 覆盖」只在真读了 14 个时才成立( findings 注意窗口内 3 会话未读却报满)。
 // P0-②:sessionsTotal 用 eligible 口径(噪声/超体量已出局)——分母=真正会被处理的会话数,
 // 否则「4/5 覆盖」里那 1 个永远读不到的噪声会话让覆盖率永远虚低。
  let run = recordCoverage(started.run, { coverage: { sessionsTotal: eligible.length }, at: now });
 // (机制审计「水位空转」):start 不预写 run.cursor —— 此时 coverage 仍为 0,
 // 写进去会让 run 文件呈现「水位已推进但覆盖 0」,读者误判为已读。真水位只在 runNightly 收尾
 // (finalizeRun + advanceCursor 写 cursor.json)推进;selection 文件保留 lastSessionId/lastMtimeMs
 // 作本轮增量边界,两者语义不再混用。

  const selection: NightlySelectionFile = {
    runId: run.runId,
    projectId: run.projectId,
    date: run.date,
    selectedAt: iso(now),
    sessions: selected,
    ...(unselected.length > 0 ? { unselected } : {}),
 // P0-②:选择期过滤与游标取证(11-17 卡位游标疑云——快照记下实际使用的游标值,可回查)。
    ...(noiseSkipped.length > 0 ? { noiseSkipped } : {}),
    ...(oversized.length > 0 ? { oversized } : {}),
    cursorUsed: { ...(typeof cursor.lastMtimeMs === "number" ? { lastMtimeMs: cursor.lastMtimeMs } : {}) },
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
 * 七步全 done/skipped → finalizeRun + 前移 cursor.json。
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
 // (机制审计「进度不可观测」):执行**之前**先把步骤标 running 并落盘——
 // pull-traces 首次要跑十几分钟,旧实现期间 run 恒为 status=pending、七步全 pending,
 // sys_rsi 把在跑的 run 误判成停摆。markStep(running) 只把 run.status pending→running,
 // 不会让 run 提前终态。
    const started = markStep(run, { name: step.name, status: "running", at });
    run = started.run;
    writeJsonAtomic(paths.runFile, run);
    codes.push(...started.codes);
    options.onStepStart?.(step.name, run);
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
 // 失败原因同时落在 run 上(不只看 step.error),报表/体检都能读到「为什么失败」。
      run = { ...failed.run, error: message };
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
      ...(outcome.workUnits === undefined ? {} : { workUnits: outcome.workUnits }),
      artifactRef: outcome.artifactRef,
      note: outcome.note,
      at,
    });
    run = marked.run;
    writeJsonAtomic(paths.runFile, run);
    codes.push(...marked.codes);
 // 水位:pull-traces 步 done 即把 cursor 前移到已拉取水位——预算暂停的 run
 // 下一次增量从已读之后开始(旧实现只在七步全 done 后 advanceCursor,paused 1/7 重跑
 // =22 万事件全量重读);selection 快照仍在,本 run 续跑走步状态机不重拉。
    if (step.name === "pull-traces" && marked.run.status !== "failed") {
      advanceCursor(paths.cursorFile, run.projectId, selection);
    }
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
 // 水位只在真正收尾时落 run 文件(= 已消费到的会话边界),开工预写已删除。
      const finalizedCursor =
        selection.lastSessionId !== undefined && typeof selection.lastMtimeMs === "number"
          ? { lastSessionId: selection.lastSessionId, lastMtimeMs: selection.lastMtimeMs }
          : {};
      run = {
        ...finalized.run,
        cursor: finalizedCursor,
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

/** 陈旧 run 判定阈值:run.updatedAt 距今超过它即认为进程已死(默认 30min)。 */
export const DEFAULT_NIGHTLY_STALE_MS = 30 * 60 * 1000;

/** worker 互斥锁 TTL:锁里的 at 距今超过它即视为陈旧可接管(默认 20min)。 */
export const DEFAULT_NIGHTLY_LOCK_TTL_MS = 20 * 60 * 1000;

/** 锁文件名(每个 project 目录一个)。 */
export const NIGHTLY_LOCK_FILE = ".worker.lock";

export interface ReclaimNightlyOptions {
  projectId: string;
  date: string;
  journalDir: string;
 /** epoch ms。 */
  now?: number;
 /** run.updatedAt 距今 <= staleMs 视为在跑(默认 DEFAULT_NIGHTLY_STALE_MS)。 */
  staleMs?: number;
  maxSessions?: number;
}

export interface ReclaimNightlyResult {
 /** none=无 run 或已终态;live=仍在跑;其余为回收后 run 的终态。 */
  status: "none" | "live" | NightlyRun["status"];
  run: NightlyRun | null;
  note: string;
}

/**
 * 陈旧 run 回收(机制审计):
 * - 当日无 run / 已终态 → {status:"none"}(不动文件);
 * - updatedAt 距 now <= staleMs → {status:"live"}(在跑,不抢);
 * - 否则把残留 running 步骤退回 pending(resetStalledRun)后续跑 runNightly;
 * 续跑抛错或仍未终态 → 落 status="failed" + error 可见(report 里也有一行),不再无限挂起。
 * 返回回收后的终态。
 */
export async function reclaimNightly(
  root: string,
  options: ReclaimNightlyOptions,
): Promise<ReclaimNightlyResult> {
  if (!options || typeof options.projectId !== "string" || options.projectId.trim() === "") {
    throw new Error("reclaimNightly 缺少 projectId");
  }
  if (typeof options.journalDir !== "string" || options.journalDir === "") {
    throw new Error("reclaimNightly 缺少 journalDir");
  }
  const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
  const staleMs =
    typeof options.staleMs === "number" && Number.isFinite(options.staleMs) && options.staleMs > 0
      ? options.staleMs
      : DEFAULT_NIGHTLY_STALE_MS;
  const paths = nightlyPaths(root, options.projectId, options.date);
  const run = loadRunFromFile(paths);
  if (!run) return { status: "none", run: null, note: `无当日 run: ${options.projectId}/${options.date}` };
  if (terminalCode(run) !== null) {
    return { status: "none", run, note: `run 已终态(${run.status}):无需回收` };
  }
  const updatedMs = Date.parse(run.updatedAt);
  const idleMs = Number.isFinite(updatedMs) ? now - updatedMs : Number.POSITIVE_INFINITY;
  if (idleMs <= staleMs) {
    return {
      status: "live",
      run,
      note: `run 仍在跑(updatedAt 距今 ${Math.max(0, Math.round(idleMs / 1000))}s <= ${Math.round(staleMs / 1000)}s)`,
    };
  }

 // 残留 running 步骤先退回 pending,否则 nextStep 看不到它、续跑会立刻「无步可跑」。
  let current = resetStalledRun(run, { at: now }).run;
  writeJsonAtomic(paths.runFile, current);
  let failure = "";
  try {
    const resumed = await runNightly(root, {
      runId: { projectId: options.projectId, date: options.date },
      journalDir: options.journalDir,
      maxSessions: options.maxSessions,
      now: now + 1,
    });
    current = resumed.run;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (failure !== "" || terminalCode(current) === null) {
    const failed = failRun(current, {
      at: now + 2,
      error: failure !== "" ? `reclaim 续跑抛错: ${failure}` : `reclaim 续跑后仍未终态(status=${current.status})`,
    });
    current = failed.run;
    writeJsonAtomic(paths.runFile, current);
    return { status: "failed", run: current, note: `回收失败: ${current.error ?? ""}` };
  }
  return { status: current.status, run: current, note: `回收后 status=${current.status}` };
}

export interface NightlyLockInfo {
  pid: number;
 /** epoch ms(锁写入时刻)。 */
  at: number;
}

export interface NightlyLockOptions {
 /** epoch ms。 */
  now?: number;
  ttlMs?: number;
}

export interface NightlyLockState {
  held: boolean;
  lock: NightlyLockInfo | null;
}

export interface AcquireNightlyLockOptions extends NightlyLockOptions {
 /** 缺省 process.pid。 */
  pid?: number;
}

export interface AcquireNightlyLockResult {
  acquired: boolean;
  lock: NightlyLockInfo;
 /** 被别的活进程持有时为持有者信息,否则 null。 */
  holder: NightlyLockInfo | null;
}

/** `<root>/.genie/rsi/nightly/<project>/.worker.lock`。 */
export function nightlyLockFile(root: string, projectId: string): string {
  return join(root, NIGHTLY_DIR, projectId, NIGHTLY_LOCK_FILE);
}

function readLockInfo(file: string): NightlyLockInfo | null {
  const raw = readJson<Record<string, unknown>>(file);
  if (!raw) return null;
  const pid = typeof raw.pid === "number" && Number.isFinite(raw.pid) ? Math.trunc(raw.pid) : 0;
  const atRaw = raw.at;
  const at =
    typeof atRaw === "number" && Number.isFinite(atRaw)
      ? Math.trunc(atRaw)
      : typeof atRaw === "string"
        ? Date.parse(atRaw)
        : Number.NaN;
  if (!Number.isFinite(at)) return null;
  return { pid, at };
}

function resolveLockClock(options?: NightlyLockOptions): { now: number; ttlMs: number } {
  const now =
    typeof options?.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
  const ttlMs =
    typeof options?.ttlMs === "number" && Number.isFinite(options.ttlMs) && options.ttlMs > 0
      ? options.ttlMs
      : DEFAULT_NIGHTLY_LOCK_TTL_MS;
  return { now, ttlMs };
}

/** 锁存在且 at 距今 < ttlMs → held(陈旧锁返回 held:false + 锁信息,便于调用方接管)。 */
export function nightlyLockHeld(
  root: string,
  projectId: string,
  options?: NightlyLockOptions,
): NightlyLockState {
  const { now, ttlMs } = resolveLockClock(options);
  const lock = readLockInfo(nightlyLockFile(root, projectId));
  if (!lock) return { held: false, lock: null };
  return { held: now - lock.at < ttlMs, lock };
}

/** 抢锁:被活进程持有则 acquired:false(不改文件);锁陈旧则接管覆盖。 */
export function acquireNightlyLock(
  root: string,
  projectId: string,
  options?: AcquireNightlyLockOptions,
): AcquireNightlyLockResult {
  const { now, ttlMs } = resolveLockClock(options);
  const pid =
    typeof options?.pid === "number" && Number.isFinite(options.pid) ? Math.trunc(options.pid) : process.pid;
  const lock: NightlyLockInfo = { pid, at: now };
  const state = nightlyLockHeld(root, projectId, { now, ttlMs });
  if (state.held) return { acquired: false, lock, holder: state.lock };
  writeJsonAtomic(nightlyLockFile(root, projectId), lock);
  return { acquired: true, lock, holder: null };
}

/** 放锁:给了 pid 时只放自己持有的锁(避免误删别人接管后的锁)。 */
export function releaseNightlyLock(root: string, projectId: string, options?: { pid?: number }): boolean {
  const file = nightlyLockFile(root, projectId);
  const lock = readLockInfo(file);
  if (!lock) return false;
  if (typeof options?.pid === "number" && Number.isFinite(options.pid) && lock.pid !== Math.trunc(options.pid)) {
    return false;
  }
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
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
  options: PauseNightlyOptions,
): Promise<{ run: NightlyRun | null; codes: NightlyCode[] }> {
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

/** 越支的 run 续跑前需要抬高上限(理由见 resumeNightly 注释)。双轨各自抬高。 */
function withBudgetHeadroom(run: NightlyRun): NightlyRun {
  const { tokens, maxTokens } = run.budget;
  const workUnits = typeof run.budget.workUnits === "number" ? run.budget.workUnits : 0;
  const maxWorkUnits = run.budget.maxWorkUnits ?? DEFAULT_MAX_WORK_UNITS;
  if (tokens <= maxTokens && workUnits <= maxWorkUnits) return run;
  return {
    ...run,
    budget: {
      tokens,
      maxTokens: tokens > maxTokens ? Math.max(tokens * 2, tokens + 1) : maxTokens,
      workUnits,
      maxWorkUnits: workUnits > maxWorkUnits ? Math.max(workUnits * 2, workUnits + 1) : maxWorkUnits,
    },
  };
}

/** 手工收尾(七步都 done/skipped 才允许)。 */
export async function finalizeNightly(
  root: string,
  options: FinalizeNightlyOptions,
): Promise<{ run: NightlyRun | null; codes: NightlyCode[] }> {
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

/**
 * (S3 种子):STOPWORDS 历史晋升回收——停用词扩容后,历史已晋升主题的
 * 关键词可能全部被吸收(如 missing/implemented 类样板词簇),却仍占 active 席位与简报位。
 * 判据:goal id 内嵌的 theme 段(`pg:<project>:<theme>` 第三段起)而非标题全串——addGoal
 * 的标题含固定 wrapper(「主题」「会话在近期活跃」等非停用词),按标题判恒不中。只回收 pg:
 * 前缀(主题晋升产物),人工 goal 不动;goal 载荷无 origin 字段是已知局限(§07 决策 12),
 * pg: 前缀即身份标记。幂等:closeGoal 对已关 goal 返回 idempotent 不追加第二行;
 * append-only——不删不改历史行,只追加 goal_close 事件(reason=stopword-absorbed)。
 * @returns 本次实际回收数(幂等重跑返回 0)
 */
export function demoteStopwordAbsorbedGoals(root: string, projectId: string): number {
  const snapPath = join(root, ".genie", "rsi", "atlas", `${projectId}.json`);
  const snap = JSON.parse(readFileSync(snapPath, "utf8")) as { goals?: Array<{ id: string; status?: string }> };
  let demoted = 0;
  for (const g of snap.goals ?? []) {
    if (g.status !== "active" || !g.id.startsWith("pg:")) continue;
    const theme = g.id.split(":").slice(2).join(":");
    if (theme === "" || !isAllStopwords(theme)) continue;
    const res = closeGoal(root, projectId, {
      goalId: g.id,
      status: "abandoned",
      reason: "stopword-absorbed: 主题关键词全部被停用词吸收(2026-11-17 扩容后),不再代表开发方向",
      evidence: [`atlas-snapshot:${g.id}`],
      by: "rsi-nightly",
    });
    if (res.ok && res.idempotent !== true) demoted += 1; // 幂等重放(idempotent)不计入本次回收数
  }
  return demoted;
}
