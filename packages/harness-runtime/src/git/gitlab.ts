/**
 * GitLabProvider(designs/06 多平台修订:GitLab@192.168.8.60 一等 provider)。
 * REST API v4(与自建 GitLab 兼容形态同源):MR/成员/群组走 HTTP,clone/push 走 git CLI。
 *
 * 令牌纪律(诚实登记):
 * - token 只用于 HTTP 头(PRIVATE-TOKEN)与 git 子进程环境(askpass,见 ./askpass);
 *   任何错误文案/日志经 redactSecret 清洗,token 绝不出现在异常消息里。
 * - clone/push 不把 token 写盘:credential.helper 清空 + GIT_ASKPASS 供凭据,
 *   remote URL 保持干净(.git/config 不含 token)——exposure window 仅为 git 进程环境。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitProvider, MergeRequest } from "./provider.js";
import { askpassEnv, buildCloneArgs, buildPushArgs } from "./askpass.js";

const execFileP = promisify(execFile);

/** 平台成员信息(成员种子导入的统一输入形态)。 */
export interface PlatformMemberInfo {
  username: string;
  name?: string;
  /** 平台访问级(GitLab:10 Guest/20 Reporter/30 Developer/40 Maintainer/50 Owner)。 */
  accessLevel?: number;
}

export interface GitLabProviderOptions {
  /** 例:http://192.168.8.60(不带尾斜杠也可,内部归一)。 */
  baseUrl: string;
  /** Personal Access Token;绝不入日志/错误文案。 */
  token: string;
  /** 项目标识 "group/repo"(API 调用时 URL-encoded)。 */
  projectPath: string;
  /** https 克隆凭据用户名(PAT 惯例任意非空,默认 oauth2)。 */
  cloneUsername?: string;
  /** 测试注入口(默认 globalThis.fetch)。 */
  fetchImpl?: typeof fetch;
}

/** GitLab v4 原始 MR 形态(只取我们消费的字段)。 */
interface RawMR {
  iid?: number | string;
  id?: number | string;
  title?: string;
  source_branch?: string;
  target_branch?: string;
  state?: string;
  web_url?: string;
}

interface RawMember {
  username?: string;
  name?: string;
  access_level?: number;
}

interface RawGroup {
  path?: string;
  full_path?: string;
  name?: string;
}

interface RawProject {
  path?: string;
  path_with_namespace?: string;
  name?: string;
  http_url_to_repo?: string;
}

function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

export function mapMRState(raw: string | undefined): MergeRequest["state"] {
  if (raw === "merged") return "merged";
  if (raw === "opened") return "open";
  return "closed";
}

export function mapRawMR(raw: RawMR): MergeRequest {
  return {
    id: String(raw.iid ?? raw.id ?? ""),
    title: raw.title ?? "",
    sourceBranch: raw.source_branch ?? "",
    targetBranch: raw.target_branch ?? "",
    state: mapMRState(raw.state),
    url: raw.web_url ?? "",
  };
}

type Query = Record<string, string | number | undefined>;

interface ApiInit {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Query;
}

/**
 * GitLab REST v4 共享底座(CodeupProvider 复用:Codeup API 与 GitLab v4 形态高度同源)。
 * 子类可覆写 extraQuery 注入平台差异参数(如云效 organizationId)。
 */
export class RestV4ProviderBase implements GitProvider {
  readonly kind: string = "gitlab";
  protected readonly baseUrl: string;
  protected readonly token: string;
  protected readonly projectPath: string;
  protected readonly cloneUsername: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GitLabProviderOptions) {
    if (!opts.token) throw new Error("gitlab provider:缺少 token");
    if (!opts.projectPath) throw new Error("gitlab provider:缺少 projectPath");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.projectPath = opts.projectPath;
    this.cloneUsername = opts.cloneUsername ?? "oauth2";
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /** 平台差异 query(默认无;Codeup 覆写为 organizationId)。 */
  protected extraQuery(): Query {
    return {};
  }

  /** :id 形态:数字原样(Codeup 数字项目 ID),路径形态 URL-encoded(GitLab group/repo)。 */
  protected get projectId(): string {
    return /^\d+$/.test(this.projectPath) ? this.projectPath : encodeURIComponent(this.projectPath);
  }

  protected async api<T>(path: string, init?: ApiInit): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v4${path}`);
    const query = { ...this.extraQuery(), ...init?.query };
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: init?.method ?? "GET",
        headers: { "PRIVATE-TOKEN": this.token, "Content-Type": "application/json" },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (err) {
      throw new Error(`git api ${init?.method ?? "GET"} ${path} 失败:${redactSecret(String(err), this.token)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `git api ${init?.method ?? "GET"} ${path} → HTTP ${res.status}:${redactSecret(text.slice(0, 300), this.token)}`,
      );
    }
    return (await res.json()) as T;
  }

  /** 分页拉全(per_page=100;护栏 50 页防端点异常时的死循环)。 */
  protected async apiPaged<T>(path: string, query?: Query): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const rows = await this.api<T[]>(path, { query: { ...query, per_page: 100, page } });
      out.push(...rows);
      if (rows.length < 100) break;
    }
    return out;
  }

  /**
   * 推分支到 origin(与 CustomGitProvider 同语义:调用方只管本地提交,provider 负责上远端)。
   * 凭据经 askpass 环境供给,remote/config 不落 token。
   */
  protected async pushBranch(repoPath: string, branch: string): Promise<void> {
    await execFileP("git", buildPushArgs("origin", branch), {
      cwd: repoPath,
      env: { ...process.env, ...(await askpassEnv(this.token, this.cloneUsername)) },
    });
  }

  /** GitProvider.push(引导/手动操作)。 */
  async push(repoPath: string, branch: string): Promise<void> {
    await this.pushBranch(repoPath, branch);
  }

  async clone(repoUrl: string, dest: string): Promise<void> {
    await execFileP("git", buildCloneArgs(repoUrl, dest), {
      cwd: process.cwd(),
      env: { ...process.env, ...(await askpassEnv(this.token, this.cloneUsername)) },
    });
  }

  async createMR(input: { repoPath: string; sourceBranch: string; targetBranch: string; title: string; body: string }): Promise<MergeRequest> {
    await this.pushBranch(input.repoPath, input.sourceBranch);
    const raw = await this.api<RawMR>(`/projects/${this.projectId}/merge_requests`, {
      method: "POST",
      body: {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
        description: input.body,
      },
    });
    return mapRawMR(raw);
  }

  async listMR(input: { repoPath: string; state?: "open" | "merged" | "closed" }): Promise<MergeRequest[]> {
    const state = input.state ?? "open";
    const rows = await this.api<RawMR[]>(`/projects/${this.projectId}/merge_requests`, {
      query: { state: state === "open" ? "opened" : state, per_page: 100 },
    });
    return rows.map(mapRawMR);
  }

  /** 项目成员(分页拉全;成员种子导入输入)。 */
  async listMembers(): Promise<PlatformMemberInfo[]> {
    const rows = await this.apiPaged<RawMember>(`/projects/${this.projectId}/members`);
    return rows
      .filter((m) => !!m.username)
      .map((m) => ({ username: m.username!, name: m.name ?? m.username, accessLevel: m.access_level }));
  }

  /** 群组清单(R7 team 绑定用)。 */
  async listGroups(): Promise<{ path: string; fullPath: string; name: string }[]> {
    const rows = await this.apiPaged<RawGroup>("/groups");
    return rows
      .filter((g) => !!g.full_path)
      .map((g) => ({ path: g.path ?? "", fullPath: g.full_path!, name: g.name ?? g.path ?? "" }));
  }

  /** 群组下项目清单(R7:team 项目=group 下的代码库)。 */
  async listGroupProjects(groupPath: string): Promise<{ path: string; fullPath: string; name: string; httpUrl: string }[]> {
    const id = /^\d+$/.test(groupPath) ? groupPath : encodeURIComponent(groupPath);
    const rows = await this.apiPaged<RawProject>(`/groups/${id}/projects`);
    return rows.map((p) => ({
      path: p.path ?? "",
      fullPath: p.path_with_namespace ?? "",
      name: p.name ?? p.path ?? "",
      httpUrl: p.http_url_to_repo ?? "",
    }));
  }
}

/** GitLab 一等 provider(designs/06 §R7-5:二期首版;kind="gitlab" 继承自底座)。 */
export class GitLabProvider extends RestV4ProviderBase {}
