/**
 * 生产接线:dispatch 真调用 gate 时传入合成订阅表(open Ticket + liveSubscriptions)。
 * 探针:
 * A) open Ticket → 订阅表含 route 条目且 gate 直通(真 dispatch:steered);
 * A2) 仅 open Ticket、live 表为空 → 新表在真 dispatch 生效(旧代码会 observed,现 dispatched);
 * B) 无 Ticket 但 live=true → 合成 live 条目直通(dispatched);
 * C) 都无 → 空表,既有 allowlist/addressed/panel 行为不变,im 未授权仍 observed;
 * D) 同 threadKey 多 Ticket → 字典序最小;
 * E) 输出排序/确定性。
 */
import { describe, expect, it } from "vitest";
import type { Task } from "@lampgenie/core";
import { dispatch, type DispatchDeps } from "../src/router/dispatch.js";
import { subscriptionsFromTickets } from "../src/router/ticket-subscriptions.js";
import { gate, DEFAULT_POLICY_CONFIG, type PolicyConfig } from "../src/router/policy.js";
import type { Disposition, Ticket, Trigger } from "../src/router/model.js";

const T0 = 1_700_000_000_000;
const TK = "session:s1";

function configOf(over: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    ...DEFAULT_POLICY_CONFIG,
    mode: "observe",
    allowlist: [],
    sources: [{ name: "panel", listened: true }, { name: "im", listened: true }],
    ...over,
  };
}

function ticketOf(over: Partial<Ticket> = {}): Ticket {
  return {
    ticketId: "ticket-a",
    triggerId: "trg-old",
    sessionId: "s1",
    phase: "open",
    threadKey: TK,
    taskId: "task-1",
    createdAt: T0 - 5_000,
    updatedAt: T0 - 5_000,
    ...over,
  };
}

function depsOf(opts: { config?: PolicyConfig; tickets?: Map<string, Ticket>; live?: Map<string, boolean>; taskState?: Task["state"] } = {}) {
  const tickets = opts.tickets ?? new Map<string, Ticket>();
  const liveSubscriptions = opts.live ?? new Map<string, boolean>();
  const submitted: Array<{ sessionId: string; instruction: string }> = [];
  const dispositions: Disposition[] = [];
  const state = opts.taskState ?? "running";
  const deps: DispatchDeps = {
    tm: {
      submit: (_kind, sessionId, instruction) => {
        submitted.push({ sessionId, instruction });
        return { id: `task-${submitted.length + 1}`, state } as unknown as Task;
      },
      get: (taskId) => (tickets.size > 0 || taskId === "task-1" ? ({ id: taskId, state } as unknown as Task) : undefined),
    },
    config: opts.config ?? configOf(),
    tickets,
    liveSubscriptions,
    saveDisposition: (d) => { dispositions.push(d); },
    now: () => T0,
  };
  return { deps, tickets, liveSubscriptions, submitted, dispositions };
}

const triggerOf = (over: Partial<Trigger> = {}): Trigger => ({
  id: "trg-1",
  source: "im",
  sessionId: "s1",
  instruction: "继续推进",
  threadKey: TK,
  identity: "u-x",
  at: T0,
  ...over,
});

describe("A:open Ticket → route 条目 + gate 直通", () => {
  it("订阅表含 ticket 条目,gate 判 routed;真 dispatch 走 steered", async () => {
    const tickets = new Map<string, Ticket>([["ticket-a", ticketOf()]]);
    const live = new Map<string, boolean>([[TK, true]]);
    const subs = subscriptionsFromTickets(tickets, live, { now: T0 });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ id: "ticket:ticket-a", threadKey: TK, mode: "route", subscriber: "s1" });
    const verdict = gate(triggerOf(), configOf(), live, { subscriptions: subs, now: T0 });
    expect(verdict.admissible).toBe(true);
    expect(verdict.subscriptionDecision).toEqual({ decision: "routed", subscriptionIds: ["ticket:ticket-a"] });

    const { deps, dispositions } = depsOf({ tickets, live });
    const out = await dispatch(triggerOf(), deps);
    expect(out.kind).toBe("steered");
    if (out.kind === "steered") expect(out.ticket.ticketId).toBe("ticket-a");
    expect(dispositions.at(-1)).toMatchObject({ outcome: "steered", steeredTicketId: "ticket-a" });
  });

  it("A2) 仅 open Ticket、live 表为空 → 新订阅表在真 dispatch 生效(旧代码 observed)", async () => {
    const tickets = new Map<string, Ticket>([["ticket-a", ticketOf()]]);
    const { deps, submitted, dispositions } = depsOf({ tickets });
    const out = await dispatch(triggerOf({ id: "trg-a2" }), deps);
    expect(out.kind).toBe("dispatched");
    expect(submitted).toHaveLength(1);
    expect(dispositions.at(-1)).toMatchObject({ outcome: "dispatched", routeIdentityCode: "OK" });
  });
});

describe("B:无 Ticket 但 live=true → 合成 live 条目直通", () => {
  it("订阅表含 live 条目;真 dispatch 判 dispatched(非 steered,无承接 task)", async () => {
    const live = new Map<string, boolean>([[TK, true]]);
    const subs = subscriptionsFromTickets(new Map(), live, { now: T0 });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      id: `live:${TK}`, threadKey: TK, subscriber: "live", mode: "route", wakePolicy: "immediate", since: T0, createdAt: T0, generation: 1,
    });
    const verdict = gate(triggerOf(), configOf(), live, { subscriptions: subs, now: T0 });
    expect(verdict.admissible).toBe(true);
    expect(verdict.subscriptionDecision?.decision).toBe("routed");

    const { deps, submitted } = depsOf({ live });
    const out = await dispatch(triggerOf({ id: "trg-b" }), deps);
    expect(out.kind).toBe("dispatched");
    expect(submitted).toHaveLength(1);
  });
});

describe("C:都无 → 空表,既有授权链行为不变", () => {
  it("空表 + im 未授权 → observed(would_accept),零派发", async () => {
    const { deps, submitted, dispositions } = depsOf();
    expect(subscriptionsFromTickets(deps.tickets, deps.liveSubscriptions, { now: T0 })).toEqual([]);
    const out = await dispatch(triggerOf({ id: "trg-c1" }), deps);
    expect(out.kind).toBe("observed");
    expect(submitted).toHaveLength(0);
    expect(dispositions.at(-1)).toMatchObject({ outcome: "observed", would_accept: true });
  });

  it("空表 + allowlist 命中 → dispatched(explicit)", async () => {
    const { deps, submitted, dispositions } = depsOf({ config: configOf({ allowlist: ["u-9"] }) });
    const out = await dispatch(triggerOf({ id: "trg-c2", identity: "u-9" }), deps);
    expect(out.kind).toBe("dispatched");
    expect(submitted).toHaveLength(1);
    expect(dispositions.at(-1)).toMatchObject({ outcome: "dispatched" });
  });

  it("空表 + addressed → dispatched(explicit)", async () => {
    const { deps, submitted, dispositions } = depsOf();
    const out = await dispatch(triggerOf({ id: "trg-c3", identity: "u-y", addressed: true }), deps);
    expect(out.kind).toBe("dispatched");
    expect(submitted).toHaveLength(1);
    expect(dispositions.at(-1)).toMatchObject({ outcome: "dispatched" });
  });

  it("空表 + panel 来源 → dispatched(explicit 面板路径不变)", async () => {
    const { deps, submitted } = depsOf();
    const out = await dispatch(triggerOf({ id: "trg-c4", source: "panel" }), deps);
    expect(out.kind).toBe("dispatched");
    expect(submitted).toHaveLength(1);
  });
});

describe("D:同 threadKey 多 Ticket → 字典序最小", () => {
  it("pick ticket-a(不是先插入的 ticket-b),gate 直通 id 一致", () => {
    const tickets = new Map<string, Ticket>([
      ["ticket-b", ticketOf({ ticketId: "ticket-b" })],
      ["ticket-a", ticketOf({ ticketId: "ticket-a" })],
    ]);
    const live = new Map<string, boolean>([[TK, true]]);
    const subs = subscriptionsFromTickets(tickets, live, { now: T0 });
    expect(subs.map((s) => s.id)).toEqual(["ticket:ticket-a"]);
    const verdict = gate(triggerOf(), configOf(), live, { subscriptions: subs, now: T0 });
    expect(verdict.subscriptionDecision).toEqual({ decision: "routed", subscriptionIds: ["ticket:ticket-a"] });
  });
});

describe("E:输出排序 / 确定性", () => {
  it("多 threadKey 按序输出,重复调用 deep equal", () => {
    const tickets = new Map<string, Ticket>([
      ["ticket-z", ticketOf({ ticketId: "ticket-z", threadKey: "session:z" })],
      ["ticket-a", ticketOf({ ticketId: "ticket-a", threadKey: "session:a" })],
    ]);
    const live = new Map<string, boolean>([["session:m", true], ["session:a", true]]);
    const one = subscriptionsFromTickets(tickets, live, { now: T0 });
    const two = subscriptionsFromTickets(tickets, live, { now: T0 });
    expect(one.map((s) => s.threadKey)).toEqual(["session:a", "session:m", "session:z"]);
    expect(two).toEqual(one);
  });
});
