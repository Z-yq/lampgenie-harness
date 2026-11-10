#!/usr/bin/env node
/**
 * 存量任务墓碑补写(2026-10-19「这些删不掉」的存量面)。
 *
 * 背景:本次修复前 task.delete 只从内存删,journal 里一条删除事件都没有——网关每次重启回放
 * task.* 快照就把删掉的任务全复活。修完之后新的删除会落 task.deleted,但**修复前已经删过、
 * 已经复活的那些**没有任何墓碑,只能补写。
 *
 * 用法(必须在网关**停止**时跑:跑到一半的网关自己也在 append,seq 会撞):
 *   node scripts/purge-deleted-tasks.mjs                       # dry-run:只打印将删清单
 *   node scripts/purge-deleted-tasks.mjs --session auto-        # 按会话 id 前缀筛(dry-run)
 *   node scripts/purge-deleted-tasks.mjs --session auto- --apply   # 真写 task.deleted
 *   node scripts/purge-deleted-tasks.mjs --task <taskId> --apply   # 指定单条
 *   --journal <path>    # 缺省 .genie/journals/gateway.jsonl
 *
 * 写入口径:按 journal 当前末尾 seq+1 连续追加,一条事件装一批 taskId(payload.taskIds),
 * 与 server.ts / app.ts 的 task.deleted 语义完全一致(回放时先扫墓碑再跳过被删 id)。
 */
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes("--" + name);
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};

const journalPath = resolve(opt("journal", ".genie/journals/gateway.jsonl"));
const sessPrefix = opt("session", null);
const taskId = opt("task", null);
const apply = flag("apply");

if (!existsSync(journalPath)) {
  console.error(`journal 不存在:${journalPath}`);
  process.exit(1);
}

// ---- 回放:按 id 取最后态(与 apps/gateway/src/app.ts 恢复扫描同款语义)----
const live = new Map();      // taskId -> 最后快照
const dead = new Set();      // 已有墓碑的 id(重跑幂等的关键)
let lastSeq = -1;
for (const line of readFileSync(journalPath, "utf-8").split("\n")) {
  const s = line.trim();
  if (!s) continue;
  let ev;
  try { ev = JSON.parse(s); } catch { break; }   // 崩溃残留半截行:其后不可信
  if (typeof ev.seq === "number" && ev.seq > lastSeq) lastSeq = ev.seq;
  if (ev.kind === "task.deleted") {
    const ids = (ev.payload && Array.isArray(ev.payload.taskIds)) ? ev.payload.taskIds : [];
    for (const id of ids) if (typeof id === "string") dead.add(id);
    continue;
  }
  if (!ev.kind || !ev.kind.startsWith("task.")) continue;
  const p = ev.payload;
  if (!p || typeof p.id !== "string" || typeof p.state !== "string") continue;
  live.set(p.id, p);
}

// ---- 筛选目标 ----
const targets = [...live.values()].filter((t) => {
  if (dead.has(t.id)) return false;                 // 已有墓碑:不重复
  if (taskId) return t.id === taskId;
  if (sessPrefix) return String(t.sessionId || "").startsWith(sessPrefix);
  return false;
});

if (!sessPrefix && !taskId) {
  console.error("必须给筛选条件:--session <前缀> 或 --task <id>(防误删全表)");
  process.exit(1);
}
if (!targets.length) {
  console.log(`无需处理:没有匹配的活任务(已有墓碑 ${dead.size} 条)。`);
  process.exit(0);
}

const bySess = new Map();
for (const t of targets) {
  const k = String(t.sessionId || "(无会话)");
  if (!bySess.has(k)) bySess.set(k, []);
  bySess.get(k).push(t);
}
console.log(`journal: ${journalPath}`);
console.log(`末尾 seq: ${lastSeq} | 活任务 ${live.size} 条 | 已有墓碑 ${dead.size} 条 | 本次将墓碑化 ${targets.length} 条`);
for (const [sid, list] of bySess) {
  console.log(`  ${sid}  ${list.length} 条`);
  for (const t of list.slice(0, 5)) {
    console.log(`    - ${t.id}  ${t.state}  ${String(t.title || t.instruction || "").slice(0, 50)}`);
  }
  if (list.length > 5) console.log(`    … 还有 ${list.length - 5} 条`);
}

if (!apply) {
  console.log("\n[dry-run] 未写盘。加 --apply 执行(网关必须先停)。");
  process.exit(0);
}

// ---- 落盘:按会话分组,一条事件装一批(dry-run 之外唯一的写入口)----
let seq = lastSeq + 1;
const lines = [];
for (const [sid, list] of bySess) {
  lines.push(JSON.stringify({
    seq: seq++,
    time: Date.now(),
    kind: "task.deleted",
    sessionId: sid,
    payload: { taskIds: list.map((t) => t.id), sessionId: sid, by: "purge-script" },
  }));
}
appendFileSync(journalPath, lines.join("\n") + "\n", "utf-8");
console.log(`\n已写入 ${lines.length} 条 task.deleted(${targets.length} 个任务墓碑化)。重启网关后生效。`);