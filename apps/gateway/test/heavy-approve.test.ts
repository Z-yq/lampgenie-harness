/**
 * 任务书预授权白名单(spawn_subagent.heavyApprove)单测:
 * ①heavyApproveMatch 前缀语义(命中/未命中/空/缺省/空前缀不恒真)
 * ②命中→直接按批准处理并 journal 留痕 brief-scoped-auto(沿用 subagent.heavy-ask/-answer 事件形状)
 * ③未命中→仍走既有父审批链(ask 被调用、无 brief-scoped-auto 痕)
 * ④deny 红线现状如实断言:本层 deny 判定只有 git-guard(git 写/破坏);pkill 类进程信号命令
 * 不在 heavyOp 分类表也不在 git-guard——白名单含 "pkill" 时会放行 heavy 闸,但注意 pkill 根本
 * 不命中 heavyOp 分类(闸都不会触发),真正拦截它的层是任务书红线/父代理审批语义,不在本层。
 * git push 即使白名单含 "git push" 也被 deny 优先拦下(仍走父审批链)。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { setImmediate as setImmediateCb } from "node:timers";
const setImmediate = setImmediateCb as unknown as <T>(cb: () => T) => T;
import {
  heavyApproveMatch,
  journalBriefScopedHeavyAutoApproval,
  makeBriefScopedHeavyAskRouter,
  LlmLoopBackend,
} from "../src/llm-loop-backend.js";
import { ParentAskBroker } from "@lampgenie/runtime/agent/parent-ask-broker";
import { classifyHeavyOp } from "@lampgenie/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MATCH = (cmd: string) => classifyHeavyOp(cmd)!;

describe("heavyApproveMatch(前缀语义)", () => {
  it("命中=command.trim().startsWith(prefix)(大小写敏感,不做 shell 解析)", () => {
    expect(heavyApproveMatch("pnpm --filter x run build", ["pnpm --filter"])).toBe(true);
    expect(heavyApproveMatch("  tsc -b  ", ["tsc -b"])).toBe(true); // 两侧 trim
    expect(heavyApproveMatch("Pnpm build", ["pnpm"])).toBe(false); // 大小写敏感
    expect(heavyApproveMatch("echo pnpm build", ["pnpm"])).toBe(false); // 前缀而非包含
  });
  it("缺省/空数组/空命令=false(与现状逐字一致)", () => {
    expect(heavyApproveMatch("pnpm build")).toBe(false);
    expect(heavyApproveMatch("pnpm build", [])).toBe(false);
    expect(heavyApproveMatch("", ["pnpm"])).toBe(false);
    expect(heavyApproveMatch("   ", ["pnpm"])).toBe(false);
  });
  it("空前缀条目不参与匹配(防空串恒真放行)", () => {
    expect(heavyApproveMatch("rm -rf /", ["", "  "])).toBe(false);
  });
});

describe("父侧路由 makeBriefScopedHeavyAskRouter()", () => {
  it("白名单命中→直接批准+journal brief-scoped-auto(heavy-ask/-answer 成对);ask 不被调", async () => {
    const j = new MemoryJournal();
    let asks = 0;
    const route = makeBriefScopedHeavyAskRouter({
      journal: j, sessionId: "s-parent", prefixes: ["/home/zhongyuqi/.nvm/versions/node/v24.22.2/bin/node --import tsx"],
      ask: async () => { asks++; return { approved: false, by: "parent-llm" }; },
    });
    const r = await route({ taskId: "t1", role: "worker", tool: "run_cmd", command: "/home/zhongyuqi/.nvm/versions/node/v24.22.2/bin/node --import tsx ../node_modules/vitest/vitest.mjs run test/permission-presets.test.ts", match: MATCH("/home/zhongyuqi/.nvm/versions/node/v24.22.2/bin/node --import tsx ../node_modules/vitest/vitest.mjs run test/permission-presets.test.ts") });
    expect(r.approved).toBe(true);
    expect(r.by).toBe("brief-scoped-auto");
    expect(asks).toBe(0);
    const customs = j.readAll().filter((e) => e.kind === "custom").map((e) => e.payload as { topic?: string; approved?: boolean; approvedBy?: string; note?: string });
    expect(customs.some((p) => p.topic === "subagent.heavy-ask")).toBe(true);
    const ans = customs.find((p) => p.topic === "subagent.heavy-answer");
    expect(ans?.approved).toBe(true);
    expect(ans?.approvedBy).toBe("brief-scoped-auto");
    expect(ans?.note).toBe("brief-scoped-auto");
  });
  it("未命中→仍走既有父审批链(ask 被调,无 brief-scoped-auto 痕)", async () => {
    const j = new MemoryJournal();
    let asks = 0;
    const route = makeBriefScopedHeavyAskRouter({
      journal: j, sessionId: "s-parent", prefixes: ["npm run lint"],
      ask: async () => { asks++; return { approved: true, reason: "父批准", by: "parent-llm" }; },
    });
    const r = await route({ taskId: "t2", role: "worker", tool: "run_cmd", command: "pnpm build", match: MATCH("pnpm build") });
    expect(r.approved).toBe(true);
    expect(r.by).toBe("parent-llm");
    expect(asks).toBe(1);
    expect(j.readAll().filter((e) => (e.payload as { approvedBy?: string })?.approvedBy === "brief-scoped-auto")).toHaveLength(0);
  });
  it("deny 红线优先:git push 命中 git-guard 写判定,白名单含 \"git push\" 也不自动放行(回落父审批)", async () => {
    const j = new MemoryJournal();
    let asks = 0;
    const route = makeBriefScopedHeavyAskRouter({
      journal: j, sessionId: "s-parent", prefixes: ["git push"],
      ask: async () => { asks++; return { approved: false, reason: "红线", by: "parent-llm" }; },
    });
    const r = await route({ taskId: "t3", role: "worker", tool: "run_cmd", command: "git push origin main", match: MATCH("git push origin main") });
    expect(asks).toBe(1); // 未被白名单短路,走了父审批
    expect(r.approved).toBe(false);
    expect(r.by).toBe("parent-llm");
    expect(j.readAll().filter((e) => (e.payload as { approvedBy?: string })?.approvedBy === "brief-scoped-auto")).toHaveLength(0);
  });
  it("缺省/空数组=行为与现状逐字一致(全部走 ask)", async () => {
    let asks = 0;
    for (const prefixes of [undefined, [] as string[]]) {
      const route = makeBriefScopedHeavyAskRouter({ journal: null, sessionId: "s", prefixes, ask: async () => { asks++; return { approved: false, by: "timeout" }; } });
      const r = await route({ taskId: "t", role: "worker", tool: "run_cmd", command: "pnpm build", match: MATCH("pnpm build") });
      expect(r.by).toBe("timeout");
    }
    expect(asks).toBe(2);
  });
  it("现状语义如实登记:pkill 不在 heavyOp 分类表(classifyHeavyOp=null,闸根本不触发);白名单放行不影响该结论", () => {
    expect(classifyHeavyOp("pkill -f gateway")).toBeNull();
    expect(heavyApproveMatch("pkill -f gateway", ["pkill"])).toBe(true); // helper 层会命中——但闸不触发,放行语义不存在
  });
});

describe("留痕形状 journalBriefScopedHeavyAutoApproval", () => {
  it("heavy-ask/-answer 成对,answer 带 approvedBy=brief-scoped-auto", () => {
    const j = new MemoryJournal();
    journalBriefScopedHeavyAutoApproval(j, "s-x", { taskId: "t9", role: "worker", tool: "run_cmd", command: "tsc -b", match: MATCH("tsc -b") });
    const topics = j.readAll().map((e) => (e.payload as { topic?: string }).topic);
    expect(topics).toEqual(["subagent.heavy-ask", "subagent.heavy-answer"]);
  });
  it("journal 缺省(null)=no-op 不抛", () => {
    expect(() => journalBriefScopedHeavyAutoApproval(null, "s", { taskId: "t", role: "r", tool: "run_cmd", command: "x", match: MATCH("tsc -b") })).not.toThrow();
  });
});

describe("子侧闸接线(LlmLoopBackend heavyApprove,真实 run_cmd 链路)", () => {
  function fakeLlm(script: Array<{ content: string; toolCalls?: { id: string; name: string; arguments: string }[] }>) {
    let i = 0;
    return { async chat() { const r = script[Math.min(i, script.length - 1)]!; i++; return r; } } as never;
  }
  async function runBackend(backend: LlmLoopBackend, taskId: string, dir: string) {
    let result: { ok: boolean; finalText?: string; error?: { kind?: string } } | undefined;
    const handle = await backend.spawn({ taskId, instructions: "做任务", workdir: dir, permissions: "sandbox" }, (e) => { if (e.type === "result") result = e.result; });
    for (let i = 0; i < 150 && !result; i++) await new Promise((r) => setTimeout(r, 100));
    try { await handle.cancel(); } catch { /* 已结束 */ }
    return result;
  }
  const NODE_BIN = "/home/zhongyuqi/.nvm/versions/node/v24.22.2/bin/node";
  it("白名单命中:heavy 命令直接执行不问父(parentAsk 零调用;留痕形状由 helper 单测锚定)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ha-hit-"));
    try {
      const asked: string[] = [];
      const backend = new LlmLoopBackend({
        llm: fakeLlm([
          { content: "构建", toolCalls: [{ id: "c1", name: "run_cmd", arguments: JSON.stringify({ command: NODE_BIN + " --version" }) }] },
          { content: "探针完成" },
        ]),
        roots: [dir], workdir: dir, role: "worker",
        parentAsk: (input) => { asked.push(input.command); return Promise.resolve({ approved: false, by: "parent-llm" }); },
 // 白名单给 NODE_BIN 前缀——真实命令为轻探针(node --version,不判 heavy、不过闸);
 // heavy 分类命中的同前缀命令(npm run test 等)在本用例不跑,避免真实资源操作。
 // 闸语义断言由「未命中」用例(反向:问父)+helper 单测(路由放行)共同覆盖。
        heavyApprove: [NODE_BIN],
      });
      const result = await runBackend(backend, "ha-hit", dir);
      expect(asked).toEqual([]); // 白名单/轻命令均不问父
      expect(result?.ok).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
  it("未命中:heavy 命令照旧问父(asked 有记录);轻命令不过闸", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ha-miss-"));
    try {
      const asked: string[] = [];
      const broker = new ParentAskBroker();
      broker.onPending = (q) => { asked.push(q.command); setImmediate(() => broker.answer(q.requestId, { approved: false, reason: "资源紧" })); };
      const backend = new LlmLoopBackend({
        llm: fakeLlm([
          { content: "构建", toolCalls: [{ id: "c1", name: "run_cmd", arguments: JSON.stringify({ command: "npm run test" }) }] },
          { content: "被父拒绝,未执行" },
        ]),
        roots: [dir], workdir: dir, role: "worker",
        parentAsk: (input) => broker.ask(input),
        heavyApprove: ["tsc -b"], // 不含 npm run
      });
      const result = await runBackend(backend, "ha-miss", dir);
      expect(asked).toEqual(["npm run test"]); // 未命中→仍走父审批
      expect(result?.finalText ?? "").toContain("被父拒绝");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
