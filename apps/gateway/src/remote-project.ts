/**
 * 远程项目身份层(ZCode packages/shared/src/remote-workspace-identity.ts 形态移植):
 * 项目=workspace,远程目录用 identity 表示——构造与解析必须复用本模块,禁止业务代码手写拼接/拆解。
 * 格式契约(与 ZCode 对齐的子集,一期只做 ssh):
 *   remote:ssh:<host>:<port>:<username>:<posixPath>
 * path 段归一(分隔符→"/",去收尾斜杠,空→"/")后恒以 "/" 开头;authority 各段不含 "/" 与 ":"
 * (host 小写;port 数字;username 合法字符集不含 ":" 与 "/")。path 段可能含 ":",解析逐段消费
 * authority 后取剩余整段,不整体 split(ZCode 同法)。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readSecretValue } from "@lampgenie/core";
import { repoRoot } from "./repo-root.js";
import { parseWslPath } from "./wsl.js";

const execFileP = promisify(execFile);

export const REMOTE_PROJECT_PREFIX = "remote:";

export interface RemoteSshProject {
  kind: "ssh";
  host: string;
  port: number;
  username: string;
  /** 远端真实路径(posix 归一形态,以 "/" 开头)。 */
  workspacePath: string;
  /** 归一化 identity(去重键)。 */
  identity: string;
}

export interface RemoteWslProject {
  kind: "wsl";
  /** WSL 发行版名(如 Ubuntu / Ubuntu-22.04;不含 ":"、"/")。 */
  distro: string;
  /** 发行版内 POSIX 路径(以 "/" 开头)。 */
  workspacePath: string;
  identity: string;
}

/** 远程项目(SSH / WSL 两形态;两者共用同一套远端工作区服务与工具面)。 */
export type RemoteProject = RemoteSshProject | RemoteWslProject;

function normalizeRemotePath(p: string): string {
  const normalized = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  return `/${trimmed}`;
}

/** POSIX 单引号转义(wsl.exe --exec sh -lc 用)。 */
function posixQuote(s: string): string {
  return `'` + String(s).replace(/'/g, `'\\''`) + `'`;
}

export function buildRemoteSshIdentity(host: string, port: number, username: string, workspacePath: string): string {
  return `remote:ssh:${host.trim().toLowerCase()}:${port}:${username.trim()}:${normalizeRemotePath(workspacePath)}`;
}

/** WSL 项目 identity:remote:wsl:<distro>:<posixPath>(与 SSH 同构的远端工作区)。 */
export function buildRemoteWslIdentity(distro: string, workspacePath: string): string {
  const d = String(distro ?? "").trim();
  if (!d || /[:/\\]/.test(d)) throw new Error("非法 WSL 发行版名:" + d);
  return `remote:wsl:${d}:${normalizeRemotePath(workspacePath)}`;
}

/** 解析 remote:wsl identity;非法/非 WSL 返回 null。 */
export function parseRemoteWslProject(path: string): RemoteWslProject | null {
  if (!path.startsWith("remote:wsl:")) return null;
  const rest = path.slice("remote:wsl:".length);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  const distro = rest.slice(0, i);
  const workspacePath = rest.slice(i + 1);
  if (!distro || /[:/\\]/.test(distro)) return null;
  if (!workspacePath.startsWith("/")) return null;
  return { kind: "wsl", distro, workspacePath: normalizeRemotePath(workspacePath), identity: buildRemoteWslIdentity(distro, workspacePath) };
}

/** 统一解析(SSH/WSL);非法/本地路径返回 null(调用方回落本地语义)。 */
export function parseRemoteProject(path: string): RemoteProject | null {
  return parseRemoteSshProject(path) ?? parseRemoteWslProject(path);
}

/** WSL UNC 路径(\wsl.localhost\<distro>\<posix> / \\wsl$\...)→ WSL 远程项目身份。
 *  用于「添加项目」时把目录选择器选中的 UNC 路径自动登记成远端工作区(不再当本地路径用)。 */
export function remoteWslFromUncPath(p: string): RemoteWslProject | null {
  const loc = parseWslPath(p);
  if (!loc) return null;
  try {
    return parseRemoteWslProject(buildRemoteWslIdentity(loc.distro, loc.posix));
  } catch {
    return null;
  }
}

/** 解析 remote:ssh identity;非法/非远程返回 null(调用方回落本地语义)。 */
export function parseRemoteSshProject(path: string): RemoteSshProject | null {
  if (!path.startsWith(REMOTE_PROJECT_PREFIX)) return null;
  const rest = path.slice(REMOTE_PROJECT_PREFIX.length);
  if (!rest.startsWith("ssh:")) return null;
  // authority 三段:host/port/username;逐段消费(path 段可能含 ":")。
  let cursor = "ssh:".length;
  const segs: string[] = [];
  for (let i = 0; i < 3; i++) {
    const next = rest.indexOf(":", cursor);
    if (next <= cursor) return null;
    segs.push(rest.slice(cursor, next));
    cursor = next + 1;
  }
  const [host, portRaw, username] = segs as [string, string, string];
  if (!host || !username) return null;
  if (!/^\d+$/.test(portRaw ?? "")) return null;
  const port = Number(portRaw);
  if (port < 1 || port > 65535) return null;
  const workspacePath = rest.slice(cursor);
  if (!workspacePath.startsWith("/")) return null;
  return { kind: "ssh", host: host.toLowerCase(), port, username, workspacePath, identity: buildRemoteSshIdentity(host, port, username, workspacePath) };
}

/** 面板显示名:host:尾段路径(ZCode 虚拟项目同风格)。 */
export function remoteProjectLabel(p: RemoteProject): string {
  const tail = p.workspacePath.split("/").filter(Boolean).pop() ?? p.workspacePath;
  return p.kind === "wsl" ? `WSL:${p.distro}:${tail}` : `${p.host}:${tail}`;
}

export interface SshProbeOptions {
  /** 密码(经 env 注入 sshpass;不进命令行参数——ps 可见面收窄)。 */
  password?: string;
  timeoutMs?: number;
  /** 测试注入;缺省真跑 sshpass+ssh。 */
  exec?: (cmd: string, args: string[], opts: { timeout: number; env?: Record<string, string> }) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * SSH 可用性探测:sshpass -e ssh 远端 `test -d <path>`。
 * 凭证红线:密码只进 SSHPASS env(不出现在 argv/输出);无 sshpass/无密码=unverified,不抛错。
 */
/**
 * SSH 密码解析链:显式注入(测试)→ env GENIE_SSH_PASSWORD →
 * secrets 按服务器精确键 GENIE_SSH_<HOST>_<USER>(点转下划线大写,.genie/secrets.json,
 * 凭证红线:不入库不进 argv)→ secrets 通用键 GENIE_SSH_PASSWORD 兜底(单服务器部署)。
 */
export function resolveSshPassword(p: RemoteSshProject, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.GENIE_SSH_PASSWORD) return env.GENIE_SSH_PASSWORD;
  const hostKey = `GENIE_SSH_${p.host.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${p.username.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  return readSecretValue(repoRoot(), hostKey, env) ?? readSecretValue(repoRoot(), "GENIE_SSH_PASSWORD", env);
}

export async function probeRemoteSsh(p: RemoteSshProject, opts: SshProbeOptions = {}): Promise<boolean> {
  const password = opts.password ?? resolveSshPassword(p);
  if (!password || !(await hasSshpass(opts))) return false;
  const run = opts.exec ?? ((cmd, args, o) => execFileP(cmd, args, o) as Promise<{ stdout: string; stderr: string }>);
  try {
    await run("sshpass", [
      "-e", "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "BatchMode=no",
      "-o", "ConnectTimeout=8",
      "-o", "PreferredAuthentications=password,keyboard-interactive",
      "-o", "PubkeyAuthentication=no",
      "-p", String(p.port),
      `${p.username}@${p.host}`,
      `test -d ${shSingleQuoted(p.workspacePath)}`,
    ], { timeout: opts.timeoutMs ?? 20_000, env: { ...process.env, SSHPASS: password } });
    return true;
  } catch {
    return false;
  }
}

function shSingleQuoted(s: string): string {
  return posixQuote(s);
}

/** WSL 可用性探测:`wsl.exe -d <distro> --exec sh -lc 'test -d <posix>'`。非 Windows 返回 false。 */
export async function probeRemoteWsl(p: RemoteWslProject, opts: SshProbeOptions = {}): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const run = opts.exec ?? ((cmd, args, o) => execFileP(cmd, args, o) as Promise<{ stdout: string; stderr: string }>);
  try {
    await run("wsl.exe", ["-d", p.distro, "--exec", "sh", "-lc", `test -d ${posixQuote(p.workspacePath)}`], { timeout: opts.timeoutMs ?? 20_000 });
    return true;
  } catch {
    return false;
  }
}

/** 统一可达性探测(SSH 走 sshpass;WSL 走 wsl.exe)。 */
export async function probeRemoteProject(p: RemoteProject, opts: SshProbeOptions = {}): Promise<boolean> {
  return p.kind === "wsl" ? probeRemoteWsl(p, opts) : probeRemoteSsh(p, opts);
}

async function hasSshpass(opts: SshProbeOptions): Promise<boolean> {
  const run = opts.exec ?? ((cmd, args, o) => execFileP(cmd, args, o) as Promise<{ stdout: string; stderr: string }>);
  try {
    await run("sshpass", ["-V"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
