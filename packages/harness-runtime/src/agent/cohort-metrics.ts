/**
 * 一次通过率与缺陷逃逸度量(RSI #212):纯逻辑、零 IO。
 *
 * 问题:「争取一步到位」没有度量——返工率只算任务内返工,交付后被修复任务打穿的缺陷不算进来,
 * 于是「预防机制到底有没有用」无从判定。本模块把交付与修复两条记录流关联成「逃逸」,
 * 再按 module / defectClass / taskClass / boardType / signature 分桶算五项指标:
 * - 一次通过率 firstPassRate = (deliveries - escapes) / deliveries
 * - 缺陷逃逸率 escapeRate   = escapes / deliveries
 * - 逃逸缺陷缺失类别分布     escapeClasses
 * - 扇出返工率 fanoutReworkRate = Σ fix.changeNodes / Σ delivery.changeNodes(分母 0 → null)
 * - 发现延迟 discoveryDelay = fix.at - delivery.at 天数的中位数 + 分档计数
 *
 * 关联规则(linkFixes):
 * 1. 显式 relatedDeliveryId 命中既有交付即关联(显式优先,不看窗口);
 * 2. 否则隐式:同 module 且 fix.at ∈ (delivery.at, delivery.at + windowDays] 取最近一次交付;
 * 3. 一个 fix 只归一个 delivery(多 fix 可归同一交付)。
 *
 * 前后对比(compareBeforeAfter)按同一签名桶比:firstPassRate 提升 → improved;
 * |Δ| < minDeltaPct → flat;下降 → declined。flat / declined 一律 COHORT_REVIEW_REQUIRED,
 * 因为「预防机制没能提高一次通过率」本身就是要复审的信号。
 *
 * 纪律:不抛异常(非法记录计数跳过、缺字段给默认)、不做 IO、不依赖其它模块。
 */

/** 数据契约版本(落盘行与本模块共用)。 */
export const COHORT_VERSION = 1;

/** 稳定码:调用方按码分流,不解析文案。 */
export const COHORT_CODES = [
  "COHORT_OK",
  "COHORT_SAMPLE_LOW",
  "COHORT_ESCAPE_LINKED",
  "COHORT_UNLINKED_FIX",
  "COHORT_REVIEW_REQUIRED",
  "COHORT_IMPROVED",
  "COHORT_NO_BASELINE",
] as const;

export type CohortCode = (typeof COHORT_CODES)[number];

/** 逃逸缺陷的缺失类别(与 gap-taxonomy 的 missedLink 口径同源)。 */
export const COHORT_DEFECT_CLASSES = [
  "requirement",
  "plan-coverage",
  "verification-coverage",
  "knowledge-gap",
  "tool-gap",
  "wrong-assumption",
  "impact-analysis",
  "other",
] as const;

export type CohortDefectClass = (typeof COHORT_DEFECT_CLASSES)[number];

/** 返工发现延迟的分档(越靠后越贵)。 */
export const COHORT_DISCOVERY_STAGES = ["pre-commit", "ci", "nightly", "user-report"] as const;

/** 分档取值;未知档位记 "unknown"(不丢样本,也不假装知道)。 */
export type CohortDiscoveryStage = (typeof COHORT_DISCOVERY_STAGES)[number] | "unknown";

/** 一次交付(一个任务交付的结果,可能含多个变更节点)。 */
export interface DeliveryRecord {
  id: string;
  taskId: string;
  module: string;
  taskClass: string;
  boardType: string;
  at: number;
  /** 同签名桶对比用的签名(如预防机制的 id / 开关名)。 */
  signature?: string;
  changeNodes?: number;
}

/** 一次修复(修复任务;关联到交付即成为逃逸)。 */
export interface FixRecord {
  id: string;
  taskId: string;
  at: number;
  relatedDeliveryId?: string;
  module: string;
  defectClass?: CohortDefectClass;
  foundAt: CohortDiscoveryStage;
  changeNodes?: number;
}

/** 分桶键:defectClass 不参与交付分桶(只在逃逸类别分布里用)。 */
export interface CohortKey {
  module: string;
  defectClass?: CohortDefectClass;
  taskClass: string;
  boardType: string;
  signature?: string;
}

export interface CohortMetrics {
  key: CohortKey;
  deliveries: number;
  escapes: number;
  firstPassRate: number;
  escapeRate: number;
  escapeClasses: Record<string, number>;
  fanoutReworkRate: number | null;
  discoveryDelay: { medianDays: number | null; byStage: Record<string, number> };
  sampleSufficient: boolean;
}

export interface LinkedPair {
  delivery: DeliveryRecord;
  fix: FixRecord;
}

export interface LinkResult {
  linked: LinkedPair[];
  unlinked: FixRecord[];
  codes: CohortCode[];
  /** 非法(缺 id/at/module)而被跳过的记录数。 */
  skipped: number;
}

export interface ComputeResult {
  cohorts: CohortMetrics[];
  linked: LinkedPair[];
  unlinked: FixRecord[];
  codes: CohortCode[];
  skipped: number;
}

export type CohortVerdict = "improved" | "flat" | "declined";

export interface ComparisonResult {
  verdict: CohortVerdict;
  deltaPct: number;
  codes: CohortCode[];
}

export interface ReviewItem {
  module: string;
  taskClass: string;
  boardType: string;
  signature?: string;
  beforeDeliveries: number;
  afterDeliveries: number;
  beforeFirstPassRate: number | null;
  afterFirstPassRate: number | null;
  deltaPct: number;
  verdict: CohortVerdict;
  reason: string;
}

export interface AuditRow {
  module: string;
  defectClass?: string;
  taskClass: string;
  boardType: string;
  signature?: string;
  firstPassRate: number;
  escapeRate: number;
  fanoutReworkRate: number | null;
  medianDiscoveryDays: number | null;
  sampleSufficient: boolean;
  deliveries: number;
  escapes: number;
}

export interface LinkOptions {
  windowDays?: number;
}

export interface ComputeOptions extends LinkOptions {
  minDeliveries?: number;
}

export interface CompareOptions {
  minDeltaPct?: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_MIN_DELIVERIES = 5;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filled(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const n = finite(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return round2(numerator / denominator);
}

function definedStage(value: unknown): CohortDiscoveryStage {
  const stage = filled(value);
  return stage !== undefined && (COHORT_DISCOVERY_STAGES as readonly string[]).includes(stage)
    ? (stage as CohortDiscoveryStage)
    : "unknown";
}

function definedDefectClass(value: unknown): CohortDefectClass | undefined {
  const cls = filled(value);
  if (cls === undefined) return undefined;
  return (COHORT_DEFECT_CLASSES as readonly string[]).includes(cls) ? (cls as CohortDefectClass) : "other";
}

/** 宽松读一条交付;必填 id/taskId/module/at,其余缺字段给默认。 */
export function coerceDelivery(raw: unknown): DeliveryRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const id = filled(raw.id);
  const taskId = filled(raw.taskId);
  const module = filled(raw.module);
  const at = finite(raw.at);
  if (id === undefined || taskId === undefined || module === undefined || at === undefined) return undefined;
  const delivery: DeliveryRecord = {
    id,
    taskId,
    module,
    taskClass: filled(raw.taskClass) ?? "unknown",
    boardType: filled(raw.boardType) ?? "unknown",
    at,
  };
  const signature = filled(raw.signature);
  if (signature !== undefined) delivery.signature = signature;
  const changeNodes = nonNegative(raw.changeNodes);
  if (changeNodes !== undefined) delivery.changeNodes = changeNodes;
  return delivery;
}

/** 宽松读一条修复;必填 id/taskId/module/at,其余缺字段给默认。 */
export function coerceFix(raw: unknown): FixRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const id = filled(raw.id);
  const taskId = filled(raw.taskId);
  const module = filled(raw.module);
  const at = finite(raw.at);
  if (id === undefined || taskId === undefined || module === undefined || at === undefined) return undefined;
  const fix: FixRecord = { id, taskId, module, at, foundAt: definedStage(raw.foundAt) };
  const relatedDeliveryId = filled(raw.relatedDeliveryId);
  if (relatedDeliveryId !== undefined) fix.relatedDeliveryId = relatedDeliveryId;
  const defectClass = definedDefectClass(raw.defectClass);
  if (defectClass !== undefined) fix.defectClass = defectClass;
  const changeNodes = nonNegative(raw.changeNodes);
  if (changeNodes !== undefined) fix.changeNodes = changeNodes;
  return fix;
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function coerceDeliveries(value: unknown): { records: DeliveryRecord[]; skipped: number } {
  const records: DeliveryRecord[] = [];
  let skipped = 0;
  for (const raw of asList(value)) {
    const record = coerceDelivery(raw);
    if (record === undefined) skipped += 1;
    else records.push(record);
  }
  return { records, skipped };
}

function coerceFixes(value: unknown): { records: FixRecord[]; skipped: number } {
  const records: FixRecord[] = [];
  let skipped = 0;
  for (const raw of asList(value)) {
    const record = coerceFix(raw);
    if (record === undefined) skipped += 1;
    else records.push(record);
  }
  return { records, skipped };
}

/** 按 COHORT_CODES 的固定顺序去重;空集合给 COHORT_OK。 */
function normalizeCodes(codes: Iterable<CohortCode>): CohortCode[] {
  const set = new Set<CohortCode>(codes);
  const ordered = COHORT_CODES.filter((code) => set.has(code));
  return ordered.length > 0 ? ordered : ["COHORT_OK"];
}

function byAtThenId(a: { at: number; id: string }, b: { at: number; id: string }): number {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

interface LinkCoreResult {
  linked: LinkedPair[];
  unlinked: FixRecord[];
}

/** 关联核心(已规范化的记录):显式优先,否则同 module 窗口内最近一次交付。 */
function linkCore(deliveries: DeliveryRecord[], fixes: FixRecord[], windowDays: number): LinkCoreResult {
  const windowMs = windowDays * DAY_MS;
  const byId = new Map<string, DeliveryRecord>();
  for (const delivery of deliveries) if (!byId.has(delivery.id)) byId.set(delivery.id, delivery);
  const sortedDeliveries = deliveries.slice().sort(byAtThenId);
  const linked: LinkedPair[] = [];
  const unlinked: FixRecord[] = [];

  for (const fix of fixes.slice().sort(byAtThenId)) {
    let delivery: DeliveryRecord | undefined;
    if (fix.relatedDeliveryId !== undefined) delivery = byId.get(fix.relatedDeliveryId);
    if (delivery === undefined) {
      // 隐式:同 module、交付早于修复、间隔在窗口内,取 at 最大者(同一时刻取 id 最小,保证确定性)。
      for (const candidate of sortedDeliveries) {
        if (candidate.module !== fix.module) continue;
        if (candidate.at >= fix.at) continue;
        if (fix.at - candidate.at > windowMs) continue;
        if (delivery === undefined || candidate.at > delivery.at) delivery = candidate;
        else if (candidate.at === delivery.at && candidate.id < delivery.id) delivery = candidate;
      }
    }
    if (delivery === undefined) unlinked.push(fix);
    else linked.push({ delivery, fix });
  }
  return { linked, unlinked };
}

/**
 * 关联修复到交付。
 * unlinked 里的每条 fix 都是「显式 id 查不到且窗口内无同 module 交付」的逃逸缺口。
 */
export function linkFixes(input: { deliveries?: unknown; fixes?: unknown }, options: LinkOptions = {}): LinkResult {
  const windowDays = finite(options.windowDays) ?? DEFAULT_WINDOW_DAYS;
  const deliveries = coerceDeliveries(input.deliveries);
  const fixes = coerceFixes(input.fixes);
  const core = linkCore(deliveries.records, fixes.records, windowDays);
  const codes: CohortCode[] = [];
  if (core.linked.length > 0) codes.push("COHORT_ESCAPE_LINKED");
  if (core.unlinked.length > 0) codes.push("COHORT_UNLINKED_FIX");
  return {
    linked: core.linked,
    unlinked: core.unlinked,
    codes: normalizeCodes(codes),
    skipped: deliveries.skipped + fixes.skipped,
  };
}

function bucketId(key: CohortKey): string {
  return [key.module, key.taskClass, key.boardType, key.signature ?? ""].join("\u0001");
}

function compareKeys(a: CohortKey, b: CohortKey): number {
  return (
    a.module.localeCompare(b.module) ||
    a.taskClass.localeCompare(b.taskClass) ||
    a.boardType.localeCompare(b.boardType) ||
    (a.signature ?? "").localeCompare(b.signature ?? "")
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return round2(value);
}

interface Bucket {
  key: CohortKey;
  deliveries: DeliveryRecord[];
  escapes: LinkedPair[];
}

/**
 * 按 CohortKey 分组算五项指标。
 * 分桶:module + taskClass + boardType,有 signature 时加入(签名桶=同一种预防机制的前后对比单位)。
 */
export function computeCohortMetrics(
  input: { deliveries?: unknown; fixes?: unknown },
  options: ComputeOptions = {},
): ComputeResult {
  const windowDays = finite(options.windowDays) ?? DEFAULT_WINDOW_DAYS;
  const minDeliveries = finite(options.minDeliveries) ?? DEFAULT_MIN_DELIVERIES;
  const deliveries = coerceDeliveries(input.deliveries);
  const fixes = coerceFixes(input.fixes);
  const core = linkCore(deliveries.records, fixes.records, windowDays);

  const buckets = new Map<string, Bucket>();
  const bucketOfDelivery = new Map<string, Bucket>();
  for (const delivery of deliveries.records) {
    const key: CohortKey = {
      module: delivery.module,
      taskClass: delivery.taskClass,
      boardType: delivery.boardType,
    };
    if (delivery.signature !== undefined) key.signature = delivery.signature;
    const id = bucketId(key);
    let bucket = buckets.get(id);
    if (bucket === undefined) {
      bucket = { key, deliveries: [], escapes: [] };
      buckets.set(id, bucket);
    }
    bucket.deliveries.push(delivery);
    // 同 id 交付只归第一个桶(与 linkCore 的 byId 口径一致,避免重复计数)。
    if (!bucketOfDelivery.has(delivery.id)) bucketOfDelivery.set(delivery.id, bucket);
  }
  for (const pair of core.linked) {
    const bucket = bucketOfDelivery.get(pair.delivery.id);
    if (bucket !== undefined) bucket.escapes.push(pair);
  }

  const cohorts: CohortMetrics[] = [];
  const codes: CohortCode[] = [];
  const ordered = Array.from(buckets.values()).sort((a, b) => compareKeys(a.key, b.key));
  for (const bucket of ordered) {
    const deliveryCount = bucket.deliveries.length;
    const escapeCount = bucket.escapes.length;
    const escapeClasses: Record<string, number> = {};
    const byStage: Record<string, number> = {};
    const delayDays: number[] = [];
    let fixNodes = 0;
    let deliveryNodes = 0;
    for (const pair of bucket.escapes) {
      const cls = pair.fix.defectClass ?? "other";
      escapeClasses[cls] = (escapeClasses[cls] ?? 0) + 1;
      byStage[pair.fix.foundAt] = (byStage[pair.fix.foundAt] ?? 0) + 1;
      delayDays.push((pair.fix.at - pair.delivery.at) / DAY_MS);
      fixNodes += pair.fix.changeNodes ?? 0;
    }
    for (const delivery of bucket.deliveries) deliveryNodes += delivery.changeNodes ?? 0;
    const sampleSufficient = deliveryCount >= minDeliveries;
    if (!sampleSufficient) codes.push("COHORT_SAMPLE_LOW");
    cohorts.push({
      key: bucket.key,
      deliveries: deliveryCount,
      escapes: escapeCount,
      firstPassRate: ratio(deliveryCount - escapeCount, deliveryCount),
      escapeRate: ratio(escapeCount, deliveryCount),
      escapeClasses,
      fanoutReworkRate: deliveryNodes > 0 ? round2(fixNodes / deliveryNodes) : null,
      discoveryDelay: { medianDays: median(delayDays), byStage },
      sampleSufficient,
    });
  }

  if (core.linked.length > 0) codes.push("COHORT_ESCAPE_LINKED");
  if (core.unlinked.length > 0) codes.push("COHORT_UNLINKED_FIX");

  return {
    cohorts,
    linked: core.linked,
    unlinked: core.unlinked,
    codes: normalizeCodes(codes),
    skipped: deliveries.skipped + fixes.skipped,
  };
}

/**
 * 同签名桶前后对比。
 * |Δ firstPassRate| < minDeltaPct(%) → flat;提升 ≥ minDeltaPct → improved;下降 ≥ minDeltaPct → declined。
 * flat / declined 都是「预防机制没把一次通过率抬起来」→ COHORT_REVIEW_REQUIRED。
 */
export function compareBeforeAfter(
  pair: { before: CohortMetrics; after: CohortMetrics },
  options: CompareOptions = {},
): ComparisonResult {
  const minDeltaPct = nonNegative(options.minDeltaPct) ?? 2;
  const deltaPct = round2((pair.after.firstPassRate - pair.before.firstPassRate) * 100);
  const magnitude = Math.abs(deltaPct);
  let verdict: CohortVerdict;
  if (magnitude < minDeltaPct) verdict = "flat";
  else verdict = deltaPct > 0 ? "improved" : "declined";

  const codes: CohortCode[] = [];
  if (!pair.before.sampleSufficient) codes.push("COHORT_NO_BASELINE");
  if (!pair.after.sampleSufficient) codes.push("COHORT_SAMPLE_LOW");
  if (verdict === "improved") codes.push("COHORT_IMPROVED");
  else codes.push("COHORT_REVIEW_REQUIRED");
  return { verdict, deltaPct, codes: normalizeCodes(codes) };
}

function reviewReason(result: ComparisonResult): string {
  if (result.verdict === "declined") return `一次通过率下降 ${Math.abs(result.deltaPct)}%`;
  if (result.verdict === "flat") return `一次通过率持平(delta ${result.deltaPct}%)`;
  return `一次通过率提升 ${result.deltaPct}%`;
}

/** 需要复审的桶(只列 flat / declined,带前后样本数与原因)。 */
export function reviewList(
  comparisons: Array<{ before: CohortMetrics; after: CohortMetrics; comparison?: ComparisonResult }>,
): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const item of comparisons) {
    const result = item.comparison ?? compareBeforeAfter({ before: item.before, after: item.after });
    if (result.verdict === "improved") continue;
    const after = item.after;
    const review: ReviewItem = {
      module: after.key.module,
      taskClass: after.key.taskClass,
      boardType: after.key.boardType,
      beforeDeliveries: item.before.deliveries,
      afterDeliveries: after.deliveries,
      beforeFirstPassRate: item.before.deliveries > 0 ? item.before.firstPassRate : null,
      afterFirstPassRate: after.deliveries > 0 ? after.firstPassRate : null,
      deltaPct: result.deltaPct,
      verdict: result.verdict,
      reason: reviewReason(result),
    };
    const signature = after.key.signature ?? item.before.key.signature;
    if (signature !== undefined) review.signature = signature;
    items.push(review);
  }
  return items;
}

/** 审计面行:一行一个桶,列全五项指标 + 样本是否充分。 */
export function toAuditRows(cohorts: CohortMetrics[]): AuditRow[] {
  return cohorts.map((cohort) => {
    const row: AuditRow = {
      module: cohort.key.module,
      taskClass: cohort.key.taskClass,
      boardType: cohort.key.boardType,
      firstPassRate: cohort.firstPassRate,
      escapeRate: cohort.escapeRate,
      fanoutReworkRate: cohort.fanoutReworkRate,
      medianDiscoveryDays: cohort.discoveryDelay.medianDays,
      sampleSufficient: cohort.sampleSufficient,
      deliveries: cohort.deliveries,
      escapes: cohort.escapes,
    };
    if (cohort.key.defectClass !== undefined) row.defectClass = cohort.key.defectClass;
    if (cohort.key.signature !== undefined) row.signature = cohort.key.signature;
    return row;
  });
}
