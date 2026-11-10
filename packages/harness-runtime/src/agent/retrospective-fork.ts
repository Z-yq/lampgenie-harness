/**
 * 后台复盘 fork(Retrospective Fork):主对话每积累 10 个 user turn 或 10 次 tool iteration,
 * 在「本轮有 final response、未被打断、非 cron 触发、非 nudge 会话、fork 深度未超限」时,
 * fork 一个只读、完全 detach 的复盘会话;它只许看(memory/skills/read/search/grep),
 * 不许写文件、不许开 terminal,产出作为「洞察」写进证据图,供夜间整合聚合。
 * 为什么单独一层纯逻辑:
 * - 触发口径(计数 + 四个跳过条件 + 阈值)必须能被单测逐条钉住,不能和调度器/文件 IO 搅在一起;
 * - fork 规格(继承 system prompt / tools / cache scope,白名单取交集,deny 固定四项)是安全边界,
 *   任何工具调用都要在纯函数里判一次,而不是指望调用方自觉;
 * - 复盘产物必须带幂等键 `retro:<session>:<retroCount>`,重复写不进账本 —— 去重判断同样属于纯逻辑。
 * 红线:零 IO(不读文件 / 网络 / 环境);不 throw;不 mutate 入参;时间一律 epoch ms,
 * 每个会写时间的函数都可注入 at(缺省 Date.now() 只用于生产路径,测试一律显式传)。
 * 深度限制:fork 出的会话 depth = 父 depth + 1、nudge = 0;maxDepth 缺省 1,即最多一层复盘,
 * 复盘的复盘被 SKIPPED_DEPTH 挡掉,天然禁递归。
 */

/** schema 版本:字段语义变化时递增。 */
export const RETRO_VERSION = 1;

/** 复盘 fork 的工具白名单(fork 侧只读能力)。 */
export const RETRO_FORK_TOOL_WHITELIST = ["memory", "skill_view", "read_file", "search", "grep"] as const;

/** fork 侧显式拒绝的工具(即便父会话有,也绝不继承)。 */
export const RETRO_FORK_DENY = ["write_file", "edit_file", "terminal", "run_code"] as const;

/** 缺省策略:10 个 user turn / 10 次 tool iteration 触发,最多一层复盘。 */
export const DEFAULT_RETRO_POLICY: Required<RetroPolicy> = {
  userTurns: 10,
  toolIterations: 10,
  maxDepth: 1,
};

/** 稳定码:调用方按码分支,不解析文案。 */
export const RETRO_CODES = {
  INVALID: "RETRO_INVALID",
  TRIGGERED: "RETRO_TRIGGERED",
  SKIPPED_INTERRUPTED: "RETRO_SKIPPED_INTERRUPTED",
  SKIPPED_CRON: "RETRO_SKIPPED_CRON",
  SKIPPED_NUDGE: "RETRO_SKIPPED_NUDGE",
  SKIPPED_DEPTH: "RETRO_SKIPPED_DEPTH",
  FORK_SPEC: "RETRO_FORK_SPEC",
  TOOL_DENIED: "RETRO_TOOL_DENIED",
  ARTIFACT: "RETRO_ARTIFACT",
  ARTIFACT_DUPLICATE: "RETRO_ARTIFACT_DUPLICATE",
  DONE: "RETRO_DONE",
} as const;

export type RetroCode = (typeof RETRO_CODES)[keyof typeof RETRO_CODES];

/** 触发计数状态(持久化后跨进程恢复)。 */
export interface RetroState {
  userTurns: number;
  toolIterations: number;
  /** 上次复盘完成的 epoch ms(从未复盘为 undefined)。 */
  lastRetroAt?: number;
  /** 已完成的复盘轮数(幂等键的序号来源)。 */
  retroCount: number;
  /** >0 表示本会话是被 nudge 拉起的,禁递归复盘。 */
  nudge: number;
  /** fork 深度:主线 0,复盘会话 1。 */
  depth: number;
}

/** 事件种类:计数两类,触发判定三类,完成一类。 */
export const RETRO_EVENT_KINDS = [
  "user-turn",
  "tool-iteration",
  "final-response",
  "interrupt",
  "cron",
  "retro-done",
] as const;

export type RetroEventKind = (typeof RETRO_EVENT_KINDS)[number];

export interface RetroEvent {
  kind: RetroEventKind;
  at?: number;
}

export interface RetroPolicy {
  userTurns?: number;
  toolIterations?: number;
  maxDepth?: number;
}

export interface RetroDecision {
  trigger: boolean;
  reason: string;
  codes: RetroCode[];
}

/** 父会话 → fork 需要的三个继承面(detach 持久化,故只带这三样 + 身份)。 */
export interface RetroForkParent {
  systemPrompt: string;
  tools: readonly string[];
  cacheScope: string;
  depth?: number;
  sessionId?: string;
  taskId?: string;
}

/** fork 规格:detached 永真、nudge 永 0、deny 固定四项。 */
export interface RetroForkSpec {
  systemPrompt: string;
  tools: string[];
  cacheScope: string;
  detached: true;
  depth: number;
  nudge: 0;
  deny: string[];
  sessionId?: string;
  taskId?: string;
}

export interface RetroForkSpecResult {
  ok: boolean;
  spec?: RetroForkSpec;
  code: RetroCode;
}

export interface RetroToolDecision {
  ok: boolean;
  reason: string;
  code?: RetroCode;
}

/** 证据图输入:kind 固定 insight;associations 只带 session/task 两根关联。 */
export interface RetroArtifact {
  kind: "insight";
  statement: string;
  associations: { session: string; task?: string };
  idempotencyKey: string;
  confidence: number;
  evidenceRefs: string[];
  sessionId: string;
  retroCount: number;
  at?: number;
}

/** 产物构造所需的 fork 身份面(从 RetroForkSpec / 持久化状态里取)。 */
export interface RetroArtifactFork {
  sessionId?: string;
  taskId?: string;
  retroCount?: number;
}

export interface RetroArtifactInput {
  summary: string;
  evidenceRefs?: readonly string[];
  taskId?: string;
  confidence?: number;
  at?: number;
}

export interface RetroArtifactResult {
  ok: boolean;
  artifact?: RetroArtifact;
  code: RetroCode;
}

/** 产物缺省置信度:复盘结论是自述,不该一上来就按满信记账。 */
const DEFAULT_ARTIFACT_CONFIDENCE = 0.6;

/** 危险命令特征:命中即 DENY(fork 只读,不该出现这些字样,出现就按最坏情况处理)。 */
const DANGEROUS_COMMANDS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\brm\s+(-[^\s]+\s+)*--?[a-z]*[rf]/i, label: "rm-recursive" },
  { pattern: /\b(mkfs(\.\w+)?|fdisk)\b/i, label: "filesystem-write" },
  { pattern: /\bdd\s+if=/i, label: "dd-write" },
  { pattern: /\bsudo\b/i, label: "privilege-escalation" },
  { pattern: /\b(curl|wget)\b[^\n|;]*\|\s*(\w+\s+)*(ba|z|da)?sh\b/i, label: "remote-pipe-shell" },
  { pattern: /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f)\b/i, label: "git-destructive" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, label: "host-shutdown" },
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/, label: "fork-bomb" },
];

/** 空状态(主线会话起点)。 */
export function emptyRetroState(): RetroState {
  return { userTurns: 0, toolIterations: 0, retroCount: 0, nudge: 0, depth: 0 };
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Math.floor(value) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeState(input: unknown): RetroState {
  const record = isRecord(input) ? input : {};
  const state: RetroState = {
    userTurns: isNonNegInt(record["userTurns"]) ? record["userTurns"] : 0,
    toolIterations: isNonNegInt(record["toolIterations"]) ? record["toolIterations"] : 0,
    retroCount: isNonNegInt(record["retroCount"]) ? record["retroCount"] : 0,
    nudge: isNonNegInt(record["nudge"]) ? record["nudge"] : 0,
    depth: isNonNegInt(record["depth"]) ? record["depth"] : 0,
  };
  const lastRetroAt = record["lastRetroAt"];
  if (typeof lastRetroAt === "number" && Number.isFinite(lastRetroAt)) state.lastRetroAt = lastRetroAt;
  return state;
}

function isValidState(input: unknown): input is RetroState {
  if (!isRecord(input)) return false;
  const keys: (keyof RetroState)[] = ["userTurns", "toolIterations", "retroCount", "nudge", "depth"];
  for (const key of keys) if (!isNonNegInt(input[key])) return false;
  const lastRetroAt = input["lastRetroAt"];
  return lastRetroAt === undefined || (typeof lastRetroAt === "number" && Number.isFinite(lastRetroAt));
}

/** 事件种类判定(导出给持久层复用)。 */
export function isRetroEventKind(value: unknown): value is RetroEventKind {
  return typeof value === "string" && (RETRO_EVENT_KINDS as readonly string[]).includes(value);
}

function isValidEvent(value: unknown): value is RetroEvent {
  if (!isRecord(value)) return false;
  if (!isRetroEventKind(value["kind"])) return false;
  const at = value["at"];
  return at === undefined || (typeof at === "number" && Number.isFinite(at));
}

function normalizePolicy(input: unknown): Required<RetroPolicy> | null {
  if (input === undefined) return { ...DEFAULT_RETRO_POLICY };
  if (!isRecord(input)) return null;
  const out: Required<RetroPolicy> = { ...DEFAULT_RETRO_POLICY };
  for (const key of ["userTurns", "toolIterations", "maxDepth"] as const) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || Math.floor(raw) !== raw) return null;
    out[key] = raw;
  }
  return out;
}

function skipped(code: RetroCode | undefined, reason: string): RetroDecision {
  return code === undefined ? { trigger: false, reason, codes: [] } : { trigger: false, reason, codes: [code] };
}

/**
 * 触发判定:state 为**事件发生前**的状态(计数由 updateState 累积,这里不再重复加)。
 * 顺序:非法 → interrupt → cron → retro-done → nudge → depth → 必须是 final-response → 阈值。
 */
export function shouldTrigger(
  state: RetroState,
  event: RetroEvent,
  policy: RetroPolicy = DEFAULT_RETRO_POLICY): RetroDecision {
  if (!isValidState(state) || !isValidEvent(event)) return skipped(RETRO_CODES.INVALID, "invalid-state-or-event");
  const normalized = normalizePolicy(policy);
  if (normalized === null) return skipped(RETRO_CODES.INVALID, "invalid-policy");
  if (event.kind === "interrupt") return skipped(RETRO_CODES.SKIPPED_INTERRUPTED, "interrupted");
  if (event.kind === "cron") return skipped(RETRO_CODES.SKIPPED_CRON, "cron");
  if (event.kind === "retro-done") return skipped(undefined, "retro-done");
  if (state.nudge > 0) return skipped(RETRO_CODES.SKIPPED_NUDGE, `nudge=${state.nudge}`);
  if (state.depth >= normalized.maxDepth) return skipped(RETRO_CODES.SKIPPED_DEPTH, `depth=${state.depth}`);
  if (event.kind !== "final-response") return skipped(undefined, `not-final-response:${event.kind}`);
  const byTurns = state.userTurns >= normalized.userTurns;
  const byTools = state.toolIterations >= normalized.toolIterations;
  if (!byTurns && !byTools) {
    return skipped(undefined, `below-threshold:userTurns=${state.userTurns},toolIterations=${state.toolIterations}`);
  }
  const hit = [byTurns ? `userTurns>=${normalized.userTurns}` : "", byTools ? `toolIterations>=${normalized.toolIterations}` : ""]
    .filter((part) => part !== "")
    .join("+");
  return { trigger: true, reason: `triggered:${hit}`, codes: [RETRO_CODES.TRIGGERED] };
}

/** 计数推进:user-turn / tool-iteration 各加一;retro-done 走复位;其余事件不改计数。 */
export function updateState(state: RetroState, event: RetroEvent): RetroState {
  const base = normalizeState(state);
  if (!isValidEvent(event)) return base;
  switch (event.kind) {
    case "user-turn":
      return { ...base, userTurns: base.userTurns + 1 };
    case "tool-iteration":
      return { ...base, toolIterations: base.toolIterations + 1 };
    case "retro-done":
      return markRetroDone(base, { at: event.at }).state;
    default:
      return base;
  }
}

function isForkParent(input: unknown): input is RetroForkParent {
  if (!isRecord(input)) return false;
  if (typeof input["systemPrompt"] !== "string") return false;
  if (typeof input["cacheScope"] !== "string") return false;
  const tools = input["tools"];
  if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")) return false;
  const depth = input["depth"];
  if (depth !== undefined && !isNonNegInt(depth)) return false;
  return true;
}

/**
 * 构造 fork 规格:systemPrompt / cacheScope 原样继承;tools = 候选白名单 ∩ 父工具(保序去重);
 * detach 持久化(detached=true)、depth=父+1、nudge=0、deny 固定四项。
 */
export function buildForkSpec(
  parent: RetroForkParent,
  opts: { tools?: readonly string[] } = {},
): RetroForkSpecResult {
  if (!isForkParent(parent)) return { ok: false, code: RETRO_CODES.INVALID };
  const candidates = opts.tools ?? RETRO_FORK_TOOL_WHITELIST;
  if (!Array.isArray(candidates) || !candidates.every((tool) => typeof tool === "string")) {
    return { ok: false, code: RETRO_CODES.INVALID };
  }
  const parentTools = new Set(parent.tools);
  const tools: string[] = [];
  for (const tool of candidates) {
    const name = tool.trim();
    if (name === "" || !parentTools.has(name) || tools.includes(name)) continue;
    tools.push(name);
  }
  const spec: RetroForkSpec = {
    systemPrompt: parent.systemPrompt,
    tools,
    cacheScope: parent.cacheScope,
    detached: true,
    depth: (parent.depth ?? 0) + 1,
    nudge: 0,
    deny: [...RETRO_FORK_DENY],
  };
  if (parent.sessionId !== undefined) spec.sessionId = parent.sessionId;
  if (parent.taskId !== undefined) spec.taskId = parent.taskId;
  return { ok: true, spec, code: RETRO_CODES.FORK_SPEC };
}

function isForkSpec(input: unknown): input is RetroForkSpec {
  if (!isRecord(input)) return false;
  if (typeof input["systemPrompt"] !== "string") return false;
  if (typeof input["cacheScope"] !== "string") return false;
  if (input["detached"] !== true) return false;
  if (!isNonNegInt(input["depth"])) return false;
  if (input["nudge"] !== 0) return false;
  const tools = input["tools"];
  const deny = input["deny"];
  return Array.isArray(tools) && tools.every((tool) => typeof tool === "string")
    && Array.isArray(deny) && deny.every((tool) => typeof tool === "string");
}

/** 收集参数里的字符串(深度 ≤4、最多 64 条),供危险命令扫描。 */
function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length >= 64 || depth > 4) return out;
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return out;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
  }
  return out;
}

function dangerousCommandOf(args: unknown): string | undefined {
  const strings = collectStrings(args);
  for (const text of strings) {
    for (const { pattern, label } of DANGEROUS_COMMANDS) {
      if (pattern.test(text)) return label;
    }
  }
  return undefined;
}

/**
 * fork 工具调用闸门:deny 列表命中 → DENY;不在白名单 → DENY;参数里出现危险命令 → DENY。
 * 一律返回稳定码 TOOL_DENIED,调用方据此拒绝执行,不解析 reason 文案。
 */
export function validateForkToolCall(spec: RetroForkSpec, tool: string, args?: unknown): RetroToolDecision {
  if (!isForkSpec(spec)) return { ok: false, reason: "invalid-fork-spec", code: RETRO_CODES.INVALID };
  if (typeof tool !== "string" || tool.trim() === "") {
    return { ok: false, reason: "invalid-tool-name", code: RETRO_CODES.INVALID };
  }
  const name = tool.trim();
  if (spec.deny.includes(name)) return { ok: false, reason: `denied-tool:${name}`, code: RETRO_CODES.TOOL_DENIED };
  if (!spec.tools.includes(name)) return { ok: false, reason: `tool-not-allowed:${name}`, code: RETRO_CODES.TOOL_DENIED };
  const dangerous = dangerousCommandOf(args);
  if (dangerous !== undefined) {
    return { ok: false, reason: `dangerous-command:${dangerous}`, code: RETRO_CODES.TOOL_DENIED };
  }
  return { ok: true, reason: "allowed" };
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_ARTIFACT_CONFIDENCE;
  return Math.min(1, Math.max(0, value));
}

function normalizeRefs(refs: unknown): string[] {
  if (!Array.isArray(refs)) return [];
  const out: string[] = [];
  for (const ref of refs) {
    if (typeof ref !== "string") continue;
    const trimmed = ref.trim();
    if (trimmed === "" || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * 复盘产物:kind 固定 insight,associations={session,task},幂等键 `retro:<session>:<retroCount>`。
 * 同一会话同一轮重复构造得到同一个键 —— 去重由持久层按键判重(ARTIFACT_DUPLICATE)。
 */
export function retroArtifact(fork: RetroArtifactFork, input: RetroArtifactInput): RetroArtifactResult {
  if (!isRecord(fork)) return { ok: false, code: RETRO_CODES.INVALID };
  const sessionId = typeof fork.sessionId === "string" ? fork.sessionId.trim() : "";
  if (sessionId === "") return { ok: false, code: RETRO_CODES.INVALID };
  const retroCount = fork.retroCount;
  if (!isNonNegInt(retroCount)) return { ok: false, code: RETRO_CODES.INVALID };
  if (!isRecord(input) || typeof input.summary !== "string") return { ok: false, code: RETRO_CODES.INVALID };
  const statement = input.summary.trim().replace(/\s+/g, " ");
  if (statement === "") return { ok: false, code: RETRO_CODES.INVALID };
  const taskId = typeof input.taskId === "string" && input.taskId.trim() !== ""
    ? input.taskId.trim()
    : typeof fork.taskId === "string" && fork.taskId.trim() !== ""
      ? fork.taskId.trim()
      : undefined;
  const artifact: RetroArtifact = {
    kind: "insight",
    statement,
    associations: { session: sessionId },
    idempotencyKey: `retro:${sessionId}:${retroCount}`,
    confidence: clampConfidence(input.confidence),
    evidenceRefs: normalizeRefs(input.evidenceRefs),
    sessionId,
    retroCount,
  };
  if (taskId !== undefined) artifact.associations.task = taskId;
  if (typeof input.at === "number" && Number.isFinite(input.at)) artifact.at = input.at;
  return { ok: true, artifact, code: RETRO_CODES.ARTIFACT };
}

export interface RetroDoneResult {
  ok: boolean;
  state: RetroState;
  code: RetroCode;
}

/** 复盘完成:retroCount+1、lastRetroAt=at、两类计数清零(depth/nudge 不动,由 fork 规格决定)。 */
export function markRetroDone(state: RetroState, opts: { at?: number } = {}): RetroDoneResult {
  if (!isValidState(state)) return { ok: false, state: normalizeState(state), code: RETRO_CODES.INVALID };
  const at = typeof opts.at === "number" && Number.isFinite(opts.at) ? opts.at : Date.now();
  return {
    ok: true,
    state: {
      ...state,
      userTurns: 0,
      toolIterations: 0,
      retroCount: state.retroCount + 1,
      lastRetroAt: at,
    },
    code: RETRO_CODES.DONE,
  };
}
