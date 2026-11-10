/**
 * worker 能力对齐(2026-10-19 用户口径:「worker 应该和 coding agent 差不多的编程/执行能力,
 * 只是不能再派发子 agent」)。契约:worker 挂 terminal/web/browser/board_read/session_search;
 * 派发类工具(spawn_subagent/answer_subagent/task_output/steer_task/run_workflow)与 ask_user
 * 结构性不给(不靠提示词约束,靠工具面缺失)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSubagentExtraTools } from "../src/agent-wiring";
import { ExperienceStore } from "@lampgenie/experience";
import { MemoryJournal } from "@lampgenie/core";

const root = mkdtempSync(join(tmpdir(), "worker-tools-"));
const store = new ExperienceStore(join(root, "exp"));
const j = new MemoryJournal();

describe("worker 执行面", () => {
  it("挂 terminal/board_read/session_search(+web 由装配方注入);无派发类工具", () => {
    const tools = buildSubagentExtraTools(root, [], store, { journal: j, sessionId: "s1", owner: "sub-x", webTools: [] });
    const names = tools.map((t) => t.name);
    expect(names).toContain("terminal");
    expect(names).toContain("board_read");
    expect(names).toContain("session_search");
    for (const deny of ["spawn_subagent", "answer_subagent", "task_output", "steer_task", "run_workflow", "ask_user"]) {
      expect(names).not.toContain(deny);
    }
  });
  it("只读角色(ctx 缺席)保持窄面:无 terminal/session_search", () => {
    const names = buildSubagentExtraTools(root, [], store).map((t) => t.name);
    expect(names).not.toContain("terminal");
    expect(names).toContain("code_sense");
  });
});

// 清理(尽力)
it("cleanup", () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });
