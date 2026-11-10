/**
 * 单会话实现:一个保活的 bash + 有界输出缓冲 + 命令完成 marker。
 * 实现形态:
 * - Linux 默认 `script -qefc "stty -echo; exec bash --norc --noprofile" /dev/null`——bash 看到真 tty,
 *   交互式提示(`read -p`)与行缓冲程序可用;不依赖 node-pty/原生编译。
 * - 其它平台或显式 pipe 模式:`bash --norc --noprofile` + stdio 管道(无 tty,命令/cwd/后台进程仍可用)。
 * 完成判定:send 在命令后追加唯一 marker 行(`printf '\n<token>:%s\n' "$?"`),等待 marker 出现;
 * 超时返回部分输出(waitReason=timeout),命令可能仍在运行,后续 read 继续取增量。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { RingBuffer } from "./ring-buffer.js";
import {
  TerminalError,
  type TerminalCloseResult,
  type TerminalReadInput,
  type TerminalReadResult,
  type TerminalSendInput,
  type TerminalSendResult,
  type TerminalSessionInfo,
  type TerminalSessionStatus,
  type TerminalShellKind,
  type TerminalWaitReason,
} from "./types.js";

/** 单次工具返回的字符上限(与 run_cmd 100KB 对齐;环形缓冲本身 200KB)。 */
const MAX_RETURN_CHARS = 100_000;
/** 缺省 send 超时。 */
const DEFAULT_SEND_TIMEOUT_MS = 30_000;
const MAX_SEND_TIMEOUT_MS = 600_000;
const MIN_SEND_TIMEOUT_MS = 100;
const MAX_READ_WAIT_MS = 5_000;

const ANSI_RE =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][^\x1b]*(?:\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const C0_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const MARKER_RE = /__GENIE_TERM_DONE_[0-9a-f]+_\d+:-?\d+/g;

function sanitizeTerminalText(text: string): string {
  // 裸 \r 是终端光标回车(readline 每条命令前后都会发 ESC[?2004l + CR),不是换行——丢弃,
  // 否则每条命令输出都会凭空多一个前导空行。真正的换行只认 \n / \r\n。
  return text.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "").replace(C0_RE, "");
}

function isCompleteEscape(seq: string): boolean {
  if (seq.startsWith("\x1b]")) return /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.test(seq);
  if (seq.startsWith("\x1b[")) return /\x1b\[[0-?]*[ -/]*[@-~]/.test(seq);
  if (seq.startsWith("\x1b[P^_]")) return /\x1b[P^_][^\x1b]*(?:\x1b\\)/.test(seq);
  if (seq.length < 2) return false;
  return /^\x1b[@-Z\\-_]/.test(seq);
}

/** 分块 ANSI 清洗:跨 chunk 的转义序列/CRLF 用 carry 拼接,避免半截序列泄漏成乱码。 */
class OutputSanitizer {
  private carry = "";

  push(text: string): string {
    let combined = this.carry + text;
    this.carry = "";
    const esc = combined.lastIndexOf("\x1b");
    if (esc !== -1 && !isCompleteEscape(combined.slice(esc))) {
      this.carry = combined.slice(esc);
      combined = combined.slice(0, esc);
    } else if (combined.endsWith("\r")) {
      this.carry = "\r";
      combined = combined.slice(0, -1);
    }
    if (this.carry.length > 64) this.carry = ""; // 未完成的转义过长=丢弃,防 carry 无限增长
    return sanitizeTerminalText(combined);
  }

  flush(): string {
    const carry = this.carry;
    this.carry = "";
    return sanitizeTerminalText(carry);
  }
}

function cleanOutput(text: string): string {
  const stripped = text.replace(MARKER_RE, "");
  return stripped.replace(/\n+$/, "\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface TerminalSessionOptions {
  id: string;
  owner: string;
  name?: string;
  cwd: string;
  shellKind: TerminalShellKind;
  /** auto 模式下 pty 启动失败时允许回退 pipe。 */
  fallbackToPipe: boolean;
  bufferBytes: number;
  initTimeoutMs: number;
  closeGraceMs: number;
  now?: () => number;
 /** :shell 覆盖(远程 SSH shell;提供时替代默认 bash/PTY 启动)。 */
  shellOverride?: { command: string; args: string[]; env?: Record<string, string> };
}

export class TerminalSession {
  private child: ChildProcessWithoutNullStreams | undefined;
  private shell: TerminalShellKind;
  private stdoutDecoder = new StringDecoder("utf8");
  private sanitizer = new OutputSanitizer();
  private buffer: RingBuffer;
  private status: TerminalSessionStatus = "running";
  private exitCode: number | null = null;
  private closed = false;
  private consumedCursor = 0;
  private lastActiveAt: number;
  private readonly createdAt: number;
  private markerSeq = 0;
  private readonly markerNonce: string;
  private generation = 0;
  private sendChain: Promise<unknown> = Promise.resolve();
  private waiters = new Set<() => void>();
  private exitPromise: Promise<void> = Promise.resolve();
  private exitResolve: (() => void) | undefined;

  constructor(private readonly opts: TerminalSessionOptions) {
    this.shell = opts.shellKind;
    this.buffer = new RingBuffer(opts.bufferBytes);
    this.createdAt = (opts.now ?? Date.now)();
    this.lastActiveAt = this.createdAt;
    this.markerNonce = Math.random().toString(16).slice(2, 10);
  }

  get id(): string {
    return this.opts.id;
  }

  get owner(): string {
    return this.opts.owner;
  }

  get name(): string | undefined {
    return this.opts.name;
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  get lastActive(): number {
    return this.lastActiveAt;
  }

  info(): TerminalSessionInfo {
    return {
      id: this.opts.id,
      ...(this.opts.name ? { name: this.opts.name } : {}),
      owner: this.opts.owner,
      cwd: this.opts.cwd,
      shell: this.shell,
      ...(this.child?.pid !== undefined ? { pid: this.child.pid } : {}),
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      status: this.status,
      exitCode: this.exitCode,
      bufferedBytes: this.buffer.bufferedBytes,
      cursor: this.buffer.endCursor,
    };
  }

  async start(): Promise<void> {
    const attempts: TerminalShellKind[] =
      this.shell === "pty" && this.opts.fallbackToPipe ? ["pty", "pipe"] : [this.shell];
    let lastError: unknown;
    for (const kind of attempts) {
      try {
        this.beginShell(kind);
        await this.readyHandshake();
        this.shell = kind;
        return;
      } catch (err) {
        lastError = err;
        this.generation += 1; // 让失败实例的数据/退出回调失效
        this.killTree();
        this.child = undefined;
        this.status = "running";
        this.exitCode = null;
        this.buffer = new RingBuffer(this.opts.bufferBytes);
        this.stdoutDecoder = new StringDecoder("utf8");
        this.sanitizer = new OutputSanitizer();
        this.consumedCursor = 0;
      }
    }
    throw new TerminalError(
      `终端启动失败(${this.shell}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      "STARTUP_FAILED",
    );
  }

  async send(input: TerminalSendInput): Promise<TerminalSendResult> {
    const run = this.sendChain.then(() => this.doSend(input));
    // 前一条失败不阻断后续命令(把链保持在 resolved 态)。
    this.sendChain = run.then(
      () => undefined,
      () => undefined);
    return run;
  }

  async read(input: TerminalReadInput = {}): Promise<TerminalReadResult> {
    this.touch();
    const startCursor = Math.max(0, Math.floor(input.cursor ?? this.consumedCursor));
    const waitMs = clamp(Math.floor(input.waitMs ?? 0), 0, MAX_READ_WAIT_MS);
    const maxChars = clamp(Math.floor(input.maxChars ?? MAX_RETURN_CHARS), 1, MAX_RETURN_CHARS);
    if (waitMs > 0 && this.status === "running" && this.buffer.endCursor <= startCursor) {
      await this.waitForOutput(startCursor, waitMs);
    }
    const read = this.buffer.readFrom(startCursor, maxChars);
    this.consumedCursor = Math.max(this.consumedCursor, read.nextCursor);
    return {
      sessionId: this.opts.id,
      output: cleanOutput(read.text),
      cursor: read.nextCursor,
      truncated: read.truncated,
      status: this.status,
      exitCode: this.exitCode,
    };
  }

  async close(_reason?: string): Promise<TerminalCloseResult> {
    this.touch();
    if (this.closed) return { sessionId: this.opts.id, closed: true, exitCode: this.exitCode };
    this.closed = true;
    const child = this.child;
    if (child && this.status === "running" && child.stdin.writable) {
      try {
        child.stdin.write("exit\n");
      } catch {
        /* shell 已退出 */
      }
      await Promise.race([this.exitPromise, this.delay(this.opts.closeGraceMs)]);
    }
    this.killTree();
    await Promise.race([this.exitPromise, this.delay(500)]);
    this.status = "exited";
    return { sessionId: this.opts.id, closed: true, exitCode: this.exitCode };
  }

  /** 同步杀掉整个进程组(进程退出钩子/启动失败清理用)。 */
  killNow(): void {
    this.killTree();
  }

  private beginShell(kind: TerminalShellKind): void {
    const gen = ++this.generation;
 // shellOverride(远程 SSH shell)优先于默认 bash/PTY 启动
    const launch = this.opts.shellOverride
      ? { command: this.opts.shellOverride.command, args: this.opts.shellOverride.args }
      : kind === "pty" && process.platform === "linux"
        ? { command: "script", args: ["-qefc", "stty -echo 2>/dev/null; exec bash --norc --noprofile", "/dev/null"] }
        : { command: "bash", args: ["--norc", "--noprofile"] };
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PS1: "",
      PROMPT_COMMAND: "",
      TERM: "xterm-256color",
      GENIE_TERMINAL_ID: this.opts.id,
      ...(this.opts.shellOverride?.env ?? {}),
    };
    delete env.BASH_ENV;
    delete env.ENV;
    this.exitPromise = new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });
    const child = spawn(launch.command, launch.args, {
      cwd: this.opts.cwd,
      env,
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      if (gen !== this.generation) return;
      this.onData(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (gen !== this.generation) return;
      this.onData(chunk);
    });
    child.on("error", (err) => {
      if (gen !== this.generation) return;
      this.status = "exited";
      this.appendOutput(`\n[终端错误] ${err.message}\n`);
      this.notify();
    });
    child.on("exit", (code, signal) => {
      if (gen !== this.generation) return;
      this.finishDecoding();
      this.status = "exited";
      this.exitCode = typeof code === "number" ? code : signal ? 128 : null;
      this.exitResolve?.();
      this.notify();
    });
  }

  private async readyHandshake(): Promise<void> {
    const token = `__GENIE_TERM_READY_${this.markerNonce}`;
    // 等 shell 首屏(pty 下 stty 关闭 echo 先于 bash 提示符生效):最多 400ms,退出则直接失败。
    if (this.status === "running" && this.buffer.endCursor === 0) {
      await this.waitForOutput(0, 400);
    }
    try {
      this.write(
        "stty -echo 2>/dev/null; set +m 2>/dev/null; PS1=''; PROMPT_COMMAND=''; " +
          `printf '\\n${token}:%s\\n' "$?"\n`,
      );
    } catch (err) {
      throw new TerminalError(`终端初始化写入失败: ${String(err)}`, "STARTUP_FAILED");
    }
    const outcome = await this.waitForMarker(token, this.opts.initTimeoutMs);
    if (outcome.reason !== "completed") {
      throw new TerminalError(
        `终端初始化握手失败(${outcome.reason})——shell 未就绪`,
        "STARTUP_FAILED",
      );
    }
    // 丢弃启动 banner/初始 prompt;游标归零,首条 send 从干净缓冲开始。
    this.buffer.clear();
    this.consumedCursor = 0;
  }

  private doSend(input: TerminalSendInput): Promise<TerminalSendResult> {
    return this.sendOnce(input);
  }

  private async sendOnce(input: TerminalSendInput): Promise<TerminalSendResult> {
    const startedAt = (this.opts.now ?? Date.now)();
    this.touch();
    if (this.closed) throw new TerminalError("会话已关闭,不能再发送命令", "SESSION_CLOSED");
    const command = String(input.command ?? "");
    if (!command.trim()) throw new TerminalError("command 必填", "INVALID_INPUT");
    const wait = input.wait !== false;
    const timeoutMs = clamp(
      Math.floor(input.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS),
      MIN_SEND_TIMEOUT_MS,
      MAX_SEND_TIMEOUT_MS);
    const startCursor = this.buffer.endCursor;
    if (this.status === "exited") {
      return this.finishSend(startCursor, "session-exit", this.exitCode, startedAt);
    }
    try {
      this.write(command.endsWith("\n") ? command : command + "\n");
    } catch (err) {
      throw new TerminalError(`写入终端失败: ${String(err)}`, "SESSION_CLOSED");
    }
    if (!wait) {
      await this.waitChange(25);
      return this.finishSend(startCursor, "no-wait", null, startedAt);
    }
    const token = `__GENIE_TERM_DONE_${this.markerNonce}_${++this.markerSeq}`;
    try {
      this.write(`printf '\\n${token}:%s\\n' "$?"\n`);
    } catch (err) {
      throw new TerminalError(`写入终端 marker 失败: ${String(err)}`, "SESSION_CLOSED");
    }
    const outcome = await this.waitForMarker(token, timeoutMs);
    return this.finishSend(startCursor, outcome.reason, outcome.exitCode, startedAt);
  }

  private finishSend(
    startCursor: number,
    waitReason: TerminalWaitReason,
    exitCode: number | null,
    startedAt: number): TerminalSendResult {
    const read = this.buffer.readFrom(startCursor, MAX_RETURN_CHARS);
    this.consumedCursor = Math.max(this.consumedCursor, read.nextCursor);
    return {
      sessionId: this.opts.id,
      output: cleanOutput(read.text),
      cursor: read.nextCursor,
      exitCode,
      waitReason,
      durationMs: Math.max(0, (this.opts.now ?? Date.now)() - startedAt),
      truncated: read.truncated,
    };
  }

  private async waitForMarker(
    token: string,
    timeoutMs: number): Promise<{ reason: TerminalWaitReason; exitCode: number | null }> {
    const deadline = (this.opts.now ?? Date.now)() + timeoutMs;
    let searchFrom = this.buffer.startCursor;
    while (true) {
      const found = this.findMarker(token, searchFrom);
      if (found !== null && typeof found === "object") return { reason: "completed", exitCode: found.code };
      if (found === null) {
        // token 完全未出现:把搜索起点推进到「可能的前缀起点」,保留 token 长度重叠。
        searchFrom = Math.max(searchFrom, this.buffer.endCursor - token.length - 2);
      }
      // found === "incomplete":token 已出现但退出码数字/换行未收全——searchFrom 不动,等下一块数据。
      if (this.status === "exited") {
        await this.waitChange(30);
        const late = this.findMarker(token, searchFrom);
        if (late !== null && typeof late === "object") return { reason: "completed", exitCode: late.code };
        return { reason: "session-exit", exitCode: this.exitCode };
      }
      const remaining = deadline - (this.opts.now ?? Date.now)();
      if (remaining <= 0) return { reason: "timeout", exitCode: null };
      await this.waitChange(Math.min(remaining, 100));
    }
  }

  /**
   * 查 marker:
   * - {code}:已完整出现;
   * - "incomplete":token 出现但退出码/换行未收全(调用方保持 searchFrom 等下一块);
   * - null:token 未出现(调用方可在保留重叠的前提下推进 searchFrom)。
   */
  private findMarker(token: string, searchFrom: number): { code: number } | "incomplete" | null {
    const { text } = this.buffer.readFrom(searchFrom, Number.MAX_SAFE_INTEGER);
    const needle = token + ":";
    let index = text.indexOf(needle);
    if (index === -1) return null;
    // 同一 token 可能出现多次:终端回显的原始命令里是 `token:%s`(无数字),
    // 真 marker 是后续的 `token:<code>\n`——必须跳过回显继续找,不能只看第一处。
    let sawIncomplete = false;
    while (index !== -1) {
      const digits = text.slice(index + needle.length);
      const match = /^(-?\d+)\n/.exec(digits);
      if (match) return { code: Number(match[1]) };
      sawIncomplete = true;
      index = text.indexOf(needle, index + needle.length);
    }
    return sawIncomplete ? "incomplete" : null;
  }

  private async waitForOutput(cursor: number, waitMs: number): Promise<void> {
    const deadline = (this.opts.now ?? Date.now)() + waitMs;
    while (this.status === "running" && this.buffer.endCursor <= cursor) {
      const remaining = deadline - (this.opts.now ?? Date.now)();
      if (remaining <= 0) return;
      await this.waitChange(Math.min(remaining, 100));
    }
  }

  private write(text: string): void {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error("stdin 不可写");
    child.stdin.write(text);
  }

  private onData(chunk: Buffer): void {
    const decoded = this.stdoutDecoder.write(chunk);
    const clean = this.sanitizer.push(decoded);
    this.appendOutput(clean);
    this.notify();
  }

  private appendOutput(text: string): void {
    if (text) this.buffer.append(text);
  }

  private finishDecoding(): void {
    const tail = this.stdoutDecoder.end();
    if (tail) this.appendOutput(this.sanitizer.push(tail));
    const carry = this.sanitizer.flush();
    if (carry) this.appendOutput(carry);
  }

  private notify(): void {
    if (this.waiters.size === 0) return;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }

  /** 等数据/退出/超时(事件驱动;100ms 兜底轮询)。 */
  private waitChange(ms: number): Promise<void> {
    const timeout = Math.max(1, ms);
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve();
      };
      // 不 unref:等待中的调用必须让进程保持存活(否则 top-level await 会以 unsettled 退出 13)。
      const timer = setTimeout(finish, timeout);
      this.waiters.add(finish);
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      // 不 unref:close 的宽限期需要保持事件循环。
      setTimeout(resolve, Math.max(0, ms));
    });
  }

  private touch(): void {
    this.lastActiveAt = (this.opts.now ?? Date.now)();
  }

  private killTree(): void {
    const pid = this.child?.pid;
    if (process.platform !== "win32" && typeof pid === "number") {
      try {
        process.kill(-pid, "SIGKILL"); // detached=true 使 wrapper 成为进程组组长;set +m 保证子进程同组
      } catch {
        /* 进程组已不存在 */
      }
    }
    try {
      this.child?.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
}
