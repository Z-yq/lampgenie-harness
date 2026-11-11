// UI 孤儿扫描:①id 元素存在但全脚本零引用 ②onclick 绑定到不存在元素
import { readFileSync } from "node:fs";
const ROOT = "/mnt/e/workship/genie/lampgenie-harness";
const src = readFileSync(ROOT + "/apps/gateway/src/panel.ts", "utf8");
// 收集 HTML 区(id="xxx")与 JS 区($("xxx")/getElementById)
const htmlIds = new Set<string>();
for (const m of src.matchAll(/id="([a-zA-Z][\w-]*)"/g)) htmlIds.add(m[1]!);
const jsRefs = new Set<string>();
for (const m of src.matchAll(/\$\("([\w-]+)"\)/g)) jsRefs.add(m[1]!);
for (const m of src.matchAll(/getElementById\("([\w-]+)"\)/g)) jsRefs.add(m[1]!);
for (const m of src.matchAll(/querySelector(?:All)?\("#([\w-]+)/g)) jsRefs.add(m[1]!);
// 动态生成的 id(innerHTML 模板里 id=") 会同时出现在两侧,天然排除
const orphans: string[] = [];
for (const id of htmlIds) if (!jsRefs.has(id)) orphans.push(id);
console.log("=== HTML 有 id 但 JS 零引用(潜在孤儿元素) ===");
console.log(orphans.join(", ") || "(无)");
// onclick 绑定到不存在元素(运行时炸)
console.log("\n=== JS 引用但 HTML 无此 id(潜在 TypeError;动态生成除外) ===");
const dynamicHints = ["ppf", "pp", "cc-", "mention", "slash", "term", "toast", "att", "task", "auto", "prov", "mcp", "cmd", "hook", "wiz", "quota", "node", "row", "git", "tm", "menu", "wf", "exp", "hdr", "sb", "tr"];
const missing: string[] = [];
for (const id of jsRefs) {
  if (htmlIds.has(id)) continue;
  if (dynamicHints.some((h) => id.startsWith(h))) continue;
  missing.push(id);
}
console.log(missing.join(", ") || "(无静态缺位)");
