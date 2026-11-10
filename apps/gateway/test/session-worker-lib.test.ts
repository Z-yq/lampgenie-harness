/**
 * ProxyJournal 单测(会话 worker 库):本地副本 seq 单调/订阅派发/回声去重/幂等键跨源生效。
 * process.send 打桩(vitest 无 IPC 通道)——seed 走 request→host 回包注入。
 */
import { describe, it, expect, afterEach } from "vitest";
import { ProxyJournal, handleHostResponse, setIpcTransport } from "../src/session-worker-lib.js";
import type { JournalEvent } from "@lampgenie/core";

describe("ProxyJournal(本地副本读源)", () => {
  afterEach(() => { setIpcTransport(null); });

  function stubHost(seedEvents: JournalEvent[]): void {
    setIpcTransport((msg) => {
      const m = msg as { t: string; id?: number; kind?: string };
      if (m.t === "req" && m.kind === "journal.readSession") {
        // 微任务后回包(promise 落定)
        setTimeout(() => handleHostResponse({ id: m.id!, ok: true, value: seedEvents }), 0);
      }
    });
  }

  it("seed 拉取会话全量;append 本地 seq 单调续接;readSession/readAll 过滤;订阅派发", async () => {
    stubHost([
      { kind: "message.user", sessionId: "s1", payload: { text: "种子" }, seq: 0, time: 1 },
      { kind: "message.agent", sessionId: "s1", payload: { text: "芽" }, seq: 1, time: 2 },
    ]);
    const j = new ProxyJournal("s1");
    await j.seed();
    expect(j.readSession("s1")).toHaveLength(2);
    const ev = j.append({ kind: "message.user", sessionId: "s1", payload: { text: "新" } });
    expect(ev.seq).toBe(2); // 本地续接
    expect(j.readSession("s1")).toHaveLength(3);
    expect(j.readAll(2)).toHaveLength(1);
    let fired = 0;
    j.subscribe(() => fired++);
    j.append({ kind: "message.agent", sessionId: "s1", payload: { text: "再" } });
    expect(fired).toBe(1);
    expect(j.readSession("other")).toEqual([]);
  });

  it("catchUp 水位补拉(四轮复审 R4-1):种子(seq0-1)→窗口事件(seq2)按 sinceSeq=2 增量取回,不重不漏", async () => {
    const seedEvents = [
      { kind: "message.user", sessionId: "s1", payload: { text: "种子1" }, seq: 0, time: 1 },
      { kind: "message.agent", sessionId: "s1", payload: { text: "种子2" }, seq: 1, time: 2 },
    ];
    const windowEvent = { kind: "message.user", sessionId: "s1", payload: { text: "窗口steer" }, seq: 2, time: 3 };
    let phase = 0;
    setIpcTransport((msg) => {
      const m = msg as { t: string; id?: number; kind?: string; payload?: { sinceSeq?: number } };
      if (m.t !== "req") return;
      if (m.kind === "journal.readSession") {
        // 第一次(种子):回全量;第二次(catchUp,sinceSeq=2):只回窗口事件
        const evs = phase++ === 0 ? seedEvents : (m.payload?.sinceSeq === 2 ? [windowEvent] : []);
        setTimeout(() => handleHostResponse({ id: m.id!, ok: true, value: evs }), 0);
      }
    });
    const j = new ProxyJournal("s1");
    await j.seed();
    expect(j.readSession("s1")).toHaveLength(2);
    await j.catchUp();
    const texts = j.readSession("s1").map((e) => (e.payload as { text?: string }).text);
    expect(texts).toEqual(["种子1", "种子2", "窗口steer"]); // 补到、不重、序对
  });

  it("回声去重:自己 append 的事件被 gateway 推回时不双入", () => {
    const j = new ProxyJournal("s1");
    const ev = j.append({ kind: "message.user", sessionId: "s1", payload: { text: "回声" } });
    const before = j.readSession("s1").length;
    j.ingestRemote([{ ...ev }]); // gateway 原样推回
    expect(j.readSession("s1")).toHaveLength(before);
  });

  it("幂等键:种子里的键在本地 append 撞车时返回既有事件不再入账", async () => {
    stubHost([{ kind: "task.start", sessionId: "s1", payload: {}, seq: 0, time: 1, idempotencyKey: "task.x.start" }]);
    const j = new ProxyJournal("s1");
    await j.seed();
    const again = j.append({ kind: "task.start", sessionId: "s1", payload: {}, idempotencyKey: "task.x.start" });
    expect(again.seq).toBe(0); // 命中种子事件
    expect(j.readSession("s1")).toHaveLength(1);
  });
});
