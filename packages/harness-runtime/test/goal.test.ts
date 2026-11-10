/**
 * 会话目标运行时(ZCode target 子系统移植)单测:
 * 状态机(upsert/clear/状态保留)/提示词逐字锚/fail-open 解析/校验。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import {
  readGoal, isValidGoalObjective, goalStateChangeNotice,
  formatGoalContinuationPrompt, formatGoalCompletionVerificationPrompt,
  parseGoalCompletionVerificationText,
} from "../src/agent/goal";

function goal(j: MemoryJournal, sessionId: string, payload: Record<string, unknown>): void {
  j.append({ kind: "goal.set", sessionId, payload });
}

describe("readGoal 状态机(ZCode session_target upsert 语义)", () => {
  it("set→读回;clear→null;pause 保留目标;新 set 继承预算记账", () => {
    const j = new MemoryJournal();
    expect(readGoal(j, "s")).toBeNull();
    goal(j, "s", { goal: "把登录页修好", state: "active" });
    const g = readGoal(j, "s")!;
    expect(g.objective).toBe("把登录页修好");
    expect(g.status).toBe("active");
    goal(j, "s", { goal: "把登录页修好", state: "paused" });
    expect(readGoal(j, "s")!.status).toBe("paused");
    goal(j, "s", { goal: null, state: "active" });
    expect(readGoal(j, "s")).toBeNull();
    // 跨会话隔离
    goal(j, "other", { goal: "别的会话", state: "active" });
    expect(readGoal(j, "s")).toBeNull();
  });

  it("状态机全档:complete/budget_limited 原样回读(ZCode 终态语义)", () => {
    const j = new MemoryJournal();
    goal(j, "s", { goal: "x", state: "active" });
    goal(j, "s", { goal: "x", state: "complete" });
    expect(readGoal(j, "s")!.status).toBe("complete");
    goal(j, "s", { goal: "x", state: "budget_limited" });
    expect(readGoal(j, "s")!.status).toBe("budget_limited");
  });

  it("objective 校验:≤4000 字非空(ZCode MAX_GOAL_OBJECTIVE_CHARS)", () => {
    expect(isValidGoalObjective("")).toBe(false);
    expect(isValidGoalObjective("  ")).toBe(false);
    expect(isValidGoalObjective("x".repeat(4000))).toBe(true);
    expect(isValidGoalObjective("x".repeat(4001))).toBe(false);
  });
});

describe("状态变更通知(goal_state_change 语义;2026-10-23 汉化)", () => {
  it("三态文本逐字锚定(中文)", () => {
    expect(goalStateChangeNotice("paused")).toBe("当前会话目标已暂停。除非用户恢复或更换目标,不要继续推进它。");
    expect(goalStateChangeNotice("resumed")).toBe("会话目标已恢复,将继续推进。");
    expect(goalStateChangeNotice("cleared")).toBe("会话目标已清除。除非用户设定新目标,不要继续推进任何先前目标。");
  });
});

describe("续跑提示词(ZCode formatGoalContinuationPrompt 逐字)", () => {
  it("含 untrusted_objective 包裹/预算块/完成审计清单/不自证完成纪律", () => {
    const g = { sessionId: "s", objective: "修<登录页>", status: "active" as const, tokenBudget: 1000, tokensUsed: 300, timeUsedSeconds: 60, startedAt: 0, updatedAt: 0, revision: 1, round: 0 };
    const p = formatGoalContinuationPrompt(g, { passed: false, reason: "todo 未清", nextAction: "补 X 测试" });
    expect(p).toContain("继续推进当前会话目标。补 X 测试");
    expect(p).toContain("完成校验器结果:");
    expect(p).toContain("<untrusted_objective>");
    expect(p).toContain("修&lt;登录页&gt;"); // HTML 转义(ZCode escapeGoalPromptText)
    expect(p).toContain("- 已用 tokens: 300");
    expect(p).toContain("- 剩余 tokens: 700");
    expect(p).toContain("不要自行标记目标完成。");
    expect(p).toContain("拿不准=未达成");
    // 无 verification:无校验块
    const p2 = formatGoalContinuationPrompt(g);
    expect(p2).not.toContain("完成校验器结果:");
  });
});

describe("完成校验(ZCode fail-open 语义)", () => {
  it("校验提示词含 JSON 形状/非任务豁免/untrusted 包裹", () => {
    const g = { sessionId: "s", objective: "hi", status: "active" as const, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, startedAt: 0, updatedAt: 0, revision: 1, round: 0 };
    const p = formatGoalCompletionVerificationPrompt(g);
    expect(p).toContain('{"passed": boolean, "reason": string, "nextAction": string}');
    expect(p).toContain("会话型非任务");
    expect(p).toContain("<untrusted_objective>");
    expect(p).toContain("</untrusted_objective>");
    expect(p).toContain("- token 预算: 无");
  });

  it("解析:纯 JSON/文本包裹 JSON 均收;坏 JSON=null(fail-open 由调用方处理)", () => {
    expect(parseGoalCompletionVerificationText('{"passed":true,"reason":"r","nextAction":""}')!.passed).toBe(true);
    const wrapped = '校验结论如下:\n```json\n{"passed": false, "reason": "还差测试", "nextAction": "补测试"}\n```';
    const v = parseGoalCompletionVerificationText(wrapped)!;
    expect(v.passed).toBe(false);
    expect(v.nextAction).toBe("补测试");
    expect(parseGoalCompletionVerificationText("模型胡言乱语没有 JSON")).toBeNull();
    expect(parseGoalCompletionVerificationText('{"passed":"yes"}')).toBeNull(); // passed 非布尔
  });
});
