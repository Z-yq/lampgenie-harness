/**
 * 计划退出评审持久层:.genie/rsi/plan-exits.json 原子写 / 坏账本拒写 / 业务拒绝零副作用。
 * 每个用例独立临时根目录,不碰仓内 .genie。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPlanExitOnDisk,
  decidePlanExitOnDisk,
  getPlanExitOnDisk,
  isPlanExitRejection,
  PLAN_EXIT_FILE,
  PLAN_EXIT_RELATIVE_DIR,
  PLAN_EXIT_STORE_ERROR,
  PLAN_EXIT_STORE_WRITE_MISMATCH,
  planExitPaths,
  readPlanExitStore,
  reportPlanExits,
  requestPlanExitOnDisk,
  timeoutPlanExitOnDisk,
  writePlanExitStore,
} from "../src/plan-exit-store.ts";
import { PLANEXIT_INVALID } from "@lampgenie/runtime/agent/plan-exit-review";

const T0 = 1_700_000_000_000;
const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "plan-exit-"));
  roots.push(root);
  return root;
}

function submission(planId = "p1") {
  return {
    planId,
    sessionId: "s1",
    plan: { goal: "ship", steps: ["a"], acceptance: ["b"] },
    submittedAt: T0,
  };
}

function ledger(root: string): { v: number; reviews: Record<string, { status: string; pendingExitAt?: number; exitApplied?: boolean }> } {
  return JSON.parse(readFileSync(planExitPaths(root).file, "utf8"));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("路径与空账本", () => {
  it("路径落在 .genie/rsi/plan-exits.json", () => {
    const paths = planExitPaths("/repo");
    expect(paths.dir).toBe("/repo/.genie/rsi");
    expect(paths.file).toBe("/repo/.genie/rsi/plan-exits.json");
    expect(PLAN_EXIT_RELATIVE_DIR).toBe(".genie/rsi");
    expect(PLAN_EXIT_FILE).toBe("plan-exits.json");
  });

  it("文件不存在 = 空账本 + ok + exists=false", () => {
    const root = newRoot();
    const read = readPlanExitStore(root);
    expect(read.ok).toBe(true);
    expect(read.exists).toBe(false);
    expect(read.store.reviews).toEqual({});
    expect(reportPlanExits(root).total).toBe(0);
  });

  it("空 root 是 TypeError", () => {
    expect(() => planExitPaths("")).toThrow(TypeError);
  });
});

describe("request:完整计划才落 pending", () => {
  it("channel=cli → pending 落盘 v1", () => {
    const root = newRoot();
    const r = requestPlanExitOnDisk(root, { submission: submission(), channel: { kind: "cli" } });
    expect(r.ok).toBe(true);
    expect(r.code).toBe("PLANEXIT_PENDING");
    expect(r.written).toBe(true);
    const data = ledger(root);
    expect(data.v).toBe(1);
    expect(data.reviews["p1"]?.status).toBe("pending");
    expect(data.reviews["p1"]?.pendingExitAt).toBeUndefined();
  });

  it("channel=none → BLOCKED_NO_CHANNEL 且零写入", () => {
    const root = newRoot();
    const r = requestPlanExitOnDisk(root, { submission: submission(), channel: { kind: "none" } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("PLANEXIT_BLOCKED_NO_CHANNEL");
    expect(r.written).toBe(false);
    expect(existsSync(planExitPaths(root).file)).toBe(false);
  });

  it("计划不完整 → INCOMPLETE_PLAN 且零写入", () => {
    const root = newRoot();
    const sub = submission();
    sub.plan.steps = [];
    const r = requestPlanExitOnDisk(root, { submission: sub, channel: { kind: "cli" } });
    expect(r.code).toBe("PLANEXIT_INCOMPLETE_PLAN");
    expect(r.missing).toContain("steps");
    expect(existsSync(planExitPaths(root).file)).toBe(false);
  });

  it("同一 planId 已有 pending 时重复 request → PENDING 且不覆盖", () => {
    const root = newRoot();
    requestPlanExitOnDisk(root, { submission: submission(), channel: { kind: "cli" } });
    const again = requestPlanExitOnDisk(root, {
      submission: { ...submission(), submittedAt: T0 + 999 },
      channel: { kind: "cli" },
    });
    expect(again.ok).toBe(true);
    expect(again.code).toBe("PLANEXIT_PENDING");
    expect(again.written).toBe(false);
    expect(ledger(root).reviews["p1"]?.status).toBe("pending");
  });

  it("坏账本 → STORE_ERROR 且拒写(原文件字节不变)", () => {
    const root = newRoot();
    const paths = planExitPaths(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.file, "{oops", "utf8");
    const before = readFileSync(paths.file, "utf8");
    const r = requestPlanExitOnDisk(root, { submission: submission(), channel: { kind: "cli" } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(PLAN_EXIT_STORE_ERROR);
    expect(readFileSync(paths.file, "utf8")).toBe(before);
  });
});

describe("decide:approve 与 keep-planning", () => {
  it("approve → approved + pendingExitAt=at,且不置 exitApplied", () => {
    const root = newRoot();
    requestPlanExitOnDisk(root, { submission: submission(), channel: { kind: "cli" } });
    const r = decidePlanExitOnDisk(root, { planId: "p1", decision: "approve", at: T0 + 10 });
    expect(r.ok).toBe(true);
    expect(r.code).toBe("PLANEXIT_APPROVED");
    const state = ledger(root).reviews["p1"];
    expect(state?.status).toBe("approved");
    expect(state?.pendingExitAt).toBe(T0 + 10);
    expect(state?.exitApplied).toBeUndefined();
  });

  it("keep-planning 无 feedback → FEEDBACK_REQUIRED 且账本不变", () => {
    const root = newRoot();
    requestPlanExitOnDisk(root, { submission: submission(), channel: { kind: "cli" } });
    const before = readFileSync(planExitPaths(root).file, "utf8");
    const r = decidePlanExitOnDisk(root, { planId: "p1", decision: "keep-planning", at: T0 + 10 });
    expect(r.code).toBe("PLANEXIT_FEEDBACK_REQUIRED");
    expect(r.written).toBe(false);
    expect(readFileSync(planExitPaths(root).file, "utf8")).toBe(before);
  });

  it("keep-planning 带 feedback → rejected + resume + 账本记录反馈", () => {
    const root = newRoot();
    requestPlanExitOnDisk(root, { submission: submission(), channel: { kind: "cli" } });
    const r = decidePlanExitOnDisk(root, { planId: "p1", decision: "keep-planning", feedback: "补风险", at: T0 + 11 });
    expect(r.code).toBe("PLANEXIT_KEEP_PLANNING");
    expect(r.resume).toBe(true);
    expect(r.feedback).toBe("补风险");
    expect(ledger(root).reviews["p1"]?.status).toBe("rejected");
  });

  it("未知 planId → INVALID", () => {
    const root = newRoot();
    const r = decidePlanExitOnDisk(root, { planId: "nope", decision: "approve", at: T0 });
    expect(r.code).toBe(PLANEXIT_INVALID);
    expect(r.written).toBe(false);
  });
});

describe("timeout / apply / report", () => {
  it("未到点 → PENDING 且不写盘", () => {
    const root = newRoot();
    requestPlanExitOnDisk(root, { submission: submission(), channel: { kind: "cli" } });
    const before = readFileSync(planExitPaths(root).file, "utf8");
    const r = timeoutPlanExitOnDisk(root, { planId: "p1", now: T0 + 1 });
    expect(r.code).toBe("PLANEXIT_PENDING");
    expect(r.written).toBe(false);
    expect(readFileSync(planExitPaths(root).file, "utf8")).toBe(before);
  });

  it("到点 → TIMEOUT_FAILED 且 status=failed(绝不 approved)", () => {
    const root = newRoot();
    requestPlanExitOnDisk(root, { submission: submission(), channel: { kind: "cli" } });
    const r = timeoutPlanExitOnDisk(root, { planId: "p1", now: T0 + 700_000 });
    expect(r.code).toBe("PLANEXIT_TIMEOUT_FAILED");
    expect(ledger(root).reviews["p1"]?.status).toBe("failed");
  });

  it("提前 apply → APPLY_BEFORE_DUE 且 exitApplied 未置位", () => {
    const root = newRoot();
    requestPlanExitOnDisk(root, { submission: submission(), channel: { kind: "cli" } });
    decidePlanExitOnDisk(root, { planId: "p1", decision: "approve", at: T0 + 10 });
    const r = applyPlanExitOnDisk(root, { planId: "p1", preStepAt: T0 + 9 });
    expect(r.code).toBe("PLANEXIT_APPLY_BEFORE_DUE");
    expect(ledger(root).reviews["p1"]?.exitApplied).toBeUndefined();
  });

  it("到点 apply → APPLIED 且只生效一次", () => {
    const root = newRoot();
    requestPlanExitOnDisk(root, { submission: submission(), channel: { kind: "cli" } });
    decidePlanExitOnDisk(root, { planId: "p1", decision: "approve", at: T0 + 10 });
    const applied = applyPlanExitOnDisk(root, { planId: "p1", preStepAt: T0 + 10 });
    expect(applied.code).toBe("PLANEXIT_APPLIED");
    expect(ledger(root).reviews["p1"]?.exitApplied).toBe(true);
    const again = applyPlanExitOnDisk(root, { planId: "p1", preStepAt: T0 + 20 });
    expect(again.ok).toBe(false);
    expect(again.code).toBe(PLANEXIT_INVALID);
  });

  it("report 按状态计数 + 逐条 + 拒绝码判定", () => {
    const root = newRoot();
    requestPlanExitOnDisk(root, { submission: submission("p1"), channel: { kind: "cli" } });
    requestPlanExitOnDisk(root, { submission: submission("p2"), channel: { kind: "cli" } });
    decidePlanExitOnDisk(root, { planId: "p2", decision: "keep-planning", feedback: "x", at: T0 + 1 });
    const report = reportPlanExits(root);
    expect(report.ok).toBe(true);
    expect(report.total).toBe(2);
    expect(report.byStatus.pending).toBe(1);
    expect(report.byStatus.rejected).toBe(1);
    expect(report.reviews[0]?.planId).toBe("p1");
    expect(isPlanExitRejection("PLANEXIT_APPLY_BEFORE_DUE")).toBe(true);
    expect(isPlanExitRejection("PLANEXIT_APPLIED")).toBe(false);
  });

  it("原子写:落盘后目录只剩账本文件(无 .tmp 残留)", () => {
    const root = newRoot();
    const ok = writePlanExitStore(root, { v: 1, reviews: {} });
    expect(ok.ok).toBe(true);
    const files = readdirSync(planExitPaths(root).dir);
    expect(files).toEqual([PLAN_EXIT_FILE]);
    expect(PLAN_EXIT_STORE_WRITE_MISMATCH).toBe("PLANEXIT_STORE_WRITE_MISMATCH");
  });

  it("点查接口返回当前状态", () => {
    const root = newRoot();
    requestPlanExitOnDisk(root, { submission: submission(), channel: { kind: "cli" } });
    expect(getPlanExitOnDisk(root, "p1").review?.status).toBe("pending");
    expect(getPlanExitOnDisk(root, "nope").review).toBeUndefined();
  });
});
