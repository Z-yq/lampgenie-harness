/**
 * nightly-worker 出进程入口单测(P4:
 * - 参数齐全:跑 startNightly+runNightly,stdout 末行机器可读 JSON,exit 0;
 * - 幂等跳过:同日 done 且无新会话 → {ok:true, note:"同日已完成且无新会话"},exit 0;
 * - 缺参数:exit 2 + JSON 原因。
 * 跑法:npx tsx src/nightly-worker.ts(真子进程,校验的就是进程边界)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { nightlyLockFile, runNightly, startNightly } from "../src/nightly-store.js";

const execFileP = promisify(execFile);
const NOW = Date.UTC(2026, 10, 17, 2, 0, 0);
const PROJECT = "proj";

let root = "";
const roots: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ngt-worker-"));
  roots.push(root);
  mkdirSync(join(root, "journal", "sessions"), { recursive: true });
});
afterEach(() => {
  while (roots.length > 0) {
    const r = roots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

function seedSession(name: string): void {
  writeFileSync(
    join(root, "journal", "sessions", `${name}.jsonl`),
    [
      JSON.stringify({ kind: "tool.call", sessionId: name, payload: { toolCallId: "a1", name: "read_file", arguments: JSON.stringify({ path: "src/x.ts" }) } }),
      JSON.stringify({ kind: "tool.result", sessionId: name, payload: { toolCallId: "a1", name: "read_file", content: "ok" } }),
    ].join("\n") + "\n",
  );
}

function runWorker(args: string[]) {
  return execFileP("npx", ["tsx", join(__dirname, "../src/nightly-worker.ts"), ...args], {
    cwd: join(__dirname, ".."),
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

describe("nightly-worker(子进程入口)", { timeout: 30_000 }, () => {
  it("完整跑一轮:start+run 七步,stdout 末行 JSON,exit 0", async () => {
    seedSession("sess-a");
    const { stdout } = await runWorker(["--root", root, "--project", PROJECT, "--date", "2026-11-17", "--journal", join(root, "journal")]);
    const last = stdout.trim().split(/\r?\n/).filter((l) => l !== "").pop() ?? "";
    const parsed = JSON.parse(last) as { ok: boolean; runId?: string; note?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.runId).toBe(`ngt-${PROJECT}-2026-11-17`);
    expect(parsed.note).toContain("steps=7/7");
  });

  it("幂等:同日 done 且无新会话 → ok:true 跳过", async () => {
    seedSession("sess-a");
    const pre = await startNightly(root, { date: "2026-11-17", projectId: PROJECT, journalDir: join(root, "journal"), now: NOW });
    await runNightly(root, { runId: pre.run!.runId!, journalDir: join(root, "journal"), now: NOW + 10 });
    const { stdout } = await runWorker(["--root", root, "--project", PROJECT, "--date", "2026-11-17", "--journal", join(root, "journal")]);
    const parsed = JSON.parse(stdout.trim().split(/\r?\n/).filter((l) => l !== "").pop() ?? "") as { ok: boolean; note?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.note).toContain("同日已完成且无新会话");
  });

  it("缺参数:exit 2 + JSON 原因", async () => {
    await expect(runWorker(["--root", root])).rejects.toMatchObject({ code: 2 });
  });

  it("锁被活进程持有 → ok:true note worker already running 退出 0,且不起 run", async () => {
    seedSession("sess-a");
    const lockFile = nightlyLockFile(root, PROJECT);
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
    const { stdout } = await runWorker(["--root", root, "--project", PROJECT, "--date", "2026-11-17", "--journal", join(root, "journal")]);
    const parsed = JSON.parse(stdout.trim().split(/\r?\n/).filter((l) => l !== "").pop() ?? "") as { ok: boolean; note?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.note).toContain("worker already running");
    expect(existsSync(join(root, ".genie/rsi/nightly", PROJECT, "2026-11-17.json"))).toBe(false);
    expect(existsSync(lockFile)).toBe(true); // 没抢到锁就不删别人的锁
  });

  it("陈旧锁被接管:正常跑完 steps=7/7,结束时释放锁", async () => {
    seedSession("sess-a");
    const lockFile = nightlyLockFile(root, PROJECT);
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, JSON.stringify({ pid: 999_999, at: Date.now() - 60 * 60 * 1000 }), "utf8");
    const { stdout } = await runWorker(["--root", root, "--project", PROJECT, "--date", "2026-11-17", "--journal", join(root, "journal")]);
    const parsed = JSON.parse(stdout.trim().split(/\r?\n/).filter((l) => l !== "").pop() ?? "") as { ok: boolean; note?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.note).toContain("steps=7/7");
    expect(existsSync(lockFile)).toBe(false);
  });
});
