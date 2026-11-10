/**
 * 夜间离线整合调度(Nightly Run):把「一天的工作痕迹」收敛成一份可恢复、可复算、可验收的
 * run 记录,并从中挖出少量候选(tip / gate / tool / refactor / experiment)。
 *
 * 为什么要单独一层纯逻辑:
 * - 夜间流程会跑几十步、跨好几小时、可能被预算或在线忙碌打断。状态机(6 步 × 5 态)与
 *   稳定码必须能被单元测试逐条钉住,不能和文件读写、时钟、调度器搅在一起。
 * - 下游 store(gateway 侧)只做 IO:原子写 `<root>/.genie/rsi/nightly/<project>/<date>.json`
 *   与 append-only `queue.jsonl`。它要求本文件给的一切都是**纯函数**:同输入同输出。
 *
 * 红线:
 * - 纯逻辑:零 IO(不读文件 / 网络 / 环境 / 真实时钟)。时间一律为 epoch ms 数字,来自输入
 *   (now / at);落盘字段统一转成 ISO 字符串。
 * - 绝不 throw:任何非法输入(坏日期、空 projectId、未知步骤名、非法状态、垃圾候选)都按
 *   原值兜底并通过稳定码(NIGHTLY_CODES)表达,调用方只按码分支,不解析文案。
 * - 不 mutate 入参:每个函数都返回新对象;数组字段一律新建。
 *
 * 时间口径(重要,测试已写死):
 * - date 是「本地日历日」字符串 `YYYY-MM-DD`(合法性按本地日历回读校验,拒绝 2026-02-30)。
 * - 默认 window = [date 00:00, 次日 00:00),用 date 字符串**按本地日历**构造,序列化为
 *   **不带时区偏移的本地墙钟串** `<date>T00:00:00.000`。这样同一字符串在任何机器上都按本地
 *   时区解析回同一个时刻,断言不会随 CI 的 TZ 漂移(带 Z 或带偏移都会漂)。
 * - 其余时间戳(createdAt / updatedAt / startedAt / finishedAt)都是 `new Date(ms).toISOString()`,
 *   即真正的 UTC 瞬时,便于与 journal 侧 epoch ms 对齐。
 */

/** run 记录 schema 版本:字段语义变化时递增。 */
export const NIGHTLY_VERSION = 1;

/** 预算缺省上限(令牌数):约等于一次夜间窗口的成本天花板。 */
export const DEFAULT_MAX_TOKENS = 200_000;

/** 候选缺省上限:夜间产出必须少而准,超出的一律截断。 */
export const DEFAULT_MAX_CANDIDATES = 50;

/** run 级状态。skipped = 本轮无需跑(例如在线忙碌 / 已完成),failed 只由步骤失败或外部置入。 */
export const NIGHTLY_STATUSES = [
  "pending",
  "running",
  "paused",
  "done",
  "failed",
  "skipped",
] as const;

export type NightlyStatus = (typeof NIGHTLY_STATUSES)[number];

/** 六步管线,顺序即执行顺序(mine → generate-candidates 依赖前序产物,不可换位)。 */
export const NIGHTLY_STEPS = [
  "pull-traces",
  "denoise",
  "mine",
  "update-graph",
  "generate-candidates",
  "queue-experiments",
] as const;

export type NightlyStepName = (typeof NIGHTLY_STEPS)[number];

/** 步骤级状态(没有 paused:Suspend 是 run 级概念,步内暂停会丢失边界)。 */
export const NIGHTLY_STEP_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;

export type NightlyStepStatus = (typeof NIGHTLY_STEP_STATUSES)[number];

/** 候选种类:决定下游把它投到哪个干预载体(与 trajectory-pathology 的载体命名对齐)。 */
export const NIGHTLY_CANDIDATE_KINDS = [
  "tip",
  "gate",
  "tool",
  "refactor",
  "experiment",
] as const;

export type NightlyCandidateKind = (typeof NIGHTLY_CANDIDATE_KINDS)[number];

/** 14 个稳定码:调用方只按码分支,绝不解析文案。键名与值同名,便于日志直读。 */
export const NIGHTLY_CODES = {
  NIGHTLY_INVALID: "NIGHTLY_INVALID",
  NIGHTLY_STARTED: "NIGHTLY_STARTED",
  NIGHTLY_SKIPPED_DONE: "NIGHTLY_SKIPPED_DONE",
  NIGHTLY_SKIPPED_ONLINE_BUSY: "NIGHTLY_SKIPPED_ONLINE_BUSY",
  NIGHTLY_PAUSED: "NIGHTLY_PAUSED",
  NIGHTLY_RESUMED: "NIGHTLY_RESUMED",
  NIGHTLY_STEP_DONE: "NIGHTLY_STEP_DONE",
  NIGHTLY_BUDGET_EXCEEDED: "NIGHTLY_BUDGET_EXCEEDED",
  NIGHTLY_FAILED: "NIGHTLY_FAILED",
  NIGHTLY_RETRIED: "NIGHTLY_RETRIED",
  NIGHTLY_FINALIZED: "NIGHTLY_FINALIZED",
  NIGHTLY_UNPROCESSED: "NIGHTLY_UNPROCESSED",
  NIGHTLY_BAD_STEP: "NIGHTLY_BAD_STEP",
  NIGHTLY_NO_CANDIDATES: "NIGHTLY_NO_CANDIDATES",
} as const;

export type NightlyCode = (typeof NIGHTLY_CODES)[keyof typeof NIGHTLY_CODES];

export interface NightlyWindow {
  /** 本地墙钟串 `<date>T00:00:00.000`(不含时区偏移)。 */
  from: string;
  to: string;
}

export interface NightlyCursor {
  lastSessionId?: string;
  lastMtimeMs?: number;
}

export interface NightlyRunStep {
  name: NightlyStepName;
  status: NightlyStepStatus;
  startedAt?: string;
  finishedAt?: string;
  consumedTokens: number;
  artifactRef?: string;
  error?: string;
  note?: string;
}

export interface NightlyCoverage {
  sessionsTotal: number;
  sessionsProcessed: number;
  sessionsSkipped: number;
  eventsRead: number;
  eventsSkipped: number;
}

export interface NightlyCandidate {
  id: string;
  kind: NightlyCandidateKind;
  ref: string;
  reason: string;
  evidenceRefs: string[];
}

export interface NightlyUnprocessed {
  sessionId: string;
  reason: string;
}

export interface NightlyBudget {
  tokens: number;
  maxTokens: number;
}

export interface NightlyRun {
  runId: string;
  /** 本地日历日 `YYYY-MM-DD`。 */
  date: string;
  projectId: string;
  status: NightlyStatus;
  createdAt: string;
  updatedAt: string;
  window: NightlyWindow;
  cursor: NightlyCursor;
  idempotencyKey: string;
  steps: NightlyRunStep[];
  coverage: NightlyCoverage;
  candidates: NightlyCandidate[];
  unprocessed: NightlyUnprocessed[];
  budget: NightlyBudget;
  pauseReason?: string;
  report?: string[];
}

export interface NightlyConfig {
  /** 在线会话正忙(夜间窗口内有人用):默认不抢资源。 */
  onlineBusy?: boolean;
  /** 显式 false 时,即使 onlineBusy 也照跑。 */
  deferWhenBusy?: boolean;
  maxTokens?: number;
  windowFrom?: string;
  windowTo?: string;
}

export interface StartRunInput {
  date: string;
  projectId: string;
  /** epoch ms(统一口径:所有时间入参都是数字)。 */
  now: number;
  config?: NightlyConfig;
}

/** startRun 的结果:非法输入时 run 为 null(不是半成品)。 */
export interface NightlyStartResult {
  run: NightlyRun | null;
  codes: NightlyCode[];
}

/** 变换类函数的结果:run 恒非 null(非法输入原样返回入参)。 */
export interface NightlyUpdate {
  run: NightlyRun;
  codes: NightlyCode[];
}

export interface MarkStepInput {
  name: NightlyStepName;
  status: NightlyStepStatus;
  tokens?: number;
  artifactRef?: string;
  error?: string;
  note?: string;
  /** epoch ms。 */
  at: number;
}

export interface PauseInput {
  reason: string;
  at: number;
}

export interface AtInput {
  at: number;
}

export interface CoverageInput {
  coverage: Partial<NightlyCoverage>;
  at?: number;
}

export interface AddCandidatesOptions {
  maxCandidates?: number;
}

export interface FinalizeInput {
  at: number;
  report?: string[];
}

export interface MineSessionStats {
  id: string;
  tools: Record<string, number>;
  repeatedReads: number;
  unresolvedAsks: number;
  failedSteps: number;
  filesEdited: number;
  fanoutEdges: number;
}

export interface MineStats {
  sessions: MineSessionStats[];
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const FINISHED_STEP_STATUSES: readonly NightlyStepStatus[] = ["done", "failed", "skipped"];
const TERMINAL_RUN_STATUSES: readonly NightlyStatus[] = ["paused", "done", "failed", "skipped"];

function toIso(at: number): string {
  const ms = Number.isFinite(at) ? Math.trunc(at) : 0;
  return new Date(ms).toISOString();
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** 严格解析 `YYYY-MM-DD`:正则 + 本地日历回读,2026-02-30 这类会被拒。 */
function parseCalendarDate(value: unknown): CalendarDate | null {
  if (typeof value !== "string") return null;
  const matched = DATE_PATTERN.exec(value);
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(year, month - 1, day);
  if (
    probe.getFullYear() !== year ||
    probe.getMonth() !== month - 1 ||
    probe.getDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function formatCalendarDate(parts: CalendarDate): string {
  return `${String(parts.year).padStart(4, "0")}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** 次日(本地日历推导,自动跨月/跨年/闰日)。 */
function nextCalendarDate(value: string): string {
  const parts = parseCalendarDate(value);
  if (!parts) return value;
  const next = new Date(parts.year, parts.month - 1, parts.day + 1);
  return formatCalendarDate({
    year: next.getFullYear(),
    month: next.getMonth() + 1,
    day: next.getDate(),
  });
}

/** 默认窗口:本地日历日 [00:00, 次日 00:00),序列化为不带偏移的墙钟串。 */
function defaultWindow(date: string): NightlyWindow {
  return { from: `${date}T00:00:00.000`, to: `${nextCalendarDate(date)}T00:00:00.000` };
}

function normaliseCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function isStepName(value: unknown): value is NightlyStepName {
  return typeof value === "string" && (NIGHTLY_STEPS as readonly string[]).includes(value);
}

function isStepStatus(value: unknown): value is NightlyStepStatus {
  return typeof value === "string" && (NIGHTLY_STEP_STATUSES as readonly string[]).includes(value);
}

function isCandidateKind(value: unknown): value is NightlyCandidateKind {
  return typeof value === "string" && (NIGHTLY_CANDIDATE_KINDS as readonly string[]).includes(value);
}

function emptyCoverage(): NightlyCoverage {
  return { sessionsTotal: 0, sessionsProcessed: 0, sessionsSkipped: 0, eventsRead: 0, eventsSkipped: 0 };
}

function pendingStep(name: NightlyStepName): NightlyRunStep {
  return { name, status: "pending", consumedTokens: 0 };
}

/** 幂等键:`nightly:<projectId>:<date>`,同项目同日只允许一条有效记录。 */
export function runKey(date: string, projectId: string): string {
  return `nightly:${projectId}:${date}`;
}

/** 确定性 runId(不用随机数 / 时间戳,便于测试与文件命名对照)。 */
export function runId(date: string, projectId: string): string {
  return `ngt-${projectId}-${date}`;
}

/** 把 run 的步骤重排成 6 步 pending(state 之外的字段原样保留)。 */
export function planRunSteps(run: NightlyRun): NightlyRun {
  return { ...run, steps: NIGHTLY_STEPS.map((name) => pendingStep(name)) };
}

export function startRun(input: StartRunInput): NightlyStartResult {
  const date = typeof input?.date === "string" ? input.date.trim() : "";
  const projectId = typeof input?.projectId === "string" ? input.projectId.trim() : "";
  if (!parseCalendarDate(date) || projectId === "") {
    return { run: null, codes: [NIGHTLY_CODES.NIGHTLY_INVALID] };
  }

  const config = input.config ?? {};
  const now = input.now;
  const atIso = toIso(now);
  const maxTokens =
    typeof config.maxTokens === "number" && Number.isFinite(config.maxTokens)
      ? Math.max(0, Math.trunc(config.maxTokens))
      : DEFAULT_MAX_TOKENS;
  const window = defaultWindow(date);
  const from =
    typeof config.windowFrom === "string" && config.windowFrom !== "" ? config.windowFrom : window.from;
  const to = typeof config.windowTo === "string" && config.windowTo !== "" ? config.windowTo : window.to;

  const base: NightlyRun = {
    runId: runId(date, projectId),
    date,
    projectId,
    status: "pending",
    createdAt: atIso,
    updatedAt: atIso,
    window: { from, to },
    cursor: {},
    idempotencyKey: runKey(date, projectId),
    steps: NIGHTLY_STEPS.map((name) => pendingStep(name)),
    coverage: emptyCoverage(),
    candidates: [],
    unprocessed: [],
    budget: { tokens: 0, maxTokens },
  };

  if (config.onlineBusy === true && config.deferWhenBusy !== false) {
    return {
      run: { ...base, status: "skipped", steps: [], pauseReason: "online-busy" },
      codes: [NIGHTLY_CODES.NIGHTLY_SKIPPED_ONLINE_BUSY],
    };
  }

  return { run: base, codes: [NIGHTLY_CODES.NIGHTLY_STARTED] };
}

/** 同 idempotencyKey 且已 done → 本轮跳过(不覆盖已完成的记录)。 */
export function shouldSkipCompleted(
  existingRuns: readonly NightlyRun[] | null | undefined,
  key: string,
): boolean {
  if (!Array.isArray(existingRuns) || typeof key !== "string" || key === "") return false;
  return existingRuns.some((run) => run?.idempotencyKey === key && run?.status === "done");
}

/** 第一个 pending 步骤;run 已进终局(或暂停/失败)则 undefined。 */
export function nextStep(run: NightlyRun): NightlyRunStep | undefined {
  if (!run || TERMINAL_RUN_STATUSES.includes(run.status)) return undefined;
  return run.steps.find((step) => step.status === "pending");
}

export function markStep(run: NightlyRun, input: MarkStepInput): NightlyUpdate {
  const name: unknown = input?.name;
  const status: unknown = input?.status;
  if (!isStepName(name) || !isStepStatus(status)) {
    return { run, codes: [NIGHTLY_CODES.NIGHTLY_BAD_STEP] };
  }
  const index = run.steps.findIndex((step) => step.name === name);
  if (index < 0) {
    return { run, codes: [NIGHTLY_CODES.NIGHTLY_BAD_STEP] };
  }

  const atIso = toIso(input.at);
  const tokens = normaliseCount(input.tokens);
  const steps = run.steps.map((step, position): NightlyRunStep => {
    if (position !== index) return { ...step };
    const updated: NightlyRunStep = {
      ...step,
      status,
      consumedTokens: step.consumedTokens + tokens,
      startedAt: step.startedAt ?? atIso,
      finishedAt: FINISHED_STEP_STATUSES.includes(status) ? atIso : step.finishedAt,
    };
    if (input.artifactRef !== undefined) updated.artifactRef = input.artifactRef;
    if (input.error !== undefined) updated.error = input.error;
    if (input.note !== undefined) updated.note = input.note;
    return updated;
  });

  const budget: NightlyBudget = {
    tokens: run.budget.tokens + tokens,
    maxTokens: run.budget.maxTokens,
  };
  const moved: NightlyRun = {
    ...run,
    steps,
    budget,
    status: run.status === "pending" ? "running" : run.status,
    updatedAt: atIso,
  };

  if (status === "failed") {
    return { run: { ...moved, status: "failed" }, codes: [NIGHTLY_CODES.NIGHTLY_FAILED] };
  }

  // 预算判定在「本步已记为 done」之后:越界那一步的产物不丢,只是下一轮不再继续。
  if (budget.tokens > budget.maxTokens) {
    return {
      run: { ...moved, status: "paused", pauseReason: "budget" },
      codes: [NIGHTLY_CODES.NIGHTLY_STEP_DONE, NIGHTLY_CODES.NIGHTLY_BUDGET_EXCEEDED],
    };
  }

  return { run: moved, codes: [NIGHTLY_CODES.NIGHTLY_STEP_DONE] };
}

export function pauseRun(run: NightlyRun, input: PauseInput): NightlyUpdate {
  if (!run || (run.status !== "pending" && run.status !== "running")) {
    return { run, codes: [NIGHTLY_CODES.NIGHTLY_INVALID] };
  }
  const reason =
    typeof input?.reason === "string" && input.reason !== "" ? input.reason : "manual";
  return {
    run: {
      ...run,
      steps: run.steps.map((step) => ({ ...step })),
      status: "paused",
      pauseReason: reason,
      updatedAt: toIso(input?.at),
    },
    codes: [NIGHTLY_CODES.NIGHTLY_PAUSED],
  };
}

/** 失败 / 未完成的步骤统一回到 pending(保留 consumedTokens,清 error 与 finishedAt)。 */
function resetUnfinishedSteps(steps: readonly NightlyRunStep[]): NightlyRunStep[] {
  return steps.map((step) => {
    if (step.status !== "failed" && step.status !== "running") return { ...step };
    const { error: _error, finishedAt: _finishedAt, ...rest } = step;
    return { ...rest, status: "pending", consumedTokens: step.consumedTokens };
  });
}

function dropPauseReason(run: NightlyRun): NightlyRun {
  const { pauseReason: _pauseReason, ...rest } = run;
  return { ...rest, steps: run.steps.map((step) => ({ ...step })) };
}

export function resumeRun(run: NightlyRun, input: AtInput): NightlyUpdate {
  if (!run || (run.status !== "paused" && run.status !== "failed")) {
    return { run, codes: [NIGHTLY_CODES.NIGHTLY_INVALID] };
  }
  const next = dropPauseReason(run);
  return {
    run: {
      ...next,
      steps: resetUnfinishedSteps(next.steps),
      status: "running",
      updatedAt: toIso(input?.at),
    },
    codes: [NIGHTLY_CODES.NIGHTLY_RESUMED],
  };
}

export function retryRun(run: NightlyRun, input: AtInput): NightlyUpdate {
  if (!run || run.status !== "failed") {
    return { run, codes: [NIGHTLY_CODES.NIGHTLY_INVALID] };
  }
  const next = dropPauseReason(run);
  return {
    run: {
      ...next,
      steps: resetUnfinishedSteps(next.steps),
      status: "running",
      updatedAt: toIso(input?.at),
    },
    codes: [NIGHTLY_CODES.NIGHTLY_RETRIED],
  };
}

export function recordCoverage(run: NightlyRun, input: CoverageInput): NightlyRun {
  const delta = input?.coverage ?? {};
  const coverage: NightlyCoverage = {
    sessionsTotal: run.coverage.sessionsTotal + normaliseCount(delta.sessionsTotal),
    sessionsProcessed: run.coverage.sessionsProcessed + normaliseCount(delta.sessionsProcessed),
    sessionsSkipped: run.coverage.sessionsSkipped + normaliseCount(delta.sessionsSkipped),
    eventsRead: run.coverage.eventsRead + normaliseCount(delta.eventsRead),
    eventsSkipped: run.coverage.eventsSkipped + normaliseCount(delta.eventsSkipped),
  };
  const next: NightlyRun = { ...run, coverage };
  if (typeof input?.at === "number" && Number.isFinite(input.at)) {
    next.updatedAt = toIso(input.at);
  }
  return next;
}

function normaliseCandidate(value: unknown): NightlyCandidate | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<NightlyCandidate>;
  if (typeof raw.id !== "string" || raw.id === "") return null;
  if (!isCandidateKind(raw.kind)) return null;
  const ref = typeof raw.ref === "string" ? raw.ref : "";
  const reason = typeof raw.reason === "string" ? raw.reason : "";
  const evidenceRefs = Array.isArray(raw.evidenceRefs)
    ? raw.evidenceRefs.filter((entry): entry is string => typeof entry === "string")
    : [];
  return { id: raw.id, kind: raw.kind, ref, reason, evidenceRefs };
}

/** 按 id 去重(先出现的保留)后截断到上限;真正新增为 0 时给 NO_CANDIDATES。 */
export function addCandidates(
  run: NightlyRun,
  candidates: readonly NightlyCandidate[] | null | undefined,
  options?: AddCandidatesOptions,
): NightlyUpdate {
  const limitRaw = options?.maxCandidates;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw)
      ? Math.max(0, Math.trunc(limitRaw))
      : DEFAULT_MAX_CANDIDATES;
  const merged = run.candidates.map((candidate) => ({
    ...candidate,
    evidenceRefs: [...candidate.evidenceRefs],
  }));
  const seen = new Set(merged.map((candidate) => candidate.id));
  let added = 0;

  const incoming = Array.isArray(candidates) ? candidates : [];
  for (const entry of incoming) {
    const candidate = normaliseCandidate(entry);
    if (!candidate) continue;
    if (seen.has(candidate.id)) continue;
    if (merged.length >= limit) continue;
    seen.add(candidate.id);
    merged.push(candidate);
    added += 1;
  }

  const next: NightlyRun = { ...run, candidates: merged };
  return { run: next, codes: added === 0 ? [NIGHTLY_CODES.NIGHTLY_NO_CANDIDATES] : [] };
}

export function addUnprocessed(
  run: NightlyRun,
  items: readonly NightlyUnprocessed[] | null | undefined,
): NightlyUpdate {
  const incoming = Array.isArray(items) ? items : [];
  const accepted: NightlyUnprocessed[] = [];
  for (const entry of incoming) {
    if (!entry || typeof entry.sessionId !== "string" || entry.sessionId === "") continue;
    accepted.push({
      sessionId: entry.sessionId,
      reason: typeof entry.reason === "string" ? entry.reason : "",
    });
  }
  const next: NightlyRun = {
    ...run,
    unprocessed: [...run.unprocessed.map((item) => ({ ...item })), ...accepted],
  };
  return { run: next, codes: accepted.length === 0 ? [] : [NIGHTLY_CODES.NIGHTLY_UNPROCESSED] };
}

export function finalizeRun(run: NightlyRun, input: FinalizeInput): NightlyUpdate {
  const complete =
    run.steps.length === NIGHTLY_STEPS.length &&
    NIGHTLY_STEPS.every((name) => {
      const step = run.steps.find((entry) => entry.name === name);
      return step !== undefined && (step.status === "done" || step.status === "skipped");
    });
  if (!complete) {
    return { run, codes: [NIGHTLY_CODES.NIGHTLY_BAD_STEP] };
  }
  const atIso = toIso(input?.at);
  const finalized: NightlyRun = {
    ...run,
    steps: run.steps.map((step) => ({ ...step })),
    status: "done",
    updatedAt: atIso,
  };
  const report =
    Array.isArray(input?.report) && input.report.length > 0 ? [...input.report] : buildRunReport(finalized);
  return { run: { ...finalized, report }, codes: [NIGHTLY_CODES.NIGHTLY_FINALIZED] };
}

/** 四段式人读报告:身份 / 步骤 / 覆盖 / 候选 / 未处理 / 预算(每项一行,便于 CLI 直打)。 */
export function buildRunReport(run: NightlyRun): string[] {
  const lines: string[] = [];
  lines.push(`nightly: ${run.runId}`);
  lines.push(`date: ${run.date} project: ${run.projectId} status: ${run.status}`);
  lines.push(`window: ${run.window.from} ~ ${run.window.to}`);
  lines.push(`steps(${run.steps.length}):`);
  for (const step of run.steps) {
    lines.push(`  ${step.name}: ${step.status} tokens=${step.consumedTokens}`);
  }
  const { sessionsTotal, sessionsProcessed, sessionsSkipped, eventsRead, eventsSkipped } = run.coverage;
  lines.push(
    `coverage: sessions=${sessionsTotal}/${sessionsProcessed}/${sessionsSkipped} events=${eventsRead}/${eventsSkipped}`,
  );
  lines.push(`candidates: ${run.candidates.length}`);
  lines.push(`unprocessed: ${run.unprocessed.length}`);
  lines.push(`budget: tokens=${run.budget.tokens} max=${run.budget.maxTokens}`);
  if (run.pauseReason !== undefined) lines.push(`pause: ${run.pauseReason}`);
  return lines;
}

interface MineRuleSpec {
  kind: NightlyCandidateKind;
  slug: string;
  label: string;
  detail: string;
}

function mineCandidate(rule: MineRuleSpec, evidenceRefs: readonly string[]): NightlyCandidate {
  return {
    id: `cand-${rule.kind}-${rule.slug}`,
    kind: rule.kind,
    ref: rule.slug,
    reason: `${rule.label}:${rule.detail}`,
    evidenceRefs: [...evidenceRefs],
  };
}

function mineSessions(stats: MineStats | null | undefined): MineSessionStats[] {
  const raw = stats?.sessions;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (session): session is MineSessionStats =>
      !!session && typeof session.id === "string" && session.id !== "",
  );
}

/**
 * 五条确定性规则,输出顺序固定(tip → gate → tool → refactor → experiment):
 * 1. tip       : 跨 ≥2 个 session 各自 repeatedReads ≥3(同一 ref 反复读)。
 * 2. gate      : 任一 session unresolvedAsks ≥1(提问悬空)。
 * 3. tool      : 任一 session failedSteps ≥2(工具反复失败)。
 * 4. refactor  : 任一 session fanoutEdges ≥2(扇出未闭合)。
 * 5. experiment: 全体 ΣfilesEdited ≥5 且 session 数 ≥2(热点文件)。
 * 同规则命中多个 session → 合并为一条候选,evidenceRefs 列全部命中 session id。
 */
export function mineCandidates(stats: MineStats): NightlyCandidate[] {
  const sessions = mineSessions(stats);
  if (sessions.length === 0) return [];
  const out: NightlyCandidate[] = [];

  const repeatHits = sessions.filter((session) => normaliseCount(session.repeatedReads) >= 3);
  if (repeatHits.length >= 2) {
    out.push(
      mineCandidate(
        {
          kind: "tip",
          slug: "repeated-reads",
          label: "重复读取",
          detail: `${repeatHits.length} 个会话同一 ref 重复读取 ≥3 次`,
        },
        repeatHits.map((session) => session.id),
      ),
    );
  }

  const askHits = sessions.filter((session) => normaliseCount(session.unresolvedAsks) >= 1);
  if (askHits.length >= 1) {
    out.push(
      mineCandidate(
        {
          kind: "gate",
          slug: "unresolved-asks",
          label: "悬空提问",
          detail: `${askHits.length} 个会话有未回答的提问`,
        },
        askHits.map((session) => session.id),
      ),
    );
  }

  const failHits = sessions.filter((session) => normaliseCount(session.failedSteps) >= 2);
  if (failHits.length >= 1) {
    out.push(
      mineCandidate(
        {
          kind: "tool",
          slug: "failed-steps",
          label: "工具失败",
          detail: `${failHits.length} 个会话内工具失败 ≥2 次`,
        },
        failHits.map((session) => session.id),
      ),
    );
  }

  const fanoutHits = sessions.filter((session) => normaliseCount(session.fanoutEdges) >= 2);
  if (fanoutHits.length >= 1) {
    out.push(
      mineCandidate(
        {
          kind: "refactor",
          slug: "fanout-edges",
          label: "扇出未闭合",
          detail: `${fanoutHits.length} 个会话扇出 ≥2 条未闭合边`,
        },
        fanoutHits.map((session) => session.id),
      ),
    );
  }

  const filesEdited = sessions.reduce((sum, session) => sum + normaliseCount(session.filesEdited), 0);
  if (filesEdited >= 5 && sessions.length >= 2) {
    out.push(
      mineCandidate(
        {
          kind: "experiment",
          slug: "hot-files",
          label: "热点文件",
          detail: `Σ filesEdited=${filesEdited} 跨 ${sessions.length} 个会话`,
        },
        sessions.map((session) => session.id),
      ),
    );
  }

  return out;
}
