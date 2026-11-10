/**
 * 漏点预防件持久层:种入幂等 / 缺陷路由 / 过滤 / 注入 / 调权 / 过期 / 报表 / 坏行容忍 / 图谱投影。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterAll, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreventionEntry } from "@lampgenie/runtime/agent/gap-taxonomy";
import { clarifyDefect, registerDefect } from "../src/defect-lineage-store";
import { loadEvidenceGraph } from "../src/evidence-graph-store";
import {
  applyAt,
  bumpForDefect,
  expire,
  gapLedgerPath,
  listPreventions,
  loadGaps,
  reportGaps,
  routeFromDefect,
  seedTaxonomy,
} from "../src/gap-taxonomy-store";

const MODULE = "packages/harness-runtime/src/agent";
const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gap-taxonomy-store-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/** 用 #210 台账造一条「手工判定 plan-coverage」的缺陷并返回 id。 */
async function makeDefect(root: string, id = "D-1", missedLink = "plan-coverage"): Promise<string> {
  const registered = registerDefect(root, {
    id,
    fixTaskId: `T-${id}`,
    description: "漏了板型 accept 场景",
    files: [`${MODULE}/gap-taxonomy.ts`],
    fixedAt: 1_700_000_000_000,
    module: MODULE,
  });
  expect(registered.ok).toBe(true);
  const clarified = clarifyDefect(root, id, { by: "me", note: "手工判定", missedLink: missedLink as never });
  expect(clarified.ok).toBe(true);
  return id;
}

function makeEntry(overrides: Partial<PreventionEntry> = {}): PreventionEntry {
  return {
    id: "custom-expired",
    gapCategory: "plan-coverage",
    form: "context",
    carrier: "过期试用件",
    injectionPoint: "pre-plan",
    guidance: "试用期已过的预防件",
    trigger: {},
    confidence: 0.55,
    overfitRisk: "low",
    sourceDefectIds: [],
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("gap-taxonomy-store", () => {
  it("gapLedgerPath 落在 <root>/.genie/rsi/gaps.jsonl", async () => {
    const root = await tempRoot();
    expect(gapLedgerPath(root)).toBe(join(root, ".genie", "rsi", "gaps.jsonl"));
  });

  it("seed 幂等:第二次 added=0 + GAP_SEED_DUPLICATE,台账不重复条目", async () => {
    const root = await tempRoot();
    const first = seedTaxonomy(root);
    expect(first.ok).toBe(true);
    expect(first.added).toBeGreaterThan(0);
    expect(first.total).toBe(first.added);

    const second = seedTaxonomy(root);
    expect(second.ok).toBe(true);
    expect(second.added).toBe(0);
    expect(second.code).toBe("GAP_SEED_DUPLICATE");

    const text = await readFile(gapLedgerPath(root), "utf8");
    const ids = text
      .trim()
      .split("\n")
      .flatMap((line) => {
        const parsed = JSON.parse(line) as { entries?: { id: string }[] };
        return (parsed.entries ?? []).map((entry) => entry.id);
      });
    expect(new Set(ids).size).toBe(ids.length);
    expect(loadGaps(root).byId.size).toBe(first.added);
  });

  it("routeFromDefect 读真实 #210 台账:context+gate 两条,trigger 含 module,落行后 list 查得到", async () => {
    const root = await tempRoot();
    seedTaxonomy(root);
    const id = await makeDefect(root);

    const result = routeFromDefect(root, id, { now: 1_700_000_100_000 });
    expect(result.ok).toBe(true);
    expect(result.defectId).toBe(id);
    expect(result.category).toBe("plan-coverage");
    expect(result.codes).toContain("GAP_ROUTED");
    const forms = result.routed.map((entry) => entry.form);
    expect(forms).toContain("context");
    expect(forms).toContain("gate");
    for (const entry of result.routed) expect(entry.trigger.module).toBe(MODULE);
    expect(
      result.matchReasons.some((reason) => reason.startsWith("module-scope:") && reason.includes(MODULE)),
    ).toBe(true);

    const listed = listPreventions(root, { category: "plan-coverage" });
    expect(listed.ok).toBe(true);
    const ids = listed.items.map((entry) => entry.id);
    expect(ids).toContain("plan-gate-accept-template");
    expect(ids).toContain("plan-context-history");
  });

  it("missedLink=none → GAP_CATEGORY_NONE 且不落行;不存在的缺陷 → GAP_DEFECT_NOT_FOUND", async () => {
    const root = await tempRoot();
    seedTaxonomy(root);
    await makeDefect(root, "D-none", "none");
    const before = loadGaps(root).totalLines;

    const none = routeFromDefect(root, "D-none");
    expect(none.ok).toBe(true);
    expect(none.codes).toContain("GAP_CATEGORY_NONE");
    expect(none.routed).toEqual([]);
    expect(loadGaps(root).totalLines).toBe(before);

    const missing = routeFromDefect(root, "D-404");
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("GAP_DEFECT_NOT_FOUND");
    expect(missing.routed).toEqual([]);
  });

  it("listPreventions 按 category/form/injectionPoint 过滤;过期默认不列,includeExpired 列出", async () => {
    const root = await tempRoot();
    seedTaxonomy(root);
    seedTaxonomy(root, {
      now: 1_700_000_000_500,
      entries: [makeEntry({ expiresAt: 1_000 })],
    });

    const byCategory = listPreventions(root, { category: "tool-gap" });
    expect(byCategory.items.every((entry) => entry.gapCategory === "tool-gap")).toBe(true);
    expect(byCategory.byCategory["tool-gap"]).toBe(byCategory.items.length);

    const byForm = listPreventions(root, { form: "tool" });
    expect(byForm.items.length).toBeGreaterThan(0);
    expect(byForm.items.every((entry) => entry.form === "tool")).toBe(true);

    const byInjection = listPreventions(root, { injectionPoint: "pre-verify" });
    expect(byInjection.items.length).toBeGreaterThan(0);
    expect(byInjection.items.every((entry) => entry.injectionPoint === "pre-verify")).toBe(true);

    const hidden = listPreventions(root, { category: "plan-coverage" });
    expect(hidden.items.some((entry) => entry.id === "custom-expired")).toBe(false);

    const shown = listPreventions(root, { category: "plan-coverage", includeExpired: true });
    expect(shown.items.some((entry) => entry.id === "custom-expired")).toBe(true);

    const invalid = listPreventions(root, { form: "bogus" });
    expect(invalid.ok).toBe(false);
  });

  it("applyAt 按注入点分组且 counts 自洽;非法注入点 → GAP_INVALID_INPUT", async () => {
    const root = await tempRoot();
    seedTaxonomy(root);
    const id = await makeDefect(root, "D-apply");
    const routed = routeFromDefect(root, id);
    expect(routed.ok).toBe(true);

    const grouped = applyAt(root, "pre-plan", { module: MODULE, boardType: "code" });
    expect(grouped.ok).toBe(true);
    expect(grouped.counts.context).toBe(grouped.contextBlocks.length);
    expect(grouped.counts.gate).toBe(grouped.gates.length);
    expect(grouped.counts.tool).toBe(grouped.toolChecks.length);
    expect(grouped.contextBlocks.length).toBeGreaterThan(0);
    expect(grouped.gates.length).toBeGreaterThan(0);

    const bad = applyAt(root, "pre-nothing");
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("GAP_INVALID_INPUT");
    expect(bad.counts).toEqual({ context: 0, gate: 0, tool: 0 });
  });

  it("bumpForDefect 抬高 confidence 且不超过 0.9;无关联条目 → GAP_NO_MATCH", async () => {
    const root = await tempRoot();
    seedTaxonomy(root);
    const id = await makeDefect(root, "D-bump");
    routeFromDefect(root, id);

    const before = new Map(
      listPreventions(root, { category: "plan-coverage" }).items.map((entry) => [entry.id, entry.confidence]),
    );
    const bumped = bumpForDefect(root, id);
    expect(bumped.ok).toBe(true);
    expect(bumped.updated.length).toBeGreaterThan(0);
    const after = new Map(
      listPreventions(root, { category: "plan-coverage" }).items.map((entry) => [entry.id, entry.confidence]),
    );
    for (const item of bumped.updated) {
      expect(item.to).toBeGreaterThan(item.from);
      expect(item.to).toBeLessThanOrEqual(0.9);
      expect(after.get(item.id)).toBe(item.to);
      expect(before.get(item.id)).toBe(item.from);
    }

    expect(bumpForDefect(root, "D-unrelated").code).toBe("GAP_NO_MATCH");
  });

  it("expire:过期条目被返回,list 默认不再显示,行落 expire 审计", async () => {
    const root = await tempRoot();
    seedTaxonomy(root);
    seedTaxonomy(root, { entries: [makeEntry({ id: "custom-overdue", expiresAt: 1_000_000 })] });
    const before = loadGaps(root).totalLines;

    const result = expire(root, 2_000_000);
    expect(result.ok).toBe(true);
    expect(result.expired).toContain("custom-overdue");
    expect(loadGaps(root).totalLines).toBe(before + 1);

    expect(listPreventions(root, { category: "plan-coverage" }).items.some((entry) => entry.id === "custom-overdue")).toBe(
      false,
    );
    expect(expire(root, 3_000_000).ok).toBe(true);
  });

  it("routeFromDefect 过滤失效条目:过期 plan-coverage 条目不进 routed,也不落 route 行", async () => {
    const root = await tempRoot();
    seedTaxonomy(root);
    seedTaxonomy(root, {
      now: 1_700_000_000_500,
      entries: [makeEntry({ id: "custom-route-expired", expiresAt: 1_000 })],
    });
    const id = await makeDefect(root, "D-expired");
    const before = loadGaps(root).totalLines;

    const result = routeFromDefect(root, id, { now: 1_700_000_100_000 });
    expect(result.ok).toBe(true);
    expect(result.category).toBe("plan-coverage");
    expect(result.routed.length).toBeGreaterThan(0);
    expect(result.routed.some((entry) => entry.id === "custom-route-expired")).toBe(false);
    expect(result.matchReasons.some((reason) => reason.includes("custom-route-expired"))).toBe(false);
    expect(loadGaps(root).totalLines).toBe(before + 1);

    const rows = (await readFile(gapLedgerPath(root), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; entryIds?: string[] });
    const routeRows = rows.filter((row) => row.type === "route");
    expect(routeRows.length).toBe(1);
    expect(routeRows[0].entryIds ?? []).not.toContain("custom-route-expired");
  });

  it("reportGaps:维度计数/过期/unrouted 命中,坏行计入 parseErrors", async () => {
    const root = await tempRoot();
    seedTaxonomy(root);
    seedTaxonomy(root, { entries: [makeEntry({ id: "custom-report-expired", expiresAt: 1_000 })] });
    const id = await makeDefect(root, "D-report");
    routeFromDefect(root, id);
    await appendFile(
      gapLedgerPath(root),
      `${JSON.stringify({ v: 1, type: "route", at: 5, entries: [], entryIds: [], defectId: "D-void", codes: ["GAP_NO_MATCH"] })}\n`,
      "utf8",
    );

    const report = reportGaps(root);
    expect(report.ok).toBe(true);
    expect(report.total).toBe(loadGaps(root).byId.size);
    expect(report.byCategory["plan-coverage"]).toBeGreaterThan(0);
    expect(report.byForm["gate"]).toBeGreaterThan(0);
    expect(report.expired).toBe(1);
    expect(report.active).toBe(report.total - report.expired);
    expect(report.unrouted).toBe(1);
    expect(report.parseErrors).toBe(0);

    await appendFile(gapLedgerPath(root), "{not json}\n", "utf8");
    const afterBad = reportGaps(root);
    expect(afterBad.parseErrors).toBe(1);
    expect(afterBad.totalLines).toBe(report.totalLines + 1);
    expect(afterBad.total).toBe(report.total);
    expect(loadGaps(root).parseErrors).toBe(1);
  });

  it("空 root:各 API 不抛,返回空投影", async () => {
    const root = await tempRoot();
    expect(loadGaps(root)).toEqual({ entries: [], byId: new Map(), parseErrors: 0, totalLines: 0 });
    expect(listPreventions(root)).toEqual({ ok: true, items: [], total: 0, byCategory: {} });
    const applied = applyAt(root, "pre-plan");
    expect(applied.ok).toBe(true);
    expect(applied.counts).toEqual({ context: 0, gate: 0, tool: 0 });
    expect(expire(root).expired).toEqual([]);
    expect(reportGaps(root)).toMatchObject({ ok: true, total: 0, active: 0, expired: 0, parseErrors: 0, totalLines: 0 });
    expect(bumpForDefect(root, "D-1").code).toBe("GAP_NO_MATCH");
    expect(routeFromDefect(root, "D-1").code).toBe("GAP_DEFECT_NOT_FOUND");
  });

  it("graphRoot 投影:routed → #191 证据图,不抛", async () => {
    const root = await tempRoot();
    const graphRoot = await tempRoot();
    seedTaxonomy(root);
    const id = await makeDefect(root, "D-graph");

    const result = routeFromDefect(root, id, { graphRoot });
    expect(result.ok).toBe(true);
    expect(result.graph).toBeDefined();
    expect(typeof result.graph?.ok).toBe("boolean");
    if (result.graph?.ok === true) {
      expect(result.graph.ids.length).toBeGreaterThan(0);
      expect(loadEvidenceGraph(graphRoot).totalLines).toBeGreaterThan(0);
    } else {
      expect(Array.isArray(result.graph?.codes)).toBe(true);
    }
  });

  it("投影保留 route 行绑定的 module:list 可见,bump 之后不丢,applyAt 按 ctx 过滤", async () => {
    const root = await tempRoot();
    seedTaxonomy(root);
    const id = await makeDefect(root, "D-module");
    routeFromDefect(root, id);
    bumpForDefect(root, id);

    const listed = listPreventions(root, { category: "plan-coverage" });
    const scoped = listed.items.filter((entry) => entry.id === "plan-gate-accept-template");
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.trigger.module).toBe(MODULE);

    const GATE = "板型 P0 accept 模板必须含目标模块场景";
    expect(applyAt(root, "pre-plan", { module: MODULE }).gates).toContain(GATE);
    expect(applyAt(root, "pre-plan", { module: "some/other-module" }).gates).not.toContain(GATE);
    expect(applyAt(root, "pre-plan").gates).toContain(GATE);
  });

  it("非法入参一律折叠成 GAP_INVALID_INPUT,不抛", async () => {
    const root = await tempRoot();
    expect(seedTaxonomy("").code).toBe("GAP_INVALID_INPUT");
    expect(seedTaxonomy(root, { entries: [] }).code).toBe("GAP_INVALID_INPUT");
    expect(seedTaxonomy(root, { entries: "bogus" as never }).code).toBe("GAP_INVALID_INPUT");
    expect(routeFromDefect(root, "").code).toBe("GAP_INVALID_INPUT");
    expect(bumpForDefect("", "D-1").code).toBe("GAP_INVALID_INPUT");
    expect(applyAt(root, "mars").code).toBe("GAP_INVALID_INPUT");
    expect(expire("").ok).toBe(false);
    expect(listPreventions("").ok).toBe(false);
  });
});
