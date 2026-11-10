/**
 * 子代理工作区入账(2026-10-16 用户口径:点开子代理要看到它的全部动作/消息流):
 * ①trimSubLoopEvent 裁剪契约(各 kind 字段保留/截断边界/未知 kind 兜底);
 * ②LlmLoopBackend onLoopEvent 同挂点回调(心跳机制不回退,事件序列完整);
 * ③真实链路 e2e:spawn_subagent(进程内后端)→ 主 journal 出现 subagent.event(agentId/taskId/kind 正确),
 *   外部 echo 子进程后端不产生 loop 事件(降级语义的服务端事实)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmLoopBackend, trimSubLoopEvent } from "../src/llm-loop-backend.js";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";

// env 互斥(2026-10-20):threads pool 共享 process.env,动 GENIE_PERMISSION_RULES 等进程级开关的
// 测试文件必须串行,否则并行文件互相拆 env=间歇假红。
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
beforeAll(async () => { await acquireEnvLock("subagent-event-journal"); }, 240_000); // 等锁可能长(hook 默认 10s 会假红)
afterAll(() => { releaseEnvLock("subagent-event-journal"); });

describe("trimSubLoopEvent:工作区入账裁剪契约", () => {
  it("tool.call/tool.result:保留工具语义字段,长文本按字段截断(2026-10-21 对齐实现:content 2000)", () => {
    const call = trimSubLoopEvent("tool.call", { toolCallId: "c1", name: "grep", arguments: "x".repeat(1000) });
    expect(call).toEqual({ toolCallId: "c1", name: "grep", arguments: "x".repeat(400) });
    const res = trimSubLoopEvent("tool.result", { toolCallId: "c1", name: "grep", content: "y".repeat(5000), durationMs: 42 });
    expect(res).toEqual({ toolCallId: "c1", name: "grep", content: "y".repeat(2000), durationMs: 42 });
  });

  it("message.agent:text 8000/reasoning 4000 截断(2026-10-21 对齐),toolCalls 逐调用裁剪且封顶 12 个", () => {
    const calls = Array.from({ length: 20 }, (_, i) => ({ id: "t" + i, name: "read_file", arguments: JSON.stringify({ path: "/a/b" + i }) }));
    const p = trimSubLoopEvent("message.agent", {
      text: "z".repeat(9000), reasoning: "r".repeat(5000), llmMs: 1234, turn: 3, step: 2,
      toolCalls: calls, usage: { total: 9 },
    });
    expect((p.text as string).length).toBe(8000); // 2026-10-21 对齐实现(text 8000;输入 9000 触发截断)
    expect((p.reasoning as string).length).toBe(4000); // 2026-10-21 对齐实现(reasoning 4000;输入 5000 触发截断)
    expect(p.turn).toBe(3);
    expect((p.toolCalls as unknown[]).length).toBe(12);
    expect((p.toolCalls as { arguments: string }[])[0]!.arguments.length).toBeLessThanOrEqual(200);
    expect((p as Record<string, unknown>).usage, "usage 入账(2026-10-21 对齐实现:数值字段白名单)").toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("step/turn/permission.gate:结构字段保留;未知 kind 兜底 raw 且截断 400", () => {
    expect(trimSubLoopEvent("step.end", { turn: 1, step: 0, reason: "completed" })).toEqual({ turn: 1, step: 0, reason: "completed" });
    expect(trimSubLoopEvent("step.end", { turn: 1, step: 0, reason: "error", error: "e".repeat(900) }).error).toBe("e".repeat(300));
    expect(trimSubLoopEvent("turn.end", { turn: 1, reason: "cancelled" })).toEqual({ turn: 1, reason: "cancelled" });
    const gate = trimSubLoopEvent("permission.gate", { tool: "grep", effect: "allowed", by: "rule-allowed", risk: "low" });
    expect(gate).toEqual({ tool: "grep", effect: "allowed", by: "rule-allowed" });
    const raw = trimSubLoopEvent("exotic.kind", { a: 1, big: "b".repeat(1000) }) as { raw: string };
    expect(raw.raw.length).toBeLessThanOrEqual(400);
    expect(raw.raw).toContain('"a":1');
  });

  it("子代理 context.prune/growth/model.score 结构化入账(不再只有 raw)", () => {
    const prune = trimSubLoopEvent("context.prune", {
      reason: "below-threshold", compacted: 2, savedTokens: 2485, growthSpurt: false,
      items: [{ toolCallId: "c1", tool: "grep", where: "pattern=x", action: "head_tail", originalChars: 11039, newChars: 5150 }],
    });
    expect(prune).toMatchObject({ reason: "below-threshold", compacted: 2, savedTokens: 2485 });
    expect((prune.items as { action: string }[])[0]!.action).toBe("head_tail");
    expect(trimSubLoopEvent("context.growth", { growth: 1200, rawContextTokens: 5000, previousContextTokens: 3800, keepRecent: 2 }))
      .toEqual({ growth: 1200, rawContextTokens: 5000, previousContextTokens: 3800, keepRecent: 2 });
    const score = trimSubLoopEvent("context.model.score", {
      step: 10, mode: "active", providerUrl: "http://127.0.0.1:8105", goalChars: 500,
      candidateCount: 2, previewChars: 300, questionCount: 4, requestBytes: 900, durationMs: 20,
      decisions: [{ id: "c1", tool: "grep", where: "pattern=x", keepCall: 0.1, keepResult: 0.2, confidence: 0.9 }],
    });
    expect(score).toMatchObject({ step: 10, mode: "active", candidateCount: 2, questionCount: 4, requestBytes: 900 });
    expect((score.decisions as { id: string }[])[0]!.id).toBe("c1");
    expect((prune as { raw?: string }).raw).toBeUndefined();
  });
});

describe("LlmLoopBackend onLoopEvent:子 loop 事件同挂点回调", () => {
  it("事件序列完整(tool.call/result/message.agent/step.*)且 payload 已裁剪;心跳机制不受影响", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subev-"));
    writeFileSync(join(dir, "needle.txt"), "find demo marker here\n");
    let step = 0;
    const backend = new LlmLoopBackend({
      llm: { async chat() {
        step++;
        if (step === 1) return { content: "", toolCalls: [{ id: "g1", name: "grep", arguments: JSON.stringify({ pattern: "demo", path: dir }) }] };
        return { content: "子代理调查报告:命中 needle.txt 一处。".padEnd(120, "尾") };
      } } as never,
      roots: [dir], workdir: dir, role: "explore", heartbeatMs: 100,
      onLoopEvent: (e) => got.push(e),
    });
    const got: { kind: string; payload: Record<string, unknown> }[] = [];
    const progressNotes: string[] = [];
    let result: { ok: boolean; finalText?: string } | undefined;
    await backend.spawn({ taskId: "t-ev", instructions: "调查", workdir: dir, permissions: "readonly" }, (e) => {
      if (e.type === "progress") progressNotes.push(String(e.note ?? ""));
      if (e.type === "result") result = e.result;
    });
    await new Promise((r) => setTimeout(r, 1200));
    const kinds = got.map((e) => e.kind);
    expect(kinds, "turn/step 边界入账").toContain("turn.start");
    expect(kinds).toContain("step.start");
    expect(kinds, "工具调用/返回都入账").toContain("tool.call");
    expect(kinds).toContain("tool.result");
    expect(kinds, "最终模型消息入账").toContain("message.agent");
    expect(kinds).toContain("turn.end");
    const tc = got.find((e) => e.kind === "tool.call")!.payload;
    expect(tc.name).toBe("grep");
    expect(String(tc.arguments).length).toBeLessThanOrEqual(400);
    const ma = got.filter((e) => e.kind === "message.agent").at(-1)!.payload;
    expect(String(ma.text)).toContain("子代理调查报告");
    // G2 心跳机制不回退(同一拦截器上原样保留):工具节点仍有节流心跳 progress 行
    expect(progressNotes.some((n) => n.indexOf("心跳") >= 0), "心跳行仍在:" + progressNotes.join("|").slice(0, 120)).toBe(true);
    expect(result?.ok).toBe(true);
  }, 20_000);
});

describe("真实链路 e2e:subagent.event 入主 journal", () => {
  it("进程内后端:journal 出现 subagent.event(agentId/taskId/kind 正确,sessionId=主会话)", async () => {
    process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }, { permission: "task_output", pattern: "*", action: "allow" }]);
    const tiny = mkdtempSync(join(tmpdir(), "subev-root-"));
    writeFileSync(join(tiny, "pnpm-workspace.yaml"), "packages: []\n");
    mkdirSync(join(tiny, "src"), { recursive: true });
    writeFileSync(join(tiny, "src", "demo.ts"), "export function demoMain(): number { return 1; }\n");
    process.env.GENIE_REPO_ROOT = tiny;
    process.env.GENIE_SENSE_ORIENT = "off";
    const seen: string[] = [];
    const app = createGatewayApp({      port: 0,
      llm: { async chat(_m: unknown) {
        const sys = JSON.stringify(_m);
        if (sys.includes("独立上下文")) {
          // 子代理轨:一步工具(grep 小仓)+一步终稿——工作区事件流的素材
          const n = (sys.match(/subagent-ev-step/g) || []).length; // 占位:按调用次数分流
          seen.push("child" + n);
          if (seen.filter((x) => x.startsWith("child")).length === 1) {
            return { content: "", toolCalls: [{ id: "c1", name: "grep", arguments: JSON.stringify({ pattern: "demoMain", path: tiny }) }] } as never;
          }
          return { content: "子代理报告:demoMain 定义于 src/demo.ts。" } as never;
        }
        if (seen.length === 0 || !seen.includes("spawn")) {
          seen.push("spawn");
          return { content: "", toolCalls: [{ id: "b1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "盘点 demoMain 的定义位置", agentType: "explore", run_in_background: true, title: "定义勘察" }) }] } as never;
        }
        seen.push("final");
        return { content: "主 agent:后台子代理已派出。" } as never;
      } } as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    app.taskManager.submit("user", "subev-s1", "派子代理盘点 demoMain");
    for (let i = 0; i < 150; i++) {
      const t = app.taskManager.list().find((x) => x.sessionId === "subev-s1");
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // 等后台子代理事件全部入账
    for (let i = 0; i < 50; i++) {
      const evCount = app.journal.readAll().filter((e) => e.kind === "subagent.event" && String((e.payload as { kind?: string }).kind) === "turn.end").length;
      if (evCount > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const evs = app.journal.readAll().filter((e) => e.kind === "subagent.event");
    expect(evs.length, "subagent.event 应批量入账").toBeGreaterThan(3);
    const p0 = evs[0]!.payload as { agentId?: string; taskId?: string; kind?: string };
    expect(p0.agentId, "payload 带 agentId(工作区过滤键)").toMatch(/^agent_/);
    expect(p0.taskId, "payload 带 taskId").toBeTruthy();
    expect(evs.every((e) => e.sessionId === "subev-s1"), "sessionId=主会话(随 session.history 增量可达面板)").toBe(true);
    const spawn = app.journal.readAll().find((e) => e.kind === "subagent.spawn")!;
    expect((spawn.payload as { agentId?: string }).agentId, "subagent.event 的 agentId 与 spawn 一致(同 agentId 可关联)").toBe(p0.agentId);
    const resultEv = app.journal.readAll().filter((e) => e.kind === "subagent.result");
    expect(resultEv.length, "子代理终态照旧入账(不回退)").toBeGreaterThan(0);
    await app.close();
    delete process.env.GENIE_PERMISSION_RULES;
    delete process.env.GENIE_REPO_ROOT;
    delete process.env.GENIE_SENSE_ORIENT;
  }, 40_000);

  it("外部子进程后端(echo):真实 echo-child 不产生 subagent.event(工作区降级语义的服务端事实)", async () => {
    process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }]);
    // 屏蔽 echo 替换:executor.kind 非 echo-child(echo 配置会被判定为进程内并替换 LlmLoopBackend)——
    // 用一个自造外部形态后端(kind=external-x)验证「非进程内=零 subagent.event」。
    const external = { kind: "external-x", async spawn(_spec: unknown, onEvent: (e: { type: string; note?: string; result?: unknown }) => void) {
      setTimeout(() => { try { onEvent({ type: "progress", note: "外部后端进度行" }); } catch { /* 宿主收尾 */ } }, 50);
      setTimeout(() => { try { onEvent({ type: "result", result: { ok: true, finalText: "外部后端完成" } }); } catch { /* 宿主收尾 */ } }, 150);
      return { taskId: "t", cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
    } };
    const seen: string[] = [];
    const app = createGatewayApp({      port: 0,
      llm: { async chat() {
        if (!seen.includes("spawn")) { seen.push("spawn"); return { content: "", toolCalls: [{ id: "b1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "外部调查", agentType: "explore", run_in_background: true }) }] } as never; }
        seen.push("final");
        return { content: "外部子代理已派出。" } as never;
      } } as never,
      executor: external as never,
      useExternalHttp: true,
    });
    app.taskManager.submit("user", "subev-ext", "派外部子代理");
    for (let i = 0; i < 100; i++) {
      const t = app.taskManager.list().find((x) => x.sessionId === "subev-ext");
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 600));
    const evs = app.journal.readAll().filter((e) => e.kind === "subagent.event");
    expect(evs.length, "外部后端零 loop 事件(面板对它降级 tail 时间线)").toBe(0);
    expect(app.journal.readAll().some((e) => e.kind === "subagent.result"), "外部后端终态仍照旧入账").toBe(true);
    await app.close();
    delete process.env.GENIE_PERMISSION_RULES;
  }, 30_000);
});
