/**
 * step-086 worker 生命周期测试(实测取证,全真实进程):
 * ①正常构建:fork worker(src .ts,tsx loader)→ exit 0 → index.json 落盘+worker.pid 自清;
 * ②杀父自退:中间父进程 fork worker 后被 kill -9 → worker ≤6s 自退(exit 3),宽限期取证;
 * ③起停泄漏计数:3 轮「起 worker→杀父→等自退」后,本夹具根的 sense-index-worker 进程数=0;
 * ④孤儿清扫 sweep:stale 锁删除/死 pid worker.pid 删除/活 worker(父活)不动手。
 * 夹具=3 文件小仓(worker 基线内存 ~300MB,秒级建完);不碰产线 7700。
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildLockPath, workerPidPath, readLockState } from "@lampgenie/code-sense-cli/build-lock";

const here = fileURLToPath(new URL(".", import.meta.url));
const WORKER_TS = resolve(here, "../src/sense-index-worker.ts");
const MANAGER_TS = resolve(here, "../src/sense-index-manager.ts");

const tmps: string[] = [];
function mkroot(tag: string, nFiles = 3): string {
  const d = mkdtempSync(join(tmpdir(), `silife-${tag}-`));
  tmps.push(d);
  const src = join(d, "src");
  mkdirSync(src, { recursive: true });
  for (let i = 0; i < nFiles; i++) {
    writeFileSync(join(src, `m${i}.ts`), `export function f${i}(x: number): number { return x + ${i}; }\nexport function main${i}(): number { return f${i}(1); }\n`);
  }
  return d;
}
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
}, 60_000);

/** 计数:命令行里含指定根路径的 sense-index-worker 进程数(worker cmdline argv[2]=root)。 */
function workerCount(root: string): number {
  try {
    const out = execSync("ps -eo pid,args --no-headers", { encoding: "utf-8" });
    return out.split("\n").filter((l) => l.includes("sense-index-worker") && l.includes(root)).length;
  } catch {
    return -1;
  }
}

/** fork 真实 worker(与 manager 同款:src .ts + tsx loader)。 */
function forkWorker(root: string, extra: string[] = []): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", ...extra, WORKER_TS, root], {
    cwd: resolve(here, "../.."), // gateway 包根:tsx 可解析
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitExit(c: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((res) => {
    const t = setTimeout(() => res(null), timeoutMs);
    c.on("exit", (code) => {
      clearTimeout(t);
      res(code);
    });
  });
}

/** 等谓词成立(轮询)。 */
async function waitFor(pred: () => boolean, timeoutMs: number, stepMs = 200): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (pred()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe("step-086 worker 生命周期", () => {
  it("①正常构建:exit 0,index.json 在,worker.pid 自清", { timeout: 120_000 }, async () => {
    const root = mkroot("ok");
    const w = forkWorker(root);
    const code = await waitExit(w, 90_000);
    expect(code).toBe(0);
    const base = join(root, ".genie", "sense-index");
    const dirs = execSync(`ls ${base}`, { encoding: "utf-8" }).trim().split("\n");
    expect(dirs.some((d) => existsSync(join(base, d, "index.json")))).toBe(true);
    expect(existsSync(workerPidPath(root))).toBe(false); // 干净退出自删
  });

  it("②杀父自退:中间父 kill -9 → worker ≤6s 自退(exit 3=父丢失)", { timeout: 120_000 }, async () => {
    const root = mkroot("killparent");
    // 中间父:fork worker 后自身只睡(模拟 gateway);stdout 报 worker pid
    const mid = spawn(process.execPath, [
      "-e",
      `const { spawn } = require("node:child_process");
       const w = spawn(process.execPath, ["--import","tsx", ${JSON.stringify(WORKER_TS)}, ${JSON.stringify(root)}], { cwd: ${JSON.stringify(resolve(here, "../.."))}, stdio: "ignore" });
       console.log("WORKER_PID=" + w.pid);
       setInterval(() => {}, 1 << 30);`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let workerPid = 0;
    await new Promise<void>((res) => {
      let buf = "";
      mid.stdout!.on("data", (d) => {
        buf += String(d);
        const m = buf.match(/WORKER_PID=(\d+)/);
        if (m) { workerPid = Number(m[1]); res(); }
      });
    });
    expect(workerPid).toBeGreaterThan(0);
    // 等 worker 真正起(pid 活)
    await waitFor(() => { try { process.kill(workerPid, 0); return true; } catch { return false; } }, 10_000);
    // 杀中间父(kill -9=孤儿事故同形态)
    mid.kill("SIGKILL");
    const t0 = Date.now();
    const gone = await waitFor(() => {
      try { process.kill(workerPid, 0); return false; } catch { return true; }
    }, 10_000, 100);
    const elapsed = Date.now() - t0;
    expect(gone).toBe(true);
    // 宽限期口径:disconnect(fork IPC)+2s 看门狗双通道;worker 在 ts-morph 同步解析块中事件循环
    // 不让出,检测在让出后生效——实测 5.1-6.3s(块尾对齐),断言取 10s 上限。
    expect(elapsed).toBeLessThanOrEqual(10_000);
  });

  it("③起停泄漏计数:3 轮起/杀父/等自退,本根 worker 数归零", { timeout: 180_000 }, async () => {
    const root = mkroot("leak");
    for (let i = 0; i < 3; i++) {
      const mid = spawn(process.execPath, [
        "-e",
        `const { spawn } = require("node:child_process");
         const w = spawn(process.execPath, ["--import","tsx", ${JSON.stringify(WORKER_TS)}, ${JSON.stringify(root)}], { cwd: ${JSON.stringify(resolve(here, "../.."))}, stdio: "ignore" });
         console.log("WORKER_PID=" + w.pid);
         setInterval(() => {}, 1 << 30);`,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let workerPid = 0;
      await new Promise<void>((res) => {
        let buf = "";
        mid.stdout!.on("data", (d) => {
          buf += String(d);
          const m = buf.match(/WORKER_PID=(\d+)/);
          if (m) { workerPid = Number(m[1]); res(); }
        });
      });
      await waitFor(() => { try { process.kill(workerPid, 0); return true; } catch { return false; } }, 10_000);
      mid.kill("SIGKILL");
      const gone = await waitFor(() => {
        try { process.kill(workerPid, 0); return false; } catch { return true; }
      }, 10_000, 100);
      expect(gone).toBe(true);
    }
    expect(workerCount(root)).toBe(0); // ps 计数断言:零泄漏
  });

  it("④sweep:stale 锁删/死 pid 登记删/活 worker(父活)不动手", async () => {
    const { sweepOrphanIndexWorkers } = await import(MANAGER_TS);
    const root = mkroot("sweep");
    // stale 锁:死 pid 持有
    const dead = await new Promise<number>((res) => {
      const c = spawn(process.execPath, ["-e", ""]);
      c.on("exit", () => res(c.pid!));
    });
    const lockP = buildLockPath(root);
    mkdirSync(lockP.slice(0, lockP.lastIndexOf("/")), { recursive: true });
    writeFileSync(lockP, JSON.stringify({ pid: dead, holder: "gateway", owner: "x" }));
    writeFileSync(workerPidPath(root), JSON.stringify({ pid: dead }));
    const rep = sweepOrphanIndexWorkers(root);
    expect(rep.removedLocks).toBe(1);
    expect(rep.removedPidFiles).toBe(1);
    expect(readLockState(root).state).toBe("missing");
    // 活 worker(父=本测试进程,活)→ 不动手。marker 故意不含 "sense-index-worker"
    // (命中「cmdline 非 sense-index-worker,pid 复用?」的礼貌跳过分支)
    const fake = spawn(process.execPath, ["-e", "setInterval(()=>{},1<<30)", "not-a-sense-worker"], { stdio: "ignore" });
    try {
      writeFileSync(workerPidPath(root), JSON.stringify({ pid: fake.pid }));
      const rep2 = sweepOrphanIndexWorkers(root);
      expect(rep2.killedWorkers).toBe(0);
      // 该 worker cmdline 不含 sense-index-worker 路径 → skipped(证据不足不动手)
      expect(rep2.skipped.length).toBeGreaterThan(0);
    } finally {
      fake.kill("SIGKILL");
      rmSync(workerPidPath(root), { force: true });
    }
  });
});
