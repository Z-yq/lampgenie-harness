/**
 * 工具热升级协议(Tool Upgrade Protocol,#192 承接,纯逻辑零 IO)。
 * 为什么需要这套协议:工具被自我改进循环(RSI)反复改写,如果把「新版上线」做成一次原子替换,
 * 一旦新版在真实会话里退化,唯一的止损手段就是版本回退 + 重启,代价是把已经跑起来的会话一起丢掉。
 * 本模块把升级拆成四个可观测的段位,每一步都能停:
 * - shadow:新版本注册进同名工具的别名槽位,只被显式 alias 调用命中(灰度池之外它不抢流量);
 * - canary:双跑通过后才允许按 session / project / percent 确定性分流(同一 session 永远落同侧,
 *   否则指标会被「同一会话来回切版本」污染);
 * - switch:canary 决策为正才接管原名,旧版不被删,而是降级成 demotedFrom + 2 个保留窗口,
 *   给下游留出「回滚观察期」(窗口没走完就 retire → TOOL_UP_KEEP_WINDOW_ACTIVE);
 * - retire:窗口走完后从当前解析中下线,但版本对象与历史留在 state 里供历史回放(resolveHistorical)。
 * 另外两个面是「能不能升」的判据与「怎么升」的说法:
 * - compareDualRun:双跑只认两条硬判据(样本量 + 守卫指标方向),不做加权打分——打分容易被指标搬家糊弄;
 * - nativeUpgradePlan:把 wrap / demote / tips 三种原生兼容策略变成可落库的计划。
 * 依赖纪律:只 import node:crypto(确定性分流 hash);不读写文件/网络/环境,不 import agent loop、
 * gateway 与 experiment-store(实验台账要落盘,本模块只产出「#192 兼容最小对象」由上层去写)。
 * 时间一律由调用方以数字时间戳传入,未传时记 0(不读时钟,保证同一输入永远同一输出)。
 * 全部函数:输入非法返回稳定码、绝不 throw;不改入参、只返回新对象。
 */

import { createHash } from "node:crypto";

/** 协议 schema 版本:字段语义变化时递增,读取方据此迁移。 */
export const TOOL_UPGRADE_VERSION = 1;

/** 升级段位(顺序即升级顺序):影子 → 灰度 → 接管 → 下线。 */
export type UpgradeStage = "shadow" | "canary" | "switch" | "retire";

/** 全部段位(固定顺序,用于校验与输出)。 */
export const UPGRADE_STAGES = ["shadow", "canary", "switch", "retire"] as const;

/** 灰度分流作用域:会话 / 项目 / 百分比。 */
export type CanaryScope = "session" | "project" | "percent";

/** 灰度配置:percent 钳在 0..100;sessions/projects 是命中名单(只按全等匹配)。 */
export interface CanaryConfig {
  scope: CanaryScope;
  percent?: number;
  sessions?: string[];
  projects?: string[];
}

/** 一个工具版本:stage 是段位,demotedFrom/keepWindows 只在降级后的旧版上出现。 */
export interface ToolVersion {
  version: string;
  stage: UpgradeStage;
  alias?: string;
  demotedFrom?: string;
  registeredAt: number;
  retiredAt?: number;
  keepWindows?: number;
  canary?: CanaryConfig;
}

/** 一条升级动作留痕:from/to 是版本号,experimentId 关联 #192 实验。 */
export interface UpgradeHistoryEntry {
  at: number;
  action: "init" | "shadow" | "canary" | "switch" | "rollback" | "retire";
  from?: string;
  to?: string;
  experimentId?: string;
}

/** 同名工具的升级现场:current 是此刻接管的版本,versions/history 只增不减(供回放)。 */
export interface UpgradeState {
  name: string;
  current: string;
  aliasMap: Record<string, string>;
  versions: ToolVersion[];
  history: UpgradeHistoryEntry[];
}

/** 守卫指标:direction 是「好方向」——increase=越高越好,decrease=越低越好。 */
export interface UpgradeGuardrail {
  metric: string;
  direction: "increase" | "decrease";
  threshold: number;
}

/** 双跑结论:pass/fail + 码 + 共有指标的相对变化百分比。 */
export interface DualRunResult {
  ok: boolean;
  verdict: "pass" | "fail";
  codes: string[];
  deltas: Record<string, number>;
  reason?: string;
}

/** 解析结果:source 说明这次调用落在当前版 / 灰度版 / 显式别名上。 */
export interface ResolveResult {
  ok: boolean;
  codes: string[];
  version: string;
  stage: UpgradeStage | "";
  source: "current" | "canary" | "alias" | "";
}

/** 原生兼容策略计划:wrap=包一层钩子,demote=降级到后继,tips=只给用法迁移提示。 */
export type NativeUpgradePlan =
  | { ok: true; codes: string[]; kind: "wrap"; ref: string; hooks: { pre: string; post: string }; note: string }
  | {
      ok: true;
      codes: string[];
      kind: "demote";
      ref: string;
      successor: string;
      alias: { from: string; to: string };
      note: string;
    }
  | { ok: true; codes: string[]; kind: "tips"; ref: string; tips: string[]; note: string };

/** #192 实验台账兼容的最小实验对象(落盘由 experiment-store 负责)。 */
export interface ToolUpExperimentRecord {
  hypothesis: { claim: string; mechanism: string; expectedEffect: string };
  intervention: { surface: "tool"; ref: string; variant: string };
  guardrails: unknown[];
  canary: { scope: "session"; sessions: number; status: "pending" };
  strata: unknown[];
  metrics: unknown[];
  rollbackPoint: { kind: "flag"; ref: string };
  decision: { kind: "pending" };
}

/** 稳定码(逐个导出,便于按码断言而不是比字符串字面量)。 */
export const TOOL_UP_INVALID = "TOOL_UP_INVALID";
export const TOOL_UP_SHADOW_STARTED = "TOOL_UP_SHADOW_STARTED";
export const TOOL_UP_CANARY_PROMOTED = "TOOL_UP_CANARY_PROMOTED";
export const TOOL_UP_SWITCHED = "TOOL_UP_SWITCHED";
export const TOOL_UP_RETIRED = "TOOL_UP_RETIRED";
export const TOOL_UP_ROLLED_BACK = "TOOL_UP_ROLLED_BACK";
export const TOOL_UP_NOT_FOUND = "TOOL_UP_NOT_FOUND";
export const TOOL_UP_STAGE_ORDER = "TOOL_UP_STAGE_ORDER";
export const TOOL_UP_KEEP_WINDOW_ACTIVE = "TOOL_UP_KEEP_WINDOW_ACTIVE";
export const TOOL_UP_NATIVE_STRATEGY = "TOOL_UP_NATIVE_STRATEGY";
export const TOOL_UP_DUAL_RUN_PASS = "TOOL_UP_DUAL_RUN_PASS";
export const TOOL_UP_DUAL_RUN_FAIL = "TOOL_UP_DUAL_RUN_FAIL";
export const TOOL_UP_GUARDRAIL_BREACH = "TOOL_UP_GUARDRAIL_BREACH";

/** 码表只读对象(冻结):上游按名取码,不写字面量。 */
export const TOOL_UP_CODES = Object.freeze({
  TOOL_UP_INVALID,
  TOOL_UP_SHADOW_STARTED,
  TOOL_UP_CANARY_PROMOTED,
  TOOL_UP_SWITCHED,
  TOOL_UP_RETIRED,
  TOOL_UP_ROLLED_BACK,
  TOOL_UP_NOT_FOUND,
  TOOL_UP_STAGE_ORDER,
  TOOL_UP_KEEP_WINDOW_ACTIVE,
  TOOL_UP_NATIVE_STRATEGY,
  TOOL_UP_DUAL_RUN_PASS,
  TOOL_UP_DUAL_RUN_FAIL,
  TOOL_UP_GUARDRAIL_BREACH,
} as const);

/** 段位先后(升序比较用;retire 最大)。 */
const STAGE_RANK: Record<UpgradeStage, number> = { shadow: 0, canary: 1, switch: 2, retire: 3 };

/** 旧的 current 被降级时保留的观察窗口数(每次后续 switch 消耗一个窗口)。 */
const DEMOTED_KEEP_WINDOWS = 2;

/** 失败/成功的最小返回外壳(state 类函数共用)。 */
export interface StateResult {
  ok: boolean;
  codes: string[];
  state?: UpgradeState;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStage(value: unknown): value is UpgradeStage {
  return value === "shadow" || value === "canary" || value === "switch" || value === "retire";
}

function isScope(value: unknown): value is CanaryScope {
  return value === "session" || value === "project" || value === "percent";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** state 合法性:五个字段结构齐备(name/current 非空),否则一律 TOOL_UP_INVALID。 */
function isValidState(state: unknown): state is UpgradeState {
  if (!isRecord(state)) return false;
  if (!nonEmpty(state["name"]) || !nonEmpty(state["current"])) return false;
  if (!isRecord(state["aliasMap"])) return false;
  if (!Array.isArray(state["versions"]) || !Array.isArray(state["history"])) return false;
  return true;
}

/** 深拷贝可变的三个面(versions/aliasMap/history),canary 名单也拷一份,入参永不被改写。 */
function cloneState(state: UpgradeState): UpgradeState {
  return {
    name: state.name,
    current: state.current,
    aliasMap: { ...state.aliasMap },
    versions: state.versions.map((v) => {
      const copy: ToolVersion = { ...v };
      if (v.canary !== undefined) {
        const canary: CanaryConfig = { scope: v.canary.scope };
        if (v.canary.percent !== undefined) canary.percent = v.canary.percent;
        if (Array.isArray(v.canary.sessions)) canary.sessions = [...v.canary.sessions];
        if (Array.isArray(v.canary.projects)) canary.projects = [...v.canary.projects];
        copy.canary = canary;
      }
      return copy;
    }),
    history: state.history.map((h) => ({ ...h })),
  };
}

function findVersion(state: UpgradeState, version: string): ToolVersion | undefined {
  return state.versions.find((v) => v.version === version);
}

function fail(codes: string[]): StateResult {
  return { ok: false, codes };
}

/**
 * 初始化:既有在线工具的第一个版本直接以 stage="switch" 记入(它早就在线上),
 * current=version,history 记一条 init。空 name / 空 version → TOOL_UP_INVALID。
 */
export function initState(opts: { name: string; version: string; at?: number }): StateResult {
  const name = opts?.name;
  const version = opts?.version;
  if (!nonEmpty(name) || !nonEmpty(version)) return fail([TOOL_UP_INVALID]);
  const at = isFiniteNumber(opts?.at) ? opts.at : 0;
  const state: UpgradeState = {
    name,
    current: version,
    aliasMap: {},
    versions: [{ version, stage: "switch", registeredAt: at }],
    history: [{ at, action: "init", to: version }],
  };
  return { ok: true, codes: [], state };
}

/**
 * 起影子:新版本注册为 stage="shadow" 并挂到别名槽位(其名即 alias),不进 current 不抢流量。
 * - state 非法 / newVersion 空 / alias 空 / at 非有限数 / alias 已在 aliasMap → TOOL_UP_INVALID;
 * - 同版本号已注册:已处于 shadow(重复注册)→ TOOL_UP_INVALID;处于更后段位 → TOOL_UP_STAGE_ORDER。
 */
export function startShadow(
  state: UpgradeState,
  opts: { newVersion: string; alias: string; at: number },
): StateResult {
  if (!isValidState(state)) return fail([TOOL_UP_INVALID]);
  const newVersion = opts?.newVersion;
  const alias = opts?.alias;
  if (!nonEmpty(newVersion) || !nonEmpty(alias)) return fail([TOOL_UP_INVALID]);
  if (!isFiniteNumber(opts?.at)) return fail([TOOL_UP_INVALID]);

  const existing = findVersion(state, newVersion);
  if (existing !== undefined) {
    // 同版本重复注册:还在 shadow 是「重复起影子」,已往后走则是段位乱序(不允许回头重开影子)。
    return fail([existing.stage === "shadow" ? TOOL_UP_INVALID : TOOL_UP_STAGE_ORDER]);
  }
  if (Object.prototype.hasOwnProperty.call(state.aliasMap, alias)) return fail([TOOL_UP_INVALID]);

  const next = cloneState(state);
  next.versions.push({ version: newVersion, stage: "shadow", alias, registeredAt: opts.at });
  next.aliasMap[alias] = newVersion;
  next.history.push({ at: opts.at, action: "shadow", to: newVersion });
  return { ok: true, codes: [TOOL_UP_SHADOW_STARTED], state: next };
}

/** 四舍五入到 4 位小数(避免 -0 与浮点尾巴)。 */
function round4(value: number): number {
  const rounded = Math.round(value * 10000) / 10000;
  return rounded === 0 ? 0 : rounded;
}

/**
 * 双跑比对:只判两条硬判据,不加权。
 * ① 样本量:任一侧 runs(缺失按 0)< minRuns(缺省 30)→ fail,reason="sample-low";
 * ② 守卫指标:increase 时 new < threshold、decrease 时 new > threshold 即越界 → fail 且 codes 含
 *    TOOL_UP_GUARDRAIL_BREACH(同时保留 TOOL_UP_DUAL_RUN_FAIL);缺数/非有限值的指标跳过不猜。
 * deltas:两侧共有的 metric(都是有限数且 old !== 0)的相对变化百分比 ((new-old)/|old|)*100,4 位小数;
 * old=0 一律跳过(不产生 Infinity / NaN)。纯函数,不 throw。
 */
export function compareDualRun(
  input: { oldMetrics: Record<string, number>; newMetrics: Record<string, number>; guardrails?: UpgradeGuardrail[] },
  opts?: { minRuns?: number },
): DualRunResult {
  const oldMetrics: Record<string, number> = isRecord(input?.oldMetrics)
    ? (input.oldMetrics as Record<string, number>)
    : {};
  const newMetrics: Record<string, number> = isRecord(input?.newMetrics)
    ? (input.newMetrics as Record<string, number>)
    : {};
  const guardrails = Array.isArray(input?.guardrails) ? input.guardrails : [];
  const minRuns = isFiniteNumber(opts?.minRuns) ? opts.minRuns : 30;

  const deltas: Record<string, number> = {};
  for (const metric of Object.keys(oldMetrics)) {
    const oldValue = oldMetrics[metric];
    const newValue = newMetrics[metric];
    if (!isFiniteNumber(oldValue) || !isFiniteNumber(newValue)) continue;
    if (oldValue === 0) continue;
    deltas[metric] = round4(((newValue - oldValue) / Math.abs(oldValue)) * 100);
  }

  const oldRuns = isFiniteNumber(oldMetrics["runs"]) ? oldMetrics["runs"] : 0;
  const newRuns = isFiniteNumber(newMetrics["runs"]) ? newMetrics["runs"] : 0;
  const sampleLow = oldRuns < minRuns || newRuns < minRuns;

  const breached = guardrails.some((rule) => {
    if (!isRecord(rule) || !nonEmpty(rule["metric"])) return false;
    const value = newMetrics[rule["metric"]];
    if (!isFiniteNumber(value) || !isFiniteNumber(rule["threshold"])) return false;
    return rule.direction === "increase" ? value < rule.threshold : value > rule.threshold;
  });

  if (!sampleLow && !breached) {
    return { ok: true, verdict: "pass", codes: [TOOL_UP_DUAL_RUN_PASS], deltas };
  }

  // 码顺序固定:守卫越界在前、双跑失败在后(便于自动化按序断言)。
  const codes: string[] = [];
  if (breached) codes.push(TOOL_UP_GUARDRAIL_BREACH);
  codes.push(TOOL_UP_DUAL_RUN_FAIL);
  const result: DualRunResult = { ok: false, verdict: "fail", codes, deltas };
  if (sampleLow) result.reason = "sample-low";
  return result;
}

/** 灰度配置归一:percent 钳 0..100(非有限数按 0),名单只收非空字符串并去重保序。 */
function normalizeCanary(config: CanaryConfig): CanaryConfig {
  const canary: CanaryConfig = { scope: config.scope };
  if (config.scope === "percent") {
    const raw = isFiniteNumber(config.percent) ? config.percent : 0;
    canary.percent = Math.min(100, Math.max(0, raw));
  }
  const names = (list: unknown): string[] | undefined => {
    if (!Array.isArray(list)) return undefined;
    const out: string[] = [];
    for (const item of list) if (nonEmpty(item) && !out.includes(item)) out.push(item);
    return out;
  };
  const sessions = names(config.sessions);
  if (sessions !== undefined) canary.sessions = sessions;
  const projects = names(config.projects);
  if (projects !== undefined) canary.projects = projects;
  return canary;
}

/**
 * shadow → canary:版本必须存在且仍在 shadow(否则 TOOL_UP_STAGE_ORDER);canary 配置挂到版本上、
 * percent 钳 0..100、alias 与 aliasMap 原样保留(灰度期仍可按别名精确调用新版)。
 */
export function promoteCanary(
  state: UpgradeState,
  opts: { version: string; canary: CanaryConfig; at?: number },
): StateResult {
  if (!isValidState(state)) return fail([TOOL_UP_INVALID]);
  const version = opts?.version;
  if (!nonEmpty(version)) return fail([TOOL_UP_INVALID]);
  const canary = opts?.canary;
  if (!isRecord(canary) || !isScope(canary["scope"])) return fail([TOOL_UP_INVALID]);

  const target = findVersion(state, version);
  if (target === undefined) return fail([TOOL_UP_NOT_FOUND]);
  if (target.stage !== "shadow") return fail([TOOL_UP_STAGE_ORDER]);

  const at = isFiniteNumber(opts?.at) ? opts.at : 0;
  const next = cloneState(state);
  const nextTarget = findVersion(next, version);
  if (nextTarget === undefined) return fail([TOOL_UP_NOT_FOUND]);
  nextTarget.stage = "canary";
  nextTarget.canary = normalizeCanary(canary as unknown as CanaryConfig);
  next.history.push({ at, action: "canary", to: version });
  return { ok: true, codes: [TOOL_UP_CANARY_PROMOTED], state: next };
}

/**
 * canary/shadow → switch:目标接管 current;旧 current 不删,降级为「保留窗口」形态:
 * stage 仍记 "switch"(它曾经就是在线版)、demotedFrom=工具名、keepWindows=2、
 * aliasMap[旧版本号]=旧版本号(旧版仍能按版本号精确解析)。history 记 switch(from→to)。
 */
export function switchVersion(
  state: UpgradeState,
  opts: { version: string; at: number; experimentId?: string },
): StateResult {
  if (!isValidState(state)) return fail([TOOL_UP_INVALID]);
  const version = opts?.version;
  if (!nonEmpty(version)) return fail([TOOL_UP_INVALID]);
  if (!isFiniteNumber(opts?.at)) return fail([TOOL_UP_INVALID]);

  const target = findVersion(state, version);
  if (target === undefined) return fail([TOOL_UP_NOT_FOUND]);
  if (target.stage !== "shadow" && target.stage !== "canary") return fail([TOOL_UP_STAGE_ORDER]);

  const next = cloneState(state);
  const previousCurrent = next.current;
  const nextTarget = findVersion(next, version);
  if (nextTarget === undefined) return fail([TOOL_UP_NOT_FOUND]);
  nextTarget.stage = "switch";
  next.current = version;

  if (previousCurrent !== version) {
    const demoted = findVersion(next, previousCurrent);
    if (demoted !== undefined) {
      demoted.stage = "switch";
      demoted.demotedFrom = state.name;
      demoted.keepWindows = DEMOTED_KEEP_WINDOWS;
    }
    next.aliasMap[previousCurrent] = previousCurrent;
  }

  const entry: UpgradeHistoryEntry = { at: opts.at, action: "switch", from: previousCurrent, to: version };
  if (nonEmpty(opts?.experimentId)) entry.experimentId = opts.experimentId;
  next.history.push(entry);
  return { ok: true, codes: [TOOL_UP_SWITCHED], state: next };
}

/**
 * 回滚:把 current 拨回 toVersion(存在且未 retire)。被撤下的原 current 版本 stage 回 "shadow"
 * (它回到「可被 alias 灰度调用」的位置,alias 与 aliasMap 映射一概不动),
 * history 记 rollback(from=原 current,to=toVersion)。目标等于当前 current 时只留痕不改段位。
 */
export function rollback(state: UpgradeState, opts: { toVersion: string; at: number }): StateResult {
  if (!isValidState(state)) return fail([TOOL_UP_INVALID]);
  const toVersion = opts?.toVersion;
  if (!nonEmpty(toVersion)) return fail([TOOL_UP_INVALID]);
  if (!isFiniteNumber(opts?.at)) return fail([TOOL_UP_INVALID]);

  const target = findVersion(state, toVersion);
  if (target === undefined) return fail([TOOL_UP_NOT_FOUND]);

  const next = cloneState(state);
  const previousCurrent = next.current;
  next.current = toVersion;
  // 目标若是已 retire 的版本(回滚点=历史版本),回滚即「取消退役」:段位回到 switch、清 retiredAt。
  const nextTarget = findVersion(next, toVersion);
  if (nextTarget !== undefined && nextTarget.stage === "retire") {
    nextTarget.stage = "switch";
    delete nextTarget.retiredAt;
  }
  if (previousCurrent !== toVersion) {
    const demoted = findVersion(next, previousCurrent);
    if (demoted !== undefined) demoted.stage = "shadow";
  }
  next.history.push({ at: opts.at, action: "rollback", from: previousCurrent, to: toVersion });
  return { ok: true, codes: [TOOL_UP_ROLLED_BACK], state: next };
}

/** sha256 前 8 个 hex → 非负整数(确定性分流,不依赖进程内随机源)。 */
function stableHashBucket(input: string): number {
  const hex = createHash("sha256").update(input, "utf8").digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16);
}

/** 灰度分流是否命中:percent 走稳定 hash,session/project 走名单全等匹配。 */
function canaryHits(
  state: UpgradeState,
  canary: CanaryConfig,
  opts: { sessionId?: string; projectId?: string },
): boolean {
  if (canary.scope === "percent") {
    const percent = isFiniteNumber(canary.percent) ? canary.percent : 0;
    const seed = `${opts.sessionId ?? opts.projectId ?? ""}:${state.name}`;
    return stableHashBucket(seed) % 100 < percent;
  }
  if (canary.scope === "session") {
    if (!nonEmpty(opts.sessionId)) return false;
    return Array.isArray(canary.sessions) && canary.sessions.includes(opts.sessionId);
  }
  if (!nonEmpty(opts.projectId)) return false;
  return Array.isArray(canary.projects) && canary.projects.includes(opts.projectId);
}

/**
 * 解析这次调用该落在哪个版本。优先级固定:显式 alias → canary 分流 → current。
 * - alias 给出但 aliasMap 未命中 → TOOL_UP_NOT_FOUND(version 空串,不要把调用偷渡到 current);
 * - canary 只看 stage="canary" 的版本(第一个命中者),percent 缺省 0 即「先不开量」;
 * - 都没命中 → current。taskClass 目前只做前向兼容占位,不影响分流。
 */
export function resolveForCall(
  state: UpgradeState,
  opts?: { sessionId?: string; projectId?: string; taskClass?: string; alias?: string },
): ResolveResult {
  if (!isValidState(state)) return { ok: false, codes: [TOOL_UP_INVALID], version: "", stage: "", source: "" };

  const alias = opts?.alias;
  if (nonEmpty(alias)) {
    const mapped = state.aliasMap[alias];
    if (!nonEmpty(mapped)) return { ok: false, codes: [TOOL_UP_NOT_FOUND], version: "", stage: "", source: "" };
    const version = findVersion(state, mapped);
    // 显式 alias 是历史名:即使目标已 retire 也解析出来(source=alias/stage=retire),
    // 供运维按历史版本回放;普通调用(无 alias)仍只走 current/canary,下线对调用面生效。
    return { ok: true, codes: [], version: mapped, stage: version?.stage ?? "", source: "alias" };
  }

  const request = { sessionId: opts?.sessionId, projectId: opts?.projectId };
  for (const version of state.versions) {
    if (version.stage !== "canary" || version.canary === undefined) continue;
    if (canaryHits(state, version.canary, request)) {
      return { ok: true, codes: [], version: version.version, stage: "canary", source: "canary" };
    }
  }

  const currentVersion = findVersion(state, state.current);
  return { ok: true, codes: [], version: state.current, stage: currentVersion?.stage ?? "", source: "current" };
}

/** 该版本之后已发生的 switch 次数(用于 keep window 计数)。 */
function switchesSinceDemotion(state: UpgradeState, version: string): number {
  let lastDemotionIndex = -1;
  for (let i = state.history.length - 1; i >= 0; i -= 1) {
    const entry = state.history[i];
    if (entry?.action === "switch" && entry.from === version) {
      lastDemotionIndex = i;
      break;
    }
  }
  if (lastDemotionIndex < 0) return 0;
  let count = 0;
  for (let i = lastDemotionIndex + 1; i < state.history.length; i += 1) {
    if (state.history[i]?.action === "switch") count += 1;
  }
  return count;
}

/**
 * 下线版本:从当前解析中移除,但版本对象与历史继续留在 state(历史回放用 resolveHistorical)。
 * - 不存在 → TOOL_UP_NOT_FOUND;仍是 current → TOOL_UP_STAGE_ORDER(在线版必须先 switch 走);
 * - 仍被 aliasMap 指向、且降级后已发生的 switch 次数 < keepWindows(缺省 2)→ TOOL_UP_KEEP_WINDOW_ACTIVE;
 *   从未被降级(demotedFrom 缺失)的版本没有保留窗口,可直接 retire。
 */
export function retireVersion(
  state: UpgradeState,
  opts: { version: string; at: number; keepWindows?: number },
): StateResult {
  if (!isValidState(state)) return fail([TOOL_UP_INVALID]);
  const version = opts?.version;
  if (!nonEmpty(version)) return fail([TOOL_UP_INVALID]);
  if (!isFiniteNumber(opts?.at)) return fail([TOOL_UP_INVALID]);

  const target = findVersion(state, version);
  if (target === undefined) return fail([TOOL_UP_NOT_FOUND]);
  if (state.current === version) return fail([TOOL_UP_STAGE_ORDER]);

  const keepWindows = isFiniteNumber(opts?.keepWindows) ? opts.keepWindows : DEMOTED_KEEP_WINDOWS;
  const stillAliased = Object.keys(state.aliasMap).some((alias) => state.aliasMap[alias] === version);
  const demoted = nonEmpty(target.demotedFrom);
  if (stillAliased && demoted && switchesSinceDemotion(state, version) < keepWindows) {
    return fail([TOOL_UP_KEEP_WINDOW_ACTIVE]);
  }

  const next = cloneState(state);
  const nextTarget = findVersion(next, version);
  if (nextTarget === undefined) return fail([TOOL_UP_NOT_FOUND]);
  nextTarget.stage = "retire";
  nextTarget.retiredAt = opts.at;
  next.history.push({ at: opts.at, action: "retire", to: version });
  return { ok: true, codes: [TOOL_UP_RETIRED], state: next };
}

/**
 * 历史回放:按版本号取回版本对象,**包括 stage="retire"** 的版本(事故复盘要能读当时的分流与窗口)。
 * 返回副本,调用方改了也污染不到 state。
 */
export function resolveHistorical(
  state: UpgradeState,
  opts: { version: string },
): { ok: boolean; codes: string[]; version?: ToolVersion } {
  if (!isValidState(state)) return { ok: false, codes: [TOOL_UP_INVALID] };
  const version = opts?.version;
  if (!nonEmpty(version)) return { ok: false, codes: [TOOL_UP_INVALID] };
  const found = findVersion(state, version);
  if (found === undefined) return { ok: false, codes: [TOOL_UP_NOT_FOUND] };
  return { ok: true, codes: [], version: { ...found } };
}

/**
 * 原生兼容策略:某些工具没法凭空热升级(签名/系统提示/宿主限制),这时不是「不升」而是选一种降级兼容:
 * - wrap:原实现不动,前后各挂一个钩子,新版逻辑先跑在钩子侧;
 * - demote:把调用降级到后继工具(successor 必需,缺了就 TOOL_UP_NATIVE_STRATEGY);
 * - tips:只改用法提示,不改调用面——迁移责任交给模型/用户。
 * kind 非法 / ref 空 → TOOL_UP_INVALID。
 */
export function nativeUpgradePlan(opts: { kind: "wrap" | "demote" | "tips"; ref: string; successor?: string }): NativeUpgradePlan | { ok: false; codes: string[] } {
  const kind = opts?.kind;
  const ref = opts?.ref;
  if (kind !== "wrap" && kind !== "demote" && kind !== "tips") return { ok: false, codes: [TOOL_UP_INVALID] };
  if (!nonEmpty(ref)) return { ok: false, codes: [TOOL_UP_INVALID] };

  if (kind === "wrap") {
    return {
      ok: true,
      codes: [],
      kind: "wrap",
      ref,
      hooks: { pre: "调用前把入参规整成新版签名(缺省字段补齐)", post: "调用后把新版返回映射回旧版形状" },
      note: "原实现与调用面都不动,新逻辑先跑在钩子侧;双跑通过后再走 shadow/canary。",
    };
  }
  if (kind === "demote") {
    const successor = opts?.successor;
    if (!nonEmpty(successor)) return { ok: false, codes: [TOOL_UP_NATIVE_STRATEGY] };
    return {
      ok: true,
      codes: [],
      kind: "demote",
      ref,
      successor,
      alias: { from: ref, to: successor },
      note: "调用降级到后继工具,别名指向 successor 保证老调用仍可解析;不在本模块执行重定向。",
    };
  }
  return {
    ok: true,
    codes: [],
    kind: "tips",
    ref,
    tips: [
      `改用 ${ref} 的新写法时优先传结构化参数,旧的位置参数仍接受但会被规整`,
      `${ref} 新版的错误返回带码字段,请按码分支而不是匹配报错文本`,
      `${ref} 旧字段仍在但已标记弃用,迁移期请逐步换到新字段,不要混用两套写法`,
    ],
    note: "只改用法提示不改调用面;提示随版本一起发布,rollback 时提示一并回退。",
  };
}

/**
 * 造 #192 实验台账兼容的最小实验对象(不落盘,由 experiment-store 的 recordExperiment 去写):
 * hypothesis.claim / intervention.ref 必须非空(台账唯一允许 throw 的两处校验),本函数先保证。
 * 空 name / from / to → TOOL_UP_INVALID。
 */
export function buildExperimentRecord(opts: { name: string; from: string; to: string }): ToolUpExperimentRecord | { ok: false; codes: string[] } {
  const name = opts?.name;
  const from = opts?.from;
  const to = opts?.to;
  if (!nonEmpty(name) || !nonEmpty(from) || !nonEmpty(to)) return { ok: false, codes: [TOOL_UP_INVALID] };
  return {
    hypothesis: {
      claim: `升级工具 ${name} ${from}→${to}`,
      mechanism: "新版本在 shadow/canary 双跑通过后接管原名",
      expectedEffect: "指标不低于旧版",
    },
    intervention: { surface: "tool", ref: name, variant: to },
    guardrails: [],
    canary: { scope: "session", sessions: 0, status: "pending" },
    strata: [],
    metrics: [],
    rollbackPoint: { kind: "flag", ref: `tool:${name}@${from}` },
    decision: { kind: "pending" },
  };
}
