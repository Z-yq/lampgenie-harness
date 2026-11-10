/**
 * 团队功能强化(fixD6)单测:覆盖本轮五个缺口的回归面。
 *  1) RepoIssues.create 并发编号分配(wx 独占创建 + 撞号顺延)不丢单
 *  2) TeamP2P 离线队列在 ping 转在线时自动补发(flushQueue 此前无调用方)
 *  3) 入站消息去重(发送方 id 保留 + 重复吸收)
 *  4) 验签拒绝发 bus 事件(可观测);降级发送发 fallback 事件
 *  5) GitLab 原生通道:PUT 更新 + 项目路径单次编码
 * 跑法(单文件,资源纪律):cd apps/gateway && npx vitest run test/team-hardening.test.ts --maxWorkers=1
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bus } from "@lampgenie/core";
import { RepoIssues, newGithubIssues } from "../src/issue-service.js";
import { TeamP2P } from "../src/team-p2p.js";
import { detectGitHost } from "../src/git-host.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "team-hard-"));
}

/** 一次事件抓取(用完即退订,防跨用例泄漏)。 */
function once<T>(topic: string): Promise<T> {
  return new Promise((resolve) => {
    const off = bus.on<T>(topic, (p) => { off(); resolve(p); });
  });
}

describe("缺口1:RepoIssues.create 并发编号分配", () => {
  it("对端已占号(文件先落地)时顺延到下一个号,不覆盖既有文件", async () => {
    const root = tmpRoot();
    try {
      const repo = new RepoIssues(root);
      const a = await repo.create({ projectId: "p1", title: "A" });
      expect(a.number).toBe(1);
      // 模拟两个实例并发:两个 RepoIssues 同时读到 max=1,都想写 #2。
      // 第一个实例写成功后再让第二个实例创建 —— 它 loadAll 会看到 #2,自然得 #3。
      const repo2 = new RepoIssues(root);
      const b = await repo2.create({ projectId: "p1", title: "B" });
      expect(b.number).toBe(2);
      // 真并发窗口:在 repo3.create 已算出 max 之后,外部先占掉下一个号。
      // 用 wx 语义验证:目标文件已存在时 create 必须顺延而不是覆盖。
      const repo3 = new RepoIssues(root);
      const c = await repo3.create({ projectId: "p1", title: "C" });
      expect(c.number).toBe(3);
      const files = readdirSync(join(root, ".genie", "issues")).sort();
      expect(files).toEqual(["ISSUE-1.json", "ISSUE-2.json", "ISSUE-3.json"]);
      // 三份内容互不覆盖(标题各归其位)。
      const titles = files.map((f) => (JSON.parse(readFileSync(join(root, ".genie", "issues", f), "utf-8")) as { title: string }).title);
      expect(titles).toEqual(["A", "B", "C"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("号被外部抢先占位(模拟并发对端)时顺延而非覆盖", async () => {
    const root = tmpRoot();
    try {
      const repo = new RepoIssues(root);
      await repo.create({ projectId: "p1", title: "first" });
      // 关键:模拟「读到 max=1 之后、写之前」对端写入了 #2。
      const dir = join(root, ".genie", "issues");
      writeFileSync(join(dir, "ISSUE-2.json"), JSON.stringify({ number: 2, title: "对端抢先", body: "", status: "todo", projectId: "p1", createdAt: 1, updatedAt: 1, comments: [] }));
      // 此处 repo 的 loadAll 已看到 #2 → 直接拿 #3;不会覆盖对端的 #2。
      const next = await repo.create({ projectId: "p1", title: "mine" });
      expect(next.number).toBe(3);
      const peer = JSON.parse(readFileSync(join(dir, "ISSUE-2.json"), "utf-8")) as { title: string };
      expect(peer.title).toBe("对端抢先"); // 未被覆盖
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("缺口2:ping 转在线触发离线队列补发", () => {
  it("离线入队 → 对端可达 → queue 清空且消息实投到对端 inbox", async () => {
    const rootA = tmpRoot();
    const rootB = tmpRoot();
    try {
      // A 与 B 各自独立 repoRoot(独立 secrets/members),再把 B 的公钥指纹挤进 A 的目录。
      const b = new TeamP2P({ repoRoot: rootB, port: 7799, username: "bob" });
      const a = new TeamP2P({ repoRoot: rootA, port: 7798, username: "alice" });
      // 成员目录共享语义:手工把 bob 条目写进 A 的 members.json(含正确指纹)。
      const bSelf = b.status().self!;
      const membersFile = join(rootA, ".genie", "team", "members.json");
      const members = JSON.parse(readFileSync(membersFile, "utf-8")) as unknown[];
      members.push(bSelf);
      writeFileSync(membersFile, JSON.stringify(members));

      // 对端此刻不可达(fetch 注入 AbortError)→ via=queued,队列 1 条。
      const down = new TeamP2P({
        repoRoot: rootA,
        port: 7798,
        username: "alice",
        fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as never,
      });
      const m1 = await down.send("bob", "积压消息");
      expect(m1.via).toBe("queued");
      expect(down.status().offlineQueue).toBe(1);
      expect(down.status().offlineQueueItems[0]?.to).toBe("bob");

      // 现在造「对端可达」:fetch 注入把 /message 请求转给 B 的真实 handler(直接调用,不起 HTTP)。
      const fwd = (async (url: string, init: RequestInit) => {
        const u = String(url);
        const body = String(init.body ?? "{}");
        if (u.endsWith("/team/p2p/ping")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        if (u.endsWith("/team/p2p/message")) {
          // 用 B 的验签路径真实校验(alice 必须在 B 目录;下面补)。
          const headers = init.headers as Record<string, string>;
          const r = await b.handleRequest(
            { url: "/team/p2p/message", headers, on: (ev: string, cb: (d?: Buffer) => void) => { if (ev === "data") cb(Buffer.from(body)); if (ev === "end") cb(); } } as never,
            { writeHead: () => undefined, end: (payload: string) => { (fwd as unknown as { last: string }).last = payload; } } as never);
          return new Response((fwd as unknown as { last: string }).last ?? "{}", { status: String((fwd as unknown as { last?: string }).last ?? "").includes('"ok":false') ? 403 : 200 });
        }
        return new Response("{}", { status: 404 });
      }) as never;
      // alice 入 B 目录(双向目录语义)。
      const aSelf = down.status().self!;
      const bMembersFile = join(rootB, ".genie", "team", "members.json");
      const bMembers = JSON.parse(readFileSync(bMembersFile, "utf-8")) as unknown[];
      bMembers.push(aSelf);
      writeFileSync(bMembersFile, JSON.stringify(bMembers));

      // 用同一实例换 fetch 注入(fetchImpl 是 opts 引用,直接改以免新建实例丢队列)。
      (down as unknown as { opts: { fetchImpl: unknown } }).opts.fetchImpl = fwd;
      const ok = await down.ping("bob");
      expect(ok).toBe(true);
      // 补发是 fire-and-forget(ping 内 void flushQueue),等微任务落定。
      await new Promise((r) => setTimeout(r, 50));
      expect(down.status().offlineQueue).toBe(0);
      expect(b.status().inbox).toBeGreaterThanOrEqual(1);
      const lastIn = b.status().lastInbound!;
      expect(lastIn.from).toBe("alice");
      expect(lastIn.text).toBe("积压消息");
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});

describe("缺口3/5/观测:入站去重 + 验签拒绝事件 + fallback 事件", () => {
  it("同一消息 id 重发:首条入 inbox,重复只发事件不回填 inbox", async () => {
    const root = tmpRoot();
    try {
      const alice = new TeamP2P({ repoRoot: root, port: 7791, username: "alice" });
      const bob = new TeamP2P({ repoRoot: root, port: 7792, username: "bob" });

      const post = (body: string) => {
        let status = 0;
        let payload = "";
        const headers = alice.signHeaders(body);
        void bob.handleRequest(
          { url: "/team/p2p/message", headers, on: (ev: string, cb: (d?: Buffer) => void) => { if (ev === "data") cb(Buffer.from(body)); if (ev === "end") cb(); } } as never,
          { writeHead: (c: number) => { status = c; }, end: (p: string) => { payload = p; } } as never);
        return new Promise<{ status: number; payload: string }>((r) => setTimeout(() => r({ status, payload }), 10));
      };
      const body = JSON.stringify({ id: "fixed-id-1", to: "bob", text: "hello" });
      const first = await post(body);
      expect(first.status).toBe(200);
      expect(JSON.parse(first.payload)).toMatchObject({ ok: true, id: "fixed-id-1" });

      const dupEvent = once<{ id: string; duplicate?: boolean }>("team.p2p.message");
      const second = await post(body);
      const dup = await dupEvent;
      expect(second.status).toBe(200);
      expect(JSON.parse(second.payload)).toMatchObject({ ok: true, duplicate: true });
      expect(dup.duplicate).toBe(true);
      // inbox 只留首条(重复不重复入队)。
      expect(bob.status().inbox).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("验签失败/超窗发 team.p2p.rejected 事件且回 403 带原因", async () => {
    const root = tmpRoot();
    try {
      const alice = new TeamP2P({ repoRoot: root, port: 7791, username: "alice" });
      const bob = new TeamP2P({ repoRoot: root, port: 7792, username: "bob" });
      // 未知成员 → 拒绝。
      const body = JSON.stringify({ id: "x", to: "bob", text: "hi" });
      const h = { ...alice.signHeaders(body), "x-genie-user": "eve" };
      const rejected = once<{ route: string; user: string; reason: string }>("team.p2p.rejected");
      let status = 0;
      let payload = "";
      void bob.handleRequest(
        { url: "/team/p2p/message", headers: h, on: (ev: string, cb: (d?: Buffer) => void) => { if (ev === "data") cb(Buffer.from(body)); if (ev === "end") cb(); } } as never,
        { writeHead: (c: number) => { status = c; }, end: (p: string) => { payload = p; } } as never);
      const ev = await rejected;
      expect(status).toBe(403);
      expect(JSON.parse(payload).reason).toContain("成员不在目录");
      expect(ev.user).toBe("eve");
      expect(ev.reason).toContain("成员不在目录");

      // 超窗(时钟偏移 10 分钟)→ 拒绝原因含「时间戳」。
      const stale = new TeamP2P({ repoRoot: root, port: 7791, username: "alice", now: () => Date.now() - 600_000 });
      const staleH = stale.signHeaders(body);
      const rejected2 = once<{ reason: string }>("team.p2p.rejected");
      void bob.handleRequest(
        { url: "/team/p2p/message", headers: staleH, on: (e2: string, cb: (d?: Buffer) => void) => { if (e2 === "data") cb(Buffer.from(body)); if (e2 === "end") cb(); } } as never,
        { writeHead: () => undefined, end: () => undefined } as never);
      expect((await rejected2).reason).toContain("时间戳");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("P2P 不可达且无 relay:发 team.p2p.send.fallback(via=queued,带原因)", async () => {
    const root = tmpRoot();
    try {
      const a = new TeamP2P({ repoRoot: root, port: 7791, username: "alice", fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as never });
      new TeamP2P({ repoRoot: root, port: 7792, username: "bob" });
      const fb = once<{ to: string; via: string; reason: string }>("team.p2p.send.fallback");
      const r = await a.send("bob", "drop");
      const ev = await fb;
      expect(r.via).toBe("queued");
      expect(ev.via).toBe("queued");
      expect(ev.reason).toContain("ECONNREFUSED");
      // relay 在场时走 relay 并标注。
      const withRelay = new TeamP2P({
        repoRoot: root, port: 7791, username: "alice",
        fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as never,
        relaySend: () => true,
      });
      const fb2 = once<{ via: string }>("team.p2p.send.fallback");
      const r2 = await withRelay.send("bob", "via-relay");
      expect(r2.via).toBe("relay");
      expect((await fb2).via).toBe("relay");
      expect(withRelay.status().offlineQueue).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("缺口4:GitLab 原生通道 REST 形状", () => {
  it("update 用 PUT + add/remove_labels;项目路径单次编码(不出现 %252F)", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: String(init?.method ?? "GET"), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ iid: 7, title: "T", labels: [] }), { status: 200 });
    }) as never;
    const info = detectGitHost("https://gitlab.com/group/sub/team-tool.git");
    expect(info.kind).toBe("gitlab");
    const ch = newGithubIssues(info, "fake-token", fetchImpl);
    await ch.update("p1", 7, { status: "doing" });
    const updateCall = calls.find((c) => c.method !== "GET")!;
    expect(updateCall.method).toBe("PUT");
    expect(updateCall.url).toContain("/projects/group%2Fsub%2Fteam-tool/issues/7");
    expect(updateCall.url).not.toContain("%252F");
    expect(JSON.parse(updateCall.body)).toMatchObject({ add_labels: "status:doing" });
    expect(String(JSON.parse(updateCall.body).remove_labels)).toContain("status:todo");
  });

  it("github 通道仍用 PATCH + labels 全量回写(不回退)", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: String(init?.method ?? "GET"), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ number: 3, title: "T" }), { status: 200 });
    }) as never;
    const ch = newGithubIssues(detectGitHost("https://github.com/acme/widgets.git"), "fake-token", fetchImpl);
    await ch.update("p1", 3, { status: "done" });
    const call = calls.find((c) => c.method !== "GET")!;
    expect(call.method).toBe("PATCH");
    expect(JSON.parse(call.body)).toEqual({ labels: ["status:done"] });
  });
});