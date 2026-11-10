/**
 * GitProvider 抽象( R7):统一 clone/MR/webhook 操作面。
 * 实现:Codeup / GitLab / GitHub / 自定义降级。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface MergeRequest {
  id: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  state: "open" | "merged" | "closed";
  url: string;
}

export interface GitProvider {
  readonly kind: string;
  /** git 克隆。 */
  clone(repoUrl: string, dest: string): Promise<void>;
  /** 发起 MR。 */
  createMR(input: { repoPath: string; sourceBranch: string; targetBranch: string; title: string; body: string }): Promise<MergeRequest>;
  /** 推送一个分支(团队仓引导/手动操作;平台 provider 用 askpass,remote/config 不落 token)。 */
  push(repoPath: string, branch: string): Promise<void>;
  /** 列出 MR。 */
  listMR(input: { repoPath: string; state?: "open" | "merged" | "closed" }): Promise<MergeRequest[]>;
}

/** 纯 git 命令底座(各 provider 共用)。 */
export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd });
  return stdout.trim();
}

/** 自定义/裸 git 降级:MR=分支推送+通知,无平台 API。 */
export class CustomGitProvider implements GitProvider {
  readonly kind = "custom";
  async clone(repoUrl: string, dest: string): Promise<void> {
    await git(["clone", repoUrl, dest], process.cwd());
  }
  async createMR(input: { repoPath: string; sourceBranch: string; targetBranch: string; title: string; body: string }): Promise<MergeRequest> {
    // 降级:推送分支,返回一个「待人工合并」的伪 MR
    await git(["push", "origin", input.sourceBranch], input.repoPath);
    return {
      id: `branch:${input.sourceBranch}`,
      title: input.title,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      state: "open",
      url: "",
    };
  }
  async push(repoPath: string, branch: string): Promise<void> {
    await git(["push", "origin", branch], repoPath);
  }
  async listMR(): Promise<MergeRequest[]> {
    return []; // 降级:无平台 API,MR 靠人工/轮询分支
  }
}
