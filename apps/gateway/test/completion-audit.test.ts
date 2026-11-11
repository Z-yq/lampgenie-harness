/**
 *  完成审计(2026-11):把各段收尾机制的事实聚合成一张可判定的记分卡。
 * A. 纯函数:buildCompletionAudit 六行判据 + 渲染噪音控制/长度上限;
 * B. 聚合接线(agent-wiring 实际终态):completion.audit 落一次 / off 不落 / hard 补跑后仍 fail → failed。
 */
import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
import {
  buildCompletionAudit,
  renderCompletionAudit,
  COMPLETION_RENDER_MAX,
  type CompletionFacts,
  type CompletionItem,
  type CompletionItemId,
} from "../src/completion-audit.js";

// ---- A. 纯函数 ----
const base = (over: CompletionFacts = {}): CompletionFacts => ({
  board: { hasBoard: true, p0Total: 3, p0Passed: 3, staleEvidence: 0, hasNegativeAccept: true },
  verify: { stale: false, reason: "ok", writes: 2, verificationCount: 1 },
  deliverables: { declared: 1, missing: 0 },
  change: { scope: "surface", manifest: true, auditPassed: true, verified: true, negativeAssertions: 2 },
  citations: { inScope: true, registered: 2, missing: 0 },
  ledger: { changed: 1, unknown: 0, oversized: 0 },
  ...over,
});

const rowOf = (facts: CompletionFacts, id: CompletionItemId): CompletionItem =>
  buildCompletionAudit(facts).items.find((i) => i.id === id)!;

describe("buildCompletionAudit 判据", () => {
  it("全 pass/na → passed true 且不加噪音(rendered === '')", () => {
    const a = buildCompletionAudit(base({
      board: { hasBoard: false, p0Total: 0, p0Passed: 0, staleEvidence: 0, hasNegativeAccept: true },
      deliverables: { declared: 0, missing: 0 },
      change: { scope: "normal", manifest: false, auditPassed: false, verified: false, negativeAssertions: 0 },
      citations: { inScope: false, registered: 0, missing: 0 },
      ledger: { changed: 0, unknown: 0, oversized: 0 },
    }));
    expect(a.passed).toBe(true);
    expect(a.fails).toBe(0);
    expect(a.rendered).toBe("");
    expect(a.items).toHaveLength(6);
    expect(a.items.every((i) => i.status === "pass" || i.status === "na")).toBe(true);
  });

  it("无 facts 字段 → 六行全 na 且 detail「未采集」", () => {
    const a = buildCompletionAudit({});
    expect(a.items.map((i) => i.status)).toEqual(["na", "na", "na", "na", "na", "na"]);
    expect(a.items.every((i) => i.detail.includes("未采集"))).toBe(true);
    expect(a.passed).toBe(true);
    expect(a.rendered).toBe("");
  });

  it("board:P0 未满 → fail 且点名「P0 3/4 通过」", () => {
    const r = rowOf(base({ board: { hasBoard: true, p0Total: 4, p0Passed: 3, staleEvidence: 0, hasNegativeAccept: true } }), "board");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("P0 3/4 通过");
  });

  it("board:证据过期 → fail 且点名条数", () => {
    const r = rowOf(base({ board: { hasBoard: true, p0Total: 3, p0Passed: 3, staleEvidence: 2, hasNegativeAccept: true } }), "board");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("证据过期 2 条");
  });

  it("board:全绿但无负面断言 → warn(不算 fail)", () => {
    const a = buildCompletionAudit(base({ board: { hasBoard: true, p0Total: 3, p0Passed: 3, staleEvidence: 0, hasNegativeAccept: false } }));
    const r = a.items.find((i) => i.id === "board")!;
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("P0 无负面断言");
    expect(a.passed).toBe(true);
    expect(a.warnings).toBe(1);
  });

  it("board:无板 / 无 P0 → na", () => {
    expect(rowOf(base({ board: undefined }), "board").status).toBe("na");
    const r = rowOf(base({ board: { hasBoard: true, p0Total: 0, p0Passed: 0, staleEvidence: 0, hasNegativeAccept: true } }), "board");
    expect(r.status).toBe("na");
  });

  it("deliverable:缺失 >0 → fail 且点名数量", () => {
    const a = buildCompletionAudit(base({ deliverables: { declared: 2, missing: 1 } }));
    const r = a.items.find((i) => i.id === "deliverable")!;
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("缺失 1 项");
    expect(a.passed).toBe(false);
  });

  it("change:surface 缺盘点 / 未跑审计 / 验收证据未全通过 → 三个 fail 各点名缺项", () => {
    const noManifest = rowOf(base({ change: { scope: "surface", manifest: false, auditPassed: false, verified: false, negativeAssertions: 0 } }), "change");
    expect(noManifest.status).toBe("fail");
    expect(noManifest.detail).toContain("缺盘点");
    const noAudit = rowOf(base({ change: { scope: "surface", manifest: true, auditPassed: false, verified: true, negativeAssertions: 1 } }), "change");
    expect(noAudit.status).toBe("fail");
    expect(noAudit.detail).toContain("审计");
    const noVerify = rowOf(base({ change: { scope: "surface", manifest: true, auditPassed: true, verified: false, negativeAssertions: 1 } }), "change");
    expect(noVerify.status).toBe("fail");
    expect(noVerify.detail).toContain("验收证据未全通过");
  });

  it("change:无负面断言但其它全真 → warn 且 passed 仍 true", () => {
    const a = buildCompletionAudit(base({ change: { scope: "surface", manifest: true, auditPassed: true, verified: true, negativeAssertions: 0 } }));
    const r = a.items.find((i) => i.id === "change")!;
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("无负面断言");
    expect(a.passed).toBe(true);
  });

  it("change:scope=normal → na", () => {
    expect(rowOf(base({ change: { scope: "normal", manifest: true, auditPassed: true, verified: true, negativeAssertions: 3 } }), "change").status).toBe("na");
  });

  it("citation:正文缺登记 → fail;有登记且齐全 → pass;不在作用域 → na", () => {
    const bad = rowOf(base({ citations: { inScope: true, registered: 2, missing: 1 } }), "citation");
    expect(bad.status).toBe("fail");
    expect(bad.detail).toContain("缺登记 1 处");
    expect(rowOf(base({ citations: { inScope: true, registered: 2, missing: 0 } }), "citation").status).toBe("pass");
    expect(rowOf(base({ citations: { inScope: false, registered: 5, missing: 3 } }), "citation").status).toBe("na");
  });

  it("verify:两种 stale 文案 + 无代码写 → na", () => {
    const noVerification = rowOf(base({ verify: { stale: true, reason: "no-verification", writes: 3, verificationCount: 0 } }), "verify");
    expect(noVerification.status).toBe("warn");
    expect(noVerification.detail).toContain("改了 3 个代码文件但无验证记录");
    const after = rowOf(base({ verify: { stale: true, reason: "writes-after-verification", writes: 2, verificationCount: 1 } }), "verify");
    expect(after.status).toBe("warn");
    expect(after.detail).toContain("最近一次验证后又改了 2 个文件");
    expect(rowOf(base({ verify: { stale: true, reason: "no-verification", writes: 0, verificationCount: 0 } }), "verify").status).toBe("na");
  });

  it("change-ledger:unknown/oversized → warn(永不 fail);全 0 → na;只有 changed → pass", () => {
    const u = rowOf(base({ ledger: { changed: 1, unknown: 2, oversized: 0 } }), "change-ledger");
    expect(u.status).toBe("warn");
    expect(u.detail).toContain("未跟踪 2 个");
    const o = rowOf(base({ ledger: { changed: 0, unknown: 0, oversized: 1 } }), "change-ledger");
    expect(o.status).toBe("warn");
    expect(o.detail).toContain("超大 1 个");
    expect(rowOf(base({ ledger: { changed: 0, unknown: 0, oversized: 0 } }), "change-ledger").status).toBe("na");
    expect(rowOf(base({ ledger: { changed: 4, unknown: 0, oversized: 0 } }), "change-ledger").status).toBe("pass");
  });

  it("多 fail 场景:逐项断言 + 汇总数字 + 渲染含汇总行", () => {
    const a = buildCompletionAudit({
      board: { hasBoard: true, p0Total: 4, p0Passed: 3, staleEvidence: 1, hasNegativeAccept: true },
      verify: { stale: true, reason: "writes-after-verification", writes: 1, verificationCount: 1 },
      deliverables: { declared: 2, missing: 1 },
      change: { scope: "normal", manifest: false, auditPassed: false, verified: false, negativeAssertions: 0 },
      citations: { inScope: false, registered: 0, missing: 0 },
      ledger: { changed: 0, unknown: 0, oversized: 0 },
    });
    expect(a.items.map((i) => i.id)).toEqual(["board", "verify", "deliverable", "change", "citation", "change-ledger"]);
    expect(a.items.map((i) => i.status)).toEqual(["fail", "warn", "fail", "na", "na", "na"]);
    expect(a.items[0]!.detail).toContain("P0 3/4 通过");
    expect(a.items[0]!.detail).toContain("证据过期 1 条");
    expect(a.items[1]!.detail).toContain("最近一次验证后又改了");
    expect(a.items[2]!.detail).toContain("声明 2 项,缺失 1 项");
    expect(a.items[4]!.detail).toContain("本任务不适用");
    expect(a.passed).toBe(false);
    expect(a.warnings).toBe(1);
    expect(a.fails).toBe(2);
    expect(a.rendered).toContain("通过 0 / 警告 1 / 失败 2");
    expect(a.rendered.startsWith("## 完成审计")).toBe(true);
  });

  it("图标签:pass=✅ warn=⚠ fail=❌ na=–", () => {
    const items: CompletionItem[] = [
      { id: "board", status: "pass", label: "白板 P0", detail: "P0 3/3 通过" },
      { id: "verify", status: "warn", label: "验证账本", detail: "x" },
      { id: "deliverable", status: "fail", label: "交付物", detail: "y" },
      { id: "citation", status: "na", label: "引用账本", detail: "本任务不适用" },
    ];
    const out = renderCompletionAudit(items);
    expect(out).toContain("✅ 白板 P0:P0 3/3 通过");
    expect(out).toContain("⚠ 验证账本:x");
    expect(out).toContain("❌ 交付物:y");
    expect(out).toContain("– 引用账本:本任务不适用");
    expect(renderCompletionAudit([{ id: "board", status: "pass", label: "白板 P0", detail: "x" }])).toBe("");
  });

  it("超长 detail:总长 ≤ COMPLETION_RENDER_MAX 且保留汇总行 + 省略提示", () => {
    const big = "很长的证据说明".repeat(60); // 每行 detail 远超 200 字(截断后仍远超每行预算)
    const items: CompletionItem[] = [
      { id: "board", status: "fail", label: "白板 P0", detail: big },
      { id: "verify", status: "warn", label: "验证账本", detail: big },
      { id: "deliverable", status: "fail", label: "交付物", detail: big },
      { id: "change", status: "pass", label: "全链路审计", detail: big },
      { id: "citation", status: "pass", label: "引用账本", detail: big },
      { id: "change-ledger", status: "warn", label: "变更账本", detail: big },
    ];
    // 未截断的原始文本远超上限,确保「丢行」路径真的会被走到。
    const untruncated = "## 完成审计\n" + items.map((i) => `${i.label}:${big}`).join("\n");
    expect(untruncated.length).toBeGreaterThan(COMPLETION_RENDER_MAX);
    const out = renderCompletionAudit(items);
    expect(out.length).toBeLessThanOrEqual(COMPLETION_RENDER_MAX);
    expect(out).toContain("通过 2 / 警告 2 / 失败 2");
    expect(out).toContain("…(省略 ");
    expect(out.startsWith("## 完成审计")).toBe(true);
    // detail 超 200 字先截断:任何单行都不会把 200 字以上的原文照搬进来。
    expect(Math.max(...out.split("\n").slice(1).map((l) => l.length))).toBeLessThan(260);
  });
});

// ---- B. 聚合接线(agent-wiring) ----
beforeAll(async () => { await acquireEnvLock("completion-audit"); }, 240_000);
afterAll(() => { releaseEnvLock("completion-audit"); });

const gwApps: ReturnType<typeof createGatewayApp>[] = [];
afterEach(async () => {
  for (const a of gwApps.splice(0)) await a.close();
  delete process.env.GENIE_COMPLETION_AUDIT;
});

type App = ReturnType<typeof createGatewayApp>;

const INSTRUCTION = "修一下这个逻辑";

type Append = (e: { kind: string; sessionId: string; payload: Record<string, unknown> }) => void;

interface Scenario {
  sid: string;
  /** 第 0 步在 journal 里落的事件(模拟本任务窗口内已发生的工具动作)。 */
  seed?: (sid: string, append: Append, app: App) => void;
}

async function runScenario(s: Scenario): Promise<{ state: string; result: string; app: App }> {
  let appRef: App;
  let step = 0;
  const app = createGatewayApp({
    port: 0,
    llm: {
      async chat() {
        if (step++ === 0) {
          s.seed?.(s.sid, (e) => { appRef.journal.append(e as never); }, appRef);
          return { content: "终稿" };
        }
        return { content: "终稿" };
      },
    } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  appRef = app;
  gwApps.push(app);
  app.taskManager.submit("user", s.sid, INSTRUCTION);
  for (let k = 0; k < 240; k++) {
    const t = app.taskManager.list().find((x) => x.sessionId === s.sid);
    if (t && (t.state === "done" || t.state === "failed")) return { state: t.state, result: String(t.result ?? ""), app };
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("任务未在时限内终态");
}

/** 一次成功验证 + 之后又改代码 → 验证账本 warn(记分卡有可见行)。 */
const seedVerifiedThenWrite = (sid: string, append: Append) => {
  append({ kind: "tool.call", sessionId: sid, payload: { toolCallId: "t1", name: "terminal", arguments: JSON.stringify({ command: "npx vitest run test/a.test.ts" }) } });
  append({ kind: "tool.result", sessionId: sid, payload: { toolCallId: "t1", content: "3 passed", durationMs: 5 } });
  append({ kind: "tool.call", sessionId: sid, payload: { toolCallId: "w1", name: "edit_file", arguments: JSON.stringify({ path: "apps/gateway/src/late.ts", old_string: "a", new_string: "b" }) } });
};

const audits = (app: App, sid: string) =>
  app.journal.readAll()
    .filter((e) => e.kind === "custom" && e.sessionId === sid && (e.payload as { type?: string }).type === "completion.audit");

const customTypes = (app: App, sid: string): string[] =>
  app.journal.readAll()
    .filter((e) => e.kind === "custom" && e.sessionId === sid)
    .map((e) => String((e.payload as { type?: string }).type ?? ""));

describe("完成审计接线(agent-wiring)", () => {
  it("warn(缺省):done 时落一条 completion.audit 且正文带 ## 完成审计", async () => {
    const r = await runScenario({ sid: "ca-warn-1", seed: seedVerifiedThenWrite });
    expect(r.state).toBe("done");
    expect(r.result).toContain("## 完成审计");
    expect(r.result).toContain("验证账本");
    const list = audits(r.app, "ca-warn-1");
    expect(list).toHaveLength(1);
    const p = list[0]!.payload as Record<string, unknown>;
    expect(typeof p.taskId).toBe("string");
    expect(typeof p.passed).toBe("boolean");
    expect(typeof p.warnings).toBe("number");
    expect(typeof p.fails).toBe("number");
    expect(Array.isArray(p.items)).toBe(true);
    expect((p.items as unknown[]).length).toBe(6);
    expect(p.passed).toBe(true);
    expect(p.fails).toBe(0);
    // 验证账本是确定的 warn;取整条会话的变更账本可能有额外 warn(测试期改文件),故只断言 ≥1。
    expect(Number(p.warnings)).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("off:整段跳过 → 不落 completion.audit、正文无完成审计", async () => {
    process.env.GENIE_COMPLETION_AUDIT = "off";
    const r = await runScenario({ sid: "ca-off-1", seed: seedVerifiedThenWrite });
    expect(r.state).toBe("done");
    expect(r.result).not.toContain("## 完成审计");
    expect(audits(r.app, "ca-off-1")).toHaveLength(0);
  }, 120_000);

  it("hard + 交付物缺失:补跑一轮仍 fail → failed + retry/hard-fail 事件", async () => {
    process.env.GENIE_COMPLETION_AUDIT = "hard";
    const r = await runScenario({
      sid: "ca-hard-1",
      seed: (sid, append, app) => {
        const taskId = app.taskManager.list().find((x) => x.sessionId === sid)?.id ?? "";
        append({
          kind: "custom", sessionId: sid,
          payload: { type: "deliverable.declared", taskId, processPath: "/nonexistent/xx.png", inputPath: "xx.png", size: 1, mtimeMs: 1, at: 1 },
        });
      },
    });
    expect(r.state).toBe("failed");
    expect(r.result).toContain("未通过完成审计");
    const types = customTypes(r.app, "ca-hard-1");
    expect(types).toContain("completion.audit.retry");
    expect(types).toContain("completion.audit.hard-fail");
    const hf = r.app.journal.readAll()
      .find((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "completion.audit.hard-fail")!;
    expect(String((hf.payload as { reason?: string }).reason)).toContain("交付物");
    expect(audits(r.app, "ca-hard-1").length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("干净任务(全 pass/na):正文不追加,但 journal 仍落一条 passed=true", async () => {
    const r = await runScenario({ sid: "ca-clean-1" });
    expect(r.state).toBe("done");
    expect(r.result).not.toContain("## 完成审计");
    const list = audits(r.app, "ca-clean-1");
    expect(list).toHaveLength(1);
    expect((list[0]!.payload as { passed?: boolean }).passed).toBe(true);
  }, 120_000);
});
