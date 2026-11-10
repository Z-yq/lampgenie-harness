/**
 * 读传递 gateway 集成锚( D3:跨 agent 读重叠 17.5% 治理):
 * ①子 read_file 尾注:命中父已读行段交叠 → 结果尾部「已读提示」;不交叠/无父键零尾注;
 * ②双写登记:子读经父键入父清单(兄弟子代理共享已读事实),路径=roots 相对(与主 agent 同键);
 * ③真链 spawn:主 agent 先 read_file 再 spawn → 任务书含父已读块、subagent.spawn payload 带
 *   readHandoff{files,chars};GENIE_READ_HANDOFF=off 全关(零注入零字段)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { llmLoopReadOnlyTools } from "../src/llm-loop-backend";
import { clearReadFiles, readFilesOf, recordFileRead } from "@lampgenie/runtime/agent/read-file-state";
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";

const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "rh-gw-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sessions: string[] = [];
const sid = () => { const s = `rh-gw-${Math.random().toString(36).slice(2)}`; sessions.push(s); return s; };
afterEach(() => { for (const s of sessions.splice(0)) clearReadFiles(s); });

describe("子 read_file 尾注与双写(llmLoopReadOnlyTools 直测)", () => {
  beforeEach(() => {
    const d = mk();
    writeFileSync(join(d, "probe.ts"), Array.from({ length: 300 }, (_, i) => `line${i + 1}`).join("\n"), "utf-8");
  });

  it("命中父已读行段交叠 → 尾注「已读提示」", async () => {
    const root = dirs[dirs.length - 1];
    const parent = sid();
    const child = sid();
    recordFileRead(parent, "probe.ts", 1000, 1, [{ off: 1, end: 100 }]);
    const tool = llmLoopReadOnlyTools([root], new Map(), { value: child }, parent).find((t) => t.name === "read_file")!;
    const r = String(await tool.execute({ path: join(root, "probe.ts"), offset: 50, limit: 30 }));
    expect(r).toContain("(已读提示:probe.ts 行段 1-100");
    expect(r).toContain("勿再整读");
  });

  it("不交叠/无父键 → 零尾注;子读双写父键(相对路径同键)", async () => {
    const root = dirs[dirs.length - 1];
    const parent = sid();
    const child = sid();
    recordFileRead(parent, "probe.ts", 1000, 1, [{ off: 1, end: 20 }]);
    const tool = llmLoopReadOnlyTools([root], new Map(), { value: child }, parent).find((t) => t.name === "read_file")!;
    const r = String(await tool.execute({ path: join(root, "probe.ts"), offset: 200, limit: 10 }));
    expect(r).not.toContain("已读提示");
    // 双写:父键清单出现该相对路径,行段含本次窗口 200-209(与父已读 1-20 合并)
    const pe = readFilesOf(parent).find((e) => e.path === "probe.ts");
    expect(pe?.ranges).toEqual([{ off: 1, end: 20 }, { off: 200, end: 209 }]);
    // 子清单(相对路径,不再登记绝对路径)
    expect(readFilesOf(child).some((e) => e.path === "probe.ts")).toBe(true);
    expect(readFilesOf(child).some((e) => e.path.includes(root))).toBe(false);
  });
});

// 真链集成:createGatewayApp + echo executor(范式同 spawn-tool-policy.test.ts)。
// env 互斥:动 GENIE_READ_HANDOFF/GENIE_REPO_ROOT,必须持锁串行。
describe("真链 spawn 读传递(instructions 注入 + payload.readHandoff 留痕)", () => {
  it("主 agent 先读再派 → 任务书含父已读块;off=零注入", async () => {
    await acquireEnvLock("read-handoff", 240_000);
    const realRoot = process.env.GENIE_REPO_ROOT;
    const realRules = process.env.GENIE_PERMISSION_RULES;
    const realOrient = process.env.GENIE_SENSE_ORIENT;
    const realHandoff = process.env.GENIE_READ_HANDOFF;
    try {
      const { createGatewayApp } = await import("../src/app.js");
      const { buildExecutorFromConfig } = await import("../src/factory.js");
      const run = async (sessionId: string, off: boolean) => {
        const repo = mk();
        const journalDir = mk();
        mkdirSync(join(repo, "src"), { recursive: true });
        writeFileSync(join(repo, "src", "probe.ts"), Array.from({ length: 50 }, (_, i) => `export const v${i} = ${i};`).join("\n"), "utf-8");
        process.env.GENIE_REPO_ROOT = repo;
        process.env.GENIE_SENSE_ORIENT = "off";
        process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
        if (off) process.env.GENIE_READ_HANDOFF = "off"; else delete process.env.GENIE_READ_HANDOFF;
        let step = 0;
        const app = createGatewayApp({
          port: 0, journalDir, useExternalHttp: true,
          executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
          llm: {
            async chat(m: unknown) {
              const s = JSON.stringify(m);
              if (s.includes("【任务书】")) return { content: "子任务完成" };
              step++;
              if (step === 1) return { content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "src/probe.ts" }) }] };
              if (step === 2) return { content: "", toolCalls: [{ id: "c2", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "调查 probe.ts", agentType: "explore" }) }] };
              return { content: "主线完成" };
            },
          } as never,
        });
        app.taskManager.submit("user", sessionId, "读文件后派子代理探针");
        for (let i = 0; i < 200; i++) {
          const t = app.taskManager.list().find((x) => x.sessionId === sessionId);
          if (t && (t.state === "done" || t.state === "failed")) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const spawn = app.journal.readAll().find((e) => e.kind === "subagent.spawn") as
          { payload: { instructions?: string; readHandoff?: { files: number; chars: number } } } | undefined;
        await app.close();
        return spawn?.payload;
      };
      const on = await run("rh-on-1", false);
      expect(on?.instructions).toContain("<父会话已读提示>");
      expect(on?.instructions).toContain("src/probe.ts:行段");
      expect(on?.readHandoff).toMatchObject({ files: 1 });
      expect((on?.readHandoff?.chars ?? 0)).toBeGreaterThan(0);
      const offRun = await run("rh-off-1", true);
      expect(offRun?.instructions).not.toContain("<父会话已读提示>");
      expect(offRun?.readHandoff).toBeUndefined();
    } finally {
      if (realRoot === undefined) delete process.env.GENIE_REPO_ROOT; else process.env.GENIE_REPO_ROOT = realRoot;
      if (realRules === undefined) delete process.env.GENIE_PERMISSION_RULES; else process.env.GENIE_PERMISSION_RULES = realRules;
      if (realOrient === undefined) delete process.env.GENIE_SENSE_ORIENT; else process.env.GENIE_SENSE_ORIENT = realOrient;
      if (realHandoff === undefined) delete process.env.GENIE_READ_HANDOFF; else process.env.GENIE_READ_HANDOFF = realHandoff;
      releaseEnvLock("read-handoff");
    }
  }, 180_000);
});
