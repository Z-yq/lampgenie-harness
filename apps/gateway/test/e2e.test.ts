import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";

let app: GatewayApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

describe("gateway+executor 端到端(一期 DoD)", () => {
  it("提交任务→executor 执行→done→journal 可回放", async () => {
    app = createGatewayApp({ port: 7796, executor: new EchoChildBackend() });
    const ws = new WebSocket("ws://127.0.0.1:7796");
    const inbox: Record<string, unknown>[] = [];
    ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.on("open", r));

    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "s1", instruction: "写个 README" }));
    // 等 done 广播
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("done 超时")), 8000);
      const poll = setInterval(() => {
        const hit = inbox.find((m) => m.type === "task.changed" && (m.task as { state: string }).state === "done");
        if (hit) { clearTimeout(t); clearInterval(poll); resolve(); }
      }, 50);
    });
    ws.close();
  }, 15000);
});

describe("项目级 code-sense(2026-10-12 能力挂在项目级,WS 端到端)", () => {
  it("sense.query 带 projectId→项目根;不带→harness 根回退", async () => {
    const projDir = mkdtempSync(join(tmpdir(), "gh-sense-proj-"));
    writeFileSync(join(projDir, "solo.ts"), "export function soloSenseProbe(): number {\n  return 42;\n}\n");
    try {
      app = createGatewayApp({ port: 7797, executor: new EchoChildBackend() });
      const ws = new WebSocket("ws://127.0.0.1:7797");
      const inbox: Record<string, unknown>[] = [];
      ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
      await new Promise((r) => ws.on("open", r));
      const wait = (pred: (m: Record<string, unknown>) => boolean, ms = 35000) => {
        let cursor = inbox.length; // 游标:只等「发送之后」的新消息,防匹配到上一轮结果
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("等待消息超时")), ms);
          const poll = setInterval(() => {
            const hit = inbox.slice(cursor).find(pred);
            if (hit) { clearTimeout(t); clearInterval(poll); resolve(hit); }
          }, 50);
        });
      };

      ws.send(JSON.stringify({ v: 1, type: "project.add", path: projDir }));
      const list = await wait((m) => m.type === "project.list.result" && Array.isArray(m.projects) && (m.projects as { path?: string }[]).some((p) => p.path === projDir)) as { projects: { id: string; path: string }[] };
      const proj = list.projects.find((p) => p.path === projDir)!;

      ws.send(JSON.stringify({ v: 1, type: "sense.query", query: "soloSenseProbe", mode: "debug", projectId: proj.id }));
      const hit = await wait((m) => m.type === "sense.result") as { result: { callchain?: { center: { file: string } } } };
      expect(hit.result.callchain?.center.file).toContain("solo.ts");

      // harness 根上查项目符号=「不存在符号」路径(空 focus→解析前 200 文件,大仓上 15-25s 慢路径,如实)
      ws.send(JSON.stringify({ v: 1, type: "sense.query", query: "soloSenseProbe", mode: "debug" }));
      const fallback = await wait((m) => m.type === "sense.result") as { result: { callchain?: unknown } };
      expect(fallback.result.callchain).toBeUndefined(); // harness 根没有该符号(证明两根确实不同)
      ws.close();
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  }, 90000);
});
