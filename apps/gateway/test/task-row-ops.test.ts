/**
 * F3 任务行操作:rename/pin/archive 元数据语义(正交状态机)+持久化(journal 回放)。
 */
import { describe, it, expect } from "vitest";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";

describe("F3 任务行操作(ZCode TaskListItemContextMenu 移植)", () => {
  it("重命名:标题生效/空串恢复/发变更事件;状态不变", () => {
    const tm = new TaskSupervisor();
    const events: string[] = [];
    tm.onChange((t) => events.push(t.id));
    const t = tm.submit("user", "s", "原始指令很长很长很长");
    const before = tm.get(t.id)!.state;
    events.length = 0;
    const r = tm.rename(t.id, "我的新标题");
    expect(r?.title).toBe("我的新标题");
    expect(tm.get(t.id)!.state).toBe(before);
    expect(events).toEqual([t.id]);
    // 空串=清除标题(面板回退显示 instruction)
    tm.rename(t.id, "   ");
    expect(tm.get(t.id)!.title).toBeUndefined();
    // 不存在的任务
    expect(tm.rename("nope", "x")).toBeUndefined();
  });

  it("置顶/归档:元数据正交;置顶不改 updatedAt(排序稳定);归档不改终态", () => {
    const tm = new TaskSupervisor();
    const t = tm.submit("user", "s", "活");
    const updated0 = tm.get(t.id)!.updatedAt;
    tm.setPinned(t.id, true);
    expect(tm.get(t.id)!.pinned).toBe(true);
    expect(tm.get(t.id)!.updatedAt).toBe(updated0);
    tm.setPinned(t.id, false);
    expect(tm.get(t.id)!.pinned).toBeUndefined();
    const t2 = tm.submit("user", "s2", "干完的");
    tm.setState(t2, "done", "ok");
    tm.setArchived(t2.id, true);
    expect(tm.get(t2.id)!.archived).toBe(true);
    expect(tm.get(t2.id)!.state).toBe("done"); // 归档不改状态
    expect(tm.setArchived("nope", true)).toBeUndefined();
  });

  it("持久化:元数据随 task.* journal 事件回放恢复(app.ts 恢复扫描同款语义)", () => {
    const journal = new MemoryJournal();
    const tm = new TaskSupervisor();
    tm.onChange((task) => journal.append({ kind: `task.${task.state === "queued" ? "enqueue" : task.state === "running" ? "start" : task.state === "done" ? "done" : "progress"}`, sessionId: task.sessionId, payload: task }));
    const t = tm.submit("user", "s", "要回放的");
    tm.rename(t.id, "回放标题");
    tm.setPinned(t.id, true);
    tm.setArchived(t.id, true);
    // 恢复扫描(app.ts 同款:按 id 取最后态)
    const restored = new Map<string, typeof t>();
    for (const ev of journal.readAll()) {
      const p = ev.payload as { id?: string };
      if (p && typeof p.id === "string") restored.set(p.id, p as typeof t);
    }
    const rt = restored.get(t.id)!;
    expect(rt.title).toBe("回放标题");
    expect(rt.pinned).toBe(true);
    expect(rt.archived).toBe(true);
    const tm2 = new TaskSupervisor();
    tm2.restore([...restored.values()]);
    expect(tm2.get(t.id)?.title).toBe("回放标题");
  });
});
