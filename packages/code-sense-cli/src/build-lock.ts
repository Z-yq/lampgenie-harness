/**
 * 同根索引单飞锁:同一索引根的并发索引请求合并为单飞。
 * 事故基线:3 个孤儿 sense-index-worker 并发重复索引同一仓根,各 ~1.3GB——
 * gateway 进程内有 building Map 去重,跨进程(多 gateway 实例/CLI 并存)零防护。
 * 设计:
 *  - 锁文件 = <root>/.genie/sense-index/<sha1(root)12>/build.lock(c2f.indexDir 同目录),
 *    payload = { pid, holder, host, root, startedAt, owner(uuid) }。
 *  - 原子创建:硬链优先(wx 回退;drvfs 上 link 可能不可用)。性质与 harness-runtime locks/file-lock
 * (teamai 契约组件)同源,本实现自包含(code-sense-cli 零 lampgenie-harness 运行时依赖红线)
 *    并特化:pid+starttime 双校验(防 pid 复用假活)、活 worker 礼让、等待-复用语义。
 *  - 持锁者崩溃 → pid 消失 → 下一个申请者 stale 接管(哨兵串行化,只一个赢家)。
 *  - worker.pid 文件:worker 启动自登记(build-lock 只读),接管前礼让活 worker 自退
 *    (新 worker 有父看门狗 ≤2s 自退;旧 dist worker 无看门狗,等 ORPHAN_GRACE_MS 后接管,
 *    竞窗收窄——根治待 gateway dist 重建)。
 *  - 进程内 refcount:同进程并发/嵌套申请不自我死锁(第二个申请共享同一把)。
 */
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdirSync, readFileSync, rmSync, writeFileSync, closeSync, openSync, linkSync, unlinkSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { indexDir } from "@lampgenie/code-sense/callgraph/c2f";

/** 锁持有者形态(补 session-worker:sense-index-manager 在任务 worker 进程内也实例化,
 *  等待方排障需要如实区分——此前硬编码 "gateway" 让「pid 是 worker」的锁信息自相矛盾)。 */
export type LockHolder = "gateway" | "cli" | "session-worker";

export interface BuildLockPayload {
  pid: number;
  holder: LockHolder;
  host: string;
  root: string;
  startedAt: string;
  owner: string;
}

export interface LockInfo {
  pid: number;
  holder: string;
  host?: string;
  root?: string;
  startedAt?: string;
  alive: boolean;
}

/** 锁等待轮询间隔。 */
const POLL_MS = 500;
/** 活 worker 礼让窗:接管 stale 锁前等既有 worker 自退的上限。 */
export function orphanGraceMs(): number {
  const n = Number.parseInt(process.env.GENIE_SENSE_ORPHAN_GRACE_MS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 10_000;
}

/** 本进程持有的锁:resolved path → owner token(owner 双校验释放用)。
 * 无 refcount:同进程第二个并发申请走正常 busy-wait 路径串行化(真正的互斥;
 * 本仓无嵌套申请场景——buildIndexWithReuse/ensureIndex 均平铺调用,不存在自锁死锁面)。 */
const held = new Map<string, string>();

/** 锁路径:<indexDir(root)>/build.lock。 */
export function buildLockPath(root: string): string {
  return indexDir(root) + "/build.lock";
}

/** worker 自登记文件:<indexDir(root)>/worker.pid(worker 写/删,本模块读写判定)。 */
export function workerPidPath(root: string): string {
  return indexDir(root) + "/worker.pid";
}

// ---- pid 存活判定(pid + starttime 双校验,防 pid 复用) ----

function readStartTime(pid: number): string | null {
  // Linux /proc/<pid>/stat 字段 22 = starttime(clock ticks since boot)。comm 可能含空格/括号,
  // 从最后一个 ')' 之后数:field1=state, field2=ppid, ... field20=starttime(自 pid 起第 22 字段)。
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ");
    // afterComm[0]=state(原 field3)…… starttime=原 field22 → afterComm 下标 22-3=19
    const st = afterComm[19];
    return st ? st.trim() : null;
  } catch {
    return null; // 非 Linux / 进程已死
  }
}

/** 活 worker 判定:pid 活且(有 /proc 时)starttime 与登记一致。 */
export function pidMatches(pid: number, startTime: string | null | undefined): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // EPERM=存在但无权信号 → 视为活
  }
  if (startTime == null) return true; // 无 starttime 登记 → pid 存活即认(退化档)
  const now = readStartTime(pid);
  return now === null ? false : now === startTime;
}

/** 宽松解析形态(盘上数据可能来自旧版本/被截断,字段逐个验证)。 */
interface ParsedLock {
  pid: number;
  holder: string;
  host?: string;
  root?: string;
  startedAt?: string;
  owner: string;
  startTime?: string | null;
}

function parsePayload(content: string): ParsedLock | null {
  const t = content.trim();
  if (!t) return null;
  try {
    const j = JSON.parse(t) as Partial<BuildLockPayload> & { startTime?: string | null };
    if (typeof j.pid === "number" && Number.isInteger(j.pid)) {
      return {
        pid: j.pid,
        holder: typeof j.holder === "string" ? j.holder : "unknown",
        ...(typeof j.host === "string" ? { host: j.host } : {}),
        ...(typeof j.root === "string" ? { root: j.root } : {}),
        ...(typeof j.startedAt === "string" ? { startedAt: j.startedAt } : {}),
        owner: typeof j.owner === "string" ? j.owner : "",
        startTime: typeof j.startTime === "string" ? j.startTime : null,
      };
    }
    return null;
  } catch {
    return null; // 半截行/脏数据:礼貌视为持有中,不冒进接管
  }
}

/** 纯读:锁现状(missing=无锁;live=活持有者;stale=持有者可证已死)。 */
export function readLockState(root: string): { state: "missing" | "live" | "stale"; info: LockInfo | null } {
  const p = buildLockPath(root);
  let content: string;
  try {
    content = readFileSync(p, "utf-8");
  } catch {
    return { state: "missing", info: null };
  }
  const parsed = parsePayload(content);
  if (!parsed) return { state: "live", info: { pid: -1, holder: "corrupt", alive: true } }; // 不可解析:保守视为持有中
  const alive = pidMatches(parsed.pid, parsed.startTime);
  const info: LockInfo = {
    pid: parsed.pid,
    holder: parsed.holder,
    ...(parsed.host ? { host: parsed.host } : {}),
    ...(parsed.root ? { root: parsed.root } : {}),
    ...(parsed.startedAt ? { startedAt: parsed.startedAt } : {}),
    alive,
  };
  return { state: alive ? "live" : "stale", info };
}

/** 读锁(礼貌检测/拒绝消息/doctor/sweep 用)。 */
export function readLock(root: string): LockInfo | null {
  return readLockState(root).info;
}

function exclusiveCreate(target: string, payload: string, startTime: string | null): boolean {
  // 硬链优先(原子),wx 直写回退(drvfs/跨设备 link 失败场景)。
  const tmp = `${target}.${randomUUID()}.tmp`;
  const full = JSON.stringify({ ...JSON.parse(payload), startTime });
  try {
    const fd = openSync(tmp, "wx");
    try {
      writeFileSync(fd, full);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, target);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      try {
        const fd2 = openSync(target, "wx");
        try {
          writeFileSync(fd2, full);
        } finally {
          closeSync(fd2);
        }
        return true;
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e2;
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp 清理 best effort */
    }
  }
}

/** 覆盖写(stale 接管的最终步,temp+rename 原子,锁不空窗)。 */
function overwriteLock(target: string, payload: BuildLockPayload, startTime: string | null): void {
  const tmp = `${target}.${randomUUID()}.new`;
  const full = JSON.stringify({ ...payload, startTime });
  writeFileSync(tmp, full);
  try {
    rmSync(target, { force: true });
  } catch {
    /* rename 会覆盖,先删只是防御 */
  }
  renameSync(tmp, target);
}

/** 活 worker 登记(接管礼让的判定源;worker 进程写,这里只读)。 */
export function readWorkerPid(root: string): { pid: number; startTime: string | null } | null {
  try {
    const raw = readFileSync(workerPidPath(root), "utf-8").trim();
    const j = JSON.parse(raw) as { pid: number; startTime?: string | null };
    if (typeof j.pid === "number") return { pid: j.pid, startTime: typeof j.startTime === "string" ? j.startTime : null };
    return null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface AcquireOptions {
  holder: LockHolder;
  /** 锁忙时等待释放的上限;0=不等(立即 busy)。缺省 GENIE_SENSE_INDEX_LOCK_WAIT_MS 或 240s。 */
  waitMs?: number;
  /** 接管 stale 锁前等活 worker 自退的上限(孤儿礼让)。缺省 orphanGraceMs()。 */
  orphanGraceMs?: number;
  /** 等待期回调(观测/日志)。 */
  onWait?: (info: LockInfo) => void;
}

export type AcquireResult =
  | { ok: true; path: string; release(): void; waited: number }
  | { ok: false; reason: "busy"; info: LockInfo | null; waited: number };

/** 申请同根索引锁;拿到返回 release(),忙则等待(waitMs 内让位)或礼貌拒绝。 */
export async function acquireBuildLock(root: string, opts: AcquireOptions): Promise<AcquireResult> {
  const p = buildLockPath(root);
  try {
    mkdirSync(dirname(p), { recursive: true });
  } catch {
    /* 目录建不了:下一步 exclusiveCreate 会真报错 */
  }
  const t0 = Date.now();
  const waitMs = opts.waitMs ?? waitDefaultMs();
  const graceMs = opts.orphanGraceMs ?? orphanGraceMs();
  const owner = randomUUID();
  const payload: BuildLockPayload = {
    pid: process.pid,
    holder: opts.holder,
    host: hostname(),
    root,
    startedAt: new Date().toISOString(),
    owner,
  };

  for (;;) {
    // ① 原子申请(同进程重复申请不加特殊通道——走 busy-wait 串行化,保证互斥语义)
    if (exclusiveCreate(p, JSON.stringify(payload), readStartTime(process.pid))) {
      held.set(p, owner);
      return { ok: true, path: p, waited: Date.now() - t0, release: () => releaseBuildLock(root) };
    }
    // ③ 被持有:判定 live/stale
    const { state, info } = readLockState(root);
    if (state === "live") {
      if (Date.now() - t0 >= waitMs) return { ok: false, reason: "busy", info, waited: Date.now() - t0 };
      opts.onWait?.(info!);
      await sleep(POLL_MS);
      continue;
    }
    // ④ stale:礼让可能仍在跑的 worker(父亡自退 ≤2s;旧 dist worker 跑完自清)。
    // 无活 worker 登记时直接落到接管(不空转)。
    if (graceMs > 0) {
      const w = readWorkerPid(root);
      if (w && pidMatches(w.pid, w.startTime)) {
        const gave = await yieldToLiveWorker(root, graceMs);
        if (gave === "worker-finished") continue; // worker 退了:重试申请(锁/登记可能已被清)
      }
    }
    // ⑤ 哨兵串行化 stale 接管(多申请者只有一个赢家)
    const sentinel = `${p}.sentinel`;
    let sentinelOwner: string | null = null;
    try {
      exclusiveCreateSentinel(sentinel, owner);
      sentinelOwner = owner;
    } catch {
      const st = sentinelState(sentinel, owner);
      if (st !== "stale") {
        // 他人正在接管:回到等待循环
        if (Date.now() - t0 >= waitMs) return { ok: false, reason: "busy", info, waited: Date.now() - t0 };
        await sleep(POLL_MS);
        continue;
      }
      // 哨兵持有者已死:抢删后重建
      try {
        rmSync(sentinel, { force: true });
      } catch {
        /* 删不掉:下轮再试 */
      }
      try {
        exclusiveCreateSentinel(sentinel, owner);
        sentinelOwner = owner;
      } catch {
        if (Date.now() - t0 >= waitMs) return { ok: false, reason: "busy", info, waited: Date.now() - t0 };
        await sleep(POLL_MS);
        continue;
      }
    }
    try {
      // 拿到哨兵后重评估:锁可能已释放/被复活
      const re = readLockState(root);
      if (re.state === "missing" || re.state === "stale") {
        overwriteLock(p, payload, readStartTime(process.pid));
        held.set(p, owner);
        return { ok: true, path: p, waited: Date.now() - t0, release: () => releaseBuildLock(root) };
      }
      if (Date.now() - t0 >= waitMs) return { ok: false, reason: "busy", info: re.info, waited: Date.now() - t0 };
      await sleep(POLL_MS);
    } finally {
      if (sentinelOwner === owner) {
        try {
          rmSync(sentinel, { force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }
}

function exclusiveCreateSentinel(sentinel: string, owner: string): void {
  const tmp = `${sentinel}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, owner, startedAt: new Date().toISOString() }));
  try {
    linkSync(tmp, sentinel);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw e;
    writeFileSync(sentinel, JSON.stringify({ pid: process.pid, owner, startedAt: new Date().toISOString() }), { flag: "wx" });
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
  }
}

function sentinelState(sentinel: string, selfOwner: string): "live" | "stale" {
  try {
    const j = JSON.parse(readFileSync(sentinel, "utf-8")) as { pid: number; owner: string };
    if (j.owner === selfOwner) return "live"; // 自己的哨兵(异常重入):不算 stale
    return pidMatches(j.pid, null) ? "live" : "stale";
  } catch {
    return "stale"; // 读不了=视为 stale 可抢
  }
}

/** 等活 worker 自退(调用前已确认 worker 活着)。返回 worker-finished=已退;timeout=礼让窗用尽。 */
async function yieldToLiveWorker(root: string, graceMs: number): Promise<"worker-finished" | "timeout"> {
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 >= graceMs) return "timeout";
    await sleep(POLL_MS);
    const w = readWorkerPid(root);
    if (!w || !pidMatches(w.pid, w.startTime)) return "worker-finished";
  }
}

function waitDefaultMs(): number {
  const n = Number.parseInt(process.env.GENIE_SENSE_INDEX_LOCK_WAIT_MS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 240_000;
}

/** 释放锁(owner 双校验,只删自己持有的)。 */
export function releaseBuildLock(root: string): void {
  const p = buildLockPath(root);
  const owner = held.get(p);
  if (!owner) return;
  held.delete(p);
  try {
    const j = parsePayload(readFileSync(p, "utf-8"));
    if (j && j.owner && j.owner !== owner) return; // 已被他人接管:不动
  } catch {
    /* 读不了(已消失):无事可做 */
  }
  try {
    rmSync(p, { force: true });
  } catch {
    /* best effort */
  }
}

/** 供测试:本进程当前持锁数。 */
export function heldLockCountForTest(): number {
  return held.size;
}
