/**
 * 子代理生命周期注册表单测:纯逻辑,零 IO。
 * 覆盖:五态常量 / 注册幂等 / update 终态不可回退 / list 排序·过滤·递归后代·防环 /
 * descendants / interrupt(只动目标) / stats / restore(终态保留) / 快照不可变。
 */
import { describe, expect, it } from "vitest";
import { SUBAGENT_STATES, SubagentRegistry, isTerminalSubagentState } from "../src/agent/subagent-registry.ts";
import type { SubagentRecord } from "../src/agent/subagent-registry.ts";

function rec(agentId: string, over: Partial<SubagentRecord> = {}): SubagentRecord {
  return { agentId, taskId: "t-" + agentId, sessionId: "s1", state: "running", spawnedAt: 1000, ...over };
}

describe("常量与谓词", () => {
  it("SUBAGENT_STATES 恰为五态且顺序稳定", () => {
    expect([...SUBAGENT_STATES]).toEqual(["running", "done", "failed", "cancelled", "interrupted"]);
  });
  it("isTerminalSubagentState:四终态 true,running/未知 false", () => {
    for (const s of ["done", "failed", "cancelled", "interrupted"]) expect(isTerminalSubagentState(s)).toBe(true);
    expect(isTerminalSubagentState("running")).toBe(false);
    expect(isTerminalSubagentState("bogus")).toBe(false);
    expect(isTerminalSubagentState(undefined)).toBe(false);
  });
});

describe("register", () => {
  it("首次注册 ok 并返回字段快照", () => {
    const reg = new SubagentRegistry();
    const r = reg.register(rec("a1", { parentId: "task-1", title: "探测", model: "m1", spawnedAt: 5, deadlineAt: 99 }));
    expect(r.ok).toBe(true);
    expect(r.code).toBeUndefined();
    expect(r.record).toMatchObject({ agentId: "a1", parentId: "task-1", taskId: "t-a1", sessionId: "s1", title: "探测", model: "m1", state: "running", spawnedAt: 5, deadlineAt: 99 });
  });
  it("幂等:同 agentId 返回 DUPLICATE 且不覆盖已有记录", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a1", { title: "原始", spawnedAt: 1 }));
    const r = reg.register(rec("a1", { title: "迟到", spawnedAt: 2 }));
    expect(r.ok).toBe(true);
    expect(r.code).toBe("DUPLICATE");
    expect(r.record?.title).toBe("原始");
    expect(reg.stats().total).toBe(1);
  });
  it("非法 state → INVALID,不抛", () => {
    const reg = new SubagentRegistry();
    const bad = { ...rec("a1"), state: "zombie" } as unknown as SubagentRecord;
    expect(reg.register(bad)).toEqual({ ok: false, code: "INVALID" });
    expect(reg.stats().total).toBe(0);
  });
  it("空 agentId → INVALID,不抛", () => {
    const reg = new SubagentRegistry();
    expect(reg.register({ ...rec("x"), agentId: "   " }).code).toBe("INVALID");
  });
  it("parentId 可空(顶层子代理)", () => {
    const reg = new SubagentRegistry();
    const r = reg.register(rec("a1"));
    expect(r.ok).toBe(true);
    expect(r.record?.parentId).toBeUndefined();
  });
});

describe("update", () => {
  it("不存在 → NOT_FOUND", () => {
    expect(new SubagentRegistry().update("nope", { state: "done" })).toEqual({ ok: false, code: "NOT_FOUND" });
  });
  it("running→done 成功并刷新 lastEventAt", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a1", { spawnedAt: 1 }));
    const before = reg.get("a1")?.lastEventAt;
    const r = reg.update("a1", { state: "done", resultSummary: "完成" });
    expect(r.ok).toBe(true);
    expect(r.record?.state).toBe("done");
    expect(r.record?.lastEventAt).toBeTypeOf("number");
    expect(before).toBeUndefined();
  });
  it("终态回退到 running → INVALID 且状态不变", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a1"));
    reg.update("a1", { state: "failed" });
    const r = reg.update("a1", { state: "running" });
    expect(r.code).toBe("INVALID");
    expect(reg.get("a1")?.state).toBe("failed");
  });
  it("终态之间可迁移(interrupted→done,迟到终态覆盖)", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a1"));
    reg.interrupt("a1");
    const r = reg.update("a1", { state: "done" });
    expect(r.ok).toBe(true);
    expect(reg.get("a1")?.state).toBe("done");
  });
  it("resultSummary 截断到 200 字", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a1"));
    reg.update("a1", { state: "done", resultSummary: "x".repeat(500) });
    expect(reg.get("a1")?.resultSummary?.length).toBe(200);
  });
  it("非法 state → INVALID", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a1"));
    const r = reg.update("a1", { state: "zombie" as unknown as SubagentRecord["state"] });
    expect(r.code).toBe("INVALID");
    expect(reg.get("a1")?.state).toBe("running");
  });
});

describe("list", () => {
  it("按 spawnedAt 升序", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("c", { spawnedAt: 300 }));
    reg.register(rec("a", { spawnedAt: 100 }));
    reg.register(rec("b", { spawnedAt: 200 }));
    expect(reg.list().map((r) => r.agentId)).toEqual(["a", "b", "c"]);
  });
  it("同 spawnedAt 按 agentId 字典序(确定性)", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("b2", { spawnedAt: 7 }));
    reg.register(rec("a1", { spawnedAt: 7 }));
    expect(reg.list().map((r) => r.agentId)).toEqual(["a1", "b2"]);
  });
  it("parentId 过滤含全部后代(孙代)", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("child", { parentId: "root", spawnedAt: 10 }));
    reg.register(rec("grand", { parentId: "child", spawnedAt: 20 }));
    reg.register(rec("other", { parentId: "elsewhere", spawnedAt: 30 }));
    expect(reg.list({ parentId: "root" }).map((r) => r.agentId)).toEqual(["child", "grand"]);
  });
  it("parentId 过滤不含根自身与非后代", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("root"));
    reg.register(rec("child", { parentId: "root" }));
    reg.register(rec("stranger"));
    expect(reg.list({ parentId: "root" }).map((r) => r.agentId)).toEqual(["child"]);
  });
  it("父子链成环时不无限展开(防环)", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a", { parentId: "b", spawnedAt: 1 }));
    reg.register(rec("b", { parentId: "a", spawnedAt: 2 }));
    const ids = reg.descendants("a");
    expect(ids).toEqual(["b"]);
  });
  it("includeDone=false 只留运行中", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a1", { spawnedAt: 1 }));
    reg.register(rec("a2", { spawnedAt: 2 }));
    reg.update("a1", { state: "done" });
    expect(reg.list({ includeDone: false }).map((r) => r.agentId)).toEqual(["a2"]);
  });
  it("缺省包含终态", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a1"));
    reg.update("a1", { state: "failed" });
    expect(reg.list().length).toBe(1);
  });
  it("limit 缺省 50", () => {
    const reg = new SubagentRegistry();
    for (let i = 0; i < 60; i += 1) reg.register(rec("a" + String(i).padStart(2, "0"), { spawnedAt: i }));
    expect(reg.list().length).toBe(50);
  });
  it("limit 显式生效", () => {
    const reg = new SubagentRegistry();
    for (let i = 0; i < 5; i += 1) reg.register(rec("a" + i, { spawnedAt: i }));
    expect(reg.list({ limit: 2 }).map((r) => r.agentId)).toEqual(["a0", "a1"]);
    expect(reg.list({ limit: 0 })).toEqual([]);
  });
  it("sessionId 过滤", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a1", { sessionId: "s1", spawnedAt: 1 }));
    reg.register(rec("a2", { sessionId: "s2", spawnedAt: 2 }));
    expect(reg.list({ sessionId: "s2" }).map((r) => r.agentId)).toEqual(["a2"]);
  });
});

describe("descendants", () => {
  it("递归返回后代 id(排序、不含自身)", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("root"));
    reg.register(rec("c2", { parentId: "root", spawnedAt: 20 }));
    reg.register(rec("c1", { parentId: "root", spawnedAt: 10 }));
    reg.register(rec("g1", { parentId: "c2", spawnedAt: 30 }));
    expect(reg.descendants("root")).toEqual(["c1", "c2", "g1"]);
  });
  it("未知 agentId → []", () => {
    expect(new SubagentRegistry().descendants("nope")).toEqual([]);
  });
  it("环不导致自锁:自身永不出现在后代集", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a", { parentId: "b" }));
    reg.register(rec("b", { parentId: "a" }));
    expect(reg.descendants("a")).not.toContain("a");
    expect(reg.descendants("b")).not.toContain("b");
  });
});

describe("interrupt", () => {
  it("非终态 → ok,state=interrupted,返回记录", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a1"));
    const r = reg.interrupt("a1");
    expect(r.ok).toBe(true);
    expect(r.record?.state).toBe("interrupted");
    expect(reg.get("a1")?.state).toBe("interrupted");
  });
  it("终态 → ALREADY_TERMINAL,状态不变", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a1"));
    reg.update("a1", { state: "done" });
    const r = reg.interrupt("a1");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("ALREADY_TERMINAL");
    expect(reg.get("a1")?.state).toBe("done");
  });
  it("不存在 → NOT_FOUND", () => {
    const r = new SubagentRegistry().interrupt("nope");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("NOT_FOUND");
  });
  it("只影响目标:兄弟子代理保持 running", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a1", { parentId: "root" }));
    reg.register(rec("a2", { parentId: "root" }));
    reg.interrupt("a1");
    expect(reg.get("a1")?.state).toBe("interrupted");
    expect(reg.get("a2")?.state).toBe("running");
  });
  it("interrupt 后 update 不能打回 running", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a1"));
    reg.interrupt("a1");
    expect(reg.update("a1", { state: "running" }).code).toBe("INVALID");
  });
});

describe("stats", () => {
  it("按状态计数 + terminal 汇总", () => {
    const reg = new SubagentRegistry();
    for (let i = 0; i < 5; i += 1) reg.register(rec("a" + i));
    reg.update("a0", { state: "done" });
    reg.update("a1", { state: "failed" });
    reg.update("a2", { state: "cancelled" });
    reg.interrupt("a3");
    expect(reg.stats()).toEqual({ total: 5, running: 1, done: 1, failed: 1, cancelled: 1, interrupted: 1, terminal: 4 });
  });
});

describe("restore", () => {
  it("恢复新记录且终态保留", () => {
    const reg = new SubagentRegistry();
    const out = reg.restore([
      { ...rec("a1", { spawnedAt: 3 }), state: "done" },
      { ...rec("a2", { spawnedAt: 4 }), state: "failed" },
    ]);
    expect(out).toEqual({ restored: 2, skipped: 0 });
    expect(reg.get("a1")?.state).toBe("done");
    expect(reg.get("a2")?.state).toBe("failed");
  });
  it("已存在记录不被覆盖(终态保留)", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a1"));
    reg.update("a1", { state: "done" });
    const out = reg.restore([{ ...rec("a1"), state: "running" }]);
    expect(out).toEqual({ restored: 0, skipped: 1 });
    expect(reg.get("a1")?.state).toBe("done");
  });
  it("非法记录跳过不抛", () => {
    const reg = new SubagentRegistry();
    const out = reg.restore([{ agentId: "" } as unknown as SubagentRecord, { ...rec("a1"), state: "zombie" } as unknown as SubagentRecord, rec("a3")]);
    expect(out).toEqual({ restored: 1, skipped: 2 });
    expect(reg.get("a3")?.state).toBe("running");
  });
});

describe("不可变快照", () => {
  it("返回值被冻结", () => {
    const reg = new SubagentRegistry();
    const r = reg.register(rec("a1"));
    expect(Object.isFrozen(r.record)).toBe(true);
    expect(Object.isFrozen(reg.get("a1"))).toBe(true);
  });
  it("改返回值不影响注册表内部状态", () => {
    const reg = new SubagentRegistry();
    const r = reg.register(rec("a1", { title: "原始" }));
    const snap = r.record as SubagentRecord;
    try { (snap as { title?: string }).title = "被改"; } catch { /* 严格模式抛错也算防护 */ }
    expect(reg.get("a1")?.title).toBe("原始");
  });
  it("两次 list 返回互相独立的快照", () => {
    const reg = new SubagentRegistry();
    reg.register(rec("a1"));
    const first = reg.list()[0] as SubagentRecord;
    try { (first as { title?: string }).title = "污染"; } catch { /* ignore */ }
    expect(reg.list()[0]?.title).toBeUndefined();
  });
});
