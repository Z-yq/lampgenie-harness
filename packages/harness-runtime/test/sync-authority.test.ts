/**
 * 同步权威协议(#113)纯逻辑:事件接受三态分流 / owner 丢弃 / 水位 / 四段迁移 / 订阅脏位 /
 * 追平超时 / 代理放行 / 响应水位头。全部固定数据,不碰文件、不读真实时钟。
 */
import { describe, expect, it } from "vitest";
import {
  MIGRATE_PHASES,
  acceptEvent,
  awaitCatchup,
  emptyState,
  migrate,
  proxyAllowed,
  responseWatermark,
  subscribeThenRead,
  watermarkFor,
} from "../src/agent/sync-authority.ts";
import type { AuthorityEvent, SyncState } from "../src/agent/sync-authority.ts";

const T0 = 1_700_000_000_000;
const AGG = "agg-1";
const O1 = "owner-1";
const O2 = "owner-2";

function ev(over: Partial<AuthorityEvent> = {}): AuthorityEvent {
  return {
    aggregateId: AGG,
    seq: 1,
    ownerId: O1,
    payloadHash: "h1",
    at: T0,
    ...over,
  };
}

/** 依次接受一串事件,返回最终状态(任一被拒就抛,便于在用例里就地断言)。 */
function seed(...events: AuthorityEvent[]): SyncState {
  let state = emptyState();
  for (const event of events) {
    const result = acceptEvent(state, event);
    expect(result.code).toBe("SYNC_ACCEPTED");
    state = result.state;
  }
  return state;
}

describe("acceptEvent / emptyState", () => {
  it("emptyState 每次返回新的空结构", () => {
    const a = emptyState();
    const b = emptyState();
    expect(a).toEqual({ aggregates: {}, owners: {} });
    expect(a).not.toBe(b);
    expect(a.aggregates).not.toBe(b.aggregates);
  });

  it("aggregateId 为空 → SYNC_INVALID", () => {
    const state = emptyState();
    expect(acceptEvent(state, ev({ aggregateId: "" })).code).toBe("SYNC_INVALID");
    expect(acceptEvent(state, ev({ aggregateId: "   " })).code).toBe("SYNC_INVALID");
  });

  it("seq 非正整数 → SYNC_INVALID", () => {
    const state = emptyState();
    for (const seq of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(acceptEvent(state, ev({ seq })).code).toBe("SYNC_INVALID");
    }
  });

  it("ownerId 为空 → SYNC_INVALID", () => {
    expect(acceptEvent(emptyState(), ev({ ownerId: "" })).code).toBe("SYNC_INVALID");
  });

  it("payloadHash 为空 → SYNC_INVALID", () => {
    expect(acceptEvent(emptyState(), ev({ payloadHash: "" })).code).toBe("SYNC_INVALID");
  });

  it("at 非有限数 → SYNC_INVALID", () => {
    expect(acceptEvent(emptyState(), ev({ at: Number.NaN })).code).toBe("SYNC_INVALID");
    expect(acceptEvent(emptyState(), ev({ at: Number.POSITIVE_INFINITY })).code).toBe("SYNC_INVALID");
  });

  it("非法事件不改状态且返回入参 state 本身", () => {
    const state = emptyState();
    const out = acceptEvent(state, ev({ seq: 0 }));
    expect(out.code).toBe("SYNC_INVALID");
    expect(out.state).toBe(state);
    expect(state.aggregates).toEqual({});
  });

  it("首次接受 → SYNC_ACCEPTED,水位=seq,事件一条", () => {
    const out = acceptEvent(emptyState(), ev({ seq: 3 }));
    expect(out.code).toBe("SYNC_ACCEPTED");
    const agg = out.state.aggregates[AGG];
    expect(agg?.ownerId).toBe(O1);
    expect(agg?.watermark).toBe(3);
    expect(agg?.events.map((e) => e.seq)).toEqual([3]);
  });

  it("首次接受登记 owner since=at 且不修改入参状态", () => {
    const state = emptyState();
    const out = acceptEvent(state, ev({ seq: 1, at: T0 }));
    expect(out.state).not.toBe(state);
    expect(out.state.owners[O1]).toEqual({ since: T0 });
    expect(state.aggregates).toEqual({});
    expect(state.owners).toEqual({});
  });

  it("重复投递同 seq 同 hash → SYNC_NOOP 且状态引用不变", () => {
    const state = seed(ev({ seq: 1 }));
    const out = acceptEvent(state, ev({ seq: 1 }));
    expect(out.code).toBe("SYNC_NOOP");
    expect(out.state).toBe(state);
    expect(out.state.aggregates[AGG]?.events).toHaveLength(1);
  });

  it("同 seq 异 hash → SYNC_CONFLICT_DIE 且历史与水位不变", () => {
    const state = seed(ev({ seq: 1 }), ev({ seq: 2 }));
    const out = acceptEvent(state, ev({ seq: 2, payloadHash: "h-other" }));
    expect(out.code).toBe("SYNC_CONFLICT_DIE");
    expect(out.state).toBe(state);
    expect(out.state.aggregates[AGG]?.watermark).toBe(2);
    expect(out.state.aggregates[AGG]?.events.map((e) => e.payloadHash)).toEqual(["h1", "h1"]);
  });

  it("冲突后文件态与冲突前深比较相等(无部分写入)", () => {
    const state = seed(ev({ seq: 1 }));
    const before = JSON.parse(JSON.stringify(state)) as SyncState;
    acceptEvent(state, ev({ seq: 1, payloadHash: "hx" }));
    expect(state).toEqual(before);
  });

  it("owner 不符 → SYNC_DROPPED_OWNER 且水位不变", () => {
    const state = seed(ev({ seq: 1 }));
    const out = acceptEvent(state, ev({ seq: 2, ownerId: O2 }));
    expect(out.code).toBe("SYNC_DROPPED_OWNER");
    expect(out.state).toBe(state);
    expect(out.state.aggregates[AGG]?.watermark).toBe(1);
    expect(out.state.owners[O2]).toBeUndefined();
  });

  it("owner 不符优先于水位推进(迟到写回不改任何字段)", () => {
    const state = seed(ev({ seq: 4, at: T0 + 10 }));
    const out = acceptEvent(state, ev({ seq: 9, ownerId: "owner-late", at: T0 + 99 }));
    expect(out.code).toBe("SYNC_DROPPED_OWNER");
    expect(out.state.aggregates[AGG]?.events).toHaveLength(1);
    expect(out.state.owners["owner-late"]).toBeUndefined();
  });

  it("乱序 seq 接受后 events 按 seq 升序", () => {
    const state = seed(ev({ seq: 5 }), ev({ seq: 2 }), ev({ seq: 9 }), ev({ seq: 3 }));
    expect(state.aggregates[AGG]?.events.map((e) => e.seq)).toEqual([2, 3, 5, 9]);
  });

  it("watermark = max(旧水位, 新 seq)", () => {
    const high = seed(ev({ seq: 7 }));
    const after = acceptEvent(high, ev({ seq: 3 }));
    expect(after.state.aggregates[AGG]?.watermark).toBe(7);
    const low = seed(ev({ seq: 1 }));
    const up = acceptEvent(low, ev({ seq: 4 }));
    expect(up.state.aggregates[AGG]?.watermark).toBe(4);
  });

  it("owners 已有则保留更早的 since", () => {
    const first = acceptEvent(emptyState(), ev({ seq: 1, at: T0 + 500 }));
    const second = acceptEvent(first.state, ev({ seq: 2, at: T0 }));
    expect(second.state.owners[O1]).toEqual({ since: T0 });
  });

  it("接受结果与调用方传入事件对象解耦(深拷贝)", () => {
    const event = ev({ seq: 1 });
    const out = acceptEvent(emptyState(), event);
    event.payloadHash = "mutated";
    event.seq = 99;
    expect(out.state.aggregates[AGG]?.events[0]?.payloadHash).toBe("h1");
    expect(out.state.aggregates[AGG]?.events[0]?.seq).toBe(1);
  });

  it("多聚合互不干扰", () => {
    const state = seed(ev({ seq: 1 }), ev({ aggregateId: "agg-2", seq: 1, ownerId: O2 }));
    expect(Object.keys(state.aggregates).sort()).toEqual(["agg-1", "agg-2"]);
    expect(state.owners[O1]).toEqual({ since: T0 });
    expect(state.owners[O2]).toEqual({ since: T0 });
    expect(state.aggregates["agg-2"]?.ownerId).toBe(O2);
  });
});

describe("migrate", () => {
  it("成功路径 phases 顺序为 flatten→claim→replay→steal", () => {
    const state = seed(ev({ seq: 1 }), ev({ seq: 2 }));
    const out = migrate(state, { aggregateId: AGG, fromOwner: O1, toOwner: O2, at: T0 + 10 });
    expect(out.code).toBe("SYNC_MIGRATED");
    expect(out.phases).toEqual([...MIGRATE_PHASES]);
  });

  it("成功后聚合 owner 变为 toOwner 且水位保留", () => {
    const state = seed(ev({ seq: 1 }), ev({ seq: 5 }));
    const out = migrate(state, { aggregateId: AGG, fromOwner: O1, toOwner: O2, at: T0 });
    const agg = out.state.aggregates[AGG];
    expect(agg?.ownerId).toBe(O2);
    expect(agg?.watermark).toBe(5);
    expect(agg?.events.map((e) => e.seq)).toEqual([1, 5]);
  });

  it("replay 段交出全部事件深拷贝(与权威状态不共享引用)", () => {
    const state = seed(ev({ seq: 1 }), ev({ seq: 2 }));
    const out = migrate(state, { aggregateId: AGG, fromOwner: O1, toOwner: O2, at: T0 });
    expect(out.replays.map((e) => e.seq)).toEqual([1, 2]);
    expect(out.replays[0]).not.toBe(out.state.aggregates[AGG]?.events[0]);
    out.replays[0]!.payloadHash = "mutated";
    expect(out.state.aggregates[AGG]?.events[0]?.payloadHash).toBe("h1");
  });

  it("steal 段返回 revokedOwner=fromOwner 并登记新 owner", () => {
    const state = seed(ev({ seq: 1 }));
    const out = migrate(state, { aggregateId: AGG, fromOwner: O1, toOwner: O2, at: T0 + 7 });
    expect(out.revokedOwner).toBe(O1);
    expect(out.state.owners[O2]).toEqual({ since: T0 + 7 });
    expect(out.leaseToken).toBe(`${AGG}@${O2}:1`);
  });

  it("迁移不修改入参 state", () => {
    const state = seed(ev({ seq: 1 }));
    const before = JSON.parse(JSON.stringify(state)) as SyncState;
    migrate(state, { aggregateId: AGG, fromOwner: O1, toOwner: O2, at: T0 });
    expect(state).toEqual(before);
  });

  it("聚合不存在 → MIGRATE_FAILED / flatten:no-aggregate / phases 空", () => {
    const state = emptyState();
    const out = migrate(state, { aggregateId: "missing", fromOwner: O1, toOwner: O2, at: T0 });
    expect(out.code).toBe("SYNC_MIGRATE_FAILED");
    expect(out.reason).toBe("flatten:no-aggregate");
    expect(out.phases).toEqual([]);
    expect(out.replays).toEqual([]);
    expect(out.state).toBe(state);
  });

  it("fromOwner 不是当前 owner → flatten:not-owner 且 state 原样", () => {
    const state = seed(ev({ seq: 1 }));
    const out = migrate(state, { aggregateId: AGG, fromOwner: "owner-x", toOwner: O2, at: T0 });
    expect(out.reason).toBe("flatten:not-owner");
    expect(out.phases).toEqual([]);
    expect(out.state).toBe(state);
  });

  it("fromOwner === toOwner → claim:same-owner,phases 只含 flatten", () => {
    const state = seed(ev({ seq: 1 }));
    const out = migrate(state, { aggregateId: AGG, fromOwner: O1, toOwner: O1, at: T0 });
    expect(out.code).toBe("SYNC_MIGRATE_FAILED");
    expect(out.reason).toBe("claim:same-owner");
    expect(out.phases).toEqual(["flatten"]);
    expect(out.state).toBe(state);
  });

  it("toOwner 为空 → claim:empty-owner,不得写出无主聚合", () => {
    const state = seed(ev({ seq: 1 }));
    const out = migrate(state, { aggregateId: AGG, fromOwner: O1, toOwner: "  ", at: T0 });
    expect(out.reason).toBe("claim:empty-owner");
    expect(out.state).toBe(state);
    expect(out.state.aggregates[AGG]?.ownerId).toBe(O1);
  });

  it("迁移后旧 owner 迟到写回被 DROPPED_OWNER", () => {
    const state = seed(ev({ seq: 1 }));
    const moved = migrate(state, { aggregateId: AGG, fromOwner: O1, toOwner: O2, at: T0 }).state;
    const late = acceptEvent(moved, ev({ seq: 2, ownerId: O1 }));
    expect(late.code).toBe("SYNC_DROPPED_OWNER");
    expect(late.state).toBe(moved);
  });

  it("迁移后新 owner 写新 seq → SYNC_ACCEPTED 且水位推进", () => {
    const state = seed(ev({ seq: 1 }));
    const moved = migrate(state, { aggregateId: AGG, fromOwner: O1, toOwner: O2, at: T0 }).state;
    const out = acceptEvent(moved, ev({ seq: 2, ownerId: O2, payloadHash: "h2" }));
    expect(out.code).toBe("SYNC_ACCEPTED");
    expect(out.state.aggregates[AGG]?.watermark).toBe(2);
    expect(out.state.aggregates[AGG]?.ownerId).toBe(O2);
  });
});

describe("subscribeThenRead / watermarkFor", () => {
  it("聚合不存在 → dirtyFromSeq=sinceSeq,history 空", () => {
    const out = subscribeThenRead(emptyState(), { aggregateId: AGG, sinceSeq: 4 });
    expect(out.code).toBe("SYNC_SUBSCRIBED");
    expect(out.subscription).toEqual({ aggregateId: AGG, dirtyFromSeq: 4 });
    expect(out.history).toEqual([]);
  });

  it("聚合存在 → dirtyFromSeq = max(sinceSeq, watermark+1)", () => {
    const state = seed(ev({ seq: 1 }), ev({ seq: 3 }));
    expect(subscribeThenRead(state, { aggregateId: AGG, sinceSeq: 0 }).subscription.dirtyFromSeq).toBe(4);
    expect(subscribeThenRead(state, { aggregateId: AGG, sinceSeq: 9 }).subscription.dirtyFromSeq).toBe(9);
  });

  it("history 按 sinceSeq 过滤且升序", () => {
    const state = seed(ev({ seq: 5 }), ev({ seq: 1 }), ev({ seq: 3 }));
    const out = subscribeThenRead(state, { aggregateId: AGG, sinceSeq: 3 });
    expect(out.history.map((e) => e.seq)).toEqual([3, 5]);
  });

  it("history 是深拷贝", () => {
    const state = seed(ev({ seq: 1 }));
    const out = subscribeThenRead(state, { aggregateId: AGG, sinceSeq: 0 });
    out.history[0]!.payloadHash = "mutated";
    expect(state.aggregates[AGG]?.events[0]?.payloadHash).toBe("h1");
  });

  it("非法 aggregateId → SYNC_INVALID 与空壳", () => {
    const out = subscribeThenRead(emptyState(), { aggregateId: "", sinceSeq: 1 });
    expect(out.code).toBe("SYNC_INVALID");
    expect(out.subscription).toEqual({ aggregateId: "", dirtyFromSeq: 0 });
    expect(out.history).toEqual([]);
  });

  it("watermarkFor 聚合不存在 = 0", () => {
    expect(watermarkFor(emptyState(), AGG)).toBe(0);
    expect(watermarkFor(emptyState(), "")).toBe(0);
  });

  it("watermarkFor 返回既有水位", () => {
    const state = seed(ev({ seq: 2 }), ev({ seq: 6 }));
    expect(watermarkFor(state, AGG)).toBe(6);
  });
});

describe("awaitCatchup / proxyAllowed / responseWatermark", () => {
  it("本地已追平 → 立即 SYNC_CATCHUP_OK", async () => {
    let clock = 0;
    const out = await awaitCatchup(5, 5, { timeoutMs: 100, now: () => clock, sleep: async () => {} });
    expect(out.code).toBe("SYNC_CATCHUP_OK");
    expect(out.caughtUp).toBe(true);
    expect(out.localSeq).toBe(5);
    expect(out.elapsedMs).toBe(0);
  });

  it("readLocalSeq 追上后返回 OK 且 elapsed 用注入时钟", async () => {
    let clock = 0;
    let local = 1;
    const out = await awaitCatchup(1, 3, {
      timeoutMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        local += 1;
      },
      readLocalSeq: () => local,
      pollMs: 10,
    });
    expect(out.code).toBe("SYNC_CATCHUP_OK");
    expect(out.localSeq).toBe(3);
    expect(out.elapsedMs).toBe(20);
  });

  it("超过 timeoutMs → SYNC_CATCHUP_TIMEOUT 且 caughtUp=false", async () => {
    let clock = 0;
    const out = await awaitCatchup(0, 10, {
      timeoutMs: 30,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      readLocalSeq: () => 0,
      pollMs: 10,
    });
    expect(out.code).toBe("SYNC_CATCHUP_TIMEOUT");
    expect(out.caughtUp).toBe(false);
    expect(out.localSeq).toBe(0);
    expect(out.elapsedMs).toBeGreaterThanOrEqual(30);
  });

  it("timeoutMs=0 且未追平 → 立刻 TIMEOUT,不得乐观返回 OK", async () => {
    const out = await awaitCatchup(0, 1, { timeoutMs: 0, now: () => 0, sleep: async () => {} });
    expect(out.code).toBe("SYNC_CATCHUP_TIMEOUT");
  });

  it("proxyAllowed:sync 连接时放行", () => {
    expect(proxyAllowed({ syncConnected: true })).toEqual({ allowed: true, code: null });
  });

  it("proxyAllowed:sync 断开 → SYNC_PROXY_REFUSED", () => {
    expect(proxyAllowed({ syncConnected: false })).toEqual({ allowed: false, code: "SYNC_PROXY_REFUSED" });
  });

  it("responseWatermark 带 x-sync-watermark 头", () => {
    const state = seed(ev({ seq: 1 }), ev({ seq: 4 }));
    const out = responseWatermark(state, AGG);
    expect(out.watermark).toBe(4);
    expect(out.headers["x-sync-watermark"]).toBe("4");
  });

  it("responseWatermark 聚合不存在 → 0", () => {
    const out = responseWatermark(emptyState(), "nope");
    expect(out.watermark).toBe(0);
    expect(out.headers).toEqual({ "x-sync-watermark": "0" });
  });
});
