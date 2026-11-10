/**
 * 证据图:稳定 id / 版本化(supersede/correct)/ 权威版与降级 / 有效期查询 / 显式冲突 /
 * 半衰期衰减 + 容量逐出 / 模型换代 rescore。全部纯数据 + 固定时间戳,不碰文件与真实时钟。
 */
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_CODES,
  EVIDENCE_SCHEMA_VERSION,
  addEvidence,
  applyDecay,
  canonicalJSON,
  conflictsOf,
  correctEvidence,
  createEvidenceGraph,
  decayScore,
  evidenceIdOf,
  historyOf,
  markAuthoritative,
  normalizeStatement,
  queryEvidence,
  rescoreForModelVersion,
  sha256hex,
  supersedeEvidence,
} from "../src/agent/evidence-graph.ts";
import type { EvidenceGraph, EvidenceNode, EvidenceNodeKind } from "../src/agent/evidence-graph.ts";

const T0 = 1_700_000_000_000;
const T1 = 1_700_000_100_000;
const DAY = 86_400_000;

const MODULE = [{ type: "module", ref: "src/a.ts" }] as const;

/** 起一张图并塞进一条默认 fact 节点,返回 {graph, node}。 */
function seed(
  statement = "retry hint cuts retries",
  partial: Partial<{ kind: EvidenceNodeKind; associations: { type: "module" | "tool" | "tip" | "task"; ref: string; label?: string }[]; confidence: number; projectId: string; modelVersion: string; observedAt: number; validFrom: number }> = {},
  at = T0): { graph: EvidenceGraph; node: EvidenceNode } {
  const res = addEvidence(
    createEvidenceGraph(),
    {
      kind: partial.kind ?? "fact",
      statement,
      associations: partial.associations ?? [...MODULE],
      confidence: partial.confidence,
      projectId: partial.projectId,
      modelVersion: partial.modelVersion,
      observedAt: partial.observedAt,
      validFrom: partial.validFrom,
      at,
    },
    { at },
  );
  expect(res.ok).toBe(true);
  return { graph: res.graph, node: res.node! };
}

/** 在既有 graph 上追加一条(必定成功,失败即测试断言炸掉)。 */
function push(graph: EvidenceGraph, statement: string, at = T0, partial: Parameters<typeof seed>[1] = {}): { graph: EvidenceGraph; node: EvidenceNode } {
  const res = addEvidence(
    graph,
    {
      kind: partial.kind ?? "fact",
      statement,
      associations: partial.associations ?? [...MODULE],
      confidence: partial.confidence,
      projectId: partial.projectId,
      modelVersion: partial.modelVersion,
      observedAt: partial.observedAt,
      validFrom: partial.validFrom,
      at,
    },
    { at },
  );
  expect(res.ok).toBe(true);
  return { graph: res.graph, node: res.node! };
}

/** 手工造节点(只用于构造历史链/环等边角数据)。 */
function bareNode(id: string, partial: Partial<EvidenceNode> = {}): EvidenceNode {
  return {
    id,
    kind: "fact",
    statement: id,
    observedAt: T0,
    validFrom: T0,
    confidence: 1,
    source: {},
    associations: [],
    status: "active",
    corrections: [],
    authoritativeness: "latest",
    createdAt: T0,
    updatedAt: T0,
    ...partial,
  };
}

describe("规范化与稳定 id", () => {
  it("normalizeStatement:trim + 空白折叠 + 小写", () => {
    expect(normalizeStatement("  Retry   HINT\n cuts\tretries ")).toBe("retry hint cuts retries");
    expect(normalizeStatement("ABC")).toBe("abc");
  });

  it("canonicalJSON:键升序、数组保序、省略 undefined", () => {
    expect(canonicalJSON({ b: 1, a: undefined, c: [2, 1] })).toBe('{"b":1,"c":[2,1]}');
    expect(canonicalJSON([{ z: 1, a: 2 }])).toBe('[{"a":2,"z":1}]');
  });

  it("sha256hex 稳定性", () => {
    expect(sha256hex("a")).toBe(sha256hex("a"));
    expect(sha256hex("a")).not.toBe(sha256hex("b"));
  });

  it("evidenceIdOf 幂等且前缀为 ev-", () => {
    const a = evidenceIdOf({ kind: "fact", statement: "Retry  hint", associations: [{ type: "module", ref: "m" }] });
    const b = evidenceIdOf({ kind: "fact", statement: "  retry hint ", associations: [{ type: "module", ref: "m" }] });
    expect(a).toBe(b);
    expect(a.startsWith("ev-")).toBe(true);
    expect(a.slice(3)).toHaveLength(16);
  });

  it("evidenceIdOf 与 association 顺序无关", () => {
    const asc = evidenceIdOf({
      kind: "insight",
      statement: "s",
      associations: [{ type: "module", ref: "a" }, { type: "tool", ref: "b" }],
    });
    const desc = evidenceIdOf({
      kind: "insight",
      statement: "s",
      associations: [{ type: "tool", ref: "b" }, { type: "module", ref: "a" }],
    });
    expect(asc).toBe(desc);
  });

  it("evidenceIdOf 随 kind / associations 变化而变化", () => {
    const base = evidenceIdOf({ kind: "fact", statement: "s", associations: [{ type: "module", ref: "a" }] });
    expect(evidenceIdOf({ kind: "insight", statement: "s", associations: [{ type: "module", ref: "a" }] })).not.toBe(base);
    expect(evidenceIdOf({ kind: "fact", statement: "s", associations: [{ type: "tool", ref: "a" }] })).not.toBe(base);
    expect(evidenceIdOf({ kind: "fact", statement: "s", associations: [] })).not.toBe(base);
  });
});

describe("addEvidence", () => {
  it("缺省字段:observedAt=validFrom=at、confidence=0.7、active、latest、无修正", () => {
    const { node } = seed("x", {}, T1);
    expect(node.observedAt).toBe(T1);
    expect(node.validFrom).toBe(T1);
    expect(node.confidence).toBeCloseTo(0.7);
    expect(node.status).toBe("active");
    expect(node.authoritativeness).toBe("latest");
    expect(node.corrections).toEqual([]);
    expect(node.createdAt).toBe(T1);
    expect(node.updatedAt).toBe(T1);
  });

  it("confidence clamp 到 [0,1]", () => {
    expect(seed("a", { confidence: 3 }).node.confidence).toBe(1);
    expect(seed("b", { confidence: -2 }).node.confidence).toBe(0);
  });

  it("schemaVersion = 1", () => {
    expect(createEvidenceGraph()).toEqual({ schemaVersion: EVIDENCE_SCHEMA_VERSION, nodes: {} });
    expect(EVIDENCE_SCHEMA_VERSION).toBe(1);
  });

  it("非法 kind / 空 statement → EVIDENCE_INVALID_INPUT 且 graph 不变", () => {
    const g = createEvidenceGraph();
    const badKind = addEvidence(g, { kind: "rumor" as EvidenceNodeKind, statement: "s", at: T0 }, { at: T0 });
    expect(badKind.ok).toBe(false);
    expect(badKind.code).toBe(EVIDENCE_CODES.INVALID_INPUT);
    const empty = addEvidence(g, { kind: "fact", statement: "   ", at: T0 }, { at: T0 });
    expect(empty.code).toBe(EVIDENCE_CODES.INVALID_INPUT);
    expect(Object.keys(g.nodes)).toHaveLength(0);
  });

  it("重复 add → EVIDENCE_DUPLICATE 且返回既有节点,graph 不变", () => {
    const first = seed("same statement");
    const again = addEvidence(first.graph, { kind: "fact", statement: "same statement", associations: [...MODULE], at: T1 }, { at: T1 });
    expect(again.ok).toBe(false);
    expect(again.code).toBe(EVIDENCE_CODES.DUPLICATE);
    expect(again.node!.id).toBe(first.node.id);
    expect(again.node!.createdAt).toBe(T0);
    expect(Object.keys(again.graph.nodes)).toHaveLength(1);
  });

  it("语句相同但 associations 不同 → 两个节点、不同 id", () => {
    const a = seed("同一句话", { associations: [{ type: "module", ref: "m1" }] });
    const b = push(a.graph, "同一句话", T0, { associations: [{ type: "module", ref: "m2" }] });
    expect(b.node.id).not.toBe(a.node.id);
    expect(Object.keys(b.graph.nodes)).toHaveLength(2);
  });

  it("不修改入参 graph(纯函数)", () => {
    const g = createEvidenceGraph();
    const res = addEvidence(g, { kind: "fact", statement: "pure", at: T0 }, { at: T0 });
    expect(res.graph).not.toBe(g);
    expect(Object.keys(g.nodes)).toHaveLength(0);
  });
});

describe("supersedeEvidence", () => {
  it("双向指针 + 旧版保留可查", () => {
    const a = seed("old claim");
    const res = supersedeEvidence(a.graph, a.node.id, { kind: "fact", statement: "new claim", associations: [...MODULE], at: T1 }, { by: "genie", reason: "新实验推翻", at: T1 });
    expect(res.ok).toBe(true);
    const oldNode = res.graph.nodes[a.node.id]!;
    const newNode = res.node!;
    expect(oldNode.validTo).toBe(T1);
    expect(oldNode.supersededBy).toBe(newNode.id);
    expect(oldNode.updatedAt).toBe(T1);
    expect(oldNode.status).toBe("active");
    expect(newNode.supersedes).toBe(a.node.id);
    expect(newNode.validFrom).toBe(T1);
    expect(newNode.authoritativeness).toBe("latest");
    expect(Object.keys(res.graph.nodes)).toHaveLength(2);
  });

  it("缺 by 或 reason → INVALID_INPUT;id 不存在 → NOT_FOUND", () => {
    const a = seed("s1");
    const noBy = supersedeEvidence(a.graph, a.node.id, { kind: "fact", statement: "s2", at: T1 }, { reason: "r", at: T1 });
    expect(noBy.code).toBe(EVIDENCE_CODES.INVALID_INPUT);
    const noReason = supersedeEvidence(a.graph, a.node.id, { kind: "fact", statement: "s2", at: T1 }, { by: "g", at: T1 });
    expect(noReason.code).toBe(EVIDENCE_CODES.INVALID_INPUT);
    const missing = supersedeEvidence(a.graph, "ev-nope", { kind: "fact", statement: "s2", at: T1 }, { by: "g", reason: "r", at: T1 });
    expect(missing.code).toBe(EVIDENCE_CODES.NOT_FOUND);
    expect(Object.keys(a.graph.nodes)).toHaveLength(1);
  });

  it("同说法 supersede 时走版本 id,两条记录都留下", () => {
    const a = seed("identical claim");
    const res = supersedeEvidence(a.graph, a.node.id, { kind: "fact", statement: "identical claim", associations: [...MODULE], at: T1 }, { by: "g", reason: "复核", at: T1 });
    expect(res.ok).toBe(true);
    expect(res.node!.id).not.toBe(a.node.id);
    expect(Object.keys(res.graph.nodes)).toHaveLength(2);
    expect(res.graph.nodes[a.node.id]!.supersededBy).toBe(res.node!.id);
  });
});

describe("correctEvidence", () => {
  it("产生新版本:旧版 validTo + supersededBy,新版 corrections.fromStatement", () => {
    const a = seed("原说法");
    const res = correctEvidence(a.graph, a.node.id, { statement: "新说法", by: "genie", reason: "补样本", at: T1 });
    expect(res.ok).toBe(true);
    const newNode = res.node!;
    expect(newNode.supersedes).toBe(a.node.id);
    expect(newNode.statement).toBe("新说法");
    expect(newNode.observedAt).toBe(T1);
    expect(newNode.validFrom).toBe(T1);
    expect(newNode.corrections).toHaveLength(1);
    expect(newNode.corrections[0]).toEqual({ at: T1, by: "genie", reason: "补样本", fromStatement: "原说法" });
    expect(res.graph.nodes[a.node.id]!.validTo).toBe(T1);
    expect(res.graph.nodes[a.node.id]!.supersededBy).toBe(newNode.id);
    expect(Object.keys(res.graph.nodes)).toHaveLength(2);
  });

  it("复制 kind/associations/source/modelVersion/projectId", () => {
    const res0 = addEvidence(
      createEvidenceGraph(),
      {
        kind: "anti-pattern",
        statement: "别在热点路径上加校验",
        associations: [{ type: "tip", ref: "tips/perf" }],
        source: { sessionId: "s-1", note: "trace" },
        modelVersion: "claude-a",
        projectId: "p1",
        at: T0,
      },
      { at: T0 },
    );
    const res = correctEvidence(res0.graph, res0.node!.id, { confidence: 0.9, by: "g", reason: "复核", at: T1 });
    const newNode = res.node!;
    expect(newNode.kind).toBe("anti-pattern");
    expect(newNode.associations).toEqual([{ type: "tip", ref: "tips/perf" }]);
    expect(newNode.source).toEqual({ sessionId: "s-1", note: "trace" });
    expect(newNode.modelVersion).toBe("claude-a");
    expect(newNode.projectId).toBe("p1");
    expect(newNode.confidence).toBeCloseTo(0.9);
  });

  it("仅改 confidence 时使用版本 id,旧节点仍可查", () => {
    const a = seed("稳定说法", { confidence: 0.6 });
    const res = correctEvidence(a.graph, a.node.id, { confidence: 0.95, by: "g", reason: "更多样本", at: T1 });
    expect(res.ok).toBe(true);
    expect(res.node!.id).not.toBe(a.node.id);
    expect(res.node!.id).not.toBe(evidenceIdOf({ kind: "fact", statement: "稳定说法", associations: [...MODULE] }));
    expect(res.graph.nodes[a.node.id]!.supersededBy).toBe(res.node!.id);
    expect(res.graph.nodes[a.node.id]!.statement).toBe("稳定说法");
    expect(Object.keys(res.graph.nodes)).toHaveLength(2);
  });

  it("连续修正累积 corrections", () => {
    const a = seed("v0");
    const one = correctEvidence(a.graph, a.node.id, { statement: "v1", by: "g", reason: "r1", at: T1 });
    const two = correctEvidence(one.graph, one.node!.id, { statement: "v2", by: "g", reason: "r2", at: T1 + 1000 });
    expect(two.node!.corrections).toHaveLength(2);
    expect(two.node!.corrections.map((c) => c.fromStatement)).toEqual(["v0", "v1"]);
  });

  it("缺 by/reason → INVALID;不存在 → NOT_FOUND", () => {
    const a = seed("c1");
    expect(correctEvidence(a.graph, a.node.id, { statement: "c2", reason: "r", at: T1 }).code).toBe(EVIDENCE_CODES.INVALID_INPUT);
    expect(correctEvidence(a.graph, a.node.id, { statement: "c2", by: "g", at: T1 }).code).toBe(EVIDENCE_CODES.INVALID_INPUT);
    expect(correctEvidence(a.graph, "ev-missing", { by: "g", reason: "r", at: T1 }).code).toBe(EVIDENCE_CODES.NOT_FOUND);
    expect(Object.keys(a.graph.nodes)).toHaveLength(1);
  });
});

describe("markAuthoritative", () => {
  it("目标置 authoritative,冲突组内其它节点降为 latest", () => {
    const a = seed("结论 A");
    const b = push(a.graph, "结论 B", T1);
    const first = markAuthoritative(b.graph, a.node.id);
    expect(first.ok).toBe(true);
    expect(first.graph.nodes[a.node.id]!.authoritativeness).toBe("authoritative");
    const second = markAuthoritative(first.graph, b.node.id);
    expect(second.graph.nodes[b.node.id]!.authoritativeness).toBe("authoritative");
    expect(second.graph.nodes[a.node.id]!.authoritativeness).toBe("latest");
    expect(second.demoted).toEqual([a.node.id]);
  });

  it("不同 kind 或不同 association 不降级", () => {
    const a = seed("结论 A");
    const b = push(a.graph, "结论 B", T1, { kind: "insight" });
    const withAuth = markAuthoritative(b.graph, a.node.id);
    const res = markAuthoritative(withAuth.graph, b.node.id);
    expect(res.demoted).toEqual([]);
    expect(res.graph.nodes[a.node.id]!.authoritativeness).toBe("authoritative");

    const other = push(withAuth.graph, "结论 C", T1, { associations: [{ type: "module", ref: "other.ts" }] });
    const res2 = markAuthoritative(other.graph, other.node.id);
    expect(res2.demoted).toEqual([]);
  });

  it("id 不存在 → NOT_FOUND", () => {
    const a = seed("x");
    const res = markAuthoritative(a.graph, "ev-gone");
    expect(res.ok).toBe(false);
    expect(res.code).toBe(EVIDENCE_CODES.NOT_FOUND);
    expect(res.demoted).toEqual([]);
  });
});

describe("queryEvidence", () => {
  it("默认只返回 at 时有效且 active 的节点", () => {
    const a = seed("q1");
    const sup = supersedeEvidence(a.graph, a.node.id, { kind: "fact", statement: "q2", associations: [...MODULE], at: T1 }, { by: "g", reason: "r", at: T1 });
    expect(queryEvidence(sup.graph, { at: T0 }).map((n) => n.statement)).toEqual(["q1"]);
    expect(queryEvidence(sup.graph, { at: T1 }).map((n) => n.statement)).toEqual(["q2"]);
  });

  it("validTo 排他、validFrom 包含", () => {
    const a = seed("edge", {}, T1);
    expect(queryEvidence(a.graph, { at: T1 })).toHaveLength(1);
    expect(queryEvidence(a.graph, { at: T1 - 1 })).toHaveLength(0);
    const closed = a.graph.nodes[a.node.id]!;
    closed.validTo = T1 + 10;
    expect(queryEvidence(a.graph, { at: T1 + 9 })).toHaveLength(1);
    expect(queryEvidence(a.graph, { at: T1 + 10 })).toHaveLength(0);
  });

  it("includeHistory 返回全部版本(不做有效期过滤)", () => {
    const a = seed("h1");
    const sup = supersedeEvidence(a.graph, a.node.id, { kind: "fact", statement: "h2", associations: [...MODULE], at: T1 }, { by: "g", reason: "r", at: T1 });
    const all = queryEvidence(sup.graph, { at: T1, includeHistory: true });
    expect(all).toHaveLength(2);
    expect(all.map((n) => n.statement)).toEqual(["h2", "h1"]);
  });

  it("status 单值与数组", () => {
    const a = seed("s1");
    const decayed = applyDecay(a.graph, { at: T0 + 30 * DAY, halfLifeDays: 7, staleBelow: 0.9 });
    expect(queryEvidence(decayed.graph, { at: T0 + 30 * DAY, status: "stale" })).toHaveLength(1);
    expect(queryEvidence(decayed.graph, { at: T0 + 30 * DAY, status: ["active", "stale"] })).toHaveLength(1);
    expect(queryEvidence(decayed.graph, { at: T0 + 30 * DAY })).toHaveLength(0);
  });

  it("authoritativeOnly 只留权威版", () => {
    const a = seed("auth A");
    const b = push(a.graph, "auth B", T1);
    const marked = markAuthoritative(b.graph, a.node.id);
    const out = queryEvidence(marked.graph, { at: T1, authoritativeOnly: true });
    expect(out.map((n) => n.id)).toEqual([a.node.id]);
  });

  it("projectId / module / tool / tip 过滤", () => {
    const a = seed("p-node", { projectId: "p1" });
    const b = push(a.graph, "p2-node", T0, { projectId: "p2", associations: [{ type: "module", ref: "m2" }] });
    const c = push(b.graph, "tool-node", T0, { associations: [{ type: "tool", ref: "bash" }] });
    const d = push(c.graph, "tip-node", T0, { associations: [{ type: "tip", ref: "tips/retry" }] });
    expect(queryEvidence(d.graph, { at: T0, projectId: "p1" }).map((n) => n.statement)).toEqual(["p-node"]);
    expect(queryEvidence(d.graph, { at: T0, module: "m2" }).map((n) => n.statement)).toEqual(["p2-node"]);
    expect(queryEvidence(d.graph, { at: T0, tool: "bash" }).map((n) => n.statement)).toEqual(["tool-node"]);
    expect(queryEvidence(d.graph, { at: T0, tip: "tips/retry" }).map((n) => n.statement)).toEqual(["tip-node"]);
    expect(queryEvidence(d.graph, { at: T0, tool: "nope" })).toEqual([]);
  });

  it("kind 过滤与稳定排序:validFrom desc → observedAt desc → id asc", () => {
    const a = seed("第一句", {}, T0);
    const b = push(a.graph, "第二句", T1);
    const list = queryEvidence(b.graph, { at: T1 });
    expect(list.map((n) => n.statement)).toEqual(["第二句", "第一句"]);
    expect(queryEvidence(b.graph, { at: T1, kind: "insight" })).toEqual([]);
    const tie = push(b.graph, "同刻", T1);
    const ids = queryEvidence(tie.graph, { at: T1 }).filter((n) => n.validFrom === T1).map((n) => n.id);
    expect(ids).toEqual(ids.slice().sort());
  });
});

describe("conflictsOf", () => {
  it("同 association 的矛盾结论显式并存,latestId 取最新", () => {
    const a = seed("结论甲");
    const b = push(a.graph, "结论乙", T1);
    const conflicts = conflictsOf(b.graph, T1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].associationKey).toBe("module:src/a.ts");
    expect(conflicts[0].nodes.map((n) => n.id)).toEqual([b.node.id, a.node.id]);
    expect(conflicts[0].latestId).toBe(b.node.id);
    expect(conflicts[0].authoritativeId).toBeUndefined();
    // 显式并存:节点一个都没删
    expect(Object.keys(b.graph.nodes)).toHaveLength(2);
  });

  it("指定权威版后 authoritativeId 出现", () => {
    const a = seed("坏结论");
    const b = push(a.graph, "好结论", T1);
    const marked = markAuthoritative(b.graph, a.node.id);
    const conflicts = conflictsOf(marked.graph, T1);
    expect(conflicts[0].authoritativeId).toBe(a.node.id);
    expect(conflicts[0].latestId).toBe(b.node.id);
  });

  it("相同说法不成组;无共享 association 不成组;归档节点不参与", () => {
    const a = seed("同一说法");
    // 说法相同(规范化后同一句)即使并列成两个节点也不构成冲突
    const manual: EvidenceGraph = { schemaVersion: EVIDENCE_SCHEMA_VERSION, nodes: {} };
    manual.nodes.n1 = bareNode("n1", { statement: "同一说法", associations: [{ type: "module", ref: "src/a.ts" }] });
    manual.nodes.n2 = bareNode("n2", { statement: " 同一说法 ", associations: [{ type: "module", ref: "src/a.ts" }] });
    expect(conflictsOf(manual, T0)).toEqual([]);

    const other = push(a.graph, "别的说法", T1, { associations: [{ type: "module", ref: "other.ts" }] });
    expect(conflictsOf(other.graph, T1)).toEqual([]);

    const b = push(a.graph, "冲突说法", T1);
    b.graph.nodes[b.node.id]!.status = "archived";
    expect(conflictsOf(b.graph, T1)).toEqual([]);
  });
});

describe("historyOf", () => {
  it("oldest → newest 版本链", () => {
    const a = seed("v0");
    const one = correctEvidence(a.graph, a.node.id, { statement: "v1", by: "g", reason: "r1", at: T1 });
    const two = correctEvidence(one.graph, one.node!.id, { statement: "v2", by: "g", reason: "r2", at: T1 + 1000 });
    expect(historyOf(two.graph, two.node!.id).map((n) => n.statement)).toEqual(["v0", "v1", "v2"]);
    expect(historyOf(two.graph, a.node.id).map((n) => n.statement)).toEqual(["v0", "v1", "v2"]);
  });

  it("不存在返回空数组", () => {
    const a = seed("solo");
    expect(historyOf(a.graph, "ev-nope")).toEqual([]);
  });

  it("环保护:手造环只返回有限链条", () => {
    const graph: EvidenceGraph = { schemaVersion: EVIDENCE_SCHEMA_VERSION, nodes: {} };
    graph.nodes.a = bareNode("a", { supersedes: "b", supersededBy: "b" });
    graph.nodes.b = bareNode("b", { supersedes: "a", supersededBy: "a" });
    const chain = historyOf(graph, "a");
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.length).toBeLessThanOrEqual(2);
  });
});

describe("decayScore / applyDecay", () => {
  it("at=validFrom 时等于 confidence", () => {
    const { node } = seed("d1", { confidence: 0.8 }, T1);
    expect(decayScore(node, { at: T1, halfLifeDays: 7 })).toBeCloseTo(0.8);
  });

  it("一个半衰期后为 0.5*confidence", () => {
    const { node } = seed("d2", { confidence: 0.9 }, T0);
    expect(decayScore(node, { at: T0 + 7 * DAY, halfLifeDays: 7 })).toBeCloseTo(0.45);
    expect(decayScore(node, { at: T0 + 14 * DAY, halfLifeDays: 7 })).toBeCloseTo(0.225);
  });

  it("halfLifeDays<=0 不衰减;未来 validFrom 按 age=0", () => {
    const { node } = seed("d3", { confidence: 0.6 }, T0);
    expect(decayScore(node, { at: T0 + 100 * DAY, halfLifeDays: 0 })).toBeCloseTo(0.6);
    expect(decayScore(node, { at: T0 - DAY, halfLifeDays: 7 })).toBeCloseTo(0.6);
  });

  it("阈值置 stale,节点保留", () => {
    const a = seed("stale-me", { confidence: 1 }, T0);
    const res = applyDecay(a.graph, { at: T0 + 7 * DAY, halfLifeDays: 7, staleBelow: 0.6 });
    expect(res.ok).toBe(true);
    const node = res.graph.nodes[a.node.id]!;
    expect(node.status).toBe("stale");
    expect(node.staleAt).toBe(T0 + 7 * DAY);
    expect(res.report.stale).toBe(1);
    expect(res.report.staleIds).toEqual([a.node.id]);
    expect(res.report.archived).toBe(0);
    expect(res.report.rescored).toBe(0);
    expect(res.report.at).toBe(T0 + 7 * DAY);
  });

  it("archiveBelow 置 archived,不物理删且不动 validTo", () => {
    const a = seed("archive-me", { confidence: 1 }, T0);
    const res = applyDecay(a.graph, { at: T0 + 21 * DAY, halfLifeDays: 7, staleBelow: 0.6, archiveBelow: 0.2 });
    const node = res.graph.nodes[a.node.id]!;
    expect(node.status).toBe("archived");
    expect(node.archivedReason).toBe("decay");
    expect(node.archivedAt).toBe(T0 + 21 * DAY);
    expect(node.validTo).toBeUndefined();
    expect(Object.keys(res.graph.nodes)).toHaveLength(1);
    expect(res.report.archivedIds).toEqual([a.node.id]);
    expect(res.report.archived).toBe(1);
  });

  it("maxNodes 逐出低分节点(archivedReason=capacity)且 report 计数", () => {
    const a = seed("high", { confidence: 0.95 }, T0);
    const b = push(a.graph, "mid", T0, { confidence: 0.8 });
    const c = push(b.graph, "low", T0, { confidence: 0.5 });
    const res = applyDecay(c.graph, { at: T0, halfLifeDays: 7, staleBelow: 0, maxNodes: 2 });
    expect(res.ok).toBe(true);
    expect(res.report.evicted).toBe(1);
    expect(res.report.evictedIds).toEqual([c.node.id]);
    expect(res.graph.nodes[c.node.id]!.status).toBe("archived");
    expect(res.graph.nodes[c.node.id]!.archivedReason).toBe("capacity");
    expect(res.graph.nodes[b.node.id]!.status).toBe("active");
    expect(Object.keys(res.graph.nodes)).toHaveLength(3);
    expect(queryEvidence(res.graph, { at: T0 })).toHaveLength(2);
  });

  it("maxNodes=0 全部逐出;非法 policy → INVALID_INPUT", () => {
    const a = seed("only", { confidence: 1 }, T0);
    const zero = applyDecay(a.graph, { at: T0, halfLifeDays: 7, staleBelow: 0, maxNodes: 0 });
    expect(zero.report.evicted).toBe(1);
    expect(Object.keys(zero.graph.nodes)).toHaveLength(1);

    const bad = applyDecay(a.graph, { at: T0, halfLifeDays: 0, staleBelow: 0.5 } as never);
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe(EVIDENCE_CODES.INVALID_INPUT);
    const badMax = applyDecay(a.graph, { at: T0, halfLifeDays: 7, staleBelow: 0.5, maxNodes: -1 });
    expect(badMax.code).toBe(EVIDENCE_CODES.INVALID_INPUT);
    expect(Object.keys(a.graph.nodes)).toHaveLength(1);
  });
});

describe("rescoreForModelVersion", () => {
  it("旧模型版本的 active 节点置 stale(model-version),不归档", () => {
    const a = seed("旧模型结论", { modelVersion: "model-a" }, T0);
    const b = push(a.graph, "新模型结论", T0, { modelVersion: "model-b" });
    const c = push(b.graph, "无版本结论", T0);
    const res = rescoreForModelVersion(c.graph, "model-b", { at: T1 });
    expect(res.ok).toBe(true);
    expect(res.rescored).toEqual([a.node.id]);
    const stale = res.graph.nodes[a.node.id]!;
    expect(stale.status).toBe("stale");
    expect(stale.staleReason).toBe("model-version");
    expect(stale.staleAt).toBe(T1);
    expect(stale.archivedAt).toBeUndefined();
    expect(res.graph.nodes[b.node.id]!.status).toBe("active");
    expect(res.graph.nodes[c.node.id]!.status).toBe("active");
    expect(Object.keys(res.graph.nodes)).toHaveLength(3);
  });

  it("空 modelVersion → INVALID_INPUT", () => {
    const a = seed("x", { modelVersion: "model-a" });
    const res = rescoreForModelVersion(a.graph, "   ");
    expect(res.ok).toBe(false);
    expect(res.code).toBe(EVIDENCE_CODES.INVALID_INPUT);
    expect(res.rescored).toEqual([]);
  });
});

describe("健壮性", () => {
  it("非法/垃圾输入不抛异常", () => {
    const g = createEvidenceGraph();
    expect(() => addEvidence(null as never, null as never)).not.toThrow();
    expect(() => addEvidence(g, undefined as never)).not.toThrow();
    expect(() => supersedeEvidence(g, "", {} as never, {})).not.toThrow();
    expect(() => correctEvidence(g, "ev-x", undefined as never)).not.toThrow();
    expect(() => markAuthoritative(g, "")).not.toThrow();
    expect(() => queryEvidence(null as never, {} as never)).not.toThrow();
    expect(() => queryEvidence(g, { at: Number.NaN })).not.toThrow();
    expect(() => conflictsOf(null as never)).not.toThrow();
    expect(() => historyOf(g, "ev-x")).not.toThrow();
    expect(() => decayScore({} as never, {} as never)).not.toThrow();
    expect(() => applyDecay(g, {} as never)).not.toThrow();
    expect(() => rescoreForModelVersion(null as never, "m")).not.toThrow();
    expect(addEvidence(null as never, null as never).ok).toBe(false);
    expect(addEvidence(null as never, null as never).code).toBe(EVIDENCE_CODES.INVALID_INPUT);
    expect(applyDecay(g, {} as never).code).toBe(EVIDENCE_CODES.INVALID_INPUT);
    expect(decayScore(null as never, {})).toBe(0);
    expect(decayScore({} as never, {})).toBeGreaterThanOrEqual(0);
  });

  it("NaN / 非法时间不产生非法节点", () => {
    const res = addEvidence(g_new(), { kind: "fact", statement: "nan time", observedAt: Number.NaN, validFrom: Number.NaN, at: T0 }, { at: T0 });
    expect(res.ok).toBe(true);
    expect(res.node!.observedAt).toBe(T0);
    expect(res.node!.validFrom).toBe(T0);
  });
});

function g_new(): EvidenceGraph {
  return createEvidenceGraph();
}
