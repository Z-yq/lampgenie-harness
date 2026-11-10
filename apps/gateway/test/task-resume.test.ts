/**
 * 重启恢复 e2e(2026-11-05 状态机优化):
 * 模拟网关死亡(进程内:journal 快照留在盘上)→ 重启清算 running→interrupted →
 * resumeInterrupted 一键续跑(同 session 重提)→ 幂等(同 key 二次 resume 不双跑)。
 * 不起真网关(生产网关禁止重启);app 层路径(createGatewayApp)由 test/ui/task-resume.spec.cjs 覆盖。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TaskSupervisor } from "../src/task-manager.js";
import type { Task } from "@lampgenie/core";

const mkTask = (over: Partial<Task> & { id: string }): Task => ({
  sessionId: "sess-e2e",
  instruction: "原任务书:做一件被网关重启打断的事",
  state: "running",
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 1_000,
  ...over,
} as Task);

describe("重启恢复 e2e:死亡→清算 interrupted→一键续跑→幂等", () => {
  let tm: TaskSupervisor;
  beforeEach(() => { tm = new TaskSupervisor({ maxConcurrent: 4, maxConcurrentPerOwner: 2 }); });

  it("全链路:running 快照 restore→interrupted(带回执)→resume 重提→原任务 cancelled", () => {
    // ① 模拟死亡前的 journal 快照(进程崩了,内存态没了,只剩快照)
    const dead = mkTask({ id: "dead-1" });
    // ② 重启清算
    const collected = tm.restore([dead], {
      receipt: (t) => `网关重启中断(原任务书 ${t.id} / 会话 ${t.sessionId} / 中断前约 7 轮;可续跑)`,
    });
    expect(collected).toHaveLength(1);
    const it2 = tm.get("dead-1")!;
    expect(it2.state).toBe("interrupted");
    expect(it2.result).toContain("dead-1");
    expect(it2.result).toContain("sess-e2e");
    expect(it2.result).toContain("中断前约 7 轮");
    // ③ 一键续跑(面板按钮→task.resume→resumeInterrupted)
    const nt = tm.resumeInterrupted("dead-1", (t) => `【续跑】${t.instruction}`);
    expect(nt).toBeDefined();
    expect(nt!.sessionId).toBe("sess-e2e"); // 同 session 续跑
    expect(nt!.state === "queued" || nt!.state === "running").toBe(true); // 复用队列机制
    expect(nt!.instruction).toContain("【续跑】");
    expect(nt!.instruction).toContain("原任务书");
    // 原任务收口:被续跑替代
    expect(tm.get("dead-1")!.state).toBe("cancelled");
    expect(tm.get("dead-1")!.result).toContain(nt!.id);
  });

  it("幂等:同任务二次续跑返回同一新任务(resume:<原id> 命中幂等索引),不双跑", () => {
    tm.restore([mkTask({ id: "dead-2" })]);
    const a = tm.resumeInterrupted("dead-2", (t) => `【续跑】${t.instruction}`);
    expect(a).toBeDefined();
    // 二次点击(双击/重连/自动+手动竞争):同 key 返回已有任务
    const b = tm.resumeInterrupted("dead-2", (t) => `【续跑】${t.instruction}`);
    expect(b).toBeDefined();
    expect(b!.id).toBe(a!.id);
    // 运行副本唯一:同 sessionId 的非终态任务只有那一个新任务(dead-2 已 cancelled)
    const live = tm.list({ sessionId: "sess-e2e" }).filter((t) => !["done", "failed", "cancelled"].includes(t.state));
    expect(live.map((t) => t.id)).toEqual([a!.id]);
  });

  it("自动恢复窗:窗内 interrupted 自动重提;窗外不碰;缺省(不开窗)零自动 submit", () => {
    const now = Date.now();
    // 窗内:中断发生在 1 分钟前,窗 5 分钟
    tm.restore([
      mkTask({ id: "fresh-1", updatedAt: now - 60_000 }),
      mkTask({ id: "stale-1", updatedAt: now - 3_600_000 }), // 1 小时前=窗外
    ]);
    const resumed = tm.autoResumeInterrupted({
      windowMs: 5 * 60_000,
      now,
      buildInstruction: (t) => `【续跑】${t.instruction}`,
    });
    expect(resumed.map((t) => t.sessionId)).toEqual(["sess-e2e"]);
    expect(tm.get("fresh-1")!.state).toBe("cancelled"); // 已被续跑替代
    expect(tm.get("stale-1")!.state).toBe("interrupted"); // 窗外:保留等一键
  });

  it("非 interrupted/legacy 状态拒绝续跑(done 任务不复活)", () => {
    tm.restore([mkTask({ id: "done-1", state: "done", result: "ok" })]);
    expect(tm.resumeInterrupted("done-1", (t) => t.instruction)).toBeUndefined();
    // legacy:旧版清算成 cancelled 且 result 含「重启中断」的存量任务可续跑
    tm.restore([mkTask({ id: "legacy-1", state: "cancelled", result: "网关重启中断(可重发)" })]);
    const nt = tm.resumeInterrupted("legacy-1", (t) => `【续跑】${t.instruction}`);
    expect(nt).toBeDefined();
  });
});
