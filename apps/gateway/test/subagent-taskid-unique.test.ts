/**
 * 子代理 taskId 唯一性(2026-10-19 实锤):同一父任务并行派两个 explore,旧实现两者都拿
 * `${task.id}-sub` → 子 loop sessionId / 轨迹目录 subagent-<taskId>-sub / subagent.event.taskId
 * 全撞在一起(159 次调用混在一个目录,无法按子代理排障)。源结构锁:派发唯一化 + 父 id 留痕。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "../src/agent-wiring.ts"), "utf-8");

describe("subagent taskId 唯一化(源结构锁)", () => {
  it("① 每次派发生成 subTaskId(父 id 前缀 + agentId 片段)", () => {
    expect(src).toContain('const subTaskId = task.id.slice(0, 8) + "-" + bgAgentId.slice(6, 14);');
  });

  it("② 前后台 spawn 都带唯一后缀,不再共用 ${task.id}-sub/-bg", () => {
    expect(src).toContain("taskId: `${subTaskId}-sub`");
    expect(src).toContain("taskId: `${subTaskId}-bg`");
    expect(src).not.toContain("taskId: `${task.id}-sub`");
    expect(src).not.toContain("taskId: `${task.id}-bg`");
  });

  it("③ journal 事件带 subTaskId + parentTaskId(可追溯父任务)", () => {
    expect(src).toContain("taskId: subTaskId, parentTaskId: task.id");
  });
});
