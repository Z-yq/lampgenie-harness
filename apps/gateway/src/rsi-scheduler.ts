/**
 * RSI 自转调度器( RSI-SELF-DRIVE;mechanisms.md #190/#192/#198/#200 的运行链)。
 * 要解决的问题:12 个机制此前只能人点「运行」,夜间整合没有定时触发,失败只能人工重派,
 * 成本没有自动记账,ROI 门/熔断器从不参与运行决策——所以「RSI」只是 12 个手动按钮,
 * 不是一个会自转的闭环。
 * 本模块把调度做成**可测的确定性状态机**(与 automations.ts 同哲学:判断纯函数化,IO 只做落盘):
 * - 到点 + 项目空闲 + 无在跑 run → 开一个 cycle,按机制目录顺序**串行**派 agent 任务;
 * - 每个 tick 顺带收尾已到终态的 run(成本/会话认账/预算超限,与 annotate 同一 settleRunRecord);
 * - 失败 run(error=task interrupted)在窗口内自动重派一次(retryCount 上限),不重试用户取消;
 * - 单次运行 token 软预算写进任务书;经验证超限 → 追加 warn 条目并**提前结束本周期**;
 * - 周期结束按真实 usage 记 `cost.jsonl`(mining 阶段),再跑 ROI 门:
 * 连续负收益达阈值 → downshift/pause,熔断暂停后调度器停转(保留观测,恢复需人工);
 * - 熔断暂停等 breaker 状态、欠账信息都落在 `.genie/rsi/scheduler.json`,重启可续。
 * 红线:
 * - 只写 `<root>/.genie/rsi/scheduler.json`;成本/结果/运行记录全走既有 store 的 API。
 * - 除参数错误(root 形状)外不 throw:IO/解析失败折叠成稳定 action/warnings。
 * - 串行:同一时刻最多一个 RSI run(全局单跑在 startMechanismRun 内已有,这里先查再派,减少空转)。
 * - 在线繁忙让路:cycle 开始前检查 idleOnly;已开始的 cycle 不因中途繁忙被腰斩(避免半周期)。
 */
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  RSI_MECHANISM_IDS,
  mechanismSpec,
  type RsiMechanismId,
} from "@lampgenie/runtime/agent/rsi-mechanisms";
import { getState as getBreakerState, pause as pauseBreaker, resume as resumeBreaker } from "./rsi-breaker-store.js";
import { evaluateRoiGate, recordCost, reportCost } from "./rsi-cost-store.js";
import { drainCandidateQueue, settleExperiments } from "./experiment-settler.js"; // #192 周期实验自动结算+候选消费
import { nightlyLockHeld, reclaimNightly, runNightly, startNightly } from "./nightly-store.js"; // P1:code 驱动夜间管线; 加锁互斥+陈旧 run 回收
import { seedTaxonomy } from "./gap-taxonomy-store.js"; // P2:#211 预防件分类账落地
import { fileCycleFindingsToChangeRequests } from "./rsi-findings-bridge.js"; // P1-④:机制发现→提案
import { aggregateWeekly, appendWeeklyEvent, readWeeklyEvents, writeReportFile } from "./rsi-weekly.js"; // 周报进调度器(设计稿§11 P1#1;7 天门防重复)
import {
  getRun,
  listRuns,
  loadMechanisms,
  markRunRetried,
  type RsiRunRecord,
} from "./rsi-mechanism-store.js";
import {
  costUnmeasured,
  ORPHAN_GRACE_MS,
  settleRunRecord,
  startMechanismRun,
  type SettleRunOptions,
  type StartRunDeps,
  type StartRunResult,
} from "./rsi-agent-runner.js";

/** 调度器状态文件(root 相对)。 */
export const RSI_SCHEDULER_REL = ".genie/rsi/scheduler.json";

/** 缺省周期:每天一次。 */
export const RSI_SCHEDULER_DEFAULT_EVERY_MINUTES = 24 * 60;

/** 缺省单次运行 token 软预算(经验证单机制 0.6M~3M;800k 覆盖多数机制,超限即停本周期)。 */
export const RSI_SCHEDULER_DEFAULT_BUDGET = 800_000;

/** 缺省单周期 token 预算(经验证 12 机制周期 12.7M~22.9M;12M 在成本失控前)。 */
export const RSI_SCHEDULER_DEFAULT_CYCLE_BUDGET = 12_000_000;

/** 重试窗口:只重试最近 24h 内被中断的 run(更老的中断不自动烧 token 重跑)。 */
export const RSI_RETRY_WINDOW_MS = 24 * 3600 * 1000;

/** 单个旧 run 的自动重试上限(写在旧记录 retryCount 上,防无限重派)。 */
export const RSI_RETRY_MAX_DEFAULT = 1;

const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set(["done", "failed", "cancelled", "interrupted", "blocked"]);

/** 调度配置(用户可改;0 值语义见各字段注释)。 */
export interface RsiSchedulerConfig {
  enabled: boolean;
 /** 周期间隔(分钟,1~525600)。 */
  everyMinutes: number;
 /** 参与自动周期的机制(空数组=全部「启用且 agent 驱动」的机制)。 */
  mechanisms: RsiMechanismId[];
 /** 只在没有前台任务时启动新周期(已开始的周期不中断)。 */
  idleOnly: boolean;
 /** 自动重试被中断的 run。 */
  autoRetry: boolean;
 /** 单个旧 run 最多自动重试几次。 */
  maxRetriesPerRun: number;
 /** 单次运行 token 软预算(0=不设)。 */
  tokenBudgetPerRun: number;
 /** 单周期 token 预算(0=不设)。 质量轮经验证:单 run 预算 5M 从未触线,
 * 但 12 个 run 组成的周期可到 12.7~22.9M——预算门必须在**周期聚合层**也有一道。 */
  tokenBudgetPerCycle: number;
 /** 周期结束是否跑 ROI 门(连负降频/停摆)。 */
  roiGate: boolean;
  updatedAt: number;
  by?: string;
}

/** 一个自动周期(串行派发,runIds 是已派出的机制→run)。 */
export interface RsiSchedulerCycle {
  id: string;
  index: number;
  startedAt: number;
 /** 还没尝试的机制(按目录顺序)。 */
  pending: RsiMechanismId[];
 /** 已成功派出的机制→runId。 */
  runIds: Partial<Record<RsiMechanismId, string>>;
 /** 已尝试过的机制(含被跳过/派发失败)。 */
  settled: RsiMechanismId[];
 /** 本周期因单次运行预算超限被提前结束的机制(有值=不再派余下机制)。 */
  budgetExceeded?: RsiMechanismId;
 /** 本周期累计 token 超周期预算(true=本周期,余下机制下周期再排)。 */
  cycleBudgetExceeded?: boolean;
 /** 本周期采用的 ROI 降频因子(<1=机制集按比例裁剪,轮转覆盖)。 */
  quotaFactor?: number;
}

export interface RsiSchedulerRuntime {
  lastTickAt?: number;
 /** 下一次允许开新周期的时间(running 中=undefined)。 */
  nextRunAt?: number;
 /** 已开过多少周期(单调递增;cycle.index 与它同源)。 */
  cycleCount?: number;
 /** P1(机制税分层):机制→上次 agent 派发时刻;intervalDays 频次门的判据。 */
  mechanismLastRunAt?: Record<string, number>;
 /** P1:本周期 code 驱动夜间管线的执行摘要(notes 进周报排查;失败不挡周期)。 */
  nightlyPipeline?: { at: number; ok: boolean; runId?: string; note?: string };
 /** ROI 降频时机制集的轮转起点(保证被裁掉的机制下个周期先跑)。 */
  mechanismOffset?: number;
  cycle?: RsiSchedulerCycle;
  lastCycle?: {
    id: string;
    at: number;
    runIds: string[];
    costTokens: number;
    amountCny: number | null;
    budgetExceeded: boolean;
 /** :本周期采用的 ROI 降频因子(<1=机制集按比例裁剪)。 */
    quotaFactor?: number;
    roi?: { action: string; negativeStreak: number; detail?: string };
  };
  breaker?: { paused: boolean; reason?: string; at?: number; /** P0-①:pause 落盘失败标记——tick ① 重试而非清旗。 */
    writeFailed?: boolean };
}

export interface RsiSchedulerState {
  config: RsiSchedulerConfig;
  runtime: RsiSchedulerRuntime;
}

export function schedulerPath(root: string): string {
  return join(root, RSI_SCHEDULER_REL);
}

/** 缺省配置(关闭:自动烧 token 的调度必须由用户显式打开)。 */
export function defaultSchedulerConfig(now = Date.now()): RsiSchedulerConfig {
  return {
    enabled: false,
    everyMinutes: RSI_SCHEDULER_DEFAULT_EVERY_MINUTES,
    mechanisms: [],
    idleOnly: true,
    autoRetry: true,
    maxRetriesPerRun: RSI_RETRY_MAX_DEFAULT,
    tokenBudgetPerRun: RSI_SCHEDULER_DEFAULT_BUDGET,
    tokenBudgetPerCycle: RSI_SCHEDULER_DEFAULT_CYCLE_BUDGET,
    roiGate: true,
    updatedAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asMechanismId(value: unknown): RsiMechanismId | undefined {
  return typeof value === "string" && (RSI_MECHANISM_IDS as readonly string[]).includes(value)
    ? (value as RsiMechanismId)
    : undefined;
}

function clampEvery(value: number): number {
  return Math.min(525600, Math.max(1, Math.floor(value)));
}

function normalizeConfig(raw: unknown, now: number): RsiSchedulerConfig {
  const base = defaultSchedulerConfig(now);
  if (!isRecord(raw)) return base;
  const every = asNumber(raw.everyMinutes);
  const budget = asNumber(raw.tokenBudgetPerRun);
  const cycleBudget = asNumber(raw.tokenBudgetPerCycle);
  const maxRetries = asNumber(raw.maxRetriesPerRun);
  const mechanisms = Array.isArray(raw.mechanisms)
    ? [...new Set(raw.mechanisms.map(asMechanismId).filter((id): id is RsiMechanismId => id !== undefined))]
    : [];
  const out: RsiSchedulerConfig = {
    enabled: raw.enabled === true,
    everyMinutes: every === undefined ? base.everyMinutes : clampEvery(every),
    mechanisms,
    idleOnly: raw.idleOnly !== false,
    autoRetry: raw.autoRetry !== false,
    maxRetriesPerRun: maxRetries === undefined ? base.maxRetriesPerRun : Math.min(5, Math.max(0, Math.floor(maxRetries))),
    tokenBudgetPerRun: budget === undefined ? base.tokenBudgetPerRun : Math.max(0, Math.floor(budget)),
    tokenBudgetPerCycle: cycleBudget === undefined ? base.tokenBudgetPerCycle : Math.max(0, Math.floor(cycleBudget)),
    roiGate: raw.roiGate !== false,
    updatedAt: asNumber(raw.updatedAt) ?? now,
  };
  const by = asString(raw.by);
  if (by !== undefined) out.by = by;
  return out;
}

function normalizeRuntime(raw: unknown): RsiSchedulerRuntime {
  if (!isRecord(raw)) return {};
  const out: RsiSchedulerRuntime = {};
  const lastTickAt = asNumber(raw.lastTickAt);
  if (lastTickAt !== undefined) out.lastTickAt = lastTickAt;
  const nextRunAt = asNumber(raw.nextRunAt);
  if (nextRunAt !== undefined) out.nextRunAt = nextRunAt;
  const cycleCount = asNumber(raw.cycleCount);
  if (cycleCount !== undefined) out.cycleCount = cycleCount;
  const mechanismOffset = asNumber(raw.mechanismOffset);
  if (mechanismOffset !== undefined) out.mechanismOffset = mechanismOffset;
 // P1:机制频次判据 + code 驱动管线摘要(旧 state 无此字段=空,首周期全量放行)。
  if (isRecord(raw.mechanismLastRunAt)) {
    const lastRunAt: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.mechanismLastRunAt)) {
      const mech = asMechanismId(k);
      const at = asNumber(v);
      if (mech !== undefined && at !== undefined) lastRunAt[mech] = at;
    }
    if (Object.keys(lastRunAt).length > 0) out.mechanismLastRunAt = lastRunAt;
  }
  if (isRecord(raw.nightlyPipeline)) {
    const at = asNumber(raw.nightlyPipeline.at);
    if (at !== undefined) {
      const runId = asString(raw.nightlyPipeline.runId);
      const note = asString(raw.nightlyPipeline.note);
      out.nightlyPipeline = {
        at,
        ok: raw.nightlyPipeline.ok === true,
        ...(runId !== undefined && runId !== "" ? { runId } : {}),
        ...(note !== undefined && note !== "" ? { note } : {}),
      };
    }
  }
  const cycle = raw.cycle;
  if (isRecord(cycle)) {
    const id = asString(cycle.id);
    const pending = Array.isArray(cycle.pending)
      ? cycle.pending.map(asMechanismId).filter((m): m is RsiMechanismId => m !== undefined)
      : [];
    if (id !== undefined) {
      const runIds: Partial<Record<RsiMechanismId, string>> = {};
      if (isRecord(cycle.runIds)) {
        for (const [k, v] of Object.entries(cycle.runIds)) {
          const mech = asMechanismId(k);
          const runId = asString(v);
          if (mech !== undefined && runId !== undefined) runIds[mech] = runId;
        }
      }
      const settled = Array.isArray(cycle.settled)
        ? cycle.settled.map(asMechanismId).filter((m): m is RsiMechanismId => m !== undefined)
        : [];
      out.cycle = {
        id,
        index: asNumber(cycle.index) ?? 0,
        startedAt: asNumber(cycle.startedAt) ?? Date.now(),
        pending,
        runIds,
        settled,
      };
      const budget = asMechanismId(cycle.budgetExceeded);
      if (budget !== undefined) out.cycle.budgetExceeded = budget;
      if (cycle.cycleBudgetExceeded === true) out.cycle.cycleBudgetExceeded = true;
      const cycleQuota = asNumber(cycle.quotaFactor);
      if (cycleQuota !== undefined) out.cycle.quotaFactor = cycleQuota;
    }
  }
  if (isRecord(raw.lastCycle)) {
    const id = asString(raw.lastCycle.id);
    if (id !== undefined) {
      const roi = isRecord(raw.lastCycle.roi)
        ? {
            action: asString(raw.lastCycle.roi.action) ?? "ok",
            negativeStreak: asNumber(raw.lastCycle.roi.negativeStreak) ?? 0,
            ...(asString(raw.lastCycle.roi.detail) === undefined ? {} : { detail: asString(raw.lastCycle.roi.detail)! }),
          }
        : undefined;
      out.lastCycle = {
        id,
        at: asNumber(raw.lastCycle.at) ?? 0,
        runIds: Array.isArray(raw.lastCycle.runIds)
          ? raw.lastCycle.runIds.filter((v): v is string => typeof v === "string")
          : [],
        costTokens: asNumber(raw.lastCycle.costTokens) ?? 0,
        amountCny: raw.lastCycle.amountCny === null ? null : (asNumber(raw.lastCycle.amountCny) ?? null),
        budgetExceeded: raw.lastCycle.budgetExceeded === true,
        ...(asNumber(raw.lastCycle.quotaFactor) === undefined ? {} : { quotaFactor: asNumber(raw.lastCycle.quotaFactor)! }),
        ...(roi === undefined ? {} : { roi }),
      };
    }
  }
  if (isRecord(raw.breaker)) {
    out.breaker = {
      paused: raw.breaker.paused === true,
      ...(asString(raw.breaker.reason) === undefined ? {} : { reason: asString(raw.breaker.reason)! }),
      ...(asNumber(raw.breaker.at) === undefined ? {} : { at: asNumber(raw.breaker.at)! }),
      ...(raw.breaker.writeFailed === true ? { writeFailed: true } : {}),
    };
  }
  return out;
}

async function readTextOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

/** 原子写(同目录 .tmp + fsync + rename;与 rsi-mechanism-store 同口径)。 */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

/** 读调度状态:缺失/坏文件 → 缺省(**不写盘**:没启用与文件损坏必须可区分)。 */
export async function loadSchedulerState(root: string, now = Date.now()): Promise<RsiSchedulerState> {
  const text = await readTextOrEmpty(schedulerPath(root));
  if (text.trim() === "") return { config: defaultSchedulerConfig(now), runtime: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { config: defaultSchedulerConfig(now), runtime: {} };
  }
  if (!isRecord(parsed)) return { config: defaultSchedulerConfig(now), runtime: {} };
  return { config: normalizeConfig(parsed.config, now), runtime: normalizeRuntime(parsed.runtime) };
}

async function saveSchedulerState(root: string, state: RsiSchedulerState): Promise<void> {
  await writeJsonAtomic(schedulerPath(root), state);
}

/** 用户可改的字段(白名单;未知键忽略)。`resumeBreaker` 是动作不是字段。 */
export interface RsiSchedulerPatch {
  enabled?: boolean;
  everyMinutes?: number;
  mechanisms?: readonly string[];
  idleOnly?: boolean;
  autoRetry?: boolean;
  maxRetriesPerRun?: number;
  tokenBudgetPerRun?: number;
  tokenBudgetPerCycle?: number;
  roiGate?: boolean;
 /** true=人工恢复熔断(breaker.resume),并清掉调度器里的暂停快照。 */
  resumeBreaker?: boolean;
}

export interface SetSchedulerResult {
  ok: boolean;
  reason?: string;
  state?: RsiSchedulerState;
  breakerResumed?: boolean;
}

/**
 * 改调度配置(白名单合并,原子落盘)。
 * 打开开关 / 改周期 → nextRunAt=now(立即进入第一个周期);显式 resumeBreaker 调熔断台账 resume。
 * 参数形状不对 → reason INVALID_PATCH;IO 失败 → WRITE_FAILED;不 throw。
 */
export async function setSchedulerConfig(
  root: string,
  patch: RsiSchedulerPatch,
  by?: string,
  now = Date.now(),
): Promise<SetSchedulerResult> {
  if (!isRecord(patch)) return { ok: false, reason: "INVALID_PATCH" };
  let state = await loadSchedulerState(root, now);
  const cfg = { ...state.config };
  const wasEnabled = cfg.enabled;
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") return { ok: false, reason: "INVALID_PATCH" };
    cfg.enabled = patch.enabled;
  }
  if (patch.everyMinutes !== undefined) {
    const v = asNumber(patch.everyMinutes);
    if (v === undefined) return { ok: false, reason: "INVALID_PATCH" };
    cfg.everyMinutes = clampEvery(v);
  }
  if (patch.mechanisms !== undefined) {
    if (!Array.isArray(patch.mechanisms)) return { ok: false, reason: "INVALID_PATCH" };
    const ids: RsiMechanismId[] = [];
    for (const raw of patch.mechanisms) {
      const id = asMechanismId(raw);
      if (id === undefined) return { ok: false, reason: "INVALID_PATCH" };
      if (!ids.includes(id)) ids.push(id);
    }
    cfg.mechanisms = ids;
  }
  if (patch.idleOnly !== undefined) {
    if (typeof patch.idleOnly !== "boolean") return { ok: false, reason: "INVALID_PATCH" };
    cfg.idleOnly = patch.idleOnly;
  }
  if (patch.autoRetry !== undefined) {
    if (typeof patch.autoRetry !== "boolean") return { ok: false, reason: "INVALID_PATCH" };
    cfg.autoRetry = patch.autoRetry;
  }
  if (patch.maxRetriesPerRun !== undefined) {
    const v = asNumber(patch.maxRetriesPerRun);
    if (v === undefined) return { ok: false, reason: "INVALID_PATCH" };
    cfg.maxRetriesPerRun = Math.min(5, Math.max(0, Math.floor(v)));
  }
  if (patch.tokenBudgetPerRun !== undefined) {
    const v = asNumber(patch.tokenBudgetPerRun);
    if (v === undefined || v < 0) return { ok: false, reason: "INVALID_PATCH" };
    cfg.tokenBudgetPerRun = Math.floor(v);
  }
  if (patch.tokenBudgetPerCycle !== undefined) {
    const v = asNumber(patch.tokenBudgetPerCycle);
    if (v === undefined || v < 0) return { ok: false, reason: "INVALID_PATCH" };
    cfg.tokenBudgetPerCycle = Math.floor(v);
  }
  if (patch.roiGate !== undefined) {
    if (typeof patch.roiGate !== "boolean") return { ok: false, reason: "INVALID_PATCH" };
    cfg.roiGate = patch.roiGate;
  }
  cfg.updatedAt = now;
  const byText = asString(by);
  if (byText !== undefined) cfg.by = byText;
  state = { config: cfg, runtime: state.runtime };
 // 新打开 / 改周期:重置下一次到点时间(开机即跑第一周期;用户不必等一天)。
  if ((cfg.enabled && !wasEnabled) || patch.everyMinutes !== undefined) {
    state.runtime.nextRunAt = now;
  }
  let breakerResumed = false;
  if (patch.resumeBreaker === true) {
    try {
      const r = await resumeBreaker(root, { by: byText ?? "panel", reason: "人工恢复(调度器设置)", kind: "human" });
      breakerResumed = r?.ok === true;
      if (breakerResumed) delete state.runtime.breaker;
    } catch { /* 恢复失败不挡配置保存 */ }
  }
  try {
    await saveSchedulerState(root, state);
  } catch {
    return { ok: false, reason: "WRITE_FAILED" };
  }
  return { ok: true, state, breakerResumed };
}

export type RsiSchedulerAction =
  | "disabled"
  | "breaker-paused"
  | "running"
  | "busy"
  | "busy-tick"
  | "not-due"
  | "retried"
  | "started"
  | "skipped-mechanism"
  | "cycle-done"
  | "cycle-budget-stop"
  | "cycle-empty"
  | "settling"
  | "error";

export interface RsiSchedulerTickResult {
  action: RsiSchedulerAction;
  mechanismId?: string;
  runId?: string;
  taskId?: string;
  reason?: string;
 /** 本次 tick 收尾的 run 数(诊断用)。 */
  finalized?: number;
  state: RsiSchedulerState;
}

/** 调度器依赖:复用 startMechanismRun 的依赖 + 在线繁忙探测 + 可注入的时钟/breaker/start(单测)。 */
export interface RsiSchedulerDeps extends StartRunDeps {
 /** 有前台任务在跑/排队(缺省=不判断,视作空闲)。 */
  isOnlineBusy?: () => boolean;
  now?: number;
 /** 测试注入:缺省=真 startMechanismRun。 */
  start?: (deps: StartRunDeps, mechanismId: RsiMechanismId) => Promise<StartRunResult>;
 /** 测试注入:缺省=真 rsi-breaker-store.getState。 */
  breakerState?: (root: string) => Promise<{ paused?: boolean; reason?: string; trigger?: string }>;
 /** P1:code 驱动夜间管线(确定性六步,零 LLM);测试注入观察调用。 */
  runNightlyPipeline?: (root: string, now: number) => Promise<{ ok: boolean; runId?: string; note?: string }>;
 /** LLM 语义归因:finishCycle 时对 uncategorized 链做 LLM 分类;测试注入。 */
  semanticAttributionFn?: (root: string) => Promise<{ enriched: number; errors: number }>;
}

/** P4:管线缺省实现改为**出进程执行**——此前直跑在 tick 里(重同步 IO)曾阻塞
 * 网关事件循环 ~5min(WS 全超时/面板假死),且第一拍状态未落盘引发第二拍重建周期的竞态。
 * bundle 态 spawn dist/nightly-worker.mjs(事件循环零阻塞,15min 超时看护);src/tsx 态无
 * worker 产物时内联回退(开发/测试语义不变)。 */
async function defaultNightlyPipeline(root: string, now: number): Promise<{ ok: boolean; runId?: string; note?: string }> {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const projectId = basenameOfRoot(root);
  const journalDir = join(root, ".genie", "journals");
 // 一个 project 同时只允许一个夜间 worker(活锁让路,陈旧锁由 worker 接管)。
  const lock = nightlyLockHeld(root, projectId, { now });
  if (lock.held) {
    return { ok: true, note: `夜间 worker 已在跑(pid=${lock.lock?.pid ?? "?"})` };
  }
  const workerUrl = new URL("./nightly-worker.mjs", import.meta.url);
  const workerPath = workerUrl.protocol === "file:" ? fileURLToPath(workerUrl) : undefined;
  if (workerPath !== undefined && existsSync(workerPath)) {
    return await new Promise((resolve) => {
      execFile(
        process.execPath,
        [workerPath, "--root", root, "--project", projectId, "--date", date, "--journal", journalDir],
        { timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          const lastLine = String(stdout ?? "").trim().split(/\r?\n/).filter((l) => l !== "").pop() ?? "";
          try {
            const parsed = JSON.parse(lastLine) as { ok?: unknown; runId?: unknown; note?: unknown };
            resolve({
              ok: parsed.ok === true,
              ...(typeof parsed.runId === "string" ? { runId: parsed.runId } : {}),
              note: typeof parsed.note === "string" ? parsed.note : error !== null ? `worker 异常:${error.message}` : undefined,
            });
          } catch {
            resolve({ ok: false, note: error !== null ? `worker 执行失败:${error.message}` : "worker 输出不可解析" });
          }
        },
      );
    });
  }
 // 内联回退(src/tsx 态:worker 产物不存在;语义与旧实现逐字一致)。
 // 先回收陈旧 run(残留 running 步骤退回 pending 续跑,续不动就落 failed),再考虑起新程。
  try {
    const reclaimed = await reclaimNightly(root, { projectId, date, journalDir, now });
    if (reclaimed.status === "live") {
      return { ok: true, ...(reclaimed.run === null ? {} : { runId: reclaimed.run.runId }), note: `夜间 run 进行中:${reclaimed.note}` };
    }
  } catch { /* 回收失败不挡管线;startNightly 自带幂等跳过 */ }
  const started = await startNightly(root, { date, projectId, journalDir, now });
  if (!started.run || started.run.status === "skipped") {
    return { ok: false, note: `start 被拒:${started.codes.join(",")}` };
  }
  if (started.run.status === "done") return { ok: true, note: "同日已完成且无新会话" };
  const result = await runNightly(root, { runId: started.run.runId, journalDir, now });
  return {
    ok: result.run.status === "done",
    ...(started.run.runId !== undefined ? { runId: started.run.runId } : {}),
    note: `${result.run.status} steps=${result.run.steps.filter((s) => s.status === "done").length}/${result.run.steps.length}`,
  };
}

function basenameOfRoot(root: string): string {
  const parts = String(root ?? "").replace(/\\/g, "/").split("/").filter((p) => p !== "");
  return parts.length > 0 ? (parts[parts.length - 1] ?? "root") : "root";
}

function cycleIdOf(now: number): string {
  return `rsi-cycle-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
}

/** 配置里点名的机制 ∩ 当前启用 ∩ agent 驱动;空 mechanisms=全部启用机制。保持目录顺序。 */
export async function resolveCycleMechanisms(
  root: string,
  pick: readonly RsiMechanismId[],
): Promise<RsiMechanismId[]> {
  let states: Record<string, { enabled: boolean; driver: "agent" | "code" }> = {};
  try {
    states = await loadMechanisms(root);
  } catch {
    states = {};
  }
  const explicit = pick.length > 0 ? new Set(pick) : undefined;
  const out: RsiMechanismId[] = [];
  for (const id of RSI_MECHANISM_IDS) {
    const spec = mechanismSpec(id);
    if (!spec) continue;
    if (explicit !== undefined && !explicit.has(id)) continue;
    const state = states[id];
    const enabled = state?.enabled ?? spec.defaultEnabled;
    const driver = state?.driver ?? spec.defaultDriver;
    if (enabled && driver === "agent") out.push(id);
  }
  return out;
}

function runIsLive(
  run: RsiRunRecord,
  taskState?: (taskId: string) => string | undefined,
  now: number = Date.now(),
): boolean {
  if (run.status !== "running") return false;
  if (run.taskId === undefined || taskState === undefined) return true;
  const stateText = taskState(run.taskId);
 // 孤儿:网关重启后 taskManager 查不到 taskId(undefined)。这种 run 永远不会自己收尾,
 // 超过宽限仍查不到 → 不算在跑(否则把整个调度周期永久堵在「有在跑 run」)。
  if (stateText === undefined) return now - run.startedAt <= ORPHAN_GRACE_MS;
  return !TERMINAL_TASK_STATES.has(stateText);
}

/** 在最近窗口内找一个「被中断且还没重试过」的 run。只认 task interrupted,不重试用户取消/失败。 */
export function pickRetryCandidate(
  runs: readonly RsiRunRecord[],
  now: number,
  maxRetries: number,
): RsiRunRecord | undefined {
  if (maxRetries <= 0) return undefined;
  let best: RsiRunRecord | undefined;
  for (const run of runs) {
    if (run.status !== "failed") continue;
    if (run.error !== "task interrupted") continue;
    if ((run.retryCount ?? 0) >= maxRetries) continue;
    if (now - run.startedAt > RSI_RETRY_WINDOW_MS) continue;
    if (best === undefined || run.startedAt > best.startedAt) best = run;
  }
  return best;
}

/** 周期结束结账:真实 usage 落 cost.jsonl → ROI 门 → 下一周期时间。 */
async function finishCycle(
  root: string,
  state: RsiSchedulerState,
  now: number,
  deps: RsiSchedulerDeps,
): Promise<RsiSchedulerTickResult> {
  const cycle = state.runtime.cycle;
  if (cycle === undefined) return { action: "error", reason: "NO_CYCLE", state };
  let costTokens = 0;
  let amountCny: number | null = 0;
  let measured = false;
  let anyBudget = cycle.budgetExceeded !== undefined || cycle.cycleBudgetExceeded === true;
  let unsettledRecent = false;
  const settleOpts: SettleRunOptions = {
    root,
    now,
    ...(deps.taskState === undefined ? {} : { taskState: deps.taskState }),
    ...(deps.readSession === undefined ? {} : { readSession: deps.readSession }),
    ...(deps.config === undefined ? {} : { config: deps.config }),
    ...(deps.experienceStore === undefined ? {} : { experienceStore: deps.experienceStore }),
  };
  for (const [mech, runId] of Object.entries(cycle.runIds) as [RsiMechanismId, string][]) {
    let run: RsiRunRecord | undefined;
    try {
      run = await getRun(root, mech, runId);
    } catch {
      continue;
    }
    if (run === undefined) continue;
 // 终态但还没结账(成本/预算/认账):周期前再补一次(面板没轮询也要算钱)。
 // 经验证 :任务 done 当刻 journal 写后读可能还看不到窗口,这里补一次通常已可见。
    if (
      run.status !== "running" &&
      (run.cost === undefined
        || costUnmeasured(run.cost)
        || (run.budgetTokens !== undefined && (run.budgetExceeded === undefined || costUnmeasured(run.cost)))
        || (run.analysis !== undefined && (run.analysisMissing === undefined || costUnmeasured(run.cost))))
    ) {
      try {
        const spec = mechanismSpec(mech);
        const settled = await settleRunRecord(settleOpts, { id: mech, title: spec?.title ?? mech }, run);
        run = settled.run;
      } catch { /* 下一 tick/面板轮询再补 */ }
    }
    if (run.budgetExceeded === true) anyBudget = true;
    const cost = run.cost;
    if (cost === undefined || costUnmeasured(cost)) {
 // 刚结束(<120s)的 run 允许等下一次 tick 补账;等不到就按「未计价」,不写假 0 元。
      if (now - (run.finishedAt ?? run.startedAt) < 120_000) unsettledRecent = true;
      continue;
    }
 // 0 token 且无单价=没测到用量,不记假账(与 ROI 门「0 token 不能当零成本」同口径)。
    if (cost.totalTokens > 0 || cost.amountCny !== null) {
      try {
        recordCost(root, {
          id: `${cycle.id}:${runId}`,
          cycleId: cycle.id,
          at: new Date(now).toISOString(),
          stage: "mining",
          mechanismId: mech,
          ...(cost.model === undefined ? {} : { model: cost.model }),
          tokens: { input: cost.inputTokens, output: cost.outputTokens, total: cost.totalTokens },
          wallMs: Math.max(0, (run.finishedAt ?? now) - run.startedAt),
        });
      } catch { /* 记账失败不挡周期 */ }
      costTokens += cost.totalTokens;
      measured = true;
      if (cost.amountCny !== null) amountCny = (amountCny ?? 0) + cost.amountCny;
    }
  }
  if (unsettledRecent && !anyBudget) {
 // 有刚结束但账未落的 run:本 tick 不,下一 tick 再试(避免把 0 成本写进 lastCycle)。
 // 预算超限是硬:即使成本未结清也先停本周期(余下机制不派)。
    state.runtime.lastTickAt = now;
    try {
      await saveSchedulerState(root, state);
    } catch { /* 观测失败容忍 */ }
    return { action: "settling", finalized: 0, state };
  }
  if (!measured) amountCny = null;
  if (amountCny !== null && !Number.isFinite(amountCny)) amountCny = null;
  let roi: { action: string; negativeStreak: number; detail?: string } | undefined;
  if (state.config.roiGate) {
    try {
      const gate = await evaluateRoiGate(root, { apply: true, breakerRoot: root });
      roi = {
        action: String((gate as { action?: unknown }).action ?? "ok"),
        negativeStreak: Number((gate as { negativeStreak?: unknown }).negativeStreak ?? 0) || 0,
        ...(typeof (gate as { detail?: unknown }).detail === "string" ? { detail: (gate as { detail: string }).detail } : {}),
      };
 // ROI 门触发 pause:本周期结束即停转(下一 tick 会读到 breaker.paused 并停在 breaker-paused)。
 // P0-①:breaker 落盘失败要标 writeFailed——tick ① 据此重试 pause 而不是清旗(防写失败=熔断失效)。
      if (roi.action === "pause") {
        state.runtime.breaker = {
          paused: true,
          reason: roi.detail ?? "roi-gate: 连续负收益",
          at: now,
          ...(gate.breaker?.ok === false ? { writeFailed: true } : {}),
        };
      }
    } catch { /* ROI 评测失败不挡周期 */ }
  }
 // #192 实验自动结算:周期时对满样本 tip 实验写回 result 指标+建议决策
 // (不自动 adopt——自我修改安全门;决策/建议进台账,周报与 rsi.status 实验区照常呈现)。
  try {
    await settleExperiments(root, { now });
  } catch { /* 结算失败不挡周期 */ }
 // P0-2:消费 nightly 候选队列——可确定性翻译的候选登记进实验账本并标记,
 // 打断「同批候选每轮重排无人消费」;翻译不了的留队给 agent 机制。
  try {
    drainCandidateQueue(root, { now });
  } catch { /* 消费失败不挡周期 */ }
 // LLM 语义归因:对 uncategorized 返工链做 LLM 分类(P2-⑥ 验证 60% 需此层)。
 // 零链时零 LLM 调用;预算由模块内 enrichMax 控制(缺省 10 链/轮)。
  if (deps.semanticAttributionFn !== undefined) {
    try {
      const attributed = await deps.semanticAttributionFn(root);
      void attributed; // 结果入 enrichment 台账,无需再处理
    } catch { /* 归因失败不挡周期 */ }
  }
 // P2:gap-taxonomy 内置分类账落地(幂等 seed;GAP_SEED_DUPLICATE=已在册)——
 // #211 预防件消费面(applyAt 注入)的前提;后续 rework 链的佐证 bump 也读这份台账。
  try {
    seedTaxonomy(root, { now });
  } catch { /* seed 失败不挡周期(下周期再试) */ }
 // P1-④:机制发现→提案——本轮 bad 级发现自动进 change-requests 开发队列
 // (64 条发现靠人抄的闭环断点;dedupeKey 幂等,重复=merge)。
  try {
    fileCycleFindingsToChangeRequests(root, { ...(cycle.runIds as Record<string, string>) }, { at: now });
  } catch { /* 转换失败不挡周期 */ }
 // (设计稿§11 P1#1):周报进调度器——链每周一报(距上一条 generated ≥7 天才跑,
 // 不增每周期开销);聚合失败不挡。产物落 .genie/rsi/weekly/report-<date>.md 供面板/人随时翻。
  try {
    const lastGeneratedAt = readWeeklyEvents(root).reduce((acc, e) => {
      if (e.kind !== "generated") return acc;
      const t = Date.parse(e.at);
      return Number.isFinite(t) && t > acc ? t : acc;
    }, 0);
    if (now - lastGeneratedAt >= 7 * 24 * 60 * 60 * 1000) {
      const report = await aggregateWeekly(root, { now });
      writeReportFile(root, report, `.genie/rsi/weekly/report-${new Date(now).toISOString().slice(0, 10)}.md`);
      appendWeeklyEvent(root, {
        kind: "generated",
        at: now,
        report: { from: report.window.from, to: report.window.to, warnings: report.warnings },
      });
    }
  } catch { /* 周报生成失败不挡周期(下周期再试) */ }
  state.runtime.lastCycle = {
    id: cycle.id,
    at: now,
    runIds: Object.values(cycle.runIds).filter((v): v is string => typeof v === "string"),
    costTokens,
    amountCny,
    budgetExceeded: anyBudget,
    ...(cycle.quotaFactor === undefined ? {} : { quotaFactor: cycle.quotaFactor }),
    ...(roi === undefined ? {} : { roi }),
  };
  state.runtime.cycle = undefined;
  state.runtime.lastTickAt = now;
  state.runtime.nextRunAt = now + state.config.everyMinutes * 60_000;
  try {
    await saveSchedulerState(root, state);
  } catch {
    return { action: "error", reason: "WRITE_FAILED", state };
  }
  return { action: anyBudget ? "cycle-budget-stop" : "cycle-done", finalized: 0, state };
}

/**
 * 调度 tick(网关 60s 一次;也可由 CLI/测试直接调用):
 * 收尾终态 run → 等待在跑 run → 自动重试中断 run → 到点/空闲检查 → 串行派一个机制 → 周期。
 * 任何 IO 失败都折叠成 action=error(下一 tick 重试),不 throw。
 * P4:进程内互斥——app.ts 的 60s 定时器是 fire-and-forget,管线耗时期间下一拍
 * 可能重入(经验证:第一拍状态未落盘,第二拍重建周期)。互斥后重入拍返回 busy-tick 零副作用。
 */
let tickInFlight = false;

export async function tickRsiScheduler(deps: RsiSchedulerDeps): Promise<RsiSchedulerTickResult> {
  const root = deps.root;
  const now = deps.now ?? Date.now();
  let state: RsiSchedulerState;
  try {
    state = await loadSchedulerState(root, now);
  } catch {
    state = { config: defaultSchedulerConfig(now), runtime: {} };
  }
  if (tickInFlight) return { action: "busy-tick", state };
  tickInFlight = true;
  try {
    return await tickRsiSchedulerInner(deps, state);
  } finally {
    tickInFlight = false;
  }
}

async function tickRsiSchedulerInner(deps: RsiSchedulerDeps, state: RsiSchedulerState): Promise<RsiSchedulerTickResult> {
  const root = deps.root;
  const now = deps.now ?? Date.now();
  if (!state.config.enabled) return { action: "disabled", state };

 // ① 熔断暂停:停夜间整合/停实验/停注入,保留观测。
  let breaker: { paused?: boolean; reason?: string } = {};
  try {
    breaker = deps.breakerState !== undefined ? await deps.breakerState(root) : await getBreakerState(root);
  } catch {
    breaker = {};
  }
  if (breaker.paused === true) {
    state.runtime.breaker = { paused: true, reason: breaker.reason ?? "breaker paused", at: now };
    state.runtime.lastTickAt = now;
    try {
      await saveSchedulerState(root, state);
    } catch { /* 观测落盘失败不挡返回 */ }
    return { action: "breaker-paused", state };
  }
 // P0-①(熔断脱钩修复):runtime 说 paused 但台账说没 paused——两种情况:
 // ①正常路径:人工 resume 清了台账 → 同步清 runtime 快照(旧行为);
 // ②writeFailed:pause 当次落盘失败(cost 旧变量 import 注意)→ **重试 pause**而不是清旗,
 // 否则一次写失败=熔断永久失效(经验证 7 周期 91.8M 失守)。
  if (state.runtime.breaker?.paused === true) {
    if (state.runtime.breaker.writeFailed === true) {
      try {
        const retried = await pauseBreaker(root, {
          by: "rsi-scheduler",
          reason: state.runtime.breaker.reason ?? "roi-gate pause 落盘失败重试",
          scope: "all",
          trigger: "auto-negative-streak",
        });
        if (retried.ok === true) {
          state.runtime.breaker = { paused: true, reason: retried.state?.reason ?? state.runtime.breaker.reason, at: now };
          state.runtime.lastTickAt = now;
          try { await saveSchedulerState(root, state); } catch { /* 观测失败容忍 */ }
          return { action: "breaker-paused", state };
        }
 // 重试仍失败:保持 paused 快照(本 tick 不开周期,下一拍再试)。
        state.runtime.lastTickAt = now;
        try { await saveSchedulerState(root, state); } catch { /* 观测失败容忍 */ }
        return { action: "breaker-paused", state };
      } catch { /* 重试异常:同样保持 paused,不进入周期 */ }
      state.runtime.lastTickAt = now;
      try { await saveSchedulerState(root, state); } catch { /* 观测失败容忍 */ }
      return { action: "breaker-paused", state };
    }
    state.runtime.breaker = { paused: false };
  }

 // ② 收尾已到终态的 run(不依赖面板轮询:没有 rsi.status 请求时账本也会结账)。
  let finalized = 0;
  let runs: RsiRunRecord[] = [];
  try {
    runs = await listRuns(root);
  } catch {
    runs = [];
  }
  const settleOpts: SettleRunOptions = {
    root,
    now,
    ...(deps.taskState === undefined ? {} : { taskState: deps.taskState }),
    ...(deps.readSession === undefined ? {} : { readSession: deps.readSession }),
    ...(deps.config === undefined ? {} : { config: deps.config }),
    ...(deps.experienceStore === undefined ? {} : { experienceStore: deps.experienceStore }),
  };
  for (const run of runs) {
    if (run.runId === undefined) continue;
    const stateText = run.taskId !== undefined && deps.taskState !== undefined ? deps.taskState(run.taskId) : undefined;
 // 任务到终态(run 已是 done/failed,或 run 自称 running 但任务状态已终态)才收尾。
 // 孤儿:running + taskId 查不到 + 超宽限 → 也算可收尾(交给 settleRunRecord 判 failed)。
    const orphan = run.status === "running" && run.taskId !== undefined && deps.taskState !== undefined
      && stateText === undefined && now - run.startedAt > ORPHAN_GRACE_MS;
    const terminalNow = run.status !== "running" || orphan
      || (stateText !== undefined && TERMINAL_TASK_STATES.has(stateText));
    if (!terminalNow) continue;
 // 空成本账(0 token/null 金额)按「待重算」处理,不要让早结算把费用永久钉成 0。
    const emptyCost = costUnmeasured(run.cost);
    const needs = run.cost === undefined
      || emptyCost
      || (run.budgetTokens !== undefined && run.budgetTokens > 0 && (run.budgetExceeded === undefined || emptyCost))
      || (run.analysis !== undefined && (run.analysisMissing === undefined || emptyCost));
    if (!needs) continue;
 // 只扫最近 10 分钟的**已终态**记录:更老的历史/已结账记录不在调度器里反复读 journal。
 // 例外:run 仍自称 running 但任务已终态——这是「无人结账」的活记录,多老都要收
 // (经验证:nightly 跑完 10 分钟后 age 闸把它跳过,面板不轮询就永远 running)。
    if (run.status !== "running" && now - (run.finishedAt ?? run.startedAt) > 10 * 60_000) continue;
    try {
      const spec = mechanismSpec(run.mechanismId);
      const settled = await settleRunRecord(settleOpts, { id: run.mechanismId, title: spec?.title ?? run.mechanismId }, run);
      if (settled.finalized > 0) finalized += 1;
      if (state.runtime.cycle !== undefined && settled.run.budgetExceeded === true
        && Object.values(state.runtime.cycle.runIds).includes(run.runId)) {
        state.runtime.cycle.budgetExceeded = run.mechanismId as RsiMechanismId;
      }
    } catch { /* 下一 tick 再试 */ }
  }

 // ②b 周期内已有 run 标记预算超限(可能上一步才收尾,也可能由面板轮询结账):
 // 置 cycle.budgetExceeded,下面会提前本周期,不再派余下机制。
  if (state.runtime.cycle !== undefined) {
    const cycleRunIds = new Set(Object.values(state.runtime.cycle.runIds));
    let cycleTokens = 0;
    for (const run of runs) {
      if (!cycleRunIds.has(run.runId)) continue;
      if (run.budgetExceeded === true) state.runtime.cycle.budgetExceeded = run.mechanismId as RsiMechanismId;
      cycleTokens += run.cost?.totalTokens ?? 0;
    }
 // 质量轮经验证补口:单 run 预算从未触线,但 12 机制周期合计可达 12.7~22.9M。
 // 周期聚合层超预算 → 本周期(余下机制下周期再排),不再线性烧钱。
    if (state.config.tokenBudgetPerCycle > 0 && cycleTokens > state.config.tokenBudgetPerCycle) {
      state.runtime.cycle.cycleBudgetExceeded = true;
    }
  }

 // ③ 有在跑 run:等待(全局单跑;避免 RUNNING_ALREADY 空转)。
  if (runs.some((run) => runIsLive(run, deps.taskState, now))) {
    state.runtime.lastTickAt = now;
    try {
      await saveSchedulerState(root, state);
    } catch { /* 观测失败容忍 */ }
    return { action: "running", finalized, state };
  }

 // ④ 自动重试被中断的 run(每 tick 最多一次;重派即返回,让下一个 tick 等它跑完)。
  if (state.config.autoRetry) {
    const candidate = pickRetryCandidate(runs, now, state.config.maxRetriesPerRun);
    if (candidate !== undefined) {
      const spec = mechanismSpec(candidate.mechanismId);
      if (spec !== undefined) {
        const start = deps.start ?? startMechanismRun;
        const retried = await start(
          {
            ...deps,
            retryOf: candidate.runId,
            ...(state.config.tokenBudgetPerRun > 0 ? { budgetTokens: state.config.tokenBudgetPerRun } : {}),
          },
          candidate.mechanismId as RsiMechanismId,
        );
        if (retried.ok === true) {
          try {
            await markRunRetried(root, candidate.mechanismId, candidate.runId);
          } catch { /* 计数失败下一 tick 可能重复重试一次;有上限兜底 */ }
          state.runtime.lastTickAt = now;
          try {
            await saveSchedulerState(root, state);
          } catch { /* 观测失败容忍 */ }
          return {
            action: "retried",
            mechanismId: candidate.mechanismId,
            ...(retried.runId === undefined ? {} : { runId: retried.runId }),
            ...(retried.taskId === undefined ? {} : { taskId: retried.taskId }),
            finalized,
            state,
          };
        }
 // 派不出去(已关闭/code 驱动/仍在跑)不重试,也不消耗重试次数。
      }
    }
  }

 // ⑤ 周期推进。
  if (state.runtime.cycle === undefined) {
    if (state.runtime.nextRunAt !== undefined && now < state.runtime.nextRunAt) {
      state.runtime.lastTickAt = now;
      try {
        await saveSchedulerState(root, state);
      } catch { /* 观测失败容忍 */ }
      return { action: "not-due", finalized, state };
    }
    if (state.config.idleOnly && deps.isOnlineBusy?.() === true) {
      state.runtime.lastTickAt = now;
      try {
        await saveSchedulerState(root, state);
      } catch { /* 观测失败容忍 */ }
      return { action: "busy", finalized, state };
    }
    const all = await resolveCycleMechanisms(root, state.config.mechanisms);
    if (all.length === 0) {
      state.runtime.lastTickAt = now;
      state.runtime.nextRunAt = now + state.config.everyMinutes * 60_000;
      try {
        await saveSchedulerState(root, state);
      } catch { /* 观测失败容忍 */ }
      return { action: "cycle-empty", finalized, state };
    }
 // 补齐 ROI 降频运行面:cost 机制注意「downshift 已落盘但周期仍跑满 12 机制」。
 // 降频因子 <1 时按比例裁剪本周期机制集,并用 mechanismOffset 轮转,保证被裁掉的机制下轮先跑。
    let pending = all;
    let quotaFactor: number | undefined;
    try {
      const gate = reportCost(root).lastGate;
      const factor = gate?.action === "downshift" ? gate.quota.nightlyWindowFactor : undefined;
      if (typeof factor === "number" && Number.isFinite(factor) && factor > 0 && factor < 1 && all.length > 1) {
        quotaFactor = Math.max(0.1, factor);
        const keep = Math.max(1, Math.ceil(all.length * quotaFactor));
        const offset = (state.runtime.mechanismOffset ?? 0) % all.length;
        const rotated = [...all.slice(offset), ...all.slice(0, offset)];
        pending = rotated.slice(0, keep);
        state.runtime.mechanismOffset = (offset + keep) % all.length;
      }
    } catch { /* 成本台账不可读:不降频,按全量跑 */ }
    const cycleIndex = (state.runtime.cycleCount ?? 0) + 1;
    state.runtime.cycleCount = cycleIndex;
    state.runtime.cycle = {
      id: cycleIdOf(now),
      index: cycleIndex,
      startedAt: now,
      pending,
      runIds: {},
      settled: [],
      ...(quotaFactor === undefined ? {} : { quotaFactor }),
    };
    state.runtime.nextRunAt = undefined;
 // P4:周期对象**先落盘**再跑管线——此前管线(阻塞 5min)期间状态未持久,
 // 下一拍按「无在途周期」重建周期(竞态注意);先存后跑,崩溃也能从半途周期恢复。
    try {
      await saveSchedulerState(root, state);
    } catch { /* 保存失败继续(下一拍有互斥兜底) */ }
 // P1机制税分层:新周期第一拍先跑 code 驱动夜间管线(确定性七步,零 LLM)——
 // 采集先行,本周期 agent 机制审计的才是新鲜数据;失败折叠进 runtime.nightlyPipeline 不挡周期。
    try {
      const pipeline = deps.runNightlyPipeline ?? defaultNightlyPipeline;
      const piped = await pipeline(root, now);
      state.runtime.nightlyPipeline = {
        at: now,
        ok: piped.ok,
        ...(piped.runId !== undefined ? { runId: piped.runId } : {}),
        ...(piped.note !== undefined ? { note: piped.note } : {}),
      };
    } catch (e) {
      state.runtime.nightlyPipeline = { at: now, ok: false, note: e instanceof Error ? e.message : String(e) };
    }
  }

  const cycle = state.runtime.cycle;
 // 预算超限:提前本周期(余下机制下周期再来)。
  if (cycle.budgetExceeded !== undefined || cycle.cycleBudgetExceeded === true) {
    return finishCycle(root, state, now, deps);
  }

 // 串行派下一个;关闭/code 驱动的机制直接跳过(不消耗派发)。
  const states = await loadMechanisms(root).catch(() => ({} as Record<string, { enabled: boolean; driver: "code" | "agent" }>));
  while (cycle.pending.length > 0) {
    const mech = cycle.pending.shift()!;
    const spec = mechanismSpec(mech);
    if (spec === undefined) continue;
    const mechState = states[mech];
    const enabled = mechState?.enabled ?? spec.defaultEnabled;
    const driver = mechState?.driver ?? spec.defaultDriver;
    if (!enabled || driver !== "agent") {
      cycle.settled.push(mech);
      continue;
    }
 // P1机制税分层:intervalDays 频次门——距上次 agent 派发不足间隔的机制本轮
 // 跳过(不消耗派发)。**从未派发过的机制恒到期**(lastRunAt=0 不设槛,首周期全量放行)。
 // 确定性数据流(nightly 管线/结算/队列消费)不受此门,每日照跑;agent 只做语义审计,
 // 按信息产出速率分层(台账静态审计 7 天,轨迹语义 3 天,prompts 30 天)。
    const intervalMs = Math.max(1, Math.floor(spec.intervalDays ?? 1)) * 86_400_000;
    const lastAgentRunAt = state.runtime.mechanismLastRunAt?.[mech] ?? 0;
    if (lastAgentRunAt > 0 && now - lastAgentRunAt < intervalMs) {
      cycle.settled.push(mech);
      continue;
    }
    const start = deps.start ?? startMechanismRun;
 // experimentQuotaFactor 首个消费方——experiments 机制降频时把配额因子写进任务书
 // (限「最多转入多少条候选」)与 run 记录;读不到成本台账/未降频 = 不设限,旧行为不变。
    let experimentQuotaFactor: number | undefined;
    if (mech === "experiments") {
      try {
        const gate = reportCost(root).lastGate;
        const factor = gate?.action === "downshift" ? gate.quota.experimentQuotaFactor : undefined;
        if (typeof factor === "number" && Number.isFinite(factor) && factor > 0 && factor < 1) {
          experimentQuotaFactor = factor;
        }
      } catch { /* 成本台账不可读:不设限 */ }
    }
    const result = await start(
      {
        ...deps,
        cycleId: cycle.id,
        ...(state.config.tokenBudgetPerRun > 0 ? { budgetTokens: state.config.tokenBudgetPerRun } : {}),
        ...(experimentQuotaFactor === undefined ? {} : { experimentQuotaFactor }),
      },
      mech,
    );
    if (result.ok === true && result.runId !== undefined) {
      cycle.runIds[mech] = result.runId;
      cycle.settled.push(mech);
 // P1:频次门判据——成功派发即记时刻(失败的派发不占频次,下 tick 可重试)。
      state.runtime.mechanismLastRunAt = { ...(state.runtime.mechanismLastRunAt ?? {}), [mech]: now };
      state.runtime.lastTickAt = now;
      try {
        await saveSchedulerState(root, state);
      } catch { /* 观测失败容忍 */ }
      return {
        action: "started",
        mechanismId: mech,
        runId: result.runId,
        ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
        finalized,
        state,
      };
    }
    if (result.reason === "RUNNING_ALREADY") {
 // 有别的 run 正在跑(手动触发):放回队首,等下一 tick。
      cycle.pending.unshift(mech);
      state.runtime.lastTickAt = now;
      try {
        await saveSchedulerState(root, state);
      } catch { /* 观测失败容忍 */ }
      return { action: "running", mechanismId: mech, reason: result.reason, finalized, state };
    }
 // 其余 reason(关闭/code/派发失败):记 settled,继续试下一个机制。
    cycle.settled.push(mech);
    state.runtime.lastTickAt = now;
    try {
      await saveSchedulerState(root, state);
    } catch { /* 观测失败容忍 */ }
    return { action: "skipped-mechanism", mechanismId: mech, reason: result.reason, finalized, state };
  }

 // 队列空 → 周期。
  return finishCycle(root, state, now, deps);
}

/** 只读快照(面板/诊断):配置 + 运行态 + 熔断状态;不写盘。 */
export async function collectSchedulerStatus(root: string, now = Date.now()): Promise<RsiSchedulerState> {
  const state = await loadSchedulerState(root, now);
  try {
    const breaker = await getBreakerState(root);
    state.runtime.breaker = {
      paused: breaker.paused === true,
      ...(typeof breaker.reason === "string" ? { reason: breaker.reason } : {}),
    };
  } catch {
 // 熔断台账不可读:保留文件里的旧快照
  }
  return state;
}
