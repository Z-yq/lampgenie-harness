import { describe, it, expect } from "vitest";
import { queryTrace, isToolError, TRACE_QUERY_MAX_LIMIT } from "../src/agent/trace-query";
import type { TraceQueryEvent } from "../src/agent/trace-query";

/** 构造事件:seq 从 1 递增(与 journal 一致)。 */
function ev(seq: number, kind: string, payload: Record<string, unknown>): TraceQueryEvent {
  return { seq, kind, time: 1000 + seq, sessionId: "s1", payload };
}

/** 一批覆盖五类聚合的事件。 */
function sample(): TraceQueryEvent[] {
  return [
    ev(1, "turn.start", { turn: 1 }),
    ev(2, "message.agent", { turn: 1, text: "思考", llmMs: 1200, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    ev(3, "tool.call", { turn: 1, toolCallId: "c1", name: "bash", arguments: "{}" }),
    ev(4, "tool.result", { turn: 1, toolCallId: "c1", name: "bash", content: "ok", durationMs: 300 }),
    ev(5, "tool.call", { turn: 1, toolCallId: "c2", name: "grep", arguments: "{}" }),
    ev(6, "tool.result", { turn: 1, toolCallId: "c2", name: "grep", content: "慢", durationMs: 900 }),
    ev(7, "tool.call", { turn: 1, toolCallId: "c3", name: "bash", arguments: "{}" }),
    ev(8, "tool.result", { turn: 1, toolCallId: "c3", name: "bash", content: "错误: 命令失败", durationMs: 50 }),
    ev(9, "tool.call", { turn: 1, toolCallId: "c4", name: "read" }),
    ev(10, "tool.result", {
      turn: 1, toolCallId: "c4", name: "read", content: "denied",
      durationMs: 5, error: { origin: "denied", message: "权限拒绝" },
    }),
    ev(11, "message.agent", { turn: 1, text: "", llmMs: 4000, error: { message: "upstream 500" } }),
    ev(12, "step.end", { turn: 1, step: 0, reason: "tools-done" }),
    ev(13, "turn.end", { turn: 1, reason: "completed" }),
    ev(14, "turn.start", { turn: 2 }),
  ];
}

describe("queryTrace:过滤面(txa6/txa7/txa8)", () => {
  it("kinds 只保留指定 kind;kindCounts 与保留集一致", () => {
    const { events, summary } = queryTrace(sample(), { kinds: ["tool.result"] });
    expect(events.map((e) => e.seq)).toEqual([4, 6, 8, 10]);
    expect(summary.kindCounts).toEqual({ "tool.result": 4 });
    expect(summary.matched).toBe(4);
    expect(summary.returned).toBe(4);
  });

  it("tools 只裁 tool.call/tool.result,非工具事件不受影响", () => {
    const { events, summary } = queryTrace(sample(), { tools: ["bash"], kinds: ["tool.call", "tool.result", "turn.start"] });
    expect(events.map((e) => e.seq)).toEqual([1, 3, 4, 7, 8, 14]);
    expect(summary.toolErrors.map((t) => t.name)).toEqual(["bash"]);
  });

  it("turn 过滤(无 turn 字段的事件被剔除)", () => {
    const evs: TraceQueryEvent[] = [...sample(), { seq: 99, kind: "tool.result", payload: { name: "x", content: "ok", durationMs: 1 } }];
    const { events } = queryTrace(evs, { turn: 2 });
    expect(events.map((e) => e.seq)).toEqual([14]);
    // 无 turn 字段的 seq=99 不在任何 turn 里 → turn:2 不匹配
    expect(queryTrace(evs, { turn: 2 }).summary.matched).toBe(1);
  });

  it("sinceSeq 含端点(seq >= sinceSeq)", () => {
    const { events } = queryTrace(sample(), { sinceSeq: 12 });
    expect(events.map((e) => e.seq)).toEqual([12, 13, 14]);
  });

  it("onlyErrors 认新形态(error 对象)与旧形态(content 前缀「错误:」)", () => {
    const { events, summary } = queryTrace(sample(), { onlyErrors: true });
    expect(events.map((e) => e.seq)).toEqual([8, 10, 11]);
    expect(summary.matched).toBe(3);
  });

  it("isToolError:新形态优先,旧 content 前缀回退", () => {
    expect(isToolError({ error: { origin: "timeout", message: "x" } })).toBe(true);
    expect(isToolError({ content: "错误: xx" })).toBe(true);
    expect(isToolError({ content: "正常结果" })).toBe(false);
    expect(isToolError({ error: undefined, content: "ok" })).toBe(false);
    expect(isToolError(null)).toBe(false);
  });

  it("limit 截断 returned 但 matched 是全量;limit 非法(负/非数/0)按默认 200", () => {
    const many = Array.from({ length: 30 }, (_, i) => ev(i + 1, "step.start", { turn: 1, step: i }));
    expect(queryTrace(many, { limit: 5 }).summary).toMatchObject({ matched: 30, returned: 5 });
    expect(queryTrace(many, { limit: 5 }).events).toHaveLength(5);
    for (const bad of [-1, 0, Number.NaN, "100" as unknown as number]) {
      const r = queryTrace(many, { limit: bad as number });
      expect(r.summary.returned, `limit=${String(bad)} 按默认`).toBe(30);
    }
  });

  it("limit 硬上限 2000", () => {
    const many = Array.from({ length: 2100 }, (_, i) => ev(i + 1, "step.start", { payload: i } as unknown as Record<string, unknown>));
    const r = queryTrace(many, { limit: 99999 });
    expect(TRACE_QUERY_MAX_LIMIT).toBe(2000);
    expect(r.events).toHaveLength(2000);
    expect(r.summary.matched).toBe(2100);
  });
});

describe("queryTrace:聚合面(txa9)", () => {
  it("五类聚合:kindCounts/llmCalls/llmFailures/firstSeq/lastSeq/matched", () => {
    const { summary } = queryTrace(sample(), {});
    expect(summary.matched).toBe(14);
    expect(summary.returned).toBe(14);
    expect(summary.kindCounts).toEqual({
      "turn.start": 2, "message.agent": 2, "tool.call": 4, "tool.result": 4, "step.end": 1, "turn.end": 1,
    });
    expect(summary.llmCalls).toBe(2);
    expect(summary.llmFailures).toBe(1);
    expect(summary.firstSeq).toBe(1);
    expect(summary.lastSeq).toBe(14);
  });

  it("slowestTools 按 durationMs 降序,只在 tool.result 上统计", () => {
    const { summary } = queryTrace(sample(), {});
    expect(summary.slowestTools.map((t) => [t.name, t.durationMs, t.errored])).toEqual([
      ["grep", 900, false],
      ["bash", 300, false],
      ["bash", 50, true],
      ["read", 5, true],
    ]);
    expect(summary.slowestTools[2]!.toolCallId).toBe("c3");
  });

  it("llm.trace 带 error 也计入 llmFailures,但不进 llmCalls(与 trace-stats 口径一致)", () => {
    // 真实 journal 形态:成功调用落 message.agent,失败调用落 llm.trace(loop 失败分支)。
    const evs: TraceQueryEvent[] = [
      ev(1, "message.agent", { turn: 1, step: 0, text: "ok", llmMs: 1200 }),
      ev(2, "llm.trace", { turn: 1, step: 1, model: "m", ms: 2500, error: "上游 502" }),
      ev(3, "llm.trace", { turn: 1, step: 2, model: "m", ms: 800 }),
    ];
    const { summary } = queryTrace(evs, {});
    expect(summary.llmCalls).toBe(1); // 只数成功的 message.agent
    expect(summary.llmFailures).toBe(1); // 只数带 error 的 llm.trace
  });

  it("negative:成功路径的 llm.trace(无 error)不算失败", () => {
    const evs: TraceQueryEvent[] = [ev(1, "llm.trace", { turn: 1, step: 0, model: "m", ms: 900 })];
    const { summary } = queryTrace(evs, {});
    expect(summary.llmFailures).toBe(0);
    expect(summary.llmCalls).toBe(0);
  });

  it("slowestTools top10 上限", () => {
    const evs = Array.from({ length: 15 }, (_, i) => ev(i + 1, "tool.result", { name: "t", toolCallId: `c${i}`, content: "ok", durationMs: i * 10 }));
    const { summary } = queryTrace(evs, {});
    expect(summary.slowestTools).toHaveLength(10);
    expect(summary.slowestTools[0]!.durationMs).toBe(140);
  });

  it("toolErrors 按 count 降序,origins 归集 origin", () => {
    const evs = [
      ev(1, "tool.result", { name: "bash", toolCallId: "a", content: "错误: x", durationMs: 1 }),
      ev(2, "tool.result", { name: "bash", toolCallId: "b", content: "", durationMs: 1, error: { origin: "threw", message: "e" } }),
      ev(3, "tool.result", { name: "read", toolCallId: "c", content: "", durationMs: 1, error: { origin: "timeout", message: "e" } }),
      ev(4, "tool.result", { name: "read", toolCallId: "d", content: "", durationMs: 1, error: { origin: "timeout", message: "e" } }),
    ];
    const { summary } = queryTrace(evs, {});
    // count 相同 → 按 name 升序(稳定,便于断言)
    expect(summary.toolErrors.map((t) => [t.name, t.count])).toEqual([["bash", 2], ["read", 2]]);
    const read = summary.toolErrors.find((t) => t.name === "read")!;
    expect(read.origins).toEqual({ timeout: 2 });
    const bash = summary.toolErrors.find((t) => t.name === "bash")!;
    expect(bash.origins).toEqual({ threw: 1 }); // 旧形态无 origin → 不进 origins
  });
});

describe("queryTrace:投影裁剪与健壮性", () => {
  it("content 5000 字 → 输出 ≤2064 字且 truncated:true", () => {
    const big = "a".repeat(5000);
    const { events } = queryTrace([ev(1, "tool.result", { name: "bash", toolCallId: "c1", content: big, durationMs: 1 })], {});
    const p = events[0]!.payload as { content: string; truncated?: boolean };
    expect(p.content.length).toBeLessThanOrEqual(2064);
    expect(p.content.length).toBe(2000);
    expect(p.truncated).toBe(true);
  });

  it("text/arguments 同样截断;短字段不置 truncated", () => {
    const big = "b".repeat(3000);
    const { events } = queryTrace([
      ev(1, "message.agent", { turn: 1, text: big }),
      ev(2, "tool.call", { turn: 1, name: "bash", toolCallId: "c1", arguments: big }),
      ev(3, "tool.result", { name: "bash", toolCallId: "c1", content: "短", durationMs: 1 }),
    ], {});
    const a = events[0]!.payload as { text: string; truncated?: boolean };
    expect(a.text.length).toBe(2000);
    expect(a.truncated).toBe(true);
    const b = events[1]!.payload as { arguments: string; truncated?: boolean };
    expect(b.arguments.length).toBe(2000);
    expect(b.truncated).toBe(true);
    expect((events[2]!.payload as { truncated?: boolean }).truncated).toBeUndefined();
  });

  it("payload.images 元素换占位串,base64 绝不出 wire", () => {
    const b64 = "data:image/png;base64," + "A".repeat(500);
    const { events } = queryTrace([ev(1, "tool.result", {
      name: "view_image", toolCallId: "c1", content: "图片已注入视觉通道(1 张)", durationMs: 1, images: [b64, b64],
    })], {});
    const s = JSON.stringify(events);
    expect(s).not.toContain("base64");
    const p = events[0]!.payload as { images: string[] };
    expect(p.images).toEqual(["(image omitted)", "(image omitted)"]);
  });

  it("空事件数组 → 零值 summary,不抛", () => {
    const r = queryTrace([], { kinds: ["tool.result"], limit: 5 });
    expect(r.events).toEqual([]);
    expect(r.summary).toEqual({
      matched: 0, returned: 0, kindCounts: {}, slowestTools: [], toolErrors: [],
      llmCalls: 0, llmFailures: 0, firstSeq: null, lastSeq: null,
    });
    expect(() => queryTrace([], {})).not.toThrow();
  });

  it("全被过滤掉 → 零值 summary", () => {
    const r = queryTrace(sample(), { kinds: ["nope"] });
    expect(r.events).toEqual([]);
    expect(r.summary.matched).toBe(0);
    expect(r.summary.firstSeq).toBeNull();
  });

  it("不改写入参事件(payload 是拷贝)", () => {
    const src = ev(1, "tool.result", { name: "bash", toolCallId: "c1", content: "x".repeat(3000), durationMs: 1 });
    const before = (src.payload as { content: string }).content.length;
    queryTrace([src], {});
    expect((src.payload as { content: string }).content.length).toBe(before);
  });
});
