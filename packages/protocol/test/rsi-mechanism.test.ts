/**
 * RSI 机制治理面协议测试( RSI-MECH):
 * ①四条请求 + 三条应答各自合法载荷 parse 成功、非法载荷拒绝;
 * ②旧 rsi.status.result(不带 enabled/driver/items/run)仍能 parse —— 向后兼容硬门;
 * ③新 section 带 enabled/driver/items/run 能 parse;
 * ④ClientMessage / ServerMessage 联合能收下新 type。
 */
import { describe, expect, it } from "vitest";
import {
  ClientMessage,
  PROTOCOL_VERSION,
  RsiItemDelete,
  RsiItemResult,
  RsiItemUpdate,
  RsiMechanismRun,
  RsiMechanismRunResult,
  RsiMechanismSet,
  RsiMechanismSetResult,
  RsiStatusResult,
  ServerMessage,
} from "../src/index.js";

const v = PROTOCOL_VERSION;

describe("rsi.mechanism.set", () => {
  it("接受 enabled / driver", () => {
    const r = RsiMechanismSet.safeParse({ v, type: "rsi.mechanism.set", id: "nightly", enabled: false, driver: "agent" });
    expect(r.success).toBe(true);
  });
  it("接受只改 enabled", () => {
    expect(RsiMechanismSet.safeParse({ v, type: "rsi.mechanism.set", id: "cost", enabled: true }).success).toBe(true);
  });
  it("拒绝非法 driver 与缺 id", () => {
    expect(RsiMechanismSet.safeParse({ v, type: "rsi.mechanism.set", id: "x", driver: "llm" }).success).toBe(false);
    expect(RsiMechanismSet.safeParse({ v, type: "rsi.mechanism.set", enabled: true }).success).toBe(false);
  });
  it("应答 parse 成功", () => {
    const r = RsiMechanismSetResult.safeParse({ v, type: "rsi.mechanism.set.result", ok: true, id: "nightly", enabled: true, driver: "agent" });
    expect(r.success).toBe(true);
  });
});

describe("rsi.mechanism.run / rsi.item.*", () => {
  it("run 请求与应答", () => {
    expect(RsiMechanismRun.safeParse({ v, type: "rsi.mechanism.run", id: "pathology" }).success).toBe(true);
    expect(RsiMechanismRun.safeParse({ v, type: "rsi.mechanism.run" }).success).toBe(false);
    expect(
      RsiMechanismRunResult.safeParse({ v, type: "rsi.mechanism.run.result", ok: false, id: "pathology", reason: "MODEL_UNAVAILABLE" }).success).toBe(true);
  });
  it("item.update / item.delete 字段约束", () => {
    expect(
      RsiItemUpdate.safeParse({ v, type: "rsi.item.update", mechanismId: "cohort", itemId: "r1:i0", summary: "改过的摘要", status: "warn" }).success).toBe(true);
    expect(RsiItemUpdate.safeParse({ v, type: "rsi.item.update", mechanismId: "cohort", itemId: "r1:i0", status: "weird" }).success).toBe(false);
    expect(RsiItemDelete.safeParse({ v, type: "rsi.item.delete", mechanismId: "cohort", itemId: "r1:i0" }).success).toBe(true);
    expect(RsiItemDelete.safeParse({ v, type: "rsi.item.delete", mechanismId: "cohort" }).success).toBe(false);
  });
  it("item.result 可带最新投影", () => {
    const r = RsiItemResult.safeParse({
      v,
      type: "rsi.item.result",
      ok: true,
      mechanismId: "cohort",
      itemId: "r1:i0",
      items: [{ id: "r1:i0", title: "一次通过率", summary: "92%", status: "ok", source: "agent", at: 1 }],
    });
    expect(r.success).toBe(true);
  });
});

describe("rsi.status.result 向后兼容", () => {
  const base = {
    v,
    type: "rsi.status.result",
    at: 1,
    okCount: 1,
    warnCount: 0,
    sections: [{ id: "nightly", title: "夜间任务", ok: true, metrics: [{ label: "候选", value: 5 }], warnings: [] }],
  };
  it("旧载荷(无 enabled/driver/items/run)仍通过", () => {
    expect(RsiStatusResult.safeParse(base).success).toBe(true);
  });
  it("带 enabled/driver/items/run 的 section 通过", () => {
    const r = RsiStatusResult.safeParse({
      ...base,
      sections: [
        {
          ...base.sections[0],
          enabled: true,
          driver: "agent",
          items: [{ id: "r1:i0", title: "t", summary: "s", status: "info", source: "agent", at: 2 }],
          run: { runId: "r1", status: "done", startedAt: 1, finishedAt: 2 },
        },
      ],
    });
    expect(r.success).toBe(true);
  });
  it("非法 run.status 拒绝", () => {
    const r = RsiStatusResult.safeParse({ ...base, sections: [{ ...base.sections[0], run: { status: "idle" } }] });
    expect(r.success).toBe(false);
  });
});

describe("run.cost / run.analysis(2026-11-12 RSI-SESSION-COST)", () => {
  const base = {
    v,
    type: "rsi.status.result",
    at: 1,
    okCount: 1,
    warnCount: 0,
    sections: [{ id: "nightly", title: "夜间任务", ok: true, metrics: [], warnings: [] }],
  };
  const section = (run: Record<string, unknown>) => RsiStatusResult.safeParse({ ...base, sections: [{ ...base.sections[0], run }] });
  const cost = {
    inputTokens: 8000,
    cachedTokens: 3000,
    outputTokens: 1345,
    totalTokens: 12345,
    cacheCreationTokens: 100,
    model: "gpt-x",
    amountCny: 0.1234,
    missing: [],
  };
  it("带成本与金额的 run 通过", () => {
    expect(section({ status: "done", cost }).success).toBe(true);
  });
  it("单价缺失:amountCny=null + missing 列段名仍通过(不按 0 冒充)", () => {
    const r = section({ status: "done", cost: { ...cost, amountCny: null, missing: ["output"] } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.sections[0]!.run!.cost!.amountCny).toBeNull();
  });
  it("cost 缺 amountCny/missing 拒绝(不允许静默按 0)", () => {
    const { amountCny: _a, ...noAmount } = cost;
    expect(section({ status: "done", cost: noAmount }).success).toBe(false);
    const { missing: _m, ...noMissing } = cost;
    expect(section({ status: "done", cost: noMissing }).success).toBe(false);
  });
  it("analysis:候选/已分析都收,lastActiveAt 可缺", () => {
    const r = section({
      status: "done",
      analysis: {
        windowDays: 3,
        candidates: [{ sessionId: "s1", projectId: "__harness__", lastActiveAt: 2 }, { sessionId: "s2" }],
        analyzed: [{ sessionId: "s1", projectId: "__harness__" }],
      },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.sections[0]!.run!.analysis!.analyzed[0]).toEqual({ sessionId: "s1", projectId: "__harness__" });
  });
  it("analysis 缺 sessionId 拒绝", () => {
    const r = section({ status: "done", analysis: { windowDays: 3, candidates: [{ projectId: "p" }], analyzed: [] } });
    expect(r.success).toBe(false);
  });
});

describe("联合类型收编", () => {
  it("ClientMessage 收下四条新请求", () => {
    const raws = [
      { v, type: "rsi.mechanism.set", id: "tools", enabled: false },
      { v, type: "rsi.mechanism.run", id: "tools" },
      { v, type: "rsi.item.update", mechanismId: "tools", itemId: "x", title: "t" },
      { v, type: "rsi.item.delete", mechanismId: "tools", itemId: "x" },
    ];
    for (const raw of raws) expect(ClientMessage.safeParse(raw).success).toBe(true);
  });
  it("ServerMessage 收下三条新应答", () => {
    const raws = [
      { v, type: "rsi.mechanism.set.result", ok: true, id: "tools" },
      { v, type: "rsi.mechanism.run.result", ok: true, id: "tools" },
      { v, type: "rsi.item.result", ok: true, mechanismId: "tools", itemId: "x" },
    ];
    for (const raw of raws) expect(ServerMessage.safeParse(raw).success).toBe(true);
  });
});
