#!/usr/bin/env node
/**
 * 打包环境预检(pkg-s1):wine/WoW64/WINEPREFIX/NSIS 可用性。
 * 口径(2026-10-25 Windows 实机构建收敛):electron-builder 自带 NSIS 与 wine 驱动即可构建;
 * 系统 makensis/wine64 不是硬依赖。缺系统命令时按「bundled/等效可用」判定,并明确标注依据。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const checks = [];
function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").trim().split(/\r?\n/)[0] : "";
}
const wine = which("wine");
checks.push({ name: "wine", ok: !!wine, detail: wine || "未找到" });
for (const c of ["wine64", "makensis", "makensis.exe"]) {
  const p = which(c);
  checks.push({ name: c, ok: !!p, detail: p || "系统未安装", optional: true });
}
const prefix = process.env.WINEPREFIX || "";
checks.push({ name: "WINEPREFIX", ok: true, detail: prefix || "未设置(使用默认 prefix;electron-builder 构建实测成功)", optional: !prefix });
if (wine) {
  const r = spawnSync("wine", ["--version"], { encoding: "utf8" });
  checks.push({ name: "wine32(WoW64)", ok: r.status === 0, detail: r.status === 0 ? (r.stdout || "").trim() : "wine --version 失败" });
}
// electron-builder 自带 NSIS(nsis-3.0.4.1)在缓存里;系统 makensis 不是硬依赖。
const cache = join(homedir(), ".cache", "electron-builder");
const bundledNsis = existsSync(cache) && readdirSync(cache).some((n) => n.startsWith("nsis-"));
checks.push({ name: "NSIS", ok: !!which("makensis") || bundledNsis, detail: which("makensis") ? which("makensis") : bundledNsis ? "electron-builder bundled NSIS(" + cache + ")" : "未找到系统 makensis 或 electron-builder 缓存" });
const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const eb = which("electron-builder") || existsSync(join(desktopDir, "node_modules", ".bin", "electron-builder"));
checks.push({ name: "electron-builder", ok: !!eb, detail: eb ? String(eb) : "缺少 electron-builder(在 apps/desktop 执行 pnpm install)" });
let bad = 0;
for (const c of checks) {
  const miss = !c.ok && !c.optional;
  console.log(`[preflight-win] ${c.ok ? "ok" : "MISSING"} ${c.name}: ${c.detail}`);
  if (miss) bad++;
}
if (bad) {
  console.error("[preflight-win] FAIL 缺少必需打包工具。");
  process.exit(1);
}
console.log("[preflight-win] PASS wine + WoW64 + NSIS(electron-builder) 可用;系统 makensis/wine64 缺失不阻塞");
