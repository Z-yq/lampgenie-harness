/**
 * 会话 worker 进程协议(设计参考 ZCode(致谢):一会话一进程,gateway 只做聚合)。
 * 形态:gateway(host)为每个 running 任务 fork 一个 session-worker 进程;worker 内跑完整
 * agent loop(wireAgentLoop 全套依赖在 worker 内自建或经 IPC 代理),gateway 保留 WS 面板、
 * TaskSupervisor 权威(队列/并发/恢复)、journal 权威(seq 分配/落盘/订阅广播)。
 * 协议(复用 SubagentBackend 的跨进程词汇,IPC=process.send/on("message")):
 *  - gateway→worker 通知:{t:"cancel"} / {t:"permission.resolved"}(面板代答) / {t:"model.reload"}
 *  - worker→gateway 通知:{t:"ready"} / {t:"journal.append",events} / {t:"task.state",...} /
 *    {t:"subagent.mirror",...} / {t:"stream",sessionId,ev} / {t:"log",line}
 *  - worker→gateway 请求:{t:"req",id,kind,payload} → {t:"res",id,ok,value,error}
 *    kind: journal.readSession / journal.readAll / session.search /
 *          mcp.tools / mcp.call / permission.ask / wfAsk / askUser / subagent.cancel
 * seq 语义:worker 侧 ProxyJournal 分配临时 seq(进程内单调,仅保序);gateway 落账时统一
 * 重分配全局 seq(权威)——面板/跨会话读路径只见 gateway seq,一致。
 */

/** host↔worker 协议版本(三轮复审:抄 ACP initialize(protocolVersion) fail-visible——
 *  半重建状态(新 gateway dist + 旧 worker bundle)静默错译消息比显式报错更难排查)。
 * v2(冻结治理):新增 worker→host 心跳通知 {t:"hb"}——host 侧冻结探针依赖它
 *  判定 worker 事件循环生死;旧 worker 不发心跳,新 host 会把健康任务误判冻结收割,必须同批构建。 */
export const SESSION_WORKER_PROTOCOL_VERSION = 2;

/** 任务描述符:host 一次性下发给 worker(文件形态,argv[2] 路径,避免巨 argv)。 */
export interface SessionWorkerSpec {
  /** 协议版本(host 写当前值;worker 不匹配=显式失败退出,不静默错译)。 */
  protocolVersion: number;
  /** 完整任务记录(gateway TaskSupervisor 权威快照)。 */
  task: {
    id: string;
    sessionId: string;
    instruction: string;
    state: string;
    createdAt: number;
    updatedAt: number;
    title?: string;
    kind?: string;
    targetNode?: string;
    resourceTags?: string[];
    credentialRef?: string;
    projectId?: string;
    attachments?: unknown[];
    result?: string;
  };
  /** gateway repoRoot()(config/journal/.genie 根)。 */
  repoRoot: string;
 /** 项目表快照( P0 修复:worker 侧 resolveWorkdir 必须与网关同源——
   *  空 registry 会让带 projectId 的任务 taskRoot 回落 harnessRoot=读码写码全在错的根)。 */
  projects?: { entries: { id: string; path: string; label: string; availability: "available" | "unavailable-local-directory" | "unavailable-remote-unverified" | "unavailable-remote-unreachable"; addedAt: number }[]; activeProjectId?: string };
  /** 浏览器工具开关快照。 */
  browser: {
    enabled: boolean; allowDomains: string[];
    /* 2026-11 browser-ux-redo:视图/回收/持久 profile 三项随 spec 下发(缺省=旧行为)。 */
    idleMinutes?: number; profile?: "persistent" | "ephemeral"; profileDir?: string; headless?: boolean;
  };
  /** 主模型上下文窗口 tokens。 */
  contextWindow?: number;
}

/** worker→gateway 通知信封。 */
export type WorkerNotice =
  | { t: "ready"; pid: number }
  | { t: "hb"; pid: number }
  | { t: "log"; line: string }
  | { t: "journal.append"; events: unknown[] }
  | { t: "task.state"; taskId: string; state: string; result?: string; error?: string }
  | { t: "subagent.mirror"; entries: { agentId: string; outputFile: string; status: string; sessionId: string; title?: string; model?: string; lastEventAt?: number; deadlineAt?: number }[] }
  | { t: "stream"; sessionId: string; ev: unknown };

/** worker→gateway 请求。 */
export type WorkerRequest =
  | { t: "req"; id: number; kind: "journal.readSession"; payload: { sessionId: string; sinceSeq?: number } }
  | { t: "req"; id: number; kind: "journal.readAll"; payload: { sinceSeq?: number } }
 /**  生产态:worker 写前屏障——批量落账 + flushStrict,二者都成功才 ack。 */
  | { t: "req"; id: number; kind: "journal.appendSync"; payload: { events: unknown[] } }
  /** 无待上行事件时的纯屏障:清掉此前 notify 批在 gateway FileJournal 里的队列。 */
  | { t: "req"; id: number; kind: "journal.flushStrict"; payload: Record<string, never> }
  | { t: "req"; id: number; kind: "session.search"; payload: { op: "discover" | "scroll" | "read"; args: unknown; currentSessionId?: string } }
  | { t: "req"; id: number; kind: "mcp.tools"; payload: Record<string, never> }
  | { t: "req"; id: number; kind: "mcp.call"; payload: { serverId: string; tool: string; args: unknown } }
  | { t: "req"; id: number; kind: "permission.ask"; payload: { sessionId?: string; tool: string; summary: string; risk?: string; args?: unknown } }
  | { t: "req"; id: number; kind: "wfAsk"; payload: { wfId: string; cacheKey: string; instructions: string } }
  | { t: "req"; id: number; kind: "askUser"; payload: { sessionId: string; payload: unknown } }
  | { t: "req"; id: number; kind: "subagent.cancel"; payload: { agentId: string } };

/** gateway→worker 消息。 */
export type HostMessage =
  | { t: "res"; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "cancel"; reason: string }
  | { t: "model.reload" }
  /** gateway 权威 journal 新事件推送(steer/系统消息等 gateway 侧写入;worker 本地副本去重后并入)。 */
  | { t: "journal.events"; events: unknown[] };

/** IPC 上承载的联合类型(worker 侧收到 HostMessage;host 侧收到 WorkerNotice|WorkerRequest)。 */
export type WorkerToHost = WorkerNotice | WorkerRequest;
export type HostToWorker = HostMessage;
