import { codeSenseTool } from "./src/sense-tool.js";
import { sessionSearchTool } from "./src/session-search.js";
import { createTerminalTool } from "../../packages/harness-terminal/src/index.js";
import { MemoryJournal } from "@lampgenie/core";
const j = new MemoryJournal();
for (const t of [codeSenseTool("/tmp"), sessionSearchTool(j as never, "s"), createTerminalTool({ service: {} as never, owner: "x", root: "/tmp" } as never)]) {
  console.log("=====", t.name, "descLen", t.description.length);
  console.log(t.description.slice(0, 700));
  console.log("--- params:", JSON.stringify(t.parameters).length);
}
