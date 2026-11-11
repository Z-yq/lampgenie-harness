/**
 * 开工画像(work start profile):编码任务开工/会话恢复时的只读探测 + 稳定前缀渲染。
 * 定位:把「本仓现在长什么样」和「本仓可用的验证命令」压成一段**确定性文本**塞进 system 稳定前缀。
 * 为什么 verify 命令要进稳定前缀:
 * - 验证命令是本仓真值(git 分支/包管理器/scripts.test 现读),不是模型猜的;模型自猜命令
 * (`npm test` 撞 pnpm workspace)会白烧一轮验证;
 * - system 前缀每步重发,但逐字不变 → prompt cache 命中,增量成本≈0;若改成「按需推送 tip」,
 * 每步都要重新决定注不注,反而增加失配与膨胀风险。
 * 为什么探测失败不能阻塞开工:
 * - 开工信息是**增益**不是前置条件:git 缺失/工作区异常/detached HEAD 时任务照样能做;
 * - 逐项 fail-soft(字段 undefined + errors[] 留痕),渲染侧把失败显式写进 brief,
 * 让模型知道「这条没探到」而不是以为仓库干净。
 * 约束:探测只读(git 只跑只读子命令,文件 IO 只 stat/读 manifests);纯函数渲染、同输入同输出;
 * 本模块任何路径都不 throw。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { START_BRIEF_STOP_RULES } from "./agent-wiring-sop-tips.js";

/** 注入式 exec(git 命令执行;测试替换为假实现,生产接 execFileSync)。 */
export interface WorkStartExecOpts {
  cwd?: string;
  timeoutMs?: number;
}

export type WorkStartExec = (
  cmd: string,
  args: string[],
  opts?: WorkStartExecOpts) => { ok: boolean; stdout: string; stderr: string };

export interface WorkStartProbeInput {
  root: string;
  exec: WorkStartExec;
}

/** 仓库根下的包清单存在性(只 stat,不读内容)。 */
export interface WorkStartManifests {
  packageJson: boolean;
  pnpmWorkspace: boolean;
  pyproject: boolean;
  cargo: boolean;
  goMod: boolean;
}

export interface WorkStartProbeError {
  probe: string;
  error: string;
}

export type WorkStartPackageManager = "pnpm" | "yarn" | "npm" | "uv" | "pip" | "cargo" | "go";

export interface WorkStartProfile {
  root: string;
  branch?: string;
  dirtyFiles?: number;
 /** `git log -5 --oneline` 的逐行原文(已 trim)。 */
  commits?: string[];
 /** `git worktree list --porcelain` 里的 worktree 路径。 */
  worktrees?: string[];
  manifests: WorkStartManifests;
  packageManager?: WorkStartPackageManager;
 /** package.json scripts.test 原文(verifyCommandsFor 的判据之一)。 */
  testScript?: string;
  errors: WorkStartProbeError[];
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  const s = String(err ?? "");
  return s || "unknown error";
}

/** 单文件存在性;fs 抛错(权限/路径异常)也 fail-soft 记 errors。 */
function existsSoft(root: string, name: string, errors: WorkStartProbeError[], probe = `manifest:${name}`): boolean {
  try {
    return existsSync(join(root, name));
  } catch (err) {
    errors.push({ probe, error: errMsg(err) });
    return false;
  }
}

/**
 * 探测开工画像。任何单项失败只落 errors,整体恒返回 profile(绝不 throw)。
 * 分支/脏文件数/近期提交/worktree 四项走注入的 exec(git);manifest 与包管理器走 fs。
 */
export async function probeWorkStart(input: WorkStartProbeInput): Promise<WorkStartProfile> {
  const root = String(input?.root ?? "");
  const errors: WorkStartProbeError[] = [];
  const profile: WorkStartProfile = {
    root,
    manifests: { packageJson: false, pnpmWorkspace: false, pyproject: false, cargo: false, goMod: false },
    errors,
  };
 /** 跑一条只读 git 命令;失败返回 undefined 并落 errors(不抛)。 */
  const runGit = (probe: string, args: string[]): string | undefined => {
    try {
      const r = input.exec("git", args, { cwd: root, timeoutMs: 3000 });
      if (!r || r.ok !== true) {
        errors.push({ probe, error: String(r?.stderr ?? "").trim() || "命令失败" });
        return undefined;
      }
      return String(r.stdout ?? "");
    } catch (err) {
      errors.push({ probe, error: errMsg(err) });
      return undefined;
    }
  };

  const branchOut = runGit("branch", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branchOut !== undefined) profile.branch = branchOut.trim() || "(detached)";

  const statusOut = runGit("status", ["status", "--porcelain"]);
  if (statusOut !== undefined) profile.dirtyFiles = statusOut.split("\n").filter((l) => l.trim().length > 0).length;

  const logOut = runGit("log", ["log", "-5", "--oneline"]);
  if (logOut !== undefined) profile.commits = logOut.split("\n").map((l) => l.trim()).filter(Boolean);

  const wtOut = runGit("worktree", ["worktree", "list", "--porcelain"]);
  if (wtOut !== undefined) {
    profile.worktrees = wtOut
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim())
      .filter(Boolean);
  }

  profile.manifests.packageJson = existsSoft(root, "package.json", errors);
  profile.manifests.pnpmWorkspace = existsSoft(root, "pnpm-workspace.yaml", errors);
  profile.manifests.pyproject = existsSoft(root, "pyproject.toml", errors);
  profile.manifests.cargo = existsSoft(root, "Cargo.toml", errors);
  profile.manifests.goMod = existsSoft(root, "go.mod", errors);

 // scripts.test 只读 package.json 的 scripts 段(判「是否有可执行的 test 入口」)。
  if (profile.manifests.packageJson) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
      const t = pkg?.scripts?.test;
      if (typeof t === "string" && t.trim()) profile.testScript = t.trim();
    } catch (err) {
      errors.push({ probe: "package.json", error: errMsg(err) });
    }
  }

 // 包管理器判定(顺序即优先级:锁文件 > 生态清单)。
  const pnpmLock = existsSoft(root, "pnpm-lock.yaml", errors, "lock:pnpm-lock.yaml");
  const yarnLock = existsSoft(root, "yarn.lock", errors, "lock:yarn.lock");
  const npmLock = existsSoft(root, "package-lock.json", errors, "lock:package-lock.json");
  const uvLock = profile.manifests.pyproject ? existsSoft(root, "uv.lock", errors, "lock:uv.lock") : false;
  if (pnpmLock) profile.packageManager = "pnpm";
  else if (yarnLock) profile.packageManager = "yarn";
  else if (npmLock) profile.packageManager = "npm";
  else if (profile.manifests.pyproject) profile.packageManager = uvLock ? "uv" : "pip";
  else if (profile.manifests.cargo) profile.packageManager = "cargo";
  else if (profile.manifests.goMod) profile.packageManager = "go";

  return profile;
}

/** verify 命令上限(稳定前缀不是清单;>5 条就淹掉停止规则)。 */
export const VERIFY_COMMANDS_MAX = 5;

/**
 * 由画像推导可执行 verify 命令(去重、最多 VERIFY_COMMANDS_MAX 条、没有=[])。
 * 只挑「本仓真能跑」的:workspace 全量 build/test、单包 scripts.test、python/cargo/go 生态默认命令。
 */
export function verifyCommandsFor(profile: WorkStartProfile): string[] {
  const out: string[] = [];
  const add = (cmd: string): void => {
    if (out.length < VERIFY_COMMANDS_MAX && !out.includes(cmd)) out.push(cmd);
  };
  const m = profile.manifests ?? { packageJson: false, pnpmWorkspace: false, pyproject: false, cargo: false, goMod: false };
  if (m.pnpmWorkspace) {
    add("pnpm -r run build");
    add("pnpm -r test");
  }
  if (m.packageJson && profile.testScript) {
    add(profile.packageManager === "npm" ? "npm test" : profile.packageManager === "yarn" ? "yarn test" : "pnpm test");
  }
  if (m.pyproject) add("pytest -q");
  if (m.cargo) add("cargo test");
  if (m.goMod) add("go test ./...");
  return out.slice(0, VERIFY_COMMANDS_MAX);
}

/** brief 总长上限(字符);超出按「验证命令 → commits → worktree」顺序裁剪。 */
export const WORK_START_BRIEF_MAX_CHARS = 1200;

/** 头部 root 展示上限(防超长路径把停止规则挤掉;root 不参与裁剪优先级)。 */
const ROOT_DISPLAY_MAX = 100;

/** 按模型家族给编辑格式提示:gpt/codex/o 系列吃 apply_patch 补丁;其余走 edit_file 精确替换。 */
export function editFormatHint(modelFamily?: string): string {
  const f = String(modelFamily ?? "").toLowerCase();
  if (f && /gpt|codex|(^|[^a-z0-9])o[134]([^0-9]|$)/.test(f)) {
    return "编辑格式: gpt 家族 → 优先 apply_patch 补丁式编辑(patch 失败先重读文件再改)";
  }
  return "编辑格式: edit_file 精确替换(先 read_file 定位,patch 失败先重读再改)";
}

function clipRoot(root: string): string {
  const r = String(root || "?");
  return r.length > ROOT_DISPLAY_MAX ? "…" + r.slice(r.length - ROOT_DISPLAY_MAX) : r;
}

/**
 * 渲染开工 brief(纯函数、确定性:无时间戳/无随机数,同输入逐字同输出)。
 * 裁剪优先级:验证命令 → commits → worktree;停止规则、编辑提示、探测失败行永不裁。
 */
export function renderWorkStartBrief(profile: WorkStartProfile, opts: { modelFamily?: string } = {}): string {
  const branch = profile.branch ?? "?";
  const dirty = profile.dirtyFiles === undefined ? "?" : String(profile.dirtyFiles);
  const commits = profile.commits?.length ?? 0;
  const header = `开工画像(root=${clipRoot(profile.root)} branch=${branch} dirty=${dirty} commits=${commits})`;
  const verify = verifyCommandsFor(profile);
  const commitLines = (profile.commits ?? []).map((c) => "- " + c);
  const worktreeLines = (profile.worktrees ?? []).length > 1 ? (profile.worktrees ?? []).map((w) => "- worktree " + w) : [];
  const errLine = profile.errors.length
    ? "探测失败: " + profile.errors.map((e) => `${e.probe}=${e.error}`).join("; ")
    : "";

 // 永不裁剪的骨架:头部 + 停止规则 + 编辑格式(顺序固定 = 稳定前缀)。
  const fixed: string[] = [
    header,
    "停止规则:",
    ...START_BRIEF_STOP_RULES.map((l, i) => `${i + 1}. ${l}`),
    editFormatHint(opts.modelFamily),
  ];

  const build = (keepVerify: boolean, keepCommits: boolean, keepWorktree: boolean): string[] => {
    const parts = fixed.slice();
    if (keepVerify && verify.length) parts.splice(1, 0, "验证命令:", ...verify.map((c) => "- " + c));
    if (keepCommits && commitLines.length) parts.push("近期提交:", ...commitLines);
    if (keepWorktree && worktreeLines.length) parts.push("worktree:", ...worktreeLines);
    return parts;
  };
 // 裁剪档位:全量 → 去验证命令 → 去 commits → 去 worktree。
  const levels: Array<[boolean, boolean, boolean]> = [
    [true, true, true],
    [false, true, true],
    [false, false, true],
    [false, false, false],
  ];
  for (const [v, c, w] of levels) {
    const parts = build(v, c, w);
    if (errLine) parts.push(errLine);
    const text = parts.join("\n");
    if (text.length <= WORK_START_BRIEF_MAX_CHARS) return text;
  }
 // 极端档:骨架 + 截断后的 errors 行(停止规则仍全量保留)。
  const base = build(false, false, false).join("\n");
  if (!errLine) return base.slice(0, Math.max(0, WORK_START_BRIEF_MAX_CHARS));
  const room = WORK_START_BRIEF_MAX_CHARS - base.length - 1;
  if (room <= 4) return base.slice(0, Math.max(0, WORK_START_BRIEF_MAX_CHARS));
  return base + "\n" + errLine.slice(0, room);
}
