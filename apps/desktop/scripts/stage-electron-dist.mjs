#!/usr/bin/env node
/**
 * Stage un unpacked Windows Electron distribution for electron-builder's `electronDist`.
 * Why: @electron/get 在本机网络下偶发 ECONNRESET,而 electron-builder 的缓存命中不稳定;
 * electronDist 指向本地解包目录可完全离线打包。来源优先级:
 *   1) ~/.cache/electron/<hash>/electron-v<ver>-win32-x64.zip(历史上已下载的缓存)
 *   2) .stage/downloads/electron-v<ver>-win32-x64.zip
 *   3) GitHub release(失败走 gh-proxy/ghfast 镜像)
 * 产物:apps/desktop/.stage/electron-dist(含 electron.exe),已存在则跳过。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const stageDir = join(desktopDir, ".stage");
const dest = join(stageDir, "electron-dist");
const downloads = join(stageDir, "downloads");
const log = (m) => console.log(`[stage-electron-dist] ${m}`);
const fatal = (m) => { console.error(`[stage-electron-dist] FAIL ${m}`); process.exit(1); };

const electronPkg = JSON.parse(readFileSync(join(desktopDir, "node_modules", "electron", "package.json"), "utf8"));
const version = electronPkg.version;
const zipName = `electron-v${version}-win32-x64.zip`;

if (existsSync(join(dest, "electron.exe"))) {
  log(`已就绪 electron=${version} (${(statSync(join(dest, "electron.exe")).size / 1024 / 1024).toFixed(1)}MB exe),跳过`);
  process.exit(0);
}
mkdirSync(downloads, { recursive: true });

function findCached() {
  const roots = [join(homedir(), ".cache", "electron"), downloads];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const direct = join(root, zipName);
    if (existsSync(direct)) return direct;
    for (const entry of readdirSync(root)) {
      const p = join(root, entry, zipName);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function download() {
  const url = `https://github.com/electron/electron/releases/download/v${version}/${zipName}`;
  const candidates = [url, `https://gh-proxy.com/${url}`, `https://ghfast.top/${url}`];
  const out = join(downloads, zipName);
  for (const u of candidates) {
    log(`下载 ${u}`);
    rmSync(`${out}.part`, { force: true });
    const r = spawnSync("curl", ["-fL", "--retry", "5", "--retry-all-errors", "--retry-delay", "2", "--connect-timeout", "20", "-o", `${out}.part`, u], { stdio: "inherit" });
    if (!r.error && r.status === 0 && existsSync(`${out}.part`) && statSync(`${out}.part`).size > 50 * 1024 * 1024) {
      rmSync(out, { force: true });
      spawnSync("mv", [`${out}.part`, out], { stdio: "ignore" });
      return out;
    }
    rmSync(`${out}.part`, { force: true });
  }
  fatal(`Electron 下载失败(v${version});可手动把 ${zipName} 放到 ${downloads}`);
}

const zip = findCached() || download();
log(`解包 ${zip} → ${dest}`);
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
const sevenZip = process.env.SEVEN_ZIP || "7z";
const r = spawnSync(sevenZip, ["x", "-y", `-o${dest}`, zip], { stdio: "ignore" });
if (r.error || r.status !== 0) fatal(`7z 解包失败:${r.error?.message || r.status}`);
if (!existsSync(join(dest, "electron.exe"))) fatal("解包后缺少 electron.exe(压缩包结构不符)");
log(`完成 electron=${version} → ${dest}`);