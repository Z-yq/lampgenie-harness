/**
 * fixD1/D2/D3 单测:git 托管甄别表 / RepoIssues CRUD / 通道降级判定 / P2P 签名验证。
 * 跑法(单文件,资源纪律):cd apps/gateway && npx vitest run test/issue-p2p.test.ts --maxWorkers=1
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectGitHost } from "../src/git-host.js";
import { RepoIssues, IssueService, resolveIssueToken } from "../src/issue-service.js";
import { TeamP2P } from "../src/team-p2p.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "issue-d-"));
}

// ---- D1 甄别表(URL 样本×5 + 边界) ----
describe("fixD1 detectGitHost", () => {
  it("github https 形", () => {
    expect(detectGitHost("https://github.com/acme/widgets.git")).toEqual({
      kind: "github", apiBase: "https://api.github.com", repo: "acme/widgets", fullPath: "acme/widgets", host: "github.com",
    });
  });
  it("github scp 形(带 .git 后缀剥除)", () => {
    const r = detectGitHost("git@github.com:acme/widgets.git");
    expect(r.kind).toBe("github");
    expect(r.repo).toBe("acme/widgets");
  });
  it("gitlab.com → gitlab", () => {
    const r = detectGitHost("https://gitlab.com/group/sub/team-tool.git");
    expect(r.kind).toBe("gitlab");
    expect(r.apiBase).toBe("https://gitlab.com/api/v4");
    expect(r.repo).toBe("sub/team-tool");
  });
  it("私有域名 → gitlab-self(apiBase 指私有域)", () => {
    const r = detectGitHost("git@git.internal.acme.com:plat/pipeline.git");
    expect(r.kind).toBe("gitlab-self");
    expect(r.apiBase).toBe("https://git.internal.acme.com/api/v4");
    expect(r.repo).toBe("plat/pipeline");
  });
  it("私有域名 + override.gitHost=gitlab → gitlab", () => {
    const r = detectGitHost("https://scm.acme.dev/team/x.git", { gitHost: "gitlab" });
    expect(r.kind).toBe("gitlab");
    expect(r.apiBase).toBe("https://scm.acme.dev/api/v4");
  });
  it("子域含 gitlab → gitlab(apiBase 跟随实际域名)", () => {
    const r = detectGitHost("https://gitlab.acme.io/a/b.git");
    expect(r.kind).toBe("gitlab");
    expect(r.apiBase).toBe("https://gitlab.acme.io/api/v4");
  });
  it("本地路径/null → none", () => {
    expect(detectGitHost(null).kind).toBe("none");
    expect(detectGitHost("/srv/git/repo.git").kind).toBe("none");
    expect(detectGitHost("").kind).toBe("none");
  });
});

// ---- D2 RepoIssues CRUD ----
describe("fixD2 RepoIssues CRUD(服务零 git 写)", () => {
  it("create→list→update→comment 全链(文件落 .genie/issues/ISSUE-<n>.json)", async () => {
    const root = tmpRoot();
    try {
      const repo = new RepoIssues(root);
      const a = await repo.create({ projectId: "p1", title: "修登录闪退", body: "iOS 18 复现", assignee: "ann" });
      expect(a.number).toBe(1);
      expect(a.status).toBe("todo");
      const b = await repo.create({ projectId: "p1", title: "补文档" });
      expect(b.number).toBe(2); // 编号递增
      expect(existsSync(join(root, ".genie", "issues", "ISSUE-2.json"))).toBe(true);
      const list = await repo.list("p1");
      expect(list.map((x) => x.number)).toEqual([1, 2]);
      const up = await repo.update("p1", 1, { status: "doing", taskId: "t-9" });
      expect(up?.status).toBe("doing");
      expect(up?.taskId).toBe("t-9");
      expect(await repo.comment("p1", 1, "genie", "已复现")).toBe(true);
      const after = (await repo.list("p1")).find((x) => x.number === 1);
      expect(after?.comments).toHaveLength(1);
      expect(after?.comments[0]?.body).toBe("已复现");
      expect(await repo.update("p1", 404, { status: "done" })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---- D2 token 解析链 ----
describe("fixD2 resolveIssueToken(env > secrets.json)", () => {
  it("env 优先;secrets.json 兜底;都没有=undefined", () => {
    const root = tmpRoot();
    try {
      mkdirSync(join(root, ".genie"), { recursive: true });
      writeFileSync(join(root, ".genie", "secrets.json"), JSON.stringify({ gitlabToken: "glpat-x" }), { mode: 0o600 });
      expect(resolveIssueToken("gitlab", root, {})).toBe("glpat-x");
      expect(resolveIssueToken("gitlab", root, { GENIE_GITLAB_TOKEN: "env-y" })).toBe("env-y");
      expect(resolveIssueToken("github", root, {})).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---- D2 通道选择与降级 ----
describe("fixD2 IssueService 通道降级判定", () => {
  it("gitlab remote + token 在 → 原生通道;假 token 401 → 自动降级 RepoIssues 重放", async () => {
    const root = tmpRoot();
    try {
      const svc = new IssueService({
        repoRoot: root,
        resolveRoot: () => root,
        remoteUrl: async () => "https://gitlab.com/acme/widgets.git",
        env: { GENIE_GITLAB_TOKEN: "fake-token" },
        // 假 token:全部 401(真实形态:未授权 token 调 API 必拒)。
        fetchImpl: (async () => new Response(JSON.stringify({ message: "401 Unauthorized" }), { status: 401 })) as never,
      });
      const d0 = await svc.describe("p1");
      expect(d0.mode).toBe("gitlab"); // 判定=原生(降级发生在首次调用失败)
      const rec = await svc.create({ projectId: "p1", title: "降级路径创建" });
      expect(rec.number).toBe(1); // 降级后重放成功(RepoIssues 落盘)
      const d1 = await svc.describe("p1");
      expect(d1.mode).toBe("repo");
      expect(String(d1.degradedReason)).toContain("401");
      // 会话内钉死 repo:后续调用不再打原生(第二次 create 直接 RepoIssues)。
      const rec2 = await svc.create({ projectId: "p1", title: "钉死通道" });
      expect(rec2.number).toBe(2);
      expect(existsSync(join(root, ".genie", "issues", "ISSUE-2.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("none(本地目录)→ 直选 RepoIssues;taskLink 终态路由登记", async () => {
    const root = tmpRoot();
    try {
      const svc = new IssueService({ repoRoot: root, resolveRoot: () => root, remoteUrl: async () => null });
      expect((await svc.describe("px")).mode).toBe("repo");
      const rec = await svc.create({ projectId: "px", title: "T" });
      svc.linkTask("task-1", "px", rec.number);
      expect(svc.findIssueByTask("task-1")).toEqual({ projectId: "px", number: rec.number });
      expect(svc.findIssueByTask("task-404")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---- D3 P2P 签名验证(密钥对造数) ----
describe("fixD3 TeamP2P 签名验证与目录", () => {
  it("密钥对落 secrets(按用户名分键)+ 目录登记(仓内只含指纹不含私钥)", () => {
    const root = tmpRoot();
    try {
      const p = new TeamP2P({ repoRoot: root, port: 7858, username: "alice" });
      const secrets = JSON.parse(readFileSync(join(root, ".genie", "secrets.json"), "utf-8")) as Record<string, string>;
      expect(secrets["p2pKey.alice"]).toBeTruthy();
      const members = JSON.parse(readFileSync(join(root, ".genie", "team", "members.json"), "utf-8")) as { username: string; pubkeyFingerprint: string }[];
      const me = members.find((m) => m.username === "alice");
      expect(me?.pubkeyFingerprint).toHaveLength(40);
      expect(JSON.stringify(members)).not.toContain("PRIVATE KEY");
      void p;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("正签通过;篡改 body/未知成员/换公钥拒绝", () => {
    const root = tmpRoot();
    try {
      const alice = new TeamP2P({ repoRoot: root, port: 7858, username: "alice", now: () => 1_700_000_000_000 });
      // bob 手工入册(用他自己的实例生成指纹;目录=git 共享文件语义)。
      const bob = new TeamP2P({ repoRoot: root, port: 7859, username: "bob", now: () => 1_700_000_000_000 });
      const body = JSON.stringify({ to: "alice", text: "ping" });
      const h = bob.signHeaders(body);
      const norm = (o: Record<string, string>): Record<string, string | undefined> => o;
      expect(alice.verifyRequest(norm(h), body).ok).toBe(true);
      // 篡改 body → 摘要不符 → 拒。
      expect(alice.verifyRequest(norm(h), body + "x").ok).toBe(false);
      // 未知成员(不在目录)→ 拒。
      expect(alice.verifyRequest(norm({ ...h, "x-genie-user": "eve" }), body).ok).toBe(false);
      // 换公钥(自称 bob 但用 mallory 私钥签名 → 指纹与目录不符)→ 拒。
      const mallory = new TeamP2P({ repoRoot: root, port: 9999, username: "mallory", now: () => 1_700_000_000_000 });
      const mh = { ...mallory.signHeaders(body), "x-genie-user": "bob" };
      expect(alice.verifyRequest(norm(mh), body).reason).toContain("指纹");
      // 时间戳超窗(±300s)→ 拒。
      const stale = new TeamP2P({ repoRoot: root, port: 7859, username: "bob", now: () => 1_700_000_000_000 - 400_000 });
      expect(alice.verifyRequest(norm(stale.signHeaders(body)), body).reason).toContain("时间戳");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("消息发送:P2P 不可达+无 relay → 离线队列(via=queued)", async () => {
    const root = tmpRoot();
    try {
      const a = new TeamP2P({ repoRoot: root, port: 7858, username: "alice" });
      new TeamP2P({ repoRoot: root, port: 7859, username: "bob" }); // 入册 bob(端口不通)
      const r = await a.send("bob", "hello");
      expect(r.via).toBe("queued");
      expect(a.status().offlineQueue).toBe(1);
      const r404 = await a.send("nobody", "x");
      expect(r404.via).toBe("queued"); // 不在目录=队列(不做登记)
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
