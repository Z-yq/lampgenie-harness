/**
 * 情境签名样本的持久层(RSI 版本治理):把 cohort-signature 的纯逻辑落到 append-only jsonl。
 * 为什么 append-only:一条样本的签名是「它当时在什么情境下跑出来的」这一审计事实,
 * 版本切换、基线重估也必须留痕——后来的写入不该覆盖历史行。
 * 单行追加 + 写后重读行数校验让「写成功了吗」成为可复核断言(而不是信任 append 没抛)。
 * 数据面:`<root>/.genie/rsi/signatures.jsonl`,每行 `{v:1,type,at,...}`
 * - sample   {sample}                                  一条观测样本(SignatureSample)
 * - version  {modelVersion,providerVersion,prev?,changed}  一次版本登记(每次调用都追加)
 * - baseline {modelVersion,providerVersion,reason}     版本变化时重估基线的留痕
 * 投影语义:按行序读全部行;坏行(JSON 坏 / v 不是 1 / type 未知 / 载荷不合法)只计入 parseErrors
 * 并跳过:一行坏不整文件失效、不 throw。
 * 依赖纪律:node:fs / node:path + runtime 的纯逻辑模块;不引 agent loop、不引 gateway 其余业务模块。
 * runtime 模块按 cohort-metrics-store 的既有套路惰性解析(两跳):
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 除参数错误(root 非法)外不 throw:IO/投影失败一律折叠成稳定码返回。
 * store 自产的码与 runtime 的 CONF_* 分开(前者说「存/取失败」,后者说「样本集不能说事」)。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ComparisonResult,
  ConfounderResult,
  CounterfactualResult,
  MarkStaleResult,
  SignatureBucket,
  SignatureExperiment,
  SignatureSample,
  SituationSignature,
  SurvivorBiasResult,
  VersionChangeResult,
  VersionPair,
  VersionStratum,
} from "@lampgenie/runtime/agent/cohort-signature";

/** store 稳定码:store 层自产的失败码(样本集判断码沿用 runtime 的 CONF_*)。 */
export const SIGNATURE_STORE_CODES = [
  "SIGNATURE_DUPLICATE",
  "SIGNATURE_INVALID_INPUT",
  "SIGNATURE_MISSING_SAMPLE",
  "SIGNATURE_LEDGER_WRITE_VERIFY_FAILED",
  "SIGNATURE_STORE_ERROR",
] as const;

export type SignatureStoreCode = (typeof SIGNATURE_STORE_CODES)[number];

/** 落盘行类型(只增不改)。 */
export const SIGNATURE_LINE_TYPES = ["sample", "version", "baseline"] as const;

export type SignatureLineType = (typeof SIGNATURE_LINE_TYPES)[number];

export interface SignatureSampleLine {
  v: 1;
  type: "sample";
  at: number;
  sample: SignatureSample;
}

export interface SignatureVersionLine {
  v: 1;
  type: "version";
  at: number;
  modelVersion: string;
  providerVersion: string;
  prev?: VersionPair;
  changed: boolean;
}

export interface SignatureBaselineLine {
  v: 1;
  type: "baseline";
  at: number;
  modelVersion: string;
  providerVersion: string;
  reason: "version-change";
}

export type SignatureLine = SignatureSampleLine | SignatureVersionLine | SignatureBaselineLine;

/** 投影结果:三条记录流 + 坏行计数。 */
export interface SignatureProjection {
  samples: SignatureSample[];
  versions: SignatureVersionLine[];
  baselines: SignatureBaselineLine[];
  parseErrors: number;
  totalLines: number;
  badLines: number[];
}

export interface SignatureAddResult {
  ok: boolean;
  id?: string;
  codes: string[];
}

export interface SignatureListOptions {
  signatureKey?: string;
  status?: string;
}

export interface SignatureListResult {
  ok: true;
  samples: SignatureSample[];
  codes: string[];
  parseErrors: number;
  totalLines: number;
}

export interface SignatureBucketTotals {
  samples: number;
  done: number;
  failed: number;
  interrupted: number;
  cancelled: number;
}

export interface SignatureBucketsResult {
  ok: true;
  buckets: Record<string, SignatureBucket>;
  totals: SignatureBucketTotals;
  codes: string[];
  parseErrors: number;
  totalLines: number;
}

export interface SignatureCompareOptions {
  aId: string;
  bId: string;
  strict?: boolean;
  minPerArm?: number;
}

export interface SignatureCompareResult {
  ok: boolean;
  verdict: "comparable" | "not-matched" | "insufficient" | "missing-sample";
  codes: string[];
  deltas: ComparisonResult["deltas"];
  includesFailures: { a: number; b: number };
  aId: string;
  bId: string;
  armSizes: { a: number; b: number };
  signatureKeyA?: string;
  signatureKeyB?: string;
}

export interface SignatureCounterfactualsResult {
  ok: true;
  result: CounterfactualResult;
  codes: string[];
  parseErrors: number;
}

export interface SignatureVersionChangeOptions {
  modelVersion: string;
  providerVersion: string;
  experiments?: Array<{ id: string; signature: SituationSignature }>;
}

export interface SignatureVersionChangeStoreResult {
  ok: boolean;
  result: VersionChangeResult;
  prev?: VersionPair;
  appended: { version: boolean; baseline: boolean };
  codes: string[];
  parseErrors: number;
}

export interface SignatureMarkStaleOptions {
  modelVersion?: string;
  providerVersion?: string;
  experiments?: Array<{ id: string; signature: SituationSignature }>;
}

export interface SignatureMarkStaleStoreResult {
  ok: boolean;
  stale: string[];
  active: string[];
  codes: string[];
}

export interface SignatureConfoundersResult {
  ok: true;
  result: ConfounderResult;
  codes: string[];
  parseErrors: number;
}

export interface SignatureSurvivorBiasResult {
  ok: true;
  result: SurvivorBiasResult;
  codes: string[];
  parseErrors: number;
}

export interface SignatureReportBucket {
  signatureKey: string;
  counts: { done: number; failed: number; interrupted: number; cancelled: number };
  mean: number;
  decisions: string[];
}

export interface SignatureReportVersionRow {
  providerVersions: string[];
  mean: number;
  count: number;
}

export interface SignatureReportResult {
  ok: true;
  version: 1;
  totalLines: number;
  parseErrors: number;
  samples: number;
  buckets: SignatureReportBucket[];
  versions: Record<string, SignatureReportVersionRow>;
  confounders: ConfounderResult;
  survivorBias: SurvivorBiasResult;
  codes: string[];
}

interface SignatureRuntime {
  SIGNATURE_VERSION: number;
  signatureKey(sig: SituationSignature): string;
  coerceSignature(raw: unknown): SituationSignature | undefined;
  coerceSample(raw: unknown): SignatureSample | undefined;
  buildBuckets(samples: readonly SignatureSample[]): Record<string, SignatureBucket>;
  counterfactualPairs(
    samples: readonly SignatureSample[],
    opts?: { minPerArm?: number },
  ): CounterfactualResult;
  evaluateComparison(
    a: readonly SignatureSample[],
    b: readonly SignatureSample[],
    opts?: { strict?: boolean; minPerArm?: number },
  ): ComparisonResult;
  stratifyByVersion(samples: readonly SignatureSample[]): Record<string, VersionStratum>;
  detectVersionChange(input: {
    prev: VersionPair;
    next: VersionPair;
    experiments?: readonly SignatureExperiment[];
  }): VersionChangeResult;
  markStale(
    experiments: readonly SignatureExperiment[],
    target: VersionPair): MarkStaleResult;
  confounders(samples: readonly SignatureSample[]): ConfounderResult;
  survivorBias(samples: readonly SignatureSample[]): SurvivorBiasResult;
}

let signatureRuntime: SignatureRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadSignatureRuntime(): Promise<SignatureRuntime> {
  if (signatureRuntime) return signatureRuntime;
  const spec = "@lampgenie/runtime/agent/cohort-signature";
  try {
    signatureRuntime = (await import(spec)) as SignatureRuntime;
  } catch {
    const srcUrl = new URL(
      "../../../packages/harness-runtime/src/agent/cohort-signature.ts",
      import.meta.url).href;
    signatureRuntime = (await import(srcUrl)) as SignatureRuntime;
  }
  return signatureRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadSignatureRuntime();

const LINE_TYPES: ReadonlySet<string> = new Set<string>(SIGNATURE_LINE_TYPES);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return round2(sum / values.length);
}

function normalizeCodes(codes: Iterable<string>): string[] {
  return Array.from(new Set(codes)).sort();
}

/** 签名样本台账文件绝对路径:`<root>/.genie/rsi/signatures.jsonl`。 */
export function signaturesPath(root: string): string {
  const base = assertRoot(root);
  return join(base, ".genie", "rsi", "signatures.jsonl");
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

/** 追加一行并做写后行数校验;失败折叠成 SIGNATURE_LEDGER_WRITE_VERIFY_FAILED,不回滚、不 throw。 */
function appendSignatureLine(root: string, line: SignatureLine): boolean {
  const path = signaturesPath(root);
  const before = countLines(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    return false;
  }
  return countLines(path) === before + 1;
}

function versionPairOf(value: unknown): VersionPair | undefined {
  if (!isRecord(value)) return undefined;
  const modelVersion = textOf(value["modelVersion"]);
  const providerVersion = textOf(value["providerVersion"]);
  if (modelVersion === undefined || providerVersion === undefined) return undefined;
  return { modelVersion, providerVersion };
}

/** 读整个台账:坏行计入 parseErrors/badLines 并跳过,不 throw。 */
export function loadSignatures(root: string): SignatureProjection {
  const base = assertRoot(root);
  const path = signaturesPath(base);
  const projection: SignatureProjection = {
    samples: [],
    versions: [],
    baselines: [],
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
  const seenSample = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!.trim();
    if (raw === "") continue;
    projection.totalLines += 1;
    const bad = () => {
      projection.parseErrors += 1;
      projection.badLines.push(i + 1);
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      bad();
      continue;
    }
    if (
      !isRecord(parsed) ||
      parsed["v"] !== 1 ||
      typeof parsed["type"] !== "string" ||
      !LINE_TYPES.has(parsed["type"])
    ) {
      bad();
      continue;
    }
    const type = parsed["type"];
    const at = parsed["at"];
    if (type === "sample") {
      const sample = rt.coerceSample(parsed["sample"]);
      if (sample === undefined || seenSample.has(sample.id)) {
        bad();
        continue;
      }
      seenSample.add(sample.id);
      projection.samples.push(sample);
      continue;
    }
    const modelVersion = textOf(parsed["modelVersion"]);
    const providerVersion = textOf(parsed["providerVersion"]);
    if (modelVersion === undefined || providerVersion === undefined) {
      bad();
      continue;
    }
    if (type === "version") {
      const prev = versionPairOf(parsed["prev"]);
      const line: SignatureVersionLine = {
        v: 1,
        type: "version",
        at: isFiniteNumber(at) ? at : 0,
        modelVersion,
        providerVersion,
        changed: parsed["changed"] === true,
      };
      if (prev !== undefined) line.prev = prev;
      projection.versions.push(line);
      continue;
    }
    // type === "baseline":只认 reason=version-change 的基线重估留痕。
    if (parsed["reason"] !== "version-change") {
      bad();
      continue;
    }
    projection.baselines.push({
      v: 1,
      type: "baseline",
      at: isFiniteNumber(at) ? at : 0,
      modelVersion,
      providerVersion,
      reason: "version-change",
    });
  }
  return projection;
}

function keyOf(sample: SignatureSample): string {
  return rt.signatureKey(sample.signature);
}

/** 登记一条样本;coerce 失败 → SIGNATURE_INVALID_INPUT,同 id 已存在 → SIGNATURE_DUPLICATE(不覆盖)。 */
export function addSample(root: string, sample: unknown): SignatureAddResult {
  const base = assertRoot(root);
  const normalized = rt.coerceSample(sample);
  if (normalized === undefined) return { ok: false, codes: ["SIGNATURE_INVALID_INPUT"] };
  const projection = loadSignatures(base);
  if (projection.samples.some((item) => item.id === normalized.id)) {
    return { ok: false, id: normalized.id, codes: ["SIGNATURE_DUPLICATE"] };
  }
  const line: SignatureSampleLine = { v: 1, type: "sample", at: normalized.at, sample: normalized };
  if (!appendSignatureLine(base, line)) {
    return { ok: false, id: normalized.id, codes: ["SIGNATURE_LEDGER_WRITE_VERIFY_FAILED"] };
  }
  return { ok: true, id: normalized.id, codes: [] };
}

/** 按行序列出样本;可选按签名键 / 状态过滤(签名键用 runtime 的 signatureKey 算,避免口径分叉)。 */
export function listSamples(root: string, opts: SignatureListOptions = {}): SignatureListResult {
  const base = assertRoot(root);
  const projection = loadSignatures(base);
  const wantKey = textOf(opts.signatureKey);
  const wantStatus = textOf(opts.status);
  const samples = projection.samples.filter((sample) => {
    if (wantKey !== undefined && keyOf(sample) !== wantKey) return false;
    if (wantStatus !== undefined && sample.status !== wantStatus) return false;
    return true;
  });
  return {
    ok: true,
    samples,
    codes: [],
    parseErrors: projection.parseErrors,
    totalLines: projection.totalLines,
  };
}

/** 分桶视图 + 总量(非 done 样本一律计入,不剔除)。 */
export function buckets(root: string): SignatureBucketsResult {
  const base = assertRoot(root);
  const projection = loadSignatures(base);
  const bucketMap = rt.buildBuckets(projection.samples);
  const totals: SignatureBucketTotals = {
    samples: 0,
    done: 0,
    failed: 0,
    interrupted: 0,
    cancelled: 0,
  };
  for (const bucket of Object.values(bucketMap)) {
    totals.done += bucket.counts.done;
    totals.failed += bucket.counts.failed;
    totals.interrupted += bucket.counts.interrupted;
    totals.cancelled += bucket.counts.cancelled;
  }
  totals.samples = totals.done + totals.failed + totals.interrupted + totals.cancelled;
  return {
    ok: true,
    buckets: bucketMap,
    totals,
    codes: [],
    parseErrors: projection.parseErrors,
    totalLines: projection.totalLines,
  };
}

/** 一条样本的对比臂:同签名桶 + 同 decision(样本无 decision → 整桶)。 */
function armOf(samples: readonly SignatureSample[], anchor: SignatureSample): SignatureSample[] {
  const anchorKey = keyOf(anchor);
  return samples.filter((sample) => {
    if (keyOf(sample) !== anchorKey) return false;
    if (anchor.decision === undefined) return true;
    return sample.decision === anchor.decision;
  });
}

/**
 * 两条样本的对比:先各自成臂(同桶同 decision),再交给 runtime 评估。
 * id 不存在 → verdict=missing-sample + SIGNATURE_MISSING_SAMPLE(退出码 2 的第三态)。
 */
export function compare(root: string, opts: SignatureCompareOptions): SignatureCompareResult {
  const base = assertRoot(root);
  const aId = textOf(opts?.aId) ?? "";
  const bId = textOf(opts?.bId) ?? "";
  const empty: SignatureCompareResult = {
    ok: false,
    verdict: "missing-sample",
    codes: [],
    deltas: [],
    includesFailures: { a: 0, b: 0 },
    aId,
    bId,
    armSizes: { a: 0, b: 0 },
  };
  if (aId === "" || bId === "") {
    return { ...empty, codes: ["SIGNATURE_INVALID_INPUT"] };
  }
  const projection = loadSignatures(base);
  const sampleA = projection.samples.find((sample) => sample.id === aId);
  const sampleB = projection.samples.find((sample) => sample.id === bId);
  if (sampleA === undefined || sampleB === undefined) {
    return { ...empty, codes: ["SIGNATURE_MISSING_SAMPLE"] };
  }
  const armA = armOf(projection.samples, sampleA);
  const armB = armOf(projection.samples, sampleB);
  const evaluation = rt.evaluateComparison(armA, armB, {
    strict: opts?.strict,
    minPerArm: opts?.minPerArm,
  });
  return {
    ok: evaluation.verdict === "comparable",
    verdict: evaluation.verdict,
    codes: evaluation.codes,
    deltas: evaluation.deltas,
    includesFailures: evaluation.includesFailures,
    aId,
    bId,
    armSizes: { a: armA.length, b: armB.length },
    signatureKeyA: keyOf(sampleA),
    signatureKeyB: keyOf(sampleB),
  };
}

/** 反事实配对(同桶同指标两臂)。 */
export function counterfactuals(
  root: string,
  opts: { minPerArm?: number } = {},
): SignatureCounterfactualsResult {
  const base = assertRoot(root);
  const projection = loadSignatures(base);
  const result = rt.counterfactualPairs(projection.samples, opts);
  return { ok: true, result, codes: result.codes, parseErrors: projection.parseErrors };
}

/**
 * prev = 台账里最近一条 version 行;没有则回退到**样本里的基线版本**。
 * 基线取「样本最多的 (model,provider) 组合」(并列取最早出现的那个),而不是「最后一条样本」:
 * 版本升级后新样本往往排在末尾,拿最后一条当基线会把「刚升到的新版本」认成旧基线,
 * 于是 changed=false、基线重估静默不发生——正是本模块要防的那类假结论。
 */
function prevVersionOf(projection: SignatureProjection): VersionPair | undefined {
  const last = projection.versions[projection.versions.length - 1];
  if (last !== undefined) {
    return { modelVersion: last.modelVersion, providerVersion: last.providerVersion };
  }
  const tally = new Map<string, { pair: VersionPair; count: number; firstAt: number }>();
  for (const sample of projection.samples) {
    const pair: VersionPair = {
      modelVersion: sample.signature.modelVersion,
      providerVersion: sample.signature.providerVersion,
    };
    const key = `${pair.modelVersion}@${pair.providerVersion}`;
    const hit = tally.get(key);
    if (hit === undefined) tally.set(key, { pair, count: 1, firstAt: sample.at });
    else hit.count += 1;
  }
  let best: { pair: VersionPair; count: number; firstAt: number } | undefined;
  for (const item of tally.values()) {
    if (
      best === undefined ||
      item.count > best.count ||
      (item.count === best.count && item.firstAt < best.firstAt)
    ) {
      best = item;
    }
  }
  return best?.pair;
}

/**
 * 版本登记:版本变了 → 追加 baseline(基线须重估)并返回 stale 实验;
 * 无论如何追加一条 version 行(「现在跑在什么版本上」本身就是审计事实)。
 */
export function versionChange(
  root: string,
  opts: SignatureVersionChangeOptions): SignatureVersionChangeStoreResult {
  const base = assertRoot(root);
  const modelVersion = textOf(opts?.modelVersion);
  const providerVersion = textOf(opts?.providerVersion);
  const at = Date.now();
  if (modelVersion === undefined || providerVersion === undefined) {
    return {
      ok: false,
      result: { changed: false, staleExperimentIds: [], codes: ["CONF_INVALID"] },
      appended: { version: false, baseline: false },
      codes: ["SIGNATURE_INVALID_INPUT"],
      parseErrors: 0,
    };
  }
  const projection = loadSignatures(base);
  const next: VersionPair = { modelVersion, providerVersion };
  const prev = prevVersionOf(projection);
  const detection = rt.detectVersionChange({
    // 台账里没有任何历史:这一版就是基线,不算「变了」(否则首次登记就白重估一次)。
    prev: prev ?? next,
    next,
    experiments: opts?.experiments,
  });

  const versionLine: SignatureVersionLine = {
    v: 1,
    type: "version",
    at,
    modelVersion,
    providerVersion,
    changed: detection.changed,
  };
  if (prev !== undefined) versionLine.prev = prev;
  const versionAppended = appendSignatureLine(base, versionLine);
  let baselineAppended = false;
  if (detection.changed) {
    const baselineLine: SignatureBaselineLine = {
      v: 1,
      type: "baseline",
      at,
      modelVersion,
      providerVersion,
      reason: "version-change",
    };
    baselineAppended = appendSignatureLine(base, baselineLine);
  }
  const codes: string[] = [...detection.codes];
  if (!versionAppended || (detection.changed && !baselineAppended)) {
    codes.push("SIGNATURE_LEDGER_WRITE_VERIFY_FAILED");
  }
  const result: SignatureVersionChangeStoreResult = {
    ok: versionAppended && (!detection.changed || baselineAppended),
    result: detection,
    appended: { version: versionAppended, baseline: baselineAppended },
    codes: normalizeCodes(codes),
    parseErrors: projection.parseErrors,
  };
  if (prev !== undefined) result.prev = prev;
  return result;
}

/** 默认版本目标:最近一条 version 行,回退到最后一条样本的签名版本。 */
function targetVersionOf(projection: SignatureProjection): VersionPair {
  return prevVersionOf(projection) ?? { modelVersion: "?", providerVersion: "?" };
}

/** 台账里的样本当成「挂着某签名的实验」用(未显式给 experiments 时的回退)。 */
function experimentsOf(
  projection: SignatureProjection,
  provided?: Array<{ id: string; signature: SituationSignature }>,
): SignatureExperiment[] {
  if (Array.isArray(provided)) {
    const list: SignatureExperiment[] = [];
    for (const item of provided) {
      const id = isRecord(item) ? textOf(item["id"]) : undefined;
      if (id === undefined) continue;
      // 签名原样透传:无法核验的签名由 runtime 判 stale(它不是「不存在」,而是「不能证明仍有效」)。
      list.push({ id, signature: (item as { signature: SituationSignature }).signature });
    }
    return list;
  }
  const seen = new Set<string>();
  const list: SignatureExperiment[] = [];
  for (const sample of projection.samples) {
    if (seen.has(sample.id)) continue;
    seen.add(sample.id);
    list.push({ id: sample.id, signature: sample.signature });
  }
  return list;
}

/** 把实验按目标版本切成 stale / active。 */
export function markStale(
  root: string,
  target: SignatureMarkStaleOptions = {},
): SignatureMarkStaleStoreResult {
  const base = assertRoot(root);
  const projection = loadSignatures(base);
  const fallback = targetVersionOf(projection);
  const goal: VersionPair = {
    modelVersion: textOf(target?.modelVersion) ?? fallback.modelVersion,
    providerVersion: textOf(target?.providerVersion) ?? fallback.providerVersion,
  };
  const experiments = experimentsOf(projection, target?.experiments);
  const result = rt.markStale(experiments, goal);
  return { ok: true, stale: result.stale, active: result.active, codes: [] };
}

/** 混杂因子体检(四项恒在)。 */
export function confounders(root: string): SignatureConfoundersResult {
  const base = assertRoot(root);
  const projection = loadSignatures(base);
  const result = rt.confounders(projection.samples);
  return { ok: true, result, codes: result.codes, parseErrors: projection.parseErrors };
}

/** 幸存者偏差体检(对照集只剩成功样本 → SURVIVOR_BIAS)。 */
export function survivorBias(root: string): SignatureSurvivorBiasResult {
  const base = assertRoot(root);
  const projection = loadSignatures(base);
  const result = rt.survivorBias(projection.samples);
  return { ok: true, result, codes: result.codes, parseErrors: projection.parseErrors };
}

/** 签名报表:桶(计数/均值/决策臂)+ 版本分层 + 混杂/幸存者告警。 */
export function reportSignatures(root: string): SignatureReportResult {
  const base = assertRoot(root);
  const projection = loadSignatures(base);
  const bucketMap = rt.buildBuckets(projection.samples);
  const reportBuckets: SignatureReportBucket[] = [];
  for (const key of Object.keys(bucketMap).sort()) {
    const bucket = bucketMap[key];
    if (bucket === undefined) continue;
    const decisions = Array.from(
      new Set(
        bucket.samples
          .map((sample) => sample.decision)
          .filter((decision): decision is string => decision !== undefined),
      ),
    ).sort();
    reportBuckets.push({
      signatureKey: key,
      counts: {
        done: bucket.counts.done,
        failed: bucket.counts.failed,
        interrupted: bucket.counts.interrupted,
        cancelled: bucket.counts.cancelled,
      },
      mean: mean(bucket.samples.map((sample) => sample.outcome.value)),
      decisions,
    });
  }
  const strata = rt.stratifyByVersion(projection.samples);
  const versions: Record<string, SignatureReportVersionRow> = {};
  for (const [model, stratum] of Object.entries(strata)) {
    versions[model] = {
      providerVersions: stratum.providerVersions,
      mean: stratum.metrics.mean,
      count: stratum.metrics.count,
    };
  }
  const confounderResult = rt.confounders(projection.samples);
  const bias = rt.survivorBias(projection.samples);
  return {
    ok: true,
    version: 1,
    totalLines: projection.totalLines,
    parseErrors: projection.parseErrors,
    samples: projection.samples.length,
    buckets: reportBuckets,
    versions,
    confounders: confounderResult,
    survivorBias: bias,
    codes: normalizeCodes([...confounderResult.codes, ...bias.codes]),
  };
}

/** 形态判定:是不是合法的样本载荷(CLI 用,免得重复实现)。 */
export function isSamplePayload(value: unknown): boolean {
  return rt.coerceSample(value) !== undefined;
}

export type {
  ComparisonResult,
  ConfounderResult,
  CounterfactualResult,
  MarkStaleResult,
  SignatureBucket,
  SignatureExperiment,
  SignatureSample,
  SituationSignature,
  SurvivorBiasResult,
  VersionChangeResult,
  VersionPair,
  VersionStratum,
};
