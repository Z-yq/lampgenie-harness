/**
 * Prompt footprint 预算闸 + 负收益剪枝。
 * 两个生产消费端(纯逻辑,CLI/CI 入口见 scripts/prompt-budget-gate.mts):
 * A) CI 增量 token 预算闸:evaluateBudget(总量/分类别超限) + evaluateDelta(相对基线增量 + 字节断言);
 * B) RSI 负收益剪枝:negativeReturnPrunes(#192 实验账本 reject/rollback → footprint 分块可剪项)。
 * 口径(与 prompt-footprint.ts 一致):
 * - chars 逐字 exact;tokensRaw 不乘系数;tokensEstimate 乘 provider 标定 ratio(缺省 1),两列不合成。
 * - 预算 unit 决定判定用哪一列(缺省 "estimate")。
 * - borderline(=limit)算通过;未配置的维度直接跳过,不产生 check/breach。
 * - 本模块永不抛:坏输入返回稳定码;输出不可变(每次返回新对象/新数组);同输入同输出(输出已排序)。
 */
import {
  SECTION_CATEGORIES,
  buildFootprint,
  diffFootprint,
  parseFootprintManifest,
  type FootprintEntry,
  type FootprintInput,
  type FootprintReport,
  type FootprintTotal,
  type SectionCategory,
} from "./prompt-footprint";

/** 预算闸契约版本(改动输出语义时递增)。 */
export const PROMPT_BUDGET_GATE_VERSION = "1.0.0";

/** 稳定码表(CLI 退出码与 CI 断言都认这些字面量)。 */
export const PROMPT_BUDGET_CODES = {
  OK: "OK",
  TOTAL_OVER: "TOTAL_OVER",
  CATEGORY_OVER: "CATEGORY_OVER",
  DELTA_OVER: "DELTA_OVER",
  MANIFEST_INVALID: "MANIFEST_INVALID",
  INVALID: "INVALID",
  NO_BASELINE: "NO_BASELINE",
} as const;

export type PromptBudgetCode = (typeof PROMPT_BUDGET_CODES)[keyof typeof PROMPT_BUDGET_CODES];

/** 判定用哪一列 token。 */
export type TokenUnit = "estimate" | "raw";

/** 单个维度的 token 上限(两列都给出时按 unit 选列,raw 缺省回落 estimate)。 */
export interface TokenLimit {
  estimate: number;
  raw?: number;
}

export interface PromptBudget {
  totalTokens?: TokenLimit;
  categories?: Partial<Record<SectionCategory, TokenLimit>>;
 /** 增量闸默认比例(CLI 未显式给比例时使用)。 */
  deltaRatio?: number;
 /** 判定用哪一列,缺省 "estimate"。 */
  unit?: TokenUnit;
}

export interface BudgetCheck {
  scope: "total" | "category";
  category?: SectionCategory;
  unit: TokenUnit;
  used: number;
  limit: number;
  ok: boolean;
 /** 超出量(未超为 0)。 */
  overBy: number;
}

export interface BudgetBreach {
  code: PromptBudgetCode;
  scope: "total" | "category" | "delta";
  category?: SectionCategory;
  used: number;
  limit: number;
  overBy: number;
  message: string;
}

export interface BudgetEvaluation {
  code: PromptBudgetCode;
  verdict: "ok" | "over" | "invalid";
  unit: TokenUnit;
  report: FootprintReport;
  checks: BudgetCheck[];
  breaches: BudgetBreach[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyReport(): FootprintReport {
  return buildFootprint({});
}

function zeroTotal(): FootprintTotal {
  return { chars: 0, tokensRaw: 0, tokensEstimate: 0 };
}

/** 按 unit 取一条 stat 的 token 值。 */
function tokenOf(stat: { tokensRaw: number; tokensEstimate: number }, unit: TokenUnit): number {
  return unit === "raw" ? stat.tokensRaw : stat.tokensEstimate;
}

type LimitResolution = { kind: "ok"; limit: number } | { kind: "missing" } | { kind: "invalid" };

/** 解析一条上限配置;缺失=跳过,非法=整次判定 INVALID。 */
function resolveLimit(raw: unknown, unit: TokenUnit): LimitResolution {
  if (raw === undefined || raw === null) return { kind: "missing" };
  if (typeof raw === "number") {
 // 容忍直接写数字(等价于 { estimate }),但仍是同一套合法性判定。
    if (!Number.isFinite(raw) || raw < 0) return { kind: "invalid" };
    return { kind: "ok", limit: raw };
  }
  if (!isRecord(raw)) return { kind: "invalid" };
  let value: unknown = unit === "raw" ? raw["raw"] : raw["estimate"];
  if (value === undefined && unit === "raw") value = raw["estimate"];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return { kind: "invalid" };
  return { kind: "ok", limit: value };
}

function invalidBudget(report: FootprintReport, unit: TokenUnit, message: string): BudgetEvaluation {
  return {
    code: PROMPT_BUDGET_CODES.INVALID,
    verdict: "invalid",
    unit,
    report,
    checks: [],
    breaches: [{ code: PROMPT_BUDGET_CODES.INVALID, scope: "total", used: 0, limit: 0, overBy: 0, message }],
  };
}

/**
 * 预算判定:总量 + 分类别。
 * - 任一维度 used > limit → breach(TOTAL_OVER / CATEGORY_OVER);
 * - used === limit 通过;
 * - 未配置的维度跳过;
 * - 输入非法 → MANIFEST_INVALID;预算配置非法(负数/非有限数)→ INVALID。
 */
export function evaluateBudget(
  input: FootprintInput | string | null | undefined,
  budget: PromptBudget | null | undefined): BudgetEvaluation {
  const cfg = isRecord(budget) ? (budget as PromptBudget) : undefined;
  const unit: TokenUnit = cfg?.unit === "raw" ? "raw" : "estimate";

  const parsed = parseFootprintManifest(input as unknown);
  if (!parsed.ok) {
    return {
      code: PROMPT_BUDGET_CODES.MANIFEST_INVALID,
      verdict: "invalid",
      unit,
      report: emptyReport(),
      checks: [],
      breaches: [
        {
          code: PROMPT_BUDGET_CODES.MANIFEST_INVALID,
          scope: "total",
          used: 0,
          limit: 0,
          overBy: 0,
          message: `${parsed.code}: ${parsed.message}`,
        },
      ],
    };
  }
  const report = buildFootprint(parsed.input);

 // 预算形态先校验一遍:任一维度非法即整次 INVALID(不输出半截结论)。
  let invalidMessage: string | undefined;
  if (cfg && cfg.deltaRatio !== undefined) {
    const ratio = cfg.deltaRatio;
    if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0) {
      invalidMessage = "deltaRatio 必须是非负有限数";
    }
  }
  const totalLimit = resolveLimit(cfg?.totalTokens, unit);
  if (totalLimit.kind === "invalid") invalidMessage = invalidMessage ?? "totalTokens 非法(需非负有限数)";
  const categoryLimits: Partial<Record<SectionCategory, unknown>> = isRecord(cfg?.categories)
    ? (cfg?.categories as Partial<Record<SectionCategory, unknown>>)
    : {};
  const categoryResolutions = new Map<SectionCategory, LimitResolution>();
  for (const category of SECTION_CATEGORIES) {
    const resolution = resolveLimit(categoryLimits[category], unit);
    if (resolution.kind === "invalid") invalidMessage = invalidMessage ?? `categories.${category} 非法(需非负有限数)`;
    categoryResolutions.set(category, resolution);
  }
  if (invalidMessage) return invalidBudget(report, unit, invalidMessage);

  const checks: BudgetCheck[] = [];
  const breaches: BudgetBreach[] = [];

  if (totalLimit.kind === "ok") {
    const used = tokenOf(report.total, unit);
    const ok = used <= totalLimit.limit;
    checks.push({ scope: "total", unit, used, limit: totalLimit.limit, ok, overBy: ok ? 0 : used - totalLimit.limit });
    if (!ok) {
      breaches.push({
        code: PROMPT_BUDGET_CODES.TOTAL_OVER,
        scope: "total",
        used,
        limit: totalLimit.limit,
        overBy: used - totalLimit.limit,
        message: `总量 ${used} 超过上限 ${totalLimit.limit}(${unit},超 ${used - totalLimit.limit})`,
      });
    }
  }

  for (const category of SECTION_CATEGORIES) {
    const resolution = categoryResolutions.get(category);
    if (!resolution || resolution.kind !== "ok") continue;
    const used = tokenOf(report.byCategory[category], unit);
    const ok = used <= resolution.limit;
    checks.push({
      scope: "category",
      category,
      unit,
      used,
      limit: resolution.limit,
      ok,
      overBy: ok ? 0 : used - resolution.limit,
    });
    if (!ok) {
      breaches.push({
        code: PROMPT_BUDGET_CODES.CATEGORY_OVER,
        scope: "category",
        category,
        used,
        limit: resolution.limit,
        overBy: used - resolution.limit,
        message: `类别 ${category} 用量 ${used} 超过上限 ${resolution.limit}(${unit},超 ${used - resolution.limit})`,
      });
    }
  }

  return {
    code: breaches.length > 0 ? breaches[0]!.code : PROMPT_BUDGET_CODES.OK,
    verdict: breaches.length > 0 ? "over" : "ok",
    unit,
    report,
    checks,
    breaches,
  };
}

// ---------------------------------------------------------------------------
// 增量闸:相对基线的增长 + changedIds 之外的字节断言
// ---------------------------------------------------------------------------

export interface DeltaOptions {
 /** 允许发生字节变化的分块 id(其余公共分块必须逐字节相等)。 */
  allowChangedIds?: readonly string[];
 /** 总量增长上限(给出时判定)。 */
  maxDeltaTokens?: number;
 /** 总量增长比例上限(相对基线,给出时判定)。 */
  maxDeltaRatio?: number;
  unit?: TokenUnit;
}

export interface DeltaCheck {
  kind: "bytes" | "tokens" | "ratio";
  used: number;
  limit: number;
  ok: boolean;
  overBy: number;
}

export interface CategoryDelta {
  category: SectionCategory;
  before: number;
  after: number;
  delta: number;
}

export interface DeltaEvaluation {
  code: PromptBudgetCode;
  verdict: "ok" | "over" | "invalid" | "no-baseline";
  unit: TokenUnit;
  checks: DeltaCheck[];
  breaches: BudgetBreach[];
  categories: CategoryDelta[];
  changed: string[];
  added: string[];
  removed: string[];
 /** changedIds 之外却改了字节的分块 id(空 = 字节断言通过)。 */
  unrelated: string[];
  baseTotal: FootprintTotal;
  nextTotal: FootprintTotal;
 /** 总量增量(next - base,按 unit)。 */
  totalDelta: number;
}

function emptyDelta(unit: TokenUnit): DeltaEvaluation {
  return {
    code: PROMPT_BUDGET_CODES.OK,
    verdict: "ok",
    unit,
    checks: [],
    breaches: [],
    categories: [],
    changed: [],
    added: [],
    removed: [],
    unrelated: [],
    baseTotal: zeroTotal(),
    nextTotal: zeroTotal(),
    totalDelta: 0,
  };
}

function invalidDelta(unit: TokenUnit, message: string): DeltaEvaluation {
  return {
    ...emptyDelta(unit),
    code: PROMPT_BUDGET_CODES.INVALID,
    verdict: "invalid",
    breaches: [{ code: PROMPT_BUDGET_CODES.INVALID, scope: "delta", used: 0, limit: 0, overBy: 0, message }],
  };
}

/**
 * 增量判定:next 相对 base 的增长是否超限。
 * - 复用 diffFootprint 的字节断言:changedIds 之外改字节 → DELTA_OVER(逐条点名 id);
 * - 增长超 maxDeltaTokens / maxDeltaRatio → DELTA_OVER;缩小永不触发 breach;
 * - 缺基线 → NO_BASELINE;输入坏 → MANIFEST_INVALID;阈值非法 → INVALID。
 */
export function evaluateDelta(
  base: FootprintInput | string | null | undefined,
  next: FootprintInput | string | null | undefined,
  opts: DeltaOptions = {},
): DeltaEvaluation {
  const unit: TokenUnit = opts.unit === "raw" ? "raw" : "estimate";
  const empty = emptyDelta(unit);

  if (base === undefined || base === null) {
    return {
      ...empty,
      code: PROMPT_BUDGET_CODES.NO_BASELINE,
      verdict: "no-baseline",
      breaches: [
        {
          code: PROMPT_BUDGET_CODES.NO_BASELINE,
          scope: "delta",
          used: 0,
          limit: 0,
          overBy: 0,
          message: "缺少基线 manifest,无法判定增量",
        },
      ],
    };
  }

  const baseParsed = parseFootprintManifest(base as unknown);
  if (!baseParsed.ok) {
    return {
      ...empty,
      code: PROMPT_BUDGET_CODES.MANIFEST_INVALID,
      verdict: "invalid",
      breaches: [
        {
          code: PROMPT_BUDGET_CODES.MANIFEST_INVALID,
          scope: "delta",
          used: 0,
          limit: 0,
          overBy: 0,
          message: `baseline: ${baseParsed.code}: ${baseParsed.message}`,
        },
      ],
    };
  }
  const nextParsed = parseFootprintManifest(next as unknown);
  if (!nextParsed.ok) {
    return {
      ...empty,
      code: PROMPT_BUDGET_CODES.MANIFEST_INVALID,
      verdict: "invalid",
      breaches: [
        {
          code: PROMPT_BUDGET_CODES.MANIFEST_INVALID,
          scope: "delta",
          used: 0,
          limit: 0,
          overBy: 0,
          message: `next: ${nextParsed.code}: ${nextParsed.message}`,
        },
      ],
    };
  }

  const maxTokens = opts.maxDeltaTokens;
  const maxRatio = opts.maxDeltaRatio;
  if (maxTokens !== undefined && (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens < 0)) {
    return invalidDelta(unit, "maxDeltaTokens 必须是非负有限数");
  }
  if (maxRatio !== undefined && (typeof maxRatio !== "number" || !Number.isFinite(maxRatio) || maxRatio < 0)) {
    return invalidDelta(unit, "maxDeltaRatio 必须是非负有限数");
  }

  const baseReport = buildFootprint(baseParsed.input);
  const nextReport = buildFootprint(nextParsed.input);
  const baseTokens = tokenOf(baseReport.total, unit);
  const nextTokens = tokenOf(nextReport.total, unit);
  const totalDelta = nextTokens - baseTokens;

  const diff = diffFootprint(baseParsed.input, nextParsed.input, { changedIds: opts.allowChangedIds ?? [] });

  const checks: DeltaCheck[] = [];
  const breaches: BudgetBreach[] = [];
  let unrelated: string[] = [];

  if (!diff.ok) {
    unrelated = [...diff.ids];
    checks.push({ kind: "bytes", used: unrelated.length, limit: 0, ok: false, overBy: unrelated.length });
    breaches.push({
      code: PROMPT_BUDGET_CODES.DELTA_OVER,
      scope: "delta",
      used: unrelated.length,
      limit: 0,
      overBy: unrelated.length,
      message: `changedIds 之外的分块字节被改动: ${unrelated.join(", ")}`,
    });
  } else {
    checks.push({ kind: "bytes", used: 0, limit: 0, ok: true, overBy: 0 });
  }

  if (typeof maxTokens === "number") {
    const ok = totalDelta <= maxTokens;
    checks.push({ kind: "tokens", used: totalDelta, limit: maxTokens, ok, overBy: ok ? 0 : totalDelta - maxTokens });
    if (!ok) {
      breaches.push({
        code: PROMPT_BUDGET_CODES.DELTA_OVER,
        scope: "delta",
        used: totalDelta,
        limit: maxTokens,
        overBy: totalDelta - maxTokens,
        message: `总量增长 ${totalDelta} 超过允许增量 ${maxTokens}(${unit},超 ${totalDelta - maxTokens})`,
      });
    }
  }

  if (typeof maxRatio === "number") {
 // 基线为 0 时:next 有增长视为无穷比例(拦),无增长比例 0(放行)。
    const ratio = baseTokens > 0 ? totalDelta / baseTokens : totalDelta > 0 ? Number.POSITIVE_INFINITY : 0;
    const ok = ratio <= maxRatio;
    checks.push({
      kind: "ratio",
      used: ratio,
      limit: maxRatio,
      ok,
      overBy: ok ? 0 : Number.isFinite(ratio) ? ratio - maxRatio : Number.MAX_SAFE_INTEGER,
    });
    if (!ok) {
      breaches.push({
        code: PROMPT_BUDGET_CODES.DELTA_OVER,
        scope: "delta",
        used: ratio,
        limit: maxRatio,
        overBy: Number.isFinite(ratio) ? ratio - maxRatio : Number.MAX_SAFE_INTEGER,
        message: Number.isFinite(ratio)
          ? `总量增长比例 ${ratio.toFixed(4)} 超过上限 ${maxRatio}`
          : `基线为 0 而 next 有增长,增长比例视为无穷,超过上限 ${maxRatio}`,
      });
    }
  }

  const categories: CategoryDelta[] = SECTION_CATEGORIES.map((category) => {
    const before = tokenOf(baseReport.byCategory[category], unit);
    const after = tokenOf(nextReport.byCategory[category], unit);
    return { category, before, after, delta: after - before };
  });

  return {
    code: breaches.length > 0 ? PROMPT_BUDGET_CODES.DELTA_OVER : PROMPT_BUDGET_CODES.OK,
    verdict: breaches.length > 0 ? "over" : "ok",
    unit,
    checks,
    breaches,
    categories,
    changed: diff.ok ? diff.changed.map((c) => c.id) : [],
    added: diff.ok ? [...diff.added] : [],
    removed: diff.ok ? [...diff.removed] : [],
    unrelated,
    baseTotal: baseReport.total,
    nextTotal: nextReport.total,
    totalDelta,
  };
}

// ---------------------------------------------------------------------------
// RSI 负收益剪枝:reject/rollback 实验 → footprint 分块
// ---------------------------------------------------------------------------

export interface LedgerMetric {
  role?: string;
  unit?: string;
  baseline?: number;
  result?: number;
  success?: { baseline?: number; result?: number; unit?: string };
}

export interface LedgerExperiment {
  experimentId?: string;
  decision?: string;
  intervention?: { surface?: string; ref?: string };
  metrics?: LedgerMetric[];
}

export interface PruneItem {
  surface: string;
  ref: string;
  experimentId: string;
  reason: string;
 /** 命中的 footprint 分块 id(tool → "tool:<name>")。 */
  sections: string[];
  estimatedTokensSaved: number;
 /** 节省量来源:metric=实验 success 指标差值;estimator=该分块当前 tokensEstimate。 */
  savedFrom: "metric" | "estimator";
}

export interface UnattributedItem {
  surface: string;
  ref: string;
  experimentId: string;
  reason: string;
}

export interface NegativeReturnReport {
  code: PromptBudgetCode;
  prunes: PruneItem[];
  unattributed: UnattributedItem[];
}

const PRUNE_SURFACES: ReadonlySet<string> = new Set(["tip", "tool", "prompt", "skill"]);

function isTokenUnit(unit: unknown): boolean {
  if (typeof unit !== "string") return false;
  return /^(tokens?|tokens?[_ -]?estimate|tokens?[_ -]?raw)$/i.test(unit.trim());
}

/** 取一条 metric 的 success 前后值(显式 success 对象优先)。 */
function successOf(metric: LedgerMetric): { baseline: number; result: number; unit?: string } | undefined {
  if (!metric || typeof metric !== "object") return undefined;
  const nested = metric.success;
  if (nested && typeof nested === "object") {
    const b = nested.baseline;
    const r = nested.result;
    if (typeof b === "number" && Number.isFinite(b) && typeof r === "number" && Number.isFinite(r)) {
      return { baseline: b, result: r, unit: nested.unit ?? metric.unit };
    }
  }
  const b = metric.baseline;
  const r = metric.result;
  if (typeof b === "number" && Number.isFinite(b) && typeof r === "number" && Number.isFinite(r)) {
    return { baseline: b, result: r, unit: metric.unit };
  }
  return undefined;
}

/** 从 success 指标里取 token 单位的「baseline - result」;取不到返回 undefined。 */
function metricTokenSaving(metrics: readonly LedgerMetric[] | undefined): number | undefined {
  if (!Array.isArray(metrics)) return undefined;
  for (const metric of metrics) {
    if (!metric || typeof metric !== "object") continue;
    if (metric.role !== "success" && metric.success === undefined) continue;
    const success = successOf(metric);
    if (!success || !isTokenUnit(success.unit)) continue;
    const saving = success.baseline - success.result;
    if (Number.isFinite(saving) && saving > 0) return saving;
  }
  return undefined;
}

function experimentsOf(raw: unknown): LedgerExperiment[] | undefined {
  if (Array.isArray(raw)) return raw as LedgerExperiment[];
  if (isRecord(raw) && Array.isArray(raw["experiments"])) return raw["experiments"] as LedgerExperiment[];
  return undefined;
}

/** 按 surface 把实验 ref 映射到 footprint 分块 id。 */
function matchSections(surface: string, ref: string, input: FootprintInput): string[] {
  const ids: string[] = [];
  if (surface === "tool") {
    for (const tool of input.tools ?? []) {
      if (tool && typeof tool.name === "string" && tool.name === ref) ids.push(`tool:${tool.name}`);
    }
    return ids;
  }
  for (const section of input.sections ?? []) {
    if (!section || typeof section.id !== "string") continue;
    if (section.id === ref || section.id === `${surface}:${ref}` || section.id.endsWith(`:${ref}`)) {
      ids.push(section.id);
    }
  }
  return ids;
}

/**
 * 负收益剪枝:把 #192 实验账本里 reject/rollback 的实验映射到 footprint 分块。
 * - tip/skill/prompt → sections[].id;tool → tools[].name(即 "tool:<name>" 分块);
 * - adopt/iterate 不剪也不进 unattributed(它们不是负收益);
 * - 未匹配/字段缺失/surface 不支持 → unattributed(诚实记账,不猜);
 * - estimatedTokensSaved:token 单位的 success 指标差值优先,否则该分块 tokensEstimate。
 */
export function negativeReturnPrunes(
  experiments: unknown,
  input: FootprintInput | string | null | undefined): NegativeReturnReport {
  const list = experimentsOf(experiments);
  if (!list) {
    return { code: PROMPT_BUDGET_CODES.INVALID, prunes: [], unattributed: [] };
  }
  const parsed = parseFootprintManifest(input as unknown);
  if (!parsed.ok) {
    return { code: PROMPT_BUDGET_CODES.MANIFEST_INVALID, prunes: [], unattributed: [] };
  }
  const report = buildFootprint(parsed.input);
  const entryById = new Map<string, FootprintEntry>(
    report.entries.map((entry): [string, FootprintEntry] => [entry.id, entry]),
  );

  const prunes: PruneItem[] = [];
  const unattributed: UnattributedItem[] = [];

  for (const experiment of list) {
    if (!experiment || typeof experiment !== "object") continue;
    const decision = typeof experiment.decision === "string" ? experiment.decision.trim().toLowerCase() : "";
    if (decision !== "reject" && decision !== "rollback") continue;
    const experimentId = typeof experiment.experimentId === "string" ? experiment.experimentId : "";
    const surfaceRaw = experiment.intervention?.surface;
    const refRaw = experiment.intervention?.ref;
    const surface = typeof surfaceRaw === "string" ? surfaceRaw.trim().toLowerCase() : "";
    const ref = typeof refRaw === "string" ? refRaw.trim() : "";

    if (!PRUNE_SURFACES.has(surface)) {
      unattributed.push({ surface, ref, experimentId, reason: `unsupported-surface: ${surface || "(missing)"}` });
      continue;
    }
    if (ref.length === 0) {
      unattributed.push({ surface, ref, experimentId, reason: "missing-ref" });
      continue;
    }

    const sectionIds = Array.from(new Set(matchSections(surface, ref, parsed.input)));
    if (sectionIds.length === 0) {
      unattributed.push({ surface, ref, experimentId, reason: "no-matching-section" });
      continue;
    }

    const metricSaving = metricTokenSaving(experiment.metrics);
    const estimatorSaving = sectionIds.reduce((sum, id) => sum + (entryById.get(id)?.tokensEstimate ?? 0), 0);
    const estimatedTokensSaved = metricSaving !== undefined ? metricSaving : estimatorSaving;

    prunes.push({
      surface,
      ref,
      experimentId,
      reason: `decision=${decision}; surface=${surface}`,
      sections: sectionIds.sort((a, b) => a.localeCompare(b)),
      estimatedTokensSaved,
      savedFrom: metricSaving !== undefined ? "metric" : "estimator",
    });
  }

  prunes.sort(
    (a, b) =>
      a.experimentId.localeCompare(b.experimentId) || a.surface.localeCompare(b.surface) || a.ref.localeCompare(b.ref),
  );
  unattributed.sort(
    (a, b) =>
      a.experimentId.localeCompare(b.experimentId) || a.surface.localeCompare(b.surface) || a.ref.localeCompare(b.ref),
  );

  return { code: PROMPT_BUDGET_CODES.OK, prunes, unattributed };
}
