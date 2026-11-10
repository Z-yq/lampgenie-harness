/**
 * 轨迹数据契约(M201,2026-11-09 RSI 第 28 轮 #201):把 journal 的**原始事件**抽取成统一的
 * **轨迹事件**批次,供夜间整合批量消费。
 *
 * 三条红线:
 * 1. **纯逻辑零 IO**——输入 raw 事件数组,输出批次对象;落盘(批次文件/账本)在
 *    `apps/gateway/src/trace-harvest.ts`。
 * 2. **脱敏先行**——所有保留的字符串字段先 `redactText`(core:凭证形态→占位符)再
 *    `scrubSecrets`(runtime:形状兜底),随后用**窄判据**复检;复检命中即整字段丢弃并计数。
 *    窄判据只认明确凭证形态,**不用** `hasSensitiveText`(它对长 base64 误杀,会把正常
 *    工具结果整条判死)。
 * 3. **幂等键含版本**——batchKey = sha256(sessionId + seq 区间 + ruleVersion +
 *    contractVersion);规则或契约升级必产新键,重跑不重复入账。
 *
 * 事件词汇(kind 判别字段):
 * - `step`      步进画像(steps/calls/tokensSpent/phase):来源 `task.trajectory` 优先,
 *               该会话本批无 trajectory 时退用 `step.start`(steps=1,计数缺省 0,不推断)。
 * - `tool`      工具调用画像(name/ok/durationMs/argsChars/resultChars):`tool.call` 与
 *               `tool.result` 按 toolCallId 配对;只有 call 没有 result 记为 ok=false。
 * - `token`     token 用量(input/output/total/cached):来源 `llm.trace.payload.usage`;
 *               **缺 usage 不推断**(不出事件)。
 * - `phase`     阶段遥测(spans/quality):来源 `custom` 且 `payload.what="telemetry.phase"`。
 * - `decision`  可判定决策(what/effect/tool/key):来源 `permission.gate` 的 effect、
 *               `tip.injected` 的注入键、`custom` 的 what/type ∈ {task.route, plan.gate,
 *               goal.*}、以及工具调用里的 `board_upsert`。
 *
 * 覆盖口径:`coverageRate = mappedEvents / (inputEvents - duplicateSeqs)`(分母 0 给 0,
 * 不产生 NaN);未被映射的 kind 逐类计数在 `unmappedByKind`(含「本轮未选用的二选一来源」,
 * 如已有 trajectory 时的 step.start)。
 */
import { createHash } from "node:crypto";
import { redactText } from "@lampgenie/core";
import { scrubSecrets } from "../security/redact";

/** 契约版本:事件形状或映射口径变更时 +1(批次键随之变化,旧批不被覆盖)。 */
export const TRACE_CONTRACT_VERSION = 1;

/** 轨迹维度:每条事件都带,供下游按会话/项目/任务/模型/任务类别切片。 */
export interface TraceDimension {
  sessionId: string;
  projectId?: string;
  taskId?: string;
  model?: string;
  taskClass?: string;
  turn?: number;
  step?: number;
}

export type TraceEventKind = "step" | "tool" | "token" | "phase" | "decision";

/** 所有轨迹事件共有的信封字段。 */
export interface TraceEventEnvelope {
  /** 源 journal 事件的 seq(同会话内唯一;子代理内层事件继承外层 seq)。 */
  seq: number;
  /** 源事件时间戳(ms;缺省 0)。 */
  at: number;
  /** 源 journal kind(摊平后的内层 kind)——留作溯源,不参与下游切片。 */
  source: string;
  /** 子代理标识(subagent.event 摊平时带上;主会话事件无此键)。 */
  agentId?: string;
  dimension: TraceDimension;
}

export interface StepTraceEvent extends TraceEventEnvelope {
  kind: "step";
  steps: number;
  calls: number;
  tokensSpent: number;
  phase?: string;
}

export interface ToolTraceEvent extends TraceEventEnvelope {
  kind: "tool";
  name: string;
  ok: boolean;
  durationMs: number;
  /** 参数文本长度(字符数)——**不落参数原文**,正文里可能带凭证。 */
  argsChars: number;
  /** 结果文本长度(字符数)——同样不落原文。 */
  resultChars: number;
}

export interface TokenTraceEvent extends TraceEventEnvelope {
  kind: "token";
  input: number;
  output: number;
  total: number;
  cached: number;
}

export interface PhaseSpan {
  name: string;
  ms: number;
  status: string;
}

export interface PhaseTraceEvent extends TraceEventEnvelope {
  kind: "phase";
  spans: PhaseSpan[];
  quality?: string;
}

export interface DecisionTraceEvent extends TraceEventEnvelope {
  kind: "decision";
  what: string;
  effect?: string;
  tool?: string;
  key?: string;
}

export type TraceEvent =
  | StepTraceEvent
  | ToolTraceEvent
  | TokenTraceEvent
  | PhaseTraceEvent
  | DecisionTraceEvent;

export interface TraceCoverage {
  /** 输入原始事件行数(含重复行)。 */
  inputEvents: number;
  /** 按 (sessionId, seq) 判定为重复被丢弃的行数。 */
  duplicateSeqs: number;
  /** 至少产出一条轨迹事件的输入行数。 */
  mappedEvents: number;
  /** 未映射的 kind → 行数。 */
  unmappedByKind: Record<string, number>;
  /** mappedEvents / (inputEvents - duplicateSeqs);分母 0 → 0。 */
  coverageRate: number;
}

export interface TraceDropped {
  count: number;
  byReason: Record<string, number>;
  byField: Record<string, number>;
}

export interface TraceExtractOptions {
  /** 抽取规则版本(进批次键;规则口径变化必须改它)。 */
  ruleVersion: string;
  /** 契约版本覆盖(缺省 TRACE_CONTRACT_VERSION;测试/回放用)。 */
  contractVersion?: number;
  /** 批次会话归属(缺省取输入里出现过的会话按字典序拼接)。 */
  sessionId?: string;
  /** 批次 seq 区间覆盖(缺省取输入事件 seq 的 min/max)。 */
  seqStart?: number;
  seqEnd?: number;
}

export interface TraceBatch {
  version: number;
  ruleVersion: string;
  batchKey: string;
  events: TraceEvent[];
  coverage: TraceCoverage;
  dropped: TraceDropped;
}

export interface TraceBatchKeyInput {
  sessionId: string;
  seqStart: number;
  seqEnd: number;
  ruleVersion: string;
  contractVersion: number;
}

/**
 * 批次幂等键:稳定 JSON(字段顺序固定)→ sha256 hex。
 * ruleVersion 或 contractVersion 变化即变键 —— 重跑同规则同窗口才命中跳过。
 */
export function traceBatchKey(input: TraceBatchKeyInput): string {
  const stable = JSON.stringify({
    sessionId: input.sessionId,
    seqStart: input.seqStart,
    seqEnd: input.seqEnd,
    ruleVersion: input.ruleVersion,
    contractVersion: input.contractVersion,
  });
  return createHash("sha256").update(stable, "utf8").digest("hex");
}

// ── 内部:脱敏复检 ─────────────────────────────────────────────────────────────

/**
 * 窄判据:只认**明确**的凭证形态(与主脱敏规则相比更保守,故只用于「脱敏之后还漏没漏」)。
 * 命中即整字段丢弃——字段级丢弃可解释、可计数,比整条事件丢弃更保数据。
 */
const RESIDUAL_SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{8,}/,
  /Bearer\s+\S{10,}/i,
  /(api[_-]?key|secret|token|password)\s*[:=]\s*\S{8,}/i,
];

/** 主脱敏产出的人造占位符:它们是**已脱敏标记**,不能算残留。 */
const PLACEHOLDER_RE = /<redacted:[a-z]+>|<REDACTED:[a-zA-Z0-9]+>/g;

function hasResidualSecret(text: string): boolean {
  if (!text) return false;
  const bare = text.replace(PLACEHOLDER_RE, "");
  return RESIDUAL_SECRET_PATTERNS.some((re) => re.test(bare));
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/** 单字段脱敏:redactText → scrubSecrets → 窄判据复检;复检命中返回 undefined 并计数。 */
function sanitizeField(value: unknown, field: string, dropped: TraceDropped): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const cleaned = scrubSecrets(redactText(value));
  if (hasResidualSecret(cleaned)) {
    dropped.count += 1;
    bump(dropped.byReason, "redaction-failed");
    bump(dropped.byField, field);
    return undefined;
  }
  return cleaned;
}

// ── 内部:原始行 ───────────────────────────────────────────────────────────────

type Payload = Record<string, unknown>;

interface RawRow {
  rowId: number;
  sessionId: string;
  seq?: number;
  kind: string;
  payload: Payload;
  time: number;
  agentId?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function charsOf(v: unknown): number {
  return typeof v === "string" ? v.length : 0;
}

function asObject(v: unknown): Payload | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Payload) : undefined;
}

function asRow(raw: unknown, rowId: number): RawRow | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;
  const kind = str(obj.kind);
  if (!kind) return undefined;
  return {
    rowId,
    sessionId: str(obj.sessionId) ?? "",
    seq: num(obj.seq),
    kind,
    payload: asObject(obj.payload) ?? {},
    time: num(obj.time) ?? 0,
  };
}

/** `subagent.event` 摊平:内层事件继承外层 sessionId/seq,并带 agentId。 */
function pushFlattened(out: RawRow[], row: RawRow): void {
  let cur = row;
  let agentId = row.agentId;
  // 嵌套层数设上限,避免异常数据死循环(正常实现只有一层)。
  for (let depth = 0; depth < 8; depth++) {
    if (cur.kind !== "subagent.event") {
      out.push(agentId ? { ...cur, agentId } : cur);
      return;
    }
    const innerKind = str(cur.payload.kind);
    agentId = str(cur.payload.agentId) ?? agentId;
    if (!innerKind) {
      // 内层 kind 缺失:保留外层行,按 subagent.event 计入 unmapped。
      out.push(agentId ? { ...cur, agentId } : cur);
      return;
    }
    const rest: Payload = {};
    for (const [k, v] of Object.entries(cur.payload)) {
      if (k === "kind" || k === "agentId" || k === "parentTaskId") continue;
      rest[k] = v;
    }
    cur = { ...cur, kind: innerKind, payload: rest, ...(agentId ? { agentId } : {}) };
  }
  out.push(agentId ? { ...cur, agentId } : cur);
}

// ── 内部:映射 ─────────────────────────────────────────────────────────────────

interface PendingTool {
  rowId: number;
  seq: number;
  at: number;
  name: string;
  argsChars: number;
  source: string;
  agentId?: string;
  dimension: TraceDimension;
}

/** `custom` 事件里可判定为决策的 what/type 值。 */
function decisionWhatOf(p: Payload): string | undefined {
  const what = str(p.what) ?? str(p.type);
  if (!what) return undefined;
  if (what === "task.route" || what === "plan.gate") return what;
  if (what.startsWith("goal.")) return what;
  return undefined;
}

/**
 * 从原始事件抽取一个批次。**不抛**:未知/畸形输入只计数。
 */
export function extractTraceBatch(
  rawEvents: readonly unknown[],
  opts: TraceExtractOptions,
): TraceBatch {
  const contractVersion = opts.contractVersion ?? TRACE_CONTRACT_VERSION;
  const dropped: TraceDropped = { count: 0, byReason: {}, byField: {} };
  const inputEvents = Array.isArray(rawEvents) ? rawEvents.length : 0;

  // ── 1. 去重(sessionId, seq)+ 摊平 ───────────────────────────────────────
  const rows: RawRow[] = [];
  const seen = new Set<string>();
  let duplicateSeqs = 0;
  let invalidRows = 0;
  for (let i = 0; i < inputEvents; i++) {
    const row = asRow(rawEvents[i], i);
    if (!row) {
      invalidRows += 1;
      continue;
    }
    if (row.seq !== undefined) {
      const key = `${row.sessionId}\u0000${row.seq}`;
      if (seen.has(key)) {
        duplicateSeqs += 1;
        continue;
      }
      seen.add(key);
    }
    pushFlattened(rows, row);
  }

  // ── 2. 会话级画像(项目归属 / 任务类别 / 是否有 trajectory)─────────────────
  const projectBySession = new Map<string, string>();
  const taskClassBySession = new Map<string, string>();
  const hasTrajectory = new Set<string>();
  for (const row of rows) {
    if (row.kind === "session.project.bind") {
      const pid = str(row.payload.projectId);
      if (pid && !projectBySession.has(row.sessionId)) projectBySession.set(row.sessionId, pid);
    }
    const tc = str(row.payload.taskClass);
    if (tc && !taskClassBySession.has(row.sessionId)) taskClassBySession.set(row.sessionId, tc);
    if (row.kind === "task.trajectory") hasTrajectory.add(row.sessionId);
  }

  const dimensionOf = (row: RawRow): TraceDimension => {
    const dim: TraceDimension = {
      sessionId: sanitizeField(row.sessionId, "sessionId", dropped) ?? "",
    };
    const projectId = sanitizeField(projectBySession.get(row.sessionId), "projectId", dropped);
    if (projectId) dim.projectId = projectId;
    const taskId = sanitizeField(row.payload.taskId, "taskId", dropped);
    if (taskId) dim.taskId = taskId;
    const model = sanitizeField(row.payload.model, "model", dropped);
    if (model) dim.model = model;
    const taskClass =
      sanitizeField(row.payload.taskClass, "taskClass", dropped) ??
      sanitizeField(taskClassBySession.get(row.sessionId), "taskClass", dropped);
    if (taskClass) dim.taskClass = taskClass;
    const turn = num(row.payload.turn);
    if (turn !== undefined) dim.turn = turn;
    const step = num(row.payload.step);
    if (step !== undefined) dim.step = step;
    return dim;
  };

  // ── 3. 映射 ──────────────────────────────────────────────────────────────
  const events: TraceEvent[] = [];
  const mappedRows = new Set<number>();
  const pending = new Map<string, PendingTool>();

  const envelope = (row: RawRow): TraceEventEnvelope => {
    const source = sanitizeField(row.kind, "source", dropped) ?? row.kind;
    return {
      seq: row.seq ?? 0,
      at: row.time,
      source,
      ...(row.agentId ? { agentId: row.agentId } : {}),
      dimension: dimensionOf(row),
    };
  };

  for (const row of rows) {
    const p = row.payload;
    switch (row.kind) {
      case "task.trajectory": {
        const phase = sanitizeField(p.phase, "phase", dropped);
        events.push({
          ...envelope(row),
          kind: "step",
          steps: num(p.steps) ?? 0,
          calls: num(p.calls) ?? 0,
          tokensSpent: num(p.tokensSpent) ?? 0,
          ...(phase ? { phase } : {}),
        });
        mappedRows.add(row.rowId);
        break;
      }
      case "step.start": {
        // 二选一:该会话已有 task.trajectory → 本行不计入映射(在 unmappedByKind 里可见)。
        if (hasTrajectory.has(row.sessionId)) break;
        const phase = sanitizeField(p.phase, "phase", dropped);
        events.push({
          ...envelope(row),
          kind: "step",
          steps: 1,
          calls: 0,
          tokensSpent: 0,
          ...(phase ? { phase } : {}),
        });
        mappedRows.add(row.rowId);
        break;
      }
      case "tool.call": {
        const toolCallId = str(p.toolCallId) ?? `${row.seq ?? row.rowId}`;
        const name = sanitizeField(p.name, "tool", dropped) ?? "";
        pending.set(toolCallId, {
          rowId: row.rowId,
          seq: row.seq ?? 0,
          at: row.time,
          name,
          argsChars: charsOf(p.arguments),
          source: row.kind,
          ...(row.agentId ? { agentId: row.agentId } : {}),
          dimension: dimensionOf(row),
        });
        // board_upsert 是「可判定事件」:白板写入决策本身进 decision 面。
        if (name === "board_upsert") {
          events.push({
            ...envelope(row),
            kind: "decision",
            what: "board_upsert",
            tool: name,
          });
          mappedRows.add(row.rowId);
        }
        break;
      }
      case "tool.result": {
        const toolCallId = str(p.toolCallId);
        const call = toolCallId ? pending.get(toolCallId) : undefined;
        if (toolCallId) pending.delete(toolCallId);
        const name = sanitizeField(p.name, "tool", dropped) ?? call?.name ?? "";
        const ok = !p.error;
        const dim: TraceDimension = { ...(call?.dimension ?? dimensionOf(row)) };
        // 结果行的 turn/step 更贴近「完成时刻」,有就用它覆盖。
        const turn = num(p.turn);
        const step = num(p.step);
        if (turn !== undefined) dim.turn = turn;
        if (step !== undefined) dim.step = step;
        events.push({
          ...envelope(row),
          kind: "tool",
          name,
          ok,
          durationMs: num(p.durationMs) ?? 0,
          argsChars: call?.argsChars ?? 0,
          resultChars: charsOf(p.content),
          dimension: dim,
        });
        mappedRows.add(row.rowId);
        // 配对的 call 行同样算「已映射」:它的信息进了这条 tool 事件(argsChars/name/dim)。
        if (call) mappedRows.add(call.rowId);
        break;
      }
      case "llm.trace": {
        const usage = asObject(p.usage);
        if (!usage) break; // 缺 usage 不推断
        const input = num(usage.inputTokens) ?? num(usage.prompt_tokens);
        const output = num(usage.outputTokens) ?? num(usage.completion_tokens);
        const total = num(usage.totalTokens) ?? num(usage.total_tokens);
        if (input === undefined && output === undefined && total === undefined) break;
        events.push({
          ...envelope(row),
          kind: "token",
          input: input ?? 0,
          output: output ?? 0,
          total: total ?? (input ?? 0) + (output ?? 0),
          cached: num(usage.cachedTokens) ?? num(usage.cached_tokens) ?? 0,
        });
        mappedRows.add(row.rowId);
        break;
      }
      case "custom": {
        const what = str(p.what) ?? str(p.type);
        if (what === "telemetry.phase") {
          const rawSpans = Array.isArray(p.spans) ? p.spans : [];
          const spans: PhaseSpan[] = [];
          for (const rawSpan of rawSpans) {
            const sp = asObject(rawSpan);
            if (!sp) continue;
            spans.push({
              name: sanitizeField(sp.name, "span.name", dropped) ?? "",
              ms: num(sp.ms) ?? 0,
              status: sanitizeField(sp.status, "span.status", dropped) ?? "",
            });
          }
          const quality = sanitizeField(p.quality, "quality", dropped);
          events.push({ ...envelope(row), kind: "phase", spans, ...(quality ? { quality } : {}) });
          mappedRows.add(row.rowId);
          break;
        }
        const decisionWhat = decisionWhatOf(p);
        if (!decisionWhat) break;
        const effect = sanitizeField(p.effect, "effect", dropped);
        const tool = sanitizeField(p.tool, "tool", dropped);
        events.push({
          ...envelope(row),
          kind: "decision",
          what: sanitizeField(decisionWhat, "what", dropped) ?? "",
          ...(effect ? { effect } : {}),
          ...(tool ? { tool } : {}),
        });
        mappedRows.add(row.rowId);
        break;
      }
      case "permission.gate": {
        const effect = sanitizeField(p.effect, "effect", dropped);
        const tool = sanitizeField(p.tool, "tool", dropped);
        events.push({
          ...envelope(row),
          kind: "decision",
          what: "permission.gate",
          ...(effect ? { effect } : {}),
          ...(tool ? { tool } : {}),
        });
        mappedRows.add(row.rowId);
        break;
      }
      case "tip.injected": {
        const keys = Array.isArray(p.keys) ? p.keys.filter((k): k is string => typeof k === "string") : [];
        const key = sanitizeField(keys.join("|"), "key", dropped);
        events.push({
          ...envelope(row),
          kind: "decision",
          what: "tip.injected",
          ...(key ? { key } : {}),
        });
        mappedRows.add(row.rowId);
        break;
      }
      default:
        break; // 未知 kind:留给 unmappedByKind
    }
  }

  // ── 4. 只有 call 没有 result 的工具:按失败收尾(不丢行)──────────────────
  for (const call of pending.values()) {
    events.push({
      seq: call.seq,
      at: call.at,
      source: call.source,
      ...(call.agentId ? { agentId: call.agentId } : {}),
      dimension: call.dimension,
      kind: "tool",
      name: call.name,
      ok: false,
      durationMs: 0,
      argsChars: call.argsChars,
      resultChars: 0,
    });
    mappedRows.add(call.rowId);
  }

  // ── 5. 未映射计数 + 覆盖率 ────────────────────────────────────────────────
  const unmappedByKind: Record<string, number> = {};
  for (const row of rows) {
    if (mappedRows.has(row.rowId)) continue;
    bump(unmappedByKind, row.kind);
  }
  if (invalidRows > 0) unmappedByKind["<invalid>"] = invalidRows;

  const denominator = inputEvents - duplicateSeqs;
  const coverage: TraceCoverage = {
    inputEvents,
    duplicateSeqs,
    mappedEvents: mappedRows.size,
    unmappedByKind,
    coverageRate: denominator > 0 ? mappedRows.size / denominator : 0,
  };

  // ── 6. 批次键 ────────────────────────────────────────────────────────────
  const distinctSessions = [...new Set(rows.map((r) => r.sessionId))].sort();
  const seqs = rows.map((r) => r.seq).filter((s): s is number => s !== undefined);
  const sessionId = opts.sessionId ?? distinctSessions.join(",");
  const seqStart = opts.seqStart ?? (seqs.length ? Math.min(...seqs) : 0);
  const seqEnd = opts.seqEnd ?? (seqs.length ? Math.max(...seqs) : 0);
  const batchKey = traceBatchKey({ sessionId, seqStart, seqEnd, ruleVersion: opts.ruleVersion, contractVersion });

  return {
    version: contractVersion,
    ruleVersion: opts.ruleVersion,
    batchKey,
    events,
    coverage,
    dropped,
  };
}
