/**
 * RSI 运行成本/已分析会话抽取( RSI-SESSION-COST)。
 * 钉住四类事实:
 * ① 窗口切分:按 taskId 精准切 task.start→task.done|task.fail,**同会话多任务交错不串**;
 * ② 用量:只认 llm.trace 上报值求和(不估算),calls 数正确,model 取窗口内最后一个;
 * ③ 最终回复:取窗口内**最后**一条 message.agent 文本;
 * ④ 记账行解析:中英逗号/顿号/空白都拆,`(无)` 视为空,只收形如 sessionId 的 token。
 */
import { describe, expect, it } from "vitest";
import {
  finalAgentText,
  parseAnalyzedSessions,
  taskWindowOf,
  usageOfWindow,
} from "../src/rsi-run-metrics.js";

type Event = { kind: string; payload?: Record<string, unknown> };

describe("taskWindowOf", () => {
  const events: Event[] = [
    { kind: "message.user", payload: { text: "hello" } },
    { kind: "task.start", payload: { id: "t-1" } },
    { kind: "llm.trace", payload: { model: "deepseek-flash", usage: { inputTokens: 100, cachedTokens: 40, outputTokens: 10 } } },
    { kind: "task.start", payload: { id: "t-2" } }, // 交错:另一任务开始 → t-1 窗口必须
    { kind: "llm.trace", payload: { model: "deepseek-flash", usage: { inputTokens: 999, outputTokens: 99 } } },
    { kind: "task.done", payload: { id: "t-2" } },
    { kind: "task.done", payload: { id: "t-1" } },
  ];

  it("同一会话里多任务交错:各自窗口互不污染", () => {
    const w1 = taskWindowOf(events, "t-1");
    expect(w1.map((e) => e.kind)).toEqual(["task.start", "llm.trace"]);
    const usage1 = usageOfWindow(w1);
    expect(usage1).toMatchObject({ inputTokens: 100, cachedTokens: 40, outputTokens: 10, calls: 1 });

    const w2 = taskWindowOf(events, "t-2");
    expect(usageOfWindow(w2)).toMatchObject({ inputTokens: 999, outputTokens: 99, calls: 1 });
  });

  it("找不到该 task 的 task.start / taskId 为空 → 空窗口(不猜一段事件当成本)", () => {
    expect(taskWindowOf(events, "t-404")).toEqual([]);
    expect(taskWindowOf(events, "")).toEqual([]);
    expect(taskWindowOf([], "t-1")).toEqual([]);
  });

  it("缺 task.start:退化为第一个带 taskId 的事件,并在下一任务/终态义务处收口", () => {
    const list: Event[] = [
      { kind: "message.user", payload: { text: "before" } },
      { kind: "task.context", payload: { taskId: "t-9" } },
      { kind: "llm.trace", payload: { model: "m", usage: { inputTokens: 50, outputTokens: 5 } } },
      { kind: "task.trajectory", payload: { taskId: "t-9" } },
      { kind: "delivery.obligation", payload: { taskId: "t-9", terminalState: "done" } },
      { kind: "llm.trace", payload: { usage: { inputTokens: 9999 } } },
    ];
    const w = taskWindowOf(list, "t-9");
    expect(w.map((e) => e.kind)).toEqual(["task.context", "llm.trace", "task.trajectory"]);
    expect(usageOfWindow(w)).toMatchObject({ inputTokens: 50, outputTokens: 5, calls: 1 });

    const list2: Event[] = [
      { kind: "task.context", payload: { taskId: "t-a" } },
      { kind: "llm.trace", payload: { usage: { inputTokens: 10 } } },
      { kind: "task.context", payload: { taskId: "t-b" } },
      { kind: "llm.trace", payload: { usage: { inputTokens: 20 } } },
    ];
    expect(usageOfWindow(taskWindowOf(list2, "t-a"))).toMatchObject({ inputTokens: 10, calls: 1 });
  });

  it("task.fail 也是窗口终点", () => {
    const list: Event[] = [
      { kind: "task.start", payload: { id: "t-3" } },
      { kind: "llm.trace", payload: { usage: { inputTokens: 5, outputTokens: 5 } } },
      { kind: "task.fail", payload: { id: "t-3" } },
      { kind: "llm.trace", payload: { usage: { inputTokens: 1000, outputTokens: 1000 } } },
    ];
    expect(usageOfWindow(taskWindowOf(list, "t-3"))).toMatchObject({ inputTokens: 5, outputTokens: 5, calls: 1 });
  });
});

describe("usageOfWindow", () => {
  it("多调用求和 + 最后一个 model;cacheCreationTokens 缺省按 0", () => {
    const window: Event[] = [
      { kind: "llm.trace", payload: { model: "claude-sonnet-5", usage: { inputTokens: 1000, cachedTokens: 400, cacheCreationTokens: 100, outputTokens: 200 } } },
      { kind: "message.agent", payload: { text: "中间输出" } },
      { kind: "llm.trace", payload: { model: "deepseek-flash", usage: { inputTokens: 500, cachedTokens: 100, outputTokens: 50 } } },
    ];
    const usage = usageOfWindow(window);
    expect(usage).toMatchObject({
      inputTokens: 1500,
      cachedTokens: 500,
      cacheCreationTokens: 100,
      outputTokens: 250,
      totalTokens: 1750,
      calls: 2,
      model: "deepseek-flash",
    });
  });

  it("没有 llm.trace → 全 0、无 model(不编造用量)", () => {
    const usage = usageOfWindow([{ kind: "message.agent", payload: { text: "x" } }]);
    expect(usage).toMatchObject({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 });
    expect(usage.model).toBeUndefined();
  });
});

describe("finalAgentText", () => {
  it("取窗口内最后一条 message.agent 文本", () => {
    const window: Event[] = [
      { kind: "message.agent", payload: { text: "早期输出" } },
      { kind: "tool.result", payload: {} },
      { kind: "message.agent", payload: { text: "最终回复\n已分析会话: web-1" } },
    ];
    expect(finalAgentText(window)).toContain("已分析会话: web-1");
  });

  it("没有 message.agent → 空串", () => {
    expect(finalAgentText([{ kind: "llm.trace", payload: {} }])).toBe("");
    expect(finalAgentText([])).toBe("");
  });
});

describe("parseAnalyzedSessions", () => {
  it("中文逗号/顿号/空白都拆,剥 markdown,保序去重", () => {
    expect(parseAnalyzedSessions("已分析会话: web-1,web-2、web-3 web-1")).toEqual(["web-1", "web-2", "web-3"]);
    expect(parseAnalyzedSessions("总结…\n**已分析会话**: `web-a`, `web-b`")).toEqual(["web-a", "web-b"]);
  });

  it("(无)/（无）视为空", () => {
    expect(parseAnalyzedSessions("已分析会话: (无)")).toEqual([]);
    expect(parseAnalyzedSessions("已分析会话: （无）")).toEqual([]);
  });

  it("只接受形如 sessionId 的 token(拒中文词与数量描述)", () => {
    expect(parseAnalyzedSessions("已分析会话: web-1, 无, 三个会话, web-2")).toEqual(["web-1", "web-2"]);
  });

  it("多行时取最后一条标记行(最终回复在末尾)", () => {
    const text = "已分析会话: stale-1\n…其它说明…\n已分析会话: web-final";
    expect(parseAnalyzedSessions(text)).toEqual(["web-final"]);
  });

  it("没有标记行 / 空文本 → 空数组", () => {
    expect(parseAnalyzedSessions("分析完了,没写记账行")).toEqual([]);
    expect(parseAnalyzedSessions("")).toEqual([]);
  });
});
