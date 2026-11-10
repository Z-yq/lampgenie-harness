/**
 * goal 续跑身份护栏专项。
 * 锚定:
 * ① goalContinueVerdict 五码纯判据(INACTIVE / ROUND_LIMIT / SUBAGENTS_ACTIVE / BUDGET / REVISION_STALE);
 * ② maybeContinueGoal 在 paused / 预算 / 子代理活跃 / 轮数上限下不 submit 且落 goal.blocked;
 * ③ 正常续跑带 revision/round(任务书身份行 + journal goal.continue 回填 messageId);
 * ④ 期望修订号不一致 → REVISION_STALE 拒绝。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { goalContinueVerdict, readGoalFromJournal, type SessionGoal } from "@lampgenie/runtime/agent/goal";
import { TaskSupervisor } from "../src/task-manager.js";
import { maybeContinueGoal } from "../src/agent-wiring.js";

// maybeContinueGoal 在会话 worker 子进程内直接 return(生产正确行为);测试环境若残留
// GENIE_SESSION_WORKER_CHILD=1 会静默跳过全部用例,故按块清理并在块末恢复。
const savedWorkerChild = process.env["GENIE_SESSION_WORKER_CHILD"];
beforeEach(() => { delete process.env["GENIE_SESSION_WORKER_CHILD"]; });
afterEach(() => {
  if (savedWorkerChild === undefined) delete process.env["GENIE_SESSION_WORKER_CHILD"];
  else process.env["GENIE_SESSION_WORKER_CHILD"] = savedWorkerChild;
});

const GOAL_BASE: SessionGoal = {
  sessionId: "g", objective: "把登录页修好", status: "active",
  tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, startedAt: 0, updatedAt: 0,
  revision: 2, round: 0,
};

describe("goalContinueVerdict 五码(纯判据)", () => {
  it("INACTIVE:无目标 / 非 active 都拒", () => {
    expect(goalContinueVerdict({ goal: null, round: 0, maxContinues: 5 }).code).toBe("GOAL_INACTIVE");
    for (const status of ["paused", "complete", "budget_limited"] as const) {
      const v = goalContinueVerdict({ goal: { ...GOAL_BASE, status }, round: 0, maxContinues: 5 });
      expect(v.allow).toBe(false);
      expect(v.code).toBe("GOAL_INACTIVE");
    }
  });

  it("ROUND_LIMIT:round>=max 拒,差一轮放行", () => {
    expect(goalContinueVerdict({ goal: GOAL_BASE, round: 4, maxContinues: 5 }).allow).toBe(true);
    const v = goalContinueVerdict({ goal: GOAL_BASE, round: 5, maxContinues: 5 });
    expect(v.code).toBe("GOAL_ROUND_LIMIT");
  });

  it("SUBAGENTS_ACTIVE:有活跃子代理就拒", () => {
    expect(goalContinueVerdict({ goal: GOAL_BASE, round: 0, maxContinues: 5, activeSubagents: 2 }).code).toBe("GOAL_SUBAGENTS_ACTIVE");
    expect(goalContinueVerdict({ goal: GOAL_BASE, round: 0, maxContinues: 5, activeSubagents: 0 }).allow).toBe(true);
  });

  it("BUDGET:token 用满拒;无界预算不拦", () => {
    expect(goalContinueVerdict({ goal: { ...GOAL_BASE, tokenBudget: 1000, tokensUsed: 1000 }, round: 0, maxContinues: 5 }).code).toBe("GOAL_BUDGET");
    expect(goalContinueVerdict({ goal: { ...GOAL_BASE, tokenBudget: null, tokensUsed: 99_999 }, round: 0, maxContinues: 5 }).allow).toBe(true);
  });

  it("REVISION_STALE:期望修订号不一致拒;缺省不校验", () => {
    expect(goalContinueVerdict({ goal: GOAL_BASE, round: 0, maxContinues: 5, expectedRevision: 1 }).code).toBe("GOAL_REVISION_STALE");
    expect(goalContinueVerdict({ goal: GOAL_BASE, round: 0, maxContinues: 5, expectedRevision: 2 }).allow).toBe(true);
    expect(goalContinueVerdict({ goal: GOAL_BASE, round: 0, maxContinues: 5 }).allow).toBe(true);
  });
});

describe("readGoalFromJournal:revision / round 口径", () => {
  it("每条 goal.set 递增 revision;round=goal.continue 事件数", () => {
    const j = new MemoryJournal();
    j.append({ kind: "goal.set", sessionId: "r", payload: { goal: "a", state: "active" } });
    j.append({ kind: "goal.set", sessionId: "r", payload: { goal: "a", state: "paused" } });
    j.append({ kind: "goal.set", sessionId: "r", payload: { goal: "a", state: "active" } });
    j.append({ kind: "custom", sessionId: "r", payload: { type: "goal.continue", round: 1 } });
    j.append({ kind: "custom", sessionId: "r", payload: { type: "goal.blocked", code: "GOAL_BUDGET" } });
    j.append({ kind: "custom", sessionId: "r", payload: { type: "goal.continue", round: 2 } });
    const g = readGoalFromJournal(j.readAll(), "r")!;
    expect(g.revision).toBe(3);
    expect(g.round).toBe(2);
    // 其它会话的 goal.continue 不串号
    expect(readGoalFromJournal(j.readAll(), "other")).toBeNull();
  });
});

/** 完成校验器假 LLM:返回未通过(fail-open 分支不会触发续跑,所以这里给明确 JSON)。 */
function verifierLlm(nextAction = "补测试"): { chat: () => Promise<{ content: string }> } {
  return { async chat() { return { content: JSON.stringify({ passed: false, reason: "还差一步", nextAction }) }; } };
}

function makeTm(): TaskSupervisor {
  return new TaskSupervisor({ maxConcurrent: 4, maxConcurrentPerOwner: 2, maxConcurrentSystem: 2 });
}

function setGoal(j: MemoryJournal, sessionId: string, extra: Record<string, unknown> = {}): void {
  j.append({ kind: "goal.set", sessionId, payload: { goal: "把登录页修好", state: "active", ...extra } });
}

function blockedEvents(j: MemoryJournal): Array<{ code?: string; reason?: string; round?: number; revision?: number }> {
  return j.readAll()
    .filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "goal.blocked")
    .map((e) => e.payload as { code?: string; reason?: string; round?: number; revision?: number });
}

describe("maybeContinueGoal 发轮前校验", () => {
  it("paused:不 submit,落 goal.blocked{GOAL_INACTIVE}", async () => {
    const j = new MemoryJournal();
    const tm = makeTm();
    setGoal(j, "s-paused", { state: "paused" });
    await maybeContinueGoal(tm, j, verifierLlm() as never, "s-paused");
    expect(tm.list()).toHaveLength(0);
    const blocked = blockedEvents(j);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.code).toBe("GOAL_INACTIVE");
    expect(blocked[0]!.revision).toBe(1);
  });

  it("预算超:不 submit,落 goal.blocked{GOAL_BUDGET} 且目标置 budget_limited", async () => {
    const j = new MemoryJournal();
    const tm = makeTm();
    setGoal(j, "s-budget", { tokenBudget: 10 });
    j.append({ kind: "message.agent", sessionId: "s-budget", payload: { text: "x", usage: { totalTokens: 50 } } });
    await maybeContinueGoal(tm, j, verifierLlm() as never, "s-budget");
    expect(tm.list()).toHaveLength(0);
    expect(blockedEvents(j)[0]!.code).toBe("GOAL_BUDGET");
    const lastGoal = j.readAll().filter((e) => e.kind === "goal.set").at(-1)!.payload as { state: string };
    expect(lastGoal.state).toBe("budget_limited");
  });

  it("子代理活跃:不 submit,落 goal.blocked{GOAL_SUBAGENTS_ACTIVE}", async () => {
    const j = new MemoryJournal();
    const tm = makeTm();
    setGoal(j, "s-sub");
    await maybeContinueGoal(tm, j, verifierLlm() as never, "s-sub", { activeSubagents: 1 });
    expect(tm.list()).toHaveLength(0);
    expect(blockedEvents(j)[0]!.code).toBe("GOAL_SUBAGENTS_ACTIVE");
  });

  it("轮数上限:不 submit,落 goal.blocked{GOAL_ROUND_LIMIT} 且目标置 paused", async () => {
    const j = new MemoryJournal();
    const tm = makeTm();
    setGoal(j, "s-round");
    j.append({ kind: "custom", sessionId: "s-round", payload: { type: "goal.continue", round: 1 } });
    await maybeContinueGoal(tm, j, verifierLlm() as never, "s-round", { maxContinues: 1 });
    expect(tm.list()).toHaveLength(0);
    expect(blockedEvents(j)[0]!.code).toBe("GOAL_ROUND_LIMIT");
    expect(blockedEvents(j)[0]!.round).toBe(1);
    const lastGoal = j.readAll().filter((e) => e.kind === "goal.set").at(-1)!.payload as { state: string };
    expect(lastGoal.state).toBe("paused");
  });

  it("revision 变化:不 submit,落 goal.blocked{GOAL_REVISION_STALE}", async () => {
    const j = new MemoryJournal();
    const tm = makeTm();
    setGoal(j, "s-stale");
    setGoal(j, "s-stale"); // revision=2
    await maybeContinueGoal(tm, j, verifierLlm() as never, "s-stale", { expectedRevision: 1 });
    expect(tm.list()).toHaveLength(0);
    const blocked = blockedEvents(j);
    expect(blocked[0]!.code).toBe("GOAL_REVISION_STALE");
    expect(blocked[0]!.revision).toBe(2);
  });

  it("正常续跑:submit 一轮,任务书带 revision/round,journal goal.continue 回填 messageId", async () => {
    const j = new MemoryJournal();
    const tm = makeTm();
    setGoal(j, "s-ok");
    await maybeContinueGoal(tm, j, verifierLlm("补一个测试") as never, "s-ok");
    const tasks = tm.list().filter((t) => t.sessionId === "s-ok");
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.instruction).toContain("补一个测试");
    expect(task.instruction).toContain("[goal] revision=1 round=1");
    const cont = j.readAll().find((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "goal.continue")!;
    const payload = cont.payload as { revision: number; round: number; messageId: string };
    expect(payload.revision).toBe(1);
    expect(payload.round).toBe(1);
    expect(payload.messageId).toBe(task.id);
    // 已续跑过一轮 → 下一轮身份行 round 递增(round 来自 goal.continue 事件数)
    const g = readGoalFromJournal(j.readAll(), "s-ok")!;
    expect(g.round).toBe(1);
  });
});
