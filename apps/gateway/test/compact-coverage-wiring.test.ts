/**
 * 接线单测:auto-compact 三处插入(watermark → start / 提交前覆盖证明 → done 前 / 证明字段 → done)
 * 与 compact-coverage 纯逻辑的导出面,全部按源码逐字断言。
 * 为什么读源码而不是实例化:插入点是「顺序契约」(watermark 必须先于 compact.start、验证必须先于
 * compact.done),行为层由 packages/harness-runtime/test/compact-coverage.test.ts 的实跑覆盖,
 * 这里只守接线形状。
 * 跑法:cd apps/gateway && NODE_OPTIONS=--conditions=development npx vitest run test/compact-coverage-wiring.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const AUTO_COMPACT = readFileSync(fileURLToPath(new URL("../../../packages/harness-runtime/src/agent/auto-compact.ts", import.meta.url)), "utf-8");
const COVERAGE = readFileSync(fileURLToPath(new URL("../../../packages/harness-runtime/src/agent/compact-coverage.ts", import.meta.url)), "utf-8");

describe("插入 ①:compact.start 之前取 watermark", () => {
  it("从 ./compact-coverage 引入四个符号", () => {
    expect(AUTO_COMPACT).toMatch(/import \{[^}]*commitDecision[^}]*\} from "\.\/compact-coverage"/);
    expect(AUTO_COMPACT).toMatch(/import \{[^}]*computeWatermark[^}]*\} from "\.\/compact-coverage"/);
    expect(AUTO_COMPACT).toMatch(/import \{[^}]*verifyCoverage[^}]*\} from "\.\/compact-coverage"/);
    expect(AUTO_COMPACT).toMatch(/import \{[^}]*coverageProof[^}]*\} from "\.\/compact-coverage"/);
  });

  it("watermark 在 compact.start 之前取(journal.readAll + sessionId)", () => {
    const wmIdx = AUTO_COMPACT.indexOf("const watermark = computeWatermark(");
    const startIdx = AUTO_COMPACT.indexOf('kind: "compact.start"');
    expect(wmIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(wmIdx);
    expect(AUTO_COMPACT.slice(wmIdx, wmIdx + 200)).toMatch(/journal\.readAll\(\)/);
    expect(AUTO_COMPACT.slice(wmIdx, wmIdx + 200)).toMatch(/lastCompactSeq/);
  });

  it("lastCompactSeq 来自上一条 compact.done 的 coveredWatermark", () => {
    expect(AUTO_COMPACT).toMatch(/kind === "compact\.done"\)\.pop\(\)/);
    expect(AUTO_COMPACT).toMatch(/coveredWatermark/);
  });

  it("compact.start payload 带 watermarkSeq/digest 可选键", () => {
    const startIdx = AUTO_COMPACT.indexOf('kind: "compact.start"');
    const startBlock = AUTO_COMPACT.slice(startIdx, AUTO_COMPACT.indexOf('kind: "compact.start"') + 1600);
    expect(startBlock).toMatch(/watermarkSeq: watermark\.watermarkSeq/);
    expect(startBlock).toMatch(/digest: watermark\.digest/);
  });
});

describe("插入 ②:写 compact.done 之前做覆盖证明 + 双条件", () => {
  it("verifyCoverage 与 commitDecision 都在 compact.done 之前", () => {
    const verifyIdx = AUTO_COMPACT.indexOf("verifyCoverage(watermark");
    const decisionIdx = AUTO_COMPACT.indexOf("const decision = commitDecision(");
    const doneIdx = AUTO_COMPACT.indexOf('kind: "compact.done"');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(decisionIdx).toBeGreaterThan(verifyIdx);
    expect(doneIdx).toBeGreaterThan(decisionIdx);
  });

  it("代际用表面事实计数(start 快照 vs 提交前)", () => {
    expect(AUTO_COMPACT).toMatch(/generationAtStart: lock\.surfaceGeneration \?\? lock\.generation/);
    expect(AUTO_COMPACT).toMatch(/generationNow: now\.filter\(\(e\) => SURFACE_EVENT_KINDS\.has\(e\.kind\)\)\.length/);
    expect(AUTO_COMPACT).toMatch(/lock\.surfaceGeneration = eventsAtStart\.filter/);
  });

  it("不通过 → 写 compact.abandoned(reason 带 code,payload 含 appendedIds),不写 done", () => {
    const decisionIdx = AUTO_COMPACT.indexOf("const decision = commitDecision(");
    const doneIdx = AUTO_COMPACT.indexOf('kind: "compact.done"');
    const guard = AUTO_COMPACT.slice(decisionIdx, doneIdx);
    expect(guard).toMatch(/if \(!decision\.commit\)/);
    expect(guard).toMatch(/kind: "compact\.abandoned"/);
    expect(guard).toMatch(/reason: decision\.code/);
    expect(guard).toMatch(/appendedIds: coverage\.appendedIds/);
    expect(guard).toMatch(/missingIds: coverage\.missingIds/);
 // 失败分支必须在写 done 之前就 return(不能被后续 done 覆盖)
    expect(guard.indexOf("return { compacted: false, reason }")).toBeGreaterThan(0);
  });

  it("既有 surface-changed 计数门仍在覆盖门之前(口径互补,零回归)", () => {
    const surfaceIdx = AUTO_COMPACT.indexOf("surfaced.length > 0");
    const verifyIdx = AUTO_COMPACT.indexOf("verifyCoverage(watermark");
    expect(surfaceIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(surfaceIdx);
  });
});

describe("插入 ③:compact.done 的证明字段", () => {
  it("四项证明字段都在 done payload 里", () => {
    const doneIdx = AUTO_COMPACT.indexOf('kind: "compact.done"');
    const block = AUTO_COMPACT.slice(doneIdx, doneIdx + 2600);
    expect(block).toMatch(/coveredWatermark: proof\.coveredWatermark/);
    expect(block).toMatch(/coveredIds: proof\.coveredIds/);
    expect(block).toMatch(/coverageDigest: proof\.digest/);
    expect(block).toMatch(/coverageCode: proof\.code/);
  });

  it("既有边界字段 tailStartId/tailGroupCount 保留", () => {
    const doneIdx = AUTO_COMPACT.indexOf('kind: "compact.done"');
    const block = AUTO_COMPACT.slice(doneIdx, doneIdx + 2600);
    expect(block).toMatch(/tailStartId: aligned\.tailStartId/);
    expect(block).toMatch(/tailGroupCount: aligned\.groupCount/);
  });
});

describe("compact-coverage 纯逻辑面", () => {
  it("导出五个函数 + 五个码,且零 IO(只依赖 node:crypto)", () => {
    for (const fn of ["computeWatermark", "verifyCoverage", "commitDecision", "coverageProof", "mergeCoveredProofs"]) {
      expect(COVERAGE).toMatch(new RegExp(`export function ${fn}\\(`));
    }
    expect(COVERAGE).toMatch(/export const COMPACT_COVERAGE_CODES = \["OK", "COVERAGE_GAP", "CONCURRENT_APPEND", "STALE_GENERATION", "INVALID"\] as const/);
    const imports = [...COVERAGE.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(imports).toEqual(['import { createHash } from "node:crypto";']);
  });

  it("四类事实的口径写死在模块内(观测/过程事件不算)", () => {
    expect(COVERAGE).toMatch(/new Set<string>\(\["message\.user", "message\.agent", "message\.system", "tool\.result"\]\)/);
  });
});
