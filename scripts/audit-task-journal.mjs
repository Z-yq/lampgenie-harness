/**
 * 状态机审计脚本(任务状态机优化 ①):
 * 扫 journal 7 天窗口的 task.* 事件,产出:
 * - 各 TaskState 出现次数(按任务最终态计)→ 死态判定(blocked 是否零使用)
 * - 迁移边计数(from→to;journal 无显式 from,用同任务相邻快照 state 差推)
 * - 队列等待分布(enqueue→start 时长;仅 7 天窗口内)→ 优先级字段决策依据(p90<2min 不做)
 * - 重启清算痕迹(task.progress 带「重启中断」的收编事件计数)
 * 数据真源:.genie/journals/gateway.jsonl(只读,不写任何文件)。
 * 用法:node scripts/audit-task-journal.mjs [--days 7] [--journal <path>]
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function argOf(name, dflt) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const DAYS = Number(argOf("days", "7"));
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 任务事件真源:gateway.jsonl(前)+ global.jsonl(分片迁移后)。两个都扫。
const JOURNALS = [
  resolve(ROOT, argOf("journal", ".genie/journals/gateway.jsonl")),
  resolve(ROOT, ".genie/journals/global.jsonl"),
];
const cutoff = Date.now() - DAYS * 86_400_000;

// ---- 单遍流式解析 ----
const finalState = new Map(); // id → 最后快照 state
const byId = new Map(); // id → [{state, time}] (按事件序)
const waits = []; // enqueue→start 秒
const receipts = []; // 重启收编回执
let taskEvents = 0;
let scannedEvents = 0;
const kindCount = new Map();

const text = JOURNALS.flatMap((p) => {
  try { return readFileSync(p, "utf-8").split("\n"); } catch { return []; }
});
for (const line of text) {
  if (!line || line[0] !== "{") continue;
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  scannedEvents++;
  if (!ev.kind || !ev.kind.startsWith("task.")) continue;
  if (ev.kind === "task.deleted") continue;
  const p = ev.payload;
  if (!p || typeof p.id !== "string" || typeof p.state !== "string") continue;
  if (typeof ev.time === "number" && ev.time < cutoff) continue;
  taskEvents++;
  kindCount.set(ev.kind, (kindCount.get(ev.kind) ?? 0) + 1);
  const arr = byId.get(p.id) ?? [];
  arr.push({ state: p.state, time: Number(ev.time || 0) });
  byId.set(p.id, arr);
  finalState.set(p.id, p.state);
  if (String(p.result || "").includes("重启中断")) receipts.push({ id: p.id, kind: ev.kind, state: p.state, time: ev.time });
}

// 队列等待:同任务相邻事件 queued→running
for (const [id, arr] of byId) {
  for (let i = 1; i < arr.length; i++) {
    if (arr[i - 1].state === "queued" && arr[i].state === "running" && arr[i].time > 0 && arr[i - 1].time > 0) {
      waits.push((arr[i].time - arr[i - 1].time) / 1000);
    }
  }
}

// ---- 输出 ----
function pct(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0; }
const stateCount = {};
for (const s of finalState.values()) stateCount[s] = (stateCount[s] ?? 0) + 1;
const edges = {};
for (const arr of byId.values()) {
  for (let i = 1; i < arr.length; i++) {
    if (arr[i].state === arr[i - 1].state) continue;
    const k = arr[i - 1].state + "→" + arr[i].state;
    edges[k] = (edges[k] ?? 0) + 1;
  }
}
const sw = [...waits].sort((a, b) => a - b);

console.log(`# 任务状态机审计(近 ${DAYS} 天)`);
console.log(`journal: ${JOURNALS.join(" + ")}`);
console.log(`扫描事件 ${scannedEvents} 条,其中 task.* 窗口内 ${taskEvents} 条,任务 ${byId.size} 个\n`);
console.log("## 各态计数(任务最终态)");
for (const [s, c] of Object.entries(stateCount).sort((a, b) => b[1] - a[1])) console.log(`  ${s.padEnd(12)} ${c}`);
console.log(`  死态判定: blocked ${stateCount.blocked ?? 0} 次(0=从未使用的死态)`);
console.log("\n## 迁移边计数(相邻快照 state 差)");
for (const [k, c] of Object.entries(edges).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${c}`);
console.log("\n## 队列等待(enqueue→start,秒)");
if (sw.length) {
  console.log(`  n=${sw.length} p50=${pct(sw, 0.5).toFixed(1)}s p90=${pct(sw, 0.9).toFixed(1)}s max=${sw[sw.length - 1].toFixed(1)}s`);
  console.log(`  优先级决策:p90 ${pct(sw, 0.9) < 120 ? "<" : "≥"} 2min → ${pct(sw, 0.9) < 120 ? "不做优先级字段(等待可忽略)" : "建议做优先级字段"}`);
} else console.log("  窗口内无 queued→running 样本");
console.log("\n## 重启清算痕迹(result 含「重启中断」)");
if (receipts.length) {
  for (const r of receipts.slice(-10)) console.log(`  ${new Date(r.time).toISOString()} ${r.id.slice(0, 8)} ${r.kind} state=${r.state}`);
  console.log(`  共 ${receipts.length} 条`);
} else console.log("  0 条");
console.log("\n## 事件 kind 分布");
for (const [k, c] of Object.entries(Object.fromEntries(kindCount)).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${c}`);
