/**
 * 服务端接入:session.history 分页路径的 atRevision/atLogEpoch 游标 → delta / reset,
 * 以及旧 sinceSeq 流式路径逐字不变(探针 E)。协议层同时验证新可选字段可被解析。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parseClientMessage } from "@lampgenie/protocol";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { NodeRegistry } from "../src/nodes.js";
import { MemoryJournal } from "@lampgenie/core";
import WebSocket from "ws";

const PORT = 7896;
const SID = "m181-sess";
let journal: MemoryJournal;
let srv: { close: () => Promise<void> };
let ws: WebSocket;
const inbox: Record<string, unknown>[] = [];

async function ask(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cursor = inbox.length;
  ws.send(JSON.stringify({ v: 1, type: "session.history", sessionId: SID, ...payload }));
  for (let i = 0; i < 150; i++) {
    const hit = inbox.slice(cursor).find((m) => m.type === "session.history.result");
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`session.history.result 超时(${JSON.stringify(payload)})`);
}

const seqsOf = (msg: Record<string, unknown>): number[] => (msg.events as { seq: number }[]).map((e) => e.seq);

beforeAll(async () => {
  journal = new MemoryJournal();
  for (let i = 0; i < 10; i++) journal.append({ kind: "message.user", sessionId: SID, payload: { text: `m-${i}` } });
  srv = startGatewayServer({ port: PORT, taskManager: new TaskSupervisor(), journal, nodes: new NodeRegistry() });
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on("message", (raw: Buffer) => inbox.push(JSON.parse(raw.toString())));
  await new Promise((r) => ws.on("open", r));
});

afterAll(async () => {
  ws?.close();
  await srv?.close();
});

describe("协议:session.history 游标字段", () => {
  it("atRevision/atLogEpoch 可解析,负值拒收", () => {
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "session.history", sessionId: "s", atRevision: 3, atLogEpoch: 9 }))?.type).toBe("session.history");
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "session.history", sessionId: "s", atRevision: -1 }))).toBeNull();
  });
});

describe("session.history 分页 + delta/reset", () => {
  it("无游标整页:末 3 条 + hasMore/nextBeforeSeq/atRevision/atLogEpoch,事件保留旧形状", async () => {
    const res = await ask({ limit: 3 });
    expect(seqsOf(res)).toEqual([7, 8, 9]);
    expect(res.hasMore).toBe(true);
    expect(res.nextBeforeSeq).toBe(7);
    expect(res.atRevision).toBe(9);
    expect(typeof res.atLogEpoch, "epoch 回包").toBe("number");
    expect(res.delta).toBeUndefined();
    expect(res.reset).toBeUndefined();
 // 整页 events 仍是 journal 原事件(sessionId 在、无 rowId)——老面板逐字兼容
    expect((res.events as { sessionId?: string }[])[0]?.sessionId).toBe(SID);
    expect((res.events as { rowId?: string }[])[0]?.rowId).toBeUndefined();
  });

  it("游标命中 ring → 只回增量(delta:true),不重复整页", async () => {
    const full = await ask({ limit: 3 });
    journal.append({ kind: "message.user", sessionId: SID, payload: { text: "m-10" } });
    journal.append({ kind: "message.user", sessionId: SID, payload: { text: "m-11" } });
    const res = await ask({ limit: 3, atRevision: full.atRevision, atLogEpoch: full.atLogEpoch });
    console.log("[probe E1 delta]", JSON.stringify({ delta: res.delta, seqs: seqsOf(res), atRevision: res.atRevision, atLogEpoch: res.atLogEpoch }));
    expect(res.delta).toBe(true);
    expect(seqsOf(res)).toEqual([10, 11]);
    expect((res.events as { rowId?: string }[])[0]?.rowId).toBe(`${SID}:10`);
    expect(res.atRevision).toBe(11);
    expect(res.hasMore).toBeUndefined();
  });

  it("已追平(游标=当前水位)→ delta:true 且空增量", async () => {
    const tail = await ask({ limit: 3 });
    const res = await ask({ limit: 3, atRevision: tail.atRevision, atLogEpoch: tail.atLogEpoch });
    expect(res.delta).toBe(true);
    expect(seqsOf(res)).toEqual([]);
  });

  it("epoch 不匹配 → 整页 + reset:true(网关重启/journal 重载语义)", async () => {
    const base = await ask({ limit: 3 });
    const res = await ask({ limit: 3, atRevision: base.atRevision, atLogEpoch: (base.atLogEpoch as number) - 1 });
    console.log("[probe E2 reset]", JSON.stringify({ reset: res.reset, delta: res.delta, seqs: seqsOf(res) }));
    expect(res.reset).toBe(true);
    expect(res.delta).toBeUndefined();
    expect(seqsOf(res)).toEqual([9, 10, 11]);
    expect(res.atRevision).toBe(11);
  });

  it("revision 不是 ring 边界 → 整页 + reset:true(ring-miss)", async () => {
    const base = await ask({ limit: 3 });
    const res = await ask({ limit: 3, atRevision: 1, atLogEpoch: base.atLogEpoch });
    expect(res.reset).toBe(true);
    expect(seqsOf(res)).toEqual([9, 10, 11]);
  });

  it("旧 sinceSeq 路径逐字不变(探针 E:字段集合无新增)", async () => {
    const res = await ask({ sinceSeq: 0 });
    console.log("[probe E legacy]", JSON.stringify({ count: seqsOf(res).length, since: res.since, hasMore: res.hasMore, atRevision: res.atRevision, delta: res.delta, reset: res.reset }));
    expect(seqsOf(res).length).toBe(12);
    expect(res.since).toBe(0);
    expect(res.hasMore).toBeUndefined();
    expect(res.nextBeforeSeq).toBeUndefined();
    expect(res.atRevision).toBeUndefined();
    expect(res.atLogEpoch).toBeUndefined();
    expect(res.delta).toBeUndefined();
    expect(res.reset).toBeUndefined();
  });
});
