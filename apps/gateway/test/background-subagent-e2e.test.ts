import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// 审计探针(保留):后台子代理 run_in_background→output.txt→task_output 链操作级验证
import { afterAll, expect, it } from "vitest";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { existsSync, readFileSync, rmSync } from "node:fs";

// env 互斥:threads pool 共享 process.env,动 GENIE_PERMISSION_RULES 等进程级开关的
// 测试文件必须串行,否则并行文件互相拆 env=间歇假红。

it("后台子代理:async_launched→output.txt→注册表 complete", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }, { permission: "task_output", pattern: "*", action: "allow" }]);
  const seen: string[] = [];
  const slowLlm = { async chat(_m: unknown) {
    await new Promise((r) => setTimeout(r, 600));
    return { content: "后台调查报告完成" };
  } };
  // 直接驱动 spawnTool 的后台分支:构造最小 app,取 wireAgentLoop 同款 spawnTool 不可行——
  // 经 runWithAgent 真链太重;改为验证 agent-wiring 导出的后台注册表桥+手动驱动后端结果写入。
  // 更直接:走 app 的任务链,任务书让模型调 spawn_subagent(run_in_background)
  const app = createGatewayApp({    port: 0,
    llm: { async chat() {
      // 只派一次后台,下一步直接给最终报告(探针用;真实循环模型不受此限)
      if (seen.length === 0) {
        seen.push("spawn");
        return { content: '', toolCalls: [{ id: "b1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "调查一下", agentType: "explore", run_in_background: true }) }] };
      }
      seen.push("final");
      return { content: "主 agent 收到 async_launched,转述给用户" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  app.taskManager.submit("user", "bg-s1", "后台查一下");
  // 等主任务终态(轮询,事件驱动在 onChange 已有)
  for (let i = 0; i < 100; i++) {
    const t = app.taskManager.list().find((x) => x.sessionId === "bg-s1");
    if (t && (t.state === "done" || t.state === "failed")) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 1200)); // 等后台子代理写 output.txt
  await new Promise((r) => setTimeout(r, 800)); // 等后台子代理写 output.txt
  const reg = (globalThis as { __bgAgents?: Map<string, { outputFile: string; status: string }> }).__bgAgents!;
  expect(reg.size, "后台注册表应有条目").toBeGreaterThan(0);
  expect(seen.some((x) => x === "spawn"), "主 agent 应派发过一次后台").toBe(true);
  const entry = [...reg.values()][0]!;
  expect(existsSync(entry.outputFile), "output.txt 应存在").toBe(true);
  const content = readFileSync(entry.outputFile, "utf-8");
  expect(content).toContain("[started]");
  expect(content).toContain("[result ok=true]");
  expect(content).toContain("主 agent 收到");
  void seen;
  await app.close();
  delete process.env.GENIE_PERMISSION_RULES;
}, 30_000);

it("task_output waitSec:阻塞等待后台子代理终态(2026-10-14 等待语义)", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }, { permission: "task_output", pattern: "*", action: "allow" }]);
  const seen: string[] = [];
  const t0 = Date.now();
  let waitedMs = 0;
  const app = createGatewayApp({    port: 0,
    llm: { async chat(_m: unknown) {
      const sys = JSON.stringify(_m);
      if (sys.includes("独立上下文")) {
        // 子 agent:慢 2s 才出报告——task_output 的等待必须真实阻塞
        await new Promise((r) => setTimeout(r, 2000));
        return { content: "后台调查报告完成" };
      }
      if (seen.length === 0) { seen.push("spawn"); return { content: "", toolCalls: [{ id: "b1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "慢慢调查", agentType: "explore", run_in_background: true }) }] }; }
      if (seen.length === 1) {
        seen.push("wait");
        const reg = (globalThis as { __bgAgents?: Map<string, { outputFile: string; status: string }> }).__bgAgents!;
        const aid = [...reg.entries()].filter(([, v]) => v.outputFile.includes("bg-wait")).at(-1)?.[0] ?? "";
        const waitStart = Date.now();
        const r = { content: "", toolCalls: [{ id: "b2", name: "task_output", arguments: JSON.stringify({ agentId: aid, waitSec: 15 }) }] };
        void waitStart;
        return r as never;
      }
      seen.push("final");
      waitedMs = Date.now() - t0;
      return { content: "等待结束,汇总:" + String((_m as { messages?: { content?: string }[] })?.messages?.slice(-1)[0]?.content ?? "").slice(0, 200) };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  app.taskManager.submit("user", "bg-wait", "等子代理完成");
  for (let i = 0; i < 150; i++) {
    const t = app.taskManager.list().find((x) => x.sessionId === "bg-wait");
    if (t && (t.state === "done" || t.state === "failed")) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const reg = (globalThis as { __bgAgents?: Map<string, { outputFile: string; status: string }> }).__bgAgents!;
  const entry = [...reg.values()].find((e) => e.outputFile.includes("bg-wait")) ?? [...reg.values()][0]!;
  expect(entry.status, "子代理应已完成").toBe("completed");
  // task_output 阻塞等待过子代理(慢 2s)——主任务总时长应 > 2s
  expect(waitedMs, "主任务应真实等待过子代理(>1.8s)").toBeGreaterThan(1800);
  await app.close();
  delete process.env.GENIE_PERMISSION_RULES;
}, 40_000);
// afterEach 清理由各用例尾部完成(进程级 env,同文件顺序执行)

it("后台回执把「等还是继续」的决策权交给主 agent(2026-10-20 )", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
  const seen: string[] = [];
  let spawnReceipt = "";
  const app = createGatewayApp({    port: 0,
    llm: { async chat(_m: unknown) {
      if (JSON.stringify(_m).includes("独立上下文")) return { content: "子代理速答" }; // 子 agent 秒回
      if (seen.length === 0) {
        seen.push("spawn");
        return { content: "", toolCalls: [{ id: "d1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "快速调查", agentType: "explore", run_in_background: true }) }] };
      }
      seen.push("capture");
      // 第二步:从上下文里截获第一步 spawn 的工具回执(async_launched JSON)
      const m = JSON.stringify(_m);
 // 锚用 note 独有串(「已后台启动(异步)」): 起历史任务档案块会被注入上下文,
 // 旧锚「async_launched」可能先命中历史块里的结果文本(经验证污染)。
      const i = m.indexOf("已后台启动(异步)");
      if (i >= 0) spawnReceipt = m.slice(Math.max(0, i - 80), i + 760);
      return { content: "收执" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  app.taskManager.submit("user", "bg-note", "查一下");
  for (let i = 0; i < 100; i++) {
    const t = app.taskManager.list().find((x) => x.sessionId === "bg-note");
    if (t && (t.state === "done" || t.state === "failed")) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 600));
  expect(spawnReceipt, "应截获 async_launched 回执").toContain("async_launched");
  expect(spawnReceipt).toContain("由你判断");
  expect(spawnReceipt).toContain("不重叠"); // 明确「不要重复子代理任务书内容」的约束在场
  expect(spawnReceipt).not.toContain("继续做其它工作;"); // 旧指令式文案必须退场(机制不再替主 agent 指定做什么)
  await app.close();
  delete process.env.GENIE_PERMISSION_RULES;
}, 30_000);

it("wait:true=选择等待:单次工具调用挂起到终态,结果直接返回(等待期零 LLM 轮次)", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
  const seen: string[] = [];
  const t0 = Date.now();
  let waitedMs = 0;
  let spawnResult = "";
  const app = createGatewayApp({    port: 0,
    llm: { async chat(_m: unknown) {
      if (JSON.stringify(_m).includes("独立上下文")) {
        await new Promise((r) => setTimeout(r, 2000)); // 子代理慢 2s
        return { content: "勘察报告:结论 A" };
      }
      if (seen.length === 0) {
        seen.push("spawn");
        return { content: "", toolCalls: [{ id: "w1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "慢速勘察", agentType: "explore", wait: true }) }] };
      }
      seen.push("final");
      waitedMs = Date.now() - t0;
      // 截获第一步 spawn 的工具回执
      const m = JSON.stringify(_m);
      const i = m.indexOf("勘察报告");
      if (i >= 0) spawnResult = m.slice(Math.max(0, i - 60), i + 80);
      return { content: "汇总" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  app.taskManager.submit("user", "bg-wait-flag", "等它");
  for (let i = 0; i < 100; i++) {
    const t = app.taskManager.list().find((x) => x.sessionId === "bg-wait-flag");
    if (t && (t.state === "done" || t.state === "failed")) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(seen).toEqual(["spawn", "final"]); // 主 llm 只有 2 轮:派发+汇总——等待期零 LLM 轮次
  expect(waitedMs, "主循环真实挂起过子代理 2s").toBeGreaterThan(1800);
  expect(spawnResult, "spawn 回执=最终文本(非 backgrounded JSON)").toContain("勘察报告:结论 A");
  expect(spawnResult).not.toContain("backgrounded");
  await app.close();
  delete process.env.GENIE_PERMISSION_RULES;
}, 30_000);

it("task_output waitFor:result=挂起到终态(零 LLM 轮次),不靠模型给秒数", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }, { permission: "task_output", pattern: "*", action: "allow" }]);
  const seen: string[] = [];
  let waitReturn = "";
  const app = createGatewayApp({    port: 0,
    llm: { async chat(_m: unknown) {
      if (JSON.stringify(_m).includes("独立上下文")) {
        await new Promise((r) => setTimeout(r, 2000)); // 子代理慢 2s
        return { content: "后台结论 B" };
      }
      if (seen.length === 0) {
        seen.push("spawn");
        return { content: "", toolCalls: [{ id: "f1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "后台慢查", agentType: "explore", run_in_background: true }) }] };
      }
      if (seen.length === 1) {
        seen.push("wait");
        const reg = (globalThis as { __bgAgents?: Map<string, { outputFile: string }> }).__bgAgents!;
        const aid = [...reg.entries()].filter(([, v]) => v.outputFile.includes("bg-waitfor")).at(-1)?.[0] ?? [...reg.keys()].at(-1) ?? "";
        return { content: "", toolCalls: [{ id: "f2", name: "task_output", arguments: JSON.stringify({ agentId: aid, waitFor: "result" }) }] };
      }
      seen.push("final");
      const m = JSON.stringify(_m);
      waitReturn = m; // 整串断言:工具结果嵌在 messages 里带多层转义,截取窗口会跨到系统提示其它段
      return { content: "汇总" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  app.taskManager.submit("user", "bg-waitfor", "后台查+等到底");
  for (let i = 0; i < 100; i++) {
    const t = app.taskManager.list().find((x) => x.sessionId === "bg-waitfor");
    if (t && (t.state === "done" || t.state === "failed")) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(seen).toEqual(["spawn", "wait", "final"]); // 3 轮:派发、挂起等待、汇总——等待在工具内,零 LLM
  expect(waitReturn, "waitFor 挂起后应拿到完整输出").toContain("后台结论 B");
  expect(waitReturn, "task_output 返回应为终态 completed(挂起等到结果而非超时快照)").toMatch(/status[^]{0,30}completed/);
  await app.close();
  delete process.env.GENIE_PERMISSION_RULES;
}, 30_000);

it("前台 spawn(非 wait)180s 自动转后台——轮询判定通道(2026-10-20 生产实挂修复的回归锚)", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
  const seen: number[] = [];
  const t0 = Date.now();
  const app = createGatewayApp({
    port: 0,
    llm: { async chat(_m: unknown) {
      const s = JSON.stringify(_m);
      if (s.includes("独立上下文")) { await new Promise((r) => setTimeout(r, 400_000)); return { content: "慢报告" }; }
      seen.push(Date.now() - t0);
      if (seen.length === 1) return { content: "", toolCalls: [{ id: "ab1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "慢查", agentType: "explore", deadlineMin: 25 }) }] };
      return { content: "拿到回执:" + (s.includes("backgrounded") ? "已转后台" : "其它") };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  app.taskManager.submit("user", "bg-autobg", "前台慢查");
  for (let i = 0; i < 1200; i++) {
    const t = app.taskManager.list().find((x) => x.sessionId === "bg-autobg");
    if (t && (t.state === "done" || t.state === "failed")) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 300));
  expect(seen.length, "主轨应两步:派发+拿转后台回执后收尾").toBeGreaterThanOrEqual(2);
  expect(seen[1]!, "转后台应在 ~180s(轮询 200ms 节律;并行负载下放宽到 +50s 容差)").toBeGreaterThan(160_000);
  expect(seen[1]!).toBeLessThan(235_000);
  await app.close();
  delete process.env.GENIE_PERMISSION_RULES;
}, 300_000);


// e2e 任务会往共享 .genie 写终态档案(与生产同根)——收尾清理,防测试任务进生产历史注入流。
afterAll(() => {
  try { rmSync(join(process.cwd(), "..", "..", ".genie", "task-archive.jsonl"), { force: true }); } catch { /* 清理失败无害 */ }
  try { rmSync(join(process.cwd(), ".genie", "task-archive.jsonl"), { force: true }); } catch { /* 清理失败无害 */ }
});
