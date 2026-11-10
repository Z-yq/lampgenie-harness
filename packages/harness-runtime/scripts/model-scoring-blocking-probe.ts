/**
 * 阻塞语义实测(2026-11-04 P0 止损证据):同一慢 provider 下 shadow vs active 的 runTurn 墙钟差。
 *
 * 用法:cd packages/harness-runtime && npx tsx scripts/model-scoring-blocking-probe.ts
 * 结论口径:shadow 用 void 不 await 评分 → runTurn 耗时与 provider 延迟无关;
 *           active 每 N 步 await 一次 → runTurn 多等一个 provider 延迟。
 */
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, type LlmProvider } from "../src/agent/loop";

const SLOW_MS = 1_500;

async function measure(mode: "shadow" | "active", scoreEverySteps: number): Promise<number> {
  const sessionId = `m-${mode}-${scoreEverySteps}`;
  const journal = new MemoryJournal();
  journal.append({ kind: "message.user", sessionId, payload: { text: "目标" } });
  journal.append({ kind: "message.agent", sessionId, payload: { text: "", toolCalls: [{ id: "c0", name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) }] } });
  journal.append({ kind: "tool.result", sessionId, payload: { toolCallId: "c0", content: "x".repeat(5_000) } });
  for (let i = 0; i < 6; i++) journal.append({ kind: "message.user", sessionId, payload: { text: `pad${i}` } });
  const llm: LlmProvider = { async chat() { return { content: "done" }; } };
  const slowFetch = (async () => {
    await new Promise((r) => setTimeout(r, SLOW_MS));
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;
  const loop = new AgentLoop({
    journal, sessionId, system: "sys", llm,
    modelScoring: { mode, providerUrl: "http://test", scoreEverySteps, fetchImpl: slowFetch },
  });
  const t0 = Date.now();
  await loop.runTurn("go");
  const elapsed = Date.now() - t0;
  await new Promise((r) => setTimeout(r, SLOW_MS + 100));
  return elapsed;
}

const shadow5 = await measure("shadow", 5);
const shadow50 = await measure("shadow", 50);
const active5 = await measure("active", 5);

console.log(`provider 延迟 ${SLOW_MS}ms,单步 turn 墙钟:`);
console.log(`  shadow/scoreEverySteps=5   runTurn=${shadow5}ms`);
console.log(`  shadow/scoreEverySteps=50  runTurn=${shadow50}ms`);
console.log(`  active/scoreEverySteps=5   runTurn=${active5}ms`);
const ok = shadow5 < SLOW_MS && shadow50 < SLOW_MS && active5 >= SLOW_MS - 100;
console.log(ok
  ? `PASS:shadow 不阻塞、active 阻塞(每评分步白等 ≈${active5 - shadow50}ms)`
  : "FAIL:阻塞语义与预期不符");
process.exit(ok ? 0 : 1);