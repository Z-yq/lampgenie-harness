/**
 *  指导可度量·结果指标(guidance-outcome),纯函数层。
 * 与 guidance-metrics(计数层)的分工:计数层回答「本任务注入了哪些 tip、落了多少板/验证」;
 * 本模块回答「这些干预有没有让任务变好」——按任务 journal 窗口算四类结果指标,并按
 * 项目/模型/任务类分层,与实验账本(#192 experiment-ledger)做 before/after 对照,产出
 * 可直接并入台账记录的样本。
 * 数据源只有本任务事件(调用方用 `journal.readSession(sessionId, taskStartSeq)` 切片):
 * step.start → steps
 * tool.call(name, arguments) → toolCalls / read_file 去重
 * tool.result(content, error?) → reworkCalls(有 error 或 content 以「错误」开头)
 * llm.trace(usage, error?) → totalTokens / wastedTokens(失败或空 usage 的调用)
 * 纪律:
 * - 全确定性:同输入同输出,零 IO、零随机、零 LLM。
 * - 分母为 0 → 率返回 0(诚实 0,不造「看起来合理」的数);重复探索率分母取 max(1, uniqueReads)。
 * - 不修改入参(内部排序副本),返回冻结对象;任何畸形输入不 throw。
 */

/** journal 事件最小面(测试可直接喂普通对象)。 */
export interface GuidanceOutcomeEvent {
  seq: number;
  kind: string;
  time?: number;
  payload?: unknown;
}

/** 四类结果率的名字(台账指标名与 delta 键共用)。 */
export const OUTCOME_METRIC_NAMES = [
  "avoidableErrorRate",
  "inefficientDecisionRate",
  "repeatedExplorationRate",
  "wasteTokenRate",
] as const;

export type OutcomeMetricName = (typeof OUTCOME_METRIC_NAMES)[number];

/** 四率集合。 */
export interface OutcomeRates {
 /** reworkCalls / toolCalls:本可避免的工具/调用错误占比。 */
  avoidableErrorRate: number;
 /** max(0, steps - baseline) / baseline:超出经验步数的低效决策占比。 */
  inefficientDecisionRate: number;
 /** repeatedReads / max(1, uniqueReads):同 path 重复读占去重后文件数的比例(可 >1,按公式不 clamp)。 */
  repeatedExplorationRate: number;
 /** wastedTokens / max(1, totalTokens):失败或空 usage 调用消耗的 token 占比。 */
  wasteTokenRate: number;
}

/** 单个任务窗口的结果指标。 */
export interface GuidanceOutcome extends OutcomeRates {
  taskClass: string;
  model?: string;
  projectId?: string;
  toolCalls: number;
  steps: number;
  reworkCalls: number;
  repeatedReads: number;
  uniqueReads: number;
  wastedTokens: number;
  totalTokens: number;
 /** 实际使用的步数基线(便于审计:注入值 vs 经验值)。 */
  baselineSteps: number;
}

export interface GuidanceOutcomeOptions {
  taskClass: string;
  model?: string;
  projectId?: string;
 /** 覆盖 taskClass 的经验基线;非有限数或 ≤0 时回落经验值。 */
  baselineSteps?: number;
}

/** 任务类步数经验基线:qa 8 / office 20 / coding 40;未知类按 coding(保守)。 */
export const TASK_CLASS_BASELINE_STEPS: Readonly<Record<"qa" | "office" | "coding", number>> = {
  qa: 8,
  office: 20,
  coding: 40,
};

/** taskClass 的默认步数基线(未知类回落 coding 40)。 */
export function baselineStepsOf(taskClass: string): number {
  if (taskClass === "qa") return TASK_CLASS_BASELINE_STEPS.qa;
  if (taskClass === "office") return TASK_CLASS_BASELINE_STEPS.office;
  return TASK_CLASS_BASELINE_STEPS.coding;
}

function asEvents(events: unknown): GuidanceOutcomeEvent[] {
  return Array.isArray(events) ? (events as GuidanceOutcomeEvent[]) : [];
}

function payloadOf(e: GuidanceOutcomeEvent | null | undefined): Record<string, unknown> {
  const p = e?.payload;
  return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

function finiteOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function rateOf(v: unknown): number {
  return finiteOf(v) ?? 0;
}

function argsOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** path 归一:去空白、反斜杠转斜杠、折叠重复斜杠与前导 `./`、去尾部斜杠。 */
export function normalizeReadPath(raw: string): string {
  const p = String(raw ?? "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
  const trimmed = p.replace(/\/+$/, "");
  return trimmed || p || "";
}

function readPathOf(payload: Record<string, unknown>): string {
  const a = argsOf(payload.arguments);
  const raw = typeof a.path === "string" && a.path.trim()
    ? a.path
    : typeof a.file_path === "string" && a.file_path.trim() ? a.file_path : "";
  return raw ? normalizeReadPath(raw) : "";
}

function resolveBaselineSteps(taskClass: string, injected: unknown): number {
  const v = finiteOf(injected);
  if (v !== undefined && v > 0) return v;
  return baselineStepsOf(taskClass);
}

/**
 * 本任务窗口的结果指标(纯函数)。
 * 空事件/旧 journal → 全 0(率也为 0),baselineSteps 仍给出经验基线,便于对照。
 */
export function computeGuidanceOutcome(
  events: readonly GuidanceOutcomeEvent[] | unknown,
  options?: GuidanceOutcomeOptions): GuidanceOutcome {
  const opts = (options && typeof options === "object" ? options : {}) as Partial<GuidanceOutcomeOptions>;
  const evs = [...asEvents(events)].sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  const taskClass = typeof opts.taskClass === "string" && opts.taskClass ? opts.taskClass : "coding";
  const model = typeof opts.model === "string" && opts.model ? opts.model : undefined;
  const projectId = typeof opts.projectId === "string" && opts.projectId ? opts.projectId : undefined;
  const baselineSteps = resolveBaselineSteps(taskClass, opts.baselineSteps);

  let steps = 0;
  let toolCalls = 0;
  let reworkCalls = 0;
  let totalTokens = 0;
  let wastedTokens = 0;
  const readCounts = new Map<string, number>();

  for (const e of evs) {
    const kind = String(e?.kind ?? "");
    if (kind === "step.start") {
      steps += 1;
      continue;
    }
    if (kind === "tool.result") {
      const p = payloadOf(e);
      const text = typeof p.content === "string" ? p.content.trim() : "";
      if (p.error || text.startsWith("错误")) reworkCalls += 1;
      continue;
    }
    if (kind === "llm.trace") {
      const p = payloadOf(e);
      const usage = p.usage && typeof p.usage === "object" ? (p.usage as Record<string, unknown>) : null;
      const tokens = usage ? finiteOf(usage.totalTokens) : undefined;
      if (tokens !== undefined) totalTokens += tokens;
 // 失败调用或空 usage(拿不到 totalTokens):该调用消耗的 token 计为浪费;缺失不计。
      if (p.error || tokens === undefined) {
        if (tokens !== undefined) wastedTokens += tokens;
      }
      continue;
    }
    if (kind !== "tool.call") continue;
    const p = payloadOf(e);
    toolCalls += 1;
    if (String(p.name ?? "") === "read_file") {
      const path = readPathOf(p);
      if (path) readCounts.set(path, (readCounts.get(path) ?? 0) + 1);
    }
  }

  let repeatedReads = 0;
  for (const n of readCounts.values()) if (n > 1) repeatedReads += n - 1;
  const uniqueReads = readCounts.size;

  const out: GuidanceOutcome = {
    taskClass,
    ...(model !== undefined ? { model } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    toolCalls,
    steps,
    reworkCalls,
    repeatedReads,
    uniqueReads,
    wastedTokens,
    totalTokens,
    baselineSteps,
    avoidableErrorRate: toolCalls > 0 ? reworkCalls / toolCalls : 0,
    inefficientDecisionRate: baselineSteps > 0 ? Math.max(0, steps - baselineSteps) / baselineSteps : 0,
    repeatedExplorationRate: repeatedReads / Math.max(1, uniqueReads),
    wasteTokenRate: wastedTokens / Math.max(1, totalTokens),
  };
  return Object.freeze(out);
}

/** 分层汇总:分层的率是样本率的简单平均(不是加权平均,避免长任务压掉短任务)。 */
export interface OutcomeStratum {
 /** `${projectId ?? "-"}|${model ?? "-"}|${taskClass}`。 */
  key: string;
  projectId?: string;
  model?: string;
  taskClass: string;
  samples: number;
  avg: OutcomeRates;
  sums: {
    toolCalls: number;
    steps: number;
    reworkCalls: number;
    repeatedReads: number;
    uniqueReads: number;
    wastedTokens: number;
    totalTokens: number;
  };
}

/** 按 项目/模型/任务类 分层:key 缺项目/模型用 "-" 占位,同 key 的样本聚合到一条。 */
export function stratifyOutcomes(items: readonly GuidanceOutcome[] | unknown): Map<string, OutcomeStratum> {
  const list = Array.isArray(items) ? (items as GuidanceOutcome[]) : [];
  const groups = new Map<string, { meta: { projectId?: string; model?: string; taskClass: string }; samples: number; rates: OutcomeRates; sums: OutcomeStratum["sums"] }>();
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const projectId = typeof it.projectId === "string" && it.projectId ? it.projectId : undefined;
    const model = typeof it.model === "string" && it.model ? it.model : undefined;
    const taskClass = typeof it.taskClass === "string" && it.taskClass ? it.taskClass : "-";
    const key = `${projectId ?? "-"}|${model ?? "-"}|${taskClass}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        meta: { ...(projectId !== undefined ? { projectId } : {}), ...(model !== undefined ? { model } : {}), taskClass },
        samples: 0,
        rates: { avoidableErrorRate: 0, inefficientDecisionRate: 0, repeatedExplorationRate: 0, wasteTokenRate: 0 },
        sums: { toolCalls: 0, steps: 0, reworkCalls: 0, repeatedReads: 0, uniqueReads: 0, wastedTokens: 0, totalTokens: 0 },
      };
      groups.set(key, g);
    }
    g.samples += 1;
    g.rates.avoidableErrorRate += rateOf(it.avoidableErrorRate);
    g.rates.inefficientDecisionRate += rateOf(it.inefficientDecisionRate);
    g.rates.repeatedExplorationRate += rateOf(it.repeatedExplorationRate);
    g.rates.wasteTokenRate += rateOf(it.wasteTokenRate);
    g.sums.toolCalls += rateOf(it.toolCalls);
    g.sums.steps += rateOf(it.steps);
    g.sums.reworkCalls += rateOf(it.reworkCalls);
    g.sums.repeatedReads += rateOf(it.repeatedReads);
    g.sums.uniqueReads += rateOf(it.uniqueReads);
    g.sums.wastedTokens += rateOf(it.wastedTokens);
    g.sums.totalTokens += rateOf(it.totalTokens);
  }

  const result = new Map<string, OutcomeStratum>();
  for (const [key, g] of groups) {
    const n = g.samples || 1;
    result.set(key, Object.freeze({
      key,
      ...g.meta,
      samples: g.samples,
      avg: Object.freeze({
        avoidableErrorRate: g.rates.avoidableErrorRate / n,
        inefficientDecisionRate: g.rates.inefficientDecisionRate / n,
        repeatedExplorationRate: g.rates.repeatedExplorationRate / n,
        wasteTokenRate: g.rates.wasteTokenRate / n,
      }),
      sums: Object.freeze({ ...g.sums }),
    }));
  }
  return result;
}

/** 前后对照的方向判定阈值:任一率的 |delta| 小于它视为「平坦」。 */
export const OUTCOME_FLAT_EPSILON = 0.01;

export interface OutcomeCompare {
 /** after - before;四个率各一条(率降=改善)。 */
  delta: Record<OutcomeMetricName, number>;
 /** better=降、worse=升、flat=全部 |delta|<0.01。 */
  direction: "better" | "worse" | "flat";
  sample: { before: number; after: number };
 /** 任一侧样本 <3(方向仍算,但证据不足)。 */
  sampleLow: boolean;
 /** 用于判方向的指标(缺省 avoidableErrorRate;它平坦时按固定顺序找第一个非平坦率)。 */
  primary: OutcomeMetricName;
  before: OutcomeRates;
  after: OutcomeRates;
}

function toOutcomeList(x: readonly GuidanceOutcome[] | GuidanceOutcome | null | undefined): GuidanceOutcome[] {
  if (!x) return [];
  if (Array.isArray(x)) return x.filter((v): v is GuidanceOutcome => !!v && typeof v === "object");
  return typeof x === "object" ? [x as GuidanceOutcome] : [];
}

function avgRates(list: GuidanceOutcome[]): OutcomeRates {
  const n = list.length;
  const sums: OutcomeRates = { avoidableErrorRate: 0, inefficientDecisionRate: 0, repeatedExplorationRate: 0, wasteTokenRate: 0 };
  if (!n) return sums;
  for (const it of list) {
    sums.avoidableErrorRate += rateOf(it.avoidableErrorRate);
    sums.inefficientDecisionRate += rateOf(it.inefficientDecisionRate);
    sums.repeatedExplorationRate += rateOf(it.repeatedExplorationRate);
    sums.wasteTokenRate += rateOf(it.wasteTokenRate);
  }
  return {
    avoidableErrorRate: sums.avoidableErrorRate / n,
    inefficientDecisionRate: sums.inefficientDecisionRate / n,
    repeatedExplorationRate: sums.repeatedExplorationRate / n,
    wasteTokenRate: sums.wasteTokenRate / n,
  };
}

/**
 * before/after 对照(单样本或样本数组都接受;数组取各率均值)。
 * 方向判定:先看 primary 指标(缺省 avoidableErrorRate);它平坦则按固定顺序找第一个非平坦率;
 * 全部 |delta|<0.01 → flat。率降=better、升=worse。
 */
export function compareOutcomes(
  before: readonly GuidanceOutcome[] | GuidanceOutcome | null | undefined,
  after: readonly GuidanceOutcome[] | GuidanceOutcome | null | undefined,
  primaryMetric?: OutcomeMetricName): OutcomeCompare {
  const b = toOutcomeList(before);
  const a = toOutcomeList(after);
  const beforeRates = avgRates(b);
  const afterRates = avgRates(a);
  const delta = {
    avoidableErrorRate: afterRates.avoidableErrorRate - beforeRates.avoidableErrorRate,
    inefficientDecisionRate: afterRates.inefficientDecisionRate - beforeRates.inefficientDecisionRate,
    repeatedExplorationRate: afterRates.repeatedExplorationRate - beforeRates.repeatedExplorationRate,
    wasteTokenRate: afterRates.wasteTokenRate - beforeRates.wasteTokenRate,
  } as Record<OutcomeMetricName, number>;

  const order: OutcomeMetricName[] = primaryMetric && OUTCOME_METRIC_NAMES.includes(primaryMetric)
    ? [primaryMetric, ...OUTCOME_METRIC_NAMES.filter((n) => n !== primaryMetric)]
    : [...OUTCOME_METRIC_NAMES];
  let primary: OutcomeMetricName = order[0] ?? "avoidableErrorRate";
  let decisive: number = delta[primary];
  for (const name of order) {
    if (Math.abs(delta[name]) >= OUTCOME_FLAT_EPSILON) {
      primary = name;
      decisive = delta[name];
      break;
    }
  }
  const direction: OutcomeCompare["direction"] = Math.abs(decisive) < OUTCOME_FLAT_EPSILON
    ? "flat"
    : decisive < 0 ? "better" : "worse";

  return Object.freeze({
    delta: Object.freeze(delta),
    direction,
    sample: Object.freeze({ before: b.length, after: a.length }),
    sampleLow: b.length < 3 || a.length < 3,
    primary,
    before: Object.freeze(beforeRates),
    after: Object.freeze(afterRates),
  });
}

export interface ExperimentSampleOptions {
 /** 干预标识(与实验账本的 intervention.ref 对齐,如 "tip:parallel")。 */
  intervention: string;
 /** 干预具体对象(如 "dyn:verify-stop")。 */
  ref: string;
 /** 取哪个率作为指标值;缺省 avoidableErrorRate。 */
  metric?: OutcomeMetricName;
 /** 基线值(与实验账本 baseline.value 对齐;不给则 metric.baseline 缺省)。 */
  baseline?: number;
}

/** 可直接并入实验账本记录的一条样本(不改账本 schema,只对齐字段形状)。 */
export interface GuidanceExperimentSample {
  metric: { name: string; value: number; baseline?: number };
  stratum: { project: string; model: string; taskClass: string };
  note: string;
}

/** 把一条结果指标折叠成实验账本样本(确定性;缺字段用 "-" 占位)。 */
export function toExperimentSample(
  outcome: GuidanceOutcome | null | undefined,
  options?: ExperimentSampleOptions): GuidanceExperimentSample {
  const o = (outcome && typeof outcome === "object" ? outcome : {}) as Partial<GuidanceOutcome>;
  const opts = (options && typeof options === "object" ? options : {}) as Partial<ExperimentSampleOptions>;
  const metric: OutcomeMetricName = opts.metric && OUTCOME_METRIC_NAMES.includes(opts.metric)
    ? opts.metric
    : "avoidableErrorRate";
  const value = rateOf((o as Record<string, unknown>)[metric]);
  const baseline = finiteOf(opts.baseline);
  const stratum = {
    project: typeof o.projectId === "string" && o.projectId ? o.projectId : "-",
    model: typeof o.model === "string" && o.model ? o.model : "-",
    taskClass: typeof o.taskClass === "string" && o.taskClass ? o.taskClass : "-",
  };
  const note = `${String(opts.intervention ?? "")}@${String(opts.ref ?? "")} · 指标 ${metric} · 分层 ${stratum.project}/${stratum.model}/${stratum.taskClass} · 样本 1`;
  return Object.freeze({
    metric: Object.freeze({ name: metric, value, ...(baseline !== undefined ? { baseline } : {}) }),
    stratum: Object.freeze(stratum),
    note,
  });
}
