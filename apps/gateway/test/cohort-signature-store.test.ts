/**
 * 情境签名样本的持久层:台账落盘、同 id 拒收、过滤/分桶、两臂对比四态、反事实配对、
 * 版本登记与基线重估、混杂/幸存者体检、报表结构、坏行容忍。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SituationSignature } from "@lampgenie/runtime/agent/cohort-signature";
import {
  addSample,
  buckets,
  compare,
  confounders,
  counterfactuals,
  listSamples,
  loadSignatures,
  markStale,
  reportSignatures,
  signaturesPath,
  survivorBias,
  versionChange,
} from "../src/cohort-signature-store";

const T0 = 1_700_000_000_000;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cohort-signature-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sig(over: Partial<SituationSignature> = {}): SituationSignature {
  return {
    taskClass: "impl",
    phase: "execute",
    toolSurface: "fs",
    contextPressure: "medium",
    modelVersion: "m1",
    providerVersion: "p1",
    ...over,
  };
}

function raw(
  id: string,
  options: {
    decision?: string;
    status?: string;
    value?: number;
    metric?: string;
    signature?: Partial<SituationSignature>;
    projectId?: string;
    durationMs?: number;
    at?: number;
  } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id,
    signature: sig(options.signature ?? {}),
    status: options.status ?? "done",
    outcome: { metric: options.metric ?? "turns", value: options.value ?? 10 },
    at: options.at ?? T0,
  };
  if (options.decision !== undefined) payload["decision"] = options.decision;
  if (options.projectId !== undefined) payload["projectId"] = options.projectId;
  if (options.durationMs !== undefined) payload["durationMs"] = options.durationMs;
  return payload;
}

function lineCount(): number {
  return readFileSync(signaturesPath(root), "utf8").trim().split("\n").filter((line) => line !== "").length;
}

/** 一条 6 样本的「两组三臂」台账:A 组 3(含 1 failed)、B 组 3(含 1 interrupted)。 */
function seedComparablePair(): void {
  expect(addSample(root, raw("a1", { decision: "A", value: 10 })).ok).toBe(true);
  expect(addSample(root, raw("a2", { decision: "A", value: 12 })).ok).toBe(true);
  expect(addSample(root, raw("a3", { decision: "A", value: 30, status: "failed" })).ok).toBe(true);
  expect(addSample(root, raw("b1", { decision: "B", value: 8 })).ok).toBe(true);
  expect(addSample(root, raw("b2", { decision: "B", value: 9 })).ok).toBe(true);
  expect(addSample(root, raw("b3", { decision: "B", value: 4, status: "interrupted" })).ok).toBe(true);
}

describe("addSample", () => {
  it("合法样本落一行,坏载荷只回 SIGNATURE_INVALID_INPUT 不写盘", () => {
    const result = addSample(root, raw("s1"));
    expect(result.ok).toBe(true);
    expect(result.id).toBe("s1");
    expect(result.codes).toEqual([]);
    expect(lineCount()).toBe(1);

    const bad = addSample(root, { id: "s2", signature: sig(), status: "unknown", outcome: { metric: "x", value: 1 }, at: T0 });
    expect(bad.ok).toBe(false);
    expect(bad.codes).toContain("SIGNATURE_INVALID_INPUT");
    expect(lineCount()).toBe(1);
    const parsed = JSON.parse(readFileSync(signaturesPath(root), "utf8").trim()) as Record<string, unknown>;
    expect(parsed["v"]).toBe(1);
    expect(parsed["type"]).toBe("sample");
  });

  it("同 id 重复拒收(append-only,不覆盖)", () => {
    expect(addSample(root, raw("s1", { value: 10 })).ok).toBe(true);
    const dup = addSample(root, raw("s1", { value: 99 }));
    expect(dup.ok).toBe(false);
    expect(dup.id).toBe("s1");
    expect(dup.codes).toContain("SIGNATURE_DUPLICATE");
    expect(lineCount()).toBe(1);
    const samples = listSamples(root).samples;
    expect(samples).toHaveLength(1);
    expect(samples[0]?.outcome.value).toBe(10);
  });
});

describe("listSamples", () => {
  it("按 signatureKey 过滤,只回同签名样本", () => {
    expect(addSample(root, raw("m1a")).ok).toBe(true);
    expect(addSample(root, raw("m1b")).ok).toBe(true);
    expect(addSample(root, raw("m2a", { signature: { modelVersion: "m2" } })).ok).toBe(true);
    const key = "tc=impl|ph=execute|ts=fs|cp=medium|mv=m1|pv=p1";
    const filtered = listSamples(root, { signatureKey: key });
    expect(filtered.ok).toBe(true);
    expect(filtered.samples.map((sample) => sample.id)).toEqual(["m1a", "m1b"]);
    expect(filtered.totalLines).toBe(3);
    expect(filtered.parseErrors).toBe(0);
    const failedOnly = listSamples(root, { status: "failed" });
    expect(failedOnly.samples).toHaveLength(0);
  });
});

describe("buckets", () => {
  it("计数含 failed/interrupted,totals 汇总全部样本", () => {
    seedComparablePair();
    const result = buckets(root);
    expect(result.ok).toBe(true);
    const key = "tc=impl|ph=execute|ts=fs|cp=medium|mv=m1|pv=p1";
    const bucket = result.buckets[key];
    expect(bucket).toBeDefined();
    expect(bucket!.counts).toEqual({ done: 4, failed: 1, interrupted: 1, cancelled: 0 });
    expect(result.totals).toEqual({ samples: 6, done: 4, failed: 1, interrupted: 1, cancelled: 0 });
    expect(result.parseErrors).toBe(0);
    expect(result.totalLines).toBe(6);
  });
});

describe("compare", () => {
  it("同桶两臂 comparable 且记 CONF_INCLUDES_FAILURES", () => {
    seedComparablePair();
    const result = compare(root, { aId: "a1", bId: "b1" });
    expect(result.verdict).toBe("comparable");
    expect(result.ok).toBe(true);
    expect(result.codes).toContain("CONF_MATCHED");
    expect(result.codes).toContain("CONF_INCLUDES_FAILURES");
    expect(result.includesFailures).toEqual({ a: 1, b: 1 });
    expect(result.armSizes).toEqual({ a: 3, b: 3 });
    expect(result.deltas).toHaveLength(1);
  });

  it("异签名 not-matched", () => {
    expect(addSample(root, raw("x1", { decision: "A" })).ok).toBe(true);
    expect(addSample(root, raw("y1", { decision: "A", signature: { modelVersion: "m2" } })).ok).toBe(true);
    const result = compare(root, { aId: "x1", bId: "y1" });
    expect(result.verdict).toBe("not-matched");
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("CONF_NOT_MATCHED");
    expect(result.signatureKeyA).not.toBe(result.signatureKeyB);
  });

  it("某臂只有 2 条 → insufficient", () => {
    expect(addSample(root, raw("c1", { decision: "C" })).ok).toBe(true);
    expect(addSample(root, raw("c2", { decision: "C" })).ok).toBe(true);
    expect(addSample(root, raw("d1", { decision: "D" })).ok).toBe(true);
    expect(addSample(root, raw("d2", { decision: "D" })).ok).toBe(true);
    expect(addSample(root, raw("d3", { decision: "D" })).ok).toBe(true);
    const result = compare(root, { aId: "c1", bId: "d1" });
    expect(result.verdict).toBe("insufficient");
    expect(result.codes).toContain("CONF_INSUFFICIENT_SAMPLES");
    expect(result.armSizes).toEqual({ a: 2, b: 3 });
  });

  it("id 不存在 → missing-sample", () => {
    expect(addSample(root, raw("only")).ok).toBe(true);
    const result = compare(root, { aId: "nope", bId: "only" });
    expect(result.verdict).toBe("missing-sample");
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SIGNATURE_MISSING_SAMPLE");
    expect(result.armSizes).toEqual({ a: 0, b: 0 });
  });
});

describe("counterfactuals", () => {
  it("同桶同指标两组各 3 条 → 出一条 pair", () => {
    seedComparablePair();
    const result = counterfactuals(root);
    expect(result.ok).toBe(true);
    expect(result.result.pairs).toHaveLength(1);
    expect(result.result.candidates).toHaveLength(0);
    const pair = result.result.pairs[0]!;
    expect(pair.decisionA).toBe("A");
    expect(pair.decisionB).toBe("B");
    expect(pair.sampleA).toBe(3);
    expect(pair.sampleB).toBe(3);
    expect(pair.codes).toContain("CONF_INCLUDES_FAILURES");
  });

  it("每组样本不足 → candidates + CONF_INSUFFICIENT_SAMPLES", () => {
    expect(addSample(root, raw("e1", { decision: "A" })).ok).toBe(true);
    expect(addSample(root, raw("f1", { decision: "B" })).ok).toBe(true);
    const result = counterfactuals(root);
    expect(result.result.pairs).toHaveLength(0);
    expect(result.result.candidates).toHaveLength(1);
    expect(result.result.codes).toContain("CONF_INSUFFICIENT_SAMPLES");
  });
});

describe("versionChange", () => {
  it("版本变了 → CONF_BASELINE_RESTIMATED 且追加 version/baseline 两行", () => {
    expect(addSample(root, raw("v1")).ok).toBe(true);
    const result = versionChange(root, {
      modelVersion: "m2",
      providerVersion: "p2",
      experiments: [{ id: "exp-old", signature: sig() }],
    });
    expect(result.ok).toBe(true);
    expect(result.result.changed).toBe(true);
    expect(result.result.codes).toContain("CONF_BASELINE_RESTIMATED");
    expect(result.result.codes).toContain("CONF_VERSION_STALE");
    expect(result.result.staleExperimentIds).toEqual(["exp-old"]);
    expect(result.prev).toEqual({ modelVersion: "m1", providerVersion: "p1" });
    expect(result.appended).toEqual({ version: true, baseline: true });
    expect(lineCount()).toBe(3);
    const projection = loadSignatures(root);
    expect(projection.versions).toHaveLength(1);
    expect(projection.baselines).toHaveLength(1);
    expect(projection.baselines[0]?.reason).toBe("version-change");
  });

  it("版本不变 → 只追加 version 行,不追加 baseline", () => {
    expect(addSample(root, raw("v1")).ok).toBe(true);
    const result = versionChange(root, { modelVersion: "m1", providerVersion: "p1" });
    expect(result.result.changed).toBe(false);
    expect(result.appended).toEqual({ version: true, baseline: false });
    expect(lineCount()).toBe(2);
    const projection = loadSignatures(root);
    expect(projection.baselines).toHaveLength(0);
    expect(projection.versions).toHaveLength(1);
  });

  it("无 version 行时基线取样本里的多数版本,不取最后一条样本", () => {
    expect(addSample(root, raw("v1", { at: T0 })).ok).toBe(true);
    expect(addSample(root, raw("v2", { at: T0 + 1 })).ok).toBe(true);
    // 版本升级后新样本排在末尾:最后一条是 m2/p2,但基线仍是样本多数的 m1/p1。
    expect(
      addSample(root, raw("v3", { signature: { modelVersion: "m2", providerVersion: "p2" }, at: T0 + 2 })).ok,
    ).toBe(true);
    const result = versionChange(root, { modelVersion: "m3", providerVersion: "p3" });
    expect(result.prev).toEqual({ modelVersion: "m1", providerVersion: "p1" });
    expect(result.result.changed).toBe(true);
    expect(result.result.codes).toContain("CONF_BASELINE_RESTIMATED");
    expect(result.appended).toEqual({ version: true, baseline: true });
  });
});

describe("markStale", () => {
  it("版本不同的样本全标 stale", () => {
    expect(addSample(root, raw("old1")).ok).toBe(true);
    expect(addSample(root, raw("new1", { signature: { modelVersion: "m2", providerVersion: "p2" } })).ok).toBe(
      true,
    );
    const result = markStale(root, { modelVersion: "m2", providerVersion: "p2" });
    expect(result.ok).toBe(true);
    expect(result.stale).toEqual(["old1"]);
    expect(result.active).toEqual(["new1"]);
  });
});

describe("confounders / survivorBias", () => {
  it("四因子恒在,混杂时记 CONF_CONFOUNDERS_PRESENT", () => {
    expect(
      addSample(root, raw("p1", { projectId: "proj-a", durationMs: 100, signature: { taskClass: "impl" } })).ok,
    ).toBe(true);
    expect(
      addSample(root, raw("p2", { projectId: "proj-b", durationMs: 900, signature: { taskClass: "review" } })).ok,
    ).toBe(true);
    const result = confounders(root);
    expect(result.ok).toBe(true);
    expect(result.result.items.map((item) => item.factor)).toEqual([
      "version",
      "project",
      "taskClass",
      "duration",
    ]);
    const present = result.result.items.filter((item) => item.present).map((item) => item.factor);
    expect(present).toContain("project");
    expect(present).toContain("taskClass");
    expect(present).toContain("duration");
    expect(result.codes).toContain("CONF_CONFOUNDERS_PRESENT");
  });

  it("全 done → SURVIVOR_BIAS;含 failed → 不告警但记 CONF_INCLUDES_FAILURES", () => {
    expect(addSample(root, raw("ok1")).ok).toBe(true);
    expect(addSample(root, raw("ok2")).ok).toBe(true);
    const clean = survivorBias(root);
    expect(clean.result.biased).toBe(true);
    expect(clean.codes).toContain("CONF_SURVIVOR_BIAS");

    expect(addSample(root, raw("bad1", { status: "failed" })).ok).toBe(true);
    const mixed = survivorBias(root);
    expect(mixed.result.biased).toBe(false);
    expect(mixed.codes).toContain("CONF_INCLUDES_FAILURES");
  });
});

describe("reportSignatures", () => {
  it("结构完整:buckets/versions/confounders/survivorBias", () => {
    seedComparablePair();
    const report = reportSignatures(root);
    expect(report.ok).toBe(true);
    expect(report.version).toBe(1);
    expect(report.samples).toBe(6);
    expect(report.totalLines).toBe(6);
    expect(report.parseErrors).toBe(0);
    expect(report.buckets).toHaveLength(1);
    const bucket = report.buckets[0]!;
    expect(bucket.signatureKey).toBe("tc=impl|ph=execute|ts=fs|cp=medium|mv=m1|pv=p1");
    expect(bucket.counts.done).toBe(4);
    expect(bucket.decisions).toEqual(["A", "B"]);
    expect(typeof bucket.mean).toBe("number");
    expect(report.versions["m1"]).toEqual({ providerVersions: ["p1"], mean: bucket.mean, count: 6 });
    expect(report.confounders.items).toHaveLength(4);
    expect(report.survivorBias.biased).toBe(false);
    expect(report.codes).toContain("CONF_INCLUDES_FAILURES");
  });
});

describe("坏行容忍", () => {
  it("坏 JSON 与 v≠1 只计 parseErrors=2,不 throw", () => {
    expect(addSample(root, raw("good")).ok).toBe(true);
    writeFileSync(
      signaturesPath(root),
      [
        JSON.stringify({ v: 1, type: "sample", at: T0, sample: raw("good") }),
        '{"v":1,"type":"sample"',
        JSON.stringify({ v: 2, type: "sample", at: T0, sample: raw("other") }),
        "",
      ].join("\n"),
      "utf8",
    );
    const projection = loadSignatures(root);
    expect(projection.parseErrors).toBe(2);
    expect(projection.totalLines).toBe(3);
    expect(projection.samples.map((sample) => sample.id)).toEqual(["good"]);
    expect(projection.badLines).toEqual([2, 3]);
    expect(() => buckets(root)).not.toThrow();
    expect(buckets(root).parseErrors).toBe(2);
    expect(reportSignatures(root).parseErrors).toBe(2);
  });
});

describe("参数校验", () => {
  it("root 非法 → throw", () => {
    expect(() => signaturesPath("")).toThrow();
    expect(() => buckets("   ")).toThrow();
    expect(() => addSample(undefined as unknown as string, raw("s1"))).toThrow();
  });
});
