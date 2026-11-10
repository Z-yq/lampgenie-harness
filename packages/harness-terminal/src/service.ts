/**
 * owner-scoped 终端会话注册表(step-122)。
 *
 * 服务拥有:会话 id、owner 授权、上限/空闲回收、审计出口、进程退出兜底清理。
 * 会话本身(进程/缓冲)由 TerminalSession 拥有。
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { TerminalSession } from "./session.js";
import {
  TerminalError,
  readPositiveIntEnv,
  type TerminalAuditEvent,
  type TerminalCloseResult,
  type TerminalOpenInput,
  type TerminalReadInput,
  type TerminalReadResult,
  type TerminalSendInput,
  type TerminalSendResult,
  type TerminalServiceOptions,
  type TerminalSessionInfo,
  type TerminalShellKind,
} from "./types.js";

const NAME_RE = /^[A-Za-z0-9._-]{1,40}$/;
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_MAX_PER_OWNER = 4;
const DEFAULT_BUFFER_KB = 200;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_REAPER_MS = 30_000;
const DEFAULT_INIT_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_GRACE_MS = 1_500;
/** 已关闭会话台账上限(防长命 service 泄漏)。 */
const CLOSED_OWNER_LIMIT = 200;

/** 自愈说明前缀:旧 id 被回收后自动重绑到同一 owner 的存活会话时前置一行。 */
function redirectNote(newId: string): string {
  return `[终端会话已回收,已自动切换到同一 owner 的现存会话 ${newId};后续请用新 id]\n`;
}

interface PendingOwner {
  count: number;
  names: Set<string>;
}

const liveServices = new Set<TerminalSessionService>();
let exitHookInstalled = false;

function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // 进程退出兜底:detached 子进程不会随父进程自动退出,同步 SIGKILL 进程组。
  process.once("exit", () => {
    for (const service of liveServices) service.killAllNow();
  });
}

function normalizeShellMode(raw: string | undefined): {
  shellKind: TerminalShellKind;
  fallbackToPipe: boolean;
} {
  const mode = raw === "pty" || raw === "pipe" || raw === "auto" ? raw : "auto";
  if (mode === "pty") return { shellKind: "pty", fallbackToPipe: false };
  if (mode === "pipe") return { shellKind: "pipe", fallbackToPipe: false };
  return process.platform === "linux"
    ? { shellKind: "pty", fallbackToPipe: true }
    : { shellKind: "pipe", fallbackToPipe: false };
}

function normalizeCwd(input: string): string {
  if (!input || !isAbsolute(input)) {
    throw new TerminalError(`cwd 必须是绝对路径: ${String(input)}`, "INVALID_CWD");
  }
  const resolved = resolve(input);
  try {
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new TerminalError(`cwd 不存在或不是目录: ${resolved}`, "INVALID_CWD");
    }
    return realpathSync(resolved);
  } catch (err) {
    if (err instanceof TerminalError) throw err;
    throw new TerminalError(`cwd 不可用: ${resolved} (${String(err)})`, "INVALID_CWD");
  }
}

export class TerminalSessionService {
  private readonly sessions = new Map<string, TerminalSession>();
  /** owner → 最近使用的会话 id(open/成功 send/成功 read 时更新;close 指向它时删除)。 */
  private readonly lastByOwner = new Map<string, string>();
  /** 已关闭会话 id → owner(自愈判定「曾属该 owner」;LRU 上限 CLOSED_OWNER_LIMIT)。 */
  private readonly closedOwner = new Map<string, string>();
  private readonly pending = new Map<string, PendingOwner>();
  private pendingTotal = 0;
  private sequence = 0;
  private readonly reaper: NodeJS.Timeout | undefined;
  private readonly maxSessions: number;
  private readonly maxSessionsPerOwner: number;
  private readonly bufferBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly initTimeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly shellKind: TerminalShellKind;
  private readonly fallbackToPipe: boolean;
  private readonly auditSink: ((event: TerminalAuditEvent) => void) | undefined;
  private readonly now: () => number;
  private disposed = false;

  constructor(opts: TerminalServiceOptions = {}) {
    this.maxSessions = opts.maxSessions ?? readPositiveIntEnv("GENIE_TERMINAL_MAX_SESSIONS", DEFAULT_MAX_SESSIONS);
    this.maxSessionsPerOwner =
      opts.maxSessionsPerOwner ?? readPositiveIntEnv("GENIE_TERMINAL_MAX_PER_OWNER", DEFAULT_MAX_PER_OWNER);
    this.bufferBytes =
      opts.bufferBytes ?? readPositiveIntEnv("GENIE_TERMINAL_BUFFER_KB", DEFAULT_BUFFER_KB) * 1024;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? readPositiveIntEnv("GENIE_TERMINAL_IDLE_MS", DEFAULT_IDLE_MS);
    this.initTimeoutMs = opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.closeGraceMs = opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    const shell = normalizeShellMode(opts.shellMode ?? process.env.GENIE_TERMINAL_MODE);
    this.shellKind = shell.shellKind;
    this.fallbackToPipe = shell.fallbackToPipe;
    this.auditSink = opts.audit;
    this.now = opts.now ?? Date.now;
    const reaperInterval = opts.reaperIntervalMs ?? DEFAULT_REAPER_MS;
    if (reaperInterval > 0) {
      this.reaper = setInterval(() => {
        void this.reapIdle();
      }, reaperInterval);
      this.reaper.unref?.();
    }
    liveServices.add(this);
    ensureExitHook();
  }

  async open(owner: string, input: TerminalOpenInput): Promise<TerminalSessionInfo> {
    if (!owner || !owner.trim()) throw new TerminalError("owner 不能为空", "INVALID_OWNER");
    const name = input.name?.trim() || undefined;
    if (name && !NAME_RE.test(name)) {
      throw new TerminalError(`会话名非法(允许字母/数字/._-,1-40 字): ${name}`, "INVALID_INPUT");
    }
    const cwd = normalizeCwd(input.cwd);
    this.assertCapacity(owner, name);
    const reservation = this.reserve(owner, name);
    const id = `term_${Date.now().toString(36)}_${(++this.sequence).toString(36)}`;
    const session = new TerminalSession({
      id,
      owner,
      ...(name ? { name } : {}),
      cwd,
      ...(input.shellOverride ? { shellOverride: input.shellOverride } : {}),
      shellKind: this.shellKind,
      fallbackToPipe: this.fallbackToPipe,
      bufferBytes: this.bufferBytes,
      initTimeoutMs: this.initTimeoutMs,
      closeGraceMs: this.closeGraceMs,
      now: this.now,
    });
    try {
      await session.start();
    } catch (err) {
      await session.close("startup-failed").catch(() => undefined);
      this.emit("startup-failed", owner, {
        ...(name ? { name } : {}),
        cwd,
        reason: String(err instanceof Error ? err.message : err).slice(0, 300),
      });
      this.release(owner, reservation, name);
      throw err instanceof TerminalError
        ? err
        : new TerminalError(`终端启动失败: ${String(err)}`, "STARTUP_FAILED");
    }
    this.sessions.set(id, session);
    this.lastByOwner.set(owner, id);
    this.closedOwner.delete(id);
    this.release(owner, reservation, name);
    const info = session.info();
    this.emit("open", owner, {
      sessionId: id,
      ...(name ? { name } : {}),
      cwd,
      exitCode: null,
      reason: `shell=${info.shell} pid=${String(info.pid ?? "?")}`,
    });
    return info;
  }

  async send(owner: string, sessionId: string, input: TerminalSendInput): Promise<TerminalSendResult> {
    const target = this.getOwned(owner, sessionId);
    const session = target.session;
    try {
      const result = await session.send(input);
      this.lastByOwner.set(owner, session.id);
      this.emit("send", owner, {
        sessionId: session.id,
        cwd: session.cwd,
        command: String(input.command ?? "").slice(0, 2000),
        exitCode: result.exitCode,
        waitReason: result.waitReason,
        durationMs: result.durationMs,
      });
      if (target.redirectedFrom) {
        return { ...result, output: redirectNote(session.id) + result.output };
      }
      return result;
    } catch (err) {
      this.emit("send", owner, {
        sessionId: session.id,
        cwd: session.cwd,
        command: String(input.command ?? "").slice(0, 2000),
        reason: String(err instanceof Error ? err.message : err).slice(0, 300),
      });
      throw err;
    }
  }

  async read(owner: string, sessionId: string, input: TerminalReadInput = {}): Promise<TerminalReadResult> {
    const target = this.getOwned(owner, sessionId);
    const session = target.session;
    try {
      const result = await session.read(input);
      this.lastByOwner.set(owner, session.id);
      this.emit("read", owner, {
        sessionId: session.id,
        cwd: session.cwd,
        reason: `cursor=${result.cursor} bytes=${Buffer.byteLength(result.output, "utf8")}`,
      });
      if (target.redirectedFrom) {
        return { ...result, output: redirectNote(session.id) + result.output };
      }
      return result;
    } catch (err) {
      this.emit("read", owner, {
        sessionId: session.id,
        cwd: session.cwd,
        reason: String(err instanceof Error ? err.message : err).slice(0, 300),
      });
      throw err;
    }
  }

  async close(owner: string, sessionId: string, reason = "requested"): Promise<TerminalCloseResult> {
    const session = this.getOwned(owner, sessionId).session;
    const result = await session.close(reason);
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    // 台帐:该 id 从此「曾属该 owner」,用于自愈判定;lastByOwner 指向它时清掉。
    this.rememberClosed(sessionId, owner);
    if (this.lastByOwner.get(owner) === sessionId) this.lastByOwner.delete(owner);
    this.emit("close", owner, { sessionId, cwd: session.cwd, exitCode: result.exitCode, reason });
    return result;
  }

  list(owner: string): TerminalSessionInfo[] {
    if (!owner || !owner.trim()) throw new TerminalError("owner 不能为空", "INVALID_OWNER");
    return [...this.sessions.values()]
      .filter((session) => session.owner === owner)
      .sort((a, b) => a.info().createdAt - b.info().createdAt)
      .map((session) => session.info());
  }

  /** 空闲回收(定时器每 reaperIntervalMs 调用;测试可直接调用)。 */
  async reapIdle(now = this.now()): Promise<string[]> {
    const reaped: string[] = [];
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastActive < this.idleTimeoutMs) continue;
      try {
        await session.close("idle");
      } catch {
        /* 回收失败仍从注册表移除(进程已 kill) */
      }
      this.sessions.delete(session.id);
      this.rememberClosed(session.id, session.owner);
      if (this.lastByOwner.get(session.owner) === session.id) this.lastByOwner.delete(session.owner);
      this.emit("reap", session.owner, {
        sessionId: session.id,
        cwd: session.cwd,
        reason: `idle>${this.idleTimeoutMs}ms`,
      });
      reaped.push(session.id);
    }
    return reaped;
  }

  /** 关闭全部会话(dispose/进程退出兜底)。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reaper) clearInterval(this.reaper);
    liveServices.delete(this);
    await Promise.allSettled([...this.sessions.values()].map((session) => session.close("service-dispose")));
    this.sessions.clear();
  }

  /** 同步杀全部进程组(仅进程退出钩子;异步清理走 dispose)。 */
  killAllNow(): void {
    for (const session of this.sessions.values()) session.killNow();
    this.sessions.clear();
  }

  private getOwned(owner: string, sessionId: string): { session: TerminalSession; redirectedFrom?: string } {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.owner !== owner) {
        this.emit("denied", owner, {
          sessionId,
          reason: `owner mismatch (session owner=${session.owner})`,
        });
        throw new TerminalError("拒绝访问:该终端会话属于其它 owner", "FOREIGN_SESSION");
      }
      return { session };
    }
    // 自愈:会话已不在注册表,但曾属该 owner 且该 owner 现有存活会话 → 重绑。
    if (this.closedOwner.get(sessionId) === owner) {
      const alive = this.pickAliveForOwner(owner);
      if (alive) {
        this.emit("rebind", owner, {
          sessionId: alive.id,
          reason: `session ${sessionId} recycled; auto-rebind to ${alive.id}`,
        });
        return { session: alive, redirectedFrom: sessionId };
      }
      throw new TerminalError(
        `终端会话 ${sessionId} 已被回收,且当前无存活会话;请先 term.open 新建`,
        "NO_SESSION",
      );
    }
    throw new TerminalError(`终端会话不存在: ${sessionId}`, "NO_SESSION");
  }

  /** owner 现存存活会话:优先最近使用的那个,否则 owner 名下唯一的一个(多个时按创建时间取最早)。 */
  private pickAliveForOwner(owner: string): TerminalSession | undefined {
    const last = this.lastByOwner.get(owner);
    if (last) {
      const session = this.sessions.get(last);
      if (session && session.owner === owner) return session;
    }
    const owned = [...this.sessions.values()]
      .filter((session) => session.owner === owner)
      .sort((a, b) => a.info().createdAt - b.info().createdAt);
    return owned[0];
  }

  /** 记「已关闭会话 → owner」台账(LRU 上限 CLOSED_OWNER_LIMIT,防长命 service 泄漏)。 */
  private rememberClosed(sessionId: string, owner: string): void {
    this.closedOwner.delete(sessionId);
    this.closedOwner.set(sessionId, owner);
    while (this.closedOwner.size > CLOSED_OWNER_LIMIT) {
      const oldest = this.closedOwner.keys().next();
      if (oldest.done) break;
      this.closedOwner.delete(oldest.value);
    }
  }

  private assertCapacity(owner: string, name: string | undefined): void {
    if (this.sessions.size + this.pendingTotal >= this.maxSessions) {
      throw new TerminalError(
        `终端会话总数已达上限 ${this.maxSessions};先 close 不用的会话`,
        "LIMIT_EXCEEDED",
      );
    }
    const ownerSessions = [...this.sessions.values()].filter((session) => session.owner === owner);
    const pendingOwner = this.pending.get(owner);
    const ownerCount = ownerSessions.length + (pendingOwner?.count ?? 0);
    if (ownerCount >= this.maxSessionsPerOwner) {
      throw new TerminalError(
        `该会话的终端数已达上限 ${this.maxSessionsPerOwner};先 close 不用的会话`,
        "LIMIT_EXCEEDED",
      );
    }
    if (!name) return;
    if (ownerSessions.some((session) => session.name === name) || pendingOwner?.names.has(name)) {
      throw new TerminalError(`同名终端会话已存在: ${name}（owner 内命名唯一）`, "DUPLICATE_NAME");
    }
  }

  private reserve(owner: string, name: string | undefined): PendingOwner {
    let pending = this.pending.get(owner);
    if (!pending) {
      pending = { count: 0, names: new Set() };
      this.pending.set(owner, pending);
    }
    pending.count += 1;
    if (name) pending.names.add(name);
    this.pendingTotal += 1;
    return pending;
  }

  private release(owner: string, pending: PendingOwner, name: string | undefined): void {
    pending.count -= 1;
    if (name) pending.names.delete(name);
    this.pendingTotal = Math.max(0, this.pendingTotal - 1);
    if (pending.count <= 0 && pending.names.size === 0) this.pending.delete(owner);
  }

  private emit(
    action: TerminalAuditEvent["action"],
    owner: string,
    extra: Omit<TerminalAuditEvent, "type" | "action" | "owner" | "at">,
  ): void {
    if (!this.auditSink) return;
    try {
      this.auditSink({ type: "terminal.audit", action, owner, at: this.now(), ...extra });
    } catch {
      /* 审计失败不影响终端操作 */
    }
  }
}
