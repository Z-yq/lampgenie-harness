import { describe, it, expect } from "vitest";
import {
  ANNOUNCE_KINDS,
  ANNOUNCE_TYPE,
  INVALID,
  announceEvent,
  announceKeyOf,
  hardCompactSeqOf,
  lastAnnounceOf,
  markAnnounced,
  shouldAnnounce,
  stableHash,
  type AnnounceEventLike,
} from "../src/agent/announce-once";

const SID = "s-announce";

type Payload = Record<string, unknown>;

/** 构造 journal 事件(结构子集;seq 单调)。 */
function ev(seq: number, kind: string, payload?: Payload, sessionId?: string): AnnounceEventLike {
  return { seq, kind, ...(sessionId !== undefined ? { sessionId } : {}), ...(payload !== undefined ? { payload } : {}) };
}

function announceEv(seq: number, key: string, at = 1000, sessionId = SID): AnnounceEventLike {
  return ev(seq, "custom", { type: ANNOUNCE_TYPE, announceKind: "system-section-update", key, at }, sessionId);
}

function compactEv(seq: number, summary: string | undefined, sessionId = SID): AnnounceEventLike {
  return ev(seq, "compact.done", summary === undefined ? { tail: [] } : { summary, tail: [] }, sessionId);
}

const HASH_DELTA = stableHash("[系统提示更新] agents-md 变更");
const HASH_OTHER = stableHash("[系统提示更新] memory revision 变更");

describe("ANNOUNCE_KINDS / 常量", () => {
  it("四种公告种类逐字固定(新增种类必须改常量而非传裸串)", () => {
    expect([...ANNOUNCE_KINDS]).toEqual([
      "system-section-update",
      "tool-activation",
      "model-switch",
      "config-change",
    ]);
  });

  it("journal 落账标记固定为 runtime.announce", () => {
    expect(ANNOUNCE_TYPE).toBe("runtime.announce");
    expect(INVALID).toBe("INVALID");
  });
});

describe("announceKeyOf", () => {
  it("key = kind:sha256(payloadHash).slice(0,16),长度与形状稳定", () => {
    const key = announceKeyOf("system-section-update", HASH_DELTA);
    expect(key).toMatch(/^system-section-update:[0-9a-f]{16}$/);
    expect(key.slice("system-section-update:".length)).toHaveLength(16);
  });

  it("确定性:同 kind+payloadHash 多次派生逐字相同", () => {
    expect(announceKeyOf("tool-activation", HASH_DELTA)).toBe(announceKeyOf("tool-activation", HASH_DELTA));
  });

  it("载荷不同 → key 不同;种类不同 → key 不同", () => {
    expect(announceKeyOf("system-section-update", HASH_DELTA)).not.toBe(announceKeyOf("system-section-update", HASH_OTHER));
    expect(announceKeyOf("system-section-update", HASH_DELTA)).not.toBe(announceKeyOf("model-switch", HASH_DELTA));
  });

  it("未知 kind → INVALID(不 throw)", () => {
    expect(announceKeyOf("unknown-kind", HASH_DELTA)).toBe(INVALID);
    expect(announceKeyOf("", HASH_DELTA)).toBe(INVALID);
  });

  it("空 payloadHash → INVALID", () => {
    expect(announceKeyOf("config-change", "")).toBe(INVALID);
    expect(announceKeyOf("config-change", undefined as unknown as string)).toBe(INVALID);
  });

  it("非字符串输入不 throw,统一 INVALID", () => {
    expect(announceKeyOf(undefined as unknown as string, undefined as unknown as string)).toBe(INVALID);
    expect(announceKeyOf(42 as unknown as string, 42 as unknown as string)).toBe(INVALID);
  });
});

describe("shouldAnnounce(A/B/C/D/E/F)", () => {
  it("A) 首次(无任何公告)→ first / announce=true", () => {
    const r = shouldAnnounce({ events: [], sessionId: SID, kind: "system-section-update", payloadHash: HASH_DELTA });
    expect(r).toMatchObject({ ok: true, announce: true, reason: "first" });
    expect(r.key).toBe(announceKeyOf("system-section-update", HASH_DELTA));
  });

  it("B) 边界之后已公告 → already-announced / announce=false,仍返回 key", () => {
    const key = announceKeyOf("system-section-update", HASH_DELTA);
    const events = [announceEv(3, key)];
    const r = shouldAnnounce({ events, sessionId: SID, kind: "system-section-update", payloadHash: HASH_DELTA });
    expect(r).toMatchObject({ ok: true, announce: false, reason: "already-announced", key });
  });

  it("C) 中间出现真压缩边界 → after-compact / announce=true", () => {
    const key = announceKeyOf("system-section-update", HASH_DELTA);
    const events = [announceEv(3, key), compactEv(5, "会话摘要")];
    const r = shouldAnnounce({ events, sessionId: SID, kind: "system-section-update", payloadHash: HASH_DELTA });
    expect(r).toMatchObject({ ok: true, announce: true, reason: "after-compact", key });
  });

  it("D) 无 summary 的旧 compact.done 不重置公告生命 → 仍 already-announced", () => {
    const key = announceKeyOf("system-section-update", HASH_DELTA);
    const events = [announceEv(3, key), compactEv(4, undefined), compactEv(5, "   ")];
    const r = shouldAnnounce({ events, sessionId: SID, kind: "system-section-update", payloadHash: HASH_DELTA });
    expect(r).toMatchObject({ ok: true, announce: false, reason: "already-announced" });
    expect(hardCompactSeqOf(events, SID)).toBe(0);
  });

  it("E) force=true 覆盖已公告判定 → forced / announce=true 且 key 不变", () => {
    const key = announceKeyOf("model-switch", HASH_DELTA);
    const events = [announceEv(3, key)];
    const r = shouldAnnounce({ events, sessionId: SID, kind: "model-switch", payloadHash: HASH_DELTA, force: true });
    expect(r).toMatchObject({ ok: true, announce: true, reason: "forced", key });
  });

  it("F) 未知 kind → INVALID / ok=false,不公告", () => {
    const r = shouldAnnounce({ events: [], sessionId: SID, kind: "bogus", payloadHash: HASH_DELTA });
    expect(r.ok).toBe(false);
    expect(r.announce).toBe(false);
    expect(r.key).toBe(INVALID);
    expect(r.reason).toBe("invalid-kind");
  });

  it("空 payloadHash → INVALID / invalid-payload", () => {
    const r = shouldAnnounce({ events: [], sessionId: SID, kind: "config-change", payloadHash: "" });
    expect(r).toMatchObject({ ok: false, announce: false, key: INVALID, reason: "invalid-payload" });
  });

  it("不同载荷 = 不同 key → 各自 first,互不影响", () => {
    const keyA = announceKeyOf("system-section-update", HASH_DELTA);
    const events = [announceEv(3, keyA)];
    const r = shouldAnnounce({ events, sessionId: SID, kind: "system-section-update", payloadHash: HASH_OTHER });
    expect(r).toMatchObject({ ok: true, announce: true, reason: "first" });
  });

  it("会话隔离:别的 session 公告过不影响本 session", () => {
    const key = announceKeyOf("config-change", HASH_DELTA);
    const events = [announceEv(3, key, 1000, "other-session")];
    const r = shouldAnnounce({ events, sessionId: SID, kind: "config-change", payloadHash: HASH_DELTA });
    expect(r).toMatchObject({ ok: true, announce: true, reason: "first" });
  });

  it("压缩后再公告一次之后又回到 already-announced(闭环)", () => {
    const key = announceKeyOf("system-section-update", HASH_DELTA);
    const input = { sessionId: SID, kind: "system-section-update", payloadHash: HASH_DELTA } as const;
    const events: AnnounceEventLike[] = [announceEv(3, key), compactEv(5, "摘要")];
    const after = shouldAnnounce({ ...input, events });
    expect(after.reason).toBe("after-compact");
    const appended = markAnnounced(events, SID, { kind: "system-section-update", key, at: 2000 });
    expect(appended).toHaveLength(1);
    const next = shouldAnnounce({ ...input, events: [...events, ...appended] });
    expect(next).toMatchObject({ ok: true, announce: false, reason: "already-announced" });
  });

  it("不可变:调用不改写 events(逐字 JSON 快照不变)", () => {
    const key = announceKeyOf("system-section-update", HASH_DELTA);
    const events = [announceEv(3, key), compactEv(5, "摘要")];
    const snapshot = JSON.stringify(events);
    shouldAnnounce({ events, sessionId: SID, kind: "system-section-update", payloadHash: HASH_DELTA });
    expect(JSON.stringify(events)).toBe(snapshot);
  });

  it("确定性:同输入重复调用结果逐字相同", () => {
    const events = [announceEv(3, announceKeyOf("tool-activation", HASH_DELTA))];
    const input = { events, sessionId: SID, kind: "tool-activation", payloadHash: HASH_DELTA };
    expect(shouldAnnounce(input)).toEqual(shouldAnnounce(input));
  });
});

describe("lastAnnounceOf", () => {
  it("无公告 → null", () => {
    expect(lastAnnounceOf([], SID, announceKeyOf("model-switch", HASH_DELTA))).toBeNull();
  });

  it("多条同 key 公告 → 取最后一条(seq/at)", () => {
    const key = announceKeyOf("model-switch", HASH_DELTA);
    const got = lastAnnounceOf([announceEv(3, key, 111), announceEv(9, key, 999)], SID, key);
    expect(got).toEqual({ at: 999, seq: 9, key });
  });

  it("边界之前的公告不算(压缩已抹掉)→ null", () => {
    const key = announceKeyOf("model-switch", HASH_DELTA);
    expect(lastAnnounceOf([announceEv(3, key), compactEv(6, "摘要")], SID, key)).toBeNull();
  });

  it("忽略其他 key / 其他 session / 非 runtime.announce 的 custom", () => {
    const key = announceKeyOf("model-switch", HASH_DELTA);
    const events = [
      annouceOther(2, "another-key"),
      announceEv(3, key, 5, "other-session"),
      ev(4, "custom", { type: "something.else", key }, SID),
      ev(5, "message.user", { text: "hi" }, SID),
    ];
    expect(lastAnnounceOf(events, SID, key)).toBeNull();
  });

  it("空 key / INVALID key → null(不 throw)", () => {
    expect(lastAnnounceOf([announceEv(3, "x")], SID, "")).toBeNull();
    expect(lastAnnounceOf([announceEv(3, "x")], SID, INVALID)).toBeNull();
  });

  it("缺 at 字段时回落 0(坏数据不污染判定)", () => {
    const key = "model-switch:abcdef0123456789";
    const got = lastAnnounceOf([ev(2, "custom", { type: ANNOUNCE_TYPE, key }, SID)], SID, key);
    expect(got).toEqual({ at: 0, seq: 2, key });
  });
});

describe("announceEvent / markAnnounced", () => {
  it("announceEvent 产出稳定 custom 结构(type/announceKind/key/at)", () => {
    const out = announceEvent({ kind: "config-change", key: "config-change:0011223344556677", at: 12345 });
    expect(out.kind).toBe("custom");
    expect(out.payload).toEqual({
      type: ANNOUNCE_TYPE,
      announceKind: "config-change",
      key: "config-change:0011223344556677",
      at: 12345,
    });
  });

  it("announceEvent summary 截断到 200 字;无 summary 时不留空字段", () => {
    const long = announceEvent({ kind: "config-change", key: "k", at: 1, summary: "x".repeat(500) });
    expect((long.payload.summary ?? "").length).toBe(200);
    const empty = announceEvent({ kind: "config-change", key: "k", at: 1 });
    expect("summary" in empty.payload).toBe(false);
  });

  it("announceEvent 非法输入不 throw(key 空 → INVALID,at 非数 → 0)", () => {
    const out = announceEvent({ kind: "bogus", key: "", at: Number.NaN });
    expect(out.payload.key).toBe(INVALID);
    expect(out.payload.at).toBe(0);
    expect(out.payload.announceKind).toBe("bogus");
  });

  it("markAnnounced 只返回追加事件、不改入参,seq = max+1", () => {
    const events = [ev(3, "message.user", { text: "a" }, SID), ev(7, "message.user", { text: "b" }, SID)];
    const snapshot = JSON.stringify(events);
    const appended = markAnnounced(events, SID, { kind: "system-section-update", key: "k:1", at: 42 });
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ kind: "custom", sessionId: SID, seq: 8 });
    expect((appended[0]!.payload as { at: number }).at).toBe(42);
    expect(JSON.stringify(events)).toBe(snapshot);
  });

  it("markAnnounced:边界之后已有同 key 公告 → 返回空数组(同一步幂等)", () => {
    const key = announceKeyOf("tool-activation", HASH_DELTA);
    expect(markAnnounced([announceEv(3, key)], SID, { kind: "tool-activation", key, at: 9 })).toEqual([]);
  });

  it("markAnnounced:边界之前有同 key 公告(已被压缩)→ 允许再落一条", () => {
    const key = announceKeyOf("tool-activation", HASH_DELTA);
    const appended = markAnnounced([announceEv(3, key), compactEv(4, "摘要")], SID, { kind: "tool-activation", key, at: 9 });
    expect(appended).toHaveLength(1);
    expect(appended[0]!.seq).toBe(5);
  });

  it("markAnnounced:INVALID/空 key → 不落(返回空数组)", () => {
    expect(markAnnounced([], SID, { kind: "bogus", key: INVALID, at: 1 })).toEqual([]);
    expect(markAnnounced([], SID, { kind: "bogus", key: "", at: 1 })).toEqual([]);
  });

  it("落账后 shouldAnnounce 立即转为 already-announced(落账→判定闭环)", () => {
    const key = announceKeyOf("config-change", HASH_DELTA);
    const appended = markAnnounced([], SID, { kind: "config-change", key, at: 1 });
    const r = shouldAnnounce({
      events: appended,
      sessionId: SID,
      kind: "config-change",
      payloadHash: HASH_DELTA,
    });
    expect(r.reason).toBe("already-announced");
  });
});

/** 其他 key 的公告事件(构造用)。 */
function annouceOther(seq: number, key: string): AnnounceEventLike {
  return ev(seq, "custom", { type: ANNOUNCE_TYPE, announceKind: "model-switch", key, at: 1 }, SID);
}
