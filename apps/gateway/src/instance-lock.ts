/**
 * 网关单实例锁(2026-10-21 LLM 400 根因修复;2026-10-25 陈旧锁回收加固)。
 *
 * 背景:同一 journal 目录被两个网关进程同时写 = 两个独立的 seq 计数器各写一份 seq,
 * 文件里出现「同 seq 两事件」。重启时按 seq 去重会丢掉较新事件(历史缺 assistant 消息,
 * 只剩 tool 结果 → OpenAI 400「role 'tool' must be a response to a preceding message with
 * 'tool_calls'」)。单实例锁是这条链的结构性防线:第二个实例直接拒绝启动。
 *
 * 语义:O_EXCL 原子创建;已存在→判持有者是否还活着:
 *   - 活着(同一次进程启动)→ 拒绝,带持有者 pid;
 *   - 已死 / 僵尸(Z)/ PID 被复用 → 视为陈旧锁,unlink 后重试一次;
 *   - 锁文件损坏/读不到 pid → 同样按陈旧回收(否则一次断电就永久拒绝启动)。
 *
 * 2026-10-25 加固点(实测「进程已死仍报占用」):
 *   ① /proc/<pid>/stat 的 starttime 指纹:锁里记下创建者的进程启动时刻,
 *      pid 存在但 starttime 不同 = PID 被复用,不是原持有者 → 回收;
 *   ② 僵尸进程 kill(pid,0) 仍成功,但 state=Z 已经死了 → 判死;
 *   ③ kill 的 EPERM=活(无权限但进程在)/ ESRCH=死,其它 errno 用 /proc 是否存在兜底
 *      (不把「未知错误」误当活锁,也不再让 EACCES/只读盘把进程炸掉);
 *   ④ unlink 失败(只读盘/权限)不再伪装成「他人在用」:返回 reason=stale-unremovable,
 *      由入口打印可操作提示;
 *   ⑤ 兼容旧格式(纯 pid 文本):没有 starttime 时用 /proc/<pid>/cmdline 识别明显不是网关的
 *      pid 复用(老锁也能自动回收,不必手删)。
 *
 * 进程退出(含 uncaught 保活路径的 exit)释放;kill -9 留下的陈旧锁由下一次启动回收。
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface InstanceLockResult {
  ok: boolean;
  /** 拒绝时=当前持有者 pid(读不到则 undefined)。 */
  holderPid?: number;
  /** 回收的陈旧锁 pid(观测用)。 */
  reclaimedPid?: number;
  /** 失败原因(可操作文案的分派键;ok=true 时不带)。 */
  reason?: "held" | "stale-unremovable" | "lock-unreadable" | "race";
  /** 失败细节(路径/errno/处置建议;只用于日志,不含密钥)。 */
  detail?: string;
}

interface LockFileInfo {
  pid?: number;
  /** /proc/<pid>/stat 的 starttime(clock ticks since boot);旧格式锁没有。 */
  start?: string;
  /** 损坏/读不到(→ 按陈旧回收)。 */
  corrupted: boolean;
  raw?: string;
}

/** /proc/<pid>/stat 的关键字段(comm 里可能有空格/括号,必须从最后一个 ')' 后切)。 */
export interface ProcStat {
  /** R/S/D/Z/X…;Z=僵尸已退出未回收。 */
  state: string;
  /** 进程启动时刻(第 22 字段,clock ticks since boot)。 */
  start: string;
}

/**
 * 解析 /proc/<pid>/stat。
 * 格式:pid (comm) state ppid ... starttime(第 22 字段)...
 * comm 可含空格与 ')' → 以最后一个 ')' 为界;其后第 1 个 token 是 state(总第 3 字段),
 * 总第 22 字段 = 其后第 20 个 token(下标 19)。
 */
export function parseProcStat(text: string): ProcStat | undefined {
  const close = text.lastIndexOf(")");
  if (close < 0) return undefined;
  const rest = text.slice(close + 1).trim().split(/\s+/);
  const state = rest[0];
  const start = rest[19];
  if (!state || !start) return undefined;
  return { state, start };
}

function readProcStat(pid: number): ProcStat | undefined {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf-8"));
  } catch {
    return undefined;
  }
}

/** 本进程(或被查 pid)的启动指纹;非 Linux(/proc 缺失)返回 undefined。 */
export function procStartTick(pid = process.pid): string | undefined {
  return readProcStat(pid)?.start;
}

export function parseTasklistCsv(out: string, pid: number): { exists: boolean; image?: string } {
  for (const line of String(out).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('"')) continue;
    const cols = (t.match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1));
    if (cols.length < 2) continue;
    if (Number(cols[1]) === pid) return { exists: true, ...(cols[0] ? { image: cols[0] } : {}) };
  }
  return { exists: false };
}

/**
 * Windows 进程复核。process.kill(pid, 0) 在 Windows 上对「已死但 pid 曾经存在」的进程
 * 可能抛 EPERM 而不是 ESRCH(2026-11-08 新用户模拟实测:陈旧锁 pid=18576 已死仍 EPERM),
 * 而 Windows 没有 /proc,旧实现会一路保守当成活锁 → 死 pid 的锁永久挡住启动。
 * tasklist 用系统 API 给出「存在/不存在 + 镜像名」;探测失败返回 undefined(仍保守当活)。
 */
function lookupWindowsProcess(pid: number): { exists: boolean; image?: string } | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      windowsHide: true,
      timeout: 5000,
      encoding: "utf8",
    });
    if (r.error || r.status !== 0) return undefined;
    // 中文系统的 tasklist 输出是 OEM 代码页,但 CSV 的引号/镜像名/PID 都是 ASCII;
    // utf8 解码只会让本地化提示行乱码,不影响 `"image","pid"` 行解析。
    return parseTasklistCsv(String(r.stdout ?? ""), pid);
  } catch {
    return undefined;
  }
}

/** 网关镜像名特征:打包态 LampGenie.exe(Electron as node)/dev 态 electron.exe。 */
function looksLikeGatewayImage(image: string | undefined): boolean {
  if (!image) return false;
  return /genie|electron/i.test(image);
}

/** 供单测注入的探针(默认走真实 kill + Windows tasklist)。 */
export interface PidAliveDeps {
  kill?: (pid: number, signal: number) => void;
  windowsLookup?: (pid: number) => { exists: boolean; image?: string } | undefined;
}

/**
 * 进程是否还活着。
 * - kill(pid,0) 成功但 state=Z/X = 僵尸(等父进程回收),业务上已死;
 * - EPERM:Linux=存在但无权限(仍算活着);Windows=可能是死 pid(实测),用 tasklist 复核;
 * - ESRCH=不存在;
 * - 其它 errno 用 /proc/<pid> 是否存在兜底,无 /proc 时保守视为活(避免误删活锁)。
 */
export function pidAlive(pid: number, deps: PidAliveDeps = {}): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    (deps.kill ?? process.kill)(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      // Windows 上 EPERM 不是「确实活着」的充分证据:tasklist 说不存在就是死。
      const info = (deps.windowsLookup ?? lookupWindowsProcess)(pid);
      return info ? info.exists : true;
    }
    if (code === "ESRCH") return false;
    // EINVAL/ENOSYS/未知:有 /proc 以目录存在为准;无 /proc(Windows/裁剪系统)保守当活。
    return existsSync(`/proc/${pid}`) ? true : !existsSync("/proc");
  }
  const st = readProcStat(pid);
  if (st && (st.state === "Z" || st.state === "X" || st.state === "x")) return false;
  return true;
}

function readProcCmdline(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ").trim();
  } catch {
    return undefined;
  }
}

/** 网关进程的命令行特征(dist/gateway.mjs、tsx src/main.ts、桌面打包 resources/gateway/gateway.mjs)。 */
function looksLikeGatewayCmdline(cmdline: string): boolean {
  return /gateway\.mjs|gateway[\\/]src[\\/]main\.ts|genie-gateway/i.test(cmdline);
}

/** 读锁文件:兼容 JSON(pid+start)与旧格式(纯 pid 文本)。 */
function readLock(lockPath: string): LockFileInfo {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8").trim();
  } catch {
    return { corrupted: true };
  }
  if (!raw) return { corrupted: true, raw };
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw) as { pid?: unknown; start?: unknown };
      const pid = Number(obj.pid);
      if (!Number.isFinite(pid) || pid <= 0) return { corrupted: true, raw };
      const start = typeof obj.start === "string" || typeof obj.start === "number" ? String(obj.start) : undefined;
      return { pid, corrupted: false, raw, ...(start ? { start } : {}) };
    } catch {
      return { corrupted: true, raw };
    }
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? { pid: n, corrupted: false, raw } : { corrupted: true, raw };
}

/** 持有者状态:alive=真持有者;dead=进程没了;reused=pid 还在但已不是原进程。 */
type HolderStatus = "alive" | "dead" | "reused";

function holderStatus(pid: number | undefined, start: string | undefined): HolderStatus {
  if (pid === undefined) return "dead"; // 损坏锁:按陈旧回收(否则一次断电永久拒绝)
  if (!pidAlive(pid)) return "dead";
  if (pid === process.pid) {
    // 自己持有:锁里的 starttime 与当前进程不同 = 上一个同 pid 进程留下的(pid 复用)。
    const self = procStartTick(pid);
    return start && self && start !== self ? "reused" : "alive";
  }
  if (start) {
    const st = readProcStat(pid);
    // /proc 不可读时保守当活;可读且 starttime 不同 = 原进程已退出、pid 被复用。
    return st && st.start !== start ? "reused" : "alive";
  }
  // 旧格式锁(纯 pid):用 cmdline 识别明显不是网关的 pid 复用;读不到时
  // Windows 再用 tasklist 镜像名兜底(锁持有者必须是网关镜像),Linux 保守当活。
  const cmd = readProcCmdline(pid);
  if (cmd === undefined || cmd === "") {
    const info = lookupWindowsProcess(pid);
    if (info && info.exists && info.image && !looksLikeGatewayImage(info.image)) return "reused";
    return "alive";
  }
  return looksLikeGatewayCmdline(cmd) ? "alive" : "reused";
}

function tryUnlink(path: string): boolean {
  try {
    unlinkSync(path);
  } catch {
    /* ENOENT=他者已回收;EPERM/EBUSY=还在,下面用 existsSync 判 */
  }
  return !existsSync(path);
}

/** 申请单实例锁(幂等失败即返回,不等待)。 */
export function acquireInstanceLock(lockPath: string, pid = process.pid): InstanceLockResult {
  mkdirSync(dirname(lockPath), { recursive: true });
  let reclaimedPid: number | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      let start: string | undefined;
      try {
        start = procStartTick(pid);
        // JSON 容忍未来加字段;starttime 是「同一进程」的精确指纹(跨 PID 复用)。
        writeFileSync(fd, JSON.stringify({ pid, ...(start ? { start } : {}), at: Date.now() }), "utf-8");
      } finally {
        closeSync(fd);
      }
      // 竞态复核:两个实例同时回收同一个陈旧锁时,后者的 unlink 可能删掉前者刚建的锁。
      // 写完后立刻按内容复核——不再是我们的 pid/starttime = 本次没拿到锁,拒绝而不是双写。
      const verify = readLock(lockPath);
      if (verify.pid !== pid || (start !== undefined && verify.start !== undefined && verify.start !== start)) {
        return {
          ok: false,
          ...(verify.pid !== undefined ? { holderPid: verify.pid } : {}),
          reason: "race",
          detail: "锁在创建瞬间被另一实例替换(并发启动竞态),本次拒绝启动",
        };
      }
      return reclaimedPid !== undefined ? { ok: true, reclaimedPid } : { ok: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // EACCES/EPERM/EROFS/EISDIR(锁路径被建成目录)…:锁面不可用,不抛异常炸启动,
        // 由入口决定拒绝并给出可操作提示。
        return {
          ok: false,
          reason: "lock-unreadable",
          detail: `无法创建锁文件 ${lockPath}(${code ?? "unknown"};检查目录权限/是否被目录占用)`,
        };
      }
      const holder = readLock(lockPath);
      if (holderStatus(holder.pid, holder.start) === "alive") {
        return { ok: false, holderPid: holder.pid, reason: "held" };
      }
      // 陈旧/复用/损坏:回收后重试一次。
      if (holder.pid !== undefined) reclaimedPid = holder.pid;
      if (!tryUnlink(lockPath)) {
        // 删除失败:再读一次,若已被别人换成活锁 → 如实报占用;否则是权限/只读盘。
        const again = readLock(lockPath);
        if (again.pid !== undefined && holderStatus(again.pid, again.start) === "alive") {
          return { ok: false, holderPid: again.pid, reason: "held" };
        }
        return {
          ok: false,
          ...(holder.pid !== undefined ? { holderPid: holder.pid } : {}),
          reason: "stale-unremovable",
          detail: `陈旧锁(持有者 pid=${holder.pid ?? "?"} 已死或 pid 被复用)无法删除;检查 ${lockPath} 权限后手动删除`,
        };
      }
      if (attempt === 1) return { ok: false, ...(holder.pid !== undefined ? { holderPid: holder.pid } : {}), reason: "race" };
    }
  }
  return { ok: false, ...(reclaimedPid !== undefined ? { reclaimedPid } : {}), reason: "race" };
}

/** 释放(仅当锁属于本进程时;避免误删他人的锁)。 */
export function releaseInstanceLock(lockPath: string, pid = process.pid): void {
  if (!existsSync(lockPath)) return;
  if (readLock(lockPath).pid !== pid) return;
  try { unlinkSync(lockPath); } catch { /* 已删 */ }
}
