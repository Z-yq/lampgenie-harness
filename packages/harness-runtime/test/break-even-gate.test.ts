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

describe("经济判据 v2(N > r·B/W,缺口#25)", () => {
  it("v2 开启 + N=2 + r=50:小前缀(N·W > B·r)裁;大前缀(不成立)deferred", () => {
 // W ≈ 40k 字符的 token(≈13972);N=2、r=50 → 需 2W > 50B ⟺ B < 2W/50 ≈ 559 tok。
 // 小 B(前缀仅 user 一条):判据成立 → 纯省 token 动作放行。
    const smallB: Message[] = [
      { role: "user", content: "q" },
      ...dup("c1", "src/same.ts", 40_000),
      ...dup("c2", "src/same.ts", 40_000),
    ];
    const cfg: MicrocompactConfig = { breakEvenGateV2: true, remainingStepsEstimate: 2, priceRatio: 50 };
    const res = microcompactMessages(smallB, cfg);
    expect(res.skipped).toBeUndefined();
    expect(res.compacted).toBeGreaterThan(0);

 // 大 B(前缀 800k 字符 ≈ 280021 tok):N·W=2×13972 < B·r=50×280021 → skip 纯省 token。
 // c1/c2 内容相同 → dedup(经济账)被拦;head_tail 属 B=0 的就近改写照做。
    const bigB: Message[] = [
      { role: "user", content: "q" },
      ...big("c0", "src/prefix.ts", 800_000),
      ...dup("c1", "src/same.ts", 40_000),
      ...dup("c2", "src/same.ts", 40_000),
    ];
    const resB = microcompactMessages(bigB, cfg);
    expect(resB.skipped).toContain("v2");
    expect(resB.compacted).toBeGreaterThan(0);
    const actions = (resB.pruned ?? []).map((p) => p.action);
    expect(actions).toContain("head_tail"); // B=0 的就近改写不受经济门约束
 // v2 经济门只拦「当轮新产生的」args 摘要/全量去重 pass;supersede 属正确性账仍照做
 // (本构造里 c1/c2 同内容 → dedup 先折叠了旧份,supersede 无候选:actions 含 dedup 属预期)。
  });

  it("v2 关闭(缺省):旧行为 factor=3 逐字不变(大 B 场景同样 skip,口径不同)", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" },
      ...big("c0", "src/prefix.ts", 800_000),
      ...dup("c1", "src/same.ts", 40_000),
      ...dup("c2", "src/same.ts", 40_000),
    ];
    const legacy = microcompactMessages(msgs);
 // v1 判据:省 13972 tok < 前缀 280021 tok × 3 → skip;skip 文案是 v1 口径(不含「v2」)。
    expect(legacy.skipped).toBeDefined();
    expect(legacy.skipped).not.toContain("v2");
    expect(legacy.skipped).toContain("× 3");

 // v2 下同一输入:同样 skip 但文案换 v2 口径 → 两档行为可区分。
    const v2 = microcompactMessages(msgs, { breakEvenGateV2: true, remainingStepsEstimate: 2, priceRatio: 50 });
    expect(v2.skipped).toContain("v2");
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

  it("r 缺省 50:DEFAULT_PRICE_RATIO 常量", () => {
    expect(DEFAULT_PRICE_RATIO).toBe(50);
  });

  it("N 缺省回退 assumedRemainingCalls(现 10):同输入下 N=10 与缺省裁决一致", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" },
      ...big("c0", "src/prefix.ts", 800_000),
      ...dup("c1", "src/same.ts", 40_000),
      ...dup("c2", "src/same.ts", 40_000),
    ];
 // N=10(显式)与缺省回退(=10)都应给出同一 v2 skip 文案(N 10 × W 13972 ≤ B 280021 × r 50)。
    const explicit = microcompactMessages(msgs, { breakEvenGateV2: true, remainingStepsEstimate: 10, priceRatio: 50 });
    const fallback = microcompactMessages(msgs, { breakEvenGateV2: true, priceRatio: 50 });
    expect(explicit.skipped).toContain("N 10 ×");
    expect(fallback.skipped).toBe(explicit.skipped);
  });
});
