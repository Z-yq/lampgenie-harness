import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, fingerprintOf, createInviteCode } from "../src/identity/identity";
import { CustomGitProvider } from "../src/git/provider";

describe("身份层", () => {
  it("首次生成,二次幂等加载,私钥 600", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-id-"));
    const a = loadOrCreateIdentity(dir);
    const b = loadOrCreateIdentity(dir);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(existsSync(join(dir, "identity.pem"))).toBe(true);
    // 私钥权限 600
    const mode = statSync(join(dir, "identity.pem")).mode & 0o777;
    expect(mode).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });
  it("指纹稳定且人可读", () => {
    const f1 = fingerprintOf("pub-key-A");
    expect(f1).toBe(fingerprintOf("pub-key-A"));
    expect(f1).toMatch(/^([0-9a-f]{4}-){7}[0-9a-f]{4}$/);
  });
  it("邀请码 7 天有效", () => {
    const inv = createInviteCode();
    expect(inv.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("CustomGitProvider(降级)", () => {
  it("clone 走真实 git 命令", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-git-"));
    const provider = new CustomGitProvider();
    // 本地 bare 仓当源
    const { execSync } = await import("node:child_process");
    execSync("git init --bare src.git", { cwd: dir });
    await provider.clone(join(dir, "src.git"), join(dir, "dst"));
    expect(existsSync(join(dir, "dst", ".git"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
