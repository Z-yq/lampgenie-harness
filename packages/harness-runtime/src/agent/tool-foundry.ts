/**
 * Tool Foundry:把会话里反复出现的「同一条命令序列」炼成候选工具(纯逻辑零 IO)。
 * 为什么需要它:RSI 每次挖掘都会看到同一批手工步骤被反复执行(打补丁、查日志、跑迁移),
 * 但「重复劳动」只是观感,不是证据——直接把一次观察升级成工具,等于把偶发行为固化成契约。
 * 本模块把这件事拆成四段可停的流水线,每段都能被否决:
 * - observe:先把一次模式观察规范化并校验(签名/步骤/成本/成败),非法输入只回 FOUNDRY_INVALID;
 * - mineCandidates:按 signature 分组,过三道门槛(频次 / 会话数 / 是否已被下线过的重复签名),
 *   再按 token 口径估出「如果做成工具能省多少」,输出排序好的候选;
 * - 影子段:startShadow → evaluateShadow,只有通过样本量与成功率双门才能 PASS,
 *   样本不足记 FOUNDRY_LOW_REUSE(继续攒,不是失败),成功率不足直接 rejected(带 rejectedAt 留痕);
 * - 注册与下线:registerCandidate 硬要求人工 approved === true,产出 DataToolSpec 交给 data 层;
 *   retireCandidate 只写状态,不删历史签名(再次挖掘会得到 duplicate-retired 而不是复活)。
 * 依赖纪律:零 import(仅 `import type` 读 DataToolSpec,编译期擦除);不读写文件/网络/环境,
 * 不 import agent loop / gateway / experiment-store。时间一律由调用方传入数字时间戳,缺省 0,
 * 保证同一输入永远同一输出。全部函数输入非法返回稳定码、绝不 throw,且不改入参(只返回新对象)。
 */

import type { DataToolSpec } from "./data-tool-registry.ts";

/** Foundry schema 版本:字段语义变化时递增。 */
export const FOUNDRY_VERSION = 1;

/** 模式种类:命令序列 / 内联脚本 / 手工步骤(顺序即默认展示顺序)。 */
export const FOUNDRY_KINDS = ["command-sequence", "inline-script", "manual-step"] as const;

export type FoundryKind = (typeof FOUNDRY_KINDS)[number];

/** 一次模式观察:某会话里按签名归一的一段重复动作与其代价。 */
export interface PatternObservation {
  id: string;
  sessionId: string;
  projectId: string;
  at: number;
  kind: FoundryKind;
  signature: string;
  steps: string[];
  cost: { tokens: number; wallMs: number; toolCalls: number };
  success: boolean;
  failureMode?: string;
}

/** 候选工具:由同签名观测聚合而来,带预估节省、契约、权限与影子/注册状态。 */
export interface ToolCandidate {
  id: string;
  name: string;
  description: string;
  sourceSignature: string;
  kind: FoundryKind;
  frequency: number;
  sessions: number;
  projects: string[];
  estimatedSavings: { tokens: number; toolCalls: number };
  contract: { parameters: Record<string, unknown>; returns?: string };
  permissions: { mode: "read" | "write" | "exec"; allowlist?: string[] };
  failureModes: string[];
  status: "candidate" | "shadow" | "registered" | "retired" | "rejected";
  shadow?: { runs: number; successes: number; rejectedAt?: number };
  dataToolSpec?: DataToolSpec;
  createdAt: number;
  updatedAt: number;
}

/** 稳定码(固定顺序,便于自动化按码断言)。 */
export const FOUNDRY_CODES = [
  "FOUNDRY_INVALID",
  "FOUNDRY_OBSERVED",
  "FOUNDRY_CANDIDATE",
  "FOUNDRY_NO_CANDIDATE",
  "FOUNDRY_SHADOW_STARTED",
  "FOUNDRY_SHADOW_PASS",
  "FOUNDRY_SHADOW_FAIL",
  "FOUNDRY_REGISTERED",
  "FOUNDRY_RETIRED",
  "FOUNDRY_DUPLICATE",
  "FOUNDRY_NEEDS_APPROVAL",
  "FOUNDRY_LOW_REUSE",
] as const;

export type FoundryCode = (typeof FOUNDRY_CODES)[number];

/** 候选名形状:与 data-tool-registry 的 NAME_RE 对齐(3..48 个小写/数字/下划线)。 */
const CANDIDATE_NAME_RE = /^[a-z0-9_]{3,48}$/;

/** 缺省门槛:同签名至少 3 次、至少 2 个会话、预估省下 60% token。 */
export const FOUNDRY_DEFAULT_MIN_OCCURRENCES = 3;
export const FOUNDRY_DEFAULT_MIN_SESSIONS = 2;
export const FOUNDRY_DEFAULT_SAVINGS_RATIO = 0.6;

/** 影子缺省门槛:至少 3 次运行、成功率不低于 0.8。 */
export const FOUNDRY_DEFAULT_SHADOW_MIN_RUNS = 3;
export const FOUNDRY_DEFAULT_SHADOW_MIN_SUCCESS_RATE = 0.8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

/** FNV-1a 32 位,输出 8 位十六进制;纯函数,同一输入永远同一输出(不用 Math.random)。 */
function hashHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 签名 → 合法 slug(非法字符折成下划线,留出前缀/哈希位确保总长 ≤ 48)。 */
function slugOf(signature: string): string {
  const base = signature
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (base.length > 0 ? base : "sig").slice(0, 37);
}

/** 签名 → 候选名:`tf_` + slug + 6 位确定性哈希。 */
function candidateNameOf(signature: string): string {
  return `tf_${slugOf(signature)}_${hashHex(signature).slice(0, 6)}`;
}

/** 观测 id 的确定性派生(同一 session/签名/时间/步骤 → 同一 id)。 */
function observationIdOf(input: {
  sessionId: string;
  projectId: string;
  signature: string;
  at: number;
  steps: string[];
}): string {
  return `obs_${hashHex(
    [input.sessionId, input.projectId, input.signature, String(input.at), input.steps.join("\u0001")].join("|"),
  )}`;
}

type ObserveResult = {
  ok: boolean;
  codes: FoundryCode[];
  observation?: PatternObservation;
  reason?: string;
};

function invalid(reason: string): ObserveResult {
  return { ok: false, codes: ["FOUNDRY_INVALID"], reason };
}

/**
 * 规范化一次模式观察:校验对象/签名/步骤/成本/种类/会话项目/成败,合法则补齐 id 与 at。
 * 非法输入只返回 FOUNDRY_INVALID + reason,绝不 throw。
 */
export function observe(input: unknown, ctx?: { id?: string; at?: number }): ObserveResult {
  if (!isPlainObject(input)) return invalid("observation 必须是普通对象");
  if (!nonEmptyString(input.signature)) return invalid("signature 必须是非空字符串");
  if (!Array.isArray(input.steps) || input.steps.length === 0) return invalid("steps 必须是非空字符串数组");
  const steps: string[] = [];
  for (const step of input.steps) {
    if (!nonEmptyString(step)) return invalid("steps 必须是非空字符串数组");
    steps.push(step.trim());
  }
  if (!isPlainObject(input.cost)) return invalid("cost 必须是对象");
  if (!isFiniteNumber(input.cost.tokens)) return invalid("cost.tokens 必须是有限数值");
  if (!isFiniteNumber(input.cost.wallMs)) return invalid("cost.wallMs 必须是有限数值");
  if (!isFiniteNumber(input.cost.toolCalls)) return invalid("cost.toolCalls 必须是有限数值");
  if (typeof input.kind !== "string" || !(FOUNDRY_KINDS as readonly string[]).includes(input.kind)) {
    return invalid("kind 必须是 command-sequence / inline-script / manual-step");
  }
  if (!nonEmptyString(input.sessionId)) return invalid("sessionId 必须是非空字符串");
  if (!nonEmptyString(input.projectId)) return invalid("projectId 必须是非空字符串");
  if (typeof input.success !== "boolean") return invalid("success 必须是布尔值");
  if (input.failureMode !== undefined && !nonEmptyString(input.failureMode)) {
    return invalid("failureMode 必须是非空字符串(可省略)");
  }

  const at = finiteOr(input.at, finiteOr(ctx?.at, 0));
  const sessionId = input.sessionId.trim();
  const projectId = input.projectId.trim();
  const signature = input.signature.trim();
  const id = ctx?.id !== undefined && nonEmptyString(ctx.id)
    ? ctx.id
    : observationIdOf({ sessionId, projectId, signature, at, steps });

  const observation: PatternObservation = {
    id,
    sessionId,
    projectId,
    at,
    kind: input.kind as FoundryKind,
    signature,
    steps,
    cost: {
      tokens: input.cost.tokens,
      wallMs: input.cost.wallMs,
      toolCalls: input.cost.toolCalls,
    },
    success: input.success,
  };
  if (nonEmptyString(input.failureMode)) observation.failureMode = input.failureMode.trim();
  return { ok: true, codes: ["FOUNDRY_OBSERVED"], observation };
}

export interface MineOptions {
  minOccurrences?: number;
  minSessions?: number;
  savingsRatio?: number;
  existing?: ToolCandidate[];
  now?: number;
}

export interface MineResult {
  candidates: ToolCandidate[];
  discarded: { signature: string; reason: string }[];
  codes: FoundryCode[];
}

/** 按签名把观测聚成候选:三道门槛 + 节省估算 + 确定性命名,输出按节省降序排序。 */
export function mineCandidates(observations: unknown, opts: MineOptions = {}): MineResult {
  if (!Array.isArray(observations)) {
    return { candidates: [], discarded: [], codes: ["FOUNDRY_INVALID"] };
  }
  const options = isPlainObject(opts) ? opts : {};
  const minOccurrences = finiteOr(options.minOccurrences, FOUNDRY_DEFAULT_MIN_OCCURRENCES);
  const minSessions = finiteOr(options.minSessions, FOUNDRY_DEFAULT_MIN_SESSIONS);
  const savingsRatio = finiteOr(options.savingsRatio, FOUNDRY_DEFAULT_SAVINGS_RATIO);
  const existing: unknown[] = Array.isArray(options.existing) ? options.existing : [];
  const now = finiteOr(options.now, 0);

  const discarded: { signature: string; reason: string }[] = [];
  const groups = new Map<string, PatternObservation[]>();
  for (const raw of observations) {
    const result = observe(raw);
    if (!result.ok || result.observation === undefined) {
      const signature = isPlainObject(raw) && typeof raw.signature === "string" ? raw.signature : "";
      discarded.push({ signature, reason: "invalid-observation" });
      continue;
    }
    const bucket = groups.get(result.observation.signature);
    if (bucket) bucket.push(result.observation);
    else groups.set(result.observation.signature, [result.observation]);
  }

  const candidates: ToolCandidate[] = [];
  for (const [signature, group] of groups) {
    const frequency = group.length;
    const sessions = new Set(group.map((entry) => entry.sessionId)).size;
    if (frequency < minOccurrences) {
      discarded.push({ signature, reason: "low-frequency" });
      continue;
    }
    if (sessions < minSessions) {
      discarded.push({ signature, reason: "single-session" });
      continue;
    }
    const retiredDuplicate = existing.some(
      (entry) => isPlainObject(entry) && entry.sourceSignature === signature && entry.status === "retired",
    );
    if (retiredDuplicate) {
      discarded.push({ signature, reason: "duplicate-retired" });
      continue;
    }

    const totalTokens = group.reduce((sum, entry) => sum + entry.cost.tokens, 0);
    const totalToolCalls = group.reduce((sum, entry) => sum + entry.cost.toolCalls, 0);
    const failureModes = [
      ...new Set(
        group
          .filter((entry) => entry.success === false && nonEmptyString(entry.failureMode))
          .map((entry) => (entry.failureMode as string).trim()),
      ),
    ].sort();
    const projects = [...new Set(group.map((entry) => entry.projectId))].sort();
    const first = group[0];
    if (first === undefined) continue;

    candidates.push({
      id: `cand_${hashHex(signature)}`,
      name: candidateNameOf(signature),
      description: `从 ${frequency} 次观测自动挖掘的工具候选(签名 ${signature})`,
      sourceSignature: signature,
      kind: first.kind,
      frequency,
      sessions,
      projects,
      estimatedSavings: {
        tokens: Math.round(totalTokens * savingsRatio),
        toolCalls: Math.max(0, totalToolCalls - frequency),
      },
      contract: { parameters: { input: { type: "string" } }, returns: "string" },
      permissions: { mode: "read" },
      failureModes,
      status: "candidate",
      createdAt: now,
      updatedAt: now,
    });
  }

  candidates.sort((a, b) => {
    if (b.estimatedSavings.tokens !== a.estimatedSavings.tokens) {
      return b.estimatedSavings.tokens - a.estimatedSavings.tokens;
    }
    if (b.frequency !== a.frequency) return b.frequency - a.frequency;
    return a.sourceSignature < b.sourceSignature ? -1 : a.sourceSignature > b.sourceSignature ? 1 : 0;
  });

  return {
    candidates,
    discarded,
    codes: candidates.length > 0 ? ["FOUNDRY_CANDIDATE"] : ["FOUNDRY_NO_CANDIDATE"],
  };
}

/** 只读渲染候选报告(文本),不改入参;空数组给明确空态。 */
export function renderCandidateReport(candidates: ToolCandidate[]): string {
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length === 0) return "Tool Foundry 候选:无(没有模式同时达到频次与会话门槛)";
  const lines: string[] = [`Tool Foundry 候选:${list.length} 个`];
  list.forEach((candidate, index) => {
    const name = typeof candidate?.name === "string" ? candidate.name : "(unknown)";
    const signature = typeof candidate?.sourceSignature === "string" ? candidate.sourceSignature : "(unknown)";
    const frequency = finiteOr(candidate?.frequency, 0);
    const sessions = finiteOr(candidate?.sessions, 0);
    const projects = Array.isArray(candidate?.projects) && candidate.projects.length > 0
      ? candidate.projects.join(", ")
      : "(无)";
    const tokens = finiteOr(candidate?.estimatedSavings?.tokens, 0);
    const toolCalls = finiteOr(candidate?.estimatedSavings?.toolCalls, 0);
    const returns = typeof candidate?.contract?.returns === "string" ? candidate.contract.returns : "(未声明)";
    const mode = typeof candidate?.permissions?.mode === "string" ? candidate.permissions.mode : "read";
    const allowlist = Array.isArray(candidate?.permissions?.allowlist) && candidate.permissions.allowlist.length > 0
      ? ` allowlist=${candidate.permissions.allowlist.join(",")}`
      : "";
    const failureModes = Array.isArray(candidate?.failureModes) && candidate.failureModes.length > 0
      ? candidate.failureModes.join(", ")
      : "(无)";
    lines.push(
      `${index + 1}. ${name}`,
      `   签名: ${signature}`,
      `   频次: ${frequency} 次 / 会话: ${sessions} 个 / 项目: ${projects}`,
      `   预估节省: tokens ${tokens} / toolCalls ${toolCalls}`,
      `   契约: parameters=input:string → returns=${returns}`,
      `   权限: ${mode}${allowlist}`,
      `   失败模式: ${failureModes}`,
    );
  });
  return lines.join("\n");
}

/** candidate → shadow:允许进影子(返回新对象,runs/successes 归零),其它状态一律 INVALID。 */
export function startShadow(candidate: ToolCandidate, now?: number): { candidate: ToolCandidate; codes: FoundryCode[] } {
  const raw = candidate as unknown;
  if (!isPlainObject(raw) || raw.status !== "candidate") {
    return { candidate, codes: ["FOUNDRY_INVALID"] };
  }
  const at = finiteOr(now, finiteOr(candidate.updatedAt, 0));
  return {
    candidate: { ...candidate, status: "shadow", shadow: { runs: 0, successes: 0 }, updatedAt: at },
    codes: ["FOUNDRY_SHADOW_STARTED"],
  };
}

export interface ShadowEvaluation {
  runs: number;
  successes: number;
  minRuns?: number;
  minSuccessRate?: number;
  now?: number;
}

/** 影子评估:样本不足 → LOW_REUSE(仍 shadow);成功率不足 → rejected;达标 → SHADOW_PASS。 */
export function evaluateShadow(
  candidate: ToolCandidate,
  input: ShadowEvaluation): { candidate: ToolCandidate; codes: FoundryCode[] } {
  const raw = candidate as unknown;
  if (!isPlainObject(raw) || raw.status !== "shadow") {
    return { candidate, codes: ["FOUNDRY_INVALID"] };
  }
  if (!isPlainObject(input)) return { candidate, codes: ["FOUNDRY_INVALID"] };
  if (!isFiniteNumber(input.runs) || input.runs < 0) return { candidate, codes: ["FOUNDRY_INVALID"] };
  if (!isFiniteNumber(input.successes) || input.successes < 0) return { candidate, codes: ["FOUNDRY_INVALID"] };
  if (input.successes > input.runs) return { candidate, codes: ["FOUNDRY_INVALID"] };

  const minRuns = finiteOr(input.minRuns, FOUNDRY_DEFAULT_SHADOW_MIN_RUNS);
  const minSuccessRate = finiteOr(input.minSuccessRate, FOUNDRY_DEFAULT_SHADOW_MIN_SUCCESS_RATE);
  const at = finiteOr(input.now, finiteOr(candidate.updatedAt, 0));
  const shadow = { runs: input.runs, successes: input.successes };

  if (input.runs < minRuns) {
    return {
      candidate: { ...candidate, status: "shadow", shadow, updatedAt: at },
      codes: ["FOUNDRY_LOW_REUSE"],
    };
  }
  const rate = input.runs === 0 ? 0 : input.successes / input.runs;
  if (rate < minSuccessRate) {
    return {
      candidate: { ...candidate, status: "rejected", shadow: { ...shadow, rejectedAt: at }, updatedAt: at },
      codes: ["FOUNDRY_SHADOW_FAIL"],
    };
  }
  return {
    candidate: { ...candidate, status: "shadow", shadow, updatedAt: at },
    codes: ["FOUNDRY_SHADOW_PASS"],
  };
}

export interface RegisterDecision {
  approved: boolean;
  now?: number;
}

/** 注册:必须 shadow 且 approved===true;已 registered → DUPLICATE;其余 → NEEDS_APPROVAL。 */
export function registerCandidate(
  candidate: ToolCandidate,
  decision: RegisterDecision): { candidate: ToolCandidate; codes: FoundryCode[] } {
  const raw = candidate as unknown;
  if (!isPlainObject(raw)) return { candidate, codes: ["FOUNDRY_INVALID"] };
  if (raw.status === "registered") return { candidate, codes: ["FOUNDRY_DUPLICATE"] };
  const approved = isPlainObject(decision) && decision.approved === true;
  if (raw.status !== "shadow" || !approved) {
    return { candidate, codes: ["FOUNDRY_NEEDS_APPROVAL"] };
  }
  const at = finiteOr(decision.now, finiteOr(candidate.updatedAt, 0));
  return {
    candidate: { ...candidate, status: "registered", dataToolSpec: toDataToolSpec(candidate), updatedAt: at },
    codes: ["FOUNDRY_REGISTERED"],
  };
}

export interface RetireDecision {
  reason: string;
  now?: number;
}

/** 下线:reason 必填;已 retired → DUPLICATE;其余 → retired(签名留作历史,不删)。 */
export function retireCandidate(
  candidate: ToolCandidate,
  decision: RetireDecision): { candidate: ToolCandidate; codes: FoundryCode[] } {
  const raw = candidate as unknown;
  if (!isPlainObject(raw)) return { candidate, codes: ["FOUNDRY_INVALID"] };
  if (raw.status === "retired") return { candidate, codes: ["FOUNDRY_DUPLICATE"] };
  if (!isPlainObject(decision) || !nonEmptyString(decision.reason)) {
    return { candidate, codes: ["FOUNDRY_INVALID"] };
  }
  const at = finiteOr(decision.now, finiteOr(candidate.updatedAt, 0));
  return { candidate: { ...candidate, status: "retired", updatedAt: at }, codes: ["FOUNDRY_RETIRED"] };
}

/** 候选 → data 层工具规格(不判断 native 冲突,交由 data-tool-registry 裁决)。 */
export function toDataToolSpec(candidate: ToolCandidate): DataToolSpec {
  const raw: Record<string, unknown> = isPlainObject(candidate) ? candidate : {};
  const name = typeof raw.name === "string" && CANDIDATE_NAME_RE.test(raw.name) ? raw.name : "tf_invalid_000000";
  const sourceSignature = typeof raw.sourceSignature === "string" ? raw.sourceSignature : name;
  const description = typeof raw.description === "string" ? raw.description : "";
  const contract = isPlainObject(raw.contract) ? raw.contract : {};
  const parameters = isPlainObject(contract.parameters) ? contract.parameters : { input: { type: "string" } };
  const permissions = isPlainObject(raw.permissions) ? raw.permissions : {};
  const mode = permissions.mode === "write" || permissions.mode === "exec" ? permissions.mode : "read";
  const spec: DataToolSpec = {
    name,
    version: "1.0.0",
    owner: "tool-foundry",
    description,
    parameters,
    handler: { kind: "command", ref: sourceSignature },
    permissions: { mode },
    layer: "data",
    registeredBy: "rsi",
  };
  if (Array.isArray(permissions.allowlist)) {
    spec.permissions.allowlist = permissions.allowlist.filter((entry): entry is string => typeof entry === "string");
  }
  return spec;
}
