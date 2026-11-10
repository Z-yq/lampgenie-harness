/**
 * 平台绑定 team 的 e2e(designs/06 R1):providers.yaml 按 team={provider, groupPath} 声明,
 * relay 经 provider-factory 构造 provider——用 `platform: "force"` 声明平台但走裸 git 命令
 * (不碰平台 API;真实 gitlab/codeup API 路径待平台令牌实机联调)。
 * 链:providers.yaml(force)→ providerFromBinding=CustomGitProvider → bootstrap 空仓 →
 *     TeamRelay(providerOpts) → owner 邀请 → alice 兑换 → roster 分支真实存在。
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import WebSocket from "ws";
import { TeamRelay } from "../src/team/team-relay";
import { loadTeamBinding, providerFromBinding, bootstrapTeamRepo } from "../src/git/provider-factory";
import { loadOrCreateIdentity, fingerprintOf } from "../src/identity/identity.js";
import { readFileSync } from "node:fs";
import { signChallenge } from "../src/team/relay-auth.js";

const execFileP = promisify(execFile);
const git = (args: string[], cwd: string) => execFileP("git", args, { cwd }).then((r) => r.stdout.trim());

let dir: string;
let bare: string;
let relay: TeamRelay;
let httpServer: import("node:http").Server;
let relayUrl: string;
let ownerIdentity: ReturnType<typeof loadOrCreateIdentity>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "team-provider-e2e-"));
  bare = join(dir, "team.git");
  await git(["init", "--bare", "-b", "main", bare], dir);
  ownerIdentity = loadOrCreateIdentity(join(dir, "owner-identity"));
}, 60_000);

afterAll(async () => {
  if (relay) await relay.close().catch(() => {});
  if (httpServer) await new Promise<void>((r) => httpServer.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe("providers.yaml 平台绑定 team → Relay 全链(platform:force 裸 git + bootstrap)", () => {
  it("绑定解析 → 引导空仓 → Relay 邀请流全链", async () => {
    // ① providers.yaml 声明平台 team(groupPath)+platform:force → 构造出 CustomGitProvider。
    writeFileSync(join(dir, "providers.yaml"), JSON.stringify({
      team: { provider: "gitlab", groupPath: "my-org", baseUrl: "http://192.168.8.60", platform: "force" },
    }));
    const binding = loadTeamBinding(join(dir, "providers.yaml"))!;
    expect(binding.team.groupPath).toBe("my-org");
    const provider = providerFromBinding(binding);
    expect(provider.kind).toBe("custom"); // force=声明平台仍走裸 git

    // ② bootstrap 空仓:写 roster/projects.yaml 并推送。
    const made = await bootstrapTeamRepo(provider, bare, join(dir, ".bootstrap"));
    expect(made).toBe(true);
    // 再补 owner roster,好让 owner 能认证。
    const seed = mkdtempSync(join(dir, "seed-"));
    await git(["clone", bare, seed], dir);
    mkdirSync(join(seed, "roster", "members"), { recursive: true });
    writeFileSync(join(seed, "roster", "members", "owner1.yaml"), [
      "username: owner1", "displayName: Owner", `fingerprint: ${ownerIdentity.fingerprint}`,
      "keys:", `  - ${ownerIdentity.fingerprint}`, "role: owner", "projects: []",
      "registeredAt: 2026-10-13T00:00:00Z", "revoked: false", "",
    ].join("\n"));
    const gi = ["-c", "user.email=s@local", "-c", "user.name=s"];
    await git([...gi, "add", "-A"], seed);
    await git([...gi, "commit", "-m", "seed owner"], seed);
    await git(["push", "origin", "main"], seed);
    rmSync(seed, { recursive: true, force: true });

    // ③ Relay 用 providerOpts 构造(不再写死 CustomGitProvider)。
    httpServer = createServer();
    relay = new TeamRelay({
      server: httpServer, teamRepoUrl: bare, workdir: join(dir, "relay-work"),
      providerOpts: provider, rosterPollMs: 150,
    });
    await new Promise<void>((r) => httpServer.listen(0, r));
    relayUrl = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    await relay.start();

    // ④ 裸 WS 简易客户端:owner 鉴权(真身份,指纹自证+签名——假密钥会被 F1 拒)。
    const ownerPub = readFileSync(ownerIdentity.privateKeyPath.replace(/\.pem$/, ".pub"), "utf-8");
    const ownerPriv = readFileSync(ownerIdentity.privateKeyPath, "utf-8");
    const owner = new WebSocket(relayUrl);
    const received: Record<string, unknown>[] = [];
    owner.on("message", (raw: Buffer) => {
      const m = JSON.parse(raw.toString());
      received.push(m);
      if (m.type === "relay.challenge") {
        owner.send(JSON.stringify({
          v: 1, type: "relay.auth",
          fingerprint: ownerIdentity.fingerprint, publicKeyPem: ownerPub,
          nonce: m.nonce, sig: signChallenge(ownerPriv, m.nonce as string),
        }));
      }
    });
    const authOk = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 3000);
      const iv = setInterval(() => {
        if (received.some((m) => m.type === "relay.auth.ok")) { clearTimeout(t); clearInterval(iv); resolve(true); }
      }, 50);
    });
    expect(authOk).toBe(true); // roster + provider 通道正常(空 fingerprint 成员=memberByFingerprint 命中)

    // ⑤ owner 发邀请码 → 兑换 → roster 分支真实存在于团队仓。
    owner.send(JSON.stringify({ v: 1, type: "relay.invite.create" }));
    const issued = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("invite.issued 超时")), 3000);
      const iv = setInterval(() => {
        const hit = received.find((m) => m.type === "relay.invite.issued");
        if (hit) { clearTimeout(t); clearInterval(iv); resolve(hit); }
      }, 50);
    });
    const alice = new WebSocket(relayUrl);
    const aliceRecv: Record<string, unknown>[] = [];
    alice.on("message", (raw: Buffer) => aliceRecv.push(JSON.parse(raw.toString())));
    await new Promise((r) => setTimeout(r, 300));
    alice.send(JSON.stringify({
      v: 1, type: "relay.invite.redeem", code: (issued as { code: string }).code,
      username: "alice", displayName: "Alice", fingerprint: "alicefp1",
    }));
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("invite.result 超时")), 3000);
      const iv = setInterval(() => {
        const hit = aliceRecv.find((m) => m.type === "relay.invite.result");
        if (hit) { clearTimeout(t); clearInterval(iv); resolve(hit); }
      }, 50);
    });
    expect((result as { ok: boolean }).ok).toBe(true);
    const branch = ((result as { mr: { branch: string } }).mr).branch;
    const ls = await git(["ls-remote", "--heads", bare], dir);
    expect(ls).toContain(branch); // 兑换在团队仓开了真实 roster 分支(provider 通道)

    owner.close();
    alice.close();
  }, 60_000);
});
