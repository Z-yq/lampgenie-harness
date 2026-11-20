// vm.Script 语法门:本批改动分片(script-core 为主,views/submit 未动一并复核)逐段编译,不抛即过
import vm from "node:vm";
import { PANEL_JS_CORE } from "../src/panel/script-core.ts";
import { PANEL_JS_VIEWS } from "../src/panel/script-views.ts";
import { PANEL_JS_SUBMIT } from "../src/panel/script-submit.ts";

const segs = [
  ["script-core", PANEL_JS_CORE],
  ["script-views", PANEL_JS_VIEWS],
  ["script-submit", PANEL_JS_SUBMIT],
];
let fail = 0;
for (const [n, src] of segs) {
  if (!src) { console.log(n, "NO EXPORT"); fail++; continue; }
  try { new vm.Script(src); console.log(n, "OK", src.length); }
  catch (e) { console.log(n, "SYNTAX-FAIL", String(e).slice(0, 150)); fail++; }
 // 模板约束(与 vm-gate 同口径):体内裸反引号/ ${ 会截断 PAGE 模板
  const body = src.slice(src.indexOf("`", 1) + 1, src.lastIndexOf("`"));
  const stripped = body.replace(/`{2,}/g, "");
  if (stripped.includes("`") || body.includes("${")) {
    const i = stripped.indexOf("`");
    console.log(n, "TEMPLATE-CONSTRAINT-FAIL(体内含反引号或 ${)", JSON.stringify(stripped.slice(Math.max(0, i - 80), i + 40)), "dollarBrace:", body.includes("${"));
    fail++;
  }
}
process.exit(fail ? 1 : 0);
