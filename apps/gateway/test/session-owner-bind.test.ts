/**
 * 会话项目归属不可变(对齐 ZCode session.project_id 语义):
 * ①会话 owner 优先于 explicit——面板每次提交都带 active 项目,不得改写已定归属
 * (注意 web-1792663585723:前两任务 pid=genie,重启后点「重发」变 __harness__);
 * ②owner 首次解析即持久绑定(session.project.bind,幂等),任务被删后归属不丢;
 * ③新会话(无 owner)才用 explicit/active;
 * ④分叉复制事件时绑定随行继承(server.ts session.fork 拷贝非排除 kind)。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { TaskSupervisor } from "../src/task-manager.js";
import { resolveSubmitProjectId, sessionBindProjectId, sessionOwnerOf, SESSION_PROJECT_BIND_KIND } from "../src/server.js";

const GENIE = "caad6f38-1123-4bdf-9c72-c9989c710982";
const HARNESS = "__harness__";

function setup() {
  const journal = new MemoryJournal();
  const tm = new TaskSupervisor();
  return { journal, tm };
}

describe("会话项目归属不可变(owner > explicit)", () => {
  it("①已有 owner:explicit(当前 active 项目)不得改写——重发不再漂移", () => {
    const { journal, tm } = setup();
    const first = resolveSubmitProjectId(tm, "s1", GENIE, { journal });
    expect(first).toBe(GENIE);
    tm.submit("user", "s1", "原任务", { projectId: first! });
    // 重启后+切到 harness,面板重发带 explicit=__harness__
    const resend = resolveSubmitProjectId(tm, "s1", HARNESS, { journal });
    expect(resend).toBe(GENIE); // ← 修复前是 __harness__
  });

  it("②绑定是持久事实:任务被删后 owner 仍在(session.project.bind 幂等一条)", () => {
    const { journal, tm } = setup();
    tm.submit("user", "s2", "任务", { projectId: GENIE });
    expect(resolveSubmitProjectId(tm, "s2", HARNESS, { journal })).toBe(GENIE);
    // 模拟任务被删(task.deleteSession):内存任务表清空
    for (const t of tm.list({ sessionId: "s2" })) tm.markDeleted(new Set([t.id]));
    tm.restore([]);
    expect(sessionOwnerOf(journal, tm, "s2")).toBe(GENIE);
    expect(resolveSubmitProjectId(tm, "s2", HARNESS, { journal })).toBe(GENIE);
    const binds = journal.readSession("s2").filter((e) => e.kind === SESSION_PROJECT_BIND_KIND);
    expect(binds).toHaveLength(1); // 幂等:不重复写
  });

  it("③新会话(无 owner):explicit 生效并落绑定;无 explicit 时用 active", () => {
    const { journal, tm } = setup();
    expect(resolveSubmitProjectId(tm, "s3", GENIE, { journal })).toBe(GENIE);
    expect(sessionBindProjectId(journal, "s3")).toBe(GENIE);
    const projects = { activeId: () => HARNESS } as unknown as import("../src/projects.js").ProjectRegistry;
    expect(resolveSubmitProjectId(tm, "s4", undefined, { projects, journal })).toBe(HARNESS);
  });

  it("④最早任务派生 owner 会被补写成绑定(老会话迁移路径)", () => {
    const { journal, tm } = setup();
    tm.submit("user", "s5", "老任务", { projectId: GENIE });
    expect(sessionBindProjectId(journal, "s5")).toBeUndefined(); // 绑定前:无事件
    expect(resolveSubmitProjectId(tm, "s5", HARNESS, { journal })).toBe(GENIE);
    expect(sessionBindProjectId(journal, "s5")).toBe(GENIE); // 解析即补写
  });

  it("⑤分叉:绑定事件不被 fork 排除,子会话继承父 owner", () => {
    const { journal, tm } = setup();
    tm.submit("user", "parent", "任务", { projectId: GENIE });
    resolveSubmitProjectId(tm, "parent", undefined, { journal }); // 触发绑定
    // 复刻 server.ts session.fork 的拷贝语义(kind 未在 SESSION_FORK_EXCLUDED_KINDS)
    for (const e of journal.readSession("parent")) {
      journal.append({ kind: e.kind, sessionId: "fork-child", payload: e.payload, time: e.time });
    }
    expect(sessionBindProjectId(journal, "fork-child")).toBe(GENIE);
    expect(resolveSubmitProjectId(tm, "fork-child", HARNESS, { journal })).toBe(GENIE);
  });
});

describe("存量漂移归位(启动迁移)", () => {
  it("晚于 owner 任务却被贴到别的项目的任务 → 归位到 owner,幂等", async () => {
    const { repairSessionProjectDrift } = await import("../src/server.js");
    const { journal, tm } = setup();
    tm.submit("user", "s-drift", "原任务", { projectId: GENIE });
    await new Promise((r) => setTimeout(r, 3));
    tm.submit("user", "s-drift", "漂移任务", { projectId: HARNESS });
    const projects = { has: (id: string) => id === GENIE || id === HARNESS } as unknown as import("../src/projects.js").ProjectRegistry;
    const n1 = repairSessionProjectDrift(journal, tm, projects);
    expect(n1).toBe(1);
    expect(tm.list({ sessionId: "s-drift" }).every((t) => t.projectId === GENIE)).toBe(true);
    expect(repairSessionProjectDrift(journal, tm, projects)).toBe(0); // 幂等
    expect(journal.readAll().some((e) => (e.payload as { type?: string } | undefined)?.type === "task.project.repair")).toBe(true);
  });

  it("owner 已移除 → 不迁移(避免迁到不存在的项目)", async () => {
    const { repairSessionProjectDrift } = await import("../src/server.js");
    const { journal, tm } = setup();
    tm.submit("user", "s-dead", "原任务", { projectId: "dead-pid" });
    await new Promise((r) => setTimeout(r, 3));
    tm.submit("user", "s-dead", "漂移任务", { projectId: HARNESS });
    const projects = { has: (id: string) => id === HARNESS } as unknown as import("../src/projects.js").ProjectRegistry;
    expect(repairSessionProjectDrift(journal, tm, projects)).toBe(0);
  });
});
