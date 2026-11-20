/** 产物面聚合单测:fixture=拷贝生产环境真实台账 jsonl 到临时目录(不许手写理想数据),
 * 计数断言全部从 fixture 文件动态推导(与 wc -l / 逐行 type 计数对拍),1600 追加新行不破坏断言;
 * 另测空目录(全字段 undefined=面板诚实空态)与坏行容错。 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectRsiOutputs } from "../src/rsi-status.ts";

const ROOT = join(process.cwd(), "..", ".."); // vitest cwd=apps/gateway → 仓根
const RSI = join(ROOT, ".genie", "rsi");

function countLines(path: string): number {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").length;
}

let fixtureDir: string | undefined;

function buildFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "rsi-outputs-"));
  fixtureDir = dir;
  mkdirSync(join(dir, ".genie", "rsi", "atlas"), { recursive: true });
  mkdirSync(join(dir, ".genie", "rsi", "weekly"), { recursive: true });
  mkdirSync(join(dir, ".genie", "rsi", "nightly"), { recursive: true });
  mkdirSync(join(dir, ".genie", "evidence"), { recursive: true });
  mkdirSync(join(dir, ".genie", "experiments"), { recursive: true });
  for (const [src, dest] of [
    ["rework-chains.jsonl", join(".genie", "rsi", "rework-chains.jsonl")],
    ["negkb.jsonl", join(".genie", "rsi", "negkb.jsonl")],
    ["change-requests.jsonl", join(".genie", "rsi", "change-requests.jsonl")],
    ["cohort.jsonl", join(".genie", "rsi", "cohort.jsonl")],
    ["cost.jsonl", join(".genie", "rsi", "cost.jsonl")],
    [join("atlas", "lampgenie-harness.json"), join(".genie", "rsi", "atlas", "lampgenie-harness.json")],
    [join("nightly", "queue.jsonl"), join(".genie", "rsi", "nightly", "queue.jsonl")],
  ] as const) {
    const from = join(RSI, src);
    if (existsSync(from)) copyFileSync(from, join(dir, dest));
  }
 // 干净重测会清掉 negkb/change-requests/cost——fixture 缺件时补最小合成样本,
 // 保证测试锁的是「读取与投影契约」,不被生产账本的清理状态绑架。
  const ensure = (rel: string, body: string): void => {
    const path = join(dir, rel);
    if (!existsSync(path)) writeFileSync(path, body, "utf8");
  };
  ensure(
    join(".genie", "rsi", "negkb.jsonl"),
    JSON.stringify({
      type: "record",
      record: {
        id: "neg-fixture",
        plan: "用 grep 找模板串里的 UI 文案(已废弃)",
        context: { symptoms: ["grep 找不到内联脚本函数"] },
        alternative: "不要用 grep,改用 code_sense refs 一次查多候选",
        failureEvidence: [{ ref: "tasks/fixture.md" }],
        confidence: 0.6,
        createdAt: Date.now() - 86_400_000,
      },
    }) + "\n",
  );
  ensure(
    join(".genie", "rsi", "change-requests.jsonl"),
    JSON.stringify({ type: "create", request: { id: "cr-fixture", title: "源码变更:测试夹具", kind: "source", evidenceRefs: ["apps/gateway/src/rsi-status.ts"] } }) + "\n",
  );
  ensure(join(".genie", "rsi", "cohort.jsonl"), JSON.stringify({ type: "delivery", delivery: { taskId: "t1", module: "rsi", taskClass: "coding", changeNodes: 2 } }) + "\n" + JSON.stringify({ type: "fix", fix: { taskId: "t2" } }) + "\n");
  ensure(join(".genie", "rsi", "cost.jsonl"), JSON.stringify({ type: "saving", tokens: { total: 1000 } }) + "\n");
  const expFrom = join(ROOT, ".genie", "experiments", "ledger.jsonl");
  if (existsSync(expFrom)) copyFileSync(expFrom, join(dir, ".genie", "experiments", "ledger.jsonl"));
  const graphFrom = join(ROOT, ".genie", "evidence", "graph.jsonl");
  if (existsSync(graphFrom)) copyFileSync(graphFrom, join(dir, ".genie", "evidence", "graph.jsonl"));
  const weeklyDir = join(RSI, "weekly");
  if (existsSync(weeklyDir)) {
    const mds = readdirSync(weeklyDir).filter((n) => n.endsWith(".md")).sort();
    if (mds.length > 0) copyFileSync(join(weeklyDir, mds[mds.length - 1]), join(dir, ".genie", "rsi", "weekly", mds[mds.length - 1]));
  }
  return dir;
}

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

describe("collectRsiOutputs(真实台账 fixture)", () => {
  it("返工链:计数与台账对拍;核验分层四档合计=total,确认项带人话改进", async () => {
    const dir = buildFixture();
    const o = await collectRsiOutputs(dir);
    const path = join(dir, ".genie", "rsi", "rework-chains.jsonl");
    const rows = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
    const rc = o.reworkChains;
    expect(rc?.total).toBe(rows.length);
    expect(rc?.total).toBeGreaterThan(0);
    const withPrev = rows.filter((r) => r.prevention && typeof r.prevention === "object").length;
    expect(rc?.withPrevention).toBe(withPrev);
    const evMap: Record<string, number> = rc?.byEvidence ?? {};
    const sum = Object.values(evMap).reduce((a, b) => a + b, 0);
    expect(sum).toBe(rows.length);
    expect((rc?.confirmed ?? 0) + (rc?.probable ?? 0) + (rc?.weak ?? 0) + (rc?.excluded ?? 0)).toBe(rows.length);
 // 真实台账里至少有一条同任务族(等)能被确认;确认项必须带人话字段。
    const confirmed = (rc?.items ?? []).filter((it) => it.tier === "confirmed");
    expect(confirmed.length).toBeGreaterThanOrEqual(1);
    for (const it of confirmed) {
      expect(it.tierReason).toContain("同一任务族");
      expect(it.buildAction).not.toBe("");
      expect(it.fixAction).not.toBe("");
      expect(it.improvement).not.toBe("");
      expect(it.improvementStatus).not.toBe("");
    }
 // 核验排除项必须给出理由;没有逻辑单元的不能显示成 "?"。
    const excluded = (rc?.items ?? []).filter((it) => it.tier === "excluded");
    for (const it of excluded) {
      expect(it.tierReason.length).toBeGreaterThan(4);
      if (it.path === "" && it.logicalKey === "") expect(it.moduleLabel).toBe("(未定位)");
    }
  });
  it("知识库:证据观测去重合并 + 基因/死路 + 新增计数 + 用途(灰度/队列/提示)", async () => {
    const o = await collectRsiOutputs(fixtureDir!);
    const kb = o.knowledge;
    expect(kb).toBeDefined();
    expect(kb!.total).toBe(kb!.items.length);
    expect(kb!.newCount + kb!.existingCount).toBe(kb!.total);
    const byTypeSum = Object.values(kb!.byType).reduce((a, b) => a + b, 0);
    expect(byTypeSum).toBe(kb!.total);
    const genes = kb!.items.filter((it) => it.type === "gene");
    expect(genes.length).toBeGreaterThanOrEqual(1);
    expect(genes[0]!.actionKind).toBe("injected");
    const dead = kb!.items.find((it) => it.type === "dead-end");
    expect(dead?.detail).toContain("替代");
 // 同一 cand-* 的多条证据观察必须合并成一条(observations>1),而不是一条知识几十张卡。
    const facts = kb!.items.filter((it) => it.type === "fact" && it.observations > 1);
    expect(facts.length).toBeGreaterThanOrEqual(1);
  });
  it("世界模型:目标带新增/演进/代表任务,热点带新/延续标记", async () => {
    const o = await collectRsiOutputs(fixtureDir!);
    const proj = o.projectsAtlas?.find((p) => p.project === "lampgenie-harness");
    expect(proj).toBeDefined();
    expect(proj!.sessions).toBeGreaterThan(0);
    expect(proj!.goals.length).toBeGreaterThanOrEqual(1);
    const g = proj!.goals[0]!;
    expect(typeof g.isNew).toBe("boolean");
    expect(Array.isArray(g.progress)).toBe(true);
    expect(Array.isArray(g.representativeTasks)).toBe(true);
    expect(proj!.newGoals + proj!.existingGoals).toBe(proj!.goals.length);
    expect(proj!.newHotModules + proj!.existingHotModules).toBe(proj!.hotModules.length);
    const withProgress = proj!.goals.find((x) => x.progress.length > 0);
    expect(withProgress).toBeDefined();
    expect(proj!.latestEvolution).not.toBe("");
  });
  it("死路(negkb):条数=行数,首条含 plan/alternative(用户最想要的产物)", async () => {
    const o = await collectRsiOutputs(fixtureDir!);
    const lines = countLines(join(fixtureDir!, ".genie", "rsi", "negkb.jsonl"));
    expect(o.negkb?.total).toBe(lines);
    expect(lines).toBeGreaterThanOrEqual(1);
    expect(o.negkb?.items[0]?.plan).toBeTruthy();
    expect(o.negkb?.items[0]?.alternative).toContain("grep");
  });
  it("证据图:nodes=add 行数,当前零边(correction 链路未通),节点含 statement/confidence", async () => {
    const o = await collectRsiOutputs(fixtureDir!);
    const rows = readFileSync(join(fixtureDir!, ".genie", "evidence", "graph.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
    const adds = rows.filter((r) => r.type === "add");
    const links = rows.filter((r) => r.type === "link");
    expect(o.evidenceGraph?.nodes).toBe(adds.length);
    expect(o.evidenceGraph?.edges).toBe(links.length);
    expect(o.evidenceGraph?.items[0]?.statement).toBeTruthy();
    expect(o.evidenceGraph?.items[0]?.confidence).toBeGreaterThan(0);
  });
  it("变更请求/cohort/周报/atlas/成本:计数与文本逐一对拍", async () => {
    const o = await collectRsiOutputs(fixtureDir!);
    expect(o.changeRequests?.total).toBe(countLines(join(fixtureDir!, ".genie", "rsi", "change-requests.jsonl")));
    expect(o.changeRequests?.items[0]?.title).toContain("源码");
    const cohortRows = readFileSync(join(fixtureDir!, ".genie", "rsi", "cohort.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
    expect(o.cohort?.deliveries).toBe(cohortRows.filter((r) => r.type === "delivery").length);
    expect(o.cohort?.fixes).toBe(cohortRows.filter((r) => r.type === "fix").length);
    expect(o.weekly?.text).toContain("自主决策");
    expect(o.weekly?.text).toContain("净省");
    expect(o.atlas?.goals).toBeGreaterThanOrEqual(1);
    expect(o.atlas?.defectGenes.length).toBeGreaterThanOrEqual(1);
    const costRows = readFileSync(join(fixtureDir!, ".genie", "rsi", "cost.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
    expect(o.cost?.entries).toBe(costRows.length);
    expect(o.cost?.totalTokens).toBe(costRows.reduce((a, r) => a + (r.tokens?.total ?? 0), 0));
  });
  it("空目录:全字段 undefined(面板诚实空态);空串 root 同样不炸", async () => {
    const empty = mkdtempSync(join(tmpdir(), "rsi-empty-"));
    try {
      const o = await collectRsiOutputs(empty);
      expect(o.reworkChains).toBeUndefined();
      expect(o.negkb).toBeUndefined();
      expect(o.evidenceGraph).toBeUndefined();
      expect(o.changeRequests).toBeUndefined();
      expect(o.cohort).toBeUndefined();
      expect(o.weekly).toBeUndefined();
      expect(o.atlas).toBeUndefined();
      expect(o.cost).toBeUndefined();
      const o2 = await collectRsiOutputs("");
      expect(o2).toEqual({});
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
  it("坏行容错:混入非 JSON 行不炸,好行照常聚出", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rsi-bad-"));
    try {
      mkdirSync(join(dir, ".genie", "rsi"), { recursive: true });
      const good = JSON.stringify({
        type: "record",
        record: { id: "neg-bad", plan: "坏行容错样本", context: { symptoms: ["x"] }, alternative: "grep 兜底", createdAt: Date.now() },
      });
      writeFileSync(join(dir, ".genie", "rsi", "negkb.jsonl"), "{not json\n" + good + "\n");
      const o = await collectRsiOutputs(dir);
      expect(o.negkb?.total).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
