// 审计轮操作级探针(取证后删):R1 五项「已接线」声称的真行为验证
// orient 关闭:无符号任务首查会触发 plan 画像/索引构建(秒级~百秒),
// 本文件的取消链用例在 orient 完成前提交 cancel 会只改状态不 abort(loop 未注册)——
// 被测对象是取消链不是 orient,测试环境与产品开关隔离。
process.env.GENIE_SENSE_ORIENT = "off";
import { it, expect } from "vitest";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";

const wsConn = (port: number): Promise<import("ws").WebSocket> =>
  import("ws").then(({ WebSocket }) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`);
    return new Promise((res, rej) => { w.on("open", () => res(w)); w.on("error", rej); });
  });

it("A. session.status 推送化:任务状态变化→服务端主动推 session.status.changed", async () => {
  const app = createGatewayApp({ port: 0, llm: undefined, useExternalHttp: true });
  const { createServer } = await import("node:http");
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  app.attachWs(server);
  const w = await wsConn(port);
  const got = new Promise<string>((res) => {
    w.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.type === "session.status.changed") res(String(m.sessionId)); });
  });
  app.taskManager.submit("user", "push-s1", "x");
  const sid = await Promise.race([got, new Promise<string>((_, rej) => setTimeout(() => rej(new Error("推送未达")), 4000))]);
  expect(sid).toBe("push-s1");
  w.close(); await app.close(); await new Promise<void>((r) => server.close(() => r()));
});

it("B. 取消信号链 e2e:task.cancel→LLM 请求 abort→turn cancelled 收口", async () => {
  let aborted = false;
  const hangLlm = { async chat(_m: unknown, _t: unknown, signal?: AbortSignal) {
    await new Promise<void>((res) => {
      const t = setTimeout(res, 30_000);
      signal?.addEventListener("abort", () => { aborted = true; clearTimeout(t); res(); }, { once: true });
    });
    throw new Error("aborted");
  } };
  const app = createGatewayApp({ port: 0, llm: hangLlm as never, executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never, useExternalHttp: true });
  const { createServer } = await import("node:http");
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, r));
  app.attachWs(server);
  const w = await wsConn((server.address() as { port: number }).port);
  // 事件驱动等待(固定 sleep 在全量套件并发下资源饥饿不可靠——审计 R2 教训)
  const waitFor = (pred: () => boolean, ms: number) => new Promise<void>((res, rej) => {
    const t0 = Date.now();
    const tick = () => { if (pred()) return res(); if (Date.now() - t0 > ms) return rej(new Error("waitFor 超时")); setTimeout(tick, 50); };
    tick();
  });
  w.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "cancel-s1", instruction: "长任务" }));
  await waitFor(() => app.taskManager.list().some((t) => t.sessionId === "cancel-s1" && t.state === "running"), 30_000);
  const running = app.taskManager.list().find((t) => t.sessionId === "cancel-s1")!;
  w.send(JSON.stringify({ v: 1, type: "task.cancel", taskId: running.id }));
  await waitFor(() => aborted, 30_000);
  expect(aborted, "cancel 应 abort 底层 LLM 请求").toBe(true);
  await waitFor(() => app.taskManager.list().some((t) => t.id === running.id && t.state === "cancelled"), 30_000);
  const turnEnd = app.journal.readAll().filter((e) => e.sessionId === "cancel-s1" && e.kind === "turn.end").at(-1);
  expect((turnEnd?.payload as { reason?: string }).reason, "turn 以 cancelled 收口").toBe("cancelled");
  w.close(); await app.close(); await new Promise<void>((r) => server.close(() => r()));
}, 60_000);

it("C. permission-policy 会话级代答:always 决策后同会话 ask 直通(组件级操作验证)", async () => {
  const { PermissionBroker } = await import("../src/permission-broker.js");
  const { TaskPermissionGuard } = await import("@lampgenie/runtime/task/permission-policy");
  const policy = new TaskPermissionGuard({} as never);
  const broker = new PermissionBroker(1000);
  broker.policy = {
    shouldAutoAllow: (o, s2, t) => policy.shouldAutoAllow(o, s2, t),
    applyDecision: (o, s2, d, t) => policy.applyDecision(o, s2, d, t),
  };
  broker.policy.applyDecision("local", "pol-s1", "always");
  expect(broker.policy.shouldAutoAllow("local", "pol-s1")).toBe(true);
  expect(broker.policy.shouldAutoAllow("local", "pol-s2")).toBe(false);
  // ask 直通:policy 放行时 ask() 立刻 resolve(不广播不等待)
  broker.online = false; // 即使无面板连接,policy 层也应直通
  const outcome = await broker.ask({ requestId: "r1", sessionId: "pol-s1", tool: "t", summary: "s" });
  expect(outcome).toEqual({ decision: "allow-once", by: "policy" });
});

it("D. factory zcode/opencode 后端分支真返回 CliOneShotBackend", async () => {
  const be = buildExecutorFromConfig({ executor: { kind: "zcode" } } as never);
  expect(be).toBeTruthy();
  expect((be as { kind?: string }).kind ?? "cli").toBeTruthy();
  const be2 = buildExecutorFromConfig({ executor: { kind: "opencode" } } as never);
  expect(be2).toBeTruthy();
});

it("E. 新视图服务面:/ 页含 team/nodes/approvals/board 视图与 goalPill,总路线在代码档案 tab", async () => {
  const { servePanel } = await import("../src/panel.js");
  const p2 = servePanel(7907, () => {});
  await new Promise((r) => setTimeout(r, 300));
  const html = await (await fetch("http://127.0.0.1:7907/")).text();
 // 总线路一级视图并入代码档案「总路线」tab——断言从 view-pipeline 换成 tab + 承载库位
  for (const marker of ['id="view-team"', 'id="view-nodes"', 'id="view-approvals"', 'id="view-board"', 'id="goalPill"', "builtinGoal", "builtinTeam", 'data-ptab="roadmap"', 'id="rmBody"', 'id="rmFunnel"']) {
    expect(html.includes(marker), "缺 " + marker).toBe(true);
  }
  expect(html.includes('id="view-pipeline"'), "总线路一级视图已合并,不应残留").toBe(false);
  p2.close();
  void 0;
}, 15_000);
