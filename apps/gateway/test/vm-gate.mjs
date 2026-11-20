// vm.Script 语法门:改动分片逐段编译,不抛即过
import vm from "node:vm";
import { PANEL_JS_MODEL_MENU } from "../src/panel/script-model-menu.ts";
import { PANEL_JS_VIEWS } from "../src/panel/script-views.ts";
import { PANEL_JS_COMMANDS } from "../src/panel/script-commands.ts";
import { PANEL_JS_SUBMIT } from "../src/panel/script-submit.ts";
import { PANEL_SHELL } from "../src/panel/page-shell.ts";

const segs = [
  ["script-model-menu", PANEL_JS_MODEL_MENU],
  ["script-views", PANEL_JS_VIEWS],
  ["script-commands", PANEL_JS_COMMANDS],
  ["script-submit", PANEL_JS_SUBMIT],
  ["page-shell", PANEL_SHELL],
];
let fail = 0;
for (const [n, src] of segs) {
  if (!src) { console.log(n, "NO EXPORT"); fail++; continue; }
  const isHtml = n === "page-shell"; // HTML 载体非 JS,只查模板约束
  if (!isHtml) {
    try { new vm.Script(src); console.log(n, "OK", src.length); }
    catch (e) { console.log(n, "SYNTAX-FAIL", String(e).slice(0, 150)); fail++; }
  } else console.log(n, "HTML seg", src.length);
 // 模板约束(参考口径):体内裸反引号需甄别——/init 历史段的 \`\`\`text 转义形态是 HEAD 既有豁免;
 // 判定只看 vm.Script 编译(JS 分片)+ 本批改动未新增裸反引号(vm.Script OK 即满足)。
  const body = src.slice(src.indexOf("`", 1) + 1, src.lastIndexOf("`"));
 // 危险形态=单个裸反引号(会截断模板);HEAD /init 段的 ```/`` 转义串是历史豁免,一并剥掉
  const stripped = body.replace(/`{2,}/g, "");
  if (stripped.includes("`") || body.includes("${")) {
    const i = stripped.indexOf("`");
    console.log(n, "TEMPLATE-CONSTRAINT-FAIL(体内含反引号或 ${)", JSON.stringify(stripped.slice(Math.max(0, i - 80), i + 40)), "dollarBrace:", body.includes("${"));
    fail++;
  }
}
process.exit(fail ? 1 : 0);
