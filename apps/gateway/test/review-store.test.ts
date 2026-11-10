/**
 * review.store.get(评审遗留店消费,2026-10-13 遗留3):WS 往返——
 * 预置店 fixture → 项目注册 → review.store.get → open/resolved 分桶;空店=双空数组。
 */
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";

let app: GatewayApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

// 随机高位端口(step-083):固定 7801/7802 与并发会话在跑实例相撞(2026-10-16 实锤:step-082 的
// serve 占 7802,WS 连到外来服务→resolveWorkdir 回退根→root 店 6 条假阳性)。同 session-fork 模式;
// 段取 24000+(避开仓内 18000-19499 测试惯例段——并发会话 vitest 同段跑会互撞)。
const PORT_A = 24000 + Math.floor(Math.random() * 2000);
const PORT_B = PORT_A + 1;

describe("review.store.get", () => {
  it("open/resolved 分桶;字段原样透传", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-revstore-"));
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    mkdirSync(join(dir, ".genie"), { recursive: true });
    writeFileSync(join(dir, ".genie", "review-comments.json"), JSON.stringify({ version: 1, updatedAt: 9, comments: [
      { key: "k-open", path: "a.ts", line: 1, rule: "bug", message: "开放发现", severity: "blocker", postedAt: 1, repostCount: 3 },
      { key: "k-res", path: "a.ts", line: 2, message: "已解决发现", severity: "nit", postedAt: 1, resolvedAt: 5 },
    ] }));
    try {
      app = createGatewayApp({ port: PORT_A, executor: new EchoChildBackend() });
      const proj = app.projects.add(dir);
      if (!proj.ok) throw new Error("项目注册失败: " + proj.reason);
      const ws = new WebSocket("ws://127.0.0.1:" + PORT_A + "/ws");
      const inbox: Record<string, unknown>[] = [];
      ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
      await new Promise((r) => ws.on("open", r));
      ws.send(JSON.stringify({ v: 1, type: "review.store.get", projectId: proj.project.id }));
      let hit: Record<string, unknown> | null = null;
      for (let i = 0; i < 60 && !hit; i++) {
        await new Promise((r) => setTimeout(r, 50));
        hit = (inbox.find((m) => m.type === "review.store.result") ?? null) as Record<string, unknown> | null;
      }
      expect(hit).toBeTruthy();
      const open = hit!.open as { key: string; message: string; severity: string; repostCount?: number }[];
      const resolved = hit!.resolved as { key: string }[];
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ key: "k-open", severity: "blocker", repostCount: 3 });
      expect(hit!.root).toBe(dir);
      expect(hit!.projectId).toBe(proj.project.id);
      expect(resolved).toHaveLength(1);
      ws.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("无店文件:双空数组(不报错)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-revstore-empty-"));
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    try {
      app = createGatewayApp({ port: PORT_B, executor: new EchoChildBackend() });
      const proj = app.projects.add(dir);
      if (!proj.ok) throw new Error("项目注册失败: " + proj.reason);
      const ws = new WebSocket("ws://127.0.0.1:" + PORT_B + "/ws");
      const inbox: Record<string, unknown>[] = [];
      ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
      await new Promise((r) => ws.on("open", r));
      ws.send(JSON.stringify({ v: 1, type: "review.store.get", projectId: proj.project.id }));
      let hit: Record<string, unknown> | null = null;
      for (let i = 0; i < 60 && !hit; i++) {
        await new Promise((r) => setTimeout(r, 50));
        hit = (inbox.find((m) => m.type === "review.store.result") ?? null) as Record<string, unknown> | null;
      }
      expect(hit).toBeTruthy();
      expect(hit!.open).toEqual([]);
      expect(hit!.resolved).toEqual([]);
      ws.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
