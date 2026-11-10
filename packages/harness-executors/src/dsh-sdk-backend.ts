/**
 * dsh-sdk 后端( P3 复活:spawn 构建好的 dsh CLI(--profile sdk),
 * JSON-RPC over stdio(@deepseek-ai/dsh-sdk-protocol:initialize → session/prompt →
 * session.event 通知流 → session.status 终态)。
 * 与 NdjsonChildBackend 的 spawn/ready/progress 协议不同,直接实现 SubagentBackend。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SubagentBackend, SubagentEvent, SubagentHandle, TaskResult, TaskSpec } from "./ndjson-backend";

export interface DshSdkOptions {
  /** dsh CLI 启动命令(构建产物 bin;源码形态=node --import tsx bin.ts)。 */
  command: { cmd: string; args: string[] };
  /** SDK 路由(dsh 侧 provider/model;deepseek 原生栈)。 */
  provider: string;
  model: string;
  /** 子进程环境(凭证如 DEEPSEEK_API_KEY、DSH_HOME 由调用方注入)。 */
  env?: Record<string, string>;
  /** initialize 握手超时。 */
  initTimeoutMs?: number;
  /** 单任务回合预算(超过=failed budget-exhausted)。 */
  wallClockMs?: number;
}

interface PendingEntry {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class DshSdkBackend implements SubagentBackend {
  readonly kind = "dsh";
  constructor(private readonly opts: DshSdkOptions) {}

  async spawn(spec: TaskSpec, onEvent: (e: SubagentEvent) => void): Promise<SubagentHandle> {
 // PATH 修复:dsh 引擎要求 node≥22,父进程 PATH 里可能是 node20——
    // 把所用 node 的 bin 目录前插,子进程 shell 出的辅助进程拿对版本。
    // profile 参数由本后端补齐(launch 语义=bin --profile sdk;DSH_SDK_CLI 显式帧里已含则不重复)
    const baseArgs = this.opts.command.args.filter((a, i) => !(a === "--profile" || this.opts.command.args[i - 1] === "--profile"));
    const finalArgs = this.opts.command.args.includes("--profile")
      ? this.opts.command.args
      : [...baseArgs, "--profile", "sdk"];
    const nodeBinDir = dirname(this.opts.command.cmd);
    const childPath = nodeBinDir + ":" + (process.env.PATH ?? "");
    const child: ChildProcess = spawn(this.opts.command.cmd, finalArgs, {
      cwd: spec.workdir,
      env: { ...process.env, PATH: childPath, ...(this.opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrTail: string[] = [];
    child.stderr!.on("data", (d: Buffer) => {
      stderrTail.push(d.toString());
      if (stderrTail.length > 20) stderrTail.shift();
    });
 // 连接级 error 必须接住(进程被杀时 emit,无监听=unhandled 崩宿主, 同款)
    child.on("error", () => {});

    const pending = new Map<string, PendingEntry>();
    const request = (method: string, params: unknown, timeoutMs: number): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`dsh sdk ${method} 超时(${timeoutMs}ms)`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
        if (dbg) console.error("[dsh-sdk][in] " + frame.slice(0, 160));
        child.stdin!.write(frame);
      });

    // 事件面:assistant 文本收集 + 工具调用进度
    const texts: string[] = [];
    let lastError = "";
    let settled = false;
    const finish = (r: TaskResult) => {
      if (settled) return;
      settled = true;
      onEvent({ type: "result", result: r });
    };

    const dbg = process.env.DSH_SDK_DEBUG === "1";
    let buf = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      if (dbg) console.error("[dsh-sdk][out] " + chunk.toString().slice(0, 200));
      buf += chunk.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        const id = msg.id as string | undefined;
        if (id && pending.has(id)) {
          const p = pending.get(id)!;
          pending.delete(id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(`dsh sdk ${String((msg.error as { message?: string }).message ?? "error")}`));
          else p.resolve((msg.result ?? {}) as Record<string, unknown>);
          continue;
        }
        const method = msg.method as string | undefined;
        const params = (msg.params ?? {}) as Record<string, unknown>;
        if (method === "session.event") {
          const ev = params.event as Record<string, unknown> | undefined;
 // dsh session-log 信封:字段是 type(非 kind),负载字段在顶层(server.ts 验证)
          const kind = String(ev?.type ?? "");
          if (kind === "assistant/message") {
            const blocks = (ev?.message as { content?: { type?: string; text?: string }[] } | undefined)?.content ?? [];
            for (const b of blocks) if (b.type === "text" && b.text) texts.push(b.text);
          } else if (kind === "tool/call") {
            onEvent({ type: "progress", note: "tool:" + String(ev?.name ?? ""), pct: undefined });
          } else if (kind === "turn/end") {
            // 回合终态(reason=completed/error/aborted/max-tokens…)
            const reason = String(ev?.reason ?? "completed");
            if (reason === "error") {
              finish({ ok: false, error: { kind: "backend-crash", detail: (lastError || stderrTail.join("") || "dsh 回合以 error 结束").slice(0, 300) } });
            } else {
              finish({ ok: true, finalText: texts.join("").slice(0, 64_000) || "(dsh 无文本输出)" });
            }
          } else if (kind === "assistant/attempt") {
            // 未产出表面消息的尝试(失败/重试)——错误细节常在这里
            const streamText = JSON.stringify(ev ?? {}).slice(0, 200);
            if (/error|fail/i.test(streamText)) lastError = streamText;
          }
        } else if (method === "session.status") {
 // 整 agent 生命周期(idle|running),非回合终态——不结算,只播进度(语义修正)
          onEvent({ type: "progress", note: "agent " + String(params.status ?? "") });
        }
      }
    });

    // initialize 握手(fail-visible:坏配置秒级显形)
    let handle: SubagentHandle;
    try {
      await request("initialize", { cwd: spec.workdir, provider: this.opts.provider, model: this.opts.model }, this.opts.initTimeoutMs ?? 20_000);
      onEvent({ type: "ready" });
    } catch (err) {
      child.kill("SIGKILL");
      const stderrDump = stderrTail.join("").slice(-400);
      if (stderrDump) console.error("[dsh-sdk][stderr] " + stderrDump);
      onEvent({ type: "result", result: { ok: false, error: { kind: "spawn-failed", detail: String(err).slice(0, 200) + (stderrDump ? " | stderr: " + stderrDump.slice(0, 200) : "") } } });
      return {
        taskId: spec.taskId,
        pid: child.pid,
        async cancel() { child.kill("SIGKILL"); },
        async steer() { return false; },
        async respondPermission() { /* 初始化失败无会话 */ },
      };
    }

    // 回合预算(dsh 侧无超时;我们兜底)
    const wall = setTimeout(() => {
      lastError = "回合预算耗尽(" + Math.round((this.opts.wallClockMs ?? 600_000) / 1000) + "s)";
      child.kill("SIGKILL");
      finish({ ok: false, error: { kind: "budget-exhausted", detail: lastError } });
    }, this.opts.wallClockMs ?? 600_000);
    const clearWall = () => clearTimeout(wall);
    const origOnEvent = onEvent;
    // 结束时清预算(事件回调里包一层)
    onEvent = (e: SubagentEvent) => { if (e.type === "result") clearWall(); origOnEvent(e); };

 // 派任务:session/prompt 入队;回合由 session.status 通知
    void request("session/prompt", {
      sessionId: "sdk-" + spec.taskId,
      contentBlocks: [{ type: "text", text: spec.instructions }],
    }, 60_000).catch((err: Error) => {
      clearWall();
      finish({ ok: false, error: { kind: "backend-crash", detail: String(err).slice(0, 200) } });
    });

    child.on("exit", (code) => {
      if (!settled) {
        clearWall();
        finish({ ok: false, error: { kind: "backend-crash", detail: "dsh 子进程提前退出(code=" + code + ") " + stderrTail.join("").slice(-200) } });
      }
    });

    handle = {
      taskId: spec.taskId,
      pid: child.pid,
      async cancel() {
        try { await request("shutdown", undefined, 3000); } catch { /* 已死则忽略 */ }
        child.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 1200));
        if (child.exitCode === null) child.kill("SIGKILL");
        clearWall();
        finish({ ok: false, error: { kind: "cancelled", detail: "用户取消" } });
      },
      async steer(text, mode) {
        // dsh sdk 无 steer 方法:hint 以新用户消息追加(directive 不支持,如实 false)
        if (mode !== "hint") return false;
        try {
          await request("session/prompt", { sessionId: "sdk-" + spec.taskId, contentBlocks: [{ type: "text", text: "[补充指示] " + text }] }, 30_000);
          return true;
        } catch { return false; }
      },
      async respondPermission() { /* dsh 权限在其子进程内部审批,不经 SDK 面 */ },
    };
    return handle;
  }
}

/** 解析 dsh CLI 启动命令(构建产物 bin;DSH_SDK_CLI 显式优先,缺省=仓内构建产物)。 */
export function resolveDshCliCommand(repoRoot: string): { cmd: string; args: string[] } | null {
  const envCli = process.env.DSH_SDK_CLI;
  if (envCli) {
    const parsed = JSON.parse(envCli) as { cmd: string; args?: string[] };
    return { cmd: parsed.cmd, args: parsed.args ?? [] };
  }
  const candidates = [
    process.env.HOME + "/dsh-build/apps/cli/lib/bin.js", // 实测构建产物路径
    process.env.HOME + "/dsh-build/apps/cli/dist/bin.mjs",
    process.env.HOME + "/dsh-build/apps/cli/dist/bin.js",
    join3(repoRoot, "deepseek-harness/apps/cli/lib/bin.js"),
    join3(repoRoot, "deepseek-harness/apps/cli/dist/bin.mjs"),
  ];
  for (const c of candidates) if (existsSync(c)) return { cmd: resolveNode22Plus(), args: [c] };
  return null;
}

/** dsh 引擎要求 node ≥22:优先 nvm 安装的 22+/24,回退当前 process(不满足时由子进程自身报错显形)。 */
function resolveNode22Plus(): string {
  const nvmDir = process.env.NVM_DIR ?? process.env.HOME + "/.nvm";
  try {
    const versions = readdirSync(join3(nvmDir, "versions/node"))
      .filter((v) => /^v(2[2-9]|[3-9]\d)\./.test(v))
      .sort()
      .reverse();
    for (const v of versions) {
      const bin = join3(join3(nvmDir, "versions/node"), v) + "/bin/node";
      if (existsSync(bin)) return bin;
    }
  } catch { /* 无 nvm 目录 */ }
  return process.execPath;
}

function join3(a: string, b: string): string {
  return (a.endsWith("/") ? a.slice(0, -1) : a) + "/" + b;
}
