/**
 * TaskState 全迁移边单测(2026-11-05 状态机优化):
 * 七态 TRANSITIONS 矩阵逐边校验——表驱动,与实现同源自 TRANSITIONS 语义;
 * interrupted 为本批新增态,全部出边/入边显式断言。
 */
import { describe, it, expect } from "vitest";
import { canTransition, TERMINAL_STATES, transition, type Task, type TaskState } from "../src/task/task.js";

const ALL: TaskState[] = ["queued", "running", "blocked", "interrupted", "done", "failed", "cancelled"];

/** 期望的合法迁移全集(from → Set<to>),与 task.ts TRANSITIONS 逐字对应(故意独立复述,校验漂移)。 */
const EXPECTED: Record<TaskState, TaskState[]> = {
  queued: ["running", "done", "failed", "cancelled"],
  running: ["blocked", "interrupted", "done", "failed", "cancelled"],
  blocked: ["running", "interrupted", "cancelled"],
  interrupted: ["running", "cancelled", "failed"],
  done: [],
  failed: [],
  cancelled: [],
};

const mk = (state: TaskState): Task => ({ id: "t-edge", sessionId: "s1", instruction: "x", state, createdAt: 1, updatedAt: 1 });

describe("TaskState 迁移矩阵(七态全边)", () => {
  for (const from of ALL) {
    for (const to of ALL) {
      const legal = EXPECTED[from]!.includes(to);
      it(`${from} → ${to} = ${legal ? "合法" : "非法"}`, () => {
        expect(canTransition(from, to)).toBe(legal);
        if (legal) {
          expect(transition(mk(from), to).state).toBe(to);
        } else {
          expect(() => transition(mk(from), to)).toThrow(/非法任务状态迁移/);
        }
      });
    }
  }

  it("TERMINAL_STATES 不含 interrupted(可恢复,非终态)", () => {
    expect(TERMINAL_STATES.has("interrupted")).toBe(false);
    expect(TERMINAL_STATES.has("done")).toBe(true);
    expect(TERMINAL_STATES.has("failed")).toBe(true);
    expect(TERMINAL_STATES.has("cancelled")).toBe(true);
  });

  it("interrupted→running 刷新 startedAt(续跑重计时)", () => {
    const t = transition(mk("interrupted"), "running");
    expect(t.startedAt).toBeGreaterThan(0);
  });

  it("非法迁移报错含 from→to 与任务 id", () => {
    try {
      transition(mk("done"), "interrupted");
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toContain("done -> interrupted");
      expect(String(err)).toContain("t-edge");
    }
  });
});
