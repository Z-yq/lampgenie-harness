#!/usr/bin/env npx tsx
/**
 * 工具 schema 字符账(2026-11-04「参数级优选措辞推广」的成本口径):
 * 序列化主 agent 工具定义的 description + parameters,给出每个工具与合计的 UTF-8 字节数。
 *
 * 用途:措辞改动前后各跑一次,差值即「措辞的 schema 成本」。
 * 注意口径:tools 数组是请求前缀的稳定段,缓存命中后增量只落在冷启动首个请求上,
 * 因此这里给的是「未命中时多付多少」,不是「每步多付多少」。
 *
 * 跑法:NODE_OPTIONS=--conditions=development npx tsx scripts/measure-tool-schema.ts
 *      (加 --json 出机器可读)
 * 输出:每行 `<tool> <total> (params <n>)`,末尾 `TOTAL <n>`。
 */
import { MemoryJournal } from "../packages/core/src/index.ts";
import { createFileTools } from "../apps/gateway/src/file-tools.ts";
import { boardUpsertTool } from "../apps/gateway/src/agent-wiring.ts";
import { codeSenseTool } from "../apps/gateway/src/sense-tool.ts";

const journal = new MemoryJournal();
const root = process.cwd();

const WANTED = new Set(["read_file", "grep", "edit_file", "view_image", "glob", "write_file"]);
const tools = [
  ...createFileTools({ root, journal, sessionId: "schema-measure" }).filter((t) => WANTED.has(t.name)),
  boardUpsertTool(journal, "schema-measure", "task-measure", root),
  codeSenseTool(root),
];

const rows: { name: string; chars: number; params: number }[] = [];
for (const t of tools) {
  const desc = typeof t.description === "string" ? t.description : "";
  const paramsJson = JSON.stringify(t.parameters ?? {});
  rows.push({
    name: t.name,
    chars: Buffer.byteLength(desc + paramsJson, "utf-8"),
    params: Buffer.byteLength(paramsJson, "utf-8"),
  });
}

const total = rows.reduce((s, r) => s + r.chars, 0);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ rows, total }, null, 2));
} else {
  for (const r of rows) console.log(`${r.name}\t${r.chars}\t(params ${r.params})`);
  console.log(`TOTAL\t${total}`);
}