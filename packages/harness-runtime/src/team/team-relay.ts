/**
 * Team Relay 服务核心(designs/05 §5):每个 org 一个的轻中继。
 * 职责正面清单:presence 交换/活动流路由/邀请码兑换/团队仓同步通知;
 * 红线:不存会话正文、不做成员资格判定(那是 roster MR 的事)、不接触凭证。
 * 权威数据全部在 Git 仓——roster 镜像只是缓存,挂了可重建。
 */
import { WebSocketServer, WebSocket } from "ws";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  parseRelayClientMessage,
  type ActivityEvent,
  type PresenceFacts,
  type RelayClientMessage,
  type RelayServerMessage,
} from "@lampgenie/protocol";
import { CustomGitProvider, git, type GitProvider } from "../git/provider.js";
import { fingerprintOf } from "../identity/identity.js";
import { InviteStore } from "./invite-store.js";
import { parseYamlLite, stringifyYamlLite } from "./yaml-lite.js";
import { newChallenge, verifyChallenge } from "./relay-auth.js";
import { derivePresence } from "./presence.js";
import type { Member, Projects } from "../roster/schema.js";
import { AuditLog } from "../security/audit-log.js";
import { readTeamaiAssets, readLearningsDir, parseLearningMeta, safeSkillPath, teamaiPushBranch, type TeamaiLearning } from "./teamai-bridge.js";
import { learningPath, renderLearningDoc } from "./team-contribute.js";

export interface TeamRelayOptions {
  port?: number;
  server?: import("node:http").Server;
  /** 团队仓(bare)URL/路径——roster 权威源。 */
  teamRepoUrl: string;
  /** relay 工作目录(克隆+邀请码存储)。 */
  workdir: string;
  provider?: GitProvider;
  /** roster 轮询周期(吊销即时踢的上界;默认 30s)。 */
  rosterPollMs?: number;
  /** presence diff 广播周期(默认 30s)。 */
  presenceBroadcastMs?: number;
  /** 活动流环形缓冲容量(默认 500)。 */
  activityCapacity?: number;
  /** GitProvider 注入点(缺省 CustomGitProvider):factory 按 providers.yaml 平台绑定构造。 */
  providerOpts?: GitProvider;
  /** 团队主分支(缺省自动探测 ls-remote HEAD;团队仓可能是 master,如 teamai 形态)。 */
  mainBranch?: string;
  /** 上游权威仓(designs/24:TEAM_REPO_URL 为本地镜像时的上游同步源;teammate 推送经此进来)。 */
  upstreamUrl?: string;
  /** learnings 专用分支名(teamai Context 层约定,缺省 teamai-learnings)。 */
  learningsBranch?: string;
}

interface ConnState {
  ws: WebSocket;
  nonce: string;
  /** null=未认证。 */
  fingerprint: string | null;
  username: string | null;
  facts: PresenceFacts | null;
  lastSeen: number;
}

interface RosterMirror {
  members: Member[];
  projects: Projects["projects"];
  pulledAt: number;
}

const DEFAULT_MAIN = "main";

/** teamai 可推送/删除的资源类别(designs/30 §2.2)。 */
export type TeamaiResourceKind = "skill" | "rule" | "doc";

/** kind → 团队仓落点相对路径(§2.2);ns/name 非法返回 null(写路径防穿越)。 */
export function teamaiResourcePath(kind: TeamaiResourceKind, ns: string, name: string): string | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,48}$/i.test(name ?? "")) return null;
  if (kind === "doc") return `docs/${name}.md`; // doc 无 namespace:docs/<name>.md
  const pair = safeSkillPath(ns ?? "", name);
  if (!pair) return null;
  return kind === "rule" ? `rules/${pair}.md` : `skills/${pair}/SKILL.md`;
}

/** kind → 删除目标(§2.3 `git rm -r <path>`):skill 删整目录(skills/<ns>/<name>),其余同写路径。 */
export function teamaiRemovePath(kind: TeamaiResourceKind, ns: string, name: string): string | null {
  if (kind === "skill") {
    const pair = safeSkillPath(ns ?? "", name ?? "");
    return pair ? `skills/${pair}` : null;
  }
  return teamaiResourcePath(kind, ns, name);
}

export class TeamRelay {
  private conns = new Set<ConnState>();
  private invites: InviteStore;
  private provider: GitProvider;
  private roster: RosterMirror = { members: [], projects: {}, pulledAt: 0 };
  private activity: ActivityEvent[] = [];
  /** git 操作串行化(同目录并发 git 会互相踩)。 */
  private gitQueue: Promise<unknown> = Promise.resolve();
  private lastPresenceBroadcast = new Map<string, string>();
  private timers: NodeJS.Timeout[] = [];
  private wss: WebSocketServer;
  /** 审计日志(designs/10 §6:member.invite/roster.merge 产生点;默认 $HOME/audit/)。 */
  private audit: AuditLog;
  readonly cloneDir: string;

  constructor(private readonly opts: TeamRelayOptions) {
    mkdirSync(opts.workdir, { recursive: true });
    this.cloneDir = join(opts.workdir, "team-clone");
    this.invites = new InviteStore(join(opts.workdir, "invites.jsonl"));
    this.audit = new AuditLog(join(opts.workdir, "audit.jsonl"));
    this.provider = opts.providerOpts ?? opts.provider ?? new CustomGitProvider();
    this.wss = opts.server
      ? new WebSocketServer({ server: opts.server })
      : new WebSocketServer({ port: opts.port });
    this.wss.on("connection", (ws) => this.onConnection(ws));

    const pollMs = opts.rosterPollMs ?? 30_000;
    const presenceMs = opts.presenceBroadcastMs ?? 30_000;
    // 周期器不阻塞进程退出。
    const pollTimer = setInterval(() => void this.pullRoster().catch(() => {}), pollMs);
    const presenceTimer = setInterval(() => this.broadcastPresenceDiff(), presenceMs);
    pollTimer.unref?.();
    presenceTimer.unref?.();
    this.timers.push(pollTimer, presenceTimer);
  }

  /** 启动即拉一次 roster(不 await 构造;失败容忍——离线启动是合法工况 I4)。 */
  async start(): Promise<void> {
    await this.pullRoster().catch(() => {});
  }

  close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const c of this.conns) c.ws.terminate();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }

  // ---- roster 镜像(Git 是权威;这里是缓存) ----

  private memberByFingerprint(fp: string): Member | undefined {
    return this.roster.members.find((m) => m.fingerprint === fp || m.keys.includes(fp));
  }

  private memberByUsername(name: string): Member | undefined {
    return this.roster.members.find((m) => m.username === name);
  }

  async pullRoster(): Promise<void> {
    const task = this.gitQueue.then(() => this.doPullRoster());
    this.gitQueue = task.catch(() => {});
    await task;
  }

  /** 团队主分支:opts.mainBranch 显式 > ls-remote HEAD 自动探测 > main。团队仓可能是 master(teamai 形态)。 */
  private mainBranchResolved: string | null = null;
  private async resolveMainBranch(): Promise<string> {
    if (this.mainBranchResolved) return this.mainBranchResolved;
    if (this.opts.mainBranch) {
      this.mainBranchResolved = this.opts.mainBranch;
      return this.mainBranchResolved;
    }
    try {
      const out = await git(["ls-remote", "--symref", this.opts.teamRepoUrl, "HEAD"], this.opts.workdir);
      const m = /ref: refs\/heads\/(\S+)\tHEAD/.exec(out);
      this.mainBranchResolved = m?.[1] ?? DEFAULT_MAIN;
    } catch {
      this.mainBranchResolved = DEFAULT_MAIN;
    }
    return this.mainBranchResolved;
  }

  private async doPullRoster(): Promise<void> {
    const main = await this.resolveMainBranch();
    let first = false;
    try {
      await git(["rev-parse", "--git-dir"], this.cloneDir);
    } catch {
      await this.provider.clone(this.opts.teamRepoUrl, this.cloneDir);
      first = true;
    }
    await git(["fetch", "origin"], this.cloneDir);
    // 上游同步(designs/24):teammate 推上游权威仓→镜像必须跟上,否则上游内容永远进不来。
    if (this.opts.upstreamUrl) {
      try {
        await git(["fetch", "upstream"], this.cloneDir).catch(async () => {
          await git(["remote", "add", "upstream", this.opts.upstreamUrl!], this.cloneDir);
          await git(["fetch", "upstream"], this.cloneDir);
        });
        const behind = await git(["rev-list", "--count", `origin/${main}..upstream/${main}`], this.cloneDir).catch(() => "0");
        if (Number(behind) > 0) {
          await git(["checkout", "-f", main], this.cloneDir).catch(() => {});
          await git(["reset", "--hard", `origin/${main}`], this.cloneDir);
          // 合并上游(roster/ 本地提交与上游内容路径不相交;冲突时保守保留本地 roster)
          await git(["merge", `upstream/${main}`, "-m", "relay: sync upstream teamai content"], this.cloneDir);
          await git(["push", "origin", main], this.cloneDir);
        }
      } catch { /* 上游不可达容忍:镜像继续供数 */ }
    }
    await git(["checkout", "-f", main], this.cloneDir).catch(() => {});
    await git(["reset", "--hard", `origin/${main}`], this.cloneDir);

    const members: Member[] = [];
    const { readdirSync, readFileSync, existsSync } = await import("node:fs");
    const membersDir = join(this.cloneDir, "roster", "members");
    if (existsSync(membersDir)) {
      for (const f of readdirSync(membersDir)) {
        if (!f.endsWith(".yaml")) continue;
        const raw = parseYamlLite(readFileSync(join(membersDir, f), "utf-8"));
        members.push({
          username: String(raw.username ?? ""),
          displayName: String(raw.displayName ?? ""),
          fingerprint: String(raw.fingerprint ?? ""),
          keys: Array.isArray(raw.keys) ? raw.keys.map(String) : [],
          role: (raw.role as Member["role"]) ?? "member",
          projects: Array.isArray(raw.projects) ? raw.projects.map(String) : [],
          invitedBy: raw.invitedBy ? String(raw.invitedBy) : undefined,
          registeredAt: String(raw.registeredAt ?? ""),
          revoked: raw.revoked === true,
        });
      }
    }
    const projectsFile = join(this.cloneDir, "roster", "projects.yaml");
    const projects: Projects["projects"] = {};
    if (existsSync(projectsFile)) {
      const raw = parseYamlLite(readFileSync(projectsFile, "utf-8"));
      // 受控子集无嵌套:projects.yaml 形态为「<projectId>.type: team」/「<projectId>.repo: …」扁平键。
      for (const [k, v] of Object.entries(raw)) {
        const m = /^([A-Za-z0-9_.-]+)\.(type|repo|owner)$/.exec(k);
        if (!m) continue;
        const id = m[1]!;
        projects[id] ??= { type: "team", sharedNodes: [] };
        if (m[2] === "type") projects[id]!.type = v === "personal" ? "personal" : "team";
        if (m[2] === "repo") projects[id]!.repo = String(v);
        if (m[2] === "owner") (projects[id] as { owner?: string }).owner = String(v);
      }
    }
    const prev = this.roster;
    this.roster = { members, projects, pulledAt: Date.now() };
    // 项目注册表变化即广播(designs/23;roster MR 合并落地后 gateway 侧绑定键更新)。
    // 前后用同一投影比较(直接比原始对象会因形状差异恒不等)。
    if (JSON.stringify(TeamRelay.projectRegistryOf(projects)) !== JSON.stringify(TeamRelay.projectRegistryOf(prev.projects))) {
      this.broadcastAll({ v: 1, type: "relay.projects", projects: this.projectsRegistry() });
    }
    await this.broadcastTeamaiDigest().catch(() => {});
    if (!first && prev.pulledAt > 0) {
      // 审计:roster.merge(roster 内容变化=有 MR 合并落地;成员差集入明细 hash)。
      const prevNames = new Set(prev.members.map((m) => m.username));
      const added = members.filter((m) => !prevNames.has(m.username)).map((m) => m.username);
      const revoked = members.filter((m) => m.revoked).map((m) => m.username);
      if (added.length > 0 || revoked.length !== prev.members.filter((m) => m.revoked).length) {
        this.audit.append(
          { actor: { kind: "system", device: "relay" }, action: "roster.merge", target: { type: "roster", id: "main" }, result: "ok", source_ip_scope: "lan" },
          { added, revokedCount: revoked.length },
        );
      }
      this.enforceRosterOnConnections();
    }
    // roster 每次刷新都全量重播 presence(2026-10-27 实锤:diff 按 state 抑制,projects 投影
    // 变化——如项目绑定种子/成员增减——不触发 state 变化,客户端永远持旧投影=「项目成员空」)。
    this.lastPresenceBroadcast.clear();
    this.broadcastPresenceDiff();
  }

  /** 吊销即时性(designs/05 工况 I3):roster 更新后,已认证但被吊销/移除的连接立即断开。 */
  private enforceRosterOnConnections(): void {
    for (const c of this.conns) {
      if (!c.fingerprint) continue;
      const m = this.memberByFingerprint(c.fingerprint);
      if (!m || m.revoked) {
        this.send(c, { v: 1, type: "relay.auth.reject", reason: "成员资格已变更(吊销或移除),连接被终止", code: "revoked" });
        c.ws.close();
      }
    }
  }

  // ---- 连接与消息 ----

  private onConnection(ws: WebSocket): void {
    ws.on("error", () => {});
    const conn: ConnState = {
      ws,
      nonce: newChallenge(),
      fingerprint: null,
      username: null,
      facts: null,
      lastSeen: Date.now(),
    };
    this.conns.add(conn);
    this.send(conn, { v: 1, type: "relay.challenge", nonce: conn.nonce });

    ws.on("message", (raw: Buffer) => {
      const msg = parseRelayClientMessage(raw.toString());
      if (!msg) {
        this.send(conn, { v: 1, type: "error", code: "invalid-message", message: "非法 relay 消息" });
        return;
      }
      conn.lastSeen = Date.now();
      void this.handleMessage(conn, msg);
    });
    ws.on("close", () => {
      this.conns.delete(conn);
      this.broadcastPresenceDiff();
    });
  }

  private async handleMessage(conn: ConnState, msg: RelayClientMessage): Promise<void> {
    if (!msg) return;
    // 未认证放行面:relay.auth(鉴权本身)+invite.redeem(入册前兑换)+ping;其余一律拒。
    const authlessAllowed = msg.type === "relay.auth" || msg.type === "relay.invite.redeem" || msg.type === "ping";
    if (!authlessAllowed && !conn.fingerprint) {
      this.send(conn, { v: 1, type: "error", code: "unauthenticated", message: "先完成 relay.auth" });
      return;
    }
    switch (msg.type) {
      case "ping":
        this.send(conn, { v: 1, type: "pong", time: Date.now() });
        return;
      case "relay.auth":
        this.handleAuth(conn, msg);
        return;
      case "relay.presence":
        conn.facts = msg.facts;
        return;
      case "relay.activity.push": {
        // 归属校验(协议「推自己的活动事件」的服务端强制):伪造他人活动=拒绝。
        if (msg.event.userId !== conn.username) {
          this.send(conn, { v: 1, type: "error", code: "forbidden", message: "活动事件只能以本人 userId 上行" });
          return;
        }
        this.pushActivity(msg.event);
        this.send(conn, { v: 1, type: "relay.activity", events: [msg.event] });
        return;
      }
      case "relay.activity.list":
        this.send(conn, { v: 1, type: "relay.activity", events: this.listActivity(conn, msg.since) });
        return;
      case "relay.invite.create":
        await this.handleInviteCreate(conn, msg);
        return;
      case "relay.teamai.push":
        await this.handleTeamaiPush(conn, msg);
        return;
      case "relay.teamai.remove":
        await this.handleTeamaiRemove(conn, msg);
        return;
      case "relay.teamai.contribute":
        await this.handleTeamaiContribute(conn, msg);
        return;
      case "relay.invite.redeem":
        await this.handleInviteRedeem(conn, msg);
        return;
      case "relay.roster.changed":
        await this.pullRoster().catch(() => {});
        this.broadcastPresenceDiff();
        return;
      case "relay.query.member":
        this.handleQueryMember(conn, msg.target);
        return;
    }
  }

  private handleAuth(
    conn: ConnState,
    msg: { fingerprint: string; publicKeyPem: string; nonce: string; sig: string },
  ): void {
    // 挑战绑定:应答必须针对本连接的 nonce——否则嗅探一次握手续可无限重放冒充。
    if (msg.nonce !== conn.nonce) {
      this.send(conn, { v: 1, type: "relay.auth.reject", reason: "挑战不匹配(疑似重放)", code: "bad-sig" });
      return;
    }
    // 信任锚=指纹:客户端提供的公钥必须指纹自证,再验签名(私钥持有证明)。
    if (fingerprintOf(msg.publicKeyPem) !== msg.fingerprint) {
      this.send(conn, { v: 1, type: "relay.auth.reject", reason: "公钥与指纹不匹配", code: "key-mismatch" });
      return;
    }
    const member = this.memberByFingerprint(msg.fingerprint);
    if (!member) {
      this.send(conn, { v: 1, type: "relay.auth.reject", reason: "指纹不在 roster(等待 MR 合并或联系 owner)", code: "not-on-roster" });
      return;
    }
    if (member.revoked) {
      this.send(conn, { v: 1, type: "relay.auth.reject", reason: "指纹已被吊销", code: "revoked" });
      return;
    }
    if (!verifyChallenge(msg.publicKeyPem, msg.nonce, msg.sig)) {
      this.send(conn, { v: 1, type: "relay.auth.reject", reason: "签名校验失败", code: "bad-sig" });
      return;
    }
    conn.fingerprint = msg.fingerprint;
    conn.username = member.username;
    this.send(conn, { v: 1, type: "relay.auth.ok", member: { username: member.username, role: member.role } });
    // 全量快照:diff 只发变化项,新连接没有基线(首屏 presence 恒空直到有人变化)——认证后先发全量。
    this.send(conn, { v: 1, type: "relay.presence.diff", states: this.presenceStates() });
    // 项目注册表(designs/23):gateway 绑定「激活项目 git remote ↔ roster projects.repo」的数据源。
    this.send(conn, { v: 1, type: "relay.projects", projects: this.projectsRegistry() });
    // teamai 团队仓资产投影(designs/24)。
    this.sendTeamaiDigest(conn);
    this.broadcastPresenceDiff();
  }

  // ---- 邀请流(designs/05 §3) ----

  private async handleInviteCreate(conn: ConnState, msg: { projects?: string[] }): Promise<void> {
    const member = conn.fingerprint ? this.memberByFingerprint(conn.fingerprint) : undefined;
    if (!member || (member.role !== "owner" && member.role !== "reviewer")) {
      this.send(conn, { v: 1, type: "error", code: "forbidden", message: "只有 owner/reviewer 可发邀请码" });
      return;
    }
    // designs/23:邀请绑定激活项目——兑换产生的 roster 条目自动带 projects(不依赖兑换者自觉申报)。
    const projects = (msg.projects ?? []).map(String).filter(Boolean).slice(0, 10);
    const { code, expiresAt } = (await import("../identity/identity.js")).createInviteCode();
    const rec = this.invites.issue(code, member.username, expiresAt, projects);
    // 审计:member.invite(明细只入 hash)。
    this.audit.append(
      { actor: { kind: "user", fingerprint: conn.fingerprint ?? "", device: member.username }, action: "member.invite", target: { type: "invite", id: code.slice(0, 8) }, result: "ok", source_ip_scope: "unknown" },
      { by: member.username, expiresAt, projects },
    );
    this.send(conn, { v: 1, type: "relay.invite.issued", code: rec.code, expiresAt: rec.expiresAt, ...(projects.length ? { projects } : {}) });
  }

  private async handleInviteRedeem(
    conn: ConnState,
    msg: { code: string; username: string; displayName: string; fingerprint: string },
  ): Promise<void> {
    const r = this.invites.redeem(msg.code, msg.username);
    if (!r.ok) {
      this.send(conn, { v: 1, type: "relay.invite.result", ok: false, reason: r.reason });
      return;
    }
    try {
      const branch = await this.createRosterBranch(msg.username, msg.displayName, msg.fingerprint, r.record.createdBy, r.record.projects);
      this.invites.attachBranch(msg.code, branch);
      this.send(conn, {
        v: 1,
        type: "relay.invite.result",
        ok: true,
        mr: { branch, title: `roster: add member ${msg.username}` },
      });
    } catch (err) {
      // git 失败要把兑换名额退回,否则码被无效消耗。
      this.invites.attachBranch(msg.code, "__failed__");
      this.send(conn, { v: 1, type: "relay.invite.result", ok: false, reason: `roster 分支创建失败:${String(err)}` });
    }
  }

  /** 在团队仓创建成员登记分支并推 MR(Custom 降级=推分支;平台 Provider=真 MR)。 */
  private async createRosterBranch(
    username: string,
    displayName: string,
    fingerprint: string,
    invitedBy: string,
    projects: string[] = [],
  ): Promise<string> {
    const task = this.gitQueue.then(() => this.doCreateRosterBranch(username, displayName, fingerprint, invitedBy, projects));
    this.gitQueue = task.catch(() => {});
    return task as Promise<string>;
  }

  private async doCreateRosterBranch(
    username: string,
    displayName: string,
    fingerprint: string,
    invitedBy: string,
    projects: string[],
  ): Promise<string> {
    const branch = `roster/${username}-${Date.now().toString(36)}`;
    await this.ensureClone();
    const main = await this.resolveMainBranch();
    await git(["fetch", "origin"], this.cloneDir);
    await git(["checkout", "-f", main], this.cloneDir).catch(() => {});
    await git(["reset", "--hard", `origin/${main}`], this.cloneDir);
    await git(["checkout", "-b", branch], this.cloneDir);
    const membersDir = join(this.cloneDir, "roster", "members");
    mkdirSync(membersDir, { recursive: true });
    const member = {
      username,
      displayName,
      fingerprint,
      keys: [fingerprint],
      role: "member",
      projects, // designs/23:邀请绑定的项目归属(邀请时定,不由兑换者申报)
      invitedBy,
      registeredAt: new Date().toISOString(),
      revoked: false, // 显式默认态:吊销 MR 的 diff 可读(改 true),不靠字段缺省
    };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(membersDir, `${username}.yaml`), stringifyYamlLite(member));
    const ident = ["-c", "user.email=relay@lampgenie.local", "-c", "user.name=genie-relay"];
    await git([...ident, "add", "roster/"], this.cloneDir);
    await git([...ident, "commit", "-m", `roster: add member ${username}`], this.cloneDir);
    await this.provider.createMR({
      repoPath: this.cloneDir,
      sourceBranch: branch,
      targetBranch: main,
      title: `roster: add member ${username}`,
      body: `invitedBy=${invitedBy}`,
    });
    return branch;
  }

  private async ensureClone(): Promise<void> {
    try {
      await git(["rev-parse", "--git-dir"], this.cloneDir);
    } catch {
      await this.provider.clone(this.opts.teamRepoUrl, this.cloneDir);
    }
  }

  // ---- presence 广播(diff) ----

  /** 项目注册表(受控投影:只暴露绑定所需的 id/type/repo)。 */
  private projectsRegistry(): Record<string, { type?: string; repo?: string }> {
    return TeamRelay.projectRegistryOf(this.roster.projects);
  }

  /** 投影纯函数(静态:roster 变更检测与对外下发共用同一形状)。 */
  private static projectRegistryOf(projects: Projects["projects"]): Record<string, { type?: string; repo?: string }> {
    const out: Record<string, { type?: string; repo?: string }> = {};
    for (const [id, p] of Object.entries(projects)) {
      out[id] = { ...(p.type ? { type: p.type } : {}), ...(p.repo ? { repo: p.repo } : {}) };
    }
    return out;
  }

  /** 全量 presence 状态(非 revoked roster 成员;连接活着即 online,facts 上行后按状态机细化)。 */
  private presenceStates() {
    const now = Date.now();
    return this.roster.members
      .filter((m) => !m.revoked)
      .map((m) => {
        const conn = [...this.conns].find((c) => c.fingerprint && (c.fingerprint === m.fingerprint || m.keys.includes(c.fingerprint)));
        // 已认证连接默认 online(WS 活着即在线,designs/04 §2);facts 上行后按状态机细化。
        const state = conn ? (conn.facts ? derivePresence(conn.facts, now) : "online") : "offline";
        return { fingerprint: m.fingerprint, username: m.username, state, lastActiveAt: conn?.lastSeen ?? 0, projects: m.projects };
      });
  }

  private broadcastPresenceDiff(): void {
    const states = this.presenceStates();
    const diff = states.filter((s) => this.lastPresenceBroadcast.get(s.username) !== s.state);
    if (diff.length === 0) return;
    for (const s of diff) this.lastPresenceBroadcast.set(s.username, s.state);
    this.broadcastAll({ v: 1, type: "relay.presence.diff", states: diff });
  }

  // ---- 活动流+隐私红线(designs/04 §6) ----

  private pushActivity(event: ActivityEvent): void {
    this.activity.push(event);
    if (this.activity.length > (this.opts.activityCapacity ?? 500)) {
      this.activity.splice(0, this.activity.length - (this.opts.activityCapacity ?? 500));
    }
  }

  /** 可见性:team 项目=全员;personal/未登记项目=仅本人(红线:不看内容,直接过滤;
   * 未登记项目 fail-closed——projects.yaml 未同步时不扩大可见面,与成员卡口径一致)。 */
  private listActivity(conn: ConnState, since?: number): ActivityEvent[] {
    const me = conn.fingerprint ? this.memberByFingerprint(conn.fingerprint) : undefined;
    return this.activity.filter((e) => {
      if (since !== undefined && e.ts <= since) return false;
      const proj = this.roster.projects[e.projectId];
      if (proj?.type === "team") return true;
      return me?.username === e.userId;
    });
  }

  private handleQueryMember(conn: ConnState, target: string): void {
    const me = conn.fingerprint ? this.memberByFingerprint(conn.fingerprint) : undefined;
    const member = this.memberByUsername(target) ?? this.memberByFingerprint(target);
    if (!member || member.revoked) {
      this.send(conn, { v: 1, type: "relay.query.result", notFound: true, card: null });
      return;
    }
    // 「在干什么」只透 team 可见项目;personal 任务的名称对他人不可见(designs/04 §6)。
    let currentTask: string | null = null;
    for (let i = this.activity.length - 1; i >= 0; i--) {
      const e = this.activity[i]!;
      if (e.userId !== member.username || e.category !== "task") continue;
      const proj = this.roster.projects[e.projectId];
      const self = me?.username === member.username;
      if (proj?.type === "team" || self) currentTask = e.summary;
      break;
    }
    const targetConn = [...this.conns].find(
      (c) => c.fingerprint && (c.fingerprint === member.fingerprint || member.keys.includes(c.fingerprint)),
    );
    const state = targetConn ? (targetConn.facts ? derivePresence(targetConn.facts, Date.now()) : "online") : "offline";
    this.send(conn, {
      v: 1,
      type: "relay.query.result",
      notFound: false,
      card: { username: member.username, state, currentTask },
    });
  }

  // ---- teamai 团队仓资产(designs/24) ----

  private teamaiJsonCache = "";

  /** learnings 补挂(teamai Context 约定:learnings 走专用分支,不一定在 master)。
   * 有 upstreamUrl → `upstream/<branch>` 优先(上游权威);无 upstreamUrl → `origin/<branch>`(designs/30 §2.4:
   * 内嵌 bare 无上游,contribute 写的就是本仓 origin 的 learnings 分支)。 */
  private async learningsFromGit(): Promise<TeamaiLearning[]> {
    const branch = this.learningsBranchName();
    const refs = this.opts.upstreamUrl ? [`upstream/${branch}`, `origin/${branch}`] : [`origin/${branch}`];
    for (const ref of refs) {
      const got = await this.readLearningsAtRef(ref);
      if (got) return got;
    }
    return []; // 分支不存在/不可达=无 learnings,零影响
  }

  /** 读某 ref 的 learnings/(ref 不存在返回 null,好让调用方退到下一条 ref)。 */
  private async readLearningsAtRef(ref: string): Promise<TeamaiLearning[] | null> {
    try {
      const paths = (await git(["-c", "core.quotepath=off", "ls-tree", "-r", "--name-only", ref, "learnings/"], this.cloneDir))
        .split("\n").map((x: string) => x.trim()).filter((x: string) => x.endsWith(".md")).slice(0, 64);
      const out: TeamaiLearning[] = [];
      for (const p of paths) {
        try {
          const body = await git(["show", `${ref}:${p}`], this.cloneDir);
          const meta = parseLearningMeta(body);
          out.push({ path: p, ...meta, body: body.slice(0, 6_000) });
        } catch { /* 单文件读取失败跳过 */ }
      }
      return out;
    } catch {
      return null;
    }
  }

  /** 统一 digest 出口:fs 投影 + 上游 learnings 分支补挂(按 path 去重)。 */
  private async currentTeamaiDigest(): Promise<Record<string, unknown>> {
    const digest = readTeamaiAssets(this.cloneDir);
    const gl = await this.learningsFromGit();
    if (gl.length) {
      const seen = new Set(((digest.learnings ?? []) as TeamaiLearning[]).map((l) => l.path));
      digest.learnings = [...(digest.learnings ?? []), ...gl.filter((l) => !seen.has(l.path))] as unknown as TeamaiLearning[];
    }
    return digest as unknown as Record<string, unknown>;
  }

  /** 读克隆目录 → digest 投影;内容不变不重算不广播。 */
  private async broadcastTeamaiDigest(): Promise<void> {
    try {
      const digest = await this.currentTeamaiDigest();
      const json = JSON.stringify(digest);
      if (json === this.teamaiJsonCache) return;
      this.teamaiJsonCache = json;
      this.broadcastAll({ v: 1, type: "relay.teamai.digest", digest });
    } catch { /* 克隆目录异常容忍(离线启动是合法工况) */ }
  }

  private async sendTeamaiDigest(conn: ConnState): Promise<void> {
    try {
      this.send(conn, { v: 1, type: "relay.teamai.digest", digest: await this.currentTeamaiDigest() });
    } catch { /* 容忍 */ }
  }

  /** teamai push:资源以团队仓形态写分支+MR(分支名对齐 teamai-cli 约定;Custom 降级=推分支)。 */
  private async handleTeamaiPush(
    conn: ConnState,
    msg: { ns: string; name: string; description: string; body: string; contributors?: string[]; kind?: TeamaiResourceKind },
  ): Promise<void> {
    const username = conn.username ?? "unknown";
    if (!conn.fingerprint) {
      this.send(conn, { v: 1, type: "relay.teamai.push.result", ok: false, reason: "未认证", code: "unauthorized" });
      return;
    }
    const kind: TeamaiResourceKind = msg.kind ?? "skill";
    if (!msg.body.trim()) {
      this.send(conn, { v: 1, type: "relay.teamai.push.result", ok: false, reason: "body 不能为空", code: "invalid" });
      return;
    }
    const path = teamaiResourcePath(kind, msg.ns, msg.name);
    if (!path) {
      this.send(conn, { v: 1, type: "relay.teamai.push.result", ok: false, reason: "ns/name 只允许字母数字-_(≤49 字符)", code: "invalid" });
      return;
    }
    const task = this.gitQueue.then(() => this.doTeamaiPush(username, conn.fingerprint ?? "", kind, path, msg));
    this.gitQueue = task.catch(() => {});
    try {
      const branch = await task;
      this.send(conn, { v: 1, type: "relay.teamai.push.result", ok: true, branch });
      this.pushTeamaiActivity(username, "push", `${kind} ${path}`);
    } catch (err) {
      // fail-visible:git 链路失败必须回到发起方(此前静默吞=push 无声消失)。
      this.send(conn, { v: 1, type: "relay.teamai.push.result", ok: false, reason: String(err).slice(0, 300) });
    }
  }

  private async doTeamaiPush(
    username: string,
    fingerprint: string,
    kind: TeamaiResourceKind,
    path: string,
    msg: { name: string; description: string; body: string; contributors?: string[] },
  ): Promise<string> {
    const branch = teamaiPushBranch(username);
    await this.ensureClone();
    const main = await this.resolveMainBranch();
    await git(["fetch", "origin"], this.cloneDir);
    await git(["checkout", "-f", main], this.cloneDir).catch(() => {});
    await git(["reset", "--hard", `origin/${main}`], this.cloneDir);
    // -B:同名分支(同秒重复 push)可复用,不因「分支已存在」整链失败。
    await git(["checkout", "-B", branch], this.cloneDir);
    const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
    const fm = `---\nname: ${msg.name}\ndescription: "${msg.description.replace(/"/g, "'")}\"\n---\n\n${msg.body}`;
    // skill = 目录形态(skills/<ns>/<name>/SKILL.md + CONTRIBUTORS);rule/doc = 单文件。
    mk(join(this.cloneDir, path, ".."), { recursive: true });
    wf(join(this.cloneDir, path), fm, "utf-8");
    if (kind === "skill") {
      const skillDir = join(this.cloneDir, path, "..");
      wf(join(skillDir, "CONTRIBUTORS"), (msg.contributors ?? [username]).join("\n") + "\n", "utf-8");
    }
    const top = path.split("/")[0]!;
    const ident = ["-c", "user.email=relay@lampgenie.local", "-c", "user.name=genie-relay"];
    await git([...ident, "add", `${top}/`], this.cloneDir);
    await git([...ident, "commit", "-m", `${top}: add ${path} (via lampgenie-harness)`], this.cloneDir);
    await this.provider.createMR({
      repoPath: this.cloneDir,
      sourceBranch: branch,
      targetBranch: main,
      title: `${top}: add ${path}`,
      body: `pushed-by=${username}`,
    });
    this.audit.append(
      { actor: { kind: "user", fingerprint, device: username }, action: "resource.push", target: { type: kind, id: path }, result: "ok", source_ip_scope: "unknown" },
      { branch, kind },
    );
    return branch;
  }

  /** teamai remove:main 上 `git rm -r <path>` → commit → push origin(designs/30 §2.3)。 */
  private async handleTeamaiRemove(
    conn: ConnState,
    msg: { kind: TeamaiResourceKind; ns: string; name: string },
  ): Promise<void> {
    const username = conn.username ?? "unknown";
    if (!conn.fingerprint) {
      this.send(conn, { v: 1, type: "relay.teamai.remove.result", ok: false, reason: "未认证", code: "unauthorized" });
      return;
    }
    const path = teamaiRemovePath(msg.kind, msg.ns ?? "", msg.name ?? "");
    if (!path) {
      this.send(conn, { v: 1, type: "relay.teamai.remove.result", ok: false, reason: "ns/name 为空或含非法字符", code: "invalid" });
      return;
    }
    const task = this.gitQueue.then(() => this.doTeamaiRemove(username, conn.fingerprint ?? "", msg.kind, path));
    this.gitQueue = task.catch(() => {});
    try {
      const removed = await task;
      if (!removed) {
        // not-found:不 commit 不 push(工作树/分支保持原样)。
        this.send(conn, { v: 1, type: "relay.teamai.remove.result", ok: false, path, reason: `未找到 ${path}`, code: "not-found" });
        return;
      }
      this.send(conn, { v: 1, type: "relay.teamai.remove.result", ok: true, path });
      this.pushTeamaiActivity(username, "remove", `${msg.kind} ${path}`);
      await this.broadcastTeamaiDigest().catch(() => {});
    } catch (err) {
      this.send(conn, { v: 1, type: "relay.teamai.remove.result", ok: false, path, reason: String(err).slice(0, 300) });
    }
  }

  private async doTeamaiRemove(username: string, fingerprint: string, kind: TeamaiResourceKind, path: string): Promise<boolean> {
    await this.ensureClone();
    const main = await this.resolveMainBranch();
    await git(["fetch", "origin"], this.cloneDir);
    // 存在性以远端 main 为权威(先判定再动工作树:not-found 必须零写入)。
    try {
      await git(["cat-file", "-e", `origin/${main}:${path}`], this.cloneDir);
    } catch {
      return false;
    }
    await git(["checkout", "-f", main], this.cloneDir).catch(() => {});
    await git(["reset", "--hard", `origin/${main}`], this.cloneDir);
    const ident = ["-c", "user.email=relay@lampgenie.local", "-c", "user.name=genie-relay"];
    await git([...ident, "rm", "-r", "-q", "--ignore-unmatch", path], this.cloneDir);
    await git([...ident, "commit", "-m", `${kind}: remove ${path} (by ${username})`], this.cloneDir);
    await this.provider.push(this.cloneDir, main);
    // 让本克隆的 origin/<main> 追上(后续 digest/pullRoster 读它)。
    await git(["fetch", "origin"], this.cloneDir);
    this.audit.append(
      { actor: { kind: "user", fingerprint, device: username }, action: "resource.push", target: { type: kind, id: path }, result: "ok", source_ip_scope: "unknown" },
      { branch: main, op: "remove" },
    );
    return true;
  }

  /** teamai contribute:经验写 learnings 分支(designs/30 §2.4;git plumbing,不碰 cloneDir 工作树)。 */
  private async handleTeamaiContribute(
    conn: ConnState,
    msg: { title: string; body: string; tags?: string[]; project?: string },
  ): Promise<void> {
    const username = conn.username ?? "unknown";
    const branch = this.learningsBranchName();
    if (!conn.fingerprint) {
      this.send(conn, { v: 1, type: "relay.teamai.contribute.result", ok: false, branch, reason: "未认证", code: "unauthorized" });
      return;
    }
    const title = (msg.title ?? "").trim();
    if (!title || !(msg.body ?? "").trim()) {
      this.send(conn, { v: 1, type: "relay.teamai.contribute.result", ok: false, branch, reason: "title/body 不能为空", code: "invalid" });
      return;
    }
    const task = this.gitQueue.then(() => this.doTeamaiContribute(username, title, msg));
    this.gitQueue = task.catch(() => {});
    try {
      const r = await task;
      this.send(conn, { v: 1, type: "relay.teamai.contribute.result", ok: true, branch: r.branch, path: r.path });
      this.pushTeamaiActivity(username, "contribute", `learning ${r.path}`, msg.project);
      await this.broadcastTeamaiDigest().catch(() => {});
    } catch (err) {
      this.send(conn, { v: 1, type: "relay.teamai.contribute.result", ok: false, branch, reason: String(err).slice(0, 300) });
    }
  }

  private learningsBranchName(): string {
    return this.opts.learningsBranch ?? "teamai-learnings";
  }

  /**
   * 在独立临时仓里写 learnings 并 push(不 checkout cloneDir:避免与 pullRoster 的 reset --hard 竞态)。
   * 分支已存在→以其 tip 为基;不存在→空树起新根提交(契约 §2.4)。
   */
  private async doTeamaiContribute(
    username: string,
    title: string,
    msg: { body: string; tags?: string[] },
  ): Promise<{ branch: string; path: string }> {
    await this.ensureClone();
    const branch = this.learningsBranchName();
    const ts = Date.now();
    const path = learningPath(ts, title);
    const doc = renderLearningDoc({ title, body: msg.body, author: username, tags: msg.tags, at: ts });
    const { mkdirSync: mk, writeFileSync: wf, rmSync: rm } = await import("node:fs");
    const work = join(this.opts.workdir, "contribute-work");
    rm(work, { recursive: true, force: true }); // 每次重建=无残留脏状态
    mk(work, { recursive: true });
    await git(["init", "-q"], work);
    await git(["remote", "add", "origin", this.opts.teamRepoUrl], work);
    try {
      await git(["fetch", "--quiet", "origin", branch], work);
      await git(["reset", "--hard", "--quiet", "FETCH_HEAD"], work);
    } catch { /* 分支不存在=空树起新历史 */ }
    mk(join(work, path, ".."), { recursive: true }); // learnings/ 目录在空树下不存在
    wf(join(work, path), doc, "utf-8");    const ident = ["-c", "user.email=relay@lampgenie.local", "-c", "user.name=genie-relay"];
    await git([...ident, "add", path], work);
    await git([...ident, "commit", "-q", "-m", `learnings: ${title} (by ${username})`], work);
    await this.provider.push(work, `HEAD:refs/heads/${branch}`);
    // cloneDir 同步远端 ref,好让 learningsFromGit/digest 立即读回本条。
    await git(["fetch", "--quiet", "origin", `${branch}:refs/remotes/origin/${branch}`], this.cloneDir);
    rm(work, { recursive: true, force: true });
    return { branch, path };
  }

  /** teamai 活动事件的 projectId:显式 project > 首个 team 项目 > ""(空=仅本人可见)。 */
  private pushTeamaiActivity(username: string, type: "push" | "remove" | "contribute", summary: string, project?: string): void {
    let projectId = project ?? "";
    if (!projectId) {
      const teams = Object.entries(this.roster.projects as Record<string, { type?: string }>);
      projectId = teams.find(([, p]) => p.type === "team")?.[0] ?? "";
    }
    this.pushActivity({ ts: Date.now(), userId: username, projectId, category: "teamai", type, summary });
  }

  // ---- 基础发送 ----

  private send(conn: ConnState, msg: RelayServerMessage): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  private broadcastAll(msg: RelayServerMessage): void {
    for (const c of this.conns) {
      if (c.fingerprint) this.send(c, msg);
    }
  }

  /** 测试/运维观察面。 */
  snapshot(): { members: number; connections: number; activity: number; pulledAt: number } {
    return {
      members: this.roster.members.length,
      connections: this.conns.size,
      activity: this.activity.length,
      pulledAt: this.roster.pulledAt,
    };
  }
}
