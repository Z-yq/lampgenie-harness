// 本地虚拟组织自举 e2e(团队移植第三段):
// seed 一次成型(4 成员/3 角色/3 规则/3 技能/demo git 项目)→ 二次 seed 硬幂等(零写入零提交)→
// cleanup 只删 demo 数据并提交推送 → 二次 cleanup 空 removed 不报错。
// 全部在 mkdtemp 临时根里跑,git 身份走 -c(不依赖也不写入全局 config)。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupVirtualTeam, seedVirtualTeam, virtualTeamStatus, type VirtualTeamReport } from "../src/team-demo.js";
import { parseYamlLite } from "@lampgenie/runtime/team/yaml-lite";

const execFileP = promisify(execFile);
/** 显式 git 身份:测试不依赖全局 git config。 */
const GIT_ID = ["-c", "user.name=test-harness", "-c", "user.email=test@demo.genie.local"];

async function gitOut(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", [...GIT_ID, ...args], { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "genie-vteam-"));
}

function cloneOf(root: string): string {
  return join(root, "relay", "team-clone");
}

const ROLE_ID: Record<string, string> = {
  "demo-kai": "owner",
  "demo-lin": "dev",
  "demo-rui": "dev",
  "demo-mei": "reviewer",
};

/** 团队仓 main 分支上的全部文件路径(bare 侧权威视图)。 */
async function bareTree(root: string): Promise<string[]> {
  const ls = await gitOut(["ls-tree", "-r", "--name-only", "main"], join(root, "team-repo.git"));
  return ls.split("\n").map((s) => s.trim()).filter(Boolean);
}

describe("seedVirtualTeam:本地虚拟组织 + demo git 项目", () => {
  let root: string;
  let report: VirtualTeamReport;

  beforeAll(async () => {
    root = newRoot();
    report = await seedVirtualTeam({ root });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("4 名成员 yaml:字段齐、roleId/指纹正确、projects 指向 demo-app", () => {
    expect(report.members.map((m) => m.username)).toEqual(["demo-kai", "demo-lin", "demo-rui", "demo-mei"]);
    expect(report.created.length).toBeGreaterThan(10);
    for (const m of report.members) {
      const file = join(cloneOf(root), "roster", "members", `${m.username}.yaml`);
      expect(existsSync(file)).toBe(true);
      const y = parseYamlLite(readFileSync(file, "utf-8"));
      expect(y.username).toBe(m.username);
      expect(y.roleId).toBe(ROLE_ID[m.username]);
      expect(m.roleId).toBe(ROLE_ID[m.username]);
      const want = createHash("sha256").update(`demo:${m.username}`).digest("hex").slice(0, 32);
      expect(y.fingerprint).toBe(want);
      expect(m.fingerprint).toBe(want);
      expect(String(y.fingerprint)).toHaveLength(32);
      expect(y.keys).toEqual([want]);
      expect(y.projects).toEqual(["demo-app"]);
      expect(y.revoked).toBe(false);
      expect(String(y.registeredAt).length).toBeGreaterThan(10);
    }
  });

  it("bare 团队仓 main 含全部资产:teamai/culture/roles/3 规则/3 技能/docs", async () => {
    const tree = await bareTree(root);
    for (const f of [
      "teamai.yaml",
      "culture.md",
      "roster/roles.yaml",
      "roster/projects.yaml",
      "roster/members/demo-kai.yaml",
      "roster/members/demo-lin.yaml",
      "roster/members/demo-rui.yaml",
      "roster/members/demo-mei.yaml",
      "rules/demo/demo-typescript.md",
      "rules/demo/demo-review-checklist.md",
      "rules/demo/demo-release.md",
      "skills/demo/demo-onboarding/SKILL.md",
      "skills/demo/demo-code-style/SKILL.md",
      "skills/demo/demo-review-loop/SKILL.md",
      "docs/demo-team-guide.md",
    ]) {
      expect(tree).toContain(f);
    }
    // 三角色块式定义 + 每角色 skills/rules 非空
    const roles = readFileSync(join(cloneOf(root), "roster", "roles.yaml"), "utf-8");
    for (const id of ["owner", "dev", "reviewer"]) expect(roles).toContain(`- id: ${id}`);
    expect(roles.match(/\n\s+skills: \[[^\]]+\]/g) ?? []).toHaveLength(3);
    expect(roles.match(/\n\s+rules: \[[^\]]+\]/g) ?? []).toHaveLength(3);
    // 技能 frontmatter 有 name/description
    const skill = readFileSync(join(cloneOf(root), "skills/demo/demo-onboarding/SKILL.md"), "utf-8");
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toContain("name: demo-onboarding");
    expect(skill).toMatch(/description: ".*"/);
    // 规则是真内容不是占位符
    const rule = readFileSync(join(cloneOf(root), "rules/demo/demo-typescript.md"), "utf-8");
    expect(rule.length).toBeGreaterThan(200);
    expect(rule).not.toContain("TODO");
  });

  it("projects.yaml 含 demo-app 绑定(type/repo/owner)", () => {
    const y = parseYamlLite(readFileSync(join(cloneOf(root), "roster", "projects.yaml"), "utf-8"));
    expect(y["demo-app.type"]).toBe("team");
    expect(y["demo-app.repo"]).toBe(join(root, "demo-projects", "demo-app.git"));
    expect(y["demo-app.owner"]).toBe("demo-kai");
  });

  it("demo 项目真仓:≥2 次真实提交、origin 指向 bare、bare 已收到 main", async () => {
    const work = join(root, "demo-projects", "demo-app");
    const bare = join(root, "demo-projects", "demo-app.git");
    const count = Number(await gitOut(["rev-list", "--count", "HEAD"], work));
    expect(count).toBeGreaterThanOrEqual(2);
    expect(report.project.commits).toBe(count);
    expect(report.project.id).toBe("demo-app");
    expect(report.project.repoUrl).toBe(bare);
    expect(await gitOut(["remote", "get-url", "origin"], work)).toBe(bare);
    expect(await gitOut(["status", "--porcelain"], work)).toBe("");
    expect(await gitOut(["rev-parse", "--verify", "refs/heads/main"], bare)).toHaveLength(40);
    // 真的两次提交(不是一次提交 + 空提交):两个不同 subject
    const subjects = (await gitOut(["log", "--format=%s"], work)).split("\n").filter(Boolean);
    expect(new Set(subjects).size).toBe(subjects.length);
  });

  it("virtualTeamStatus 只读:present/4 成员/project=demo-app", async () => {
    const st = await virtualTeamStatus({ root });
    expect(st.present).toBe(true);
    expect(st.members).toEqual(["demo-kai", "demo-lin", "demo-mei", "demo-rui"]);
    expect(st.project).toBe("demo-app");
  });

  it("二次 seed 硬幂等:created 为空、全走 skipped、两仓提交数都不增加", async () => {
    const teamLogBefore = await gitOut(["log", "--oneline"], cloneOf(root));
    const teamCommitsBefore = teamLogBefore.split("\n").filter(Boolean).length;
    const demoCommitsBefore = Number(await gitOut(["rev-list", "--count", "HEAD"], join(root, "demo-projects", "demo-app")));

    const again = await seedVirtualTeam({ root });

    expect(again.created).toEqual([]);
    expect(again.skipped.length).toBeGreaterThan(10);
    expect(again.skipped).toContain("team-repo.git");
    expect(again.skipped).toContain("relay/team-clone");
    expect(again.skipped).toContain("roster/members/demo-kai.yaml");
    expect(again.skipped).toContain("roster/roles.yaml");
    expect(again.skipped).toContain("skills/demo/demo-onboarding/SKILL.md");
    expect(again.skipped).toContain("team-repo:commit");
    expect(again.skipped).toContain("team-repo:push");

    expect(Number(await gitOut(["rev-list", "--count", "HEAD"], cloneOf(root)))).toBe(teamCommitsBefore);
    expect(await gitOut(["log", "--oneline"], cloneOf(root))).toBe(teamLogBefore);
    expect(Number(await gitOut(["rev-list", "--count", "HEAD"], join(root, "demo-projects", "demo-app")))).toBe(
      demoCommitsBefore);
    expect(await gitOut(["status", "--porcelain"], cloneOf(root))).toBe("");
    // 成员 yaml 逐字节未变(registeredAt 固定常量,不会因重跑漂移)
    expect(readFileSync(join(cloneOf(root), "roster", "members", "demo-lin.yaml"), "utf-8")).toContain(
      "registeredAt: 2026-10-29T00:00:00.000Z",
    );
  });
});

describe("cleanupVirtualTeam:只删 demo 数据 + 幂等", () => {
  let root: string;

  beforeAll(async () => {
    root = newRoot();
    await seedVirtualTeam({ root });
    // 非 demo 成员:清理后必须原样存在
    writeFileSync(
      join(cloneOf(root), "roster", "members", "alice.yaml"),
      "username: alice\ndisplayName: Alice\nfingerprint: 00ff00ff00ff00ff00ff00ff00ff00ff\nkeys:\n  - 00ff00ff00ff00ff00ff00ff00ff00ff\nrole: member\nroleId: dev\nprojects:\n  - other-app\nrevoked: false\n",
      "utf-8",
    );
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("删 demo 成员/技能/规则/docs/demo-projects,保留 alice,并提交推送团队仓", async () => {
    const res = await cleanupVirtualTeam({ root });
    expect(res.removed).toContain("roster/members/demo-kai.yaml");
    expect(res.removed).toContain("roster/members/demo-mei.yaml");
    expect(res.removed).toContain("skills/demo");
    expect(res.removed).toContain("rules/demo");
    expect(res.removed).toContain("docs/demo-team-guide.md");
    expect(res.removed).toContain("demo-projects");
    expect(res.removed).toContain("team-repo:commit");

    const membersDir = join(cloneOf(root), "roster", "members");
    expect(existsSync(join(membersDir, "alice.yaml"))).toBe(true);
    expect(existsSync(join(membersDir, "demo-lin.yaml"))).toBe(false);
    expect(existsSync(join(cloneOf(root), "skills", "demo"))).toBe(false);
    expect(existsSync(join(cloneOf(root), "rules", "demo"))).toBe(false);
    expect(existsSync(join(root, "demo-projects"))).toBe(false);

    // 已提交并推送:工作区干净、bare main 侧同样没有 demo 数据、alice 还在
    expect(await gitOut(["status", "--porcelain"], cloneOf(root))).toBe("");
    const tree = await bareTree(root);
    expect(tree).toContain("roster/members/alice.yaml");
    expect(tree.filter((f) => f.startsWith("roster/members/demo-"))).toEqual([]);
    expect(tree.filter((f) => f.startsWith("skills/demo"))).toEqual([]);
    expect(tree.filter((f) => f.startsWith("rules/demo"))).toEqual([]);
    expect(tree.filter((f) => f.startsWith("docs/demo"))).toEqual([]);
    expect(tree).toContain("roster/roles.yaml"); // 角色定义是通用资产,不属 demo

    // 指向 demo-projects 的项目绑定也清掉;非 demo 键保留
    const py = parseYamlLite(readFileSync(join(cloneOf(root), "roster", "projects.yaml"), "utf-8"));
    expect(py["demo-app.repo"]).toBeUndefined();
    expect(aliceProjects()).toEqual(["other-app"]);

    const st = await virtualTeamStatus({ root });
    expect(st.present).toBe(true);
    expect(st.members).toEqual(["alice"]);
    expect(st.project).toBeNull();
  });

  it("二次 cleanup:removed 为空且不抛错(无 demo 数据不再提交)", async () => {
    const commitsBefore = Number(await gitOut(["rev-list", "--count", "HEAD"], cloneOf(root)));
    const res = await cleanupVirtualTeam({ root });
    expect(res.removed).toEqual([]);
    expect(Number(await gitOut(["rev-list", "--count", "HEAD"], cloneOf(root)))).toBe(commitsBefore);
    expect(await gitOut(["status", "--porcelain"], cloneOf(root))).toBe("");
  });

  function aliceProjects(): unknown {
    return parseYamlLite(readFileSync(join(cloneOf(root), "roster", "members", "alice.yaml"), "utf-8")).projects;
  }
});

describe("virtualTeamStatus:未自举 = present:false", () => {
  it("空根目录只读不建目录", async () => {
    const root = newRoot();
    try {
      const st = await virtualTeamStatus({ root });
      expect(st).toEqual({ present: false, members: [], project: null });
      expect(existsSync(join(root, "relay"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
