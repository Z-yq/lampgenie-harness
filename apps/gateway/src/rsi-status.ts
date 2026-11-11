/**
 * RSI 只读聚合器:把 12 个 RSI 子系统投影折成一份 `RsiStatusSection[]` 状态快照。
 * 依赖纪律(为什么是 lazy import):
 * - 缺省 readers 用 `await import("./xxx-store.js")` 逐区加载。src 内相对动态 import 是既有风格
 * (见 agent-wiring.ts 多处的 `await import("./board-store.js")`),esbuild 对相对模块的动态 import
 * 会在同一 bundle 内解析并折叠,不破坏 `--format=esm` 单文件产物;而静态 import 会把 13 个 store
 * 及其 runtime 依赖全量拉进任何引用本模块的构建图。
 * - 严格只读:本文件不 mkdir、不写文件。store 缺失一律先 `existsSync` 判定 → `{ok:false, code:"UNAVAILABLE"}`;
 * 读取过程中出现的 ENOENT/任意异常由区级 try/catch 折成 `ERROR`,绝不整体 throw。
 * - 归一化后每区 metrics ≤ 8 条、每区 warnings ≤ 8 条(单条文本截 160 字)。
 */
import { existsSync, readdirSync } from "node:fs";
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
 /** 机制开关( RSI-MECH;缺省=未注入)。 */
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
 /** 本次运行成本( RSI-SESSION-COST;旧数据无此字段)。 */
  cost?: RsiStatusRunCost;
 /** 本次运行的会话分析计划与认账(旧数据无此字段)。 */
  analysis?: RsiStatusRunAnalysis;
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
  return {
    ok: done,
    code: done ? undefined : "NOT_DONE",
    metrics: [
      { label: "最近状态", value: status, tone: done ? "ok" : status === "failed" ? "bad" : "warn" },
      { label: "最近日期", value: last.date },
      { label: "最近项目", value: last.projectId },
      { label: "运行数", value: runs.length, tone: "ok" },
      { label: "步骤数", value: Array.isArray(last.steps) ? last.steps.length : 0 },
    ],
    warnings: done ? [] : [`最近一次夜间运行状态为 ${status}`],
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
  const { atlasDir, reportAtlas } = await import("./direction-atlas-store.js");
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
}): Promise<{ at: number; sections: RsiStatusSection[]; okCount: number; warnCount: number }> {
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
  return { at, sections, okCount, warnCount: sections.length - okCount };
}
