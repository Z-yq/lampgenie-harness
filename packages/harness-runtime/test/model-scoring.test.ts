import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, type LlmProvider, type Message as LoopMessage } from "../src/agent/loop";
import {
  buildModelDecisionSets,
  collectScoringCandidates,
  DEFAULT_MODEL_SCORING,
  goalFromMessages,
  MIN_SCORING_CANDIDATES,
  MIN_SCORING_TOTAL_CHARS,
  modelScoringCacheSize,
  resetModelScoringCache,
  resolveModelScoringConfig,
  scoreContextCandidates,
  scoringContentKey,
  scoringSkipReason,
  SCORING_CACHE_CAPACITY,
  SCORING_CACHE_TTL_MS,
  shouldScoreStep,
  type ScoringCandidate,
  type ScoringDecision,
} from "../src/agent/model-scoring";
import type { Message } from "../src/agent/loop";

const jevAnswer = (truth: number) => ({
  label: truth >= 0.5 ? "true" : "false",
  confidence: Math.max(truth, 1 - truth),
  probabilities: { true: truth, false: 1 - truth },
});

describe("model-scoring:默认本地 150M / 其它 provider", () => {
  it("默认值指向本地 150M Jev(/decide)", () => {
    const c = resolveModelScoringConfig(undefined);
    expect(c.mode).toBe("shadow");
    expect(c.providerUrl).toBe("http://127.0.0.1:8105");
    expect(c.model).toBe("jev-150m");
    expect(c.apiType).toBe("jev");
    expect(DEFAULT_MODEL_SCORING.maxCandidates).toBe(12);
  });

  it("候选只取温区:最近 6 条、认知/错误/不可读不送", () => {
    const messages: Message[] = [
      { role: "user", content: "目标" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) }] },
      { role: "tool", toolCallId: "c1", content: "ok-" + "x".repeat(2_000) },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "code_sense", arguments: JSON.stringify({ target: "foo" }) }] },
      { role: "tool", toolCallId: "c2", content: "认知结果" },
      { role: "assistant", content: "", toolCalls: [{ id: "c3", name: "terminal", arguments: JSON.stringify({ command: "npm test" }) }] },
      { role: "tool", toolCallId: "c3", content: "Traceback (most recent call last):\nError: boom" },
      { role: "assistant", content: "", toolCalls: [{ id: "c5", name: "read_file", arguments: JSON.stringify({ path: "src/cn.ts" }) }] },
      { role: "tool", toolCallId: "c5", content: "错误:路径非法或越出项目根" },
      { role: "assistant", content: "", toolCalls: [{ id: "c6", name: "terminal", arguments: JSON.stringify({ command: "x" }) }] },
      { role: "tool", toolCallId: "c6", content: '{"ok":false,"error":"boom"}' },
      { role: "user", content: "最近1" },
      { role: "user", content: "最近2" },
      { role: "user", content: "最近3" },
      { role: "assistant", content: "", toolCalls: [{ id: "c4", name: "read_file", arguments: JSON.stringify({ path: "src/recent.ts" }) }] },
      { role: "tool", toolCallId: "c4", content: "recent" },
    ];
    const out = collectScoringCandidates(messages, 10, 6);
    expect(out.map((c) => c.id)).toEqual(["c1"]); // c2 认知、c3/c5/c6 错误、c4 热区
    expect(out[0]!.tool).toBe("read_file");
    expect(out[0]!.where).toContain("src/a.ts");
    expect(out[0]!.preview.length).toBeLessThanOrEqual(500);
  });

  it("goal 取最近 3 条用户文本,跳过系统提醒", () => {
    const goal = goalFromMessages([
      { role: "user", content: "第一" },
      { role: "user", content: "[系统提醒] 忽略" },
      { role: "user", content: "第二" },
      { role: "user", content: "第三" },
    ]);
    expect(goal).toContain("第一");
    expect(goal).toContain("第二");
    expect(goal).toContain("第三");
    expect(goal).not.toContain("系统提醒");
  });

  it("goal 去掉 message.user 尾部注入的核心纪律卡", () => {
    const goal = goalFromMessages([
      { role: "user", content: "真实任务\n\n## 核心纪律卡(系统纪律;直接执行,不要复述此段)\n- 五阶段流程\n- plan-gate 硬闸" },
    ]);
    expect(goal).toBe("真实任务");
    expect(goal).not.toContain("核心纪律卡");
    expect(goal).not.toContain("plan-gate");
  });

  it("Jev /decide:两问 keepCall/keepResult,按 probabilities.true 取概率", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(Object.keys(body.questions).sort()).toEqual(["call_c1", "result_c1"]);
      return new Response(JSON.stringify({ call_c1: jevAnswer(0.2), result_c1: jevAnswer(0.9) }), { status: 200 });
    }) as typeof fetch;
    const r = await scoreContextCandidates(
      { providerUrl: "http://127.0.0.1:8105", apiType: "jev", fetchImpl },
      [{ id: "c1", tool: "read_file", where: "src/a.ts", chars: 100, preview: "x" }],
      "goal",
    );
    expect(r.error).toBeUndefined();
    expect(calls[0]!.url).toBe("http://127.0.0.1:8105/decide");
    expect(r.decisions[0]).toMatchObject({ id: "c1", keepCall: 0.2, keepResult: 0.9 });
    expect(r.decisions[0]!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(r).toMatchObject({ goalChars: 4, candidateCount: 1, previewChars: 1, questionCount: 2 });
    expect(r.requestBytes).toBeGreaterThan(0);
  });

  it("Jev 默认 12 候选全部发送(24 问);8 问/行分块由批量服务处理", async () => {
    let questionCount = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { questions?: Record<string, unknown> };
      const keys = Object.keys(body.questions ?? {});
      questionCount = keys.length;
      const answers: Record<string, unknown> = {};
      for (const key of keys) {
        answers[key] = jevAnswer(key.startsWith("result_") ? 0.9 : 0.2);
      }
      return new Response(JSON.stringify(answers), { status: 200 });
    }) as typeof fetch;
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `c${i}`, tool: "read_file", where: `src/${i}.ts`, chars: 100, preview: "x",
    }));
    const r = await scoreContextCandidates(
      { providerUrl: "http://127.0.0.1:8105", apiType: "jev", maxCandidates: 12, fetchImpl },
      many,
      "goal",
    );
    expect(r.error).toBeUndefined();
    expect(questionCount).toBe(24); // 不改默认;服务内部按 8 问/行分块
    expect(r.decisions).toHaveLength(12);
  });

  it("OpenAI 兼容 provider:解析 code fence JSON", async () => {
    let seenUrl = "";
    const fetchImpl = (async (url: string | URL | Request) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: "```json\n" + JSON.stringify({
              decisions: [{ id: "c1", keepCall: 0.1, keepResult: 0.05, confidence: 0.95 }],
            }) + "\n```",
          },
        }],
      }), { status: 200 });
    }) as typeof fetch;
    const r = await scoreContextCandidates(
      { providerUrl: "http://127.0.0.1:9000", apiType: "openai", model: "refiner", fetchImpl },
      [{ id: "c1", tool: "read_file", where: "src/a.ts", chars: 100, preview: "x" }],
      "goal",
    );
    expect(seenUrl).toBe("http://127.0.0.1:9000/v1/chat/completions");
    expect(r.decisions[0]).toMatchObject({ id: "c1", keepCall: 0.1, keepResult: 0.05, confidence: 0.95 });
  });

  it("provider 失败 fail-soft:返回 error 不抛", async () => {
    const r = await scoreContextCandidates(
      { providerUrl: "http://127.0.0.1:1", fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch },
      [{ id: "c1", tool: "read_file", where: "src/a.ts", chars: 100, preview: "x" }],
      "goal",
    );
    expect(r.error).toContain("ECONNREFUSED");
    expect(r.decisions).toEqual([]);
  });

  it("shadow 主链路:只写 context.model.score,不改上下文", async () => {
    const journal = new MemoryJournal();
    journal.append({ kind: "message.user", sessionId: "s-shadow", payload: { text: "目标" } });
    journal.append({ kind: "message.agent", sessionId: "s-shadow", payload: { text: "", toolCalls: [{ id: "c0", name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) }] } });
    journal.append({ kind: "tool.result", sessionId: "s-shadow", payload: { toolCallId: "c0", content: "x".repeat(5_000) } });
    // 真实缺口的 loop 级回归:中文错误结果必须被 collectScoringCandidates 过滤。
    journal.append({ kind: "message.agent", sessionId: "s-shadow", payload: { text: "", toolCalls: [{ id: "cErr", name: "read_file", arguments: JSON.stringify({ path: "src/cn.ts" }) }] } });
    journal.append({ kind: "tool.result", sessionId: "s-shadow", payload: { toolCallId: "cErr", content: "错误:路径非法或越出项目根(/tmp/x);只接受项目内相对路径" } });
    for (let i = 0; i < 6; i++) journal.append({ kind: "message.user", sessionId: "s-shadow", payload: { text: `pad${i}` } });
    let seen: LoopMessage[] = [];
    const llm: LlmProvider = { async chat(messages) { seen = messages; return { content: "done" }; } };
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { questions?: Record<string, unknown> };
      const ids = Object.keys(body.questions ?? {}).filter((k) => k.startsWith("call_")).map((k) => k.slice(5));
      const answers: Record<string, unknown> = {};
      for (const id of ids) {
        answers[`call_${id}`] = jevAnswer(0.2);
        answers[`result_${id}`] = jevAnswer(0.9);
      }
      return new Response(JSON.stringify(answers), { status: 200 });
    }) as typeof fetch;
    const loop = new AgentLoop({
      journal, sessionId: "s-shadow", system: "sys", llm,
      modelScoring: { mode: "shadow", providerUrl: "http://test", scoreEverySteps: 1, fetchImpl, minCandidates: 0, minTotalChars: 0 },
    });
    await loop.runTurn("go");
    for (let i = 0; i < 20; i++) {
      if (journal.readAll().some((e) => e.kind === "context.model.score")) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const ev = journal.readAll().find((e) => e.kind === "context.model.score")!;
    expect(ev).toBeTruthy();
    expect((ev.payload as { mode: string }).mode).toBe("shadow");
    expect((ev.payload as { decisions: unknown[] }).decisions).toHaveLength(1);
    expect(ev.payload).toMatchObject({
      candidateCount: 1,
      questionCount: 2,
      previewChars: 500,
      candidates: [{ id: "c0", tool: "read_file" }],
    });
    expect(JSON.stringify((ev.payload as { candidates: unknown[] }).candidates)).not.toContain("cErr");
    expect((ev.payload as { goalChars: number }).goalChars).toBeGreaterThan(0);
    expect((ev.payload as { requestBytes: number }).requestBytes).toBeGreaterThan(0);
    expect(String((ev.payload as { goalHead?: string }).goalHead)).toContain("pad");
    expect(seen.some((m) => String(m.content).includes("x".repeat(5_000)))).toBe(true); // shadow 不改上下文
  });

  it("active 主链路:高置信度 drop 让温区结果被压到 2KB", async () => {
    const journal = new MemoryJournal();
    journal.append({ kind: "message.user", sessionId: "s-active", payload: { text: "目标" } });
    journal.append({ kind: "message.agent", sessionId: "s-active", payload: { text: "", toolCalls: [{ id: "c0", name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) }] } });
    journal.append({ kind: "tool.result", sessionId: "s-active", payload: { toolCallId: "c0", content: "drop-" + "x".repeat(5_000) } });
    for (let i = 0; i < 6; i++) journal.append({ kind: "message.user", sessionId: "s-active", payload: { text: `pad${i}` } });
    let seen: LoopMessage[] = [];
    const llm: LlmProvider = { async chat(messages) { seen = messages; return { content: "done" }; } };
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { questions?: Record<string, unknown> };
      const ids = Object.keys(body.questions ?? {}).filter((k) => k.startsWith("call_")).map((k) => k.slice(5));
      const answers: Record<string, unknown> = {};
      for (const id of ids) {
        answers[`call_${id}`] = jevAnswer(0.1);
        answers[`result_${id}`] = jevAnswer(0.05);
      }
      return new Response(JSON.stringify(answers), { status: 200 });
    }) as typeof fetch;
    const loop = new AgentLoop({
      journal, sessionId: "s-active", system: "sys", llm,
      modelScoring: { mode: "active", providerUrl: "http://test", scoreEverySteps: 1, fetchImpl, minConfidence: 0.9, minCandidates: 0, minTotalChars: 0 },
    });
    await loop.runTurn("go");
    const toolMsg = seen.find((m) => m.role === "tool" && m.toolCallId === "c0")!;
    expect(String(toolMsg.content)).toContain("调用已发生");
    expect(String(toolMsg.content)).toContain("有效内容未保留");
    expect(String(toolMsg.content).length).toBeLessThan(500);
    // 工具调用本身必须在历史里,不能只剩结果占位让 agent 误以为没调用。
    expect(seen.some((m) => m.role === "assistant" && m.toolCalls?.some((c) => c.id === "c0"))).toBe(true);
    const ev = journal.readAll().find((e) => e.kind === "context.model.score")!;
    expect((ev.payload as { mode: string }).mode).toBe("active");
 // 审计口径:生效集合大小与阈值必须落账,否则「评分跑过但零生效」无从查询
    // (旧实现只能靠离线复算 1271 次评分才看出来)。
    expect(ev.payload).toMatchObject({ minConfidence: 0.9, effectiveKeep: 0, effectiveDrop: 1 });
  });

  it("shadow 不阻塞主链:provider 慢 1.5s 时 runTurn 仍在 200ms 内完成", async () => {
    const journal = new MemoryJournal();
    journal.append({ kind: "message.user", sessionId: "s-shadow-fast", payload: { text: "目标" } });
    journal.append({ kind: "message.agent", sessionId: "s-shadow-fast", payload: { text: "", toolCalls: [{ id: "c0", name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) }] } });
    journal.append({ kind: "tool.result", sessionId: "s-shadow-fast", payload: { toolCallId: "c0", content: "x".repeat(5_000) } });
    for (let i = 0; i < 6; i++) journal.append({ kind: "message.user", sessionId: "s-shadow-fast", payload: { text: `pad${i}` } });
    const llm: LlmProvider = { async chat() { return { content: "done" }; } };
    // 模拟慢 provider(审计里 p99 数秒):shadow 必须 void 不 await,否则每步白等。
    const slowFetch = (async () => {
      await new Promise((r) => setTimeout(r, 1_500));
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const loop = new AgentLoop({
      journal, sessionId: "s-shadow-fast", system: "sys", llm,
      modelScoring: { mode: "shadow", providerUrl: "http://test", scoreEverySteps: 1, fetchImpl: slowFetch, minCandidates: 0, minTotalChars: 0 },
    });
    const t0 = Date.now();
    await loop.runTurn("go");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1_500);
    // active 对照:同一慢 provider 必须等(证明上面的快是 shadow 语义带来的,不是计时巧合)。
    const journal2 = new MemoryJournal();
    journal2.append({ kind: "message.user", sessionId: "s-active-slow", payload: { text: "目标" } });
    journal2.append({ kind: "message.agent", sessionId: "s-active-slow", payload: { text: "", toolCalls: [{ id: "c0", name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) }] } });
    journal2.append({ kind: "tool.result", sessionId: "s-active-slow", payload: { toolCallId: "c0", content: "x".repeat(5_000) } });
    for (let i = 0; i < 6; i++) journal2.append({ kind: "message.user", sessionId: "s-active-slow", payload: { text: `pad${i}` } });
    const loop2 = new AgentLoop({
      journal: journal2, sessionId: "s-active-slow", system: "sys", llm,
      modelScoring: { mode: "active", providerUrl: "http://test", scoreEverySteps: 1, fetchImpl: slowFetch, minCandidates: 0, minTotalChars: 0 },
    });
    const t1 = Date.now();
    await loop2.runTurn("go");
    expect(Date.now() - t1).toBeGreaterThanOrEqual(1_400);
  });

  it("scoreEverySteps=50:第 5 步不再评分,50 步才评一次(止损口径)", async () => {
    // 口径表:scoreEverySteps 从 5 → 50 的直接效果(第 0 步的 0%N==0 是既有语义,保留)
    expect(shouldScoreStep(0, { scoreEverySteps: 50 })).toBe(true);
    expect(shouldScoreStep(5, { scoreEverySteps: 50 })).toBe(false);
    expect(shouldScoreStep(49, { scoreEverySteps: 50 })).toBe(false);
    expect(shouldScoreStep(50, { scoreEverySteps: 50 })).toBe(true);
    // 对照旧值:5 步一次
    expect(shouldScoreStep(5, { scoreEverySteps: 5 })).toBe(true);
    // 端到端:同一 turn 内 50 步口径下最多 1 次请求(第 0 步),不再每 5 步打一次
    const calls: number[] = [];
    const fetchImpl = (async () => {
      calls.push(1);
      return new Response(JSON.stringify({}), { status: 500 });
    }) as unknown as typeof fetch;
    const journal = new MemoryJournal();
    journal.append({ kind: "message.user", sessionId: "s-every", payload: { text: "目标" } });
    journal.append({ kind: "message.agent", sessionId: "s-every", payload: { text: "", toolCalls: [{ id: "c0", name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) }] } });
    journal.append({ kind: "tool.result", sessionId: "s-every", payload: { toolCallId: "c0", content: "x".repeat(5_000) } });
    for (let i = 0; i < 6; i++) journal.append({ kind: "message.user", sessionId: "s-every", payload: { text: `pad${i}` } });
    const llm: LlmProvider = { async chat() { return { content: "done" }; } };
    const loop = new AgentLoop({
      journal, sessionId: "s-every", system: "sys", llm,
      modelScoring: { mode: "shadow", providerUrl: "http://test", scoreEverySteps: 50, fetchImpl, minCandidates: 0, minTotalChars: 0 },
    });
    await loop.runTurn("go");
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(1);
  });

  it("keep/drop 集合只收高置信度;低置信/drop 双票不一致都不动作", () => {
    const decisions: ScoringDecision[] = [
      { id: "keep", tool: "read_file", where: "a", keepCall: 0.9, keepResult: 0.95, confidence: 0.95 },
      { id: "drop", tool: "read_file", where: "b", keepCall: 0.1, keepResult: 0.05, confidence: 0.95 },
      { id: "low", tool: "read_file", where: "c", keepCall: 0.5, keepResult: 0.9, confidence: 0.6 },
      // call 仍要留、result 可丢:不能据此压掉唯一结果
      { id: "call-only", tool: "read_file", where: "d", keepCall: 0.95, keepResult: 0.05, confidence: 0.95 },
    ];
    const sets = buildModelDecisionSets(decisions, 0.9);
    expect([...sets.keep]).toEqual(["keep"]);
    expect([...sets.drop]).toEqual(["drop"]);
  });
});

// 优化轮:候选过小跳过 / 同候选集缓存 / 失败降级 / 落账补全。
const scoringCand = (id: string, chars: number): ScoringCandidate => ({
  id, tool: "read_file", where: `src/${id}.ts`, chars, preview: "x".repeat(20),
});

/** 造一个「N 条工具结果 + 6 条热区垫片」的 journal(collectScoringCandidates 只收 N 条)。 */
function scoringJournal(sessionId: string, sizes: number[]): MemoryJournal {
  const journal = new MemoryJournal();
  journal.append({ kind: "message.user", sessionId, payload: { text: "目标" } });
  sizes.forEach((size, i) => {
    journal.append({ kind: "message.agent", sessionId, payload: { text: "", toolCalls: [{ id: `c${i}`, name: "read_file", arguments: JSON.stringify({ path: `src/${i}.ts` }) }] } });
    journal.append({ kind: "tool.result", sessionId, payload: { toolCallId: `c${i}`, content: "x".repeat(size) } });
  });
  for (let i = 0; i < 6; i++) journal.append({ kind: "message.user", sessionId, payload: { text: `pad${i}` } });
  return journal;
}

/** 全部 call/result 按给定概率回答的 Jev provider;计数请求次数。 */
function jevFetchOf(calls: { n: number }, result = 0.9, call = 0.2): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.n += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as { questions?: Record<string, unknown> };
    const ids = Object.keys(body.questions ?? {}).filter((k) => k.startsWith("call_")).map((k) => k.slice(5));
    const answers: Record<string, unknown> = {};
    for (const id of ids) {
      answers[`call_${id}`] = jevAnswer(call);
      answers[`result_${id}`] = jevAnswer(result);
    }
    return new Response(JSON.stringify(answers), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("model-scoring:候选过小跳过 / 内容缓存 / 失败降级(2026-11-05)", () => {
  it("阈值常量与判定:2 候选→too-few-candidates;3 小候选→content-too-small", () => {
    expect(MIN_SCORING_CANDIDATES).toBe(3);
    expect(MIN_SCORING_TOTAL_CHARS).toBe(20_000);
    expect(SCORING_CACHE_TTL_MS).toBe(60_000);
    expect(SCORING_CACHE_CAPACITY).toBe(32);
    expect(scoringSkipReason([scoringCand("a", 100), scoringCand("b", 100)])).toBe("too-few-candidates");
    expect(scoringSkipReason([scoringCand("a", 100), scoringCand("b", 100), scoringCand("c", 100)]))
      .toBe("content-too-small");
    expect(scoringSkipReason([scoringCand("a", 10_000), scoringCand("b", 9_000), scoringCand("c", 100)]))
      .toBe("content-too-small");
    expect(scoringSkipReason([scoringCand("a", 10_000), scoringCand("b", 10_000), scoringCand("c", 0)]))
      .toBeUndefined(); // 边界:10k+10k+0 = 20_000 恰好到线,不算过小
    expect(scoringSkipReason([scoringCand("a", 10_000), scoringCand("b", 10_000), scoringCand("c", 1_000)]))
      .toBeUndefined();
    // 阈值 0 = 关闭该维(既有直调用例保持「总是发请求」的老语义)
    expect(scoringSkipReason([scoringCand("a", 1)], 0, 0)).toBeUndefined();
  });

  it("候选过小:scoreContextCandidates 不发 HTTP、durationMs=0、返回 skipped", async () => {
    resetModelScoringCache();
    const calls = { n: 0 };
    const r = await scoreContextCandidates(
      { providerUrl: "http://t", apiType: "jev", fetchImpl: jevFetchOf(calls) },
      [scoringCand("a", 1_000), scoringCand("b", 1_000)],
      "goal",
      { skipTooSmall: true, cache: true, sessionId: "s-skip-unit" },
    );
    expect(calls.n).toBe(0);
    expect(r.skipped).toBe("too-few-candidates");
    expect(r.durationMs).toBe(0);
    expect(r.decisions).toEqual([]);
    expect(r.totalChars).toBe(2_000);
  });

  it("候选过小主链路:仍落一条 context.model.score,payload 带 skipped/totalChars", async () => {
    resetModelScoringCache();
    const calls = { n: 0 };
    const journal = scoringJournal("s-skip-loop", [1_000, 2_000]);
    const llm: LlmProvider = { async chat() { return { content: "done" }; } };
    const loop = new AgentLoop({
      journal, sessionId: "s-skip-loop", system: "sys", llm,
      modelScoring: { mode: "active", providerUrl: "http://test", scoreEverySteps: 1, fetchImpl: jevFetchOf(calls) },
    });
    await loop.runTurn("go");
    const ev = journal.readAll().find((e) => e.kind === "context.model.score")!;
    const p = ev.payload as Record<string, unknown>;
    expect(calls.n).toBe(0);
    expect(p).toMatchObject({
      skipped: "too-few-candidates",
      candidateCount: 2,
      totalChars: 3_000,
      durationMs: 0,
      effectiveKeep: 0,
      effectiveDrop: 0,
      mode: "active",
    });
  });

  it("同候选集缓存命中:第二次不发 HTTP、decisions 相同、cacheHit=true", async () => {
    resetModelScoringCache();
    const calls = { n: 0 };
    const cands = [scoringCand("a", 10_000), scoringCand("b", 10_000), scoringCand("c", 10_000)];
    const cfg = { providerUrl: "http://t", apiType: "jev" as const, fetchImpl: jevFetchOf(calls) };
    const opts = { skipTooSmall: true, cache: true, sessionId: "s-cache" };
    const r1 = await scoreContextCandidates(cfg, cands, "goal", opts);
    const r2 = await scoreContextCandidates(cfg, cands, "goal", opts);
    expect(calls.n).toBe(1);
    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(true);
    expect(r2.durationMs).toBe(0);
    expect(r2.decisions).toEqual(r1.decisions);
    expect(r2.decisions).not.toBe(r1.decisions); // 缓存不共享可变数组
    expect(r2.totalChars).toBe(30_000);
    expect(modelScoringCacheSize()).toBe(1);
  });

  it("内容变化(ids/chars/goal 任一)不命中,重新调用", async () => {
    resetModelScoringCache();
    const calls = { n: 0 };
    const base = [scoringCand("a", 10_000), scoringCand("b", 10_000), scoringCand("c", 10_000)];
    const cfg = { providerUrl: "http://t", apiType: "jev" as const, fetchImpl: jevFetchOf(calls) };
    const opts = { skipTooSmall: true, cache: true, sessionId: "s-miss" };
    await scoreContextCandidates(cfg, base, "goal", opts);
    await scoreContextCandidates(cfg, base, "goal-2", opts); // goal 变
    expect(calls.n).toBe(2);
    await scoreContextCandidates(cfg, [base[0]!, base[1]!, scoringCand("d", 10_000)], "goal-2", opts); // ids 变
    expect(calls.n).toBe(3);
    await scoreContextCandidates(cfg, [base[0]!, base[1]!, scoringCand("d", 10_001)], "goal-2", opts); // chars 变
    expect(calls.n).toBe(4);
    // 换 session 同内容也不命中(键含 sessionId)
    await scoreContextCandidates(cfg, [base[0]!, base[1]!, scoringCand("d", 10_001)], "goal-2", { ...opts, sessionId: "s-miss-2" });
    expect(calls.n).toBe(5);
    expect(scoringContentKey("s-miss", base, "goal")).not.toBe(scoringContentKey("s-miss", base, "goal-2"));
  });

  it("TTL 过期重新调用(注入时钟,不 sleep)", async () => {
    resetModelScoringCache();
    const calls = { n: 0 };
    let now = 1_000_000;
    const cands = [scoringCand("a", 10_000), scoringCand("b", 10_000), scoringCand("c", 10_000)];
    const cfg = { providerUrl: "http://t", apiType: "jev" as const, fetchImpl: jevFetchOf(calls) };
    const opts = { skipTooSmall: true, cache: true, sessionId: "s-ttl", now: () => now };
    await scoreContextCandidates(cfg, cands, "goal", opts);
    now += SCORING_CACHE_TTL_MS - 1;
    const fresh = await scoreContextCandidates(cfg, cands, "goal", opts);
    expect(fresh.cacheHit).toBe(true);
    expect(calls.n).toBe(1);
    now += 2; // 越过 TTL
    const expired = await scoreContextCandidates(cfg, cands, "goal", opts);
    expect(expired.cacheHit).toBe(false);
    expect(calls.n).toBe(2);
  });

  it("error 路径:durationMs>0、无 skipped、不写缓存", async () => {
    resetModelScoringCache();
    const calls = { n: 0 };
    const fetchImpl = (async () => {
      calls.n += 1;
      await new Promise((r) => setTimeout(r, 15));
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const cands = [scoringCand("a", 10_000), scoringCand("b", 10_000), scoringCand("c", 10_000)];
    const cfg = { providerUrl: "http://t", apiType: "jev" as const, fetchImpl };
    const opts = { skipTooSmall: true, cache: true, sessionId: "s-error" };
    const r1 = await scoreContextCandidates(cfg, cands, "goal", opts);
    expect(r1.error).toContain("ECONNREFUSED");
    expect(r1.durationMs).toBeGreaterThan(0);
    expect(r1.skipped).toBeUndefined();
    expect(modelScoringCacheSize()).toBe(0);
    // error 未写缓存 → 同内容再调仍然打 HTTP(失败不被 TTL 放大成 60s 失能)
    const r2 = await scoreContextCandidates(cfg, cands, "goal", opts);
    expect(r2.error).toContain("ECONNREFUSED");
    expect(calls.n).toBe(2);
  });

  it("超时(AbortController)路径:catch 里 durationMs 已算且 >0", async () => {
    resetModelScoringCache();
    // fetch 永不 resolve,只在 abort 时 reject → 必须由 timeoutMs 兜底退出。
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const r = await scoreContextCandidates(
      { providerUrl: "http://t", apiType: "jev", timeoutMs: 500, fetchImpl },
      [scoringCand("a", 10_000), scoringCand("b", 10_000), scoringCand("c", 10_000)],
      "goal",
      { skipTooSmall: true, cache: true, sessionId: "s-timeout" },
    );
    expect(r.error).toBeTruthy();
    expect(r.durationMs).toBeGreaterThanOrEqual(400);
    expect(modelScoringCacheSize()).toBe(0);
  }, 5_000);

  it("reset 后重新调用", async () => {
    resetModelScoringCache();
    const calls = { n: 0 };
    const cands = [scoringCand("a", 10_000), scoringCand("b", 10_000), scoringCand("c", 10_000)];
    const cfg = { providerUrl: "http://t", apiType: "jev" as const, fetchImpl: jevFetchOf(calls) };
    const opts = { skipTooSmall: true, cache: true, sessionId: "s-reset" };
    await scoreContextCandidates(cfg, cands, "goal", opts);
    expect((await scoreContextCandidates(cfg, cands, "goal", opts)).cacheHit).toBe(true);
    expect(calls.n).toBe(1);
    resetModelScoringCache();
    expect(modelScoringCacheSize()).toBe(0);
    expect((await scoreContextCandidates(cfg, cands, "goal", opts)).cacheHit).toBe(false);
    expect(calls.n).toBe(2);
  });

  it("跨 turn 节拍:scoreEverySteps 用跨 turn 累加计数(不再每 turn 首步必评)", async () => {
    resetModelScoringCache();
    const calls = { n: 0 };
    const sizes = [10_000, 10_000, 10_000];
    const journal = scoringJournal("s-tick", sizes);
    const llm: LlmProvider = { async chat() { return { content: "done" }; } };
    const loop = new AgentLoop({
      journal, sessionId: "s-tick", system: "sys", llm,
      modelScoring: { mode: "shadow", providerUrl: "http://test", scoreEverySteps: 2, fetchImpl: jevFetchOf(calls) },
    });
    await loop.runTurn("go"); // 第 1 个 turn:tick 0 → 评分
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.n).toBe(1);
    await loop.runTurn("go"); // 第 2 个 turn:tick 1 → 不评分(旧口径 step 归零会再评一次)
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.n).toBe(1);
    await loop.runTurn("go"); // 第 3 个 turn:tick 2 → 评分
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.n).toBe(2);
    // 真实 step 仍按 turn 内计数落账
    const steps = journal.readAll()
      .filter((e) => e.kind === "context.model.score")
      .map((e) => (e.payload as { step: number }).step);
    expect(steps).toEqual([0, 0]);
  });
});
