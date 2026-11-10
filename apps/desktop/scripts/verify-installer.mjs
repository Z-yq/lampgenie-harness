#!/usr/bin/env node
/**
 * 安装包内容对账门(pkg-s4, 2026-11-08)。
 *
 * 背景(实测事故):electron-builder 的 NSIS 打包在 win-unpacked 里有文件被占用/扫描锁定时,
 * 7za 会**静默跳过**该文件继续出包;0.0.8/0.0.9 都因此把 chrome_elf.dll / vulkan-1.dll /
 * D3DCompiler_47.dll / onnxruntime.dll 漏在安装包外,首次启动才被壳的运行时自检拦下。
 * 这里在打包后直接解出安装包内嵌的 app 7z,与 dist/win-unpacked 逐文件对账:
 *   - 缺文件 → 非零退出并点名(必须重新打包,且先关掉占用产物的进程);
 *   - 多出文件 → 只提示(通常是上一次构建残留,不阻塞)。
 *
 * 用法:node scripts/verify-installer.mjs [--exe <path>] [--dir dist/win-unpacked] [--json]
 * 默认取 dist/LampGenie Setup <package.version>.exe。
 */
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const args = process.argv.slice(2);
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const asJson = args.includes("--json");

const pkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf-8"));
const exePath = resolve(desktopDir, argOf("--exe") || join("dist", `LampGenie Setup ${pkg.version}.exe`));
const unpackedDir = resolve(desktopDir, argOf("--dir") || join("dist", "win-unpacked"));
if (!existsSync(exePath)) fail(`找不到安装包 ${exePath}`);
if (!existsSync(unpackedDir)) fail(`找不到 ${unpackedDir}`);

const SEVEN_Z = find7z();
const tmp = mkdtempSync(join(tmpdir(), "verify-installer-"));
try {
  const payload = extractPayload(exePath, join(tmp, "payload.7z"));
  if (!payload) fail("安装包里找不到内嵌 7z 载荷(签名 7z\\xBC\\xAF\\x27\\x1C)");
  const packed = listArchive(SEVEN_Z, payload);
  const expected = walkFiles(unpackedDir);
  const packedSet = new Set(packed.map((p) => p.toLowerCase()));
  const expectedSet = new Set(expected.map((p) => p.toLowerCase()));
  const missing = expected.filter((p) => !packedSet.has(p.toLowerCase()));
  const unexpected = packed.filter((p) => !expectedSet.has(p.toLowerCase()));
  const result = {
    exe: exePath,
    unpacked: unpackedDir,
    payloadBytes: statSync(payload).size,
    expectedFiles: expected.length,
    packedFiles: packed.length,
    missing,
    unexpected,
  };
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[verify-installer] exe=${relative(desktopDir, exePath)} payload=${(result.payloadBytes / 1048576).toFixed(1)}MB packed=${packed.length} unpacked=${expected.length}`);
    if (unexpected.length) console.log(`[verify-installer] 提示:包内多出 ${unexpected.length} 个不在 win-unpacked 的条目(残留),不阻塞`);
  }
  if (missing.length) {
    console.error(`[verify-installer] FAIL 安装包缺少 ${missing.length} 个文件(打包时被占用/跳过?先关掉 LampGenie/Chrome/模型服务再重打):`);
    for (const m of missing.slice(0, 20)) console.error("  - " + m);
    if (missing.length > 20) console.error(`  … 其余 ${missing.length - 20} 个`);
    process.exitCode = 1;
  } else {
    console.log("[verify-installer] PASS 安装包内容与 win-unpacked 逐文件一致");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function fail(msg) {
  console.error("[verify-installer] FAIL " + msg);
  process.exit(1);
}

function find7z() {
  for (const cmd of ["7z", "7za"]) {
    const r = spawnSync(cmd, ["i"], { stdio: "ignore" });
    if (!r.error && r.status === 0) return cmd;
  }
  // electron-builder 缓存里的 7za(离线/精简系统兜底)
  const cache = join(process.env.HOME || "", ".cache", "electron-builder");
  if (existsSync(cache)) {
    for (const d of readdirSync(cache)) {
      if (!d.startsWith("7zip")) continue;
      const base = join(cache, d);
      for (const sub of readdirSync(base)) {
        const p = join(base, sub, "bin", "7za");
        if (existsSync(p)) return p;
      }
    }
  }
  fail("找不到 7z/7za(需要能解 7z 的二进制;安装 p7zip 或确认 electron-builder 缓存存在)");
}

/** 扫描 exe 找 7z 魔数,把从该偏移到文件尾的切片写成 payload.7z。 */
function extractPayload(exe, out) {
  const SIG = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
  const size = statSync(exe).size;
  const chunk = 4 * 1024 * 1024;
  const fd = openSync(exe, "r");
  let offset = 0;
  let carry = Buffer.alloc(0);
  let found = -1;
  try {
    while (offset < size) {
      const buf = Buffer.alloc(chunk);
      const n = readSync(fd, buf, 0, chunk, offset);
      if (n <= 0) break;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const i = data.indexOf(SIG);
      if (i >= 0) { found = offset - carry.length + i; break; }
      carry = data.subarray(Math.max(0, data.length - SIG.length + 1));
      offset += n;
    }
  } finally {
    closeSync(fd);
  }
  if (found < 0) return null;
  // 拷贝切片(同步流式,避免 700MB 一次性进内存)
  const r = spawnSync("/bin/sh", ["-c", `tail -c +${found + 1} ${shellQuote(exe)} > ${shellQuote(out)}`], { stdio: "ignore" });
  if (r.error || r.status !== 0 || !existsSync(out)) return null;
  return out;
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function listArchive(sevenZ, file) {
  const r = spawnSync(sevenZ, ["l", "-slt", file], { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 });
  if (r.error || (r.status !== 0 && !r.stdout)) fail(`7z 列举失败:${r.error || r.stderr}`);
  const out = [];
  let cur = null;
  for (const line of String(r.stdout).split(/\r?\n/)) {
    if (line.startsWith("Path = ")) cur = { path: line.slice(7), folder: false };
    else if (line.startsWith("Folder = ")) { if (cur) cur.folder = line.slice(9).trim() === "+"; }
    else if (line.startsWith("Attributes = ") && cur) {
      // 7z 不写 Folder 时以 Attributes 里的 D 判定
      if (/^D/.test(line.slice(13))) cur.folder = true;
    } else if (line === "" && cur) {
      if (!cur.folder && cur.path) out.push(cur.path);
      cur = null;
    }
  }
  return out;
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) stack.push(abs);
      else if (ent.isFile()) out.push(relative(root, abs).split("\\").join("/"));
    }
  }
  return out.sort();
}