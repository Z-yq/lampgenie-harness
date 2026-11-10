/**
 * M16 轮末变更账本(turn-change-ledger,2026-11-07)。
 *
 * A. 纯函数/采集:临时 git 仓(改 tracked / 新建 untracked / .gitignore 忽略 / 超大 / 非 git / 上限截断);
 * B. 接线(agent-wiring):done 与 failed 两路都落 journal custom `turn.change-ledger`,
 *    且账本内容绝不进 finalOut/模型上下文。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
import {
  captureBaseline,
  collectToolTouched,
  computeChangeLedger,
  parsePorcelainZ,
  DEFAULT_OVERSIZED_BYTES,
  MAX_UNKNOWN,
  type LedgerEvent,
} from "../src/turn-change-ledger.js";

// ---- 测试基建:临时 git 仓 ----
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
});

function git(cwd: string, args: readonly string[]): string {
  return String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

/** 建一个已提交一次的临时仓(tracked.txt = v1)。 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "genie-ledger-"));
  dirs.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "tester"]);
  writeFileSync(join(dir, "tracked.txt"), "v1\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

let seq = 0;
const touch = (path: string, tool = "edit_file"): LedgerEvent => ({
  seq: ++seq,
  kind: "tool.call",
  payload: { toolCallId: `t${seq}`, name: tool, arguments: JSON.stringify({ path }) },
});

describe("git status -z 解析", () => {
  it("普通条目与重命名(取新路径、跳过旧路径字段)", () => {
    const entries = parsePorcelainZ(" M tracked.txt\0?? new.txt\0R  newer.txt\0older.txt\0");
    expect(entries).toEqual([
      { status: " M", path: "tracked.txt" },
      { status: "??", path: "new.txt" },
      { status: "R ", path: "newer.txt" },
    ]);
  });
});

describe("collectToolTouched", () => {
  it("只收 write 类工具,绝对路径归一为仓内相对,去重保序", () => {
    const root = "/repo";
    const list = collectToolTouched([
      touch(join(root, "src/a.ts")),
      touch("src/a.ts", "write_file"),
      touch("src/b.ts", "apply_patch"),
      { kind: "tool.call", payload: { name: "terminal", arguments: JSON.stringify({ command: "ls" }) } },
    ], root);
    expect(list).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("computeChangeLedger(git 模式)", () => {
  it("改 tracked / 新建 untracked → changed;字段完整", async () => {
    const dir = makeRepo();
    const baseline = await captureBaseline(dir);
    expect(baseline.mode).toBe("git");
    writeFileSync(join(dir, "tracked.txt"), "v2 changed\n");
    writeFileSync(join(dir, "brand-new.txt"), "hello\n");
    const ledger = await computeChangeLedger({
      root: dir, baseline,
      endEvents: [touch("tracked.txt"), touch("brand-new.txt")],
    });
    expect(ledger.mode).toBe("git");
    expect(ledger.baselineCount).toBe(Object.keys(baseline.files).length);
    const paths = ledger.changed.map((c) => c.path).sort();
    expect(paths).toContain("tracked.txt");
    expect(paths).toContain("brand-new.txt");
    const tracked = ledger.changed.find((c) => c.path === "tracked.txt")!;
    expect(tracked.status.trim()).not.toBe(""); // XY 非空
    expect(tracked.size).toBeGreaterThan(0);
    expect(typeof tracked.oversized).toBe("boolean");
    expect(Array.isArray(ledger.unknown)).toBe(true);
    expect(Array.isArray(ledger.oversized)).toBe(true);
    expect(ledger.truncated.changed).toBe(false);
  });

  it("工具触碰 .gitignore 忽略文件(git 看不见)→ unknown,未知不判「未改」", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    git(dir, ["add", ".gitignore"]);
    git(dir, ["commit", "-q", "-m", "ignore"]);
    const baseline = await captureBaseline(dir);
    writeFileSync(join(dir, "noise.log"), "ignored content\n");
    const ledger = await computeChangeLedger({
      root: dir, baseline, endEvents: [touch("noise.log", "write_file")],
    });
    expect(ledger.changed.map((c) => c.path)).not.toContain("noise.log");
    const un = ledger.unknown.find((u) => u.path === "noise.log");
    expect(un).toBeTruthy();
    expect(un!.reason).toContain("git 不可见");
  });

  it("超大文件单列 oversized 且不省略", async () => {
    const dir = makeRepo();
    const baseline = await captureBaseline(dir);
    const big = Buffer.alloc(4096, "a");
    writeFileSync(join(dir, "big.txt"), big);
    const ledger = await computeChangeLedger({
      root: dir, baseline,
      endEvents: [touch("big.txt", "write_file")],
      oversizedBytes: 1024,
    });
    const hit = ledger.changed.find((c) => c.path === "big.txt")!;
    expect(hit.oversized).toBe(true);
    expect(ledger.oversized).toContainEqual({ path: "big.txt", size: 4096 });
    // 缺省阈值常量(1MB)本身也要有真源
    expect(DEFAULT_OVERSIZED_BYTES).toBe(1024 * 1024);
  });

  it("二进制文件即使很小也判 oversized", async () => {
    const dir = makeRepo();
    const baseline = await captureBaseline(dir);
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    const ledger = await computeChangeLedger({
      root: dir, baseline, endEvents: [touch("blob.bin", "write_file")], oversizedBytes: 1024 * 1024,
    });
    expect(ledger.oversized.map((o) => o.path)).toContain("blob.bin");
  });

  it("unknown 超 50 条 → 截断但计数不全静默", async () => {
    const dir = makeRepo();
    const baseline = await captureBaseline(dir);
    const missing = Array.from({ length: MAX_UNKNOWN + 3 }, (_, i) => touch(`gone-${i}.txt`));
    const ledger = await computeChangeLedger({ root: dir, baseline, endEvents: missing });
    expect(ledger.unknown.length).toBe(MAX_UNKNOWN);
    expect(ledger.truncated.unknown).toBe(true);
    expect(ledger.truncated.unknownTotal).toBe(MAX_UNKNOWN + 3);
  });
});

describe("computeChangeLedger(非 git)", () => {
  it("非 git 目录:mode=non-git,工具触碰且存在 → changed,stat 失败 → unknown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "genie-ledger-nongit-"));
    dirs.push(dir);
    const baseline = await captureBaseline(dir);
    expect(baseline.mode).toBe("non-git");
    expect(baseline.files).toEqual({});
    writeFileSync(join(dir, "kept.txt"), "x\n");
    const ledger = await computeChangeLedger({
      root: dir, baseline, endEvents: [touch("kept.txt"), touch("absent.txt")],
    });
    expect(ledger.mode).toBe("non-git");
    expect(ledger.changed.map((c) => c.path)).toEqual(["kept.txt"]);
    expect(ledger.unknown.map((u) => u.path)).toEqual(["absent.txt"]);
    expect(ledger.unknown[0]!.reason).toContain("stat 失败");
  });
});

// ---- B. 接线:agent-wiring(done / failed 两路) ----
beforeAll(async () => { await acquireEnvLock("turn-change-ledger"); }, 240_000);
afterAll(() => { releaseEnvLock("turn-change-ledger"); });

const gwApps: ReturnType<typeof createGatewayApp>[] = [];
afterEach(async () => {
  for (const a of gwApps.splice(0)) await a.close();
  delete process.env.GENIE_VERIFY_ON_STOP;
});

type App = ReturnType<typeof createGatewayApp>;
type Append = (e: { kind: string; sessionId: string; payload: Record<string, unknown> }) => void;

const INSTRUCTION = "跑一下这个任务";

interface Scenario { sid: string; seed: (sid: string, append: Append) => void }

async function runScenario(s: Scenario): Promise<{ state: string; result: string; app: App }> {
  let appRef: App;
  let step = 0;
  const app = createGatewayApp({
    port: 0,
    llm: {
      async chat() {
        if (step++ === 0) {
          s.seed(s.sid, (e) => { appRef.journal.append(e as never); });
          return { content: "终稿" };
        }
        return { content: "终稿" };
      },
    } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  appRef = app;
  gwApps.push(app);
  app.taskManager.submit("user", s.sid, INSTRUCTION);
  for (let k = 0; k < 240; k++) {
    const t = app.taskManager.list().find((x) => x.sessionId === s.sid);
    if (t && (t.state === "done" || t.state === "failed")) return { state: t.state, result: String(t.result ?? ""), app };
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("任务未在时限内终态");
}

const seedWrite = (sid: string, append: Append) => {
  // 用 .md 文档路径:验证账本(M107)对文档抑制,不会把路径写进 finalOut——这样 canary 只可能来自变更账本。
  append({ kind: "tool.call", sessionId: sid, payload: { toolCallId: "w1", name: "write_file", arguments: JSON.stringify({ path: "docs/__ledger_probe__.md", content: "x" }) } });
};
const seedVerifiedThenWrite = (sid: string, append: Append) => {
  append({ kind: "tool.call", sessionId: sid, payload: { toolCallId: "t1", name: "terminal", arguments: JSON.stringify({ command: "npx vitest run test/a.test.ts" }) } });
  append({ kind: "tool.result", sessionId: sid, payload: { toolCallId: "t1", content: "3 passed", durationMs: 5 } });
  // hard 场景需要「验证之后又写代码」→ 这里必须是代码文件(验证账本只对文档抑制)。
  append({ kind: "tool.call", sessionId: sid, payload: { toolCallId: "w2", name: "edit_file", arguments: JSON.stringify({ path: "apps/gateway/src/late.ts", old_string: "a", new_string: "b" }) } });
};

const ledgerEvents = (app: App, sid: string) =>
  app.journal.readAll().filter((e) => e.kind === "custom" && e.sessionId === sid && (e.payload as { type?: string } | undefined)?.type === "turn.change-ledger");

/** 账本在 finally 里异步采集(终态先落、账本后到),这里等它出现(上限 30s)。 */
async function waitLedger(app: App, sid: string): Promise<Record<string, unknown> | null> {
  for (let k = 0; k < 200; k++) {
    const hit = ledgerEvents(app, sid)[0];
    if (hit) return hit.payload as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

describe("接线:turn.change-ledger 只进 journal,不进 finalOut", () => {
  it("done:落账本事件,字段完整;finalOut 不含账本内容", async () => {
    const r = await runScenario({ sid: "m16-done-1", seed: seedWrite });
    expect(r.state).toBe("done");
    const p = await waitLedger(r.app, "m16-done-1");
    expect(p).toBeTruthy();
    const pl = p as Record<string, unknown>;
    expect(pl.taskId).toBeTruthy();
    expect(["git", "non-git"]).toContain(pl.mode);
    expect(typeof pl.baselineCount).toBe("number");
    expect(Array.isArray(pl.changed)).toBe(true);
    expect(Array.isArray(pl.unknown)).toBe(true);
    expect(Array.isArray(pl.oversized)).toBe(true);
    expect(pl.truncated).toBeTruthy();
    // 账本绝不进模型可见的终稿
    expect(r.result).not.toContain("turn.change-ledger");
    expect(r.result).not.toContain("__ledger_probe__");
  }, 120_000);

  it("failed:同样出账本(不许只在成功路径)", async () => {
    process.env.GENIE_VERIFY_ON_STOP = "hard";
    const r = await runScenario({ sid: "m16-failed-1", seed: seedVerifiedThenWrite as Scenario["seed"] });
    expect(r.state).toBe("failed");
    const p = await waitLedger(r.app, "m16-failed-1");
    expect(p).toBeTruthy();
    expect((p as Record<string, unknown>).state).toBe("failed");
    expect(r.result).not.toContain("turn.change-ledger");
  }, 120_000);
});
