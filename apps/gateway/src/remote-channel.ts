/**
 * 远端工作区通道(2026-10-26,ZCode「stdio over SSH + 远端 agent runtime」的 genie 形态):
 * 每个远程 SSH 主机一条持久管道——spawn `ssh <host> node ~/.genie/agent-stdio.mjs <workspace>`
 * (ControlMaster 复用连接),stdin/stdout JSON-Lines 请求/响应。
 * 生命周期:懒启动(首请求拉起)→ 崩溃自动重启(下请求懒拉);请求 30s 超时;
 * 部署:ensureRemoteWorkspaceAgent(远端缺 agent-stdio.mjs 时从本仓 dist 上传+selftest 验证)。
 * ssh-ops 的 remoteLs/Read/Write/Exec 优先走本通道,失败回退 shim/shell(三层)。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RemoteProject } from "./remote-project.js";

/** 通道调用的主机参数:完整 RemoteProject(SSH/WSL;remoteRun/部署同源)。 */
type SshRunLike = RemoteProject;
import { remoteRun, shQuote } from "./ssh-ops.js";
import { repoRoot } from "./repo-root.js";

const REMOTE_AGENT_DIR = "$HOME/.genie";
const CALL_TIMEOUT_MS = 30_000;
/** 每主机的远端服务调用路径(node>=12 用 .mjs,老 node 用 .cjs;部署时确定)。 */
const agentPathByHost = new Map<string, string>();
function agentPathOf(key: string): string {
  return agentPathByHost.get(key) ?? `${REMOTE_AGENT_DIR}/agent-stdio.mjs`;
}

interface Channel {
  proc: ChildProcessWithoutNullStreams;
  pending: Map<string, { resolve: (v: Record<string, unknown>) => void; timer: NodeJS.Timeout }>;
  seq: number;
  buf: string;
}

const channels = new Map<string, Channel>();
/** agent-stdio.mjs 远端部署状态(每主机):unknown=未探测 true/false=已探测结果。 */
const agentDeployed = new Map<string, boolean>();

function hostKeyOf(r: RemoteProject): string {
  // 2026-10-27:key 必须含 workspace——agent-stdio 的 cwd/fence 在启动时固定;
  // 只按主机做 key 会让同主机第二个项目复用第一个项目的根(exec 跑错目录),
  // 连接向导(根 "/")与项目通道也要分开。
  return r.kind === "wsl"
    ? `wsl:${r.distro}:${r.workspacePath}`
    : `ssh:${r.host}:${r.port}:${r.username}:${r.workspacePath}`;
}

/** 通道拉起参数(纯函数,单测锚定):SSH=ssh 远端 node;WSL=wsl.exe 发行版内 node。 */
export function channelSpawnArgs(remote: RemoteProject, agentPath: string): { cmd: string; args: string[] } {
  if (remote.kind === "wsl") {
    return { cmd: "wsl.exe", args: ["-d", remote.distro, "--exec", "node", agentPath, remote.workspacePath] };
  }
  return {
    cmd: "ssh",
    args: [
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=8",
      // ControlMaster 复用(与 ssh-ops 同款 ctl 目录):管道与逐命令共享一条 SSH 连接
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${join(process.env.HOME ?? "/tmp", ".genie-ssh-ctl", "%C")}`,
      "-o", "ControlPersist=120",
      "-p", String(remote.port),
      `${remote.username}@${remote.host}`,
      `node ${agentPath} ${shQuote(remote.workspacePath)}`,
    ],
  };
}

/** 本地 agent-stdio bundle 目录:优先 gateway 运行目录旁(dist/gateway.mjs → dist/downloads),
 *  回退仓库布局(dev/测试:apps/gateway/dist/downloads)。2026-10-27 打包态 repoRoot=数据根修正。 */
function localAgentBundlePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const beside = join(here, "downloads");
  if (existsSync(join(beside, "agent-stdio.mjs"))) return join(beside, "agent-stdio.mjs");
  return join(repoRoot(), "apps", "gateway", "dist", "downloads", "agent-stdio.mjs");
}

export interface RemoteHost { host: string; port: number; username: string; workspacePath: string }

/** 拉起(或复用)一条远端服务管道。 */
function spawnChannel(remote: SshRunLike, opts: { password?: string } = {}): Channel {
  const key = hostKeyOf(remote);
  const old = channels.get(key);
  if (old) {
    try { if (!old.proc.killed && old.proc.exitCode === null) return old; } catch { /* 已死,重建 */ }
    channels.delete(key);
  }
  const agentPath = agentPathOf(key);
  // WSL 的 node 参数不走 shell(argv 直传),必须绝对路径(agentReady/部署会把 $HOME 展开后记进来)
  if (remote.kind === "wsl" && !agentPath.startsWith("/")) throw new Error("WSL 工作区服务路径未就绪(先部署)");
  const inv = channelSpawnArgs(remote, agentPath);
  console.log("[remote-channel] 拉起工作区服务管道 " + key + "(" + inv.cmd + " node " + agentPath + ")");
  const proc = spawn(inv.cmd, inv.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as ChildProcessWithoutNullStreams;
  const ch: Channel = { proc, pending: new Map(), seq: 0, buf: "" };
  ch.proc.stdout.on("data", (d: Buffer) => {
    ch.buf += d.toString();
    let nl: number;
    while ((nl = ch.buf.indexOf("\n")) >= 0) {
      const line = ch.buf.slice(0, nl); ch.buf = ch.buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line) as { id?: string; ok?: boolean };
        if (msg.id && ch.pending.has(msg.id)) {
          const p = ch.pending.get(msg.id)!;
          ch.pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg as Record<string, unknown>);
        }
      } catch { /* 非 JSON 行(stderr 混流等):忽略 */ }
    }
  });
  ch.proc.stderr.on("data", () => { /* 远端 stderr:日志混流,忽略 */ });
  // spawn 失败(Windows 无 wsl.exe / 无 ssh)是 error 事件而非异常:必须消费,
  // 否则进程级 uncaught(2026-10-27 WSL 通道补齐)。
  ch.proc.on("error", () => {
    for (const [, p] of ch.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: "远端服务启动失败" }); }
    ch.pending.clear();
    if (channels.get(key) === ch) channels.delete(key);
  });
  ch.proc.on("exit", () => {
    // 管道死:所有在飞请求失败;下请求懒拉新管道
    for (const [, p] of ch.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: "远端服务管道断开" }); }
    ch.pending.clear();
    if (channels.get(key) === ch) channels.delete(key);
  });
  channels.set(key, ch);
  return ch;
}

/** 通道调用:请求/响应匹配+超时。通道死/超时抛错(调用方回退)。 */
async function channelCall(remote: SshRunLike, op: string, args: Record<string, unknown>, opts: { password?: string } = {}): Promise<Record<string, unknown>> {
  const ch = spawnChannel(remote, opts);
  const key = hostKeyOf(remote);
  const id = "r" + (++ch.seq);
  const req = JSON.stringify({ id, op, args });
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      ch.pending.delete(id);
      reject(new Error("远端服务调用超时(" + op + ")"));
    }, CALL_TIMEOUT_MS);
    ch.pending.set(id, { resolve, timer });
    try { ch.proc.stdin.write(req + "\n"); } catch (e) { clearTimeout(timer); ch.pending.delete(id); reject(e as Error); }
  });
}

/** 远端 agent 就绪检查(部署状态缓存;unknown 才探测一次)。 */
async function agentReady(remote: SshRunLike, opts: { password?: string } = {}): Promise<boolean> {
  const key = hostKeyOf(remote);
  const hit = agentDeployed.get(key);
  if (hit !== undefined) return hit;
  const r = await remoteRun(remote, `for f in ${REMOTE_AGENT_DIR}/agent-stdio.mjs ${REMOTE_AGENT_DIR}/agent-stdio.cjs; do test -f $f && node $f selftest 2>/dev/null | grep -q '"ok":true' && { echo "yes:$f"; break; }; done; echo no`, opts);
  // 2026-10-27 修复:命令末尾恒有 "no"(在 for 循环外),旧实现取最后一行 → 永远判未部署,
  // 通道从未启用(SSH 侧静默退化到 shim/shell)。改为找第一条 yes:<path>。
  const yesLine = (r.ok ? r.stdout : "").split("\n").map((s) => s.trim()).find((s) => s.startsWith("yes:")) ?? "";
  const ok = yesLine.length > 0;
  if (ok) agentPathByHost.set(key, yesLine.slice(4).trim()); // 记录可用变体的远端路径(.mjs/.cjs;$HOME 由 shell 展开=绝对) 
  if (!ok) console.log("[remote-channel] 工作区服务未就绪 " + key + "(先部署;probe=" + JSON.stringify((r.stdout || r.error || "").slice(0, 120)) + ")");
  agentDeployed.set(key, ok);
  return ok;
}

export function invalidateRemoteAgentCache(hostKey?: string): void {
  if (hostKey) agentDeployed.delete(hostKey); else agentDeployed.clear();
}

/**
 * 部署远端工作区服务(上传 agent-stdio bundle + selftest)。
 * bundle 缺失(dist 未 build)时报错指路。成功后标记该主机已部署。
 */
export async function deployRemoteWorkspaceAgent(remote: SshRunLike, opts: { password?: string } = {}): Promise<{ version: string; remotePath: string } | { error: string }> {
  // bundle 解析(2026-10-27):桌面/打包态 repoRoot=数据根,`apps/gateway/dist/downloads` 不存在;
  // 优先取 gateway 运行目录旁的 downloads/ 再回退仓库布局(dev)。
  const dl = dirname(localAgentBundlePath());
  // 远端 node 版本探测(major>=12 → ESM .mjs;老 node → CJS .cjs,target=node8 转译)
  const vprobe = await remoteRun(remote, "node --version 2>/dev/null || echo none", opts);
  const vstr = vprobe.ok ? vprobe.stdout.trim().replace(/^v/, "") : "none";
  const major = Number(vstr.split(".")[0]);
  if (vstr === "none" || !Number.isFinite(major)) {
    return {
      error: remote.kind === "wsl"
        ? `WSL 发行版内没有 node(${remote.distro}):请在发行版内安装 Node.js(如 nvm 或 apt install nodejs)后重试`
        : "远端无 node(runtimeToolDeploy 未实现;请安装 node 后重试部署)",
    };
  }
  const useCjs = major < 14;
  const local = useCjs ? join(dl, "agent-stdio.cjs") : join(dl, "agent-stdio.mjs");
  let code: string;
  try {
    if (!existsSync(local)) throw new Error("bundle 缺失:" + local + "(先 pnpm --filter @lampgenie/gateway build)");
    code = readFileSync(local, "utf-8");
  } catch (e) {
    return { error: (e as Error).message };
  }
  const remoteName = useCjs ? "agent-stdio.cjs" : "agent-stdio.mjs";
  const remotePath = `${REMOTE_AGENT_DIR}/${remoteName}`;
  // 清掉另一种变体:旧版残留(如 node12 上跑不动的 .mjs)会让就绪探测先命中坏文件。
  const staleName = useCjs ? "agent-stdio.mjs" : "agent-stdio.cjs";
  const b64 = Buffer.from(code, "utf-8").toString("base64");
  const upload = await remoteRun(remote, `mkdir -p $HOME/.genie && rm -f $HOME/.genie/${staleName} && printf %s ${shQuote(b64)} | base64 -d > ${remotePath} && node ${remotePath} selftest`, opts);
  if (!upload.ok) return { error: "上传/自检失败(node " + vstr + "):" + (upload.error ?? upload.stderr.slice(0, 160)) };
  // WSL 通道 argv 直传 node 脚本路径(不经 shell),把 $HOME 展开成绝对路径存起来
  let spawnPath = remotePath;
  if (remote.kind === "wsl") {
    const homeR = await remoteRun(remote, 'printf %s "$HOME"', opts);
    const home = homeR.ok ? homeR.stdout.trim() : "";
    if (home.startsWith("/")) spawnPath = `${home}/.genie/${remoteName}`;
  }
  agentPathByHost.set(hostKeyOf(remote), spawnPath);
  invalidateRemoteAgentCache(hostKeyOf(remote));
  let ver: { version?: string } = {};
  try { ver = JSON.parse(upload.stdout.trim().split("\n").pop() ?? "{}"); } catch { /* 解析失败但命令成功 */ }
  return { version: String(ver.version ?? "1") + " (node " + vstr + (useCjs ? ",cjs" : ",mjs") + ")", remotePath };
}

/**
 * 通道调用入口(供 ssh-ops 回退链第一层):返回 null=通道不可用(调用方回退 shim/shell)。
 * 只在 agent 已部署(或首次探测成功)时启用。
 */
export async function tryChannelJson(
  remote: SshRunLike,
  op: string,
  args: Record<string, unknown>,
  opts: { password?: string } = {},
): Promise<Record<string, unknown> | null> {
  try {
    if (!(await agentReady(remote, opts))) return null;
    return await channelCall(remote, op, args, opts);
  } catch (err) {
    console.error("[remote-channel] 通道调用失败(" + hostKeyOf(remote) + " " + op + "):" + String((err as Error)?.message ?? err).slice(0, 200));
    return null; // 通道故障:回退(调用方 shim/shell 兜底)
  }
}
/** 指纹(诊断用):当前通道数与部署缓存。 */
export function remoteChannelStats(): { channels: number; deployedHosts: number } {
  return { channels: channels.size, deployedHosts: [...agentDeployed.values()].filter(Boolean).length };
}

