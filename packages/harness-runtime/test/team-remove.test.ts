/**
 * relay.teamai.remove( §2.3):main 上删除资源 → commit → push origin;
 * not-found 时零写入(不 commit 不 push),非法入参 code=invalid。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AddressInfo } from "node:net";
import WebSocket from "ws";
import { TeamRelay } from "../src/team/team-relay";
import { newDeviceKey, signChallenge } from "../src/team/relay-auth";
import { fingerprintOf } from "../src/identity/identity";

const execFileP = promisify(execFile);
const g = (args: string[], cwd: string) => execFileP("git", args, { cwd }).then((r) => r.stdout.trim());
const bareGit = (bare: string, args: string[], cwd: string) => g(["--git-dir", bare, ...args], cwd);
/** 分支清单 + 全分支提交数(not-found 前后必须完全一致)。 */
const snapshot = async (bare: string, cwd: string) => ({
  branches: await bareGit(bare, ["for-each-ref", "--format=%(refname)", "refs/heads"], cwd),
  commits: await bareGit(bare, ["rev-list", "--count", "--branches"], cwd),
});

interface Client {
  request(m: Record<string, unknown>, type: string, pred?: (m: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
  close(): void;
}

async function connect(url: string, fp: string, pub: string, priv: string): Promise<Client> {
  const ws = new WebSocket(url);
  const recv: Record<string, unknown>[] = [];
  ws.on("message", (raw: Buffer) => {
    const m = JSON.parse(raw.toString()) as Record<string, unknown>;
    recv.push(m);
    if (m.type === "relay.challenge") {
      ws.send(JSON.stringify({
        v: 1, type: "relay.auth", fingerprint: fp, publicKeyPem: pub,
        nonce: m.nonce as string, sig: signChallenge(priv, m.nonce as string),
      }));
    }
  });
  const waitFor = (type: string, pred?: (m: Record<string, unknown>) => boolean, ms = 15000, base = 0) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${type} 超时`)), ms);
      const iv = setInterval(() => {
        for (let i = base; i < recv.length; i++) {
          const m = recv[i]!;
          if (m.type === type && (!pred || pred(m))) { clearTimeout(t); clearInterval(iv); resolve(m); return; }
        }
      }, 25);
    });
  const ready = waitFor("relay.auth.ok");
  const client: Client = {
    request: (m, type, pred, ms) => {
      const base = recv.length; // 只认本次请求之后的响应
      ws.send(JSON.stringify({ v: 1, ...m }));
      return waitFor(type, pred, ms, base);
    },
    close: () => ws.close(),
  };
  await ready;
  return client;
}

let root: string;
let bare: string;
let relay: TeamRelay;
let server: import("node:http").Server;
let client: Client;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "team-remove-"));
  bare = join(root, "team.git");
  await g(["init", "--bare", "-q", "-b", "main", bare], root);
  const key = newDeviceKey();
  const fp = fingerprintOf(key.publicKeyPem);
  const seed = join(root, "seed");
  await g(["clone", "-q", bare, seed], root);
  const files: Record<string, string> = {
    "roster/members/dev1.yaml": [
      "username: dev1", "displayName: Dev One", `fingerprint: ${fp}`, "keys:", `  - ${fp}`,
      "role: member", "projects: [demo]", "registeredAt: 2026-10-29T00:00:00Z", "revoked: false", "",
    ].join("\n"),
    "roster/projects.yaml": "demo.type: team\ndemo.repo: demo-app\n",
    "rules/demo/legacy.md": "---\nname: legacy\n---\n\n# legacy rule\n",
    "skills/demo/gone/SKILL.md": "---\nname: gone\ndescription: \"gone\"\n---\n\n# gone skill\n",
    "skills/demo/gone/CONTRIBUTORS": "dev1\n",
    "docs/keepme.md": "# keep me\n",
  };
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, p)), { recursive: true });
    writeFileSync(join(seed, p), content);
  }
  const ident = ["-c", "user.email=seed@local", "-c", "user.name=seed"];
  await g([...ident, "add", "-A"], seed);
  await g([...ident, "commit", "-q", "-m", "seed"], seed);
  await g(["push", "-q", "origin", "main"], seed);

  server = createServer();
  relay = new TeamRelay({ server, teamRepoUrl: bare, workdir: join(root, "relay-work"), rosterPollMs: 600_000 });
  await new Promise<void>((r) => server.listen(0, r));
  await relay.start();
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = await connect(url, fp, key.publicKeyPem, key.privateKeyPem);
}, 120_000);

afterAll(async () => {
  client?.close();
  if (relay) await relay.close().catch(() => {});
  if (server) await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

describe("relay.teamai.remove(§2.3)", () => {
  it("kind=rule 删除并推送:main 上该文件消失,其他资源不受影响", async () => {
    const r = await client.request({ type: "relay.teamai.remove", kind: "rule", ns: "demo", name: "legacy" }, "relay.teamai.remove.result");
    expect(r.ok).toBe(true);
    expect(r.path).toBe("rules/demo/legacy.md");
    // 删除生效的判定:origin/main 上读回该文件必须失败
    await expect(bareGit(bare, ["show", "main:rules/demo/legacy.md"], root)).rejects.toThrow();
    expect(await bareGit(bare, ["show", "main:docs/keepme.md"], root)).toContain("keep me");
    expect(await bareGit(bare, ["show", "main:skills/demo/gone/SKILL.md"], root)).toContain("gone skill");
  }, 60_000);

  it("kind=skill 删除整目录(skills/<ns>/<name>)", async () => {
    const r = await client.request({ type: "relay.teamai.remove", kind: "skill", ns: "demo", name: "gone" }, "relay.teamai.remove.result");
    expect(r.ok).toBe(true);
    const tree = await bareGit(bare, ["ls-tree", "-r", "--name-only", "main"], root);
    expect(tree.split("\n").filter((p) => p.startsWith("skills/demo/gone"))).toEqual([]);
  }, 60_000);

  it("路径不存在 → code=not-found 且不 commit 不 push", async () => {
    const before = await snapshot(bare, root);
    const r = await client.request({ type: "relay.teamai.remove", kind: "rule", ns: "demo", name: "nope" }, "relay.teamai.remove.result");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("not-found");
    const after = await snapshot(bare, root);
    expect(after.branches).toBe(before.branches);
    expect(after.commits).toBe(before.commits);
  }, 60_000);

  it("name 为空 → code=invalid", async () => {
    const r = await client.request({ type: "relay.teamai.remove", kind: "rule", ns: "demo", name: "" }, "relay.teamai.remove.result");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("invalid");
  }, 30_000);
});
