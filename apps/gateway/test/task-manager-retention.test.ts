/**
 * TaskSupervisor 保留期(二期能力):终态超期清除,pinned/非终态豁免,days<=0 关。
 */
import { describe, it, expect } from "vitest";
import { TaskSupervisor } from "../src/task-manager.js";

function mkTask(id: string, state: "done" | "failed" | "running", ageDays: number, pinned = false): any {
  return {
    id, sessionId: "s", instruction: "x", state,
    createdAt: Date.now() - ageDays * 86_400_000,
    updatedAt: Date.now() - ageDays * 86_400_000,
    ...(pinned ? { pinned: true } : {}),
  };
}

describe("applyRetention", () => {
  it("超期终态清除;pinned 与非终态豁免;days=0 关", () => {
    const tm = new TaskSupervisor({});
    tm.restore([
      mkTask("old-done", "done", 10),
      mkTask("old-fail", "failed", 8),
      mkTask("old-pin", "done", 10, true),
      mkTask("old-run", "running", 10),
      mkTask("new-done", "done", 1),
    ]);
 // 语义变更(interrupted 态):restore 把 running 收编成 interrupted(非终态,
    // 可续跑)而非 cancelled——保留期只清终态,old-run 以 interrupted 保留等续跑/人工清理,
    // 清除数=2(old-done/old-fail)。修复前口径(收编=cancelled 终态,清除数=3)随状态机演进作废。
    expect(tm.applyRetention(7)).toBe(2);
    expect(tm.get("old-done")).toBeUndefined();
    expect(tm.get("old-fail")).toBeUndefined();
    expect(tm.get("old-run")).toBeTruthy(); // interrupted:非终态豁免,等一键续跑
    expect(tm.get("old-run")!.state).toBe("interrupted");
    expect(tm.get("old-pin")).toBeTruthy();
    expect(tm.get("new-done")).toBeTruthy();
    expect(tm.applyRetention(0)).toBe(0);
  });
});
