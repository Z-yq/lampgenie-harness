/**
 * maxSteps 热读链操作级验证(C9 闭环):wireAgentLoop(config.agent.maxSteps=2)→
 * 永不停止的假 LLM → 恰好 2 步后 turn.end reason=max-steps;缺省(未传)走 1000。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { wireAgentLoop } from "../src/agent-wiring.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { EchoChildBackend } from "@lampgenie/executors";

function setup(maxSteps?: number) {
  const tm = new TaskSupervisor({});
  const journal = new MemoryJournal();
  const llm = { async chat() { return { content: "继续", toolCalls: [{ id: "x" + Math.random(), name: "grep", arguments: "{}" }] }; } };
  const tools = [{ name: "grep", description: "d", parameters: { type: "object", properties: { pattern: { type: "string" } } }, isConcurrencySafe: () => true, async execute() { return "r"; } }];
  const executor = new EchoChildBackend();
  wireAgentLoop(tm as never, journal as never, llm as never, executor as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { agent: { maxSteps } } as never);
  return { tm, journal };
}

describe("maxSteps 热读链(C9 闭环)", () => {
  it("maxSteps=2:永不完成的任务恰在 2 步截停(turn.end=max-steps)", async () => {
    const { tm, journal } = setup(2);
    tm.submit("user", "ms-hot", "永不完成");
    for (let i = 0; i < 100; i++) {
      const t = tm.list().find((x) => x.sessionId === "ms-hot");
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const turnEnd = journal.readAll().filter((e) => e.kind === "turn.end").at(-1);
    expect(turnEnd, "turn 应收口").toBeTruthy();
    expect((turnEnd!.payload as { reason: string }).reason, "应在 2 步截停").toBe("max-steps");
    const steps = journal.readAll().filter((e) => e.kind === "step.end");
    expect(steps.length).toBe(2);
  }, 30_000);
});
