/**
 * 决策质量:记录 → 聚类 → 升阶 → 入库 → 反事实 → 证据图投影。
 * 全部纯数据 + 固定时间戳常量,不碰文件与真实时钟。
 */
import { describe, expect, it } from "vitest";
import {
  DECISION_QUALITY_CODES,
  DECISION_QUALITY_CODE_LIST,
  DECISION_QUALITY_VERSION,
  addToLibrary,
  aggregate,
  choiceSignature,
  compareCost,
  counterfactual,
  costTuple,
  humanCorrect,
  promote,
  recordDecision,
  toGraphNode,
  weightOf,
} from "../src/agent/decision-quality.ts";
import type { DecisionRecord, Pattern } from "../src/agent/decision-quality.ts";

const T0 = 1_700_000_000_000;
const CODES = DECISION_QUALITY_CODES;

function rec(partial: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "D-1",
    sessionId: "S-1",
    type: "tool-choice",
    at: T0,
    context: { taskClass: "bugfix", model: "m1", phase: "impl", projectId: "proj-a" },
    choice: "grep src/agent",
    evidenceRefs: ["ev-1"],
    outcome: "failure",
    cost: { tokens: 1000, wallMs: 5000, toolCalls: 3 },
    avoidability: "decision-error",
    source: "session",
    ...partial,
  };
}

function input(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "S-1",
    type: "tool-choice",
    choice: "grep src/agent",
    evidenceRefs: ["ev-1"],
    outcome: "failure",
    cost: { tokens: 10, wallMs: 20, toolCalls: 1 },
    context: { taskClass: "bugfix" },
    ...partial,
  };
}

function pat(partial: Partial<Pattern> = {}): Pattern {
  return {
    id: "p-1",
    kind: "anti-pattern",
    level: "L0",
    name: "反复失败的选择",
    description: "描述",
    decisionType: "tool-choice",
    choiceSignature: "tool-choice|agent|grep|src!",
    instances: [{ decisionId: "D-1", projectId: "proj-a", model: "m1" }],
    frequency: 2,
    distribution: { projects: ["proj-a"], models: ["m1"], taskClasses: ["bugfix"] },
    confidence: 0.5,
    status: "candidate",
    promotion: { crossEntityCount: 2, replayValidated: false, transferTested: false },
    updatedAt: T0,
    ...partial,
  };
}

describe("稳定码与版本", () => {
  it("版本号为 1", () => {
    expect(DECISION_QUALITY_VERSION).toBe(1);
  });

  it("稳定码表 11 个且取值都是 DQ_ 前缀", () => {
    expect(DECISION_QUALITY_CODE_LIST).toHaveLength(11);
    for (const code of DECISION_QUALITY_CODE_LIST) expect(code.startsWith("DQ_")).toBe(true);
    expect(CODES.EVIDENCE_REQUIRED).toBe("DQ_EVIDENCE_REQUIRED");
    expect(new Set(DECISION_QUALITY_CODE_LIST).size).toBe(11);
  });
});

describe("recordDecision 校验与证据要求", () => {
  it("合法输入记一条并回 DQ_RECORDED", () => {
    const res = recordDecision(input(), { at: T0 });
    expect(res.codes).toEqual([CODES.RECORDED]);
    expect(res.record?.at).toBe(T0);
    expect(res.record?.avoidability).toBe("unknown");
    expect(res.record?.source).toBe("session");
  });

  it("缺 sessionId → DQ_INVALID 且无 record", () => {
    const { sessionId: _omit, ...rest } = input();
    const res = recordDecision(rest, { at: T0 });
    expect(res.codes).toEqual([CODES.INVALID]);
    expect(res.record).toBeUndefined();
  });

  it("缺 type / choice / outcome → DQ_INVALID", () => {
    for (const key of ["type", "choice", "outcome"]) {
      const raw = input();
      delete raw[key];
      expect(recordDecision(raw, { at: T0 }).codes).toEqual([CODES.INVALID]);
    }
  });

  it("evidenceRefs 非数组 → DQ_INVALID", () => {
    expect(recordDecision(input({ evidenceRefs: "ev-1" }), { at: T0 }).codes).toEqual([CODES.INVALID]);
    expect(recordDecision(input({ evidenceRefs: [1, 2] }), { at: T0 }).codes).toEqual([CODES.INVALID]);
  });

  it("cost 非数 / 缺失 → DQ_INVALID", () => {
    expect(recordDecision(input({ cost: { tokens: "10", wallMs: 1, toolCalls: 1 } }), { at: T0 }).codes).toEqual([
      CODES.INVALID,
    ]);
    expect(recordDecision(input({ cost: 5 }), { at: T0 }).codes).toEqual([CODES.INVALID]);
    const raw = input();
    delete raw["cost"];
    expect(recordDecision(raw, { at: T0 }).codes).toEqual([CODES.INVALID]);
  });

  it("非法 avoidability → DQ_INVALID", () => {
    expect(recordDecision(input({ avoidability: "not-a-reason" }), { at: T0 }).codes).toEqual([CODES.INVALID]);
  });

  it("失败类 outcome 且证据为空 → DQ_EVIDENCE_REQUIRED 且无 record", () => {
    for (const outcome of ["failure", "retry", "waste", "timeout"]) {
      const res = recordDecision(input({ outcome, evidenceRefs: [] }), { at: T0 });
      expect(res.codes).toEqual([CODES.EVIDENCE_REQUIRED]);
      expect(res.record).toBeUndefined();
    }
  });

  it("success 不强制证据,照常记录", () => {
    const res = recordDecision(input({ outcome: "success", evidenceRefs: [] }), { at: T0 });
    expect(res.codes).toEqual([CODES.RECORDED]);
    expect(res.record?.outcome).toBe("success");
  });

  it("环境噪声:保留 record 并额外带 DQ_ENVIRONMENT_NOISE", () => {
    const res = recordDecision(input({ avoidability: "environment-noise" }), { at: T0 });
    expect(res.record?.avoidability).toBe("environment-noise");
    expect(res.codes).toContain(CODES.RECORDED);
    expect(res.codes).toContain(CODES.ENVIRONMENT_NOISE);
  });

  it("id 缺省确定性派生:同输入同 id,带 sessionId/at/type", () => {
    const a = recordDecision(input(), { at: T0 });
    const b = recordDecision(input(), { at: T0 });
    expect(a.record?.id).toBe(b.record?.id);
    expect(a.record?.id.startsWith(`dq-S-1-${T0}-tool-choice-`)).toBe(true);
  });

  it("at 由 opts 注入优先于输入里的 at", () => {
    const res = recordDecision(input({ at: 1 }), { at: T0 });
    expect(res.record?.at).toBe(T0);
    expect(res.record?.id).toContain(`-${T0}-`);
  });

  it("非对象输入不抛,只回 DQ_INVALID", () => {
    for (const junk of [null, undefined, 42, "x", []]) {
      expect(() => recordDecision(junk, { at: T0 })).not.toThrow();
      expect(recordDecision(junk, { at: T0 }).codes).toEqual([CODES.INVALID]);
    }
  });
});

describe("choiceSignature token 化", () => {
  it("token 顺序/大小写/标点不同的同一选择得到同签名", () => {
    const a = choiceSignature(rec({ choice: "Edit src/a.ts", outcome: "success" }));
    const b = choiceSignature(rec({ choice: "src/a.ts  edit", outcome: "success" }));
    expect(a).toBe(b);
    expect(a).toBe("tool-choice|a|edit|src|ts");
  });

  it("失败类 outcome 加 ! 且与成功不同签名", () => {
    const failed = choiceSignature(rec({ outcome: "retry" }));
    const ok = choiceSignature(rec({ outcome: "success" }));
    expect(failed.endsWith("!")).toBe(true);
    expect(ok.endsWith("!")).toBe(false);
    expect(failed).not.toBe(ok);
  });

  it("最多取排序后前 6 个 token", () => {
    const sig = choiceSignature(rec({ type: "edit", choice: "h8 g7 f6 e5 d4 c3 b2 a1", outcome: "success" }));
    expect(sig).toBe("edit|a1|b2|c3|d4|e5|f6");
  });

  it("CJK 作为整段 token 保留", () => {
    expect(choiceSignature(rec({ type: "verify", choice: "重试 grep" }))).toBe("verify|grep|重试!");
  });

  it("无 token 的 choice 仍给出稳定签名", () => {
    expect(choiceSignature(rec({ type: "compact", choice: "!!!", outcome: "success" }))).toBe("compact|");
  });
});

describe("weightOf 权重", () => {
  it("defect-lineage=3 / human-correction=2 / session=1 / 未知=0", () => {
    expect(weightOf("defect-lineage")).toBe(3);
    expect(weightOf("human-correction")).toBe(2);
    expect(weightOf("session")).toBe(1);
    expect(weightOf("mystery")).toBe(0);
    expect(weightOf(undefined)).toBe(0);
  });
});

describe("aggregate 聚类", () => {
  it("同签名合并成一条 anti-pattern", () => {
    const res = aggregate(
      [rec({ id: "D-1" }), rec({ id: "D-2", choice: "src/agent grep" })],
      { now: T0 },
    );
    const anti = res.patterns.filter((p) => p.kind === "anti-pattern");
    expect(anti).toHaveLength(1);
    expect(anti[0]?.instances).toHaveLength(2);
    expect(anti[0]?.frequency).toBe(2);
    expect(res.codes).toContain(CODES.PATTERN_CANDIDATE);
  });

  it("defect-lineage 来源权重 3 抬高 frequency", () => {
    const res = aggregate([rec({ id: "D-1", source: "defect-lineage" })], { now: T0 });
    expect(res.patterns[0]?.frequency).toBe(3);
  });

  it("environment-noise 只进 observations,不进 anti-pattern", () => {
    const res = aggregate(
      [rec({ id: "D-N", avoidability: "environment-noise" }), rec({ id: "D-2" })],
      { now: T0 },
    );
    const obs = res.observations.filter((o) => o.code === CODES.ENVIRONMENT_NOISE);
    expect(obs).toHaveLength(1);
    expect(obs[0]?.decisionId).toBe("D-N");
    const anti = res.patterns.find((p) => p.kind === "anti-pattern");
    expect(anti?.instances.map((i) => i.decisionId)).toEqual(["D-2"]);
    expect(anti?.frequency).toBe(1);
  });

  it("requirement-change 只进 observations", () => {
    const res = aggregate(
      [rec({ id: "D-R", avoidability: "requirement-change" }), rec({ id: "D-2" })],
      { now: T0 },
    );
    expect(res.observations.map((o) => o.decisionId)).toContain("D-R");
    expect(res.patterns.find((p) => p.kind === "anti-pattern")?.instances).toHaveLength(1);
  });

  it("distribution 去重,undefined 跳过", () => {
    const res = aggregate(
      [
        rec({ id: "D-1", context: { taskClass: "bugfix", model: "m1", projectId: "proj-a" } }),
        rec({ id: "D-2", context: { taskClass: "bugfix", model: "m1", projectId: "proj-a" } }),
        rec({ id: "D-3", context: { taskClass: "feature" } }),
      ],
      { now: T0 },
    );
    const anti = res.patterns.find((p) => p.kind === "anti-pattern");
    expect(anti?.distribution.projects).toEqual(["proj-a"]);
    expect(anti?.distribution.models).toEqual(["m1"]);
    expect(anti?.distribution.taskClasses).toEqual(["bugfix", "feature"]);
  });

  it("confidence 按 0.3 + 0.1*frequency 计算并 round 2 位", () => {
    const res = aggregate(
      [
        rec({ id: "D-1" }),
        rec({ id: "D-2" }),
        rec({ id: "D-3" }),
        rec({ id: "D-4" }),
      ],
      { now: T0 },
    );
    expect(res.patterns[0]?.frequency).toBe(4);
    expect(res.patterns[0]?.confidence).toBe(0.7);
  });

  it("confidence 封顶 0.9", () => {
    const records = Array.from({ length: 10 }, (_unused, index) =>
      rec({ id: `D-${index}`, source: "defect-lineage" }),
    );
    const res = aggregate(records, { now: T0 });
    expect(res.patterns[0]?.frequency).toBe(30);
    expect(res.patterns[0]?.confidence).toBe(0.9);
  });

  it("全 session 且 frequency<2 仍产出候选(低置信)", () => {
    const res = aggregate([rec({ id: "D-1", source: "session" })], { now: T0 });
    const anti = res.patterns.find((p) => p.kind === "anti-pattern");
    expect(anti?.frequency).toBe(1);
    expect(anti?.confidence).toBeLessThan(0.5);
    expect(anti?.status).toBe("candidate");
  });

  it("候选初值:level=L0 / status=candidate / promotion 三字段 / updatedAt=now", () => {
    const res = aggregate(
      [
        rec({ id: "D-1", context: { taskClass: "bugfix", model: "m1", projectId: "proj-a" } }),
        rec({ id: "D-2", context: { taskClass: "bugfix", model: "m2", projectId: "proj-b" } }),
      ],
      { now: T0 },
    );
    const anti = res.patterns[0];
    expect(anti?.level).toBe("L0");
    expect(anti?.status).toBe("candidate");
    expect(anti?.updatedAt).toBe(T0);
    expect(anti?.promotion).toEqual({ crossEntityCount: 4, replayValidated: false, transferTested: false });
  });

  it("模式 id 由 choiceSignature+kind 确定性派生", () => {
    const once = aggregate([rec({ id: "D-1" })], { now: T0 });
    const twice = aggregate([rec({ id: "D-9" })], { now: T0 + 1 });
    expect(once.patterns[0]?.id).toBe(twice.patterns[0]?.id);
    expect(once.patterns[0]?.id.startsWith("p-")).toBe(true);
  });

  it("efficient-pattern 收低于同 type 成功中位代价的记录", () => {
    const res = aggregate(
      [
        rec({ id: "E-1", type: "edit", choice: "edit tiny", outcome: "success", cost: { tokens: 100, wallMs: 100, toolCalls: 1 } }),
        rec({ id: "E-2", type: "edit", choice: "edit medium", outcome: "success", cost: { tokens: 200, wallMs: 100, toolCalls: 1 } }),
        rec({ id: "E-3", type: "edit", choice: "edit large", outcome: "success", cost: { tokens: 300, wallMs: 100, toolCalls: 1 } }),
      ],
      { now: T0 },
    );
    const eff = res.patterns.filter((p) => p.kind === "efficient-pattern");
    expect(eff).toHaveLength(1);
    expect(eff[0]?.instances.map((i) => i.decisionId)).toEqual(["E-1"]);
  });

  it("单条 success 等于自身中位数,不产出 efficient-pattern", () => {
    const res = aggregate([rec({ id: "E-1", outcome: "success" })], { now: T0 });
    expect(res.patterns.filter((p) => p.kind === "efficient-pattern")).toHaveLength(0);
  });

  it("records 非数组 → DQ_INVALID 与空结果", () => {
    const res = aggregate("nope", { now: T0 });
    expect(res.patterns).toEqual([]);
    expect(res.observations).toEqual([]);
    expect(res.codes).toEqual([CODES.INVALID]);
  });

  it("非法记录被跳过并留观察,不抛异常", () => {
    const res = aggregate([null, rec({ id: "D-1" }), { id: "D-bad" }], { now: T0 });
    expect(res.patterns[0]?.instances.map((i) => i.decisionId)).toEqual(["D-1"]);
    expect(res.observations.map((o) => o.decisionId).sort()).toEqual(["(unknown)", "D-bad"]);
    expect(res.codes).toContain(CODES.INVALID);
  });
});

describe("代价口径", () => {
  it("compareCost 依次比较 tokens → wallMs → toolCalls", () => {
    expect(compareCost(costTuple({ tokens: 1, wallMs: 99, toolCalls: 99 }), costTuple({ tokens: 2, wallMs: 1, toolCalls: 1 }))).toBe(-1);
    expect(compareCost(costTuple({ tokens: 1, wallMs: 1, toolCalls: 99 }), costTuple({ tokens: 1, wallMs: 2, toolCalls: 1 }))).toBe(-1);
    expect(compareCost(costTuple({ tokens: 1, wallMs: 1, toolCalls: 3 }), costTuple({ tokens: 1, wallMs: 1, toolCalls: 2 }))).toBe(1);
    expect(compareCost(costTuple({ tokens: 1, wallMs: 1, toolCalls: 1 }), costTuple({ tokens: 1, wallMs: 1, toolCalls: 1 }))).toBe(0);
  });
});

describe("promote 逐级升阶", () => {
  it("L0→L1 跨实体不足 → NOT_PROMOTABLE + reason,级别不变", () => {
    const res = promote(pat(), { minCrossEntity: 3 });
    expect(res.pattern.level).toBe("L0");
    expect(res.codes).toEqual([CODES.NOT_PROMOTABLE]);
    expect(res.reason).toContain("跨实体不足");
  });

  it("L0→L1 满足跨实体门槛 → L1 + PATTERN_PROMOTED", () => {
    const base = pat({
      instances: [
        { decisionId: "D-1", projectId: "proj-a" },
        { decisionId: "D-2", projectId: "proj-b" },
        { decisionId: "D-3", model: "m1" },
      ],
    });
    const res = promote(base);
    expect(res.pattern.level).toBe("L1");
    expect(res.codes).toEqual([CODES.PATTERN_PROMOTED]);
    expect(res.pattern.promotion.crossEntityCount).toBe(3);
    expect(base.level).toBe("L0");
  });

  it("L1→L2 缺 replayValidated 拒绝,给了才升", () => {
    const l1 = pat({ level: "L1" });
    expect(promote(l1).codes).toEqual([CODES.NOT_PROMOTABLE]);
    expect(promote(l1).pattern.level).toBe("L1");
    const ok = promote(l1, { replayValidated: true });
    expect(ok.codes).toEqual([CODES.PATTERN_PROMOTED]);
    expect(ok.pattern.level).toBe("L2");
    expect(ok.pattern.promotion.replayValidated).toBe(true);
  });

  it("L2→L3 缺 transferTested 拒绝,给了才升", () => {
    const l2 = pat({ level: "L2" });
    expect(promote(l2).codes).toEqual([CODES.NOT_PROMOTABLE]);
    const ok = promote(l2, { transferTested: true });
    expect(ok.pattern.level).toBe("L3");
    expect(ok.pattern.promotion.transferTested).toBe(true);
  });

  it("L3 再调 → NOT_PROMOTABLE(封顶)", () => {
    const res = promote(pat({ level: "L3" }), { replayValidated: true, transferTested: true });
    expect(res.pattern.level).toBe("L3");
    expect(res.codes).toEqual([CODES.NOT_PROMOTABLE]);
    expect(res.reason).toContain("L3");
  });

  it("非法 pattern 不抛,回 DQ_INVALID", () => {
    expect(() => promote(null)).not.toThrow();
    expect(promote(null).codes).toEqual([CODES.INVALID]);
    expect(promote({ level: "L9" }).codes).toEqual([CODES.INVALID]);
  });
});

describe("addToLibrary 库准入", () => {
  it("L0 拒绝", () => {
    const res = addToLibrary(pat({ level: "L0", confidence: 0.9 }));
    expect(res.codes).toEqual([CODES.NOT_PROMOTABLE]);
    expect(res.pattern.status).toBe("candidate");
  });

  it("confidence<0.6 拒绝", () => {
    const res = addToLibrary(pat({ level: "L1", confidence: 0.5 }));
    expect(res.codes).toEqual([CODES.NOT_PROMOTABLE]);
    expect(res.pattern.status).toBe("candidate");
  });

  it("status=observation 拒绝", () => {
    const res = addToLibrary(pat({ level: "L1", confidence: 0.7, status: "observation" }));
    expect(res.codes).toEqual([CODES.NOT_PROMOTABLE]);
    expect(res.pattern.status).toBe("observation");
  });

  it("三条件满足 → library + LIBRARY_ADDED,入参不变", () => {
    const base = pat({ level: "L1", confidence: 0.6, status: "candidate" });
    const res = addToLibrary(base);
    expect(res.codes).toEqual([CODES.LIBRARY_ADDED]);
    expect(res.pattern.status).toBe("library");
    expect(base.status).toBe("candidate");
  });
});

describe("counterfactual 反事实", () => {
  const ctx = { taskClass: "bugfix", model: "m1", phase: "impl" };

  it("命中更优的不同选择", () => {
    const records = [
      rec({ id: "D-T", context: ctx, choice: "grep src/agent", outcome: "failure" }),
      rec({
        id: "D-A",
        context: ctx,
        choice: "read file agent",
        outcome: "success",
        cost: { tokens: 100, wallMs: 100, toolCalls: 1 },
      }),
      rec({
        id: "D-B",
        context: ctx,
        choice: "list dir tree",
        outcome: "success",
        cost: { tokens: 50, wallMs: 50, toolCalls: 1 },
      }),
    ];
    const res = counterfactual(records, "D-T");
    expect(res.codes).toEqual([CODES.COUNTERFACTUAL_FOUND]);
    expect(res.match?.decisionId).toBe("D-B");
  });

  it("同签名更优不算反事实(签名相同=同一个选择)", () => {
    const records = [
      rec({ id: "D-T", context: ctx, choice: "grep src/agent", outcome: "success", cost: { tokens: 100, wallMs: 1, toolCalls: 1 } }),
      rec({ id: "D-S", context: ctx, choice: "src/agent grep", outcome: "success", cost: { tokens: 50, wallMs: 1, toolCalls: 1 } }),
    ];
    expect(choiceSignature(records[0] as DecisionRecord)).toBe(choiceSignature(records[1] as DecisionRecord));
    expect(counterfactual(records, "D-T").codes).toEqual([CODES.NO_COUNTERFACTUAL]);
  });

  it("context 的 taskClass/model/phase 不同不算", () => {
    const records = [
      rec({ id: "D-T", context: ctx, choice: "grep src/agent", outcome: "failure" }),
      rec({
        id: "D-A",
        context: { ...ctx, taskClass: "feature" },
        choice: "read file agent",
        outcome: "success",
      }),
      rec({ id: "D-B", context: { ...ctx, model: "m2" }, choice: "list dir tree", outcome: "success" }),
      rec({ id: "D-C", context: { ...ctx, phase: "review" }, choice: "open issue doc", outcome: "success" }),
    ];
    expect(counterfactual(records, "D-T").codes).toEqual([CODES.NO_COUNTERFACTUAL]);
  });

  it("同为 success 时取代价更小者,更贵的不算", () => {
    const cheap = [
      rec({ id: "D-T", context: ctx, choice: "grep src/agent", outcome: "success", cost: { tokens: 100, wallMs: 1, toolCalls: 1 } }),
      rec({ id: "D-C", context: ctx, choice: "read file agent", outcome: "success", cost: { tokens: 50, wallMs: 1, toolCalls: 1 } }),
    ];
    expect(counterfactual(cheap, "D-T").match?.decisionId).toBe("D-C");
    const pricey = [
      rec({ id: "D-T", context: ctx, choice: "grep src/agent", outcome: "success", cost: { tokens: 100, wallMs: 1, toolCalls: 1 } }),
      rec({ id: "D-C", context: ctx, choice: "read file agent", outcome: "success", cost: { tokens: 200, wallMs: 1, toolCalls: 1 } }),
    ];
    expect(counterfactual(pricey, "D-T").codes).toEqual([CODES.NO_COUNTERFACTUAL]);
  });

  it("decisionId 不存在或输入非法 → NO_COUNTERFACTUAL,不抛", () => {
    expect(counterfactual([rec()], "nope").codes).toEqual([CODES.NO_COUNTERFACTUAL]);
    expect(counterfactual(null, "D-1").codes).toEqual([CODES.NO_COUNTERFACTUAL]);
    expect(counterfactual([rec()], 42).codes).toEqual([CODES.NO_COUNTERFACTUAL]);
  });
});

describe("humanCorrect 人工纠正", () => {
  it("改 avoidability + HUMAN_CORRECTION,并写入 by", () => {
    const res = humanCorrect(rec({ avoidability: "unknown" }), {
      by: "alice",
      note: "其实当时能查到缓存",
      at: T0 + 5,
      avoidability: "decision-error",
    });
    expect(res.codes).toEqual([CODES.HUMAN_CORRECTION]);
    expect(res.record.avoidability).toBe("decision-error");
    expect(res.record.note).toContain("alice");
    expect(res.record.note).toContain("其实当时能查到缓存");
    expect(res.record.note).toContain(String(T0 + 5));
  });

  it("不给 avoidability 时保持原值", () => {
    const res = humanCorrect(rec({ avoidability: "environment-noise" }), { by: "bob", note: "复核" });
    expect(res.record.avoidability).toBe("environment-noise");
    expect(res.codes).toEqual([CODES.HUMAN_CORRECTION]);
  });

  it("入参不被修改", () => {
    const base = rec({ avoidability: "unknown", note: "原始备注" });
    const snapshot = JSON.stringify(base);
    const res = humanCorrect(base, { by: "carol", note: "追加", avoidability: "decision-error" });
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(res.record.note?.startsWith("原始备注 | ")).toBe(true);
    expect(res.record).not.toBe(base);
  });

  it("非法输入 → DQ_INVALID 不抛", () => {
    expect(() => humanCorrect(null, { by: "a", note: "b" })).not.toThrow();
    expect(humanCorrect(null, { by: "a", note: "b" }).codes).toEqual([CODES.INVALID]);
    expect(humanCorrect(rec(), { by: "", note: "b" }).codes).toEqual([CODES.INVALID]);
    expect(humanCorrect(rec(), undefined).codes).toEqual([CODES.INVALID]);
  });
});

describe("toGraphNode 证据图投影", () => {
  it("仅 library 投影:候选返回 undefined", () => {
    expect(toGraphNode(pat({ status: "candidate" }))).toBeUndefined();
    expect(toGraphNode(pat({ status: "observation" }))).toBeUndefined();
  });

  it("library 的 anti-pattern → anti-pattern 节点并带 associations", () => {
    const node = toGraphNode(pat({ status: "library" }));
    expect(node?.kind).toBe("anti-pattern");
    expect(node?.associations.decisionType).toBe("tool-choice");
    expect(node?.associations.choiceSignature).toBe("tool-choice|agent|grep|src!");
    expect(node?.associations.distribution.projects).toEqual(["proj-a"]);
    expect(node?.confidence).toBe(0.5);
    expect(node?.statement).toContain("描述");
  });

  it("library 的 efficient-pattern → direction 节点", () => {
    const node = toGraphNode(pat({ kind: "efficient-pattern", status: "library" }));
    expect(node?.kind).toBe("direction");
  });

  it("非法输入返回 undefined 不抛", () => {
    for (const junk of [null, undefined, 1, "x", []]) {
      expect(() => toGraphNode(junk)).not.toThrow();
      expect(toGraphNode(junk)).toBeUndefined();
    }
  });
});
