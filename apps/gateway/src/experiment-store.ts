/**
 * 实验台账持久层(生产侧,实验台账 2026-11):把 experiment-ledger 的纯逻辑落到 append-only jsonl。
 * 为什么 append-only 而不是读改写整文件:决策是审计事实,不能被后来的写入覆盖或抹掉;
 * 单行追加 + 写后行数校验(重读文件统计非空行数)让「写成功了吗」变成可复核的断言,
 * 而不是信任 appendFileSync 没抛异常。
 * 数据面:`<root>/.genie/experiments/ledger.jsonl`,每行一条
 * - `{type:"record", at, v:1, experiment}` —— 实验本体(台账底账)。
 * - `{type:"decision", at, v:1, id, kind, by?, reason?, resultMetrics?, codes?}` —— 决策/结果指标。
 * 投影语义(loadProjection):
 * - record 建底(同 id 后写覆盖前写);decision 按行序依次套用 → latest wins;
 *   decision 携带的 resultMetrics 按指标名合并进 metrics。
 * - 坏行(JSON 坏 / 未知 v / 缺必需字段)只计入 badLines 并跳过:一行坏不整文件失效、不 throw。
 * 依赖纪律:node:fs / node:path + runtime 的纯逻辑模块;不引 agent loop、不引 gateway 业务模块。
 * runtime 模块按 trace-harvest 的既有套路惰性解析(两跳):
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出的 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 参数错误是唯一允许 throw 的情形(TypeError);IO/投影/闸门失败一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Experiment,
  ExperimentCanary,
  ExperimentDecisionKind,
  ExperimentGuardrail,
  ExperimentHypothesis,
  ExperimentIntervention,
  ExperimentMetric,
  ExperimentRollbackPoint,
  ExperimentStratum,
} from "@lampgenie/runtime/agent/experiment-ledger";

/** 台账稳定码:store 层自产的失败码(闸门码沿用 runtime 的 EXPERIMENT_GATE_CODES)。 */
export const EXPERIMENT_STORE_CODES = [
  "EXP_DUPLICATE",
  "EXP_DUPLICATE_HYPOTHESIS",
  "EXP_NOT_FOUND",
  "EXP_REASON_REQUIRED",
  "EXP_LEDGER_WRITE_VERIFY_FAILED",
  "EXP_STORE_ERROR",
  "EXP_DECISION_KIND_INVALID",
] as const;

export type ExperimentStoreCode = (typeof EXPERIMENT_STORE_CODES)[number];

/** 实验决策类型(不含 pending:pending 是初始态,不是可下发的动作)。 */
export type DecidableKind = Exclude<ExperimentDecisionKind, "pending">;

/** 投影结果:可用实验(按首次出现顺序)+ 坏行/总行计数。 */
export interface ExperimentProjection {
  experiments: Experiment[];
  badLines: number;
  totalLines: number;
}

/** 单次写入结果。 */
export interface StoreResult {
  ok: boolean;
  code?: string;
  id?: string;
}

/** 决策写入结果:codes 为闸门/校验码(空 = 通过)。 */
export interface DecideStoreResult {
  ok: boolean;
  code?: string;
  codes: string[];
}

/** 决策入参(by/reason 可选,resultMetrics 覆盖/补齐指标结果)。 */
export interface DecideStoreOptions {
  reason?: string;
  by?: string;
  resultMetrics?: ExperimentMetric[];
}

/** runtime experiment-ledger 在本文件用到的模块面(与 467 行源文件逐一对齐)。 */
interface LedgerRuntime {
  readonly EXPERIMENT_SCHEMA_VERSION: number;
  normalizeClaim(claim: string): string;
  experimentIdOf(exp: Pick<Experiment, "hypothesis" | "intervention" | "strata">): string;
  evaluateAdoptGate(
    exp: Experiment,
    policy?: { minZ?: number; conflicts?: Array<{ id: string }> },
  ): { ok: boolean; codes: string[]; details: string[] };
  inheritMetricRoles(incoming: ExperimentMetric[], current: ExperimentMetric[]): ExperimentMetric[];
  findConflicts(candidate: Experiment, existing: Experiment[]): Experiment[];
  decideExperiment(
    exp: Experiment,
    kind: DecidableKind,
    opts?: {
      by?: string;
      reason?: string;
      at?: number;
      resultMetrics?: ExperimentMetric[];
      conflicts?: Array<{ id: string }>;
    },
  ): { ok: boolean; codes: string[]; experiment?: Experiment };
  filterByStratum(
    experiments: Experiment[],
    f: { projectId?: string; taskClass?: string; model?: string; window?: { from: string; to: string } },
  ): Experiment[];
}

let ledgerRuntime: LedgerRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadLedgerRuntime(): Promise<LedgerRuntime> {
  if (ledgerRuntime) return ledgerRuntime;
  const spec = "@lampgenie/runtime/agent/experiment-ledger";
  try {
    ledgerRuntime = (await import(spec)) as LedgerRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/experiment-ledger.ts", import.meta.url).href;
    ledgerRuntime = (await import(srcUrl)) as LedgerRuntime;
  }
  return ledgerRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadLedgerRuntime();

/** 台账 schema 版本(与 runtime 同源)。 */
const SCHEMA_VERSION = rt.EXPERIMENT_SCHEMA_VERSION;

/** 台账文件绝对路径:`<root>/.genie/experiments/ledger.jsonl`。 */
export function experimentLedgerPath(root: string): string {
  return join(root, ".genie", "experiments", "ledger.jsonl");
}

const DECISION_KINDS: ReadonlySet<string> = new Set<string>([
  "pending",
  "adopt",
  "reject",
  "iterate",
  "rollback",
]);

const DECIDABLE_KINDS: ReadonlySet<string> = new Set<string>(["adopt", "reject", "iterate", "rollback"]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 时间窗重叠(ISO 字符串比较;任一方缺失视为重叠,与 runtime 口径一致)。 */
function windowsOverlap(
  a: { from: string; to: string } | undefined,
  b: { from: string; to: string } | undefined): boolean {
  if (!a || !b) return true;
  return a.from <= b.to && b.from <= a.to;
}

/** 实验必需字段校验:缺字段/类型不符 → undefined(由调用方计 badLines 并跳过)。 */
function asExperiment(value: unknown): Experiment | undefined {
  if (!isRecord(value)) return undefined;
  const id = value["id"];
  if (typeof id !== "string" || id.trim() === "") return undefined;
  if (typeof value["schemaVersion"] !== "number") return undefined;
  if (typeof value["createdAt"] !== "number" || typeof value["updatedAt"] !== "number") return undefined;

  const hypothesis = value["hypothesis"];
  if (!isRecord(hypothesis) || typeof hypothesis["claim"] !== "string") return undefined;
  const intervention = value["intervention"];
  if (!isRecord(intervention)) return undefined;
  if (
    typeof intervention["surface"] !== "string" ||
    typeof intervention["ref"] !== "string" ||
    typeof intervention["variant"] !== "string"
  ) {
    return undefined;
  }
  const decision = value["decision"];
  if (!isRecord(decision) || typeof decision["kind"] !== "string" || !DECISION_KINDS.has(decision["kind"])) {
    return undefined;
  }
  const rollbackPoint = value["rollbackPoint"];
  if (!isRecord(rollbackPoint) || typeof rollbackPoint["ref"] !== "string") return undefined;
  const canary = value["canary"];
  if (!isRecord(canary) || typeof canary["status"] !== "string") return undefined;

  if (!Array.isArray(value["guardrails"])) return undefined;
  if (!Array.isArray(value["strata"])) return undefined;
  if (!Array.isArray(value["metrics"])) return undefined;
  return value as unknown as Experiment;
}

/** 一条 decision 行(projection 用的最小形状)。 */
interface DecisionLine {
  at: number;
  id: string;
  kind: ExperimentDecisionKind;
  by?: string;
  reason?: string;
  resultMetrics?: ExperimentMetric[];
}

function asDecisionLine(value: UnknownRecord): DecisionLine | undefined {
  const id = value["id"];
  const kind = value["kind"];
  const at = value["at"];
  if (typeof id !== "string" || id.trim() === "") return undefined;
  if (typeof kind !== "string" || !DECISION_KINDS.has(kind)) return undefined;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  const resultMetrics = value["resultMetrics"];
  if (resultMetrics !== undefined && !Array.isArray(resultMetrics)) return undefined;
  const line: DecisionLine = { at, id, kind: kind as ExperimentDecisionKind };
  if (typeof value["by"] === "string") line.by = value["by"];
  if (typeof value["reason"] === "string") line.reason = value["reason"];
  if (Array.isArray(resultMetrics)) line.resultMetrics = resultMetrics as ExperimentMetric[];
  return line;
}

/** 结果指标合并:同名覆盖、新名追加(保持既有顺序)。 */
function mergeMetrics(current: ExperimentMetric[], incoming: ExperimentMetric[]): ExperimentMetric[] {
  const byName = new Map<string, ExperimentMetric>();
  for (const m of current) byName.set(String(m?.name ?? ""), m);
  for (const m of incoming) {
    const name = String(m?.name ?? "");
    const prev = byName.get(name);
    // 结果行可能不带 role:同名指标沿用原记录 role,避免 guardrail 被降级成 success。
    byName.set(name, m.role === undefined && prev?.role !== undefined ? { ...m, role: prev.role } : m);
  }
  return [...byName.values()];
}

/** 把一条 decision 套到实验上(latest wins)。 */
function applyDecision(exp: Experiment, line: DecisionLine): void {
  exp.decision = {
    kind: line.kind,
    at: line.at,
    ...(line.by !== undefined ? { by: line.by } : {}),
    ...(line.reason !== undefined ? { reason: line.reason } : {}),
  };
  exp.updatedAt = line.at;
  if (line.resultMetrics !== undefined) exp.metrics = mergeMetrics(exp.metrics ?? [], line.resultMetrics);
}

/** 读台账非空行数(文件不存在 → 0)。 */
function countLedgerLines(path: string): number {
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

/**
 * 追加一行并做写后行数校验:重读文件统计非空行数,必须等于「写前行数 + 1」。
 * 校验失败返回 false(调用方折叠成 EXP_LEDGER_WRITE_VERIFY_FAILED);不回滚已写内容、不 throw。
 */
function appendLedgerLine(root: string, line: UnknownRecord): boolean {
  const path = experimentLedgerPath(root);
  const before = countLedgerLines(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    return false;
  }
  return countLedgerLines(path) === before + 1;
}

/**
 * 投影:record 建底(同 id 后写覆盖)+ decision 按行序套用(latest wins)。
 * 坏行只计 badLines,绝不让整文件失效、不 throw。
 */
export function loadProjection(root: string): ExperimentProjection {
  const path = experimentLedgerPath(root);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { experiments: [], badLines: 0, totalLines: 0 };
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const byId = new Map<string, Experiment>();
  const order: string[] = [];
  const decisions = new Map<string, DecisionLine[]>();
  let badLines = 0;
  let totalLines = 0;

  for (const raw of lines) {
    if (raw.trim() === "") continue;
    totalLines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      badLines += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      badLines += 1;
      continue;
    }
    if (parsed["v"] !== SCHEMA_VERSION) {
      badLines += 1;
      continue;
    }
    const type = parsed["type"];
    if (type === "record") {
      const exp = asExperiment(parsed["experiment"]);
      if (!exp) {
        badLines += 1;
        continue;
      }
      if (!byId.has(exp.id)) order.push(exp.id);
      byId.set(exp.id, exp);
      continue;
    }
    if (type === "decision") {
      const line = asDecisionLine(parsed);
      if (!line) {
        badLines += 1;
        continue;
      }
      const bucket = decisions.get(line.id);
      if (bucket) bucket.push(line);
      else decisions.set(line.id, [line]);
      continue;
    }
    badLines += 1;
  }

  // 孤儿 decision(无对应 record)忽略:投影只产出能建底的实验。
  for (const [id, bucket] of decisions) {
    const exp = byId.get(id);
    if (!exp) continue;
    for (const line of bucket) applyDecision(exp, line);
  }

  const experiments: Experiment[] = [];
  for (const id of order) {
    const exp = byId.get(id);
    if (exp) experiments.push(exp);
  }
  return { experiments, badLines, totalLines };
}

/** 重复假设判定:规范化 claim 相同且 strata 时间窗重叠(不看 ref/variant)。 */
function sameHypothesis(a: Experiment, b: Experiment): boolean {
  if (rt.normalizeClaim(a.hypothesis.claim) !== rt.normalizeClaim(b.hypothesis.claim)) return false;
  const sa = Array.isArray(a.strata) ? a.strata : [];
  const sb = Array.isArray(b.strata) ? b.strata : [];
  if (sa.length === 0 || sb.length === 0) return true;
  return sa.some((x) => sb.some((y) => windowsOverlap(x?.window, y?.window)));
}

/**
 * 记录一条实验。
 * - 参数非法(非对象 / hypothesis.claim 空 / intervention.ref 空)→ TypeError(唯一允许 throw 的情形)。
 * - id 缺省由 experimentIdOf 补齐;schemaVersion/createdAt/updatedAt 缺省补齐。
 * - 同 id 已存在(无论状态)→ `{ok:false, code:"EXP_DUPLICATE"}`。
 * - 同假设(规范化 claim + strata 重叠)已存在 → `{ok:false, code:"EXP_DUPLICATE_HYPOTHESIS"}`。
 * - 成功 → `{ok:true, id}`。
 */
export function recordExperiment(root: string, exp: unknown): StoreResult {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError("recordExperiment: root 必须是非空字符串");
  if (!isRecord(exp)) throw new TypeError("recordExperiment: 实验必须是对象");
  const hypothesisRaw = exp["hypothesis"];
  if (!isRecord(hypothesisRaw) || typeof hypothesisRaw["claim"] !== "string" || hypothesisRaw["claim"].trim() === "") {
    throw new TypeError("recordExperiment: hypothesis.claim 不能为空");
  }
  const interventionRaw = exp["intervention"];
  if (!isRecord(interventionRaw) || typeof interventionRaw["ref"] !== "string" || interventionRaw["ref"].trim() === "") {
    throw new TypeError("recordExperiment: intervention.ref 不能为空");
  }

  try {
    const now = Date.now();
    const base = exp as unknown as Partial<Experiment>;
    const hypothesis = hypothesisRaw as unknown as ExperimentHypothesis;
    const intervention = interventionRaw as unknown as ExperimentIntervention;
    const draft: Experiment = {
      ...(base as Experiment),
      id: typeof base.id === "string" && base.id.trim() !== "" ? base.id.trim() : "",
      schemaVersion: typeof base.schemaVersion === "number" ? base.schemaVersion : SCHEMA_VERSION,
      hypothesis: { ...hypothesis, claim: hypothesis.claim.trim() },
      intervention: { ...intervention, ref: intervention.ref.trim() },
      guardrails: Array.isArray(base.guardrails) ? (base.guardrails as ExperimentGuardrail[]) : [],
      canary: (base.canary as ExperimentCanary | undefined) ?? { scope: "session", sessions: 0, status: "pending" },
      strata: Array.isArray(base.strata) ? (base.strata as ExperimentStratum[]) : [],
      metrics: Array.isArray(base.metrics) ? (base.metrics as ExperimentMetric[]) : [],
      rollbackPoint: (base.rollbackPoint as ExperimentRollbackPoint | undefined) ?? { kind: "flag", ref: "" },
      decision: base.decision ?? { kind: "pending" },
      createdAt: typeof base.createdAt === "number" ? base.createdAt : now,
      updatedAt: typeof base.updatedAt === "number" ? base.updatedAt : now,
    };
    const id = draft.id !== "" ? draft.id : rt.experimentIdOf(draft);
    draft.id = id;

    const projection = loadProjection(root);
    if (projection.experiments.some((e) => e.id === id)) return { ok: false, code: "EXP_DUPLICATE", id };
    if (projection.experiments.some((e) => sameHypothesis(e, draft))) {
      return { ok: false, code: "EXP_DUPLICATE_HYPOTHESIS", id };
    }

    const line: UnknownRecord = { type: "record", at: draft.createdAt, v: SCHEMA_VERSION, experiment: draft };
    if (!appendLedgerLine(root, line)) return { ok: false, code: "EXP_LEDGER_WRITE_VERIFY_FAILED", id };
    return { ok: true, id };
  } catch {
    return { ok: false, code: "EXP_STORE_ERROR" };
  }
}

/**
 * 写入决策。
 * - adopt:先算 conflicts(同面同 ref 已 adopt 的其他实验),再过 decidePure 的采纳闸;
 *   闸门不过 → `{ok:false, codes}` 且**不写 decision 行**。
 * - reject/iterate/rollback:reason 空白 → EXP_REASON_REQUIRED(同样不写行)。
 * - 写盘/行数校验失败 → EXP_LEDGER_WRITE_VERIFY_FAILED。除参数错误外不 throw。
 */
export function decideExperiment(
  root: string,
  id: string,
  kind: DecidableKind,
  opts: DecideStoreOptions = {},
): DecideStoreResult {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError("decideExperiment: root 必须是非空字符串");
  if (typeof id !== "string") throw new TypeError("decideExperiment: id 必须是字符串");
  if (id.trim() === "") return { ok: false, code: "EXP_NOT_FOUND", codes: [] };
  if (!DECIDABLE_KINDS.has(String(kind))) {
    return { ok: false, code: "EXP_DECISION_KIND_INVALID", codes: ["EXP_DECISION_KIND_INVALID"] };
  }

  try {
    const projection = loadProjection(root);
    const current = projection.experiments.find((e) => e.id === id);
    if (!current) return { ok: false, code: "EXP_NOT_FOUND", codes: [] };

    let decidedAt = Date.now();
    let decidedReason = opts.reason;
    // 结果文件不带 role 时按指标名沿用原记录 role(guardrail 不得被降级成 success)。
    const resultMetrics =
      opts.resultMetrics !== undefined ? rt.inheritMetricRoles(opts.resultMetrics, current.metrics ?? []) : undefined;
    if (kind === "adopt") {
      const candidate: Experiment = resultMetrics !== undefined ? { ...current, metrics: resultMetrics } : current;
      const conflicts = rt.findConflicts(candidate, projection.experiments);
      const gate = rt.decideExperiment(candidate, "adopt", {
        by: opts.by,
        reason: opts.reason,
        resultMetrics: opts.resultMetrics,
        conflicts,
      });
      if (!gate.ok) return { ok: false, code: gate.codes[0], codes: gate.codes };
      decidedAt = gate.experiment?.decision.at ?? decidedAt;
      decidedReason = gate.experiment?.decision.reason ?? decidedReason;
    } else {
      const gate = rt.decideExperiment(current, kind, {
        by: opts.by,
        reason: opts.reason,
        resultMetrics: opts.resultMetrics,
      });
      if (!gate.ok) return { ok: false, code: gate.codes[0], codes: gate.codes };
      decidedAt = gate.experiment?.decision.at ?? decidedAt;
      decidedReason = gate.experiment?.decision.reason ?? decidedReason;
    }

    const line: UnknownRecord = {
      type: "decision",
      at: decidedAt,
      v: SCHEMA_VERSION,
      id,
      kind,
      codes: [] as string[],
    };
    if (opts.by !== undefined) line["by"] = opts.by;
    if (decidedReason !== undefined) line["reason"] = decidedReason;
    if (opts.resultMetrics !== undefined) line["resultMetrics"] = opts.resultMetrics;

    if (!appendLedgerLine(root, line)) return { ok: false, code: "EXP_LEDGER_WRITE_VERIFY_FAILED", codes: [] };
    return { ok: true, codes: [] };
  } catch {
    return { ok: false, code: "EXP_STORE_ERROR", codes: [] };
  }
}

/** 按分层(projectId/taskClass/model/window)+ decision 过滤实验。 */
export function listExperiments(
  root: string,
  filter?: {
    projectId?: string;
    taskClass?: string;
    model?: string;
    window?: { from: string; to: string };
    decision?: string;
  },
): Experiment[] {
  const all = loadProjection(root).experiments;
  if (!filter) return all;
  const { decision, ...stratumFilter } = filter;
  let out = rt.filterByStratum(all, stratumFilter);
  if (decision !== undefined) out = out.filter((e) => e.decision.kind === decision);
  return out;
}

/** 按 id 取单条实验(投影语义,decision 已是最新)。 */
export function getExperiment(root: string, id: string): Experiment | undefined {
  return loadProjection(root).experiments.find((e) => e.id === id);
}

/** 台账汇总报告:决策/面/分层分布 + 冲突对数 + 坏行数。 */
export function reportExperiments(root: string): {
  total: number;
  byDecision: Record<string, number>;
  bySurface: Record<string, number>;
  byStratum: {
    projectId: Record<string, number>;
    taskClass: Record<string, number>;
    model: Record<string, number>;
  };
  conflicts: number;
  parseErrors: number;
} {
  const projection = loadProjection(root);
  const byDecision: Record<string, number> = {};
  const bySurface: Record<string, number> = {};
  const projectId: Record<string, number> = {};
  const taskClass: Record<string, number> = {};
  const model: Record<string, number> = {};
  const bump = (bag: Record<string, number>, key: string): void => {
    bag[key] = (bag[key] ?? 0) + 1;
  };

  for (const exp of projection.experiments) {
    bump(byDecision, exp.decision.kind);
    bump(bySurface, exp.intervention.surface);
    const seen = { projectId: new Set<string>(), taskClass: new Set<string>(), model: new Set<string>() };
    for (const s of exp.strata ?? []) {
      if (s?.projectId !== undefined) seen.projectId.add(s.projectId);
      if (s?.taskClass !== undefined) seen.taskClass.add(s.taskClass);
      if (s?.model !== undefined) seen.model.add(s.model);
    }
    for (const key of seen.projectId) bump(projectId, key);
    for (const key of seen.taskClass) bump(taskClass, key);
    for (const key of seen.model) bump(model, key);
  }

  // 冲突:两两 adopt 且同 surface+ref+窗口重叠的对数(按无序对去重)。
  const adopted = projection.experiments.filter((e) => e.decision.kind === "adopt");
  const pairs = new Set<string>();
  for (const exp of adopted) {
    for (const other of rt.findConflicts(exp, adopted)) {
      pairs.add([exp.id, other.id].sort().join("\u0000"));
    }
  }

  return {
    total: projection.experiments.length,
    byDecision,
    bySurface,
    byStratum: { projectId, taskClass, model },
    conflicts: pairs.size,
    parseErrors: projection.badLines,
  };
}
