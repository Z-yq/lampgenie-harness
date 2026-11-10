/**
 * IDE 保存链沙箱负面断言:file.write 必须「合法相对路径可写、一切越界形态拒绝且
 * 真实文件未创建」。沙箱=realpath 前缀比对(与 file.read 同强度,symlink 先解析防逃逸)+
 * .git/ 路径段拒 + 512KB 上限;允许新建文件,父目录不存在报错(协议口径:不隐式建目录,
 * 故合法写用例需预建父目录)。
 * 测试基建纪律(与 file-read-full.test.ts 同款):
 * - 端口:http listen(0) 真实绑定取空闲口(不硬编码,合跑/并行零 EADDRINUSE);
 * - waitType 消费式(命中即从 inbox 移除),同 type 多次请求各取各的响应;
 * - server/http 关闭全部进 finally,断言失败/超时也不泄漏进程占口。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import WebSocket from "ws";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import type { ProjectRegistry } from "../src/projects.js";

function stubFor(dir: string): ProjectRegistry {
  return { activeId: () => "p1", resolveWorkdir: () => dir, list: () => [] } as unknown as ProjectRegistry;
}

/** 起一套临时端口网关并跑 fn;server/http 的关闭在 finally,任一断言失败也不泄漏。 */
async function withGateway(dir: string, fn: (send: (o: object) => void, waitType: (t: string) => Promise<Record<string, unknown>>) => Promise<void>) {
  const httpServer = createServer();
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = (httpServer.address() as { port: number }).port;
  const srv = startGatewayServer({ port, server: httpServer, taskManager: new TaskSupervisor(), journal: new MemoryJournal(), projects: stubFor(dir) });
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

describe("file.write 沙箱(合法写+四类拒绝)", () => {
  it("合法相对路径写成功(新文件+覆盖既有文件)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fw-"));
    try {
      mkdirSync(join(dir, "notes"), { recursive: true }); // 协议口径:允许新建文件但父目录须已存在(不隐式建目录)
      await withGateway(dir, async (send, waitType) => {
        send({ type: "file.write", path: "notes/todo.md", content: "第一版" });
        const r1 = await waitType("file.write.result");
        expect(r1.ok).toBe(true);
        expect(existsSync(join(dir, "notes/todo.md"))).toBe(true);
        expect(readFileSync(join(dir, "notes/todo.md"), "utf-8")).toBe("第一版");

        send({ type: "file.write", path: "notes/todo.md", content: "覆盖后的第二版" });
        const r2 = await waitType("file.write.result");
        expect(r2.ok).toBe(true);
        expect(readFileSync(join(dir, "notes/todo.md"), "utf-8")).toBe("覆盖后的第二版");
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("../../ 越界拒且目标文件未创建", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fw-"));
    try {
      const outside = join(dir, "..", "gw-fw-evil-marker.txt");
      await withGateway(dir, async (send, waitType) => {
        send({ type: "file.write", path: "../../../gw-fw-evil-marker.txt", content: "evil" });
        const e = await waitType("error");
        expect(e.code).toBe("file-write-denied");
        expect(String(e.message)).toContain("越界");
      });
      expect(existsSync(outside)).toBe(false);
      expect(existsSync("/tmp/gw-fw-evil-marker.txt")).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(join(dir, "..", "gw-fw-evil-marker.txt"), { force: true }); }
  });

  it(".git/ 路径拒(根段与子目录段)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fw-"));
    try {
      await withGateway(dir, async (send, waitType) => {
        send({ type: "file.write", path: ".git/config", content: "evil" });
        const e1 = await waitType("error");
        expect(e1.code).toBe("file-write-denied");
        expect(String(e1.message)).toContain(".git");

        send({ type: "file.write", path: "sub/.git/hooks/x.sh", content: "evil" });
        const e2 = await waitType("error");
        expect(e2.code).toBe("file-write-denied");
      });
      expect(existsSync(join(dir, ".git"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("symlink 出仓拒且仓外文件内容不变(symlink 逃逸)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fw-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "gw-fw-out-"));
    try {
      const outsideFile = join(outsideDir, "secret.txt");
      writeFileSync(outsideFile, "不可被改写", "utf-8");
      mkdirSync(join(dir, "docs"), { recursive: true });
      symlinkSync(outsideFile, join(dir, "docs", "leak.txt"));
      await withGateway(dir, async (send, waitType) => {
        send({ type: "file.write", path: "docs/leak.txt", content: "已被篡改" });
        const e = await waitType("error");
        expect(e.code).toBe("file-write-denied");
      });
      expect(readFileSync(outsideFile, "utf-8")).toBe("不可被改写"); // 负面断言必须验「文件未变」,不只看 error
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outsideDir, { recursive: true, force: true }); }
  });

  it("512KB 超限拒", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fw-"));
    try {
      await withGateway(dir, async (send, waitType) => {
        send({ type: "file.write", path: "big.txt", content: "x".repeat(512 * 1024 + 1) });
        const e = await waitType("error");
        expect(e.code).toBe("file-write-denied");
        expect(String(e.message)).toContain("过大");
      });
      expect(existsSync(join(dir, "big.txt"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("新文件父目录不存在→报错(不隐式建目录)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fw-"));
    try {
      await withGateway(dir, async (send, waitType) => {
        send({ type: "file.write", path: "no/such/dir/a.txt", content: "x" });
        const e = await waitType("error");
        expect(e.code).toBe("file-write-denied");
      });
      expect(existsSync(join(dir, "no"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// 覆盖 dirname join 语义自检:dir 下相对路径父目录解析不逃逸(同强度参照)。
describe("file.write 路径形态自检", () => {
  it("normalize 后的 ./ 与子段 ../ 形态仍落在仓内或被拒", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fw-"));
    try {
      await withGateway(dir, async (send, waitType) => {
        send({ type: "file.write", path: "./sub/../ok.txt", content: "v" });
        const r = await waitType("file.write.result");
        expect(r.ok).toBe(true);
        expect(existsSync(join(dir, "ok.txt"))).toBe(true);

        send({ type: "file.write", path: "sub/../../escape.txt", content: "v" });
        const e = await waitType("error");
        expect(e.code).toBe("file-write-denied");
        expect(existsSync(join(dirname(dir), "escape.txt"))).toBe(false);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(join(dirname(dir), "escape.txt"), { force: true }); }
  });
});
