/**
 * relay.teamai.push 多类型( §2.2):kind=skill|rule|doc 三个落点路径,
 * 以及空 body 的可诊断拒绝(code=invalid,且不产生新分支)。
 * 手法:mkdtemp 临时 bare 团队仓 + 真 TeamRelay + 裸 WS 客户端(dev1 真密钥签名)。
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const waitReady = waitFor("relay.auth.ok");
  const client: Client = {
    /** 发一条消息并等**本次**响应(基线=发送时刻的 recv 长度,避免拿到上一条结果)。 */
    request: (m, type, pred, ms) => {
      const base = recv.length;
      ws.send(JSON.stringify({ v: 1, ...m }));
      return waitFor(type, pred, ms, base);
    },
    close: () => ws.close(),
  };
  await waitReady;
  return client;
}

let root: string;
let bare: string;
let relay: TeamRelay;
let server: import("node:http").Server;
let client: Client;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "team-push-kinds-"));
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

describe("relay.teamai.push 多类型落点(§2.2)", () => {
  it("kind=skill|rule|doc 落在 skills/<ns>/<name>/SKILL.md、rules/<ns>/<name>.md、docs/<name>.md", async () => {
    const r1 = await client.request(
      { type: "relay.teamai.push", kind: "skill", ns: "demo", name: "alpha", description: "A", body: "# alpha body" },
      "relay.teamai.push.result",
    );
    expect(r1.ok).toBe(true);
    const b1 = r1.branch as string;
    expect(await bareGit(bare, ["show", `${b1}:skills/demo/alpha/SKILL.md`], root)).toContain("# alpha body");
    expect(await bareGit(bare, ["show", `${b1}:skills/demo/alpha/CONTRIBUTORS`], root)).toContain("dev1");

    // 分支名按秒粒度:同秒重复 push 会被远端判 non-ff,错开一拍。
    await sleep(1100);
    const r2 = await client.request(
      { type: "relay.teamai.push", kind: "rule", ns: "demo", name: "beta", description: "B", body: "# beta rule" },
      "relay.teamai.push.result",
    );
    expect(r2.ok).toBe(true);
    const b2 = r2.branch as string;
    expect(await bareGit(bare, ["show", `${b2}:rules/demo/beta.md`], root)).toContain("# beta rule");

    await sleep(1100);
    const r3 = await client.request(
      { type: "relay.teamai.push", kind: "doc", ns: "demo", name: "gamma", description: "G", body: "# gamma doc" },
      "relay.teamai.push.result",
    );
    expect(r3.ok).toBe(true);
    const b3 = r3.branch as string;
    expect(await bareGit(bare, ["show", `${b3}:docs/gamma.md`], root)).toContain("# gamma doc");
    const tree3 = await bareGit(bare, ["ls-tree", "-r", "--name-only", b3], root);
    expect(tree3.split("\n")).toContain("docs/gamma.md");
    expect(tree3.split("\n")).not.toContain("docs/demo/gamma.md");
  }, 90_000);

  it("kind 缺省=skill(旧客户端行为不变)", async () => {
    await sleep(1100);
    const r = await client.request(
      { type: "relay.teamai.push", ns: "demo", name: "delta", description: "D", body: "# delta body" },
      "relay.teamai.push.result",
    );
    expect(r.ok).toBe(true);
    const branch = r.branch as string;
    expect(await bareGit(bare, ["show", `${branch}:skills/demo/delta/SKILL.md`], root)).toContain("# delta body");
    expect(branch.startsWith("teamai/push/dev1/")).toBe(true);
  }, 60_000);

  it("空 body → code=invalid 且不产生新分支", async () => {
    const before = await bareGit(bare, ["for-each-ref", "--format=%(refname)", "refs/heads"], root);
    const r = await client.request(
      { type: "relay.teamai.push", kind: "rule", ns: "demo", name: "empty", description: "", body: "   " },
      "relay.teamai.push.result",
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe("invalid");
    const after = await bareGit(bare, ["for-each-ref", "--format=%(refname)", "refs/heads"], root);
    expect(after).toBe(before);
  }, 30_000);
});
