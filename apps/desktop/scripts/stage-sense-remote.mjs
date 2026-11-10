#!/usr/bin/env node
/**
 * 远端代码认知运行时 staging(ZCode Source Server 形态的 genie 切片):
 * 把 code-sense CLI + 依赖闭包 + **自带的 Linux Node 20** 打成 `sense-remote.tar.gz`,
 * 连接 WSL/SSH 时上传到目标 `~/.genie/genie-sense`,之后 code_sense / code_review
 * 由工作区服务在远端直接执行(不再逐次 wsl.exe / ssh 拼命令)。
 * 为什么自带 Node:code-sense 需要 node>=20(可选链/空值合并、Object.hasOwn、Array.at 等),
 * 而 WSL 常见 apt node 只有 12;远端没有可靠 node 时工具会整块不可用(ZCode 同样在
 * Source Server archive 内自带目标 Node)。
 * 内容:
 *   node                        Node 20 linux-x64 官方二进制(下载缓存 .stage/downloads)
 *   app/cli.js                  packages/code-sense-cli/dist/cli.js(esbuild bundle,外部依赖 ts-morph/web-tree-sitter)
 *   app/package.json            {"type":"module"}(ESM 入口)
 *   app/node_modules/…          gateway staging 的依赖闭包去掉 playwright-core;
 *                               tree-sitter-wasms 剪到 code-sense 支持的 11 种语言
 * 幂等:.stage/sense-remote 每次重建;tar 版本号=sha256 前 16 位,部署端据此跳过重复上传。
 * 纯 Node 内置实现 + tar 命令(WSL/Linux 均自带)。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const stageDir = join(desktopDir, ".stage");
const senseDir = join(stageDir, "sense-remote");
const downloads = join(stageDir, "downloads");
const tarPath = join(stageDir, "sense-remote.tar.gz");
const versionPath = join(stageDir, "sense-remote.version");

const NODE_VERSION = "20.18.3";
const NODE_DIST = `node-v${NODE_VERSION}-linux-x64`;
const NODE_URLS = [
  `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.xz`,
  `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${NODE_DIST}.tar.xz`,
];

/** code-sense 支持的语言(adapters/tree-sitter.ts TsLang);只带这些 wasm,50MB→~10MB。 */
const TS_LANGS = ["python", "go", "java", "c", "cpp", "javascript", "typescript", "rust", "c_sharp", "ruby", "php"];

const log = (m) => console.log(`[stage-sense-remote] ${m}`);

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

function ensureNodeTarball() {
  mkdirSync(downloads, { recursive: true });
  const cached = join(downloads, `${NODE_DIST}.tar.xz`);
  if (existsSync(cached) && statSync(cached).size > 10 * 1024 * 1024) return cached;
  let lastErr = "";
  for (const url of NODE_URLS) {
    try {
      log(`下载 ${url}`);
      run("curl", ["-fL", "--retry", "3", "--connect-timeout", "15", "-o", cached, url]);
      if (statSync(cached).size > 10 * 1024 * 1024) return cached;
      lastErr = "下载体量异常";
    } catch (e) {
      lastErr = String(e?.message ?? e);
      log(`下载失败:${lastErr.slice(0, 160)}`);
    }
  }
  throw new Error("Node 运行时下载失败:" + lastErr);
}

function extractNode(tarball) {
  const tmp = join(stageDir, ".sense-node-extract");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  run("tar", ["-xJf", tarball, "-C", tmp, `${NODE_DIST}/bin/node`]);
  const src = join(tmp, NODE_DIST, "bin", "node");
  if (!existsSync(src)) throw new Error("解包后找不到 node 二进制:" + src);
  const dest = join(senseDir, "node");
  cpSync(src, dest);
  run("chmod", ["+x", dest]);
  rmSync(tmp, { recursive: true, force: true });
}

function copyApp() {
  const cli = join(repoRoot, "packages", "code-sense-cli", "dist", "cli.js");
  if (!existsSync(cli)) throw new Error("缺少 code-sense-cli bundle:" + cli + "(先 pnpm --filter @lampgenie/code-sense-cli build)");
  const appDir = join(senseDir, "app");
  mkdirSync(appDir, { recursive: true });
  cpSync(cli, join(appDir, "cli.js"));
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "genie-sense-remote", private: true, type: "module" }, null, 2) + "\n");

  const srcModules = join(stageDir, "node_modules");
  if (!existsSync(srcModules)) throw new Error("缺少 .stage/node_modules(先跑 scripts/stage-gateway-deps.mjs)");
  const destModules = join(appDir, "node_modules");
  rmSync(destModules, { recursive: true, force: true });
  mkdirSync(destModules, { recursive: true });
  for (const name of readdirSync(srcModules)) {
    if (name === "playwright-core") continue; // 代码认知不用浏览器
    cpSync(join(srcModules, name), join(destModules, name), { recursive: true, dereference: true });
  }

  // tree-sitter-wasms 剪枝(只留 code-sense 支持的语言 + package.json)
  const tsDir = join(destModules, "tree-sitter-wasms");
  const outDir = join(tsDir, "out");
  if (existsSync(outDir)) {
    const keep = new Set(TS_LANGS.map((l) => `tree-sitter-${l}.wasm`));
    for (const f of readdirSync(outDir)) {
      if (!keep.has(f)) rmSync(join(outDir, f), { force: true });
    }
    log(`tree-sitter wasm 剪枝:${readdirSync(outDir).length} 个(${TS_LANGS.join(", ")})`);
  }
}

function makeTar() {
  rmSync(tarPath, { force: true });
  run("tar", ["-czf", tarPath, "-C", senseDir, "."]);
  const bytes = readFileSync(tarPath);
  const version = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  writeFileSync(versionPath, version + "\n");
  return { bytes: bytes.length, version };
}

function selfCheck() {
  const node = join(senseDir, "node");
  const cli = join(senseDir, "app", "cli.js");
  const out = run(node, [cli, "--help"], { timeout: 60_000 });
  if (!/codesense/i.test(out)) throw new Error("远端 CLI 自检失败:输出不含 codesense");
  // 真索引冒烟:临时 TS 项目 index + symbol
  const tmp = join(stageDir, ".sense-smoke");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "src"), { recursive: true });
  writeFileSync(join(tmp, "src", "a.ts"), "export function hello(x: number) { return helper(x); }\nexport function helper(y: number) { return y + 1; }\n");
  run(node, [cli, "index", tmp], { timeout: 120_000, cwd: tmp });
  const sym = run(node, [cli, "symbol", "helper", "--root", tmp], { timeout: 60_000, cwd: tmp });
  if (!/helper/.test(sym)) throw new Error("远端 CLI 索引冒烟失败");
  rmSync(tmp, { recursive: true, force: true });
  return out.split("\n")[0];
}

function main() {
  log(`repo=${repoRoot}`);
  rmSync(senseDir, { recursive: true, force: true });
  mkdirSync(senseDir, { recursive: true });
  extractNode(ensureNodeTarball());
  copyApp();
  const version = selfCheck();
  const { bytes, version: hash } = makeTar();
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + "MB";
  log(`自检通过:${version}`);
  log(`产出 ${tarPath} ${mb(bytes)}(version=${hash})`);
}

try {
  main();
} catch (err) {
  console.error("[stage-sense-remote] 失败:", err instanceof Error ? err.message : err);
  process.exit(1);
}