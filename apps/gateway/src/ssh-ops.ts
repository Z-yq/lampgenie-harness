/**
 * SSH 远程操作层(ZCode remote workspace 三层切片的 genie 化:
 * ZCode packages/server/src/remote/{sshAuth,connect}.ts 的 CLI-ssh 等价实现——
 * ZCode 用 ssh2 连接池化+keepalive,genie 零依赖走 sshpass+OpenSSH CLI,每操作一条
 * 命令+超时保护;连接池化/资产部署(ZCode deploy.ts 系)不在本切片,由节点体系承担)。
 * 凭证链复用 remote-project.ts resolveSshPassword(env→secrets 精确键→通用键);
 * 密码只进 SSHPASS env(不进 argv/日志,ps 不可见收窄)。
 * 面向三消费端:server 消息面(ssh.test/remote.ls/remote.read)、agent 工具
 * (remote_ls/remote_read/remote_exec,远程项目任务注入)、面板远程文件树。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSecretValue } from "@lampgenie/core";
import { repoRoot } from "./repo-root.js";
import { tryChannelJson, deployRemoteWorkspaceAgent } from "./remote-channel.js";
import type { RemoteProject, RemoteSshProject } from "./remote-project.js";
import { resolveSshPassword } from "./remote-project.js";
import { wslErrorHint } from "./wsl.js";

const execFileP = promisify(execFile);

export const REMOTE_OP_TIMEOUT_MS = 20_000;
/**
 * 连接复用(复查补:ZCode ssh2 池化+keepalive 的 CLI 等价)——OpenSSH
 * ControlMaster:auto+Persist 120s:首次建连走完整握手(密码认证),窗口内后续命令复用
 * 既有 master 通道(经验证冷连 ~7s → 复用毫秒级)。%C=hash(host,port,user) 防多主机串槽。
 */
// ctl 目录必须在原生文件系统:WSL 下 repoRoot 常在 /mnt/*(9p)——unix socket 无法在 9p 上
// 创建(经验证 unix_listener 报错);固定用 $HOME/.genie-ssh-ctl(ext4/tmpfs)。
const SSH_CTL_DIR = () => join(process.env.HOME ?? "/tmp", ".genie-ssh-ctl");
const SSH_MUX_OPTS = [
  "-o", "ControlMaster=auto",
  "-o", `ControlPath=${join(SSH_CTL_DIR(), "%C")}`,
  "-o", "ControlPersist=120",
] as const;
/** remote.read 上限(ZCode read 工具同量级:输出量封顶防大文件灌爆上下文)。 */
export const REMOTE_READ_MAX_BYTES = 256 * 1024;
/** remote.ls 条目上限(超大目录截断,如实标注)。 */
export const REMOTE_LS_MAX_ENTRIES = 500;

export interface SshRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** 失败归一文案(auth/网络/超时/命令非零)。 */
  error?: string;
}

/** 归一化 SSH 错误(ZCode sshAuth.normalizeSSHConnectError 同语义,CLI 形态)。 */
/** 错误归一(ZCode sshAuth.normalizeSSHConnectError 同语义,CLI 形态;导出供兜底复用)。 */
export function normalizeSshError(stderr: string): string {
  if (/permission denied|authentication failed|authentications that can continue/i.test(stderr))
    return "SSH 认证失败:检查用户名/密码(secrets 键 GENIE_SSH_<HOST>_<USER>)或密钥";
  if (/connection timed out|connection refused|could not resolve hostname|network is unreachable/i.test(stderr))
    return "SSH 连接失败:主机不可达(网络/防火墙/地址)";
  if (/host key verification failed/i.test(stderr)) return "SSH 主机指纹校验失败";
  return "SSH 执行失败";
}

/** 单次 SSH 执行(命令字符串在远端 shell 跑——调用方负责注入防护/白名单)。 */
/** sshRun 执行器注入(测试用;缺省真跑 sshpass+ssh)。 */
export type SshRunner = (remote: RemoteSshProject, command: string, opts: { password?: string; timeoutMs?: number }) => Promise<SshRunResult>;
const runnerRef: { current?: SshRunner } = {};
/** 测试注入:替换执行器(生产不调)。 */
export function setSshRunnerForTest(r: SshRunner | undefined): void {
  runnerRef.current = r;
}

/**
 * 私钥解析(复查补,ZCode sshAuth privateKey/passphrase 对齐):
 * secrets 键 GENIE_SSHKEY_<HOST>_<USER>(私钥全文)与 GENIE_SSHKEY_PASSPHRASE_<HOST>_<USER>(可选);
 * 优先级:显式密码 > secrets 密码 > secrets 私钥。私钥落临时文件(600,用后删)传 -i。
 */
export function resolveSshPrivateKey(p: RemoteSshProject, env: NodeJS.ProcessEnv = process.env): { key: string; passphrase?: string } | undefined {
  const suffix = `${p.host.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${p.username.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const key = readSecretValue(repoRoot(), `GENIE_SSHKEY_${suffix}`, env);
  if (!key) return undefined;
  const passphrase = readSecretValue(repoRoot(), `GENIE_SSHKEY_PASSPHRASE_${suffix}`, env);
  return { key, ...(passphrase ? { passphrase } : {}) };
}

export const sshRun: SshRunner = async (remote, command, opts) => {
  if (runnerRef.current) return runnerRef.current(remote, command, opts);
  const runOpts = { timeout: opts.timeoutMs ?? REMOTE_OP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 };
  try { mkdirSync(SSH_CTL_DIR(), { recursive: true }); } catch { /* ctl 目录失败=退化为直连 */ }
  // ── 私钥模式(ZCode privateKey/passphrase 语义)──
  const pk = opts.password ? undefined : resolveSshPrivateKey(remote);
  if (pk) {
    const keyFile = join(SSH_CTL_DIR(), `key-${remote.host}-${remote.port}-${remote.username}`);
    let keyArgs: string[];
    try {
      writeFileSync(keyFile, pk.key.endsWith("\n") ? pk.key : pk.key + "\n", { mode: 0o600 });
      keyArgs = ["-i", keyFile, "-o", "BatchMode=no", "-o", "IdentitiesOnly=yes"];
      if (pk.passphrase) keyArgs = keyArgs.concat(["-o", "Passphrase=" + pk.passphrase]);
    } catch {
      return { ok: false, stdout: "", stderr: "", error: "私钥临时文件写入失败(" + keyFile + ")" };
    }
    try {
      const r = await execFileP("ssh", [
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=8",
        ...SSH_MUX_OPTS,
        ...keyArgs,
        "-p", String(remote.port),
        `${remote.username}@${remote.host}`,
        command,
      ], runOpts) as { stdout: string; stderr: string };
      return { ok: true, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
      return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "", error: e.killed ? "SSH 执行超时" : normalizeSshError(e.stderr ?? e.message ?? "") };
    }
  }
  // ── 密码模式(sshpass;SSHPASS env 不进 argv)──
  const password = opts.password ?? resolveSshPassword(remote);
  if (!password) return { ok: false, stdout: "", stderr: "", error: "无 SSH 凭证(env GENIE_SSH_PASSWORD 或 secrets GENIE_SSH_<HOST>_<USER>/GENIE_SSHKEY_<HOST>_<USER>)" };
  try {
    const r = await execFileP("sshpass", [
      "-e", "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "BatchMode=no",
      "-o", "ConnectTimeout=8",
      "-o", "PreferredAuthentications=password,keyboard-interactive",
      "-o", "PubkeyAuthentication=no",
      ...SSH_MUX_OPTS,
      "-p", String(remote.port),
      `${remote.username}@${remote.host}`,
      command,
    ], { ...runOpts, env: { ...process.env, SSHPASS: password } });
    return { ok: true, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
      error: e.killed ? "SSH 执行超时" : normalizeSshError(e.stderr ?? e.message ?? ""),
    };
  }
}

/** 统一远端执行器(SSH/WSL 两形态;权限/凭证只对 SSH 有意义)。 */
export type RemoteRunner = (remote: RemoteProject, command: string, opts: { password?: string; timeoutMs?: number }) => Promise<SshRunResult>;

/** WSL 执行器注入(测试用;缺省真跑 wsl.exe)。 */
const wslRunnerRef: { current?: RemoteRunner } = {};
export function setWslRunnerForTest(r: RemoteRunner | undefined): void {
  wslRunnerRef.current = r;
}

/** WSL 命令形态(纯函数,单测锚定):命令字符串在发行版 bash -lc 里跑(与 SSH 命令同语义)。 */
export function wslCommandFor(distro: string, command: string): { cmd: string; args: string[] } {
  return { cmd: "wsl.exe", args: ["-d", distro, "--exec", "bash", "-lc", command] };
}

/** WSL 单次执行(`wsl.exe -d <distro> --exec bash -lc <command>`)。 */
export const wslRun: RemoteRunner = async (remote, command, opts) => {
  // 测试注入优先(单测跑在 Linux,仍要能验证分流与回退链)
  if (wslRunnerRef.current) return wslRunnerRef.current(remote, command, opts);
  // WSL 项目只在 Windows 宿主有意义(Linux 网关遇到 remote:wsl 直接失败,不借 interop 乱跑)
  if (process.platform !== "win32") return { ok: false, stdout: "", stderr: "", error: "WSL 项目只能在 Windows 桌面端执行" };
  if (remote.kind !== "wsl") return { ok: false, stdout: "", stderr: "", error: "非 WSL 项目" };
  const inv = wslCommandFor(remote.distro, command);
  try {
    const r = (await execFileP(inv.cmd, inv.args, {
      timeout: opts.timeoutMs ?? REMOTE_OP_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    })) as { stdout: string; stderr: string };
    return { ok: true, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
    const hint = wslErrorHint(err, remote.distro);
    const detail = String(e.stderr ?? e.message ?? "").trim();
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
      error: e.killed ? "WSL 执行超时" : hint ?? ("WSL 执行失败" + (detail ? ":" + detail.slice(0, 160) : "")),
    };
  }
};

/** 远端统一执行入口:WSL 项目走 wsl.exe;SSH 项目走 sshpass/ssh。 */
export const remoteRun: RemoteRunner = async (remote, command, opts) => {
  if (remote.kind === "wsl") return wslRun(remote, command, opts);
  return sshRun(remote as RemoteSshProject, command, opts);
};

/**
 * 远程写文件(复查补,remote_write 工具后端):内容 base64 经 stdin 传远端解码写入
 * (内容不进 argv);自动建父目录;写入后回读字节数校验。
 */
export async function remoteWrite(remote: RemoteProject, rel: string, content: string, opts: { password?: string } = {}): Promise<{ bytes: number } | { error: string }> {
  const file = remoteFencePath(remote, rel);
  if (!file) return { error: "路径非法(相对路径,禁止绝对路径与 ..)" };
  if (content.length > REMOTE_READ_MAX_BYTES) return { error: `内容超限(${content.length}B > ${REMOTE_READ_MAX_BYTES}B);大文件分段写或远端生成` };
  try {
    const ch = await tryChannelJson(remote, "fs.write", { path: rel, contentB64: Buffer.from(content, "utf-8").toString("base64") });
    if (ch && ch.ok) {
      const data = ch.data as { bytes: number };
      return { bytes: data.bytes ?? content.length };
    }
  } catch { /* 通道故障回退 */ }
  const b64 = Buffer.from(content, "utf-8").toString("base64");
  // stdin 传 base64 → 远端 base64 -d 写入;cat 限回读校验
  const probe = await remoteRunWithStdin(remote, `mkdir -p $(dirname ${shQuote(file)}) && base64 -d > ${shQuote(file)} && wc -c < ${shQuote(file)}`, b64, opts);
  if ("error" in probe) return probe;
  const bytes = Number((probe.stdout ?? "").trim());
  if (!Number.isFinite(bytes) || bytes < 0) return { error: "写入完成但回读校验失败(" + String(probe.stdout).slice(0, 60) + ")" };
  return { bytes };
}


/** remoteRun 的 stdin 变体(remoteWrite / 远端运行时 tar 上传用;SSH 密码/私钥/WSL 三形态)。 */
async function remoteRunWithStdin(remote: RemoteProject, command: string, stdin: string | Buffer, opts: { password?: string; timeoutMs?: number }): Promise<{ stdout: string } | { error: string }> {
  if (remote.kind === "wsl") {
    if (wslRunnerRef.current) {
      const r = await wslRunnerRef.current(remote, command, opts);
      return r.ok ? { stdout: r.stdout } : { error: r.error ?? "WSL 执行失败" };
    }
    const inv = wslCommandFor(remote.distro, command);
    const { spawn } = await import("node:child_process");
    return await new Promise<{ stdout: string } | { error: string }>((resolve) => {
      const child = spawn(inv.cmd, inv.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let out = "";
      let errText = "";
      const timer = setTimeout(() => { child.kill(); resolve({ error: "WSL 执行超时" }); }, opts.timeoutMs ?? REMOTE_OP_TIMEOUT_MS);
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); if (out.length > 4 * 1024 * 1024) child.kill(); });
      child.stderr.on("data", (d: Buffer) => { errText += d.toString(); });
      child.on("error", (e: Error) => { clearTimeout(timer); resolve({ error: wslErrorHint(e, remote.distro) ?? e.message }); });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout: out });
        else resolve({ error: wslErrorHint({ message: errText }) ?? ("WSL 写入失败:" + errText.trim().slice(0, 160)) });
      });
      child.stdin.write(stdin);
      child.stdin.end();
    });
  }
  if (runnerRef.current) {
    const r = await runnerRef.current(remote, command, opts);
    return r.ok ? { stdout: r.stdout } : { error: r.error ?? "SSH 执行失败" };
  }
  const ssh = remote as RemoteSshProject;
  try { mkdirSync(SSH_CTL_DIR(), { recursive: true }); } catch { /* ctl 目录失败=退化为直连 */ }
  const baseArgs = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "BatchMode=no",
    "-o", "ConnectTimeout=8",
    ...SSH_MUX_OPTS,
    "-p", String(ssh.port),
    `${ssh.username}@${ssh.host}`,
    command,
  ];
  const { spawn } = await import("node:child_process");
  return await new Promise<{ stdout: string } | { error: string }>((resolve) => {
    let cmd = "ssh";
    let args: string[] = baseArgs;
    let env: NodeJS.ProcessEnv = { ...process.env };
    const password = opts.password ?? resolveSshPassword(ssh);
    if (password) {
      cmd = "sshpass";
      args = ["-e", "ssh", "-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=password,keyboard-interactive", ...baseArgs];
      env = { ...env, SSHPASS: password };
    } else {
 // 私钥模式:stdin 不再把内容 base64 内联进命令(大 tar 必然超限),改用 -i 直连 + 管道
      const pk = resolveSshPrivateKey(ssh);
      if (!pk) { resolve({ error: "无 SSH 凭证" }); return; }
      const keyFile = join(SSH_CTL_DIR(), `key-${ssh.host}-${ssh.port}-${ssh.username}`);
      try {
        writeFileSync(keyFile, pk.key.endsWith("\n") ? pk.key : pk.key + "\n", { mode: 0o600 });
      } catch {
        resolve({ error: "私钥临时文件写入失败(" + keyFile + ")" }); return;
      }
      args = ["-i", keyFile, "-o", "IdentitiesOnly=yes", ...baseArgs];
    }
    const child = spawn(cmd, args, { env });
    let out = "";
    let errText = "";
    const timer = setTimeout(() => { child.kill(); resolve({ error: "SSH 执行超时" }); }, opts.timeoutMs ?? REMOTE_OP_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); if (out.length > 4 * 1024 * 1024) child.kill(); });
    child.stderr.on("data", (d: Buffer) => { errText += d.toString(); });
    child.on("error", (e: Error) => { clearTimeout(timer); resolve({ error: normalizeSshError(e.message) }); });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: out });
      else resolve({ error: normalizeSshError(errText) + (errText.trim() ? ":" + errText.trim().slice(0, 160) : "") });
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** shell 单引号转义(remote-project 同款;路径进命令前必经)。 */
export function shQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}

/** 远端路径围栏:相对 workspacePath 解析+上跳拒绝(本地 file-tools fencePath 同语义)。 */
export function remoteFencePath(remote: RemoteProject, rel: string): string | null {
  const p = String(rel ?? "").trim();
  if (!p || p.startsWith("/") || p.includes("..")) return null;
  // "." = 根;去首尾斜杠拼接
  const segs = p.split("/").filter((x) => x && x !== ".");
  return segs.length ? `${remote.workspacePath}/${segs.join("/")}` : remote.workspacePath;
}

export interface RemoteLsEntry { name: string; kind: "dir" | "file" }

/** 远程列目录(ls -1Ap:尾 / = 目录;截断如实标注)。 */
export async function remoteLs(remote: RemoteProject, rel: string, opts: { password?: string } = {}): Promise<{ entries: RemoteLsEntry[]; truncated: boolean } | { error: string }> {
  const dir = remoteFencePath(remote, rel || ".");
  if (!dir) return { error: "路径非法(相对路径,禁止绝对路径与 ..)" };
 // 三层:agent-stdio 通道(持久管道)→ shim → shell(远端工作区服务)
  try {
    const ch = await tryChannelJson(remote, "fs.list", { path: rel || "." });
    if (ch && ch.ok) {
      const data = ch.data as { entries: RemoteLsEntry[]; truncated?: boolean };
      return { entries: data.entries ?? [], truncated: !!data.truncated };
    }
  } catch { /* 通道故障回退 */ }
  // shim 优先(部署后):统一 JSON 输出;缺失/失败回退 shell 路径(零行为差)
  const viaShim = await remoteLsViaShim(remote, dir);
  if (viaShim) return viaShim;
  const r = await remoteRun(remote, `LC_ALL=C ls -1Ap ${shQuote(dir)} 2>/dev/null | head -n ${REMOTE_LS_MAX_ENTRIES + 1}`, opts);
  if (!r.ok) { const err = r.error || normalizeSshError(r.stderr); return { error: err + (r.stderr.trim() ? ":" + r.stderr.trim().slice(0, 120) : "") }; }
  const entries: RemoteLsEntry[] = [];
  for (const line of r.stdout.split("\n")) {
    const name = line.trimEnd();
    if (!name) continue;
    if (name.endsWith("/")) entries.push({ name: name.slice(0, -1), kind: "dir" });
    else entries.push({ name, kind: "file" });
  }
  const truncated = entries.length > REMOTE_LS_MAX_ENTRIES;
  return { entries: entries.slice(0, REMOTE_LS_MAX_ENTRIES), truncated };
}

/** 远程读文件(文本;超限截断;二进制启发=NUL 字节检测后拒读,本地 read_file 同语义)。 */
export async function remoteRead(remote: RemoteProject, rel: string, opts: { password?: string; maxBytes?: number } = {}): Promise<{ content: string; bytes: number; truncated: boolean; binary: boolean } | { error: string }> {
  const file = remoteFencePath(remote, rel);
  if (!file) return { error: "路径非法(相对路径,禁止绝对路径与 ..)" };
  try {
    const ch = await tryChannelJson(remote, "fs.read", { path: rel, max: opts.maxBytes ?? REMOTE_READ_MAX_BYTES });
    if (ch && ch.ok) {
      const data = ch.data as { base64: string; bytes: number; binary: boolean; truncated?: boolean };
      if (data.binary) return { content: "", bytes: data.bytes, truncated: !!data.truncated, binary: true };
      const text = Buffer.from(data.base64, "base64").toString("utf-8");
      return { content: text, bytes: data.bytes, truncated: !!data.truncated, binary: false };
    }
  } catch { /* 通道故障回退 */ }
  const max = opts.maxBytes ?? REMOTE_READ_MAX_BYTES;
  // head -c 限流;二进制判定在 JS 侧(NUL 探测)
  const r = await remoteRun(remote, `head -c ${max + 1} ${shQuote(file)} | base64 -w0`, opts);
  if (!r.ok) { const err = r.error || normalizeSshError(r.stderr); return { error: err + (r.stderr.trim() ? ":" + r.stderr.trim().slice(0, 120) : "") }; }
  let buf: Buffer;
  try {
    buf = Buffer.from(r.stdout.trim(), "base64");
  } catch {
    return { error: "远端读回内容解码失败" };
  }
  if (!buf.length) return { content: "", bytes: 0, truncated: false, binary: false };
  const probe = buf.subarray(0, Math.min(buf.length, 8000));
  if (probe.includes(0)) return { content: "", bytes: buf.length, truncated: buf.length > max, binary: true };
  return { content: buf.subarray(0, max).toString("utf-8"), bytes: buf.length, truncated: buf.length > max, binary: false };
}

/** 远程读原始字节(IDE 图片预览用;通道 base64 优先,shell base64 回退)。 */
export async function remoteReadBinary(remote: RemoteProject, rel: string, maxBytes = 16 * 1024 * 1024, opts: { password?: string } = {}): Promise<{ buf: Buffer; bytes: number; truncated: boolean } | { error: string }> {
  const file = remoteFencePath(remote, rel);
  if (!file) return { error: "路径非法(相对路径,禁止绝对路径与 ..)" };
  try {
    const ch = await tryChannelJson(remote, "fs.read", { path: rel, max: maxBytes });
    if (ch && ch.ok) {
      const data = ch.data as { base64: string; bytes: number; truncated?: boolean };
      const buf = Buffer.from(data.base64, "base64");
      return { buf, bytes: data.bytes ?? buf.length, truncated: !!data.truncated };
    }
  } catch { /* 通道故障回退 */ }
  const r = await remoteRun(remote, `head -c ${maxBytes} ${shQuote(file)} | base64 -w0`, opts);
  if (!r.ok) return { error: r.error ?? "远端读失败" };
  try {
    const buf = Buffer.from(r.stdout.trim(), "base64");
    return { buf, bytes: buf.length, truncated: false };
  } catch {
    return { error: "远端内容解码失败" };
  }
}

/** 远程执行命令(cwd=workspacePath;输出截断;调用方做权限闸门)。 */
export async function remoteExec(remote: RemoteProject, command: string, opts: { password?: string; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string; truncated: boolean } | { error: string }> {
  try {
    const ch = await tryChannelJson(remote, "exec", { cwd: ".", commandB64: Buffer.from(command, "utf-8").toString("base64"), timeout: opts.timeoutMs ?? 60_000 });
    if (ch && ch.ok) {
      const data = ch.data as { stdout: string; truncated?: boolean };
      return { stdout: data.stdout ?? "", stderr: "", truncated: !!data.truncated };
    }
  } catch { /* 通道故障回退 */ }
  const r = await remoteRun(remote, `cd ${shQuote(remote.workspacePath)} && (${command}) 2>&1 | head -c ${REMOTE_READ_MAX_BYTES + 1}`, { ...opts, timeoutMs: opts.timeoutMs ?? 60_000 });
  if (!r.ok) { const err = r.error || normalizeSshError(r.stderr); return { error: err + (r.stderr.trim() ? ":" + r.stderr.trim().slice(0, 120) : "") }; }
  const out = r.stdout;
  return { stdout: out.slice(0, REMOTE_READ_MAX_BYTES), stderr: "", truncated: out.length > REMOTE_READ_MAX_BYTES };
}

// ── 远端工作区服务(shim)优先通道(ZCode/VS Code remote 的 genie 形态)──
// 部署:SSH 上传 assets/remote-workspace-shim.mjs → ~/.genie/genie-ws.mjs + selftest 验证。
// 运行时:ls/read/write 优先走 shim(统一 JSON/远端引号收敛),shim 缺失自动回退纯 shell。
const SHIM_REMOTE_PATH = "$HOME/.genie/genie-ws.mjs";
/** 每主机 shim 可用性探测缓存(进程级;部署后失效)。 */
const shimCache = new Map<string, boolean>();
export function invalidateShimCache(hostKey?: string): void {
  if (hostKey) shimCache.delete(hostKey); else shimCache.clear();
}
const hostKeyOf = (r: RemoteProject) => r.kind === "wsl" ? "wsl:" + r.distro : "ssh:" + r.host + ":" + r.port + ":" + r.username;

async function shimAvailable(remote: RemoteProject): Promise<boolean> {
  const k = hostKeyOf(remote);
  const hit = shimCache.get(k);
  if (hit !== undefined) return hit;
  const r = await remoteRun(remote, `test -f ${SHIM_REMOTE_PATH} && echo yes || echo no`, {});
  const has = r.ok && r.stdout.trim() === "yes";
  shimCache.set(k, has);
  return has;
}

async function shimJson<T>(remote: RemoteProject, sub: string, opts: { password?: string } = {}): Promise<T | { error: string }> {
  const r = await remoteRun(remote, `node ${SHIM_REMOTE_PATH} ${sub}`, opts);
  if (!r.ok) return { error: r.error ?? "shim 调用失败" };
  try {
    const j = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as { ok?: boolean; error?: string } & T;
    if (!j.ok) return { error: j.error ?? "shim 返回失败" };
    return j as T;
  } catch {
    return { error: "shim 输出非 JSON" };
  }
}

/** 远端代码认知组件包路径:env > 打包态 gateway 同目录上级(resources/sense-remote.tar.gz) > 仓内 .stage。 */
export function senseRemoteTarPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const cands = [
    process.env.GENIE_SENSE_REMOTE_TAR,
    join(here, "..", "sense-remote.tar.gz"),
    join(repoRoot(), "apps", "desktop", ".stage", "sense-remote.tar.gz"),
  ].filter((x): x is string => typeof x === "string" && x.length > 0);
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

/**
 * 部署远端代码认知/评审运行时(连接过程中随 server 一起装):
 * tar.gz(自带 Node 20 + code-sense CLI + 依赖闭包)经 stdin 上传解包到 `~/.genie/genie-sense`,
 * 版本=tar sha256 前 16 位;已装同版本直接跳过。装好后 code_sense/code_review 经工作区服务在远端执行。
 */
export async function deployRemoteSense(remote: RemoteProject, opts: { password?: string } = {}): Promise<{ version: string } | { error: string }> {
  const tar = senseRemoteTarPath();
  if (!tar) return { error: "远端代码认知组件包缺失(sense-remote.tar.gz 未打包;开发态先跑 apps/desktop/scripts/stage-sense-remote.mjs)" };
  let buf: Buffer;
  try { buf = readFileSync(tar); } catch (e) { return { error: "读取组件包失败:" + String((e as Error).message ?? e).slice(0, 120) }; }
  const version = createHash("sha256").update(buf).digest("hex").slice(0, 16);
  const dir = "$HOME/.genie/genie-sense";
  // 随包 Node 是 linux-x64;其它架构(arm64 等)如实拒绝,不装一个跑不起来的运行时。
  const arch = await remoteRun(remote, "uname -m 2>/dev/null || echo unknown", { ...opts, timeoutMs: 15_000 });
  const mach = arch.ok ? arch.stdout.trim() : "";
  if (mach && mach !== "x86_64" && mach !== "amd64") {
    return { error: "远端代码认知组件当前只提供 linux-x64 构建(远端架构 " + mach + ");请在本机 x64 或改用 SSH 到 x64 主机" };
  }
  const cur = await remoteRun(remote, `cat ${dir}/.version 2>/dev/null || echo none`, { ...opts, timeoutMs: 20_000 });
  if (cur.ok && cur.stdout.trim() === version) return { version };
  const upload = await remoteRunWithStdin(
    remote,
    `mkdir -p ${dir} && rm -rf ${dir}/app ${dir}/node && tar -xzf - -C ${dir} && printf %s ${version} > ${dir}/.version`,
    buf,
    { ...opts, timeoutMs: 300_000 },
  );
  if ("error" in upload) return { error: "上传失败:" + String(upload.error).slice(0, 200) };
  const check = await remoteRun(remote, `${dir}/node ${dir}/app/cli.js --help >/dev/null 2>&1 && echo ok || echo fail`, { ...opts, timeoutMs: 90_000 });
  if (!check.ok || check.stdout.trim() !== "ok") return { error: "远端代码认知组件自检失败(" + String(check.error ?? check.stdout).slice(0, 160) + ")" };
  return { version };
}

/** 部署远端工作区服务(上传 shim + selftest 验证)。返回版本信息或错误。 */
export async function deployRemoteWorkspace(remote: RemoteProject, opts: { password?: string } = {}): Promise<{ version: number; node: string } | { error: string }> {
 // 打包态 repoRoot=数据根:先找 gateway 运行目录旁 assets/,再回退仓库 src/assets。
  const here = dirname(fileURLToPath(import.meta.url));
  const cands = [join(here, "assets", "remote-workspace-shim.mjs"), join(repoRoot(), "apps", "gateway", "src", "assets", "remote-workspace-shim.mjs")];
  const shimPath = cands.find((p) => existsSync(p)) ?? cands[cands.length - 1]!;
  let code: string;
  try {
    code = readFileSyncForDeploy(shimPath);
  } catch {
    return { error: "本地 shim 资产缺失(" + shimPath + ")" };
  }
  const b64 = Buffer.from(code, "utf-8").toString("base64");
  const upload = await remoteRun(remote, `mkdir -p $HOME/.genie && printf %s ${shQuote(b64)} | base64 -d > ${SHIM_REMOTE_PATH} && node ${SHIM_REMOTE_PATH} selftest`, opts);
  if (!upload.ok) return { error: "上传/自检失败:" + (upload.error ?? upload.stderr.slice(0, 160)) };
  let ver: { version?: number; node?: string } = {};
  try { ver = JSON.parse(upload.stdout.trim().split("\n").pop() ?? "{}"); } catch { /* 自检输出解析失败但命令成功:继续 */ }
  invalidateShimCache(hostKeyOf(remote));
  return { version: ver.version ?? 1, node: ver.node ?? "(unknown)" };
}

function readFileSyncForDeploy(p: string): string {
  // 延迟 require 保持顶部 import 列表稳定(esbuild bundle 顺序敏感)
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return readFileSync(p, "utf-8");
}

/**
 * shim 优先的 ls(部署后使用):输出形态与 shell 回退一致 {entries,truncated}。
 * 调用方:remoteLs 顶部探测(shim 可用→shim;否则原 shell 路径)。
 */
async function remoteLsViaShim(remote: RemoteProject, absDir: string): Promise<{ entries: RemoteLsEntry[]; truncated: boolean } | { error: string } | null> {
  if (!(await shimAvailable(remote))) return null;
  const r = await shimJson<{ entries: RemoteLsEntry[]; truncated?: boolean }>(remote, "ls " + shQuote(absDir));
  if ("error" in r) return null; // shim 失败回退 shell(部署版本/执行异常都不阻塞)
  return { entries: r.entries ?? [], truncated: !!r.truncated };
}

// ── 远程文件工具原语(远程项目任务"同名工具"套件的后端)──

/** 远程读(带行号窗口形态,对齐本地 read_file 契约):返回 {startLine,totalLines,content} 或错误。 */
export async function remoteReadWindow(remote: RemoteProject, rel: string, line?: number, limit?: number, maxLines = 2000): Promise<{ startLine: number; totalLines: number; content: string } | { error: string }> {
  const r = await remoteRead(remote, rel, { maxBytes: 1024 * 1024 });
  if ("error" in r) return { error: r.error };
  if (r.binary) return { error: "二进制文件,read_file 不解码:" + rel };
  const lines = r.content.split("\n");
  const total = lines.length;
  const target = Math.min(Math.max(1, line ?? 1), total);
  const start = Math.max(1, target - 20);
  const end = Math.min(total, limit ? start + limit - 1 : target + 20);
  return { startLine: start, totalLines: total, content: lines.slice(start - 1, end).join("\n") };
}

/** 远程整文件读(编辑/改写用):全文或错误。 */
export async function remoteReadFull(remote: RemoteProject, rel: string): Promise<{ content: string } | { error: string }> {
  const r = await remoteRead(remote, rel, { maxBytes: 1024 * 1024 });
  if ("error" in r) return { error: r.error };
  if (r.binary) return { error: "二进制文件:" + rel };
  return { content: r.content + (r.truncated ? "\n" : "") };
}

/** 远程精确字面替换(edit_file 语义):old 唯一匹配替换;返回替换次数。 */
export async function remoteEdit(remote: RemoteProject, rel: string, oldString: string, newString: string, replaceAll = false): Promise<{ replaced: number } | { error: string }> {
  const r = await remoteReadFull(remote, rel);
  if ("error" in r) return r;
  const content = r.content;
  const count = content.split(oldString).length - 1;
  if (count === 0) return { error: "old_string 在文件中无匹配:" + rel };
  if (count > 1 && !replaceAll) return { error: `old_string 匹配 ${count} 处(非唯一);扩大上下文或用 replace_all` };
  const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
  const w = await remoteWrite(remote, rel, next);
  if ("error" in w) return w;
  return { replaced: count };
}

/** 远程 glob(经 find:* 不跨目录,** 跨目录;按 mtime 新→旧排序,对齐本地 glob 契约)。 */
export async function remoteGlob(remote: RemoteProject, pattern: string, opts: { password?: string } = {}): Promise<{ files: string[] } | { error: string }> {
  if (pattern.includes("..")) return { error: "非法模式" };
  const base = remote.workspacePath.replace(/[$"\\`]/g, "");
  const pat = pattern.replace(/[$"\\`]/g, "");
  // ** → find 全树;-maxdepth 1 仅当前(纯 * 不含 /)
  const crossDir = pat.includes("**");
  const namePat = crossDir ? pat.replace(/\*\*/g, "*").replace(/\//g, "") || "*" : pat;
  const cmd = crossDir
    ? `find ${shQuote(base)} -name ${shQuote(namePat)} -type f 2>/dev/null | head -n 400`
    : `find ${shQuote(base)} -maxdepth 1 -name ${shQuote(namePat)} -type f 2>/dev/null | head -n 400`;
  const sortCmd = crossDir
    ? `| xargs -r stat -c "%Y@%n" 2>/dev/null | sort -rn | head -n 200 | cut -d@ -f2-`
    : `| xargs -r stat -c "%Y@%n" 2>/dev/null | sort -rn | head -n 200 | cut -d@ -f2-`;
  const r = await remoteRun(remote, cmd + sortCmd, opts);
  if (!r.ok) return { error: r.error ?? "find 失败" };
  const files = r.stdout.split("\n").filter(Boolean).map((f) => f.startsWith(base + "/") ? f.slice(base.length + 1) : f);
  return { files };
}

/** 远端 git(通道优先,回退 ssh git;供任务链 checkpoint/diffstat/review 基线远端化)。 */
export async function remoteGit(remote: RemoteProject, gitArgs: string[], opts: { password?: string } = {}): Promise<{ stdout: string; exit: number } | { error: string }> {
  try {
    const ch = await tryChannelJson(remote, "git", { gitArgs }, opts);
    if (ch && ch.ok) {
      const data = ch.data as { stdout: string; exit: number };
      return { stdout: data.stdout ?? "", exit: data.exit ?? 0 };
    }
  } catch { /* 回退 */ }
  const r = await remoteRun(remote, `cd ${shQuote(remote.workspacePath)} && git ${gitArgs.map((x) => shQuote(x)).join(" ")} 2>&1`, opts);
  if (!r.ok) return { error: r.error ?? "远端 git 失败" };
  return { stdout: r.stdout, exit: 0 };
}
