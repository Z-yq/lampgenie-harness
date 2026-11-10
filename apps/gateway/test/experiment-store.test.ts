import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExperimentMetric } from "@lampgenie/runtime/agent/experiment-ledger";
import {
  decideExperiment,
  experimentLedgerPath,
  getExperiment,
  listExperiments,
  loadProjection,
  recordExperiment,
  reportExperiments,
} from "../src/experiment-store";

/** 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。 */
const tempDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-exp-store-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** 能过采纳闸的指标:rate 降向,样本足、效应 -20%、z≈2.01 ≥ 1.96。 */
function passingMetric(name = "reads_per_turn"): Record<string, unknown> {
  return {
    name,
    kind: "rate",
    direction: "decrease",
    baseline: { value: 0.5, sample: 200 },
    result: { value: 0.4, sample: 200 },
    thresholds: { minSample: 100, minEffectPct: 5, minZ: 1.96 },
  };
}

/** 样本不足的指标(过不了闸)。 */
function lowSampleMetric(name = "reads_per_turn"): Record<string, unknown> {
  return {
    name,
    kind: "rate",
    direction: "decrease",
    baseline: { value: 0.5, sample: 200 },
    result: { value: 0.4, sample: 12 },
    thresholds: { minSample: 100, minEffectPct: 5, minZ: 1.96 },
  };
}

/** 一条完整实验(不含 id:由 store 用 experimentIdOf 补齐)。 */
function makeExperiment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hypothesis: { claim: "tip 里内联文件摘要能降低重复读文件次数", mechanism: "少一次回读", expectedEffect: "-20% reads" },
    intervention: { surface: "tip", ref: "tips/read-file.md", variant: "v2" },
    guardrails: [{ metric: "reads_per_turn", maxRegressionPct: 10 }],
    canary: { scope: "session", sessions: 3, status: "done" },
    strata: [
      {
        projectId: "proj-a",
        taskClass: "code-edit",
        model: "m1",
        window: { from: "2026-11-01", to: "2026-11-10" },
      },
    ],
    metrics: [passingMetric()],
    rollbackPoint: { kind: "flag", ref: "flag:tip-inline-summary" },
    decision: { kind: "pending" },
    ...overrides,
  };
}

/** 台账非空行(直接读文件,绕开投影)。 */
async function ledgerLines(root: string): Promise<string[]> {
  const text = await readFile(experimentLedgerPath(root), "utf8");
  return text.split("\n").filter((line) => line.trim() !== "");
}

describe("experiment-store:record", () => {
  it("记录成功:文件存在、1 行、投影 1 条、id 由 experimentIdOf 补齐", async () => {
    const root = await tmpRoot();
    const res = recordExperiment(root, makeExperiment());
    expect(res.ok).toBe(true);
    expect(res.id).toMatch(/^exp-[0-9a-f]{16}$/);

    const lines = await ledgerLines(root);
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(row["type"]).toBe("record");
    expect(row["v"]).toBe(1);
    expect(typeof row["at"]).toBe("number");
    const stored = row["experiment"] as Record<string, unknown>;
    expect(stored["id"]).toBe(res.id);
    expect(stored["schemaVersion"]).toBe(1);

    const projection = loadProjection(root);
    expect(projection.experiments.length).toBe(1);
    expect(projection.badLines).toBe(0);
    expect(projection.totalLines).toBe(1);
    expect(projection.experiments[0]!.decision.kind).toBe("pending");
  });

  it("同 id 重复记录 → EXP_DUPLICATE,行数不增", async () => {
    const root = await tmpRoot();
    const first = recordExperiment(root, makeExperiment({ id: "exp-fixed-0001" }));
    expect(first.ok).toBe(true);
    const again = recordExperiment(root, makeExperiment({ id: "exp-fixed-0001" }));
    expect(again).toEqual({ ok: false, code: "EXP_DUPLICATE", id: "exp-fixed-0001" });
    expect((await ledgerLines(root)).length).toBe(1);
  });

  it("同 claim + 同 strata、仅 ref 不同 → EXP_DUPLICATE_HYPOTHESIS", async () => {
    const root = await tmpRoot();
    const first = recordExperiment(root, makeExperiment());
    expect(first.ok).toBe(true);
    const dup = recordExperiment(
      root,
      makeExperiment({ intervention: { surface: "tip", ref: "tips/another-file.md", variant: "v3" } }),
    );
    expect(dup.ok).toBe(false);
    expect(dup.code).toBe("EXP_DUPLICATE_HYPOTHESIS");
    expect(dup.id).not.toBe(first.id);
    expect((await ledgerLines(root)).length).toBe(1);
  });

  it("参数非法抛 TypeError", async () => {
    const root = await tmpRoot();
    expect(() => recordExperiment(root, "not-an-object")).toThrow(TypeError);
    expect(() => recordExperiment(root, makeExperiment({ hypothesis: { claim: "  " } }))).toThrow(TypeError);
    expect(() => recordExperiment(root, makeExperiment({ intervention: { surface: "tip", ref: "", variant: "v1" } })))
      .toThrow(TypeError);
    expect((await ledgerLines(root).catch(() => [])).length).toBe(0);
  });
});

describe("experiment-store:投影与坏行", () => {
  it("坏行只计 badLines,不 throw,好记录仍可见", async () => {
    const root = await tmpRoot();
    const rec = recordExperiment(root, makeExperiment());
    expect(rec.ok).toBe(true);
    const path = experimentLedgerPath(root);
    await writeFile(path, `${await readFile(path, "utf8")}not json\n`, "utf8");

    const projection = loadProjection(root);
    expect(projection.badLines).toBe(1);
    expect(projection.totalLines).toBe(2);
    expect(projection.experiments.length).toBe(1);
    expect(projection.experiments[0]!.id).toBe(rec.id);

    const listed = listExperiments(root);
    expect(listed.length).toBe(1);
    expect(getExperiment(root, rec.id!)?.id).toBe(rec.id);
  });

  it("缺必需字段 / 未知 v 的行 → 计入 badLines 并跳过", async () => {
    const root = await tmpRoot();
    await mkdir(join(root, ".genie", "experiments"), { recursive: true });
    await writeFile(
      experimentLedgerPath(root),
      [
        JSON.stringify({ type: "record", at: 1, v: 2, experiment: { id: "exp-old" } }),
        JSON.stringify({ type: "record", at: 1, v: 1, experiment: { id: "exp-partial" } }),
        JSON.stringify({ type: "mystery", at: 1, v: 1 }),
        "",
      ].join("\n"),
      "utf8",
    );
    const projection = loadProjection(root);
    expect(projection.experiments.length).toBe(0);
    expect(projection.badLines).toBe(3);
    expect(projection.totalLines).toBe(3);
  });

  it("decision 投影 latest wins,resultMetrics 合并进 metrics", async () => {
    const root = await tmpRoot();
    const rec = recordExperiment(root, makeExperiment());
    const id = rec.id!;

    const first = decideExperiment(root, id, "reject", { reason: "样本代表性不足" });
    expect(first).toEqual({ ok: true, codes: [] });
    const second = decideExperiment(root, id, "iterate", {
      reason: "换成更小范围的 tip 再跑一轮",
      by: "tester",
      resultMetrics: [passingMetric("extra_turns") as unknown as ExperimentMetric],
    });
    expect(second.ok).toBe(true);

    const exp = getExperiment(root, id);
    expect(exp?.decision.kind).toBe("iterate");
    expect(exp?.decision.reason).toBe("换成更小范围的 tip 再跑一轮");
    expect(exp?.decision.by).toBe("tester");
    expect(exp?.metrics.map((m) => m.name)).toContain("reads_per_turn");
    expect(exp?.metrics.map((m) => m.name)).toContain("extra_turns");
    expect((await ledgerLines(root)).length).toBe(3);
  });
});

describe("experiment-store:decide 闸门", () => {
  it("样本不足的 adopt 被拒:codes 含 EXP_RESULT_SAMPLE_LOW 且不写 decision 行", async () => {
    const root = await tmpRoot();
    const rec = recordExperiment(root, makeExperiment({ metrics: [lowSampleMetric()] }));
    expect(rec.ok).toBe(true);
    const before = (await ledgerLines(root)).length;

    const res = decideExperiment(root, rec.id!, "adopt", { by: "lead", reason: "想上线" });
    expect(res.ok).toBe(false);
    expect(res.codes).toContain("EXP_RESULT_SAMPLE_LOW");
    expect((await ledgerLines(root)).length).toBe(before);
    expect(getExperiment(root, rec.id!)?.decision.kind).toBe("pending");
  });

  it("样本足、效应达标、z≥1.96、canary done → adopt 成功并多一行 decision", async () => {
    const root = await tmpRoot();
    const rec = recordExperiment(root, makeExperiment());
    const before = (await ledgerLines(root)).length;

    const res = decideExperiment(root, rec.id!, "adopt", { by: "lead", reason: "显著且无回归" });
    expect(res).toEqual({ ok: true, codes: [] });

    const lines = await ledgerLines(root);
    expect(lines.length).toBe(before + 1);
    const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(last["type"]).toBe("decision");
    expect(last["kind"]).toBe("adopt");
    expect(last["id"]).toBe(rec.id);
    expect(last["codes"]).toEqual([]);

    const exp = getExperiment(root, rec.id!);
    expect(exp?.decision.kind).toBe("adopt");
    expect(exp?.decision.by).toBe("lead");
  });

  it("同 surface+ref 的第二个 adopt → codes 含 EXP_CONFLICTING_ADOPTED", async () => {
    const root = await tmpRoot();
    const a = recordExperiment(root, makeExperiment({ hypothesis: { claim: "假设A:内联摘要降读取", expectedEffect: "-20%" } }));
    const b = recordExperiment(root, makeExperiment({ hypothesis: { claim: "假设B:换措辞降读取", expectedEffect: "-15%" } }));
    expect(a.ok && b.ok).toBe(true);
    expect(a.id).not.toBe(b.id);

    expect(decideExperiment(root, a.id!, "adopt", { reason: "先上 A" }).ok).toBe(true);
    const second = decideExperiment(root, b.id!, "adopt", { reason: "再上 B" });
    expect(second.ok).toBe(false);
    expect(second.codes).toContain("EXP_CONFLICTING_ADOPTED");
    expect(getExperiment(root, b.id!)?.decision.kind).toBe("pending");
  });

  it("reject 缺 reason → EXP_REASON_REQUIRED;未知 id → EXP_NOT_FOUND", async () => {
    const root = await tmpRoot();
    const rec = recordExperiment(root, makeExperiment());
    const noReason = decideExperiment(root, rec.id!, "reject", { reason: "   " });
    expect(noReason).toEqual({ ok: false, code: "EXP_REASON_REQUIRED", codes: ["EXP_REASON_REQUIRED"] });
    expect(getExperiment(root, rec.id!)?.decision.kind).toBe("pending");

    const missing = decideExperiment(root, "exp-does-not-exist", "reject", { reason: "x" });
    expect(missing).toEqual({ ok: false, code: "EXP_NOT_FOUND", codes: [] });
  });
});

describe("experiment-store:list / report", () => {
  it("report 计数正确(total/byDecision/bySurface/byStratum/conflicts/parseErrors)", async () => {
    const root = await tmpRoot();
    const a = recordExperiment(root, makeExperiment({ hypothesis: { claim: "报告假设一", expectedEffect: "-20%" } }));
    const b = recordExperiment(
      root,
      makeExperiment({
        hypothesis: { claim: "报告假设二", expectedEffect: "-20%" },
        intervention: { surface: "tool", ref: "tools/grep.md", variant: "v2" },
        strata: [{ projectId: "proj-b", taskClass: "review", model: "m2" }],
      }),
    );
    expect(a.ok && b.ok).toBe(true);
    expect(decideExperiment(root, a.id!, "adopt", { reason: "adopt 一" }).ok).toBe(true);
    expect(decideExperiment(root, b.id!, "reject", { reason: "reject 二" }).ok).toBe(true);

    const path = experimentLedgerPath(root);
    await writeFile(path, `${await readFile(path, "utf8")}{"v":1,"type":"record"}\n`, "utf8");

    const report = reportExperiments(root);
    expect(report.total).toBe(2);
    expect(report.byDecision).toEqual({ adopt: 1, reject: 1 });
    expect(report.bySurface).toEqual({ tip: 1, tool: 1 });
    expect(report.byStratum.projectId).toEqual({ "proj-a": 1, "proj-b": 1 });
    expect(report.byStratum.taskClass).toEqual({ "code-edit": 1, review: 1 });
    expect(report.byStratum.model).toEqual({ m1: 1, m2: 1 });
    expect(report.conflicts).toBe(0);
    expect(report.parseErrors).toBe(1);
  });

  it("list 过滤:decision=\"adopt\" 只返回 adopt;projectId 过滤按 strata 命中", async () => {
    const root = await tmpRoot();
    const a = recordExperiment(root, makeExperiment({ hypothesis: { claim: "列表假设一", expectedEffect: "-20%" } }));
    const b = recordExperiment(
      root,
      makeExperiment({
        hypothesis: { claim: "列表假设二", expectedEffect: "-20%" },
        intervention: { surface: "prompt", ref: "prompts/plan.md", variant: "v2" },
        strata: [{ projectId: "proj-b", taskClass: "review" }],
      }),
    );
    expect(a.ok && b.ok).toBe(true);
    expect(decideExperiment(root, a.id!, "adopt", { reason: "上" }).ok).toBe(true);

    const adopted = listExperiments(root, { decision: "adopt" });
    expect(adopted.length).toBe(1);
    expect(adopted[0]!.id).toBe(a.id);

    const projB = listExperiments(root, { projectId: "proj-b" });
    expect(projB.length).toBe(1);
    expect(projB[0]!.id).toBe(b.id);

    const windowed = listExperiments(root, { window: { from: "2026-11-05", to: "2026-12-01" } });
    expect(windowed.length).toBe(2);

    expect(listExperiments(root).length).toBe(2);
  });

  it("两两 adopt 同 surface+ref 重叠窗 → report.conflicts 计对数(去重)", async () => {
    const root = await tmpRoot();
    const a = recordExperiment(root, makeExperiment({ hypothesis: { claim: "冲突假设一", expectedEffect: "-20%" } }));
    const b = recordExperiment(root, makeExperiment({ hypothesis: { claim: "冲突假设二", expectedEffect: "-20%" } }));
    expect(a.ok && b.ok).toBe(true);
    // 直接手写两条 adopt 行(绕过闸门)以验证 report 的冲突累计。
    const path = experimentLedgerPath(root);
    const adoptedRows = [a.id, b.id].map((id) =>
      JSON.stringify({ type: "decision", at: Date.now(), v: 1, id, kind: "adopt", codes: [] }),
    );
    await writeFile(path, `${await readFile(path, "utf8")}${adoptedRows.join("\n")}\n`, "utf8");

    const report = reportExperiments(root);
    expect(report.byDecision).toEqual({ adopt: 2 });
    expect(report.conflicts).toBe(1);
  });
});
