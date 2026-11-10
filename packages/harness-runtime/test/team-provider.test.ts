import { describe, it, expect } from "vitest";
import {
  resolveTeamSecret, loadTeamBinding, providerFromBinding, bootstrapTeamRepo,
} from "../src/git/provider-factory";
import { CustomGitProvider } from "../src/git/provider";
import { GitLabProvider } from "../src/git/gitlab";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const git = (args: string[], cwd: string) => execFileP("git", args, { cwd }).then((r) => r.stdout.trim());

describe("team provider 绑定( R1:providers.yaml 按 team={provider, groupPath})", () => {
  it("resolveTeamSecret:$ENV:NAME 从环境解析,缺失 fail-visible 抛错", () => {
    expect(resolveTeamSecret("$ENV:MY_TOK", { MY_TOK: "abc" } as NodeJS.ProcessEnv)).toBe("abc");
    expect(resolveTeamSecret("plaintext")).toBe("plaintext");
    expect(resolveTeamSecret(undefined)).toBeUndefined();
    expect(() => resolveTeamSecret("$ENV:MISSING_VAR", {} as NodeJS.ProcessEnv)).toThrow("环境变量缺失");
  });

  it("providerFromBinding:无绑定 → CustomGitProvider;platform:force → Custom(声明平台仍走裸 git,不碰 API)", () => {
    expect(providerFromBinding(null).kind).toBe("custom");
    const p = providerFromBinding({
      team: { provider: "gitlab", groupPath: "my-org", baseUrl: "http://x", platform: "force" },
    });
    expect(p.kind).toBe("custom");
  });

  it("providerFromBinding:gitlab 构造(缺 baseUrl fail-visible)", () => {
    expect(() => providerFromBinding({ team: { provider: "gitlab", projectPath: "a/b" } } as never)).toThrow("baseUrl");
    const p = providerFromBinding({
      team: { provider: "gitlab", baseUrl: "http://192.168.8.60", projectPath: "my-org/genie-team-context" },
    }, { RELAY_PROVIDER_TOKEN: "tok" } as NodeJS.ProcessEnv);
    expect(p).toBeInstanceOf(GitLabProvider);
    expect(p.kind).toBe("gitlab");
  });

  it("loadTeamBinding:缺失文件→null;坏 JSON→null(降级 custom,不吓人)", () => {
    const dir = mkdtempSync(join(tmpdir(), "prov-"));
    expect(loadTeamBinding(join(dir, "nope.yaml"))).toBeNull();
    writeFileSync(join(dir, "bad.yaml"), "{not json");
    expect(loadTeamBinding(join(dir, "bad.yaml"))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("bootstrapTeamRepo:空仓写入 roster/projects.yaml 并推送;已有 roster 幂等返回 false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boot-"));
    const bare = join(dir, "team.git");
    await git(["init", "--bare", "-b", "main", bare], dir);
    const p = new CustomGitProvider();
    const first = await bootstrapTeamRepo(p, bare, join(dir, ".b"));
    expect(first).toBe(true);
    // main 上现在有了 projects.yaml(空 head 时由 main orphan 分支)。
    const wd = mkdtempSync(join(dir, "v-"));
    await git(["clone", bare, wd], dir);
    const proj = (await import("node:fs")).readFileSync(join(wd, "roster", "projects.yaml"), "utf-8");
    expect(proj).toContain("lampgenie-harness.type: team");
    rmSync(wd, { recursive: true, force: true });
    const second = await bootstrapTeamRepo(p, bare, join(dir, ".b2"));
    expect(second).toBe(false); // 已有 roster=幂等
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
