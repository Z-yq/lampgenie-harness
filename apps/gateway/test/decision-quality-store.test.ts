/**
 * 决策质量台账的持久层:决策落盘、证据缺失拒收、聚合出候选并落 patterns.jsonl、
 * 过滤/升阶/入库/反事实/人工纠正折叠、报表分组、坏行容忍、重复聚合不倒退。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DECISION_STORE_CODES,
  addToLibrary,
  aggregate,
  counterfactual,
  decisionsPath,
  humanCorrect,
  listPatterns,
  patternsPath,
  promote,
  record,
  reportDecisions,
} from "../src/decision-quality-store";

const T0 = 1_700_000_000_000;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "decision-quality-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 一条失败类决策(decision-error + 有证据):anti-pattern 的最小输入。 */
function failing(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "s1",
    type: "tool-choice",
    choice: "grep fallback",
    outcome: "failure",
    evidenceRefs: ["ev-1"],
    cost: { tokens: 100, wallMs: 200, toolCalls: 4 },
    context: { taskClass: "impl", model: "m1", phase: "execute", projectId: "p1" },
    avoidability: "decision-error",
    at: T0,
    ...over,
  };
}

function lines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("record", () => {
  it("落一条决策到 decisions.jsonl(type=decision)", () => {
    const result = record(root, failing({ id: "d1" }));
    expect(result.record?.id).toBe("d1");
    expect(result.codes).toContain("DQ_RECORDED");
    const rows = lines(decisionsPath(root));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["type"]).toBe("decision");
    expect(rows[0]?.["v"]).toBe(1);
    expect((rows[0]?.["record"] as { id?: string }).id).toBe("d1");
  });

  it("失败决策缺证据 → DQ_EVIDENCE_REQUIRED 且不落盘", () => {
    const result = record(root, failing({ evidenceRefs: [] }));
    expect(result.record).toBeUndefined();
    expect(result.codes).toContain("DQ_EVIDENCE_REQUIRED");
    expect(existsSync(decisionsPath(root))).toBe(false);
  });

  it("结构非法 → DQ_INVALID;root 非法才 throw", () => {
    const result = record(root, { sessionId: "s1", type: "nope" });
    expect(result.codes).toContain("DQ_INVALID");
    expect(existsSync(decisionsPath(root))).toBe(false);
    expect(() => record("", failing())).toThrow();
  });
});

describe("aggregate", () => {
  it("聚出 anti-pattern 候选并落 patterns.jsonl", () => {
    record(root, failing({ id: "d1", sessionId: "s1" }));
    record(root, failing({ id: "d2", sessionId: "s2" }));
    const result = aggregate(root, { now: T0 + 10 });
    expect(result.patterns.length).toBe(1);
    expect(result.patterns[0]?.kind).toBe("anti-pattern");
    expect(result.patterns[0]?.level).toBe("L0");
    expect(result.patterns[0]?.status).toBe("candidate");
    expect(result.badLines).toBe(0);
    const rows = lines(patternsPath(root));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["type"]).toBe("pattern");
    expect((rows[0]?.["pattern"] as { id?: string }).id).toBe(result.patterns[0]?.id);
  });

  it("环境噪声进 observations 不进 anti-pattern", () => {
    record(root, failing({ id: "d1", avoidability: "environment-noise" }));
    const result = aggregate(root, { now: T0 + 10 });
    expect(result.patterns).toHaveLength(0);
    expect(result.observations.some((item) => item.code === "DQ_ENVIRONMENT_NOISE")).toBe(true);
  });

  it("重复 aggregate 幂等:已升阶的状态不倒退", () => {
    record(root, failing({ id: "d1", sessionId: "s1", context: { taskClass: "impl", model: "m1", projectId: "p1" } }));
    record(root, failing({ id: "d2", sessionId: "s2", context: { taskClass: "impl", model: "m2", projectId: "p2" } }));
    record(root, failing({ id: "d3", sessionId: "s3", context: { taskClass: "impl", model: "m3", projectId: "p3" } }));
    const first = aggregate(root, { now: T0 + 10 });
    const id = first.patterns[0]?.id ?? "";
    const promoted = promote(root, id, {});
    expect(promoted.pattern?.level).toBe("L1");
    const again = aggregate(root, { now: T0 + 20 });
    expect(again.patterns[0]?.level).toBe("L1");
    expect(listPatterns(root).patterns[0]?.level).toBe("L1");
  });
});

describe("listPatterns", () => {
  it("按 kind/level/status 过滤折叠后的最新状态", () => {
    record(root, failing({ id: "d1" }));
    record(root, failing({ id: "d2" }));
    aggregate(root, { now: T0 + 10 });
    expect(listPatterns(root).patterns).toHaveLength(1);
    expect(listPatterns(root, { kind: "anti-pattern" }).patterns).toHaveLength(1);
    expect(listPatterns(root, { kind: "efficient-pattern" }).patterns).toHaveLength(0);
    expect(listPatterns(root, { level: "L0" }).patterns).toHaveLength(1);
    expect(listPatterns(root, { level: "L1" }).patterns).toHaveLength(0);
    expect(listPatterns(root, { status: "candidate" }).patterns).toHaveLength(1);
    expect(listPatterns(root, { status: "library" }).patterns).toHaveLength(0);
  });

  it("空台账返回空列表且不 throw", () => {
    const result = listPatterns(root, { kind: "anti-pattern" });
    expect(result.patterns).toHaveLength(0);
    expect(result.totalLines).toBe(0);
  });
});

describe("promote / addToLibrary", () => {
  it("跨实体达标升 L1,缺 replay 时 L1→L2 拒绝", () => {
    record(root, failing({ id: "d1", context: { taskClass: "impl", model: "m1", projectId: "p1" } }));
    record(root, failing({ id: "d2", context: { taskClass: "impl", model: "m2", projectId: "p2" } }));
    record(root, failing({ id: "d3", context: { taskClass: "impl", model: "m3", projectId: "p3" } }));
    const id = aggregate(root, { now: T0 + 10 }).patterns[0]?.id ?? "";

    const first = promote(root, id, {});
    expect(first.codes).toContain("DQ_PATTERN_PROMOTED");
    expect(first.pattern?.level).toBe("L1");
    expect(lines(patternsPath(root))).toHaveLength(2);

    const stalled = promote(root, id, {});
    expect(stalled.codes).toContain("DQ_NOT_PROMOTABLE");
    expect(stalled.pattern?.level).toBe("L1");
    expect(stalled.reason).toBeTruthy();
    expect(lines(patternsPath(root))).toHaveLength(2);

    const replay = promote(root, id, { replayValidated: true });
    expect(replay.pattern?.level).toBe("L2");
    expect(lines(patternsPath(root))).toHaveLength(3);
  });

  it("promote 不存在的 pattern → DQ_PATTERN_NOT_FOUND", () => {
    const result = promote(root, "p-missing", {});
    expect(result.pattern).toBeUndefined();
    expect(result.codes).toEqual(["DQ_PATTERN_NOT_FOUND"]);
    expect(DECISION_STORE_CODES).toContain("DQ_PATTERN_NOT_FOUND");
  });

  it("addToLibrary:升到 L1 后可入库,未升阶的 L0 被拒", () => {
    record(root, failing({ id: "d1", context: { taskClass: "impl", model: "m1", projectId: "p1" } }));
    record(root, failing({ id: "d2", context: { taskClass: "impl", model: "m2", projectId: "p2" } }));
    record(root, failing({ id: "d3", context: { taskClass: "impl", model: "m3", projectId: "p3" } }));
    const id = aggregate(root, { now: T0 + 10 }).patterns[0]?.id ?? "";

    const rejected = addToLibrary(root, id);
    expect(rejected.codes).toContain("DQ_NOT_PROMOTABLE");
    expect(rejected.pattern?.status).toBe("candidate");

    promote(root, id, {});
    const added = addToLibrary(root, id);
    expect(added.codes).toContain("DQ_LIBRARY_ADDED");
    expect(added.pattern?.status).toBe("library");
    expect(listPatterns(root, { status: "library" }).patterns).toHaveLength(1);

    const missing = addToLibrary(root, "p-missing");
    expect(missing.codes).toEqual(["DQ_PATTERN_NOT_FOUND"]);
  });
});

describe("counterfactual", () => {
  it("同上下文更优选择 → 命中对照", () => {
    record(root, failing({ id: "bad", choice: "grep fallback", outcome: "failure" }));
    record(
      root,
      failing({
        id: "good",
        sessionId: "s2",
        choice: "code-sense impact",
        outcome: "success",
        avoidability: "unknown",
        cost: { tokens: 10, wallMs: 10, toolCalls: 1 },
      }),
    );
    const result = counterfactual(root, "bad");
    expect(result.codes).toContain("DQ_COUNTERFACTUAL_FOUND");
    expect(result.match?.decisionId).toBe("good");
  });

  it("无对照 → DQ_NO_COUNTERFACTUAL;决策不存在 → DQ_DECISION_NOT_FOUND", () => {
    record(root, failing({ id: "bad" }));
    expect(counterfactual(root, "bad").codes).toContain("DQ_NO_COUNTERFACTUAL");
    const missing = counterfactual(root, "nope");
    expect(missing.match).toBeUndefined();
    expect(missing.codes).toContain("DQ_DECISION_NOT_FOUND");
  });
});

describe("humanCorrect", () => {
  it("追加 correction 覆盖行,折叠后 avoidability 变化并影响聚合", () => {
    record(root, failing({ id: "d1", avoidability: "unknown" }));
    expect(aggregate(root, { now: T0 + 10 }).patterns).toHaveLength(0);

    const corrected = humanCorrect(root, "d1", { by: "owner", note: "手抖选错工具", avoidability: "decision-error", at: T0 + 20 });
    expect(corrected.codes).toContain("DQ_HUMAN_CORRECTION");
    expect(corrected.record?.avoidability).toBe("decision-error");

    const rows = lines(decisionsPath(root));
    expect(rows).toHaveLength(2);
    expect(rows[1]?.["type"]).toBe("correction");
    expect(rows[1]?.["targetId"]).toBe("d1");
    expect(rows[1]?.["by"]).toBe("owner");
    expect(rows[0]?.["type"]).toBe("decision");

    const report = reportDecisions(root, { now: T0 + 30 });
    expect(report.total).toBe(1);
    expect(report.byAvoidability["decision-error"]).toBe(1);
    expect(aggregate(root, { now: T0 + 30 }).patterns).toHaveLength(1);
  });

  it("决策不存在 → DQ_DECISION_NOT_FOUND;参数缺失 → DQ_STORE_INVALID_INPUT", () => {
    expect(humanCorrect(root, "nope", { by: "owner", note: "x" }).codes).toEqual(["DQ_DECISION_NOT_FOUND"]);
    record(root, failing({ id: "d1" }));
    expect(humanCorrect(root, "d1", { by: "", note: "x" }).codes).toEqual(["DQ_STORE_INVALID_INPUT"]);
  });
});

describe("reportDecisions", () => {
  it("分组计数、模式状态与级别分布", () => {
    record(root, failing({ id: "d1", context: { taskClass: "impl", model: "m1", projectId: "p1" } }));
    record(root, failing({ id: "d2", context: { taskClass: "impl", model: "m2", projectId: "p2" } }));
    record(root, failing({ id: "d3", context: { taskClass: "impl", model: "m3", projectId: "p3" } }));
    record(root, failing({ id: "d4", sessionId: "s4", outcome: "success", avoidability: "unknown", choice: "read file" }));
    const id = aggregate(root, { now: T0 + 10 }).patterns[0]?.id ?? "";
    promote(root, id, {});

    const report = reportDecisions(root, { now: T0 + 20 });
    expect(report.total).toBe(4);
    expect(report.byType["tool-choice"]).toBe(4);
    expect(report.byOutcome["failure"]).toBe(3);
    expect(report.byOutcome["success"]).toBe(1);
    expect(report.byAvoidability["decision-error"]).toBe(3);
    expect(report.patterns.candidates).toBe(1);
    expect(report.patterns.library).toBe(0);
    expect(report.levels.L1).toBe(1);
    expect(report.levels.L0).toBe(0);
    expect(report.badLines).toBe(0);
    expect(Array.isArray(report.observations)).toBe(true);
  });

  it("坏行容错:手写坏 JSON 后仍能读其余行且 badLines=1", () => {
    record(root, failing({ id: "d1" }));
    appendFileSync(decisionsPath(root), "{ this is not json\n", "utf8");
    record(root, failing({ id: "d2" }));

    const report = reportDecisions(root, { now: T0 + 10 });
    expect(report.total).toBe(2);
    expect(report.badLines).toBe(1);
    expect(aggregate(root, { now: T0 + 10 }).patterns).toHaveLength(1);

    writeFileSync(patternsPath(root), "not json at all\n", "utf8");
    const patterns = listPatterns(root);
    expect(patterns.patterns).toHaveLength(0);
    expect(patterns.badLines).toBe(1);
  });
});
