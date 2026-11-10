/**
 * RSI 成本台账(store 层):记账 / 坏行计数 / 周期报告 / 预览不落盘 / apply 落行 /
 * pause 真接熔断台账 / 汇总与最近状态 / 参数错误。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getState } from "../src/rsi-breaker-store";
import {
  costPaths,
  cycleReport,
  evaluateRoiGate,
  loadCostProjection,
  recordCost,
  recordSavings,
  reportCost,
  RSI_COST_STORE_CODES,
} from "../src/rsi-cost-store";

const tempDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-rsi-cost-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** 台账非空行(直接读文件,绕开投影)。 */
async function ledgerLines(root: string): Promise<string[]> {
  const text = await readFile(costPaths(root).file, "utf8");
  return text.split("\n").filter((line) => line.trim() !== "");
}

function costEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "c1",
    cycleId: "cycle-1",
    at: "2026-11-01T00:00:00.000Z",
    stage: "mining",
    mechanismId: "m1",
    projectId: "p1",
    tokens: { input: 100, output: 20, total: 120 },
    wallMs: 1000,
    usd: 0.01,
    ...over,
  };
}

function savingEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "s1",
    cycleId: "cycle-1",
    at: "2026-11-01T01:00:00.000Z",
    mechanismId: "m1",
    projectId: "p1",
    tokensSaved: 120,
    wallMsSaved: 500,
    usdSaved: 0.02,
    ...over,
  };
}

/** 造一段「每周期净亏 110」的台账(root 下写 cost 120 / saving 10)。 */
function negativeCycle(root: string, id: string): void {
  recordCost(root, costEntry({ id: `${id}-c`, cycleId: id, at: "2026-11-01T00:00:00.000Z", tokens: { input: 100, output: 20, total: 120 }, wallMs: 1000 }) as never);
  recordSavings(root, savingEntry({ id: `${id}-s`, cycleId: id, at: "2026-11-01T00:10:00.000Z", tokensSaved: 10 }) as never);
}

describe("记账", () => {
  it("recordCost 落一行(v/type/at/条目字段)", async () => {
    const root = await tmpRoot();
    expect(recordCost(root, costEntry() as never)).toEqual({ ok: true, codes: [], at: "2026-11-01T00:00:00.000Z" });
    const lines = await ledgerLines(root);
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]);
    expect(row.v).toBe(1);
    expect(row.type).toBe("cost");
    expect(row.at).toBe("2026-11-01T00:00:00.000Z");
    expect(row.stage).toBe("mining");
    expect(row.tokens).toEqual({ input: 100, output: 20, total: 120 });
  });

  it("recordSavings 落一行(未知字段被丢弃)", async () => {
    const root = await tmpRoot();
    const result = recordSavings(root, savingEntry({ evil: "x" }) as never);
    expect(result.ok).toBe(true);
    const row = JSON.parse((await ledgerLines(root))[0]);
    expect(row.type).toBe("saving");
    expect(row.tokensSaved).toBe(120);
    expect(row.evil).toBeUndefined();
  });

  it("缺 at 时自动补 ISO 时间戳", async () => {
    const root = await tmpRoot();
    const entry = costEntry();
    delete entry.at;
    recordCost(root, entry as never);
    const row = JSON.parse((await ledgerLines(root))[0]);
    expect(typeof row.at).toBe("string");
    expect(Number.isNaN(Date.parse(row.at))).toBe(false);
  });

  it("空仓投影:0 行 / 0 坏行", async () => {
    const root = await tmpRoot();
    expect(loadCostProjection(root)).toEqual({ rows: [], badLines: 0, totalLines: 0 });
  });
});

describe("坏行与投影", () => {
  it("坏行只计 badLines 并跳过:JSON 坏 / 未知 v / 未知 type / 缺 at", async () => {
    const root = await tmpRoot();
    recordCost(root, costEntry() as never);
    const { file } = costPaths(root);
    const extra = [
      "{不是 json",
      JSON.stringify({ v: 2, type: "cost", at: "2026-11-01T00:00:00.000Z" }),
      JSON.stringify({ v: 1, type: "mystery", at: "2026-11-01T00:00:00.000Z" }),
      JSON.stringify({ v: 1, type: "cost" }),
    ].join("\n");
    await writeFile(file, `${(await readFile(file, "utf8"))}${extra}\n`, "utf8");
    const projection = loadCostProjection(root);
    expect(projection.badLines).toBe(4);
    expect(projection.totalLines).toBe(5);
    expect(projection.rows).toHaveLength(1);
    expect(reportCost(root).badLines).toBe(4);
  });

  it("条目字段非法不算坏行(交给纯逻辑计 invalid)", async () => {
    const root = await tmpRoot();
    recordCost(root, costEntry({ stage: "unknown" }) as never);
    const projection = loadCostProjection(root);
    expect(projection.badLines).toBe(0);
    expect(cycleReport(root, "cycle-1").invalid).toBe(1);
  });
});

describe("周期报告", () => {
  it("只汇总该周期,roi = 省 / 花", async () => {
    const root = await tmpRoot();
    recordCost(root, costEntry({ tokens: { input: 100, output: 100, total: 200 } }) as never);
    recordSavings(root, savingEntry({ tokensSaved: 100 }) as never);
    recordCost(root, costEntry({ id: "c2", cycleId: "cycle-2", tokens: { input: 9, output: 9, total: 18 } }) as never);
    const report = cycleReport(root, "cycle-1");
    expect(report.costTokens).toBe(200);
    expect(report.savingTokens).toBe(100);
    expect(report.netTokens).toBe(-100);
    expect(report.roi).toBeCloseTo(0.5, 10);
    expect(report.badLines).toBe(0);
    expect(report.entries).toEqual({ costs: 1, savings: 1 });
  });

  it("没有成本的周期 roi=null 且带 ZERO_COST", async () => {
    const root = await tmpRoot();
    recordSavings(root, savingEntry({ cycleId: "cycle-z", tokensSaved: 55 }) as never);
    const report = cycleReport(root, "cycle-z");
    expect(report.roi).toBeNull();
    expect(report.netTokens).toBe(55);
    expect(report.codes).toContain("RSI_ROI_ZERO_COST");
  });
});

describe("evaluateRoiGate(台账版)", () => {
  it("预览(缺省 apply)不落盘:行数不变", async () => {
    const root = await tmpRoot();
    for (const id of ["c1", "c2", "c3"]) negativeCycle(root, id);
    const before = (await ledgerLines(root)).length;
    const result = await evaluateRoiGate(root);
    expect(result.action).toBe("downshift");
    expect(result.negativeStreak).toBe(3);
    expect(result.cycleIds).toEqual(["c1", "c2", "c3"]);
    expect(result.applied).toBe(false);
    expect(result.wroteLines).toBe(0);
    expect((await ledgerLines(root)).length).toBe(before);
  });

  it("apply downshift → 落 roi-eval + downshift 两行,downshift 带 quota", async () => {
    const root = await tmpRoot();
    for (const id of ["c1", "c2", "c3"]) negativeCycle(root, id);
    const before = (await ledgerLines(root)).length;
    const result = await evaluateRoiGate(root, { apply: true });
    expect(result.action).toBe("downshift");
    expect(result.applied).toBe(true);
    expect(result.wroteLines).toBe(2);
    const lines = await ledgerLines(root);
    expect(lines.length).toBe(before + 2);
    const evalRow = JSON.parse(lines[before]);
    const downshiftRow = JSON.parse(lines[before + 1]);
    expect(evalRow.type).toBe("roi-eval");
    expect(downshiftRow.type).toBe("downshift");
    expect(downshiftRow.action).toBe("downshift");
    expect(downshiftRow.negativeStreak).toBe(3);
    expect(downshiftRow.quota).toEqual({ nightlyWindowFactor: 0.5, experimentQuotaFactor: 0.5 });
    expect(downshiftRow.policy).toEqual({});
    expect(downshiftRow.at).toBe(evalRow.at);
  });

  it("action=ok 即使 apply 也不落盘", async () => {
    const root = await tmpRoot();
    recordCost(root, costEntry() as never);
    recordSavings(root, savingEntry({ tokensSaved: 500 }) as never);
    const before = (await ledgerLines(root)).length;
    const result = await evaluateRoiGate(root, { apply: true });
    expect(result.action).toBe("ok");
    expect(result.applied).toBe(false);
    expect((await ledgerLines(root)).length).toBe(before);
  });

  it("apply pause 且传 breakerRoot → 真实熔断台账 paused=true(auto-negative-streak)", async () => {
    const root = await tmpRoot();
    const breakerRoot = await tmpRoot();
    for (const id of ["c1", "c2", "c3", "c4", "c5", "c6"]) negativeCycle(root, id);
    const result = await evaluateRoiGate(root, { apply: true, breakerRoot });
    expect(result.action).toBe("pause");
    expect(result.codes).toEqual(["RSI_ROI_NEGATIVE_STREAK", "RSI_ROI_PAUSE"]);
    expect(result.negativeStreak).toBe(6);
    expect(result.breaker?.ok).toBe(true);
    const state = await getState(breakerRoot);
    expect(state.paused).toBe(true);
    expect(state.trigger).toBe("auto-negative-streak");
    expect(state.scope).toBe("all");
    expect(state.by).toBe("rsi-cost");
    expect(state.reason).toContain("roi-gate:");
  });

  it("apply pause 不传 breakerRoot → 不碰熔断(breaker 缺省)", async () => {
    const root = await tmpRoot();
    for (const id of ["c1", "c2", "c3", "c4", "c5", "c6"]) negativeCycle(root, id);
    const result = await evaluateRoiGate(root, { apply: true });
    expect(result.action).toBe("pause");
    expect(result.breaker).toBeUndefined();
  });

  it("cycleIds 显式传入覆盖台账顺序", async () => {
    const root = await tmpRoot();
    negativeCycle(root, "c1");
    recordCost(root, costEntry({ id: "c2-c", cycleId: "c2", tokens: { input: 10, output: 0, total: 10 } }) as never);
    recordSavings(root, savingEntry({ id: "c2-s", cycleId: "c2", tokensSaved: 999 }) as never);
    const result = await evaluateRoiGate(root, { cycleIds: ["c2"] });
    expect(result.cycleIds).toEqual(["c2"]);
    expect(result.action).toBe("ok");
    expect(result.reports).toHaveLength(1);
  });

  it("minCycleSamples 让样本不足的周期评估时跳过(仍进报告)", async () => {
    const root = await tmpRoot();
    for (const id of ["c1", "c2", "c3"]) negativeCycle(root, id);
    const result = await evaluateRoiGate(root, { policy: { minCycleSamples: 3 } });
    expect(result.reports).toHaveLength(3);
    expect(result.negativeStreak).toBe(0);
    expect(result.action).toBe("ok");
  });
});

describe("reportCost", () => {
  it("周期列表 / 累计 / 两维度分摊 / 最近降频状态", async () => {
    const root = await tmpRoot();
    for (const id of ["c1", "c2", "c3"]) negativeCycle(root, id);
    await evaluateRoiGate(root, { apply: true });
    const report = reportCost(root);
    expect(report.ok).toBe(true);
    expect(report.cycles).toEqual(["c1", "c2", "c3"]);
    expect(report.totals.costTokens).toBe(360);
    expect(report.totals.savingTokens).toBe(30);
    expect(report.totals.netTokens).toBe(-330);
    expect(report.totals.roi).toBeCloseTo(30 / 360, 10);
    expect(report.totals.costByStage["mining"]).toBe(360);
    expect(report.byMechanism[0]).toMatchObject({ key: "m1", costTokens: 360, savingTokens: 30, netTokens: -330 });
    expect(report.byProject[0]).toMatchObject({ key: "p1", costTokens: 360, savingTokens: 30 });
    expect(report.lastGate?.action).toBe("downshift");
    expect(report.lastGate?.negativeStreak).toBe(3);
    expect(report.lastGate?.quota).toEqual({ nightlyWindowFactor: 0.5, experimentQuotaFactor: 0.5 });
    expect(report.lastGate?.at).toBeTruthy();
    expect(report.badLines).toBe(0);
    expect(report.reports).toHaveLength(3);
  });

  it("空仓:ok / 空周期 / 零合计 / 无 lastGate", async () => {
    const root = await tmpRoot();
    const report = reportCost(root);
    expect(report).toMatchObject({ ok: true, codes: [], cycles: [], byMechanism: [], byProject: [], badLines: 0, totalLines: 0 });
    expect(report.totals.roi).toBeNull();
    expect(report.lastGate).toBeUndefined();
  });

  it("取最后一条 downshift 行作为现状", async () => {
    const root = await tmpRoot();
    for (const id of ["c1", "c2", "c3"]) negativeCycle(root, id);
    await evaluateRoiGate(root, { apply: true });
    for (const id of ["c4", "c5", "c6"]) negativeCycle(root, id);
    await evaluateRoiGate(root, { apply: true, policy: { downshiftAfter: 3, pauseAfter: 6 } });
    const report = reportCost(root);
    expect(report.lastGate?.action).toBe("pause");
    expect(report.lastGate?.negativeStreak).toBe(6);
    expect(report.codes).toEqual([]);
  });
});

describe("失败与参数错误", () => {
  it("store 层码表含写盘失败码", () => {
    expect([...RSI_COST_STORE_CODES]).toEqual(["RSI_COST_WRITE_MISMATCH", "RSI_COST_STORE_ERROR"]);
  });

  it("写盘失败(目标路径是目录)→ ok:false + RSI_COST_WRITE_MISMATCH", async () => {
    const root = await tmpRoot();
    const { file } = costPaths(root);
    await mkdir(file, { recursive: true });
    const result = recordCost(root, costEntry() as never);
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["RSI_COST_WRITE_MISMATCH"]);
  });

  it("参数错误抛 TypeError(root 空 / entry 非对象 / cycleId 空 / policy 非对象)", async () => {
    const root = await tmpRoot();
    expect(() => costPaths("")).toThrow(TypeError);
    expect(() => recordCost("   ", costEntry() as never)).toThrow(TypeError);
    expect(() => recordCost(root, null as never)).toThrow(TypeError);
    expect(() => recordSavings(root, [] as never)).toThrow(TypeError);
    expect(() => cycleReport(root, "")).toThrow(TypeError);
    await expect(evaluateRoiGate(root, { policy: [] as never })).rejects.toThrow(TypeError);
    await expect(evaluateRoiGate("", {})).rejects.toThrow(TypeError);
  });
});
