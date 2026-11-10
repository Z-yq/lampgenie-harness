/**
 * 轨迹卡 + 注入闸在 loop 里的接线(J1,2026-11 token 轮):
 * ①trajectorySteps 节奏 ②phase 切换立即落 ③tip.injected 带累计 tokensSpent
 * ④pending 同正文在 +5k 被闸拦、+10k 放行 ⑤负面断言:task.trajectory 不进 deriveMessages。
 */
import { describe, it, expect } from "vitest";
import { AgentLoop, deriveMessages } from "../src/agent/loop";
import { MemoryJournal } from "@lampgenie/core";
import type { LlmProvider, LlmResponse } from "../src/agent/loop";

const echoTool = {
  name: "echo", description: "d", parameters: { type: "object", properties: {} },
  isConcurrencySafe: () => true, async execute() { return "ok"; },
} as never;

type TrajectoryPayload = {
  taskId?: string; step: number; turn: number; steps: number; calls: number;
  tools: Record<string, number>; parallelRate: number; errors: number; retries: number;
  tokensSpent: number; phase?: string; subgoal: string;
};

/** 假 provider:前 toolSteps 步各发一次 echo 调用,之后给终态文本;usage 每步固定。 */
function fakeLlm(opts: { toolSteps: number; tokensPerCall: number; onCall?: (n: number) => void }): LlmProvider {
  let n = 0;
  return {
    async chat(): Promise<LlmResponse> {
      n++;
      opts.onCall?.(n);
      const usage = { inputTokens: opts.tokensPerCall, outputTokens: 0, totalTokens: opts.tokensPerCall };
      return n <= opts.toolSteps
        ? { content: "", toolCalls: [{ id: `c${n}`, name: "echo", arguments: JSON.stringify({ path: `f${n}.ts` }) }], usage }
        : { content: "结论:完成", usage };
    },
  };
}

describe("task.trajectory 轨迹卡", () => {
  it("trajectorySteps=2 跑 4 步 → ≥2 条轨迹卡且字段齐", async () => {
    const journal = new MemoryJournal();
    // step 从 0 起:step0 不落卡(无「上一步」),节奏点落在 step1/step3 → 需 ≥4 次工具步才凑够 2 条。
    const loop = new AgentLoop({
      journal, sessionId: "traj-1", system: "s", tools: [echoTool], maxSteps: 8,
      llm: fakeLlm({ toolSteps: 5, tokensPerCall: 400 }),
      trajectorySteps: 2,
      trajectoryTaskId: () => "task-42",
      trajectoryMeta: () => ({ phase: "implement", subgoal: "改 loop 注入点" }),
    });
    await loop.runTurn("干活");

    const cards = journal.readAll().filter((e) => e.kind === "task.trajectory");
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const p = cards[0].payload as TrajectoryPayload;
    expect(p.taskId).toBe("task-42");
    expect(p.step).toBe(1); // 第 1 步触发(step 0 不落)
    expect(p.turn).toBeGreaterThan(0);
    expect(p.steps).toBe(2); // step0+step1 两步已统计
    expect(p.calls).toBe(2);
    expect(p.tools).toEqual({ echo: 2 });
    expect(p.parallelRate).toBe(0); // 每步只有 1 个调用
    expect(p.errors).toBe(0);
    expect(p.retries).toBe(0);
    expect(p.tokensSpent).toBe(800); // usage 400 × 2 次调用
    expect(p.phase).toBe("implement");
    expect(p.subgoal).toBe("改 loop 注入点");
    expect(cards[0].sessionId).toBe("traj-1");
  }, 20_000);

  it("phase 变化 → 不等步数节奏,立即落一条", async () => {
    const journal = new MemoryJournal();
    let phase = "understand";
    const loop = new AgentLoop({
      journal, sessionId: "traj-2", system: "s", tools: [echoTool], maxSteps: 5,
      // 第 3 次调用(step2 组装时)阶段才变:step0 不落卡,step1 落 understand、step2 因 phase 变立即落 implement
      llm: fakeLlm({ toolSteps: 3, tokensPerCall: 100, onCall: (n) => { if (n >= 3) phase = "implement"; } }),
      trajectorySteps: 10, // 节奏远未到,只因 phase 变化落卡
      trajectoryMeta: () => ({ phase, subgoal: "" }),
    });
    await loop.runTurn("干活");

    const cards = journal.readAll().filter((e) => e.kind === "task.trajectory").map((e) => e.payload as TrajectoryPayload);
    expect(cards.map((c) => c.phase)).toEqual(["understand", "implement"]);
    expect(cards[0].subgoal).toBe(""); // 缺省子目标落空串
  }, 20_000);

  it("tip.injected payload.tokensSpent = 累计 usage(逐步抬升)", async () => {
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "traj-3", system: "s", tools: [echoTool], maxSteps: 4,
      llm: fakeLlm({ toolSteps: 2, tokensPerCall: 1_500 }),
      // 第 1、2 步各注入一次(装配方自带去重策略;loop 只负责给 ctx.tokensSpent)
      tips: (ctx) => (ctx.step >= 1 && ctx.step <= 2 ? `<system-reminder>tips S${ctx.step}</system-reminder>` : null),
    });
    await loop.runTurn("干活");

    const evs = journal.readAll().filter((e) => e.kind === "tip.injected").map((e) => e.payload as { step: number; tokensSpent: number });
    expect(evs.length).toBe(2);
    // step1 注入时 token 计数=step0 一次调用;step2 时=两次
    expect(evs[0].step).toBe(1);
    expect(evs[0].tokensSpent).toBe(1_500);
    expect(evs[1].tokensSpent).toBe(3_000);
  }, 20_000);

  it("tips ctx 带齐新字段(gate/lastStepFiles/totalErrors/trajectory/tokensSpent)", async () => {
    const journal = new MemoryJournal();
    const snap: { hasGate: boolean; files: string[]; tokens: number; trajectory?: string }[] = [];
    const loop = new AgentLoop({
      journal, sessionId: "traj-4", system: "s", tools: [echoTool], maxSteps: 3,
      llm: fakeLlm({ toolSteps: 2, tokensPerCall: 200 }),
      trajectorySteps: 1,
      trajectoryMeta: () => ({ phase: "verify", subgoal: "跑测试" }),
      tips: (ctx) => {
        snap.push({
          hasGate: typeof ctx.gate?.check === "function",
          files: ctx.lastStepFiles,
          tokens: ctx.tokensSpent,
          trajectory: ctx.trajectory,
        });
        return null;
      },
    });
    await loop.runTurn("干活");

    expect(snap[0].hasGate).toBe(true);
    expect(snap[0].files).toEqual([]); // step0 无上一步
    expect(snap[1].files).toEqual(["f1.ts"]); // 从 arguments.path 解析
    expect(snap[2].tokens).toBe(400);
    expect(snap[2].trajectory, "上一步落卡后摘要行可见").toContain("并行");
    expect(snap[2].trajectory).toContain("跑测试");
  }, 20_000);
});

describe("pending 审批注入的 token 闸", () => {
  it("同正文 +5k 拒、+10k 放行(正文变=新 key 立即放行)", async () => {
    const journal = new MemoryJournal();
    const perStep: string[] = [];
    const pending = "<system-reminder>待决审批:requestId=req-1</system-reminder>";
    let call = 0;
    const llm: LlmProvider = {
      async chat(messages): Promise<LlmResponse> {
        call++;
        perStep.push(messages.map((m) => String(m.content)).join("\n"));
        const usage = { inputTokens: 5_000, outputTokens: 0, totalTokens: 5_000 };
        return call <= 3
          ? { content: "", toolCalls: [{ id: `c${call}`, name: "echo", arguments: "{}" }], usage }
          : { content: "结论:完成", usage };
      },
    };
    const loop = new AgentLoop({
      journal, sessionId: "pend-1", system: "s", tools: [echoTool], maxSteps: 4,
      llm, pendingQuestions: () => pending,
    });
    await loop.runTurn("干活");

    // step0:无记录→放行;step1:5k<10k→拒;step2:10k→放行;step3:15k<20k→拒
    expect(perStep[0]).toContain("req-1");
    expect(perStep[1]).not.toContain("req-1");
    expect(perStep[2]).toContain("req-1");
    expect(perStep[3]).not.toContain("req-1");
  }, 20_000);

  it("正文变化 → 换 key,即使水位未到也立即注入(到达性)", async () => {
    const journal = new MemoryJournal();
    const perStep: string[] = [];
    let call = 0;
    // 每步正文带不同 requestId:旧 request 了结、新 request 出现
    const llm: LlmProvider = {
      async chat(messages): Promise<LlmResponse> {
        call++;
        perStep.push(messages.map((m) => String(m.content)).join("\n"));
        const usage = { inputTokens: 5_000, outputTokens: 0, totalTokens: 5_000 };
        return call <= 3
          ? { content: "", toolCalls: [{ id: `c${call}`, name: "echo", arguments: "{}" }], usage }
          : { content: "结论:完成", usage };
      },
    };
    const loop = new AgentLoop({
      journal, sessionId: "pend-2", system: "s", tools: [echoTool], maxSteps: 4,
      llm,
      pendingQuestions: () => `<system-reminder>待决审批:requestId=req-${call + 1}</system-reminder>`,
    });
    await loop.runTurn("干活");

    // 每步都是新正文 → 每步都注入(闸拦不住新 key)
    expect(perStep[0]).toContain("req-1");
    expect(perStep[1]).toContain("req-2");
    expect(perStep[2]).toContain("req-3");
  }, 20_000);
});

describe("轨迹卡是旁路(零上下文影响)", () => {
  it("deriveMessages 处理含 task.trajectory 的 journal 后不含轨迹内容", async () => {
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "traj-neg", system: "s", tools: [echoTool], maxSteps: 3,
      llm: fakeLlm({ toolSteps: 2, tokensPerCall: 100 }),
      trajectorySteps: 1,
      trajectoryMeta: () => ({ phase: "TRAJECTORY-PHASE-MARK", subgoal: "TRAJECTORY-SUBGOAL-MARK" }),
    });
    await loop.runTurn("干活");

    expect(journal.readAll().filter((e) => e.kind === "task.trajectory").length).toBeGreaterThan(0);
    const msgs = deriveMessages(journal, "traj-neg");
    expect(msgs.length).toBeGreaterThan(0); // 会话真相照常在
    const dump = JSON.stringify(msgs);
    expect(dump).not.toContain("TRAJECTORY-PHASE-MARK");
    expect(dump).not.toContain("TRAJECTORY-SUBGOAL-MARK");
    expect(dump).not.toContain("task.trajectory");
  }, 20_000);

  it("无 phase 信号时按 N 步节奏落卡:trajectorySteps=3 → step 3/6(不是 2/5)", async () => {
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "traj-cadence", system: "s", tools: [echoTool], maxSteps: 10,
      llm: fakeLlm({ toolSteps: 8, tokensPerCall: 100 }),
      trajectorySteps: 3,
      trajectoryMeta: () => ({}), // 不给 phase → 只有步数节奏触发(隔离 phase 首次必落的分支)
    });
    await loop.runTurn("干活");
    const steps = journal.readAll().filter((e) => e.kind === "task.trajectory").map((e) => (e.payload as TrajectoryPayload).step);
    expect(steps).toEqual([3, 6]); // 每 N 步=第 N/2N… 步;初值 -1 会让它变成 2/5(已修)
  }, 20_000);
});

/* ───────────── onTrajectory 回调(J1 接线闭环,2026-11):gateway 靠它写 task.progress ───────────── */

type TrajEv = {
  taskId?: string; step: number; turn: number; phase?: string; subgoal: string;
  tokensSpent: number; errors: number; steps: number; tools: Record<string, number>;
};

describe("onTrajectory 回调", () => {
  it("每 5 步触发一次(不是每步):12 步工具 → step 5/10 两次", async () => {
    const journal = new MemoryJournal();
    const evs: TrajEv[] = [];
    const loop = new AgentLoop({
      journal, sessionId: "traj-cb-1", system: "s", tools: [echoTool], maxSteps: 20,
      llm: fakeLlm({ toolSteps: 12, tokensPerCall: 100 }),
      trajectorySteps: 5,
      trajectoryTaskId: () => "task-cb",
      onTrajectory: (ev) => { evs.push(ev); },
    });
    await loop.runTurn("干活");
    expect(evs.map((e) => e.step)).toEqual([5, 10]); // 只在真正 due 的那次触发
    const cards = journal.readAll().filter((e) => e.kind === "task.trajectory");
    expect(cards.length).toBe(evs.length); // 与落账条数一一对应
  }, 20_000);

  it("payload 字段与 journal 的 task.trajectory 完全一致(同源)", async () => {
    const journal = new MemoryJournal();
    const evs: TrajEv[] = [];
    const loop = new AgentLoop({
      journal, sessionId: "traj-cb-2", system: "s", tools: [echoTool], maxSteps: 6,
      llm: fakeLlm({ toolSteps: 5, tokensPerCall: 300 }),
      trajectorySteps: 2,
      trajectoryTaskId: () => "task-42",
      trajectoryMeta: () => ({ phase: "implement", subgoal: "改注入点" }),
      onTrajectory: (ev) => { evs.push(ev); },
    });
    await loop.runTurn("干活");
    expect(evs.length).toBeGreaterThanOrEqual(2);
    const cards = journal.readAll().filter((e) => e.kind === "task.trajectory").map((e) => e.payload as Record<string, unknown>);
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i]!;
      const p = cards[i]!;
      const evKeys = Object.keys(ev);
      const subset = Object.fromEntries(evKeys.map((k) => [k, p[k]]));
      expect(ev).toEqual(subset); // 同名字段值一致,且 ev 不带 journal 里没有的字段
      expect(p.taskId).toBe("task-42");
    }
    expect(evs[0]!.phase).toBe("implement");
    expect(evs[0]!.subgoal).toBe("改注入点");
    expect(evs[0]!.tokensSpent).toBeGreaterThan(0);
    expect(evs[0]!.tools).toEqual(cards[0]!.tools);
  }, 20_000);

  it("phase 变化 → 不等步数节奏即回调(且 step 不必是 N 的倍数)", async () => {
    const journal = new MemoryJournal();
    let phase = "understand";
    const evs: TrajEv[] = [];
    const loop = new AgentLoop({
      journal, sessionId: "traj-cb-3", system: "s", tools: [echoTool], maxSteps: 5,
      llm: fakeLlm({ toolSteps: 3, tokensPerCall: 100, onCall: (n) => { if (n >= 3) phase = "implement"; } }),
      trajectorySteps: 10, // 节奏远未到
      trajectoryMeta: () => ({ phase, subgoal: "" }),
      onTrajectory: (ev) => { evs.push(ev); },
    });
    await loop.runTurn("干活");
    expect(evs.map((e) => e.phase)).toEqual(["understand", "implement"]);
    expect(evs.map((e) => e.step)).toEqual([1, 2]);
  }, 20_000);

  it("无 trajectoryTaskId → ev.taskId 为 undefined(不带归属)", async () => {
    const journal = new MemoryJournal();
    const evs: TrajEv[] = [];
    const loop = new AgentLoop({
      journal, sessionId: "traj-cb-4", system: "s", tools: [echoTool], maxSteps: 4,
      llm: fakeLlm({ toolSteps: 3, tokensPerCall: 100 }),
      trajectorySteps: 1,
      onTrajectory: (ev) => { evs.push(ev); },
    });
    await loop.runTurn("干活");
    expect(evs.length).toBeGreaterThan(0);
    for (const ev of evs) expect(ev.taskId).toBeUndefined();
  }, 20_000);

  it("回调抛错不打断 turn(task 照常收尾,后续步照常回调)", async () => {
    const journal = new MemoryJournal();
    let n = 0;
    const loop = new AgentLoop({
      journal, sessionId: "traj-cb-5", system: "s", tools: [echoTool], maxSteps: 6,
      llm: fakeLlm({ toolSteps: 4, tokensPerCall: 100 }),
      trajectorySteps: 1,
      onTrajectory: () => { n += 1; throw new Error("progress boom"); },
    });
    const out = await loop.runTurn("干活");
    expect(out).toBe("结论:完成");
    expect(n).toBeGreaterThanOrEqual(2); // 抛错后下一步仍会回调(不残留脏状态)
    expect(journal.readAll().filter((e) => e.kind === "task.trajectory").length).toBe(n);
  }, 20_000);
});
