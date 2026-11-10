/**
 * node-agent:远程执行节点。连 gateway、注册能力/可达性、心跳、接任务、跑 executor、回报。
 * node.task.dispatch 真执行+凭证引用本地解析
 * (值只进子进程 env,不进指令文本——输出回流不含值,红线:值不过网关)。
 * 二期( §5):GENIE_NODE_JUMPWEB=1 注册 "jumpweb" 任务 kind——
 * 跳板机网页登录执行器(录制脚本+凭证本地解析+输出回放校验);未启用时行为与旧版完全一致。
 */
import WebSocket from "ws";
import { readFileSync, existsSync } from "node:fs";
import { createJumpWebHandler, type JumpWebDriver, type JumpWebHandleResult, type JumpWebTaskInput } from "./jumpweb.js";

export * from "./jumpweb.js";

/**
 * 本机负载采样(节点 Fleet「真实负载」):与 gateway 侧 load-sample.ts 同一口径
 * (cpu=1m 负载均值/核数,mem=1-可用/总量,runningTasks=委派执行并发)。独立小函数就地放——
 * node-agent 是独立分发单文件,不为 10 行采样引 workspace 依赖。
 */
import os from "node:os";
export function sampleNodeLoad(runningTasks = 0): { cpu: number; mem: number; runningTasks: number } {
  const cpus = os.cpus().length || 1;
  const cpu = Math.max(0, Math.min(1, (os.loadavg()[0] ?? 0) / cpus));
  const total = os.totalmem();
  const mem = total > 0 ? Math.max(0, Math.min(1, (total - os.freemem()) / total)) : 0;
  return { cpu, mem, runningTasks };
}

export interface NodeAgentOptions {
  gatewayUrl: string;
  nodeId: string;
  kind: "pc" | "server" | "jump";
  capabilities: string[];
  reachability: string[];
  /** 心跳间隔。 */
  heartbeatMs?: number;
  /** 本地凭据库(JSON:{ref: value});缺省=$GENIE_NODE_CREDENTIALS 或无(任务带 ref 但无库=执行失败,fail-visible)。 */
  credentialsFile?: string;
  /** 本地执行后端;缺省=子进程 echo。 */
  execute?: (instruction: string, env: Record<string, string>) => Promise<{ ok: boolean; output: string; error?: string }>;
  /**
 * 跳板机网页执行器驱动工厂(playwright 系; §5。playwright 非本仓依赖,由部署侧注入;
   * 未注入时 jumpweb 任务逐个 typed 失败 fail-visible,不伪造成功)。
   */
  jumpwebDriverFactory?: () => JumpWebDriver | Promise<JumpWebDriver>;
  /** 显式 jumpweb 处理器(测试/高级注入);false=强制关;缺省=按 GENIE_NODE_JUMPWEB=1 构造。 */
  jumpweb?: { handle: (task: JumpWebTaskInput) => Promise<JumpWebHandleResult> } | false;
}

function loadCredentials(file?: string): Record<string, string> {
  const path = file ?? process.env.GENIE_NODE_CREDENTIALS;
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function startNodeAgent(opts: NodeAgentOptions): { close: () => void } {
  const ws = new WebSocket(opts.gatewayUrl);
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  const credentials = loadCredentials(opts.credentialsFile);

 // 跳板机网页执行器( §5):GENIE_NODE_JUMPWEB=1 才注册;未启用=行为与旧版一致。
 // 凭证解析走同一本地凭据库(语义:值只在节点解析,不进指令/日志/回流)。
  const jumpwebHandler = opts.jumpweb === false
    ? undefined
    : opts.jumpweb ?? (process.env.GENIE_NODE_JUMPWEB === "1"
        ? createJumpWebHandler({
            driver: opts.jumpwebDriverFactory,
            resolveCredential: (name: string): string => {
              if (name in credentials) return credentials[name]!;
              throw new Error(`本地凭据库无引用 ${name}(fail-visible,不猜)`);
            },
          })
        : undefined);

 // 委派执行并发计数(心跳 runningTasks 语义=正在执行的委派任务数)。
  let activeDispatches = 0;

  ws.on("open", () => {
    ws.send(JSON.stringify({
      v: 1, type: "node.register",
      nodeId: opts.nodeId,
      capabilities: opts.capabilities,
      reachability: opts.reachability,
    }));
  });

  const timer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
 // 真实负载(旧硬编码 {0,0,0}——面板 Fleet 的 cpu/mem 恒零占位)。
      ws.send(JSON.stringify({
        v: 1, type: "node.heartbeat", nodeId: opts.nodeId,
        load: sampleNodeLoad(activeDispatches),
      }));
    }
  }, heartbeatMs);
  timer.unref?.();

 // 连接失败/中断的 error 必须接住:CONNECTING 态 terminate 会异步 emit error,
  // 无监听=unhandled 污染宿主退出码(一期无重连策略,静默退出)。
  ws.on("error", () => {});

  ws.on("message", (raw: Buffer) => {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "node.task.dispatch") {
      activeDispatches++;
      void handleDispatch(ws, opts, credentials, jumpwebHandler, msg).finally(() => {
        activeDispatches = Math.max(0, activeDispatches - 1);
      });
    }
  });

  return {
    close: () => {
      clearInterval(timer);
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
      } catch {
        // best effort
      }
    },
  };
}

async function handleDispatch(
  ws: WebSocket,
  opts: NodeAgentOptions,
  credentials: Record<string, string>,
  jumpwebHandler: { handle: (task: JumpWebTaskInput) => Promise<JumpWebHandleResult> } | undefined,
  msg: { [k: string]: unknown },
): Promise<void> {
  const taskId = String(msg.taskId ?? "");
  const instruction = String(msg.instruction ?? "");
  const credentialRef = msg.credentialRef ? String(msg.credentialRef) : undefined;
  const send = (payload: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ v: 1, ...payload }));
  };

  if (!taskId || !instruction) {
    send({ type: "node.task.result", nodeId: opts.nodeId, taskId, ok: false, error: "任务书缺字段" });
    return;
  }

 // 二期( §5):kind=jumpweb 且执行器已启用 → 跳板机网页登录链路。
  // 未启用时落到下方缺省执行(行为与旧版完全一致)。
  if (msg.kind === "jumpweb" && jumpwebHandler) {
    const credRefs = Array.isArray(msg.credRefs) ? msg.credRefs.map((r) => String(r)) : undefined;
    try {
      const r = await jumpwebHandler.handle({ instruction, script: msg.script, credRefs });
      send({
        type: "node.task.result", nodeId: opts.nodeId, taskId, ok: r.ok, output: r.output,
        ...(r.error ? { error: `${r.error.code}: ${r.error.detail}` } : {}),
      });
    } catch (err) {
      send({ type: "node.task.result", nodeId: opts.nodeId, taskId, ok: false, output: "", error: String(err).slice(0, 200) });
    }
    return;
  }

  // 凭证引用本地解析:值只进子进程 env(CREDENTIAL_<REF>=value),不进指令文本/日志/回流。
  const env: Record<string, string> = {};
  if (credentialRef) {
    if (!(credentialRef in credentials)) {
      send({ type: "node.task.result", nodeId: opts.nodeId, taskId, ok: false, error: `本地凭据库无引用 ${credentialRef}(fail-visible,不猜)` });
      return;
    }
    env[`CREDENTIAL_${credentialRef.replace(/[^A-Za-z0-9_]/g, "_")}`] = credentials[credentialRef]!;
  }
  try {
    const exec = opts.execute ?? defaultExecute;
    const r = await exec(instruction, env);
    send({ type: "node.task.result", nodeId: opts.nodeId, taskId, ok: r.ok, output: r.output, ...(r.error ? { error: r.error } : {}) });
  } catch (err) {
    send({ type: "node.task.result", nodeId: opts.nodeId, taskId, ok: false, error: String(err).slice(0, 200) });
  }
}

/** 缺省执行器:子进程执行(env 注入凭证;输出为确定性回执,不含 env 内容)。 */
async function defaultExecute(instruction: string, env: Record<string, string>): Promise<{ ok: boolean; output: string; error?: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  try {
    const { stdout } = await execFileP("node", ["-e", `console.log(JSON.stringify({executed:true,len:${instruction.length}}))`], {
      env: { ...process.env, ...env },
      timeout: 30_000,
    });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { ok: false, output: "", error: String(err) };
  }
}
