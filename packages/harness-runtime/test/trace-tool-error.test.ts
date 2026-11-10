/**
 * 轨迹采集补齐(txa1/txa2/txa3/txa4)单测:
 * - txa1/txa2:工具失败的结构化归因(tool.result.payload.error.origin),content 文案不变;
 * - txa3:tool.call / tool.result 带 turn/step,message.user 带 turn;
 * - txa4:LLM 调用抛错时落 durable 的 llm.trace(带非空 error),取消场景不记失败。
 * 端到端(runTurn + 假 LLM)为主;取消竞态在 execOne 单函数级验证(见最后一条)。
 */
import { describe, it, expect } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import type { Tool, ToolCall } from "../src/agent/loop";
import { MemoryJournal } from "@lampgenie/core";
import type { JournalEvent, PermissionRule } from "@lampgenie/core";

type ToolUse = { id: string; name: string; arguments: string };

/** 假 LLM:第 1 步发出给定工具调用,第 2 步收到工具结果后收尾。 */
function llmOnce(calls: ToolUse[], final = "完成") {
  let n = 0;
  return {
    async chat(messages: { role?: string }[]) {
      n++;
      if (n === 1) return { content: "调工具", toolCalls: calls };
      const hasToolResult = messages.some((m) => m.role === "tool");
      return { content: hasToolResult ? final : "no-result", toolCalls: [] };
    },
  };
}

const okTool: Tool = {
  name: "ok_tool",
  description: "正常工具",
  parameters: { type: "object", properties: {} },
  async execute() { return "正常结果"; },
};

const boomTool: Tool = {
  name: "boom_tool",
  description: "必抛工具",
  parameters: { type: "object", properties: {} },
  async execute() { throw new Error("工具炸了"); },
};

const dangerTool: Tool = {
  name: "danger",
  description: "被闸工具(无 isReadOnly → 过闸)",
  parameters: { type: "object", properties: {} },
  async execute() { return "executed"; },
};

function loopOf(journal: MemoryJournal, sessionId: string, tools: Tool[], calls: ToolUse[], opts: Record<string, unknown> = {}) {
  return new AgentLoop({
    journal, sessionId, system: "s",
    llm: llmOnce(calls) as never,
    tools,
    maxSteps: 4,
    ...opts,
  } as never);
}

const payloadOf = (evs: JournalEvent[], kind: string) =>
  (evs.find((e) => e.kind === kind)?.payload ?? {}) as Record<string, unknown>;

describe("工具失败结构化归因(txa1/txa2)", () => {
  it("未知工具:error.origin=unknown-tool,content 仍以「错误:」开头(模型可读文案不变)", async () => {
    const journal = new MemoryJournal();
    await loopOf(journal, "te1", [okTool], [{ id: "c1", name: "nope_tool", arguments: "{}" }]).runTurn("做");

    const p = payloadOf(journal.readAll(), "tool.result");
    const err = p.error as { origin: string; message: string; name?: string };
    expect(err.origin).toBe("unknown-tool");
    expect(err.name).toBe("nope_tool");
    expect(String(p.content).startsWith("错误:")).toBe(true);
    expect(String(p.content)).toBe("错误:未知工具 nope_tool"); // 文案一字未改
  });

  it("工具 execute 抛错:error.origin=threw,message 带原始错误", async () => {
    const journal = new MemoryJournal();
    await loopOf(journal, "te2", [boomTool], [{ id: "c2", name: "boom_tool", arguments: "{}" }]).runTurn("做");

    const p = payloadOf(journal.readAll(), "tool.result");
    const err = p.error as { origin: string; message: string };
    expect(err.origin).toBe("threw");
    expect(err.message).toContain("工具炸了");
    expect(String(p.content)).toBe("错误:Error: 工具炸了"); // 旧文案原样保留
  });

  it("成功工具:payload 无 error 键('error' in payload === false)", async () => {
    const journal = new MemoryJournal();
    await loopOf(journal, "te3", [okTool], [{ id: "c3", name: "ok_tool", arguments: "{}" }]).runTurn("做");

    const p = payloadOf(journal.readAll(), "tool.result");
    expect(p.content).toBe("正常结果");
    expect("error" in p).toBe(false);
  });

  it("闸门 deny:error.origin=denied(文案前缀兜底判定),工具未执行", async () => {
    const journal = new MemoryJournal();
    const rules: PermissionRule[] = [{ permission: "danger", pattern: "*", action: "deny" }];
    const loop = new AgentLoop({
      journal, sessionId: "te4", system: "s",
      llm: llmOnce([{ id: "c4", name: "danger", arguments: "{}" }]) as never,
      tools: [dangerTool],
      permission: { rules },
      maxSteps: 4,
    } as never);
    await loop.runTurn("做");

    const evs = journal.readAll();
    const p = payloadOf(evs, "tool.result");
    const err = p.error as { origin: string };
    expect(err.origin).toBe("denied");
    expect(String(p.content)).toContain("被权限规则拒绝");
    // 闸门拒绝 = 工具根本没跑,故不落 tool.call(既有配对语义)。
    expect(evs.some((e) => e.kind === "tool.call")).toBe(false);
  });
});

describe("turn/step 归属(txa3)", () => {
  it("tool.result 的 turn/step 与 turn.start/step.start 一致;tool.call 同值", async () => {
    const journal = new MemoryJournal();
    await loopOf(journal, "te5", [okTool], [{ id: "c5", name: "ok_tool", arguments: "{}" }]).runTurn("做");

    const evs = journal.readAll();
    const turnStart = payloadOf(evs, "turn.start") as { turn: number };
    const stepStart = payloadOf(evs, "step.start") as { turn: number; step: number };
    const result = payloadOf(evs, "tool.result") as { turn: number; step: number };
    const callEv = payloadOf(evs, "tool.call") as { turn: number; step: number };

    expect(typeof result.turn).toBe("number");
    expect(typeof result.step).toBe("number");
    expect(result.turn).toBe(turnStart.turn);
    expect(result.step).toBe(stepStart.step);
    expect(callEv.turn).toBe(turnStart.turn);
    expect(callEv.step).toBe(stepStart.step);
  });

  it("message.user 带 turn,不带 step(用户消息不属于某步)", async () => {
    const journal = new MemoryJournal();
    await loopOf(journal, "te6", [okTool], [{ id: "c6", name: "ok_tool", arguments: "{}" }]).runTurn("做");

    const evs = journal.readAll();
    const user = payloadOf(evs, "message.user") as { turn?: unknown; step?: unknown };
    expect(user.turn).toBe((payloadOf(evs, "turn.start") as { turn: number }).turn);
    expect("step" in user).toBe(false);
  });
});

describe("LLM 失败落 durable 事件(txa4)", () => {
  it("chat 抛错:journal 有 llm.trace 且 payload.error 非空、ms≥0、turn/step/model 在场", async () => {
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "te7", system: "s",
      llm: { async chat() { throw new Error("fetch failed"); }, modelName: "m-test" },
      tools: [],
      maxSteps: 2,
    } as never);
    await expect(loop.runTurn("炸")).rejects.toThrow("fetch failed");

    const evs = journal.readAll();
    const traces = evs.filter((e) => e.kind === "llm.trace");
    expect(traces).toHaveLength(1);
    const p = traces[0]!.payload as { error: string; ms: number; model?: string; turn: number; step: number };
    expect(p.error).toBe("fetch failed");
    expect(p.ms).toBeGreaterThanOrEqual(0);
    expect(p.model).toBe("m-test");
    expect(p.turn).toBe((payloadOf(evs, "turn.start") as { turn: number }).turn);
    expect(p.step).toBe(0);
    // 不编造 file 键(loop 拿不到落盘路径)
    expect("file" in p).toBe(false);
  });

  it("成功调用不落 llm.trace(失败事件专用于失败),llmCalls 口径仍由 message.agent 计", async () => {
    const journal = new MemoryJournal();
    await loopOf(journal, "te8", [], []).runTurn("跑");
    const evs = journal.readAll();
    expect(evs.some((e) => e.kind === "llm.trace")).toBe(false);
    expect(evs.filter((e) => e.kind === "message.agent")).toHaveLength(1);
  });
});

describe("取消/未派发归因", () => {
  it("[ABORTED_BEFORE_DISPATCH] 合成结果带 error.origin=aborted(端到端:前一工具内取消)", async () => {
    const journal = new MemoryJournal();
    // 第一个独占工具执行时取消 → 同批后续未派发调用走合成结果(designs/14 §1.3 配对纪律)。
    const cancelTool: Tool = {
      name: "cancel_tool",
      description: "执行中取消整个 turn",
      parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => false,
      async execute(_args, _signal, ctx) {
        holder.loop?.cancel("test-cancel");
        void ctx;
        return "已请求取消";
      },
    };
    const afterTool: Tool = { ...okTool };
    const holder: { loop?: AgentLoop } = {};
    const loop = new AgentLoop({
      journal, sessionId: "te9", system: "s",
      llm: llmOnce([
        { id: "c9a", name: "cancel_tool", arguments: "{}" },
        { id: "c9b", name: "ok_tool", arguments: "{}" },
      ]) as never,
      tools: [cancelTool, afterTool],
      maxSteps: 4,
    } as never);
    holder.loop = loop;
    await loop.runTurn("做");

    const results = journal.readAll().filter((e) => e.kind === "tool.result").map((e) => e.payload as Record<string, unknown>);
    expect(results).toHaveLength(2);
    const dispatched = results.find((r) => r.toolCallId === "c9a")!;
    expect("error" in dispatched).toBe(false); // 已派发且成功 → 无 error 键
    const synthetic = results.find((r) => r.toolCallId === "c9b")!;
    expect(synthetic.content).toBe("[ABORTED_BEFORE_DISPATCH]");
    expect((synthetic.error as { origin: string }).origin).toBe("aborted");
  });

  it("超时:error.origin=timeout(execOne 单函数级,超时文案前缀兜底判定)", async () => {
    const journal = new MemoryJournal();
    const slow: Tool = {
      name: "slow_tool",
      description: "永不返回",
      parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() { await new Promise((r) => setTimeout(r, 60_000)); return "迟到"; },
    };
    const loop = loopOf(journal, "te10", [slow], [], { toolTimeoutMs: 40 });
    const out = await (loop as unknown as { execOne: (c: ToolCall) => Promise<{ content: string; error?: { origin: string } }> })
      .execOne({ id: "c10", name: "slow_tool", arguments: "{}" });
    expect(out.content.startsWith("错误:工具执行超时(")).toBe(true);
    expect(out.error?.origin).toBe("timeout");
    await new Promise((r) => setTimeout(r, 80)); // 迟到 settle 走完,不产生 unhandled
  });

  it("取消:error.origin=aborted(execOne 收到已 abort 的 signal)", async () => {
    const journal = new MemoryJournal();
    const abortable: Tool = {
      name: "abortable",
      description: "抛错工具",
      parameters: { type: "object", properties: {} },
      async execute() { throw new Error("late boom"); },
    };
    const loop = loopOf(journal, "te11", [abortable], []);
    const ac = new AbortController();
    ac.abort();
    const out = await (loop as unknown as { execOne: (c: ToolCall, s: AbortSignal) => Promise<{ content: string; error?: { origin: string } }> })
      .execOne({ id: "c11", name: "abortable", arguments: "{}" }, ac.signal);
    expect(out.content).toBe("[aborted] 执行被取消");
    expect(out.error?.origin).toBe("aborted");
  });
});
