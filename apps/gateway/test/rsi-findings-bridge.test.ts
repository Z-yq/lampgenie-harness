/** P1-④ 机制发现→提案转换器:bad 转提案/warn 跳过/dedupeKey 幂等(重复=merge)。 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCycleFindingsToChangeRequests } from "../src/rsi-findings-bridge.js";
import { loadChangeRequests } from "../src/change-request-store.js";

let root = "";
const roots: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "p14-bridge-"));
  roots.push(root);
});
afterEach(() => {
  while (roots.length > 0) { const r = roots.pop(); if (r) rmSync(r, { recursive: true, force: true }); }
});

function writeResult(mech: string, runId: string, items: unknown[]): void {
  const dir = join(root, ".genie", "rsi", "agent-runs", mech);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.result.json`), JSON.stringify({ items }));
}

describe("fileCycleFindingsToChangeRequests", () => {
  it("bad 转提案(带证据/建议/出处),warn 跳过,幂等重放=merge 不重复开单", () => {
    writeResult("cost", "run-1", [
      { id: "breaker-decoupled", status: "bad", title: "熔断 pause 后仍跑 7 个周期", summary: "91.8M token 失守", evidence: "cost.jsonl:44", impact: "熔断失效", action: "夜间入口读 breaker state 短路" },
      { id: "warn-only", status: "warn", title: "小告警", summary: "不重要" },
    ]);
    writeResult("tools", "run-2", [
      { id: "session-search-unused", status: "bad", title: "session_search 0 使用", summary: "裸扫 journal", evidence: "31 会话计数", impact: "token 浪费", action: "注册 journal_query" },
    ]);
    const first = fileCycleFindingsToChangeRequests(root, { cost: "run-1", tools: "run-2" });
    expect(first.created).toHaveLength(2);
    expect(first.skipped).toBe(1); // warn 不开单
    const projection = loadChangeRequests(root);
    const titles = [...projection.entries.values()].map((r) => r.title);
    expect(titles.some((t) => t.includes("熔断"))).toBe(true);
    expect(titles.some((t) => t.includes("session_search"))).toBe(true);
 // 证据逐字搬运
    const breaker = [...projection.entries.values()].find((r) => r.title.includes("熔断"));
    expect(breaker?.evidenceRefs?.[0]).toContain("cost.jsonl:44");
 // 重放:同 dedupeKey → merge,created=0
    const second = fileCycleFindingsToChangeRequests(root, { cost: "run-1", tools: "run-2" });
    expect(second.created).toHaveLength(0);
    expect(second.merged).toHaveLength(2);
 // 台账仍只有 2 条 alive 提案
    expect([...loadChangeRequests(root).entries.values()].filter((r) => r.status === "proposed")).toHaveLength(2);
  });

  it("结果文件缺失/坏 JSON=fail-soft 零提案", () => {
    const r = fileCycleFindingsToChangeRequests(root, { cost: "run-not-exist" });
    expect(r.created).toHaveLength(0);
    expect(r.codes).toEqual([]);
  });
});
