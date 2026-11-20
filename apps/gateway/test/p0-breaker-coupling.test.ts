/**
 * P0-① 熔断-调度脱钩修复验收(主线 g-rsi-closed-loop ①)。
 * 三个注意的对应用例:
 * 1) pause 落地:evaluateRoiGate(apply) 判 pause → breaker.jsonl 真实落盘 paused
 * (旧实现经变量 URL 动态 import 在 bundle 里静默失败——91.8M 失守根因);
 * 2) streak 归零:16 周期含 1 个低样本正收益 → streak=0(旧顺序被样本闸 continue 跳过);
 * 3) recordCost 幂等:同 id 二次落账被跳过(RSI_COST_DUPLICATE_SKIPPED);
 * 4) 调度器自愈:runtime.breaker.writeFailed 且台账未 paused → tick 重试 pause 而非清旗。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateRoiGate, recordCost } from "../src/rsi-cost-store.js";
import { getState as getBreakerState } from "../src/rsi-breaker-store.js";
import { evaluateRoiGate as pureGate } from "@lampgenie/runtime/agent/rsi-cost-roi";
import { loadSchedulerState, schedulerPath, setSchedulerConfig, tickRsiScheduler, type RsiSchedulerDeps } from "../src/rsi-scheduler.js";
import type { StartRunDeps } from "../src/rsi-agent-runner.js";

let root = "";
const roots: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "p01-fix-"));
  roots.push(root);
});
afterEach(() => {
  while (roots.length > 0) {
    const r = roots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

const NOW = 1_000_000;
function deps(extra: Partial<RsiSchedulerDeps> = {}): RsiSchedulerDeps {
  return { root, submit: () => ({ id: "t" }), taskState: () => undefined, now: NOW, ...extra };
}
async function enable(patch: Record<string, unknown> = {}) {
  const r = await setSchedulerConfig(root, { enabled: true, mechanisms: ["cost"], idleOnly: true, autoRetry: false, roiGate: false, tokenBudgetPerRun: 1000, ...patch } as never, "test", NOW - 1000);
  expect(r.ok).toBe(true);
}

describe("P0-① 熔断脱钩修复", () => {
  it("1) roi-gate 判 pause → breaker.jsonl 真实落盘(不再静默失败)", async () => {
 // 构造连续负收益周期账(cost-only,样本足量)
    for (let i = 0; i < 8; i += 1) {
      recordCost(root, { id: `c${i}`, cycleId: `rsi-cycle-${i}`, stage: "mining", mechanismId: "cost", tokens: { input: 900_000, output: 90_000, total: 990_000 }, wallMs: 1000 } as never);
    }
    const r = await evaluateRoiGate(root, { apply: true, breakerRoot: root });
    expect(r.action).toBe("pause");
    expect(r.breaker?.ok, "breaker.pause 必须成功落盘(旧实现变量 import 在 bundle 静默失败)").toBe(true);
    expect(existsSync(join(root, ".genie", "rsi", "breaker.jsonl")), "breaker.jsonl 必须存在").toBe(true);
    const state = await getBreakerState(root);
    expect(state.paused).toBe(true);
  });

  it("2) streak:低样本正收益周期优先归零(旧序被样本闸跳过 → 恒=窗口-1)", () => {
    const reports = Array.from({ length: 16 }, (_, i) => ({
      cycleId: `c${i}`,
      entries: { costs: 50, savings: 40 },
      netTokens: -1000,
    }));
 // 最新一个周期:正收益但样本低于 minCycleSamples(默认 1?给 0 样本)
    reports[15] = { cycleId: "c15", entries: { costs: 0, savings: 0 }, netTokens: +500 };
    const gate = pureGate(reports as never);
    expect(gate.negativeStreak, "正收益周期(即使低样本)必须把 streak 归零").toBe(0);
    expect(gate.action).toBe("ok");
 // 反例:全负且样本足量 → streak=16(计数完整);低样本的负周期仍被样本闸跳过(设计行为)
    const allNeg = reports.map((r, i) => (i === 15 ? { ...r, netTokens: -1, entries: { costs: 10, savings: 0 } } : r));
    expect(pureGate(allNeg as never).negativeStreak).toBe(16);
    const lowSampleNeg = reports.map((r, i) => (i === 15 ? { ...r, netTokens: -1 } : r));
    expect(pureGate(lowSampleNeg as never).negativeStreak).toBe(15);
  });

  it("3) recordCost 幂等:同 id 二次落账跳过", () => {
    const entry = { id: "cycle-x:run-1", cycleId: "cycle-x", stage: "mining", mechanismId: "tools", tokens: { input: 1, output: 1, total: 2 }, wallMs: 5 } as never;
    const first = recordCost(root, entry);
    expect(first.ok).toBe(true);
    const second = recordCost(root, entry);
    expect(second.ok).toBe(false);
    expect(second.codes).toContain("RSI_COST_DUPLICATE_SKIPPED");
 // 台账里同 id 只有一条
    const text = readFileSync(join(root, ".genie", "rsi", "cost.jsonl"), "utf8");
    expect(text.split('"id":"cycle-x:run-1"').length - 1).toBe(1);
  });

  it("4) 调度器自愈:writeFailed 快照 + 台账未 paused → 重试 pause 不清旗", async () => {
    await enable();
 // 直接构造 writeFailed 快照(模拟 cost 旧 bug:pause 判了但没落盘)
    const state = await loadSchedulerState(root, NOW);
    state.runtime.breaker = { paused: true, reason: "roi-gate: 连续负收益", at: NOW - 60_000, writeFailed: true };
    mkdirSync(join(root, ".genie", "rsi"), { recursive: true });
    writeFileSync(schedulerPath(root), JSON.stringify({ config: state.config, runtime: state.runtime }, null, 2), "utf8");
    const calls: string[] = [];
    const r = await tickRsiScheduler(deps({ isOnlineBusy: () => false, start: async (_d: StartRunDeps, mech: string) => { calls.push(mech); return { ok: true, id: mech, runId: "r" }; } }));
    expect(r.action).toBe("breaker-paused");
    expect(calls).toEqual([]);
 // 重试后台账真实 paused(自愈成功)
    const bs = await getBreakerState(root);
    expect(bs.paused).toBe(true);
 // 再 tick:台账 paused → 仍 breaker-paused
    const r2 = await tickRsiScheduler(deps({ isOnlineBusy: () => false, start: async () => ({ ok: true, id: "cost", runId: "r2" }) }));
    expect(r2.action).toBe("breaker-paused");
  });
});
