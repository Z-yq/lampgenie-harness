/**
 * 压缩覆盖证明:watermark / 并发追加 / 代际重验 / 证明字段 / 累计。
 * 探针:A) 10 事件 watermark 覆盖 ids/digest 稳定;B) 摘要期间新增 message.user → CONCURRENT_APPEND
 * 且不写 compact.done;C) generation 变 → STALE_GENERATION;D) 无新增 → OK/commit;
 * E) 结构损坏 → INVALID;F) compact.done 实跑含四项证明字段。
 * 跑法:cd packages/harness-runtime && NODE_OPTIONS=--conditions=development npx vitest run test/compact-coverage.test.ts
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import {
  COMPACT_COVERAGE_CODES,
  commitDecision,
  computeWatermark,
  coverageDigestOf,
  coverageEventId,
  coverageProof,
  mergeCoveredProofs,
  verifyCoverage,
} from "../src/agent/compact-coverage";
import { autoCompact } from "../src/agent/auto-compact";
import type { LlmProvider } from "../src/agent/loop";

type Ev = { seq: number; kind: string; sessionId: string; payload?: unknown };

function ev(seq: number, kind: string, sessionId = "s"): Ev {
  return { seq, kind, sessionId, payload: {} };
}

/** 独立实现一遍指纹口径,避免「用被测函数证明被测函数」。 */
function sha16(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

const EMPTY_DIGEST = sha16("");

describe("computeWatermark 取景", () => {
  it("只收四类可压缩事实,过滤 tool.call / step.start / llm.trace / compact.*", () => {
    const events = [
      ev(1, "message.user"),
      ev(2, "message.agent"),
      ev(3, "message.system"),
      ev(4, "tool.result"),
      ev(5, "tool.call"),
      ev(6, "step.start"),
      ev(7, "llm.trace"),
      ev(8, "compact.start"),
    ];
    const wm = computeWatermark(events, "s");
    expect(wm.coveredIds).toEqual(["e:1", "e:2", "e:3", "e:4"]);
    expect(wm.watermarkSeq).toBe(4);
    expect(wm.counts).toEqual({ messages: 2, toolResults: 1, system: 1 });
  });

  it("只收 sessionId 匹配的事件(跨会话事件带全局 seq,不能混进本会话 watermark)", () => {
    const wm = computeWatermark([ev(1, "message.user", "s"), ev(2, "message.user", "other"), ev(3, "tool.result", "other")], "s");
    expect(wm.coveredIds).toEqual(["e:1"]);
    expect(wm.sessionId).toBe("s");
  });

  it("seq ≤ lastCompactSeq 的段落已被上一轮覆盖,不进本轮 watermark", () => {
    const wm = computeWatermark([ev(1, "message.user"), ev(2, "message.user"), ev(5, "message.user")], "s", { lastCompactSeq: 2 });
    expect(wm.coveredIds).toEqual(["e:5"]);
    expect(wm.watermarkSeq).toBe(5);
  });

  it("ids 形态 e:<seq> 且按数值升序(e:9 排在 e:10 前)", () => {
    const wm = computeWatermark([ev(10, "message.user"), ev(2, "message.user"), ev(9, "message.user")], "s");
    expect(wm.coveredIds).toEqual(["e:2", "e:9", "e:10"]);
    expect(coverageEventId(7)).toBe("e:7");
  });

  it("digest = sha256(ids.join(',')) 前 16 位", () => {
    const wm = computeWatermark([ev(1, "message.user"), ev(2, "tool.result")], "s");
    expect(wm.digest).toBe(sha16("e:1,e:2"));
    expect(wm.digest).toHaveLength(16);
    expect(coverageDigestOf(["e:2", "e:1"])).toBe(sha16("e:2,e:1")); // 指纹严格按传入顺序,不偷偷排序
  });

  it("空集 → watermarkSeq=lastCompactSeq,digest=sha256('')", () => {
    const wm = computeWatermark([], "s", { lastCompactSeq: 42 });
    expect(wm.watermarkSeq).toBe(42);
    expect(wm.coveredIds).toEqual([]);
    expect(wm.digest).toBe(EMPTY_DIGEST);
    expect(wm.digest).toHaveLength(16);
  });

  it("缺省 lastCompactSeq=0:seq 0 视作已覆盖基线,右界仍取真实最大 seq", () => {
    const wm = computeWatermark([ev(0, "message.user"), ev(1, "message.user")], "s");
    expect(wm.coveredIds).toEqual(["e:1"]);
    expect(wm.watermarkSeq).toBe(1);
  });

  it("maxEvents 只取最新 N 条,右界仍落在最大 seq", () => {
    const events = [1, 2, 3, 4, 5].map((seq) => ev(seq, "message.user"));
    const wm = computeWatermark(events, "s", { maxEvents: 2 });
    expect(wm.coveredIds).toEqual(["e:4", "e:5"]);
    expect(wm.watermarkSeq).toBe(5);
    expect(wm.counts.messages).toBe(2);
  });

  it("同 seq 双写(重启/双进程计数器)只算一条事实", () => {
    const wm = computeWatermark([ev(3, "message.user"), ev(3, "message.user"), ev(4, "message.user")], "s");
    expect(wm.coveredIds).toEqual(["e:3", "e:4"]);
    expect(wm.counts.messages).toBe(2);
  });

  it("确定性:同输入两次调用结果深相等", () => {
    const events = [3, 1, 2].map((seq) => ev(seq, "message.user"));
    expect(computeWatermark(events, "s")).toEqual(computeWatermark([...events], "s"));
  });

  it("不可变:不改写入参数组与事件对象", () => {
    const events = [ev(2, "message.user"), ev(1, "tool.result")];
    const before = JSON.stringify(events);
    const snapshot = [...events];
    const wm = computeWatermark(events, "s");
    wm.coveredIds.push("e:999");
    expect(JSON.stringify(events)).toBe(before);
    expect(events).toEqual(snapshot);
  });

  it("坏输入(undefined / 非数组 / 无 seq / 非有限 seq)不 throw", () => {
    expect(() => computeWatermark(undefined, "s")).not.toThrow();
    expect(computeWatermark(undefined, "s").coveredIds).toEqual([]);
    expect(computeWatermark("nope" as unknown as Ev[], "s").coveredIds).toEqual([]);
    const junk = [
      { kind: "message.user", sessionId: "s" },
      { seq: Number.NaN, kind: "message.user", sessionId: "s" },
      { seq: 5, sessionId: "s" },
      null as unknown as Ev,
    ];
    expect(computeWatermark(junk, "s").coveredIds).toEqual([]);
  });

  it("探针 A:10 事件 watermark 的 ids/digest 稳定且可复算", () => {
    const events = Array.from({ length: 10 }, (_, i) => ev(i + 1, i % 3 === 0 ? "tool.result" : "message.user"));
    const first = computeWatermark(events, "s");
    const second = computeWatermark([...events].reverse(), "s");
    expect(first.coveredIds).toEqual(["e:1", "e:2", "e:3", "e:4", "e:5", "e:6", "e:7", "e:8", "e:9", "e:10"]);
    expect(first.watermarkSeq).toBe(10);
    expect(first.digest).toBe(sha16(first.coveredIds.join(",")));
    expect(second.digest).toBe(first.digest); // 输入顺序无关,指纹只由 id 集决定
    expect(second.coveredIds).toEqual(first.coveredIds);
  });
});

describe("verifyCoverage 提交前验证", () => {
  const base = () => computeWatermark([ev(1, "message.user"), ev(2, "message.agent")], "s");

  it("探针 B:右界之后新增 message.user → CONCURRENT_APPEND 并列出 appendedIds", () => {
    const wm = base();
    const now = [ev(1, "message.user"), ev(2, "message.agent"), ev(3, "message.user")];
    const r = verifyCoverage(wm, now, "s");
    expect(r.code).toBe("CONCURRENT_APPEND");
    expect(r.appendedIds).toEqual(["e:3"]);
    expect(r.missingIds).toEqual([]);
  });

  it("tool.result 新到达同样算并发追加", () => {
    const r = verifyCoverage(base(), [ev(1, "message.user"), ev(2, "message.agent"), ev(9, "tool.result")], "s");
    expect(r.code).toBe("CONCURRENT_APPEND");
    expect(r.appendedIds).toEqual(["e:9"]);
  });

  it("探针 D:无新增 → OK", () => {
    const r = verifyCoverage(base(), [ev(1, "message.user"), ev(2, "message.agent")], "s");
    expect(r).toEqual({ code: "OK", appendedIds: [], missingIds: [] });
  });

  it("只新增遥测/过程事件 → 仍然 OK(它们不进上下文)", () => {
    const r = verifyCoverage(base(), [ev(1, "message.user"), ev(2, "message.agent"), ev(3, "llm.trace"), ev(4, "step.start"), ev(5, "compact.start")], "s");
    expect(r.code).toBe("OK");
  });

  it("别的会话在右界之后新增事实 → 不影响本会话覆盖", () => {
    const r = verifyCoverage(base(), [ev(1, "message.user"), ev(2, "message.agent"), ev(7, "message.user", "other")], "s");
    expect(r.code).toBe("OK");
  });

  it("探针 E:watermarkSeq 为负数 → INVALID", () => {
    const broken = { ...base(), watermarkSeq: -1 };
    expect(verifyCoverage(broken, [ev(1, "message.user")], "s").code).toBe("INVALID");
  });

  it("coveredIds 不是数组 → INVALID", () => {
    const broken = { ...base(), coveredIds: "e:1" as unknown as string[] };
    expect(verifyCoverage(broken, [ev(1, "message.user")], "s").code).toBe("INVALID");
  });

  it("watermark 缺失/null → INVALID(缺证明不能当 OK 用)", () => {
    expect(verifyCoverage(undefined, [], "s").code).toBe("INVALID");
    expect(verifyCoverage(null, [], "s").code).toBe("INVALID");
  });

  it("watermark 声称覆盖的 id 在事实面里读不到 → COVERAGE_GAP 并列出 missingIds", () => {
    const r = verifyCoverage(base(), [ev(1, "message.user")], "s");
    expect(r.code).toBe("COVERAGE_GAP");
    expect(r.missingIds).toEqual(["e:2"]);
  });

  it("同时存在新增与缺失 → 优先报 CONCURRENT_APPEND(本次摘要必然过期)", () => {
    const r = verifyCoverage(base(), [ev(1, "message.user"), ev(5, "message.user")], "s");
    expect(r.code).toBe("CONCURRENT_APPEND");
    expect(r.appendedIds).toEqual(["e:5"]);
    expect(r.missingIds).toEqual(["e:2"]);
  });

  it("坏事件(无 seq / 非对象)不 throw", () => {
    expect(() => verifyCoverage(base(), [null as unknown as Ev, { kind: "message.user" } as unknown as Ev], "s")).not.toThrow();
    expect(verifyCoverage(base(), undefined, "s").code).toBe("COVERAGE_GAP");
  });
});

describe("commitDecision 双条件", () => {
  const ok = { code: "OK", appendedIds: [] as string[], missingIds: [] as string[] };

  it("探针 D:代际未变 + coverage OK → commit=true", () => {
    expect(commitDecision({ generationAtStart: 7, generationNow: 7, coverage: ok })).toEqual({ commit: true, code: "OK" });
  });

  it("探针 C:代际变化 → STALE_GENERATION,不提交", () => {
    expect(commitDecision({ generationAtStart: 7, generationNow: 8, coverage: ok })).toEqual({ commit: false, code: "STALE_GENERATION" });
  });

  it("coverage=CONCURRENT_APPEND → commit=false 且保留原码", () => {
    expect(commitDecision({ generationAtStart: 7, generationNow: 7, coverage: { code: "CONCURRENT_APPEND", appendedIds: ["e:9"], missingIds: [] } })).toEqual({
      commit: false,
      code: "CONCURRENT_APPEND",
    });
  });

  it("coverage=COVERAGE_GAP → commit=false", () => {
    expect(commitDecision({ generationAtStart: 7, generationNow: 7, coverage: { code: "COVERAGE_GAP", appendedIds: [], missingIds: ["e:1"] } }).code).toBe("COVERAGE_GAP");
  });

  it("coverage 缺省 → COVERAGE_GAP(fail-closed)", () => {
    expect(commitDecision({ generationAtStart: 7, generationNow: 7 })).toEqual({ commit: false, code: "COVERAGE_GAP" });
  });

  it("代际不是有限数 → INVALID", () => {
    expect(commitDecision({ generationAtStart: Number.NaN, generationNow: 0, coverage: ok }).code).toBe("INVALID");
    expect(commitDecision(undefined).code).toBe("INVALID");
  });

  it("取值域只有五个码", () => {
    expect([...COMPACT_COVERAGE_CODES]).toEqual(["OK", "COVERAGE_GAP", "CONCURRENT_APPEND", "STALE_GENERATION", "INVALID"]);
  });
});

describe("coverageProof 证明字段", () => {
  it("字段序固定且 count 与 ids 一致", () => {
    const wm = computeWatermark([ev(1, "message.user"), ev(2, "tool.result")], "s");
    const proof = coverageProof(wm, { commit: true, code: "OK" });
    expect(Object.keys(proof)).toEqual(["coveredWatermark", "coveredIds", "count", "digest", "code"]);
    expect(proof).toEqual({ coveredWatermark: 2, coveredIds: ["e:1", "e:2"], count: 2, digest: wm.digest, code: "OK" });
  });

  it("入参坏 → 不 throw,空 ids + INVALID", () => {
    expect(coverageProof(undefined, undefined)).toEqual({ coveredWatermark: 0, coveredIds: [], count: 0, digest: EMPTY_DIGEST, code: "INVALID" });
  });

  it("不可变:改动返回的 coveredIds 不影响 watermark", () => {
    const wm = computeWatermark([ev(1, "message.user")], "s");
    const proof = coverageProof(wm, { commit: true, code: "OK" });
    proof.coveredIds.push("e:99");
    expect(wm.coveredIds).toEqual(["e:1"]);
  });
});

describe("mergeCoveredProofs 多轮累计", () => {
  const p = (wm: number, ids: string[]) => {
    const sorted = [...new Set(ids)].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
    return { coveredWatermark: wm, coveredIds: ids, count: ids.length, digest: sha16(sorted.join(",")), code: "OK" as const };
  };

  it("只保留最近 3 轮", () => {
    let acc = mergeCoveredProofs(undefined, p(1, ["e:1"]));
    for (let i = 2; i <= 5; i++) acc = mergeCoveredProofs(acc, p(i, [`e:${i}`]));
    expect(acc).toHaveLength(3);
    expect(acc.map((x) => x.coveredWatermark)).toEqual([3, 4, 5]);
  });

  it("ids 去重排序(数值序),同轮重复提交不重复入列", () => {
    const merged = mergeCoveredProofs([p(2, ["e:10", "e:2", "e:10"])], p(2, ["e:2", "e:10"]));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.coveredIds).toEqual(["e:2", "e:10"]);
    expect(merged[0]!.count).toBe(2);
  });

  it("坏输入不 throw", () => {
    expect(mergeCoveredProofs(undefined, undefined)).toEqual([]);
    expect(mergeCoveredProofs("x" as unknown as [], null)).toEqual([]);
  });
});

describe("探针 F/B:auto-compact 实跑接线", () => {
  function longJournal(sid = "s") {
    const j = new MemoryJournal();
    for (let i = 0; i < 20; i++) j.append({ kind: "message.user", sessionId: sid, payload: { text: "很长很长的内容".repeat(50) } });
    return j;
  }
  const okLlm: LlmProvider = { async chat() { return { content: "摘要:压缩了" }; } };

  it("探针 F:compact.start 带 watermarkSeq/digest;compact.done 带四项证明字段", async () => {
    const j = longJournal();
    const dir = mkdtempSync(join(tmpdir(), "m126-"));
    const r = await autoCompact(j, "s", { thresholdTokens: 100, keepRecentMessages: 3, compactLlm: okLlm, devlogDir: dir, force: true });
    expect(r.compacted).toBe(true);

    const events = j.readAll();
    const start = events.find((e) => e.kind === "compact.start")!;
    const sp = start.payload as { watermarkSeq?: number; digest?: string };
    const done = events.find((e) => e.kind === "compact.done")!;
    const dp = done.payload as {
      coveredWatermark?: number;
      coveredIds?: string[];
      coverageDigest?: string;
      coverageCode?: string;
      tailStartId?: string;
      tailGroupCount?: number;
    };

 // watermark 实算:seq 0 视作基线,覆盖 e:1..e:19
    expect(sp.watermarkSeq).toBe(19);
    expect(sp.digest).toBe(sha16(Array.from({ length: 19 }, (_, i) => `e:${i + 1}`).join(",")));

 // 证明四件套与 start 的 watermark 对齐
    expect(dp.coveredWatermark).toBe(19);
    expect(dp.coveredIds).toHaveLength(19);
    expect(dp.coveredIds![0]).toBe("e:1");
    expect(dp.coveredIds![18]).toBe("e:19");
    expect(dp.coverageDigest).toBe(sp.digest);
    expect(dp.coverageCode).toBe("OK");

 // 既有边界字段零回归
    expect(typeof dp.tailStartId).toBe("string");
    expect(typeof dp.tailGroupCount).toBe("number");
    expect(events.some((e) => e.kind === "compact.abandoned")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("探针 B(真实路径):摘要期间 append message.user → 不写 compact.done,历史不变", async () => {
    const j = longJournal();
    const dir = mkdtempSync(join(tmpdir(), "m126-"));
    const racingLlm: LlmProvider = {
      async chat() {
        j.append({ kind: "message.user", sessionId: "s", payload: { text: "摘要途中新到达的消息" } });
        return { content: "摘要:压缩了" };
      },
    };
    const r = await autoCompact(j, "s", { thresholdTokens: 100, keepRecentMessages: 3, compactLlm: racingLlm, devlogDir: dir, force: true });
    expect(r.compacted).toBe(false);

    const events = j.readAll();
    expect(events.some((e) => e.kind === "compact.done")).toBe(false);

 // 同一事实面用覆盖逻辑复算:右界之后确有新增事实 → CONCURRENT_APPEND(证明这条数据是真的)
    const beforeSummary = events.filter((e) => typeof e.seq === "number" && e.seq <= 19);
    const wm = computeWatermark(beforeSummary, "s");
    expect(wm.watermarkSeq).toBe(19);
    const appended = verifyCoverage(wm, events, "s");
    expect(appended.code).toBe("CONCURRENT_APPEND");
    expect(appended.appendedIds).toHaveLength(1);
    expect(Number(appended.appendedIds[0]!.slice(2))).toBeGreaterThan(19);
    rmSync(dir, { recursive: true, force: true });
  });

  it("第二轮压缩:lastCompactSeq 取上一轮 coveredWatermark,不重复覆盖已证明段", async () => {
    const j = longJournal();
    const dir = mkdtempSync(join(tmpdir(), "m126-"));
    await autoCompact(j, "s", { thresholdTokens: 100, keepRecentMessages: 3, compactLlm: okLlm, devlogDir: dir, force: true });
    const second = await autoCompact(j, "s", { thresholdTokens: 100, keepRecentMessages: 3, compactLlm: okLlm, devlogDir: dir, force: true });
    expect(second.compacted).toBe(true);

    const starts = j.readAll().filter((e) => e.kind === "compact.start");
    const dones = j.readAll().filter((e) => e.kind === "compact.done");
    const firstDone = dones[0]!.payload as { coveredWatermark?: number };
    const secondStart = starts[starts.length - 1]!.payload as { watermarkSeq?: number; digest?: string };
    const firstStart = starts[0]!.payload as { digest?: string };
    expect(firstDone.coveredWatermark).toBe(19);
 // 第二轮只覆盖「上一轮右界之后」的事实(压缩提示 message.system 等),不重复已证明段
    expect(secondStart.watermarkSeq).toBeGreaterThan(19);
    expect(secondStart.digest).not.toBe(firstStart.digest);

    const lastDone = dones[dones.length - 1]!.payload as { coveredIds?: string[]; coverageCode?: string; coveredWatermark?: number };
    expect(lastDone.coverageCode).toBe("OK");
    expect(lastDone.coveredWatermark).toBe(secondStart.watermarkSeq);
    expect(lastDone.coveredIds!.every((id) => Number(id.slice(2)) > 19)).toBe(true);
    expect(lastDone.coveredIds!.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
