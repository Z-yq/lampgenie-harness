/**
 * 会议导入流水线( §3):录音/纪要→抽取→确认→批量 task。
 * ASR 一期用「文字纪要直读」+「音频留接口」;抽取用 coding LLM。
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { LlmProvider } from "../agent/loop";

export interface MeetingTodo {
  content: string;
  owner?: string;
  deadline?: string;
}
export interface MeetingExtraction {
  topics: string[];
  decisions: string[];
  todos: MeetingTodo[];
  openQuestions: string[];
}

/** 幂等:同输入 hash 复用产物。 */
export function meetingHash(inputPath: string): string {
  const content = readFileSync(inputPath);
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * 从文字纪要走完整流水线(ASR 一期跳过,直接读文本)。
 * 产出中间件落盘,可重跑任一步。
 */
export async function importMeeting(
  inputPath: string,
  workDir: string,
  llm: LlmProvider): Promise<{ extraction: MeetingExtraction; draftPath: string }> {
  const hash = meetingHash(inputPath);
  const dir = join(workDir, hash);
  mkdirSync(dir, { recursive: true });

  // 中间产物:抽取结果
  const extractPath = join(dir, "extract.json");
  let extraction: MeetingExtraction;
  if (existsSync(extractPath)) {
    extraction = JSON.parse(readFileSync(extractPath, "utf-8"));
  } else {
    const text = readFileSync(inputPath, "utf-8");
    const res = await llm.chat([
      { role: "system", content: `从会议纪要抽取结构化内容,严格输出 JSON:{"topics":[],"decisions":[],"todos":[{"content":"","owner":"","deadline":""}],"openQuestions":[]}。只输出 JSON。` },
      { role: "user", content: text.slice(0, 8000) },
    ], []);
    const raw = res.content.trim().replace(/^```json\s*|\s*```$/g, "");
    extraction = JSON.parse(raw);
    writeFileSync(extractPath, JSON.stringify(extraction, null, 2));
  }

  // 生成 task 草稿
  const draftPath = join(dir, "draft_tasks.json");
  const drafts = extraction.todos.map((t) => ({
    instruction: t.content,
    owner: t.owner,
    deadline: t.deadline,
    source: `meeting:${hash}`,
  }));
  writeFileSync(draftPath, JSON.stringify(drafts, null, 2));
  return { extraction, draftPath };
}
