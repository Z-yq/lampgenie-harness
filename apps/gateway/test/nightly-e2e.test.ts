import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nightlyPaths, reclaimNightly, runNightly, startNightly } from "../src/nightly-store.js";
import type { NightlyRun } from "@lampgenie/runtime/agent/nightly-run";

const DATE = "2026-11-17";
const PROJECT = "proj";
let root = "";
let journalDir = "";

function seedSession(name: string): void {
  writeFileSync(
    join(journalDir, "sessions", `${name}.jsonl`),
    [
      JSON.stringify({ kind: "tool.call", sessionId: name, payload: { toolCallId: "a1", name: "read_file", arguments: "{}" } }),
      JSON.stringify({ kind: "tool.result", sessionId: name, payload: { toolCallId: "a1", name: "read_file", content: "ok" } }),
    ].join("\n") + "\n",
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ngt-e2e-"));
  journalDir = join(root, "journal");
  mkdirSync(join(journalDir, "sessions"), { recursive: true });
  writeFileSync(
    join(journalDir, "global.jsonl"),
    JSON.stringify({ kind: "custom", sessionId: "s1", payload: { type: "gene.brief.shown" } }) + "\n",
  );
  seedSession("s1");
  seedSession("s2");
  seedSession("s3");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function readRun(): NightlyRun {
  return JSON.parse(readFileSync(nightlyPaths(root, PROJECT, DATE).runFile, "utf8")) as NightlyRun;
}

describe("nightly 端到端", () => {
  it("开工不预写水位;跑起来有 running 进度;收尾有终态与覆盖", async () => {
    const started = await startNightly(root, { date: DATE, projectId: PROJECT, journalDir, now: 1_000 });
    expect(started.run?.status).toBe("pending");
    expect(started.run?.cursor).toEqual({});
    expect(started.run?.coverage.sessionsProcessed).toBe(0);

    const snapshots: Array<{ runStatus: string; running: number }> = [];
    const result = await runNightly(root, {
      runId: started.run!.runId,
      journalDir,
      now: 2_000,
      onStepStart: (_step, run) => {
        snapshots.push({ runStatus: run.status, running: run.steps.filter((s) => s.status === "running").length });
      },
    });
    expect(result.run.status).toBe("done");
    expect(result.run.steps.every((s) => s.status === "done")).toBe(true);
    expect(snapshots).toHaveLength(7);
    expect(snapshots.every((s) => s.runStatus === "running")).toBe(true);
    expect(snapshots.every((s) => s.running === 1)).toBe(true);
    expect(result.run.coverage.sessionsProcessed).toBe(3);
    expect(typeof result.run.cursor.lastMtimeMs).toBe("number");
    expect(readRun().status).toBe("done");
    expect(existsSync(nightlyPaths(root, PROJECT, DATE).cursorFile)).toBe(true);
  });

  it("崩溃残留:陈旧 pending run 被回收为终态(done)并补齐步骤", async () => {
    const started = await startNightly(root, { date: DATE, projectId: PROJECT, journalDir, now: 1_000 });
    const paths = nightlyPaths(root, PROJECT, DATE);
    const stale: NightlyRun = { ...started.run!, updatedAt: "2020-01-01T00:00:00.000Z" };
    writeFileSync(paths.runFile, JSON.stringify(stale), "utf8");

    const reclaimed = await reclaimNightly(root, {
      projectId: PROJECT,
      date: DATE,
      journalDir,
      now: Date.now(),
      staleMs: 60_000,
    });
    expect(reclaimed.status).toBe("done");
    expect(reclaimed.run?.status).toBe("done");
    expect(reclaimed.run?.steps.every((s) => s.status === "done")).toBe(true);
  });

  it("回收续跑失败也必须有终态(failed + 原因),不静默 pending", async () => {
    const started = await startNightly(root, { date: DATE, projectId: PROJECT, journalDir, now: 1_000 });
    const paths = nightlyPaths(root, PROJECT, DATE);
    const stale: NightlyRun = { ...started.run!, updatedAt: "2020-01-01T00:00:00.000Z" };
    writeFileSync(paths.runFile, JSON.stringify(stale), "utf8");
    mkdirSync(paths.statsFile, { recursive: true });

    const reclaimed = await reclaimNightly(root, {
      projectId: PROJECT,
      date: DATE,
      journalDir,
      now: Date.now(),
      staleMs: 60_000,
    });
    expect(reclaimed.status).toBe("failed");
    expect(reclaimed.run?.status).toBe("failed");
    expect(String(reclaimed.run?.error ?? "")).not.toBe("");
    expect(readRun().status).toBe("failed");
  });

  it("在跑的 run 不被抢跑(live)", async () => {
    await startNightly(root, { date: DATE, projectId: PROJECT, journalDir, now: Date.now() });
    const reclaimed = await reclaimNightly(root, { projectId: PROJECT, date: DATE, journalDir, now: Date.now() });
    expect(reclaimed.status).toBe("live");
  });
});
