/**
 * RSI 会话候选池 + 已分析账本( RSI-SESSION-COST)。
 * 钉住四类事实:
 * ① 窗口选择:mtime 落在近 3 日内、按 mtime 降序、排除 RSI 自身会话 "rsi"、窗口外不选;
 * ② 账本:append 写、坏行忽略、同 sessionId 重复标记读侧去重、空数组不写文件;
 * ③ 计划:候选 = 窗口内 − 已分析,limit 封顶 12,projectOf 缺省不填 projectId(不编造);
 * ④ 降级:journalDir 缺失 / 目录不存在 → 空候选,不 throw。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RSI_ANALYSIS_MAX_CANDIDATES,
  RSI_ANALYSIS_WINDOW_MS,
  analyzedSessionsPath,
  buildAnalysisPlan,
  listRecentSessions,
  loadAnalyzedEntries,
  loadAnalyzedIds,
  markAnalyzed,
} from "../src/rsi-sessions.js";

const tempDirs: string[] = [];

async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

/** 造一个 journal 目录并给若干会话文件指定 mtime(ms)。 */
async function journalWith(entries: { sid: string; mtimeMs: number }[]): Promise<string> {
  const journalDir = await freshDir("rsi-sess-journal-");
  const sessions = join(journalDir, "sessions");
  await mkdir(sessions, { recursive: true });
  for (const entry of entries) {
    const file = join(sessions, `${entry.sid}.jsonl`);
    await writeFile(file, '{"kind":"message.user","payload":{}}\n', "utf8");
    const seconds = entry.mtimeMs / 1000;
    await utimes(file, seconds, seconds);
  }
  return journalDir;
}

describe("listRecentSessions", () => {
  it("窗口内按 mtime 降序,排除 RSI 自身会话", async () => {
    const journalDir = await journalWith([
      { sid: "web-old", mtimeMs: NOW - 2 * 24 * 3600 * 1000 },
      { sid: "web-new", mtimeMs: NOW - 60_000 },
      { sid: "web-mid", mtimeMs: NOW - 3600_000 },
      { sid: "rsi", mtimeMs: NOW - 1000 },
    ]);
    const list = await listRecentSessions(journalDir, NOW);
    expect(list.map((s) => s.sessionId)).toEqual(["web-new", "web-mid", "web-old"]);
    expect(list[0]!.lastActiveAt).toBeGreaterThan(list[1]!.lastActiveAt);
  });

  it("窗口外(超过 3 日)与未来 mtime 都不选", async () => {
    const journalDir = await journalWith([
      { sid: "too-old", mtimeMs: NOW - RSI_ANALYSIS_WINDOW_MS - 60_000 },
      { sid: "future", mtimeMs: NOW + 3600_000 },
      { sid: "inside", mtimeMs: NOW - 1000 },
    ]);
    const list = await listRecentSessions(journalDir, NOW);
    expect(list.map((s) => s.sessionId)).toEqual(["inside"]);
  });

  it("journalDir 缺省/不存在 → 空数组,不 throw", async () => {
    expect(await listRecentSessions("", NOW)).toEqual([]);
    expect(await listRecentSessions(join(tmpdir(), "rsi-sess-nope-404"), NOW)).toEqual([]);
  });
});

describe("analyzed 账本", () => {
  it("markAnalyzed 落行,loadAnalyzedIds 读回;空数组不建文件", async () => {
    const root = await freshDir("rsi-sess-ledger-");
    expect(await markAnalyzed(root, [])).toBe(0);
    await expect(stat(analyzedSessionsPath(root))).rejects.toThrow();

    const n = await markAnalyzed(root, [
      { sessionId: "web-1", projectId: "__harness__", mechanismId: "nightly", runId: "run_1", at: NOW },
      { sessionId: "web-2", mechanismId: "cost", runId: "run_1", at: NOW },
    ]);
    expect(n).toBe(2);
    const ids = await loadAnalyzedIds(root);
    expect([...ids].sort()).toEqual(["web-1", "web-2"]);
    const entries = await loadAnalyzedEntries(root);
    expect(entries.find((e) => e.sessionId === "web-1")).toMatchObject({ projectId: "__harness__", mechanismId: "nightly", runId: "run_1" });
  });

  it("重复标记幂等(读侧去重),坏行忽略", async () => {
    const root = await freshDir("rsi-sess-ledger-dup-");
    const entry = { sessionId: "web-9", mechanismId: "atlas", runId: "run_1", at: NOW };
    await markAnalyzed(root, [entry]);
    await markAnalyzed(root, [entry]);
    await mkdir(join(root, ".genie", "rsi"), { recursive: true });
    const file = analyzedSessionsPath(root);
    const before = await readFile(file, "utf8");
    await writeFile(file, `${before}坏行不是 JSON\n{"sessionId":""}\n`, "utf8");
    const ids = await loadAnalyzedIds(root);
    expect([...ids]).toEqual(["web-9"]);
  });
});

describe("buildAnalysisPlan", () => {
  it("候选 = 窗口内 − 已分析,windowDays=3,scanned/alreadyAnalyzed 如实计数", async () => {
    const root = await freshDir("rsi-plan-root-");
    const journalDir = await journalWith([
      { sid: "done-1", mtimeMs: NOW - 1000 },
      { sid: "todo-1", mtimeMs: NOW - 2000 },
      { sid: "todo-2", mtimeMs: NOW - 3000 },
    ]);
    await markAnalyzed(root, [{ sessionId: "done-1", mechanismId: "nightly", runId: "run_1", at: NOW }]);
    const plan = await buildAnalysisPlan({
      journalDir,
      root,
      nowMs: NOW,
      projectOf: (sid) => (sid === "todo-1" ? "__harness__" : undefined),
    });
    expect(plan.windowDays).toBe(3);
    expect(plan.scanned).toBe(3);
    expect(plan.alreadyAnalyzed).toBe(1);
    expect(plan.candidates.map((c) => c.sessionId)).toEqual(["todo-1", "todo-2"]);
 // projectOf 缺省值不编造:todo-2 没有 projectId 字段
    expect(plan.candidates[0]).toMatchObject({ sessionId: "todo-1", projectId: "__harness__" });
    expect(plan.candidates[1]).not.toHaveProperty("projectId");
  });

  it("limit 封顶(缺省 12),不传 projectOf 就全不给 projectId", async () => {
    const root = await freshDir("rsi-plan-limit-");
    const entries = Array.from({ length: RSI_ANALYSIS_MAX_CANDIDATES + 5 }, (_, i) => ({
      sid: `web-${String(i).padStart(2, "0")}`,
      mtimeMs: NOW - (i + 1) * 1000,
    }));
    const journalDir = await journalWith(entries);
    const plan = await buildAnalysisPlan({ journalDir, root, nowMs: NOW });
    expect(plan.candidates).toHaveLength(RSI_ANALYSIS_MAX_CANDIDATES);
    expect(plan.candidates.every((c) => c.projectId === undefined)).toBe(true);
    const limited = await buildAnalysisPlan({ journalDir, root, nowMs: NOW, limit: 2 });
    expect(limited.candidates.map((c) => c.sessionId)).toEqual(["web-00", "web-01"]);
  });

  it("journalDir 缺失 → 空候选(scanned=0),不 throw", async () => {
    const root = await freshDir("rsi-plan-empty-");
    const plan = await buildAnalysisPlan({ root, nowMs: NOW });
    expect(plan).toMatchObject({ windowDays: 3, scanned: 0, alreadyAnalyzed: 0, candidates: [] });
  });
});
