/**
 * RSI 成本与 ROI 门(纯逻辑零 IO,RSI 成本 2026-11)。
 * 为什么需要它:自我改进循环(RSI)每次挖掘/归因/实验/复盘都在烧 token 与墙钟,但「省了多少」往往没口径——
 * 于是循环可以长期负净值运行而没人察觉。本模块把「花」与「省」统一成两条台账(CostEntry / SavingEntry),
 * 按周期(cycleId)折成净值,再给出三个结论:
 * - cycleReport:单周期账本(costTokens / savingTokens / netTokens / roi),roi = saving/cost(cost=0 → null)。
 * - evaluateRoiGate:按传入顺序(旧→新)只数**末尾连续**净负周期;达到 downshiftAfter → 降频(两个配额因子打折),
 *   达到 pauseAfter → 停摆(优先于降频)。netTokens===0 不算负,转正即清零。
 * - adoptRoiGate:实验采纳前的硬门——没有经验证 ROI 直接拒(adopt 不允许拿估算当证据),
 * 经验证低于 minRoi 或估算为负也拒。
 * 依赖纪律:零 import(不读文件/环境/网络/时间),所有函数不 throw:
 * 非法 entry(缺 id/cycleId/at、tokens 非有限数、stage 不在枚举…)只计入 invalid 计数后跳过。
 * 码表顺序固定(便于自动化按码断言):NEGATIVE_STREAK 在前,动作码在后。
 */

/** 成本账本 schema 版本:字段语义变化时递增。 */
export const RSI_COST_VERSION = 1;

/** 成本阶段:挖掘 / 归因 / 实验 / 复盘 / 其它。 */
export type RsiStage = "mining" | "attribution" | "experiment" | "retro" | "other";

/** 全部合法阶段(固定顺序;costByStage 以此为键序)。 */
export const RSI_STAGES = ["mining", "attribution", "experiment", "retro", "other"] as const;

/** 稳定码:ROI 门与账本的判断结论(字符串常量,便于落盘与断言)。 */
export const RSI_ROI_OK = "RSI_ROI_OK" as const;
export const RSI_ROI_NEGATIVE_STREAK = "RSI_ROI_NEGATIVE_STREAK" as const;
export const RSI_ROI_DOWNSHIFT = "RSI_ROI_DOWNSHIFT" as const;
export const RSI_ROI_PAUSE = "RSI_ROI_PAUSE" as const;
export const RSI_ROI_ENTRY_INVALID = "RSI_ROI_ENTRY_INVALID" as const;
export const RSI_ROI_ZERO_COST = "RSI_ROI_ZERO_COST" as const;
export const RSI_ROI_ADOPT_BLOCKED = "RSI_ROI_ADOPT_BLOCKED" as const;
export const RSI_ROI_ADOPT_NO_MEASURED = "RSI_ROI_ADOPT_NO_MEASURED" as const;

/** 全部稳定码(固定顺序)。 */
export const RSI_ROI_CODES = [
  RSI_ROI_OK,
  RSI_ROI_NEGATIVE_STREAK,
  RSI_ROI_DOWNSHIFT,
  RSI_ROI_PAUSE,
  RSI_ROI_ENTRY_INVALID,
  RSI_ROI_ZERO_COST,
  RSI_ROI_ADOPT_BLOCKED,
  RSI_ROI_ADOPT_NO_MEASURED,
] as const;

export type RsiRoiCode = (typeof RSI_ROI_CODES)[number];

/** 缺省分摊键(条目没给 mechanismId / projectId 时)。 */
export const RSI_UNASSIGNED_KEY = "(unassigned)";

/** token 三元组(total 应是 input+output,读取时按兜底算)。 */
export interface CostTokens {
  input: number;
  output: number;
  total: number;
}

/** 成本条目:一次 RSI 动作烧掉的资源。 */
export interface CostEntry {
  id: string;
  cycleId: string;
  at: string;
  stage: RsiStage;
  mechanismId?: string;
  projectId?: string;
  model?: string;
  tokens: CostTokens;
  wallMs: number;
  usd?: number;
}

/** 节省条目:一次 RSI 动作省回来的资源(tokensSaved 是唯一必填配额)。 */
export interface SavingEntry {
  id: string;
  cycleId: string;
  at: string;
  mechanismId?: string;
  projectId?: string;
  tokensSaved: number;
  wallMsSaved?: number;
  usdSaved?: number;
  evidenceRefs?: string[];
}

/** ROI 门策略(downshiftAfter / pauseAfter 是「末尾连续负周期数」阈值)。 */
export interface RoiPolicy {
  downshiftAfter: number;
  pauseAfter: number;
  downshiftFactor: number;
  minCycleSamples: number;
  adoptMinRoi: number;
}

/** 缺省策略:连负 3 周期降频(配额打 0.5),连负 6 周期停摆,采纳门槛 10%。 */
export const ROI_POLICY_DEFAULTS: RoiPolicy = {
  downshiftAfter: 3,
  pauseAfter: 6,
  downshiftFactor: 0.5,
  minCycleSamples: 1,
  adoptMinRoi: 0.1,
};

/** 一段条目的聚合(非法条目计入 invalid,不进任何数值)。 */
export interface CostAggregate {
  tokens: CostTokens;
  wallMs: number;
  usd: number;
  valid: number;
  invalid: number;
}

/** 单周期报告。 */
export interface CycleReport {
  cycleId: string;
  costTokens: number;
  savingTokens: number;
  netTokens: number;
  roi: number | null;
  costByStage: Record<string, number>;
  costByMechanism: Record<string, number>;
  costByProject: Record<string, number>;
  wallMs: number;
  entries: { costs: number; savings: number };
  codes: string[];
  invalid: number;
}

/** 全周期合计(按阶段/机制/项目分摊)。 */
export interface CycleTotals {
  costTokens: number;
  savingTokens: number;
  netTokens: number;
  roi: number | null;
  wallMs: number;
  costByStage: Record<string, number>;
  costByMechanism: Record<string, number>;
  costByProject: Record<string, number>;
}

/** ROI 门配额(降频时两因子同时打折;ok 时为空对象)。 */
export interface RoiQuota {
  nightlyWindowFactor?: number;
  experimentQuotaFactor?: number;
}

/** ROI 门结论。 */
export interface RoiGateResult {
  action: "ok" | "downshift" | "pause";
  codes: string[];
  negativeStreak: number;
  quota: RoiQuota;
  detail: string;
}

/** 采纳门结论。 */
export interface AdoptGateResult {
  ok: boolean;
  codes: string[];
  detail: string;
}

/** 分摊行(缺省键是 RSI_UNASSIGNED_KEY;net 允许为负)。 */
export interface AllocationRow {
  key: string;
  costTokens: number;
  savingTokens: number;
  netTokens: number;
  costWallMs: number;
  savingWallMs: number;
  usd: number;
  usdSaved: number;
  entries: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function stageOf(value: unknown): RsiStage | undefined {
  const text = nonEmptyText(value);
  if (text === undefined) return undefined;
  return (RSI_STAGES as readonly string[]).includes(text) ? (text as RsiStage) : undefined;
}

/** 规范化后的成本条目(全数值已保证有限)。 */
interface NormalizedCost {
  stage: RsiStage;
  mechanismKey: string;
  projectKey: string;
  input: number;
  output: number;
  total: number;
  wallMs: number;
  usd: number;
}

interface NormalizedSaving {
  mechanismKey: string;
  projectKey: string;
  tokens: number;
  wallMs: number;
  usd: number;
}

/** 读成本条目:任何必填项缺失/非有限数 → undefined(计入 invalid)。 */
function readCost(entry: unknown): NormalizedCost | undefined {
  if (!isRecord(entry)) return undefined;
  if (nonEmptyText(entry["id"]) === undefined) return undefined;
  if (nonEmptyText(entry["cycleId"]) === undefined) return undefined;
  if (nonEmptyText(entry["at"]) === undefined) return undefined;
  const stage = stageOf(entry["stage"]);
  if (stage === undefined) return undefined;
  const tokens = entry["tokens"];
  if (!isRecord(tokens)) return undefined;
  const input = finiteNumber(tokens["input"]);
  const output = finiteNumber(tokens["output"]);
  if (input === undefined || output === undefined) return undefined;
  if (input < 0 || output < 0) return undefined;
  const rawTotal = tokens["total"];
  const total = rawTotal === undefined || rawTotal === null ? input + output : finiteNumber(rawTotal);
  if (total === undefined || total < 0) return undefined;
  const wallMs = finiteNumber(entry["wallMs"]);
  if (wallMs === undefined || wallMs < 0) return undefined;
  const rawUsd = entry["usd"];
  const usd = rawUsd === undefined || rawUsd === null ? 0 : finiteNumber(rawUsd);
  if (usd === undefined) return undefined;
  return {
    stage,
    mechanismKey: nonEmptyText(entry["mechanismId"]) ?? RSI_UNASSIGNED_KEY,
    projectKey: nonEmptyText(entry["projectId"]) ?? RSI_UNASSIGNED_KEY,
    input,
    output,
    total,
    wallMs,
    usd,
  };
}

/** 读节省条目:tokensSaved 必填有限且非负;wallMsSaved/usdSaved 缺省按 0。 */
function readSaving(entry: unknown): NormalizedSaving | undefined {
  if (!isRecord(entry)) return undefined;
  if (nonEmptyText(entry["id"]) === undefined) return undefined;
  if (nonEmptyText(entry["cycleId"]) === undefined) return undefined;
  if (nonEmptyText(entry["at"]) === undefined) return undefined;
  const tokens = finiteNumber(entry["tokensSaved"]);
  if (tokens === undefined || tokens < 0) return undefined;
  const rawWall = entry["wallMsSaved"];
  const wallMs = rawWall === undefined || rawWall === null ? 0 : finiteNumber(rawWall);
  if (wallMs === undefined) return undefined;
  const rawUsd = entry["usdSaved"];
  const usd = rawUsd === undefined || rawUsd === null ? 0 : finiteNumber(rawUsd);
  if (usd === undefined) return undefined;
  return {
    mechanismKey: nonEmptyText(entry["mechanismId"]) ?? RSI_UNASSIGNED_KEY,
    projectKey: nonEmptyText(entry["projectId"]) ?? RSI_UNASSIGNED_KEY,
    tokens,
    wallMs,
    usd,
  };
}

function emptyTokens(): CostTokens {
  return { input: 0, output: 0, total: 0 };
}

/** 汇总成本条目(用不着分摊时用这个;cycleReport 内有单遍实现)。 */
export function sumCosts(entries: readonly unknown[] | undefined): CostAggregate {
  const out: CostAggregate = { tokens: emptyTokens(), wallMs: 0, usd: 0, valid: 0, invalid: 0 };
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const cost = readCost(entry);
    if (cost === undefined) {
      out.invalid += 1;
      continue;
    }
    out.valid += 1;
    out.tokens.input += cost.input;
    out.tokens.output += cost.output;
    out.tokens.total += cost.total;
    out.wallMs += cost.wallMs;
    out.usd += cost.usd;
  }
  return out;
}

/** 汇总节省条目(tokens 只填 total,input/output 恒 0——节省没有输入输出之分)。 */
export function sumSavings(entries: readonly unknown[] | undefined): CostAggregate {
  const out: CostAggregate = { tokens: emptyTokens(), wallMs: 0, usd: 0, valid: 0, invalid: 0 };
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const saving = readSaving(entry);
    if (saving === undefined) {
      out.invalid += 1;
      continue;
    }
    out.valid += 1;
    out.tokens.total += saving.tokens;
    out.wallMs += saving.wallMs;
    out.usd += saving.usd;
  }
  return out;
}

/** 空的分摊表(阶段键全给 0,便于消费方不必判 undefined)。 */
function emptyStageMap(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const stage of RSI_STAGES) out[stage] = 0;
  return out;
}

function bump(map: Record<string, number>, key: string, value: number): void {
  map[key] = (map[key] ?? 0) + value;
}

/** 只取该周期且 cycleId 字段匹配的原始条目(先按 cycleId 过滤,再校验:invalid 才计得准)。 */
function sameCycle(entry: unknown, cycleId: string): boolean {
  return isRecord(entry) && entry["cycleId"] === cycleId;
}

/**
 * 单周期报告:只取 cycleId 匹配的条目;costTokens=0 时 roi=null 且 codes 带 RSI_ROI_ZERO_COST
 * (净额照算:没有成本也可能有净节省)。wallMs 是周期内「花 + 省」的墙钟合计。
 */
export function cycleReport(input: {
  cycleId: string;
  costs?: readonly unknown[];
  savings?: readonly unknown[];
}): CycleReport {
  const cycleId = nonEmptyText(isRecord(input) ? input.cycleId : undefined) ?? "";
  const costs = isRecord(input) && Array.isArray(input.costs) ? input.costs : [];
  const savings = isRecord(input) && Array.isArray(input.savings) ? input.savings : [];

  const costByStage = emptyStageMap();
  const costByMechanism: Record<string, number> = {};
  const costByProject: Record<string, number> = {};
  let costTokens = 0;
  let costWallMs = 0;
  let costCount = 0;
  let invalid = 0;

  for (const raw of costs) {
    if (!sameCycle(raw, cycleId)) continue;
    const cost = readCost(raw);
    if (cost === undefined) {
      invalid += 1;
      continue;
    }
    costCount += 1;
    costTokens += cost.total;
    bump(costByStage, cost.stage, cost.total);
    bump(costByMechanism, cost.mechanismKey, cost.total);
    bump(costByProject, cost.projectKey, cost.total);
    costWallMs += cost.wallMs;
  }

  let savingTokens = 0;
  let savingWallMs = 0;
  let savingCount = 0;
  for (const raw of savings) {
    if (!sameCycle(raw, cycleId)) continue;
    const saving = readSaving(raw);
    if (saving === undefined) {
      invalid += 1;
      continue;
    }
    savingCount += 1;
    savingTokens += saving.tokens;
    savingWallMs += saving.wallMs;
  }

  const netTokens = savingTokens - costTokens;
  const codes: string[] = [];
  if (costTokens === 0) codes.push(RSI_ROI_ZERO_COST);
  if (invalid > 0) codes.push(RSI_ROI_ENTRY_INVALID);

  return {
    cycleId,
    costTokens,
    savingTokens,
    netTokens,
    roi: costTokens > 0 ? savingTokens / costTokens : null,
    costByStage,
    costByMechanism,
    costByProject,
    wallMs: costWallMs + savingWallMs,
    entries: { costs: costCount, savings: savingCount },
    codes,
    invalid,
  };
}

function mergeMaps(into: Record<string, number>, from: Record<string, number>): void {
  for (const [key, value] of Object.entries(from)) bump(into, key, value);
}

/** 多周期汇总:reports 按传入 cycleIds 顺序;total 合并三个分摊维度。 */
export function summarizeCycles(
  cycleIds: readonly string[] | undefined,
  costs: readonly unknown[] | undefined,
  savings: readonly unknown[] | undefined): { reports: CycleReport[]; total: CycleTotals } {
  const ids = Array.isArray(cycleIds) ? cycleIds : [];
  const reports: CycleReport[] = [];
  const total: CycleTotals = {
    costTokens: 0,
    savingTokens: 0,
    netTokens: 0,
    roi: null,
    wallMs: 0,
    costByStage: emptyStageMap(),
    costByMechanism: {},
    costByProject: {},
  };
  for (const raw of ids) {
    const cycleId = nonEmptyText(raw);
    if (cycleId === undefined) continue;
    const report = cycleReport({ cycleId, costs, savings });
    reports.push(report);
    total.costTokens += report.costTokens;
    total.savingTokens += report.savingTokens;
    total.wallMs += report.wallMs;
    mergeMaps(total.costByStage, report.costByStage);
    mergeMaps(total.costByMechanism, report.costByMechanism);
    mergeMaps(total.costByProject, report.costByProject);
  }
  total.netTokens = total.savingTokens - total.costTokens;
  total.roi = total.costTokens > 0 ? total.savingTokens / total.costTokens : null;
  return { reports, total };
}

/** 策略归一:非法/缺省字段回落缺省值,保证阈值单调(downshiftAfter<=pauseAfter)。 */
function resolvePolicy(policy: Partial<RoiPolicy> | undefined): RoiPolicy {
  const src = isRecord(policy) ? policy : {};
  const pick = (key: keyof RoiPolicy): number => {
    const value = finiteNumber(src[key]);
    return value === undefined ? ROI_POLICY_DEFAULTS[key] : value;
  };
  const downshiftAfter = Math.max(1, pick("downshiftAfter"));
  const pauseAfter = Math.max(downshiftAfter, pick("pauseAfter"));
  const downshiftFactor = pick("downshiftFactor");
  return {
    downshiftAfter,
    pauseAfter,
    downshiftFactor: downshiftFactor > 0 && downshiftFactor <= 1 ? downshiftFactor : ROI_POLICY_DEFAULTS.downshiftFactor,
    minCycleSamples: Math.max(0, pick("minCycleSamples")),
    adoptMinRoi: pick("adoptMinRoi"),
  };
}

function quotaOf(factor: number): RoiQuota {
  return { nightlyWindowFactor: factor, experimentQuotaFactor: factor };
}

/**
 * ROI 门:按传入顺序(旧→新)只数**末尾连续** netTokens<0 的周期;netTokens===0 不算负,转正清零。
 * 样本数(entries.costs+entries.savings)小于 policy.minCycleSamples 的周期在评估时跳过(仍留在报告里)。
 * 达到 pauseAfter → action="pause"(优先),codes 只含 [NEGATIVE_STREAK, PAUSE];否则达到 downshiftAfter → 降频。
 */
export function evaluateRoiGate(
  reports: readonly CycleReport[] | undefined,
  policy?: Partial<RoiPolicy>,
): RoiGateResult {
  const resolved = resolvePolicy(policy);
  const list = Array.isArray(reports) ? reports : [];
  let negativeStreak = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const report = list[i];
    if (!isRecord(report)) continue;
    const entries = isRecord(report.entries) ? report.entries : {};
    const costs = finiteNumber(entries["costs"]) ?? 0;
    const savings = finiteNumber(entries["savings"]) ?? 0;
    if (costs + savings < resolved.minCycleSamples) continue;
    const net = finiteNumber(report.netTokens);
    if (net === undefined || net >= 0) break;
    negativeStreak += 1;
  }

  if (negativeStreak >= resolved.pauseAfter) {
    return {
      action: "pause",
      codes: [RSI_ROI_NEGATIVE_STREAK, RSI_ROI_PAUSE],
      negativeStreak,
      quota: quotaOf(resolved.downshiftFactor),
      detail: `连续 ${negativeStreak} 个周期净亏(阈值:降频 ${resolved.downshiftAfter}、停摆 ${resolved.pauseAfter}),建议暂停夜间改进与实验投放`,
    };
  }
  if (negativeStreak >= resolved.downshiftAfter) {
    return {
      action: "downshift",
      codes: [RSI_ROI_NEGATIVE_STREAK, RSI_ROI_DOWNSHIFT],
      negativeStreak,
      quota: quotaOf(resolved.downshiftFactor),
      detail: `连续 ${negativeStreak} 个周期净亏(降频阈值 ${resolved.downshiftAfter}),建议配额因子降为 ${resolved.downshiftFactor}`,
    };
  }
  return {
    action: "ok",
    codes: [RSI_ROI_OK],
    negativeStreak,
    quota: {},
    detail: `连续净亏 ${negativeStreak} 个周期,未达降频阈值 ${resolved.downshiftAfter},维持当前配额`,
  };
}

/**
 * 采纳门:没有经验证 ROI 直接拒(估算不能当证据);经验证低于 minRoi(缺省 0.1)或估算为负也拒。
 * 缺省 minRoi 取 policy.adoptMinRoi 的缺省值,可被入参覆盖。
 */
export function adoptRoiGate(input: {
  estimateRoi?: number;
  measuredRoi?: number;
  minRoi?: number;
}): AdoptGateResult {
  const src = isRecord(input) ? input : {};
  const measured = finiteNumber(src["measuredRoi"]);
  const minRoi = finiteNumber(src["minRoi"]) ?? ROI_POLICY_DEFAULTS.adoptMinRoi;
  if (measured === undefined) {
    return {
      ok: false,
      codes: [RSI_ROI_ADOPT_NO_MEASURED],
      detail: "缺少实测 ROI(measuredRoi),估算值不能作为采纳证据",
    };
  }
  const estimate = finiteNumber(src["estimateRoi"]);
  if (measured < minRoi) {
    return {
      ok: false,
      codes: [RSI_ROI_ADOPT_BLOCKED],
      detail: `实测 ROI ${measured} 低于采纳门槛 ${minRoi},拒绝采纳`,
    };
  }
  if (estimate !== undefined && estimate < 0) {
    return {
      ok: false,
      codes: [RSI_ROI_ADOPT_BLOCKED],
      detail: `估算 ROI ${estimate} 为负,拒绝采纳`,
    };
  }
  return {
    ok: true,
    codes: [RSI_ROI_OK],
    detail: `实测 ROI ${measured} 达到采纳门槛 ${minRoi},允许采纳`,
  };
}

interface RowAccumulator {
  key: string;
  costTokens: number;
  savingTokens: number;
  costWallMs: number;
  savingWallMs: number;
  usd: number;
  usdSaved: number;
  entries: number;
}

/** 按某个维度分摊(只统计合法条目;缺省键 RSI_UNASSIGNED_KEY)。 */
function allocate(
  costs: readonly unknown[] | undefined,
  savings: readonly unknown[] | undefined,
  dim: "mechanism" | "project",
): AllocationRow[] {
  const acc = new Map<string, RowAccumulator>();
  const pick = (): RowAccumulator => ({
    key: "",
    costTokens: 0,
    savingTokens: 0,
    costWallMs: 0,
    savingWallMs: 0,
    usd: 0,
    usdSaved: 0,
    entries: 0,
  });
  const at = (key: string): RowAccumulator => {
    const found = acc.get(key);
    if (found !== undefined) return found;
    const fresh = pick();
    fresh.key = key;
    acc.set(key, fresh);
    return fresh;
  };

  if (Array.isArray(costs)) {
    for (const raw of costs) {
      const cost = readCost(raw);
      if (cost === undefined) continue;
      const row = at(dim === "mechanism" ? cost.mechanismKey : cost.projectKey);
      row.costTokens += cost.total;
      row.costWallMs += cost.wallMs;
      row.usd += cost.usd;
      row.entries += 1;
    }
  }
  if (Array.isArray(savings)) {
    for (const raw of savings) {
      const saving = readSaving(raw);
      if (saving === undefined) continue;
      const row = at(dim === "mechanism" ? saving.mechanismKey : saving.projectKey);
      row.savingTokens += saving.tokens;
      row.savingWallMs += saving.wallMs;
      row.usdSaved += saving.usd;
      row.entries += 1;
    }
  }

  const rows: AllocationRow[] = [];
  for (const row of acc.values()) {
    rows.push({
      key: row.key,
      costTokens: row.costTokens,
      savingTokens: row.savingTokens,
      netTokens: row.savingTokens - row.costTokens,
      costWallMs: row.costWallMs,
      savingWallMs: row.savingWallMs,
      usd: row.usd,
      usdSaved: row.usdSaved,
      entries: row.entries,
    });
  }
  rows.sort((a, b) => (b.costTokens - a.costTokens) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows;
}

/** 按机制(mechanismId)分摊;costTokens 降序、同值 key 升序。 */
export function allocateByMechanism(
  costs: readonly unknown[] | undefined,
  savings: readonly unknown[] | undefined): AllocationRow[] {
  return allocate(costs, savings, "mechanism");
}

/** 按项目(projectId)分摊;costTokens 降序、同值 key 升序。 */
export function allocateByProject(
  costs: readonly unknown[] | undefined,
  savings: readonly unknown[] | undefined): AllocationRow[] {
  return allocate(costs, savings, "project");
}
