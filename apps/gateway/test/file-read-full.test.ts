/**
 * file.read full=true 全文读(IDE 编辑区数据源);缺省(不带参数)逐字节保持
 * ±20 行窗口旧语义(citation/#fileViewer/sidebar.spec 三消费面锁死)。另锁 binary/tooLarge
 * 标志:首 8KB 含 NUL=binary、>2MB=tooLarge,均不回全文。
 * 测试基建纪律:
 * - 端口:http listen(0) 真实绑定取空闲口(不硬编码,合跑/并行零 EADDRINUSE);
 * - waitType 消费式(匹配后从 inbox 移除),同 type 多次请求各取各的响应,不误捞旧帧;
 * - server/http 关闭全部进 finally,断言失败也不泄漏进程占口。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import type { ProjectRegistry } from "../src/projects.js";

const LINES = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`);
const FULL_TEXT = LINES.join("\n");

async function withSession(dir: string, fn: (send: (o: object) => void, waitType: (t: string) => Promise<Record<string, unknown>>) => Promise<void>) {
  const stub = { activeId: () => "p1", resolveWorkdir: () => dir, list: () => [] } as unknown as ProjectRegistry;
  // 临时端口:先让 http 真实绑定 listen(0) 拿空闲口,再把 WSS 挂上去(零硬编码、零竞态)。
  const httpServer = createServer();
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = (httpServer.address() as { port: number }).port;
  const srv = startGatewayServer({ port, server: httpServer, taskManager: new TaskSupervisor(), journal: new MemoryJournal(), projects: stub });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: Record<string, unknown>[] = [];
  ws.on("message", (r) => inbox.push(JSON.parse(r.toString()) as Record<string, unknown>));
  await new Promise((r) => ws.on("open", r));
  const send = (o: object) => ws.send(JSON.stringify({ v: 1, ...o }));
  // 消费式等待:命中即从 inbox 移除,下一次同 type 等待拿到的是新响应(修复误捞旧帧)。
  const waitType = (t: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${t} 超时`)), 10_000);
      const p = setInterval(() => {
        const i = inbox.findIndex((x) => x.type === t);
        if (i >= 0) { clearTimeout(timer); clearInterval(p); resolve(inbox.splice(i, 1)[0]); }
      }, 25);
    });
  try { await fn(send, waitType); } finally {
    try { ws.close(); } catch { /* 已断开容忍 */ }
    await srv.close();
    await new Promise<void>((r) => { httpServer.close(() => r()); httpServer.closeAllConnections?.(); });
  }
}

describe("file.read full=true 全文与守卫标志", () => {
  it("full:true 返回全文(startLine=1,content=完整文本)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fr-"));
    try {
      writeFileSync(join(dir, "big.txt"), FULL_TEXT, "utf-8");
      await withSession(dir, async (send, waitType) => {
        send({ type: "file.read", path: "big.txt", full: true });
        const r = await waitType("file.read.result");
        expect(r.content).toBe(FULL_TEXT);
        expect(r.startLine).toBe(1);
        expect(r.totalLines).toBe(100);
        expect(r.binary).toBeUndefined();
        expect(r.tooLarge).toBeUndefined();
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("不带参数保持 ±20 行窗口(缺省行为不变)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fr-"));
    try {
      writeFileSync(join(dir, "win.txt"), FULL_TEXT, "utf-8");
      await withSession(dir, async (send, waitType) => {
        send({ type: "file.read", path: "win.txt", line: 50 });
        const r = await waitType("file.read.result");
        expect(r.startLine).toBe(30);
        expect(r.totalLines).toBe(100);
        expect(r.content).toBe(LINES.slice(29, 70).join("\n")); // 41 行窗口,与旧实现逐字节一致

        send({ type: "file.read", path: "win.txt" });
        const r2 = await waitType("file.read.result");
        expect(r2.startLine).toBe(1);
        expect(r2.content).toBe(LINES.slice(0, 21).join("\n")); // 缺省 line=1 → 前 21 行
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("首 8KB 含 NUL → binary 标记,不回全文", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fr-"));
    try {
      const buf = Buffer.concat([Buffer.from("PNG-ish\x00\x01\x02", "latin1"), Buffer.alloc(64, 7)]);
      writeFileSync(join(dir, "blob.bin"), buf);
      await withSession(dir, async (send, waitType) => {
        send({ type: "file.read", path: "blob.bin", full: true });
        const r = await waitType("file.read.result");
        expect(r.binary).toBe(true);
        expect(r.content).toBe("");
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it(">2MB → tooLarge 标记,不回全文", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fr-"));
    try {
      writeFileSync(join(dir, "huge.txt"), "a".repeat(2 * 1024 * 1024 + 1), "utf-8");
      await withSession(dir, async (send, waitType) => {
        send({ type: "file.read", path: "huge.txt", full: true });
        const r = await waitType("file.read.result");
        expect(r.tooLarge).toBe(true);
        expect(r.content).toBe("");
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("full 读子目录相对路径 + 越界路径回 missing(与旧读同强度)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fr-"));
    try {
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "sub", "n.txt"), "嵌套内容", "utf-8");
      await withSession(dir, async (send, waitType) => {
        send({ type: "file.read", path: "sub/n.txt", full: true });
        const r = await waitType("file.read.result");
        expect(r.content).toBe("嵌套内容");

        send({ type: "file.read", path: "../../../etc/passwd", full: true });
        const r2 = await waitType("file.read.result");
        expect(r2.missing).toBe(true);
        expect(r2.content).toBe("");
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
