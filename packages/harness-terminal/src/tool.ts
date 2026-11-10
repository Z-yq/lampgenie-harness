/**
 * agent 工具 `terminal`:open/send/read/close/list。
 * 设计纪律:
 * - owner 由工具工厂硬绑定(主 agent 任务 sessionId),模型无法在参数里伪造 owner;
 * - read/list 声明只读(权限闸豁免);open/send/close 是写/执行类,过既有权限规则/ask 链;
 * - cwd 围栏在工具根内(相对路径从根解析,绝对路径必须落在根内);
 * - 输出统一 JSON 字符串(工具结果面),send/read 带 sessionId + cursor 支持增量消费。
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { TerminalSessionService } from "./service.js";
import { JobError, type JobRegistry, type JobStartInput } from "./jobs.js";
import { TerminalError, type TerminalSessionInfo } from "./types.js";

/** 与 @lampgenie/runtime 的 Tool 结构兼容(不引 runtime,避免包间依赖)。 */
export interface TerminalToolLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isReadOnly(args: unknown): boolean;
  isConcurrencySafe(args: unknown): boolean;
  execute(args: unknown): Promise<string>;
}

export interface CreateTerminalToolOptions {
  service: TerminalSessionService;
  /** 精确 owner(生产=task.sessionId)。 */
  owner: string;
  /** cwd 围栏根(生产=taskRoot)。 */
  root: string;
 /** 上下文卫生提醒:开=send/read 输出超过阈值时附 hygieneNote,
   * 提醒调用方(主 coding agent)把大输出工作拆子任务派子代理。子代理装配不传=不打扰(它就是干活的)。 */
  contextHygiene?: { thresholdBytes?: number };
  /** 命令围栏(workspace=工作区内):send 分支**下发前**调用,返回非 null=拒因 → 命令不下发,
   * 直接回 ok:false。未注入=行为逐字不变(ask/auto/readonly/plan 与旧版一致)。 */
  fenceCommand?: (cmd: string) => string | null;
}

/** 上下文卫生尾注(与 gateway file-tools 的 grep 尾注同语义):大输出进入调用方上下文的代价提醒。 */
function hygieneNoteFor(bytes: number, threshold: number): string | undefined {
  if (bytes <= threshold) return undefined;
  return `[上下文卫生] 本次输出 ${Math.round(bytes / 1024)}KB 已进入你的上下文——此类大输出勘察/实施建议拆成子任务派 spawn_subagent(子代理上下文独立,过程细节不污染主轨),你只收结论。`;
}

interface TerminalToolArgs {
  action?: string;
  sessionId?: string;
  cwd?: string;
  name?: string;
  command?: string;
 /** 批量命令:一次往返内按序执行多条,逐条回执合并。
   *  用途:多条探测/验证命令不必各占一轮 LLM(长会话每轮都要重发全量上下文)。
   *  与 command 互斥:同时给则以 commands 为准。任一条失败即停(默认),stopOnError=false 可继续。 */
  commands?: string[];
  /** 批量模式:遇错是否继续(缺省 true=遇错即停,与 shell `set -e` 直觉一致)。 */
  stopOnError?: boolean;
  timeout?: number;
  wait?: boolean;
  cursor?: number;
  waitMs?: number;
}

const DESCRIPTION =
  "Persistent terminal session (PTY): open a named session (optional cwd) / send a command and wait / " +
  "read the increment (pass the previous cursor) / close / list. Division of labour with run_cmd: " +
  "use run_cmd for one-shot commands (build/test/git); use terminal when you need to keep a session alive, " +
  "interactive input, or persistence of cwd/env vars/background processes across commands. " +
  "send's output is only this command's new output; cursor feeds the next read. " +
  "Start long-lived processes with a trailing & or wait=false, then read the output; " +
  "waitReason=timeout means the command may still be running (it is not killed) — keep reading. " +
  "Sessions are isolated per agent session (other sessions/subagents cannot read them).";

const READ_ONLY_ACTIONS = new Set(["read", "list"]);

function safeRealpath(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : resolve(path);
  } catch {
    return resolve(path);
  }
}

/** cwd 围栏:相对=从工具根解析;绝对=必须落在工具根内(realpath 后判定)。 */
function resolveCwd(root: string, requested: string | undefined): string {
  const base = safeRealpath(root);
  const target = !requested || requested === "." ? base : isAbsolute(requested) ? resolve(requested) : resolve(base, requested);
  const real = safeRealpath(target);
  const rel = relative(base, real);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new TerminalError(`cwd 越出工具根: ${requested}`, "INVALID_CWD");
  }
  return real;
}

function renderError(err: unknown): string {
  if (err instanceof TerminalError) {
    return JSON.stringify({ ok: false, code: err.code, error: err.message });
  }
  return JSON.stringify({
    ok: false,
    code: "INTERNAL",
    error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
  });
}

function publicInfo(info: TerminalSessionInfo): Record<string, unknown> {
  // owner 不返回(工具面无需暴露内部键)。
  return {
    sessionId: info.id,
    ...(info.name ? { name: info.name } : {}),
    cwd: info.cwd,
    shell: info.shell,
    ...(info.pid !== undefined ? { pid: info.pid } : {}),
    createdAt: info.createdAt,
    lastActiveAt: info.lastActiveAt,
    status: info.status,
    exitCode: info.exitCode,
    bufferedBytes: info.bufferedBytes,
    cursor: info.cursor,
  };
}

export function createTerminalTool(opts: CreateTerminalToolOptions): TerminalToolLike {
  const { service, owner, root } = opts;
  const hygieneThreshold = opts.contextHygiene?.thresholdBytes ?? 6 * 1024;
  return {
    name: "terminal",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["open", "send", "read", "close", "list"],
          description: "open=start a session; send=run a command; read=take new output; close; list=this session's terminals",
        },
        sessionId: { type: "string", description: "session id (returned by open; required for send/read/close)" },
        cwd: { type: "string", description: "open's working dir (relative to tool root, or an absolute path inside it)" },
        name: { type: "string", description: "open's session name (alnum/._-, unique per owner, optional)" },
        command: { type: "string", description: "send's command (runs in a persistent bash; may contain newlines)" },
        commands: {
          type: "array",
          items: { type: "string" },
          description:
            "send: run several commands in order within ONE round-trip (preferred over calling send repeatedly — " +
            "each extra round-trip re-sends the whole context). Stops on first non-zero exit unless stopOnError:false.",
        },
        stopOnError: { type: "boolean", description: "commands: keep going after a failing command (default false = stop)" },
        timeout: { type: "number", description: "send: seconds to wait for the command (default 30, max 600)" },
        wait: {
          type: "boolean",
          description: "send: wait for completion (default true; use false for interactive or long-lived foreground processes, then read)",
        },
        cursor: { type: "number", description: "read: start cursor (default = last consumed position; use the cursor from the previous result)" },
        waitMs: { type: "number", description: "read: ms to wait for new output (max 5000)" },
      },
      required: ["action"],
    },
    isReadOnly(args: unknown): boolean {
      const action = (args as TerminalToolArgs | undefined)?.action;
      return typeof action === "string" && READ_ONLY_ACTIONS.has(action);
    },
    isConcurrencySafe(): boolean {
      return false;
    },
    async execute(args: unknown): Promise<string> {
      const a = (args ?? {}) as TerminalToolArgs;
      const action = String(a.action ?? "");
      try {
        if (action === "open") {
          const cwd = resolveCwd(root, a.cwd);
          const info = await service.open(owner, { cwd, ...(a.name ? { name: a.name } : {}) });
          return JSON.stringify({
            ok: true,
            ...publicInfo(info),
            hint: "用 send 发命令;一次性命令优先用 run_cmd",
          });
        }
        if (action === "send") {
          if (!a.sessionId) return renderError(new TerminalError("send 需要 sessionId", "INVALID_INPUT"));
          const batch = Array.isArray(a.commands)
            ? a.commands.map((c) => String(c ?? "")).filter((c) => c.trim())
            : [];
          const single = typeof a.command === "string" ? a.command : "";
          if (batch.length === 0 && !single.trim()) {
            return renderError(new TerminalError("send 需要 command 或 commands", "INVALID_INPUT"));
          }
          const timeoutMs =
            typeof a.timeout === "number" && Number.isFinite(a.timeout) ? Math.floor(a.timeout * 1000) : undefined;
 // 批量模式:一次往返按序跑多条,遇错默认即停。
          if (batch.length > 0) {
            const stopOnError = a.stopOnError !== false;
            const runs: Array<{ command: string; ok: boolean; exitCode: number | null; output: string; durationMs: number }> = [];
            let lastSessionId = a.sessionId;
            for (const cmd of batch) {
              const fenced = opts.fenceCommand ? opts.fenceCommand(cmd) : null;
              if (fenced) {
                runs.push({ command: cmd, ok: false, exitCode: null, output: `错误:${fenced}`, durationMs: 0 });
                if (stopOnError) break;
                continue;
              }
              const r = await service.send(owner, lastSessionId, {
                command: cmd,
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                ...(a.wait !== undefined ? { wait: a.wait } : {}),
              });
              lastSessionId = r.sessionId;
              const ok = r.exitCode === 0 || r.exitCode === null;
              runs.push({
                command: cmd,
                ok,
                exitCode: r.exitCode ?? null,
                output: r.output || "(无输出)",
                durationMs: r.durationMs,
              });
              if (!ok && stopOnError) break;
            }
            const failedAt = runs.findIndex((x) => !x.ok);
            return JSON.stringify({
              ok: failedAt < 0,
              sessionId: lastSessionId,
              executed: runs.length,
              total: batch.length,
              ...(failedAt >= 0 ? { failedAt } : {}),
              runs,
              ...(failedAt >= 0 && stopOnError && runs.length < batch.length
                ? { hint: `第 ${failedAt + 1} 条失败已停;剩余 ${batch.length - runs.length} 条未执行(要全跑传 stopOnError:false)` }
                : {}),
            });
          }
          // 命令围栏(workspace=工作区内):下发前判定,拒因非 null 时**不下发**,命令文本零副作用。
          const fenced = opts.fenceCommand ? opts.fenceCommand(single) : null;
          if (fenced) return renderError(new TerminalError(fenced, "INVALID_INPUT"));
          const result = await service.send(owner, a.sessionId, {
            command: single,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(a.wait !== undefined ? { wait: a.wait } : {}),
          });
          return JSON.stringify({
            ok: true,
            sessionId: result.sessionId,
            waitReason: result.waitReason,
            exitCode: result.exitCode,
            output: result.output || "(无输出)",
            cursor: result.cursor,
            durationMs: result.durationMs,
            ...(result.truncated ? { truncated: true } : {}),
            ...(result.waitReason === "timeout"
              ? { hint: "命令可能仍在运行;用 read(带 cursor)继续取增量,或 close 终止会话" }
              : {}),
            ...(result.waitReason === "session-exit" ? { hint: "shell 已退出;该会话不能再执行命令" } : {}),
            ...(opts.contextHygiene ? { hygieneNote: hygieneNoteFor(Buffer.byteLength(result.output ?? ""), hygieneThreshold) } : {}),
          });
        }
        if (action === "read") {
          if (!a.sessionId) return renderError(new TerminalError("read 需要 sessionId", "INVALID_INPUT"));
          const result = await service.read(owner, a.sessionId, {
            ...(typeof a.cursor === "number" ? { cursor: a.cursor } : {}),
            ...(typeof a.waitMs === "number" ? { waitMs: a.waitMs } : {}),
          });
          return JSON.stringify({
            ok: true,
            sessionId: result.sessionId,
            output: result.output || "(无新输出)",
            cursor: result.cursor,
            truncated: result.truncated,
            status: result.status,
            exitCode: result.exitCode,
            ...(opts.contextHygiene ? { hygieneNote: hygieneNoteFor(Buffer.byteLength(result.output ?? ""), hygieneThreshold) } : {}),
          });
        }
        if (action === "close") {
          if (!a.sessionId) return renderError(new TerminalError("close 需要 sessionId", "INVALID_INPUT"));
          const result = await service.close(owner, a.sessionId);
          return JSON.stringify({ ok: true, sessionId: result.sessionId, closed: result.closed, exitCode: result.exitCode });
        }
        if (action === "list") {
          const sessions = service.list(owner).map(publicInfo);
          return JSON.stringify({ ok: true, sessions, count: sessions.length });
        }
        return renderError(
          new TerminalError(`未知 action "${action}"(可用 open/send/read/close/list)`, "INVALID_INPUT"),
        );
      } catch (err) {
        return renderError(err);
      }
    },
  };
}

/* ───────────────────────────── :job 工具 ───────────────────────────── */

export interface CreateJobToolOptions {
  registry: JobRegistry;
  /** 精确 owner(生产=task.sessionId / 子代理=sub-<subTaskId>);模型无法在参数里伪造。 */
  owner: string;
  /** 通知投递路由(缺省=owner)。 */
  sessionId?: string;
  /** cwd 围栏根(生产=taskRoot)。 */
  root: string;
  /** 命令围栏(与 terminal 同口径);返回非 null=拒因。 */
  fenceCommand?: (cmd: string) => string | null;
}

const JOB_DESCRIPTION = `后台命令 job(独立句柄,可 list/read/wait/kill):
- start: 启动一条后台命令(返回 jobId/pid,不阻塞);长任务/构建/测试用它,不要用 shell & 混在会话流。
- list: 本 owner 的 job 列表(状态/pid/字节数/spillPath)。
- read: 按**从启动起的绝对字节 offset** 读增量(返回 nextOffset,eof);输出超过 256KB 会落 spill 文件。
- wait: 等 job 结算(缺省 60s,上限 600s;超时返回 running 快照,不杀 job)。
- kill: 结算本 job(SIGTERM→宽限→SIGKILL);已结算返回既有快照。
错误以稳定码开头:JOB_LIMIT / JOB_FORBIDDEN / JOB_NOT_FOUND / JOB_BAD_CWD。`;

interface JobToolArgs {
  action?: string;
  jobId?: string;
  command?: string;
  cwd?: string;
  title?: string;
  offset?: number;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: string;
}

function renderJobError(err: unknown): string {
  if (err instanceof JobError) {
    const e = err as JobError;
    return JSON.stringify({ ok: false, code: e.code, error: e.message });
  }
  return JSON.stringify({
    ok: false,
    code: "JOB_INTERNAL",
    error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
  });
}

export function createJobTool(opts: CreateJobToolOptions): TerminalToolLike {
  const { registry, owner } = opts;
  if (opts.sessionId) registry.bindOwner(owner, opts.sessionId);
  return {
    name: "job",
    description: JOB_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "list", "read", "wait", "kill"],
          description: "start=启动后台命令; list=本 owner 的 job 列表; read=按绝对字节 offset 增量读; wait=等结算; kill=结算并终止",
        },
        jobId: { type: "string", description: "job id(start 返回;read/wait/kill 必填)" },
        command: { type: "string", description: "start 的命令(Unix 经 bash -lc 执行;Windows 经 cmd /d /s /c)" },
        cwd: { type: "string", description: "start 的工作目录(相对工具根,或工具根内的绝对路径)" },
        title: { type: "string", description: "start 的短标题(列表/通知里显示)" },
        offset: { type: "number", description: "read 的绝对字节偏移(缺省 0;用上次返回的 nextOffset 增量读)" },
        maxBytes: { type: "number", description: "read 单次返回字节上限(缺省 65536)" },
        timeoutMs: { type: "number", description: "wait 超时毫秒(缺省 60000,上限 600000;超时不杀 job)" },
        signal: { type: "string", description: "kill 的初始信号(缺省 SIGTERM,宽限后 SIGKILL)" },
      },
    },
    isReadOnly(args: unknown): boolean {
      const action = String((args as JobToolArgs | null)?.action ?? "");
      return action === "list" || action === "read" || action === "wait";
    },
    isConcurrencySafe(args: unknown): boolean {
      const action = String((args as JobToolArgs | null)?.action ?? "");
      return action === "list" || action === "read" || action === "wait";
    },
    async execute(args: unknown): Promise<string> {
      const a = (args ?? {}) as JobToolArgs;
      const action = String(a.action ?? "");
      try {
        if (action === "start") {
          if (!a.command || !String(a.command).trim()) {
            return renderJobError(new JobError("start 需要 command", "JOB_INVALID_INPUT"));
          }
          if (opts.fenceCommand) {
            const rejected = opts.fenceCommand(String(a.command));
            if (rejected) return renderJobError(new JobError(rejected, "JOB_FORBIDDEN"));
          }
          const input: JobStartInput = {
            command: String(a.command),
            ...(a.cwd ? { cwd: String(a.cwd) } : {}),
            ...(a.title ? { title: String(a.title) } : {}),
            fenceRoot: opts.root,
          };
          const started = registry.start(owner, input);
          return JSON.stringify({ ok: true, jobId: started.jobId, pid: started.pid, startedAt: started.startedAt });
        }
        if (action === "list") {
          const jobs = registry.list(owner);
          return JSON.stringify({ ok: true, jobs: jobs.map((j) => ({ ...j, owner: undefined })), count: jobs.length });
        }
        if (action === "read") {
          if (!a.jobId) return renderJobError(new JobError("read 需要 jobId", "JOB_INVALID_INPUT"));
          const r = registry.read(owner, String(a.jobId), {
            ...(typeof a.offset === "number" ? { offset: a.offset } : {}),
            ...(typeof a.maxBytes === "number" ? { maxBytes: a.maxBytes } : {}),
          });
          return JSON.stringify({
            ok: true,
            jobId: String(a.jobId),
            chunk: r.chunk,
            offset: r.offset,
            nextOffset: r.nextOffset,
            eof: r.eof,
            ...(r.spilled ? { spilled: true, note: "请求的偏移已被内存环淘汰;内容来自 spill 文件" } : {}),
            ...(r.spillPath ? { spillPath: r.spillPath } : {}),
          });
        }
        if (action === "wait") {
          if (!a.jobId) return renderJobError(new JobError("wait 需要 jobId", "JOB_INVALID_INPUT"));
          const info = await registry.wait(owner, String(a.jobId), {
            ...(typeof a.timeoutMs === "number" ? { timeoutMs: a.timeoutMs } : {}),
          });
          return JSON.stringify({ ok: true, ...info, owner: undefined });
        }
        if (action === "kill") {
          if (!a.jobId) return renderJobError(new JobError("kill 需要 jobId", "JOB_INVALID_INPUT"));
          const info = await registry.kill(owner, String(a.jobId), {
            ...(a.signal ? { signal: String(a.signal) } : {}),
          });
          return JSON.stringify({ ok: true, ...info, owner: undefined });
        }
        return renderJobError(
          new JobError(`未知 action "${action}"(可用 start/list/read/wait/kill)`, "JOB_INVALID_INPUT"),
        );
      } catch (err) {
        return renderJobError(err);
      }
    },
  };
}
