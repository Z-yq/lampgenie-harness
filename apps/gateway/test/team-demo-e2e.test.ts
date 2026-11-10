/**
 * 团队功能端到端(W4):seed 虚拟组织 → 真实身份入册 → relay 认证 → 角色/权限位分离 →
 * 团队仓 push/MR 合并/pull 双向一致 → 活动流 → contribute 回流 → remove → issue 协作 → 一键清理。
 * 覆盖边界(不假装):
 * 1. 成员加入用「roster 落盘模拟」:两个真实 ed25519 身份(loadOrCreateIdentity)的指纹写进
 *    roster/members 后提交推送;invite 兑换路径由既有 team-native-rest / team-provider-relay-e2e 测试覆盖。
 * 2. teamai push 是 MR 语义:relay 把资源写成 `teamai/push/<user>/<ts>` 分支(见 team-relay.doTeamaiPush),
 *    CustomGitProvider 只推分支、不自动合并。因此本测试扮演 reviewer 把分支 merge 进 main 并推回,
 *    再发 `relay.roster.changed` 让 relay 走真实下行链路(pullRoster → broadcastTeamaiDigest)。
 * 3. digest.rules 只投影 `rules/` 顶层 `*.md`(teamai-bridge.readTeamaiAssets),而 push 落点恒为嵌套的
 *    `rules/<ns>/<name>.md`,所以「规则本体两视角一致」以团队仓 main 的字节为权威断言;
 *    digest 侧的跨成员可见性由 doc 方向(digest.docs)与 contribute(learnings)覆盖。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamRelay } from "@lampgenie/runtime/team/team-relay";
import { TeamRelayClient } from "@lampgenie/runtime/team/relay-client";
import { loadOrCreateIdentity, type Identity } from "@lampgenie/runtime/identity/identity";
import { stringifyYamlLite } from "@lampgenie/runtime/team/yaml-lite";
import { cleanupVirtualTeam, seedVirtualTeam, virtualTeamStatus } from "../src/team-demo";
import { RepoIssues } from "../src/issue-service";

const execFileP = promisify(execFile);
/** 全部 git 调用带显式提交身份:不依赖也不写入任何全局 git config。 */
const IDENT = ["-c", "user.name=e2e-team", "-c", "user.email=e2e-team@genie.local"];

async function gitOut(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", [...IDENT, ...args], { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}
/** 探测式 git(存在性检查用):失败返回 null。 */
async function gitTry(args: string[], cwd: string): Promise<string | null> {
  try {
    return await gitOut(args, cwd);
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立(禁止 sleep 硬等);超时打印最后收到的消息类型。 */
async function pollUntil<T>(what: string, probe: () => T | undefined, ms: number, trail: () => string): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const got = probe();
    if (got !== undefined) return got;
    if (Date.now() - t0 >= ms) throw new Error(`${what} 超时(${ms}ms);最后收到的消息:${trail()}`);
    await sleep(25);
  }
}

type Msg = { type: string } & Record<string, unknown>;

/** digest 里本测试用到的投影(其余字段忽略)。 */
interface Digest {
  pulledAt?: number;
  roles?: { id: string; name?: string }[];
  memberRoles?: Record<string, string>;
  counts?: { members?: number; rules?: number; docs?: number; learnings?: number };
  rules?: { name: string; body?: string }[];
  docs?: string[];
  learnings?: { title?: string; path?: string; body?: string }[];
}

const stripPulledAt = (d: Digest): string => {
  const { pulledAt: _ignored, ...rest } = d;
  return JSON.stringify(rest);
};

/** 一个 relay 客户端(TeamRelayClient 真连 + 消息缓冲,便于「等指定类型且超时可诊断」)。 */
class Peer {
  readonly recv: Msg[] = [];
  readonly client: TeamRelayClient;

  constructor(readonly name: string, url: string, readonly identityDir: string) {
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

  /** 发一条消息并等**本次**响应(基线=发送时刻的缓冲长度,不会拿到上一条结果)。 */
  request(msg: Record<string, unknown>, type: string, pred?: (m: Msg) => boolean, ms = 5000): Promise<Msg> {
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

  /** 等一条**基准之后**才到达的 digest(base=触发前 recv.length;可附加内容条件)。 */
  async waitDigest(base: number, pred?: (d: Digest) => boolean, ms = 8000): Promise<Digest> {
    const m = await this.waitFor("relay.teamai.digest", (x) => !pred || pred(x.digest as Digest), ms, base);
    return m.digest as Digest;
  }

  close(): void {
    this.client.stop();
  }
}

const ALICE = "e2e-alice";
const BOB = "e2e-bob";
const RULE_BODY = "# from-a —— e2e 规则\n\n由 A 经 relay push 落盘,经 reviewer 合并进 main。\n";
const DOC_BODY = "# from-b —— e2e 文档\n\n由 B 经 relay push 落盘,经 reviewer 合并进 main。\n";
const LEARNING_TITLE = "e2e-经验-B";
const LEARNING_MARKER = "e2e-contribute-marker";

let root: string;
let teamRoot: string;
let bare: string;
let clone: string;
let projectId: string;
let httpServer: Server;
let relay: TeamRelay;
let idA: Identity;
let idB: Identity;
let peerA: Peer;
let peerB: Peer;

/** 成员 yaml:role=权限位(owner/reviewer/member),roleId=角色命名空间(dev/reviewer),两字段分开。 */
function memberYaml(o: {
  username: string;
  displayName: string;
  fingerprint: string;
  role: string;
  roleId: string;
  project: string;
}): string {
  return stringifyYamlLite({
    username: o.username,
    displayName: o.displayName,
    fingerprint: o.fingerprint,
    keys: [o.fingerprint],
    role: o.role,
    roleId: o.roleId,
    projects: [o.project],
    invitedBy: "demo-kai",
    registeredAt: "2026-10-29T00:00:00.000Z",
    revoked: false,
  });
}

/** 扮演 reviewer:把 relay 推上来的 teamai/push 分支 merge 进 main 并推回 origin(Custom provider 无真 MR 合并)。 */
async function mergePushBranch(branch: string): Promise<void> {
  await gitOut(["fetch", "origin"], clone);
  await gitOut(["checkout", "-f", "main"], clone);
  await gitOut(["reset", "--hard", "origin/main"], clone);
  await gitOut(["merge", "--no-ff", `origin/${branch}`, "-m", `review: merge ${branch}`], clone);
  await gitOut(["push", "origin", "main"], clone);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "genie-team-demo-e2e-"));
  teamRoot = join(root, ".genie", "team");
  const seeded = await seedVirtualTeam({ root: teamRoot });
  projectId = seeded.project.id;
  expect(seeded.project.commits).toBeGreaterThanOrEqual(2);
  bare = join(teamRoot, "team-repo.git");
  clone = join(teamRoot, "relay", "team-clone");

  // ① 两个真实身份(挑战签名用真私钥),以 roster 落盘模拟成员加入。
  idA = loadOrCreateIdentity(join(root, "identity-a"));
  idB = loadOrCreateIdentity(join(root, "identity-b"));
  const membersDir = join(clone, "roster", "members");
  mkdirSync(membersDir, { recursive: true });
  writeFileSync(
    join(membersDir, `${ALICE}.yaml`),
    memberYaml({ username: ALICE, displayName: "E2E Alice(开发)", fingerprint: idA.fingerprint, role: "member", roleId: "dev", project: projectId }),
    "utf-8",
  );
  writeFileSync(
    join(membersDir, `${BOB}.yaml`),
    memberYaml({ username: BOB, displayName: "E2E Bob(评审)", fingerprint: idB.fingerprint, role: "member", roleId: "reviewer", project: projectId }),
    "utf-8",
  );
  await gitOut(["add", "-A"], clone);
  await gitOut(["commit", "-m", `roster: add ${ALICE} + ${BOB}(e2e 真实身份入册)`], clone);
  await gitOut(["push", "origin", "main"], clone);

  // ② relay:自建 http server 拿空闲端口(port:0),轮询周期拉长到让本测试显式驱动。
  httpServer = createServer();
  relay = new TeamRelay({
    server: httpServer,
    teamRepoUrl: bare,
    workdir: join(root, "relay-work"),
    rosterPollMs: 400,
    presenceBroadcastMs: 600_000,
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
  const port = (httpServer.address() as AddressInfo).port;
  await relay.start();

  // ③ 两个客户端真连 + 挑战签名认证。
  const url = `ws://127.0.0.1:${port}`;
  peerA = new Peer("A", url, join(root, "identity-a"));
  peerB = new Peer("B", url, join(root, "identity-b"));
  peerA.connect();
  peerB.connect();
  await pollUntil(`${peerA.name} ready`, () => (peerA.client.ready ? true : undefined), 10_000, () => peerA.trail());
  await pollUntil(`${peerB.name} ready`, () => (peerB.client.ready ? true : undefined), 10_000, () => peerB.trail());
}, 180_000);

afterAll(async () => {
  try {
    peerA?.close();
    peerB?.close();
  } catch {
    /* 清理失败不掩盖用例结论 */
  }
  if (relay) await relay.close().catch(() => {});
  if (httpServer) await new Promise<void>((r) => httpServer.close(() => r()));
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("团队功能 e2e(seed 虚拟组织 + 真 relay + 真身份)", () => {
  it("1. 成员加入:roster 落盘的真实指纹 → 两个客户端都 relay.auth.ok", () => {
    // 以 roster 落盘模拟成员加入(真实身份指纹);invite 兑换路径由既有 team-native-rest/relay 测试覆盖。
    expect(existsSync(join(clone, "roster", "members", `${ALICE}.yaml`))).toBe(true);
    expect(existsSync(join(clone, "roster", "members", `${BOB}.yaml`))).toBe(true);
    expect(peerA.client.ready).toBe(true);
    expect(peerB.client.ready).toBe(true);
    const okA = peerA.recv.find((m) => m.type === "relay.auth.ok");
    const okB = peerB.recv.find((m) => m.type === "relay.auth.ok");
    expect((okA?.member as { username: string }).username).toBe(ALICE);
    expect((okB?.member as { username: string }).username).toBe(BOB);
  }, 30_000);

  it("2. 角色可见:digest.roles 含 dev/reviewer,memberRoles 把新成员映射到各自 roleId(≠权限位 role)", () => {
    const digest = peerA.lastDigest();
    expect(digest).toBeDefined();
    const roleIds = (digest!.roles ?? []).map((r) => r.id);
    expect(roleIds).toContain("dev");
    expect(roleIds).toContain("reviewer");
    expect(digest!.memberRoles?.[ALICE]).toBe("dev");
    expect(digest!.memberRoles?.[BOB]).toBe("reviewer");
    // 权限位与角色分字段:B 的 role(roster 权限位)=member,而 roleId(reviewer)不同名不同义。
    const okB = peerB.recv.find((m) => m.type === "relay.auth.ok");
    expect((okB?.member as { role: string }).role).toBe("member");
    expect(digest!.memberRoles?.[BOB]).not.toBe((okB?.member as { role: string }).role);
  }, 30_000);

  it("3. 团队仓 push→pull:A 的 rule 与 B 的 doc 都进 main,两视角 digest 一致", async () => {
    // 方向一:A push rule(MR 分支)。
    const pushA = await peerA.request(
      { type: "relay.teamai.push", kind: "rule", ns: "e2e", name: "from-a", description: "e2e 规则", body: RULE_BODY },
      "relay.teamai.push.result",
    );
    expect(pushA.ok).toBe(true);
    const branchA = String(pushA.branch);
    expect(branchA.startsWith(`teamai/push/${ALICE}/`)).toBe(true);
    await gitOut(["fetch", "origin"], clone);
    expect(await gitOut(["show", `origin/${branchA}:rules/e2e/from-a.md`], clone)).toContain("from-a —— e2e 规则");

    // reviewer 合并 → 通知 relay 拉取(pull 侧);两视角各自等「基准之后到达」的 digest。
    await mergePushBranch(branchA);
    const baseA = peerA.recv.length;
    const baseB = peerB.recv.length;
    peerA.send({ type: "relay.roster.changed" });
    const digestB = await peerB.waitDigest(baseB);
    const digestA = await peerA.waitDigest(baseA);
    // 两视角内容一致(同一份投影,pulledAt 除外)。
    expect(stripPulledAt(digestA)).toBe(stripPulledAt(digestB));
    // 规则本体以团队仓 main 的字节为权威;digest.rules 同时投影扁平 rules/<name>.md 与
 // 命名空间 rules/<ns>/<name>.md(修:此前只扫扁平层,嵌套规则进得了团队仓、
    // 出不来投影,counts.rules 恒 0)。故这里断言 A 侧 rule 已进两视角 digest。
    expect(await gitOut(["show", "origin/main:rules/e2e/from-a.md"], clone)).toContain("from-a —— e2e 规则");
    expect((digestB.rules ?? []).map((r) => r.name)).toContain("e2e/from-a");
    expect((digestA.rules ?? []).map((r) => r.name)).toContain("e2e/from-a");

    // 方向二:B push doc → A 侧 digest.docs 可见(跨视角 pull)。
    const pushB = await peerB.request(
      { type: "relay.teamai.push", kind: "doc", ns: "e2e", name: "from-b", description: "e2e 文档", body: DOC_BODY },
      "relay.teamai.push.result",
    );
    expect(pushB.ok).toBe(true);
    const branchB = String(pushB.branch);
    expect(branchB.startsWith(`teamai/push/${BOB}/`)).toBe(true);
    await mergePushBranch(branchB);
    const baseA2 = peerA.recv.length;
    const baseB2 = peerB.recv.length;
    peerB.send({ type: "relay.roster.changed" });
    const digestA2 = await peerA.waitDigest(baseA2, (d) => (d.docs ?? []).includes("from-b.md"));
    const digestB2 = await peerB.waitDigest(baseB2, (d) => (d.docs ?? []).includes("from-b.md"));
    // digest.docs 里的路径相对 docs/(无前缀),所以条目名就是 from-b.md。
    expect(digestA2.docs ?? []).toContain("from-b.md");
    expect(stripPulledAt(digestB2)).toBe(stripPulledAt(digestA2));
    expect(await gitOut(["show", "origin/main:docs/from-b.md"], clone)).toContain("from-b —— e2e 文档");
  }, 120_000);

  it("4. 活动流:A 发 category=task 事件,B 用 activity.list 读到且 userId 是 A 的成员名", async () => {
    const event = {
      ts: Date.now(),
      userId: ALICE,
      projectId,
      category: "task",
      type: "issue",
      summary: "e2e-活动-A",
    };
    const echo = await peerA.request({ type: "relay.activity.push", event }, "relay.activity");
    expect(((echo.events as { summary: string }[])[0] ?? {}).summary).toBe("e2e-活动-A");

    const listed = await peerB.request({ type: "relay.activity.list" }, "relay.activity", (m) =>
      (m.events as { summary: string }[]).some((e) => e.summary === "e2e-活动-A"),
    );
    const hit = (listed.events as { userId: string; summary: string; category: string }[]).find(
      (e) => e.summary === "e2e-活动-A",
    );
    expect(hit).toBeDefined();
    expect(hit!.userId).toBe(ALICE);
    expect(hit!.category).toBe("task");
  }, 30_000);

  it("5. contribute 回流:B 的经验进 learnings 分支,A 侧 digest.learnings 可见(origin/<branch> 生效)", async () => {
    const baseA = peerA.recv.length;
    const res = await peerB.request(
      { type: "relay.teamai.contribute", title: LEARNING_TITLE, body: `${LEARNING_MARKER}\n\nrelay 内嵌 bare 无上游,读本地 origin/teamai-learnings。`, tags: ["e2e"] },
      "relay.teamai.contribute.result",
    );
    expect(res.ok).toBe(true);
    expect(res.branch).toBe("teamai-learnings");
    expect(String(res.path).startsWith("learnings/")).toBe(true);

    const digest = await peerA.waitDigest(baseA, (d) => (d.learnings ?? []).some((l) => String(l.title ?? "").includes(LEARNING_TITLE)));
    const hit = (digest.learnings ?? []).find((l) => String(l.title ?? "").includes(LEARNING_TITLE));
    expect(hit).toBeDefined();
    expect(String(hit!.path)).toContain("learnings/");
    expect(String(hit!.body ?? "")).toContain(LEARNING_MARKER);
  }, 60_000);

  it("6. remove 语义:A 删掉自己 push 的 rule → remove.result ok 且 main 上消失,B 侧无附带损伤", async () => {
    const baseB = peerB.recv.length;
    const res = await peerA.request(
      { type: "relay.teamai.remove", kind: "rule", ns: "e2e", name: "from-a" },
      "relay.teamai.remove.result",
    );
    expect(res.ok).toBe(true);
    expect(res.path).toBe("rules/e2e/from-a.md");

    await gitOut(["fetch", "origin"], clone);
    expect(await gitTry(["cat-file", "-e", "origin/main:rules/e2e/from-a.md"], clone)).toBeNull();
    expect(await gitTry(["cat-file", "-e", "origin/main:docs/from-b.md"], clone)).not.toBeNull();

    // 等「remove 之后的投影」而不是「下一个 digest」:relay 在 remove 前后可能连推两帧,
 // baseB 之后的第一个帧仍可能是 remove 前的快照(经验证偶发,非产品缺陷)。
    const digest = await peerB.waitDigest(
      baseB,
      (d) => (d.rules ?? []).some((r) => String(r.name).startsWith("demo/")) && !(d.rules ?? []).some((r) => String(r.name).includes("e2e/from-a")),
    );
    expect((digest.rules ?? []).map((r) => r.name)).not.toContain("e2e/from-a");
    // 无附带损伤:其它资产与成员计数不受 remove 影响(digest.rules 现可见嵌套规则,见第 3 条说明)。
    expect((digest.docs ?? []).some((p) => String(p).includes("demo-team-guide"))).toBe(true);
    expect(digest.counts?.members).toBe(6); // 4 名 seed demo 成员 + 2 名 e2e 成员
  }, 60_000);

  it("7. issue 协作:两成员共享同一 issue 存储,创建/评论/状态流转互相可见", async () => {
    // issue 本体走 RepoIssues(本地 .genie/issues JSON 通道),两实例指向同一 project root =
    // 两名成员各自的 gateway 视图。跨成员可见性的另一条通道(活动流)已由第 4 条覆盖。
    const projectRoot = join(root, "issue-project");
    const asAlice = new RepoIssues(projectRoot);
    const asBob = new RepoIssues(projectRoot);

    const created = await asAlice.create({ projectId, title: "e2e: relay digest 下行延迟", body: "由 A 创建" });
    expect(created.number).toBe(1);
    expect(created.status).toBe("todo");

    const bView = await asBob.list();
    expect(bView.map((i) => i.number)).toEqual([1]);
    expect(bView[0]!.title).toBe("e2e: relay digest 下行延迟");

    expect(await asBob.comment(projectId, created.number, BOB, "B 评论:已复现")).toBe(true);
    const moved = await asBob.update(projectId, created.number, { status: "doing" });
    expect(moved?.status).toBe("doing");

    const aView = (await asAlice.list()).find((i) => i.number === created.number)!;
    expect(aView.status).toBe("doing");
    expect(aView.comments.map((c) => `${c.author}:${c.body}`)).toContain(`${BOB}:B 评论:已复现`);
  }, 30_000);

  it("8. 清理:cleanupVirtualTeam 后 demo 数据全清、demo-projects 不存在", async () => {
    // 先把工作克隆同步到 origin/main(relay 的 remove 推过新提交,避免非快进推送)。
    await gitOut(["fetch", "origin"], clone);
    await gitOut(["reset", "--hard", "origin/main"], clone);

    const { removed } = await cleanupVirtualTeam({ root: teamRoot });
    expect(removed).toContain("rules/demo");
    expect(removed).toContain("skills/demo");
    expect(removed).toContain("demo-projects");
    expect(existsSync(join(teamRoot, "demo-projects"))).toBe(false);

    const st = await virtualTeamStatus({ root: teamRoot });
    expect(st.members.filter((m) => m.startsWith("demo-"))).toEqual([]);
    expect(st.members).toEqual([ALICE, BOB]);
    expect(st.project).toBeNull();
  }, 120_000);
});
