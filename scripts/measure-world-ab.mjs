#!/usr/bin/env node
/**
 * measure-world-ab.mjs — 世界模型接入前 vs 后:固定代码问题的探索成本 A/B 经验证。
 * 用法:/home/zhongyuqi/.nvm/versions/node/v24.22.2/bin/node scripts/measure-world-ab.mjs --runs 3
 * 口径(全部真命令,零编造):
 * - before(无世界模型,盲探协议):① 全仓 grep -rn <关键词> apps packages --include=*.ts | head -60
 * (模拟 agent grep 工具的命中上限)② 读首个命中文件 ±窗口(前20后180行)③ 若答案文件不在
 * grep 命中也不在窗口内,读第二命中窗口。上限 2 grep + 2 read。
 * - after(有世界模型):① codesense world --for "<问题文本>"(确定性下钻,~2s 进程开销如实计入)
 * ② 取首个命中模块,模块目录内 grep -rn <关键词> | head -60 ③ 读首个命中 ±40 行窗口。
 * 下钻零命中时如实降级为全仓 grep(不假装命中)。
 * - 计量:steps=命令条数;bytes=各命令 stdout 字节和(read 计窗口字节);ms=hrtime 墙钟和。
 * - 判定:答案文件出现在协议输出(grep 命中行或读窗口)即 hit,否则 miss(如实标,不静默)。
 * - 每题每协议 n=3 取中位,原始样本全落 docs/world-model-ab-samples.json。
 * 局限(写进 docs):测的是**固定协议的信息检索成本**,不是完整 agent 行为;before 是保守下界
 * (真实盲探通常更多步);after 计入 CLI ~2s 进程固定开销(R1 未治);5 题均为定位类,
 * 上游闭包类问题归 code_sense impact(改前链路闸),不在本 A/B 范围。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "packages/code-sense-cli/dist/cli.js");
const NODE = process.execPath;

const argv = process.argv.slice(2);
let runs = 3;
for (let i = 0; i < argv.length; i++) if (argv[i] === "--runs") runs = Number(argv[++i]) || 3;

/** 5 个固定问题(定位类;关键词与答案文件写死,可复现)。 */
const QUESTIONS = [
  { id: "Q1", text: "WS 消息总入口 handleMessage 在哪个文件哪一行?", kw: "handleMessage", answer: "apps/gateway/src/server.ts" },
  { id: "Q2", text: "开工画像渲染函数 renderWorkStartBrief 在哪个文件?", kw: "renderWorkStartBrief", answer: "apps/gateway/src/work-start-profile.ts" },
  { id: "Q3", text: "白板 prune 零痕迹安全门在哪个文件实现?", kw: "prune", answer: "apps/gateway/src/board-store.ts" },
  { id: "Q4", text: "确定性质量门 computeQuality 在哪个文件,默认阈值是什么?", kw: "computeQuality", answer: "packages/code-sense/src/world/quality.ts" },
  { id: "Q5", text: "edit_file 回执的 editHint 提示在哪里被消费?", kw: "editHint", answer: "apps/gateway/src/file-tools.ts" },
];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s[Math.floor(s.length / 2)];
  return s.length % 2 === 0 ? (s[Math.floor(s.length / 2) - 1] + m) / 2 : m;
};

function run(cmd, args) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { out: r.stdout || "", err: r.stderr || "", status: r.status, ms };
}
const bash = (script) => run("bash", ["-c", script]);

/** grep 命中行 → {file, line}(首条)。 */
function firstHit(grepOut) {
  const line = grepOut.split("\n").find((l) => /^[^:]+:\d+:/.test(l));
  if (!line) return null;
  const i = line.indexOf(":");
  const j = line.indexOf(":", i + 1);
  return { file: line.slice(0, i), line: Number(line.slice(i + 1, j)) };
}

/** 读文件窗口(前 before 后 after 行),返回字节与文本。 */
function readWindow(file, line, before, after) {
  const p = join(ROOT, file);
  if (!existsSync(p)) return { bytes: 0, text: "" };
  const lines = readFileSync(p, "utf8").split("\n");
  const lo = Math.max(0, line - 1 - before);
  const hi = Math.min(lines.length, line - 1 + after + 1);
  const text = lines.slice(lo, hi).join("\n");
  return { bytes: Buffer.byteLength(text, "utf8"), text };
}

function beforeProtocol(q) {
  let steps = 0, bytes = 0, ms = 0, hit = false;
  const g1 = bash(`grep -rn '${q.kw}' apps packages --include='*.ts' 2>/dev/null | head -60`);
  steps++; bytes += Buffer.byteLength(g1.out, "utf8"); ms += g1.ms;
  if (g1.out.includes(q.answer)) hit = true;
  const hits = g1.out.split("\n").filter((l) => /^[^:]+:\d+:/.test(l));
  for (const h of hits.slice(0, 2)) {
    const i = h.indexOf(":"); const j = h.indexOf(":", i + 1);
    const file = h.slice(0, i); const line = Number(h.slice(i + 1, j));
    const w = readWindow(file, line, 20, 180);
    steps++; bytes += w.bytes; ms += 0; // fs 读计时忽略(本地页缓存,量级 <1ms;命令耗时以 grep/CLI 为准)
    if (w.text.includes(q.answer) || file === q.answer) hit = true;
    if (hit) break;
  }
  return { steps, bytes, ms: Math.round(ms), hit };
}

function afterProtocol(q) {
  let steps = 0, bytes = 0, ms = 0, hit = false;
  const d = run(NODE, [CLI, "world", "--for", q.text]);
  steps++; bytes += Buffer.byteLength(d.out, "utf8"); ms += d.ms;
  if (d.out.includes(q.answer)) hit = true;
 // 首个命中模块:页头 "# 模块 <name>"
  const m = /^# 模块 (.+)$/m.exec(d.out);
  const mod = m ? m[1].trim() : null;
  const scope = mod && existsSync(join(ROOT, mod)) ? mod : "apps packages";
  const g = bash(`grep -rn '${q.kw}' ${scope} --include='*.ts' 2>/dev/null | head -60`);
  steps++; bytes += Buffer.byteLength(g.out, "utf8"); ms += g.ms;
  if (g.out.includes(q.answer)) hit = true;
  const fh = firstHit(g.out);
  if (fh) {
    const w = readWindow(fh.file, fh.line, 40, 40);
    steps++; bytes += w.bytes;
    if (w.text.includes(q.answer) || fh.file === q.answer) hit = true;
  }
  return { steps, bytes, ms: Math.round(ms), hit, module: mod, degraded: !mod };
}

if (!existsSync(CLI)) { console.error(`[ab] 缺 CLI 产物: ${CLI}(先 pnpm --filter @lampgenie/code-sense-cli build)`); process.exit(2); }

const samples = [];
const table = [];
for (const q of QUESTIONS) {
  const b = [], a = [];
  for (let i = 0; i < runs; i++) {
    const br = beforeProtocol(q);
    const ar = afterProtocol(q);
    b.push(br); a.push(ar);
    samples.push({ q: q.id, protocol: "before", run: i + 1, ...br });
    samples.push({ q: q.id, protocol: "after", run: i + 1, ...ar });
  }
  const med = (xs, k) => median(xs.map((x) => x[k]));
  table.push({
    id: q.id, text: q.text, answer: q.answer,
    bSteps: med(b, "steps"), bBytes: med(b, "bytes"), bMs: med(b, "ms"), bHit: b.every((x) => x.hit),
    aSteps: med(a, "steps"), aBytes: med(a, "bytes"), aMs: med(a, "ms"), aHit: a.every((x) => x.hit),
    aModule: a[0].module, degraded: a.some((x) => x.degraded),
  });
}

const dir = join(ROOT, "docs");
writeFileSync(join(dir, "world-model-ab-samples.json"), JSON.stringify({ at: new Date().toISOString(), node: process.version, runs, questions: QUESTIONS, samples }, null, 2));

const lines = [
  "# 世界模型 A/B 实测:接入前 vs 后探索成本",
  "",
  `> 真跑产物:${new Date().toISOString()} · node ${process.version} · runs=${runs} · 原始样本 docs/world-model-ab-samples.json`,
  `> 复跑:/home/zhongyuqi/.nvm/versions/node/v24.22.2/bin/node scripts/measure-world-ab.mjs --runs ${runs}`,
  "",
  "## 方法(固定协议,可复现)",
  "",
  "- **before(盲探)**:全仓 `grep -rn <kw> apps packages --include=*.ts | head -60` → 读首命中文件窗口(前20后180行)→ 未命中再读第二命中。上限 2 grep + 2 read。",
  "- **after(世界模型)**:`codesense world --for \"<问题>\"`(确定性下钻)→ 首命中模块内 `grep -rn <kw> <module> | head -60` → 读首命中 ±40 行窗口。零命中如实降级全仓 grep。",
  "- 计量:steps=命令条数;bytes=stdout 字节和(read 计窗口);ms=命令墙钟和(after 含 CLI ~2s 进程固定开销,R1 未治)。",
  "- 判定:答案文件出现在 grep 命中行或读窗口 = hit;否则 miss(如实标)。",
  "",
  "## 结果(中位数,n=" + runs + ")",
  "",
  "| 题 | 问题 | before steps/bytes/ms | after steps/bytes/ms | bytes 节省 | ms 差 | hit(before/after) |",
  "|---|---|---|---|---|---|---|",
];
for (const r of table) {
  const save = r.bBytes > 0 ? Math.round((1 - r.aBytes / r.bBytes) * 100) : 0;
  lines.push(`| ${r.id} | ${r.text} | ${r.bSteps}/${r.bBytes}/${r.bMs} | ${r.aSteps}/${r.aBytes}/${r.aMs}${r.degraded ? "(降级)" : ""} | ${save}% | ${r.aMs - r.bMs >= 0 ? "+" : ""}${r.aMs - r.bMs}ms | ${r.bHit ? "✓" : "✗"}/${r.aHit ? "✓" : "✗"} |`);
}
lines.push(
  "",
  "## 局限(如实)",
  "",
  "1. 测的是**固定协议的信息检索成本**,不是完整 agent 行为;真实盲探步数通常更多(before 是保守下界)。",
  "2. after 计入 CLI 进程固定开销(~1.9s,R1 未治);开工注入与 code_sense action=world 走进程内读产物,无此开销——本表是 CLI 路径的保守口径。",
  "3. 5 题均为定位类;上游闭包类(改这里影响谁)归 code_sense impact + 改前链路闸,不在本 A/B 范围。",
  "4. 区分度高的符号题(handleMessage/renderWorkStartBrief)盲探 grep 一步即中,世界模型收益有限甚至为负——收益主要在概念/模糊题与开工定向,不夸大。",
  "",
  "## 读法",
  "",
  "- bytes 节省为正 = 下钻收窄了检索面;为负 = 下钻产物本身比 grep 命中行更重(小仓/高区分度题常见)。",
  "- ms 差几乎恒正(CLI 进程开销)——这正是「注入走进程内、CLI 只留给终端」的设计依据。",
);
writeFileSync(join(dir, "world-model-ab.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.log(`\n[ab] 样本已落 docs/world-model-ab-samples.json(${samples.length} 条)`);
