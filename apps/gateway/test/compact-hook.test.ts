/**
 * step-058 compact 钩子接线锚定(makeCompactHook):
 * ①子 agent 结果合并(tool.result)只增上下文——合并本身绝不触发压缩(解耦);
 * ②usage 实测逼近模型窗口(80%)才真压缩,且压缩发生时同步触发 exp 经验沉淀(用户口径);
 * ③无窗口时显式阈值(config agent.compactThresholdTokens 通道)兜底。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { ExperienceStore } from "@lampgenie/experience";
import type { LlmProvider } from "@lampgenie/runtime/agent/loop";
import { makeCompactHook } from "../src/compact-hook.js";

const tmp = mkdtempSync(join(tmpdir(), "compact-hook-test-"));

function stubLlm(reply: string | ((lastMessage: string) => string)): LlmProvider {
  return {
    chat: async (messages: unknown) => {
      const arr = Array.isArray(messages) ? (messages as { content?: unknown }[]) : [];
      const last = String(arr.at(-1)?.content ?? "");
      return { content: typeof reply === "function" ? reply(last) : reply };
    },
  } as unknown as LlmProvider;
}

function agent(j: MemoryJournal, text: string, inputTokens: number): void {
  j.append({ kind: "message.agent", sessionId: "s1", payload: { text, usage: { inputTokens } } });
}

describe("makeCompactHook(step-058)", () => {
  it("子 agent 结果合并(tool.result)只增上下文——绝不因此触发压缩(与合并解耦)", async () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s1", payload: { text: "派子代理调查" } });
    agent(j, "", 1000);
    j.append({ kind: "tool.result", sessionId: "s1", payload: { toolCallId: "c1", content: "X".repeat(2000) } }); // 子代理结果合并
    agent(j, "继续", 1100);
    agent(j, "完成", 1200);
    const hook = makeCompactHook({
      contextWindow: 8192,
      compactLlm: stubLlm("不应被调用"),
      devlogDir: tmp,
      taskId: "t1",
      fallbackInstruction: "",
      store: new ExperienceStore(join(tmp, "exp0")),
    });
    await hook(j, "s1");
    expect(j.readAll().filter((e) => e.kind === "compact.start" || e.kind === "compact.done")).toHaveLength(0);
  });

  it("usage ≥ 窗口 80% → 真压缩(带摘要边界)且同步触发 exp 沉淀(经验库出条目)", async () => {
    const store = new ExperienceStore(join(tmp, "exp"));
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s1", payload: { text: "调查 compact 机制并修复" } });
    // 2026-11-04 强压守卫修订:对话史必须真有分量(est ≥ 阈)——「usage 大但史小」是死亡螺旋形态,
    // 现在会被 force-vs-est 守卫拦下。真实增长 = 历史里有真实体量(工具结果堆积)。
    j.append({ kind: "message.user", sessionId: "s1", payload: { text: "素材".repeat(20_000) } });
    agent(j, "第0步", 7000);
    j.append({ kind: "message.user", sessionId: "s1", payload: { text: "素材".repeat(20_000) } });
    agent(j, "第1步", 7000);
    j.append({ kind: "message.user", sessionId: "s1", payload: { text: "素材".repeat(20_000) } });
    agent(j, "第2步", 7000); // 窗口 8192→阈 6554;≥阈且 3 条消息>基线抑制窗 → fire+force
    const expOps = JSON.stringify({ ops: [{ op: "write", category: "debug", name: "compact-exp-lesson", description: "压缩时同步沉淀经验", body: "压缩发生时把头部内容 fold-in 进经验库" }] });
    const expPrompts: string[] = [];
    const compactLlm = stubLlm("目标:修 compact;已完成:闸门收敛;待办:无");
    const expLlm = stubLlm((last) => {
      expPrompts.push(last);
      return expOps;
    });
    const hook = makeCompactHook({ contextWindow: 8192, compactLlm, expLlm, devlogDir: tmp, taskId: "t1", fallbackInstruction: "", store });
    await hook(j, "s1");
    const done = j.readAll().find((e) => e.kind === "compact.done");
    expect(String((done?.payload as { summary?: string } | undefined)?.summary ?? "")).toContain("compact");
    // exp 是异步跟发(不阻塞主链路),轮询经验库出条目
    const t0 = Date.now();
    while (Date.now() - t0 < 3000 && !store.read("debug", "compact-exp-lesson")) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(store.read("debug", "compact-exp-lesson")).not.toBeNull();
    expect(expPrompts[0]).toContain("经验提炼员"); // 走 exp 提炼提示词(fold-in)
  });

  it("无窗口时显式阈值兜底(config agent.compactThresholdTokens 通道)", async () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s1", payload: { text: "hi" } });
    // 同上:强压守卫要求 est ≥ 阈(真实增长形态)
    j.append({ kind: "message.user", sessionId: "s1", payload: { text: "素材".repeat(30_000) } });
    agent(j, "x", 30_000);
    agent(j, "x", 30_000);
    agent(j, "x", 30_000); // ≥ 显式阈 24000 → fire+force
    // M49 缩小校验(摘要必须严格小于被遮蔽的 head):hook 的 keepRecent=min(10,msgCount-1),
    // 消息数 ≤11 时 head 恒只有第 1 条(这里是 "hi"),压缩毫无收益且会被 not-smaller 拒。
    // 补齐消息数到 12 让 head 含真实体量(第 2 条 3 万字素材),与生产「长会话压缩」形态一致。
    for (let i = 0; i < 7; i++) agent(j, "x", 30_000);
    const hook = makeCompactHook({
      explicitThreshold: 24_000,
      compactLlm: stubLlm("显式阈值路径摘要"),
      devlogDir: tmp,
      taskId: "t1",
      fallbackInstruction: "",
      store: new ExperienceStore(join(tmp, "exp2")),
    });
    await hook(j, "s1");
    expect(j.readAll().some((e) => e.kind === "compact.done")).toBe(true);
  });
});
