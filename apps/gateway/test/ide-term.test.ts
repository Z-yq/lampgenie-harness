/**
 * 面板 IDE 第二批:term.session.*(持久终端)+ git.show(文件历史内容)后端单测。
 * 语义:owner="panel:<连接标识>";open(cwd 项目内 realpath 校验)→ send(写入即返回)→
 * read(cursor 增量)→ close;WS 断开回收该 owner 全部会话(审计事件观测)。
 * git.show:HEAD 内容正确;未跟踪文件回 error。
 * 测试基建纪律(与 ide-fs.test.ts 同款):端口 listen(0);waitType 消费式;
 * server/http 关闭全进 finally。PTY/进程 spawn 在 9p 盘秒级 → 用例显式放宽超时。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import type { ProjectRegistry } from "../src/projects.js";

function stubFor(dir: string): ProjectRegistry {
  return { activeId: () => "p1", resolveWorkdir: () => dir, list: () => [] } as unknown as ProjectRegistry;
}

async function withGateway(
  dir: string,
  fn: (ctx: {
    send: (o: object) => void;
    waitType: (t: string) => Promise<Record<string, unknown>>;
    ws: WebSocket;
    journal: MemoryJournal;
  }) => Promise<void>,
) {
  const httpServer = createServer();
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = (httpServer.address() as { port: number }).port;
  const journal = new MemoryJournal();
  const srv = startGatewayServer({ port, server: httpServer, taskManager: new TaskSupervisor(), journal, projects: stubFor(dir) });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const box: Record<string, unknown>[] = [];
  ws.on("message", (r) => box.push(JSON.parse(r.toString()) as Record<string, unknown>));
  await new Promise((r) => ws.on("open", r));
  const send = (o: object) => ws.send(JSON.stringify({ v: 1, ...o }));
  const waitType = (t: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${t} 超时`)), 20_000);
      const p = setInterval(() => {
        const i = box.findIndex((x) => x.type === t);
        if (i >= 0) { clearTimeout(timer); clearInterval(p); resolve(box.splice(i, 1)[0]); }
      }, 25);
    });
  try { await fn({ send, waitType, ws, journal }); } finally {
    try { ws.close(); } catch { /* 已断开容忍 */ }
    await srv.close();
    await new Promise<void>((r) => { httpServer.close(() => r()); httpServer.closeAllConnections?.(); });
  }
}

/** read 轮询直到输出含目标串(上限 ~15s);超时抛错带上已收到的输出便于诊断。 */
async function pollRead(send: (o: object) => void, waitType: (t: string) => Promise<Record<string, unknown>>, sessionId: string, needle: string, requestId: string): Promise<void> {
  let got = "";
  for (let i = 0; i < 40; i++) {
    send({ type: "term.session.read", requestId, sessionId });
    const r = await waitType("term.session.read.result");
    got += String(r.data ?? "");
    if (got.includes(needle)) return;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`read 轮询超时未见 ${needle};已收到:${got.slice(-500)}`);
}

function gitInitWithCommit(dir: string, file: string, content: string) {
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  writeFileSync(join(dir, file), content, "utf-8");
  git(["add", file]);
  git(["-c", "user.email=panel@test.local", "-c", "user.name=panel-test", "commit", "-q", "-m", "init"]);
}

describe("term.session.*(持久终端)", () => {
  it("open → send(echo i2-term-probe)→ read 轮询到输出 → close 全链", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-term-"));
    try {
      await withGateway(dir, async ({ send, waitType }) => {
        send({ type: "term.session.open", requestId: "t-open" });
        const open = await waitType("term.session.open.result");
        expect(open.requestId).toBe("t-open");
        const sessionId = String(open.sessionId);
        expect(sessionId.length).toBeGreaterThan(0);

        send({ type: "term.session.send", requestId: "t-send", sessionId, data: "echo i2-term-probe\n" });
        const sent = await waitType("term.session.send.result");
        expect(sent.requestId).toBe("t-send");
        await pollRead(send, waitType, sessionId, "i2-term-probe", "t-read"); // shell 回显/输出含探针串

        send({ type: "term.session.close", requestId: "t-close", sessionId });
        const closed = await waitType("term.session.close.result");
        expect(closed.requestId).toBe("t-close");

        send({ type: "term.session.read", requestId: "t-after", sessionId });
        const err = await waitType("error"); // close 后会话已回收,read 报错
        expect(String(err.message)).toContain("t-after");
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it("cwd 越界(../)拒绝开终端", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-term-"));
    try {
      await withGateway(dir, async ({ send, waitType }) => {
        send({ type: "term.session.open", requestId: "t-evil", cwd: "../../tmp" });
        const r = await waitType("error");
        expect(String(r.message)).toContain("越界");
        expect(String(r.message)).toContain("t-evil");
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("WS 断开回收该 owner 全部会话(审计 close 事件 reason=panel-disconnect)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-term-"));
    try {
      await withGateway(dir, async ({ send, waitType, ws, journal }) => {
        send({ type: "term.session.open", requestId: "t-o1" });
        const open = await waitType("term.session.open.result");
        const sid = String(open.sessionId);
        send({ type: "term.session.open", requestId: "t-o2" });
        await waitType("term.session.open.result");
        // 原始断开(不经 finally 的 ws.close() 走同一条 close 事件路径)
        ws.close(1001, "client-gone");
        // 断开回调异步回收:轮询 journal 直到两条 panel-disconnect 审计出现(上限 ~10s)
        for (let i = 0; i < 40; i++) {
          const evts = journal.readAll()
            .map((e) => e.payload as { type?: string; action?: string; sessionId?: string; reason?: string })
            .filter((p) => p?.type === "terminal.audit" && p.action === "close" && p.reason === "panel-disconnect");
          if (evts.length >= 2 && evts.some((e) => e.sessionId === sid)) return;
          await new Promise((res) => setTimeout(res, 250));
        }
        throw new Error("断开后未见 owner 会话回收审计(panel-disconnect)");
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});

describe("git.show(文件历史内容)", () => {
  it("HEAD 内容正确;未跟踪文件回 error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-gitshow-"));
    try {
      gitInitWithCommit(dir, "a.txt", "hello git-show\nline2\n");
      writeFileSync(join(dir, "untracked.txt"), "not committed\n", "utf-8");
      await withGateway(dir, async ({ send, waitType }) => {
        send({ type: "git.show", requestId: "g-1", path: "a.txt" });
        const r = await waitType("git.show.result");
        expect(r.requestId).toBe("g-1");
        expect(String(r.content)).toContain("hello git-show");
        expect(String(r.content)).toContain("line2");

        send({ type: "git.show", requestId: "g-2", path: "untracked.txt" });
        const err = await waitType("error");
        expect(String(err.message)).toContain("g-2"); // requestId 归因
        expect(String(err.message).length).toBeGreaterThan(10);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it("非 git 仓库 → norepo error 降级", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-gitshow-"));
    try {
      await withGateway(dir, async ({ send, waitType }) => {
        send({ type: "git.show", requestId: "g-3", path: "a.txt" });
        const err = await waitType("error");
        expect(err.code).toBe("git-norepo");
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
