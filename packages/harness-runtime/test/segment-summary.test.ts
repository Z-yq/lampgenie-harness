import { describe, it, expect } from "vitest";
import {
  buildSegmentSummaryPlan, segmentSummaryPrompt,
  SEGMENT_SUMMARY_MAX_CHARS, SEGMENT_SUMMARY_MIN_CHARS,
} from "../src/agent/segment-summary";

/** 已闭合段温区批的小模型摘要执行器(设计 §3.6.3 第一手段)单测。 */

const big = (n: number) => "R".repeat(n);

function msg(id: string, content: string) {
  return { role: "tool", toolCallId: id, content };
}

describe("segment-summary(温区第一手段:小模型摘要)", () => {
  it("只摘计划命中、够长、未占位的 tool 结果;摘要进 Map,短/占位/未命中跳过", async () => {
    const calls: string[] = [];
    const messages = [
      { role: "assistant", toolCalls: [{ id: "a", name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) }] },
      msg("a", big(5_000)),
      { role: "assistant", toolCalls: [{ id: "b", name: "grep", arguments: JSON.stringify({ pattern: "TODO" }) }] },
      msg("b", big(SEGMENT_SUMMARY_MIN_CHARS + 10)),
      { role: "assistant", toolCalls: [{ id: "short", name: "read_file", arguments: "{}" }] },
      msg("short", big(100)),
      { role: "assistant", toolCalls: [{ id: "ph", name: "read_file", arguments: "{}" }] },
      msg("ph", "[工具结果已清除(上下文压力):old]"),
      { role: "assistant", toolCalls: [{ id: "notplanned", name: "read_file", arguments: "{}" }] },
      msg("notplanned", big(5_000)),
    ];
    const plan = await buildSegmentSummaryPlan(messages, {
      ids: new Set(["a", "b", "short", "ph"]),
      goal: "改白板加载性能",
      digest: async (prompt) => {
        calls.push(prompt);
        return prompt.includes("src/a.ts") ? "关键结论:A\n精确锚点:src/a.ts:10" : "关键结论:B";
      },
    });
    expect([...plan.keys()].sort()).toEqual(["a", "b"]);
    expect(plan.get("a")).toContain("src/a.ts:10");
    expect(plan.get("b")).toContain("关键结论:B");
    expect(calls).toHaveLength(2);
    expect(calls.every((p) => p.includes("改白板加载性能"))).toBe(true);
    expect(calls[0]).toContain("read_file src/a.ts");
  });

  it("摘要超长截断;digest 抛错/空摘要不进入 Map(fail-soft 回落占位)", async () => {
    const plan = await buildSegmentSummaryPlan(
      [
        msg("long", "LONGMARK" + big(5_000)),
        msg("err", "ERRMARK" + big(5_000)),
        msg("empty", "EMPTYMARK" + big(5_000)),
      ],
      {
        ids: new Set(["long", "err", "empty"]),
        goal: "g",
        digest: async (prompt) => {
          if (prompt.includes("ERRMARK")) throw new Error("model down");
          if (prompt.includes("EMPTYMARK")) return "   ";
          return "S".repeat(SEGMENT_SUMMARY_MAX_CHARS + 500);
        },
      },
    );
    expect([...plan.keys()]).toEqual(["long"]);
    expect(plan.get("long")!.length).toBeGreaterThan(SEGMENT_SUMMARY_MAX_CHARS);
    expect(plan.get("long")).toContain("摘要超长已截断");
  });

  it("无 digest/空 ids → 空 Map(不硬造摘要)", async () => {
    expect((await buildSegmentSummaryPlan([msg("a", big(5_000))], { ids: new Set(["a"]), goal: "g" })).size).toBe(0);
    expect((await buildSegmentSummaryPlan([msg("a", big(5_000))], {
      ids: new Set(), goal: "g", digest: async () => "x",
    })).size).toBe(0);
  });

  it("提示词要求四段且明确不复述原文", () => {
    const p = segmentSummaryPrompt("目标", "read_file", "src/a.ts", "body");
    for (const k of ["关键结论", "精确锚点", "异常与风险", "下一步", "不要复述原文"]) expect(p).toContain(k);
  });
});