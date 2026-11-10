/**
 * M24 生产态写前屏障:worker ProxyJournal.flushStrict 走 RPC ack(2026-11-07)。
 *
 * 断言语义:
 * ①host RPC journal.appendSync:落账成功 + flushStrict 成功 → ok:true,且 flush 在 append 之后;
 *   flushStrict 抛错 → ok:false + error(带原因);appendMany 抛错 → ok:false 且不调 flush;
 * ②host RPC journal.flushStrict:只清 gateway FileJournal 队列(不落账),抛错 → ok:false;
 * ③ProxyJournal.flushStrict:有 batch 只发一次 appendSync(microtask 不重发)、无 batch 发 flushStrict;
 *   RPC reject → 抛 "journal flushStrict failed: …" 且失败批保留待重试(不丢);
 * ④桩 worker 真 IPC 走一遍两个 kind(host answer 装配正确,不只是单函数级)。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { MemoryJournal } from "@lampgenie/core";
import type { Journal, NewEvent, JournalEvent, EventListener } from "@lampgenie/core";
import { TaskSupervisor } from "../src/task-manager.js";
import { createSessionWorkerHost, type SessionWorkerHostDeps } from "../src/session-worker-host.js";
import { ProxyJournal, setIpcTransport, handleHostResponse, request } from "../src/session-worker-lib.js";

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, "fixtures", "session-worker-stub.mjs");

// ── host 侧:假 journal(可注入 append/flush 顺序与失败)────────────────────────
class FlushJournal implements Journal {
  private inner = new MemoryJournal();
  order: string[] = [];
  /** 落账失败注入:events 里出现该 payload.text 即抛错(只炸目标批,ack 回写批照常入账)。 */
  failAppendText?: string;
  flushFails = false;
  /** ack 回写批是否已入账(用于断言「落账失败不 flush」——桩 worker 会紧跟着发 flushStrict RPC)。 */
  ackLanded = false;
  flushBeforeAck = false;
  appendMany<T>(events: NewEvent<T>[]): JournalEvent<T>[] {
    this.order.push("append");
    if (this.failAppendText && events.some((e) => (e.payload as { text?: string } | undefined)?.text === this.failAppendText)) {
      throw new Error("ENOSPC: no space left on device");
    }
    if (events.some((e) => (e.payload as { what?: string } | undefined)?.what === "journalsync.ack")) this.ackLanded = true;
    return this.inner.appendMany(events);
  }
  append<T>(event: NewEvent<T>): JournalEvent<T> { return this.inner.append(event); }
  readAll(sinceSeq?: number): JournalEvent[] { return this.inner.readAll(sinceSeq); }
  readSession(sessionId: string, sinceSeq?: number): JournalEvent[] { return this.inner.readSession(sessionId, sinceSeq); }
  subscribe(listener: EventListener): () => void { return this.inner.subscribe(listener); }
  flushStrict(): void {
    this.order.push("flush");
    if (!this.ackLanded) this.flushBeforeAck = true;
    if (this.flushFails) throw new Error("EIO: i/o error");
  }
  get length(): number { return this.inner.length; }
}

function hostSetup(journal: Journal) {
  const tm = new TaskSupervisor();
  const host = createSessionWorkerHost({
    taskManager: tm,
    journal,
    streamSink: () => {},
    bgAgentsMirror: new Map(),
    repoRoot: mkdtempSync(join(tmpdir(), "swfs-")),
    browserConfig: { enabled: () => false, allowDomains: () => [] },
    setState: (task, to, result) => tm.setState(task, to, result),
    workerEntry: STUB,
  } as SessionWorkerHostDeps);
  const task = tm.submit("user", "s-w1", "flush-strict 桩任务");
  host.dispatch(task);
  return host;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (pred: () => boolean, ms = 8000, step = 50): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await wait(step); }
  return pred();
};

/** 从 journal 里取桩 worker 回写的 ack 结果。 */
function ackOf(journal: Journal, sid: string): { a: { ok: boolean; error: string | null }; b: { ok: boolean; error: string | null } } | null {
  const e = journal.readSession(sid).filter((x) => (x.payload as { what?: string }).what === "journalsync.ack").pop();
  return e ? (e.payload as { a: never; b: never }) as never : null;
}

afterEach(() => { delete process.env.STUB_MODE; vi.restoreAllMocks(); });

describe("host RPC journal.appendSync / journal.flushStrict(stub worker 真 IPC)", () => {
  it("正常:appendSync ok 且 flush 在 append 之后;flushStrict ok", async () => {
    process.env.STUB_MODE = "journalsync";
    const journal = new FlushJournal();
    hostSetup(journal);
    expect(await waitUntil(() => ackOf(journal, "s-w1") !== null)).toBe(true);
    const ack = ackOf(journal, "s-w1")!;
    expect(ack.a).toEqual({ ok: true, error: null });
    expect(ack.b).toEqual({ ok: true, error: null });
    // 落账真的发生(权威 seq 由 gateway 分配)
    expect(journal.readSession("s-w1").some((e) => (e.payload as { text?: string }).text === "sync-evt")).toBe(true);
    // 顺序:append 早于 flush
    const iAppend = journal.order.indexOf("append");
    const iFlush = journal.order.indexOf("flush");
    expect(iAppend).toBeGreaterThanOrEqual(0);
    expect(iFlush).toBeGreaterThan(iAppend);
  }, 15_000);

  it("flushStrict 抛错:appendSync 回 ok:false(带原因),append 已发生", async () => {
    process.env.STUB_MODE = "journalsync";
    const journal = new FlushJournal();
    journal.flushFails = true;
    hostSetup(journal);
    expect(await waitUntil(() => ackOf(journal, "s-w1") !== null)).toBe(true);
    const ack = ackOf(journal, "s-w1")!;
    expect(ack.a.ok).toBe(false);
    expect(String(ack.a.error)).toContain("flushStrict");
    expect(String(ack.a.error)).toContain("EIO");
    expect(ack.b.ok).toBe(false);
    expect(journal.order).toContain("append");
  }, 15_000);

  it("appendMany 抛错:appendSync 回 ok:false 且不调 flushStrict", async () => {
    process.env.STUB_MODE = "journalsync";
    const journal = new FlushJournal();
    journal.failAppendText = "sync-evt";
    hostSetup(journal);
    expect(await waitUntil(() => ackOf(journal, "s-w1") !== null)).toBe(true);
    const ack = ackOf(journal, "s-w1")!;
    expect(ack.a.ok).toBe(false);
    expect(String(ack.a.error)).toContain("ENOSPC");
    // 落账失败不 flush:只允许桩 worker 后续那条纯 flushStrict RPC 的 flush(此时 ack 批已入账)。
    expect(journal.flushBeforeAck).toBe(false);
  }, 15_000);
});

// ── worker 侧:ProxyJournal.flushStrict(IPC 打桩)──────────────────────────────
describe("ProxyJournal.flushStrict(RPC ack)", () => {
  afterEach(() => { setIpcTransport(null); });

  interface Sent { t: string; id?: number; kind?: string; events?: unknown[]; payload?: { events?: unknown[] } }
  /** 打桩 host:记录所有 req;byKind 决定回包(ok/失败/挂起)。 */
  function stub(args: { fail?: string; hold?: boolean } = {}) {
    const reqs: Sent[] = [];
    setIpcTransport((msg) => {
      const m = msg as Sent;
      if (m.t !== "req") return;
      reqs.push(m);
      if (args.hold) return; // 挂起:测并发/microtask 不重发
      const fail = args.fail === m.kind;
      setTimeout(() => handleHostResponse({ id: m.id!, ok: !fail, ...(fail ? { error: "host: 落盘失败" } : { value: true }) }), 0);
    });
    return reqs;
  }

  it("有 batch:只发一次 appendSync(剥本地 seq),microtask 不重发", async () => {
    const reqs = stub({ hold: true });
    const j = new ProxyJournal("s1");
    j.append({ kind: "message.user", sessionId: "s1", payload: { text: "a" } });
    j.append({ kind: "message.agent", sessionId: "s1", payload: { text: "b" } });
    const p = j.flushStrict(); // 取快照 → 发 appendSync
    await wait(10); // 让 scheduleFlush 的 microtask 跑完
    const appends = reqs.filter((r) => r.kind === "journal.appendSync");
    expect(appends).toHaveLength(1);
    expect(appends[0]!.payload!.events).toHaveLength(2);
    expect((appends[0]!.payload!.events![0] as { seq?: number }).seq).toBeUndefined(); // 权威 seq 由 gateway 分配
    expect(reqs.some((r) => r.kind === "journal.appendSync" && (r as Sent & { t: string }).t === "req")).toBe(true);
    handleHostResponse({ id: appends[0]!.id!, ok: true, value: true });
    await expect(p).resolves.toBeUndefined();
  });

  it("无 batch:发 journal.flushStrict(不带 events)", async () => {
    const reqs = stub();
    const j = new ProxyJournal("s1");
    await expect(j.flushStrict()).resolves.toBeUndefined();
    expect(reqs.filter((r) => r.kind === "journal.flushStrict")).toHaveLength(1);
    expect(reqs.some((r) => r.kind === "journal.appendSync")).toBe(false);
  });

  it("RPC reject:抛 journal flushStrict failed 且失败批保留(下次可重试)", async () => {
    const reqs = stub({ fail: "journal.appendSync" });
    const j = new ProxyJournal("s1");
    j.append({ kind: "message.user", sessionId: "s1", payload: { text: "keep" } });
    await expect(j.flushStrict()).rejects.toThrow(/journal flushStrict failed: .*落盘失败/);
    // 第 2 次:队列里的事件还在(未被丢),再发一次 appendSync
    const reqs2 = stub({ hold: true });
    const p = j.flushStrict();
    await wait(10);
    const again = reqs2.filter((r) => r.kind === "journal.appendSync");
    expect(again).toHaveLength(1);
    expect(again[0]!.payload!.events).toHaveLength(1);
    expect((again[0]!.payload!.events![0] as { payload?: { text?: string } }).payload?.text).toBe("keep");
    handleHostResponse({ id: again[0]!.id!, ok: true, value: true });
    await p;
  });

  it("flushStrict 路 reject:同样抛错(不静默)", async () => {
    stub({ fail: "journal.flushStrict" });
    const j = new ProxyJournal("s1");
    await expect(j.flushStrict()).rejects.toThrow(/journal flushStrict failed/);
  });

  it("host 通道不可用:立即抛错(不静默、不挂死)", async () => {
    setIpcTransport(null);
    const j = new ProxyJournal("s1");
    j.append({ kind: "message.user", sessionId: "s1", payload: { text: "x" } });
    await expect(j.flushStrict()).rejects.toThrow(/journal flushStrict failed/);
  });
});

describe("request 契约(RPC 应答通道)", () => {
  it("res ok:false → reject(错误串透传)", async () => {
    setIpcTransport((msg) => {
      const m = msg as { id?: number };
      setTimeout(() => handleHostResponse({ id: m.id!, ok: false, error: "boom" }), 0);
    });
    try {
      await expect(request("journal.flushStrict", {})).rejects.toThrow("boom");
    } finally {
      setIpcTransport(null);
    }
  });
});
