/**
 * 端到端(WS 全链):echo 后端 + 脚本化 LLM 驱动一轮 read/write/edit 任务——
 * project.add(临时项目根)→ task.submit(projectId)→ 主 loop 依次调 write_file/read_file/edit_file →
 * done;journal 断言三对 tool.call/tool.result 齐全、文件真实落盘、file.write 权限规则全链命中
 * (env 规则 → loop 闸门 → file.write 类别别名 → 放行)。
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";

// env 互斥(2026-10-20):threads pool 共享 process.env,动 GENIE_PERMISSION_RULES 等进程级开关的
// 测试文件必须串行,否则并行文件互相拆 env=间歇假红。
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
beforeAll(async () => { await acquireEnvLock("file-tools-e2e"); }, 240_000); // 等锁可能长(hook 默认 10s 会假红)
afterAll(() => { releaseEnvLock("file-tools-e2e"); });

process.env.GENIE_CHECKPOINT = "off"; // 临时目录跑 git 快照超 5s(2026-10-14 全量套件实测),e2e 关闭
process.env.GENIE_SENSE_ORIENT = "off"; // 开工 orient 不吃脚本化 LLM 步数
process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "file.write", pattern: "*", action: "allow" }]);

let app: GatewayApp | null = null;
afterEach(async () => { await app?.close(); app = null; delete process.env.GENIE_PERMISSION_RULES; });

describe("文件工具端到端(echo 后端 + 脚本化 LLM,WS 全链)", () => {
  it("write_file → read_file → edit_file 一轮完成,journal 三对工具事件齐全,文件真实落盘", async () => {
    const projDir = mkdtempSync(join(tmpdir(), "gh-filetools-e2e-"));
    try {
      // 脚本化 LLM:四个 step——写/读/编/收口
      let phase = 0;
      app = createGatewayApp({
      config: { agent: { planGate: "off" } }, // 文件链测试与规划闸无关,显式关(闸门行为由 plan-gate.test 覆盖)
        port: 7799,
        llm: {
          async chat() {
            phase++;
            if (phase === 1) return { content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: "notes/alpha.md", content: "line1\nline2\n" }) }] };
            if (phase === 2) return { content: "", toolCalls: [{ id: "r1", name: "read_file", arguments: JSON.stringify({ path: "notes/alpha.md" }) }] };
            if (phase === 3) return { content: "", toolCalls: [{ id: "e1", name: "edit_file", arguments: JSON.stringify({ path: "notes/alpha.md", old_string: "line2", new_string: "line2-edited" }) }] };
            return { content: "文件工具链完成:已创建并编辑 notes/alpha.md" };
          },
        } as never,
        executor: new EchoChildBackend(),
      });
      const ws = new WebSocket("ws://127.0.0.1:7799");
      const inbox: Record<string, unknown>[] = [];
      ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
      await new Promise((r) => ws.on("open", r));
      const wait = (pred: (m: Record<string, unknown>) => boolean, ms = 30000) => {
        let cursor = inbox.length;
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("等待消息超时")), ms);
          const poll = setInterval(() => {
            const hit = inbox.slice(cursor).find(pred);
            if (hit) { clearTimeout(t); clearInterval(poll); resolve(hit); }
          }, 50);
        });
      };

      // 临时项目入库(任务根=项目根,文件工具围栏跟随)
      ws.send(JSON.stringify({ v: 1, type: "project.add", path: projDir }));
      const list = await wait((m) => m.type === "project.list.result" && Array.isArray(m.projects) && (m.projects as { path?: string }[]).some((p) => p.path === projDir)) as { projects: { id: string; path: string }[] };
      const proj = list.projects.find((p) => p.path === projDir)!;
      ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "ft-e2e-1", instruction: "建一个 alpha.md 并编辑它", projectId: proj.id }));

      // 等 done(轮询化)
      await wait((m) => m.type === "task.changed" && (m.task as { state?: string }).state === "done");
      ws.close();

      // 文件真实落盘且编辑生效
      const target = join(projDir, "notes", "alpha.md");
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf-8")).toBe("line1\nline2-edited\n");

      // journal:三对 tool.call/tool.result 齐全且按序;工具结果内容可查
      const events = app.journal.readAll().filter((e) => e.sessionId === "ft-e2e-1");
      const calls = events.filter((e) => e.kind === "tool.call").map((e) => e.payload as { name: string; toolCallId: string });
      const results = events.filter((e) => e.kind === "tool.result").map((e) => e.payload as { toolCallId: string; name: string; content: string });
      expect(calls.map((c) => c.name)).toEqual(["write_file", "read_file", "edit_file"]);
      expect(results.map((r) => r.name)).toEqual(["write_file", "read_file", "edit_file"]);
      const byCall = new Map(calls.map((c) => [c.toolCallId, c.name]));
      for (const r of results) expect(byCall.get(r.toolCallId)).toBe(r.name); // call/result 配对
      expect(results[0]!.content).toContain("已创建");
      expect(results[1]!.content).toContain("     1\tline1");
      expect(results[2]!.content).toContain("替换 1 处");
      // 权限规则全链命中:env file.write allow 规则放行三连(loop 闸门无拒事件)
      expect(events.filter((e) => e.kind === "permission.gate" && (e.payload as { effect?: string }).effect === "denied")).toEqual([]);
      } finally {
        rmSync(projDir, { recursive: true, force: true });
      }
  }, 45000);
});
