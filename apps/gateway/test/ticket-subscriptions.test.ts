/**
 * subscriptionsFromTickets —— open Ticket + liveSubscriptions 合成 route 订阅表(纯逻辑)。
 * 探针:
 * A) open Ticket → 一条 route 条目(id=ticket:<ticketId>),字段逐项正确;非 open/空 threadKey 跳过;
 * B) liveSubscriptions=true 且未被 Ticket 覆盖 → live 条目;false/已覆盖跳过;
 * C) 同 threadKey 多 Ticket → ticketId 字典序最小(确定性);
 * D) 输出按 threadKey 排序,重复调用 deep equal,输入表不被修改;
 * E) 非法输入不 throw;describeSubscription 一行 ≤160。
 */
import { describe, expect, it } from "vitest";
import type { Ticket } from "../src/router/model.js";
import { describeSubscription, subscriptionsFromTickets } from "../src/router/ticket-subscriptions.js";

const T0 = 1_700_000_000_000;

function ticketOf(over: Partial<Ticket> = {}): Ticket {
  return {
    ticketId: "ticket-a",
    triggerId: "trg-1",
    sessionId: "s1",
    phase: "open",
    threadKey: "session:s1",
    taskId: "task-1",
    createdAt: T0 - 5_000,
    updatedAt: T0 - 5_000,
    ...over,
  };
}

describe("A:open Ticket → route 订阅条目", () => {
  it("字段逐项正确;createdAt 缺省回退 now", () => {
    const tickets = new Map<string, Ticket>([["ticket-a", ticketOf()]]);
    const list = subscriptionsFromTickets(tickets, new Map(), { now: T0 });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "ticket:ticket-a",
      threadKey: "session:s1",
      subscriber: "s1",
      mode: "route",
      wakePolicy: "immediate",
      since: T0 - 5_000,
      createdAt: T0 - 5_000,
      generation: 1,
    });

    const noCreatedAt = subsOf([ticketOf({ createdAt: undefined as unknown as number })], new Map(), T0);
    expect(noCreatedAt[0]).toMatchObject({ since: T0, createdAt: T0 });
  });

  it("非 open 与空 threadKey 跳过", () => {
    const tickets = new Map<string, Ticket>([
      ["t1", ticketOf({ ticketId: "t1", phase: "observed" })],
      ["t2", ticketOf({ ticketId: "t2", phase: "closed" })],
      ["t3", ticketOf({ ticketId: "t3", threadKey: "" })],
      ["t4", ticketOf({ ticketId: "t4", threadKey: "   " })],
    ]);
    expect(subscriptionsFromTickets(tickets, new Map(), { now: T0 })).toEqual([]);
  });
});

describe("B:liveSubscriptions 合成 live 条目", () => {
  it("true 且未被覆盖 → live 条目;false 与已覆盖跳过", () => {
    const tickets = new Map<string, Ticket>([["ticket-a", ticketOf({ threadKey: "session:s1" })]]);
    const live = new Map<string, boolean>([
      ["session:s1", true],
      ["session:s2", true],
      ["session:s3", false],
    ]);
    const list = subscriptionsFromTickets(tickets, live, { now: T0 });
    expect(list.map((s) => s.id)).toEqual(["ticket:ticket-a", "live:session:s2"]);
    expect(list[1]).toMatchObject({
      id: "live:session:s2",
      threadKey: "session:s2",
      subscriber: "live",
      mode: "route",
      wakePolicy: "immediate",
      since: T0,
      createdAt: T0,
      generation: 1,
    });
  });
});

describe("C:同 threadKey 多 Ticket → ticketId 字典序最小", () => {
  it("插入顺序不影响选择", () => {
    const first = new Map<string, Ticket>([
      ["ticket-b", ticketOf({ ticketId: "ticket-b" })],
      ["ticket-a", ticketOf({ ticketId: "ticket-a" })],
    ]);
    const second = new Map<string, Ticket>([
      ["ticket-a", ticketOf({ ticketId: "ticket-a" })],
      ["ticket-b", ticketOf({ ticketId: "ticket-b" })],
    ]);
    expect(subsOf([...first.values()], new Map(), T0)[0]?.id).toBe("ticket:ticket-a");
    expect(subscriptionsFromTickets(second, new Map(), { now: T0 })[0]?.id).toBe("ticket:ticket-a");
  });
});

describe("D:排序 / 确定性 / 不可变", () => {
  it("输出按 threadKey 排序,重复调用 deep equal,输入不被改", () => {
    const tickets = new Map<string, Ticket>([
      ["ticket-z", ticketOf({ ticketId: "ticket-z", threadKey: "session:z" })],
      ["ticket-a", ticketOf({ ticketId: "ticket-a", threadKey: "session:a" })],
    ]);
    const live = new Map<string, boolean>([
      ["session:m", true],
      ["session:a", true],
    ]);
    const beforeTickets = new Map(tickets);
    const beforeLive = new Map(live);
    const one = subscriptionsFromTickets(tickets, live, { now: T0 });
    const two = subscriptionsFromTickets(tickets, live, { now: T0 });
    expect(one.map((s) => s.threadKey)).toEqual(["session:a", "session:m", "session:z"]);
    expect(one.map((s) => s.id)).toEqual(["ticket:ticket-a", "live:session:m", "ticket:ticket-z"]);
    expect(two).toEqual(one);
    expect(one[0]).not.toBe(two[0]);
    expect([...tickets.entries()]).toEqual([...beforeTickets.entries()]);
    expect([...live.entries()]).toEqual([...beforeLive.entries()]);
  });
});

describe("E:非法输入不 throw + describeSubscription", () => {
  it("null/undefined/无字段对象 → 空表", () => {
    expect(subscriptionsFromTickets(null, null, { now: T0 })).toEqual([]);
    expect(subscriptionsFromTickets(undefined, undefined)).toEqual([]);
    const junk = new Map<string, Ticket>([
      ["x", undefined as unknown as Ticket],
      ["y", { ticketId: "t", phase: "open" } as unknown as Ticket],
    ]);
    expect(subscriptionsFromTickets(junk, new Map(), { now: T0 })).toEqual([]);
  });

  it("plain object 形态的 live 表也支持", () => {
    const list = subscriptionsFromTickets(new Map(), { "session:s9": true, "session:s10": false }, { now: T0 });
    expect(list.map((s) => s.id)).toEqual(["live:session:s9"]);
  });

  it("describeSubscription 一行且 ≤160 字,null 不 throw", () => {
    const [sub] = subsOf([ticketOf()], new Map(), T0);
    const line = describeSubscription(sub);
    expect(line).toContain("ticket:ticket-a");
    expect(line).toContain("route/immediate");
    expect(line.length).toBeLessThanOrEqual(160);
    expect(describeSubscription(null)).toBe("(invalid subscription)");
    const long = describeSubscription({ id: "x".repeat(400), threadKey: "k", subscriber: "s", mode: "route", wakePolicy: "immediate", since: T0, createdAt: T0, generation: 1, decisionHistory: [] });
    expect(long.length).toBeLessThanOrEqual(160);
  });
});

function subsOf(tickets: Ticket[], live: Map<string, boolean>, now: number) {
  return subscriptionsFromTickets(tickets, live, { now });
}
