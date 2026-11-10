/**
 * 缺陷血缘:投票 → 置信度 → 类别 → 漏点 → 链 → 证据图投影。
 * 全部纯数据 + 固定时间戳常量,不碰文件与真实时钟。
 */
import { describe, expect, it } from "vitest";
import {
  DEFECT_CODES,
  DEFECT_LINEAGE_VERSION,
  buildLineage,
  classifyLineage,
  inferMissedLink,
  resolveConfidence,
  toEvidenceGraphInputs,
  voteEvidence,
} from "../src/agent/defect-lineage.ts";
import type { DefectRecord, EvidenceVote, SourceTaskEvidence } from "../src/agent/defect-lineage.ts";

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

function defect(partial: Partial<DefectRecord> = {}): DefectRecord {
  return {
    id: "D-1",
    fixTaskId: "TFIX-1",
    description: "retry loop double fires",
    module: "src/agent",
    files: ["src/agent/a.ts", "src/agent/b.ts"],
    fixedAt: T0,
    category: "unknown",
    confidence: "low",
    ...partial,
  };
}

function source(partial: Partial<SourceTaskEvidence> = {}): SourceTaskEvidence {
  return {
    taskId: "T-1",
    filesChanged: ["src/agent/a.ts"],
    at: T0 - DAY,
    text: "改了 a.ts 的重试",
    ...partial,
  };
}

/** 能把计划/验证/影响面都覆盖到的最小"干净"交付。 */
function completeSource(partial: Partial<SourceTaskEvidence> = {}): SourceTaskEvidence {
  return source({
    module: "src/agent",
    filesChanged: ["src/agent/a.ts"],
    testsChanged: ["src/agent/a.ts"],
    text: "模块 src/agent 的 retry 修复",
    plan: { nodes: [{ id: "n1", label: "retry", targets: ["src/agent/a.ts"] }] },
    verification: { commands: ["npx vitest run test/a.test.ts"], evidenceRefs: ["ev-1"] },
    codeSenseUsed: true,
    ...partial,
  });
}

/** 与缺陷毫无交集的交付。 */
function unrelatedSource(partial: Partial<SourceTaskEvidence> = {}): SourceTaskEvidence {
  return source({ module: "docs", filesChanged: ["docs/readme.md"], text: "改文档措辞", ...partial });
}

function voteKinds(votes: EvidenceVote[]): string[] {
  return votes.map((vote) => vote.kind);
}

describe("voteEvidence:强证据三路子", () => {
  it("blame 同提交同文件 → 一票 strong", () => {
    const votes = voteEvidence(
      defect({ blame: [{ file: "src/agent/a.ts", line: 12, commit: "abc123" }] }),
      source({ commit: "abc123", filesChanged: ["src/agent/a.ts"], text: undefined }),
    );
    expect(voteKinds(votes)).toEqual(["strong"]);
    expect(votes[0]?.note).toContain("abc123");
  });

  it("blame 同提交但文件不在改动列表 → 不出 strong(仅同提交不够)", () => {
    const votes = voteEvidence(
      defect({ blame: [{ file: "src/agent/a.ts", line: 12, commit: "abc123" }] }),
      source({ commit: "abc123", filesChanged: ["docs/other.md"], text: undefined }),
    );
    expect(votes).toEqual([]);
  });

  it("测试改动命中缺陷文件 → 一票 strong", () => {
    const votes = voteEvidence(defect(), source({ testsChanged: ["src/agent/a.ts"], filesChanged: ["docs/x.md"], text: undefined }));
    expect(voteKinds(votes)).toEqual(["strong"]);
    expect(votes[0]?.note).toContain("测试改动");
  });

  it("交付描述点名缺陷 module → 一票 strong", () => {
    const votes = voteEvidence(defect(), source({ text: "顺手整理了 src/agent 的日志", filesChanged: ["docs/x.md"] }));
    expect(voteKinds(votes)).toEqual(["strong"]);
    expect(votes[0]?.note).toContain("src/agent");
  });

  it("三条理由同时成立 → 三票 strong 并存", () => {
    const votes = voteEvidence(
      defect({ blame: [{ file: "src/agent/a.ts", line: 1, commit: "c9" }] }),
      source({
        commit: "c9",
        filesChanged: ["src/agent/a.ts"],
        testsChanged: ["src/agent/a.ts"],
        text: "src/agent 的重试修复",
      }),
    );
    expect(voteKinds(votes)).toEqual(["strong", "strong", "strong"]);
  });

  it("module 大小写不敏感命中 → strong", () => {
    const votes = voteEvidence(defect(), source({ text: "SRC/Agent 目录统一收口", filesChanged: ["docs/x.md"] }));
    expect(voteKinds(votes)).toEqual(["strong"]);
  });
});

describe("voteEvidence:强证据门槛与归一化", () => {
  it("测试改动与缺陷文件用反斜杠/./ 归一后仍算强证据", () => {
    const votes = voteEvidence(
      defect({ files: ["src/agent/a.ts"] }),
      source({ testsChanged: ["./src\\agent\\a.ts"], filesChanged: ["docs/x.md"], text: undefined }),
    );
    expect(voteKinds(votes)).toEqual(["strong"]);
  });

  it("basename 相等也算同一文件(src\\agent\\a.ts ≡ ./a.ts)", () => {
    const votes = voteEvidence(
      defect({ files: ["src/agent/a.ts"] }),
      source({ testsChanged: ["a.ts"], filesChanged: ["docs/x.md"], text: undefined }),
    );
    expect(voteKinds(votes)).toEqual(["strong"]);
  });

  it("无任何交集 → 0 票", () => {
    expect(voteEvidence(defect(), unrelatedSource())).toEqual([]);
  });

  it("仅路径交集 → 一票 weak", () => {
    const votes = voteEvidence(defect(), source({ filesChanged: ["src/agent/b.ts"], text: undefined }));
    expect(voteKinds(votes)).toEqual(["weak"]);
  });

  it("中证据三条件全满足 → 一票 medium", () => {
    const votes = voteEvidence(defect(), source({ text: "改了 a.ts 的重试", module: "src/agent", at: T0 - DAY, filesChanged: ["src/agent/a.ts"] }));
    expect(voteKinds(votes)).toEqual(["medium"]);
  });

  it("语义未命中时中证据不成立,只余 weak", () => {
    const votes = voteEvidence(defect(), source({ text: "改了点别的", module: "src/agent", at: T0 - DAY, filesChanged: ["src/agent/a.ts"] }));
    expect(voteKinds(votes)).toEqual(["weak"]);
  });

  it("时间远离 14 天窗口 → 中证据不成立,只余 weak", () => {
    const votes = voteEvidence(defect(), source({ text: "改了 a.ts 的重试", module: "src/agent", at: T0 - 30 * DAY }));
    expect(voteKinds(votes)).toEqual(["weak"]);
  });
});

describe("resolveConfidence:强中证据门槛", () => {
  it("≥1 张 strong → high + LINK_STRONG", () => {
    const res = resolveConfidence([{ kind: "strong", note: "s" }]);
    expect(res.confidence).toBe("high");
    expect(res.codes).toEqual([DEFECT_CODES.LINK_STRONG]);
  });

  it("中等证据门槛:两张 medium 才够 medium,一张只算 low", () => {
    const two = resolveConfidence([
      { kind: "medium", note: "m1" },
      { kind: "medium", note: "m2" },
    ]);
    expect(two.confidence).toBe("medium");
    expect(two.codes).toEqual([DEFECT_CODES.LINK_MEDIUM]);
    const one = resolveConfidence([{ kind: "medium", note: "m1" }]);
    expect(one.confidence).toBe("low");
    expect(one.codes).toEqual([DEFECT_CODES.LINK_WEAK]);
  });

  it("strong 存在时 medium 数量不影响结论", () => {
    const res = resolveConfidence([
      { kind: "medium", note: "m1" },
      { kind: "strong", note: "s" },
      { kind: "medium", note: "m2" },
    ]);
    expect(res.confidence).toBe("high");
  });

  it("仅 weak → low", () => {
    expect(resolveConfidence([{ kind: "weak", note: "w" }])).toEqual({
      confidence: "low",
      codes: [DEFECT_CODES.LINK_WEAK],
    });
  });

  it("空票 → low", () => {
    expect(resolveConfidence([]).confidence).toBe("low");
    expect(resolveConfidence(null as any).codes).toEqual([DEFECT_CODES.LINK_WEAK]);
  });
});

describe("classifyLineage:五类分类", () => {
  it("同模块且描述命中重构语义 → refactor", () => {
    const res = classifyLineage(defect(), source({ module: "src/agent", text: "统一重试逻辑" }));
    expect(res.category).toBe("refactor");
    expect(res.codes).toEqual([DEFECT_CODES.CATEGORY_UNKNOWN]);
  });

  it("refactor 也认得 rename 线索", () => {
    expect(classifyLineage(defect(), source({ module: "src/agent", text: "rename helpers" })).category).toBe("refactor");
  });

  it("有文件交集且验证覆盖存在 → rework", () => {
    const res = classifyLineage(defect(), completeSource());
    expect(res.category).toBe("rework");
    expect(res.codes).toEqual([]);
  });

  it("无文件交集 → unrelated", () => {
    const res = classifyLineage(defect(), unrelatedSource());
    expect(res.category).toBe("unrelated");
    expect(res.codes).toEqual([]);
  });

  it("有交集但无验证覆盖 → drift", () => {
    const res = classifyLineage(defect(), source({ module: "src/agent", filesChanged: ["src/agent/a.ts"] }));
    expect(res.category).toBe("drift");
    expect(res.codes).toEqual([]);
  });

  it("时间远离不影响类别判定(仍 drift)", () => {
    const res = classifyLineage(defect(), source({ filesChanged: ["src/agent/a.ts"], at: T0 - 90 * DAY }));
    expect(res.category).toBe("drift");
  });

  it("非法输入 → unknown + CATEGORY_UNKNOWN", () => {
    expect(classifyLineage(null as any, undefined as any)).toEqual({
      category: "unknown",
      codes: [DEFECT_CODES.CATEGORY_UNKNOWN],
    });
  });
});

describe("inferMissedLink:七类漏点", () => {
  it("knowledge-gap:历史同类缺陷存在且有 evidenceRefs", () => {
    const res = inferMissedLink(defect({ evidenceRefs: ["ev-9"] }), completeSource(), {
      priorDefects: [defect({ id: "D-0", module: "src/agent" })],
    });
    expect(res.missedLink).toBe("knowledge-gap");
    expect(res.codes).toEqual([]);
    expect(res.rationale).toContain("priorDefects");
  });

  it("knowledge-gap:同一缺陷自己不算历史", () => {
    const res = inferMissedLink(defect({ evidenceRefs: ["ev-9"] }), completeSource(), { priorDefects: [defect()] });
    expect(res.missedLink).toBe("none");
  });

  it("requirement:交付描述为空", () => {
    const res = inferMissedLink(defect(), completeSource({ text: undefined }));
    expect(res.missedLink).toBe("requirement");
    expect(res.rationale).toContain("source.text");
  });

  it("requirement:描述未提到缺陷模块", () => {
    const res = inferMissedLink(defect(), completeSource({ text: "修了一下重试" }));
    expect(res.missedLink).toBe("requirement");
  });

  it("plan-coverage:计划缺失", () => {
    const res = inferMissedLink(defect(), completeSource({ plan: undefined }));
    expect(res.missedLink).toBe("plan-coverage");
    expect(res.rationale).toContain("plan");
  });

  it("plan-coverage:节点 targets 未命中文件/模块", () => {
    const res = inferMissedLink(defect(), completeSource({ plan: { nodes: [{ id: "n1", label: "docs", targets: ["docs/x.md"] }] } }));
    expect(res.missedLink).toBe("plan-coverage");
    expect(res.rationale).toContain("targets");
  });

  it("verification-coverage:验证信息全空", () => {
    const res = inferMissedLink(defect(), completeSource({ verification: undefined, boardEvidenceRefs: [] }));
    expect(res.missedLink).toBe("verification-coverage");
    expect(res.rationale).toContain("verification");
  });

  it("impact-analysis:有模块但 codeSenseUsed=false", () => {
    const res = inferMissedLink(defect(), completeSource({ codeSenseUsed: false }));
    expect(res.missedLink).toBe("impact-analysis");
    expect(res.rationale).toContain("codeSenseUsed");
  });

  it("tool-gap:codeSenseUsed=false 且无模块", () => {
    const res = inferMissedLink(defect({ module: undefined }), completeSource({ module: undefined, codeSenseUsed: false }));
    expect(res.missedLink).toBe("tool-gap");
    expect(res.rationale).toContain("codeSenseUsed");
  });

  it("tool-gap:filesChanged 为空", () => {
    const res = inferMissedLink(defect(), completeSource({ filesChanged: [] }));
    expect(res.missedLink).toBe("tool-gap");
    expect(res.rationale).toContain("filesChanged");
  });

  it("wrong-assumption:描述承认未复核的假设", () => {
    const res = inferMissedLink(defect(), completeSource({ text: "模块 src/agent 的假设默认成立" }));
    expect(res.missedLink).toBe("wrong-assumption");
    expect(res.rationale).toContain("source.text");
  });

  it("none:所有防线都在,证据不足不指认漏点", () => {
    const res = inferMissedLink(defect(), completeSource());
    expect(res.missedLink).toBe("none");
    expect(res.rationale).toBe("证据不足,无法定位漏点");
    expect(res.codes).toEqual([]);
  });

  it("knowledge-gap 优先于 plan-coverage", () => {
    const res = inferMissedLink(defect({ evidenceRefs: ["ev-9"] }), completeSource({ plan: undefined }), {
      priorDefects: [defect({ id: "D-0" })],
    });
    expect(res.missedLink).toBe("knowledge-gap");
  });

  it("非法输入 → [INVALID] 且不抛", () => {
    const res = inferMissedLink({} as any, {} as any);
    expect(res.missedLink).toBe("none");
    expect(res.codes).toEqual([DEFECT_CODES.INVALID]);
  });
});

describe("buildLineage:血缘链组装", () => {
  it("chain 顺序:task → module → defect → decision", () => {
    const res = buildLineage(defect(), completeSource());
    expect(res.ok).toBe(true);
    expect(res.unattributed).toBe(false);
    expect(res.defect?.category).toBe("rework");
    expect(res.defect?.confidence).toBe("high");
    expect(res.defect?.missedLink).toBe("none");
    expect(res.codes).toEqual([DEFECT_CODES.LINK_STRONG]);
    expect(res.chain.map((entry) => entry.type)).toEqual(["task", "module", "defect", "decision"]);
    expect(res.chain[0]).toEqual({ type: "task", ref: "T-1", label: "交付任务 T-1" });
    expect(res.chain[1]).toEqual({ type: "module", ref: "src/agent", label: "模块 src/agent" });
    expect(res.chain[2]).toEqual({ type: "defect", ref: "D-1", label: "缺陷 D-1" });
    expect(res.chain[3]?.label).toBe("rework / high / none");
  });

  it("missedLink 非 none 时链尾追加 missing-safeguard 文案", () => {
    const res = buildLineage(defect(), completeSource({ plan: undefined }));
    expect(res.defect?.missedLink).toBe("plan-coverage");
    expect(res.chain.map((entry) => entry.type)).toEqual(["task", "module", "defect", "decision", "missing-safeguard"]);
    expect(res.chain[4]).toEqual({
      type: "missing-safeguard",
      ref: "plan-coverage",
      label: "计划覆盖:交付任务必须为目标模块落节点(targets 命中)",
    });
  });

  it("module 缺失时 module 环退回首个文件", () => {
    const res = buildLineage(defect({ module: undefined }), completeSource({ module: "src/agent" }));
    expect(res.chain[1]).toEqual({ type: "module", ref: "src/agent/a.ts", label: "模块 src/agent/a.ts" });
  });

  it("低置信不入链:0 票 → unattributed 且 chain 为空", () => {
    const res = buildLineage(defect(), unrelatedSource());
    expect(res.votes).toEqual([]);
    expect(res.defect?.confidence).toBe("low");
    expect(res.unattributed).toBe(true);
    expect(res.chain).toEqual([]);
    expect(res.codes).toEqual([DEFECT_CODES.LINK_WEAK, DEFECT_CODES.UNATTRIBUTED]);
  });

  it("unrelated不入链:类别无关即不给血缘", () => {
    const res = buildLineage(defect(), unrelatedSource({ text: "改文档措辞", module: "docs" }));
    expect(res.defect?.category).toBe("unrelated");
    expect(res.unattributed).toBe(true);
    expect(res.chain).toEqual([]);
    expect(res.codes).toContain(DEFECT_CODES.UNATTRIBUTED);
  });

  it("非法输入不抛且带 DEFECT_INVALID", () => {
    expect(() => buildLineage(null as any, null as any)).not.toThrow();
    const res = buildLineage({ id: "D-1" } as any, { taskId: "T-1", filesChanged: [] });
    expect(res.ok).toBe(false);
    expect(res.chain).toEqual([]);
    expect(res.unattributed).toBe(true);
    expect(res.codes).toEqual([DEFECT_CODES.INVALID]);
  });

  it("enriched defect 保留原字段并补齐 category/confidence/missedLink", () => {
    const res = buildLineage(defect({ description: "keep me" }), completeSource());
    expect(res.defect).toMatchObject({
      id: "D-1",
      fixTaskId: "TFIX-1",
      description: "keep me",
      module: "src/agent",
      category: "rework",
      confidence: "high",
      missedLink: "none",
    });
    expect(res.defect?.files).toEqual(["src/agent/a.ts", "src/agent/b.ts"]);
  });
});

describe("toEvidenceGraphInputs:证据图投影", () => {
  it("anti-pattern 节点与 associations(none 时单节点)", () => {
    const proj = toEvidenceGraphInputs(buildLineage(defect(), completeSource()));
    expect(proj.ok).toBe(true);
    expect(proj.codes).toEqual([DEFECT_CODES.LINK_STRONG, DEFECT_CODES.GRAPH_PROJECTED]);
    expect(proj.nodes).toHaveLength(1);
    expect(proj.edges).toEqual([]);
    expect(proj.nodes[0]).toEqual({
      kind: "anti-pattern",
      statement: "缺陷 D-1 回归:retry loop double fires",
      associations: [
        { type: "task", ref: "TFIX-1" },
        { type: "module", ref: "src/agent" },
        { type: "decision", ref: "T-1", label: "none" },
      ],
      confidence: 0.85,
      source: { note: "defect-lineage v1 TFIX-1" },
    });
  });

  it("有漏点时追加 direction 节点与 contains 边", () => {
    const proj = toEvidenceGraphInputs(buildLineage(defect(), completeSource({ plan: undefined })));
    expect(proj.nodes).toHaveLength(2);
    expect(proj.nodes[1]).toEqual({
      kind: "direction",
      statement: "计划覆盖:交付任务必须为目标模块落节点(targets 命中)",
      associations: [
        { type: "module", ref: "src/agent" },
        { type: "decision", ref: "plan-coverage" },
      ],
      confidence: 0.6,
      source: { note: "missing-safeguard" },
    });
    expect(proj.edges).toEqual([{ from: "node-0", to: "node-1", kind: "contains" }]);
  });

  it("弱证据不投影:低置信 lineage → GRAPH_FAILED 且无节点", () => {
    const proj = toEvidenceGraphInputs(buildLineage(defect(), unrelatedSource()));
    expect(proj.ok).toBe(false);
    expect(proj.codes).toEqual([DEFECT_CODES.LINK_WEAK, DEFECT_CODES.UNATTRIBUTED, DEFECT_CODES.GRAPH_FAILED]);
    expect(proj.nodes).toEqual([]);
    expect(proj.edges).toEqual([]);
  });

  it("ok=false 的 lineage 直接 GRAPH_FAILED", () => {
    const proj = toEvidenceGraphInputs(buildLineage({} as any, {} as any));
    expect(proj.ok).toBe(false);
    expect(proj.codes).toEqual([DEFECT_CODES.INVALID, DEFECT_CODES.GRAPH_FAILED]);
  });

  it("confidence 三档数值:high 0.85 / medium 0.6 / low 0.35", () => {
    const high = toEvidenceGraphInputs(buildLineage(defect(), completeSource()));
    expect(high.nodes[0]?.confidence).toBe(0.85);

    const mediumLineage = {
      ok: true,
      defect: defect({ confidence: "medium", category: "rework", missedLink: "none" }),
      chain: [
        { type: "task" as const, ref: "T-1", label: "交付任务 T-1" },
        { type: "module" as const, ref: "src/agent", label: "模块 src/agent" },
        { type: "defect" as const, ref: "D-1", label: "缺陷 D-1" },
      ],
      unattributed: false,
      votes: [],
      codes: [],
    };
    const medium = toEvidenceGraphInputs(mediumLineage);
    expect(medium.ok).toBe(true);
    expect(medium.nodes[0]?.confidence).toBe(0.6);

    const lowLineage = { ...mediumLineage, defect: defect({ confidence: "low", category: "drift", missedLink: "none" }) };
    const low = toEvidenceGraphInputs(lowLineage);
    expect(low.ok).toBe(true);
    expect(low.nodes[0]?.confidence).toBe(0.35);
  });

  it("版本常量与稳定码表就位", () => {
    expect(DEFECT_LINEAGE_VERSION).toBe(1);
    expect(DEFECT_CODES.GRAPH_PROJECTED).toBe("DEFECT_GRAPH_PROJECTED");
  });
});
