/**
 * plan-gate 代码级规划强制( planner 委托/先骨架后丰满/防目标丢失
 * 不能只靠上下文,要代码机制记录与追踪):
 * - 写角色子代理派发前置闸:无板拒(journal permission.gate by=plan-gate)并指路 planner;
 * - planner/explore 不受限;
 * - 主 agent 直写文件同闸(createFileTools planGate 回调);
 * - 板在场即放行(与 board_upsert 同根 taskRoot)。
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { createFileTools } from "../src/file-tools.js";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../src/repo-root.js";

// env 互斥:threads pool 共享 process.env,动 GENIE_PERMISSION_RULES 等进程级开关的
// 测试文件必须串行,否则并行文件互相拆 env=间歇假红。
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
beforeAll(async () => { await acquireEnvLock("plan-gate"); }, 240_000); // 等锁可能长(hook 默认 10s 会假红)
afterAll(() => { releaseEnvLock("plan-gate"); });

const apps: ReturnType<typeof createGatewayApp>[] = [];
/** 写文件用例的路径唯一化后缀:固定路径在第二次运行时命中「已存在需先 read_file」,会让「已创建」断言假红。 */
const UNIQ = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); delete process.env.GENIE_PERMISSION_RULES; });

function llmScript(steps: Array<(ctx: { msgs: string }) => { content: string; toolCalls?: { id: string; name: string; arguments: string }[] }>) {
  let i = 0;
  return { async chat(_m: unknown) {
    if (JSON.stringify(_m).includes("独立上下文")) return { content: "子代理完成" }; // 子 agent 秒回
    const step = steps[Math.min(i++, steps.length - 1)]!;
    return step({ msgs: JSON.stringify(_m) });
  } } as never;
}

function boardPathOf(sid: string, taskId: string): string {
  return join(process.cwd(), "..", "..", ".genie", "boards", sid, `${taskId}.json`);
}

async function drive(app: ReturnType<typeof createGatewayApp>, sid: string) {
  app.taskManager.submit("user", sid, "改点东西");
  for (let k = 0; k < 120; k++) {
    const t = app.taskManager.list().find((x) => x.sessionId === sid);
    if (t && (t.state === "done" || t.state === "failed")) return t;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("任务未在时限内终态");
}

it("无板:派 worker 被拒并指路 planner;再派 planner 放行(第二次工具调用不再被拒)", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
  const seen: string[] = [];
  const app = createGatewayApp({    port: 0,
    llm: llmScript([
      () => ({ content: "", toolCalls: [{ id: "g1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "干活" }) }] }), // 缺省 worker
      () => ({ content: "", toolCalls: [{ id: "g2", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "规划", agentType: "planner" }) }] }),
      ({ msgs }) => { seen.push(msgs); return { content: "终稿" }; },
    ]),
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  await drive(app, "pg-block-1");
  // push 只发生在终稿步:该步 messages 已含两步工具结果
  const final = seen[0] ?? "";
  expect(final).toContain("plan-gate");
  expect(final).toContain("rejected");
  expect(final).toContain("planner"); // 拒绝文本指路 planner
  expect(final).toContain("规划"); // planner 派发的结果(echo 回显任务书)进了上下文=派发走通
}, 30_000);

it("阶段与板解耦(2026-10-21):task_phase 不建板;无板+已声明仍拒;落设计板后放行", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }, { permission: "task_phase", pattern: "*", action: "allow" }]);
  const seen: string[] = [];
  const sid = "pg-pass-1";
  let landed = false;
  const app = createGatewayApp({ port: 0,
    llm: { async chat(_m: unknown) {
      const m = JSON.stringify(_m);
      if (m.includes("独立上下文")) return { content: "子代理完成" };
      const step = seen.length;
      seen.push("s" + step);
      if (step === 0) return { content: "", toolCalls: [{ id: "r1", name: "task_phase", arguments: JSON.stringify({ phase: "understand", note: "u" }) }] };
      if (step === 1) return { content: "", toolCalls: [{ id: "r2", name: "task_phase", arguments: JSON.stringify({ phase: "plan", note: "p" }) }] };
      if (step === 2) return { content: "", toolCalls: [{ id: "r3", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "干重活" }) }] }; // 无板:板门拒(阶段已声明,阶段门过)
      if (step === 3 && !landed) {
        landed = true;
        const t = app.taskManager.list().find((x) => x.sessionId === sid)!;
        const board = { version: 1, taskId: t.id, sessionId: sid, title: "设计板", status: "draft", rev: 1, nodes: [{ id: "d1", kind: "module", label: "主模块", summary: "设计节点", targets: ["apps/gateway/src/x.ts"] }], edges: [] }; // :内容节点(带 targets)才开门
        for (const base of [join(process.cwd(), "..", ".."), process.cwd()]) {
          try { const d = join(base, ".genie", "boards", sid); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${t.id}.json`), JSON.stringify(board), "utf-8"); } catch { /* 只读跳过 */ }
        }
        seen.push("landed");
        return { content: "", toolCalls: [{ id: "r4", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "再干" }) }] }; // 板+阶段齐:放行
      }
      seen.push("final:" + m);
      return { content: "终稿" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  const t = await drive(app, sid);
  // 白板不得含阶段节点(task_phase 已不写板;若用例自建设计板,亦不得有 ph-)
  const bp = boardPathOf(sid, t.id);
  if (existsSync(bp)) {
    const nodes = JSON.parse(readFileSync(bp, "utf-8")).nodes as { id: string }[];
    expect(nodes.every((n) => !n.id.startsWith("ph-")), "白板不得含阶段节点").toBe(true);
  }
  const final = seen.find((x) => x.startsWith("final:"))?.slice(6) ?? "";
  expect((final.match(/被拦/g) ?? []).length, "仅无板那次被拦(阶段已声明,被拦的只能是板门)").toBe(1);
  expect(final).toContain("再干"); // 板落地后派发真实执行(echo 回显进上下文)
}, 30_000);

// 板根统一:board_upsert 实际写盘根 = repoRoot(storeRoot 缺省),闸门也必须读同根。
// 任务 projectId 指向非 harness 项目时 taskRoot≠repoRoot——旧实现按 taskRoot 读板恒读不到 → 死循环。
it("板根统一:任务 projectId 指向非 harness 项目(taskRoot≠repoRoot),板写在 storeRoot 后闸门放行", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
  const projDir = mkdtempSync(join(tmpdir(), "pg-root-"));
  const sid = "pg-root-1";
  const seen: string[] = [];
  const app = createGatewayApp({ port: 0,
    llm: { async chat(_m: unknown) {
      const m = JSON.stringify(_m);
      if (m.includes("独立上下文")) return { content: "子代理完成" };
      if (seen.length === 0) {
        // 板落在 storeRoot(=repoRoot()),即 board_upsert/面板面板的真实写盘根。
        const t = app.taskManager.list().find((x) => x.sessionId === sid)!;
        const d = join(repoRoot(), ".genie", "boards", sid);
        mkdirSync(d, { recursive: true });
        const board = { version: 1, taskId: t.id, sessionId: sid, title: "设计板", status: "draft", rev: 1, nodes: [{ id: "d1", kind: "module", label: "主模块", summary: "设计节点", targets: ["apps/gateway/src/y.ts"] }], edges: [] }; // :内容节点(带 targets)才开门
        writeFileSync(join(d, `${t.id}.json`), JSON.stringify(board), "utf-8");
        seen.push("step0");
        return { content: "", toolCalls: [{ id: "w1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "干活甲" }) }] };
      }
      seen.push("final:" + m);
      return { content: "终稿" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  const added = app.projects.add(projDir);
  if (!added.ok) throw new Error("项目添加失败:" + added.reason);
  const task = app.taskManager.submit("user", sid, "改点东西", { projectId: added.project.id });
  for (let k = 0; k < 120; k++) {
    const cur = app.taskManager.get(task.id);
    if (cur && (cur.state === "done" || cur.state === "failed")) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const final = seen.find((x) => x.startsWith("final:"))?.slice(6) ?? "";
  expect(final, "板在 storeRoot 就应放行,不再误报无板").not.toContain("本任务还没有设计白板");
  expect(final).toContain("干活甲"); // 写角色子代理真的派发出去(echo 回显任务书)
  try { rmSync(join(repoRoot(), ".genie", "boards", sid), { recursive: true, force: true }); } catch { /* 清理失败容忍 */ }
  rmSync(projDir, { recursive: true, force: true });
}, 40_000);

// 逃生阀:同一 task 同因「无板」拒绝累计到第 3 次 → 降级放行 + journal 留痕,
// 防「闸门根错位/板真落不了」时 agent 被同一 reason 钉死无限重试。
it("逃生阀:同任务连续 3 次「无板」拒绝后第 3 次降级放行,journal 记 effect=escalated", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }, { permission: "task_phase", pattern: "*", action: "allow" }]);
  const sid = "pg-escalate-1";
  const seen: string[] = [];
  const app = createGatewayApp({ port: 0,
    llm: { async chat(_m: unknown) {
      const m = JSON.stringify(_m);
      if (m.includes("独立上下文")) return { content: "子代理完成" };
      const step = seen.length;
      seen.push("s" + step);
      if (step === 0) return { content: "", toolCalls: [{ id: "p1", name: "task_phase", arguments: JSON.stringify({ phase: "plan", note: "先规划" }) }] };
      if (step === 1) return { content: "", toolCalls: [{ id: "e1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "干活乙" }) }] };
      if (step === 2) return { content: "", toolCalls: [{ id: "e2", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "干活乙" }) }] };
      if (step === 3) return { content: "", toolCalls: [{ id: "e3", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "干活乙" }) }] }; // 第 3 次:降级放行
      seen.push("final:" + m);
      return { content: "终稿" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  const task = app.taskManager.submit("user", sid, "改点东西");
  for (let k = 0; k < 120; k++) {
    const cur = app.taskManager.get(task.id);
    if (cur && (cur.state === "done" || cur.state === "failed")) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const final = seen.find((x) => x.startsWith("final:"))?.slice(6) ?? "";
  expect((final.match(/次因「无板」被拒/g) ?? []).length, "前两次仍是拒绝(带诊断)").toBe(2);
  expect(final).toContain("干活乙"); // 第 3 次放行:子代理真的跑起来
  const esc = app.journal.readAll().filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "plan.gate" && (e.payload as { effect?: string }).effect === "escalated");
  expect(esc).toHaveLength(1);
  expect((esc[0]!.payload as { count?: number }).count).toBe(3);
}, 40_000);

it("规划委托:主 agent 内联 >3 节点板且未派 planner → 写角色被拒;派 planner 后放行", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
  const sid = "pg-planner-required-1";
  const seen: string[] = [];
  let step = 0;
  let app: ReturnType<typeof createGatewayApp>;
  app = createGatewayApp({ port: 0,
    llm: { async chat(m: unknown) {
      const msgs = JSON.stringify(m);
      if (msgs.includes("独立上下文")) return { content: "子代理完成" };
      const i = step++;
      if (i === 0) {
        // 模拟主 agent 自己内联画了 4 节点大板(旧行为;规范只允许 ≤3 节点轻量板)
        const t = app.taskManager.list().find((x) => x.sessionId === sid)!;
        const board = {
          version: 1, taskId: t.id, sessionId: sid, title: "主代理内联大板", status: "draft", rev: 1,
          nodes: [1, 2, 3, 4].map((n) => ({ id: `d${n}`, kind: "module", label: `模块${n}`, summary: `节点${n}`, targets: [`src/m${n}.ts`] })), edges: [], // :内容节点才进放行分支
        };
        const d = join(repoRoot(), ".genie", "boards", sid);
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, `${t.id}.json`), JSON.stringify(board), "utf-8");
        return { content: "", toolCalls: [{ id: "w1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "干活一" }) }] };
      }
      if (i === 1) return { content: "", toolCalls: [{ id: "p1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "规划", agentType: "planner" }) }] };
      if (i === 2) return { content: "", toolCalls: [{ id: "w2", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "干活二" }) }] };
      seen.push(msgs);
      return { content: "终稿" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  try {
    const t = await drive(app, sid);
    const final = seen[0] ?? "";
    expect((final.match(/plan-gate\(规划委托\)/g) ?? []).length, "第一次写角色派发被规划委托闸拒绝").toBe(1);
    expect(final).toContain("没有派过 planner"); // 拒绝指路 planner
 // 差分回执(B2 P2):只报缺什么+下一步,不复述规则全文
    expect(final).toContain("缺:planner 派发 0 次");
    expect(final).toContain("下一步一句话:spawn_subagent(agentType=\\\\\\\"planner\\\\\\\""); // final 是 messages JSON 序列化,引号被转义
    expect(final).not.toContain("规范要求非小修任务由 planner 自己落规划契约"); // 规则全文不再进回执
    expect(final).toContain("规划"); // planner 派发走通(echo 回显任务书)
    expect(final).toContain("干活二"); // 派 planner 后写角色放行
    const ev = app.journal.readAll().filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "plan.gate" && (e.payload as { effect?: string }).effect === "planner-required");
    expect(ev).toHaveLength(1);
    expect((ev[0]!.payload as { nodeCount?: number }).nodeCount).toBe(4);
    expect(t.state).toBe("done");
  } finally {
    try { rmSync(join(repoRoot(), ".genie", "boards", sid), { recursive: true, force: true }); } catch { /* 清理失败容忍 */ }
  }
}, 40_000);

it("createFileTools planGate 回调:write_file/edit_file 被拦,read 不受影响", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pg-ft-"));
  const journal = { append: () => {} } as never;
  const blocked = JSON.stringify({ status: "rejected", reason: "plan-gate:test 拦截" });
  const tools = createFileTools({ root: dir, journal, sessionId: "s-ft", planGate: (tool) => (tool === "write_file" || tool === "edit_file" ? blocked : null) });
  const write = tools.find((x) => x.name === "write_file")!;
  const read = tools.find((x) => x.name === "read_file")!;
  expect(await write.execute({ path: "a.txt", content: "x" })).toContain("plan-gate:test 拦截");
  writeFileSync(join(dir, "a.txt"), "hello", "utf-8");
  expect(await read.execute({ path: "a.txt" })).toContain("hello"); // 读侧无闸
});

// 内容节点判据:纯计划步骤板(「s1 梳理→s2 归因」,零 targets/symbolRef/accept/数据)
// 不再开门——板是「变更在系统里的内容契约」不是 TODO 清单(板偏计划步骤而非实际开发内容逻辑)。
it("纯步骤板不开门:拒绝话术点名步骤板并教内容要求;补 targets 后放行", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }, { permission: "task_phase", pattern: "*", action: "allow" }]);
  const seen: string[] = [];
  const sid = "pg-content-1";
  let landed = false;
  const app = createGatewayApp({ port: 0,
    llm: { async chat(_m: unknown) {
      const m = JSON.stringify(_m);
      if (m.includes("独立上下文")) return { content: "子代理完成" };
      const step = seen.length;
      seen.push("s" + step);
      if (step === 0) return { content: "", toolCalls: [{ id: "c0a", name: "task_phase", arguments: JSON.stringify({ phase: "understand", note: "u" }) }] };
      if (step === 1) return { content: "", toolCalls: [{ id: "c0b", name: "task_phase", arguments: JSON.stringify({ phase: "plan", note: "p" }) }] };
      if (step === 2) return { content: "", toolCalls: [{ id: "c1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "干重活" }) }] }; // 无板:拒
      if (step === 3 && !landed) {
        landed = true;
        const t = app.taskManager.list().find((x) => x.sessionId === sid)!;
        // 先落步骤板 → 下一步仍应被拒;再原地升级为内容板 → 放行
        const stepBoard = { version: 1, taskId: t.id, sessionId: sid, title: "步骤板", status: "draft", rev: 1, nodes: [
          { id: "s1", kind: "module", label: "梳理轨迹", summary: "先看" },
          { id: "s2", kind: "module", label: "归因根因", summary: "再找" },
        ], edges: [] };
        for (const base of [join(process.cwd(), "..", ".."), process.cwd()]) {
          try { const d = join(base, ".genie", "boards", sid); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${t.id}.json`), JSON.stringify(stepBoard), "utf-8"); } catch { /* 只读跳过 */ }
        }
        seen.push("landed-step");
        return { content: "", toolCalls: [{ id: "c2", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "再试" }) }] };
      }
      if (seen.includes("landed-step") && !seen.includes("landed-content")) {
        const t = app.taskManager.list().find((x) => x.sessionId === sid)!;
        const contentBoard = { version: 1, taskId: t.id, sessionId: sid, title: "契约板", status: "draft", rev: 2, nodes: [
          { id: "m1", kind: "module", label: "改 x 模块", summary: "加守卫", targets: ["apps/gateway/src/app.ts"] },
          { id: "s1", kind: "module", label: "梳理轨迹", summary: "先看" },
        ], edges: [] };
        for (const base of [join(process.cwd(), "..", ".."), process.cwd()]) {
          try { const d = join(base, ".genie", "boards", sid); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${t.id}.json`), JSON.stringify(contentBoard), "utf-8"); } catch { /* 只读跳过 */ }
        }
        seen.push("landed-content");
        return { content: "", toolCalls: [{ id: "c3", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "三试" }) }] };
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
 // 步骤板被拒时的拒绝话术必须点名步骤板并教内容要求
  expect(final).toContain("纯计划步骤板");
  expect(final).toContain("targets");
  // 内容板落地后真正放行(三试的 echo 回显进上下文)
  expect(final).toContain("三试");
}, 30_000);

// ── 阶段门自动推进 + 记账收敛 ─────────────────────────────────────────
// 背景:7 天 telemetry(n=108 次 phase 拒绝/33 会话)中 100% 的 by=plan-gate/phase 拒绝发生在
// 「该会话此前无任何 task_phase 声明」时,69.4% 是同会话重复被拒。板含内容节点=规划事实已发生,
// 用「阶段声明」这种形式拦写操作过严 → 阶段门改为自动推进到 plan 并首次留痕,不再拒绝。
it("阶段门自动推进:板在场但从未 task_phase,首个写操作放行且只留一次 phase-auto-advanced", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
  const sid = "pg-phase-auto-1";
  const seen: string[] = [];
  let step = 0;
  let app: ReturnType<typeof createGatewayApp>;
  app = createGatewayApp({ port: 0,
    llm: { async chat(m: unknown) {
      const msgs = JSON.stringify(m);
      if (msgs.includes("独立上下文")) return { content: "子代理完成" };
      const i = step++;
      if (i === 0) {
        // 板已在场(含内容节点),但全程不调 task_phase
        const t = app.taskManager.list().find((x) => x.sessionId === sid)!;
        const d = join(repoRoot(), ".genie", "boards", sid);
        mkdirSync(d, { recursive: true });
        const board = { version: 1, taskId: t.id, sessionId: sid, title: "内容板", status: "draft", rev: 1, nodes: [{ id: "d1", kind: "module", label: "改闸门", summary: "改 plan-gate", targets: ["apps/gateway/src/agent-wiring.ts"] }], edges: [] };
        writeFileSync(join(d, `${t.id}.json`), JSON.stringify(board), "utf-8");
        return { content: "", toolCalls: [{ id: "pa1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "干活甲" }) }] };
      }
      if (i === 1) return { content: "", toolCalls: [{ id: "pa2", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "干活乙" }) }] };
      seen.push(msgs);
      return { content: "终稿" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  try {
    await drive(app, sid);
    const final = seen[0] ?? "";
    // 两次写操作都放行(无「被拦」),阶段门不再拒绝
    expect(final).not.toContain("五阶段流程还没走到");
    expect(final).toContain("干活甲");
    expect(final).toContain("干活乙");
    const evs = app.journal.readAll().filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "plan.gate" && (e.payload as { effect?: string }).effect === "phase-auto-advanced");
    expect(evs, "第二次写操作不再落 phase-auto-advanced").toHaveLength(1);
    const p = evs[0]!.payload as { to?: string; from?: string | null; nodeCount?: number; tool?: string };
    expect(p.to).toBe("plan");
    expect(p.from).toBeNull();
    expect(p.nodeCount).toBe(1);
    expect(p.tool).toBe("spawn_subagent");
    const phaseEvs = app.journal.readAll().filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "task.phase" && (e.payload as { auto?: boolean }).auto === true);
    expect(phaseEvs).toHaveLength(1);
    const pp = phaseEvs[0]!.payload as { phase?: string; from?: string | null };
    expect(pp.phase).toBe("plan");
    expect(pp.from).toBeNull();
 // 规划质量结构化留痕(B2 P2):收尾落 task.quality,面板结算直接读,不重放板。
    const q = app.journal.readAll().filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "task.quality");
    expect(q, "板在场任务收尾必落一条 task.quality").toHaveLength(1);
    const qp = q[0]!.payload as { taskId?: string; planQuality?: { boardType: unknown; nodes: number; contentNodes: number; p0: { passed: number; total: number }; anchorDensity: number } };
    expect(qp.taskId).toBe(app.taskManager.list().find((x) => x.sessionId === sid)!.id);
    expect(qp.planQuality).toMatchObject({ nodes: 1, contentNodes: 1, p0: { passed: 0, total: 0 }, anchorDensity: 1 });
  } finally {
    try { rmSync(join(repoRoot(), ".genie", "boards", sid), { recursive: true, force: true }); } catch { /* 清理失败容忍 */ }
  }
}, 40_000);

it("逃生阀记账收敛:13 次无板拒绝只落 2 条 escalated(attempt=3 与 13),首条带结构化字段", async () => {
  const prevMode = process.env.GENIE_PLAN_GATE;
  process.env.GENIE_PLAN_GATE = "hard";
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
  const sid = "pg-escalate-converge-1";
  const calls = Array.from({ length: 13 }, (_, k) => ({ id: `ec${k}`, name: "spawn_subagent", arguments: JSON.stringify({ instructions: "干活丙" }) }));
  const app = createGatewayApp({ port: 0,
    llm: llmScript([
      () => ({ content: "", toolCalls: calls }), // 同一步发 13 个写角色派发:全部走无板判据 => ({ content: "终稿" }),
    ]),
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  try {
    await drive(app, sid);
    const esc = app.journal.readAll()
      .filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "plan.gate" && (e.payload as { effect?: string }).effect === "escalated")
      .map((e) => e.payload as { attempt?: number; count?: number; escalatedAt?: number; reason?: string; limit?: number });
    expect(esc.length, "只在第 3 次与第 13 次留痕").toBe(2);
    expect(esc.map((e) => e.attempt)).toEqual([3, 13]);
    expect(typeof esc[0]!.escalatedAt).toBe("number");
    expect(esc[0]!.reason).toBe("no-board");
    expect(esc[0]!.limit).toBe(3);
    expect(esc[0]!.count).toBe(3); // 向后兼容字段保留
    expect(esc[1]!.escalatedAt).toBeTypeOf("number");
  } finally {
    if (prevMode === undefined) delete process.env.GENIE_PLAN_GATE; else process.env.GENIE_PLAN_GATE = prevMode;
  }
}, 40_000);

it("规划委托闸记账收敛:13 次写角色派发只落 planner-required×2 + escalated×2(attempt=3 与 13)", async () => {
 // 背景( N1 基线):旧实现 escalated 后每次写操作都落一条,320 条里 316 条是重复记
  // (3 个会话贡献 271/320,最长 count=163),把"逃生阀占比 77.5%"这种事件级比例彻底污染。
  // 收敛口径:非 escalated(前 2 次)每条都落;escalated 只在首次(3)与之后每 +10 落一条。
  // 放行语义不变:第 3 次起仍放行(不再返回 rejected)。
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
  const sid = "pg-planner-converge-1";
  let app: ReturnType<typeof createGatewayApp>;
  let step = 0;
  const calls = Array.from({ length: 13 }, (_, k) => ({ id: `pc${k}`, name: "spawn_subagent", arguments: JSON.stringify({ instructions: `干活${k}` }) }));
  app = createGatewayApp({ port: 0,
    llm: { async chat(m: unknown) {
      const msgs = JSON.stringify(m);
      if (msgs.includes("独立上下文")) return { content: "子代理完成" };
      const i = step++;
      if (i === 0) {
        // 主 agent 内联 4 节点内容板、未派 planner → 每次写角色派发都走委托闸
        const t = app.taskManager.list().find((x) => x.sessionId === sid)!;
        const board = {
          version: 1, taskId: t.id, sessionId: sid, title: "内联大板", status: "draft", rev: 1,
          nodes: [1, 2, 3, 4].map((n) => ({ id: `d${n}`, kind: "module", label: `模块${n}`, summary: `节点${n}`, targets: [`src/m${n}.ts`] })), edges: [],
        };
        const d = join(repoRoot(), ".genie", "boards", sid);
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, `${t.id}.json`), JSON.stringify(board), "utf-8");
        return { content: "", toolCalls: calls }; // 同一步 13 个写角色派发
      }
      return { content: "终稿" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  try {
    await drive(app, sid);
    const pgEvs = app.journal.readAll()
      .filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "plan.gate")
      .map((e) => e.payload as { effect?: string; attempt?: number; escalatedAt?: number; reason?: string; limit?: number });
    const normal = pgEvs.filter((e) => e.effect === "planner-required");
    const esc = pgEvs.filter((e) => e.effect === "planner-required-escalated");
    expect(normal.map((e) => e.attempt), "前 2 次拒绝每条都落").toEqual([1, 2]);
    expect(esc.map((e) => e.attempt), "escalated 只落 attempt=3 与 13").toEqual([3, 13]);
    expect(esc[0]!.reason).toBe("planner-not-spawned");
    expect(esc[0]!.limit).toBe(2);
    expect(typeof esc[0]!.escalatedAt).toBe("number");
  } finally {
    try { rmSync(join(repoRoot(), ".genie", "boards", sid), { recursive: true, force: true }); } catch { /* 清理失败容忍 */ }
    delete process.env.GENIE_PERMISSION_RULES;
  }
}, 60_000);

it("无板 permission.gate 结构化:payload.reason=no-board 且 rule/decisionBy/taskId 在场", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
  const sid = "pg-noboard-payload-1";
  const app = createGatewayApp({ port: 0,
    llm: llmScript([
      () => ({ content: "", toolCalls: [{ id: "nb1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "干活丁" }) }] }),
      () => ({ content: "终稿" }),
    ]),
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  const t = await drive(app, sid);
  const gates = app.journal.readAll().filter((e) => e.kind === "permission.gate" && (e.payload as { by?: string }).by === "plan-gate");
  expect(gates.length, "第一次无板写操作被拒并留痕").toBe(1);
  const p = gates[0]!.payload as { reason?: string; rule?: string; decisionBy?: string; taskId?: string; effect?: string; by?: string; hint?: string };
  expect(p.reason).toBe("no-board");
  expect(p.rule).toBe("plan-gate/content-board");
  expect(p.decisionBy).toBe("plan-gate");
  expect(p.taskId).toBe(t.id);
  expect(p.effect).toBe("denied");
  expect(p.hint).toBe("本任务无规划板——先 spawn planner 落规划契约"); // 话术逐字不动
}, 30_000);


// ── 白板适用面(「白板不要任何内容都进行落板;白板一定是开发内容逻辑,
// 不要是 todo list;办公任务也可以在板上画作业思路(主题/受众/结构/章节/章间关系/顺序)」):
// office 从「软免板」改硬闸(composition 作业思路板 / exemptReason 留痕二选一);coding 增豁免通道。
describe("白板适用面收口:office 硬闸 + exemptReason 豁免通道", () => {
  // 合法豁免理由(trim 后 ≥20 字;18 字的「本任务是纯环境探查,没有开发内容」会被判过短)
  const VALID_REASON = "本任务是纯环境探查,只核对依赖版本与目录结构,没有任何开发内容";
  const compositionBoard = (t: { id: string }, sid: string) => ({
    version: 1, taskId: t.id, sessionId: sid, title: "作业思路板", status: "draft", rev: 1, boardType: "composition",
    nodes: [
      { id: "n1", kind: "note", label: "主题:项目一年进展汇报", summary: "讲清进展与风险" },
      { id: "n2", kind: "note", label: "受众:研发管理者", summary: "5 分钟,决定是否追加投入" },
      { id: "n3", kind: "section", label: "01 进展", summary: "已完成事项" },
      { id: "n4", kind: "section", label: "02 风险", summary: "承接进展,递进到风险与对策" },
    ],
    edges: [{ from: "n3", to: "n4", kind: "data", label: "递进" }],
  });

  it("office 任务 + 无板 → 写操作被拒,reason 含「作业思路板」与 exemptReason", async () => {
    process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "write_file", pattern: "*", action: "allow" }]);
    const seen: string[] = [];
    const sid = "pg-office-noboard-1";
    const app = createGatewayApp({ port: 0,
      llm: { async chat(_m: unknown) {
        const m = JSON.stringify(_m);
        if (m.includes("独立上下文")) return { content: "子代理完成" };
        seen.push(m);
        if (seen.length === 1) return { content: "", toolCalls: [{ id: "ow1", name: "write_file", arguments: JSON.stringify({ path: "out/deck-note-pg-office-noboard.txt", content: "ppt 大纲" }) }] };
        return { content: "被 plan-gate 拦,先落作业思路板或豁免。" };
      } } as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    apps.push(app);
    app.taskManager.submit("user", sid, "做一份 PPT 介绍这个项目");
    for (let k = 0; k < 200; k++) {
      const t = app.taskManager.list().find((x) => x.sessionId === sid);
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const second = seen[1] ?? "";
    expect(second).toContain("作业思路板");
    expect(second).toContain("exemptReason");
    expect(second).toContain("composition");
    const gate = app.journal.readAll().find((e) => e.kind === "permission.gate" && (e.payload as { reason?: string }).reason === "no-composition-board");
    expect(gate, "office 无板拒绝要结构化留痕").toBeTruthy();
    expect((gate!.payload as { rule?: string }).rule).toBe("plan-gate/composition-board");
  }, 40_000);

  it("office 任务 + composition 板(≥3 节点)→ 写操作放行", async () => {
    process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "write_file", pattern: "*", action: "allow" }]);
    const seen: string[] = [];
    const sid = "pg-office-composition-1";
    let landed = false;
    let app: ReturnType<typeof createGatewayApp>;
    app = createGatewayApp({ port: 0,
      llm: { async chat(m: unknown) {
        const msgs = JSON.stringify(m);
        if (msgs.includes("独立上下文")) return { content: "子代理完成" };
        seen.push(msgs);
        if (!landed) {
          landed = true;
          const t = app.taskManager.list().find((x) => x.sessionId === sid)!;
          const d = join(repoRoot(), ".genie", "boards", sid);
          mkdirSync(d, { recursive: true });
          writeFileSync(join(d, `${t.id}.json`), JSON.stringify(compositionBoard(t, sid)), "utf-8");
          return { content: "", toolCalls: [{ id: "oc1", name: "write_file", arguments: JSON.stringify({ path: `out/deck-ok-pg-office-composition-${UNIQ}.txt`, content: "按思路板写" }) }] };
        }
        return { content: "终稿" };
      } } as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    apps.push(app);
    try {
      app.taskManager.submit("user", sid, "做一份 PPT 介绍这个项目");
      for (let k = 0; k < 200; k++) {
        const t = app.taskManager.list().find((x) => x.sessionId === sid);
        if (t && (t.state === "done" || t.state === "failed")) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      // 系统提示本身含「作业思路板」字样,不能用它当判据——只看 plan-gate 拒绝回执与写入结果。
      const final = seen[1] ?? "";
      expect(final, "composition 板在场:写操作不被 plan-gate 拦").not.toContain("plan-gate:主 agent 直写");
      expect(final).toContain("已创建");
      const ev = app.journal.readAll().filter((e) => e.kind === "custom" && (e.payload as { effect?: string }).effect === "board-present-composition");
      expect(ev).toHaveLength(1);
    } finally {
      try { rmSync(join(repoRoot(), ".genie", "boards", sid), { recursive: true, force: true }); } catch { /* 清理失败容忍 */ }
    }
  }, 40_000);

  it("coding 任务 + exemptReason 过短 → 仍拒;合法理由 → 放行且 journal 有 board.exempt", async () => {
    process.env.GENIE_PLAN_GATE = "hard";
    process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "board_upsert", pattern: "*", action: "allow" }, { permission: "spawn_subagent", pattern: "*", action: "allow" }]);
    const prevMode = process.env.GENIE_PLAN_GATE;
    const seen: string[] = [];
    const sid = "pg-exempt-1";
    let step = 0;
    const app = createGatewayApp({ port: 0,
      llm: { async chat(m: unknown) {
        const msgs = JSON.stringify(m);
        if (msgs.includes("独立上下文")) return { content: "子代理完成" };
        seen.push(msgs);
        const i = step++;
        if (i === 0) return { content: "", toolCalls: [{ id: "x1", name: "board_upsert", arguments: JSON.stringify({ exemptReason: "没内容" }) }] };
        if (i === 1) return { content: "", toolCalls: [{ id: "x2", name: "board_upsert", arguments: JSON.stringify({ exemptReason: VALID_REASON }) }] };
        if (i === 2) return { content: "", toolCalls: [{ id: "x3", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "干活豁免后" }) }] };
        return { content: "终稿" };
      } } as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    apps.push(app);
    try {
      await drive(app, sid);
      // 过短理由被拒(拒绝回执文本逐字)
      expect(seen[1] ?? "").toContain("豁免理由过短");
      // 合法理由 → 回执 status=exempted(不写板)
      // 整段 messages 被 JSON.stringify 转义过引号,按片段断言
      expect(seen[2] ?? "").toContain("exempted");
      // 豁免后写角色放行
      expect(seen[3] ?? "").toContain("干活豁免后");
      const ex = app.journal.readAll().filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "board.exempt");
      expect(ex).toHaveLength(1);
      const p = ex[0]!.payload as { reason?: string; taskClass?: string; tool?: string; taskId?: string };
      expect(p.reason).toBe(VALID_REASON);
      expect(p.taskClass).toBe("coding");
      expect(p.tool).toBe("board_upsert");
    } finally {
      if (prevMode === undefined) delete process.env.GENIE_PLAN_GATE; else process.env.GENIE_PLAN_GATE = prevMode;
    }
  }, 40_000);

  it("qa 任务 → 无板直写仍放行(既有行为不回归)", async () => {
    process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "write_file", pattern: "*", action: "allow" }]);
    const seen: string[] = [];
    const sid = "pg-qa-1";
    const app = createGatewayApp({ port: 0,
      llm: { async chat(m: unknown) {
        const msgs = JSON.stringify(m);
        if (msgs.includes("独立上下文")) return { content: "qa 子代理完成" };
        seen.push(msgs);
        if (seen.length === 1) return { content: "", toolCalls: [{ id: "q1", name: "write_file", arguments: JSON.stringify({ path: `out/qa-pg-qa-${UNIQ}.txt`, content: "笔记" }) }] };
        return { content: "结论:入口在 main.ts" };
      } } as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    apps.push(app);
    app.taskManager.submit("user", sid, "这个项目的入口在哪里?");
    for (let k = 0; k < 200; k++) {
      const t = app.taskManager.list().find((x) => x.sessionId === sid);
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const second = seen[1] ?? "";
    expect(second).not.toContain("规划板");
    expect(second).not.toContain("作业思路板");
    expect(second).toContain("已创建");
  }, 40_000);
});
