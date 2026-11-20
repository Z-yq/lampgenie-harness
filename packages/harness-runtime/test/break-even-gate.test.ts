import { describe, it, expect } from "vitest";
import {
  microcompactMessages,
  DEFAULT_PRICE_RATIO,
  type MicrocompactConfig,
} from "../src/agent/microcompact";
import type { Message } from "../src/agent/loop";

/**
 * 缺口#25:经济判据 v2(N > r·B/W)数值断言。
 * 断言四件事:v2 开启走新判据、v2 关闭旧行为不变、正确性旁路、两本账标注。
 * W/B 口径与 microcompact.ts 内部一致(字符 → approxTokensOfChars)。
 */

/** 同 path 同内容的 read_file 两次(内容指纹去重的最小构造)。 */
function dup(id: string, path: string, chars: number): Message[] {
  return [
    {
      role: "assistant" as never,
      content: "",
      toolCalls: [{ id, name: "read_file", arguments: JSON.stringify({ path, offset: 1, limit: 500 }) }],
    },
    { role: "tool", toolCallId: id, content: "D".repeat(chars) },
  ];
}

/** 独立 path 的大结果(撑大 B:最早改写点之前的已缓存前缀)。 */
function big(id: string, path: string, chars: number): Message[] {
  return [
    {
      role: "assistant" as never,
      content: "",
      toolCalls: [{ id, name: "read_file", arguments: JSON.stringify({ path, offset: 1, limit: 500 }) }],
    },
    { role: "tool", toolCallId: id, content: "B".repeat(chars) },
  ];
}

describe("经济判据 v2(终版公式 W/W′ > r/N,缺口#37 弃 B 口径)", () => {
  it("代价项=tail(改写点之后)而非 B(改写点之前):800k 前缀在改写点之前不算代价", () => {
 // dup 对 + 大 tail:c2(保留的最后一份)在改写点之后 → tail≈28020 tok;
 // 800k 前缀在改写点**之前**→ 拍板口径「仍命中,不算重付」(旧 B 口径会算 280021)。
    const msgs: Message[] = [
      { role: "user", content: "q" },
      ...big("c0", "src/prefix.ts", 800_000),
      ...dup("c1", "src/same.ts", 40_000),
      ...dup("c2", "src/same.ts", 40_000),
    ];
    const res = microcompactMessages(msgs, { breakEvenGateV2: true, remainingStepsEstimate: 2, priceRatio: 50 });
    expect(res.skipped).toBeDefined();
 // 文案口径:代价项是 W′+tail(tail≈保留份规模),不是 B(前缀 280021)——证明代价对象已切换。
    expect(res.skipped).toContain("tail");
    expect(res.skipped).not.toContain("280021");
  });

  it("N 维度:N=2 拦、N=25 放(同输入 r=10;dedup 场景 tail≈2W → 阈值 N≈2r)", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" },
      ...dup("c1", "src/same.ts", 40_000),
      ...dup("c2", "src/same.ts", 40_000),
    ];
 // 结构比例:dedup 改写点=被折叠者的 assistant 调用处,之后 = 被折叠份+保留份 ≈ 2×40k chars
 // → W≈13972、tail≈28020、W′≈29 → 放行需 N > (29+28020)×10/13972 ≈ 20.1。
    const n2 = microcompactMessages(msgs, { breakEvenGateV2: true, remainingStepsEstimate: 2, priceRatio: 10 });
    expect(n2.skipped).toContain("v2");
    const n25 = microcompactMessages(msgs, { breakEvenGateV2: true, remainingStepsEstimate: 25, priceRatio: 10 });
    expect(n25.skipped).toBeUndefined();
    expect(n25.compacted).toBeGreaterThan(0);
  });

  it("v2 关闭(缺省):旧行为 factor=3 逐字不变(大前缀场景 skip,口径不同)", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" },
      ...big("c0", "src/prefix.ts", 800_000),
      ...dup("c1", "src/same.ts", 40_000),
      ...dup("c2", "src/same.ts", 40_000),
    ];
    const legacy = microcompactMessages(msgs);
 // v1 判据:省 10000 tok < 前缀 200000 tok × 3 → skip;skip 文案是 v1 口径(不含「v2」)。
    expect(legacy.skipped).toBeDefined();
    expect(legacy.skipped).not.toContain("v2");
    expect(legacy.skipped).toContain("× 3");

 // v2 下同一输入:代价=tail(保留份)→ 同样拦但文案是 tail 口径(非 B)→ 两档可区分。
    const v2 = microcompactMessages(msgs, { breakEvenGateV2: true, remainingStepsEstimate: 2, priceRatio: 50 });
    expect(v2.skipped).toContain("tail");
  });

  it("正确性裁剪旁路经济门:superseded 照裁并标 ledger:correctness", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" },
      ...big("c0", "src/prefix.ts", 800_000),
      ...dup("c1", "src/same.ts", 10_000),
      ...dup("c2", "src/same.ts", 20_000), // 内容不同 → 不 dedup,但同 where → c1 被 c2 取代
    ];
    const res = microcompactMessages(msgs, { breakEvenGateV2: true, priceRatio: 50 });
    const superseded = (res.pruned ?? []).filter((p) => p.action === "superseded");
    expect(superseded.length).toBeGreaterThan(0);
    for (const p of superseded) expect(p.ledger).toBe("correctness");
  });

  it("两本账标注:economy/correctness 按 action 分账", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" },
      ...big("c0", "src/prefix.ts", 100),
      ...dup("c1", "src/same.ts", 40_000),
      ...dup("c2", "src/same.ts", 20_000), // 内容不同:dedup 不触发,superseded 触发
    ];
    const res = microcompactMessages(msgs);
    const items = res.pruned ?? [];
    expect(items.length).toBeGreaterThan(0);
    for (const p of items) {
      if (p.action === "superseded" || p.action === "model_drop") {
        expect(p.ledger).toBe("correctness");
      } else if (p.action === "dedup" || p.action === "args_summarized") {
        expect(p.ledger).toBe("economy");
      }
    }
  });

  it("r 缺省逐模型:priceRatioOf 显式参数/env 优先,deepseek 按价表现算,其余家 10", async () => {
    const { priceRatioOf, DEFAULT_PRICE_RATIO, FALLBACK_PRICE_RATIO } = await import("../src/agent/microcompact");
    expect(DEFAULT_PRICE_RATIO).toBe(50); // 历史常数保留(v1 注释口径)
    expect(FALLBACK_PRICE_RATIO).toBe(10); // 拍板:其余家统一 10
    expect(priceRatioOf(undefined, 30)).toBe(30); // 显式参数优先
    expect(priceRatioOf("deepseek-flash-x", undefined)).toBe(50); // 价表现算 2/0.04
    expect(priceRatioOf("deepseek-v4-pro", undefined)).toBe(30); // 9/0.3
    expect(priceRatioOf("claude-sonnet-5", undefined)).toBe(10); // 拍板统一(价表现算 10 也一致)
    expect(priceRatioOf("qwen3.8-max", undefined)).toBe(10); // cacheRead=null → 拍板 10
    expect(priceRatioOf("unknown-model", undefined)).toBe(10); // 未匹配 → 10
    expect(priceRatioOf(undefined, undefined)).toBe(10); // 无模型名 → 10(不再 50)
  });

  it("N 缺省回退 assumedRemainingCalls(现 10):同输入下 N=10 与缺省裁决一致", () => {
 // 大 tail 场景:两档都被拦,skip 文案含 N 10。
    const msgs: Message[] = [
      { role: "user", content: "q" },
      ...dup("c1", "src/same.ts", 40_000),
      ...dup("c2", "src/same.ts", 40_000),
      ...big("c0", "src/after.ts", 800_000),
    ];
    const explicit = microcompactMessages(msgs, { breakEvenGateV2: true, remainingStepsEstimate: 10, priceRatio: 50 });
    const fallback = microcompactMessages(msgs, { breakEvenGateV2: true, priceRatio: 50 });
    expect(explicit.skipped).toContain("N 10 ×");
    expect(fallback.skipped).toBe(explicit.skipped);
  });
});
