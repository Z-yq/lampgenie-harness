import { boardUpsertTool } from "./src/agent-wiring.js";
import { MemoryJournal } from "@lampgenie/core";
const t = boardUpsertTool(new MemoryJournal() as never,"s1","t1","/tmp","/tmp");
const clone = (o:any):any => Array.isArray(o)?o.map(clone):o&&typeof o==="object"?Object.fromEntries(Object.entries(o).filter(([k])=>k!=="description").map(([k,v])=>[k,clone(v)])):o;
const bare = clone(t.parameters);
console.log("params now:", JSON.stringify(t.parameters).length, "bare(all desc removed):", JSON.stringify(bare).length, "desc lines:", t.description.length);
