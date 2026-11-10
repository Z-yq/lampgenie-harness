/**
 * session.history 游标分页(2026-10-22):长会话首开不全量拉历史的「向后翻页」通道。
 * 语义抄 ZCode conversationProjectionStore rowsRange(beforeRowId, limit):
 *  - beforeSeq + limit → seq < beforeSeq 的最后 limit 条(按 seq 升序);
 *  - hasMore = 还存在更早事件;nextBeforeSeq = 本页最小 seq(仅 hasMore=true 时给);
 *  - 游标必须严格推进(本页为空或本页最小 seq >= beforeSeq → hasMore:false 且无 nextBeforeSeq),防前端死循环。
 * 既有 sinceSeq 增量追平路径必须原样不回归(⑤)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayApp, type GatewayApp } from "../src/app.js";

const PORT = 7893;
const SID = "page-sess";
const OTHER = "page-other";
const TOTAL = 150;
const PAGE = 50;

let app: GatewayApp | null = null;
let journalDir = "";
let ws: WebSocket | null = null;
const inbox: Record<string, unknown>[] = [];

/** 每会话 seq 升序提取(把 result 帧里的 events 归一成一维 seq 数组)。 */
function seqsOf(msg: Record<string, unknown>): number[] {
  return (msg.events as { seq: number }[]).map((e) => e.seq);
}

async function ask(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cursor = inbox.length;
  ws!.send(JSON.stringify({ v: 1, type: "session.history", sessionId: SID, ...payload }));
  for (let i = 0; i < 100; i++) {
    const hit = inbox.slice(cursor).find((m) => m.type === "session.history.result");
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`session.history.result 超时(payload=${JSON.stringify(payload)})`);
}

beforeAll(async () => {
  journalDir = mkdtempSync(join(tmpdir(), "gh-histpaging-"));
  app = createGatewayApp({ port: PORT, journalDir });
  // 150 条同会话事件(夹一条别的会话事件,顺带证 sessionId 过滤不被分页破坏)。
  for (let i = 0; i < TOTAL; i++) {
    app.journal.append({ kind: "message.user", sessionId: SID, payload: { text: `msg-${i}` } });
    if (i === 0) app.journal.append({ kind: "message.user", sessionId: OTHER, payload: { text: "other" } });
  }
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on("message", (raw: Buffer) => inbox.push(JSON.parse(raw.toString())));
  await new Promise((r) => ws!.on("open", r));
}, 60_000);

afterAll(async () => {
  ws?.close();
  await app?.close();
  app = null;
  if (journalDir) rmSync(journalDir, { recursive: true, force: true });
});

describe("session.history 向后翻页(beforeSeq/limit/hasMore/nextBeforeSeq)", () => {
  it("①首屏 {limit:50} 返该会话末 50 条且按 seq 升序", async () => {
    const all = await ask({ sinceSeq: 0 });
    const allSeqs = seqsOf(all);
    expect(allSeqs.length, "该会话恰 150 条(不含 isOther 会话)").toBe(TOTAL);

    const first = await ask({ limit: PAGE });
    const seqs = seqsOf(first);
    expect(seqs.length).toBe(PAGE);
    expect(seqs).toEqual(allSeqs.slice(TOTAL - PAGE)); // 末 50 条
    expect([...seqs].sort((a, b) => a - b), "升序").toEqual(seqs);
    expect(first.hasMore, "还有更早 100 条").toBe(true);
    expect(first.nextBeforeSeq).toBe(seqs[0]); // 游标=本页最小 seq
    expect(first.nextBeforeSeq as number).toBeLessThan(Math.max(...seqs) + 1);
  });

  it("②带 beforeSeq=首屏最小 seq 再取一页:size 正确且 nextBeforeSeq 严格小于上一页最小值", async () => {
    const first = await ask({ limit: PAGE });
    const firstMin = Math.min(...seqsOf(first));
    const second = await ask({ limit: PAGE, beforeSeq: firstMin });
    const seqs = seqsOf(second);
    expect(seqs.length).toBe(PAGE);
    expect(Math.max(...seqs), "第二页全部早于第一页").toBeLessThan(firstMin);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(second.hasMore).toBe(true);
    expect(second.nextBeforeSeq as number).toBe(seqs[0]);
    expect(second.nextBeforeSeq as number, "游标严格推进").toBeLessThan(firstMin);
  });

  it("③连取三页:seq 无重复、每页升序且页间严格递退(全局单调)", async () => {
    const pages: number[][] = [];
    let cursor: number | undefined;
    for (let i = 0; i < 3; i++) {
      const res = await ask(cursor === undefined ? { limit: PAGE } : { limit: PAGE, beforeSeq: cursor });
      const seqs = seqsOf(res);
      expect(seqs.length).toBe(PAGE);
      expect([...seqs].sort((a, b) => a - b), `第 ${i + 1} 页升序`).toEqual(seqs);
      if (pages.length > 0) expect(Math.max(...seqs)).toBeLessThan(Math.min(...pages[pages.length - 1]!));
      pages.push(seqs);
      if (res.hasMore === true) cursor = res.nextBeforeSeq as number;
      else cursor = undefined;
    }
    const flat = pages.flat();
    expect(flat.length).toBe(PAGE * 3);
    expect(new Set(flat).size, "无重复 seq").toBe(flat.length);
  });

  it("④末页 hasMore=false 且无 nextBeforeSeq;beforeSeq=0 也判 false(游标不推进)", async () => {
    const first = await ask({ limit: PAGE });
    const second = await ask({ limit: PAGE, beforeSeq: Math.min(...seqsOf(first)) });
    const third = await ask({ limit: PAGE, beforeSeq: second.nextBeforeSeq as number });
    const seqs = seqsOf(third);
    expect(seqs.length).toBe(PAGE); // 150 = 50*3,末页正好 50 条
    expect(third.hasMore, "没有更早事件").toBe(false);
    expect(third.nextBeforeSeq, "hasMore=false 不给游标").toBeUndefined();

    const empty = await ask({ limit: PAGE, beforeSeq: 0 });
    expect(seqsOf(empty)).toEqual([]);
    expect(empty.hasMore).toBe(false);
    expect(empty.nextBeforeSeq).toBeUndefined();
  });

  it("⑤既有 sinceSeq 路径不回归:sinceSeq=0 仍返全量,sinceSeq=尾部水位仍返增量", async () => {
    const full = await ask({ sinceSeq: 0 });
    const fullSeqs = seqsOf(full);
    expect(fullSeqs.length, "全量路径条数=改动前(150)").toBe(TOTAL);
    expect(full.since).toBe(0);
    expect(full.hasMore, "全量路径不带分页字段").toBeUndefined();
    expect(full.nextBeforeSeq).toBeUndefined();

    const tail = await ask({ sinceSeq: fullSeqs[TOTAL - 10]! });
    expect(seqsOf(tail).length, "增量:从该 seq 起(含)共 10 条").toBe(10);
    expect(tail.since).toBe(fullSeqs[TOTAL - 10]);
  });
});
