import { describe, it, expect } from "vitest";
import {
  parseTeamaiMeta, parseHookList, parseEnvYaml, scanSkillFrontmatter,
  readTeamaiAssets, teamaiPushBranch, safeSkillPath,
} from "../src/team/teamai-bridge";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("parseTeamaiMeta(嵌套形态只取三条路径)", () => {
  it("team/description/repo/enforced/reviewers 全解析", () => {
    const meta = parseTeamaiMeta(`team: 神眸精灵系统
description: "团队 AI 知识库(经 teamai-cli 分发)"
repo: https://codeup.aliyun.com/x/y.git
sharing:
  rules:
    enforced:
      - security.md
      - git-commit.md
  docs:
    localDir: ./.teamai/docs
reviewers:
  - zhaohongtao
`);
    expect(meta.team).toBe("神眸精灵系统");
    expect(meta.description).toBe("团队 AI 知识库(经 teamai-cli 分发)");
    expect(meta.repo).toBe("https://codeup.aliyun.com/x/y.git");
    expect(meta.enforcedRules).toEqual(["security.md", "git-commit.md"]);
    expect(meta.reviewers).toEqual(["zhaohongtao"]);
  });

  it("缺文件形态=全空不抛错", () => {
    expect(parseTeamaiMeta("").team).toBe("");
  });
});

describe("parseHookList / parseEnvYaml(真实团队仓形态)", () => {
  it("hooks 块式列表+tools 流式列表", () => {
    const hooks = parseHookList(`hooks:
  - id: block-secret-leak
    description: 拦截疑似密钥内容
    event: PreToolUse
    matcher: "Bash|Write|Edit"
    timeout: 10
    tools: [claude]
    command: python3 -c '...'
  - id: second
    event: SessionStart
    tools: []
`);
    expect(hooks).toHaveLength(2);
    expect(hooks[0]).toMatchObject({ id: "block-secret-leak", event: "PreToolUse", matcher: "Bash|Write|Edit", tools: ["claude"] });
    expect(hooks[1]).toMatchObject({ id: "second", event: "SessionStart", tools: [] });
  });

  it("env variables 三字段;secrets 只取 key", () => {
    const vars = parseEnvYaml(`variables:
  - key: QWEATHER_HOST
    value: devapi.qweather.com
    description: 和风天气 API host
`);
    expect(vars).toEqual([{ key: "QWEATHER_HOST", value: "devapi.qweather.com", description: "和风天气 API host" }]);
  });
});

describe("scanSkillFrontmatter(teamai skill 形态)", () => {
  it("name/description 带引号剥离", () => {
    const fm = scanSkillFrontmatter(`---
name: genie-debug-workflow
description: "系统性调试工作流。"
---

# 调试工作流
`);
    expect(fm).toEqual({ name: "genie-debug-workflow", description: "系统性调试工作流。" });
  });
});

describe("readTeamaiAssets(克隆目录全量投影)", () => {
  it("skills/rules/culture/docs/env/hooks 全读;secrets 只出 key;enforced 标记正确", () => {
    const dir = join(tmpdir(), "gh-teamai-" + Date.now().toString(36));
    mkdirSync(join(dir, "skills", "common", "debug"), { recursive: true });
    mkdirSync(join(dir, "rules"), { recursive: true });
    mkdirSync(join(dir, "env"), { recursive: true });
    mkdirSync(join(dir, "docs", "guide"), { recursive: true });
    writeFileSync(join(dir, "teamai.yaml"), "team: T\nsharing:\n  rules:\n    enforced:\n      - security\n");
    writeFileSync(join(dir, "culture.md"), "使命:把事做对。");
    writeFileSync(join(dir, "rules", "security.md"), "禁密钥入库");
    writeFileSync(join(dir, "rules", "style.md"), "风格指南");
    writeFileSync(join(dir, "skills", "common", "debug", "SKILL.md"), "---\nname: debug\ndescription: \"调试\"\n---\n正文");
    writeFileSync(join(dir, "skills", "common", "debug", "CONTRIBUTORS"), "yujitai\n");
    writeFileSync(join(dir, "docs", "guide", "a.md"), "x");
    writeFileSync(join(dir, "env", "env.yaml"), "variables:\n  - key: K1\n    value: v1\n");
    writeFileSync(join(dir, "env", "secrets.yaml"), "variables:\n  - key: SECRET_TOKEN\n    value: super-secret-value\n");
    try {
      const d = readTeamaiAssets(dir);
      expect(d.meta.team).toBe("T");
      expect(d.culture).toContain("使命");
      expect(d.rules.find((r) => r.name === "security")?.enforced).toBe(true);
      expect(d.rules.find((r) => r.name === "style")?.enforced).toBe(false);
      expect(d.skills).toEqual([{ ns: "common", name: "debug", description: "调试", contributors: ["yujitai"], body: expect.stringContaining("正文") }]);
      expect(d.docs).toEqual(["guide/a.md"]);
      expect(d.envVars).toEqual([{ key: "K1", value: "v1", description: "" }]);
      expect(d.secretKeys).toEqual(["SECRET_TOKEN"]);
      expect(JSON.stringify(d)).not.toContain("super-secret-value"); // 红线:secrets 值绝不进投影
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("push 守卫", () => {
  it("分支名对齐 teamai-cli 约定", () => {
    expect(teamaiPushBranch("yujitai", new Date(2026, 9, 13, 22, 36, 2))).toBe("teamai/push/yujitai/20261013-223602");
  });
  it("safeSkillPath 防穿越", () => {
    expect(safeSkillPath("common", "my-skill")).toBe("common/my-skill");
    expect(safeSkillPath("../evil", "x")).toBeNull();
    expect(safeSkillPath("common", "../../etc")).toBeNull();
    expect(safeSkillPath("common", "a".repeat(60))).toBeNull();
  });
});
