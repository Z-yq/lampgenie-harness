/**
 * RSI 熔断台账持久层(生产侧,RSI 熔断 2026-11):把 rsi-circuit-breaker 的纯逻辑落到 append-only jsonl。
 * 为什么 append-only:暂停/恢复/评测/基线/回滚都是审计事实,不能被后来的写入覆盖或抹掉;
 * 单行追加 + 写后行数校验(重读文件统计非空行数)让「写成功了吗」变成可复核的断言,
 * 而不是信任 appendFileSync 没抛异常。
 * 数据面:`<root>/.genie/rsi/breaker.jsonl`,每行一条 `{"v":1,"type":...,"at":ISO,...}`
 * - `pause{by,reason,scope,trigger}` / `resume{by,reason,kind}` —— 熔断开关状态折叠。
 * - `evaluate{shouldPause,trigger?,codes,streak,breaches}` —— 一次评测的结论(预览不落盘)。
 * - `baseline{snapshot}` —— 基线快照(同 id 不重复落盘)。
 * - `rollback-planned{targetId,steps,requeueExperiments}` / `rollback-applied{targetId}` —— 回滚动作。
 * 投影语义(loadBreakerProjection):
 * - state = pause/resume 按行序折叠(latest wins);空态 `{paused:false,scope:"all"}`;
 *   evaluate 行只更新 lastEvaluation,不改 paused。
 * - baselines 按行序(同 id 只留首次);history 是每行的事件摘要;rollbacksApplied 是已应用目标。
 * - 坏行(JSON 坏 / 未知 v / 未知 type / 缺 at)只计入 badLines 并跳过:一行坏不整文件失效、不 throw。
 * 依赖纪律:node:fs / node:path + runtime 纯逻辑(两跳惰性解析)+ 只读复用 experiment-store 的
 * listExperiments(不重复实现实验投影)。参数错误是唯一允许 throw 的情形(TypeError);
 * IO/投影/闸门失败一律折叠成稳定码返回。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BaselineSnapshot,
  BreakerEvaluation,
  BreakerPolicy,
  BreakerScope,
  BreakerState,
  BreakerTrigger,
  ExperimentOutcome,
  RollbackPlan,
  RollbackStep,
} from "@lampgenie/runtime/agent/rsi-circuit-breaker";

/**
 * 只读复用 experiment-store 的 listExperiments。
 * 用 `.ts` 显式后缀的惰性 import:静态无后缀 import 在 `node --experimental-strip-types`
 * 下会 ERR_MODULE_NOT_FOUND(CLI 入口要能直接跑),而 tsc 的 Bundler 解析允许动态 URL 面。
 */
type ExperimentStoreModule = { listExperiments: typeof import("./experiment-store").listExperiments };
let experimentStoreModule: ExperimentStoreModule | undefined;

async function loadExperimentStore(): Promise<ExperimentStoreModule> {
  if (experimentStoreModule) return experimentStoreModule;
  const srcUrl = new URL("./experiment-store.ts", import.meta.url).href;
  experimentStoreModule = (await import(srcUrl)) as ExperimentStoreModule;
  return experimentStoreModule;
}

/** 熔断台账稳定码:store 层自产的失败码(闸门码沿用 runtime 的 RSI_CODES)。 */
export const RSI_STORE_CODES = [
  "RSI_BASELINE_DUPLICATE",
  "RSI_BASELINE_MISSING",
  "RSI_ROLLBACK_ALREADY_APPLIED",
  "RSI_LEDGER_WRITE_MISMATCH",
  "RSI_STORE_ERROR",
] as const;

export type RsiStoreCode = (typeof RSI_STORE_CODES)[number];

/** 台账行类型(只增不改)。 */
export const RSI_LINE_TYPES = [
  "pause",
  "resume",
  "evaluate",
  "baseline",
  "rollback-planned",
  "rollback-applied",
] as const;

export type RsiLineType = (typeof RSI_LINE_TYPES)[number];

/** 台账路径(目录 + 文件各一份,便于上层建目录/守护)。 */
export interface RsiBreakerPaths {
  dir: string;
  file: string;
}

/** 一次评测的结论(与纯逻辑 evaluateBreaker 的返回同形,直接用 runtime 类型)。 */

/** 回滚计划(与纯逻辑 planRollback 的返回同形,直接用 runtime 类型)。 */

/** 回滚计划行(投影用)。 */
export interface RollbackPlanRecord {
  targetId: string;
  at: string;
  steps: unknown[];
  requeueExperiments: string[];
}

/** 历史事件摘要。 */
export interface BreakerHistoryEntry {
  type: string;
  at: string;
  summary?: string;
}

/** 投影结果:可复核的熔断视图。 */
export interface BreakerProjection {
  state: BreakerState;
  baselines: BaselineSnapshot[];
  history: BreakerHistoryEntry[];
  badLines: number;
  totalLines: number;
  rollbackPlans: RollbackPlanRecord[];
  rollbacksApplied: string[];
}

/** runtime rsi-circuit-breaker 在本文件用到的模块面(纯函数出口)。 */
interface RsiRuntime {
  readonly RSI_BREAKER_VERSION: number;
  evaluateBreaker(
    input: { outcomes: ExperimentOutcome[]; guardMetrics?: Record<string, number> },
    policy?: Partial<BreakerPolicy>,
  ): BreakerEvaluation;
  pause(
    state: BreakerState,
    opts: { by: string; reason: string; scope?: BreakerScope; trigger?: BreakerTrigger; at?: string },
  ): { ok: true; state: BreakerState } | { ok: false; codes: string[] };
  resume(
    state: BreakerState,
    opts: { by: string; kind: "human" | "agent"; reason: string; at?: string },
  ): { ok: true; state: BreakerState } | { ok: false; codes: string[] };
  isBlocked(state: BreakerState, action: "nightly" | "experiment" | "injection" | "observe"): boolean;
  takeBaseline(input: {
    id: string;
    at?: string;
    label?: string;
    versions: BaselineSnapshot["versions"];
    metrics?: Record<string, number>;
  }): BaselineSnapshot;
  planRollback(
    target: BaselineSnapshot | undefined | null,
    current: BaselineSnapshot,
    opts?: { affectedExperiments?: string[] },
  ): RollbackPlan;
  verifyRollback(current: BaselineSnapshot, target: BaselineSnapshot): { ok: boolean; codes: string[] };
 /** §14.2③ 观察窗自动试探重启(确定性:连续正收益窗才放行;agent 不能伪造窗口,窗口由 store 从账本算)。 */
  evaluateObservationRestart(
    windows: Array<{ startAt: number; endAt: number; netSaving: number }>,
    policy?: { minPositiveWindows?: number },
  ): { restart: boolean; positiveWindows: number };
}

/** runtime 面:静态导入(批量,exit 13 坑防第六犯;bundle 内联零成本)。 */
import * as rt_rsi_circuit_breaker from "@lampgenie/runtime/agent/rsi-circuit-breaker";

const rt: RsiRuntime = rt_rsi_circuit_breaker;

/** 台账 schema 版本(与 runtime 同源)。 */
const SCHEMA_VERSION = rt.RSI_BREAKER_VERSION;

const KNOWN_TYPES: ReadonlySet<string> = new Set<string>(RSI_LINE_TYPES);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 非空字符串(去空白后仍非空)。 */
function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 参数错误校验(唯一允许 throw 的情形)。 */
function assertRoot(fn: string, root: unknown): string {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError(`${fn}: root 必须是非空字符串`);
  return root;
}

/** 熔断台账路径:`<root>/.genie/rsi/breaker.jsonl`。 */
export function breakerPaths(root: string): RsiBreakerPaths {
  const base = assertRoot("breakerPaths", root);
  const dir = join(base, ".genie", "rsi");
  return { dir, file: join(dir, "breaker.jsonl") };
}

/**
 * 启动初始化——台账缺失时建**空**台账。
 * 空文件是「无 pause/resume 事件」的显式事实(如实 closed),不再让体检区报「熔断台账缺失(按未熔断处理)」。
 * 已存在返回 false(不动既有内容)。
 */
export function ensureBreakerLedger(root: string): boolean {
  const { dir, file } = breakerPaths(root);
  if (existsSync(file)) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, "", "utf8");
  return true;
}

/** 时间戳(入参缺省 → 当前 ISO)。 */
function atOf(at?: unknown): string {
  const given = nonEmpty(at);
  return given ?? new Date().toISOString();
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
 * 校验失败返回 false(调用方折叠成 RSI_LEDGER_WRITE_MISMATCH);不回滚已写内容、不 throw。
 */
function appendLine(root: string, line: UnknownRecord): boolean {
  const { file } = breakerPaths(root);
  const before = countLines(file);
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    return false;
  }
  return countLines(file) === before + 1;
}

/** 写盘失败的标准返回(codes 只带一个码)。 */
function writeFailed(): string[] {
  return ["RSI_LEDGER_WRITE_MISMATCH"];
}

/** 事件摘要(history 用;不影响 state 折叠)。 */
function summarize(type: string, row: UnknownRecord): string | undefined {
  switch (type) {
    case "pause": {
      const by = nonEmpty(row["by"]) ?? "unknown";
      const reason = typeof row["reason"] === "string" ? row["reason"] : "";
      const scope = nonEmpty(row["scope"]) ?? "all";
      return `paused by ${by} (${scope}): ${reason}`;
    }
    case "resume": {
      const by = nonEmpty(row["by"]) ?? "unknown";
      const kind = nonEmpty(row["kind"]) ?? "unknown";
      const reason = typeof row["reason"] === "string" ? row["reason"] : "";
      return `resumed by ${by} (${kind}): ${reason}`;
    }
    case "evaluate": {
      const codes = Array.isArray(row["codes"]) ? (row["codes"] as unknown[]).map(String).join(",") : "";
      const streak = typeof row["streak"] === "number" ? row["streak"] : 0;
      return `evaluate shouldPause=${row["shouldPause"] === true} streak=${streak} codes=[${codes}]`;
    }
    case "baseline": {
      const snapshot = isRecord(row["snapshot"]) ? row["snapshot"] : undefined;
      return `baseline ${nonEmpty(snapshot?.["id"]) ?? "unknown"}`;
    }
    case "rollback-planned":
      return `rollback-planned ${nonEmpty(row["targetId"]) ?? "unknown"}`;
    case "rollback-applied":
      return `rollback-applied ${nonEmpty(row["targetId"]) ?? "unknown"}`;
    default:
      return undefined;
  }
}

/** pause 行折叠成新 state(纯逻辑被拒的行不会写盘,这里只做确定性折叠)。 */
function foldPause(state: BreakerState, row: UnknownRecord, at: string): BreakerState {
  const next: BreakerState = {
    paused: true,
    pausedAt: at,
    scope: (nonEmpty(row["scope"]) ?? "all") as BreakerScope,
  };
  const reason = nonEmpty(row["reason"]);
  if (reason !== undefined) next.reason = reason;
  const trigger = nonEmpty(row["trigger"]);
  if (trigger !== undefined) next.trigger = trigger as BreakerTrigger;
  const by = nonEmpty(row["by"]);
  if (by !== undefined) next.by = by;
  if (state.lastEvaluation !== undefined) next.lastEvaluation = state.lastEvaluation;
  return next;
}

/**
 * 投影:pause/resume 按行序折叠 state;baseline 同 id 只留首个;rollback-planned/applied 各自聚合。
 * 坏行只计 badLines,绝不让整文件失效、不 throw。
 */
export function loadBreakerProjection(root: string): BreakerProjection {
  const base = assertRoot("loadBreakerProjection", root);
  const { file } = breakerPaths(base);
  const empty: BreakerState = { paused: false, scope: "all" };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {
      state: empty,
      baselines: [],
      history: [],
      badLines: 0,
      totalLines: 0,
      rollbackPlans: [],
      rollbacksApplied: [],
    };
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let state: BreakerState = empty;
  const baselines: BaselineSnapshot[] = [];
  const baselineIds = new Set<string>();
  const history: BreakerHistoryEntry[] = [];
  const rollbackPlans: RollbackPlanRecord[] = [];
  const rollbacksApplied: string[] = [];
  let badLines = 0;
  let totalLines = 0;

  for (const raw of lines) {
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
    const type = parsed["type"];
    const at = nonEmpty(parsed["at"]);
    if (typeof type !== "string" || !KNOWN_TYPES.has(type) || at === undefined) {
      badLines += 1;
      continue;
    }

    if (type === "pause") {
      state = foldPause(state, parsed, at);
    } else if (type === "resume") {
      const next: BreakerState = { paused: false, scope: state.scope, recoveredAt: at };
      const by = nonEmpty(parsed["by"]);
      if (by !== undefined) next.by = by;
      const reason = nonEmpty(parsed["reason"]);
      if (reason !== undefined) next.reason = reason;
      if (state.lastEvaluation !== undefined) next.lastEvaluation = state.lastEvaluation;
      state = next;
    } else if (type === "evaluate") {
      const evaluation = {
        at,
        shouldPause: parsed["shouldPause"] === true,
        codes: Array.isArray(parsed["codes"]) ? (parsed["codes"] as unknown[]).map(String) : [],
        streak: typeof parsed["streak"] === "number" ? (parsed["streak"] as number) : 0,
        trigger: nonEmpty(parsed["trigger"]),
      };
      state = { ...state, lastEvaluation: evaluation as unknown as BreakerState["lastEvaluation"] };
    } else if (type === "baseline") {
      const snapshot = parsed["snapshot"];
      if (!isRecord(snapshot) || nonEmpty(snapshot["id"]) === undefined) {
        badLines += 1;
        continue;
      }
      const id = nonEmpty(snapshot["id"]) as string;
      if (baselineIds.has(id)) continue;
      baselineIds.add(id);
      baselines.push(snapshot as unknown as BaselineSnapshot);
      history.push({ type, at, summary: summarize(type, parsed) ?? `baseline ${id}` });
      continue; // baseline 不影响 state
    } else if (type === "rollback-planned") {
      const targetId = nonEmpty(parsed["targetId"]);
      if (targetId === undefined) {
        badLines += 1;
        continue;
      }
      rollbackPlans.push({
        targetId,
        at,
        steps: Array.isArray(parsed["steps"]) ? (parsed["steps"] as unknown[]) : [],
        requeueExperiments: Array.isArray(parsed["requeueExperiments"])
          ? (parsed["requeueExperiments"] as unknown[]).map(String)
          : [],
      });
    } else if (type === "rollback-applied") {
      const targetId = nonEmpty(parsed["targetId"]);
      if (targetId === undefined) {
        badLines += 1;
        continue;
      }
      if (!rollbacksApplied.includes(targetId)) rollbacksApplied.push(targetId);
    }

    const summary = summarize(type, parsed);
    history.push(summary === undefined ? { type, at } : { type, at, summary });
  }

  return { state, baselines, history, badLines, totalLines, rollbackPlans, rollbacksApplied };
}

/** 当前熔断状态(空仓 → `{paused:false,scope:"all"}`)。 */
export async function getState(root: string): Promise<BreakerState> {
  return loadBreakerProjection(assertRoot("getState", root)).state;
}

/** 暂停(人工/自动)。纯逻辑拒绝 → ok:false 且不落盘,state 原样。 */
export async function pause(
  root: string,
  opts: { by: string; reason: string; scope?: BreakerScope; trigger?: BreakerTrigger; at?: string },
): Promise<{ ok: boolean; codes: string[]; state: BreakerState }> {
  const base = assertRoot("pause", root);
  if (!isRecord(opts)) throw new TypeError("pause: opts 必须是对象");
  // by/reason 为空不 throw:交给纯逻辑拒(RSI_RESUME_REASON_REQUIRED),被拒即不落盘、state 原样。
  const by = typeof opts.by === "string" ? opts.by : "";
  const reason = typeof opts.reason === "string" ? opts.reason : "";
  const at = atOf(opts.at);
  const current = loadBreakerProjection(base).state;

  let result: { ok: boolean; codes?: string[]; state?: BreakerState };
  try {
    result = rt.pause(current, { by, reason, scope: opts.scope, trigger: opts.trigger, at });
  } catch {
    return { ok: false, codes: ["RSI_STORE_ERROR"], state: current };
  }
  if (result.ok !== true) return { ok: false, codes: result.codes ?? [], state: current };

  const next = result.state ?? current;
  const line: UnknownRecord = { v: SCHEMA_VERSION, type: "pause", at, by, reason };
  const scope = opts.scope ?? next.scope;
  if (scope !== undefined) line["scope"] = scope;
  const trigger = opts.trigger ?? next.trigger;
  if (trigger !== undefined) line["trigger"] = trigger;
  if (!appendLine(base, line)) return { ok: false, codes: writeFailed(), state: current };
  return { ok: true, codes: [], state: loadBreakerProjection(base).state };
}

/** 恢复(人工/agent)。agent 恢复被拒 → ok:false 且不落盘,state 原样。 */
export async function resume(
  root: string,
  opts: { by: string; kind: "human" | "agent"; reason: string; at?: string },
): Promise<{ ok: boolean; codes: string[]; state: BreakerState }> {
  const base = assertRoot("resume", root);
  if (!isRecord(opts)) throw new TypeError("resume: opts 必须是对象");
  // by/reason/kind 非法不 throw:由纯逻辑拒(RSI_RESUME_NOT_HUMAN / RSI_RESUME_REASON_REQUIRED),不落盘。
  const by = typeof opts.by === "string" ? opts.by : "";
  const reason = typeof opts.reason === "string" ? opts.reason : "";
  const at = atOf(opts.at);
  const current = loadBreakerProjection(base).state;

  let result: { ok: boolean; codes?: string[]; state?: BreakerState };
  try {
    result = rt.resume(current, { by, kind: opts.kind, reason, at });
  } catch {
    return { ok: false, codes: ["RSI_STORE_ERROR"], state: current };
  }
  if (result.ok !== true) return { ok: false, codes: result.codes ?? [], state: current };

  const line: UnknownRecord = { v: SCHEMA_VERSION, type: "resume", at, by, reason, kind: opts.kind };
  if (!appendLine(base, line)) return { ok: false, codes: writeFailed(), state: current };
  return { ok: true, codes: [], state: loadBreakerProjection(base).state };
}

/**
 * 评测并(可选)落盘。
 * - apply !== true → 完全不写盘,返回 applied:false 的预览。
 * - apply === true → 先落 evaluate 行;shouldPause 时再落 pause 行(by:"auto")。
 */
export async function evaluateAndApply(
  root: string,
  input: {
    outcomes: ExperimentOutcome[];
    guardMetrics?: Record<string, number>;
    policy?: Partial<BreakerPolicy>;
    apply?: boolean;
  },
): Promise<{ ok: boolean; applied: boolean; codes: string[]; evaluation: BreakerEvaluation; state: BreakerState }> {
  const base = assertRoot("evaluateAndApply", root);
  if (!isRecord(input)) throw new TypeError("evaluateAndApply: input 必须是对象");
  if (!Array.isArray(input.outcomes)) throw new TypeError("evaluateAndApply: outcomes 必须是数组");
  const current = loadBreakerProjection(base).state;

  let evaluation: BreakerEvaluation;
  try {
    evaluation = rt.evaluateBreaker({ outcomes: input.outcomes, guardMetrics: input.guardMetrics }, input.policy);
  } catch {
    return { ok: false, applied: false, codes: ["RSI_STORE_ERROR"], evaluation: emptyEvaluation(), state: current };
  }
  const codes = Array.isArray(evaluation.codes) ? evaluation.codes : [];
  if (input.apply !== true) {
    return { ok: true, applied: false, codes, evaluation, state: current };
  }

  const at = new Date().toISOString();
  const evalLine: UnknownRecord = {
    v: SCHEMA_VERSION,
    type: "evaluate",
    at,
    shouldPause: evaluation.shouldPause === true,
    codes,
    streak: evaluation.streak,
    breaches: evaluation.breaches,
  };
  if (evaluation.trigger !== undefined) evalLine["trigger"] = evaluation.trigger;
  if (!appendLine(base, evalLine)) {
    return { ok: false, applied: false, codes: writeFailed(), evaluation, state: current };
  }

  if (evaluation.shouldPause === true) {
    const pauseLine: UnknownRecord = {
      v: SCHEMA_VERSION,
      type: "pause",
      at,
      by: "auto",
      reason: `auto-pause: codes=[${codes.join(",")}] streak=${evaluation.streak}`,
      scope: evaluation.scope,
    };
    if (evaluation.trigger !== undefined) pauseLine["trigger"] = evaluation.trigger;
    if (!appendLine(base, pauseLine)) {
      return { ok: false, applied: true, codes: writeFailed(), evaluation, state: loadBreakerProjection(base).state };
    }
  }

  return { ok: true, applied: true, codes, evaluation, state: loadBreakerProjection(base).state };
}

/** 空评测(纯逻辑异常时的占位,不影响调用方判 ok:false)。 */
function emptyEvaluation(): BreakerEvaluation {
  return { shouldPause: false, scope: "all", codes: [], streak: 0, breaches: [] };
}

/** 拍基线。同 id 已存在 → RSI_BASELINE_DUPLICATE,不落盘。 */
export async function takeBaseline(
  root: string,
  input: {
    id: string;
    at?: string;
    label?: string;
    versions: BaselineSnapshot["versions"];
    metrics?: Record<string, number>;
  },
): Promise<{ ok: boolean; codes: string[]; snapshot?: BaselineSnapshot }> {
  const base = assertRoot("takeBaseline", root);
  if (!isRecord(input)) throw new TypeError("takeBaseline: input 必须是对象");
  const id = nonEmpty(input.id);
  if (id === undefined) throw new TypeError("takeBaseline: id 不能为空");
  if (!isRecord(input.versions)) throw new TypeError("takeBaseline: versions 必须是对象");
  const at = atOf(input.at);

  if (loadBreakerProjection(base).baselines.some((b) => b.id === id)) {
    return { ok: false, codes: ["RSI_BASELINE_DUPLICATE"] };
  }

  let snapshot: BaselineSnapshot;
  try {
    snapshot = rt.takeBaseline({
      id,
      at,
      label: input.label,
      versions: input.versions,
      metrics: input.metrics ?? {},
    });
  } catch {
    return { ok: false, codes: ["RSI_STORE_ERROR"] };
  }
  const line: UnknownRecord = { v: SCHEMA_VERSION, type: "baseline", at, snapshot };
  if (!appendLine(base, line)) return { ok: false, codes: writeFailed() };
  return { ok: true, codes: [], snapshot };
}

/** 全部基线(发生顺序,同 id 只留首次)。 */
export async function listBaselines(root: string): Promise<BaselineSnapshot[]> {
  return loadBreakerProjection(assertRoot("listBaselines", root)).baselines;
}

/** 按 id 取基线。 */
export async function getBaseline(root: string, id: string): Promise<BaselineSnapshot | undefined> {
  const base = assertRoot("getBaseline", root);
  return loadBreakerProjection(base).baselines.find((b) => b.id === id);
}

/** 规划回滚:目标不存在 → RSI_BASELINE_MISSING(不落盘);否则落 rollback-planned 行。 */
export async function planRollback(
  root: string,
  targetId: string,
  opts?: { affectedExperiments?: string[] },
): Promise<{ ok: boolean; codes: string[]; plan?: RollbackPlan }> {
  const base = assertRoot("planRollback", root);
  const id = nonEmpty(targetId);
  if (id === undefined) throw new TypeError("planRollback: targetId 不能为空");

  const projection = loadBreakerProjection(base);
  const target = projection.baselines.find((b) => b.id === id);
  if (target === undefined) return { ok: false, codes: ["RSI_BASELINE_MISSING"] };
  const latest = projection.baselines.length > 0 ? projection.baselines[projection.baselines.length - 1] : undefined;
  const current = latest ?? target;

  let plan: RollbackPlan;
  try {
    plan = rt.planRollback(target, current, { affectedExperiments: opts?.affectedExperiments });
  } catch {
    return { ok: false, codes: ["RSI_STORE_ERROR"] };
  }
  const codes = Array.isArray(plan.codes) ? plan.codes : [];
  if (plan.ok !== true) return { ok: false, codes };

  const at = new Date().toISOString();
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const requeue = Array.isArray(plan.requeueExperiments) ? plan.requeueExperiments.map(String) : [];
  const line: UnknownRecord = {
    v: SCHEMA_VERSION,
    type: "rollback-planned",
    at,
    targetId: id,
    steps,
    requeueExperiments: requeue,
  };
  if (!appendLine(base, line)) return { ok: false, codes: writeFailed() };
  return { ok: true, codes, plan: { ...plan, codes, steps, requeueExperiments: requeue } };
}

/** 标记回滚已应用:目标不存在 → RSI_BASELINE_MISSING;已标记过 → RSI_ROLLBACK_ALREADY_APPLIED。 */
export async function markRollbackApplied(
  root: string,
  targetId: string,
): Promise<{ ok: boolean; codes: string[] }> {
  const base = assertRoot("markRollbackApplied", root);
  const id = nonEmpty(targetId);
  if (id === undefined) throw new TypeError("markRollbackApplied: targetId 不能为空");

  const projection = loadBreakerProjection(base);
  const known =
    projection.baselines.some((b) => b.id === id) || projection.rollbackPlans.some((p) => p.targetId === id);
  if (!known) return { ok: false, codes: ["RSI_BASELINE_MISSING"] };
  if (projection.rollbacksApplied.includes(id)) return { ok: false, codes: ["RSI_ROLLBACK_ALREADY_APPLIED"] };

  const line: UnknownRecord = {
    v: SCHEMA_VERSION,
    type: "rollback-applied",
    at: new Date().toISOString(),
    targetId: id,
  };
  if (!appendLine(base, line)) return { ok: false, codes: writeFailed() };
  return { ok: true, codes: [] };
}

/** 熔断汇总报告:state + 基线 + 事件摘要 + 坏行数 + 已应用回滚目标。 */
export async function reportBreaker(root: string): Promise<{
  state: BreakerState;
  baselines: BaselineSnapshot[];
  history: BreakerHistoryEntry[];
  badLines: number;
  rollbacksApplied: string[];
}> {
  const projection = loadBreakerProjection(assertRoot("reportBreaker", root));
  return {
    state: projection.state,
    baselines: projection.baselines,
    history: projection.history,
    badLines: projection.badLines,
    rollbacksApplied: projection.rollbacksApplied,
  };
}

/** 实验投影 → 熔断输入(复用 experiment-store.listExperiments,不重复实现投射)。 */
export async function outcomesFromExperiments(root: string): Promise<ExperimentOutcome[]> {
  const base = assertRoot("outcomesFromExperiments", root);
  const { listExperiments } = await loadExperimentStore();
  const experiments = listExperiments(base);
  const out: ExperimentOutcome[] = [];
  for (const exp of experiments) {
    const raw = exp.decision?.kind;
    const decision = raw === "adopt" || raw === "reject" || raw === "iterate" || raw === "rollback" ? raw : "pending";
    const metrics: Record<string, number> = {};
    for (const metric of exp.metrics ?? []) {
      const value = metric.result?.value ?? metric.baseline?.value;
      if (typeof value === "number" && Number.isFinite(value)) metrics[metric.name] = value;
    }
    // Experiment 无 netReturn 字段(收益口径在 metrics 里),故 netReturn 留 undefined。
    out.push({
      id: exp.id,
      decision: decision as ExperimentOutcome["decision"],
      metrics: Object.keys(metrics).length > 0 ? metrics : undefined,
    } as ExperimentOutcome);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * §14.2③ 观察窗自动试探重启(消费面接线)
 * 设计原文:「停改进、不停观察」——熔断停摆后观察类动作继续,连续 2 个观察窗 ROI 转正
 * (netSaving>0,严格为正) → 自动重启,频率 ×0.25。两条恢复路径先到先得:人类 resume
 * (rt.resume,不变) 或本函数(确定性窗口闸,不经 rt.resume——runtime 注释明确指路)。
 * ------------------------------------------------------------------ */

/** 观察窗数据源:cost/saving 账本按固定 7 天桶聚合(确定性、可重放;空账 → 无窗口=不放行)。 */
export function observationWindowsFromCostLedgers(
  root: string,
  opts: { now?: number; windowDays?: number; windowCount?: number } = {},
): Array<{ startAt: number; endAt: number; netSaving: number }> {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const days = Number.isFinite(opts.windowDays) && Number(opts.windowDays) > 0 ? Number(opts.windowDays) : 7;
  const count = Number.isFinite(opts.windowCount) && Number(opts.windowCount) > 0 ? Math.floor(Number(opts.windowCount)) : 3;
  const windowMs = days * 24 * 60 * 60 * 1000;
  const currentBucket = Math.floor(now / windowMs);
  const cost = new Map<number, number>();
  const saving = new Map<number, number>();
  const add = (file: string, fn: (bucket: number, row: UnknownRecord) => void) => {
    let text = "";
    try { text = readFileSync(join(root, ".genie", "rsi", file), "utf8"); } catch { return; }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const row = JSON.parse(line) as UnknownRecord;
        if (!isRecord(row)) continue;
        const at = nonEmpty(row["at"]);
        const ts = at === undefined ? NaN : Date.parse(at);
        if (!Number.isFinite(ts)) continue;
        fn(Math.floor(ts / windowMs), row);
      } catch { /* 坏行跳过 */ }
    }
  };
  add("cost.jsonl", (bucket, row) => {
    if (row["type"] !== "cost") return;
    const tokens = isRecord(row["tokens"]) ? row["tokens"] : undefined;
    const total = tokens !== undefined && typeof tokens["total"] === "number" && Number.isFinite(tokens["total"]) ? tokens["total"] : 0;
    cost.set(bucket, (cost.get(bucket) ?? 0) + total);
  });
  add("cost.jsonl", (bucket, row) => {
    if (row["type"] !== "saving") return;
    const saved = typeof row["tokensSaved"] === "number" && Number.isFinite(row["tokensSaved"]) ? row["tokensSaved"] : 0;
    saving.set(bucket, (saving.get(bucket) ?? 0) + saved);
  });
  const windows: Array<{ startAt: number; endAt: number; netSaving: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const bucket = currentBucket - i;
    const startAt = bucket * windowMs;
 // 最新桶的 endAt 用 now(窗未走完,不制造未来时间)。
    const endAt = i === 0 ? now : startAt + windowMs;
    windows.push({ startAt, endAt, netSaving: (saving.get(bucket) ?? 0) - (cost.get(bucket) ?? 0) });
  }
  return windows;
}

/**
 * 观察窗自动试探重启(确定性闸,不经 rt.resume)。
 * - 未暂停 → RSI_BREAKER_NOT_PAUSED(预览语义,不写盘);
 * - evaluateObservationRestart 不放行(窗口不足/非连续正)→ RSI_OBSERVATION_NOT_POSITIVE,不写盘;
 * - 放行 → 追加 resume 行(kind=observation,by=rsi-scheduler),折出 paused=false;
 * 返回 restartFactor(缺省 0.25,调度器据此把 everyMinutes ×4)。
 */
export async function autoResumeFromObservation(
  root: string,
  opts: { windows: Array<{ startAt: number; endAt: number; netSaving: number }>; policy?: { minPositiveWindows?: number; restartFactor?: number }; by?: string; at?: string },
): Promise<{ ok: boolean; codes: string[]; positiveWindows: number; restartFactor?: number; state: BreakerState }> {
  const base = assertRoot("autoResumeFromObservation", root);
  const current = loadBreakerProjection(base).state;
  if (current.paused !== true) {
    return { ok: false, codes: ["RSI_BREAKER_NOT_PAUSED"], positiveWindows: 0, state: current };
  }
  let evaluation: { restart: boolean; positiveWindows: number };
  try {
    evaluation = rt.evaluateObservationRestart(opts.windows, { minPositiveWindows: opts.policy?.minPositiveWindows });
  } catch {
    return { ok: false, codes: ["RSI_STORE_ERROR"], positiveWindows: 0, state: current };
  }
  if (evaluation.restart !== true) {
    return { ok: false, codes: ["RSI_OBSERVATION_NOT_POSITIVE"], positiveWindows: evaluation.positiveWindows, state: current };
  }
  const at = atOf(opts.at);
  const by = nonEmpty(opts.by) ?? "rsi-scheduler";
  const line: UnknownRecord = {
    v: SCHEMA_VERSION,
    type: "resume",
    at,
    by,
    kind: "observation",
    reason: `观察窗自动试探重启:连续 ${evaluation.positiveWindows} 个正收益窗(netSaving>0)`,
  };
  if (!appendLine(base, line)) {
    return { ok: false, codes: writeFailed(), positiveWindows: evaluation.positiveWindows, state: current };
  }
  const state = loadBreakerProjection(base).state;
  const factor = typeof opts.policy?.restartFactor === "number" && opts.policy.restartFactor > 0 && opts.policy.restartFactor <= 1
    ? opts.policy.restartFactor
    : 0.25;
  return { ok: true, codes: [], positiveWindows: evaluation.positiveWindows, restartFactor: factor, state };
}
