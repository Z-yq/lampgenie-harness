/**
 * loop 接线(M150):tool.execute 前归一层。
 * 契约:
 *  - 归一成功后工具收到归一参数并正常执行;
 *  - 校验失败 → 该工具结果是 [工具参数错误] 框,turn 不失败、loop 继续(下一步仍可调用);
 *  - 无 schema / schema 非 object → 原样透传(零回归);
 *  - 改名 / coercion 落一条轻量 custom 旁注(payload 不含参数值)。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, type LlmProvider, type LlmResponse, type Tool } from "../src/agent/loop";

function scriptedLlm(steps: { toolCalls?: { id: string; name: string; arguments: string }[] }[]): LlmProvider & { rounds: number } {
  const llm = {
    rounds: 0,
    async chat(): Promise<LlmResponse> {
      const step = steps[Math.min(llm.rounds, steps.length - 1)]!;
      llm.rounds++;
      return step.toolCalls ? { content: "", toolCalls: step.toolCalls } : { content: "done" };
    },
  };
  return llm as LlmProvider & { rounds: number };
}

const mkTool = (name: string, parameters: Record<string, unknown>, execute: (args: unknown) => string): Tool => ({
  name, description: "d", parameters,
  isConcurrencySafe: () => false,
  async execute(args) { return execute(args); },
});

const pathSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };

describe("loop ↔ tool-args", () => {
  it('归一后的参数交给工具("42"→42、file_path→path)并落轻量旁注', async () => {
    const seen: unknown[] = [];
    const numSchema = {
      type: "object",
      properties: { path: { type: "string" }, n: { type: "number" } },
      required: ["path"],
    };
    const journal = new MemoryJournal();
    const llm = scriptedLlm([{ toolCalls: [{ id: "c1", name: "work", arguments: JSON.stringify({ file_path: "a.txt", n: "42" }) }] }, {}]);
    const loop = new AgentLoop({
      journal, sessionId: "s-args-1", system: "", llm,
      tools: [mkTool("work", numSchema, (args) => { seen.push(args); return "ok"; })],
    });
    await loop.runTurn("go");
    expect(seen).toEqual([{ path: "a.txt", n: 42 }]);
    const events = journal.readAll();
    expect(events.filter((e) => e.kind === "tool.result")).toHaveLength(1);
    const note = events.find((e) => e.kind === "custom" && (e.payload as { what?: string }).what === "tool.args.normalized");
    expect(note).toBeDefined();
    const p = note!.payload as { tool: string; renamed: string; coerced: string };
    expect(p.tool).toBe("work");
    expect(p.renamed).toContain("file_path->path");
    expect(p.coerced).toContain("n:string->number");
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(300);
  });

  it("校验失败 → 工具结果是 [工具参数错误],turn 继续,下一步仍可调用成功", async () => {
    const calls: unknown[] = [];
    const journal = new MemoryJournal();
    const llm = scriptedLlm([
      { toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] },
      { toolCalls: [{ id: "c2", name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) }] },
      {},
    ]);
    const loop = new AgentLoop({
      journal, sessionId: "s-args-2", system: "", llm, maxSteps: 5,
      tools: [mkTool("read_file", pathSchema, (args) => { calls.push(args); return "content-a"; })],
    });
    const out = await loop.runTurn("go");
    expect(out).toBe("done");
    expect(calls).toEqual([{ path: "a.txt" }]); // 第一次没执行,第二次执行
    const results = journal.readAll().filter((e) => e.kind === "tool.result").map((e) => String((e.payload as { content: string }).content));
    expect(results).toHaveLength(2);
    expect(results[0]).toContain("[工具参数错误] read_file");
    expect(results[0]).toContain("- path: 期望 required,收到 undefined");
    expect(results[1]).toBe("content-a");
    // 错误框是工具结果而非 turn 失败:turn 正常收口
    const ends = journal.readAll().filter((e) => e.kind === "turn.end");
    expect((ends.at(-1)!.payload as { reason: string }).reason).toBe("completed");
  });

  it("坏 JSON 参数 → 错误框,不抛(loop 继续)", async () => {
    const journal = new MemoryJournal();
    const llm = scriptedLlm([{ toolCalls: [{ id: "c1", name: "read_file", arguments: "{not-json" }] }, {}]);
    const loop = new AgentLoop({
      journal, sessionId: "s-args-3", system: "", llm, maxSteps: 3,
      tools: [mkTool("read_file", pathSchema, () => "should-not-run")],
    });
    await loop.runTurn("go");
    const result = journal.readAll().find((e) => e.kind === "tool.result")!.payload as { content: string; error?: unknown };
    expect(result.content).toContain("[工具参数错误]");
    expect(result.content).toContain("JSON 解析失败");
    expect(result.content).not.toBe("should-not-run");
  });

  it("无 schema / schema 非 object → 原样透传(零回归)", async () => {
    const seen: unknown[] = [];
    const journal = new MemoryJournal();
    const llm = scriptedLlm([{ toolCalls: [{ id: "c1", name: "loose", arguments: JSON.stringify({ n: "42" }) }] }, {}]);
    const loop = new AgentLoop({
      journal, sessionId: "s-args-4", system: "", llm,
      tools: [mkTool("loose", {}, (args) => { seen.push(args); return "ok"; })],
    });
    await loop.runTurn("go");
    expect(seen).toEqual([{ n: "42" }]);
    expect(journal.readAll().some((e) => e.kind === "custom" && (e.payload as { what?: string }).what === "tool.args.normalized")).toBe(false);
  });

  it("既有语义不变:tool.call/tool.result 同 id 配对,结果文本原样落账", async () => {
    const journal = new MemoryJournal();
    const llm = scriptedLlm([{ toolCalls: [{ id: "cx", name: "read_file", arguments: JSON.stringify({ path: "a" }) }] }, {}]);
    const loop = new AgentLoop({
      journal, sessionId: "s-args-5", system: "", llm,
      tools: [mkTool("read_file", pathSchema, () => "plain-result")],
    });
    await loop.runTurn("go");
    const events = journal.readAll();
    const call = events.find((e) => e.kind === "tool.call")!.payload as { toolCallId: string };
    const result = events.find((e) => e.kind === "tool.result")!.payload as { toolCallId: string; content: string };
    expect(result.toolCallId).toBe(call.toolCallId);
    expect(result.content).toBe("plain-result");
  });
});
