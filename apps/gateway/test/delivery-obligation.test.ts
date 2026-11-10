/**
 * 网关终态投递义务 —— 状态机/持久化单测面(内存 fake journal + 可推进时钟)。
 * 覆盖:register 幂等(重复登记只 1 条 journal 事件)、attempts≤3 → failed、首投起 24h → failed、
 * mayBeDuplicate 仅 attempts>1、sweep 超租约 attempting→pending、无连接不 markDelivered
 * (register 后保持 pending;send 返回 false/抛错都 release 回 pending)。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import {
  DELIVERY_OBLIGATION_KIND,
  attemptDelivery,
  createDeliveryObligationStore,
} from "../src/delivery-obligation.js";

const CLAIM_TTL = 60_000;
const DAY = 24 * 60 * 60 * 1000;

function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) { now += ms; return now; },
  };
}

function setup() {
  const clock = fakeClock();
  const journal = new MemoryJournal();
  const store = createDeliveryObligationStore({ journal, now: clock.now });
  return { clock, journal, store };
}

const obligationEvents = (journal: MemoryJournal) =>
  journal.readAll().filter((e) => e.kind === DELIVERY_OBLIGATION_KIND);

const task = (id: string) => ({ id, sessionId: `s-${id}`, state: "done" });

describe(" 网关终态投递义务", () => {
  it("register 幂等:重复登记不新增 journal 事件,obligationId=<taskId>:terminal", () => {
    const { journal, store } = setup();
    const first = store.register(task("t-1"));
    const second = store.register(task("t-1"));
    expect(first.obligationId).toBe("t-1:terminal");
    expect(second).toEqual(first);
    expect(obligationEvents(journal)).toHaveLength(1);
    expect(first.state).toBe("pending");
    expect(first.attempts).toBe(0);
    expect(first.mayBeDuplicate).toBe(false);
    expect(journal.readAll()[0]?.idempotencyKey).toBe("delivery.obligation:t-1:terminal:registered");
  });

  it("attempts 上限 3:第 4 次 claim 拒绝并自动 failed(attempts-exhausted)", () => {
    const { clock, store } = setup();
    store.register(task("t-1"));
    expect(store.beginAttempt("t-1")?.attempts).toBe(1);
    clock.advance(CLAIM_TTL + 1); // 越过租约才允许下一次 claim
    expect(store.beginAttempt("t-1")?.attempts).toBe(2);
    clock.advance(CLAIM_TTL + 1);
    expect(store.beginAttempt("t-1")?.attempts).toBe(3);
    clock.advance(CLAIM_TTL + 1);
    expect(store.beginAttempt("t-1")).toBeUndefined();
    const ob = store.get("t-1");
    expect(ob?.state).toBe("failed");
    expect(ob?.reason).toBe("attempts-exhausted");
    expect(ob?.attempts).toBe(3);
    // failed 是终态:不再进入待投递清单
    expect(store.pending()).toHaveLength(0);
  });

  it("首投起超 24h → sweep 自动 failed(window-expired),即使 attempts 未用尽", () => {
    const { clock, store } = setup();
    store.register(task("t-1"));
    expect(store.beginAttempt("t-1")?.attempts).toBe(1);
    clock.advance(DAY);
    expect(store.sweep()).toHaveLength(0);
    const ob = store.get("t-1");
    expect(ob?.state).toBe("failed");
    expect(ob?.reason).toBe("window-expired");
    expect(ob?.attempts).toBe(1);
  });

  it("mayBeDuplicate 仅 attempts>1(首投 false,release 后重发 true)", () => {
    const { clock, store } = setup();
    store.register(task("t-1"));
    const first = store.beginAttempt("t-1");
    expect(first?.attempts).toBe(1);
    expect(first?.mayBeDuplicate).toBe(false);
    store.release("t-1"); // 发送失败 → pending
    clock.advance(1);
    const second = store.beginAttempt("t-1");
    expect(second?.attempts).toBe(2);
    expect(second?.mayBeDuplicate).toBe(true);
    // 投递成功后再 sweep 不会复活
    expect(store.markDelivered("t-1")?.state).toBe("delivered");
    expect(store.sweep()).toHaveLength(0);
    expect(store.get("t-1")?.state).toBe("delivered");
  });

  it("sweep 回收超租约 attempting→pending(保留 attempts),租约内的不动", () => {
    const { clock, store } = setup();
    store.register(task("t-1"));
    store.register(task("t-2"));
    store.beginAttempt("t-1");
    store.beginAttempt("t-2");
    clock.advance(CLAIM_TTL + 1); // 两条都超租约
    const due = store.sweep();
    expect(due.map((ob) => ob.taskId).sort()).toEqual(["t-1", "t-2"]);
    expect(store.get("t-1")?.state).toBe("pending");
    expect(store.get("t-1")?.attempts).toBe(1); // attempts 不清零,过期上限照旧生效

    // 租约内:再次 sweep 之前先 claim 一条,不应被回收
    expect(store.beginAttempt("t-1")?.attempts).toBe(2);
    expect(store.sweep().map((ob) => ob.taskId)).not.toContain("t-1");
    expect(store.get("t-1")?.state).toBe("attempting");
  });

  it("无连接不 markDelivered:register 后保持 pending;send false/抛错都 release 回 pending", () => {
    const { store } = setup();
    // 无连接 = server 不调用 attemptDelivery;义务只能停在 pending,不 claim、不落 delivered
    store.register(task("t-1"));
    expect(store.get("t-1")?.state).toBe("pending");
    expect(store.get("t-1")?.attempts).toBe(0);
    expect(store.pending().map((ob) => ob.taskId)).toEqual(["t-1"]);

    // 有连接但发送失败:release 回 pending(不置 delivered),attempts 已计入
    const failedSend = attemptDelivery(store, "t-1", () => false);
    expect(failedSend?.state).toBe("pending");
    expect(store.get("t-1")?.state).toBe("pending");
    expect(store.get("t-1")?.attempts).toBe(1);

    // send 抛错同语义(不冒泡出 state machine)
    store.register(task("t-2"));
    const thrown = attemptDelivery(store, "t-2", () => { throw new Error("ws closed"); });
    expect(thrown?.state).toBe("pending");
    expect(store.get("t-2")?.state).toBe("pending");
    expect(store.get("t-2")?.attempts).toBe(1);

    // 成功才 delivered
    const ok = attemptDelivery(store, "t-2", () => true);
    expect(ok?.state).toBe("delivered");
    expect(store.get("t-2")?.state).toBe("delivered");
  });
});
