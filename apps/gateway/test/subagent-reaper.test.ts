/**
 * 机制4 网关启动僵尸清算 + 机制1/3 的 wiring 侧(外部后端形态):
 * - 启动清算:上一进程遗留 spawn-无-result 子代理补终态(journal append-only),幂等,不误伤本次进程所派;
 * - 外部后端 deadline 收割:wiring 层到点取消子代理,已有输出轨迹打包为部分结果交付(ok=true 显式标注);
 * - task_output stale 标记:运行中子代理超 staleWarnMin 无任何事件→stale:true(主 agent 止损依据)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import WebSocket from "ws";
import { createGatewayApp } from "../src/app.js";
import { reapOrphanSubagents } from "../src/agent-wiring.js";

// plan-gate 豁免:本文件测 reaper/worktree/会话纪律基础设施,不涉及规划流程
process.env.GENIE_PLAN_GATE = "off";


process.env.GENIE_PERM_ASK_MODE = "allow";

function waitFor<T>(fn: () => T | undefined, timeoutMs: number, stepMs = 50): Promise<T> {
  return (async () => {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v !== undefined) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error("waitFor 超时");
      await new Promise((r) => setTimeout(r, stepMs));
    }
  })();
}

describe("机制4:网关启动僵尸清算", () => {
  it("启动清算:孤儿 spawn 补终态;有 result 的不碰;二次启动幂等不重复补", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reap-"));
    const t0 = Date.now() - 2 * 3600_000;
    const lines = [
      { seq: 0, kind: "session.start", time: t0, sessionId: "s1", payload: {} },
      { seq: 1, kind: "subagent.spawn", time: t0, sessionId: "s1", payload: { agentId: "agent_zombie", taskId: "t1", instructions: "遗留的巡检" } },
      { seq: 2, kind: "subagent.spawn", time: t0 + 1000, sessionId: "s1", payload: { agentId: "agent_done", taskId: "t1", instructions: "正常完成的巡检" } },
      { seq: 3, kind: "subagent.result", time: t0 + 2000, sessionId: "s1", payload: { agentId: "agent_done", taskId: "t1", event: { type: "result", ok: true, finalText: "完成" } } },
    ];
    writeFileSync(join(dir, "gateway.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
    const countReaps = (evs: { kind: string; payload: Record<string, unknown> }[]) =>
      evs.filter((e) => e.kind === "subagent.result" && (e.payload as { reap?: unknown }).reap !== undefined);
    const app1 = createGatewayApp({ port: 0, journalDir: dir, executor: { kind: "noop" } as never });
    const evs1 = app1.journal.readAll() as { kind: string; payload: Record<string, unknown>; sessionId: string }[];
    const reaps1 = countReaps(evs1);
    expect(reaps1.length, "恰好补一条终态(只清孤儿)").toBe(1);
    const p1 = reaps1[0]!.payload as { agentId?: string; event?: { ok?: boolean; note?: string } };
    expect(p1.agentId).toBe("agent_zombie");
    expect(p1.event?.ok, "清算=显式失败终态(面板目录落「失败 · 网关重启」,不再永远运行中)").toBe(false);
    expect(p1.event?.note).toContain("网关重启");
    await app1.close();
    // 二次启动:补过终态的 agentId 已有 result → 不再命中(幂等)
    const app2 = createGatewayApp({ port: 0, journalDir: dir, executor: { kind: "noop" } as never });
    const evs2 = app2.journal.readAll() as { kind: string; payload: Record<string, unknown> }[];
    expect(countReaps(evs2).length, "二次启动不重复补终态").toBe(1);
    await app2.close();
  }, 30_000);

  it("不误伤:bootAt 之后(本次进程)新派的 spawn 不清算;直接函数面幂等", () => {
    const j = new MemoryJournal();
    const now = Date.now();
    j.append({ kind: "subagent.spawn", sessionId: "sx", payload: { agentId: "agent_new", taskId: "tn" }, time: now - 100 });
    j.append({ kind: "subagent.spawn", sessionId: "sx", payload: { agentId: "agent_old", taskId: "to" }, time: now - 3600_000 });
    // bootAt 界线在两次 spawn 之间:agent_new(界线后=本次进程所派)不误伤,agent_old(界线前=上进程遗留)补终态
    const bootAt = now - 50_000;
    const reaped1 = reapOrphanSubagents(j, { bootAt });
    expect(reaped1).toEqual(["agent_old"]);
    // 二次清扫:已有终态 → 空(idempotencyKey 双保险)
    const reaped2 = reapOrphanSubagents(j, { bootAt });
    expect(reaped2).toEqual([]);
    const results = j.readAll().filter((e) => e.kind === "subagent.result");
    expect(results.length, "agent_old 恰好一条终态,零重复").toBe(1);
  });
});

describe("机制1(外部后端形态):deadline 到点 wiring 收割", () => {
  it("外部后端超时未返回→取消+output.txt 轨迹打包为部分结果(ok=true)+journal 终态+注册表落终态", async () => {
    let cancelCalled = false;
    let phase = 0;
    const extBackend = {
      kind: "ext-deadline-test",
      async spawn(spec: { taskId: string }, onEvent: (e: { type: string; note?: string }) => void) {
        onEvent({ type: "progress", note: "外部后端已开工" });
        return { taskId: spec.taskId, cancel: async () => { cancelCalled = true; }, steer: async () => true, respondPermission: async () => {} };
      },
    };
    const app = createGatewayApp({
      port: 0,
      useExternalHttp: true,
      llm: { async chat(_messages: unknown) {
        phase++;
        if (phase === 1) return { content: "", toolCalls: [{ id: "e1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "长巡检任务", run_in_background: true, deadlineMin: 0.01 }) }] };
        return { content: "已派后台子代理" };
      } } as never,
      executor: extBackend as never,
    });
    app.taskManager.submit("user", "reap-dl", "派个巡检");
    for (let i = 0; i < 100; i++) {
      const t = app.taskManager.list().find((x) => x.sessionId === "reap-dl");
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const evs = app.journal.readAll() as { kind: string; payload: Record<string, unknown> }[];
    const spawnEv = evs.find((e) => e.kind === "subagent.spawn");
    const agentId = String(spawnEv?.payload.agentId ?? "");
    expect(agentId).toMatch(/^agent_/);
    // deadline 600ms 后:wiring 收割
    const reapEv = await waitFor(() => {
      const found = (app.journal.readAll() as { kind: string; payload: Record<string, unknown> }[]).find(
        (e) => e.kind === "subagent.result" && (e.payload as { reap?: { reason?: string } }).reap?.reason === "deadline",
      );
      return found;
    }, 6_000) as { payload: Record<string, unknown> } | undefined;
    expect(reapEv, "deadline 收割应落 journal 终态").toBeTruthy();
    const rp = reapEv!.payload as { agentId?: string; event?: { ok?: boolean; finalText?: string } };
    expect(rp.agentId).toBe(agentId);
    expect(rp.event?.ok, "收割不是 fail——部分结果交付").toBe(true);
    expect(rp.event?.finalText).toContain("[deadline 收割]");
    expect(cancelCalled, "收割应取消外部子代理").toBe(true);
    // 注册表与输出文件
    const reg = (globalThis as { __bgAgents?: Map<string, { status: string; outputFile: string }> }).__bgAgents!;
    const entry = reg.get(agentId)!;
    expect(entry.status).toBe("completed");
    expect(existsSync(entry.outputFile), "输出文件应在").toBe(true);
    const outText = readFileSync(entry.outputFile, "utf-8");
    expect(outText).toContain("[progress] 外部后端已开工");
    expect(outText).toContain("[result ok=true]");
    expect(outText).toContain("[deadline 收割]");
    await app.close();
  }, 30_000);
});

describe("机制3(主 agent 面):task_output stale 标记", () => {
  it("运行中子代理超 staleWarnMin 无任何事件→waitSec 等待超时的 task_output 带 stale:true", async () => {
    let phase = 0;
    const silentBackend = {
      kind: "ext-silent-test",
      async spawn(spec: { taskId: string }, onEvent: (e: { type: string; note?: string }) => void) {
        onEvent({ type: "progress", note: "开工一线后彻底沉默" });
        return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
      },
    };
    const app = createGatewayApp({
      port: 0,
      useExternalHttp: true,
      config: { agent: { subagentStaleWarnMin: 0.05 } }, // 3s:测试窗内可观测
      llm: { async chat(messages: { role: string; content: string }[]) {
        phase++;
        if (phase === 1) return { content: "", toolCalls: [{ id: "s1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "沉默的巡检", run_in_background: true }) }] };
        if (phase === 2) {
          const last = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
          const aid = String(last.match(/"agentId":"(agent_[a-z0-9]+)"/)?.[1] ?? "");
          return { content: "", toolCalls: [{ id: "s2", name: "task_output", arguments: JSON.stringify({ agentId: aid, waitSec: 4 }) }] };
        }
        return { content: "已检查,子代理疑似卡死" };
      } } as never,
      executor: silentBackend as never,
    });
    app.taskManager.submit("user", "reap-stale", "盯一下子代理");
    for (let i = 0; i < 200; i++) {
      const t = app.taskManager.list().find((x) => x.sessionId === "reap-stale");
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const evs = app.journal.readAll() as { kind: string; payload: { name?: string; content?: string } }[];
    const toResult = evs.filter((e) => e.kind === "tool.result" && e.payload.name === "task_output").at(-1);
    expect(toResult, "task_output 结果应在案").toBeTruthy();
    const parsed = JSON.parse(String(toResult!.payload.content ?? "{}")) as { status?: string; stale?: boolean; staleNote?: string };
    expect(parsed.status).toBe("running");
    expect(parsed.stale, "超阈值无产出→stale 标记(主 agent 可止损重派)").toBe(true);
    expect(parsed.staleNote).toContain("无任何事件");
    await app.close();
  }, 30_000);
});

describe("subagent.cancel 通路(G3 协议 × spawnTool 句柄收尾)", () => {
  it("运行中条目挂 cancel 句柄:WS 终止→ok:true+注册表翻 failed+journal 终态;已收尾再终止=ok:false", async () => {
    let phase = 0;
    let cancelCalls = 0;
    let sink: ((e: { type: string; result?: { ok: boolean; error?: { kind?: string } } }) => void) | undefined;
    const hangBackend = {
      kind: "ext-cancel-test",
      async spawn(spec: { taskId: string }, onEvent: (e: { type: string; result?: { ok: boolean; error?: { kind?: string } } }) => void) {
        sink = onEvent;
        onEvent({ type: "progress" } as never); // 活性一线
        return {
          taskId: spec.taskId,
          cancel: async () => {
            cancelCalls++;
            sink?.({ type: "result", result: { ok: false, error: { kind: "cancelled" } } }); // 取消→后端落终态
          },
          steer: async () => true,
          respondPermission: async () => {},
        };
      },
    };
    const app = createGatewayApp({
      port: 7877,
      llm: { async chat(_m: unknown) {
        phase++;
        if (phase === 1) return { content: "", toolCalls: [{ id: "c1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "会被终止的巡检", run_in_background: true }) }] };
        return { content: "已派" };
      } } as never,
      executor: hangBackend as never,
    });
    app.taskManager.submit("user", "cancel-ch", "派个可终止的子代理");
    for (let i = 0; i < 100; i++) {
      const t = app.taskManager.list().find((x) => x.sessionId === "cancel-ch");
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const agentId = String((app.journal.readAll() as { kind: string; payload: Record<string, unknown> }[]).find((e) => e.kind === "subagent.spawn")?.payload.agentId ?? "");
    expect(agentId).toMatch(/^agent_/);
    const reg = (globalThis as { __bgAgents?: Map<string, { status: string; cancel?: unknown }> }).__bgAgents!;
    expect(typeof reg.get(agentId)?.cancel, "运行中条目应挂 cancel 句柄").toBe("function");
    // WS 终止(G3 协议全链:parse → server case → 注册表句柄)
    const ws = new WebSocket(`ws://127.0.0.1:7877`);
    const inbox: { type: string; ok?: boolean; reason?: string; agentId?: string }[] = [];
    ws.on("message", (r) => inbox.push(JSON.parse(r.toString())));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ v: 1, type: "subagent.cancel", agentId }));
    await waitFor(() => inbox.find((m) => m.type === "subagent.cancel.result"), 5_000);
    const first = inbox.find((m) => m.type === "subagent.cancel.result")!;
    expect(first.ok, "句柄在场→取消成功").toBe(true);
    expect(first.agentId).toBe(agentId);
    expect(cancelCalls, "句柄应真正调到后端 cancel").toBe(1);
    // 取消→后端 result(ok=false cancelled)→注册表翻 failed+journal 终态+句柄摘除
    await waitFor(() => reg.get(agentId)?.status === "failed" ? true : undefined, 5_000);
    expect(reg.get(agentId)?.cancel, "终态摘除句柄").toBeUndefined();
    const termEv = (app.journal.readAll() as { kind: string; payload: { agentId?: string; event?: { ok?: boolean } } }[]).filter((e) => e.kind === "subagent.result" && e.payload.agentId === agentId);
    expect(termEv.some((e) => e.payload.event?.ok === false), "取消终态落 journal").toBe(true);
    // 已收尾再终止:句柄缺席=server 诚实 ok:false(不假做成功)
    ws.send(JSON.stringify({ v: 1, type: "subagent.cancel", agentId }));
    await waitFor(() => inbox.filter((m) => m.type === "subagent.cancel.result").length >= 2 ? true : undefined, 5_000);
    const second = inbox.filter((m) => m.type === "subagent.cancel.result")[1]!;
    expect(second.ok).toBe(false);
    expect(String(second.reason)).toContain("取消通道未接入");
    ws.close();
    await app.close();
  }, 30_000);
});
