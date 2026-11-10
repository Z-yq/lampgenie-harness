/**
 * PID 文件锁(契约移植自 teamai-cli src/update.ts 195-420,MIT)。
 * 裁契约:fse→node:fs/promises;logger→窄接口;锁路径由调用方传入。
 * 保留全部安全性质:原子创建(硬链优先/O_EXCL 回退)、legacy 裸 PID 兼容、
 * EPERM 判活、reclaim sentinel 串行化、owner 双校验释放。
 */
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, readFile, writeFile, link, rename, rm } from "node:fs/promises";

export interface LockLogger {
  warn(msg: string): void;
}

interface LockPayload {
  pid: number;
  startedAt: string;
  owner: string;
}

/** 本进程持有的锁(resolved path → owner token),防误删他人锁。 */
const heldLockOwners = new Map<string, string>();

function parseLockContent(content: string): { pid: number; owner?: string } | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    const json: unknown = JSON.parse(trimmed);
    if (typeof json === "number") return Number.isInteger(json) ? { pid: json } : null;
    const parsed = json as Partial<LockPayload>;
    if (typeof parsed.pid === "number" && !isNaN(parsed.pid)) {
      return { pid: parsed.pid, owner: typeof parsed.owner === "string" ? parsed.owner : undefined };
    }
    return null;
  } catch {
    const pid = parseInt(trimmed, 10);
    return isNaN(pid) ? null : { pid };
  }
}

/** 纯读:live(活进程持有)/ stale(持有者可证明已死)/ missing。 */
async function lockState(resolved: string, log: LockLogger): Promise<"live" | "stale" | "missing"> {
  let content: string;
  try {
    content = await readFile(resolved, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    log.warn(`${resolved} 不可读(${code});视为持有中。`);
    return "live";
  }
  const parsed = parseLockContent(content);
  if (!parsed) {
    log.warn(`${resolved} 无持有者信息;视为持有中。`);
    return "live";
  }
  try {
    process.kill(parsed.pid, 0);
    return "live";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" ? "live" : "stale";
  }
}

async function exclusiveCreate(target: string, payload: string): Promise<boolean> {
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, payload);
  try {
    await link(tmp, target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    return exclusiveCreateInPlace(target, payload);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

async function exclusiveCreateInPlace(target: string, payload: string): Promise<boolean> {
  try {
    await writeFile(target, payload, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

async function createOrInspect(
  resolved: string, payload: string, log: LockLogger): Promise<"acquired" | "live" | "stale"> {
  if (await exclusiveCreate(resolved, payload)) return "acquired";
  const state = await lockState(resolved, log);
  if (state !== "missing") return state;
  return (await exclusiveCreate(resolved, payload)) ? "acquired" : "live";
}

async function removeIfOwner(target: string, owner: string): Promise<void> {
  try {
    const content = await readFile(target, "utf-8").catch(() => null);
    if (content !== null) {
      const parsed = parseLockContent(content);
      if (parsed?.owner && parsed.owner !== owner) return;
    }
    await rm(target, { force: true });
  } catch {
    // best effort
  }
}

/** reclaim 哨兵:串行化 stale 锁接管,多进程竞争只有一个赢家。 */
async function acquireReclaimSentinel(sentinel: string, owner: string, log: LockLogger): Promise<boolean> {
  const payload = JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), owner,
  } satisfies LockPayload);
  if (await exclusiveCreate(sentinel, payload)) return true;
  if ((await lockState(sentinel, log)) !== "stale") return false;
  try {
    await rename(sentinel, `${sentinel}.reclaim-${owner}`);
  } catch {
    return false;
  }
  await rm(`${sentinel}.reclaim-${owner}`, { force: true }).catch(() => {});
  return exclusiveCreate(sentinel, payload);
}

export interface AcquireLockOptions {
  /** 预览模式:只答「能不能拿到」,不创建。 */
  dryRun?: boolean;
  logger?: LockLogger;
}

/** 试取锁;拿到返回 true,被活进程持有返回 false。 */
export async function acquireLock(lockPath: string, options: AcquireLockOptions = {}): Promise<boolean> {
  const log = options.logger ?? console;
  if (options.dryRun) return (await lockState(lockPath, log)) !== "live";
  const owner = randomUUID();
  const payload = JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), owner,
  } satisfies LockPayload);

  try {
    await mkdir(dirname(lockPath), { recursive: true });
  } catch {
    return false;
  }

  const first = await createOrInspect(lockPath, payload, log);
  if (first === "acquired") {
    heldLockOwners.set(lockPath, owner);
    return true;
  }
  if (first === "live") return false;

  const sentinel = `${lockPath}.sentinel`;
  if (!(await acquireReclaimSentinel(sentinel, owner, log))) return false;
  try {
    // 拿到哨兵后重新评估:锁可能已消失/被他人复活。
    const second = await createOrInspect(lockPath, payload, log);
    if (second === "acquired") {
      heldLockOwners.set(lockPath, owner);
      return true;
    }
    if (second === "live") return false;
    // 仍 stale:temp 文件 + rename 原子覆盖(锁不空窗,新竞争者插不进来)。
    const tmp = `${lockPath}.new-${owner}`;
    await writeFile(tmp, payload);
    await rename(tmp, lockPath);
    heldLockOwners.set(lockPath, owner);
    return true;
  } catch {
    return false;
  } finally {
    await removeIfOwner(sentinel, owner);
  }
}

/** 释放锁;只删本进程持有的(磁盘 owner 与内存 token 双校验)。 */
export async function releaseLock(lockPath: string): Promise<void> {
  const owner = heldLockOwners.get(lockPath);
  if (!owner) return;
  heldLockOwners.delete(lockPath);
  await removeIfOwner(lockPath, owner);
}

/** 便捷:持锁执行。 */
export async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (!(await acquireLock(lockPath))) return undefined;
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath);
  }
}
