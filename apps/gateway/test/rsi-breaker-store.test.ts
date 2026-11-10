import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaselineSnapshot, ExperimentOutcome } from "@lampgenie/runtime/agent/rsi-circuit-breaker";
import { recordExperiment } from "../src/experiment-store";
import {
  breakerPaths,
  evaluateAndApply,
  getBaseline,
  getState,
  listBaselines,
  loadBreakerProjection,
  markRollbackApplied,
  outcomesFromExperiments,
  pause,
  planRollback,
  reportBreaker,
  resume,
  takeBaseline,
} from "../src/rsi-breaker-store";

/** 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。 */
const tempDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-rsi-breaker-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** 台账非空行(直接读文件,绕开投影)。 */
async function ledgerLines(root: string): Promise<string[]> {
  const text = await readFile(breakerPaths(root).file, "utf8");
  return text.split("\n").filter((line) => line.trim() !== "");
}

/** 台账行 JSON(带宽松字段类型)。 */
async function ledgerRows(root: string): Promise<Array<Record<string, unknown>>> {
  return (await ledgerLines(root)).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function versions(overrides: Partial<BaselineSnapshot["versions"]> = {}): BaselineSnapshot["versions"] {
  return { tools: "tools@1", tips: "tips@1", prompts: "prompts@1", wiki: "wiki@1", graph: "graph@1", ...overrides };
}

/** 连续负向结果(应触发熔断)。 */
function negativeOutcomes(n = 5): ExperimentOutcome[] {
  return Array.from({ length: n }, (_v, i) => ({
    id: `exp-neg-${i}`,
    decision: "reject",
    netReturn: -0.3,
  })) as unknown as ExperimentOutcome[];
}

/** 正向结果(不应触发熔断)。 */
function positiveOutcomes(): ExperimentOutcome[] {
  return [{ id: "exp-pos-0", decision: "adopt", netReturn: 0.2 }] as unknown as ExperimentOutcome[];
}

describe("rsi-breaker-store:paths 与空仓", () => {
  it("breakerPaths 指向 <root>/.genie/rsi/breaker.jsonl", async () => {
    const root = await tmpRoot();
    const paths = breakerPaths(root);
    expect(paths.dir).toBe(join(root, ".genie", "rsi"));
    expect(paths.file).toBe(join(root, ".genie", "rsi", "breaker.jsonl"));
  });

  it("空仓 getState → {paused:false,scope:'all'},不建文件", async () => {
    const root = await tmpRoot();
    const state = await getState(root);
    expect(state.paused).toBe(false);
    expect(state.scope).toBe("all");
    expect((await listBaselines(root)).length).toBe(0);
    const report = await reportBreaker(root);
    expect(report.history.length).toBe(0);
    expect(report.badLines).toBe(0);
    await expect(readFile(breakerPaths(root).file, "utf8")).rejects.toThrow();
  });

  it("root 非非空字符串 → TypeError", async () => {
    await expect(getState("")).rejects.toThrow(TypeError);
    await expect(getState("   ")).rejects.toThrow(TypeError);
  });
});

describe("rsi-breaker-store:pause/resume", () => {
  it("pause 后 getState 折叠出 paused/by/reason/scope", async () => {
    const root = await tmpRoot();
    const res = await pause(root, { by: "owner", reason: "nightly 连续回退", scope: "nightly" });
    expect(res.ok).toBe(true);
    expect(res.codes).toEqual([]);
    expect(res.state.paused).toBe(true);

    const state = await getState(root);
    expect(state.paused).toBe(true);
    expect(state.by).toBe("owner");
    expect(state.reason).toBe("nightly 连续回退");
    expect(state.scope).toBe("nightly");
    expect(typeof state.pausedAt).toBe("string");

    const rows = await ledgerRows(root);
    expect(rows.length).toBe(1);
    expect(rows[0]!["v"]).toBe(1);
    expect(rows[0]!["type"]).toBe("pause");
    expect(typeof rows[0]!["at"]).toBe("string");
  });

  it("resume human 折叠回未暂停", async () => {
    const root = await tmpRoot();
    await pause(root, { by: "owner", reason: "手动熔断", scope: "all" });
    const res = await resume(root, { by: "owner", kind: "human", reason: "已复核指标" });
    expect(res.ok).toBe(true);
    expect(res.state.paused).toBe(false);
    expect(typeof res.state.recoveredAt).toBe("string");

    const state = await getState(root);
    expect(state.paused).toBe(false);
    expect((await ledgerLines(root)).length).toBe(2);
  });

  it("resume agent 被拒 → ok:false 且行数不变", async () => {
    const root = await tmpRoot();
    await pause(root, { by: "owner", reason: "手动熔断", scope: "all" });
    const before = (await ledgerLines(root)).length;
    const res = await resume(root, { by: "agent-7", kind: "agent", reason: "我看没事了" });
    expect(res.ok).toBe(false);
    expect(res.codes.length).toBeGreaterThan(0);
    expect(res.state.paused).toBe(true);
    expect((await ledgerLines(root)).length).toBe(before);
  });
});

describe("rsi-breaker-store:evaluateAndApply", () => {
  it("缺省不落盘:applied:false 且文件不存在", async () => {
    const root = await tmpRoot();
    const res = await evaluateAndApply(root, { outcomes: negativeOutcomes() });
    expect(res.applied).toBe(false);
    expect(res.evaluation.shouldPause).toBe(true);
    expect(res.state.paused).toBe(false);
    await expect(readFile(breakerPaths(root).file, "utf8")).rejects.toThrow();
  });

  it("apply:true 且应暂停 → 落 evaluate+pause 两行,state.paused 且 trigger=auto-negative-streak", async () => {
    const root = await tmpRoot();
    const res = await evaluateAndApply(root, { outcomes: negativeOutcomes(), apply: true });
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(true);
    expect(res.evaluation.shouldPause).toBe(true);
    expect(res.state.paused).toBe(true);
    expect(res.state.trigger).toBe("auto-negative-streak");
    expect(res.state.by).toBe("auto");
    expect(res.state.reason).toContain("auto-pause");

    const rows = await ledgerRows(root);
    expect(rows.length).toBe(2);
    expect(rows[0]!["type"]).toBe("evaluate");
    expect(rows[0]!["shouldPause"]).toBe(true);
    expect(rows[1]!["type"]).toBe("pause");
    expect(rows[1]!["by"]).toBe("auto");
    expect(rows[1]!["trigger"]).toBe("auto-negative-streak");
  });

  it("apply:true 且不应暂停 → 只落 1 行 evaluate", async () => {
    const root = await tmpRoot();
    const res = await evaluateAndApply(root, { outcomes: positiveOutcomes(), apply: true });
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(true);
    expect(res.evaluation.shouldPause).toBe(false);
    expect(res.state.paused).toBe(false);

    const rows = await ledgerRows(root);
    expect(rows.length).toBe(1);
    expect(rows[0]!["type"]).toBe("evaluate");
    expect(rows[0]!["shouldPause"]).toBe(false);
    expect(await getState(root).then((s) => s.paused)).toBe(false);
  });
});

describe("rsi-breaker-store:baseline", () => {
  it("takeBaseline 落行 + listBaselines/getBaseline 按发生顺序取回", async () => {
    const root = await tmpRoot();
    const first = await takeBaseline(root, { id: "base-1", label: "首版", versions: versions() });
    expect(first.ok).toBe(true);
    expect(first.snapshot?.id).toBe("base-1");
    const second = await takeBaseline(root, { id: "base-2", versions: versions({ tips: "tips@2" }) });
    expect(second.ok).toBe(true);

    const list = await listBaselines(root);
    expect(list.map((b) => b.id)).toEqual(["base-1", "base-2"]);
    expect((await getBaseline(root, "base-2"))?.versions.tips).toBe("tips@2");
    expect(await getBaseline(root, "base-missing")).toBeUndefined();
    expect((await ledgerLines(root)).length).toBe(2);
  });

  it("重复 baseline id → RSI_BASELINE_DUPLICATE 且不落盘", async () => {
    const root = await tmpRoot();
    await takeBaseline(root, { id: "base-1", versions: versions() });
    const dup = await takeBaseline(root, { id: "base-1", versions: versions({ tips: "tips@9" }) });
    expect(dup.ok).toBe(false);
    expect(dup.codes).toEqual(["RSI_BASELINE_DUPLICATE"]);
    expect((await ledgerLines(root)).length).toBe(1);
    expect((await getBaseline(root, "base-1"))?.versions.tips).toBe("tips@1");
  });
});

describe("rsi-breaker-store:rollback", () => {
  it("目标不存在 → RSI_BASELINE_MISSING 且不落盘", async () => {
    const root = await tmpRoot();
    await takeBaseline(root, { id: "base-1", versions: versions() });
    const res = await planRollback(root, "base-missing");
    expect(res.ok).toBe(false);
    expect(res.codes).toEqual(["RSI_BASELINE_MISSING"]);
    expect((await ledgerLines(root)).length).toBe(1);
  });

  it("正常规划 → 计划步数为 7 且落 rollback-planned 行", async () => {
    const root = await tmpRoot();
    await takeBaseline(root, { id: "base-1", versions: versions() });
    await takeBaseline(root, { id: "base-2", versions: versions({ tools: "tools@2", tips: "tips@2" }) });
    const res = await planRollback(root, "base-1", { affectedExperiments: ["exp-a"] });
    expect(res.ok).toBe(true);
    expect(res.plan?.steps.length).toBe(7);
    expect(Array.isArray(res.plan?.requeueExperiments)).toBe(true);

    const rows = await ledgerRows(root);
    expect(rows.length).toBe(3);
    const planned = rows[2]!;
    expect(planned["type"]).toBe("rollback-planned");
    expect(planned["targetId"]).toBe("base-1");
    expect((planned["steps"] as unknown[]).length).toBe(7);
  });

  it("markRollbackApplied 成功后 reportBreaker().rollbacksApplied 含 id;重复标记拒", async () => {
    const root = await tmpRoot();
    await takeBaseline(root, { id: "base-1", versions: versions() });
    await planRollback(root, "base-1");
    const applied = await markRollbackApplied(root, "base-1");
    expect(applied.ok).toBe(true);
    expect((await reportBreaker(root)).rollbacksApplied).toContain("base-1");

    const linesAfterApply = (await ledgerLines(root)).length;
    const again = await markRollbackApplied(root, "base-1");
    expect(again.ok).toBe(false);
    expect(again.codes).toEqual(["RSI_ROLLBACK_ALREADY_APPLIED"]);
    expect((await ledgerLines(root)).length).toBe(linesAfterApply);
  });

  it("markRollbackApplied 目标不存在 → RSI_BASELINE_MISSING", async () => {
    const root = await tmpRoot();
    const res = await markRollbackApplied(root, "base-missing");
    expect(res.ok).toBe(false);
    expect(res.codes).toEqual(["RSI_BASELINE_MISSING"]);
  });
});

describe("rsi-breaker-store:坏行与投影", () => {
  it("坏行只计 badLines,有效行照常投影", async () => {
    const root = await tmpRoot();
    await pause(root, { by: "owner", reason: "手动熔断" });
    const file = breakerPaths(root).file;
    const pauseText = await readFile(file, "utf8");
    await mkdir(join(root, ".genie", "rsi"), { recursive: true });
    await writeFile(
      file,
      [
        pauseText.trimEnd(),
        "{不是 JSON",
        JSON.stringify({ v: 9, type: "pause", at: "2026-11-01T00:00:00.000Z" }),
        JSON.stringify({ v: 1, type: "unknown-type", at: "2026-11-01T00:00:00.000Z" }),
        JSON.stringify({ v: 1, type: "rollback-applied" }),
        "",
      ].join("\n"),
      "utf8",
    );

    const projection = loadBreakerProjection(root);
    expect(projection.badLines).toBe(4);
    expect(projection.totalLines).toBe(5);
    expect(projection.state.paused).toBe(true);
    expect(projection.history.length).toBe(1);

    const report = await reportBreaker(root);
    expect(report.badLines).toBe(4);
  });
});

describe("rsi-breaker-store:outcomesFromExperiments", () => {
  it("读真实 experiment store 后映射 decision/metrics", async () => {
    const root = await tmpRoot();
    const recorded = recordExperiment(root, {
      hypothesis: { claim: "tip 里内联文件摘要能降低重复读文件次数", mechanism: "少一次回读", expectedEffect: "-20% reads" },
      intervention: { surface: "tip", ref: "tips/read-file.md", variant: "v2" },
      guardrails: [{ metric: "reads_per_turn", maxRegressionPct: 10 }],
      canary: { scope: "session", sessions: 3, status: "done" },
      strata: [
        { projectId: "proj-a", taskClass: "code-edit", model: "m1", window: { from: "2026-11-01", to: "2026-11-10" } },
      ],
      metrics: [
        {
          name: "reads_per_turn",
          kind: "rate",
          direction: "decrease",
          baseline: { value: 0.5, sample: 200 },
          result: { value: 0.4, sample: 200 },
          thresholds: { minSample: 100, minEffectPct: 5, minZ: 1.96 },
        },
      ],
      rollbackPoint: { kind: "flag", ref: "flag:tip-inline-summary" },
      decision: { kind: "pending" },
    });
    expect(recorded.ok).toBe(true);

    const outcomes = await outcomesFromExperiments(root);
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.id).toBe(recorded.id);
    expect(outcomes[0]!.decision).toBe("pending");
    expect(outcomes[0]!.netReturn).toBeUndefined();
    expect(typeof outcomes[0]!.metrics?.["reads_per_turn"]).toBe("number");
  });

  it("空 experiment 台账 → 空数组", async () => {
    const root = await tmpRoot();
    expect(await outcomesFromExperiments(root)).toEqual([]);
  });
});
