import { describe, it, expect } from "vitest";
import {
  microcompactMessages,
  HEAD_TAIL_AUDIT_TYPE,
  HUGE_RESULT_CHARS,
  type MicrocompactPolicyState,
} from "../src/agent/microcompact";
import type { Message } from "../src/agent/loop";

/**
 * 缺口#32(H3):head_tail 精炼的独立审计事件结构。
 * cacheAwareMicrocompact 在 head_tail 动作发生处填充 headTailAudits;
 * journal 写入点在 loop.ts(本文件不测);事件 type 常量 HEAD_TAIL_AUDIT_TYPE。
 */

const dup = (id: string, path: string, n: number): Message[] => [
  {
    role: "assistant" as never,
    content: "",
    toolCalls: [{ id, name: "read_file", arguments: JSON.stringify({ path, offset: 1, limit: 500 }) }],
  },
  { role: "tool", toolCallId: id, content: "D".repeat(n) },
];

describe("headTailAudits(缺口#32/H3)", () => {
  it("HEAD_TAIL_AUDIT_TYPE 常量 = context.refine.head_tail", () => {
    expect(HEAD_TAIL_AUDIT_TYPE).toBe("context.refine.head_tail");
  });

  it("cache-aware 管线:tail 区发生 head_tail 时填充 headTailAudits(字段口径对齐)", () => {
    const state: MicrocompactPolicyState = { clock: 1, turnStart: true };
    const msgs: Message[] = [
      { role: "user", content: "q" },
      ...dup("c1", "src/a.ts", HUGE_RESULT_CHARS + 5_000),
    ];
    const res = microcompactMessages(msgs, { policyState: state, thresholdTokens: 200_000 });
    const headTailItems = (res.pruned ?? []).filter((p) => p.action === "head_tail");
    expect(headTailItems.length).toBeGreaterThan(0);
    expect(res.headTailAudits).toBeDefined();
    expect(res.headTailAudits).toHaveLength(headTailItems.length);
    const audit = res.headTailAudits![0]!;
    expect(audit.toolCallId).toBe("c1");
    expect(audit.tool).toBe("read_file");
    expect(audit.where).toContain("src/a.ts");
    expect(audit.originalChars).toBe(HUGE_RESULT_CHARS + 5_000);
    expect(audit.newChars).toBeGreaterThan(0);
    expect(audit.newChars).toBeLessThan(audit.originalChars);
 // 审计条目与 pruned 中 head_tail 条目一一对应(同 toolCallId 同字符口径)。
    expect(audit.originalChars).toBe(headTailItems[0]!.originalChars);
    expect(audit.newChars).toBe(headTailItems[0]!.newChars);
  });

  it("无 head_tail 动作时不携带该字段(可选字段,零动作零开销)", () => {
    const state: MicrocompactPolicyState = { clock: 1, turnStart: true };
    const msgs: Message[] = [
      { role: "user", content: "q" },
      ...dup("c1", "src/a.ts", 1_000), // 小结果:不精炼
    ];
    const res = microcompactMessages(msgs, { policyState: state, thresholdTokens: 200_000 });
    expect(res.headTailAudits).toBeUndefined();
  });

  it("audit 条数随 head_tail 条数增长(多条超大结果各生成一条)", () => {
    const state: MicrocompactPolicyState = { clock: 1, turnStart: true };
    const msgs: Message[] = [
      { role: "user", content: "q" },
      ...dup("c1", "src/a.ts", HUGE_RESULT_CHARS + 5_000),
      ...dup("c2", "src/b.ts", HUGE_RESULT_CHARS + 5_000),
    ];
    const res = microcompactMessages(msgs, { policyState: state, thresholdTokens: 200_000 });
    expect((res.pruned ?? []).filter((p) => p.action === "head_tail")).toHaveLength(2);
    expect(res.headTailAudits).toHaveLength(2);
    expect(new Set(res.headTailAudits!.map((a) => a.toolCallId))).toEqual(new Set(["c1", "c2"]));
  });
});
