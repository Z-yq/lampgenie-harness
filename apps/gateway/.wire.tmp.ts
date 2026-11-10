import { readFileSync } from "node:fs";
import { boardUpsertTool } from "./src/agent-wiring.js";
import { codeSenseTool } from "./src/sense-tool.js";
import { sessionSearchTool } from "./src/session-search.js";
import { createTerminalTool } from "../../packages/harness-terminal/src/index.js";
import { attachToolView } from "./src/tool-view.js";
import { MemoryJournal } from "@lampgenie/core";

const CJK = /[\u3000-\u9fff\uff00-\uffef]/g;
const cjk = (s: string) => (s.match(CJK) ?? []).length;
const j = new MemoryJournal();
const raw = [
  boardUpsertTool(j as never, "s1", "t1", "/tmp", "/tmp"),
  codeSenseTool("/tmp"),
  sessionSearchTool(j as never, "s1"),
  createTerminalTool({ service: {} as never, owner: "x", root: "/tmp" }),
];
// spawn_subagent 不导出：从源码抓 description 与 parameters 块
const src = readFileSync("src/agent-wiring.ts", "utf8");
const s0 = src.indexOf("const spawnTool: Tool = {");
const s1 = src.indexOf('required: ["instructions"],', s0);
const block = src.slice(s0, s1 + 30);
const dDesc = /description: ("(?:[^"\\]|\\.)*"),\n    parameters:/.exec(block)![1]!;
const dParams = null as unknown as Record<string, unknown>;
const spawn = { name: "spawn_subagent", description: JSON.parse(dDesc) as string, parameters: {} };

const wire = attachToolView([...raw, spawn] as never);
for (const t of wire) {
  const size = JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length;
  console.log(`${t.name}: wire=${size} desc=${t.description.length} param=${JSON.stringify(t.parameters).length} cjk=${cjk(t.description) + cjk(JSON.stringify(t.parameters))}`);
}
const sum = (xs: typeof wire) => xs.reduce((a, t) => a + JSON.stringify({ n: t.name, d: t.description, p: t.parameters }).length, 0);
console.log(`WIRE TOTAL(4+1 tools)=${sum(wire)}`);
