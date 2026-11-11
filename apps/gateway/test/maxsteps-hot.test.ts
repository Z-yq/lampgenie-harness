/**
 * maxSteps 热读链操作级验证(C9 闭环):wireAgentLoop(config.agent.maxSteps=2)→
 * 永不停止的假 LLM → 恰好 2 步后以 budget-exhausted 优雅收束(末步不执行工具,
 * 改发一次 tools=[] 的收尾请求);缺省(未传)走 1000。
 * 另加看板映射:budget-exhausted 与 max-steps 同为「等用户接话」,不落错误态。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import type { JournalEvent } from "@lampgenie/core";
import { wireAgentLoop } from "../src/agent-wiring.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { rebuildDashboardSessions } from "../src/dashboard-collector.js";
import { EchoChildBackend } from "@lampgenie/executors";

function setup(maxSteps?: number) {
  const tm = new TaskSupervisor({});
  const journal = new MemoryJournal();
 // seenTools:每次 chat 的 tools 长度——收尾请求必须为 0(禁用工具)。
  const seenTools: number[] = [];
  const llm = {
    async chat(_messages: unknown, tools: unknown[]) {
      seenTools.push(tools.length);
      return { content: "继续", toolCalls: [{ id: "x" + Math.random(), name: "grep", arguments: "{}" }] };
    },
  };
  const tools = [{ name: "grep", description: "d", parameters: { type: "object", properties: { pattern: { type: "string" } } }, isConcurrencySafe: () => true, async execute() { return "r"; } }];
  const executor = new EchoChildBackend();
  wireAgentLoop(tm as never, journal as never, llm as never, executor as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { agent: { maxSteps } } as never);
  return { tm, journal, seenTools };
}

const T0 = 1_700_000_000_000;
/** 造事件(time 偏移毫秒;journal 事件形状)。 */
function ev(kind: string, sid: string, offsetMs: number, payload: unknown = {}): JournalEvent {
  return { kind: kind as JournalEvent["kind"], sessionId: sid, seq: 0, time: T0 + offsetMs, payload };
}

describe("maxSteps 热读链(C9 闭环)", () => {
  it("maxSteps=2:永不完成的任务恰在 2 步后收束(turn.end=budget-exhausted,末次请求无工具)", async () => {
    const { tm, journal, seenTools } = setup(2);
    tm.submit("user", "ms-hot", "永不完成");
    for (let i = 0; i < 100; i++) {
      const t = tm.list().find((x) => x.sessionId === "ms-hot");
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const turnEnd = journal.readAll().filter((e) => e.kind === "turn.end").at(-1);
    expect(turnEnd, "turn 应收口").toBeTruthy();
    expect((turnEnd!.payload as { reason: string }).reason, "应在 2 步后预算收束").toBe("budget-exhausted");
    const steps = journal.readAll().filter((e) => e.kind === "step.end");
    expect(steps.length).toBe(2);
    expect((steps.at(-1)!.payload as { reason: string }).reason).toBe("budget-exhausted");
 // 主请求 2 次 + 收尾 1 次;收尾那次 tools 为空 = 想调也调不到(主请求带完整广告面)
    expect(seenTools).toHaveLength(3);
    expect(seenTools[0]).toBeGreaterThan(0);
    expect(seenTools[2]).toBe(0);
  }, 30_000);
});

describe("看板映射:预算耗尽不是错误态", () => {
  it("budget-exhausted 与 max-steps 同为 waiting_for_input,everError=false", () => {
    for (const reason of ["budget-exhausted", "max-steps"]) {
      const s = rebuildDashboardSessions([
        ev("task.start", "s1", 0, { id: "t1", sessionId: "s1", state: "running" }),
        ev("message.user", "s1", 100, { text: "跑" }),
        ev("turn.end", "s1", 500, { reason }),
      ], T0 + 1_000)[0];
      expect(s, `会话应收口(reason=${reason})`).toBeTruthy();
      expect(s!.status, `reason=${reason} 应等用户接话`).toBe("waiting_for_input");
      expect(s!.hadError, `reason=${reason} 不应落错误态`).toBe(false);
    }
  });
});
