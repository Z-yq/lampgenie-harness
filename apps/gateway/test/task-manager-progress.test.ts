/**
 * TaskSupervisor.touch(2026-11 token 轮)· 任务进展旁注契约测试。
 *
 * 为什么要单独一文件:进展是**正交元数据**(不改状态机、不改时间戳、不复活已删任务),
 * 与 task-manager.test.ts 里的调度/恢复语义互不影响,分开放便于「改 touch 只跑这一份」。
 *
 * 零反斜杠纪律:断言全用字面串/数值。
 */
import { describe, it, expect } from "vitest";
import { TaskSupervisor } from "../src/task-manager.js";
import { Task as TaskZ } from "@lampgenie/protocol";

describe("TaskSupervisor.touch(prog)", () => {
  it("两次 touch 累积 phase+step+note(浅合并,后写覆盖同键)", () => {
    const tm = new TaskSupervisor({ maxConcurrent: 4, maxConcurrentPerOwner: 2 });
    const t = tm.submit("user", "s1", "do work");
    tm.touch(t.id, { phase: "implement", step: 1 });
    const merged = tm.touch(t.id, { step: 2, note: "改完 A 文件" });
    expect(merged!.progress).toMatchObject({ phase: "implement", step: 2, note: "改完 A 文件" });
    expect(tm.get(t.id)!.progress!.phase).toBe("implement"); // 第一次的 phase 未被后一次清掉
    expect(typeof tm.get(t.id)!.progress!.at).toBe("number"); // 缺省 at=Date.now()
  });

  it("不改 state / updatedAt / startedAt(进展只是旁注)", () => {
    const tm = new TaskSupervisor({ maxConcurrent: 4, maxConcurrentPerOwner: 2 });
    const t = tm.submit("user", "s1", "do work");
    const before = tm.get(t.id)!;
    const after = tm.touch(t.id, { phase: "verify", step: 3, note: "跑测试" });
    expect(after!.state).toBe(before.state);
    expect(after!.updatedAt).toBe(before.updatedAt);
    expect(after!.startedAt).toBe(before.startedAt);
    expect(after!.id).toBe(before.id);
    expect(after).not.toBe(before); // 新对象(不可变风格)
  });

  it("patch.at 显式给出时不覆盖成 now", () => {
    const tm = new TaskSupervisor({ maxConcurrent: 4, maxConcurrentPerOwner: 2 });
    const t = tm.submit("user", "s1", "x");
    expect(tm.touch(t.id, { at: 1234 })!.progress!.at).toBe(1234);
  });

  it("不存在的 id → undefined,且不新增任务", () => {
    const tm = new TaskSupervisor();
    const sizeBefore = tm.list().length;
    expect(tm.touch("no-such-id", { phase: "implement" })).toBeUndefined();
    expect(tm.list().length).toBe(sizeBefore);
    expect(tm.get("no-such-id")).toBeUndefined();
  });

  it("墓碑任务 → undefined(已删任务不被在跑执行链的 touch 复活)", () => {
    const tm = new TaskSupervisor({ maxConcurrent: 4, maxConcurrentPerOwner: 2 });
    const t = tm.submit("user", "s1", "x");
    tm.delete(t.id);
    expect(tm.deletedIds()).toContain(t.id); // 墓碑已立
    expect(tm.touch(t.id, { phase: "implement", step: 1 })).toBeUndefined();
    expect(tm.get(t.id)).toBeUndefined(); // 不回填 Map
  });

  it("每次成功的 touch 发一次 emit,失败不发(面板靠它拿最新态)", () => {
    const tm = new TaskSupervisor({ maxConcurrent: 4, maxConcurrentPerOwner: 2 });
    const t = tm.submit("user", "s1", "x");
    let emitted = 0;
    let last: { id: string; progress?: unknown } | undefined;
    tm.onChange((task) => { emitted++; last = task; });
    tm.touch(t.id, { phase: "implement", step: 1 });
    expect(emitted).toBe(1);
    expect(last!.id).toBe(t.id);
    expect(last!.progress).toMatchObject({ phase: "implement", step: 1 });
    tm.touch(t.id, { step: 2 });
    expect(emitted).toBe(2);
    tm.touch("no-such-id", { step: 9 }); // 失败路径不 emit
    expect(emitted).toBe(2);
  });

  it("protocol Task 解析:带 progress 通过、不带也通过、只带部分键也通过", () => {
    const base = {
      id: "t1", sessionId: "s1", instruction: "x", state: "running", createdAt: 1, updatedAt: 2,
    };
    expect(TaskZ.safeParse(base).success).toBe(true);
    expect(TaskZ.safeParse({ ...base, progress: { phase: "implement", step: 2, note: "n", at: 3 } }).success).toBe(true);
    expect(TaskZ.safeParse({ ...base, progress: {} }).success).toBe(true);
    expect(TaskZ.safeParse({ ...base, progress: { step: 2 } }).success).toBe(true);
    // 类型口径一致:touch 的返回值能被协议 Task 解析(gateway Task = core Task,结构对齐)
    const tm = new TaskSupervisor({ maxConcurrent: 4, maxConcurrentPerOwner: 2 });
    const t = tm.submit("user", "s1", "x");
    const touched = tm.touch(t.id, { phase: "implement", step: 1 })!;
    expect(TaskZ.safeParse(touched).success).toBe(true);
  });
});
