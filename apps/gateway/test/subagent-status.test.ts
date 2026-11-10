import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// B(2026-10-14)子代理过程卡服务端面:session.status 带 subagentList(后台注册表按会话过滤+output.txt tail);
// journal 的 subagent.spawn/subagent.result 带 agentId(面板卡关联键)。纯增量,不触权限语义。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { createGatewayApp } from "../src/app.js";

// env 互斥(2026-10-20):threads pool 共享 process.env,动 GENIE_PERMISSION_RULES 等进程级开关的
// 测试文件必须串行,否则并行文件互相拆 env=间歇假红。
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
beforeAll(async () => { await acquireEnvLock("subagent-status"); }, 240_000); // 等锁可能长(hook 默认 10s 会假红)
afterAll(() => { releaseEnvLock("subagent-status"); });

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox: Record<string, unknown>[] = [];
    (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox = inbox;
    ws.on("message", (raw: Buffer) => inbox.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket, type: string, timeoutMs = 4000): Promise<Record<string, unknown>> {
  const inbox = (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox;
  const hit = inbox.findIndex((m) => m.type === type);
  if (hit >= 0) return Promise.resolve(inbox.splice(hit, 1)[0]!);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeoutMs);
    const poll = setInterval(() => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) { clearTimeout(timer); clearInterval(poll); resolve(inbox.splice(i, 1)[0]!); }
    }, 20);
  });
}

describe("子代理过程卡服务端面(B)", () => {
  it("session.status.subagentList:按会话过滤注册表+tail;他会话不带该字段;journal 事件带 agentId", async () => {
    process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
    const seen: string[] = [];
    const slowBackend = {
      kind: "sbd-test",
      async spawn(spec: { taskId: string }, onEvent: (e: { type: string; note?: string; result?: { ok: boolean; finalText?: string } }) => void) {
        onEvent({ type: "progress", note: "扫描中第一批" });
        setTimeout(() => { try { onEvent({ type: "result", result: { ok: true, finalText: "调查完成:两处渲染点" } }); } catch { /* 收尾竞态 */ } }, 250);
        return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
      },
    };
    const app = createGatewayApp({      port: 7785,
      llm: { async chat() {
        if (seen.length === 0) { seen.push("spawn"); return { content: "", toolCalls: [{ id: "b1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "调查渲染链路", agentType: "explore", run_in_background: true }) }] }; }
        return { content: "已派后台子代理" };
      } } as never,
      executor: slowBackend as never,
    });
    const ws = await connect(7785);
    await nextMessage(ws, "hello");
    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "sa-1", instruction: "派子代理", idempotencyKey: "k-sa1" }));
    await nextMessage(ws, "task.submitted");
    for (let i = 0; i < 80; i++) {
      const t = app.taskManager.list().find((x) => x.sessionId === "sa-1");
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 500)); // 等后台终态事件落盘
    ws.send(JSON.stringify({ v: 1, type: "session.status", sessionId: "sa-1" }));
    const m = await nextMessage(ws, "session.status.result");
    const status = m.status as { subagentList?: { agentId: string; status: string; outputFile: string; tail?: string; model?: string }[] };
    expect(Array.isArray(status.subagentList), "本会话应带 subagentList").toBe(true);
    const entry = status.subagentList![0]!;
    expect(entry.agentId, "agentId 形态").toMatch(/^agent_/);
    expect(entry.status, "后台子代理应已终态").toBe("completed");
    expect(entry.tail, "tail 应含进度行").toContain("[progress] 扫描中第一批");
    expect(entry.tail, "tail 应含结果行").toContain("[result ok=true]");
    // step-060 子代理目录:注册表带模型名(测试用自造 provider 无 modelName 字段=诚实回落「主模型」)
    expect(entry.model, "model 应回落主模型文案").toBe("主模型");
    // journal 事件关联键
    const all = (app as unknown as { journal: { readAll(): { kind: string; sessionId?: string; payload: Record<string, unknown> }[] } }).journal.readAll();
    const spawnEv = all.find((e) => e.kind === "subagent.spawn" && e.sessionId === "sa-1");
    expect(String(spawnEv?.payload.agentId ?? ""), "spawn 事件应带 agentId").toMatch(/^agent_/);
    const resEv = all.find((e) => e.kind === "subagent.result" && e.sessionId === "sa-1");
    expect(String(resEv?.payload.agentId ?? ""), "result 事件应带 agentId(后台路径也落终态)").toMatch(/^agent_/);
    // 他会话:注册表过滤后为空 → 不带字段(降级=与旧版一致的诚实形态)
    ws.send(JSON.stringify({ v: 1, type: "session.status", sessionId: "sa-other" }));
    const m2 = await nextMessage(ws, "session.status.result");
    const status2 = m2.status as { subagentList?: unknown[] };
    expect(status2.subagentList, "无子代理会话不带 subagentList").toBeUndefined();
    ws.close();
    await app.close();
    delete process.env.GENIE_PERMISSION_RULES;
  }, 30_000);
});
