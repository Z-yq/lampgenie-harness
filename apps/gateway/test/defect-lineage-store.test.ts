/**
 * 缺陷血缘持久层:登记/归属/澄清/列表/队列/报表/投影证据图/坏行容忍。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DefectRecord, SourceTaskEvidence } from "@lampgenie/runtime/agent/defect-lineage";
import {
  attributeDefect,
  clarifyDefect,
  defectLineagePath,
  listDefects,
  loadDefects,
  projectToGraph,
  registerDefect,
  reportDefects,
  unattributedQueue,
} from "../src/defect-lineage-store";
import { loadEvidenceGraph } from "../src/evidence-graph-store";

const tempDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-defect-lineage-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const FILE = "apps/gateway/src/defect-lineage-store.ts";
const MODULE = "defect-store";

/** 一条可被强证据命中的缺陷(blame 提交与交付提交相同)。 */
function strongDefect(over: Partial<DefectRecord> = {}): DefectRecord {
  return {
    id: "def-1",
    fixTaskId: "task-fix-1",
    description: "归属写错了行",
    module: MODULE,
    files: [FILE],
    fixedAt: T0,
    blame: [{ file: FILE, line: 12, commit: "c0ffee1" }],
    category: "unknown",
    confidence: "low",
    evidenceRefs: [],
    ...over,
  };
}

/** 一份「强证据 + 漏点=影响面分析」的交付证据(→ anti-pattern + direction 两节点)。 */
function strongSource(over: Partial<SourceTaskEvidence> = {}): SourceTaskEvidence {
  return {
    taskId: "task-1",
    commit: "c0ffee1",
    at: T0 - DAY,
    text: `交付 ${MODULE} 的归属逻辑`,
    module: MODULE,
    filesChanged: [FILE],
    codeSenseUsed: false,
    plan: { nodes: [{ id: "n1", label: "改归属", targets: [FILE] }] },
    verification: { commands: ["npx vitest run test/defect-lineage-store.test.ts"] },
    ...over,
  };
}

/** 一份完全无交集的交付证据(→ 弱/无票 → unattributed)。 */
function weakSource(): SourceTaskEvidence {
  return {
    taskId: "task-other",
    at: T0 - 30 * DAY,
    filesChanged: ["docs/readme.md"],
    module: "docs",
  };
}

/** 读回台账原始行(按行解析)。 */
async function readLedger(root: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(defectLineagePath(root), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("defect-lineage-store", () => {
  it("登记成功:追加 register 行并可投影读回", async () => {
    const root = await tmpRoot();
    const res = registerDefect(root, strongDefect(), { now: T0 });
    expect(res.ok).toBe(true);
    expect(res.id).toBe("def-1");

    const lines = await readLedger(root);
    expect(lines.length).toBe(1);
    expect(lines[0].type).toBe("register");
    expect(lines[0].v).toBe(1);

    const projection = loadDefects(root);
    expect(projection.totalLines).toBe(1);
    expect(projection.parseErrors).toBe(0);
    expect(projection.entries.get("def-1")?.status).toBe("registered");
  });

  it("重复登记同 id:返回 DEFECT_DUPLICATE 且不追加行", async () => {
    const root = await tmpRoot();
    expect(registerDefect(root, strongDefect(), { now: T0 }).ok).toBe(true);
    const dup = registerDefect(root, strongDefect({ description: "另一份描述" }), { now: T0 + 1 });
    expect(dup.ok).toBe(false);
    expect(dup.code).toBe("DEFECT_DUPLICATE");
    expect((await readLedger(root)).length).toBe(1);
    expect(loadDefects(root).entries.get("def-1")?.defect.description).toBe("归属写错了行");
  });

  it("非法输入:缺 files / 缺 description 返回 DEFECT_INVALID_INPUT 且不落盘", async () => {
    const root = await tmpRoot();
    const noFiles = { ...strongDefect({ id: "def-bad" }), files: undefined } as unknown as DefectRecord;
    expect(registerDefect(root, noFiles).code).toBe("DEFECT_INVALID_INPUT");
    const noDesc = { ...strongDefect({ id: "def-bad2" }), description: "  " } as unknown as DefectRecord;
    expect(registerDefect(root, noDesc).code).toBe("DEFECT_INVALID_INPUT");
    expect(registerDefect(root, undefined as unknown as DefectRecord).code).toBe("DEFECT_INVALID_INPUT");
    expect(await readLedger(root).catch(() => [])).toEqual([]);
  });

  it("强证据归属:入链 high,落盘顺序 register → attribute", async () => {
    const root = await tmpRoot();
    registerDefect(root, strongDefect(), { now: T0 });
    const res = attributeDefect(root, "def-1", strongSource(), { now: T0 + DAY });
    expect(res.ok).toBe(true);
    expect(res.unattributed).toBe(false);
    expect(res.code).toBeUndefined();
    expect(res.lineage?.confidence).toBe("high");
    expect(res.lineage?.unattributed).toBe(false);
    expect(res.lineage?.codes).toContain("DEFECT_LINK_STRONG");
    expect(res.lineage?.defect?.missedLink).toBe("impact-analysis");

    const lines = await readLedger(root);
    expect(lines.map((line) => line.type)).toEqual(["register", "attribute"]);
    expect(lines[1].at).toBe(T0 + DAY);
  });

  it("弱证据归属:unattributed + DEFECT_UNATTRIBUTED,并出现在未归属队列", async () => {
    const root = await tmpRoot();
    registerDefect(root, strongDefect({ id: "def-weak", blame: undefined }), { now: T0 });
    const res = attributeDefect(root, "def-weak", weakSource(), { now: T0 + 2 * DAY });
    expect(res.ok).toBe(true);
    expect(res.unattributed).toBe(true);
    expect(res.code).toBe("DEFECT_UNATTRIBUTED");
    expect(res.lineage?.unattributed).toBe(true);
    expect(res.lineage?.chain).toEqual([]);
    // unattributed 仍落行(便于队列查询)
    expect((await readLedger(root)).map((line) => line.type)).toEqual(["register", "attribute"]);

    const queue = unattributedQueue(root);
    expect(queue.items.length).toBe(1);
    expect(queue.items[0].id).toBe("def-weak");
    expect(queue.items[0].fixTaskId).toBe("task-fix-1");
    expect(queue.items[0].reason.length).toBeGreaterThan(0);
  });

  it("归属未知 id:返回 DEFECT_NOT_FOUND 且不落 attribute 行", async () => {
    const root = await tmpRoot();
    registerDefect(root, strongDefect(), { now: T0 });
    const res = attributeDefect(root, "def-missing", strongSource(), { now: T0 });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("DEFECT_NOT_FOUND");
    expect((await readLedger(root)).length).toBe(1);
  });

  it("归属非法输入(source 缺 taskId):DEFECT_INVALID_INPUT", async () => {
    const root = await tmpRoot();
    registerDefect(root, strongDefect(), { now: T0 });
    const bad = { filesChanged: [FILE] } as unknown as SourceTaskEvidence;
    expect(attributeDefect(root, "def-1", bad, { now: T0 }).code).toBe("DEFECT_INVALID_INPUT");
  });

  it("澄清后条目状态 clarified 且不再出现在未归属队列", async () => {
    const root = await tmpRoot();
    registerDefect(root, strongDefect({ id: "def-c", blame: undefined }), { now: T0 });
    attributeDefect(root, "def-c", weakSource(), { now: T0 + DAY });
    expect(unattributedQueue(root).items.length).toBe(1);

    const res = clarifyDefect(root, "def-c", {
      by: "lead",
      note: "人工确认是 task-9 引入",
      sourceTaskId: "task-9",
      missedLink: "verification-coverage",
      now: T0 + 2 * DAY,
    });
    expect(res.ok).toBe(true);
    expect(res.lineage?.attribution).toBe("manual");
    expect(res.lineage?.unattributed).toBe(false);
    expect(res.lineage?.codes).toEqual(["DEFECT_LINK_MEDIUM"]);
    expect(res.lineage?.chain.map((entry) => entry.type)).toEqual([
      "task",
      "module",
      "defect",
      "decision",
      "missing-safeguard",
    ]);
    expect(res.lineage?.chain[0].ref).toBe("task-9");
    expect(res.lineage?.defect?.missedLink).toBe("verification-coverage");

    expect(unattributedQueue(root).items).toEqual([]);
    const list = listDefects(root);
    expect(list.items[0].status).toBe("clarified");
    expect((await readLedger(root)).map((line) => line.type)).toEqual(["register", "attribute", "clarify"]);
  });

  it("澄清校验:by/note 必填、未知 id NOT_FOUND、非法 missedLink 拒绝", async () => {
    const root = await tmpRoot();
    registerDefect(root, strongDefect(), { now: T0 });
    expect(clarifyDefect(root, "def-1", { by: " ", note: "x" }).code).toBe("DEFECT_INVALID_INPUT");
    expect(clarifyDefect(root, "def-1", { by: "lead", note: "" }).code).toBe("DEFECT_INVALID_INPUT");
    expect(
      clarifyDefect(root, "def-1", { by: "lead", note: "x", missedLink: "bogus" as unknown as "none" }).code,
    ).toBe("DEFECT_INVALID_INPUT");
    expect(clarifyDefect(root, "nope", { by: "lead", note: "x" }).code).toBe("DEFECT_NOT_FOUND");
    expect((await readLedger(root)).length).toBe(1);
  });

  it("listDefects 按 category 与 unattributed 过滤", async () => {
    const root = await tmpRoot();
    registerDefect(root, strongDefect({ id: "def-strong" }), { now: T0 });
    registerDefect(root, strongDefect({ id: "def-weak", blame: undefined }), { now: T0 });
    const strong = attributeDefect(root, "def-strong", strongSource(), { now: T0 + DAY });
    expect(strong.unattributed).toBe(false);
    const weak = attributeDefect(root, "def-weak", weakSource(), { now: T0 + DAY });
    expect(weak.unattributed).toBe(true);

    const all = listDefects(root);
    expect(all.items.length).toBe(2);
    expect(all.totalLines).toBe(4);

    const onlyUnattributed = listDefects(root, { unattributed: true });
    expect(onlyUnattributed.items.map((item) => item.defect.id)).toEqual(["def-weak"]);

    const attributable = listDefects(root, { unattributed: false });
    expect(attributable.items.map((item) => item.defect.id)).toEqual(["def-strong"]);

    const byCategory = listDefects(root, { category: "unrelated" });
    expect(byCategory.items.map((item) => item.defect.id)).toEqual(["def-weak"]);
    expect(listDefects(root, { category: "rework" }).items.map((item) => item.defect.id)).toEqual(["def-strong"]);
  });

  it("reportDefects 按最终状态计数", async () => {
    const root = await tmpRoot();
    registerDefect(root, strongDefect({ id: "def-1" }), { now: T0 });
    registerDefect(root, strongDefect({ id: "def-2", blame: undefined }), { now: T0 });
    registerDefect(root, strongDefect({ id: "def-3", files: ["apps/gateway/src/x.ts"] }), { now: T0 });
    attributeDefect(root, "def-1", strongSource(), { now: T0 + DAY });
    attributeDefect(root, "def-2", weakSource(), { now: T0 + DAY });

    const report = reportDefects(root);
    expect(report.ok).toBe(true);
    expect(report.total).toBe(3);
    expect(report.byCategory.rework).toBe(1);
    expect(report.byCategory.unrelated).toBe(1);
    expect(report.byCategory.unknown).toBe(1);
    expect(report.byConfidence.high).toBe(1);
    expect(report.byConfidence.low).toBe(2);
    expect(report.byMissedLink["impact-analysis"]).toBeGreaterThanOrEqual(1);
    expect(report.byMissedLink.none).toBeGreaterThanOrEqual(1);
    expect(report.unattributed).toBe(1);
    expect(report.pendingClarify).toBe(1);
    expect(report.parseErrors).toBe(0);
    expect(report.totalLines).toBe(5);
  });

  it("projectToGraph 真写临时图谱:anti-pattern + direction,重复调用幂等", async () => {
    const root = await tmpRoot();
    const graphRoot = await tmpRoot();
    registerDefect(root, strongDefect(), { now: T0 });
    attributeDefect(root, "def-1", strongSource(), { now: T0 + DAY });

    const first = projectToGraph(root, "def-1", { graphRoot, now: T0 + 2 * DAY });
    expect(first.ok).toBe(true);
    expect(first.code).toBe("DEFECT_GRAPH_PROJECTED");
    expect(first.nodes).toBe(first.ids.length);
    expect(first.nodes).toBe(2);
    expect(first.codes).toContain("DEFECT_GRAPH_PROJECTED");

    type NodeLike = { kind: string; statement: string; associations: { type: string; ref: string }[] };
    const nodes = Object.values(loadEvidenceGraph(graphRoot).graph.nodes) as unknown as NodeLike[];
    expect(nodes.length).toBe(2);
    expect(nodes.map((node) => node.kind).sort()).toEqual(["anti-pattern", "direction"]);
    const associations = nodes.flatMap((node) => node.associations.map((assoc) => assoc.type));
    expect(associations).toContain("task");
    expect(associations).toContain("module");

    const second = projectToGraph(root, "def-1", { graphRoot, now: T0 + 3 * DAY });
    expect(second.ok).toBe(true);
    expect(second.ids).toEqual(first.ids);
    expect(second.codes).toContain("EVIDENCE_DUPLICATE");
    expect(Object.values(loadEvidenceGraph(graphRoot).graph.nodes).length).toBe(2);
  });

  it("projectToGraph 对未入链缺陷返回 DEFECT_GRAPH_FAILED", async () => {
    const root = await tmpRoot();
    const graphRoot = await tmpRoot();
    registerDefect(root, strongDefect({ id: "def-u", blame: undefined }), { now: T0 });
    attributeDefect(root, "def-u", weakSource(), { now: T0 + DAY });

    const res = projectToGraph(root, "def-u", { graphRoot, now: T0 + 2 * DAY });
    expect(res.ok).toBe(false);
    expect(res.codes).toContain("DEFECT_GRAPH_FAILED");
    expect(res.ids).toEqual([]);
    expect(res.nodes).toBe(0);
    expect(Object.values(loadEvidenceGraph(graphRoot).graph.nodes).length).toBe(0);

    // 未归属：码面是 DEFECT_UNATTRIBUTED，codes 里带 GRAPH_FAILED（未入链不许进图）
    expect(res.code).toBe("DEFECT_UNATTRIBUTED");

    const missing = projectToGraph(root, "def-nope", { graphRoot });
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("DEFECT_NOT_FOUND");
  });

  it("坏行注入:parseErrors 计数且不 throw,好行照常可用", async () => {
    const root = await tmpRoot();
    registerDefect(root, strongDefect(), { now: T0 });
    const path = defectLineagePath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${await readFile(path, "utf8")}{"v":1,"type":"attribute" 坏行\n`, "utf8");

    const projection = loadDefects(root);
    expect(projection.parseErrors).toBe(1);
    expect(projection.totalLines).toBe(2);
    expect(projection.entries.get("def-1")?.status).toBe("registered");

    const list = listDefects(root);
    expect(list.parseErrors).toBe(1);
    expect(list.items.length).toBe(1);

    // 坏行不阻断后续写入
    const res = attributeDefect(root, "def-1", strongSource(), { now: T0 + DAY });
    expect(res.ok).toBe(true);
  });
});
