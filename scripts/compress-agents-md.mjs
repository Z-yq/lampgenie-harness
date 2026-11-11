#!/usr/bin/env node
// AGENTS.md 压缩脚本:确定性变换,可重复执行
// 规则节(首条会话留痕之前的全部内容)原样保留;
// 会话留痕:最近 KEEP 条保留全文,其余压成一行索引(标题 120 字);
// 全文无损归档到 (含条目全文与编号)。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SRC = resolve(process.argv[2] ?? "AGENTS.md");
const ARCHIVE = resolve(process.argv[3] ?? "tasks/agents-md-history.md");
const KEEP = Number(process.env.KEEP ?? 15);
const TITLE_MAX = Number(process.env.TITLE_MAX ?? 120);

const raw = readFileSync(SRC, "utf8");
if (/完整历史\(\d+ 条/.test(raw)) {
  console.error("AGENTS.md 已是压缩形态(检测到归档提示行),拒绝重复压缩;如需重压请先从 tasks/agents-md-history.md 或 git 恢复原文件。");
  process.exit(1);
}
const lines = raw.split("\n");

// 1) 定位「## 会话留痕」标题行与第一条会话条目
const headerIdx = lines.findIndex((l) => /^## 会话留痕/.test(l));
if (headerIdx < 0) throw new Error("未找到「## 会话留痕」标题");
let firstEntryIdx = -1;
for (let i = headerIdx + 1; i < lines.length; i++) {
  if (/^- 【/.test(lines[i])) { firstEntryIdx = i; break; }
}
if (firstEntryIdx < 0) throw new Error("未找到任何会话条目");

const head = lines.slice(0, firstEntryIdx);           // 规则节 + 会话留痕标题
const entries = lines.slice(firstEntryIdx);           // 条目区(空行分隔)

// 2) 切成条目(以 「- 【」 开头的块)
const items = [];
let cur = null;
for (const l of entries) {
  if (/^- 【/.test(l)) { if (cur) items.push(cur); cur = [l]; }
  else if (cur) { if (l.trim() === "") { items.push(cur); cur = null; } else cur.push(l); }
}
if (cur) items.push(cur);

// 3) 压缩
const n = items.length;
const keepFrom = Math.max(0, n - KEEP);
const kept = items.slice(keepFrom).map((blk) => blk.join("\n"));
const indexed = items.slice(0, keepFrom).map((blk) => {
  const title = blk[0].slice(0, TITLE_MAX).replace(/…$/, "");
  return title.startsWith("- ") ? title : `- ${title}`;
});

// 4) 输出
const compressed = [
  ...head,
  "",
  `> 完整历史(${n} 条,${raw.length} 字符)无损归档于 tasks/agents-md-history.md;此处仅保留最近 ${KEEP} 条全文,更早条目为一行索引(标题截 120 字)。`,
  "",
  ...indexed.map((s, i) => s),
  "",
  ...kept.join("\n\n").split("\n"),
  "",
].join("\n");

const archive = [
  "# AGENTS.md 会话留痕完整归档",
  "",
  `> 压缩时间:${new Date().toISOString()};源文件字符数:${raw.length};条目总数:${n};最近 ${KEEP} 条同时保留在 AGENTS.md。`,
  "> 本文件为无损归档,按需 grep 检索;勿在此追加新条目,新条目仍追加到 AGENTS.md 末尾。",
  "",
  "## 归档条目(全文)",
  "",
  ...items.map((blk, i) => `<!-- AGENTS-${String(i + 1).padStart(3, "0")} -->\n${blk.join("\n")}`),
  "",
].join("\n");

mkdirSync(dirname(ARCHIVE), { recursive: true });
writeFileSync(ARCHIVE, archive);
writeFileSync(SRC, compressed);
console.log(JSON.stringify({
  entries: n,
  keptFull: n - keepFrom,
  indexed: keepFrom,
  beforeChars: raw.length,
  afterChars: compressed.length,
  archiveChars: archive.length,
  keptRatio: (compressed.length / raw.length).toFixed(4),
}, null, 2));
