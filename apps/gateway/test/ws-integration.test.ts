import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import { ExperienceStore } from "@lampgenie/experience";
import type { ProjectRegistry } from "../src/projects.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app: GatewayApp | null = null;
let extraSrv: { close: () => void } | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  extraSrv?.close();
  extraSrv = null;
});

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    // 立即挂收集器:hello 等早到消息可能先于 nextMessage 的监听注册。
    const inbox: Record<string, unknown>[] = [];
    (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox = inbox;
    ws.on("message", (raw: Buffer) => inbox.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  const inbox = (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox;
  // 先查缓冲(早到的),再等新消息。
  const hit = inbox.findIndex((m) => m.type === type);
  if (hit >= 0) return Promise.resolve(inbox.splice(hit, 1)[0]!);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), 3000);
    const poll = setInterval(() => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(inbox.splice(i, 1)[0]!);
      }
    }, 20);
  });
}

describe("gateway WS 集成", () => {
  it("连接即收 hello(服务端主动发),提交任务后可回放 session.history", async () => {
    app = createGatewayApp({ port: 7799 });
    const ws = await connect(7799);

    const hello = await nextMessage(ws, "hello");
    expect(hello.tasks).toEqual([]);

    ws.send(JSON.stringify({
      v: 1,
      type: "task.submit", sessionId: "s1", instruction: "demo task", idempotencyKey: "k-demo",
    }));
    const submitted = await nextMessage(ws, "task.submitted");
    const task = submitted.task as { id: string; state: string };
    expect(task.state).toBe("running"); // 快照一致性(P1 修复)在协议面同样成立

    ws.send(JSON.stringify({ v: 1, type: "session.history", sessionId: "s1" }));
    const hist = await nextMessage(ws, "session.history.result");
    const events = hist.events as { kind: string }[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.kind.startsWith("task."))).toBe(true);

    ws.close();
  });

  it("node.register 实装(step-011):注册成功回执", async () => {
    app = createGatewayApp({ port: 7798 });
    const ws = await connect(7798);
    await nextMessage(ws, "hello");
    ws.send(JSON.stringify({ v: 1, type: "node.register", nodeId: "n1", capabilities: ["build"], reachability: ["lan"] }));
    const ack = await nextMessage(ws, "node.registered");
    expect(ack.nodeId).toBe("n1");
    ws.close();
  });

  it("幂等:同 idempotencyKey 断线重发不产生第二个任务", async () => {
    app = createGatewayApp({ port: 7797 });
    const ws = await connect(7797);
    await nextMessage(ws, "hello");
    for (let i = 0; i < 3; i++) {
      ws.send(JSON.stringify({
        v: 1, type: "task.submit", sessionId: "s1", instruction: "x", idempotencyKey: "k-idem",
      }));
    }
    ws.send(JSON.stringify({ v: 1, type: "task.list" }));
    const list = await nextMessage(ws, "task.list");
    expect((list.tasks as unknown[]).length).toBe(1);
    ws.close();
  });

  it("非法消息:error.message 带字段改名(P3 指路)", async () => {
    app = createGatewayApp({ port: 7786 });
    const ws = await connect(7786);
    await nextMessage(ws, "hello");
    // 缺 sessionId(必填)的 task.submit → 旧文案「信封 v:1 必填/未知类型/字段缺失」无从定位。
    ws.send(JSON.stringify({ v: 1, type: "task.submit", instruction: "x" }));
    const err = await nextMessage(ws, "error");
    expect(err.code).toBe("invalid-message");
    const message = String(err.message);
    expect(message).toContain("task.submit");
    expect(message).toContain("sessionId");
    ws.close();
  });

  it("非 JSON 消息:error.message 报解析异常(不再冒泡成进程崩溃)", async () => {
    app = createGatewayApp({ port: 7785 });
    const ws = await connect(7785);
    await nextMessage(ws, "hello");
    ws.send("not json");
    const err = await nextMessage(ws, "error");
    expect(err.code).toBe("invalid-message");
    expect(String(err.message)).toContain("消息解析异常");
    // 连接仍活:后续合法消息照常处理。
    ws.send(JSON.stringify({ v: 1, type: "sys.meta" }));
    const meta = await nextMessage(ws, "sys.meta.result");
    expect(meta.meta).toBeTruthy();
    ws.close();
  });

  it("sys.meta/exp.list/exp.view 面板消息(侧栏数据源)", async () => {
    app = createGatewayApp({ port: 7794 });
    const ws = await connect(7794);
    await nextMessage(ws, "hello");

    ws.send(JSON.stringify({ v: 1, type: "sys.meta" }));
    const meta = await nextMessage(ws, "sys.meta.result");
    expect(meta.meta).toBeTruthy();

    ws.send(JSON.stringify({ v: 1, type: "exp.list" }));
    const exp = await nextMessage(ws, "exp.list.result");
    expect(Array.isArray(exp.items)).toBe(true);

    ws.send(JSON.stringify({ v: 1, type: "exp.view", category: "coding", name: "nonexistent" }));
    const view = await nextMessage(ws, "exp.view.result");
    expect(view.body).toBeNull();
    ws.close();
  });

  it("exp.remove:删除后 list 不含该条;不存在 ok:false;未装配报 not-implemented", async () => {
    // 注入临时 store:删除是破坏性操作,绝不打真实 .genie/experiences
    const tmp = mkdtempSync(join(tmpdir(), "gh-ws-exp-"));
    const st = new ExperienceStore(tmp);
    await st.write({ category: "coding", name: "del-me", description: "待删条目", created_by: "agent" }, "正文");
    const srv = startGatewayServer({
      port: 7795,
      taskManager: new TaskSupervisor(),
      journal: new MemoryJournal(),
      projects: { activeId: () => "p1", resolveWorkdir: () => "/tmp", list: () => [] } as unknown as ProjectRegistry,
      experience: {
        index: () => st.index(),
        view: (c: string, n: string) => st.view(c, n),
        disabled: () => st.disabledEntries(),
        remove: (c: string, n: string) => st.remove(c, n),
      },
    });
    extraSrv = srv;
    const ws = new WebSocket("ws://127.0.0.1:7795");
    const inbox: Record<string, unknown>[] = [];
    ws.on("message", (r) => inbox.push(JSON.parse(r.toString())));
    await new Promise((r) => ws.on("open", r));
    const ask = (body: object, want: string) => {
      inbox.length = 0;
      ws.send(JSON.stringify({ v: 1, ...body }));
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(want + " 超时")), 5000);
        const p = setInterval(() => {
          const m = inbox.find((x) => x.type === want);
          if (m) { clearTimeout(t); clearInterval(p); resolve(m); }
        }, 20);
      });
    };
    // 删除存在条目 → ok:true + list 不再含
    const r1 = await ask({ type: "exp.remove", category: "coding", name: "del-me" }, "exp.remove.result");
    expect(r1.ok).toBe(true);
    const list = await ask({ type: "exp.list" }, "exp.list.result");
    expect((list.items as { name: string }[]).some((x) => x.name === "del-me")).toBe(false);
    // 再删不存在 → ok:false
    const r2 = await ask({ type: "exp.remove", category: "coding", name: "del-me" }, "exp.remove.result");
    expect(r2.ok).toBe(false);
    // ledger 记 delete(审计)
    expect(st.ledger().some((e) => e.action === "delete")).toBe(true);
    ws.close();
    srv.close();
    rmSync(tmp, { recursive: true, force: true });

    // 未装配(createGatewayApp 但强制无 experience?不行——createGatewayApp 恒装配真库;
    // 未装配路径用 startGatewayServer 缺省 opts 走 not-implemented)
    const srv2 = startGatewayServer({ port: 7796, taskManager: new TaskSupervisor(), journal: new MemoryJournal(), projects: { activeId: () => "p1", resolveWorkdir: () => "/tmp", list: () => [] } as unknown as ProjectRegistry });
    const ws2 = new WebSocket("ws://127.0.0.1:7796");
    const inbox2: Record<string, unknown>[] = [];
    ws2.on("message", (r) => inbox2.push(JSON.parse(r.toString())));
    await new Promise((r) => ws2.on("open", r));
    ws2.send(JSON.stringify({ v: 1, type: "exp.remove", category: "coding", name: "x" }));
    const err = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("error 超时")), 5000);
      const p = setInterval(() => {
        const m = inbox2.find((x) => x.type === "error");
        if (m) { clearTimeout(t); clearInterval(p); resolve(m); }
      }, 20);
    });
    expect(err.code).toBe("not-implemented");
    ws2.close();
    srv2.close();
  });

  it("cfg 通道:未装配报 not-implemented;装配后 get/set 闭环且热项直传 provider", async () => {
    // 未装配(缺省 createGatewayApp):cfg.get → error not-implemented
    app = createGatewayApp({ port: 7793 });
    const ws0 = await connect(7793);
    await nextMessage(ws0, "hello");
    ws0.send(JSON.stringify({ v: 1, type: "cfg.get" }));
    const err = await nextMessage(ws0, "error");
    expect(err.code).toBe("not-implemented");
    ws0.close();
    await app.close();

    // 装配:fake provider 收 update、onConfigSet 返回热/冷分界
    const updates: Record<string, unknown>[] = [];
    const fakeLlm = {
      update: (p: Record<string, unknown>) => updates.push(p),
      chat: async () => ({ content: "", toolCalls: undefined }),
    };
    const calls: Record<string, unknown>[] = [];
    app = createGatewayApp({
      port: 7792,
      llm: fakeLlm as unknown as import("@lampgenie/runtime/agent/loop").LlmProvider,
      config: { coding: { llm: { model: "m1" } } },
      configSources: { "coding.llm.model": "project" },
      configProjectPath: "/tmp/x/genie.config.json",
      onConfigSet: (patch) => {
        calls.push(patch);
        return { applied: ["coding.llm.model"], needsRestart: [] };
      },
    });
    const ws = await connect(7792);
    await nextMessage(ws, "hello");
    ws.send(JSON.stringify({ v: 1, type: "cfg.get" }));
    const got = await nextMessage(ws, "cfg.get.result");
    expect(got.config).toEqual({ coding: { llm: { model: "m1" } } });
    expect(got.sources["coding.llm.model"]).toBe("project");
    expect(got.projectPath).toBe("/tmp/x/genie.config.json");
    ws.send(JSON.stringify({ v: 1, type: "cfg.set", patch: { coding: { llm: { model: "m2" } } } }));
    const set = await nextMessage(ws, "cfg.set.result");
    expect(set.applied).toEqual(["coding.llm.model"]);
    expect(updates).toEqual([{ model: "m2" }]); // 热项真到 provider
    expect(calls).toEqual([{ coding: { llm: { model: "m2" } } }]);
    ws.close();
  });

  it("models.list:未装配 models-not-implemented;装配后返回 id 列表", async () => {
    app = createGatewayApp({ port: 7791 });
    const ws0 = await connect(7791);
    await nextMessage(ws0, "hello");
    ws0.send(JSON.stringify({ v: 1, type: "models.list" }));
    const err = await nextMessage(ws0, "error");
    // step-101:错误码域化(models- 前缀)——panel /models/ 内联分支才能接住,状态行不滞留「拉取中…」
    expect(err.code).toBe("models-not-implemented");
    ws0.close();
    await app.close();

    app = createGatewayApp({ port: 7790, listModels: async () => ["a-model", "b-model"] });
    const ws = await connect(7790);
    await nextMessage(ws, "hello");
    ws.send(JSON.stringify({ v: 1, type: "models.list" }));
    const r = await nextMessage(ws, "models.list.result");
    expect(r.ids).toEqual(["a-model", "b-model"]);
    ws.close();
  });

  it("cfg.set 工具提供商:web.search.* 属热键,不得被谎报「重启生效」(2026-10-28 修复)", async () => {
    app = createGatewayApp({
      port: 7787,
      config: { web: { search: {} } },
      // 服务端(applyConfigPatch + HOT_CONFIG_PATHS)已把 web.search.* 判为热应用
      onConfigSet: () => ({ applied: ["web.search.disabled", "quota.weeklyTokens"], needsRestart: [] }),
    });
    const ws = await connect(7787);
    await nextMessage(ws, "hello");
    ws.send(JSON.stringify({ v: 1, type: "cfg.set", patch: { web: { search: { disabled: true } } } }));
    const r = await nextMessage(ws, "cfg.set.result");
    // 旧实现把「非模型轨的 applied」全挪进 needsRestart → 面板显示「已写入·重启生效」且 applied 为空
    expect(r.applied).toEqual(expect.arrayContaining(["web.search.disabled"]));
    expect(r.needsRestart).toEqual([]);
    ws.close();
  });

  it("cfg.set 角色模型:provider 缺位时热项诚实降级 needsRestart", async () => {
    const updates: Record<string, unknown>[] = [];
    const fakeLlm = {
      update: (p: Record<string, unknown>) => updates.push(p),
      chat: async () => ({ content: "", toolCalls: undefined }),
    };
    app = createGatewayApp({
      port: 7789,
      llm: fakeLlm as unknown as import("@lampgenie/runtime/agent/loop").LlmProvider,
      config: { coding: { llm: { model: "m1" } } },
      onConfigSet: () => ({ applied: ["coding.llm.model", "coding.models.compact.model"], needsRestart: [] }),
      // models.compact provider 未装配 → models.compact.model 应降级
    });
    const ws = await connect(7789);
    await nextMessage(ws, "hello");
    ws.send(JSON.stringify({ v: 1, type: "cfg.set", patch: { coding: { llm: { model: "m2" }, models: { compact: { model: "c1" } } } } }));
    const r = await nextMessage(ws, "cfg.set.result");
    expect(r.applied).toEqual(["coding.llm.model"]);                 // 只有主模型真热
    expect(r.needsRestart).toEqual(["coding.models.compact.model"]); // 压缩模型诚实降级
    expect(updates).toEqual([{ model: "m2" }]);
    ws.close();
  });

  it("cfg.set 子代理模型:provider 已装配时热分发 update(step-112)", async () => {
    const updates: Record<string, unknown>[] = [];
    const fakeLlm = {
      update: () => {},
      chat: async () => ({ content: "", toolCalls: undefined }),
    };
    const fakeSub = {
      update: (p: Record<string, unknown>) => updates.push(p),
      chat: async () => ({ content: "", toolCalls: undefined }),
    };
    app = createGatewayApp({
      port: 7788,
      llm: fakeLlm as unknown as import("@lampgenie/runtime/agent/loop").LlmProvider,
      models: { subagent: fakeSub as unknown as import("@lampgenie/runtime/agent/loop").LlmProvider & { update: (p: Record<string, unknown>) => void } },
      config: { coding: { llm: { model: "m1" }, models: { subagent: { model: "s1" } } } },
      onConfigSet: () => ({ applied: ["coding.models.subagent.model"], needsRestart: [] }),
    });
    const ws = await connect(7788);
    await nextMessage(ws, "hello");
    ws.send(JSON.stringify({ v: 1, type: "cfg.set", patch: { coding: { models: { subagent: { model: "s2" } } } } }));
    const r = await nextMessage(ws, "cfg.set.result");
    expect(r.applied).toEqual(["coding.models.subagent.model"]);
    expect(r.needsRestart).toEqual([]);
    expect(updates).toEqual([{ model: "s2" }]);
    ws.close();
  });

  it("cfg.set 角色模型换 Provider:路由冷项不把模型热切到旧端点(step-112)", async () => {
    const updates: Record<string, unknown>[] = [];
    const fakeLlm = { update: () => {}, chat: async () => ({ content: "", toolCalls: undefined }) };
    const fakeCompact = { update: (p: Record<string, unknown>) => updates.push(p), chat: async () => ({ content: "", toolCalls: undefined }) };
    app = createGatewayApp({
      port: 7787,
      llm: fakeLlm as unknown as import("@lampgenie/runtime/agent/loop").LlmProvider,
      models: { compact: fakeCompact as unknown as import("@lampgenie/runtime/agent/loop").LlmProvider & { update: (p: Record<string, unknown>) => void } },
      config: { coding: { llm: { model: "m1" }, models: { compact: { model: "c1" } } } },
      onConfigSet: () => ({
        applied: ["coding.models.compact.model"],
        needsRestart: ["coding.models.compact.providerId", "coding.models.compact.baseUrl"],
      }),
    });
    const ws = await connect(7787);
    await nextMessage(ws, "hello");
    ws.send(JSON.stringify({ v: 1, type: "cfg.set", patch: { coding: { models: { compact: { model: "c2", providerId: "p2", baseUrl: "http://p2" } } } } }));
    const r = await nextMessage(ws, "cfg.set.result");
    expect(r.applied).toEqual([]); // 路由冷项在场:模型也不热切
    expect(r.needsRestart).toEqual([
      "coding.models.compact.providerId",
      "coding.models.compact.baseUrl",
      "coding.models.compact.model",
    ]);
    expect(updates).toEqual([]);
    ws.close();
  });
});

describe("step-046 WS 面:diffstat/统计", () => {
  it("task.diffstat:checkpoint 事件携带 sha → 返回真实 numstat;无快照 → 空", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "zws-diff-"));
    const g = (a: string) => execSync("git " + a, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString();
    g("init -q"); g('config user.email t@t'); g('config user.name t');
    writeFileSync(join(dir, "a.txt"), "1" + "\n");
    g("add -A"); g("commit -qm base");
    writeFileSync(join(dir, "a.txt"), "1" + "\n2" + "\n");
    const sha = g("stash create").trim();

    app = createGatewayApp({ port: 7798 });
    // @ts-expect-error 观察面暴露 journal(app.journal)
    const journal = (app as unknown as { journal: import("@lampgenie/core").Journal }).journal;
    writeFileSync(join(dir, "a.txt"), "1" + "\n2" + "\n3" + "\n");
    journal.append({ kind: "checkpoint.create", sessionId: "s1", payload: { taskId: "t-diff", sha, root: dir } });
    journal.append({ kind: "checkpoint.create", sessionId: "s1", payload: { taskId: "t-nosnap", sha: null, root: dir } });

    const ws = await connect(7798);
    await nextMessage(ws, "hello");
    ws.send(JSON.stringify({ v: 1, type: "task.diffstat", taskId: "t-diff" }));
    const m = await nextMessage(ws, "task.diffstat.result");
    expect(m.taskId).toBe("t-diff");
    expect(m.sha).toBe(sha);
    expect(m.total).toEqual({ files: 1, add: 1, del: 0 });

    ws.send(JSON.stringify({ v: 1, type: "task.diffstat", taskId: "t-nosnap" }));
    const m2 = await nextMessage(ws, "task.diffstat.result");
    expect(m2.sha).toBeNull();
    expect(m2.total).toEqual({ files: 0, add: 0, del: 0 });
    ws.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stats.summary:journal 归约结果回包(形状+值)", async () => {
    app = createGatewayApp({ port: 7797 });
    // @ts-expect-error 观察面暴露 journal
    const journal = (app as unknown as { journal: import("@lampgenie/core").Journal }).journal;
    journal.append({ kind: "turn.start", sessionId: "s1", payload: { turn: 1 } });
    journal.append({ kind: "message.agent", sessionId: "s1", payload: { text: "hi", usage: { inputTokens: 10, outputTokens: 5 } } });
    const ws = await connect(7797);
    await nextMessage(ws, "hello");
    ws.send(JSON.stringify({ v: 1, type: "stats.summary" }));
    const m = await nextMessage(ws, "stats.summary.result");
    const s = m.summary as Record<string, unknown>;
    const tt = s.totals as Record<string, number>;
    expect(tt.turns).toBe(1);
    expect(tt.llmCalls).toBe(1);
    expect((tt.tokens as Record<string, number>).total).toBe(15);
    expect(Array.isArray(s.perDay) && (s.perDay as unknown[]).length === 30).toBe(true);
    expect(Array.isArray(s.heatmap) && (s.heatmap as unknown[]).length === 7).toBe(true);
    ws.close();
  });
});

/**
 * 2026-10-22「主动 /compact 感觉没运行」服务端两因(板节点 n3/n4):
 * ③手动压缩恒走主轨 llm(与自动路径 agent-wiring.ts:2174 不同源);
 * ④轮次守卫按相邻 role 段计 assistant 轮 → 一轮多 step 被误判「会话太短」。
 * 手动路径 keepRecentMessages=10:消息必须 > 10 条才有可压缩 head。
 */
describe("session.compact 手动压缩(模型轨 + 轮次守卫)", () => {
  it("优先用 models.compact 轨(不调主轨 llm)", async () => {
    const mainCalls: unknown[] = [];
    const compactCalls: unknown[] = [];
    app = createGatewayApp({
      port: 7787,
      llm: { chat: async (m: unknown) => { mainCalls.push(m); return { content: "主轨摘要" }; } } as unknown as import("@lampgenie/runtime/agent/loop").LlmProvider,
      models: {
        compact: {
          update: () => { /* 测试占位 */ },
          chat: async (m: unknown) => { compactCalls.push(m); return { content: "压缩轨摘要" }; },
        } as unknown as import("@lampgenie/runtime/agent/loop").LlmProvider & { update: (p: Record<string, unknown>) => void },
      },
    });
    // @ts-expect-error 观察面暴露 journal
    const journal = (app as unknown as { journal: import("@lampgenie/core").Journal }).journal;
    journal.append({ kind: "message.user", sessionId: "sc", payload: { text: "第一轮" } });
    for (let i = 0; i < 12; i++) journal.append({ kind: "message.agent", sessionId: "sc", payload: { text: `第${i}步`, turn: i < 6 ? 1 : 2 } });
    journal.append({ kind: "message.user", sessionId: "sc", payload: { text: "第二轮" } });

    const ws = await connect(7787);
    await nextMessage(ws, "hello");
    ws.send(JSON.stringify({ v: 1, type: "session.compact", sessionId: "sc" }));
    const r = await nextMessage(ws, "session.compact.result");
    expect(r.compacted).toBe(true);
    expect(compactCalls.length).toBe(1); // 压缩轨真被调
    expect(mainCalls.length).toBe(0);    // 主轨不被碰
    const done = journal.readAll().find((e) => e.kind === "compact.done");
    expect(String((done?.payload as { summary?: string }).summary)).toBe("压缩轨摘要");
    ws.close();
  });

  it("单轮多 step(一条 user + 多条连续 message.agent,payload.turn 相同)可以压缩,不回「会话太短」", async () => {
    app = createGatewayApp({
      port: 7786,
      llm: { chat: async () => ({ content: "单轮摘要" }) } as unknown as import("@lampgenie/runtime/agent/loop").LlmProvider,
    });
    // @ts-expect-error 观察面暴露 journal
    const journal = (app as unknown as { journal: import("@lampgenie/core").Journal }).journal;
    journal.append({ kind: "message.user", sessionId: "s1r", payload: { text: "一轮做 15 步" } });
    for (let i = 0; i < 15; i++) journal.append({ kind: "message.agent", sessionId: "s1r", payload: { text: `step ${i}`, turn: 1 } });

    const ws = await connect(7786);
    await nextMessage(ws, "hello");
    ws.send(JSON.stringify({ v: 1, type: "session.compact", sessionId: "s1r" }));
    const r = await nextMessage(ws, "session.compact.result");
    expect(String(r.reason ?? "")).not.toContain("会话太短");
    expect(r.compacted).toBe(true);
    ws.close();
  });
});
