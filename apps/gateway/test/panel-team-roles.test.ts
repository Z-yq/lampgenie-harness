// 团队页角色/同步面静态断言( teamai 移植 p1):
// panel.ts 是 ~29.7k 行内联脚本大文件(grep 对其静默零命中),按 panel-git-sync 的既有模式做源码级契约锚。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "panel.ts"), "utf-8");

describe("团队页角色卡(roles 资源命名空间)", () => {
  it("digest.roles 渲染为「角 色(资源命名空间)」分区,空态有提示", () => {
    expect(src).toContain("sec(\"角 色(资源命名空间)\", roleRows");
    expect(src).toContain("roster/roles.yaml 未定义角色");
  });
  it("角色行展示 id/name/description 与 skills·rules 计数", () => {
    expect(src).toContain("const roleRows = (t.roles || []).map");
    expect(src).toContain('" · rules " + ((r.rules || []).length)');
    expect(src).toMatch(/esc\(r\.id\)/);
  });
  it("团队仓头部计数包含 roles 与 learnings", () => {
    expect(src).toContain('" · roles " + (t.roles || []).length + " · learnings " + (t.learnings || []).length');
  });
});

describe("成员角色徽标(memberRoles 与权限位 role 分离)", () => {
  it("成员卡按 digest.memberRoles[username] 出 roleId 徽标", () => {
    expect(src).toContain("const rid = memberRoles[p.username];");
    expect(src).toContain("const roleChip = rid ?");
  });
  it("旧网关无 memberRoles 字段时退化为空对象(不报错、不显示徽标)", () => {
    expect(src).toContain('(typeof lastTeamaiRaw === "object" && lastTeamaiRaw && lastTeamaiRaw.memberRoles) || {}');
  });
});

describe("团队仓有角色/学习时不再被判空", () => {
  it("空态判据纳入 roles 与 learnings(否则只有角色/学习的团队仓整块消失)", () => {
    expect(src).toContain("!(t.roles && t.roles.length) && !(t.learnings && t.learnings.length)");
  });
});
