/**
 * `subagent.spawn` 记模型(2026-11「面板上看得见用了什么模型」T1)。
 *
 * 为什么这样测:**行为级**——照 spawn-tool-policy.test.ts 的 journal 级集成锚，
 * createGatewayApp 真链跑一次 spawn_subagent，读 journal 断言 payload.model 落盘。
 * 不能只测源码文本：模型名取的是 `subagentModelNameOf(models?.subagent ?? llm)`
 * (provider 的 modelName getter，热切换后跟新值)，只有真链才能证明「派遣那一刻生效的模型」被写进 journal。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";

// env 互斥：本文件动 GENIE_PERMISSION_RULES/GENIE_REPO_ROOT(进程级)，必须串行。
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
beforeAll(async () => { await acquireEnvLock("subagent-spawn-model"); }, 240_000);
afterAll(() => { releaseEnvLock("subagent-spawn-model"); });

const mk = () => mkdtempSync(join(tmpdir(), "spawnmodel-"));

describe("subagent.spawn payload 含 model(行为级:createGatewayApp 真链)", () => {
  it("派遣时生效的模型名落 journal(会话结束后仍可回溯)", async () => {
    const realRoot = process.env.GENIE_REPO_ROOT;
    const realRules = process.env.GENIE_PERMISSION_RULES;
    const realOrient = process.env.GENIE_SENSE_ORIENT;
    const repo = mk();
    const journalDir = mk();
    try {
      process.env.GENIE_REPO_ROOT = repo;
      process.env.GENIE_SENSE_ORIENT = "off";
      process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
      let spawned = false;
      const llmModel = "openai-compat/gpt-5.1";
      const app = createGatewayApp({
        port: 0,
        journalDir,
        useExternalHttp: true,
        executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
        llm: {
          // provider 的模型名读数源(agent-wiring: subagentModelNameOf(models?.subagent ?? llm))
          modelName: llmModel,
          async chat(m: unknown) {
            const s = JSON.stringify(m);
            if (s.includes("【任务书】")) return { content: "子任务完成" }; // 子 loop 收尾
            if (!spawned) {
              spawned = true;
              return { content: "", toolCalls: [{ id: "c1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "帮我探针", agentType: "explore" }) }] };
            }
            return { content: "主线完成" };
          },
        } as never,
      });
      app.taskManager.submit("user", "s-spawn-model", "探针任务(不包含任务书标记)");
      for (let i = 0; i < 200; i++) {
        const t = app.taskManager.list().find((x) => x.sessionId === "s-spawn-model");
        if (t && (t.state === "done" || t.state === "failed")) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const events = app.journal.readAll()
        .map((e) => e as { kind: string; sessionId: string; payload: Record<string, unknown> })
        .filter((e) => e.kind === "subagent.spawn" && e.sessionId === "s-spawn-model");
      await app.close();
      expect(events.length, "spawn 未落 journal").toBe(1);
      const model = events[0].payload.model;
      expect(typeof model, "payload.model 缺失(会话结束后将无法回溯用了什么模型)").toBe("string");
      expect(model).toBe(llmModel);
      // 取不到模型时不写该键(不是写空串/undefined):模型读数源恒有值,故此处为正向断言另一半
      expect(String(model).length).toBeGreaterThan(0);
    } finally {
      if (realRoot === undefined) delete process.env.GENIE_REPO_ROOT; else process.env.GENIE_REPO_ROOT = realRoot;
      if (realRules === undefined) delete process.env.GENIE_PERMISSION_RULES; else process.env.GENIE_PERMISSION_RULES = realRules;
      if (realOrient === undefined) delete process.env.GENIE_SENSE_ORIENT; else process.env.GENIE_SENSE_ORIENT = realOrient;
    }
  }, 120_000);
});
