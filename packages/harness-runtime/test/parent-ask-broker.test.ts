import { describe, it, expect } from "vitest";
import { AgentLoop, deriveMessages, type Tool, type Message, type LlmResponse } from "../src/agent/loop";
import {
  ParentAskBroker,
  driveParentDecision,
  renderPendingQuestionsBlock,
  buildSubagentAnswerTool,
  ANSWER_SUBAGENT_SPEC,
} from "../src/agent/parent-ask-broker";
import { MemoryJournal } from "@lampgenie/core";
import type { PermissionRule } from "@lampgenie/core";

/** 命令执行工具(子代理 run_cmd 同形态:参数带 command 字符串)。 */
function runCmdTool(executeLog: string[]): Tool {
  return {
    name: "run_cmd",
    description: "执行命令",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    async execute(args: unknown) {
      const cmd = String((args as { command?: string }).command ?? "");
      executeLog.push(cmd);
      return `ran:${cmd}`;
    },
  };
}

function scriptedLlm(steps: ((messages: Message[]) => LlmResponse)[]) {
  let i = 0;
  return {
    async chat(messages: Message[]): Promise<LlmResponse> {
      const step = steps[Math.min(i++, steps.length - 1)];
      return step!(messages);
    },
  };
}

/** 子 loop 装配(重操作闸→broker.ask):生产 LlmLoopBackend Phase 2 同构。 */
function childLoopWithBroker(broker: ParentAskBroker, taskId: string, journal: MemoryJournal, tool: Tool, extraPermission: Record<string, unknown> = {}) {
  return new AgentLoop({
    journal,
    sessionId: "child-" + taskId,
    system: "child",
    llm: scriptedLlm([
      () => ({ content: "", toolCalls: [{ id: "c1", name: "run_cmd", arguments: JSON.stringify({ command: "pnpm build" }) }] }),
      () => ({ content: "done" }),
    ]),
    tools: [tool],
    permission: {
      rules: [{ permission: "run_cmd", pattern: "*", action: "allow" }] as PermissionRule[],
      heavyOp: {
        callerIsSubagent: true,
        onHeavyAsk: async (call, match) => {
          const command = String((JSON.parse(call.arguments) as { command?: string }).command ?? "");
          const a = await broker.ask({ taskId, role: "worker", tool: call.name, command, match });
          return a.approved;
        },
      },
      ...extraPermission,
    },
  });
}

const gatesOf = (j: MemoryJournal) => j.readAll().filter((e) => e.kind === "permission.gate");
const asksOf = (j: MemoryJournal) => j.readAll().filter((e) => e.kind === "custom" && (e.payload as { topic?: string }).topic === "subagent.heavy-ask");
const answersOf = (j: MemoryJournal) => j.readAll().filter((e) => e.kind === "custom" && (e.payload as { topic?: string }).topic === "subagent.heavy-answer");

describe("loop 重操作闸(D2 强制 ask:allow 规则拦不住)", () => {
  it("子代理 run_cmd build:allow 规则在场仍强制走 onHeavyAsk;拒绝→不执行+拒绝文案", async () => {
    const journal = new MemoryJournal();
    const broker = new ParentAskBroker({ journal, sessionId: "parent-s1" });
    broker.onPending = (q) => { setImmediate(() => broker.answer(q.requestId, { approved: false, reason: "资源紧张,先不要构建" })); };
    const log: string[] = [];
    const loop = childLoopWithBroker(broker, "t1", journal, runCmdTool(log));
    await loop.runTurn("做任务");
    expect(log).toEqual([]); // 工具未执行
    const toolResult = journal.readAll().find((e) => e.kind === "tool.result");
    expect(String((toolResult!.payload as { content: string }).content)).toContain("重操作");
    expect(String((toolResult!.payload as { content: string }).content)).toContain("未获父代理批准");
    const g = gatesOf(journal)[0]!.payload as { effect: string; by: string; heavy: { category: string } };
    expect(g.effect).toBe("denied");
    expect(g.by).toBe("heavy-op-rejected");
    expect(g.heavy.category).toBe("build");
    // 问答审计成对(journal 落在父 journal)
    expect(asksOf(journal)).toHaveLength(1);
    const ans = answersOf(journal)[0]!.payload as { approved: boolean; reason?: string; by: string };
    expect(ans.approved).toBe(false);
    expect(ans.reason).toContain("资源紧张");
    expect(ans.by).toBe("parent-llm");
  });

  it("父代理自身同命令不受闸(无 heavyOp 配置=旧行为,allow 规则直接放行)", async () => {
    const journal = new MemoryJournal();
    const log: string[] = [];
    await new AgentLoop({
      journal, sessionId: "main-s", system: "main",
      llm: scriptedLlm([
        () => ({ content: "", toolCalls: [{ id: "c1", name: "run_cmd", arguments: JSON.stringify({ command: "pnpm build" }) }] }),
        () => ({ content: "ok" }),
      ]),
      tools: [runCmdTool(log)],
      permission: { rules: [{ permission: "run_cmd", pattern: "*", action: "allow" }] },
    }).runTurn("构建");
    expect(log).toEqual(["pnpm build"]); // 直接执行,无闸
    expect(gatesOf(journal)).toHaveLength(0);
  });

  it("非重操作命令不走闸(allow 规则放行);豁免命令不进 ask;无 command 参数工具不进闸", async () => {
    const journal = new MemoryJournal();
    const broker = new ParentAskBroker({ journal, sessionId: "p" });
    let asked = 0;
    broker.onPending = () => { asked++; };
    const log: string[] = [];
    const loop = new AgentLoop({
      journal, sessionId: "child-t2", system: "child",
      llm: scriptedLlm([
        () => ({ content: "", toolCalls: [
          { id: "c1", name: "run_cmd", arguments: JSON.stringify({ command: "grep -rn foo src/" }) },
          { id: "c2", name: "run_cmd", arguments: JSON.stringify({ command: "vitest run test/a.test.ts --maxWorkers=1" }) },
        ] }),
        () => ({ content: "done" }),
      ]),
      tools: [runCmdTool(log)],
      permission: {
        rules: [{ permission: "run_cmd", pattern: "*", action: "allow" }] as PermissionRule[],
        heavyOp: {
          callerIsSubagent: true,
          onHeavyAsk: async (call, match) => {
            asked++;
            const a = await broker.ask({ taskId: "t2", role: "worker", tool: call.name, command: String((JSON.parse(call.arguments) as { command?: string }).command ?? ""), match });
            return a.approved;
          },
        },
      },
    });
    await loop.runTurn("做任务");
    expect(log).toEqual(["grep -rn foo src/", "vitest run test/a.test.ts --maxWorkers=1"]); // 轻命令与豁免命令直通
    expect(gatesOf(journal)).toHaveLength(0);
    expect(asked).toBe(0);
  });
});

describe("父子 ask-answer broker(D3 批准/D5 超时 fail-closed)", () => {
  it("D3:父批准→子代理放行执行;问答事件成对;permission.gate by=heavy-op-approved", async () => {
    const journal = new MemoryJournal();
    const broker = new ParentAskBroker({ journal, sessionId: "parent-s2" });
    broker.onPending = (q) => { setImmediate(() => broker.answer(q.requestId, { approved: true, reason: "任务需要,资源充足" })); };
    const log: string[] = [];
    const loop = childLoopWithBroker(broker, "t3", journal, runCmdTool(log));
    await loop.runTurn("做任务");
    expect(log).toEqual(["pnpm build"]); // 批准后执行
    const g = gatesOf(journal)[0]!.payload as { effect: string; by: string };
    expect(g.effect).toBe("allowed");
    expect(g.by).toBe("heavy-op-approved");
    expect(asksOf(journal)).toHaveLength(1);
    expect(answersOf(journal)).toHaveLength(1);
    const q = asksOf(journal)[0]!.payload as { taskId: string; command: string; match: { category: string } };
    expect(q.taskId).toBe("t3");
    expect(q.command).toBe("pnpm build");
    expect(q.match.category).toBe("build");
  });

  it("D5:无应答到时→超时拒绝(fail-closed)+onSettled 通知;answer 已了结的 id 返回 false", async () => {
    const journal = new MemoryJournal();
    const settled: { approved: boolean; by: string }[] = [];
    const broker = new ParentAskBroker({ journal, sessionId: "parent-s3", onSettled: (a) => { settled.push({ approved: a.approved, by: a.by }); } });
    const askPromise = broker.ask({ taskId: "t4", role: "worker", tool: "run_cmd", command: "pnpm -r build", match: { kind: "cmd.heavy", category: "bulk", pattern: "x", note: "递归" }, timeoutMs: 30 });
    const ans = await askPromise;
    expect(ans.approved).toBe(false);
    expect(ans.by).toBe("timeout");
    expect(ans.reason).toContain("超时");
    expect(settled).toEqual([{ approved: false, by: "timeout" }]);
    expect(broker.pending()).toHaveLength(0);
    expect(broker.answer(ans.requestId, { approved: true })).toBe(false); // 已了结不可再答
    expect(answersOf(journal)[0]!.payload).toMatchObject({ by: "timeout" });
  });

  it("pending 结构化清单+问题块渲染(谁/什么命令/为何类重操作)+answer_subagent 工具", () => {
    const broker = new ParentAskBroker();
    void broker.ask({ taskId: "t5", role: "worker", tool: "run_cmd", command: "pnpm install", match: { kind: "cmd.heavy", category: "install", pattern: "x", note: "安装类:依赖安装" }, timeoutMs: 5_000 });
    const pend = broker.pending();
    expect(pend).toHaveLength(1);
    expect(pend[0]!.command).toBe("pnpm install");
    expect(pend[0]!.match.category).toBe("install");
    const block = renderPendingQuestionsBlock(pend);
    expect(block).toContain("[子代理重操作审批]");
    expect(block).toContain(pend[0]!.requestId);
    expect(block).toContain("pnpm install");
    expect(block).toContain("install");
    // answer_subagent 工具:批准路径
    const tool = buildSubagentAnswerTool(broker);
    expect(ANSWER_SUBAGENT_SPEC.name).toBe("answer_subagent");
    return tool.execute({ requestId: pend[0]!.requestId, approved: true, reason: "ok" }).then((r1) => {
      expect(String(r1)).toContain("已应答");
      expect(broker.pending()).toHaveLength(0);
      // 未知/已答 id
      return tool.execute({ requestId: pend[0]!.requestId, approved: true }).then((r2) => {
        expect(String(r2)).toContain("无此待决请求");
      });
    });
  });
});

describe("driveParentDecision 决策泵(D3/D4 父 LLM 两分支+幻觉重试)", () => {
  function brokerWithOneAsk(journal: MemoryJournal): { broker: ParentAskBroker; askPromise: Promise<{ approved: boolean; reason?: string; by: string }> } {
    const broker = new ParentAskBroker({ journal, sessionId: "p" });
    const askPromise = broker.ask({ taskId: "t6", role: "worker", tool: "run_cmd", command: "tsc -b", match: { kind: "cmd.heavy", category: "build", pattern: "x", note: "构建类" }, timeoutMs: 5_000 });
    return { broker, askPromise };
  }

  it("批准分支:父 LLM 应答 approved=true→子代理侧拿到批准", async () => {
    const journal = new MemoryJournal();
    const { broker, askPromise } = brokerWithOneAsk(journal);
    const llm = scriptedLlm([(messages) => {
      const id = /\[([a-z0-9-]+)\]/.exec(String(messages[1]!.content))![1]!;
      return { content: "", toolCalls: [{ id: "a1", name: "answer_subagent", arguments: JSON.stringify({ requestId: id, approved: true, reason: "必要且资源充足" }) }] };
    }]);
    const r = await driveParentDecision(broker, llm);
    expect(r).toEqual({ asked: 1, answered: 1 });
    const ans = await askPromise;
    expect(ans.approved).toBe(true);
    expect(ans.by).toBe("parent-llm");
    expect(ans.reason).toBe("必要且资源充足");
  });

  it("拒绝分支:父 LLM 应答 approved=false+理由→子代理侧拿到拒绝", async () => {
    const journal = new MemoryJournal();
    const { broker, askPromise } = brokerWithOneAsk(journal);
    const llm = scriptedLlm([(messages) => {
      const id = /\[([a-z0-9-]+)\]/.exec(String(messages[1]!.content))![1]!;
      return { content: "", toolCalls: [{ id: "a1", name: "answer_subagent", arguments: JSON.stringify({ requestId: id, approved: false, reason: "已有构建在跑,稍后再说" }) }] };
    }]);
    await driveParentDecision(broker, llm);
    const ans = await askPromise;
    expect(ans.approved).toBe(false);
    expect(ans.reason).toContain("已有构建在跑");
  });

  it("幻觉兜底:mini-turn 未产工具调用→重试一次;仍不产→answered=0(超时 fail-closed 兜底)", async () => {
    const journal = new MemoryJournal();
    const { broker, askPromise } = brokerWithOneAsk(journal);
    let calls = 0;
    const llm = scriptedLlm([
      () => { calls++; return { content: "我觉得可以" }; }, // 幻觉:无工具调用 => { calls++; return { content: "", toolCalls: [{ id: "a1", name: "answer_subagent", arguments: JSON.stringify({ requestId: broker.pending()[0]?.requestId ?? "gone", approved: true }) }] }; },
    ]);
    const r = await driveParentDecision(broker, llm);
    expect(calls).toBe(2);
    expect(r.answered).toBe(1);
    expect((await askPromise).approved).toBe(true);
  });

  it("无待决问题=零开销直接返回", async () => {
    const broker = new ParentAskBroker();
    const llm = scriptedLlm([() => { throw new Error("不应被调用"); }]);
    await expect(driveParentDecision(broker, llm)).resolves.toEqual({ asked: 0, answered: 0 });
  });
});

describe("端到端(注入式通道):后台子代理申请→父 loop 下一 step 可见→answer_subagent 应答→子代理放行", () => {
  it("父 loop 轮转中经 journal 注入看到结构化问题,LLM 调 answer_subagent,子代理被唤醒执行", async () => {
    const parentJournal = new MemoryJournal();
    const childJournal = new MemoryJournal();
    const broker = new ParentAskBroker({ journal: parentJournal, sessionId: "main-s" });
    // 钉序:申请登记(onPending)前问题块已先落父 journal——父 loop 下一步 derive 必然可见。
    // (生产后台子代理到达时刻本就异步,父 loop 任意后续 step 可见;此处钉序只为断言确定性。)
    let askRegistered!: () => void;
    const askRegisteredP = new Promise<void>((r) => { askRegistered = r; });
    broker.onPending = (q) => {
      parentJournal.append({ kind: "message.user", sessionId: "main-s", payload: { text: renderPendingQuestionsBlock([q]) } });
      askRegistered();
    };
    const childLog: string[] = [];
    const childTool = runCmdTool(childLog);
    // 子代理 loop(闸→broker)
    const childLoop = childLoopWithBroker(broker, "t7", childJournal, childTool);
    let childDoneP: Promise<void> = Promise.resolve();
    // spawn 工具(后台形态:启动子 loop 不等待其完成,返回 agentId;真实 gateway run_in_background 同构)
    const spawnTool: Tool = {
      name: "spawn_subagent", description: "spawn", parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() {
        childDoneP = childLoop.runTurn("帮我构建").then(() => {
          parentJournal.append({ kind: "message.system", sessionId: "main-s", payload: { text: "[子代理完成]" } });
        });
        await askRegisteredP; // 等子代理的重操作申请登记完成(问题块已入父 journal)
        return "spawned:agent_x";
      },
    };
    // 父 loop:step1=spawn;step2=看到注入问题→answer_subagent 批准;step3=收尾
    const seenByLlm: string[] = [];
    const parentLlm = scriptedLlm([
      (messages) => {
        seenByLlm.push(messages.map((m) => m.content).join("|"));
        return { content: "", toolCalls: [{ id: "p1", name: "spawn_subagent", arguments: "{}" }] };
      },
      (messages) => {
        seenByLlm.push(messages.map((m) => m.content).join("|"));
        expect(messages.some((m) => m.content.includes("[子代理重操作审批]"))).toBe(true); // 注入可见
        const id = /\[([a-z0-9-]+)\]/.exec(messages.find((m) => m.content.includes("[子代理重操作审批]"))!.content)![1]!;
        return { content: "", toolCalls: [{ id: "p2", name: "answer_subagent", arguments: JSON.stringify({ requestId: id, approved: true, reason: "任务书明说需要构建" }) }] };
      },
      () => ({ content: "全部完成" }),
    ]);
    const parentLoop = new AgentLoop({
      journal: parentJournal, sessionId: "main-s", system: "main",
      llm: parentLlm,
      tools: [spawnTool, buildSubagentAnswerTool(broker)],
      maxSteps: 6,
    });
    await parentLoop.runTurn("派个子代理构建");
    await childDoneP;
    expect(childLog).toEqual(["pnpm build"]); // 子代理被批准后真实执行
    const ans = answersOf(parentJournal)[0]!.payload as { approved: boolean; by: string; reason?: string };
    expect(ans).toMatchObject({ approved: true, by: "parent-llm", reason: "任务书明说需要构建" });
    expect(seenByLlm[1]).toContain("[子代理重操作审批]"); // 父 LLM 真实收到了结构化问题
  });
});

describe("待决审批 ephemeral 注入(2026-11-03 token 治理):不落 journal、了结即消失", () => {
  it("待决步可见并应答;应答后注入消失;deriveMessages 历史零审批块", async () => {
    const parentJournal = new MemoryJournal();
    const childJournal = new MemoryJournal();
    const broker = new ParentAskBroker({ journal: parentJournal, sessionId: "main-s" });
    // 子代理 loop(闸→broker.ask 阻塞;不立即应答,让待决状态跨父 loop 多个 step)
    const childLog: string[] = [];
    const childLoop = childLoopWithBroker(broker, "t-eph", childJournal, runCmdTool(childLog));
    const childDoneP = childLoop.runTurn("帮我构建");
    // 钉序:等子代理的申请注册进 broker 再启动父 loop(否则父 step2 先跑完,竞态下断言1不稳)。
    for (let i = 0; i < 500 && broker.pending().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(broker.pending().length).toBeGreaterThan(0);
    // 父 loop:pendingQuestions 回调=每步现算 broker.pending()(生产 agent-wiring 同构);
    // step1=占位工具保持轮转(纯文本结束 turn 会让子代理无人应答),step2=看到注入→answer_subagent
    // 批准,step3=确认注入消失后收尾。
    const noopTool: Tool = {
      name: "noop", description: "占位", parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() { return "ok"; },
    };
    const seenByLlm: string[] = [];
    const parentLlm = scriptedLlm([
      (messages) => {
        seenByLlm.push(messages.map((m) => m.content).join("|"));
        return { content: "", toolCalls: [{ id: "p1", name: "noop", arguments: "{}" }] };
      },
      (messages) => {
        seenByLlm.push(messages.map((m) => m.content).join("|"));
        const blk = messages.find((m) => m.content.includes("[子代理重操作审批]"));
        expect(blk).toBeDefined(); // 断言1:待决期间注入可见(ephemeral)
        const id = /\[([a-z0-9-]+)\]/.exec(blk!.content)![1]!;
        return { content: "", toolCalls: [{ id: "p2", name: "answer_subagent", arguments: JSON.stringify({ requestId: id, approved: true, reason: "任务需要" }) }] };
      },
      (messages) => {
        seenByLlm.push(messages.map((m) => m.content).join("|"));
        expect(messages.some((m) => m.content.includes("[子代理重操作审批]"))).toBe(false); // 断言2:应答后注入消失
        return { content: "全部完成" };
      },
    ]);
    const parentLoop = new AgentLoop({
      journal: parentJournal, sessionId: "main-s", system: "main",
      llm: parentLlm,
      tools: [noopTool, buildSubagentAnswerTool(broker)],
      maxSteps: 6,
      pendingQuestions: () => renderPendingQuestionsBlock(broker.pending().slice(0, 8)) || null,
    });
    await parentLoop.runTurn("派个子代理构建");
    await childDoneP;
    expect(childLog).toEqual(["pnpm build"]); // 子代理被批准后真实执行
    // 断言3:审批块从未落 journal——deriveMessages 重建历史零审批块,后续请求不再重放旧块。
    const derived = deriveMessages(parentJournal, "main-s");
    expect(derived.some((m) => m.content.includes("[子代理重操作审批]"))).toBe(false);
  });

  it("回调缺席(undefined)=零注入,行为与旧构造点完全一致", async () => {
    const journal = new MemoryJournal();
    const loop = new AgentLoop({
      journal, sessionId: "s-x", system: "sys",
      llm: scriptedLlm([() => ({ content: "ok" })]),
      tools: [],
    });
    // 缺席回调时无注入可断言——直接断言 runTurn 正常完成且历史无审批块。
    await loop.runTurn("普通任务");
    expect(deriveMessages(journal, "s-x").some((m) => m.content.includes("[子代理重操作审批]"))).toBe(false);
  });
});
