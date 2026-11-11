/**
 * 生产接线:dispatch 入口真实派生并冻结路由身份。
 * 探针:
 * A) panel 正常 trigger → dispatched,且 ticket.routeIdentity.key 稳定(同输入同 key);
 * B) im 无 identity → subjectId=sessionId,派生仍 OK;
 * C) allowedTenants 不含 source → observed 零派发,reason 含 route-identity:TENANT_DENIED;
 * D) 同 subject 不同 threadKey → 各自 key 稳定且互不相等;
 * E) 旧调用点(deps 不传 routeIdentity)零回归 + 恢复 Ticket 复用同一快照(不重新派生)。
 */
import { describe, expect, it } from "vitest";
import type { Task } from "@lampgenie/core";
import { dispatch, deriveDispatchRouteIdentity, type DispatchDeps } from "../src/router/dispatch.js";
import type { Disposition, Ticket, Trigger } from "../src/router/model.js";
import { DEFAULT_POLICY_CONFIG, type PolicyConfig } from "../src/router/policy.js";
import { freezeRouteIdentity, type RouteIdentity } from "@lampgenie/runtime/router/route-identity";

const T0 = 1_700_000_000_000;

function configOf(over: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    ...DEFAULT_POLICY_CONFIG,
    mode: "observe",
    allowlist: [],
    sources: [{ name: "panel", listened: true }, { name: "im", listened: true }],
    ...over,
  };
}

function triggerOf(over: Partial<Trigger> = {}): Trigger {
  return {
    id: "trg-1",
    source: "panel",
    sessionId: "s1",
    instruction: "写个 README",
    threadKey: "session:s1",
    at: T0,
    ...over,
  };
}

function depsOf(opts: { config?: PolicyConfig; tickets?: Map<string, Ticket>; taskState?: Task["state"] } = {}) {
  const tickets = opts.tickets ?? new Map<string, Ticket>();
  const liveSubscriptions = new Map<string, boolean>();
  const submitted: Array<{ sessionId: string; instruction: string; extra: unknown }> = [];
  const dispositions: Disposition[] = [];
  const state = opts.taskState ?? "running";
  const deps: DispatchDeps = {
    tm: {
      submit: (_kind, sessionId, instruction, extra) => {
        submitted.push({ sessionId, instruction, extra });
        return { id: "task-1", state } as unknown as Task;
      },
      get: () => ({ id: "task-1", state } as unknown as Task),
    },
    config: opts.config ?? configOf(),
    tickets,
    liveSubscriptions,
    saveDisposition: (d) => { dispositions.push(d); },
    now: () => T0,
  };
  return { deps, tickets, liveSubscriptions, submitted, dispositions };
}

function frozen(over: { subjectId?: string; threadId?: string } = {}): RouteIdentity {
  const r = freezeRouteIdentity({}, {
    tenantId: "im",
    sourceKind: "group",
    subjectId: "u-9",
    threadId: "session:s1",
    ...over,
  });
  if (!r.ok) throw new Error(`冻结失败:${r.code}`);
  return r.identity;
}

describe("A:panel 正常 trigger → dispatched,key 稳定", () => {
  it("ticket.routeIdentity 落上冻结快照,同输入重复派生同 key", async () => {
    const { deps, tickets, submitted, dispositions } = depsOf();
    const trigger = triggerOf();
    const out = await dispatch(trigger, deps);
    expect(out.kind).toBe("dispatched");
    expect(submitted).toHaveLength(1);
    const ticket = [...tickets.values()][0]!;
    expect(ticket.routeIdentity).toBeDefined();
    expect(ticket.routeIdentity!.key).toMatch(/^[0-9a-f]{24}$/);
    expect(Object.isFrozen(ticket.routeIdentity)).toBe(true);
 // key 稳定:同一 trigger 再派生一次 → 同 key
    const again = deriveDispatchRouteIdentity(trigger, configOf());
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.identity.key).toBe(ticket.routeIdentity!.key);
    expect(ticket.routeIdentity).toMatchObject({ tenantId: "panel", sourceKind: "dm", subjectId: "s1", threadId: "session:s1" });
    expect(dispositions.at(-1)).toMatchObject({ outcome: "dispatched", routeIdentityCode: "OK" });
  });
});

describe("B:im 无 identity → subjectId=sessionId", () => {
  it("派生 ok,subjectId 回落 sessionId(sourceKind=group)", async () => {
    const { deps, dispositions } = depsOf();
    const out = await dispatch(triggerOf({ id: "trg-b", source: "im", sessionId: "s-b" }), deps);
    expect(out.kind).toBe("observed");
    const d = dispositions.at(-1)!;
    expect(d.routeIdentityCode).toBe("OK");
    expect(d.routeIdentity).toMatchObject({ tenantId: "im", sourceKind: "group", subjectId: "s-b" });
  });
});

describe("C:allowedTenants 不含 source → 零派发", () => {
  it("TENANT_DENIED:不 submit、不开 ticket、不订阅,reason 带稳定码", async () => {
    const { deps, tickets, liveSubscriptions, submitted, dispositions } = depsOf({
      config: configOf({ sources: [{ name: "panel", listened: true }, { name: "im", listened: false }] }),
    });
    const out = await dispatch(triggerOf({ id: "trg-c", source: "im" }), deps);
    expect(out.kind).toBe("observed");
    expect(submitted).toHaveLength(0);
    expect(tickets.size).toBe(0);
    expect(liveSubscriptions.size).toBe(0);
    const d = dispositions.at(-1)!;
    expect(d.outcome).toBe("observed");
    expect(d.reason).toContain("route-identity:TENANT_DENIED");
    expect(d.routeIdentityCode).toBe("TENANT_DENIED");
    expect(d.routeIdentity).toBeUndefined();
  });
});

describe("D:同 subject 不同 threadKey → key 稳定", () => {
  it("各自重复派生同 key,互不相等", () => {
    const cfg = configOf();
    const a1 = deriveDispatchRouteIdentity(triggerOf({ threadKey: "th-a" }), cfg);
    const a2 = deriveDispatchRouteIdentity(triggerOf({ threadKey: "th-a" }), cfg);
    const b1 = deriveDispatchRouteIdentity(triggerOf({ threadKey: "th-b" }), cfg);
    expect(a1.ok && a2.ok && b1.ok).toBe(true);
    if (!a1.ok || !a2.ok || !b1.ok) return;
    expect(a1.identity.subjectId).toBe(b1.identity.subjectId);
    expect(a1.identity.key).toBe(a2.identity.key);
    expect(a1.identity.key).not.toBe(b1.identity.key);
  });
});

describe("E:旧调用点零回归 + 恢复 Ticket 复用快照", () => {
  it("旧调用点(deps 无新字段)仍按原口径派发", async () => {
    const { deps, dispositions } = depsOf();
    const out = await dispatch(triggerOf({ id: "trg-e" }), deps);
    expect(out.kind).toBe("dispatched");
    expect(dispositions.at(-1)).toMatchObject({ outcome: "dispatched", policyVersion: expect.any(String) });
  });

  it("open Ticket 已有冻结快照 → gate 读快照(不按 trigger.identity 重算)", async () => {
 // 快照主体 u-9 在白名单里;trigger.identity=u-x 不在。复用快照 → 直通(steered);重算 → observed。
    const tickets = new Map<string, Ticket>();
    tickets.set("ticket-recovered", {
      ticketId: "ticket-recovered",
      triggerId: "trg-old",
      sessionId: "s1",
      phase: "open",
      threadKey: "session:s1",
      taskId: "task-1",
      routeIdentity: frozen({ subjectId: "u-9" }),
      createdAt: T0 - 1000,
      updatedAt: T0 - 1000,
    });
    const { deps, dispositions } = depsOf({
      tickets,
      config: configOf({ allowlist: ["u-9"] }),
      taskState: "running",
    });
    deps.liveSubscriptions.set("session:s1", true);
    const out = await dispatch(triggerOf({ id: "trg-e2", source: "im", identity: "u-x" }), deps);
    expect(out.kind).toBe("steered");
    if (out.kind === "steered") expect(out.ticket.routeIdentity?.subjectId).toBe("u-9");
    expect(dispositions.at(-1)).toMatchObject({ outcome: "steered", routeIdentityCode: "OK" });
  });
});
