/**
 * 会议导入接线(二期, §3):runtime 流水线(纪要→抽取→确认→批量任务)
 * 出两个 agent 工具 + WS 命令面。ASR 音频面仍留接口( §6 凭证前置,不造假)。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./repo-root.js";
import type { LlmProvider, Tool } from "@lampgenie/runtime/agent/loop";
import type { TaskSupervisor } from "./task-manager.js";
import type { MeetingExtraction } from "@lampgenie/runtime/meeting/import";

/** 会议产物目录(.genie/meetings/<hash>/)。 */
export function meetingsDir(): string {
  const dir = join(repoRoot(), ".genie", "meetings");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** agent 工具:import_meeting(纪要文件→抽取产物落盘+结构化返回)。 */
export function meetingImportTool(llm: LlmProvider): Tool {
  return {
    name: "import_meeting",
    description: "导入会议纪要(文本类:.md/.txt)并抽取议题/决议/待办/开放问题。参数 path=纪要绝对路径。产物落 .genie/meetings/(幂等,同文件复用)。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "纪要文件绝对路径" } },
      required: ["path"],
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as { path?: string };
      const p = String(a.path ?? "");
      if (!p) return "错误:path 必填";
      const { importMeeting } = await import("@lampgenie/runtime/meeting/import");
      try {
        const { extraction, draftPath } = await importMeeting(p, meetingsDir(), llm);
        return JSON.stringify({ draftPath, extraction }, null, 2);
      } catch (err) {
        return `错误:${String(err).slice(0, 300)}`;
      }
    },
  };
}

/** 确认面:把选中的 todos 批量立任务( §3 第四步;title 带 [会议] 前缀)。 */
export function scheduleMeetingTodos(
  tm: TaskSupervisor,
  todos: { content: string; owner?: string; deadline?: string }[],
  sessionId?: string): { id: string; content: string }[] {
  const created: { id: string; content: string }[] = [];
  for (const t of todos.slice(0, 20)) {
    const instruction = [
      t.content,
      t.owner ? `负责人:${t.owner}` : "",
      t.deadline ? `截止:${t.deadline}` : "",
    ].filter(Boolean).join("\n");
    const task = tm.submit("user", sessionId ?? `meeting-${Date.now()}`, instruction, { title: "[会议] " + t.content.slice(0, 40) });
    created.push({ id: task.id, content: t.content });
  }
  return created;
}

/** 抽取结果的人类可读摘要(agent 工具/面板共用)。 */
export function formatExtraction(e: MeetingExtraction): string {
  const lines: string[] = [];
  if (e.topics?.length) lines.push(`议题:${e.topics.join("、")}`);
  if (e.decisions?.length) lines.push(`决议:\n${e.decisions.map((d) => `- ${d}`).join("\n")}`);
  if (e.todos?.length) lines.push(`待办:\n${e.todos.map((t) => `- ${t.content}${t.owner ? `(${t.owner})` : ""}${t.deadline ? `[${t.deadline}]` : ""}`).join("\n")}`);
  if (e.openQuestions?.length) lines.push(`开放问题:\n${e.openQuestions.map((q) => `- ${q}`).join("\n")}`);
  return lines.join("\n\n");
}
