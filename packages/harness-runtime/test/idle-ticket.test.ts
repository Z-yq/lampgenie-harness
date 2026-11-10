/**
 * 闲时算力票据纯逻辑:双轴状态机 / 原子 CAS 认领 / 结算幂等 / 回收 / 手动续号 / 轮询与派发闸门。
 * 全纯函数直测,不触 IO。
 */
import { describe, expect, it } from "vitest";
import {
  claim,
  cloneTicket,
  continueExpired,
  createTicket,
  dispatchRound,
  dualAxis,
  emptyTicketStore,
  expire,
  IDLE_CLAIMED,
  IDLE_CODES,
  IDLE_CONTINUED,
  IDLE_CREATED,
  IDLE_DEFAULT_MAX_ACTIVE_MS,
  IDLE_DEFAULT_READY_DEADLINE_MS,
  IDLE_DISPATCH_REJECTED,
  IDLE_EXPIRED,
  IDLE_INVALID,
  IDLE_NOT_SCHEDULABLE,
  IDLE_PENDING_EXISTS,
  IDLE_POLL_DUE,
  IDLE_POLL_MAX_MS,
  IDLE_POLL_MIN_MS,
  IDLE_POLL_WAIT,
  IDLE_QUOTA_EXHAUSTED,
  IDLE_READY,
  IDLE_RECLAIMED,
  IDLE_RETRY_PENDING,
  IDLE_SETTLED,
  IDLE_TICKET_VERSION,
  isPending,
  makeReady,
  pendingOf,
  pollPlan,
  reclaimStale,
  sanitizeTicketStore,
  settle,
  summarizeTickets,
  type IdleTicket,
  type TicketStore,
} from "../src/agent/idle-ticket.ts";

const T0 = 1_700_000_000_000;

function storeWith(tickets: IdleTicket[]): TicketStore {
  const store = emptyTicketStore();
  for (const t of tickets) {
    store.tickets[t.id] = t;
    const bucket = store.bySession[t.sessionId];
    if (bucket === undefined) store.bySession[t.sessionId] = [t.id];
    else bucket.push(t.id);
  }
  return store;
}

function ticket(partial: Partial<IdleTicket> & { id: string }): IdleTicket {
  return {
    sessionId: partial.sessionId ?? "s1",
    localStatus: partial.localStatus ?? "queued",
    ticketStatus: partial.ticketStatus ?? "queued",
    createdAt: partial.createdAt ?? T0,
    updatedAt: partial.updatedAt ?? T0,
    revision: partial.revision ?? 1,
    attempts: partial.attempts ?? 0,
    ...partial,
  };
}

function makeActive(store: TicketStore, id: string): void {
  expect(makeReady(store, { id, now: T0 }).code).toBe(IDLE_READY);
  expect(claim(store, { id, now: T0 + 1 }).code).toBe(IDLE_CLAIMED);
}

describe("码表与账本骨架", () => {
  it("版本与 15 个稳定码固定顺序", () => {
    expect(IDLE_TICKET_VERSION).toBe(1);
    expect(IDLE_CODES).toHaveLength(15);
    expect(IDLE_CODES[0]).toBe("IDLE_INVALID");
    expect(new Set(IDLE_CODES).size).toBe(15);
    for (const code of IDLE_CODES) expect(code.startsWith("IDLE_")).toBe(true);
  });

  it("空账本两张表都为空", () => {
    const store = emptyTicketStore();
    expect(Object.keys(store.tickets)).toHaveLength(0);
    expect(Object.keys(store.bySession)).toHaveLength(0);
  });

  it("返回给调用方的票据是副本,外部改动不回灌内部状态", () => {
    const store = emptyTicketStore();
    const created = createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    expect(created.ticket).toBeDefined();
    created.ticket!.localStatus = "done";
    expect(store.tickets["t1"]?.localStatus).toBe("queued");
    const copy = cloneTicket(store.tickets["t1"]!);
    copy.id = "hacked";
    expect(store.tickets["hacked"]).toBeUndefined();
  });
});

describe("createTicket:先取票再落库", () => {
  it("创建 queued 票据并进会话索引", () => {
    const store = emptyTicketStore();
    const r = createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    expect(r.code).toBe(IDLE_CREATED);
    expect(r.ok).toBe(true);
    expect(r.ticket).toMatchObject({ id: "t1", sessionId: "s1", localStatus: "queued", ticketStatus: "queued", revision: 1, attempts: 0 });
    expect(store.bySession["s1"]).toEqual(["t1"]);
  });

  it("缺省 id 按会话序号生成并跳过撞号", () => {
    const store = emptyTicketStore();
    const r1 = createTicket(store, { sessionId: "s1", now: T0 });
    expect(r1.ticket?.id).toBe("idle-s1-1");
    // 手工占掉下一个候选名,再创建应跳到 3
    store.tickets["idle-s1-2"] = ticket({ id: "idle-s1-2" });
    const r2 = createTicket(store, { sessionId: "s2", now: T0 });
    expect(r2.ticket?.id).toBe("idle-s2-1");
  });

  it("sessionId 非法 → INVALID 且不落库", () => {
    const store = emptyTicketStore();
    for (const sessionId of ["", "   "]) {
      const r = createTicket(store, { sessionId, now: T0 });
      expect(r.code).toBe(IDLE_INVALID);
    }
    expect(Object.keys(store.tickets)).toHaveLength(0);
    const longId = "x".repeat(200);
    expect(createTicket(store, { sessionId: longId, now: T0 }).code).toBe(IDLE_INVALID);
  });

  it("now 非法(NaN / 负数)→ INVALID", () => {
    const store = emptyTicketStore();
    expect(createTicket(store, { sessionId: "s1", now: Number.NaN }).code).toBe(IDLE_INVALID);
    expect(createTicket(store, { sessionId: "s1", now: -1 }).code).toBe(IDLE_INVALID);
    expect(Object.keys(store.tickets)).toHaveLength(0);
  });

  it("额度不足 → QUOTA_EXHAUSTED 且不落库", () => {
    const store = emptyTicketStore();
    const r = createTicket(store, { sessionId: "s1", now: T0, budgetOk: false });
    expect(r.code).toBe(IDLE_QUOTA_EXHAUSTED);
    expect(r.ok).toBe(false);
    expect(Object.keys(store.tickets)).toHaveLength(0);
    expect(store.bySession["s1"]).toBeUndefined();
  });

  it("同会话已有一张 queued → PENDING_EXISTS", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    const r = createTicket(store, { sessionId: "s1", now: T0 + 1 });
    expect(r.code).toBe(IDLE_PENDING_EXISTS);
    expect(r.detail?.["pendingIds"]).toEqual(["t1"]);
    expect(Object.keys(store.tickets)).toHaveLength(1);
  });

  it("同会话 pending 覆盖 ready / active 两态", () => {
    const readyStore = emptyTicketStore();
    createTicket(readyStore, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(readyStore, { id: "t1", now: T0 });
    expect(createTicket(readyStore, { sessionId: "s1", now: T0 + 2 }).code).toBe(IDLE_PENDING_EXISTS);

    const activeStore = emptyTicketStore();
    createTicket(activeStore, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(activeStore, "t1");
    expect(createTicket(activeStore, { sessionId: "s1", now: T0 + 2 }).code).toBe(IDLE_PENDING_EXISTS);
  });

  it("异会话互不影响", () => {
    const store = emptyTicketStore();
    expect(createTicket(store, { sessionId: "s1", now: T0, id: "t1" }).code).toBe(IDLE_CREATED);
    expect(createTicket(store, { sessionId: "s2", now: T0, id: "t2" }).code).toBe(IDLE_CREATED);
    expect(Object.keys(store.tickets)).toHaveLength(2);
  });

  it("已有终态(done)后同会话可再创建", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(store, "t1");
    expect(settle(store, { id: "t1", outcome: "ok", now: T0 + 5 }).code).toBe(IDLE_SETTLED);
    expect(createTicket(store, { sessionId: "s1", now: T0 + 6, id: "t2" }).code).toBe(IDLE_CREATED);
    expect(store.bySession["s1"]).toEqual(["t1", "t2"]);
  });

  it("expired 票不再占 pending 名额", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(store, { id: "t1", now: T0 });
    expect(expire(store, { id: "t1", now: T0 + IDLE_DEFAULT_READY_DEADLINE_MS + 1 }).code).toBe(IDLE_EXPIRED);
    expect(createTicket(store, { sessionId: "s1", now: T0 + IDLE_DEFAULT_READY_DEADLINE_MS + 2 }).code).toBe(IDLE_CREATED);
  });

  it("显式 id 撞号 → INVALID", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    expect(createTicket(store, { sessionId: "s2", now: T0, id: "t1" }).code).toBe(IDLE_INVALID);
  });
});

describe("makeReady", () => {
  it("queued → ready,挂 10min 缺省 deadline,本地轴转 schedulable", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    const r = makeReady(store, { id: "t1", now: T0 });
    expect(r.code).toBe(IDLE_READY);
    expect(r.ticket).toMatchObject({ ticketStatus: "ready", localStatus: "schedulable", readyDeadline: T0 + IDLE_DEFAULT_READY_DEADLINE_MS });
    expect(r.ticket?.revision).toBe(2);
  });

  it("自定义 deadlineMs 生效", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    const r = makeReady(store, { id: "t1", now: T0, deadlineMs: 1_000 });
    expect(r.ticket?.readyDeadline).toBe(T0 + 1_000);
  });

  it("重复 ready 幂等且不延长存活期", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(store, { id: "t1", now: T0 });
    const r = makeReady(store, { id: "t1", now: T0 + 1_000, deadlineMs: 99_000_000 });
    expect(r.code).toBe(IDLE_READY);
    expect(r.detail?.["idempotent"]).toBe(true);
    expect(r.ticket?.readyDeadline).toBe(T0 + IDLE_DEFAULT_READY_DEADLINE_MS);
  });

  it("已过 deadline 的 ready → EXPIRED 并把票转 expired", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(store, { id: "t1", now: T0, deadlineMs: 1_000 });
    const r = makeReady(store, { id: "t1", now: T0 + 1_001 });
    expect(r.code).toBe(IDLE_EXPIRED);
    expect(store.tickets["t1"]?.ticketStatus).toBe("expired");
  });

  it("expired 票不能转 ready(NOT_SCHEDULABLE)", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(store, { id: "t1", now: T0, deadlineMs: 10 });
    expire(store, { id: "t1", now: T0 + 100 });
    expect(makeReady(store, { id: "t1", now: T0 + 200 }).code).toBe(IDLE_NOT_SCHEDULABLE);
  });

  it("active 票不能回 ready;不存在的票 → INVALID", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(store, "t1");
    expect(makeReady(store, { id: "t1", now: T0 + 10 }).code).toBe(IDLE_NOT_SCHEDULABLE);
    expect(makeReady(store, { id: "nope", now: T0 }).code).toBe(IDLE_INVALID);
  });
});

describe("claim:原子 CAS", () => {
  it("ready 且未过 deadline → active + claimedAt + 本地 running", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(store, { id: "t1", now: T0 });
    const r = claim(store, { id: "t1", now: T0 + 100 });
    expect(r.code).toBe(IDLE_CLAIMED);
    expect(r.ticket).toMatchObject({ ticketStatus: "active", localStatus: "running", claimedAt: T0 + 100 });
    expect(store.tickets["t1"]?.revision).toBe(3);
  });

  it("queued 直接 claim → NOT_SCHEDULABLE", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    const r = claim(store, { id: "t1", now: T0 + 1 });
    expect(r.code).toBe(IDLE_NOT_SCHEDULABLE);
    expect(r.detail?.["status"]).toBe("queued");
    expect(store.tickets["t1"]?.ticketStatus).toBe("queued");
  });

  it("过 deadline 的 ready → EXPIRED 且票转 expired(不放过期票)", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(store, { id: "t1", now: T0, deadlineMs: 1_000 });
    const r = claim(store, { id: "t1", now: T0 + 1_001 });
    expect(r.code).toBe(IDLE_EXPIRED);
    expect(store.tickets["t1"]?.ticketStatus).toBe("expired");
    expect(store.tickets["t1"]?.localStatus).toBe("queued");
  });

  it("deadline 边界:now === readyDeadline 仍可认领(闭区间)", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(store, { id: "t1", now: T0, deadlineMs: 1_000 });
    expect(claim(store, { id: "t1", now: T0 + 1_000 }).code).toBe(IDLE_CLAIMED);
  });

  it("expired / 已结算票 → NOT_SCHEDULABLE", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(store, { id: "t1", now: T0, deadlineMs: 10 });
    expire(store, { id: "t1", now: T0 + 100 });
    expect(claim(store, { id: "t1", now: T0 + 101 }).code).toBe(IDLE_NOT_SCHEDULABLE);

    const doneStore = emptyTicketStore();
    createTicket(doneStore, { sessionId: "s1", now: T0, id: "t2" });
    makeActive(doneStore, "t2");
    settle(doneStore, { id: "t2", outcome: "ok", now: T0 + 5 });
    expect(claim(doneStore, { id: "t2", now: T0 + 6 }).code).toBe(IDLE_NOT_SCHEDULABLE);
  });

  it("CAS 版本不符 → NOT_SCHEDULABLE,相符 → 成功", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(store, { id: "t1", now: T0 });
    const bad = claim(store, { id: "t1", now: T0 + 1, expectRevision: 1 });
    expect(bad.code).toBe(IDLE_NOT_SCHEDULABLE);
    expect(bad.detail?.["reason"]).toBe("revision-mismatch");
    expect(claim(store, { id: "t1", now: T0 + 2, expectRevision: 2 }).code).toBe(IDLE_CLAIMED);
  });

  it("重复 claim 第二发拿不到(单飞语义)", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(store, "t1");
    const second = claim(store, { id: "t1", now: T0 + 2 });
    expect(second.code).toBe(IDLE_NOT_SCHEDULABLE);
    expect(store.tickets["t1"]?.claimedAt).toBe(T0 + 1);
  });

  it("不存在的票 → INVALID", () => {
    expect(claim(emptyTicketStore(), { id: "nope", now: T0 }).code).toBe(IDLE_INVALID);
  });
});

describe("expire", () => {
  it("ready 过 deadline → expired,本地轴回 queued", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(store, { id: "t1", now: T0, deadlineMs: 1_000 });
    const r = expire(store, { id: "t1", now: T0 + 1_001 });
    expect(r.code).toBe(IDLE_EXPIRED);
    expect(r.ticket).toMatchObject({ ticketStatus: "expired", localStatus: "queued" });
  });

  it("未到 deadline → INVALID(不提前收口)", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(store, { id: "t1", now: T0, deadlineMs: 10_000 });
    const r = expire(store, { id: "t1", now: T0 + 5_000 });
    expect(r.code).toBe(IDLE_INVALID);
    expect(r.detail?.["reason"]).toBe("not-yet-due");
    expect(store.tickets["t1"]?.ticketStatus).toBe("ready");
  });

  it("queued 无 deadline → INVALID;设了 deadline 的 queued 到期可过期", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    expect(expire(store, { id: "t1", now: T0 + 999_999 }).code).toBe(IDLE_INVALID);

    const withDeadline = storeWith([ticket({ id: "t2", readyDeadline: T0 + 100 })]);
    expect(expire(withDeadline, { id: "t2", now: T0 + 101 }).code).toBe(IDLE_EXPIRED);
  });

  it("已 expired 幂等;active 票不能 expire", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(store, { id: "t1", now: T0, deadlineMs: 10 });
    expire(store, { id: "t1", now: T0 + 100 });
    const again = expire(store, { id: "t1", now: T0 + 200 });
    expect(again.code).toBe(IDLE_EXPIRED);
    expect(again.detail?.["idempotent"]).toBe(true);
    expect(again.ticket?.revision).toBe(store.tickets["t1"]?.revision);

    createTicket(store, { sessionId: "s2", now: T0, id: "t2" });
    makeActive(store, "t2");
    expect(expire(store, { id: "t2", now: T0 + 999_999 }).code).toBe(IDLE_INVALID);
  });
});

describe("settle:终态与重试", () => {
  it("5xx → RETRY_PENDING,保持 active,attempts+1,无 settledAt", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(store, "t1");
    const r = settle(store, { id: "t1", outcome: "5xx", now: T0 + 10 });
    expect(r.code).toBe(IDLE_RETRY_PENDING);
    expect(r.ticket).toMatchObject({ ticketStatus: "active", localStatus: "running", attempts: 1 });
    expect(r.ticket?.settledAt).toBeUndefined();
    expect(settle(store, { id: "t1", outcome: "5xx", now: T0 + 20 }).ticket?.attempts).toBe(2);
  });

  it("ok → SETTLED 终态 done + settledAt/outcome", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(store, "t1");
    const r = settle(store, { id: "t1", outcome: "ok", now: T0 + 30 });
    expect(r.code).toBe(IDLE_SETTLED);
    expect(r.ticket).toMatchObject({ localStatus: "done", settledAt: T0 + 30, outcome: "ok" });
    expect(r.detail?.["ack"]).toBe("final");
  });

  it("4xx → SETTLED 且本地 failed(幂等 ack)", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(store, "t1");
    const r = settle(store, { id: "t1", outcome: "4xx", now: T0 + 30 });
    expect(r.code).toBe(IDLE_SETTLED);
    expect(r.ticket).toMatchObject({ localStatus: "failed", outcome: "4xx" });
    expect(r.detail?.["ack"]).toBe("idempotent");
  });

  it("4xx 重放幂等:状态与 revision 都不再变", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(store, "t1");
    settle(store, { id: "t1", outcome: "4xx", now: T0 + 30 });
    const rev = store.tickets["t1"]?.revision;
    const again = settle(store, { id: "t1", outcome: "4xx", now: T0 + 40 });
    expect(again.code).toBe(IDLE_SETTLED);
    expect(again.detail?.["idempotent"]).toBe(true);
    expect(store.tickets["t1"]?.revision).toBe(rev);
    expect(store.tickets["t1"]?.settledAt).toBe(T0 + 30);
  });

  it("终态后再用另一个 outcome 结算 → INVALID", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(store, "t1");
    settle(store, { id: "t1", outcome: "ok", now: T0 + 30 });
    const r = settle(store, { id: "t1", outcome: "4xx", now: T0 + 40 });
    expect(r.code).toBe(IDLE_INVALID);
    expect(r.detail?.["reason"]).toBe("already-settled");
  });

  it("非 active 票不能结算;非法 outcome / 未知 id → INVALID", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    expect(settle(store, { id: "t1", outcome: "ok", now: T0 + 1 }).code).toBe(IDLE_NOT_SCHEDULABLE);
    expect(settle(store, { id: "t1", outcome: "2xx" as never, now: T0 + 1 }).code).toBe(IDLE_INVALID);
    expect(settle(store, { id: "nope", outcome: "ok", now: T0 }).code).toBe(IDLE_INVALID);
  });
});

describe("reclaimStale:僵尸票回收", () => {
  it("超租期首次回收 → queued(可再派发),attempts+1", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(store, "t1");
    const r = reclaimStale(store, { now: T0 + IDLE_DEFAULT_MAX_ACTIVE_MS + 2 });
    expect(r.code).toBe(IDLE_RECLAIMED);
    expect(r.requeued.map((t) => t.id)).toEqual(["t1"]);
    expect(r.failed).toHaveLength(0);
    expect(store.tickets["t1"]).toMatchObject({
      ticketStatus: "queued",
      localStatus: "queued",
      attempts: 0,
      reclaims: 1,
      recoveredFrom: "t1",
    });
    expect(store.tickets["t1"]?.claimedAt).toBeUndefined();
  });

  it("回收后再次超租期 → failed 收口(不无限空转)", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(store, "t1");
    reclaimStale(store, { now: T0 + IDLE_DEFAULT_MAX_ACTIVE_MS + 2 });
    makeActive(store, "t1");
    const r = reclaimStale(store, { now: T0 + IDLE_DEFAULT_MAX_ACTIVE_MS + 100_000 });
    expect(r.failed.map((t) => t.id)).toEqual(["t1"]);
    expect(store.tickets["t1"]?.localStatus).toBe("failed");
    expect(store.tickets["t1"]?.settledAt).toBeDefined();
    expect(isPending(store.tickets["t1"]!)).toBe(false);
  });

  it("5xx 重试过的票第一次回收仍回 queued(重试计数不挡回收)", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(store, "t1");
    expect(settle(store, { id: "t1", outcome: "5xx", now: T0 + 10 }).code).toBe(IDLE_RETRY_PENDING);
    const r = reclaimStale(store, { now: T0 + IDLE_DEFAULT_MAX_ACTIVE_MS + 2 });
    expect(r.requeued.map((t) => t.id)).toEqual(["t1"]);
    expect(store.tickets["t1"]).toMatchObject({ ticketStatus: "queued", reclaims: 1, attempts: 1 });
  });

  it("未超租期 / 已结算 / 非 active 都不回收", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(store, "t1");
    expect(reclaimStale(store, { now: T0 + 100 }).reclaimed).toHaveLength(0);

    settle(store, { id: "t1", outcome: "ok", now: T0 + 200 });
    const r = reclaimStale(store, { now: T0 + 999_999 });
    expect(r.reclaimed).toHaveLength(0);
    expect(r.ok).toBe(true);
    expect(r.detail?.["count"]).toBe(0);
  });

  it("sessionId 过滤只回收目标会话", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(store, "t1");
    createTicket(store, { sessionId: "s2", now: T0, id: "t2" });
    makeActive(store, "t2");
    const r = reclaimStale(store, { now: T0 + IDLE_DEFAULT_MAX_ACTIVE_MS + 2, sessionId: "s2" });
    expect(r.requeued.map((t) => t.id)).toEqual(["t2"]);
    expect(store.tickets["t1"]?.ticketStatus).toBe("active");
  });

  it("now 非法 → INVALID 且零改动", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(store, "t1");
    const r = reclaimStale(store, { now: Number.NaN });
    expect(r.code).toBe(IDLE_INVALID);
    expect(r.reclaimed).toHaveLength(0);
    expect(store.tickets["t1"]?.ticketStatus).toBe("active");
  });
});

describe("continueExpired:手动补号", () => {
  it("expired + 本地 queued → 新票,记录 continuedFrom", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(store, { id: "t1", now: T0, deadlineMs: 10 });
    expire(store, { id: "t1", now: T0 + 100 });
    const r = continueExpired(store, { id: "t1", now: T0 + 200, newId: "t1b" });
    expect(r.code).toBe(IDLE_CONTINUED);
    expect(r.ticket).toMatchObject({ id: "t1b", sessionId: "s1", ticketStatus: "queued", continuedFrom: "t1" });
    expect(r.detail?.["sourceId"]).toBe("t1");
    expect(store.bySession["s1"]).toEqual(["t1", "t1b"]);
  });

  it("未 expired / 不存在 → NOT_SCHEDULABLE / INVALID", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    expect(continueExpired(store, { id: "t1", now: T0 + 1 }).code).toBe(IDLE_NOT_SCHEDULABLE);
    expect(continueExpired(store, { id: "nope", now: T0 + 1 }).code).toBe(IDLE_INVALID);
  });

  it("本地已 failed 的 expired 票不许续号(失败收口)", () => {
    const store = storeWith([
      ticket({ id: "t1", ticketStatus: "expired", localStatus: "failed" }),
    ]);
    const r = continueExpired(store, { id: "t1", now: T0 + 1 });
    expect(r.code).toBe(IDLE_INVALID);
    expect(r.detail?.["reason"]).toBe("local-status");
  });

  it("同会话已有 pending 时不许再补号", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(store, { id: "t1", now: T0, deadlineMs: 10 });
    expire(store, { id: "t1", now: T0 + 100 });
    createTicket(store, { sessionId: "s1", now: T0 + 101, id: "t2" });
    const r = continueExpired(store, { id: "t1", now: T0 + 102 });
    expect(r.code).toBe(IDLE_PENDING_EXISTS);
  });
});

describe("pollPlan:5s–5min 间隔", () => {
  it("首轮(无上次时间)→ DUE", () => {
    const plan = pollPlan({ now: T0 });
    expect(plan.code).toBe(IDLE_POLL_DUE);
    expect(plan.due).toBe(true);
  });

  it("不足 5s → WAIT,给出剩余等待", () => {
    const plan = pollPlan({ lastPollAt: T0, now: T0 + 2_000 });
    expect(plan.code).toBe(IDLE_POLL_WAIT);
    expect(plan.due).toBe(false);
    expect(plan.waitMs).toBe(3_000);
    expect(plan.nextPollAt).toBe(T0 + IDLE_POLL_MIN_MS);
  });

  it("恰好 5s → DUE(边界闭区间)", () => {
    expect(pollPlan({ lastPollAt: T0, now: T0 + IDLE_POLL_MIN_MS }).code).toBe(IDLE_POLL_DUE);
  });

  it("超过 5min → DUE 且标 overdue", () => {
    const plan = pollPlan({ lastPollAt: T0, now: T0 + IDLE_POLL_MAX_MS + 1_000 });
    expect(plan.code).toBe(IDLE_POLL_DUE);
    expect(plan.overdue).toBe(true);
    expect(plan.overdueMs).toBe(1_000);
  });

  it("中间区间(1min)→ DUE 但不 overdue", () => {
    const plan = pollPlan({ lastPollAt: T0, now: T0 + 60_000 });
    expect(plan.code).toBe(IDLE_POLL_DUE);
    expect(plan.overdue).toBe(false);
  });

  it("now 非法 → INVALID 且 not due", () => {
    const plan = pollPlan({ lastPollAt: T0, now: Number.NaN });
    expect(plan.code).toBe(IDLE_INVALID);
    expect(plan.due).toBe(false);
  });
});

describe("dispatchRound:派发轮闸门", () => {
  it("空账本 / 只有 queued / 只有 expired 终态 → 放行", () => {
    expect(dispatchRound(emptyTicketStore()).code).toBe(IDLE_CREATED);

    const queued = emptyTicketStore();
    createTicket(queued, { sessionId: "s1", now: T0, id: "t1" });
    expect(dispatchRound(queued).ok).toBe(true);

    const expired = emptyTicketStore();
    createTicket(expired, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(expired, { id: "t1", now: T0, deadlineMs: 10 });
    expire(expired, { id: "t1", now: T0 + 100 });
    expect(dispatchRound(expired).ok).toBe(true);
  });

  it("有 ready → 拒绝再创建,点名阻塞票", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeReady(store, { id: "t1", now: T0 });
    const r = dispatchRound(store);
    expect(r.code).toBe(IDLE_DISPATCH_REJECTED);
    expect(r.rejected).toBe(true);
    expect(r.blockingIds).toEqual(["t1"]);
  });

  it("有 active → 拒绝;结算后放行", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(store, "t1");
    expect(dispatchRound(store).code).toBe(IDLE_DISPATCH_REJECTED);
    settle(store, { id: "t1", outcome: "ok", now: T0 + 10 });
    expect(dispatchRound(store).ok).toBe(true);
  });
});

describe("dualAxis:只有 ready 才 schedulable", () => {
  it("ready + 本地 queued / schedulable 都可调度", () => {
    expect(dualAxis(ticket({ id: "a", ticketStatus: "ready", localStatus: "queued" })).schedulable).toBe(true);
    expect(dualAxis(ticket({ id: "b", ticketStatus: "ready", localStatus: "schedulable" })).schedulable).toBe(true);
  });

  it("本地显示 schedulable 但票据已 expired → 不可调度(本地轴不越权)", () => {
    const r = dualAxis(ticket({ id: "c", ticketStatus: "expired", localStatus: "schedulable" }));
    expect(r.schedulable).toBe(false);
    expect(r.reason).toBe("ticket-expired");
  });

  it("queued / active / 已结算 → 不可调度", () => {
    expect(dualAxis(ticket({ id: "d" })).schedulable).toBe(false);
    expect(dualAxis(ticket({ id: "e", ticketStatus: "active", localStatus: "running" })).schedulable).toBe(false);
    expect(dualAxis(ticket({ id: "f", ticketStatus: "ready", localStatus: "schedulable", settledAt: T0 })).reason).toBe("settled");
  });
});

describe("summarizeTickets / sanitizeTicketStore", () => {
  it("计数 / pending / 僵尸 active", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    makeActive(store, "t1");
    createTicket(store, { sessionId: "s2", now: T0, id: "t2" });
    makeReady(store, { id: "t2", now: T0 });
    const summary = summarizeTickets(store, { now: T0 + IDLE_DEFAULT_MAX_ACTIVE_MS + 2 });
    expect(summary.total).toBe(2);
    expect(summary.pending).toBe(2);
    expect(summary.byTicketStatus.active).toBe(1);
    expect(summary.byTicketStatus.ready).toBe(1);
    expect(summary.byLocalStatus.running).toBe(1);
    expect(summary.byLocalStatus.schedulable).toBe(1);
    expect(summary.staleActive.map((t) => t.id)).toEqual(["t1"]);
    expect(summary.pendingBySession).toEqual({ s1: ["t1"], s2: ["t2"] });
    expect(summary.sessions).toBe(2);
  });

  it("sanitize:坏条目丢弃,好条目保序恢复", () => {
    const raw = {
      v: 1,
      tickets: {
        b: { sessionId: "s2", localStatus: "queued", ticketStatus: "queued", createdAt: T0 + 5, updatedAt: T0 + 5, revision: 1, attempts: 0 },
        a: { sessionId: "s1", localStatus: "done", ticketStatus: "active", createdAt: T0 + 1, updatedAt: T0 + 2, revision: 3, attempts: 0, settledAt: T0 + 2, outcome: "ok" },
        bad1: { sessionId: "", localStatus: "queued", ticketStatus: "queued", createdAt: T0, updatedAt: T0 },
        bad2: { sessionId: "s1", localStatus: "wat", ticketStatus: "queued", createdAt: T0, updatedAt: T0 },
        bad3: null,
      },
    };
    const { store, dropped } = sanitizeTicketStore(raw);
    expect(Object.keys(store.tickets).sort()).toEqual(["a", "b"]);
    expect(dropped.sort()).toEqual(["bad1", "bad2", "bad3"]);
    expect(store.bySession["s1"]).toEqual(["a"]);
    expect(store.tickets["a"]?.outcome).toBe("ok");
    expect(store.tickets["a"]?.settledAt).toBe(T0 + 2);
  });

  it("sanitize:非对象输入 → 空账本不炸", () => {
    expect(sanitizeTicketStore(null).store.tickets).toEqual({});
    expect(sanitizeTicketStore("nope").store.tickets).toEqual({});
    expect(sanitizeTicketStore({ tickets: [] }).store.tickets).toEqual({});
  });

  it("pendingOf 只返回未结算 pending", () => {
    const store = emptyTicketStore();
    createTicket(store, { sessionId: "s1", now: T0, id: "t1" });
    expect(pendingOf(store, "s1").map((t) => t.id)).toEqual(["t1"]);
    makeActive(store, "t1");
    settle(store, { id: "t1", outcome: "ok", now: T0 + 3 });
    expect(pendingOf(store, "s1")).toHaveLength(0);
    expect(pendingOf(store, "unknown")).toHaveLength(0);
  });
});
