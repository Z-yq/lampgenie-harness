import { boardUpsertTool } from "./src/agent-wiring.js";
import { MemoryJournal } from "@lampgenie/core";
const t = boardUpsertTool(new MemoryJournal() as never, "s", "t", "/tmp", "/tmp");
function strip(o: any): any {
  if (Array.isArray(o)) return o.map(strip);
  if (o && typeof o === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(o)) { if (k === "description") continue; out[k] = strip(v); }
    return out;
  }
  return o;
}
const full = JSON.stringify(t.parameters).length;
const bare = JSON.stringify(strip(t.parameters)).length;
console.log(`full params=${full} bare(no desc)=${bare}`);
// 各项体量
const p: any = t.parameters;
for (const [k, v] of Object.entries(p.properties)) console.log(k, JSON.stringify(v).length);
