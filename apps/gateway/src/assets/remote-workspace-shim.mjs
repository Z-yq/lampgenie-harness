#!/usr/bin/env node
/**
 * genie 远端工作区服务(ZCode/VS Code remote 的 genie 形态):
 * 部署到远端 ~/.genie/genie-ws.mjs,由本地网关经 SSH 复用通道逐命令调用。
 * 与"直接拼 shell"相比:统一 JSON 输出/错误码、路径与引号处理收敛在远端、grep/tree 等
 * 复合操作一次往返。自检:node genie-ws.mjs selftest。
 * 用法(全部输出单行 JSON,失败 {ok:false,error}):
 *   node genie-ws.mjs ls <absDir> [--limit N]
 *   node genie-ws.mjs read <absFile> [--max N]        (base64 内容)
 *   node genie-ws.mjs write <absFile> <b64Content>    (mkdir -p 父目录 + 回读字节数)
 *   node genie-ws.mjs exec <cwd> <b64Command>         (bash -lc,输出截断)
 *   node genie-ws.mjs grep <absDir> <pattern> [--limit N]
 *   node genie-ws.mjs selftest
 */
import { existsSync, mkdirSync, readFileSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const MAX_OUT = 256 * 1024;

function ok(obj) { process.stdout.write(JSON.stringify({ ok: true, ...obj }) + "\n"); }
function fail(error) { process.stdout.write(JSON.stringify({ ok: false, error: String(error).slice(0, 300) }) + "\n"); process.exit(0); }

function argNum(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

const cmd = process.argv[2];
try {
  if (cmd === "selftest") {
    ok({ version: 1, node: process.version, cwd: process.cwd() });
  } else if (cmd === "ls") {
    const dir = process.argv[3];
    if (!dir) fail("缺目录参数");
    if (!existsSync(dir)) fail("目录不存在");
    const limit = argNum("--limit", 500);
    const all = readdirSync(dir).sort();
    const entries = all.slice(0, limit).map((name) => {
      let kind = "file";
      try { kind = statSync(dir + "/" + name).isDirectory() ? "dir" : "file"; } catch { /* 断链=文件 */ }
      return { name, kind };
    });
    ok({ entries, truncated: all.length > limit });
  } else if (cmd === "read") {
    const file = process.argv[3];
    if (!file) fail("缺路径参数");
    if (!existsSync(file)) fail("文件不存在");
    const max = argNum("--max", MAX_OUT);
    const buf = readFileSync(file).subarray(0, max);
    ok({ base64: buf.toString("base64"), bytes: buf.length, binary: buf.subarray(0, 8000).includes(0) });
  } else if (cmd === "write") {
    const file = process.argv[3];
    const b64 = process.argv[4];
    if (!file || b64 === undefined) fail("缺路径或内容");
    const data = Buffer.from(b64, "base64");
    if (data.length > MAX_OUT) fail("内容超限");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    ok({ bytes: statSync(file).size });
  } else if (cmd === "exec") {
    const cwd = process.argv[3];
    const b64 = process.argv[4];
    if (!cwd || b64 === undefined) fail("缺 cwd 或命令");
    const command = Buffer.from(b64, "base64").toString("utf-8");
    const r = spawnSync("bash", ["-lc", command], { cwd, encoding: "utf-8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    const out = ((r.stdout ?? "") + (r.stderr ?? "")).slice(0, MAX_OUT);
    ok({ stdout: out, truncated: ((r.stdout ?? "") + (r.stderr ?? "")).length > MAX_OUT, exit: r.status ?? -1 });
  } else if (cmd === "grep") {
    const dir = process.argv[3];
    const pattern = process.argv[4];
    if (!dir || !pattern) fail("缺目录或模式");
    const r = spawnSync("grep", ["-rn", "--include=*", "-I", pattern, dir], { encoding: "utf-8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const out = (r.stdout ?? "").slice(0, MAX_OUT);
    ok({ matches: out.split("\n").filter(Boolean), truncated: (r.stdout ?? "").length > MAX_OUT });
  } else {
    fail("未知子命令: " + String(cmd ?? ""));
  }
} catch (e) {
  fail(e && e.message ? e.message : e);
}