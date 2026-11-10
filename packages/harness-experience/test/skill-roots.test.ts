/**
 * n5 多根技能发现测试(ZCode adapters/skills):
 * ① resolveSkillRoots 顺序与 priority(每级 +10);② 同名 project 覆盖 user 且记 warning;
 * ③ description >1024 丢弃 + error 诊断;④ 无 frontmatter 用目录名;⑤ block scalar(`|` 与 `>`)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperienceStore, resolveSkillRoots } from "../src";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function mk(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-skillroots-"));
  dirs.push(d);
  return d;
}

/** 手写一个 SKILL.md(测试直接落原始文本,模拟外部手写技能;不走 store.write)。 */
function writeSkill(root: string, category: string, dirName: string, text: string): void {
  const d = join(root, category, dirName);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), text, "utf-8");
}

describe("resolveSkillRoots(n5 多根 + priority)", () => {
  it("顺序 user → project,每级 priority += 10;home 缺技能目录则跳过", () => {
    const base = mk();
    const home = join(base, "home");
    const project = join(base, "repo");
    mkdirSync(join(home, ".genie", "experiences"), { recursive: true });
    mkdirSync(project, { recursive: true });

    const roots = resolveSkillRoots({ projectRoot: project, home });
    expect(roots.map((r) => r.scope)).toEqual(["user", "project"]);
    expect(roots[0]!.priority).toBe(10);
    expect(roots[1]!.priority).toBe(20);
    expect(roots[0]!.dir).toBe(join(home, ".genie", "experiences"));
    expect(roots[1]!.dir).toBe(join(project, ".genie", "experiences"));

    // home 下没有 .genie/experiences → 只留 project 根(不凭空造用户根)
    const home2 = join(base, "home2");
    mkdirSync(home2, { recursive: true });
    const only = resolveSkillRoots({ projectRoot: project, home: home2 });
    expect(only.map((r) => r.scope)).toEqual(["project"]);
    expect(only[0]!.priority).toBe(10);

    // home=null 明确不要 user 根
    expect(resolveSkillRoots({ projectRoot: project, home: null }).map((r) => r.scope)).toEqual(["project"]);
  });

  it("ExperienceStore.fromRoots:写落最高优先级根,读能跨根命中;旧单根构造行为不变", async () => {
    const base = mk();
    const userRoot = join(base, "user-exp");
    const projectRoot = join(base, "proj-exp");
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    const store = ExperienceStore.fromRoots([
      { dir: userRoot, scope: "user", priority: 10 },
      { dir: projectRoot, scope: "project", priority: 20 },
    ]);
    expect(store.root).toBe(projectRoot);
    await store.write({ category: "coding", name: "written", description: "写路径落 project 根", created_by: "agent" }, "正文");
    expect(store.read("coding", "written")).not.toBeNull();
    expect(store.skillDir("coding", "written")).toBe(join(projectRoot, "coding", "written"));

    // 旧单根构造:root=入参,行为与多根前一致
    const single = new ExperienceStore(projectRoot);
    expect(single.root).toBe(projectRoot);
    expect(single.read("coding", "written")).not.toBeNull();
  });
});

describe("frontmatter 解析纪律(n5)", () => {
  function twoRootStore() {
    const base = mk();
    const userRoot = join(base, "user-exp");
    const projectRoot = join(base, "proj-exp");
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    const store = ExperienceStore.fromRoots([
      { dir: userRoot, scope: "user", priority: 10 },
      { dir: projectRoot, scope: "project", priority: 20 },
    ]);
    return { store, userRoot, projectRoot };
  }

  it("同名 project 覆盖 user,被压过的记 warning 诊断", () => {
    const { store, userRoot, projectRoot } = twoRootStore();
    writeSkill(userRoot, "coding", "dup", "---\nname: dup\ndescription: 用户版\n---\n\n用户正文");
    writeSkill(projectRoot, "coding", "dup", "---\nname: dup\ndescription: 项目版\n---\n\n项目正文");

    const { skills, diagnostics } = store.indexWithDiagnostics();
    const dup = skills.find((s) => s.category === "coding" && s.name === "dup");
    expect(dup!.description).toBe("项目版");
    expect(dup!.scope).toBe("project");
    expect(dup!.path).toBe(join(projectRoot, "coding", "dup", "SKILL.md"));
    // 全文读到的也是 project 版本
    expect(store.readBody("coding", "dup")).toContain("项目正文");

    const shadowed = diagnostics.filter((d) => d.code === "skill_shadowed");
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0]!.severity).toBe("warning");
    expect(shadowed[0]!.path).toBe(join(userRoot, "coding", "dup", "SKILL.md"));
    expect(shadowed[0]!.message).toContain("coding/dup");

    // 向后兼容:index() 直接返回数组
    expect(Array.isArray(store.index())).toBe(true);
  });

  it("description >1024 丢弃并记 error 诊断;写入侧 ≤60 校验仍保留", async () => {
    const { store, projectRoot } = twoRootStore();
    writeSkill(projectRoot, "coding", "too-long", `---\nname: too-long\ndescription: ${"字".repeat(1025)}\n---\n\n正文`);
    writeSkill(projectRoot, "coding", "ok", `---\nname: ok\ndescription: ${"字".repeat(1024)}\n---\n\n正文`);
    writeSkill(projectRoot, "coding", "no-desc", "---\nname: no-desc\n---\n\n正文");

    const { skills, diagnostics } = store.indexWithDiagnostics();
    expect(skills.map((s) => s.name)).toEqual(["ok"]); // 1024 恰好过、1025 丢弃、缺 description 丢弃
    const errs = diagnostics.filter((d) => d.severity === "error");
    expect(errs.some((d) => d.code === "skill_description_too_long" && d.skillName === "too-long")).toBe(true);
    expect(errs.some((d) => d.code === "skill_missing_description" && d.skillName === "no-desc")).toBe(true);

    // 写路径口径不变:>60 字符拒绝落库
    await expect(
      store.write({ category: "coding", name: "w", description: "d".repeat(61), created_by: "agent" }, "b"),
    ).rejects.toThrow(/60/);
  });

  it("无 frontmatter → name 回退目录名、description 空、无 error 诊断", () => {
    const { store, projectRoot } = twoRootStore();
    writeSkill(projectRoot, "ops", "handwritten", "# 手写技能\n\n没有 frontmatter 的正文。");
    const { skills, diagnostics } = store.indexWithDiagnostics();
    const hw = skills.find((s) => s.name === "handwritten");
    expect(hw).toBeDefined();
    expect(hw!.description).toBe("");
    expect(hw!.path).toBe(join(projectRoot, "ops", "handwritten", "SKILL.md"));
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("block scalar:`|` 保留换行、`>` 折成一行;when_to_use 映射 whenToUse", () => {
    const { store, projectRoot } = twoRootStore();
    writeSkill(
      projectRoot,
      "coding",
      "literal",
      "---\nname: literal\ndescription: |\n  第一行\n  第二行\nwhen_to_use: >\n  需要写\n  block scalar 的时候\n---\n\n正文L",
    );
    writeSkill(
      projectRoot,
      "coding",
      "folded",
      "---\nname: folded\ndescription: >\n  折行的第一段\n  仍然同一行\n\n  第二段\n---\n\n正文F",
    );
    const { skills } = store.indexWithDiagnostics();
    const lit = skills.find((s) => s.name === "literal")!;
    expect(lit.description).toBe("第一行\n第二行");
    expect(lit.whenToUse).toBe("需要写 block scalar 的时候");
    const fold = skills.find((s) => s.name === "folded")!;
    expect(fold.description).toBe("折行的第一段 仍然同一行\n第二段");
  });
});
