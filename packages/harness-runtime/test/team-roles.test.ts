/**
 * teamai-roles:roster/roles.yaml 解析(designs/30 §2.1/§2.7)。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRolesYaml, readRoles } from "../src/team/teamai-roles.js";

describe("parseRolesYaml(块式列表,仿 parseHookList)", () => {
  it("契约形态:四角色多字段解析", () => {
    const roles = parseRolesYaml(`roles:
  - id: dev
    name: 开发
    description: 实现与自测
    skills: [demo-team-style]
    rules: [demo-typescript]
  - id: reviewer
    name: 评审
    description: 代码评审
    skills: []
    rules: [demo-typescript, demo-security]
`);
    expect(roles).toHaveLength(2);
    expect(roles[0]).toEqual({ id: "dev", name: "开发", description: "实现与自测", skills: ["demo-team-style"], rules: ["demo-typescript"] });
    expect(roles[1]).toMatchObject({ id: "reviewer", skills: [], rules: ["demo-typescript", "demo-security"] });
  });

  it("块式 skills/rules 续行 + 注释/CRLF 容忍", () => {
    const roles = parseRolesYaml("roles:\r\n  - id: owner\r\n    # 注释行\r\n    skills:\r\n      - demo-a\r\n      - demo-b\r\n    rules:\r\n      - demo-r\r\n");
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ id: "owner", name: "owner", skills: ["demo-a", "demo-b"], rules: ["demo-r"] });
  });

  it("缺 id 的条目跳过,空文本/无 roles 段返回 []", () => {
    expect(parseRolesYaml(`roles:
  - name: 无名
    description: 没 id
  - id: ok
`)).toHaveLength(1);
    expect(parseRolesYaml("")).toEqual([]);
    expect(parseRolesYaml("roles: []\n")).toEqual([]);
  });
});

describe("readRoles", () => {
  it("读 <cloneDir>/roster/roles.yaml;不存在返回 []", () => {
    const dir = mkdtempSync(join(tmpdir(), "roles-"));
    try {
      expect(readRoles(dir)).toEqual([]);
      mkdirSync(join(dir, "roster"), { recursive: true });
      writeFileSync(join(dir, "roster", "roles.yaml"), "roles:\n  - id: dev\n    name: 开发\n", "utf-8");
      expect(readRoles(dir)).toHaveLength(1);
      expect(readRoles(dir)[0]!.id).toBe("dev");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
