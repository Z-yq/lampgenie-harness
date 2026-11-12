/**
 * RSI 机制治理面接线测试( RSI-MECH):
 * ①runner:未知机制/已关闭/code 驱动/重复运行/派发失败 五类都回结构化 reason,不 throw;
 * 成功路径 submit 恰调 1 次(kind=system),任务书含机制标题与结果文件路径;
 * ②annotate:开关/驱动/结果条目/运行态注入 12 区,运行中任务已终态时就地收尾;
 * ③源码接线:server.ts 四条 case、client-capabilities 四条通道、panel.ts 交互节点。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotateRsiSections, startMechanismRun } from "../src/rsi-agent-runner.js";
import {
  finishRun,
  getRun,
  listRuns,
  resultFilePath,
  setMechanism,
} from "../src/rsi-mechanism-store.js";
import { analyzedSessionsPath, loadAnalyzedIds } from "../src/rsi-sessions.js";
import type { RsiStatusSection } from "../src/rsi-status.js";
import { PANEL_SRC as src } from "./panel-source.js";

const SRC = join(process.cwd(), "src");

function section(id: string, title: string): RsiStatusSection {
  return { id, title, ok: true, metrics: [{ label: "候选", value: 1 }], warnings: [] };
}

describe("startMechanismRun", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rsi-runner-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("未知机制:SUBMIT 不调用,回 UNKNOWN_MECHANISM", async () => {
    const calls: string[] = [];
    const r = await startMechanismRun({ root, submit: () => (calls.push("x"), { id: "t" }) }, "nope");
    expect(r).toMatchObject({ ok: false, reason: "UNKNOWN_MECHANISM" });
    expect(calls).toEqual([]);
  });

  it("机制已关闭:回 MECHANISM_DISABLED 且不派任务", async () => {
    await setMechanism(root, "nightly", { enabled: false }, "test");
    const calls: string[] = [];
    const r = await startMechanismRun({ root, submit: () => (calls.push("x"), { id: "t" }) }, "nightly");
    expect(r).toMatchObject({ ok: false, reason: "MECHANISM_DISABLED" });
    expect(calls).toEqual([]);
  });

  it("code 驱动:回 CODE_DRIVER_CLI_ONLY 且不派任务", async () => {
    await setMechanism(root, "cost", { driver: "code" }, "test");
    const calls: string[] = [];
    const r = await startMechanismRun({ root, submit: () => (calls.push("x"), { id: "t" }) }, "cost");
    expect(r).toMatchObject({ ok: false, reason: "CODE_DRIVER_CLI_ONLY" });
    expect(calls).toEqual([]);
  });

  it("成功:submit 恰调 1 次(system 独立池),固定会话 rsi,任务书含机制标题与结果路径,运行记录落盘", async () => {
    const sent: { kind: string; sid: string; instruction: string; title?: string }[] = [];
    const r = await startMechanismRun(
      {
        root,
        submit: (kind, sid, instruction, extra) => {
          sent.push({ kind, sid, instruction, title: extra?.title });
          return { id: "task-1" };
        },
      },
      "pathology",
    );
    expect(r).toMatchObject({ ok: true, id: "pathology", taskId: "task-1", sessionId: "rsi" });
    expect(sent).toHaveLength(1);
 // kind=system:走独立系统池,避免被用户会话 maxConcurrent 挤成永久排队(经验证)
    expect(sent[0]!.kind).toBe("system");
    expect(sent[0]!.sid).toBe("rsi");
    expect(sent[0]!.instruction).toContain("病理目录");
    expect(sent[0]!.instruction).toContain("最终回复");
    expect(sent[0]!.instruction).toContain(resultFilePath(root, "pathology", r.runId!));
    const runs = await listRuns(root, "pathology");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: r.runId, status: "running", taskId: "task-1", sessionId: "rsi" });
  });

  it("两次运行进同一个固定会话,runId 各不同", async () => {
    const sids: string[] = [];
    const submit = (_kind: string, sid: string) => {
      sids.push(sid);
      return { id: `t-${sids.length}` };
    };
    const first = await startMechanismRun({ root, submit: submit as never }, "pathology");
    await finishRun(root, "pathology", first.runId!, "done");
    const second = await startMechanismRun({ root, submit: submit as never }, "cohort");
    expect(second.ok).toBe(true);
    expect(sids).toEqual(["rsi", "rsi"]);
    expect(second.runId).not.toBe(first.runId);
  });

  it("全局单跑:机制 A 运行中时机制 B 被拒 RUNNING_ALREADY", async () => {
    const a = await startMechanismRun({ root, submit: () => ({ id: "t-a" }) }, "atlas");
    expect(a.ok).toBe(true);
    const b = await startMechanismRun({ root, submit: () => ({ id: "t-b" }) }, "cohort");
    expect(b).toMatchObject({ ok: false, reason: "RUNNING_ALREADY", runId: a.runId });
  });

  it("已有运行中记录:回 RUNNING_ALREADY,不重复派发", async () => {
    const submit = (): { id: string } => ({ id: "task-1" });
    const first = await startMechanismRun({ root, submit }, "evidence");
    expect(first.ok).toBe(true);
    const second = await startMechanismRun({ root, submit }, "evidence");
    expect(second).toMatchObject({ ok: false, reason: "RUNNING_ALREADY" });
  });

  it("submit 抛错:回 SUBMIT_FAILED 且留一条 failed 运行记录", async () => {
    const r = await startMechanismRun(
      {
        root,
        submit: () => {
          throw new Error("model not configured");
        },
      },
      "cohort",
    );
    expect(r).toMatchObject({ ok: false, reason: "SUBMIT_FAILED" });
    const runs = await listRuns(root, "cohort");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", error: "model not configured" });
  });
});

describe("annotateRsiSections", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rsi-annotate-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("注入开关/驱动/结果条目/运行态;未知分区原样透传", async () => {
    await setMechanism(root, "tools", { enabled: false, driver: "code" }, "test");
    const submitted = await startMechanismRun({ root, submit: () => ({ id: "t-9" }) }, "nightly");
    expect(submitted.ok).toBe(true);
 // 模拟 agent 写回结果文件
    const p = resultFilePath(root, "nightly", submitted.runId!);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, JSON.stringify({ items: [{ id: "cand-1", title: "重复读取", summary: "19 个会话", status: "warn" }] }), "utf8");

    const res = await annotateRsiSections({
      root,
      sections: [section("nightly", "夜间任务"), section("tools", "数据工具"), section("legacy", "老分区")],
    });
    expect(res.sections).toHaveLength(3);
    const nightly = res.sections[0]!;
    expect(nightly.enabled).toBe(true);
    expect(nightly.driver).toBe("agent");
    expect(nightly.items).toHaveLength(1);
    expect(nightly.items![0]).toMatchObject({ id: `${submitted.runId}:cand-1`, title: "重复读取" });
    expect(nightly.run).toMatchObject({ runId: submitted.runId, status: "running" });
    const tools = res.sections[1]!;
    expect(tools.enabled).toBe(false);
    expect(tools.driver).toBe("code");
    const legacy = res.sections[2]!;
    expect(legacy.enabled).toBeUndefined();
    expect(legacy.items).toBeUndefined();
  });

  it("运行中任务已终态:就地收尾为 done,finalized 计数 +1", async () => {
    const r = await startMechanismRun({ root, submit: () => ({ id: "t-1" }) }, "atlas");
    expect(r.ok).toBe(true);
    const res = await annotateRsiSections({
      root,
      sections: [section("atlas", "方向图")],
      taskState: (taskId) => (taskId === "t-1" ? "done" : undefined),
    });
    expect(res.finalized).toBe(1);
    expect(res.sections[0]!.run).toMatchObject({ status: "done" });
    const runs = await listRuns(root, "atlas");
    expect(runs[0]!.status).toBe("done");
  });

  it("单区读取失败 fail-open:该区保留并追加 warning,不抛", async () => {
    const res = await annotateRsiSections({
      root,
      sections: [{ ...section("nightly", "夜间任务"), metrics: undefined as never, warnings: undefined as never }],
    });
    expect(res.sections).toHaveLength(1);
    expect(Array.isArray(res.sections[0]!.metrics)).toBe(true);
    expect(Array.isArray(res.sections[0]!.warnings)).toBe(true);
  });
});

describe("源码接线", () => {
  it("server.ts 四条 case 在场且走 safeSend", async () => {
    const src = await readFile(join(SRC, "server.ts"), "utf8");
    for (const type of ["rsi.mechanism.set", "rsi.mechanism.run", "rsi.item.update", "rsi.item.delete"]) {
      expect(src).toContain(`case "${type}"`);
    }
    expect(src).toContain("annotateRsiSections(");
    expect(src).toContain("startMechanismRun(");
  });
  it("client-capabilities 四条新通道进 PANEL_CHANNELS", async () => {
    const src = await readFile(join(SRC, "client-capabilities.ts"), "utf8");
    for (const ch of ["rsi.mechanism.set", "rsi.mechanism.run", "rsi.item.update", "rsi.item.delete"]) {
      expect(src).toContain(`"${ch}"`);
    }
  });
  it("panel.ts 有开关/驱动/运行/结果节点与三条回包分支", async () => {
        for (const key of ["rsi-sw", "rsi-drv", "rsi-run", "rsi-items", "rsi.item.result", "rsi.mechanism.set.result", "rsi.mechanism.run.result"]) {
      expect(src).toContain(key);
    }
 // RSI-SESSION-COST:成本/分析节点在场(卡片体小块 + 两行运行头)。
    for (const key of ["rsiCostLine", "data-run-cost", "data-run-analysis", "rsiCostBody(", "rsiCostHead(", "rsiAnalysisHead("]) {
      expect(src).toContain(key);
    }
  });
});

describe("会话候选注入 + 运行成本/认账(RSI-SESSION-COST)", () => {
  let root = "";
  let journalDir = "";
  const NOW = Date.now();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rsi-cost-root-"));
    journalDir = await mkdtemp(join(tmpdir(), "rsi-cost-journal-"));
    await mkdir(join(journalDir, "sessions"), { recursive: true });
    const file = join(journalDir, "sessions", "web-1.jsonl");
    await writeFile(file, '{"kind":"message.user","payload":{}}\n', "utf8");
    await utimes(file, NOW / 1000, NOW / 1000);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(journalDir, { recursive: true, force: true });
  });

  function costDeps(readSession: (sid: string) => unknown[]) {
    return {
      root,
      journalDir,
      projectOf: (sid: string) => (sid === "web-1" ? "__harness__" : undefined),
      readSession,
    };
  }

  it("派单 brief 注入候选清单,run 记录落 analysis.candidates", async () => {
    const instructions: string[] = [];
    const r = await startMechanismRun(
      {
        ...costDeps(() => []),
        submit: (_kind, _sid, instruction) => {
          instructions.push(instruction);
          return { id: "t-cost-1" };
        },
      },
      "nightly",
    );
    expect(r.ok).toBe(true);
    expect(instructions[0]).toContain("待分析会话(近 3 日 · 所有项目 · 未分析过)");
    expect(instructions[0]).toContain("web-1");
    expect(instructions[0]).toContain("项目 __harness__");
    expect(instructions[0]).toContain("已分析会话:");
    const run = await getRun(root, "nightly", r.runId!);
    expect(run?.analysis).toMatchObject({
      windowDays: 3,
      candidates: [{ sessionId: "web-1", projectId: "__harness__" }],
      analyzed: [],
    });
  });

  it("收尾:按 taskId 切窗口算成本(单价命中=真金),认账只收候选内会话并写账本", async () => {
    const started = await startMechanismRun({ ...costDeps(() => []), submit: () => ({ id: "t-cost-2" }) }, "nightly");
    expect(started.ok).toBe(true);
 // task.start 落在派单之前也无妨(窗口按 taskId 匹配);这里模拟 agent 真实事件流。
    const events = [
      { kind: "task.start", payload: { id: "t-cost-2" } },
      { kind: "llm.trace", payload: { model: "deepseek-flash", usage: { inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0 } } },
      { kind: "message.agent", payload: { text: "结论…\n已分析会话: web-1, web-hallucinated" } },
      { kind: "task.done", payload: { id: "t-cost-2" } },
    ];
    const res = await annotateRsiSections({
      root,
      sections: [section("nightly", "夜间任务")],
      taskState: () => "done",
      readSession: () => events,
    });
    expect(res.finalized).toBe(1);
    const run = await getRun(root, "nightly", started.runId!);
 // deepseek-flash 未命中输入 2 元/百万 → 1M token = 2 元(缓存命中价不在 missing:缓存写入 0 token)。
    expect(run?.cost).toMatchObject({ totalTokens: 1_000_000, amountCny: 2, missing: [], model: "deepseek-flash" });
 // 幻觉 id 不算数,只认候选里的 web-1
    expect(run?.analysis?.analyzed).toEqual([{ sessionId: "web-1", projectId: "__harness__" }]);
    expect(res.sections[0]!.run?.cost).toMatchObject({ amountCny: 2 });
    const ledger = await loadAnalyzedIds(root);
    expect([...ledger]).toEqual(["web-1"]);
 // 再轮询一次:costa 已在 → 不重算、账本不重复追加
    await annotateRsiSections({ root, sections: [section("nightly", "夜间任务")], taskState: () => "done", readSession: () => events });
    const lines = (await readFile(analyzedSessionsPath(root), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("单价缺失:amountCny=null 且 missing 列段,绝不按 0 冒充", async () => {
    const started = await startMechanismRun({ ...costDeps(() => []), submit: () => ({ id: "t-cost-3" }) }, "cohort");
    const events = [
      { kind: "task.start", payload: { id: "t-cost-3" } },
      { kind: "llm.trace", payload: { model: "mystery-model-9000", usage: { inputTokens: 1000, outputTokens: 200 } } },
      { kind: "task.done", payload: { id: "t-cost-3" } },
    ];
    await annotateRsiSections({
      root,
      sections: [section("cohort", "同期群")],
      taskState: () => "done",
      readSession: () => events,
    });
    const run = await getRun(root, "cohort", started.runId!);
    expect(run?.cost?.amountCny).toBeNull();
    expect(run?.cost?.missing).toEqual(["cacheRead", "cacheWrite", "inputMiss", "output"]);
    expect(run?.cost?.totalTokens).toBe(1200);
 // 没有记账行 → analyzed 为空(不认账、不写账本)
    expect(run?.analysis?.analyzed).toEqual([]);
    await expect(readFile(analyzedSessionsPath(root), "utf8")).rejects.toThrow();
  });

  it("不传 journalDir:brief 不插小节,run 无 analysis(旧行为不变)", async () => {
    const instructions: string[] = [];
    const r = await startMechanismRun(
      {
        root,
        submit: (_kind, _sid, instruction) => {
          instructions.push(instruction);
          return { id: "t-cost-4" };
        },
      },
      "nightly",
    );
    expect(r.ok).toBe(true);
    expect(instructions[0]).not.toContain("待分析会话");
    const run = await getRun(root, "nightly", r.runId!);
    expect(run?.analysis).toBeUndefined();
  });
});
