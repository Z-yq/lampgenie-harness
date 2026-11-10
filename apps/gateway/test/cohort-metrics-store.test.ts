/**
 * 一次通过率/缺陷逃逸度量的持久层(RSI #212):台账落盘、关联投影、报表/复审/审计面、坏行容忍。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DeliveryRecord, FixRecord } from "@lampgenie/runtime/agent/cohort-metrics";
import {
  cohortMetricsPath,
  compute,
  exportAuditRows,
  recordDelivery,
  recordFix,
  reportCohorts,
  review,
} from "../src/cohort-metrics-store";

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const MODULE = "cohort-module";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cohort-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function delivery(id: string, at: number, over: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return { id, taskId: `task-${id}`, module: MODULE, taskClass: "feature", boardType: "single", at, ...over };
}

function fixRecord(id: string, at: number, over: Partial<FixRecord> = {}): FixRecord {
  return { id, taskId: `task-${id}`, module: MODULE, at, foundAt: "ci", ...over };
}

/** 台账文件里的非空行数(与 store 的 countLines 同口径)。 */
function ledgerLines(): number {
  const path = cohortMetricsPath(root);
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .length;
}

/** 直接落盘多行原始文本(模拟被手改/被旧版本写坏的台账)。 */
function writeRawLedger(lines: string[]): void {
  const path = cohortMetricsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

/** 把几条交付按 at 递增顺序登记。 */
function recordDeliveries(records: DeliveryRecord[]): void {
  for (const record of records) expect(recordDelivery(root, record).ok).toBe(true);
}

describe("cohort-metrics-store 台账与投影", () => {
  it("空目录 compute:文件不存在不抛,cohorts 空、COHORT_OK、parseErrors 0", () => {
    expect(existsSync(cohortMetricsPath(root))).toBe(false);
    const result = compute(root);
    expect(result.ok).toBe(true);
    expect(result.cohorts).toEqual([]);
    expect(result.linked).toEqual([]);
    expect(result.unlinked).toEqual([]);
    expect(result.codes).toContain("COHORT_OK");
    expect(result.parseErrors).toBe(0);
    expect(result.totalLines).toBe(0);
  });

  it("显式关联 + 4 交付 1 逃逸:linked 1、firstPassRate 0.75、escapeRate 0.25", () => {
    recordDeliveries([
      delivery("d-1", T0),
      delivery("d-2", T0 + DAY),
      delivery("d-3", T0 + 2 * DAY),
      delivery("d-4", T0 + 3 * DAY),
    ]);
    const written = recordFix(
      root,
      fixRecord("f-1", T0 + 3 * DAY + 3_600_000, {
        relatedDeliveryId: "d-2",
        defectClass: "verification-coverage",
        changeNodes: 2,
      }),
    );
    expect(written).toEqual({ ok: true, id: "f-1" });

    const result = compute(root);
    expect(result.ok).toBe(true);
    expect(result.linked.length).toBe(1);
    expect(result.linked[0]?.delivery.id).toBe("d-2");
    expect(result.unlinked).toEqual([]);
    expect(result.codes).toContain("COHORT_ESCAPE_LINKED");
    expect(result.cohorts.length).toBe(1);
    const cohort = result.cohorts[0]!;
    expect(cohort.deliveries).toBe(4);
    expect(cohort.escapes).toBe(1);
    expect(cohort.firstPassRate).toBe(0.75);
    expect(cohort.escapeRate).toBe(0.25);
    expect(cohort.key.module).toBe(MODULE);
  });

  it("窗口外修复:unlinked 1、codes 含 COHORT_UNLINKED_FIX", () => {
    recordDeliveries([delivery("d-1", T0)]);
    expect(recordFix(root, fixRecord("f-late", T0 + 20 * DAY)).ok).toBe(true);

    const result = compute(root);
    expect(result.unlinked.length).toBe(1);
    expect(result.unlinked[0]?.id).toBe("f-late");
    expect(result.linked).toEqual([]);
    expect(result.codes).toContain("COHORT_UNLINKED_FIX");
    expect(result.cohorts[0]?.escapes).toBe(0);
    expect(result.cohorts[0]?.firstPassRate).toBe(1);
  });

  it("重复 id 交付:COHORT_DUPLICATE,台账行数不变", () => {
    expect(recordDelivery(root, delivery("d-dup", T0))).toEqual({ ok: true, id: "d-dup" });
    const before = ledgerLines();
    expect(before).toBe(1);

    const second = recordDelivery(root, delivery("d-dup", T0 + DAY));
    expect(second.ok).toBe(false);
    expect(second.code).toBe("COHORT_DUPLICATE");
    expect(second.id).toBe("d-dup");
    expect(ledgerLines()).toBe(before);
    expect(compute(root).cohorts[0]?.deliveries).toBe(1);
  });

  it("非法输入(缺 module / 缺 at)折叠成 COHORT_INVALID_INPUT,不 throw", () => {
    const missingModule = { id: "d-nomod", taskId: "task-1", at: T0 } as unknown as DeliveryRecord;
    let deliveryResult: ReturnType<typeof recordDelivery> | undefined;
    expect(() => {
      deliveryResult = recordDelivery(root, missingModule);
    }).not.toThrow();
    expect(deliveryResult).toEqual({ ok: false, code: "COHORT_INVALID_INPUT" });

    const missingAt = { id: "f-nat", taskId: "task-1", module: MODULE } as unknown as FixRecord;
    let fixResult: ReturnType<typeof recordFix> | undefined;
    expect(() => {
      fixResult = recordFix(root, missingAt);
    }).not.toThrow();
    expect(fixResult).toEqual({ ok: false, code: "COHORT_INVALID_INPUT" });

    expect(ledgerLines()).toBe(0);
  });

  it("手写坏行(JSON 坏 + v:2 + type 未知)只计 parseErrors,好行仍被读到", () => {
    writeRawLedger([
      "{not json",
      JSON.stringify({ v: 2, type: "delivery", at: T0, delivery: delivery("bad-v", T0) }),
      JSON.stringify({ v: 1, type: "unknown-kind", at: T0 }),
      JSON.stringify({ v: 1, type: "delivery", at: T0 + DAY, delivery: delivery("good-1", T0 + DAY) }),
    ]);

    const result = compute(root);
    expect(result.ok).toBe(true);
    expect(result.parseErrors).toBe(3);
    expect(result.totalLines).toBe(4);
    expect(result.cohorts.length).toBe(1);
    expect(result.cohorts[0]?.deliveries).toBe(1);
    expect(result.cohorts[0]?.firstPassRate).toBe(1);
  });
});

describe("cohort-metrics-store 报表与复审", () => {
  it("reportCohorts:byModule 指标、byDefectClass 计数、sampleLow 列出小样本桶", () => {
    recordDeliveries([
      delivery("d-1", T0, { module: "mod-a" }),
      delivery("d-2", T0 + DAY, { module: "mod-a" }),
      delivery("d-3", T0 + 2 * DAY, { module: "mod-a" }),
    ]);
    expect(
      recordFix(root, fixRecord("f-1", T0 + 2 * DAY + 60_000, { module: "mod-a", relatedDeliveryId: "d-1", defectClass: "plan-coverage" })).ok).toBe(true);

    const report = reportCohorts(root);
    expect(report.ok).toBe(true);
    expect(report.cohorts).toBe(1);
    expect(report.byModule["mod-a"]).toEqual({
      deliveries: 3,
      escapes: 1,
      firstPassRate: 0.67,
      escapeRate: 0.33,
      fanoutReworkRate: null,
    });
    expect(report.totals.deliveries).toBe(3);
    expect(report.totals.escapes).toBe(1);
    expect(report.byTaskClass["feature"]?.deliveries).toBe(3);
    expect(report.byBoardType["single"]?.deliveries).toBe(3);
    expect(report.byDefectClass).toEqual({ "plan-coverage": 1 });
    expect(report.sampleLow.length).toBe(1);
    expect(report.sampleLow[0]).toEqual({
      module: "mod-a",
      taskClass: "feature",
      boardType: "single",
      deliveries: 3,
    });
    expect(report.parseErrors).toBe(0);
    expect(report.totalLines).toBe(4);
  });

  it("review 未给签名:签名桶对比本 module 未签名基线,0.5 vs 1.0 → declined 且 reason 含「下降」", () => {
    recordDeliveries([
      delivery("u-1", T0),
      delivery("u-2", T0 + DAY),
      delivery("u-3", T0 + 2 * DAY),
      delivery("s-1", T0 + 3 * DAY, { signature: "prevent-x" }),
      delivery("s-2", T0 + 4 * DAY, { signature: "prevent-x" }),
    ]);
    expect(
      recordFix(root, fixRecord("f-1", T0 + 4 * DAY + 60_000, { relatedDeliveryId: "s-2" })).ok).toBe(true);

    const result = review(root);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("module-baseline");
    expect(result.items.length).toBe(1);
    const item = result.items[0]!;
    expect(item.signature).toBe("prevent-x");
    expect(item.beforeDeliveries).toBe(3);
    expect(item.afterDeliveries).toBe(2);
    expect(item.beforeFirstPassRate).toBe(1);
    expect(item.afterFirstPassRate).toBe(0.5);
    expect(item.deltaPct).toBe(-50);
    expect(["declined", "flat"]).toContain(item.verdict);
    expect(["持平", "下降"].some((word) => item.reason.includes(word))).toBe(true);
    expect(result.comparisons.length).toBe(1);
    expect(result.comparisons[0]?.comparison.verdict).toBe(item.verdict);
    expect(result.codes).toContain("COHORT_REVIEW_REQUIRED");
  });

  it("review 给前后签名(同一签名两窗):mode=signature-window,items 1 条、flat", () => {
    recordDeliveries([
      delivery("s-1", T0, { signature: "shared-sig" }),
      delivery("s-2", T0 + 3_600_000, { signature: "shared-sig" }),
      delivery("s-3", T0 + DAY, { signature: "shared-sig" }),
      delivery("s-4", T0 + DAY + 3_600_000, { signature: "shared-sig" }),
    ]);
    expect(recordFix(root, fixRecord("f-1", T0 + DAY + 7_200_000, { relatedDeliveryId: "s-1" })).ok).toBe(
      true);

    const result = review(root, { beforeSignatures: ["shared-sig"], afterSignatures: ["shared-sig"] });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("signature-window");
    expect(result.comparisons.length).toBe(1);
    expect(result.comparisons[0]?.before.deliveries).toBe(4);
    expect(result.comparisons[0]?.after.deliveries).toBe(4);
    expect(result.items.length).toBe(1);
    const item = result.items[0]!;
    expect(item.signature).toBe("shared-sig");
    expect(item.beforeFirstPassRate).toBe(0.75);
    expect(item.afterFirstPassRate).toBe(0.75);
    expect(item.deltaPct).toBe(0);
    expect(item.verdict).toBe("flat");
    expect(item.reason).toContain("持平");
    expect(result.codes).toContain("COHORT_REVIEW_REQUIRED");
  });

  it("review 前后签名不同(旧机制 vs 新机制):按 module/taskClass/boardType 配对,after 窗更差 → declined", () => {
    recordDeliveries([
      delivery("b-1", T0, { signature: "win-before" }),
      delivery("b-2", T0 + 3_600_000, { signature: "win-before" }),
      delivery("a-1", T0 + DAY, { signature: "win-after" }),
      delivery("a-2", T0 + DAY + 3_600_000, { signature: "win-after" }),
    ]);
    expect(recordFix(root, fixRecord("f-1", T0 + DAY + 7_200_000, { relatedDeliveryId: "a-1" })).ok).toBe(
      true);

    const result = review(root, { beforeSignatures: ["win-before"], afterSignatures: ["win-after"] });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("signature-window");
    expect(result.comparisons.length).toBe(1);
    expect(result.comparisons[0]?.before.deliveries).toBe(2);
    expect(result.comparisons[0]?.after.deliveries).toBe(2);
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.signature).toBe("win-after");
    expect(result.items[0]?.beforeFirstPassRate).toBe(1);
    expect(result.items[0]?.afterFirstPassRate).toBe(0.5);
    expect(result.items[0]?.verdict).toBe("declined");
    expect(result.codes).toContain("COHORT_REVIEW_REQUIRED");
    expect(result.parseErrors).toBe(0);
    expect(result.totalLines).toBe(5);
  });

  it("exportAuditRows:行数与 compute 桶数一致,每行带 firstPassRate/escapeRate/sampleSufficient", () => {
    recordDeliveries([
      delivery("a-1", T0, { module: "mod-a" }),
      delivery("a-2", T0 + DAY, { module: "mod-a" }),
      delivery("b-1", T0 + 2 * DAY, { module: "mod-b" }),
      delivery("b-2", T0 + 3 * DAY, { module: "mod-b" }),
    ]);
    const cohorts = compute(root).cohorts;
    const result = exportAuditRows(root);
    expect(result.ok).toBe(true);
    expect(result.rows.length).toBe(cohorts.length);
    expect(result.rows.length).toBe(2);
    expect(result.rows.map((row) => row.module)).toEqual(["mod-a", "mod-b"]);
    for (const row of result.rows) {
      expect(typeof row.firstPassRate).toBe("number");
      expect(typeof row.escapeRate).toBe("number");
      expect(typeof row.sampleSufficient).toBe("boolean");
      expect(row.sampleSufficient).toBe(false);
      expect(row.deliveries).toBe(2);
    }
    expect(result.parseErrors).toBe(0);
    expect(result.totalLines).toBe(4);
  });
});

describe("cohort-metrics-store 台账路径与幂等", () => {
  it("台账路径固定为 <root>/.genie/rsi/cohort.jsonl", () => {
    const path = cohortMetricsPath(root);
    expect(path.startsWith(root)).toBe(true);
    expect(path.split("\\").join("/")).toBe(`${root.split("\\").join("/")}/.genie/rsi/cohort.jsonl`);
    expect(path.split("\\").join("/").endsWith("/.genie/rsi/cohort.jsonl")).toBe(true);
  });

  it("同一交付记录两次:第二次被拒且不重复落盘", () => {
    const record = delivery("d-once", T0);
    expect(recordDelivery(root, record)).toEqual({ ok: true, id: "d-once" });
    expect(recordDelivery(root, record)).toEqual({ ok: false, code: "COHORT_DUPLICATE", id: "d-once" });
    expect(ledgerLines()).toBe(1);
    const projection = compute(root);
    expect(projection.totalLines).toBe(1);
    expect(projection.parseErrors).toBe(0);
    expect(projection.cohorts[0]?.deliveries).toBe(1);
  });

  it("交付与修复共用 id 空间:同 id 先记 fix 再记 delivery 被拒", () => {
    expect(recordFix(root, fixRecord("shared-1", T0))).toEqual({ ok: true, id: "shared-1" });
    const conflict = recordDelivery(root, delivery("shared-1", T0 + DAY));
    expect(conflict.ok).toBe(false);
    expect(conflict.code).toBe("COHORT_DUPLICATE");
    expect(ledgerLines()).toBe(1);
  });

  it("root 非法才 throw", () => {
    expect(() => compute("")).toThrow();
    expect(() => recordDelivery("   ", delivery("d-1", T0))).toThrow();
    expect(() => reportCohorts(undefined as unknown as string)).toThrow();
  });
});
