/**
 * Tool Foundry 持久层(gateway 侧):把 tool-foundry 的纯逻辑落到 append-only jsonl。
 * 为什么 append-only:观察、挖掘、影子评估、注册、下线都是审计事实,后来的判断不能抹掉
 * 「当初为什么这么定」;单行追加也让状态演进可逐行重放。纯逻辑模块本身零 IO、确定性,
 * 持久层只负责「读全量 → 重放成投影 → 基于投影推进一段 → 追加一行」这个闭环。
 * 数据面:`<root>/.genie/rsi/foundry.jsonl`,每行一条
 * - `{v:1, type:"observation", at, observation}` —— 一次模式观察(按 id 去重)。
 * - `{v:1, type:"candidate", at, candidate}` —— 候选整对象快照(同 id 后写覆盖前写,保留插入序)。
 * - `{v:1, type:"shadow", at, op:"start"|"evaluate", id, runs?, successes?, status?}` —— 影子段状态。
 * - `{v:1, type:"registered", at, id, dataToolSpec}` —— 注册成功后的 data 层工具规格。
 * - `{v:1, type:"retired", at, id, reason}` —— 下线留痕(签名不删,再次挖掘走 duplicate-retired)。
 * 投影语义:observation 收进观测列表(按 id 去重);candidate 以 id 建底(后写覆盖);
 * shadow/registered/retired 按行序套用到对应 candidate,目标不存在只计 badLines 跳过;
 * 坏行(JSON 坏 / 缺 v / 未知 type / 缺必需字段)一律计 badLines,绝不让整文件失效、不 throw。
 * 依赖纪律:node:fs / node:path + runtime 的纯逻辑模块;不引 agent loop、不引 gateway 业务模块。
 * runtime 模块按 experiment-store 的既有套路惰性解析(两跳):
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出的 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 参数错误是唯一允许 throw 的情形(TypeError);IO/校验/闸门失败一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FoundryCode, PatternObservation, ToolCandidate } from "@lampgenie/runtime/agent/tool-foundry";

/** 落盘 schema 版本(与 runtime FOUNDRY_VERSION 同源;不一致的行按坏行跳过)。 */
const ROW_VERSION = 1;

type DataToolSpecLike = NonNullable<ToolCandidate["dataToolSpec"]>;
type CandidateStatus = ToolCandidate["status"];

interface FoundryStepResult {
  candidate: ToolCandidate;
  codes: FoundryCode[];
}

interface FoundryDiscard {
  signature: string;
  reason: string;
}

/** runtime tool-foundry 在本文件用到的模块面(与 488 行源文件逐一对齐)。 */
interface FoundryRuntime {
  observe(
    input: unknown,
    ctx?: { id?: string; at?: number },
  ): { ok: boolean; codes: FoundryCode[]; observation?: PatternObservation; reason?: string };
  mineCandidates(
    observations: unknown,
    opts?: {
      minOccurrences?: number;
      minSessions?: number;
      savingsRatio?: number;
      existing?: ToolCandidate[];
      now?: number;
    },
  ): { candidates: ToolCandidate[]; discarded: FoundryDiscard[]; codes: FoundryCode[] };
  startShadow(candidate: ToolCandidate, now?: number): FoundryStepResult;
  evaluateShadow(
    candidate: ToolCandidate,
    input: {
      runs: number;
      successes: number;
      minRuns?: number;
      minSuccessRate?: number;
      now?: number;
    },
  ): FoundryStepResult;
  registerCandidate(
    candidate: ToolCandidate,
    decision: { approved: boolean; now?: number },
  ): FoundryStepResult;
  retireCandidate(candidate: ToolCandidate, decision: { reason: string; now?: number }): FoundryStepResult;
  toDataToolSpec(candidate: ToolCandidate): DataToolSpecLike;
}

let foundryRuntime: FoundryRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadFoundryRuntime(): Promise<FoundryRuntime> {
  if (foundryRuntime) return foundryRuntime;
  const spec = "@lampgenie/runtime/agent/tool-foundry";
  try {
    foundryRuntime = (await import(spec)) as FoundryRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/tool-foundry.ts", import.meta.url).href;
    foundryRuntime = (await import(srcUrl)) as FoundryRuntime;
  }
  return foundryRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadFoundryRuntime();

/** foundry 台账绝对路径:`<root>/.genie/rsi/foundry.jsonl`。 */
export function foundryPath(root: string): string {
  assertRoot(root);
  return join(root, ".genie", "rsi", "foundry.jsonl");
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** root 非字符串/空串 → TypeError(参数错误是唯一允许 throw 的情形)。 */
function assertRoot(root: unknown): asserts root is string {
  if (!nonEmptyString(root)) throw new TypeError("root 必须是非空字符串");
}

/** 可选对象参数:缺省 → undefined;非普通对象 → TypeError。 */
function optionalRecord(value: unknown, name: string): UnknownRecord | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError(`${name} 必须是非普通对象`);
  return value;
}

const STATUSES: ReadonlySet<string> = new Set<string>([
  "candidate",
  "shadow",
  "registered",
  "retired",
  "rejected",
]);

/** 结果类型:业务失败一律 ok:false + codes,稳定码来自 runtime FOUNDRY_CODES。 */
export interface ObserveStoreResult {
  ok: boolean;
  codes: FoundryCode[];
  observation?: PatternObservation;
  reason?: string;
}

export interface MineStoreResult {
  ok: boolean;
  codes: FoundryCode[];
  candidates?: ToolCandidate[];
  discarded?: FoundryDiscard[];
  duplicateSignatures?: string[];
  reason?: string;
}

export interface CandidateStoreResult {
  ok: boolean;
  codes: FoundryCode[];
  candidate?: ToolCandidate;
  reason?: string;
}

export interface RegisterStoreResult extends CandidateStoreResult {
  dataToolSpec?: DataToolSpecLike;
}

export interface FoundryReport {
  total: number;
  byStatus: Record<string, number>;
  estimatedSavings: { tokens: number; toolCalls: number };
  failureModes: { mode: string; count: number }[];
  observations: number;
  badLines: number;
}

/** 投影结果:观测(按 id 去重)+ 候选(按插入序)+ 坏行计数。 */
export interface FoundryProjection {
  observations: PatternObservation[];
  candidates: ToolCandidate[];
  badLines: number;
}

/** 观测行校验:必需字段缺失/类型不符 → undefined(由调用方计 badLines)。 */
function normalizeObservation(value: unknown): PatternObservation | undefined {
  if (!isRecord(value)) return undefined;
  if (!nonEmptyString(value["id"])) return undefined;
  if (!nonEmptyString(value["signature"])) return undefined;
  if (!nonEmptyString(value["sessionId"])) return undefined;
  if (!nonEmptyString(value["projectId"])) return undefined;
  return value as unknown as PatternObservation;
}

/** 候选行校验:至少要有 id 与合法 status(整对象快照,其余字段信任写入方)。 */
function normalizeCandidate(value: unknown): ToolCandidate | undefined {
  if (!isRecord(value)) return undefined;
  if (!nonEmptyString(value["id"])) return undefined;
  if (typeof value["status"] !== "string" || !STATUSES.has(value["status"])) return undefined;
  if (typeof value["sourceSignature"] !== "string") return undefined;
  return value as unknown as ToolCandidate;
}

/** 读投影:文件不存在 → 空投影(不算坏行)。 */
function loadProjection(root: string): FoundryProjection {
  const path = foundryPath(root);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { observations: [], candidates: [], badLines: 0 };
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const observations: PatternObservation[] = [];
  const observationIds = new Set<string>();
  const byId = new Map<string, ToolCandidate>();
  let badLines = 0;

  for (const raw of lines) {
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      badLines += 1;
      continue;
    }
    if (!isRecord(parsed) || parsed["v"] !== ROW_VERSION) {
      badLines += 1;
      continue;
    }
    const at = parsed["at"];
    if (!isFiniteNumber(at)) {
      badLines += 1;
      continue;
    }
    const type = parsed["type"];
    if (type === "observation") {
      const observation = normalizeObservation(parsed["observation"]);
      if (observation === undefined) {
        badLines += 1;
        continue;
      }
      if (!observationIds.has(observation.id)) {
        observationIds.add(observation.id);
        observations.push(observation);
      }
      continue;
    }
    if (type === "candidate") {
      const candidate = normalizeCandidate(parsed["candidate"]);
      if (candidate === undefined) {
        badLines += 1;
        continue;
      }
      // 后写覆盖前写;Map.set 保留首次插入位置 = 创建序。
      byId.set(candidate.id, candidate);
      continue;
    }
    if (type === "shadow") {
      const id = parsed["id"];
      const op = parsed["op"];
      const target = nonEmptyString(id) ? byId.get(id) : undefined;
      if (target === undefined || (op !== "start" && op !== "evaluate")) {
        badLines += 1;
        continue;
      }
      if (op === "start") {
        byId.set(id as string, { ...target, status: "shadow", shadow: { runs: 0, successes: 0 }, updatedAt: at });
        continue;
      }
      const runs = parsed["runs"];
      const successes = parsed["successes"];
      const status = parsed["status"];
      if (!isFiniteNumber(runs) || !isFiniteNumber(successes)) {
        badLines += 1;
        continue;
      }
      if (typeof status !== "string" || !STATUSES.has(status)) {
        badLines += 1;
        continue;
      }
      const shadow: NonNullable<ToolCandidate["shadow"]> =
        status === "rejected" ? { runs, successes, rejectedAt: at } : { runs, successes };
      byId.set(id as string, { ...target, status: status as CandidateStatus, shadow, updatedAt: at });
      continue;
    }
    if (type === "registered") {
      const id = parsed["id"];
      const spec = parsed["dataToolSpec"];
      const target = nonEmptyString(id) ? byId.get(id) : undefined;
      if (target === undefined || !isRecord(spec)) {
        badLines += 1;
        continue;
      }
      byId.set(id as string, {
        ...target,
        status: "registered",
        dataToolSpec: spec as unknown as DataToolSpecLike,
        updatedAt: at,
      });
      continue;
    }
    if (type === "retired") {
      const id = parsed["id"];
      const reason = parsed["reason"];
      const target = nonEmptyString(id) ? byId.get(id) : undefined;
      if (target === undefined || !nonEmptyString(reason)) {
        badLines += 1;
        continue;
      }
      byId.set(id as string, { ...target, status: "retired", updatedAt: at });
      continue;
    }
    // 未知 type:坏行。
    badLines += 1;
  }

  return { observations, candidates: [...byId.values()], badLines };
}

/** 追加一行(缺目录自动建);写失败返回 false,由调用方折叠成稳定码。 */
function appendRow(root: string, row: UnknownRecord): boolean {
  const path = foundryPath(root);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
  } catch {
    return false;
  }
  return true;
}

function findCandidate(root: string, id: string): ToolCandidate | undefined {
  return loadProjection(root).candidates.find((entry) => entry.id === id);
}

function notFound(reason = "candidate-not-found"): CandidateStoreResult {
  return { ok: false, codes: ["FOUNDRY_INVALID"], reason };
}

/** 观察落盘:先由 runtime 校验/规范化,非法只回码不写行。 */
export function observe(root: string, input: unknown): ObserveStoreResult {
  assertRoot(root);
  const checked = rt.observe(input, { at: Date.now() });
  if (!checked.ok || checked.observation === undefined) {
    return { ok: false, codes: checked.codes, reason: checked.reason ?? "invalid-observation" };
  }
  const observation = checked.observation;
  const written = appendRow(root, { v: ROW_VERSION, type: "observation", at: observation.at, observation });
  if (!written) return { ok: false, codes: ["FOUNDRY_INVALID"], reason: "write-failed" };
  return { ok: true, codes: checked.codes, observation };
}

export interface MineStoreOptions {
  minOccurrences?: number;
  minSessions?: number;
  savingsRatio?: number;
}

/**
 * 挖掘:全量观测 + 既有候选一起判,三道门槛交给 runtime;store 只加两条规则:
 * ① 达标签名已存在 retired 候选 → 整体 DUPLICATE、一行不写(再次挖掘不复活历史签名);
 * ② 已存在非 retired 同签名候选 → already-mined 跳过,不重复追加。
 */
export function mine(root: string, opts?: MineStoreOptions): MineStoreResult {
  assertRoot(root);
  const options = optionalRecord(opts, "opts") ?? {};
  const projection = loadProjection(root);
  const mined = rt.mineCandidates(projection.observations, {
    minOccurrences: options["minOccurrences"] as number | undefined,
    minSessions: options["minSessions"] as number | undefined,
    savingsRatio: options["savingsRatio"] as number | undefined,
    existing: [],
    now: Date.now(),
  });

  const retired = new Set(
    projection.candidates.filter((entry) => entry.status === "retired").map((entry) => entry.sourceSignature),
  );
  const duplicateSignatures = [
    ...new Set(mined.candidates.filter((entry) => retired.has(entry.sourceSignature)).map((e) => e.sourceSignature)),
  ];
  if (duplicateSignatures.length > 0) {
    return { ok: false, codes: ["FOUNDRY_DUPLICATE"], duplicateSignatures, discarded: mined.discarded };
  }

  const known = new Set(projection.candidates.map((entry) => entry.sourceSignature));
  const discarded: FoundryDiscard[] = [...mined.discarded];
  const fresh: ToolCandidate[] = [];
  for (const candidate of mined.candidates) {
    if (known.has(candidate.sourceSignature)) {
      discarded.push({ signature: candidate.sourceSignature, reason: "already-mined" });
      continue;
    }
    fresh.push(candidate);
  }

  for (const candidate of fresh) {
    const written = appendRow(root, { v: ROW_VERSION, type: "candidate", at: candidate.createdAt, candidate });
    if (!written) return { ok: false, codes: ["FOUNDRY_INVALID"], reason: "write-failed" };
  }

  return {
    ok: true,
    codes: [fresh.length > 0 ? "FOUNDRY_CANDIDATE" : "FOUNDRY_NO_CANDIDATE"],
    candidates: fresh,
    discarded,
    duplicateSignatures: [],
  };
}

/** 列出候选(投影后按创建序;可按 status 过滤)。 */
export function listCandidates(root: string, filter?: { status?: CandidateStatus }): ToolCandidate[] {
  assertRoot(root);
  const options = optionalRecord(filter, "filter");
  const status = options?.["status"];
  const candidates = loadProjection(root).candidates;
  if (status === undefined) return candidates;
  return candidates.filter((entry) => entry.status === status);
}

/** 进影子:候选不存在 → not-found;成功后追加 op:"start" 行。 */
export function startShadow(root: string, id: string): CandidateStoreResult {
  assertRoot(root);
  if (typeof id !== "string") throw new TypeError("id 必须是非空字符串");
  const candidate = findCandidate(root, id);
  if (candidate === undefined) return notFound();
  const at = Date.now();
  const result = rt.startShadow(candidate, at);
  if (!result.codes.includes("FOUNDRY_SHADOW_STARTED")) {
    return { ok: false, codes: result.codes, candidate: result.candidate, reason: "shadow-not-started" };
  }
  const written = appendRow(root, { v: ROW_VERSION, type: "shadow", at, op: "start", id });
  if (!written) return { ok: false, codes: ["FOUNDRY_INVALID"], reason: "write-failed" };
  return { ok: true, codes: result.codes, candidate: result.candidate };
}

export interface EvaluateShadowStoreInput {
  runs: number;
  successes: number;
  minRuns?: number;
  minSuccessRate?: number;
}

/**
 * 影子评估:非 INVALID 的结论(含 LOW_REUSE / SHADOW_FAIL)都要落行留痕,
 * 只有 SHADOW_PASS 回 ok:true;样本不足/成功率不足按原码回 ok:false。
 */
export function evaluateShadow(root: string, id: string, input: EvaluateShadowStoreInput): CandidateStoreResult {
  assertRoot(root);
  if (typeof id !== "string") throw new TypeError("id 必须是非空字符串");
  const options = optionalRecord(input, "input");
  if (options === undefined) throw new TypeError("input 必须是普通对象");
  const candidate = findCandidate(root, id);
  if (candidate === undefined) return notFound();

  const at = Date.now();
  const result = rt.evaluateShadow(candidate, {
    runs: options["runs"] as number,
    successes: options["successes"] as number,
    minRuns: options["minRuns"] as number | undefined,
    minSuccessRate: options["minSuccessRate"] as number | undefined,
    now: at,
  });
  if (result.codes.includes("FOUNDRY_INVALID")) {
    return { ok: false, codes: result.codes, candidate, reason: "invalid-evaluation" };
  }
  const shadow = result.candidate.shadow;
  const written = appendRow(root, {
    v: ROW_VERSION,
    type: "shadow",
    at,
    op: "evaluate",
    id,
    runs: shadow?.runs ?? 0,
    successes: shadow?.successes ?? 0,
    status: result.candidate.status,
  });
  if (!written) return { ok: false, codes: ["FOUNDRY_INVALID"], reason: "write-failed" };
  return { ok: result.codes.includes("FOUNDRY_SHADOW_PASS"), codes: result.codes, candidate: result.candidate };
}

/** 注册:硬要求人工 approved;成功追加 registered 行(id + dataToolSpec)。 */
export function register(root: string, id: string, opts: { approved: boolean }): RegisterStoreResult {
  assertRoot(root);
  if (typeof id !== "string") throw new TypeError("id 必须是非空字符串");
  const options = optionalRecord(opts, "opts");
  if (options === undefined) throw new TypeError("opts 必须是普通对象");
  const candidate = findCandidate(root, id);
  if (candidate === undefined) return notFound();

  const at = Date.now();
  const result = rt.registerCandidate(candidate, { approved: options["approved"] === true, now: at });
  if (!result.codes.includes("FOUNDRY_REGISTERED")) {
    return { ok: false, codes: result.codes, candidate: result.candidate, reason: "not-registered" };
  }
  const dataToolSpec = result.candidate.dataToolSpec ?? rt.toDataToolSpec(result.candidate);
  const written = appendRow(root, { v: ROW_VERSION, type: "registered", at, id, dataToolSpec });
  if (!written) return { ok: false, codes: ["FOUNDRY_INVALID"], reason: "write-failed" };
  return { ok: true, codes: result.codes, candidate: result.candidate, dataToolSpec };
}

/** 下线:reason 必填;已 retired → DUPLICATE;成功追加 retired 行。 */
export function retire(root: string, id: string, opts: { reason: string }): CandidateStoreResult {
  assertRoot(root);
  if (typeof id !== "string") throw new TypeError("id 必须是非空字符串");
  const options = optionalRecord(opts, "opts");
  if (options === undefined) throw new TypeError("opts 必须是普通对象");
  const candidate = findCandidate(root, id);
  if (candidate === undefined) return notFound();

  const at = Date.now();
  const reason = options["reason"];
  const result = rt.retireCandidate(candidate, { reason: reason as string, now: at });
  if (!result.codes.includes("FOUNDRY_RETIRED")) {
    return { ok: false, codes: result.codes, candidate: result.candidate, reason: "not-retired" };
  }
  const written = appendRow(root, { v: ROW_VERSION, type: "retired", at, id, reason: reason as string });
  if (!written) return { ok: false, codes: ["FOUNDRY_INVALID"], reason: "write-failed" };
  return { ok: true, codes: result.codes, candidate: result.candidate };
}

/**
 * 汇总:状态分布 + 总节省(剔除 retired/rejected,不下线的才谈收益)+ 失败模式按候选数降序。
 * failureModes 统计所有候选(含已下线,历史失败不算抹掉);坏行数如实透出便于排障。
 */
export function report(root: string): FoundryReport {
  assertRoot(root);
  const projection = loadProjection(root);
  const byStatus: Record<string, number> = {};
  const modeCounts = new Map<string, number>();
  const estimatedSavings = { tokens: 0, toolCalls: 0 };

  for (const candidate of projection.candidates) {
    byStatus[candidate.status] = (byStatus[candidate.status] ?? 0) + 1;
    if (candidate.status !== "retired" && candidate.status !== "rejected") {
      estimatedSavings.tokens += isFiniteNumber(candidate.estimatedSavings?.tokens)
        ? candidate.estimatedSavings.tokens
        : 0;
      estimatedSavings.toolCalls += isFiniteNumber(candidate.estimatedSavings?.toolCalls)
        ? candidate.estimatedSavings.toolCalls
        : 0;
    }
    for (const mode of new Set(Array.isArray(candidate.failureModes) ? candidate.failureModes : [])) {
      if (typeof mode !== "string") continue;
      modeCounts.set(mode, (modeCounts.get(mode) ?? 0) + 1);
    }
  }

  const failureModes = [...modeCounts.entries()]
    .map(([mode, count]) => ({ mode, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.mode < b.mode ? -1 : 1));

  return {
    total: projection.candidates.length,
    byStatus,
    estimatedSavings,
    failureModes,
    observations: projection.observations.length,
    badLines: projection.badLines,
  };
}
