/**
 * IDE 文件操作后端单测:fs.mkdir / fs.remove / fs.rename / fs.grep。
 * 沙箱口径与 file.write 完全一致(realpath 前缀比对 + 拒 .git 段 + 拒 ../ 越界);
 * 失败走回包式 fs.*.result { ok:false, error }(非 error 帧),面板据此 toast 且不刷新树。
 * 测试基建纪律(与 file-write-sandbox.test.ts 同款):
 * - 端口:http listen(0) 真实绑定取空闲口(不硬编码,合跑/并行零 EADDRINUSE);
 * - waitType 消费式(命中即从 inbox 移除),同 type 多次请求各取各的响应;
 * - server/http 关闭全部进 finally,断言失败/超时也不泄漏进程占口。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
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

describe("fs.mkdir / fs.remove / fs.rename 沙箱与语义", () => {
  it("mkdir 成功:目录真实存在且回包 ok:true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fsop-"));
    try {
      await withGateway(dir, async (send, waitType) => {
        send({ type: "fs.mkdir", path: "docs" });
        const r = await waitType("fs.mkdir.result");
        expect(r.ok).toBe(true);
        expect(r.path).toBe("docs");
        expect(existsSync(join(dir, "docs"))).toBe(true);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("mkdir 越界(../../)被拒且仓外目录未创建", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fsop-"));
    const outside = join(dir, "..", "gw-fsop-evil-dir");
    try {
      await withGateway(dir, async (send, waitType) => {
        send({ type: "fs.mkdir", path: "../../gw-fsop-evil-dir" });
        const r = await waitType("fs.mkdir.result");
        expect(r.ok).toBe(false);
        expect(String(r.error)).toContain("越界");
      });
      expect(existsSync(outside)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  it("mkdir 建 .git 被拒(保护段)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fsop-"));
    try {
      await withGateway(dir, async (send, waitType) => {
        send({ type: "fs.mkdir", path: ".git" });
        const r = await waitType("fs.mkdir.result");
        expect(r.ok).toBe(false);
        expect(String(r.error)).toContain(".git");
        send({ type: "fs.mkdir", path: "sub/.git" });
        const r2 = await waitType("fs.mkdir.result");
        expect(r2.ok).toBe(false);
      });
      expect(existsSync(join(dir, ".git"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rename 成功:源消失、目标存在且内容不变", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fsop-"));
    try {
      writeFileSync(join(dir, "old.txt"), "内容 payload", "utf-8");
      await withGateway(dir, async (send, waitType) => {
        send({ type: "fs.rename", from: "old.txt", to: "new.txt" });
        const r = await waitType("fs.rename.result");
        expect(r.ok).toBe(true);
        expect(r.from).toBe("old.txt");
        expect(r.to).toBe("new.txt");
      });
      expect(existsSync(join(dir, "old.txt"))).toBe(false);
      expect(readFileSync(join(dir, "new.txt"), "utf-8")).toBe("内容 payload");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rename 源不存在 / 目标已存在 均被拒且不改动文件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fsop-"));
    try {
      writeFileSync(join(dir, "a.txt"), "A", "utf-8");
      writeFileSync(join(dir, "b.txt"), "B", "utf-8");
      await withGateway(dir, async (send, waitType) => {
        send({ type: "fs.rename", from: "missing.txt", to: "x.txt" });
        const e1 = await waitType("fs.rename.result");
        expect(e1.ok).toBe(false);
        expect(String(e1.error)).toContain("源不存在");

        send({ type: "fs.rename", from: "a.txt", to: "b.txt" });
        const e2 = await waitType("fs.rename.result");
        expect(e2.ok).toBe(false);
        expect(String(e2.error)).toContain("已存在");
      });
      expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("A"); // 负面断言:两个文件都没被改
      expect(readFileSync(join(dir, "b.txt"), "utf-8")).toBe("B");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("remove 非空目录未传 recursive → 拒绝,目录与内容保留", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fsop-"));
    try {
      mkdirSync(join(dir, "keep"), { recursive: true });
      writeFileSync(join(dir, "keep", "inner.txt"), "inner", "utf-8");
      await withGateway(dir, async (send, waitType) => {
        send({ type: "fs.remove", path: "keep" });
        const r = await waitType("fs.remove.result");
        expect(r.ok).toBe(false);
        expect(String(r.error)).toContain("recursive");
      });
      expect(existsSync(join(dir, "keep", "inner.txt"))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("remove 非空目录传 recursive → 成功递归删除", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fsop-"));
    try {
      mkdirSync(join(dir, "gone", "deep"), { recursive: true });
      writeFileSync(join(dir, "gone", "deep", "x.txt"), "x", "utf-8");
      await withGateway(dir, async (send, waitType) => {
        send({ type: "fs.remove", path: "gone", recursive: true });
        const r = await waitType("fs.remove.result");
        expect(r.ok).toBe(true);
      });
      expect(existsSync(join(dir, "gone"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("remove 单文件与空目录成功;删 .git / 项目根被拒", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-fsop-"));
    try {
      writeFileSync(join(dir, "f.txt"), "f", "utf-8");
      mkdirSync(join(dir, "emptydir"));
      mkdirSync(join(dir, ".git"));
      await withGateway(dir, async (send, waitType) => {
        send({ type: "fs.remove", path: "f.txt" });
        expect((await waitType("fs.remove.result")).ok).toBe(true);
        send({ type: "fs.remove", path: "emptydir" });
        expect((await waitType("fs.remove.result")).ok).toBe(true);

        send({ type: "fs.remove", path: ".git" });
        const g = await waitType("fs.remove.result");
        expect(g.ok).toBe(false);
        expect(String(g.error)).toContain(".git");

        send({ type: "fs.remove", path: ".", recursive: true });
        const root = await waitType("fs.remove.result");
        expect(root.ok).toBe(false);
      });
      expect(existsSync(join(dir, "f.txt"))).toBe(false);
      expect(existsSync(join(dir, ".git"))).toBe(true); // 受保护段仍在
      expect(existsSync(dir)).toBe(true);               // 项目根未被删
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("fs.grep 内容搜索", () => {
  it("命中行号与整行文本正确,跳过 node_modules/.git/dist/.genie", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-grep-"));
    try {
      writeFileSync(join(dir, "a.ts"), "const alpha = 1;\nconst target = 2;\n// target again\n", "utf-8");
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "sub", "b.txt"), "nothing\nTARGET here\n", "utf-8");
      // 三个必跳目录:命中文本必须只来自仓内真源文件
      for (const skip of ["node_modules", "dist", ".git", ".genie"]) {
        mkdirSync(join(dir, skip), { recursive: true });
        writeFileSync(join(dir, skip, "skip.txt"), "target should not be found\n", "utf-8");
      }
      await withGateway(dir, async (send, waitType) => {
        send({ type: "fs.grep", query: "target" });
        const r = await waitType("fs.grep.result");
        expect(r.error).toBeUndefined();
        const matches = r.matches as { path: string; line: number; text: string }[];
        // 大小写不敏感:命中 a.ts 第 2/3 行 + sub/b.txt 第 2 行
        const paths = [...new Set(matches.map((m) => m.path))].sort();
        expect(paths).toEqual(["a.ts", "sub/b.txt"]);
        const a = matches.filter((m) => m.path === "a.ts");
        expect(a.map((m) => m.line)).toEqual([2, 3]);
        expect(a[0].text).toBe("const target = 2;");
        expect(a[1].text).toBe("// target again");
        const b = matches.filter((m) => m.path === "sub/b.txt");
        expect(b.length).toBe(1);
        expect(b[0].line).toBe(2);
        expect(b[0].text).toBe("TARGET here");
        // 跳过目录零命中
        expect(matches.some((m) => /node_modules|dist|\.git|\.genie/.test(m.path))).toBe(false);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("regex 模式生效;非法正则回 error 且 matches 为空", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-grep-"));
    try {
      writeFileSync(join(dir, "r.txt"), "id=42\nid=abc\n", "utf-8");
      await withGateway(dir, async (send, waitType) => {
        send({ type: "fs.grep", query: "id=\\d+", regex: true });
        const r = await waitType("fs.grep.result");
        const matches = r.matches as { path: string; line: number }[];
        expect(matches.length).toBe(1);
        expect(matches[0].line).toBe(1);

        send({ type: "fs.grep", query: "([unclosed", regex: true });
        const bad = await waitType("fs.grep.result");
        expect(String(bad.error)).toContain("正则非法");
        expect((bad.matches as unknown[]).length).toBe(0);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("maxResults 截断:回 truncated:true 且条数不超过上限", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-grep-"));
    try {
      writeFileSync(join(dir, "many.txt"), Array.from({ length: 30 }, () => "hit line").join("\n"), "utf-8");
      await withGateway(dir, async (send, waitType) => {
        send({ type: "fs.grep", query: "hit", maxResults: 5 });
        const r = await waitType("fs.grep.result");
        expect((r.matches as unknown[]).length).toBe(5);
        expect(r.truncated).toBe(true);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("越界搜索起点被拒(../ 与绝对路径)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-grep-"));
    try {
      await withGateway(dir, async (send, waitType) => {
        send({ type: "fs.grep", query: "x", path: "../" });
        const r = await waitType("fs.grep.result");
        expect(String(r.error)).toContain("越界");
        send({ type: "fs.grep", query: "x", path: "/etc" });
        const r2 = await waitType("fs.grep.result");
        expect(String(r2.error)).toContain("越界");
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
