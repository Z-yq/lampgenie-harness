// code_index 多维扫雷:用静态索引挖真问题
import { loadIndex, querySymbol } from "../packages/code-sense/src/callgraph/c2f";
import { readFileSync } from "node:fs";
const ROOT = "/mnt/e/workship/genie/lampgenie-harness";
const idx = loadIndex(ROOT)!;

console.log("=== ① 死代码候选(leaf 但无人调用且非导出/入口/测试钩子) ===");
// leaf(出度 0)且 inCount=0 的函数实际上不可能存在(trunk 定义入度 0);找 in=0 且 out>0 的 trunk 太正常。
// 真死代码=inCount===0 且 export 但无 import 方——索引进度只算调用,import 未调用不算。
// 换个角度:大文件 top10(节点数)
const byFile = new Map<string, number>();
for (const n of idx.nodes) byFile.set(n.file, (byFile.get(n.file) ?? 0) + 1);
console.log("-- 节点数 top10 文件(上帝文件嫌疑) --");
for (const [f, c] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${f}: ${c} 个符号`);

console.log("\n=== ② 同名符号散布(复制粘贴嫌疑) ===");
const dup = Object.entries(idx.byName).filter(([k, v]) => v.length >= 3 && !/^(run|handle|parse|get|set|render|init|close|send|main|test)$/.test(k));
for (const [k, v] of dup.slice(0, 12)) console.log(`  ${k}: ${v.length} 处 → ${v.map((id) => id.split("#")[0]!.split("/").slice(-1)[0]).join(", ")}`);

console.log("\n=== ③ 高扇出函数(出度>40,上帝函数嫌疑) ===");
for (const n of idx.nodes.filter((x) => x.outCount > 40).sort((a, b) => b.outCount - a.outCount).slice(0, 8))
  console.log(`  ${n.name} 出=${n.outCount} 入=${n.inCount} @${n.file}:${n.line}`);

console.log("\n=== ④ 入度 0 且出度 0 的符号(定义了啥也不干) ===");
const inert = idx.nodes.filter((n) => n.inCount === 0 && n.outCount === 0);
console.log(`  共 ${inert.length} 个,样例:`, inert.slice(0, 8).map((n) => `${n.name}@${n.file.split("/").pop()}`).join(", "));
