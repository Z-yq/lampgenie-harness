/**
 * step-136 DoD 取证:进程回收(stop → 进程树消失)。
 * 用法:node scripts/dod-recycle.mjs
 * 说明:仅取证脚本,不进产品链路。
 */
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, "..");
const { startGateway } = await import(join(desktopDir, "gateway-process.js").replace(/\\/g, "/")).catch(async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)(join(desktopDir, "gateway-process.js"));
});

const gatewayDir = join(desktopDir, "dist", "win-unpacked", "resources", "gateway");
const dataRoot = "/tmp/dod-recycle-root";
const logs = join(dataRoot, "logs");

if (!existsSync(join(gatewayDir, "gateway.mjs"))) {
  console.error(`[recycle] 找不到 ${gatewayDir}/gateway.mjs —— 先跑 dist:dir`);
  process.exit(2);
}

rmSync(dataRoot, { recursive: true, force: true });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const handle = startGateway({ gatewayDir, dataRoot, port: 7802, logs });
const pid = handle.child.pid;
console.log(`[recycle] started pid=${pid}`);

// 等 gateway 真正就绪(而不是盲等)
let ready = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 250));
  if (!alive(pid)) break;
  try {
    const res = await fetch("http://127.0.0.1:7802/");
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {
    /* 还没起 */
  }
}
console.log(`[recycle] ready=${ready} alive=${alive(pid)}`);
if (!ready) {
  console.log(`[recycle] FAIL: gateway 未就绪,输出:\n${handle.recentOutput().join("\n")}`);
  await handle.stop();
  process.exit(1);
}

const t0 = Date.now();
await handle.stop();
const stopMs = Date.now() - t0;
await new Promise((r) => setTimeout(r, 800));
const stillAlive = alive(pid);
console.log(`[recycle] stop() 耗时 ${stopMs}ms,进程残留=${stillAlive} → ${stillAlive ? "FAIL" : "PASS"}`);
process.exit(stillAlive ? 1 : 0);