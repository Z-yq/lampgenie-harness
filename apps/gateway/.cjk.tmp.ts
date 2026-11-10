import { codeSenseTool } from "./src/sense-tool.js";
import { sessionSearchTool } from "./src/session-search.js";
import { createTerminalTool } from "../../packages/harness-terminal/src/index.js";
import { MemoryJournal } from "@lampgenie/core";
const CJK = /[\u3000-\u9fff\uff00-\uffef]+/g;
const j = new MemoryJournal();
for (const t of [codeSenseTool("/tmp"), sessionSearchTool(j as never, "s"), createTerminalTool({ service: {} as never, owner: "x", root: "/tmp" } as never)]) {
  const s = JSON.stringify({ d: t.description, p: t.parameters });
  const hits = s.match(CJK) ?? [];
  console.log(t.name, JSON.stringify([...new Set(hits)]));
}
