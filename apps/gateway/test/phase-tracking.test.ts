/**
 * 五硬阶段追踪(2026-10-20 用户口径:理解→规划→实施→验收→完成,每阶段上板,
 * 不涉及也声明;代码级追踪防越做越偏):
 * - task_phase 推进:确认文本+journal task.phase 事件+板上「00 流程」泳道出现 ph- 节点;
 * - 越阶警告:understand 直接跳 close → 返回含越阶提醒(journal 留 warnings);
 * - skip 声明:上板节点 summary 含「不涉及」;
 * - plan-gate 收紧:纯阶段板(ph- 节点)不放行写角色;补设计节点后放行。
 */
import { it, expect, afterEach } from "vitest";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { readFileSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apps: ReturnType<typeof createGatewayApp>[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); delete process.env.GENIE_PERMISSION_RULES; });

function boardPathOf(sid: string, taskId: string): string {
  // 与 spawn-tool-policy 同根:GENIE_REPO_ROOT 未设时 taskRoot=repoRoot=harness 根
  return join(process.cwd(), "..", "..", ".genie", "boards", sid, `${taskId}.json`);
}

async function drive(app: ReturnType<typeof createGatewayApp>, sid: string) {
  app.taskManager.submit("user", sid, "做个小功能");
  for (let k = 0; k < 120; k++) {
    const t = app.taskManager.list().find((x) => x.sessionId === sid);
    if (t && (t.state === "done" || t.state === "failed")) return t;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("任务未终态");
}

it("task_phase:推进上板+journal 留痕;越阶与回退有警告;skip 上板「不涉及」", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }, { permission: "task_phase", pattern: "*", action: "allow" }]);
  const receipts: string[] = [];
  const sid = "ph-track-1";
  const app = createGatewayApp({
    port: 0,
    llm: { async chat(_m: unknown) {
      if (JSON.stringify(_m).includes("独立上下文")) return { content: "子代理完成" };
      const step = receipts.length;
      receipts.push("s" + step);
      if (step === 0) return { content: "", toolCalls: [{ id: "p1", name: "task_phase", arguments: JSON.stringify({ phase: "understand", note: "摸清任务边界" }) }] };
      if (step === 1) return { content: "", toolCalls: [{ id: "p2", name: "task_phase", arguments: JSON.stringify({ phase: "verify", note: "直接验收?" }) }] };
      if (step === 2) return { content: "", toolCalls: [{ id: "p3", name: "task_phase", arguments: JSON.stringify({ phase: "plan", note: "骨架规划完成" }) }] };
      if (step === 3) return { content: "", toolCalls: [{ id: "p4", name: "task_phase", arguments: JSON.stringify({ phase: "close", skip: true, note: "演示未完成" }) }] };
      receipts.push(JSON.stringify(_m));
      return { content: "终稿" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  const t = await drive(app, sid);
  const m = receipts.find((x) => x.startsWith("[") || x.startsWith("{")) ?? "";
  // p1 推进确认;p2 越阶(understand→verify)+skip;p3 回退(verify→plan)
  expect(m).toContain("阶段已推进");
  expect(m).toContain("越阶");
  expect(m).toContain("阶段回退");
  // 2026-10-21 用户口径修正:五阶段不落白板(白板=设计草图)——归宿=journal task.phase(带 taskId)
  // +「任务追踪」看板。断言:不生成阶段板文件。
  const bp = boardPathOf(sid, t.id);
  expect(existsSync(bp), "task_phase 不得再写白板").toBe(false);
}, 30_000);

it("P1-3 账本零步:task_phase 与并发安全工具同批(同一步)时两者都执行,task.phase 仍落 journal", async () => {
  // 背景(2026-10-30):task_phase 今日 97 次调用、每次独占一个完整 step(实测全仓 1.0 工具/步),
  // 占 input 4.1~4.4%。改法=tool 声明 isConcurrencySafe:true + 纪律卡明确「不要为它单独走一步」,
  // 让模型可以把它和工作工具塞进同一步。
  // 这里断言的是行为契约(isConcurrencySafe 是 tool 对象的局部字段,不经 wire 暴露):
  // 同一步批 task_phase + todo_write,两者必须都执行,且阶段事件不得因此丢失(plan-gate 判定源)。
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([
    { permission: "task_phase", pattern: "*", action: "allow" },
    { permission: "todo_write", pattern: "*", action: "allow" },
  ]);
  const seenReq: string[] = [];
  const sid = "ph-zero-step";
  const app = createGatewayApp({
    port: 0,
    llm: { async chat(msg: unknown) {
      const s = JSON.stringify(msg);
      if (s.includes("独立上下文")) return { content: "子代理完成" };
      seenReq.push(s);
      if (seenReq.length === 1) {
        // 同一步发两条:task_phase(账本)+ todo_write(另一并发安全工具)
        return { content: "", toolCalls: [
          { id: "z1", name: "task_phase", arguments: JSON.stringify({ phase: "understand", note: "同批声明" }) },
          { id: "z2", name: "todo_write", arguments: JSON.stringify({ items: [{ content: "做一件小事", status: "pending" }] }) },
        ] };
      }
      return { content: "终稿" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  await drive(app, sid);
  // 第二次请求能看到两条工具回执(两者都真执行了,没被并行批丢弃)
  const second = seenReq.at(-1) ?? "";
  expect(second).toContain("阶段已推进");
  expect(second).toMatch(/已记录|待办|计划/);
  // 阶段事件仍在 journal(plan-gate 的判定源不能因并行而弱化)
  const evs = (app as unknown as { journal?: { readSession(id: string): { kind?: string; payload?: Record<string, unknown> }[] } }).journal?.readSession(sid) ?? [];
  const phaseEvs = evs.filter((e) => e.kind === "custom" && (e.payload as { type?: string } | undefined)?.type === "task.phase");
  expect(phaseEvs.length, "task.phase 事件必须落 journal").toBeGreaterThan(0);
}, 30_000);

it("旧板防御(2026-10-21):只含 ph- 阶段节点的板不放行写角色(阶段已迁任务追踪看板)", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }, { permission: "task_phase", pattern: "*", action: "allow" }]);
  const seen: string[] = [];
  const sid = "ph-gate-1";
  const app = createGatewayApp({
    port: 0,
    llm: { async chat(_m: unknown) {
      const m = JSON.stringify(_m);
      if (m.includes("独立上下文")) return { content: "子代理完成" };
      const step = seen.length;
      seen.push("s" + step);
      if (step === 0) {
        // 声明阶段(不建板)+ 手工落一块「纯阶段节点」旧形态板——板门必须仍拒(无设计节点)
        const t = app.taskManager.list().find((x) => x.sessionId === sid)!;
        const board = { version: 1, taskId: t.id, sessionId: sid, title: "旧阶段板", status: "draft", rev: 1, nodes: [{ id: "ph-understand", kind: "note", label: "理解", summary: "旧形态" }], edges: [] };
        for (const base of [join(process.cwd(), "..", ".."), process.cwd()]) {
          try { const d = join(base, ".genie", "boards", sid); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${t.id}.json`), JSON.stringify(board), "utf-8"); } catch { /* 只读跳过 */ }
        }
        return { content: "", toolCalls: [
          { id: "o1", name: "task_phase", arguments: JSON.stringify({ phase: "understand", note: "u" }) },
          { id: "o2", name: "task_phase", arguments: JSON.stringify({ phase: "plan", note: "p" }) },
          { id: "o3", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "干重活" }) },
        ] };
      }
      seen.push("final:" + m);
      return { content: "终稿" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  await drive(app, sid);
  const final = seen.find((x) => x.startsWith("final:"))?.slice(6) ?? "";
  expect(final).toContain("被拦"); // 纯 ph- 板=无设计节点,闸门拒(阶段已声明,拒因只能是板门)
  expect(final).toContain("plan-gate");
}, 30_000);

it("核心纪律卡随用户消息注入:主 llm 首步 messages 的首条 user 消息尾部含纪律卡", async () => {
  const seen: string[] = [];
  const app = createGatewayApp({
    port: 0,
    llm: { async chat(_m: unknown) {
      const m = JSON.stringify(_m);
      if (m.includes("独立上下文")) return { content: "子代理完成" };
      seen.push(m);
      return { content: "终稿" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  await drive(app, "ph-card-1");
  const first = seen[0] ?? "";
  expect(first).toContain("核心纪律卡");
  expect(first).toContain("task_phase");
  expect(first).toContain("简明扼要");
  expect(first).toContain("P0 验收证据全绿前不宣称完成");
}, 30_000);

it("任务终态档案:done 落盘(含五阶段);后续任务注入历史块;planner 任务书带档案", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }, { permission: "task_phase", pattern: "*", action: "allow" }]);
  const sid = "ph-arch-1";
  const seen: string[] = [];
  const app = createGatewayApp({
    port: 0,
    llm: { async chat(_m: unknown) {
      const m = JSON.stringify(_m);
      if (m.includes("独立上下文") || m.includes("【子智能体角色")) {
        if (m.includes("规划子 agent")) {
          // planner 上下文应含历史档案块(第二个任务派 planner 时)
          seen.push("planner:" + (m.includes("历史任务/规划档案") ? "has-history" : "no-history"));
          return { content: "规划完成(子代理侧)" };
        }
        return { content: "子代理完成" };
      }
      const step = seen.length;
      seen.push("s" + step);
      if (step === 0) return { content: "", toolCalls: [{ id: "a1", name: "task_phase", arguments: JSON.stringify({ phase: "understand", note: "u" }) }] };
      if (step === 1) return { content: "", toolCalls: [{ id: "a2", name: "task_phase", arguments: JSON.stringify({ phase: "close", skip: true, note: "小任务" }) }] };
      if (step === 2) return { content: "第一任务完成:结论X" };
      if (step === 3) return { content: "", toolCalls: [{ id: "a3", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "新规划", agentType: "planner" }) }] };
      return { content: "第二任务收尾" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  // 任务一(带阶段)→ done 落档
  app.taskManager.submit("user", sid, "档案测试任务一");
  for (let k = 0; k < 100; k++) { const t = app.taskManager.list().find((x) => x.sessionId === sid && !("arch" in (x as object))); if (t && (t.state === "done" || t.state === "failed")) break; await new Promise((r) => setTimeout(r, 150)); }
  await new Promise((r) => setTimeout(r, 300));
  // 档案文件(候选根:repoRoot 与 cwd 上层,与板同策略)
  const { existsSync: ex, readFileSync: rd } = await import("node:fs");
  let entry: { state?: string; phases?: { phase: string }[]; instruction?: string } | null = null;
  for (const base of [join(process.cwd(), "..", ".."), process.cwd()]) {
    const ap = join(base, ".genie", "task-archive.jsonl");
    if (ex(ap)) {
      const last = rd(ap, "utf-8").split("\n").filter(Boolean).at(-1);
      if (last) { try { entry = JSON.parse(last); } catch { /* 坏行跳过 */ } }
      if (entry?.instruction?.includes("档案测试任务一")) break;
    }
  }
  expect(entry, "task-archive.jsonl 应有任务一条目").toBeTruthy();
  expect(entry!.state).toBe("done");
  expect(entry!.phases?.map((x) => x.phase)).toEqual(["understand", "close"]);
  // 任务二(同会话):注入历史块 + 派 planner 带档案
  app.taskManager.submit("user", sid, "档案测试任务二");
  for (let k = 0; k < 100; k++) {
    const ts = app.taskManager.list().filter((x) => x.sessionId === sid);
    if (ts.length >= 2 && ts[0] && (ts[0].state === "done" || ts[0].state === "failed")) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 300));
  const plannerHit = seen.find((x) => x.startsWith("planner:"));
  expect(plannerHit, "planner 子代理应被派发").toMatch(/^planner:has-history$/);
}, 45_000);
