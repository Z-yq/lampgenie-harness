/**
 * rsi-weekly(IO 层)用例:全部在 os.tmpdir() 下建临时 root,用真实 store 写接口造数据,
 * 绝不碰仓库 .genie。
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderWeeklyReportText } from "@lampgenie/runtime/agent/rsi-weekly-report";
import {
  WEEKLY_LEDGER_REL,
  aggregateWeekly,
  appendWeeklyEvent,
  correctFromReport,
  lastRemindedAt,
  readWeeklyEvents,
  shouldRemind,
  writeReportFile,
} from "../src/rsi-weekly";
import { addEvidence, history as evidenceHistory } from "../src/evidence-graph-store";
import { listExperiments, recordExperiment } from "../src/experiment-store";
import { pause as pauseBreaker } from "../src/rsi-breaker-store";
import { recordCost, recordSavings } from "../src/rsi-cost-store";
import { requestModification } from "../src/self-modification-store";

const tempDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-rsi-weekly-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** 一条待决的实验(decision 由 record 行的底账直接给定,绕开采纳闸)。 */
function experimentOf(id: string, decision: "adopt" | "reject" | "pending", claim?: string): Record<string, unknown> {
  const now = Date.now();
  return {
    id,
    hypothesis: { claim: claim ?? `周报实验 ${id} 有效`, expectedEffect: "+10%" },
    intervention: { surface: "tip", ref: `tips/${id}.md`, variant: "v2" },
    guardrails: [],
    canary: { scope: "session", sessions: 3, status: "done" },
    strata: [],
    metrics: [
      {
        name: "repeat-read",
        direction: "decrease",
        baseline: { value: 10, sample: 40, stddev: 1 },
        result: { value: 6, sample: 40, stddev: 1 },
        thresholds: { minSample: 30, minEffectPct: 10 },
      },
    ],
    rollbackPoint: { kind: "flag", ref: `flag:${id}` },
    evidence: [`ev-${id}`],
    decision: decision === "pending" ? { kind: "pending" } : { kind: decision, at: now, by: "tester" },
    createdAt: now,
    updatedAt: now,
  };
}

/** 自我修改请求(rsi 作者 → 闸门判 need-approval)。 */
function rsiRequest(id: string): Record<string, unknown> {
  const now = Date.now();
  return {
    id,
    schemaVersion: 1,
    surface: "tip",
    targetRef: "tips/read-file.md",
    variant: "v2",
    summary: "tip 内联文件摘要降低重复读",
    author: { kind: "rsi", id: "rsi-1" },
    evidence: { experimentId: "exp-1", diffSummary: "diff --stat", testsRun: "vitest run tips" },
    impact: { files: ["tips/read-file.md"], scanRef: "code-sense:tip", blastRadius: "low" },
    dryRun: { command: "npx vitest run tips", ok: true, at: now },
    canary: { scope: "session", size: 3 },
    rollback: { kind: "flag", ref: "flag:tip-inline-summary" },
    ownerName: "owner-1",
    irreversible: false,
    riskFlags: [],
    createdAt: now,
    updatedAt: now,
    decision: { kind: "pending" },
  };
}

/** 造一份「有待批」的周报(供提醒/渲染用例复用)。 */
async function rootWithPendingApproval(): Promise<string> {
  const root = await tmpRoot();
  requestModification(root, rsiRequest("mod-rsi") as unknown as Parameters<typeof requestModification>[1]);
  return root;
}

describe("rsi-weekly", () => {
  it("1. adopt + reject 两实验 → changed.adopted / changed.rejected 各含其 id", async () => {
    const root = await tmpRoot();
    recordExperiment(root, experimentOf("exp-adopt", "adopt"));
    recordExperiment(root, experimentOf("exp-reject", "reject", "周报实验 exp-reject 无效"));

    const report = await aggregateWeekly(root);
    expect(report.changed.adopted.map((item) => item.id)).toContain("exp-adopt");
    expect(report.changed.rejected.map((item) => item.id)).toContain("exp-reject");
    expect(report.counts.byDecision.adopt).toBe(1);
  });

  it("2. 负净值成本 → needsDecision 含 negative-roi", async () => {
    const root = await tmpRoot();
    recordCost(root, {
      id: "c1-c",
      cycleId: "c1",
      at: "2026-11-01T00:00:00.000Z",
      stage: "retro",
      mechanismId: "m1",
      projectId: "p1",
      tokens: { input: 800, output: 200, total: 1000 },
      wallMs: 1000,
    });
    recordSavings(root, { id: "c1-s", cycleId: "c1", at: "2026-11-01T00:10:00.000Z", tokensSaved: 100 });

    const report = await aggregateWeekly(root);
    expect(report.savings.netTokens).toBeLessThan(0);
    expect(report.needsDecision.map((item) => item.kind)).toContain("negative-roi");
    expect(report.healthy).toBe(false);
  });

  it("3. 断路器暂停 → needsDecision 含 breaker-paused", async () => {
    const root = await tmpRoot();
    await pauseBreaker(root, { by: "tester", reason: "回归超阈" });

    const report = await aggregateWeekly(root);
    expect(report.needsDecision.map((item) => item.kind)).toContain("breaker-paused");
  });

  it("4. 自我修改 need-approval → needsDecision 含 pending-approval", async () => {
    const root = await rootWithPendingApproval();

    const report = await aggregateWeekly(root);
    const approval = report.needsDecision.find((item) => item.kind === "pending-approval");
    expect(approval).toBeDefined();
    expect(approval?.ref).toBe("mod-rsi");
  });

  it("5. 空 root → healthy、needsDecision 空、渲染含「本周无需要你处理的事项」", async () => {
    const root = await tmpRoot();

    const report = await aggregateWeekly(root);
    expect(report.healthy).toBe(true);
    expect(report.needsDecision).toEqual([]);
    expect(report.changed.adopted).toEqual([]);
    expect(renderWeeklyReportText(report)).toContain("本周无需要你处理的事项");
  });

  it("6. attentionOnly=true 且无待决 → suppressedSections 含 changed", async () => {
    const root = await tmpRoot();
    recordExperiment(root, experimentOf("exp-att", "adopt"));

    const report = await aggregateWeekly(root, { attentionOnly: true });
    expect(report.attentionOnly).toBe(true);
    expect(report.suppressedSections ?? []).toContain("changed");
    expect(report.changed.adopted).toEqual([]);
  });

  it("7. attentionOnly=true 且有待决 → changed 被压空、needsDecision 保留", async () => {
    const root = await rootWithPendingApproval();
    recordExperiment(root, experimentOf("exp-att2", "adopt"));

    const report = await aggregateWeekly(root, { attentionOnly: true });
    expect(report.changed.adopted).toEqual([]);
    expect(report.needsDecision.map((item) => item.kind)).toContain("pending-approval");
  });

  it("8. correctFromReport rewrite 已有证据 → ok + graphNodeId + history>=2 + corrected 事件", async () => {
    const root = await tmpRoot();
    const nodeId = addEvidence(root, { kind: "fact", statement: "缓存命中率随固定前缀稳定" }).id;
    expect(nodeId).toBeDefined();

    const result = await correctFromReport(root, {
      kind: "rewrite",
      target: nodeId!,
      by: "tester",
      reason: "口径写错了",
      newStatement: "缓存命中率随固定前缀稳定,但仅限 4k 以上前缀",
    });

    expect(result.ok).toBe(true);
    expect(result.graphNodeId).toBeDefined();
    expect(result.historyLength ?? 0).toBeGreaterThanOrEqual(2);
    const events = readWeeklyEvents(root);
    expect(events.map((event) => event.kind)).toContain("corrected");
    expect(existsSync(join(root, WEEKLY_LEDGER_REL))).toBe(true);
  });

  it("9. correctFromReport rollback 实验 → ok 且决策变 rollback", async () => {
    const root = await tmpRoot();
    recordExperiment(root, experimentOf("exp-roll", "pending"));

    const result = await correctFromReport(root, {
      kind: "rollback",
      target: "exp-roll",
      by: "tester",
      reason: "线上回归",
    });

    expect(result.ok).toBe(true);
    expect(listExperiments(root).find((exp) => exp.id === "exp-roll")?.decision.kind).toBe("rollback");
  });

  it("10. shouldRemind 首次 true → 记 reminded 后 ttl 抑制 → ttlMs=0 再 true", async () => {
    const root = await rootWithPendingApproval();
    const report = await aggregateWeekly(root);

    expect(shouldRemind(root, report).remind).toBe(true);
    appendWeeklyEvent(root, { kind: "reminded" });
    expect(lastRemindedAt(root)).toBeTypeOf("number");
    expect(shouldRemind(root, report).remind).toBe(false);
    expect(shouldRemind(root, report, { ttlMs: 0 }).remind).toBe(true);
  });

  it("11. writeReportFile 写 markdown → 文件存在且含「## 本周改了什么」", async () => {
    const root = await rootWithPendingApproval();
    const report = await aggregateWeekly(root);

    const path = writeReportFile(root, report, ".genie/rsi/weekly-report.md");
    expect(existsSync(path)).toBe(true);
    const text = await readFile(path, "utf8");
    expect(text).toContain("## 本周改了什么");
    expect(text).toContain("## 需要你决定什么");
  });

  it("12. 空 root + 证据源不可读 → 不抛异常", async () => {
    const root = await tmpRoot();
    // 把 .genie 做成普通文件:证据图/成本路径读取时必然失败,聚合仍须返回报告。
    await writeFile(join(root, ".genie"), "not a directory", "utf8");

    const report = await aggregateWeekly(root);
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(typeof report.healthy).toBe("boolean");
  });

  it("13. 带 from/to 时 warnings 含 cost-window-unsupported", async () => {
    const root = await tmpRoot();
    await mkdir(join(root, ".genie", "rsi"), { recursive: true });
    recordCost(root, {
      id: "c1-c",
      cycleId: "c1",
      at: "2026-11-01T00:00:00.000Z",
      stage: "retro",
      mechanismId: "m1",
      projectId: "p1",
      tokens: { input: 80, output: 20, total: 100 },
      wallMs: 500,
    });
    recordSavings(root, { id: "c1-s", cycleId: "c1", at: "2026-11-01T00:10:00.000Z", tokensSaved: 500 });

    const now = Date.now();
    const report = await aggregateWeekly(root, {
      from: new Date(now - 7 * 86400000).toISOString(),
      to: new Date(now).toISOString(),
    });
    expect(report.warnings).toContain("cost-window-unsupported");
    expect(report.window.from).not.toBe("");
  });
});
