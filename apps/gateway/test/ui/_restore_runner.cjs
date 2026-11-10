/** 白板恢复闭环经验证 runner:掌管 gateway 子进程生命周期(启动/杀/同参重启),
 * 然后进程内运行 boardrestore.spec.cjs(spec 末尾 process.exit 收尾)。
 * 用法:cd apps/gateway && npx tsx test/ui/_restore_runner.cjs
 * 环境:SELF_PORT(默认 7799)/GENIE_JOURNAL_DIR(默认 /tmp/j-s072)/KEEP_JOURNAL=1 跳过清账(复跑验收用) */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const PORT = Number(process.env.SELF_PORT || 7799);
const JD = process.env.GENIE_JOURNAL_DIR || "/tmp/j-s072";
const SERVER = path.join(__dirname, "_restore_server.cjs");

let child = null;
async function start() {
 // --conditions=development:workspace 包走 src,绕开 stale dist(并发在途面 parent-ask-broker dist 缺失验证;
  // 与 vitest 全仓同一条件,免「包级 build」重操作)。
 // detached:true=独立进程组——gateway 会 fork sense-index-worker(重建孤儿经验证:重启后旧 worker 存活
 // 并吃满 CPU,把后续 spec 页面加载拖到 60s 超时),必须按组杀(续作轮)。
  child = spawn(process.execPath, ["--import", "tsx", "--conditions=development", SERVER], {
    env: { ...process.env, SELF_PORT: String(PORT), GENIE_JOURNAL_DIR: JD, GENIE_CHECKPOINT: "off", NODE_OPTIONS: "--max-old-space-size=1024" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.on("data", (d) => process.stdout.write("[gw] " + d));
  child.stderr.on("data", (d) => process.stderr.write("[gw!] " + d));
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch("http://127.0.0.1:" + PORT + "/"); if (r.ok) break; } catch (e) { /* 未就绪 */ }
    if (child.exitCode !== null) throw new Error("gateway child exited early code=" + child.exitCode);
    if (Date.now() - t0 > 30000) throw new Error("gateway not ready on " + PORT);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log("[runner] gateway ready on " + PORT + " (journalDir=" + JD + ")");
}
async function stop() {
  if (!child) return;
  const c = child; child = null;
  try { process.kill(-c.pid, "SIGKILL"); } catch (e) { c.kill("SIGKILL"); } // 按组杀:连带 sense-index-worker
  await new Promise((r) => setTimeout(r, 700));
}
globalThis.GWCTL = {
  restart: async () => { console.log("[runner] restarting gateway…"); await stop(); await start(); },
  port: PORT,
  journalDir: JD,
};
process.on("exit", () => { try { if (child) process.kill(-child.pid, "SIGKILL"); } catch (e) { /* 尽力 */ } });

process.env.PANEL_BASE = "http://127.0.0.1:" + PORT;
(async () => {
  if (!process.env.KEEP_JOURNAL) fs.rmSync(JD, { recursive: true, force: true });
  fs.mkdirSync(JD, { recursive: true });
  await start();
  require(process.env.SELF_SPEC || "./boardrestore.spec.cjs");
})().catch((e) => { console.error("RUNNER CRASH", e); process.exit(1); });
