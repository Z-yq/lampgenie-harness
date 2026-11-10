/**
 * genie 远端工作区服务(ZCode 远端 agent runtime 的 genie 形态:
 * 部署到远端 ~/.genie/agent-stdio.mjs,网关经 SSH 复用通道拉起
 * `node agent-stdio.mjs --stdio <workspacePath>`,stdin/stdout JSON-Lines 全双工。
 * 一条持久管道承载该远程项目的全部 workspace 服务(fs/grep/exec/git),
 * 替代逐命令拼 shell(ZCode:远端 agent 持有 workspace runtime,UI 全功能走它)。
 * 协议:请求 {"id","op","args"} 单行;响应 {"id","ok","data"|"error"} 单行。
 * ops:ping / fs.list / fs.read / fs.write / fs.mkdir / fs.remove / fs.rename / fs.grep / exec / git.status
 * 自检:`node agent-stdio.mjs selftest`(不经管道,直接输出版本后退出)。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import * as readlineMod from "node:readline";
import { homedir } from "node:os";

const VERSION = 1;
const MAX_OUT = 512 * 1024;

/** node8 兼容 mkdir -p(10.12 前 mkdirSync 无 recursive;10.18.70 经验证 EEXIST 注意)。 */
function mkdirp(p: string): void {
  const segs = p.split(sep).filter(Boolean);
  let cur = p.startsWith("/") ? "/" : "";
  for (const s2 of segs) {
    cur += "/" + s2;
    try { mkdirSync(cur); } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "EEXIST") throw e;
      if (!statSync(cur).isDirectory()) throw new Error("路径被文件占用: " + cur);
    }
  }
}

function respond(id: string, payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ id, ...payload }) + "\n");
}
function fail(id: string, error: unknown): void {
  respond(id, { ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 400) });
}
/** workspace 围栏:路径必须落在 workspacePath 内(相对路径先解析;.. 与越界拒绝)。 */
function inside(wsPath: string, p: string): string | null {
  const abs = p.startsWith("/") ? p : resolve(wsPath, p);
  const norm = resolve(abs);
  const ws = resolve(wsPath);
  if (norm === ws || norm.startsWith(ws + sep)) return norm;
  return null;
}

function handle(wsPath: string, op: string, a: Record<string, unknown>): Record<string, unknown> {
  if (op === "ping") return { ok: true, data: { version: VERSION, node: process.version, workspace: wsPath, pid: process.pid } };
  if (op === "fs.list") {
    const dir = inside(wsPath, String(a.path ?? "."));
    if (!dir) throw new Error("路径越界");
    if (!existsSync(dir)) throw new Error("目录不存在");
    const limit = Number(a.limit ?? 500);
    const all = readdirSync(dir).sort();
    const entries = all.slice(0, limit).map((name) => {
      let kind = "file";
      try { kind = statSync(dir + sep + name).isDirectory() ? "dir" : "file"; } catch { /* 断链 */ }
      let size = 0;
      let mtime = 0;
      try { const st = statSync(dir + sep + name); size = st.size; mtime = st.mtimeMs; } catch { /* 忽略 */ }
      return { name, kind, size, mtime };
    });
    return { ok: true, data: { entries, truncated: all.length > limit } };
  }
  if (op === "fs.read") {
    const file = inside(wsPath, String(a.path ?? ""));
    if (!file) throw new Error("路径越界");
    if (!existsSync(file)) throw new Error("文件不存在");
 // 二进制/图片预览要能取 >512KB(IDE /ide/asset 走远程通道);普通文本调用方仍传小 max。
    const max = Math.min(Math.max(1, Number(a.max ?? MAX_OUT)), 24 * 1024 * 1024);
    const buf = readFileSync(file).subarray(0, max);
    return { ok: true, data: { base64: buf.toString("base64"), bytes: buf.length, binary: buf.subarray(0, 8000).includes(0), truncated: statSync(file).size > max } };
  }
  if (op === "fs.write") {
    const file = inside(wsPath, String(a.path ?? ""));
    if (!file) throw new Error("路径越界");
    const data = Buffer.from(String(a.contentB64 ?? ""), "base64");
    if (data.length > MAX_OUT) throw new Error("内容超限(>512KB)");
    mkdirp(dirname(file));
    writeFileSync(file, data);
    return { ok: true, data: { bytes: statSync(file).size } };
  }
  if (op === "fs.mkdir") {
    const dir = inside(wsPath, String(a.path ?? ""));
    if (!dir) throw new Error("路径越界");
    mkdirp(dir);
    return { ok: true, data: {} };
  }
  if (op === "fs.remove") {
    const t = inside(wsPath, String(a.path ?? ""));
    if (!t || t === resolve(wsPath)) throw new Error("路径越界(根不可删)");
    rmSync(t, { recursive: true, force: true });
    return { ok: true, data: {} };
  }
  if (op === "fs.rename") {
    const from = inside(wsPath, String(a.from ?? ""));
    const to = inside(wsPath, String(a.to ?? ""));
    if (!from || !to) throw new Error("路径越界");
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    return { ok: true, data: {} };
  }
  if (op === "fs.grep") {
    const dir = inside(wsPath, String(a.dir ?? "."));
    if (!dir) throw new Error("路径越界");
    const pattern = String(a.pattern ?? "");
    if (!pattern) throw new Error("缺模式");
    // 与本地 fs.grep 同语义:默认字面串(不区分大小写),regex=true 才按正则。
    const regex = a.regex === true;
    const limit = Math.min(Math.max(1, Number(a.limit ?? 200)), 2000);
    const pat = regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const args = ["-rn", "-I", ...(regex ? [] : ["-i"]), pat, dir];
    const r = spawnSync("grep", args, { encoding: "utf-8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    const raw = (r.stdout ?? "").split("\n").filter(Boolean);
    const lines = raw.slice(0, limit);
    // 去掉 workspace 前缀,回相对路径(与本地 fs.grep 形态对齐)
    const matches = lines.map((l) => l.startsWith(dir) ? l.slice(dir.length + 1) : l);
    return { ok: true, data: { matches, truncated: raw.length > limit || (r.stdout ?? "").length > MAX_OUT } };
  }
  if (op === "exec") {
    const cwd = inside(wsPath, String(a.cwd ?? "."));
    if (!cwd) throw new Error("cwd 越界");
    const command = Buffer.from(String(a.commandB64 ?? ""), "base64").toString("utf-8");
    const r = spawnSync("bash", ["-lc", command], { cwd, encoding: "utf-8", timeout: Number(a.timeout ?? 120_000), maxBuffer: 8 * 1024 * 1024 });
    const out = ((r.stdout ?? "") + (r.stderr ?? "")).slice(0, MAX_OUT);
    return { ok: true, data: { stdout: out, exit: r.status ?? -1, truncated: ((r.stdout ?? "") + (r.stderr ?? "")).length > MAX_OUT } };
  }
 // 远端代码认知/评审(ZCode Source Server 形态):连接时随包安装到
  // ~/.genie/genie-sense(自带 Node 20 + code-sense CLI),这里在远端执行——桌面端只发 argv,
  // 不再逐次 wsl.exe / ssh 拼命令。输出上限 256KB(评审 --json 可能较大)。
  if (op === "sense" || op === "review") {
    const argv = Array.isArray(a.argv) ? a.argv.map(String).filter((x) => x.length > 0) : [];
    if (op === "sense" && argv.length === 0) throw new Error("缺 argv(action 参数)");
    const senseDir = process.env.GENIE_SENSE_DIR || join(homedir(), ".genie", "genie-sense");
    const nodeBin = join(senseDir, "node");
    const cli = join(senseDir, "app", "cli.js");
    if (!existsSync(nodeBin) || !existsSync(cli)) {
      throw new Error("远端代码认知组件未安装(重新连接项目/「优化远程连接」会安装到 ~/.genie/genie-sense)");
    }
    const args = op === "review" ? ["review", ...argv, "--json"] : argv;
    const timeout = Number(a.timeout ?? 300_000);
    const r = spawnSync(nodeBin, [cli, ...args], { cwd: wsPath, encoding: "utf-8", timeout, maxBuffer: 32 * 1024 * 1024 });
    const stdout = String(r.stdout ?? "");
    const stderr = String(r.stderr ?? "");
    const timedOut = r.error && (r.error as { code?: string }).code === "ETIMEDOUT";
    if (timedOut) return { ok: false, error: "代码认知执行超时(" + Math.round(timeout / 1000) + "s;大仓首次建索引较慢,可重试或先用 CLI)" };
    return {
      ok: true,
      data: {
        stdout: stdout.slice(0, 256 * 1024),
        stderr: stderr.slice(0, 8 * 1024),
        exit: r.status ?? -1,
        truncated: stdout.length > 256 * 1024,
      },
    };
  }
  if (op === "git") {
 // 通用 git(远端化:checkpoint/diffstat/review 基线等任务链 git 消费)
    const gitArgs = (a.gitArgs ?? []) as string[];
    if (!Array.isArray(gitArgs) || gitArgs.some((x) => typeof x !== "string")) throw new Error("gitArgs 须为字符串数组");
    const r = spawnSync("git", gitArgs, { cwd: wsPath, encoding: "utf-8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, data: { stdout: (r.stdout ?? "").slice(0, MAX_OUT), exit: r.status ?? -1 } };
  }
  if (op === "git.status") {
    const r = spawnSync("git", ["status", "--porcelain", "-b"], { cwd: wsPath, encoding: "utf-8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    return { ok: true, data: { text: (r.stdout ?? "").slice(0, MAX_OUT), exit: r.status ?? -1 } };
  }
  throw new Error("未知 op: " + op);
}

const args = process.argv.slice(2);
if (args[0] === "selftest") {
  process.stdout.write(JSON.stringify({ ok: true, version: VERSION, node: process.version }) + "\n");
  process.exit(0);
}
const wsRoot = resolve(args[0] ?? process.cwd());
if (!statSync(wsRoot, { throwIfNoEntry: false })?.isDirectory()) {
  process.stderr.write("workspace 目录不存在: " + wsRoot + "\n");
  process.exit(1);
}

const rl = readlineMod.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line: string) => {
  const t = line.trim();
  if (!t) return;
  let id = "";
  try {
    const req = JSON.parse(t) as { id?: string; op?: string; args?: Record<string, unknown> };
    id = String(req.id ?? "");
    const data = handle(wsRoot, String(req.op ?? ""), req.args ?? {});
    respond(id, data);
  } catch (e) {
    fail(id, e);
  }
});
rl.on("close", () => process.exit(0));
