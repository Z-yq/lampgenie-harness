import { boardUpsertTool } from "./src/agent-wiring.js";
import { codeSenseTool } from "./src/sense-tool.js";
import { sessionSearchTool } from "./src/session-search.js";
import { createTerminalTool } from "../../packages/harness-terminal/src/index.js";
import { MemoryJournal } from "@lampgenie/core";
const CJK = /[\u3000-\u9fff\uff00-\uffef]+/g;
const j = new MemoryJournal();
const list:any[] = [boardUpsertTool(j as never,"s1","t1","/tmp","/tmp"), codeSenseTool("/tmp"), sessionSearchTool(j as never,"s"), createTerminalTool({service:{} as never,owner:"x",root:"/tmp"} as never)];
for (const t of list) {
  const p = JSON.stringify(t.parameters);
  console.log(t.name, "desc=",t.description.length, "params=",p.length, "sum=",t.description.length+p.length, "cjkDesc=",(JSON.stringify(t.description).match(CJK)??[]).join("|"), "cjkParams=",[...(new Set(p.match(CJK)??[]))].join("|"));
}
