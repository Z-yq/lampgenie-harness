/**
 * ACP 子代理后端:把外部 ACP agent(Claude Code / Codex / Kimi / Hermes / Qwen Code …)
 * 作为一类 SubagentBackend 驱动。
 * 协议:JSON-RPC 2.0 over stdio,一行一帧(ACP v1 稳定词汇):
 *   initialize → session/new → session/prompt → session/update 通知流
 *   → session/request_permission 反向请求 → session/cancel 通知(取消)
 * 零依赖手写 wire:资源纪律不引入 @agentclientprotocol/sdk(仓内未安装,且 ACP client 面很小);
 * 字段与参考实现逐点对齐(见 「参考实现」表)。
 * 契约与 LlmLoopBackend/DshSdkBackend 同语义:
 * - 事件经 onEvent 流(ready/progress/permission-ask/result);结果只发一次(settled 守卫)。
 * - finalText = 全部 agent_message_chunk 文本拼接(上限 64k,与 DshSdkBackend 同口径)。
 * - fail-visible:adapter 缺失/协议版本不兼容/未知 stopReason 一律 typed 错误,绝不静默成功。
 * - 父进程凭证默认不泄漏:子进程 env = scrub(process.env) + 显式 adapterEnv/spec.env(opt-in)。
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { SubagentBackend, SubagentEvent, SubagentHandle, TaskResult, TaskSpec } from "./ndjson-backend";

/** ACP 协议版本(ACP v1;adapter 返回其它版本=fail-visible)。 */
export const ACP_PROTOCOL_VERSION = 1;
/** initialize / session/new 缺省超时。 */
const DEFAULT_INIT_TIMEOUT_MS = 20_000;
/** 单回合缺省超时(可被 spec.budget.wallClockSec 或 opts.promptTimeoutMs 覆盖)。 */
const DEFAULT_PROMPT_TIMEOUT_MS = 600_000;
/** 权限请求等待上限(超时=fail-closed,cancelled)。 */
const DEFAULT_PERMISSION_TIMEOUT_MS = 300_000;
/** 取消时 graceful 等待 adapter 自行的宽限。 */
const DEFAULT_KILL_GRACE_MS = 1_500;
/** finalText 上限(与 DshSdkBackend 的 64k 一致)。 */
const TEXT_CAP = 64_000;
/** stderr 尾巴上限(诊断用,防噪声内存)。 */
const STDERR_CAP = 8_000;

/** 内置 adapter 目录(与 qwen-audio-agent 的 ACP drivers 对齐;`install` 用于缺失时的报错指引)。 */
export interface AcpAdapterDefinition {
  cmd: string;
  args: string[];
  label: string;
  install: string;
}

export const ACP_ADAPTERS: Record<string, AcpAdapterDefinition> = {
  "claude-code": {
    cmd: "claude-code-acp",
    args: [],
    label: "Claude Code",
    install: "npm i -g @zed-industries/claude-code-acp(另需 claude CLI 自身认证)",
  },
  codex: {
    cmd: "codex-acp",
    args: [],
    label: "Codex",
    install: "npm i -g @agentclientprotocol/codex-acp(另需 codex login)",
  },
  kimi: {
    cmd: "kimi",
    args: ["acp"],
    label: "Kimi Code",
    install: "npm i -g @moonshot-ai/kimi-code;运行 `kimi login`",
  },
  hermes: {
    cmd: "hermes",
    args: ["acp", "--accept-hooks"],
    label: "Hermes",
    install: "hermes 官方安装脚本;`hermes setup --portal` 完成认证",
  },
  qwen: {
    cmd: "qwen",
    args: ["--acp"],
    label: "Qwen Code",
    install: "npm i -g @qwen-code/qwen-code;首次启动完成 /auth",
  },
  opencode: {
    cmd: "opencode",
    args: ["acp"],
    label: "OpenCode",
    install: "npm i -g opencode-ai;`opencode auth login`",
  },
  dsh: {
    cmd: "dsh",
    args: ["--profile", "acp"],
    label: "DeepSeek Harness",
    install: "npm i -g @deepseek-ai/dsh",
  },
  minimax: {
    cmd: "mcode",
    args: ["acp"],
    label: "MiniMax Code",
    install: "npm i -g @minimax-ai/code",
  },
};

/** 解析后的 adapter 调用描述。 */
export interface AcpAdapterSpec {
  command: string;
  args: string[];
  label: string;
}

export type AcpPermissionPolicy = "ask" | "allow" | "reject";

export interface AcpBackendOptions {
  /** adapter 可执行文件(显式;优先于 adapter 名字)。 */
  command?: string;
  /** command 的附加参数。 */
  args?: string[];
  /** 内置目录名 / 裸命令行 / JSON {"cmd","args"} / 可执行路径。 */
  adapter?: string;
  /** adapter 附加参数(拼在内置参数之后)。 */
  adapterArgs?: string[];
  /** 显式透传给 adapter 的环境变量(在 scrub 之后合并 = opt-in 凭证通道)。 */
  env?: Record<string, string>;
  /** initialize/session-new 超时(缺省 20s)。 */
  initTimeoutMs?: number;
  /** 单回合超时(缺省 spec.budget.wallClockSec×1000,再缺省 600s)。 */
  promptTimeoutMs?: number;
  /** 权限请求等待上限(缺省 300s,超时即可 fail-closed 取消)。 */
  permissionTimeoutMs?: number;
  /** 权限策略:ask=经 SubagentEvent.permission-ask 回流(缺省);allow/reject=自动应答。 */
  permissionPolicy?: AcpPermissionPolicy;
 /** graceful cancel 等待 adapter 的宽限(缺省 1500ms)。 */
  killGraceMs?: number;
  /** false=不剔除父进程凭证(缺省 true;仅测试/受控场景关闭)。 */
  scrubEnv?: boolean;
  /** true=经 shell 启动 adapter(Windows .cmd shim 用;缺省 false)。 */
  shell?: boolean;
  /** initialize 的 clientInfo.name(缺省 lampgenie-harness)。 */
  clientName?: string;
}

/** 把 spawn_subagent 的参数面搓成 backend(adapter 未给时由 env GENIE_ACP_ADAPTER 兜底)。 */
export interface AcpSpawnParams {
  adapter?: string;
  adapterArgs?: string[];
  adapterEnv?: Record<string, string>;
}

export function createAcpBackend(params: AcpSpawnParams = {}, opts: AcpBackendOptions = {}): AcpBackend {
  return new AcpBackend({
    ...opts,
    ...(params.adapter ? { adapter: params.adapter } : {}),
    ...(params.adapterArgs ? { adapterArgs: params.adapterArgs } : {}),
    ...(params.adapterEnv ? { env: { ...(opts.env ?? {}), ...params.adapterEnv } } : {}),
  });
}

/** 内置目录名清单(报错指引用)。 */
export function listAcpAdapters(): string[] {
  return Object.keys(ACP_ADAPTERS);
}

/**
 * 解析 adapter:显式 input > env GENIE_ACP_ADAPTER > null。
 * 形态:内置目录名 / JSON {"cmd":string,"args"?:string[],"label"?:string} / 裸命令行(空白拆分)。
 * 额外参数 = env GENIE_ACP_ADAPTER_ARGS(JSON 数组) + extraArgs。
 */
export function resolveAcpAdapter(
  input?: string,
  extraArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env): AcpAdapterSpec | null {
  const raw = (input ?? env.GENIE_ACP_ADAPTER ?? "").trim();
  if (!raw) return null;
  const envExtra = parseStringArray(env.GENIE_ACP_ADAPTER_ARGS, "GENIE_ACP_ADAPTER_ARGS");
  const tail = [...envExtra, ...extraArgs];
  const known = ACP_ADAPTERS[raw];
  if (known) return { command: known.cmd, args: [...known.args, ...tail], label: known.label };
  if (raw.startsWith("{")) {
    let parsed: { cmd?: unknown; args?: unknown; label?: unknown };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch (err) {
      throw new Error(`GENIE_ACP_ADAPTER JSON 解析失败:${String(err).slice(0, 160)}`);
    }
    if (typeof parsed.cmd !== "string" || !parsed.cmd.trim()) {
      throw new Error('GENIE_ACP_ADAPTER JSON 缺 cmd:需要 {"cmd":"...","args":[...]}');
    }
    const args = Array.isArray(parsed.args) ? parsed.args.map(String) : [];
    return {
      command: parsed.cmd.trim(),
      args: [...args, ...tail],
      label: typeof parsed.label === "string" && parsed.label ? parsed.label : parsed.cmd.trim(),
    };
  }
  const parts = raw.split(/\s+/).filter(Boolean);
  const command = parts[0];
  if (!command) return null;
  return { command, args: [...parts.slice(1), ...tail], label: command };
}

/** env 里的 JSON 字符串数组(非法=抛错,坏配置不静默)。 */
function parseStringArray(raw: string | undefined, label: string): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("不是数组");
    return parsed.map(String);
  } catch (err) {
    throw new Error(`${label} 解析失败(需要 JSON 数组):${String(err).slice(0, 160)}`);
  }
}

/** env 里的 JSON 对象(显式 env 透传);非法=空(该变量只做 opt-in,坏值不阻塞主流程)。 */
function parseEnvOverrides(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** 凭证名模式:父进程的密钥默认不进子进程(显式 adapterEnv 才放行)。 */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** 剔除父进程凭证的环境副本(保留 PATH/HOME 等 adapter 认证与运行必需项)。 */
export function scrubEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (SECRET_NAME.test(k)) continue;
    out[k] = v;
  }
  return out;
}

type JsonRpcId = string | number;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRpc {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

interface RpcHandlers {
  onNotification: (method: string, params: Record<string, unknown>) => void;
  onRequest: (method: string, params: Record<string, unknown>, id: JsonRpcId) => void;
}

/**
 * 最小 JSON-RPC 2.0 over NDJSON(stdout 一行一帧)。
 * - 请求(id 自增)带可选超时;通知无 id;反向请求交给 onRequest(由调用方异步应答)。
 * - 解析失败的行(adapter 日志)静默跳过;连接关闭时 failAll 拒绝未决请求。
 */
class JsonRpcStdio {
  private readonly pending = new Map<string, PendingRpc>();
  private nextId = 1;
  private buffer = "";
  private closed = false;

  constructor(private readonly child: ChildProcess, private readonly handlers: RpcHandlers) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      this.feed(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 0): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error("ACP 连接已关闭"));
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const entry: PendingRpc = { resolve, reject };
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          if (this.pending.delete(String(id))) reject(new Error(`ACP ${method} 超时(${timeoutMs}ms)`));
        }, timeoutMs);
        timer.unref?.();
        entry.timer = timer;
      }
      this.pending.set(String(id), entry);
      if (!this.write({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(String(id));
        if (entry.timer) clearTimeout(entry.timer);
        reject(new Error("ACP 写入失败(stdin 已关闭)"));
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: JsonRpcId, result: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: JsonRpcId, message: string, code = -32601): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /** 关闭连接:拒绝全部未决请求(进程退出/初始化失败路径)。 */
  failAll(error: Error): void {
    this.closed = true;
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private write(frame: JsonRpcMessage): boolean {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) return false;
    try {
      this.child.stdin.write(JSON.stringify(frame) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  private feed(text: string): void {
    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue; // 非 JSON 行(adapter 日志)忽略
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
    if (typeof msg.method === "string") {
      if (msg.id !== undefined && msg.id !== null) this.handlers.onRequest(msg.method, params, msg.id);
      else this.handlers.onNotification(msg.method, params);
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const key = String(msg.id);
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    if (msg.error) {
      const code = msg.error.code === undefined ? "" : ` ${msg.error.code}`;
      entry.reject(new Error(`ACP 错误${code}:${String(msg.error.message ?? "unknown")}`));
      return;
    }
    entry.resolve((msg.result && typeof msg.result === "object" ? msg.result : {}) as Record<string, unknown>);
  }
}

interface AcpContentBlock {
  type?: string;
  text?: string;
}

interface AcpPermissionOption {
  optionId?: unknown;
  kind?: unknown;
}

/** 权限 option 选择:allow → allow_once(回退 allow_always);reject → reject_once(回退 reject_always)。 */
function selectPermissionOption(options: AcpPermissionOption[], decision: "allow-once" | "reject"): string | undefined {
  const wanted = decision === "allow-once" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of wanted) {
    const hit = options.find((o) => o.kind === kind && typeof o.optionId === "string");
    if (hit) return hit.optionId as string;
  }
  return undefined;
}

/** 权限请求摘要(≤160 字;控制字符压平)。 */
function summarizePermission(params: Record<string, unknown>): { summary: string; risk: "low" | "high" } {
  const toolCall = (params.toolCall && typeof params.toolCall === "object" ? params.toolCall : {}) as Record<string, unknown>;
  const title = String(toolCall.title ?? toolCall.name ?? "外部 agent 请求权限").replace(/\s+/g, " ").trim();
  const rawInput = (toolCall.rawInput && typeof toolCall.rawInput === "object" ? toolCall.rawInput : {}) as Record<string, unknown>;
  const detail = String(rawInput.command ?? rawInput.path ?? rawInput.description ?? "").replace(/\s+/g, " ").trim();
  const summary = (detail ? `${title} — ${detail}` : title).slice(0, 160);
  const kind = String(toolCall.kind ?? "");
  const risk = /^(edit|delete|move|execute)$/.test(kind) ? "high" : "low";
  return { summary, risk };
}

/** session/update → progress note(tool_call/tool_call_update 归一)。 */
function toolNote(update: Record<string, unknown>): string {
  const title = String(update.title ?? update.toolCallId ?? "").replace(/\s+/g, " ").slice(0, 100);
  const kind = String(update.kind ?? "?");
  const status = String(update.status ?? "");
  return `tool:${kind}:${title}${status ? ` [${status}]` : ""}`.slice(0, 160);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deadHandle(taskId: string): SubagentHandle {
  return {
    taskId,
    async cancel() {},
    async steer() { return false; },
    async respondPermission() {},
  };
}

export class AcpBackend implements SubagentBackend {
  readonly kind = "acp";
  /** 配置面 adapter 标识(journal/面板用;实际解析在 spawn 时,env 兜底）。 */
  readonly adapterHint?: string;

  constructor(private readonly opts: AcpBackendOptions = {}) {
    this.adapterHint = opts.adapter ?? opts.command ?? process.env.GENIE_ACP_ADAPTER;
  }

  async spawn(spec: TaskSpec, onEvent: (e: SubagentEvent) => void): Promise<SubagentHandle> {
    let adapter: AcpAdapterSpec | null;
    try {
      adapter = this.opts.command
        ? {
            command: this.opts.command,
            args: [...(this.opts.args ?? []), ...(this.opts.adapterArgs ?? [])],
            label: this.opts.adapter ?? this.opts.command,
          }
        : resolveAcpAdapter(this.opts.adapter, this.opts.adapterArgs ?? []);
    } catch (err) {
      onEvent({ type: "result", result: { ok: false, error: { kind: "spawn-failed", detail: String(err).slice(0, 300) } } });
      return deadHandle(spec.taskId);
    }
    if (!adapter) {
      const catalog = listAcpAdapters().map((n) => `${n}(${ACP_ADAPTERS[n]!.cmd}${ACP_ADAPTERS[n]!.args.length ? " " + ACP_ADAPTERS[n]!.args.join(" ") : ""})`).join(", ");
      onEvent({
        type: "result",
        result: {
          ok: false,
          error: {
            kind: "spawn-failed",
            detail: `未配置 ACP adapter:spawn_subagent 传 adapter(内置:${catalog};或传可执行命令/JSON {"cmd","args"}),或设置 env GENIE_ACP_ADAPTER。`,
          },
        },
      });
      return deadHandle(spec.taskId);
    }

    // 子进程 env:scrub(父凭证默认不泄漏) + GENIE_ACP_ENV / opts.env / spec.env(显式 opt-in)。
    const baseEnv: Record<string, string> = this.opts.scrubEnv === false
      ? Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
      : scrubEnvironment(process.env);
    const childEnv: Record<string, string> = {
      ...baseEnv,
      ...parseEnvOverrides(process.env.GENIE_ACP_ENV),
      ...this.opts.env,
      ...spec.env,
    };

    let child: ChildProcess;
    try {
      child = spawn(adapter.command, adapter.args, {
        cwd: spec.workdir,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: this.opts.shell ?? process.env.GENIE_ACP_SHELL === "1",
      });
    } catch (err) {
      onEvent({ type: "result", result: { ok: false, error: { kind: "spawn-failed", detail: String(err).slice(0, 200) } } });
      return deadHandle(spec.taskId);
    }

    let settled = false;
    let stage: "init" | "prompt" = "init";
    let sessionId: string | undefined;
    let cancelRequested = false;
    let stderrTail = "";
    let sawThought = false;
    const textChunks: string[] = [];
    const pendingPermissions = new Map<string, { rpcId: JsonRpcId; timer: NodeJS.Timeout; options: AcpPermissionOption[] }>();
    let timeoutTimer: NodeJS.Timeout | undefined;
    let onParentAbort: (() => void) | undefined;
    let resolvePromptSettled!: () => void;
    const promptSettled = new Promise<void>((resolve) => { resolvePromptSettled = resolve; });

    const killChild = (signal: NodeJS.Signals): void => {
      try { child.kill(signal); } catch { /* 已死 */ }
    };

    // 结果只发一次(自然结束/取消/超时/崩溃先到先得),随后异步收尸(不阻塞事件流)。
    let disposal: Promise<void> | undefined;
    const disposeProcess = (graceMs = 400): Promise<void> => (disposal ??= (async () => {
      try { child.stdin?.end(); } catch { /* 已关闭 */ }
      await sleep(graceMs);
      if (child.exitCode === null && child.signalCode === null) killChild("SIGTERM");
      await sleep(300);
      if (child.exitCode === null && child.signalCode === null) killChild("SIGKILL");
    })());

    const settle = (result: TaskResult): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (onParentAbort && spec.parentSignal) spec.parentSignal.removeEventListener("abort", onParentAbort);
      for (const p of pendingPermissions.values()) clearTimeout(p.timer);
      pendingPermissions.clear();
      onEvent({ type: "result", result });
      void disposeProcess();
    };

    const rpc = new JsonRpcStdio(child, {
      onNotification: (method, params) => {
        if (method !== "session/update") return; // 未知通知容忍(协议扩展)
        const update = (params.update && typeof params.update === "object" ? params.update : undefined) as Record<string, unknown> | undefined;
        if (!update) return;
        const kind = String(update.sessionUpdate ?? "");
        switch (kind) {
          case "agent_message_chunk": {
            const content = (update.content && typeof update.content === "object" ? update.content : undefined) as AcpContentBlock | undefined;
            if (content?.type === "text" && typeof content.text === "string") textChunks.push(content.text);
            break;
          }
          case "agent_thought_chunk":
            if (!sawThought) {
              sawThought = true;
              onEvent({ type: "progress", note: "thinking…" });
            }
            break;
          case "tool_call":
          case "tool_call_update":
            onEvent({ type: "progress", note: toolNote(update) });
            break;
          case "plan": {
            const steps = Array.isArray(update.entries) ? update.entries.length : 0;
            onEvent({ type: "progress", note: `plan:${steps} steps` });
            break;
          }
          default:
            break; // usage_update 等扩展更新容忍(不影响终态)
        }
      },
      onRequest: (method, params, rpcId) => {
        if (method !== "session/request_permission") {
          // 未知反向请求:按 JSON-RPC 回错误,避免 adapter 挂死等待。
          rpc.respondError?.(rpcId, `lampgenie-harness 不支持 ${method}`);
          return;
        }
        const policy = this.opts.permissionPolicy ?? "ask";
        const options = (Array.isArray(params.options) ? params.options : []) as AcpPermissionOption[];
        if (policy !== "ask") {
          const optionId = selectPermissionOption(options, policy === "allow" ? "allow-once" : "reject");
          rpc.respond(rpcId, optionId
            ? { outcome: { outcome: "selected", optionId } }
            : { outcome: { outcome: "cancelled" } });
          return;
        }
        const requestId = String(rpcId);
        const { summary, risk } = summarizePermission(params);
        const timer = setTimeout(() => {
          if (!pendingPermissions.delete(requestId)) return;
          rpc.respond(rpcId, { outcome: { outcome: "cancelled" } });
          onEvent({ type: "progress", note: `ACP 权限请求超时(已自动拒绝):${summary}` });
        }, this.opts.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS);
        timer.unref?.();
        pendingPermissions.set(requestId, { rpcId, timer, options });
        onEvent({ type: "permission-ask", requestId, summary, risk });
      },
    });

    // 句柄先建(取消信号可能在 initialize 期间到达;getter 读闭包状态)。
    const handle: SubagentHandle = {
      taskId: spec.taskId,
      get pid() { return child.pid; },
      get acpSessionId() { return sessionId; },
      get acpAdapter() { return adapter.label; },
      cancel: async (mode) => {
        if (settled) return;
        cancelRequested = true;
        if (sessionId) {
          try { rpc.notify("session/cancel", { sessionId }); } catch { /* 已断开 */ }
        }
        if (mode === "graceful") {
          await Promise.race([promptSettled, sleep(this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS)]);
        }
        const text = textChunks.join("").slice(0, TEXT_CAP);
        settle({
          ok: false,
          ...(text ? { finalText: text } : {}),
          error: { kind: "cancelled", detail: mode === "force" ? "cancel(force):进程强制终止" : "cancel:已发送 session/cancel 并终止 adapter" },
        });
        if (mode === "force") {
          killChild("SIGKILL");
          return;
        }
        killChild("SIGTERM");
        await sleep(800);
        if (child.exitCode === null && child.signalCode === null) killChild("SIGKILL");
      },
      steer: async () => false, // ACP prompt 是单回合请求,无运行中干预语义(如实 false)
      respondPermission: async (requestId, decision) => {
        const pending = pendingPermissions.get(requestId);
        if (!pending) return; // 已应答/已超时:幂等忽略
        pendingPermissions.delete(requestId);
        clearTimeout(pending.timer);
        const optionId = selectPermissionOption(pending.options, decision);
        rpc.respond(pending.rpcId, optionId
          ? { outcome: { outcome: "selected", optionId } }
          : { outcome: { outcome: "cancelled" } });
      },
    };

 // 父中止信号 → 同一取消路径(父子取消语义)。
    onParentAbort = (): void => { void handle.cancel("graceful"); };
    if (spec.parentSignal) {
      if (spec.parentSignal.aborted) onParentAbort();
      else spec.parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_CAP);
    });
    child.on("error", (err) => {
      rpc.failAll(err);
      settle({ ok: false, error: { kind: "spawn-failed", detail: `adapter 启动失败(${adapter.command}):${String(err).slice(0, 200)}` } });
    });
    child.on("exit", (code, signal) => {
      rpc.failAll(new Error(`ACP adapter 进程退出(code=${String(code)},signal=${String(signal)})`));
      if (settled) return;
      const tail = stderrTail.trim().slice(-200);
      settle({
        ok: false,
        error: {
          kind: stage === "init" ? "spawn-failed" : "backend-crash",
          detail: `ACP adapter 提前退出(code=${String(code)},signal=${String(signal)})${tail ? ":" + tail : ""}`,
        },
      });
    });

    // initialize 握手 + 会话创建(fail-visible:坏 adapter/版本不兼容秒级显形)。
    try {
      const init = await rpc.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: this.opts.clientName ?? "lampgenie-harness" },
      }, this.opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS);
      if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new Error(`ACP 协议版本不兼容(adapter=${String(init.protocolVersion)},harness=${ACP_PROTOCOL_VERSION})`);
      }
      const session = await rpc.request("session/new", { cwd: spec.workdir, mcpServers: [] }, this.opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS);
      const sid = session.sessionId;
      if (typeof sid !== "string" || !sid) throw new Error("ACP session/new 未返回 sessionId(协议违约)");
      sessionId = sid;
    } catch (err) {
      const tail = stderrTail.trim().slice(-200);
      settle({
        ok: false,
        error: {
          kind: "spawn-failed",
          detail: `${String(err).slice(0, 200)}${tail ? " | stderr: " + tail : ""}`,
        },
      });
      killChild("SIGKILL");
      return handle;
    }
    if (settled) return handle; // initialize 期间已被取消

    stage = "prompt";
    onEvent({ type: "ready" });
    onEvent({ type: "progress", note: `acp session ${sessionId}` });

    // 回合预算:超时先发 session/cancel(协作),再按统一收尸阶梯 SIGTERM→SIGKILL(权威);落 timeout。
    const budgetMs = this.opts.promptTimeoutMs
      ?? (spec.budget?.wallClockSec ? spec.budget.wallClockSec * 1000 : DEFAULT_PROMPT_TIMEOUT_MS);
    timeoutTimer = setTimeout(() => {
      if (settled) return;
      try { rpc.notify("session/cancel", { sessionId }); } catch { /* 已断开 */ }
      settle({ ok: false, error: { kind: "timeout", detail: `ACP prompt 超过 ${budgetMs}ms,已发送 session/cancel 并终止 adapter` } });
    }, budgetMs);
    timeoutTimer.unref?.();

    const promptPromise = rpc.request("session/prompt", {
      sessionId: sessionId!,
      prompt: [{ type: "text", text: spec.instructions }],
    }, 0);

    promptPromise
      .then((res) => {
        if (settled) return;
        const stop = String(res.stopReason ?? "");
        const text = textChunks.join("").slice(0, TEXT_CAP);
        const partial = text ? { finalText: text } : {};
        switch (stop) {
          case "end_turn":
            settle({ ok: true, finalText: text || "(acp 无文本输出)", artifacts: [] });
            break;
          case "max_tokens":
          case "max_turn_requests":
            settle({ ok: false, ...partial, error: { kind: "budget-exhausted", detail: `adapter stopReason=${stop}` } });
            break;
          case "cancelled":
            settle({ ok: false, ...partial, error: { kind: "cancelled", detail: cancelRequested ? "已按 session/cancel 取消" : "adapter 报告 cancelled" } });
            break;
          case "refusal":
            settle({ ok: false, ...partial, error: { kind: "backend-crash", detail: "adapter 拒绝执行(refusal)" } });
            break;
          default:
            settle({ ok: false, ...partial, error: { kind: "backend-crash", detail: `未知 stopReason:${stop || "(缺失)"}(fail-visible)` } });
            break;
        }
      })
      .catch((err: unknown) => {
        if (settled) return;
        settle({ ok: false, error: { kind: "backend-crash", detail: `ACP prompt 失败:${String(err).slice(0, 200)}` } });
      })
      .finally(() => {
        resolvePromptSettled();
        if (onParentAbort && spec.parentSignal) spec.parentSignal.removeEventListener("abort", onParentAbort);
      });

    return handle;
  }
}
