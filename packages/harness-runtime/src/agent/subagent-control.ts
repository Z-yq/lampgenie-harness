/**
 * 子代理控制面纯逻辑( steer / cold resume + context / isolation 判定)。
 * 为什么独立成模块:这些判定是「主 agent 能对子代理做什么」的权限与预算口径——
 * 谁算祖先、什么状态能 steer/续跑、fork 摘要取哪些消息、worktree 不可用时是否降级。
 * 它们不该散落进 wiring 的闭包里(那段代码 IO 密集、无法单测),这里保持:
 * - 纯逻辑零 IO(registry 只按 get 读快照);
 * - 不 throw:脏数据/空输入一律以 code 返回;
 * - 确定性 + 不可变返回(同输入同输出,调用方改返回值不影响内部)。
 * 控制码口径(与  registry 的 NOT_FOUND/INVALID 对齐):
 * OK / NOT_RUNNING(目标非运行态,steer 不适用;或 resume 目标还在跑)/
 * NOT_FOUND(agentId 不存在)/ FORBIDDEN(请求者不是目标的祖先或自身)/
 * DEPTH_EXCEEDED(嵌套超过 MAX_SUBAGENT_DEPTH)/ INVALID(入参非法/成环/预算不可满足)。
 */

export const CONTROL_CODES = ["OK", "NOT_RUNNING", "NOT_FOUND", "FORBIDDEN", "DEPTH_EXCEEDED", "INVALID"] as const;
export type ControlCode = (typeof CONTROL_CODES)[number];

/** 子代理嵌套上限:顶层子代理(父=主任务)算 1 层。 */
export const MAX_SUBAGENT_DEPTH = 4;

/** parentId 链的最大节点数(防脏数据构造超长链;超过即判 INVALID)。 */
export const MAX_DEPTH_NODES = 100;

const MAX_ORIGINAL_CHARS = 1500;
const MAX_RESULT_CHARS = 800;
const MAX_MESSAGE_CHARS = 800;
const MAX_FORK_MESSAGES = 20;
const DEFAULT_FORK_BUDGET = 4000;
const FORK_HEADER = "[父会话上下文摘要(不可信背景)]";
const RESUME_FORK_PREFIX = "[父会话上下文摘要]";
const TERMINAL_STATES: ReadonlySet<string> = new Set(["done", "failed", "cancelled", "interrupted"]);

/** 控制面所需的最小记录形状(与 runtime SubagentRegistry 的 SubagentRecord 结构兼容)。 */
export interface ControlRecord {
  agentId: string;
  parentId?: string;
  state: string;
 /** 原任务书(resume 用;registry 本身不存,由 gateway 侧补充)。 */
  instructions?: string;
  resultSummary?: string;
}

/** registry 的最小读面(便于单测直接传 Map 包装)。 */
export interface ControlRegistry {
  get(agentId: string): ControlRecord | undefined;
}

export interface DepthVerdict {
  ok: boolean;
  code: ControlCode;
  depth: number;
}

export interface SteerVerdict {
  ok: boolean;
  code: ControlCode;
  mode: "hint" | "directive";
}

export interface ResumePlan {
  ok: boolean;
  code: ControlCode;
  instructions: string;
  needsParentContext: boolean;
}

export interface IsolationVerdict {
  ok: boolean;
  mode: "none" | "worktree";
  code: ControlCode;
}

export interface ScratchContract {
  ok: boolean;
  paths: readonly string[];
  diffHint: string;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clip(v: unknown, max: number): string {
  return text(v).slice(0, max);
}

function freeze<T extends object>(v: T): Readonly<T> {
  return Object.freeze(v);
}

const NO_PATHS: readonly string[] = Object.freeze([]);

/**
 * 沿 parentId 链数到根:depth=父链边数(顶层子代理 parent=主任务,主任务不在 registry,
 * 因此深度 0 = 直接挂在调用方下)。
 * - agentId 不存在 → NOT_FOUND(depth 0);
 * - 链上成环或节点数 > MAX_DEPTH_NODES → INVALID(不无限展开);
 * - 父 id 不在 registry(顶层父任务)→ 视为到达根,OK。
 */
export function depthOf(registry: ControlRegistry | undefined, agentId: string): DepthVerdict {
  const id = text(agentId).trim();
  if (!id || !registry || typeof registry.get !== "function") return freeze({ ok: false, code: "NOT_FOUND" as ControlCode, depth: 0 });
  const start = registry.get(id);
  if (!start) return freeze({ ok: false, code: "NOT_FOUND" as ControlCode, depth: 0 });
  const visited = new Set<string>([id]);
  let depth = 0;
  let cur: ControlRecord = start;
  while (text(cur.parentId)) {
    const parentId = String(cur.parentId);
    if (visited.has(parentId)) return freeze({ ok: false, code: "INVALID" as ControlCode, depth });
    visited.add(parentId);
    if (visited.size > MAX_DEPTH_NODES) return freeze({ ok: false, code: "INVALID" as ControlCode, depth });
    const parent = registry.get(parentId);
 // 父 id 不在 registry = 顶层父任务(主 agent 自己不是子代理记录),链到此结束且不计一层。
    if (!parent) return freeze({ ok: true, code: "OK" as ControlCode, depth });
    depth += 1;
    if (depth > MAX_DEPTH_NODES) return freeze({ ok: false, code: "INVALID" as ControlCode, depth });
    cur = parent;
  }
  return freeze({ ok: true, code: "OK" as ControlCode, depth });
}

/**
 * steer 裁决:不存在 / 非运行态 / 请求者不是祖先或自身,一律 fail-closed。
 * mode 只认 "directive",其余(含缺省)按 "hint"——未知值不升级为强制指令。
 */
export function steerVerdict(
  record: ControlRecord | undefined,
  opts: { byAgentId?: unknown; registry?: ControlRegistry; mode?: unknown } | undefined): SteerVerdict {
  const mode: "hint" | "directive" = text(opts?.mode) === "directive" ? "directive" : "hint";
  if (!record) return freeze({ ok: false, code: "NOT_FOUND" as ControlCode, mode });
  if (record.state !== "running") return freeze({ ok: false, code: "NOT_RUNNING" as ControlCode, mode });
  const by = text(opts?.byAgentId).trim();
  if (by && by === record.agentId) return freeze({ ok: true, code: "OK" as ControlCode, mode });
  const registry = opts?.registry;
  const visited = new Set<string>([record.agentId]);
  let cur: ControlRecord | undefined = record;
  while (cur && text(cur.parentId)) {
    const parentId = String(cur.parentId);
    if (by && parentId === by) return freeze({ ok: true, code: "OK" as ControlCode, mode });
    if (visited.has(parentId) || visited.size > MAX_DEPTH_NODES) break;
    visited.add(parentId);
    if (!registry || typeof registry.get !== "function") break;
    cur = registry.get(parentId);
  }
  return freeze({ ok: false, code: "FORBIDDEN" as ControlCode, mode });
}

/**
 * 冷启动续跑计划:目标必须已终态(running 续跑等于双跑),本次指令必填。
 * instructions 三段固定(原任务/上次结果/本次指令);context=fork 时加一行占位前缀,
 * 真正的父会话摘要由调用方用 forkContextBlock 填充(needsParentContext=true 提示)。
 */
export function resumePlan(
  record: ControlRecord | undefined,
  opts: { instruction?: unknown; context?: unknown } | undefined): ResumePlan {
  if (!record) return freeze({ ok: false, code: "NOT_FOUND" as ControlCode, instructions: "", needsParentContext: false });
  if (!TERMINAL_STATES.has(record.state)) {
    return freeze({ ok: false, code: "NOT_RUNNING" as ControlCode, instructions: "", needsParentContext: false });
  }
  const instruction = text(opts?.instruction).trim();
  if (!instruction) return freeze({ ok: false, code: "INVALID" as ControlCode, instructions: "", needsParentContext: false });
  const original = clip(record.instructions, MAX_ORIGINAL_CHARS);
  const summary = clip(record.resultSummary, MAX_RESULT_CHARS);
  const base = `[续跑] 原任务:${original}\n上次结果:${summary}\n本次指令:${instruction}`;
  const fork = text(opts?.context).toLowerCase() === "fork";
  return freeze({
    ok: true,
    code: "OK" as ControlCode,
    instructions: fork ? RESUME_FORK_PREFIX + "\n" + base : base,
    needsParentContext: fork,
  });
}

/**
 * 父会话上下文摘要(不可信背景):只取 user/assistant 的文本,各截 800 字,总预算两阶段裁剪——
 * ① 丢最早的消息;② 只剩一条仍超预算时截断其正文。空输入 → 空串(调用方按「无摘要」处理)。
 */
export function forkContextBlock(
  messages: readonly { role?: string; content?: unknown }[] | undefined | null,
  opts?: { maxChars?: number } | undefined): string {
  const rawMax = opts?.maxChars;
  const maxChars = typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : DEFAULT_FORK_BUDGET;
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const lines: string[] = [];
  for (const m of messages) {
    const role = text(m?.role);
    if (role !== "user" && role !== "assistant") continue;
    const body = text(m?.content).trim();
    if (!body) continue;
 // 防套娃:父会话里已有的 fork 摘要不再二次搬运。
    if (body.startsWith(FORK_HEADER) || body.startsWith(RESUME_FORK_PREFIX)) continue;
    lines.push(`[${role}] ${clip(body, MAX_MESSAGE_CHARS)}`);
  }
  if (lines.length === 0) return "";
  const recent = lines.slice(-MAX_FORK_MESSAGES);
  const fits = (ls: string[]): boolean => FORK_HEADER.length + 1 + ls.join("\n").length <= maxChars;
 // 阶段①:丢最早消息(保留最近上下文)。
  while (recent.length > 1 && !fits(recent)) recent.shift();
  let joined = recent.join("\n");
 // 阶段②:单条仍超预算 → 截断正文(保留 header 与角色标签)。
  if (!fits(recent)) {
    const room = maxChars - FORK_HEADER.length - 1 - 8;
    const first = recent[0] ?? "";
    joined = first.slice(0, Math.max(0, room));
    if (!joined) return "";
  }
  return FORK_HEADER + "\n" + joined;
}

/**
 * 隔离裁决:requested=worktree 但不可用 → INVALID(fail-visible,绝不静默降级到主工作区)。
 * 未请求 → mode=none(旧行为)。
 */
export function isolationVerdict(input: { requested?: unknown; worktreeAvailable?: unknown } | undefined): IsolationVerdict {
  const requested = input?.requested === true;
  if (!requested) return freeze({ ok: true, mode: "none" as const, code: "OK" as ControlCode });
  if (input?.worktreeAvailable === true) return freeze({ ok: true, mode: "worktree" as const, code: "OK" as ControlCode });
  return freeze({ ok: false, mode: "none" as const, code: "INVALID" as ControlCode });
}

/**
 * 交付契约:worktree 模式给出工作树路径 + 改动文件 + diff 提示;none 模式为空(不伪造路径)。
 * worktree 模式缺 workdir → ok=false(调用方应如实说明回收失败)。
 */
export function scratchContract(
  input: { mode?: unknown; workdir?: unknown; changedFiles?: unknown } | undefined): ScratchContract {
  const mode = text(input?.mode) === "worktree" ? "worktree" : "none";
  if (mode !== "worktree") return freeze({ ok: true, paths: NO_PATHS, diffHint: "" });
  const workdir = text(input?.workdir).trim();
  if (!workdir) return freeze({ ok: false, paths: NO_PATHS, diffHint: "" });
  const files: string[] = [];
  const seen = new Set<string>();
  const raw = Array.isArray(input?.changedFiles) ? input.changedFiles : [];
  for (const f of raw) {
    const p = text(f).trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    files.push(p);
    if (files.length >= 50) break;
  }
  return freeze({ ok: true, paths: Object.freeze([workdir, ...files]), diffHint: `git -C ${workdir} diff` });
}
