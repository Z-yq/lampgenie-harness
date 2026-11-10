const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, dirname } = require("node:path");

const { fullRuntimeEnv } = require("../gateway-process");
const { fullRuntimeChecklist } = require("../paths");

function touch(file, body = "x") {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function makeResources() {
  const root = mkdtempSync(join(tmpdir(), "gh-full-"));
  const m = (...p) => join(root, "runtime", "model-150m", ...p);
  touch(m("server.mjs"));
  touch(m("onnx", "config.json"));
  touch(m("onnx", "tokenizer.json"));
  touch(m("onnx", "model.onnx"));
  touch(m("onnx", "model.onnx.data"));
  touch(join(root, "browsers", "chrome-win64", "chrome.exe"));
  touch(join(root, "git", "bin", "bash.exe"));
  touch(join(root, "sense-remote.tar.gz"));
  return root;
}

test("fullRuntimeEnv: 组件齐全时注入模型/ONNX/Chromium/bash 的绝对路径", () => {
  const root = makeResources();
  try {
    const env = fullRuntimeEnv(root);
    assert.equal(env.GENIE_MODEL_150M_DIR, join(root, "runtime", "model-150m"));
    assert.equal(env.GENIE_MODEL_150M_ONNX_DIR, join(root, "runtime", "model-150m", "onnx"));
    assert.equal(env.CHROME_PATH, join(root, "browsers", "chrome-win64", "chrome.exe"));
    assert.equal(env.GENIE_SHELL_BIN, join(root, "git", "bin", "bash.exe"));
    assert.equal(env.GENIE_SENSE_REMOTE_TAR, join(root, "sense-remote.tar.gz"));
    // 不再注入 Python/torch 时代的变量
    assert.equal(env.GENIE_MODEL_150M_REPO, undefined);
    assert.equal(env.MODEL_ENCODER, undefined);
    // PATH 必须前置随包 git 的三个目录(git.exe / bash / coreutils);键名沿用宿主的 Path/PATH
    const pathVal = env.PATH || env.Path;
    assert.ok(pathVal, "缺少 PATH/Path");
    const seg = pathVal.split(";");
    assert.equal(seg[0], join(root, "git", "cmd"));
    assert.equal(seg[1], join(root, "git", "bin"));
    assert.equal(seg[2], join(root, "git", "mingw64", "bin"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullRuntimeEnv: 缺 server.mjs 或 onnx 时整体不注入(dev 态零副作用)", () => {
  const root = mkdtempSync(join(tmpdir(), "gh-partial-"));
  try {
    touch(join(root, "runtime", "model-150m", "onnx", "config.json"));
    assert.deepEqual(fullRuntimeEnv(root), {});
    assert.deepEqual(fullRuntimeEnv(null), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullRuntimeChecklist: ONNX 全量组件缺一即点名,齐全则无 missing", () => {
  const root = makeResources();
  const m = (...p) => join(root, "runtime", "model-150m", ...p);
  try {
    touch(m("lib", "encode.mjs"));
    touch(m("lib", "ort-engine.mjs"));
    touch(m("node_modules", "onnxruntime-node", "bin", "napi-v6", "win32", "x64", "onnxruntime.dll"));
    touch(m("node_modules", "@huggingface", "tokenizers", "package.json"));
    touch(join(root, "git", "cmd", "git.exe"));
    const all = fullRuntimeChecklist(root);
    assert.equal(all.filter((i) => i.missing).length, 0);

    rmSync(join(root, "browsers", "chrome-win64", "chrome.exe"));
    const missing = fullRuntimeChecklist(root).filter((i) => i.missing).map((i) => i.name);
    assert.deepEqual(missing, ["browsers/chrome-win64/chrome.exe"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("运行时缺失默认降级不阻断(360 等杀软会持续隔离 DLL);严格模式可 opt-in", () => {
  const root = makeResources();
  try {
    // 组件缺失属于「功能降级」:任何一项都不是启动硬门槛。
    assert.ok(fullRuntimeChecklist(root).every((i) => i.required === false));
    const src = readFileSync(join(__dirname, "..", "main.js"), "utf8");
    assert.ok(src.includes("GENIE_REQUIRE_FULL_RUNTIME"), "严格模式开关丢失");
    assert.ok(src.includes("DEGRADED_TITLE"), "降级标题丢失");
    assert.ok(src.includes("功能降级"), "降级文案丢失");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});