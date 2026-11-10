/**
 * M27 Job registry:后台命令 job(owner fence / 有界输出环 + spill / settlement first-wins / wait·kill·通知一次)。
 *
 * 与持久终端会话(service.ts)的分工:
 * - terminal = 交互式保活的 shell 会话(命令混在会话流里);
 * - job = 一次性后台命令的独立句柄:有 jobId/pid/状态/输出偏移/spill 文件,可 wait/kill,
 *   结算只发生一次,通知只投递一次。owner 由工具工厂硬绑定(模型无法伪造)。
 *
 * 关键语义:
 * - 输出:stdout+stderr 合并按到达序写有界字节环(缺省 256KB);超限时把**完整历史**落
 *   `<spillDir>/<jobId>.log` 并继续追加。offset 是「从 job 启动起的绝对字节偏移」,不因淘汰重置。
 * - settlement:exit/close/error 只结算一次(running→done|failed|killed);wait/kill/通知都读同一份结算。
 * - kill:发信号→宽限→SIGKILL;已结算直接返回既有快照(不重复结算)。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readPositiveIntEnv } from "./types.js";

export type JobStatus = "running" | "done" | "failed" | "killed";

export interface JobInfo {
  jobId: string;
  owner: string;
  title?: string;
  status: JobStatus;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  code: number | null;
  signal: string | null;
  /** 从 job 启动起累计输出的字节数(= 绝对 offset 的高水位)。 */
  bytes: number;
  /** 输出超限后完整历史的落盘路径。 */
  spillPath?: string;
}

/** 结算事件(通知出口的 payload)。 */
export interface JobSettledEvent {
  jobId: string;
  owner: string;
  title?: string;
  status: Exclude<JobStatus, "running">;
  code: number | null;
  signal: string | null;
  bytes: number;
  spillPath?: string;
  startedAt: number;
  endedAt: number;
}

export interface JobStartInput {
  command: string;
  cwd?: string;
  title?: string;
  env?: Record<string, string>;
  /** shell 可执行文件覆盖(缺省 GENIE_SHELL_BIN / Unix: /bin/bash;Windows: cmd)。 */
  shell?: string;
  /** cwd 围栏根覆盖(工具层=taskRoot;缺省 registry.root)。 */
  fenceRoot?: string;
}

export interface JobReadInput {
  /** 绝对字节偏移(从 job 启动起);缺省 0。 */
  offset?: number;
  /** 单次返回字节上限;缺省 64KB(不设上限会把 256KB 一次塞回上下文)。 */
  maxBytes?: number;
}

export interface JobReadResult {
  chunk: string;
  /** 本次请求的绝对起偏移。 */
  offset: number;
  /** 下一次读取应传的偏移。 */
  nextOffset: number;
  eof: boolean;
  /** true=请求的偏移已被内存环淘汰,内容来自 spill 文件。 */
  spilled: boolean;
  spillPath?: string;
}

export interface JobWaitInput {
  timeoutMs?: number;
}

export interface JobKillInput {
  signal?: string;
}

export type JobErrorCode =
  | "JOB_LIMIT"
  | "JOB_FORBIDDEN"
  | "JOB_NOT_FOUND"
  | "JOB_BAD_CWD"
  | "JOB_INVALID_INPUT"
  | "JOB_SPAWN_FAILED";

export class JobError extends Error {
  constructor(
    message: string,
    readonly code: JobErrorCode,
  ) {
    super(message);
    this.name = "JobError";
  }
}

export interface JobRegistryOptions {
  /** cwd 围栏根(缺省 process.cwd())。 */
  root?: string;
  /** spill 目录(缺省 <root>/.genie/jobs)。 */
  spillDir?: string;
  /** 单 owner 并发上限(缺省 env GENIE_JOB_MAX_PER_OWNER / 4)。 */
  maxPerOwner?: number;
  /** 全局并发上限(缺省 env GENIE_JOB_MAX_GLOBAL / 16)。 */
  maxGlobal?: number;
  /** 内存环字节上限(缺省 env GENIE_JOB_BUFFER_KB / 256KB)。 */
  bufferBytes?: number;
  /** kill 宽限毫秒(SIGTERM 后等这么久再 SIGKILL;缺省 env GENIE_JOB_KILL_GRACE_MS / 1500)。 */
  killGraceMs?: number;
  /** 结算通知出口(每个 job 最多调一次;wake=false=结算被 wait 当场消费,不再唤醒)。 */
  onSettle?: (event: JobSettledEvent, meta: { wake: boolean }) => void;
  /** 测试可注入时钟。 */
  now?: () => number;
}

interface OutputChunk {
  /** chunk 首字节的绝对偏移。 */
  start: number;
  buf: Buffer;
}

/** 有界字节环 + 完整历史 spill。 */
class BoundedOutput {
  private chunks: OutputChunk[] = [];
  private head = 0;
  private end = 0;
  private buffered = 0;
  private spillPath: string | undefined;

  constructor(
    private readonly maxBytes: number,
    private readonly spillPathFor: () => string,
  ) {}

  get startOffset(): number {
    return this.head;
  }

  get endOffset(): number {
    return this.end;
  }

  get spillFile(): string | undefined {
    return this.spillPath;
  }

  append(buf: Buffer): void {
    if (buf.length === 0) return;
    const alreadySpilled = this.spillPath !== undefined;
    this.chunks.push({ start: this.end, buf });
    this.end += buf.length;
    this.buffered += buf.length;
    if (alreadySpilled) {
      appendFileSync(this.spillPath!, buf);
    } else if (this.buffered > this.maxBytes) {
      const path = this.spillPathFor();
      mkdirSync(dirname(path), { recursive: true });
      // 把到目前为止的**完整历史**一次性落盘,之后逐块追加。
      writeFileSync(path, Buffer.concat(this.chunks.map((c) => c.buf)));
      this.spillPath = path;
    }
    this.trim();
  }

  /** 从绝对 offset 读最多 maxBytes 字节;offset 早于淘汰头时从 spill 文件续读。 */
  read(offset: number, maxBytes: number): Omit<JobReadResult, "eof"> {
    const max = Math.max(1, Math.floor(maxBytes));
    if (offset >= this.end) {
      return { chunk: "", offset, nextOffset: offset, spilled: false, ...(this.spillPath ? { spillPath: this.spillPath } : {}) };
    }
    if (offset < this.head) {
      const want = Math.min(this.head - offset, max);
      let text = "";
      let consumed = 0;
      if (this.spillPath && want > 0) {
        const fd = openSync(this.spillPath, "r");
        try {
          const b = Buffer.alloc(want);
          const n = readSync(fd, b, 0, want, offset);
          consumed = n;
          text = b.subarray(0, n).toString("utf8");
        } finally {
          closeSync(fd);
        }
      }
      return {
        chunk: text,
        offset,
        nextOffset: offset + consumed,
        spilled: true,
        ...(this.spillPath ? { spillPath: this.spillPath } : {}),
      };
    }
    const parts: Buffer[] = [];
    let taken = 0;
    for (const ch of this.chunks) {
      if (taken >= max) break;
      const chEnd = ch.start + ch.buf.length;
      if (chEnd <= offset) continue;
      const from = Math.max(0, offset - ch.start);
      const take = Math.min(ch.buf.length - from, max - taken);
      if (take <= 0) continue;
      parts.push(ch.buf.subarray(from, from + take));
      taken += take;
    }
    const buf = Buffer.concat(parts);
    return {
      chunk: buf.toString("utf8"),
      offset,
      nextOffset: offset + buf.length,
      spilled: false,
      ...(this.spillPath ? { spillPath: this.spillPath } : {}),
    };
  }

  private trim(): void {
    while (this.buffered > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.buffered -= dropped.buf.length;
      this.head = dropped.start + dropped.buf.length;
    }
    if (this.buffered > this.maxBytes && this.chunks.length === 1) {
      const only = this.chunks[0]!;
      const drop = this.buffered - this.maxBytes;
      only.buf = only.buf.subarray(drop);
      only.start += drop;
      this.buffered = only.buf.length;
      this.head = only.start;
    }
  }
}

class Job {
  readonly startedAt: number;
  status: JobStatus = "running";
  code: number | null = null;
  signal: string | null = null;
  endedAt: number | undefined;
  pid: number | undefined;
  readonly out: BoundedOutput;
  child: ChildProcess | undefined;
  killRequested = false;
  notified = false;
  readonly waiters = new Set<() => void>();

  constructor(
    readonly id: string,
    readonly owner: string,
    readonly title: string | undefined,
    now: () => number,
    bufferBytes: number,
    spillPath: string,
  ) {
    this.startedAt = now();
    this.out = new BoundedOutput(bufferBytes, () => spillPath);
  }

  snapshot(): JobInfo {
    return {
      jobId: this.id,
      owner: this.owner,
      ...(this.title ? { title: this.title } : {}),
      status: this.status,
      ...(this.pid !== undefined ? { pid: this.pid } : {}),
      startedAt: this.startedAt,
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      code: this.code,
      signal: this.signal,
      bytes: this.out.endOffset,
      ...(this.out.spillFile ? { spillPath: this.out.spillFile } : {}),
    };
  }
}

const DEFAULT_MAX_PER_OWNER = 4;
const DEFAULT_MAX_GLOBAL = 16;
const DEFAULT_BUFFER_KB = 256;
const DEFAULT_KILL_GRACE_MS = 1_500;
const DEFAULT_READ_BYTES = 64 * 1024;
const MAX_WAIT_MS = 600_000;
/** 已结算 job 台账上限(防长命进程泄漏;spill 文件保留)。 */
const SETTLED_KEEP = 200;

function isDirectory(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  /** owner → 通知路由的会话 id(job 工具创建时绑定;缺省 owner 本身)。 */
  private readonly ownerSession = new Map<string, string>();
  private readonly root: string;
  private readonly spillDir: string;
  private readonly maxPerOwner: number;
  private readonly maxGlobal: number;
  private readonly bufferBytes: number;
  private readonly killGraceMs: number;
  private readonly onSettle: ((event: JobSettledEvent, meta: { wake: boolean }) => void) | undefined;
  private readonly now: () => number;
  private seq = 0;

  constructor(opts: JobRegistryOptions = {}) {
    this.root = safeRealpath(opts.root ?? process.cwd());
    this.spillDir = resolve(opts.spillDir ?? join(this.root, ".genie", "jobs"));
    this.maxPerOwner = opts.maxPerOwner ?? readPositiveIntEnv("GENIE_JOB_MAX_PER_OWNER", DEFAULT_MAX_PER_OWNER);
    this.maxGlobal = opts.maxGlobal ?? readPositiveIntEnv("GENIE_JOB_MAX_GLOBAL", DEFAULT_MAX_GLOBAL);
    this.bufferBytes = opts.bufferBytes ?? readPositiveIntEnv("GENIE_JOB_BUFFER_KB", DEFAULT_BUFFER_KB) * 1024;
    this.killGraceMs = opts.killGraceMs ?? readPositiveIntEnv("GENIE_JOB_KILL_GRACE_MS", DEFAULT_KILL_GRACE_MS);
    this.onSettle = opts.onSettle;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 绑定 owner → 会话 id(通知投递路由;主 agent owner=sessionId 时可省)。 */
  bindOwner(owner: string, sessionId: string): void {
    if (owner && sessionId) this.ownerSession.set(owner, sessionId);
  }

  sessionForOwner(owner: string): string {
    return this.ownerSession.get(owner) ?? owner;
  }

  get spillDirectory(): string {
    return this.spillDir;
  }

  start(owner: string, input: JobStartInput): { jobId: string; pid: number | undefined; startedAt: number } {
    if (!owner) throw new JobError("owner 必填", "JOB_FORBIDDEN");
    const command = String(input.command ?? "");
    if (!command.trim()) throw new JobError("command 必填", "JOB_INVALID_INPUT");
    const cwd = this.resolveCwd(input.cwd, input.fenceRoot ?? this.root);
    this.enforceLimits(owner);

    const jobId = `job-${this.now().toString(36)}-${(++this.seq).toString(36)}`;
    const job = new Job(jobId, owner, input.title?.trim() || undefined, this.now, this.bufferBytes, join(this.spillDir, `${jobId}.log`));
    this.jobs.set(jobId, job);
    this.pruneSettled();

    const shellBin = input.shell ?? defaultShellBin();
    const args = shellArgs(shellBin, command);
    let child: ChildProcess;
    try {
      child = spawn(shellBin, args, {
        cwd,
        env: { ...process.env, ...(input.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      job.status = "failed";
      job.endedAt = this.now();
      this.notify(job);
      throw new JobError(`spawn 失败: ${(err as Error).message}`, "JOB_SPAWN_FAILED");
    }
    job.child = child;
    job.pid = child.pid;
    child.stdout?.on("data", (chunk: Buffer | string) => {
      job.out.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      job.out.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("close", (code, signal) => {
      this.settle(job, job.killRequested ? "killed" : code === 0 ? "done" : "failed", code ?? null, signal ?? null);
    });
    child.on("error", () => {
      this.settle(job, job.killRequested ? "killed" : "failed", null, null);
    });
    return { jobId, pid: child.pid, startedAt: job.startedAt };
  }

  list(owner: string): JobInfo[] {
    if (!owner) throw new JobError("owner 必填", "JOB_FORBIDDEN");
    return [...this.jobs.values()]
      .filter((j) => j.owner === owner)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((j) => j.snapshot());
  }

  read(owner: string, jobId: string, input: JobReadInput = {}): JobReadResult {
    const job = this.require(owner, jobId);
    const offset = Number.isFinite(input.offset) ? Math.max(0, Math.floor(Number(input.offset))) : 0;
    const maxBytes =
      Number.isFinite(input.maxBytes) && Number(input.maxBytes) > 0 ? Math.floor(Number(input.maxBytes)) : DEFAULT_READ_BYTES;
    const r = job.out.read(offset, maxBytes);
    const eof = job.status !== "running" && r.nextOffset >= job.out.endOffset;
    return { ...r, eof };
  }

  /** 等 settlement(超时返回 running 快照,**不取消** job)。 */
  async wait(owner: string, jobId: string, input: JobWaitInput = {}): Promise<JobInfo> {
    const job = this.require(owner, jobId);
    if (job.status !== "running") return job.snapshot();
    const timeoutMs = Math.min(MAX_WAIT_MS, Math.max(0, Math.floor(input.timeoutMs ?? 60_000)));
    await waitForJob(job, timeoutMs);
    return job.snapshot();
  }

  /** 终态结算一次(SIGTERM→宽限→SIGKILL);已结算直接返回既有快照。 */
  async kill(owner: string, jobId: string, input: JobKillInput = {}): Promise<JobInfo> {
    const job = this.require(owner, jobId);
    if (job.status !== "running") return job.snapshot();
    job.killRequested = true;
    const signal = (input.signal ?? "SIGTERM").toUpperCase();
    killTree(job, signal);
    if (signal !== "SIGKILL") {
      const closed = await waitForJob(job, this.killGraceMs);
      if (!closed && job.status === "running") killTree(job, "SIGKILL");
    }
    if (job.status === "running") await waitForJob(job, 2_000);
    // SIGKILL 后仍不退出(不可杀进程):强制结算,保证终态只出现一次。
    this.settle(job, "killed", job.code, job.signal ?? signal);
    return job.snapshot();
  }

  /** owner 级回收:kill 本 owner 全部 running 并标 killed。 */
  async disposeOwner(owner: string): Promise<number> {
    if (!owner) return 0;
    const running = [...this.jobs.values()].filter((j) => j.owner === owner && j.status === "running");
    await Promise.allSettled(running.map((j) => this.kill(owner, j.id)));
    this.ownerSession.delete(owner);
    return running.length;
  }

  /** 会话级回收(任务终态):本会话 owner + 绑定到该会话的子代理 owner。 */
  async disposeSession(sessionId: string): Promise<number> {
    if (!sessionId) return 0;
    const owners = new Set<string>([sessionId]);
    for (const [owner, sid] of this.ownerSession) if (sid === sessionId) owners.add(owner);
    const results = await Promise.allSettled([...owners].map((o) => this.disposeOwner(o)));
    return results.reduce((sum, r) => sum + (r.status === "fulfilled" ? r.value : 0), 0);
  }

  /** 全部回收(进程退出/服务关闭)。 */
  async shutdown(): Promise<number> {
    const running = [...this.jobs.values()].filter((j) => j.status === "running");
    await Promise.allSettled(running.map((j) => this.kill(j.owner, j.id)));
    this.ownerSession.clear();
    return running.length;
  }

  private settle(job: Job, status: Exclude<JobStatus, "running">, code: number | null, signal: string | null): void {
    if (job.status !== "running") return; // first-wins:exit/error/kill 三路只结算一次
    job.status = status;
    job.code = code;
    job.signal = signal;
    job.endedAt = this.now();
    const hadWaiter = job.waiters.size > 0;
    for (const w of [...job.waiters]) w();
    job.waiters.clear();
    this.notify(job, !hadWaiter);
  }

  /** 通知 first-wins:settledNotified 标记保证同一 job 只调一次。 */
  private notify(job: Job, wake = true): void {
    if (job.notified) return;
    job.notified = true;
    if (!this.onSettle) return;
    try {
      this.onSettle(
        {
          jobId: job.id,
          owner: job.owner,
          ...(job.title ? { title: job.title } : {}),
          status: job.status === "running" ? "failed" : job.status,
          code: job.code,
          signal: job.signal,
          bytes: job.out.endOffset,
          ...(job.out.spillFile ? { spillPath: job.out.spillFile } : {}),
          startedAt: job.startedAt,
          endedAt: job.endedAt ?? this.now(),
        },
        { wake },
      );
    } catch {
      /* 通知失败不影响 settlement */
    }
  }

  private require(owner: string, jobId: string): Job {
    if (!owner) throw new JobError("owner 必填", "JOB_FORBIDDEN");
    const job = this.jobs.get(String(jobId ?? ""));
    if (!job) throw new JobError(`job 不存在: ${jobId}`, "JOB_NOT_FOUND");
    if (job.owner !== owner) throw new JobError(`job ${jobId} 不属于当前 owner`, "JOB_FORBIDDEN");
    return job;
  }

  private enforceLimits(owner: string): void {
    const running = [...this.jobs.values()].filter((j) => j.status === "running");
    if (running.length >= this.maxGlobal) {
      throw new JobError(`后台 job 全局并发上限 ${this.maxGlobal} 已达`, "JOB_LIMIT");
    }
    if (running.filter((j) => j.owner === owner).length >= this.maxPerOwner) {
      throw new JobError(`后台 job 单 owner 并发上限 ${this.maxPerOwner} 已达`, "JOB_LIMIT");
    }
  }

  /** 已结算台账只留最近 SETTLED_KEEP 条(spill 文件保留)。 */
  private pruneSettled(): void {
    if (this.jobs.size <= SETTLED_KEEP) return;
    const settled = [...this.jobs.values()].filter((j) => j.status !== "running");
    for (const j of settled) {
      if (this.jobs.size <= SETTLED_KEEP) break;
      this.jobs.delete(j.id);
    }
  }

  private resolveCwd(requested: string | undefined, root: string): string {
    const base = safeRealpath(root);
    const target =
      !requested || requested === "." ? base : isAbsolute(requested) ? resolve(requested) : resolve(base, requested);
    if (!isDirectory(target)) throw new JobError(`cwd 不存在或不是目录: ${requested}`, "JOB_BAD_CWD");
    const real = safeRealpath(target);
    const rel = relative(base, real);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new JobError(`cwd 越出工具根: ${requested}`, "JOB_BAD_CWD");
    }
    return real;
  }
}

/** 等 job 结算或超时;返回是否已结算。 */
function waitForJob(job: Job, timeoutMs: number): Promise<boolean> {
  if (job.status !== "running") return Promise.resolve(true);
  if (timeoutMs <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolveWait) => {
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      job.waiters.delete(done);
      resolveWait(job.status !== "running");
    };
    job.waiters.add(done);
    timer = setTimeout(done, timeoutMs);
    timer.unref?.();
  });
}

function defaultShellBin(): string {
  if (process.env.GENIE_SHELL_BIN) return process.env.GENIE_SHELL_BIN;
  return process.platform === "win32" ? process.env.ComSpec || "cmd" : "/bin/bash";
}

function shellArgs(shellBin: string, command: string): string[] {
  if (process.platform === "win32" && /cmd(\.exe)?$/i.test(shellBin)) return ["/d", "/s", "/c", command];
  return ["-lc", command];
}

/** 本仓 tsconfig 的 NodeJS 命名空间不含 Signals;信号类型从 child.kill 签名反推。 */
type KillSignal = NonNullable<Parameters<ChildProcess["kill"]>[0]>;

function killTree(job: Job, signal: string): void {
  const pid = job.child?.pid;
  if (pid === undefined) return;
  const sig = signal as KillSignal;
  try {
    if (process.platform !== "win32") {
      // detached 子进程组:整组发信号,避免只杀 shell 留下孙进程。
      process.kill(-pid, sig as Parameters<typeof process.kill>[1]);
    } else {
      job.child?.kill(sig);
    }
  } catch {
    try {
      job.child?.kill(sig);
    } catch {
      /* 进程已退出 */
    }
  }
}
