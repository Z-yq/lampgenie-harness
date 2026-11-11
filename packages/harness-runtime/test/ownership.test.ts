/**
 * 会话工作所有权注册表纯逻辑单测(零 IO):
 * 覆盖 register 幂等/代次升降、update 浅合并、settle 迟到丢弃、两阶段关闭(beginClose →
 * cancel → settle → completeClose)、级联顺序确定性、pending 语义、isStale/stats/restore、
 * 快照不可变与入参非法不抛错。
 */
import { describe, expect, it } from "vitest";
import { OWNERSHIP_CODES, OwnerRegistry } from "../src/task/ownership";
import type { OwnerUnit } from "../src/task/ownership";

/** 单调递增假时钟:每次读都往前走一点,让 registeredAt/closedAt 可预测。 */
function fakeClock(start = 1_000, step = 10): { now: () => number; tick: () => number } {
  let value = start;
  return {
    now: () => value,
    tick: () => {
      const current = value;
      value += step;
      return current;
    },
  };
}

function makeRegistry(now: () => number = () => 1_000): OwnerRegistry {
  return new OwnerRegistry({ now });
}

function register(registry: OwnerRegistry, unitId: string, generation = 1, kind: OwnerUnit["kind"] = "subagent", owner = "s1") {
  return registry.register({ unitId, kind, ownerSessionId: owner, generation });
}

/** 把 registry 里该会话的单元全部 settle(正常结束)。 */
function settleAll(registry: OwnerRegistry, owner = "s1"): void {
  for (const unit of registry.snapshot(owner)) {
    if (unit.state !== "closed") registry.settle(unit.unitId, { generation: unit.generation });
  }
}

describe("OWNERSHIP_CODES", () => {
  it("封闭五码且顺序稳定", () => {
    expect([...OWNERSHIP_CODES]).toEqual(["OK", "NOT_FOUND", "CLOSING", "STALE_GENERATION", "INVALID"]);
  });
});

describe("register:注册与代次", () => {
  it("新单元落 running,registeredAt = now()", () => {
    const clock = fakeClock();
    const registry = makeRegistry(() => clock.tick());
    const result = register(registry, "u1", 1, "terminal");
    expect(result.code).toBe("OK");
    expect(result.unit).toMatchObject({ unitId: "u1", kind: "terminal", ownerSessionId: "s1", generation: 1, state: "running", registeredAt: 1_000 });
    expect(result.unit?.closedAt).toBeUndefined();
  });

  it("同 generation 重复注册幂等,不刷新 registeredAt", () => {
    const clock = fakeClock();
    const registry = makeRegistry(() => clock.tick());
    const first = register(registry, "u1");
    const second = register(registry, "u1");
    expect(second.code).toBe("OK");
    expect(second.unit?.registeredAt).toBe(first.unit?.registeredAt);
    expect(registry.stats().total).toBe(1);
  });

  it("新 generation 更大 → 更新代次且保留 registeredAt", () => {
    const clock = fakeClock();
    const registry = makeRegistry(() => clock.tick());
    const first = register(registry, "u1", 1);
    const second = register(registry, "u1", 5);
    expect(second.code).toBe("OK");
    expect(second.unit?.generation).toBe(5);
    expect(second.unit?.registeredAt).toBe(first.unit?.registeredAt);
    expect(registry.get("u1")?.generation).toBe(5);
  });

  it("旧 generation 注册 → STALE_GENERATION 且不更新", () => {
    const registry = makeRegistry();
    register(registry, "u1", 4);
    const stale = register(registry, "u1", 3);
    expect(stale.code).toBe("STALE_GENERATION");
    expect(registry.get("u1")?.generation).toBe(4);
  });

  it("已 closed 的 unitId 复用 → INVALID", () => {
    const registry = makeRegistry();
    register(registry, "u1");
    registry.beginClose("s1");
    settleAll(registry);
    registry.completeClose("s1");
 // 已 closed 的 unitId 换一个未关闭的会话去复用:身份不可复用 → INVALID。
    const reused = register(registry, "u1", 9, "subagent", "s2");
    expect(reused.code).toBe("INVALID");
    expect(registry.get("u1")?.generation).toBe(1);
 // 同一会话(已 beginClose)则先撞 CLOSING,阻止新启动。
    expect(register(registry, "u1", 9).code).toBe("CLOSING");
  });

  it("running 之外:closing 单元再注册 → CLOSING", () => {
    const registry = makeRegistry();
    register(registry, "u1");
    registry.beginClose("s1");
    expect(register(registry, "u1", 2, "subagent", "s2").code).toBe("CLOSING");
  });

  it("非法入参 → INVALID 且不落状态、不抛错", () => {
    const registry = makeRegistry();
    const cases: unknown[] = [
      null,
      undefined,
      {},
      { unitId: "", kind: "terminal", ownerSessionId: "s1", generation: 1 },
      { unitId: "u1", kind: "bogus", ownerSessionId: "s1", generation: 1 },
      { unitId: "u1", kind: "terminal", ownerSessionId: "", generation: 1 },
      { unitId: "u1", kind: "terminal", ownerSessionId: "s1", generation: -1 },
      { unitId: "u1", kind: "terminal", ownerSessionId: "s1", generation: Number.NaN },
      { unitId: "u1", kind: "terminal", ownerSessionId: "s1", generation: Number.POSITIVE_INFINITY },
    ];
    for (const bad of cases) {
      const result = registry.register(bad as never);
      expect(result.code).toBe("INVALID");
      expect(result.reason).toBeTruthy();
    }
    expect(registry.stats().total).toBe(0);
  });

  it("beginClose 之后再注册同会话新单元 → CLOSING", () => {
    const registry = makeRegistry();
    register(registry, "u1", 1, "terminal");
    registry.beginClose("s1");
    const result = register(registry, "u2", 1, "subagent");
    expect(result.code).toBe("CLOSING");
    expect(registry.get("u2")).toBeUndefined();
  });
});

describe("update:浅合并", () => {
  it("不存在 → NOT_FOUND", () => {
    expect(makeRegistry().update("nope", { state: "closing" }).code).toBe("NOT_FOUND");
  });

  it("合并 state/generation/closedAt 并返回快照", () => {
    const registry = makeRegistry();
    register(registry, "u1", 1);
    const updated = registry.update("u1", { state: "closing", generation: 2, closedAt: 42 });
    expect(updated.code).toBe("OK");
    expect(updated.unit).toMatchObject({ unitId: "u1", state: "closing", generation: 2, closedAt: 42 });
    expect(registry.get("u1")).toMatchObject({ state: "closing", generation: 2, closedAt: 42 });
  });

  it("身份字段(unitId/kind/ownerSessionId)不被 patch 改写", () => {
    const registry = makeRegistry();
    register(registry, "u1", 1, "terminal", "s1");
    registry.update("u1", { unitId: "hijack", kind: "workflow", ownerSessionId: "s9" } as never);
    expect(registry.get("u1")).toMatchObject({ unitId: "u1", kind: "terminal", ownerSessionId: "s1" });
  });

  it("非法 patch → INVALID 且保持原状", () => {
    const registry = makeRegistry();
    register(registry, "u1", 1);
    expect(registry.update("u1", { state: "bogus" } as never).code).toBe("INVALID");
    expect(registry.update("u1", { generation: -3 }).code).toBe("INVALID");
    expect(registry.update("u1", null as never).code).toBe("INVALID");
    expect(registry.get("u1")).toMatchObject({ state: "running", generation: 1 });
  });
});

describe("settle:结束回调记账", () => {
  it("同代次 settle → OK,不改 state/closedAt", () => {
    const registry = makeRegistry();
    register(registry, "u1", 3);
    const result = registry.settle("u1", { generation: 3 });
    expect(result.code).toBe("OK");
    expect(registry.get("u1")).toMatchObject({ state: "running", generation: 3 });
    expect(registry.get("u1")?.closedAt).toBeUndefined();
  });

  it("旧代次 settle → STALE_GENERATION 且状态不更新(迟到丢弃)", () => {
    const registry = makeRegistry();
    register(registry, "u1", 3);
    registry.beginClose("s1");
    const stale = registry.settle("u1", { generation: 2 });
    expect(stale.code).toBe("STALE_GENERATION");
    expect(registry.get("u1")?.state).toBe("closing");
 // 旧代 settle 不算数:completeClose 仍把它列进 pending。
    expect(registry.completeClose("s1").pending).toEqual(["u1"]);
  });

  it("未知单元 → NOT_FOUND", () => {
    expect(makeRegistry().settle("ghost", { generation: 1 }).code).toBe("NOT_FOUND");
  });
});

describe("两阶段关闭:canStart / beginClose", () => {
  it("canStart:未关闭 true,beginClose 后 false,completeClose 后仍 false", () => {
    const registry = makeRegistry();
    register(registry, "u1");
    expect(registry.canStart("s1")).toBe(true);
    registry.beginClose("s1");
    expect(registry.canStart("s1")).toBe(false);
    settleAll(registry);
    registry.completeClose("s1");
    expect(registry.canStart("s1")).toBe(false);
    expect(registry.canStart("other")).toBe(true);
  });

  it("beginClose 级联顺序固定 terminal → subagent → workflow", () => {
    const clock = fakeClock();
    const registry = makeRegistry(() => clock.tick());
    register(registry, "w1", 1, "workflow");
    register(registry, "s1-unit", 1, "subagent");
    register(registry, "t1", 1, "terminal");
    register(registry, "t2", 1, "terminal");
    const result = registry.beginClose("s1");
    expect(result.code).toBe("OK");
    expect(result.units?.map((unit) => unit.unitId)).toEqual(["t1", "t2", "s1-unit", "w1"]);
    expect(result.units?.every((unit) => unit.state === "closing")).toBe(true);
  });

  it("同 kind 内 registeredAt 相同时按 unitId 字典序", () => {
    const registry = makeRegistry(() => 500);
    register(registry, "b", 1, "subagent");
    register(registry, "a", 1, "subagent");
    expect(registry.beginClose("s1").units?.map((unit) => unit.unitId)).toEqual(["a", "b"]);
  });

  it("beginClose 无单元 → OK,units=[]", () => {
    const registry = makeRegistry();
    const result = registry.beginClose("empty");
    expect(result.code).toBe("OK");
    expect(result.units).toEqual([]);
  });

  it("beginClose 幂等:重复调用返回同一序列", () => {
    const registry = makeRegistry();
    register(registry, "t1", 1, "terminal");
    register(registry, "s1-unit", 1, "subagent");
    const first = registry.beginClose("s1");
    const second = registry.beginClose("s1");
    expect(second.code).toBe("OK");
    expect(second.units?.map((unit) => unit.unitId)).toEqual(first.units?.map((unit) => unit.unitId));
  });
});

describe("completeClose:pending 语义", () => {
  it("未 settle 时 pending 非空且单元已 closed", () => {
    const clock = fakeClock();
    const registry = makeRegistry(() => clock.tick());
    register(registry, "t1", 1, "terminal");
    register(registry, "w1", 1, "workflow");
    registry.beginClose("s1");
    const result = registry.completeClose("s1");
    expect(result.code).toBe("OK");
    expect(result.pending).toEqual(["t1", "w1"]);
    expect(registry.get("t1")?.state).toBe("closed");
    expect(registry.get("w1")?.closedAt).toBeTypeOf("number");
  });

  it("全部 settle 后 completeClose:全 closed、pending 为空、closedAt 用 now", () => {
    const registry = makeRegistry(() => 7_777);
    register(registry, "t1", 1, "terminal");
    register(registry, "w1", 1, "workflow");
    registry.beginClose("s1");
    settleAll(registry);
    const result = registry.completeClose("s1");
    expect(result.pending).toEqual([]);
    expect(registry.snapshot("s1").map((unit) => unit.state)).toEqual(["closed", "closed"]);
    expect(registry.get("t1")?.closedAt).toBe(7_777);
    expect(registry.stats()).toEqual({ total: 2, running: 0, closing: 0, closed: 2, owners: 1 });
  });

  it("部分 settle:pending 只列未 settle 的单元(保持级联顺序)", () => {
    const registry = makeRegistry();
    register(registry, "t1", 1, "terminal");
    register(registry, "s1-unit", 1, "subagent");
    register(registry, "w1", 1, "workflow");
    registry.beginClose("s1");
    registry.settle("s1-unit", { generation: 1 });
    expect(registry.completeClose("s1").pending).toEqual(["t1", "w1"]);
  });

  it("completeClose 不影响其它会话的单元", () => {
    const registry = makeRegistry();
    register(registry, "u1", 1, "terminal", "s1");
    register(registry, "u2", 1, "terminal", "s2");
    registry.beginClose("s1");
    settleAll(registry, "s1");
    registry.completeClose("s1");
    expect(registry.get("u2")?.state).toBe("running");
    expect(registry.canStart("s2")).toBe(true);
  });
});

describe("closeByOwner", () => {
  it("等同 beginClose:返回需 cancel 单元与顺序", () => {
    const registry = makeRegistry();
    register(registry, "w1", 1, "workflow");
    register(registry, "t1", 1, "terminal");
    const result = registry.closeByOwner("s1");
    expect(result.code).toBe("OK");
    expect(result.units?.map((unit) => unit.unitId)).toEqual(["t1", "w1"]);
    expect(registry.canStart("s1")).toBe(false);
  });

  it("closeByOwner → settle → completeClose 全链路", () => {
    const registry = makeRegistry();
    register(registry, "w1", 1, "workflow");
    register(registry, "w2", 1, "workflow");
    const listed = registry.closeByOwner("s1");
    for (const unit of listed.units ?? []) registry.settle(unit.unitId, { generation: unit.generation });
    const done = registry.completeClose("s1");
    expect(done.pending).toEqual([]);
    expect(registry.snapshot("s1").every((unit) => unit.state === "closed")).toBe(true);
  });
});

describe("isStale", () => {
  it("未知单元 → true", () => {
    expect(makeRegistry().isStale("nope", 1)).toBe(true);
  });

  it("代次相等 false,不等 true", () => {
    const registry = makeRegistry();
    register(registry, "u1", 5);
    expect(registry.isStale("u1", 5)).toBe(false);
    expect(registry.isStale("u1", 4)).toBe(true);
    expect(registry.isStale("u1", 6)).toBe(true);
  });
});

describe("stats", () => {
  it("空注册表全 0", () => {
    expect(makeRegistry().stats()).toEqual({ total: 0, running: 0, closing: 0, closed: 0, owners: 0 });
  });

  it("按状态与 owner 数汇总", () => {
    const registry = makeRegistry();
    register(registry, "u1", 1, "terminal", "s1");
    register(registry, "u2", 1, "terminal", "s1");
    register(registry, "u3", 1, "subagent", "s2");
    registry.beginClose("s1");
    registry.settle("u1", { generation: 1 });
    registry.completeClose("s1");
    expect(registry.stats()).toEqual({ total: 3, running: 1, closing: 0, closed: 2, owners: 2 });
  });
});

describe("restore:覆盖式载入", () => {
  const row = (over: Partial<OwnerUnit> = {}): OwnerUnit => ({
    unitId: "u1",
    kind: "terminal",
    ownerSessionId: "s1",
    generation: 1,
    state: "running",
    registeredAt: 100,
    ...over,
  });

  it("覆盖式载入并返回条数,非法条目跳过", () => {
    const registry = makeRegistry();
    register(registry, "stale-unit");
    const restored = registry.restore([
      row({ unitId: "t1" }),
      row({ unitId: "w1", kind: "workflow", state: "closing" }),
      row({ unitId: "" }),
      row({ unitId: "bad-kind", kind: "bogus" as never }),
      row({ unitId: "bad-gen", generation: -1 }),
      row({ unitId: "bad-state", state: "zombie" as never }),
      row({ unitId: "bad-at", registeredAt: Number.NaN }),
      null as never,
    ]);
    expect(restored).toEqual({ restored: 2 });
    expect(registry.get("stale-unit")).toBeUndefined();
    expect(registry.get("t1")?.state).toBe("running");
    expect(registry.stats()).toMatchObject({ total: 2, running: 1, closing: 1 });
  });

  it("closing/closed 单元的 owner 记入 closingOwners(canStart=false)", () => {
    const registry = makeRegistry();
    registry.restore([row({ unitId: "c1", state: "closed", closedAt: 200 }), row({ unitId: "r2", ownerSessionId: "s2" })]);
    expect(registry.canStart("s1")).toBe(false);
    expect(registry.canStart("s2")).toBe(true);
    expect(register(registry, "new", 1, "subagent", "s1").code).toBe("CLOSING");
  });

  it("非数组 → restored 0 且不抛错", () => {
    const registry = makeRegistry();
    register(registry, "u1");
    expect(registry.restore(null as never)).toEqual({ restored: 0 });
    expect(registry.restore("x" as never)).toEqual({ restored: 0 });
    expect(registry.get("u1")?.state).toBe("running");
  });
});

describe("快照与不可变", () => {
  it("snapshot/get 返回副本,外部改动不影响内部", () => {
    const registry = makeRegistry();
    register(registry, "u1", 1, "terminal");
    const list = registry.snapshot("s1");
    list[0].state = "closed";
    list.push({ ...list[0], unitId: "injected" });
    const unit = registry.get("u1");
    expect(unit?.state).toBe("running");
    expect(unit).not.toBe(registry.get("u1"));
    registry.snapshot("s1")[0].state = "closed";
    expect(registry.get("u1")?.state).toBe("running");
    expect(registry.stats().total).toBe(1);
  });

  it("register/beginClose 返回值也是副本", () => {
    const registry = makeRegistry();
    const registered = register(registry, "t1", 1, "terminal");
    if (registered.unit) registered.unit.generation = 99;
    const closed = registry.beginClose("s1");
    if (closed.units?.[0]) closed.units[0].state = "closed";
    expect(registry.get("t1")).toMatchObject({ generation: 1, state: "closing" });
  });

  it("不重排调用方传入的 restore 数组", () => {
    const rows: OwnerUnit[] = [
      { unitId: "w1", kind: "workflow", ownerSessionId: "s1", generation: 1, state: "running", registeredAt: 300 },
      { unitId: "t1", kind: "terminal", ownerSessionId: "s1", generation: 1, state: "running", registeredAt: 100 },
    ];
    const registry = makeRegistry();
    registry.restore(rows);
    expect(rows.map((unit) => unit.unitId)).toEqual(["w1", "t1"]);
    expect(registry.snapshot("s1").map((unit) => unit.unitId)).toEqual(["t1", "w1"]);
  });
});

describe("不抛错与确定性", () => {
  it("任意非法入参都不抛错", () => {
    const registry = makeRegistry();
    expect(() => registry.update("u", null as never)).not.toThrow();
    expect(registry.settle("u", null as never).code).toBe("NOT_FOUND");
    expect(registry.beginClose("").code).toBe("INVALID");
    expect(registry.completeClose(null as never).code).toBe("INVALID");
    expect(registry.closeByOwner(undefined as never).code).toBe("INVALID");
    expect(registry.canStart(null as never)).toBe(false);
    expect(registry.isStale(null as never, 1)).toBe(true);
    expect(registry.snapshot(null as never)).toEqual([]);
  });

  it("注入时钟抛错也不抛给调用方", () => {
    const registry = new OwnerRegistry({
      now: () => {
        throw new Error("clock down");
      },
    });
    const result = register(registry, "u1");
    expect(result.code).toBe("OK");
    expect(result.unit?.registeredAt).toBe(0);
  });

  it("确定性:同操作序列两次结果完全一致(含顺序)", () => {
    const run = () => {
      const registry = makeRegistry();
      register(registry, "w1", 1, "workflow");
      register(registry, "t2", 1, "terminal");
      register(registry, "t1", 1, "terminal");
      register(registry, "s1-unit", 1, "subagent");
      const closing = registry.beginClose("s1");
      registry.settle("t1", { generation: 1 });
      const done = registry.completeClose("s1");
      return {
        closing: closing.units?.map((unit) => unit.unitId),
        pending: done.pending,
        snapshot: registry.snapshot(),
        stats: registry.stats(),
      };
    };
    expect(run()).toEqual(run());
  });
});
