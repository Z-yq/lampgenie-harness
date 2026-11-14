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
  NIGHTLY_DIR,
  finalizeNightly,
  getRun,
  listRuns,
  markQueueConsumed,
  nightlyPaths,
  nightlyReport,
  parseSessionFile,
  pauseNightly,
  readQueue,
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

  it("runNightly 跑完六步:全 done + coverage 计数正确 + FINALIZED", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const { result } = await fullRun(root, journalDir);

    expect(result.run.steps.map((step) => step.name)).toEqual([
      "pull-traces",
      "denoise",
      "mine",
      "update-graph",
      "generate-candidates",
      "queue-experiments",
    ]);
    expect(result.run.steps.every((step) => step.status === "done")).toBe(true);
    expect(result.run.status).toBe("done");
    expect(result.codes).toContain(NIGHTLY_CODES.NIGHTLY_STEP_DONE);
    expect(result.codes).toContain(NIGHTLY_CODES.NIGHTLY_FINALIZED);
    expect(result.run.coverage).toEqual({
      sessionsTotal: 5,
      sessionsProcessed: 5,
      sessionsSkipped: 1,
      eventsRead: 24,
      eventsSkipped: 1,
    });
    expect(result.run.budget.tokens).toBeGreaterThan(24);
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
    expect(first.run?.coverage.sessionsTotal).toBe(5);
    const done = await runNightly(root, { runId: first.run!.runId, journalDir, now: NOW + 10 });
    expect(done.run.status).toBe("done");

    const cursor = JSON.parse(
      readFileSync(nightlyPaths(root, PROJECT, "2026-03-05").cursorFile, "utf8"),
    ) as Record<string, { lastMtimeMs: number; lastSessionId: string }>;
    expect(cursor[PROJECT]?.lastMtimeMs).toBe(base + 4_000);

    const touched = new Date(base + 90_000);
    utimesSync(files.b!, touched, touched);
    const second = await startNightly(root, { date: "2026-03-06", projectId: PROJECT, journalDir, now: NOW + 100 });
    expect(second.run?.coverage.sessionsTotal).toBe(1);
    const selection = JSON.parse(
      readFileSync(nightlyPaths(root, PROJECT, "2026-03-06").selectionFile, "utf8"),
    ) as { sessions: { sessionId: string }[] };
    expect(selection.sessions.map((entry) => entry.sessionId)).toEqual(["sess-b"]);
  });

  it("预算暂停:maxTokens=1 → paused + BUDGET_EXCEEDED,resumeNightly 后完成", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const started = await startNightly(root, {
      date: "2026-03-05",
      projectId: PROJECT,
      journalDir,
      now: NOW,
      config: { maxTokens: 1 },
    });
    const paused = await runNightly(root, { runId: started.run!.runId, journalDir, now: NOW + 1 });
    expect(paused.run.status).toBe("paused");
    expect(paused.run.pauseReason).toBe("budget");
    expect(paused.codes).toContain(NIGHTLY_CODES.NIGHTLY_BUDGET_EXCEEDED);
    expect(paused.run.steps[0]?.status).toBe("done");
    expect(paused.run.steps[1]?.status).toBe("pending");

    const resumed = await resumeNightly(root, {
      projectId: PROJECT,
      date: "2026-03-05",
      journalDir,
      now: NOW + 100,
    });
    expect(resumed.codes).toContain(NIGHTLY_CODES.NIGHTLY_RESUMED);
    expect(resumed.run.status).toBe("done");
    expect(resumed.run.steps.every((step) => step.status === "done")).toBe(true);
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

  it("probe/smoke 噪声跳过,空会话进 unprocessed", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const { result } = await fullRun(root, journalDir);
    expect(result.run.coverage.sessionsSkipped).toBe(1);
    expect(result.run.unprocessed).toEqual([{ sessionId: "sess-empty", reason: "empty" }]);
    expect(result.codes).toContain(NIGHTLY_CODES.NIGHTLY_UNPROCESSED);
  });

  it("finalize/report:报告含身份/步骤/覆盖/候选/未处理五段,nightlyReport 复用 run.report", async () => {
    const { root, journalDir } = makeFixture();
    seedStandard(journalDir);
    const { result, date } = await fullRun(root, journalDir);
    const text = (result.run.report ?? []).join("\n");
    expect(text).toContain(`nightly: ${result.run.runId}`);
    expect(text).toContain("status: done");
    expect(text).toContain("steps(6):");
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
    expect(selection.unselected?.map((e) => e.sessionId).sort()).toEqual(["ws-delta", "ws-gamma"]);

    const result = await runNightly(root, { runId: started.run!.runId, journalDir, now: NOW + 10 });
    expect(result.run.status).toBe("done");
 // 未读会话显式入 unprocessed(不再被「窗口判完成」吞掉)
    const unprocessedIds = result.run.unprocessed.map((item) => item.sessionId).sort();
    expect(unprocessedIds).toEqual(["ws-delta", "ws-gamma"]);
 // window.to 收紧到实际 cursor 时间;报表带 cursor 行
    expect(result.run.window.to).toBe(new Date((mt + 60) * 1000).toISOString());
    expect(result.run.report?.some((line) => line.startsWith("cursor: last=ws-beta"))).toBe(true);
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
    expect(nextSelection.sessions.map((e: { sessionId: string }) => e.sessionId).sort()).toEqual(["ws-delta", "ws-gamma"]);
  });
});

describe("RSI 残余 E/F/G/C(2026-11-14)", () => {
  const userMsg = (text: string, sessionId = "s") =>
    JSON.stringify({ kind: "message.user", sessionId, payload: { text } });

  it("E:主题簇 → proposed-goals.json(覆盖写幂等,不进 entries.jsonl)", async () => {
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
    expect(existsSync(join(root, ".genie", "rsi", "atlas", "entries.jsonl"))).toBe(false); // 不直接进 curated 层
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
