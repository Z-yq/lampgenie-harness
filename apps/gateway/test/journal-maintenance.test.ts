/**
 * journal 存储维护协议测试。
 * 覆盖:snapshot/holders(判活+--force 放行)、plan(阈值/keepNewest/预算/maxFiles/大文件优先)、
 * apply(移动+manifest+cursor)、dryRun 零改动、snapshot-drift abort、verify/restore 双门、
 * FileJournal 归档冷读(boot 不扫 archive / readSession 兜底)、CLI 退出码。
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { FileJournal } from "@lampgenie/core";
import {
  applyArchive,
  archiveGate,
  listHolders,
  planArchive,
  restoreArchive,
  snapshotJournal,
  verifyArchive,
  journalArchiveDirOf,
  type ApplyArchiveHooks,
} from "../src/journal-maintenance.js";

const DAY = 86_400_000;
const dirs: string[] = [];

function tmpRoot(prefix = "jm-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function journalOf(root: string): string {
  return join(root, ".genie", "journals");
}

function writeSessionFile(journalDir: string, sid: string, bytes: number, mtimeMs: number): string {
  const sessionsDir = join(journalDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const file = join(sessionsDir, `${sid}.jsonl`);
  writeFileSync(file, "x".repeat(bytes), "utf-8");
  const secs = mtimeMs / 1000;
  utimesSync(file, secs, secs);
  return file;
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("journal-maintenance plan / snapshot", () => {
  it("plan / plan-keep-newest: 阈值/keepNewest/预算/maxFiles 与大文件优先", () => {
    const jd = journalOf(tmpRoot());
    const now = 1_800_000_000_000;
    const a = writeSessionFile(jd, "a", 5000, now - 30 * DAY);
    const b = writeSessionFile(jd, "b", 3000, now - 25 * DAY);
    const c = writeSessionFile(jd, "c", 1000, now - 20 * DAY);
    const d = writeSessionFile(jd, "d", 2000, now - 10 * DAY);
    const e = writeSessionFile(jd, "e", 4000, now - 2 * DAY);
    const f = writeSessionFile(jd, "f", 6000, now - 1 * DAY);

    // 快照:枚举全部会话文件(含 dev/ino/size/mtimeMs)
    const snapshot = snapshotJournal(jd);
    expect(snapshot.map((s) => s.file).sort()).toEqual([a, b, c, d, e, f].sort());
    for (const s of snapshot) {
      expect(s.size).toBeGreaterThan(0);
      expect(typeof s.ino).toBe("number");
      expect(typeof s.dev).toBe("number");
      expect(typeof s.mtimeMs).toBe("number");
    }

    const plan = planArchive({ journalDir: jd, olderThanDays: 7, keepNewest: 2, maxFiles: 10, maxBytes: 1_000_000, now });
    // 大文件优先:size 降序
    expect(plan.candidates.map((x) => x.sid)).toEqual(["a", "b", "d", "c"]);
    expect(plan.totalBytes).toBe(11_000);
    expect(plan.sessionsFiles).toBe(6);
    // keepNewest=2:最新两个(f,e)一律不进 candidates,并记 skipped
    expect(plan.skipped.filter((s) => s.reason === "keep-newest").map((s) => s.file).sort()).toEqual([e, f].sort());
    expect(plan.candidates.some((x) => x.file === e || x.file === f)).toBe(false);

    // maxFiles=2:只取最大的两个,其余记 max-files
    const byCount = planArchive({ journalDir: jd, olderThanDays: 7, keepNewest: 2, maxFiles: 2, maxBytes: 1_000_000, now });
    expect(byCount.candidates.map((x) => x.sid)).toEqual(["a", "b"]);
    expect(byCount.skipped.filter((s) => s.reason === "max-files").length).toBe(2);

    // maxBytes=4000:a(5000) 超预算跳过,b(3000) 装入,d(2000) 超预算,c(1000) 装入 → 4000
    const byBytes = planArchive({ journalDir: jd, olderThanDays: 7, keepNewest: 2, maxFiles: 10, maxBytes: 4000, now });
    expect(byBytes.candidates.map((x) => x.sid)).toEqual(["b", "c"]);
    expect(byBytes.totalBytes).toBe(4000);
    expect(byBytes.skipped.find((s) => s.file === a)?.reason).toBe("budget");
    expect(byBytes.skipped.find((s) => s.file === d)?.reason).toBe("budget");

    // 阈值:keepNewest=0 时 e(2 天)按 fresh 跳过(不归档新文件)
    const freshOnly = planArchive({ journalDir: jd, olderThanDays: 7, keepNewest: 0, maxFiles: 10, maxBytes: 1_000_000, now });
    expect(freshOnly.skipped.find((s) => s.file === e)?.reason).toBe("fresh");
    expect(freshOnly.candidates.map((x) => x.sid)).toEqual(["a", "b", "d", "c"]);
  });

  it("plan: sessions 目录不存在 → 空候选空态(不抛)", () => {
    const jd = journalOf(tmpRoot());
    mkdirSync(jd, { recursive: true });
    const plan = planArchive({ journalDir: jd });
    expect(plan.sessionsFiles).toBe(0);
    expect(plan.candidates).toEqual([]);
    expect(plan.totalBytes).toBe(0);
    expect(journalArchiveDirOf(jd)).toBe(join(jd, "sessions-archive"));
  });
});

describe("journal-maintenance apply", () => {
  it("apply: 归档移动 + manifest.jsonl + archive-cursor.json", () => {
    const jd = journalOf(tmpRoot());
    const ad = journalArchiveDirOf(jd);
    const now = Date.now();
    const f1 = writeSessionFile(jd, "s1", 120, now - 30 * DAY);
    const f2 = writeSessionFile(jd, "s2", 80, now - 20 * DAY);
    const plan = planArchive({ journalDir: jd, archiveDir: ad, olderThanDays: 7, keepNewest: 0, maxFiles: 10, maxBytes: 1_000_000, now });
    expect(plan.candidates.length).toBe(2);

    const result = applyArchive(plan, { snapshotBefore: snapshotJournal(jd), now });
    expect(result.ok).toBe(true);
    expect(result.archived.map((a) => a.sid)).toEqual(["s1", "s2"]); // size 降序
    expect(existsSync(f1)).toBe(false);
    expect(existsSync(f2)).toBe(false);
    expect(existsSync(join(ad, "s1.jsonl"))).toBe(true);
    expect(existsSync(join(ad, "s2.jsonl"))).toBe(true);

    const manifest = readJsonl(join(ad, "manifest.jsonl"));
    expect(manifest.length).toBe(2);
    for (const rec of manifest) {
      expect(rec.sid).toBeTypeOf("string");
      expect(rec.file).toBeTypeOf("string");
      expect(rec.bytes).toBeTypeOf("number");
      expect(rec.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(rec.archivedAt).toBeTypeOf("number");
    }
    const cursor = JSON.parse(readFileSync(join(jd, "archive-cursor.json"), "utf-8")) as {
      completed: number;
      lastCompleted?: string;
      totalCandidates: number;
    };
    expect(cursor.completed).toBe(2);
    expect(cursor.lastCompleted).toBe(f2);
    expect(cursor.totalCandidates).toBe(2);
    // 归档文件内容与 manifest sha 一致
    expect(verifyArchive(ad).ok).toBe(true);
  });

  it("dryRun: 零写入(sessions 目录与 manifest 均不变)", () => {
    const jd = journalOf(tmpRoot());
    const ad = journalArchiveDirOf(jd);
    const now = Date.now();
    writeSessionFile(jd, "d1", 100, now - 30 * DAY);
    writeSessionFile(jd, "d2", 50, now - 20 * DAY);
    const plan = planArchive({ journalDir: jd, archiveDir: ad, olderThanDays: 7, keepNewest: 0, now });
    const before = readdirSync(join(jd, "sessions")).sort();

    const result = applyArchive(plan, { snapshotBefore: snapshotJournal(jd), dryRun: true, now });
    expect(result.dryRun).toBe(true);
    expect(result.archived).toEqual([]);
    expect(result.wouldArchive.map((c) => c.sid)).toEqual(["d1", "d2"]);
    expect(readdirSync(join(jd, "sessions")).sort()).toEqual(before);
    expect(existsSync(join(ad, "manifest.jsonl"))).toBe(false);
    expect(existsSync(join(jd, "archive-cursor.json"))).toBe(false);
  });

  it("drift / drift-abort: beforeRename 改写 → abort,已归档项标 drift,剩余候选原样保留", () => {
    const jd = journalOf(tmpRoot());
    const ad = journalArchiveDirOf(jd);
    const now = Date.now();
    const a = writeSessionFile(jd, "a", 300, now - 30 * DAY);
    const b = writeSessionFile(jd, "b", 200, now - 25 * DAY);
    const c = writeSessionFile(jd, "c", 100, now - 20 * DAY);
    const plan = planArchive({ journalDir: jd, archiveDir: ad, olderThanDays: 7, keepNewest: 0, now });
    expect(plan.candidates.map((x) => x.sid)).toEqual(["a", "b", "c"]);

    const hooks: ApplyArchiveHooks = {
      beforeRename: (candidate) => {
        if (candidate.sid === "b") appendFileSync(candidate.file, "drift-write");
      },
    };
    const result = applyArchive(plan, { snapshotBefore: snapshotJournal(jd), hooks, now });

    expect(result.ok).toBe(false);
    expect(result.aborted?.code).toBe("SNAPSHOT_DRIFT");
    expect(result.aborted?.file).toBe(b);
    expect(result.archived.length).toBe(1);
    expect(result.archived[0]?.sid).toBe("a");
    expect(result.archived[0]?.drift).toBe(true);
    // 已归档的 a 保留在 archive;漂移的 b 与未处理的 c 都原样留在 sessions
    expect(existsSync(a)).toBe(false);
    expect(existsSync(join(ad, "a.jsonl"))).toBe(true);
    expect(existsSync(b)).toBe(true);
    expect(existsSync(c)).toBe(true);
    expect(existsSync(join(ad, "b.jsonl"))).toBe(false);
    expect(existsSync(join(ad, "c.jsonl"))).toBe(false);
    const manifest = readJsonl(join(ad, "manifest.jsonl"));
    expect(manifest.some((r) => r.type === "abort" && r.code === "SNAPSHOT_DRIFT")).toBe(true);
    const cursor = JSON.parse(readFileSync(join(jd, "archive-cursor.json"), "utf-8")) as { aborted?: { code?: string } };
    expect(cursor.aborted?.code).toBe("SNAPSHOT_DRIFT");
  });
});

describe("journal-maintenance holders", () => {
  it("holders: gateway.pid/lock/run.json 解析 + kill 判定;不可判活→拒;--force/--dryRun 放行", () => {
    const root = tmpRoot();
    mkdirSync(join(root, ".genie", "journals"), { recursive: true });
    mkdirSync(join(root, ".genie", "session-workers"), { recursive: true });
    writeFileSync(join(root, ".genie", "gateway.pid"), String(process.pid), "utf-8");
    writeFileSync(join(root, ".genie", "journals", "gateway.lock"), JSON.stringify({ pid: process.pid, start: "1", at: 1 }), "utf-8");
    writeFileSync(join(root, ".genie", "session-workers", "t1.run.json"), JSON.stringify({ pid: 4242 }), "utf-8");
    writeFileSync(join(root, ".genie", "session-workers", "t2.run.json"), JSON.stringify({ taskId: "no-pid" }), "utf-8");

    const deadKill = (): void => {
      const err = new Error("gone") as { code?: string };
      err.code = "ESRCH";
      throw err;
    };
    const dead = listHolders(root, { kill: deadKill });
    expect(dead.gatewayPid).toBe(process.pid);
    expect(dead.lockPid).toBe(process.pid);
    expect(dead.workerPids).toEqual([4242]);
    expect(dead.live).toBe(false);
    expect(archiveGate(dead).ok).toBe(true);

    // 不可判活(EPERM/未知 errno)→ 保守当活 → 拒跑
    const unknownKill = (): void => {
      const err = new Error("denied") as { code?: string };
      err.code = "EPERM";
      throw err;
    };
    const busy = listHolders(root, { kill: unknownKill });
    expect(busy.live).toBe(true);
    const gate = archiveGate(busy);
    expect(gate.ok).toBe(false);
    expect(gate.code).toBe("STORAGE_BUSY_HOLDERS");
    expect(archiveGate(busy, { force: true }).ok).toBe(true);
    expect(archiveGate(busy, { dryRun: true }).ok).toBe(true);

    // 真实 kill:不存在的 pid → 不活(另起一个根,避免本进程 pid 混入)
    const deadRoot = tmpRoot();
    mkdirSync(join(deadRoot, ".genie", "journals"), { recursive: true });
    writeFileSync(join(deadRoot, ".genie", "gateway.pid"), "2147483647", "utf-8");
    expect(listHolders(deadRoot).live).toBe(false);
  });
});

describe("journal-maintenance verify / restore", () => {
  it("verify/restore: sha 一致成功;篡改拒;目标已存在拒 RESTORE_TARGET_EXISTS", () => {
    const jd = journalOf(tmpRoot());
    const ad = journalArchiveDirOf(jd);
    const now = Date.now();
    const file = writeSessionFile(jd, "v1", 64, now - 30 * DAY);
    const original = readFileSync(file);
    const plan = planArchive({ journalDir: jd, archiveDir: ad, olderThanDays: 7, keepNewest: 0, now });
    expect(applyArchive(plan, { snapshotBefore: snapshotJournal(jd), now }).archived.length).toBe(1);

    expect(verifyArchive(ad).ok).toBe(true);
    expect(verifyArchive(ad).checked).toBe(1);

    // 目标已存在 → 拒(绝不覆盖)
    const target = join(jd, "sessions", "v1.jsonl");
    writeFileSync(target, "occupied", "utf-8");
    const exists = restoreArchive({ archiveDir: ad, journalDir: jd, sid: "v1" });
    expect(exists.ok).toBe(false);
    if (!exists.ok) expect(exists.code).toBe("RESTORE_TARGET_EXISTS");
    expect(readFileSync(target, "utf-8")).toBe("occupied");

    // 删除占用后成功回迁,内容与原文件一致
    rmSync(target);
    const ok = restoreArchive({ archiveDir: ad, journalDir: jd, sid: "v1" });
    expect(ok.ok).toBe(true);
    expect(readFileSync(target)).toEqual(original);
    // 回迁后 manifest 里该文件「归档次数 = 回迁次数」→ verify 不再要求它在归档目录
    const afterRestore = verifyArchive(ad);
    expect(afterRestore.ok).toBe(true);
    expect(afterRestore.checked).toBe(0);

    // 篡改归档文件 → verify 失败(CORRUPT)与 restore 拒
    expect(applyArchive(planArchive({ journalDir: jd, archiveDir: ad, olderThanDays: 7, keepNewest: 0, now }), { snapshotBefore: snapshotJournal(jd), now }).archived.length).toBe(1);
    appendFileSync(join(ad, "v1.jsonl"), "tampered");
    const badVerify = verifyArchive(ad);
    expect(badVerify.ok).toBe(false);
    expect(badVerify.failures.some((f) => f.code === "HASH_MISMATCH")).toBe(true);
    const badRestore = restoreArchive({ archiveDir: ad, journalDir: jd, sid: "v1" });
    expect(badRestore.ok).toBe(false);
    if (!badRestore.ok) expect(badRestore.code).toBe("RESTORE_HASH_MISMATCH");

    // 不存在的 sid
    const missing = restoreArchive({ archiveDir: ad, journalDir: jd, sid: "nope" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("ARCHIVE_NOT_FOUND");
  });
});

/** 分片夹具:global 里给 s-old 一条跨会话事件(创建会话槽);s-old 的会话域文件已归档;s-new 正常。 */
function seedArchivedJournal(jd: string): void {
  mkdirSync(join(jd, "sessions"), { recursive: true });
  writeFileSync(
    join(jd, "global.jsonl"),
    [
      JSON.stringify({ seq: 1, time: 1000, sessionId: "s-old", kind: "task.start", payload: { taskId: "t1" } }),
      JSON.stringify({ seq: 4, time: 1004, sessionId: "s-new", kind: "task.start", payload: { taskId: "t2" } }),
    ].join("\n") + "\n",
    "utf-8",
  );
  writeFileSync(
    join(jd, "sessions", "s-old.jsonl"),
    [
      JSON.stringify({ seq: 2, time: 1002, sessionId: "s-old", kind: "message.user", payload: { text: "old-marker-1" } }),
      JSON.stringify({ seq: 3, time: 1003, sessionId: "s-old", kind: "message.assistant", payload: { text: "old-marker-2" } }),
    ].join("\n") + "\n",
    "utf-8",
  );
  writeFileSync(
    join(jd, "sessions", "s-new.jsonl"),
    JSON.stringify({ seq: 5, time: 1005, sessionId: "s-new", kind: "message.user", payload: { text: "new-marker" } }) + "\n",
    "utf-8",
  );
  const ad = join(jd, "sessions-archive");
  mkdirSync(ad, { recursive: true });
  renameSync(join(jd, "sessions", "s-old.jsonl"), join(ad, "s-old.jsonl"));
}

function hasMarker(events: Array<{ payload?: unknown }>, marker: string): boolean {
  return events.some((e) => JSON.stringify(e.payload ?? {}).includes(marker));
}

describe("FileJournal archive 冷读", () => {
  it("archive-fallback / no-scan-archive: boot loadChunked 不扫归档,readSession(sid) 从 archiveDir 读回", async () => {
    const jd = join(tmpRoot(), "journals");
    seedArchivedJournal(jd);
    const j = new FileJournal(join(jd, "gateway.jsonl"), {
      sharded: true,
      deferLoad: true,
      archiveDir: join(jd, "sessions-archive"),
    });
    await j.loadChunked();

    // 冷启动只扫 sessions/:归档文件的会话域事件不在常驻集里
    const all = j.readAll();
    expect(hasMarker(all, "old-marker")).toBe(false);
    expect(hasMarker(all, "new-marker")).toBe(true);

    // 契约 a(boot 期归档冷读默认关闭,9b54efd1):enable 之前 readSession 只回内存部分——
    // global 里那条跨会话事件(task.start),归档里的会话域事件不可见。
    expect(j.readSession("s-old").map((e) => e.seq)).toEqual([1]);

    // 契约 b(显式开启后才兜底):生产侧由 main.ts 在 createGatewayApp 之后调 enableArchiveReads()。
    // enable 后 readSession 走归档兜底:seq 与归档前一致(global 的 1 + 归档文件的 2/3)。
    j.enableArchiveReads();
    const restored = j.readSession("s-old");
    expect(restored.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(hasMarker(restored, "old-marker-1")).toBe(true);
    expect(hasMarker(restored, "old-marker-2")).toBe(true);
    // 正常会话不受影响
    expect(j.readSession("s-new").map((e) => e.seq)).toEqual([4, 5]);
  });

  // 本用例不测试「归档冷读默认可用」语义(那是上一条的两段式契约):它测归档副本缺失 /
  // 未配 archiveDir 的降级路径,故刻意不调 enableArchiveReads(),期望值仍是内存的部分 [1]。
  it("archive-fallback-missing / no-archive-arg: 无归档副本或不传 archiveDir 时只返回内存部分且不抛", () => {
    const jd = join(tmpRoot(), "journals");
    seedArchivedJournal(jd);

    const emptyArchive = new FileJournal(join(jd, "gateway.jsonl"), {
      sharded: true,
      archiveDir: join(jd, "empty-archive"),
    });
    expect(emptyArchive.readSession("s-old").map((e) => e.seq)).toEqual([1]);

    const noArchive = new FileJournal(join(jd, "gateway.jsonl"), { sharded: true });
    expect(() => noArchive.readSession("s-old")).not.toThrow();
    expect(noArchive.readSession("s-old").map((e) => e.seq)).toEqual([1]);
  });

  it("wiring: main.ts 与 app.ts 两处 FileJournal 装配都传 archiveDir", () => {
    const mainSrc = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf-8");
    expect(mainSrc).toMatch(/archiveDir:\s*journalArchiveDirOf\(journalDirAbs\)/);
    const appSrc = readFileSync(fileURLToPath(new URL("../src/app.ts", import.meta.url)), "utf-8");
    expect(appSrc).toMatch(/archiveDir:\s*journalArchiveDirOf\(opts\.journalDir\)/);
  });
});

describe("journal-maintenance CLI", () => {
  const cli = fileURLToPath(new URL("../../../scripts/journal-maintenance.mts", import.meta.url));
  // 运行环境 node 可能是 v20(无默认类型剥离):用仓内 tsx 跑同一个 .mts 入口(生产验收用 Node≥22.18 裸跑亦可)。
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");
  function runCli(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [tsxCli, cli, ...args], { cwd, encoding: "utf-8" });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("cli: --plan --json 只读;活 writer --apply 退出 2;--force 放行;--verify/--restore 成功;未知参数退出 3", () => {
    const root = tmpRoot();
    const jd = journalOf(root);
    const now = Date.now();
    writeSessionFile(jd, "old1", 100, now - 30 * DAY);
    writeSessionFile(jd, "old2", 200, now - 20 * DAY);
    const before = readdirSync(join(jd, "sessions")).sort();

    // plan:只读(前后 sessions 目录逐字不变)
    const planned = runCli(["--journal", jd, "--plan", "--json", "--keep-newest", "0"], root);
    expect(planned.status).toBe(0);
    const planJson = JSON.parse(planned.stdout) as { mode: string; candidateCount: number; totalBytes: number; holders: { live: boolean } };
    expect(planJson.mode).toBe("plan");
    expect(planJson.candidateCount).toBe(2);
    expect(planJson.totalBytes).toBe(300);
    expect(readdirSync(join(jd, "sessions")).sort()).toEqual(before);

    // 活 writer(本进程 pid)→ 拒跑 exit 2,零改动
    writeFileSync(join(root, ".genie", "gateway.pid"), String(process.pid), "utf-8");
    const blocked = runCli(["--journal", jd, "--apply", "--json", "--keep-newest", "0"], root);
    expect(blocked.status).toBe(2);
    expect(blocked.stdout).toContain("STORAGE_BUSY_HOLDERS");
    expect(readdirSync(join(jd, "sessions")).sort()).toEqual(before);

    // --force 放行
    const forced = runCli(["--journal", jd, "--apply", "--json", "--force", "--keep-newest", "0"], root);
    expect(forced.status).toBe(0);
    expect((JSON.parse(forced.stdout) as { archived: unknown[] }).archived.length).toBe(2);
    expect(readdirSync(join(jd, "sessions"))).toEqual([]);

    // verify / restore 子命令
    const verified = runCli(["--journal", jd, "--verify", "--json"], root);
    expect(verified.status).toBe(0);
    expect((JSON.parse(verified.stdout) as { ok: boolean }).ok).toBe(true);
    const restored = runCli(["--journal", jd, "--restore", "old1", "--json"], root);
    expect(restored.status).toBe(0);
    expect(existsSync(join(jd, "sessions", "old1.jsonl"))).toBe(true);

    // 参数错误 → 3
    const unknown = runCli(["--bogus"], root);
    expect(unknown.status).toBe(3);
  }, 60_000);
});
