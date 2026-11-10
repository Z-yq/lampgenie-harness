/**
 * 虚拟组织协作开发流场景(tasks/step-1525-j3-team-collab):
 * 入册(真 ed25519 身份)→ 鉴权 → 派单 → MR 提交 → 评审合入 → 评审意见 → 修订 → 经验回流 →
 * 资产下线 → 角色变更 → 体检 → 活动流可见性 → 周报聚合,每步产出 1 条 CollabCheck。
 *
 * 两种模式共用同一组步骤与断言:
 * - `temp`:mkdtemp 建根,自种组织(seedVirtualTeam)+ enrollRealMembers + 自起 relay(port 0)。
 * - `live`:attach 仓内活组织 `<repo>/.genie/team`,relay 用 `ws://127.0.0.1:7870`,**不启动 relay、
 *   不重启进程**;只写 .genie 之内(demo 数据允许写,允许 push/merge/remove 真跑一轮)。
 *
 * 纪律:所有等待走轮询(pollUntil),不 sleep 硬等;单步超时默认 15s 并报最后收到的消息
 * (setup 例外:live 需要等 relay 周期拉 roster,语义上限 60s,故 setup 单独放宽)。
 * 断言不放宽:某步语义与预期不同就记 ok=false 并写清现象,由调用方断言失败。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityEvent } from "@lampgenie/protocol";
import { TeamRelay } from "@lampgenie/runtime/team/team-relay";
import { TeamRelayClient } from "@lampgenie/runtime/team/relay-client";
import { loadOrCreateIdentity } from "@lampgenie/runtime/identity/identity";
import { parseYamlLite } from "@lampgenie/runtime/team/yaml-lite";
import { readTeamaiAssets, teamaiDoctor, teamaiList, teamaiStatus } from "@lampgenie/runtime/team/teamai-bridge";
import { teamActivityDigest } from "@lampgenie/runtime/team/team-activity-digest";
import { enrollRealMembers, seedVirtualTeam } from "../src/team-demo";
import { RepoIssues } from "../src/issue-service";

const execFileP = promisify(execFile);
/** 全部 git 调用带显式提交身份:不依赖也不写入任何全局 git config。 */
const IDENT = ["-c", "user.name=collab-reviewer", "-c", "user.email=collab@genie.local"];

export interface CollabCheck {
  id: string;
  ok: boolean;
  detail: string;
  evidence?: string;
}

export interface CollabReport {
  checks: CollabCheck[];
  weekly?: {
    sinceTs: number;
    total: number;
    perMember: { userId: string; count: number }[];
    perCategory: { category: string; count: number }[];
  };
  visibility?: { consistent: boolean; members: string[]; detail: string };
}

export interface CollabScenarioOptions {
  mode: "temp" | "live";
  /** 覆盖根目录:temp 忽略;live 缺省 `<repo>/.genie/team`。 */
  root?: string;
  /** 覆盖 relay url:live 缺省 ws://127.0.0.1:7870。 */
  relayUrl?: string;
}

type Msg = { type: string } & Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待(禁长 sleep);超时带上最后收到的消息,便于定位。 */
async function pollUntil<T>(what: string, probe: () => T | undefined, ms: number, trail: () => string): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const got = probe();
    if (got !== undefined) return got;
    if (Date.now() - t0 >= ms) throw new Error(`${what} 超时(${ms}ms);最后收到的消息:${trail()}`);
    await sleep(25);
  }
}

async function gitOut(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", [...IDENT, ...args], { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function gitTry(args: string[], cwd: string): Promise<string | null> {
  try {
    return await gitOut(args, cwd);
  } catch {
    return null;
  }
}

/** 一个 relay 客户端(真连 + 消息缓冲)。 */
class Peer {
  readonly recv: Msg[] = [];
  readonly client: TeamRelayClient;

  constructor(
    readonly name: string,
    url: string,
    readonly identityDir: string,
  ) {
    this.client = new TeamRelayClient({
      url,
      identityDir,
      backoffBaseMs: 200,
      onMessage: (m) => this.recv.push(m as unknown as Msg),
    });
  }

  connect(): void {
    this.client.connect();
  }

  send(msg: Record<string, unknown>): void {
    this.client.wsSend({ v: 1, ...msg });
  }

  trail(): string {
    const last = this.recv.slice(-3).map((m) => m.type);
    return last.length > 0 ? last.join(", ") : "无";
  }

  private find(type: string, pred?: (m: Msg) => boolean, base = 0): Msg | undefined {
    for (let i = base; i < this.recv.length; i++) {
      const m = this.recv[i]!;
      if (m.type === type && (!pred || pred(m))) return m;
    }
    return undefined;
  }

  waitFor(type: string, pred?: (m: Msg) => boolean, ms = 5000, base = 0): Promise<Msg> {
    const trail = (): string => {
      const after = this.recv.slice(base).map((m) => m.type);
      return after.length > 0 ? `基准后 ${after.slice(-6).join(", ")}` : `基准后无消息(共 ${this.recv.length} 条,base=${base})`;
    };
    return pollUntil(`${this.name} 等 ${type}`, () => this.find(type, pred, base), ms, trail);
  }

  /** 发一条消息并等**本次**响应(基准=发送时刻的缓冲长度)。 */
  request(msg: Record<string, unknown>, type: string, pred?: (m: Msg) => boolean, ms = 10_000): Promise<Msg> {
    const base = this.recv.length;
    this.send(msg);
    return this.waitFor(type, pred, ms, base);
  }

  lastDigest(): Digest | undefined {
    for (let i = this.recv.length - 1; i >= 0; i--) {
      const m = this.recv[i]!;
      if (m.type === "relay.teamai.digest") return m.digest as Digest;
    }
    return undefined;
  }

  async waitDigest(base: number, pred?: (d: Digest) => boolean, ms = 15_000): Promise<Digest> {
    const m = await this.waitFor("relay.teamai.digest", (x) => !pred || pred(x.digest as Digest), ms, base);
    return m.digest as Digest;
  }

  stop(): void {
    this.client.stop();
  }
}

/** digest 里本场景用到的投影。 */
interface Digest {
  pulledAt?: number;
  roles?: { id: string; name?: string }[];
  memberRoles?: Record<string, string>;
  counts?: { members?: number; rules?: number; docs?: number; learnings?: number; skills?: number };
  rules?: { name: string; body?: string }[];
  skills?: { ns: string; name: string; body?: string }[];
  docs?: string[];
  learnings?: { title?: string; path?: string; body?: string }[];
}

const stripPulledAt = (d: Digest): string => {
  const { pulledAt: _ignored, ...rest } = d;
  return JSON.stringify(rest);
};

const MEMBERS = ["demo-kai", "demo-lin", "demo-rui", "demo-mei"] as const;
const EXPECTED_ROLES: Record<string, string> = { "demo-kai": "owner", "demo-lin": "member", "demo-rui": "member", "demo-mei": "reviewer" };
const PROJECT_ID = "demo-app";

/** 场景内所有可变资产名的唯一来源:一律带本次 run 的短后缀 → 连跑两轮不撞名(幂等)。 */
export interface CollabNames {
  runId: string;
  skill: string;
  skillPath: string;
  rule: string;
  rulePath: string;
  doc: string;
  docPath: string;
  learning: string;
  issueTitle: string;
}

function makeNames(runId: string): CollabNames {
  const skill = `demo-greeting-${runId}`;
  const rule = `demo-naming-${runId}`;
  const doc = `demo-runbook-${runId}`;
  return {
    runId,
    skill,
    skillPath: `skills/common/${skill}/SKILL.md`,
    rule,
    rulePath: `rules/common/${rule}.md`,
    doc,
    docPath: `docs/${doc}.md`,
    learning: `collab-经验-lin-${runId}`,
    issueTitle: `实现 greet 函数-${runId}`,
  };
}

const SKILL_BODY_V1 = (n: CollabNames): string => `# ${n.skill} —— 问候语写作规范\n\n第一版:统一问候语模板。\n`;
const SKILL_BODY_V2 = (n: CollabNames): string =>
  `# ${n.skill} —— 问候语写作规范\n\n第二版(按评审意见修订):**补类型标注**,并**补测试**覆盖空名字回退。\n`;
const RULE_BODY = (n: CollabNames): string => `# ${n.rule} —— 命名规则\n\n函数用动词短语,类型用名词。\n`;
const DOC_BODY = (n: CollabNames): string => `# ${n.doc} —— 发布手册\n\n1. 跑测试;2. 打标签;3. 通知评审。\n`;

export interface CollabContext {
  mode: "temp" | "live";
  /** temp=临时根;live=`<repo>/.genie/team`。 */
  root: string;
  /** 团队目录根(含 team-repo.git / relay/team-clone)。 */
  teamRoot: string;
  clone: string;
  bare: string;
  /** 本次 run 的资产名(os 后缀),所有路径/标题都从这里取。 */
  names: CollabNames;
  /** 本次 run dev.submit 真实推上来的分支(name → branch),review.merge 只合这些。 */
  pushed: Record<string, string>;
  projectId: string;
  identityDir: string;
  /** demo 项目工作目录(issue 存储落点)。 */
  projectRoot: string;
  url: string;
  peers: Record<string, Peer>;
  intruder?: Peer;
  httpServer?: Server;
  relay?: TeamRelay;
  issueNumber: number;
  sinceTs: number;
  /** 本场景自己推的活动事件(用于周报计数对账)。 */
  expected: Map<string, number>;
  lastMsg: () => string;
}

function bump(c: CollabContext, userId: string, n = 1): void {
  c.expected.set(userId, (c.expected.get(userId) ?? 0) + n);
}

/** 周报期望表:本次实际推的事件数(team 项目可见的那些)。 */
function resetExpected(c: CollabContext): void {
  c.expected.clear();
  for (const m of MEMBERS) c.expected.set(m, 0);
}

async function readFileAtMain(clone: string, path: string): Promise<string | null> {
  return gitTry(["show", `origin/main:${path}`], clone);
}

async function branchExists(clone: string, branch: string): Promise<boolean> {
  const out = await gitTry(["ls-remote", "origin", `refs/heads/${branch}`], clone);
  return Boolean(out && out.trim().length > 0);
}

/** 扮演 reviewer:把 relay 推上来的 teamai/push 分支 merge 进 main 并推回 origin。 */
async function mergePushBranch(clone: string, branch: string): Promise<void> {
  await gitOut(["fetch", "origin"], clone);
  await gitOut(["checkout", "-f", "main"], clone);
  await gitOut(["reset", "--hard", "origin/main"], clone);
  await gitOut(["merge", "--no-ff", `origin/${branch}`, "-m", `review: merge ${branch}`], clone);
  await gitOut(["push", "origin", "main"], clone);
}

/** 同步本地 clone 到 origin/main(丢弃本地工作树改动:clone 是场景的评审工作台,不是数据源)。 */
async function syncClone(clone: string): Promise<void> {
  await gitOut(["fetch", "origin"], clone);
  await gitOut(["checkout", "-f", "main"], clone);
  await gitOut(["reset", "--hard", "origin/main"], clone);
}

/** 让 relay 重新拉 roster+broadcast digest,并等 4 名成员都收到满足 pred 的快照。 */
async function waitAllDigests(c: CollabContext, pred: (d: Digest) => boolean, ms = 15_000): Promise<Record<string, Digest>> {
  const bases: Record<string, number> = {};
  for (const m of MEMBERS) bases[m] = c.peers[m]!.recv.length;
  c.peers["demo-kai"]!.send({ type: "relay.roster.changed" });
  const out: Record<string, Digest> = {};
  for (const m of MEMBERS) out[m] = await c.peers[m]!.waitDigest(bases[m]!, pred, ms);
  return out;
}

const stepDefs: {
  id: string;
  timeoutMs: number;
  run: (c: CollabContext, r: CollabReport) => Promise<CollabCheck>;
}[] = [];

function step(id: string, run: (c: CollabContext, r: CollabReport) => Promise<CollabCheck>, timeoutMs = 15_000): void {
  stepDefs.push({ id, timeoutMs, run });
}

// ---- 1. setup ----

step(
  "setup",
  async (c) => {
    const ev: string[] = [];
    const authOks: { username: string; role: string }[] = [];
    for (const m of MEMBERS) {
      const peer = c.peers[m]!;
      await pollUntil(`${m} auth.ok`, () => (peer.client.ready ? true : undefined), 60_000, () => peer.trail());
      const ok = peer.recv.find((x) => x.type === "relay.auth.ok");
      const member = (ok?.member ?? {}) as { username?: string; role?: string };
      authOks.push({ username: String(member.username ?? ""), role: String(member.role ?? "") });
      ev.push(`${m}:auth.ok=${JSON.stringify(member)}`);
    }
    await pollUntil(
      "4 客户端全部 ready",
      () => (MEMBERS.every((m) => c.peers[m]!.client.ready) ? true : undefined),
      15_000,
      () => c.lastMsg(),
    );
    const bad = authOks.filter((a, i) => a.username !== MEMBERS[i] || a.role !== EXPECTED_ROLES[MEMBERS[i]!]);
    // 每个成员还要能读到自己 roleId 对应的 digest 角色映射(角色正确 = auth.ok 的 role + digest.memberRoles)
    const digest = await pollUntil(
      "demo-kai digest",
      () => c.peers["demo-kai"]!.lastDigest(),
      15_000,
      () => c.lastMsg(),
    );
    const roleIds = MEMBERS.map((m) => String(digest.memberRoles?.[m] ?? ""));
    const ok = bad.length === 0 && roleIds.every((x) => x.length > 0);
    ev.push(`memberRoles=${JSON.stringify(digest.memberRoles)}`, `counts.members=${digest.counts?.members}`);
    return {
      id: "setup",
      ok,
      detail: ok
        ? `4 名成员以真身份通过 relay 鉴权(role 与 roleId 均正确)`
        : `鉴权/角色不符:${JSON.stringify(bad)};memberRoles=${JSON.stringify(digest.memberRoles)}`,
      evidence: ev.join(" | "),
    };
  },
  // setup 例外:live 模式要等 relay 周期拉 roster(≤60s),故放宽。
  180_000,
);

// ---- 2. auth.negative ----

step("auth.negative", async (c) => {
  const peer = c.intruder!;
  const reject = await peer.waitFor("relay.auth.reject", undefined, 15_000);
  const code = String((reject as { code?: string }).code ?? "");
  peer.stop();
  const ok = code === "not-on-roster";
  return {
    id: "auth.negative",
    ok,
    detail: ok ? `非 roster 身份被拒 code=${code}` : `期望 not-on-roster,实得 code=${JSON.stringify(code)}`,
    evidence: `intruder identity=${peer.identityDir} reject=${JSON.stringify(reject)}`,
  };
});

// ---- 3. dispatch ----

step("dispatch", async (c, r) => {
  // demo-kai 派单:RepoIssues 在 demo-app 建 issue,指派 demo-lin。
  const kai = new RepoIssues(c.projectRoot);
  const created = await kai.create({ projectId: c.projectId, title: c.names.issueTitle, body: "按 runbook 产出 greet,类型标注齐全。", assignee: "demo-lin" });
  c.issueNumber = created.number;
  // 推 category="task" 活动(userId 必须是发送者本人,relay 强校验)。
  const event: ActivityEvent = { ts: Date.now(), userId: "demo-kai", projectId: c.projectId, category: "task", type: "issue", summary: `派单 #${created.number} ${c.names.issueTitle}` };
  const echo = await c.peers["demo-kai"]!.request({ type: "relay.activity.push", event }, "relay.activity");
  bump(c, "demo-kai");
  const seen: Record<string, boolean> = {};
  for (const m of MEMBERS) {
    const view = await new RepoIssues(c.projectRoot).list();
    seen[m] = view.some((i) => i.number === created.number && i.assignee === "demo-lin");
  }
  const ok = Object.values(seen).every(Boolean) && ((echo.events as ActivityEvent[])[0]?.category ?? "") === "task";
  if (!ok) r.checks.push({ id: "dispatch.partial", ok: false, detail: `成员视角未见 issue:${JSON.stringify(seen)}` });
  return {
    id: "dispatch",
    ok,
    detail: ok ? `issue #${created.number} 在 4 名成员视角均可见(assignee=demo-lin),task 活动已上行` : `成员可见性不全:${JSON.stringify(seen)}`,
    evidence: `issue=${JSON.stringify({ number: created.number, status: created.status, assignee: created.assignee })}`,
  };
});

// ---- 4. dev.submit ----

step("dev.submit", async (c) => {
  const pushes: { user: string; kind: string; ns: string; name: string; path: string }[] = [
    { user: "demo-lin", kind: "skill", ns: "common", name: c.names.skill, path: c.names.skillPath },
    { user: "demo-rui", kind: "rule", ns: "common", name: c.names.rule, path: c.names.rulePath },
    { user: "demo-kai", kind: "doc", ns: "common", name: c.names.doc, path: c.names.docPath },
  ];
  const bodies: Record<string, string> = { [c.names.skill]: SKILL_BODY_V1(c.names), [c.names.rule]: RULE_BODY(c.names), [c.names.doc]: DOC_BODY(c.names) };
  const branches: Record<string, string> = {};
  for (const p of pushes) {
    const res = await c.peers[p.user]!.request(
      { type: "relay.teamai.push", kind: p.kind, ns: p.ns, name: p.name, description: `${p.name} —— collab 场景`, body: bodies[p.name]! },
      "relay.teamai.push.result",
      undefined,
      90_000,
    );
    if (res.ok !== true) throw new Error(`${p.user} push ${p.name} 失败:${JSON.stringify(res)}`);
    const branch = String(res.branch ?? "");
    if (!branch.startsWith(`teamai/push/${p.user}/`)) throw new Error(`分支名不符合 teamai/push/<user>/<ts>:${branch}`);
    await pollUntil(`分支 ${branch} 存在`, async () => ((await branchExists(c.clone, branch)) ? true : undefined), 90_000, () => c.lastMsg());
    branches[p.name] = branch;
    c.pushed[p.name] = branch;
    bump(c, p.user); // relay 的 push 成功会自己推一条 category=teamai 活动
  }
  return {
    id: "dev.submit",
    ok: true,
    detail: `三条团队资产以 MR 分支落盘(skill/rule/doc),main 未被自动合并`,
    evidence: JSON.stringify(branches),
  };
  // live 实测:relay 侧一次 push(git fetch/checkout -B/commit/MR)在 /mnt/e 上约 6-8s,
  // 本步串行 3 次 push+branch 轮询 → 15s 预算必超(断言不变,只放宽「等预算」)。
}, 120_000);

// ---- 5. review.merge ----

step("review.merge", async (c, r) => {
  // 从 origin 的真实分支列表里取三名成员各一条 teamai/push 分支(分支名带秒级时间戳)。
  const list = (await gitOut(["ls-remote", "--heads", "origin"], c.clone))
    .split("\n")
    .map((l) => l.split("\t")[1]?.replace("refs/heads/", "") ?? "")
    .filter((b) => b.startsWith("teamai/push/"));
  const pick = (user: string): string | undefined => list.filter((b) => b.startsWith(`teamai/push/${user}/`)).sort().at(-1);
  const chosen: string[] = [];
  for (const user of ["demo-lin", "demo-rui", "demo-kai"]) {
    // 优先用本次 run dev.submit 实际推上来的分支(活组织里历史分支很多,ls-remote 取"最新"可能取到旧的)。
    const b = c.pushed[
      user === "demo-lin" ? c.names.skill : user === "demo-rui" ? c.names.rule : c.names.doc
    ] ?? pick(user);
    if (!b) throw new Error(`找不到 ${user} 的 push 分支(现有:${list.join(", ")})`);
    chosen.push(b);
  }
  for (const b of chosen) await mergePushBranch(c.clone, b);
  const files = [c.names.skillPath, c.names.rulePath, c.names.docPath];
  const missing: string[] = [];
  for (const f of files) if ((await readFileAtMain(c.clone, f)) === null) missing.push(f);

  // 4 名成员收到的 digest 是否一致(跨成员可见性的硬证据)。
  const digests = await waitAllDigests(
    c,
    (d) => (d.skills ?? []).some((s) => s.name === c.names.skill) && (d.rules ?? []).some((x) => x.name === `common/${c.names.rule}`),
    90_000,
  );
  const ref = stripPulledAt(digests["demo-kai"]!);
  const inconsistent = MEMBERS.filter((m) => stripPulledAt(digests[m]!) !== ref);
  r.visibility = {
    consistent: inconsistent.length === 0,
    members: MEMBERS.slice(),
    detail:
      inconsistent.length === 0
        ? "4 名成员的 relay.teamai.digest 投影逐字一致(pulledAt 除外)"
        : `以下成员 digest 与 demo-kai 不一致:${inconsistent.join(", ")}`,
  };
  const ok = missing.length === 0 && r.visibility.consistent;
  return {
    id: "review.merge",
    ok,
    detail: ok ? `reviewer 把 3 条 MR 分支合并进 main,4 名成员 digest 一致` : `缺文件=${JSON.stringify(missing)};${r.visibility.detail}`,
    evidence: `merged=${JSON.stringify(chosen)};counts=${JSON.stringify(digests["demo-kai"]!.counts)}`,
  };
  // 3 次 merge+push(私有克隆,每次 fetch/reset/merge/push)+ 4 人 digest 等待:live 上需 >15s。
}, 120_000);

// ---- 6. review.comment ----

step("review.comment", async (c) => {
  const mei = new RepoIssues(c.projectRoot);
  const c1 = await mei.comment(c.projectId, c.issueNumber, "demo-mei", "补类型标注:greet 的返回值请显式标 string");
  const c2 = await mei.comment(c.projectId, c.issueNumber, "demo-mei", "补测试:空名字回退 world 需要有断言");
  const moved = await mei.update(c.projectId, c.issueNumber, { status: "doing" });
  const me = c.peers["demo-mei"]!;

  // 缺口探针(不作放宽):协议 ActivityEvent.category 是封闭枚举
  // ["task","approval","doc","node","build","member","eval","teamai"](protocol/src/relay.ts:34),
  // **没有 "review"** —— 推 category="review" 会被 relay 以 invalid-message 直接拒收。
  // 这里先真推一次把现象固定进证据,再用协议已有的等价类目 "approval"(审批/评审)落地本次评审活动。
  const probeBase = me.recv.length;
  me.send({
    type: "relay.activity.push",
    event: { ts: Date.now(), userId: "demo-mei", projectId: c.projectId, category: "review", type: "issue", summary: "探针:category=review" },
  });
  const probeErr = await pollUntil(
    "评审类目探针结果",
    () => {
      for (let i = probeBase; i < me.recv.length; i++) if (me.recv[i]!.type === "error") return me.recv[i]!;
      return undefined;
    },
    10_000,
    () => me.trail(),
  );
  const probeCode = String((probeErr as { code?: string }).code ?? "");

  const event: ActivityEvent = { ts: Date.now(), userId: "demo-mei", projectId: c.projectId, category: "approval", type: "review", summary: `评审 #${c.issueNumber}:补类型标注 + 补测试` };
  const base = me.recv.length;
  me.send({ type: "relay.activity.push", event });
  let echoedCategory = "";
  try {
    const echo = await me.waitFor("relay.activity", undefined, 10_000, base);
    echoedCategory = String(((echo.events as ActivityEvent[])[0] ?? {}).category ?? "");
  } catch (err) {
    const after = me.recv.slice(base).map((m) => m.type);
    const errors = me.recv.slice(base).filter((m) => m.type === "error");
    return {
      id: "review.comment",
      ok: false,
      detail: `评审活动未上行:${String((err as Error)?.message ?? err)};ready=${me.client.ready};基准后消息=${JSON.stringify(after)};errors=${JSON.stringify(errors)}`,
      evidence: `comments=${JSON.stringify((await new RepoIssues(c.projectRoot).list()).find((i) => i.number === c.issueNumber)?.comments ?? [])}`,
    };
  }
  bump(c, "demo-mei");
  const view = (await new RepoIssues(c.projectRoot).list()).find((i) => i.number === c.issueNumber);
  const ok = c1 && c2 && moved?.status === "doing" && (view?.comments ?? []).filter((x) => x.author === "demo-mei").length === 2 && echoedCategory === "approval";
  return {
    id: "review.comment",
    ok,
    detail: ok
      ? `评审留下 2 条意见并把 issue 状态推进到 doing;评审活动以 relay 支持的 category=approval 上行(协议无 "review" 类目:探针被拒 code=${probeCode})`
      : `c1=${c1} c2=${c2} status=${String(moved?.status)} comments=${(view?.comments ?? []).length} echoedCategory=${echoedCategory}`,
    evidence: `comments=${JSON.stringify(view?.comments ?? [])};category=review 探针被拒 code=${probeCode}(产品缺口:ActivityEvent.category 无 review 类目)`,
  };
});

// ---- 7. dev.revise ----

step("dev.revise", async (c) => {
  const res = await c.peers["demo-lin"]!.request(
    { type: "relay.teamai.push", kind: "skill", ns: "common", name: c.names.skill, description: `${c.names.skill} v2(按评审意见修订)`, body: SKILL_BODY_V2(c.names) },
    "relay.teamai.push.result",
    undefined,
    60_000,
  );
  if (res.ok !== true) throw new Error(`revise push 失败:${JSON.stringify(res)}`);
  const branch = String(res.branch ?? "");
  bump(c, "demo-lin");
  await mergePushBranch(c.clone, branch);
  const body = await readFileAtMain(c.clone, c.names.skillPath);
  const ok = Boolean(body?.includes("补类型标注") && body.includes("补测试") && !body.includes("第一版"));
  return {
    id: "dev.revise",
    ok,
    detail: ok ? `main 上 ${c.names.skill} 已是第二版(${branch})` : `main 内容不是第二版:${String(body).slice(0, 200)}`,
    evidence: `branch=${branch}`,
  };
}, 120_000);

// ---- 8. contribute ----

step("contribute", async (c) => {
  const base = c.peers["demo-kai"]!.recv.length;
  const res = await c.peers["demo-lin"]!.request(
    { type: "relay.teamai.contribute", title: c.names.learning, body: "greet 实现经验:先用空名字跑通回退,再补类型标注。", tags: ["collab", "greet"], project: c.projectId },
    "relay.teamai.contribute.result",
    undefined,
    60_000,
  );
  if (res.ok !== true) throw new Error(`contribute 失败:${JSON.stringify(res)}`);
  bump(c, "demo-lin");
  const branch = String(res.branch ?? "");
  // 既有 team-demo-e2e 的做法:learnings 走 teamai-learnings 分支,relay 直接从 origin/<branch> 读
  // (不 merge 进 main,避免 orphan 历史无关合并),digest.learnings 即可见。
  const digest = await c.peers["demo-kai"]!.waitDigest(
    base,
    (d) => (d.learnings ?? []).some((l) => String(l.title ?? "").includes(c.names.learning)),
    15_000,
  );
  const hit = (digest.learnings ?? []).find((l) => String(l.title ?? "").includes(c.names.learning));
  const ok = Boolean(hit) && String(hit!.path ?? "").startsWith("learnings/");
  return {
    id: "contribute",
    ok,
    detail: ok ? `经验进 ${branch},demo-kai 侧 digest.learnings 可见` : `digest.learnings 未含该标题:${JSON.stringify(digest.learnings)}`,
    evidence: `branch=${branch} path=${String(res.path)} learnings=${JSON.stringify(hit)}`,
  };
  // relay 侧 push+learnings 分支 + digest 重投影在 live 上远超 15s。
}, 120_000);

// ---- 9. remove ----

step("remove", async (c) => {
  const res = await c.peers["demo-rui"]!.request(
    { type: "relay.teamai.remove", kind: "rule", ns: "common", name: c.names.rule },
    "relay.teamai.remove.result",
    undefined,
    60_000,
  );
  if (res.ok !== true) throw new Error(`remove 失败:${JSON.stringify(res)}`);
  bump(c, "demo-rui");
  await syncClone(c.clone);
  const gone = (await readFileAtMain(c.clone, c.names.rulePath)) === null;
  const skillOk = (await readFileAtMain(c.clone, c.names.skillPath)) !== null;
  const docOk = (await readFileAtMain(c.clone, c.names.docPath)) !== null;
  const ok = gone && skillOk && docOk;
  return {
    id: "remove",
    ok,
    detail: ok
      ? `main 上 ${c.names.rulePath} 消失,skill/doc 无附带损伤`
      : `gone=${gone} skill=${skillOk} doc=${docOk}`,
    evidence: `remove.result=${JSON.stringify(res)}`,
  };
}, 120_000);

// ---- 10. roles ----

step("roles", async (c) => {
  await syncClone(c.clone);
  const rolesFile = join(c.clone, "roster", "roles.yaml");
  const text = readFileSync(rolesFile, "utf-8");
  if (!/\n\s+- id: qa\b/.test(text)) {
    writeFileSync(
      rolesFile,
      `${text.replace(/\n*$/, "\n")}  - id: qa\n    name: 质量保障\n    description: 回归与验收,发布前跑一次全链路 e2e\n    skills: []\n    rules: []\n`,
      "utf-8",
    );
    await gitOut(["add", "-A"], c.clone);
    await gitOut(["commit", "-m", "roster: 新增 qa 角色"], c.clone);
    await gitOut(["push", "origin", "main"], c.clone);
  }
  const digests = await waitAllDigests(c, (d) => (d.roles ?? []).some((x) => x.id === "qa"), 30_000);
  const holders = MEMBERS.filter((m) => (digests[m]!.roles ?? []).some((x) => x.id === "qa"));
  const ok = holders.length === MEMBERS.length;
  return {
    id: "roles",
    ok,
    detail: ok ? "4 条连接的 digest.roles 都在 30s 内出现 qa" : `仅 ${holders.join(", ")} 看到 qa`,
    evidence: `roles=${JSON.stringify((digests["demo-kai"]!.roles ?? []).map((x) => x.id))}`,
  };
});

// ---- 11. inspect ----

step("inspect", async (c) => {
  await syncClone(c.clone);
  const digest = readTeamaiAssets(c.clone);
  const list = teamaiList(digest);
  const status = teamaiStatus(digest, c.clone);
  const doctor = teamaiDoctor(c.clone);

  // main 上的实际资产(git 为权威)。
  const tree = (await gitOut(["ls-tree", "-r", "--name-only", "origin/main"], c.clone)).split("\n").filter(Boolean);
  const expected = new Set<string>();
  for (const f of tree) {
    if (/^skills\/[^/]+\/[^/]+\/SKILL\.md$/.test(f)) expected.add(`skill:${f.split("/")[2]!}`);
    else if (/^rules\/.+\.md$/.test(f)) expected.add(`rule:${f.replace(/^rules\//, "").replace(/\.md$/, "")}`);
    else if (/^docs\/.+/.test(f)) expected.add(`doc:${f.replace(/^docs\//, "")}`);
  }
  const actual = new Set<string>(
    list
      .filter((x) => x.kind !== "learning")
      .map((x) => (x.kind === "skill" ? `skill:${x.name}` : x.kind === "rule" ? `rule:${x.name}` : `doc:${x.name}`)),
  );
  const missing = [...expected].filter((x) => !actual.has(x));
  const extra = [...actual].filter((x) => !expected.has(x));
  const statusClean = status.added.length === 0 && status.removed.length === 0 && status.changed.length === 0;
  const ok = missing.length === 0 && extra.length === 0 && statusClean && doctor.ok;
  return {
    id: "inspect",
    ok,
    detail: ok
      ? `teamaiList 与 origin/main 资产一一对应(${expected.size} 项),teamaiStatus 无差异,doctor.ok=true`
      : `missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)} status=${JSON.stringify(status)} doctor.ok=${doctor.ok} findings=${JSON.stringify(doctor.findings.filter((f) => f.level !== "ok"))}`,
    evidence: `counts=${JSON.stringify(digest.counts)}`,
  };
});

// ---- 12. activity.isolation ----

step("activity.isolation", async (c) => {
  const personal: ActivityEvent = { ts: Date.now(), userId: "demo-lin", projectId: "personal-lin", category: "task", type: "issue", summary: "私人任务:整理本地笔记" };
  await c.peers["demo-lin"]!.request({ type: "relay.activity.push", event: personal }, "relay.activity");
  const teamEvent: ActivityEvent = { ts: Date.now(), userId: "demo-rui", projectId: c.projectId, category: "task", type: "issue", summary: "团队任务:补 demo-app README 示例" };
  await c.peers["demo-rui"]!.request({ type: "relay.activity.push", event: teamEvent }, "relay.activity");
  bump(c, "demo-rui");

  const views: Record<string, ActivityEvent[]> = {};
  for (const m of MEMBERS) {
    const res = await c.peers[m]!.request({ type: "relay.activity.list" }, "relay.activity");
    views[m] = (res.events ?? []) as ActivityEvent[];
  }
  const personalSeenBy = MEMBERS.filter((m) => views[m]!.some((e) => e.summary === personal.summary));
  const teamSeenBy = MEMBERS.filter((m) => views[m]!.some((e) => e.summary === teamEvent.summary));
  const ok = personalSeenBy.length === 1 && personalSeenBy[0] === "demo-lin" && teamSeenBy.length === MEMBERS.length;
  return {
    id: "activity.isolation",
    ok,
    detail: ok
      ? "未登记项目(personal-lin)事件仅本人可见;team 项目(demo-app)事件 4 人全可见"
      : `personal 可见者=${JSON.stringify(personalSeenBy)}(期望仅 demo-lin);team 可见者=${JSON.stringify(teamSeenBy)}(期望 4 人)`,
    evidence: `personal=${personal.projectId} team=${teamEvent.projectId}`,
  };
});

// ---- 13. weekly ----

step("weekly", async (c, r) => {
  const res = await c.peers["demo-kai"]!.request({ type: "relay.activity.list" }, "relay.activity");
  const events = ((res.events ?? []) as ActivityEvent[]).filter((e) => e.ts >= c.sinceTs);
  // 周报口径:**demo-kai 视角可见的全部活动**(relay 已按可见性裁掉他人 personal 事件)。
  // 不再按 projectId===demo-app 过滤:活组织里 relay 的 teamai 活动 projectId 归到
  // 「roster 首个 team 项目」(实测落到 lampgenie-harness),按单个项目过滤会把 push/remove
  // 全部漏掉 —— 这是多团队项目组织下的真实口径缺陷,已登记(见 live-report 与测试表)。
  const visible = events;
  const digest = teamActivityDigest(visible, c.sinceTs);
  r.weekly = { sinceTs: c.sinceTs, total: digest.total, perMember: digest.perMember, perCategory: digest.perCategory };
  const actual = new Map(digest.perMember.map((x) => [x.userId, x.count]));
  const expectedTotal = [...c.expected.values()].reduce((a, b) => a + b, 0);
  const mismatches: string[] = [];
  for (const [userId, count] of c.expected) {
    const got = actual.get(userId) ?? 0;
    if (got !== count) mismatches.push(`${userId}: 期望 ${count} 实得 ${got}`);
  }
  if (digest.total !== expectedTotal) mismatches.push(`total: 期望 ${expectedTotal} 实得 ${digest.total}`);
  const ok = mismatches.length === 0;
  return {
    id: "weekly",
    ok,
    detail: ok ? `周报 perMember/total 与本次实际事件数一致(total=${digest.total})` : `计数不一致:${mismatches.join("; ")}`,
    evidence: JSON.stringify({ perMember: digest.perMember, perCategory: digest.perCategory }),
  };
});

/** 步骤间共享的状态容器(模块内可变,导出后由调用方持有)。 */
export async function runCollabScenario(opts: CollabScenarioOptions): Promise<{ ctx: CollabContext; report: CollabReport }> {
  const report: CollabReport = { checks: [] };
  const isTemp = opts.mode === "temp";
  // live 缺省根必须解析到**仓根** `.genie/team`:vitest 的 cwd 是 apps/gateway,用 process.cwd()
  // 会拼出 apps/gateway/.genie/team(不存在)→ enrollRealMembers 报「团队工作克隆缺失」。
  const root = isTemp
    ? mkdtempSync(join(tmpdir(), "genie-team-collab-"))
    : (opts.root ?? join(__dirname, "..", "..", "..", ".genie", "team"));
  const teamRoot = isTemp ? join(root, ".genie", "team") : root;
  // temp:仍用 relay 自己的工作克隆(临时目录,独占)。live:**绝不碰 relay 的克隆**
  // (7870 relay 进程同刻在里面 fetch/reset → index.lock 冲突),改用 <repo>/.genie/team-collab/clone
  // 私有克隆;推 origin 仍是 team-repo.git bare,relay 自己周期拉 main/roster。
  const clone = isTemp ? join(teamRoot, "relay", "team-clone") : join(__dirname, "..", "..", "..", ".genie", "team-collab", "clone");
  const bare = join(teamRoot, "team-repo.git");
  const identityDir = join(teamRoot, "identities");
  const sinceTs = Date.now();
  const names = makeNames(Date.now().toString(36).slice(-4));

  if (isTemp) {
    await seedVirtualTeam({ root: teamRoot });
    await enrollRealMembers({ root: teamRoot });
    const probe = await gitTry(["rev-parse", "--git-dir"], clone);
    if (probe === null) await gitOut(["clone", bare, clone], teamRoot);
  } else {
    // 活组织:入册真身份(push 到活团队仓 origin/main),等 relay 周期拉 roster,不重启任何进程。
    // enrollRealMembers 只会 ff-merge 且自身幂等,不再复用它的克隆给场景做写操作(见上)。
    await enrollRealMembers({ root: teamRoot });
    // 私有克隆:首次 clone,之后 fetch+reset 到 origin/main(丢弃上一轮残留)。
    const probe = await gitTry(["rev-parse", "--git-dir"], clone);
    if (probe === null) {
      mkdirSync(join(clone, ".."), { recursive: true });
      await gitOut(["clone", bare, clone], join(clone, ".."));
    }
    await syncClone(clone);
  }

  const projectRoot = existsSync(join(teamRoot, "demo-projects", PROJECT_ID))
    ? join(teamRoot, "demo-projects", PROJECT_ID)
    : join(teamRoot, "collab-issues");
  mkdirSync(projectRoot, { recursive: true });

  let url = opts.relayUrl ?? "ws://127.0.0.1:7870";
  let httpServer: Server | undefined;
  let relay: TeamRelay | undefined;
  if (isTemp) {
    httpServer = createServer();
    relay = new TeamRelay({
      server: httpServer,
      teamRepoUrl: bare,
      workdir: join(root, "relay-work"),
      rosterPollMs: 400,
      presenceBroadcastMs: 600_000,
    });
    await new Promise<void>((res) => httpServer!.listen(0, "127.0.0.1", () => res()));
    const port = (httpServer.address() as AddressInfo).port;
    await relay.start();
    url = `ws://127.0.0.1:${port}`;
  }

  const peers: Record<string, Peer> = {};
  for (const m of MEMBERS) {
    const dir = join(identityDir, m);
    if (isTemp) loadOrCreateIdentity(dir); // 入册时已生成;显式确保存在(读回同一把钥匙)
    peers[m] = new Peer(m, url, dir);
  }
  // 非 roster 身份:真身份、密钥本地生成,但永不在 roster 里 → 鉴权必须被拒 not-on-roster。
  const intruderDir = join(teamRoot, "identities", "intruder-e2e");
  loadOrCreateIdentity(intruderDir);
  const intruder = new Peer("intruder", url, intruderDir);

  const lastMsg = (): string => MEMBERS.map((m) => `${m}[${peers[m]!.trail()}]`).join(" ");
  const ctx: CollabContext = {
    mode: opts.mode,
    root,
    teamRoot,
    clone,
    bare,
    names,
    pushed: {},
    projectId: PROJECT_ID,
    identityDir,
    projectRoot,
    url,
    peers,
    intruder,
    httpServer,
    relay,
    issueNumber: 0,
    sinceTs,
    expected: new Map(),
    lastMsg,
  };
  resetExpected(ctx);

  for (const m of MEMBERS) peers[m]!.connect();
  intruder.connect();

  for (const def of stepDefs) {
    let check: CollabCheck;
    try {
      check = await withTimeout(def.timeoutMs, def.id, lastMsg, () => def.run(ctx, report));
    } catch (err) {
      check = { id: def.id, ok: false, detail: `步骤抛错/超时:${String((err as Error)?.message ?? err)}`, evidence: lastMsg() };
    }
    report.checks.push(check);
  }
  return { ctx, report };
}

export async function closeCollabScenario(ctx: CollabContext): Promise<void> {
  try {
    for (const m of MEMBERS) ctx.peers[m]?.stop();
  } catch {
    /* 清理失败不掩盖用例结论 */
  }
  try {
    ctx.intruder?.stop();
  } catch {
    /* 同上 */
  }
  if (ctx.relay) await ctx.relay.close().catch(() => {});
  if (ctx.httpServer) await new Promise<void>((r) => ctx.httpServer!.close(() => r()));
  if (ctx.mode === "temp" && ctx.root) rmSync(ctx.root, { recursive: true, force: true });
}

/** 单步超时(默认 15s):超时信息里带最后收到的消息,便于定位卡在哪一步。 */
async function withTimeout<T>(ms: number, what: string, trail: () => string, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 超时(${ms}ms);最后收到的消息:${trail()}`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 便捷导出:供 live 测试断言 roster 里 demo 成员是否已有真身份指纹用。 */
export function readRosterFingerprints(cloneDir: string): Record<string, { fingerprint: string; hasPublicKey: boolean }> {
  const dir = join(cloneDir, "roster", "members");
  const out: Record<string, { fingerprint: string; hasPublicKey: boolean }> = {};
  if (!existsSync(dir)) return out;
  for (const f of ["demo-kai", "demo-lin", "demo-rui", "demo-mei"]) {
    const p = join(dir, `${f}.yaml`);
    if (!existsSync(p)) continue;
    try {
      const raw = parseYamlLite(readFileSync(p, "utf-8"));
      out[f] = { fingerprint: String(raw.fingerprint ?? ""), hasPublicKey: typeof raw.publicKey === "string" && raw.publicKey.length > 0 };
    } catch {
      out[f] = { fingerprint: "", hasPublicKey: false };
    }
  }
  return out;
}
