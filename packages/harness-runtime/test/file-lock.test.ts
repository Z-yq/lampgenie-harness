import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, withLock } from "../src/locks/file-lock";

describe("PID 文件锁", () => {
  it("同进程重入被拒(锁已被自己持有)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-lock-"));
    const lp = join(dir, "x.lock");
    expect(await acquireLock(lp)).toBe(true);
    expect(await acquireLock(lp)).toBe(false); // 同进程活着 → live → 拒
    await releaseLock(lp);
    expect(await acquireLock(lp)).toBe(true); // 释放后可再拿
    await releaseLock(lp);
    rmSync(dir, { recursive: true, force: true });
  });

  it("stale 锁(死 PID)被回收", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-lock-"));
    const lp = join(dir, "x.lock");
    // 写一个死 PID 的锁(999999 几乎不可能存在)
    writeFileSync(lp, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString(), owner: "dead" }));
    expect(await acquireLock(lp)).toBe(true); // 回收成功
    await releaseLock(lp);
    rmSync(dir, { recursive: true, force: true });
  });

  it("withLock 互斥执行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-lock-"));
    const lp = join(dir, "x.lock");
    let inside = 0;
    const r1 = await withLock(lp, async () => {
      inside++;
      const nested = await withLock(lp, async () => { inside += 100; });
      expect(nested).toBeUndefined(); // 嵌套拿不到
      return "ok";
    });
    expect(r1).toBe("ok");
    expect(inside).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
