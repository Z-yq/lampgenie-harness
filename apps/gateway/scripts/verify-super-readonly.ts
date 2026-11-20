/**
 * 真机验证:用**真实 LLM**跑一轮 super agent turn,验证只读探索权生效。
 * 断言口径(证据落 stdout):
 * ① 工具面含 read_file/glob/grep/list_dir,不含 write_file/edit_file/命令类;
 * ② 被问到代码细节时,super 自己调只读工具读文件回答,而不是 spawn_task 派任务
 * (journal 里出现 tool.call read_file/grep/glob;taskManager.list 保持 0 条);
 * ③ 回答是一句话结论形态,不含「要不要列出/要不要拉清单」这类二次询问。
 * 运行(仓根):
 * /home/zhongyuqi/.nvm/versions/node/v24.22.2/bin/node node_modules/tsx/dist/cli.mjs \
 * apps/gateway/scripts/verify-super-readonly.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, FileJournal } from "@lampgenie/core";
import { MemoryStore } from "@lampgenie/runtime/agent/soul-memory";
import { buildLlmFromConfig } from "../src/factory.js";
import { runSuperAgentTurn, buildSuperAgentTools } from "../src/super-agent.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { ProjectRegistry } from "../src/projects.js";
import { repoRoot } from "../src/repo-root.js";

const ROOT = repoRoot();
const journalDir = mkdtempSync(join(tmpdir(), "sup-verify-j-"));
const soulDir = mkdtempSync(join(tmpdir(), "sup-verify-s-"));
const journal = new FileJournal(join(journalDir, "gateway.jsonl"), { writeBehind: true, sharded: true });
const taskManager = new TaskSupervisor();
const projects = new ProjectRegistry(null);
const config = loadConfig({ repoRoot: ROOT }).config;
const llm = buildLlmFromConfig(config, ROOT);
if (!llm) {
  console.error("✗ 未配置 coding.llm,无法真机验证");
  process.exit(2);
}

const deps = { journal, taskManager, projects, llm };
const soul = new MemoryStore(soulDir);

try {
  const toolNames = buildSuperAgentTools(deps, soul).map((t) => t.name);
  console.log("[1] 工具面:", toolNames.join(","));
  for (const n of ["read_file", "glob", "grep", "list_dir"]) {
    if (!toolNames.includes(n)) throw new Error(`只读工具缺席: ${n}`);
  }
  for (const n of ["write_file", "edit_file", "bash", "run_cmd"]) {
    if (toolNames.includes(n)) throw new Error(`写类/命令类工具意外在场: ${n}`);
  }
  console.log("[1] ✓ 只读四件在场,写类/命令类缺席");

  const question = "看 apps/gateway/src/super-agent.ts:buildSuperAgentTools 返回的工具数组里有没有 write_file?一句话回答,不要派任务。";
  const t0 = Date.now();
  const out = await runSuperAgentTurn(deps, question, soul);
  const ms = Date.now() - t0;
  console.log(`[2] 真实 LLM 轮次耗时 ${ms}ms`);
  console.log("[2] 回答原文 >>>");
  console.log(out.text);
  console.log("<<< 回答结束");

  const calls = journal.readAll()
    .filter((e) => e.kind === "tool.call")
    .map((e) => JSON.stringify(e.payload ?? ""));
  const usedRead = calls.some((c) => c.includes("read_file"));
  const usedSearch = calls.some((c) => c.includes("grep") || c.includes("glob") || c.includes("list_dir"));
  const spawned = taskManager.list().length;
  console.log(`[3] 只读工具调用: read_file=${usedRead} grep/glob/list_dir=${usedSearch};派任务数=${spawned}`);
  if (!usedRead && !usedSearch) throw new Error("super 没有自己调只读工具(可能直接凭记忆答)");
  if (spawned !== 0) throw new Error(`super 为一个「看一眼」的问题开了 ${spawned} 条任务线`);
  if (/要不要我(列出|拉|展开|给你)|要不要(列出|拉完整清单)/.test(out.text)) {
    throw new Error("回答里仍出现「要不要列出/拉清单」二次询问");
  }
  console.log("[3] ✓ 自己读文件回答,未派任务,无二次询问");
  console.log("VERIFY_PASS");
} catch (err) {
  console.error("VERIFY_FAIL:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
} finally {
  try { rmSync(journalDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(soulDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
