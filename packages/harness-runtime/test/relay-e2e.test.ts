/**
 * step-032 e2e:邀请流全链/吊销即时踢/隐私红线/relay 挂演练(designs/05 验证方式四条)。
 * 团队仓=本地 bare git repo(CustomGitProvider 真实 git 命令;Codeup 实 API 待令牌,降级路径即本形态)。
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { TeamRelay } from "../src/team/team-relay.js";
import { TeamRelayClient } from "../src/team/relay-client.js";
import { loadOrCreateIdentity, fingerprintOf } from "../src/identity/identity.js";
import { signChallenge } from "../src/team/relay-auth.js";

const execFileP = promisify(execFile);
const git = (args: string[], cwd: string) => execFileP("git", args, { cwd }).then((r) => r.stdout.trim());

let dir: string;
let bare: string;
let relay: TeamRelay;
let httpServer: import("node:http").Server;
let relayUrl: string;
const ident = new Map<string, ReturnType<typeof loadOrCreateIdentity>>();

/** 简易测试客户端:挑战应答+请求/响应配对(按类型等待)。 */
class TestClient {
  ws: WebSocket;
  private waiters: { type: string; resolve: (m: Record<string, unknown>) => void }[] = [];
  received: Record<string, unknown>[] = [];
  closed = false;

  constructor(url: string, who: string) {
    this.ws = new WebSocket(url);
    this.ws.on("error", () => {});
    this.ws.on("close", () => { this.closed = true; });
    this.ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown> & { type: string };
      if (msg.type === "relay.challenge") {
        const id = ident.get(who)!;
        const pub = readFileSync(id.privateKeyPath.replace(/\.pem$/, ".pub"), "utf-8");
        const priv = readFileSync(id.privateKeyPath, "utf-8");
        this.ws.send(JSON.stringify({
          v: 1, type: "relay.auth",
          fingerprint: fingerprintOf(pub), publicKeyPem: pub,
          nonce: msg.nonce, sig: signChallenge(priv, msg.nonce as string),
        }));
        return;
      }
      this.received.push(msg);
      this.waiters.filter((w) => w.type === msg.type).forEach((w) => w.resolve(msg));
    });
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ v: 1, ...msg }));
  }

  wait(type: string, ms = 5000): Promise<Record<string, unknown>> {
    const hit = this.received.find((m) => m.type === type);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), ms);
      this.waiters.push({ type, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }

  close(): void {
    this.ws.close();
  }
}

/** 在 bare 仓的 main 上落一次提交(reviewer 动作,不经 relay)。 */
async function commitToMain(sub: (dir: string) => void, msg: string): Promise<void> {
  const wd = mkdtempSync(join(dir, "reviewer-"));
  await git(["clone", bare, wd], dir);
  sub(wd);
  const ident = ["-c", "user.email=reviewer@local", "-c", "user.name=reviewer"];
  await git([...ident, "add", "-A"], wd);
  await git([...ident, "commit", "-m", msg], wd);
  await git(["push", "origin", "main"], wd);
  rmSync(wd, { recursive: true, force: true });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "relay-e2e-"));
  // 团队仓(bare):owner roster + projects.yaml(team 项目+personal 项目)。
  bare = join(dir, "team.git");
  await git(["init", "--bare", "-b", "main", bare], dir);
  const seed = mkdtempSync(join(dir, "seed-"));
  await git(["clone", bare, seed], dir);
  mkdirSync(join(seed, "roster", "members"), { recursive: true });
  const ownerIdent = loadOrCreateIdentity(join(dir, "owner-identity"));
  ident.set("owner", ownerIdent);
  const ownerFp = ownerIdent.fingerprint;
  writeFileSync(join(seed, "roster", "members", "owner1.yaml"), [
    `username: owner1`, `displayName: Owner`, `fingerprint: ${ownerFp}`,
    `keys:`, `  - ${ownerFp}`, `role: owner`, `projects: []`,
    `registeredAt: 2026-10-11T00:00:00Z`, `revoked: false`, "",
  ].join("\n"));
  writeFileSync(join(seed, "roster", "projects.yaml"), [
    "lampgenie-harness.type: team", "lampgenie-harness.owner: owner1",
    "my-notes.type: personal", "my-notes.owner: owner1", "",
  ].join("\n"));
  const gi = ["-c", "user.email=seed@local", "-c", "user.name=seed"];
  await git([...gi, "add", "-A"], seed);
  await git([...gi, "commit", "-m", "roster: seed"], seed);
  await git(["push", "origin", "main"], seed);
  rmSync(seed, { recursive: true, force: true });

  // invitee 身份(尚未入册)。
  ident.set("alice", loadOrCreateIdentity(join(dir, "alice-identity")));

  // relay:短轮询周期(吊销即时踢用;默认 30s)。
  httpServer = createServer();
  relay = new TeamRelay({
    server: httpServer, teamRepoUrl: bare, workdir: join(dir, "relay-work"),
    rosterPollMs: 150, presenceBroadcastMs: 200,
  });
  await new Promise<void>((r) => httpServer.listen(0, r));
  relayUrl = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  await relay.start();
}, 60_000);

afterAll(async () => {
  await relay.close().catch(() => {});
  await new Promise<void>((r) => httpServer.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe("step-032 Team Relay e2e", () => {
  it("D1 邀请流全链:邀请→兑换→MR 分支→合并→pull 生效;合并前无任何权限", async () => {
    // ① owner 连接并鉴权通过。
    const owner = new TestClient(relayUrl, "owner");
    await owner.wait("relay.auth.ok");

    // ② alice(未入册)鉴权被拒——roster 合并前无任何权限(红线);code 供 client 区分重试/永久。
    const alice = new TestClient(relayUrl, "alice");
    const rej = await alice.wait("relay.auth.reject");
    expect(rej.reason).toContain("roster");
    expect(rej.code).toBe("not-on-roster");
    // 未认证连接的受限面:invite.create 必须被拒。
    alice.send({ type: "relay.invite.create" });
    const err = await alice.wait("error");
    expect(err.code).toBe("unauthenticated");

    // ③ owner 发邀请码。
    owner.send({ type: "relay.invite.create" });
    const issued = await owner.wait("relay.invite.issued");
    const code = issued.code as string;
    expect(code).toBeTruthy();

    // ④ alice 兑换:relay 在团队仓创建 roster 分支(伪 MR)。
    alice.send({
      type: "relay.invite.redeem", code, username: "alice", displayName: "Alice",
      fingerprint: ident.get("alice")!.fingerprint,
    });
    const result = await alice.wait("relay.invite.result");
    expect(result.ok).toBe(true);
    const branch = (result.mr as Record<string, unknown>).branch as string;
    // 分支真实存在于 bare 仓。
    const ls = await git(["ls-remote", "--heads", bare], dir);
    expect(ls).toContain(branch);
    // 兑换码即刻作废(一次性):轮询等第二条 result(wait 会命中首条缓存)。
    alice.send({ type: "relay.invite.redeem", code, username: "alice2", displayName: "", fingerprint: ident.get("alice")!.fingerprint });
    const second = await new Promise<Record<string, unknown> | null>((resolve) => {
      const started = Date.now();
      const tick = () => {
        const rs = alice.received.filter((m) => m.type === "relay.invite.result");
        if (rs.length >= 2) return resolve(rs[1]!);
        if (Date.now() - started > 3000) return resolve(null);
        setTimeout(tick, 50);
      };
      tick();
    });
    expect(second?.ok).toBe(false);
    expect(second?.reason).toBe("邀请码已被兑换");

    // ⑤ reviewer 合并(真实 git merge,不经 relay)。
    await commitToMain((wd) => {
      // 分支已在远端:取回并 fast-forward 合并到 main。
    }, `__noop__`).catch(() => {}); // 先验证直接 merge 流程:
    const wd = mkdtempSync(join(dir, "merger-"));
    await git(["clone", bare, wd], dir);
    await git(["fetch", "origin", branch], wd);
    await git(["checkout", "main"], wd);
    await git(["merge", `origin/${branch}`], wd);
    await git(["push", "origin", "main"], wd);
    rmSync(wd, { recursive: true, force: true });

    // ⑥ 通知 relay 拉取(roster.changed;轮询是兜底)。
    owner.send({ type: "relay.roster.changed" });
    await new Promise((r) => setTimeout(r, 400));

    // ⑦ alice 重连:鉴权通过(成员资格生效)。
    const alice2 = new TestClient(relayUrl, "alice");
    await alice2.wait("relay.auth.ok");

    // D3 隐私红线(在此连接上验):personal 项目对他人不可见。
    // 归属校验:活动只能以本人 userId 上行——alice 伪造 owner1 活动=拒,推自己的 team 活动=收。
    alice2.send({ type: "relay.activity.push", event: { ts: Date.now(), userId: "owner1", projectId: "lampgenie-harness", category: "task", type: "spoof", summary: "伪造 owner 活动" } });
    const spoof = await alice2.wait("error");
    expect(spoof.code).toBe("forbidden");
    alice2.send({ type: "relay.activity.push", event: { ts: Date.now() + 1, userId: "alice", projectId: "lampgenie-harness", category: "task", type: "submitted", summary: "接口联调 task#129" } });
    // owner 推自己的 personal 活动(my-notes 是 owner1 的 personal 项目)。
    const ownerSelf = new TestClient(relayUrl, "owner");
    await ownerSelf.wait("relay.auth.ok");
    ownerSelf.send({ type: "relay.activity.push", event: { ts: Date.now() + 2, userId: "owner1", projectId: "my-notes", category: "task", type: "submitted", summary: "写周报草稿(personal)" } });
    await new Promise((r) => setTimeout(r, 200));
    // alice 视角拉活动流:team 条目可见,personal(他人)条目被过滤。
    alice2.send({ type: "relay.activity.list" });
    const listAck = await new Promise<Record<string, unknown>[]>((resolve) => {
      const onMsg = (raw: Buffer) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "relay.activity" && Array.isArray(m.events)) {
          alice2.ws.off("message", onMsg);
          resolve(m.events);
        }
      };
      alice2.ws.on("message", onMsg as never);
      setTimeout(() => resolve([]), 3000);
    });
    const summaries = listAck.map((e) => (e as Record<string, unknown>).summary);
    expect(summaries).toContain("接口联调 task#129");
    expect(summaries).not.toContain("写周报草稿(personal)");
    expect(summaries).not.toContain("伪造 owner 活动");
    // alice 查 owner1 成员卡:personal 任务名不可见(currentTask=null),状态可见。
    alice2.send({ type: "relay.query.member", target: "owner1" });
    const card = await alice2.wait("relay.query.result");
    expect((card.card as Record<string, unknown>).currentTask).toBeNull();
    // owner 自查:personal 任务对自己可见。
    ownerSelf.send({ type: "relay.query.member", target: "owner1" });
    const selfCard = await ownerSelf.wait("relay.query.result");
    expect((selfCard.card as Record<string, unknown>).currentTask).toBe("写周报草稿(personal)");
    // 不存在的成员=notFound(轮询取下一条 query.result,避缓存命中)。
    alice2.send({ type: "relay.query.member", target: "nobody" });
    const nf = await new Promise<Record<string, unknown> | null>((resolve) => {
      const started = Date.now();
      const tick = () => {
        const rs = alice2.received.filter((m) => m.type === "relay.query.result");
        const hit = rs.find((r) => r.notFound === true);
        if (hit || rs.length >= 3 || Date.now() - started > 3000) return resolve(hit ?? null);
        setTimeout(tick, 50);
      };
      tick();
    });
    expect(nf?.notFound).toBe(true);

    // D2 吊销即时性:reviewer 把 alice 标记 revoked → 轮询周期内被踢。
    const t0 = Date.now();
    await commitToMain((wd) => {
      const f = join(wd, "roster", "members", "alice.yaml");
      const txt = readFileSync(f, "utf-8");
      writeFileSync(f, txt.replace("revoked: false", "revoked: true"));
    }, "roster: revoke alice");
    const kick = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("吊销后未被踢")), 5000);
      const onMsg = (raw: Buffer) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "relay.auth.reject") { clearTimeout(t); resolve(m); }
      };
      alice2.ws.on("message", onMsg as never);
    });
    await new Promise<void>((resolve) => {
      if (alice2.closed) return resolve();
      alice2.ws.on("close", () => resolve());
      setTimeout(resolve, 3000);
    });
    expect(alice2.closed).toBe(true);
    expect(String(kick.reason)).toContain("吊销");
    const kickMs = Date.now() - t0;
    expect(kickMs).toBeLessThan(30_000); // designs/05 验收线:30s 内(实测值进记录)
    // eslint-disable-next-line no-console
    console.log(`[D2] 吊销→踢连接实测 ${kickMs}ms(轮询 150ms)`);

    owner.close(); alice.close(); alice2.close(); ownerSelf.close();
  }, 60_000);

  it("安全与流加固:挑战重放拒/伪造拒/未知项目 fail-closed/not-on-roster 合并后自动恢复", async () => {
    // ① 重放攻击:第一连接的真实握手续(nonce+sig)重放到第二连接(新挑战)必须被拒——
    // nonce 绑定校验先于 roster 查询(未入册的 bob 也应拿到「重放」而非「不在 roster」)。
    const idBob = loadOrCreateIdentity(join(dir, "bob-identity"));
    ident.set("bob", idBob);
    const pub = readFileSync(idBob.privateKeyPath.replace(/\.pem$/, ".pub"), "utf-8");
    const priv = readFileSync(idBob.privateKeyPath, "utf-8");
    const fp = idBob.fingerprint;

    const c1 = new WebSocket(relayUrl);
    const n1 = await new Promise<string>((resolve) => {
      c1.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.type === "relay.challenge") resolve(m.nonce); });
    });
    const sig1 = signChallenge(priv, n1);
    const c2 = new WebSocket(relayUrl);
    const n2 = await new Promise<string>((resolve) => {
      c2.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.type === "relay.challenge") resolve(m.nonce); });
    });
    expect(n2).not.toBe(n1);
    const replay = await new Promise<Record<string, unknown>>((resolve) => {
      c2.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.type === "relay.auth.reject") resolve(m); });
      c2.send(JSON.stringify({ v: 1, type: "relay.auth", fingerprint: fp, publicKeyPem: pub, nonce: n1, sig: sig1 }));
    });
    expect(replay.code).toBe("bad-sig");
    expect(String(replay.reason)).toContain("重放");
    c1.close();
    c2.close();

    // ② bob 未入册:reject 带 code=not-on-roster;真 client 保持退避重试(不永久停)。
    const bobStates: string[] = [];
    const bobMsgs: Record<string, unknown>[] = [];
    const bobClient = new TeamRelayClient({
      url: relayUrl, identityDir: join(dir, "bob-identity"), backoffBaseMs: 100,
      onState: (s) => bobStates.push(s),
      onMessage: (m) => bobMsgs.push(m as unknown as Record<string, unknown>),
    });
    bobClient.connect();
    await new Promise((r) => setTimeout(r, 600));
    const bobRej = bobMsgs.find((m) => m.type === "relay.auth.reject");
    expect(bobRej?.code).toBe("not-on-roster");
    expect(bobStates).toContain("rejected");
    expect(bobStates.filter((s) => s === "connecting").length).toBeGreaterThanOrEqual(2);

    // ③ reviewer 合并 bob 入册 → relay 轮询拉到 → 同一 client 自动恢复 ready(免重启)。
    await commitToMain((wd) => {
      mkdirSync(join(wd, "roster", "members"), { recursive: true });
      writeFileSync(join(wd, "roster", "members", "bob.yaml"), [
        `username: bob`, `displayName: Bob`, `fingerprint: ${fp}`,
        `keys:`, `  - ${fp}`, `role: member`, `projects: []`,
        `registeredAt: 2026-10-13T00:00:00Z`, `revoked: false`, "",
      ].join("\n"));
    }, "roster: add bob");
    const ready = await new Promise<boolean>((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (bobClient.ready) return resolve(true);
        if (Date.now() - t0 > 8000) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });
    expect(ready).toBe(true);

    // ④ 全量 presence 快照:认证后立即收到含全部非 revoked 成员的 states(diff 只有变化项,新连接没有基线)。
    const bobRaw = new TestClient(relayUrl, "bob");
    await bobRaw.wait("relay.auth.ok");
    const snap = await bobRaw.wait("relay.presence.diff");
    const snapNames = ((snap.states as Record<string, unknown>[]) ?? []).map((s) => s.username);
    expect(snapNames).toContain("owner1");
    expect(snapNames).toContain("bob");

    // ⑤ 归属校验:bob 伪造 owner1 活动=拒;自己的活动(未登记项目)=收。
    bobRaw.send({ type: "relay.activity.push", event: { ts: Date.now(), userId: "owner1", projectId: "lampgenie-harness", category: "task", type: "spoof", summary: "bob 伪造 owner 活动" } });
    const ferr = await bobRaw.wait("error");
    expect(ferr.code).toBe("forbidden");
    bobRaw.send({ type: "relay.activity.push", event: { ts: Date.now() + 1, userId: "bob", projectId: "ghost-proj", category: "task", type: "submitted", summary: "bob 在未登记项目的活动" } });
    await new Promise((r) => setTimeout(r, 200));
    // 恰好一条 error(伪造那条被拒);自己的 push 有回显=被接受。
    const errs = bobRaw.received.filter((m) => m.type === "error");
    expect(errs).toHaveLength(1);
    const echo = bobRaw.received.find((m) => m.type === "relay.activity") as Record<string, unknown> | undefined;
    expect(((echo?.events as Record<string, unknown>[]) ?? [])[0]?.summary).toBe("bob 在未登记项目的活动");

    // ⑥ 未知项目 fail-closed:ghost-proj 未登记在 projects.yaml → owner 拉不到,只有 bob 自己可见。
    const owner2 = new TestClient(relayUrl, "owner");
    await owner2.wait("relay.auth.ok");
    owner2.send({ type: "relay.activity.list" });
    const ownerList = await owner2.wait("relay.activity");
    const ownerSummaries = (ownerList.events as Record<string, unknown>[]).map((e) => e.summary);
    expect(ownerSummaries).not.toContain("bob 在未登记项目的活动");
    expect(ownerSummaries).not.toContain("bob 伪造 owner 活动");
    bobRaw.close();
    owner2.close();
    bobClient.stop();
  }, 30_000);

  it("client 拒绝分支锚定:revoked 永久停 / legacy 无 code 保守停(审计 R1-C6)", async () => {
    // ① 已吊销成员(alice 在 D1 的 D2 段被标记 revoked):真 client 收 reject(code=revoked)→
    //    stopped=true,退避重试终止(connecting 只出现首轮,后续观察窗内不再出现)。
    const aliceStates: string[] = [];
    const aliceMsgs: Record<string, unknown>[] = [];
    const aliceClient = new TeamRelayClient({
      url: relayUrl, identityDir: join(dir, "alice-identity"), backoffBaseMs: 100,
      onState: (s) => aliceStates.push(s),
      onMessage: (m) => aliceMsgs.push(m as unknown as Record<string, unknown>),
    });
    aliceClient.connect();
    await new Promise((r) => setTimeout(r, 700));
    const aliceRej = aliceMsgs.find((m) => m.type === "relay.auth.reject");
    expect(aliceRej?.code).toBe("revoked");
    expect(aliceStates.filter((s) => s === "connecting")).toHaveLength(1);
    // 再等数个退避周期:重试已终止,connecting 计数不再增长。
    await new Promise((r) => setTimeout(r, 600));
    expect(aliceStates.filter((s) => s === "connecting")).toHaveLength(1);
    aliceClient.stop();

    // ② legacy relay(reject 无 code 字段,模拟旧版中继)→ client 保守按永久停。
    const legacyStates: string[] = [];
    const legacyHttp = createServer();
    const legacyWss = new WebSocketServer({ server: legacyHttp });
    legacyWss.on("connection", (ws) => {
      ws.send(JSON.stringify({ v: 1, type: "relay.challenge", nonce: "legacy-nonce" }));
      ws.on("message", () => {
        ws.send(JSON.stringify({ v: 1, type: "relay.auth.reject", reason: "旧版中继:reject 无 code 字段" }));
      });
    });
    await new Promise<void>((r) => legacyHttp.listen(0, r));
    const legacyUrl = `ws://127.0.0.1:${(legacyHttp.address() as AddressInfo).port}`;
    const legacyClient = new TeamRelayClient({
      url: legacyUrl, identityDir: join(dir, "owner-identity"), backoffBaseMs: 100,
      onState: (s) => legacyStates.push(s),
    });
    legacyClient.connect();
    await new Promise((r) => setTimeout(r, 700));
    expect(legacyStates).toContain("rejected");
    expect(legacyStates.filter((s) => s === "connecting")).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 600));
    expect(legacyStates.filter((s) => s === "connecting")).toHaveLength(1);
    legacyClient.stop();
    legacyWss.close();
    await new Promise<void>((r) => legacyHttp.close(() => r()));
  }, 30_000);

  it("D5 relay 挂了:本地 Git 操作不受影响;client 静默降级不抛错", async () => {
    // 先在 relay 活着时创建 client(死 URL),验证不抛错+退避态。
    const client = new TeamRelayClient({ url: "ws://127.0.0.1:1", identityDir: join(dir, "owner-identity") });
    expect(() => client.connect()).not.toThrow();
    // 本地 Git 功能(不经 relay):reviewer 直接对 bare 仓提交。
    await commitToMain((wd) => {
      writeFileSync(join(wd, "notes.md"), "local work without relay");
    }, "local: direct git op");
    const head = await git(["ls-remote", bare, "main"], dir);
    expect(head).toBeTruthy();
    // 杀 relay 再验一次直连 Git(挂了也不影响)。
    await relay.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    await commitToMain((wd) => {
      writeFileSync(join(wd, "notes2.md"), "local work after relay down");
    }, "local: after relay down");
    const head2 = await git(["ls-remote", bare, "main"], dir);
    expect(head2).not.toBe(head);
    client.stop();
  }, 30_000);
});
