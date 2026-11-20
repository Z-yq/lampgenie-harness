/**
 * Issue 台账(mechanisms.md #100。
 * 项目仓内 .genie/issues/ 每条一文件,append-only 评论流+状态字段+关联边。
 * 任务开工自动建,认领/计划/实现/验证/关闭各阶段回写;关闭带签名(session+agent+模型+commit+证据)。
 * 作为任务级去噪投影(带人类确认信号),供方向总览、缺陷基因与一次通过率消费。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export interface IssueRecord {
  id: string;
  title: string;
  status: "open" | "in-progress" | "closed" | "abandoned";
  createdBy: string;
  createdAt: number;
  closedAt?: number;
  closeSignature?: { sessionId: string; agent: string; model: string; commitSha?: string; evidence?: string[] };
  links?: Array<{ type: "blocks" | "duplicates" | "task" | "board"; ref: string }>;
}

export function issuesDir(root: string): string {
  return join(root, ".genie", "issues");
}

export function issuePath(root: string, id: string): string {
  return join(issuesDir(root), `${id}.md`);
}

/** 任务开工自动建 issue(幂等:同 id 已存在跳过)。 */
export function createIssue(
  root: string,
  input: { id: string; title: string; createdBy: string },
): { ok: boolean; code?: string } {
  const file = issuePath(root, input.id);
  if (existsSync(file)) return { ok: true, code: "ISSUE_EXISTS" };
  mkdirSync(issuesDir(root), { recursive: true });
  const rec: IssueRecord = {
    id: input.id,
    title: input.title,
    status: "open",
    createdBy: input.createdBy,
    createdAt: Date.now(),
  };
  const md = [
    `# ${input.title}`,
    "",
    `- id: ${input.id}`,
    `- status: open`,
    `- created-by: ${input.createdBy}`,
    `- created-at: ${new Date(rec.createdAt).toISOString()}`,
    "",
    "## 评论",
    "",
    `### ${new Date(rec.createdAt).toISOString()} — auto-create`,
    `任务开工自动创建(from session: ${input.createdBy})`,
    "",
  ].join("\n");
  writeFileSync(file, md, "utf8");
  return { ok: true };
}

/** 追加评论(任何阶段留痕)。 */
export function commentIssue(root: string, id: string, by: string, text: string): boolean {
  const file = issuePath(root, id);
  if (!existsSync(file)) return false;
  appendFileSync(file, `\n### ${new Date().toISOString()} — ${by}\n${text}\n`, "utf8");
  return true;
}

/** 关闭 issue(写签名+状态更新)。 */
export function closeIssue(
  root: string,
  id: string,
  signature: IssueRecord["closeSignature"],
): { ok: boolean; code?: string } {
  const file = issuePath(root, id);
  if (!existsSync(file)) return { ok: false, code: "ISSUE_NOT_FOUND" };
  let text = readFileSync(file, "utf8");
  text = text.replace("status: open", "status: closed").replace("status: in-progress", "status: closed");
  text += `\n### ${new Date().toISOString()} — close\n`;
  text += `- session: ${signature?.sessionId ?? "?"}\n- agent: ${signature?.agent ?? "?"}\n- model: ${signature?.model ?? "?"}\n`;
  if (signature?.commitSha) text += `- commit: ${signature.commitSha}\n`;
  if (signature?.evidence?.length) text += `- evidence: ${signature.evidence.join(", ")}\n`;
  text += `\nstatus: closed\nclosed-at: ${new Date().toISOString()}\n`;
  writeFileSync(file, text, "utf8");
  return { ok: true };
}

/** 列出全部 issue(读目录,解析状态行)。 */
export async function listIssues(root: string): Promise<Array<{ id: string; title: string; status: string }>> {
  const dir = issuesDir(root);
  if (!existsSync(dir)) return [];
  const out: Array<{ id: string; title: string; status: string }> = [];
  const { readdirSync } = await import("node:fs");
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const text = readFileSync(join(dir, name), "utf8");
    const title = (text.match(/^# (.+)$/m) ?? [])[1] ?? name;
    const status = (text.match(/status: (\S+)/) ?? [])[1] ?? "unknown";
    out.push({ id: name.replace(/\.md$/, ""), title, status });
  }
  return out;
}
