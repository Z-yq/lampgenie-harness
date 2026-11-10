/**
 * 持久终端会话(step-122)公共契约。
 *
 * 会话是进程内的:shell 进程/输出缓冲不落盘;跨工具调用的状态(cwd/env/变量/后台进程)
 * 由同一个 shell 进程保持。owner 是精确的会话键(tool 绑定 task.sessionId),不是可猜测的名字。
 */

/** 终端实现形态:pty=`script` 伪 TTY(Linux);pipe=Node stdio 管道(通用回退)。 */
export type TerminalShellKind = "pty" | "pipe";

/** send 返回原因。session-exit 只表示顶层 shell 退出,不表示任意前台子进程退出。 */
export type TerminalWaitReason = "completed" | "timeout" | "session-exit" | "no-wait";

export type TerminalSessionStatus = "running" | "exited";

export interface TerminalSessionInfo {
  id: string;
  name?: string;
  /** 精确 owner(tool 侧=task.sessionId)。 */
  owner: string;
  cwd: string;
  shell: TerminalShellKind;
  pid?: number;
  createdAt: number;
  lastActiveAt: number;
  status: TerminalSessionStatus;
  exitCode: number | null;
  /** 环形缓冲当前占用字节数。 */
  bufferedBytes: number;
  /** 缓冲末端游标(字符偏移,单调递增;传给 read 可做增量读)。 */
  cursor: number;
}

export interface TerminalOpenInput {
  cwd: string;
  name?: string;
  /**
   * 2026-10-26:shell 覆盖(远程项目终端=经 SSH 开远端 shell,对齐 ZCode 远端 workspace 终端语义)。
   * 提供时替代默认 bash/PTY 启动命令;env 并入子进程环境(如 sshpass 的 SSHPASS)。
   */
  shellOverride?: { command: string; args: string[]; env?: Record<string, string> };
}

export interface TerminalSendInput {
  command: string;
  /** 缺省 30s,上限 600s。 */
  timeoutMs?: number;
  /** false=写完立即返回(交互式程序/长驻前台进程用);缺省 true=等命令结束 marker。 */
  wait?: boolean;
}

export interface TerminalSendResult {
  sessionId: string;
  output: string;
  /** 已消费到的缓冲游标(下一次 read 缺省从此处继续)。 */
  cursor: number;
  exitCode: number | null;
  waitReason: TerminalWaitReason;
  durationMs: number;
  /** true=起点输出已被环形缓冲淘汰(只返回现有部分)。 */
  truncated: boolean;
}

export interface TerminalReadInput {
  /** 起始游标;缺省=上次已消费位置。 */
  cursor?: number;
  /** 短等新输出(毫秒,上限 5000)。 */
  waitMs?: number;
  /** 单次返回字符上限;缺省 100_000。 */
  maxChars?: number;
}

export interface TerminalReadResult {
  sessionId: string;
  output: string;
  cursor: number;
  truncated: boolean;
  status: TerminalSessionStatus;
  exitCode: number | null;
}

export interface TerminalCloseResult {
  sessionId: string;
  closed: boolean;
  exitCode: number | null;
}

/** 审计事件(落 journal 的 payload;命令原文不特判,只记录)。 */
export interface TerminalAuditEvent {
  type: "terminal.audit";
  action: "open" | "send" | "read" | "close" | "reap" | "denied" | "rebind" | "startup-failed";
  owner: string;
  sessionId?: string;
  name?: string;
  cwd?: string;
  command?: string;
  exitCode?: number | null;
  waitReason?: TerminalWaitReason;
  durationMs?: number;
  reason?: string;
  at: number;
}

export type TerminalAuditSink = (event: TerminalAuditEvent) => void;

/** 服务级错误码(工具层转成可读 JSON)。 */
export type TerminalErrorCode =
  | "INVALID_OWNER"
  | "NO_SESSION"
  | "FOREIGN_SESSION"
  | "LIMIT_EXCEEDED"
  | "DUPLICATE_NAME"
  | "INVALID_CWD"
  | "INVALID_INPUT"
  | "STARTUP_FAILED"
  | "SESSION_CLOSED";

export class TerminalError extends Error {
  constructor(
    message: string,
    readonly code: TerminalErrorCode,
  ) {
    super(message);
    this.name = "TerminalError";
  }
}

export interface TerminalServiceOptions {
  /** 全局会话上限(缺省 env GENIE_TERMINAL_MAX_SESSIONS / 8)。 */
  maxSessions?: number;
  /** 单 owner 会话上限(缺省 env GENIE_TERMINAL_MAX_PER_OWNER / 4)。 */
  maxSessionsPerOwner?: number;
  /** 每会话环形缓冲字节上限(缺省 env GENIE_TERMINAL_BUFFER_KB / 200KB)。 */
  bufferBytes?: number;
  /** 空闲回收毫秒(缺省 env GENIE_TERMINAL_IDLE_MS / 30min)。 */
  idleTimeoutMs?: number;
  /** 回收扫描间隔(缺省 30s;测试可调小)。 */
  reaperIntervalMs?: number;
  /** auto=Linux 用 script、其它平台用 pipe;pty=强制 script;pipe=强制管道。 */
  shellMode?: "auto" | TerminalShellKind;
  /** 审计出口(生产=journal custom 事件;缺省静默)。 */
  audit?: TerminalAuditSink;
  /** open 的 READY 握手超时(缺省 5s)。 */
  initTimeoutMs?: number;
  /** close 先等 exit 的宽限(缺省 1.5s),之后 SIGKILL 进程组。 */
  closeGraceMs?: number;
  /** 测试可注入时钟。 */
  now?: () => number;
}

export function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
