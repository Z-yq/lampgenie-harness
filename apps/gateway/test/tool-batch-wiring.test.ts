/**
 * 工具批次接线断言(读源码,不跑 loop):loop 的工具批次执行块必须使用
 * planToolBatch 分段 + mergeBatchResults 按 calls 序归并,旧的 safe/exclusive 二分已移除。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const loopSource = readFileSync(
  fileURLToPath(new URL("../../../packages/harness-runtime/src/agent/loop.ts", import.meta.url)),
  "utf8",
);

const batchSource = readFileSync(
  fileURLToPath(new URL("../../../packages/harness-runtime/src/agent/tool-batch.ts", import.meta.url)),
  "utf8",
);

describe(" 工具批次接线", () => {
  it("loop 导入 tool-batch 的 planToolBatch 与 mergeBatchResults", () => {
    expect(loopSource).toContain('import { mergeBatchResults, planToolBatch } from "./tool-batch";');
  });

  it("loop 以 planToolBatch(runnable, { isSafe }) 规划批次", () => {
    expect(loopSource).toMatch(/planToolBatch\(runnable,\s*\{/);
    expect(loopSource).toContain("isSafe: (c) => this.tools.get(c.name)?.isConcurrencySafe?.(this.parseArgs(c)) ?? false");
  });

  it("loop 按 segment 执行:parallel → Promise.all(segment.calls)", () => {
    expect(loopSource).toContain("Promise.all(segment.calls.map((c) => this.execOne(c, ac.signal)))");
    expect(loopSource).toContain("for (const segment of plan.segments)");
  });

  it("loop 用 mergeBatchResults(calls, byId) 统一按提交序归并结果", () => {
    expect(loopSource).toContain("const byId = new Map<string, ToolExecOutcome>();");
    expect(loopSource).toContain("const results: ToolExecOutcome[] = mergeBatchResults(calls, byId);");
  });

  it("旧的 safe/exclusive 二分与 Promise.all(safe.map) 已移除", () => {
    expect(loopSource).not.toContain("const safe = runnable.filter(");
    expect(loopSource).not.toContain("const exclusive = runnable.filter(");
    expect(loopSource).not.toContain("Promise.all(safe.map(");
  });

  it("tool-batch.ts 导出四个契约函数", () => {
    expect(batchSource).toContain("export function pathsOfToolCall(");
    expect(batchSource).toContain("export function planToolBatch(");
    expect(batchSource).toMatch(/export function mergeBatchResults[<(]/);
    expect(batchSource).toContain("export function batchStats(");
  });
});
