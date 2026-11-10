/**
 * 方向总览(纯逻辑):构建 / 排序 / 计数 / 冲突 / 缺陷聚合 / 漂移三规则 / 裁决幂等 / 渲染。
 * 全纯函数直测:now 一律显式注入,不建临时目录,不读时钟。
 */
import { describe, expect, it } from "vitest";
import {
  ATLAS_BUILT,
  ATLAS_CODES,
  ATLAS_CONFLICT_OPEN,
  ATLAS_CONFLICT_RESOLVED,
  ATLAS_DEFAULT_NOW,
  ATLAS_DRIFT_DETECTED,
  ATLAS_GOAL_NOT_FOUND,
  ATLAS_INVALID,
  ATLAS_NO_DRIFT,
  buildAtlas,
  emptyAtlas,
  renderAtlasJson,
  renderAtlasMarkdown,
  resolveConflict,
  timelineSince,
  topDefectClasses,
  DIRECTION_ATLAS_VERSION,
  type AtlasInput,
  type Conflict,
  type DefectGene,
  type DirectionAtlas,
  type DirectionChange,
  type Goal,
  type KeyDecision,
} from "../src/agent/direction-atlas.ts";

const NOW = "2026-11-01T00:00:00.000Z";

function goal(id: string, since: string, extra: Partial<Goal> = {}): Goal {
  return {
    id,
    title: `目标-${id}`,
    status: "active",
    since,
    evidenceRefs: [`ev-${id}`],
    ...extra,
  };
}

function change(id: string, at: string, kind: DirectionChange["kind"], extra: Partial<DirectionChange> = {}) {
  return { id, at, kind, reason: `因为-${id}`, evidenceRefs: [`ev-${id}`], ...extra };
}

function conflict(id: string, goals: [string, string], extra: Partial<Conflict> = {}): Conflict {
  return { id, goals, description: `冲突-${id}`, status: "open", ...extra };
}

function decision(id: string, at: string, impact: KeyDecision["impact"]): KeyDecision {
  return { id, at, decision: `决策-${id}`, rationale: `理由-${id}`, impact, evidenceRefs: [`ev-${id}`] };
}

function gene(defectClass: string, count: number, id = `${defectClass}-g`): DefectGene {
  return { id, defectClass, module: "m1", count, lastAt: NOW };
}

function input(partial: Partial<AtlasInput> = {}): AtlasInput {
  return {
    projectId: "proj-1",
    goals: [],
    changes: [],
    conflicts: [],
    decisions: [],
    defectGenes: [],
    ...partial,
  };
}

function build(atlasInput: AtlasInput, now = NOW, driftWindowDays?: number) {
  return buildAtlas(atlasInput, { now, driftWindowDays });
}

describe("版本与码表", () => {
  it("DIRECTION_ATLAS_VERSION 为 1", () => {
    expect(DIRECTION_ATLAS_VERSION).toBe(1);
  });

  it("ATLAS_CODES 含 9 个稳定码且顺序固定", () => {
    expect(ATLAS_CODES).toHaveLength(9);
    expect(ATLAS_CODES[0]).toBe(ATLAS_INVALID);
    expect(ATLAS_CODES[1]).toBe(ATLAS_BUILT);
  });

  it("任何时候都带 ATLAS_BUILT", () => {
    expect(build(input()).codes).toContain(ATLAS_BUILT);
  });

  it("codes 去重并按 ATLAS_CODES 顺序排列", () => {
    const { codes } = build(input({ goals: [goal("g1", "2026-01-01")] }));
    const positions = codes.map((code) => ATLAS_CODES.indexOf(code));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("buildAtlas：目标排序与计数", () => {
  it("goals 按 since 升序", () => {
    const { atlas } = build(
      input({ goals: [goal("g2", "2026-03-01T00:00:00.000Z"), goal("g1", "2026-01-01T00:00:00.000Z")] }),
    );
    expect(atlas.goals.map((item) => item.id)).toEqual(["g1", "g2"]);
  });

  it("计数 active/achieved/abandoned", () => {
    const { atlas } = build(
      input({
        goals: [
          goal("g1", "2026-01-01", { status: "active" }),
          goal("g2", "2026-01-02", { status: "active" }),
          goal("g3", "2026-01-03", { status: "achieved" }),
          goal("g4", "2026-01-04", { status: "abandoned" }),
        ],
      }),
    );
    expect(atlas.summary.activeGoals).toBe(2);
    expect(atlas.summary.achieved).toBe(1);
    expect(atlas.summary.abandoned).toBe(1);
  });

  it("superseded 不计入三计数", () => {
    const { atlas } = build(input({ goals: [goal("g1", "2026-01-01", { status: "superseded" })] }));
    expect(atlas.summary.activeGoals).toBe(0);
    expect(atlas.summary.achieved).toBe(0);
    expect(atlas.summary.abandoned).toBe(0);
  });

  it("generatedAt 缺省是固定常量（不取真实时钟）", () => {
    const { atlas } = buildAtlas(input());
    expect(atlas.generatedAt).toBe(ATLAS_DEFAULT_NOW);
    expect(ATLAS_DEFAULT_NOW).toBe("1970-01-01T00:00:00.000Z");
  });

  it("generatedAt 用注入的 now", () => {
    const { atlas } = build(input());
    expect(atlas.generatedAt).toBe(NOW);
  });

  it("projectId 原样带入", () => {
    expect(build(input({ projectId: "p-9" })).atlas.projectId).toBe("p-9");
  });
});

describe("buildAtlas：转向时间线", () => {
  it("timeline 按 at 升序", () => {
    const { atlas } = build(
      input({
        changes: [
          change("c2", "2026-05-01T00:00:00.000Z", "scope-cut"),
          change("c1", "2026-02-01T00:00:00.000Z", "add"),
        ],
      }),
    );
    expect(atlas.timeline.map((item) => item.id)).toEqual(["c1", "c2"]);
  });

  it("pivot 的 from/to 命中 goal id 时保留 id", () => {
    const { atlas, codes } = build(
      input({
        goals: [goal("g1", "2026-01-01"), goal("g2", "2026-02-01")],
        changes: [change("c1", NOW, "pivot", { from: "g1", to: "g2" })],
      }),
    );
    expect(atlas.timeline[0]?.from).toBe("g1");
    expect(atlas.timeline[0]?.to).toBe("g2");
    expect(codes).not.toContain(ATLAS_GOAL_NOT_FOUND);
  });

  it("refocus 的 from/to 未命中 goal id 时不报错且保留原文本", () => {
    const { atlas, codes } = build(
      input({ changes: [change("c1", NOW, "refocus", { from: "手工描述A", to: "手工描述B" })] }),
    );
    expect(atlas.timeline[0]?.from).toBe("手工描述A");
    expect(atlas.timeline[0]?.to).toBe("手工描述B");
    expect(codes).not.toContain(ATLAS_INVALID);
    expect(codes).not.toContain(ATLAS_GOAL_NOT_FOUND);
  });

  it("非法 kind 的变更被跳过并记 ATLAS_INVALID", () => {
    const { atlas, codes } = build(
      input({ changes: [{ id: "c1", at: NOW, kind: "unknown", reason: "", evidenceRefs: [] } as unknown as DirectionChange] }),
    );
    expect(atlas.timeline).toHaveLength(0);
    expect(codes).toContain(ATLAS_INVALID);
  });
});

describe("buildAtlas：冲突", () => {
  it("open 冲突计入 summary 并记 ATLAS_CONFLICT_OPEN", () => {
    const { atlas, codes } = build(
      input({ goals: [goal("g1", "2026-01-01"), goal("g2", "2026-01-02")], conflicts: [conflict("k1", ["g1", "g2"])] }),
    );
    expect(atlas.summary.openConflicts).toBe(1);
    expect(codes).toContain(ATLAS_CONFLICT_OPEN);
    expect(codes).not.toContain(ATLAS_CONFLICT_RESOLVED);
  });

  it("resolved 冲突记 ATLAS_CONFLICT_RESOLVED 且不计入 openConflicts", () => {
    const { atlas, codes } = build(
      input({
        goals: [goal("g1", "2026-01-01"), goal("g2", "2026-01-02")],
        conflicts: [
          conflict("k1", ["g1", "g2"], {
            status: "resolved",
            resolution: { chosenGoalId: "g1", reason: "r", by: "me", at: NOW },
          }),
        ],
      }),
    );
    expect(atlas.summary.openConflicts).toBe(0);
    expect(codes).toContain(ATLAS_CONFLICT_RESOLVED);
  });

  it("冲突里的 goal 缺失时记 ATLAS_GOAL_NOT_FOUND 但仍构建且冲突原样保留", () => {
    const { atlas, codes } = build(
      input({ goals: [goal("g1", "2026-01-01")], conflicts: [conflict("k1", ["g1", "ghost"])] }),
    );
    expect(codes).toContain(ATLAS_GOAL_NOT_FOUND);
    expect(atlas.conflicts).toHaveLength(1);
    expect(atlas.conflicts[0]?.goals).toEqual(["g1", "ghost"]);
    expect(atlas.summary.openConflicts).toBe(1);
  });
});

describe("buildAtlas：缺陷基因与决策", () => {
  it("按 defectClass 聚合求和", () => {
    const { atlas } = build(input({ defectGenes: [gene("NPE", 2, "a"), gene("NPE", 3, "b"), gene("LEAK", 1, "c")] }));
    expect(atlas.summary.topDefectClasses).toEqual([
      { class: "NPE", count: 5 },
      { class: "LEAK", count: 1 },
    ]);
  });

  it("top5 截断", () => {
    const genes = ["a", "b", "c", "d", "e", "f"].map((cls, index) => gene(cls, 10 - index, `g${index}`));
    const { atlas } = build(input({ defectGenes: genes }));
    expect(atlas.summary.topDefectClasses).toHaveLength(5);
    expect(atlas.summary.topDefectClasses[4]?.class).toBe("e");
  });

  it("同 count 按 class 字典序", () => {
    const { atlas } = build(input({ defectGenes: [gene("zebra", 2, "1"), gene("alpha", 2, "2")] }));
    expect(atlas.summary.topDefectClasses.map((row) => row.class)).toEqual(["alpha", "zebra"]);
  });

  it("highImpactDecisions 只数 high", () => {
    const { atlas } = build(
      input({
        decisions: [decision("d1", NOW, "high"), decision("d2", NOW, "low"), decision("d3", NOW, "high")],
      }),
    );
    expect(atlas.summary.highImpactDecisions).toBe(2);
    expect(atlas.keyDecisions).toHaveLength(3);
  });
});

describe("buildAtlas：漂移三规则", () => {
  it("规则①：active goal 无证据引用且 since 早于窗口 → 命中", () => {
    const { atlas, codes } = build(input({ goals: [goal("g1", "2026-01-01", { evidenceRefs: [] })] }));
    expect(atlas.driftFlags).toEqual(["goal:g1:no-recent-evidence"]);
    expect(codes).toContain(ATLAS_DRIFT_DETECTED);
    expect(codes).not.toContain(ATLAS_NO_DRIFT);
  });

  it("规则①：evidenceRefs 空但 since 在窗口内 → 不命中", () => {
    const { atlas, codes } = build(input({ goals: [goal("g1", "2026-10-20T00:00:00.000Z", { evidenceRefs: [] })] }));
    expect(atlas.driftFlags).toEqual([]);
    expect(codes).toContain(ATLAS_NO_DRIFT);
  });

  it("规则①：evidenceRefs 全空串视同无引用", () => {
    const { atlas } = build(input({ goals: [goal("g1", "2026-01-01", { evidenceRefs: ["", "  "] })] }));
    expect(atlas.driftFlags).toEqual(["goal:g1:no-recent-evidence"]);
  });

  it("规则①：有证据引用则不命中", () => {
    const { atlas } = build(input({ goals: [goal("g1", "2026-01-01", { evidenceRefs: ["ev-1"] })] }));
    expect(atlas.driftFlags).toEqual([]);
  });

  it("规则①：只看 active，achieved 目标不报", () => {
    const { atlas } = build(
      input({ goals: [goal("g1", "2026-01-01", { status: "achieved", evidenceRefs: [] })] }),
    );
    expect(atlas.driftFlags).toEqual([]);
  });

  it("规则①：driftWindowDays 可调（窗口放大后不再命中）", () => {
    const goals = [goal("g1", "2026-09-01T00:00:00.000Z", { evidenceRefs: [] })];
    expect(build(input({ goals }), NOW, 30).atlas.driftFlags).toHaveLength(1);
    expect(build(input({ goals }), NOW, 365).atlas.driftFlags).toHaveLength(0);
  });

  it("规则②：open 冲突且双方都 active → 命中", () => {
    const { atlas } = build(
      input({ goals: [goal("g1", "2026-01-01"), goal("g2", "2026-01-02")], conflicts: [conflict("k1", ["g1", "g2"])] }),
    );
    expect(atlas.driftFlags).toEqual(["conflict-open:k1"]);
  });

  it("规则②：一方已 achieved 则不算撕扯 → 不命中", () => {
    const { atlas } = build(
      input({
        goals: [goal("g1", "2026-01-01"), goal("g2", "2026-01-02", { status: "achieved" })],
        conflicts: [conflict("k1", ["g1", "g2"])],
      }),
    );
    expect(atlas.driftFlags).toEqual([]);
  });

  it("规则③：最后一条变更是 abandon 且无 active successor → 命中", () => {
    const { atlas } = build(
      input({
        goals: [goal("g1", "2026-01-01")],
        changes: [change("c1", "2026-05-01T00:00:00.000Z", "add"), change("c2", NOW, "abandon", { from: "g1", to: "g9" })],
      }),
    );
    expect(atlas.driftFlags).toEqual(["abandon-without-successor:c2"]);
  });

  it("规则③：abandon 的 to 指向 active goal → 不命中", () => {
    const { atlas } = build(
      input({
        goals: [goal("g1", "2026-01-01"), goal("g2", "2026-01-02")],
        changes: [change("c1", NOW, "abandon", { from: "g1", to: "g2" })],
      }),
    );
    expect(atlas.driftFlags).toEqual([]);
  });

  it("规则③：最后一条不是 abandon 时不命中", () => {
    const { atlas } = build(
      input({
        goals: [goal("g1", "2026-01-01")],
        changes: [change("c1", "2026-05-01T00:00:00.000Z", "abandon"), change("c2", NOW, "add")],
      }),
    );
    expect(atlas.driftFlags).toEqual([]);
  });

  it("无漂移时记 ATLAS_NO_DRIFT", () => {
    const { codes } = build(input({ goals: [goal("g1", "2026-01-01")] }));
    expect(codes).toContain(ATLAS_NO_DRIFT);
    expect(codes).not.toContain(ATLAS_DRIFT_DETECTED);
  });

  it("多条漂移告警全列出", () => {
    const { atlas } = build(
      input({
        goals: [goal("g1", "2026-01-01", { evidenceRefs: [] }), goal("g2", "2026-01-02", { evidenceRefs: [] })],
        conflicts: [conflict("k1", ["g1", "g2"])],
      }),
    );
    expect(atlas.driftFlags).toHaveLength(3);
    expect(atlas.driftFlags).toContain("goal:g1:no-recent-evidence");
    expect(atlas.driftFlags).toContain("goal:g2:no-recent-evidence");
    expect(atlas.driftFlags).toContain("conflict-open:k1");
  });
});

describe("buildAtlas：非法输入", () => {
  it("projectId 为空 → ATLAS_INVALID 且不抛", () => {
    const { atlas, codes } = build(input({ projectId: "" }));
    expect(codes).toContain(ATLAS_INVALID);
    expect(atlas.projectId).toBe("");
  });

  it("goal 缺 id 被跳过并记 ATLAS_INVALID", () => {
    const { atlas, codes } = build(
      input({ goals: [{ title: "无名", status: "active", since: NOW, evidenceRefs: [] } as unknown as Goal] }),
    );
    expect(atlas.goals).toHaveLength(0);
    expect(codes).toContain(ATLAS_INVALID);
  });

  it("since 不是 ISO → 该 goal 跳过", () => {
    const { atlas, codes } = build(input({ goals: [goal("g1", "去年"), goal("g2", "2026-01-01")] }));
    expect(atlas.goals.map((item) => item.id)).toEqual(["g2"]);
    expect(codes).toContain(ATLAS_INVALID);
  });

  it("字段不是数组 → ATLAS_INVALID 但照常产出 atlas", () => {
    const { atlas, codes } = build(
      input({ goals: "nope" as unknown as Goal[], changes: null as unknown as DirectionChange[] }),
    );
    expect(codes).toContain(ATLAS_INVALID);
    expect(codes).toContain(ATLAS_BUILT);
    expect(atlas.goals).toEqual([]);
    expect(atlas.summary.activeGoals).toBe(0);
  });

  it("空对象/垃圾入参不抛", () => {
    expect(() => buildAtlas({} as AtlasInput)).not.toThrow();
    expect(() => buildAtlas(null as unknown as AtlasInput)).not.toThrow();
    expect(buildAtlas({} as AtlasInput).codes).toContain(ATLAS_INVALID);
  });
});

describe("resolveConflict", () => {
  function openAtlas(): DirectionAtlas {
    return build(
      input({ goals: [goal("g1", "2026-01-01"), goal("g2", "2026-01-02")], conflicts: [conflict("k1", ["g1", "g2"])] }),
    ).atlas;
  }

  it("成功后冲突 resolved 并写入 resolution", () => {
    const { atlas, codes } = resolveConflict(openAtlas(), "k1", {
      chosenGoalId: "g1",
      reason: "资源更匹配",
      by: "owner",
      at: NOW,
    });
    const target = atlas.conflicts[0];
    expect(target?.status).toBe("resolved");
    expect(target?.resolution).toEqual({ chosenGoalId: "g1", reason: "资源更匹配", by: "owner", at: NOW });
    expect(codes).toContain(ATLAS_CONFLICT_RESOLVED);
  });

  it("另一侧 goal 转 superseded，until/supersededBy 正确", () => {
    const { atlas } = resolveConflict(openAtlas(), "k1", { chosenGoalId: "g1", reason: "r", by: "me", at: NOW });
    const g2 = atlas.goals.find((item) => item.id === "g2");
    expect(g2?.status).toBe("superseded");
    expect(g2?.until).toBe(NOW);
    expect(g2?.supersededBy).toBe("g1");
  });

  it("胜出 goal 保持 active 且不写 until", () => {
    const { atlas } = resolveConflict(openAtlas(), "k1", { chosenGoalId: "g1", reason: "r", by: "me", at: NOW });
    const g1 = atlas.goals.find((item) => item.id === "g1");
    expect(g1?.status).toBe("active");
    expect(g1?.until).toBeUndefined();
  });

  it("重复裁决幂等：结构相等、codes 一致", () => {
    const first = resolveConflict(openAtlas(), "k1", { chosenGoalId: "g1", reason: "r", by: "me", at: NOW });
    const second = resolveConflict(first.atlas, "k1", {
      chosenGoalId: "g1",
      reason: "别的理由",
      by: "别人",
      at: "2026-12-01T00:00:00.000Z",
    });
    expect(second.atlas).toEqual(first.atlas);
    expect(second.codes).toEqual([ATLAS_CONFLICT_RESOLVED]);
  });

  it("冲突不存在 → ATLAS_INVALID 且 atlas 等价未改动", () => {
    const atlas = openAtlas();
    const result = resolveConflict(atlas, "nope", { chosenGoalId: "g1", reason: "r", by: "me", at: NOW });
    expect(result.codes).toEqual([ATLAS_INVALID]);
    expect(result.atlas).toEqual(atlas);
  });

  it("chosenGoalId 不属于该冲突 → ATLAS_GOAL_NOT_FOUND 且不改状态", () => {
    const atlas = openAtlas();
    const result = resolveConflict(atlas, "k1", { chosenGoalId: "g3", reason: "r", by: "me", at: NOW });
    expect(result.codes).toEqual([ATLAS_GOAL_NOT_FOUND]);
    expect(result.atlas.conflicts[0]?.status).toBe("open");
    expect(result.atlas).toEqual(atlas);
  });

  it("不修改入参 atlas（深拷贝）", () => {
    const atlas = openAtlas();
    const snapshot = JSON.parse(JSON.stringify(atlas)) as DirectionAtlas;
    resolveConflict(atlas, "k1", { chosenGoalId: "g1", reason: "r", by: "me", at: NOW });
    expect(atlas).toEqual(snapshot);
  });
});

describe("timelineSince", () => {
  const atlas = build(
    input({
      changes: [
        change("c1", "2026-01-01T00:00:00.000Z", "add"),
        change("c2", "2026-06-01T00:00:00.000Z", "pivot"),
        change("c3", "2026-12-01T00:00:00.000Z", "scope-cut"),
      ],
    }),
  ).atlas;

  it("from/to 过滤含端点", () => {
    expect(
      timelineSince(atlas, { from: "2026-06-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z" }).map((c) => c.id),
    ).toEqual(["c2", "c3"]);
  });

  it("只给 from 时截后段", () => {
    expect(timelineSince(atlas, { from: "2026-06-01T00:00:00.000Z" }).map((c) => c.id)).toEqual(["c2", "c3"]);
  });

  it("非法 ISO 边界被忽略", () => {
    expect(timelineSince(atlas, { from: "去年", to: "明年" }).map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("不传 opts 返回全量（按 at 升序）", () => {
    expect(timelineSince(atlas).map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });
});

describe("topDefectClasses", () => {
  const atlas = build(
    input({ defectGenes: [gene("a", 5, "1"), gene("b", 4, "2"), gene("c", 3, "3"), gene("d", 2, "4"), gene("e", 1, "5"), gene("f", 1, "6")] }),
  ).atlas;

  it("缺省 limit 为 5", () => {
    expect(topDefectClasses(atlas)).toHaveLength(5);
  });

  it("自定义 limit 生效", () => {
    expect(topDefectClasses(atlas, { limit: 2 })).toEqual([
      { class: "a", count: 5 },
      { class: "b", count: 4 },
    ]);
  });

  it("limit ≤ 0 返回空数组", () => {
    expect(topDefectClasses(atlas, { limit: 0 })).toEqual([]);
    expect(topDefectClasses(atlas, { limit: -3 })).toEqual([]);
  });
});

describe("renderAtlasMarkdown", () => {
  it("首行是方向总览标题", () => {
    const md = renderAtlasMarkdown(build(input({ projectId: "p-1" })).atlas);
    expect(md.split("\n")[0]).toBe("# 方向总览 — p-1");
  });

  it("五节标题齐全且计数/条数在标题里", () => {
    const atlas = build(
      input({
        goals: [goal("g1", "2026-01-01")],
        changes: [change("c1", NOW, "add")],
        conflicts: [conflict("k1", ["g1", "g2"])],
        decisions: [decision("d1", NOW, "high")],
        defectGenes: [gene("NPE", 2)],
      }),
    ).atlas;
    const md = renderAtlasMarkdown(atlas);
    expect(md).toContain("## 当前目标（active 1 / achieved 0 / abandoned 0）");
    expect(md).toContain("## 转向时间线（共 1 条）");
    expect(md).toContain("## 需求冲突与裁决");
    expect(md).toContain("## 关键决策");
    expect(md).toContain("## 缺陷基因摘要");
  });

  it("空节正文写「暂无」", () => {
    const md = renderAtlasMarkdown(emptyAtlas("p-1"));
    expect((md.match(/暂无/g) ?? []).length).toBe(5);
  });

  it("漂移告警列表与无告警文案", () => {
    const drift = renderAtlasMarkdown(build(input({ goals: [goal("g1", "2026-01-01", { evidenceRefs: [] })] })).atlas);
    expect(drift).toContain("## 漂移告警");
    expect(drift).toContain("- goal:g1:no-recent-evidence");
    expect(renderAtlasMarkdown(emptyAtlas("p-1"))).toContain("无漂移告警");
  });
});

describe("renderAtlasJson", () => {
  const atlas = build(
    input({ goals: [goal("g1", "2026-01-01")], decisions: [decision("d1", NOW, "high")], defectGenes: [gene("NPE", 1)] }),
  ).atlas;

  it("可被 JSON.parse 且内容对齐", () => {
    const parsed = JSON.parse(renderAtlasJson(atlas)) as DirectionAtlas;
    expect(parsed.projectId).toBe(atlas.projectId);
    expect(parsed.summary.highImpactDecisions).toBe(1);
  });

  it("key 顺序稳定（顶层与 summary）", () => {
    const parsed = JSON.parse(renderAtlasJson(atlas)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "projectId",
      "generatedAt",
      "goals",
      "timeline",
      "conflicts",
      "keyDecisions",
      "defectGenes",
      "summary",
      "driftFlags",
    ]);
    expect(Object.keys(parsed["summary"] as object)).toEqual([
      "activeGoals",
      "achieved",
      "abandoned",
      "openConflicts",
      "topDefectClasses",
      "highImpactDecisions",
    ]);
  });

  it("末尾带换行", () => {
    expect(renderAtlasJson(atlas).endsWith("\n")).toBe(true);
  });
});

describe("emptyAtlas", () => {
  it("全空数组 + 全 0 计数", () => {
    const atlas = emptyAtlas("p-empty");
    expect(atlas.goals).toEqual([]);
    expect(atlas.timeline).toEqual([]);
    expect(atlas.conflicts).toEqual([]);
    expect(atlas.keyDecisions).toEqual([]);
    expect(atlas.defectGenes).toEqual([]);
    expect(atlas.driftFlags).toEqual([]);
    expect(atlas.summary).toEqual({
      activeGoals: 0,
      achieved: 0,
      abandoned: 0,
      openConflicts: 0,
      topDefectClasses: [],
      highImpactDecisions: 0,
    });
  });

  it("generatedAt 缺省用固定常量，传 now 时用 now", () => {
    expect(emptyAtlas("p").generatedAt).toBe(ATLAS_DEFAULT_NOW);
    expect(emptyAtlas("p", NOW).generatedAt).toBe(NOW);
  });
});
