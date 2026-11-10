/**
 * 团队视图服务面(step-032 遗留收口:团队页 UI 的数据层)+多 org(step-032 多 relay 并存)。
 * 每个 relay URL 一个 TeamRelayClient;presence diff 应用成全量视图;activity 滚动缓存;
 * 邀请码经 relay.invite.create。红线不变:relay 不可达=该 org 显示 disconnected,本地零影响。
 */
import { TeamRelayClient } from "@lampgenie/runtime/team/relay-client";
import type { RelayServerMessage } from "@lampgenie/protocol";
import { matchProjectId } from "@lampgenie/runtime/team/project-binding";

export interface OrgView {
  url: string;
  state: string;
  member?: { username: string; role: string };
  fingerprint?: string;
  presence: { fingerprint: string; username: string; state: string; lastActiveAt: number }[];
  activity: { ts: number; userId: string; projectId: string; category: string; type: string; summary: string }[];
}

interface OrgEntry {
  url: string;
  client: TeamRelayClient;
  state: string;
  member?: { username: string; role: string };
  fingerprint?: string;
  presence: Map<string, { username: string; state: string; lastActiveAt: number; projects: string[] }>;
  /** 项目注册表镜像(designs/23:relay 下发的 roster projects 投影;绑定键匹配数据源)。 */
  projectsRegistry: Record<string, { type?: string; repo?: string }>;
  /** teamai 团队仓资产投影(designs/24:relay 下发的 digest;secrets 只含 key)。 */
  teamai: Record<string, unknown> | null;
  activity: OrgView["activity"];
}

export interface TeamViewOptions {
  urls: string[];
  identityDir: string;
  /** presence 心跳上行(取当前任务面事实)。 */
  presenceFacts?: () => { lastInputAt: number; runningSessions: number; pendingAsks: number; dnd: boolean };
  log?: (line: string) => void;
}

const ACTIVITY_CAP = 50;

export class TeamView {
  private orgs = new Map<string, OrgEntry>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: TeamViewOptions) {
    for (const url of opts.urls) this.addOrg(url);
    // presence 心跳(25s 节律,沿用 step-032 实测形态);unref 不钉进程。
    this.heartbeat = setInterval(() => this.sendPresence(), 25_000);
    this.heartbeat.unref?.();
  }

  /** env 解析:RELAY_URLS(CSV,多 org)优先;回退 RELAY_URL(单 org 兼容)。 */
  static urlsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
    const csv = env.RELAY_URLS ?? env.RELAY_URL;
    return (csv ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  }

  private addOrg(url: string): void {
    if (this.orgs.has(url)) return;
    const entry: OrgEntry = { url, client: null as unknown as TeamRelayClient, state: "connecting", presence: new Map(), projectsRegistry: {}, teamai: null, activity: [] };
    entry.client = new TeamRelayClient({
      url,
      identityDir: this.opts.identityDir,
      onState: (s) => { entry.state = s; },
      onMessage: (m) => this.handle(url, entry, m),
    });
    entry.client.connect();
    this.orgs.set(url, entry);
  }

  private handle(url: string, entry: OrgEntry, m: RelayServerMessage): void {
    switch (m.type) {
      case "relay.auth.ok":
        entry.member = { username: m.member.username, role: m.member.role };
        break;
      case "relay.presence.diff":
        for (const s of m.states) entry.presence.set(s.fingerprint, { username: s.username, state: s.state, lastActiveAt: s.lastActiveAt, projects: s.projects ?? entry.presence.get(s.fingerprint)?.projects ?? [] });
        break;
      case "relay.projects":
        entry.projectsRegistry = m.projects;
        break;
      case "relay.teamai.digest":
        entry.teamai = m.digest;
        break;
      case "relay.activity":
        entry.activity = [...m.events.map((e) => ({ ts: e.ts, userId: e.userId, projectId: e.projectId, category: e.category, type: e.type, summary: e.summary })), ...entry.activity].slice(0, ACTIVITY_CAP);
        break;
      case "relay.member.joined":
        entry.activity = [{ ts: Date.now(), userId: m.username, projectId: "", category: "member", type: "joined", summary: `${m.username} 加入团队` }, ...entry.activity].slice(0, ACTIVITY_CAP);
        break;
      case "relay.invite.issued":
        for (const l of this.inviteListeners) { try { l(url, m.code, m.expiresAt); } catch { /* 监听者异常不影响 */ } }
        break;
      case "relay.teamai.push.result":
        for (const l of [...this.pushListeners]) { try { l(m); } catch { /* 监听者异常不影响 */ } }
        break;
      case "relay.teamai.contribute.result":
        for (const l of [...this.contributeListeners]) { try { l(m); } catch { /* 监听者异常不影响 */ } }
        break;
      case "relay.teamai.remove.result":
        for (const l of [...this.removeListeners]) { try { l(m); } catch { /* 监听者异常不影响 */ } }
        break;
      default:
        break;
    }
    void url;
  }

  private inviteListeners: ((orgUrl: string, code: string, expiresAt: number) => void)[] = [];
  private pushListeners: ((r: { ok: boolean; branch?: string; reason?: string }) => void)[] = [];
  /** designs/30:经验贡献/资源删除的结果挂勾(与 push 分流,互不串包)。 */
  private contributeListeners: ((r: { ok: boolean; branch?: string; path?: string; reason?: string }) => void)[] = [];
  private removeListeners: ((r: { ok: boolean; path?: string; reason?: string }) => void)[] = [];

  /** teamai push 结果挂勾(调用方自行 offPushResult 防泄漏)。 */
  onPushResult(l: (r: { ok: boolean; branch?: string; reason?: string }) => void): void {
    this.pushListeners.push(l);
  }
  offPushResult(l: (r: { ok: boolean; branch?: string; reason?: string }) => void): void {
    this.pushListeners = this.pushListeners.filter((x) => x !== l);
  }

  /** 经验贡献结果挂勾(调用方自行 offContributeResult 防泄漏)。 */
  onContributeResult(l: (r: { ok: boolean; branch?: string; path?: string; reason?: string }) => void): void {
    this.contributeListeners.push(l);
  }
  offContributeResult(l: (r: { ok: boolean; branch?: string; path?: string; reason?: string }) => void): void {
    this.contributeListeners = this.contributeListeners.filter((x) => x !== l);
  }

  /** 资源删除结果挂勾(调用方自行 offRemoveResult 防泄漏)。 */
  onRemoveResult(l: (r: { ok: boolean; path?: string; reason?: string }) => void): void {
    this.removeListeners.push(l);
  }
  offRemoveResult(l: (r: { ok: boolean; path?: string; reason?: string }) => void): void {
    this.removeListeners = this.removeListeners.filter((x) => x !== l);
  }

  private sendPresence(): void {
    if (!this.opts.presenceFacts) return;
    const facts = this.opts.presenceFacts();
    for (const entry of this.orgs.values()) {
      if (entry.client.ready) entry.client.sendPresence(facts);
    }
  }

  /** 面板快照(org 列表;presence 按活跃降序)。 */
  snapshot(): { orgs: OrgView[] } {
    return {
      orgs: [...this.orgs.values()].map((e) => ({
        url: e.url,
        state: e.state,
        ...(e.member ? { member: e.member } : {}),
        presence: [...e.presence.entries()]
          .map(([fingerprint, v]) => ({ fingerprint, ...v }))
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt),
        activity: [...e.activity],
      })),
    };
  }

  /**
   * 项目绑定团队(designs/23):激活项目 → roster projects.repo 归一化匹配 → 该项目的真成员。
   * 每个绑定的 org 出一份成员切片;绑不上时 bound=false(候选-only 视图的信号)。
   */
  projectTeam(binding: { remoteUrl: string | null; label: string }): {
    bound: boolean;
    projectId: string | null;
    sources: { url: string; state: string; projectId: string | null; members: { username: string; fingerprint: string; state: string; lastActiveAt: number }[] }[];
  } {
    const sources = [...this.orgs.values()].map((e) => {
      const projectId = matchProjectId(e.projectsRegistry, binding.remoteUrl, binding.label);
      const members = projectId
        ? [...e.presence.entries()]
            .filter(([, v]) => v.projects.includes(projectId))
            .map(([fingerprint, v]) => ({ username: v.username, fingerprint, state: v.state, lastActiveAt: v.lastActiveAt }))
            .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        : [];
      return { url: e.url, state: e.state, projectId, members };
    });
    const anyBound = sources.some((s) => s.projectId);
    return { bound: anyBound, projectId: sources.find((s) => s.projectId)?.projectId ?? null, sources };
  }

  /** 创建邀请码(relay.invite.create;邀请码经 message 面的 relay.invite.issued 返回)。 */
  invite(orgUrl: string, displayName?: string, projects?: string[]): boolean {
    const entry = this.orgs.get(orgUrl);
    if (!entry || !entry.client.ready) return false;
    entry.client.wsSend({ v: 1, type: "relay.invite.create", ...(displayName ? { displayName } : {}), ...(projects?.length ? { projects } : {}) });
    return true;
  }

  /** teamai 资产 digest(第一个 ready org 的;无 → null)。 */
  teamaiDigest(): Record<string, unknown> | null {
    for (const e of this.orgs.values()) {
      if (e.client.ready && e.teamai) return e.teamai;
    }
    return null;
  }

  /** teamai push:经 relay 写分支+MR;结果经 relay.teamai.push.result 异步回(onMessage 分发)。 */
  teamaiPush(orgUrl: string, payload: { ns: string; name: string; description: string; body: string; contributors?: string[]; kind?: "skill" | "rule" | "doc" }): boolean {
    const entry = this.orgs.get(orgUrl);
    if (!entry || !entry.client.ready) return false;
    entry.client.wsSend({ v: 1, type: "relay.teamai.push", ...payload });
    return true;
  }

  /** teamai contribute:会话经验写 learnings 分支(designs/30 §2.4);结果经 contribute.result 异步回。 */
  teamaiContribute(orgUrl: string, payload: { title: string; body: string; tags?: string[]; project?: string }): boolean {
    const entry = this.orgs.get(orgUrl);
    if (!entry || !entry.client.ready) return false;
    entry.client.wsSend({ v: 1, type: "relay.teamai.contribute", ...payload });
    return true;
  }

  /** teamai remove:删团队仓 main 上一份资源(designs/30 §2.3);结果经 remove.result 异步回。 */
  teamaiRemove(orgUrl: string, payload: { kind: "skill" | "rule" | "doc"; ns?: string; name: string }): boolean {
    const entry = this.orgs.get(orgUrl);
    if (!entry || !entry.client.ready) return false;
    entry.client.wsSend({ v: 1, type: "relay.teamai.remove", ...payload });
    return true;
  }

  /** 手动触发 relay 重拉团队仓(roster+teamai 一起刷新;30s 轮询的即时机)。 */
  pull(orgUrl?: string): void {
    for (const [url, e] of this.orgs.entries()) {
      if (!orgUrl || url === orgUrl) e.client.wsSend({ v: 1, type: "relay.roster.changed" });
    }
  }

  /**
   * 任务级活动上行(2026-10-27:此前活动流只有 P2P 兜底会推,任务开始/完成无人推=活动区恒空)。
   * userId 服务端强制=本连接 member 名(伪造他人=forbidden),故由已认证 entry.member 决定;
   * projectId 传 roster 绑定键(未绑定时传空——relay 可见性按「未登记项目仅本人」收敛)。
   */
  notifyActivity(projectId: string, category: string, type: string, summary: string): void {
    for (const e of this.orgs.values()) {
      if (e.client.ready && e.member) {
        e.client.wsSend({
          v: 1,
          type: "relay.activity.push",
          event: { ts: Date.now(), userId: e.member.username, projectId, category, type, summary: String(summary).slice(0, 200) },
        });
      }
    }
  }

  /** invite.issued 结果挂勾(面板等待邀请码弹窗用)。 */
  onInviteIssued(l: (orgUrl: string, code: string, expiresAt: number) => void): void {
    this.inviteListeners.push(l);
  }

  /** 退订(一次性等待用)。 */
  offInviteIssued(l: (orgUrl: string, code: string, expiresAt: number) => void): void {
    const i = this.inviteListeners.indexOf(l);
    if (i >= 0) this.inviteListeners.splice(i, 1);
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
  }
}
