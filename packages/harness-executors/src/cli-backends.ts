/**
 * 二期 CLI 后端( §2.2 zcode-headless / opencode-run):
 * 把外部编码 CLI(`zcode` / `opencode`)作为非交互一次性子进程驱动,实现 SubagentBackend 契约。
 * 形态:不是 NDJSON-RPC 会话(NdjsonChildBackend 那种),而是一次性进程——
 * spawn → 收集 stdout/stderr → 退出码裁决 → result(stdout trim 后即 finalText)。
 * 调用策略(诚实登记:两 CLI 的非交互 flag 均按各自文档 best-effort,可能随装机版本调整,
 * 真机标定待办;buildCommand 注入点可完全接管,测试即用它顶替真 CLI):
 * - opencode:`opencode run <instruction>`(官方文档化 headless 模式;--format json 等经 opts.args 携带)。
 * - zcode:无公开文档化的一次性 flag——缺省把指令经 stdin 喂入(等价交互管道单轮),flags 走 opts.args。
 * 错误映射(fail-visible,不静默降级):spawn ENOENT 等 → spawn-failed;
 * 非零退出 → backend-crash(stderr 尾巴进 detail);超时 → kill + timeout;cancel → kill + cancelled。
 * steering 一次性 CLI 不支持恒回 false( §2.2:二期待核实);permission 三档/permissionRules
 * 的 CLI flag 采纳待真机标定(现只透传 env,不伪装已生效)。
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { SubagentBackend, SubagentEvent, SubagentHandle, TaskResult, TaskSpec } from "./ndjson-backend";

/** stdout/stderr 收集上限(与 node-agent cli.ts 同口径)。 */
const STREAM_CAP = 200_000;
/** 一次性执行缺省超时(待标定;可用 opts.timeoutMs 或 spec.budget.wallClockSec 覆盖)。 */
const DEFAULT_TIMEOUT_MS = 600_000;
/** graceful cancel 的 SIGTERM→SIGKILL 宽限(与 NdjsonChildBackend 三板斧同款)。 */
const KILL_GRACE_MS = 1500;

/** 一次 CLI 调用的完整描述。 */
export interface CliCommandSpec {
  cmd: string;
  args: string[];
  /** 需经 stdin 喂给 CLI 的文本(缺省不喂)。 */
  stdin?: string;
}

export interface CliBackendOptions {
  /** CLI 可执行文件;缺省按 kind(zcode→"zcode",opencode→"opencode")。 */
  bin?: string;
  /** 固定附加参数(flags),插在指令前。 */
  args?: string[];
  /** 一次性执行超时 ms;缺省 spec.budget.wallClockSec×1000,再缺省 600_000。超时即 SIGKILL+timeout 错误。 */
  timeoutMs?: number;
  /**
   * 注入式命令构造(完全接管调用策略;测试用它把 fixture 顶成"CLI")。
   * 缺省走各 backend 的文档化缺省策略。
   */
  buildCommand?: (instruction: string, spec: TaskSpec) => CliCommandSpec;
  /** 工作目录推导;缺省 spec.workdir。 */
  cwdFn?: (spec: TaskSpec) => string;
  /** 额外子进程 env(在 process.env 之上、spec.env 之下——spec.env 是凭证注入位)。 */
  env?: Record<string, string>;
}

/** 一次性 CLI 后端基类:进程生命周期/超时/取消/结果裁决全套,子类只声明调用策略。 */
export abstract class CliOneShotBackend implements SubagentBackend {
  abstract readonly kind: string;
  protected readonly opts: CliBackendOptions;

  constructor(opts: CliBackendOptions = {}) {
    this.opts = opts;
  }

  /** 缺省 bin(可被 opts.bin 覆盖)。 */
  protected abstract get defaultBin(): string;
  /** 指令是否经 stdin 进入(否则以参数拼在 args 尾部)。 */
  protected abstract get instructionViaStdin(): boolean;
  /** 指令以参数形态进入时的拼装(args 尾部)。 */
  protected abstract instructionArgs(instruction: string): string[];

  /** 缺省调用策略;opts.buildCommand 优先。 */
  protected command(instruction: string, spec: TaskSpec): CliCommandSpec {
    if (this.opts.buildCommand) return this.opts.buildCommand(instruction, spec);
    return {
      cmd: this.opts.bin ?? this.defaultBin,
      args: [...(this.opts.args ?? []), ...(this.instructionViaStdin ? [] : this.instructionArgs(instruction))],
      stdin: this.instructionViaStdin ? instruction : undefined,
    };
  }

  async spawn(spec: TaskSpec, onEvent: (e: SubagentEvent) => void): Promise<SubagentHandle> {
    const built = this.command(spec.instructions, spec);
    const cwd = this.opts.cwdFn ? this.opts.cwdFn(spec) : spec.workdir;
    const timeoutMs = this.opts.timeoutMs
      ?? (spec.budget?.wallClockSec ? spec.budget.wallClockSec * 1000 : DEFAULT_TIMEOUT_MS);

    let child: ChildProcess;
    try {
      child = spawn(built.cmd, built.args, {
        cwd,
        env: { ...process.env, ...this.opts.env, ...spec.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      // 同步抛(参数非法等):与异步 ENOENT 同语义 fail-visible。
      onEvent({ type: "result", result: { ok: false, error: { kind: "spawn-failed", detail: String(err).slice(0, 200) } } });
      return deadHandle(spec.taskId);
    }

    // 结果只发一次:cancel/timeout/spawn-failed/close 先到先得。
    let settled = false;
    let stdout = "";
    let stderr = "";
    const push = (sink: string, chunk: Buffer): string => (sink.length >= STREAM_CAP ? sink : sink + chunk.toString());

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* 已死 */ }
      onEvent({ type: "result", result: { ok: false, error: { kind: "timeout", detail: `一次性执行超过 ${timeoutMs}ms,已 SIGKILL(fail-visible)` } } });
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (err) => {
      // ENOENT 等异步 spawn 失败:上抛会带崩宿主(NdjsonChildBackend 同教训),落 typed 错误。
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onEvent({ type: "result", result: { ok: false, error: { kind: "spawn-failed", detail: String(err).slice(0, 200) } } });
    });

    child.stdout!.on("data", (d: Buffer) => { stdout = push(stdout, d); });
    child.stderr!.on("data", (d: Buffer) => { stderr = push(stderr, d); });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        onEvent({ type: "result", result: { ok: true, finalText: stdout.trim(), artifacts: [] } });
      } else {
        const tail = stderr.trim().slice(-200);
        onEvent({ type: "result", result: { ok: false, error: { kind: "backend-crash", detail: `exit code ${String(code)}${tail ? ":" + tail : ""}` } } });
      }
    });

    onEvent({ type: "ready" });
    onEvent({ type: "progress", note: `CLI ${this.kind} 一次性执行中` });
    if (built.stdin !== undefined) {
      try {
        child.stdin!.write(built.stdin);
        child.stdin!.end();
      } catch {
        // CLI 提前退出(EPIPE)时写 stdin 会抛;结果由 close/error 裁决,这里不吞错误信息。
      }
    }

    return {
      taskId: spec.taskId,
      pid: child.pid,
      async cancel(mode) {
        if (settled) return; // 已有结果(可能已自然退出),不再补发 cancelled
        settled = true;
        clearTimeout(timer);
        onEvent({ type: "result", result: { ok: false, error: { kind: "cancelled", detail: `cancel(${mode}) 触发,进程已终止` } } });
        if (child.exitCode !== null || child.signalCode !== null) return;
        try { child.kill(mode === "force" ? "SIGKILL" : "SIGTERM"); } catch { /* 已死 */ }
        if (mode === "graceful") {
          await new Promise((r) => setTimeout(r, KILL_GRACE_MS));
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill("SIGKILL"); } catch { /* 已死 */ }
          }
        }
      },
      async steer() {
        return false; // 一次性 CLI 无运行中干预语义
      },
      async respondPermission() {
        // 一次性 CLI 不产生 permission-ask,无回流面
      },
    };
  }
}

/** spawn 同步失败时的死句柄(结果已发,一切操作 no-op)。 */
function deadHandle(taskId: string): SubagentHandle {
  return {
    taskId,
    async cancel() {},
    async steer() { return false; },
    async respondPermission() {},
  };
}

/**
 * ZcodeCliBackend(kind=zcode-headless):驱动外部 `zcode` CLI 的一次性后端。
 * 缺省策略:`zcode [flags]` + 指令经 stdin(无公开文档化的一次性 flag,诚实登记待真机标定)。
 */
export class ZcodeCliBackend extends CliOneShotBackend {
  readonly kind = "zcode-headless";
  protected override get defaultBin(): string { return "zcode"; }
  protected override get instructionViaStdin(): boolean { return true; }
  protected override instructionArgs(_instruction: string): string[] { return []; }
}

/**
 * OpencodeCliBackend(kind=opencode-run):驱动外部 `opencode` CLI 的一次性后端。
 * 缺省策略:`opencode run <instruction>`(官方文档化非交互 headless 模式);
 * --format json 等经 opts.args 携带——注意指令恒拼在最后,需要其它形态时用 buildCommand 接管。
 */
export class OpencodeCliBackend extends CliOneShotBackend {
  readonly kind = "opencode-run";
  protected override get defaultBin(): string { return "opencode"; }
  protected override get instructionViaStdin(): boolean { return false; }
  protected override instructionArgs(instruction: string): string[] { return [instruction]; }
}

export type CliBackendKind = "zcode" | "opencode";

/** 工厂:gateway 接线方(executor.kind switch)按 kind 取后端;未知 kind 显式抛(fail-visible)。 */
export function createCliBackend(kind: CliBackendKind, opts: CliBackendOptions = {}): SubagentBackend {
  switch (kind) {
    case "zcode":
      return new ZcodeCliBackend(opts);
    case "opencode":
      return new OpencodeCliBackend(opts);
  }
  throw new Error(`createCliBackend:未知 kind ${String(kind)}(支持 zcode|opencode,fail-visible 不猜)`);
}
