/**
 * session→owner project 桥(2026-10-22 归属漂移根治,session.owner.get 服务端半边)。
 *
 * 语义:该会话**最早**一条带 projectId 的任务的 projectId = 会话既有 owner
 * (server.ts `sessionOwnerProjectId`);无任务/无归属 → projectId:null。
 * 契约字面:{type:"session.owner.get", sessionId}(c2s)/{type:"session.owner.result", sessionId, projectId}(s2c)。
 * 起服方式与 ws-integration.test.ts 同款(createGatewayApp 独立端口 + inbox 收集器)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import { createGatewayApp, type GatewayApp } from "../src/app.js";

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

function waitMatch(ws: WebSocket, pred: (m: Record<string, unknown>) => boolean, ms = 8000): Promise<Record<string, unknown>> {
  const inbox = (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 session.owner.result 超时")), ms);
    const poll = setInterval(() => {
      const hit = inbox.find(pred);
      if (hit) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(hit);
      }
    }, 20);
  });
}

describe("session.owner.get(会话 owner 项目桥)", () => {
  let app: GatewayApp | null = null;
  let server: Server | null = null;
  let port = 0;

  beforeEach(async () => {
    // 不注入 executor:任务停在 running,不会自动收尾(归属判定只看任务元数据)
    app = createGatewayApp({ port: 0, useExternalHttp: true, journalDir: undefined });
    server = createServer();
    await new Promise<void>((r) => server!.listen(0, r));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    app.attachWs(server);
  });

  afterEach(async () => {
    await app?.close();
    app = null;
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  it("返回最早一条带 projectId 的任务的 projectId(后续切项目不改写既有归属)", async () => {
    const tm = app!.taskManager;
    // 顺序:__harness__ → genie;owner 取**最早**的 __harness__(而不是最新)
    tm.submit("user", "s-owner", "第一个任务", { projectId: "__harness__", title: "t1" });
    await new Promise((r) => setTimeout(r, 5)); // createdAt 毫秒序保证
    tm.submit("user", "s-owner", "第二个任务", { projectId: "genie", title: "t2" });

    const ws = await connect(port);
    ws.send(JSON.stringify({ v: 1, type: "session.owner.get", sessionId: "s-owner" }));
    const r = await waitMatch(ws, (m) => m.type === "session.owner.result" && m.sessionId === "s-owner");
    expect(r.projectId).toBe("__harness__");
    ws.close();
  }, 20000);

  it("无任务 → projectId:null;有任务但都不带 projectId → 同样 null", async () => {
    const ws = await connect(port);
    ws.send(JSON.stringify({ v: 1, type: "session.owner.get", sessionId: "s-empty" }));
    const none = await waitMatch(ws, (m) => m.type === "session.owner.result" && m.sessionId === "s-empty");
    expect(none.projectId).toBeNull();

    app!.taskManager.submit("user", "s-noproj", "无项目任务", { title: "t" });
    ws.send(JSON.stringify({ v: 1, type: "session.owner.get", sessionId: "s-noproj" }));
    const bare = await waitMatch(ws, (m) => m.type === "session.owner.result" && m.sessionId === "s-noproj");
    expect(bare.projectId).toBeNull();
    ws.close();
  }, 20000);

  it("会话间互不串味:两个会话各自 owner 独立", async () => {
    const tm = app!.taskManager;
    tm.submit("user", "s-a", "a", { projectId: "proj-a" });
    tm.submit("user", "s-b", "b", { projectId: "proj-b" });
    const ws = await connect(port);
    ws.send(JSON.stringify({ v: 1, type: "session.owner.get", sessionId: "s-a" }));
    ws.send(JSON.stringify({ v: 1, type: "session.owner.get", sessionId: "s-b" }));
    const a = await waitMatch(ws, (m) => m.type === "session.owner.result" && m.sessionId === "s-a");
    const b = await waitMatch(ws, (m) => m.type === "session.owner.result" && m.sessionId === "s-b");
    expect(a.projectId).toBe("proj-a");
    expect(b.projectId).toBe("proj-b");
    ws.close();
  }, 20000);
});
