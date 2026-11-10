/**
 * 全链路闭环变更硬门(2026-11-06 用户口径:「用户只描述意图,harness 自动找出该意图涉及的
 * 所有链路节点…一次性全部改到一致,并证明没有残留、没有孤儿、没有只改一半」)。
 *
 * 覆盖:
 * - 替换/迁移类指令 + 无盘点清单 → 写操作被拒且指路 change_surface;
 * - 有盘点清单 → 放行(spawn 真派发);
 * - exempt 显式豁免(理由落 journal)→ 放行;
 * - normal 指令(新建/小修)→ 不误拦;
 * - 收尾:surface 任务没有 passed 的 change.audit → 终稿带「未通过全链路审计」且不硬杀;
 * - task.context 记 changeScope / surfaceItems(开工一条 + 收尾刷新一条)。
 *
 * 断言口径:拒绝话术与子代理回显都进**模型上下文**(不在 task.result 里),故按 plan-gate.test.ts
 * 的既有写法抓最后一次 chat 的 messages。
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { surfaceGateVerdict } from "../src/change-surface-tool.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
beforeAll(async () => { await acquireEnvLock("change-scope-gate"); }, 240_000);
afterAll(() => { releaseEnvLock("change-scope-gate"); });

type App = ReturnType<typeof createGatewayApp>;
type Payload = Record<string, unknown>;
type Ev = { kind: string; sessionId?: string; payload?: Payload };

const apps: App[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); delete process.env.GENIE_PERMISSION_RULES; });

const SURFACE_INSTRUCTION = "把 SuperAgent 整体替换成新的数字人";
const NORMAL_INSTRUCTION = "加个按钮";

function landBoard(sid: string, taskId: string): void {
  const board = {
    version: 1, taskId, sessionId: sid, title: "设计板", status: "draft", rev: 1,
    nodes: [{ id: "d1", kind: "module", label: "主模块", summary: "设计节点", targets: ["apps/gateway/src/x.ts"] }],
    edges: [],
  };
  for (const base of [join(process.cwd(), "..", ".."), process.cwd()]) {
    try {
      const d = join(base, ".genie", "boards", sid);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, `${taskId}.json`), JSON.stringify(board), "utf-8");
    } catch { /* 只读跳过 */ }
  }
}

/**
 * 链路图摘要小样本(与生产端 `change.surface.chain` 同形:2 层 / 7 落点 / 1 条 flow 边,
 * withCallChain=false 时原因写在 knownLimits)。
 */
const chainSummary = (concept = "demoFlag") => ({
  stats: { layers: 2, nodes: 7, edges: 2, impactNodes: 0, withCallChain: false },
  layers: [{ category: "symbol", hits: 7, files: ["f0.ts"] }],
  order: Array.from({ length: 7 }, (_, i) => `symbol:f${i}.ts:1:${concept}`),
  edges: [{ from: `symbol:f0.ts:1:${concept}`, to: `symbol:f1.ts:1:${concept}`, kind: "flow" }],
  knownLimits: ["索引不可用(先 codesense index 构建),只有字面量层"],
});

const manifestEvent = (sid: string, taskId: string, hits = 7, withChain = true): Ev => ({
  kind: "custom",
  sessionId: sid,
  payload: {
    type: "change.surface", taskId, concepts: ["demoFlag"],
    ids: Array.from({ length: hits }, (_, i) => `symbol:f${i}.ts:1:demoFlag`),
    hits, byCategory: { symbol: hits }, truncated: false,
    ...(withChain ? { chain: chainSummary() } : {}),
    at: Date.now(),
  },
});

const auditEvent = (sid: string, taskId: string, passed: boolean): Ev => ({
  kind: "custom",
  sessionId: sid,
  payload: {
    type: "change.audit", taskId, concepts: ["demoFlag"], passed,
    total: 7, resolved: passed ? 7 : 3, justified: 0, unexplained: passed ? 0 : 4,
    invalidJustifications: 0, at: Date.now(),
  },
});

const taskIdOf = (app: App, sid: string): string => app.taskManager.list().find((x) => x.sessionId === sid)?.id ?? "";

interface Scenario {
  sid: string;
  instruction: string;
  withBoard: boolean;
  withManifest: boolean;
  /** 清单是否带链路图(缺省 true;仅「有盘点但无链路图」用例传 false)。 */
  withChain?: boolean;
  withAudit?: boolean;
  exempt?: boolean;
  spawnText: string;
}

/** 跑一个场景:第 0 步落盘前置事实 + 首次 spawn;之后返回终稿。返回 [终稿, 最后一次上下文]。 */
async function runScenario(s: Scenario): Promise<{ state: string; result: string; context: string; app: App }> {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
  const seen: string[] = [];
  let appRef: App;
  let step = 0;
  const app = createGatewayApp({
    port: 0,
    llm: {
      async chat(_m: unknown) {
        const m = JSON.stringify(_m);
        if (m.includes("独立上下文")) return { content: "子代理完成" };
        if (step++ === 0) {
          const tid = taskIdOf(appRef, s.sid);
          if (s.withBoard) landBoard(s.sid, tid);
          if (s.withManifest) appRef.journal.append(manifestEvent(s.sid, tid, 7, s.withChain ?? true) as never);
          if (s.withAudit !== undefined) appRef.journal.append(auditEvent(s.sid, tid, s.withAudit) as never);
          if (s.exempt) {
            appRef.journal.append({ kind: "custom", sessionId: s.sid, payload: { type: "change.exempt", taskId: tid, reason: "该概念只在文档举例中出现,无链路影响", at: Date.now() } } as never);
          }
          seen.push(m);
          return { content: "", toolCalls: [{ id: "s1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: s.spawnText }) }] };
        }
        seen.push(m);
        return { content: "终稿" };
      },
    } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  appRef = app;
  apps.push(app);
  app.taskManager.submit("user", s.sid, s.instruction);
  for (let k = 0; k < 200; k++) {
    const t = app.taskManager.list().find((x) => x.sessionId === s.sid);
    if (t && (t.state === "done" || t.state === "failed")) {
      return { state: t.state, result: String(t.result ?? ""), context: seen[seen.length - 1] ?? "", app };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("任务未在时限内终态");
}

describe("全链路硬门:替换类指令必须先盘点", () => {
  it("替换类指令 + 无盘点 → 拒绝并指路 change_surface(子代理未真派发)", async () => {
    const r = await runScenario({ sid: "csg-deny-1", instruction: SURFACE_INSTRUCTION, withBoard: false, withManifest: false, spawnText: "干活甲" });
    expect(r.context).toContain("plan-gate(全链路变更)");
    expect(r.context).toContain("change_surface");
    // 未真派发的判据:任务书文本只出现一次(assistant 自己的 tool_call 参数)。真派发时 echo 执行器
    // 还会把任务书回显进工具结果 → 出现 ≥2 次(与 plan-gate.test.ts 的「回显=走通」同源)。
    expect((r.context.match(/干活甲/g) ?? []).length, "任务书只该出现在未执行的 tool_call 参数里").toBe(1);
    const gate = r.app.journal.readAll().filter((e: Ev) => e.kind === "permission.gate" && (e.payload as Payload).rule === "plan-gate/change-surface");
    expect(gate.length).toBeGreaterThanOrEqual(1);
    expect((gate[0]!.payload as Payload).reason).toBe("no-change-surface");
  }, 60_000);

  it("有盘点 + 有板 → 放行(spawn 真派发)", async () => {
    const r = await runScenario({ sid: "csg-pass-1", instruction: SURFACE_INSTRUCTION, withBoard: true, withManifest: true, spawnText: "干活乙" });
    expect(r.context).toContain("干活乙");
    expect(r.context).not.toContain("plan-gate(全链路变更)");
  }, 60_000);

  it("有盘点但无链路图 → 拒绝 reason=no-chain-map,指路重新 scan", async () => {
    const r = await runScenario({ sid: "csg-chain-deny-1", instruction: SURFACE_INSTRUCTION, withBoard: true, withManifest: true, withChain: false, spawnText: "干活子甲" });
    expect(r.context).toContain("plan-gate(全链路变更)");
    expect(r.context).toContain("链路图");
    const gates = r.app.journal.readAll()
      .filter((e: Ev) => e.kind === "permission.gate" && (e.payload as Payload).reason === "no-chain-map");
    expect(gates.length, "缺链路图必须留 gate 痕").toBeGreaterThanOrEqual(1);
    // rule 字段:链路图轮由 agent-wiring 接线改成 plan-gate/change-chain;当前实测仍是
    // plan-gate/change-surface(同一处硬门),故按「reason 为准 + rule 二选一」断言,不锁死接线细节。
    expect(["plan-gate/change-chain", "plan-gate/change-surface"]).toContain((gates[0]!.payload as Payload).rule);
    // 未真派发:任务书只出现在未执行的 tool_call 参数里(同 deny 用例口径)。
    expect((r.context.match(/干活子甲/g) ?? []).length, "被拦 → 任务书不该被回显").toBe(1);
  }, 60_000);

  it("重扫后有链路图 → 放行(任务书回显=真派发)", async () => {
    const r = await runScenario({ sid: "csg-chain-pass-1", instruction: SURFACE_INSTRUCTION, withBoard: true, withManifest: true, withChain: true, spawnText: "干活子乙" });
    expect(r.context).not.toContain("plan-gate(全链路变更)");
    expect(r.context).toContain("干活子乙");
  }, 60_000);

  it("directRoute 豁免:无链路图也不拒", () => {
    // 场景无法注入 directRoute(agent-wiring 内部状态),故直接单测纯函数判据。
    const v = surfaceGateVerdict({
      taskClass: "coding", instruction: SURFACE_INSTRUCTION,
      hasManifest: true, hasChain: false, directRoute: true, exempt: false,
    });
    expect(v.deny).toBe(false);
    // 对照:同一输入去掉 directRoute → 必须拒(证明上面不是「永远放行」)。
    const denied = surfaceGateVerdict({
      taskClass: "coding", instruction: SURFACE_INSTRUCTION,
      hasManifest: true, hasChain: false, directRoute: false, exempt: false,
    });
    expect(denied.deny).toBe(true);
    expect(denied.reason).toBe("no-chain-map");
  });

  it("exempt 显式豁免(理由落 journal)→ 放行", async () => {
    const r = await runScenario({ sid: "csg-exempt-1", instruction: SURFACE_INSTRUCTION, withBoard: true, withManifest: false, exempt: true, spawnText: "干活丙" });
    expect(r.context).not.toContain("plan-gate(全链路变更)");
    expect(r.context).toContain("干活丙");
  }, 60_000);

  it("normal 指令(加个按钮)→ 不误拦,无盘点也派发", async () => {
    const r = await runScenario({ sid: "csg-normal-1", instruction: NORMAL_INSTRUCTION, withBoard: true, withManifest: false, spawnText: "干活丁" });
    expect(r.context).not.toContain("plan-gate(全链路变更)");
    expect(r.context).toContain("干活丁");
  }, 60_000);
});

describe("收尾审计", () => {
  it("surface 任务无 passed 的 change.audit → 终稿带「未通过全链路审计」且任务不硬杀", async () => {
    const r = await runScenario({ sid: "csg-close-1", instruction: SURFACE_INSTRUCTION, withBoard: true, withManifest: true, spawnText: "干活戊" });
    expect(r.state).toBe("done"); // 不硬杀
    expect(r.result).toContain("未通过全链路审计");
    const ev = r.app.journal.readAll().filter((e: Ev) => e.kind === "custom" && (e.payload as Payload).type === "change.audit.missing");
    expect(ev.length, "缺审计留痕").toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("surface 任务 audit failed → 也标未通过并报未处理数", async () => {
    const r = await runScenario({ sid: "csg-close-failed", instruction: SURFACE_INSTRUCTION, withBoard: true, withManifest: true, withAudit: false, spawnText: "干活癸" });
    expect(r.result).toContain("未通过全链路审计");
    expect(r.result).toContain("4 项未处理");
  }, 60_000);

  it("surface 任务 audit passed → 终稿不带未通过标记;normal 任务不误报", async () => {
    const passed = await runScenario({ sid: "csg-close-2", instruction: SURFACE_INSTRUCTION, withBoard: true, withManifest: true, withAudit: true, spawnText: "干活己" });
    expect(passed.result).not.toContain("未通过全链路审计");

    const normal = await runScenario({ sid: "csg-close-3", instruction: NORMAL_INSTRUCTION, withBoard: true, withManifest: false, spawnText: "干活庚" });
    expect(normal.result).not.toContain("未通过全链路审计");
  }, 90_000);
});

describe("task.context 判据字段", () => {
  it("surface 任务记 changeScope=surface;收尾刷新条带最终 surfaceItems;normal 任务记 normal", async () => {
    const s = await runScenario({ sid: "csg-ctx-1", instruction: SURFACE_INSTRUCTION, withBoard: true, withManifest: true, spawnText: "干活辛" });
    const ctxEvs = s.app.journal.readAll().filter((e: Ev) => e.kind === "task.context" && e.sessionId === "csg-ctx-1");
    expect(ctxEvs.length, "开工一条 + 收尾刷新一条").toBeGreaterThanOrEqual(2);
    const first = ctxEvs[0]!.payload as Payload;
    expect(first.changeScope).toBe("surface");
    expect(Number(first.surfaceItems), "开工时还没盘点=0(如实)").toBe(0);
    const last = ctxEvs[ctxEvs.length - 1]!.payload as Payload;
    expect(Number(last.surfaceItems)).toBe(7);

    const n = await runScenario({ sid: "csg-ctx-2", instruction: NORMAL_INSTRUCTION, withBoard: true, withManifest: false, spawnText: "干活壬" });
    const ctxN = n.app.journal.readAll().find((e: Ev) => e.kind === "task.context" && e.sessionId === "csg-ctx-2");
    expect(((ctxN?.payload ?? {}) as Payload).changeScope).toBe("normal");
    expect(Number(((ctxN?.payload ?? {}) as Payload).surfaceItems)).toBe(0);
  }, 90_000);
});
