// step-056 会话纪律(用户口径「session 没有权创建新 session,只能 super agent 创建 session;
// session 只能创建子进程 agent 并自己管理」+ ZCode Agent 机制):
// 1) run_parallel(经 tm.submit 造新会话)已删除——agent 调它必须吃「未知工具」,且全程零新任务;
// 2) 并行=同一条消息里多个 spawn_subagent 同批并发(loop Promise.all),子代理全在本会话内。
import { it, expect } from "vitest";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";

// plan-gate 豁免(2026-10-21):本文件测 reaper/worktree/会话纪律基础设施,不涉及规划流程
process.env.GENIE_PLAN_GATE = "off";


// 本测试验证并行机制与会话纪律,不验证权限闸:.genie/permissions.json(并发线在途)给 subagent 默认 ask,
// 测试进程无面板应答=自动拒绝——这里显式放行(GENIE_PERM_ASK_MODE 在 wire 时读取)。
process.env.GENIE_PERM_ASK_MODE = "allow";

it("run_parallel 已删除:调用=未知工具,全程零新任务/新会话", async () => {
  let phase = 0;
  const app = createGatewayApp({
    port: 0,
    llm: { async chat() {
      phase++;
      if (phase === 1) return { content: "", toolCalls: [{ id: "p1", name: "run_parallel", arguments: JSON.stringify({ instructions: ["静态排查 A", "静态排查 B"] }) }] };
      return { content: "收到,并行通道已下线,改用子代理。" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  app.taskManager.submit("user", "disc-s1", "并行排查一下");
  for (let i = 0; i < 100; i++) {
    const t = app.taskManager.list().find((x) => x.sessionId === "disc-s1");
    if (t && (t.state === "done" || t.state === "failed")) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const tasks = app.taskManager.list();
  expect(tasks.filter((t) => t.sessionId.includes("-par-")), "不得出现 -par- 新会话").toEqual([]);
  expect(tasks.length, "全程只有用户提交的那一个任务").toBe(1);
  const events = app.journal.readAll();
  const pr = events.find((e) => e.kind === "tool.result" && (e.payload as { name?: string })?.name === "run_parallel");
  expect(pr, "run_parallel 的 tool.result 应在案").toBeTruthy();
  expect(String((pr?.payload as { content?: string })?.content)).toContain("未知工具");
  await app.close();
}, 30_000);

it("并行=同批多个 spawn_subagent 并发跑:同会话、零新任务、maxInFlight≥2", async () => {
  let inflight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const spawn = (id: string, instr: string) => ({ id, name: "spawn_subagent", arguments: JSON.stringify({ instructions: instr }) });
  const slowLlm = { async chat() {
    calls++;
    inflight++;
    maxInFlight = Math.max(maxInFlight, inflight);
    await new Promise((r) => setTimeout(r, 250));
    inflight--;
    // 调用序列:1=主循环第1步(同批派两个子代理) → 2,3=两个子代理(并发,250ms 重叠) → 4=主循环第2步收尾
    if (calls === 1) {
      return { content: "", toolCalls: [spawn("s1", "静态排查 agent loop"), spawn("s2", "静态排查工具面")] };
    }
    return { content: "调查完成" };
  } };
  const app = createGatewayApp({
    port: 0,
    llm: slowLlm as never,
    // factory "echo"→EchoChildBackend(.kind="echo-child")→spawnTool 换装 LlmLoopBackend=生产同款进程内子代理
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  const before = app.taskManager.list().length;
  app.taskManager.submit("user", "disc-s2", "两路并行静态排查");
  for (let i = 0; i < 150; i++) {
    const t = app.taskManager.list().find((x) => x.sessionId === "disc-s2");
    if (t && (t.state === "done" || t.state === "failed")) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const t = app.taskManager.list().find((x) => x.sessionId === "disc-s2");
  expect(t?.state, "主任务应终态").toBe("done");
  // 会话纪律:任务表只多出用户提交的一个(子代理不是任务/会话)
  expect(app.taskManager.list().length - before, "子代理不得登记为任务").toBe(1);
  // 并发实证:两个子代理的 LLM 调用时间重叠
  expect(maxInFlight, "spawn 同批应并行(两个子代理 LLM 调用重叠)").toBeGreaterThanOrEqual(2);
  await app.close();
}, 60_000);
