import { describe, it, expect } from "vitest";
import { TaskSupervisor } from "../src/task-manager.js";

describe("TaskSupervisor", () => {
  it("提交后进入 queued,drain 后 running", () => {
    const tm = new TaskSupervisor({ maxConcurrent: 4, maxConcurrentPerOwner: 2 });
    const t = tm.submit("user", "s1", "do something");
    expect(t.state).toBe("running"); // drain 在 submit 里被调用
  });

  it("幂等:同 idempotencyKey 返回同一任务", () => {
    const tm = new TaskSupervisor();
    const a = tm.submit("user", "s1", "x", { idempotencyKey: "k1" });
    const b = tm.submit("user", "s1", "x", { idempotencyKey: "k1" });
    expect(a.id).toBe(b.id);
  });

  it("并发上限:超过 maxConcurrent 的排队", () => {
    const tm = new TaskSupervisor({ maxConcurrent: 2, maxConcurrentPerOwner: 10 });
    tm.submit("user", "s1", "a");
    tm.submit("user", "s2", "b");
    const t3 = tm.submit("user", "s3", "c");
    expect(t3.state).toBe("queued"); // 已满,排队
  });

  it("同一 owner 受 perOwner 上限约束", () => {
    const tm = new TaskSupervisor({ maxConcurrent: 10, maxConcurrentPerOwner: 1 });
    tm.submit("user", "s1", "a");
    const t2 = tm.submit("user", "s1", "b");
    expect(t2.state).toBe("queued");
  });

  it("完成后释放位置,排队任务被调度", () => {
    const tm = new TaskSupervisor({ maxConcurrent: 1, maxConcurrentPerOwner: 10 });
    const t1 = tm.submit("user", "s1", "a");
    const t2 = tm.submit("user", "s2", "b");
    expect(t2.state).toBe("queued");
    tm.setState(t1, "done");
    expect(tm.get(t2.id)!.state).toBe("running");
  });
});

describe("submit 返回值一致性(R1 审计 C3/C4 根因)", () => {
  it("submit 返回的对象状态与内部存储一致", () => {
    const tm = new TaskSupervisor({ maxConcurrent: 4, maxConcurrentPerOwner: 2 });
    const t = tm.submit("user", "s1", "do something");
    expect(t.state).toBe("running");
    expect(tm.get(t.id)!.state).toBe("running");
    expect(tm.get(t.id)).toBe(t); // 同一对象,不是陈旧快照
  });
  it("setState 返回新对象且内部同步", () => {
    const tm = new TaskSupervisor();
    const t = tm.submit("user", "s1", "x");
    const done = tm.setState(t, "done", "ok");
    expect(done.state).toBe("done");
    expect(tm.get(t.id)!.state).toBe("done");
  });
});

describe("restore(宕机恢复)", () => {
  it("终态任务原样装载;running/blocked 收编为 interrupted(2026-11-05 语义诚实:外因中断≠取消);queued 原样重排队", () => {
    const tm = new TaskSupervisor();
    const now = Date.now();
    tm.restore([
      { id: "t1", sessionId: "s1", instruction: "done task", state: "done", createdAt: now, updatedAt: now, result: "ok" },
      { id: "t2", sessionId: "s1", instruction: "was running", state: "running", createdAt: now, updatedAt: now },
      { id: "t3", sessionId: "s2", instruction: "was queued", state: "queued", createdAt: now, updatedAt: now },
      { id: "t4", sessionId: "s2", instruction: "was blocked", state: "blocked", createdAt: now, updatedAt: now },
    ]);
    expect(tm.get("t1")!.state).toBe("done");
    expect(tm.get("t1")!.result).toBe("ok");
    expect(tm.get("t2")!.state).toBe("interrupted");
    expect(tm.get("t2")!.result).toContain("重启中断");
    expect(tm.get("t2")!.result).toContain("t2"); // 回执带原任务书 id
    expect(tm.get("t2")!.result).toContain("s1"); // 回执带 sessionId
    expect(tm.get("t3")!.state).toBe("queued"); // 未开始:不是中断,原样重排队
    expect(tm.get("t4")!.state).toBe("interrupted");
  });

  it("restore 幂等:interrupted 任务再次 restore 不改写(不翻 cancelled 不重复收编)", () => {
    const tm = new TaskSupervisor();
    const now = Date.now();
    const first = tm.restore([{ id: "t9", sessionId: "s1", instruction: "x", state: "running", createdAt: now, updatedAt: now }]);
    expect(first).toHaveLength(1);
    expect(tm.get("t9")!.state).toBe("interrupted");
    const second = tm.restore([{ ...tm.get("t9")! }]);
    expect(second).toHaveLength(0);
    expect(tm.get("t9")!.state).toBe("interrupted");
  });

  it("恢复重建幂等索引:同 idempotencyKey 再提交返回旧任务", () => {
    const tm = new TaskSupervisor();
    const now = Date.now();
    tm.restore([
      { id: "t1", sessionId: "s1", instruction: "x", state: "done", createdAt: now, updatedAt: now, idempotencyKey: "k-1" },
    ]);
    const again = tm.submit("user", "s1", "x", { idempotencyKey: "k-1" });
    expect(again.id).toBe("t1");
    expect(again.state).toBe("done"); // 不会重新排队执行
  });

  it("restore 不发变更事件、不触发调度(恢复的任务不应占并发位)", () => {
    const tm = new TaskSupervisor({ maxConcurrent: 1, maxConcurrentPerOwner: 1 });
    let emitted = 0;
    tm.onChange(() => emitted++);
    const now = Date.now();
    tm.restore([{ id: "old", sessionId: "s1", instruction: "old", state: "done", createdAt: now, updatedAt: now }]);
    expect(emitted).toBe(0);
    const t = tm.submit("user", "s1", "new work");
    expect(t.state).toBe("running"); // done 的恢复任务不占并发位
  });
});
