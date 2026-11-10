/**
 * 一次通过率与缺陷逃逸度量的持久层(RSI #212):把 cohort-metrics 的纯逻辑落到 append-only jsonl。
 * 为什么 append-only:交付与修复是审计事实——「这条修复算不算逃逸」「它归到哪次交付」是判断的历史,
 * 后来的写入不该覆盖;单行追加 + 写后重读行数校验让「写成功了吗」成为可复核断言(而不是信任 append 没抛)。
 * 数据面:`<root>/.genie/rsi/cohort.jsonl`,每行 `{v:1,type,at,...}`
 * - delivery {delivery}   一次交付(module/taskClass/boardType/signature/changeNodes)
 * - fix      {fix}        一次修复(relatedDeliveryId/defectClass/foundAt/changeNodes)
 * 投影语义:按行序读全部行;坏行(JSON 坏 / v 不是 1 / type 未知 / 载荷不合法)只计入 parseErrors 并跳过:
 * 一行坏不整文件失效、不 throw。
 * 依赖纪律:node:fs / node:path + runtime 的纯逻辑模块;不引 agent loop、不引 gateway 其余业务模块。
 * runtime 模块按 defect-lineage-store 的既有套路惰性解析(两跳):
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 除参数错误(root 非法)外不 throw:IO/投影失败一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AuditRow,
  CohortCode,
  CohortMetrics,
  ComparisonResult,
  ComputeOptions,
  ComputeResult,
  DeliveryRecord,
  FixRecord,
  LinkedPair,
  LinkResult,
  ReviewItem,
} from "@lampgenie/runtime/agent/cohort-metrics";

/** store 稳定码:store 层自产的失败码(指标码沿用 runtime 的 COHORT_CODES)。 */
export const COHORT_STORE_CODES = [
  "COHORT_DUPLICATE",
  "COHORT_INVALID_INPUT",
  "COHORT_LEDGER_WRITE_VERIFY_FAILED",
  "COHORT_STORE_ERROR",
] as const;

export type CohortStoreCode = (typeof COHORT_STORE_CODES)[number];

/** 落盘行类型(只增不改)。 */
export const COHORT_LINE_TYPES = ["delivery", "fix"] as const;

export type CohortLineType = (typeof COHORT_LINE_TYPES)[number];

export interface CohortDeliveryLine {
  v: 1;
  type: "delivery";
  at: number;
  delivery: DeliveryRecord;
}

export interface CohortFixLine {
  v: 1;
  type: "fix";
  at: number;
  fix: FixRecord;
}

export type CohortLine = CohortDeliveryLine | CohortFixLine;

/** 投影结果:两条记录流 + 坏行计数。 */
export interface CohortProjection {
  deliveries: DeliveryRecord[];
  fixes: FixRecord[];
  parseErrors: number;
  totalLines: number;
  badLines: number[];
}

export interface CohortRecordResult {
  ok: boolean;
  code?: string;
  id?: string;
}

export interface CohortComputeStoreResult {
  ok: boolean;
  code?: string;
  cohorts: CohortMetrics[];
  linked: LinkedPair[];
  unlinked: FixRecord[];
  codes: string[];
  parseErrors: number;
  totalLines: number;
}

export interface CohortAggregateRow {
  deliveries: number;
  escapes: number;
  firstPassRate: number;
  escapeRate: number;
  fanoutReworkRate: number | null;
}

export interface CohortSampleLowItem {
  module: string;
  taskClass: string;
  boardType: string;
  signature?: string;
  deliveries: number;
}

export interface CohortReportResult {
  ok: boolean;
  code?: string;
  cohorts: number;
  totals: CohortAggregateRow;
  byModule: Record<string, CohortAggregateRow>;
  byTaskClass: Record<string, CohortAggregateRow>;
  byBoardType: Record<string, CohortAggregateRow>;
  byDefectClass: Record<string, number>;
  sampleLow: CohortSampleLowItem[];
  codes: string[];
  parseErrors: number;
  totalLines: number;
}

export interface CohortReviewOptions {
  beforeSignatures?: string[];
  afterSignatures?: string[];
}

export interface CohortReviewResult {
  ok: boolean;
  code?: string;
  mode: "signature-window" | "module-baseline";
  items: ReviewItem[];
  comparisons: Array<{ before: CohortMetrics; after: CohortMetrics; comparison: ComparisonResult }>;
  codes: string[];
  parseErrors: number;
  totalLines: number;
}

export interface CohortAuditRowsResult {
  ok: boolean;
  code?: string;
  rows: AuditRow[];
  codes: string[];
  parseErrors: number;
  totalLines: number;
}

interface CohortRuntime {
  COHORT_VERSION: number;
  coerceDelivery(raw: unknown): DeliveryRecord | undefined;
  coerceFix(raw: unknown): FixRecord | undefined;
  linkFixes(input: { deliveries?: unknown; fixes?: unknown }, options?: { windowDays?: number }): LinkResult;
  computeCohortMetrics(
    input: { deliveries?: unknown; fixes?: unknown },
    options?: ComputeOptions): ComputeResult;
  compareBeforeAfter(
    pair: { before: CohortMetrics; after: CohortMetrics },
    options?: { minDeltaPct?: number },
  ): ComparisonResult;
  reviewList(
    comparisons: Array<{ before: CohortMetrics; after: CohortMetrics; comparison?: ComparisonResult }>,
  ): ReviewItem[];
  toAuditRows(cohorts: CohortMetrics[]): AuditRow[];
}

let cohortRuntime: CohortRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadCohortRuntime(): Promise<CohortRuntime> {
  if (cohortRuntime) return cohortRuntime;
  const spec = "@lampgenie/runtime/agent/cohort-metrics";
  try {
    cohortRuntime = (await import(spec)) as CohortRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/cohort-metrics.ts", import.meta.url).href;
    cohortRuntime = (await import(srcUrl)) as CohortRuntime;
  }
  return cohortRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadCohortRuntime();

const LINE_TYPES: ReadonlySet<string> = new Set<string>(COHORT_LINE_TYPES);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value.slice() as string[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 指标台账文件绝对路径:`<root>/.genie/rsi/cohort.jsonl`。 */
export function cohortMetricsPath(root: string): string {
  return join(root, ".genie", "rsi", "cohort.jsonl");
}

function assertRoot(root: unknown): string {
  if (typeof root !== "string" || root.trim() === "") throw new Error("root 必须是非空字符串");
  return root;
}

/** 统计文件非空行数;文件不存在/读失败按 0。 */
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

/** 追加一行并做写后行数校验;失败折叠成 COHORT_LEDGER_WRITE_VERIFY_FAILED,不回滚、不 throw。 */
function appendCohortLine(root: string, line: CohortLine): boolean {
  const path = cohortMetricsPath(root);
  const before = countLines(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    return false;
  }
  return countLines(path) === before + 1;
}

/** 读整个台账:坏行计入 parseErrors/badLines 并跳过,不 throw。 */
export function loadCohort(root: string): CohortProjection {
  const base = assertRoot(root);
  const path = cohortMetricsPath(base);
  const projection: CohortProjection = {
    deliveries: [],
    fixes: [],
    parseErrors: 0,
    totalLines: 0,
    badLines: [],
  };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return projection;
  }
  const seenDelivery = new Set<string>();
  const seenFix = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!.trim();
    if (raw === "") continue;
    projection.totalLines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      projection.parseErrors += 1;
      projection.badLines.push(i + 1);
      continue;
    }
    if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.type !== "string" || !LINE_TYPES.has(parsed.type)) {
      projection.parseErrors += 1;
      projection.badLines.push(i + 1);
      continue;
    }
    if (parsed.type === "delivery") {
      const delivery = rt.coerceDelivery(parsed.delivery);
      if (delivery === undefined) {
        projection.parseErrors += 1;
        projection.badLines.push(i + 1);
        continue;
      }
      if (seenDelivery.has(delivery.id)) {
        projection.parseErrors += 1;
        projection.badLines.push(i + 1);
        continue;
      }
      seenDelivery.add(delivery.id);
      projection.deliveries.push(delivery);
    } else {
      const fix = rt.coerceFix(parsed.fix);
      if (fix === undefined) {
        projection.parseErrors += 1;
        projection.badLines.push(i + 1);
        continue;
      }
      if (seenFix.has(fix.id)) {
        projection.parseErrors += 1;
        projection.badLines.push(i + 1);
        continue;
      }
      seenFix.add(fix.id);
      projection.fixes.push(fix);
    }
  }
  return projection;
}

function hasId(projection: CohortProjection, id: string): boolean {
  return projection.deliveries.some((item) => item.id === id) || projection.fixes.some((item) => item.id === id);
}

/** 登记一次交付;重复 id 拒收,非法输入折叠成 COHORT_INVALID_INPUT。 */
export function recordDelivery(root: string, delivery: unknown): CohortRecordResult {
  const base = assertRoot(root);
  const normalized = rt.coerceDelivery(delivery);
  if (normalized === undefined) return { ok: false, code: "COHORT_INVALID_INPUT" };
  if (hasId(loadCohort(base), normalized.id)) return { ok: false, code: "COHORT_DUPLICATE", id: normalized.id };
  const line: CohortDeliveryLine = { v: 1, type: "delivery", at: normalized.at, delivery: normalized };
  if (!appendCohortLine(base, line)) return { ok: false, code: "COHORT_LEDGER_WRITE_VERIFY_FAILED" };
  return { ok: true, id: normalized.id };
}

/** 登记一次修复;重复 id 拒收,非法输入折叠成 COHORT_INVALID_INPUT。 */
export function recordFix(root: string, fix: unknown): CohortRecordResult {
  const base = assertRoot(root);
  const normalized = rt.coerceFix(fix);
  if (normalized === undefined) return { ok: false, code: "COHORT_INVALID_INPUT" };
  if (hasId(loadCohort(base), normalized.id)) return { ok: false, code: "COHORT_DUPLICATE", id: normalized.id };
  const line: CohortFixLine = { v: 1, type: "fix", at: normalized.at, fix: normalized };
  if (!appendCohortLine(base, line)) return { ok: false, code: "COHORT_LEDGER_WRITE_VERIFY_FAILED" };
  return { ok: true, id: normalized.id };
}

/** 计算桶指标(关联 + 分桶 + 五项指标),附带 linked/unlinked 明细。 */
export function compute(root: string, options: ComputeOptions = {}): CohortComputeStoreResult {
  const base = assertRoot(root);
  const projection = loadCohort(base);
  const result = rt.computeCohortMetrics(
    { deliveries: projection.deliveries, fixes: projection.fixes },
    options);
  return {
    ok: true,
    cohorts: result.cohorts,
    linked: result.linked,
    unlinked: result.unlinked,
    codes: result.codes,
    parseErrors: projection.parseErrors,
    totalLines: projection.totalLines,
  };
}

function summarize(deliveries: DeliveryRecord[], linked: LinkedPair[]): CohortAggregateRow {
  const total = deliveries.length;
  const escapes = linked.length;
  let fixNodes = 0;
  let deliveryNodes = 0;
  for (const pair of linked) fixNodes += pair.fix.changeNodes ?? 0;
  for (const delivery of deliveries) deliveryNodes += delivery.changeNodes ?? 0;
  return {
    deliveries: total,
    escapes,
    firstPassRate: total > 0 ? round2((total - escapes) / total) : 0,
    escapeRate: total > 0 ? round2(escapes / total) : 0,
    fanoutReworkRate: deliveryNodes > 0 ? round2(fixNodes / deliveryNodes) : null,
  };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [item]);
    else bucket.push(item);
  }
  return groups;
}

/** 报表:总账 + byModule/byTaskClass/byBoardType 汇总 + byDefectClass 计数 + 样本不足清单。 */
export function reportCohorts(root: string): CohortReportResult {
  const base = assertRoot(root);
  const projection = loadCohort(base);
  const link = rt.linkFixes({ deliveries: projection.deliveries, fixes: projection.fixes });
  const result = rt.computeCohortMetrics(
    { deliveries: projection.deliveries, fixes: projection.fixes },
    {},
  );
  const byModule: Record<string, CohortAggregateRow> = {};
  for (const [module, deliveries] of groupBy(projection.deliveries, (item) => item.module)) {
    const ids = new Set(deliveries.map((item) => item.id));
    byModule[module] = summarize(deliveries, link.linked.filter((pair) => ids.has(pair.delivery.id)));
  }
  const byTaskClass: Record<string, CohortAggregateRow> = {};
  for (const [taskClass, deliveries] of groupBy(projection.deliveries, (item) => item.taskClass)) {
    const ids = new Set(deliveries.map((item) => item.id));
    byTaskClass[taskClass] = summarize(deliveries, link.linked.filter((pair) => ids.has(pair.delivery.id)));
  }
  const byBoardType: Record<string, CohortAggregateRow> = {};
  for (const [boardType, deliveries] of groupBy(projection.deliveries, (item) => item.boardType)) {
    const ids = new Set(deliveries.map((item) => item.id));
    byBoardType[boardType] = summarize(deliveries, link.linked.filter((pair) => ids.has(pair.delivery.id)));
  }
  const byDefectClass: Record<string, number> = {};
  for (const pair of link.linked) {
    const cls = pair.fix.defectClass ?? "other";
    byDefectClass[cls] = (byDefectClass[cls] ?? 0) + 1;
  }
  const sampleLow: CohortSampleLowItem[] = result.cohorts
    .filter((cohort) => !cohort.sampleSufficient)
    .map((cohort) => {
      const item: CohortSampleLowItem = {
        module: cohort.key.module,
        taskClass: cohort.key.taskClass,
        boardType: cohort.key.boardType,
        deliveries: cohort.deliveries,
      };
      if (cohort.key.signature !== undefined) item.signature = cohort.key.signature;
      return item;
    });
  return {
    ok: true,
    cohorts: result.cohorts.length,
    totals: summarize(projection.deliveries, link.linked),
    byModule,
    byTaskClass,
    byBoardType,
    byDefectClass,
    sampleLow,
    codes: result.codes,
    parseErrors: projection.parseErrors,
    totalLines: projection.totalLines,
  };
}

function bucketIdOf(cohort: CohortMetrics): string {
  return [cohort.key.module, cohort.key.taskClass, cohort.key.boardType].join("\u0001");
}

/**
 * 复审清单。
 * - 给了 beforeSignatures/afterSignatures:按签名把交付分成前后两窗,同桶对比(mode=signature-window)。
 * - 未给:每个签名桶与「本 module 未写签名的交付」聚合基线对比(mode=module-baseline);
 *   module 里没有任何未签名交付时退回全 module 聚合,并标 COHORT_NO_BASELINE(基线不是真前置窗)。
 */
export function review(root: string, options: CohortReviewOptions = {}): CohortReviewResult {
  const base = assertRoot(root);
  const projection = loadCohort(base);
  const beforeSignatures = new Set(stringArray(options.beforeSignatures) ?? []);
  const afterSignatures = new Set(stringArray(options.afterSignatures) ?? []);
  const link = rt.linkFixes({ deliveries: projection.deliveries, fixes: projection.fixes });
  const comparisonItems: Array<{ before: CohortMetrics; after: CohortMetrics; comparison: ComparisonResult }> = [];
  const codes = new Set<string>();

  if (beforeSignatures.size > 0 && afterSignatures.size > 0) {
    // 前后两个窗口的签名本来就不一样(旧机制的签名 vs 新机制的签名),签名若留在桶键里前后永不配对。
    // 所以这里先剥掉签名、按 module/taskClass/boardType 分桶,再把 after 窗的签名集合挂回桶键供报表读。
    const stripSignature = (item: DeliveryRecord): DeliveryRecord => {
      const copy: DeliveryRecord = { ...item };
      delete copy.signature;
      return copy;
    };
    const pick = (signatures: Set<string>) => {
      const deliveries = projection.deliveries.filter(
        (item) => item.signature !== undefined && signatures.has(item.signature),
      );
      const ids = new Set(deliveries.map((item) => item.id));
      const fixes = link.linked.filter((pair) => ids.has(pair.delivery.id)).map((pair) => pair.fix);
      return rt.computeCohortMetrics({ deliveries: deliveries.map(stripSignature), fixes }, {});
    };
    const afterLabel = Array.from(afterSignatures).sort().join("+");
    const beforeSide = pick(beforeSignatures);
    const afterSide = pick(afterSignatures);
    for (const code of beforeSide.codes) codes.add(code);
    for (const code of afterSide.codes) codes.add(code);
    const beforeById = new Map<string, CohortMetrics>();
    for (const cohort of beforeSide.cohorts) {
      beforeById.set(bucketIdOf(cohort), { ...cohort, key: { ...cohort.key, signature: afterLabel } });
    }
    for (const cohort of afterSide.cohorts) {
      const before = beforeById.get(bucketIdOf(cohort));
      if (before === undefined) {
        codes.add("COHORT_NO_BASELINE");
        continue;
      }
      const after: CohortMetrics = { ...cohort, key: { ...cohort.key, signature: afterLabel } };
      comparisonItems.push({
        before,
        after,
        comparison: rt.compareBeforeAfter({ before, after }),
      });
    }
    for (const item of comparisonItems) for (const code of item.comparison.codes) codes.add(code);
    return {
      ok: true,
      mode: "signature-window",
      items: rt.reviewList(comparisonItems),
      comparisons: comparisonItems,
      codes: codes.size > 0 ? Array.from(codes) : ["COHORT_OK"],
      parseErrors: projection.parseErrors,
      totalLines: projection.totalLines,
    };
  }

  const all = rt.computeCohortMetrics({ deliveries: projection.deliveries, fixes: projection.fixes }, {});
  const signedCohorts = all.cohorts.filter((cohort) => cohort.key.signature !== undefined);
  const byModuleDeliveries = groupBy(projection.deliveries, (item) => item.module);
  for (const cohort of signedCohorts) {
    const moduleDeliveries = byModuleDeliveries.get(cohort.key.module) ?? [];
    const unsigned = moduleDeliveries.filter((item) => item.signature === undefined);
    const baselineDeliveries = unsigned.length > 0 ? unsigned : moduleDeliveries;
    if (baselineDeliveries.length === 0) {
      codes.add("COHORT_NO_BASELINE");
      continue;
    }
    if (unsigned.length === 0) codes.add("COHORT_NO_BASELINE");
    const ids = new Set(baselineDeliveries.map((item) => item.id));
    const baselineFixes = link.linked.filter((pair) => ids.has(pair.delivery.id)).map((pair) => pair.fix);
    const baseline = rt.computeCohortMetrics({ deliveries: baselineDeliveries, fixes: baselineFixes }, {});
    const before = baseline.cohorts.find((item) => item.key.module === cohort.key.module && item.key.signature === undefined);
    if (before === undefined) {
      codes.add("COHORT_NO_BASELINE");
      continue;
    }
    const comparison = rt.compareBeforeAfter({ before, after: cohort });
    for (const code of comparison.codes) codes.add(code);
    comparisonItems.push({ before, after: cohort, comparison });
  }
  for (const code of all.codes) if (code === "COHORT_UNLINKED_FIX") codes.add(code);
  return {
    ok: true,
    mode: "module-baseline",
    items: rt.reviewList(comparisonItems),
    comparisons: comparisonItems,
    codes: codes.size > 0 ? Array.from(codes) : ["COHORT_OK"],
    parseErrors: projection.parseErrors,
    totalLines: projection.totalLines,
  };
}

/** 审计面行(周报/审计面消费)。 */
export function exportAuditRows(root: string): CohortAuditRowsResult {
  const base = assertRoot(root);
  const result = compute(base, {});
  return {
    ok: true,
    rows: rt.toAuditRows(result.cohorts),
    codes: result.codes,
    parseErrors: result.parseErrors,
    totalLines: result.totalLines,
  };
}

/** 供 CLI 打印的码表(runtime 码 + store 码)。 */
export const COHORT_ALL_CODES: string[] = [...COHORT_STORE_CODES];

/** 形态判定:是不是合法的修复载荷(CLI 用,免得重复实现)。 */
export function isFixPayload(value: unknown): value is FixRecord {
  return rt.coerceFix(value) !== undefined;
}

/** 形态判定:是不是合法的交付载荷。 */
export function isDeliveryPayload(value: unknown): value is DeliveryRecord {
  return rt.coerceDelivery(value) !== undefined;
}

export type { AuditRow, CohortCode, CohortMetrics, ComparisonResult, DeliveryRecord, FixRecord, ReviewItem };
