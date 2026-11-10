/**
 * 二期 GitProvider 面(GitLab/Codeup REST v4 + 成员种子导入)单测:
 * fetch 全注入(fake fetch 断言 URL/鉴权头/分页),git CLI 走真实本地 bare 仓,
 * token 泄漏面专项(redact + askpass 脚本无密 + 命令构造无 argv 内嵌)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GitLabProvider, mapRawMR } from "../src/git/gitlab.js";
import { CodeupProvider } from "../src/git/codeup.js";
import { askpassEnv, buildCloneArgs } from "../src/git/askpass.js";
import { importMembersFromProvider } from "../src/git/seed-members.js";
import { parseYamlLite, stringifyYamlLite } from "../src/team/yaml-lite.js";

const TOKEN = "glpat-SECRET-DO-NOT-LEAK-42";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (url: URL, init: RequestInit, call: number) => Response): { impl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url: url.toString(), init: init ?? {} });
    return handler(url, init ?? {}, calls.length - 1);
  }) as typeof fetch;
  return { impl, calls };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tokenHeader(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string>)["PRIVATE-TOKEN"];
}

/** 真实本地 git 场景:bare 远端 + 已带 feature 分支的克隆仓。 */
function makeRepoWithBranch(branch: string): { dir: string; repo: string; bare: string } {
  const dir = mkdtempSync(join(tmpdir(), "gh-provider-"));
  const bare = join(dir, "origin.git");
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "--bare", bare]);
  execFileSync("git", ["clone", bare, repo]);
  execFileSync("git", ["-c", "user.email=t@local", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repo });
  execFileSync("git", ["checkout", "-b", branch], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@local", "-c", "user.name=t", "commit", "--allow-empty", "-m", "work"], { cwd: repo });
  return { dir, repo, bare };
}

describe("GitLabProvider(REST v4)", () => {
  it("createMR:先推分支再 POST,projectPath URL-encoded,鉴权头带 token", async () => {
    const { impl, calls } = fakeFetch(() =>
      jsonRes({ iid: 7, title: "T", source_branch: "feature", target_branch: "main", state: "opened", web_url: "http://g/infra/app/-/merge_requests/7" }),
    );
    const provider = new GitLabProvider({ baseUrl: "http://192.168.8.60/", token: TOKEN, projectPath: "infra/app", fetchImpl: impl });
    const { dir, repo, bare } = makeRepoWithBranch("feature");
    try {
      const mr = await provider.createMR({ repoPath: repo, sourceBranch: "feature", targetBranch: "main", title: "T", body: "B" });
      // 分支真的推上了远端(push 在 POST 之前)
      const pushed = execFileSync("git", ["--git-dir", bare, "rev-parse", "--verify", "refs/heads/feature"]).toString().trim();
      expect(pushed).toMatch(/^[0-9a-f]{40}$/);
      // API 请求形态
      expect(calls.length).toBe(1);
      const u = new URL(calls[0]!.url);
      expect(u.origin + u.pathname).toBe("http://192.168.8.60/api/v4/projects/infra%2Fapp/merge_requests");
      expect(calls[0]!.init.method).toBe("POST");
      expect(tokenHeader(calls[0]!.init)).toBe(TOKEN);
      const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, string>;
      expect(body.source_branch).toBe("feature");
      expect(body.target_branch).toBe("main");
      // MR 映射:iid→id、opened→open、web_url→url
      expect(mr).toEqual({ id: "7", title: "T", sourceBranch: "feature", targetBranch: "main", state: "open", url: "http://g/infra/app/-/merge_requests/7" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("listMR:state 映射 opened,缺省 open", async () => {
    const { impl, calls } = fakeFetch(() => jsonRes([{ iid: 3, title: "x", source_branch: "a", target_branch: "b", state: "opened", web_url: "u" }]));
    const provider = new GitLabProvider({ baseUrl: "http://192.168.8.60", token: TOKEN, projectPath: "infra/app", fetchImpl: impl });
    const mrs = await provider.listMR({ repoPath: "/unused" });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/api/v4/projects/infra%2Fapp/merge_requests");
    expect(u.searchParams.get("state")).toBe("opened");
    expect(u.searchParams.get("per_page")).toBe("100");
    expect(mrs[0]).toMatchObject({ id: "3", state: "open" });
    // 显式 merged 原样传递
    await provider.listMR({ repoPath: "/unused", state: "merged" });
    expect(new URL(calls[1]!.url).searchParams.get("state")).toBe("merged");
  });

  it("listMembers:per_page=100 分页拉全", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ username: `u${i}`, name: `User ${i}`, access_level: 30 }));
    const page2 = [{ username: "tail", name: "Tail", access_level: 40 }];
    const { impl, calls } = fakeFetch((_url, _init, call) => jsonRes(call === 0 ? page1 : page2));
    const provider = new GitLabProvider({ baseUrl: "http://g", token: TOKEN, projectPath: "g/r", fetchImpl: impl });
    const members = await provider.listMembers();
    expect(members).toHaveLength(101);
    expect(members[100]).toEqual({ username: "tail", name: "Tail", accessLevel: 40 });
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.get("page")).toBe("1");
    expect(new URL(calls[1]!.url).searchParams.get("page")).toBe("2");
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v4/projects/g%2Fr/members");
  });

  it("listGroups/listGroupProjects:路径定位群组", async () => {
    const { impl, calls } = fakeFetch(() => jsonRes([{ path: "infra", full_path: "infra", name: "Infra" }]));
    const provider = new GitLabProvider({ baseUrl: "http://g", token: TOKEN, projectPath: "g/r", fetchImpl: impl });
    const groups = await provider.listGroups();
    expect(groups[0]).toEqual({ path: "infra", fullPath: "infra", name: "Infra" });
    await provider.listGroupProjects("infra/sub");
    expect(new URL(calls[1]!.url).pathname).toBe("/api/v4/groups/infra%2Fsub/projects");
  });

  it("token 不泄漏:网络异常与 HTTP 错误文案均清洗", async () => {
    const thrower = fakeFetch(() => {
      throw new Error(`connect ECONNREFUSED mirror ${TOKEN}`);
    });
    const p1 = new GitLabProvider({ baseUrl: "http://g", token: TOKEN, projectPath: "g/r", fetchImpl: thrower.impl });
    const err1 = await p1.listMR({ repoPath: "x" }).catch((e: Error) => e);
    expect(err1.message).not.toContain(TOKEN);
    expect(err1.message).toContain("[redacted]");

    const unauthorized = fakeFetch(() => new Response(`{"message":"401 unauthorized bad_token=${TOKEN}"}`, { status: 401 }));
    const p2 = new GitLabProvider({ baseUrl: "http://g", token: TOKEN, projectPath: "g/r", fetchImpl: unauthorized.impl });
    const err2 = await p2.listMR({ repoPath: "x" }).catch((e: Error) => e);
    expect(err2.message).not.toContain(TOKEN);
    expect(err2.message).toContain("HTTP 401");
  });

  it("clone:命令构造清凭据助手且 URL 剥离内嵌凭据;本地路径直落 git CLI", async () => {
    // 命令构造(单测锚点):-c credential.helper= 防全局 helper 收token;URL 内嵌凭据剥除
    const args = buildCloneArgs("https://oauth2:leaked@git.example.com/group/repo.git", "/tmp/dst");
    expect(args.slice(0, 2)).toEqual(["-c", "credential.helper="]);
    expect(args.join(" ")).not.toContain("leaked");
    expect(args[3]).toBe("https://git.example.com/group/repo.git");
    // 真实 clone(本地 bare,无凭据语境):走 askpass 环境也不炸
    const { impl } = fakeFetch(() => jsonRes({}));
    const provider = new GitLabProvider({ baseUrl: "http://g", token: TOKEN, projectPath: "g/r", fetchImpl: impl });
    const dir = mkdtempSync(join(tmpdir(), "gh-clone-"));
    try {
      const bare = join(dir, "origin.git");
      execFileSync("git", ["init", "--bare", bare]);
      const dest = join(dir, "dst");
      await provider.clone(bare, dest);
      expect(existsSync(join(dest, ".git"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("askpass 凭据环境(token 处理决策的锚点)", () => {
  it("token 只进环境变量;helper 脚本静态无密;命令不含 argv 内嵌", async () => {
    const env = await askpassEnv(TOKEN, "oauth2");
    expect(env.GIT_ASKPASS_PASS).toBe(TOKEN);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    // helper 是磁盘上的静态脚本,内容绝不含 token
    const body = readFileSync(env.GIT_ASKPASS, "utf-8");
    expect(body).not.toContain(TOKEN);
    expect(body).toContain("GIT_ASKPASS_PASS");
  });
});

describe("CodeupProvider(云效 REST v4 同源形态)", () => {
  it("默认 baseUrl=codeup.aliyun.com;organizationId 附加进每个请求 query", async () => {
    const { impl, calls } = fakeFetch(() => jsonRes([]));
    const provider = new CodeupProvider({ token: TOKEN, projectPath: "123456", organizationId: 876, fetchImpl: impl });
    expect(provider.kind).toBe("codeup");
    await provider.listMR({ repoPath: "x" });
    const u = new URL(calls[0]!.url);
    expect(u.host).toBe("codeup.aliyun.com");
    expect(u.pathname).toBe("/api/v4/projects/123456/merge_requests"); // 数字项目 ID 原样
    expect(u.searchParams.get("organizationId")).toBe("876");
    await provider.listMembers();
    expect(new URL(calls[1]!.url).searchParams.get("organizationId")).toBe("876");
  });

  it("未传 organizationId 不附加;路径形态 projectPath URL-encoded", async () => {
    const { impl, calls } = fakeFetch(() => jsonRes([]));
    const provider = new CodeupProvider({ token: TOKEN, projectPath: "CMG-Live/repo", fetchImpl: impl });
    await provider.listMR({ repoPath: "x" });
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get("organizationId")).toBeNull();
    expect(u.pathname).toBe("/api/v4/projects/CMG-Live%2Frepo/merge_requests");
  });
});

describe("成员种子导入( R7-2)", () => {
  it("生成种子条目:pending 指纹+pendingInvite;已有条目不 clobber;非法用户名拒绝", async () => {
    const roster = mkdtempSync(join(tmpdir(), "gh-seed-"));
    try {
      mkdirSync(join(roster, "members"), { recursive: true });
      // 预置正式成员 alice(平台同名——导入必须保留原条目)
      const aliceFile = join(roster, "members", "alice.yaml");
      const aliceOriginal = stringifyYamlLite({
        username: "alice", displayName: "Alice Local", fingerprint: "aaaa-bbbb-cccc", keys: ["aaaa-bbbb-cccc"],
        role: "reviewer", projects: [], registeredAt: "2026-01-01T00:00:00.000Z", revoked: false,
      });
      writeFileSync(aliceFile, aliceOriginal);

      const provider = {
        listMembers: async () => [
          { username: "alice", name: "Alice Remote", accessLevel: 40 }, // 已有→跳过
          { username: "bob", name: "Bob Builder", accessLevel: 30 },    // 新增→member
          { username: "carol", name: "Carol Owner", accessLevel: 50 },  // 新增→owner
          { username: "dave", accessLevel: 20 },                        // 新增→member(无 name 回退 username)
          { username: "../evil", name: "Traversal" },                   // 非法→拒绝
          { username: "  " },                                           // 空→拒绝
        ],
      };
      const r1 = await importMembersFromProvider(provider, roster);
      expect(r1.total).toBe(6);
      expect(r1.added.sort()).toEqual(["bob", "carol", "dave"]);
      expect(r1.skipped).toContain("alice");
      expect(r1.skipped).toContain("../evil");
      // alice 内容逐字节未动
      expect(readFileSync(aliceFile, "utf-8")).toBe(aliceOriginal);
      // bob 种子形态:pending 指纹 / pendingInvite=true / 角色映射
      const bob = parseYamlLite(readFileSync(join(roster, "members", "bob.yaml"), "utf-8"));
      expect(bob.username).toBe("bob");
      expect(bob.fingerprint).toBe("pending");
      expect(bob.pendingInvite).toBe(true);
      expect(bob.role).toBe("member");
      expect(bob.keys).toEqual([]);
      expect(bob.revoked).toBe(false);
      // 角色映射:50→owner;无 name→回退 username
      expect(parseYamlLite(readFileSync(join(roster, "members", "carol.yaml"), "utf-8")).role).toBe("owner");
      const dave = parseYamlLite(readFileSync(join(roster, "members", "dave.yaml"), "utf-8"));
      expect(dave.displayName).toBe("dave");
      expect(dave.role).toBe("member");
      // 路径穿越绝不落盘
      expect(existsSync(join(roster, "evil.yaml"))).toBe(false);
      expect(existsSync(join(roster, "members", "evil.yaml"))).toBe(false);
    } finally {
      rmSync(roster, { recursive: true, force: true });
    }
  });

  it("幂等:第二次运行零写入", async () => {
    const roster = mkdtempSync(join(tmpdir(), "gh-seed2-"));
    try {
      const provider = { listMembers: async () => [{ username: "bob", name: "Bob", accessLevel: 30 }] };
      const r1 = await importMembersFromProvider(provider, roster);
      expect(r1.added).toEqual(["bob"]);
      const before = readFileSync(join(roster, "members", "bob.yaml"), "utf-8");
      const r2 = await importMembersFromProvider(provider, roster);
      expect(r2.added).toEqual([]);
      expect(r2.skipped).toEqual(["bob"]);
      expect(readFileSync(join(roster, "members", "bob.yaml"), "utf-8")).toBe(before);
    } finally {
      rmSync(roster, { recursive: true, force: true });
    }
  });

  it("成员文件可被 relay 同一解析器读回(形态契约)", async () => {
    const roster = mkdtempSync(join(tmpdir(), "gh-seed3-"));
    try {
      const provider = { listMembers: async () => [{ username: "erin", name: "Erin", accessLevel: 40 }] };
      await importMembersFromProvider(provider, roster);
      const raw = parseYamlLite(readFileSync(join(roster, "members", "erin.yaml"), "utf-8"));
      // team-relay doPullRoster 的字段形态:role 可归一、revoked 布尔、keys 列表
      expect((raw.role as string) === "reviewer").toBe(true);
      expect(raw.revoked).toBe(false);
      expect(Array.isArray(raw.keys)).toBe(true);
      expect(raw.fingerprint).not.toBe("");
    } finally {
      rmSync(roster, { recursive: true, force: true });
    }
  });
});

describe("MR 映射纯函数", () => {
  it("state 三态映射与缺省", () => {
    expect(mapRawMR({ iid: 1, state: "opened" }).state).toBe("open");
    expect(mapRawMR({ iid: 1, state: "merged" }).state).toBe("merged");
    expect(mapRawMR({ iid: 1, state: "closed" }).state).toBe("closed");
    expect(mapRawMR({ iid: 1, state: "locked" }).state).toBe("closed");
    expect(mapRawMR({}).id).toBe("");
  });
});
