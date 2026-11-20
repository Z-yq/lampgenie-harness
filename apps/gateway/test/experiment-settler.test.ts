/**
 * #192 实验自动结算器单测:
 * - collectTipMarkerSessions:标记 needle 命中/mtime 窗口过滤/文件名即 sessionId/缺目录码;
 * - loadSessionStats:多项目多日文件聚合、同会话取 generatedAt 新者、坏文件跳过;
 * - settleExperiments:满样本 → 写回 result 指标 + decision=iterate(建议进 reason,不自动 adopt);
 * 样本不足 → waiting 不写;幂等(已有 result 跳过);非 tip 面/已决实验不碰。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTipMarkerSessions, drainCandidateQueue, loadSessionStats, settleExperiments } from "../src/experiment-settler.js";
import { getExperiment, recordExperiment } from "../src/experiment-store.js";
import { readQueue } from "../src/nightly-store.js";
import { EXPERIMENT_SCHEMA_VERSION } from "@lampgenie/runtime/agent/experiment-ledger";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "exp-settler-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeJournalSession(journalDir: string, sid: string, lines: string[], mtimeMs?: number): void {
  mkdirSync(join(journalDir, "sessions"), { recursive: true });
  const p = join(journalDir, "sessions", `${sid}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  if (mtimeMs !== undefined) utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
}

function writeStats(project: string, date: string, generatedAt: string, sessions: Array<Record<string, unknown>>): void {
  const dir = join(root, ".genie", "rsi", "nightly", project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${date}.session-stats.json`), JSON.stringify({ generatedAt, runId: "r", projectId: project, date, sessions, skipped: 0, unprocessed: 0 }));
}

function seedExperiment(id: string, minSample: number, createdAt: number): void {
  const res = recordExperiment(root, {
    id,
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    hypothesis: { claim: "重复读取提示可降低重复读取组数 ≥30%。", mechanism: "工具执行面拦截已知重复组合。", expectedEffect: "重复读取组数下降 ≥30%。" },
    intervention: { surface: "tip", ref: "repeated-reads", variant: "test-variant" },
    guardrails: [{ metric: "failed-steps", maxRegressionPct: 5 }],
    canary: { scope: "percent", percent: 100, status: "running" },
    strata: [{ projectId: "p1", taskClass: "coding" }],
    metrics: [
      {
        name: "repeated-read-groups",
        unit: "ratio",
        kind: "rate",
        direction: "decrease",
        baseline: { value: 0.5, sample: 10 },
        thresholds: { minSample: minSample, minEffectPct: 30 },
      },
      {
        name: "failed-steps",
        unit: "ratio",
        kind: "rate", // rate 口径:二项 se 可算——mean 口径缺 stddev 时 z 检验恒拒(EXP_NOT_SIGNIFICANT)
        direction: "decrease",
        baseline: { value: 0.5, sample: 10 },
        thresholds: { minSample: minSample, minEffectPct: 0, minZ: 0 },
      },
    ],
    rollbackPoint: { kind: "config", ref: "tip-off" },
    decision: { kind: "pending" },
    createdAt,
    updatedAt: createdAt,
  });
  expect(res.ok, `seed ${id} 失败: ${res.code ?? ""}`).toBe(true);
}

describe("collectTipMarkerSessions", () => {
  it("命中标记+ref 的会话计入(mtime 窗口外排除;文件名即 sessionId)", () => {
    const journalDir = join(root, "journals");
    const now = Date.now();
    writeJournalSession(journalDir, "t1", [JSON.stringify({ kind: "custom", sessionId: "t1", payload: { type: "rsi.tip.shown", ref: "repeated-reads" } })]);
    writeJournalSession(journalDir, "t2", [JSON.stringify({ kind: "custom", sessionId: "t2", payload: { type: "rsi.tip.shown", ref: "other-tip" } })]);
    writeJournalSession(journalDir, "c1", [JSON.stringify({ kind: "custom", sessionId: "c1", payload: { type: "gene.brief.shown" } })]);
    writeJournalSession(journalDir, "old", [JSON.stringify({ kind: "custom", sessionId: "old", payload: { type: "rsi.tip.shown", ref: "repeated-reads" } })], now - 10_000);
    const r = collectTipMarkerSessions(journalDir, "repeated-reads", now - 1_000);
    expect([...r.shown].sort()).toEqual(["t1"]);
    expect(r.filesScanned).toBeGreaterThanOrEqual(1);
    expect(r.codes).toEqual([]);
  });

  it("缺 sessions 目录 → SETTLER_NO_JOURNAL_DIR 空集不 throw", () => {
    const r = collectTipMarkerSessions(join(root, "nope"), "repeated-reads", 0);
    expect(r.shown.size).toBe(0);
    expect(r.codes).toContain("SETTLER_NO_JOURNAL_DIR");
  });
});

describe("loadSessionStats", () => {
  it("跨项目聚合,同会话多日取 generatedAt 新者", () => {
    writeStats("p1", "2026-11-15", "2026-11-15T01:00:00Z", [{ sessionId: "s1", repeatedReads: 9, failedSteps: 1 }]);
    writeStats("p1", "2026-11-16", "2026-11-16T01:00:00Z", [{ sessionId: "s1", repeatedReads: 2, failedSteps: 0 }, { sessionId: "s2", repeatedReads: 0 }]);
    writeStats("p2", "2026-11-16", "2026-11-16T02:00:00Z", [{ sessionId: "s3", repeatedReads: 4 }]);
    const { bySession } = loadSessionStats(root);
    expect(bySession.get("s1")).toMatchObject({ repeatedReads: 2 });
    expect(bySession.get("s2")).toMatchObject({ repeatedReads: 0 });
    expect(bySession.get("s3")).toMatchObject({ repeatedReads: 4 });
  });

  it("坏 JSON 文件跳过不 throw(fail-soft)", () => {
    const dir = join(root, ".genie", "rsi", "nightly", "p1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.session-stats.json"), "{not json");
    writeStats("p1", "2026-11-16", "2026-11-16T01:00:00Z", [{ sessionId: "s1", repeatedReads: 1 }]);
    const { bySession } = loadSessionStats(root);
    expect(bySession.has("s1")).toBe(true);
  });
});

describe("settleExperiments", () => {
  it("满样本:写回 result + decision=iterate(reason 含建议,不自动 adopt)", async () => {
    const journalDir = join(root, "journals");
    const at = Date.now() - 60_000;
    writeJournalSession(journalDir, "t1", [JSON.stringify({ kind: "custom", sessionId: "t1", payload: { type: "rsi.tip.shown", ref: "repeated-reads" } })]);
    writeJournalSession(journalDir, "t2", [JSON.stringify({ kind: "custom", sessionId: "t2", payload: { type: "rsi.tip.shown", ref: "repeated-reads" } })]);
    writeStats("p1", "2026-11-16", "2026-11-16T01:00:00Z", [
      { sessionId: "t1", repeatedReads: 0, failedSteps: 1 },
      { sessionId: "t2", repeatedReads: 0, failedSteps: 1 },
      { sessionId: "c1", repeatedReads: 3, failedSteps: 1 },
      { sessionId: "c2", repeatedReads: 1, failedSteps: 1 },
    ]);
    seedExperiment("exp-settle-test-1", 2, at);
    const summary = await settleExperiments(root, { journalDir });
    expect(summary.waiting).toEqual([]);
    expect(summary.settled).toHaveLength(1);
    const out = summary.settled[0]!;
    expect(out.action).toBe("written");
    expect(out.nTreatment).toBe(2);
    expect(out.treatmentRate).toBe(0);
    expect(out.effectPct).toBe(100); // 0% vs 100% 对照
    const after = getExperiment(root, "exp-settle-test-1");
    expect(after?.decision.kind).toBe("iterate");
    expect(after?.metrics[0]?.result).toMatchObject({ sample: 2 });
    expect(after?.decision.reason ?? "").toContain("rsi-settler");
    expect(after?.decision.reason ?? "").toContain("建议 adopt");
    expect(after?.decision.reason ?? "").toContain("机器闸未达标"); // §14.2①:legacyMixed 对照拒自动生效
  });

  it("§14.2① 机器闸三条件达标(同资格对照)→ decision=adopt by=rsi-auto-gate + active + 基线快照", async () => {
    const journalDir = join(root, "journals");
    const at = Date.now() - 60_000;
 // 20+20 同资格样本:runtime 台账另有 minZ=1.96 显著性门(两比例 z 检验),样本过小会
 // EXP_NOT_SIGNIFICANT——机器闸 c1 用实验自带 minSample,runtime 门是更严的第二道。
    const stats: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 20; i++) {
      writeJournalSession(journalDir, `t${i}`, [JSON.stringify({ kind: "custom", sessionId: `t${i}`, payload: { type: "rsi.tip.shown", ref: "repeated-reads" } })]);
      stats.push({ sessionId: `t${i}`, repeatedReads: i === 1 ? 1 : 0, failedSteps: i <= 3 ? 1 : 0 }); // 失败率 3/20=0.15<baseline 0.5(direction=decrease 才不回归);1/20 非零防 se=0
    }
    for (let i = 1; i <= 20; i++) {
      writeJournalSession(journalDir, `c${i}`, [JSON.stringify({ kind: "custom", sessionId: `c${i}`, payload: { type: "rsi.tip.withheld", ref: "repeated-reads" } })]);
      stats.push({ sessionId: `c${i}`, repeatedReads: 2, failedSteps: 1 });
    }
    writeStats("p1", "2026-11-16", "2026-11-16T01:00:00Z", stats);
    seedExperiment("exp-autoadopt-1", 2, at);
    const summary = await settleExperiments(root, { journalDir });
    const out = summary.settled[0]!;
    expect(out.action).toBe("adopt");
    const after = getExperiment(root, "exp-autoadopt-1");
    expect(after?.decision.kind).toBe("adopt");
    expect(after?.decision.by).toBe("rsi-auto-gate");
 // a2:active-interventions 写入(100% 生效)
    const active = JSON.parse(readFileSync(join(root, ".genie", "rsi", "active-interventions.json"), "utf8")) as string[];
    expect(active).toContain("repeated-reads");
 // a1:breaker.jsonl 落 baseline 行(回滚基准快照)
    const breakerLines = readFileSync(join(root, ".genie", "rsi", "breaker.jsonl"), "utf8");
    expect(breakerLines).toContain("\"type\":\"baseline\"");
    expect(breakerLines).toContain("adopt-exp-autoadopt-1");
  });

  it("样本不足:waiting 不写决策", async () => {
    const journalDir = join(root, "journals");
    writeJournalSession(journalDir, "t1", [JSON.stringify({ kind: "custom", sessionId: "t1", payload: { type: "rsi.tip.shown", ref: "repeated-reads" } })]);
    writeStats("p1", "2026-11-16", "2026-11-16T01:00:00Z", [{ sessionId: "t1", repeatedReads: 0 }, { sessionId: "c1", repeatedReads: 1 }]);
    seedExperiment("exp-settle-test-2", 5, Date.now() - 60_000);
    const summary = await settleExperiments(root, { journalDir });
    expect(summary.settled).toEqual([]);
    expect(summary.waiting).toEqual([{ id: "exp-settle-test-2", nTreatment: 1, minSample: 5 }]);
    expect(getExperiment(root, "exp-settle-test-2")?.decision.kind).toBe("pending");
  });

  it("幂等:已有 result 的实验不再结算", async () => {
    const journalDir = join(root, "journals");
    writeJournalSession(journalDir, "t1", [JSON.stringify({ kind: "custom", sessionId: "t1", payload: { type: "rsi.tip.shown", ref: "repeated-reads" } })]);
    writeStats("p1", "2026-11-16", "2026-11-16T01:00:00Z", [{ sessionId: "t1", repeatedReads: 0 }]);
    seedExperiment("exp-settle-test-3", 1, Date.now() - 60_000);
    await settleExperiments(root, { journalDir });
    const again = await settleExperiments(root, { journalDir });
    expect(again.settled).toEqual([]);
    expect(again.waiting).toEqual([]);
  });
});

describe("drainCandidateQueue(P0-2)", () => {
  function writeQueueLine(candidate: Record<string, unknown>): void {
    const dir = join(root, ".genie", "rsi", "nightly");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "queue.jsonl"), JSON.stringify({ queuedAt: "2026-11-17T00:00:00Z", runId: "ngt-p1-2026-11-17", projectId: "p1", date: "2026-11-17", candidate }) + "\n", { flag: "a" });
  }

  it("已有同 ref 实验的候选 → 只标消费不重复登记(打断连排)", () => {
    seedExperiment("exp-dup-ref", 30, Date.now() - 60_000); // intervention.ref=repeated-reads
    writeQueueLine({ id: "cand-tip-repeated-reads", kind: "tip", ref: "repeated-reads", reason: "重复读取候选(测试)", evidenceRefs: ["s1"] });
    const r = drainCandidateQueue(root);
    expect(r.recorded).toEqual([]);
    expect(r.markedConsumed).toContain("cand-tip-repeated-reads");
    expect(readQueue(root).find((l) => (l as { candidate?: { id?: string } }).candidate?.id === "cand-tip-repeated-reads")).toMatchObject({ consumedAt: expect.any(String) });
  });

  it("有指标映射的新候选 → 从 session-stats 算诚实基线登记实验并标消费", () => {
    writeStats("p1", "2026-11-17", "2026-11-17T01:00:00Z", [
      { sessionId: "a", failedSteps: 3 }, { sessionId: "b", failedSteps: 0 }, { sessionId: "c", failedSteps: 0 },
    ]);
    writeQueueLine({ id: "cand-tool-failed-steps", kind: "tool", ref: "failed-steps", reason: "工具失败:1/3 会话失败 ≥2 次", evidenceRefs: ["a"] });
    const r = drainCandidateQueue(root);
    expect(r.leftQueued).toContain("cand-tool-failed-steps"); // 修5:failed-steps 已移除,留队
    const exp = getExperiment(root, "exp-cand-failed-steps");
    expect(exp).toBeUndefined(); // 不再自动登记(修5:基线虚高+无注入位)
  });

  it("翻译不了的候选(gate 类)诚实留队,不伪造基线", () => {
    writeQueueLine({ id: "cand-gate-unresolved-asks", kind: "gate", ref: "unresolved-asks", reason: "悬空提问候选(测试)", evidenceRefs: [] });
    const r = drainCandidateQueue(root);
    expect(r.leftQueued).toContain("cand-gate-unresolved-asks");
    expect(r.recorded).toEqual([]);
  });
});

describe("P5(2026-11-17) 同资格对照(withheld)", () => {
  it("withheld 标记会话进对照组;shown 进处理组;两组外会话不计入(不再用其余全体)", async () => {
    const journalDir = join(root, "journals");
    const at = Date.now() - 60_000;
    const mk = (sid: string, type: "rsi.tip.shown" | "rsi.tip.withheld") =>
      writeJournalSession(journalDir, sid, [JSON.stringify({ kind: "custom", sessionId: sid, payload: { type, ref: "repeated-reads" } })]);
    mk("t1", "rsi.tip.shown");
    mk("t2", "rsi.tip.shown");
    mk("w1", "rsi.tip.withheld");
    mk("w2", "rsi.tip.withheld");
    mk("w3", "rsi.tip.withheld");
    writeStats("p1", "2026-11-17", "2026-11-17T01:00:00Z", [
      { sessionId: "t1", repeatedReads: 0, failedSteps: 1 },
      { sessionId: "t2", repeatedReads: 0, failedSteps: 1 },
      { sessionId: "w1", repeatedReads: 1, failedSteps: 1 },
      { sessionId: "w2", repeatedReads: 0, failedSteps: 1 },
      { sessionId: "w3", repeatedReads: 0, failedSteps: 1 },
      { sessionId: "bystander", repeatedReads: 5, failedSteps: 9 },
    ]);
    seedExperiment("exp-p5-test", 2, at);
    const r = await settleExperiments(root, { journalDir });
    expect(r.settled).toHaveLength(1);
    const out = r.settled[0]!;
    expect(out.nTreatment).toBe(2);
    expect(out.nControl).toBe(3); // 只含 withheld,不含 bystander(旧口径会把 bystander 计入对照)
    expect(out.treatmentRate).toBe(0);
    expect(out.controlRate).toBeCloseTo(1 / 3, 4);
    const after = getExperiment(root, "exp-p5-test");
    expect(after?.decision.reason ?? "").not.toContain("回退旧口径");
  });
});
