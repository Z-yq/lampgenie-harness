/**
 * 团队 issue 原生通道形状与降级策略单测(fixD7):覆盖本轮 5 个缺口。
 *  1) GitHub 评论走 /comments(GitLab 才走 /notes)
 *  2) GitLab list 用 state=opened(GitHub 才用 state=open)
 *  3) GitLab create 用 labels 逗号串 + assignee_ids(用户名先解析成 id)
 *  4) 标签/指派人回读两平台形状(GitLab labels 是字符串数组、assignees 是数组)
 *  5) 降级策略:仅 401/403/404/网络错降级;5xx 与参数错原样上抛(防数据两边分叉)
 * 跑法(单文件):cd apps/gateway && npx vitest run test/team-native-rest.test.ts --maxWorkers=1
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueService, RepoIssues, isDegradableError, newGithubIssues } from "../src/issue-service.js";
import { detectGitHost } from "../src/git-host.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "team-native-"));
}

interface Call { url: string; method: string; body: string; }

/** 记录调用的假 REST 服务:按 url 片段返回预设响应。 */
function fakeApi(runner: (url: string, method: string) => { status: number; data: unknown }): { calls: Call[]; fetchImpl: never } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? "GET");
    calls.push({ url: String(url), method, body: String(init?.body ?? "") });
    const r = runner(String(url), method);
    return new Response(JSON.stringify(r.data), { status: r.status });
  }) as never;
  return { calls, fetchImpl };
}

describe("缺口1:评论端点按平台分支", () => {
  it("GitHub → /issues/{n}/comments", async () => {
    const { calls, fetchImpl } = fakeApi(() => ({ status: 201, data: { id: 1 } }));
    const ch = newGithubIssues(detectGitHost("https://github.com/acme/widgets.git"), "t", fetchImpl);
    expect(await ch.comment("p1", 7, "ann", "已复现")).toBe(true);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://api.github.com/repos/acme/widgets/issues/7/comments");
    expect(JSON.parse(post.body).body).toBe("[ann] 已复现");
  });

  it("GitLab → /issues/{iid}/notes", async () => {
    const { calls, fetchImpl } = fakeApi(() => ({ status: 201, data: { id: 1 } }));
    const ch = newGithubIssues(detectGitHost("https://gitlab.com/g/sub/tool.git"), "t", fetchImpl);
    expect(await ch.comment("p1", 7, "ann", "已复现")).toBe(true);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://gitlab.com/api/v4/projects/g%2Fsub%2Ftool/issues/7/notes");
  });
});

describe("缺口2:list 的 state 取值按平台", () => {
  it("GitHub → state=open;GitLab → state=opened", async () => {
    const gh = fakeApi(() => ({ status: 200, data: [] }));
    await newGithubIssues(detectGitHost("https://github.com/a/b.git"), "t", gh.fetchImpl).list("p1");
    expect(gh.calls[0]!.url).toContain("state=open&");
    expect(gh.calls[0]!.url).not.toContain("state=opened");

    const gl = fakeApi(() => ({ status: 200, data: [] }));
    await newGithubIssues(detectGitHost("https://gitlab.com/a/b.git"), "t", gl.fetchImpl).list("p1");
    expect(gl.calls[0]!.url).toContain("state=opened");
  });
});

describe("缺口3:GitLab create 参数形状", () => {
  it("labels 逗号串 + assignee_ids(先 /users 解析 id)", async () => {
    const { calls, fetchImpl } = fakeApi((url) => {
      if (url.includes("/users?username=")) return { status: 200, data: [{ id: 42, username: "ann" }] };
      return { status: 201, data: { iid: 9, title: "T", labels: ["status:todo"] } };
    });
    const ch = newGithubIssues(detectGitHost("https://gitlab.com/a/b.git"), "t", fetchImpl);
    const rec = await ch.create({ projectId: "p1", title: "T", assignee: "ann" });
    expect(rec.number).toBe(9);
    expect(rec.status).toBe("todo");
    expect(rec.assignee).toBeUndefined(); // 响应里没带 assignees(形状见下一用例)
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues"))!;
    const body = JSON.parse(post.body);
    expect(body.labels).toBe("status:todo");       // 字符串而非数组
    expect(body.assignee_ids).toEqual([42]);        // id 数组而非用户名
    expect(body.assignees).toBeUndefined();
  });

  it("GitLab 用户名解析不到 → 不指派(不发非法参数把 create 打成 400)", async () => {
    const { calls, fetchImpl } = fakeApi((url) => {
      if (url.includes("/users?username=")) return { status: 200, data: [] };
      return { status: 201, data: { iid: 10, title: "T" } };
    });
    const ch = newGithubIssues(detectGitHost("https://gitlab.com/a/b.git"), "t", fetchImpl);
    await ch.create({ projectId: "p1", title: "T", assignee: "ghost" });
    const body = JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/issues"))!.body);
    expect(body.assignee_ids).toBeUndefined();
    expect(body.labels).toBe("status:todo");
  });

  it("GitHub 保持 labels 数组 + assignees 字符串数组(不回退)", async () => {
    const { calls, fetchImpl } = fakeApi(() => ({ status: 201, data: { number: 3, title: "T" } }));
    const ch = newGithubIssues(detectGitHost("https://github.com/a/b.git"), "t", fetchImpl);
    await ch.create({ projectId: "p1", title: "T", assignee: "ann" });
    const body = JSON.parse(calls.find((c) => c.method === "POST")!.body);
    expect(body.labels).toEqual(["status:todo"]);
    expect(body.assignees).toEqual(["ann"]);
  });
});

describe("缺口4:回读形状两平台(状态与指派人)", () => {
  it("GitLab:labels 字符串数组 → 状态正确;assignees 数组 → 指派人取到", async () => {
    const { fetchImpl } = fakeApi(() => ({
      status: 200,
      data: [
        { iid: 1, title: "A", labels: ["status:doing"], assignees: [{ username: "ann" }] },
        { iid: 2, title: "B", labels: ["status:done"], assignees: [] },
        { iid: 3, title: "C", labels: [] },
      ],
    }));
    const list = await newGithubIssues(detectGitHost("https://gitlab.com/a/b.git"), "t", fetchImpl).list("p1");
    expect(list.map((x) => x.status)).toEqual(["doing", "done", "todo"]);
    expect(list[0]!.assignee).toBe("ann");
    expect(list[1]!.assignee).toBeUndefined();
  });

  it("GitHub:labels 对象数组 → 状态正确(旧行为不回退)", async () => {
    const { fetchImpl } = fakeApi(() => ({
      status: 200,
      data: [{ number: 1, title: "A", labels: [{ name: "status:done" }], assignee: { login: "bob" } }],
    }));
    const list = await newGithubIssues(detectGitHost("https://github.com/a/b.git"), "t", fetchImpl).list("p1");
    expect(list[0]!.status).toBe("done");
    expect(list[0]!.assignee).toBe("bob");
  });
});

describe("缺口5:降级策略只对不可用类错误生效", () => {
  it("isDegradableError:401/403/404 与网络错=可降级;5xx/400/422=不降级", () => {
    expect(isDegradableError(new Error("list 失败 HTTP 401"))).toBe(true);
    expect(isDegradableError(new Error("create 失败 HTTP 403"))).toBe(true);
    expect(isDegradableError(new Error("create 失败 HTTP 404"))).toBe(true);
    expect(isDegradableError(new TypeError("fetch failed"))).toBe(true);
    expect(isDegradableError(new Error("connect ECONNREFUSED 127.0.0.1:1"))).toBe(true);
    expect(isDegradableError(new Error("list 失败 HTTP 500"))).toBe(false);
    expect(isDegradableError(new Error("create 失败 HTTP 400"))).toBe(false);
    expect(isDegradableError(new Error("create 失败 HTTP 422"))).toBe(false);
    expect(isDegradableError(new Error("list 失败 HTTP 429"))).toBe(false);
  });

  it("原生通道 500 → 原样上抛(不降级、不写本地副本)", async () => {
    const root = tmpRoot();
    try {
      const svc = new IssueService({
        repoRoot: root, resolveRoot: () => root,
        remoteUrl: async () => "https://gitlab.com/a/b.git",
        env: { GENIE_GITLAB_TOKEN: "tok" },
        fetchImpl: (async () => new Response(JSON.stringify({ message: "boom" }), { status: 500 })) as never,
      });
      await expect(svc.create({ projectId: "p1", title: "T" })).rejects.toThrow(/500/);
      // 关键:没有降级成 repo 通道,也没在本地落任何 issue 文件。
      expect((await svc.describe("p1")).mode).toBe("gitlab");
      const dir = join(root, ".genie", "issues");
      expect(() => readdirSync(dir)).toThrow(); // 目录都没建
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("原生通道 401 → 降级 repo 并重放(旧行为保持)", async () => {
    const root = tmpRoot();
    try {
      const svc = new IssueService({
        repoRoot: root, resolveRoot: () => root,
        remoteUrl: async () => "https://gitlab.com/a/b.git",
        env: { GENIE_GITLAB_TOKEN: "tok" },
        fetchImpl: (async () => new Response(JSON.stringify({ message: "401" }), { status: 401 })) as never,
      });
      const rec = await svc.create({ projectId: "p1", title: "降级创建" });
      expect(rec.number).toBe(1);
      const d = await svc.describe("p1");
      expect(d.mode).toBe("repo");
      expect(String(d.degradedReason)).toContain("401");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("缺口6:issue 文件原子写", () => {
  it("update/comment 后无临时文件残留,内容完整可解析", async () => {
    const root = tmpRoot();
    try {
      const repo = new RepoIssues(root);
      const rec = await repo.create({ projectId: "p1", title: "原子写" });
      await repo.update("p1", rec.number, { status: "doing", taskId: "t-1" });
      await repo.comment("p1", rec.number, "ann", "一条评论");
      const dir = join(root, ".genie", "issues");
      const files = readdirSync(dir);
      // 只有正式文件,没有 .tmp-* 残留(崩溃/异常路径也不会留)。
      expect(files).toEqual([`ISSUE-${rec.number}.json`]);
      const disk = JSON.parse(readFileSync(join(dir, files[0]!), "utf-8"));
      expect(disk.status).toBe("doing");
      expect(disk.taskId).toBe("t-1");
      expect(disk.comments).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loadAll 跳过半截文件时,其余 issue 不受影响(原子写的动机)", async () => {
    const root = tmpRoot();
    try {
      const repo = new RepoIssues(root);
      const a = await repo.create({ projectId: "p1", title: "好的" });
      // 模拟历史崩溃遗留的半截文件(不是本次原子写能防的旧数据,但不能连带其它记录)。
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(root, ".genie", "issues", "ISSUE-99.json"), '{"number":99,"title":"半截');
      const list = await repo.list("p1");
      expect(list.map((x) => x.number)).toEqual([a.number]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("缺口7:自建实例的 apiBase 跟随 remote 的真实 scheme 与端口", () => {
  it("http + 端口(内网自建 GitLab 常见形态)→ apiBase 保留 http 与端口", () => {
    const r = detectGitHost("http://192.168.8.60:8080/my-org/plat/tool.git");
    expect(r.kind).toBe("gitlab-self");
    expect(r.apiBase).toBe("http://192.168.8.60:8080/api/v4");
    expect(r.host).toBe("192.168.8.60");
    expect(r.fullPath).toBe("my-org/plat/tool");
  });

  it("https 无端口 → 不加端口(既有行为不回退)", () => {
    const r = detectGitHost("https://scm.acme.dev/team/x.git");
    expect(r.apiBase).toBe("https://scm.acme.dev/api/v4");
  });

  it("私有域名 + override=github(企业版)→ /api/v3 且跟随 scheme/端口", () => {
    const r = detectGitHost("http://ghe.corp:9000/org/repo.git", { gitHost: "github" });
    expect(r.kind).toBe("github");
    expect(r.apiBase).toBe("http://ghe.corp:9000/api/v3");
  });

  it("scp 形(无 scheme)→ API 按 https 兜底", () => {
    const r = detectGitHost("git@git.internal.acme.com:plat/pipeline.git");
    expect(r.apiBase).toBe("https://git.internal.acme.com/api/v4");
  });

  it("gitlab.com 仍走官方 API 域(不被 scheme 逻辑污染)", () => {
    const r = detectGitHost("https://gitlab.com/a/b.git");
    expect(r.apiBase).toBe("https://gitlab.com/api/v4");
    expect(r.kind).toBe("gitlab");
  });

  it("API 基址可被真实 REST 调用复用(http 自建 → 请求发到 http+端口)", async () => {
    const { calls, fetchImpl } = fakeApi((url) => {
      if (url.includes("/users?username=")) return { status: 200, data: [{ id: 7 }] };
      return { status: 201, data: { iid: 1, title: "T", labels: ["status:todo"] } };
    });
    const ch = newGithubIssues(detectGitHost("http://127.0.0.1:9999/grp/tool.git"), "t", fetchImpl);
    await ch.create({ projectId: "p1", title: "T", assignee: "ann" });
    expect(calls.every((c) => c.url.startsWith("http://127.0.0.1:9999/api/v4/"))).toBe(true);
    expect(calls[0]!.url).toBe("http://127.0.0.1:9999/api/v4/users?username=ann");
    expect(calls.some((c) => c.url === "http://127.0.0.1:9999/api/v4/projects/grp%2Ftool/issues")).toBe(true);
  });
});