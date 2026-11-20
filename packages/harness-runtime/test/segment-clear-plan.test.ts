import { describe, it, expect } from "vitest";
import { microcompactMessages, planSegmentBatch, type MicrocompactConfig } from "../src/agent/microcompact";
import type { Message } from "../src/agent/loop";

/**
 * 段批档(§4.1.3 攒批真裁):segmentClearPlan 命中的组被清占位、
 * 未命中项逐字不动;经济门已在 settle 处裁决(此处只守前缀稳定门)。
 * cache-aware 路径:decideReset 段批档 → renderFrozenAndTail(clearAllGroups)执行。
 */

/** 构造:group(id, path, chars) = assistant toolCall + tool 结果。 */
function group(id: string, path: string, chars: number): Message[] {
  return [
    {
      role: "assistant" as never,
      content: "",
      toolCalls: [{ id, name: "read_file", arguments: JSON.stringify({ path, offset: 1, limit: 2000 }) }],
    },
    { role: "tool", toolCallId: id, content: "D".repeat(chars) },
  ];
}

describe("segment-clear-plan(段批档,cache-aware 路径)", () => {
  it("plan 命中组被清占位,未命中项逐字不动;reason=segment-applied", () => {
    const messages: Message[] = [
      { role: "user", content: "q" },
      ...group("c1", "src/old1.ts", 20_000),
      ...group("cmid", "src/open-seg.ts", 6_000), // 开放段:夹在两个 plan 命中组之间(冻结切片内)
      ...group("c2", "src/old2.ts", 20_000),
      ...group("c3", "src/recent.ts", 6_000), // 开放段:冻结边界之后
    ];
    const plan = new Set(["c1", "c2"]); // settle 批准 c1/c2;cmid/c3 未裁决
    const config: MicrocompactConfig = {
      thresholdTokens: 10_000,
      segmentClearPlan: plan,
      policyState: { clock: 5, turnStart: true, frozenCount: 0, resetsThisTurn: 0 },
      minContextTokens: 1, // 测试:绕过低上下文门槛
      pruneMinBatchTokens: 1, // 测试:绕过最小批量
      maxResetCutRatio: 0.9, // 测试:两组都过 20% 削减上限(默认 0.2 只放行一组)
    };
    const res = microcompactMessages(messages, config);
    expect(res.reason).toBe("segment-applied");
    const cleared = (res.pruned ?? []).filter((p) => p.action === "cleared");
    const clearedIds = new Set(cleared.map((p) => p.toolCallId));
    expect(clearedIds.has("c1")).toBe(true);
    expect(clearedIds.has("c2")).toBe(true);
    expect(clearedIds.has("c3")).toBe(false); // 未命中逐字不动(开放段)
    expect(clearedIds.has("cmid")).toBe(false); // 冻结切片内的开放段组也逐字保留(§4.1.3:开放段一个字节不动)
 // cmid/c3 原文仍在
    const midMsg = res.messages.find((m) => m.role === "tool" && m.toolCallId === "cmid");
    expect(midMsg?.content).toBe("D".repeat(6_000));
    const c3msg = res.messages.find((m) => m.role === "tool" && m.toolCallId === "c3");
    expect(c3msg?.content).toBe("D".repeat(6_000));
 // prefixBreak=true(reset 语义:冻结区推进)
    expect(res.prefixBreak).toBe(true);
  });

  it("plan 命中为空(候选已被折叠):segment-empty,计划作废不重试", () => {
    const messages: Message[] = [
      { role: "user", content: "q" },
      ...group("c9", "src/ghost.ts", 20_000),
    ];
    const config: MicrocompactConfig = {
      thresholdTokens: 10_000,
      segmentClearPlan: new Set(["nonexistent"]),
      policyState: { clock: 5, turnStart: true, frozenCount: 0, resetsThisTurn: 0 },
      minContextTokens: 1,
    };
    const res = microcompactMessages(messages, config);
    expect(res.reason).toBe("segment-empty");
    expect(res.prefixBreak).toBe(false); // skip 档:policy=append-only,prefixBreak=false(未破前缀)
  });

  it("冷却期内不动前缀:cooldown-skip,计划保留(不消费)", () => {
    const messages: Message[] = [
      { role: "user", content: "q" },
      ...group("c1", "src/old1.ts", 20_000),
    ];
    const config: MicrocompactConfig = {
      thresholdTokens: 10_000,
      segmentClearPlan: new Set(["c1"]),
 // lastResetClock=4、clock=5 → stepsSince=1 <20 且 growth <50000 → 冷却拦截
      policyState: { clock: 5, turnStart: false, frozenCount: 0, resetsThisTurn: 0, lastResetClock: 4, lastResetTokens: 90_000 },
      minContextTokens: 1,
    };
    const res = microcompactMessages(messages, config);
    expect(res.reason).toBe("cooldown-skip");
  });

  it("段批档免旧 benefit 门:正常 reset 档会拦的小额削减,段批照放(settle 已裁决)", () => {
 // est ≈ 15k×3 组 + user ≈ 45k;cutTarget 大概率被 benefit 门拦(cut×10 < est),
 // 但段批档跳过 benefit 门直接按 plan 清。
    const messages: Message[] = [
      { role: "user", content: "q" },
      ...group("c1", "src/old1.ts", 15_000),
      ...group("c2", "src/old2.ts", 15_000),
    ];
    const config: MicrocompactConfig = {
      thresholdTokens: 30_000,
      segmentClearPlan: new Set(["c1"]),
      policyState: { clock: 5, turnStart: true, frozenCount: 0, resetsThisTurn: 0 },
      minContextTokens: 1,
      pruneMinBatchTokens: 1,
      maxResetCutRatio: 0.9, // 测试:单组削减过 20% 上限(默认只放行部分)
      assumedRemainingCalls: 1, // benefit 门最严:cut×1 < est 必拦——段批档应绕过
    };
    const res = microcompactMessages(messages, config);
    expect(res.reason).toBe("segment-applied");
    const cleared = (res.pruned ?? []).filter((p) => p.action === "cleared");
    expect(cleared.map((p) => p.toolCallId)).toContain("c1");
  });

  it("段批档不被 minContext 门槛挡住:小上下文(≈6k tok)也按 settle 批准的计划执行", () => {
 // threshold=10k → 默认 minContext=min(110k, 9k)=9k;本夹具约 6k tok < 9k。
 // 普通阈值清理此时应 low-context-skip;但段批已由经济门裁决,不应再被兜底阀拦住。
    const messages: Message[] = [
      { role: "user", content: "q" },
      ...group("c1", "src/old1.ts", 12_000),
      ...group("c2", "src/old2.ts", 12_000),
    ];
    const config: MicrocompactConfig = {
      thresholdTokens: 10_000,
      segmentClearPlan: new Set(["c1"]),
      policyState: { clock: 5, turnStart: true, frozenCount: 0, resetsThisTurn: 0 },
 // 故意不传 minContextTokens:走默认兜底阀(9k)
      pruneMinBatchTokens: 1,
      maxResetCutRatio: 0.9,
    };
    const res = microcompactMessages(messages, config);
    expect(res.reason).toBe("segment-applied");
    expect(res.pruned?.some((p) => p.action === "cleared" && p.toolCallId === "c1")).toBe(true);
  });

  it("planSegmentBatch:候选命中边界内的全部可清组都进 ids/W(与 executor 同批)", () => {
    const messages: Message[] = [
      { role: "user", content: "q" },
      ...group("c1", "src/old1.ts", 20_000),
      ...group("c2", "src/old2.ts", 20_000),
      ...group("c3", "src/recent.ts", 20_000),
    ];
    const onlyC1 = planSegmentBatch(messages, new Set(["c1"]));
    expect(onlyC1?.ids).toEqual(["c1"]); // 边界只到 c1
    const onlyC2 = planSegmentBatch(messages, new Set(["c2"]));
    expect(onlyC2?.ids).toEqual(["c1", "c2"]); // 边界到 c2,边界内 c1 也会被冻结重放清掉
    expect(onlyC2!.w).toBeGreaterThan(0);
    expect(planSegmentBatch(messages, new Set(["missing"]))).toBeUndefined();

 // gate 用的 plan.ids 必须等于 executor 实际清除集合
    const plan = onlyC2!;
    const config: MicrocompactConfig = {
      thresholdTokens: 10_000,
      segmentClearPlan: new Set(plan.ids),
      policyState: { clock: 5, turnStart: true, frozenCount: 0, resetsThisTurn: 0 },
      minContextTokens: 1,
    };
    const res = microcompactMessages(messages, config);
    const cleared = new Set((res.pruned ?? []).filter((p) => p.action === "cleared").map((p) => p.toolCallId));
    expect([...cleared].sort()).toEqual([...plan.ids].sort());
  });

  it("温区第一手段:segmentSummaryPlan 有摘要时用摘要替换,无摘要回落占位", () => {
    const messages: Message[] = [
      { role: "user", content: "q" },
      ...group("c1", "src/old1.ts", 20_000),
      ...group("c2", "src/old2.ts", 20_000),
    ];
    const config: MicrocompactConfig = {
      thresholdTokens: 10_000,
      segmentClearPlan: new Set(["c1", "c2"]),
      segmentSummaryPlan: new Map([["c1", "关键结论:旧实现是 O(n)\n精确锚点:src/old1.ts:10"]]),
      policyState: { clock: 5, turnStart: true, frozenCount: 0, resetsThisTurn: 0 },
      minContextTokens: 1,
      pruneMinBatchTokens: 1,
      maxResetCutRatio: 0.9,
    };
    const res = microcompactMessages(messages, config);
    expect(res.reason).toBe("segment-applied");
    const c1 = res.messages.find((m) => m.role === "tool" && m.toolCallId === "c1");
    const c2 = res.messages.find((m) => m.role === "tool" && m.toolCallId === "c2");
    expect(String(c1?.content)).toContain("[段批摘要:");
    expect(String(c1?.content)).toContain("关键结论:旧实现是 O(n)");
    expect(String(c1?.content)).toContain("src/old1.ts:10");
    expect(String(c1?.content)).not.toContain("[工具结果已清除");
 // 无摘要条目的兜底轨仍是确定性占位
    expect(String(c2?.content)).toContain("[工具结果已清除");
  });
});
