/**
 * 会话 worker host(gateway 侧, 设计参考 ZCode(致谢):一会话一进程,gateway 只做聚合)。
 * 职责:对 TaskSupervisor 的 running 任务 fork session-worker 进程;中继 worker 通知进 gateway
 * (journal.appendMany 落账+订阅派发 / task.state 镜像 / 子代理注册表镜像 / 流式出口);
 * 应答 worker RPC(journal 读 / MCP / 权限审批 / wf·askUser / 子代理取消);cancel 下发;
 * 模型热切 reload 广播。fork 工程学抄 sense-index-manager(双形态路径/execArgv 堆帽/stderr
 * tail/失败冷却);ppid 看门狗在 worker 侧(session-worker.ts)。
 * 退化:host 自身不 fallback 进程内(避免双跑);fork 失败=任务显式失败+提示关
 * agent.sessionWorker。测试环境(VITEST)与 GENIE_SESSION_WORKER=off 由 app.ts 决定不装配本 host。
 */
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Journal } from "@lampgenie/core";
import { loadConfig, bus } from "@lampgenie/core";
import type { Task, TaskState } from "@lampgenie/core/task/task";
import type { TaskSupervisor } from "./task-manager.js";
import { createSessionModelFace, createSessionModelStore } from "./session-model.js";
import type { PermissionBroker, PermissionOutcome } from "./permission-broker.js";
import type { SessionWorkerSpec, WorkerToHost, HostToWorker, WorkerRequest } from "./session-worker-protocol.js";
import { SESSION_WORKER_PROTOCOL_VERSION } from "./session-worker-protocol.js";
import { snapshotApprovalObject, verifyApprovalObject } from "./approval-object.js";
// 启动期阶段租约(纯逻辑;ready 超时判决与杀前取证都走它)。
import { STARTUP_STAGES, StartupLease, threadStackHint, type StartupStage } from "./startup-lease.js";
import {
  cleanEnvForOrigin,
  resolveCredential,
  credentialAuditLine,
  type CredentialOrigin,
  type CredentialAuditLine,
} from "./credential-resolver.js";

/* ---------------------------------------------------------------------------
 *  凭证引用 → 子进程执行环境边界。
 * worker 进程默认整份继承 gateway 的 process.env(LLM Key / git token / npm token 全在里面)。
 * 子进程只该看到它跑任务真正需要的那一个凭证:env 从「安全基线」起算,带 credentialRef 时
 * 按 task origin 解析、成功才注入单个变量;失败不注入(fail-closed)并落一条不含值的审计。
 * GENIE_CREDENTIAL_BOUNDARY=off 可整体回退旧行为(整份 env 继承),用于排障/紧急兜底。
 * ------------------------------------------------------------------------- */

/** 读 repoRoot/.genie/secrets.json(与 team-p2p/issue-service 同一读法;失败=空表,绝不抛)。 */
export function readGenieSecrets(repoRoot: string): Record<string, unknown> {
  try {
    const p = join(repoRoot, ".genie", "secrets.json");
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface WorkerEnvOptions {
 /** 清洗来源(缺省 process.env;测试传 fake 基线)。 */
  baseEnv?: Record<string, string | undefined>;
 /** secrets 读取器(缺省空表;生产传 => readGenieSecrets(repoRoot),测试传 fake)。 */
  readSecrets?: () => Record<string, unknown>;
 /** true=回退旧行为(整份 env 原样继承,不清洗不注入);缺省读 GENIE_CREDENTIAL_BOUNDARY。 */
  boundaryOff?: boolean;
 /** 按 origin 覆写允许名单(测试/未来按来源细化用)。 */
  allowNamesByOrigin?: Partial<Record<CredentialOrigin, readonly string[]>>;
}

/** 子进程 env 构建结果:audit 仅在 credentialRef 解析失败时给出(不含明文)。 */
export interface WorkerEnvBuild {
  env: Record<string, string | undefined>;
  audit?: { what: "credential.resolve" } & CredentialAuditLine;
}

/**
 * 构建 fork 子进程的 env:
 * 1) 基线 = cleanEnvForOrigin(baseEnv, "task")(安全基线变量 + task origin 白名单);
 * 2) credentialRef 存在 → resolveCredential(ref,"task",{env,secrets});成功只注入该变量;
 * 3) 失败不注入,返回审计对象(ref/origin/code,不含值)交由调用方落 journal。
 */
export function buildWorkerEnv(credentialRef: string | undefined | null, opts: WorkerEnvOptions = {}): WorkerEnvBuild {
  const baseEnv = opts.baseEnv ?? process.env;
  const off = opts.boundaryOff ?? process.env.GENIE_CREDENTIAL_BOUNDARY === "off";
 // 旧行为:整份 env 原样继承(仍返回副本,不把 process.env 本体交给 fork)
  if (off) return { env: { ...baseEnv } };
  const byOrigin = opts.allowNamesByOrigin;
  const env = cleanEnvForOrigin(baseEnv, "task", byOrigin ? { allowNamesByOrigin: byOrigin } : {});
  const ref = typeof credentialRef === "string" ? credentialRef.trim() : "";
  if (!ref) return { env };
  let secrets: Record<string, unknown> = {};
  try {
    secrets = opts.readSecrets ? opts.readSecrets() : {};
  } catch {
    secrets = {}; // 读失败按空表:解析会落到 MISSING(fail-closed)
  }
  const result = resolveCredential(ref, "task", {
    env: baseEnv,
    secrets,
    ...(byOrigin ? { allowNamesByOrigin: byOrigin } : {}),
  });
  if (!result.ok) {
 // 失败审计只带 code,绝不带值(值和 ref 的明文都不落日志)
    return { env, audit: { what: "credential.resolve", ...credentialAuditLine(ref, "task", result) } };
  }
  return { env: { ...env, ...result.env } };
}

/** 审批对象=执行对象:permission.ask 的可执行面(tool+summary+可选 args)。 */
export interface PermissionAskPayload {
  sessionId?: string;
  tool: string;
  summary: string;
  risk?: string;
  args?: unknown;
}

/**
 * worker 侧 permission.ask 的冻结/复核体。
 * ask 前冻结可执行面;broker 回 allow 后按同一上下文复核,不一致→{decision:"reject"} + object-changed 审计;
 * 冻结失败同样 fail-closed(无法复核就不放行)。
 */
export async function askPermissionWithApprovalObject(
  broker: PermissionBroker,
  journal: Journal | undefined,
  requestId: string,
  payload: PermissionAskPayload): Promise<PermissionOutcome> {
  const approvalObject = () =>
    payload.args === undefined
      ? { tool: payload.tool, summary: payload.summary }
      : { tool: payload.tool, summary: payload.summary, args: payload.args };
  const audit = (event: Record<string, unknown>) => {
    try {
      journal?.append({ kind: "permission.gate", sessionId: payload.sessionId ?? "", payload: event });
    } catch {
      /* 审计失败不影响 fail-closed 判定 */
    }
  };
  const snap = snapshotApprovalObject(approvalObject());
  if (!snap.ok) {
    audit({ tool: payload.tool, effect: "denied", by: "object-snapshot-failed", code: snap.code });
    return { decision: "reject", by: "object-snapshot-failed" };
  }
  const outcome = await broker.ask({
    requestId,
    sessionId: payload.sessionId ?? "",
    tool: payload.tool,
    summary: payload.summary,
    ...(payload.risk ? { risk: payload.risk } : {}),
  });
  if (outcome.decision === "allow-once") {
    const verdict = verifyApprovalObject(snap.frozen, approvalObject());
    if (!verdict.ok) {
      audit({ tool: payload.tool, effect: "object-changed", code: verdict.code, beforeHash: verdict.beforeHash, afterHash: verdict.afterHash, by: "approval-object" });
      return { decision: "reject", by: "object-changed" };
    }
  }
  return outcome;
}

/** fork 失败冷却:连续失败后停一段时间再试(防 dist 缺失/资源枯竭时的 fork 风暴)。 */
const SPAWN_FAIL_COOLDOWN_MS = 60_000;
/** ready 等待上限:超时视为 worker 起不来(杀+任务失败)。 */
const READY_TIMEOUT_MS = 30_000;

export interface SessionWorkerHostDeps {
  taskManager: TaskSupervisor;
  journal: Journal;
  permissionBroker?: PermissionBroker;
  /** MCP 管理器(快照+callTool 中继;缺省=无 MCP)。 */
  mcp?: { allToolsForAgent(): Promise<{ serverId: string; serverName: string; name: string; description: string }[]>; callTool(serverId: string, tool: string, args: unknown): Promise<string> };
  /** workflow ask / ask_user 路由(可选)。 */
  workflowAskRouter?: { ask(wfId: string, cacheKey: string, instructions: string): Promise<string | null> };
  askUserRouter?: { ask(sessionId: string, payload: unknown): Promise<string | null> };
  /** 流式出口(streamRelay.push 同签名)。 */
  streamSink?: (sessionId: string, ev: unknown) => void;
  /** 子代理注册表镜像写入(globalThis.__bgAgents;agent-wiring 模块在 gateway 进程加载时置位)。 */
  bgAgentsMirror: Map<string, { outputFile: string; status: string; sessionId: string; title?: string; model?: string; lastEventAt?: number; cancel?: () => unknown; spawnedAt?: number; deadlineAt?: number; ownerTask?: string }>;
  /** 子代理取消执行器(host 收 RPC 后回调;缺省=镜像条目 cancel)。 */
  onSubagentCancel?: (agentId: string) => boolean;
  repoRoot: string;
  /** gateway 进程的浏览器/窗口配置快照源。 */
  browserConfig: { enabled: () => boolean; allowDomains: () => string[]; idleMinutes?: () => number; profile?: () => "persistent" | "ephemeral"; profileDir?: () => string; headless?: () => boolean };
  contextWindow?: number;
 /** /proc 法证读取器(第四次冻结后的根治批):判决前读 worker 的主线程 state/
   *  wchan/线程态分布——D(不可中断 IO)=盘停顿可自愈→延长耐心;R/S 静默=用户态死锁→照杀。
   *  缺省=readProcForensics(本机 procfs);测试注入假态。 */
  readProcForensics?: (pid: number | undefined) => { state: string; wchan: string; dThreads: number; threads: number } | null;
  /** per-session 主模型覆盖面(m3:host 侧按任务会话覆盖重算 contextWindow 再下发 spec;
   *  缺省=undefined,worker 用 deps.contextWindow 启动时定值——行为与旧版一致)。 */
  sessionModels?: import("./session-model.js").SessionModelFace;
  /** 任务终态回写(gateway TaskSupervisor 权威)。 */
  setState: (task: Task, to: TaskState, result?: string) => Task;
 /** 项目表快照源( P0:worker resolveWorkdir 同源注入)。 */
  projects?: { list(): { id: string; path: string; label: string; availability: "available" | "unavailable-local-directory" | "unavailable-remote-unverified" | "unavailable-remote-unreachable"; addedAt: number }[]; activeId(): string };
 /** 任务 done 后回调( P0:goal 续跑由网关统一发起——worker 内本地 submit 不可见且会被退出截杀)。 */
  onTaskDone?: (task: Task) => void;
  /** 测试缝:显式指定 worker 入口(缺省=dist/src 双形态探测)。 */
  workerEntry?: string;
}

/** 双形态入口探测(抄 sense-index):dist bundle 优先,src+tsx 兜底(开发态)。 */
function resolveWorkerEntry(repoRoot: string): { file: string; isTs: boolean } | null {
  // 打包态:本模块被 bundle 进 <resources>/gateway/gateway.mjs,worker 与它同目录;
  // repoRoot 此时是桌面数据根(%APPDATA%\LampGenie),不能按仓库布局拼路径。
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "session-worker.mjs");
  if (existsSync(bundled)) return { file: bundled, isTs: false };
  const dist = join(repoRoot, "apps", "gateway", "dist", "session-worker.mjs");
  if (existsSync(dist)) return { file: dist, isTs: false };
  const src = join(repoRoot, "apps", "gateway", "src", "session-worker.ts");
  if (existsSync(src)) return { file: src, isTs: true };
  return null;
}

/** /proc 法证(第四次冻结后的根治批):读 worker 的主线程 state/wchan/线程态分布。
 *  只读 procfs(内存文件系统,毫秒级,不碰 9p);非 Linux/进程已死/权限不可得=null(如实)。
 * 四次冻结收割全部无证据定因(话术一律「疑似文件系统停顿」;11-01 注意收割时网关全健康、
 *  盘根本没停——真因无据可查)。从此:判决即留证,死因可分型。 */
export function readProcForensics(pid: number | undefined): { state: string; wchan: string; dThreads: number; threads: number } | null {
  if (!pid || !Number.isFinite(pid)) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const after = stat.slice(stat.lastIndexOf(")") + 2); // comm 可含空格,取最右括号后字段
    const state = (after.split(" ")[0] ?? "?").trim();
    let wchan = "";
    try { wchan = readFileSync(`/proc/${pid}/wchan`, "utf-8").trim(); } catch { /* 特权差异 */ }
    let threads = 0;
    let dThreads = 0;
    try {
      for (const t of readdirSync(`/proc/${pid}/task`)) {
        if (threads >= 128) break;
        threads++;
        try {
          const ts = readFileSync(`/proc/${pid}/task/${t}/stat`, "utf-8");
          if ((ts.slice(ts.lastIndexOf(")") + 2).split(" ")[0] ?? "").trim() === "D") dThreads++;
        } catch { /* 线程消失 */ }
      }
    } catch { /* task 目录不可读(已退出的线程组) */ }
    return { state, wchan, dThreads, threads };
  } catch {
    return null;
  }
}

interface WorkerRun {
  child: ChildProcess;
  taskId: string;
  sessionId: string;
  /** 观测(F5-3:pid/时刻记账,host.list() 暴露)。 */
  pid?: number;
  startedAt: number;
  readyAt?: number;
  lastEventAt?: number;
 /** ready 定时器饥饿重武装次数(gateway 拥堵致定时器超睡时重武装,至多 2 次)。 */
  readyRetries?: number;
 /** D 态耐心留痕节流(盘等待期间每 60s 一条 worker.disk-wait,不刷屏)。 */
  lastDiskWaitNote?: number;
  stderrTail: string[];
  ready: boolean;
 /** 启动期阶段租约:spawn→config→executor→providers→loop-ready,ready 超时判决读它。 */
  lease: StartupLease;
 /** 已落 journal 的 startup.progress 阶段(同一 stage 只落一次)。 */
  startupStagesLogged?: Set<string>;
 /** ready 定时器句柄(ready 到达即停判决)。 */
  readyTimer?: ReturnType<typeof setTimeout>;
 /** CPU 采样上一拍(/proc/<pid>/stat utime+stime ticks 与时刻;首拍=只建基线)。 */
  cpuPrev?: { ticks: number; at: number };
  rpcId: number;
  /** 本 run 上行落账后的权威 seq 集(订阅转发时跳过=回声去重;>5000 清空冷重建)。 */
  selfSeqs: Set<number>;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
}

/** pid 是否在世(/proc 探测;非 linux 恒 true=保守不清)。 */
function sweepPidAlive(pid: number): boolean {
  return existsSync(join("/proc", String(pid)));
}

/** 孤儿 worker 清扫(F5-3:抄 sense-index 证据链纪律,但本环境收敛为保守版)——
 *  主机制=worker 自身的 disconnect+ppid 看门狗(IPC 通道随父死关闭,事件即刻触发,不受
 *  subreaper 影响);本清扫只兜经典孤儿形态:cmdline 含 node+session-worker 且 ppid=1(init
 *  收养)或 ppid 已死。注意本机宿主(zcode-cli)是 subreaper,孤儿多被它收养(ppid 活)——
 *  这类**故意不杀**:无法与「他网关实例/测试桩的合法子进程」区分,误杀风险优先。
 *  顺带清掉 pid 已死的 .run.json 登记残骸(确定性信号)。返回 {killed, sweptFiles}。 */
export function sweepOrphanSessionWorkers(currentGatewayPid: number): { killed: number; sweptFiles: number } {
  const result = { killed: 0, sweptFiles: 0 };
  const procs = "/proc";
  let names: string[] = [];
  try { names = readdirSync(procs); } catch { return result; } // 非 linux=无 /proc,零动作
  const alivePids = new Set<number>();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    alivePids.add(pid);
    if (pid === currentGatewayPid || pid === process.pid) continue;
    let cmdline = "";
    let ppid = -1;
    try {
      cmdline = readFileSync(join(procs, name, "cmdline"), "utf-8");
      const stat = readFileSync(join(procs, name, "stat"), "utf-8");
      // stat 第 4 字段是 ppid(_comm 可能含空格括号,取最后一个 ')' 之后的部分再数)
      const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      ppid = Number(afterComm[1]);
    } catch { continue; } // 进程刚退/权限=跳过
    if (!cmdline.includes("session-worker") || !cmdline.includes("node")) continue;
    if (ppid !== 1) continue; // 只有 init 收养的才是无主孤儿
    try { process.kill(pid, "SIGKILL"); result.killed++; console.warn(`[session-worker] 孤儿清扫:SIGKILL pid=${pid}(上代 gateway 遗留)`); } catch { /* 已退 */ }
  }
  // .run.json 残骸:pid 不在世的登记文件清走(目录即 specDir 约定)
  void alivePids;
  return result;
}

/** worker 侧写板事件 → gateway bus 中继(n5「看板数据不更新」根治)。
 *  根因:生产默认 agent.sessionWorker=true,agent loop 跑在 session-worker 子进程
 *  (apps/gateway/src/session-worker.ts),那个进程内的 bus 是独立实例——agent-wiring.ts:999/1048
 *  落账后的 bus.emit("board.changed") 只在子进程里空转;gateway 只在 server.ts:535 订阅**自己**进程
 *  的 bus,面板白板视图因此永不刷新(任务收官钩子 app.ts:399 那次 emit 在 gateway 进程,所以只在收尾
 *  时偶尔刷一次)。⇒ worker 侧 bus 与 gateway 不共享,必须在此中继。
 *  中继点=journal.appendMany 落账**成功之后**(事件已持久化,面板回拉必然取到),同步 emit 无队列。
 *  kind 前缀 board.(board.update / board.comment / board.sense 等一切写板路径)统一补发,与
 *  agent-wiring / server.ts 的写板路径同语义;面板侧 board.changed 是幂等重拉,重复广播无害。 */
export function relayBoardChanged(
  landed: { kind?: string; sessionId?: string; payload?: unknown }[],
  emit: (topic: string, payload: unknown) => void): void {
  for (const e of landed) {
    if (typeof e.kind !== "string" || !e.kind.startsWith("board.")) continue;
    const p = (e.payload ?? {}) as { taskId?: unknown };
    const taskId = typeof p.taskId === "string" ? p.taskId : undefined;
    emit("board.changed", { sessionId: e.sessionId, ...(taskId ? { taskId } : {}) });
  }
}

export interface SessionWorkerHost {
  /** 任务派发入口(wireAgentLoop 同位替换:onChange running→fork)。 */
  dispatch: (task: Task) => void;
  /** cancel 下发(onChange cancelled→IPC;worker 内 loop.cancel)。 */
  cancelTask: (taskId: string) => void;
  /** 模型热切广播(worker 收到后重建 provider,下任务生效)。 */
  broadcastModelReload: () => void;
  /** 活跃 worker 数(可观测)。 */
  readonly activeCount: number;
  /** 活跃 worker 清单(F5-3:pid/会话/时刻;server workers.list 暴露)。 */
  list: () => { taskId: string; sessionId: string; pid?: number; startedAt: number; readyAt?: number; lastEventAt?: number; ready: boolean }[];
}

export function createSessionWorkerHost(deps: SessionWorkerHostDeps): SessionWorkerHost {
  const runs = new Map<string, WorkerRun>(); // taskId → run
  const runsBySession = new Map<string, Set<WorkerRun>>(); // sessionId → runs(同会话可双任务并行,转发广播到全部)
  let spawnFailAt = 0;
  let spawnFails = 0;
  const specDir = join(deps.repoRoot, ".genie", "session-workers");
  // 孤儿清扫(四轮复审 R4-3 + 五轮 F5-3):
  // ①上代 gateway 遗留的失灵 worker 进程(ppid=1 证据链,SIGKILL);
  // ②崩溃残留的 spec/.run.json(>2h 尸骸;run.json 里 pid 已死的即刻清)。
  try {
    const swept0 = sweepOrphanSessionWorkers(process.pid);
    let swept = 0;
    for (const f of readdirSync(specDir)) {
      if (!f.endsWith(".json")) continue;
      const p2 = join(specDir, f);
      try {
        if (f.endsWith(".run.json")) {
          const reg = JSON.parse(readFileSync(p2, "utf-8")) as { pid?: number };
          if (!reg.pid || !sweepPidAlive(reg.pid)) { rmSync(p2, { force: true }); swept++; }
          continue;
        }
        if (Date.now() - statSync(p2).mtimeMs > 2 * 60 * 60_000) { rmSync(p2, { force: true }); swept++; }
      } catch { /* 单文件失败不挡 */ }
    }
    if (swept0.killed > 0 || swept > 0) console.warn(`[session-worker] 孤儿清扫:进程 ${swept0.killed} 个,文件 ${swept} 个`);
  } catch { /* 目录不存在=无事 */ }
  // gateway 权威 journal 订阅:本会话新事件(steer/系统消息等 gateway 侧写入)推给 worker,
  // 跳过该 run 自己上行的回声(selfSeqs)。断连(worker 退出)即无 run,零开销。
  deps.journal.subscribe((ev: { sessionId?: string; seq?: number }) => {
    const runSet = ev.sessionId ? runsBySession.get(String(ev.sessionId)) : undefined;
    if (!runSet) return;
    for (const run of runSet) {
      if (!run.ready) continue;
      if (typeof ev.seq === "number" && run.selfSeqs.has(ev.seq)) continue; // 自己上行的回声
      send(run, { t: "journal.events", events: [ev] });
    }
  });

  const failTask = (task: Task, reason: string): void => {
    try {
      deps.setState(task, "failed", `会话 worker 不可用:${reason}。可在配置设 agent.sessionWorker=false 回退进程内模式后重派。`);
    } catch (err) {
      console.error("[session-worker] 任务失败回写异常", err);
    }
  };

  const send = (run: WorkerRun, msg: HostToWorker): void => {
    // IPC 已断开时 child.send 会**异步 emit 'error'**(ERR_IPC_CHANNEL_CLOSED)而不是同步 throw;
 // 只 try/catch 拦不住,会冒到 process.uncaughtException(经验证 watchdog 取消死子代理时炸),
    // 巡检被打断→父任务等不到子代理终态→并发槽被长期占住。先判 connected,并给 send 回调吞错误。
    if (!run.child.connected) return;
    try { run.child.send?.(msg, () => { /* 通道关闭竞态:错误已由 error 监听兜底,不抛 */ }); } catch (err) { console.warn("[session-worker] 下发失败(可能已退出)", err); }
  };

  /** worker RPC 应答器。 */
  const answer = async (run: WorkerRun, req: WorkerRequest): Promise<{ ok: boolean; value?: unknown; error?: string }> => {
    try {
      switch (req.kind) {
        case "journal.readSession": {
          const evs = deps.journal.readSession(req.payload.sessionId, req.payload.sinceSeq ?? 0);
          return { ok: true, value: evs };
        }
        case "journal.readAll": {
          const evs = deps.journal.readAll(req.payload.sinceSeq ?? 0);
          return { ok: true, value: evs };
        }
        case "journal.appendSync": {
 //  生产态:worker 写前屏障。落账 + flushStrict **都成功才 ack**——
          // worker 收到 ok 才放行工具/LLM;任一失败回 ok:false(worker 侧抛错,阻止副作用)。
          const r = ingestEvents(run, req.payload.events);
          if (!r.ok) return { ok: false, error: r.error };
          try {
            // 旧 journal(MemoryJournal/测试假 journal)无 flushStrict → 视为成功(与 loop 侧 no-op 同语义)。
            await deps.journal.flushStrict?.();
            return { ok: true, value: true };
          } catch (err) {
            return { ok: false, error: `flushStrict: ${String(err instanceof Error ? err.message : err).slice(0, 300)}` };
          }
        }
        case "journal.flushStrict": {
          // 无待上行事件时的纯屏障:清掉此前 notify 批在 gateway FileJournal 队列里的写-behind。
          try {
            await deps.journal.flushStrict?.();
            return { ok: true, value: true };
          } catch (err) {
            return { ok: false, error: `flushStrict: ${String(err instanceof Error ? err.message : err).slice(0, 300)}` };
          }
        }
        case "session.search": {
 // worker 的 session_search 代理到 gateway 真 journal(全历史索引)。
          // 现场建工具执行(sessionSearchTool 内部走 WeakMap 单例+盘上缓存,不重复构建);
          // 缺 sessionId 的 discover 由工具默认排除当前会话(worker 上报)。
 // :op=capsule 走同一条 gateway 实现(runSessionSearchCapsule),不复制胶囊逻辑。
          const p = req.payload as {
            op: "discover" | "scroll" | "read" | "capsule";
            args: unknown;
            currentSessionId?: string;
          };
          const { sessionSearchTool, runSessionSearchCapsule } = await import("./session-search.js");
          const out =
            p.op === "capsule"
              ? runSessionSearchCapsule(deps.journal, p.args as { sessionId?: unknown; focus?: unknown })
              : await sessionSearchTool(deps.journal, p.currentSessionId).execute(p.args);
          return { ok: true, value: out };
        }
        case "mcp.tools": {
          const tools = deps.mcp ? await deps.mcp.allToolsForAgent() : [];
          return { ok: true, value: tools };
        }
        case "mcp.call": {
          if (!deps.mcp) return { ok: true, value: "(MCP 未启用)" };
          return { ok: true, value: await deps.mcp.callTool(req.payload.serverId, req.payload.tool, req.payload.args) };
        }
        case "permission.ask": {
          if (!deps.permissionBroker) return { ok: true, value: { decision: "reject", by: "offline" } satisfies PermissionOutcome };
 // 冻结 tool/summary/args,回包前复核(变了→reject)。
          const outcome = await askPermissionWithApprovalObject(deps.permissionBroker, deps.journal, `w-${run.rpcId}-${req.id}`, req.payload);
          return { ok: true, value: outcome };
        }
        case "wfAsk": {
          if (!deps.workflowAskRouter) return { ok: true, value: null };
          return { ok: true, value: await deps.workflowAskRouter.ask(req.payload.wfId, req.payload.cacheKey, req.payload.instructions) };
        }
        case "askUser": {
          if (!deps.askUserRouter) return { ok: true, value: null };
          return { ok: true, value: await deps.askUserRouter.ask(req.payload.sessionId, req.payload.payload) };
        }
        case "subagent.cancel": {
          const okDel = deps.onSubagentCancel?.(req.payload.agentId) ?? false;
          if (!okDel) {
            const en = deps.bgAgentsMirror.get(req.payload.agentId);
            if (en?.cancel) { en.cancel(); return { ok: true, value: true }; }
          }
          return { ok: true, value: okDel };
        }
        default:
          return { ok: false, error: "未知请求" };
      }
    } catch (err) {
      return { ok: false, error: String(err).slice(0, 300) };
    }
  };

  /** journal 落账:重分配全局 seq/time(权威),保序入账;记录权威 seq 供订阅转发去重。
 * :返回 {ok,error} 供 RPC 路(journal.appendSync)判定;notify 路仍只记日志不抛。 */
  const ingestEvents = (run: WorkerRun, events: unknown[]): { ok: true } | { ok: false; error: string } => {
    if (!Array.isArray(events) || events.length === 0) return { ok: true };
 // worker 上行可观测( tips 留痕丢失排查):GENIE_WORKER_JOURNAL_DEBUG=1 时每批
    // kind 摘要一行——审计「哪些事件真的从 worker 到达 gateway」;tip.injected 是否上行一眼可判。
    if (process.env.GENIE_WORKER_JOURNAL_DEBUG === "1") {
      const kinds = (events as { kind?: string }[]).map((e) => String(e.kind ?? "?"));
      console.log(`[session-worker ${run.taskId.slice(0, 8)}] journal 上行 ${events.length} 条: ${kinds.join(",")}`);
    }
    // 经 appendMany 逐条重建(NewEvent 形态:剥掉 worker 临时 seq,由 gateway 分配权威 seq)。
    const cleaned = events.map((e) => {
      const c = { ...(e as Record<string, unknown>) };
      delete c.seq;
      return c;
    }) as Parameters<Journal["appendMany"]>[0];
    try {
      const landed = deps.journal.appendMany(cleaned);
      for (const e of landed) {
        run.selfSeqs.add(e.seq);
        if (run.selfSeqs.size > 5000) run.selfSeqs.clear(); // 有界(冷一次:最坏回声重复,worker 键去重兜底)
      }
      // n5:落账成功后中继写板广播(worker 侧 bus 与 gateway 不共享,在此补发 board.changed)。
      relayBoardChanged(landed, (topic, payload) => bus.emit(topic, payload));
      return { ok: true };
    } catch (err) {
      console.error("[session-worker] journal 落账失败", err);
      return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 300) };
    }
  };

  const handleNotice = (run: WorkerRun, msg: WorkerToHost): void => {
    run.lastEventAt = Date.now();
    if ("t" in msg) {
 // 启动阶段进度(worker 上报 config/executor/providers/loop-ready)。
 // 协议不动(WorkerNotice 未加成员):按字符串识别,未知形态按普通未知通知忽略。
      if ((msg as { t?: string }).t === "startup.progress") {
        const raw = (msg as { stage?: unknown }).stage;
        if (typeof raw === "string" && (STARTUP_STAGES as readonly string[]).includes(raw)) {
          const stage = raw as StartupStage;
          const advanced = run.lease.begin(stage);
          if (advanced.ok) {
            run.startupStagesLogged ??= new Set();
            if (!run.startupStagesLogged.has(stage)) {
              run.startupStagesLogged.add(stage);
 // 阶段证据落 journal:复盘能看到启动推进到哪一段、每段耗时多少(同一 stage 只落一次)。
              try {
                deps.journal.append({ kind: "custom", sessionId: run.sessionId, payload: { type: "worker.startup.progress", taskId: run.taskId, stage, elapsedMs: Math.max(0, Date.now() - run.startedAt) } });
              } catch { /* 观测落账失败不影响启动 */ }
            }
          } else {
            console.warn(`[session-worker] 启动阶段回退被拒(${stage},当前 ${advanced.stage})——worker 上报乱序,忽略`);
          }
        }
        return;
      }
      switch (msg.t) {
        case "ready":
 // ready 到达=启动完成(loop-ready 终态),同时停掉超时判决。
          run.lease.begin("loop-ready");
          run.ready = true;
          if (run.readyTimer) clearTimeout(run.readyTimer);
          run.pid = typeof msg.pid === "number" ? msg.pid : run.child.pid;
          run.readyAt = Date.now();
          break;
        case "log":
          console.log(`[session-worker ${run.taskId.slice(0, 8)}] ${msg.line}`);
          break;
        case "journal.append":
          ingestEvents(run, msg.events);
          break;
        case "task.state": {
          // worker TaskSupervisor.onChange 镜像:终态/失败回写 gateway 权威(queued/running 由 gateway 自身驱动,忽略)。
          if (["done", "failed", "cancelled"].includes(msg.state)) {
            const task = deps.taskManager.list().find((x) => x.id === msg.taskId);
            if (task && task.state !== msg.state) deps.setState(task, msg.state as TaskState, msg.result ?? msg.error);
            // 终态 uplink 已落地=落盘对账文件使命完成(读后即清,防残骸误对账)。
            try { rmSync(join(deps.repoRoot, ".genie", "session-workers", `${msg.taskId}.terminal.json`), { force: true }); } catch { /* 清理失败无害 */ }
 // goal 续跑网关统一发起( P0:worker 内已禁本地续跑;done 才续,failed 不续=与进程内语义一致)
            if (msg.state === "done" && task) { try { deps.onTaskDone?.(task); } catch { /* 续跑发起失败不影响终态 */ } }
          }
          break;
        }
        case "subagent.mirror": {
          for (const en of msg.entries) {
            const prev = deps.bgAgentsMirror.get(en.agentId);
            deps.bgAgentsMirror.set(en.agentId, {
              ...en,
              spawnedAt: prev?.spawnedAt ?? en.lastEventAt,
              // 来源 run 章(五轮复审 F5-1):退出清理按 run 级过滤——同会话可双 worker 并行,
              // 按 sessionId 清理会误杀对方还在跑的子代理;ownerTask=最后上报该条目的 run。
              ownerTask: run.taskId,
              // cancel 经 IPC 回 worker(镜像本身无进程内句柄)
              cancel: () => requestCancel(run, en.agentId),
            });
          }
          break;
        }
        case "stream":
          try { deps.streamSink?.(msg.sessionId, msg.ev); } catch { /* 流式出口失败不挡主链 */ }
          break;
        default:
          break;
      }
    }
  };

  /** 子代理取消:借 cancel 通知带 agentId 前缀(worker 侧解析)。 */
  const requestCancel = (run: WorkerRun, agentId: string): void => {
    // 同 send:worker 已退出时 send 会异步 emit error(ERR_IPC_CHANNEL_CLOSED),必须判 connected +
    // 回调吞错误,否则 watchdog 的 en.cancel() 会把网关打进 uncaughtException 保活并中断本轮巡检。
    if (!run.child.connected) return;
    try { run.child.send?.({ t: "cancel", reason: `subagent:${agentId}` }, () => { /* 通道关闭竞态:忽略 */ }); } catch { /* 已退出 */ }
  };

  const onMessage = (run: WorkerRun) => (msg: WorkerToHost): void => {
    if (msg && msg.t === "req") {
      void answer(run, msg).then((res) => send(run, { t: "res", id: msg.id, ...res }));
      return;
    }
    handleNotice(run, msg);
  };

 /** :worker 进程 CPU 占比采样(启动期 CPU 兜底证据)。
 * /proc/<pid>/stat 的 utime+stime 增量 / USER_HZ(常规 100)/ 采样间隔;
 * 首拍(无基线)/进程已退/非 Linux=undefined(=无 CPU 证据,判决退 NO_PROGRESS)。 */
  const readCpuPercent = (run: WorkerRun): number | undefined => {
    const pid = run.pid ?? run.child.pid;
    if (!pid) return undefined;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
 // comm 可含空格:取最右括号后字段;utime/stime 是全量字段 14/15 → 切分后 index 11/12
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(after[11]) + Number(after[12]);
      if (!Number.isFinite(ticks)) return undefined;
      const at = Date.now();
      const prev = run.cpuPrev;
      run.cpuPrev = { ticks, at };
      if (!prev || at <= prev.at) return undefined;
      const pct = ((ticks - prev.ticks) / 100) / ((at - prev.at) / 1000) * 100;
      return Math.max(0, Math.min(100, pct));
    } catch {
      return undefined;
    }
  };

  /** 收尸阶梯(三轮复审 ③:抄 ACP/sense-index 三板凶——SIGTERM 后 3s 仍活着升 SIGKILL;
   *  9p D 态 syscall 里 SIGTERM 可能长期送不进,单级会留僵尸)。exit 事件到场即取消升级。 */
  const killLadder = (run: WorkerRun): void => {
    try { run.child.kill("SIGTERM"); } catch { /* 已退出 */ }
    const t = setTimeout(() => { try { run.child.kill("SIGKILL"); } catch { /* 已退出 */ } }, 3000);
    t.unref?.();
    run.child.once("exit", () => clearTimeout(t));
  };

  const reap = (taskId: string): void => {
    const run = runs.get(taskId);
    if (!run) return;
    runs.delete(taskId);
    runsBySession.get(run.sessionId)?.delete(run);
    killLadder(run);
  };

 /** 终态落盘对账(晚间事故产物):worker 终态时会写 <taskId>.terminal.json;
   *  gateway 消息处理被饿死时在途 task.state uplink 随 IPC 通道关闭丢失,exit 收割把已交稿
   *  任务误判「异常退出」。收割路径判决前回读落盘——有则按真实终态记账(读后即清)。 */
  const applyDurableTerminal = (run: WorkerRun): { state: string; result: string } | null => {
    try {
      const p = join(deps.repoRoot, ".genie", "session-workers", `${run.taskId}.terminal.json`);
      const j = JSON.parse(readFileSync(p, "utf-8")) as { taskId?: string; state?: string; result?: string };
      rmSync(p, { force: true });
      if (j && typeof j.state === "string" && ["done", "failed", "cancelled"].includes(j.state)) {
        return { state: j.state, result: String(j.result ?? "") };
      }
    } catch { /* 无落盘/损坏=按原路径判决 */ }
    return null;
  };

 // ── 冻结探针(冻结治理)───────────────────────────────────────────
 // 背景:worker 事件循环被同步 IO 停顿冻住(WSL 9p 注意:四 loop 卡死 35 分钟无人收割,
  // exit 收割不触发——进程活着只是不响应;子代理级 stale 预警只发一次不收割)。
  // 机制:worker 侧 30s 心跳(协议 v2 {t:"hb"})+ host 侧 lastEventAt(心跳/任何上行都刷新);
  // 超过 FREEZE_MS 无任何上行 = 事件循环冻结 → 任务翻 failed(可续:重发任务即新 worker)+
  // 镜像子代理就地翻 failed 落死讯 + killLadder(SIGTERM→SIGKILL;D 态送不进就等它自己回来)。
  // 健康长任务零误伤:长 LLM/长命令/等人都是异步 await,心跳照发。
  const freezeMs = (): number => {
    const n = Number(process.env.GENIE_SESSION_WORKER_FREEZE_MS ?? 180_000);
    return Number.isFinite(n) && n >= 0 ? n : 180_000;
  };
  /** D 态耐心硬顶:主线程卡在不可中断 IO(9p 停顿可自愈)时的最长等待;到顶仍 D=永久楔死,照杀。 */
  const diskWaitMs = (): number => {
    const n = Number(process.env.GENIE_SESSION_WORKER_DISK_WAIT_MS ?? 600_000);
    return Number.isFinite(n) && n >= 0 ? n : 600_000;
  };
  const reapMirrorAgents = (run: WorkerRun, finalText: string, reason: string): void => {
    for (const [agentId, en] of deps.bgAgentsMirror) {
      // run 级过滤(F5-1):只收自己 run 上报的条目;他人 run 的条目即使同会话也不碰。
      if (en.ownerTask !== run.taskId || en.status !== "running") continue;
      en.status = "failed";
      en.lastEventAt = Date.now();
      delete en.cancel;
      try {
        deps.journal.append({ kind: "subagent.result", sessionId: en.sessionId, payload: { agentId, event: { type: "result", ok: false, finalText }, reap: { reason } } });
        deps.journal.append({ kind: "message.system", sessionId: en.sessionId, payload: { text: `[子代理死讯] ${agentId}${en.title ? `(${en.title})` : ""} 宿主 worker 已被收割,已强制收尾。需要它的工作请重派。` } });
      } catch { /* journal 失败不影响镜像翻态 */ }
    }
  };
  const freezeReap = (run: WorkerRun, forensics?: { state: string; wchan: string; dThreads: number; threads: number } | null): void => {
    if (runs.get(run.taskId) !== run) return; // 已被 cancel/reap 路径收走
    const silentMs = Date.now() - (run.lastEventAt ?? run.startedAt);
    runs.delete(run.taskId);
    runsBySession.get(run.sessionId)?.delete(run);
    try {
      deps.journal.append({ kind: "custom", sessionId: run.sessionId, payload: { type: "worker.freeze", taskId: run.taskId, pid: run.pid, silentMs, ...(forensics ? { forensics } : {}) } });
    } catch { /* 审计失败不挡收割 */ }
    const t = deps.taskManager.list().find((x) => x.id === run.taskId);
    if (t && !["done", "failed", "cancelled"].includes(t.state)) {
      // 终态落盘对账:冻结判定前先看 worker 是否已交稿(交稿后 scheduleExit 前的冻结应按真实终态记)。
      const durable = applyDurableTerminal(run);
      if (durable) {
        console.warn(`[session-worker] 终态落盘对账(冻结路径):任务 ${run.taskId} 静默 ${Math.round(silentMs / 1000)}s 但已交稿,按落盘终态 ${durable.state} 记账`);
        deps.setState(t, durable.state as TaskState, durable.result);
      } else {
 // 话术按 /proc 法证分型(四次冻结两种真因被同一句话术掩盖——盘停顿(可自愈,
        // 已由 D 态耐心兜住)与用户态死锁/同步计算(真 bug)。法证进 journal 与失败回执,下次有据可查)
        const f = forensics ? `[/proc 法证:主线程 ${forensics.state} 态,wchan=${forensics.wchan || "?"},${forensics.dThreads}/${forensics.threads} 线程 D 态]` : "[/proc 法证不可得]";
        const cause = forensics?.state === "D"
          ? `主线程 D 态=卡在不可中断磁盘 IO ${diskWaitMs() / 1000}s 硬顶内未自愈(9p 挂载永久楔死的已知形态)`
          : forensics?.state === "R"
            ? `主线程 R 态=同步计算/死循环烧死(用户态 bug,非磁盘)——请把任务上下文与 ${f} 反馈给维护者定位`
            : `主线程 ${forensics?.state ?? "?"} 态静默=疑似用户态死锁 ${f}`;
        deps.setState(t, "failed",
          `会话 worker 事件循环冻结(${Math.round(silentMs / 1000)}s 无心跳;${cause}),已强制收割。` +
          `任务可直接重发续跑(新 worker 接手)。`);
      }
    }
    reapMirrorAgents(run, "[worker 冻结收割] 宿主 worker 事件循环冻结被强制终止,该子代理随之收尾。", "worker-freeze");
    try { rmSync(join(deps.repoRoot, ".genie", "session-workers", `${run.taskId}.json`), { force: true }); } catch { /* 清理失败无害 */ }
    try { rmSync(join(deps.repoRoot, ".genie", "session-workers", `${run.taskId}.run.json`), { force: true }); } catch { /* 清理失败无害 */ }
    console.warn(`[session-worker] 冻结收割:任务 ${run.taskId} pid=${run.pid ?? "?"} ${Math.round(silentMs / 1000)}s 无心跳,SIGTERM→SIGKILL`);
    killLadder(run);
  };
  let freezeScanTimer: ReturnType<typeof setInterval> | undefined;
  let lastFreezeTickAt = 0;
  const ensureFreezeScan = (): void => {
    if (freezeScanTimer || freezeMs() <= 0) return;
    const scanMs = Math.max(5_000, Number(process.env.GENIE_SESSION_WORKER_FREEZE_SCAN_MS ?? 30_000));
    lastFreezeTickAt = Date.now();
    freezeScanTimer = setInterval(() => {
      const now = Date.now();
      const gap = now - lastFreezeTickAt;
      lastFreezeTickAt = now;
      const ms = freezeMs();
      if (ms <= 0) return;
 // 饥饿免疫(晚间事故:gateway 被巨型会话轮询饿死 200s+,worker 心跳在队列里
      // 没被处理,静默被误归因于 worker 冻结→健康任务被误杀)。本扫描自身超睡(gap>>scanMs)
      // = gateway 拥堵的确定性证据——期间的静默不可归因,重置观察窗,本轮不判决。
      if (lastFreezeTickAt > 0 && gap > scanMs * 2 + 2_000) {
        console.warn(`[session-worker] 冻结扫描超睡 ${Math.round(gap / 1000)}s(gateway 自身拥堵)——静默不可归因于 worker,重置观察窗不判决`);
        for (const r of runs.values()) r.lastEventAt = now;
        return;
      }
      for (const run of [...runs.values()]) {
        const silent = Date.now() - (run.lastEventAt ?? run.startedAt);
        if (silent <= ms) continue;
 // 判决前先拿 /proc 法证(四次冻结首次有死因证据)。D 态=盘等待可自愈:
        // 静默不足硬顶(diskWaitMs)就再等——停顿解除后 worker 自行恢复,任务零损失;
        // 其余态(R/S 静默=用户态死锁/同步计算)照杀。到顶仍 D=永久楔死(9p 已知形态),也杀。
        const forensics = (deps.readProcForensics ?? readProcForensics)(run.pid);
        if (forensics?.state === "D" && silent < Math.max(diskWaitMs(), ms)) { // 耐心恒 ≥ 阈值(防 env 配置倒挂直跳收割)
          if (Date.now() - (run.lastDiskWaitNote ?? 0) > 60_000) {
            run.lastDiskWaitNote = Date.now();
            try {
              deps.journal.append({ kind: "custom", sessionId: run.sessionId, payload: { type: "worker.disk-wait", taskId: run.taskId, pid: run.pid, silentMs: Math.round(silent), forensics } });
            } catch { /* 留痕失败不挡等待 */ }
            console.warn(`[session-worker] worker D 态盘等待:任务 ${run.taskId} pid=${run.pid ?? "?"} 静默 ${Math.round(silent / 1000)}s(wchan=${forensics.wchan || "?"},${forensics.dThreads}/${forensics.threads} 线程 D)——耐心延长至 ${Math.round(diskWaitMs() / 1000)}s 等停顿自愈`);
          }
          continue;
        }
        freezeReap(run, forensics);
      }
    }, scanMs);
    freezeScanTimer.unref?.();
  };

  /** m3:该任务会话覆盖模型的 contextWindow;无覆盖/无元数据 → deps.contextWindow(启动时定值)。
   * 派生/查表失败 fail-soft 回退(窗口算不出来不该挂任务)。
   * 覆盖面来源优先级:deps.sessionModels(装配注入/测试缝)> host 自建(loadConfig+store,惰性一次)。
   * 自建分支不需要 app.ts 额外接线——host 有 repoRoot 就够,生产/测试两条装配都成立。 */
  /** host 自建的覆盖面(惰性一次;undefined=未尝试,null=尝试失败不再重试)。 */
  let hostFace: import("./session-model.js").SessionModelFace | null | undefined;
  const faceForWindows = (): import("./session-model.js").SessionModelFace | undefined => {
    if (deps.sessionModels) return deps.sessionModels;
    if (hostFace === null) return undefined;
    if (hostFace === undefined) {
      try {
        const cfg = loadConfig({ repoRoot: deps.repoRoot }).config;
        hostFace = createSessionModelFace(cfg, deps.repoRoot, createSessionModelStore(deps.repoRoot));
      } catch (err) {
        console.warn(`[session-worker] 覆盖表装配失败(contextWindow 用启动定值):`, String(err).slice(0, 120));
        hostFace = null;
      }
    }
    return hostFace ?? undefined;
  };
  const sessionContextWindowFor = (task: Task): number | undefined => {
    try {
      const face = faceForWindows();
      const override = face?.resolve(task.sessionId);
      if (!override || !face) return deps.contextWindow;
      return face.contextWindowFor(override) ?? deps.contextWindow;
    } catch {
      return deps.contextWindow;
    }
  };

  const dispatch = (task: Task): void => {
    if (runs.has(task.id)) return;
    if (spawnFails >= 2 && Date.now() - spawnFailAt < SPAWN_FAIL_COOLDOWN_MS) {
      failTask(task, `连续 ${spawnFails} 次 fork 失败(冷却中,${Math.ceil((SPAWN_FAIL_COOLDOWN_MS - (Date.now() - spawnFailAt)) / 1000)}s 后重试)`);
      return;
    }
    const entry = deps.workerEntry ? { file: deps.workerEntry, isTs: false } : resolveWorkerEntry(deps.repoRoot);
    if (!entry) {
      spawnFails++; spawnFailAt = Date.now();
      failTask(task, "session-worker 入口不存在(dist/session-worker.mjs 与 src/session-worker.ts 都缺席——构建不完整)");
      return;
    }
    const spec: SessionWorkerSpec = {
      protocolVersion: SESSION_WORKER_PROTOCOL_VERSION,
      task: {
        id: task.id, sessionId: task.sessionId, instruction: task.instruction, state: task.state,
        createdAt: task.createdAt, updatedAt: task.updatedAt, title: task.title,
        targetNode: task.targetNode, resourceTags: task.resourceTags, credentialRef: task.credentialRef,
        projectId: task.projectId, attachments: task.attachments as unknown[], result: task.result,
      },
      repoRoot: deps.repoRoot,
      projects: deps.projects ? { entries: deps.projects.list(), activeProjectId: deps.projects.activeId() } : undefined,
      browser: {
        enabled: deps.browserConfig.enabled(), allowDomains: deps.browserConfig.allowDomains(),
        ...(deps.browserConfig.idleMinutes ? { idleMinutes: deps.browserConfig.idleMinutes() } : {}),
        ...(deps.browserConfig.profile ? { profile: deps.browserConfig.profile() } : {}),
        ...(deps.browserConfig.profileDir ? { profileDir: deps.browserConfig.profileDir() } : {}),
        ...(deps.browserConfig.headless ? { headless: deps.browserConfig.headless() } : {}),
      },
      // m3:contextWindow 随该任务会话的模型覆盖重算(derive 时算一次,非每轮热改);
      // 无覆盖/无模型元数据 → 回退启动时注入的定值(旧行为零变化)。
      contextWindow: sessionContextWindowFor(task),
    };
    let specFile: string;
    try {
      mkdirSync(specDir, { recursive: true });
      specFile = join(specDir, `${task.id}.json`);
      writeFileSync(specFile, JSON.stringify(spec), "utf-8");
    } catch (err) {
      failTask(task, `描述符写入失败:${String(err).slice(0, 120)}`);
      return;
    }
    const run: WorkerRun = { child: undefined as unknown as ChildProcess, taskId: task.id, sessionId: task.sessionId, startedAt: Date.now(), stderrTail: [], ready: false, rpcId: 0, selfSeqs: new Set(), pending: new Map(), lease: new StartupLease({ timeoutMs: READY_TIMEOUT_MS }) };
 // 起租。spawn 是最长的一段(进程起来→loadConfig),也是唯一没有 worker 上报的阶段。
    run.lease.begin("spawn", run.startedAt);
 // :子进程 env 从安全基线起算;带 credentialRef 时按 task origin 解析,成功才注入那一个变量。
 // 失败=不注入 + 审计落账(custom 事件只带 code,不含值);GENIE_CREDENTIAL_BOUNDARY=off 回退旧 env。
    const envBuild = buildWorkerEnv(task.credentialRef, {
      baseEnv: process.env,
      readSecrets: () => readGenieSecrets(deps.repoRoot),
    });
    if (envBuild.audit) {
      try {
        deps.journal.append({ kind: "custom", sessionId: task.sessionId, payload: envBuild.audit });
      } catch {
 /* 审计落账失败不挡派发(凭证本身已 fail-closed 未注入) */
      }
    }
    try {
      const heapMb = Math.max(512, Number(process.env.GENIE_SESSION_WORKER_HEAP_MB ?? 2048));
      run.child = fork(entry.file, [specFile], {
        cwd: deps.repoRoot,
 // :只给子进程安全基线 + 解析出的单个凭证变量(不再是整份 process.env)
        env: envBuild.env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        // 堆帽(F5-2:agent loop 大上下文;可配 GENIE_SESSION_WORKER_HEAP_MB,下限 512)
        execArgv: entry.isTs ? ["--import", "tsx", `--max-old-space-size=${heapMb}`] : [`--max-old-space-size=${heapMb}`],
      });
    } catch (err) {
      spawnFails++; spawnFailAt = Date.now();
      failTask(task, `fork 失败:${String(err).slice(0, 160)}`);
      return;
    }
    // IPC 通道关闭/子进程 send 失败会以 child 'error' 事件到来;没有监听器=process.uncaughtException
    // (网关虽保活,但 watchdog/取消链会被打断)。这里消费并留 stderr 证据,不改变任务状态机。
    run.child.on("error", (err) => {
      run.stderrTail.push(`[child error] ${String(err).slice(0, 300)}`);
      if (run.stderrTail.length > 40) run.stderrTail.shift();
    });
    runs.set(task.id, run);
    let bySession = runsBySession.get(task.sessionId);
    if (!bySession) { bySession = new Set(); runsBySession.set(task.sessionId, bySession); }
    bySession.add(run);
    run.child.stderr?.on("data", (d: Buffer) => {
      run.stderrTail.push(d.toString("utf-8"));
      if (run.stderrTail.length > 40) run.stderrTail.shift();
    });
 // stdout 同样消费(P0 复审——只 pipe 不读会背压堵死 worker;日志并入 tail 留尸)
    run.child.stdout?.on("data", (d: Buffer) => {
      run.stderrTail.push(d.toString("utf-8"));
      if (run.stderrTail.length > 40) run.stderrTail.shift();
    });
    run.child.on("message", onMessage(run));
 // ready 超时判决(阶段租约替代黑盒总超时)。
 // 每次 tick 读 lease:wait→短定时器再采;retry→阶段刚推进过,重武装整窗(落 worker.startup.retry);
 // kill→先落 worker.startup.evidence(阶段轨迹+线程栈取证建议+stderr 尾)再 failTask/killLadder。
 // 饥饿免疫(晚间事故)保留在 sample 之前:定时器超睡=gateway 自身拥堵,
 // 期间的静默不可归因于 worker,通道仍连则重武装(至多 2 次)不判决。
    const readyTimerHolder: { t?: ReturnType<typeof setTimeout> } = {};
    let windowStartAt = Date.now();
 // 首拍只建 CPU 基线(否则 30s 后第一次判决读不到增量,只能按「无 CPU 证据」杀)。
    readCpuPercent(run);
    const armReadyTimer = (windowMs: number = READY_TIMEOUT_MS): void => {
      readyTimerHolder.t = setTimeout(() => {
        if (run.ready) return;
        const tickAt = Date.now();
        const sinceSchedule = tickAt - windowStartAt;
        if (sinceSchedule > windowMs * 2 && run.child.connected && (run.readyRetries ?? 0) < 2) {
          run.readyRetries = (run.readyRetries ?? 0) + 1;
          console.warn(`[session-worker] ready 定时器超睡(elapsed=${sinceSchedule}ms 远超预算 ${windowMs}ms=gateway 拥堵),重武装第 ${run.readyRetries} 次(ready 可能仍在队列)`);
          windowStartAt = tickAt;
          armReadyTimer();
          return;
        }
        const cpuPercent = readCpuPercent(run);
        const verdict = run.lease.sample({ ...(cpuPercent !== undefined ? { cpuPercent } : {}), at: tickAt });
        if (verdict.action === "wait") {
          if (verdict.code === "OK") return; // loop-ready 已上报,判决停止
          armReadyTimer(Math.min(windowMs, 1_000));
          return;
        }
        if (verdict.action === "retry") {
 // 阶段刚推进过(stageElapsed 小)= 还在干活:重武装整窗再观察,不急于杀。
          try {
            deps.journal.append({ kind: "custom", sessionId: run.sessionId, payload: { type: "worker.startup.retry", taskId: run.taskId, stage: verdict.stage, elapsedMs: verdict.elapsedMs, stageElapsedMs: verdict.stageElapsedMs } });
          } catch { /* 观测落账失败不挡判决 */ }
          windowStartAt = tickAt;
          armReadyTimer(); // 重武装整窗
          return;
        }
 // kill:先取证再动手——阶段轨迹 + 线程栈/报告路径 + stderr 尾 20 行入 journal。
        const evidence = {
          ...run.lease.evidence(),
          threadStack: threadStackHint(run.pid),
          stderrTail: run.stderrTail.join("").split("\n").slice(-20),
        };
        try {
          deps.journal.append({ kind: "custom", sessionId: run.sessionId, payload: { type: "worker.startup.evidence", taskId: run.taskId, stage: verdict.stage, code: verdict.code, reason: verdict.reason, evidence } });
        } catch { /* 证据落账失败不挡收割 */ }
        console.error(`[session-worker] 启动超时(阶段 ${verdict.stage},${verdict.code},${verdict.elapsedMs}ms):${verdict.reason},任务 ${task.id} 判失败`);
        failTask(task, `worker 启动卡在阶段 ${verdict.stage}(${verdict.code},已 ${Math.round(verdict.elapsedMs / 1000)}s 未就绪)`);
        reap(task.id);
      }, windowMs);
      readyTimerHolder.t.unref?.();
      run.readyTimer = readyTimerHolder.t;
    };
    armReadyTimer();
    run.child.on("exit", (code, signal) => {
      clearTimeout(readyTimerHolder.t);
      const still = runs.get(task.id);
      if (still !== run) return; // 已被 reap(cancel 路径)
      runs.delete(task.id);
      runsBySession.get(run.sessionId)?.delete(run);
 // 非终态退出(worker 崩溃/被杀):先对账落盘终态( uplink 丢失事故),无落盘才判异常。
      const t = deps.taskManager.list().find((x) => x.id === task.id);
      if (t && !["done", "failed", "cancelled"].includes(t.state)) {
        const durable = applyDurableTerminal(run);
        if (durable) {
          console.warn(`[session-worker] 终态落盘对账:任务 ${task.id} worker 退出(code=${code})但已交稿,按落盘终态 ${durable.state} 记账(uplink 在途丢失)`);
          deps.setState(t, durable.state as TaskState, durable.result);
        } else {
          const tail = run.stderrTail.join("").slice(-1200);
          deps.setState(t, "failed", `会话 worker 异常退出(code=${code} signal=${signal})。${tail ? `\nstderr 尾:\n${tail}` : ""}`);
        }
      }
      // ghost 防治(三轮复审 ②:ZCode「子代理事实决定自身状态」的 worker 形态对价):
      // worker 退出=其进程内子代理物理死亡,镜像里仍 running 的条目就地翻 failed+落死讯,
      // 否则去时间盒后无 deadline 永不被收割,分身卡/过程球常年挂死条目。
      reapMirrorAgents(run, "[worker 退出收割] 宿主 worker 进程已退出,该子代理随之终止(后台存活语义仅在进程内模式成立)。", "worker-exit");
      try { rmSync(specFile, { force: true }); } catch { /* 清理失败无害 */ }
    });
    ensureFreezeScan(); // 冻结探针:首个 run 注册后启动周期扫描(unref 不挡退出)
  };

  const cancelTask = (taskId: string): void => {
    const run = runs.get(taskId);
    if (!run) return;
    send(run, { t: "cancel", reason: "task.cancel" });
    // 3s 宽限后收尸阶梯(协作取消失败兜底:SIGTERM→SIGKILL)。
    const t = setTimeout(() => reap(taskId), 3000);
    t.unref?.();
  };

  return {
    dispatch,
    cancelTask,
    broadcastModelReload: () => { for (const run of runs.values()) send(run, { t: "model.reload" }); },
    get activeCount() { return runs.size; },
    list: () => [...runs.values()].map((r) => ({ taskId: r.taskId, sessionId: r.sessionId, pid: r.pid, startedAt: r.startedAt, readyAt: r.readyAt, lastEventAt: r.lastEventAt, ready: r.ready })),
  };
}

/** 供测试/观测:读 worker 描述符文件(清理对账用)。 */
export function readWorkerSpec(specFile: string): SessionWorkerSpec | null {
  try {
    return JSON.parse(readFileSync(specFile, "utf-8")) as SessionWorkerSpec;
  } catch {
    return null;
  }
}

/** 供测试:追加 stderr 证据(协议不动)。 */
export function appendWorkerLog(file: string, line: string): void {
  try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, line + "\n", "utf-8"); } catch { /* 无害 */ }
}
