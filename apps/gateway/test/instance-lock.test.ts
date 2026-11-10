/**
 * 单实例锁:双写 journal → seq 重复 → 重启丢事件 → LLM 400 的结构性防线。
 * 2026-10-25 加固回归:僵尸/PID 复用/旧格式锁/损坏锁/锁面不可写都必须「能自动回收或诚实拒绝」,
 * 不能让一个死 pid 的锁把新实例永久挡在门外(实测事故)。
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock, parseProcStat, parseTasklistCsv, pidAlive, releaseInstanceLock } from "../src/instance-lock.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "il-"));
}

/** 起一个「活的非网关进程」,用于模拟 PID 复用(老格式锁没有 starttime 指纹)。 */
async function spawnSleeper(extraArgs: string[] = []): Promise<{ pid: number; kill: () => Promise<void> }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", ...extraArgs], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  const pid = child.pid!;
  const kill = async () => {
    try { child.kill("SIGKILL"); } catch { /* 已退 */ }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      setTimeout(resolve, 2000);
    });
  };
  return { pid, kill };
}

describe("instance-lock", () => {
  it("首获成功;同 pid 再获 = 拒绝(带持有者 pid)", () => {
    const dir = tmpDir();
    try {
      const p = join(dir, "gateway.lock");
      expect(acquireInstanceLock(p, process.pid).ok).toBe(true);
      const second = acquireInstanceLock(p, process.pid);
      expect(second.ok).toBe(false);
      expect(second.holderPid).toBe(process.pid);
      expect(second.reason).toBe("held");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("陈旧锁(持有者 pid 已死)自动回收(旧格式纯文本)", () => {
    const dir = tmpDir();
    try {
      const p = join(dir, "gateway.lock");
      writeFileSync(p, "999999999", "utf-8"); // 不可能存在的 pid
      const r = acquireInstanceLock(p, process.pid);
      expect(r.ok).toBe(true);
      expect(r.reclaimedPid).toBe(999999999);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("锁定文件损坏/空 → 按陈旧回收(不因一次断电永久拒绝启动)", () => {
    const dir = tmpDir();
    try {
      const p = join(dir, "gateway.lock");
      writeFileSync(p, "{not-json", "utf-8");
      expect(acquireInstanceLock(p, process.pid).ok).toBe(true);
      writeFileSync(p, "", "utf-8");
      expect(acquireInstanceLock(p, process.pid).ok).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("PID 被复用(starttime 指纹不同)→ 回收,不再永久占用", () => {
    const dir = tmpDir();
    try {
      const p = join(dir, "gateway.lock");
      expect(acquireInstanceLock(p, process.pid).ok).toBe(true);
      const info = JSON.parse(readFileSync(p, "utf-8")) as { pid: number; start?: string };
      expect(info.start, "Linux 下应写入 starttime 指纹").toBeTruthy();
      // 模拟「同一个 pid,但已经是另一个进程」:启动时刻不同。
      writeFileSync(p, JSON.stringify({ ...info, start: String(Number(info.start) + 1) }), "utf-8");
      const r = acquireInstanceLock(p, process.pid);
      expect(r.ok).toBe(true);
      expect(r.reclaimedPid).toBe(process.pid);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("旧格式锁 + 活着的非网关进程(PID 复用)→ 回收", async () => {
    const dir = tmpDir();
    const sleeper = await spawnSleeper();
    try {
      const p = join(dir, "gateway.lock");
      writeFileSync(p, String(sleeper.pid), "utf-8");
      const r = acquireInstanceLock(p, process.pid);
      expect(r.ok).toBe(true);
      expect(r.reclaimedPid).toBe(sleeper.pid);
    } finally {
      await sleeper.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("旧格式锁 + 活着的网关进程(cmdline 命中)→ 仍拒绝(不误回收活锁)", async () => {
    const dir = tmpDir();
    // 用 gateway.mjs 作为额外 argv 让 /proc/<pid>/cmdline 命中网关特征(不真的启动网关)。
    const sleeper = await spawnSleeper(["gateway.mjs"]);
    try {
      const p = join(dir, "gateway.lock");
      writeFileSync(p, String(sleeper.pid), "utf-8");
      const r = acquireInstanceLock(p, process.pid);
      expect(r.ok).toBe(false);
      expect(r.holderPid).toBe(sleeper.pid);
      expect(r.reason).toBe("held");
    } finally {
      await sleeper.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("锁路径被目录占住:不抛异常,返回可诊断失败(不炸启动流程)", () => {
    const dir = tmpDir();
    try {
      const p = join(dir, "gateway.lock");
      mkdirSync(p);
      const r = acquireInstanceLock(p, process.pid);
      expect(r.ok).toBe(false);
      expect(["stale-unremovable", "lock-unreadable"]).toContain(r.reason);
      expect(r.detail).toBeTruthy();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("释放后他人可获;非持有者释放不误删", () => {
    const dir = tmpDir();
    try {
      const p = join(dir, "gateway.lock");
      expect(acquireInstanceLock(p, 12345).ok).toBe(true);
      releaseInstanceLock(p, 54321); // 非持有者
      expect(existsSync(p)).toBe(true);
      releaseInstanceLock(p, 12345);
      expect(existsSync(p)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("parseProcStat:comm 含空格/括号时仍取到 state 与 starttime(第 22 字段)", () => {
    // 字段:pid (comm) state ... 第 22 字段 = starttime;')' 后第 20 个 token(下标 19)。
    const rest = ["S", ...Array.from({ length: 18 }, (_, i) => String(i + 1)), "424242"].join(" ");
    expect(parseProcStat(`777 (node (x) worker) ${rest}`)).toEqual({ state: "S", start: "424242" });
    expect(parseProcStat("")).toBeUndefined();
    expect(parseProcStat("777 (no-close")).toBeUndefined();
  });

  // Windows 实测(2026-11-08 新用户模拟):死 pid 18576 的 process.kill(pid,0) 抛 EPERM 而不是
  // ESRCH,旧逻辑直接当活锁 → 陈旧锁永久挡住启动。EPERM 必须用 tasklist 复核。
  it("pidAlive:Windows EPERM + tasklist 说不存在 → 判死", () => {
    const eperm = (): never => {
      const err = new Error("kill EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    };
    expect(pidAlive(18576, { kill: eperm, windowsLookup: () => ({ exists: false }) })).toBe(false);
    expect(pidAlive(18576, { kill: eperm, windowsLookup: () => ({ exists: true, image: "LampGenie.exe" }) })).toBe(true);
    // 探测失败 = 未知:保守当活,绝不误删他人锁。
    expect(pidAlive(18576, { kill: eperm, windowsLookup: () => undefined })).toBe(true);
    // ESRCH 仍然明确判死,不依赖探针。
    const esrch = (): never => {
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    };
    expect(pidAlive(1, { kill: esrch, windowsLookup: () => ({ exists: true }) })).toBe(false);
  });

  it("parseTasklistCsv:命中/未命中 + 中文系统乱码提示行不影响解析", () => {
    const out = [
      "\u4fe1\u606f: \u6ca1\u6709\u8fd0\u884c\u7684\u4efb\u52a1\u8ddf\u8fd9\u4e2a\u6807\u51c6\u5339\u914d\u3002",
      '"LampGenie.exe","18576","Console","1","123,456 K"',
      "",
    ].join("\r\n");
    expect(parseTasklistCsv(out, 18576)).toEqual({ exists: true, image: "LampGenie.exe" });
    expect(parseTasklistCsv(out, 99999)).toEqual({ exists: false });
    expect(parseTasklistCsv("", 1)).toEqual({ exists: false });
  });
});
