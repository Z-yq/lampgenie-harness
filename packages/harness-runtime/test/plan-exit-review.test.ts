/**
 * 计划退出评审纯逻辑:计划校验 / 阻塞请求 / 用户决定 / 超时 fail-closed / pre-step 生效 / 同址续跑。
 * 全纯函数直测,不触 IO、不读时钟。
 */
import { describe, expect, it } from "vitest";
import {
  applyPendingExit,
  decideReview,
  isReviewState,
  PLANEXIT_APPLIED,
  PLANEXIT_APPLY_BEFORE_DUE,
  PLANEXIT_APPROVED,
  PLANEXIT_BLOCKED_NO_CHANNEL,
  PLANEXIT_CODES,
  PLANEXIT_DEFAULT_TIMEOUT_MS,
  PLANEXIT_FEEDBACK_REQUIRED,
  PLANEXIT_INCOMPLETE_PLAN,
  PLANEXIT_INVALID,
  PLANEXIT_KEEP_PLANNING,
  PLANEXIT_PENDING,
  PLANEXIT_TIMEOUT_FAILED,
  PLANEXIT_VALID,
  requestExit,
  resumeAtSameCall,
  timeoutReview,
  validatePlan,
  type PlanDraft,
  type PlanSubmission,
  type ReviewState,
} from "../src/agent/plan-exit-review.ts";

const T0 = 1_700_000_000_000;

function plan(over: Partial<PlanDraft> = {}): PlanDraft {
  return { goal: "ship the feature", steps: ["step a"], acceptance: ["check b"], ...over };
}

function submission(over: Partial<PlanSubmission> = {}): PlanSubmission {
  return { planId: "p1", sessionId: "s1", plan: plan(), submittedAt: T0, ...over };
}

function pending(over: Partial<ReviewState> = {}): ReviewState {
  return { status: "pending", planId: "p1", sessionId: "s1", submittedAt: T0, timeoutMs: 1000, ...over };
}

describe("validatePlan:完整计划门槛", () => {
  it("完整计划通过", () => {
    const r = validatePlan(plan());
    expect(r.ok).toBe(true);
    expect(r.code).toBe(PLANEXIT_VALID);
    expect(r.missing).toEqual([]);
  });

  it("缺 goal → INCOMPLETE_PLAN 且点名 goal", () => {
    const r = validatePlan(plan({ goal: "  " }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe(PLANEXIT_INCOMPLETE_PLAN);
    expect(r.missing).toContain("goal");
  });

  it("steps 为空 → INCOMPLETE_PLAN", () => {
    const r = validatePlan(plan({ steps: [] }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe(PLANEXIT_INCOMPLETE_PLAN);
    expect(r.missing).toContain("steps");
  });

  it("acceptance 为空 → INCOMPLETE_PLAN", () => {
    const r = validatePlan(plan({ acceptance: [] }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe(PLANEXIT_INCOMPLETE_PLAN);
    expect(r.missing).toContain("acceptance");
  });

  it("steps 含空白条目 → INCOMPLETE_PLAN", () => {
    const r = validatePlan(plan({ steps: ["ok", "  "] }));
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("steps");
  });

  it("plan 非对象 → INVALID", () => {
    expect(validatePlan(null).code).toBe(PLANEXIT_INVALID);
    expect(validatePlan("plan").code).toBe(PLANEXIT_INVALID);
    expect(validatePlan([]).code).toBe(PLANEXIT_INVALID);
  });

  it("risks 类型不对 → INVALID", () => {
    const r = validatePlan({ ...plan(), risks: [1, 2] });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(PLANEXIT_INVALID);
  });

  it("risks 可以是空数组", () => {
    expect(validatePlan({ ...plan(), risks: [] }).ok).toBe(true);
  });
});

describe("requestExit:阻塞请求与无通道 fail-closed", () => {
  it("channel=none → BLOCKED_NO_CHANNEL 且不产出状态", () => {
    const r = requestExit({ submission: submission(), channel: { kind: "none" } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(PLANEXIT_BLOCKED_NO_CHANNEL);
    expect(r.state).toBeUndefined();
  });

  it("panel 通道 → pending", () => {
    const r = requestExit({ submission: submission(), channel: { kind: "panel" } });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(PLANEXIT_PENDING);
    expect(r.state?.status).toBe("pending");
    expect(r.state?.planId).toBe("p1");
    expect(r.state?.sessionId).toBe("s1");
    expect(r.state?.submittedAt).toBe(T0);
  });

  it("pending 不产生待生效退出(无「回合后生效」路径)", () => {
    const r = requestExit({ submission: submission(), channel: { kind: "cli" } });
    expect(r.state?.pendingExitAt).toBeUndefined();
    expect(r.state?.exitApplied).toBeUndefined();
  });

  it("缺省超时 10 分钟", () => {
    const r = requestExit({ submission: submission(), channel: { kind: "cli" } });
    expect(r.state?.timeoutMs).toBe(PLANEXIT_DEFAULT_TIMEOUT_MS);
    expect(PLANEXIT_DEFAULT_TIMEOUT_MS).toBe(600_000);
  });

  it("通道可自定义超时", () => {
    const r = requestExit({ submission: submission(), channel: { kind: "panel", timeoutMs: 500 } });
    expect(r.state?.timeoutMs).toBe(500);
  });

  it("channel.kind 非法 → INVALID", () => {
    const r = requestExit({ submission: submission(), channel: { kind: "slack" as never } });
    expect(r.code).toBe(PLANEXIT_INVALID);
  });

  it("缺 sessionId → INVALID", () => {
    const r = requestExit({ submission: submission({ sessionId: "" }), channel: { kind: "cli" } });
    expect(r.code).toBe(PLANEXIT_INVALID);
  });

  it("计划不完整 → INCOMPLETE_PLAN,不给 pending", () => {
    const r = requestExit({ submission: submission({ plan: plan({ steps: [] }) }), channel: { kind: "cli" } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(PLANEXIT_INCOMPLETE_PLAN);
    expect(r.state).toBeUndefined();
  });

  it("无 submittedAt 时回落 now", () => {
    const r = requestExit({ submission: submission({ submittedAt: undefined as never }), channel: { kind: "cli" }, now: T0 + 7 });
    expect(r.state?.submittedAt).toBe(T0 + 7);
  });
});

describe("decideReview:approve 记 pendingExitAt 不立即生效", () => {
  it("approve → approved + pendingExitAt=at", () => {
    const r = decideReview(pending(), { decision: "approve", at: T0 + 5 });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(PLANEXIT_APPROVED);
    expect(r.state?.status).toBe("approved");
    expect(r.state?.pendingExitAt).toBe(T0 + 5);
    expect(r.state?.decidedAt).toBe(T0 + 5);
  });

  it("approve 不等于已生效", () => {
    const r = decideReview(pending(), { decision: "approve", at: T0 + 5 });
    expect(r.state?.exitApplied).toBeUndefined();
    expect(r.resume).toBe(false);
  });

  it("重复 approve → INVALID", () => {
    const approved: ReviewState = { ...pending(), status: "approved", pendingExitAt: T0 };
    const r = decideReview(approved, { decision: "approve", at: T0 + 1 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(PLANEXIT_INVALID);
  });

  it("rejected 后再 decide → INVALID", () => {
    const rejected: ReviewState = { ...pending(), status: "rejected", feedback: "x" };
    expect(decideReview(rejected, { decision: "approve", at: T0 }).code).toBe(PLANEXIT_INVALID);
  });

  it("decision 非法 → INVALID", () => {
    const r = decideReview(pending(), { decision: "maybe" as never, at: T0 });
    expect(r.code).toBe(PLANEXIT_INVALID);
  });

  it("缺 at → INVALID,状态不变", () => {
    const state = pending();
    const r = decideReview(state, { decision: "approve" });
    expect(r.code).toBe(PLANEXIT_INVALID);
    expect(r.state?.status).toBe("pending");
  });
});

describe("decideReview:keep-planning 必须带反馈", () => {
  it("无 feedback → FEEDBACK_REQUIRED 且状态不变", () => {
    const state = pending();
    const r = decideReview(state, { decision: "keep-planning", at: T0 + 1 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(PLANEXIT_FEEDBACK_REQUIRED);
    expect(r.state?.status).toBe("pending");
    expect(r.state?.feedback).toBeUndefined();
  });

  it("空白 feedback → FEEDBACK_REQUIRED", () => {
    const r = decideReview(pending(), { decision: "keep-planning", feedback: "   ", at: T0 + 1 });
    expect(r.code).toBe(PLANEXIT_FEEDBACK_REQUIRED);
  });

  it("带 feedback → rejected 且 resume=true(同一调用点续跑)", () => {
    const r = decideReview(pending(), { decision: "keep-planning", feedback: " 补测试 ", at: T0 + 2 });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(PLANEXIT_KEEP_PLANNING);
    expect(r.state?.status).toBe("rejected");
    expect(r.state?.feedback).toBe("补测试");
    expect(r.state?.decidedAt).toBe(T0 + 2);
    expect(r.resume).toBe(true);
    expect(r.feedback).toBe("补测试");
  });

  it("approved 后 keep-planning → INVALID", () => {
    const approved: ReviewState = { ...pending(), status: "approved", pendingExitAt: T0 };
    expect(decideReview(approved, { decision: "keep-planning", feedback: "x", at: T0 }).code).toBe(PLANEXIT_INVALID);
  });
});

describe("timeoutReview:超时 fail-closed", () => {
  it("未到点 → PENDING(ok,仍阻塞)", () => {
    const r = timeoutReview(pending(), { now: T0 + 999 });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(PLANEXIT_PENDING);
    expect(r.state?.status).toBe("pending");
    expect(r.detail).toBe("not-due");
  });

  it("到点 → failed,绝不自动 approve", () => {
    const r = timeoutReview(pending(), { now: T0 + 1000 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(PLANEXIT_TIMEOUT_FAILED);
    expect(r.state?.status).toBe("failed");
    expect(r.state?.reason).toBe("timeout");
  });

  it("缺省超时按 10 分钟判定", () => {
    const state: ReviewState = { status: "pending", submittedAt: T0 };
    expect(timeoutReview(state, { now: T0 + 599_999 }).code).toBe(PLANEXIT_PENDING);
    expect(timeoutReview(state, { now: T0 + 600_000 }).code).toBe(PLANEXIT_TIMEOUT_FAILED);
  });

  it("入参 timeoutMs 可覆盖", () => {
    const r = timeoutReview(pending({ timeoutMs: 1000 }), { now: T0 + 10, timeoutMs: 5 });
    expect(r.code).toBe(PLANEXIT_TIMEOUT_FAILED);
  });

  it("clock 回退 → INVALID", () => {
    expect(timeoutReview(pending(), { now: T0 - 1 }).code).toBe(PLANEXIT_INVALID);
  });

  it("非 pending 不能超时", () => {
    const approved: ReviewState = { ...pending(), status: "approved", pendingExitAt: T0 };
    expect(timeoutReview(approved, { now: T0 + 9999 }).code).toBe(PLANEXIT_INVALID);
  });

  it("now 非法 → INVALID", () => {
    expect(timeoutReview(pending(), { now: Number.NaN }).code).toBe(PLANEXIT_INVALID);
  });
});

describe("applyPendingExit:pre-step 到点才生效", () => {
  const approved = (): ReviewState => ({ ...pending(), status: "approved", decidedAt: T0 + 5, pendingExitAt: T0 + 5 });

  it("提前 apply → APPLY_BEFORE_DUE,状态不变", () => {
    const r = applyPendingExit(approved(), { preStepAt: T0 + 4 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(PLANEXIT_APPLY_BEFORE_DUE);
    expect(r.state?.exitApplied).toBeUndefined();
  });

  it("到点 apply → APPLIED 一次", () => {
    const r = applyPendingExit(approved(), { preStepAt: T0 + 5 });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(PLANEXIT_APPLIED);
    expect(r.state?.exitApplied).toBe(true);
    expect(r.state?.appliedAt).toBe(T0 + 5);
  });

  it("重复 apply → INVALID", () => {
    const applied: ReviewState = { ...approved(), exitApplied: true, appliedAt: T0 + 5 };
    const r = applyPendingExit(applied, { preStepAt: T0 + 9 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(PLANEXIT_INVALID);
  });

  it("pending 不能 apply", () => {
    expect(applyPendingExit(pending(), { preStepAt: T0 + 99 }).code).toBe(PLANEXIT_INVALID);
  });

  it("缺 preStepAt → INVALID", () => {
    expect(applyPendingExit(approved(), {}).code).toBe(PLANEXIT_INVALID);
  });

  it("approved 缺 pendingExitAt → INVALID", () => {
    const broken: ReviewState = { ...pending(), status: "approved" };
    expect(applyPendingExit(broken, { preStepAt: T0 + 99 }).code).toBe(PLANEXIT_INVALID);
  });
});

describe("resumeAtSameCall:只有 rejected 能续跑", () => {
  it("rejected → resume=true 并带回 feedback", () => {
    const r = resumeAtSameCall({ ...pending(), status: "rejected", feedback: "先补风险" });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(PLANEXIT_KEEP_PLANNING);
    expect(r.resume).toBe(true);
    expect(r.feedback).toBe("先补风险");
  });

  it("pending → 仍阻塞", () => {
    const r = resumeAtSameCall(pending());
    expect(r.code).toBe(PLANEXIT_PENDING);
    expect(r.resume).toBe(false);
    expect(r.detail).toBe("still-blocked");
  });

  it("approved → 等 pre-step", () => {
    const r = resumeAtSameCall({ ...pending(), status: "approved", pendingExitAt: T0 });
    expect(r.code).toBe(PLANEXIT_APPROVED);
    expect(r.resume).toBe(false);
  });

  it("failed → 超时收口", () => {
    const r = resumeAtSameCall({ ...pending(), status: "failed" });
    expect(r.code).toBe(PLANEXIT_TIMEOUT_FAILED);
    expect(r.resume).toBe(false);
  });

  it("形状非法 → INVALID", () => {
    expect(resumeAtSameCall({} as never).code).toBe(PLANEXIT_INVALID);
  });
});

describe("码表与状态判定", () => {
  it("稳定码表覆盖规格要求的 10 个码且不重复", () => {
    const required = [
      PLANEXIT_INVALID,
      PLANEXIT_INCOMPLETE_PLAN,
      PLANEXIT_BLOCKED_NO_CHANNEL,
      PLANEXIT_PENDING,
      PLANEXIT_APPROVED,
      PLANEXIT_APPLIED,
      PLANEXIT_KEEP_PLANNING,
      PLANEXIT_FEEDBACK_REQUIRED,
      PLANEXIT_TIMEOUT_FAILED,
      PLANEXIT_APPLY_BEFORE_DUE,
    ];
    for (const code of required) expect(PLANEXIT_CODES).toContain(code);
    expect(new Set(PLANEXIT_CODES).size).toBe(PLANEXIT_CODES.length);
  });

  it("isReviewState 只认四种状态", () => {
    expect(isReviewState({ status: "pending" })).toBe(true);
    expect(isReviewState({ status: "done" })).toBe(false);
    expect(isReviewState(null)).toBe(false);
  });
});
