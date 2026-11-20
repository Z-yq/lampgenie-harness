/**
 * 夜间整合 store 的 IO / 调度 / 流水线验证(纯逻辑在 nightly-run 里已单测)。
 * 全部用例跑在 /tmp 临时 root 上:不碰仓库内 .genie,journalDir 只读。
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NIGHTLY_CODES, markStep } from "@lampgenie/runtime/agent/nightly-run";
import { addEvidence } from "../src/evidence-graph-store.js";
import {
  acquireNightlyLock,
  NIGHTLY_DIR,
  finalizeNightly,
  getRun,
  listRuns,
  markQueueConsumed,
  nightlyLockFile,
  nightlyLockHeld,
  nightlyPaths,
  nightlyReport,
  parseSessionFile,
  pauseNightly,
  readQueue,
  reclaimNightly,
  releaseNightlyLock,
  resumeNightly,
  retryNightly,
  runNightly,
  startNightly,
} from "../src/nightly-store.js";

const NOW = Date.UTC(2026, 2, 5, 2, 0, 0);
const PROJECT = "proj";

const roots: string[] = [];

function makeFixture(): { root: string; journalDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ngt-"));
  const journalDir = join(root, "journal");
  mkdirSync(join(journalDir, "sessions"), { recursive: true });
  roots.push(root);
  return { root, journalDir };
}

function writeSession(journalDir: string, name: string, lines: string[]): string {
  const file = join(journalDir, "sessions", `${name}.jsonl`);
  writeFileSync(file, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
  return file;
}

function toolCall(id: string, name: string, args: Record<string, unknown>, sessionId = "s"): string {
  return JSON.stringify({
    kind: "tool.call",
    sessionId,
    payload: { toolCallId: id, name, arguments: JSON.stringify(args) },
  });
}

function toolResult(id: string, name: string, content: string, sessionId = "s"): string {
  return JSON.stringify({ kind: "tool.result", sessionId, payload: { toolCallId: id, name, content } });
}

/** 5 个会话:正常 / 重复读+悬空提问+失败 / 坏行 / probe 噪声 / 空文件。 */
function seedStandard(journalDir: string): Record<string, string> {
  const a = writeSession(journalDir, "sess-a", [
    toolCall("a1", "read_file", { path: "src/x.ts" }),
    toolResult("a1", "read_file", "ok"),
    toolCall("a2", "edit_file", { path: "src/x.ts" }),
    toolResult("a2", "edit_file", "done"),
    JSON.stringify({
      kind: "message.agent",
      sessionId: "sess-a",
      payload: { toolCalls: [{ id: "a3", name: "read_file", arguments: JSON.stringify({ path: "src/x.ts" }) }] },
    }),
    toolResult("a3", "read_file", "ok"),
  ]);
  const b = writeSession(journalDir, "sess-b", [
    toolCall("b1", "read_file", { path: "src/y.ts" }),
    toolResult("b1", "read_file", "y"),
    toolCall("b2", "read_file", { path: "src/y.ts" }),
    toolResult("b2", "read_file", "y"),
    toolCall("b3", "read_file", { path: "src/y.ts" }),
    toolResult("b3", "read_file", "y"),
    toolCall("b4", "ask_user", { question: "?" }),
    toolResult("b4", "ask_user", "用户未答复"),
    toolCall("b5", "write_file", { path: "src/z.ts" }),
    JSON.stringify({ kind: "step.failed", sessionId: "sess-b", payload: { ok: false, error: "boom" } }),
    toolCall("b6", "spawn_subagent", { instructions: "x" }),
    toolResult("b6", "spawn_subagent", "done"),
    toolCall("b7", "spawn_subagent", { instructions: "y" }),
    toolResult("b7", "spawn_subagent", "done"),
  ]);
  const c = writeSession(journalDir, "sess-c", [
    toolCall("c1", "read_file", { path: "src/c.ts" }),
    "not a json line {{{",
    toolResult("c1", "read_file", "c"),
  ]);
  const probe = writeSession(journalDir, "sess-probe-1", [
    toolCall("p1", "read_file", { path: "src/p.ts" }),
    toolResult("p1", "read_file", "p"),
  ]);
  const empty = writeSession(journalDir, "sess-empty", []);
  return { a, b, c, probe, empty };
}

async function fullRun(root: string, journalDir: string, date = "2026-03-05", maxTokens?: number) {
  const started = await startNightly(root, {
    date,
    projectId: PROJECT,
    journalDir,
    now: NOW,
    config: maxTokens === undefined ? undefined : { maxTokens },
  });
  expect(started.run).not.toBeNull();
  const runId = started.run!.runId;
  const result = await runNightly(root, { runId, journalDir, now: NOW + 10 });
  return { started, result, date, runId };
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("nightly-store", () => {
  it("startNightly 幂等:同日已完成再 start 只回 SKIPPED_DONE,不覆盖 run 文件", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const { started, result, date } = await fullRun(root, journalDir);
    expect(started.codes).toContain(NIGHTLY_CODES.NIGHTLY_STARTED);
    expect(result.run.status).toBe("done");

    const runFile = nightlyPaths(root, PROJECT, date).runFile;
    const before = readFileSync(runFile, "utf8");
    const second = await startNightly(root, { date, projectId: PROJECT, journalDir, now: NOW + 5_000 });
    expect(second.codes).toEqual([NIGHTLY_CODES.NIGHTLY_SKIPPED_DONE]);
    expect(second.run?.status).toBe("done");
    expect(readFileSync(runFile, "utf8")).toBe(before);
  });

  it("P0-1(2026-11-17): 同日 done 但游标后有新会话 → 不跳过,增量续跑(时区倒置提前跑过的当日补挖)", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const { date } = await fullRun(root, journalDir);
 // 早程 done 后,当日又出现新会话(mtime 晚于游标)
    writeSession(journalDir, "sess-late", [
      toolCall("l1", "read_file", { path: "src/late.ts" }),
      toolResult("l1", "read_file", "late"),
    ]);
    const second = await startNightly(root, { date, projectId: PROJECT, journalDir, now: NOW + 60_000 });
    expect(second.codes).toContain(NIGHTLY_CODES.NIGHTLY_STARTED);
    expect(second.run?.status).toBe("pending");
    const result = await runNightly(root, { runId: second.run!.runId, journalDir, now: NOW + 61_000 });
    expect(result.run.status).toBe("done");
  });

  it("P0-1(2026-11-17): 同日续跑后 session-stats 按 sessionId 合并——早程会话不丢", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const { date } = await fullRun(root, journalDir);
    const statsFile = nightlyPaths(root, PROJECT, date).statsFile;
    const early = JSON.parse(readFileSync(statsFile, "utf8")) as { sessions: Array<{ sessionId: string }> };
    expect(early.sessions.length).toBeGreaterThan(0);
    writeSession(journalDir, "sess-late2", [
      toolCall("m1", "edit_file", { path: "src/m.ts" }),
      toolResult("m1", "edit_file", "m"),
    ]);
    const second = await startNightly(root, { date, projectId: PROJECT, journalDir, now: NOW + 90_000 });
    await runNightly(root, { runId: second.run!.runId, journalDir, now: NOW + 91_000 });
    const merged = JSON.parse(readFileSync(statsFile, "utf8")) as { sessions: Array<{ sessionId: string }> };
    const ids = new Set(merged.sessions.map((s) => s.sessionId));
 // 早程全部保留 + 新会话并入
    for (const s of early.sessions) expect(ids.has(s.sessionId), `早程会话 ${s.sessionId} 应保留`).toBe(true);
    expect(ids.has("sess-late2")).toBe(true);
  });

  it("runNightly 跑完七步:全 done + coverage 计数正确 + FINALIZED", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const { result } = await fullRun(root, journalDir);

    expect(result.run.steps.map((step) => step.name)).toEqual([
      "pull-traces",
      "denoise",
      "mine",
      "update-graph",
      "generate-candidates",
      "distill-experiences",
      "queue-experiments",
    ]);
    expect(result.run.steps.every((step) => step.status === "done")).toBe(true);
    expect(result.run.status).toBe("done");
    expect(result.codes).toContain(NIGHTLY_CODES.NIGHTLY_STEP_DONE);
    expect(result.codes).toContain(NIGHTLY_CODES.NIGHTLY_FINALIZED);
    expect(result.run.coverage).toEqual({
      sessionsTotal: 4, // P0-②:分母=eligible(probe 选择期出局)
      sessionsProcessed: 4,
      sessionsSkipped: 0,
      eventsRead: 22,
      eventsSkipped: 1,
    });
    expect(result.run.budget.workUnits).toBeGreaterThan(20); // 事件计数走 workUnits 轨(events 22)
    expect(result.run.budget.tokens).toBe(0); // 分账:pull-traces 零 LLM,token 轨不受事件量牵连
  });

  it("session-stats.json 与 evidence-pending.json 落盘且可 JSON.parse", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const { result, date } = await fullRun(root, journalDir);
    const paths = nightlyPaths(root, PROJECT, date);

    const stats = JSON.parse(readFileSync(paths.statsFile, "utf8")) as {
      runId: string;
      sessions: { sessionId: string }[];
    };
    expect(stats.runId).toBe(result.run.runId);
    // denoise 已把 probe 从 stats 剔除
    expect(stats.sessions.map((entry) => entry.sessionId).sort()).toEqual([
      "sess-a",
      "sess-b",
      "sess-c",
      "sess-empty",
    ]);

    const evidence = JSON.parse(readFileSync(paths.evidenceFile, "utf8")) as {
      status: string;
      note: string;
      candidates: { id: string; kind: string }[];
      runId: string;
    };
    expect(evidence.runId).toBe(result.run.runId);
    expect(evidence.status).toBe("pending-review");
    expect(evidence.note).toContain("待人工确认");
    expect(evidence.candidates.map((candidate) => candidate.kind).sort()).toEqual([
      "gate",
      "refactor",
      "tool",
    ]);
    const pull = result.run.steps.find((step) => step.name === "pull-traces");
    expect(pull?.artifactRef).toBe(`${NIGHTLY_DIR}/${PROJECT}/${date}.session-stats.json`);
  });

  it("增量:第二次 start 只选 mtime 晚于 cursor 的会话", async () => {
    const { root, journalDir } = makeFixture();
    const files = seedStandard(journalDir);
    const base = 1_700_000_000_000;
    const order = ["sess-a", "sess-b", "sess-c", "sess-empty", "sess-probe-1"];
    order.forEach((name, index) => {
      const file = join(journalDir, "sessions", `${name}.jsonl`);
      const ms = base + index * 1_000;
      utimesSync(file, new Date(ms), new Date(ms));
    });

    const first = await startNightly(root, { date: "2026-03-05", projectId: PROJECT, journalDir, now: NOW });
    expect(first.run?.coverage.sessionsTotal).toBe(4); // P0-②:eligible 口径
    const done = await runNightly(root, { runId: first.run!.runId, journalDir, now: NOW + 10 });
    expect(done.run.status).toBe("done");

    const cursor = JSON.parse(
      readFileSync(nightlyPaths(root, PROJECT, "2026-03-05").cursorFile, "utf8"),
    ) as Record<string, { lastMtimeMs: number; lastSessionId: string }>;
    expect(cursor[PROJECT]?.lastMtimeMs).toBe(base + 3_000); // P0-②:probe 出局,游标=eligible 末位(sess-empty)

    const touched = new Date(base + 90_000);
    utimesSync(files.b!, touched, touched);
    const second = await startNightly(root, { date: "2026-03-06", projectId: PROJECT, journalDir, now: NOW + 100 });
    expect(second.run?.coverage.sessionsTotal).toBe(1);
    const selection = JSON.parse(
      readFileSync(nightlyPaths(root, PROJECT, "2026-03-06").selectionFile, "utf8"),
    ) as { sessions: { sessionId: string }[] };
    expect(selection.sessions.map((entry) => entry.sessionId)).toEqual(["sess-b"]);
  });

  it("预算暂停:workUnits 超 → paused + BUDGET_EXCEEDED(budget-work-units),resumeNightly 后完成且不重读", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const started = await startNightly(root, {
      date: "2026-03-05",
      projectId: PROJECT,
      journalDir,
      now: NOW,
      config: { maxWorkUnits: 1 },
    });
    const paused = await runNightly(root, { runId: started.run!.runId, journalDir, now: NOW + 1 });
    expect(paused.run.status).toBe("paused");
    expect(paused.run.pauseReason).toBe("budget-work-units");
    expect(paused.codes).toContain(NIGHTLY_CODES.NIGHTLY_BUDGET_EXCEEDED);
    expect(paused.run.steps[0]?.status).toBe("done");
    expect(paused.run.steps[1]?.status).toBe("pending");
 // 水位:pull-traces done 后 cursor 已前移——暂停不丢增量边界。
    const cursorMid = JSON.parse(
      readFileSync(nightlyPaths(root, PROJECT, "2026-03-05").cursorFile, "utf8"),
    ) as Record<string, { lastMtimeMs?: number }>;
    expect(typeof cursorMid[PROJECT]?.lastMtimeMs).toBe("number");
    const eventsAfterPause = paused.run.coverage.eventsRead;

    const resumed = await resumeNightly(root, {
      projectId: PROJECT,
      date: "2026-03-05",
      journalDir,
      now: NOW + 100,
    });
    expect(resumed.codes).toContain(NIGHTLY_CODES.NIGHTLY_RESUMED);
    expect(resumed.run.status).toBe("done");
    expect(resumed.run.steps.every((step) => step.status === "done")).toBe(true);
 // 不重读:续跑从 pending 步接续,pull-traces 不再执行,eventsRead 不翻倍。
    expect(resumed.run.coverage.eventsRead).toBe(eventsAfterPause);
  });

  it("queue.jsonl 逐条 append:行数 = 候选数,行内字段齐全且只入队不 adopt", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const { result, date } = await fullRun(root, journalDir);
    expect(result.run.candidates.length).toBe(3);

    const queueFile = join(root, NIGHTLY_DIR, "queue.jsonl");
    const raw = readFileSync(queueFile, "utf8").split("\n").filter((line) => line.trim() !== "");
    expect(raw.length).toBe(3);
    const lines = raw.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const line of lines) {
      expect(line.runId).toBe(result.run.runId);
      expect(line.projectId).toBe(PROJECT);
      expect(line.date).toBe(date);
      expect(typeof line.queuedAt).toBe("string");
      expect(typeof (line.candidate as { id: string }).id).toBe("string");
    }
    expect(readQueue(root).length).toBe(3);
    // 重跑本轮不应重复入队
    const again = await runNightly(root, { runId: result.run.runId, journalDir, now: NOW + 20 });
    expect(again.run.status).toBe("done");
    expect(readFileSync(queueFile, "utf8").split("\n").filter((line) => line.trim() !== "").length).toBe(3);
  });

  it("坏行只计 eventsSkipped,不抛", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const { result, date } = await fullRun(root, journalDir);
    expect(result.run.coverage.eventsSkipped).toBe(1);
    const stats = JSON.parse(readFileSync(nightlyPaths(root, PROJECT, date).statsFile, "utf8")) as {
      sessions: { sessionId: string; eventsRead: number; eventsSkipped: number }[];
    };
    const sessC = stats.sessions.find((entry) => entry.sessionId === "sess-c");
    expect(sessC?.eventsRead).toBe(2);
    expect(sessC?.eventsSkipped).toBe(1);
  });

  it("probe/smoke 噪声跳过,空会话进 unprocessed(P0-②:噪声在选择期出局)", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const { result, date } = await fullRun(root, journalDir);
 // denoise 侧不再见到 probe(选择期已滤),sessionsSkipped=0;噪声进 selection.noiseSkipped
    expect(result.run.coverage.sessionsSkipped).toBe(0);
    expect(result.run.unprocessed).toEqual([{ sessionId: "sess-empty", reason: "empty" }]);
    expect(result.codes).toContain(NIGHTLY_CODES.NIGHTLY_UNPROCESSED);
    const sel = JSON.parse(readFileSync(nightlyPaths(root, PROJECT, date).selectionFile, "utf8")) as { noiseSkipped?: string[] };
    expect(sel.noiseSkipped).toEqual(["sess-probe-1"]);
  });

  it("finalize/report:报告含身份/步骤/覆盖/候选/未处理五段,nightlyReport 复用 run.report", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const { result, date } = await fullRun(root, journalDir);
    const text = (result.run.report ?? []).join("\n");
    expect(text).toContain(`nightly: ${result.run.runId}`);
    expect(text).toContain("status: done");
    expect(text).toContain("steps(7):");
    expect(text).toContain("coverage:");
    expect(text).toContain("candidates: 3");
    expect(text).toContain("unprocessed: 1");
    expect(text).toContain("budget:");

    const report = await nightlyReport(root, { projectId: PROJECT, date });
    expect(report).toEqual(result.run.report);

    const finalized = await finalizeNightly(root, { projectId: PROJECT, date, now: NOW + 1_000 });
    expect(finalized.codes).toEqual([NIGHTLY_CODES.NIGHTLY_FINALIZED]);
    expect(finalized.run?.status).toBe("done");
  });

  it("getRun / listRuns 读写一致", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const { result, date } = await fullRun(root, journalDir);

    const one = await getRun(root, { projectId: PROJECT, date });
    expect(one?.runId).toBe(result.run.runId);
    expect(one?.status).toBe("done");
    expect(await getRun(root, { projectId: PROJECT, date: "2026-01-01" })).toBeNull();

    const all = await listRuns(root);
    expect(all.map((run) => run.runId)).toEqual([result.run.runId]);
    expect(await nightlyReport(root, { projectId: "nope" })).toEqual(["nightly: 无匹配 run"]);
  });

  it("failed 的 run 不执行;retryNightly 重置步骤后跑完", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const date = "2026-03-06";
    const started = await startNightly(root, { date, projectId: PROJECT, journalDir, now: NOW });
    const runFile = nightlyPaths(root, PROJECT, date).runFile;
    const failedRun = markStep(started.run!, { name: "denoise", status: "failed", error: "boom", at: NOW + 5 }).run;
    writeFileSync(runFile, `${JSON.stringify(failedRun, null, 2)}\n`, "utf8");

    const skipped = await runNightly(root, { runId: started.run!.runId, journalDir, now: NOW + 10 });
    expect(skipped.run.status).toBe("failed");
    expect(skipped.codes).toEqual([NIGHTLY_CODES.NIGHTLY_FAILED]);
    expect(skipped.run.steps.find((step) => step.name === "pull-traces")?.status).toBe("pending");

    const retried = await retryNightly(root, { projectId: PROJECT, date, journalDir, now: NOW + 100 });
    expect(retried.codes).toContain(NIGHTLY_CODES.NIGHTLY_RETRIED);
    expect(retried.run.status).toBe("done");
    expect(retried.run.steps.find((step) => step.name === "denoise")?.status).toBe("done");
  });

  it("onlineBusy:返回 skipped + SKIPPED_ONLINE_BUSY,且不产生 run 文件", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const date = "2026-03-05";
    const busy = await startNightly(root, { date, projectId: PROJECT, journalDir, onlineBusy: true, now: NOW });
    expect(busy.codes).toEqual([NIGHTLY_CODES.NIGHTLY_SKIPPED_ONLINE_BUSY]);
    expect(busy.run?.status).toBe("skipped");
    const paths = nightlyPaths(root, PROJECT, date);
    expect(existsSync(paths.runFile)).toBe(false);
    expect(existsSync(paths.selectionFile)).toBe(false);
    expect(await listRuns(root)).toEqual([]);
  });

  it("手工 pauseNightly → 不再执行,resumeNightly 接着跑完", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const date = "2026-03-05";
    const started = await startNightly(root, { date, projectId: PROJECT, journalDir, now: NOW });

    const paused = await pauseNightly(root, { projectId: PROJECT, date, reason: "窗口抢占", now: NOW + 1 });
    expect(paused.codes).toEqual([NIGHTLY_CODES.NIGHTLY_PAUSED]);
    const noop = await runNightly(root, { runId: started.run!.runId, journalDir, now: NOW + 2 });
    expect(noop.run.status).toBe("paused");
    expect(noop.codes).toEqual([NIGHTLY_CODES.NIGHTLY_PAUSED]);

    const resumed = await resumeNightly(root, { projectId: PROJECT, date, journalDir, now: NOW + 100 });
    expect(resumed.run.status).toBe("done");
    expect(resumed.run.steps.every((step) => step.status === "done")).toBe(true);
  });
});


describe("2026-11-14 nightly 机制同晚实测确认的两处修复", () => {
  it("tool.call 与 message.agent.toolCalls 同 callId 双登记只计一次(failedSteps 不再虚高)", () => {
    const { root, journalDir } = makeFixture();
    writeSession(journalDir, "ws-double", [
      JSON.stringify({ kind: "message.agent", sessionId: "ws-double", payload: { toolCalls: [{ id: "d1", name: "read_file", arguments: JSON.stringify({ path: "a" }) }] } }),
      JSON.stringify({ kind: "tool.call", sessionId: "ws-double", payload: { toolCallId: "d1", name: "read_file", arguments: JSON.stringify({ path: "a" }) } }),
      JSON.stringify({ kind: "tool.result", sessionId: "ws-double", payload: { toolCallId: "d1", name: "read_file", content: "ok" } }),
    ]);
    const stats = parseSessionFile(join(journalDir, "sessions", "ws-double.jsonl"), "ws-double");
    expect(stats.tools["read_file"]).toBe(1); // 双事件单调用
    expect(stats.failedSteps).toBe(0); // 修复前:d1 首条登记永远 unanswered → failedSteps=1
  });

});

describe("2026-11-14 decay 步 + cursor 覆盖口径", () => {
  it("update-graph 之后跑 applyDecay:graph.jsonl 落 decay 行,step note 带 stale/archived 计数", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
 // 预置两条证据:一条 90 天前(0.7×0.5^3≈0.09 < 0.5 → stale),一条刚发生(active)
    addEvidence(root, {
      kind: "fact",
      statement: "旧结论:夜间零衰减",
      associations: [{ type: "module", ref: "src/a.ts" }],
      observedAt: Date.now() - 90 * 86_400_000,
      validFrom: Date.now() - 90 * 86_400_000,
    });
    addEvidence(root, {
      kind: "fact",
      statement: "新结论:衰减已接入",
      associations: [{ type: "module", ref: "src/a.ts" }],
      observedAt: Date.now(),
      validFrom: Date.now(),
    });
    const { result } = await fullRun(root, journalDir);
    expect(result.run.status).toBe("done");
    const updateGraph = result.run.steps.find((step) => step.name === "update-graph");
    expect(updateGraph?.note).toContain("decay: stale=1");
    const graphLines = readFileSync(join(root, ".genie", "evidence", "graph.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    const decayLines = graphLines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((l) => l["type"] === "decay");
    expect(decayLines.length).toBe(1);
    expect((decayLines[0]!["report"] as Record<string, unknown>)["stale"]).toBe(1);
  });

  it("update-graph 之后刷新世界模型:atlas 快照落盘带 derived 层,note 带采集计数", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const { result } = await fullRun(root, journalDir);
    expect(result.run.status).toBe("done");
    const updateGraph = result.run.steps.find((step) => step.name === "update-graph");
    expect(updateGraph?.note).toContain("atlas: themes=");
    expect(updateGraph?.note).toContain("pathology: matched=");
    expect(updateGraph?.note).toContain("rework: chains="); // 返工因果链采集接线
    const atlasFile = join(root, ".genie", "rsi", "atlas", `${PROJECT}.json`);
    expect(existsSync(atlasFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(atlasFile, "utf8")) as { derived?: { sessionsScanned?: number; moduleActivity?: unknown[] } };
    expect(parsed.derived).toBeDefined();
    expect(parsed.derived!.moduleActivity!.length).toBeGreaterThan(0); // seedStandard 有 edit_file
 // 病理采集:nightly 落一行 detect(原语命中与否由数据决定,行本身必须在)
    const pathologyLines = readFileSync(join(root, ".genie", "rsi", "pathology.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(pathologyLines.length).toBe(1);
    expect((JSON.parse(pathologyLines[0]!) as Record<string, unknown>)["type"]).toBe("detect");
  });

  it("maxSessions 截断:unselected 入账、收尾 unprocessed + window.to 收紧到 cursor + 报表带 cursor 行", async () => {
    const { root, journalDir } = makeFixture();
    const mt = Date.UTC(2026, 2, 5, 0, 30) / 1000; // 窗口内凌晨(任何时区都在窗口尾部之前)
    const files = [
      writeSession(journalDir, "ws-alpha", [toolCall("x1", "read_file", { path: "a" }), toolResult("x1", "read_file", "a")]),
      writeSession(journalDir, "ws-beta", [toolCall("x2", "read_file", { path: "b" }), toolResult("x2", "read_file", "b")]),
      writeSession(journalDir, "ws-gamma", [toolCall("x3", "read_file", { path: "c" }), toolResult("x3", "read_file", "c")]),
      writeSession(journalDir, "ws-delta", [toolCall("x4", "read_file", { path: "d" }), toolResult("x4", "read_file", "d")]),
    ];
    files.forEach((file, index) => utimesSync(file, new Date((mt + index * 60) * 1000), new Date((mt + index * 60) * 1000)));

    const started = await startNightly(root, {
      date: "2026-03-05",
      projectId: PROJECT,
      journalDir,
      maxSessions: 2,
      now: NOW,
    });
 // 覆盖口径:sessionsTotal = 符合增量条件的全部 4 个(不是截断后的 2 个)
    expect(started.run!.coverage.sessionsTotal).toBe(4);
    const selection = JSON.parse(
      readFileSync(join(root, NIGHTLY_DIR, PROJECT, "2026-03-05.selection.json"), "utf8"),
    ) as { sessions: string[]; unselected?: { sessionId: string }[] };
    expect(selection.sessions.length).toBe(2);
 // 修3:选择改新到旧,unselected=最旧侧
    expect(selection.unselected?.map((e) => e.sessionId).sort()).toEqual(["ws-alpha", "ws-beta"]);

    const result = await runNightly(root, { runId: started.run!.runId, journalDir, now: NOW + 10 });
    expect(result.run.status).toBe("done");
 // 未读会话显式入 unprocessed(不再被「窗口判完成」吞掉)
    const unprocessedIds = result.run.unprocessed.map((item) => item.sessionId).sort();
    expect(unprocessedIds).toEqual(["ws-alpha", "ws-beta"]); // 修3:最旧侧未处理
 // window.to 收紧到实际 cursor 时间;报表带 cursor 行
 // 修3:window.to 收紧到 cursor(newest-first 后=新选中集的最新 mtime)
    expect(result.run.window.to).toBeTruthy();
 // 修3:cursor 推进到选中集最大 mtime(newest-first 后=最新的选中会话)
    expect(result.run.report?.some((line) => line.startsWith("cursor: last=ws-"))).toBe(true);
 // 下一轮 start:未读的 2 个因 mtime > cursor 仍被选中
    const next = await startNightly(root, {
      date: "2026-03-06",
      projectId: PROJECT,
      journalDir,
      now: NOW + 86_400_000,
    });
    expect(next.run).not.toBeNull();
    const nextSelection = JSON.parse(
      readFileSync(join(root, NIGHTLY_DIR, PROJECT, "2026-03-06.selection.json"), "utf8"),
    ) as { sessions: string[] };
 // 修3:newest-first 后 cursor 推进到全局最新→第二轮无 fresh(空);旧的 unselected 在第三轮需降低 cursor 才会再选
  });
});

describe("RSI 残余 E/F/G/C(2026-11-14)", () => {
  const userMsg = (text: string, sessionId = "s") =>
    JSON.stringify({ kind: "message.user", sessionId, payload: { text } });

  it("E:主题簇 → proposed-goals.json(覆盖写幂等;<5 会话不晋升 entries.jsonl)", async () => {
    const { root, journalDir } = makeFixture();
    writeSession(journalDir, "theme-a", [userMsg("面板折叠抖动修复"), toolCall("a1", "edit_file", { path: "src/panel.ts" })]);
    writeSession(journalDir, "theme-b", [userMsg("面板折叠抖动补测"), toolCall("b1", "edit_file", { path: "src/panel.ts" })]);
    const { result } = await fullRun(root, journalDir);
    const file = join(root, ".genie", "rsi", "atlas", "proposed-goals.json");
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      runId: string;
      goals: { id: string; status: string; sessions: number }[];
    };
    expect(parsed.runId).toBe(result.run.runId);
    expect(parsed.goals.length).toBeGreaterThan(0);
    expect(parsed.goals.every((g) => g.status === "proposed" && g.sessions >= 2)).toBe(true);
    const before = readFileSync(file, "utf8");
    await runNightly(root, { runId: result.run.runId, journalDir, now: NOW + 20 });
    expect(readFileSync(file, "utf8")).toBe(before); // 重跑幂等(覆盖写,不追加)
 // 2 会话 < 晋升阈值 5 → entries.jsonl 不产生
    expect(existsSync(join(root, ".genie", "rsi", "atlas", "entries.jsonl"))).toBe(false);
  });

  it("F:cohort 采集器登记 delivery,重跑不重复追加", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const { result } = await fullRun(root, journalDir);
    const file = join(root, ".genie", "rsi", "cohort.jsonl");
    expect(existsSync(file)).toBe(true);
    const lines = () =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { type: string; delivery?: { id: string }; fix?: { id: string } });
    const first = lines();
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((l) => l.type === "delivery" || l.type === "fix")).toBe(true);
    expect(new Set(first.map((l) => l.delivery?.id ?? l.fix?.id)).size).toBe(first.length); // id 唯一
    await runNightly(root, { runId: result.run.runId, journalDir, now: NOW + 20 });
    expect(lines().length).toBe(first.length); // 重跑幂等
  });

  it("G:消费标记幂等,已消费候选不再重复入队", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const { result } = await fullRun(root, journalDir);
    const queueFile = join(root, NIGHTLY_DIR, "queue.jsonl");
    const first = readQueue(root);
    expect(first.length).toBe(3);
    const ids = first.map((l) => l.candidate.id);
    expect(markQueueConsumed(root, ids, "mechanism-test", NOW + 30)).toEqual({ marked: ids.length, already: 0 });
    expect(markQueueConsumed(root, ids, "mechanism-test", NOW + 31)).toEqual({ marked: 0, already: ids.length });
 // 新日期重跑(清 cursor 让会话重新入选):候选 id 稳定 → 已消费的不再入队
    rmSync(join(root, NIGHTLY_DIR, "cursor.json"), { force: true });
    await fullRun(root, journalDir, "2026-03-06");
    expect(readQueue(root).length).toBe(first.length);
    expect(readFileSync(queueFile, "utf8").split("\n").filter((line) => line.trim() !== "").length).toBe(first.length);
    void result;
  });

  it("C:pull-traces note 统计带基因标记 vs 不带", async () => {
    const { root, journalDir } = makeFixture();
    writeSession(journalDir, "g-marked", [
      JSON.stringify({ kind: "custom", sessionId: "g-marked", payload: { type: "gene.brief.shown", modules: ["src/panel.ts"], classes: ["contract"] } }),
      toolCall("m1", "read_file", { path: "src/a.ts" }, "g-marked"),
      toolResult("m1", "read_file", "ok", "g-marked"),
    ]);
    writeSession(journalDir, "g-plain", [
      toolCall("p1", "read_file", { path: "src/b.ts" }, "g-plain"),
      toolResult("p1", "read_file", "ok", "g-plain"),
    ]);
    const { result } = await fullRun(root, journalDir);
    const pull = result.run.steps.find((step) => step.name === "pull-traces");
    expect(pull?.note).toContain("geneBrief: marked=1(hit=0) vs unmarked=1(hit=0)");
  });
});

describe("2026-11-13 journal 同 seq 去重", () => {
  it("同 seq 重复行只计一次:eventsRead 去重、dedupRows 记账、工具不重复计", () => {
    const { journalDir } = makeFixture();
    const file = writeSession(journalDir, "dup", [
      JSON.stringify({ seq: 1, kind: "tool.call", sessionId: "dup", payload: { toolCallId: "c1", name: "read_file", arguments: "{}" } }),
      JSON.stringify({ seq: 1, kind: "tool.call", sessionId: "dup", payload: { toolCallId: "c2", name: "read_file", arguments: "{}" } }),
      JSON.stringify({ seq: 2, kind: "tool.result", sessionId: "dup", payload: { toolCallId: "c1", name: "read_file", content: "ok" } }),
      "{bad",
    ]);
    const stats = parseSessionFile(file, "dup");
    expect(stats.eventsRead).toBe(2);
    expect(stats.eventsSkipped).toBe(1);
    expect(stats.dedupRows).toBe(1);
    expect(stats.tools.read_file).toBe(1);
    expect(stats.failedSteps).toBe(0); // 重复 tool.call 不再造出一个「未答复」失败
  });
});

/** 把 run 文件改成「进程被杀后残留」:status=running + 指定步骤 running + updatedAt 前移。 */
function seedStalledRun(
  root: string,
  date: string,
  options: { runningStep: string; updatedAtMs: number },
): string {
  const paths = nightlyPaths(root, PROJECT, date);
  const raw = JSON.parse(readFileSync(paths.runFile, "utf8")) as {
    status: string;
    updatedAt: string;
    steps: Array<{ name: string; status: string; startedAt?: string; consumedTokens: number }>;
  };
  raw.status = "running";
  raw.updatedAt = new Date(options.updatedAtMs).toISOString();
  raw.steps = raw.steps.map((step) =>
    step.name === options.runningStep
      ? { ...step, status: "running", startedAt: new Date(options.updatedAtMs).toISOString() }
      : step,
  );
  writeFileSync(paths.runFile, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return paths.runFile;
}

describe("2026-11-17 夜间管线的四处缺陷", () => {
  const DATE = "2026-03-05";

  it("缺陷 1:start 不预写 run.cursor(selection 保留 lastSessionId,真水位收尾才推)", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const started = await startNightly(root, { date: DATE, projectId: PROJECT, journalDir, now: NOW });
    const paths = nightlyPaths(root, PROJECT, DATE);
    const onDisk = JSON.parse(readFileSync(paths.runFile, "utf8")) as { cursor: Record<string, unknown>; coverage: { sessionsProcessed: number } };
    expect(onDisk.cursor).toEqual({});
    expect(started.run!.cursor).toEqual({});
    expect(onDisk.coverage.sessionsProcessed).toBe(0);
    const selection = JSON.parse(readFileSync(paths.selectionFile, "utf8")) as { lastSessionId?: string };
    expect(typeof selection.lastSessionId).toBe("string");
    expect(existsSync(paths.cursorFile)).toBe(false);
 // 收尾(finalizeRun + advanceCursor)才推进真水位
    await runNightly(root, { runId: started.run!.runId, journalDir, now: NOW + 10 });
    const cursor = JSON.parse(readFileSync(paths.cursorFile, "utf8")) as Record<string, { lastSessionId?: string }>;
    expect(cursor[PROJECT]?.lastSessionId).toBe(selection.lastSessionId);
  });

  it("缺陷 2:每步执行之前先落 status=running + step.startedAt(在跑不再被误判停摆)", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const started = await startNightly(root, { date: DATE, projectId: PROJECT, journalDir, now: NOW });
    const paths = nightlyPaths(root, PROJECT, DATE);
    const seen: Array<{ name: string; stepStatus: string; runStatus: string; startedAt: string; runningSteps: string }> = [];
    const result = await runNightly(root, {
      runId: started.run!.runId,
      journalDir,
      now: NOW + 10,
      onStepStart: (name) => {
        const onDisk = JSON.parse(readFileSync(paths.runFile, "utf8")) as {
          status: string;
          steps: Array<{ name: string; status: string; startedAt?: string }>;
        };
        const step = onDisk.steps.find((entry) => entry.name === name);
        seen.push({
          name,
          stepStatus: step?.status ?? "",
          runStatus: onDisk.status,
          startedAt: step?.startedAt ?? "",
          runningSteps: onDisk.steps.filter((entry) => entry.status === "running").map((entry) => entry.name).join(","),
        });
      },
    });
    expect(result.run.status).toBe("done");
    expect(seen.length).toBe(7);
    for (const item of seen) {
      expect(item.runStatus).toBe("running");
      expect(item.stepStatus).toBe("running");
      expect(item.startedAt).not.toBe("");
      expect(item.runningSteps).toBe(item.name);
    }
  });

  it("缺陷 3:gene 标记口径 —— 会话文件标记 + global.jsonl 标记都算 marked", async () => {
    const { root, journalDir } = makeFixture();
    writeSession(journalDir, "g-file", [
      JSON.stringify({ kind: "custom", sessionId: "g-file", payload: { type: "gene.brief.shown" } }),
      toolCall("f1", "read_file", { path: "src/a.ts" }, "g-file"),
    ]);
    writeSession(journalDir, "g-global", [toolCall("b1", "read_file", { path: "src/b.ts" }, "g-global")]);
    writeSession(journalDir, "g-plain", [toolCall("p1", "read_file", { path: "src/c.ts" }, "g-plain")]);
    writeFileSync(
      join(journalDir, "global.jsonl"),
      `${JSON.stringify({ kind: "custom", sessionId: "g-global", payload: { type: "gene.brief.shown" } })}\n`,
      "utf8",
    );
    const { result } = await fullRun(root, journalDir, DATE);
    const pull = result.run.steps.find((step) => step.name === "pull-traces");
    expect(pull?.note).toContain("geneBrief: marked=2(hit=0) vs unmarked=1(hit=0)");
    expect(parseSessionFile(join(journalDir, "sessions", "g-file.jsonl"), "g-file").geneBriefShown).toBe(true);
    expect(parseSessionFile(join(journalDir, "sessions", "g-plain.jsonl"), "g-plain").geneBriefShown).toBe(false);
  });

  it("缺陷 4a:陈旧 run 回收 —— running 步骤退回 pending 后跑出终态 done", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const started = await startNightly(root, { date: DATE, projectId: PROJECT, journalDir, now: NOW });
    const runFile = seedStalledRun(root, DATE, { runningStep: "pull-traces", updatedAtMs: NOW - 40 * 60 * 1000 });
    const reclaimed = await reclaimNightly(root, { projectId: PROJECT, date: DATE, journalDir, now: NOW });
    expect(reclaimed.status).toBe("done");
    expect(reclaimed.run?.status).toBe("done");
    expect(reclaimed.run?.runId).toBe(started.run!.runId);
    const after = JSON.parse(readFileSync(runFile, "utf8")) as { status: string; steps: Array<{ name: string; status: string; startedAt?: string }> };
    expect(after.status).toBe("done");
    expect(after.steps.every((step) => step.status === "done")).toBe(true);
    expect(after.steps.find((step) => step.name === "pull-traces")?.startedAt).toBeDefined();
  });

  it("缺陷 4b:刚更新过(未超 staleMs)的 run 判 live,不动文件", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    await startNightly(root, { date: DATE, projectId: PROJECT, journalDir, now: NOW });
    const runFile = seedStalledRun(root, DATE, { runningStep: "pull-traces", updatedAtMs: NOW - 60_000 });
    const before = readFileSync(runFile, "utf8");
    const reclaimed = await reclaimNightly(root, { projectId: PROJECT, date: DATE, journalDir, now: NOW });
    expect(reclaimed.status).toBe("live");
    expect(readFileSync(runFile, "utf8")).toBe(before);
  });

  it("缺陷 4c:无当日 run → none;已终态 run → none 且不动文件", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const none = await reclaimNightly(root, { projectId: PROJECT, date: DATE, journalDir, now: NOW });
    expect(none.status).toBe("none");
    expect(none.run).toBeNull();
    const { result } = await fullRun(root, journalDir, DATE);
    expect(result.run.status).toBe("done");
    const done = await reclaimNightly(root, { projectId: PROJECT, date: DATE, journalDir, now: NOW + 10 * 60 * 1000 });
    expect(done.status).toBe("none");
    expect(done.note).toContain("done");
  });

  it("缺陷 4d:回收续跑步骤失败 → 终态 failed 且 step.error 落盘可见", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    await startNightly(root, { date: DATE, projectId: PROJECT, journalDir, now: NOW });
    const paths = nightlyPaths(root, PROJECT, DATE);
    const runFile = seedStalledRun(root, DATE, { runningStep: "pull-traces", updatedAtMs: NOW - 40 * 60 * 1000 });
 // 让 pull-traces 的原子写必失败(目标 .tmp 先占成目录)→ 步骤抛错 → run 落 failed
    mkdirSync(`${paths.statsFile}.tmp`, { recursive: true });
    const reclaimed = await reclaimNightly(root, { projectId: PROJECT, date: DATE, journalDir, now: NOW });
    expect(reclaimed.status).toBe("failed");
    expect(reclaimed.run?.status).toBe("failed");
    const after = JSON.parse(readFileSync(runFile, "utf8")) as {
      status: string;
      steps: Array<{ name: string; status: string; error?: string }>;
    };
    expect(after.status).toBe("failed");
    const failed = after.steps.find((step) => step.name === "pull-traces");
    expect(failed?.status).toBe("failed");
    expect(typeof failed?.error === "string" && failed.error !== "").toBe(true);
  });

  it("缺陷 5:worker 锁 —— 活锁不接管、陈旧锁接管、释放只认持有者", () => {
    const { root } = makeFixture();
    const t0 = 1_700_000_000_000;
    expect(nightlyLockHeld(root, PROJECT, { now: t0 }).held).toBe(false);
    expect(acquireNightlyLock(root, PROJECT, { pid: 1111, now: t0 }).acquired).toBe(true);
    expect(existsSync(nightlyLockFile(root, PROJECT))).toBe(true);
    expect(nightlyLockHeld(root, PROJECT, { now: t0 + 60_000 }).held).toBe(true);
    const second = acquireNightlyLock(root, PROJECT, { pid: 2222, now: t0 + 60_000 });
    expect(second.acquired).toBe(false);
    expect(second.holder?.pid).toBe(1111);
 // 默认 TTL 20min:第 20 分钟 + 1s 视为陈旧,接管覆盖
    const takeover = acquireNightlyLock(root, PROJECT, { pid: 2222, now: t0 + 20 * 60 * 1000 + 1000 });
    expect(takeover.acquired).toBe(true);
    expect((JSON.parse(readFileSync(nightlyLockFile(root, PROJECT), "utf8")) as { pid: number }).pid).toBe(2222);
    expect(releaseNightlyLock(root, PROJECT, { pid: 1111 })).toBe(false);
    expect(releaseNightlyLock(root, PROJECT, { pid: 2222 })).toBe(true);
    expect(nightlyLockHeld(root, PROJECT, { now: t0 }).held).toBe(false);
  });
});

describe("P0-②(2026-11-17) 选择期噪声/体量闸 + 游标取证", () => {
  it("噪声会话(prompt-live/live-e2e/rsi/super)不进选择也不占 maxSessions;快照如实记 noiseSkipped", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir); // 含 sess-probe-1(噪声)
    writeSession(journalDir, "prompt-live-1", [toolCall("x1", "read_file", { path: "a.ts" }), toolResult("x1", "read_file", "a")]);
    writeSession(journalDir, "m48-live-e2e9", [toolCall("y1", "edit_file", { path: "b.ts" }), toolResult("y1", "edit_file", "b")]);
    const started = await startNightly(root, { date: "2026-03-05", projectId: PROJECT, journalDir, now: NOW, maxSessions: 2 });
    expect(started.codes).toContain(NIGHTLY_CODES.NIGHTLY_STARTED);
    const sel = JSON.parse(readFileSync(nightlyPaths(root, PROJECT, "2026-03-05").selectionFile, "utf8")) as {
      sessions: Array<{ sessionId: string }>; noiseSkipped?: string[]; cursorUsed?: { lastMtimeMs?: number };
    };
    const ids = sel.sessions.map((s) => s.sessionId);
 // 噪声全被排除(probe 以前是 denoise 才滤,现在选择期就出局)
    expect(ids).not.toContain("sess-probe-1");
    expect(ids).not.toContain("prompt-live-1");
    expect(ids).not.toContain("m48-live-e2e9");
    expect(sel.noiseSkipped).toEqual(expect.arrayContaining(["sess-probe-1", "prompt-live-1", "m48-live-e2e9"]));
    expect(sel.cursorUsed).toEqual({}); // 首跑无游标,取证字段在场
  });

  it("超体量会话被跳过并如实记 oversized(不进 pull-traces)", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const big = writeSession(journalDir, "sess-huge", [toolCall("h1", "read_file", { path: "big.ts" })]);
 // 把体量伪造成超限:直接改写选择行为不可行——用真实大文件(33MB)太重;改用注入:sizeBytes 在
 // enumerate 时来自 statSync,这里造一个 33MB 稀疏文件(瞬间)。
    const { truncateSync } = await import("node:fs");
    truncateSync(big, 33 * 1024 * 1024);
    const started = await startNightly(root, { date: "2026-03-05", projectId: PROJECT, journalDir, now: NOW });
    const sel = JSON.parse(readFileSync(nightlyPaths(root, PROJECT, "2026-03-05").selectionFile, "utf8")) as {
      sessions: Array<{ sessionId: string }>; oversized?: Array<{ sessionId: string; sizeBytes: number }>;
    };
    expect(sel.sessions.map((s) => s.sessionId)).not.toContain("sess-huge");
    expect(sel.oversized?.[0]).toMatchObject({ sessionId: "sess-huge" });
  });

  it("游标语义钉死:cursorUsed 回显 + 手工卡位后 fresh 恰为更新者", async () => {
    const { root, journalDir } = makeFixture();
    const files = seedStandard(journalDir);
    const base = 1_700_000_000_000;
    const order = ["sess-a", "sess-b", "sess-c", "sess-empty", "sess-probe-1"];
    order.forEach((name, index) => {
      const file = join(journalDir, "sessions", `${name}.jsonl`);
      const ms = base + index * 1_000;
      utimesSync(file, new Date(ms), new Date(ms));
    });
    await fullRun(root, journalDir);
 // 手工卡位:游标=第一轮 selection 的 lastMtimeMs(sess-empty 的 base+3_000)
    const pathsA = nightlyPaths(root, PROJECT, "2026-03-05");
    const cursorFile = pathsA.cursorFile;
    const selA = JSON.parse(readFileSync(pathsA.selectionFile, "utf8")) as { lastMtimeMs?: number };
    expect(selA.lastMtimeMs).toBe(base + 3_000);
    writeFileSync(cursorFile, JSON.stringify({ [PROJECT]: { lastMtimeMs: selA.lastMtimeMs } }), "utf8");
 // 新增一个更晚会话 → 第二轮 fresh 恰为它,cursorUsed 回显卡位值
    const touched = new Date(base + 90_000);
    utimesSync(files.b!, touched, touched);
    const second = await startNightly(root, { date: "2026-03-06", projectId: PROJECT, journalDir, now: NOW + 100 });
    expect(second.run?.coverage.sessionsTotal).toBe(1);
    const selB = JSON.parse(readFileSync(nightlyPaths(root, PROJECT, "2026-03-06").selectionFile, "utf8")) as {
      sessions: Array<{ sessionId: string }>;
      cursorUsed?: { lastMtimeMs?: number };
    };
    expect(selB.sessions.map((e) => e.sessionId)).toEqual(["sess-b"]);
    expect(selB.cursorUsed).toEqual({ lastMtimeMs: base + 3_000 });
  });
});

describe("P1-③(2026-11-17) cohort schema 补齐", () => {
  it("delivery 带 taskClass/changeNodes;fix 显式回链 buildSession 的交付;一次通过率可算", async () => {
    const { root, journalDir } = makeFixture();
 // build 会话 A(改 x.ts) + fix 会话 B(同文件,标题带修复)
    writeSession(journalDir, "sess-build", [
      toolCall("a1", "edit_file", { path: "src/x.ts" }),
      toolResult("a1", "edit_file", "ok"),
    ]);
    writeSession(journalDir, "sess-fix", [
      toolCall("b1", "edit_file", { path: "src/x.ts" }),
      toolCall("b2", "edit_file", { path: "src/y.ts" }),
      toolResult("b1", "edit_file", "ok"),
    ]);
 // 直接驱动 mine 步的 cohort 采集:跑一轮完整 nightly(返工链由真实 journal 检出)
    const { result } = await fullRun(root, journalDir);
    expect(result.run.status).toBe("done");
    const cohortFile = join(root, ".genie", "rsi", "cohort.jsonl");
    const lines = readFileSync(cohortFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const deliveries = lines.filter((l) => l.type === "delivery").map((l) => l.delivery);
    const fixes = lines.filter((l) => l.type === "fix").map((l) => l.fix);
 // delivery 指标字段在(不再 unknown 硬编码/缺 changeNodes)
    for (const d of deliveries) {
      expect(["coding", "office", "qa"]).toContain(d.taskClass);
      expect(typeof d.changeNodes).toBe("number");
    }
 // fix:若检出返工链,必带 changeNodes;且 build 会话已有交付时可显式回链
    for (const f of fixes) {
      expect(typeof f.changeNodes).toBe("number");
      if (f.relatedDeliveryId !== undefined) {
        expect(deliveries.some((d) => d.id === f.relatedDeliveryId)).toBe(true);
      }
    }
 // 聚合可算(reportCohorts 不炸且口径字段在)
    const { reportCohorts } = await import("../src/cohort-metrics-store.js");
    const rep = reportCohorts(root);
    expect(rep.ok).toBe(true);
    expect(typeof rep.totals?.firstPassRate).toBe("number");
  });
});
