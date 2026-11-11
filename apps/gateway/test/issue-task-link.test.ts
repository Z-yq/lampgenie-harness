/**
 *  issue-task-link 纯逻辑单测(零 IO):状态映射 / 幂等判据 / 事件形状 / 确定性。
 * 跑法:cd apps/gateway && NODE_OPTIONS=--conditions=development npx vitest run test/issue-task-link.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  ISSUE_LINK_CODES,
  buildWriteBackEvent,
  hasWriteBack,
  terminalWriteBackPlan,
  writeBackKey,
  type JournalEventLike,
} from "../src/issue-task-link.js";

const AT = 1_700_000_000_000;

describe("ISSUE_LINK_CODES", () => {
  it("四码齐全且顺序固定", () => {
    expect([...ISSUE_LINK_CODES]).toEqual(["OK", "DUPLICATE", "NOT_FOUND", "INVALID"]);
  });
});

describe("writeBackKey", () => {
  it("格式 issue-writeback:<taskId>:<n>", () => {
    expect(writeBackKey("t-1", 7)).toBe("issue-writeback:t-1:7");
  });
  it("task 或 issue 不同即不同键", () => {
    expect(writeBackKey("t-1", 7)).not.toBe(writeBackKey("t-1", 8));
    expect(writeBackKey("t-1", 7)).not.toBe(writeBackKey("t-2", 7));
  });
});

describe("terminalWriteBackPlan:completed", () => {
  it("todo → OK + status done + 固定完成评论", () => {
    const p = terminalWriteBackPlan({ taskId: "t-1", taskState: "completed", issue: { number: 1, status: "todo" }, at: AT });
    expect(p.ok).toBe(true);
    expect(p.code).toBe("OK");
    expect(p.patch).toEqual({ status: "done" });
    expect(p.comment).toContain("t-1");
    expect(p.comment).toContain("completed");
  });
  it("doing → OK + status done", () => {
    const p = terminalWriteBackPlan({ taskId: "t-8", taskState: "completed", issue: { number: 2, status: "doing" }, at: AT });
    expect(p.code).toBe("OK");
    expect(p.patch?.status).toBe("done");
  });
  it("已是 done → DUPLICATE 且无 patch", () => {
    const p = terminalWriteBackPlan({ taskId: "t-1", taskState: "completed", issue: { number: 1, status: "done" }, at: AT });
    expect(p.ok).toBe(true);
    expect(p.code).toBe("DUPLICATE");
    expect(p.patch).toBeUndefined();
  });
});

describe("terminalWriteBackPlan:failed/cancelled", () => {
  it("failed → OK 不改 status + 评论含 failed", () => {
    const p = terminalWriteBackPlan({ taskId: "t-2", taskState: "failed", issue: { number: 3, status: "doing" }, at: AT });
    expect(p.code).toBe("OK");
    expect(p.patch).toBeUndefined();
    expect(p.comment).toContain("t-2");
    expect(p.comment).toContain("failed");
  });
  it("cancelled → OK 不改 status + 评论含 cancelled", () => {
    const p = terminalWriteBackPlan({ taskId: "t-3", taskState: "cancelled", issue: { number: 4, status: "todo" }, at: AT });
    expect(p.code).toBe("OK");
    expect(p.patch).toBeUndefined();
    expect(p.comment).toContain("cancelled");
  });
  it("已有同文评论 → DUPLICATE", () => {
    const first = terminalWriteBackPlan({ taskId: "t-4", taskState: "failed", issue: { number: 5, status: "doing" }, at: AT });
    const second = terminalWriteBackPlan({
      taskId: "t-4",
      taskState: "failed",
      issue: { number: 5, status: "doing", comments: [{ author: "genie", body: first.comment }] },
      at: AT,
    });
    expect(second.code).toBe("DUPLICATE");
  });
  it("不同评论文本不算重复", () => {
    const p = terminalWriteBackPlan({
      taskId: "t-5",
      taskState: "cancelled",
      issue: { number: 6, status: "todo", comments: [{ body: "无关评论" }] },
      at: AT,
    });
    expect(p.code).toBe("OK");
  });
});

describe("terminalWriteBackPlan:异常/边界", () => {
  it("未知 taskState → INVALID", () => {
    const p = terminalWriteBackPlan({ taskId: "t-6", taskState: "running", issue: { number: 7, status: "doing" }, at: AT });
    expect(p.ok).toBe(false);
    expect(p.code).toBe("INVALID");
  });
  it("空 taskState → INVALID", () => {
    const p = terminalWriteBackPlan({ taskId: "t-6", taskState: "", issue: { number: 7 }, at: AT });
    expect(p.code).toBe("INVALID");
  });
  it("issue 缺失 → NOT_FOUND", () => {
    const p = terminalWriteBackPlan({ taskId: "t-7", taskState: "completed", issue: null, at: AT });
    expect(p.ok).toBe(false);
    expect(p.code).toBe("NOT_FOUND");
  });
  it("issue 缺失优先于状态判定(null issue + 未知态 → NOT_FOUND)", () => {
    const p = terminalWriteBackPlan({ taskId: "t-7", taskState: "bogus", issue: undefined, at: AT });
    expect(p.code).toBe("NOT_FOUND");
  });
});

describe("terminalWriteBackPlan:确定性/不可变/文本约束", () => {
  it("同输入两次深相等", () => {
    const input = { taskId: "t-9", taskState: "completed", issue: { number: 9, status: "todo" }, at: AT };
    expect(terminalWriteBackPlan(input)).toEqual(terminalWriteBackPlan(input));
  });
  it("不修改传入 issue", () => {
    const issue = { number: 10, status: "todo" as const, comments: [] as { body?: string }[] };
    terminalWriteBackPlan({ taskId: "t-10", taskState: "failed", issue, at: AT });
    expect(issue.status).toBe("todo");
    expect(issue.comments).toEqual([]);
  });
  it("评论文本 ≤200 字(超长 taskId 截断兜底)", () => {
    const longId = "t-" + "x".repeat(180);
    for (const state of ["completed", "failed", "cancelled"]) {
      const p = terminalWriteBackPlan({ taskId: longId, taskState: state, issue: { number: 11, status: "todo" }, at: AT });
      expect((p.comment ?? "").length).toBeLessThanOrEqual(200);
      expect(p.comment).toContain(state);
      expect(p.comment?.startsWith("任务 ")).toBe(true);
    }
    const normal = terminalWriteBackPlan({ taskId: "t-1", taskState: "completed", issue: { number: 11, status: "todo" }, at: AT });
    expect(normal.comment).toContain("t-1");
  });
});

describe("hasWriteBack", () => {
  const custom = (payload: unknown): JournalEventLike => ({ kind: "custom", payload });
  const key = "issue-writeback:t-1:1";

  it("命中同 type+key → true", () => {
    expect(hasWriteBack([custom({ type: "issue.task.writeback", key })], key)).toBe(true);
  });
  it("key 不同 → false", () => {
    expect(hasWriteBack([custom({ type: "issue.task.writeback", key: "other" })], key)).toBe(false);
  });
  it("type 不同 → false", () => {
    expect(hasWriteBack([custom({ type: "other", key })], key)).toBe(false);
  });
  it("kind 非 custom → false", () => {
    expect(hasWriteBack([{ kind: "message.user", payload: { type: "issue.task.writeback", key } }], key)).toBe(false);
  });
  it("畸形 payload(null/string/undefined) 不抛且 false", () => {
    expect(hasWriteBack([custom(null), custom("x"), { kind: "custom" }], key)).toBe(false);
  });
});

describe("buildWriteBackEvent", () => {
  it("稳定结构字段齐全且顺序固定", () => {
    const e = buildWriteBackEvent({ key: "k", taskId: "t", issueNumber: 3, projectId: "p", state: "completed", at: AT });
    expect(e).toEqual({ type: "issue.task.writeback", key: "k", taskId: "t", issueNumber: 3, projectId: "p", state: "completed", at: AT });
    expect(Object.keys(e)).toEqual(["type", "key", "taskId", "issueNumber", "projectId", "state", "at"]);
  });
  it("同输入深相等", () => {
    const a = buildWriteBackEvent({ key: "k", taskId: "t", issueNumber: 3, projectId: "p", state: "failed", at: AT });
    const b = buildWriteBackEvent({ key: "k", taskId: "t", issueNumber: 3, projectId: "p", state: "failed", at: AT });
    expect(a).toEqual(b);
  });
  it("key 可与 writeBackKey 组合并被 hasWriteBack 识别", () => {
    const key = writeBackKey("t-11", 12);
    const e = buildWriteBackEvent({ key, taskId: "t-11", issueNumber: 12, projectId: "p", state: "completed", at: AT });
    expect(hasWriteBack([{ kind: "custom", payload: e }], key)).toBe(true);
  });
});
