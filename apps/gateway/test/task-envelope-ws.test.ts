/**
 * M162 信封闸生产可达性(WS e2e):修复前 protocol TaskSubmit 无 source/envelope/deliveryKey 字段,
 * zod strip 后 server 的 externalSourceOf(rawSubmit) 永远拿不到 source —— 外部来源路径不可达。
 *
 * 断言面(真网关 createGatewayApp + WS,无 llm/executor=任务停在 running):
 * ① source=bot + deliveryKey → task.submitted 带 envelope + journal task.envelope.issued;
 * ② 同 deliveryKey 重投 → duplicate:true 且 taskId 相同;
 * ③ 篡改 envelope.taskId → error ENVELOPE_DIGEST_MISMATCH 且不建任务;
 * ④ 带 workspace → error SOURCE_SELF_DECLARED_WORKSPACE;
 * ⑤ 内部 user 提交(无 source)→ 零变化(无 envelope、journal 无 issued)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import { createGatewayApp, type GatewayApp } from "../src/app.js";

interface Msg {
  type?: string;
  code?: string;
  duplicate?: boolean;
  task?: { id: string; sessionId: string };
  envelope?: { taskId: string; source?: { kind?: string; id?: string }; deliveryKey?: string };
}

let app: GatewayApp | null = null;
let server: Server | null = null;
let ws: WebSocket | null = null;

afterEach(async () => {
  ws?.close();
  ws = null;
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  await app?.close();
  app = null;
});

async function boot(): Promise<{ ws: WebSocket; inbox: Msg[]; wait: (pred: (m: Msg) => boolean, ms?: number) => Promise<Msg> }> {
  app = createGatewayApp({ port: 0, useExternalHttp: true });
  server = createServer();
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  app.attachWs(server);
  const sock = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: Msg[] = [];
  sock.on("message", (raw) => inbox.push(JSON.parse(raw.toString()) as Msg));
  await new Promise((r) => sock.on("open", r));
  ws = sock;
  const wait = (pred: (m: Msg) => boolean, ms = 8000): Promise<Msg> => {
    const cursor = inbox.length; // 只等「发送之后」的新消息
    return new Promise<Msg>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("等待消息超时")), ms);
      const poll = setInterval(() => {
        const hit = inbox.slice(cursor).find(pred);
        if (hit) { clearTimeout(t); clearInterval(poll); resolve(hit); }
      }, 30);
    });
  };
  return { ws: sock, inbox, wait };
}

function issuedEvents(sessionId: string): { type?: unknown; taskId?: unknown }[] {
  const events = app!.journal.readSession(sessionId) as { payload?: { type?: unknown; taskId?: unknown } }[];
  return events.map((e) => e.payload ?? {}).filter((p) => p.type === "task.envelope.issued");
}

describe("M162 信封闸 WS 生产链路", () => {
  it("外部来源签发/重投去重/篡改拒收/自声明拒收/内部零变化", { timeout: 30_000 }, async () => {
    const { ws, wait } = await boot();

    // ① source=bot + deliveryKey → 带 envelope + journal issued
    ws.send(JSON.stringify({
      v: 1, type: "task.submit", sessionId: "s-ext", instruction: "外部任务",
      source: { kind: "bot", id: "probe-bot" }, deliveryKey: "deliver-1",
    }));
    const first = await wait((m) => m.type === "task.submitted");
    expect(first.envelope, "外部来源应回执 envelope").toBeTruthy();
    expect(first.envelope?.source).toEqual({ kind: "bot", id: "probe-bot" });
    expect(first.envelope?.taskId).toBe(first.task?.id);
    expect(first.duplicate).toBeUndefined();
    const issued = issuedEvents("s-ext");
    expect(issued.length, "journal 应落 task.envelope.issued").toBe(1);
    expect(issued[0]!.taskId).toBe(first.task?.id);

    // ② 同 deliveryKey 重投 → duplicate 同 taskId
    ws.send(JSON.stringify({
      v: 1, type: "task.submit", sessionId: "s-ext", instruction: "外部任务",
      source: { kind: "bot", id: "probe-bot" }, deliveryKey: "deliver-1",
    }));
    const again = await wait((m) => m.type === "task.submitted");
    expect(again.duplicate).toBe(true);
    expect(again.task?.id).toBe(first.task?.id);
    expect(app!.taskManager.list().length, "重投不应再建任务").toBe(1);

    // ③ 篡改 envelope.taskId → ENVELOPE_DIGEST_MISMATCH 且不建任务
    const tampered = { ...first.envelope!, taskId: "tampered-task-id" };
    ws.send(JSON.stringify({
      v: 1, type: "task.submit", sessionId: "s-ext", instruction: "篡改信封",
      source: { kind: "bot", id: "probe-bot" }, deliveryKey: "deliver-2", envelope: tampered,
    }));
    const mismatch = await wait((m) => m.type === "error");
    expect(mismatch.code).toBe("ENVELOPE_DIGEST_MISMATCH");
    expect(app!.taskManager.list().length, "篡改信封不建任务").toBe(1);

    // ④ 自声明 workspace → SOURCE_SELF_DECLARED_WORKSPACE
    ws.send(JSON.stringify({
      v: 1, type: "task.submit", sessionId: "s-ext", instruction: "越权落点",
      source: { kind: "remote", id: "r1" }, workspace: "/etc",
    }));
    const selfDecl = await wait((m) => m.type === "error");
    expect(selfDecl.code).toBe("SOURCE_SELF_DECLARED_WORKSPACE");
    expect(app!.taskManager.list().length).toBe(1);

    // ⑤ 内部 user 提交(面板口径,无 source)→ 零变化
    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "s-user", instruction: "内部任务" }));
    const inner = await wait((m) => m.type === "task.submitted");
    expect("envelope" in inner, "内部路径不带 envelope").toBe(false);
    expect(issuedEvents("s-user").length, "内部路径无 task.envelope.issued").toBe(0);
    expect(app!.taskManager.list().length).toBe(2);
  });
});
