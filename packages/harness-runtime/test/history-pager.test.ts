/**
 * session.history 分页纯逻辑:rowId/pageHistory/DeltaRing/validateHistoryCursor。
 * 覆盖:分页边界、rowId 唯一、beforeSeq 游标推进、ring 容量与不连续、epoch 校验、空会话、
 * limit 钳制、不可变、确定性;并打印真实探针 A-E 的中间结果(A-D 在本文件,E 依赖 WS 路径见 gateway 测试)。
 */
import { describe, it, expect } from "vitest";
import {
  rowIdOf,
  pageHistory,
  DeltaRing,
  validateHistoryCursor,
  type HistoryRow,
  type SessionEventLike,
} from "../src/session/history-pager.ts";

const SID = "sess-1";

function ev(seq: number, sessionId = SID, kind = "message.user"): SessionEventLike {
  return { seq, kind, time: 1_000 + seq, sessionId, payload: { seq } };
}

function evs(n: number, sessionId = SID): SessionEventLike[] {
  return Array.from({ length: n }, (_, i) => ev(i + 1, sessionId));
}

function row(seq: number, sessionId = SID): HistoryRow {
  return { rowId: rowIdOf(sessionId, seq), seq, kind: "message.user", time: 1_000 + seq, payload: { seq } };
}

function rows(...seqs: number[]): HistoryRow[] {
  return seqs.map((seq) => row(seq));
}

const seqsOf = (page: { rows: HistoryRow[] }): number[] => page.rows.map((r) => r.seq);

describe("rowIdOf", () => {
  it("稳定且唯一:`sessionId:seq`", () => {
    expect(rowIdOf(SID, 7)).toBe("sess-1:7");
    expect(rowIdOf("a:b", 1)).toBe("a:b:1");
    const page = pageHistory(evs(50), { sessionId: SID, limit: 50 });
    const ids = page.rows.map((r) => r.rowId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("pageHistory 分页边界", () => {
  it("空会话:rows=[],atRevision=0,无 nextBeforeSeq", () => {
    const page = pageHistory([], { sessionId: SID, limit: 10 });
    expect(page.rows).toEqual([]);
    expect(page.atRevision).toBe(0);
    expect(page.nextBeforeSeq).toBeUndefined();
  });

  it("10 事件 limit 3:末 3 条 + nextBeforeSeq=本页最小 + atRevision=会话水位", () => {
    const page = pageHistory(evs(10), { sessionId: SID, limit: 3 });
    expect(seqsOf(page)).toEqual([8, 9, 10]);
    expect(page.nextBeforeSeq).toBe(8);
    expect(page.atRevision).toBe(10);
  });

  it("beforeSeq 游标逐页推进到首页,最后无 nextBeforeSeq", () => {
    const events = evs(10);
    const p1 = pageHistory(events, { sessionId: SID, limit: 3 });
    const p2 = pageHistory(events, { sessionId: SID, limit: 3, beforeSeq: p1.nextBeforeSeq });
    expect(seqsOf(p2)).toEqual([5, 6, 7]);
    expect(p2.nextBeforeSeq).toBe(5);
    const p3 = pageHistory(events, { sessionId: SID, limit: 3, beforeSeq: p2.nextBeforeSeq });
    expect(seqsOf(p3)).toEqual([2, 3, 4]);
    expect(p3.nextBeforeSeq).toBe(2);
    const p4 = pageHistory(events, { sessionId: SID, limit: 3, beforeSeq: p3.nextBeforeSeq });
    expect(seqsOf(p4)).toEqual([1]);
    expect(p4.nextBeforeSeq).toBeUndefined();
 // atRevision 恒为会话水位,不随翻到哪一页变化
    for (const p of [p1, p2, p3, p4]) expect(p.atRevision).toBe(10);
  });

  it("beforeSeq=0 返回空页且不给游标(防前端 loop)", () => {
    const page = pageHistory(evs(10), { sessionId: SID, limit: 3, beforeSeq: 0 });
    expect(page.rows).toEqual([]);
    expect(page.nextBeforeSeq).toBeUndefined();
  });

  it("beforeSeq 落在稀疏 seq 上:只取严格更早的行", () => {
    const events = [ev(10), ev(20), ev(30), ev(40)];
    const page = pageHistory(events, { sessionId: SID, limit: 10, beforeSeq: 30 });
    expect(seqsOf(page)).toEqual([10, 20]);
    expect(page.nextBeforeSeq).toBeUndefined();
  });

  it("limit 钳制:[1,2000],非整数向下取整,非法回退 500", () => {
    expect(pageHistory(evs(5), { sessionId: SID, limit: 0 }).rows.length).toBe(1);
    expect(pageHistory(evs(5), { sessionId: SID, limit: -3 }).rows.length).toBe(1);
    expect(pageHistory(evs(5), { sessionId: SID, limit: 1.9 }).rows.length).toBe(1);
    expect(pageHistory(evs(5), { sessionId: SID, limit: Number.NaN }).rows.length).toBe(5);
    expect(pageHistory(evs(5), { sessionId: SID }).rows.length).toBe(5);
    expect(pageHistory(evs(2500), { sessionId: SID, limit: 99_999 }).rows.length).toBe(2000);
  });

  it("缺省 limit=500", () => {
    expect(pageHistory(evs(600), { sessionId: SID }).rows.length).toBe(500);
  });

  it("只保留指定会话的行,rowId 用请求 sessionId", () => {
    const mixed = [...evs(3), ...evs(2, "other")];
    const page = pageHistory(mixed, { sessionId: SID, limit: 10 });
    expect(seqsOf(page)).toEqual([1, 2, 3]);
    expect(page.rows.every((r) => r.rowId.startsWith(`${SID}:`))).toBe(true);
    expect(page.atRevision).toBe(3);
  });

  it("输入无序时按 seq 升序输出(确定性);不改动入参", () => {
    const input = [ev(3), ev(1), ev(2)];
    const snapshot = JSON.stringify(input);
    const page = pageHistory(input, { sessionId: SID, limit: 10 });
    expect(seqsOf(page)).toEqual([1, 2, 3]);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("kind/time/payload 映射;缺字段回退 custom/0", () => {
    const page = pageHistory([{ seq: 1, sessionId: SID }, { seq: 2, sessionId: SID, kind: "turn.end", time: 42, payload: { a: 1 } }], { sessionId: SID, limit: 10 });
    expect(page.rows[0]).toEqual({ rowId: `${SID}:1`, seq: 1, kind: "custom", time: 0, payload: undefined });
    expect(page.rows[1]).toEqual({ rowId: `${SID}:2`, seq: 2, kind: "turn.end", time: 42, payload: { a: 1 } });
  });

  it("确定性:同输入两次调用深度相等", () => {
    const events = evs(40);
    const a = pageHistory(events, { sessionId: SID, limit: 7, beforeSeq: 30 });
    const b = pageHistory(events, { sessionId: SID, limit: 7, beforeSeq: 30 });
    expect(a).toEqual(b);
  });
});

describe("DeltaRing", () => {
  it("push 两次后 replaySince(旧水位) 回增量,当前水位回空数组", () => {
    const ring = new DeltaRing(200);
    ring.push(SID, rows(8, 9, 10), 10);
    ring.push(SID, rows(11, 12), 12);
    expect(ring.replaySince(SID, 10)?.map((r) => r.seq)).toEqual([11, 12]);
    expect(ring.replaySince(SID, 12)).toEqual([]);
  });

  it("越界/不连续/未知会话 → null(不可增量)", () => {
    const ring = new DeltaRing(200);
    ring.push(SID, rows(11, 12), 12);
    expect(ring.replaySince(SID, 10)).toBeNull(); // 没有 revision=10 的边界(不连续)
    expect(ring.replaySince(SID, 99)).toBeNull(); // 超出当前水位
    expect(ring.replaySince("nope", 12)).toBeNull(); // 未知会话
    expect(ring.replaySince(SID, Number.NaN)).toBeNull();
  });

  it("容量淘汰:老批次被挤掉后其边界不可回放", () => {
    const ring = new DeltaRing(3);
    ring.push(SID, rows(1, 2), 2);
    ring.push(SID, rows(3, 4), 4);
    expect(ring.stats().rows).toBeLessThanOrEqual(3);
    expect(ring.replaySince(SID, 2)).toBeNull();
    expect(ring.replaySince(SID, 4)).toEqual([]);
  });

  it("单批次超容量时裁掉最旧行,边界保持不变", () => {
    const ring = new DeltaRing(2);
    ring.push(SID, rows(1, 2, 3), 3);
    expect(ring.stats().rows).toBe(2);
    expect(ring.replaySince(SID, 3)).toEqual([]);
  });

  it("同 revision 二次 push 合并(翻更早页)且回放按 seq>revision 过滤边界行", () => {
    const ring = new DeltaRing(200);
    ring.push(SID, rows(8, 9, 10), 10);
    ring.push(SID, rows(5, 6, 7), 10);
    expect(ring.stats().revisions).toBe(1);
    expect(ring.replaySince(SID, 10)).toEqual([]);
    ring.push(SID, rows(10, 11, 12), 12);
    expect(ring.replaySince(SID, 10)?.map((r) => r.seq)).toEqual([11, 12]);
  });

  it("reset 会话 / 全量,stats 形态正确", () => {
    const ring = new DeltaRing(50);
    ring.push(SID, rows(1), 1);
    ring.push("s2", rows(2), 2);
    expect(ring.stats()).toEqual({ sessions: 2, rows: 2, maxRows: 50, revisions: 2 });
    ring.reset(SID);
    expect(ring.replaySince(SID, 1)).toBeNull();
    expect(ring.stats().sessions).toBe(1);
    ring.reset();
    expect(ring.stats()).toEqual({ sessions: 0, rows: 0, maxRows: 50, revisions: 0 });
  });

  it("非法入参不抛错(纯函数容错)", () => {
    const ring = new DeltaRing(Number.NaN);
    expect(() => ring.push("", rows(1), 1)).not.toThrow();
    expect(() => ring.push(SID, rows(1), Number.NaN)).not.toThrow();
    expect(() => ring.push(SID, null as unknown as HistoryRow[], 1)).not.toThrow();
    expect(ring.replaySince("", 1)).toBeNull(); // 空 sessionId 被忽略,未登记
    expect(ring.replaySince(SID, 1)).toEqual([]); // 空页仍建立边界(可判「已追平」)
    expect(ring.stats().maxRows).toBe(200);
  });
});

describe("validateHistoryCursor", () => {
  const ctx = { currentRevision: 10, currentEpoch: 111, canReplay: (r: number) => r === 10 };

  it("无游标 → full/no-cursor", () => {
    expect(validateHistoryCursor({}, ctx)).toEqual({ mode: "full", reason: "no-cursor" });
    expect(validateHistoryCursor({ atLogEpoch: 111 }, ctx)).toEqual({ mode: "full", reason: "no-cursor" });
  });

  it("epoch 不匹配 → full/epoch-mismatch(网关重启/journal 重载)", () => {
    expect(validateHistoryCursor({ atRevision: 10, atLogEpoch: 99 }, ctx)).toEqual({ mode: "full", reason: "epoch-mismatch" });
  });

  it("atRevision 超过当前水位 → full/ring-miss", () => {
    expect(validateHistoryCursor({ atRevision: 11, atLogEpoch: 111 }, ctx)).toEqual({ mode: "full", reason: "ring-miss" });
  });

  it("ring 可覆盖 → delta/ok;不可覆盖 → full/ring-miss", () => {
    expect(validateHistoryCursor({ atRevision: 10, atLogEpoch: 111 }, ctx)).toEqual({ mode: "delta", reason: "ok" });
    expect(validateHistoryCursor({ atRevision: 8 }, ctx)).toEqual({ mode: "full", reason: "ring-miss" });
    expect(validateHistoryCursor({ atRevision: 10 }, { currentRevision: 10, currentEpoch: 111 })).toEqual({ mode: "full", reason: "ring-miss" });
  });

  it("不修改入参、确定性", () => {
    const cursor = { atRevision: 10, atLogEpoch: 111 };
    const snapshot = JSON.stringify(cursor);
    expect(validateHistoryCursor(cursor, ctx)).toEqual(validateHistoryCursor(cursor, ctx));
    expect(JSON.stringify(cursor)).toBe(snapshot);
  });
});

describe("真实探针 A-E(runtime 侧,A-D)", () => {
  it("探针 A:10 事件 limit 3", () => {
    const page = pageHistory(evs(10), { sessionId: SID, limit: 3 });
    console.log("[probe A]", JSON.stringify({ rows: seqsOf(page), nextBeforeSeq: page.nextBeforeSeq, atRevision: page.atRevision }));
    expect(seqsOf(page)).toEqual([8, 9, 10]);
    expect(page.nextBeforeSeq).toBe(8);
    expect(page.atRevision).toBe(10);
  });

  it("探针 B:ring push 后 replaySince 回增量,越界 revision → null", () => {
    const ring = new DeltaRing(200);
    ring.push(SID, rows(8, 9, 10), 10);
    ring.push(SID, rows(11, 12), 12);
    const delta = ring.replaySince(SID, 10);
    const over = ring.replaySince(SID, 99);
    console.log("[probe B]", JSON.stringify({ delta: delta?.map((r) => r.seq) ?? null, over }));
    expect(delta?.map((r) => r.seq)).toEqual([11, 12]);
    expect(over).toBeNull();
  });

  it("探针 C:epoch 不匹配 → full/epoch-mismatch", () => {
    const verdict = validateHistoryCursor({ atRevision: 10, atLogEpoch: 111 - 1 }, { currentRevision: 12, currentEpoch: 111, canReplay: () => true });
    console.log("[probe C]", JSON.stringify(verdict));
    expect(verdict).toEqual({ mode: "full", reason: "epoch-mismatch" });
  });

  it("探针 D:无 cursor → full/no-cursor", () => {
    const verdict = validateHistoryCursor({}, { currentRevision: 12, currentEpoch: 111, canReplay: () => true });
    console.log("[probe D]", JSON.stringify(verdict));
    expect(verdict).toEqual({ mode: "full", reason: "no-cursor" });
  });
});
