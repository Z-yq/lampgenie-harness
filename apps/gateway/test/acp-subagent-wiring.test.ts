/**
 * 接线验证:spawn_subagent(backend="acp") 经 agent-wiring 的最小 branch,
 * 真实驱动 mock ACP adapter(协议级),并验证 journal 记录 ACP 会话 id。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";

// env 互斥:threads pool 共享 process.env,动 GENIE_PERMISSION_RULES 等进程级开关的
// 测试文件必须串行,否则并行文件互相拆 env=间歇假红。
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
beforeAll(async () => { await acquireEnvLock("acp-subagent-wiring"); }, 240_000); // 等锁可能长(hook 默认 10s 会假红)
afterAll(() => { releaseEnvLock("acp-subagent-wiring"); });

const mockAdapter = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/harness-executors/test/fixtures/mock-acp-adapter.mjs");

describe("spawn_subagent ACP 接线", () => {
  it("backend=acp + adapter → ACP 后端真跑;journal 落 backend=acp 与 acp.session", async () => {
    process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
    mkdtempSync(join(tmpdir(), "acp-wire-")); // 触发 tmp 目录存在;workdir 由 harness 注入
    let calls = 0;
    const app = createGatewayApp({
      port: 0,
      llm: {
        async chat() {
          calls += 1;
          if (calls === 1) {
            return {
              content: "",
              toolCalls: [{
                id: "s1",
                name: "spawn_subagent",
                arguments: JSON.stringify({
                  instructions: "读一下 README 并总结",
                  title: "ACP 冒烟",
                  backend: "acp",
                  adapter: JSON.stringify({ cmd: process.execPath, args: [mockAdapter] }),
                  adapterEnv: { MOCK_ACP_MODE: "happy" },
                }),
              }],
            };
          }
          return { content: "ACP 子代理结果已收到" };
        },
      } as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    try {
      app.taskManager.submit("user", "acp-wire-1", "派一个 ACP 子代理读 README");
      let state = "";
      for (let i = 0; i < 100; i += 1) {
        const task = app.taskManager.list().find((x) => x.sessionId === "acp-wire-1");
        state = task?.state ?? "";
        if (state === "done" || state === "failed") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(state).toBe("done");
      const events = app.journal.readAll().filter((e) => e.sessionId === "acp-wire-1");
      const spawn = events.find((e) => e.kind === "subagent.spawn");
      expect((spawn?.payload as { backend?: string }).backend).toBe("acp");
      const acpSession = events.find((e) => e.kind === "subagent.event" && (e.payload as { kind?: string }).kind === "acp.session");
      expect(acpSession, "ACP 会话 id 应落 journal").toBeTruthy();
      expect((acpSession?.payload as { sessionId?: string }).sessionId).toBe("sess-mock-1");
      const result = events.find((e) => e.kind === "subagent.result");
      expect(String((result?.payload as { event?: { finalText?: string } }).event?.finalText ?? "")).toContain("第一段第二段");
    } finally {
      await app.close();
      delete process.env.GENIE_PERMISSION_RULES;
    }
  }, 30_000);

  it("ACP 权限请求走既有 ask 通道:permission-ask → GENIE_SUBAGENT_ASK=allow-once → 应答回流", async () => {
    process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
    process.env.GENIE_SUBAGENT_ASK = "allow-once";
    let calls = 0;
    const app = createGatewayApp({
      port: 0,
      llm: {
        async chat() {
          calls += 1;
          if (calls === 1) {
            return {
              content: "",
              toolCalls: [{
                id: "s2",
                name: "spawn_subagent",
                arguments: JSON.stringify({
                  instructions: "写一个文件(会触发权限请求)",
                  title: "ACP 权限",
                  backend: "acp",
                  adapter: JSON.stringify({ cmd: process.execPath, args: [mockAdapter] }),
                  adapterEnv: { MOCK_ACP_MODE: "permission" },
                }),
              }],
            };
          }
          return { content: "已处理 ACP 权限请求" };
        },
      } as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    try {
      app.taskManager.submit("user", "acp-wire-2", "派一个会申请权限的 ACP 子代理");
      let state = "";
      for (let i = 0; i < 100; i += 1) {
        const task = app.taskManager.list().find((x) => x.sessionId === "acp-wire-2");
        state = task?.state ?? "";
        if (state === "done" || state === "failed") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(state).toBe("done");
      const events = app.journal.readAll().filter((e) => e.sessionId === "acp-wire-2");
      const gates = events.filter((e) => e.kind === "permission.gate").map((e) => e.payload as { effect?: string; by?: string });
      expect(gates.some((g) => g.effect === "asked"), "权限请求应进 ask 通道").toBe(true);
      expect(gates.some((g) => g.effect === "allowed" && String(g.by).includes("env-allow-once")), "应答应回流并落 allowed").toBe(true);
      const result = events.find((e) => e.kind === "subagent.result");
      expect(String((result?.payload as { event?: { finalText?: string } }).event?.finalText ?? "")).toContain("opt-allow");
    } finally {
      await app.close();
      delete process.env.GENIE_PERMISSION_RULES;
      delete process.env.GENIE_SUBAGENT_ASK;
    }
  }, 30_000);
});
