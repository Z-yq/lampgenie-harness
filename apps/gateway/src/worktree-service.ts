/**
 * git worktree 隔离服务(参照 deepseek-harness packages/experimental/worktree
 * 与 opencode packages/opencode/src/worktree 的形态,不搬实现):
 * - 子代理可运行在基于当前分支 pin commit 的临时 worktree 里,并行互不踩文件;
 * - 生命周期:成功/失败都保留 worktree + 分支(供人工合并/诊断),不自动改主工作区;
 * - remove/cleanup 默认**保留分支**,只有显式 deleteBranch 才删本服务创建的 `genie/` 分支;
 * - 安全:目录池围栏(<repo>/.genie/worktrees)、名字清洗、分支 check-ref-format、
 *   创建失败回滚(只删本次产物且只在池内)。
 * 纯 Node 内置依赖(child_process/fs/path),不引入新包。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** 受管 worktree 目录池(相对 repo 根)。 */
export const WORKTREE_POOL_SEGMENTS = [".genie", "worktrees"] as const;

export type WorktreeErrorCode =
  | "NOT_GIT"
  | "GIT_UNAVAILABLE"
  | "INVALID_INPUT"
  | "NAME_INVALID"
  | "LIMIT"
  | "CREATE_FAILED"
  | "REMOVE_FAILED"
  | "PATH_OUTSIDE";

export class WorktreeError extends Error {
  constructor(
    public readonly code: WorktreeErrorCode,
    message: string,
    public readonly detail?: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

export interface WorktreeInfo {
  /** 目录名(创建时的 sanitize 后 agentId/name)。 */
  id: string;
  /** 绝对路径。 */
  path: string;
  /** 分支全名(去掉 refs/heads/),如 genie/agent_x。 */
  branch: string;
  /** 创建时 pin 的 commit(worktree list 的 HEAD)。 */
  baseCommit: string;
  repoRoot: string;
  /** 创建时刻(registry 缺失时回退目录 mtime);TTL 清理依据。 */
  createdAt: number;
}

export interface WorktreeCreateInput {
  /** 任意 repo 内目录;用它解析 `git rev-parse --show-toplevel`。 */
  cwd: string;
  /** worktree/分支名(通常=子代理 agentId);缺省 "wt"。 */
  id?: string;
  /** git revision;缺省 HEAD。 */
  base?: string;
  /** 本次调用的上限覆盖(缺省服务配置)。 */
  maxWorktrees?: number;
}

export interface WorktreeRemoveInput {
  cwd: string;
  /** 二选一:受管目录名或绝对路径。 */
  id?: string;
  path?: string;
  /** 显式删除本服务创建的 genie/ 分支(缺省 false=保留)。 */
  deleteBranch?: boolean;
}

export interface WorktreeCleanupInput {
  cwd: string;
  /** 超过该年龄(ms)的受管 worktree 被移除;缺省 7 天。0=全部。 */
  ttlMs?: number;
  dryRun?: boolean;
}

export interface WorktreeRemoveResult {
  removed: boolean;
  path: string;
  branch?: string;
  branchKept: boolean;
}

export interface WorktreeCleanupResult {
  removed: WorktreeInfo[];
  kept: WorktreeInfo[];
  dryRun: boolean;
}

/** :worktree 交付回收(只读 git status,不改任何 git 状态)。 */
export interface WorktreeCollectInput {
 /** 工作树绝对路径(须是 git 工作树)。 */
  path: string;
}

export interface WorktreeCollectResult {
  ok: boolean;
  path: string;
 /** 相对 HEAD 的改动文件(git status --porcelain,去重排序)。 */
  changedFiles: string[];
  error?: { code: WorktreeErrorCode; message: string };
}

export interface WorktreeServiceOptions {
  gitCommand?: string;
  /** 每仓受管 worktree 上限;0=不限。缺省 env GENIE_WORKTREE_MAX 或 8。 */
  maxWorktrees?: number;
  /** TTL 清理缺省年龄;缺省 env GENIE_WORKTREE_TTL_HOURS 或 168h。 */
  defaultTtlMs?: number;
  /** 单条 git 命令超时。 */
  timeoutMs?: number;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RegistryEntry {
  branch: string;
  baseCommit: string;
  createdAt: number;
}

interface RegistryFile {
  version: 1;
  entries: Record<string, RegistryEntry>;
}

interface ParsedWorktree {
  path: string;
  head?: string;
  branch?: string;
}

const DEFAULT_MAX = 8;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REGISTRY_FILE = "registry.json";
const EXCLUDE_LINE = ".genie/worktrees/";

/** 名字清洗:分支/目录只留安全字符;空→wt。导出供测试与脚本复用。 */
export function sanitizeWorktreeName(raw: string): string {
  const cleaned = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "")
    .slice(0, 48);
  return cleaned || "wt";
}

function rand4(): string {
  return Math.random().toString(36).slice(2, 6);
}

/** 路径是否严格位于 root 内(root 本身不算)。 */
function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel.length > 0 && rel !== "." && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes("\0");
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function parseWorktreeList(stdout: string): ParsedWorktree[] {
  const out: ParsedWorktree[] = [];
  let cur: ParsedWorktree | undefined;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (cur?.path) out.push(cur);
      cur = undefined;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (cur?.path) out.push(cur);
      cur = { path: line.slice("worktree ".length) };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("HEAD ")) cur.head = line.slice("HEAD ".length).trim();
    else if (line.startsWith("branch ")) cur.branch = line.slice("branch ".length).trim();
  }
  if (cur?.path) out.push(cur);
  return out;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** git worktree 隔离服务。实例无全局状态(除可选的进程级单例),可按测试构造。 */
export class WorktreeService {
  private readonly gitCommand: string;
  private readonly maxWorktrees: number;
  private readonly defaultTtlMs: number;
  private readonly timeoutMs: number;
  /** registry.json 读-改-写串行化:并行 create 同进程时不丢条目(文件锁只保护 git,不保护本文件)。 */
  private registryQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: WorktreeServiceOptions = {}) {
    this.gitCommand = opts.gitCommand ?? "git";
    const envMax = Number(process.env.GENIE_WORKTREE_MAX);
    this.maxWorktrees = opts.maxWorktrees ?? (Number.isFinite(envMax) ? envMax : DEFAULT_MAX);
    const envTtlHours = Number(process.env.GENIE_WORKTREE_TTL_HOURS);
    this.defaultTtlMs = opts.defaultTtlMs
      ?? (Number.isFinite(envTtlHours) && envTtlHours >= 0 ? envTtlHours * 60 * 60 * 1000 : DEFAULT_TTL_MS);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /** 解析 repo 根;非 git 仓/目录不存在=NOT_GIT(明确报错,不静默回退)。 */
  async resolveRepo(cwd: string): Promise<string> {
    if (!cwd || !isAbsolute(cwd)) {
      throw new WorktreeError("INVALID_INPUT", `worktree: cwd 必须是绝对路径(收到 ${JSON.stringify(cwd)})`);
    }
    let st;
    try {
      st = await stat(cwd);
    } catch {
      throw new WorktreeError("NOT_GIT", `worktree 需要 git 仓:目录不存在 ${cwd}`);
    }
    if (!st.isDirectory()) throw new WorktreeError("NOT_GIT", `worktree 需要 git 仓:不是目录 ${cwd}`);
    const r = await this.git(["rev-parse", "--show-toplevel"], cwd);
    const root = r.stdout.trim().split(/\r?\n/)[0]?.trim();
    if (r.code !== 0 || !root) {
      throw new WorktreeError(
        "NOT_GIT",
        `worktree 需要 git 仓:${cwd} 不是 git 工作树(git rev-parse --show-toplevel 失败)。` +
          `如需在主工作区执行,请去掉 worktree 参数重新派发。`,
        r.stderr.trim(),
      );
    }
    try {
      return await realpath(root);
    } catch {
      return resolve(root);
    }
  }

  /** 创建受管 worktree:目录 <repo>/.genie/worktrees/<id>,分支 genie/<id>,base 缺省 HEAD。 */
  async create(input: WorktreeCreateInput): Promise<WorktreeInfo> {
    const repoRoot = await this.resolveRepo(input.cwd);
    await this.ensureExcluded(repoRoot);
    const pool = this.poolFor(repoRoot);
    const max = input.maxWorktrees ?? this.maxWorktrees;
    const existing = await this.listManaged(repoRoot);
    if (max > 0 && existing.length >= max) {
      throw new WorktreeError(
        "LIMIT",
        `worktree 并发上限 ${max} 已满(当前 ${existing.length} 个受管工作树)。先清理:` +
          `tsx apps/gateway/scripts/worktree-cleanup.ts cleanup --repo ${repoRoot} --ttl-hours 168`,
      );
    }
    const baseRef = String(input.base ?? "HEAD").trim() || "HEAD";
    const baseRun = await this.git(["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], repoRoot);
    if (baseRun.code !== 0) {
      throw new WorktreeError(
        "CREATE_FAILED",
        `worktree base 解析失败(${baseRef}):${baseRun.stderr.trim() || `exit ${baseRun.code}`}`,
      );
    }
    const baseCommit = baseRun.stdout.trim();
    const baseName = sanitizeWorktreeName(input.id ?? "wt");

    let chosen: { id: string; branch: string; path: string } | undefined;
    for (let attempt = 0; attempt < 8 && !chosen; attempt += 1) {
      const id = attempt === 0 ? baseName : `${baseName}-${rand4()}`.slice(0, 52);
      const branch = `genie/${id}`;
      const path = join(pool, id);
      if (existsSync(path)) continue;
      const refCheck = await this.git(["check-ref-format", "--branch", branch], repoRoot);
      if (refCheck.code !== 0) continue;
      const branchExists = await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
      if (branchExists.code === 0) continue;
      chosen = { id, branch, path };
    }
    if (!chosen) {
      throw new WorktreeError("NAME_INVALID", `worktree 名字冲突/非法(已重试 8 次):${baseName}`);
    }

    let addSucceeded = false;
    try {
      const add = await this.withLockRetry(() =>
        this.git(["worktree", "add", "-b", chosen!.branch, chosen!.path, baseCommit], repoRoot),
      );
      if (add.code !== 0) {
        throw new Error(add.stderr.trim() || add.stdout.trim() || `git worktree add exit ${add.code}`);
      }
      addSucceeded = true;
      const st = await stat(chosen.path);
      if (!st.isDirectory()) throw new Error(`worktree 目录未创建:${chosen.path}`);
      if (!isInside(pool, chosen.path)) throw new Error(`worktree 路径越出目录池:${chosen.path}`);
      const info: WorktreeInfo = {
        id: chosen.id,
        path: chosen.path,
        branch: chosen.branch,
        baseCommit,
        repoRoot,
        createdAt: Date.now(),
      };
      await this.writeRegistryEntry(repoRoot, info);
      return info;
    } catch (err) {
      const rollback = await this.rollbackCreate(repoRoot, chosen, addSucceeded);
      throw new WorktreeError(
        "CREATE_FAILED",
        `worktree 创建失败:${errText(err)}(${rollback})`,
        errText(err),
      );
    }
  }

  /** 列出本仓受管 worktree(只含目录池内、git 注册过的)。 */
  async list(input: { cwd: string }): Promise<WorktreeInfo[]> {
    const repoRoot = await this.resolveRepo(input.cwd);
    return this.listManaged(repoRoot);
  }

 /**
 * 交付回收:列出工作树相对 HEAD 的改动文件(git status --porcelain)。
 * 只读、不改 git 状态、不 throw——回收失败如实返回 error,不打断子代理结果交付。
 */
  async collect(input: WorktreeCollectInput): Promise<WorktreeCollectResult> {
    const path = String(input?.path ?? "").trim();
    if (!path || !isAbsolute(path)) {
      return { ok: false, path, changedFiles: [], error: { code: "INVALID_INPUT", message: "collect: path 必须是绝对路径" } };
    }
    if (!existsSync(path)) {
      return { ok: false, path, changedFiles: [], error: { code: "INVALID_INPUT", message: `collect: 路径不存在(${path})` } };
    }
    const r = await this.git(["status", "--porcelain"], path);
    if (r.code === -1) {
      return { ok: false, path, changedFiles: [], error: { code: "GIT_UNAVAILABLE", message: r.stderr } };
    }
    if (r.code !== 0) {
      return { ok: false, path, changedFiles: [], error: { code: "INVALID_INPUT", message: `git status 失败:${r.stderr.trim() || `exit ${r.code}`}` } };
    }
    const files: string[] = [];
    const seen = new Set<string>();
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      const raw = line.slice(3).trim();
      const file = raw.includes(" -> ") ? raw.split(" -> ").pop()!.trim() : raw;
      if (!file || seen.has(file)) continue;
      seen.add(file);
      files.push(file);
      if (files.length >= 200) break;
    }
    files.sort();
    return { ok: true, path, changedFiles: files };
  }

  /** 移除 worktree;缺省保留分支(deleteBranch=true 才删本服务创建的 genie/ 分支)。 */
  async remove(input: WorktreeRemoveInput): Promise<WorktreeRemoveResult> {
    const repoRoot = await this.resolveRepo(input.cwd);
    const pool = this.poolFor(repoRoot);
    let target: string;
    if (input.path) {
      if (!isAbsolute(input.path)) throw new WorktreeError("INVALID_INPUT", "worktree: path 必须是绝对路径");
      target = resolve(input.path);
    } else if (input.id) {
      target = join(pool, sanitizeWorktreeName(input.id));
    } else {
      throw new WorktreeError("INVALID_INPUT", "worktree: remove 需要 id 或 path");
    }
    if (samePath(target, pool) || !isInside(pool, target)) {
      throw new WorktreeError("PATH_OUTSIDE", `worktree: 只能移除目录池 ${pool} 内的受管工作树(${target})`);
    }

    await this.ensureExcluded(repoRoot);
    const before = await this.parsedWorktrees(repoRoot);
    const entry = before.find((e) => samePath(e.path, target));
    const branch = entry?.branch?.replace(/^refs\/heads\//, "") ?? undefined;
    let removed = false;
    if (entry) {
      const r = await this.withLockRetry(() => this.git(["worktree", "remove", "--force", entry.path], repoRoot));
      if (r.code !== 0) {
        await this.git(["worktree", "prune"], repoRoot);
        const after = await this.parsedWorktrees(repoRoot);
        if (after.some((e) => samePath(e.path, target))) {
          throw new WorktreeError(
            "REMOVE_FAILED",
            `git worktree remove 失败:${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`,
          );
        }
      }
      removed = true;
    }
    // 残留目录(git 已不注册/部分失败)只在本池围栏内清理。
    if (existsSync(target)) {
      try {
        await rm(target, { recursive: true, force: true });
        removed = true;
      } catch (err) {
        throw new WorktreeError("REMOVE_FAILED", `删除 worktree 目录失败:${errText(err)}`);
      }
    }
    await this.git(["worktree", "prune"], repoRoot);

    let branchKept = !!branch;
    if (branch && input.deleteBranch) {
      if (branch.startsWith("genie/")) {
        const del = await this.git(["branch", "-D", branch], repoRoot);
        if (del.code === 0) branchKept = false;
      }
      // 非 genie/ 前缀(理论不可达)不删:本服务只拥有 genie/ 分支。
    }
    await this.removeRegistryEntry(repoRoot, basename(target));
    return { removed, path: target, ...(branch ? { branch } : {}), branchKept };
  }

  /** TTL 清理:超过 ttl 的受管 worktree 逐个 remove(默认保留分支);dryRun 只报告。 */
  async cleanup(input: WorktreeCleanupInput): Promise<WorktreeCleanupResult> {
    const repoRoot = await this.resolveRepo(input.cwd);
    await this.ensureExcluded(repoRoot);
    const infos = await this.listManaged(repoRoot);
    const ttl = input.ttlMs ?? this.defaultTtlMs;
    const dryRun = input.dryRun === true;
    const now = Date.now();
    const removed: WorktreeInfo[] = [];
    const kept: WorktreeInfo[] = [];
    for (const info of infos) {
      const age = now - info.createdAt;
      if (info.createdAt > 0 && age < ttl) {
        kept.push(info);
        continue;
      }
      if (dryRun) {
        removed.push(info);
        continue;
      }
      await this.remove({ cwd: repoRoot, id: info.id });
      removed.push(info);
    }
    return { removed, kept, dryRun };
  }

  // ---- internals ----

  private poolFor(repoRoot: string): string {
    return join(repoRoot, ...WORKTREE_POOL_SEGMENTS);
  }

  private async git(args: string[], cwd: string): Promise<GitResult> {
    return await new Promise<GitResult>((res) => {
      execFile(
        this.gitCommand,
        args,
        {
          cwd,
          timeout: this.timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
          if (e && (e.code === "ENOENT" || e.code === "EACCES")) {
            res({ code: -1, stdout: "", stderr: `git 不可用(${this.gitCommand}):${String(e.code)}` });
            return;
          }
          const code = err ? (typeof e?.code === "number" ? (e.code as number) : 1) : 0;
          res({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
    });
  }

  private async parsedWorktrees(repoRoot: string): Promise<ParsedWorktree[]> {
    const r = await this.git(["worktree", "list", "--porcelain"], repoRoot);
    if (r.code === -1) throw new WorktreeError("GIT_UNAVAILABLE", r.stderr);
    if (r.code !== 0) {
      throw new WorktreeError("INVALID_INPUT", `git worktree list 失败:${r.stderr.trim() || `exit ${r.code}`}`);
    }
    return parseWorktreeList(r.stdout);
  }

  private async listManaged(repoRoot: string): Promise<WorktreeInfo[]> {
    const pool = this.poolFor(repoRoot);
    const parsed = await this.parsedWorktrees(repoRoot);
    const registry = await this.readRegistry(repoRoot);
    const infos: WorktreeInfo[] = [];
    for (const entry of parsed) {
      if (!isInside(pool, entry.path)) continue;
      const id = basename(entry.path);
      const reg = registry.entries[id];
      let createdAt = reg?.createdAt ?? 0;
      if (!createdAt) {
        try {
          createdAt = (await stat(entry.path)).mtimeMs;
        } catch {
          createdAt = 0;
        }
      }
      infos.push({
        id,
        path: entry.path,
        branch: entry.branch?.replace(/^refs\/heads\//, "") ?? reg?.branch ?? "",
        baseCommit: entry.head ?? reg?.baseCommit ?? "",
        repoRoot,
        createdAt,
      });
    }
    // 注册表纠偏(进程崩溃/手工 rm 后残留):只保留仍在 git 注册表中且属于本池的条目。
    const liveIds = new Set(infos.map((i) => i.id));
    const stale = Object.keys(registry.entries).filter((id) => !liveIds.has(id));
    if (stale.length) {
      await this.updateRegistry(repoRoot, (reg) => {
        for (const id of stale) delete reg.entries[id];
      });
    }
    return infos;
  }

  /** 兜底:让任意用户仓的主工作区 git status 也看不到目录池(写 .git/info/exclude,不动工作树)。 */
  private async ensureExcluded(repoRoot: string): Promise<void> {
    try {
      const gp = await this.git(["rev-parse", "--git-path", "info/exclude"], repoRoot);
      const relPath = gp.stdout.trim().split(/\r?\n/)[0]?.trim();
      if (gp.code !== 0 || !relPath) return;
      const excludeFile = isAbsolute(relPath) ? relPath : resolve(repoRoot, relPath);
      await mkdir(dirname(excludeFile), { recursive: true });
      const cur = existsSync(excludeFile) ? await readFile(excludeFile, "utf-8") : "";
      const lines = cur.split(/\r?\n/).map((l) => l.trim());
      if (lines.includes(EXCLUDE_LINE)) return;
      const next = `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}# lampgenie-harness subagent worktrees()\n${EXCLUDE_LINE}\n`;
      await writeFile(excludeFile, next, "utf-8");
    } catch {
      // 兜底失败不阻塞创建:仓自己的 .gitignore 可能已覆盖 .genie/。
    }
  }

  private registryPath(repoRoot: string): string {
    return join(this.poolFor(repoRoot), REGISTRY_FILE);
  }

  private async readRegistry(repoRoot: string): Promise<RegistryFile> {
    try {
      const raw = await readFile(this.registryPath(repoRoot), "utf-8");
      const parsed = JSON.parse(raw) as Partial<RegistryFile>;
      const entries = parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object"
        ? parsed.entries
        : {};
      return { version: 1, entries };
    } catch {
      return { version: 1, entries: {} };
    }
  }

  private async writeRegistry(repoRoot: string, registry: RegistryFile): Promise<void> {
    const file = this.registryPath(repoRoot);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${rand4()}.tmp`;
    await writeFile(tmp, JSON.stringify(registry, null, 2), "utf-8");
    await rename(tmp, file);
  }

  private async writeRegistryEntry(repoRoot: string, info: WorktreeInfo): Promise<void> {
    await this.updateRegistry(repoRoot, (registry) => {
      registry.entries[info.id] = { branch: info.branch, baseCommit: info.baseCommit, createdAt: info.createdAt };
    });
  }

  private async removeRegistryEntry(repoRoot: string, id: string): Promise<void> {
    await this.updateRegistry(repoRoot, (registry) => {
      delete registry.entries[id];
    });
  }

  /** registry 读-改-写(串行;并行 create 不丢条目)。 */
  private async updateRegistry(repoRoot: string, mutate: (registry: RegistryFile) => void): Promise<void> {
    const run = this.registryQueue.then(async () => {
      const registry = await this.readRegistry(repoRoot);
      mutate(registry);
      await this.writeRegistry(repoRoot, registry);
    });
    this.registryQueue = run.then(() => undefined, () => undefined);
    await run;
  }

  /** git 元数据锁竞争重试(并行 worktree add 的 .git/worktrees 锁)。 */
  private async withLockRetry(run: () => Promise<GitResult>): Promise<GitResult> {
    let last: GitResult = { code: 0, stdout: "", stderr: "" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await run();
      if (last.code === 0) return last;
      const lockish = /\.lock|unable to (create|lock)|could not lock|cannot lock/i.test(`${last.stderr}\n${last.stdout}`);
      if (!lockish || attempt === 2) return last;
      await new Promise((r) => setTimeout(r, 150));
    }
    return last;
  }

  /** 创建失败回滚:只删本次可能产生、且位于本池内的 worktree/分支/目录。 */
  private async rollbackCreate(
    repoRoot: string,
    chosen: { id: string; branch: string; path: string },
    addSucceeded: boolean): Promise<string> {
    const notes: string[] = [];
    const pool = this.poolFor(repoRoot);
    try {
      const registered = (await this.parsedWorktrees(repoRoot)).some((e) => samePath(e.path, chosen.path));
      if (registered) {
        const r = await this.git(["worktree", "remove", "--force", chosen.path], repoRoot);
        notes.push(r.code === 0 ? "worktree 已回滚" : `worktree 回滚失败:${r.stderr.trim().slice(0, 120)}`);
      }
      await this.git(["worktree", "prune"], repoRoot);
    } catch {
      notes.push("worktree 回滚检查失败");
    }
    if (addSucceeded || (await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${chosen.branch}`], repoRoot)).code === 0) {
      const del = await this.git(["branch", "-D", chosen.branch], repoRoot);
      notes.push(del.code === 0 ? "分支已回滚" : `分支回滚失败:${del.stderr.trim().slice(0, 120)}`);
    }
    if (existsSync(chosen.path) && isInside(pool, chosen.path)) {
      try {
        await rm(chosen.path, { recursive: true, force: true });
        notes.push("目录已回滚");
      } catch (err) {
        notes.push(`目录回滚失败:${errText(err).slice(0, 120)}`);
      }
    }
    await this.removeRegistryEntry(repoRoot, chosen.id).catch(() => undefined);
    return notes.length ? `回滚:${notes.join(";")}` : "回滚:无可清理产物";
  }
}

/** 进程级单例(spawn 接线用;测试可自行 new WorktreeService 隔离). */
let singleton: WorktreeService | undefined;
export function defaultWorktreeService(): WorktreeService {
  singleton ??= new WorktreeService();
  return singleton;
}
