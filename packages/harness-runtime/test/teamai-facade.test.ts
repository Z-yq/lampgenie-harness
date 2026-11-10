/**
 * teamai 门面五件套:digest 新字段(roles/counts)+ teamaiList / teamaiStatus / teamaiDoctor( §2.6/§2.7)。
 * 用临时目录造一个"团队仓"树,断言只增不改的向后兼容面。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTeamaiAssets, teamaiList, teamaiStatus, teamaiDoctor } from "../src/team/teamai-bridge.js";

let root = "";

const w = (rel: string, body: string) => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body, "utf-8");
};

const ROLES_YAML = `roles:
  - id: owner
    name: 负责人
    description: 定方向
    skills: [demo/x]
    rules: [demo/y]
  - id: dev
    name: 开发
    description: 实现与自测
    skills: [x]
    rules: [demo/y]
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "teamai-facade-"));
  w("teamai.yaml", "team: 虚拟组织\ndescription: 演示团队\nrepo: https://example.com/t.git\nreviewers:\n  - demo-kai\n");
  w("culture.md", "# 文化\n先小步提交。\n");
  w("roster/members/demo-kai.yaml", "username: demo-kai\ndisplayName: 凯\nfingerprint: f-kai\nrole: owner\nroleId: owner\nregisteredAt: 2026-01-01\n");
  w("roster/members/demo-lin.yaml", "username: demo-lin\ndisplayName: 林\nfingerprint: f-lin\nrole: member\nroleId: dev\nregisteredAt: 2026-01-01\n");
  w("roster/roles.yaml", ROLES_YAML);
  w("roster/projects.yaml", "projects:\n  demo-app:\n    type: team\n");
  w("skills/demo/x/SKILL.md", "---\nname: x\ndescription: 演示技能\n---\n技能正文\n");
  w("rules/demo/y.md", "规则正文\n");
  w("rules/flat.md", "扁平规则正文\n");
  w("docs/z.md", "文档正文\n");
  w("learnings/1700000000-demo.md", "---\ntitle: t\nauthor: demo-kai\ndate: 2026-01-01\n---\n经验正文\n");
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("readTeamaiAssets 新字段(只增不改)", () => {
  it("roles 与 counts 填充;既有字段语义不变", () => {
    const d = readTeamaiAssets(root, 1_700_000_000_000);
    expect(d.meta.team).toBe("虚拟组织");
    expect(d.roles.map((r) => r.id)).toEqual(["owner", "dev"]);
    expect(d.counts).toEqual({ members: 2, skills: 1, rules: 2, docs: 1, learnings: 1 });
    expect(d.pulledAt).toBe(1_700_000_000_000);
    expect(d.skills[0]).toMatchObject({ ns: "demo", name: "x" });
 // rules 两层都收——命名空间 rules/demo/y.md(relay push kind=rule 落点)与扁平 rules/flat.md
    expect(d.rules.map((r) => r.name)).toEqual(["demo/y", "flat"]);
  });

  it("空目录不抛错:roles=[] / counts 全 0", () => {
    const empty = mkdtempSync(join(tmpdir(), "teamai-empty-"));
    try {
      const d = readTeamaiAssets(empty);
      expect(d.roles).toEqual([]);
      expect(d.counts).toEqual({ members: 0, skills: 0, rules: 0, docs: 0, learnings: 0 });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("teamaiList(资源枚举面)", () => {
  it("skill/rule/doc/learning 扁平清单", () => {
    const d = readTeamaiAssets(root);
    const list = teamaiList(d);
    expect(list).toEqual([
      { kind: "skill", name: "x", ns: "demo" },
      { kind: "rule", name: "demo/y" },
      { kind: "rule", name: "flat" },
      { kind: "doc", name: "z.md" },
      { kind: "learning", name: "1700000000-demo.md" },
    ]);
  });
});

describe("teamaiStatus(本地 vs digest 增删改三态)", () => {
  it("内容一致=三态全空", () => {
    const d = readTeamaiAssets(root);
    expect(teamaiStatus(d, root)).toEqual({ added: [], removed: [], changed: [] });
  });

  it("改内容→changed;新增文件→added;删文件→removed;均排序返回", () => {
    const before = readTeamaiAssets(root);
    w("rules/flat.md", "扁平规则正文(改过)\n");
    w("rules/extra.md", "新规则\n");
    w("skills/demo/newnew/SKILL.md", "新技能\n");
    unlinkSync(join(root, "learnings/1700000000-demo.md"));
    const st = teamaiStatus(before, root);
    expect(st.changed).toEqual(["rules/flat.md"]);
    expect(st.added).toEqual(["rules/extra.md", "skills/demo/newnew/SKILL.md"]);
    expect(st.removed).toEqual(["learnings/1700000000-demo.md"]);
  });
});

describe("teamaiDoctor(团队仓健康度)", () => {
  it("完整团队仓:ok=true,含 ok finding", () => {
    const r = teamaiDoctor(root);
    expect(r.ok).toBe(true);
    expect(r.findings.some((f) => f.level === "ok")).toBe(true);
    expect(r.findings.filter((f) => f.level === "error")).toEqual([]);
  });

  it("缺 teamai.yaml → error;角色引用不存在的技能 → warn", () => {
    rmSync(join(root, "teamai.yaml"));
    w("roster/roles.yaml", "roles:\n  - id: dev\n    name: 开发\n    skills: [nope/missing]\n    rules: [demo/y]\n");
    const r = teamaiDoctor(root);
    expect(r.ok).toBe(false);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("teamai_yaml_missing");
    expect(codes).toContain("role_skill_missing");
    expect(r.findings.find((f) => f.code === "teamai_yaml_missing")!.level).toBe("error");
    expect(r.findings.find((f) => f.code === "role_skill_missing")!.level).toBe("warn");
    // 规则引用可解析的两种写法(带 ns 与裸名)都不断言为 missing
    expect(codes.filter((c) => c === "role_rule_missing")).toEqual([]);
  });

  it("空目录:多条 error(members 目录缺失)", () => {
    const empty = mkdtempSync(join(tmpdir(), "teamai-doc-"));
    try {
      const r = teamaiDoctor(empty);
      expect(r.ok).toBe(false);
      expect(r.findings.filter((f) => f.level === "error").map((f) => f.code).sort()).toEqual([
        "members_dir_missing",
        "teamai_yaml_missing",
      ]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
