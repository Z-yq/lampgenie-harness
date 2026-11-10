/**
 * 扇出返工簇:聚簇阈值 / 边去重 / 归属最近窗口 / 三态分类 / 七项必备 / 门三态 / 图投影 / 幂等 / 非法输入。
 * 全部纯数据 + 固定时间戳常量,不碰文件与真实时钟。
 */
import { describe, expect, it } from "vitest";
import {
  ARCHETYPE_REQUIRED,
  CHECKLIST_KEYS,
  CONTRACT_TYPES,
  FANOUT_ARCHETYPES,
  FANOUT_CODES,
  FANOUT_VERSION,
  classifyCluster,
  clusterToGraphNodes,
  detectClusters,
  edgeKeyOf,
  entityKeyOf,
  evaluateRadiationGate,
  requiredChecklist,
} from "../src/agent/fanout-cluster.ts";
import type { ChangeNode, FanoutCluster, FixEdge, FixEvent, RadiationChecklist } from "../src/agent/fanout-cluster.ts";

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

function edge(from: string, to: string, contractType: FixEdge["contractType"] = "signature"): FixEdge {
  return { from, to, contractType };
}

function change(over: Partial<ChangeNode> = {}): ChangeNode {
  return {
    id: "c-1",
    entity: "m1",
    module: "pkg-a",
    files: ["pkg-a/src/x.ts"],
    at: T0,
    taskId: "t-change",
    archetype: "integration-replace",
    ...over,
  };
}

function fix(over: Partial<FixEvent> = {}): FixEvent {
  return {
    id: "f-1",
    taskId: "t-fix",
    at: T0 + DAY,
    entity: "m1",
    module: "pkg-a",
    files: ["pkg-a/src/y.ts"],
    edges: [edge("m1", "m2")],
    description: "call site mismatch",
    ...over,
  };
}

function checklist(keys: string[], over: Partial<RadiationChecklist> = {}): RadiationChecklist {
  return { items: keys.map((key) => ({ key: key as RadiationChecklist["items"][number]["key"] })), ...over };
}

function clusterOf(changes: ChangeNode[], fixes: FixEvent[]): FanoutCluster {
  const result = detectClusters({ changes, fixes });
  expect(result.clusters).toHaveLength(1);
  return result.clusters[0]!;
}

describe("常量与基础口径", () => {
  it("版本号为 1", () => {
    expect(FANOUT_VERSION).toBe(1);
  });

  it("原型与契约类型枚举齐全", () => {
    expect([...FANOUT_ARCHETYPES]).toEqual(["integration-replace", "public-contract-change", "delete-or-semantic-change", "other"]);
    expect([...CONTRACT_TYPES]).toEqual(["signature", "semantics", "precision", "nullability", "timing", "events"]);
    expect([...CHECKLIST_KEYS]).toEqual([
      "upstream-callers",
      "downstream-deps",
      "data-contracts",
      "side-effects",
      "tests-mocks",
      "config-flags",
      "compat-migration",
    ]);
  });

  it("稳定码文案与常量一致", () => {
    expect(FANOUT_CODES.INVALID).toBe("FANOUT_INVALID");
    expect(FANOUT_CODES.CHECKLIST_OK).toBe("FANOUT_CHECKLIST_OK");
    expect(FANOUT_CODES.INSUFFICIENT_EVIDENCE).toBe("FANOUT_INSUFFICIENT_EVIDENCE");
  });

  it("edgeKeyOf 逐字使用 from->to:contractType", () => {
    expect(edgeKeyOf(edge("a", "b", "timing"))).toBe("a->b:timing");
  });

  it("entityKeyOf 缺省实体回退 module 并带命名空间", () => {
    expect(entityKeyOf({ entity: " m1 " })).toBe("m1");
    expect(entityKeyOf({ module: "pkg-a" })).toBe("module:pkg-a");
    expect(entityKeyOf({ entity: "  ", module: "pkg-a" })).toBe("module:pkg-a");
    expect(entityKeyOf({})).toBe("");
  });
});

describe("detectClusters:成簇与阈值", () => {
  it("空输入返回 NO_CLUSTER 且无簇", () => {
    expect(detectClusters({ changes: [], fixes: [] })).toEqual({ clusters: [], codes: [FANOUT_CODES.NO_CLUSTER] });
  });

  it("输入不是对象或数组缺失 → FANOUT_INVALID", () => {
    expect(detectClusters(undefined as never).codes).toEqual([FANOUT_CODES.INVALID]);
    expect(detectClusters({ changes: [] } as never).codes).toEqual([FANOUT_CODES.INVALID]);
  });

  it("windowDays 非正 → FANOUT_INVALID", () => {
    expect(detectClusters({ changes: [change()], fixes: [fix()] }, { windowDays: 0 }).codes).toEqual([FANOUT_CODES.INVALID]);
    expect(detectClusters({ changes: [change()], fixes: [fix()] }, { windowDays: -3 }).codes).toEqual([FANOUT_CODES.INVALID]);
  });

  it("minFixes < 1 → FANOUT_INVALID", () => {
    expect(detectClusters({ changes: [change()], fixes: [fix()] }, { minFixes: 0 }).codes).toEqual([FANOUT_CODES.INVALID]);
  });

  it("一个变更 + 三条不同边的修复 → 1 簇,size=3", () => {
    const result = detectClusters({
      changes: [change()],
      fixes: [fix({ id: "f-1" }), fix({ id: "f-2", edges: [edge("m3", "m4", "semantics")] }), fix({ id: "f-3", edges: [edge("m5", "m6", "timing")] })],
    });
    expect(result.codes).toContain(FANOUT_CODES.CLUSTER_FOUND);
    expect(result.clusters).toHaveLength(1);
    const cluster = result.clusters[0]!;
    expect(cluster.id).toBe("fanout-c-1");
    expect(cluster.entity).toBe("m1");
    expect(cluster.size).toBe(3);
    expect(cluster.fixes.map((item) => item.id)).toEqual(["f-1", "f-2", "f-3"]);
  });

  it("边类型按 CONTRACT_TYPES 顺序去重输出", () => {
    const cluster = clusterOf(
      [change()],
      [
        fix({ id: "f-1", edges: [edge("a", "b", "timing")] }),
        fix({ id: "f-2", edges: [edge("c", "d", "signature"), edge("e", "f", "timing")] }),
      ],
    );
    expect(cluster.edgeTypes).toEqual(["signature", "timing"]);
    expect(cluster.edgeKeys).toEqual(["a->b:timing", "c->d:signature", "e->f:timing"]);
  });

  it("只有一个修复 → 不成簇(缺 minFixes)", () => {
    const result = detectClusters({ changes: [change()], fixes: [fix({ id: "f-1" })] });
    expect(result.clusters).toHaveLength(0);
    expect(result.codes).toEqual([FANOUT_CODES.NO_CLUSTER]);
  });

  it("两条修复踩同一条边 → 不成簇(边数 < 2)", () => {
    const result = detectClusters({
      changes: [change()],
      fixes: [fix({ id: "f-1" }), fix({ id: "f-2" })],
    });
    expect(result.clusters).toHaveLength(0);
  });

  it("同一 from->to 但契约类型不同 → 算两条不同边", () => {
    const cluster = clusterOf(
      [change()],
      [fix({ id: "f-1", edges: [edge("a", "b", "signature")] }), fix({ id: "f-2", edges: [edge("a", "b", "timing")] })],
    );
    expect(cluster.edgeKeys).toEqual(["a->b:signature", "a->b:timing"]);
    expect(cluster.edgeTypes).toEqual(["signature", "timing"]);
  });

  it("minFixes 可调高,低于阈值不成簇", () => {
    const input = { changes: [change()], fixes: [fix({ id: "f-1" }), fix({ id: "f-2", edges: [edge("c", "d")] })] };
    expect(detectClusters(input, { minFixes: 3 }).clusters).toHaveLength(0);
    expect(detectClusters(input, { minFixes: 2 }).clusters).toHaveLength(1);
  });
});

describe("detectClusters:时间窗", () => {
  it("缺省窗口 14 天:窗口内成簇", () => {
    const result = detectClusters({
      changes: [change({ at: T0 })],
      fixes: [fix({ id: "f-1", at: T0 + 13 * DAY }), fix({ id: "f-2", at: T0 + 14 * DAY, edges: [edge("c", "d")] })],
    });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.window).toEqual({ from: T0, to: T0 + 14 * DAY });
  });

  it("窗口右端闭区间,越界 1ms 即排除", () => {
    const input = {
      changes: [change({ at: T0 })],
      fixes: [fix({ id: "f-1", at: T0 }), fix({ id: "f-2", at: T0 + 14 * DAY + 1, edges: [edge("c", "d")] })],
    };
    expect(detectClusters(input).clusters).toHaveLength(0);
  });

  it("变更之前的修复不计入窗口", () => {
    const input = {
      changes: [change({ at: T0 })],
      fixes: [fix({ id: "f-1", at: T0 - 1 }), fix({ id: "f-2", at: T0 - 2, edges: [edge("c", "d")] })],
    };
    expect(detectClusters(input).clusters).toHaveLength(0);
  });

  it("自定义 windowDays 生效(1 天)", () => {
    const input = {
      changes: [change({ at: T0 })],
      fixes: [fix({ id: "f-1", at: T0 + DAY }), fix({ id: "f-2", at: T0 + DAY + 1, edges: [edge("c", "d")] })],
    };
    expect(detectClusters(input, { windowDays: 1 }).clusters).toHaveLength(0);
    expect(detectClusters(input, { windowDays: 2 }).clusters).toHaveLength(1);
  });
});

describe("detectClusters:实体归属与去重", () => {
  it("实体不同不成簇", () => {
    const result = detectClusters({
      changes: [change({ entity: "m1" })],
      fixes: [fix({ id: "f-1" }), fix({ id: "f-2", entity: "m9", edges: [edge("c", "d")] })],
    });
    expect(result.clusters).toHaveLength(0);
  });

  it("实体缺省时回退 module 匹配", () => {
    const cluster = clusterOf(
      [change({ entity: "", module: "pkg-a" })],
      [fix({ id: "f-1", entity: undefined, module: "pkg-a" }), fix({ id: "f-2", entity: undefined, module: "pkg-a", edges: [edge("c", "d")] })],
    );
    expect(cluster.entity).toBe("pkg-a");
    expect(cluster.size).toBe(2);
  });

  it("变更用 entity、修复只有 module → 视为不同实体", () => {
    const result = detectClusters({
      changes: [change({ entity: "m1" })],
      fixes: [fix({ id: "f-1", entity: undefined, module: "pkg-a" }), fix({ id: "f-2", entity: undefined, module: "pkg-a", edges: [edge("c", "d")] })],
    });
    expect(result.clusters).toHaveLength(0);
  });

  it("同一修复只归最近窗口内的变更", () => {
    const result = detectClusters({
      changes: [change({ id: "c-old", at: T0 }), change({ id: "c-new", at: T0 + 2 * DAY })],
      fixes: [
        fix({ id: "f-1", at: T0 + 3 * DAY }),
        fix({ id: "f-2", at: T0 + 3 * DAY + 1, edges: [edge("c", "d")] }),
      ],
    });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.change.id).toBe("c-new");
  });

  it("重复修复 id 只计一次", () => {
    const duplicate = fix({ id: "f-1" });
    const result = detectClusters({ changes: [change()], fixes: [duplicate, { ...duplicate }] });
    expect(result.clusters).toHaveLength(0);
  });

  it("同一修复内含重复边 → 触发 EDGE_DEDUPED 且边数不足则不成簇", () => {
    const result = detectClusters({
      changes: [change()],
      fixes: [fix({ id: "f-1", edges: [edge("a", "b"), edge("a", "b")] }), fix({ id: "f-2", edges: [edge("a", "b")] })],
    });
    expect(result.clusters).toHaveLength(0);
    expect(result.codes).toContain(FANOUT_CODES.EDGE_DEDUPED);
  });

  it("成簇时重复边被折叠,size 仍按修复数", () => {
    const cluster = clusterOf(
      [change()],
      [
        fix({ id: "f-1", edges: [edge("a", "b"), edge("a", "b")] }),
        fix({ id: "f-2", edges: [edge("c", "d")] }),
      ],
    );
    expect(cluster.size).toBe(2);
    expect(cluster.edgeKeys).toEqual(["a->b:signature", "c->d:signature"]);
    expect(cluster.codes).toContain(FANOUT_CODES.EDGE_DEDUPED);
  });

  it("重复 detect 结果逐字一致(幂等)", () => {
    const input = {
      changes: [change()],
      fixes: [fix({ id: "f-1", at: T0 + DAY }), fix({ id: "f-2", at: T0 + 2 * DAY, edges: [edge("c", "d")] })],
    };
    expect(detectClusters(input)).toEqual(detectClusters(input));
  });

  it("多簇按窗口起点升序排列", () => {
    const result = detectClusters({
      changes: [change({ id: "c-late", entity: "m2", at: T0 + 20 * DAY }), change({ id: "c-early", at: T0 })],
      fixes: [
        fix({ id: "f-1", at: T0 + DAY }),
        fix({ id: "f-2", at: T0 + 2 * DAY, edges: [edge("c", "d")] }),
        fix({ id: "f-3", entity: "m2", at: T0 + 21 * DAY }),
        fix({ id: "f-4", entity: "m2", at: T0 + 22 * DAY, edges: [edge("e", "f")] }),
      ],
    });
    expect(result.clusters.map((cluster) => cluster.change.id)).toEqual(["c-early", "c-late"]);
  });
});

describe("detectClusters:坏记录容忍", () => {
  it("坏变更被跳过但仍标 INVALID,合法簇照常产出", () => {
    const result = detectClusters({
      changes: [change(), { id: "bad", entity: "m1", files: [], at: "nope", taskId: "t", archetype: "other" } as never],
      fixes: [fix({ id: "f-1" }), fix({ id: "f-2", edges: [edge("c", "d")] })],
    });
    expect(result.clusters).toHaveLength(1);
    expect(result.codes).toContain(FANOUT_CODES.INVALID);
  });

  it("契约类型非法的边被丢弃,簇仍可成", () => {
    const result = detectClusters({
      changes: [change()],
      fixes: [
        fix({ id: "f-1", edges: [edge("a", "b"), { from: "x", to: "y", contractType: "bogus" } as never] }),
        fix({ id: "f-2", edges: [edge("c", "d")] }),
      ],
    });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.edgeKeys).toEqual(["a->b:signature", "c->d:signature"]);
    expect(result.codes).toContain(FANOUT_CODES.INVALID);
  });

  it("缺 files 的修复被跳过", () => {
    const result = detectClusters({
      changes: [change()],
      fixes: [{ id: "f-0", taskId: "t", at: T0 + DAY, edges: [edge("a", "b")], description: "x" } as never, fix({ id: "f-1" })],
    });
    expect(result.clusters).toHaveLength(0);
    expect(result.codes).toContain(FANOUT_CODES.INVALID);
  });
});

describe("classifyCluster:三态判定", () => {
  it("expectedInPlan=true → batched-delivery", () => {
    const cluster = clusterOf([change()], [fix({ id: "f-1", expectedInPlan: true }), fix({ id: "f-2", edges: [edge("c", "d")] })]);
    expect(cluster.verdict).toBe("batched-delivery");
    expect(cluster.codes).toEqual([FANOUT_CODES.BATCHED_DELIVERY]);
    expect(classifyCluster(cluster).rationale).toContain("分批交付");
  });

  it("batchedPlanRef 非空 → batched-delivery", () => {
    const cluster = clusterOf([change({ batchedPlanRef: "plan-7/step-2" })], [fix({ id: "f-1" }), fix({ id: "f-2", edges: [edge("c", "d")] })]);
    expect(cluster.verdict).toBe("batched-delivery");
  });

  it("清单缺失 → impact-not-closed 并给出必备项", () => {
    const cluster = clusterOf([change()], [fix({ id: "f-1" }), fix({ id: "f-2", edges: [edge("c", "d")] })]);
    const result = classifyCluster(cluster);
    expect(result.verdict).toBe("impact-not-closed");
    expect(result.codes).toEqual([FANOUT_CODES.IMPACT_NOT_CLOSED]);
    expect(result.missing).toEqual([...ARCHETYPE_REQUIRED["integration-replace"]]);
  });

  it("清单 items 为空等同缺失", () => {
    const cluster = clusterOf([change({ radiationChecklist: { items: [] } })], [fix({ id: "f-1" }), fix({ id: "f-2", edges: [edge("c", "d")] })]);
    expect(classifyCluster(cluster).verdict).toBe("impact-not-closed");
  });

  it("清单存在但未覆盖边 → impact-not-closed 且列出未覆盖边", () => {
    const cluster = clusterOf(
      [change({ radiationChecklist: checklist(["side-effects"]) })],
      [fix({ id: "f-1", edges: [edge("a", "b", "signature")] }), fix({ id: "f-2", edges: [edge("c", "d", "signature")] })],
    );
    const result = classifyCluster(cluster);
    expect(result.verdict).toBe("impact-not-closed");
    expect(result.uncoveredEdges).toEqual(["a->b:signature", "c->d:signature"]);
    expect(result.missing).toContain("upstream-callers");
  });

  it("清单覆盖所有边 → insufficient-evidence", () => {
    const cluster = clusterOf(
      [change({ radiationChecklist: checklist(["upstream-callers"]) })],
      [fix({ id: "f-1" }), fix({ id: "f-2", edges: [edge("c", "d", "timing")] })],
    );
    const result = classifyCluster(cluster);
    expect(result.verdict).toBe("insufficient-evidence");
    expect(result.codes).toEqual([FANOUT_CODES.INSUFFICIENT_EVIDENCE]);
    expect(result.rationale).toContain("人工");
  });

  it("事件边可用 config-flags 覆盖", () => {
    const cluster = clusterOf(
      [change({ radiationChecklist: checklist(["config-flags"]) })],
      [fix({ id: "f-1", edges: [edge("a", "b", "events")] }), fix({ id: "f-2", edges: [edge("c", "d", "events")] })],
    );
    expect(classifyCluster(cluster).verdict).toBe("insufficient-evidence");
  });

  it("非法簇输入 → INVALID", () => {
    expect(classifyCluster(undefined).codes).toEqual([FANOUT_CODES.INVALID]);
    expect(classifyCluster({ change: {} as never, fixes: [] }).codes).toEqual([FANOUT_CODES.INVALID]);
  });

  it("detect 产出的簇自带 verdict 与码", () => {
    const cluster = clusterOf([change()], [fix({ id: "f-1" }), fix({ id: "f-2", edges: [edge("c", "d")] })]);
    expect(cluster.verdict).toBe("impact-not-closed");
    expect(cluster.codes).toEqual([FANOUT_CODES.IMPACT_NOT_CLOSED]);
  });
});

describe("requiredChecklist:七项必备子集", () => {
  it("integration-replace 必备 5 项", () => {
    const result = requiredChecklist("integration-replace");
    expect(result.applicable).toBe(true);
    expect(result.required.map((item) => item.key)).toEqual([...ARCHETYPE_REQUIRED["integration-replace"]]);
    expect(result.required.map((item) => item.key)).toHaveLength(5);
  });

  it("public-contract-change 必备含 side-effects", () => {
    const keys = requiredChecklist("public-contract-change").required.map((item) => item.key);
    expect(keys).toContain("side-effects");
    expect(keys).toHaveLength(6);
  });

  it("delete-or-semantic-change 必备含 config-flags", () => {
    const keys = requiredChecklist("delete-or-semantic-change").required.map((item) => item.key);
    expect(keys).toContain("config-flags");
    expect(keys).toHaveLength(6);
  });

  it("other 与未知原型 → applicable=false 且无必备项", () => {
    expect(requiredChecklist("other")).toEqual({ archetype: "other", applicable: false, required: [] });
    expect(requiredChecklist("nope").applicable).toBe(false);
    expect(requiredChecklist("").applicable).toBe(false);
  });

  it("每项都带 label 与机械化命令提示", () => {
    for (const item of requiredChecklist("public-contract-change").required) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.mechanism).toMatch(/codesense|rg |vitest|版本/);
    }
  });

  it("三类原型都只取 7 项的子集", () => {
    const all = new Set<string>(CHECKLIST_KEYS);
    for (const archetype of ["integration-replace", "public-contract-change", "delete-or-semantic-change"] as const) {
      for (const item of requiredChecklist(archetype).required) expect(all.has(item.key)).toBe(true);
    }
  });
});

describe("evaluateRadiationGate:门三态", () => {
  it("非三类原型 → ok + ARCHETYPE_MISS", () => {
    const result = evaluateRadiationGate({ archetype: "other" });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual([FANOUT_CODES.ARCHETYPE_MISS]);
    expect(result.applicable).toBe(false);
  });

  it("命中原型但清单缺失 → CHECKLIST_MISSING 不通过", () => {
    const result = evaluateRadiationGate({ archetype: "integration-replace" });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([FANOUT_CODES.ARCHETYPE_MATCH, FANOUT_CODES.CHECKLIST_MISSING]);
    expect(result.missing).toHaveLength(5);
  });

  it("清单为空数组 → CHECKLIST_MISSING", () => {
    const result = evaluateRadiationGate({ archetype: "integration-replace", checklist: { items: [] } });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain(FANOUT_CODES.CHECKLIST_MISSING);
  });

  it("清单缺必备项 → CHECKLIST_INCOMPLETE 并点名缺项", () => {
    const result = evaluateRadiationGate({
      archetype: "integration-replace",
      checklist: checklist(["upstream-callers", "downstream-deps", "data-contracts", "tests-mocks"]),
    });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([FANOUT_CODES.ARCHETYPE_MATCH, FANOUT_CODES.CHECKLIST_INCOMPLETE]);
    expect(result.missing).toEqual(["compat-migration"]);
  });

  it("七项给全 → CHECKLIST_OK 通过", () => {
    const result = evaluateRadiationGate({ archetype: "public-contract-change", checklist: checklist([...CHECKLIST_KEYS]) });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual([FANOUT_CODES.ARCHETYPE_MATCH, FANOUT_CODES.CHECKLIST_OK]);
    expect(result.missing).toEqual([]);
  });

  it("多余项不影响判定", () => {
    const result = evaluateRadiationGate({
      archetype: "delete-or-semantic-change",
      checklist: checklist([...CHECKLIST_KEYS, "upstream-callers"]),
    });
    expect(result.ok).toBe(true);
  });

  it("缺 archetype 或未知取值 → FANOUT_INVALID", () => {
    expect(evaluateRadiationGate({}).codes).toEqual([FANOUT_CODES.INVALID]);
    expect(evaluateRadiationGate({ archetype: "bogus" }).codes).toEqual([FANOUT_CODES.INVALID]);
    expect(evaluateRadiationGate(null as never).codes).toEqual([FANOUT_CODES.INVALID]);
  });

  it("非法清单项被忽略 → 视为缺项", () => {
    const result = evaluateRadiationGate({
      archetype: "integration-replace",
      checklist: { items: [...ARCHETYPE_REQUIRED["integration-replace"].map((key) => ({ key })), { key: "bogus" } as never] },
    });
    expect(result.ok).toBe(true);
  });
});

describe("clusterToGraphNodes:证据图投影", () => {
  it("产出 anti-pattern + direction 两节点", () => {
    const cluster = clusterOf(
      [change()],
      [fix({ id: "f-1" }), fix({ id: "f-2", edges: [edge("c", "d", "timing")] }), fix({ id: "f-3", edges: [edge("e", "f", "events")] })],
    );
    const result = clusterToGraphNodes(cluster);
    expect(result.ok).toBe(true);
    expect(result.nodes.map((node) => node.kind)).toEqual(["anti-pattern", "direction"]);
    expect(result.nodes[0]!.statement).toBe("扇出未闭合:m1 引发 3 条后续修复(边类型:signature/timing/events)");
    expect(result.nodes[1]!.statement).toContain("辐射面清单");
    expect(result.codes).toContain(FANOUT_CODES.CLUSTER_FOUND);
  });

  it("associations 覆盖 entity/module/task", () => {
    const nodes = clusterToGraphNodes(clusterOf([change()], [fix({ id: "f-1" }), fix({ id: "f-2", edges: [edge("c", "d")] })])).nodes;
    for (const node of nodes) {
      expect(node.associations.map((assoc) => assoc.type)).toEqual(["feature", "module", "task"]);
      expect(node.associations[0]!.ref).toBe("m1");
      expect(node.associations[0]!.label).toBe("entity");
    }
  });

  it("无 module 时省略 module association", () => {
    const nodes = clusterToGraphNodes({
      entity: "m1",
      change: change({ module: undefined }),
      fixes: [],
      size: 0,
      edgeTypes: [],
    }).nodes;
    expect(nodes[0]!.associations.map((assoc) => assoc.type)).toEqual(["feature", "task"]);
  });

  it("非法簇输入 → ok=false + INVALID", () => {
    expect(clusterToGraphNodes(undefined).codes).toEqual([FANOUT_CODES.INVALID]);
    expect(clusterToGraphNodes({ entity: "x", change: {} as never, fixes: [], size: 0, edgeTypes: [] }).ok).toBe(false);
  });
});
