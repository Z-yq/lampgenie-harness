/**
 * g3 WS 发送字节账本单测(2026-11):
 *  - 按帧型聚合(降序)、单帧峰值、type 归一、脏 bytes 忽略;
 *  - reset 窗口语义;
 *  - 零帧不落账(不发空账);
 *  - 落账事件内容可断言(MemoryJournal)+ 落账后账本清空。
 */
import { describe, it, expect, vi } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { WsByteLedger, flushWsLedger } from "../src/ws-byte-ledger.js";

function ledgerAt(ms: number): WsByteLedger {
  return new WsByteLedger(() => ms);
}

/** 读 journal 里的 ws.ledger 事件(按落账顺序)。 */
function ledgerEvents(journal: MemoryJournal): { kind: string; sessionId: string; payload: Record<string, unknown> }[] {
  return journal
    .readAll()
    .filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "ws.ledger")
    .map((e) => ({ kind: e.kind, sessionId: e.sessionId, payload: e.payload as Record<string, unknown> }));
}

describe("WsByteLedger 纯内存账本", () => {
  it("按帧型聚合:frames/bytes/maxFrameBytes 累加,byType 按 bytes 降序", () => {
    const l = ledgerAt(1_000);
    l.record("stream", 300);
    l.record("stream", 900);
    l.record("task.changed", 1_500);
    l.record("hello", 10);

    const s = l.snapshot();
    expect(s.totalFrames).toBe(4);
    expect(s.totalBytes).toBe(2_710);
    expect(s.byType.map((r) => r.type)).toEqual(["task.changed", "stream", "hello"]);
    expect(s.byType[1]).toEqual({ type: "stream", frames: 2, bytes: 1_200, maxFrameBytes: 900 });
    expect(s.since).toBe(1_000);
  });

  it("峰值记录 = 单帧最大字节(带帧型)", () => {
    const l = ledgerAt(0);
    l.record("a", 100);
    l.record("b", 5_000);
    l.record("a", 200);
    expect(l.snapshot().peak).toEqual({ type: "b", bytes: 5_000 });
    // 同字节不覆盖首个峰值(先到先得,口径稳定)
    l.record("c", 5_000);
    expect(l.snapshot().peak).toEqual({ type: "b", bytes: 5_000 });
    expect(ledgerAt(0).snapshot().peak).toBeNull();
  });

  it("type 缺省/空白归一为 ?,非有限/负 bytes 忽略", () => {
    const l = ledgerAt(0);
    l.record("", 10);
    l.record("   ", 20);
    l.record(undefined as unknown as string, 30);
    l.record("ok", Number.NaN);
    l.record("ok", Number.POSITIVE_INFINITY);
    l.record("ok", -5);
    l.record("ok", 40);

    const s = l.snapshot();
    expect(s.totalFrames).toBe(4); // 3 个 "?" 帧 + 1 个 ok 帧;脏 bytes 的那 3 条一条都没进
    expect(s.totalBytes).toBe(100);
    expect(s.byType.find((r) => r.type === "?")).toEqual({ type: "?", frames: 3, bytes: 60, maxFrameBytes: 30 });
    expect(s.byType.find((r) => r.type === "ok")).toEqual({ type: "ok", frames: 1, bytes: 40, maxFrameBytes: 40 });
  });

  it("背压丢帧另计 dropped(不进 byType 实发口径)", () => {
    const l = ledgerAt(0);
    l.record("stream", 100);
    l.record("stream", 0, true);
    l.record("stream", 0, true);
    const s = l.snapshot();
    expect(s.totalFrames).toBe(1);
    expect(s.droppedFrames).toBe(2);
    expect(s.byType).toHaveLength(1);
  });

  it("reset:清空计数并开启新窗口(since 前移,peak 归零)", () => {
    let now = 1_000;
    const l = new WsByteLedger(() => now);
    l.record("x", 1_000);
    expect(l.snapshot().since).toBe(1_000);

    now = 31_000;
    l.reset();
    const s = l.snapshot();
    expect(s).toMatchObject({ totalFrames: 0, totalBytes: 0, byType: [], peak: null, since: 31_000 });
  });
});

describe("flushWsLedger 周期落账", () => {
  it("零帧不落账(不发空账):journal 无事件,账本窗口不清", () => {
    const l = ledgerAt(1_000);
    const journal = new MemoryJournal();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const r = flushWsLedger(l, journal, 31_000);
      expect(r.flushed).toBe(false);
      expect(journal.readAll()).toHaveLength(0);
      expect(spy).not.toHaveBeenCalled();
      expect(l.snapshot().since).toBe(1_000); // 空窗口不重置起点
    } finally {
      spy.mockRestore();
    }
  });

  it("有帧则落一条 custom/ws.ledger 事件,内容可断言,且落账后账本清空", () => {
    let now = 0;
    const l = new WsByteLedger(() => now);
    const journal = new MemoryJournal();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      l.record("stream", 2_000);
      l.record("stream", 4_000);
      l.record("task.changed", 500);
      l.record("board.frame", 9_000); // peak
      now = 30_000;
      const r = flushWsLedger(l, journal, now);
      expect(r.flushed).toBe(true);

      const evs = ledgerEvents(journal);
      expect(evs).toHaveLength(1);
      expect(evs[0]!.kind).toBe("custom"); // custom 属 CROSS_SESSION_KINDS → 归 global
      expect(evs[0]!.sessionId).toBe("system");
      expect(evs[0]!.payload).toMatchObject({
        type: "ws.ledger",
        totalFrames: 4,
        totalBytes: 15_500,
        peak: { type: "board.frame", bytes: 9_000 },
        at: 30_000,
      });
      const byType = evs[0]!.payload.byType as { type: string; frames: number; bytes: number }[];
      expect(byType.map((r) => r.type)).toEqual(["board.frame", "stream", "task.changed"]);
      expect(byType[1]).toMatchObject({ frames: 2, bytes: 6_000 });

      // 摘要一行(log,warn 不走)
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]![0])).toContain("ws 发送账本 30s");
      expect(String(spy.mock.calls[0]![0])).toContain("board.frame=8.8KB/1f");

      // 落账后开启新窗口
      expect(l.snapshot()).toMatchObject({ totalFrames: 0, totalBytes: 0, since: 30_000 });
    } finally {
      spy.mockRestore();
    }
  });

  it("byType 落账截断到前 10(日志摘要截前 5),防账本事件自己变成大帧", () => {
    const l = ledgerAt(0);
    const journal = new MemoryJournal();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < 14; i += 1) l.record(`t${i}`, (i + 1) * 100);
      flushWsLedger(l, journal, 30_000);
      const ev = ledgerEvents(journal)[0]!;
      expect((ev.payload.byType as unknown[]).length).toBe(10);
      const logged = String(spy.mock.calls[0]![0]);
      expect(logged).toContain("t13=");
      expect(logged).not.toContain("t8="); // 前 5 行之外不出现
    } finally {
      spy.mockRestore();
    }
  });

  it("journal append 抛错不阻断落账后的账本重置与返回", () => {
    const l = ledgerAt(0);
    const journal = new MemoryJournal();
    const boom = { ...journal, append: () => { throw new Error("disk full"); } } as unknown as MemoryJournal;
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      l.record("x", 10);
      const r = flushWsLedger(l, boom, 30_000);
      expect(r.flushed).toBe(true);
      expect(l.snapshot().totalFrames).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
