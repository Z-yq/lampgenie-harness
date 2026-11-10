import { describe, it, expect, afterEach } from "vitest";
import { gitContributors, gitRemoteUrl } from "../src/git-service.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let dir: string | null = null;
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

function freshRepo(withRemote = true): string {
  dir = mkdtempSync(join(tmpdir(), "gh-gitsvc-"));
  const g = (args: string[], cwd = dir!) => execFileSync("git", args, { cwd });
  g(["init", "-q"]);
  g(["config", "user.email", "alice@x.com"]);
  g(["config", "user.name", "Alice"]);
  writeFileSync(join(dir, "a.txt"), "1");
  g(["add", "."]); g(["commit", "-qm", "a1"]); g(["commit", "-qam", "a2", "--allow-empty"]);
  g(["-c", "user.email=bob@y.com", "-c", "user.name=Bob", "commit", "-qm", "b1", "--allow-empty"]);
  g(["-c", "user.email=bob@y.com", "-c", "user.name=Bob", "commit", "-qm", "b2", "--allow-empty"]);
  g(["-c", "user.email=bob@y.com", "-c", "user.name=Bob", "commit", "-qm", "b3", "--allow-empty"]);
  if (withRemote) g(["remote", "add", "origin", "https://git.example.com/foo/bar.git"]);
  return dir;
}

describe("gitRemoteUrl(设计稿23 绑定键来源)", () => {
  it("有 origin → 返回 URL;无 remote → null", () => {
    expect(gitRemoteUrl(freshRepo(true))).resolves.toBe("https://git.example.com/foo/bar.git");
    expect(gitRemoteUrl(freshRepo(false))).resolves.toBeNull();
  });
});

describe("gitContributors(designs/23 候选名单)", () => {
  it("按邮箱聚合提交数并降序", async () => {
    const cwd = freshRepo(true);
    const list = await gitContributors(cwd);
    expect(list[0]).toMatchObject({ name: "Bob", email: "bob@y.com", commits: 3 });
    expect(list[1]).toMatchObject({ name: "Alice", email: "alice@x.com", commits: 2 });
    expect(list.length).toBe(2);
  });

  it("limit 截断", async () => {
    const cwd = freshRepo(true);
    const list = await gitContributors(cwd, 1);
    expect(list.length).toBe(1);
    expect(list[0]!.email).toBe("bob@y.com");
  });
});
