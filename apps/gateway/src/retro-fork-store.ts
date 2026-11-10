/**
 * 后台复盘 fork 的持久层(gateway 侧):把 retrospective-fork 的纯逻辑落到 append-only 台账。
 * 为什么 append-only:`event / trigger / fork / artifact / done` 都是审计事实(哪一轮因何触发、
 * fork 拿到了什么规格、写进了哪条洞察),后来的写入不能覆盖或抹掉历史;每行追加后重读文件
 * 统计非空行数做写后校验,让「写成功了吗」成为可复核的断言而不是「appendFileSync 没抛异常」。
 * 数据面:`<root>/.genie/rsi/retro.jsonl`,每行 `{"v":1,"type":...,"sessionId":...,"at":ISO}`
 * - `event{kind}` —— user-turn / tool-iteration / final-response / interrupt / cron(计数与跳过口径)。
 * - `state{nudge?,userTurns?,...}` —— 外部状态覆盖(被 nudge 拉起的会话等)。
 * - `trigger{reason,codes}` —— 一次触发判定(只观测,不改变计数)。
 * - `fork{spec}` —— fork 规格落盘;恢复时 depth/nudge 从规格取,故嵌套复盘被 SKIPPED_DEPTH 挡住。
 * - `artifact{artifact}` —— 证据图输入;幂等键 `retro:<session>:<retroCount>` 去重。
 * - `done` —— 复盘完成(计数清零、retroCount+1)。
 * 投影语义:按行序折叠单个 sessionId 的状态;坏行(JSON 坏 / 未知 type / 缺 sessionId)只计入
 * badLines 并跳过 —— 一行坏不整文件失效、不 throw。参数错误是本层唯一允许的拒绝(稳定码 INVALID)。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  RETRO_CODES,
  buildForkSpec,
  emptyRetroState,
  isRetroEventKind,
  markRetroDone,
  retroArtifact,
  shouldTrigger,
  updateState,
} from "@lampgenie/runtime/agent/retrospective-fork";
import type {
  RetroArtifact,
  RetroEventKind,
  RetroForkParent,
  RetroForkSpec,
  RetroPolicy,
  RetroState,
} from "@lampgenie/runtime/agent/retrospective-fork";

/** 台账 schema 版本。 */
export const RETRO_STORE_VERSION = 1;

/** 台账目录与文件名(相对仓根)。 */
export const RETRO_LEDGER_DIR = join(".genie", "rsi");
export const RETRO_LEDGER_FILE = "retro.jsonl";

/** store 层自产的失败码(runtime 码沿用 RETRO_CODES)。 */
export const RETRO_STORE_CODES = ["RETRO_LEDGER_WRITE_MISMATCH", "RETRO_STORE_ERROR"] as const;

export type RetroStoreCode = (typeof RETRO_STORE_CODES)[number];

export interface RetroPaths {
  dir: string;
  file: string;
}

/** 台账路径。 */
export function retroPaths(root: string): RetroPaths {
  const dir = join(root, RETRO_LEDGER_DIR);
  return { dir, file: join(dir, RETRO_LEDGER_FILE) };
}

interface RetroRow {
  v?: number;
  type?: string;
  sessionId?: string;
  at?: string;
  kind?: string;
  reason?: string;
  codes?: string[];
  spec?: unknown;
  artifact?: unknown;
  nudge?: number;
  userTurns?: number;
  toolIterations?: number;
  retroCount?: number;
  depth?: number;
  lastRetroAt?: number;
}

export interface RetroLedgerRead {
  rows: RetroRow[];
  badLines: number;
  totalLines: number;
}

/** 读台账:坏行只计数不抛。 */
export function readRetroLedger(root: string): RetroLedgerRead {
  let text: string;
  try {
    text = readFileSync(retroPaths(root).file, "utf8");
  } catch {
    return { rows: [], badLines: 0, totalLines: 0 };
  }
  const rows: RetroRow[] = [];
  let badLines = 0;
  let totalLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    totalLines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      badLines += 1;
      continue;
    }
    const row = parsed as RetroRow;
    if (typeof row.type !== "string" || nonEmpty(row.sessionId) === undefined) {
      badLines += 1;
      continue;
    }
    rows.push(row);
  }
  return { rows, badLines, totalLines };
}

function countLines(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") n += 1;
  return n;
}

/** 追加一行并做写后行数校验:失败返回 false(调用方折叠成 RETRO_LEDGER_WRITE_MISMATCH)。 */
function appendLine(root: string, row: RetroRow): boolean {
  const { file } = retroPaths(root);
  const before = countLines(file);
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ v: RETRO_STORE_VERSION, ...row })}\n`, "utf8");
  } catch {
    return false;
  }
  return countLines(file) === before + 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function nonNegInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Math.floor(value) === value
    ? value
    : undefined;
}

function parseAt(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function isoAt(at: number | undefined): string {
  return new Date(at ?? Date.now()).toISOString();
}

/** 单会话投影:状态 + 计数 + 已写产物幂等键。 */
export interface RetroSessionProjection {
  state: RetroState;
  triggers: number;
  forks: number;
  artifacts: number;
  idempotencyKeys: Set<string>;
}

/** 从台账行折叠出某会话的投影(坏行已在 readRetroLedger 过滤)。 */
export function projectRetroSession(rows: RetroRow[], sessionId: string): RetroSessionProjection {
  let state = emptyRetroState();
  let triggers = 0;
  let forks = 0;
  let artifacts = 0;
  const idempotencyKeys = new Set<string>();
  for (const row of rows) {
    if (row.sessionId !== sessionId) continue;
    switch (row.type) {
      case "event": {
        if (isRetroEventKind(row.kind)) {
          state = updateState(state, { kind: row.kind, at: parseAt(row.at) });
        }
        break;
      }
      case "state": {
        const next: RetroState = { ...state };
        const userTurns = nonNegInt(row.userTurns);
        const toolIterations = nonNegInt(row.toolIterations);
        const retroCount = nonNegInt(row.retroCount);
        const nudge = nonNegInt(row.nudge);
        const depth = nonNegInt(row.depth);
        if (userTurns !== undefined) next.userTurns = userTurns;
        if (toolIterations !== undefined) next.toolIterations = toolIterations;
        if (retroCount !== undefined) next.retroCount = retroCount;
        if (nudge !== undefined) next.nudge = nudge;
        if (depth !== undefined) next.depth = depth;
        const lastRetroAt = parseAt(row.at);
        if (lastRetroAt !== undefined) next.lastRetroAt = lastRetroAt;
        state = next;
        break;
      }
      case "trigger":
        triggers += 1;
        break;
      case "fork": {
        forks += 1;
        const spec = isRecord(row.spec) ? row.spec : undefined;
        if (spec !== undefined) {
          const depth = nonNegInt(spec["depth"]);
          const nudge = nonNegInt(spec["nudge"]);
          if (depth !== undefined) state = { ...state, depth: Math.max(state.depth, depth) };
          if (nudge !== undefined) state = { ...state, nudge: Math.max(state.nudge, nudge) };
        }
        break;
      }
      case "artifact": {
        artifacts += 1;
        const artifact = isRecord(row.artifact) ? row.artifact : undefined;
        const key = nonEmpty(artifact?.["idempotencyKey"]);
        if (key !== undefined) idempotencyKeys.add(key);
        break;
      }
      case "done":
        state = markRetroDone(state, { at: parseAt(row.at) }).state;
        break;
      default:
        break;
    }
  }
  return { state, triggers, forks, artifacts, idempotencyKeys };
}

export interface RetroSessionState {
  sessionId: string;
  state: RetroState;
  triggers: number;
  forks: number;
  artifacts: number;
  badLines: number;
  totalLines: number;
}

/** 恢复某会话状态(持久化历史 → 计数)。 */
export function loadRetroSession(root: string, sessionId: string): RetroSessionState {
  const ledger = readRetroLedger(root);
  const projection = projectRetroSession(ledger.rows, sessionId);
  return {
    sessionId,
    state: projection.state,
    triggers: projection.triggers,
    forks: projection.forks,
    artifacts: projection.artifacts,
    badLines: ledger.badLines,
    totalLines: ledger.totalLines,
  };
}

/** `state` 别名(与规格命名一致)。 */
export function getRetroState(root: string, sessionId: string): RetroSessionState {
  return loadRetroSession(root, sessionId);
}

export interface RetroTickInput {
  sessionId: string;
  event: RetroEventKind;
  at?: number;
  policy?: RetroPolicy;
  parent?: RetroForkParent;
  /** >0 表示本会话被 nudge 拉起(禁递归);落一行 state 供后续 tick 恢复。 */
  nudge?: number;
}

export interface RetroTickResult {
  ok: boolean;
  sessionId: string;
  event?: RetroEventKind;
  trigger: boolean;
  reason: string;
  codes: string[];
  state: RetroState;
  forkSpec?: RetroForkSpec;
}

function invalidTick(sessionId: string, event: RetroEventKind | undefined, reason: string): RetroTickResult {
  return {
    ok: false,
    sessionId,
    event,
    trigger: false,
    reason,
    codes: [RETRO_CODES.INVALID],
    state: emptyRetroState(),
  };
}

/** 缺省父上下文:CLI/离线演示没有父会话时,以全白名单 + 空 system prompt 生成可执行规格。 */
function fallbackParent(sessionId: string, depth: number): RetroForkParent {
  return {
    systemPrompt: "",
    tools: ["memory", "skill_view", "read_file", "search", "grep"],
    cacheScope: "retro",
    depth,
    sessionId,
  };
}

/**
 * 一次 tick:恢复计数 → 落事件行 → shouldTrigger → 按需落 trigger/fork 行并返回 forkSpec。
 * 触发与否不影响事件计数落盘(否则「10 个 user turn」永远凑不齐)。
 */
export function tick(root: string, input: RetroTickInput): RetroTickResult {
  const sessionId = nonEmpty(input?.sessionId);
  const event = input?.event;
  if (sessionId === undefined) return invalidTick("", event, "invalid-session-id");
  if (!isRetroEventKind(event)) return invalidTick(sessionId, undefined, "invalid-event-kind");
  const at = typeof input.at === "number" && Number.isFinite(input.at) ? input.at : undefined;

  if (typeof input.nudge === "number" && Number.isFinite(input.nudge) && input.nudge >= 0) {
    if (!appendLine(root, { type: "state", sessionId, at: isoAt(at), nudge: Math.floor(input.nudge) })) {
      return { ...invalidTick(sessionId, event, "ledger-write-failed"), codes: [RETRO_STORE_CODES[0]] };
    }
  }

  const before = loadRetroSession(root, sessionId).state;
  const decision = shouldTrigger(before, { kind: event, at }, input.policy);
  const decisionCodes = [...decision.codes];
  if (decisionCodes.includes(RETRO_CODES.INVALID)) {
    return { ...invalidTick(sessionId, event, decision.reason), state: before };
  }

  const row: RetroRow = { type: event === "retro-done" ? "done" : "event", sessionId, at: isoAt(at) };
  if (event !== "retro-done") row.kind = event;
  if (!appendLine(root, row)) {
    return { ...invalidTick(sessionId, event, "ledger-write-failed"), state: before, codes: [RETRO_STORE_CODES[0]] };
  }
  let next = event === "retro-done"
    ? markRetroDone(before, { at: at ?? Date.now() }).state
    : updateState(before, { kind: event, at });

  const result: RetroTickResult = {
    ok: true,
    sessionId,
    event,
    trigger: decision.trigger,
    reason: decision.reason,
    codes: decisionCodes,
    state: next,
  };
  if (!decision.trigger) return result;

  if (!appendLine(root, { type: "trigger", sessionId, at: isoAt(at), reason: decision.reason, codes: decisionCodes })) {
    return { ...result, codes: [...decisionCodes, RETRO_STORE_CODES[0]] };
  }
  const parent = input.parent ?? fallbackParent(sessionId, next.depth);
  const specResult = buildForkSpec({ ...parent, depth: next.depth, sessionId });
  if (!specResult.ok || specResult.spec === undefined) {
    return { ...result, codes: [...decisionCodes, RETRO_CODES.INVALID] };
  }
  const forkSpec = specResult.spec;
  if (!appendLine(root, { type: "fork", sessionId, at: isoAt(at), spec: forkSpec })) {
    return { ...result, forkSpec, codes: [...decisionCodes, RETRO_CODES.FORK_SPEC, RETRO_STORE_CODES[0]] };
  }
  next = { ...next, depth: forkSpec.depth, nudge: forkSpec.nudge };
  return { ...result, state: next, forkSpec, codes: [...decisionCodes, RETRO_CODES.FORK_SPEC] };
}

export interface RetroArtifactRecordInput {
  sessionId: string;
  summary: string;
  evidenceRefs?: string[];
  taskId?: string;
  confidence?: number;
  at?: number;
}

export interface RetroArtifactRecordResult {
  ok: boolean;
  sessionId: string;
  artifact?: RetroArtifact;
  codes: string[];
  reason?: string;
}

/** 写一条复盘产物:按幂等键去重,重复不落盘(ARTIFACT_DUPLICATE)。 */
export function recordArtifact(root: string, input: RetroArtifactRecordInput): RetroArtifactRecordResult {
  const sessionId = nonEmpty(input?.sessionId);
  if (sessionId === undefined) {
    return { ok: false, sessionId: "", codes: [RETRO_CODES.INVALID], reason: "invalid-session-id" };
  }
  const ledger = readRetroLedger(root);
  const projection = projectRetroSession(ledger.rows, sessionId);
  const built = retroArtifact(
    { sessionId, retroCount: projection.state.retroCount, ...(input.taskId !== undefined ? { taskId: input.taskId } : {}) },
    {
      summary: input.summary,
      ...(input.evidenceRefs !== undefined ? { evidenceRefs: input.evidenceRefs } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.at !== undefined ? { at: input.at } : {}),
    },
  );
  if (!built.ok || built.artifact === undefined) {
    return { ok: false, sessionId, codes: [built.code], reason: "invalid-artifact" };
  }
  const artifact = built.artifact;
  if (projection.idempotencyKeys.has(artifact.idempotencyKey)) {
    return {
      ok: false,
      sessionId,
      artifact,
      codes: [RETRO_CODES.ARTIFACT_DUPLICATE],
      reason: `duplicate:${artifact.idempotencyKey}`,
    };
  }
  if (!appendLine(root, { type: "artifact", sessionId, at: isoAt(input.at), artifact })) {
    return { ok: false, sessionId, artifact, codes: [RETRO_STORE_CODES[0]], reason: "ledger-write-failed" };
  }
  return { ok: true, sessionId, artifact, codes: [RETRO_CODES.ARTIFACT] };
}

export interface RetroSessionReport {
  sessionId: string;
  userTurns: number;
  toolIterations: number;
  retroCount: number;
  depth: number;
  nudge: number;
  triggers: number;
  forks: number;
  artifacts: number;
}

export interface RetroReport {
  version: number;
  generatedAt: string;
  file: string;
  sessions: RetroSessionReport[];
  totals: { sessions: number; triggers: number; forks: number; artifacts: number; retros: number };
  badLines: number;
  totalLines: number;
}

/** 全量报告:按 sessionId 聚合(供 CLI `--report` 与夜间整合消费)。 */
export function retroReport(root: string, opts: { at?: number } = {}): RetroReport {
  const ledger = readRetroLedger(root);
  const sessions = new Set<string>();
  for (const row of ledger.rows) {
    const sessionId = nonEmpty(row.sessionId);
    if (sessionId !== undefined) sessions.add(sessionId);
  }
  const entries: RetroSessionReport[] = [];
  const totals = { sessions: 0, triggers: 0, forks: 0, artifacts: 0, retros: 0 };
  for (const sessionId of [...sessions].sort()) {
    const projection = projectRetroSession(ledger.rows, sessionId);
    const entry: RetroSessionReport = {
      sessionId,
      userTurns: projection.state.userTurns,
      toolIterations: projection.state.toolIterations,
      retroCount: projection.state.retroCount,
      depth: projection.state.depth,
      nudge: projection.state.nudge,
      triggers: projection.triggers,
      forks: projection.forks,
      artifacts: projection.artifacts,
    };
    entries.push(entry);
    totals.sessions += 1;
    totals.triggers += entry.triggers;
    totals.forks += entry.forks;
    totals.artifacts += entry.artifacts;
    totals.retros += entry.retroCount;
  }
  return {
    version: RETRO_STORE_VERSION,
    generatedAt: new Date(opts.at ?? Date.now()).toISOString(),
    file: retroPaths(root).file,
    sessions: entries,
    totals,
    badLines: ledger.badLines,
    totalLines: ledger.totalLines,
  };
}
