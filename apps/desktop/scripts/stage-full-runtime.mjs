#!/usr/bin/env node
/**
 * 全量桌面包运行时 staging(ONNX 版):让安装包在新 PC 上零外部依赖运行,且不再随 Python/torch。
 *
 * 产物(全部由 electron-builder extraResources 搬进 <install>/resources):
 *   .stage/runtime/model-150m    ONNX 模型服务(server.mjs + lib/ + onnx/ + node_modules)
 *   .stage/browsers/chrome-win64 Chrome for Testing(与 playwright-core 同 revision)
 *   .stage/git                   PortableGit(bash + git,Windows 无 bash 的兜底)
 *
 * 幂等:下载缓存在 .stage/downloads;组件关键文件齐全则跳过;--force 全量重建。
 * 模型来自 services/model-150m(先跑 .venv/bin/python tools/export_onnx.py)。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const serviceDir = join(repoRoot, "services", "model-150m");
const stageDir = join(desktopDir, ".stage");
const downloadsDir = join(stageDir, "downloads");
const runtimeDir = join(stageDir, "runtime");
const modelDir = join(runtimeDir, "model-150m");
const browsersDir = join(stageDir, "browsers");
const gitDir = join(stageDir, "git");
const FORCE = process.argv.includes("--force");

const SOURCES = {
  chrome: "https://cdn.playwright.dev/builds/cft/156.0.8078.4/win64/chrome-win64.zip",
  git: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe",
};
function gitMirrors(url) {
  return [`https://gh-proxy.com/${url}`, `https://ghfast.top/${url}`];
}
const EXPECTED = { chrome: 207073013, git: 60087472 };

function log(msg) {
  console.log(`[stage-full-runtime] ${msg}`);
}
function fatal(msg) {
  console.error(`[stage-full-runtime] FAIL ${msg}`);
  process.exit(1);
}
function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}
function requireFile(p, label = p) {
  if (!existsSync(p)) fatal(`缺少 ${label}`);
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) fatal(`${cmd} 执行失败:${r.error.message}`);
  if (r.status !== 0) fatal(`${cmd} 退出码 ${r.status}:${args.join(" ")}`);
}
/** 下载(带镜像/大小校验):urls 依序尝试,全部失败才 fatal。 */
function download(urls, file, expectedBytes) {
  const list = Array.isArray(urls) ? urls : [urls];
  ensureDir(dirname(file));
  if (existsSync(file) && statSync(file).size > 1024) {
    const size = statSync(file).size;
    if (!expectedBytes || size === expectedBytes) {
      log(`复用下载 ${basename(file)}(${(size / 1024 / 1024).toFixed(1)}MB)`);
      return file;
    }
    log(`缓存大小不符(${size} != ${expectedBytes}),重新下载 ${basename(file)}`);
  }
  for (const url of list) {
    log(`下载 ${url}`);
    rmSync(`${file}.part`, { force: true });
    const r = spawnSync("curl", ["-fL", "--retry", "5", "--retry-all-errors", "--retry-delay", "2", "--connect-timeout", "20", "-o", `${file}.part`, url], { stdio: "inherit" });
    const ok = !r.error && r.status === 0 && existsSync(`${file}.part`);
    const size = ok ? statSync(`${file}.part`).size : -1;
    if (ok && (!expectedBytes || size === expectedBytes)) {
      rmSync(file, { force: true });
      cpSync(`${file}.part`, file);
      rmSync(`${file}.part`, { force: true });
      return file;
    }
    log(`失败/大小不符(url=${url} exit=${r.status ?? r.error?.message} size=${size})`);
    rmSync(`${file}.part`, { force: true });
  }
  fatal(`全部下载源失败:${basename(file)}`);
}
function extract(archive, dest) {
  rmSync(dest, { recursive: true, force: true });
  ensureDir(dest);
  const sevenZip = process.env.SEVEN_ZIP || "7z";
  const probe = spawnSync(sevenZip, ["i"], { stdio: "ignore" });
  if (probe.error) fatal(`需要 7z 解压 ${basename(archive)}(安装 p7zip 或设置 SEVEN_ZIP)`);
  run(sevenZip, ["x", "-y", `-o${dest}`, archive], { stdio: "ignore" });
}
function dirSize(p) {
  if (!existsSync(p)) return 0;
  let total = 0;
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const child = join(p, entry.name);
    total += entry.isDirectory() ? dirSize(child) : statSync(child).size;
  }
  return total;
}
function mb(p) {
  return `${(dirSize(p) / 1024 / 1024).toFixed(1)}MB`;
}

/* ── 1. ONNX 模型服务(server.mjs + lib + onnx + 运行时 node_modules) ─────── */
function stageModel() {
  const onnxSrc = join(serviceDir, "onnx");
  const graph = join(onnxSrc, "model.onnx");
  const data = join(onnxSrc, "model.onnx.data");
  if (!existsSync(graph) || !existsSync(data)) {
    fatal("缺少 ONNX 模型/权重(model.onnx + model.onnx.data):先跑 services/model-150m/.venv/bin/python tools/export_onnx.py");
  }
  if (!existsSync(join(serviceDir, "node_modules", "onnxruntime-node"))) {
    log("安装模型服务 Node 依赖(npm install --ignore-scripts)…");
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: serviceDir });
  }
  const marker = join(modelDir, ".stage.json");
  const ortDll = join(modelDir, "node_modules", "onnxruntime-node", "bin", "napi-v6", "win32", "x64", "onnxruntime.dll");
  if (!FORCE && existsSync(marker) && existsSync(join(modelDir, "server.mjs")) && existsSync(join(modelDir, "onnx", "model.onnx")) && existsSync(join(modelDir, "onnx", "model.onnx.data")) && existsSync(ortDll)) {
    log(`model-150m(onnx)已就绪,跳过(${mb(modelDir)})`);
    return;
  }
  rmSync(modelDir, { recursive: true, force: true });
  ensureDir(join(modelDir, "onnx"));
  // 服务代码(不含 Python 遗留:server.py/engine.py/batcher.py/upstream/权重)
  for (const f of ["server.mjs", "package.json"]) {
    requireFile(join(serviceDir, f), `services/model-150m/${f}`);
    copyFileSync(join(serviceDir, f), join(modelDir, f));
  }
  cpSync(join(serviceDir, "lib"), join(modelDir, "lib"), { recursive: true });
  // ONNX 运行期模型:图 + 外部权重(fp32;与 torch 逐位对齐)
  copyFileSync(graph, join(modelDir, "onnx", "model.onnx"));
  copyFileSync(data, join(modelDir, "onnx", "model.onnx.data"));
  for (const f of ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"]) {
    const src = join(onnxSrc, f);
    if (existsSync(src)) copyFileSync(src, join(modelDir, "onnx", f));
  }
  // node_modules:只留 Windows x64 的 ORT 二进制(去掉 DirectML/其它平台/脚本),其余依赖原样。
  const nmSrc = join(serviceDir, "node_modules");
  const nmDst = join(modelDir, "node_modules");
  cpSync(nmSrc, nmDst, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const norm = src.split(sep()).join("/");
      if (norm.includes("/onnxruntime-node/script")) return false;
      const at = norm.indexOf("/onnxruntime-node/bin/");
      if (at >= 0) {
        const rest = norm.slice(at + "/onnxruntime-node/bin/".length).split("/");
        // 目录本身(空 rest)与祖先目录要放行,否则整个 bin/ 被剪掉。
        if (!rest[0]) return true;
        if (rest[0] !== "napi-v6") return false;
        if (rest.length === 1) return true;
        if (rest[1] !== "win32") return false;
        if (rest.length === 2) return true;
        if (rest[2] !== "x64") return false;
        if (rest.length === 3) return true;
        return ["onnxruntime.dll", "onnxruntime_binding.node"].includes(rest[3]);
      }
      return true;
    },
  });
  for (const [p, label] of [
    [join(modelDir, "server.mjs"), "server.mjs"],
    [join(modelDir, "lib", "encode.mjs"), "lib/encode.mjs"],
    [join(modelDir, "onnx", "model.onnx"), "onnx/model.onnx"],
    [join(modelDir, "onnx", "model.onnx.data"), "onnx/model.onnx.data"],
    [join(modelDir, "onnx", "tokenizer.json"), "onnx/tokenizer.json"],
    [join(modelDir, "node_modules", "onnxruntime-node", "bin", "napi-v6", "win32", "x64", "onnxruntime.dll"), "onnxruntime.dll"],
  ]) requireFile(p, label);
  const modelBytes = statSync(join(modelDir, "onnx", "model.onnx.data")).size;
  writeFileSync(marker, JSON.stringify({
    component: "model-150m-onnx",
    at: new Date().toISOString(),
    model: "model.onnx(+model.onnx.data)",
    modelBytes,
    precision: "fp32",
  }, null, 2));
  log(`model-150m(onnx fp32,权重 ${(modelBytes / 1024 / 1024).toFixed(1)}MB)完成(${mb(modelDir)})`);
}

/** 当前平台分隔符(只用于过滤路径;构建机是 Linux,产物按 win32 布局裁剪)。 */
function sep() {
  return process.platform === "win32" ? "\\" : "/";
}

/* ── 2. Chromium(Chrome for Testing) ──────────────────────────────────── */
function stageBrowsers() {
  const exe = join(browsersDir, "chrome-win64", "chrome.exe");
  if (!FORCE && existsSync(exe) && existsSync(join(browsersDir, "chrome-win64", "chrome.dll"))) {
    log(`browsers 已就绪,跳过(${mb(browsersDir)})`);
    return;
  }
  const zip = download(SOURCES.chrome, join(downloadsDir, "chrome-win64.zip"), EXPECTED.chrome);
  extract(zip, browsersDir);
  requireFile(join(browsersDir, "chrome-win64", "chrome.exe"), "chrome-win64/chrome.exe");
  log(`browsers 完成(${mb(browsersDir)})`);
}

/* ── 3. PortableGit(bash + git) ─────────────────────────────────────────── */
function stageGit() {
  const bash = join(gitDir, "bin", "bash.exe");
  const git = join(gitDir, "cmd", "git.exe");
  if (!FORCE && existsSync(bash) && existsSync(git)) {
    log(`git 已就绪,跳过(${mb(gitDir)})`);
    return;
  }
  const archive = download([SOURCES.git, ...gitMirrors(SOURCES.git)], join(downloadsDir, "PortableGit.7z.exe"), EXPECTED.git);
  extract(archive, gitDir);
  requireFile(join(gitDir, "bin", "bash.exe"), "git/bin/bash.exe");
  requireFile(join(gitDir, "cmd", "git.exe"), "git/cmd/git.exe");
  requireFile(join(gitDir, "usr", "bin", "sed.exe"), "git/usr/bin/sed.exe");
  log(`git 完成(${mb(gitDir)})`);
}

/* ── main ───────────────────────────────────────────────────────────────── */
ensureDir(downloadsDir);
ensureDir(runtimeDir);
// 清掉 0.0.3 及更早的 Python/torch 全量运行时残留(本批的核心目标)
rmSync(join(runtimeDir, "python"), { recursive: true, force: true });
stageModel();
stageBrowsers();
stageGit();

const summary = {
  at: new Date().toISOString(),
  components: {
    model: {
      path: "runtime/model-150m",
      sizeMB: +(dirSize(modelDir) / 1024 / 1024).toFixed(1),
      modelBytes: existsSync(join(modelDir, "onnx", "model.onnx.data")) ? statSync(join(modelDir, "onnx", "model.onnx.data")).size : 0,
      precision: "fp32(external data)",
      runtime: "onnxruntime-node win32-x64 + @huggingface/tokenizers(no torch/python)",
    },
    browsers: { path: "browsers", sizeMB: +(dirSize(browsersDir) / 1024 / 1024).toFixed(1), source: SOURCES.chrome },
    git: { path: "git", sizeMB: +(dirSize(gitDir) / 1024 / 1024).toFixed(1), source: SOURCES.git },
  },
};
writeFileSync(join(stageDir, "full-runtime.json"), JSON.stringify(summary, null, 2));
log(`DONE runtime=${summary.components.model.sizeMB}MB browsers=${summary.components.browsers.sizeMB}MB git=${summary.components.git.sizeMB}MB → ${stageDir}`);