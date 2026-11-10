/** node-agent CLI 的 os 导入整理(esbuild bundle 后顺序敏感,统一头部导入)。 */
import * as os from "node:os";
import { spawn } from "node:child_process";
import { startNodeAgent } from "./index.js";

const gatewayUrl = process.env.GENIE_GATEWAY_URL;
if (!gatewayUrl) {
  console.error("缺 GENIE_GATEWAY_URL(例如 ws://192.168.1.10:7700)");
  process.exit(1);
}
const nodeId = process.env.GENIE_NODE_ID ?? "node-" + os.hostname();

// 一期执行后端:子进程 bash(命令文本;输出/退出码回传)。
const execute = (instruction: string, env: Record<string, string>) =>
  new Promise<{ ok: boolean; output: string; error?: string }>((resolve) => {
    const p = spawn("bash", ["-lc", instruction], { env: { ...process.env, ...env }, timeout: 120_000 });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); if (out.length > 200_000) p.kill(); });
    p.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("exit", (code) => resolve({ ok: code === 0, output: out.slice(0, 200_000), ...(code !== 0 ? { error: "exit " + code } : {}) }));
    p.on("error", (e) => resolve({ ok: false, output: out, error: String(e).slice(0, 200) }));
  });

startNodeAgent({
  gatewayUrl,
  nodeId,
  kind: (process.env.GENIE_NODE_KIND as "pc" | "server" | "jump") ?? "server",
  capabilities: (process.env.GENIE_NODE_CAPS ?? "shell,fs").split(",").map((s) => s.trim()).filter(Boolean),
  reachability: (process.env.GENIE_NODE_REACH ?? "lan,internet").split(",").map((s) => s.trim()).filter(Boolean),
  execute,
});
console.log("[node-agent] 连接 " + gatewayUrl + " · id=" + nodeId);
