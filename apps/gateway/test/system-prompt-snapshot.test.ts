/**
 * system 提示词快照落账(token 轮 P1 · designs/token-opt-round3-p1 §5-1/§5-2):
 * ① 同 session 同 sha 两次调用只落一条 system.prompt;② chars === text.length;
 * ③ text 超 65536 字符 → 截断到 65536 并置 truncated:true;④ deriveMessages 不消费该 kind。
 * 落点判定:幂等+截断逻辑抽成纯函数放 apps/gateway/src/system-prompt-snapshot.ts
 * (loop 消费侧在 runtime,写入侧在 gateway 装配点 agent-wiring 的 runWithAgent)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { deriveMessages } from "@lampgenie/runtime/agent/loop";
import type { Message } from "@lampgenie/runtime/agent/loop";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SYSTEM_PROMPT_SNAPSHOT_MAX_CHARS,
  buildSystemPromptSnapshot,
  hasSystemPromptSnapshot,
  recordSystemPromptSnapshot,
  systemPromptSha,
} from "../src/system-prompt-snapshot.js";

const apps: ReturnType<typeof createGatewayApp>[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

describe("system.prompt 快照落账", () => {
  it("同 session 同 sha 两次调用只落一条(chars === text.length)", () => {
    const journal = new MemoryJournal();
    const sid = "sps-1";
    const sys = "SYSTEM " + "x".repeat(1000);
    expect(recordSystemPromptSnapshot(journal, sid, sys)).toBe(true);
    expect(recordSystemPromptSnapshot(journal, sid, sys)).toBe(false); // 幂等:第二次不写

    const evs = journal.readSession(sid).filter((e) => e.kind === "system.prompt");
    expect(evs).toHaveLength(1);
    const p = evs[0]!.payload as { sha: string; text: string; chars: number; truncated?: boolean };
    expect(p.text).toBe(sys);
    expect(p.chars).toBe(p.text.length);
    expect(p.chars).toBe(sys.length);
    expect(p.sha).toBe(systemPromptSha(sys));
    expect(p.sha).toHaveLength(12); // 与 task.context.systemSha 同口径(sha1 前 12 位)
    expect(p.truncated).toBeUndefined();
  });

  it("不同 sha(系统提示变更)只落首条:后续版本不再写全文(冗余副本 = 未读存储 + 暴露面)", () => {
    const journal = new MemoryJournal();
    const sid = "sps-2";
    const v1 = "SYSTEM-V1";
    const v2 = "SYSTEM-V2";
    expect(recordSystemPromptSnapshot(journal, sid, v1)).toBe(true);
    expect(recordSystemPromptSnapshot(journal, sid, v2)).toBe(false); // 首条即定案
    const evs = journal.readSession(sid).filter((e) => e.kind === "system.prompt");
    expect(evs).toHaveLength(1);
    expect((evs[0]!.payload as { text: string }).text).toBe(v1);
    // 幂等判定兼容旧版本:重放 v1 仍不新增
    expect(hasSystemPromptSnapshot(journal, sid, systemPromptSha(v1))).toBe(true);
    expect(recordSystemPromptSnapshot(journal, sid, v1)).toBe(false);
    expect(journal.readSession(sid).filter((e) => e.kind === "system.prompt")).toHaveLength(1);
  });

  it("超 64k 字符 → 截断到 65536 并置 truncated:true(chars 为截断后长度)", () => {
    const journal = new MemoryJournal();
    const sid = "sps-3";
    const sys = "S".repeat(SYSTEM_PROMPT_SNAPSHOT_MAX_CHARS + 500);
    recordSystemPromptSnapshot(journal, sid, sys);
    const p = journal.readSession(sid).find((e) => e.kind === "system.prompt")!.payload as {
      sha: string; text: string; chars: number; truncated?: boolean;
    };
    expect(p.truncated).toBe(true);
    expect(p.text.length).toBe(SYSTEM_PROMPT_SNAPSHOT_MAX_CHARS);
    expect(p.chars).toBe(SYSTEM_PROMPT_SNAPSHOT_MAX_CHARS);
    expect(p.chars).toBe(p.text.length);
    expect(p.sha).toBe(systemPromptSha(sys)); // 指纹按全文算(截断只影响正文长度)
  });

  it("恰好 64k 不截断(边界:截断条件是 > 而非 >=)", () => {
    const sys = "S".repeat(SYSTEM_PROMPT_SNAPSHOT_MAX_CHARS);
    const p = buildSystemPromptSnapshot(sys);
    expect(p.truncated).toBeUndefined();
    expect(p.text.length).toBe(SYSTEM_PROMPT_SNAPSHOT_MAX_CHARS);
  });

  it("negative:deriveMessages 不消费 system.prompt(输出条数与内容不变)", () => {
    const journal = new MemoryJournal();
    const sid = "sps-4";
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "任务" } });
    journal.append({ kind: "message.agent", sessionId: sid, payload: { text: "回执" } });
    const before = deriveMessages(journal, sid);
    recordSystemPromptSnapshot(journal, sid, "SNAPSHOT-TEXT");
    const after = deriveMessages(journal, sid);
    expect(after).toHaveLength(before.length);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("装配点接线:runWithAgent 审计锚同处落快照(与 task.context 同一 sys / 同一 sha 口径)", () => {
    // 与 task-class.test.ts 的板规范固化同风格:装配点漏接线时这里立刻红(单测覆盖不到 runWithAgent)。
    const aw = readFileSync(resolve(__dirname, "../src/agent-wiring.ts"), "utf8");
    expect(aw).toContain('import { systemPromptSha, recordSystemPromptSnapshot } from "./system-prompt-snapshot.js"');
    expect(aw).toContain("recordSystemPromptSnapshot(journal, task.sessionId, sys)");
    expect(aw).toContain("systemSha: systemPromptSha(sys)");
  });

  it("e2e 主链路:真跑一个任务 → 只落一条快照,且首请求 node0 就是该快照(node0 冻结生效)", async () => {
    const seen: Message[][] = [];
    const sid = "sps-e2e-1";
    const app = createGatewayApp({
      port: 0,
      llm: { async chat(m: unknown) {
        if (JSON.stringify(m).includes("独立上下文")) return { content: "子代理完成" };
        seen.push(m as Message[]);
        return { content: "结论:一句话够了。" };
      } } as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    apps.push(app);
    app.taskManager.submit("user", sid, "这个项目的入口在哪里?");
    for (let k = 0; k < 200; k++) {
      const t = app.taskManager.list().find((x) => x.sessionId === sid);
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const snaps = app.journal.readSession(sid).filter((e) => e.kind === "system.prompt");
    expect(snaps).toHaveLength(1);
    const p = snaps[0]!.payload as { sha: string; text: string; chars: number; truncated?: boolean };
    expect(p.chars).toBe(p.text.length);
    expect(p.truncated).toBeUndefined();
    // 与审计锚同口径:task.context.systemSha === 快照 sha(同一 function 产出)
    const ctx = app.journal.readSession(sid).find((e) => e.kind === "task.context")!.payload as { systemSha: string };
    expect(ctx.systemSha).toBe(p.sha);
    // 首请求 node0 = 快照全文(实时 system 与快照同版 → 不追加)
    const first = seen[0]!;
    expect(first[0]).toEqual({ role: "system", content: p.text });
    expect(first.some((m) => m.content.startsWith("[系统提示更新]"))).toBe(false);
  }, 45_000);
});
