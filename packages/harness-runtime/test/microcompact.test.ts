import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import {
  microcompactMessages, HUGE_RESULT_CHARS,
  buildDefaultMicrocompactThreshold,
  estimateTokensOfText,
  MICROCOMPACT_THRESHOLD_BUFFER_TOKENS,
  MICROCOMPACT_THRESHOLD_RATIO,
  shouldAggressivePrune,
  looksLikeErrorResult,
  type MicrocompactConfig,
  type MicrocompactPolicyState,
} from "../src/agent/microcompact";
import { AgentLoop, deriveMessages, estimateMessagesTokens, type Message, type LlmProvider, type Tool } from "../src/agent/loop";

/** 造一组「assistant 带 toolCalls + 对应 tool 结果」消息(组清理测试基建)。 */
function toolGroup(i: number, tool: string, resultChars: number): Message[] {
  return [
    { role: "assistant" as never, content: "", toolCalls: [{ id: `c${i}`, name: tool, arguments: JSON.stringify({ path: `src/f${i}.ts`, offset: 1, limit: 500 }) }] },
    { role: "tool", toolCallId: `c${i}`, content: `结果${i}:` + "x".repeat(resultChars) },
  ];
}

describe("错误结果硬保护(2026-10-25 中文/结构化错误补齐)", () => {
  it("识别中文前缀错误与结构化 ok:false/is_error", () => {
    expect(looksLikeErrorResult("错误:路径非法或越出项目根")).toBe(true);
    expect(looksLikeErrorResult("错误：只接受项目内相对路径")).toBe(true);
    expect(looksLikeErrorResult("失败: 命令退出")).toBe(true);
    expect(looksLikeErrorResult("异常: timeout")).toBe(true);
    expect(looksLikeErrorResult('{"ok":false,"error":"boom"}')).toBe(true);
    expect(looksLikeErrorResult('{"is_error":true,"content":"x"}')).toBe(true);
    // 普通正文里出现“错误”不误判(只在行首/结构化错误字段时保护)
    expect(looksLikeErrorResult("这个函数会返回错误码,不是异常")).toBe(false);
    expect(looksLikeErrorResult('{"ok":true,"error":null}')).toBe(false);
  });

  it("中文/结构化错误即使超大也不 head/tail,原文全保留", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c0", name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) }] },
      { role: "tool", toolCallId: "c0", content: "错误:路径非法\n" + "x".repeat(HUGE_RESULT_CHARS + 100) },
    ];
    const first = microcompactMessages(msgs);
    expect(first.compacted).toBe(0);
    expect(String((first.messages[2] as { content: string }).content)).toContain("错误:路径非法");

    const structured: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c1", name: "terminal", arguments: JSON.stringify({ command: "x" }) }] },
      { role: "tool", toolCallId: "c1", content: '{"ok":false,"error":"boom"}' + "y".repeat(HUGE_RESULT_CHARS + 100) },
    ];
    const second = microcompactMessages(structured);
    expect(second.compacted).toBe(0);
    expect(String((second.messages[2] as { content: string }).content)).toContain('"ok":false');
  });
});

describe("microcompact(2026-10-18 重写:默认全量,只占位超大结果)", () => {
  it("普通体量历史全量保留(不再按 HUGE_RESULT_CHARS 滚动占位)", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" },
      ...Array.from({ length: 20 }, (_, i) => ({ role: "tool" as const, toolCallId: `c${i}`, content: `结果${i}` })),
    ];
    const { messages, compacted } = microcompactMessages(msgs);
    expect(compacted).toBe(0);
    expect((messages[1] as { content: string }).content).toBe("结果0"); // 最早的历史也在
  });
  it("超大结果被替换为带寻址参数的占位符(可精确重读)", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c0", name: "read_file", arguments: JSON.stringify({ path: "src/big.ts", offset: 1, limit: 2000 }) }] },
      { role: "tool", toolCallId: "c0", content: "x".repeat(HUGE_RESULT_CHARS + 100) },
    ];
    const { messages, compacted } = microcompactMessages(msgs);
    expect(compacted).toBe(1);
    const c = (messages[2] as { content: string }).content;
    expect(c).toContain("src/big.ts");
    expect(c).toContain("offset=1");
    expect(c).toContain("精确重读");
  });
  it("认知类工具豁免:code_sense/code_index 超大结果也全量保留", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c0", name: "code_sense", arguments: JSON.stringify({ query: "grepIn", mode: "debug" }) }] },
      { role: "tool", toolCallId: "c0", content: "y".repeat(HUGE_RESULT_CHARS + 100) },
    ];
    const { compacted } = microcompactMessages(msgs);
    expect(compacted).toBe(0);
  });
  it("未知工具(不在两名单)超大结果保留——诚实优先,不做静默裁剪", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c0", name: "mystery_tool", arguments: "{}" }] },
      { role: "tool", toolCallId: "c0", content: "z".repeat(HUGE_RESULT_CHARS + 100) },
    ];
    const { compacted } = microcompactMessages(msgs);
    expect(compacted).toBe(0);
  });
  it("不写 journal compact 事件(纯读取侧)——旧实现每加一条工具结果就写无摘要 compact.done,被 deriveMessages 当真压缩边界硬截断(模型失忆)+面板渲染「上下文已压缩」+压缩闸门清零", () => {
    const j = new MemoryJournal();
    for (let i = 0; i < 7; i++) {
      j.append({ kind: "tool.result", sessionId: "s", payload: { toolCallId: `c${i}`, content: "x" } });
    }
    // 读取侧替换照常生效(占位机制不受影响)
    const { compacted } = microcompactMessages([
      { role: "user", content: "q" },
      ...Array.from({ length: 7 }, (_, i) => ({ role: "tool" as const, toolCallId: `c${i}`, content: `结果${i}` })),
    ]);
    expect(compacted).toBe(0); // 新语义:普通体量结果零占位(旧滚动语义已废)
    // journal 零 compact 事件:压缩边界语义只留给真压缩(autoCompact 恒带摘要)
    expect(j.readAll().filter((e) => e.kind === "compact.start" || e.kind === "compact.done")).toHaveLength(0);
  });
  it("deriveMessages 只认带摘要的真压缩边界——旧 journal 里的无摘要 compact.done(microcompact 遗留)不再清空上下文", () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s", payload: { text: "原始任务" } });
    j.append({ kind: "message.agent", sessionId: "s", payload: { text: "进展" } });
    j.append({ kind: "compact.done", sessionId: "s", payload: { compacted: 2, keepRecent: 5 } }); // 旧 microcompact 形态:无摘要
    j.append({ kind: "message.user", sessionId: "s", payload: { text: "后续追问" } });
    // 旧实现:out.length=0 → 模型只剩「后续追问」,任务上下文丢失;修复后边界前的原文保留
    const msgs = deriveMessages(j, "s");
    expect(msgs.map((m) => m.content)).toContain("原始任务");
    expect(msgs).toHaveLength(3);
 // 带摘要的真边界仍硬截断(语义不回退)
    j.append({ kind: "compact.done", sessionId: "s", payload: { summary: "任务摘要", tokensBefore: 100 } });
    expect(deriveMessages(j, "s")).toHaveLength(0);
  });
});

describe("阈值触发组清理(对齐 ZCode:达到阈值才触发+keepRecent 5+minSavings 回滚)", () => {
  const bigGroups = (n: number): Message[] =>
    Array.from({ length: n }, (_, i) => toolGroup(i, "read_file", 2_000)).flat();
  const tinyGroups = (n: number): Message[] =>
    Array.from({ length: n }, (_, i) => toolGroup(i, "read_file", 30)).flat();

  it("低于阈值不动:估算 < thresholdTokens 零清理(reason=below-threshold)", () => {
    const msgs: Message[] = [{ role: "user", content: "q" }, ...bigGroups(10)];
    const { messages, compacted, reason } = microcompactMessages(msgs, { thresholdTokens: 1_000_000 });
    expect(reason).toBe("below-threshold");
    expect(compacted).toBe(0);
    expect((messages[2] as { content: string }).content).toContain("结果0:"); // 原文未动
  });

  it("10 组达阈值→前 5 组清为「已清除+可重读」占位(带寻址参数),后 5 组原文保留", () => {
    const msgs: Message[] = [{ role: "user", content: "q" }, ...bigGroups(10)];
    const { messages, compacted, reason } = microcompactMessages(msgs, { thresholdTokens: 1_000 });
    expect(reason).toBe("applied");
    expect(compacted).toBe(5);
    for (let i = 0; i < 5; i++) { // 组 i 的 tool 消息下标 = 2 + 2i
      const c = (messages[2 + i * 2] as { content: string }).content;
      expect(c).toContain(`[工具结果已清除(上下文压力):read_file src/f${i}.ts offset=1 limit=500`);
      expect(c).toContain("重读"); // 可重读指引
      expect(c).not.toContain(`结果${i}:`); // 原内容已清
    }
    for (let i = 5; i < 10; i++) {
      expect((messages[2 + i * 2] as { content: string }).content).toContain(`结果${i}:`); // 保留原文
    }
  });

  it("keepRecent 可调:keepRecent=8 时 10 组只清前 2 组", () => {
    const msgs: Message[] = [{ role: "user", content: "q" }, ...bigGroups(10)];
    const cfg: MicrocompactConfig = { thresholdTokens: 1_000, keepRecent: 8 };
    const { messages, compacted, reason } = microcompactMessages(msgs, cfg);
    expect(reason).toBe("applied");
    expect(compacted).toBe(2);
    expect((messages[2] as { content: string }).content).toContain("已清除"); // 组 0 清
    expect((messages[6] as { content: string }).content).toContain("结果2:"); // 组 2 起
  });

  it("minSavings 不足回滚:占位符比原文还长(省为负)时整体回滚,原文全保留", () => {
    const msgs: Message[] = [{ role: "user", content: "q" }, ...tinyGroups(10)];
    // 每组结果 ~34 字符 → est≈91;threshold=50 触发,但清 5 组省不出 256 → 回滚
    const { messages, compacted, reason } = microcompactMessages(msgs, { thresholdTokens: 50 });
    expect(reason).toBe("rolled-back");
    expect(compacted).toBe(0);
    expect((messages[2] as { content: string }).content).toContain("结果0:");
    expect((messages[20] as { content: string }).content).toContain("结果9:");
  });

  it("认知工具豁免:code_sense 结果组不入候选(达阈值也 nothing-to-clear)", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" },
      ...Array.from({ length: 10 }, (_, i) => toolGroup(i, "code_sense", 2_000)).flat(),
    ];
    const { messages, compacted, reason } = microcompactMessages(msgs, { thresholdTokens: 100 });
    expect(reason).toBe("nothing-to-clear");
    expect(compacted).toBe(0);
    expect((messages[2] as { content: string }).content).toContain("结果0:"); // 全量保留
  });

  it("未传配置=旧行为不变:普通体量零占位(reason=huge-only)", () => {
    const msgs: Message[] = [{ role: "user", content: "q" }, ...bigGroups(10)];
    const { messages, compacted, reason } = microcompactMessages(msgs);
    expect(reason).toBe("huge-only");
    expect(compacted).toBe(0);
    expect((messages[2] as { content: string }).content).toContain("结果0:");
  });

  it("buildDefaultMicrocompactThreshold:max(0, min(⌊auto×0.9⌋, auto−2000)) 对齐 ZCode", () => {
    expect(MICROCOMPACT_THRESHOLD_RATIO).toBe(0.9);
    expect(MICROCOMPACT_THRESHOLD_BUFFER_TOKENS).toBe(2_000);
    expect(buildDefaultMicrocompactThreshold(100_000)).toBe(90_000); // min(90000, 98000)
    expect(buildDefaultMicrocompactThreshold(10_000)).toBe(8_000); // min(9000, 8000) 取 buffer 侧
    expect(buildDefaultMicrocompactThreshold(2_000)).toBe(0); // buffer 侧=0
    expect(buildDefaultMicrocompactThreshold(1_500)).toBe(0); // max(0, min(1350, -500))
  });
});

describe(" 主链路:AgentLoop 接线(组装消息时占位生效,journal 原文不动)", () => {
  /** 预置 10 组大结果工具历史进 journal(message.agent 带 toolCalls + tool.result)。 */
  function seed(journal: MemoryJournal): void {
    journal.append({ kind: "message.user", sessionId: "s-mc", payload: { text: "q" } });
    for (let i = 0; i < 10; i++) {
      journal.append({
        kind: "message.agent", sessionId: "s-mc",
        payload: { text: "", toolCalls: [{ id: `c${i}`, name: "read_file", arguments: JSON.stringify({ path: `src/f${i}.ts`, offset: 1, limit: 500 }) }] },
      });
      journal.append({ kind: "tool.result", sessionId: "s-mc", payload: { toolCallId: `c${i}`, content: `结果${i}:` + "x".repeat(2_000) } });
    }
  }
 /** 记录喂给 LLM 的消息的 mock provider(一步纯文本)。 */
  function recordingLlm(seen: Message[]): LlmProvider {
    return { async chat(messages) { seen.push(...messages); return { content: "done" }; } };
  }

  it("带 microcompact 配置:LLM 实际收到占位消息(前 5 组已清除、后 5 组原文),journal 原文全保留", async () => {
    const journal = new MemoryJournal();
    seed(journal);
    const seen: Message[] = [];
    const loop = new AgentLoop({
      journal, sessionId: "s-mc", system: "sys", llm: recordingLlm(seen),
 // cacheAware:false = 显式选旧「每步增量清」行为(新策略默认开启:
      // 小上下文被门槛跳过、缺批量则 defer,旧用例断言的正是被新策略替换掉的行为)。
      microcompact: { thresholdTokens: 1_000, cacheAware: false },
    });
    await loop.runTurn("继续");
    expect(seen.length).toBeGreaterThan(0);
    // ephemeral 块(token 轮 P0-1)现紧接 system 注入 → 历史整体右移;按实际前缀算偏移。
    const off = seen[1] && String((seen[1] as { content: string }).content).startsWith("[系统提醒]") ? 1 : 0;
    // seen[off]=system;[off+1]=user q;[off+2]=a0,[off+3]=t0…t_i=off+3+2i → 前 5 组已清除,后 5 组原文
    for (let i = 0; i < 5; i++) {
      const c = (seen[off + 3 + i * 2] as { content: string }).content;
      expect(c).toContain("工具结果已清除");
      expect(c).toContain(`src/f${i}.ts`);
    }
    for (let i = 5; i < 10; i++) {
      expect((seen[off + 3 + i * 2] as { content: string }).content).toContain(`结果${i}:`);
    }
    // 读取侧语义:journal 的 tool.result 原文未被改动(占位只发生在组装消息时)
    const results = journal.readAll().filter((e) => e.kind === "tool.result");
    expect((results[0]!.payload as { content: string }).content).toContain("结果0:");
    expect((results[9]!.payload as { content: string }).content).toContain("结果9:");
    expect((results[0]!.payload as { content: string }).content).not.toContain("已清除");
  });

  it("未传 microcompact 配置(loop 级旧行为):LLM 收到全部原文,零占位", async () => {
    const journal = new MemoryJournal();
    seed(journal);
    const seen: Message[] = [];
    const loop = new AgentLoop({ journal, sessionId: "s-mc", system: "sys", llm: recordingLlm(seen) });
    await loop.runTurn("继续");
    expect((seen[3] as { content: string }).content).toContain("结果0:"); // 最早的历史也全量
    expect((seen[21] as { content: string }).content).toContain("结果9:");
    expect(seen.some((m) => String((m as { content?: string }).content ?? "").includes("已清除"))).toBe(false);
  });

  it("Phase 0:组清理实际发生时落 context.prune,并向本步注入上下文清单", async () => {
    const journal = new MemoryJournal();
    seed(journal);
    const seen: Message[] = [];
    const loop = new AgentLoop({
      journal, sessionId: "s-mc", system: "sys", llm: recordingLlm(seen),
 // cacheAware:false = 显式选旧「每步增量清」行为(新策略默认开启:
      // 小上下文被门槛跳过、缺批量则 defer,旧用例断言的正是被新策略替换掉的行为)。
      microcompact: { thresholdTokens: 1_000, cacheAware: false },
    });
    await loop.runTurn("继续");
    const pruneEvents = journal.readAll().filter((e) => e.kind === "context.prune");
    expect(pruneEvents.length).toBeGreaterThan(0);
    expect(seen.some((m) => String((m as { content?: string }).content ?? "").includes("[上下文清单]"))).toBe(true);
  });

  it("cache-aware 主链路:一步成批剪 + 后续步粘性重放,context.prune 带策略字段", async () => {
    const journal = new MemoryJournal();
    const sid = "s-mc-cache";
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "q" } });
    for (let i = 0; i < 12; i++) {
      journal.append({
        kind: "message.agent", sessionId: sid,
        payload: { text: "", toolCalls: [{ id: `m${i}`, name: "read_file", arguments: JSON.stringify({ path: `src/m${i}.ts` }) }] },
      });
      journal.append({ kind: "tool.result", sessionId: sid, payload: { toolCallId: `m${i}`, content: `结果${i}:` + "x".repeat(2_000) } });
    }
    const calls: Message[][] = [];
    const llm: LlmProvider = {
      async chat(messages) {
        calls.push(messages.map((m) => ({ ...m })));
        if (calls.length < 3) {
          return { content: "", toolCalls: [{ id: `n${calls.length}`, name: "read_file", arguments: JSON.stringify({ path: `src/n${calls.length}.ts` }) }] };
        }
        return { content: "done" };
      },
    };
    const tool: Tool = {
      name: "read_file", description: "", parameters: {},
      async execute() { return "new:" + "z".repeat(1_000); },
    };
    const loop = new AgentLoop({
      journal, sessionId: sid, system: "sys", llm, tools: [tool],
      microcompact: {
        thresholdTokens: 1_000, keepRecent: 5,
        minContextTokens: 1_000, pruneMinBatchTokens: 300,
        resetCooldownTokens: 2_000, resetCooldownSteps: 3,
        assumedRemainingCalls: 10,
      },
    });
    await loop.runTurn("go");
    const prunes = journal.readAll().filter((e) => e.kind === "context.prune").map((e) => e.payload as Record<string, unknown>);
    const resets = prunes.filter((p) => p.policy === "reset");
    expect(resets.length).toBeLessThanOrEqual(1); // 同一 turn 内前缀重置 ≤1
    expect(resets.length).toBeGreaterThan(0);
    const b = resets[0]!;
    expect(typeof b.planCount).toBe("number");
    expect(Number(b.planCount)).toBeGreaterThanOrEqual(1);
    expect(b.prefixBreak).toBe(true);
    expect(typeof b.contextTokens).toBe("number");
    expect(typeof b.clock).toBe("number");
    expect(typeof b.cutTokens).toBe("number");
    expect(typeof b.budgetTokens).toBe("number");
    expect(b.reason).toBe("applied");
    // 后续步:冻结区逐字重放(append-only / 冷却跳过),不再改写前缀
    expect(prunes.some((p) => p.prefixBreak === false && p.frozenCount !== undefined)).toBe(true);
    const clearedAt = (batch: Message[]): string[] => batch
      .map((m) => String((m as { content?: string }).content ?? ""))
      .filter((c) => c.includes("工具结果已清除"));
    const afterBatch = clearedAt(calls[1] ?? []);
    const last = clearedAt(calls[calls.length - 1] ?? []);
    expect(afterBatch.length).toBeGreaterThan(0);
    expect(last.slice(0, afterBatch.length)).toEqual(afterBatch);
  });
});

describe("Phase 0:硬保护 / dedup / supersede / per-tool cap / manifest", () => {
  function oneTool(name: string, content: string, args: Record<string, unknown> = { path: "src/a.ts" }): Message[] {
    return [
      { role: "user", content: "q" },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c0", name, arguments: JSON.stringify(args) }] },
      { role: "tool", toolCallId: "c0", content },
    ];
  }

  it("错误/异常结果硬保护:中段关键栈帧也不能被 head/tail 剪掉", () => {
    const middle = "  File \"src/critical.ts\", line 99, in foo";
    const content = "Traceback (most recent call last):\n" + "a".repeat(5_000) + "\n" + middle + "\n" + "b".repeat(5_000);
    const { messages, compacted } = microcompactMessages(oneTool("terminal", content, { command: "npm test" }));
    expect(compacted).toBe(0);
    const out = (messages[2] as { content: string }).content;
    expect(out).toContain("src/critical.ts");
    expect(out.length).toBe(content.length);
  });

  it("不可逆动作回执硬保护:edit_file 超大结果也不剪", () => {
    const { compacted } = microcompactMessages(oneTool("edit_file", "y".repeat(HUGE_RESULT_CHARS + 500), { path: "src/a.ts" }));
    expect(compacted).toBe(0);
  });

  it("无寻址结果硬保护:不可回读就不剪", () => {
    const { compacted, messages } = microcompactMessages(oneTool("read_file", "z".repeat(HUGE_RESULT_CHARS + 500), {}));
    expect(compacted).toBe(0);
    expect((messages[2] as { content: string }).content).toHaveLength(HUGE_RESULT_CHARS + 500);
  });

  it("错误扫描全量:中段 ERROR(不在头尾采样窗口)也硬保护", () => {
    const content = "a".repeat(60_000) + "\nERROR: critical middle\n" + "b".repeat(60_000);
    const { messages, compacted } = microcompactMessages(oneTool("terminal", content, { command: "run" }));
    expect(compacted).toBe(0);
    expect((messages[2] as { content: string }).content).toContain("critical middle");
  });

  it("ENOENT 错误结果不被 supersede", () => {
    const old = "ENOENT: no such file or directory, open '/x'";
    const msgs: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c0", name: "read_file", arguments: JSON.stringify({ path: "src/missing.ts" }) }] },
      { role: "tool", toolCallId: "c0", content: old },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "src/missing.ts" }) }] },
      { role: "tool", toolCallId: "c1", content: "now exists" },
    ];
    const r = microcompactMessages(msgs);
    expect(r.compacted).toBe(0);
    expect((r.messages[2] as { content: string }).content).toBe(old);
  });

  it("grep 的 pattern 参与寻址:不同 pattern 不互相取代", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c0", name: "grep", arguments: JSON.stringify({ pattern: "TODO", path: "src" }) }] },
      { role: "tool", toolCallId: "c0", content: "src/a.ts:1: TODO" },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c1", name: "grep", arguments: JSON.stringify({ pattern: "FIXME", path: "src" }) }] },
      { role: "tool", toolCallId: "c1", content: "src/b.ts:9: FIXME" },
    ];
    const r = microcompactMessages(msgs);
    expect(r.compacted).toBe(0);
    expect((r.messages[2] as { content: string }).content).toContain("TODO");
    expect((r.messages[4] as { content: string }).content).toContain("FIXME");
  });

  it("grep 同 pattern+path 才取代", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c0", name: "grep", arguments: JSON.stringify({ pattern: "TODO", path: "src" }) }] },
      { role: "tool", toolCallId: "c0", content: "old match" },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c1", name: "grep", arguments: JSON.stringify({ pattern: "TODO", path: "src" }) }] },
      { role: "tool", toolCallId: "c1", content: "new match" },
    ];
    const r = microcompactMessages(msgs);
    expect(r.compacted).toBe(1);
    expect(r.pruned?.[0]?.action).toBe("superseded");
    expect((r.messages[2] as { content: string }).content).toContain("已被后续同类调用取代");
  });

  it("dedup:相同 tool+寻址+内容的旧结果折叠,只留最新", () => {
    const content = "same-" + "x".repeat(1_000);
    const msgs: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c0", name: "read_file", arguments: JSON.stringify({ path: "src/same.ts" }) }] },
      { role: "tool", toolCallId: "c0", content },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "src/same.ts" }) }] },
      { role: "tool", toolCallId: "c1", content },
    ];
    const r = microcompactMessages(msgs);
    expect(r.compacted).toBe(1);
    expect(r.pruned?.[0]?.action).toBe("dedup");
    expect((r.messages[2] as { content: string }).content).toContain("已去重");
    expect((r.messages[4] as { content: string }).content).toBe(content);
  });

  it("supersede:同路径不同内容的旧 read_file 被后续调用取代", () => {
    const msgs: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c0", name: "read_file", arguments: JSON.stringify({ path: "src/change.ts" }) }] },
      { role: "tool", toolCallId: "c0", content: "old-" + "a".repeat(1_000) },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "src/change.ts" }) }] },
      { role: "tool", toolCallId: "c1", content: "new-" + "b".repeat(1_000) },
    ];
    const r = microcompactMessages(msgs);
    expect(r.compacted).toBe(1);
    expect(r.pruned?.[0]?.action).toBe("superseded");
    expect((r.messages[2] as { content: string }).content).toContain("已被后续同类调用取代");
    expect((r.messages[4] as { content: string }).content).toContain("new-");
  });

  it("supersede 不碰错误结果:旧 traceback 保留", () => {
    const old = "Traceback (most recent call last):\n" + "e".repeat(1_000);
    const msgs: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c0", name: "read_file", arguments: JSON.stringify({ path: "src/err.ts" }) }] },
      { role: "tool", toolCallId: "c0", content: old },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "src/err.ts" }) }] },
      { role: "tool", toolCallId: "c1", content: "now-ok-" + "x".repeat(1_000) },
    ];
    const r = microcompactMessages(msgs);
    expect(r.compacted).toBe(0);
    expect((r.messages[2] as { content: string }).content).toBe(old);
  });

  it("per-tool cap:自定义阈值让较小结果也走 head/tail", () => {
    const content = "cap-" + "x".repeat(2_500);
    const msgs = oneTool("read_file", content, { path: "src/cap.ts" });
    expect(microcompactMessages(msgs).compacted).toBe(0); // 默认 8KB 不触发
    const r = microcompactMessages(msgs, { toolCaps: { read_file: 2_000 } });
    expect(r.compacted).toBe(1);
    expect(r.pruned?.[0]?.action).toBe("head_tail");
    expect((r.messages[2] as { content: string }).content).toContain("已精炼");
  });

  it("modelKeep:高置信度 keep 让超大结果逐字保留", () => {
    const content = "keep-" + "x".repeat(HUGE_RESULT_CHARS + 500);
    const r = microcompactMessages(oneTool("read_file", content, { path: "src/keep.ts" }), {
      modelKeep: new Set(["c0"]),
    });
    expect(r.compacted).toBe(0);
    expect((r.messages[2] as { content: string }).content).toBe(content);
  });

  it("modelDrop:温区结果强制压到 2KB;最近 6 条热区不碰", () => {
    const warm: Message[] = [
      ...oneTool("read_file", "drop-" + "x".repeat(5_000), { path: "src/drop.ts" }),
      ...Array.from({ length: 6 }, (_, i) => ({ role: "user" as const, content: `pad${i}` })),
    ];
    const dropped = microcompactMessages(warm, { modelDrop: new Set(["c0"]) });
    expect(dropped.compacted).toBe(1);
    expect(dropped.pruned?.[0]?.action).toBe("model_drop");
    const droppedText = (dropped.messages[2] as { content: string }).content;
    expect(droppedText).toContain("调用已发生");
    expect(droppedText).toContain("有效内容未保留");
    expect(droppedText).toContain("src/drop.ts");
    expect(droppedText).not.toContain("已精炼");
    expect(droppedText.length).toBeLessThan(500);
    // 占位符不得被下一次 microcompact 再剪/再计数
    expect(microcompactMessages(dropped.messages, { modelDrop: new Set(["c0"]) }).compacted).toBe(0);

    const recent: Message[] = [
      { role: "user", content: "q" },
      ...Array.from({ length: 5 }, (_, i) => ({ role: "user" as const, content: `pad${i}` })),
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c0", name: "read_file", arguments: JSON.stringify({ path: "src/recent.ts" }) }] },
      { role: "tool", toolCallId: "c0", content: "recent-" + "y".repeat(5_000) },
    ];
    const kept = microcompactMessages(recent, { modelDrop: new Set(["c0"]) });
    expect(kept.compacted).toBe(0);
    expect((kept.messages.at(-1) as { content: string }).content).toContain("recent-");
  });

  it("manifest/pruned/savedTokens:折叠清单可注入、可按 toolCallId 回查", () => {
    const r = microcompactMessages(oneTool("read_file", "m".repeat(HUGE_RESULT_CHARS + 100), { path: "src/big.ts" }));
    expect(r.compacted).toBe(1);
    expect(r.pruned?.[0]?.toolCallId).toBe("c0");
    expect(r.pruned?.[0]?.tool).toBe("read_file");
    expect(r.manifest).toContain("[上下文清单]");
    expect(r.manifest).toContain("src/big.ts");
    expect(r.savedTokens ?? 0).toBeGreaterThan(0);
  });

  it("shouldAggressivePrune:只在有基线且超过阈值时触发", () => {
    expect(shouldAggressivePrune(50_000, 30_000, 12_000)).toBe(true);
    expect(shouldAggressivePrune(40_000, 30_000, 12_000)).toBe(false);
    expect(shouldAggressivePrune(50_000, undefined, 12_000)).toBe(false);
    expect(shouldAggressivePrune(50_000, 30_000, 0)).toBe(false);
  });
});

describe("Phase 0:增长突增主链路", () => {
  it("单步新增超阈值:落 context.growth", async () => {
    const journal = new MemoryJournal();
    journal.append({ kind: "message.user", sessionId: "s-growth", payload: { text: "go" } });
    let calls = 0;
    const tool: Tool = {
      name: "read_file", description: "", parameters: {},
      async execute() { return "z".repeat(10_000); },
    };
    const llm: LlmProvider = {
      async chat() {
        calls += 1;
        if (calls === 1) {
          return { content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "src/huge.ts" }) }] };
        }
        return { content: "done" };
      },
    };
    const loop = new AgentLoop({
      journal, sessionId: "s-growth", system: "sys", llm, tools: [tool],
      microcompact: { thresholdTokens: 1_000_000 },
      growthSpurtTokens: 100,
      aggressiveKeepRecent: 2,
    });
    await loop.runTurn("go");
    const growth = journal.readAll().filter((e) => e.kind === "context.growth");
    expect(growth.length).toBeGreaterThan(0);
    expect(Number((growth[0]!.payload as { growth: number }).growth)).toBeGreaterThan(0);
  });

  it("增长突增不只落事件:11 组时按 aggressiveKeepRecent=2 真清 9 组、保留最近 2 组", async () => {
    const journal = new MemoryJournal();
    const sid = "s-growth-effect";
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "q" } });
    for (let i = 0; i < 10; i++) {
      journal.append({
        kind: "message.agent", sessionId: sid,
        payload: { text: "", toolCalls: [{ id: `g${i}`, name: "read_file", arguments: JSON.stringify({ path: `src/g${i}.ts` }) }] },
      });
      journal.append({ kind: "tool.result", sessionId: sid, payload: { toolCallId: `g${i}`, content: `结果${i}:` + "x".repeat(2_000) } });
    }
    const calls: Message[][] = [];
    const llm: LlmProvider = {
      async chat(messages) {
        calls.push(messages.map((m) => ({ ...m })));
        if (calls.length === 1) {
          return { content: "", toolCalls: [{ id: "c-new", name: "read_file", arguments: JSON.stringify({ path: "src/new.ts" }) }] };
        }
        return { content: "done" };
      },
    };
    const tool: Tool = {
      name: "read_file", description: "", parameters: {},
      async execute() { return "new:" + "z".repeat(1_000); }, // 小结果:新组本身也进入候选,才能验证 keepRecent=2
    };
    const loop = new AgentLoop({
      journal, sessionId: sid, system: "sys", llm, tools: [tool],
      microcompact: { thresholdTokens: 1_000_000, keepRecent: 5 },
      growthSpurtTokens: 100,
      aggressiveKeepRecent: 2,
    });
    await loop.runTurn("go");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const second = calls[1]!;
    // 第二请求:system[0] user[1] 组 i 的 tool 下标 = 3+2i;前 9 组应被清,组 9 保留。
    // (ephemeral 块 P0-1 紧接 system → 历史右移;按实际前缀算偏移)
    const off2 = second[1] && String((second[1] as { content: string }).content).startsWith("[系统提醒]") ? 1 : 0;
    expect((second[off2 + 3] as { content: string }).content).toContain("已清除");
    expect((second[off2 + 3 + 2 * 8] as { content: string }).content).toContain("已清除");
    expect((second[off2 + 3 + 2 * 9] as { content: string }).content).toContain("结果9:");
    expect(journal.readAll().some((e) => e.kind === "context.growth")).toBe(true);
  });
});

describe("CJK 感知 token 估算(2026-11-04 档位落地)", () => {
  it("estimateTokensOfText:自有启发式口径(CJK 1.95/其它 0.25,ceil)", () => {
    expect(estimateTokensOfText("")).toBe(0);
    expect(estimateTokensOfText("abcd")).toBe(1);
    expect(estimateTokensOfText("中文中文")).toBe(8);
    expect(estimateTokensOfText("中文abcd")).toBe(5);
    // 汉字类仍显著高于 chars/4(8 字 16 tok),纯 ASCII 口径会算成 2 tok
    expect(estimateTokensOfText("中文中文中文中文")).toBe(16);
  });

  it("negative:纯 ASCII 重复字符按 0.25/字(4 字符 1 token)", () => {
    const ascii = "x".repeat(4_000);
    expect(estimateTokensOfText(ascii)).toBe(1_000);
  });

  it("中文 tool 结果在旧口径下被漏剪、新口径下能进入组清理(阈值触发率提升的机制锚)", () => {
    // 造 8 组中文大结果(每组 3000 汉字;内容各不相同,避免全量去重先把它们折叠)
    const zh = (i: number): Message[] => [
      { role: "assistant" as never, content: "", toolCalls: [{ id: `z${i}`, name: "read_file", arguments: JSON.stringify({ path: `src/中${i}.ts`, offset: 1, limit: 500 }) }] },
      { role: "tool", toolCallId: `z${i}`, content: `第${i}组:` + "中".repeat(3_000) },
    ];
    const msgs: Message[] = [{ role: "user", content: "q" }];
    for (let i = 0; i < 8; i++) msgs.push(...zh(i));
    const est = estimateMessagesTokens(msgs);
    // 旧口径(chars/4)估 ≈6,100;新口径 ≈2.3 万——同一阈值 20,000 在旧口径下「低于阈值」不触发
    expect(est).toBeGreaterThan(15_000);
    expect(microcompactMessages(msgs, { thresholdTokens: 20_000 }).reason).toBe("applied");
    expect(microcompactMessages(msgs, { thresholdTokens: 60_000 }).reason).toBe("below-threshold");
  });
});

describe("读侧历史裁剪(2026-11-03):arguments 计入估算 / 写入正文摘要 / 全量去重", () => {
  const BODY = (tag: string, n = 10_000): string => tag + "x".repeat(n);

  function writeCall(id: string, path: string, content: string): Message {
    return {
      role: "assistant" as never, content: "",
      toolCalls: [{ id, name: "write_file", arguments: JSON.stringify({ path, content }) }],
    };
  }

  it("positive:含 10KB write_file arguments 的 assistant 消息计入估算(≥1000 tok 差)", () => {
    const plain: Message[] = [
      { role: "user", content: "q" },
      writeCall("c0", "src/big.ts", BODY("body-", 10_000)),
    ];
    // 同结构但参数只有 path(arguments 极小):模拟"不计 arguments"的旧口径上界
    const tiny: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant" as never, content: "", toolCalls: [{ id: "c0", name: "write_file", arguments: JSON.stringify({ path: "src/big.ts" }) }] },
    ];
    const withArgs = estimateMessagesTokens(plain);
    const withoutArgs = estimateMessagesTokens(tiny);
 // 自有估算口径:10KB 重复字符 arguments ≈2500 tok(0.25/字)。
    // (旧系数按 4 字符 1 token 估 ≈2500)。
    expect(withArgs - withoutArgs).toBeGreaterThanOrEqual(1_000);
    // 旧口径(content-only)会把它算成 ~0
    const contentOnly = Math.ceil(("").length / 4);
    expect(withArgs).toBeGreaterThan(contentOnly + 1_000);
  });

  it("positive:3 条 write_file 仅最近 1 条保留完整正文,前 2 条摘要且 path 仍在、JSON 可解析", () => {
    const msgs: Message[] = [{ role: "user", content: "q" }];
    for (let i = 0; i < 3; i++) {
      msgs.push(writeCall(`w${i}`, `src/w${i}.ts`, BODY(`body${i}-`)));
      msgs.push({ role: "tool", toolCallId: `w${i}`, content: `已创建 src/w${i}.ts(10000 字节)` });
    }
    const r = microcompactMessages(msgs);
    const summarized = r.pruned?.filter((p) => p.action === "args_summarized") ?? [];
    expect(summarized.length).toBe(2);
    for (let i = 0; i < 2; i++) {
      const aMsg = r.messages[1 + i * 2] as { toolCalls: { arguments: string }[] };
      const args = JSON.parse(aMsg.toolCalls[0]!.arguments) as { path: string; content: string };
      expect(args.path).toBe(`src/w${i}.ts`); // toolWhere 寻址必须还在
      expect(args.content).toContain("历史正文已省略");
      expect(args.content).not.toContain("body"); // 正文已移除
    }
    const last = JSON.parse((r.messages[5] as never as { toolCalls: { arguments: string }[] }).toolCalls[0]!.arguments) as { content: string };
    expect(last.content).toContain("body2-"); // 最近 1 条逐字保留
  });

  it("positive:2 个内容相同的写工具回执 → 只保最后一份,两个 toolCallId 都在", () => {
    const receipt = "已覆写 src/same.ts(1234 字节)";
    const msgs: Message[] = [
      { role: "user", content: "q" },
      writeCall("a1", "src/same.ts", BODY("one-", 2_000)),
      { role: "tool", toolCallId: "a1", content: receipt },
      writeCall("a2", "src/same.ts", BODY("two-", 2_000)),
      { role: "tool", toolCallId: "a2", content: receipt },
      // 副本须滑出热区(见 DEDUP_MIN_AGE_MESSAGES):去重绝不改写靠近末尾的历史,
      // 否则每来一次重复就改一次历史中段 → 前缀缓存全失效(token 轮正是要省这个)。
      ...Array.from({ length: 8 }, (_, i) => ({ role: "user" as const, content: `pad${i}` })),
    ];
    const r = microcompactMessages(msgs);
    const dedupItem = r.pruned?.find((p) => p.action === "dedup");
    expect(dedupItem?.toolCallId).toBe("a1");
    expect(dedupItem?.tool).toBe("write_file");
    expect((r.messages[2] as { content: string }).content).toContain("已去重");
    expect((r.messages[4] as { content: string }).content).toBe(receipt);
    // toolCallId 配对不破
    expect((r.messages[2] as { toolCallId: string }).toolCallId).toBe("a1");
    expect((r.messages[4] as { toolCallId: string }).toolCallId).toBe("a2");
  });

  it("negative:journal 原文(deriveMessages 输入)逐字不变", () => {
    const journal = new MemoryJournal();
    const sid = "s-trim";
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "q" } });
    journal.append({
      kind: "message.agent", sessionId: sid,
      payload: { text: "", toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: "src/j1.ts", content: BODY("j1-") }) }] },
    });
    journal.append({ kind: "tool.result", sessionId: sid, payload: { toolCallId: "w1", content: "已创建 src/j1.ts(10000 字节)" } });
    journal.append({
      kind: "message.agent", sessionId: sid,
      payload: { text: "", toolCalls: [{ id: "w2", name: "write_file", arguments: JSON.stringify({ path: "src/j2.ts", content: BODY("j2-") }) }] },
    });
    journal.append({ kind: "tool.result", sessionId: sid, payload: { toolCallId: "w2", content: "已创建 src/j1.ts(10000 字节)" } });

    const before = JSON.stringify(journal.readAll());
    const derived = deriveMessages(journal, sid);
    const derivedBefore = JSON.stringify(derived);
    const r = microcompactMessages(derived);
    expect(r.compacted).toBeGreaterThan(0); // 确实做了裁剪
    expect(JSON.stringify(journal.readAll())).toBe(before); // journal 原文逐字不动
    expect(JSON.stringify(derived)).toBe(derivedBefore); // 输入副本也不被原地改
  });

  it("negative:摘要/占位不会被二次处理(两次输出逐字节相同)", () => {
    const msgs: Message[] = [{ role: "user", content: "q" }];
    for (let i = 0; i < 3; i++) {
      msgs.push(writeCall(`w${i}`, `src/d${i}.ts`, BODY(`d${i}-`)));
      msgs.push({ role: "tool", toolCallId: `w${i}`, content: "已创建 same.ts(10000 字节)" });
    }
    const first = microcompactMessages(msgs);
    const second = microcompactMessages(first.messages);
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages));
    expect(second.compacted).toBe(0);
  });

  it("negative:两个开关都置 false → 输出与改前逐字节一致", () => {
    const msgs: Message[] = [{ role: "user", content: "q" }];
    for (let i = 0; i < 3; i++) {
      msgs.push(writeCall(`w${i}`, `src/off${i}.ts`, BODY(`off${i}-`)));
      msgs.push({ role: "tool", toolCallId: `w${i}`, content: "已创建 same.ts(10000 字节)" });
    }
    const off = microcompactMessages(msgs, { summarizeWriteArgs: false, dedupAnyTool: false });
    expect(off.compacted).toBe(0);
    expect(JSON.stringify(off.messages)).toBe(JSON.stringify(msgs));
  });

 // ---- 净收益门:裁历史中段会作废前缀缓存,省得不够就不裁 ----
  function longHistory(turns: number): Message[] {
    const msgs: Message[] = [{ role: "user", content: "q" }];
    for (let i = 0; i < turns; i++) {
      msgs.push({ role: "assistant" as never, content: "", toolCalls: [{ id: `r${i}`, name: "read_file", arguments: JSON.stringify({ path: `src/f${i}.ts` }) }] });
      // 内容各不相同(否则会被 dedup 折叠,省得太多,反而过门)
      msgs.push({ role: "tool", toolCallId: `r${i}`, content: `f${i}:` + "x".repeat(2000) });
    }
    // 需要 ≥2 条候选才触发摘要(最近 1 条保留全文);三者都 ≥400 字符
    msgs.push(writeCall("w0", "src/a.ts", "y".repeat(800) + BODY("a-", 3000)));
    msgs.push({ role: "tool", toolCallId: "w0", content: "已创建 src/a.ts" });
    msgs.push(writeCall("w1", "src/b.ts", BODY("b-")));
    msgs.push({ role: "tool", toolCallId: "w1", content: "已创建 src/b.ts" });
    msgs.push(writeCall("w2", "src/c.ts", BODY("c-")));
    msgs.push({ role: "tool", toolCallId: "w2", content: "已创建 src/c.ts" });
    return msgs;
  }

  it("净收益门 positive:前缀 20k 字符、只能省 800 → 判定净亏,历史逐字不变", () => {
    const msgs = longHistory(10);
    const r = microcompactMessages(msgs);
    expect(r.compacted).toBe(0);
    expect(r.reason).toBe("break-even-skip");
    expect(r.skipped).toContain("净收益不足");
    expect(JSON.stringify(r.messages)).toBe(JSON.stringify(msgs));
  });

  it("净收益门 negative:breakEvenGate:false → 恢复旧行为,照样裁", () => {
    const msgs = longHistory(10);
    const r = microcompactMessages(msgs, { breakEvenGate: false });
    expect(r.compacted).toBeGreaterThan(0);
    expect(r.pruned?.some((p) => p.action === "args_summarized")).toBe(true);
  });

  it("净收益门 positive:前缀很小时省得划算 → 照裁", () => {
    const msgs: Message[] = [{ role: "user", content: "q" }];
    msgs.push(writeCall("w0", "src/a.ts", "y".repeat(800)));
    msgs.push({ role: "tool", toolCallId: "w0", content: "已创建 src/a.ts" });
    msgs.push(writeCall("w1", "src/b.ts", BODY("b-")));
    msgs.push({ role: "tool", toolCallId: "w1", content: "已创建 src/b.ts" });
    const r = microcompactMessages(msgs);
    expect(r.compacted).toBeGreaterThan(0);
  });

  it("净收益门 positive:superseded 属正确性裁剪 → 即使净亏也照做", () => {
    const msgs = longHistory(10);
    const args = JSON.stringify({ pattern: "TODO", path: "src" });
    msgs.push({ role: "assistant" as never, content: "", toolCalls: [{ id: "g0", name: "grep", arguments: args }] });
    msgs.push({ role: "tool", toolCallId: "g0", content: "old match" });
    msgs.push({ role: "assistant" as never, content: "", toolCalls: [{ id: "g1", name: "grep", arguments: args }] });
    msgs.push({ role: "tool", toolCallId: "g1", content: "new match" });
    const r = microcompactMessages(msgs);
    expect(r.pruned?.some((p) => p.action === "superseded")).toBe(true);
  });
});

describe("cache-aware 前缀稳定策略 v2(2026-11-06:append-only 为主 + 1~2% 预算)", () => {
  /** 10 组历史(每组 ~2KB 结果;est ≈ 5.2k tok)。 */
  const history = (n: number): Message[] => [
    { role: "user", content: "q" },
    ...Array.from({ length: n }, (_, i) => toolGroup(i, "read_file", 2_000)).flat(),
  ];
  /** 小批量档:真实缺省(110k 门槛 / 20k 削减量)在单测里够不着,按比例缩小,语义不变。
   *  **冷却缺省不缩**(50k tok / 20 步):单测上下文只有 ~5k,天然落在冷却期内——这正是 v2 要的常态。 */
  const cfg = (
    over: Partial<MicrocompactConfig> = {},
    state: MicrocompactPolicyState = {},
  ): MicrocompactConfig => ({
    thresholdTokens: 1_000,
    keepRecent: 5,
    minContextTokens: 1_000,
    pruneMinBatchTokens: 300,
    assumedRemainingCalls: 10,
    policyState: state,
    ...over,
  });

  it("小上下文不剪:est 低于门槛 → low-context-skip,消息逐字不变", () => {
    const msgs = history(10);
    const r = microcompactMessages(msgs, cfg({ minContextTokens: 1_000_000 }));
    expect(r.policy).toBe("low-context-skip");
    expect(r.compacted).toBe(0);
    expect(r.skipped).toContain("门槛");
    expect(JSON.stringify(r.messages)).toBe(JSON.stringify(msgs));
  });

  it("重置水位:单次削减 ≤上下文的 20%(禁 250k→160k 大跳),重置后仍高于阈值×88%", () => {
    const msgs = history(10);
    const r = microcompactMessages(msgs, cfg({}, { clock: 1, turnStart: true }));
    expect(r.policy).toBe("reset");
    expect(r.prefixBreak).toBe(true);
    expect(r.compacted).toBeGreaterThan(0);
    expect(r.planCount).toBe(r.compacted);
    expect(r.frozenCount).toBeGreaterThan(0);
    expect(r.anchor).toBeTruthy();
    expect(r.cutTokens!).toBeLessThanOrEqual(Math.floor(r.contextTokensBefore! * 0.2));
    expect(r.contextTokensAfter!).toBeGreaterThanOrEqual(880); // 阈值 × 88% 基线
  });

  it("连续 5 步:重置后冷却期内不再动前缀,请求逐字相同", () => {
    const msgs = history(10);
    const first = microcompactMessages(msgs, cfg({}, { clock: 1, turnStart: true }));
    expect(first.policy).toBe("reset");
    const baseline = JSON.stringify(first.messages);
    const state: MicrocompactPolicyState = {
      clock: 1,
      lastResetClock: 1,
      lastResetTokens: first.contextTokensAfter,
      frozenCount: first.frozenCount,
      frozenAnchor: first.anchor,
      resetsThisTurn: 1,
    };
    const policies: string[] = [];
    for (let step = 2; step <= 5; step++) {
      const r = microcompactMessages(msgs, cfg({}, { ...state, clock: step }));
      policies.push(r.policy ?? "");
      // 冻结区逐字重放 → 与上一步请求完全相同(公共前缀 100% 保持)
      expect(JSON.stringify(r.messages)).toBe(baseline);
      expect(r.prefixBreak).toBe(false);
    }
    expect(policies).toEqual(["cooldown-skip", "cooldown-skip", "cooldown-skip", "cooldown-skip"]);
  });

  it("冷却过期(步数)后允许再重置,冻结区前移(集合变大)", () => {
    const first = microcompactMessages(history(10), cfg({}, { clock: 1, turnStart: true }));
    const r = microcompactMessages(history(20), cfg({ resetCooldownSteps: 3 }, {
      clock: 6,
      lastResetClock: 1,
      lastResetTokens: first.contextTokensAfter,
      frozenCount: first.frozenCount,
      frozenAnchor: first.anchor,
      resetsThisTurn: 0,
    }));
    expect(r.policy).toBe("reset");
    expect(r.frozenCount!).toBeGreaterThan(first.frozenCount!);
  });

  it("同一 turn 重置上限 ≤1:第二次被 turn-cap-skip 拦下", () => {
    const first = microcompactMessages(history(20), cfg({}, { clock: 1, turnStart: true }));
    const r = microcompactMessages(history(20), cfg({ resetCooldownSteps: 1 }, {
      clock: 2,
      lastResetClock: 1,
      lastResetTokens: first.contextTokensAfter,
      frozenCount: first.frozenCount,
      frozenAnchor: first.anchor,
      resetsThisTurn: 1,
    }));
    expect(r.policy).toBe("turn-cap-skip");
    expect(r.prefixBreak).toBe(false);
    expect(JSON.stringify(r.messages.slice(0, r.frozenCount ?? 0)))
      .toBe(JSON.stringify(first.messages.slice(0, r.frozenCount ?? 0)));
  });

  it("增长突增档:装配方显式配置时按 keepRecent 清到窗口外(不受冷却约束)", () => {
    const r = microcompactMessages(history(10), cfg({ keepRecent: 2 }, { clock: 3, turnStart: true, force: true }));
    expect(r.policy).toBe("growth-spurt");
    expect(r.prefixBreak).toBe(true);
    // 9 组候选(1 组被 keepRecent 之外的窗口保留 → 实际清到只剩最近 2 组)
    expect(r.compacted).toBeGreaterThanOrEqual(7);
  });

  it("收益不划算 → benefit-skip(省下的 ×保守剩余次数 < 一次前缀失效成本)", () => {
    const msgs = history(10);
    const r = microcompactMessages(msgs, cfg({ assumedRemainingCalls: 1 }, { clock: 1, turnStart: true }));
    expect(r.policy).toBe("benefit-skip");
    expect(r.compacted).toBe(0);
    expect(r.skipped).toContain("不划算");
    expect(JSON.stringify(r.messages)).toBe(JSON.stringify(msgs));
  });

  it("安全边界不动:错误结果与最近 keepRecent 组即使重置也不清", () => {
    const msgs: Message[] = [{ role: "user", content: "q" }];
    for (let i = 0; i < 12; i++) msgs.push(...toolGroup(i, "read_file", 2_000));
    // 组 2 换成错误结果(硬保护):user 在 0,组 i 的 assistant=1+2i、tool=2+2i
    const errIdx = 2 + 2 * 2;
    msgs[errIdx] = { role: "tool", toolCallId: "c2", content: "错误:路径非法\n" + "x".repeat(2_000) };
    const r = microcompactMessages(msgs, cfg({}, { clock: 1, turnStart: true }));
    expect(r.policy).toBe("reset");
    expect(String((r.messages[errIdx] as { content: string }).content)).toContain("错误:路径非法");
    // 最近 5 组(组 7..11)保留原文
    for (let i = 7; i < 12; i++) {
      const idx = 2 + 2 * i;
      expect(String((r.messages[idx] as { content: string }).content)).toContain(`结果${i}:`);
    }
  });

  it("回放 step49/step84 形态:20 步里重置 ≤3 次,其余步请求前缀逐字不变(无锯齿)", () => {
    // 每步新增一组(read_file 结果),共 20 步;模拟「derive 每步重建 + 策略状态跨步传递」。
    const steps: Message[][] = [];
    const policies: string[] = [];
    const breaks: boolean[] = [];
    let anchor: string | undefined;
    let frozenCount: number | undefined;
    let lastResetClock: number | undefined;
    let lastResetTokens: number | undefined;
    let resetsThisTurn = 0;
    for (let step = 1; step <= 20; step++) {
      const msgs = history(6 + step);
      const turnStart = step === 1 || step === 11;
      if (turnStart) resetsThisTurn = 0;
      const state: MicrocompactPolicyState = {
        clock: step,
        turnStart,
        frozenCount,
        resetsThisTurn,
        ...(lastResetClock !== undefined ? { lastResetClock } : {}),
        ...(lastResetTokens !== undefined ? { lastResetTokens } : {}),
        ...(anchor ? { frozenAnchor: anchor } : {}),
      };
      const r = microcompactMessages(msgs, cfg({ resetCooldownSteps: 20 }, state));
      steps.push(r.messages);
      policies.push(r.policy ?? "");
      breaks.push(r.prefixBreak === true);
      if (r.prefixBreak) {
        lastResetClock = step;
        lastResetTokens = r.contextTokensAfter;
        resetsThisTurn += 1;
      }
      if (r.frozenCount !== undefined) frozenCount = r.frozenCount;
      if (r.anchor) anchor = r.anchor;
    }
    // 重置次数远少于步数(旧行为=每步一次改写历史中段)
    expect(policies.filter((p) => p === "reset" || p === "growth-spurt").length).toBeLessThanOrEqual(3);
    expect(breaks.filter(Boolean).length).toBeLessThanOrEqual(3);
    // 相邻两步公共前缀:重置步可断,其余步已有部分必须逐字相同
    for (let i = 1; i < steps.length; i++) {
      if (breaks[i]) continue;
      const prev = steps[i - 1]!;
      const cur = steps[i]!;
      for (let k = 0; k < prev.length; k++) expect(JSON.stringify(cur[k])).toBe(JSON.stringify(prev[k]));
    }
  });
});
