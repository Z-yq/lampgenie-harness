/**
 * RSI 成本台账持久层(生产侧,RSI 成本 2026-11):把 rsi-cost-roi 的纯逻辑落到 append-only jsonl。
 *
 * 为什么 append-only:成本与节省都是审计事实(花了多少、省了多少、门禁在哪一刻降频/停摆),
 * 不能被后来的写入覆盖或抹掉。单行追加 + 写后行数校验(重读文件统计非空行数)让「写成功了吗」
 * 变成可复核的断言,而不是信任 appendFileSync 没抛异常。
 *
 * 数据面:`<root>/.genie/rsi/cost.jsonl`,每行一条 `{"v":1,"type":...,"at":ISO,...}`
 * - `cost{id,cycleId,stage,tokens,wallMs,usd?,mechanismId?,projectId?,model?}` —— 一笔花费(字段与行平铺)。
 * - `saving{id,cycleId,tokensSaved,wallMsSaved?,usdSaved?,evidenceRefs?}` —— 一笔节省。
 * - `roi-eval{action,codes,negativeStreak,quota,policy,cycleIds,detail}` —— 一次「已应用」的评测结论。
 * - `downshift{action,quota,negativeStreak,policy}` —— 降频/停摆的落地后果(report 取最后一条当现状)。
 *
 * 投影语义:
 * - evaluateRoiGate 预览(apply 缺省/false)不落盘;apply=true 且 action!="ok" 时落 roi-eval + downshift 两行
 *   (评测事实 + 落地后果分开记);action="ok" 不落盘。
 * - action="pause" 且传了 breakerRoot → await rsi-breaker-store.pause(trigger:"auto-negative-streak",
 *   reason 以 "roi-gate:" 开头),返回里带 breaker 结果(ok/codes/state)。
 * - 坏行(JSON 坏 / 未知 v / 未知 type / 缺 at / 条目字段非法)只计入 badLines 并跳过:一行坏不整文件失效、不 throw。
 *
 * 依赖纪律:node:fs / node:path + runtime 纯逻辑(两跳惰性解析)+ 惰性复用 rsi-breaker-store.pause
 * (不重复实现熔断折叠)。参数错误是唯一允许 throw 的情形(TypeError);IO/投影/闸门失败一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AllocationRow,
  CostEntry,
  CycleReport,
  RoiGateResult,
  RoiPolicy,
  RoiQuota,
  SavingEntry,
} from "@lampgenie/runtime/agent/rsi-cost-roi";

/** store 层自产的失败码(闸门码沿用 runtime 的 RSI_ROI_CODES)。 */
export const RSI_COST_STORE_CODES = ["RSI_COST_WRITE_MISMATCH", "RSI_COST_STORE_ERROR"] as const;

export type RsiCostStoreCode = (typeof RSI_COST_STORE_CODES)[number];

/** 台账行类型(只增不改)。 */
export const RSI_COST_LINE_TYPES = ["cost", "saving", "roi-eval", "downshift"] as const;

export type RsiCostLineType = (typeof RSI_COST_LINE_TYPES)[number];

/** 台账路径(目录 + 文件各一份,便于上层建目录/守护)。 */
export interface RsiCostPaths {
  dir: string;
  file: string;
}

type UnknownRecord = Record<string, unknown>;

interface RoiRuntime {
  readonly RSI_COST_VERSION: number;
  cycleReport(input: { cycleId: string; costs?: readonly unknown[]; savings?: readonly unknown[] }): CycleReport;
  summarizeCycles(
    cycleIds: readonly string[] | undefined,
    costs: readonly unknown[] | undefined,
    savings: readonly unknown[] | undefined,
  ): {
    reports: CycleReport[];
    total: {
      costTokens: number;
      savingTokens: number;
      netTokens: number;
      roi: number | null;
      wallMs: number;
      costByStage: Record<string, number>;
      costByMechanism: Record<string, number>;
      costByProject: Record<string, number>;
    };
  };
  evaluateRoiGate(reports: readonly CycleReport[] | undefined, policy?: Partial<RoiPolicy>): RoiGateResult;
  allocateByMechanism(costs: readonly unknown[] | undefined, savings: readonly unknown[] | undefined): AllocationRow[];
  allocateByProject(costs: readonly unknown[] | undefined, savings: readonly unknown[] | undefined): AllocationRow[];
}

let roiRuntime: RoiRuntime | undefined;

/**
 * 两跳解析 runtime 模块:静态无后缀 import 在 `node --experimental-strip-types` 下会解析到
 * dist(dist 里没有新模块),因此失败时回落源码 `.ts` URL。
 */
async function loadRoiRuntime(): Promise<RoiRuntime> {
  if (roiRuntime) return roiRuntime;
  const spec = "@lampgenie/runtime/agent/rsi-cost-roi";
  try {
    roiRuntime = (await import(spec)) as unknown as RoiRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/rsi-cost-roi.ts", import.meta.url).href;
    roiRuntime = (await import(srcUrl)) as unknown as RoiRuntime;
  }
  return roiRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadRoiRuntime();

/** 台账 schema 版本(与 runtime 同源)。 */
const SCHEMA_VERSION = rt.RSI_COST_VERSION;

const KNOWN_TYPES: ReadonlySet<string> = new Set<string>(RSI_COST_LINE_TYPES);

interface BreakerPauseResult {
  ok: boolean;
  codes: string[];
  state: unknown;
}

interface BreakerModule {
  pause(
    root: string,
    opts: { by: string; reason: string; scope?: string; trigger?: string; at?: string },
  ): Promise<BreakerPauseResult>;
}

let breakerModule: BreakerModule | undefined;

/** 惰性复用熔断台账(两跳同 runtime:源码 URL 回落)。 */
async function loadBreakerModule(): Promise<BreakerModule> {
  if (breakerModule) return breakerModule;
  const srcUrl = new URL("./rsi-breaker-store.ts", import.meta.url).href;
  breakerModule = (await import(srcUrl)) as unknown as BreakerModule;
  return breakerModule;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 参数错误校验(唯一允许 throw 的情形)。 */
function assertRoot(fn: string, root: unknown): string {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError(`${fn}: root 必须是非空字符串`);
  return root;
}

function assertCycleId(fn: string, cycleId: unknown): string {
  const id = nonEmpty(cycleId);
  if (id === undefined) throw new TypeError(`${fn}: cycleId 必须是非空字符串`);
  return id;
}

/** 成本台账路径:`<root>/.genie/rsi/cost.jsonl`。 */
export function costPaths(root: string): RsiCostPaths {
  const base = assertRoot("costPaths", root);
  const dir = join(base, ".genie", "rsi");
  return { dir, file: join(dir, "cost.jsonl") };
}

/** 时间戳(入参缺省 → 当前 ISO)。 */
function atOf(at?: unknown): string {
  return nonEmpty(at) ?? new Date().toISOString();
}

/** 读台账非空行数(文件不存在 → 0)。 */
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

/**
 * 追加一行并做写后行数校验:重读文件统计非空行数,必须等于「写前行数 + 1」。
 * 校验失败返回 false(调用方折叠成 RSI_COST_WRITE_MISMATCH);不回滚已写内容、不 throw。
 */
function appendLine(root: string, line: UnknownRecord): boolean {
  const { file } = costPaths(root);
  const before = countLines(file);
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    return false;
  }
  return countLines(file) === before + 1;
}

/** 台账投影:合法行 + 坏行计数。 */
export interface RsiCostProjection {
  rows: UnknownRecord[];
  badLines: number;
  totalLines: number;
}

/** 读台账并投影:坏行(JSON 坏 / 未知 v / 未知 type / 缺 at)计入 badLines 跳过。 */
export function loadCostProjection(root: string): RsiCostProjection {
  const base = assertRoot("loadCostProjection", root);
  const { file } = costPaths(base);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { rows: [], badLines: 0, totalLines: 0 };
  }
  const rows: UnknownRecord[] = [];
  let badLines = 0;
  let totalLines = 0;
  for (const raw of text.split("\n")) {
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
    const type = nonEmpty(parsed["type"]);
    if (type === undefined || !KNOWN_TYPES.has(type)) {
      badLines += 1;
      continue;
    }
    if (nonEmpty(parsed["at"]) === undefined) {
      badLines += 1;
      continue;
    }
    rows.push(parsed);
  }
  return { rows, badLines, totalLines };
}

/** 行 → 成本条目(去掉行信封 v/type),字段原样交给纯逻辑校验。 */
function costsOf(rows: readonly UnknownRecord[]): UnknownRecord[] {
  const out: UnknownRecord[] = [];
  for (const row of rows) {
    if (row["type"] !== "cost") continue;
    const entry: UnknownRecord = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === "v" || key === "type") continue;
      entry[key] = value;
    }
    out.push(entry);
  }
  return out;
}

/** 行 → 节省条目。 */
function savingsOf(rows: readonly UnknownRecord[]): UnknownRecord[] {
  const out: UnknownRecord[] = [];
  for (const row of rows) {
    if (row["type"] !== "saving") continue;
    const entry: UnknownRecord = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === "v" || key === "type") continue;
      entry[key] = value;
    }
    out.push(entry);
  }
  return out;
}

/** 台账全部 cycleId(首次出现顺序,旧→新)。 */
function cycleIdsOf(rows: readonly UnknownRecord[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const type = row["type"];
    if (type !== "cost" && type !== "saving") continue;
    const id = nonEmpty(row["cycleId"]);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 只保留条目已知字段(防止任意键污染台账行)。 */
function pickCostFields(entry: UnknownRecord): UnknownRecord {
  const row: UnknownRecord = {};
  for (const key of ["id", "cycleId", "stage", "mechanismId", "projectId", "model", "tokens", "wallMs", "usd"]) {
    if (entry[key] !== undefined) row[key] = entry[key];
  }
  return row;
}

function pickSavingFields(entry: UnknownRecord): UnknownRecord {
  const row: UnknownRecord = {};
  for (const key of ["id", "cycleId", "mechanismId", "projectId", "tokensSaved", "wallMsSaved", "usdSaved", "evidenceRefs"]) {
    if (entry[key] !== undefined) row[key] = entry[key];
  }
  return row;
}

/** 记一笔成本(字段非法不在写入时拒:交给纯逻辑在报告时计入 invalid,台账只忠实落盘)。 */
export function recordCost(
  root: string,
  entry: CostEntry | UnknownRecord,
): { ok: boolean; codes: string[]; at?: string } {
  const base = assertRoot("recordCost", root);
  if (!isRecord(entry)) throw new TypeError("recordCost: entry 必须是对象");
  const at = atOf(entry["at"]);
  const line: UnknownRecord = { v: SCHEMA_VERSION, type: "cost", at, ...pickCostFields(entry) };
  if (!appendLine(base, line)) return { ok: false, codes: ["RSI_COST_WRITE_MISMATCH"] };
  return { ok: true, codes: [], at };
}

/** 记一笔节省。 */
export function recordSavings(
  root: string,
  entry: SavingEntry | UnknownRecord,
): { ok: boolean; codes: string[]; at?: string } {
  const base = assertRoot("recordSavings", root);
  if (!isRecord(entry)) throw new TypeError("recordSavings: entry 必须是对象");
  const at = atOf(entry["at"]);
  const line: UnknownRecord = { v: SCHEMA_VERSION, type: "saving", at, ...pickSavingFields(entry) };
  if (!appendLine(base, line)) return { ok: false, codes: ["RSI_COST_WRITE_MISMATCH"] };
  return { ok: true, codes: [], at };
}

/** 单周期报告(带坏行数)。 */
export function cycleReport(root: string, cycleId: string): CycleReport & { badLines: number } {
  const base = assertRoot("cycleReport", root);
  const id = assertCycleId("cycleReport", cycleId);
  const projection = loadCostProjection(base);
  let report: CycleReport;
  try {
    report = rt.cycleReport({ cycleId: id, costs: costsOf(projection.rows), savings: savingsOf(projection.rows) });
  } catch {
    report = {
      cycleId: id,
      costTokens: 0,
      savingTokens: 0,
      netTokens: 0,
      roi: null,
      costByStage: {},
      costByMechanism: {},
      costByProject: {},
      wallMs: 0,
      entries: { costs: 0, savings: 0 },
      codes: ["RSI_COST_STORE_ERROR"],
      invalid: 0,
    };
  }
  return { ...report, badLines: projection.badLines };
}

/** 评测入参。 */
export interface EvaluateCostOptions {
  cycleIds?: string[];
  policy?: Partial<RoiPolicy>;
  apply?: boolean;
  breakerRoot?: string;
}

/** 评测结论(纯逻辑结论 + 落盘/熔断结果)。 */
export interface EvaluateCostResult extends RoiGateResult {
  ok: boolean;
  applied: boolean;
  cycleIds: string[];
  policy: Partial<RoiPolicy> | undefined;
  reports: CycleReport[];
  wroteLines: number;
  badLines: number;
  breaker?: BreakerPauseResult;
}

function isPolicyObject(policy: unknown): policy is Partial<RoiPolicy> {
  return policy === undefined || isRecord(policy);
}

/**
 * 评测 ROI 门:cycleIds 缺省=台账全部 cycleId(首次出现顺序旧→新)。
 * apply 缺省/false → 纯预览不落盘;apply=true 且 action!="ok" → 落 roi-eval + downshift 行,
 * action="pause" 且传 breakerRoot → 调熔断台账 pause(trigger:"auto-negative-streak")。
 */
export async function evaluateRoiGate(root: string, opts?: EvaluateCostOptions): Promise<EvaluateCostResult> {
  const base = assertRoot("evaluateRoiGate", root);
  if (opts !== undefined && !isRecord(opts)) throw new TypeError("evaluateRoiGate: opts 必须是对象");
  const options: EvaluateCostOptions = opts ?? {};
  if (!isPolicyObject(options.policy)) throw new TypeError("evaluateRoiGate: policy 必须是对象");
  if (options.cycleIds !== undefined && !Array.isArray(options.cycleIds)) {
    throw new TypeError("evaluateRoiGate: cycleIds 必须是字符串数组");
  }
  if (options.breakerRoot !== undefined && nonEmpty(options.breakerRoot) === undefined) {
    throw new TypeError("evaluateRoiGate: breakerRoot 必须是非空字符串");
  }

  const projection = loadCostProjection(base);
  const costs = costsOf(projection.rows);
  const savings = savingsOf(projection.rows);
  const cycleIds = options.cycleIds !== undefined ? options.cycleIds.map((id) => String(id)) : cycleIdsOf(projection.rows);

  let reports: CycleReport[];
  let gate: RoiGateResult;
  try {
    const summary = rt.summarizeCycles(cycleIds, costs, savings);
    reports = summary.reports;
    gate = rt.evaluateRoiGate(reports, options.policy);
  } catch {
    return {
      ok: false,
      codes: ["RSI_COST_STORE_ERROR"],
      action: "ok",
      negativeStreak: 0,
      quota: {},
      detail: "ROI 评测失败",
      applied: false,
      cycleIds,
      policy: options.policy,
      reports: [],
      wroteLines: 0,
      badLines: projection.badLines,
    };
  }

  const result: EvaluateCostResult = {
    ...gate,
    ok: true,
    applied: false,
    cycleIds,
    policy: options.policy,
    reports,
    wroteLines: 0,
    badLines: projection.badLines,
  };

  if (options.apply !== true || gate.action === "ok") return result;

  const at = new Date().toISOString();
  const quota: RoiQuota = gate.quota;
  const evalLine: UnknownRecord = {
    v: SCHEMA_VERSION,
    type: "roi-eval",
    at,
    action: gate.action,
    codes: gate.codes,
    negativeStreak: gate.negativeStreak,
    quota,
    policy: options.policy ?? {},
    cycleIds,
    detail: gate.detail,
  };
  if (!appendLine(base, evalLine)) {
    return { ...result, ok: false, codes: [...gate.codes, "RSI_COST_WRITE_MISMATCH"] };
  }
  let wrote = 1;
  const downshiftLine: UnknownRecord = {
    v: SCHEMA_VERSION,
    type: "downshift",
    at,
    action: gate.action,
    quota,
    negativeStreak: gate.negativeStreak,
    policy: options.policy ?? {},
  };
  if (!appendLine(base, downshiftLine)) {
    return { ...result, ok: false, applied: false, wroteLines: wrote, codes: [...gate.codes, "RSI_COST_WRITE_MISMATCH"] };
  }
  wrote += 1;
  const applied: EvaluateCostResult = { ...result, applied: true, wroteLines: wrote };

  if (gate.action !== "pause") return applied;
  const breakerRoot = nonEmpty(options.breakerRoot);
  if (breakerRoot === undefined) return applied;
  try {
    const breaker = await loadBreakerModule();
    applied.breaker = await breaker.pause(breakerRoot, {
      by: "rsi-cost",
      reason: "roi-gate: 连续负 ROI 达 pauseAfter",
      scope: "all",
      trigger: "auto-negative-streak",
      at,
    });
  } catch {
    applied.breaker = { ok: false, codes: ["RSI_COST_STORE_ERROR"], state: {} };
  }
  return applied;
}

/** 最近一条 downshift 行(report 的现状位)。 */
export interface LastDownshift {
  at: string;
  action: string;
  quota: RoiQuota;
  negativeStreak: number;
}

/** 成本汇总报告。 */
export interface CostReport {
  ok: boolean;
  codes: string[];
  cycles: string[];
  totals: {
    costTokens: number;
    savingTokens: number;
    netTokens: number;
    roi: number | null;
    wallMs: number;
    costByStage: Record<string, number>;
    costByMechanism: Record<string, number>;
    costByProject: Record<string, number>;
  };
  reports: CycleReport[];
  byMechanism: AllocationRow[];
  byProject: AllocationRow[];
  lastGate: LastDownshift | undefined;
  badLines: number;
  totalLines: number;
}

/** 汇总:周期列表 + 累计 + 两维度分摊 + 最近降频/停摆状态 + 坏行数。 */
export function reportCost(root: string): CostReport {
  const base = assertRoot("reportCost", root);
  const projection = loadCostProjection(base);
  const costs = costsOf(projection.rows);
  const savings = savingsOf(projection.rows);
  const cycles = cycleIdsOf(projection.rows);

  let reports: CycleReport[] = [];
  let totals: CostReport["totals"] = {
    costTokens: 0,
    savingTokens: 0,
    netTokens: 0,
    roi: null,
    wallMs: 0,
    costByStage: {},
    costByMechanism: {},
    costByProject: {},
  };
  let byMechanism: AllocationRow[] = [];
  let byProject: AllocationRow[] = [];
  let codes: string[] = [];
  try {
    const summary = rt.summarizeCycles(cycles, costs, savings);
    reports = summary.reports;
    totals = summary.total;
    byMechanism = rt.allocateByMechanism(costs, savings);
    byProject = rt.allocateByProject(costs, savings);
  } catch {
    codes = ["RSI_COST_STORE_ERROR"];
  }

  let lastGate: LastDownshift | undefined;
  for (const row of projection.rows) {
    if (row["type"] !== "downshift") continue;
    const at = nonEmpty(row["at"]);
    const action = nonEmpty(row["action"]);
    if (at === undefined || action === undefined) continue;
    const quotaRaw = isRecord(row["quota"]) ? row["quota"] : {};
    const quota: RoiQuota = {};
    const nightly = finiteNumber(quotaRaw["nightlyWindowFactor"]);
    const experiment = finiteNumber(quotaRaw["experimentQuotaFactor"]);
    if (nightly !== undefined) quota.nightlyWindowFactor = nightly;
    if (experiment !== undefined) quota.experimentQuotaFactor = experiment;
    lastGate = { at, action, quota, negativeStreak: finiteNumber(row["negativeStreak"]) ?? 0 };
  }

  return {
    ok: codes.length === 0,
    codes,
    cycles,
    totals,
    reports,
    byMechanism,
    byProject,
    lastGate,
    badLines: projection.badLines,
    totalLines: projection.totalLines,
  };
}
