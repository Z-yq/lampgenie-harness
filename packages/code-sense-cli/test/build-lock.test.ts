/**
 * step-086 同根单飞锁测试:①申请/释放/owner 校验;②跨进程 busy(礼貌拒绝信息带持有者);
 * ③等待-复用(持有者释放后等到);④stale 接管(持有者死);⑤活 worker 礼让窗;
 * ⑥buildIndexWithReuse 接线(忙→IndexBusyError;闲→正常构建,二次构建全复用零重扫)。
 * 全部产物落 mkdtemp,不污染真实仓。
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireBuildLock, releaseBuildLock, buildLockPath, workerPidPath, readLockState,
  pidMatches, readWorkerPid,
} from "../src/build-lock.js";
import { buildIndexWithReuse, IndexBusyError } from "../src/incremental.js";

const tmps: string[] = [];
function mkroot(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `cslock-${tag}-`));
  tmps.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
}, 60_000);

function writeLockFile(root: string, payload: unknown): void {
  const p = buildLockPath(root);
  mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
  writeFileSync(p, JSON.stringify(payload), { flag: "wx" });
}

/** 死进程 pid(取一个已退出子进程的 pid;pid 复用窗口内断言安全——starttime 校验双保险)。 */
function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["-e", ""]);
    c.on("exit", () => resolve(c.pid!));
  });
}

/** 子进程持锁 ms 后释放退出(协议直写,与 build-lock 同格式)。 */
function spawnHolder(root: string, holdMs: number): ChildProcess {
  const lockPath = buildLockPath(root);
  const script = `
    const fs = require("node:fs");
    const p = ${JSON.stringify(lockPath)};
    fs.mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
    try {
      fs.writeFileSync(p, JSON.stringify({ pid: process.pid, holder: "cli", startedAt: new Date().toISOString(), owner: "child" }), { flag: "wx" });
      console.log("locked");
    } catch { console.log("busy"); process.exit(1); }
    setTimeout(() => { fs.rmSync(p, { force: true }); console.log("released"); }, ${holdMs});
  `;
  return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
}

/** 等子进程报「locked」(锁已被子进程持有,消掉建锁竞态)。 */
function waitLocked(c: ChildProcess): Promise<void> {
  return new Promise((res) => {
    let buf = "";
    c.stdout!.on("data", (d) => {
      buf += d;
      if (buf.includes("locked")) res();
    });
  });
}

describe("step-086 同根单飞锁", () => {
  it("①申请→释放→锁文件消失;重复释放无害", async () => {
    const root = mkroot("basic");
    const l = await acquireBuildLock(root, { holder: "cli", waitMs: 0 });
    expect(l.ok).toBe(true);
    expect(existsSync(buildLockPath(root))).toBe(true);
    expect(readLockState(root).state).toBe("live");
    releaseBuildLock(root);
    expect(existsSync(buildLockPath(root))).toBe(false);
    expect(readLockState(root).state).toBe("missing");
    releaseBuildLock(root); // 无害
  });

  it("②跨进程 busy:持有者活→waitMs 内礼貌拒绝,信息带 pid", async () => {
    const root = mkroot("busy");
    const child = spawnHolder(root, 5_000);
    await new Promise<void>((res) => {
      let buf = "";
      child.stdout!.on("data", (d) => {
        buf += d;
        if (buf.includes("locked")) res();
      });
    });
    const t0 = Date.now();
    const l = await acquireBuildLock(root, { holder: "cli", waitMs: 600 });
    expect(l.ok).toBe(false);
    if (!l.ok) {
      expect(l.reason).toBe("busy");
      expect(l.info?.pid).toBe(child.pid);
      expect(l.waited).toBeGreaterThanOrEqual(500);
    }
    expect(Date.now() - t0).toBeLessThan(3_000);
    child.kill("SIGKILL");
  });

  it("③等待-复用:持有者 1.2s 后释放,等待方能拿到锁", async () => {
    const root = mkroot("wait");
    const child = spawnHolder(root, 1_200);
    await waitLocked(child);
    const l = await acquireBuildLock(root, { holder: "cli", waitMs: 15_000 });
    expect(l.ok).toBe(true);
    expect(l.waited).toBeGreaterThanOrEqual(1_000);
    releaseBuildLock(root);
  });

  it("④stale 接管:持有者被 kill -9(锁残留)→ 无活 worker 时快速接管", async () => {
    const root = mkroot("stale");
    const child = spawnHolder(root, 60_000);
    await new Promise<void>((res) => {
      let buf = "";
      child.stdout!.on("data", (d) => {
        buf += d;
        if (buf.includes("locked")) res();
      });
    });
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300)); // 等 exit 落定(pid 死)
    const st = readLockState(root);
    expect(st.state).toBe("stale");
    const l = await acquireBuildLock(root, { holder: "gateway", waitMs: 5_000, orphanGraceMs: 0 });
    expect(l.ok).toBe(true);
    releaseBuildLock(root);
  });

  it("⑤活 worker 礼让:stale 锁+活 worker.pid → 等满礼让窗再接管;worker 死→快速通过", async () => {
    const root = mkroot("grace");
    await deadPid(); // 预热一次,降低 pid 复用撞锁持有者的概率
    const holderPid = await deadPid();
    writeLockFile(root, { pid: holderPid, holder: "gateway", startedAt: new Date().toISOString(), owner: "dead" });
    expect(readLockState(root).state).toBe("stale");
    // 活 worker = 本测试进程(pid 活,starttime 同 /proc)
    writeFileSync(workerPidPath(root), JSON.stringify({ pid: process.pid, startTime: null }));
    expect(readWorkerPid(root)!.pid).toBe(process.pid);
    expect(pidMatches(process.pid, null)).toBe(true);
    const t0 = Date.now();
    const l = await acquireBuildLock(root, { holder: "cli", waitMs: 10_000, orphanGraceMs: 900 });
    expect(l.ok).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(850); // 礼让窗生效
    releaseBuildLock(root);
    unlinkSync(workerPidPath(root));

    // 对照:worker.pid 是死 pid → 礼让零等待
    const root2 = mkroot("grace2");
    const deadWorker = await deadPid();
    writeLockFile(root2, { pid: await deadPid(), holder: "gateway", owner: "dead" });
    writeFileSync(workerPidPath(root2), JSON.stringify({ pid: deadWorker }));
    const t1 = Date.now();
    const l2 = await acquireBuildLock(root2, { holder: "cli", waitMs: 10_000, orphanGraceMs: 8_000 });
    expect(l2.ok).toBe(true);
    expect(Date.now() - t1).toBeLessThan(3_000);
    releaseBuildLock(root2);
  });

  it("⑥buildIndexWithReuse 接线:忙→IndexBusyError(带持有者);闲→构建;再构建零重扫", { timeout: 120_000 }, async () => {
    const root = mkroot("build");
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "a.ts"), "export function a1(x: number): number { return x + 1; }\nexport function aMain(): number { return a1(1); }\n");
    const child = spawnHolder(root, 6_000);
    await new Promise<void>((res) => {
      let buf = "";
      child.stdout!.on("data", (d) => {
        buf += d;
        if (buf.includes("locked")) res();
      });
    });
    const err = await buildIndexWithReuse(root, { lockWaitMs: 400, heapBudget: "off" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IndexBusyError);
    expect((err as Error).message).toContain("已有索引在飞");
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    // 持有者死了但锁残留:接管语义照常(礼让窗内无活 worker)
    const out = await buildIndexWithReuse(root, { heapBudget: "off" });
    expect(out.mode).toBe("full");
    expect(out.scanned).toEqual(["src/a.ts"]);
    // 第二次:指纹全命中 → scanned 0(「并发/重复请求只产生一次实际解析」的复用半边)
    const out2 = await buildIndexWithReuse(root, { heapBudget: "off" });
    expect(out2.mode).toBe("incremental");
    expect(out2.scanned).toEqual([]);
  });
});
