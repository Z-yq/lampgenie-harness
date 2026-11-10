/**
 * 方向总览(RSI #194)持久层:addX 落行 / 坏行跳过 / build 投影落盘 / resolve 失败不写盘与幂等 /
 * 快照读取与三视图(timeline、render、report)/ 多 root 隔离。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  addChange,
  addConflict,
  addDecision,
  addGoal,
  ATLAS_NOT_FOUND,
  atlasEntriesPath,
  atlasJsonPath,
  build,
  getAtlas,
  ingestDefects,
  loadAtlasEvents,
  render,
  reportAtlas,
  resolveConflict,
  timeline,
} from "../src/direction-atlas-store";

const tempDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-atlas-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const NOW = "2026-11-20T00:00:00.000Z";
const P = "p1";

type GoalInput = Parameters<typeof addGoal>[2];
type ChangeInput = Parameters<typeof addChange>[2];
type ConflictInput = Parameters<typeof addConflict>[2];
type DecisionInput = Parameters<typeof addDecision>[2];
type GeneInput = Parameters<typeof ingestDefects>[2];

function goal(id: string, over: Record<string, unknown> = {}): GoalInput {
  return {
    id,
    title: `目标 ${id}`,
    since: "2026-11-01T00:00:00.000Z",
    status: "active",
    evidenceRefs: ["e-1"],
    ...over,
  } as GoalInput;
}

function change(at: string, over: Record<string, unknown> = {}): ChangeInput {
  return {
    id: `ch-${at}`,
    at,
    kind: "pivot",
    from: "g1",
    to: "g2",
    reason: `${at} 转向`,
    evidenceRefs: ["e-1"],
    ...over,
  } as ChangeInput;
}

function conflict(id: string, goalIds: [string, string], over: Record<string, unknown> = {}): ConflictInput {
  return { id, goals: goalIds, description: `冲突 ${id}`, status: "open", ...over } as ConflictInput;
}

function decision(id: string, impact: string, over: Record<string, unknown> = {}): DecisionInput {
  return {
    id,
    at: "2026-11-03T00:00:00.000Z",
    decision: `决策 ${id}`,
    rationale: "依据",
    impact,
    evidenceRefs: ["e-1"],
    ...over,
  } as DecisionInput;
}

function genes(items: Array<[string, number]>): GeneInput {
  return items.map(([defectClass, count]) => ({
    id: `gene-${defectClass}`,
    defectClass,
    module: "gateway",
    count,
    lastAt: NOW,
  })) as GeneInput;
}

async function entryLines(root: string): Promise<string[]> {
  const text = await readFile(atlasEntriesPath(root), "utf8");
  return text.split("\n").filter((line) => line.trim() !== "");
}

async function entriesBytes(root: string): Promise<number> {
  const info = await stat(atlasEntriesPath(root)).catch(() => null);
  return info?.size ?? -1;
}

describe("direction-atlas-store / 事件台账", () => {
  it("addGoal 追加一行且可回读", async () => {
    const root = await tmpRoot();
    expect(addGoal(root, P, goal("g1", { at: NOW }), NOW)).toEqual({ ok: true });
    const lines = await entryLines(root);
    expect(lines).toHaveLength(1);
    const projected = loadAtlasEvents(root, P);
    expect(projected.events).toHaveLength(1);
    expect(projected.events[0].kind).toBe("goal");
    expect(projected.badLines).toBe(0);
  });

  it("addChange 追加一行且 kind=change", async () => {
    const root = await tmpRoot();
    expect(addChange(root, P, change("2026-11-02T00:00:00.000Z"), NOW)).toEqual({ ok: true });
    const { events } = loadAtlasEvents(root, P);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("change");
  });

  it("addConflict 追加一行且 kind=conflict", async () => {
    const root = await tmpRoot();
    expect(addConflict(root, P, conflict("c1", ["g1", "g2"]), NOW)).toEqual({ ok: true });
    const { events } = loadAtlasEvents(root, P);
    expect(events[0].kind).toBe("conflict");
  });

  it("addDecision 追加一行且 kind=decision", async () => {
    const root = await tmpRoot();
    expect(addDecision(root, P, decision("d1", "high"), NOW)).toEqual({ ok: true });
    const { events } = loadAtlasEvents(root, P);
    expect(events[0].kind).toBe("decision");
  });

  it("ingestDefects 两批累积而不是覆盖", async () => {
    const root = await tmpRoot();
    expect(ingestDefects(root, P, genes([["naming", 2]]), NOW)).toEqual({ ok: true });
    expect(ingestDefects(root, P, genes([["naming", 3], ["perf", 1]]), NOW)).toEqual({ ok: true });
    const lines = await entryLines(root);
    expect(lines).toHaveLength(2);
    const { events } = loadAtlasEvents(root, P);
    const built = build(root, P, { now: NOW });
    expect(built.ok).toBe(true);
    expect(events.filter((event) => event.kind === "defects")).toHaveLength(2);
  });
});

describe("direction-atlas-store / build 与快照", () => {
  it("build 落盘快照:summary 计数、topDefectClasses、原子写产物可完整 parse", async () => {
    const root = await tmpRoot();
    addGoal(root, P, goal("g1"), NOW);
    addGoal(root, P, goal("g2", { since: "2026-11-05T00:00:00.000Z" }), NOW);
    addGoal(root, P, goal("g3", { since: "2026-11-06T00:00:00.000Z", status: "achieved" }), NOW);
    addConflict(root, P, conflict("c1", ["g1", "g2"]), NOW);
    addDecision(root, P, decision("d1", "high"), NOW);
    ingestDefects(root, P, genes([["naming", 2], ["perf", 3]]), NOW);

    const built = build(root, P, { now: NOW });
    expect(built.ok).toBe(true);
    expect(built.badLines).toBe(0);
    expect(built.codes).toContain("ATLAS_BUILT");
    expect(built.path).toBe(atlasJsonPath(root, P));

    const raw = await readFile(atlasJsonPath(root, P), "utf8");
    const atlas = JSON.parse(raw) as Record<string, any>;
    expect(atlas.summary.activeGoals).toBe(2);
    expect(atlas.summary.achieved).toBe(1);
    expect(atlas.summary.openConflicts).toBe(1);
    expect(atlas.summary.highImpactDecisions).toBe(1);
    const classes = atlas.summary.topDefectClasses.map((row: any) => row.class);
    expect(classes).toContain("naming");
    expect(classes).toContain("perf");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("build 遇坏行计入 badLines 且不崩溃、不丢好行", async () => {
    const root = await tmpRoot();
    addGoal(root, P, goal("g1"), NOW);
    await appendFile(atlasEntriesPath(root), "{not json\n\n{\"kind\":\"ghost\",\"at\":\"x\"}\n", "utf8");
    addGoal(root, P, goal("g2", { since: "2026-11-04T00:00:00.000Z" }), NOW);

    const built = build(root, P, { now: NOW });
    expect(built.ok).toBe(true);
    expect(built.badLines).toBe(2);
    const atlas = built.atlas as Record<string, any>;
    expect(atlas.goals).toHaveLength(2);
  });

  it("build 两次(同 now)结果深度相等", async () => {
    const root = await tmpRoot();
    addGoal(root, P, goal("g1"), NOW);
    addChange(root, P, change("2026-11-02T00:00:00.000Z"), NOW);
    const first = build(root, P, { now: NOW });
    const second = build(root, P, { now: NOW });
    expect(first.atlas).toEqual(second.atlas);
  });

  it("getAtlas 未 build → ATLAS_NOT_FOUND", async () => {
    const root = await tmpRoot();
    expect(getAtlas(root, P)).toEqual({ ok: false, code: ATLAS_NOT_FOUND });
  });

  it("getAtlas 读回 build 的同一份快照", async () => {
    const root = await tmpRoot();
    addGoal(root, P, goal("g1"), NOW);
    const built = build(root, P, { now: NOW });
    const got = getAtlas(root, P);
    expect(got.ok).toBe(true);
    expect(got.atlas).toEqual(built.atlas);
  });
});

describe("direction-atlas-store / 冲突裁决", () => {
  async function seeded(): Promise<string> {
    const root = await tmpRoot();
    addGoal(root, P, goal("g1"), NOW);
    addGoal(root, P, goal("g2", { since: "2026-11-05T00:00:00.000Z" }), NOW);
    addConflict(root, P, conflict("c1", ["g1", "g2"]), NOW);
    build(root, P, { now: NOW });
    return root;
  }

  it("resolveConflict 成功后另一 goal superseded 且 openConflicts 归 0", async () => {
    const root = await seeded();
    const resolved = resolveConflict(root, P, "c1", {
      chosenGoalId: "g1",
      reason: "方向收拢",
      by: "lead",
      at: NOW,
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.code).toBe("ATLAS_CONFLICT_RESOLVED");
    expect(await entryLines(root)).toHaveLength(4);

    const built = build(root, P, { now: NOW });
    const atlas = built.atlas as Record<string, any>;
    expect(atlas.summary.openConflicts).toBe(0);
    const byId = new Map<string, any>(atlas.goals.map((item: any) => [item.id, item]));
    expect(byId.get("g2")?.status).toBe("superseded");
    expect(byId.get("g2")?.supersededBy).toBe("g1");
    expect(byId.get("g1")?.status).toBe("active");
    expect(atlas.conflicts[0].status).toBe("resolved");
    expect(atlas.conflicts[0].resolution.chosenGoalId).toBe("g1");
  });

  it("重复 resolve 幂等:entries 不增长、快照不变", async () => {
    const root = await seeded();
    const opts = { chosenGoalId: "g1", reason: "方向收拢", by: "lead", at: NOW };
    const first = resolveConflict(root, P, "c1", opts);
    expect(first.ok).toBe(true);
    const linesAfterFirst = await entryLines(root);
    const atlasAfterFirst = build(root, P, { now: NOW }).atlas;
    const second = resolveConflict(root, P, "c1", opts);
    expect(second.ok).toBe(true);
    expect(second.idempotent).toBe(true);
    expect(await entryLines(root)).toEqual(linesAfterFirst);
    expect(build(root, P, { now: NOW }).atlas).toEqual(atlasAfterFirst);
  });

  it("resolve 不存在的冲突 → ok:false 且 entries.jsonl 字节数不变", async () => {
    const root = await seeded();
    const before = await entriesBytes(root);
    const result = resolveConflict(root, P, "ghost", {
      chosenGoalId: "g1",
      reason: "x",
      by: "lead",
      at: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ATLAS_NOT_FOUND);
    expect(await entriesBytes(root)).toBe(before);
  });

  it("resolve chosen 不属于该冲突 → ATLAS_GOAL_NOT_FOUND 且不写盘", async () => {
    const root = await seeded();
    const before = await entriesBytes(root);
    const result = resolveConflict(root, P, "c1", {
      chosenGoalId: "g9",
      reason: "x",
      by: "lead",
      at: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ATLAS_GOAL_NOT_FOUND");
    expect(await entriesBytes(root)).toBe(before);
  });

  it("resolve 参数缺失 → ATLAS_INVALID_INPUT 且不建文件", async () => {
    const root = await tmpRoot();
    const result = resolveConflict(root, P, "", { chosenGoalId: "g1", reason: "x", by: "lead" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ATLAS_INVALID_INPUT");
    expect(await entriesBytes(root)).toBe(-1);
  });
});

describe("direction-atlas-store / 三视图与隔离", () => {
  async function seeded(): Promise<string> {
    const root = await tmpRoot();
    addGoal(root, P, goal("g1"), NOW);
    addChange(root, P, change("2026-11-02T00:00:00.000Z"), NOW);
    addChange(root, P, change("2026-11-10T00:00:00.000Z", { kind: "refocus", to: "g1" }), NOW);
    addConflict(root, P, conflict("c1", ["g1", "g2"]), NOW);
    addDecision(root, P, decision("d1", "high"), NOW);
    ingestDefects(root, P, genes([["naming", 2]]), NOW);
    build(root, P, { now: NOW });
    return root;
  }

  it("timeline 按 from/to 过滤", async () => {
    const root = await seeded();
    const all = timeline(root, P);
    expect(all.ok).toBe(true);
    expect(all.changes).toHaveLength(2);
    const narrowed = timeline(root, P, { from: "2026-11-05T00:00:00.000Z" });
    expect(narrowed.changes).toHaveLength(1);
    const upper = timeline(root, P, { to: "2026-11-05T00:00:00.000Z" });
    expect(upper.changes).toHaveLength(1);
    const none = timeline(root, P, { from: "2027-01-01T00:00:00.000Z" });
    expect(none.changes).toHaveLength(0);
  });

  it("render md 出五节、json 可 parse", async () => {
    const root = await seeded();
    const md = render(root, P, { format: "md" });
    expect(md.ok).toBe(true);
    expect(md.code).toBe("ATLAS_RENDERED");
    for (const title of ["当前目标", "转向时间线", "需求冲突与裁决", "关键决策", "缺陷基因摘要"]) {
      expect(md.text).toContain(title);
    }
    const json = render(root, P, { format: "json" });
    expect(json.ok).toBe(true);
    const parsed = JSON.parse(json.text as string) as Record<string, unknown>;
    expect(Array.isArray(parsed.goals)).toBe(true);
  });

  it("reportAtlas 摘要字段齐全", async () => {
    const root = await seeded();
    const result = reportAtlas(root, P);
    expect(result.ok).toBe(true);
    const report = result.report as Record<string, any>;
    expect(report.projectId).toBe(P);
    expect(report.activeGoals).toBe(1);
    expect(report.achieved).toBe(0);
    expect(report.abandoned).toBe(0);
    expect(report.abandonedGoals).toEqual([]);
    expect(report.openConflicts).toBe(1);
    expect(report.openConflictIds).toEqual(["c1"]);
    expect(report.highImpactDecisions).toBe(1);
    expect(report.topDefectClasses[0]).toMatchObject({ class: "naming", count: 2 });
    expect(report.goalCount).toBe(1);
    expect(report.changeCount).toBe(2);
    expect(report.decisionCount).toBe(1);
  });

  it("未 build 时 timeline / render / report 都返回 ATLAS_NOT_FOUND", async () => {
    const root = await tmpRoot();
    expect(timeline(root, P).code).toBe(ATLAS_NOT_FOUND);
    expect(render(root, P, { format: "md" }).code).toBe(ATLAS_NOT_FOUND);
    expect(reportAtlas(root, P).code).toBe(ATLAS_NOT_FOUND);
  });

  it("两个临时 root 互不干扰", async () => {
    const rootA = await tmpRoot();
    const rootB = await tmpRoot();
    addGoal(rootA, P, goal("ga"), NOW);
    addGoal(rootB, P, goal("gb"), NOW);
    build(rootA, P, { now: NOW });
    build(rootB, P, { now: NOW });
    const a = getAtlas(rootA, P).atlas as Record<string, any>;
    const b = getAtlas(rootB, P).atlas as Record<string, any>;
    expect(a.goals.map((item: any) => item.id)).toEqual(["ga"]);
    expect(b.goals.map((item: any) => item.id)).toEqual(["gb"]);
    // 另一个 project 在同一 root 下也读不到这份数据
    expect(getAtlas(rootA, "p2").code).toBe(ATLAS_NOT_FOUND);
  });
});
