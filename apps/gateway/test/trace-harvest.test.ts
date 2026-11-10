import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvestTraces, type HarvestJournal } from "../src/trace-harvest";

type RawEvent = { seq: number; time: number; sessionId: string; kind: string; payload: Record<string, unknown> };

/** 造 call/result 配对的工具事件(pairs 对 = 2*pairs 行)。 */
function sessionEvents(sessionId: string, pairs: number, base = 1): RawEvent[] {
  const out: RawEvent[] = [];
  let seq = base;
  for (let i = 0; i < pairs; i++) {
    out.push({ seq: seq, time: 1000 + seq, sessionId, kind: "tool.call", payload: { toolCallId: `c${seq}`, name: "grep", arguments: "abc" } });
    seq += 1;
    out.push({ seq: seq, time: 1000 + seq, sessionId, kind: "tool.result", payload: { toolCallId: `c${seq - 1}`, name: "grep", content: "ok", durationMs: 3 } });
    seq += 1;
  }
  return out;
}

/** 假 journal:readSession 的 sinceSeq 与真实实现一致(inclusive)。 */
function fakeJournal(eventsBySession: Record<string, RawEvent[]>, failOn?: string): HarvestJournal {
  return {
    readSession(sessionId: string, sinceSeq = 0) {
      if (failOn === sessionId) throw new Error("boom-read");
      return (eventsBySession[sessionId] ?? []).filter((e) => e.seq >= sinceSeq);
    },
    readAll() {
      return Object.values(eventsBySession).flat();
    },
  };
}

async function batchFiles(outDir: string): Promise<string[]> {
  try {
    return (await readdir(join(outDir, "batches"))).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
}

async function tmpOut(): Promise<string> {
  return mkdtemp(join(tmpdir(), "trace-harvest-"));
}

describe("trace-harvest:批次落盘与幂等", () => {
  it("首跑产批 + 账本;重跑账本命中原样跳过且不新增批次文件", async () => {
    const outDir = await tmpOut();
    const journal = fakeJournal({ s1: sessionEvents("s1", 3) }); // 6 行

    const first = await harvestTraces({ journal, root: outDir, outDir, sessions: ["s1"], ruleVersion: "r1" });
    expect(first.failedSessions).toEqual([]);
    expect(first.batches).toBe(1);
    expect(first.skippedBatches).toBe(0);
    expect(first.events).toBe(3); // 3 次配对工具 = 3 条 tool 事件
    expect(first.coverage).toMatchObject({ inputEvents: 6, duplicateSeqs: 0, mappedEvents: 6, coverageRate: 1 });

    const filesAfterFirst = await batchFiles(outDir);
    expect(filesAfterFirst).toHaveLength(1);
    const batchPath = join(outDir, "batches", filesAfterFirst[0]!);
    const body = await readFile(batchPath, "utf-8");
    expect(body.trim().split("\n")).toHaveLength(3);
    expect(JSON.parse(body.trim().split("\n")[0]!).kind).toBe("tool");

    const ledger = JSON.parse(await readFile(join(outDir, "ledger.json"), "utf-8")) as {
      version: number;
      ruleVersion: string;
      batches: Record<string, { sessionId: string; seqStart: number; seqEnd: number; events: number }>;
    };
    expect(ledger.version).toBe(1);
    expect(Object.keys(ledger.batches)).toHaveLength(1);
    const ledgerBatch = Object.values(ledger.batches)[0]!;
    expect(ledgerBatch).toMatchObject({ sessionId: "s1", seqStart: 1, seqEnd: 6, events: 3 });

    const second = await harvestTraces({ journal, root: outDir, outDir, sessions: ["s1"], ruleVersion: "r1" });
    expect(second.batches).toBe(0);
    expect(second.skippedBatches).toBe(1);
    expect(second.skippedEvents).toBe(3);
    expect(second.events).toBe(0);
    expect(await batchFiles(outDir)).toEqual(filesAfterFirst); // 不新增、不改写
    expect(await readFile(batchPath, "utf-8")).toBe(body);
    await rm(outDir, { recursive: true, force: true });
  });

  it("ruleVersion 变 → 键变:重新产批(旧批保留)", async () => {
    const outDir = await tmpOut();
    const journal = fakeJournal({ s1: sessionEvents("s1", 2) });
    await harvestTraces({ journal, root: outDir, outDir, sessions: ["s1"], ruleVersion: "r1" });
    const filesR1 = await batchFiles(outDir);
    expect(filesR1).toHaveLength(1);

    const r2 = await harvestTraces({ journal, root: outDir, outDir, sessions: ["s1"], ruleVersion: "r2" });
    expect(r2.batches).toBe(1);
    expect(r2.skippedBatches).toBe(0);
    const filesR2 = await batchFiles(outDir);
    expect(filesR2).toHaveLength(2);
    expect(filesR2).toContain(filesR1[0]!);
    await rm(outDir, { recursive: true, force: true });
  });

  it("增量:追加新事件后再跑,先跳过旧窗口再产新批", async () => {
    const outDir = await tmpOut();
    const bySession: Record<string, RawEvent[]> = { s1: sessionEvents("s1", 1) }; // seq 1..2
    const journal = fakeJournal(bySession);
    await harvestTraces({ journal, root: outDir, outDir, sessions: ["s1"], ruleVersion: "r1" });

    bySession.s1 = [...bySession.s1!, ...sessionEvents("s1", 1, 3)]; // + seq 3..4
    const again = await harvestTraces({ journal, root: outDir, outDir, sessions: ["s1"], ruleVersion: "r1" });
    expect(again.skippedBatches).toBe(1); // 旧窗口 key 命中
    expect(again.batches).toBe(1); // 窗口变宽 → 新键
    const files = await batchFiles(outDir);
    expect(files).toHaveLength(2);
    await rm(outDir, { recursive: true, force: true });
  });
});

describe("trace-harvest:边界与失败隔离", () => {
  it("dryRun 只读:不产批次文件、不写账本", async () => {
    const outDir = await tmpOut();
    const journal = fakeJournal({ s1: sessionEvents("s1", 1) });
    const report = await harvestTraces({ journal, root: outDir, outDir, sessions: ["s1"], dryRun: true });
    expect(report.batches).toBe(1);
    expect(report.dryRun).toBe(true);
    expect(await batchFiles(outDir)).toEqual([]);
    await expect(readFile(join(outDir, "ledger.json"), "utf-8")).rejects.toThrow();
    await rm(outDir, { recursive: true, force: true });
  });

  it("单会话读失败 → 记 failedSessions,其余会话照常产批,不抛", async () => {
    const outDir = await tmpOut();
    const journal = fakeJournal({ ok: sessionEvents("ok", 1), bad: sessionEvents("bad", 1) }, "bad");
    const report = await harvestTraces({ journal, root: outDir, outDir, sessions: ["bad", "ok"] });
    expect(report.failedSessions).toHaveLength(1);
    expect(report.failedSessions[0]).toMatchObject({ sessionId: "bad" });
    expect(report.failedSessions[0]!.error).toContain("boom-read");
    expect(report.batches).toBe(1);
    expect(report.sessions).toBe(2);
    await rm(outDir, { recursive: true, force: true });
  });

  it("maxEventsPerSession 截断:标记 windowTruncated 并继续读完整会话", async () => {
    const outDir = await tmpOut();
    const journal = fakeJournal({ s1: sessionEvents("s1", 3) }); // 6 行
    const report = await harvestTraces({
      journal, root: outDir, outDir, sessions: ["s1"], maxEventsPerSession: 2,
    });
    expect(report.windowTruncated).toBeGreaterThanOrEqual(1);
    expect(report.batches).toBe(3); // 2+2+2
    expect(report.events).toBe(3); // 3 次配对
    expect(report.coverage.inputEvents).toBe(6);
    // 每个批次窗口互不重叠
    const starts = report.batchesDetail.map((b) => b.seqStart);
    expect(starts).toEqual([1, 3, 5]);
    await rm(outDir, { recursive: true, force: true });
  });

  it("账本损坏 → 重建账本并如实标记 ledgerReset(旧批次文件仍在)", async () => {
    const outDir = await tmpOut();
    const journal = fakeJournal({ s1: sessionEvents("s1", 1) });
    await harvestTraces({ journal, root: outDir, outDir, sessions: ["s1"] });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(outDir, "ledger.json"), "{ not json", "utf-8");
    const report = await harvestTraces({ journal, root: outDir, outDir, sessions: ["s1"] });
    expect(report.ledgerReset).toBe(true);
    expect(report.batches).toBe(1); // 账本重建 → 该批重新登记(文件已存在,内容不变)
    expect(await batchFiles(outDir)).toHaveLength(1);
    await rm(outDir, { recursive: true, force: true });
  });

  it("sessions 缺省时从 readAll 推 distinct 会话", async () => {
    const outDir = await tmpOut();
    const journal = fakeJournal({ a: sessionEvents("a", 1), b: sessionEvents("b", 1) });
    const report = await harvestTraces({ journal, root: outDir, outDir });
    expect(report.sessions).toBe(2);
    expect(report.batches).toBe(2);
    await rm(outDir, { recursive: true, force: true });
  });
});
