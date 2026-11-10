#!/usr/bin/env node
/**
 * 打包产物验收门(pkg-s3):校验 win-unpacked/resources/gateway 五件套 + staged node_modules 链。
 * 用法:
 *   node scripts/verify-artifact.mjs [--dir dist/win-unpacked] [--proto]
 * --proto 只做 gateway.mjs 与 session-worker.mjs 的 SESSION_WORKER_PROTOCOL_VERSION 同批一致性。
 * 任一必需项缺失/版本不一致 → 非零退出并点名,不静默通过。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const args = process.argv.slice(2);
const dirArg = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : "dist/win-unpacked";
const protoOnly = args.includes("--proto");
const fullCheck = args.includes("--full");
const unpacked = resolve(desktopDir, dirArg);
const gatewayDir = join(unpacked, "resources", "gateway");

function fail(msg) {
  console.error("[verify-artifact] FAIL " + msg);
  process.exit(1);
}
function protocolOf(file) {
  if (!existsSync(file)) return { file, error: "文件不存在" };
  const s = readFileSync(file, "utf8");
  const m = s.match(/SESSION_WORKER_PROTOCOL_VERSION\s*=\s*(\d+)/);
  if (!m) return { file, error: "未解析到 SESSION_WORKER_PROTOCOL_VERSION(可能被 minify 改写)" };
  return { file, version: m[1] };
}
function findTsMorphCommon() {
  const top = join(gatewayDir, "node_modules", "@ts-morph", "common");
  if (existsSync(top)) return top;
  const nested = join(gatewayDir, "node_modules", "ts-morph", "node_modules", "@ts-morph", "common");
  return existsSync(nested) ? nested : null;
}

const gwFile = join(gatewayDir, "gateway.mjs");
const workerFile = join(gatewayDir, "session-worker.mjs");

if (protoOnly) {
  const a = protocolOf(gwFile);
  const b = protocolOf(workerFile);
  console.log("[verify-artifact] proto gateway=" + (a.version ?? a.error) + " session-worker=" + (b.version ?? b.error));
  if (a.error || b.error) fail("协议版本解析失败:" + [a, b].filter((x) => x.error).map((x) => x.file + "(" + x.error + ")").join("; "));
  if (a.version !== b.version) fail(`协议版本不一致:gateway=${a.version} session-worker=${b.version}(两 bundle 必须同批构建)`);
  console.log("[verify-artifact] PASS protocol=" + a.version);
  process.exit(0);
}

if (!existsSync(gatewayDir)) fail("找不到 " + gatewayDir + "(先跑 pnpm run dist:dir)");
const required = [
  ["gateway.mjs", gwFile],
  ["session-worker.mjs", workerFile],
  ["sense-index-worker.mjs", join(gatewayDir, "sense-index-worker.mjs")],
  ["tree-sitter.wasm", join(gatewayDir, "tree-sitter.wasm")],
  ["echo-child.mjs", join(gatewayDir, "echo-child.mjs")],
  ["assets/", join(gatewayDir, "assets")],
  // PPT 导出依赖(src/board-pptx.mjs 的拷贝;缺失则打包态 board_export_pptx 工具 ERR_MODULE_NOT_FOUND)
  ["board-pptx.mjs", join(gatewayDir, "board-pptx.mjs")],
  // ESM 标记(缺失则同目录 .js(tsc 产物)被 Node 按 CJS 解析 → 外部 import 直接 SyntaxError)
  ["package.json", join(gatewayDir, "package.json")],
];
const missing = [];
for (const [name, p] of required) {
  const ok = existsSync(p);
  console.log(`[verify-artifact] ${ok ? "ok" : "MISSING"} ${name}`);
  if (!ok) missing.push(name);
}
const tsMorph = join(gatewayDir, "node_modules", "ts-morph");
const tsCommon = findTsMorphCommon();
console.log(`[verify-artifact] ${existsSync(tsMorph) ? "ok" : "MISSING"} node_modules/ts-morph`);
if (!existsSync(tsMorph)) missing.push("node_modules/ts-morph");
console.log(`[verify-artifact] ${tsCommon ? "ok" : "MISSING"} ts-morph → @ts-morph/common`);
if (!tsCommon) missing.push("ts-morph → @ts-morph/common");
const optional = ["playwright-core", "tree-sitter-wasms", "web-tree-sitter"];
const optRows = optional.map((n) => [n, existsSync(join(gatewayDir, "node_modules", n))]);
for (const [n, ok] of optRows) console.log(`[verify-artifact] ${ok ? "ok" : "optional-missing"} node_modules/${n}`);
if (missing.length) fail("必需项缺失:" + missing.join(", "));

/* 全量运行时(pkg-full):ONNX 模型服务、Chromium、PortableGit。
 * 这些是新 PC 零外部依赖的前提,缺一即视为残包(不再静默降级)。
 * 同时拒绝旧 torch/Python 运行时残留(本批目标就是把它从包里拿掉)。 */
if (fullCheck) {
  const res = join(unpacked, "resources");
  const m = (...p) => join(res, "runtime", "model-150m", ...p);
  const items = [
    ["runtime/model-150m/server.mjs", m("server.mjs"), 1024],
    ["runtime/model-150m/lib/encode.mjs", m("lib", "encode.mjs"), 1024],
    ["runtime/model-150m/lib/ort-engine.mjs", m("lib", "ort-engine.mjs"), 1024],
    ["runtime/model-150m/lib/tokenizer.mjs", m("lib", "tokenizer.mjs"), 512],
    ["runtime/model-150m/onnx/config.json", m("onnx", "config.json"), 64],
    ["runtime/model-150m/onnx/tokenizer.json", m("onnx", "tokenizer.json"), 1024],
    ["runtime/model-150m/onnx/model.onnx", m("onnx", "model.onnx"), 10 * 1024],
    ["runtime/model-150m/onnx/model.onnx.data", m("onnx", "model.onnx.data"), 100 * 1024 * 1024],
    ["runtime/model-150m/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll", m("node_modules", "onnxruntime-node", "bin", "napi-v6", "win32", "x64", "onnxruntime.dll"), 1024 * 1024],
    ["runtime/model-150m/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node", m("node_modules", "onnxruntime-node", "bin", "napi-v6", "win32", "x64", "onnxruntime_binding.node"), 100 * 1024],
    ["runtime/model-150m/node_modules/onnxruntime-common/package.json", m("node_modules", "onnxruntime-common", "package.json"), 64],
    ["runtime/model-150m/node_modules/@huggingface/tokenizers/package.json", m("node_modules", "@huggingface", "tokenizers", "package.json"), 64],
    ["browsers/chrome-win64/chrome.exe", join(res, "browsers", "chrome-win64", "chrome.exe"), 1024],
    ["git/bin/bash.exe", join(res, "git", "bin", "bash.exe"), 1024],
    ["git/cmd/git.exe", join(res, "git", "cmd", "git.exe"), 1024],
    // 远端代码认知/评审运行时(自带 Node 20 + code-sense CLI;连接 WSL/SSH 时上传到目标)
    ["sense-remote.tar.gz", join(res, "sense-remote.tar.gz"), 10 * 1024 * 1024],
  ];
  const bad = [];
  for (const [name, p, minBytes] of items) {
    let ok = false;
    let detail = "missing";
    try {
      const st = statSync(p);
      ok = st.isFile() && st.size >= minBytes;
      detail = `${(st.size / 1024 / 1024).toFixed(1)}MB`;
    } catch {
      /* missing */
    }
    console.log(`[verify-artifact] ${ok ? "ok" : "MISSING"} ${name}${ok ? " " + detail : ""}`);
    if (!ok) bad.push(name);
  }
  // 目录级:tokenizer 配置、Chromium 资源。旧 torch 运行时/Python 不得随包。
  const dirItems = [
    ["runtime/model-150m/onnx/tokenizer_config.json", m("onnx", "tokenizer_config.json")],
    ["browsers/chrome-win64/resources", join(res, "browsers", "chrome-win64", "resources")],
    ["browsers/chrome-win64/chrome.dll", join(res, "browsers", "chrome-win64", "chrome.dll")],
  ];
  for (const [name, p] of dirItems) {
    const ok = existsSync(p);
    console.log(`[verify-artifact] ${ok ? "ok" : "MISSING"} ${name}`);
    if (!ok) bad.push(name);
  }
  for (const rel of ["runtime/python", "runtime/model-150m/jevlite.pt", "runtime/model-150m/ModernBERT-base", "runtime/model-150m/upstream"]) {
    const p = join(res, rel);
    if (existsSync(p)) {
      console.log(`[verify-artifact] STALE ${rel}(旧 torch 运行时残留,不应随包)`);
      bad.push(rel + "(stale)");
    }
  }
  if (bad.length) fail("全量运行时缺失/残留:" + bad.join(", "));
  console.log(`[verify-artifact] PASS full-runtime items=${items.length + dirItems.length}`);
}

const gwSize = readFileSync(gwFile).length;
const workerSize = readFileSync(workerFile).length;
console.log(`[verify-artifact] PASS files=${required.length + 1} gateway=${(gwSize / 1024 / 1024).toFixed(2)}MB worker=${(workerSize / 1024 / 1024).toFixed(2)}MB optional=${optRows.filter(([, ok]) => ok).length}/${optional.length}`);
