/**
 * 全链路变更第二批:收尾硬门 + E2E/负面断言入审计 + 语义孤儿接入 change.audit。
 * 覆盖三块:
 *  A. closeAuditVerdict 三态(warn 行为逐字不变 / hard 各缺口 hardFail 且文案点名 / directRoute 豁免);
 *  B. change_surface audit 的 verify 规整与落账(缺省/非法形状/截断/旧事件回读不炸);
 *  C. 语义孤儿检查(临时 git 仓:仅测试接线的导出 + 空 catch;非 git 目录走 knownLimits 不抛);
 *  D. 收尾硬门在 agent-wiring 的实际终态(hard 不满足 → failed + journal hard-fail;off 全放行)。
 */
import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
import {
  closeAuditVerdict,
  makeChangeSurfaceTool,
  normalizeVerify,
  readChangeAudit,
  readChangeSurfaceManifest,
  type ChangeAuditRecord,
  type ChangeSurfaceJournal,
  type ChangeSurfaceManifest,
} from "../src/change-surface-tool.js";

// ---- 夹具 ----
// env 锁:本文件 D 段会改进程级 GENIE_PERMISSION_RULES / GENIE_CHANGE_AUDIT(与并行文件互斥)。
beforeAll(async () => { await acquireEnvLock("change-audit-hard"); }, 240_000);
type Payload = Record<string, unknown>;
type Ev = { kind: string; sessionId?: string; payload?: Payload };

function fakeJournal(seed: Ev[] = []): ChangeSurfaceJournal & { evs: Ev[] } {
  const evs: Ev[] = [...seed];
  return {
    evs,
    append(e) { evs.push(e as Ev); return evs.length; },
    readAll() { return evs; },
  };
}

/**
 * 链路图摘要小样本(与生产端 `change.surface.chain` 同形:2 层 / 7 落点 / 1 条 flow 边)。
 * 与 change-scope-gate.test.ts 的 chainSummary 同形状(两份夹具互不 import)。
 */
const chainSample = (concept = "legacyFlag") => ({
  stats: { layers: 2, nodes: 7, edges: 2, impactNodes: 0, withCallChain: false },
  layers: [{ category: "symbol", hits: 7, files: ["f0.ts"] }],
  order: Array.from({ length: 7 }, (_, i) => `symbol:f${i}.ts:1:${concept}`),
  edges: [{ from: `symbol:f0.ts:1:${concept}`, to: `symbol:f1.ts:1:${concept}`, kind: "flow" }],
  knownLimits: ["索引不可用(先 codesense index 构建),只有字面量层"],
});

const manifest = (hits = 3): ChangeSurfaceManifest => ({
  taskId: "t1",
  concepts: ["legacyFlag"],
  ids: Array.from({ length: hits }, (_, i) => `symbol:f${i}.ts:1:legacyFlag`),
  hits,
  byCategory: { symbol: hits },
  truncated: false,
  chain: chainSample(),
  at: 1,
});

/** 同一清单的「旧清单」版本(链路图轮之前落的:无 chain 字段)。 */
const manifestNoChain = (hits = 3): ChangeSurfaceManifest => {
  const { chain: _chain, ...rest } = manifest(hits);
  return rest;
};

/** 一条「去向全有、验收证据齐全、无孤儿」的通过记录。 */
const auditPassed = (over: Partial<ChangeAuditRecord> = {}): ChangeAuditRecord => ({
  taskId: "t1",
  passed: true,
  total: 3,
  resolved: 3,
  justified: 0,
  unexplained: 0,
  invalidJustifications: 0,
  verified: true,
  verifyE2e: { n: 1, failed: 0 },
  verifyNegatives: { n: 1, failed: 0 },
  verifyFailed: 0,
  orphans: 0,
  orphanWarnings: 0,
  orphanFindings: [],
  at: 1,
  ...over,
});

const SURFACE_INSTRUCTION = "把 legacyFlag 整体替换成新开关";

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmpProject(files: Record<string, string>, git = false): string {
  const dir = mkdtempSync(join(tmpdir(), "genie-cah-"));
  tmpDirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body, "utf-8");
  }
  if (git) {
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
    g("init", "-q");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    g("add", "-A");
    g("commit", "-qm", "base");
  }
  return dir;
}

// ---- A. closeAuditVerdict 三态 ----
describe("closeAuditVerdict:warn / hard / directRoute", () => {
  const base = { taskClass: "coding", instruction: SURFACE_INSTRUCTION };

  it("warn(缺省):无盘点/无审计/未通过 各挂警告,hardFail 不出现", () => {
    const noManifest = closeAuditVerdict({ ...base, manifest: null, audit: null });
    expect(noManifest.warn).toBe(true);
    expect(noManifest.mark).toContain("无变更面盘点");
    expect(noManifest.hardFail).toBeUndefined();

    const noAudit = closeAuditVerdict({ ...base, manifest: manifest(), audit: null });
    expect(noAudit.warn).toBe(true);
    expect(noAudit.mark).toContain("未跑 change.audit");

    const failed = closeAuditVerdict({ ...base, manifest: manifest(), audit: auditPassed({ passed: false, unexplained: 2 }) });
    expect(failed.warn).toBe(true);
    expect(failed.mark).toContain("2 项未处理");
    expect(failed.hardFail).toBeUndefined();
  });

  it("warn:passed 但缺验收证据 → 行为不变(不警告、不标记)", () => {
    const v = closeAuditVerdict({ ...base, manifest: manifest(), audit: auditPassed({ verified: false, verifyE2e: { n: 0, failed: 0 }, verifyNegatives: { n: 0, failed: 0 } }) });
    expect(v.warn).toBe(false);
    expect(v.mark).toBe("");
    expect(v.hardFail).toBeUndefined();
  });

  it("hard:各缺口都 hardFail 且文案点名", () => {
    const noManifest = closeAuditVerdict({ ...base, manifest: null, audit: null, hard: true });
    expect(noManifest.hardFail).toBe(true);
    expect(noManifest.mark).toContain("无变更面盘点");

    const noAudit = closeAuditVerdict({ ...base, manifest: manifest(), audit: null, hard: true });
    expect(noAudit.hardFail).toBe(true);
    expect(noAudit.mark).toContain("未跑 change.audit");

    const notPassed = closeAuditVerdict({ ...base, manifest: manifest(), audit: auditPassed({ passed: false, unexplained: 4 }), hard: true });
    expect(notPassed.hardFail).toBe(true);
    expect(notPassed.mark).toContain("4 项未处理");

    const noEvidence = closeAuditVerdict({ ...base, manifest: manifest(), audit: auditPassed({ verified: false, verifyE2e: { n: 0, failed: 0 }, verifyNegatives: { n: 0, failed: 0 } }), hard: true });
    expect(noEvidence.hardFail).toBe(true);
    expect(noEvidence.mark).toContain("缺验收证据");

    const evFailed = closeAuditVerdict({ ...base, manifest: manifest(), audit: auditPassed({ verified: false, verifyE2e: { n: 2, failed: 1 } }), hard: true });
    expect(evFailed.hardFail).toBe(true);
    expect(evFailed.mark).toContain("验收证据 1 条未通过");

    const orphan = closeAuditVerdict({ ...base, manifest: manifest(), audit: auditPassed({ orphans: 2, orphanWarnings: 1, orphanFindings: [{ file: "src/a.ts", line: 3, title: "孤独逻辑:导出 x 无任何调用方", severity: "warning", detail: "d" }] }), hard: true });
    expect(orphan.hardFail).toBe(true);
    expect(orphan.mark).toContain("warning 级孤儿");
    expect(orphan.text).toContain("src/a.ts:3");
  });

  it("hard:证据齐全 + 仅 nit 级孤儿 → 放行(不 hardFail)", () => {
    const v = closeAuditVerdict({
      ...base, manifest: manifest(),
      audit: auditPassed({ orphans: 2, orphanWarnings: 0, orphanFindings: [{ file: "src/a.ts", line: 1, title: "空 catch", severity: "nit", detail: "d" }] }),
      hard: true,
    });
    expect(v.hardFail).toBeUndefined();
    expect(v.warn).toBe(false);
  });

  it("hard + 清单缺链路图 → hardFail 且 mark 含「缺链路图」", () => {
    const v = closeAuditVerdict({ ...base, manifest: manifestNoChain(), audit: auditPassed(), hard: true });
    expect(v.hardFail).toBe(true);
    expect(v.mark).toContain("缺链路图");
    expect(v.mark).toContain("未通过全链路审计");
    expect(v.text).toContain("链路图");
    // 缺口顺序:缺链路图先于「未跑 audit」判定(清单本身不完整时不给审计结论)。
    const noAudit = closeAuditVerdict({ ...base, manifest: manifestNoChain(), audit: null, hard: true });
    expect(noAudit.hardFail).toBe(true);
    expect(noAudit.mark).toContain("缺链路图");
  });

  it("warn + 清单缺链路图 → warn=false 且不加标记(行为逐字不变)", () => {
    const v = closeAuditVerdict({ ...base, manifest: manifestNoChain(), audit: auditPassed() });
    expect(v.warn).toBe(false);
    expect(v.mark).toBe("");
    expect(v.hardFail).toBeUndefined();
  });

  it("directRoute 豁免:hard 模式下也不判", () => {
    const v = closeAuditVerdict({ ...base, manifest: null, audit: null, hard: true, directRoute: true });
    expect(v.hardFail).toBeUndefined();
    expect(v.warn).toBe(false);
  });

  it("非 surface 指令 / 非 coding:三态都不判", () => {
    for (const hard of [false, true]) {
      expect(closeAuditVerdict({ taskClass: "coding", instruction: "加个按钮", manifest: null, audit: null, hard }).warn).toBe(false);
      expect(closeAuditVerdict({ taskClass: "qa", instruction: SURFACE_INSTRUCTION, manifest: null, audit: null, hard }).warn).toBe(false);
    }
  });
});

// ---- B. verify 规整 + 落账 ----
describe("verify 入审计", () => {
  it("规整:合法形状 verified=true;缺 negatives 不算 verified;非法形状忽略并说明", () => {
    const ok = normalizeVerify({
      e2e: [{ command: "npx vitest run x", passed: true, output: "1 passed" }],
      negatives: [{ assertion: "非法开关值必须被拒", passed: true, evidence: "抛错" }],
    });
    expect(ok.verified).toBe(true);
    expect(ok.e2e).toHaveLength(1);
    expect(ok.negatives).toHaveLength(1);

    const noNeg = normalizeVerify({ e2e: [{ command: "a", passed: true }] });
    expect(noNeg.verified).toBe(false);
    expect(noNeg.notes.join(";")).toContain("未提供负面断言");

    const bad = normalizeVerify({ e2e: [{ passed: true }, "x", { command: "b", passed: "yes" }], negatives: "nope" });
    expect(bad.e2e).toHaveLength(0);
    expect(bad.verified).toBe(false);
    expect(bad.notes.join(";")).toContain("已忽略");

    const scalar = normalizeVerify("e2e: 全绿");
    expect(scalar.verified).toBe(false);
    expect(scalar.notes.join(";")).toContain("必须是对象");
  });

  it("截断:e2e 超 10 条 / negatives 超 20 条 → 截断并写明", () => {
    const v = normalizeVerify({
      e2e: Array.from({ length: 12 }, (_, i) => ({ command: `c${i}`, passed: true })),
      negatives: Array.from({ length: 25 }, (_, i) => ({ assertion: `a${i}`, passed: true })),
    });
    expect(v.e2e).toHaveLength(10);
    expect(v.negatives).toHaveLength(20);
    expect(v.notes.join(";")).toContain("e2e 超过 10 条");
    expect(v.notes.join(";")).toContain("negatives 超过 20 条");
    expect(v.verified).toBe(true);
  });

  it("audit 落 journal 与回执:带 verify → verified/计数;不带 verify → verified:false", async () => {
    const root = tmpProject({ "src/a.ts": "export const legacyFlag = 1;\n" });
    const j = fakeJournal();
    const tool = makeChangeSurfaceTool({ journal: j, sessionId: "s1", taskId: "t1", root });

    const withVerify = await tool.execute({
      action: "audit", concept: "legacyFlag",
      resolutions: [{ file: "src/a.ts", status: "resolved" }],
      verify: { e2e: [{ command: "npx vitest run a.test.ts", passed: true }], negatives: [{ assertion: "空 concept 必须报错", passed: true }] },
    });
    expect(withVerify).toContain("验收证据");
    expect(withVerify).toContain("verified");
    const rec1 = readChangeAudit(j, "s1", "t1")!;
    expect(rec1.passed).toBe(true);
    expect(rec1.verified).toBe(true);
    expect(rec1.verifyE2e).toEqual({ n: 1, failed: 0 });
    expect(rec1.verifyNegatives).toEqual({ n: 1, failed: 0 });

    const without = await tool.execute({ action: "audit", concept: "legacyFlag", resolutions: [{ file: "src/a.ts", status: "resolved" }] });
    expect(without).toContain("未提供 E2E/负面断言,收尾硬门不放行");
    const rec2 = readChangeAudit(j, "s1", "t1")!;
    expect(rec2.verified).toBe(false);
    expect(rec2.verifyE2e.n).toBe(0);
  });

  it("旧 journal 事件(第二批之前,无新字段)回读不炸,按 0/false", () => {
    const j = fakeJournal([{
      kind: "custom", sessionId: "s1",
      payload: { type: "change.audit", taskId: "t1", concepts: ["x"], passed: true, total: 2, resolved: 2, justified: 0, unexplained: 0, invalidJustifications: 0, at: 5 },
    }]);
    const rec = readChangeAudit(j, "s1", "t1");
    expect(rec).not.toBeNull();
    expect(rec!.passed).toBe(true);
    expect(rec!.verified).toBe(false);
    expect(rec!.verifyE2e).toEqual({ n: 0, failed: 0 });
    expect(rec!.orphans).toBe(0);
    expect(rec!.orphanFindings).toEqual([]);
  });

  it("change.surface 回读:带 chain → 返回链路图;旧事件无 chain → 字段 undefined(不是 null)", () => {
    const withChain = fakeJournal([{
      kind: "custom", sessionId: "s1",
      payload: { type: "change.surface", ...manifest(), taskId: "t1", at: 5 },
    }]);
    const m = readChangeSurfaceManifest(withChain, "s1", "t1")!;
    expect(m.chain).toBeDefined();
    expect(m.chain!.stats.nodes).toBe(7);
    expect(m.chain!.stats.withCallChain).toBe(false);
    expect(m.chain!.layers[0]).toEqual({ category: "symbol", hits: 7, files: ["f0.ts"] });
    expect(m.chain!.order).toHaveLength(7);
    expect(m.chain!.edges[0]!.kind).toBe("flow");
    expect(m.chain!.knownLimits[0]).toContain("索引不可用");

    const legacy = fakeJournal([{
      kind: "custom", sessionId: "s1",
      payload: { type: "change.surface", taskId: "t1", concepts: ["legacyFlag"], hits: 1, ids: ["symbol:f0.ts:1:legacyFlag"], byCategory: { symbol: 1 }, truncated: false, at: 5 },
    }]);
    const old = readChangeSurfaceManifest(legacy, "s1", "t1")!;
    expect(old.chain).toBeUndefined();
    expect("chain" in old, "旧事件省略该字段(不是填 null)").toBe(false);
    expect(old.hits).toBe(1);
  });
});

// ---- C. 语义孤儿检查 ----
// ---- D. 收尾硬门在 agent-wiring 的实际终态(hard / off) ----
const gwApps: ReturnType<typeof createGatewayApp>[] = [];
afterEach(async () => {
  for (const a of gwApps.splice(0)) await a.close();
  delete process.env.GENIE_PERMISSION_RULES;
  delete process.env.GENIE_CHANGE_AUDIT;
});
afterAll(() => { releaseEnvLock("change-audit-hard"); });

type App = ReturnType<typeof createGatewayApp>;

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

const manifestEvent = (sid: string, taskId: string, hits = 7): Ev => ({
  kind: "custom", sessionId: sid,
  payload: {
    type: "change.surface", taskId, concepts: ["legacyFlag"],
    ids: Array.from({ length: hits }, (_, i) => `symbol:f${i}.ts:1:legacyFlag`),
    hits, byCategory: { symbol: hits }, truncated: false,
    chain: chainSample(),
    at: Date.now(),
  },
});

const auditEventPassed = (sid: string, taskId: string): Ev => ({
  kind: "custom", sessionId: sid,
  payload: {
    type: "change.audit", taskId, concepts: ["legacyFlag"], passed: true,
    total: 7, resolved: 7, justified: 0, unexplained: 0, invalidJustifications: 0,
    verified: true, verifyE2e: { n: 1, failed: 0 }, verifyNegatives: { n: 1, failed: 0 },
    orphans: 0, orphanWarnings: 0, orphanFindings: [], at: Date.now(),
  },
});

/** 跑一个场景:第 0 步落盘前置事实 + 首次 spawn;之后返回终稿(补跑轮同样返回终稿)。 */
async function runScenario(s: { sid: string; withManifest: boolean; withPassedAudit: boolean }): Promise<{ state: string; result: string; app: App }> {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
  let appRef: App;
  let step = 0;
  const app = createGatewayApp({
    port: 0,
    llm: {
      async chat() {
        if (step++ === 0) {
          const tid = appRef.taskManager.list().find((x) => x.sessionId === s.sid)?.id ?? "";
          landBoard(s.sid, tid);
          if (s.withManifest) appRef.journal.append(manifestEvent(s.sid, tid) as never);
          if (s.withPassedAudit) appRef.journal.append(auditEventPassed(s.sid, tid) as never);
          return { content: "", toolCalls: [{ id: "s1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "干活" }) }] };
        }
        return { content: "终稿" };
      },
    } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  appRef = app;
  gwApps.push(app);
  app.taskManager.submit("user", s.sid, SURFACE_INSTRUCTION);
  for (let k = 0; k < 240; k++) {
    const t = app.taskManager.list().find((x) => x.sessionId === s.sid);
    if (t && (t.state === "done" || t.state === "failed")) return { state: t.state, result: String(t.result ?? ""), app };
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("任务未在时限内终态");
}

describe("收尾硬门终态(agent-wiring)", () => {
  it("hard + 只有盘点没有审计 → 先补跑一轮(change.audit.retry),仍不满足则 failed + change.audit.hard-fail", async () => {
    process.env.GENIE_CHANGE_AUDIT = "hard";
    const r = await runScenario({ sid: "cah-hard-1", withManifest: true, withPassedAudit: false });
    expect(r.state).toBe("failed");
    expect(r.result).toContain("未通过全链路审计");
    const evs = r.app.journal.readAll().filter((e) => e.kind === "custom" && e.sessionId === "cah-hard-1");
    const types = evs.map((e) => (e.payload as Payload).type);
    expect(types).toContain("change.audit.retry");
    expect(types).toContain("change.audit.hard-fail");
    const hf = evs.find((e) => (e.payload as Payload).type === "change.audit.hard-fail")!.payload as Payload & { reason: string };
    expect(hf.reason).toContain("未通过全链路审计");
  }, 120_000);

  it("hard + 通过审计且证据齐全、无孤儿 → done,终稿不带未通过标记", async () => {
    process.env.GENIE_CHANGE_AUDIT = "hard";
    const r = await runScenario({ sid: "cah-hard-2", withManifest: true, withPassedAudit: true });
    expect(r.state).toBe("done");
    expect(r.result).not.toContain("未通过全链路审计");
  }, 120_000);

  it("off + 无盘点无审计 → done 且不追加任何审计文案", async () => {
    process.env.GENIE_CHANGE_AUDIT = "off";
    const r = await runScenario({ sid: "cah-off-1", withManifest: false, withPassedAudit: false });
    expect(r.state).toBe("done");
    expect(r.result).not.toContain("未通过全链路审计");
    expect(r.result).not.toContain("验收摘要标记");
  }, 120_000);
});

describe("语义孤儿接入 change.audit", () => {
  it("临时 git 仓:新增导出仅测试引用(nit)+ 无人引用(warning)+ 空 catch(nit)都进回执与 journal", async () => {
    const root = tmpProject({ "src/base.ts": "export const legacyFlag = 1;\n" }, true);
    // 基线之后的新增(未提交):只被测试引用的导出 / 完全无人引用的导出 / 空 catch
    writeFileSync(join(root, "src", "onlytest.ts"), "export function helperOnlyInTest() { return 1; }\n", "utf-8");
    writeFileSync(join(root, "src", "orphan.ts"), "export function neverReferencedAnywhere() { return 2; }\n", "utf-8");
    writeFileSync(join(root, "src", "swallow.ts"), "export function swallowIt() {\n  try { return 1; } catch { }\n}\n", "utf-8");
    writeFileSync(join(root, "src", "onlytest.test.ts"), "import { helperOnlyInTest } from \"./onlytest.js\";\nhelperOnlyInTest();\n", "utf-8");

    const j = fakeJournal();
    const tool = makeChangeSurfaceTool({ journal: j, sessionId: "s1", taskId: "t1", root });
    const out = await tool.execute({
      action: "audit", concept: "legacyFlag",
      resolutions: [
        { file: "src/base.ts", status: "resolved" },
        { file: "src/orphan.ts", status: "resolved" },
        { file: "src/onlytest.ts", status: "resolved" },
        { file: "src/swallow.ts", status: "resolved" },
      ],
      verify: { e2e: [{ command: "echo ok", passed: true }], negatives: [{ assertion: "空 concept 报错", passed: true }] },
    });

    expect(out).toContain("语义孤儿");
    const rec = readChangeAudit(j, "s1", "t1")!;
    expect(rec.orphans).toBeGreaterThan(0);
    const titles = rec.orphanFindings.map((f) => f.title).join(" | ");
    expect(titles).toContain("neverReferencedAnywhere");
    expect(titles).toContain("helperOnlyInTest");
    expect(titles).toContain("空 catch");
    expect(rec.orphanWarnings, "无人引用是 warning 级,必须阻断 hard").toBeGreaterThan(0);
  }, 60_000);

  it("非 git 目录:孤儿检查不可用但不让 audit 失败(记 orphanNote)", async () => {
    const root = tmpProject({ "src/a.ts": "export const legacyFlag = 1;\n" });
    const j = fakeJournal();
    const tool = makeChangeSurfaceTool({ journal: j, sessionId: "s1", taskId: "t1", root });
    const out = await tool.execute({ action: "audit", concept: "legacyFlag", resolutions: [{ file: "src/a.ts", status: "resolved" }] });
    expect(out).toContain("语义孤儿检查不可用");
    const rec = readChangeAudit(j, "s1", "t1")!;
    expect(rec.passed, "孤儿不可用不影响去向审计结论").toBe(true);
    expect(rec.orphans).toBe(0);
    expect(typeof rec.orphanNote).toBe("string");
  }, 60_000);
});
