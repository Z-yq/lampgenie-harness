/**
 * 子代理防死机制直测(派发后主 agent 自行判断等待/继续,harness 只负责检测死活):
 * - scanBgAgentsForWatchdog 判定面:idle>staleWarnMs→stale-warn(只一次);超 deadline+宽限→reap-dead;
 *   终态条目零动作。
 * - runSubagentWatchdog 执行面:预警落 message.system;判死翻 failed+output.txt 补 [watchdog 收割]+
 *   journal 落 subagent.result(reap=watchdog)。
 * 注册表经 __bgAgents 全局桥(与 background-subagent-e2e 同形态)。
 */
import { it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanBgAgentsForWatchdog, runSubagentWatchdog } from "../src/agent-wiring.js";
import type { Journal } from "@lampgenie/core";

type Entry = { outputFile: string; status: string; sessionId: string; title?: string; model?: string; lastEventAt?: number; cancel?: () => unknown; spawnedAt?: number; deadlineAt?: number; staleWarnMs?: number; staleNotified?: boolean };
function reg(): Map<string, Entry> {
  return (globalThis as { __bgAgents?: Map<string, Entry> }).__bgAgents!;
}

/** 最小 journal 桩:只记 append 的 (kind, payload.text 摘要)。 */
function fakeJournal() {
  const events: { kind: string; sessionId: string; text: string; payload: Record<string, unknown> }[] = [];
  return {
    events,
    journal: {
      append(e: { kind: string; sessionId: string; payload?: Record<string, unknown> }) {
        events.push({ kind: e.kind, sessionId: e.sessionId, text: String((e.payload as { text?: unknown } | undefined)?.text ?? ""), payload: e.payload ?? {} });
      },
    } as unknown as Journal,
  };
}

function addEntry(id: string, opts?: Partial<Entry>): string {
  const dir = mkdtempSync(join(tmpdir(), "wd-sub-"));
  const outputFile = join(dir, "output.txt");
  writeFileSync(outputFile, "[started] 任务书:测试\n", "utf-8"); // 与 spawn 真实行为一致:登记时先落 started 行
  const base: Entry = { outputFile, status: "running", sessionId: "s-wd", lastEventAt: Date.now(), spawnedAt: Date.now(), staleWarnMs: 20 * 60_000 };
  reg().set(id, { ...base, ...opts });
  return outputFile;
}

beforeEach(() => {
  reg().clear();
});

it("scan:活跃条目(running 且 idle<staleWarnMs)零动作", () => {
  addEntry("a-live");
  expect(scanBgAgentsForWatchdog()).toEqual([]);
});

it("scan:idle 超 staleWarnMs→stale-warn 一次;条目自带 staleNotified 后不再报", () => {
  const now = Date.now();
  addEntry("a-stale", { lastEventAt: now - 25 * 60_000, spawnedAt: now - 25 * 60_000 });
  const acts = scanBgAgentsForWatchdog(now);
  expect(acts).toEqual([{ agentId: "a-stale", kind: "stale-warn", idleMs: 25 * 60_000 }]);
  // 执行后 staleNotified 置位,同刻再扫不再报
  runSubagentWatchdog(fakeJournal().journal);
  expect(scanBgAgentsForWatchdog(now)).toEqual([]);
});

it("scan:超 deadline+60s 宽限仍 running→reap-dead(收割失灵=死);终态条目零动作", () => {
  const now = Date.now();
  addEntry("a-dead", { spawnedAt: now - 30 * 60_000, lastEventAt: now - 30 * 60_000, deadlineAt: now - 20 * 60_000, staleNotified: true });
  addEntry("a-done", { status: "completed", spawnedAt: now - 30 * 60_000, deadlineAt: now - 20 * 60_000 });
  const acts = scanBgAgentsForWatchdog(now);
  expect(acts.filter((a) => a.agentId === "a-dead")).toHaveLength(1);
  expect(acts[0]!.kind).toBe("reap-dead");
  expect(acts.filter((a) => a.agentId === "a-done")).toEqual([]);
});

it("scan:无 deadlineAt=不限时条目——永不判死(2026-10-21 ),无论闲置多久只有 stale 预警一路", () => {
  const now = Date.now();
  // 旧兜底:60min 硬上限后 reap-dead。现口径:未设时间盒=子代理跑完为止,watchdog 不杀。
  addEntry("a-nodl", { spawnedAt: now - 59 * 60_000, lastEventAt: now - 59 * 60_000, staleNotified: true });
  expect(scanBgAgentsForWatchdog(now)).toEqual([]);
  addEntry("a-nodl2", { spawnedAt: now - 24 * 60_000 * 60, lastEventAt: now - 24 * 60_000 * 60, staleNotified: true }); // 挂 24 小时
  expect(scanBgAgentsForWatchdog(now)).toEqual([]);
});

it("run:stale-warn 落一条 message.system(含 agentId 与止损指引)", () => {
  const now = Date.now();
  addEntry("a-warn", { lastEventAt: now - 22 * 60_000, spawnedAt: now - 22 * 60_000, title: "勘察" });
  const fj = fakeJournal();
  runSubagentWatchdog(fj.journal);
  const sys = fj.events.filter((e) => e.kind === "message.system");
  expect(sys).toHaveLength(1);
  expect(sys[0]!.text).toContain("a-warn");
  expect(sys[0]!.text).toContain("勘察");
  expect(sys[0]!.text).toContain("重派");
  expect(reg().get("a-warn")!.staleNotified).toBe(true);
  expect(reg().get("a-warn")!.status).toBe("running"); // 预警不杀
});

it("run:reap-dead 翻 failed+cancel 被调+output.txt 补 [watchdog 收割]+journal 落终态与死讯", () => {
  const now = Date.now();
  let cancelled = 0;
  const outputFile = addEntry("a-reap", { spawnedAt: now - 30 * 60_000, lastEventAt: now - 30 * 60_000, deadlineAt: now - 20 * 60_000, staleNotified: true, cancel: () => { cancelled++; } });
  const fj = fakeJournal();
  runSubagentWatchdog(fj.journal);
  const en = reg().get("a-reap")!;
  expect(en.status).toBe("failed");
  expect(cancelled).toBe(1);
  expect(en.cancel).toBeUndefined();
  const tail = readFileSync(outputFile, "utf-8");
  expect(tail).toContain("[result ok=false]");
  expect(tail).toContain("[watchdog 收割]");
  const result = fj.events.filter((e) => e.kind === "subagent.result");
  expect(result).toHaveLength(1);
  expect((result[0]!.payload as { reap?: { reason?: string } }).reap?.reason).toBe("watchdog");
  const sys = fj.events.filter((e) => e.kind === "message.system");
  expect(sys.some((e) => e.text.includes("死讯") && e.text.includes("a-reap"))).toBe(true);
});
