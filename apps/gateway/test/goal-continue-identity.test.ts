/**
 * Goal 续跑身份护栏接生产链专项。
 * 锚定:
 * ① 生产传 expectedRevision:过期(任务运行期间 goal.set 再来一条)→ GOAL_REVISION_STALE,无 submit;
 * ② 任务运行期间 goal 被 clear → 无目标静默返回(无 submit / 无 blocked);
 * ③ 重复轮:同 round 二次调用、或该轮已有 goal.continue → GOAL_DUPLICATE_ROUND,无第二次 submit;
 * ④ claim/release 成对:happy path = claim→goal.continue(continue 即结账,不 release);
 *    verifier passed → release;连续不可用暂停 → release;verifier/submit 抛异常 → release 后重抛;
 * ⑤ 悬挂 claim(无 release、无 continue)→ 崩溃重试放行;claim + continue 同轮 → 判重复轮。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { goalContinueVerdict, goalRoundClaimState, readGoalFromJournal, type SessionGoal } from "@lampgenie/runtime/agent/goal";
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

/** 完成校验器假 LLM:未通过(会真正派轮)。 */
function verifierLlm(nextAction = "补测试"): { chat: () => Promise<{ content: string }> } {
  return { async chat() { return { content: JSON.stringify({ passed: false, reason: "还差一步", nextAction }) }; } };
}

/** 完成校验器假 LLM:已通过(不续跑)。 */
function passLlm(): { chat: () => Promise<{ content: string }> } {
  return { async chat() { return { content: JSON.stringify({ passed: true, reason: "做完了", nextAction: "" }) }; } };
}

/** 完成校验器假 LLM:总是抛错(走 unavailable 分支)。 */
function throwLlm(): { chat: () => Promise<{ content: string }> } {
  return { async chat() { throw new Error("verifier boom"); } };
}

function makeTm(): TaskSupervisor {
  return new TaskSupervisor({ maxConcurrent: 4, maxConcurrentPerOwner: 2, maxConcurrentSystem: 2 });
}

function setGoal(j: MemoryJournal, sessionId: string, objective = "把登录页修好"): void {
  j.append({ kind: "goal.set", sessionId, payload: { goal: objective, state: "active" } });
}

function eventsOf(j: MemoryJournal, type: string): Array<Record<string, unknown>> {
  return j.readAll()
    .filter((e) => e.kind === "custom" && (e.payload as { type?: unknown }).type === type)
    .map((e) => e.payload as Record<string, unknown>);
}

function blockedEvents(j: MemoryJournal): Array<{ code?: string; reason?: string; round?: number; revision?: number }> {
  return eventsOf(j, "goal.blocked") as Array<{ code?: string; reason?: string; round?: number; revision?: number }>;
}

describe("goalContinueVerdict 重复轮判据(纯判据)", () => {
  it("DUPLICATE_ROUND:该轮已有 continue / 已有 [goal] 任务在跑 → 拒", () => {
    expect(goalContinueVerdict({ goal: GOAL_BASE, round: 0, maxContinues: 5, hasContinueForRound: true }).code).toBe("GOAL_DUPLICATE_ROUND");
    expect(goalContinueVerdict({ goal: GOAL_BASE, round: 0, maxContinues: 5, hasTaskForRound: true }).code).toBe("GOAL_DUPLICATE_ROUND");
  });

  it("悬挂 claim(该轮 claim、无 release/continue、无 goal 任务)→ 崩溃重试放行", () => {
    const v = goalContinueVerdict({ goal: GOAL_BASE, round: 0, maxContinues: 5, claimedRound: 1 });
    expect(v.allow).toBe(true);
    expect(v.reason).toContain("崩溃重试");
    // claim 但仍有 [goal] 任务在跑 = 崩溃发生在 submit 之后 → 不许双派
    expect(goalContinueVerdict({ goal: GOAL_BASE, round: 0, maxContinues: 5, claimedRound: 1, hasTaskForRound: true }).code).toBe("GOAL_DUPLICATE_ROUND");
    // claim + continue 同轮 → 已真正派出,判重复轮
    expect(goalContinueVerdict({ goal: GOAL_BASE, round: 0, maxContinues: 5, claimedRound: 1, hasContinueForRound: true }).code).toBe("GOAL_DUPLICATE_ROUND");
  });

  it("重复轮判据排在修订号之后:过期修订优先报 REVISION_STALE", () => {
    expect(goalContinueVerdict({ goal: GOAL_BASE, round: 0, maxContinues: 5, expectedRevision: 1, hasTaskForRound: true }).code).toBe("GOAL_REVISION_STALE");
  });
});

describe("goalRoundClaimState(claim/release/continue 留痕状态)", () => {
  it("只认本会话、本轮次的三个事件", () => {
    const j = new MemoryJournal();
    j.append({ kind: "custom", sessionId: "s", payload: { type: "goal.round.claim", round: 2 } });
    j.append({ kind: "custom", sessionId: "s", payload: { type: "goal.round.release", round: 2, reason: "verifier-passed" } });
    j.append({ kind: "custom", sessionId: "s", payload: { type: "goal.continue", round: 2 } });
    j.append({ kind: "custom", sessionId: "s", payload: { type: "goal.round.claim", round: 3 } });
    j.append({ kind: "custom", sessionId: "other", payload: { type: "goal.round.claim", round: 2 } });
    expect(goalRoundClaimState(j.readAll(), "s", 2)).toEqual({ claimed: true, released: true, continued: true });
    expect(goalRoundClaimState(j.readAll(), "s", 3)).toEqual({ claimed: true, released: false, continued: false });
    expect(goalRoundClaimState(j.readAll(), "s", 4)).toEqual({ claimed: false, released: false, continued: false });
  });
});

describe("maybeContinueGoal 生产口径:expectedRevision", () => {
  it("过期修订号:不 submit,落 goal.blocked{GOAL_REVISION_STALE},不立 claim", async () => {
    const j = new MemoryJournal();
    setGoal(j, "s-stale");
    const rev = readGoalFromJournal(j.readAll(), "s-stale")!.revision;
    const tm = makeTm();
    await maybeContinueGoal(tm, j, verifierLlm() as never, "s-stale", { expectedRevision: rev });
    expect(tm.list()).toHaveLength(1);

    setGoal(j, "s-stale"); // 任务运行期间用户换了目标 → revision+1
    const tm2 = makeTm(); // 新 TaskSupervisor 避开「[goal] 任务在跑」的重复轮判定,单测 revision 判据
    await maybeContinueGoal(tm2, j, verifierLlm() as never, "s-stale", { expectedRevision: rev });
    expect(tm2.list()).toHaveLength(0);
    expect(blockedEvents(j).at(-1)!.code).toBe("GOAL_REVISION_STALE");
    expect(eventsOf(j, "goal.round.claim")).toHaveLength(1); // 只有第一轮(放行那次)立过 claim
    expect(eventsOf(j, "goal.continue")).toHaveLength(1);
  });

  it("目标被 clear:静默返回(无 submit / 无 blocked / 不调校验器)", async () => {
    const j = new MemoryJournal();
    setGoal(j, "s-clear");
    j.append({ kind: "goal.set", sessionId: "s-clear", payload: { goal: null, state: "active" } });
    let calls = 0;
    const llm = { async chat() { calls += 1; return { content: "{}" }; } };
    const tm = makeTm();
    await maybeContinueGoal(tm, j, llm as never, "s-clear");
    expect(tm.list()).toHaveLength(0);
    expect(calls).toBe(0);
    expect(blockedEvents(j)).toHaveLength(0);
    expect(eventsOf(j, "goal.round.claim")).toHaveLength(0);
  });
});

describe("maybeContinueGoal 重复轮护栏", () => {
  it("同 round 调用两次:第二次 GOAL_DUPLICATE_ROUND,无第二次 submit", async () => {
    const j = new MemoryJournal();
    setGoal(j, "s-dup");
    const tm = makeTm();
    await maybeContinueGoal(tm, j, verifierLlm("a") as never, "s-dup");
    await maybeContinueGoal(tm, j, verifierLlm("b") as never, "s-dup");
    expect(tm.list().filter((t) => t.sessionId === "s-dup")).toHaveLength(1);
    expect(eventsOf(j, "goal.continue")).toHaveLength(1);
    expect(blockedEvents(j).at(-1)!.code).toBe("GOAL_DUPLICATE_ROUND");
  });

  it("该轮已有 goal.continue 留痕:幂等拒发(不调校验器)", async () => {
    const j = new MemoryJournal();
    setGoal(j, "s-cont");
    j.append({ kind: "custom", sessionId: "s-cont", payload: { type: "goal.continue", round: 5, messageId: "m-old" } });
    let calls = 0;
    const llm = { async chat() { calls += 1; return { content: "{}" }; } };
    const tm = makeTm();
    await maybeContinueGoal(tm, j, llm as never, "s-cont");
    expect(tm.list()).toHaveLength(0);
    expect(calls).toBe(0);
    expect(blockedEvents(j)[0]!.code).toBe("GOAL_DUPLICATE_ROUND");
  });
});

describe("maybeContinueGoal round claim/release 成对", () => {
  it("happy path:claim → goal.continue(continue 结账,不 release)", async () => {
    const j = new MemoryJournal();
    setGoal(j, "s-claim");
    const tm = makeTm();
    await maybeContinueGoal(tm, j, verifierLlm("补测试") as never, "s-claim");
    const claims = eventsOf(j, "goal.round.claim");
    expect(claims).toHaveLength(1);
    expect(claims[0]!["round"]).toBe(1);
    expect(claims[0]!["revision"]).toBe(1);
    expect(typeof claims[0]!["tickId"]).toBe("string");
    expect(eventsOf(j, "goal.round.release")).toHaveLength(0);
    const cont = eventsOf(j, "goal.continue");
    expect(cont).toHaveLength(1);
    expect(cont[0]!["round"]).toBe(1);
    // claim 落在 continue 之前(顺序=先立 claim 再派发)
    const all = j.readAll().filter((e) => e.kind === "custom");
    const claimIdx = all.findIndex((e) => (e.payload as { type?: string }).type === "goal.round.claim");
    const contIdx = all.findIndex((e) => (e.payload as { type?: string }).type === "goal.continue");
    expect(claimIdx).toBeGreaterThanOrEqual(0);
    expect(claimIdx).toBeLessThan(contIdx);
  });

  it("verifier passed:claim → release(reason=verifier-passed),不 submit", async () => {
    const j = new MemoryJournal();
    setGoal(j, "s-pass");
    const tm = makeTm();
    await maybeContinueGoal(tm, j, passLlm() as never, "s-pass");
    expect(tm.list()).toHaveLength(0);
    expect(eventsOf(j, "goal.round.claim")).toHaveLength(1);
    const rel = eventsOf(j, "goal.round.release");
    expect(rel).toHaveLength(1);
    expect(rel[0]!["round"]).toBe(1);
    expect(rel[0]!["reason"]).toBe("verifier-passed");
    expect(rel[0]!["tickId"]).toBe(eventsOf(j, "goal.round.claim")[0]!["tickId"]);
  });

  it("连续不可用暂停:claim → release(reason=verifier-unavailable),目标 paused", async () => {
    const j = new MemoryJournal();
    setGoal(j, "s-unavail");
    // 第 1 轮 fallback 续跑(新 TaskSupervisor 避开 busy/goal 任务判定)
    await maybeContinueGoal(makeTm(), j, throwLlm() as never, "s-unavail");
    expect(eventsOf(j, "goal.continue")).toHaveLength(1);
    // 第 2 轮:连续不可用 → blocked + release
    const tm2 = makeTm();
    await maybeContinueGoal(tm2, j, throwLlm() as never, "s-unavail");
    expect(tm2.list()).toHaveLength(0);
    expect(blockedEvents(j).at(-1)!.code).toBe("GOAL_VERIFIER_UNAVAILABLE");
    const rel = eventsOf(j, "goal.round.release");
    expect(rel).toHaveLength(1);
    expect(rel[0]!["round"]).toBe(2);
    expect(rel[0]!["reason"]).toBe("verifier-unavailable");
    const lastGoal = j.readAll().filter((e) => e.kind === "goal.set").at(-1)!.payload as { state: string };
    expect(lastGoal.state).toBe("paused");
  });

  it("异常路径(tm.submit 抛错):claim → release(reason 带错误),异常继续上抛", async () => {
    const j = new MemoryJournal();
    setGoal(j, "s-boom");
    const boomTm = {
      list: () => [],
      submit: () => { throw new Error("submit-boom"); },
    };
    await expect(maybeContinueGoal(boomTm as never, j, verifierLlm() as never, "s-boom")).rejects.toThrow("submit-boom");
    const rel = eventsOf(j, "goal.round.release");
    expect(rel).toHaveLength(1);
    expect(String(rel[0]!["reason"])).toContain("submit-boom");
    expect(eventsOf(j, "goal.continue")).toHaveLength(0);
  });

  it("悬挂 claim(无 release 无 continue)→ 崩溃重试放行,正常派轮", async () => {
    const j = new MemoryJournal();
    setGoal(j, "s-retry");
    j.append({ kind: "custom", sessionId: "s-retry", payload: { type: "goal.round.claim", round: 1, revision: 1, tickId: "t-dead", at: Date.now() } });
    const tm = makeTm();
    await maybeContinueGoal(tm, j, verifierLlm("补测试") as never, "s-retry");
    expect(tm.list().filter((t) => t.sessionId === "s-retry")).toHaveLength(1);
    const cont = eventsOf(j, "goal.continue");
    expect(cont).toHaveLength(1);
    expect(cont[0]!["round"]).toBe(1);
    expect(blockedEvents(j)).toHaveLength(0);
  });
});
