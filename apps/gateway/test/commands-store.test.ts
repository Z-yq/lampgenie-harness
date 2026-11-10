/**
 * 自定义命令仓库(2026-10,ZCode 语义补全)单测。
 * 覆盖:子目录命名空间 / 多根优先级 + 覆盖诊断 / frontmatter / 无 description 兜底 /
 *       100KB 上限 / upsert 冒号分层 + 路径穿越拦截。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandStore, parseFlatYaml, validateCommandName } from "../src/commands-store.js";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gwcmd2-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(dir: string, rel: string, content: string): string {
  const file = join(dir, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content, "utf-8");
  return file;
}

describe("CommandStore 发现(多根 + 递归 + 命名空间)", () => {
  it("① 子目录 → dir:name(命名空间用冒号;名字小写化)", () => {
    const dir = join(root, "project");
    write(dir, "deploy.md", "部署到预发");
    write(dir, join("git", "sync.md"), "同步远端分支");
    write(dir, join("db", "migrate", "up.md"), "跑迁移");
    const store = new CommandStore([{ dir, priority: 20, source: "project" }]);
    const names = store.list().map((c) => c.name);
    expect(names).toContain("deploy");
    expect(names).toContain("git:sync");
    expect(names).toContain("db:migrate:up");
    expect(store.listWithDiagnostics().diagnostics).toHaveLength(0);
  });

  it("② project 根覆盖 user 根同名命令(priority 高者赢 + 被覆盖者记 warning)", () => {
    const userDir = join(root, "user");
    const projDir = join(root, "project");
    write(userDir, "deploy.md", "user 版本:部署到预发");
    write(projDir, "deploy.md", "project 版本:部署到生产");
    write(userDir, "only-user.md", "只在 user 根");
    const store = CommandStore.fromRoots([
      { dir: userDir, priority: 10, source: "user" },
      { dir: projDir, priority: 20, source: "project" },
    ]);
    const outcome = store.listWithDiagnostics();
    const deploy = outcome.commands.find((c) => c.name === "deploy");
    expect(deploy?.body).toBe("project 版本:部署到生产");
    expect(deploy?.source).toBe("project");
    expect(outcome.commands.find((c) => c.name === "only-user")?.source).toBe("user");
    const dup = outcome.diagnostics.find((d) => d.code === "custom_command_duplicate_name");
    expect(dup).toBeTruthy();
    expect(dup?.severity).toBe("warning");
    expect(dup?.path).toContain("deploy.md");
  });

  it("③ frontmatter:description / argument-hint / allowed-tools / model / skills + body 只留正文", () => {
    const dir = join(root, "project");
    write(
      dir,
      "codereview.md",
      [
        "---",
        "description: 四维度代码审查",
        "argument-hint: 审查重点(可空)",
        "allowed-tools: read_file, code_review",
        "model: claude-sonnet-4",
        "skills: code-review",
        "unknown-key: 随便写不报错",
        "---",
        "",
        "# 审查正文",
        "按正确性/风险/测试覆盖/可维护性输出 findings",
      ].join("\n"),
    );
    const store = new CommandStore([{ dir, priority: 20, source: "project" }]);
    const cmd = store.list()[0]!;
    expect(cmd.description).toBe("四维度代码审查");
    expect(cmd.inputHint).toBe("审查重点(可空)");
    expect(cmd.allowedTools).toEqual(["read_file", "code_review"]);
    expect(cmd.model).toBe("claude-sonnet-4");
    expect(cmd.skills).toEqual(["code-review"]);
    // body = frontmatter 之后的正文(frontmatter 不出现在 body 里)
    expect(cmd.body.startsWith("# 审查正文")).toBe(true);
    expect(cmd.body).not.toContain("description:");
    // 未知键不报错(收下不诊断)
    expect(store.listWithDiagnostics().diagnostics).toHaveLength(0);
  });

  it("③b block scalar(> 折叠 / | 保留换行)", () => {
    const folded = parseFlatYaml(["description: >", "  第一行", "  第二行", "model: x"].join("\n"));
    expect(folded.values.description).toBe("第一行 第二行");
    expect(folded.values.model).toBe("x");
    const literal = parseFlatYaml(["details: |", "  a", "  b"].join("\n"));
    expect(literal.values.details).toBe("a\nb");
  });

  it("④ 无 description → 取正文首个非空行(截 200 字)", () => {
    const dir = join(root, "project");
    write(dir, "plain.md", "\n\n# 部署到预发环境\n后续说明");
    const cmd = new CommandStore([{ dir, priority: 10, source: "project" }]).list()[0]!;
    expect(cmd.description).toBe("部署到预发环境");

    write(dir, "long.md", "x".repeat(400));
    const long = new CommandStore([{ dir, priority: 10, source: "project" }])
      .list()
      .find((c) => c.name === "long")!;
    expect(long.description).toHaveLength(200);
  });

  it("⑤ 超过 100KB 跳过 + 记诊断", () => {
    const dir = join(root, "project");
    write(dir, "big.md", "a".repeat(100_100));
    write(dir, "ok.md", "小命令");
    const outcome = new CommandStore([{ dir, priority: 10, source: "project" }]).listWithDiagnostics();
    expect(outcome.commands.map((c) => c.name)).toEqual(["ok"]);
    const diag = outcome.diagnostics.find((d) => d.code === "custom_command_too_large");
    expect(diag).toBeTruthy();
    expect(diag?.severity).toBe("warning");
    expect(diag?.message).toContain("100000");
  });

  it("非法名跳过 + 诊断(大写/空格/中文开头)", () => {
    const dir = join(root, "project");
    write(dir, "Bad Name.md", "x");
    const outcome = new CommandStore([{ dir, priority: 10, source: "project" }]).listWithDiagnostics();
    expect(outcome.commands).toHaveLength(0);
    expect(outcome.diagnostics.some((d) => d.code === "custom_command_invalid_name")).toBe(true);
  });

  it("symlink 环不死循环(realpath 去重);深度 >12 不扫", () => {
    const dir = join(root, "project");
    write(dir, "a.md", "命令 a");
    try {
      const { symlinkSync } = require("node:fs") as typeof import("node:fs");
      symlinkSync(dir, join(dir, "loop"), "dir");
    } catch {
      // Windows 无权限建 symlink:跳过环断言,不影响其他用例
    }
    const store = new CommandStore([{ dir, priority: 10, source: "project" }]);
    const names = store.list().map((c) => c.name);
    expect(names).toContain("a");
    expect(names.length).toBeLessThan(5);

    // 14 层深的文件不应被扫到
    const deep = join(dir, ...Array.from({ length: 14 }, () => "d"));
    write(deep, "deep.md", "太深的命令");
    expect(new CommandStore([{ dir, priority: 10, source: "project" }]).list().map((c) => c.name)).not.toContain(
      "d:d:d:d:d:d:d:d:d:d:d:d:d:deep",
    );
  });
});

describe("CommandStore 写入(upsert / remove)", () => {
  it("⑥ upsert 带冒号写子目录;`../x` 与绝对路径被拒", () => {
    const projDir = join(root, "project");
    const store = new CommandStore([{ dir: projDir, priority: 20, source: "project" }]);
    const r = store.upsert("git:sync", "同步远端分支");
    expect("error" in (r as object)).toBe(false);
    expect(existsSync(join(projDir, "git", "sync.md"))).toBe(true);
    expect(store.list().map((c) => c.name)).toContain("git:sync");

    // 路径穿越 / 非法形态全部拒绝
    for (const bad of ["../x", "..", "a/b", "/etc/passwd", "a::b", "", ":x", "x:"]) {
      const out = store.upsert(bad, "x");
      expect("error" in (out as object), `应拒绝: ${bad}`).toBe(true);
    }
    // 拒绝的名字不落盘(根目录下只应有 git/sync.md)
    expect(existsSync(join(projDir, "..", "..", "x.md"))).toBe(false);

    // remove 同样拦截穿越
    expect(store.remove("../x")).toBe(false);
    expect(store.remove("git:sync")).toBe(true);
    expect(store.remove("git:sync")).toBe(false);
  });

  it("upsert 带 opts 写 frontmatter(description/argument-hint),再次 list 能读回", () => {
    const projDir = join(root, "project");
    const store = new CommandStore([{ dir: projDir, priority: 20, source: "project" }]);
    store.upsert("deploy", "部署到预发", { description: "部署命令", inputHint: "环境名?" });
    const cmd = store.list().find((c) => c.name === "deploy")!;
    expect(cmd.description).toBe("部署命令");
    expect(cmd.inputHint).toBe("环境名?");
    expect(cmd.body).toBe("部署到预发");
  });

  it("upsert 只写 project 根(不改 user 根);兼容旧单目录构造", () => {
    const userDir = join(root, "user");
    const projDir = join(root, "project");
    write(userDir, "deploy.md", "user 版本");
    const store = CommandStore.fromRoots([
      { dir: userDir, priority: 10, source: "user" },
      { dir: projDir, priority: 20, source: "project" },
    ]);
    store.upsert("deploy", "project 版本");
    expect(existsSync(join(projDir, "deploy.md"))).toBe(true);
    expect(store.list().find((c) => c.name === "deploy")?.body).toBe("project 版本");

    // 旧构造 new CommandStore(dir) 仍可用(单根 project)
    const legacy = new CommandStore(join(root, "legacy", "commands"));
    legacy.upsert("hello", "你好");
    expect(legacy.list().map((c) => c.name)).toEqual(["hello"]);
  });

  it("名称校验函数:合法/非法一览", () => {
    expect(validateCommandName("deploy")).toBeNull();
    expect(validateCommandName("/deploy")).toBeNull();
    expect(validateCommandName("git:sync")).toBeNull();
    expect(validateCommandName("../x")).toContain("..");
    expect(validateCommandName("a/b")).toContain("分隔符");
    expect(validateCommandName("a::b")).toContain("连续冒号");
    expect(validateCommandName("")).toContain("不能为空");
  });
});
