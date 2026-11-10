import { readFileSync, writeFileSync } from "node:fs";
import { boardUpsertTool } from "./src/agent-wiring.js";
import { codeSenseTool } from "./src/sense-tool.js";
import { sessionSearchTool } from "./src/session-search.js";
import { createTerminalTool } from "../../packages/harness-terminal/src/index.js";
import { attachToolView } from "./src/tool-view.js";
import { MemoryJournal } from "@lampgenie/core";

const CJK = /[\u3000-\u9fff\uff00-\uffef]/g;
const cjk = (s: string) => (s.match(CJK) ?? []).length;
const tok = (s: string) => cjk(s) * 0.789 + (s.length - cjk(s)) * 0.297;
const j = new MemoryJournal();
const raw = [
  boardUpsertTool(j as never, "s1", "t1", "/tmp", "/tmp"),
  codeSenseTool("/tmp"),
  sessionSearchTool(j as never, "s1"),
  createTerminalTool({ service: {} as never, owner: "x", root: "/tmp" } as never),
];
// spawn_subagent 未导出：从源码块抓 description（参数面按源码长度统计）
const src = readFileSync("src/agent-wiring.ts", "utf8");
const s0 = src.indexOf("const spawnTool: Tool = {");
const s1 = src.indexOf('required: ["instructions"],', s0);
const block = src.slice(s0, s1);
const descM = /description: ((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+),\s*parameters:/.exec(block.trim());
const spawnDesc = descM ? [...descM[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join("") : "";
const spawnParams = block.slice(block.indexOf("parameters: {"));

const wire = attachToolView(raw as never, { defer: false });
const rows = wire.map((t) => {
  const d = String(t.description);
  const p = JSON.stringify(t.parameters);
  return { name: t.name, wireDesc: d.length, wireParams: p.length, cjk: cjk(d) + cjk(p), tok: tok(d + p), rawDesc: d.length, rawParams: p.length };
});
rows.push({ name: "spawn_subagent", wireDesc: Math.min(spawnDesc.length, 400), wireParams: spawnParams.length, cjk: cjk(spawnDesc) + cjk(spawnParams), tok: tok(spawnDesc) + tok(spawnParams), rawDesc: spawnDesc.length, rawParams: spawnParams.length });
for (const r of rows) console.log(`${r.name}: raw(desc+params)=${r.rawDesc + r.rawParams} wire=${r.wireDesc + r.wireParams} cjk=${r.cjk} estTok=${Math.round(r.tok)}`);
const tot = (k: "wireDesc" | "wireParams" | "cjk" | "tok" | "rawDesc" | "rawParams") => rows.reduce((a, r) => a + r[k], 0);
console.log(`TOTAL: raw=${tot("rawDesc") + tot("rawParams")} wire=${tot("wireDesc") + tot("wireParams")} cjk=${tot("cjk")} estTok=${Math.round(tot("tok"))}`);
writeFileSync(process.argv[2] ?? "/tmp/wire.json", JSON.stringify(rows, null, 2));
