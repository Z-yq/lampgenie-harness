/**
 * 面板 IDE 第二批:lsp.diagnostics(问题面板)后端单测。
 * 语义:paths=项目内相对路径;仅 .ts/.tsx/.js/.jsx/.mts/.cts 参与诊断(其它扩展名静默跳过);
 * severity 只回 error/warning;line/col 1-based;paths 上限 32。
 * 检查器与 agent 编辑链同源(harness-lsp checkEditedFile;format 关闭=不落盘)。
 *
 * 测试基建纪律(与 ide-fs.test.ts 同款):端口 listen(0) 真实绑定;waitType 消费式;
 * server/http 关闭全进 finally。LSP/TS 兜底冷启动秒级 → 用例显式放宽 vitest 超时。
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import type { ProjectRegistry } from "../src/projects.js";

// 钉死检查器=TS 编译器兜底(与 lsp-edit-checks.test.ts 同款):环境装了 typescript-language-server
// 也不走 LSP 路径,code 形态稳定为 TS####,断言确定性。
const ORIGINAL_TS = process.env.GENIE_LSP_TYPESCRIPT_COMMAND;
process.env.GENIE_LSP_TYPESCRIPT_COMMAND = "/nonexistent/typescript-language-server";
afterAll(() => { if (ORIGINAL_TS === undefined) delete process.env.GENIE_LSP_TYPESCRIPT_COMMAND; else process.env.GENIE_LSP_TYPESCRIPT_COMMAND = ORIGINAL_TS; });

function stubFor(dir: string): ProjectRegistry {
  return { activeId: () => "p1", resolveWorkdir: () => dir, list: () => [] } as unknown as ProjectRegistry;
}

async function withGateway(dir: string, fn: (send: (o: object) => void, waitType: (t: string) => Promise<Record<string, unknown>>, inbox: () => Record<string, unknown>[]) => Promise<void>) {
  const httpServer = createServer();
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = (httpServer.address() as { port: number }).port;
  const srv = startGatewayServer({ port, server: httpServer, taskManager: new TaskSupervisor(), journal: new MemoryJournal(), projects: stubFor(dir) });
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
  try { await fn(send, waitType, () => box); } finally {
    try { ws.close(); } catch { /* 已断开容忍 */ }
    await srv.close();
    await new Promise<void>((r) => { httpServer.close(() => r()); httpServer.closeAllConnections?.(); });
  }
}

describe("lsp.diagnostics(问题面板)", () => {
  it("临时 .ts 含类型错误 → 回包含 line/severity/message(1-based)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-lsp-"));
    try {
      // 第 1 行故意放一个合法语句垫位,断言 1-based 行号不是从 0 起。
      writeFileSync(join(dir, "broken.ts"), "const pad = 1;\nconst n: number = \"x\";\n", "utf-8");
      await withGateway(dir, async (send, waitType) => {
        send({ type: "lsp.diagnostics", requestId: "r1", paths: ["broken.ts"] });
        const r = await waitType("lsp.diagnostics.result");
        expect(r.requestId).toBe("r1");
        const diags = r.diagnostics as { path: string; line: number; col: number; severity: string; message: string; code?: string }[];
        expect(diags.length).toBeGreaterThan(0);
        const first = diags[0]!;
        expect(first.path).toBe("broken.ts");
        expect(first.severity).toBe("error");
        expect(first.line).toBe(2); // 1-based:错误在第 2 行
        expect(first.col).toBeGreaterThan(0);
        expect(first.message.length).toBeGreaterThan(0);
        expect(String(first.code ?? "")).toMatch(/^TS/);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);

  it(".md 路径静默跳过:不出现在结果也不回 error 帧", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-lsp-"));
    try {
      writeFileSync(join(dir, "notes.md"), "# title\n正文\n", "utf-8");
      writeFileSync(join(dir, "broken.ts"), "const n: number = \"x\";\n", "utf-8");
      await withGateway(dir, async (send, waitType, inbox) => {
        send({ type: "lsp.diagnostics", requestId: "r2", paths: ["notes.md", "broken.ts"] });
        const r = await waitType("lsp.diagnostics.result");
        expect(r.requestId).toBe("r2");
        const diags = r.diagnostics as { path: string }[];
        expect(diags.length).toBeGreaterThan(0);
        expect(diags.every((d) => d.path !== "notes.md")).toBe(true); // .md 不出现
        expect(inbox().some((x) => x.type === "error")).toBe(false); // 不报错
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);

  it("paths 超 32 上限 → error(bad-request)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-lsp-"));
    try {
      await withGateway(dir, async (send, waitType) => {
        send({ type: "lsp.diagnostics", requestId: "r3", paths: Array.from({ length: 33 }, (_, i) => `f${i}.ts`) });
        const r = await waitType("error");
        expect(r.code).toBe("bad-request");
        expect(String(r.message)).toContain("32");
        expect(String(r.message)).toContain("r3"); // requestId 归因
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);
});
