/**
 * M115 循环护栏 × AgentLoop 端到端:执行前 stop/配额拦截(不执行)、执行后 notice 前置、
 * 只读结果第 2 次 stub(只换模型可见文本,journal 原文不变)、成功 mutation 重置连击、
 * turn 结束 custom tool.loop.guard 落账、跨 turn 状态清零。
 */
import { describe, it, expect } from "vitest";
import { AgentLoop, type LlmProvider, type LlmResponse, type Message, type Tool } from "../src/agent/loop";
import { MemoryJournal } from "@lampgenie/core";

interface ToolResultPayload {
  content?: string;
  modelContent?: string;
  error?: { origin?: string };
}

function mkTool(name: string, result: string | ((n: number) => string) = `${name}-ok`): Tool {
  let n = 0;
  return {
    name,
    description: "d",
    parameters: { type: "object", properties: {} },
    isConcurrencySafe: () => true,
    async execute() {
      n += 1;
      return typeof result === "function" ? result(n) : result;
    },
  };
}

function resultsOf(journal: MemoryJournal): ToolResultPayload[] {
  return journal.readAll()
    .filter((e) => e.kind === "tool.result")
    .map((e) => e.payload as ToolResultPayload);
}

function guardEvents(journal: MemoryJournal): { turn?: number; stops?: number; notices?: number; stubbed?: number; quotas?: number }[] {
  return journal.readAll()
    .filter((e) => e.kind === "custom" && (e.payload as { what?: string }).what === "tool.loop.guard")
    .map((e) => e.payload as { turn?: number; stops?: number; notices?: number; stubbed?: number; quotas?: number });
}

/** 固定脚本的假 provider(脚本耗尽后固定返回 done)。 */
function scriptedLlm(script: LlmResponse[], seen: Message[][] = []): LlmProvider {
  return {
    async chat(messages: Message[]): Promise<LlmResponse> {
      seen.push(messages);
      return script.shift() ?? { content: "done" };
    },
  };
}

const call = (id: string, name: string, args: Record<string, unknown>): LlmResponse => ({
  content: "",
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
});

describe("同签名连击:第 3 次 notice,第 5 次不执行", () => {
  it("read_file 同参 5 次:执行 4 次,第 5 次回 GUARD_STOP,journal 落一条汇总", async () => {
    let executed = 0;
    const tool: Tool = {
      name: "read_file",
      description: "d",
      parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() { executed += 1; return "SAME-CONTENT"; },
    };
    const llm = scriptedLlm([
      call("c1", "read_file", { path: "a" }),
      call("c2", "read_file", { path: "a" }),
      call("c3", "read_file", { path: "a" }),
      call("c4", "read_file", { path: "a" }),
      call("c5", "read_file", { path: "a" }),
      { content: "done" },
    ]);
    const journal = new MemoryJournal();
    const loop = new AgentLoop({ journal, sessionId: "guard-sig", system: "s", llm, tools: [tool], maxSteps: 8 });
    await loop.runTurn("go");

    const rs = resultsOf(journal);
    expect(executed).toBe(4); // 第 5 次被拦下
    expect(rs).toHaveLength(5);
    expect(rs[2]?.content).toContain("循环护栏"); // 第 3 次 notice
    expect(rs[4]?.content).toContain("GUARD_STOP");
    expect(rs[4]?.error?.origin).toBe("guard");

    const events = guardEvents(journal);
    expect(events).toHaveLength(1);
    expect(events[0]?.notices).toBeGreaterThanOrEqual(1);
    expect(events[0]?.stops).toBeGreaterThanOrEqual(1);
    expect(events[0]?.turn).toBe(events[0]?.turn); // 带 turn 字段
    expect(typeof events[0]?.turn).toBe("number");
  });
});

describe("批次周期:A,B,A,B 两轮 notice,第三轮 stop", () => {
  it("交替调用:第 4 次 notice,第 6 次不执行", async () => {
    let execA = 0;
    let execB = 0;
    const toolA: Tool = {
      name: "read_file", description: "d", parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() { execA += 1; return `A${execA}`; },
    };
    const toolB: Tool = {
      name: "grep", description: "d", parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() { execB += 1; return `B${execB}`; },
    };
    const llm = scriptedLlm([
      call("a1", "read_file", { path: "a" }),
      call("b1", "grep", { pattern: "x" }),
      call("a2", "read_file", { path: "a" }),
      call("b2", "grep", { pattern: "x" }),
      call("a3", "read_file", { path: "a" }),
      call("b3", "grep", { pattern: "x" }),
      { content: "done" },
    ]);
    const journal = new MemoryJournal();
    const loop = new AgentLoop({ journal, sessionId: "guard-cycle", system: "s", llm, tools: [toolA, toolB], maxSteps: 8 });
    await loop.runTurn("go");

    const rs = resultsOf(journal);
    expect(rs).toHaveLength(6);
    expect(rs[3]?.content).toContain("批次循环");
    expect(rs[5]?.content).toContain("GUARD_STOP");
    expect(rs[5]?.error?.origin).toBe("guard");
    expect(execA + execB).toBe(5);
  });
});

describe("结果去重 stub:只改模型可见文本", () => {
  it("read_file 两次相同结果 → 第 2 次 modelContent=stub,journal content 原文不动;模型历史看到 stub", async () => {
    const seen: Message[][] = [];
    const llm = scriptedLlm([
      call("r1", "read_file", { path: "f1" }),
      call("r2", "read_file", { path: "f2" }),
      { content: "done" },
    ], seen);
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "guard-stub", system: "s", llm,
      tools: [mkTool("read_file", "SAME")], maxSteps: 5,
    });
    await loop.runTurn("go");

    const rs = resultsOf(journal);
    expect(rs).toHaveLength(2);
    expect(rs[0]?.content).toBe("SAME");
    expect(rs[0]?.modelContent).toBeUndefined();
    expect(rs[1]?.content).toBe("SAME"); // journal 原文不变
    expect(rs[1]?.modelContent).toContain("结果与第 1 次调用相同");

    // 模型侧历史确实拿到 stub(deriveMessages 优先 modelContent)
    const toolTexts = seen.flatMap((msgs) => msgs.filter((m) => m.role === "tool").map((m) => String(m.content)));
    expect(toolTexts.some((t) => t.includes("结果与第 1 次调用相同"))).toBe(true);
    expect(guardEvents(journal)[0]?.stubbed).toBe(1);
  });

  it("write_file 相同结果不 stub", async () => {
    const llm = scriptedLlm([
      call("w1", "write_file", { path: "o1" }),
      call("w2", "write_file", { path: "o2" }),
      { content: "done" },
    ]);
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "guard-stub-write", system: "s", llm,
      tools: [mkTool("write_file", "WRITTEN")], maxSteps: 5,
    });
    await loop.runTurn("go");
    const rs = resultsOf(journal);
    expect(rs).toHaveLength(2);
    expect(rs[1]?.content).toBe("WRITTEN");
    expect(rs[1]?.modelContent).toBeUndefined();
    expect(guardEvents(journal)).toHaveLength(0); // 无 stub/无 stop/无 notice 时不落账
  });
});

describe("每轮配额", () => {
  it("web_search 默认 8:第 9 次 GUARD_QUOTA 且不执行", async () => {
    let executed = 0;
    const tool: Tool = {
      name: "web_search", description: "d", parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() { executed += 1; return `hit-${executed}`; },
    };
    const script = Array.from({ length: 9 }, (_, i) => call(`s${i}`, "web_search", { query: `q${i}` }));
    const llm = scriptedLlm([...script, { content: "done" }]);
    const journal = new MemoryJournal();
    const loop = new AgentLoop({ journal, sessionId: "guard-quota-ws", system: "s", llm, tools: [tool], maxSteps: 12 });
    await loop.runTurn("go");

    const rs = resultsOf(journal);
    expect(executed).toBe(8);
    expect(rs).toHaveLength(9);
    expect(rs[8]?.content).toContain("GUARD_QUOTA");
    expect(rs[8]?.error?.origin).toBe("guard");
    expect(guardEvents(journal)[0]?.quotas).toBe(1);
  });

  it("spawn_subagent 默认 6:第 7 次 GUARD_QUOTA", async () => {
    let executed = 0;
    const tool: Tool = {
      name: "spawn_subagent", description: "d", parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() { executed += 1; return `sub-${executed}`; },
    };
    const script = Array.from({ length: 7 }, (_, i) => call(`p${i}`, "spawn_subagent", { instructions: `job${i}` }));
    const llm = scriptedLlm([...script, { content: "done" }]);
    const journal = new MemoryJournal();
    const loop = new AgentLoop({ journal, sessionId: "guard-quota-sub", system: "s", llm, tools: [tool], maxSteps: 12 });
    await loop.runTurn("go");
    const rs = resultsOf(journal);
    expect(executed).toBe(6);
    expect(rs[6]?.content).toContain("GUARD_QUOTA");
  });

  it("env 可调(1=第 2 次拦)且 0=关", async () => {
    const runWith = async (envValue: string): Promise<{ executed: number; results: ToolResultPayload[] }> => {
      const prev = process.env.GENIE_GUARD_WEB_SEARCH_MAX;
      process.env.GENIE_GUARD_WEB_SEARCH_MAX = envValue;
      try {
        let executed = 0;
        const tool: Tool = {
          name: "web_search", description: "d", parameters: { type: "object", properties: {} },
          isConcurrencySafe: () => true,
          async execute() { executed += 1; return `r-${executed}`; },
        };
        const script = Array.from({ length: 3 }, (_, i) => call(`e${i}`, "web_search", { query: `qq${i}` }));
        const journal = new MemoryJournal();
        const loop = new AgentLoop({ journal, sessionId: `guard-env-${envValue}`, system: "s", llm: scriptedLlm([...script, { content: "done" }]), tools: [tool], maxSteps: 6 });
        await loop.runTurn("go");
        return { executed, results: resultsOf(journal) };
      } finally {
        if (prev === undefined) delete process.env.GENIE_GUARD_WEB_SEARCH_MAX;
        else process.env.GENIE_GUARD_WEB_SEARCH_MAX = prev;
      }
    };

    const limited = await runWith("1");
    expect(limited.executed).toBe(1);
    expect(limited.results[1]?.content).toContain("GUARD_QUOTA");

    const off = await runWith("0");
    expect(off.executed).toBe(3);
    expect(off.results.some((r) => String(r.content).includes("GUARD_QUOTA"))).toBe(false);
  });
});

describe("成功 mutation 重置连击 / turn 状态清零", () => {
  it("read×2 → write 成功 → read 不再 notice", async () => {
    const llm = scriptedLlm([
      call("m1", "read_file", { path: "a" }),
      call("m2", "read_file", { path: "a" }),
      call("m3", "write_file", { path: "a" }),
      call("m4", "read_file", { path: "a" }),
      { content: "done" },
    ]);
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "guard-reset", system: "s", llm,
      tools: [mkTool("read_file", (n) => `read-${n}`), mkTool("write_file", "WRITTEN")], maxSteps: 6,
    });
    await loop.runTurn("go");
    const rs = resultsOf(journal);
    expect(rs).toHaveLength(4);
    expect(rs.some((r) => String(r.content).includes("循环护栏"))).toBe(false);
  });

  it("跨 turn 清零:turn1 有 notice,turn2 单次调用无 notice,且各 turn 各落一条汇总", async () => {
    let execN = 0;
    const tool: Tool = {
      name: "read_file", description: "d", parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() { execN += 1; return `SAME`; },
    };
    const llm = scriptedLlm([
      call("t1a", "read_file", { path: "a" }),
      call("t1b", "read_file", { path: "a" }),
      call("t1c", "read_file", { path: "a" }),
      { content: "done-1" },
      call("t2a", "read_file", { path: "a" }),
      { content: "done-2" },
    ]);
    const journal = new MemoryJournal();
    const loop = new AgentLoop({ journal, sessionId: "guard-turn", system: "s", llm, tools: [tool], maxSteps: 6 });

    await loop.runTurn("go1");
    await loop.runTurn("go2");

    const rs = resultsOf(journal);
    const turn2Results = rs.slice(3); // turn1 三次 + turn2 一次
    expect(turn2Results).toHaveLength(1);
    // turn2 的 guard 状态已清零:无护栏 notice、无 stub(既有「整步签名连击」提示不属本机制,可能附带)。
    expect(String(turn2Results[0]?.content).startsWith("SAME")).toBe(true);
    expect(String(turn2Results[0]?.content)).not.toContain("循环护栏");
    expect(turn2Results[0]?.modelContent).toBeUndefined();

    const events = guardEvents(journal);
    expect(events).toHaveLength(1); // 只有 turn1 有活动
    expect(typeof events[0]?.turn).toBe("number");
    const turnStarts = journal.readAll().filter((e) => e.kind === "turn.start");
    expect(turnStarts).toHaveLength(2);
  });
});
