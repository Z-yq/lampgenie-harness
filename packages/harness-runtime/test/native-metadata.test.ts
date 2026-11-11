/**
 * 原生元数据降级 + overflow 单次守卫(纯逻辑单测)。
 * 覆盖:三判据(同模型/模型不符/失败轮)、降级不可变与确定性、投影、head 文本化、
 * overflow 单次/durable/表面缩减才放行、以及「确定性/不 throw/不改入参」边界。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { deriveMessages } from "../src/agent/loop";
import {
  NATIVE_METADATA_CODES,
  NATIVE_METADATA_FIELDS,
  HEAD_TEXT_CHECKPOINT_LIMIT,
  OverflowOnceGuard,
  degradeMessageNativeMetadata,
  projectMessagesForProvider,
  projectionCodeOf,
  serializeHeadAsTextCheckpoint,
  shouldReplayNativeMetadata,
} from "../src/agent/native-metadata";

type AnyMsg = Record<string, unknown>;

const nativeAssistant = (over: AnyMsg = {}): AnyMsg => ({
  role: "assistant",
  content: "思考后的回答",
  toolCalls: [{ id: "t1", name: "read_file", arguments: "{}" }],
  model: "m-a",
  reasoning: "这是思考过程",
  providerMetadata: { vendor: "x" },
  thinkingBlocks: [{ type: "thinking" }],
  providerItemId: "item-1",
  ...over,
});

describe("NATIVE_METADATA_CODES", () => {
  it("四个码固定顺序", () => {
    expect([...NATIVE_METADATA_CODES]).toEqual(["OK", "MODEL_MISMATCH", "ERROR_TURN", "DEGRADED"]);
  });
  it("字段白名单含 4 个原生字段", () => {
    expect([...NATIVE_METADATA_FIELDS]).toEqual(["reasoning", "providerMetadata", "thinkingBlocks", "providerItemId"]);
  });
});

describe("shouldReplayNativeMetadata 三判据", () => {
  it("同模型且无错 → OK/replay", () => {
    const d = shouldReplayNativeMetadata({ messageModel: "m-a", currentModel: "m-a" });
    expect(d.replay).toBe(true);
    expect(d.code).toBe("OK");
    expect(d.reason.length).toBeGreaterThan(0);
  });
  it("缺 messageModel → MODEL_MISMATCH", () => {
    const d = shouldReplayNativeMetadata({ currentModel: "m-a" });
    expect(d.replay).toBe(false);
    expect(d.code).toBe("MODEL_MISMATCH");
  });
  it("缺 currentModel → MODEL_MISMATCH", () => {
    const d = shouldReplayNativeMetadata({ messageModel: "m-a" });
    expect(d).toMatchObject({ replay: false, code: "MODEL_MISMATCH" });
  });
  it("两者都缺 → MODEL_MISMATCH(宁降级不冒险)", () => {
    expect(shouldReplayNativeMetadata({})).toMatchObject({ replay: false, code: "MODEL_MISMATCH" });
  });
  it("空串模型视为缺失", () => {
    expect(shouldReplayNativeMetadata({ messageModel: "", currentModel: "m-a" }).code).toBe("MODEL_MISMATCH");
  });
  it("模型不一致 → MODEL_MISMATCH", () => {
    const d = shouldReplayNativeMetadata({ messageModel: "m-a", currentModel: "m-b" });
    expect(d).toMatchObject({ replay: false, code: "MODEL_MISMATCH" });
    expect(d.reason).toContain("m-a");
  });
  it("同模型但失败标记 → ERROR_TURN", () => {
    expect(shouldReplayNativeMetadata({ messageModel: "m-a", currentModel: "m-a", messageHadError: true }))
      .toMatchObject({ replay: false, code: "ERROR_TURN" });
  });
  it("模型不一致 + 失败标记 → 先报 MODEL_MISMATCH(判据顺序固定)", () => {
    expect(shouldReplayNativeMetadata({ messageModel: "m-a", currentModel: "m-b", messageHadError: true }).code)
      .toBe("MODEL_MISMATCH");
  });
  it("messageHadError=false 不阻挡回放", () => {
    expect(shouldReplayNativeMetadata({ messageModel: "m", currentModel: "m", messageHadError: false }).replay).toBe(true);
  });
  it("deterministic:同输入两次结果一致", () => {
    const i = { messageModel: "m-a", currentModel: "m-b", messageHadError: true };
    expect(shouldReplayNativeMetadata(i)).toEqual(shouldReplayNativeMetadata(i));
  });
});

describe("projectionCodeOf", () => {
  it("回放 → OK", () => {
    expect(projectionCodeOf(shouldReplayNativeMetadata({ messageModel: "m", currentModel: "m" }))).toBe("OK");
  });
  it("降级 → DEGRADED", () => {
    expect(projectionCodeOf(shouldReplayNativeMetadata({ messageModel: "m", currentModel: "n" }))).toBe("DEGRADED");
  });
});

describe("degradeMessageNativeMetadata", () => {
  it("剥离 reasoning 但保留 content/toolCalls", () => {
    const out = degradeMessageNativeMetadata(nativeAssistant());
    expect(out["reasoning"]).toBeUndefined();
    expect(out["content"]).toBe("思考后的回答");
    expect(out["toolCalls"]).toEqual([{ id: "t1", name: "read_file", arguments: "{}" }]);
  });
  it("剥离 providerMetadata/thinkingBlocks/providerItemId", () => {
    const out = degradeMessageNativeMetadata(nativeAssistant());
    expect(out["providerMetadata"]).toBeUndefined();
    expect(out["thinkingBlocks"]).toBeUndefined();
    expect(out["providerItemId"]).toBeUndefined();
  });
  it("不修改入参(不可变)", () => {
    const src = nativeAssistant();
    degradeMessageNativeMetadata(src);
    expect(src["reasoning"]).toBe("这是思考过程");
    expect(src["providerItemId"]).toBe("item-1");
  });
  it("有原生字段时返回新对象", () => {
    const src = nativeAssistant();
    expect(degradeMessageNativeMetadata(src)).not.toBe(src);
  });
  it("无原生字段时原样返回同一引用", () => {
    const plain = { role: "assistant", content: "hi", toolCalls: [] };
    expect(degradeMessageNativeMetadata(plain)).toBe(plain);
  });
  it("deterministic:两次降级 JSON 相同", () => {
    const src = nativeAssistant();
    expect(JSON.stringify(degradeMessageNativeMetadata(src))).toBe(JSON.stringify(degradeMessageNativeMetadata(src)));
  });
});

describe("projectMessagesForProvider", () => {
  it("同模型 assistant 原样保留", () => {
    const m = nativeAssistant();
    const out = projectMessagesForProvider([m], { currentModel: "m-a" });
    expect(out[0]).toBe(m);
  });
  it("换模型 → 降级且 reasoning 去掉、content 保留", () => {
    const out = projectMessagesForProvider([nativeAssistant()], { currentModel: "m-b" });
    expect(out[0]!["reasoning"]).toBeUndefined();
    expect(out[0]!["content"]).toBe("思考后的回答");
  });
  it("failedModels 命中 → 降级", () => {
    const out = projectMessagesForProvider([nativeAssistant()], { currentModel: "m-a", failedModels: ["m-a"] });
    expect(out[0]!["reasoning"]).toBeUndefined();
  });
  it("无 currentModel → 保守降级", () => {
    const out = projectMessagesForProvider([nativeAssistant()], {});
    expect(out[0]!["reasoning"]).toBeUndefined();
  });
  it("user/tool 等非 assistant 消息原样保留", () => {
    const u = { role: "user", content: "问题", reasoning: "不该出现在 user 上" };
    const out = projectMessagesForProvider([u], { currentModel: "m-b" });
    expect(out[0]).toBe(u);
  });
  it("总是返回新数组", () => {
    const msgs = [{ role: "user", content: "a" }];
    expect(projectMessagesForProvider(msgs, { currentModel: "m" })).not.toBe(msgs);
  });
  it("不改入参且确定性", () => {
    const msgs = [nativeAssistant(), { role: "user", content: "q" }];
    const a = projectMessagesForProvider(msgs, { currentModel: "m-b" });
    const b = projectMessagesForProvider(msgs, { currentModel: "m-b" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(msgs[0]!["reasoning"]).toBe("这是思考过程");
  });
});

describe("serializeHeadAsTextCheckpoint", () => {
  it("按 [role] content 逐行输出且不含原生字段", () => {
    const text = serializeHeadAsTextCheckpoint([nativeAssistant(), { role: "user", content: "问题" }]);
    const lines = text.split("\n");
    expect(lines).toEqual(["[assistant] 思考后的回答", "[user] 问题"]);
    expect(text).not.toContain("这是思考过程");
    expect(text).not.toContain("providerItemId");
  });
  it("超长 content 按 6000 字截断", () => {
    const long = "x".repeat(HEAD_TEXT_CHECKPOINT_LIMIT + 100);
    const text = serializeHeadAsTextCheckpoint([{ role: "assistant", content: long }]);
    expect(text.length).toBeLessThanOrEqual(HEAD_TEXT_CHECKPOINT_LIMIT + "[assistant] ".length + 1);
    expect(text.endsWith("…")).toBe(true);
  });
  it("空数组 → 空串;非字符串 content 按空串处理", () => {
    expect(serializeHeadAsTextCheckpoint([])).toBe("");
    expect(serializeHeadAsTextCheckpoint([{ role: "user" }])).toBe("[user] ");
  });
});

describe("deriveMessages 接入(loop.ts 行为面)", () => {
  const journalOf = (agentPayload: AnyMsg): MemoryJournal => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s", payload: { text: "问" } });
    j.append({ kind: "message.agent", sessionId: "s", payload: { text: "答", reasoning: "思考", ...agentPayload } });
    return j;
  };
  it("不传 currentModel = 旧行为逐字不变(reasoning 照带)", () => {
    const out = deriveMessages(journalOf({ model: "m-a" }), "s");
    expect(out[1]).toMatchObject({ role: "assistant", reasoning: "思考" });
  });
  it("同模型无错 → reasoning 保留", () => {
    const out = deriveMessages(journalOf({ model: "m-a" }), "s", { currentModel: "m-a" });
    expect(out[1]).toMatchObject({ role: "assistant", reasoning: "思考" });
  });
  it("换模型 → reasoning 被降级去掉、content 保留", () => {
    const out = deriveMessages(journalOf({ model: "m-a" }), "s", { currentModel: "m-b" });
    expect((out[1] as AnyMsg)["reasoning"]).toBeUndefined();
    expect(out[1]!.content).toBe("答");
  });
  it("同模型但 payload 带失败标记 → ERROR_TURN 降级", () => {
    const out = deriveMessages(journalOf({ model: "m-a", error: "boom" }), "s", { currentModel: "m-a" });
    expect((out[1] as AnyMsg)["reasoning"]).toBeUndefined();
  });
});

describe("OverflowOnceGuard", () => {
  it("首次 overflow 无 durable → compact-and-replay/OK_COMPACT", () => {
    const g = new OverflowOnceGuard();
    expect(g.next({ turn: 1, durableOutputTokens: 0, overflow: true }))
      .toMatchObject({ action: "compact-and-replay", code: "OK_COMPACT" });
  });
  it("同一 turn 第二次 overflow → OVERFLOW_REPEAT/terminal", () => {
    const g = new OverflowOnceGuard();
    g.next({ turn: 1, overflow: true });
    expect(g.next({ turn: 1, overflow: true }))
      .toMatchObject({ action: "terminal", code: "OVERFLOW_REPEAT" });
  });
  it("durable 输出 > 0 → DURABLE_OUTPUT/terminal", () => {
    const g = new OverflowOnceGuard();
    expect(g.next({ turn: 1, durableOutputTokens: 42, overflow: true }))
      .toMatchObject({ action: "terminal", code: "DURABLE_OUTPUT" });
  });
  it("durable 优先于「同 turn 第二次」判据(仍是终态)", () => {
    const g = new OverflowOnceGuard();
    g.next({ turn: 1, overflow: true });
    expect(g.next({ turn: 1, durableOutputTokens: 1, overflow: true }).code).toBe("DURABLE_OUTPUT");
  });
  it("非 overflow → NO_OVERFLOW", () => {
    const g = new OverflowOnceGuard();
    expect(g.next({ turn: 1, overflow: false })).toMatchObject({ code: "NO_OVERFLOW" });
  });
  it("新 turn 首次 overflow 仍可压缩一次", () => {
    const g = new OverflowOnceGuard();
    g.next({ turn: 1, overflow: true });
    g.noteSurfaceTokens(100);
    expect(g.next({ turn: 2, overflow: true })).toMatchObject({ action: "compact-and-replay" });
  });
  it("压缩后 surface 缩小 → 下一 turn 仍放行", () => {
    const g = new OverflowOnceGuard();
    g.next({ turn: 1, overflow: true });
    g.noteSurfaceTokens(100);
    g.next({ turn: 2, overflow: true });
    g.noteSurfaceTokens(80);
    expect(g.next({ turn: 3, overflow: true }).action).toBe("compact-and-replay");
  });
  it("压缩后 surface 未缩小(相等或更大) → 终态", () => {
    const g = new OverflowOnceGuard();
    g.next({ turn: 1, overflow: true });
    g.noteSurfaceTokens(100);
    g.next({ turn: 2, overflow: true });
    g.noteSurfaceTokens(100);
    expect(g.next({ turn: 3, overflow: true }))
      .toMatchObject({ action: "terminal", code: "OVERFLOW_REPEAT" });
  });
  it("surface 变大同样判终态", () => {
    const g = new OverflowOnceGuard();
    g.next({ turn: 1, overflow: true });
    g.noteSurfaceTokens(50);
    g.noteSurfaceTokens(60);
    expect(g.next({ turn: 2, overflow: true }).action).toBe("terminal");
  });
  it("turn 边界重置:上一 turn 压缩后 surface 未缩,新 turn 仍重新允许一次", () => {
    const g = new OverflowOnceGuard();
    g.next({ turn: 1, overflow: true });
    g.noteSurfaceTokens(100);
    g.noteSurfaceTokens(100); // 压缩后未缩 → 停滞;不重置时 turn 2 会被判终态
    expect(g.next({ turn: 2, overflow: true }).code).toBe("OVERFLOW_REPEAT");
    g.resetForTurn(); // loop.runTurn 每 turn 开头调用
    expect(g.next({ turn: 2, overflow: true }))
      .toMatchObject({ action: "compact-and-replay", code: "OK_COMPACT" });
 // 新 turn 仍只许一次:同 turn 二次 overflow → 终态
    expect(g.next({ turn: 2, overflow: true }).code).toBe("OVERFLOW_REPEAT");
  });
  it("turn 边界重置 + surface 缩减 → 新 turn 继续放行", () => {
    const g = new OverflowOnceGuard();
    g.next({ turn: 1, overflow: true });
    g.noteSurfaceTokens(100);
    g.resetForTurn();
    expect(g.next({ turn: 2, overflow: true }).action).toBe("compact-and-replay");
    g.noteSurfaceTokens(80); // 真缩了
    g.resetForTurn();
    expect(g.next({ turn: 3, overflow: true }).action).toBe("compact-and-replay");
  });
  it("resetForTurn 幂等且不 throw", () => {
    const g = new OverflowOnceGuard();
    expect(() => { g.resetForTurn(); g.resetForTurn(); }).not.toThrow();
    expect(g.next({ turn: 1, overflow: true }).action).toBe("compact-and-replay");
  });
  it("实例状态彼此独立", () => {
    const a = new OverflowOnceGuard();
    a.next({ turn: 1, overflow: true });
    const b = new OverflowOnceGuard();
    expect(b.next({ turn: 1, overflow: true }).action).toBe("compact-and-replay");
  });
  it("确定性:同一序列在两只新守卫上结果相同", () => {
    const run = () => {
      const g = new OverflowOnceGuard();
      return [
        g.next({ turn: 1, overflow: true }),
        g.next({ turn: 1, overflow: true }),
        g.next({ turn: 2, overflow: true }),
      ];
    };
    expect(run()).toEqual(run());
  });
  it("不 throw:空/异常入参也返回决策", () => {
    const g = new OverflowOnceGuard();
    expect(() => g.next({ turn: Number.NaN })).not.toThrow();
    expect(() => g.next({ turn: 1, overflow: true, durableOutputTokens: Number.NaN })).not.toThrow();
    expect(g.next({ turn: Number.NaN, overflow: true }).code).toBe("OK_COMPACT");
  });
});
