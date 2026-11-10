/**
 * 扇出簇持久层:登记/聚簇落盘/幂等/分类/门留痕/真写证据图/报表/坏行容忍。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterAll, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChangeNode, FixEvent, FixEdge } from "@lampgenie/runtime/agent/fanout-cluster";
import {
  classifyStoredCluster,
  detectAndSave,
  fanoutClusterPath,
  listClusters,
  loadFanout,
  projectToGraph,
  radiationGate,
  recordChange,
  recordFix,
  reportFanout,
} from "../src/fanout-cluster-store";
import { loadEvidenceGraph } from "../src/evidence-graph-store";

const tempDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-fanout-cluster-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

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

/** 一组能成簇的输入:1 变更 + 3 条不同边的修复。 */
function seedFixes(): FixEvent[] {
  return [
    fix({ id: "f-1", at: T0 + DAY }),
    fix({ id: "f-2", at: T0 + 2 * DAY, edges: [edge("m3", "m4", "semantics")] }),
    fix({ id: "f-3", at: T0 + 3 * DAY, edges: [edge("m5", "m6", "timing")] }),
  ];
}

async function seed(root: string): Promise<void> {
  expect(recordChange(root, change(), { now: T0 }).ok).toBe(true);
  for (const item of seedFixes()) expect(recordFix(root, item, { now: T0 }).ok).toBe(true);
}

describe("recordChange / recordFix", () => {
  it("变更落一行到 .genie/rsi/fanout.jsonl", async () => {
    const root = await tmpRoot();
    const result = recordChange(root, change(), { now: T0 + 5 });
    expect(result).toEqual({ ok: true, id: "c-1" });
    const text = await readFile(fanoutClusterPath(root), "utf8");
    const line = JSON.parse(text.trim());
    expect(line).toMatchObject({ v: 1, type: "change", at: T0 + 5 });
    expect(line.change.id).toBe("c-1");
  });

  it("重复变更 → FANOUT_DUPLICATE 且不追加", async () => {
    const root = await tmpRoot();
    recordChange(root, change());
    const again = recordChange(root, change());
    expect(again).toEqual({ ok: false, code: "FANOUT_DUPLICATE", id: "c-1" });
    expect(loadFanout(root).changes.size).toBe(1);
  });

  it("非法变更 → FANOUT_INVALID_INPUT", async () => {
    const root = await tmpRoot();
    expect(recordChange(root, { id: "c-1" }).code).toBe("FANOUT_INVALID_INPUT");
    expect(recordChange(root, { ...change(), at: "nope" }).code).toBe("FANOUT_INVALID_INPUT");
    expect(recordChange(root, { ...change(), files: undefined }).code).toBe("FANOUT_INVALID_INPUT");
    expect(loadFanout(root).totalLines).toBe(0);
  });

  it("修复落盘 + 重复修复 → FANOUT_DUPLICATE", async () => {
    const root = await tmpRoot();
    expect(recordFix(root, fix()).ok).toBe(true);
    expect(recordFix(root, fix()).code).toBe("FANOUT_DUPLICATE");
    expect(loadFanout(root).fixes.size).toBe(1);
  });

  it("修复缺 files/edges → FANOUT_INVALID_INPUT", async () => {
    const root = await tmpRoot();
    expect(recordFix(root, { ...fix(), files: "x" }).code).toBe("FANOUT_INVALID_INPUT");
    expect(recordFix(root, { ...fix(), edges: "x" }).code).toBe("FANOUT_INVALID_INPUT");
  });

  it("root 为空 → FANOUT_INVALID_INPUT", () => {
    expect(recordChange("", change()).code).toBe("FANOUT_INVALID_INPUT");
    expect(recordFix("", fix()).code).toBe("FANOUT_INVALID_INPUT");
  });
});

describe("detectAndSave", () => {
  it("1 变更 + 3 修复 → 落 1 簇,size=3,多类边", async () => {
    const root = await tmpRoot();
    await seed(root);
    const result = detectAndSave(root, { now: T0 + 10 });
    expect(result.ok).toBe(true);
    expect(result.ids).toEqual(["fanout-c-1"]);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.size).toBe(3);
    expect(result.clusters[0]!.edgeTypes).toEqual(["signature", "semantics", "timing"]);
    expect(result.codes).toContain("FANOUT_CLUSTER_FOUND");
    expect(loadFanout(root).clusters.size).toBe(1);
  });

  it("重复 detect 幂等:同 id 不重复落行", async () => {
    const root = await tmpRoot();
    await seed(root);
    detectAndSave(root, { now: T0 + 10 });
    const second = detectAndSave(root, { now: T0 + 11 });
    expect(second.ok).toBe(true);
    expect(second.ids).toEqual([]);
    expect(loadFanout(root).clusters.size).toBe(1);
  });

  it("无修复 → NO_CLUSTER 且不落簇行", async () => {
    const root = await tmpRoot();
    recordChange(root, change());
    const result = detectAndSave(root);
    expect(result.ok).toBe(true);
    expect(result.ids).toEqual([]);
    expect(result.codes).toContain("FANOUT_NO_CLUSTER");
  });

  it("windowDays 收紧后不成簇", async () => {
    const root = await tmpRoot();
    await seed(root);
    const result = detectAndSave(root, { windowDays: 1 });
    expect(result.ids).toEqual([]);
  });

  it("新修复到达后重估:同簇 id 不重复但新簇可落", async () => {
    const root = await tmpRoot();
    recordChange(root, change({ id: "c-1" }));
    recordFix(root, fix({ id: "f-1" }));
    expect(detectAndSave(root).ids).toEqual([]);
    recordFix(root, fix({ id: "f-2", at: T0 + 2 * DAY, edges: [edge("m3", "m4")] }));
    expect(detectAndSave(root).ids).toEqual(["fanout-c-1"]);
  });
});

describe("listClusters / classifyStoredCluster", () => {
  it("列簇按窗口起点升序,可按 verdict 过滤", async () => {
    const root = await tmpRoot();
    await seed(root);
    detectAndSave(root);
    const all = listClusters(root);
    expect(all.ok).toBe(true);
    expect(all.clusters.map((item) => item.verdict)).toEqual(["impact-not-closed"]);
    expect(listClusters(root, { verdict: "impact-not-closed" }).clusters).toHaveLength(1);
    expect(listClusters(root, { verdict: "batched-delivery" }).clusters).toHaveLength(0);
  });

  it("classify 已落盘簇:无清单 → impact-not-closed 且给缺项", async () => {
    const root = await tmpRoot();
    await seed(root);
    detectAndSave(root);
    const result = classifyStoredCluster(root, "fanout-c-1");
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe("impact-not-closed");
    expect(result.missing).toContain("upstream-callers");
  });

  it("classify 声明分批 → batched-delivery", async () => {
    const root = await tmpRoot();
    recordChange(root, change({ batchedPlanRef: "plan-7" }));
    for (const item of seedFixes()) recordFix(root, item);
    detectAndSave(root);
    expect(classifyStoredCluster(root, "fanout-c-1").verdict).toBe("batched-delivery");
  });

  it("classify 不存在的簇 → FANOUT_NOT_FOUND", async () => {
    const root = await tmpRoot();
    expect(classifyStoredCluster(root, "nope").code).toBe("FANOUT_NOT_FOUND");
    expect(classifyStoredCluster(root, "").code).toBe("FANOUT_INVALID_INPUT");
  });
});

describe("radiationGate", () => {
  it("缺清单 → 不通过且留痕 gate 行", async () => {
    const root = await tmpRoot();
    const result = radiationGate(root, { archetype: "integration-replace" }, { now: T0 });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("FANOUT_CHECKLIST_MISSING");
    expect(result.written).toBe(true);
    const projection = loadFanout(root);
    expect(projection.gates).toHaveLength(1);
    expect(projection.gates[0]!.ok).toBe(false);
  });

  it("七项齐 → CHECKLIST_OK", async () => {
    const root = await tmpRoot();
    const keys = [
      "upstream-callers",
      "downstream-deps",
      "data-contracts",
      "side-effects",
      "tests-mocks",
      "config-flags",
      "compat-migration",
    ];
    const result = radiationGate(root, { archetype: "public-contract-change", checklist: { items: keys.map((key) => ({ key: key as never })) } });
    expect(result.ok).toBe(true);
    expect(result.codes).toContain("FANOUT_CHECKLIST_OK");
  });

  it("非三类原型 → 通过(ARCHETYPE_MISS)", async () => {
    const root = await tmpRoot();
    const result = radiationGate(root, { archetype: "other" });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["FANOUT_ARCHETYPE_MISS"]);
  });

  it("非法原型 → 不留痕", async () => {
    const root = await tmpRoot();
    const result = radiationGate(root, { archetype: "bogus" });
    expect(result.codes).toEqual(["FANOUT_INVALID"]);
    expect(result.written).toBe(false);
    expect(loadFanout(root).gates).toHaveLength(0);
  });
});

describe("projectToGraph(真实 #191 证据图)", () => {
  it("投影出 anti-pattern + direction 两节点", async () => {
    const root = await tmpRoot();
    const graphRoot = await tmpRoot();
    await seed(root);
    detectAndSave(root);
    const result = projectToGraph(root, "fanout-c-1", { graphRoot });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("FANOUT_GRAPH_PROJECTED");
    expect(result.nodes).toBe(2);
    const graph = loadEvidenceGraph(graphRoot);
    const nodes = Object.values(graph.graph.nodes) as { id: string; kind: string; statement: string }[];
    expect(nodes).toHaveLength(2);
    expect(nodes.map((node) => node.kind).sort()).toEqual(["anti-pattern", "direction"]);
    const anti = nodes.find((node) => node.kind === "anti-pattern")!;
    expect(anti.statement).toContain("扇出未闭合:m1");
    expect(anti.statement).toContain("3 条后续修复");
  });

  it("重复投影复用既有节点 id(DUPLICATE 不报错)", async () => {
    const root = await tmpRoot();
    const graphRoot = await tmpRoot();
    await seed(root);
    detectAndSave(root);
    const first = projectToGraph(root, "fanout-c-1", { graphRoot });
    const second = projectToGraph(root, "fanout-c-1", { graphRoot });
    expect(second.ok).toBe(true);
    expect(second.ids).toEqual(first.ids);
    expect(second.codes).toContain("EVIDENCE_DUPLICATE");
    expect(Object.keys(loadEvidenceGraph(graphRoot).graph.nodes).length).toBe(2);
  });

  it("簇不存在 → FANOUT_NOT_FOUND", async () => {
    const root = await tmpRoot();
    const graphRoot = await tmpRoot();
    expect(projectToGraph(root, "nope", { graphRoot }).code).toBe("FANOUT_NOT_FOUND");
    expect(projectToGraph(root, "x", { graphRoot: "" }).code).toBe("FANOUT_INVALID_INPUT");
  });
});

describe("reportFanout 与坏行容忍", () => {
  it("报表聚合 verdict / edgeTypes / 门拒绝数", async () => {
    const root = await tmpRoot();
    await seed(root);
    detectAndSave(root);
    radiationGate(root, { archetype: "integration-replace" });
    const report = reportFanout(root);
    expect(report.changes).toBe(1);
    expect(report.fixes).toBe(3);
    expect(report.clusters).toBe(1);
    expect(report.gates).toBe(1);
    expect(report.gateRejected).toBe(1);
    expect(report.byVerdict).toEqual({ "impact-not-closed": 1 });
    expect(report.byEdgeType).toEqual({ signature: 1, semantics: 1, timing: 1 });
    expect(report.parseErrors).toBe(0);
  });

  it("坏行计 parseErrors 与行号,合法行照常投影", async () => {
    const root = await tmpRoot();
    await seed(root);
    await appendFile(fanoutClusterPath(root), "{不是 JSON\n", "utf8");
    const report = reportFanout(root);
    expect(report.parseErrors).toBe(1);
    expect(report.badLines).toHaveLength(1);
    expect(report.changes).toBe(1);
    expect(report.fixes).toBe(3);
    expect(listClusters(root).clusters).toHaveLength(0);
  });

  it("未知 type 的行也计入坏行", async () => {
    const root = await tmpRoot();
    const path = fanoutClusterPath(root);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ v: 1, type: "bogus", at: T0 })}\n`, "utf8");
    const projection = loadFanout(root);
    expect(projection.parseErrors).toBe(1);
    expect(projection.totalLines).toBe(1);
  });

  it("空 root 报表为零值不抛", () => {
    const report = reportFanout("");
    expect(report.ok).toBe(true);
    expect(report.clusters).toBe(0);
  });
});
