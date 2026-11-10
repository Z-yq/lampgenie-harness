/**
 * 决策质量样本的持久层(RSI 模式库):把 decision-quality 的纯逻辑落到 append-only jsonl。
 *
 * 为什么 append-only:一条决策是「当时为什么这么选」的审计事实,事后的人工纠正也必须留痕——
 * 纠正不原地改写历史行,而是追加一条覆盖行,投影时按行序折叠。这样「版本切换/口径变化后
 * 同一个 id 读出来是什么」永远可复核(重放同一文件即可复算)。
 * 单行追加 + 写后重读行数校验让「写成功了吗」成为可复核断言(而不是信任 append 没抛)。
 *
 * 数据面:
 * - `<root>/.genie/rsi/decisions.jsonl`
 *   decision   {record}                        一条决策(DecisionRecord)
 *   correction {targetId, record, by, note}     人工纠正的覆盖行(同 id 后写为准)
 * - `<root>/.genie/rsi/patterns.jsonl`
 *   pattern    {pattern}                       一次模式快照(同 patternId 后写为准)
 *
 * 投影语义:按行序读全部行;坏行(JSON 坏 / v 不是 1 / type 未知 / 载荷不合法 / correction 指向
 * 不存在的决策)只计入 badLines 并跳过:一行坏不整文件失效、不 throw。
 * patterns 折叠后不倒退:aggregate 重算出的低级别快照不会把已升阶/已入库的状态打回去。
 *
 * 依赖纪律:node:fs / node:path + runtime 的纯逻辑模块;不引 agent loop、不引 gateway 其余业务模块。
 * runtime 模块按 cohort-signature-store 的既有套路惰性解析(两跳):
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 除参数错误(root 非法)外不 throw:IO/投影失败一律折叠成稳定码返回。
 * store 自产的码与 runtime 的 DQ_* 分开(前者说「存/取失败」,后者说「这批决策能说什么」)。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  CounterfactualMatch,
  DecisionRecord,
  DecisionType,
  Pattern,
  PatternKind,
  PatternLevel,
  PatternStatus,
} from "@lampgenie/runtime/agent/decision-quality";

/** store 稳定码:store 层自产的失败码(模式/决策的判断码沿用 runtime 的 DQ_*)。 */
export const DECISION_STORE_CODES = [
  "DQ_STORE_INVALID_INPUT",
  "DQ_STORE_ERROR",
  "DQ_WRITE_VERIFY_FAILED",
  "DQ_PATTERN_NOT_FOUND",
  "DQ_DECISION_NOT_FOUND",
] as const;

export type DecisionStoreCode = (typeof DECISION_STORE_CODES)[number];

/** 落盘行类型(只增不改)。 */
export const DECISION_LINE_TYPES = ["decision", "pattern", "correction"] as const;

export type DecisionLineType = (typeof DECISION_LINE_TYPES)[number];

export interface DecisionLine {
  v: 1;
  type: "decision";
  at: number;
  record: DecisionRecord;
}

export interface PatternLine {
  v: 1;
  type: "pattern";
  at: number;
  pattern: Pattern;
}

export interface CorrectionLine {
  v: 1;
  type: "correction";
  at: number;
  targetId: string;
  record: DecisionRecord;
  by: string;
  note: string;
}

export type DecisionLedgerLine = DecisionLine | CorrectionLine;

/** 决策流投影(纠正已折叠)+ 坏行计数。 */
export interface DecisionProjection {
  decisions: DecisionRecord[];
  totalLines: number;
  badLines: number;
}

/** 模式流投影(同 id 后写为准)+ 坏行计数。 */
export interface PatternProjection {
  patterns: Pattern[];
  totalLines: number;
  badLines: number;
}

export interface DecisionRecordResult {
  record?: DecisionRecord;
  codes: string[];
}

export interface DecisionAggregateResult {
  patterns: Pattern[];
  observations: DecisionObservation[];
  totalLines: number;
  badLines: number;
  codes: string[];
}

export interface DecisionPatternListOptions {
  kind?: string;
  level?: string;
  status?: string;
}

export interface DecisionPatternListResult {
  patterns: Pattern[];
  totalLines: number;
  badLines: number;
  codes: string[];
}

export interface DecisionPromoteEvidence {
  minCrossEntity?: number;
  replayValidated?: boolean;
  transferTested?: boolean;
}

export interface DecisionPromoteStoreResult {
  pattern?: Pattern;
  codes: string[];
  reason?: string;
}

export interface DecisionLibraryStoreResult {
  pattern?: Pattern;
  codes: string[];
  reason?: string;
}

export interface DecisionCounterfactualStoreResult {
  match?: CounterfactualMatch;
  codes: string[];
}

export interface DecisionHumanCorrectOptions {
  by: string;
  note: string;
  avoidability?: string;
  at?: number;
}

export interface DecisionHumanCorrectStoreResult {
  record?: DecisionRecord;
  codes: string[];
}

export interface DecisionReportResult {
  total: number;
  byType: Record<string, number>;
  byOutcome: Record<string, number>;
  byAvoidability: Record<string, number>;
  patterns: { candidates: number; library: number; observations: number };
  levels: { L0: number; L1: number; L2: number; L3: number };
  observations: DecisionObservation[];
  badLines: number;
  codes: string[];
}

/** runtime 的旁路观察(不进模式,只说明这条记录为什么被跳过)。 */
export interface DecisionObservation {
  decisionId: string;
  code: string;
  reason: string;
}

interface DecisionQualityRuntime {
  DECISION_QUALITY_VERSION: number;
  recordDecision(input: unknown, opts?: { at?: number }): { record?: DecisionRecord; codes: string[] };
  choiceSignature(record: DecisionRecord): string;
  weightOf(source: string | undefined): number;
  aggregate(records: unknown, opts?: { now?: number }): {
    patterns: Pattern[];
    observations: DecisionObservation[];
    codes: string[];
  };
  promote(
    pattern: unknown,
    opts?: { minCrossEntity?: number; replayValidated?: boolean; transferTested?: boolean },
  ): { pattern: Pattern; codes: string[]; reason?: string };
  addToLibrary(pattern: unknown): { pattern: Pattern; codes: string[]; reason?: string };
  counterfactual(records: unknown, decisionId: unknown): { match?: CounterfactualMatch; codes: string[] };
  humanCorrect(
    record: unknown,
    opts?: { by: string; note: string; at?: number; avoidability?: string },
  ): { record: DecisionRecord; codes: string[] };
}

let decisionRuntime: DecisionQualityRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadDecisionRuntime(): Promise<DecisionQualityRuntime> {
  if (decisionRuntime) return decisionRuntime;
  const spec = "@lampgenie/runtime/agent/decision-quality";
  try {
    decisionRuntime = (await import(spec)) as DecisionQualityRuntime;
  } catch {
    const srcUrl = new URL(
      "../../../packages/harness-runtime/src/agent/decision-quality.ts",
      import.meta.url,
    ).href;
    decisionRuntime = (await import(srcUrl)) as DecisionQualityRuntime;
  }
  return decisionRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadDecisionRuntime();

const LINE_TYPES: ReadonlySet<string> = new Set<string>(DECISION_LINE_TYPES);
const DECISION_TYPES: ReadonlySet<string> = new Set<string>([
  "tool-choice",
  "plan",
  "edit",
  "verify",
  "delegate",
  "compact",
  "context",
]);
const OUTCOMES: ReadonlySet<string> = new Set<string>(["success", "failure", "retry", "waste", "timeout"]);
const AVOIDABILITIES: ReadonlySet<string> = new Set<string>([
  "decision-error",
  "environment-noise",
  "requirement-change",
  "unknown",
]);
const SOURCES: ReadonlySet<string> = new Set<string>(["session", "defect-lineage", "human-correction"]);
const PATTERN_LEVELS: ReadonlySet<string> = new Set<string>(["L0", "L1", "L2", "L3"]);
const PATTERN_KINDS: ReadonlySet<string> = new Set<string>(["anti-pattern", "efficient-pattern"]);
const PATTERN_STATUSES: ReadonlySet<string> = new Set<string>(["candidate", "library", "observation"]);
const LEVEL_ORDER: readonly PatternLevel[] = ["L0", "L1", "L2", "L3"];

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function assertRoot(root: unknown): string {
  if (typeof root !== "string" || root.trim() === "") throw new Error("root 必须是非空字符串");
  return root;
}

/** 决策台账文件绝对路径:`<root>/.genie/rsi/decisions.jsonl`。 */
export function decisionsPath(root: string): string {
  const base = assertRoot(root);
  return join(base, ".genie", "rsi", "decisions.jsonl");
}

/** 模式台账文件绝对路径:`<root>/.genie/rsi/patterns.jsonl`。 */
export function patternsPath(root: string): string {
  const base = assertRoot(root);
  return join(base, ".genie", "rsi", "patterns.jsonl");
}

/** 统计文件非空行数;文件不存在/读失败按 0。 */
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

/** 追加一行并做写后行数校验;失败返回 false(不回滚、不 throw)。 */
function appendLine(path: string, line: DecisionLine | PatternLine | CorrectionLine): boolean {
  const before = countLines(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    return false;
  }
  return countLines(path) === before + 1;
}

/** 已落盘行的结构校验(行由 runtime 产出,这里只挡手改/截断). */
function coerceRecord(value: unknown): DecisionRecord | undefined {
  if (!isRecord(value)) return undefined;
  const id = textOf(value["id"]);
  const sessionId = textOf(value["sessionId"]);
  const choice = textOf(value["choice"]);
  const type = textOf(value["type"]);
  const outcome = textOf(value["outcome"]);
  const avoidability = textOf(value["avoidability"]);
  const source = textOf(value["source"]);
  if (id === undefined || sessionId === undefined || choice === undefined) return undefined;
  if (type === undefined || !DECISION_TYPES.has(type)) return undefined;
  if (outcome === undefined || !OUTCOMES.has(outcome)) return undefined;
  if (avoidability === undefined || !AVOIDABILITIES.has(avoidability)) return undefined;
  if (source === undefined || !SOURCES.has(source)) return undefined;
  if (!isFiniteNumber(value["at"])) return undefined;
  if (!Array.isArray(value["evidenceRefs"])) return undefined;
  const cost = value["cost"];
  const context = value["context"];
  if (!isRecord(cost) || !isRecord(context)) return undefined;
  if (textOf(context["taskClass"]) === undefined) return undefined;
  return value as unknown as DecisionRecord;
}

function coercePattern(value: unknown): Pattern | undefined {
  if (!isRecord(value)) return undefined;
  const id = textOf(value["id"]);
  const kind = textOf(value["kind"]);
  const level = textOf(value["level"]);
  const status = textOf(value["status"]);
  const decisionType = textOf(value["decisionType"]);
  const signature = textOf(value["choiceSignature"]);
  if (id === undefined || kind === undefined || level === undefined || status === undefined) return undefined;
  if (!PATTERN_KINDS.has(kind) || !PATTERN_LEVELS.has(level) || !PATTERN_STATUSES.has(status)) return undefined;
  if (decisionType === undefined || !DECISION_TYPES.has(decisionType)) return undefined;
  if (signature === undefined) return undefined;
  if (typeof value["name"] !== "string") return undefined;
  if (!isFiniteNumber(value["confidence"]) || !isFiniteNumber(value["frequency"])) return undefined;
  if (!Array.isArray(value["instances"])) return undefined;
  if (!isRecord(value["distribution"]) || !isRecord(value["promotion"])) return undefined;
  return value as unknown as Pattern;
}

/**
 * 读决策台账:decision 行按 id 折叠,correction 行按行序覆盖(纠正行自带折叠后的 record)。
 * correction 指向尚未出现的 id → 挂起,文件末尾仍找不到才算坏行。
 */
function readDecisions(base: string): DecisionProjection {
  const path = decisionsPath(base);
  const projection: DecisionProjection = { decisions: [], totalLines: 0, badLines: 0 };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return projection;
  }
  const folded = new Map<string, DecisionRecord>();
  const pending: CorrectionLine[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!.trim();
    if (raw === "") continue;
    projection.totalLines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      projection.badLines += 1;
      continue;
    }
    if (
      !isRecord(parsed) ||
      parsed["v"] !== 1 ||
      typeof parsed["type"] !== "string" ||
      !LINE_TYPES.has(parsed["type"])
    ) {
      projection.badLines += 1;
      continue;
    }
    if (parsed["type"] === "pattern") {
      // 模式行走另一个文件;混进来算坏行(免得静默吞掉写错位置的快照)。
      projection.badLines += 1;
      continue;
    }
    const record = coerceRecord(parsed["record"]);
    if (record === undefined) {
      projection.badLines += 1;
      continue;
    }
    if (parsed["type"] === "decision") {
      folded.set(record.id, record);
      continue;
    }
    const targetId = textOf(parsed["targetId"]);
    if (targetId === undefined || targetId !== record.id) {
      projection.badLines += 1;
      continue;
    }
    const line: CorrectionLine = {
      v: 1,
      type: "correction",
      at: isFiniteNumber(parsed["at"]) ? parsed["at"] : record.at,
      targetId,
      record,
      by: textOf(parsed["by"]) ?? "(unknown)",
      note: typeof parsed["note"] === "string" ? parsed["note"] : "",
    };
    if (folded.has(targetId)) folded.set(targetId, record);
    else pending.push(line);
  }
  for (const line of pending) {
    if (folded.has(line.targetId)) folded.set(line.targetId, line.record);
    else projection.badLines += 1;
  }
  projection.decisions = [...folded.values()];
  return projection;
}

/** 读模式台账:同 patternId 后写为准(按行序折叠)。 */
function readPatterns(base: string): PatternProjection {
  const path = patternsPath(base);
  const projection: PatternProjection = { patterns: [], totalLines: 0, badLines: 0 };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return projection;
  }
  const folded = new Map<string, Pattern>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!.trim();
    if (raw === "") continue;
    projection.totalLines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      projection.badLines += 1;
      continue;
    }
    if (!isRecord(parsed) || parsed["v"] !== 1 || parsed["type"] !== "pattern") {
      projection.badLines += 1;
      continue;
    }
    const pattern = coercePattern(parsed["pattern"]);
    if (pattern === undefined) {
      projection.badLines += 1;
      continue;
    }
    folded.set(pattern.id, pattern);
  }
  projection.patterns = [...folded.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return projection;
}

function levelOf(pattern: Pattern): number {
  const index = LEVEL_ORDER.indexOf(pattern.level);
  return index < 0 ? 0 : index;
}

/**
 * 聚合结果与已有快照合并:重算不得让状态倒退。
 * - level 取高:已 L1/L2/L3 的不会因为一次重算回到 L0(证据仍在,只是这次没带 replay 标志)。
 * - promotion 证据取并集(crossEntity 取大、replay/transfer 或起来)。
 * - status 已 library 的保持 library。
 */
function mergeWithLatest(next: Pattern, prev: Pattern | undefined): Pattern {
  if (prev === undefined) return next;
  const merged: Pattern = { ...next };
  merged.level = levelOf(prev) > levelOf(next) ? prev.level : next.level;
  merged.promotion = {
    crossEntityCount: Math.max(prev.promotion.crossEntityCount, next.promotion.crossEntityCount),
    replayValidated: prev.promotion.replayValidated || next.promotion.replayValidated,
    transferTested: prev.promotion.transferTested || next.promotion.transferTested,
  };
  merged.status = prev.status === "library" ? "library" : next.status;
  return merged;
}

/** 追加一条模式快照;写失败折叠成 DQ_WRITE_VERIFY_FAILED。 */
function appendPattern(base: string, pattern: Pattern): boolean {
  return appendLine(patternsPath(base), {
    v: 1,
    type: "pattern",
    at: isFiniteNumber(pattern.updatedAt) ? pattern.updatedAt : Date.now(),
    pattern,
  });
}

/** 记一条决策:证据缺失(DQ_EVIDENCE_REQUIRED)/结构非法(DQ_INVALID)不落盘。 */
export function record(root: string, input: unknown): DecisionRecordResult {
  const base = assertRoot(root);
  const result = rt.recordDecision(input);
  const codes = [...result.codes];
  const normalized = result.record;
  if (normalized === undefined) return { codes };
  const ok = appendLine(decisionsPath(base), {
    v: 1,
    type: "decision",
    at: normalized.at,
    record: normalized,
  });
  if (!ok) codes.push("DQ_WRITE_VERIFY_FAILED");
  return { record: normalized, codes };
}

/**
 * 聚合:读全部决策行(已折叠纠正)→ runtime aggregate → 每个 pattern 追加一条快照。
 * 写失败只追加 DQ_WRITE_VERIFY_FAILED,不 throw、不回滚已写行。
 */
export function aggregate(root: string, opts: { now?: number } = {}): DecisionAggregateResult {
  const base = assertRoot(root);
  const projection = readDecisions(base);
  const aggregateOpts = isFiniteNumber(opts.now) ? { now: opts.now } : {};
  const result = rt.aggregate(projection.decisions, aggregateOpts);
  const codes = new Set<string>(result.codes);
  const latest = new Map(readPatterns(base).patterns.map((pattern) => [pattern.id, pattern]));
  const persisted: Pattern[] = [];
  for (const pattern of result.patterns) {
    const merged = mergeWithLatest(pattern, latest.get(pattern.id));
    if (!appendPattern(base, merged)) codes.add("DQ_WRITE_VERIFY_FAILED");
    persisted.push(merged);
  }
  return {
    patterns: persisted,
    observations: result.observations,
    totalLines: projection.totalLines,
    badLines: projection.badLines,
    codes: [...codes].sort(),
  };
}

/** 列模式(折叠后的最新状态),可按 kind/level/status 过滤。 */
export function listPatterns(root: string, opts: DecisionPatternListOptions = {}): DecisionPatternListResult {
  const base = assertRoot(root);
  const projection = readPatterns(base);
  const wantKind = textOf(opts.kind);
  const wantLevel = textOf(opts.level);
  const wantStatus = textOf(opts.status);
  const patterns = projection.patterns.filter((pattern) => {
    if (wantKind !== undefined && pattern.kind !== wantKind) return false;
    if (wantLevel !== undefined && pattern.level !== wantLevel) return false;
    if (wantStatus !== undefined && pattern.status !== wantStatus) return false;
    return true;
  });
  return { patterns, totalLines: projection.totalLines, badLines: projection.badLines, codes: [] };
}

/** 升一级:读最新快照 → runtime promote → 升级才落盘新行。 */
export function promote(
  root: string,
  patternId: string,
  evidence: DecisionPromoteEvidence = {},
): DecisionPromoteStoreResult {
  const base = assertRoot(root);
  const id = textOf(patternId);
  if (id === undefined) return { codes: ["DQ_STORE_INVALID_INPUT"] };
  const current = readPatterns(base).patterns.find((pattern) => pattern.id === id);
  if (current === undefined) return { codes: ["DQ_PATTERN_NOT_FOUND"] };
  const opts: { minCrossEntity?: number; replayValidated?: boolean; transferTested?: boolean } = {};
  if (isFiniteNumber(evidence.minCrossEntity)) opts.minCrossEntity = evidence.minCrossEntity;
  if (evidence.replayValidated === true) opts.replayValidated = true;
  if (evidence.transferTested === true) opts.transferTested = true;
  const result = rt.promote(current, opts);
  const codes = [...result.codes];
  if (!codes.includes("DQ_PATTERN_PROMOTED")) {
    const failed: DecisionPromoteStoreResult = { pattern: result.pattern, codes };
    if (result.reason !== undefined) failed.reason = result.reason;
    return failed;
  }
  if (!appendPattern(base, result.pattern)) codes.push("DQ_WRITE_VERIFY_FAILED");
  return { pattern: result.pattern, codes };
}

/** 入知识库:读最新快照 → runtime addToLibrary → 准入才落盘新行。 */
export function addToLibrary(root: string, patternId: string): DecisionLibraryStoreResult {
  const base = assertRoot(root);
  const id = textOf(patternId);
  if (id === undefined) return { codes: ["DQ_STORE_INVALID_INPUT"] };
  const current = readPatterns(base).patterns.find((pattern) => pattern.id === id);
  if (current === undefined) return { codes: ["DQ_PATTERN_NOT_FOUND"] };
  const result = rt.addToLibrary(current);
  const codes = [...result.codes];
  if (!codes.includes("DQ_LIBRARY_ADDED")) {
    const failed: DecisionLibraryStoreResult = { pattern: result.pattern, codes };
    if (result.reason !== undefined) failed.reason = result.reason;
    return failed;
  }
  if (!appendPattern(base, result.pattern)) codes.push("DQ_WRITE_VERIFY_FAILED");
  return { pattern: result.pattern, codes };
}

/** 反事实:在折叠后的全部决策里找更优的对照;决策不存在 → DQ_DECISION_NOT_FOUND。 */
export function counterfactual(root: string, decisionId: string): DecisionCounterfactualStoreResult {
  const base = assertRoot(root);
  const id = textOf(decisionId);
  if (id === undefined) return { codes: ["DQ_STORE_INVALID_INPUT"] };
  const projection = readDecisions(base);
  const result = rt.counterfactual(projection.decisions, id);
  const codes = [...result.codes];
  if (!projection.decisions.some((record) => record.id === id)) codes.push("DQ_DECISION_NOT_FOUND");
  if (result.match === undefined) return { codes };
  return { match: result.match, codes };
}

/**
 * 人工纠正:读折叠后的决策 → runtime humanCorrect → 追加一条 correction 覆盖行。
 * append-only:历史行不动,投影时后写为准(纠正可叠加,note 累积留痕)。
 */
export function humanCorrect(
  root: string,
  decisionId: string,
  opts: DecisionHumanCorrectOptions,
): DecisionHumanCorrectStoreResult {
  const base = assertRoot(root);
  const id = textOf(decisionId);
  const by = textOf(opts?.by);
  const note = textOf(opts?.note);
  if (id === undefined || by === undefined || note === undefined) return { codes: ["DQ_STORE_INVALID_INPUT"] };
  const target = readDecisions(base).decisions.find((record) => record.id === id);
  if (target === undefined) return { codes: ["DQ_DECISION_NOT_FOUND"] };
  const correctOpts: { by: string; note: string; at?: number; avoidability?: string } = { by, note };
  if (isFiniteNumber(opts.at)) correctOpts.at = opts.at;
  if (textOf(opts.avoidability) !== undefined) correctOpts.avoidability = textOf(opts.avoidability);
  const result = rt.humanCorrect(target, correctOpts);
  const codes = [...result.codes];
  if (codes.includes("DQ_INVALID")) return { record: result.record, codes: ["DQ_STORE_INVALID_INPUT"] };
  const line: CorrectionLine = {
    v: 1,
    type: "correction",
    at: isFiniteNumber(opts.at) ? opts.at : Date.now(),
    targetId: id,
    record: result.record,
    by,
    note,
  };
  if (!appendLine(decisionsPath(base), line)) codes.push("DQ_WRITE_VERIFY_FAILED");
  return { record: result.record, codes };
}

/** 报表:分组计数 + 模式状态/级别分布 + 旁路观察 + 坏行数。 */
export function reportDecisions(root: string, opts: { now?: number } = {}): DecisionReportResult {
  const base = assertRoot(root);
  const decisions = readDecisions(base);
  const patterns = readPatterns(base);
  const aggregateOpts = isFiniteNumber(opts.now) ? { now: opts.now } : {};
  const aggregated = rt.aggregate(decisions.decisions, aggregateOpts);

  const byType: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  const byAvoidability: Record<string, number> = {};
  for (const record of decisions.decisions) {
    byType[record.type] = (byType[record.type] ?? 0) + 1;
    byOutcome[record.outcome] = (byOutcome[record.outcome] ?? 0) + 1;
    byAvoidability[record.avoidability] = (byAvoidability[record.avoidability] ?? 0) + 1;
  }

  const folded = new Map<string, Pattern>(patterns.patterns.map((pattern) => [pattern.id, pattern]));
  for (const pattern of aggregated.patterns) {
    folded.set(pattern.id, mergeWithLatest(pattern, folded.get(pattern.id)));
  }
  const levels = { L0: 0, L1: 0, L2: 0, L3: 0 };
  const statusCounts = { candidates: 0, library: 0, observations: 0 };
  for (const pattern of folded.values()) {
    levels[pattern.level] += 1;
    if (pattern.status === "library") statusCounts.library += 1;
    else if (pattern.status === "observation") statusCounts.observations += 1;
    else statusCounts.candidates += 1;
  }

  return {
    total: decisions.decisions.length,
    byType,
    byOutcome,
    byAvoidability,
    patterns: statusCounts,
    levels,
    observations: aggregated.observations,
    badLines: decisions.badLines + patterns.badLines,
    codes: [...aggregated.codes],
  };
}

/** 便捷类型导出:让调用方不必再引 runtime 的包。 */
export type {
  CounterfactualMatch,
  DecisionRecord,
  DecisionType,
  Pattern,
  PatternKind,
  PatternLevel,
  PatternStatus,
};
