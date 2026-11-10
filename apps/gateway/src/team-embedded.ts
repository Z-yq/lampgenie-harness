/**
 * 内嵌团队 relay(团队页空态修复):「有 gateway 就有团队」。
 * 此前团队面三重死亡:relay 服务进程(apps/relay)从没人启动、.env 的 RELAY_URL 对 gateway
 * 进程是死文件、TeamView 因此从未构造(面板 orgs:[])。本模块在未配置外部 relay 时
 * 于本机自举一个单 org relay:本地 bare 团队仓 + owner 成员种子 + 项目绑定种子,
 * gateway 自连——团队页立即可用(成员在线/项目团队/teamai 资产/邀请/活动流)。
 * 三态:resolveTeamMode——外部(env RELAY_URL(S) 指向非本机)/内嵌(缺省或指向本机)/off
 * (GENIE_TEAM_RELAY=off 显式关)。换真实多人部署时把 RELAY_URL 指到共享服务器即可,零代码迁移。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TeamRelay } from "@lampgenie/runtime/team/team-relay";
import { loadOrCreateIdentity } from "@lampgenie/runtime/identity/identity";
import { parseYamlLite, stringifyYamlLite, type YamlValue } from "@lampgenie/runtime/team/yaml-lite";
import { normalizeRepoUrl } from "@lampgenie/runtime/team/project-binding";
import { gitRemoteUrl } from "./git-service.js";
import { REMOTE_PROJECT_PREFIX } from "./remote-project.js";

const execFileP = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

// ---- 模式判定 ----

export type TeamMode =
  | { kind: "external" }
  | { kind: "embedded"; port: number }
  | { kind: "off" };

function isLoopbackUrl(url: string): boolean {
  const m = /^wss?:\/\/([^/:]+)/i.exec(url.trim());
  const host = (m?.[1] ?? "").toLowerCase();
  return host === "" || host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function portOfUrl(url: string): number | null {
  const m = /^wss?:\/\/[^/]*:(\d+)/i.exec(url.trim());
  return m ? Number(m[1]) : null;
}

/** 三态判定:GENIE_TEAM_RELAY=off 显式关;env 指向非本机=外部;未配/全指本机=内嵌。 */
export function resolveTeamMode(env: NodeJS.ProcessEnv): TeamMode {
  if (env.GENIE_TEAM_RELAY === "off") return { kind: "off" };
  const urls = (env.RELAY_URLS ?? env.RELAY_URL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (urls.length === 0) return { kind: "embedded", port: Number(env.RELAY_PORT ?? 7870) };
  if (urls.every(isLoopbackUrl)) {
    return { kind: "embedded", port: portOfUrl(urls[0]!) ?? Number(env.RELAY_PORT ?? 7870) };
  }
  return { kind: "external" };
}

// ---- 团队仓自举(幂等) ----

export interface BootstrapOptions {
  /** bare 团队仓目录(如 <root>/.genie/team/team-repo.git)。 */
  bareDir: string;
  /** relay 工作目录(其下 team-clone 为工作克隆;与 TeamRelay.cloneDir 同一约定)。 */
  workdir: string;
  /** 设备身份目录(已有身份用其指纹;没有则生成——与 gateway TeamView 客户端同目录)。 */
  identityDir: string;
  /** 本机用户名(roster 成员文件名/用户名;非法字符清洗)。 */
  username: string;
  /** 项目绑定种子:激活仓 origin remote(缺省不种 projects)。 */
  originUrl?: string | null;
  /** 项目绑定 id(roster projects.yaml 键;通常=项目目录名)。 */
  projectId?: string;
}

export interface BootstrapResult {
  /** 本次是否新建了 bare 仓。 */
  createdRepo: boolean;
  /** 写入/已存在的 owner 成员名(bootstrap 失败为 null)。 */
  member: string;
  /** 新写入 roster 的键(成员 yaml/projects 键),空数组=零写入(幂等命中)。 */
  wrote: string[];
}

/** 用户名清洗:roster 成员文件名安全(禁路径穿越/非法字符;空/./.. 回退 owner)。 */
export function sanitizeUsername(raw: string): string {
  const s = String(raw ?? "").replace(/[^\w.-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return !s || s === "." || s === ".." ? "owner" : s;
}

/**
 * 团队仓自举:bare 仓(无则 init -b main)→ 工作克隆(无则 clone,空仓合法)→
 * owner 成员种子(指纹=本机身份,已存在不 clobber)→ 项目绑定种子(origin 归一化键)。
 * 幂等:第二次起零写入;git 失败上抛(调用方决定降级形态)。
 */
export async function bootstrapTeamRepo(opts: BootstrapOptions): Promise<BootstrapResult> {
  const username = sanitizeUsername(opts.username);
  mkdirSync(opts.workdir, { recursive: true });
  let createdRepo = false;
  if (!existsSync(join(opts.bareDir, "HEAD"))) {
    mkdirSync(opts.bareDir, { recursive: true });
    try {
      await git(["init", "--bare", "-b", "main", opts.bareDir], opts.workdir);
    } catch {
      // 老 git 无 -b:init 后补 HEAD 指向
      await git(["init", "--bare", opts.bareDir], opts.workdir);
      await git(["symbolic-ref", "HEAD", "refs/heads/main"], opts.bareDir).catch(() => {});
    }
    createdRepo = true;
  }
  const cloneDir = join(opts.workdir, "team-clone");
  try {
    await git(["rev-parse", "--git-dir"], cloneDir);
  } catch {
    await git(["clone", opts.bareDir, cloneDir], opts.workdir);
  }
  const identity = loadOrCreateIdentity(opts.identityDir);
  const ident = ["-c", "user.name=genie-team", "-c", "user.email=team@lampgenie.local"];

  const wrote: string[] = [];
  const membersDir = join(cloneDir, "roster", "members");
  const memberFile = join(membersDir, `${username}.yaml`);
  const wantProjectId = opts.originUrl && opts.projectId ? opts.projectId : null;
  if (!existsSync(memberFile)) {
    mkdirSync(membersDir, { recursive: true });
    writeFileSync(memberFile, stringifyYamlLite({
      username,
      displayName: username,
      fingerprint: identity.fingerprint,
      keys: [identity.fingerprint],
      role: "owner",
      projects: wantProjectId ? [wantProjectId] : [],
      registeredAt: new Date().toISOString(),
      revoked: false,
    }));
    wrote.push(`roster/members/${username}.yaml`);
  }
  if (wantProjectId) {
    const projectsFile = join(cloneDir, "roster", "projects.yaml");
    let flat: Record<string, YamlValue> = {};
    if (existsSync(projectsFile)) {
      try {
        flat = parseYamlLite(readFileSync(projectsFile, "utf-8"));
      } catch { /* 坏文件不 clobber 判定:仍写入本键 */ }
    }
    const typeKey = `${wantProjectId}.type`;
    const repoKey = `${wantProjectId}.repo`;
    if (flat[typeKey] !== "team" || flat[repoKey] !== opts.originUrl) {
      flat[typeKey] = "team";
      flat[repoKey] = String(opts.originUrl);
      writeFileSync(projectsFile, stringifyYamlLite(flat));
      wrote.push(`roster/projects.yaml:${wantProjectId}`);
    }
  }
  if (wrote.length > 0) {
    await git([...ident, "add", "roster/"], cloneDir);
    await git([...ident, "commit", "-m", "roster: bootstrap owner + project binding"], cloneDir);
    const branch = (await git(["symbolic-ref", "--short", "HEAD"], cloneDir)).trim() || "main";
    await git([...ident, "push", "-u", "origin", branch], cloneDir);
  }
  return { createdRepo, member: username, wrote };
}

// ---- 内嵌 relay 启动 ----

export interface EmbeddedTeamOptions {
  root: string;
  port: number;
  log?: (line: string) => void;
  /** 测试注入口:传 http server 时 relay 挂其上(不走独立端口)。 */
  server?: import("node:http").Server;
}

export interface EmbeddedTeamHandle {
  port: number;
  teamRepoUrl: string;
  relay: TeamRelay;
  boot: BootstrapResult;
  /** 全项目绑定种子(注册表新增项目后可重复调用;幂等)。 */
  seed(bindings: TeamProjectBinding[]): Promise<string[]>;
  close(): Promise<void>;
}

/** 项目绑定入参:roster 键用 label(可读),repo 归一化已存在时复用旧键(改名不重复入册)。 */
export interface TeamProjectBinding {
  projectId: string;
  label: string;
  originUrl: string | null;
}

/**
 * 全项目绑定种子(「团队页只有 lampgenie-harness」修复):注册表里每个有 origin 的
 * 本地项目都进 roster——projects.yaml 加 <key>.type/.repo 键 + owner 成员 projects 数组补齐
 * (presence 按 member.projects 投影,成员数组不含该项目=团队页该项目恒无成员)。
 * 幂等:repo 归一化反查复用既有键;零变化零提交。非 git 项目(originUrl=null)不入册。
 */
export async function seedTeamProjects(opts: {
  workdir: string;
  username: string;
  bindings: TeamProjectBinding[];
}): Promise<string[]> {
  const username = sanitizeUsername(opts.username);
  const cloneDir = join(opts.workdir, "team-clone");
  try {
    await git(["rev-parse", "--git-dir"], cloneDir);
  } catch {
    return []; // 未自举(调用方顺序错误):静默空,不在这里补 clone
  }
  const projectsFile = join(cloneDir, "roster", "projects.yaml");
  let flat: Record<string, YamlValue> = {};
  if (existsSync(projectsFile)) {
    try {
      flat = parseYamlLite(readFileSync(projectsFile, "utf-8"));
    } catch { /* 坏文件仍写本键 */ }
  }
  const keyByRepo = new Map<string, string>();
  for (const [k, v] of Object.entries(flat)) {
    const m = /^(.+)\.repo$/.exec(k);
    if (m) keyByRepo.set(normalizeRepoUrl(String(v)), m[1]!);
  }
  const wrote: string[] = [];
  const wantIds: string[] = [];
  let projectsChanged = false;
  for (const b of opts.bindings) {
    if (!b.originUrl) continue;
    const existing = keyByRepo.get(normalizeRepoUrl(b.originUrl));
    const key = existing ?? sanitizeUsername(b.label || b.projectId);
    const typeKey = `${key}.type`;
    const repoKey = `${key}.repo`;
    if (flat[typeKey] !== "team" || flat[repoKey] !== b.originUrl) {
      flat[typeKey] = "team";
      flat[repoKey] = String(b.originUrl);
      projectsChanged = true;
      wrote.push(`projects.yaml:${key}`);
    }
    if (!wantIds.includes(key)) wantIds.push(key);
  }
  if (projectsChanged) writeFileSync(projectsFile, stringifyYamlLite(flat));
  const memberFile = join(cloneDir, "roster", "members", `${username}.yaml`);
  if (wantIds.length > 0 && existsSync(memberFile)) {
    const raw = parseYamlLite(readFileSync(memberFile, "utf-8"));
    const cur = Array.isArray(raw.projects) ? raw.projects.map(String) : [];
    const merged = [...cur];
    let changed = false;
    for (const id of wantIds) {
      if (!merged.includes(id)) { merged.push(id); changed = true; }
    }
    if (changed) {
      raw.projects = merged;
      writeFileSync(memberFile, stringifyYamlLite(raw as Record<string, YamlValue>));
      wrote.push(`members/${username}.yaml:projects`);
    }
  }
  if (wrote.length > 0) {
    const ident = ["-c", "user.name=genie-team", "-c", "user.email=team@lampgenie.local"];
    await git([...ident, "add", "roster/"], cloneDir);
    await git([...ident, "commit", "-m", "roster: seed project bindings"], cloneDir);
    const branch = (await git(["symbolic-ref", "--short", "HEAD"], cloneDir)).trim() || "main";
    await git([...ident, "push", "origin", branch], cloneDir);
  }
  return wrote;
}

/**
 * 注册表→roster 全项目绑定(开机种子与运行期 project.add 共用):
 * 收集本地 available 项目的 origin,seed 进团队仓后重拉 roster 广播。
 * 返回写入键数;未启内嵌 relay(handle=null)或零变化=0。
 */
export async function seedRegistryProjects(
  handle: EmbeddedTeamHandle,
  list: { id: string; path: string; label: string; availability: string }[],
): Promise<string[]> {
  const bindings: TeamProjectBinding[] = [];
  for (const p of list) {
    if (p.path.startsWith(REMOTE_PROJECT_PREFIX) || p.availability !== "available") continue;
    const originUrl = await gitRemoteUrl(p.path).catch(() => null);
    bindings.push({ projectId: p.id, label: p.label, originUrl });
  }
  const wrote = await handle.seed(bindings);
  if (wrote.length > 0) await handle.relay.start(); // 重拉 roster 并广播(注册表/presence projects 投影刷新)
  return wrote;
}

/** 本机用户名解析:repoRoot git config user.name → 系统用户名 → owner。 */
export async function localUsername(root: string): Promise<string> {
  try {
    const n = (await git(["config", "user.name"], root)).trim();
    if (n) return n;
  } catch { /* 无 git/未配置,走系统名 */ }
  try {
    const { userInfo } = await import("node:os");
    return userInfo().username || "owner";
  } catch {
    return "owner";
  }
}

/**
 * 启动内嵌团队 relay:自举团队仓 → 起 relay(独立端口,不与 gateway WS 同 server)。
 * 端口被占返回 null(调用方降级为「按该地址连外部 relay」);其余错误上抛。
 */
export async function startEmbeddedTeam(opts: EmbeddedTeamOptions): Promise<EmbeddedTeamHandle | null> {
  const log = opts.log ?? (() => {});
  const teamDir = join(opts.root, ".genie", "team");
  const bareDir = join(teamDir, "team-repo.git");
  const workdir = join(teamDir, "relay");
  const identityDir = join(opts.root, ".genie", "identity");
  let originUrl: string | null = null;
  try {
    const u = (await git(["remote", "get-url", "origin"], opts.root)).trim();
    originUrl = u || null;
  } catch { /* 无 origin:不种项目绑定 */ }
  const username = sanitizeUsername(await localUsername(opts.root));
  const boot = await bootstrapTeamRepo({ bareDir, workdir, identityDir, username, originUrl, projectId: opts.root.split(/[\\/]/).filter(Boolean).pop() });
  if (boot.wrote.length > 0) log(`[team-embedded] 团队仓自举:${boot.wrote.join(", ")}(bare=${bareDir})`);
  else if (boot.createdRepo) log(`[team-embedded] 团队仓已存在,自举幂等命中(bare=${bareDir})`);

  if (!opts.server) {
    // 端口预占探测:TeamRelay 构造内的 WebSocketServer({port}) 端口被占会抛无监听 error,
    // 这里先探一次,被占=可能有外部 relay 在此端口——返回 null 让 gateway 按外部地址连接。
    const free = await new Promise<boolean>((resolve) => {
      const probe = import("node:http").then(({ createServer }) => createServer());
      void probe.then((srv) => {
        srv.once("error", () => resolve(false));
        srv.listen(opts.port, () => srv.close(() => resolve(true)));
      });
    });
    if (!free) return null;
  }
  const relay = new TeamRelay({
    ...(opts.server ? { server: opts.server } : { port: opts.port }),
    teamRepoUrl: bareDir,
    workdir,
    mainBranch: "main",
  });
  await relay.start();
  return {
    port: opts.port,
    teamRepoUrl: bareDir,
    relay,
    boot,
    seed: (bindings) => seedTeamProjects({ workdir, username, bindings }),
    close: () => relay.close(),
  };
}
