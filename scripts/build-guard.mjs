#!/usr/bin/env node
/**
 * 构建守卫(2026-10-21 用户口径:7700 有活跃 session 不允许构建):
 * ① 有 running/queued/blocked 任务 → 拒绝;
 * ② 最近 90s journal 有新事件(活跃会话交互中)→ 拒绝。
 * 7700 不可达(没起服务/CI)→ 放行。所有探测全程限时;任何一步超时按降级处理
 * (守卫不阻塞构建链路,只在明确活跃时拦截)。
 */
import { statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.env.GENIE_PORT ?? "7700";
const HERE = dirname(fileURLToPath(import.meta.url));
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

// ① HTTP 可达性(GET;HEAD 可能不被支持而悬挂)
const ok = await withTimeout(
  fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false),
  4000,
);
// HTTP 不可达不短路:WS/任务探测跳过,但 journal 活跃度仍要查(HTTP 挂死而 WS 活着的
// 半死态实测存在——此时面板仍在交互,构建同样应被拒)。

// ② 活跃任务:WS task.list(全程限时;失败降级跳过,以 journal 活跃度兜底)
let tasks = null;
try {
  const WebSocket = (await import(join(dirname(HERE), "apps", "gateway", "node_modules", "ws", "index.js"))).default;
  tasks = await withTimeout(new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const t = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error("task.list timeout")); }, 4500);
    ws.on("open", () => ws.send(JSON.stringify({ v: 1, type: "task.list" })));
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === "task.list") { clearTimeout(t); try { ws.close(); } catch {} resolve(m.tasks ?? []); }
    });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
  }), 5000);
} catch { tasks = null; }

if (ok !== true) console.log("[build-guard] HTTP 探测失败(半死态或未启动),跳过任务探测,以 journal 兜底");
if (Array.isArray(tasks)) {
  const busy = tasks.filter((x) => x.state === "running" || x.state === "queued" || x.state === "blocked");
  if (busy.length) {
    console.error("[build-guard] 拒绝构建:7700 有活跃任务——");
    for (const b of busy.slice(0, 8)) console.error(`  [${b.state}] ${String(b.instruction ?? b.id).slice(0, 70)}`);
    console.error("  等任务终态后再构建(活跃期换 dist=运行态与磁盘态割裂)。");
    process.exit(1);
  }
} else {
  console.log("[build-guard] 任务态探测超时(降级,以 journal 活跃度兜底)");
}

// ③ journal 最近事件(90s 窗)——2026-10-21 分文件修复:gateway.jsonl 已冻结(只读历史),
// 活跃事件写 global.jsonl + sessions/*.jsonl;扫整个 journals 目录取最新 mtime,单文件缺失忽略。
try {
  const jdir = join(dirname(HERE), ".genie", "journals");
  let newest = 0;
  const consider = (p) => { try { const m = statSync(p).mtimeMs; if (m > newest) newest = m; } catch { /* 单文件不可达忽略 */ } };
  consider(join(jdir, "gateway.jsonl"));
  consider(join(jdir, "global.jsonl"));
  try {
    for (const f of readdirSync(join(jdir, "sessions"))) if (f.endsWith(".jsonl")) consider(join(jdir, "sessions", f));
  } catch { /* sessions/ 不存在=未启用分文件,旧单文件已覆盖 */ }
  const ageMs = Date.now() - newest;
  if (newest > 0 && ageMs < 90_000) {
    console.error(`[build-guard] 拒绝构建:journal ${Math.round(ageMs / 1000)}s 前仍有事件(会话交互中)。稍候或确认会话空闲。`);
    process.exit(1);
  }
} catch { /* journal 不可达=跳过 */ }
console.log("[build-guard] 7700 空闲,放行构建");
process.exit(0);
