/**
 * step-136 DoD 取证脚本:向已运行的 gateway 提交一条 echo 任务,并校验 journal 落盘。
 * 用法:node scripts/dod-submit.mjs <port> <dataRoot>
 * 说明:仅用于本环境 DoD 取证(打包产物 → 起 gateway → 提交任务 → 检查 journal),不进产品链路。
 * 依赖解析走仓内相对路径(不写死作者机器绝对路径),换机/CI 可复现。
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", ".."); // apps/desktop/scripts → 仓根
const port = Number(process.argv[2] || 7799);
const dataRoot = resolve(process.argv[3] || join(repoRoot, ".genie", "dod-root"));

// ws 从 gateway 包的解析上下文取(它依赖 ws);不需要额外安装。
const req = createRequire(join(repoRoot, "apps", "gateway", "noop.js"));
let WebSocket;
try {
  WebSocket = req("ws");
} catch (err) {
  console.error(`[dod] 无法解析 ws(需先安装仓依赖): ${err && err.message}`);
  process.exit(2);
}

const journalDir = join(dataRoot, ".genie", "journals");
const before = existsSync(journalDir) ? readdirSync(journalDir) : [];

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
let sawResult = false;

ws.on("open", () => {
  console.log(`[dod] ws open → task.submit (port=${port} dataRoot=${dataRoot})`);
  ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "dod-136", instruction: "echo DOD136-OK" }));
});

ws.on("message", (d) => {
  const s = String(d);
  if (/DOD136-OK|task\.result|task\.status|task\.done|state":"done/.test(s)) {
    console.log(`[dod] frame: ${s.slice(0, 200)}`);
    if (/DOD136-OK|task\.result|state":"done/.test(s)) sawResult = true;
  }
});

ws.on("error", (e) => console.log("[dod] ws error:", e && e.message));

setTimeout(() => {
  ws.close();
  const after = existsSync(journalDir) ? readdirSync(journalDir) : [];
  const added = after.filter((f) => !before.includes(f));
  console.log(`[dod] sawResult=${sawResult}`);
  console.log(`[dod] journal before=${before.length} after=${after.length} added=${JSON.stringify(added)}`);
  process.exit(sawResult && added.length > 0 ? 0 : 1);
}, 25000);