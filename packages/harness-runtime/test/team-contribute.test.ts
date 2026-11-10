/**
 * relay.teamai.contribute(designs/30 §2.4):经验写 teamai-learnings 分支,
 * 以及 relay 读侧 learningsFromGit(无 upstreamUrl → origin/<learningsBranch>)能读回。
 * 纯函数面(learningPath/renderLearningDoc)单独断言形态,保证读侧 parseLearningMeta 可解析。
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
import { learningPath, learningSlug, renderLearningDoc } from "../src/team/team-contribute";
import { parseLearningMeta } from "../src/team/teamai-bridge";
import { newDeviceKey, signChallenge } from "../src/team/relay-auth";
import { fingerprintOf } from "../src/identity/identity";

const execFileP = promisify(execFile);
const g = (args: string[], cwd: string) => execFileP("git", args, { cwd }).then((r) => r.stdout.trim());
const bareGit = (bare: string, args: string[], cwd: string) => g(["--git-dir", bare, ...args], cwd);

interface Client {
  request(m: Record<string, unknown>, type: string, pred?: (m: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
  waitAny(type: string, pred?: (m: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
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
      const base = recv.length;
      ws.send(JSON.stringify({ v: 1, ...m }));
      return waitFor(type, pred, ms, base);
    },
    /** 从连接起全量搜(用于「已发生过的广播」,pred 需保证唯一,如 path 包含判定)。 */
    waitAny: (type, pred, ms) => waitFor(type, pred, ms, 0),
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
  root = mkdtempSync(join(tmpdir(), "team-contribute-"));
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

  // 无 upstreamUrl:learnings 读侧必须走 origin/<learningsBranch>(内嵌 bare 形态)。
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

describe("team-contribute 纯函数面", () => {
  it("learningSlug:非字母数字转 -、截断 40、空则 untitled", () => {
    expect(learningSlug("Flaky Test: fix retry!")).toBe("flaky-test-fix-retry");
    expect(learningSlug("")).toBe("untitled");
    expect(learningSlug("中文标题")).toBe("untitled");
    expect(learningSlug("a".repeat(60)).length).toBe(40);
    expect(learningPath(1_700_000_000_000, "Multi  Space__name")).toBe("learnings/1700000000000-multi-space-name.md");
  });

  it("renderLearningDoc 的 frontmatter 能被读侧 parseLearningMeta 解析", () => {
    const doc = renderLearningDoc({
      title: "Retry 要退避", body: "指数退避 + 抖动\n", author: "dev1", tags: ["retry", "flaky"],
      at: Date.UTC(2026, 9, 29, 12, 0, 0),
    });
    const meta = parseLearningMeta(doc);
    expect(meta.title).toBe("Retry 要退避");
    expect(meta.author).toBe("dev1");
    expect(meta.tags).toEqual(["retry", "flaky"]);
    expect(meta.date).toBe("2026-10-29T12:00:00.000Z");
    expect(doc).toContain("指数退避 + 抖动");
  });
});

describe("relay.teamai.contribute(§2.4)", () => {
  it("title/body 为空 → code=invalid,不产生分支", async () => {
    const r = await client.request({ type: "relay.teamai.contribute", title: "  ", body: "x" }, "relay.teamai.contribute.result");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("invalid");
    const heads = await bareGit(bare, ["for-each-ref", "--format=%(refname)", "refs/heads"], root);
    expect(heads).not.toContain("teamai-learnings");
  }, 30_000);

  it("写入 learnings 分支 + digest.learnings 能读回(无 upstreamUrl)", async () => {
    const r = await client.request(
      { type: "relay.teamai.contribute", title: "Relay 写入经验", body: "贡献正文第一段", tags: ["relay", "obs"] },
      "relay.teamai.contribute.result",
    );
    expect(r.ok).toBe(true);
    expect(r.branch).toBe("teamai-learnings");
    const path = r.path as string;
    expect(path).toMatch(/^learnings\/\d+-relay\.md$/); // 非 ASCII 冲掉,只剩 "relay"
    const shown = await bareGit(bare, ["show", `teamai-learnings:${path}`], root);
    expect(shown).toContain('title: "Relay 写入经验"');
    expect(shown).toContain("author: dev1");
    expect(shown).toContain("贡献正文第一段");

    // 读侧:relay 的 learningsFromGit 走 origin/teamai-learnings → digest.learnings 出现该 path
    // (contribute 成功即广播 digest;pred 以唯一 path 锚定,可全量搜已到达的广播)
    const digestMsg = await client.waitAny("relay.teamai.digest", (m) =>
      JSON.stringify(m.digest ?? {}).includes(path));
    const digest = digestMsg.digest as { learnings?: { path: string; title: string; author: string }[] };
    const hit = (digest.learnings ?? []).find((l) => l.path === path);
    expect(hit?.title).toBe("Relay 写入经验");
    expect(hit?.author).toBe("dev1");
  }, 60_000);

  it("再贡献一条:分支上累积两条(分支已存在时以其 tip 为基)", async () => {
    const r = await client.request(
      { type: "relay.teamai.contribute", title: "flaky test fix", body: "第二条经验", tags: ["test"] },
      "relay.teamai.contribute.result",
    );
    expect(r.ok).toBe(true);
    expect(r.path).toMatch(/^learnings\/\d+-flaky-test-fix\.md$/);
    const files = (await bareGit(bare, ["ls-tree", "-r", "--name-only", "teamai-learnings", "learnings/"], root))
      .split("\n").filter(Boolean);
    expect(files.length).toBe(2);
    expect(files.some((f) => f.endsWith("-flaky-test-fix.md"))).toBe(true);
  }, 60_000);
});
