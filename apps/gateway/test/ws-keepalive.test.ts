import { describe, it, expect, afterEach } from "vitest";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { NodeRegistry } from "../src/nodes.js";
import { MemoryJournal } from "@lampgenie/core";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";
import WebSocket from "ws";
import http from "node:http";
import crypto from "node:crypto";

let app: GatewayApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

function waitDone(inbox: { type: string; task?: { state: string } }[], ms = 10_000): Promise<void> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("done 超时")), ms);
    const p = setInterval(() => {
      if (inbox.some((m) => m.type === "task.changed" && m.task?.state === "done")) { clearTimeout(t); clearInterval(p); res(); }
    }, 30);
  });
}

describe("WS keepalive 与断连恢复(修复)", () => {
  it("静默连接(握手后不回 pong)被超时清理", async () => {
    const port = 7841;
    const srv = startGatewayServer({
      port,
      taskManager: new TaskSupervisor(),
      journal: new MemoryJournal(),
      nodes: new NodeRegistry(),
      keepalive: { intervalMs: 50, timeoutMs: 180 },
    });
    // 裸 socket:完成 WS 握手但对服务端 ping 永不回 pong(ws 库/浏览器会自动回,这里模拟死客户端)
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({
      host: "127.0.0.1", port,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" },
    });
    req.end();
    const socket = await new Promise<import("node:net").Socket>((resolve, reject) => {
      req.on("upgrade", (_res, s) => resolve(s));
      req.on("error", reject);
    });
    // 裸探针必须消费数据流(resume):无消费者时 socket 处于 paused 态,'close' 不会触发
    // (真实 WS 客户端如 ws 库自带 data 处理,无此形态问题)。
    socket.resume();
    const closed = new Promise<void>((r) => socket.on("close", () => r()));
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("1.5s 内未清理死连接")), 1_500))]);
    expect(true).toBe(true);
    await srv.close();
  }, 5_000);

  it("活连接(auto-pong)不被 keepalive 误杀", async () => {
    // ws 库客户端对服务端协议级 ping 自动回 pong:多个 ping 周期 + 超时窗过后连接仍 OPEN。
    const port = 7844;
    const srv = startGatewayServer({
      port,
      taskManager: new TaskSupervisor(),
      journal: new MemoryJournal(),
      keepalive: { intervalMs: 60, timeoutMs: 300 },
    });
    const c = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => c.on("open", r));
    await new Promise((r) => setTimeout(r, 900)); // ≥3 个 ping 周期 + 2 个超时窗
    expect(c.readyState).toBe(WebSocket.OPEN);
    c.close();
    await srv.close();
  }, 5_000);

  it("env 可调(GENIE_WS_PING_MS/GENIE_WS_PONG_TIMEOUT_MS):缩短超时死连接被快速清理", async () => {
    // 未传 opts.keepalive,仅 env:证明生产无显式配置时 env 通道生效(优先级 opts > env > 缺省)。
    process.env.GENIE_WS_PING_MS = "40";
    process.env.GENIE_WS_PONG_TIMEOUT_MS = "150";
    const port = 7845;
    let srv: ReturnType<typeof startGatewayServer> | null = null;
    try {
      srv = startGatewayServer({ port, taskManager: new TaskSupervisor(), journal: new MemoryJournal() });
      const key = crypto.randomBytes(16).toString("base64");
      const req = http.request({
        host: "127.0.0.1", port,
        headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" },
      });
      req.end();
      const socket = await new Promise<import("node:net").Socket>((resolve, reject) => {
        req.on("upgrade", (_res, s) => resolve(s));
        req.on("error", reject);
      });
      socket.resume();
      const closed = new Promise<void>((r) => socket.on("close", () => r()));
      await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("env 缩短超时后死连接未被清理")), 1_500))]);
    } finally {
      delete process.env.GENIE_WS_PING_MS;
      delete process.env.GENIE_WS_PONG_TIMEOUT_MS;
      await srv?.close();
    }
  }, 5_000);

  it("断连恢复原语:断开期间的 journal 事件经重连 session.history(sinceSeq) 补齐", async () => {
    const port = 7822;
    app = createGatewayApp({ port, executor: new EchoChildBackend() });
    app.listenStandalone();

    // 客户端1:任务一 done 后断连
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox1: { type: string; task?: { state: string }; events?: { seq: number }[] }[] = [];
    ws1.on("message", (r) => inbox1.push(JSON.parse(r.toString())));
    await new Promise((r) => ws1.on("open", r));
    ws1.send(JSON.stringify({ v: 1, type: "session.history", sessionId: "ka", sinceSeq: 0 }));
    await new Promise((r) => setTimeout(r, 300));
    ws1.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "ka", instruction: "任务一", idempotencyKey: "ka-1" }));
    await waitDone(inbox1);
    const hist1 = inbox1.find((m) => m.type === "session.history.result");
    const beforeSeq = Math.max(-1, ...((hist1?.events ?? []).map((e) => e.seq)));
    // 先拿全量 history 定 maxSeq(任务一 done 之后)
    const probe = new WebSocket(`ws://127.0.0.1:${port}`);
    const probeInbox: { type: string; events?: { seq: number }[] }[] = [];
    probe.on("message", (r) => probeInbox.push(JSON.parse(r.toString())));
    await new Promise((r) => probe.on("open", r));
    probe.send(JSON.stringify({ v: 1, type: "session.history", sessionId: "ka", sinceSeq: 0 }));
    await new Promise((r) => setTimeout(r, 300));
    const maxSeq = Math.max(...((probeInbox.find((m) => m.type === "session.history.result")?.events ?? []).map((e) => e.seq)));
    probe.close();
    ws1.close();

    // 断连期间:客户端2 提交任务二
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox2: { type: string; task?: { state: string } }[] = [];
    ws2.on("message", (r) => inbox2.push(JSON.parse(r.toString())));
    await new Promise((r) => ws2.on("open", r));
    ws2.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "ka", instruction: "任务二", idempotencyKey: "ka-2" }));
    await waitDone(inbox2);
    ws2.close();

    // 客户端1 重连:增量拉取补齐断连期间事件
    const ws3 = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox3: { type: string; events?: { seq: number; kind: string }[] }[] = [];
    ws3.on("message", (r) => inbox3.push(JSON.parse(r.toString())));
    await new Promise((r) => ws3.on("open", r));
    ws3.send(JSON.stringify({ v: 1, type: "session.history", sessionId: "ka", sinceSeq: maxSeq + 1 }));
    const hist = await new Promise<{ events?: { seq: number; kind: string }[] }>((res, rej) => {
      const t = setTimeout(() => rej(new Error("history 超时")), 5_000);
      const p = setInterval(() => {
        const h = inbox3.find((m) => m.type === "session.history.result");
        if (h) { clearTimeout(t); clearInterval(p); res(h); }
      }, 30);
    });
    expect((hist.events ?? []).length).toBeGreaterThan(0);
    expect((hist.events ?? []).every((e) => e.seq > maxSeq)).toBe(true); // 全部是断连期间的新事件=增量语义
    ws3.close();
  }, 20_000);
});
