// vm.Script 语法门:改动分片逐段编译,不抛即过(口径同 vm-gate.mjs)
import vm from "node:vm";
import { PANEL_JS_TOOL_RENDER } from "../src/panel/script-tool-render.ts";
import { PANEL_JS_HISTORY } from "../src/panel/script-history.ts";

const segs = [
  ["script-tool-render", PANEL_JS_TOOL_RENDER],
  ["script-history", PANEL_JS_HISTORY],
];
let fail = 0;
for (const [n, src] of segs) {
  if (!src) { console.log(n, "NO EXPORT"); fail++; continue; }
  try { new vm.Script(src); console.log(n, "OK", src.length); }
  catch (e) { console.log(n, "SYNTAX-FAIL", String(e).slice(0, 150)); fail++; }
 // 模板约束:体内不新增裸反引号/模板插值(与 1602 门同口径)
  const body = src.slice(src.indexOf("`", 1) + 1, src.lastIndexOf("`"));
  const stripped = body.replace(/`{2,}/g, "");
  if (stripped.includes("`") || body.includes("${")) {
    const i = stripped.indexOf("`");
    console.log(n, "TEMPLATE-CONSTRAINT-FAIL(体内含反引号或 ${)", JSON.stringify(stripped.slice(Math.max(0, i - 80), i + 40)), "dollarBrace:", body.includes("${"));
    fail++;
  }
}
process.exit(fail ? 1 : 0);
