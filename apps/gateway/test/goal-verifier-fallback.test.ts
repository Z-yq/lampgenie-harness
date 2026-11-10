/**
 * goal 校验器失败不再静默停摆(专项)。
 * 锚定:
 * ① goal 存在且非 busy → 落 custom goal.tick;无 goal / busy → 不落;
 * ② 校验器首败(超时/抛错/非 JSON)→ 重试一次(45s/最近 16 条),每次尝试落 goal.verifier;
 * ③ 重试仍 unavailable → 第 1 轮 fallback 续跑(goal.continue fallback=true),连续第 2 轮
 *    goal.blocked{GOAL_VERIFIER_UNAVAILABLE} + goal.set paused + message.system;
 * ④ 中间恢复有效结果 → 连续失败计数清零;passed → complete 不续跑;
 * ⑤ fallback 任务书含矩阵文件路径与「校验器不可用」;续跑提示词含重启纪律行。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import {
  consecutiveVerifierFailures,
  formatGoalContinuationPrompt,
  type SessionGoal,
} from "@lampgenie/runtime/agent/goal";
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

type Step = { kind: "pass" | "fail" | "throw" | "garbage"; nextAction?: string; reason?: string };

/** 假校验器 LLM:按脚本顺序回应(用尽后重复最后一步);记录调用次数与每次消息数。 */
function scriptedLlm(steps: Step[]): { chat: (messages: Array<{ role: string }>) => Promise<{ content: string }>; calls: () => number; seen: number[] } {
  const seen: number[] = [];
  let i = 0;
  return {
    async chat(messages: Array<{ role: string }>) {
      const s = steps[Math.min(i, steps.length - 1)]!;
      i += 1;
      seen.push(messages.length);
      if (s.kind === "throw") throw new Error("verifier timeout");
      if (s.kind === "garbage") return { content: "模型胡言乱语,没有任何 JSON" };
      return { content: JSON.stringify({ passed: s.kind === "pass", reason: s.reason ?? "r", nextAction: s.nextAction ?? "" }) };
    },
    calls: () => i,
    seen,
  };
}

function makeTm(): TaskSupervisor {
  return new TaskSupervisor({ maxConcurrent: 4, maxConcurrentPerOwner: 2, maxConcurrentSystem: 2 });
}

function setGoal(j: MemoryJournal, sessionId: string, objective = "把登录页修好"): void {
  j.append({ kind: "goal.set", sessionId, payload: { goal: objective, state: "active" } });
}

function eventsOf(j: MemoryJournal, type: string): Array<Record<string, unknown>> {
  return j.readAll()
    .filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === type)
    .map((e) => e.payload as Record<string, unknown>);
}

function lastGoalState(j: MemoryJournal): string {
  const last = j.readAll().filter((e) => e.kind === "goal.set").at(-1)!.payload as { state?: string };
  return String(last.state);
}

const GOAL_BASE: SessionGoal = {
  sessionId: "s", objective: "修登录页", status: "active",
  tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, startedAt: 0, updatedAt: 0,
  revision: 1, round: 0,
};

describe("goal.tick 入口留痕", () => {
  it("有 goal 且非 busy → 落 goal.tick{sessionId,tickId,round,revision,status,activeSubagents,at}", async () => {
    const j = new MemoryJournal();
    setGoal(j, "s-tick");
    await maybeContinueGoal(makeTm(), j, scriptedLlm([{ kind: "pass" }]) as never, "s-tick");
    const ticks = eventsOf(j, "goal.tick");
    expect(ticks).toHaveLength(1);
    const t = ticks[0]!;
    expect(t["sessionId"]).toBe("s-tick");
    expect(typeof t["tickId"]).toBe("string");
    expect(t["round"]).toBe(0);
    expect(t["revision"]).toBe(1);
    expect(t["status"]).toBe("active");
    expect(t["activeSubagents"]).toBe(0);
    expect(typeof t["at"]).toBe("number");
  });

  it("无 goal → 不落 goal.tick,不调校验器", async () => {
    const j = new MemoryJournal();
    const llm = scriptedLlm([{ kind: "fail" }]);
    await maybeContinueGoal(makeTm(), j, llm as never, "s-none");
    expect(eventsOf(j, "goal.tick")).toHaveLength(0);
    expect(llm.calls()).toBe(0);
  });

  it("busy(会话有 running/queued 任务)→ 不落 goal.tick,不续跑", async () => {
    const j = new MemoryJournal();
    const tm = makeTm();
    setGoal(j, "s-busy");
    tm.submit("system", "s-busy", "进行中的任务", { title: "running" });
    const llm = scriptedLlm([{ kind: "fail" }]);
    await maybeContinueGoal(tm, j, llm as never, "s-busy");
    expect(eventsOf(j, "goal.tick")).toHaveLength(0);
    expect(llm.calls()).toBe(0);
    expect(tm.list().filter((t) => t.sessionId === "s-busy")).toHaveLength(1);
  });
});

describe("校验器重试与 goal.verifier 留痕", () => {
  it("首轮抛错 → 重试拿到 not_passed → 正常续跑,goal.verifier 两条(unavailable/not_passed)", async () => {
    const j = new MemoryJournal();
    const tm = makeTm();
    setGoal(j, "s-retry");
    const llm = scriptedLlm([{ kind: "throw" }, { kind: "fail", nextAction: "补测试" }]);
    await maybeContinueGoal(tm, j, llm as never, "s-retry");

    const verifier = eventsOf(j, "goal.verifier");
    expect(verifier.map((v) => v["result"])).toEqual(["unavailable", "not_passed"]);
    expect(verifier.map((v) => v["attempt"])).toEqual([1, 2]);
    expect(verifier[0]!["tickId"]).toBe(verifier[1]!["tickId"]);
    expect(typeof verifier[0]!["durationMs"]).toBe("number");
    expect(llm.calls()).toBe(2);
    // 首次 24 条历史 / 重试 16 条(都是 +1 条 system 提示)
    expect(llm.seen[0]).toBeLessThanOrEqual(25);
    expect(llm.seen[1]).toBeLessThanOrEqual(17);

    const tasks = tm.list().filter((t) => t.sessionId === "s-retry");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.instruction).toContain("补测试");
    const cont = eventsOf(j, "goal.continue");
    expect(cont).toHaveLength(1);
    expect(cont[0]!["fallback"]).toBeUndefined();
    expect(eventsOf(j, "goal.blocked")).toHaveLength(0);
    expect(lastGoalState(j)).toBe("active");
  });

  it("非 JSON 输出同样算 unavailable → 重试仍不可用走兜底", async () => {
    const j = new MemoryJournal();
    setGoal(j, "s-garbage");
    await maybeContinueGoal(makeTm(), j, scriptedLlm([{ kind: "garbage" }]) as never, "s-garbage");
    const verifier = eventsOf(j, "goal.verifier");
    expect(verifier.map((v) => v["result"])).toEqual(["unavailable", "unavailable"]);
    expect(eventsOf(j, "goal.continue")[0]!["fallback"]).toBe(true);
  });
});

describe("连续不可用:兜底续跑 → 暂停", () => {
  it("第 1 轮 fallback 续跑(任务书含矩阵路径与「校验器不可用」),第 2 轮 blocked+paused", async () => {
    const j = new MemoryJournal();
    setGoal(j, "s-fb", "按 tasks/designs/mechanism-gap-matrix.md 推进,当前 46 missing/72 partial");
    const llm = scriptedLlm([{ kind: "throw" }]);

    const tm1 = makeTm();
    await maybeContinueGoal(tm1, j, llm as never, "s-fb");
    const cont = eventsOf(j, "goal.continue");
    expect(cont).toHaveLength(1);
    expect(cont[0]!["fallback"]).toBe(true);
    const task = tm1.list().filter((t) => t.sessionId === "s-fb")[0]!;
    expect(task.instruction).toContain("校验器不可用");
    expect(task.instruction).toContain("mechanism-gap-matrix.md");
    expect(task.instruction).toMatch(/回写矩阵/);
    expect(eventsOf(j, "goal.blocked")).toHaveLength(0);
    expect(lastGoalState(j)).toBe("active");

    // 第 2 轮:新 TaskSupervisor 避开 busy 守卫(同一 journal ⇒ 失败计数不丢)
    const tm2 = makeTm();
    await maybeContinueGoal(tm2, j, llm as never, "s-fb");
    expect(tm2.list()).toHaveLength(0);
    const blocked = eventsOf(j, "goal.blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!["code"]).toBe("GOAL_VERIFIER_UNAVAILABLE");
    expect(blocked[0]!["consecutive"]).toBe(2);
    expect(lastGoalState(j)).toBe("paused");
    const sys = j.readAll().filter((e) => e.kind === "message.system")
      .map((e) => String((e.payload as { text?: string }).text ?? ""));
    expect(sys.some((t) => t.includes("完成校验器连续不可用") && t.includes("/goal resume"))).toBe(true);
    // 两轮各两次尝试
    expect(eventsOf(j, "goal.verifier")).toHaveLength(4);
  });

  it("中间恢复有效结果 → 连续失败计数清零(第 3 轮再不可用只兜底不暂停)", async () => {
    const j = new MemoryJournal();
    setGoal(j, "s-reset");
    await maybeContinueGoal(makeTm(), j, scriptedLlm([{ kind: "throw" }]) as never, "s-reset");
    await maybeContinueGoal(makeTm(), j, scriptedLlm([{ kind: "fail", nextAction: "继续" }]) as never, "s-reset");
    await maybeContinueGoal(makeTm(), j, scriptedLlm([{ kind: "throw" }]) as never, "s-reset");

    expect(eventsOf(j, "goal.blocked")).toHaveLength(0);
    expect(eventsOf(j, "goal.continue").map((c) => c["fallback"])).toEqual([true, undefined, true]);
    expect(lastGoalState(j)).toBe("active");
  });

  it("consecutiveVerifierFailures:按 tickId 分组,只数尾部连续 unavailable", () => {
    const j = new MemoryJournal();
    const push = (tickId: string, results: string[]) => {
      for (const result of results) {
        j.append({ kind: "custom", sessionId: "s", payload: { type: "goal.verifier", sessionId: "s", tickId, result } });
      }
    };
    push("t1", ["unavailable", "unavailable"]);
    expect(consecutiveVerifierFailures(j.readAll(), "s")).toBe(1);
    push("t2", ["unavailable", "not_passed"]);
    expect(consecutiveVerifierFailures(j.readAll(), "s")).toBe(0);
    push("t3", ["unavailable", "unavailable"]);
    push("t4", ["unavailable", "unavailable"]);
    expect(consecutiveVerifierFailures(j.readAll(), "s")).toBe(2);
    expect(consecutiveVerifierFailures(j.readAll(), "other")).toBe(0);
  });
});

describe("正常路径不变", () => {
  it("passed → complete,不续跑,goal.verifier 一条 passed", async () => {
    const j = new MemoryJournal();
    const tm = makeTm();
    setGoal(j, "s-pass");
    await maybeContinueGoal(tm, j, scriptedLlm([{ kind: "pass", reason: "全部完成" }]) as never, "s-pass");
    expect(tm.list()).toHaveLength(0);
    expect(eventsOf(j, "goal.continue")).toHaveLength(0);
    expect(eventsOf(j, "goal.verifier").map((v) => v["result"])).toEqual(["passed"]);
    expect(lastGoalState(j)).toBe("complete");
  });
});

describe("续跑提示词", () => {
  it("含重启纪律行(重启放最后一步 / 不在任务中途重启)", () => {
    const p = formatGoalContinuationPrompt(GOAL_BASE);
    expect(p).toContain("若本轮需要重启网关:把重启放在最后一步");
    expect(p).toContain("不要在任务中途重启");
  });
});
