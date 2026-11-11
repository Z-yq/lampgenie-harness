/**
 * 任务预算耗尽优雅收束:末步(step === maxSteps-1)带 toolCalls 时——
 * ① 不执行这些工具,给每个 call 补合成 tool.result(配对不能断);
 * ② step.end reason=budget-exhausted;
 * ③ 恰好一次禁用工具的收尾请求(tools=[]),文本作为 finalText 落 message.agent;
 * ④ turn.end reason=budget-exhausted。
 * 本文件把契约逐条钉死:调用次数/配对/提示文案/空文本与抛错回退/取消优先/usage 合并/非末步不变。
 */
import { describe, it, expect } from "vitest";
import { AgentLoop, deriveMessages } from "../src/agent/loop";
import type { LlmProvider, LlmResponse, Message, Tool, ToolSpec } from "../src/agent/loop";
import { MemoryJournal } from "@lampgenie/core";

type ChatMessages = Message[];
type ChatTools = ToolSpec[];
interface ChatCall { messages: ChatMessages; tools: ChatTools; toolsLen: number; attemptId?: string }
interface Reply {
  content?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  usage?: LlmResponse["usage"];
  throw?: Error;
}

/** 记录每次 chat 调用的 messages/tools(收尾请求的 tools=[] 只能从这里观察)。 */
function scriptedLlm(make: (i: number, call: ChatCall) => Reply | Promise<Reply>): LlmProvider & { calls: ChatCall[] } {
  const calls: ChatCall[] = [];
  const provider = {
    calls,
    async chat(
      messages: ChatMessages,
      tools: ChatTools,
      _signal?: AbortSignal,
      _onDelta?: (d: never) => void,
      opts?: { attemptId?: string },
    ) {
      const call: ChatCall = { messages, tools, toolsLen: tools.length, ...(opts?.attemptId ? { attemptId: opts.attemptId } : {}) };
      calls.push(call);
      const r = await make(calls.length - 1, call);
      if (r.throw) throw r.throw;
      return {
        content: r.content ?? "",
        ...(r.toolCalls ? { toolCalls: r.toolCalls } : {}),
        ...(r.usage ? { usage: r.usage } : {}),
      } as LlmResponse;
    },
  };
  return provider as typeof provider & LlmProvider;
}

const call = (id: string) => ({ id, name: "t", arguments: "{}" });

function setup(args: { maxSteps: number; reply: (i: number, c: ChatCall) => Reply | Promise<Reply> }) {
  const journal = new MemoryJournal();
  const llm = scriptedLlm(args.reply);
  const runs = { n: 0 };
  const tool: Tool = {
    name: "t",
    description: "测试工具",
    parameters: { type: "object", properties: {} },
    async execute() { runs.n += 1; return "ok"; },
  };
  const loop = new AgentLoop({ journal, sessionId: "bw", system: "s", llm, tools: [tool], maxSteps: args.maxSteps });
  return { journal, llm, runs, loop };
}

/** 恒返「带工具调用」的假 LLM:最后一步之前的每步都在调工具。 */
const alwaysTool = (i: number): Reply => ({ content: `工具 ${i}`, toolCalls: [call(`c${i}`)] });

const payloads = (journal: MemoryJournal, kind: string) =>
  journal.readAll().filter((e) => e.kind === kind).map((e) => e.payload as Record<string, unknown>);

const NOT_RUN_2 = "[预算耗尽] 本步工具未执行：已达步数上限 2，收尾阶段不再调用工具；如需继续请拆小任务或调大 maxSteps。";
const WRAP_PROMPT_2 = "已达本任务步数上限(2)。请只用文字给出：已完成什么/未完成什么/建议下一步；不能再调用工具。";
const FALLBACK = "已达步数上限，未能生成收尾结论；请查看已完成步骤或拆小任务后重试。";

describe(" 预算耗尽优雅收束(maxSteps=2 恒返 toolCall)", () => {
  it("provider 恰好 3 次调用:step0 主请求 + step1 主请求 + 1 次收尾", async () => {
    const { llm, loop } = setup({ maxSteps: 2, reply: alwaysTool });
    await loop.runTurn("干活");
    expect(llm.calls).toHaveLength(3);
  });

  it("末步工具不执行:真实 execute 只跑 1 次(step0),step1 的调用被拦在收尾", async () => {
    const { runs, loop } = setup({ maxSteps: 2, reply: alwaysTool });
    await loop.runTurn("干活");
    expect(runs.n).toBe(1);
  });

  it("合成 tool.result 与 assistant 的 toolCalls 一一配对(不悬空)", async () => {
    const { journal, loop } = setup({ maxSteps: 2, reply: alwaysTool });
    await loop.runTurn("干活");
    const callIds = payloads(journal, "message.agent")
      .flatMap((p) => (Array.isArray(p.toolCalls) ? (p.toolCalls as { id: string }[]) : []))
      .map((c) => c.id)
      .sort();
    const resultIds = payloads(journal, "tool.result").map((p) => String(p.toolCallId)).sort();
    expect(callIds).toEqual(["c0", "c1"]);
    expect(resultIds).toEqual(callIds);
  });

  it("合成结果文案为固定口径(带步数上限 N),不是「假装工具跑过」", async () => {
    const { journal, loop } = setup({ maxSteps: 2, reply: alwaysTool });
    await loop.runTurn("干活");
    const contents = payloads(journal, "tool.result").map((p) => String(p.content));
    expect(contents[0]).toBe("ok"); // step0 真实执行
    expect(contents[1]).toBe(NOT_RUN_2); // step1 合成
    expect(payloads(journal, "tool.result")[1]!.durationMs).toBe(0);
  });

  it("收尾请求恰好一次:tools=[] 且带收尾提示(含步数上限)", async () => {
    const { llm, loop } = setup({ maxSteps: 2, reply: alwaysTool });
    await loop.runTurn("干活");
    const wrapups = llm.calls.filter((c) => c.toolsLen === 0);
    expect(wrapups).toHaveLength(1);
    const last = wrapups[0]!.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toBe(WRAP_PROMPT_2);
 // 主请求仍带正常广告面(tools 不被收尾污染)
    expect(llm.calls[0]!.toolsLen).toBe(1);
  });

  it("收尾请求 attemptId 派生:与主请求不撞、可辨识", async () => {
    const { llm, loop } = setup({ maxSteps: 2, reply: alwaysTool });
    await loop.runTurn("干活");
    const ids = llm.calls.map((c) => c.attemptId);
    expect(new Set(ids).size).toBe(3);
    expect(String(ids[2])).toContain("budget-wrapup");
  });

  it("收尾文本 = runTurn 返回值 = 最后一条 message.agent", async () => {
    const reply = (i: number): Reply => (i < 2 ? alwaysTool(i) : { content: "已完成:两步探测;未完成:写入;下一步:拆小任务" });
    const { journal, loop } = setup({ maxSteps: 2, reply });
    const text = await loop.runTurn("干活");
    expect(text).toBe("已完成:两步探测;未完成:写入;下一步:拆小任务");
    const agents = payloads(journal, "message.agent");
    expect(agents.at(-1)!.text).toBe(text);
  });

  it("终态:turn.end/step.end 均为 budget-exhausted", async () => {
    const { journal, loop } = setup({ maxSteps: 2, reply: alwaysTool });
    await loop.runTurn("干活");
    expect(payloads(journal, "turn.end").at(-1)!.reason).toBe("budget-exhausted");
    const stepEnds = payloads(journal, "step.end").map((p) => p.reason);
    expect(stepEnds).toEqual(["tools-done", "budget-exhausted"]);
    expect(payloads(journal, "message.agent")).toHaveLength(3); // 2 主请求 + 1 收尾
  });

  it("收尾 usage 合并进 turn(遥测总量=3 次调用之和)", async () => {
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    const { journal, loop } = setup({ maxSteps: 2, reply: (i) => ({ ...alwaysTool(i), usage }) });
    await loop.runTurn("干活");
    const tele = journal.readAll()
      .filter((e) => e.kind === "custom")
      .map((e) => e.payload as { what?: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } })
      .find((p) => p.what === "telemetry.phase");
    expect(tele?.usage?.totalTokens).toBe(45);
    expect(tele?.usage?.inputTokens).toBe(30);
    expect(tele?.usage?.outputTokens).toBe(15);
  });
});

describe(" 收尾失败与取消", () => {
  it("收尾空文本 → 固定回退文案,不抛错,终态仍 budget-exhausted", async () => {
    const reply = (i: number): Reply => (i < 2 ? alwaysTool(i) : { content: "   " });
    const { journal, loop } = setup({ maxSteps: 2, reply });
    const text = await loop.runTurn("干活");
    expect(text).toBe(FALLBACK);
    expect(payloads(journal, "turn.end").at(-1)!.reason).toBe("budget-exhausted");
    expect(payloads(journal, "message.agent").at(-1)!.text).toBe(FALLBACK);
  });

  it("收尾抛错(非取消)→ 回退文案,turn 不落 error(已完成的进展不算失败)", async () => {
    const reply = (i: number): Reply => (i < 2 ? alwaysTool(i) : { throw: new Error("upstream 500") });
    const { journal, loop } = setup({ maxSteps: 2, reply });
    const text = await loop.runTurn("干活");
    expect(text).toBe(FALLBACK);
    expect(payloads(journal, "turn.end").at(-1)!.reason).toBe("budget-exhausted");
    expect(payloads(journal, "step.end").map((p) => p.reason)).not.toContain("error");
  });

  it("收尾期间用户取消 → 取消优先,turn.end=cancelled(不吞成 budget-exhausted)", async () => {
    let l: AgentLoop | undefined;
    const reply = (i: number): Reply => {
      if (i < 2) return alwaysTool(i);
      l!.cancel("user-cancel"); // 收尾请求发起的同一刻用户点了停止
      return { throw: new Error("cancelled:user-cancel") };
    };
    const s = setup({ maxSteps: 2, reply });
    l = s.loop;
    await s.loop.runTurn("干活");
    expect(payloads(s.journal, "turn.end").at(-1)!.reason).toBe("cancelled");
  });
});

describe(" 边界与逐字不变", () => {
  it("maxSteps=1:第 0 步即收尾(2 次调用,1 条合成结果)", async () => {
    const { journal, llm, runs, loop } = setup({ maxSteps: 1, reply: alwaysTool });
    await loop.runTurn("干活");
    expect(llm.calls).toHaveLength(2);
    expect(runs.n).toBe(0); // 一步都不执行
    const results = payloads(journal, "tool.result");
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe(
      "[预算耗尽] 本步工具未执行：已达步数上限 1，收尾阶段不再调用工具；如需继续请拆小任务或调大 maxSteps。",
    );
    expect(payloads(journal, "turn.end").at(-1)!.reason).toBe("budget-exhausted");
  });

  it("收尾响应意外带 toolCalls 也不进历史(避免悬空配对)", async () => {
    const reply = (i: number): Reply => (i < 2 ? alwaysTool(i) : { content: "结论文字", toolCalls: [call("w0")] });
    const { journal, loop } = setup({ maxSteps: 2, reply });
    const text = await loop.runTurn("干活");
    expect(text).toBe("结论文字");
    const agents = payloads(journal, "message.agent");
    expect("toolCalls" in agents.at(-1)!).toBe(false);
    expect(payloads(journal, "tool.result").map((p) => p.toolCallId)).toEqual(["c0", "c1"]);
  });

  it("非末步行为逐字不变:工具照常执行、step.end=tools-done、终态 completed", async () => {
    const reply = (i: number): Reply => (i < 2 ? alwaysTool(i) : { content: "完成" });
    const { journal, runs, loop } = setup({ maxSteps: 3, reply });
    expect(await loop.runTurn("干活")).toBe("完成");
    expect(runs.n).toBe(2);
    expect(payloads(journal, "tool.result").map((p) => p.content)).toEqual(["ok", "ok"]);
    expect(payloads(journal, "step.end").map((p) => p.reason)).toEqual(["tools-done", "tools-done", "completed"]);
    expect(payloads(journal, "turn.end").at(-1)!.reason).toBe("completed");
  });

  it("无 toolCalls 的末步仍 completed(不误判 budget-exhausted)", async () => {
    const { journal, llm, loop } = setup({ maxSteps: 2, reply: () => ({ content: "直接结论" }) });
    expect(await loop.runTurn("干活")).toBe("直接结论");
    expect(llm.calls).toHaveLength(1);
    expect(payloads(journal, "turn.end").at(-1)!.reason).toBe("completed");
    expect(payloads(journal, "tool.result")).toHaveLength(0);
  });

  it("同一步多个 toolCall 全部合成:2 个调用 → 2 条合成结果,一个都不执行", async () => {
    const reply = (i: number): Reply => (i < 1
      ? { content: "并行两调", toolCalls: [call("p0"), call("p1")] }
      : { content: "结论" });
    const { journal, runs, loop } = setup({ maxSteps: 1, reply });
    await loop.runTurn("干活");
    expect(runs.n).toBe(0);
    const results = payloads(journal, "tool.result");
    expect(results.map((p) => p.toolCallId)).toEqual(["p0", "p1"]);
    expect(results.map((p) => p.content)).toEqual([NOT_RUN_2.replace("上限 2", "上限 1"), NOT_RUN_2.replace("上限 2", "上限 1")]);
    expect(payloads(journal, "message.agent")[0]!.toolCalls).toHaveLength(2);
  });

  it("deriveMessages 投影:合成结果进历史且配对完整(下一轮追问不会 400)", async () => {
    const { journal, loop } = setup({ maxSteps: 2, reply: alwaysTool });
    await loop.runTurn("干活");
    const msgs = deriveMessages(journal, "bw");
    const resultIds = new Set(msgs.filter((m) => m.role === "tool").map((m) => m.toolCallId));
    for (const m of msgs) {
      if (m.role === "assistant" && m.toolCalls?.length) {
        for (const c of m.toolCalls) expect(resultIds.has(c.id), `悬空配对:${c.id}`).toBe(true);
      }
    }
 // 合成说明对模型可见(下一轮它知道哪些工具没跑)
    expect(msgs.some((m) => m.role === "tool" && String(m.content).includes("[预算耗尽]"))).toBe(true);
  });
});
