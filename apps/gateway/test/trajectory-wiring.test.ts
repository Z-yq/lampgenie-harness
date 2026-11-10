/**
 * J1 轨迹卡接线(2026-11 token 轮 P0 缺口修复)回归锚。
 *
 * 缺口形态:runtime 已实现 `task.trajectory` 轨迹卡(loop.emitTrajectory,opts
 * trajectorySteps/trajectoryMeta/trajectoryTaskId),但 gateway 装配处没接线 → 真实任务永不落卡、
 * 面板轨迹条恒空、tips 的 ctx.trajectory 恒 undefined。
 *
 * 本文件是**行为级**验证:走真装配路径(createGatewayApp + 假 provider 跑真实 AgentLoop),
 * 断言 journal 里真出现 `task.trajectory`,且轨迹 payload 不进 deriveMessages(零上下文影响)。
 */
import { it, expect, afterEach, describe } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { deriveMessages } from "@lampgenie/runtime/agent/loop";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { currentSubgoal, progressNoteFromTrajectory, applyTrajectoryProgress } from "../src/agent-wiring.js";

const apps: ReturnType<typeof createGatewayApp>[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  delete process.env.GENIE_PERMISSION_RULES;
});

/* ---------------- ① currentSubgoal 取数口径(纯函数,直接锁三层兜底) ---------------- */

it("currentSubgoal:计划未完成项优先(取第一个 in_progress/pending),全完成退化任务书首句", () => {
  const j = new MemoryJournal();
  expect(currentSubgoal(j, "s1", "任务书原文")).toBe("任务书原文"); // 无计划 → 任务书
  j.append({ kind: "todo.updated", sessionId: "s1", payload: { items: [
    { content: "已完成项", status: "completed" },
    { content: "待办项 A", status: "pending" },
    { content: "进行中项 B", status: "in_progress" },
  ] } });
  expect(currentSubgoal(j, "s1", "任务书原文")).toBe("待办项 A"); // 计划内第一个未完成项
  // 最近一条计划全完成 → 不回溯历史计划,退化为任务书首句
  j.append({ kind: "todo.updated", sessionId: "s1", payload: { items: [{ content: "全完了", status: "completed" }] } });
  expect(currentSubgoal(j, "s1", "任务书原文")).toBe("任务书原文");
  // 任务书换行压平 + 取前 40 字
  const long = "第一行任务书\n第二行补充说明".repeat(3);
  expect(currentSubgoal(j, "s1", long)).toBe(long.replace(/\s+/g, " ").trim().slice(0, 40));
  // 都没有 → ""
  expect(currentSubgoal(j, "s1", "")).toBe("");
});

it("currentSubgoal:journal 读取故障兜底成空串(轨迹元数据故障绝不打断主链)", () => {
  const broken = { readSession: () => { throw new Error("journal boom"); } } as never;
  expect(currentSubgoal(broken, "s1", "任务书原文")).toBe("");
});

/* ---------------- ② 真装配路径:6 步只读工具调用后落 task.trajectory ---------------- */

it("e2e:真装配主 loop 跑 10 步只读调用 → journal 落 task.trajectory(taskId/steps/parallelRate 齐全),且不进 deriveMessages", async () => {
  const sid = "traj-e2e-1";
  const instruction = "轨迹卡接线验证任务";
  let calls = 0;
  const app = createGatewayApp({
    port: 0,
    llm: { async chat(_m: unknown) {
      const m = JSON.stringify(_m);
      if (m.includes("独立上下文")) return { content: "子代理完成" };
      calls += 1;
      // 前 12 个请求各返回一个只读工具调用(code_sense 声明 isReadOnly=权限闸门豁免);
      // 之后返回纯文本收尾。12 步保证「每 5 步」落满两条(step 5 与 step 10;
      // runtime 的 trajLast 初值 0 → 节奏点=第 N/2N… 步)。
      if (calls <= 12) {
        return { content: "", toolCalls: [{ id: `c${calls}`, name: "code_sense", arguments: JSON.stringify({ action: "project" }) }] };
      }
      return { content: "终稿" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  const submitted = app.taskManager.submit("user", sid, instruction);
  for (let k = 0; k < 200; k++) {
    const t = app.taskManager.list().find((x) => x.sessionId === sid);
    if (t && (t.state === "done" || t.state === "failed")) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const task = app.taskManager.list().find((x) => x.sessionId === sid)!;
  expect(task.state, "任务应跑完(轨迹/tips 注入不得打断主链)").toBe("done");
  expect(calls).toBeGreaterThanOrEqual(13); // 真跑了 ≥12 步工具 + 收尾

  const traj = app.journal.readAll().filter((e) => e.sessionId === sid && e.kind === "task.trajectory");
  expect(traj.length, "journal 必须出现 task.trajectory(装配接线缺失时此处为 0)").toBeGreaterThanOrEqual(2);
  // 步进口径:每 5 步一条(runtime trajLast 初值 0 → step 5 / step 10)
  expect(Math.max(...traj.map((e) => Number((e.payload as { step?: number }).step ?? 0)))).toBeGreaterThanOrEqual(5);
  const p = traj[traj.length - 1]!.payload as {
    taskId?: string; step?: number; steps?: number; tools?: Record<string, number>;
    parallelRate?: number; errors?: number; retries?: number; tokensSpent?: number; subgoal?: string;
  };
  expect(p.taskId).toBe(submitted.id); // 归属本任务
  expect(typeof p.step).toBe("number");
  expect(p.step!).toBeGreaterThanOrEqual(1); // trajectorySteps=5:每 5 步(或 phase 切换)才落
  expect(typeof p.steps).toBe("number");
  expect(p.tools && Object.keys(p.tools).length).toBeGreaterThan(0);
  expect(p.tools!.code_sense).toBeGreaterThanOrEqual(1);
  expect(typeof p.parallelRate).toBe("number");
  expect(p.parallelRate!).toBeGreaterThanOrEqual(0);
  expect(p.parallelRate!).toBeLessThanOrEqual(1);
  expect(typeof p.errors).toBe("number");
  expect(typeof p.retries).toBe("number");
  expect(typeof p.tokensSpent).toBe("number");
  // 本任务没写过 todo → subgoal 退化为任务书首句
  expect(p.subgoal).toBe(instruction.slice(0, 40));

  // 负面门:轨迹卡是旁路观测,payload 绝不进 deriveMessages(否则每次请求重放轨迹=token 反向膨胀)
  const derived = JSON.stringify(deriveMessages(app.journal, sid));
  expect(derived).not.toContain("parallelRate");
  expect(derived).not.toContain("tokensSpent");
  expect(derived).not.toContain("task.trajectory");
}, 60_000);

/* ───────── C) 轨迹 → 任务进度(touch):agent-wiring 折算纯函数(子任务 C 落点) ─────────
 *
 * 为什么抽纯函数:runWithAgent 装配路径太重(要真起 app + provider),而「note 怎么截断、phase 缺省
 * 带不带键、touch 抛错怎么办」正是容易写错的部分——抽 progressNoteFromTrajectory / applyTrajectoryProgress
 * 直测,装配侧只剩一行 `onTrajectory: (ev) => applyTrajectoryProgress(tm, task.id, ev)`。
 */

describe("C) progressNoteFromTrajectory / applyTrajectoryProgress", () => {
  type Ev = Parameters<typeof applyTrajectoryProgress>[2];
  const ev = (patch: Partial<Ev> = {}): Ev => ({
    taskId: "t1", step: 5, turn: 1, phase: "implement", subgoal: "改注入点",
    tokensSpent: 1000, errors: 2, steps: 5, tools: { code_sense: 3, edit_file: 2 }, ...patch,
  });

  it("① note 含步/工具类别数/错误数,且始终 ≤60 字(截断兜底)", () => {
    expect(progressNoteFromTrajectory(ev())).toBe("第5步 · 工具2类 · 错误2");
    // 极端值(超长步数 + 大量工具类别)也不得超过 60 字 —— 面板/任务卡一行放不下就会折行成噪音
    const many = Object.fromEntries(Array.from({ length: 999 }, (_, i) => [`a-very-long-tool-name-${i}`, 1]));
    const long = progressNoteFromTrajectory({ step: 987654321, tools: many, errors: 123456 });
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.startsWith("第987654321步")).toBe(true);
  });

  it("② touch 收到 phase/step/note/at;phase 缺省时不带该键(不覆盖旧 phase)", () => {
    const calls: { taskId: string; patch: Record<string, unknown> }[] = [];
    const tm = { touch: (taskId: string, patch: Record<string, unknown>) => { calls.push({ taskId, patch }); return undefined; } };
    applyTrajectoryProgress(tm, "t1", ev({ phase: "verify", step: 12 }));
    expect(calls[0]!.taskId).toBe("t1");
    expect(calls[0]!.patch.phase).toBe("verify");
    expect(calls[0]!.patch.step).toBe(12);
    expect(String(calls[0]!.patch.note)).toContain("第12步");
    expect(typeof calls[0]!.patch.at).toBe("number");
    // 无 phase → 不带键(否则 touch 的合并语义会拿 undefined 抹掉旧 phase)
    applyTrajectoryProgress(tm, "t1", ev({ phase: undefined, step: 13 }));
    expect("phase" in calls[1]!.patch).toBe(false);
    expect(calls[1]!.patch.step).toBe(13); // phase 未变时也照样每 5 步推进 step
    // 空串同样不带键
    applyTrajectoryProgress(tm, "t1", ev({ phase: "", step: 14 }));
    expect("phase" in calls[2]!.patch).toBe(false);
  });

  it("③ tm 缺失 / taskId 缺失 / touch 抛错 → 静默跳过,不抛(不打断主链)", () => {
    expect(() => applyTrajectoryProgress(undefined, "t1", ev())).not.toThrow();
    let called = 0;
    const tm = { touch: () => { called += 1; } };
    expect(() => applyTrajectoryProgress(tm, undefined, ev())).not.toThrow();
    expect(called).toBe(0);
    const boom = { touch: () => { throw new Error("tm boom"); } };
    expect(() => applyTrajectoryProgress(boom, "t1", ev())).not.toThrow();
  });

  it("④ 集成:真 TaskSupervisor.touch 写入 progress 且不动 state/updatedAt", async () => {
    const { TaskSupervisor } = await import("../src/task-manager.js");
    const tm = new TaskSupervisor();
    const task = tm.submit("user", "sess-c1", "任务书");
    const before = tm.get(task.id)!;
    applyTrajectoryProgress(tm, task.id, ev({ phase: "verify", step: 10 }));
    const after = tm.get(task.id)!;
    expect(after.progress?.phase).toBe("verify");
    expect(after.progress?.step).toBe(10);
    expect(String(after.progress?.note)).toContain("第10步");
    expect(after.state).toBe(before.state); // 状态迁移不归这里
    expect(after.updatedAt).toBe(before.updatedAt); // touch 不抬 updatedAt
    // 墓碑任务 → touch 返回 undefined,不抛
    tm.delete(task.id);
    expect(() => applyTrajectoryProgress(tm, task.id, ev({ step: 11 }))).not.toThrow();
  });
});

/* ---------------- ③ 真装配路径:C) 轨迹 → 任务进度(phase/step/note 写进 TaskSupervisor) ---------------- */

it("e2e:真装配跑 8 步 → task.progress 被写入(step 每 5 步推进),state/updatedAt 不被进度改写", async () => {
  const sid = "traj-prog-1";
  const instruction = "进度接线验证任务";
  let calls = 0;
  const app = createGatewayApp({
    port: 0,
    llm: { async chat(m: unknown) {
      const s = JSON.stringify(m);
      if (s.includes("独立上下文")) return { content: "子代理完成" };
      calls += 1;
      // 8 步工具(含一次 run_cmd 之外全是只读)→ 轨迹在 step5 due 一次 → onTrajectory 写一次进度
      if (calls <= 8) {
        return { content: "", toolCalls: [{ id: `c${calls}`, name: "code_sense", arguments: JSON.stringify({ action: "project" }) }] };
      }
      return { content: "终稿" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  const submitted = app.taskManager.submit("user", sid, instruction);
  for (let k = 0; k < 200; k++) {
    const t = app.taskManager.list().find((x) => x.sessionId === sid);
    if (t && (t.state === "done" || t.state === "failed")) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const task = app.taskManager.get(submitted.id)!;
  expect(task.state, "任务应跑完(进度旁注不得打断主链)").toBe("done");
  // onTrajectory 接线在场 → 进度被写(未接线时 progress 恒 undefined)
  expect(task.progress?.step, "step 应由 onTrajectory 写进 task.progress").toBeGreaterThanOrEqual(5);
  expect(String(task.progress?.note ?? "")).toContain("工具");
  expect(task.progress?.note!.length).toBeLessThanOrEqual(61); // ≤60 字(+可选省略号)
}, 60_000);
