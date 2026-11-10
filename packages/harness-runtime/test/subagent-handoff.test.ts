/**
 * 子代理进程交接与委派分桶(纯逻辑,零 IO)。
 * 断言全部按 subagent-handoff.ts 的真实行为:交接四码(缺 purpose / 非 owner / 超限 / 非法)、
 * 纯函数不改入参、退出盘点三态、按 group 分桶但不扩张并发、每桶一条聚合消息、
 * default-off 时从 schema 整个删掉 group 字段,以及脏输入不抛。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROUP,
  DEFAULT_MAX_HANDOFFS,
  HANDOFF_CODES,
  HANDOFF_VERSION,
  coerceRegistry,
  delegateGroup,
  emptyRegistry,
  handoff,
  inventory,
  joinBucket,
  registerAgent,
  registerProcess,
  stripGroupField,
} from "../src/agent/subagent-handoff.ts";
import type { DelegateTask, ManagedProcess, Registry } from "../src/agent/subagent-handoff.ts";

/** 造一个 owner=a1 的台账:进程 p1。 */
function base(): Registry {
  return registerProcess(emptyRegistry(), { id: "p1", owner: "a1", purpose: "watcher" }).registry;
}

function ownerOf(registry: Registry, id: string): string | undefined {
  return registry.processes[id]?.owner;
}

function proc(registry: Registry, id: string): ManagedProcess {
  const value = registry.processes[id];
  if (value === undefined) throw new Error(`进程 ${id} 不存在`);
  return value;
}

describe("契约与空台账", () => {
  it("契约版本与稳定码集合固定(调用方按码分流)", () => {
    expect(HANDOFF_VERSION).toBe(1);
    expect(HANDOFF_CODES).toEqual([
      "HANDOFF_INVALID",
      "HANDOFF_HANDED_OFF",
      "HANDOFF_PURPOSE_REQUIRED",
      "HANDOFF_NOT_OWNER",
      "HANDOFF_LIMIT",
      "HANDOFF_INVENTORY",
      "HANDOFF_GROUP_ASSIGNED",
      "HANDOFF_GROUP_STRIPPED",
      "HANDOFF_JOINED",
    ]);
    expect(DEFAULT_MAX_HANDOFFS).toBe(3);
    expect(DEFAULT_GROUP).toBe("default");
  });

  it("空台账没有进程也没有代理", () => {
    const registry = emptyRegistry();
    expect(Object.keys(registry.processes)).toEqual([]);
    expect(Object.keys(registry.agents)).toEqual([]);
  });

  it("coerceRegistry 容忍脏数据:缺 owner 的进程被跳过、坏 agents 归一到默认上限", () => {
    const registry = coerceRegistry({
      processes: {
        p1: { owner: "a1" },
        bad: { handoffs: 1 },
        p2: "nope",
      },
      agents: { a1: { maxHandoffs: "x" } },
    });
    expect(Object.keys(registry.processes)).toEqual(["p1"]);
    expect(proc(registry, "p1").handoffs).toBe(0);
    expect(registry.agents.a1?.maxHandoffs).toBe(DEFAULT_MAX_HANDOFFS);
  });

  it("coerceRegistry 对非对象输入返回空台账,不抛", () => {
    expect(Object.keys(coerceRegistry(undefined).processes)).toEqual([]);
    expect(Object.keys(coerceRegistry("x").agents)).toEqual([]);
  });
});

describe("注册代理与进程", () => {
  it("registerAgent 缺省上限 3", () => {
    const registry = registerAgent(emptyRegistry(), "a1").registry;
    expect(registry.agents.a1?.maxHandoffs).toBe(3);
  });

  it("registerAgent 接受自定义上限,非法值回落到 3", () => {
    const custom = registerAgent(emptyRegistry(), "a1", { maxHandoffs: 5 }).registry;
    expect(custom.agents.a1?.maxHandoffs).toBe(5);
    const bad = registerAgent(emptyRegistry(), "a2", { maxHandoffs: 0 }).registry;
    expect(bad.agents.a2?.maxHandoffs).toBe(3);
  });

  it("registerAgent 空白 id 返回 HANDOFF_INVALID 且台账不变", () => {
    const registry = emptyRegistry();
    const result = registerAgent(registry, "   ");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("HANDOFF_INVALID");
    expect(result.registry).toBe(registry);
  });

  it("registerProcess 自动登记不存在的 owner,进程 handoffs 从 0 起", () => {
    const result = registerProcess(emptyRegistry(), { id: "p1", owner: "a1", purpose: "ci" });
    expect(result.ok).toBe(true);
    expect(result.registry.agents.a1?.maxHandoffs).toBe(3);
    expect(proc(result.registry, "p1")).toMatchObject({
      id: "p1",
      owner: "a1",
      purpose: "ci",
      handoffs: 0,
    });
  });

  it("registerProcess 同 id 重复登记被拒(HANDOFF_INVALID)", () => {
    const registry = base();
    const again = registerProcess(registry, { id: "p1", owner: "a2" });
    expect(again.ok).toBe(false);
    expect(again.code).toBe("HANDOFF_INVALID");
    expect(ownerOf(again.registry, "p1")).toBe("a1");
  });

  it("registerProcess 缺 owner 被拒", () => {
    const result = registerProcess(emptyRegistry(), { id: "p1" });
    expect(result.code).toBe("HANDOFF_INVALID");
  });
});

describe("handoff:锁内翻 owner", () => {
  it("成功交接:HANDED_OFF、owner 翻转、handoffs+1、handedOffFrom 记录旧 owner", () => {
    const before = base();
    const result = handoff(before, { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "长跑 CI" });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("HANDOFF_HANDED_OFF");
    expect(ownerOf(result.registry, "p1")).toBe("a2");
    expect(proc(result.registry, "p1")).toMatchObject({
      handoffs: 1,
      purpose: "长跑 CI",
      handedOffFrom: ["a1"],
    });
  });

  it("交接是纯函数:原 registry 与新 registry 不共享进程对象", () => {
    const before = base();
    const result = handoff(before, { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "x" });
    expect(ownerOf(before, "p1")).toBe("a1");
    expect(before.processes.p1).not.toBe(result.registry.processes.p1);
    expect(proc(before, "p1").handoffs).toBe(0);
  });

  it("交接自动登记未知的接手方(避免交接完立刻变孤儿)", () => {
    const result = handoff(base(), { processId: "p1", fromAgent: "a1", toAgent: "a9", purpose: "接管" });
    expect(result.registry.agents.a9?.maxHandoffs).toBe(3);
  });

  it("缺 purpose → HANDOFF_PURPOSE_REQUIRED,台账不变", () => {
    const before = base();
    const result = handoff(before, { processId: "p1", fromAgent: "a1", toAgent: "a2" });
    expect(result.code).toBe("HANDOFF_PURPOSE_REQUIRED");
    expect(result.registry).toBe(before);
    expect(ownerOf(before, "p1")).toBe("a1");
  });

  it("purpose 只有空白 → 同样 HANDOFF_PURPOSE_REQUIRED", () => {
    const result = handoff(base(), { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "  \t " });
    expect(result.code).toBe("HANDOFF_PURPOSE_REQUIRED");
  });

  it("非当前 owner 交接 → HANDOFF_NOT_OWNER(进程仍是原 owner)", () => {
    const since = handoff(base(), { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "第一次" }).registry;
    const stolen = handoff(since, { processId: "p1", fromAgent: "a1", toAgent: "a3", purpose: "抢" });
    expect(stolen.code).toBe("HANDOFF_NOT_OWNER");
    expect(stolen.ok).toBe(false);
    expect(ownerOf(stolen.registry, "p1")).toBe("a2");
  });

  it("同一进程累计 3 次交接后第 4 次 → HANDOFF_LIMIT", () => {
    let registry = base();
    registry = handoff(registry, { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "1" }).registry;
    registry = handoff(registry, { processId: "p1", fromAgent: "a2", toAgent: "a1", purpose: "2" }).registry;
    registry = handoff(registry, { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "3" }).registry;
    expect(proc(registry, "p1").handoffs).toBe(3);
    const fourth = handoff(registry, { processId: "p1", fromAgent: "a2", toAgent: "a1", purpose: "4" });
    expect(fourth.code).toBe("HANDOFF_LIMIT");
    expect(proc(fourth.registry, "p1").handoffs).toBe(3);
    expect(ownerOf(fourth.registry, "p1")).toBe("a2");
  });

  it("maxPerAgent 显式收紧上限(1 → 第 2 次即 LIMIT)", () => {
    const once = handoff(base(), { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "1" }, { maxPerAgent: 1 });
    expect(once.ok).toBe(true);
    const twice = handoff(once.registry, { processId: "p1", fromAgent: "a2", toAgent: "a1", purpose: "2" }, { maxPerAgent: 1 });
    expect(twice.code).toBe("HANDOFF_LIMIT");
  });

  it("代理自带 maxHandoffs 生效(5 → 第 4 次仍可交接)", () => {
    let registry = registerAgent(base(), "a1", { maxHandoffs: 5 }).registry;
    registry = registerAgent(registry, "a2", { maxHandoffs: 5 }).registry;
    registry = handoff(registry, { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "1" }).registry;
    registry = handoff(registry, { processId: "p1", fromAgent: "a2", toAgent: "a1", purpose: "2" }).registry;
    registry = handoff(registry, { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "3" }).registry;
    const fourth = handoff(registry, { processId: "p1", fromAgent: "a2", toAgent: "a1", purpose: "4" });
    expect(fourth.ok).toBe(true);
    expect(proc(fourth.registry, "p1").handoffs).toBe(4);
  });

  it("限制先看归属:非 owner 且已到上限时报 NOT_OWNER(不越权报 LIMIT)", () => {
    let registry = base();
    registry = handoff(registry, { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "1" }).registry;
    registry = handoff(registry, { processId: "p1", fromAgent: "a2", toAgent: "a1", purpose: "2" }).registry;
    registry = handoff(registry, { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "3" }).registry;
    const stranger = handoff(registry, { processId: "p1", fromAgent: "a1", toAgent: "a3", purpose: "x" });
    expect(stranger.code).toBe("HANDOFF_NOT_OWNER");
  });

  it("不存在的进程 → HANDOFF_INVALID", () => {
    const result = handoff(base(), { processId: "nope", fromAgent: "a1", toAgent: "a2", purpose: "x" });
    expect(result.code).toBe("HANDOFF_INVALID");
  });

  it("自己交给自己 → HANDOFF_INVALID(不算一次交接)", () => {
    const result = handoff(base(), { processId: "p1", fromAgent: "a1", toAgent: "a1", purpose: "x" });
    expect(result.code).toBe("HANDOFF_INVALID");
    expect(proc(result.registry, "p1").handoffs).toBe(0);
  });

  it("handedOffFrom 去重:来回踢也不重复记同一个代理", () => {
    let registry = base();
    registry = handoff(registry, { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "1" }).registry;
    registry = handoff(registry, { processId: "p1", fromAgent: "a2", toAgent: "a1", purpose: "2" }).registry;
    registry = handoff(registry, { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "3" }).registry;
    expect(proc(registry, "p1").handedOffFrom).toEqual(["a1", "a2"]);
  });
});

describe("inventory:退出盘点三态", () => {
  it("我交出去的进程进 handedOff(owner 已不是我)", () => {
    const registry = handoff(base(), { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "x" }).registry;
    const inv = inventory(registry, "a1");
    expect(inv.handedOff).toEqual(["p1"]);
    expect(inv.codes).toContain("HANDOFF_INVENTORY");
  });

  it("仍归我所有的进程不进 handedOff", () => {
    const inv = inventory(base(), "a1");
    expect(inv.handedOff).toEqual([]);
  });

  it("owner 已不在注册表 → orphaned(全局列表)", () => {
    const registry = coerceRegistry({ processes: { ghost: { owner: "died", handoffs: 2 } }, agents: {} });
    expect(inventory(registry, "a1").orphaned).toEqual(["ghost"]);
  });

  it("已注册 owner 的进程不算孤儿", () => {
    expect(inventory(base(), "a2").orphaned).toEqual([]);
  });

  it("unreadCompletions 由调用方计数传入,负数与缺省归 0", () => {
    expect(inventory(base(), "a1", { unreadCompletions: 7 }).unreadCompletions).toBe(7);
    expect(inventory(base(), "a1", { count: 2 }).unreadCompletions).toBe(2);
    expect(inventory(base(), "a1").unreadCompletions).toBe(0);
    expect(inventory(base(), "a1", { unreadCompletions: -3 }).unreadCompletions).toBe(0);
  });

  it("空白 agentId → HANDOFF_INVALID,不误报任何 handedOff", () => {
    const registry = handoff(base(), { processId: "p1", fromAgent: "a1", toAgent: "a2", purpose: "x" }).registry;
    const inv = inventory(registry, " ");
    expect(inv.codes).toContain("HANDOFF_INVALID");
    expect(inv.handedOff).toEqual([]);
    expect(inv.agentId).toBe("");
  });
});

describe("delegateGroup:分桶不改变并发计费", () => {
  const tasks: DelegateTask[] = [
    { id: "t1", group: "g1", agentId: "a1" },
    { id: "t2", group: "g2", agentId: "a2" },
    { id: "t3", group: "g1", agentId: "a3" },
    { id: "t4", group: "g2", agentId: "a4" },
  ];

  it("4 任务 2 组 → 2 个桶,joinOrder 按首次出现顺序", () => {
    const plan = delegateGroup({ tasks, concurrency: 4 });
    expect(Object.keys(plan.buckets)).toEqual(["g1", "g2"]);
    expect(plan.joinOrder).toEqual(["g1", "g2"]);
    expect(plan.buckets.g1?.map((task) => task.id)).toEqual(["t1", "t3"]);
    expect(plan.buckets.g2?.map((task) => task.id)).toEqual(["t2", "t4"]);
    expect(plan.codes).toEqual(["HANDOFF_GROUP_ASSIGNED"]);
  });

  it("并发预算不因分桶扩张:concurrency 原样保留,slots=min(concurrency,桶数)", () => {
    const plan = delegateGroup({ tasks, concurrency: 1 });
    expect(plan.concurrency).toBe(1);
    expect(plan.slots).toBe(1);
    const wide = delegateGroup({ tasks, concurrency: 8 });
    expect(wide.concurrency).toBe(8);
    expect(wide.slots).toBe(2);
  });

  it("任务没有 group 时落到入参 group,再没有就落 default", () => {
    const plan = delegateGroup({ tasks: [{ id: "t1", agentId: "a1" }], group: "batch" });
    expect(plan.joinOrder).toEqual(["batch"]);
    const fallback = delegateGroup({ tasks: [{ id: "t2", agentId: "a2" }] });
    expect(fallback.joinOrder).toEqual([DEFAULT_GROUP]);
  });

  it("空任务集 → 无桶、slots 0、HANDOFF_INVALID", () => {
    const plan = delegateGroup({ tasks: [] });
    expect(plan.joinOrder).toEqual([]);
    expect(plan.slots).toBe(0);
    expect(plan.codes).toContain("HANDOFF_INVALID");
  });

  it("非法任务被跳过,不改入参数组", () => {
    const input: DelegateTask[] = [{ id: "t1", agentId: "a1" }, { id: "", agentId: "a1" }];
    const plan = delegateGroup({ tasks: input, concurrency: 2 });
    expect(plan.buckets[DEFAULT_GROUP]?.length).toBe(1);
    expect(input).toHaveLength(2);
  });
});

describe("joinBucket:每桶一条聚合消息", () => {
  it("同桶任务按完成顺序聚合成一条消息", () => {
    const join = joinBucket(
      [
        { taskId: "t1", group: "g1", ok: true, output: "3 files" },
        { taskId: "t3", group: "g1", ok: true },
      ],
      "g1",
    );
    expect(join.joined).toBe(2);
    expect(join.failed).toBe(0);
    expect(join.ok).toBe(true);
    expect(join.taskIds).toEqual(["t1", "t3"]);
    expect(join.message).toBe("g1: 2/2 完成 · t1 完成(3 files); t3 完成");
    expect(join.code).toBe("HANDOFF_JOINED");
  });

  it("其它桶的结果不混进来", () => {
    const join = joinBucket(
      [
        { taskId: "t1", group: "g1", ok: true },
        { taskId: "t2", group: "g2", ok: true },
      ],
      "g2",
    );
    expect(join.taskIds).toEqual(["t2"]);
  });

  it("失败任务计入 failed 且整桶 ok=false", () => {
    const join = joinBucket(
      [
        { taskId: "t1", group: "g1", ok: true },
        { taskId: "t2", group: "g1", ok: false, output: "tsc error" },
      ],
      "g1",
    );
    expect(join.failed).toBe(1);
    expect(join.ok).toBe(false);
    expect(join.message).toContain("t2 失败(tsc error)");
  });

  it("未回报(ok 缺省)算待回报,不当成功", () => {
    const join = joinBucket(
      [
        { taskId: "t1", group: "g1" },
        { taskId: "t2", group: "g1" },
      ],
      "g1",
    );
    expect(join.joined).toBe(2);
    expect(join.ok).toBe(false);
    expect(join.message).toBe("g1: 0/2 完成 · 2 待回报 · t1 待回报; t2 待回报");
  });

  it("空桶也返回一条消息(不返回 null)", () => {
    const join = joinBucket([], "g9");
    expect(join.joined).toBe(0);
    expect(join.message).toBe("g9: 0/0 完成(无任务)");
  });
});

describe("stripGroupField:default-off 时整个删字段", () => {
  const schema = {
    type: "object",
    properties: {
      group: { type: "string" },
      agentId: { type: "string" },
    },
    required: ["group", "agentId"],
  };

  it("defaultOff=true 时 properties.group 与 required 里的 group 都被删掉", () => {
    const result = stripGroupField(schema, { defaultOff: true });
    expect(result.stripped).toBe(true);
    expect(result.codes).toEqual(["HANDOFF_GROUP_STRIPPED"]);
    const next = result.schema as { properties: Record<string, unknown>; required: string[] };
    expect("group" in next.properties).toBe(false);
    expect(next.properties.agentId).toEqual({ type: "string" });
    expect(next.required).toEqual(["agentId"]);
  });

  it("不改原 schema(纯函数)", () => {
    stripGroupField(schema, { defaultOff: true });
    expect("group" in schema.properties).toBe(true);
    expect(schema.required).toEqual(["group", "agentId"]);
  });

  it("未开 default-off 时原样返回(stripped=false)", () => {
    const result = stripGroupField(schema, { defaultOff: false });
    expect(result.stripped).toBe(false);
    expect(result.schema).toBe(schema);
    expect(result.codes).toEqual([]);
  });

  it("schema 本来没有 group → stripped=false(不是错误)", () => {
    const result = stripGroupField({ type: "object", properties: { x: {} } }, { defaultOff: true });
    expect(result.stripped).toBe(false);
    expect(result.codes).toEqual([]);
  });

  it("非对象 schema → HANDOFF_INVALID 且不抛", () => {
    const result = stripGroupField("not-a-schema", { defaultOff: true });
    expect(result.stripped).toBe(false);
    expect(result.codes).toEqual(["HANDOFF_INVALID"]);
  });
});
