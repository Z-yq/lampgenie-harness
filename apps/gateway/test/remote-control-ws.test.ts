/**
 * 移动端远程控制端到端(真实 WS + 真实面板 HTTP):
 * start → 二维码/链接 → /m 配对页 200 → 手机 WS 连上 → 桌面状态 connected → stop → idle。
 * 同时验证坏 token 的 HTTP 403 与 WS 4003 拒连。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createGatewayApp } from "../src/app.js";
import { servePanel } from "../src/panel.js";

const PORT = 7983;

interface Inbox {
  ws: WebSocket;
  box: Record<string, unknown>[];
  closeCode?: number;
}

function connect(url: string): Promise<Inbox> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const box: Record<string, unknown>[] = [];
    const out: Inbox = { ws, box };
    ws.on("message", (raw) => { try { box.push(JSON.parse(String(raw)) as Record<string, unknown>); } catch { /* 忽略 */ } });
    ws.on("close", (code) => { out.closeCode = code; });
    ws.on("open", () => resolve(out));
    ws.on("error", reject);
  });
}

async function waitFor(inbox: Inbox, pred: (m: Record<string, unknown>) => boolean, label: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = inbox.box.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("等待超时:" + label + " / 已收:" + inbox.box.map((m) => String(m.type)).join(","));
}

describe("remote control WS 配对全链", () => {
  const ROOT = mkdtempSync(join(tmpdir(), "remote-control-ws-"));
  const OLD_ROOT = process.env.GENIE_REPO_ROOT;
  let app: ReturnType<typeof createGatewayApp>;
  let panel: ReturnType<typeof servePanel>;
  let desktop: Inbox;

  beforeAll(async () => {
    process.env.GENIE_REPO_ROOT = ROOT;
    process.env.GENIE_PUBLIC_HOST = "127.0.0.1";
    app = createGatewayApp({ port: PORT, useExternalHttp: true, journalDir: join(ROOT, ".genie", "journals") });
    panel = servePanel(PORT, (server) => app.attachWs(server), {
      verifyPair: (token) => app.remoteControl.verifyToken(token),
    });
    desktop = await connect(`ws://127.0.0.1:${PORT}`);
    await waitFor(desktop, (m) => m.type === "hello", "hello");
  }, 30_000);

  afterAll(async () => {
    try { desktop?.ws.close(); } catch { /* 忽略 */ }
    try { await app?.close(); } catch { /* 忽略 */ }
    try { await panel?.close(); } catch { /* 忽略 */ }
    if (OLD_ROOT === undefined) delete process.env.GENIE_REPO_ROOT;
    else process.env.GENIE_REPO_ROOT = OLD_ROOT;
    delete process.env.GENIE_PUBLIC_HOST;
    try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });

  it("start → waiting;坏 token 403;好 token 200;手机 WS → connected;stop → idle", async () => {
    desktop.ws.send(JSON.stringify({ v: 1, type: "remote.control.start" }));
    const status = await waitFor(desktop, (m) => m.type === "remote.control.status.result", "start status");
    expect(status.state).toBe("waiting");
    expect(status.clients).toBe(0);
    expect(String(status.connectUrl)).toContain("/m?pair=");
    expect(String(status.qrSvg)).toContain("<svg");
    const token = new URL(String(status.connectUrl)).searchParams.get("pair")!;
    expect(token).toHaveLength(64);

    const bad = await fetch(`http://127.0.0.1:${PORT}/m?pair=nope`);
    expect(bad.status).toBe(403);
    expect(await bad.text()).toContain("链接已失效");

    const ok = await fetch(`http://127.0.0.1:${PORT}/m?pair=${encodeURIComponent(token)}`);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("Genie 远程控制");
    expect(html).toContain("viewport-fit=cover");

 // 手机 WS(同一 token)→ 桌面状态 connected
    const mobile = await connect(`ws://127.0.0.1:${PORT}/?pair=${encodeURIComponent(token)}`);
    desktop.ws.send(JSON.stringify({ v: 1, type: "remote.control.status" }));
    const connected = await waitFor(desktop, (m) => m.type === "remote.control.status.result" && m.state === "connected", "connected");
    expect(connected.clients).toBe(1);

 // 手机断开 → 回到 waiting
    mobile.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    desktop.ws.send(JSON.stringify({ v: 1, type: "remote.control.status" }));
    const waiting = await waitFor(desktop, (m) => m.type === "remote.control.status.result" && m.state === "waiting", "waiting after mobile close");
    expect(waiting.clients).toBe(0);

 // 停止 → idle;旧 token 再连 → 4003
    desktop.ws.send(JSON.stringify({ v: 1, type: "remote.control.stop" }));
    const idle = await waitFor(desktop, (m) => m.type === "remote.control.status.result" && m.state === "idle", "idle");
    expect(idle.clients).toBe(0);

    const badWs = await connect(`ws://127.0.0.1:${PORT}/?pair=${encodeURIComponent(token)}`);
    const t0 = Date.now();
    while (badWs.closeCode === undefined && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 30));
    expect(badWs.closeCode).toBe(4003);
  }, 30_000);
});