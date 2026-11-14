/**
 * 证据图谱持久层:append-only 落盘 / 坏行容忍投影 / 版本链 / 权威降级 / 衰减状态回放 / 幂等。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddEvidenceInput } from "@lampgenie/runtime/agent/evidence-graph";
import {
  addEvidence,
  applyDecay,
  conflicts,
  correctEvidence,
  evidenceGraphPath,
  history,
  linkEvidence,
  linksOf,
  loadEvidenceGraph,
  markAuthoritative,
  queryEvidence,
  reportEvidence,
  rescoreForModelVersion,
  supersedeEvidence,
} from "../src/evidence-graph-store";

const tempDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-evidence-store-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const T0 = 1_700_000_000_000;
const T1 = T0 + 1_000_000;
const DAY = 86_400_000;

/** 一条同模块关联的 fact 输入。 */
function fact(statement: string, over: Partial<AddEvidenceInput> = {}): AddEvidenceInput {
  return {
    kind: "fact",
    statement,
    associations: [{ type: "module", ref: "mod-a" }],
    at: T0,
    ...over,
  };
}

async function lineCount(root: string): Promise<number> {
  try {
    const text = await readFile(evidenceGraphPath(root), "utf8");
    return text.split("\n").filter((line) => line.trim() !== "").length;
  } catch {
    return 0;
  }
}

describe("evidence-graph-store", () => {
  it("缺失文件时投影为空", () => {
    return tmpRoot().then((root) => {
      const projection = loadEvidenceGraph(root);
      expect(projection.totalLines).toBe(0);
      expect(projection.parseErrors).toBe(0);
      expect(Object.keys(projection.graph.nodes)).toHaveLength(0);
      expect(projection.graph.schemaVersion).toBe(1);
    });
  });

  it("add 落盘一行,投影可读回", async () => {
    const root = await tmpRoot();
    const res = addEvidence(root, fact("缓存命中率随固定前缀稳定"));
    expect(res.ok).toBe(true);
    expect(res.id).toMatch(/^ev-/);
    expect(await lineCount(root)).toBe(1);
    const projection = loadEvidenceGraph(root);
    expect(projection.totalLines).toBe(1);
    expect(projection.graph.nodes[res.id!]!.statement).toBe("缓存命中率随固定前缀稳定");
    expect(projection.graph.nodes[res.id!]!.status).toBe("active");
  });

  it("同输入重复 add 返回 DUPLICATE 且文件不增行", async () => {
    const root = await tmpRoot();
    const first = addEvidence(root, fact("同一结论不得重复入库"));
    const second = addEvidence(root, fact("同一结论不得重复入库"));
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, code: "EVIDENCE_DUPLICATE" });
    expect(await lineCount(root)).toBe(1);
  });

  it("坏行只计 parseErrors,不影响其它节点投影", async () => {
    const root = await tmpRoot();
    addEvidence(root, fact("好行照常投影"));
    const path = evidenceGraphPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${await readFile(path, "utf8")}{"v":1,"type":"add","node":{}}\nnot-json\n`, "utf8");
    const projection = loadEvidenceGraph(root);
    expect(projection.parseErrors).toBe(2);
    expect(projection.totalLines).toBe(3);
    expect(Object.keys(projection.graph.nodes)).toHaveLength(1);
  });

  it("supersede 双向指针 + 旧版 validTo 落在投影里", async () => {
    const root = await tmpRoot();
    const oldId = addEvidence(root, fact("旧结论 A")).id!;
    const res = supersedeEvidence(root, oldId, fact("新结论 B", { at: T1 }), { by: "lead", reason: "新证据", at: T1 });
    expect(res.ok).toBe(true);
    expect(res.id).not.toBe(oldId);
    expect(await lineCount(root)).toBe(2);
    const { graph } = loadEvidenceGraph(root);
    expect(graph.nodes[oldId]!.validTo).toBe(T1);
    expect(graph.nodes[oldId]!.supersededBy).toBe(res.id);
    expect(graph.nodes[res.id!]!.supersedes).toBe(oldId);
    expect(graph.nodes[res.id!]!.authoritativeness).toBe("latest");
  });

  it("correct 生成新版本:默认查询只剩新版,history 可回放两版", async () => {
    const root = await tmpRoot();
    const oldId = addEvidence(root, fact("用户最初的说法")).id!;
    const res = correctEvidence(root, oldId, { statement: "用户纠正后的说法", by: "小飞", reason: "用户纠正", at: T1 });
    expect(res.ok).toBe(true);
    const projection = loadEvidenceGraph(root);
    expect(projection.graph.nodes[res.id!]!.corrections.at(-1)!.fromStatement).toBe("用户最初的说法");

    const current = queryEvidence(root, { at: T1 + 1 });
    expect(current.map((n) => n.id)).toEqual([res.id]);
    expect(current[0]!.statement).toBe("用户纠正后的说法");

    const chain = history(root, res.id!);
    expect(chain.map((n) => n.id)).toEqual([oldId, res.id]);
    expect(chain.map((n) => n.status)).toEqual(["active", "active"]);
  });

  it("markAuthoritative 落盘后重开仍生效,组内旧权威降为 latest", async () => {
    const root = await tmpRoot();
    const a = addEvidence(root, fact("结论 A")).id!;
    const b = addEvidence(root, fact("结论 B", { at: T1 })).id!;
    expect(markAuthoritative(root, a).ok).toBe(true);
    expect(loadEvidenceGraph(root).graph.nodes[a]!.authoritativeness).toBe("authoritative");

    expect(markAuthoritative(root, b).ok).toBe(true);
    const { graph } = loadEvidenceGraph(root);
    expect(graph.nodes[b]!.authoritativeness).toBe("authoritative");
    expect(graph.nodes[a]!.authoritativeness).toBe("latest");
  });

  it("conflicts 显式并存:同 association + 同 kind 的两条相反结论", async () => {
    const root = await tmpRoot();
    const a = addEvidence(root, fact("同一模块延迟下降")).id!;
    const b = addEvidence(root, fact("同一模块延迟上升", { at: T1 })).id!;
    const groups = conflicts(root, T1 + 1);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.associationKey).toBe("module:mod-a");
    expect(groups[0]!.nodes.map((n) => n.id).sort()).toEqual([a, b].sort());
    expect(groups[0]!.latestId).toBe(b);
    expect(await lineCount(root)).toBe(2);
  });

  it("applyDecay 落状态补丁:report 计数、不物理删、重开投影一致", async () => {
    const root = await tmpRoot();
    const oldId = addEvidence(root, fact("很旧的证据", { confidence: 1, at: T0 })).id!;
    const freshId = addEvidence(root, fact("新鲜的证据", { confidence: 1, at: T0 + 30 * DAY })).id!;
    const at = T0 + 30 * DAY;
    const res = applyDecay(root, { at, halfLifeDays: 1, staleBelow: 0.6, archiveBelow: 0.1 });
    expect(res.ok).toBe(true);
    expect(res.report!.archived).toBe(1);
    expect(res.report!.archivedIds).toEqual([oldId]);

    const before = await lineCount(root);
    const again = applyDecay(root, { at, halfLifeDays: 1, staleBelow: 0.6, archiveBelow: 0.1 });
    expect(again.ok).toBe(true);
    expect(again.report!.archived).toBe(0);
    expect(again.report!.stale).toBe(0);
    expect(await lineCount(root)).toBe(before);

    const { graph } = loadEvidenceGraph(root);
    expect(Object.keys(graph.nodes)).toHaveLength(2);
    expect(graph.nodes[oldId]!.status).toBe("archived");
    expect(graph.nodes[oldId]!.archivedReason).toBe("decay");
    expect(graph.nodes[freshId]!.status).toBe("active");
    expect(await lineCount(root)).toBe(2 + 1);
  });

  it("applyDecay maxNodes 容量逐出记 archivedReason=capacity", async () => {
    const root = await tmpRoot();
    addEvidence(root, fact("低分节点", { confidence: 0.2, at: T0 }));
    const keeperId = addEvidence(root, fact("高分节点", { confidence: 0.9, at: T0 })).id!;
    const res = applyDecay(root, { at: T0, halfLifeDays: 10, staleBelow: 0.01, maxNodes: 1 });
    expect(res.ok).toBe(true);
    expect(res.report!.evicted).toBe(1);
    const { graph } = loadEvidenceGraph(root);
    const evicted = Object.values(graph.nodes).filter((n) => n.archivedReason === "capacity");
    expect(evicted).toHaveLength(1);
    expect(graph.nodes[keeperId]!.status).toBe("active");
  });

  it("algo:非法 decay policy 折叠成 INVALID_INPUT 且不写盘", async () => {
    const root = await tmpRoot();
    addEvidence(root, fact("不会被动到的证据"));
    const res = applyDecay(root, { halfLifeDays: 0, staleBelow: 0.5 });
    expect(res).toEqual({ ok: false, code: "EVIDENCE_INVALID_INPUT" });
    expect(await lineCount(root)).toBe(1);
  });

  it("query 支持 projectId/module/tool 过滤与 includeHistory", async () => {
    const root = await tmpRoot();
    const moduleId = addEvidence(
      root,
      fact("模块证据", { projectId: "proj-1", associations: [{ type: "module", ref: "m1" }] }),
    ).id!;
    const toolId = addEvidence(
      root,
      fact("工具证据", { projectId: "proj-2", associations: [{ type: "tool", ref: "t1" }] }),
    ).id!;
    expect(queryEvidence(root, { at: T0 + 1, projectId: "proj-1" }).map((n) => n.id)).toEqual([moduleId]);
    expect(queryEvidence(root, { at: T0 + 1, module: "m1" }).map((n) => n.id)).toEqual([moduleId]);
    expect(queryEvidence(root, { at: T0 + 1, tool: "t1" }).map((n) => n.id)).toEqual([toolId]);

    const oldId = moduleId;
    const newId = correctEvidence(root, oldId, { statement: "模块证据 v2", by: "lead", reason: "修订", at: T1 }).id!;
    expect(queryEvidence(root, { at: T1 + 1, module: "m1" }).map((n) => n.id)).toEqual([newId]);
    expect(queryEvidence(root, { at: T1 + 1, module: "m1", includeHistory: true }).map((n) => n.id).sort()).toEqual(
      [oldId, newId].sort(),
    );
  });

  it("reportEvidence 汇总节点/状态/冲突/坏行", async () => {
    const root = await tmpRoot();
    addEvidence(root, fact("结论 1"));
    addEvidence(root, fact("结论 2"));
    const report = reportEvidence(root);
    expect(report.ok).toBe(true);
    expect(report.nodes).toBe(2);
    expect(report.active).toBe(2);
    expect(report.stale).toBe(0);
    expect(report.archived).toBe(0);
    expect(report.conflicts).toBe(1);
    expect(report.byKind).toEqual({ fact: 2 });
    expect(report.parseErrors).toBe(0);
    expect(report.totalLines).toBe(2);
  });

  it("重开读取幂等:同文件两次投影深相等", () => {
    return tmpRoot().then(async (root) => {
      const id = addEvidence(root, fact("幂等结论")).id!;
      supersedeEvidence(root, id, fact("幂等结论 v2", { at: T1 }), { by: "lead", reason: "更新", at: T1 });
      const a = loadEvidenceGraph(root);
      const b = loadEvidenceGraph(root);
      expect(a).toEqual(b);
      expect(a.totalLines).toBe(2);
    });
  });

  it("rescoreForModelVersion 预览:不落盘且列出受影响 id", async () => {
    const root = await tmpRoot();
    const a = addEvidence(root, fact("旧模型结论 A", { modelVersion: "m1" })).id!;
    const b = addEvidence(root, fact("旧模型结论 B", { modelVersion: "m1" })).id!;
    const before = await lineCount(root);
    const preview = rescoreForModelVersion(root, "m2", { at: T1 });
    expect(preview.ok).toBe(true);
    expect(preview.preview).toBe(true);
    expect(preview.rescored).toEqual([a, b].sort());
    expect(await lineCount(root)).toBe(before);
    expect(loadEvidenceGraph(root).graph.nodes[a]!.status).toBe("active");
  });

  it("rescoreForModelVersion apply:落一行 rescore,旧版本转 stale、m2 保持 active", async () => {
    const root = await tmpRoot();
    const oldA = addEvidence(root, fact("旧模型结论 A", { modelVersion: "m1" })).id!;
    const oldB = addEvidence(root, fact("旧模型结论 B", { modelVersion: "m1" })).id!;
    const fresh = addEvidence(root, fact("新模型结论", { modelVersion: "m2" })).id!;
    const before = await lineCount(root);
    const res = rescoreForModelVersion(root, "m2", { apply: true, at: T1 });
    expect(res).toMatchObject({ ok: true, preview: false, rescored: [oldA, oldB].sort() });
    expect(await lineCount(root)).toBe(before + 1);

    const raw = await readFile(evidenceGraphPath(root), "utf8");
    const last = JSON.parse(raw.trim().split("\n").at(-1)!) as Record<string, unknown>;
    expect(last).toMatchObject({ v: 1, type: "rescore", at: T1, modelVersion: "m2" });
    expect(last["ids"]).toEqual([oldA, oldB].sort());
    expect(last["statuses"]).toEqual({ [oldA]: "stale", [oldB]: "stale" });

    const projection = loadEvidenceGraph(root);
    expect(projection.parseErrors).toBe(0);
    expect(projection.graph.nodes[oldA]!.status).toBe("stale");
    expect(projection.graph.nodes[oldA]!.staleReason).toBe("model-version");
    expect(projection.graph.nodes[fresh]!.status).toBe("active");
  });

  it("rescoreForModelVersion 无旧版本节点:rescored=0 且 apply 不写行", async () => {
    const root = await tmpRoot();
    addEvidence(root, fact("已是当前模型结论", { modelVersion: "m2" }));
    addEvidence(root, fact("无模型版本结论"));
    const before = await lineCount(root);
    const preview = rescoreForModelVersion(root, "m2");
    expect(preview).toMatchObject({ ok: true, rescored: [], preview: true });
    const applied = rescoreForModelVersion(root, "m2", { apply: true });
    expect(applied).toMatchObject({ ok: true, rescored: [], preview: false });
    expect(await lineCount(root)).toBe(before);
  });

  it("linkEvidence:边落行、投影回放、邻接查询、重复幂等", async () => {
    const root = await tmpRoot();
    const a = addEvidence(root, fact("结论 A")).id!;
    const b = addEvidence(root, fact("结论 B")).id!;
    const res = linkEvidence(root, { from: a, to: b, type: "supports", note: "同模块同因", at: T1 });
    expect(res.ok).toBe(true);
    expect(res.link).toMatchObject({ from: a, to: b, type: "supports", at: T1, note: "同模块同因" });

    const raw = await readFile(evidenceGraphPath(root), "utf8");
    const last = JSON.parse(raw.trim().split("\n").at(-1)!) as Record<string, unknown>;
    expect(last).toMatchObject({ v: 1, type: "link", at: T1 });

 // 重复同 (from,to,type) → DUPLICATE,不再落行
    const before = await lineCount(root);
    const dup = linkEvidence(root, { from: a, to: b, type: "supports" });
    expect(dup.ok).toBe(false);
    expect(dup.code).toBe("EVIDENCE_DUPLICATE");
    expect(await lineCount(root)).toBe(before);

 // 投影:graph.links 有边;邻接查询出边/入边各就位
    const projection = loadEvidenceGraph(root);
    expect(projection.graph.links?.length).toBe(1);
    expect(linksOf(root, a).outgoing.map((l) => l.type)).toEqual(["supports"]);
    expect(linksOf(root, b).incoming.map((l) => l.from)).toEqual([a]);
    expect(linksOf(root, "ev-nonexistent")).toEqual({ outgoing: [], incoming: [] });
  });

  it("linkEvidence:端点缺失/自环/非法 type → 稳定码,不落行", async () => {
    const root = await tmpRoot();
    const a = addEvidence(root, fact("孤立结论")).id!;
    expect(linkEvidence(root, { from: a, to: "ev-missing", type: "supports" })).toMatchObject({
      ok: false,
      code: "EVIDENCE_NOT_FOUND",
    });
    expect(linkEvidence(root, { from: a, to: a, type: "supports" })).toMatchObject({
      ok: false,
      code: "EVIDENCE_INVALID_INPUT",
    });
    expect(linkEvidence(root, { from: a, to: a, type: "no-such-type" as never })).toMatchObject({
      ok: false,
      code: "EVIDENCE_INVALID_INPUT",
    });
  });

  it("link 行坏行容忍 + 悬空边入 report.danglingLinks", async () => {
    const root = await tmpRoot();
    const a = addEvidence(root, fact("有节点")).id!;
 // 手工追加一条指向不存在节点的 link 行(绕过写入校验,模拟坏上游)
    await writeFile(evidenceGraphPath(root), JSON.stringify({ v: 1, type: "link", at: T1, link: { from: a, to: "ev-gone", type: "supports", at: T1 } }) + "\n", { flag: "a", encoding: "utf8" });
 // 坏 link 行(缺 type)
    await writeFile(evidenceGraphPath(root), JSON.stringify({ v: 1, type: "link", at: T1, link: { from: a, to: a, at: T1 } }) + "\n", { flag: "a", encoding: "utf8" });
    const projection = loadEvidenceGraph(root);
    expect(projection.parseErrors).toBe(1); // 缺 type 的行被跳过;悬空但形状合法的行进投影
    const report = reportEvidence(root);
    expect(report.links).toBe(1);
    expect(report.linksByType).toEqual({ supports: 1 });
    expect(report.danglingLinks).toBe(1);
  });
});
