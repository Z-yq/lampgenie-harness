#!/usr/bin/env node
// SOP 行为度量脚本( tips SOP 化升级,任务书第③件「行为验证口径」的载体)。
// 口径:只读 .genie/journals/sessions/*.jsonl(旁路留痕,不改任何状态),三个指标:
// 影响面先行率 = 会话内首个 edit_file/write_file 之前出现过 code_sense(任一 action)
// 的会话占「有文件写入动作的会话」比例 —— 度量 plan 卡「影响面先行」。
// 排障盲试度 = tool.result 带 error 之后、下一次任何探测类调用(code_sense/grep/glob/
// read_file/session_search)之前,连续 edit_file/write_file 的「盲改步数」
// 分布(p50/p90/最大值) —— 度量 debug 卡「假设驱动排障」。
// 失败即停 = 同一文件「edit→测试→fail」循环 >2 轮的会话数(fail=error 或内容含
// FAIL/✗/failing) —— 度量 debug 卡「同一逻辑最多 2 轮」。
// 复测方法:SOP 卡上线前后各跑一次 node scripts/measure-sop-behavior.mjs --since 7d,
// 报表对比(同口径可复算)。事件口径:tool.call{payload.name,arguments},tool.result
// {payload.error?(origin/message)},tip.injected{payload.keys}。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const sinceIdx = args.indexOf("--since");
const SINCE_MS = 7 * 86400e3;
const sinceMs = sinceIdx >= 0 && args[sinceIdx + 1]
  ? (String(args[sinceIdx + 1]).endsWith("d") ? Date.now - parseInt(args[sinceIdx + 1], 10) * 86400e3 : Date.now - parseInt(args[sinceIdx + 1], 10) * 1000)
  : Date.now - SINCE_MS;

const dir = join(process.cwd, ".genie", "journals", "sessions");
let files = [];
try {
  files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
    .map((f) => { const p = join(dir, f); return { p, mtime: statSync(p).mtimeMs }; })
    .filter((x) => x.mtime >= sinceMs);
} catch { console.error(`找不到 ${dir}`); process.exit(1); }

const WRITE_TOOLS = new Set(["edit_file", "write_file"]);
const PROBE_TOOLS = new Set(["code_sense", "grep", "glob", "read_file", "session_search", "list_dir"]);
const isErr = (e) => Boolean(e.payload?.error) || String(e.payload?.content ?? "").startsWith("错误");

/** 会话级事件流(只保留 tool.call/tool.result/tip.injected,按 seq 排序) */
function loadSession(p) {
  const evs = [];
  const lines = readFileSync(p, "utf-8").split("\n");
  for (const l of lines) {
    if (!l.includes('"kind":"tool.') && !l.includes('"kind":"tip.injected"') && !l.includes('"kind":"task.trajectory"')) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.kind === "tool.call" || e.kind === "tool.result" || e.kind === "tip.injected" || e.kind === "task.trajectory") evs.push(e);
  }
  evs.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return evs;
}

const sessions = [];
let tipCount = { dispatch: 0, parallel: 0, boardComments: 0, sop: 0, dyn: 0, trajectoryBackfill: 0, trajCards: 0 };// :动态卡/轨迹回看/trajectory 卡
/** J1 注入间隔审计:同 key 两次注入的 tokensSpent 水位差(J1 起 tip.injected 才带该字段) */
const lastWater = new Map;
let gateSamples = 0, gateViolations = 0;
for (const { p } of files) {
  let evs; try { evs = loadSession(p); } catch { continue; }
  if (!evs.length) continue;

 // —— 影响面先行:首个写调用前是否有 code_sense ——
  const firstWriteIdx = evs.findIndex((e) => e.kind === "tool.call" && WRITE_TOOLS.has(e.payload?.name ?? ""));
  let impactFirst = null;
  if (firstWriteIdx >= 0) {
    impactFirst = evs.slice(0, firstWriteIdx).some((e) => e.kind === "tool.call" && e.payload?.name === "code_sense");
  }
 // —— 盲试:error 后到下一次探测之间的连续盲改步 ——
  let blind = null;
  const blindRuns = [];
  let inErrorWindow = false;
  let blindCount = 0;
  for (const e of evs) {
    if (e.kind === "tool.result" && isErr(e)) { if (blindCount > 0) { blindRuns.push(blindCount); blindCount = 0; } inErrorWindow = true; continue; }
    if (e.kind === "tool.call") {
      const n = e.payload?.name ?? "";
      if (inErrorWindow) {
        if (PROBE_TOOLS.has(n)) { if (blindCount > 0) blindRuns.push(blindCount); blindCount = 0; inErrorWindow = false; }
        else if (WRITE_TOOLS.has(n)) blindCount += 1;
      }
    }
  }
  if (blindCount > 0) blindRuns.push(blindCount);
  blind = blindRuns;
 // —— 失败即停:同文件连续写未通过(失败结果清零,只有连续写才累计,>2 轮违规) ——
  let lastFile = null; let rounds = 0; let stopViolations = 0;
  for (const e of evs) {
    if (e.kind === "tool.call" && WRITE_TOOLS.has(e.payload?.name ?? "")) {
      let path = ""; try { path = JSON.parse(e.payload?.arguments ?? "{}").path ?? ""; } catch { }
      if (path && path !== lastFile) { lastFile = path; rounds = 0; }
      if (path) rounds += 1;
    } else if (e.kind === "tool.result" && isErr(e)) {
      rounds = 0; // 失败清除计数:只有「连续写、不失败」才累计轮次
    }
  }
  if (rounds > 2) stopViolations += 1;
 // —— tip 注入计数(keys) ——
  for (const e of evs) {
    if (e.kind !== "tip.injected") continue;
    for (const k of e.payload?.keys ?? []) {
      if (k === "dispatch") tipCount.dispatch += 1;
      else if (k === "parallel") tipCount.parallel += 1;
      else if (k === "board-comments") tipCount.boardComments += 1;
      else if (k.startsWith("sop:")) tipCount.sop += 1;
      else if (k.startsWith("dyn:")) tipCount.dyn += 1;
      else if (k === "task:trajectory") tipCount.trajectoryBackfill += 1;
 // 同 key 间隔审计(J1 硬规则:≥10k token)
      const w = Number(e.payload?.tokensSpent);
      if (Number.isFinite(w)) {
        const prev = lastWater.get(k);
        if (prev !== undefined) { gateSamples += 1; if (w - prev < 10000) gateViolations += 1; }
        lastWater.set(k, w);
      }
    }
  }
  sessions.push({ file: p.split("/").pop, hasWrite: firstWriteIdx >= 0, impactFirst, blindRuns, stopViolations });
}

// —— 汇总 ——
const writeSessions = sessions.filter((s) => s.hasWrite);
const m1 = writeSessions.length ? writeSessions.filter((s) => s.impactFirst).length / writeSessions.length : null;
const allBlind = sessions.flatMap((s) => s.blindRuns).sort((a, b) => a - b);
const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(q * arr.length))] : null);
const m3 = sessions.filter((s) => s.stopViolations > 0).length;

console.log(`SOP 行为度量(窗口 --since ${args[sinceIdx + 1] ?? "7d"},会话文件 ${files.length} 个,其中含工具事件 ${sessions.length} 个)`);
console.log(`M1 影响面先行率(首个写前有 code_sense): ${m1 === null ? "n/a(无写会话)" : (m1 * 100).toFixed(1) + "%(" + writeSessions.filter((s) => s.impactFirst).length + "/" + writeSessions.length + ")"}`);
console.log(`M2 排障盲试度(error 后无探测直接连续改文件的步数): 样本 ${allBlind.length} 段, p50=${pct(allBlind, 0.5)} p90=${pct(allBlind, 0.9)} max=${allBlind.length ? allBlind[allBlind.length - 1] : 0}`);
console.log(`M3 失败即停违规(同文件 edit 循环 >2 轮): ${m3} 个会话`);
console.log(`tip.injected keys 计数(J1): dyn:\*=${tipCount.dyn} task:trajectory=${tipCount.trajectoryBackfill} | 旧: dispatch=${tipCount.dispatch} parallel=${tipCount.parallel} board-comments=${tipCount.boardComments} sop:*=${tipCount.sop}`);
console.log(`J1 注入间隔审计(同 key ≥10k token): 有水位样本 ${gateSamples} 对, 违规 ${gateViolations} 对`);
console.log(`复算: node scripts/measure-sop-behavior.mjs --since 7d`);
