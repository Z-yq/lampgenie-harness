/**
 * RSI 只读聚合器:把 12 个 RSI 子系统投影折成一份 `RsiStatusSection[]` 状态快照。
 *
 * 依赖纪律(为什么是 lazy import):
 * - 缺省 readers 用 `await import("./xxx-store.js")` 逐区加载。src 内相对动态 import 是既有风格
 *   (见 agent-wiring.ts 多处的 `await import("./board-store.js")`),esbuild 对相对模块的动态 import
 *   会在同一 bundle 内解析并折叠,不破坏 `--format=esm` 单文件产物;而静态 import 会把 13 个 store
 *   及其 runtime 依赖全量拉进任何引用本模块的构建图。
 * - 严格只读:本文件不 mkdir、不写文件。store 缺失一律先 `existsSync` 判定 → `{ok:false, code:"UNAVAILABLE"}`;
 *   读取过程中出现的 ENOENT/任意异常由区级 try/catch 折成 `ERROR`,绝不整体 throw。
 * - 归一化后每区 metrics ≤ 8 条、每区 warnings ≤ 8 条(单条文本截 160 字)。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type RsiStatusTone = "ok" | "warn" | "bad";

export interface RsiStatusMetric {
  label: string;
  value: string | number;
  unit?: string;
  tone?: RsiStatusTone;
}

export interface RsiStatusSection {
  id: string;
  title: string;
  ok: boolean;
  code?: string;
  metrics: RsiStatusMetric[];
  warnings: string[];
  /** 机制开关(2026-11-11 RSI-MECH;缺省=未注入)。 */
  enabled?: boolean;
  /** 驱动方式:agent=派 agent 任务;code=确定性代码/CLI。 */
  driver?: "agent" | "code";
  /** 覆盖层投影后的结果条目(改删只影响覆盖层,不改原生台账)。 */
  items?: RsiStatusResultItem[];
  /** 最近一次运行摘要。 */
  run?: RsiStatusRunInfo;
}

/** 结果条目(与 protocol RsiResultItemZ / rsi-mechanism-store RsiResultItem 同形)。 */
export interface RsiStatusResultItem {
  id: string;
  title: string;
  summary: string;
  detail?: string;
  status?: "ok" | "warn" | "bad" | "info";
  source?: "agent" | "code" | "manual";
  at?: number;
}

/** 机制最近一次运行摘要。 */
export interface RsiStatusRunInfo {
  runId?: string;
  taskId?: string;
  status: "running" | "done" | "failed";
  /** 任务真实状态(queued/running/…):排队时 status 仍是 running,面板据此显示「排队中」。 */
  taskState?: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  /** 本次运行成本(2026-11-12 RSI-SESSION-COST;旧数据无此字段)。 */
  cost?: RsiStatusRunCost;
  /** 本次运行的会话分析计划与认账(旧数据无此字段)。 */
  analysis?: RsiStatusRunAnalysis;
  /** 2026-11-13 RSI-SELF-DRIVE:自动周期/重试/预算/质量门(旧数据无这些字段)。 */
  cycleId?: string;
  retryOf?: string;
  retryCount?: number;
  budgetTokens?: number;
  budgetExceeded?: boolean;
  analysisMissing?: boolean;
  /** 2026-11-13 质量契约 v2:结果四件套/浅层/重复/上限评分(旧数据无此字段)。 */
  quality?: RsiStatusRunQuality;
}

/** 结果质量评估(与 protocol RsiRunQualityZ / rsi-mechanism-store RsiRunQuality 同形)。 */
export interface RsiStatusRunQuality {
  items: number;
  evidenced: number;
  impacted: number;
  actionable: number;
  shallow: number;
  duplicates: number;
  overLimit: boolean;
  score: number;
  issues: { code: string; itemId?: string; note: string }[];
}

/** 运行成本(与 protocol RsiRunCostZ / rsi-mechanism-store RsiRunCostRecord 同形)。 */
export interface RsiStatusRunCost {
  inputTokens: number;
  cachedTokens: number;
  cacheCreationTokens?: number;
  outputTokens: number;
  totalTokens: number;
  model?: string;
  /** null=单价缺失(面板写「单价缺失」,不显示 0)。 */
  amountCny: number | null;
  missing: string[];
}

/** 运行与会话分析的关系(与 protocol RsiRunAnalysisZ 同形)。 */
export interface RsiStatusRunAnalysis {
  windowDays: number;
  candidates: { sessionId: string; projectId?: string; lastActiveAt?: number }[];
  analyzed: { sessionId: string; projectId?: string }[];
}

/** reader 返回值:允许 partial / 空 / undefined(readers 可注入普通函数或 async 函数)。 */
export type RsiSectionResult = Partial<RsiStatusSection> | undefined | null;
export type RsiSectionReader = (root: string) => RsiSectionResult | Promise<RsiSectionResult>;

export interface RsiStatusReaders {
  nightly: RsiSectionReader;
  evidence: RsiSectionReader;
  experiments: RsiSectionReader;
  cost: RsiSectionReader;
  injection: RsiSectionReader;
  tools: RsiSectionReader;
  changeRequests: RsiSectionReader;
  cohort: RsiSectionReader;
  negativeKb: RsiSectionReader;
  prompts: RsiSectionReader;
  atlas: RsiSectionReader;
  pathology: RsiSectionReader;
}

/** 固定顺序(协议面):sections 数组永远按这个序输出。 */
export const RSI_SECTION_IDS = [
  "nightly",
  "evidence",
  "experiments",
  "cost",
  "injection",
  "tools",
  "changeRequests",
  "cohort",
  "negativeKb",
  "prompts",
  "atlas",
  "pathology",
] as const;

export type RsiSectionId = (typeof RSI_SECTION_IDS)[number];

/** 中文短名(id 与 title 一一对应)。 */
export const RSI_SECTION_TITLES: Record<RsiSectionId, string> = {
  nightly: "夜间任务",
  evidence: "证据图",
  experiments: "实验",
  cost: "成本与熔断",
  injection: "注入防护",
  tools: "数据工具",
  changeRequests: "变更请求",
  cohort: "同批指标",
  negativeKb: "负面知识",
  prompts: "提示词版本",
  atlas: "方向图",
  pathology: "病理目录",
};

const MAX_METRICS = 8;
const MAX_WARNINGS = 8;
const MAX_TEXT = 160;

// ------------------------------------------------------------------ 归一化

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, limit = MAX_TEXT): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message === "" ? err.name : err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

function toneOf(raw: unknown): RsiStatusTone {
  return raw === "warn" || raw === "bad" || raw === "ok" ? raw : "ok";
}

function metricValue(value: unknown): string | number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return undefined;
  try {
    return String(value);
  } catch {
    return undefined;
  }
}

function normalizeMetrics(raw: unknown): RsiStatusMetric[] {
  if (!Array.isArray(raw)) return [];
  const out: RsiStatusMetric[] = [];
  for (const item of raw) {
    if (out.length >= MAX_METRICS) break;
    if (!isRecord(item)) continue;
    const label = typeof item["label"] === "string" ? item["label"].trim() : "";
    if (label === "") continue;
    const value = metricValue(item["value"]);
    if (value === undefined) continue;
    const metric: RsiStatusMetric = { label, value, tone: toneOf(item["tone"]) };
    const unit = item["unit"];
    if (typeof unit === "string" && unit !== "") metric.unit = unit;
    out.push(metric);
  }
  return out;
}

function normalizeWarnings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (out.length >= MAX_WARNINGS) break;
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (text === "") continue;
    out.push(truncate(text));
  }
  return out;
}

function unavailable(id: RsiSectionId, reason: string): RsiStatusSection {
  return {
    id,
    title: RSI_SECTION_TITLES[id],
    ok: false,
    code: "UNAVAILABLE",
    metrics: [],
    warnings: [truncate(reason)],
  };
}

function normalizeSection(id: RsiSectionId, raw: RsiSectionResult): RsiStatusSection {
  if (raw === undefined || raw === null || !isRecord(raw)) return unavailable(id, `${RSI_SECTION_TITLES[id]}:无数据`);
  const keys = Object.keys(raw);
  if (keys.length === 0) return unavailable(id, `${RSI_SECTION_TITLES[id]}:无数据`);
  const metrics = normalizeMetrics(raw["metrics"]);
  const warnings = normalizeWarnings(raw["warnings"]);
  const code = typeof raw["code"] === "string" && raw["code"].trim() !== "" ? raw["code"].trim() : undefined;
  if (raw["ok"] === true) {
    return { id, title: RSI_SECTION_TITLES[id], ok: true, metrics, warnings };
  }
  return {
    id,
    title: RSI_SECTION_TITLES[id],
    ok: false,
    code: code ?? "UNAVAILABLE",
    metrics,
    warnings,
  };
}

async function runSection(id: RsiSectionId, reader: RsiSectionReader, root: string): Promise<RsiStatusSection> {
  try {
    const raw = await reader(root);
    return normalizeSection(id, raw);
  } catch (err) {
    return {
      id,
      title: RSI_SECTION_TITLES[id],
      ok: false,
      code: "ERROR",
      metrics: [],
      warnings: [truncate(errorText(err))],
    };
  }
}

// ------------------------------------------------------------------ 只读小工具

function safeRoot(root: unknown): string | undefined {
  if (typeof root !== "string") return undefined;
  return root.trim() === "" ? undefined : root;
}

/** 从 xxxPaths(root) 的返回对象里挑出第一个 `.jsonl` 台账路径(不依赖具体字段名)。 */
function firstJsonlPath(paths: unknown): string | undefined {
  if (!isRecord(paths)) return undefined;
  for (const value of Object.values(paths)) {
    if (typeof value === "string" && value.endsWith(".jsonl")) return value;
  }
  return undefined;
}

function toneOfCount(value: number): RsiStatusTone {
  return value > 0 ? "bad" : "ok";
}

// ------------------------------------------------------------------ 缺省 readers

async function readNightly(root: string): Promise<RsiSectionResult> {
  const base = safeRoot(root);
  if (base === undefined) return undefined;
  if (!existsSync(join(base, ".genie", "rsi", "nightly"))) return undefined;
  const { listRuns } = await import("./nightly-store.js");
  const runs = await listRuns(base);
  const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
  if (last === undefined) {
    return {
      ok: true,
      metrics: [
        { label: "运行数", value: 0, tone: "warn" },
        { label: "最近状态", value: "none", tone: "warn" },
      ],
      warnings: ["夜间任务目录存在但无 run 记录"],
    };
  }
  const status = String(last.status);
  const done = status === "done";
  // :完成度可观测——不再只报一个 status,补步骤进度/会话覆盖/在跑步骤。
  const steps = Array.isArray(last.steps) ? last.steps : [];
  const doneSteps = steps.filter((step) => step !== null && typeof step === "object" && (step.status === "done" || step.status === "skipped")).length;
  const runningStep = steps.find((step) => step !== null && typeof step === "object" && step.status === "running");
  const coverage = last.coverage;
  const processed = typeof coverage?.sessionsProcessed === "number" ? coverage.sessionsProcessed : 0;
  const total = typeof coverage?.sessionsTotal === "number" ? coverage.sessionsTotal : 0;
  const inFlight = status === "pending" || status === "running";
  const warnings: string[] = [];
  if (!done) {
    warnings.push(
      inFlight
        ? `最近一次夜间运行进行中(${status}):步骤 ${doneSteps}/${steps.length}${runningStep === undefined ? "" : `,当前 ${String(runningStep.name)}`};覆盖 ${processed}/${total};起点 ${String(last.createdAt ?? "?")}`
        : `最近一次夜间运行状态为 ${status}${typeof last.error === "string" ? `(${last.error})` : ""}`,
    );
  }
  return {
    ok: done,
    code: done ? undefined : inFlight ? "IN_PROGRESS" : "NOT_DONE",
    metrics: [
      { label: "最近状态", value: status, tone: done ? "ok" : status === "failed" ? "bad" : "warn" },
      { label: "最近日期", value: last.date },
      { label: "最近项目", value: last.projectId },
      { label: "运行数", value: runs.length, tone: "ok" },
      { label: "步骤数", value: steps.length },
      { label: "步骤完成", value: `${doneSteps}/${steps.length}`, tone: done ? "ok" : doneSteps > 0 ? "warn" : "bad" },
      { label: "会话覆盖", value: `${processed}/${total}`, tone: processed > 0 ? "ok" : "warn" },
    ],
    warnings,
  };
}

async function readEvidence(root: string): Promise<RsiSectionResult> {
  const base = safeRoot(root);
  if (base === undefined) return undefined;
  const { evidenceGraphPath, reportEvidence } = await import("./evidence-graph-store.js");
  if (!existsSync(evidenceGraphPath(base))) return undefined;
  const rep = reportEvidence(base);
  const conflicts = rep.conflicts;
  const parseErrors = rep.parseErrors;
  const ok = conflicts === 0 && parseErrors === 0;
  const warnings: string[] = [];
  if (conflicts > 0) warnings.push(`${conflicts} 个证据冲突待裁决`);
  if (parseErrors > 0) warnings.push(`${parseErrors} 行坏行`);
  return {
    ok,
    code: ok ? undefined : parseErrors > 0 ? "PARSE_ERRORS" : "CONFLICTS",
    metrics: [
      { label: "节点", value: rep.nodes },
      { label: "活跃", value: rep.active, tone: "ok" },
      { label: "陈旧", value: rep.stale, tone: rep.stale > 0 ? "warn" : "ok" },
      { label: "冲突", value: conflicts, tone: toneOfCount(conflicts) },
      { label: "坏行", value: parseErrors, tone: parseErrors > 0 ? "warn" : "ok" },
    ],
    warnings,
  };
}

async function readExperiments(root: string): Promise<RsiSectionResult> {
  const base = safeRoot(root);
  if (base === undefined) return undefined;
  const { experimentLedgerPath, reportExperiments } = await import("./experiment-store.js");
  if (!existsSync(experimentLedgerPath(base))) return undefined;
  const rep = reportExperiments(base);
  const by = rep.byDecision;
  const pending = by["pending"] ?? 0;
  const conflicts = rep.conflicts;
  const ok = conflicts === 0 && rep.parseErrors === 0;
  const warnings: string[] = [];
  if (conflicts > 0) warnings.push(`${conflicts} 条实验决策冲突`);
  if (rep.parseErrors > 0) warnings.push(`${rep.parseErrors} 行坏行`);
  if (rep.total === 0) warnings.push("无实验记录");
  return {
    ok,
    code: ok ? undefined : conflicts > 0 ? "CONFLICTS" : "PARSE_ERRORS",
    metrics: [
      { label: "总数", value: rep.total },
      { label: "待决", value: pending, tone: pending > 0 ? "warn" : "ok" },
      { label: "采纳", value: by["adopt"] ?? 0 },
      { label: "否决", value: by["reject"] ?? 0 },
      { label: "迭代", value: by["iterate"] ?? 0 },
      { label: "回滚", value: by["rollback"] ?? 0, tone: (by["rollback"] ?? 0) > 0 ? "warn" : "ok" },
      { label: "冲突", value: conflicts, tone: toneOfCount(conflicts) },
    ],
    warnings,
  };
}

async function readCost(root: string): Promise<RsiSectionResult> {
  const base = safeRoot(root);
  if (base === undefined) return undefined;
  const { costPaths, reportCost } = await import("./rsi-cost-store.js");
  if (!existsSync(costPaths(base).file)) return undefined;
  const rep = reportCost(base);
  const totals = rep.totals;
  const net = totals.netTokens;

  let paused = false;
  let breakerNote: string | undefined;
  try {
    const { breakerPaths, reportBreaker } = await import("./rsi-breaker-store.js");
    if (existsSync(breakerPaths(base).file)) {
      const breaker = await reportBreaker(base);
      paused = isRecord(breaker.state) && breaker.state["paused"] === true;
    } else {
      breakerNote = "熔断台账缺失(按未熔断处理)";
    }
  } catch (err) {
    breakerNote = `熔断台账读取失败: ${errorText(err)}`;
  }

  const reports = Array.isArray(rep.reports) ? rep.reports : [];
  let consecutiveNegative = 0;
  for (let i = reports.length - 1; i >= 0; i -= 1) {
    const cycle: unknown = reports[i];
    const cycleNet = isRecord(cycle) ? cycle["netTokens"] : undefined;
    if (typeof cycleNet === "number" && cycleNet < 0) consecutiveNegative += 1;
    else break;
  }
  const lastGate: unknown = rep.lastGate;
  const downshift = isRecord(lastGate) && typeof lastGate["action"] === "string" ? lastGate["action"] : "none";

  const warnings: string[] = [];
  if (breakerNote !== undefined) warnings.push(breakerNote);
  if (!rep.ok) warnings.push(`台账码: ${rep.codes.length > 0 ? rep.codes.join(",") : "RSI_COST_STORE_ERROR"}`);
  if (rep.badLines > 0) warnings.push(`${rep.badLines} 行坏行`);

  const ok = rep.ok && !paused && consecutiveNegative === 0;
  const code = rep.ok
    ? paused
      ? "BREAKER_PAUSED"
      : consecutiveNegative > 0
        ? "NEGATIVE_CYCLES"
        : rep.badLines > 0
          ? "BAD_LINES"
          : undefined
    : (rep.codes[0] ?? "RSI_COST_STORE_ERROR");

  return {
    ok,
    code,
    metrics: [
      { label: "成本", value: totals.costTokens, unit: "tok" },
      { label: "节省", value: totals.savingTokens, unit: "tok", tone: "ok" },
      { label: "净收益", value: net, unit: "tok", tone: net < 0 ? "bad" : "ok" },
      { label: "ROI", value: totals.roi === null ? "n/a" : totals.roi, tone: totals.roi === null ? "warn" : "ok" },
      { label: "熔断", value: paused ? "paused" : "closed", tone: paused ? "bad" : "ok" },
      { label: "最近降档", value: downshift, tone: downshift === "none" ? "ok" : "warn" },
      { label: "连续负周期", value: consecutiveNegative, tone: toneOfCount(consecutiveNegative) },
      { label: "周期数", value: reports.length },
    ],
    warnings,
  };
}

async function readInjection(root: string): Promise<RsiSectionResult> {
  const base = safeRoot(root);
  if (base === undefined) return undefined;
  const mod = await import("./rsi-injection-store.js");
  const ledger = firstJsonlPath(mod.injectionPaths(base));
  if (ledger === undefined || !existsSync(ledger)) return undefined;
  const rep = mod.reportInjections(base);
  const quarantined = Object.entries(rep.byCode)
    .filter(([code]) => code.toUpperCase().includes("QUARANTINE"))
    .reduce((sum, [, count]) => sum + (typeof count === "number" ? count : 0), 0);
  const pending = rep.pendingApproval;
  const ok = pending === 0 && rep.corruptLines === 0;
  const warnings: string[] = [];
  if (pending > 0) warnings.push(`${pending} 条高风险注入待批`);
  if (rep.corruptLines > 0) warnings.push(`${rep.corruptLines} 行坏行`);
  return {
    ok,
    code: ok ? undefined : pending > 0 ? "PENDING_APPROVAL" : "CORRUPT_LINES",
    metrics: [
      { label: "待批", value: pending, tone: pending > 0 ? "bad" : "ok" },
      { label: "隔离", value: quarantined, tone: quarantined > 0 ? "warn" : "ok" },
      { label: "黑名单源", value: rep.blacklisted.length, tone: rep.blacklisted.length > 0 ? "warn" : "ok" },
      { label: "评估次数", value: rep.total },
      { label: "坏行", value: rep.corruptLines, tone: rep.corruptLines > 0 ? "warn" : "ok" },
    ],
    warnings,
  };
}

async function readTools(root: string): Promise<RsiSectionResult> {
  const base = safeRoot(root);
  if (base === undefined) return undefined;
  const { dataToolDir, reportTools } = await import("./data-tool-store.js");
  if (!existsSync(dataToolDir(base))) return undefined;
  const rep = reportTools(base);
  const degraded = Object.keys(rep.degraded).length;
  const pins = Object.keys(rep.pins).length;
  const bad = rep.bad.length;
  const ok = rep.ok && degraded === 0 && bad === 0;
  const warnings: string[] = [];
  if (degraded > 0) warnings.push(`${degraded} 个工具依赖降级`);
  if (bad > 0) warnings.push(`${bad} 个工具文件不可读`);
  return {
    ok,
    code: ok ? undefined : bad > 0 ? "STORE_BAD" : "DEGRADED",
    metrics: [
      { label: "原生", value: rep.native.length, tone: "ok" },
      { label: "数据工具", value: rep.data.length, tone: "ok" },
      { label: "降级", value: degraded, tone: degraded > 0 ? "warn" : "ok" },
      { label: "钉扎", value: pins },
      { label: "文件", value: rep.files.length },
      { label: "坏文件", value: bad, tone: bad > 0 ? "bad" : "ok" },
    ],
    warnings,
  };
}

async function readChangeRequests(root: string): Promise<RsiSectionResult> {
  const base = safeRoot(root);
  if (base === undefined) return undefined;
  const { changeRequestsPath, reportRequests } = await import("./change-request-store.js");
  if (!existsSync(changeRequestsPath(base))) return undefined;
  const rep = reportRequests(base);
  const by = rep.byStatus;
  const ok = rep.parseErrors === 0;
  const warnings: string[] = [];
  if (rep.parseErrors > 0) warnings.push(`${rep.parseErrors} 行坏行`);
  if (rep.total === 0) warnings.push("无变更请求");
  if (rep.openAged.count > 0) warnings.push(`${rep.openAged.count} 条请求滞留超过 ${rep.openAged.olderThanDays} 天`);
  return {
    ok,
    code: ok ? undefined : "PARSE_ERRORS",
    metrics: [
      { label: "总数", value: rep.total },
      { label: "提议", value: by["proposed"] ?? 0, tone: "warn" },
      { label: "受理", value: by["accepted"] ?? 0 },
      { label: "排期", value: by["scheduled"] ?? 0 },
      { label: "已发布", value: by["shipped"] ?? 0, tone: "ok" },
      { label: "拒绝", value: by["rejected"] ?? 0 },
      { label: "滞留", value: rep.openAged.count, tone: rep.openAged.count > 0 ? "warn" : "ok" },
    ],
    warnings,
  };
}

async function readCohort(root: string): Promise<RsiSectionResult> {
  const base = safeRoot(root);
  if (base === undefined) return undefined;
  const { cohortMetricsPath, reportCohorts } = await import("./cohort-metrics-store.js");
  if (!existsSync(cohortMetricsPath(base))) return undefined;
  const rep = reportCohorts(base);
  const deliveries = rep.totals.deliveries;
  if (deliveries === 0) {
    return {
      ok: false,
      code: rep.code ?? "NO_DATA",
      metrics: [{ label: "交付数", value: 0, tone: "warn" }],
      warnings: ["同批指标无样本"],
    };
  }
  const firstPassRate = rep.totals.firstPassRate;
  const escapeRate = rep.totals.escapeRate;
  const low = rep.sampleLow.length;
  const warnings: string[] = [];
  if (low > 0) warnings.push(`${low} 个同批样本量偏低`);
  if (rep.codes.length > 0) warnings.push(`台账码: ${rep.codes.join(",")}`);
  return {
    ok: rep.ok,
    code: rep.ok ? undefined : (rep.code ?? "UNAVAILABLE"),
    metrics: [
      { label: "批次", value: rep.cohorts },
      { label: "交付数", value: deliveries },
      { label: "首次通过率", value: firstPassRate, tone: firstPassRate >= 0.8 ? "ok" : firstPassRate >= 0.6 ? "warn" : "bad" },
      { label: "逃逸率", value: escapeRate, tone: escapeRate <= 0.1 ? "ok" : escapeRate <= 0.2 ? "warn" : "bad" },
      { label: "低样本", value: low, tone: low > 0 ? "warn" : "ok" },
    ],
    warnings,
  };
}

async function readNegativeKb(root: string): Promise<RsiSectionResult> {
  const base = safeRoot(root);
  if (base === undefined) return undefined;
  const { negativeKbPath, reportNegative } = await import("./negative-kb-store.js");
  if (!existsSync(negativeKbPath(base))) return undefined;
  const rep = reportNegative(base);
  const ok = rep.parseErrors === 0;
  const warnings: string[] = [];
  if (rep.parseErrors > 0) warnings.push(`${rep.parseErrors} 行坏行`);
  return {
    ok,
    code: ok ? undefined : "PARSE_ERRORS",
    metrics: [
      { label: "总数", value: rep.total },
      { label: "活跃", value: rep.active, tone: "ok" },
      { label: "翻案", value: rep.revived, tone: rep.revived > 0 ? "warn" : "ok" },
      { label: "过期", value: rep.expired, tone: rep.expired > 0 ? "warn" : "ok" },
      { label: "可命中", value: rep.hits },
    ],
    warnings,
  };
}

async function readPrompts(root: string): Promise<RsiSectionResult> {
  const base = safeRoot(root);
  if (base === undefined) return undefined;
  const { promptBookPath, reportPrompts } = await import("./prompt-version-store.js");
  if (!existsSync(promptBookPath(base))) return undefined;
  const rep = await reportPrompts(base);
  const status = rep.status;
  const warnings: string[] = [];
  if (rep.codes.length > 0) warnings.push(`台账码: ${rep.codes.join(",")}`);
  return {
    ok: rep.ok,
    code: rep.ok ? undefined : (rep.codes[0] ?? "UNAVAILABLE"),
    metrics: [
      { label: "键", value: rep.keys },
      { label: "活跃版本", value: status["active"] ?? 0, tone: "ok" },
      { label: "版本总数", value: rep.revisions },
      { label: "钉扎会话", value: rep.pins, tone: rep.pins > 0 ? "warn" : "ok" },
    ],
    warnings,
  };
}

async function readAtlas(root: string): Promise<RsiSectionResult> {
  const base = safeRoot(root);
  if (base === undefined) return undefined;
  const { atlasDir, getAtlas, reportAtlas } = await import("./direction-atlas-store.js");
  const dir = atlasDir(base);
  if (!existsSync(dir)) return undefined;
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return undefined;
  }
  if (names.length === 0) return undefined;
  let projects = 0;
  let goals = 0;
  let activeGoals = 0;
  let openConflicts = 0;
  let reworkSignals = 0;
  let impactClusters = 0;
  const warnings: string[] = [];
  for (const name of names) {
    const projectId = name.slice(0, -".json".length);
    const got = reportAtlas(base, projectId);
    if (!got.ok || got.report === undefined) {
      warnings.push(`方向图 ${projectId} 不可读(${got.code ?? "ATLAS_NOT_FOUND"})`);
      continue;
    }
    projects += 1;
    goals += got.report.goalCount;
    activeGoals += got.report.activeGoals;
    openConflicts += got.report.openConflicts;
    // 世界模型 derived 里的返工账(与开工简报同源):面板只展示计数,含义靠 title 悬停解释。
    const snap = getAtlas(base, projectId);
    const derived = snap.ok && snap.atlas !== undefined
      ? (snap.atlas as { derived?: { reworkSignals?: unknown[]; reworkChains?: { fanoutClusters?: unknown } } }).derived
      : undefined;
    if (derived !== undefined && Array.isArray(derived.reworkSignals)) reworkSignals += derived.reworkSignals.length;
    const clusters = Number(derived?.reworkChains?.fanoutClusters);
    if (Number.isFinite(clusters) && clusters > 0) impactClusters += clusters;
  }
  if (projects === 0) return unavailable("atlas", "方向图文件均不可读");
  const ok = openConflicts === 0;
  if (!ok) warnings.push(`${openConflicts} 个未解冲突`);
  return {
    ok,
    code: ok ? undefined : "CONFLICTS",
    metrics: [
      { label: "项目数", value: projects },
      { label: "目标", value: goals },
      { label: "活跃目标", value: activeGoals, tone: "ok" },
      { label: "冲突", value: openConflicts, tone: toneOfCount(openConflicts) },
      // 2026-11-14 返工账上屏:有数据才出,面板这两条带悬停解释(与开工简报同源口径)。
      ...(reworkSignals > 0 || impactClusters > 0
        ? [
            { label: "返工信号", value: reworkSignals, tone: reworkSignals > 0 ? "warn" : "ok" } as RsiStatusMetric,
            { label: "影响面未闭合簇", value: impactClusters, tone: impactClusters > 0 ? "warn" : "ok" } as RsiStatusMetric,
          ]
        : []),
    ],
    warnings,
  };
}

async function readPathology(root: string): Promise<RsiSectionResult> {
  const base = safeRoot(root);
  if (base === undefined) return undefined;
  const { pathologyLedgerPath, reportPathology, listForms } = await import("./pathology-store.js");
  if (!existsSync(pathologyLedgerPath(base))) return undefined;
  const rep = reportPathology(base);
  const forms = listForms(base);
  const candidates = rep.candidates.length;
  const ok = rep.ok && rep.badLines === 0;
  const warnings: string[] = [];
  if (rep.badLines > 0) warnings.push(`${rep.badLines} 行坏行`);
  if (candidates > 0) warnings.push(`${candidates} 个候选形态待归类`);
  return {
    ok,
    code: ok ? undefined : rep.ok ? "BAD_LINES" : "UNAVAILABLE",
    metrics: [
      { label: "目录形态", value: forms.total },
      { label: "已登记", value: forms.registered },
      { label: "候选", value: candidates, tone: candidates > 0 ? "warn" : "ok" },
      { label: "命中形态", value: Object.keys(rep.matches).length },
      { label: "坏行", value: rep.badLines, tone: rep.badLines > 0 ? "warn" : "ok" },
    ],
    warnings,
  };
}

// ------------------------------------------------------------------ 产物面聚合(B)
// 看板从「机制健康」升维成「产物优先」:除 12 区状态外,把已存在的产物台账(零新采集)
// 原样带出给面板下钻。纪律与 12 区一致:严格只读、逐文件 fail-open——缺文件=undefined
// (面板该卡显示诚实空态),任何单文件异常不拖垮整帧。

export interface RsiOutputsReworkItem {
  path: string;
  logicalKey: string;
  defectClass: string;
  evidenceLevel: string;
  prevention: string;
  attribution: string;
  buildSession: string;
  fixSession: string;
  /** 扇出链:一次构建引出的全部修复会话(单修复链为空)。 */
  fixSessions?: string[];
  buildTitle: string;
  fixTitle: string;
  /** 2026-11-21 人话化:核验档位。confirmed=同一任务族;probable=同模块+修复动词+共同主题词;
   * weak=同文件但主题不相关;excluded=漂移/无定位/非代码路径(不进结论,只做透明计数)。 */
  tier: "confirmed" | "probable" | "weak" | "excluded";
  /** 为什么是这一档(一句话,给面板直接展示)。 */
  tierReason: string;
  /** 构建/修复各一条人话动作(标题首行,去掉任务书模板噪声)。 */
  buildAction: string;
  fixAction: string;
  /** 模块短名(路径末段),面板标题不再铺全路径。 */
  moduleLabel: string;
  /** 修复内容(来自修复标题;只陈述事实,不脑补根因)。 */
  why: string;
  /** 改进方法(已有 prevention 优先;否则按缺陷类给标准防护建议)。 */
  improvement: string;
  /** 改进状态:已生效/建议未灰度/灰度实验 id。 */
  improvementStatus: string;
}

/** 知识库条目(2026-11-21):把证据图观测/缺陷基因/死路知识折成同一张「可检索知识卡」。 */
export interface RsiOutputsKnowledgeItem {
  id: string;
  type: "fact" | "anti-pattern" | "gene" | "dead-end";
  title: string;
  detail: string;
  /** 证据来源(nightly 日期 / session id / 跨会话返工链)。 */
  source: string;
  observedAt: number;
  /** 同一知识被观察到的次数(证据图同一候选的多条观察合并)。 */
  observations: number;
  isNew: boolean;
  /** 这条知识当前被怎么用:灰度实验/候选队列/开工提示/未行动。 */
  action: string;
  actionKind: "experiment" | "queue" | "injected" | "none";
}

export interface RsiOutputsNegkbItem {
  id: string;
  plan: string;
  symptoms: string[];
  alternative: string;
  refNote: string;
  confidence: number;
  createdAt: number;
}

export interface RsiOutputsEvidenceNode {
  id: string;
  kind: string;
  statement: string;
  confidence: number;
  sourceNote: string;
  /** epoch ms;知识库「新增 vs 已有」判据。 */
  observedAt: number;
}

export interface RsiOutputsChangeRequestItem {
  id: string;
  title: string;
  kind: string;
  evidenceRefs: string[];
}

export interface RsiOutputsAtlasGene {
  id: string;
  defectClass: string;
  module: string;
  count: number;
  /** epoch ms(基因最后出现时间);知识库新增判定用。 */
  lastAt?: number;
}

export interface RsiOutputsPipeline {
  date: string;
  projectId: string;
  status: string;
  stepsDone: number;
  stepsTotal: number;
  sessions: number;
  events: number;
  candidates: number;
  unprocessed: number;
  at: number;
}

export interface RsiOutputsFoundry {
  observations: number;
  candidates: number;
  registered: number;
  names: string[];
  pendingCandidates: string[];
  /** 2026-11-20:注册工具的用途(命令 ref),面板据此给出中文名与「它是干什么的」。 */
  toolRows?: Array<{ name: string; ref: string; description: string; permission: string }>;
}

export interface RsiOutputsQueueItem {
  id: string;
  kind: string;
  reason: string;
}

export interface RsiOutputsExperiments {
  total: number;
  ids: string[];
  /** 2026-11-20 人话化:每个实验的假设/预期/干预面/状态(面板直接讲「在验证什么」)。 */
  rows?: Array<{ id: string; claim: string; expectedEffect: string; intervention: string; status: string }>;
}

/** 2026-11-20 世界模型分项目:每个项目一组方向结论(atlas 快照按项目分文件)。 */
export interface RsiOutputsProjectAtlas {
  project: string;
  label: string;
  empty: boolean;
  goals: Array<{
    id: string;
    title: string;
    status: string;
    /** 方向创建时间(ISO);面板标「本周新增/延续」。 */
    since: string;
    isNew: boolean;
    /** agent 推进记录(最近 2 条,人话 note + 下一步)。 */
    progress: Array<{ at: string; note: string; nextStep: string }>;
    /** 该方向的主题簇代表任务(最多 2 条,用来回答「具体在做什么」)。 */
    representativeTasks: string[];
    /** 面板标题:有 agent 推进记录时用推进事先生成的人话方向名;否则回落聚类标题。 */
    displayTitle: string;
  }>;
  themes: RsiOutputsAtlasThemes[];
  hotModules: RsiOutputsAtlasModule[];
  reworkSignals: number;
  repeatExploration: number;
  genes: RsiOutputsAtlasGene[];
  /** 2026-11-21:项目一句话现状 + 新增/延续计数(面板首行直接可读)。 */
  sessions: number;
  newGoals: number;
  existingGoals: number;
  newHotModules: number;
  existingHotModules: number;
  /** 最近一次 agent 推进的方向结论(无推进记录则空串)。 */
  latestEvolution: string;
  /** 上一版快照里有、本版没有的方向(最多 3 条,面板标「上期未延续」)。 */
  droppedGoals: Array<{ id: string; title: string }>;
}

export interface RsiOutputsAtlasThemes {
  id: string;
  sessions: number;
  /** 主题首次/最近出现(ISO);没有上一版快照时按 firstSeen 判新。 */
  firstSeen?: string;
  lastSeen?: string;
  isNew?: boolean;
  /** 代表任务标题(最多 2 条,已去任务书模板噪声)。 */
  titles?: string[];
}

export interface RsiOutputsAtlasModule {
  path: string;
  editSessions: number;
  riskLevel: string;
  upstream: number;
  firstSeen?: string;
  lastSeen?: string;
  isNew?: boolean;
}

export interface RsiOutputsSnapshot {
  pipeline?: RsiOutputsPipeline;
  foundry?: RsiOutputsFoundry;
  queue?: { total: number; items: RsiOutputsQueueItem[] };
  experiments?: RsiOutputsExperiments;
  projectsAtlas?: RsiOutputsProjectAtlas[];
  reworkChains?: {
    total: number;
    /** 2026-11-21:核验分层计数(面板结论用 confirmed+probable,不再拿原始行数当返工数)。 */
    confirmed: number;
    probable: number;
    weak: number;
    excluded: number;
    withPrevention: number;
    byEvidence: Record<string, number>;
    items: RsiOutputsReworkItem[];
  };
  negkb?: { total: number; items: RsiOutputsNegkbItem[] };
  /** 2026-11-21:知识库(RAG 索引视图):证据图观测 + 缺陷基因 + 死路,合并去重并标新增/已有。 */
  knowledge?: {
    total: number;
    newCount: number;
    existingCount: number;
    byType: Record<string, number>;
    items: RsiOutputsKnowledgeItem[];
  };
  evidenceGraph?: { nodes: number; edges: number; items: RsiOutputsEvidenceNode[] };
  changeRequests?: { total: number; items: RsiOutputsChangeRequestItem[] };
  cohort?: {
    deliveries: number;
    fixes: number;
    recent: Array<{ taskId: string; module: string; taskClass: string; changeNodes: number }>;
  };
  weekly?: { file: string; text: string };
  atlas?: {
    goals: number;
    summaryText: string;
    defectGenes: RsiOutputsAtlasGene[];
    themes?: RsiOutputsAtlasThemes[];
    hotModules?: RsiOutputsAtlasModule[];
    reworkSignals?: number;
    repeatExploration?: number;
  };
  cost?: { entries: number; totalTokens: number; byMechanism: Record<string, number> };
}

/** 逐行读 jsonl(跳过坏行;限行数防大账本撑爆帧)。 */
function readJsonlLines(path: string, maxLines: number): Array<Record<string, unknown>> {
  const text = readFileSync(path, "utf8");
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (s === "") continue;
    try {
      const parsed: unknown = JSON.parse(s);
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      // 坏行跳过(与 readCost 同口径)
    }
    if (out.length >= maxLines) break;
  }
  return out;
}

function clip(text: unknown, limit: number): string {
  if (typeof text !== "string") return "";
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

/* ------------------------------------------------------------------ *
 * 2026-11-21 人话化与核验分层(返工链/知识库/世界模型共用)
 *
 * 背景:原始台账一条「同文件后续改动」就算返工,43 条里大量是漂移/同文件不同功能,
 * 面板直接铺出来既不可信也看不懂。这里只做**展示层核验**:不篡改台账,按任务族/修复动词/
 * 主题词把链分成 confirmed/probable/weak/excluded,面板结论只用前两档,其余透明计数。
 * ------------------------------------------------------------------ */

const REWORK_NEW_WINDOW_MS = 7 * 86_400_000;
const REWORK_FIX_RE = /修复|修好|修掉|修正|回归|补丁|解决|纠正|对齐|调整|改掉|去掉|排查|hotfix|fix/i;
/** 任务书模板噪声:只用于主题词比较,不改原台账文本。 */
const REWORK_TEMPLATE_RE =
  /\(missing\s*→\s*implemented\)|纯新增\s*\d+\s*文件|不改既有模块|不\s*build[^。;\n]*|不\s*重启[^。;\n]*|不\s*commit[^。;\n]*|目标仓[:：][^。\n]*|lampgenie-harness\s*主仓[^。\n]*|【背景】[^\n]*|用户是[^。\n]*|第\s*\d+\s*轮[:：]?\s*|#\d+\s*|M\d+\s*|step-\d+\s*|【任务】|【机制|】/gi;
const REWORK_STOP = new Set([
  "missing", "implemented", "build", "commit", "restart", "genie", "harness", "lampgenie-harness", "true", "false",
  "任务", "背景", "用户", "作者", "目标", "主仓", "仓", "实施", "实现", "机制", "修复", "需要", "现在", "一个", "我们",
  "可以", "已经", "进行", "以及", "问题", "当前", "工作", "代码", "功能", "系统", "文件", "源码", "没有", "但是", "因为",
  "所以", "这个", "那个", "如果", "不是", "就是", "还是", "应该", "期望", "一下", "请", "把", "的", "了", "在", "是", "和",
  "与", "或", "等", "中", "后", "前", "上", "下", "有", "无", "不", "对", "为", "从", "到", "按", "纯新", "新增", "不改",
  "改既", "既有", "有模", "模块", "重启", "轮", "次", "条", "个", "项", "版", "全量", "补齐", "补", "改", "加", "删",
]);

/** 台账标题常带任务书多行模板;取首个非空行并裁长度(面板只展示动作,不铺全文)。 */
function actionLine(text: unknown, limit: number): string {
  if (typeof text !== "string") return "";
  let first = text.replace(/\r/g, "").split("\n").map((s) => s.trim()).find((s) => s !== "") ?? "";
  if (first.startsWith("【任务】")) first = first.slice(4).trim();
  const line = first
    .replace(/[【】]/g, "")
    .replace(/\(矩阵[^)]*\)|（矩阵[^）]*）/g, "")
    .replace(/\(missing\s*→\s*implemented\)/gi, "")
    .replace(/纯新增\s*\d+\s*文件[^。;]*/g, "")
    .replace(/[，,；;]?\s*不改既有模块[^。;]*/g, "")
    .replace(/[，,；;]?\s*不\s*build[^。;]*/gi, "")
    .replace(/^机制\s+/i, "")
    .replace(/^修复\s*/i, "")
    .replace(/^第\s*\d+\s*轮[:：]?\s*#?\d*\s*/, "")
    .replace(/^任务[:：]\s*/, "")
    .replace(/^任务·局部修复\s*v?\d+\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return clip(line, limit);
}

/** 把 agent 推进记录折成一句方向名(去掉 step 编号与解释性破折号后的内容)。 */
function directionLabelFromNote(note: string): string {
  const cleaned = note
    .replace(/^step-\d+[:：]\s*/i, "")
    .split(/——|—|;/)[0] ?? note;
  const short = cleaned.split(/[。;]/)[0]?.trim() ?? cleaned.trim();
  return clip(short, 56);
}

/** 修复标题里「:」后的具体内容(比整条任务标题更适合回答「修了什么」)。 */
function fixDetail(action: string): string {
  const match = action.match(/[:：]\s*(.+)$/);
  if (match !== null && match[1] !== undefined && match[1].trim().length >= 8) return match[1].trim();
  return action;
}

/** 两段标题的最长共同中文短语(≥2 字)+ 共同拉丁词;用于「为什么算返工」的人话解释。 */
function sharedPhrases(buildTitle: string, fixTitle: string): string[] {
  const norm = (text: string): string => text.replace(REWORK_TEMPLATE_RE, " ").replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, " ").toLowerCase();
  const b = norm(buildTitle);
  const f = norm(fixTitle);
  const out: string[] = [];
  for (const run of f.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    let found = "";
    for (let len = Math.min(8, run.length); len >= 2 && found === ""; len -= 1) {
      for (let i = 0; i + len <= run.length; i += 1) {
        const part = run.slice(i, i + len);
        if (b.includes(part)) { found = part; break; }
      }
    }
    if (found !== "" && !out.some((x) => x.includes(found) || found.includes(x))) out.push(found);
  }
  for (const word of f.match(/[a-z][a-z0-9_-]{2,}/g) ?? []) {
    if (b.includes(word) && !out.includes(word)) out.push(word);
  }
  return out.slice(0, 3);
}

/** 任务族标识( /  / 第 65 轮 / #175):同族=同一条工作线。 */
function taskFamilyIds(text: unknown): string[] {
  if (typeof text !== "string") return [];
  const out = new Set<string>();
  for (const m of text.match(/M\d+|step-\d+|第\s*\d+\s*轮|#\d+/g) ?? []) out.add(m.replace(/\s/g, ""));
  return [...out];
}

/** 主题词:去掉任务书模板噪声后的 CJK 二元组 + 拉丁词(用于判断「是不是同一功能」)。 */
function reworkTokens(text: unknown): string[] {
  if (typeof text !== "string") return [];
  const raw = text.replace(REWORK_TEMPLATE_RE, " ").toLowerCase();
  const out = new Set<string>();
  for (const w of raw.match(/[a-z][a-z0-9_-]{2,}/g) ?? []) if (!REWORK_STOP.has(w)) out.add(w);
  for (const run of raw.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (!REWORK_STOP.has(bigram)) out.add(bigram);
    }
  }
  return [...out];
}

/** 缺陷类的标准防护建议(没有命中已有 prevention 时的兜底,面板会标「建议未灰度」)。 */
function defectClassAdvice(defectClass: string): string {
  switch (defectClass) {
    case "contract":
      return "契约类:改协议/字段前先列全部生产方与消费方,补一条端到端握手测试";
    case "boundary":
      return "边界类:补空值/异常/极端输入用例,先写失败用例再改实现";
    case "security":
      return "安全类:补权限/注入/越权路径的反向用例,默认 fail-closed";
    case "performance":
      return "性能类:先落可复现基线与阈值,再改实现并复测";
    default:
      return "先补归因:读修复会话的 diff 与测试,确认根因后再选防护(信息不足不硬给结论)";
  }
}

type ReworkTier = RsiOutputsReworkItem["tier"];

/** 核验分层:只消费台账已有字段,不做 LLM 推断。 */
function classifyRework(row: Record<string, unknown>): { tier: ReworkTier; reason: string; shared: string[] } {
  const path = typeof row["path"] === "string" ? row["path"] : "";
  const logicalKey = typeof row["logicalKey"] === "string" ? row["logicalKey"] : "";
  if (path === "" && logicalKey === "") {
    return { tier: "excluded", reason: "没有共享逻辑单元,无法定位具体改动", shared: [] };
  }
  if (path !== "" && !/^(apps|packages)\/.+\.(ts|tsx|js|mjs|cjs)$/.test(path)) {
    const area = path.startsWith("tasks/") ? "计划/评审文档" : path.startsWith("docs/") ? "设计文档" : path === "package.json" ? "配置文件" : "非代码路径";
    return { tier: "excluded", reason: `${area}不参与「代码返工」统计`, shared: [] };
  }
  const attribution = isRecord(row["attribution"]) && typeof row["attribution"]["verdict"] === "string" ? row["attribution"]["verdict"] : "";
  if (attribution === "drift") {
    return { tier: "excluded", reason: "归因判为漂移:后续改动与先做任务不是同一功能", shared: [] };
  }
  const buildTitle = typeof row["buildTitle"] === "string" ? row["buildTitle"] : "";
  const fixTitle = typeof row["fixTitle"] === "string" ? row["fixTitle"] : "";
  const buildFam = taskFamilyIds(buildTitle);
  const fixFam = taskFamilyIds(fixTitle);
  const sharedFam = buildFam.filter((id) => fixFam.includes(id));
  if (sharedFam.length > 0) {
    return { tier: "confirmed", reason: `同一任务族标识 ${sharedFam.slice(0, 2).join("/")}:构建与修复指向同一功能`, shared: sharedFam };
  }
  const buildTokens = new Set(reworkTokens(buildTitle));
  const shared = reworkTokens(fixTitle).filter((t) => buildTokens.has(t));
  if (REWORK_FIX_RE.test(fixTitle) && shared.length >= 4) {
    const phrases = sharedPhrases(buildTitle, fixTitle);
    const label = phrases.length > 0 ? phrases.join("」「") : shared.slice(0, 4).join("/");
    return { tier: "probable", reason: `修复标题含修复动词,且与构建任务共享主题「${label}」`, shared };
  }
  return { tier: "weak", reason: "同文件但主题不相关:很像同文件的不同功能,未计入返工结论", shared };
}

/** 证据图语句归一:同一候选的多条观察合并成一条知识(标题取「:」前的短标签)。 */
function knowledgeBaseKey(statement: string): string {
  const cand = statement.match(/cand-[a-z0-9-]+/i);
  if (cand) return cand[0].toLowerCase();
  const beforeObs = statement.split("(观察")[0] ?? statement;
  return (beforeObs.split(":")[0] ?? "").trim().slice(0, 40) || statement.slice(0, 40);
}

function knowledgeTitle(statement: string): string {
  const head = statement.split(/[:(（]/)[0]?.trim() ?? "";
  return clip(head !== "" ? head : statement, 30);
}

/** 产物面聚合(B):读已存在产物台账(零新采集),逐文件 fail-open;缺文件=字段缺省(面板空态)。 */
export async function collectRsiOutputs(root: string): Promise<RsiOutputsSnapshot> {
  const base = safeRoot(root);
  const out: RsiOutputsSnapshot = {};
  if (base === undefined) return out;
  const rsiDir = join(base, ".genie", "rsi");
  // ① 返工因果链(rework-chains.jsonl;裁字段控帧)
  const reworkPath = join(rsiDir, "rework-chains.jsonl");
  if (existsSync(reworkPath)) {
    try {
      const rows = readJsonlLines(reworkPath, 200);
      const items: RsiOutputsReworkItem[] = [];
      const byEvidence: Record<string, number> = {};
      const tiers = { confirmed: 0, probable: 0, weak: 0, excluded: 0 };
      let withPrevention = 0;
      for (const row of rows) {
        const level = typeof row["evidenceLevel"] === "string" ? row["evidenceLevel"] : "";
        const key = level === "" ? "ungraded" : level;
        byEvidence[key] = (byEvidence[key] ?? 0) + 1;
        const prev = isRecord(row["prevention"]) ? clip(row["prevention"]["note"], 120) : "";
        if (prev !== "") withPrevention++;
        const attr = isRecord(row["attribution"]) && typeof row["attribution"]["verdict"] === "string" ? row["attribution"]["verdict"] : "";
        const defectClass = typeof row["defectClass"] === "string" ? row["defectClass"] : "";
        const path = clip(row["path"], 80);
        const buildAction = actionLine(row["buildTitle"], 160) || "构建任务(标题缺失)";
        const fixAction = actionLine(row["fixTitle"], 160) || "后续改动(标题缺失)";
        const verdict = classifyRework(row);
        tiers[verdict.tier] += 1;
        const genericPrevention = prev !== "" && /证据不足|通用门/.test(prev);
        items.push({
          path,
          logicalKey: clip(row["logicalKey"], 60),
          defectClass,
          evidenceLevel: level,
          prevention: prev,
          attribution: attr,
          buildSession: clip(row["buildSession"], 40),
          fixSession: clip(row["fixSession"], 40),
          ...(Array.isArray(row["fixSessions"])
            ? { fixSessions: (row["fixSessions"] as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 8).map((s) => clip(s, 40)) }
            : {}),
          buildTitle: clip(row["buildTitle"], 80),
          fixTitle: clip(row["fixTitle"], 80),
          tier: verdict.tier,
          tierReason: verdict.reason,
          buildAction,
          fixAction,
          moduleLabel: path !== "" ? (path.split("/").pop() ?? path) : "(未定位)",
          why: fixDetail(fixAction),
          improvement: genericPrevention
            ? `${defectClassAdvice(defectClass)}｜当前台账已有通用防护「${prev}」`
            : prev !== "" ? prev : defectClassAdvice(defectClass),
          improvementStatus: prev !== "" ? "已进入开工/编辑提示(自动生效)" : "建议已生成;尚未进入灰度",
        });
      }
      out.reworkChains = {
        total: rows.length,
        confirmed: tiers.confirmed,
        probable: tiers.probable,
        weak: tiers.weak,
        excluded: tiers.excluded,
        withPrevention,
        byEvidence,
        items,
      };
    } catch {
      // fail-open
    }
  }
  // ② 负面知识库(negkb.jsonl;type=record → record{...})
  const negkbPath = join(rsiDir, "negkb.jsonl");
  if (existsSync(negkbPath)) {
    try {
      const rows = readJsonlLines(negkbPath, 100);
      const items: RsiOutputsNegkbItem[] = [];
      for (const row of rows) {
        const rec = isRecord(row["record"]) ? row["record"] : row;
        const ctx = isRecord(rec["context"]) ? rec["context"] : {};
        const symptoms = Array.isArray(ctx["symptoms"])
          ? ctx["symptoms"].filter((s): s is string => typeof s === "string").slice(0, 4)
          : [];
        const ev0 = Array.isArray(rec["failureEvidence"]) && isRecord(rec["failureEvidence"][0]) ? rec["failureEvidence"][0] : {};
        items.push({
          id: typeof rec["id"] === "string" ? rec["id"] : "",
          plan: clip(rec["plan"], 140),
          symptoms,
          alternative: clip(rec["alternative"], 160),
          refNote: clip(ev0["ref"], 100),
          confidence: typeof rec["confidence"] === "number" ? rec["confidence"] : 0,
          createdAt: typeof rec["createdAt"] === "number" ? rec["createdAt"] : 0,
        });
      }
      out.negkb = { total: rows.length, items };
    } catch {
      // fail-open
    }
  }
  // ③ 时空证据图(.genie/evidence/graph.jsonl;add=节点 / link=边)
  const graphPath = join(base, ".genie", "evidence", "graph.jsonl");
  if (existsSync(graphPath)) {
    try {
      const rows = readJsonlLines(graphPath, 200);
      let edges = 0;
      const items: RsiOutputsEvidenceNode[] = [];
      for (const row of rows) {
        if (row["type"] === "link") {
          edges++;
          continue;
        }
        if (row["type"] !== "add") continue;
        const node = isRecord(row["node"]) ? row["node"] : {};
        items.push({
          id: typeof node["id"] === "string" ? node["id"] : "",
          kind: typeof node["kind"] === "string" ? node["kind"] : "",
          statement: clip(node["statement"], 140),
          confidence: typeof node["confidence"] === "number" ? node["confidence"] : 0,
          sourceNote: clip(isRecord(node["source"]) ? node["source"]["note"] : "", 80),
          observedAt: typeof node["observedAt"] === "number" ? node["observedAt"] : 0,
        });
      }
      out.evidenceGraph = { nodes: items.length, edges, items };
    } catch {
      // fail-open
    }
  }
  // ④ 变更请求(change-requests.jsonl;type=create → request{...})
  const crPath = join(rsiDir, "change-requests.jsonl");
  if (existsSync(crPath)) {
    try {
      const rows = readJsonlLines(crPath, 50);
      const items: RsiOutputsChangeRequestItem[] = [];
      for (const row of rows) {
        const req = isRecord(row["request"]) ? row["request"] : row;
        const refs = Array.isArray(req["evidenceRefs"])
          ? req["evidenceRefs"].filter((r): r is string => typeof r === "string").slice(0, 3).map((r) => clip(r, 100))
          : [];
        items.push({
          id: typeof req["id"] === "string" ? req["id"] : "",
          title: clip(req["title"], 120),
          kind: typeof req["kind"] === "string" ? req["kind"] : "",
          evidenceRefs: refs,
        });
      }
      out.changeRequests = { total: rows.length, items };
    } catch {
      // fail-open
    }
  }
  // ⑤ cohort 交付账本(type=delivery/fix;样本尚稀,先计数+最近样本,趋势待积累)
  const cohortPath = join(rsiDir, "cohort.jsonl");
  if (existsSync(cohortPath)) {
    try {
      const rows = readJsonlLines(cohortPath, 300);
      let deliveries = 0;
      let fixes = 0;
      const recent: Array<{ taskId: string; module: string; taskClass: string; changeNodes: number }> = [];
      for (const row of rows) {
        if (row["type"] === "delivery") {
          deliveries++;
          const d = isRecord(row["delivery"]) ? row["delivery"] : {};
          if (recent.length < 5) {
            recent.push({
              taskId: clip(d["taskId"], 30),
              module: clip(d["module"], 50),
              taskClass: typeof d["taskClass"] === "string" ? d["taskClass"] : "",
              changeNodes: typeof d["changeNodes"] === "number" ? d["changeNodes"] : 0,
            });
          }
        } else if (row["type"] === "fix") fixes++;
      }
      out.cohort = { deliveries, fixes, recent };
    } catch {
      // fail-open
    }
  }
  // ⑥ 周报(最新一份 md,正文带出——面板无文件读取能力)
  try {
    const weeklyDir = join(rsiDir, "weekly");
    if (existsSync(weeklyDir)) {
      const names = readdirSync(weeklyDir).filter((n) => n.endsWith(".md")).sort();
      const last = names[names.length - 1];
      if (last !== undefined) {
        const text = readFileSync(join(weeklyDir, last), "utf8");
        out.weekly = { file: last, text: clip(text, 1200) };
      }
    }
  } catch {
    // fail-open
  }
  // ⑦ 方向图快照(goal 数 + summary 文本 + defectGenes 列表)
  try {
    // 2026-11-20 通用化:快照按「网关根目录名」命名,不再硬编码 lampgenie-harness;
    // 找不到对应项目键时回退目录内最新的 .json(兼容历史安装)。
    const atlasDir = join(rsiDir, "atlas");
    const projectKey = (() => {
      const norm = String(base || "").replace(/[\\/]+$/, "");
      const b = norm.split(/[\\/]/).pop();
      return b !== undefined && b !== "" ? b : "project";
    })();
    let atlasPath = join(atlasDir, `${projectKey}.json`);
    if (!existsSync(atlasPath) && existsSync(atlasDir)) {
      try {
        const names = readdirSync(atlasDir)
          .filter((n) => n.endsWith(".json") && !n.endsWith(".prev.json") && n !== "proposed-goals.json")
          .sort();
        const last = names[names.length - 1];
        if (last !== undefined) atlasPath = join(atlasDir, last);
      } catch { /* 目录不可读:保持原路径 */ }
    }
    if (existsSync(atlasPath)) {
      const raw: unknown = JSON.parse(readFileSync(atlasPath, "utf8"));
      if (isRecord(raw)) {
        const genesRaw = Array.isArray(raw["defectGenes"]) ? raw["defectGenes"] : [];
        const defectGenes: RsiOutputsAtlasGene[] = [];
        for (const g of genesRaw.slice(0, 12)) {
          if (!isRecord(g)) continue;
          defectGenes.push({
            id: clip(g["id"], 60),
            defectClass: typeof g["defectClass"] === "string" ? g["defectClass"] : "",
            module: clip(g["module"], 60),
            count: typeof g["count"] === "number" ? g["count"] : 0,
            lastAt: typeof g["lastAt"] === "number" ? g["lastAt"] : typeof g["lastAt"] === "string" ? Date.parse(g["lastAt"]) || 0 : 0,
          });
        }
        const summary = raw["summary"];
        const summaryText = clip(typeof summary === "string" ? summary : JSON.stringify(summary), 400);
        // 2026-11-20 重设计:把 derived 层的关键读数带到面板(主题/热点模块/信号计数)——
        // 「产出了什么」必须一眼可见,而不是让用户自己点进 12 区拼图。
        const derived = isRecord(raw["derived"]) ? raw["derived"] : {};
        const themes: RsiOutputsAtlasThemes[] = (Array.isArray(derived["themes"]) ? derived["themes"] : [])
          .filter(isRecord)
          .slice(0, 6)
          .map((t) => ({ id: clip(t["id"], 30), sessions: typeof t["sessions"] === "number" ? t["sessions"] : 0 }));
        const hotModules: RsiOutputsAtlasModule[] = (Array.isArray(derived["moduleActivity"]) ? derived["moduleActivity"] : [])
          .filter(isRecord)
          .slice(0, 6)
          .map((m) => {
            const ctx = isRecord(m["context"]) ? m["context"] : {};
            return {
              path: clip(m["path"], 60),
              editSessions: typeof m["editSessions"] === "number" ? m["editSessions"] : 0,
              riskLevel: typeof ctx["riskLevel"] === "string" ? ctx["riskLevel"] : "",
              upstream: typeof ctx["upstream"] === "number" ? ctx["upstream"] : 0,
            };
          });
        out.atlas = {
          goals: Array.isArray(raw["goals"]) ? raw["goals"].length : 0,
          summaryText,
          defectGenes,
          themes,
          hotModules,
          reworkSignals: Array.isArray(derived["reworkSignals"]) ? derived["reworkSignals"].length : 0,
          repeatExploration: Array.isArray(derived["repeatExploration"]) ? derived["repeatExploration"].length : 0,
        };
      }
    }
  } catch {
    // fail-open
  }
  // ⑧ 成本台账(per-run 记账;按机制聚合)
  const costPath = join(rsiDir, "cost.jsonl");
  if (existsSync(costPath)) {
    try {
      const rows = readJsonlLines(costPath, 500);
      let totalTokens = 0;
      const byMechanism: Record<string, number> = {};
      for (const row of rows) {
        const mech = typeof row["mechanismId"] === "string" ? row["mechanismId"] : "unknown";
        const tokens = isRecord(row["tokens"]) && typeof row["tokens"]["total"] === "number" ? row["tokens"]["total"] : 0;
        totalTokens += tokens;
        byMechanism[mech] = (byMechanism[mech] ?? 0) + tokens;
      }
      out.cost = { entries: rows.length, totalTokens, byMechanism };
    } catch {
      // fail-open
    }
  }
  // ⑨ 最近一轮夜间管线(采集→归因→蒸馏的开场读数)
  try {
    const nightlyDir = join(rsiDir, "nightly");
    if (existsSync(nightlyDir)) {
      let best: { run: Record<string, unknown>; file: string; at: number } | undefined;
      for (const proj of readdirSync(nightlyDir)) {
        const dir = join(nightlyDir, proj);
        try {
          for (const name of readdirSync(dir)) {
            if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
            const raw: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
            if (!isRecord(raw) || !Array.isArray(raw["steps"])) continue;
            const atOf = (v: unknown): number => {
              if (typeof v === "number" && Number.isFinite(v)) return v;
              if (typeof v === "string") { const ts = Date.parse(v); return Number.isFinite(ts) ? ts : 0; }
              return 0;
            };
            const at = Math.max(atOf(raw["updatedAt"]), atOf(raw["createdAt"]));
            if (best === undefined || at > best.at) best = { run: raw, file: name, at };
          }
        } catch { /* 单目录失败跳过 */ }
      }
      if (best !== undefined) {
        const run = best.run;
        const steps = (Array.isArray(run["steps"]) ? run["steps"] : []).filter(isRecord);
        const cov = isRecord(run["coverage"]) ? run["coverage"] : {};
        const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        out.pipeline = {
          date: best.file.replace(/\.json$/, ""),
          projectId: typeof run["projectId"] === "string" ? run["projectId"] : "",
          status: typeof run["status"] === "string" ? run["status"] : "",
          stepsDone: steps.filter((s) => s["status"] === "done").length,
          stepsTotal: steps.length,
          sessions: num(cov["sessionsProcessed"]),
          events: num(cov["eventsRead"]),
          candidates: Array.isArray(run["candidates"]) ? run["candidates"].length : 0,
          unprocessed: Array.isArray(run["unprocessed"]) ? run["unprocessed"].length : 0,
          at: best.at,
        };
      }
    }
  } catch { /* fail-open */ }
  // ⑩ 工具铸造厂(观测→候选→shadow→registered)
  try {
    const foundryPath = join(rsiDir, "foundry.jsonl");
    if (existsSync(foundryPath)) {
      const rows = readJsonlLines(foundryPath, 2000);
      const count = (type: string): number => rows.filter((r) => r["type"] === type).length;
      const names: string[] = [];
      const pending: string[] = [];
      const toolRows: NonNullable<RsiOutputsFoundry["toolRows"]> = [];
      for (const r of rows) {
        if (r["type"] === "registered") {
          const spec = isRecord(r["dataToolSpec"]) ? r["dataToolSpec"] : undefined;
          const toolName = spec !== undefined && typeof spec["name"] === "string" ? spec["name"] : (typeof r["id"] === "string" ? r["id"] : "");
          if (toolName !== "") {
            names.push(clip(toolName, 50));
            const handler = spec !== undefined && isRecord(spec["handler"]) ? spec["handler"] : {};
            const perms = spec !== undefined && isRecord(spec["permissions"]) ? spec["permissions"] : {};
            toolRows.push({
              name: clip(toolName, 60),
              ref: clip(handler["ref"], 120),
              description: clip(spec !== undefined ? spec["description"] : "", 160),
              permission: typeof perms["mode"] === "string" ? perms["mode"] : "",
            });
          }
        }
        if (r["type"] === "candidate" && isRecord(r["candidate"]) && typeof r["candidate"]["name"] === "string") {
          pending.push(clip(r["candidate"]["name"], 50));
        }
      }
      const uniqToolRows: NonNullable<RsiOutputsFoundry["toolRows"]> = [];
      const seenTools = new Set<string>();
      for (const row of toolRows) {
        if (seenTools.has(row.name)) continue;
        seenTools.add(row.name);
        uniqToolRows.push(row);
      }
      out.foundry = {
        observations: count("observation"),
        candidates: count("candidate"),
        registered: count("registered"),
        names: [...new Set(names)].slice(0, 8),
        pendingCandidates: pending.filter((n) => !names.includes(n)).slice(0, 5),
        toolRows: uniqToolRows.slice(0, 8),
      };
    }
  } catch { /* fail-open */ }
  // ⑪ 夜间候选队列(等实验翻译)
  try {
    const queuePath = join(rsiDir, "nightly", "queue.jsonl");
    if (existsSync(queuePath)) {
      const rows = readJsonlLines(queuePath, 100);
      const items: RsiOutputsQueueItem[] = [];
      for (const r of rows) {
        const c = isRecord(r["candidate"]) ? r["candidate"] : undefined;
        if (c === undefined || typeof c["id"] !== "string") continue;
        items.push({
          id: clip(c["id"], 50),
          kind: typeof c["kind"] === "string" ? c["kind"] : "",
          reason: clip(c["reason"], 120),
        });
      }
      out.queue = { total: items.length, items: items.slice(-8) };
    }
  } catch { /* fail-open */ }
  // ⑫ 实验台账(登记数 + 人话假设/预期/干预面)
  try {
    const expPath = join(base, ".genie", "experiments", "ledger.jsonl");
    if (existsSync(expPath)) {
      const rows = readJsonlLines(expPath, 200);
      const ids: string[] = [];
      const detailed: NonNullable<RsiOutputsExperiments["rows"]> = [];
      for (const r of rows) {
        if (r["type"] !== "record" || !isRecord(r["experiment"])) continue;
        const exp = r["experiment"];
        const id = typeof exp["id"] === "string" ? exp["id"] : "";
        if (id === "") continue;
        ids.push(clip(id, 60));
        const hypo = isRecord(exp["hypothesis"]) ? exp["hypothesis"] : {};
        const inter = isRecord(exp["intervention"]) ? exp["intervention"] : {};
        const canary = isRecord(exp["canary"]) ? exp["canary"] : {};
        detailed.push({
          id: clip(id, 60),
          claim: clip(hypo["claim"], 220),
          expectedEffect: clip(hypo["expectedEffect"], 160),
          intervention: clip(inter["ref"], 40),
          status: typeof canary["status"] === "string" ? canary["status"] : "",
        });
      }
      out.experiments = { total: ids.length, ids: [...new Set(ids)].slice(0, 6), rows: detailed.slice(0, 6) };
    }
  } catch { /* fail-open */ }
  // ⑬ 世界模型分项目:扫 atlas 目录快照 + 项目注册表(没有快照的项目也如实列出)
  try {
    const atlasDir = join(rsiDir, "atlas");
    const labelByBase = new Map<string, string>();
    try {
      const pr = JSON.parse(readFileSync(join(base, ".genie", "journals", "projects.json"), "utf8")) as unknown;
      const list = isRecord(pr) && Array.isArray(pr["projects"]) ? pr["projects"] : [];
      for (const item of list) {
        if (!isRecord(item)) continue;
        const path = typeof item["path"] === "string" ? item["path"] : "";
        const label = typeof item["label"] === "string" ? item["label"] : "";
        const baseName = path.replace(/\/+$/, "").split("/").pop() ?? "";
        if (baseName !== "" && label !== "") labelByBase.set(baseName, label);
      }
    } catch { /* 注册表缺失:仅按 atlas 文件展示 */ }
    const projects: RsiOutputsProjectAtlas[] = [];
    const seen = new Set<string>();
    const nowMs = Date.now();
    const isNewByTime = (iso: unknown): boolean => {
      if (typeof iso !== "string" || iso === "") return false;
      const t = Date.parse(iso);
      return Number.isFinite(t) && nowMs - t <= REWORK_NEW_WINDOW_MS;
    };
    if (existsSync(atlasDir)) {
      for (const name of readdirSync(atlasDir)) {
        if (!name.endsWith(".json")) continue;
        // 2026-11-20:目录里还躺着 proposed-goals.json(目标提案,不是项目快照)——不能当项目展示。
        // 2026-11-21:上一版比对基线 <key>.prev.json 也不是项目。
        if (name === "proposed-goals.json" || name.endsWith(".prev.json")) continue;
        const project = name.replace(/\.json$/, "");
        seen.add(project);
        try {
          const raw: unknown = JSON.parse(readFileSync(join(atlasDir, name), "utf8"));
          if (!isRecord(raw)) continue;
          // 上一版快照:只用于「新增 vs 已有」判定;没有基线时回落 since/firstSeen。
          let prev: Record<string, unknown> | undefined;
          try {
            const prevRaw: unknown = JSON.parse(readFileSync(join(atlasDir, `${project}.prev.json`), "utf8"));
            if (isRecord(prevRaw)) prev = prevRaw;
          } catch { /* 无基线 */ }
          const prevGoals = new Set<string>(
            prev && Array.isArray(prev["goals"])
              ? (prev["goals"] as unknown[]).filter(isRecord).map((g) => String(g["id"] ?? ""))
              : [],
          );
          const prevGoalRows = prev && Array.isArray(prev["goals"]) ? (prev["goals"] as unknown[]).filter(isRecord) : [];
          const prevDerived = prev && isRecord(prev["derived"]) ? prev["derived"] : {};
          const prevThemes = new Set<string>(
            Array.isArray(prevDerived["themes"]) ? (prevDerived["themes"] as unknown[]).filter(isRecord).map((t) => String(t["id"] ?? "")) : [],
          );
          const prevModules = new Set<string>(
            Array.isArray(prevDerived["moduleActivity"])
              ? (prevDerived["moduleActivity"] as unknown[]).filter(isRecord).map((m) => String(m["path"] ?? ""))
              : [],
          );
          const hasPrev = prev !== undefined;
          const derived = isRecord(raw["derived"]) ? raw["derived"] : {};
          const progressMap = isRecord(raw["goalProgress"]) ? raw["goalProgress"] : {};
          const themeById = new Map<string, Record<string, unknown>>();
          for (const t of Array.isArray(derived["themes"]) ? (derived["themes"] as unknown[]) : []) {
            if (isRecord(t) && typeof t["id"] === "string") themeById.set(t["id"], t);
          }
          const cleanTitles = (value: unknown, limit: number): string[] => {
            if (!Array.isArray(value)) return [];
            return value
              .filter((x): x is string => typeof x === "string")
              .map((x) => actionLine(x, 70))
              .filter((x) => x !== "")
              .slice(0, limit);
          };
          const goals: RsiOutputsProjectAtlas["goals"] = [];
          for (const g of (Array.isArray(raw["goals"]) ? raw["goals"] : []).slice(0, 8)) {
            if (!isRecord(g)) continue;
            const id = clip(g["id"], 60);
            const themeId = id.split(":").pop() ?? "";
            const theme = themeById.get(themeId);
            const progressRaw = progressMap[id];
            const progress = (Array.isArray(progressRaw) ? progressRaw : [])
              .filter(isRecord)
              .slice(-2)
              .map((p) => ({
                at: typeof p["at"] === "string" ? p["at"] : "",
                note: clip(p["note"], 180),
                nextStep: clip(p["nextStep"], 120),
              }));
            const latestProgress = progress[progress.length - 1];
            const goalTitle = clip(g["title"], 80);
            goals.push({
              id,
              title: goalTitle,
              status: typeof g["status"] === "string" ? g["status"] : "active",
              since: typeof g["since"] === "string" ? g["since"] : "",
              isNew: hasPrev ? !prevGoals.has(id) : isNewByTime(g["since"]),
              progress,
              representativeTasks: cleanTitles(theme?.["titles"], 2),
              displayTitle: latestProgress !== undefined ? directionLabelFromNote(latestProgress.note) : goalTitle,
            });
          }
          const themes: RsiOutputsAtlasThemes[] = (Array.isArray(derived["themes"]) ? derived["themes"] : [])
            .filter(isRecord).slice(0, 4)
            .map((t) => {
              const id = clip(t["id"], 30);
              const firstSeen = typeof t["firstSeen"] === "string" ? t["firstSeen"] : "";
              return {
                id,
                sessions: typeof t["sessions"] === "number" ? t["sessions"] : 0,
                firstSeen,
                lastSeen: typeof t["lastSeen"] === "string" ? t["lastSeen"] : "",
                isNew: hasPrev ? !prevThemes.has(id) : isNewByTime(firstSeen),
                titles: cleanTitles(t["titles"], 2),
              };
            });
          const hotModules: RsiOutputsAtlasModule[] = (Array.isArray(derived["moduleActivity"]) ? derived["moduleActivity"] : [])
            .filter(isRecord).slice(0, 6)
            .map((m) => {
              const ctx = isRecord(m["context"]) ? m["context"] : {};
              const path = clip(m["path"], 60);
              const firstSeen = typeof m["firstSeen"] === "string" ? m["firstSeen"] : "";
              return {
                path,
                editSessions: typeof m["editSessions"] === "number" ? m["editSessions"] : 0,
                riskLevel: typeof ctx["riskLevel"] === "string" ? ctx["riskLevel"] : "",
                upstream: typeof ctx["upstream"] === "number" ? ctx["upstream"] : 0,
                firstSeen,
                lastSeen: typeof m["lastSeen"] === "string" ? m["lastSeen"] : "",
                isNew: hasPrev ? !prevModules.has(path) : isNewByTime(firstSeen),
              };
            });
          const genes: RsiOutputsAtlasGene[] = [];
          for (const g of (Array.isArray(raw["defectGenes"]) ? raw["defectGenes"] : []).slice(0, 6)) {
            if (!isRecord(g)) continue;
            genes.push({
              id: clip(g["id"], 60),
              defectClass: typeof g["defectClass"] === "string" ? g["defectClass"] : "",
              module: clip(g["module"], 60),
              count: typeof g["count"] === "number" ? g["count"] : 0,
              lastAt: typeof g["lastAt"] === "number" ? g["lastAt"] : 0,
            });
          }
          let latestEvolution = "";
          let latestAt = "";
          for (const g of goals) {
            const last = g.progress[g.progress.length - 1];
            if (last && last.at > latestAt) {
              latestAt = last.at;
              latestEvolution = last.note;
            }
          }
          const currentGoalIds = new Set(goals.map((g) => g.id));
          const droppedGoals = prevGoalRows
            .filter((g) => !currentGoalIds.has(String(g["id"] ?? "")))
            .slice(0, 3)
            .map((g) => ({ id: clip(g["id"], 60), title: clip(g["title"], 80) }));
          projects.push({
            project,
            label: labelByBase.get(project) ?? project,
            empty: false,
            goals,
            themes,
            hotModules,
            reworkSignals: Array.isArray(derived["reworkSignals"]) ? derived["reworkSignals"].length : 0,
            repeatExploration: Array.isArray(derived["repeatExploration"]) ? derived["repeatExploration"].length : 0,
            genes,
            sessions: typeof derived["sessionsScanned"] === "number" ? derived["sessionsScanned"] : 0,
            newGoals: goals.filter((g) => g.isNew).length,
            existingGoals: goals.filter((g) => !g.isNew).length,
            newHotModules: hotModules.filter((m) => m.isNew).length,
            existingHotModules: hotModules.filter((m) => !m.isNew).length,
            latestEvolution: clip(latestEvolution, 180),
            droppedGoals,
          });
        } catch { /* 单快照坏:跳过 */ }
      }
    }
    // 注册表里没有快照的项目:如实列出「暂无方向数据」
    for (const [baseName, label] of labelByBase) {
      if (seen.has(baseName)) continue;
      projects.push({
        project: baseName,
        label,
        empty: true,
        goals: [],
        themes: [],
        hotModules: [],
        reworkSignals: 0,
        repeatExploration: 0,
        genes: [],
        sessions: 0,
        newGoals: 0,
        existingGoals: 0,
        newHotModules: 0,
        existingHotModules: 0,
        latestEvolution: "",
        droppedGoals: [],
      });
    }
    if (projects.length > 0) out.projectsAtlas = projects;
  } catch { /* fail-open */ }
  // ⑭ 知识库(RAG 索引视图):证据图观测 + 缺陷基因 + 死路知识合并去重,标新增/已有与当前用途
  try {
    const knowledge = new Map<string, RsiOutputsKnowledgeItem>();
    const classLabel = (cls: string): string =>
      cls === "contract" ? "契约类" : cls === "boundary" ? "边界类" : cls === "security" ? "安全类" : cls === "performance" ? "性能类" : "未分类";
    const newest = (a: number, b: number): number => (a > b ? a : b);
    // 证据图:同一 cand-* 的多条观察合并成一条知识;fact 优先于 anti-pattern 作为类型。
    for (const ev of out.evidenceGraph?.items ?? []) {
      const base = knowledgeBaseKey(ev.statement);
      const existing = knowledge.get(base);
      if (existing !== undefined) {
        existing.observations += 1;
        existing.observedAt = newest(existing.observedAt, ev.observedAt);
        if (ev.kind === "fact") existing.type = "fact";
        if (ev.sourceNote !== "") existing.source = ev.sourceNote;
        continue;
      }
      knowledge.set(base, {
        id: base,
        type: ev.kind === "anti-pattern" ? "anti-pattern" : "fact",
        title: knowledgeTitle(ev.statement),
        detail: clip(ev.statement, 180),
        source: ev.sourceNote,
        observedAt: ev.observedAt,
        observations: 1,
        isNew: ev.observedAt > 0 && Date.now() - ev.observedAt <= REWORK_NEW_WINDOW_MS,
        action: "未行动",
        actionKind: "none",
      });
    }
    // 缺陷基因:模块 + 缺陷类,面板直接讲「下次改到这里要防什么」。
    for (const gene of out.atlas?.defectGenes ?? []) {
      const moduleBase = gene.module.split("/").pop() ?? gene.module;
      const at = typeof gene.lastAt === "number" ? gene.lastAt : 0;
      knowledge.set(`gene:${gene.id}`, {
        id: `gene:${gene.id}`,
        type: "gene",
        title: `${classLabel(gene.defectClass)} · ${moduleBase}`,
        detail: `该模块累计出现 ${gene.count} 次${classLabel(gene.defectClass)}返工;下次改到这里,开工/编辑提示会自动带出历史教训。`,
        source: "跨会话返工链",
        observedAt: at,
        observations: gene.count,
        isNew: at > 0 && Date.now() - at <= REWORK_NEW_WINDOW_MS,
        action: "已用于开工/编辑提示",
        actionKind: "injected",
      });
    }
    // 死路知识:agent 主动登记过的「此路不通 + 替代方案」。
    for (const dead of out.negkb?.items ?? []) {
      knowledge.set(`dead:${dead.id}`, {
        id: `dead:${dead.id}`,
        type: "dead-end",
        title: clip(dead.plan, 40) || "未命名死路",
        detail: [dead.symptoms.length ? `现象:${dead.symptoms.join(" / ")}` : "", dead.alternative ? `替代:${dead.alternative}` : ""].filter((x) => x !== "").join(";"),
        source: "死路台账",
        observedAt: dead.createdAt,
        observations: 1,
        isNew: dead.createdAt > 0 && Date.now() - dead.createdAt <= REWORK_NEW_WINDOW_MS,
        action: "已作为死路知识按需注入",
        actionKind: "injected",
      });
    }
    // 当前用途:能对上候选队列/实验的,直接写「已进灰度/已排队」。
    for (const item of knowledge.values()) {
      const queued = (out.queue?.items ?? []).find((q) => q.id !== "" && (item.id === q.id || item.id.includes(q.id) || q.id.includes(item.id)));
      if (queued !== undefined) {
        item.action = `已进候选队列(${queued.kind})`;
        item.actionKind = "queue";
      }
      const exp = (out.experiments?.rows ?? []).find(
        (r) => r.intervention !== "" && (item.id.includes(r.intervention) || r.claim.includes(item.title)),
      );
      if (exp !== undefined) {
        item.action = `灰度实验中(${exp.id})`;
        item.actionKind = "experiment";
      }
    }
    if (knowledge.size > 0) {
      const list = [...knowledge.values()].sort((a, b) => b.observedAt - a.observedAt);
      const byType: Record<string, number> = {};
      for (const item of list) byType[item.type] = (byType[item.type] ?? 0) + 1;
      const newCount = list.filter((i) => i.isNew).length;
      out.knowledge = { total: list.length, newCount, existingCount: list.length - newCount, byType, items: list.slice(0, 60) };
    }
  } catch { /* fail-open */ }
  return out;
}

const DEFAULT_READERS: Record<RsiSectionId, RsiSectionReader> = {
  nightly: readNightly,
  evidence: readEvidence,
  experiments: readExperiments,
  cost: readCost,
  injection: readInjection,
  tools: readTools,
  changeRequests: readChangeRequests,
  cohort: readCohort,
  negativeKb: readNegativeKb,
  prompts: readPrompts,
  atlas: readAtlas,
  pathology: readPathology,
};

// ------------------------------------------------------------------ 入口

/**
 * 汇总 12 区只读状态。任何单区失败都被折叠成该区的 `{ok:false, code}`,
 * 本函数本身只会返回结构化结果,不 throw。
 */
export async function collectRsiStatus(opts: {
  root: string;
  journal?: unknown;
  now?: number;
  readers?: Partial<RsiStatusReaders>;
}): Promise<{ at: number; sections: RsiStatusSection[]; okCount: number; warnCount: number; outputs: RsiOutputsSnapshot }> {
  const at = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();
  const root = typeof opts.root === "string" ? opts.root : "";
  const readers: Record<RsiSectionId, RsiSectionReader> = { ...DEFAULT_READERS };
  const overrides = opts.readers;
  if (overrides !== undefined && overrides !== null) {
    for (const id of RSI_SECTION_IDS) {
      const reader = overrides[id];
      if (typeof reader === "function") readers[id] = reader;
    }
  }
  const sections: RsiStatusSection[] = [];
  for (const id of RSI_SECTION_IDS) {
    sections.push(await runSection(id, readers[id], root));
  }
  const okCount = sections.filter((section) => section.ok === true).length;
  // B:产物面(outputs)与 12 区同帧带出——server `...r` 透传,面板零协议改动即得。
  const outputs = await collectRsiOutputs(root);
  return { at, sections, okCount, warnCount: sections.length - okCount, outputs };
}
