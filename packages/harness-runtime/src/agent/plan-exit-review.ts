/**
 * 计划退出评审(plan-exit review,纯逻辑,零 IO,#10)。
 * 为什么需要它:计划审批只在回合结束之后发生,模型可能已经开工;「继续规划」的反馈要到
 * 下一回合才到达;没有 UI 时又容易静默离开计划模式。于是把「要求退出计划模式」变成一次
 * **阻塞评审调用**:
 *   exit_plan_mode → requestExit 落 pending(当前工具调用被阻塞,不返回)
 *   用户 decide:approve(记录 pendingExitAt,下一次 pre-step 才生效)
 *              keep-planning(返回失败调用 + 用户反馈,回到同一调用点继续规划)
 *   无交互通道 → BLOCKED_NO_CHANNEL(fail-closed,不静默退出)
 *   超时       → failed(fail-closed,绝不自动 approve)
 * 关键不变量:
 * 1. 完整计划才可提交:goal 非空 + steps≥1 + acceptance≥1。
 * 2. 只有 pending 能 decide;approve / keep-planning 都回到同一调用点。
 * 3. approve 只记 pendingExitAt,**不立即生效**(不存在「回合结束后才生效」的隐式路径)。
 * 4. applyPendingExit 需 preStepAt >= pendingExitAt,且只生效一次(exitApplied)。
 * 5. keep-planning 必须带非空 feedback,否则 FEEDBACK_REQUIRED 且状态不变。
 * 依赖纪律:零 import、不读时钟/环境;非法入参折叠成 PLANEXIT_INVALID。
 */

/** 稳定码:评审状态机的全部结论(字符串常量,便于落盘与断言)。 */
export const PLANEXIT_INVALID = "PLANEXIT_INVALID" as const;
export const PLANEXIT_VALID = "PLANEXIT_VALID" as const;
export const PLANEXIT_INCOMPLETE_PLAN = "PLANEXIT_INCOMPLETE_PLAN" as const;
export const PLANEXIT_BLOCKED_NO_CHANNEL = "PLANEXIT_BLOCKED_NO_CHANNEL" as const;
export const PLANEXIT_PENDING = "PLANEXIT_PENDING" as const;
export const PLANEXIT_APPROVED = "PLANEXIT_APPROVED" as const;
export const PLANEXIT_APPLIED = "PLANEXIT_APPLIED" as const;
export const PLANEXIT_KEEP_PLANNING = "PLANEXIT_KEEP_PLANNING" as const;
export const PLANEXIT_FEEDBACK_REQUIRED = "PLANEXIT_FEEDBACK_REQUIRED" as const;
export const PLANEXIT_TIMEOUT_FAILED = "PLANEXIT_TIMEOUT_FAILED" as const;
export const PLANEXIT_APPLY_BEFORE_DUE = "PLANEXIT_APPLY_BEFORE_DUE" as const;

/** 全部稳定码(固定顺序)。 */
export const PLANEXIT_CODES = [
  PLANEXIT_INVALID,
  PLANEXIT_VALID,
  PLANEXIT_INCOMPLETE_PLAN,
  PLANEXIT_BLOCKED_NO_CHANNEL,
  PLANEXIT_PENDING,
  PLANEXIT_APPROVED,
  PLANEXIT_APPLIED,
  PLANEXIT_KEEP_PLANNING,
  PLANEXIT_FEEDBACK_REQUIRED,
  PLANEXIT_TIMEOUT_FAILED,
  PLANEXIT_APPLY_BEFORE_DUE,
] as const;

export type PlanExitCode = (typeof PLANEXIT_CODES)[number];

/** 评审阻塞期间的缺省超时:10 分钟;超时 fail-closed(不自动批准)。 */
export const PLANEXIT_DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** 需要补全/被拒绝/失败的业务码(CLI 映射 exit 2)。 */
export const PLANEXIT_REJECTION_CODES = [
  PLANEXIT_INVALID,
  PLANEXIT_INCOMPLETE_PLAN,
  PLANEXIT_BLOCKED_NO_CHANNEL,
  PLANEXIT_FEEDBACK_REQUIRED,
  PLANEXIT_TIMEOUT_FAILED,
  PLANEXIT_APPLY_BEFORE_DUE,
] as const;

/** 计划正文:目标 / 步骤 / 验收 / 风险(可选)。 */
export interface PlanDraft {
  goal: string;
  steps: string[];
  acceptance: string[];
  risks?: string[];
}

/** 一次提交:谁(session)在什么时候交了哪份计划。 */
export interface PlanSubmission {
  planId: string;
  sessionId: string;
  plan: PlanDraft;
  submittedAt: number;
}

export type ReviewChannelKind = "panel" | "cli" | "none";

/** 交互通道:none = 没有可评审的界面(必须 fail-closed)。 */
export interface ReviewChannel {
  kind: ReviewChannelKind;
  timeoutMs?: number;
}

export type ReviewStatus = "pending" | "approved" | "rejected" | "failed";

/** 评审状态。planId/sessionId/submittedAt/timeoutMs 为落账本所需,不是业务判定字段。 */
export interface ReviewState {
  status: ReviewStatus;
  feedback?: string;
  decidedAt?: number;
  pendingExitAt?: number;
  planId?: string;
  sessionId?: string;
  submittedAt?: number;
  timeoutMs?: number;
  exitApplied?: boolean;
  appliedAt?: number;
  reason?: string;
}

/** 计划校验结论。 */
export interface PlanValidation {
  ok: boolean;
  code: PlanExitCode;
  missing: string[];
  detail?: string;
}

/** 评审函数统一返回形状。 */
export interface PlanExitResult {
  ok: boolean;
  code: PlanExitCode;
  state?: ReviewState;
  /** 是否可在同一调用点继续(resume)。keep-planning 为 true。 */
  resume: boolean;
  feedback?: string;
  missing?: string[];
  detail?: string;
  submission?: PlanSubmission;
}

export interface RequestExitInput {
  submission: PlanSubmission;
  channel: ReviewChannel;
  now?: number;
}

export interface DecideReviewInput {
  decision: "approve" | "keep-planning";
  feedback?: string;
  at?: number;
}

export interface TimeoutReviewInput {
  now?: number;
  timeoutMs?: number;
}

export interface ApplyPendingExitInput {
  preStepAt?: number;
}

const REVIEW_STATUSES: readonly ReviewStatus[] = ["pending", "approved", "rejected", "failed"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => nonEmptyString(item));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function fail(code: PlanExitCode, detail: string, state?: ReviewState): PlanExitResult {
  return state === undefined ? { ok: false, code, resume: false, detail } : { ok: false, code, resume: false, detail, state };
}

/** 形状判定(供 store 净化账本用)。 */
export function isReviewState(value: unknown): value is ReviewState {
  const rec = asRecord(value);
  if (rec === undefined) return false;
  const status = rec["status"];
  return typeof status === "string" && (REVIEW_STATUSES as readonly string[]).includes(status);
}

/**
 * 校验计划是否完整:goal 非空 + steps≥1 且每条非空 + acceptance≥1 且每条非空。
 * risks 可选,给了就必须是字符串数组。
 */
export function validatePlan(plan: unknown): PlanValidation {
  const rec = asRecord(plan);
  if (rec === undefined) return { ok: false, code: PLANEXIT_INVALID, missing: [], detail: "plan 必须是对象" };
  const missing: string[] = [];
  if (!nonEmptyString(rec["goal"])) missing.push("goal");
  const steps = rec["steps"];
  if (!stringList(steps) || steps.length === 0) missing.push("steps");
  const acceptance = rec["acceptance"];
  if (!stringList(acceptance) || acceptance.length === 0) missing.push("acceptance");
  const risks = rec["risks"];
  if (risks !== undefined && !stringList(risks)) {
    return { ok: false, code: PLANEXIT_INVALID, missing, detail: "risks 必须是字符串数组" };
  }
  if (missing.length > 0) return { ok: false, code: PLANEXIT_INCOMPLETE_PLAN, missing };
  return { ok: true, code: PLANEXIT_VALID, missing: [] };
}

/**
 * 提交退出计划模式的请求:校验计划 + 通道,成功后返回 pending 状态。
 * 评审本身是阻塞的——本函数不产生任何「回合结束后才生效」的路径:
 * pendingExitAt 只在 decide(approve) 时写入。
 */
export function requestExit(input: RequestExitInput): PlanExitResult {
  const submission = asRecord(input?.submission);
  if (submission === undefined) return fail(PLANEXIT_INVALID, "submission 必须是对象");
  const planId = submission["planId"];
  const sessionId = submission["sessionId"];
  if (!nonEmptyString(planId) || !nonEmptyString(sessionId)) {
    return fail(PLANEXIT_INVALID, "submission.planId / sessionId 必须是非空字符串");
  }

  const channel = asRecord(input?.channel);
  if (channel === undefined) return fail(PLANEXIT_INVALID, "channel 必须是对象");
  const kind = channel["kind"];
  if (kind !== "panel" && kind !== "cli" && kind !== "none") {
    return fail(PLANEXIT_INVALID, `channel.kind 只能是 panel|cli|none(收到 ${String(kind)})`);
  }

  const validation = validatePlan(submission["plan"]);
  if (!validation.ok) {
    return { ok: false, code: validation.code, resume: false, missing: validation.missing, detail: validation.detail };
  }

  const now = finiteNumber(input?.now) ? input.now : undefined;
  const submittedAtRaw = submission["submittedAt"];
  const submittedAt = finiteNumber(submittedAtRaw) ? submittedAtRaw : now;
  if (submittedAt === undefined) {
    return fail(PLANEXIT_INVALID, "submittedAt 缺失且未给 now");
  }

  if (kind === "none") {
    // fail-closed:没有面板/CLI 时不许静默离开计划模式。
    return { ok: false, code: PLANEXIT_BLOCKED_NO_CHANNEL, resume: false, detail: "没有可用的交互评审通道(panel/cli)" };
  }

  const timeoutRaw = channel["timeoutMs"];
  const timeoutMs = finiteNumber(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : PLANEXIT_DEFAULT_TIMEOUT_MS;
  const state: ReviewState = {
    status: "pending",
    planId,
    sessionId,
    submittedAt,
    timeoutMs,
  };
  return { ok: true, code: PLANEXIT_PENDING, state, resume: false };
}

/**
 * 记录用户决定。
 * - approve:approved + pendingExitAt=at(下一次 pre-step 生效)。
 * - keep-planning:feedback 必填;rejected + resume=true,同一调用点继续规划。
 */
export function decideReview(state: ReviewState, input: DecideReviewInput): PlanExitResult {
  if (!isReviewState(state)) return fail(PLANEXIT_INVALID, "state 形状非法");
  const decision = input?.decision;
  if (decision !== "approve" && decision !== "keep-planning") {
    return fail(PLANEXIT_INVALID, `decision 只能是 approve|keep-planning(收到 ${String(decision)})`, state);
  }
  const at = finiteNumber(input?.at) ? input.at : undefined;
  if (at === undefined || at < 0) return fail(PLANEXIT_INVALID, "at 必须是有限非负数", state);
  if (state.status !== "pending") {
    return fail(PLANEXIT_INVALID, `只有 pending 能 decide(当前 ${state.status})`, state);
  }

  if (decision === "approve") {
    const next: ReviewState = { ...state, status: "approved", decidedAt: at, pendingExitAt: at };
    return { ok: true, code: PLANEXIT_APPROVED, state: next, resume: false };
  }

  const feedback = typeof input?.feedback === "string" ? input.feedback.trim() : "";
  if (feedback === "") {
    // 拒绝必须带原因,否则模型无从继续规划;状态保持不变(零副作用)。
    return fail(PLANEXIT_FEEDBACK_REQUIRED, "keep-planning 必须带非空 feedback", state);
  }
  const next: ReviewState = { ...state, status: "rejected", feedback, decidedAt: at };
  return { ok: true, code: PLANEXIT_KEEP_PLANNING, state: next, resume: true, feedback };
}

/**
 * 超时裁决:pending 超过 timeoutMs → failed(fail-closed,绝不自动 approve)。
 * 未到点返回 PENDING(ok=true,detail=not-due)。
 */
export function timeoutReview(state: ReviewState, input: TimeoutReviewInput = {}): PlanExitResult {
  if (!isReviewState(state)) return fail(PLANEXIT_INVALID, "state 形状非法");
  const now = finiteNumber(input?.now) ? input.now : undefined;
  if (now === undefined || now < 0) return fail(PLANEXIT_INVALID, "now 必须是有限非负数", state);
  if (state.status !== "pending") {
    return fail(PLANEXIT_INVALID, `只有 pending 会超时(当前 ${state.status})`, state);
  }
  const submittedAt = finiteNumber(state.submittedAt) ? state.submittedAt : undefined;
  if (submittedAt === undefined) return fail(PLANEXIT_INVALID, "pending 缺 submittedAt,无法判定超时", state);
  const timeoutRaw = input?.timeoutMs;
  const timeoutMs =
    finiteNumber(timeoutRaw) && timeoutRaw > 0
      ? timeoutRaw
      : finiteNumber(state.timeoutMs) && state.timeoutMs > 0
        ? state.timeoutMs
        : PLANEXIT_DEFAULT_TIMEOUT_MS;
  if (now < submittedAt) return fail(PLANEXIT_INVALID, "now 早于 submittedAt(时钟回退)", state);
  if (now - submittedAt < timeoutMs) {
    return { ok: true, code: PLANEXIT_PENDING, state, resume: false, detail: "not-due" };
  }
  const next: ReviewState = { ...state, status: "failed", decidedAt: now, reason: "timeout" };
  return {
    ok: false,
    code: PLANEXIT_TIMEOUT_FAILED,
    state: next,
    resume: false,
    detail: `评审超时 ${now - submittedAt}ms ≥ ${timeoutMs}ms`,
  };
}

/**
 * 下一次 pre-step 应用 pending exit:approved 且 preStepAt >= pendingExitAt → APPLIED(只一次)。
 * 提前调用 → APPLY_BEFORE_DUE,状态不变。
 */
export function applyPendingExit(state: ReviewState, input: ApplyPendingExitInput = {}): PlanExitResult {
  if (!isReviewState(state)) return fail(PLANEXIT_INVALID, "state 形状非法");
  const preStepAt = finiteNumber(input?.preStepAt) ? input.preStepAt : undefined;
  if (preStepAt === undefined || preStepAt < 0) {
    return fail(PLANEXIT_INVALID, "preStepAt 必须是有限非负数", state);
  }
  if (state.status !== "approved") {
    return fail(PLANEXIT_INVALID, `只有 approved 能生效(当前 ${state.status})`, state);
  }
  if (state.exitApplied === true) return fail(PLANEXIT_INVALID, "已生效,不可重复 apply", state);
  const due = finiteNumber(state.pendingExitAt) ? state.pendingExitAt : undefined;
  if (due === undefined) return fail(PLANEXIT_INVALID, "approved 缺 pendingExitAt", state);
  if (preStepAt < due) {
    return fail(PLANEXIT_APPLY_BEFORE_DUE, `未到生效点(${preStepAt} < ${due})`, state);
  }
  const next: ReviewState = { ...state, exitApplied: true, appliedAt: preStepAt };
  return { ok: true, code: PLANEXIT_APPLIED, state: next, resume: false };
}

/**
 * 同一调用点续跑判定:只有 rejected 能 resume(把反馈原样回灌给模型)。
 * pending 仍阻塞;approved 等 pre-step;failed 已。
 */
export function resumeAtSameCall(state: ReviewState): PlanExitResult {
  if (!isReviewState(state)) return fail(PLANEXIT_INVALID, "state 形状非法");
  if (state.status === "rejected") {
    return { ok: true, code: PLANEXIT_KEEP_PLANNING, state, resume: true, feedback: state.feedback ?? "" };
  }
  if (state.status === "pending") {
    return { ok: false, code: PLANEXIT_PENDING, state, resume: false, detail: "still-blocked" };
  }
  if (state.status === "approved") {
    return { ok: false, code: PLANEXIT_APPROVED, state, resume: false, detail: "approved-waiting-pre-step" };
  }
  return { ok: false, code: PLANEXIT_TIMEOUT_FAILED, state, resume: false, detail: "timeout-failed" };
}
