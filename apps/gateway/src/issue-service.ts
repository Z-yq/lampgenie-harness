/**
 * Issue 双通道统一抽象(fixD2):github/gitlab 原生 issue(API token 在场)优先,
 * 否则自动降级仓内自建 .genie/issues/(git 提交即多人共享,零配置)。
 * 红线:①服务零 git 写——RepoIssues 只落 JSON 文件,不自动 commit/push(面板「同步到 git」
 * 按钮显式调 git-service);②token 只从 env / .genie/secrets.json(600) 取,绝不入 git/配置;
 * ③变更统一 bus.emit("issue.changed"),面板/对端实例据此刷新。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { bus } from "@lampgenie/core";
import { detectGitHost, type GitHostInfo } from "./git-host.js";
import { gitRemoteUrl } from "./git-service.js";
import {
  buildWriteBackEvent,
  hasWriteBack,
  terminalWriteBackPlan,
  writeBackKey,
  type JournalLike,
  type TerminalTaskState,
} from "./issue-task-link.js";

export type IssueStatus = "todo" | "doing" | "done";

export interface IssueComment {
  author: string;
  body: string;
  at: number;
}

export interface IssueRecord {
  number: number;
  title: string;
  body: string;
  status: IssueStatus;
  assignee?: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
  /** 派发任务关联(确认派发后回填;终态回写据此路由)。 */
  taskId?: string;
  comments: IssueComment[];
}

export interface IssueCreateInput {
  projectId: string;
  title: string;
  body?: string;
  assignee?: string;
}

export interface IssuePatch {
  status?: IssueStatus;
  assignee?: string;
  taskId?: string;
}

/**  终态回写结果(OK=已写;DUPLICATE=幂等命中;NOT_FOUND/INVALID=未写且可重试)。 */
export interface IssueWriteBackResult {
  ok: boolean;
  code: "OK" | "DUPLICATE" | "NOT_FOUND" | "INVALID";
  written?: boolean;
  error?: string;
}

export interface IssueWriteBackInput {
  projectId: string;
  number: number;
  taskId: string;
  state: TerminalTaskState | string;
  journal: JournalLike;
  sessionId: string;
}

export interface IssueChannel {
  readonly kind: "github" | "gitlab" | "repo";
  list(projectId: string): Promise<IssueRecord[]>;
  create(input: IssueCreateInput): Promise<IssueRecord>;
  update(projectId: string, number: number, patch: IssuePatch): Promise<IssueRecord | null>;
  comment(projectId: string, number: number, author: string, body: string): Promise<boolean>;
 /**  终态回写钩子(可选):通道可自定义幂等/失败语义;
 * 缺省(RepoIssues/GitHub/GitLab 均未实现)= writeBackIssueTask 走既有 update/comment,零新增网络语义。 */
  writeBack?(input: IssueWriteBackInput): Promise<IssueWriteBackResult>;
}

/** fetch 注入面(单测/自签 https 场景替换;缺省 globalThis.fetch)。 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// ---- token 解析(同 resolveTrackApiKey 链:env > .genie/secrets.json;值绝不回显) ----

export function resolveIssueToken(kind: "github" | "gitlab", repoRoot: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const envName = kind === "github" ? "GENIE_GITHUB_TOKEN" : "GENIE_GITLAB_TOKEN";
  const secretName = kind === "github" ? "githubToken" : "gitlabToken";
  if (env[envName]) return env[envName];
  try {
    const p = join(repoRoot, ".genie", "secrets.json");
    if (!existsSync(p)) return undefined;
    const secrets = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    const v = secrets[secretName];
    return typeof v === "string" && v ? v : undefined;
  } catch {
    return undefined;
  }
}

// ---- RepoIssues:仓内自建(.genie/issues/ISSUE-<n>.json;服务零 git 写) ----

function issueFile(projectRoot: string, n: number): string {
  return join(projectRoot, ".genie", "issues", `ISSUE-${n}.json`);
}

/** 原子替换写:先写同目录临时文件再 rename(同分区 rename 是原子操作)。
 * 直写目标文件时,进程崩溃/断电会留下半截 JSON,而 loadAll 对损坏文件是「静默跳过」——
 * 表现为 issue 无声消失(与并发编号覆盖同类的丢单,只是触发条件是崩溃而非并发)。
 * 临时名带 pid+随机后缀,避免多实例互相覆盖临时文件。 */
function writeAtomic(target: string, content: string): void {
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, target);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 尽力回收临时文件 */ }
    throw err;
  }
}

export class RepoIssues implements IssueChannel {
  readonly kind = "repo" as const;
  constructor(private readonly projectRoot: string) {}

  private loadAll(): IssueRecord[] {
    const dir = join(this.projectRoot, ".genie", "issues");
    if (!existsSync(dir)) return [];
    const out: IssueRecord[] = [];
    for (const f of readdirSync(dir)) {
      const m = f.match(/^ISSUE-(\d+)\.json$/);
      if (!m) continue;
      try {
        const rec = JSON.parse(readFileSync(join(dir, f), "utf-8")) as IssueRecord;
        if (typeof rec.number === "number" && typeof rec.title === "string") out.push(rec);
      } catch {
        // 损坏文件跳过(容忍;不猜内容)
      }
    }
    return out.sort((a, b) => a.number - b.number);
  }

  async list(): Promise<IssueRecord[]> {
    return this.loadAll();
  }

  async create(input: IssueCreateInput): Promise<IssueRecord> {
    const all = this.loadAll();
    let n = (all.length ? Math.max(...all.map((r) => r.number)) : 0) + 1;
    const now = Date.now();
    mkdirSync(join(this.projectRoot, ".genie", "issues"), { recursive: true });
    // 并发安全(多成员共享 .genie/issues):编号分配不能用「读 max + 写覆盖」——两个实例各自
    // 读到同一个 max 时会写同一个文件名,后者静默覆盖前者(丢单)。改为 wx 独占创建:占号失败
 // (EEXIST=对端刚占了这号)就顺延重试;上限 50 次后放弃并如用户反馈错(不自造编号)。
    for (let attempt = 0; attempt < 50; attempt++, n++) {
      const rec: IssueRecord = {
        number: n,
        title: input.title,
        body: input.body ?? "",
        status: "todo",
        ...(input.assignee ? { assignee: input.assignee } : {}),
        projectId: input.projectId,
        createdAt: now,
        updatedAt: now,
        comments: [],
      };
      const f = issueFile(this.projectRoot, n);
      let fd: number | null = null;
      try {
        fd = openSync(f, "wx");
      } catch (err) {
        if ((err as { code?: string }).code === "EEXIST") continue; // 号被对端占用 → 顺延
        throw err;
      }
      try {
        writeSync(fd, JSON.stringify(rec, null, 2));
      } catch (err) {
        closeSync(fd);
        fd = null;
        try { unlinkSync(f); } catch { /* 尽力回收半截文件 */ }
        throw err;
      }
      closeSync(fd);
      return rec;
    }
    throw new Error("issue 编号分配失败:连续 50 次撞号(.genie/issues 并发写入异常)");
  }

  async update(_projectId: string, number: number, patch: IssuePatch): Promise<IssueRecord | null> {
    const f = issueFile(this.projectRoot, number);
    if (!existsSync(f)) return null;
    const rec = JSON.parse(readFileSync(f, "utf-8")) as IssueRecord;
    if (patch.status !== undefined) rec.status = patch.status;
    if (patch.assignee !== undefined) rec.assignee = patch.assignee;
    if (patch.taskId !== undefined) rec.taskId = patch.taskId;
    rec.updatedAt = Date.now();
    writeAtomic(f, JSON.stringify(rec, null, 2));
    return rec;
  }

  async comment(_projectId: string, number: number, author: string, body: string): Promise<boolean> {
    const f = issueFile(this.projectRoot, number);
    if (!existsSync(f)) return false;
    const rec = JSON.parse(readFileSync(f, "utf-8")) as IssueRecord;
    rec.comments.push({ author, body, at: Date.now() });
    rec.updatedAt = Date.now();
    writeAtomic(f, JSON.stringify(rec, null, 2));
    return true;
  }
}

// ---- GithubIssues / GitlabIssues:原生 REST(token 在场;fetch 可注入) ----

const STATUS_LABEL: Record<IssueStatus, string> = { todo: "status:todo", doing: "status:doing", done: "status:done" };

/** 平台差异的集中表。
 * 收敛动机(经验证踩过):平台差异原先散落在 list/create/update/comment/toRecord 五处 if 分支,
 * 每加一处分支就有一次「只改 GitHub 忘了 GitLab」的静默失效(评论端点、state 取值、
 * 标签形状、指派人形状各错过一次)。现在所有差异只在这两张表里,新增差异加字段即可。 */
interface PlatformProfile {
  /** list 的 state 查询值(GitHub=open,GitLab=opened)。 */
  listState: string;
  /** 项目 REST 路径前缀。 */
  repoPath(info: GitHostInfo): string;
  /** issue 编号字段(GitHub=number,GitLab=iid)。 */
  numberOf(raw: Record<string, unknown>): number;
  /** 评论端点(GitHub=/comments,GitLab=/notes)。 */
  commentPath(repoPath: string, number: number): string;
  /** 创建载荷里的 labels 字段(GitHub=数组,GitLab=逗号串)。 */
  labelsField(label: string): Record<string, unknown>;
  /** 更新请求的动词与载荷(GitLab 用 PUT + add/remove_labels)。 */
  updateRequest(status: IssueStatus): { method: string; body: Record<string, unknown> };
  /** 回读标签名(GitHub=[{name}],GitLab=[string])。 */
  labelNames(rawLabels: unknown): string[];
  /** 回读指派人(GitHub=assignee{login},GitLab=assignees[{username}])。 */
  assigneeName(raw: Record<string, unknown>): string | undefined;
  /** 创建载荷的指派人字段(GitHub=assignees[用户名],GitLab=assignee_ids[解析出的 id])。 */
  assigneeField(username: string, resolveId: (u: string) => Promise<number | null>): Promise<Record<string, unknown>>;
}

function nameOfAssignee(v: unknown): string | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as { login?: string; username?: string };
  const name = String(o.login ?? o.username ?? "");
  return name || undefined;
}

const GITHUB_PROFILE: PlatformProfile = {
  listState: "open",
  repoPath: (info) => `/repos/${info.repo}`,
  numberOf: (raw) => Number(raw.number),
  commentPath: (repoPath, n) => `${repoPath}/issues/${n}/comments`,
  labelsField: (label) => ({ labels: [label] }),
  updateRequest: (status) => ({ method: "PATCH", body: { labels: [STATUS_LABEL[status]] } }),
  labelNames: (rawLabels) =>
    (Array.isArray(rawLabels) ? rawLabels : []).map((l) => (typeof l === "string" ? l : String((l as { name?: string })?.name ?? ""))),
  assigneeName: (raw) => nameOfAssignee(raw.assignee) ?? (Array.isArray(raw.assignees) ? nameOfAssignee((raw.assignees as unknown[])[0]) : undefined),
  assigneeField: async (username) => ({ assignees: [username] }),
};

const GITLAB_PROFILE: PlatformProfile = {
  listState: "opened",
  // 项目标识必须整段编码成 group%2Fproject,且必须是完整命名空间路径(只取末两段在子组场景会 404)。
  repoPath: (info) => `/projects/${encodeURIComponent(info.fullPath ?? info.repo ?? "")}`,
  numberOf: (raw) => Number(raw.iid ?? raw.number),
  commentPath: (repoPath, n) => `${repoPath}/issues/${n}/notes`,
  labelsField: (label) => ({ labels: label }),
  updateRequest: (status) => ({
    method: "PUT",
    body: {
      add_labels: STATUS_LABEL[status],
      remove_labels: Object.values(STATUS_LABEL).filter((l) => l !== STATUS_LABEL[status]).join(","),
    },
  }),
  // GitLab 标签是字符串数组。
  labelNames: (rawLabels) => (Array.isArray(rawLabels) ? rawLabels.map((l) => (typeof l === "string" ? l : String((l as { name?: string })?.name ?? ""))) : []),
  assigneeName: (raw) => nameOfAssignee(raw.assignee) ?? (Array.isArray(raw.assignees) ? nameOfAssignee((raw.assignees as unknown[])[0]) : undefined),
  // 解析不到 id 时不指派(发非法参数会把整个 create 打成 400)。
  assigneeField: async (username, resolveId) => {
    const id = await resolveId(username);
    return id === null ? {} : { assignee_ids: [id] };
  },
};

class NativeIssues implements IssueChannel {
  constructor(
    private readonly info: GitHostInfo,
    private readonly token: string,
    private readonly fetchImpl: FetchLike,
    private readonly user: string) {}

  get kind(): "github" | "gitlab" {
    return this.info.kind === "github" ? "github" : "gitlab";
  }

  /** 平台差异唯一入口(见 PlatformProfile;不要在下面各处再写 kind 分支)。 */
  private get platform(): PlatformProfile {
    return this.kind === "github" ? GITHUB_PROFILE : GITLAB_PROFILE;
  }

  private async api(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: unknown }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    const res = await this.fetchImpl(this.info.apiBase + path, { ...init, headers });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  }

  /** 原生 issue → 统一记录:status 从 status:* 标签读(无=todo);taskId 从 marker 评论读。 */
  private async toRecord(raw: Record<string, unknown>, projectId: string): Promise<IssueRecord> {
    // 标签形状两平台不同:GitHub=对象数组 [{name}];GitLab=字符串数组 ["status:todo"]。
    // 此前只处理对象数组——GitLab 记录的状态恒为 todo(拖拽回读永远还原成待办)。
    const labels = this.platform.labelNames(raw.labels);
    const status: IssueStatus = labels.includes(STATUS_LABEL.done) ? "done" : labels.includes(STATUS_LABEL.doing) ? "doing" : "todo";
    const num = this.platform.numberOf(raw);
    const assignee = this.platform.assigneeName(raw);
    const rec: IssueRecord = {
      number: num,
      title: String(raw.title ?? ""),
      body: String(raw.body ?? ""),
      status,
      ...(assignee ? { assignee } : {}),
      projectId,
      createdAt: Date.parse(String(raw.created_at ?? "")) || Date.now(),
      updatedAt: Date.now(),
      comments: [],
    };
    return rec;
  }

  /** GitLab 指派人必须用 assignee_ids(number[]);用户名 → id 解析(带会话内缓存)。
   * 解析失败=不指派(而不是发一个非法参数把整个 create 打成 400)。 */
  private userIdCache = new Map<string, number | null>();
  private async resolveUserId(username: string): Promise<number | null> {
    if (this.userIdCache.has(username)) return this.userIdCache.get(username) ?? null;
    const r = await this.api(`/users?username=${encodeURIComponent(username)}`).catch(() => null);
    const arr = r && r.ok && Array.isArray(r.data) ? (r.data as { id?: number }[]) : [];
    const id = arr.length && typeof arr[0]?.id === "number" ? arr[0].id! : null;
    this.userIdCache.set(username, id);
    return id;
  }

  private repoPath(): string {
    return this.platform.repoPath(this.info);
  }

  async list(projectId: string): Promise<IssueRecord[]> {
    // state 取值差异见 GITHUB_PROFILE/GITLAB_PROFILE(GitLab 只认 opened,发 open 会 400)。
    const r = await this.api(`${this.repoPath()}/issues?state=${this.platform.listState}&per_page=50`);
    if (!r.ok) throw new Error(`list 失败 HTTP ${r.status}`);
    const arr = Array.isArray(r.data) ? (r.data as Record<string, unknown>[]) : [];
    return Promise.all(arr.filter((x) => !x.pull_request).map((x) => this.toRecord(x, projectId)));
  }

  async create(input: IssueCreateInput): Promise<IssueRecord> {
    // labels 形状与指派人字段差异都在 platform 表里(GitLab:逗号串 + assignee_ids)。
    const payload: Record<string, unknown> = {
      title: input.title,
      body: input.body ?? "",
      ...this.platform.labelsField(STATUS_LABEL.todo),
    };
    if (input.assignee) {
      const assigneeField = await this.platform.assigneeField(input.assignee, (u) => this.resolveUserId(u));
      Object.assign(payload, assigneeField);
    }
    const r = await this.api(`${this.repoPath()}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`create 失败 HTTP ${r.status}`);
    return this.toRecord(r.data as Record<string, unknown>, input.projectId);
  }

  async update(projectId: string, number: number, patch: IssuePatch): Promise<IssueRecord | null> {
    // 动词与标签载荷差异见 platform.updateRequest(gitlab=PUT + add/remove_labels)。
    const req = patch.status === undefined ? { method: this.kind === "gitlab" ? "PUT" : "PATCH", body: {} as Record<string, unknown> } : this.platform.updateRequest(patch.status);
    const r = await this.api(`${this.repoPath()}/issues/${number}`, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    if (!r.ok) throw new Error(`update 失败 HTTP ${r.status}`);
    if (patch.taskId !== undefined) {
      await this.comment(projectId, number, this.user, `genie:task:${patch.taskId}`);
    }
    const rec = await this.toRecord(r.data as Record<string, unknown>, projectId);
    // gitlab iid 与 number 同值;patch.status 已在服务端生效,响应里的 labels 可能滞后,按请求值回填。
    if (patch.status !== undefined) rec.status = patch.status;
    return rec;
  }

  async comment(_projectId: string, number: number, author: string, body: string): Promise<boolean> {
    // 评论端点差异见 platform.commentPath(GitHub=/comments,GitLab=/notes)。
    const path = this.platform.commentPath(this.repoPath(), number);
    const r = await this.api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: `[${author}] ${body}` }),
    });
    return r.ok;
  }
}

export function newGithubIssues(info: GitHostInfo, token: string, fetchImpl: FetchLike, user = "genie"): IssueChannel {
  return new NativeIssues(info, token, fetchImpl, user);
}
export const newGitlabIssues = newGithubIssues; // 同实现:REST 形状在 NativeIssues 内按 kind 分支

/**
 * 错误是否属于「原生通道不可用」——只有这类才允许降级到仓内 RepoIssues。
 * 判据(保守白名单):
 *  - HTTP 401/403:token 无效/无权限(降级有据:本地副本是唯一可行通道);
 *  - HTTP 404:项目或 issue 在原生侧不存在(repo 路径配置错,继续打原生只会一直失败);
 *  - HTTP 400/422 等参数错**不降级**——那是我们的请求构造 bug,降级会把 bug 藏起来;
 *  - HTTP 5xx/429 不降级——第三方服务临时故障,降级会使本地与原生数据永久分叉;
 *  - 网络不可达(fetch failed / ECONNREFUSED / 超时 / DNS)降级——可达性问题,等同离线。
 */
export function isDegradableError(err: unknown): boolean {
  const s = String(err);
  const m = /HTTP (\d{3})/.exec(s);
  if (m) {
    const code = Number(m[1]);
    return code === 401 || code === 403 || code === 404;
  }
  // 无 HTTP 状态码 = 网络/传输层失败(NativeIssues.api 里的 fetch 抛出形态)。
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|aborted|network/i.test(s);
}

// ---- IssueService:通道选择+降级+统一事件 ----

export interface IssueServiceOptions {
  /** 项目根解析(projectId → 绝对路径;缺省=repoRoot,即 harness 本体)。 */
  resolveRoot: (projectId: string) => string;
  repoRoot: string;
  /** git remote 读取(缺省 git-service;测试注入固定 URL)。 */
  remoteUrl?: (root: string) => Promise<string | null>;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  gitHostOverride?: { gitHost?: "github" | "gitlab" };
  username?: string;
}

interface ChannelState {
  channel: IssueChannel;
  /** 通道标签:github/gitlab(原生)/repo(降级或原选)。 */
  mode: "github" | "gitlab" | "repo";
  /** 降级原因(native → repo 后记录;未降级=undefined)。 */
  degradedReason?: string;
  hostInfo?: GitHostInfo;
}

export class IssueService {
  private states = new Map<string, Promise<ChannelState>>();

  constructor(private readonly opts: IssueServiceOptions) {}

  /** 通道判定(异步缓存):remote→kind→token 在场=native,否则 RepoIssues。 */
  async channelFor(projectId: string): Promise<ChannelState> {
    let st = this.states.get(projectId);
    if (!st) {
      st = (async () => {
        const root = this.opts.resolveRoot(projectId);
        const remote = await (this.opts.remoteUrl ?? gitRemoteUrl)(root);
        const info = detectGitHost(remote, this.opts.gitHostOverride);
        if ((info.kind === "github" || info.kind === "gitlab") && info.repo) {
          const token = resolveIssueToken(info.kind === "github" ? "github" : "gitlab", this.opts.repoRoot, this.opts.env);
          if (token) {
            const native = new NativeIssues(info, token, this.opts.fetchImpl ?? ((u, i) => fetch(u, i)), this.opts.username ?? "genie");
            return { channel: native, mode: info.kind, hostInfo: info };
          }
          return { channel: new RepoIssues(root), mode: "repo", hostInfo: info };
        }
        return { channel: new RepoIssues(root), mode: "repo", hostInfo: info };
      })();
      this.states.set(projectId, st);
    }
    return st;
  }

  /** 降级执行:调用方捕获 native 错误(401/403/网络)后调用;会话内钉死 repo 通道。 */
  async degrade(projectId: string, reason: string): Promise<ChannelState> {
    const prev = await this.channelFor(projectId);
    if (prev.mode === "repo") return prev;
    const root = this.opts.resolveRoot(projectId);
    const next: ChannelState = { channel: new RepoIssues(root), mode: "repo", degradedReason: reason, hostInfo: prev.hostInfo };
    this.states.set(projectId, Promise.resolve(next));
    return next;
  }

  /** op 包装:仅在「原生通道不可用」类错误上降级到 RepoIssues 重放一次。
   * 旧实现 catch 一切错误都降级(含服务端 5xx/超时/编程错误)——那会把第三方服务故障
   * 静默写成本地副本:面板显示成功、原生侧没这条,两边数据永久分叉,且后续该项目的
   * 所有 issue 读写都被钉在 repo 通道。这里只对鉴权/可达性错误降级,其余原样上抛,
   * 由调用方(WS handler)如实回报错因。 */
  private async run<T>(projectId: string, op: (ch: IssueChannel) => Promise<T>): Promise<{ value: T; state: ChannelState }> {
    let st = await this.channelFor(projectId);
    if (st.mode !== "repo") {
      try {
        return { value: await op(st.channel), state: st };
      } catch (err) {
        if (!isDegradableError(err)) throw err;
        st = await this.degrade(projectId, String(err).slice(0, 160));
      }
    }
    return { value: await op(st.channel), state: st };
  }

  async list(projectId: string): Promise<IssueRecord[]> {
    const { value, state } = await this.run(projectId, (ch) => ch.list(projectId));
    void state;
    return value;
  }

  async create(input: IssueCreateInput): Promise<IssueRecord> {
    const { value } = await this.run(input.projectId, (ch) => ch.create(input));
    bus.emit("issue.changed", { projectId: input.projectId, number: value.number, action: "create" });
    return value;
  }

  async update(projectId: string, number: number, patch: IssuePatch): Promise<IssueRecord | null> {
    const { value } = await this.run(projectId, (ch) => ch.update(projectId, number, patch));
    if (value) bus.emit("issue.changed", { projectId, number, action: "update" });
    return value;
  }

  async comment(projectId: string, number: number, author: string, body: string): Promise<boolean> {
    const { value } = await this.run(projectId, (ch) => ch.comment(projectId, number, author, body));
    if (value) bus.emit("issue.changed", { projectId, number, action: "comment" });
    return value;
  }

  /** 通道画像(面板透出:mode + 降级原因 + 托管信息)。 */
  async describe(projectId: string): Promise<{ mode: string; degradedReason?: string; host: string; repo: string | null }> {
    const st = await this.channelFor(projectId);
    return { mode: st.mode, ...(st.degradedReason ? { degradedReason: st.degradedReason } : {}), host: st.hostInfo?.host ?? "", repo: st.hostInfo?.repo ?? null };
  }

  /** 找 taskId 关联的 issue(终态回写路由;跨项目扫已见通道,内存态零 IO)。 */
  findIssueByTask(taskId: string): { projectId: string; number: number } | null {
    // RepoIssues 直读文件(便宜);native 通道不反查(创建时本服务记录关联即可)。
    return this.taskLinks.get(taskId) ?? null;
  }

  /** 派发关联登记(确认派发时写入;终态回写路由用)。 */
  private taskLinks = new Map<string, { projectId: string; number: number }>();
  /** 回写幂等集(dispatch 兜底与 onChange 双路)。 */
  private writtenTasks = new Set<string>();
  linkTask(taskId: string, projectId: string, number: number): void {
    this.taskLinks.set(taskId, { projectId, number });
  }

  /** 终态回写(关联命中才写):结果摘要 ≤300 字评论 + done 置位;返回是否写了。
   * fixD4 竞态修复:echo 形执行器在 submit() 内同步完成——终态事件先于 linkTask,
   * 调用方(分发 handler/延迟重试)须在 link 登记后再试一次。 */
  async writebackTerminal(t: { id: string; state: string; result?: string }): Promise<boolean> {
    const link = this.taskLinks.get(t.id);
    if (!link) return false;
    if (this.writtenTasks.has(t.id)) return true; // 幂等:dispatch 兜底与 onChange 重试双路只写一次
    this.writtenTasks.add(t.id);
    const summary = (t.result ?? "").slice(0, 300) || "(无结果摘要)";
    const mark = t.state === "done" ? "✅ 任务完成:" : t.state === "failed" ? "❌ 失败:" : "⏹ 已取消:";
    await this.comment(link.projectId, link.number, this.opts.username ?? "genie", mark + summary);
    if (t.state === "done") await this.update(link.projectId, link.number, { status: "done" });
    return true;
  }
}

/**
 * :任务终态 → issue 回写(只写一次;失败可重试)。
 * 幂等双保险:①journal 里已有同 key 的 custom{type:"issue.task.writeback"} → DUPLICATE;
 * ②plan 判定已经 done / 已有同文评论 → DUPLICATE。
 * 失败(update/comment 抛错或返回空)返回 INVALID/NOT_FOUND 且**不落幂等事件**(下次可重试)。
 * 不新增网络语义:统一走通道既有 update/comment。
 */
export async function writeBackIssueTask(
  channel: IssueChannel,
  input: IssueWriteBackInput): Promise<IssueWriteBackResult> {
  if (channel.writeBack) return channel.writeBack(input);
  const key = writeBackKey(input.taskId, input.number);
  try {
    if (hasWriteBack(input.journal.readAll(), key)) return { ok: true, code: "DUPLICATE", written: false };
  } catch (err) {
    return { ok: false, code: "INVALID", error: String(err).slice(0, 300) };
  }
  let issue: IssueRecord | null;
  try {
    issue = (await channel.list(input.projectId)).find((i) => i.number === input.number) ?? null;
  } catch (err) {
    return { ok: false, code: "INVALID", error: String(err).slice(0, 300) };
  }
  if (!issue) return { ok: false, code: "NOT_FOUND", error: "issue not found" };
  const plan = terminalWriteBackPlan({
    taskId: input.taskId,
    taskState: input.state,
    issue,
    at: Date.now(),
  });
  if (plan.code === "DUPLICATE") return { ok: true, code: "DUPLICATE", written: false };
  if (!plan.ok) return { ok: false, code: plan.code };
  try {
    if (plan.patch) {
      const rec = await channel.update(input.projectId, input.number, plan.patch);
      if (!rec) return { ok: false, code: "NOT_FOUND", error: "issue vanished during update" };
    }
    if (plan.comment) {
      const done = await channel.comment(input.projectId, input.number, "genie", plan.comment);
      if (!done) return { ok: false, code: "NOT_FOUND", error: "issue vanished during comment" };
    }
    input.journal.append({
      kind: "custom",
      sessionId: input.sessionId,
      payload: buildWriteBackEvent({
        key,
        taskId: input.taskId,
        issueNumber: input.number,
        projectId: input.projectId,
        state: input.state,
        at: Date.now(),
      }),
    });
    return { ok: true, code: "OK", written: true };
  } catch (err) {
 // 失败不落幂等事件:下一次终态重放/重试还能再写一次。
    return { ok: false, code: "INVALID", error: String(err).slice(0, 300) };
  }
}
