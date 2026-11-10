/**
 * 夜间离线整合调度(nightly-run):幂等键 / 六步状态机 / 预算暂停 / 覆盖累加 / 候选去重截断 /
 * finalize 门 / 四段报告 / 五条挖掘规则 / 非法输入。
 * 全部纯数据 + 固定时间戳,不碰文件与真实时钟。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_MAX_TOKENS,
  NIGHTLY_CODES,
  NIGHTLY_STEPS,
  NIGHTLY_VERSION,
  addCandidates,
  addUnprocessed,
  buildRunReport,
  finalizeRun,
  markStep,
  mineCandidates,
  nextStep,
  pauseRun,
  planRunSteps,
  recordCoverage,
  resumeRun,
  retryRun,
  runKey,
  shouldSkipCompleted,
  startRun,
} from "../src/agent/nightly-run.ts";
import type {
  MineSessionStats,
  NightlyCandidate,
  NightlyCode,
  NightlyConfig,
  NightlyRun,
  NightlyStepStatus,
} from "../src/agent/nightly-run.ts";

const T0 = 1_700_000_000_000;
const T1 = T0 + 60_000;
const T0_ISO = "2023-11-14T22:13:20.000Z";
const DATE = "2026-03-07";

function makeRun(projectId = "demo", config?: NightlyConfig, date = DATE): NightlyRun {
  const result = startRun({ date, projectId, now: T0, ...(config ? { config } : {}) });
  if (!result.run) throw new Error("startRun returned null for valid input");
  return result.run;
}

function completeAll(run: NightlyRun, tokens = 0): NightlyRun {
  let current = run;
  for (const name of NIGHTLY_STEPS) {
    current = markStep(current, { name, status: "done", tokens, at: T1 }).run;
  }
  return current;
}

function session(id: string, patch: Partial<MineSessionStats> = {}): MineSessionStats {
  return {
    id,
    tools: {},
    repeatedReads: 0,
    unresolvedAsks: 0,
    failedSteps: 0,
    filesEdited: 0,
    fanoutEdges: 0,
    ...patch,
  };
}

function candidate(id: string, kind: NightlyCandidate["kind"] = "tip"): NightlyCandidate {
  return { id, kind, ref: `ref-${id}`, reason: `why-${id}`, evidenceRefs: [`s-${id}`] };
}

describe("常量与导出面", () => {
  it("版本是 1", () => {
    expect(NIGHTLY_VERSION).toBe(1);
  });

  it("14 个稳定码,值等于键名", () => {
    const entries = Object.entries(NIGHTLY_CODES);
    expect(entries).toHaveLength(14);
    for (const [key, value] of entries) expect(value).toBe(key);
    expect(NIGHTLY_CODES.NIGHTLY_SKIPPED_ONLINE_BUSY).toBe("NIGHTLY_SKIPPED_ONLINE_BUSY");
    expect(NIGHTLY_CODES.NIGHTLY_BUDGET_EXCEEDED).toBe("NIGHTLY_BUDGET_EXCEEDED");
  });

  it("默认预算与候选上限是约定值", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(200_000);
    expect(DEFAULT_MAX_CANDIDATES).toBe(50);
  });

  it("六步顺序固定", () => {
    expect([...NIGHTLY_STEPS]).toEqual([
      "pull-traces",
      "denoise",
      "mine",
      "update-graph",
      "generate-candidates",
      "queue-experiments",
    ]);
  });
});

describe("runKey / startRun", () => {
  it("幂等键形如 nightly:<projectId>:<date>", () => {
    expect(runKey(DATE, "demo")).toBe("nightly:demo:2026-03-07");
  });

  it("runId 确定性", () => {
    expect(makeRun().runId).toBe("ngt-demo-2026-03-07");
    expect(makeRun("other").runId).toBe("ngt-other-2026-03-07");
  });

  it("idempotencyKey = runKey,createdAt/updatedAt = now 的 ISO", () => {
    const run = makeRun();
    expect(run.idempotencyKey).toBe(runKey(DATE, "demo"));
    expect(run.createdAt).toBe(T0_ISO);
    expect(run.updatedAt).toBe(T0_ISO);
  });

  it("正常启动:pending + 六步 pending + STARTED", () => {
    const result = startRun({ date: DATE, projectId: "demo", now: T0 });
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_STARTED] satisfies NightlyCode[]);
    expect(result.run?.status).toBe("pending");
    expect(result.run?.steps.map((step) => step.name)).toEqual([...NIGHTLY_STEPS]);
    expect(result.run?.steps.every((step) => step.status === "pending")).toBe(true);
    expect(result.run?.steps.every((step) => step.consumedTokens === 0)).toBe(true);
  });

  it("默认 window 是本地日历 [date 00:00, 次日 00:00)", () => {
    const run = makeRun();
    expect(run.window.from).toBe("2026-03-07T00:00:00.000");
    expect(run.window.to).toBe("2026-03-08T00:00:00.000");
  });

  it("window 跨月跨年正确", () => {
    expect(makeRun("demo", undefined, "2026-12-31").window).toEqual({
      from: "2026-12-31T00:00:00.000",
      to: "2027-01-01T00:00:00.000",
    });
  });

  it("window 闰日正确", () => {
    expect(makeRun("demo", undefined, "2024-02-28").window.to).toBe("2024-02-29T00:00:00.000");
    expect(makeRun("demo", undefined, "2023-02-28").window.to).toBe("2023-03-01T00:00:00.000");
  });

  it("windowFrom / windowTo 覆盖缺省", () => {
    const run = makeRun("demo", { windowFrom: "2026-03-06T22:00:00.000", windowTo: "2026-03-07T06:00:00.000" });
    expect(run.window).toEqual({ from: "2026-03-06T22:00:00.000", to: "2026-03-07T06:00:00.000" });
  });

  it("缺省 maxTokens 与自定义 maxTokens", () => {
    expect(makeRun().budget).toEqual({ tokens: 0, maxTokens: DEFAULT_MAX_TOKENS });
    expect(makeRun("demo", { maxTokens: 1000 }).budget.maxTokens).toBe(1000);
  });

  it("非法 maxTokens 回落到缺省", () => {
    expect(makeRun("demo", { maxTokens: Number.NaN }).budget.maxTokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it("coverage 全 0 / cursor 空 / 候选与未处理为空", () => {
    const run = makeRun();
    expect(run.coverage).toEqual({
      sessionsTotal: 0,
      sessionsProcessed: 0,
      sessionsSkipped: 0,
      eventsRead: 0,
      eventsSkipped: 0,
    });
    expect(run.cursor).toEqual({});
    expect(run.candidates).toEqual([]);
    expect(run.unprocessed).toEqual([]);
  });

  it("onlineBusy 默认跳过:skipped + 空 steps + SKIPPED_ONLINE_BUSY", () => {
    const result = startRun({ date: DATE, projectId: "demo", now: T0, config: { onlineBusy: true } });
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_SKIPPED_ONLINE_BUSY]);
    expect(result.run?.status).toBe("skipped");
    expect(result.run?.steps).toEqual([]);
  });

  it("onlineBusy 且 deferWhenBusy=false 不跳过", () => {
    const result = startRun({
      date: DATE,
      projectId: "demo",
      now: T0,
      config: { onlineBusy: true, deferWhenBusy: false },
    });
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_STARTED]);
    expect(result.run?.status).toBe("pending");
    expect(result.run?.steps).toHaveLength(6);
  });

  it("非法 date 返回 null + NIGHTLY_INVALID", () => {
    for (const bad of ["2026-03-7", "26-03-07", "", "2026/03/07", "2026-13-01", "2026-02-30"]) {
      const result = startRun({ date: bad, projectId: "demo", now: T0 });
      expect(result.run).toBeNull();
      expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_INVALID]);
    }
  });

  it("空 / 空白 projectId 返回 null + NIGHTLY_INVALID", () => {
    expect(startRun({ date: DATE, projectId: "", now: T0 }).run).toBeNull();
    const blank = startRun({ date: DATE, projectId: "   ", now: T0 });
    expect(blank.run).toBeNull();
    expect(blank.codes).toEqual([NIGHTLY_CODES.NIGHTLY_INVALID]);
  });
});

describe("shouldSkipCompleted", () => {
  it("同 key 且 done → true", () => {
    const done = completeAll(makeRun());
    expect(done.status).toBe("running");
    const finished = finalizeRun(done, { at: T1 }).run;
    expect(finished.status).toBe("done");
    expect(shouldSkipCompleted([finished], runKey(DATE, "demo"))).toBe(true);
  });

  it("同 key 但未 done → false", () => {
    expect(shouldSkipCompleted([makeRun()], runKey(DATE, "demo"))).toBe(false);
  });

  it("不同 key / 空列表 → false", () => {
    const done = finalizeRun(completeAll(makeRun()), { at: T1 }).run;
    expect(shouldSkipCompleted([done], runKey(DATE, "other"))).toBe(false);
    expect(shouldSkipCompleted([], runKey(DATE, "demo"))).toBe(false);
  });
});

describe("planRunSteps / nextStep", () => {
  it("planRunSteps 重置为六步 pending 且不改入参", () => {
    const started = completeAll(makeRun());
    const snapshot = structuredClone(started);
    const replanned = planRunSteps(started);
    expect(replanned.steps).toHaveLength(6);
    expect(replanned.steps.every((step) => step.status === "pending" && step.consumedTokens === 0)).toBe(
      true);
    expect(started).toEqual(snapshot);
  });

  it("nextStep 是首步 pull-traces", () => {
    expect(nextStep(makeRun())?.name).toBe("pull-traces");
  });

  it("nextStep 跳过已 done 的步骤", () => {
    const afterOne = markStep(makeRun(), { name: "pull-traces", status: "done", at: T1 }).run;
    expect(nextStep(afterOne)?.name).toBe("denoise");
  });

  it("nextStep 在 paused / failed / done / skipped 时为 undefined", () => {
    const paused = pauseRun(makeRun(), { reason: "manual", at: T1 }).run;
    expect(nextStep(paused)).toBeUndefined();
    const failed = markStep(makeRun(), { name: "mine", status: "failed", error: "boom", at: T1 }).run;
    expect(nextStep(failed)).toBeUndefined();
    const done = finalizeRun(completeAll(makeRun()), { at: T1 }).run;
    expect(nextStep(done)).toBeUndefined();
    const skipped = startRun({ date: DATE, projectId: "demo", now: T0, config: { onlineBusy: true } }).run;
    expect(skipped && nextStep(skipped)).toBeUndefined();
  });
});

describe("markStep", () => {
  it("正常完成一步:STEP_DONE + finishedAt + updatedAt", () => {
    const result = markStep(makeRun(), { name: "denoise", status: "done", at: T1 });
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_STEP_DONE]);
    const step = result.run.steps.find((entry) => entry.name === "denoise");
    expect(step?.status).toBe("done");
    expect(step?.startedAt).toBe("2023-11-14T22:14:20.000Z");
    expect(step?.finishedAt).toBe("2023-11-14T22:14:20.000Z");
    expect(result.run.updatedAt).toBe("2023-11-14T22:14:20.000Z");
    expect(result.run.status).toBe("running");
  });

  it("tokens 累加到步骤与 run.budget", () => {
    const first = markStep(makeRun(), { name: "pull-traces", status: "done", tokens: 120, at: T1 });
    const second = markStep(first.run, { name: "denoise", status: "done", tokens: 80, at: T1 });
    expect(second.run.steps[0]?.consumedTokens).toBe(120);
    expect(second.run.steps[1]?.consumedTokens).toBe(80);
    expect(second.run.budget.tokens).toBe(200);
    expect(second.run.budget.maxTokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it("同一步多次累加", () => {
    const once = markStep(makeRun(), { name: "mine", status: "running", tokens: 10, at: T1 });
    const twice = markStep(once.run, { name: "mine", status: "done", tokens: 15, at: T1 });
    expect(twice.run.steps[2]?.consumedTokens).toBe(25);
    expect(twice.run.budget.tokens).toBe(25);
  });

  it("超预算:run paused + pauseReason=budget,本步仍 done,码含 STEP_DONE 与 BUDGET_EXCEEDED", () => {
    const run = makeRun("demo", { maxTokens: 100 });
    const result = markStep(run, { name: "pull-traces", status: "done", tokens: 150, at: T1 });
    expect(result.run.status).toBe("paused");
    expect(result.run.pauseReason).toBe("budget");
    expect(result.run.steps[0]?.status).toBe("done");
    expect(result.codes).toEqual([
      NIGHTLY_CODES.NIGHTLY_STEP_DONE,
      NIGHTLY_CODES.NIGHTLY_BUDGET_EXCEEDED,
    ]);
  });

  it("恰好等于上限不暂停", () => {
    const run = makeRun("demo", { maxTokens: 100 });
    const result = markStep(run, { name: "pull-traces", status: "done", tokens: 100, at: T1 });
    expect(result.run.status).toBe("running");
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_STEP_DONE]);
  });

  it("failed 步骤 → run failed + NIGHTLY_FAILED", () => {
    const result = markStep(makeRun(), { name: "mine", status: "failed", error: "boom", at: T1 });
    expect(result.run.status).toBe("failed");
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_FAILED]);
    const step = result.run.steps.find((entry) => entry.name === "mine");
    expect(step?.status).toBe("failed");
    expect(step?.error).toBe("boom");
    expect(step?.finishedAt).toBe("2023-11-14T22:14:20.000Z");
  });

  it("未知步骤名 → BAD_STEP 且 run 原样返回", () => {
    const run = makeRun();
    const result = markStep(run, { name: "bogus" as unknown as NightlyRun["steps"][number]["name"], status: "done", at: T1 });
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_BAD_STEP]);
    expect(result.run).toBe(run);
  });

  it("非法步骤状态 → BAD_STEP 且 run 原样返回", () => {
    const run = makeRun();
    const result = markStep(run, {
      name: "mine",
      status: "paused" as unknown as NightlyStepStatus,
      at: T1,
    });
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_BAD_STEP]);
    expect(result.run).toBe(run);
  });

  it("不 mutate 入参", () => {
    const run = makeRun();
    const snapshot = structuredClone(run);
    markStep(run, { name: "pull-traces", status: "done", tokens: 42, at: T1 });
    expect(run).toEqual(snapshot);
  });
});

describe("pauseRun / resumeRun / retryRun", () => {
  it("pending 可暂停", () => {
    const result = pauseRun(makeRun(), { reason: "user", at: T1 });
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_PAUSED]);
    expect(result.run.status).toBe("paused");
    expect(result.run.pauseReason).toBe("user");
    expect(result.run.updatedAt).toBe("2023-11-14T22:14:20.000Z");
  });

  it("running 可暂停", () => {
    const running = markStep(makeRun(), { name: "pull-traces", status: "done", at: T1 }).run;
    expect(pauseRun(running, { reason: "budget", at: T1 }).run.status).toBe("paused");
  });

  it("done 不可暂停 → INVALID 且 run 原样", () => {
    const done = finalizeRun(completeAll(makeRun()), { at: T1 }).run;
    const result = pauseRun(done, { reason: "x", at: T1 });
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_INVALID]);
    expect(result.run).toBe(done);
  });

  it("resume 把 failed 步骤重置 pending 并清 error/finishedAt", () => {
    const failed = markStep(makeRun(), { name: "mine", status: "failed", error: "boom", at: T1 }).run;
    const result = resumeRun(failed, { at: T1 });
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_RESUMED]);
    expect(result.run.status).toBe("running");
    const step = result.run.steps.find((entry) => entry.name === "mine");
    expect(step?.status).toBe("pending");
    expect(step?.error).toBeUndefined();
    expect(step?.finishedAt).toBeUndefined();
  });

  it("resume 清掉 pauseReason 并保留已 done 步骤", () => {
    const paused = pauseRun(
      markStep(makeRun(), { name: "pull-traces", status: "done", tokens: 5, at: T1 }).run,
      { reason: "budget", at: T1 },
    ).run;
    const resumed = resumeRun(paused, { at: T1 }).run;
    expect(resumed.status).toBe("running");
    expect(resumed.pauseReason).toBeUndefined();
    expect(resumed.steps[0]?.status).toBe("done");
    expect(resumed.budget.tokens).toBe(5);
    expect(nextStep(resumed)?.name).toBe("denoise");
  });

  it("resume 对 pending 无效", () => {
    const run = makeRun();
    const result = resumeRun(run, { at: T1 });
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_INVALID]);
    expect(result.run).toBe(run);
  });

  it("retry 只对 failed 有效", () => {
    const failed = markStep(makeRun(), { name: "denoise", status: "failed", at: T1 }).run;
    const result = retryRun(failed, { at: T1 });
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_RETRIED]);
    expect(result.run.status).toBe("running");
    expect(result.run.steps[1]?.status).toBe("pending");
  });

  it("retry 对 paused 无效", () => {
    const paused = pauseRun(makeRun(), { reason: "manual", at: T1 }).run;
    const result = retryRun(paused, { at: T1 });
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_INVALID]);
    expect(result.run).toBe(paused);
  });
});

describe("recordCoverage / addCandidates / addUnprocessed", () => {
  it("覆盖四项分别累加", () => {
    const first = recordCoverage(makeRun(), {
      coverage: { sessionsTotal: 4, sessionsProcessed: 3, sessionsSkipped: 1, eventsRead: 40, eventsSkipped: 9 },
    });
    const second = recordCoverage(first, { coverage: { sessionsTotal: 2, eventsRead: 10 } });
    expect(second.coverage).toEqual({
      sessionsTotal: 6,
      sessionsProcessed: 3,
      sessionsSkipped: 1,
      eventsRead: 50,
      eventsSkipped: 9,
    });
  });

  it("缺字段按 0,入参不变", () => {
    const run = makeRun();
    const snapshot = structuredClone(run);
    const next = recordCoverage(run, { coverage: { eventsSkipped: 2 } });
    expect(next.coverage.eventsSkipped).toBe(2);
    expect(next.coverage.sessionsTotal).toBe(0);
    expect(run).toEqual(snapshot);
  });

  it("候选按 id 去重,先出现的保留", () => {
    const run = addCandidates(makeRun(), [candidate("c1"), candidate("c2", "gate")]).run;
    const result = addCandidates(run, [candidate("c1", "refactor"), candidate("c3", "tool")]);
    expect(result.codes).toEqual([]);
    expect(result.run.candidates.map((entry) => entry.id)).toEqual(["c1", "c2", "c3"]);
    expect(result.run.candidates[0]?.kind).toBe("tip");
  });

  it("候选截断到上限", () => {
    const many = Array.from({ length: 8 }, (_, index) => candidate(`c${index}`));
    const result = addCandidates(makeRun(), many, { maxCandidates: 5 });
    expect(result.run.candidates).toHaveLength(5);
    expect(result.run.candidates.map((entry) => entry.id)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
  });

  it("已有候选占用上限名额", () => {
    const seeded = addCandidates(makeRun(), [candidate("c0")], { maxCandidates: 1 }).run;
    const result = addCandidates(seeded, [candidate("c1")], { maxCandidates: 1 });
    expect(result.run.candidates.map((entry) => entry.id)).toEqual(["c0"]);
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_NO_CANDIDATES]);
  });

  it("空候选 → NO_CANDIDATES", () => {
    const result = addCandidates(makeRun(), []);
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_NO_CANDIDATES]);
    expect(result.run.candidates).toEqual([]);
  });

  it("全部重复 / 非法条目 → NO_CANDIDATES", () => {
    const run = addCandidates(makeRun(), [candidate("c1")]).run;
    const dup = addCandidates(run, [candidate("c1")]);
    expect(dup.codes).toEqual([NIGHTLY_CODES.NIGHTLY_NO_CANDIDATES]);
    const junk = addCandidates(makeRun(), [
      { id: "", kind: "tip", ref: "r", reason: "x", evidenceRefs: [] },
      { id: "c9", kind: "nope" as unknown as NightlyCandidate["kind"], ref: "r", reason: "x", evidenceRefs: [] },
    ]);
    expect(junk.codes).toEqual([NIGHTLY_CODES.NIGHTLY_NO_CANDIDATES]);
  });

  it("未处理项追加 + UNPROCESSED", () => {
    const result = addUnprocessed(makeRun(), [{ sessionId: "s1", reason: "noise" }]);
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_UNPROCESSED]);
    expect(result.run.unprocessed).toEqual([{ sessionId: "s1", reason: "noise" }]);
  });

  it("空未处理项返回原样且无码", () => {
    const run = makeRun();
    const result = addUnprocessed(run, []);
    expect(result.codes).toEqual([]);
    expect(result.run.unprocessed).toEqual([]);
  });
});

describe("finalizeRun / buildRunReport", () => {
  it("有 pending 步骤 → BAD_STEP 且 run 原样", () => {
    const partial = markStep(makeRun(), { name: "pull-traces", status: "done", at: T1 }).run;
    const result = finalizeRun(partial, { at: T1 });
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_BAD_STEP]);
    expect(result.run).toBe(partial);
    expect(result.run.status).toBe("running");
  });

  it("六步全 done → done + FINALIZED + 自动报告", () => {
    const result = finalizeRun(completeAll(makeRun()), { at: T1 });
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_FINALIZED]);
    expect(result.run.status).toBe("done");
    expect(result.run.updatedAt).toBe("2023-11-14T22:14:20.000Z");
    expect(result.run.report?.length).toBeGreaterThan(0);
  });

  it("含 skipped 步骤也算完成", () => {
    let run = makeRun();
    for (const name of NIGHTLY_STEPS) {
      run = markStep(run, { name, status: name === "queue-experiments" ? "skipped" : "done", at: T1 }).run;
    }
    const result = finalizeRun(run, { at: T1 });
    expect(result.codes).toEqual([NIGHTLY_CODES.NIGHTLY_FINALIZED]);
    expect(result.run.status).toBe("done");
  });

  it("传进来的 report 优先", () => {
    const result = finalizeRun(completeAll(makeRun()), { at: T1, report: ["custom-a", "custom-b"] });
    expect(result.run.report).toEqual(["custom-a", "custom-b"]);
  });

  it("buildRunReport 含身份 / window / 四段", () => {
    const run = addUnprocessed(
      addCandidates(completeAll(makeRun()), [candidate("c1")]).run,
      [{ sessionId: "s1", reason: "noise" }],
    ).run;
    const lines = buildRunReport(run);
    expect(lines[0]).toContain("ngt-demo-2026-03-07");
    expect(lines[1]).toContain("2026-03-07");
    expect(lines[1]).toContain("demo");
    expect(lines[1]).toContain("status");
    expect(lines.some((line) => line.startsWith("window:") && line.includes("2026-03-07T00:00:00.000"))).toBe(
      true);
    expect(lines.some((line) => line.startsWith("coverage:"))).toBe(true);
    expect(lines).toContain("candidates: 1");
    expect(lines).toContain("unprocessed: 1");
    expect(lines.some((line) => line.startsWith("budget:") && line.includes("max=200000"))).toBe(true);
  });

  it("buildRunReport 每步一行 name: status tokens=N", () => {
    const lines = buildRunReport(completeAll(makeRun(), 7));
    for (const name of NIGHTLY_STEPS) {
      expect(lines.some((line) => line.includes(`${name}: done tokens=7`))).toBe(true);
    }
    expect(lines.some((line) => line.includes("pull-traces: done tokens=7"))).toBe(true);
  });

  it("paused run 的报告带 pause 行", () => {
    const paused = pauseRun(makeRun(), { reason: "budget", at: T1 }).run;
    expect(buildRunReport(paused).some((line) => line === "pause: budget")).toBe(true);
  });
});

describe("mineCandidates", () => {
  it("tip:跨两个 session 的 repeatedReads ≥3 合并成一条并列出全部证据", () => {
    const candidates = mineCandidates({
      sessions: [session("s1", { repeatedReads: 3 }), session("s2", { repeatedReads: 4 })],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe("tip");
    expect(candidates[0]?.id).toBe("cand-tip-repeated-reads");
    expect(candidates[0]?.reason).toContain("重复读取");
    expect(candidates[0]?.evidenceRefs).toEqual(["s1", "s2"]);
  });

  it("tip:单 session 的 repeatedReads ≥3 不命中", () => {
    expect(mineCandidates({ sessions: [session("s1", { repeatedReads: 5 })] })).toEqual([]);
  });

  it("gate:unresolvedAsks ≥1 命中", () => {
    const candidates = mineCandidates({ sessions: [session("s1"), session("s2", { unresolvedAsks: 2 })] });
    expect(candidates.map((entry) => entry.kind)).toEqual(["gate"]);
    expect(candidates[0]?.reason).toContain("悬空提问");
    expect(candidates[0]?.evidenceRefs).toEqual(["s2"]);
  });

  it("tool:failedSteps ≥2 命中", () => {
    const candidates = mineCandidates({ sessions: [session("s1", { failedSteps: 2 })] });
    expect(candidates.map((entry) => entry.kind)).toEqual(["tool"]);
    expect(candidates[0]?.id).toBe("cand-tool-failed-steps");
    expect(candidates[0]?.reason).toContain("工具失败");
  });

  it("tool:failedSteps=1 不命中", () => {
    expect(mineCandidates({ sessions: [session("s1", { failedSteps: 1 })] })).toEqual([]);
  });

  it("refactor:fanoutEdges ≥2 命中", () => {
    const candidates = mineCandidates({ sessions: [session("s1"), session("s2", { fanoutEdges: 2 })] });
    expect(candidates.map((entry) => entry.kind)).toEqual(["refactor"]);
    expect(candidates[0]?.reason).toContain("扇出未闭合");
  });

  it("experiment:ΣfilesEdited ≥5 且 ≥2 session 命中", () => {
    const candidates = mineCandidates({
      sessions: [session("s1", { filesEdited: 3 }), session("s2", { filesEdited: 2 })],
    });
    expect(candidates.map((entry) => entry.kind)).toEqual(["experiment"]);
    expect(candidates[0]?.reason).toContain("热点文件");
    expect(candidates[0]?.evidenceRefs).toEqual(["s1", "s2"]);
  });

  it("experiment:单 session 编辑再多也不命中", () => {
    expect(mineCandidates({ sessions: [session("s1", { filesEdited: 9 })] })).toEqual([]);
  });

  it("experiment:Σ 不足 5 不命中", () => {
    expect(
      mineCandidates({ sessions: [session("s1", { filesEdited: 2 }), session("s2", { filesEdited: 2 })] }),
    ).toEqual([]);
  });

  it("五条规则全命中时顺序固定", () => {
    const candidates = mineCandidates({
      sessions: [
        session("s1", { repeatedReads: 3, unresolvedAsks: 1, failedSteps: 2, filesEdited: 3, fanoutEdges: 2 }),
        session("s2", { repeatedReads: 3, filesEdited: 2 }),
      ],
    });
    expect(candidates.map((entry) => entry.kind)).toEqual(["tip", "gate", "tool", "refactor", "experiment"]);
    expect(new Set(candidates.map((entry) => entry.id)).size).toBe(candidates.length);
  });

  it("空 / 非法 stats 返回空数组", () => {
    expect(mineCandidates({ sessions: [] })).toEqual([]);
    expect(mineCandidates({ sessions: null as unknown as MineSessionStats[] })).toEqual([]);
    expect(mineCandidates(undefined as unknown as { sessions: MineSessionStats[] })).toEqual([]);
  });

  it("同输入同输出(确定性)", () => {
    const stats = { sessions: [session("s1", { repeatedReads: 3 }), session("s2", { repeatedReads: 3 })] };
    expect(mineCandidates(stats)).toEqual(mineCandidates(stats));
  });
});
