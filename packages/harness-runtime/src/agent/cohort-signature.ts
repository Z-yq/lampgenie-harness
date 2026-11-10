/**
 * 情境签名与反事实比较:纯逻辑、零 IO。
 * 为什么:一个指标只有在「情境可比」时才能相减。同一条指标(平均回合数、一次通过率)
 * 在不同任务类、不同模型/供应商版本下不能直接对比,否则版本漂移、任务难度变化会被
 * 误读成「优化生效」。本模块把「情境」定义成六维签名(taskClass / phase / toolSurface /
 * contextPressure / modelVersion / providerVersion),并在此之上给出:
 * - 签名键与匹配(signatureKey / matchSignature):缺省六维全等;近似模式只放宽非版本维,
 *   版本维不同永远判不可比(版本不同的两组本来就不是同一把尺子);
 * - 分桶与反事实配对(buildBuckets / counterfactualPairs):同桶、同指标、两个决策臂才配对,
 *   跨桶永不配对;不足 minPerArm 的一律进 candidates 而不是硬算差值;
 * - 两臂评估(evaluateComparison):comparable / not-matched / insufficient 三态,
 *   并把「臂里混了失败样本」显式记码,避免只拿成功样本比出好看的差值;
 * - 版本治理(stratifyByVersion / detectVersionChange / markStale):版本一变基线须重估,
 *   旧实验标过期,而不是继续当证据;
 * - 混杂与幸存者偏差(confounders / survivorBias):把「这批样本算不上证据」的原因说出来。
 * 纪律:不抛异常(非法样本计数跳过、缺字段给占位)、不做 IO、不依赖其它模块;
 * 均值与差值四舍五入到 2 位,保证同输入同输出。
 */

/** 数据契约版本(落盘行与本模块共用)。 */
export const SIGNATURE_VERSION = 1;

/** 稳定码:调用方按码分流,不解析文案。 */
export const CONF_CODES = [
  "CONF_INVALID",
  "CONF_MATCHED",
  "CONF_NOT_MATCHED",
  "CONF_INSUFFICIENT_SAMPLES",
  "CONF_VERSION_STALE",
  "CONF_BASELINE_RESTIMATED",
  "CONF_CONFOUNDERS_PRESENT",
  "CONF_INCLUDES_FAILURES",
  "CONF_SURVIVOR_BIAS",
] as const;

export type ConfCode = (typeof CONF_CODES)[number];

/** 情境维度(顺序即 signatureKey 的固定输出顺序)。 */
export const SIGNATURE_DIMENSIONS = [
  "taskClass",
  "phase",
  "toolSurface",
  "contextPressure",
  "modelVersion",
  "providerVersion",
] as const;

export type SignatureDimension = (typeof SIGNATURE_DIMENSIONS)[number];

/** 上下文压力档位(粗粒度即可:它的作用是分层,不是精确测量)。 */
export const CONTEXT_PRESSURES = ["low", "medium", "high"] as const;

export type ContextPressure = (typeof CONTEXT_PRESSURES)[number];

/** 样本状态:只有 done 是成功样本,failed/interrupted/cancelled 都必须参与统计但被记码。 */
export const SAMPLE_STATUSES = ["done", "failed", "interrupted", "cancelled"] as const;

export type SampleStatus = (typeof SAMPLE_STATUSES)[number];

/** 情境签名:同一把尺子 = 六个维度都相同。 */
export interface SituationSignature {
  taskClass: string;
  phase: string;
  toolSurface: string;
  contextPressure: ContextPressure;
  modelVersion: string;
  providerVersion: string;
}

/** 一条样本带一个指标取值(一次运行只看一个主指标,配对时按 metric 再分组)。 */
export interface SampleOutcome {
  metric: string;
  value: number;
}

/** 一条观测样本。 */
export interface SignatureSample {
  id: string;
  signature: SituationSignature;
  status: SampleStatus;
  outcome: SampleOutcome;
  /** 该样本所属决策臂(如 "before" / "after");缺省不参与反事实配对。 */
  decision?: string;
  projectId?: string;
  durationMs?: number;
  at: number;
}

export interface MatchOptions {
  strict?: boolean;
  requireExact?: readonly SignatureDimension[];
}

export interface MatchResult {
  matched: boolean;
  diffs: string[];
}

export interface BucketCounts {
  done: number;
  failed: number;
  interrupted: number;
  cancelled: number;
}

export interface SignatureBucket {
  signature: SituationSignature;
  samples: SignatureSample[];
  counts: BucketCounts;
}

export interface CounterfactualPair {
  signatureKey: string;
  metric: string;
  decisionA: string;
  decisionB: string;
  meanA: number;
  meanB: number;
  delta: number;
  sampleA: number;
  sampleB: number;
  codes: ConfCode[];
}

export interface CounterfactualCandidate {
  signatureKey: string;
  decisionA: string;
  decisionB: string;
  codes: ConfCode[];
  reason: string;
}

export interface CounterfactualResult {
  pairs: CounterfactualPair[];
  candidates: CounterfactualCandidate[];
  codes: ConfCode[];
}

export interface CompareOptions {
  strict?: boolean;
  minPerArm?: number;
  metricTolerance?: number;
}

export interface ComparisonDelta {
  metric: string;
  a: number;
  b: number;
  delta: number;
  withinTolerance: boolean;
}

export interface ComparisonResult {
  verdict: "comparable" | "not-matched" | "insufficient";
  codes: ConfCode[];
  deltas: ComparisonDelta[];
  includesFailures: { a: number; b: number };
}

export interface VersionStratum {
  providerVersions: string[];
  metrics: { mean: number; count: number; byStatus: Record<SampleStatus, number> };
}

export interface VersionPair {
  modelVersion: string;
  providerVersion: string;
}

export interface SignatureExperiment {
  id: string;
  signature: SituationSignature;
}

export interface VersionChangeInput {
  prev: VersionPair;
  next: VersionPair;
  experiments?: readonly SignatureExperiment[];
}

export interface VersionChangeResult {
  changed: boolean;
  staleExperimentIds: string[];
  codes: ConfCode[];
}

export interface MarkStaleResult {
  stale: string[];
  active: string[];
}

export type ConfounderFactor = "version" | "project" | "taskClass" | "duration";

export interface ConfounderItem {
  factor: ConfounderFactor;
  detail: string;
  present: boolean;
}

export interface ConfounderResult {
  items: ConfounderItem[];
  codes: ConfCode[];
}

export interface SurvivorBiasResult {
  biased: boolean;
  excludedCount: number;
  codes: ConfCode[];
}

export interface SampleSetAudit {
  usable: boolean;
  accepted: number;
  invalid: number;
  codes: ConfCode[];
}

/** 近似模式默认仍须逐字相等的维度:版本维不同就不是同一把尺子。 */
const DEFAULT_REQUIRE_EXACT: readonly SignatureDimension[] = ["modelVersion", "providerVersion"];

const DEFAULT_MIN_PER_ARM = 3;

/** 缺维占位:既不丢样本,也不假装知道。 */
const MISSING = "?";

const UNKNOWN_MODEL = "unknown";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 宽松读对象:非对象给空记录(只读不写,避免脏输入把函数打断)。 */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const got = finite(value);
  return got !== undefined && got >= 0 ? got : undefined;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function dimPart(value: unknown): string {
  return text(value) ?? MISSING;
}

function contextPressureOf(value: unknown): ContextPressure {
  const got = text(value);
  return got !== undefined && (CONTEXT_PRESSURES as readonly string[]).includes(got)
    ? (got as ContextPressure)
    : "medium";
}

function statusOf(value: unknown): SampleStatus | undefined {
  const got = text(value);
  return got !== undefined && (SAMPLE_STATUSES as readonly string[]).includes(got)
    ? (got as SampleStatus)
    : undefined;
}

/** 任何入参当列表读:非数组给空列表(脏输入不抛)。 */
function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

/** 按 CONF_CODES 的固定顺序去重;空集合原样给空(本模块没有 OK 码)。 */
function normalizeCodes(codes: Iterable<ConfCode>): ConfCode[] {
  const set = new Set<ConfCode>(codes);
  return CONF_CODES.filter((code) => set.has(code));
}

function emptyCounts(): BucketCounts {
  return { done: 0, failed: 0, interrupted: 0, cancelled: 0 };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return round2(sum / values.length);
}

function isDone(sample: SignatureSample): boolean {
  return sample.status === "done";
}

function nonDoneCount(samples: readonly SignatureSample[]): number {
  let count = 0;
  for (const sample of samples) if (!isDone(sample)) count += 1;
  return count;
}

function coerceSamples(value: unknown): { samples: SignatureSample[]; invalid: number } {
  const samples: SignatureSample[] = [];
  let invalid = 0;
  for (const raw of listOf(value)) {
    const sample = coerceSample(raw);
    if (sample === undefined) invalid += 1;
    else samples.push(sample);
  }
  return { samples, invalid };
}

/** 按 metric 分臂:同一决策臂里不同指标不能混在一起求均值。 */
function groupByMetric(samples: readonly SignatureSample[]): Map<string, SignatureSample[]> {
  const groups = new Map<string, SignatureSample[]>();
  for (const sample of samples) {
    const list = groups.get(sample.outcome.metric);
    if (list === undefined) groups.set(sample.outcome.metric, [sample]);
    else list.push(sample);
  }
  return groups;
}

function valuesOf(samples: readonly SignatureSample[]): number[] {
  return samples.map((sample) => sample.outcome.value);
}

/**
 * 签名键:固定顺序 tc=|ph=|ts=|cp=|mv=|pv=,值 trim。
 * 缺失或非字符串的维度用 "?" 占位——键必须永远可算,否则无法分桶统计脏数据。
 */
export function signatureKey(sig: SituationSignature): string {
  const raw = asRecord(sig);
  return [
    `tc=${dimPart(raw["taskClass"])}`,
    `ph=${dimPart(raw["phase"])}`,
    `ts=${dimPart(raw["toolSurface"])}`,
    `cp=${dimPart(raw["contextPressure"])}`,
    `mv=${dimPart(raw["modelVersion"])}`,
    `pv=${dimPart(raw["providerVersion"])}`,
  ].join("|");
}

/**
 * 宽松读一个签名:缺维用 "?" 占位;contextPressure 非法回退 "medium"
 * (压力档是分层用的粗标签,写错不该让整条样本消失,但也不能凭空多出一个档位)。
 * 五维全缺 = 零信息签名 → 判非法,否则空签名会把不同情境合并成同一个桶。
 */
export function coerceSignature(v: unknown): SituationSignature | undefined {
  if (!isRecord(v)) return undefined;
  const sig: SituationSignature = {
    taskClass: dimPart(v["taskClass"]),
    phase: dimPart(v["phase"]),
    toolSurface: dimPart(v["toolSurface"]),
    contextPressure: contextPressureOf(v["contextPressure"]),
    modelVersion: dimPart(v["modelVersion"]),
    providerVersion: dimPart(v["providerVersion"]),
  };
  const informative = [
    sig.taskClass,
    sig.phase,
    sig.toolSurface,
    sig.modelVersion,
    sig.providerVersion,
  ].some((part) => part !== MISSING);
  return informative ? sig : undefined;
}

/** 宽松读一条样本:必填 id / status / 签名 / metric / value / at,其余可选。 */
export function coerceSample(v: unknown): SignatureSample | undefined {
  if (!isRecord(v)) return undefined;
  const id = text(v["id"]);
  const status = statusOf(v["status"]);
  const signature = coerceSignature(v["signature"]);
  const outcomeRaw = v["outcome"];
  const metric = isRecord(outcomeRaw) ? text(outcomeRaw["metric"]) : undefined;
  const value = isRecord(outcomeRaw) ? finite(outcomeRaw["value"]) : undefined;
  const at = finite(v["at"]);
  if (
    id === undefined ||
    status === undefined ||
    signature === undefined ||
    metric === undefined ||
    value === undefined ||
    at === undefined
  ) {
    return undefined;
  }
  const sample: SignatureSample = { id, signature, status, outcome: { metric, value }, at };
  const decision = text(v["decision"]);
  if (decision !== undefined) sample.decision = decision;
  const projectId = text(v["projectId"]);
  if (projectId !== undefined) sample.projectId = projectId;
  const durationMs = nonNegative(v["durationMs"]);
  if (durationMs !== undefined) sample.durationMs = durationMs;
  return sample;
}

/**
 * 两签名是否同一情境。
 * - 缺省(strict !== false):六维全等才算 matched,diffs 逐维记 "<dim>:<a>≠<b>";
 * - strict === false:requireExact(缺省 modelVersion+providerVersion)里任一维不等 → matched=false;
 *   其余维不等只进 diffs,matched 仍为 true(近似模式承认次要维度可以漂移)。
 */
export function matchSignature(
  a: SituationSignature,
  b: SituationSignature,
  opts: MatchOptions = {},
): MatchResult {
  const left = asRecord(a);
  const right = asRecord(b);
  const diffs: string[] = [];
  for (const dim of SIGNATURE_DIMENSIONS) {
    const aPart = dimPart(left[dim]);
    const bPart = dimPart(right[dim]);
    if (aPart !== bPart) diffs.push(`${dim}:${aPart}≠${bPart}`);
  }
  if (opts.strict !== false) return { matched: diffs.length === 0, diffs };
  const requireExact = opts.requireExact ?? DEFAULT_REQUIRE_EXACT;
  const blocking = new Set(diffs.map((diff) => diff.slice(0, diff.indexOf(":"))));
  const matched = !requireExact.some((dim) => blocking.has(dim));
  return { matched, diffs };
}

/** 按签名分桶;非法样本跳过,桶内按状态计数(failed 等不剔除)。 */
export function buildBuckets(samples: readonly SignatureSample[]): Record<string, SignatureBucket> {
  const buckets: Record<string, SignatureBucket> = {};
  for (const raw of listOf(samples)) {
    const sample = coerceSample(raw);
    if (sample === undefined) continue;
    const key = signatureKey(sample.signature);
    let bucket = buckets[key];
    if (bucket === undefined) {
      bucket = { signature: sample.signature, samples: [], counts: emptyCounts() };
      buckets[key] = bucket;
    }
    bucket.samples.push(sample);
    bucket.counts[sample.status] += 1;
  }
  return buckets;
}

/**
 * 反事实配对:同签名桶内按 decision 分臂,同桶同指标两两组合。
 * 跨桶永不配对(不同情境的差不是决策效果);任一组 < minPerArm → candidates + CONF_INSUFFICIENT_SAMPLES;
 * 非 done 样本照常进均值(剔除它们就是幸存者偏差本身),但该对记 CONF_INCLUDES_FAILURES。
 */
export function counterfactualPairs(
  samples: readonly SignatureSample[],
  opts: { minPerArm?: number } = {},
): CounterfactualResult {
  const minPerArm = Math.max(1, Math.floor(finite(opts.minPerArm) ?? DEFAULT_MIN_PER_ARM));
  const buckets = buildBuckets(samples);
  const pairs: CounterfactualPair[] = [];
  const candidates: CounterfactualCandidate[] = [];

  for (const key of Object.keys(buckets).sort()) {
    const bucket = buckets[key];
    if (bucket === undefined) continue;
    const byDecision = new Map<string, SignatureSample[]>();
    for (const sample of bucket.samples) {
      const decision = sample.decision;
      if (decision === undefined) continue;
      const arm = byDecision.get(decision);
      if (arm === undefined) byDecision.set(decision, [sample]);
      else arm.push(sample);
    }
    const decisions = Array.from(byDecision.keys()).sort();
    for (let i = 0; i < decisions.length; i += 1) {
      for (let j = i + 1; j < decisions.length; j += 1) {
        const decisionA = decisions[i]!;
        const decisionB = decisions[j]!;
        const armA = groupByMetric(byDecision.get(decisionA)!);
        const armB = groupByMetric(byDecision.get(decisionB)!);
        const metrics = Array.from(new Set([...armA.keys(), ...armB.keys()])).sort();
        const shortfalls: string[] = [];
        for (const metric of metrics) {
          const samplesA = armA.get(metric) ?? [];
          const samplesB = armB.get(metric) ?? [];
          if (samplesA.length < minPerArm || samplesB.length < minPerArm) {
            shortfalls.push(`${metric}(A=${samplesA.length},B=${samplesB.length})`);
            continue;
          }
          const meanA = mean(valuesOf(samplesA));
          const meanB = mean(valuesOf(samplesB));
          const codes: ConfCode[] = [];
          if (nonDoneCount(samplesA) > 0 || nonDoneCount(samplesB) > 0) {
            codes.push("CONF_INCLUDES_FAILURES");
          }
          pairs.push({
            signatureKey: key,
            metric,
            decisionA,
            decisionB,
            meanA,
            meanB,
            delta: round2(meanB - meanA),
            sampleA: samplesA.length,
            sampleB: samplesB.length,
            codes,
          });
        }
        if (shortfalls.length > 0) {
          candidates.push({
            signatureKey: key,
            decisionA,
            decisionB,
            codes: ["CONF_INSUFFICIENT_SAMPLES"],
            reason: `每组样本不足 minPerArm=${minPerArm}: ${shortfalls.join(", ")}`,
          });
        }
      }
    }
  }

  const codes: ConfCode[] = [];
  for (const pair of pairs) codes.push(...pair.codes);
  for (const candidate of candidates) codes.push(...candidate.codes);
  if (pairs.length > 0) codes.push("CONF_MATCHED");
  return { pairs, candidates, codes: normalizeCodes(codes.length > 0 ? codes : ["CONF_INVALID"]) };
}

/**
 * 两臂评估:签名可比 + 样本够 → comparable,否则 not-matched / insufficient。
 * 任一侧含非 done → 两侧都记 CONF_INCLUDES_FAILURES 并给计数(差值里混了失败样本,
 * 调用方必须知道);deltas 只对两侧都出现过的指标给,避免拿一侧缺失当 0 比。
 */
export function evaluateComparison(
  a: readonly SignatureSample[],
  b: readonly SignatureSample[],
  opts: CompareOptions = {},
): ComparisonResult {
  const minPerArm = Math.max(1, Math.floor(finite(opts.minPerArm) ?? DEFAULT_MIN_PER_ARM));
  const tolerance = Math.abs(finite(opts.metricTolerance) ?? 0);
  const left = coerceSamples(a).samples;
  const right = coerceSamples(b).samples;
  const includesFailures = { a: nonDoneCount(left), b: nonDoneCount(right) };
  const baseCodes: ConfCode[] = [];
  if (includesFailures.a > 0 || includesFailures.b > 0) baseCodes.push("CONF_INCLUDES_FAILURES");

  const deltas: ComparisonDelta[] = [];
  const armA = groupByMetric(left);
  const armB = groupByMetric(right);
  for (const metric of Array.from(armA.keys()).sort()) {
    const samplesA = armA.get(metric) ?? [];
    const samplesB = armB.get(metric);
    if (samplesB === undefined || samplesA.length === 0 || samplesB.length === 0) continue;
    const meanA = mean(valuesOf(samplesA));
    const meanB = mean(valuesOf(samplesB));
    const delta = round2(meanB - meanA);
    deltas.push({ metric, a: meanA, b: meanB, delta, withinTolerance: Math.abs(delta) <= tolerance });
  }

  const sigA = left[0]?.signature;
  const sigB = right[0]?.signature;
  // 任一侧没有可用样本 → 拿不到签名,等同样本不足(而不是默默判"可比")。
  if (sigA === undefined || sigB === undefined) {
    return {
      verdict: "insufficient",
      codes: normalizeCodes([...baseCodes, "CONF_INSUFFICIENT_SAMPLES"]),
      deltas,
      includesFailures,
    };
  }
  const match = matchSignature(sigA, sigB, { strict: opts.strict });
  if (!match.matched) {
    return {
      verdict: "not-matched",
      codes: normalizeCodes([...baseCodes, "CONF_NOT_MATCHED"]),
      deltas,
      includesFailures,
    };
  }
  if (left.length < minPerArm || right.length < minPerArm) {
    return {
      verdict: "insufficient",
      codes: normalizeCodes([...baseCodes, "CONF_INSUFFICIENT_SAMPLES"]),
      deltas,
      includesFailures,
    };
  }
  return {
    verdict: "comparable",
    codes: normalizeCodes([...baseCodes, "CONF_MATCHED"]),
    deltas,
    includesFailures,
  };
}

/** 按 modelVersion 分层(缺版本 → "unknown"),给出各层的供应商版本集合与指标均值。 */
export function stratifyByVersion(samples: readonly SignatureSample[]): Record<string, VersionStratum> {
  const strata: Record<string, VersionStratum> = {};
  const providers = new Map<string, Set<string>>();
  for (const raw of listOf(samples)) {
    const sample = coerceSample(raw);
    if (sample === undefined) continue;
    const model = sample.signature.modelVersion === MISSING ? UNKNOWN_MODEL : sample.signature.modelVersion;
    let stratum = strata[model];
    if (stratum === undefined) {
      stratum = {
        providerVersions: [],
        metrics: { mean: 0, count: 0, byStatus: { done: 0, failed: 0, interrupted: 0, cancelled: 0 } },
      };
      strata[model] = stratum;
      providers.set(model, new Set<string>());
    }
    providers.get(model)!.add(sample.signature.providerVersion);
    const metrics = stratum.metrics;
    const previous = metrics.mean * metrics.count;
    metrics.count += 1;
    metrics.mean = round2((previous + sample.outcome.value) / metrics.count);
    metrics.byStatus[sample.status] += 1;
  }
  for (const [model, stratum] of Object.entries(strata)) {
    const set = providers.get(model);
    stratum.providerVersions = set === undefined ? [] : Array.from(set).sort();
  }
  return strata;
}

function versionPairOf(value: unknown): VersionPair {
  const raw = isRecord(value) ? value : {};
  return { modelVersion: dimPart(raw["modelVersion"]), providerVersion: dimPart(raw["providerVersion"]) };
}

/** 一条实验的签名是否仍与目标版本一致(签名缺失 → 无法核验 → 视为过期)。 */
function signatureStale(signature: unknown, target: VersionPair): boolean {
  const sig = coerceSignature(signature);
  if (sig === undefined) return true;
  return sig.modelVersion !== target.modelVersion || sig.providerVersion !== target.providerVersion;
}

/**
 * 版本是否变了:变了则基线须重估(CONF_BASELINE_RESTIMATED),
 * 签名版本与 next 不一致的实验 id 全部标 stale(无法核验的也算 stale)。
 */
export function detectVersionChange(input: VersionChangeInput): VersionChangeResult {
  const raw = asRecord(input);
  const prev = versionPairOf(raw["prev"]);
  const next = versionPairOf(raw["next"]);
  const changed = prev.modelVersion !== next.modelVersion || prev.providerVersion !== next.providerVersion;
  const staleExperimentIds: string[] = [];
  const seen = new Set<string>();
  for (const item of listOf(raw["experiments"])) {
    if (!isRecord(item)) continue;
    const id = text(item["id"]);
    if (id === undefined || seen.has(id)) continue;
    if (!signatureStale(item["signature"], next)) continue;
    seen.add(id);
    staleExperimentIds.push(id);
  }
  const codes: ConfCode[] = [];
  if (changed) codes.push("CONF_BASELINE_RESTIMATED");
  if (staleExperimentIds.length > 0) codes.push("CONF_VERSION_STALE");
  return { changed, staleExperimentIds, codes: normalizeCodes(codes) };
}

/**
 * 把实验按目标版本切成 stale / active 两堆。
 * 无签名的实验无法核验版本 → 归 stale(宁可重跑,不可拿来源不明当证据)。
 */
export function markStale(
  experiments: readonly SignatureExperiment[],
  target: VersionPair): MarkStaleResult {
  const goal = versionPairOf(target);
  const stale: string[] = [];
  const active: string[] = [];
  const seen = new Set<string>();
  for (const item of listOf(experiments)) {
    if (!isRecord(item)) continue;
    const id = text(item["id"]);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    if (signatureStale(item["signature"], goal)) stale.push(id);
    else active.push(id);
  }
  return { stale, active };
}

/**
 * 混杂因子体检:四项恒在、顺序固定,让人一眼看到「这批样本为什么不齐」。
 * - version:model+provider 组合 > 1;
 * - project:去重 projectId > 1;
 * - taskClass:去重 > 1;
 * - duration:有 durationMs 的样本 max/min > 2(更贵的任务混在一起,均值不可比)。
 */
export function confounders(samples: readonly SignatureSample[]): ConfounderResult {
  const valid = coerceSamples(samples).samples;
  const versions = new Set<string>();
  const projects = new Set<string>();
  const taskClasses = new Set<string>();
  const durations: number[] = [];
  for (const sample of valid) {
    versions.add(`${sample.signature.modelVersion}|${sample.signature.providerVersion}`);
    if (sample.projectId !== undefined) projects.add(sample.projectId);
    taskClasses.add(sample.signature.taskClass);
    if (sample.durationMs !== undefined && sample.durationMs > 0) durations.push(sample.durationMs);
  }
  const durationRatio =
    durations.length >= 2 ? round2(Math.max(...durations) / Math.min(...durations)) : 0;
  const items: ConfounderItem[] = [
    { factor: "version", detail: `versions=${versions.size}`, present: versions.size > 1 },
    { factor: "project", detail: `projects=${projects.size}`, present: projects.size > 1 },
    { factor: "taskClass", detail: `taskClasses=${taskClasses.size}`, present: taskClasses.size > 1 },
    {
      factor: "duration",
      detail: `durationRatio=${durationRatio}`,
      present: durations.length >= 2 && durationRatio > 2,
    },
  ];
  const present = items.some((item) => item.present);
  return { items, codes: present ? ["CONF_CONFOUNDERS_PRESENT"] : [] };
}

/**
 * 幸存者偏差体检:对照集只剩成功样本(有样本但全 done)→ CONF_SURVIVOR_BIAS,
 * 因为「被筛掉的失败样本」正是最该看的那部分;有非 done 才算没被筛。
 */
export function survivorBias(
  samples: readonly SignatureSample[],
  opts: { excludedCount?: number } = {},
): SurvivorBiasResult {
  const valid = coerceSamples(samples).samples;
  const dropped = Math.floor(nonNegative(opts.excludedCount) ?? 0);
  const excludedCount = nonDoneCount(valid) + dropped;
  const biased = valid.length > 0 && nonDoneCount(valid) === 0;
  const codes: ConfCode[] = [];
  if (biased) codes.push("CONF_SURVIVOR_BIAS");
  if (nonDoneCount(valid) > 0) codes.push("CONF_INCLUDES_FAILURES");
  return { biased, excludedCount, codes: normalizeCodes(codes) };
}

/**
 * 样本集合审计:accepted 含非 done(它们仍是有效观测),invalid 是被跳过的脏条数。
 * 空集/全脏 → usable=false + CONF_INVALID;有非 done → CONF_INCLUDES_FAILURES。
 */
export function assertSampleSet(samples: readonly SignatureSample[]): SampleSetAudit {
  const { samples: valid, invalid } = coerceSamples(samples);
  const accepted = valid.length;
  const usable = accepted > 0;
  const codes: ConfCode[] = [];
  if (!usable) codes.push("CONF_INVALID");
  if (invalid > 0) codes.push("CONF_INVALID");
  if (nonDoneCount(valid) > 0) codes.push("CONF_INCLUDES_FAILURES");
  return { usable, accepted, invalid, codes: normalizeCodes(codes) };
}
