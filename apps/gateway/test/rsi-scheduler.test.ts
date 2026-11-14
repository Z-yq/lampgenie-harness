/**
 * RSI 自转调度器测试( RSI-SELF-DRIVE)。
 * 钉住七件事:
 * ① 缺省关闭:未显式开启时 tick 零动作;
 * ② 白名单校验:非法字段/未知机制回 INVALID_PATCH,不落盘;
 * ③ 空闲让路:idleOnly=true 且在线繁忙时不开周期;
 * ④ 串行派发:到点开周期,一次只派一个机制,cycleId/预算进 deps;派完周期并推进 nextRunAt;
 * ⑤ 自动重试:只认 `task interrupted`,窗口内、次数未超;重试后旧记录 retryCount+1,不重试用户取消;
 * ⑥ 预算:周期内有 run budgetExceeded → 下一 tick 提前结束周期(余下机制不派);
 * ⑦ 熔断暂停:breaker.paused 时停转;resumeBreaker 人工恢复后继续可调度。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectSchedulerStatus,
  defaultSchedulerConfig,
  loadSchedulerState,
  pickRetryCandidate,
  schedulerPath,
  setSchedulerConfig,
  tickRsiScheduler,
  type RsiSchedulerDeps,
} from "../src/rsi-scheduler.js";
import { finishRun, getRun, runFilePath, startRun } from "../src/rsi-mechanism-store.js";
import type { StartRunDeps } from "../src/rsi-agent-runner.js";
import { setMechanism } from "../src/rsi-mechanism-store.js";
import { pause as pauseBreaker } from "../src/rsi-breaker-store.js";
import type { StartRunDeps } from "../src/rsi-agent-runner.js";

const NOW = 1_000_000;

function deps(root: string, extra: Partial<RsiSchedulerDeps> = {}): RsiSchedulerDeps {
  return {
    root,
    submit: () => ({ id: "unused-task" }),
    taskState: () => undefined,
    now: NOW,
    ...extra,
  };
}

async function enable(root: string, patch: Record<string, unknown> = {}): Promise<void> {
  const r = await setSchedulerConfig(
    root,
    {
      enabled: true,
      mechanisms: ["cost"],
      idleOnly: true,
      autoRetry: false,
      roiGate: false,
      tokenBudgetPerRun: 1000,
      ...patch,
    } as never,
    "test",
    NOW - 1000);
  expect(r.ok).toBe(true);
}

describe("rsi scheduler 配置", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rsi-sched-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("缺省关闭;未开启时 tick 零动作", async () => {
    const state = await loadSchedulerState(root, NOW);
    expect(state.config).toMatchObject({ enabled: false, everyMinutes: 1440, idleOnly: true, autoRetry: true });
    expect(state.config.tokenBudgetPerRun).toBe(defaultSchedulerConfig(NOW).tokenBudgetPerRun);
    const r = await tickRsiScheduler(deps(root));
    expect(r.action).toBe("disabled");
  });

  it("非法 patch:类型不对/未知机制 → INVALID_PATCH,且不落盘", async () => {
    expect((await setSchedulerConfig(root, { enabled: "yes" } as never)).reason).toBe("INVALID_PATCH");
    expect((await setSchedulerConfig(root, { mechanisms: ["nope"] })).reason).toBe("INVALID_PATCH");
    expect((await setSchedulerConfig(root, { everyMinutes: "60" as never })).reason).toBe("INVALID_PATCH");
    const state = await loadSchedulerState(root, NOW);
    expect(state.config.enabled).toBe(false);
  });

  it("打开开关把 nextRunAt 置为当前时刻(不用等一个周期)", async () => {
    await setSchedulerConfig(root, { enabled: true }, "test", NOW);
    const state = await loadSchedulerState(root, NOW);
    expect(state.runtime.nextRunAt).toBe(NOW);
  });
});

describe("tickRsiScheduler", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rsi-sched-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("idleOnly + 在线繁忙:不开周期、不派任务", async () => {
    await enable(root);
    const calls: string[] = [];
    const r = await tickRsiScheduler(
      deps(root, {
        isOnlineBusy: () => true,
        start: async (_d: StartRunDeps, mech: string) => {
          calls.push(mech);
          return { ok: true, id: mech, runId: `run-${mech}` };
        },
      }),
    );
    expect(r.action).toBe("busy");
    expect(calls).toEqual([]);
  });

  it("到点串行派发:一次一个机制,cycleId/预算进 deps;派完周期收口并推进 nextRunAt", async () => {
    await enable(root, { mechanisms: ["cost", "tools"] });
    await setMechanism(root, "tools", { enabled: true });
    const calls: { mech: string; cycleId?: string; budget?: number }[] = [];
    const start = async (d: StartRunDeps, mech: string) => {
      calls.push({ mech, cycleId: d.cycleId, budget: d.budgetTokens });
      return { ok: true, id: mech, runId: `run-${mech}`, taskId: `task-${mech}` };
    };
    const first = await tickRsiScheduler(deps(root, { isOnlineBusy: () => false, start }));
    expect(first.action).toBe("started");
    expect(first.mechanismId).toBe("cost");
    expect(calls).toHaveLength(1);
    expect(calls[0].cycleId).toMatch(/^rsi-cycle-/);
    expect(calls[0].budget).toBe(1000);

    const second = await tickRsiScheduler(deps(root, { isOnlineBusy: () => false, start }));
    expect(second.action).toBe("started");
    expect(second.mechanismId).toBe("tools");
    expect(calls).toHaveLength(2);

    const third = await tickRsiScheduler(deps(root, { isOnlineBusy: () => false, start }));
    expect(third.action).toBe("cycle-done");
    const state = await loadSchedulerState(root, NOW);
    expect(state.runtime.cycle).toBeUndefined();
    expect(state.runtime.nextRunAt).toBe(NOW + 1440 * 60_000);
    expect(state.runtime.lastCycle?.costTokens).toBe(0);
  });

  it("关闭/非 agent 驱动的机制不消耗派发,直接跳过并收口", async () => {
    await enable(root, { mechanisms: ["cost", "tools"] });
    await setMechanism(root, "tools", { enabled: false });
    const calls: string[] = [];
    const start = async (_d: StartRunDeps, mech: string) => {
      calls.push(mech);
      return { ok: true, id: mech, runId: `run-${mech}` };
    };
    await tickRsiScheduler(deps(root, { isOnlineBusy: () => false, start }));
    const r2 = await tickRsiScheduler(deps(root, { isOnlineBusy: () => false, start }));
    expect(r2.action).toBe("cycle-done");
    expect(calls).toEqual(["cost"]);
  });

  it("自动重试:只重试 task interrupted,旧记录 retryCount+1;用户取消不重试", async () => {
    await enable(root, { autoRetry: true, maxRetriesPerRun: 1 });
    await startRun(root, { mechanismId: "cost", runId: "old-run", taskId: "task-old" });
    await finishRun(root, "cost", "old-run", "failed", "task interrupted");
    let captured: StartRunDeps | undefined;
    const start = async (d: StartRunDeps, mech: string) => {
      captured = d;
      return { ok: true, id: mech, runId: "new-run", taskId: "task-new" };
    };
    const r = await tickRsiScheduler(deps(root, { isOnlineBusy: () => false, start }));
    expect(r.action).toBe("retried");
    expect(r.mechanismId).toBe("cost");
    expect(captured?.retryOf).toBe("old-run");
    expect((await getRun(root, "cost", "old-run"))?.retryCount).toBe(1);
  });

  it("pickRetryCandidate:窗口外/已重试满/非 interrupted 都不选", () => {
    const base = {
      mechanismId: "cost",
      status: "failed" as const,
      startedAt: NOW - 1000,
      error: "task interrupted",
    };
    expect(pickRetryCandidate([{ ...base, runId: "a" }], NOW, 1)?.runId).toBe("a");
    expect(pickRetryCandidate([{ ...base, runId: "a", retryCount: 1 }], NOW, 1)).toBeUndefined();
    expect(pickRetryCandidate([{ ...base, runId: "a", error: "task cancelled" }], NOW, 1)).toBeUndefined();
    expect(pickRetryCandidate([{ ...base, runId: "a", startedAt: NOW - 48 * 3600 * 1000 }], NOW, 1)).toBeUndefined();
  });

  it("run 自称 running 但任务已终态:多老都要收(不被 10 分钟 age 闸跳过)", async () => {
    await enable(root, { mechanisms: ["cost"], autoRetry: false, roiGate: false });
    await startRun(root, { mechanismId: "cost", runId: "r-old", taskId: "t-old", sessionId: "rsi" });
 // 把 startedAt 拨到 20 分钟前,模拟面板长期不轮询的无人结账记录
    const file = runFilePath(root, "cost", "r-old");
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.startedAt = NOW - 20 * 60_000;
    await writeFile(file, JSON.stringify(rec, null, 2), "utf8");
    const events = [
      { kind: "task.context", payload: { taskId: "t-old" } },
      { kind: "llm.trace", payload: { model: "deepseek-flash", usage: { inputTokens: 900, outputTokens: 300 } } },
      { kind: "delivery.obligation", payload: { taskId: "t-old", terminalState: "done" } },
    ];
    const start = async (_d: StartRunDeps, mech: string) => ({ ok: true, id: mech, runId: "run-next" });
    const r = await tickRsiScheduler(
      deps(root, {
        isOnlineBusy: () => false,
        taskState: (id) => (id === "t-old" ? "done" : undefined),
        readSession: () => events,
        start,
      }),
    );
    expect(r.finalized).toBe(1);
    const settled = await getRun(root, "cost", "r-old");
    expect(settled?.status).toBe("done");
    expect(settled?.cost?.totalTokens).toBe(1200);
  });

  it("ROI downshift 因子 <1:周期机制集按比例裁剪并轮转(补齐降频运行面)", async () => {
    await mkdir(join(root, ".genie", "rsi"), { recursive: true });
    await writeFile(
      join(root, ".genie", "rsi", "cost.jsonl"),
      JSON.stringify({
        v: 1,
        type: "downshift",
        at: new Date(NOW).toISOString(),
        action: "downshift",
        quota: { nightlyWindowFactor: 0.5, experimentQuotaFactor: 0.5 },
        negativeStreak: 4,
      }) + "\n",
      "utf8",
    );
    await enable(root, { mechanisms: ["cost", "tools", "nightly", "pathology"], roiGate: false });
    const calls: string[] = [];
    const start = async (_d: StartRunDeps, mech: string) => {
      calls.push(mech);
      return { ok: true, id: mech, runId: `run-${mech}`, taskId: `task-${mech}` };
    };
    const first = await tickRsiScheduler(deps(root, { isOnlineBusy: () => false, start }));
    expect(first.action).toBe("started");
    const state = await loadSchedulerState(root, NOW);
    const cycle = state.runtime.cycle;
    expect(cycle?.quotaFactor).toBe(0.5);
    const planned = Object.keys(cycle?.runIds ?? {}).length + (cycle?.pending.length ?? 0);
    expect(planned).toBe(2); // ceil(4 * 0.5)
    expect(state.runtime.mechanismOffset).toBe(2); // 下轮从第 3 个机制开始
    expect(calls).toEqual(["nightly"]); // 目录顺序:nightly 在前;cycle 只含裁剪后的 2 个
  });

  it("预算超限:周期内 run budgetExceeded → 下一 tick 提前收口(不再派余下机制)", async () => {
    await enable(root, { mechanisms: ["cost", "tools"] });
    const start = async (_d: StartRunDeps, mech: string) => ({ ok: true, id: mech, runId: `run-${mech}`, taskId: `task-${mech}` });
    const first = await tickRsiScheduler(deps(root, { isOnlineBusy: () => false, start }));
    expect(first.action).toBe("started");
 // 造一条「任务已完成 + 预算超限」的运行记录,让 tick 在周期内看到预算门。
    const runId = first.runId!;
    await startRun(root, { mechanismId: "cost", runId, taskId: "task-cost", cycleId: first.state.runtime.cycle?.id, budgetTokens: 1000 });
    await finishRun(root, "cost", runId, "done", undefined, { budgetExceeded: true });
    const second = await tickRsiScheduler(
      deps(root, {
        isOnlineBusy: () => false,
        taskState: (id) => (id === "task-cost" ? "done" : undefined),
        start,
      }),
    );
    expect(second.action).toBe("cycle-budget-stop");
    const state = await loadSchedulerState(root, NOW);
    expect(state.runtime.cycle).toBeUndefined();
    expect(state.runtime.lastCycle?.budgetExceeded).toBe(true);
  });

  it("experimentQuotaFactor 消费方:downshift 时 experiments 派单带配额因子,其它机制不带", async () => {
    await mkdir(join(root, ".genie", "rsi"), { recursive: true });
    await writeFile(
      join(root, ".genie", "rsi", "cost.jsonl"),
      JSON.stringify({
        v: 1,
        type: "downshift",
        at: new Date(NOW).toISOString(),
        action: "downshift",
        quota: { nightlyWindowFactor: 1, experimentQuotaFactor: 0.5 },
        negativeStreak: 4,
      }) + "\n",
      "utf8",
    );
 // 只排 experiments:nightlyWindowFactor=1 → 机制集不裁;配额只作用于 experiments 派单入参
    await enable(root, { mechanisms: ["experiments"], roiGate: false });
    const seen: Array<{ mech: string; quota: number | undefined }> = [];
    const start = async (d: StartRunDeps, mech: string) => {
      seen.push({ mech, quota: d.experimentQuotaFactor });
      return { ok: true, id: mech, runId: `run-${mech}`, taskId: `task-${mech}` };
    };
    const first = await tickRsiScheduler(deps(root, { isOnlineBusy: () => false, start }));
    expect(first.action).toBe("started");
    expect(seen).toEqual([{ mech: "experiments", quota: 0.5 }]);
  });

  it("experimentQuotaFactor:无降频/因子>=1 时派单不带配额(旧行为不变)", async () => {
    await enable(root, { mechanisms: ["experiments"], roiGate: false });
    const seen: Array<{ mech: string; quota: number | undefined }> = [];
    const start = async (d: StartRunDeps, mech: string) => {
      seen.push({ mech, quota: d.experimentQuotaFactor });
      return { ok: true, id: mech, runId: `run-${mech}`, taskId: `task-${mech}` };
    };
    const first = await tickRsiScheduler(deps(root, { isOnlineBusy: () => false, start }));
    expect(first.action).toBe("started");
    expect(seen).toEqual([{ mech: "experiments", quota: undefined }]);
  });

  it("周期收口等结账:刚结束但无成本的 run → settling,不写 0 成本;成本到位后收口", async () => {
    await enable(root, { mechanisms: ["cost"] });
    const start = async (_d: StartRunDeps, mech: string) => ({ ok: true, id: mech, runId: `run-${mech}`, taskId: `task-${mech}` });
    const first = await tickRsiScheduler(deps(root, { isOnlineBusy: () => false, start }));
    const runId = first.runId!;
    await startRun(root, { mechanismId: "cost", runId, taskId: "task-cost", cycleId: first.state.runtime.cycle?.id });
    await finishRun(root, "cost", runId, "done");
    const waiting = await tickRsiScheduler(deps(root, { isOnlineBusy: () => false, start, taskState: () => "done" }));
    expect(waiting.action).toBe("settling");
    const mid = await loadSchedulerState(root, NOW);
    expect(mid.runtime.cycle).toBeDefined();
 // journal 追上后补成本(模拟面板/下一拍结账)
    await finishRun(root, "cost", runId, "done", undefined, {
      cost: { inputTokens: 100, cachedTokens: 0, outputTokens: 50, totalTokens: 150, amountCny: 0.5, missing: [] },
      finishedAt: Date.now(),
    });
    const done = await tickRsiScheduler(deps(root, { isOnlineBusy: () => false, start, taskState: () => "done" }));
    expect(done.action).toBe("cycle-done");
    expect(done.state.runtime.lastCycle?.costTokens).toBe(150);
    expect(done.state.runtime.lastCycle?.amountCny).toBe(0.5);
  });

  it("周期聚合预算:单 run 未超但周期累计超 → 收口,余下机制不派", async () => {
    await enable(root, { mechanisms: ["cost", "tools"], tokenBudgetPerCycle: 1000, tokenBudgetPerRun: 0, roiGate: false });
    const calls: string[] = [];
    const start = async (_d: StartRunDeps, mech: string) => {
      calls.push(mech);
      return { ok: true, id: mech, runId: `run-${mech}`, taskId: `task-${mech}` };
    };
    const first = await tickRsiScheduler(deps(root, { isOnlineBusy: () => false, start }));
    expect(first.action).toBe("started");
    const runId = first.runId!;
    await startRun(root, { mechanismId: "cost", runId, taskId: "task-cost", sessionId: "rsi", cycleId: first.state.runtime.cycle?.id });
    await finishRun(root, "cost", runId, "done", undefined, {
      cost: { inputTokens: 900, cachedTokens: 0, outputTokens: 300, totalTokens: 1200, amountCny: 0.5, missing: [] },
    });
    const second = await tickRsiScheduler(
      deps(root, { isOnlineBusy: () => false, taskState: (id) => (id === "task-cost" ? "done" : undefined), start }),
    );
    expect(second.action).toBe("cycle-budget-stop");
    expect(calls).toEqual(["cost"]); // tools 未被派
    const state = await loadSchedulerState(root, NOW);
    expect(state.runtime.cycle).toBeUndefined();
    expect(state.runtime.lastCycle?.budgetExceeded).toBe(true);
  });

  it("熔断暂停:breaker.paused → 停转;resumeBreaker 人工恢复后回到可调度", async () => {
    await enable(root);
    await pauseBreaker(root, { by: "test", reason: "手动熔断", scope: "all", trigger: "manual" });
    const paused = await tickRsiScheduler(deps(root, { isOnlineBusy: () => false }));
    expect(paused.action).toBe("breaker-paused");
    expect(paused.state.runtime.breaker?.paused).toBe(true);

    const resumed = await setSchedulerConfig(root, { resumeBreaker: true }, "human", NOW);
    expect(resumed.ok).toBe(true);
    expect(resumed.breakerResumed).toBe(true);

    const start = async (_d: StartRunDeps, mech: string) => ({ ok: true, id: mech, runId: `run-${mech}` });
    const r = await tickRsiScheduler(deps(root, { isOnlineBusy: () => false, start }));
    expect(r.action).toBe("started");
  });

  it("collectSchedulerStatus:只读快照带熔断态;文件缺失给缺省(不写盘)", async () => {
    const snap = await collectSchedulerStatus(root, NOW);
    expect(snap.config.enabled).toBe(false);
    expect(snap.runtime.breaker?.paused).toBe(false);
    let text = "";
    try {
      text = await readFile(schedulerPath(root), "utf8");
    } catch {
      text = "";
    }
    expect(text).toBe("");
  });

  it("坏 scheduler.json:按缺省处理(不 throw),下次 set 原子重写", async () => {
    await mkdir(join(root, ".genie", "rsi"), { recursive: true });
    await writeFile(schedulerPath(root), "{bad json", "utf8");
    const state = await loadSchedulerState(root, NOW);
    expect(state.config.enabled).toBe(false);
    await enable(root);
    const text = await readFile(schedulerPath(root), "utf8");
    expect(JSON.parse(text).config.enabled).toBe(true);
  });
});
