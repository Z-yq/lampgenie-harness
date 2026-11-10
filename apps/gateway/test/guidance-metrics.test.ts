/**
 * 指导可度量(guidance-metrics。
 * A. 纯函数:tip 元数据表覆盖 + computeGuidanceMetrics 的 counters/rates/tips 口径(含未知 key 不丢、
 *    空事件全 0、step 区间归组、read_file 同路径重复读、验证命令复用 isVerificationCommand);
 * B. 注入侧:buildLoopTips 返回 metrics(不改文本/keys);
 * C. 收尾钩子(agent-wiring finally):done / failed 两路都落 custom guidance.metrics,且 finalOut 不被污染。
 */
import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
import { buildLoopTips } from "../src/agent-wiring.js";
import {
  TIP_METRICS,
  tipMetricOf,
  computeGuidanceMetrics,
  renderGuidanceSummary,
  type GuidanceMetricsEvent,
} from "../src/guidance-metrics.js";

// ---- A. 纯函数 ----
let seq = 0;
const ev = (kind: string, payload: Record<string, unknown>): GuidanceMetricsEvent => ({ seq: ++seq, kind, time: 1000 + seq, payload });
const stepStart = () => ev("step.start", { turn: 1, step: 0 });
const stepEnd = () => ev("step.end", { turn: 1, step: 0, reason: "tools-done" });
const toolCall = (name: string, args: unknown = {}, id = `c${++seq}`) =>
  ev("tool.call", { toolCallId: id, name, arguments: JSON.stringify(args), turn: 1, step: 0 });
const toolResult = (id: string, content: string) => ev("tool.result", { toolCallId: id, content, durationMs: 5 });
const tipEvent = (keys: string[]) => ev("tip.injected", { keys, turn: 1, step: 0, text: "x", chars: 1 });
const traceEvent = (totalTokens?: number) => ev("llm.trace", { turn: 1, step: 0, ...(totalTokens === undefined ? {} : { usage: { totalTokens } }) });

describe("TIP_METRICS 口径表", () => {
  it("覆盖 buildLoopTips 的关键 key,每条都有触发条件/预期行为/指标", () => {
    for (const k of [
      "dispatch", "board-comments", "parallel", "task:trajectory",
      "sop:understand", "sop:plan", "sop:implement", "sop:debug", "sop:close",
      "dyn:hypothesis", "dyn:verify-stop", "dyn:phase-align", "dyn:verify-cadence", "dyn:delegate",
    ]) {
      const spec = TIP_METRICS[k];
      expect(spec, k).toBeTruthy();
      expect(spec!.trigger.length).toBeGreaterThan(4);
      expect(spec!.expected.length).toBeGreaterThan(4);
      expect(spec!.metric).not.toBe("unknown");
    }
  });

  it("未知 key 记 metric=unknown 但保留 key", () => {
    const s = tipMetricOf("some:future-tip");
    expect(s.key).toBe("some:future-tip");
    expect(s.metric).toBe("unknown");
  });
});

describe("computeGuidanceMetrics", () => {
  it("合成事件:3 步(其中 1 步 2 个 tool.call)、同路径 read_file ×2、1 落板、1 验证命令、1 错误 result、2 条 usage", () => {
    seq = 0;
    const evs: GuidanceMetricsEvent[] = [
      tipEvent(["dispatch"]),
      tipEvent(["some:future-tip"]),
      stepStart(),
      toolCall("read_file", { path: "apps/gateway/src/a.ts" }, "r1"),
      toolResult("r1", "内容"),
      toolCall("read_file", { path: "apps/gateway/src/a.ts" }, "r2"),
      toolResult("r2", "内容"),
      stepEnd(),
      stepStart(),
      toolCall("board_upsert", { action: "upsert" }, "b1"),
      toolResult("b1", "板已更新"),
      stepEnd(),
      stepStart(),
      toolCall("terminal", { command: "npx vitest run test/a.test.ts" }, "t1"),
      toolResult("t1", "错误: 1 failed"),
      stepEnd(),
      traceEvent(100),
      traceEvent(250),
    ];
    const m = computeGuidanceMetrics(evs);
    expect(m.counters).toEqual({
      steps: 3,
      toolCalls: 4,
      parallelSteps: 1, // 第 1 步两个 read_file
      repeatReads: 1, // 同 path 第 2 次
      boardWrites: 1,
      verificationCommands: 1,
      reworkCalls: 1, // 「错误: …」开头的 result
      tokens: 350,
    });
    // 有工具调用的步 = 3;并行 1/3
    expect(m.rates.parallelRate).toBeCloseTo(1 / 3, 6);
    expect(m.rates.repeatReadRate).toBe(0.5); // 1/2 次 read_file
    expect(m.rates.boardRate).toBe(1);
    expect(m.rates.reworkRate).toBe(0.25); // 1/4
    // tips:已知 key 带口径,未知 key metric=unknown 但保留
    const byKey = new Map(m.tips.map((t) => [t.key, t] as const));
    expect(byKey.get("dispatch")?.count).toBe(1);
    expect(byKey.get("dispatch")?.metric).toBe("steps-tokens");
    expect(byKey.get("some:future-tip")?.count).toBe(1);
    expect(byKey.get("some:future-tip")?.metric).toBe("unknown");
  });

  it("无事件 / 无 tips / 无 tool 调用 → 全 0 不炸", () => {
    const m = computeGuidanceMetrics([]);
    expect(m.tips).toEqual([]);
    expect(m.counters).toEqual({
      steps: 0, toolCalls: 0, parallelSteps: 0, repeatReads: 0,
      boardWrites: 0, verificationCommands: 0, reworkCalls: 0, tokens: 0,
    });
    expect(m.rates).toEqual({ parallelRate: 0, repeatReadRate: 0, boardRate: 0, reworkRate: 0 });
    expect(computeGuidanceMetrics([stepStart(), stepEnd()]).rates.parallelRate).toBe(0);
    expect(computeGuidanceMetrics([traceEvent()]).counters.tokens).toBe(0); // usage 缺失忽略
  });

  it("非验证命令(--watch / echo)不计入 verificationCommands;工具超时文案计返工", () => {
    seq = 0;
    const m = computeGuidanceMetrics([
      toolCall("terminal", { command: "npx vitest --watch" }, "w1"),
      toolCall("terminal", { command: "echo testing" }, "w2"),
      toolCall("terminal", { command: "npx tsc --noEmit" }, "w3"),
      toolResult("w3", "工具执行超时(600s),已中止"),
    ]);
    expect(m.counters.verificationCommands).toBe(1);
    expect(m.counters.reworkCalls).toBe(1);
  });

  it("renderGuidanceSummary:含六条指标读数且 ≤800 字", () => {
    seq = 0;
    const m = computeGuidanceMetrics([tipEvent(["dispatch", "parallel"]), stepStart(), toolCall("board_upsert", {}, "b"), stepEnd()]);
    const text = renderGuidanceSummary(m);
    expect(text).toContain("[指导度量]");
    expect(text).toContain("并行");
    expect(text).toContain("dispatch×1");
    expect(text.length).toBeLessThanOrEqual(800);
  });
});

// ---- B. 注入侧 ----
describe("buildLoopTips 带 metrics", () => {
  it("dispatch 注入时 metrics 带触发/预期/指标;文本与 keys 不变", () => {
    const tips = buildLoopTips({ sessionId: "gm-tips" });
    const r = tips({ step: 2, lastStepTools: ["spawn_subagent"] });
    expect(r?.text).toContain("派发 tips");
    expect(r?.keys).toEqual(["dispatch"]);
    expect(r?.metrics.map((x) => x.key)).toEqual(["dispatch"]);
    expect(r?.metrics[0]!.metric).toBe("steps-tokens");
    expect(r?.metrics[0]!.trigger).toContain("spawn_subagent");
  });
});

// ---- C. 收尾钩子 ----
beforeAll(async () => { await acquireEnvLock("guidance-metrics"); }, 240_000);
afterAll(() => { releaseEnvLock("guidance-metrics"); });

type App = ReturnType<typeof createGatewayApp>;
const gwApps: App[] = [];
afterEach(async () => {
  for (const a of gwApps.splice(0)) await a.close();
  delete process.env.GENIE_VERIFY_ON_STOP;
});

const INSTRUCTION = "修一下这个逻辑";

/** 任务窗口内的事件(第 0 步 LLM 调用时补种,落在 taskStartSeq 之后)。 */
type Append = (e: { kind: string; sessionId: string; payload: Record<string, unknown> }) => void;
const seedTask = (sid: string, append: Append, opts: { failLater?: boolean } = {}) => {
  append({ kind: "tip.injected", sessionId: sid, payload: { keys: ["dispatch", "parallel"], turn: 1, step: 0, text: "tips", chars: 4 } });
  append({ kind: "step.start", sessionId: sid, payload: { turn: 1, step: 0 } });
  append({ kind: "tool.call", sessionId: sid, payload: { toolCallId: "b1", name: "board_upsert", arguments: JSON.stringify({ action: "upsert" }), turn: 1, step: 0 } });
  append({ kind: "tool.result", sessionId: sid, payload: { toolCallId: "b1", content: "板已更新", durationMs: 3 } });
  append({ kind: "tool.call", sessionId: sid, payload: { toolCallId: "t1", name: "terminal", arguments: JSON.stringify({ command: "npx vitest run test/a.test.ts" }), turn: 1, step: 0 } });
  append({ kind: "tool.result", sessionId: sid, payload: { toolCallId: "t1", content: "3 passed", durationMs: 3 } });
  // failed 分支:验证后再改代码 → GENIE_VERIFY_ON_STOP=hard 判 failed(确定性故障源,不靠 llm 抛错)。
  if (opts.failLater) {
    append({ kind: "tool.call", sessionId: sid, payload: { toolCallId: "w1", name: "edit_file", arguments: JSON.stringify({ path: "apps/gateway/src/late.ts", old_string: "a", new_string: "b" }), turn: 1, step: 0 } });
  }
  append({ kind: "step.end", sessionId: sid, payload: { turn: 1, step: 0, reason: "tools-done" } });
};

async function runScenario(sid: string, mode: "done" | "failed"): Promise<{ state: string; result: string; app: App }> {
  let appRef: App;
  let step = 0;
  if (mode === "failed") process.env.GENIE_VERIFY_ON_STOP = "hard";
  const app = createGatewayApp({
    port: 0,
    llm: {
      async chat() {
        if (step++ === 0) {
          seedTask(sid, (e) => { appRef.journal.append(e as never); }, { failLater: mode === "failed" });
        }
        return { content: "终稿" };
      },
    } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  appRef = app;
  gwApps.push(app);
  app.taskManager.submit("user", sid, INSTRUCTION);
  // 终态在 finally 之前落(收尾钩子与终态同一步但更晚),所以拿到终态后再等 guidance.metrics 落账。
  const deadline = Date.now() + 60_000;
  let terminal: { state: string; result: string } | null = null;
  while (Date.now() < deadline) {
    const t = app.taskManager.list().find((x) => x.sessionId === sid);
    if (t && (t.state === "done" || t.state === "failed")) {
      terminal = { state: t.state, result: String(t.result ?? "") };
      if (guidanceOf(app, sid).length) break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!terminal) throw new Error("任务未在时限内终态");
  return { ...terminal, app };
}

const guidanceOf = (app: App, sid: string) =>
  app.journal.readAll()
    .filter((e) => e.kind === "custom" && e.sessionId === sid)
    .filter((e) => (e.payload as { type?: string }).type === "guidance.metrics")
    .map((e) => e.payload as { taskId: string; state: string; tips: { key: string; metric: string; count: number }[]; counters: Record<string, number>; rates: Record<string, number> });

describe("收尾 guidance.metrics(done / failed 两路)", () => {
  it("done:落一条 custom,含 tips/counters/rates;finalOut 不含 guidance", async () => {
    const r = await runScenario("gm-done-1", "done");
    expect(r.state).toBe("done");
    const rows = guidanceOf(r.app, "gm-done-1");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.state).toBe("done");
    expect(typeof row.taskId).toBe("string");
    expect(row.tips.map((t) => t.key).sort()).toEqual(["dispatch", "parallel"]);
    expect(row.counters.toolCalls).toBe(2);
    expect(row.counters.boardWrites).toBe(1);
    expect(row.counters.verificationCommands).toBe(1);
    expect(row.rates.boardRate).toBe(1);
    // 只落 journal:模型可见的终稿里没有任何 guidance 字样
    expect(r.result).not.toContain("指导度量");
    expect(r.result).not.toContain("guidance");
  }, 120_000);

  it("failed:同样落一条(state=failed),finalOut 不被污染", async () => {
    const r = await runScenario("gm-fail-1", "failed");
    expect(r.state).toBe("failed");
    const rows = guidanceOf(r.app, "gm-fail-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("failed");
    expect(r.result).not.toContain("指导度量");
  }, 120_000);
});
