/**
 * Git 服务(批C,ZCode GitPane 移植):在激活项目根跑 git 命令。
 * status/branches/checkout/commit/diff 五面;非 git 目录按  * 「没有 git 就不要进行对应操作」——isGitRepo 先验,读类由调用方降级空结果,不再显式报错。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseWslPath, wslErrorHint, wslGitInvocation } from "./wsl.js"; // :WSL 项目 git 回发行版内执行

const execFileP = promisify(execFile);

/**
 * 超时预算(修「偶发 git-failed」)。
 * 原预算统一 15s。经验证本仓(490 个变更、大量未跟踪,9p/网络盘更慢)单次
 * `git status --porcelain -b` 已经 5.7~11.8s,面板 gitLoad + IDE SCM 角标 + 多会话
 * 各自触发 status 时并发叠加,**单个调用就会越过 15s → execFile SIGTERM**,
 * 而 Node 抛出的 `Error: Command failed: git status --porcelain -b` 里 stderr 为空,
 * 面板 toast 只能显示这句无信息量的原文(code=git-failed)。
 * 只读命令给 60s(大仓/慢盘留余量),写命令 30s(出错要快,别让面板干等)。
 */
const READ_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 30_000;

/** 只读子命令:可加 --no-optional-locks 不抢 index.lock;超时也按读档给。 */
const READ_ONLY_COMMANDS = new Set([
  "status", "log", "diff", "show", "branch", "rev-parse", "remote",
  "ls-files", "cat-file", "for-each-ref", "count-objects", "describe",
]);

/** 纯函数:按 cwd 选 git 执行形态(WSL 项目回发行版内;否则本地 git)。单测锚定。 */
export function gitInvocationFor(cwd: string, args: string[]): { cmd: string; args: string[]; mode: "wsl" | "host" } {
  const wsl = parseWslPath(cwd);
  if (wsl) return { ...wslGitInvocation(wsl.distro, wsl.posix, args), mode: "wsl" };
  return { cmd: "git", args, mode: "host" };
}

/**
 * 纯函数:取子命令名(跳过 `-c k=v` / `-C dir` / `--git-dir x` 这类全局参数的值)。
 * `["-c","user.email=a","commit","-m","x"]` → `"commit"`。
 */
export function gitSubcommand(args: string[]): string {
  const takesValue = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (takesValue.has(arg)) { i += 1; continue; }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return "";
}

export function isReadOnlyGitCommand(args: string[]): boolean {
  return READ_ONLY_COMMANDS.has(gitSubcommand(args));
}

/**
 * 纯函数:只读命令补 `--no-optional-locks`(git 全局标志,必须在子命令之前)。
 * status/log/diff 默认会刷索引而抢 index.lock;面板只读刷新不该和用户的 add/commit 抢锁。
 * 语义不变:只是"跳过可选刷新",输出仍是工作区真实状态。
 */
export function prepareGitArgs(args: string[]): string[] {
  if (!isReadOnlyGitCommand(args)) return args;
  return ["--no-optional-locks", ...args];
}

function timeoutFor(args: string[]): number {
  const override = Number(process.env.GENIE_GIT_TIMEOUT_MS ?? "");
  if (Number.isFinite(override) && override > 0) return override;
  return isReadOnlyGitCommand(args) ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
}

/** 瞬时失败(锁争用):值得退避重试一次,与"仓库真的有问题"区分开。 */
export function isTransientGitError(err: unknown): boolean {
  const e = err as { stderr?: string | Buffer; message?: string } | undefined;
  const text = `${typeof e?.stderr === "string" ? e.stderr : e?.stderr ? String(e.stderr) : ""}\n${String(e?.message ?? "")}`;
  return /index\.lock|Unable to create '[^']*\.lock'|Another git process|could not lock|EBUSY|ETXTBSY|Resource temporarily unavailable/i.test(text);
}

/**
 * 纯函数:把 git 失败归一成**可判读**的一句话(面板 toast 直接展示)。
 * 原样透传 Node 的 `Command failed: <cmd>` 等于让用户/助手猜(经验证 stderr 常为空)。
 */
export function gitErrorText(args: string[], err: unknown, timeoutMs: number): string {
  const sub = gitSubcommand(args) || "git";
  const e = err as { message?: string; stderr?: string | Buffer; killed?: boolean; signal?: string; code?: string } | undefined;
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  if (e?.killed || e?.signal === "SIGTERM" || e?.code === "ETIMEDOUT") {
    const what = sub === "status" ? "工作区扫描" : sub;
    return `git ${sub} 超时(>${seconds}s,已中止):${what}在仓库大 / 网络盘慢 / 并发 git 操作时会变慢,可稍后重试`;
  }
  const stderr = String(e?.stderr ?? "").trim();
  const firstLine = stderr.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  if (firstLine) return `git ${sub} 失败:${firstLine.slice(0, 200)}`;
  // Node 的 `Command failed: <cmd>` 前缀本身零信息量(命令已经在文本里),剥掉只留尾部原因。
  const message = String(e?.message ?? err ?? "")
    .replace(/^Error:\s*/, "")
    .replace(/^Command failed:\s*[^\n]*\n?/, "")
    .split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "";
  return message ? `git ${sub} 失败:${message.slice(0, 200)}` : `git ${sub} 失败(退出码 ${String(e?.code ?? "?")},无 stderr)`;
}

/** 已是归一文本的错误(wsl 提示等):不再二次包装。 */
class GitDiagnosticError extends Error {}

/** 执行一次 git argv。WSL 项目(UNC cwd)走 `wsl.exe --exec git`,不隔着 9p 用 Windows git。 */
async function runGitOnce(
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxBuffer: number): Promise<string> {
  const inv = gitInvocationFor(cwd, args);
  if (inv.mode === "wsl") {
    const wsl = parseWslPath(cwd)!;
    try {
      const { stdout } = await execFileP(inv.cmd, inv.args, { timeout: timeoutMs, maxBuffer });
      return stdout;
    } catch (err) {
      const hint = wslErrorHint(err, wsl.distro);
      if (hint) {
        throw new GitDiagnosticError(hint + "(" + String((err as Error).message ?? err).slice(0, 160) + ")");
      }
      throw err;
    }
  }
  // 允许指定 git 可执行文件(Windows 上 git 不在 PATH / 单测注入假 git)。
  const bin = process.env.GENIE_GIT_BIN?.trim() || inv.cmd;
  const { stdout } = await execFileP(bin, inv.args, { cwd, timeout: timeoutMs, maxBuffer });
  return stdout;
}

async function runGit(
  args: string[],
  cwd: string,
  opts: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? timeoutFor(args);
  const maxBuffer = opts.maxBuffer ?? 8 * 1024 * 1024;
  const argv = prepareGitArgs(args);
  for (let attempt = 0; ; attempt++) {
    try {
      return await runGitOnce(argv, cwd, timeoutMs, maxBuffer);
    } catch (err) {
      if (err instanceof GitDiagnosticError) throw err;
      // 锁争用退避重试一次;超时不重试(否则 60s×2 面板干等)
      if (attempt === 0 && isTransientGitError(err) && !(err as { killed?: boolean }).killed) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      throw new GitDiagnosticError(gitErrorText(args, err, timeoutMs));
    }
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  return runGit(args, cwd);
}

/** 是否 git 仓库(工作树/worktree 均可);探测失败一律视为非仓库,调用方跳过 git 操作。 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await git(["rev-parse", "--is-inside-work-tree"], cwd);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export interface GitChange {
  file: string;
  staged: boolean;
  label: string;
}

/** `git status --porcelain -b` 文本 → {branch,changes}(本地 git 与远端工作区服务同源解析)。 */
export function parseGitStatusPorcelain(out: string): { branch: string; changes: GitChange[] } {
  const lines = out.split("\n").filter((l) => l.trim());
  let branch = "";
  const changes: GitChange[] = [];
  for (const line of lines) {
    if (line.startsWith("##")) {
      branch = line.replace(/^##\s+/, "").split("...")[0]!.trim();
      continue;
    }
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const file = line.slice(3).trim();
    if (!file) continue;
    // XY:X=暂存区,Y=工作区;X 非空即已暂存。
    changes.push({ file, staged: x !== " " && x !== "?", label: (x === "?" ? "新增" : x !== " " ? x : y === "M" ? "修改" : y === "D" ? "删除" : y) + "" });
  }
  return { branch, changes };
}

/**
 * 单飞(single-flight):同一 cwd 上并发的 status 合并成一次 git 执行。
 * 面板 gitLoad、IDE SCM 角标刷新、多会话/子代理的 checkpoint 都会各自要 status;
 * 本仓单次 status 已 5~12s,并发 N 份只会互相拖慢,再叠加超时就变成偶发 git-failed。
 * 只合并**同时进行中**的请求(做完即删),不做时间缓存——状态新鲜度不变。
 */
const inflightStatus = new Map<string, Promise<{ branch: string; changes: GitChange[] }>>();

export async function gitStatus(cwd: string): Promise<{ branch: string; changes: GitChange[] }> {
  const running = inflightStatus.get(cwd);
  if (running) return running;
  const task = (async () => parseGitStatusPorcelain(await git(["status", "--porcelain", "-b"], cwd)))();
  inflightStatus.set(cwd, task);
  try {
    return await task;
  } finally {
    inflightStatus.delete(cwd);
  }
}

export async function gitDiff(cwd: string, file: string): Promise<string> {
  const tracked = await git(["diff", "HEAD", "--", file], cwd).catch(() => git(["diff", "--", file], cwd).catch(() => git(["diff", "--cached", "--", file], cwd)));
  if (tracked && tracked.trim()) return tracked;
  // 未跟踪文件:与空内容对比(--no-index 退出码 1 但带 diff 输出)。
  try {
    return await runGit(["diff", "--no-index", "--", "/dev/null", file], cwd, { maxBuffer: 4 * 1024 * 1024 });
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout ?? "";
    return stdout;
  }
}

/** `git branch --format=%(HEAD)%(refname:short)` 文本 → {current,branches}。 */
export function parseGitBranches(out: string): { current: string; branches: string[] } {
  const branches = out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^\*/, "").trim());
  const current = out.split("\n").find((l) => l.startsWith("*"))?.replace("*", "").trim() ?? "";
  return { current, branches: branches.filter((b) => b !== current) };
}

export async function gitBranches(cwd: string): Promise<{ current: string; branches: string[] }> {
  return parseGitBranches(await git(["branch", "--format", "%(HEAD)%(refname:short)"], cwd));
}

export async function gitCheckout(cwd: string, branch: string): Promise<string> {
  await git(["checkout", branch], cwd);
  return `已切换到 ${branch}`;
}

export async function gitCommit(cwd: string, message: string, files?: string[]): Promise<string> {
  const ident = ["-c", "user.email=panel@lampgenie.local", "-c", "user.name=genie-panel"];
  if (files && files.length > 0) {
    await git(["add", ...files], cwd);
  } else {
    await git(["add", "-A"], cwd);
  }
  await git([...ident, "commit", "-m", message], cwd);
  const out = await git(["log", "-1", "--format=%h %s"], cwd);
  return out.trim();
}

// ---- push/pull(二期:面板 GitPane 同步操作面;与 commit 同语义,作用于激活项目工作目录) ----

export interface GitSyncOpts {
  /** 远端名(缺省 origin)。 */
  remote?: string;
  /** 分支(push/pull 目标;缺省=当前分支/upstream)。 */
  branch?: string;
}

async function currentBranch(cwd: string): Promise<string> {
  return (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
}

/** push:缺省当前分支→origin;-u 设 upstream(幂等,首推新分支同一条命令)。 */
export async function gitPush(cwd: string, opts?: GitSyncOpts): Promise<string> {
  const remote = opts?.remote ?? "origin";
  const branch = opts?.branch ?? (await currentBranch(cwd));
  await git(["push", "-u", remote, branch], cwd);
  return `已推送 ${branch} → ${remote}`;
}

/** pull:带 remote/branch 则显式拉取,否则走当前分支 upstream(缺省 git pull)。 */
export async function gitPull(cwd: string, opts?: GitSyncOpts): Promise<string> {
  const remote = opts?.remote;
  const branch = opts?.branch;
  const args = remote && branch ? ["pull", remote, branch] : remote ? ["pull", remote] : ["pull"];
  await git(args, cwd);
  const head = await currentBranch(cwd);
  return `已拉取${remote ? ` ${remote}${branch ? `/${branch}` : ""}` : ""} → ${head}`;
}

export interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

/** `git log --format=%h%x09%an%x09%ar%x09%s` 文本 → 提交列表。 */
export function parseGitLog(out: string): GitCommit[] {
  return out.split("\n").filter((l) => l.trim()).map((l) => {
    const [hash = "", author = "", date = "", ...rest] = l.split("\t");
    return { hash, author, date, subject: rest.join("\t") };
  });
}

export async function gitLog(cwd: string, limit = 50): Promise<GitCommit[]> {
  return parseGitLog(await git(["log", "-n", String(limit), "--format=%h%x09%an%x09%ar%x09%s"], cwd));
}

// ---- 项目团队绑定(有 git 就有 team) ----

/** 激活项目的 origin remote(绑定键);无 remote/非 git 目录 → null(调用方回退 label 匹配)。 */
export async function gitRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const out = await git(["remote", "get-url", "origin"], cwd);
    const url = out.trim();
    return url || null;
  } catch {
    return null;
  }
}

export interface GitContributor {
  name: string;
  email: string;
  commits: number;
}

/** 项目贡献者候选名单(git 贡献者=团队候选,invite 目标建议;非成员资格)。 */
export async function gitContributors(cwd: string, limit = 20): Promise<GitContributor[]> {
  const out = await git(["log", "--format=%an%x09%ae", "--all"], cwd);
  const byEmail = new Map<string, GitContributor>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    const name = tab === -1 ? line : line.slice(0, tab);
    const email = tab === -1 ? "" : line.slice(tab + 1);
    const key = email || name;
    const cur = byEmail.get(key) ?? { name, email, commits: 0 };
    cur.commits += 1;
    byEmail.set(key, cur);
  }
  return [...byEmail.values()].sort((a, b) => b.commits - a.commits).slice(0, limit);
}

// ---- checkpoint 回滚 ----

/** 任务前快照:git stash create(悬空 commit,不动工作区);无变更→null。 */
export async function checkpointCreate(cwd: string): Promise<string | null> {
  if (!existsSync(join(cwd, ".git"))) return null;
  const sha = (await git(["stash", "create"], cwd)).trim();
  return sha || null;
}

/** 快照与当前的受影响文件清单(含未跟踪?不含——checkout 不动 untracked,预览对齐回滚语义)。 */
export async function checkpointPreview(cwd: string, sha: string): Promise<string[]> {
  const out = await git(["diff", "--name-only", sha], cwd).catch(() => "");
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** 回滚:被跟踪文件恢复到快照态(只覆盖;快照后新增的未跟踪文件保留——登记边界)。 */
/** 任意快照恢复(多快照浏览;同 rewind 语义,sha 由调用方给)。 */
export async function checkpointRestoreSha(cwd: string, sha: string): Promise<number> {
  return checkpointRewind(cwd, sha);
}

export async function checkpointRewind(cwd: string, sha: string): Promise<number> {
  const files = await checkpointPreview(cwd, sha);
  await git(["checkout", sha, "--", "."], cwd);
  return files.length;
}

/** 变更统计(内联变更条「N 个文件已更改 +A -D」):git diff --numstat 快照→当前。 */
export async function diffstat(
  cwd: string,
  sha: string): Promise<{ files: { path: string; add: number; del: number }[]; total: { files: number; add: number; del: number } }> {
  const out = await git(["diff", "--numstat", sha], cwd).catch(() => "");
  const files: { path: string; add: number; del: number }[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m || m[3] === undefined) continue;
    const add = m[1] === "-" || m[1] === undefined ? 0 : Number(m[1]);
    const del = m[2] === "-" || m[2] === undefined ? 0 : Number(m[2]);
    files.push({ path: m[3], add, del });
  }
  return {
    files,
    total: { files: files.length, add: files.reduce((s, f) => s + f.add, 0), del: files.reduce((s, f) => s + f.del, 0) },
  };
}

/** 单文件补丁( F1):任务快照 sha → 该文件 diff 全文;截断上限 120KB。 */
export async function fileDiff(cwd: string, sha: string, file: string): Promise<{ diff: string; truncated: boolean }> {
  const full = await git(["diff", "--find-renames", sha, "--", file], cwd).catch(() => "");
  const LIMIT = 120 * 1024;
  return full.length > LIMIT ? { diff: full.slice(0, LIMIT), truncated: true } : { diff: full, truncated: false };
}

/**
 * 单文件历史内容(面板 IDE 第二批 git.show):git show ref:path 全文。
 * 文件不在 ref(未提交/未跟踪/ref 笔误)→ git 非零退出,异常上抛(调用方回 error 帧);
 * 内容 >2MB → 抛错(响应体防放大);内容取自 git 对象库,无文件系统越界面。
 */
export async function showFile(cwd: string, ref: string, file: string): Promise<string> {
  const LIMIT = 2 * 1024 * 1024;
  const out = await git(["show", `${ref}:${file}`], cwd);
  if (Buffer.byteLength(out, "utf8") > LIMIT) throw new Error(`文件内容超过 2MB 上限(${ref}:${file})`);
  return out;
}
