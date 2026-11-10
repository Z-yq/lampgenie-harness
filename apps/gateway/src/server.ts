/**
 * WebSocket 服务:客户端(桌面/CLI/node-agent)连进来,
 * 收任务提交、推事件广播。
 * 消息校验走 @lampgenie/protocol(zod,信封 v:1 强制)——R2 修复:不再裸 parse。
 */
import { join } from "node:path";
import { isAbsolute } from "node:path"; // project.add 前置路径校验用
import { isPathInside } from "./path-safety.js"; // :Windows 分隔符无关的越界判定(旧 startsWith(root+"/") 在 Windows 全误判)
import { parseWslPath, wslErrorHint } from "./wsl.js"; // :WSL 项目执行/目录锚点
import { buildRemoteSshIdentity, buildRemoteWslIdentity, parseRemoteProject, probeRemoteProject, remoteWslFromUncPath } from "./remote-project.js"; // 远程项目(remote:ssh / remote:wsl,/27)
import { processAnnotateSubmit, type AnnotateNoteInput, type AnnotateRefineDeps, type AnnotateVoiceDeps } from "./annotate.js";
import { createVoiceParser, parseAudioDataUrl, VOICE_PARSE_API_KEY_ENV, VOICE_PARSE_MODEL } from "./annotate-voice.js";
import { createVoiceDrafter } from "./voice-draft.js";
import type { EmbeddedTeamHandle } from "./team-embedded.js"; // 团队绑定实时种子(仅类型;运行面走 seedRegistryProjects)
import { seedRegistryProjects } from "./team-embedded.js";
import type { TeamaiDigest } from "@lampgenie/runtime/team/teamai-bridge"; // 门面(仅类型;运行面动态 import)
import { sshRun, remoteLs, remoteRead, remoteWrite, remoteReadBinary, remoteRun, remoteExec, remoteGit, shQuote, deployRemoteWorkspace, deployRemoteSense } from "./ssh-ops.js";
import { rewriteOfficeText, OFFICE_MAX_BYTES, type OfficeTextEdit } from "./office-ooxml.js"; // 板「OOXML 文本回写」P2
import { deployRemoteWorkspaceAgent, tryChannelJson } from "./remote-channel.js";
import { loadSshConfigEntries } from "./ssh-config.js"; // SSH config 导入(新建连接)
import { handleClientSurfaceDeclare, type SurfaceJournalLike } from "./surface-capabilities.js"; // 表面能力位声明
// 终态投递义务:四态(pending/attempting/delivered/failed)+ journal 持久化 + claim 租约/sweep。
import {
  createDeliveryObligationStore,
  attemptDelivery,
  type DeliveryObligation,
  type DeliveryObligationStore,
} from "./delivery-obligation.js";

/** 连接向导:POSIX 远端路径的父目录(根("/")返回 null;用于经服务浏览目录时上跳)。 */
function posixParentOf(p: string): string | null {
  const s = "/" + String(p ?? "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (s === "/") return null;
  const i = s.lastIndexOf("/");
  return i <= 0 ? "/" : s.slice(0, i);
}

/** 显式 projectId 的项目目录不可用(运行期目录被移走,availability 未重检)时 resolveWorkdir 会
 * 静默回落 harness 根——按项目路径读/写都会打到 harness(注意:写透传到根目录)。此处硬拦。 */
function projectRootFallbackGuard(
  projects: { list(): { id: string; path: string; label: string; availability: string }[] } | undefined,
  projectId: string | undefined,
  resolvedRoot: string,
  harnessRoot: string): string | null {
  if (!projectId) return null;
  const proj = projects?.list().find((x) => x.id === projectId);
  if (!proj || proj.path.startsWith("remote:")) return null;
  if (proj.availability !== "available") return "项目目录暂不可访问(" + proj.label + "):已开启只读保护";
  try {
    if (realpathSyncNative(proj.path) === harnessRoot) return null; // 本身就是 harness 项目
  } catch { /* 目录已消失 → 回退即错 */ }
  if (resolvedRoot === harnessRoot) return "项目目录暂不可访问(" + proj.label + "):已开启只读保护。恢复目录或重新添加项目后再试";
  return null;
}
import { realpathSync as realpathSyncNative } from "node:fs"; // 远程操作层(ZCode remote workspace 切片)
import * as fsSync from "node:fs"; // 截图标注落盘(annotate.submit;同步语义与 project.add 校验一致)
import { taskIndexList, taskIndexOf } from "./task-index.js";
import { hasUserStoppedSince, USER_STOPPED_RESUME_CODE, USER_STOPPED_RESUME_MESSAGE } from "./user-stop-marker.js";
import { isSessionActivityKind } from "./session-activity.js"; // :会话活动时间白名单(侧栏排序)
import { repoRoot } from "./repo-root.js";
import { expandShellSnippets } from "./command-shell-expand.js";
import { shellErrorHint, shellInvocation } from "./shell-invocation.js";
import { repairTailBeforeResume } from "./journal-tail-repair.js"; // resume 前补合成终态(崩溃尾部修复)
import { permissionMode } from "./permission-mode.js";
import {
  currentCapabilitySnapshot,
  externalSourceOf,
  gateExternalSubmit,
  type CapabilitySnapshot,
  type EnvelopePolicy,
  type ExternalSubmitRaw,
  type TaskEnvelope,
} from "./task-envelope.js";
import { resetSessionToolFloor } from "./tool-view.js"; // 会话删除时清工具面冻结集(轮 P3)
import { superSessionId } from "./super-agent.js"; // 出站 super.turn.done 的会话 id(super:YYYYMMDD)
import { PANEL_BUILD } from "./build-stamp.js";
import { WsByteLedger, flushWsLedger, WS_LEDGER_FLUSH_MS } from "./ws-byte-ledger.js"; // g3: WS 发送字节账本(谁在发大帧的字节级证据)
import { WebSocketServer, WebSocket } from "ws";
import { bus, resolveCodingModelRoute, resolveTrackApiKey, type Journal } from "@lampgenie/core";
import { parseClientMessage, explainClientMessageError, PROTOCOL_VERSION, ErrorCode, type ClientMessage } from "@lampgenie/protocol";
import { CLIENT_MODES, DEFAULT_CLIENT_MODE, isChannelAllowed, isClientMode, isMethodAllowed, type ClientMode } from "./client-capabilities.js";
import { reapOrphanSubagents } from "./agent-wiring.js";
import { registerTraceStatsBroadcaster } from "./compact-hook.js";
import { beginRetry, clearOnProgress, clearOnTerminal, snapshot as retrySnapshot } from "./session-retry-state.js";
import { TurnNoCounter } from "./track-turns.js";
import { restoreQueues, writeQueueSync, queueItemKey } from "./queue-store.js";
import type { TaskSupervisor } from "./task-manager.js";
import type { RouterApi } from "./router/index.js";
import type { NodeRegistry, NodeConnections, NodeDispatch } from "./nodes.js";
import type { ProjectRegistry, ProjectAvailability } from "./projects.js";
import { cleanupProjectTaskRefs } from "./projects.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { WorkflowAskRouter } from "./workflow-ask-router.js";
import type { AskUserRouter } from "./ask-user-router.js";
import type { SubagentBackend } from "@lampgenie/executors";
import type { AutomationStore, AutomationScheduler } from "./automations.js";
import { computeStatsSummary, computeUsageDashboard } from "./stats.js";
import { rebuildDashboardSessions } from "./dashboard-collector.js";
import { aggregateDailySessions, computeDailyBuckets, summarizeTrendWindow, dailyWindow } from "./dashboard-trends.js";
import { eventsForScope } from "./dashboard-scope.js";
import { BUILTIN_COMMANDS } from "./command-catalog.js";
import { modelsErrorOf } from "./models-errors.js";

// ----  能力暴露 allowlist:连接级 clientMode(每 WS 连接一份,缺省 panel) ----
// 白名单判定在 ws.on("message") 解析成功之后、handleMessage 之前执行;拒绝时不进 switch。
const clientModeByWs = new WeakMap<WebSocket, ClientMode>();

/** 拒收帧 + journal 审计(client.denied 是「谁在越权」的唯一证据面)。 */
function denyChannel(
  ws: WebSocket,
  journal: Journal,
  mode: ClientMode,
  channel: string,
  msg: { sessionId?: unknown },
): void {
  const sid = typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : undefined;
  safeSend(ws, {
    v: PROTOCOL_VERSION,
    type: "error",
    code: "permission-denied",
    message: `clientMode=${mode} 无权调用 ${channel}`,
  });
  try {
    journal.append({
      kind: "custom",
      sessionId: sid ?? "",
      payload: { type: "client.denied", mode, channel, ...(sid ? { sessionId: sid } : {}), at: Date.now() },
    });
  } catch { /* 审计失败不影响拒收 */ }
}

// ---- 面板 IDE 第二批:持久终端服务(term.session.*;journal 键控单例) ----
// 注:agent 侧装配在 agent-wiring.ts(模块私有,不在本批改动许可面),无法直接 import 共享;
// 此处同构单例(同款 journal 实例键控)保证面板侧同进程去重,owner 隔离语义一致——偏离点见报告。
type PanelTerminalService = import("@lampgenie/terminal").TerminalSessionService;
const panelTerminalServices = new WeakMap<object, PanelTerminalService>();
let panelConnSeq = 0;
async function panelTerminalService(journal: Journal): Promise<PanelTerminalService> {
  const key = journal as unknown as object;
  let service = panelTerminalServices.get(key);
  if (!service) {
    const { TerminalSessionService } = await import("@lampgenie/terminal");
    // 审计落 journal custom 事件(与 agent-wiring getTerminalService 同款;断连回收观测口)。
    service = new TerminalSessionService({
      audit: (event) => {
        try { journal.append({ kind: "custom", sessionId: event.owner, payload: event }); } catch { /* 审计失败不影响终端操作 */ }
      },
    });
    panelTerminalServices.set(key, service);
  }
  return service;
}

export interface GatewayServerOptions {
  port: number;
  taskManager: TaskSupervisor;
  journal: Journal;
  nodes?: NodeRegistry;
 /** 节点 WS 连接表(node.register 登记,委派下发用);缺省=不登记。 */
  nodeConnections?: NodeConnections;
 /** 委派调度器(node.task.result 回流路由);缺省=报 not-implemented。 */
  nodeDispatch?: NodeDispatch;
 /** 项目注册表(ZCode workspace 移植);缺省=project.* 报 not-implemented。 */
  projects?: ProjectRegistry;
  /** browser 工具门禁(与 agent 工具同源;缺省时从 config.browser 现场读)。
 * 面板内置浏览器视图也要读同一份门禁(不允许绕开 browser.enabled/allowDomains)。 */
  browserConfig?: { enabled: () => boolean; allowDomains: () => string[] };
 /** 任务执行信封:当前能力目录/策略的装配方注入点。
   * 缺省=currentCapabilitySnapshot(已登记工具面/内置命令名)+ permissionMode/agent.maxSteps。 */
  envelope?: {
    capabilitySnapshot?: () => CapabilitySnapshot;
    policy?: () => EnvelopePolicy;
  };
 /** 权限审批中介( B2);缺省=ask 流走 auto-fail-closed(旧行为)。 */
  permissionBroker?: PermissionBroker;
  /** workflow ask 面板应答路由(F6);缺省=ask 全走 executor(旧行为)。 */
  workflowAskRouter?: WorkflowAskRouter;
  /** ask_user 面板问答路由(许愿式编程;缺省=工具返回 null,agent 自行推断继续)。 */
  askUser?: AskUserRouter;
 /** 子代理后端(工作流板:board.workflow.run 的 wf-agent 节点派发;缺省=纯确定性流可跑,agent 节点报未配置)。 */
  executor?: SubagentBackend;
 /** 定时自动化;缺省=automation.* 报 not-implemented。 */
  automations?: AutomationStore;
 /** 主 LLM(AI 提交信息;缺省=确定性兜底文案)。 */
  llm?: unknown;
 /** 角色模型轨(手动 /compact 与自动压缩同源——生产压缩走 coding.models.compact)。 */
  models?: {
    compact?: import("@lampgenie/runtime/agent/loop").LlmProvider;
    review?: import("@lampgenie/runtime/agent/loop").LlmProvider;
    subagent?: import("@lampgenie/runtime/agent/loop").LlmProvider;
  };
 /** 辅助链轨(archLlm/压缩等辅助调用;缺省回退主轨)。 */
  auxLlm?: import("@lampgenie/runtime/agent/loop").LlmProvider;
  automationScheduler?: AutomationScheduler;
  /** 内部广播钩子(startGatewayServer 注入;project.* 变更全客户端推送用)。 */
  broadcast?: (msg: import("@lampgenie/protocol").ServerMessage) => void;
 /** 终态投递义务表(createGatewayApp 建并做启动 sweep 后注入)。
   * 缺省=本函数自建(不额外 sweep,直连 startGatewayServer 的测试/嵌入式场景按需自调)。 */
  deliveryObligations?: DeliveryObligationStore;
 /** :会话最近活动时间索引(sid→ms;侧栏排序/行时间)。启动回放已 seed,
   * 运行期由本函数的 journal.subscribe 更新并随 session.status.changed / hello 下发。缺省=不启用。 */
  sessionActivity?: import("./session-activity.js").SessionActivityIndex;
 /** super-agent Router( P1):面板 task.submit 主径 Trigger 入 router;
   * 缺省=不注入(测试装配旧行为直提 tm.submit,零行为差异)。 */
  routerApi?: RouterApi;
  /** fixD4(团队 issue 双通道):issue.* 面板消息数据源;缺省=issue.* 报 not-implemented。 */
  issueService?: import("./issue-service.js").IssueService;
  /** fixD3(团队 P2P 直连):team.p2p.* 数据源+确认派发桥;缺省=team.p2p.* 报 not-implemented。 */
  teamP2p?: import("./team-p2p.js").TeamP2P;
  /** 经验库(结构化最小面,面板 经验库 视图用);缺省=exp.* 报 not-implemented。 */
  experience?: {
    index(): { category: string; name: string; description: string }[];
    view(category: string, name: string): string | null;
 /** 已禁用清单(缺省=空)。 */
    disabled?(): { category: string; name: string }[];
 /** 删除经验(「经验库应当可以删除」):物理删目录,ledger 记 delete;缺省=exp.remove 报 not-implemented。 */
    remove?(category: string, name: string): boolean;
  };
  /** 系统元信息快照(面板 系统 视图用);缺省=空对象。 */
  sysMeta?: Record<string, unknown>;
  /** 生效配置(stats 额度预算热读);缺省=无预算。 */
  config?: unknown;
  /** 语音任务书 fetch 注入(voice.draft 测试用);缺省=全局 fetch。 */
  voiceDraftFetch?: typeof fetch;
  /** 配置通道(面板设置页「运行配置」);缺省=cfg.* 报 not-implemented。 */
  cfg?: {
    view: () => { config: Record<string, unknown>; sources: Record<string, string>; projectPath: string; readOnly?: boolean };
    set: (patch: Record<string, unknown>) => { applied: string[]; needsRestart: string[] };
 /** 预设一键接入:写 secrets.json(只返回是否覆盖,不回显值)。 */
    secretSet?: (name: string, value: string) => { existed: boolean };
 /** 密钥名列表(只返回名字)。 */
    secretKeys?: () => string[];
  };
  /** 端点模型列表(设置页模型选择器);providerId=按该 provider 端点拉;缺省=not-implemented。 */
  listModels?: (providerId?: string) => Promise<string[]>;
 /** 单模型探活:设置页模型列表逐项「测」。 */
  probeModel?: (model: string, providerId?: string) => Promise<{ ok: boolean; ms: number; error?: string }>;
  /** per-session 主模型覆盖(白板「per-session 主模型」):session.model.set/get 的数据源;
   * set=先校验后落盘(routeError 不写盘)+journal 记 model.switch;get=该 sid override 或 null。
   * 缺省=两命令报 not-implemented(测试装配不注入即旧行为)。 */
  sessionModels?: import("./session-model.js").SessionModelApi;
 /** 连接 keepalive(qwen 形态心跳,防死连接挂账);interval=ping 周期,timeout=无 pong 判死。 */
  keepalive?: { intervalMs?: number; timeoutMs?: number };
 /** 自定义命令(2026-10 多根 + 诊断);缺省=commands.* 报 not-implemented。 */
  commands?: {
    list(): { name: string; body?: string; description?: string; inputHint?: string; path?: string }[];
    listWithDiagnostics?(): {
      commands: { name: string; body?: string; description?: string; inputHint?: string; path?: string }[];
      diagnostics: { path: string; severity: "warning" | "error"; message: string; code?: string; commandName?: string }[];
    };
    upsert(name: string, body: string, opts?: unknown): unknown;
    remove(name: string): boolean;
  };
 /** 任务生命周期钩子;缺省=hooks.* 报 not-implemented。 */
  hooks?: { list(): unknown[]; add(input: { name: string; event: string; command: string }): unknown; update(id: string, patch: { enabled?: boolean }): unknown; remove(id: string): boolean };
 /** MCP 管理器;缺省=mcp.* 报 not-implemented。 */
  mcp?: { store: { list(): { id: string; name: string; command: string; args: string[]; enabled: boolean; createdAt: number }[]; add(i: { name: string; command: string; args?: string[] }): unknown; update(id: string, patch: { enabled?: boolean }): unknown; remove(id: string): boolean }; statusOf(): Record<string, { ok: boolean | null; tools: number; error?: string }>; test(id: string): Promise<{ ok: boolean | null; tools: number; error?: string }> };
 /** 记忆库只读视图;缺省=memory.view 报 not-implemented。 */
  memoryView?: () => { user: string; memory: string; root: string; usage: { user: { used: number; limit: number }; memory: { used: number; limit: number } } };
 /** 插件系统;缺省=plugins.* 报 not-implemented。 */
  plugins?: {
    catalog(): unknown[];
    listInstalled(): { id: string; version: string; enabled: boolean; installedAt: number }[];
    install(id: string): unknown;
    uninstall(id: string): boolean;
    toggle(id: string, enabled: boolean): unknown;
  };
 /** 项目档案管线;缺省=profile.* 报 not-implemented。purge=项目移除时清产物。 */
  profiles?: {
    getOrStart(projectId: string): unknown;
    get(projectId: string): unknown;
    rebuild(projectId: string): boolean;
    purge?(projectId: string): void;
  };
 /** 远程向导:按 gateway 实际地址渲染引导命令;缺省=wizard.gen 报 not-implemented。 */
  wizardGen?: (input: { kind: "ssh" | "docker"; host: string; user: string; port: number; nodeId: string }) => { command: string; note: string };
 /** 内置技能禁用面;缺省=skills.disableBuiltin 报 not-implemented。 */
  skillsAdmin?: { disabled(): string[]; set(name: string, disabled: boolean): string[]; index(): { category: string; name: string; description: string }[] };
 /** 主模型上下文窗口(容量看板分母;未配=null)。 */
  contextWindow?: number;
 /** super agent 指挥台后端链:对话/历史/inbox/ASR;缺省=super.* 命令显式 not-implemented。 */
  superAgent?: {
    turn(text: string): Promise<string>;
    history(sinceSeq?: number): unknown[];
    /** 待处理清单(ask/permission/interrupted/blocked/failed);缺省=空数组。 */
    inbox?(limit?: number): import("@lampgenie/protocol").SuperInboxItem[];
    /** 语音输入转写(voice.transcribe);未配置=undefined,服务端回 VoiceUnavailable。 */
    asr?(audio: { data: string; format?: "pcm16" }): Promise<string>;
    /** 指挥台聊天窗活跃标记(super.turn / voice.transcribe 到达时调用;
     * ask_user 转接与任务状态播报据此决定是否主动触发一轮)。 */
    onActivity?: () => void;
  };
}

/** keepalive 生产默认:30s ping,75s 无 pong 判死(待标定)。 */
const KA_DEFAULTS = { intervalMs: 30_000, timeoutMs: 75_000 };

/** fixI7: 会话消息队列 API(startGatewayServer 构造注入 opts,handleMessage 消费)。 */
interface QueueApi {
  /** 全量队列快照(hello 恢复用)。 */
  snapshot(): import("@lampgenie/protocol").QueueItem[];
  /** 入队(session 忙碌时 task.submit 走这里);广播 queue.update。 */
  enqueue(msg: { sessionId: string; instruction: string; projectId?: string; attachments?: { name: string; path: string; mime?: string; size?: number }[] }): import("@lampgenie/protocol").QueueItem;
  /** 抢占:取消当前任务+立即提交该排队项。 */
  dispatchNow(msg: { sessionId: string; itemId: string }): { ok: true; task?: import("@lampgenie/core").Task } | { ok: false; reason: string };
  /** 删除队列项;不存在=false。 */
  remove(msg: { sessionId: string; itemId: string }): boolean;
}

/** keepalive env 通道:GENIE_WS_PING_MS / GENIE_WS_PONG_TIMEOUT_MS。
 * 优先级 显式 opts.keepalive > env > KA_DEFAULTS;非法/非正值忽略=回退缺省。
 * 返回=仅 env 提供的覆盖项(缺省由调用处 KA_DEFAULTS 先展开兜底—— 续作轮:原
 * 标注两项 required 与「部分覆盖」实现相悖,是前序 WIP 的类型错 TS2322@117,语义本就对)。 */
function keepaliveResolved(): { intervalMs?: number; timeoutMs?: number } {
  const envNum = (k: string) => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const ping = envNum("GENIE_WS_PING_MS");
  const pongTimeout = envNum("GENIE_WS_PONG_TIMEOUT_MS");
  return {
    ...(ping !== undefined ? { intervalMs: ping } : {}),
    ...(pongTimeout !== undefined ? { timeoutMs: pongTimeout } : {}),
  };
}

/**
 * session.fork 复制排除集(ZCode session-fork 语义裁剪,refs: ZCode):
 * 任务生命周期与快照噪声不继承(新会话会有自己的任务流);对话/工具/子代理/待办/目标
 * 等上下文事件全量继承(goal.set 继承=分叉会话带着原目标,符合 fork 语义)。
 */
const SESSION_FORK_EXCLUDED_KINDS: ReadonlySet<string> = new Set([
  "task.enqueue", "task.start", "task.progress", "task.done", "task.fail",
  "delivery.obligation", // :终态投递义务属于任务生命周期,分叉会话不继承
  "queue.sync", // 队列快照=环境态噪声:分叉会话不继承源会话的排队消息(与 task.* 同族排除)
  "checkpoint.create", "checkpoint.restore",
]);
let warmStarted = false; // :预热单次守卫(原每连接重触发;进程级一次足够,TTL 缓存自愈)

/** TTS 客户端懒缓存(voice.tts;配置热更由重启生效——与 provider 同语义)。 */
let ttsClientCache: { speak(text: string): Promise<{ mime: string; base64: string }> } | undefined | null = null;

/** repo wiki的 LLM 适配:主 LLM(chat) → 单 prompt generate。
 * 结构型判定,不改 GatewayServerOptions.llm 的既有类型;缺 LLM=确定性骨架(调用方降级)。 */
function wikiLlmFromProvider(provider: unknown): { generate(prompt: string): Promise<string> } | undefined {
  if (!provider || typeof (provider as { chat?: unknown }).chat !== "function") return undefined;
  const chat = (provider as { chat(messages: { role: string; content: string }[], tools: unknown[]): Promise<{ content?: string }> }).chat.bind(provider);
  return {
    async generate(prompt: string): Promise<string> {
      const r = await chat([{ role: "user", content: prompt }], []);
      if (typeof r?.content !== "string" || !r.content.trim()) throw new Error("wiki LLM 响应缺 content");
      return r.content;
    },
  };
}

/** 「总路线」并入代码档案的读取/生成面。
 * 读=loadProjectProfile(.genie/sense-index/profile.json,同步,缺席 exists=false 显式);
 * 生成=queryProjectProfile(确定性骨架 + 可选 LLM purpose 层)+ writeProjectProfile 落盘。
 * senseLlm 是 code-sense 包的进程级注入点:注入前存旧值、finally 还原,不留全局副作用。 */
async function profileSensePayload(
  root: string,
  opts: { generate?: boolean; refresh?: boolean; llm?: unknown },
): Promise<Record<string, unknown>> {
  const pp = await import("@lampgenie/code-sense/project-profile");
  let generated = false;
  if (opts.generate) {
    const { getSensingDeps, setSensingDeps } = await import("@lampgenie/code-sense/sensing/index");
    const prev = getSensingDeps();
    const senseLlm = wikiLlmFromProvider(opts.llm);
    try {
      if (senseLlm) setSensingDeps({ ...prev, senseLlm });
      else setSensingDeps(prev);
      const profile = await pp.queryProjectProfile(root, { withLlm: Boolean(senseLlm), refresh: opts.refresh === true });
      pp.writeProjectProfile(root, profile);
      generated = true;
    } finally {
      setSensingDeps(prev);
    }
  }
  const loaded = pp.loadProjectProfile(root);
  if (!loaded) {
    return {
      root, exists: false, generated,
      capabilities: [], driftWarnings: [],
      llmState: { status: "off", reason: "项目画像尚未生成——点「生成总路线」按需构建(确定性骨架无 LLM 也可用)" },
    };
  }
  const { profile } = loaded;
  const llm = profile.llm;
  const firstCand = profile.skeleton.purposeCandidates[0];
  const purpose = llm?.purpose ?? firstCand?.text;
  const purposeSource = llm ? "llm" : firstCand ? (/readme/i.test(firstCand.source) ? "readme" : "manifest") : undefined;
  return {
    root, exists: true, generated,
    stale: loaded.stale,
    builtAt: profile.builtAt,
    maturity: profile.skeleton.maturity,
    ...(purpose ? { purpose } : {}),
    ...(purposeSource ? { purposeSource } : {}),
    capabilities: llm?.capabilities ?? [],
    driftWarnings: llm?.driftWarnings ?? [],
    llmState: profile.llmState,
    skeleton: {
      purposeCandidates: profile.skeleton.purposeCandidates,
      ...(profile.skeleton.domain ? { domain: profile.skeleton.domain } : {}),
      techStack: profile.skeleton.techStack,
      frameworks: profile.skeleton.frameworks,
      ...(profile.skeleton.entrypoints ? { entrypoints: profile.skeleton.entrypoints } : {}),
      topoNotes: profile.skeleton.topoNotes,
      degraded: profile.skeleton.degraded,
    },
  };
}

export function startGatewayServer(opts: GatewayServerOptions & { server?: import("node:http").Server }): { close: () => Promise<void>; broadcast: (msg: import("@lampgenie/protocol").ServerMessage) => void } {
  const wss = opts.server ? new WebSocketServer({ server: opts.server }) : new WebSocketServer({ port: opts.port });
  const ka = { ...KA_DEFAULTS, ...keepaliveResolved(), ...(opts.keepalive ?? {}) };
  // g3(2026-11):WS 发送字节账本周期落账(30s,窗口内零帧自动跳过)——OOM 前留「谁在发大帧」的证据。
  // unref:定时器不吊住进程退出(与 kaTimer/预热定时器同口径);落账失败不影响发送路径。
  const wsLedgerTimer = setInterval(() => {
    try { flushWsLedger(wsByteLedger, opts.journal, Date.now()); } catch { /* 观测失败容忍 */ }
  }, WS_LEDGER_FLUSH_MS);
  wsLedgerTimer.unref?.();
 // 启动僵尸清算(「僵尸 worker」根治,机制4):上一进程遗留的 spawn-无-result 子代理
  // 统一补终态标记(journal append-only,补 subagent.result 事件不改历史)。此前网关重启后内存
  // 注册表清空,journal 里的孤儿 spawn 被面板目录永远显示「后台运行中 · 已工作 N 小时」。
  // 幂等(补过即非孤儿+idempotencyKey 双保险);本次进程新派的子代理不受影响(bootAt 界线在函数内)。
  {
    const reaped = reapOrphanSubagents(opts.journal);
    if (reaped.length > 0) {
      console.error(`[gateway] 启动清算:${reaped.length} 个上一进程遗留子代理补终态(网关重启,子代理随进程终止):${reaped.join(",")}`);
    }
  }
 // 文件索引预热(首次 @ 提及不再吃冷启动秒级延迟)。
 // :预热是同步重活(fileIndex 全仓 walk + sense 全图预生成),9p 慢盘上
  // 分钟级,曾把连接关键路径(面板首屏/hello/task 流)整个卡死;且原实现每个连接都重触发。
  // 改为:延迟 3s+单次守卫+unref——连接先走完,重活在事件循环空闲后一次跑(fileIndex 自带
  // 时间预算,最坏同步阻塞≈单预算)。
  if (opts.projects && !warmStarted) {
    warmStarted = true;
    const t = setTimeout(() => {
      void import("./file-index.js").then((m) => {
        try { m.fileIndex(opts.projects!.resolveWorkdir(opts.projects!.activeId())); } catch { /* 预热失败容忍,首查自愈 */ }
 // 静态调用索引预热(三改:全图提前生成落盘,agent code_index 按需毫秒查询)
        void import("./sense-index-manager.js").then((sm) => {
          try { sm.warmIndex(opts.projects!.resolveWorkdir(opts.projects!.activeId())); } catch { /* 容忍 */ }
 // 子仓逐个预热(首查体验②):工作区基根下未索引子仓按序后台建,消灭
          // 「绝大多数子仓首查=尚未就绪」死路。再延 30s(慢盘 17 子仓扫描+逐个 fork 有系统压力,
          // 先让主仓预热/fileIndex 跑),失败只记日志。GENIE_SENSE_WARM_SUBREPOS_DELAY_MS 可调。
          const subDelay = Number(process.env.GENIE_SENSE_WARM_SUBREPOS_DELAY_MS ?? 30_000);
          void sm.warmWorkspaceSubrepos(opts.projects!.resolveWorkdir(opts.projects!.activeId()), Number.isFinite(subDelay) ? Math.max(0, subDelay) : 30_000)
            .catch(() => { /* 预热失败容忍:首查等待兜底 */ });
        }).catch(() => { /* 容忍 */ });
        // 白板出图预热(2026-11):flowkit 是 ~800KB 纯 ESM,首调用 import 达百毫秒级;
        // 预热失败静默(出图时才把错误报到诊断里),不阻塞连接关键路径。
        void import("./board-diagram.js").then((m) => { void m.warmupBoardDiagram(); });
      });
    }, 3_000);
    t.unref?.();
  }
 // fixF2(面板卡+重连风暴):session.status.changed 广播 per-session 合并——前沿立即
  // +200ms 窗内合并、尾沿补发。旧=每个任务状态变化原样广播,多子代理并发时每子代理事件都触发
  // onChange→面板每帧回拉一次 session.status,广播风暴与回拉风暴互相放大(配合 F1 才能根治;
  // 200ms 时效足够,面板另有 3s 轮询兜底)。
  const STATUS_CHG_WINDOW_MS = 200;
  const statusChgState = new Map<string, { last: number; timer: ReturnType<typeof setTimeout> | null }>();
 // 活动时间广播闸(毫秒)。工具/流式事件高频,活动索引每条都更新,但只在活动时间推进超过该
  // 间隔时才借 status.changed 帧下发一次——避免把面板 session.status 回拉打成秒级风暴。
  const ACTIVITY_AIR_MS = 1000;
  // 全局活动帧最小间隔(ms):多会话并行时把活动帧总量压在 ~3.3 帧/秒以内(单会话另受 1s 闸)。
  const ACTIVITY_AIR_GLOBAL_MS = 300;
  let lastActAirWall = 0;
  const statusActAired = new Map<string, number>();
 // 会话删除/归档清空时的清理钩子(handleMessage 是模块级函数拿不到本作用域),
  // 由 startGatewayServer 注入:活动索引 + 广播闸一起清,同 sid 复用不继承旧活动时间。
  (opts as { forgetSessionActivity?: (sid: string) => void }).forgetSessionActivity = (sid: string): void => {
    if (!sid) return;
    try { opts.sessionActivity?.forget(sid); } catch { /* 清理失败不影响删除语义 */ }
    statusActAired.delete(sid);
  };
  const broadcastStatusChanged = (sessionId: string): void => {
 // 帧内带该会话最近活动时间(侧栏按活动时间排序/显示)。复用本帧 200ms 合并,
    // 不新增 message type;取当前索引值,尾沿补发时自动是最新值。
    const actAt = opts.sessionActivity?.get(sessionId);
    const frame = { v: PROTOCOL_VERSION, type: "session.status.changed" as const, sessionId, ...(actAt ? { lastActivityAt: actAt } : {}) };
    const now = Date.now();
    const st = statusChgState.get(sessionId) ?? { last: 0, timer: null };
    if (now - st.last >= STATUS_CHG_WINDOW_MS) {
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      st.last = now;
      statusChgState.set(sessionId, st);
      for (const client of wss.clients) safeSend(client, frame);
      return;
    }
    if (!st.timer) {
      st.timer = setTimeout(() => {
        statusChgState.delete(sessionId);
        for (const client of wss.clients) safeSend(client, frame);
      }, STATUS_CHG_WINDOW_MS - (now - st.last));
      st.timer.unref?.();
      statusChgState.set(sessionId, st);
    }
  };
  const broadcastAll = (msg: import("@lampgenie/protocol").ServerMessage): void => {
    if ((msg as { type?: string }).type === "session.status.changed") {
      broadcastStatusChanged(String((msg as { sessionId?: unknown }).sessionId ?? ""));
      return;
    }
    for (const client of wss.clients) safeSend(client, msg);
  };
  // 广播钩子注入(handleMessage 是模块级函数,拿不到 wss;project.* 变更推送用)。
  (opts as { broadcast?: (msg: import("@lampgenie/protocol").ServerMessage) => void }).broadcast = broadcastAll;
  // 看板刷新桥注入(2026-11):压缩成功/自动压缩完成后主动推一帧 trace.stats,面板不必等 2s 轮询。
  // 口径与 trace.stats 回包同源(computeTraceStats),避免两条路算出两个数。
  const broadcastTraceStats = async (sessionId: string): Promise<void> => {
    try {
      const frame = await computeTraceStats(sessionId, opts);
      for (const client of wss.clients) safeSend(client, frame);
    } catch { /* 看板刷新失败不阻塞主链路(面板轮询兜底) */ }
  };
  (opts as { broadcastTraceStats?: (sessionId: string) => Promise<void> }).broadcastTraceStats = broadcastTraceStats;
  // 同时注册进进程级注册表:agent-wiring 的自动压缩钩子(拿不到 opts/wss)据此推同一帧。
  registerTraceStatsBroadcaster(broadcastTraceStats);

  // fixI5: 会话消息队列(排队官 I)——session 忙碌时 task.submit 入队,
  // 任务到终态(done/failed/cancelled)FIFO 出队自动续发;抢占=取消当前+立即提交。
  // 队列快照随 hello 下发(页面刷新恢复);任何变更广播 queue.update。
 // (P3 登记根治):队列不再是纯内存态——每次变更经 queueBroadcast 落一条
  // queue.sync 全量快照到 journal,启动时 restoreQueues 回放重建(重启不丢)。
  const sessionQueues = new Map<string, import("@lampgenie/protocol").QueueItem[]>();
  const restored = restoreQueues(opts.journal);
  for (const [sid, items] of restored) sessionQueues.set(sid, items);
  if (restored.size > 0) {
    const n = [...restored.values()].reduce((a, b) => a + b.length, 0);
    console.error(`[gateway] 启动回放:恢复 ${n} 条排队消息(${restored.size} 个会话,来源 journal queue.sync)`);
  }
  // 抢占窗口抑制自动泵:queue.dispatch.now 里 cancel 会触发终态 onChange,
  // 不抑制会把「下一条排队消息」也自动顶上去(双提交竞争)。
  const suppressPump = new Set<string>();
  // 队列变更唯一出口:先落账(全量快照)再广播。入队/出队/删除/抢占/发送全走这里,
  // 任何一条变更路径漏调=重启丢消息,故禁止绕过本函数直接改 sessionQueues。
  // 落账失败(磁盘满/句柄失效)不阻断广播:队列内存态已变更,面板仍须看到真相;
  // 异常就地吞掉并告警——沿调用方(pumpQueue/onChange 回调/dispatchNow 的 finally)
  // 冒泡会升级成未捕获异常(与文件顶 B1 注记的「同步异常杀进程」同类风险)。
  const queueBroadcast = (sessionId: string) => {
    const items = sessionQueues.get(sessionId) ?? [];
    try {
      writeQueueSync(opts.journal, sessionId, items);
    } catch (err) {
      console.error(`[gateway] 队列快照落账失败(重启可能丢该会话排队消息):${String(err).slice(0, 160)}`);
    }
    opts.broadcast?.({ v: PROTOCOL_VERSION, type: "queue.update", sessionId, items });
  };
  const sessionActive = (sid: string) =>
    opts.taskManager.list().some((t) => t.sessionId === sid && (t.state === "queued" || t.state === "running" || t.state === "blocked"));
  const submitQueueItem = (item: import("@lampgenie/protocol").QueueItem) => {
    const task = opts.taskManager.submit("user", item.sessionId, item.instruction, {
      // 幂等键=queue.<sessionId>.<itemId>(会话命名空间,防跨会话同 id 误去重):重启回放据此
      // 判定该队列项已转任务(队列里不再排它,防二次执行);顺带获得同项重发不重建任务的幂等。
      idempotencyKey: queueItemKey(item.sessionId, item.id),
      // 项目决议:入队时已固化的 projectId > 会话 owner > active(队列入队处尽力固化,见 queueApi.enqueue)。
      ...(() => {
        const pid = resolveSubmitProjectId(opts.taskManager, item.sessionId, item.projectId, opts);
        return pid === undefined ? {} : { projectId: pid };
      })(),
      ...(item.attachments?.length ? { attachments: item.attachments } : {}),
    });
    // 广播 task.submitted:泵发/抢占没有请求方 ws,全体面板都要登记新任务(渲染/会话列表)。
    opts.broadcast?.({ v: PROTOCOL_VERSION, type: "task.submitted", task });
    return task;
  };
  // 终态泵:该 session 无在跑/排队任务且队列非空 → 队头出队提交(逐条 FIFO:本条再终态时续泵)。
  const pumpQueue = (sessionId: string) => {
    if (suppressPump.has(sessionId)) return;
    const q = sessionQueues.get(sessionId);
    if (!q || q.length === 0) return;
    if (sessionActive(sessionId)) return;
    const item = q.shift()!;
    if (q.length === 0) sessionQueues.delete(sessionId);
    // 先提交再落账:两步之间崩溃时 journal 的旧快照仍含该项,但该项已带 queue.<id> 幂等键
    // 的 task.* 事件 → 回放判「已提交」丢弃,不丢也不重;反序则崩在中间=消息凭空消失。
    submitQueueItem(item);
    queueBroadcast(sessionId);
  };
  opts.taskManager.onChange((task) => {
    if (task.state !== "done" && task.state !== "failed" && task.state !== "cancelled") return;
    pumpQueue(task.sessionId);
  });
  // fixI6: 队列 API 注入(handleMessage 用):入队/抢占/删除。
  const queueApi: QueueApi = {
    snapshot: () => [...sessionQueues.values()].flat(),
    enqueue(msg) {
      const q = sessionQueues.get(msg.sessionId) ?? [];
 // 归属固化(漂移根治):入队时就把 projectId 定下来,出队/重启回放不再依赖
      // 「出队当刻的 active 项目」——排队期间用户切项目不该改写这条消息的归属。
      const ownerProjectId = resolveSubmitProjectId(opts.taskManager, msg.sessionId, msg.projectId, opts);
      const item: import("@lampgenie/protocol").QueueItem = {
        id: `q-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        sessionId: msg.sessionId,
        instruction: msg.instruction,
        createdAt: Date.now(),
        ...(ownerProjectId !== undefined ? { projectId: ownerProjectId } : {}),
        ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
      };
      q.push(item);
      sessionQueues.set(msg.sessionId, q);
      queueBroadcast(msg.sessionId);
      return item;
    },
    dispatchNow(msg) {
      const q = sessionQueues.get(msg.sessionId) ?? [];
      const idx = q.findIndex((x) => x.id === msg.itemId);
      if (idx < 0) return { ok: false as const, reason: "队列项不存在(可能已发送或删除)" };
      const [item] = q.splice(idx, 1);
      if (!item) return { ok: false as const, reason: "队列项不存在(可能已发送或删除)" }; // tsc:splice 结果可能为空
      if (q.length === 0) sessionQueues.delete(msg.sessionId);
      // 抑制窗口内:取消当前任务(既有 cancel 链路:onChange→activeLoops.cancel 中断 LLM/工具)
      // + 立即提交该消息(同 sessionId,journal 上下文延续);旧 loop 的终态回写被 state guard 挡住。
      suppressPump.add(msg.sessionId);
      try {
        for (const t of opts.taskManager.list().filter((x) => x.sessionId === msg.sessionId && (x.state === "queued" || x.state === "running" || x.state === "blocked"))) {
          opts.taskManager.setState(t, "cancelled", "被新消息抢占(立即发送)");
        }
        const task = submitQueueItem(item);
        if (!task) return { ok: false as const, reason: "任务管理器拒绝了提交(会话或项目状态)" };
        return { ok: true as const, task };
      } finally {
        // 出队后的快照落账排在提交之后(同 pumpQueue:崩在两步之间也不会丢,回放按幂等键判已提交)。
        queueBroadcast(msg.sessionId);
        suppressPump.delete(msg.sessionId);
      }
    },
    remove(msg) {
      const q = sessionQueues.get(msg.sessionId) ?? [];
      const idx = q.findIndex((x) => x.id === msg.itemId);
      if (idx < 0) return false;
      q.splice(idx, 1);
      if (q.length === 0) sessionQueues.delete(msg.sessionId);
      queueBroadcast(msg.sessionId);
      return true;
    },
  };
  (opts as { queueApi?: QueueApi }).queueApi = queueApi;

  // 运行看板推模型(ref SSE /events 的 WS 总线对应物):journal 新事件 → 节流尾沿广播
  // dashboard.changed,面板收到后按当前作用域重拉 sessions/trends。节流 500ms:
  // 工具流事件高频(流式逐帧入账),逐条广播会把面板拉请求打成风暴;尾沿保证静默后必有一帧。
  if (opts.journal) {
    let dashThrottle: ReturnType<typeof setTimeout> | null = null;
    opts.journal.subscribe((e) => {
      // 重试态镜像(batch1b):provider 的 model_retry_scheduled 事件不带 sessionId(同进程共享
      // provider,无法按会话归属),故按 journal 旁路事件归集——llm.trace 失败态(C 端可见的
      // 「最后一次尝试失败」)/ 成功态(首个模型进展)/ 终态(onChange 清零)。失败原因解析 attempt。
 // 会话活动时间随 journal 事件更新,
      // 复用 session.status.changed 的 per-session 200ms 合并帧(帧内带 lastActivityAt),不新增帧类型。
      // 额外 1s 闸:工具/流式事件高频,逐条触发会让面板 status 回拉变密;索引照常更新,只是不广播。
      try {
        const sid = e.sessionId;
        if (opts.sessionActivity && sid && isSessionActivityKind(e.kind)) {
          opts.sessionActivity.noteEvent(e);
          // 闸按**墙钟**判(事件 time 可能来自导入/时钟偏斜的历史,用它会把广播静默到未来);
          // 再加一个全局最小间隔:多会话并行时把所有会话的活动帧总量压在 ~3.3 帧/秒以内。
          const wall = Date.now();
          const aired = statusActAired.get(sid) ?? 0;
          if (wall - aired >= ACTIVITY_AIR_MS && wall - lastActAirWall >= ACTIVITY_AIR_GLOBAL_MS) {
            statusActAired.set(sid, wall);
            lastActAirWall = wall;
            broadcastStatusChanged(sid);
          }
        }
      } catch { /* 旁路:活动索引故障绝不打断广播链 */ }
      try { trackRetryFromEvent(e); } catch { /* 旁路:镜像故障绝不打断广播链 */ }
      if (dashThrottle) return;
      dashThrottle = setTimeout(() => {
        dashThrottle = null;
        for (const client of wss.clients) safeSend(client, { v: PROTOCOL_VERSION, type: "dashboard.changed" });
      }, 500);
      dashThrottle.unref?.();
    });
  }
  // 重试态归集器:journal 事件 → session-retry-state 三方法(batch1b)。失败重试登记后广播
  // session.status.changed(面板拉 session.status 即从快照恢复重试条),每条会话 200ms 合并。
  const retryMaxRetries = Number(process.env.GENIE_LLM_RETRY ?? 2) || 0;
  // function 声明而非 const:上面 journal.subscribe 在定义前就引用它,若 subscribe 同步回放历史
  // 事件,const 版本会落进 TDZ 被空 catch 静默吞掉;函数声明提升可消除该隐患。
  function trackRetryFromEvent(e: import("@lampgenie/core").JournalEvent): void {
    const sid = e.sessionId;
    if (!sid) return;
    if (e.kind === "llm.trace") {
      const p = (e.payload ?? {}) as { error?: unknown };
      const err = typeof p.error === "string" ? p.error : "";
      // 可重试类失败(与 openai-provider.postWithRetry 的抛出文案同源):网络层/5xx/429。
      const retryable = /LLM 网络错误|LLM (429|500|502|503|504)\b|rate.?limit|MODEL_STREAM_IDLE_TIMEOUT/i.test(err);
      if (err && retryable) {
        const done = Number(/已重试 (\d+) 次/.exec(err)?.[1] ?? 0);
        const httpStatus = Number(/\bLLM (\d{3})\b/.exec(err)?.[1] ?? 0);
        beginRetry(sid, {
          attempt: Math.max(1, done || 1),
          maxRetries: retryMaxRetries,
          errorStatus: httpStatus > 0 ? httpStatus : null,
          error: err.slice(0, 120),
        });
        broadcastStatusChanged(sid);
        return;
      }
      // 本次 chat 成功 = 首个模型进展到达(重试已恢复):清重试态(不清=切回还会看到旧条)。
      if (!err) { clearOnProgress(sid); return; }
    }
    // step.end reason=error 是 loop 级失败的落点,同样不算恢复,保持重试态(按首个进展才清)。
  }
  // 任务终态(done/failed/cancelled)→ 重试态清零(snapshot 回包不再带 apiRetry)。
  opts.taskManager.onChange((task) => {
    if (task.state !== "done" && task.state !== "failed" && task.state !== "cancelled") return;
    clearOnTerminal(task.sessionId);
    broadcastStatusChanged(task.sessionId);
  });

 // 网关终态投递义务:终态事件先幂等登记义务,再「只对已连接 adapter」claim 投递。
  // 无连接=保持 pending(不 claim、不 markDelivered),等 hello 补投或 60s sweep 回收租约后重投。
  const deliveryObligations: DeliveryObligationStore =
    opts.deliveryObligations ?? createDeliveryObligationStore({ journal: opts.journal });
  /** 终态帧与在线通道同形(task.changed + TaskIndex 投影,见下方 per-connection onChange),
   *  额外带义务坐标:重发帧 mayBeDuplicate=true(attempts>1),面板可去重展示。 */
  const terminalFrameOf = (task: import("@lampgenie/core").Task, ob: DeliveryObligation) => ({
    v: PROTOCOL_VERSION,
    type: "task.changed" as const,
    task: taskIndexOf(task),
    obligationId: ob.obligationId,
    attempts: ob.attempts,
    mayBeDuplicate: ob.mayBeDuplicate,
  });
  /** 是否有可用(OPEN)连接:无连接时不得 claim——这是「只对已连接 adapter 投递」的判据。 */
  const hasOpenClient = (): boolean => {
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) return true;
    return false;
  };
  /** 广播终态帧,返回至少一个连接收到=true;单连接发送抛错只算该连接失败。 */
  const sendTerminalFrame = (frame: unknown): boolean => {
    let sent = 0;
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try { safeSend(client, frame); sent += 1; } catch { /* 单连接失败不影响其它连接 */ }
    }
    return sent > 0;
  };
  /** 投递一条义务:claim → 发帧 → delivered;send 失败=release 回 pending(下次带 mayBeDuplicate)。 */
  const deliverObligation = (taskId: string): DeliveryObligation | undefined => {
    const task = opts.taskManager.get(taskId);
    if (!task) {
      deliveryObligations.markFailed(taskId, "task-missing");
      return undefined;
    }
    return attemptDelivery(deliveryObligations, taskId, (ob) => sendTerminalFrame(terminalFrameOf(task, ob)));
  };
  opts.taskManager.onChange((task) => {
    if (task.state !== "done" && task.state !== "failed" && task.state !== "cancelled") return;
    try {
      deliveryObligations.register(task); // 幂等:同一 taskId 重复登记不新增事件
      if (!hasOpenClient()) return; // 无连接:义务停在 pending
      deliverObligation(task.id);
    } catch (err) {
      // 投递义务是保证性旁路:落账/发送异常不得打断会话状态推送与队列泵。
      console.error("[gateway] 终态投递义务失败(不阻塞主链):", String(err).slice(0, 200));
    }
  });
  // 周期 sweep:回收超租约 attempting(进程内发送挂住/连接中途断开)→ pending,并仅在已连接时重投。
  const deliverySweepTimer = setInterval(() => {
    try {
      const due = deliveryObligations.sweep();
      if (!due.length || !hasOpenClient()) return;
      for (const ob of due) deliverObligation(ob.taskId);
    } catch { /* 回收失败下一轮重试 */ }
  }, 60_000);
  deliverySweepTimer.unref?.();

  wss.on("connection", (ws: WebSocket) => {
    if (opts.permissionBroker) opts.permissionBroker.online = true;
    if (opts.workflowAskRouter) opts.workflowAskRouter.online = true;
    if (opts.askUser) opts.askUser.online = true;
    // 连接级 error 必须接住:客户端异常断开时 ws 异步 emit error,无监听=unhandled 崩服务。
    (ws as { connSeq?: number }).connSeq = ++panelConnSeq; // 观测:project.add/remove 审计带连接序号
    ws.on("error", () => {});
    // keepalive:周期 protocol-level ping(ws 库/浏览器自动回 pong),超时无 pong 判死连接。
    // fixF4(核对):ping 已走 ws 协议帧(非应用消息),无需改造;判死根因是 F1 前的全扫占死
    // 事件循环致 pong 排队,由 F1/F2/F3 治本,此处保持 30s/75s 口径。
    let lastPong = Date.now();
    ws.on("pong", () => { lastPong = Date.now(); });
    const kaTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPong > ka.timeoutMs) {
        ws.terminate();
        return;
      }
      ws.ping();
    }, ka.intervalMs);
    kaTimer.unref?.();

    // 任务变更时推给这个客户端(索引投影:列表帧不带正文,正文由面板 task.detail.get 现取)。
    const unsubscribe = opts.taskManager.onChange((task) => {
      safeSend(ws, { v: PROTOCOL_VERSION, type: "task.changed", task: taskIndexOf(task) });
    });

    ws.on("message", (raw: Buffer) => {
 // B1:分发层任何同步异常都会沿 ws Receiver 冒泡成 uncaughtException 杀整进程
      // (今晚多次无声重启死因)——parse 与处理器各自兜底,异常留在连接内并回 error 帧。
 // P3:非法原因的文案只有一个来源 = explainClientMessageError(含非 JSON 与
      // 字段校验两类),旧的两条重复分类路径已收敛(避免以后只改一处)。
      const rawText = raw.toString();
      let msg;
      try {
        msg = parseClientMessage(rawText);
      } catch (err) {
        // 防御分支:parseClientMessage 内部已自兜底(非 JSON/字段失败均返回 null)理论不抛(B1);
        // 真抛也不冒泡,且把原文回报——不让根因被通用文案掩盖。与下面的 explain 路径不重叠。
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.InvalidMessage, message: "消息解析异常:" + String(err).slice(0, 120) });
        return;
      }
      if (String((msg as { type?: string })?.type ?? "").startsWith("project.") || String(rawText).includes('"project.')) console.error("[projects.audit] 消息入口 type=" + String((msg as { type?: string })?.type ?? "?") + " raw=" + rawText.slice(0, 80));
      if (!msg) {
        safeSend(ws, {
          v: PROTOCOL_VERSION, type: "error", code: ErrorCode.InvalidMessage,
          // 唯一来源 = explain(非 JSON 与字段校验两类都从此出);?? 兜底只在 schema 判定漂移时可达。
          message: explainClientMessageError(rawText) ?? "非法消息(信封 v:1 必填/未知类型/字段缺失)",
        });
        return;
      }
 //  能力暴露 allowlist(闸在分发最顶部):连接级 clientMode 白名单命中才进 switch。
      // 表外 channel 一律拒(不是 denylist),高权限 channel 再走 per-method 判定;
      // 拒收只回帧 + journal,不落到 switch default 静默。
      const clientMode = clientModeByWs.get(ws) ?? DEFAULT_CLIENT_MODE;
      const channel = String((msg as { type: string }).type);
      if (!isChannelAllowed(clientMode, channel) || !isMethodAllowed(clientMode, channel, msg)) {
        denyChannel(ws, opts.journal, clientMode, channel, msg as { sessionId?: unknown });
        return;
      }
      handleMessage(ws, msg, opts).catch((err: unknown) => {
        console.error("[gateway] 消息处理异常(连接保持):", String(err).slice(0, 200));
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.HandlerCrash, message: String(err).slice(0, 160) });
      });
    });

    ws.on("close", () => {
      clearInterval(kaTimer); unsubscribe();
      // 内置浏览器视图退订(否则截图流对已死连接空转;订阅表按 ws 存)。
      const bv = browserViewSubs.get(ws);
      if (bv) {
        browserViewSubs.delete(ws);
        void import("./browser-tool.js")
          .then((m) => m.getBrowserViewHub(repoRoot(), browserCfgOf(opts)).unsubscribe(bv.subId))
          .catch(() => { /* 卸载期失败无需上报 */ });
      }
      // 审批在线性=wss.clients 数(断到零=离线,后续 ask 立即 fail-closed)。
      if (opts.permissionBroker) opts.permissionBroker.online = wss.clients.size > 0;
      if (opts.workflowAskRouter) opts.workflowAskRouter.online = wss.clients.size > 0;
      if (opts.askUser) opts.askUser.online = wss.clients.size > 0;
    });
    safeSend(ws, { v: PROTOCOL_VERSION, type: "hello", build: PANEL_BUILD, platform: process.platform, tasks: taskIndexList(opts.taskManager.list()), ...(queueApi ? { queue: queueApi.snapshot() } : {}), ...(opts.sessionActivity && opts.sessionActivity.size() ? { sessionActivity: opts.sessionActivity.snapshot() } : {}) });
    if (opts.projects) safeSend(ws, projectListMessage(opts.projects));
 // 新连接补投:把仍未 delivered 的终态义务(限 100)重发给本连接。
    // 逐条 claim → 发同一终态帧 → delivered;发送失败 release 回 pending(等下次 hello/sweep)。
    // 重发帧的 mayBeDuplicate 由 attempts>1 决定(restart 后首次补投仍是首投,不带重复标记)。
    for (const pendingOb of deliveryObligations.pending(100)) {
      if (ws.readyState !== WebSocket.OPEN) break; // 连接中途断开:剩下的留在 pending,不空转
      const task = opts.taskManager.get(pendingOb.taskId);
      if (!task) { deliveryObligations.markFailed(pendingOb.taskId, "task-missing"); continue; }
      const ob = deliveryObligations.beginAttempt(pendingOb.taskId);
      if (!ob) continue;
      let ok = false;
      try { safeSend(ws, terminalFrameOf(task, ob)); ok = true; } catch { ok = false; }
      if (ok) deliveryObligations.markDelivered(pendingOb.taskId);
      else deliveryObligations.release(pendingOb.taskId);
    }
  });

  // 事件总线广播(系统级事件)。
  const onBusEvent = (topic: string) => (payload: unknown) => {
    for (const client of wss.clients) safeSend(client, { v: PROTOCOL_VERSION, type: topic, payload });
  };
  bus.on("subagent.result", onBusEvent("subagent.result"));
 // 白板更新广播:agent board_upsert 写板 → bus → 面板板视图即时刷新。
  bus.on("board.changed", onBusEvent("board.changed"));

  return {
 /** 广播到全体客户端(权限审批通道复用;fixF2:status.changed 走 per-session 合并)。 */
    broadcast: broadcastAll,
    close: () =>
      new Promise((resolve) => {
        clearInterval(wsLedgerTimer); // g3:账本定时器随服务关闭清理
        clearInterval(deliverySweepTimer); // :投递义务 sweep 定时器随服务关闭清理(否则 vitest 挂住)
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

/** 会话归属查询(归属漂移根治):该 session **最早**一条带 projectId 的任务的 projectId=
 * 会话既有 owner。注意:web-1792572143140 前 5 个任务 projectId=__harness__,第 6 个突然变成用户
 * 期间切换的 active 项目(genie)——同会话追问被贴到新项目,历史/看板/板根全错位。
 * 语义:会话是「归属已定」的容器,active 项目只决定**新会话**的归属,不该改写老会话。 */
export function sessionOwnerProjectId(tm: TaskSupervisor, sessionId: string): string | undefined {
  const owner = tm
    .list({ sessionId })
    .filter((t) => typeof t.projectId === "string" && t.projectId.length > 0)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  return owner?.projectId;
}

/** 会话项目归属的持久事实( ZCode session.project_id 语义移植):
 * 首次绑定写一条 session.project.bind,之后普通路径不可改写。为什么需要:owner 此前只从任务
 * 派生——任务被删(task.deleteSession)/项目被清(scrub)后归属证据消失,下一次提交静默回落到
 * 当前 active 项目(经验证:web-1792663585723 前两任务 pid=genie,重启后点「重发」变 __harness__)。
 * ZCode 的对价是 session 行 project_id:写入后无改归属 API、resume 不重算、fork 继承父行;
 * 这里把同一语义落在 journal 事件上(幂等键保证只写一次,分叉复制事件时天然继承)。 */
export const SESSION_PROJECT_BIND_KIND = "session.project.bind";

/** 读会话已绑定的 owner 项目(绑定事件优先;无=undefined)。 */
export function sessionBindProjectId(journal: Journal, sessionId: string): string | undefined {
  try {
    for (const e of journal.readSession(sessionId)) {
      if (e.kind !== SESSION_PROJECT_BIND_KIND) continue;
      const pid = (e.payload as { projectId?: unknown } | undefined)?.projectId;
      if (typeof pid === "string" && pid) return pid;
    }
  } catch { /* 读失败=无绑定,回落派生 */ }
  return undefined;
}

/** 幂等绑定(已有绑定=不写,owner 不可改写)。 */
export function bindSessionProject(
  journal: Journal,
  sessionId: string,
  projectId: string | undefined,
  source: "first_task" | "explicit" | "active" | "fork",
): void {
  if (!projectId) return;
  if (sessionBindProjectId(journal, sessionId) !== undefined) return;
  try {
    journal.append({
      kind: SESSION_PROJECT_BIND_KIND,
      sessionId,
      idempotencyKey: `session.project.bind.${sessionId}`,
      payload: { projectId, source, boundAt: Date.now() },
    });
  } catch { /* 绑定失败不阻塞提交(下次提交重试) */ }
}

/** 存量漂移归位(ZCode「归属不可变」的迁移面):旧序 explicit > owner 期间,
 * 会话里晚于 owner 任务、却被显式参数贴到别的项目的任务 = 旧 bug 的产物,启动时一次性归位到 owner。
 * 保守口径:①owner 必须在册(owner 已移除不迁移,避免迁到不存在项目);②必须存在与 owner 同项目的
 * 任务作为证据;③只修 createdAt 晚于该证据任务的任务;④幂等(修完 projectId==owner 不再命中),
 * 每次修复落一条 custom 事件留审计。返回修复条数。 */
export function repairSessionProjectDrift(
  journal: Journal,
  tm: TaskSupervisor,
  projects: ProjectRegistry): number {
  const bySession = new Map<string, import("@lampgenie/core").Task[]>();
  for (const t of tm.list()) {
    if (!t.projectId) continue;
    const arr = bySession.get(t.sessionId);
    if (arr) arr.push(t); else bySession.set(t.sessionId, [t]);
  }
  let repaired = 0;
  for (const [sid, tasks] of bySession) {
    const owner = sessionOwnerOf(journal, tm, sid);
    if (!owner || !projects.has(owner)) continue;
    const sorted = [...tasks].sort((a, b) => a.createdAt - b.createdAt);
    const anchor = sorted.find((t) => t.projectId === owner);
    if (!anchor) continue;
    for (const t of sorted) {
      if (t.projectId === owner) continue;
      if (t.createdAt <= anchor.createdAt) continue;
      const fixed = { ...t, projectId: owner };
      try {
        // append-only:补一条纠偏快照(回放取最后态),不删历史。
        journal.append({ kind: "task.progress", sessionId: sid, payload: fixed });
        journal.append({ kind: "custom", sessionId: sid, payload: { type: "task.project.repair", taskId: t.id, from: t.projectId, to: owner } });
        tm.inject(fixed);
      } catch { continue; }
      repaired++;
    }
  }
  return repaired;
}

/** 会话 owner 全序:已绑定事实 > 最早带 projectId 的任务(老会话派生) > undefined。 */
export function sessionOwnerOf(journal: Journal | undefined, tm: TaskSupervisor, sessionId: string): string | undefined {
  const bound = journal ? sessionBindProjectId(journal, sessionId) : undefined;
  if (bound !== undefined) return bound;
  return sessionOwnerProjectId(tm, sessionId);
}

/**
 * 服务端签发信封用的当前策略(与 agent-wiring 开工校验同源:permissionMode + agent.maxSteps)。
 * 口径必须两处一致,否则每个外部任务都会在开工时报 POLICY_DRIFT。
 */
export function envelopePolicyOf(opts: { config?: unknown }): EnvelopePolicy {
  let maxIterations = 3000;
  try {
    const cv = (opts.config as { view?: () => { config?: { agent?: { maxSteps?: number } } } } | undefined)?.view?.().config;
    const n = Number(cv?.agent?.maxSteps ?? 0);
    if (Number.isFinite(n) && n > 0) maxIterations = n;
  } catch { /* cfg 不可用=缺省 3000 */ }
  return { approval: permissionMode(), maxIterations };
}

/** 提交任务时的 projectId 决议(唯一入口,直提/队列/审批共用)。
 * ZCode 语义修正:**会话 owner 优先于 explicit**——显式参数只决定「新会话」的归属,
 * 不得改写已定归属(旧序 explicit > owner 是本次漂移的直接原因:面板每次提交都带 active 项目)。
 * 序:已绑定 > 最早任务 owner > explicit > active > undefined(workdir 回退 harness 根)。 */
export function resolveSubmitProjectId(
  tm: TaskSupervisor,
  sessionId: string,
  explicit: string | undefined,
  opts: { projects?: ProjectRegistry; journal?: Journal },
): string | undefined {
  const owner = sessionOwnerOf(opts.journal, tm, sessionId);
  if (owner !== undefined) {
    // 老会话(任务派生 owner、尚无绑定事件)在此补写一次,之后归属不再依赖任务存活。
    if (opts.journal) bindSessionProject(opts.journal, sessionId, owner, "first_task");
    return owner;
  }
  const resolved = explicit !== undefined ? explicit : (opts.projects ? opts.projects.activeId() : undefined);
  if (opts.journal && resolved !== undefined) {
    bindSessionProject(opts.journal, sessionId, resolved, explicit !== undefined ? "explicit" : "active");
  }
  return resolved;
}

/** browser 工具门禁的同源取用(面板视图与 agent 工具读同一份,不允许绕门禁)。
 * 语义来源: apps/gateway/src/app.ts:478-483(worker/进程内两条装配路径)。 */
function browserCfgOf(opts: GatewayServerOptions): {
  enabled: () => boolean; allowDomains: () => string[];
  idleMinutes?: () => number; profile?: () => "persistent" | "ephemeral"; profileDir?: () => string; headless?: () => boolean;
} {
  if (opts.browserConfig) return opts.browserConfig;
  /* 2026-11 browser-ux-redo:enabled 缺省 true(与 schema 同口径);新增四项从 opts.config 现读。 */
  const cfg = opts.config as { browser?: { enabled?: boolean; allowDomains?: string[]; idleMinutes?: number; profile?: "persistent" | "ephemeral"; profileDir?: string; headless?: boolean } } | undefined;
  return {
    enabled: () => cfg?.browser?.enabled !== false,
    allowDomains: () => cfg?.browser?.allowDomains ?? [],
    idleMinutes: () => cfg?.browser?.idleMinutes ?? 30,
    profile: () => cfg?.browser?.profile ?? "persistent",
    profileDir: () => cfg?.browser?.profileDir ?? ".genie/browser-profile",
    headless: () => cfg?.browser?.headless ?? (process.platform !== "win32" && process.platform !== "darwin"),
  };
}

/** 连接级 browser 视图订阅表:每 ws 至多一个订阅(重订阅先退旧的)。
 * 断连必须退订(否则截图流对死连接空转),见 startGatewayServer 的 ws.on("close")。 */
const browserViewSubs = new Map<WebSocket, { subId: string; tabId: string | null }>();

/** per-session 主模型回包广播(旧实现只回发起 socket,多标签不同步)。
 * 成功=广播全体(其它标签页/客户端同步 pill);失败同样广播(纠正别的标签的乐观值),
 * 但文案只回发起方。广播通道未注入(独立装配)→ 退化为只回发起连接,零行为差异。 */
function broadcastSessionModel(
  r: import("./session-model.js").SessionModelSetOutcome & { sessionId: string },
  ws: WebSocket,
  opts: GatewayServerOptions): void {
  const frame: import("@lampgenie/protocol").ServerMessage = {
    v: PROTOCOL_VERSION,
    type: "session.model.result",
    sessionId: r.sessionId,
    modelOverride: r.modelOverride,
    ok: r.ok,
    revision: r.revision,
    ...(r.code ? { code: r.code } : {}),
    ...(r.effective ? { effective: r.effective } : {}),
    ...(r.warning ? { warning: r.warning } : {}),
    ...(r.routeError ? { routeError: r.routeError } : {}),
  };
  if (opts.broadcast) opts.broadcast(frame);
  else safeSend(ws, frame);
}

/** 压缩状态帧广播(2026-11 边界元数据):手动 /compact 与自动钩子共用的过程广播。
 * 通道未注入(独立装配/测试)→ 退化为只回发起连接,零行为差异(同 broadcastSessionModel)。 */
function broadcastCompactStatus(
  frame: import("@lampgenie/protocol").ServerMessage,
  ws: WebSocket,
  opts: GatewayServerOptions): void {
  if (opts.broadcast) opts.broadcast(frame);
  else safeSend(ws, frame);
}

/** 追踪统计派生(trace.stats 回包体;2026-11 抽出闭包供「看板刷新桥」复用)。
 * 原为 case "trace.stats" 主体,逐字搬迁:readSession 索引切片 + 水位 memo + cfg 分母 + costModels。 */
async function computeTraceStats(
  sessionId: string,
  opts: GatewayServerOptions): Promise<{ v: number; type: "trace.stats.result"; sessionId: string; stats: Record<string, unknown> }> {
  const { deriveTraceStats } = await import("@lampgenie/runtime/agent/trace-stats");
 // 深度优化(经验证):旧路径 journal.readAll.filter(sid) 每次都把全库 28 万条
 // 走一遍引用过滤(经验证 median 12.2ms,同步占事件循环);而 readSession(sid) 的会话索引
 // 是 O(log n) 二分切片(经验证 2.62ms,4.7×)。索引在 buildEvent/load 双路径已挂链,直接换。
  const sessionEvents = opts.journal.readSession(sessionId);
  // 水位 memo(照 session.status 的已验证范式:水位=会话事件数,append-only 只增):
  // 面板 2s 一拍 × 多连接,事件不变时纯聚合结果必然相同 → 直接复用,不再重算。
  // 会话内部有新事件(append)→ 事件数变 → 自然失效重算,不需要额外失效逻辑。
  const tstatsHit = traceStatsMemo.get(sessionId);
  let stats: ReturnType<typeof deriveTraceStats>;
  if (tstatsHit && tstatsHit.watermark === sessionEvents.length) {
    stats = tstatsHit.stats;
  } else {
    // 分片让步保留:首次/有新事件时仍可能贡献一批新事件的加工,不让它独占事件循环。
    stats = deriveTraceStats(
      await scanChunked(sessionEvents, (batch) => batch.map((e) => ({ kind: e.kind, payload: e.payload, time: e.time }))),
    );
    if (traceStatsMemo.size > 64 && !traceStatsMemo.has(sessionId)) {
      const oldest = traceStatsMemo.keys().next().value;
      if (oldest !== undefined) traceStatsMemo.delete(oldest);
    }
    traceStatsMemo.set(sessionId, { watermark: sessionEvents.length, stats });
  }
  // 容量分母实时读 cfg(cfg.set 热生效;启动快照作回退)
  let ctxWin = opts.contextWindow ?? null;
  let cfgObj: import("@lampgenie/core").Config | undefined;
  try {
    const cv = (opts.cfg?.view?.().config ?? {}) as { audio?: { chat?: { contextWindow?: number } }; coding?: { llm?: { contextWindow?: number } } };
    cfgObj = cv as unknown as import("@lampgenie/core").Config;
 // 口径对齐压缩分母——opts.contextWindow 就是 wireAgentLoop 生效窗口,配置兜底按 coding→audio
    // (旧序 audio 配置优先,与压缩分母不同源:面板容量%与触发阈值会对不上)
    ctxWin = Number(ctxWin ?? cv.coding?.llm?.contextWindow ?? cv.audio?.chat?.contextWindow ?? 0) || null;
  } catch { /* cfg 不可用=回退启动快照 */ }
 // 成本核算:按模型用量 × 该模型单价算四段成本(缓存命中/写入/未命中/输出)。
  // 计费门:只有 authMode 非 token-plan 的端点才出金额——套餐已包月,再显示「花了多少钱」是假账。
  // 单价缺失 → 该模型 billed=false 且 price=null,前端如实显示「未配单价」,绝不按 0 元展示。
  let costModels: Record<string, unknown>[] | undefined;
  try {
    const core = await import("@lampgenie/core");
    // 计费门单点在 core.billingForModel:authMode=token-plan 的端点 billed=false 且不出金额,
    // 单价缺失时 price/cost 为 null(前端显示「未配单价」,不写 0 元假账)。
    costModels = (stats.byModel ?? []).map((m) => ({
      ...core.billingForModel(cfgObj, m.model, {
        input: m.input, cached: m.cached, cacheWrite: m.cacheWrite ?? 0, output: m.output,
      }),
      tokens: m,
    }));
  } catch { /* 单价模块不可用=不出金额(比出假金额好) */ }
  return {
    v: PROTOCOL_VERSION, type: "trace.stats.result", sessionId,
    stats: { ...stats, contextWindow: ctxWin, ...(costModels ? { costModels } : {}) },
  };
}

async function handleMessage(
  ws: WebSocket,
  msg: ClientMessage,
  opts: GatewayServerOptions): Promise<void> {
  const { taskManager: tm, journal, nodes } = opts;
  switch (msg.type) {
    case "client.mode": {
 // :连接级 clientMode 声明。只对本连接生效(允许任意设置:面板可降级,
      // readonly/agent 也可再改回——权限收放由 allowlist 决定,不由 mode 历史决定)。
      const raw = String((msg as { mode?: unknown }).mode ?? "");
      const prev = clientModeByWs.get(ws) ?? DEFAULT_CLIENT_MODE;
      if (!isClientMode(raw)) {
        safeSend(ws, {
          v: PROTOCOL_VERSION, type: "client.mode.result", ok: false, mode: prev,
          error: `非法 clientMode:${raw.slice(0, 40)}(可选 ${CLIENT_MODES.join("/")})`,
        });
        break;
      }
      clientModeByWs.set(ws, raw);
      if (raw !== prev) {
        try {
          journal.append({
            kind: "custom",
            sessionId: "",
            payload: { type: "client.mode.changed", from: prev, to: raw, at: Date.now() },
          });
        } catch { /* 审计失败不影响设置 */ }
      }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "client.mode.result", ok: true, mode: raw });
      break;
    }
    case "task.submit": {
 // 任务执行信封:外部来源(bot/remote/group/schedule)必须带服务端签发的信封。
      // 协议零改:来源描述符按消息上存在性读取(面板不带=内部 user 路径,逐字零变化)。
      // 自声明 workspace/permissions → 拒;deliveryKey 重投 → duplicate 回执不重复建任务;
      // 无信封 → 服务端用当前能力目录/策略签发并 journal task.envelope.issued。
      const rawSubmit = msg as unknown as ExternalSubmitRaw;
      const extSource = externalSourceOf(rawSubmit, msg.sessionId);
      if (extSource) {
        const envelopeOpts = opts.envelope;
        const submitProjectId = resolveSubmitProjectId(tm, msg.sessionId, msg.projectId, opts);
        const gate = gateExternalSubmit(
          {
            sessionId: msg.sessionId,
            instruction: msg.instruction,
            source: extSource,
            ...(rawSubmit.envelope !== undefined ? { envelope: rawSubmit.envelope as TaskEnvelope } : {}),
            ...(typeof rawSubmit.deliveryKey === "string" ? { deliveryKey: rawSubmit.deliveryKey } : {}),
            declared: {
              workspace: rawSubmit.workspace,
              projectOverride: rawSubmit.projectOverride,
              permissions: rawSubmit.permissions,
              policy: rawSubmit.policy,
            },
            extra: {
              ...(msg.targetNode !== undefined ? { targetNode: msg.targetNode } : {}),
              ...(msg.resourceTags !== undefined ? { resourceTags: msg.resourceTags } : {}),
              ...(msg.credentialRef !== undefined ? { credentialRef: msg.credentialRef } : {}),
              ...(submitProjectId === undefined ? {} : { projectId: submitProjectId }),
              ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
            },
          },
          {
            taskManager: tm,
            journal,
            ...(envelopeOpts?.capabilitySnapshot ? { capabilitySnapshot: envelopeOpts.capabilitySnapshot } : {}),
            ...(envelopeOpts?.policy ? { policy: envelopeOpts.policy } : { policy: () => envelopePolicyOf(opts) }),
          },
        );
        if (!gate.ok) {
          // fail-closed:漂移/自声明一律不建任务(稳定码,面板按 code 展示)。
          safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: gate.code, message: gate.message });
          break;
        }
        safeSend(ws, {
          v: PROTOCOL_VERSION,
          type: "task.submitted",
          task: gate.task,
          ...(gate.duplicate ? { duplicate: true } : {}),
          ...(gate.envelope ? { envelope: gate.envelope } : {}),
        });
        break;
      }
      // fixI8: 会话忙碌(queued/running/blocked 任一)→ 默认入队不并行(旧=per-owner 2 lane
      // 同 session 双 loop 交错 journal);任务终态 FIFO 自动续发。非忙碌=原直提路径不变。
      const queueApi = (opts as { queueApi?: QueueApi }).queueApi;
      if (queueApi && tm.list().some((t) => t.sessionId === msg.sessionId && (t.state === "queued" || t.state === "running" || t.state === "blocked"))) {
        queueApi.enqueue(msg);
        break;
      }
 // super-agent Router P1:面板主径 Trigger 入 router(intake 三判据→gate→
      // explicit 派发/订阅直通/observe 落账)。dispatched/steered → task.submitted 回执
      // 逐字段与直提路径同构(同一 tm.submit,extras 全透传)。router 未注入=原直提路径不变。
      const routerApi = (opts as { routerApi?: RouterApi }).routerApi;
      if (routerApi) {
        const pid = resolveSubmitProjectId(tm, msg.sessionId, msg.projectId, opts);
        const r = await routerApi.submit({
          source: "panel",
          sessionId: msg.sessionId,
          instruction: msg.instruction,
          ...(msg.idempotencyKey !== undefined ? { idempotencyKey: msg.idempotencyKey } : {}),
          extra: {
            ...(msg.targetNode !== undefined ? { targetNode: msg.targetNode } : {}),
            ...(msg.resourceTags !== undefined ? { resourceTags: msg.resourceTags } : {}),
            ...(msg.credentialRef !== undefined ? { credentialRef: msg.credentialRef } : {}),
            ...(pid !== undefined ? { projectId: pid } : {}),
            ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
          },
        });
        if (r.outcome && (r.outcome.kind === "dispatched" || r.outcome.kind === "steered") && r.outcome.task) {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "task.submitted", task: r.outcome.task });
          break;
        }
        // 面板为显式授权主径,observe/filtered 仅在 policy 显式关闭 panel scope 时可达;
        // 兜底走原直提路径(回执兼容优先,不做零派发静默)。
      }
      const task = tm.submit("user", msg.sessionId, msg.instruction, {
        // 客户端键统一进 user. 命名空间(防与内部保留前缀交叉碰撞):队列项幂等键是
        // queue.<sessionId>.<itemId>,回放据此判「已提交」。若客户端自带 queue.*(或 user.queue.*
        // 与被改写的 queue.* 撞上)会让某排队项被误判已提交而静默丢消息。无条件加 user. 前缀:
        // 客户端域与内部域彻底隔离,同时保留「同 key 重发不重建任务」的幂等语义。
        idempotencyKey: msg.idempotencyKey === undefined ? undefined : `user.${msg.idempotencyKey}`,
        ...(msg.targetNode !== undefined ? { targetNode: msg.targetNode } : {}),
        ...(msg.resourceTags !== undefined ? { resourceTags: msg.resourceTags } : {}),
        ...(msg.credentialRef !== undefined ? { credentialRef: msg.credentialRef } : {}),
        // 项目:显式带 > 会话既有 owner > 激活项目;都无=undefined(workdir 回退 harness 根)。
 // 归属漂移根治:旧逻辑缺省回填 active 项目,用户期间切项目会把老会话的追问
 // 贴到新项目(经验证 session web-1792572143140 前 5 任务 __harness__、第 6 个变 genie)。
        ...(() => {
          const pid = resolveSubmitProjectId(tm, msg.sessionId, msg.projectId, opts);
          return pid === undefined ? {} : { projectId: pid };
        })(),
        ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
      });
      safeSend(ws, { v: PROTOCOL_VERSION, type: "task.submitted", task });
      break;
    }
    case "annotate.submit": {
 // 截图标注:面板标注编辑器 → 落盘 <项目>/.genie/feedback/ → 组装
      // instruction → 复用 task.submit 投递语义(忙碌=入队)。主体在 annotate.ts(依赖注入可单测),
      // 此处只做项目决议+IO 接线;远程项目拒绝(落盘必须落在 agent 文件围栏内的本地路径)。
      const fail = (message: string): void => { safeSend(ws, { v: PROTOCOL_VERSION, type: "annotate.result", ok: false, message }); };
      try {
        if (!opts.projects) { fail("项目注册表未启用,无法落盘标注反馈"); break; }
        const projectId = resolveSubmitProjectId(tm, msg.sessionId, undefined, opts);
        // 两条增强轨(2026-11):小模型整理(生产口径=models.compact ?? auxLlm,走 compact 轨,
        // 不是 realtime 主轨)+ 录音转写(qwen3.8-omni-flash)。都 fail-soft:未配置/失败回落模板任务书。
        const annCfg = (opts.config as {
          annotate?: { refine?: boolean; voiceParse?: { baseUrl?: string; model?: string; apiKeyEnv?: string; timeoutMs?: number } };
        } | undefined)?.annotate;
        const smallLlm = opts.models?.compact ?? opts.auxLlm;
        const refine: AnnotateRefineDeps = {
          enabled: annCfg?.refine !== false,
          ...(smallLlm ? { llm: smallLlm as unknown as AnnotateRefineDeps["llm"] } : {}),
        };
        const vp = annCfg?.voiceParse ?? {};
        const voiceModel = vp.model ?? VOICE_PARSE_MODEL;
        let voice: AnnotateVoiceDeps | undefined;
        if (vp.baseUrl) {
          // 凭证与 coding/audio 轨同源(env 或 .genie/secrets.json);取不到=不注入,提交照常。
          const apiKey = resolveTrackApiKey("audio.asr", vp.apiKeyEnv ?? VOICE_PARSE_API_KEY_ENV, { repoRoot: repoRoot() });
          if (apiKey) {
            try {
              voice = { parser: createVoiceParser({ baseUrl: vp.baseUrl, model: voiceModel, apiKey, ...(vp.timeoutMs ? { timeoutMs: vp.timeoutMs } : {}) }), model: voiceModel };
            } catch { voice = undefined; }
          }
        }
        const outcome = await processAnnotateSubmit(
          {
            projects: opts.projects, tm, journal, queueApi: (opts as { queueApi?: QueueApi }).queueApi,
            // 聊天侧可见性:预览复制进 /uploads 白名单根(.genie/uploads/<sid>/),作为附件随任务/队列
            // 投递——用户在聊天流直接看到标了什么(媒体卡走 /uploads?path= 读盘,feedback 目录不在白名单)。
            prepareAttachments: (info) => {
              if (!info.previewPath) return undefined;
              const bytes = fsSync.readFileSync(info.previewPath);
              const dir = join(repoRoot(), ".genie", "uploads", info.sessionId);
              fsSync.mkdirSync(dir, { recursive: true });
              const base = info.previewPath.split(/[\\/]/).pop() || "annotated.jpg";
              const attPath = join(dir, "annotate-" + base);
              fsSync.writeFileSync(attPath, bytes);
              return [{ name: base, path: attPath, mime: "image/jpeg", size: bytes.length }];
            },
            refine,
            ...(voice ? { voice } : {}),
          },
          {
            sessionId: msg.sessionId, dataUrl: msg.dataUrl, notes: msg.notes as AnnotateNoteInput[], projectId,
            ...(msg.previewDataUrl !== undefined ? { previewDataUrl: msg.previewDataUrl } : {}),
            ...(msg.audioUrl !== undefined ? { audioUrl: msg.audioUrl } : {}),
            ...(msg.capture !== undefined ? { capture: msg.capture } : {}),
            ...(msg.pageContext !== undefined ? { pageContext: msg.pageContext } : {}),
          },
          { mkdirSync: fsSync.mkdirSync, existsSync: fsSync.existsSync, writeFileSync: fsSync.writeFileSync },
        );
        safeSend(ws, { v: PROTOCOL_VERSION, type: "annotate.result", ...outcome });
      } catch (err) {
        fail(err instanceof Error ? err.message : "截图标注提交失败");
      }
      break;
    }
    case "voice.draft": {
 // 聊天窗语音任务书:录音 dataURL → coding.models.voice 角色模型(qwen3.8-omni-flash
      // 形态的 OpenAI 兼容端点)→ 任务书文本回填聊天输入区。未配置角色模型=功能不可用(明确指路,
      // 不静默降级);每次请求现读 live config(cfg.set 热切即生效,无需重启)。
      // 端点解析对齐 factory.roleFrom:merge 主轨缺省 → resolveCodingModelRoute(模型归属自愈,
      // 「只配 model」也能解析到拥有该模型的 Provider),再按轨取凭证。
      const fail = (message: string): void => { safeSend(ws, { v: PROTOCOL_VERSION, type: "voice.draft.result", sessionId: msg.sessionId, ok: false, message }); };
      const vConfig = opts.config as import("@lampgenie/core").Config | undefined;
      const vCfg = vConfig?.coding?.models?.voice;
      if (!vConfig || !vCfg?.model) {
        fail("未配置语音任务书模型:请在「模型设置 → 各角色模型 → 语音任务书模型」里选择一个支持音频输入的模型(如 qwen3.8-omni-flash)");
        break;
      }
      // 服务端兜底(面板只过滤下拉,配置文件可被手工写成非 omni):受理处校验模型名含 omni
      // (大小写不敏感),不含=拒绝并指路,绝不把非多模态模型发上去换一个必然失败的上游 400。
      if (!/omni/i.test(String(vCfg.model))) {
        fail(`语音任务书要求 omni 多模态模型(当前配置「${vCfg.model}」不含 omni):请在「模型设置 → 各角色模型 → 语音任务书模型」里更换`);
        break;
      }
      try {
        const vRoute = resolveCodingModelRoute(vConfig, { ...vConfig.coding.llm, ...vCfg, model: vCfg.model });
        if (!vRoute.baseUrl) { fail("语音任务书端点未解析:模型「" + vCfg.model + "」不在任何 Provider 目录且未显式配置 baseUrl"); break; }
        if (vRoute.apiType && vRoute.apiType !== "chat") { fail(`语音任务书要求 OpenAI 兼容(chat)端点,当前 Provider 协议=${vRoute.apiType}`); break; }
        const apiKey = resolveTrackApiKey("coding", vRoute.apiKeyEnv, { repoRoot: repoRoot() });
        if (!apiKey) { fail(`语音任务书凭证不可解析(env ${vRoute.apiKeyEnv || "(轨默认)"} 或 .genie/secrets.json)`); break; }
        const audio = parseAudioDataUrl(msg.audioUrl);
        const drafter = createVoiceDrafter({
          baseUrl: vRoute.baseUrl, model: vRoute.model, apiKey,
          ...(vCfg.timeoutMs ? { timeoutMs: vCfg.timeoutMs } : {}),
          ...(opts.voiceDraftFetch ? { fetchImpl: opts.voiceDraftFetch } : {}),
        });
        // 项目语境:会话 owner 项目显示名(结合项目实际情况;草稿态/解析不出=不带,不硬造)。
        const projectId = msg.sessionId
          ? resolveSubmitProjectId(tm, msg.sessionId, undefined, opts)
          : (opts.projects ? opts.projects.activeId() : undefined);
        const projectName = projectId && opts.projects
          ? opts.projects.list().find((p) => p.id === projectId)?.label
          : undefined;
        const text = await drafter(audio, {
          ...(projectName ? { projectName } : {}),
          ...(msg.draftText ? { draftText: msg.draftText } : {}),
        });
        journal.append({ kind: "custom", sessionId: msg.sessionId || "(draft)", payload: { type: "voice.draft", model: vRoute.model, format: audio.format, bytes: audio.bytes.length, ...(projectName ? { project: projectName } : {}), ok: true } });
        safeSend(ws, { v: PROTOCOL_VERSION, type: "voice.draft.result", sessionId: msg.sessionId, ok: true, text });
      } catch (err) {
        try { journal.append({ kind: "custom", sessionId: msg.sessionId || "(draft)", payload: { type: "voice.draft", ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 200) } }); } catch { /* 审计失败不影响回执 */ }
        fail(err instanceof Error ? err.message : "语音任务书撰写失败");
      }
      break;
    }
    case "task.rename": {
      const t = tm.rename(msg.taskId, msg.title);
      if (!t) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.UnknownTask, message: `任务不存在 ${msg.taskId}` }); break; }
 // rename 落一条无幂等键快照(app.ts onChange 落账的幂等键=task.<id>.<state>,
      // 同状态 rename 二连发会被 journal 去重跳过,title/titleCustom 重启即丢;恢复回放按 id 取最后态)。
      // 广播不重复:tm.rename 内 emit 已走 per-connection task.changed 通道。
      journal.append({ kind: "task.progress", sessionId: t.sessionId, payload: t });
      break;
    }
    case "task.pin": {
      const t = tm.setPinned(msg.taskId, msg.pinned);
      if (!t) safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.UnknownTask, message: `任务不存在 ${msg.taskId}` });
      break;
    }
    case "task.archive": {
      const t = tm.setArchived(msg.taskId, msg.archived);
      if (!t) safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.UnknownTask, message: `任务不存在 ${msg.taskId}` });
      break;
    }
    case "task.delete": {
 // 「这些删不掉」根治:删除必须落 journal(task.deleted 墓碑事件),否则网关重启时
 // 回放 task.* 快照会把删掉的任务原样复活(journal 里历史注意 0 条删除事件,235 条任务全回来)。
      const gone = tm.delete(msg.taskId);
      if (gone) {
 // 该会话已无任务时清活动索引(侧栏行为 0 行;同 sid 复用时不得继承旧活动时间顶置)。
        if (!tm.list({ sessionId: gone.sessionId }).length) (opts as { forgetSessionActivity?: (sid: string) => void }).forgetSessionActivity?.(gone.sessionId);
        journal.append({ kind: "task.deleted", sessionId: gone.sessionId, payload: { taskIds: [gone.id], sessionId: gone.sessionId, by: "panel" } });
        opts.broadcast?.({ v: PROTOCOL_VERSION, type: "task.list", tasks: taskIndexList(tm.list()) });
      } else safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.UnknownTask, message: `任务不存在 ${msg.taskId}` });
      break;
    }
    case "task.deleteSession": {
 // 侧栏一行=一个会话(聚合):删单条撑不住整行,必须删该会话全部任务。
      const gone = tm.deleteSession(msg.sessionId);
      if (!gone.length) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.UnknownTask, message: `会话无任务 ${msg.sessionId}` }); break; }
      // m5:会话被删除 → 该会话的主模型覆盖一并清掉(否则覆盖表变垃圾、新会话复用同 sid 时串模型)
      try { opts.sessionModels?.clear(msg.sessionId); } catch (err) { console.warn("[session-model] 会话删除清覆盖失败:", String(err).slice(0, 160)); }
 // 会话级工具面冻结集一并清(轮 P3):同 sid 被复用时若还留着旧冻结集,
      // 首次装配就会被迫并回上辈子的工具(前缀/成本都按旧会话算,且用户已要求「彻底删除」)。
      try { resetSessionToolFloor(msg.sessionId); } catch { /* 冻结集纯内存,清理失败不影响删除语义 */ }
 // 会话删除 → 活动索引/广播闸一并清(同 sid 复用时不得继承旧活动时间)。
      try { (opts as { forgetSessionActivity?: (sid: string) => void }).forgetSessionActivity?.(msg.sessionId); } catch { /* 清理失败不影响删除语义 */ }
      journal.append({ kind: "task.deleted", sessionId: msg.sessionId, payload: { taskIds: gone.map((t) => t.id), sessionId: msg.sessionId, by: "panel-session" } });
      opts.broadcast?.({ v: PROTOCOL_VERSION, type: "task.list", tasks: taskIndexList(tm.list()) });
      safeSend(ws, { v: PROTOCOL_VERSION, type: "git.ok", op: "task-delete-session", detail: `已删除 ${gone.length} 条任务` });
      break;
    }
    case "archive.clear": {
      const gone = tm.clearArchived();
      // 归档任务可能横跨多个会话(code_review findings):按会话分组各落一条,顶层 sessionId 与
      // payload 归属一致——按 sessionId 读 task.deleted 的消费方(会话历史/看板)不会错记到别的会话。
      const bySess = new Map<string, string[]>();
      for (const t of gone) {
        const list = bySess.get(t.sessionId) ?? [];
        list.push(t.id);
        bySess.set(t.sessionId, list);
      }
      for (const [sid, ids] of bySess) {
        // m5:归档清理同样清掉这些会话的模型覆盖(会话已无任务,覆盖留着只会污染新会话)
        try { opts.sessionModels?.clear(sid); } catch (err) { console.warn("[session-model] 归档清覆盖失败:", String(err).slice(0, 160)); }
 // 归档清理=该会话已无任务,活动索引一并清(否则 hello 快照/排序残留幽灵会话)。
        try { (opts as { forgetSessionActivity?: (sid: string) => void }).forgetSessionActivity?.(sid); } catch { /* 清理失败不影响归档语义 */ }
        journal.append({ kind: "task.deleted", sessionId: sid, payload: { taskIds: ids, sessionId: sid, by: "archive-clear" } });
      }
      opts.broadcast?.({ v: PROTOCOL_VERSION, type: "task.list", tasks: taskIndexList(tm.list()) });
      safeSend(ws, { v: PROTOCOL_VERSION, type: "git.ok", op: "archive-clear", detail: `已清理 ${gone.length} 条归档` });
      break;
    }
    case "task.cancel": {
      const task = tm.get(msg.taskId);
      if (task) tm.setState(task, "cancelled");
      break;
    }
 // interrupted 一键续跑:幂等重提同 session 续跑任务(idempotencyKey=resume:<原id>);
    // 任务不在/不可续跑时如实回错(不静默)。legacy「重启中断」cancelled 也放行(存量迁移期)。
    case "task.resume": {
      const task = tm.get(msg.taskId);
      if (!task) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.UnknownTask, message: "任务不存在(可能已删除)" }); break; }
 // :用户停止过的任务不自动/手动续跑(标记优先于状态机判定:本任务或本会话在任务创建后有停止记录)。
    if (hasUserStoppedSince(opts.journal, { taskId: task.id, sessionId: task.sessionId, since: task.createdAt })) {
      safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: USER_STOPPED_RESUME_CODE, message: USER_STOPPED_RESUME_MESSAGE });
      break;
    }
 //  崩溃尾部修复:与 app.ts 两处同源(先补合成终态,再 submit 续跑)。
      const repairNote = repairTailBeforeResume(opts.journal, task.sessionId);
      const resumed = tm.resumeInterrupted(msg.taskId, (t) =>
        "【续跑】此前任务(" + t.id + ")被网关重启打断。请基于该会话已有进展(session 历史/工作区现状)继续完成原任务书,不要重做已完成部分:" +
        repairNote + "\n" + t.instruction);
      if (!resumed) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: "task-not-resumable", message: "任务当前状态不可续跑(仅 interrupted / 重启中断的 cancelled)" }); break; }
      opts.broadcast?.({ v: PROTOCOL_VERSION, type: "task.list", tasks: taskIndexList(tm.list()) });
      safeSend(ws, { v: PROTOCOL_VERSION, type: "task.resume.ok", taskId: msg.taskId, newTaskId: resumed.id, state: resumed.state });
      break;
    }
    // fixI9: 排队消息「立即发送」=抢占:取消当前任务(走既有 cancel 链路中断 agent loop)
    // + 立即提交该消息(同 session 上下文延续);队列其余保持。
    case "queue.dispatch.now": {
      const queueApi = (opts as { queueApi?: QueueApi }).queueApi;
      if (!queueApi) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "队列未启用" }); break; }
      const r = queueApi.dispatchNow(msg);
      if (!r.ok) safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.QueueItemMissing, message: r.reason });
      break;
    }
    // fixI10: 排队消息删除(编辑=面板回填 composer 后 remove 再重发)。
    case "queue.remove": {
      const queueApi = (opts as { queueApi?: QueueApi }).queueApi;
      if (!queueApi) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "队列未启用" }); break; }
      if (!queueApi.remove(msg)) safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.QueueItemMissing, message: "队列项不存在(可能已发送或删除)" });
      break;
    }
    case "task.list":
      safeSend(ws, { v: PROTOCOL_VERSION, type: "task.list", tasks: taskIndexList(tm.list()) });
      break;
 // 按需详情(索引化配套):列表/变更帧只带 TaskIndex,正文由面板按 id 单条现取。
    // 未知/已删 id 回 task:null(不抛、不回全量列表),面板据此显示「不可用」。
    case "task.detail.get": {
      const t = tm.get(msg.taskId);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "task.detail.result", taskId: msg.taskId, task: t ?? null });
      break;
    }
    case "meeting.import": {
 // 会议导入(二期):纪要→抽取(需主 LLM;无 LLM 显式不做,不假抽取)。
      if (!opts.llm) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "meeting.import 需要 LLM 装配" }); break; }
      try {
        const { importMeeting } = await import("@lampgenie/runtime/meeting/import");
        const { meetingsDir } = await import("./meeting-tools.js");
        const { extraction, draftPath } = await importMeeting(msg.path, meetingsDir(), opts.llm as import("@lampgenie/runtime/agent/loop").LlmProvider);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "meeting.extraction", extraction, draftPath });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.MeetingImportFailed, message: String(err).slice(0, 300) });
      }
      break;
    }
    case "meeting.schedule": {
 // 确认面→批量任务( §3 第四步)。
      const { scheduleMeetingTodos } = await import("./meeting-tools.js");
      const created = scheduleMeetingTodos(tm, msg.todos, msg.sessionId);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "meeting.scheduled", tasks: created });
      opts.broadcast?.({ v: PROTOCOL_VERSION, type: "task.list", tasks: taskIndexList(tm.list()) });
      break;
    }
    case "team.status": {
 // 团队视图:多 org 快照(relay 不可达 org 如实显示 disconnected)。
      const tv = (globalThis as { __teamView?: { snapshot(): { orgs: unknown[] }; projectTeam(b: { remoteUrl: string | null; label: string }): unknown; teamaiDigest(): Record<string, unknown> | null } }).__teamView;
 // 项目绑定团队:git remote ↔ roster projects.repo → 该项目的真成员。
 // 扩全项目:此前只算激活项目=「团队页只有 harness 本体」;现在对全部
      // 可见项目(purpose!==conversation,与面板同口径;普通项目 purpose=undefined)各算一份
      // projectTeams[i],projectTeam 仍=激活项(兼容旧面板)。
      const projectTeams: unknown[] = [];
      let projectTeam: unknown = null;
      if (tv && opts.projects) {
        const gs = await import("./git-service.js");
        for (const entry of opts.projects.list().filter((p: { purpose?: string }) => p.purpose !== "conversation")) {
          const cwd = opts.projects.resolveWorkdir(entry.id);
          const remoteUrl = await gs.gitRemoteUrl(cwd).catch(() => null);
          const candidates = await gs.gitContributors(cwd).catch(() => []);
          const m = tv.projectTeam({ remoteUrl, label: entry.label }) as { bound?: boolean; projectId?: string | null; sources?: unknown };
          // projectId=roster 匹配键(面板显示/invite projects 语义);entryId=注册表 id(仅区分用)。
          const one = { ...m, entryId: entry.id, label: entry.label, remoteUrl, candidates };
          projectTeams.push(one);
          if (entry.id === opts.projects.activeId()) projectTeam = one;
        }
      }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "team.status.result", orgs: tv ? tv.snapshot().orgs : [], projectTeam, projectTeams, teamai: tv?.teamaiDigest() ?? null });
      break;
    }
    case "teamai.pull": {
      // 手动触发 relay 重拉团队仓(roster+teamai 资产一起刷新;30s 轮询的即时机)。
      const tv3 = (globalThis as { __teamView?: { pull(orgUrl?: string): void; snapshot(): { orgs: unknown[] }; teamaiDigest(): Record<string, unknown> | null } }).__teamView;
      if (!tv3) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "团队 relay 未启用" }); break; }
      tv3.pull();
      safeSend(ws, { v: PROTOCOL_VERSION, type: "team.status.result", orgs: tv3.snapshot().orgs, teamai: tv3.teamaiDigest() ?? null });
      break;
    }
    case "teamai.push": {
 // 经验/技能以 teamai 形态推团队仓(relay 写分支 teamai/push/<user>/<ts> + MR)。
      const tv4 = (globalThis as { __teamView?: { teamaiPush(orgUrl: string, payload: { ns: string; name: string; description: string; body: string; contributors?: string[]; kind?: "skill" | "rule" | "doc" }): boolean; snapshot(): { orgs: unknown[] }; onPushResult(l: (r: { ok: boolean; branch?: string; reason?: string }) => void): void; offPushResult(l: (r: { ok: boolean; branch?: string; reason?: string }) => void): void } }).__teamView;
      if (!tv4) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "团队 relay 未启用" }); break; }
      const orgUrl = msg.orgUrl || (tv4.snapshot().orgs[0] as { url?: string } | undefined)?.url || "";
      const sent = tv4.teamaiPush(orgUrl, { ns: msg.ns || "common", name: msg.name, description: msg.description || "", body: msg.body, contributors: msg.contributors, ...(msg.kind ? { kind: msg.kind } : {}) });
      if (!sent) { safeSend(ws, { v: PROTOCOL_VERSION, type: "teamai.push.result", ok: false, reason: "该 org 未就绪(relay 不可达/未认证)" }); break; }
      let done = false;
      const onPush = (r: { ok: boolean; branch?: string; reason?: string }) => {
        if (done) return;
        done = true;
        tv4.offPushResult(onPush);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "teamai.push.result", ok: r.ok, branch: r.branch, reason: r.reason });
      };
      tv4.onPushResult(onPush);
      ws.on("close", () => tv4.offPushResult(onPush));
      setTimeout(() => { if (!done) { done = true; tv4.offPushResult(onPush); safeSend(ws, { v: PROTOCOL_VERSION, type: "teamai.push.result", ok: false, reason: "relay 未回(超时)" }); } }, 15_000);
      break;
    }
    case "teamai.inspect": {
 // §2.6 门面:一次请求拿「团队仓资产清单 + 本地 vs 团队仓 diff + 团队仓体检」。
      // digest 走 __teamView(relay 下发投影),cloneDir 走内嵌 relay 的工作克隆;两者缺一只是降级不是报错。
      const tv5 = (globalThis as { __teamView?: { teamaiDigest(): Record<string, unknown> | null } }).__teamView;
      const digest = tv5?.teamaiDigest() ?? null;
      if (!digest) { safeSend(ws, { v: PROTOCOL_VERSION, type: "teamai.inspect.result", ok: false, reason: "团队资产未就绪(relay 未认证/未拉取)" }); break; }
      let list: { kind: string; name: string; ns?: string }[] = [];
      try {
        // 类型面按桥接面本地声明(包的 "./team/*" 导出无 types 条件,tsc 落到 harness-runtime/dist 的
        // 旧 d.ts;运行面经 --conditions=development 走 src,不受影响)。转 dsit 仅为规避该解析缺口。
        const bridge = (await import("@lampgenie/runtime/team/teamai-bridge")) as unknown as {
          teamaiList(d: TeamaiDigest): { kind: string; name: string; ns?: string }[];
          teamaiStatus(d: TeamaiDigest, cloneDir: string): { added: string[]; removed: string[]; changed: string[] };
          teamaiDoctor(cloneDir: string): { ok: boolean; findings: Record<string, unknown>[] };
        };
        list = bridge.teamaiList(digest as unknown as TeamaiDigest);
        const emb = (globalThis as { __teamRelayEmbedded?: EmbeddedTeamHandle | null }).__teamRelayEmbedded;
        const cloneDir = emb?.relay?.cloneDir;
        // 团队 relay 未内嵌(外部 relay/off):status/doctor 无从算起 → list 照回,原因进 reason。
        if (!cloneDir) { safeSend(ws, { v: PROTOCOL_VERSION, type: "teamai.inspect.result", ok: false, list, reason: "团队 relay 未内嵌" }); break; }
        const status = bridge.teamaiStatus(digest as unknown as TeamaiDigest, cloneDir);
        const doctor = bridge.teamaiDoctor(cloneDir);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "teamai.inspect.result", ok: true, list, status, doctor: { ok: doctor.ok, findings: doctor.findings } });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "teamai.inspect.result", ok: false, list, reason: String(err).slice(0, 300) });
      }
      break;
    }
    case "teamai.contribute": {
 // §2.4:会话经验写 learnings 分支(relay 侧 Git 动作;结果经 contribute.result 异步回)。
      const tv6 = (globalThis as { __teamView?: { teamaiContribute(orgUrl: string, payload: { title: string; body: string; tags?: string[]; project?: string }): boolean; snapshot(): { orgs: unknown[] }; onContributeResult(l: (r: { ok: boolean; branch?: string; path?: string; reason?: string }) => void): void; offContributeResult(l: (r: { ok: boolean; branch?: string; path?: string; reason?: string }) => void): void } }).__teamView;
      if (!tv6) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "团队 relay 未启用" }); break; }
      const orgUrl = msg.orgUrl || (tv6.snapshot().orgs[0] as { url?: string } | undefined)?.url || "";
      const sent = tv6.teamaiContribute(orgUrl, { title: msg.title, body: msg.body, tags: msg.tags, project: msg.project });
      if (!sent) { safeSend(ws, { v: PROTOCOL_VERSION, type: "teamai.contribute.result", ok: false, reason: "该 org 未就绪(relay 不可达/未认证)" }); break; }
      let done = false;
      const onC = (r: { ok: boolean; branch?: string; path?: string; reason?: string }) => {
        if (done) return;
        done = true;
        tv6.offContributeResult(onC);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "teamai.contribute.result", ok: r.ok, branch: r.branch, path: r.path, reason: r.reason });
      };
      tv6.onContributeResult(onC);
      ws.on("close", () => tv6.offContributeResult(onC));
      setTimeout(() => { if (!done) { done = true; tv6.offContributeResult(onC); safeSend(ws, { v: PROTOCOL_VERSION, type: "teamai.contribute.result", ok: false, reason: "relay 未回(超时)" }); } }, 15_000);
      break;
    }
    case "teamai.remove": {
 // §2.3:删团队仓 main 上一份资源(kind=skill|rule|doc);结果经 remove.result 异步回。
      const tv7 = (globalThis as { __teamView?: { teamaiRemove(orgUrl: string, payload: { kind: "skill" | "rule" | "doc"; ns?: string; name: string }): boolean; snapshot(): { orgs: unknown[] }; onRemoveResult(l: (r: { ok: boolean; path?: string; reason?: string }) => void): void; offRemoveResult(l: (r: { ok: boolean; path?: string; reason?: string }) => void): void } }).__teamView;
      if (!tv7) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "团队 relay 未启用" }); break; }
      const orgUrl = msg.orgUrl || (tv7.snapshot().orgs[0] as { url?: string } | undefined)?.url || "";
      const sent = tv7.teamaiRemove(orgUrl, { kind: msg.kind, ns: msg.ns, name: msg.name });
      if (!sent) { safeSend(ws, { v: PROTOCOL_VERSION, type: "teamai.remove.result", ok: false, reason: "该 org 未就绪(relay 不可达/未认证)" }); break; }
      let done = false;
      const onR = (r: { ok: boolean; path?: string; reason?: string }) => {
        if (done) return;
        done = true;
        tv7.offRemoveResult(onR);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "teamai.remove.result", ok: r.ok, path: r.path, reason: r.reason });
      };
      tv7.onRemoveResult(onR);
      ws.on("close", () => tv7.offRemoveResult(onR));
      setTimeout(() => { if (!done) { done = true; tv7.offRemoveResult(onR); safeSend(ws, { v: PROTOCOL_VERSION, type: "teamai.remove.result", ok: false, reason: "relay 未回(超时)" }); } }, 15_000);
      break;
    }
    case "team.invite": {
      const tv2 = (globalThis as { __teamView?: { invite(orgUrl: string, displayName?: string, projects?: string[]): boolean; onInviteIssued(l: (orgUrl: string, code: string, expiresAt: number) => void): void; offInviteIssued(l: (orgUrl: string, code: string, expiresAt: number) => void): void } }).__teamView;
      if (!tv2) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "团队 relay 未启用(RELAY_URL/RELAY_URLS)" }); break; }
      const sent = tv2.invite(msg.orgUrl, msg.displayName, msg.projects);
      if (!sent) { safeSend(ws, { v: PROTOCOL_VERSION, type: "team.invite.result", ok: false, reason: "该 org 未就绪(relay 不可达/未认证)" }); break; }
      let settled = false;
      const onIssued = (orgUrl: string, code: string) => {
        if (orgUrl !== msg.orgUrl || settled) return;
        settled = true;
        tv2.offInviteIssued(onIssued);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "team.invite.result", ok: true, code });
      };
      tv2.onInviteIssued(onIssued);
      // 超时兜底(10s):relay 未回=失败(成功先到则 settled 拦截)。
      setTimeout(() => {
        if (settled) return;
        settled = true;
        tv2.offInviteIssued(onIssued);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "team.invite.result", ok: false, reason: "relay 未回(超时)" });
      }, 10_000);
      break;
    }
    // ---- fixD4:团队 issue 双通道(issue.*)+ P2P 通道(team.p2p.*) ----
    case "issue.list": {
      if (!opts.issueService) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "issue 服务未装配" }); break; }
      const projectId = msg.projectId ?? opts.projects?.activeId() ?? "__harness__";
      // 先 list 后 describe:list 内的 401 降级会换通道,describe 要读到降级后的画像(并发=首帧画错通道)。
      const issues = await opts.issueService.list(projectId);
      const channel = await opts.issueService.describe(projectId);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "issue.list.result", projectId, issues, channel });
      break;
    }
    case "issue.create": {
      if (!opts.issueService) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "issue 服务未装配" }); break; }
      const rec = await opts.issueService.create({ projectId: msg.projectId, title: msg.title, body: msg.body, assignee: msg.assignee });
      opts.broadcast?.({ v: PROTOCOL_VERSION, type: "issue.changed", projectId: msg.projectId, number: rec.number, action: "create" });
      // 指派给自己(且未派发)=面板确认按钮+管家播报提醒(designs:确认后派,不自动跑)。
      if (opts.teamP2p && msg.assignee && msg.assignee === opts.teamP2p.username) {
        opts.broadcast?.({ v: PROTOCOL_VERSION, type: "super.notice", text: `新 issue #${rec.number}「${msg.title.slice(0, 40)}」指派给你,面板确认后派发`, state: "issue" });
      }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "issue.list.result", projectId: msg.projectId, issues: await opts.issueService.list(msg.projectId), channel: await opts.issueService.describe(msg.projectId) });
      break;
    }
    case "issue.update": {
      if (!opts.issueService) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "issue 服务未装配" }); break; }
      const rec = await opts.issueService.update(msg.projectId, msg.number, { status: msg.status, assignee: msg.assignee });
      if (rec) opts.broadcast?.({ v: PROTOCOL_VERSION, type: "issue.changed", projectId: msg.projectId, number: msg.number, action: "update" });
      else safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.IssueMissing, message: `issue 不存在 #${msg.number}` });
      break;
    }
    case "issue.comment": {
      // 评论不依赖团队 P2P 通道:没有 P2P 装配时退化为通用署名(此前要求 teamP2p 在场,
      // 否则直接 not-implemented —— 单人/未配团队的场景下评论功能整个不可用)。
      if (!opts.issueService) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "issue 服务未装配" }); break; }
      const author = opts.teamP2p?.username ?? "genie";
      const ok = await opts.issueService.comment(msg.projectId, msg.number, author, msg.body);
      if (!ok) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.IssueMissing, message: `issue 不存在 #${msg.number}` }); break; }
      opts.broadcast?.({ v: PROTOCOL_VERSION, type: "issue.changed", projectId: msg.projectId, number: msg.number, action: "comment" });
      break;
    }
    case "issue.sync": {
      // 同步到 git:显式用户动作(RepoIssues 落盘文件后推共享;服务自身零 git 写红线不动)。
      if (!opts.projects) { safeSend(ws, { v: PROTOCOL_VERSION, type: "issue.sync.result", ok: false, reason: "项目注册表未装配" }); break; }
      try {
        const gs = await import("./git-service.js");
        const root = opts.projects.resolveWorkdir(msg.projectId);
        const out = await gs.gitCommit(root, "genie: sync .genie/issues (团队 issue 共享)", [".genie/issues"]);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "issue.sync.result", ok: true, detail: out });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "issue.sync.result", ok: false, reason: String(err).slice(0, 200) });
      }
      break;
    }
    case "issue.confirm.dispatch": {
      // 确认后派(fixD4 分发桥):该 issue 所属项目提交任务;taskId 关联回写;不自动跑确认红线由面板按钮承担。
      if (!opts.issueService) { safeSend(ws, { v: PROTOCOL_VERSION, type: "issue.dispatch.result", ok: false, reason: "issue 服务未装配" }); break; }
      const issues = await opts.issueService.list(msg.projectId);
      const issue = issues.find((i) => i.number === msg.number);
      if (!issue) { safeSend(ws, { v: PROTOCOL_VERSION, type: "issue.dispatch.result", ok: false, reason: `issue 不存在 #${msg.number}` }); break; }
      if (issue.taskId) { safeSend(ws, { v: PROTOCOL_VERSION, type: "issue.dispatch.result", ok: false, reason: `已派发过(${issue.taskId.slice(0, 8)})` }); break; }
      const NL = String.fromCharCode(10);
      const instruction = `[团队 issue #${issue.number}] ${issue.title}${NL}${NL}${issue.body || "(无正文)"}${NL}${NL}验收:完成该 issue 描述的目标;结束时给出结果摘要(将自动回写 issue 评论)。`;
      const task = tm.submit("user", `issue-${msg.projectId.slice(0, 8)}-${issue.number}`, instruction, {
        title: `[issue #${issue.number}] ${issue.title.slice(0, 60)}`,
        projectId: msg.projectId,
      });
      opts.issueService.linkTask(task.id, msg.projectId, issue.number);
      await opts.issueService.update(msg.projectId, issue.number, { taskId: task.id, status: "doing" });
      // fixD4 竞态兜底:echo 形执行器 submit() 内同步终态(终态事件先于 linkTask)——
      // 关联登记后即查一次,已终态就地回写。
      const nowTask = tm.get(task.id);
      if (nowTask && (nowTask.state === "done" || nowTask.state === "failed" || nowTask.state === "cancelled")) {
        await opts.issueService.writebackTerminal(nowTask);
      }
      opts.broadcast?.({ v: PROTOCOL_VERSION, type: "issue.changed", projectId: msg.projectId, number: issue.number, action: "dispatch" });
      safeSend(ws, { v: PROTOCOL_VERSION, type: "issue.dispatch.result", ok: true, taskId: task.id });
      break;
    }
    case "team.p2p.status": {
      if (!opts.teamP2p) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "P2P 通道未装配" }); break; }
      await opts.teamP2p!.probeUnknown(); // 首答前探未知成员(签名 ping;离线项不重复探)
      safeSend(ws, { v: PROTOCOL_VERSION, type: "team.p2p.status.result", status: opts.teamP2p!.status() });
      break;
    }
    case "team.p2p.send": {
      if (!opts.teamP2p) { safeSend(ws, { v: PROTOCOL_VERSION, type: "team.p2p.message.result", ok: false, via: "none", reason: "P2P 通道未装配" }); break; }
      const r = await opts.teamP2p.send(msg.to, msg.text);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "team.p2p.message.result", ok: true, via: r.via });
      break;
    }
    case "permission.pending": {
 // 审批中心:挂起 ask 清单(旧者在前)。
      const asks = opts.permissionBroker?.pendingList?.() ?? [];
      safeSend(ws, { v: PROTOCOL_VERSION, type: "permission.pending.result", asks });
      break;
    }
    case "permission.history": {
 // 关卡 Gate 历史面:broker 内存 ring 最近决议(旧在前;重启即失)。
      const items = opts.permissionBroker?.history?.(msg.limit) ?? [];
      safeSend(ws, { v: PROTOCOL_VERSION, type: "permission.history.result", items });
      break;
    }
    case "task.group": {
 // F3 自定义分组:正交元数据,不改状态机。
      const t = tm.setGroup(msg.taskId, msg.group);
      if (!t) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.UnknownTask, message: `任务不存在 ${msg.taskId}` }); break; }
      opts.broadcast?.({ v: PROTOCOL_VERSION, type: "task.list", tasks: taskIndexList(tm.list()) });
      break;
    }
    case "exp.distill": {
 // F5 一键沉淀:会话最近一个任务→经验库(distillFromTask;确定性兜底)。
      try {
        const last = [...tm.list()].reverse().find((t) => t.sessionId === msg.sessionId);
        if (!last) { safeSend(ws, { v: PROTOCOL_VERSION, type: "exp.distill.result", ok: false, detail: "该会话无任务" }); break; }
        const aw = await import("./agent-wiring.js");
        const xp = await import("@lampgenie/experience");
 // /team share 沉淀带项目归属(激活项目 id 入 frontmatter.project)。
        const projectId = msg.projectId ?? opts.projects?.activeId() ?? undefined;
        await xp.distillFromTask(aw.getExperienceStore(), journal, last, undefined, projectId ? { project: projectId } : undefined);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "exp.distill.result", ok: true, detail: `已沉淀任务 ${last.id}` });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "exp.distill.result", ok: false, detail: String(err).slice(0, 160) });
      }
      break;
    }
    case "checkpoint.list": {
 // 多快照浏览:journal checkpoint.create 事件全量(按新→旧)。
      // fixF4: 分片让步(每 4000 条 setImmediate 一拍)防大 journal 同步独占事件循环。
      const snaps = (await scanChunked(journal.readAll(), (batch) => batch
        .filter((e) => e.kind === "checkpoint.create")
        .map((e) => {
          const p = e.payload as { taskId?: string; sha?: string | null };
          return { taskId: String(p.taskId ?? ""), sha: p.sha ?? null, sessionId: e.sessionId, at: e.time ?? Date.now() };
        })))
        .filter((x) => x.sha)
        .sort((a, b) => b.at - a.at);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "checkpoint.list.result", snapshots: snaps });
      break;
    }
    case "checkpoint.restore": {
 // 任意快照恢复(此前只有最近一个)。
      try {
        const svc = await import("./git-service.js");
        const cwd = opts.projects?.resolveWorkdir(opts.projects.activeId()) ?? repoRoot();
        const out = await svc.checkpointRestoreSha(cwd, msg.sha);
        journal.append({ kind: "checkpoint.restore", sessionId: "web", payload: { sha: msg.sha, files: out } });
        safeSend(ws, { v: PROTOCOL_VERSION, type: "checkpoint.restore.result", ok: true, sha: msg.sha });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "checkpoint.restore.result", ok: false, reason: String(err).slice(0, 200) });
      }
      break;
    }
    case "goal.set": {
 // /goal(ZCode target 子系统语义):≤4000 字校验;plan 互斥;状态变更通知入对话流;
      // set/replace 记为外部用户提示(ZCode:objective 本身进消息史)。
      const { readGoal, isValidGoalObjective, goalStateChangeNotice } = await import("@lampgenie/runtime/agent/goal");
      const prev = readGoal(journal, msg.sessionId);
      if (msg.goal !== null) {
        if (!isValidGoalObjective(msg.goal)) {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.GoalInvalid, message: `Usage: /goal <objective>(1-${4000} 字符)` });
          break;
        }
        if (permissionMode() === "plan") {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.GoalPlanMutex, message: "Plan and Goal cannot be active at the same time." });
          break;
        }
      }
      journal.append({
        kind: "goal.set",
        sessionId: msg.sessionId,
        payload: { goal: msg.goal, state: msg.state, at: Date.now() },
      });
      // 状态变更通知(ZCode goal_state_change 逐字;message.system 进 deriveMessages→agent 可见)
      if (msg.goal === null) {
        if (prev) journal.append({ kind: "message.system", sessionId: msg.sessionId, payload: { text: goalStateChangeNotice("cleared") } });
      } else if (msg.state === "paused" && prev?.status === "active") {
        journal.append({ kind: "message.system", sessionId: msg.sessionId, payload: { text: goalStateChangeNotice("paused") } });
      } else if (msg.state === "active" && prev?.status === "paused") {
        journal.append({ kind: "message.system", sessionId: msg.sessionId, payload: { text: goalStateChangeNotice("resumed") } });
      } else if (msg.state === "active") {
        // set/replace:objective 以用户提示身份入流(ZCode session-facade 语义)
        journal.append({ kind: "message.user", sessionId: msg.sessionId, payload: { text: `/goal ${msg.goal}` } });
      }
      safeSend(ws, {
        v: PROTOCOL_VERSION, type: "goal.result",
        goal: msg.goal,
        state: msg.goal === null ? "cleared" : msg.state === "paused" ? "paused" : "active",
      });
      break;
    }
    case "goal.get": {
      const { readGoal } = await import("@lampgenie/runtime/agent/goal");
      const g = readGoal(journal, msg.sessionId);
      // sync=true:状态同步回包(轮询/打开会话),前端只刷 chip 不 toast——动作确认(goal.set)才提示。
      safeSend(ws, {
        v: PROTOCOL_VERSION, type: "goal.result", sync: true,
        goal: g?.objective ?? null,
        state: g ? g.status === "paused" ? "paused" : g.status === "complete" ? "complete" : g.status === "budget_limited" ? "budget_limited" : "active" : "cleared",
      });
      break;
    }
    case "session.compact": {
 // /compact:手动压缩路径(force:低于阈值也压)+可选摘要指示透传。无 LLM=显式不可为。
 // 修「主动 /compact 感觉没运行」③:压缩模型轨与自动路径同源
      // (agent-wiring.ts:2174 `models?.compact ?? auxLlm ?? llm`)——手动命令此前恒走主轨
      // llm,配了 coding.models.compact 的用户点 /compact 实际是在用主模型压(且主轨是 realtime,
      // 端点上还开新会话)。三者皆无才报「LLM 未装配」。
      const compactLlm = opts.models?.compact ?? opts.auxLlm ?? (opts.llm as import("@lampgenie/runtime/agent/loop").LlmProvider | undefined);
      // 状态帧构造(2026-11 边界元数据):四出口(started/failed/skipped/completed)共用,字段缺省省略。
      const compactStatus = (
        phase: "started" | "completed" | "failed" | "skipped",
        extra: { reason?: string; summaryChars?: number; tokensBefore?: number; tokensAfter?: number } = {},
      ): import("@lampgenie/protocol").ServerMessage => ({
        v: PROTOCOL_VERSION, type: "session.compact.status", sessionId: msg.sessionId, phase, trigger: "manual",
        ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
        ...(extra.summaryChars !== undefined ? { summaryChars: extra.summaryChars } : {}),
        ...(extra.tokensBefore !== undefined ? { tokensBefore: extra.tokensBefore } : {}),
        ...(extra.tokensAfter !== undefined ? { tokensAfter: extra.tokensAfter } : {}),
      });
      if (!compactLlm) {
        const reason = "LLM 未装配";
        safeSend(ws, compactStatus("failed", { reason }));
        safeSend(ws, { v: PROTOCOL_VERSION, type: "session.compact.result", compacted: false, reason, trigger: "manual" });
        break;
      }
      // 入口广播:通过了 LLM 装配判定就算「已开始」(数量守卫的 skipped 是它的诚实终局)。
      broadcastCompactStatus(compactStatus("started"), ws, opts);
      // 数量守卫(ZCode hasEnoughMessagesToCompact):≥1 条 assistant,且「≥2 个 user 轮 或 ≥2 个不同
 // assistant turn」。 修④:旧判据按相邻 role 切换计 assistant 段——一轮里连续 30 个
      // message.agent 只算 1 段 → 「一轮做 30 步」这种超长会话被误判「会话太短」拒掉。真轮次看
      // payload.turn(turn 缺失时退回相邻段计数);**单轮多 step(assistant 消息 ≥2 条)也算够长**——
      // 否则「一轮 30 步」仍过不了(它只有 1 个 user、1 个 turn),与本题要修的现象相悖。
      {
        const msgs = journal.readAll().filter((e) => e.sessionId === msg.sessionId && (e.kind === "message.user" || e.kind === "message.agent"));
        let userRounds = 0;
        let segments = 0;
        let assistantMsgs = 0;
        let prevRole = "";
        let hasAssistant = false;
        const turns = new Set<number>();
        for (const e of msgs) {
          const role = e.kind === "message.agent" ? "assistant" : "user";
          if (role === "user") userRounds += 1;
          if (role === "assistant") {
            hasAssistant = true;
            assistantMsgs += 1;
            if (prevRole !== "assistant") segments += 1;
            const turn = (e.payload as { turn?: unknown }).turn;
            if (typeof turn === "number" && Number.isFinite(turn)) turns.add(turn);
          }
          prevRole = role;
        }
        const assistantRounds = turns.size > 0 ? Math.max(turns.size, 1) : segments;
        if (!hasAssistant || (userRounds < 2 && assistantRounds < 2 && assistantMsgs < 2)) {
          const reason = `会话太短(assistant 轮 ${assistantRounds} / user 轮 ${userRounds}),无需压缩`;
          broadcastCompactStatus(compactStatus("skipped", { reason }), ws, opts);
          safeSend(ws, {
            v: PROTOCOL_VERSION, type: "session.compact.result", compacted: false,
            reason, trigger: "manual",
          });
          break;
        }
      }
      try {
        const { autoCompact } = await import("@lampgenie/runtime/agent/auto-compact");
 // 保留条数与自动路径同口径收敛:固定 10 时「消息 8 条但都是巨块」的会话
        // head=0 → autoCompact 诚实拒绝「会话过短」,用户点了手动压缩却什么都没压。
        // 口径=最多保留 10 条,至少留 1 条进 head(与 compact-hook 一致)。
        const compactMsgCount = journal.readAll().filter((e) => e.sessionId === msg.sessionId
          && (e.kind === "message.user" || e.kind === "message.agent" || e.kind === "tool.result" || e.kind === "message.system")).length;
        const keepRecent = Math.max(1, Math.min(10, compactMsgCount - 1));
        // tokensBefore/tokensAfter:autoCompact 的返回值不带 token,从本次调用落下的
        // compact.start(payload.tokens)/compact.done(payload.tokensBefore/tokensAfterMicrocompact)取;
        // 取不到就省略(不编造数字)。
        const seqBefore = journal.length;
        const r = await autoCompact(journal, msg.sessionId, {
          thresholdTokens: 1, // 手动命令:force 语义
          keepRecentMessages: keepRecent,
          compactLlm,
          devlogDir: join(repoRoot(), "devlog"),
          ...(msg.instructions ? { instructions: msg.instructions } : {}),
          force: true,
          trigger: "manual",
        });
        const fresh = journal.readSession(msg.sessionId).filter((e) => e.seq >= seqBefore);
        const startEv = fresh.find((e) => e.kind === "compact.start");
        const doneEv = fresh.find((e) => e.kind === "compact.done");
        const startP = (startEv?.payload ?? {}) as { tokens?: unknown; trigger?: unknown };
        const doneP = (doneEv?.payload ?? {}) as { tokensBefore?: unknown; tokensAfterMicrocompact?: unknown; summary?: unknown };
        const tokensBefore = typeof doneP.tokensBefore === "number" ? doneP.tokensBefore
          : typeof startP.tokens === "number" ? startP.tokens : undefined;
        const tokensAfter = typeof doneP.tokensAfterMicrocompact === "number" ? doneP.tokensAfterMicrocompact : undefined;
        if (r.compacted) {
          const summaryChars = (r.summary ?? "").length;
          broadcastCompactStatus(compactStatus("completed", {
            summaryChars,
            ...(tokensBefore !== undefined ? { tokensBefore } : {}),
            ...(tokensAfter !== undefined ? { tokensAfter } : {}),
          }), ws, opts);
          // 看板刷新桥:压缩完成后主动推一帧 trace.stats(通道未注入=跳过,面板 2s 轮询兜底)。
          void (opts as { broadcastTraceStats?: (sid: string) => Promise<void> }).broadcastTraceStats?.(msg.sessionId);
        } else {
          broadcastCompactStatus(compactStatus("failed", { reason: r.reason ?? "未压缩" }), ws, opts);
        }
        safeSend(ws, {
          v: PROTOCOL_VERSION, type: "session.compact.result",
          compacted: r.compacted,
          trigger: "manual",
          ...(tokensBefore !== undefined ? { tokensBefore } : {}),
          ...(tokensAfter !== undefined ? { tokensAfter } : {}),
 // reason 真透传返回值(旧文案「低于阈值且未强制」在 force:true 下永不成立=谎报)
          ...(r.compacted ? { summaryChars: (r.summary ?? "").length } : { reason: r.reason ?? "未压缩" }),
        });
      } catch (err) {
        const reason = String(err).slice(0, 160);
        broadcastCompactStatus(compactStatus("failed", { reason }), ws, opts);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "session.compact.result", compacted: false, reason, trigger: "manual" });
      }
      break;
    }
    case "plan.approve": {
 // Plan 审批应答(ZCode turn-control/plan-mode 语义):
      // approve→切回 ask + 派实施任务(模型内容=「用户已批准你的计划…## 已批准的计划」逐字,与服务端注入配对);
      // feedback→steered 用户消息(计划未批准+反馈),保持 plan 模式。
      const file = join(repoRoot(), ".genie", "plans", `plan-${msg.sessionId}.md`);
      let plan = "";
      try { plan = (await import("node:fs")).readFileSync(file, "utf-8"); } catch { /* 无计划文件照走(诚实) */ }
      if (msg.decision === "approve") {
        const { setPermissionMode } = await import("./permission-mode.js");
        setPermissionMode("ask");
        journal.append({ kind: "message.system", sessionId: msg.sessionId, payload: { text: "## 已退出计划模式\n\n你已退出计划模式,现在可以编辑文件、执行工具与采取行动。" } });
        const content = plan
          ? `用户已批准你的计划。现在可以开始实施;如有待办先更新 todo 列表。\n\n## 已批准的计划:\n${plan}`
          : "用户已批准退出计划模式。现在可以继续。";
        tm.submit("user", msg.sessionId, content, {
          // RC-096 C2:透传原计划任务的 projectId(缺省 active 项目),防 workdir 回退 harness 根。
 // 归属漂移根治:原任务 > 会话 owner > active(审批任务回落老会话不该被切项目改写)。
          title: "[plan 批准] 按计划实施",
          projectId: resolveSubmitProjectId(tm, msg.sessionId, tm.get(msg.taskId)?.projectId, opts),
        });
        opts.broadcast?.({ v: PROTOCOL_VERSION, type: "task.list", tasks: taskIndexList(tm.list()) });
      } else {
        const fb = String(msg.feedback ?? "").trim();
        journal.append({ kind: "message.user", sessionId: msg.sessionId, payload: { text: `[计划反馈] ${fb}` } });
        journal.append({ kind: "message.system", sessionId: msg.sessionId, payload: { text: "计划未获用户批准。按反馈修订计划;保持计划模式。" } });
      }
      break;
    }
    case "task_output": {
 // 后台子代理进度/结果查询(ZCode TaskOutput 语义):读注册表+output.txt。
      const reg = (globalThis as { __bgAgents?: Map<string, { outputFile: string; status: string; sessionId: string }> }).__bgAgents;
      const entry = reg?.get(msg.agentId);
      if (!entry) { safeSend(ws, { v: PROTOCOL_VERSION, type: "task.output.result", agentId: msg.agentId, status: "unknown" }); break; }
      try {
        const out = (await import("node:fs")).readFileSync(entry.outputFile, "utf-8");
        safeSend(ws, { v: PROTOCOL_VERSION, type: "task.output.result", agentId: msg.agentId, status: entry.status, outputFile: entry.outputFile, output: out.slice(0, 8000) });
      } catch {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "task.output.result", agentId: msg.agentId, status: entry.status });
      }
      break;
    }
    case "session.export": {
 // 会话导出(二期):journal → dsh session-format v4。
      try {
        const { exportSessionToFile, verifySessionFile } = await import("./session-export.js");
        const outDir = process.env.GENIE_EXPORT_DIR ?? join(repoRoot(), ".genie", "exports");
        const file = exportSessionToFile(journal, msg.sessionId, outDir, repoRoot());
        const { events } = verifySessionFile(file);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "session.export.result", sessionId: msg.sessionId, file, events });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.SessionExportFailed, message: String(err).slice(0, 300) });
      }
      break;
    }
    case "trace.stats": {
 // 追踪统计:llmMs/toolMs/token 从 loop 增强事件派生(旧数据如实为 0)。
      // 2026-11 边界元数据轮:主体抽成模块级 computeTraceStats(看板刷新桥 broadcastTraceStats 复用同一帧口径)。
      safeSend(ws, await computeTraceStats(msg.sessionId, opts));
      break;
    }
    case "trace.query": {
      // 轨迹查询(txa6/txa7/txa8):journal 过滤 + 投影裁剪 + 聚合,纯函数在 runtime 侧(queryTrace)。
      // 分工照 trace.stats:本层只做「读 journal + 分片让步 + 回包」,判定/裁剪/聚合全在 runtime。
      try {
        const { queryTrace } = await import("@lampgenie/runtime/agent/trace-query");
 // 深度优化(同 trace.stats):readAll.filter(sid) 全库扫(经验证 12.2ms)
 // → readSession(sid) 索引切片(经验证 2.62ms,4.7×)。这里不做结果 memo:
        // 查询结果含最多 500 条事件投影(~0.5MB/条请求),缓存它的内存代价高于重算,且带 filter 的
        // 键空间会膨胀;索引读已把大头拿掉。
        const events = await scanChunked(
          journal.readSession(msg.sessionId),
          (batch) => batch.map((e) => ({
            seq: e.seq, kind: e.kind, time: e.time, sessionId: e.sessionId,
            ...(e.idempotencyKey !== undefined ? { idempotencyKey: e.idempotencyKey } : {}),
            payload: e.payload,
          })),
        );
        // 会话不存在/无事件 = 空数组 → 零值 summary(不抛、不断连接)。
        const { events: outEvents, summary } = queryTrace(events, msg.filter ?? {});
        safeSend(ws, {
          v: PROTOCOL_VERSION, type: "trace.query.result",
          sessionId: msg.sessionId, events: outEvents, summary,
        });
      } catch (err) {
        // 失败面:统计/查询类共用 stats-failed(与 trace.stats 上游同族,面板按 trace 前缀兜底)。
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.StatsFailed, message: String(err).slice(0, 300) });
      }
      break;
    }
    case "profile.file": {
 // 档案文件钻取:根=项目解析(缺省 harness);无 file=文件清单,有 file=函数+调用边。
      const root = opts.projects?.resolveWorkdir(msg.projectId) ?? repoRoot();
      try {
        if (!msg.file) {
          const { scanProject } = await import("@lampgenie/code-sense/project");
          const scan = await scanProject(root);
          safeSend(ws, { v: PROTOCOL_VERSION, type: "profile.file.result", mode: "files", files: scan.files });
        } else {
          const { fileSymbolsOf } = await import("@lampgenie/code-sense");
          // 六期修复:allowStale=索引略旧也降级直读(毫秒),重建走 sense-index-manager 的 fork;
 // 旧路径索引过期时在主进程内 ts-morph 全仓重建,把事件循环卡成分钟级无响应(经验证)。
          const { ensureIndex } = await import("./sense-index-manager.js");
          const r = await fileSymbolsOf(root, msg.file, {
            allowStale: true,
            onStale: (rt) => { void ensureIndex(rt).catch(() => {}); },
          });
 // code2flow 分类(三改):快路径时从静态索引带 trunk/leaf/regular+出入度(面板着色);
          // 慢路径(索引未就绪)kind 留空=面板按 regular 渲染,不阻塞
          let kinds: Record<string, { kind: string; inCount: number; outCount: number }> = {};
          try {
            const c2f = await import("@lampgenie/code-sense/callgraph/c2f");
            const idx = c2f.loadIndex(root);
            if (idx) {
              for (const sym of r.symbols) {
                const n = idx.nodes.find((x) => x.id === sym.id);
                if (n) kinds[sym.id] = { kind: n.kind, inCount: n.inCount, outCount: n.outCount };
              }
            }
          } catch { /* 分类缺席=regular 渲染 */ }
          // 八期定位:代码档案=项目静态基座知识,工作流画布式组织化呈现——附 fileToModules 模块分类
          // (kind=16 类工作流类型;跨文件目标单列),档案视图据此画模块画布;白板=任务态草图不掺静态呈现。
          let modules: unknown = undefined;
          try {
            const { loadIndex: li, fileToModules } = await import("@lampgenie/code-sense");
            const idx2 = li(root);
            if (idx2) {
              const mf = msg.file ?? "";
              const rel = mf !== "" && idx2.byFile[mf] !== undefined
                ? mf
                : Object.keys(idx2.byFile).find((f) => mf !== "" && (f === mf || f.endsWith("/" + mf) || f.endsWith(mf)));
              if (rel) modules = fileToModules(idx2, rel);
            }
          } catch { /* 模块分类缺席=档案退回函数列表+mermaid */ }
          safeSend(ws, { v: PROTOCOL_VERSION, type: "profile.file.result", mode: "symbols", file: msg.file, symbols: r.symbols, edges: r.edges, kinds, ...(modules ? { modules } : {}) });
        }
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.ProfileFileFailed, message: String(err).slice(0, 200) });
      }
      break;
    }
    case "companion.turn": // @deprecated 入站仍受理(老客户端),新前端只发 super.turn
    case "super.turn": {
      const sa = opts.superAgent;
      if (!sa) {
 // 未装配(LLM=off)也回 SuperFailed——指挥台两个前端(widget/指挥台 view)按
        // super-failed 清等待气泡并显式报错;原 NotImplemented 会被前端过滤掉,「思考中…」永不消失。
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.SuperFailed, message: "super agent 需要 LLM 装配(llm=off 时不假做)" });
        break;
      }
      try {
        sa.onActivity?.(); // 指挥台聊天窗活跃标记(ask_user 转接/任务播报的触发判据)
        // 用户轮次先广播给全部客户端(turn.user),再回 done(出站只发 super.*)。
        opts.broadcast?.({ v: PROTOCOL_VERSION, type: "super.turn.user", text: msg.text });
        const text = await sa.turn(msg.text);
 // done 改广播(原单发发起 socket——第二个标签页/指挥台 view 只见 user 气泡
 // 却永远等不到回复,经验证断链;error 帧仍只发发起端,避免其它端弹无关错误)。
        opts.broadcast?.({ v: PROTOCOL_VERSION, type: "super.turn.done", text, sessionId: superSessionId() });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.SuperFailed, message: String(err).slice(0, 200) });
      }
      break;
    }
    case "companion.history": // @deprecated 入站仍受理,回包统一 super.history.result
    case "super.history": {
      const sa = opts.superAgent;
      if (!sa) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "super agent 需要 LLM 装配" });
        break;
      }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "super.history.result", events: sa.history(msg.sinceSeq) } as never);
      break;
    }
    case "super.inbox": {
      // 指挥台待处理清单(ask/permission/interrupted/blocked/failed 聚合);未注入=空数组。
      const items = opts.superAgent?.inbox?.(msg.limit) ?? [];
      safeSend(ws, { v: PROTOCOL_VERSION, type: "super.inbox.result", items, ts: Date.now() } as never);
      break;
    }
    case "session.status": {
 // 会话进度投影:F1 归约器统一派到(此前内联扫描)——todo/subagent/workflow/压缩标记单点归约。
 // fixF1(面板卡+重连风暴):per-session 索引切片替代 readAll 全量。status 是三路高频
 // 触发(session.status.changed 推送回拉+面板 3s 轮询+流式 stPull),旧路径每次 readAll(生产环境
      // 30MB/28k 行)+两遍全量 map,多子代理并发时事件循环被同步全扫占死→ws 心跳排队超时→面板
      // 「重连中」恶性循环。workflow.ask 关联只涉及该会话 run 过的 wfId 会话(ask 落在 sessionId=wfId
      // 的流):按需切片喂投影第二参——过滤口径不变(其他会话本来就不可能命中这些 wfId)。
 // 投影 memo(晚间事故:巨型审计会话 5k 事件×面板 3s 轮询×1747 次,每次全量重投影
      // +重读 wf 会话,gateway 消息处理被饿到 median 19s/最大 355s——ready 假超时/心跳假冻结/终态
      // uplink 丢失三个误判的源头)。水位失效:会话事件数(append-only 只增)与 wfId 集 unchanged
      // =直接复用上次投影;容量 64 会话,超限淘汰最旧。
      const statusT0 = Date.now();
      const { projectSession, mergeProjection, emptyProjectionCarry } = await import("@lampgenie/runtime/session/projection");
      const state = sessionStatusMemo.get(msg.sessionId);
      const sinceSeq = msg.sinceSeq;
      let projection: ReturnType<typeof projectSession>;
      // 本请求实际归约的新事件数(慢日志用:增量路径=新事件数,不再是会话总事件数)。
      let freshCount = 0;
 // 增量化(治 网关 OOM:11k 事件会话 × 3s 全量回拉 → 每次 1.4~9.2s/MB 级载荷):
      // 客户端带 sinceSeq(= 上次回包 status.seq)且与累积态水位相等时,只归约 seq>sinceSeq 的新事件并合并进累积态。
      // 不带 sinceSeq(老客户端/首拉)=现场全量投影,语义与改造前逐字一致。
      if (sinceSeq !== undefined && state && state.watermark === sinceSeq) {
        // sinceSeq+1:journal.readSession 的比较是 e.seq >= sinceSeq,不 +1 会把水位那条重复归约
        // (spawnCount/resultCount 翻倍、rowCount 多 1)——有负面用例锁。
        const deltaEvents = journal.readSession(msg.sessionId, sinceSeq + 1);
        freshCount = deltaEvents.length;
        if (deltaEvents.length === 0) {
          // 空增量:memo 命中路径——不调用 projectSession,直接用累积态(只做 task/subagentList/apiRetry 组装)。
          projection = state.projection;
        } else {
          // workflows[].asks 是唯一跨会话依赖(ask 落在 sessionId=wfId 的流里,主会话增量批看不到):
          // 新出现的 wfId 首次全量读一次它的 ask 计数,之后只读 seq>上次 ask 水位的增量累加。
          // 绝不允许每请求全量重读 wf 会话——那就是原 bug 本身。
          // 权威量在 wfAsks(每 wf 累计 count + 已读水位 seq),合并后按它回填 asks。
          const wfAsks = state.wfAsks;
          const seenInBatch = new Set<string>();
          for (const e of deltaEvents) {
            if (e.kind !== "workflow.run.start" && e.kind !== "workflow.run.done") continue;
            const id = String((e.payload as { wfId?: unknown }).wfId ?? "");
            if (!id || seenInBatch.has(id)) continue;
            seenInBatch.add(id);
            const cur = wfAsks.get(id);
            if (!cur) {
              // 首次见到该 wf:全量读一次它的 ask 流(仅此一次;此后走 seq 增量)。
              let count = 0;
              let maxSeq = 0;
              for (const a of journal.readSession(id)) {
                if (a.seq > maxSeq) maxSeq = a.seq;
                if (a.kind === "workflow.ask") count++;
              }
              wfAsks.set(id, { count, seq: maxSeq });
            } else {
              // 已见 wf:只读 seq>水位 的 ask 增量(全量 filter 的增量等价,成本 O(新增))。
              let added = 0;
              let maxSeq = cur.seq;
              for (const a of journal.readSession(id, cur.seq + 1)) {
                if (a.seq > maxSeq) maxSeq = a.seq;
                if (a.kind === "workflow.ask") added++;
              }
              if (added > 0 || maxSeq !== cur.seq) wfAsks.set(id, { count: cur.count + added, seq: maxSeq });
            }
          }
          // facts 是 in-out 事实袋:带入上一批未成对的 compact.start(跨批 at/tokens 不丢),
          // 出来时是本批残留 + todoSeen(本批是否见过 todo.updated)。
          const facts: { todoSeen: boolean; compactStart: { at: number; tokens?: number } | null } = {
            todoSeen: false,
            compactStart: state.carry.compactStart,
          };
          const delta = projectSession(deltaEvents as never, [], facts);
          const merged = mergeProjection(state.projection, delta, { facts, outCarry: state.carry });
          // asks 回填:唯一权威=wfAsks 累计计数(mergeProjection 不从 delta 推导 asks)。
          for (const w of merged.workflows) {
            const cur = wfAsks.get(w.wfId);
            if (cur) w.asks = cur.count;
          }
          state.projection = merged;
          state.watermark = deltaEvents[deltaEvents.length - 1]!.seq;
          state.wfKey = [...state.carry.wfSeen].sort().join(",");
          projection = merged;
        }
      } else {
        // 全量路径(老客户端/首拉/水位对不上):读全部会话事件 + wf 会话全量 filter,投影后写入累积态基线。
        const sessionEvents = journal.readSession(msg.sessionId);
        freshCount = sessionEvents.length;
        const wfIds = new Set<string>();
        for (const e of sessionEvents) {
          if (e.kind === "workflow.run.start" || e.kind === "workflow.run.done") {
            const id = String((e.payload as { wfId?: unknown }).wfId ?? "");
            if (id) wfIds.add(id);
          }
        }
        const wfKey = [...wfIds].sort().join(",");
        if (state && state.watermark === maxSeqOf(sessionEvents) && state.wfKey === wfKey) {
          // memo 命中(改造前的双 unchanged 判据):投影与 wf 集都没变 → 不重投影,直接用累积态。
          projection = state.projection;
          freshCount = 0;
        } else {
        const related: { kind: string; payload: unknown; sessionId: string }[] = [];
        const wfAsks = new Map<string, { count: number; seq: number }>();
        for (const id of wfIds) {
          let count = 0;
          let maxSeq = 0;
          for (const e of journal.readSession(id)) {
            if (e.seq > maxSeq) maxSeq = e.seq;
            if (e.kind === "workflow.ask") {
              related.push({ kind: e.kind, payload: e.payload, sessionId: e.sessionId });
              count++;
            }
          }
          wfAsks.set(id, { count, seq: maxSeq });
        }
 // 去掉逐事件 map 拷贝(巨型会话每次 miss 分配 36K 包装对象,纯 GC 压力;
        // 结构化类型允许直传——多余字段(seq/time/sessionId)对投影透明)。
        const facts: { todoSeen: boolean; compactStart: { at: number; tokens?: number } | null } = { todoSeen: false, compactStart: null };
        const full = projectSession(sessionEvents as never, related, facts);
        projection = full;
        if (sessionStatusMemo.size > 64 && !sessionStatusMemo.has(msg.sessionId)) {
          const oldest = sessionStatusMemo.keys().next().value;
          if (oldest !== undefined) sessionStatusMemo.delete(oldest);
        }
        sessionStatusMemo.set(msg.sessionId, {
          watermark: maxSeqOf(sessionEvents),
          wfKey,
          projection: full,
          carry: (() => {
 // 统一走 emptyProjectionCarry(字段扩展时不必逐处改字面量)。
            const c = emptyProjectionCarry();
            c.compactStart = facts.compactStart;
            c.wfSeen = new Set(wfIds);
            return c;
          })(),
          wfAsks,
        });
        }
      }
      const task = opts.taskManager.list().filter((t) => t.sessionId === msg.sessionId).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
 // 子代理实时清单(B 面板过程卡数据源):后台注册表按会话过滤+output.txt 尾部。
      // 注册表缺席(重启后/旧进程)=不带该字段,面板按 journal 事件渲染(降级=与旧版一致)。
 // deadline/heartbeatAt/stale/stopReason(目录深化,并行线在注册表加的字段):
      // 防御式透传——有则带、无则缺省(协议 optional),并行线上线前后面板都不炸。
      type SubagentListEntry = {
        agentId: string; status: string; outputFile: string;
        tail?: string; title?: string; model?: string;
        deadline?: number; heartbeatAt?: number; stale?: boolean; stopReason?: string;
      };
      let subagentList: SubagentListEntry[] | undefined;
      try {
        const reg = (globalThis as { __bgAgents?: Map<string, { outputFile: string; status: string; sessionId: string; title?: string; model?: string }> }).__bgAgents;
        if (reg && reg.size > 0) {
          for (const [agentId, entry] of reg) {
            if (entry.sessionId !== msg.sessionId) continue;
 // 卡顿修复:尾部读改异步+TTL 缓存。旧=statSync+readSync 逐子代理同步读 9p,
 // 3s 轮询 × N 子代理持续阻塞事件循环(三会话并发经验证 session.status 慢 52-147ms 连绵);
            // 现异步读不阻塞循环,1.5s TTL 兜多卡/多会话同文件重复读。末 1500 字符口径不变。
            const tail = await readTailCharsCached(entry.outputFile, 1500);
            const x = entry as typeof entry & { deadline?: unknown; heartbeatAt?: unknown; stale?: unknown; stopReason?: unknown };
            (subagentList ??= []).push({
              agentId, status: entry.status, outputFile: entry.outputFile,
              ...(tail !== undefined ? { tail } : {}),
              ...(entry.title ? { title: entry.title } : {}),
              ...(entry.model ? { model: entry.model } : {}),
              ...(typeof x.deadline === "number" ? { deadline: x.deadline } : {}),
              ...(typeof x.heartbeatAt === "number" ? { heartbeatAt: x.heartbeatAt } : {}),
              ...(typeof x.stale === "boolean" ? { stale: x.stale } : {}),
              ...(typeof x.stopReason === "string" && x.stopReason ? { stopReason: x.stopReason } : {}),
            });
          }
        }
      } catch { /* 注册表读取失败=诚实降级不带清单 */ }
      // 重试态镜像读取(batch1b):在回包前现读,保证「切回会话看到的是最新态」而非请求发起时的旧态。
      const rs = retrySnapshot(msg.sessionId);
      safeSend(ws, {
        v: PROTOCOL_VERSION, type: "session.status.result",
 // 回显 sessionId —— 面板按它登记水位表;不回显则水位全落 undefined 键,
 // 后续请求永远发不出 sinceSeq(增量路径形同虚设;浏览器经验证抓到,勿删)。
        sessionId: msg.sessionId,
        status: {
 // 水位=该会话当前最大 seq(空会话=0),面板下次带 sinceSeq 走增量。
          // 现读 memo 而非顶层 state 变量:本请求可能是首拉(上面刚写入基线,state 取时为 undefined)。
          seq: sessionStatusMemo.get(msg.sessionId)?.watermark ?? 0,
 // 2026-11 任务索引化(与 hello/task.list 同口径)——instruction/result 全文不进
          // 状态帧(那正是 9.2s/MB 级载荷的放大器),正文由面板按 id 走 task.detail.get。
          task: task ? taskIndexOf(task) : null,
          todo: projection.todo,
          subagents: projection.subagents,
          workflows: projection.workflows,
          compactions: projection.compactions,
          ...(subagentList ? { subagentList } : {}),
          // 重试态跨会话保活(batch1b):从 gateway 内存镜像回填——切走会话再回来(或在别的标签页
          // 打开同一会话)仍能看到「重新连接中」;无重试态=不带该字段(前端按缺省处理)。
          ...(rs ? { apiRetry: rs } : {}),
        },
      });
      // fixF1 验收打点:status 服务端耗时(毫秒级为健康;>50ms 告警,配合前后对照度量)。
      {
        const statusMs = Date.now() - statusT0;
        if (statusMs > 50) console.error(`[gateway] session.status 慢:${statusMs}ms(本次归约 ${freshCount} 条事件${sinceSeq !== undefined ? `,sinceSeq=${sinceSeq}` : ",全量"},sessionId=${msg.sessionId})`);
      }
      break;
    }
    case "session.history": {
 // 向后翻页(设计参考 ZCode(致谢) rowsRange 游标分页):beforeSeq 在场即只取 seq<beforeSeq 的尾页;
      // 只给 limit 不给 sinceSeq 时=首屏(取全局最末 limit 条,beforeSeq 视为 +∞)。
      // 长会话首开因此不再全量拉历史。游标纪律:hasMore 只在「确实还有更早事件」时为 true,
      // nextBeforeSeq=本页最小 seq 且严格小于 beforeSeq,否则一律 false/不给——防前端 loop 死转。
      // sinceSeq 在场则一律走下面的旧全量/增量路径(逐字不变,不回归)。
      if (msg.beforeSeq !== undefined || (msg.limit !== undefined && msg.sinceSeq === undefined)) {
        const before = msg.beforeSeq ?? Number.POSITIVE_INFINITY;
        const pageSize = Math.min(2000, Math.max(1, msg.limit ?? 500));
        const older = journal.readSession(msg.sessionId).filter((e) => e.seq < before); // seq 升序(readSession 保序)
        const page = older.slice(Math.max(0, older.length - pageSize));
        const hasMore = older.length > page.length;
        const minSeq = page.length > 0 ? page[0]!.seq : undefined;
        const cursorAdvances = minSeq !== undefined && minSeq < before;
        safeSend(ws, {
          v: PROTOCOL_VERSION, type: "session.history.result", sessionId: msg.sessionId,
          since: minSeq ?? (Number.isFinite(before) ? before : 0), events: page,
          hasMore: hasMore && cursorAdvances,
          ...(hasMore && cursorAdvances ? { nextBeforeSeq: minSeq } : {}),
        });
        break;
      }
      const events = journal
        .readAll(msg.sinceSeq ?? 0)
        .filter((e) => e.sessionId === msg.sessionId);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "session.history.result", sessionId: msg.sessionId, since: msg.sinceSeq ?? 0, events });
      break;
    }
    // 运行看板(参考项目 dashboard 融合;数据源=journal,拉模型回包)。
    case "dashboard.sessions": {
      const all = journal.readAll();
      const scoped = eventsForScope(all, msg.projectId ?? "all");
      safeSend(ws, {
        v: PROTOCOL_VERSION,
        type: "dashboard.sessions.result",
        scope: msg.projectId ?? "all",
        sessions: rebuildDashboardSessions(scoped),
      });
      break;
    }
    case "dashboard.trends": {
      const all = journal.readAll();
      const scoped = eventsForScope(all, msg.projectId ?? "all");
      const buckets = computeDailyBuckets(aggregateDailySessions(scoped));
      const { current, previous } = summarizeTrendWindow(buckets);
      safeSend(ws, {
        v: PROTOCOL_VERSION,
        type: "dashboard.trends.result",
        scope: msg.projectId ?? "all",
        current,
        previous,
        daily: dailyWindow(buckets),
      });
      break;
    }
 // 子代理终止通道(目录「终止」按钮;最小消息,不动 spawn/清算区块):
    // 取消句柄挂在 __bgAgents 注册表条目的 cancel 字段上(spawn_subagent 后台句柄;并行线负责挂)。
    // 句柄缺席=诚实回 ok:false(面板 toast 提示),绝不假做成功。
    case "subagent.cancel": {
      const reg = (globalThis as { __bgAgents?: Map<string, Record<string, unknown>> }).__bgAgents;
      const entry = reg ? reg.get(msg.agentId) : undefined;
      const cancel = entry && typeof (entry as { cancel?: unknown }).cancel === "function"
        ? (entry as { cancel: () => unknown }).cancel
        : undefined;
      if (!cancel) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "subagent.cancel.result", agentId: msg.agentId, ok: false, reason: "取消通道未接入(该子代理无运行中句柄或已收尾)" });
        break;
      }
      try {
        await cancel();
        safeSend(ws, { v: PROTOCOL_VERSION, type: "subagent.cancel.result", agentId: msg.agentId, ok: true });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "subagent.cancel.result", agentId: msg.agentId, ok: false, reason: String(err).slice(0, 160) });
      }
      break;
    }
    case "session.fork": {
      // 会话分叉(ZCode session-fork 语义移植,refs: ZCode):新会话完整继承原会话上下文——
      // 原会话全部事件(剔除任务生命周期噪声)按原 seq 顺序重放进 journal,sessionId 改写为新 id;
      // 末尾落分叉标记行(message.system,deriveMessages 可见),随后由面板在新会话派发原指令。
      const srcEvents = journal.readAll().filter((e) => e.sessionId === msg.sessionId);
      if (srcEvents.length === 0) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "session.fork.result", ok: false, reason: `原会话不存在 ${msg.sessionId}` });
        break;
      }
      const forkId = "fork-" + Date.now().toString(36);
      let copied = 0;
      for (const e of srcEvents) {
        if (SESSION_FORK_EXCLUDED_KINDS.has(e.kind)) continue;
        // 幂等键必须剥除:journal 幂等表是全局的,带着原键会被判重复而静默丢弃继承件;
        // time 保留原值(继承历史的时序可读),seq 由 journal 重新分配。
        journal.append({ kind: e.kind, sessionId: forkId, payload: e.payload, time: e.time });
        copied++;
      }
      journal.append({
        kind: "message.system",
        sessionId: forkId,
        payload: { text: `[会话分叉] 本会话由 ${msg.sessionId} 于 ${new Date().toISOString()} 分叉,以上历史为继承上下文` },
      });
      // per-session 主模型覆盖随 fork 继承(ZCode session-fork 的 modelSelection 继承语义:
      // 新会话与父会话用同一模型选型,而不是回落到全局缺省)。无覆盖=不写、不产生噪声事件。
      // m8:copy 走 store 串行临界区(与并发 set 不交错、写前读盘合并),故此处 await。
      let modelOverride: { model: string; providerId?: string; effort?: string } | null = null;
      try {
        modelOverride = (await opts.sessionModels?.copy(msg.sessionId, forkId)) ?? null;
      } catch (err) {
        // fail-soft:覆盖复制失败不挂分叉(新会话按全局模型跑,warn 留痕)
        console.warn("[session-model] 分叉覆盖复制失败(新会话按全局模型):", String(err).slice(0, 160));
      }
      safeSend(ws, {
        v: PROTOCOL_VERSION, type: "session.fork.result", ok: true, sessionId: forkId, copied,
        ...(modelOverride ? { modelOverride } : {}),
      });
      break;
    }
    case "node.register":
      if (nodes) {
        nodes.register({ nodeId: msg.nodeId, capabilities: msg.capabilities, reachability: msg.reachability });
        if (opts.nodeConnections) {
 // 连接表登记:委派下发通道;断开即除名。
          opts.nodeConnections.register(msg.nodeId, (raw) => ws.readyState === WebSocket.OPEN && ws.send(raw));
          ws.on("close", () => {
            opts.nodeConnections?.drop(msg.nodeId);
 // 节点掉线廉价广播(面板重拉 nodes.list,Fleet/Gate 状态不靠手刷)。
            opts.broadcast?.({ v: PROTOCOL_VERSION, type: "nodes.changed" });
          });
        }
 // 节点上线廉价广播。
        opts.broadcast?.({ v: PROTOCOL_VERSION, type: "nodes.changed" });
        safeSend(ws, { v: PROTOCOL_VERSION, type: "node.registered", nodeId: msg.nodeId });
      } else {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "nodes 未启用" });
      }
      break;
    case "permission.respond": {
      if (!opts.permissionBroker) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "审批未启用" }); break; }
      // allow-always(F2):写项目级规则文件(下一次 ask 起热加载生效)+ 本次按 allow-once 结算。
      if (msg.decision === "allow-always") {
        const { addAlwaysAllowRule } = await import("./permission-store.js");
        const permission = msg.rule?.permission ?? "spawn_subagent";
        const pattern = msg.rule?.pattern ?? "*";
        const r = addAlwaysAllowRule(repoRoot(), permission, pattern);
        if (!r.ok) {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.RuleConflict, message: r.reason });
          break;
        }
 // 会话级代答登记:同会话后续 ask 免弹窗(policy 语义=always→auto_allow)。
        const askSession = opts.permissionBroker.sessionOf(msg.requestId);
        if (opts.permissionBroker.policy && askSession) {
          opts.permissionBroker.policy.applyDecision("local", askSession, "always");
        }
        const ok = opts.permissionBroker.respond(msg.requestId, "allow-once");
        if (!ok) safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.UnknownAsk, message: `无挂起的审批 ${msg.requestId}` });
        break;
      }
      const ok = opts.permissionBroker.respond(msg.requestId, msg.decision);
      if (!ok) safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.UnknownAsk, message: `无挂起的审批 ${msg.requestId}` });
      break;
    }
    case "git.commitmsg": {
 // AI 提交信息(ZCode gitCommitMessageGenerator 移植):diff 概要→主 LLM 一句话提交信息。
      const svc = await import("./git-service.js");
      const cwd = opts.projects?.resolveWorkdir(opts.projects.activeId()) ?? repoRoot();
      if (!(await svc.isGitRepo(cwd))) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.GitNorepo, message: "当前目录不是 git 仓库,已跳过" }); break; }
      try {
        const st = await svc.gitStatus(cwd);
        if (!st.changes.length) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.GitFailed, message: "无变更可生成提交信息" }); break; }
        const { promisify } = await import("node:util");
        const diffStat = await promisify((await import("node:child_process")).execFile)("git", ["diff", "--stat", "HEAD"], { cwd, maxBuffer: 2_000_000 }).then((r) => r.stdout.toString()).catch(() => "");
        const files = st.changes.slice(0, 20).map((c) => c.file).join(", ");
        let msg = "";
        const llm = (opts as { llm?: { chat: (msgs: unknown[], ms: unknown[]) => Promise<{ content: string }> } }).llm;
        if (llm) {
          const r = await llm.chat([{ role: "user", content: "为以下 git 变更写一句中文提交信息(≤50字,祈使句,不带前缀):\n文件:" + files + "\n统计:\n" + String(diffStat).slice(0, 1500) }], []);
          msg = r.content.trim().split("\n")[0]?.replace(/^["']|["']$/g, "") ?? "";
        }
        safeSend(ws, { v: PROTOCOL_VERSION, type: "git.ok", op: "commitmsg", detail: msg || ("chore: " + files.slice(0, 40)) });
      } catch (err) {
        // 与 git.status 同口径:git-service 已把失败归一成可判读文本,这里只去掉 Error: 前缀
        const text = err instanceof Error ? err.message : String(err);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.GitFailed, message: text.slice(0, 200) });
      }
      break;
    }
    case "profile.get": {
      if (!opts.profiles) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "项目档案未启用" }); break; }
      // 无档案→启动管线(started 语义);running→本连接立即收一次当前进度;done→直接回档案。
      const r = opts.profiles.getOrStart(msg.projectId) as Record<string, unknown>;
      if (r && typeof r === "object" && (r.profile as unknown || r.modules)) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "profile.get.result", profile: r });
      } else {
        const cur = opts.profiles.get(msg.projectId);
        if (cur) safeSend(ws, { v: PROTOCOL_VERSION, type: "profile.get.result", profile: cur });
        else safeSend(ws, { v: PROTOCOL_VERSION, type: "profile.progress", projectId: msg.projectId, progress: 1, stage: "启动中", state: "pending" });
      }
      break;
    }
    case "profile.rebuild": {
      if (!opts.profiles) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "项目档案未启用" }); break; }
      opts.profiles.rebuild(msg.projectId);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "profile.progress", projectId: msg.projectId, progress: 1, stage: "重建启动", state: "running" });
      break;
    }
    case "profile.plan.upsert":
    case "profile.plan.remove": {
      if (!opts.profiles) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "项目档案未启用" }); break; }
      const pf = opts.profiles as unknown as {
        planUpsert(projectId: string, item: unknown): unknown;
        planRemove(projectId: string, id: string): unknown;
        get(projectId: string): unknown;
      };
      const r = msg.type === "profile.plan.upsert"
        ? pf.planUpsert(msg.projectId, msg.item)
        : pf.planRemove(msg.projectId, msg.id);
      if (r && typeof r === "object" && "error" in (r as object)) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.PlanInvalid, message: String((r as { error: string }).error) });
        break;
      }
      const cur = pf.get(msg.projectId);
      if (cur) safeSend(ws, { v: PROTOCOL_VERSION, type: "profile.get.result", profile: cur });
      break;
    }
    case "profile.plan.apply": {
      // 规划落地:任务书→提交任务(带 projectId)→清规划→演进记录「规划落地」。
      if (!opts.profiles) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "项目档案未启用" }); break; }
      const pf = opts.profiles as unknown as {
        planInstruction(projectId: string): string | { error: string };
        planClear(projectId: string): unknown;
        get(projectId: string): { plan?: { kind: string; name?: string; from?: string; to?: string }[] } | undefined;
        recordChange(projectId: string, c: { taskId: string; title: string; files: { path: string }[]; add: number; del: number }): void;
      };
      const instr = pf.planInstruction(msg.projectId);
      if (typeof instr !== "string") { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.PlanEmpty, message: String((instr as { error: string }).error) }); break; }
      const task = tm.submit("user", "web-plan-" + Date.now(), instr, { projectId: msg.projectId, title: "[规划] 架构调整" });
      const planSnap = pf.get(msg.projectId)?.plan ?? [];
      pf.planClear(msg.projectId);
      pf.recordChange(msg.projectId, {
        taskId: task.id, title: "规划落地(" + planSnap.length + " 项:" + planSnap.map((x) => x.name ?? (x.from + "→" + x.to)).slice(0, 4).join(",") + ")",
        files: [], add: 0, del: 0,
      });
      safeSend(ws, { v: PROTOCOL_VERSION, type: "task.submitted", task });
      const cur = (opts.profiles as unknown as { get(id: string): unknown }).get(msg.projectId);
      if (cur) safeSend(ws, { v: PROTOCOL_VERSION, type: "profile.get.result", profile: cur });
      break;
    }
 // ---- 总路线并入代码档案:项目宗旨/主线能力/偏离提示 + 确定性骨架 ----
    case "profile.sense.get": {
      const root = opts.projects?.resolveWorkdir(msg.projectId) ?? repoRoot();
      try {
        const payload = await profileSensePayload(root, { generate: msg.generate === true, refresh: msg.refresh === true, llm: opts.llm });
        safeSend(ws, { v: PROTOCOL_VERSION, type: "profile.sense.result", projectId: msg.projectId ?? null, ...payload });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.ProfileSenseFailed, message: String(err).slice(0, 300) });
      }
      break;
    }
    case "plugins.list": {
      if (!opts.plugins) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "插件未启用" }); break; }
      const inst = new Map(opts.plugins.listInstalled().map((x) => [x.id, x]));
      const catalog = opts.plugins.catalog().map((m) => {
        const mm = m as { id: string };
        const hit = inst.get(mm.id);
        return { ...(m as object), ...(hit ? { installed: true, enabled: hit.enabled } : { installed: false }) };
      });
      safeSend(ws, { v: PROTOCOL_VERSION, type: "plugins.list.result", catalog });
      break;
    }
    case "plugins.install": {
      if (!opts.plugins) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "插件未启用" }); break; }
      const r = opts.plugins.install(msg.id) as { error?: string };
      if (r && r.error) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.PluginInvalid, message: r.error }); break; }
      // 安装即广播新目录(installed 态)+刷新命令/MCP 面
      safeSend(ws, { v: PROTOCOL_VERSION, type: "git.ok", op: "plugin-install", detail: "已安装 " + msg.id });
      break;
    }
    case "plugins.uninstall": {
      if (!opts.plugins) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "插件未启用" }); break; }
      const ok = opts.plugins.uninstall(msg.id);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "git.ok", op: "plugin-uninstall", detail: ok ? "已卸载 " + msg.id : "未安装 " + msg.id });
      break;
    }
    case "plugins.toggle": {
      if (!opts.plugins) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "插件未启用" }); break; }
      const r = opts.plugins.toggle(msg.id, msg.enabled) as { error?: string };
      if (r && r.error) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.PluginInvalid, message: r.error }); break; }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "git.ok", op: "plugin-toggle", detail: msg.id + (msg.enabled ? " 已启用" : " 已停用") });
      break;
    }
    case "voice.tts": {
 // TTS 播报(二期:文本→qwen-tts→音频 base64;凭证不出服务端。
 // 通用 TTS 能力保留(设置页试听/播报面仍用),super agent 链不再调用它
      // (指挥台出站只有 super.* 文本消息)。brief 级经 voice 包播报改写器(rewriteForSpeech)口语化限长。
      try {
        const cfg = (opts as { config?: import("@lampgenie/core").Config }).config;
        const { buildTtsFromConfig } = await import("./factory.js");
        const tts = ttsClientCache ??= buildTtsFromConfig(cfg ?? (await import("@lampgenie/core")).loadConfig({ repoRoot: repoRoot() }).config, repoRoot());
        if (!tts) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.VoiceUnavailable, message: "audio.tts 未配置(qwen3-tts)" }); break; }
        const { rewriteForSpeech } = await import("@lampgenie/runtime/voice/panel");
        let text = msg.level === "brief" ? rewriteForSpeech(msg.text, 60) : msg.text;
 // 小模型兜底(「规则先行,小模型兜底」):brief 级 + GENIE_VOICE_POLISH=1 + LLM 在场时
        // 一次口语化改写(6s 超时;任何失败回退规则版——兜底永不阻塞播报)。
        if (msg.level === "brief" && process.env.GENIE_VOICE_POLISH === "1" && opts.llm) {
          try {
            const res = await Promise.race([
              (opts.llm as import("@lampgenie/runtime/agent/loop").LlmProvider).chat(
                [{ role: "user", content: `把下面内容改写成一句不超过 50 字的中文口语播报,直接说内容不要前缀:\n${msg.text.slice(0, 400)}` }],
                [],
              ),
              new Promise<never>((_, rej) => setTimeout(() => rej(new Error("polish timeout")), 6_000)),
            ]);
            const polished = String((res as { content?: string }).content ?? "").trim().split("\n")[0]?.slice(0, 80);
            if (polished) text = polished;
          } catch { /* 兜底失败=规则版 */ }
        }
        const audio = await tts.speak(text, msg.voice ? { voice: msg.voice } : {});
        safeSend(ws, { v: PROTOCOL_VERSION, type: "voice.tts.result", audioB64: audio.base64, mime: audio.mime, text, ...(msg.voice ? { voice: msg.voice } : {}) });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.VoiceFailed, message: String(err).slice(0, 200) });
      }
      break;
    }
    case "voice.list": {
 // 音色清单(音色选择+试听):内置官方音色表按当前 audio.tts.model 过滤;
      // 未知模型=空表(前端自定义 voice id 兜底)。清单只读,不出凭证。
      const cfgV = (opts as { config?: import("@lampgenie/core").Config }).config;
      const vModel = cfgV?.audio?.tts?.model ?? "";
      const { voicesForModel } = await import("./voices.js");
      safeSend(ws, { v: PROTOCOL_VERSION, type: "voice.list.result", model: vModel, voices: voicesForModel(vModel) });
      break;
    }
    case "voice.transcribe": {
 // 语音输入:浏览器 PCM16(base64)→ 服务端 ASR → 文本;不含人格设定与语音回播,
      // 前端拿到文本后自行发 super.turn(音频不再直入大脑)。
      const audioB64 = typeof msg.audioB64 === "string" ? msg.audioB64 : "";
      const asr = opts.superAgent?.asr;
      if (!asr) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.VoiceUnavailable, message: "audio.chat(ASR)未配置" }); break; }
      if (!audioB64) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.VoiceUnavailable, message: "音频为空" }); break; }
      try {
        opts.superAgent?.onActivity?.(); // 语音入口也算指挥台活跃
        const text = await asr({ data: audioB64, format: msg.format ?? "pcm16" });
        safeSend(ws, { v: PROTOCOL_VERSION, type: "voice.transcribe.result", text });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.VoiceFailed, message: String(err).slice(0, 200) });
      }
      break;
    }
 // ── 看板三件套(子代理目录/任务追踪(含五阶段+todo)/用量追踪,各自独立看板)──
    case "workers.list": {
      // 会话 worker 清单(F5-3 可观测):活跃 worker 进程(pid/会话/时刻)。
      const host = (globalThis as { __sessionWorkerHost?: { list(): { taskId: string; sessionId: string; pid?: number; startedAt: number; readyAt?: number; lastEventAt?: number; ready: boolean }[] } }).__sessionWorkerHost;
      safeSend(ws, { v: PROTOCOL_VERSION, type: "workers.list.result", workers: host ? host.list() : [] });
      break;
    }
    case "subagents.list": {
      // 子代理目录:全局注册表(运行中真态)+ journal 终态回溯(近 400 个 subagent 事件窗口)。
 // 带 sessionId 时两区都按会话过滤。
      const wantSid = msg.sessionId !== undefined ? String(msg.sessionId) : null;
      const reg = (globalThis as { __bgAgents?: Map<string, { outputFile: string; status: string; sessionId: string; title?: string; model?: string; lastEventAt?: number }> }).__bgAgents;
      const running: unknown[] = [];
 // 「运行中」只放真在跑的(用户用户反馈):注册表保留终态条目用于收割/回溯,
      // 旧实现把整表倒进 running,已完成子代理长期挂在「运行中」区,用户以为还在跑。
      const regIds = new Set<string>();
      if (reg) {
        for (const [aid, en] of reg) {
          regIds.add(aid);
          if (String(en.status) !== "running") continue;
          if (wantSid !== null && String(en.sessionId) !== wantSid) continue;
          running.push({ agentId: aid, title: en.title ?? "", model: en.model ?? "", status: en.status, sessionId: en.sessionId, lastEventAgoSec: en.lastEventAt ? Math.max(0, Math.round((Date.now() - en.lastEventAt) / 1000)) : undefined, outputFile: en.outputFile });
        }
      }
      // 终态回溯:subagent.spawn/result 配对(近 300 条);title/at 从 spawn 事件回查(旧实现缺 title 只有 agentId)
      const past: unknown[] = [];
      try {
        const evts = opts.journal.readAll().filter((e) => (e.kind === "subagent.spawn" || e.kind === "subagent.result") && (wantSid === null || String((e as { sessionId?: string }).sessionId ?? "") === wantSid)).slice(-300);
        const spawnInfo = new Map<string, { title: string; at?: number; agentType?: string }>();
        for (const e of evts) {
          if (e.kind !== "subagent.spawn") continue;
          const sp = (e.payload ?? {}) as { agentId?: string; title?: string; agentType?: string; instructions?: string };
          const sid2 = String(sp.agentId ?? "");
          if (sid2) spawnInfo.set(sid2, { title: String(sp.title ?? (sp.instructions ? String(sp.instructions).slice(0, 40) : "")), at: e.time, agentType: String(sp.agentType ?? "") });
        }
        const seenDone = new Set<string>();
        for (let i = evts.length - 1; i >= 0 && past.length < 60; i--) {
          const e = evts[i]!;
          const p = (e.payload ?? {}) as { agentId?: string; instructions?: string; event?: { ok?: boolean; finalText?: string }; reap?: { reason?: string } };
          const aid = String(p.agentId ?? "");
          if (e.kind === "subagent.result" && aid && !seenDone.has(aid)) {
            seenDone.add(aid);
            const sp = spawnInfo.get(aid);
            past.push({ agentId: aid, title: sp?.title ?? "", agentType: sp?.agentType ?? "", ok: p.event?.ok !== false, reap: p.reap?.reason, finalText: String(p.event?.finalText ?? "").slice(0, 160), at: e.time, spawnedAt: sp?.at, sessionId: (e as { sessionId?: string }).sessionId });
          }
        }
      } catch { /* journal 读失败=空表(诚实降级) */ }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "subagents.list.result", running, past });
      break;
    }
    case "track.view": {
      // 任务追踪看板:任务表(近 30)+每任务五阶段(task.phase 事件)+最新 todo 快照。
 // 任务源(修复重启盲区):内存 tm 优先 + journal 回放(tm 里没有的历史任务,
      // 从 task.start/done/failed 事件重建)合并——gateway 重启后历史任务仍进卡。
      const live = tm.list().slice(0, 30).map((t) => ({ id: t.id, sessionId: t.sessionId, state: t.state, instruction: String(t.instruction ?? "").slice(0, 100), updatedAt: t.updatedAt ?? t.createdAt }));
      const byId = new Map(live.map((t) => [t.id, t]));
      try {
        for (const e of opts.journal.readAll()) {
          if (e.kind !== "task.start" && e.kind !== "task.done") continue; // journal 无 task.failed:失败终态由 task.done payload.state 区分?若无则 start-only 回放(诚实)
          const p = (e.payload ?? {}) as { id?: string; sessionId?: string; instruction?: string; state?: string };
          if (!p.id || byId.has(p.id)) continue;
          const st = e.kind === "task.done" ? String((p as { state?: string }).state === "failed" ? "failed" : "done") : "done";
          byId.set(p.id, { id: p.id, sessionId: e.sessionId, state: st as "done" | "failed", instruction: String(p.instruction ?? "").slice(0, 100), updatedAt: e.time ?? 0 });
        }
      } catch { /* 回放失败=仅内存任务(诚实降级) */ }
 // 任务追踪只显示当前选中会话——sessionId 在场=按会话过滤(近 30);
      // 缺席=全部近 40(兼容旧客户端/调试)。
      const wantSid = typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : null;
      const tasks = [...byId.values()]
        .filter((t) => !wantSid || t.sessionId === wantSid)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, wantSid ? 30 : 40);

      const todoBySession = new Map<string, { content: string; status: string }[]>();
      const phasesByTaskId = new Map<string, { phase: string; note: string; skipped: boolean; auto: boolean }[]>();
      const lastTaskOfSession = new Map<string, string>();
      try {
 // 阶段归属(修正):按事件 taskId 挂到对应任务(防同会话多任务串轨迹);
        // 旧事件无 taskId(去白板改造前)兜底挂会话内最新任务。
        for (const e of opts.journal.readAll()) {
          if (e.kind === "task.start" && e.sessionId) lastTaskOfSession.set(e.sessionId, String((e.payload as { id?: string } | undefined)?.id ?? ""));
          else if (e.kind === "custom") {
            const p = (e.payload ?? {}) as { type?: string; taskId?: string; phase?: string; note?: string; skip?: boolean; auto?: boolean };
            if (p.type === "task.phase" && e.sessionId) {
              const owner = String(p.taskId ?? lastTaskOfSession.get(e.sessionId) ?? "");
              if (!owner) continue;
              const arr = phasesByTaskId.get(owner) ?? [];
              arr.push({ phase: String(p.phase ?? ""), note: String(p.note ?? "").slice(0, 60), skipped: p.skip === true, auto: p.auto === true });
              phasesByTaskId.set(owner, arr);
            }
          } else if (e.kind === "todo.updated") {
            const p = (e.payload ?? {}) as { items?: { content?: string; status?: string }[] };
            if (Array.isArray(p.items)) todoBySession.set(e.sessionId, p.items.map((it) => ({ content: String(it.content ?? "").slice(0, 100), status: String(it.status ?? "") })));
          }
        }
      } catch { /* 读失败=空阶段(诚实降级) */ }
 // 追踪 Trace = turn 树(计划/todo 不再独立成块)——
      // 一级=turn(用户一轮输入),二级=五阶段(固定 5 个),三级=该阶段 LLM 写的阶段任务(note,可多条)。
      // 阶段归属:按 journal 顺序挂到「此前最近的 turn.start」(同一 turn 内多次声明=多条三级节点)。
      type TrackTurn = {
        turn: number; no?: number; at: number; userText: string; taskId: string; reasons: string[];
        phases: Record<string, { note: string; at: number; skipped: boolean; auto?: boolean }[]>;
      };
      const turns: TrackTurn[] = [];
 // 会话内显示序号:payload.turn 是 loop 静态计数器,每任务从 1 起,跨任务重复;
      // 看板「会话第几轮」按 turn.start 出现序派生 no(多会话交错时各自独立递增)。
      const turnNo = new TurnNoCounter();
      try {
        const scope = wantSid ? opts.journal.readSession(wantSid) : opts.journal.readAll();
        let cur: TrackTurn | null = null;
        let curTask = "";
        for (const e of scope) {
          if (wantSid && e.sessionId !== wantSid) continue;
          if (e.kind === "task.start") {
            curTask = String((e.payload as { id?: string } | undefined)?.id ?? "");
          } else if (e.kind === "turn.start") {
            const n = Number((e.payload as { turn?: number } | undefined)?.turn ?? 0);
            cur = { turn: Number.isFinite(n) ? n : 0, no: turnNo.next(e.sessionId), at: e.time ?? 0, userText: "", taskId: curTask, reasons: [], phases: {} };
            turns.push(cur);
          } else if (e.kind === "turn.end") {
            const r = String((e.payload as { reason?: string } | undefined)?.reason ?? "");
            if (cur && r && r !== "stop" && r !== "done") cur.reasons.push(r);
          } else if (e.kind === "message.user" && cur) {
            const p2 = e.payload as { display?: string; text?: string };
            const txt = String(p2.display || p2.text || "");
            // 系统注入块(display 缺省且以 system-reminder 开头)不是用户所说,不进 turn 标题
            const injected = p2.display === undefined && txt.startsWith("<system-reminder>");
            if (txt && !injected && !cur.userText) cur.userText = txt.slice(0, 180);
          } else if (e.kind === "custom" && cur) {
            const p2 = e.payload as { type?: string; taskId?: string; phase?: string; note?: string; skip?: boolean; auto?: boolean };
            if (p2.type !== "task.phase") continue;
            const phase = String(p2.phase ?? "");
            if (!phase) continue;
            (cur.phases[phase] ??= []).push({ note: String(p2.note ?? "").slice(0, 400), at: e.time ?? 0, skipped: p2.skip === true, auto: p2.auto === true });
          }
        }
      } catch { /* 读失败=空 turn 树(诚实降级) */ }
      // 已派发但还没跑到 turn.start 的任务(刚提交/排队):补一个「待启动」一级节点,免得追踪卡一片空白
      const turnTaskIds = new Set(turns.map((t) => t.taskId));
      for (const t of tasks) {
        if (turnTaskIds.has(t.id)) continue;
        turns.push({ turn: 0, no: turnNo.next(t.sessionId), at: t.updatedAt ?? 0, userText: String(t.instruction ?? "").slice(0, 180), taskId: t.id, reasons: ["pending"], phases: {} });
      }
      const taskStateById: Record<string, string> = {};
      for (const t of tasks) taskStateById[t.id] = t.state;
      safeSend(ws, {
        v: PROTOCOL_VERSION, type: "track.view.result",
        // tasks 保留(兼容旧客户端/统计);todo 不再下发(todoBySession 保留变量以免影响其它读取路径)
        tasks: tasks.map((t) => ({ ...t, phases: (phasesByTaskId.get(t.id) ?? []).slice(-8) })),
        turns: turns.slice(-20),
        taskStates: taskStateById,
      });
      void todoBySession;
      break;
    }
    case "usage.view": {
      // 用量看板:journal llm.trace 的 tokens 按 model+session 聚合(主轨/子代理分列)。
      const byKey = new Map<string, { model: string; sessionId: string; calls: number; input: number; output: number; cacheRead: number }>();
      let readFailed = false;
      try {
        for (const e of opts.journal.readAll()) {
          if (e.kind !== "llm.trace") continue;
          const p = (e.payload ?? {}) as { model?: string; usage?: { inputTokens?: number; outputTokens?: number; cache?: { read?: number } } };
          if (!p.usage) continue;
          const model = String(p.model ?? "?");
          const key = model + "|" + e.sessionId;
          const cur = byKey.get(key) ?? { model, sessionId: e.sessionId, calls: 0, input: 0, output: 0, cacheRead: 0 };
          cur.calls++; cur.input += p.usage.inputTokens ?? 0; cur.output += p.usage.outputTokens ?? 0; cur.cacheRead += p.usage.cache?.read ?? 0;
          byKey.set(key, cur);
        }
      } catch { readFailed = true; /* 读失败:前端区分「无数据」与「读取失败」,不把读炸伪装成空表 */ }
      const rows = [...byKey.values()].sort((a, b) => b.input + b.output - a.input - a.output).slice(0, 40);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "usage.view.result", rows, failed: readFailed, updatedAt: Date.now() });
      break;
    }
    case "nodes.list": {
 // 节点表(电脑控制/远程):真实注册表 + 在线态 + 本机身份指纹。
      const list = (opts.nodes?.list() ?? []).map((n) => ({ ...n, online: Date.now() - n.lastHeartbeat <= 60_000 }));
      let identity: { fingerprint?: string; mode: string } = { mode: "本地" };
      try {
        const { loadOrCreateIdentity } = await import("@lampgenie/runtime/identity/identity");
        const id = loadOrCreateIdentity(join(repoRoot(), ".genie", "identity"));
        identity = { fingerprint: id.fingerprint.slice(0, 16), mode: process.env.RELAY_URL ? "relay" : "本地直连" };
      } catch {
        // 身份面缺席=本地模式
      }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "nodes.list.result", nodes: list, identity });
      break;
    }
    case "node.exec": {
 // 电脑控制(真路由):local=本机任务链照旧;remote=NodeDispatch.delegate 精确钉选
      // 该节点代执行,结果经 node.exec.result 回面板(旧行为存 targetNode 却无分派消费,命令实际
      // 在本机跑——名不副实已修);节点不在线/委派失败=显式失败,不假装已派。
      if (!opts.nodeDispatch) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "委派通道未启用" }); break; }
      if (msg.nodeId === "local") {
        const task = tm.submit("user", "web-" + Date.now(), msg.command, { targetNode: "local", title: "[本机] 电脑控制" });
        safeSend(ws, { v: PROTOCOL_VERSION, type: "task.submitted", task });
        break;
      }
      const online = (opts.nodes?.online() ?? []).some((n) => n.nodeId === msg.nodeId);
      if (!online) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NodeOffline, message: "节点不在线:" + msg.nodeId }); break; }
      const t0 = Date.now();
      const r = await opts.nodeDispatch.delegate(
        { taskId: "exec-" + Date.now().toString(36), instruction: msg.command },
        "web-" + Date.now().toString(36),
        { nodeId: msg.nodeId },
      );
      safeSend(ws, {
        v: PROTOCOL_VERSION,
        type: "node.exec.result",
        nodeId: msg.nodeId,
        ok: r.ok,
        ...(r.output ? { output: r.output.slice(0, 4096) } : {}),
        ...(r.error ? { error: r.error.slice(0, 400) } : {}),
        durationMs: Date.now() - t0,
      });
      break;
    }
    case "wizard.gen": {
      if (!opts.wizardGen) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "向导未启用" }); break; }
      const r = opts.wizardGen({ kind: msg.kind, host: msg.host, user: msg.user, port: msg.port, nodeId: msg.nodeId });
      safeSend(ws, { v: PROTOCOL_VERSION, type: "wizard.gen.result", kind: msg.kind, command: r.command, note: r.note });
      break;
    }
    case "agents.list": {
 // 子智能体管理面:内置 + .genie/agents/*.md(ZCode 子智能体列表)。
      try {
        const { loadAgentProfiles } = await import("@lampgenie/runtime/agent/agent-profiles");
        const profiles = loadAgentProfiles(repoRoot());
        safeSend(ws, { v: PROTOCOL_VERSION, type: "agents.list.result", agents: profiles.map((x) => ({ name: x.name, description: x.description, systemPrompt: x.systemPrompt, tools: x.tools ?? [], builtin: x.builtin })) });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.AgentsFailed, message: String(err).slice(0, 150) });
      }
      break;
    }
    case "skills.list": {
      if (!opts.skillsAdmin) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "技能面未启用" }); break; }
      try {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "skills.list.result", items: opts.skillsAdmin.index(), disabled: opts.skillsAdmin.disabled().map((name) => ({ category: "builtin", name })).concat((opts.experience?.disabled?.() ?? [])) });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.SkillsFailed, message: String(err).slice(0, 150) });
      }
      break;
    }
    case "skills.disableBuiltin": {
      if (!opts.skillsAdmin) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "技能面未启用" }); break; }
      opts.skillsAdmin.set(msg.name, msg.disabled);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "skills.list.result", items: opts.skillsAdmin.index(), disabled: opts.skillsAdmin.disabled().map((name) => ({ category: "builtin", name })).concat((opts.experience?.disabled?.() ?? [])) });
      break;
    }
    case "commands.catalog": {
      // 纯内置目录(ZCode「内置命令目录=唯一权威」):不带 body,面板命令中心据此渲染。
      safeSend(ws, {
        v: PROTOCOL_VERSION,
        type: "commands.catalog.result",
        commands: BUILTIN_COMMANDS.map((c) => ({
          name: c.name,
          description: c.description,
          inputHint: c.inputHint,
          source: "builtin" as const,
          usage: c.usage,
          details: c.details,
        })),
      });
      break;
    }
    case "commands.list": {
      // 内置在前 + 自定义在后(自定义同名内置已在 CommandStore 层剔除并给诊断)。
      safeSend(ws, { v: PROTOCOL_VERSION, type: "commands.list.result", ...mergedCommandList(opts.commands) });
      break;
    }
    case "commands.upsert": {
      if (!opts.commands) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "命令面未启用" }); break; }
      const r = opts.commands.upsert(msg.name, msg.body) as { error?: string };
      if (r && r.error) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.CommandInvalid, message: r.error }); break; }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "commands.list.result", ...mergedCommandList(opts.commands) });
      break;
    }
    case "commands.remove": {
      if (!opts.commands) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "命令面未启用" }); break; }
      opts.commands.remove(msg.name);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "commands.list.result", ...mergedCommandList(opts.commands) });
      break;
    }
    case "hooks.list": {
      if (!opts.hooks) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "钩子未启用" }); break; }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "hooks.list.result", hooks: opts.hooks.list() });
      break;
    }
    case "hooks.upsert": {
      if (!opts.hooks) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "钩子未启用" }); break; }
      const r = opts.hooks.add({ name: msg.name, event: msg.event, command: msg.command }) as { error?: string };
      if (r && r.error) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.HookInvalid, message: r.error }); break; }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "hooks.list.result", hooks: opts.hooks.list() });
      break;
    }
    case "hooks.update": {
      if (!opts.hooks) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "钩子未启用" }); break; }
      opts.hooks.update(msg.id, { enabled: msg.enabled });
      safeSend(ws, { v: PROTOCOL_VERSION, type: "hooks.list.result", hooks: opts.hooks.list() });
      break;
    }
    case "hooks.remove": {
      if (!opts.hooks) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "钩子未启用" }); break; }
      opts.hooks.remove(msg.id);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "hooks.list.result", hooks: opts.hooks.list() });
      break;
    }
    case "mcp.list": {
      if (!opts.mcp) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "MCP 未启用" }); break; }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "mcp.list.result", servers: opts.mcp.store.list(), status: opts.mcp.statusOf() });
      break;
    }
    case "mcp.upsert": {
      if (!opts.mcp) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "MCP 未启用" }); break; }
      const r = opts.mcp.store.add({ name: msg.name, command: msg.command, args: msg.args }) as { error?: string };
      if (r && r.error) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.McpInvalid, message: r.error }); break; }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "mcp.list.result", servers: opts.mcp.store.list(), status: opts.mcp.statusOf() });
      break;
    }
    case "mcp.update": {
      if (!opts.mcp) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "MCP 未启用" }); break; }
      opts.mcp.store.update(msg.id, { enabled: msg.enabled });
      safeSend(ws, { v: PROTOCOL_VERSION, type: "mcp.list.result", servers: opts.mcp.store.list(), status: opts.mcp.statusOf() });
      break;
    }
    case "mcp.remove": {
      if (!opts.mcp) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "MCP 未启用" }); break; }
      opts.mcp.store.remove(msg.id);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "mcp.list.result", servers: opts.mcp.store.list(), status: opts.mcp.statusOf() });
      break;
    }
    case "mcp.test": {
      if (!opts.mcp) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "MCP 未启用" }); break; }
      const st = await opts.mcp.test(msg.id);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "mcp.test.result", id: msg.id, ok: st.ok, tools: st.tools, ...(st.error ? { error: st.error } : {}) });
      safeSend(ws, { v: PROTOCOL_VERSION, type: "mcp.list.result", servers: opts.mcp.store.list(), status: opts.mcp.statusOf() });
      break;
    }
    case "memory.view": {
      if (!opts.memoryView) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "记忆面未启用" }); break; }
      try {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "memory.view.result", ...opts.memoryView() });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.MemoryFailed, message: String(err).slice(0, 150) });
      }
      break;
    }
    case "term.exec":
    case "term.cancel": {
 // 终端:面板发命令 → 项目根执行(shell 由 shellInvocation 决定:POSIX=bash 登录 shell(-lc),Win32=cmd.exe /d /s /c),
      // stdout/stderr 流式回传。红线:每连接同时最多一条命令;120s 超时;200KB 输出上限;仅在面板本地连接(WS 与面板同端口)。
      const key = (ws as unknown as { __term?: { kill: () => void } }).__term;
      if (msg.type === "term.cancel") {
        if (key) { try { key.kill(); } catch { /* 忽略 */ } }
        break;
      }
      if (key) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.TermBusy, message: "已有命令在执行" }); break; }
 // 远程项目(SSH/WSL:命令走远端工作区服务(不进本地 shell;此前会落 harness 根)。
      {
        const termAct = opts.projects?.list().find((p) => p.id === opts.projects?.activeId());
        const termRemoteExec = termAct ? parseRemoteProject(termAct.path) : null;
        if (termRemoteExec) {
          const r = await remoteExec(termRemoteExec, msg.command, { timeoutMs: 120_000 });
          if ("error" in r) {
            safeSend(ws, { v: PROTOCOL_VERSION, type: "term.output", chunk: "\n" + r.error + "\n", err: true });
            safeSend(ws, { v: PROTOCOL_VERSION, type: "term.exit", code: 1, killed: false });
          } else {
            safeSend(ws, { v: PROTOCOL_VERSION, type: "term.output", chunk: r.stdout });
            safeSend(ws, { v: PROTOCOL_VERSION, type: "term.exit", code: 0, killed: false, ...(r.truncated ? { truncated: true } : {}) });
          }
          break;
        }
      }
      try {
        const { spawn: spawnProc } = await import("node:child_process");
        const cwd = opts.projects ? opts.projects.resolveWorkdir(opts.projects.activeId()) : repoRoot();
        // Windows 无 bash:shell 选择统一走 shellInvocation(win32=cmd.exe /d /s /c;GENIE_SHELL_BIN 可覆盖为 Git-Bash)。
        // WSL 项目(UNC cwd)切 wsl.exe,命令在发行版内执行。
        const inv = shellInvocation(msg.command, { cwd });
        const child = spawnProc(inv.cmd, inv.args, { cwd: inv.mode === "wsl" ? undefined : cwd, env: { ...process.env } });
        let bytes = 0;
        let killed = false;
        const state = {
          kill: () => { killed = true; try { child.kill("SIGKILL"); } catch { /* 忽略 */ } },
        };
        (ws as unknown as { __term?: typeof state }).__term = state;
        const pump = (stream: NodeJS.ReadableStream | null, isErr: boolean) => {
          stream?.on("data", (d: Buffer) => {
            if (bytes > 200 * 1024) return;
            bytes += d.length;
            safeSend(ws, { v: PROTOCOL_VERSION, type: "term.output", chunk: d.toString(), ...(isErr ? { err: true } : {}) });
          });
        };
        pump(child.stdout, false);
        pump(child.stderr, true);
        // shell 拉不起来(spawn ENOENT,如 Windows 无 bash)是 error 事件而非抛错:显式回传入话文案,不静默。
        child.on("error", (err) => {
          const hint = shellErrorHint(err, inv) ?? String(err).slice(0, 200);
          safeSend(ws, { v: PROTOCOL_VERSION, type: "term.output", chunk: "\n" + hint + "\n", err: true });
          safeSend(ws, { v: PROTOCOL_VERSION, type: "term.exit", code: 127, killed: false });
          (ws as unknown as { __term?: unknown }).__term = undefined;
        });
        const timer = setTimeout(() => { killed = true; try { child.kill("SIGKILL"); } catch { /* 忽略 */ } }, 120_000);
        timer.unref?.();
        child.on("exit", (code) => {
          clearTimeout(timer);
          (ws as unknown as { __term?: unknown }).__term = undefined;
          safeSend(ws, { v: PROTOCOL_VERSION, type: "term.exit", code: code ?? null, ...(killed ? { killed: true } : {}) });
        });
        ws.on("close", () => { clearTimeout(timer); try { child.kill("SIGKILL"); } catch { /* 忽略 */ } });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.TermFailed, message: String(err).slice(0, 200) });
      }
      break;
    }
    case "exp.disable": {
      if (!opts.experience) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "经验库未启用" }); break; }
      // setStatus 经 store 面:disabled 不入 index→开工注入(recall 走 index)自动排除。
      const { ExperienceStore } = await import("@lampgenie/experience");
      const store = new ExperienceStore(join(repoRoot(), ".genie", "experiences"));
      try {
        store.setStatus(msg.category, msg.name, msg.disabled ? "disabled" : "active");
        const items = opts.experience.index();
        safeSend(ws, { v: PROTOCOL_VERSION, type: "exp.list.result", items, disabled: opts.experience?.disabled?.() ?? [] });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.ExpFailed, message: String(err).slice(0, 150) });
      }
      break;
    }
    case "checkpoint.preview":
    case "checkpoint.rewind": {
      const svc = await import("./git-service.js");
      const ev = journal.readAll().filter((e) => e.kind === "checkpoint.create" && (e.payload as { taskId?: string }).taskId === msg.taskId).at(-1);
      const sha = ev ? ((ev.payload as { sha?: string | null }).sha ?? null) : null;
      if (!sha) { safeSend(ws, { v: PROTOCOL_VERSION, type: "checkpoint.preview.result", taskId: msg.taskId, sha: null, files: [] }); break; }
      const root = ((ev!.payload as { root?: string }).root) ?? repoRoot();
      if (msg.type === "checkpoint.preview") {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "checkpoint.preview.result", taskId: msg.taskId, sha, files: await svc.checkpointPreview(root, sha) });
      } else {
        const n = await svc.checkpointRewind(root, sha);
        journal.append({ kind: "checkpoint.restore", sessionId: ev!.sessionId, payload: { taskId: msg.taskId, sha, files: n } });
        safeSend(ws, { v: PROTOCOL_VERSION, type: "git.ok", op: "rewind", detail: "已回滚 " + n + " 个文件到任务前" });
      }
      break;
    }
    case "task.diffstat": {
 // 内联变更条:按任务快照 sha 算 numstat(无快照/无差异=空,面板隐藏条)。
      try {
        const svc = await import("./git-service.js");
        const ev = journal.readAll().filter((e) => e.kind === "checkpoint.create" && (e.payload as { taskId?: string }).taskId === msg.taskId).at(-1);
        const sha = ev ? ((ev.payload as { sha?: string | null }).sha ?? null) : null;
        if (!sha) { safeSend(ws, { v: PROTOCOL_VERSION, type: "task.diffstat.result", taskId: msg.taskId, sha: null, files: [], total: { files: 0, add: 0, del: 0 } }); break; }
        const root = ((ev!.payload as { root?: string }).root) ?? repoRoot();
 // 远端化:远程项目 checkpoint → diffstat 走远端 git --numstat
        {
          const cpEv = journal.readAll().filter((e) => e.kind === "checkpoint.create" && (e.payload as { taskId?: string }).taskId === msg.taskId).at(-1);
          const cpRemote = cpEv ? parseRemoteProject(String((cpEv.payload as { root?: string }).root ?? "")) : null;
          if (cpRemote) {
            const rg = await remoteGit(cpRemote, ["diff", "--numstat", sha]);
            const files2: { path: string; add: number; del: number }[] = [];
            let add = 0, del = 0;
            if (!("error" in rg)) {
              for (const line of rg.stdout.split("\n")) {
                const mm = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
                if (!mm) continue;
                const a2 = mm[1] === "-" ? 0 : Number(mm[1]);
                const d2 = mm[2] === "-" ? 0 : Number(mm[2]);
                files2.push({ path: mm[3]!, add: a2, del: d2 });
                add += a2; del += d2;
              }
            }
            safeSend(ws, { v: PROTOCOL_VERSION, type: "task.diffstat.result", taskId: msg.taskId, sha, files: files2, total: { files: files2.length, add, del } });
            break;
          }
        }
        safeSend(ws, { v: PROTOCOL_VERSION, type: "task.diffstat.result", taskId: msg.taskId, sha, ...(await svc.diffstat(root, sha)) });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "task.diffstat.result", taskId: msg.taskId, sha: null, files: [], total: { files: 0, add: 0, del: 0 }, error: String(err).slice(0, 150) });
      }
      break;
    }
    case "task.filediff": {
 // 单文件补丁( F1):变更条文件清单→右侧 diff 面板;快照 sha 语义与 diffstat 同源。
      try {
        const svc = await import("./git-service.js");
        const ev = journal.readAll().filter((e) => e.kind === "checkpoint.create" && (e.payload as { taskId?: string }).taskId === msg.taskId).at(-1);
        const sha = ev ? ((ev.payload as { sha?: string | null }).sha ?? null) : null;
        if (!sha) { safeSend(ws, { v: PROTOCOL_VERSION, type: "task.filediff.result", taskId: msg.taskId, file: msg.file, error: "该任务无快照" }); break; }
        const root = ((ev!.payload as { root?: string }).root) ?? repoRoot();
        const { diff, truncated } = await svc.fileDiff(root, sha, msg.file);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "task.filediff.result", taskId: msg.taskId, file: msg.file, diff, truncated });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "task.filediff.result", taskId: msg.taskId, file: msg.file, error: String(err).slice(0, 150) });
      }
      break;
    }
    case "models.probe": {
 // 模型探活( F4):逐项最小 chat 调用;未注入显式 not-implemented(不假做)。
      if (!opts.probeModel) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "探活未装配" }); break; }
      const r = await opts.probeModel(msg.model, msg.providerId);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "models.probe.result", model: msg.model, ...r });
      break;
    }
    case "stats.summary": {
 // 使用统计(ZCode UsageStatistics 对齐):journal 全量离线归约,无外部依赖。
      try {
        const budget = (opts.config as { quota?: { weeklyTokens?: number } } | undefined)?.quota?.weeklyTokens ?? 0;
 // usage=用量仪表盘:追加字段向后兼容,旧面板不读不受影响。
        safeSend(ws, {
          v: PROTOCOL_VERSION,
          type: "stats.summary.result",
          summary: computeStatsSummary(journal, opts.taskManager, 30, budget),
          usage: computeUsageDashboard(journal, 30),
        });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.StatsFailed, message: String(err).slice(0, 200) });
      }
      break;
    }
    case "automation.list": {
      if (!opts.automations) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "自动化未启用" }); break; }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "automation.list.result", automations: opts.automations.list() });
      break;
    }
    case "automation.create":
    case "automation.update": {
      if (!opts.automations) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "自动化未启用" }); break; }
      const r = msg.type === "automation.create"
        ? opts.automations.create({ name: msg.name, instruction: msg.instruction, everyMinutes: msg.everyMinutes, ...(msg.scope ? { scope: msg.scope } : {}) })
        : opts.automations.update(msg.id, msg);
      if ("error" in r) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.AutomationInvalid, message: r.error }); break; }
      opts.broadcast?.({ v: PROTOCOL_VERSION, type: "automation.list.result", automations: opts.automations.list() });
      break;
    }
    case "automation.delete": {
      if (!opts.automations) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "自动化未启用" }); break; }
      opts.automations.remove(msg.id);
      opts.broadcast?.({ v: PROTOCOL_VERSION, type: "automation.list.result", automations: opts.automations.list() });
      break;
    }
    case "automation.run": {
      if (!opts.automationScheduler) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "自动化未启用" }); break; }
      const sid = opts.automationScheduler.runNow(msg.id);
      if (!sid) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.UnknownAutomation, message: "自动化不存在" }); break; }
      opts.broadcast?.({ v: PROTOCOL_VERSION, type: "automation.list.result", automations: opts.automations!.list() });
      break;
    }
    case "ask.user.answer": {
      if (!opts.askUser) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "ask_user 未启用" }); break; }
      if (!opts.askUser.answer(msg.requestId, msg.answer)) safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.UnknownQuestion, message: "该问题已失效(超时或已答)" });
      break;
    }
    case "workflow.answer": {
      if (!opts.workflowAskRouter) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "workflow 直答未启用" }); break; }
      const ok = opts.workflowAskRouter.answer(msg.cacheKey, msg.value);
      if (!ok) safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.UnknownQuestion, message: `无等待中的问题 ${msg.cacheKey.slice(0, 12)}` });
      break;
    }
    case "files.search": {
      const { searchFiles } = await import("./file-index.js");
      const root = opts.projects?.resolveWorkdir(opts.projects.activeId()) ?? repoRoot();
      try {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "files.result", query: msg.query, files: searchFiles(root, msg.query) });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "files.result", query: msg.query, files: [] });
      }
      break;
    }
    case "session.search": {
 // 会话全文检索:懒建索引;失败 fail-soft 回空结果+error,面板不炸。
      const { getSessionSearchIndex } = await import("./session-search.js");
      try {
        const index = getSessionSearchIndex(journal);
        const result = index.discover(msg.query ?? "", { limit: Math.max(1, Math.min(30, msg.limit ?? 12)) });
        safeSend(ws, { v: PROTOCOL_VERSION, type: "session.search.result", query: msg.query ?? "", result });
      } catch (err) {
        safeSend(ws, {
          v: PROTOCOL_VERSION,
          type: "session.search.result",
          query: msg.query ?? "",
          result: { mode: "discover", query: msg.query ?? "", count: 0, results: [], error: String(err).slice(0, 200) },
        });
      }
      break;
    }
    case "file.read": {
 // 远程项目分流(ZCode remote workspace 语义):remote:ssh 项目的读文件走 SSH,
      // IDE/聊天预览/文件树复用既有消息(前端零改动)。窗口/全文/二进制形态与本地分支逐字节对齐。
      {
        const rp = opts.projects?.list().find((x) => x.id === (msg.projectId ?? opts.projects?.activeId()));
        const remote = rp ? parseRemoteProject(rp.path) : null;
        if (remote) {
          const r = await remoteRead(remote, msg.path);
          if ("error" in r) { safeSend(ws, { v: PROTOCOL_VERSION, type: "file.read.result", path: msg.path, startLine: 0, totalLines: 0, content: "", missing: true }); break; }
          if (r.binary) { safeSend(ws, { v: PROTOCOL_VERSION, type: "file.read.result", path: msg.path, startLine: 0, totalLines: 0, content: "", binary: true }); break; }
          const lines = r.content.split("\n");
          if (msg.full) {
            safeSend(ws, { v: PROTOCOL_VERSION, type: "file.read.result", path: msg.path, startLine: 1, totalLines: lines.length, content: r.content });
          } else {
            const target = Math.min(Math.max(1, msg.line ?? 1), lines.length);
            const start = Math.max(1, target - 20);
            const end = Math.min(lines.length, target + 20);
            safeSend(ws, { v: PROTOCOL_VERSION, type: "file.read.result", path: msg.path, startLine: start, totalLines: lines.length, content: lines.slice(start - 1, end).join("\n") });
          }
          break;
        }
      }
      const { realpathSync } = await import("node:fs");
 // 解析根优先用帧里的 projectId(IDE 树按桶打开),缺省回退活动项目——
 // 二者不一致时读错根会直接 missing(经验证:树是 vis-proj、active 是别的项目 → 编辑区空白)。
      // 回退检测(同 file.write:目录被移走后读 harness 同名文件=误导)
      {
        const rr = (msg.projectId ? opts.projects?.resolveWorkdir(msg.projectId) : undefined) ?? opts.projects?.resolveWorkdir(opts.projects.activeId()) ?? repoRoot();
        const blk = projectRootFallbackGuard(opts.projects, msg.projectId, rr, repoRoot());
        if (blk) { safeSend(ws, { v: PROTOCOL_VERSION, type: "file.read.result", path: msg.path, startLine: 0, totalLines: 0, content: "", missing: true, unavailable: true }); break; }
      }
 // 显式 projectId 的项目不可用 → 明确不可用标记(不回退读 harness 同名文件误导)
      {
        const wp = msg.projectId ? opts.projects?.list().find((x) => x.id === msg.projectId) : undefined;
        if (wp && wp.availability !== "available") {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "file.read.result", path: msg.path, startLine: 0, totalLines: 0, content: "", missing: true, unavailable: true });
          break;
        }
      }
      const root = (msg.projectId ? opts.projects?.resolveWorkdir(msg.projectId) : undefined)
        ?? opts.projects?.resolveWorkdir(opts.projects.activeId()) ?? repoRoot();
      try {
        const abs = realpathSync(join(root, msg.path));
        const absRoot = realpathSync(root);
        if (!isPathInside(absRoot, abs)) throw new Error("路径越界(仅项目内可读)");
        const { readFileSync } = await import("node:fs");
        if (msg.full) {
 // IDE 全文读:>2MB 回 tooLarge 标记、首 8KB 含 NUL 判二进制回 binary 标记
          //(两者都不回全文,防响应放大);文本回 startLine=1 + 全文。缺省分支逐字节保持旧窗口语义。
          const { statSync, openSync, readSync, closeSync } = await import("node:fs");
          const size = statSync(abs).size;
          if (size > 2 * 1024 * 1024) {
            safeSend(ws, { v: PROTOCOL_VERSION, type: "file.read.result", path: msg.path, startLine: 0, totalLines: 0, content: "", tooLarge: true });
            break;
          }
          const fd = openSync(abs, "r");
          const head = Buffer.alloc(Math.min(size, 8192));
          try { readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
          if (head.includes(0)) {
            safeSend(ws, { v: PROTOCOL_VERSION, type: "file.read.result", path: msg.path, startLine: 0, totalLines: 0, content: "", binary: true });
            break;
          }
          const text = readFileSync(abs, "utf-8");
          safeSend(ws, {
            v: PROTOCOL_VERSION, type: "file.read.result", path: msg.path,
            startLine: 1, totalLines: text.split("\n").length, content: text,
          });
          break;
        }
        const lines = readFileSync(abs, "utf-8").split("\n");
        const target = Math.min(Math.max(1, msg.line ?? 1), lines.length);
        const start = Math.max(1, target - 20);
        const end = Math.min(lines.length, target + 20);
        safeSend(ws, {
          v: PROTOCOL_VERSION, type: "file.read.result", path: msg.path,
          startLine: start, totalLines: lines.length, content: lines.slice(start - 1, end).join("\n"),
        });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "file.read.result", path: msg.path, startLine: 0, totalLines: 0, content: "", missing: true });
        void err;
      }
      break;
    }
    case "file.write": {
 // 远程项目分流:写走 SSH(自动建父目录+回读校验);失败回 FileWriteDenied 帧。
      {
        const rp = opts.projects?.list().find((x) => x.id === (msg.projectId ?? opts.projects?.activeId()));
        const remote = rp ? parseRemoteProject(rp.path) : null;
        if (remote) {
          const r = await remoteWrite(remote, msg.path, msg.content);
          if ("error" in r) safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.FileWriteDenied, message: "远程写入失败:" + r.error });
          else safeSend(ws, { v: PROTOCOL_VERSION, type: "file.write.result", path: msg.path, ok: true, bytes: r.bytes });
          break;
        }
      }
 // 回退检测(注意:目录被移走后 availability 未重检,resolveWorkdir 回落 harness,写透传污染根目录)
      {
        const wr = (msg.projectId ? opts.projects?.resolveWorkdir(msg.projectId) : undefined) ?? opts.projects?.resolveWorkdir(opts.projects.activeId()) ?? repoRoot();
        const blk = projectRootFallbackGuard(opts.projects, msg.projectId, wr, repoRoot());
        if (blk) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.FileWriteDenied, message: blk }); break; }
      }
 // (ZCode isWorkspaceReadOnly 语义):显式 projectId 的项目不可用时**拒写**——
      // 旧实现 resolveWorkdir 静默回退 harness 根,用户以为在编辑该项目、实际写进了 harness(危险)。
      {
        const wp = msg.projectId ? opts.projects?.list().find((x) => x.id === msg.projectId) : undefined;
        if (wp && wp.availability !== "available") {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.FileWriteDenied, message: "项目目录暂不可访问(" + wp.label + "):已开启只读保护。恢复目录或重新添加项目后再试" });
          break;
        }
      }
 // IDE 保存链:UTF-8 全文覆盖写(允许新建文件,父目录须已存在)。
      // 沙箱与 file.read 同强度(realpath 前缀比对,symlink 先解析防逃逸:父目录与已存在目标
      // 都做 realpath 再校验);另拒 .git/ 任一路径段与 >512KB。首版无锁、不做多写者冲突检测。
      const { realpathSync, writeFileSync, statSync, existsSync } = await import("node:fs");
      const { normalize, dirname, basename, isAbsolute } = await import("node:path");
 // 同 file.read——写根优先用帧内 projectId(IDE 树桶项目),缺省回退活动项目。
      const root = (msg.projectId ? opts.projects?.resolveWorkdir(msg.projectId) : undefined)
        ?? opts.projects?.resolveWorkdir(opts.projects.activeId()) ?? repoRoot();
      const deny = (reason: string) =>
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.FileWriteDenied, message: reason });
      try {
        const absRoot = realpathSync(root);
        const norm = normalize(msg.path).replace(/\\/g, "/");
        if (norm.startsWith("../") || norm === ".." || isAbsolute(msg.path)) throw new Error("路径越界(仅项目内可写)");
        if (norm.split("/").includes(".git")) throw new Error(".git 受保护,拒绝写入");
        const bytes = Buffer.byteLength(msg.content, "utf8");
        if (bytes > 512 * 1024) throw new Error("内容过大(>512KB),拒绝写入");
        const parentDir = dirname(join(absRoot, norm));
        const realParent = realpathSync(parentDir); // 父目录不存在/断链 → 抛错,不隐式建目录
        if (!isPathInside(absRoot, realParent)) throw new Error("路径越界(仅项目内可写)");
        const target = join(realParent, basename(norm));
        if (existsSync(target)) {
          if (!statSync(target).isFile()) throw new Error("目标不是普通文件");
          const realTarget = realpathSync(target); // 末段 symlink 出仓在此拦下
          if (!isPathInside(absRoot, realTarget)) throw new Error("路径越界(仅项目内可写)");
        }
        writeFileSync(target, msg.content, "utf8");
        safeSend(ws, { v: PROTOCOL_VERSION, type: "file.write.result", path: msg.path, ok: true, bytes });
      } catch (err) {
        deny(String(err).replace(/^Error:\s*/, "").slice(0, 200));
      }
      break;
    }
    case "ide.office.edit": {
 // 板「OOXML 文本回写」P2:Office 文本级编辑(服务端处理路径——浏览器不发 zip 字节,
      // 只发「哪一段换成什么文本」)。沙箱口径与 file.write 同强度;pptx/docx 是二进制,
      // 故不走 file.write(UTF-8 + 512KB 会写坏)。远程项目明确不支持(V1)。
      const reply = (ok: boolean, extra: { bytes?: number; error?: string }) =>
        safeSend(ws, { v: PROTOCOL_VERSION, type: "ide.office.edit.result", path: msg.path, ok, ...extra });
      {
        const rp = opts.projects?.list().find((x) => x.id === (msg.pid ?? opts.projects?.activeId()));
        if (rp && parseRemoteProject(rp.path)) { reply(false, { error: "远程项目暂不支持 Office 文本回写" }); break; }
      }
      {
        const wr = (msg.pid ? opts.projects?.resolveWorkdir(msg.pid) : undefined) ?? opts.projects?.resolveWorkdir(opts.projects.activeId()) ?? repoRoot();
        const blk = projectRootFallbackGuard(opts.projects, msg.pid, wr, repoRoot());
        if (blk) { reply(false, { error: blk }); break; }
      }
      {
        const wp = msg.pid ? opts.projects?.list().find((x) => x.id === msg.pid) : undefined;
        if (wp && wp.availability !== "available") { reply(false, { error: "项目目录暂不可访问(" + wp.label + "):已开启只读保护" }); break; }
      }
      const { realpathSync, writeFileSync, statSync, readFileSync, existsSync } = await import("node:fs");
      const { normalize, dirname, basename, isAbsolute, extname } = await import("node:path");
      const root = (msg.pid ? opts.projects?.resolveWorkdir(msg.pid) : undefined)
        ?? opts.projects?.resolveWorkdir(opts.projects.activeId()) ?? repoRoot();
      try {
        const ext = extname(msg.path).toLowerCase();
        if (ext !== ".pptx" && ext !== ".docx") throw new Error("仅 .pptx/.docx 支持文本回写");
        const absRoot = realpathSync(root);
        const norm = normalize(msg.path).replace(/\\/g, "/");
        if (norm.startsWith("../") || norm === ".." || isAbsolute(msg.path)) throw new Error("路径越界(仅项目内可写)");
        if (norm.split("/").includes(".git")) throw new Error(".git 受保护,拒绝写入");
        const parentDir = dirname(join(absRoot, norm));
        const realParent = realpathSync(parentDir);
        if (!isPathInside(absRoot, realParent)) throw new Error("路径越界(仅项目内可写)");
        const target = join(realParent, basename(norm));
        if (!existsSync(target)) throw new Error("文件不存在");
        if (!statSync(target).isFile()) throw new Error("目标不是普通文件");
        const realTarget = realpathSync(target);
        if (!isPathInside(absRoot, realTarget)) throw new Error("路径越界(仅项目内可写)");
        const cur = readFileSync(target);
        if (cur.length > OFFICE_MAX_BYTES) throw new Error("文件过大(>" + Math.round(OFFICE_MAX_BYTES / (1024 * 1024)) + "MB),不支持文本回写");
        const next = await rewriteOfficeText(cur, ext as ".pptx" | ".docx", msg.edits as OfficeTextEdit[]);
        if (next.length > OFFICE_MAX_BYTES) throw new Error("回写结果过大(>" + Math.round(OFFICE_MAX_BYTES / (1024 * 1024)) + "MB),已放弃(未落盘)");
        writeFileSync(target, next); // 二进制落盘
        reply(true, { bytes: next.length });
      } catch (err) {
        reply(false, { error: String(err).replace(/^Error:\s*/, "").slice(0, 300) });
      }
      break;
    }
    case "git.status":
    case "git.diff":
    case "git.branches":
    case "git.checkout":
    case "git.commit":
    case "git.log":
    case "git.push":
    case "git.pull": {
 // 远程项目(SSH/WSL:Git 面板全操作走远端工作区服务(通道 git op / 远端 git),
      // 不再落 harness 根(此前远程项目的 Git 页是错的根)。
      {
        const gitProj = opts.projects?.list().find((p) => p.id === opts.projects?.activeId());
        const gitRemote = gitProj ? parseRemoteProject(gitProj.path) : null;
        if (gitRemote) {
          const svcR = await import("./git-service.js");
          const callGit = async (args: string[]): Promise<{ stdout: string; exit: number }> => {
            const r = await remoteGit(gitRemote, args);
            if ("error" in r) throw new Error(r.error);
            return r;
          };
          const runGit = async (args: string[]): Promise<string> => (await callGit(args)).stdout;
          try {
            const rev = await remoteGit(gitRemote, ["rev-parse", "--is-inside-work-tree"]).catch(() => null);
            const isRepo = !!rev && !("error" in rev) && String(rev.stdout).trim() === "true";
            if (!isRepo) {
              if (msg.type === "git.status") safeSend(ws, { v: PROTOCOL_VERSION, type: "git.status.result", branch: "", changes: [], norepo: true });
              else if (msg.type === "git.diff") safeSend(ws, { v: PROTOCOL_VERSION, type: "git.diff.result", file: msg.file, patch: "" });
              else if (msg.type === "git.log") safeSend(ws, { v: PROTOCOL_VERSION, type: "git.log.result", commits: [] });
              else if (msg.type === "git.branches") safeSend(ws, { v: PROTOCOL_VERSION, type: "git.branches.result", current: "", branches: [], norepo: true });
              else safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.GitNorepo, message: "当前目录不是 git 仓库,已跳过 git 操作" });
              break;
            }
            if (msg.type === "git.status") {
              safeSend(ws, { v: PROTOCOL_VERSION, type: "git.status.result", ...svcR.parseGitStatusPorcelain(await runGit(["status", "--porcelain", "-b"])) });
            } else if (msg.type === "git.diff") {
              let patch = "";
              for (const args of [["diff", "HEAD", "--", msg.file], ["diff", "--", msg.file], ["diff", "--cached", "--", msg.file]]) {
                try { patch = await runGit(args as string[]); } catch { patch = ""; }
                if (patch.trim()) break;
              }
              if (!patch.trim()) {
                const untracked = await remoteGit(gitRemote, ["diff", "--no-index", "--", "/dev/null", msg.file]).catch(() => null);
                if (untracked && !("error" in untracked)) patch = untracked.stdout;
              }
              safeSend(ws, { v: PROTOCOL_VERSION, type: "git.diff.result", file: msg.file, patch });
            } else if (msg.type === "git.log") {
              safeSend(ws, { v: PROTOCOL_VERSION, type: "git.log.result", commits: svcR.parseGitLog(await runGit(["log", "-n", String(msg.limit ?? 50), "--format=%h%x09%an%x09%ar%x09%s"])) });
            } else if (msg.type === "git.branches") {
              safeSend(ws, { v: PROTOCOL_VERSION, type: "git.branches.result", ...svcR.parseGitBranches(await runGit(["branch", "--format", "%(HEAD)%(refname:short)"])) });
            } else if (msg.type === "git.checkout") {
              await runGit(["checkout", msg.branch]);
              safeSend(ws, { v: PROTOCOL_VERSION, type: "git.ok", op: "checkout", detail: `已切换到 ${msg.branch}` });
            } else if (msg.type === "git.push") {
              const remoteName = msg.remote ?? "origin";
              const branch = msg.branch ?? (await runGit(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
              await runGit(["push", "-u", remoteName, branch]);
              safeSend(ws, { v: PROTOCOL_VERSION, type: "git.ok", op: "push", detail: `已推送 ${branch} → ${remoteName}` });
            } else if (msg.type === "git.pull") {
              const args = msg.remote && msg.branch ? ["pull", msg.remote, msg.branch] : msg.remote ? ["pull", msg.remote] : ["pull"];
              await runGit(args);
              const head = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
              safeSend(ws, { v: PROTOCOL_VERSION, type: "git.ok", op: "pull", detail: `已拉取 → ${head}` });
            } else {
              const ident = ["-c", "user.email=panel@lampgenie.local", "-c", "user.name=genie-panel"];
              if (msg.files && msg.files.length > 0) await runGit(["add", ...msg.files]);
              else await runGit(["add", "-A"]);
              await runGit([...ident, "commit", "-m", msg.message]);
              const last = await runGit(["log", "-1", "--format=%h %s"]);
              safeSend(ws, { v: PROTOCOL_VERSION, type: "git.ok", op: "commit", detail: last.trim() });
            }
          } catch (err) {
            safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.GitFailed, message: String(err).slice(0, 300) });
          }
          break;
        }
      }
      const svc = await import("./git-service.js");
      const cwd = opts.projects?.resolveWorkdir(opts.projects.activeId()) ?? repoRoot();
 // 非 git 目录:
      // 读类降级空结果+norepo 标记(面板免报错);写类明确跳过提示。
      if (!(await svc.isGitRepo(cwd))) {
        if (msg.type === "git.status") {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "git.status.result", branch: "", changes: [], norepo: true });
        } else if (msg.type === "git.diff") {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "git.diff.result", file: msg.file, patch: "" });
        } else if (msg.type === "git.log") {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "git.log.result", commits: [] });
        } else if (msg.type === "git.branches") {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "git.branches.result", current: "", branches: [], norepo: true });
        } else {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.GitNorepo, message: "当前目录不是 git 仓库,已跳过 git 操作" });
        }
        break;
      }
      try {
        if (msg.type === "git.status") {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "git.status.result", ...(await svc.gitStatus(cwd)) });
        } else if (msg.type === "git.diff") {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "git.diff.result", file: msg.file, patch: await svc.gitDiff(cwd, msg.file) });
        } else if (msg.type === "git.log") {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "git.log.result", commits: await svc.gitLog(cwd, msg.limit ?? 50) });
        } else if (msg.type === "git.branches") {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "git.branches.result", ...(await svc.gitBranches(cwd)) });
        } else if (msg.type === "git.checkout") {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "git.ok", op: "checkout", detail: await svc.gitCheckout(cwd, msg.branch) });
        } else if (msg.type === "git.push") {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "git.ok", op: "push", detail: await svc.gitPush(cwd, { remote: msg.remote, branch: msg.branch }) });
        } else if (msg.type === "git.pull") {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "git.ok", op: "pull", detail: await svc.gitPull(cwd, { remote: msg.remote, branch: msg.branch }) });
        } else {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "git.ok", op: "commit", detail: await svc.gitCommit(cwd, msg.message, msg.files) });
        }
      } catch (err) {
        // git-service 的错误已是归一文本(gitErrorText);这里只剥掉 Error: 前缀,
        // 别再让面板 toast 显示无信息的「Command failed: git status --porcelain -b」。
        const text = err instanceof Error ? err.message : String(err);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.GitFailed, message: text.slice(0, 300) });
      }
      break;
    }
    case "ssh.key.import": {
      // 私钥文件导入(SSH config IdentityFile → secrets 精确键;600 权限,内容不回显)
      const { readFileSync } = await import("node:fs");
      const kp = String(msg.path ?? "");
      try {
        const keyText = readFileSync(kp, "utf-8");
        if (!keyText.includes("PRIVATE KEY")) throw new Error("文件不像私钥(未找到 PRIVATE KEY 块)");
        const H = String(msg.host).toUpperCase().replace(/[^A-Z0-9]/g, "_");
        const U = String(msg.user).toUpperCase().replace(/[^A-Z0-9]/g, "_");
        const name = `GENIE_SSHKEY_${H}_${U}`;
        if (!opts.cfg?.secretSet) throw new Error("密钥写入未启用");
        opts.cfg.secretSet(name, keyText);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "ssh.key.import.result", ok: true, name });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "ssh.key.import.result", ok: false, error: String(err).slice(0, 160) });
      }
      break;
    }
    case "ssh.config.list": {
 // SSH config 导入源(对齐 ZCode 新建连接):解析 ~/.ssh/config 具体条目
      const cfg = loadSshConfigEntries();
      safeSend(ws, { v: PROTOCOL_VERSION, type: "ssh.config.list.result", path: cfg.path, entries: cfg.entries });
      break;
    }
    case "ssh.test": {
      // SSH 连通测试(ZCode 连接表单「测试连接」对齐;凭证=secrets/env,密码不经 WS)
      const t0 = Date.now();
      const sshRef = { kind: "ssh" as const, host: String(msg.host).toLowerCase(), port: Number(msg.port ?? 22), username: String(msg.username), workspacePath: "/", identity: "" };
      const r = await sshRun(sshRef, "echo ok; echo $HOME", { timeoutMs: 15_000 });
      const home = r.ok ? (r.stdout.trim().split("\n").pop() ?? "").trim() : "";
      const base = {
        v: PROTOCOL_VERSION, type: "ssh.test.result",
        ok: r.ok, latencyMs: Date.now() - t0,
        ...(r.ok && home.startsWith("/") ? { home } : {}),
        ...(r.ok ? {} : { error: r.error ?? "连接失败" }),
      };
 // 连接向导:连通后安装/校验工作区服务(根 "/" 供目录浏览),再回 ok——
      // 「连接 → 装 server → 验证 → 经 server 浏览目录 → 选目录加项目」与 WSL 同一套。
      if (!r.ok || msg.ensureServer !== true) { safeSend(ws, base); break; }
      const conn = parseRemoteProject(buildRemoteSshIdentity(sshRef.host, sshRef.port, sshRef.username, "/"));
      const dep = await deployRemoteWorkspaceAgent(conn!);
      if ("error" in dep) { safeSend(ws, { ...base, ok: false, connected: true, error: "已连接,但工作区服务安装失败:" + dep.error }); break; }
      const ping = await tryChannelJson(conn!, "ping", {});
      if (!ping || !ping.ok) { safeSend(ws, { ...base, ok: false, connected: true, error: "工作区服务已安装但未响应(" + String((ping as { error?: string } | null)?.error ?? "无响应") + ")" }); break; }
      const pdata = (ping.data ?? {}) as { version?: unknown; node?: unknown };
      const sense = await deployRemoteSense(conn!);
      if ("error" in sense) {
        safeSend(ws, { ...base, ok: false, connected: true, server: String(pdata.version ?? dep.version), node: String(pdata.node ?? ""), error: "工作区服务已就绪,但代码认知组件安装失败:" + sense.error });
        break;
      }
      safeSend(ws, { ...base, server: String(pdata.version ?? dep.version), node: String(pdata.node ?? ""), sense: sense.version });
      break;
    }
    case "wsl.list": {
      // 连接向导 · 发行版枚举(Windows 桌面端;非 Windows 返回空并标平台)
      const { listWslDistros, wslHome } = await import("./wsl.js");
      const distros = await listWslDistros();
      const rows: { name: string; home: string | null }[] = [];
      for (const d of distros) rows.push({ name: d, home: await wslHome(d) });
      safeSend(ws, { v: PROTOCOL_VERSION, type: "wsl.list.result", platform: process.platform, distros: rows });
      break;
    }
    case "wsl.test": {
      // 连接向导 · WSL:①发行版可达 → ②安装工作区服务 → ③ping 验证(任一步失败=ok:false)
      if (process.platform !== "win32") { safeSend(ws, { v: PROTOCOL_VERSION, type: "wsl.test.result", ok: false, error: "WSL 连接仅 Windows 桌面端可用" }); break; }
      const { listWslDistros, wslHome } = await import("./wsl.js");
      const distro = String(msg.distro ?? "").trim();
      const distros = await listWslDistros();
      if (!distro || !distros.includes(distro)) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "wsl.test.result", ok: false, distro, error: "WSL 发行版不存在(" + (distro || "空") + ");检查 wsl -l -v" });
        break;
      }
      const home = (await wslHome(distro)) ?? "/";
      let conn: ReturnType<typeof parseRemoteProject> = null;
      try { conn = parseRemoteProject(buildRemoteWslIdentity(distro, "/")); } catch (e) { safeSend(ws, { v: PROTOCOL_VERSION, type: "wsl.test.result", ok: false, distro, error: String(e) }); break; }
      const dep = await deployRemoteWorkspaceAgent(conn!);
      if ("error" in dep) { safeSend(ws, { v: PROTOCOL_VERSION, type: "wsl.test.result", ok: false, distro, home, connected: true, error: "已连接,但工作区服务安装失败:" + dep.error }); break; }
      const ping = await tryChannelJson(conn!, "ping", {});
      if (!ping || !ping.ok) { safeSend(ws, { v: PROTOCOL_VERSION, type: "wsl.test.result", ok: false, distro, home, connected: true, error: "工作区服务已安装但未响应(" + String((ping as { error?: string } | null)?.error ?? "无响应") + ")" }); break; }
      const pdata = (ping.data ?? {}) as { version?: unknown; node?: unknown };
      const sense = await deployRemoteSense(conn!);
      if ("error" in sense) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "wsl.test.result", ok: false, distro, home, connected: true, server: String(pdata.version ?? dep.version), node: String(pdata.node ?? ""), error: "工作区服务已就绪,但代码认知组件安装失败:" + sense.error });
        break;
      }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "wsl.test.result", ok: true, distro, home, server: String(pdata.version ?? dep.version), node: String(pdata.node ?? ""), sense: sense.version });
      break;
    }
    case "wsl.browse": {
      // 连接向导 · 经工作区服务浏览发行版目录(根 "/" 通道;路径绝对 POSIX)
      if (process.platform !== "win32") { safeSend(ws, { v: PROTOCOL_VERSION, type: "wsl.browse.result", distro: String(msg.distro ?? ""), path: String(msg.path ?? "/"), error: "WSL 连接仅 Windows 桌面端可用" }); break; }
      let conn: ReturnType<typeof parseRemoteProject> = null;
      try { conn = parseRemoteProject(buildRemoteWslIdentity(String(msg.distro ?? ""), "/")); } catch (e) { safeSend(ws, { v: PROTOCOL_VERSION, type: "wsl.browse.result", distro: String(msg.distro ?? ""), path: String(msg.path ?? "/"), error: String(e) }); break; }
      const p = String(msg.path ?? "/") || "/";
      const r = await remoteLs(conn!, p.replace(/^\/+/, "") || ".");
      if ("error" in r) safeSend(ws, { v: PROTOCOL_VERSION, type: "wsl.browse.result", distro: String(msg.distro ?? ""), path: p, error: r.error });
      else safeSend(ws, { v: PROTOCOL_VERSION, type: "wsl.browse.result", distro: String(msg.distro ?? ""), path: p, parent: posixParentOf(p), entries: r.entries, ...(r.truncated ? { truncated: true } : {}) });
      break;
    }
    case "ssh.browse": {
      // 连接向导 · 经工作区服务浏览 SSH 主机目录(根 "/" 通道)
      const host = String(msg.host ?? "").toLowerCase();
      const port = Number(msg.port ?? 22);
      const username = String(msg.username ?? "");
      let conn: ReturnType<typeof parseRemoteProject> = null;
      try { conn = parseRemoteProject(buildRemoteSshIdentity(host, port, username, "/")); } catch (e) { safeSend(ws, { v: PROTOCOL_VERSION, type: "ssh.browse.result", host, path: String(msg.path ?? "/"), error: String(e) }); break; }
      const p = String(msg.path ?? "/") || "/";
      const r = await remoteLs(conn!, p.replace(/^\/+/, "") || ".");
      if ("error" in r) safeSend(ws, { v: PROTOCOL_VERSION, type: "ssh.browse.result", host, path: p, error: r.error });
      else safeSend(ws, { v: PROTOCOL_VERSION, type: "ssh.browse.result", host, path: p, parent: posixParentOf(p), entries: r.entries, ...(r.truncated ? { truncated: true } : {}) });
      break;
    }
    case "remote.ls": {
      if (!opts.projects) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "项目注册表未启用" }); break; }
      const proj = opts.projects.list().find((p) => p.id === msg.projectId);
      const remote = proj ? parseRemoteProject(proj.path) : null;
      if (!remote) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.RemoteOpFailed, message: "项目不存在或不是远程项目(SSH/WSL)" }); break; }
      const r = await remoteLs(remote, msg.path ?? "");
      if ("error" in r) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.RemoteOpFailed, message: r.error }); break; }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "remote.ls.result", projectId: msg.projectId, path: msg.path ?? "", entries: r.entries, ...(r.truncated ? { truncated: true } : {}) });
      break;
    }
    case "remote.deploy": {
      if (!opts.projects) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "项目注册表未启用" }); break; }
      const proj = opts.projects.list().find((p) => p.id === msg.projectId);
      const remote = proj ? parseRemoteProject(proj.path) : null;
      if (!remote) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.RemoteOpFailed, message: "项目不存在或不是远程项目(SSH/WSL)" }); break; }
 // 部署 agent-stdio(远端 workspace 服务,持久管道用)+ 保留 shim(回退层)
 // 同时安装远端代码认知/评审运行时(code_sense/code_review 在远端执行)
      const dep = await deployRemoteWorkspaceAgent(remote);
      const sense = await deployRemoteSense(remote);
      if ("error" in dep) {
        // agent-stdio 部署失败(如无 node):回退部署 shim
        const dep2 = await deployRemoteWorkspace(remote);
        if ("error" in dep2) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.RemoteOpFailed, message: "远端服务部署失败:" + dep.error }); break; }
        safeSend(ws, {
          v: PROTOCOL_VERSION, type: "remote.deploy.result", projectId: msg.projectId, ok: true, version: dep2.version, node: "shim",
          ...(("version" in sense) ? { sense: sense.version } : { senseError: sense.error }),
        });
        break;
      }
      safeSend(ws, {
        v: PROTOCOL_VERSION, type: "remote.deploy.result", projectId: msg.projectId, ok: true, version: dep.version, node: "agent-stdio",
        ...(("version" in sense) ? { sense: sense.version } : { senseError: sense.error }),
      });
      break;
    }
    case "remote.read": {
      if (!opts.projects) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "项目注册表未启用" }); break; }
      const proj = opts.projects.list().find((p) => p.id === msg.projectId);
      const remote = proj ? parseRemoteProject(proj.path) : null;
      if (!remote) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.RemoteOpFailed, message: "项目不存在或不是远程项目(SSH/WSL)" }); break; }
      const r = await remoteRead(remote, msg.path);
      if ("error" in r) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.RemoteOpFailed, message: r.error }); break; }
      if (r.binary) { safeSend(ws, { v: PROTOCOL_VERSION, type: "remote.read.result", projectId: msg.projectId, path: msg.path, binary: true, bytes: r.bytes }); break; }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "remote.read.result", projectId: msg.projectId, path: msg.path, content: r.content, bytes: r.bytes, ...(r.truncated ? { truncated: true } : {}) });
      break;
    }
    case "project.add": {
      console.error("[projects.audit] add 入口 path=" + String(msg.path ?? "").slice(0, 60) + " conn=" + String((ws as { connSeq?: number }).connSeq ?? "?"));
      if (!opts.projects) { console.error("[projects.audit] add 失败:注册表未启用"); safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "项目注册表未启用" }); break; }
 // 提交前先做路径可达性/非空校验(不全部依赖 Projects.add 内部 reason;
      // 原因分类回给面板,即时回显;校验语义与 projects.ts add() 一致:绝对路径+存在+是目录)。
      // 远程目录(remote:ssh:... / remote:wsl:...,ZCode remote workspace identity 对齐):跳过本地可达性校验,
      // 注册后异步探测刷新 availability(探测失败不拒收——可达性由节点心跳/分派守卫负责)。
      let addPath = String(msg.path ?? "");
      {
        const raw = String(msg.path ?? "");
        const fail = (reason: string): void => { console.error("[projects.audit] add 拒:" + reason); safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.ProjectAddFailed, message: reason }); };
        if (!raw.trim()) { fail("路径为空"); break; }
 // WSL 目录(UNC)→ remote:wsl identity(与 SSH 同构的远端工作区):
        // 添加后文件/命令/git 全走发行版内的工作区服务(agent-stdio),不再按本地 UNC 路径操作。
        const wslRemote = remoteWslFromUncPath(raw);
        addPath = wslRemote ? wslRemote.identity : raw;
        const remote = parseRemoteProject(addPath);
        if (!remote) {
          if (!isAbsolute(raw)) { fail("路径不可达:必须是绝对路径(收到 “" + raw.slice(0, 80) + "”)"); break; }
          try {
            const fs = await import("node:fs");
            if (!fs.existsSync(raw)) { fail("路径不可达:目录不存在(" + raw + ")"); break; }
            if (!fs.statSync(fs.realpathSync(raw)).isDirectory()) { fail("路径不可达:不是目录(项目=文件夹)"); break; }
          } catch {
            fail("路径不可达:无法解析(" + raw + ")"); break;
          }
        } else {
          // 异步 SSH 探测(密码经 GENIE_SSH_PASSWORD env 进 sshpass;不阻塞添加回执)。
          const t = setTimeout(() => {
            void probeRemoteProject(remote).then((ok) => {
              const entry = opts.projects!.list().find((p) => p.path === remote.identity);
              if (!entry) return;
              const target = ok ? "available" : "unavailable-remote-unreachable";
              if (entry.availability !== target) {
                entry.availability = target;
                opts.projects!.flush();
                opts.broadcast?.(projectListMessage(opts.projects!));
              }
            }).catch(() => { /* 探测失败保持 unverified */ });
          }, 1_200);
          t.unref?.();
 // WSL 项目(「像 SSH 一样在 WSL 里装 server」):添加后自动把工作区服务部署到
          // 发行版 ~/.genie/agent-stdio.mjs(node 缺失会失败并回退 shell;面板「优化远程连接」可重试)。
          if (remote.kind === "wsl") {
            const t2 = setTimeout(() => {
              void deployRemoteWorkspaceAgent(remote).then(async (dep) => {
                if ("error" in dep) { console.error("[wsl] 工作区服务部署失败:" + dep.error); return; }
                console.log("[wsl] 工作区服务已部署:" + dep.remotePath + " (" + dep.version + ")");
                const sense = await deployRemoteSense(remote);
                if ("error" in sense) console.error("[wsl] 代码认知组件安装失败:" + sense.error);
                else console.log("[wsl] 代码认知组件已安装:" + sense.version);
              }).catch((err) => console.error("[wsl] 工作区服务部署异常:" + String(err)));
            }, 2_500);
            t2.unref?.();
          }
        }
      }
      const r = opts.projects!.add(addPath);
      if (!r.ok) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.ProjectAddFailed, message: r.reason });
        break;
      }
 // (ZCode 语义「打开文件夹=打开该 workspace」):添加成功(含幂等命中已有)后
      // 自动激活该工作区——此前添加完 active 不变,用户看不到"打开"效果(「添加了没反应」观感来源之一);
      // 幂等命中已有项目同样切过去(ZCode 打开已存在 workspace=切到该 tab)。
      opts.projects!.activate(r.project.id);
      try { journal.append({ kind: "custom", sessionId: "system", payload: { type: "project.add", path: addPath, id: (r as { project?: { id?: string } }).project?.id ?? "", conn: (ws as { connSeq?: number }).connSeq } }); } catch { /* 观测落账失败不影响 */ }
      opts.broadcast?.(projectListMessage(opts.projects));
 // 项目添加即异步建档案(进度广播;不阻塞添加返回)。
 // :建档是重活(全仓 ts-morph;9p 慢盘分钟级),后置 5s 让添加回执/
      // 项目清单广播/面板 UI 先走完;unref=进程退出不等它。
      // 远程项目(SSH/WSL)不建档案:档案管线是本地文件扫描(ts-morph/全仓),identity 不是本地目录
 // (远程项目的工程画像后续可由工作区服务提供)。
      if (opts.profiles && r.ok && !parseRemoteProject(String((r as { project?: { path?: string } }).project?.path ?? ""))) {
        const pid = (r as { project?: { id?: string } }).project?.id ?? "";
        const t = setTimeout(() => { try { void opts.profiles!.getOrStart(pid); } catch { /* 容忍 */ } }, 5_000);
        t.unref?.();
      }
 // 团队绑定实时种子:新项目有 origin 就进 roster(开机种子之外的运行期补种);
      // 后置 2s 让添加回执先走;内嵌 relay 不在场(外部 relay/未启用)=零动作。
      {
        const emb = (globalThis as { __teamRelayEmbedded?: EmbeddedTeamHandle | null }).__teamRelayEmbedded;
        if (emb) {
          const t = setTimeout(() => {
            void seedRegistryProjects(emb, opts.projects!.list().filter((p: { id: string }) => p.id === (r as { project?: { id?: string } }).project?.id))
              .then((wrote) => { if (wrote.length > 0) console.log(`[team-embedded] project.add 绑定种子 ${wrote.length} 项`); })
              .catch(() => { /* 种子失败不影响项目添加 */ });
          }, 2_000);
          t.unref?.();
        }
      }
      break;
    }
    case "project.remove": {
      if (!opts.projects) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "项目注册表未启用" }); break; }
      const r = opts.projects.remove(msg.projectId);
      if (!r.ok) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.ProjectRemoveFailed, message: r.reason });
        break;
      }
      try { journal.append({ kind: "custom", sessionId: "system", payload: { type: "project.remove", projectId: msg.projectId, conn: (ws as { connSeq?: number }).connSeq } }); } catch { /* 观测落账失败不影响 */ }
 // 关联引用同步清理(「已移除项目」残留根治;companion project_remove 同源):
      // ①任务登记清 projectId(会话保留,侧栏落「任务」分区;运行中任务 workdir 经 resolveWorkdir 回退 harness,语义不变);
      const cleared = cleanupProjectTaskRefs(journal, (pid) => tm.clearProjectRef(pid), [msg.projectId]);
      // ②项目档案产物同步清除(.genie/profiles/<pid>.json 不再遗留)。
      opts.profiles?.purge?.(msg.projectId);
      opts.broadcast?.(projectListMessage(opts.projects));
      if (cleared.length) opts.broadcast?.({ v: PROTOCOL_VERSION, type: "task.list", tasks: taskIndexList(tm.list()) });
      break;
    }
    case "project.activate": {
      if (!opts.projects) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "项目注册表未启用" }); break; }
      const r = opts.projects.activate(msg.projectId);
      if (!r.ok) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.ProjectActivateFailed, message: r.reason });
        break;
      }
      opts.broadcast?.(projectListMessage(opts.projects));
      break;
    }
    case "project.list": {
      if (!opts.projects) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "项目注册表未启用" }); break; }
      safeSend(ws, projectListMessage(opts.projects));
      break;
    }
    case "project.rename": {
      if (!opts.projects) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "项目注册表未启用" }); break; }
      const r = opts.projects.rename(msg.projectId, String(msg.label ?? ""));
      if (!r.ok) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.ProjectRenameFailed, message: r.reason });
        break;
      }
      opts.broadcast?.(projectListMessage(opts.projects));
      break;
    }
    case "fs.list": {
 // 远程项目分流:path 以 remote:ssh: 开头(IDE 树=identity+/sub)走 SSH 列目录,
      // entries 形态与本地 listDir 对齐(前端零改动)——IDE 树/文件树对远程项目直接可用。
      {
        const p = String(msg.path ?? "");
        const remote = p ? parseRemoteProject(p) : null;
        if (remote) {
          const r = await remoteLs({ ...remote, workspacePath: remote.workspacePath }, ".");
          if ("error" in r) safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.list.result", path: p, error: r.error });
          else safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.list.result", path: p, parent: null, entries: r.entries });
          break;
        }
      }
 // 目录浏览:添加项目的目录选择器 + 文件树懒展开共用;path="" 返回锚点。
      const { listDir, browseAnchors } = await import("./fs-browse.js");
      const p = String(msg.path ?? "");
      if (!p) {
 // 连接向导口径:WSL 不再从本地目录选择器进入(先连接→装服务→服务返回目录),
        // 锚点保持纯本地语义;打开选择器不再触发 wsl.exe 探测。
        safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.list.result", path: "", anchors: { ...browseAnchors(), wsl: [] }, entries: [] });
        break;
      }
      try {
        const r = listDir(p, Boolean(msg.showHidden));
        safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.list.result", path: r.path, parent: r.parent, home: r.home, entries: r.entries });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.list.result", path: p, error: String((err as Error).message || err) });
      }
      break;
    }
    case "fs.open": {
      const { openPath } = await import("./fs-browse.js");
      safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.open.result", path: String(msg.path ?? ""), ...openPath(String(msg.path ?? ""), Boolean(msg.reveal)) });
      break;
    }
 // ---- IDE 文件操作三通道(mkdir/remove/rename)+ 全项目内容搜索(grep) ----
    // 沙箱口径对齐全 file.write:根 = 帧内 projectId ?? 活动项目 ?? harness;realpath 前缀比对
    // (父目录/目标都解析,symlink 逃逸在此拦下)+ 拒 .git 任一路径段 + 拒绝对路径与 ../ 越界。
    // 失败回包 fs.*.result { ok:false, error }(回包式,前端可按 op 精确定位失败那一条;不走 error 帧)。
    case "fs.mkdir":
    case "fs.remove":
    case "fs.rename":
    case "fs.grep": {
 // 远程项目(SSH/WSL:同名操作走工作区服务通道(agent-stdio fs.*;通道未部署回退远端 shell),
      // 围栏=项目 workspacePath。此前这些操作在远程项目上会落 harness 根(静默错位)。
      {
        const projForOp = (msg.projectId ? opts.projects?.list().find((p) => p.id === msg.projectId) : undefined)
          ?? opts.projects?.list().find((p) => p.id === opts.projects?.activeId());
        const remoteOp = projForOp ? parseRemoteProject(projForOp.path) : null;
        if (remoteOp) {
          const replyOk = () => {
            if (msg.type === "fs.mkdir") safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.mkdir.result", path: msg.path, ok: true });
            else if (msg.type === "fs.remove") safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.remove.result", path: msg.path, ok: true });
            else if (msg.type === "fs.rename") safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.rename.result", from: msg.from, to: msg.to, ok: true });
            else safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.grep.result", query: msg.query, matches: [], truncated: false });
          };
          const replyErr = (reason: string) => {
            if (msg.type === "fs.mkdir") safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.mkdir.result", path: msg.path, ok: false, error: reason });
            else if (msg.type === "fs.remove") safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.remove.result", path: msg.path, ok: false, error: reason });
            else if (msg.type === "fs.rename") safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.rename.result", from: msg.from, to: msg.to, ok: false, error: reason });
            else safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.grep.result", query: msg.query, matches: [], error: reason });
          };
          const oneLine = (s: unknown) => String(s ?? "").replace(/^Error:\s*/, "").slice(0, 200);
          // 远端 workspacePath 是 POSIX:不能用 node:path.join(Windows 打出来是反斜杠)
          const posixJoin = (base: string, rel: string) => {
            const r = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
            const b = base.replace(/\/+$/, "");
            return r && r !== "." ? `${b}/${r}` : b;
          };
          try {
            if (msg.type === "fs.mkdir") {
              const ch = await tryChannelJson(remoteOp, "fs.mkdir", { path: String(msg.path ?? "") });
              if (ch && ch.ok) { replyOk(); break; }
              const r = await remoteRun(remoteOp, `mkdir ${shQuote(posixJoin(remoteOp.workspacePath, String(msg.path ?? "")))}`, {});
              if (!r.ok) throw new Error(r.error ?? "mkdir 失败");
              replyOk();
            } else if (msg.type === "fs.remove") {
              if (!msg.recursive) {
                const ls = await remoteLs(remoteOp, String(msg.path ?? ""));
                if ("entries" in ls && ls.entries.length > 0) throw new Error("目录非空,未传 recursive 拒绝删除");
              }
              const ch = await tryChannelJson(remoteOp, "fs.remove", { path: String(msg.path ?? "") });
              if (ch && ch.ok) { replyOk(); break; }
              const r = await remoteRun(remoteOp, `rm -rf ${shQuote(posixJoin(remoteOp.workspacePath, String(msg.path ?? "")))}`, {});
              if (!r.ok) throw new Error(r.error ?? "删除失败");
              replyOk();
            } else if (msg.type === "fs.rename") {
              const ch = await tryChannelJson(remoteOp, "fs.rename", { from: String(msg.from ?? ""), to: String(msg.to ?? "") });
              if (ch && ch.ok) { replyOk(); break; }
              const from = shQuote(posixJoin(remoteOp.workspacePath, String(msg.from ?? "")));
              const to = shQuote(posixJoin(remoteOp.workspacePath, String(msg.to ?? "")));
              const r = await remoteRun(remoteOp, `test -e ${from} || { echo 源不存在; exit 1; }; test -e ${to} && { echo 目标已存在; exit 1; }; mv ${from} ${to}`, {});
              if (!r.ok) throw new Error(r.error ?? "重命名失败");
              replyOk();
            } else {
              // fs.grep:通道输出形如 相对路径:行号:文本(工作区服务已去 workspace 前缀)
              const limit = Math.min(Math.max(1, Number(msg.maxResults) || 200), 2000);
              const ch = await tryChannelJson(remoteOp, "fs.grep", { dir: String(msg.path ?? "."), pattern: String(msg.query ?? ""), regex: !!msg.regex, limit });
              let lines: string[] = [];
              let truncated = false;
              if (ch && ch.ok) {
                const data = ch.data as { matches?: string[]; truncated?: boolean };
                lines = data.matches ?? [];
                truncated = !!data.truncated;
              } else {
                const pat = msg.regex ? String(msg.query ?? "") : String(msg.query ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const base = posixJoin(remoteOp.workspacePath, String(msg.path ?? "."));
                const r = await remoteRun(remoteOp, `cd ${shQuote(remoteOp.workspacePath)} && grep -rn -I ${msg.regex ? "" : "-i "}${shQuote(pat)} ${shQuote(base)} 2>/dev/null | sed "s|^${remoteOp.workspacePath}/||" | head -n ${limit + 1}`, {});
                if (!r.ok) throw new Error(r.error ?? "grep 失败");
                lines = r.stdout.split("\n").filter(Boolean);
                if (lines.length > limit) { lines = lines.slice(0, limit); truncated = true; }
              }
              const matches: { path: string; line: number; text: string }[] = [];
              for (const ln of lines) {
                const m = /^(.*?):(\d+):([\s\S]*)$/.exec(ln);
                if (m) matches.push({ path: m[1] ?? "", line: Number(m[2]), text: (m[3] ?? "").slice(0, 400) });
              }
              safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.grep.result", query: msg.query, matches, ...(truncated ? { truncated: true } : {}) });
            }
          } catch (err) {
            replyErr(oneLine(err));
          }
          break;
        }
      }
      const { realpathSync, statSync, existsSync, mkdirSync, rmSync, renameSync, readdirSync, readFileSync } = await import("node:fs");
      const { normalize, dirname, basename, isAbsolute } = await import("node:path");
      const root = (msg.projectId ? opts.projects?.resolveWorkdir(msg.projectId) : undefined)
        ?? opts.projects?.resolveWorkdir(opts.projects.activeId()) ?? repoRoot();
      /** 相对路径 → 仓内绝对路径(realpath 前缀校验);越界/.git/断链一律抛错。 */
      const resolveInside = (rel: string): { abs: string; absRoot: string } => {
        const absRoot = realpathSync(root);
        const norm = normalize(rel).replace(/\\/g, "/");
        if (!norm || norm === "." || norm.startsWith("../") || norm === ".." || isAbsolute(rel)) throw new Error("路径越界(仅项目内可写)");
        if (norm.split("/").includes(".git")) throw new Error(".git 受保护,拒绝操作");
        const abs = join(absRoot, norm);
        const realParent = existsSync(dirname(abs)) ? realpathSync(dirname(abs)) : null;
        if (realParent !== null && !isPathInside(absRoot, realParent)) throw new Error("路径越界(仅项目内可写)");
        if (existsSync(abs)) {
          const realSelf = realpathSync(abs);
          if (!isPathInside(absRoot, realSelf)) throw new Error("路径越界(仅项目内可写)");
          return { abs: realSelf, absRoot };
        }
        return { abs, absRoot };
      };
      const fail = (reason: unknown) => String(reason instanceof Error ? reason.message : reason).replace(/^Error:\s*/, "").slice(0, 200);
      try {
        if (msg.type === "fs.mkdir") {
          const { abs } = resolveInside(msg.path);
          if (existsSync(abs)) throw new Error("目标已存在");
          mkdirSync(abs); // 单层:父目录不存在抛 ENOENT(与 file.write 同口径,不隐式建多层)
          safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.mkdir.result", path: msg.path, ok: true });
        } else if (msg.type === "fs.remove") {
          const { abs, absRoot } = resolveInside(msg.path);
          if (!existsSync(abs)) throw new Error("目标不存在");
          if (abs === absRoot) throw new Error("拒绝删除项目根");
          const st = statSync(abs);
          if (st.isDirectory()) {
            const kids = readdirSync(abs);
            if (kids.length && !msg.recursive) throw new Error("目录非空,未传 recursive 拒绝删除");
            rmSync(abs, { recursive: true, force: false }); // 目录恒走 recursive(空目录 recursive:true 亦安全)
          } else {
            rmSync(abs, { force: false });
          }
          safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.remove.result", path: msg.path, ok: true });
        } else if (msg.type === "fs.rename") {
          const { abs: fromAbs, absRoot } = resolveInside(msg.from);
          if (!existsSync(fromAbs)) throw new Error("源不存在");
          if (fromAbs === absRoot) throw new Error("拒绝重命名项目根");
          const { abs: toAbs } = resolveInside(msg.to);
          if (!existsSync(dirname(toAbs))) throw new Error("目标父目录不存在");
          if (existsSync(toAbs)) throw new Error("目标已存在");
          renameSync(fromAbs, toAbs);
          safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.rename.result", from: msg.from, to: msg.to, ok: true });
        } else {
          // fs.grep:遍历项目文本文件 — 跳过 .git/node_modules/dist/.genie、>1MB、首 8KB 含 NUL
          // path 缺省(面板 Ctrl+Shift+F 全项目搜索)= 项目根,不走 resolveInside(".")(其按写口径拒 ".")
          const baseAbs = msg.path ? resolveInside(msg.path).abs : realpathSync(root);
          const absRoot = realpathSync(root);
          const limit = Math.min(Math.max(1, Number(msg.maxResults) || 200), 2000);
          let re: RegExp | null = null;
          if (msg.regex) {
            try { re = new RegExp(msg.query, "g"); } catch (err) { throw new Error("正则非法:" + fail(err)); }
          }
          const needle = msg.regex ? "" : msg.query.toLowerCase();
          const SKIP = new Set([".git", "node_modules", "dist", ".genie"]);
          const matches: { path: string; line: number; text: string }[] = [];
          let truncated = false;
          const walk = (dir: string) => {
            if (matches.length >= limit) { truncated = true; return; }
            let names: string[];
            try { names = readdirSync(dir); } catch { return; }
            for (const nm of names) {
              if (matches.length >= limit) { truncated = true; return; }
              if (SKIP.has(nm)) continue;
              const child = join(dir, nm);
              let st;
              try { st = statSync(child); } catch { continue; }
              if (st.isDirectory()) { walk(child); continue; }
              if (!st.isFile() || st.size > 1024 * 1024) continue;
              let text: string;
              try {
                const buf = readFileSync(child);
                if (buf.subarray(0, 8192).includes(0)) continue; // 二进制跳过
                text = buf.toString("utf-8");
              } catch { continue; }
              const relPath = (child.slice(absRoot.length + 1) || nm).replace(/\\/g, "/");
              const lines = text.split("\n");
              let brokeForLimit = false;
              for (let i = 0; i < lines.length; i++) {
                if (matches.length >= limit) { brokeForLimit = true; break; }
                const ln = String(lines[i] ?? "");
                let hit = false;
                if (re) { re.lastIndex = 0; hit = re.test(ln); }
                else hit = ln.toLowerCase().includes(needle);
                if (hit) matches.push({ path: relPath, line: i + 1, text: ln.slice(0, 400) });
              }
              if (brokeForLimit) { truncated = true; return; }
            }
          };
          if (statSync(baseAbs).isDirectory()) walk(baseAbs);
          else throw new Error("搜索起点不是目录");
          safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.grep.result", query: msg.query, matches, ...(truncated ? { truncated: true } : {}) });
        }
      } catch (err) {
        const reason = fail(err);
        if (msg.type === "fs.mkdir") safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.mkdir.result", path: msg.path, ok: false, error: reason });
        else if (msg.type === "fs.remove") safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.remove.result", path: msg.path, ok: false, error: reason });
        else if (msg.type === "fs.rename") safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.rename.result", from: msg.from, to: msg.to, ok: false, error: reason });
        else safeSend(ws, { v: PROTOCOL_VERSION, type: "fs.grep.result", query: msg.query, matches: [], error: reason });
      }
      break;
    }
    // ---- 面板 IDE 第二批:lsp.diagnostics(问题面板)/ term.session.*(持久终端)/ git.show(文件历史) ----
    // 沙箱口径与 fs.grep 同款:根 = 帧内 projectId ?? 活动项目 ?? harness;realpath 前缀比对 +
    // 拒 .git 段 + 拒绝对路径与 ../ 越界。requestId 原样回传;失败走 error 帧(message 带 requestId)。
    case "lsp.diagnostics":
    case "term.session.open":
    case "term.session.send":
    case "term.session.read":
    case "term.session.close":
    case "git.show": {
      const fail = (message: string, code: string = ErrorCode.BadRequest) =>
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code, message: `[requestId=${"requestId" in msg ? String((msg as { requestId?: string }).requestId) : "-"}] ${message}`.slice(0, 300) });
      try {
        const { realpathSync, statSync, existsSync } = await import("node:fs");
        const { normalize, isAbsolute } = await import("node:path");
 // 远程项目(SSH/WSL:LSP 只在本地跑(远程跳过,回空诊断);git.show 走远端 git。
        // term.session.send/read/close 是会话 id 语义,继续走下方通用处理。
        {
          const opsPid = "projectId" in msg ? (msg as { projectId?: string }).projectId : undefined;
          const opsProj = (opsPid ? opts.projects?.list().find((p) => p.id === opsPid) : undefined)
            ?? opts.projects?.list().find((p) => p.id === opts.projects?.activeId());
          const opsRemote = opsProj ? parseRemoteProject(opsProj.path) : null;
          if (opsRemote && msg.type === "lsp.diagnostics") {
            safeSend(ws, { v: PROTOCOL_VERSION, type: "lsp.diagnostics.result", requestId: msg.requestId, diagnostics: [] });
            break;
          }
          if (opsRemote && msg.type === "git.show") {
            const rel = String(msg.path ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
            const r = await remoteGit(opsRemote, ["show", (msg.ref ?? "HEAD") + ":" + rel]);
            if ("error" in r) fail(r.error, ErrorCode.GitFailed);
            else safeSend(ws, { v: PROTOCOL_VERSION, type: "git.show.result", requestId: msg.requestId, content: r.stdout });
            break;
          }
        }
        const root = ("projectId" in msg && (msg as { projectId?: string }).projectId
          ? opts.projects?.resolveWorkdir((msg as { projectId?: string }).projectId!)
          : undefined) ?? opts.projects?.resolveWorkdir(opts.projects.activeId()) ?? repoRoot();
        const absRoot = realpathSync(root);
        /** 项目内相对路径 → 绝对路径(realpath 前缀校验);越界/.git 拒绝。 */
        const insideAbs = (rel: string): string => {
          const norm = normalize(rel).replace(/\\/g, "/");
          if (!norm || norm === "." || norm.startsWith("../") || norm === ".." || isAbsolute(rel)) throw new Error("路径越界(仅项目内可访问)");
          if (norm.split("/").includes(".git")) throw new Error(".git 受保护,拒绝操作");
          const abs = join(absRoot, norm);
          if (!existsSync(abs)) return abs; // 存在性由调用方判定(lsp 静默跳过;git.show 走对象库)
          const real = realpathSync(abs);
          if (!isPathInside(absRoot, real)) throw new Error("路径越界(仅项目内可访问)");
          return real;
        };

        if (msg.type === "lsp.diagnostics") {
          if (msg.paths.length > 32) { fail("paths 超过上限 32"); break; }
          const { checkEditedFile } = await import("@lampgenie/lsp");
          const DIAG_EXT = /\.(ts|tsx|js|jsx|mts|cts)$/i;
          const out: { path: string; line: number; col: number; severity: "error" | "warning"; message: string; code?: string }[] = [];
          // 逐文件 fail-soft:单文件解析/检查异常不拖垮整批(与 checkEditedFile 同语义)。
          for (const rel of msg.paths) {
            if (!DIAG_EXT.test(rel)) continue; // 其它扩展名静默跳过(问题面板只管 JS/TS 面)
            let abs: string;
            try { abs = insideAbs(rel); } catch { continue; }
            let isFile = false;
            try { isFile = statSync(abs).isFile(); } catch { isFile = false; }
            if (!isFile) continue;
            let r: import("@lampgenie/lsp").EditCheckResult;
            try {
              r = await checkEditedFile({
                root: absRoot,
                absPath: abs,
                // 面板诊断不落盘:format 关闭(checkEditedFile 的 format:true 会写回磁盘)。
                settings: { enabled: true, format: false, maxDiagnostics: 100, timeoutMs: 2000 },
              });
            } catch { continue; } // LSP server 启动超时等 → 该文件静默跳过(问题面板不因单文件崩)
            for (const d of r.diagnostics) {
              if (d.severity !== "error" && d.severity !== "warning") continue;
              out.push({
                path: rel, line: d.line, col: d.column, severity: d.severity,
                message: d.message.slice(0, 400),
                ...(d.code !== undefined ? { code: String(d.code) } : {}),
              });
              if (out.length >= 100) break; // 单文件 100 条封顶(与 maxDiagnostics 同口径)
            }
          }
          safeSend(ws, { v: PROTOCOL_VERSION, type: "lsp.diagnostics.result", requestId: msg.requestId, diagnostics: out });
          break;
        }

        if (msg.type === "git.show") {
          const svc = await import("./git-service.js");
          if (!(await svc.isGitRepo(absRoot))) { fail("当前目录不是 git 仓库,已跳过 git 操作", ErrorCode.GitNorepo); break; }
          insideAbs(msg.path); // 沙箱校验(越界/.git 拒绝);内容取自 git 对象库(ref:path)
          try {
            const content = await svc.showFile(absRoot, msg.ref ?? "HEAD", normalize(msg.path).replace(/\\/g, "/"));
            safeSend(ws, { v: PROTOCOL_VERSION, type: "git.show.result", requestId: msg.requestId, content });
          } catch (err) {
            fail(String(err instanceof Error ? err.message : err).replace(/^Error:\s*/, ""), ErrorCode.GitFailed);
          }
          break;
        }

        // ---- term.session.*:持久终端(owner="panel:<连接标识>";WS 关闭整 owner 回收) ----
        const service = await panelTerminalService(journal);
        const wsState = ws as unknown as { __panelTermOwner?: string; __panelTermCursors?: Map<string, number> };
        if (!wsState.__panelTermOwner) {
          wsState.__panelTermOwner = `panel:${++panelConnSeq}`;
          // 连接级清理(挂法照 term.exec):断开即回收该 owner 全部会话,不漏进程。
          ws.on("close", () => {
            const owner = wsState.__panelTermOwner;
            if (!owner) return;
            wsState.__panelTermOwner = undefined;
            for (const info of service.list(owner)) {
              void service.close(owner, info.id, "panel-disconnect").catch(() => undefined);
            }
          });
        }
        const owner = wsState.__panelTermOwner;
        const termFail = (err: unknown) => {
          const code = String((err as { code?: string }).code ?? "");
          const mapped = code === "LIMIT_EXCEEDED" ? ErrorCode.TermBusy
            : code === "NO_SESSION" || code === "FOREIGN_SESSION" || code === "INVALID_CWD" || code === "INVALID_INPUT" ? ErrorCode.BadRequest
            : ErrorCode.TermFailed;
          fail(String(err instanceof Error ? err.message : err), mapped);
        };
        if (msg.type === "term.session.open") {
          try {
 // 远程项目终端(ZCode 远端 workspace 终端语义):ssh -t 直落远端 shell
            // (cwd=workspace;密码走 resolveSshPassword→SSHPASS env,不进命令行)。
            const termPid = "projectId" in msg ? (msg as { projectId?: string }).projectId : undefined;
            const termProj = termPid ? opts.projects?.list().find((x) => x.id === termPid) : undefined;
            const termRemote = termProj ? parseRemoteProject(termProj.path) : null;
            if (termRemote) {
              if (termRemote.kind === "wsl") {
                // WSL 项目:直接落发行版内 bash(wsl.exe --cd <posix> --exec bash --norc --noprofile)
                const { wslPtyInvocation } = await import("./wsl.js");
                const inv = wslPtyInvocation(termRemote.distro, termRemote.workspacePath);
                const info = await service.open(owner, { cwd: process.cwd(), shellOverride: { command: inv.cmd, args: inv.args } });
                safeSend(ws, { v: PROTOCOL_VERSION, type: "term.session.open.result", requestId: msg.requestId, sessionId: info.id });
                break;
              }
              const { resolveSshPassword } = await import("./remote-project.js");
              const pass = resolveSshPassword(termRemote);
              if (!pass) throw new Error("远程项目终端需要 SSH 密码(设置台→远程连接 保存凭证后再开终端)");
              const info = await service.open(owner, {
                cwd: termRemote.workspacePath,
                shellOverride: {
                  command: "sshpass",
                  args: ["-e", "ssh", "-tt", "-o", "StrictHostKeyChecking=no", "-o", "PubkeyAuthentication=no", "-p", String(termRemote.port), `${termRemote.username}@${termRemote.host}`, `cd ${termRemote.workspacePath} && exec bash --norc --noprofile`],
                  env: { SSHPASS: pass },
                },
              });
              safeSend(ws, { v: PROTOCOL_VERSION, type: "term.session.open.result", requestId: msg.requestId, sessionId: info.id });
              break;
            }
            let cwd = absRoot;
            if (msg.cwd) {
              const norm = normalize(msg.cwd).replace(/\\/g, "/");
              if (norm !== "." && norm !== "") {
                if (isAbsolute(msg.cwd)) {
                  // 绝对路径(面板发项目根本身):realpath 必须落在项目内;且与相对分支一致拒绝 .git 段
                  if (msg.cwd.split(/[\\/]/).includes(".git")) throw new Error("cwd 路径越界(仅项目内可开终端)");
                  const realAbs = realpathSync(msg.cwd);
                  if (!isPathInside(absRoot, realAbs)) throw new Error("cwd 路径越界(仅项目内可开终端)");
                  cwd = realAbs;
                } else {
                  if (norm.startsWith("../") || norm === ".." || norm.split("/").includes(".git")) throw new Error("cwd 路径越界(仅项目内可开终端)");
                  const cand = join(absRoot, norm);
                  const real = realpathSync(cand); // 不存在/断链 → 抛错(INVALID_CWD 同语义)
                  if (!isPathInside(absRoot, real)) throw new Error("cwd 路径越界(仅项目内可开终端)");
                  cwd = real;
                }
              }
            }
 // WSL 项目:终端落进发行版内(bash --norc --noprofile),cwd 由 wsl --cd 承担。
            // 否则 Windows Git-Bash 只是隔着 \\wsl.localhost 共享跑 Windows 工具链,不是项目要的执行环境。
            {
              const wslLoc = parseWslPath(cwd);
              if (wslLoc) {
                const { wslPtyInvocation } = await import("./wsl.js");
                const inv = wslPtyInvocation(wslLoc.distro, wslLoc.posix);
                const info = await service.open(owner, { cwd: process.cwd(), shellOverride: { command: inv.cmd, args: inv.args } });
                safeSend(ws, { v: PROTOCOL_VERSION, type: "term.session.open.result", requestId: msg.requestId, sessionId: info.id });
                break;
              }
            }
            const info = await service.open(owner, { cwd }); // cols/rows 暂不支持 resize,忽略
            safeSend(ws, { v: PROTOCOL_VERSION, type: "term.session.open.result", requestId: msg.requestId, sessionId: info.id });
          } catch (err) { termFail(err); }
          break;
        }
        const termCursors = (wsState.__panelTermCursors ??= new Map<string, number>());
        try {
          if (msg.type === "term.session.send") {
            await service.send(owner, msg.sessionId, { command: msg.data, wait: false }); // 写入即返回;输出经 read 增量拉
            // 注:send(wait:false) 在 session 内部会推进 consumedCursor 吞掉本次输出——
            // 面板侧因此自带显式游标(termCursors),read 一律带 cursor 重读 ring buffer,不依赖 consumedCursor。
            safeSend(ws, { v: PROTOCOL_VERSION, type: "term.session.send.result", requestId: msg.requestId });
          } else if (msg.type === "term.session.read") {
            const start = msg.cursor !== undefined ? msg.cursor : (termCursors.get(msg.sessionId) ?? 0);
            const r = await service.read(owner, msg.sessionId, { cursor: start, waitMs: 250 });
            termCursors.set(msg.sessionId, r.cursor);
            safeSend(ws, { v: PROTOCOL_VERSION, type: "term.session.read.result", requestId: msg.requestId, data: r.output, cursor: r.cursor });
          } else {
            await service.close(owner, msg.sessionId, "panel-request");
            termCursors.delete(msg.sessionId);
            safeSend(ws, { v: PROTOCOL_VERSION, type: "term.session.close.result", requestId: msg.requestId });
          }
        } catch (err) { termFail(err); }
        break;
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
        break;
      }
    }
    case "node.task.result":
      if (opts.nodeDispatch) {
        const routed = opts.nodeDispatch.handleResult(msg);
        if (!routed) safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.UnknownTask, message: `无挂起的委派任务 ${msg.taskId}` });
      } else {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "委派未启用" });
      }
      break;
    case "node.heartbeat":
      if (nodes) {
 // 在线态翻转(失联→在线)时廉价广播,面板不必轮询也能看到节点复活。
        const wasOnline = (nodes.online() ?? []).some((n) => n.nodeId === msg.nodeId);
        const ok = nodes.heartbeat(msg.nodeId, msg.load);
        const nowOnline = (nodes.online() ?? []).some((n) => n.nodeId === msg.nodeId);
        if (ok && !wasOnline && nowOnline) opts.broadcast?.({ v: PROTOCOL_VERSION, type: "nodes.changed" });
        safeSend(ws, { v: PROTOCOL_VERSION, type: "node.heartbeat.ack", ok });
      } else {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "nodes 未启用" });
      }
      break;
    case "sense.query": {
      const { codeSense } = await import("@lampgenie/code-sense");
 // 项目级 code-sense:查询挂在项目根上——面板传激活项目,
      // 无项目/项目不可用回退 harness 根(resolveWorkdir 内建回退,不越界)
      const senseRoot = opts.projects?.resolveWorkdir(msg.projectId) ?? repoRoot();
      try {
        const result = await codeSense(senseRoot, msg.query, { mode: msg.mode, depth: msg.depth });
        safeSend(ws, { v: PROTOCOL_VERSION, type: "sense.result", result });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.SenseFailed, message: String(err).slice(0, 200) });
      }
      break;
    }
 // ---- repo wiki:持久页结构 .genie/wiki/<repo>/ + 面板视图 ----
    case "wiki.list": {
      const root = opts.projects?.resolveWorkdir(msg.projectId) ?? repoRoot();
      try {
        const { listWiki } = await import("@lampgenie/code-sense/wiki");
        const r = await listWiki(root);
        safeSend(ws, {
          v: PROTOCOL_VERSION, type: "wiki.list.result",
          projectId: msg.projectId ?? null, root, repo: r.repo, dir: r.dir, exists: r.exists,
          manifest: (r.manifest ?? null) as unknown as Record<string, unknown> | null,
        });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.WikiListFailed, message: String(err).slice(0, 200) });
      }
      break;
    }
    case "wiki.get": {
      const root = opts.projects?.resolveWorkdir(msg.projectId) ?? repoRoot();
      try {
        const { getWikiPage } = await import("@lampgenie/code-sense/wiki");
        const r = await getWikiPage(root, msg.page);
        safeSend(ws, {
          v: PROTOCOL_VERSION, type: "wiki.page.result",
          projectId: msg.projectId ?? null, root, pageId: msg.page,
          page: (r?.page ?? null) as unknown as Record<string, unknown> | null,
          markdown: r?.markdown ?? null,
        });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.WikiGetFailed, message: String(err).slice(0, 200) });
      }
      break;
    }
    case "wiki.rebuild": {
      const root = opts.projects?.resolveWorkdir(msg.projectId) ?? repoRoot();
      try {
        const { rebuildWiki } = await import("@lampgenie/code-sense/wiki");
        const llm = wikiLlmFromProvider(opts.llm);
        const res = await rebuildWiki(root, {
          refresh: msg.refresh === true,
          ...(llm ? { llm } : {}),
          ...(msg.maxLlmPages !== undefined ? { config: { maxLlmPages: msg.maxLlmPages } } : {}),
        });
        safeSend(ws, {
          v: PROTOCOL_VERSION, type: "wiki.rebuild.result",
          projectId: msg.projectId ?? null, root,
          hit: res.hit, reason: res.reason, rebuilt: res.rebuilt, reused: res.reused, removed: res.removed,
          llmCalls: res.llmCalls, durationMs: res.durationMs,
          manifest: res.manifest as unknown as Record<string, unknown>,
        });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.WikiRebuildFailed, message: String(err).slice(0, 300) });
      }
      break;
    }
 // sense.review/sense.status 已删(冗余收敛):评审走 code_review 工具,
    // 项目状态走系统活性面板——面板直连通道与工具面重复维护两份口径。
    case "review.store.get": {
      // 评审遗留(行级回写店消费):读 <root>/.genie/review-comments.json 的 sticky 跨轮状态。
      const root = opts.projects?.resolveWorkdir(msg.projectId) ?? repoRoot();
      const { loadStore } = await import("@lampgenie/code-sense/review/writeback");
      const store = loadStore(join(root, ".genie", "review-comments.json"));
      const open = store.comments.filter((c) => c.resolvedAt === undefined);
      const resolved = store.comments.filter((c) => c.resolvedAt !== undefined);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "review.store.result", projectId: msg.projectId ?? null, root, open, resolved });
      break;
    }
 // 评审评论一键回注聊天窗:单条/多条/整批评论编成修复指令,
    // 走 board.continue 同款通道(tm.submit 新任务)注入目标会话,coding agent 按条修复。
    case "review.inject": {
      const items = msg.items;
      const lines = items
        .map((f, i) => {
          const sev = (f.severity || "info").toUpperCase();
          const head = `${i + 1}. [${sev}] ${f.file}:${f.line} — ${f.title}`;
          const bits: string[] = [];
          if (f.detail) bits.push(`详情:${f.detail}`);
          if (f.rule) bits.push(`规则:${f.rule}`);
          return bits.length ? `${head}\n   ${bits.join(" | ")}` : head;
        })
        .join("\n");
      const instruction =
        `【按评审评论修复】以下来自代码评审的 ${items.length} 条发现,请逐条处理(能修则直接改代码;认为不适用/误报的,在回复中说明理由):\n${lines}\n` +
        (msg.note ? `用户的附加说明:${msg.note}\n` : "") +
        "修完后请再次运行 code_review 工具复查,确认上述发现不再复现;若仍有未解决项,在回复中逐条说明。";
      const task = tm.submit("user", msg.sessionId, instruction, {
        // 幂等(同 board.continue 语义):面板按评论键集生成 idempotencyKey,重发/双击不重复立任务。
        idempotencyKey: msg.idempotencyKey,
        ...(msg.projectId !== undefined ? { projectId: msg.projectId } : opts.projects ? { projectId: opts.projects.activeId() } : {}),
      });
      journal.append({
        kind: "review.inject", sessionId: msg.sessionId,
        payload: { count: items.length, files: [...new Set(items.map((f) => f.file))].slice(0, 20), source: msg.source ?? null, taskId: task.id, targetSessionId: msg.sessionId },
      });
      // task.submitted 先发(面板据此更新 tasks 登记表,回执里的会话 label 才能取到任务标题)。
      safeSend(ws, { v: PROTOCOL_VERSION, type: "task.submitted", task });
      safeSend(ws, { v: PROTOCOL_VERSION, type: "review.inject.result", sessionId: msg.sessionId, taskId: task.id, count: items.length });
      break;
    }
 // ---- 语义流程白板 ----
    case "board.list": {
      const { listBoardsExAsync } = await import("./board-store.js");
 // skipped=损坏/不可读板文件数,面板据此区分「真无板」与「板文件损坏」显式降级。
      const r = await listBoardsExAsync(repoRoot(), msg.sessionId);
 // 未处理评论:板列表回包带上每块板的待读评论数(panel 卡头 chip 数据源),
      // 消费方仍是 agent loop(takePendingComments);这里只 peek,不消费。
      const { peekPendingComments } = await import("./board-comments.js");
      const pend = peekPendingComments(msg.sessionId);
      const pendCount = new Map<string, number>();
      for (const c of pend) pendCount.set(c.taskId, (pendCount.get(c.taskId) ?? 0) + 1);
      const items = r.items.map((it) => ({ ...it, ...(pendCount.has(it.taskId) ? { pendingComments: pendCount.get(it.taskId) } : {}) }));
      safeSend(ws, { v: PROTOCOL_VERSION, type: "board.list.result", sessionId: msg.sessionId, items, ...(r.skipped ? { skipped: r.skipped } : {}) });
      break;
    }
 // 设计沉淀查询:done 板项目级索引(代码档案「设计沉淀」区数据源);
    // 无 projectId=全量(调试/未来跨项目视图)。板全文不走这里——面板点条目再发 board.get。
    case "board.archive.list": {
      const { loadBoardArchiveAsync } = await import("./board-store.js");
      const items = typeof msg.projectId === "string" && msg.projectId
        ? (await loadBoardArchiveAsync(repoRoot())).filter((it) => it.projectId === msg.projectId)
        : await loadBoardArchiveAsync(repoRoot());
      safeSend(ws, {
        v: PROTOCOL_VERSION, type: "board.archive.result",
        projectId: (typeof msg.projectId === "string" && msg.projectId) ? msg.projectId : null,
        items: items.map((it) => ({ sessionId: it.sessionId, taskId: it.taskId, title: it.title, status: it.status, updatedAt: it.updatedAt, nodeCount: it.nodeCount, files: it.files })),
      });
      break;
    }
 // ---- 内置浏览器视图(移植 ZCode UnifiedBrowserView)----
    // 订阅制:open 时挂 sink,close/断连时退订。帧只发本连接(不做全量广播),
    // 与既有「单连接回包」先例一致(session.history),避免多面板时截图流互相污染。
    case "browser.view.open": {
      const cfg = browserCfgOf(opts);
      if (!cfg.enabled()) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "browser.view.subscribed", tabId: null, ok: false, message: "[browser] 未启用(设置-浏览器控制 开启 browser.enabled)" });
        break;
      }
      const { getBrowserViewHub } = await import("./browser-tool.js");
      const hub = getBrowserViewHub(repoRoot(), cfg);
      const prev = browserViewSubs.get(ws);
      if (prev) { hub.unsubscribe(prev.subId); browserViewSubs.delete(ws); }
      const sub = hub.subscribe(msg.tabId ?? null, (m) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const out = "seq" in m
          ? { v: PROTOCOL_VERSION, type: "browser.view.frame" as const, ...m }
          : { v: PROTOCOL_VERSION, type: "browser.view.event" as const, ...m };
        safeSend(ws, out);
      });
      browserViewSubs.set(ws, sub);
      safeSend(ws, {
        v: PROTOCOL_VERSION, type: "browser.view.subscribed",
        tabId: sub.tabId, ok: true, tabs: hub.tabList(),
      });
      break;
    }
    case "browser.view.close": {
      const cfg = browserCfgOf(opts);
      const prev = browserViewSubs.get(ws);
      if (prev) {
        const { getBrowserViewHub } = await import("./browser-tool.js");
        getBrowserViewHub(repoRoot(), cfg).unsubscribe(prev.subId);
        browserViewSubs.delete(ws);
        console.error(`[browser.view] 退订 tab=${prev.tabId} sub=${prev.subId}`);
      }
      break;
    }
    case "browser.view.command": {
      const cfg = browserCfgOf(opts);
      if (!cfg.enabled()) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "browser.view.command.result", tabId: msg.tabId ?? null, action: msg.action, ok: false, text: "[browser] 未启用(设置-浏览器控制 开启 browser.enabled)" });
        break;
      }
      const { getBrowserViewHub } = await import("./browser-tool.js");
      const hub = getBrowserViewHub(repoRoot(), cfg);
      /* 2026-11 browser-ux-redo 修复:msg.tabId 原先只在回执回填、命令永远落 mostRecentTab——
       * 面板「切了 tab 但操作打错页」的根因。这里并入 args(命令面把 tabId 当 tab 的同义入参)。 */
      const cmdArgs = { ...((msg.args ?? {}) as Record<string, unknown>), tabId: msg.tabId };
      const r = await hub.runViewCommand(msg.action, cmdArgs);
      /* action=tabs 成功时随包附 tab 清单(含 owner),面板免再发一次命令。 */
      const extra = msg.action === "tabs" && r.ok ? { tabs: hub.tabList() } : {};
      safeSend(ws, { v: PROTOCOL_VERSION, type: "browser.view.command.result", tabId: msg.tabId ?? null, action: msg.action, ok: r.ok, text: r.text, ...extra });
      break;
    }
 // 表面/通道能力包:客户端声明能力位 → 校验 → journal custom session.surface
    // (同会话最新一条为准)→ surface.result。坏字段 ok:false + 稳定 error,且不落账。
    // 只有已连接客户端能声明(本 handler 本身在 ws 连接上下文里)。
    case "client.surface": {
      if (!journal) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "surface.result", ok: false, error: "surface-journal-unavailable" });
        break;
      }
      const r = handleClientSurfaceDeclare(
        msg as unknown as Record<string, unknown>,
        journal as unknown as SurfaceJournalLike);
      safeSend(ws, {
        v: PROTOCOL_VERSION, type: "surface.result",
        ...(r.ok ? { ok: true, caps: r.caps } : { ok: false, error: r.error }),
      });
      break;
    }
    case "board.get": {
      const { loadBoardAsync, listBoardsAsync, resolveBoardLinksAsync } = await import("./board-store.js");
      const storeRoot = repoRoot();
      const sid = msg.sessionId ?? "";
      if (!sid) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.BoardBadRequest, message: "board.get 需要 sessionId" });
        break;
      }
 // __session__ 哨兵(白板会话级落盘):拉手绘批注而非 BoardDoc——
      // 经由已被全线接受的 board.get 通道(新协议类型的 bundle 联合同步问题登记在案)。
      if (msg.taskId === "__session__") {
        const { loadOverlayAsync } = await import("./board-store.js");
        const dataB64 = await loadOverlayAsync(storeRoot, sid, "__session__");
        safeSend(ws, { v: PROTOCOL_VERSION, type: "board.overlay.result", sessionId: sid, taskId: "__session__", ...(dataB64 ? { dataB64 } : {}) });
        break;
      }
      const taskId = msg.taskId ?? (await listBoardsAsync(storeRoot, sid))[0]?.taskId ?? "";
      const loaded = taskId ? await loadBoardAsync(storeRoot, sid, taskId) : null;
 // 存量板关系可见(用户用户反馈「看不出有什么关系」):存量板的 edges 多为空
      // (旧版 board_upsert 不推导),只在保存时补边对它们无效。读路径按需推导一份「展示用」
      // 边集(不落盘、不改 rev):显式边优先 + 推导 virtual 边。索引不可用则仅 R2/R4 结构边。
      let doc = loaded;
      if (loaded && (loaded.docKind ?? "design") !== "workflow") {
        const { deriveBoardEdges } = await import("./board-derive.js");
        const { makeCalleesResolver } = await import("./board-derive-resolver.js");
        const derived = deriveBoardEdges(
          loaded.nodes as never,
          (loaded.edges ?? []) as never,
          { calleesOf: makeCalleesResolver(loaded.root ?? storeRoot) },
        ) as unknown as typeof loaded.edges;
        if (Array.isArray(derived) && derived.length !== (loaded.edges?.length ?? 0)) {
          doc = { ...loaded, edges: derived };
        }
      }
      let links: import("@lampgenie/protocol").BoardLinkState[] = [];
      if (doc) {
        // C3:连接三态只读盘上索引(loadIndex),不 kick 重建——看图是读路径,
        // 不能为「漂移/断链」徽标 fork 分钟级构建;索引缺席时 indexHas=null 退化为文件锚判定。
        const { loadIndex } = await import("@lampgenie/code-sense");
        const index = loadIndex(doc.root ?? storeRoot);
        const indexHas = (name: string): boolean | null => (index ? (index.byName[name]?.length ?? 0) > 0 : null);
        links = await resolveBoardLinksAsync(storeRoot, doc, indexHas);
      }
      const { loadOverlayAsync } = await import("./board-store.js");
      const overlayB64 = doc ? await loadOverlayAsync(storeRoot, sid, taskId) : null;
      safeSend(ws, {
        v: PROTOCOL_VERSION, type: "board.doc", sessionId: sid, taskId, doc, links,
        ...(overlayB64 ? { overlayB64 } : {}),
      });
      break;
    }
    // 白板出图(board.diagram):读板 → renderBoardSvg → 回 SVG。见 board-diagram.ts(绝不向上抛)。
    case "board.diagram": {
      const sid = msg.sessionId ?? "";
      if (!sid) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.BoardBadRequest, message: "board.diagram 需要 sessionId" });
        break;
      }
      const theme = msg.theme ?? "light";
      const { loadBoardAsync, listBoardsAsync } = await import("./board-store.js");
      const storeRoot = repoRoot();
      // taskId 缺省=会话最新板(与 board.get 同口径)。
      const taskId = msg.taskId ?? (await listBoardsAsync(storeRoot, sid))[0]?.taskId ?? "";
      // 出图过滤(board-filter.ts):写者裁剪 + 大分组折叠,只影响本次出图,不动板数据。
      // 缓存 key 必须含过滤参数——同一块板的「全量图」和「按写者图」是两张不同的图;
      // 无过滤时 key 保持原样(`${sid}\0${taskId}`)逐字不变,既有缓存命中不受影响。
      const { filterBoardDoc } = await import("./board-filter.js");
      const filterKey = boardDiagramFilterKey(msg.filter);
      const cacheKey = `${sid}\u0000${taskId}${filterKey ? `\u0000${filterKey}` : ""}`;
      const hit = boardDiagramCacheGet(cacheKey, theme);
      if (hit) {
        safeSend(ws, { ...hit, elapsedMs: 0 });
        break;
      }
      const doc = taskId ? await loadBoardAsync(storeRoot, sid, taskId) : null;
      if (!doc) {
        safeSend(ws, {
          v: PROTOCOL_VERSION, type: "board.diagram.result", sessionId: sid,
          ...(taskId ? { taskId } : {}), ok: false, svg: "", diagnostics: [], elapsedMs: 0, error: "board-not-found",
        });
        break;
      }
      const fr = filterBoardDoc(doc, msg.filter);
      if (fr.dropped > 0) {
        // 一行足矣(只在缓存未命中路径上打,不随轮询刷屏)。
        console.warn(
          `[board] diagram ${sid}/${taskId} 过滤丢弃 ${fr.dropped} 项(写者=${(msg.filter?.writers ?? []).join(",") || "全部"})`,
        );
      }
      const { renderBoardSvg } = await import("./board-diagram.js");
      const r = await renderBoardSvg(fr.doc, { theme });
      const frame = {
        v: PROTOCOL_VERSION, type: "board.diagram.result" as const, sessionId: sid, taskId,
        ok: r.ok, svg: r.svg, diagnostics: r.diagnostics, elapsedMs: r.elapsedMs,
        ...(r.ok ? {} : { error: r.diagnostics.find((d) => d.severity === "error")?.code ?? "render-failed" }),
      };
      boardDiagramCacheSet(cacheKey, theme, frame);
      safeSend(ws, frame);
      break;
    }
 // P3 人参与编辑( §8):人改板=改设计不改码;rev 乐观锁,冲突回 board.conflict。
    case "board.save": {
      const { loadBoardAsync, saveBoardAsync, computeHumanEdits } = await import("./board-store.js");
      const storeRoot = repoRoot();
      const existing = await loadBoardAsync(storeRoot, msg.sessionId, msg.taskId);
      if (existing && existing.rev > msg.baseRev) {
        console.error(`[board] save conflict: ${msg.sessionId}/${msg.taskId} baseRev=${msg.baseRev} current=${existing.rev}`);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "board.conflict", sessionId: msg.sessionId, taskId: msg.taskId, currentRev: existing.rev });
        break;
      }
 // 人工改板不是「agent 宣称完成」,不走 P0 落目标门(落板门/门只对 agent 写入面生效)
 // 关系推导:人工加/删节点后同样补推导边(agent 常只画节点不画边),workflow 板跳过。
      const { deriveBoardEdges } = await import("./board-derive.js");
      const { makeCalleesResolver } = await import("./board-derive-resolver.js");
      const docIn = { ...msg.doc, taskId: msg.taskId, sessionId: msg.sessionId, rev: msg.baseRev + 1 };
      if ((docIn.docKind ?? "design") !== "workflow") {
        docIn.edges = deriveBoardEdges(
          docIn.nodes as never,
          (docIn.edges ?? []) as never,
          { calleesOf: makeCalleesResolver(existing?.root ?? repoRoot()) },
        ) as never;
      }
      // 人工改动集(2026-10):把入参 nodes 与盘上 existing nodes 按 id 比,记下这次人动了哪些节点;
      // 「按板续作」据此只派变更集(不再整板 30 节点塞给 agent)。比较在**推导边之前**的入参上做
      // (推导只影响 edges,不影响节点),新增节点与语义字段/评论有变化的节点都算。
      const delta = computeHumanEdits(existing?.nodes, docIn.nodes, docIn.rev);
      docIn.humanEdits = { ids: delta.ids, rev: delta.rev, ...(Object.keys(delta.changes).length ? { changes: delta.changes } : {}) };
      const r = await saveBoardAsync(storeRoot, docIn, { skipGates: true });
      if (!r.ok) {
        console.error(`[board] save invalid: ${msg.sessionId}/${msg.taskId} reason=${r.reason}`);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.BoardInvalid, message: r.reason });
        break;
      }
      journal.append({
        kind: "board.update", sessionId: msg.sessionId,
        payload: { taskId: msg.taskId, path: r.path, rev: r.doc.rev, title: r.doc.title, nodeCount: r.doc.nodes.length, edgeCount: r.doc.edges.length, status: r.doc.status, by: "human" },
      });
      bus.emit("board.changed", { sessionId: msg.sessionId, taskId: msg.taskId });
      safeSend(ws, { v: PROTOCOL_VERSION, type: "board.doc", sessionId: msg.sessionId, taskId: msg.taskId, doc: r.doc, links: [] });
      break;
    }
    // 按板续作:把当前白板编成后续指令,作为新任务发回原会话(agent 接棒按调整后的板实施)。
    case "board.continue": {
      const { loadBoardAsync, saveBoardAsync } = await import("./board-store.js");
      const boardRoot = repoRoot();
      const doc = await loadBoardAsync(boardRoot, msg.sessionId, msg.taskId);
      if (!doc) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.BoardNotFound, message: "白板不存在" });
        break;
      }
      // 派发口径(2026-10,只传变更集):
      // ① 选区(界面勾选派发)msg.nodeIds 优先;② 否则用 board.save 记下的人工改动集 humanEdits.ids;
      // ③ 两者都没有(旧板/无人工改动/已派发清空)→ 回退整板,并在指令里显式说明是整板派发。
      const explicitIds = Array.isArray(msg.nodeIds)
        ? [...new Set(msg.nodeIds.filter((id) => typeof id === "string" && id.trim() !== ""))]
        : [];
      const humanIds = (doc.humanEdits?.ids ?? []).filter((id) => typeof id === "string" && id !== "");
      const mode: "selection" | "humanEdits" | "whole" = explicitIds.length ? "selection" : humanIds.length ? "humanEdits" : "whole";
      const wantedIds = mode === "whole" ? [] : mode === "selection" ? explicitIds : humanIds;
      const byId = new Map(doc.nodes.map((n) => [n.id, n]));
      const missingIds = wantedIds.filter((id) => !byId.has(id));
      // 派发节点集:整板=全部(按原逻辑截 30);变更集=按 wantedIds 顺序(变更集本身很小,超 30 同样截断并显式说明)
      const wantedNodes = wantedIds.map((id) => byId.get(id)).filter((n): n is (typeof doc.nodes)[number] => !!n);
      const LIMIT = 30;
      const dispatchedNodes = mode === "whole" ? doc.nodes : wantedNodes;
      const shownNodes = dispatchedNodes.slice(0, LIMIT);
      const truncated = dispatchedNodes.length - shownNodes.length;
      const changes = doc.humanEdits?.changes ?? {};
      /** 变更节点的字段级「改动:」行(拿不到字段明细时给稳妥话术,不编造)。 */
      const describeChange = (id: string): string => {
        const fields = (changes[id] ?? []).filter(Boolean);
        if (fields.length === 0) return mode === "selection" ? "人工选中此节点(未记录字段级差异)" : "人工改动(未记录字段级差异)";
        if (fields.length === 1 && fields[0] === "新增节点") return "人工新增节点(原板上没有)";
        const named = fields.map((f) => (f === "comments" ? "comment" : f));
        return `${named.join("/")} 有改动`;
      };
      const nodeLines = shownNodes
        .map((n) => {
          const bits = [`- ${n.label}(${n.change}${n.done ? ",已落实" : ""}): ${n.summary}`];
          if (n.before) bits.push(`原来:${n.before}`);
          if (n.comments?.length) bits.push(`用户评论:${n.comments.join(" / ")}`);
          if (n.symbolRef) bits.push(`[连接 ${n.symbolRef.file ?? ""}#${n.symbolRef.name}]`);
          const line = bits.join(" | ");
          // 变更集派发:每个节点后跟一行「改动:」(人一眼能看出这条为什么被派下来)
          return mode === "whole" ? line : `${line}\n  改动:${describeChange(n.id)}`;
        })
        .join("\n");
      // 关系:整板=原逻辑;变更集只留「两端都在本次派发集里」的边(否则会把没派下去的节点连进来造成误解)
      const shownIds = new Set(shownNodes.map((n) => n.id));
      const edgesShown = (mode === "whole" ? doc.edges : doc.edges.filter((e) => shownIds.has(e.from) && shownIds.has(e.to))).slice(0, LIMIT);
      const userComments = doc.nodes.filter((n) => n.comments?.length).length;
      const scopeLine = mode === "whole"
        ? "本次为整板派发(未检测到人工改动):以下为整板当前内容"
        : `本次只派**人工改动的 ${shownNodes.length} 个节点**(共 ${dispatchedNodes.length} 个待派,rev ${doc.rev})` +
          (mode === "selection" ? "(人从界面选区派发)" : "(人改板后保存的变更集)") +
          (missingIds.length ? `;选区里 ${missingIds.join(",")} 已不在板上,已跳过` : "");
      const instruction =
        `【按白板继续实施】设计白板「${doc.title}」(rev ${doc.rev},状态 ${doc.status},已落实 ${doc.nodes.filter((n) => n.done).length}/${doc.nodes.length})。\n` +
        `${scopeLine}:\n` +
        `${nodeLines}\n` +
        (truncated > 0 ? `(已达 ${LIMIT} 条上限,已截断 ${truncated} 个节点未列出;需要时用 board_read 读全板)\n` : "") +
        (edgesShown.length ? `关系:${edgesShown.map((e) => `${e.from}->${e.to}${e.label ? "(" + e.label + ")" : ""}${e.virtual ? "[虚拟边·人工标注待核实]" : ""}`).join(", ")}\n` : "") +
        (msg.note ? `用户的调整要求:${msg.note}\n` : "") +
        (userComments ? `白板上有 ${userComments} 个节点带用户评论(见上方各行「用户评论:」),优先按评论修正。\n` : "") +
        "请按这版白板继续实施/修正代码;如有新的结构变化,先用 board_upsert 更新白板再动手。";
      const prevTask = tm.get(msg.taskId);
      // 幂等(C7):同一 rev 同一派发面只立一个任务(防双击/重连重发)。
      // 变更集/选区派发把节点集排序后拼进键:同一 rev 下两个不同选区是两个意图,不能被去重掉;
      // 整板派发保持原格式(向后兼容,C7 旧行为不变)。
      const dispatchIds = mode === "whole" ? [] : [...new Set(shownNodes.map((n) => n.id))].sort();
      const idempotencyKey = dispatchIds.length
        ? `board-continue:${msg.taskId}:rev${doc.rev}:${dispatchIds.join(",")}`
        : `board-continue:${msg.taskId}:rev${doc.rev}`;
      const task = tm.submit("user", msg.sessionId, instruction, {
        idempotencyKey,
        ...(prevTask?.projectId !== undefined ? { projectId: prevTask.projectId } : {}),
      });
      // 变更集派发成功即清空 humanEdits(避免同一次人工改动被反复派下去);不动 rev——
      // 清空是记账不是改板,不制造 baseRev 冲突。清空落盘失败只留痕,不影响已派发的任务。
      if (humanIds.length > 0) {
        const cleared = await saveBoardAsync(boardRoot, { ...doc, humanEdits: { ids: [], rev: doc.rev }, updatedAt: 0 }, { skipGates: true });
        if (!cleared.ok) console.error(`[board] continue 清空 humanEdits 失败: ${msg.sessionId}/${msg.taskId} ${cleared.reason}`);
        else bus.emit("board.changed", { sessionId: msg.sessionId, taskId: msg.taskId });
      }
      journal.append({
        kind: "board.update", sessionId: msg.sessionId,
        payload: {
          taskId: msg.taskId, rev: doc.rev, title: doc.title, nodeCount: doc.nodes.length, edgeCount: doc.edges.length,
          status: doc.status, by: "continue", continueTaskId: task.id, continueScope: mode, dispatchedIds: dispatchIds,
        },
      });
      safeSend(ws, { v: PROTOCOL_VERSION, type: "task.submitted", task });
      break;
    }
 // 工作流板:编译预览(只编译不跑,错误 fail-visible 列出)。
    case "board.workflow.compile": {
      const { loadBoardAsync } = await import("./board-store.js");
      const { compileWorkflowBoard } = await import("./board-workflow.js");
      const doc = await loadBoardAsync(repoRoot(), msg.sessionId, msg.taskId);
      if (!doc) { safeSend(ws, { v: PROTOCOL_VERSION, type: "board.workflow.compile.result", sessionId: msg.sessionId, taskId: msg.taskId, ok: false, errors: ["白板不存在"] }); break; }
      const r = compileWorkflowBoard(doc);
      safeSend(ws, r.ok
        ? { v: PROTOCOL_VERSION, type: "board.workflow.compile.result", sessionId: msg.sessionId, taskId: msg.taskId, ok: true, script: r.script, order: r.order }
        : { v: PROTOCOL_VERSION, type: "board.workflow.compile.result", sessionId: msg.sessionId, taskId: msg.taskId, ok: false, errors: r.errors });
      break;
    }
 // 工作流板:编译执行(编译失败直接回 result.errors;成功=异步跑,进度 board.workflow.progress 广播,
    // 终态 board.workflow.result 广播;先回一发 compile.result 让面板拿到编译产物)。
    case "board.workflow.run": {
      const { loadBoardAsync } = await import("./board-store.js");
      const { compileWorkflowBoard, runWorkflowBoard, workflowBoardInflight } = await import("./board-workflow.js");
      const inflightWf = workflowBoardInflight(msg.taskId);
      if (inflightWf) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "board.workflow.result", sessionId: msg.sessionId, taskId: msg.taskId, wfId: inflightWf, ok: false, errors: ["该板已有运行在途(" + inflightWf + "),等它结束再跑"] });
        break;
      }
      const doc = await loadBoardAsync(repoRoot(), msg.sessionId, msg.taskId);
      if (!doc) { safeSend(ws, { v: PROTOCOL_VERSION, type: "board.workflow.result", sessionId: msg.sessionId, taskId: msg.taskId, wfId: "-", ok: false, errors: ["白板不存在"] }); break; }
      const pre = compileWorkflowBoard(doc);
      if (!pre.ok) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "board.workflow.result", sessionId: msg.sessionId, taskId: msg.taskId, wfId: "-", ok: false, errors: pre.errors });
        break;
      }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "board.workflow.compile.result", sessionId: msg.sessionId, taskId: msg.taskId, ok: true, script: pre.script, order: pre.order });
      // executor 可缺:纯确定性流(script/test/condition/parallel/notify)照跑;wf-agent 节点运行期显式失败(红态 fail-visible)。
      // 异步执行(不阻塞 WS handler);journal 留痕+广播由 runner 承担。
      void runWorkflowBoard({
        root: repoRoot(), journal, doc,
        ...(opts.executor ? { executor: opts.executor } : {}),
        broadcast: (m) => { opts.broadcast?.(m as import("@lampgenie/protocol").ServerMessage); },
        ...(opts.workflowAskRouter ? { workflowAskRouter: opts.workflowAskRouter } : {}),
      }).catch((err) => {
        console.error("[board-workflow] run 失败:", String(err).slice(0, 200));
        opts.broadcast?.({ v: PROTOCOL_VERSION, type: "board.workflow.result", sessionId: msg.sessionId, taskId: msg.taskId, wfId: "-", ok: false, errors: [String(err).slice(0, 300)] });
      });
      break;
    }
    case "board.overlay.save": {
      // 空 dataB64=删除(面板「清空」同步语义);非空=PNG 校验后落盘
      const { saveOverlayAsync, deleteOverlayAsync } = await import("./board-store.js");
      if (msg.dataB64 === "") {
        await deleteOverlayAsync(repoRoot(), msg.sessionId, msg.taskId);
        break;
      }
      const ok = await saveOverlayAsync(repoRoot(), msg.sessionId, msg.taskId, msg.dataB64);
      if (!ok) safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.BoardOverlayInvalid, message: "批注图不合法(非 PNG 或超 4MB)" });
      break;
    }
    case "board.overlay.get": {
 // 会话级批注拉取(落盘语义:无语义板时 taskId=__session__,笔迹跟会话走)
      const { loadOverlayAsync } = await import("./board-store.js");
      const dataB64 = await loadOverlayAsync(repoRoot(), msg.sessionId, msg.taskId);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "board.overlay.result", sessionId: msg.sessionId, taskId: msg.taskId, ...(dataB64 ? { dataB64 } : {}) });
      break;
    }
    // 节点评论(五期):查看态追加——服务端合并进板(免 rev 冲突,agent 并发 board_upsert 不丢评论)。
    // c1(编辑/删除):op=update/delete 按 index 改/删**同节点已有评论**;持久化形状不变(node.comments
    // 仍是纯字符串数组,index 即面板渲染顺序的下标)。三种 op 都走 rev+1 → save → 回执 → board.changed;
    // 但 update/delete 是「修订」不是「新待办」,不再 notePendingComment(未处理评论标记只属 append)。
    case "board.comment": {
      const { loadBoardAsync, saveBoardAsync } = await import("./board-store.js");
      const doc = await loadBoardAsync(repoRoot(), msg.sessionId, msg.taskId);
      if (!doc) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.BoardNotFound, message: "白板不存在" });
        break;
      }
      const node = doc.nodes.find((n) => n.id === msg.nodeId);
      if (!node) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.BoardNodeNotFound, message: `节点不存在 ${msg.nodeId}` });
        break;
      }
      const op = msg.op ?? "append";
      const newText = (msg.text ?? "").trim().slice(0, 500);
      if (op === "append") {
        if (!newText) {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.CommentTextEmpty, message: "评论内容为空" });
          break;
        }
        node.comments = [...(node.comments ?? []), newText].slice(-20); // 20 上限只作用于 append
      } else {
        const list = node.comments ?? [];
        const idx = msg.index;
        if (idx === undefined || !Number.isInteger(idx) || idx < 0 || idx >= list.length) {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.CommentIndexOutOfRange, message: `评论下标越界:${String(idx)}(该节点 ${list.length} 条)` });
          break; // 不动盘
        }
        if (op === "update") {
          if (!newText) {
            safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.CommentTextEmpty, message: "评论内容为空" });
            break;
          }
          const next = [...list];
          next[idx] = newText; // 就地替换:条数与顺序不变,不触发 20 条截断
          node.comments = next;
        } else {
          const next = [...list];
          next.splice(idx, 1); // 移除该条,其余顺序不变
          node.comments = next;
        }
      }
      doc.rev = doc.rev + 1; // saveBoard 不自增 rev(调用方语义):评论也是一次板上变更,bus 广播方据此感知
      const r = await saveBoardAsync(repoRoot(), doc);
      if (!r.ok) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.BoardInvalid, message: r.reason });
        break;
      }
      journal.append({ kind: "board.update", sessionId: msg.sessionId, payload: { taskId: msg.taskId, rev: r.doc.rev, title: r.doc.title, nodeCount: r.doc.nodes.length, edgeCount: r.doc.edges.length, status: r.doc.status, by: "comment" } });
 // 评论闭环:登记待提示,agent 下一步 loop tips 主动带出(注入即消费,不自动开轮)
      // c1:只有 append 才算「新待办」——改/删是用户自己收拾旧评论,不该再唤起 agent 回应。
      if (op === "append") {
        const { notePendingComment } = await import("./board-comments.js");
        notePendingComment({ sessionId: msg.sessionId, taskId: msg.taskId, nodeId: msg.nodeId, text: newText });
      }
      // 回执先于广播(七期竞态修复):bus 先到会把面板按旧 boardTaskId 拉回旧板
      safeSend(ws, { v: PROTOCOL_VERSION, type: "board.doc", sessionId: msg.sessionId, taskId: msg.taskId, doc: r.doc, links: [] });
      bus.emit("board.changed", { sessionId: msg.sessionId, taskId: msg.taskId });
      break;
    }
    // 从代码生成模块图(七期):code-sense 把 file 的符号整理成工作流模块节点+真实调用边。
    // 读路径纪律:loadIndex 只读(允许过期),重建走 ensureIndex fork——绝不主进程构建(L-130)。
    case "board.fromcode": {
      const storeRoot = repoRoot();
      const workRoot = opts.projects?.resolveWorkdir(msg.projectId) ?? storeRoot;
      try {
        const { loadIndex, fileToModules } = await import("@lampgenie/code-sense");
        const c2f = await import("@lampgenie/code-sense/callgraph/c2f");
        const index = loadIndex(workRoot);
        if (!index) {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.BoardNoIndex, message: "调用索引未就绪(首次构建需几分钟,稍后再试)" });
          break;
        }
        if (c2f.indexStale(workRoot, index)) {
          const { ensureIndex } = await import("./sense-index-manager.js");
          void ensureIndex(workRoot).catch(() => {}); // 过期也降级生成,fork 刷新供下次
        }
        const rel = index.byFile[msg.file] !== undefined
          ? msg.file
          : Object.keys(index.byFile).find((f) => f === msg.file || f.endsWith("/" + msg.file) || f.endsWith(msg.file));
        if (!rel) {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.BoardFileNotIndexed, message: `文件不在索引里:${msg.file}` });
          break;
        }
        const mods = fileToModules(index, rel);
        if (mods.nodes.length === 0) {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.BoardFileEmpty, message: `该文件没有可整理的符号:${rel}` });
          break;
        }
        const { saveBoardAsync, loadBoardAsync } = await import("./board-store.js");
        const tid = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "_").slice(-40);
        // review 抓:taskId 用「尾 24 字符」两文件可碰撞互相覆盖;改用全路径 hash 防撞;
        // rev 续接已有板(+1)并保留节点评论——重生成不静默清掉用户已写的评论
        const { createHash } = await import("node:crypto");
        const taskId = "code-" + createHash("sha1").update(workRoot + "/" + rel).digest("hex").slice(0, 16);
        const existing = await loadBoardAsync(storeRoot, msg.sessionId, taskId);
        const r = await saveBoardAsync(storeRoot, {
          version: 1, taskId, sessionId: msg.sessionId,
          title: "代码模块图:" + rel.split("/").slice(-1)[0],
          status: "draft", rev: (existing?.rev ?? 0) + 1, root: workRoot,
          nodes: mods.nodes.map((n) => ({
            id: tid(n.id), kind: n.kind, label: n.label, summary: n.summary, change: "keep",
            done: false, comments: existing?.nodes.find((x) => x.id === tid(n.id))?.comments ?? [],
            symbolRef: { name: n.symbolRef.name, file: n.symbolRef.file, line: n.symbolRef.line },
            flow: [],
          })),
          edges: mods.edges.slice(0, 120).map((e) => ({ from: tid(e.from), to: tid(e.to), kind: "call" as const, label: ":" + e.line })),
          planned_files: [rel],
          updatedAt: 0,
        });
        if (!r.ok) {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.BoardInvalid, message: r.reason });
          break;
        }
        journal.append({ kind: "board.update", sessionId: msg.sessionId, payload: { taskId, rev: r.doc.rev, title: r.doc.title, nodeCount: r.doc.nodes.length, edgeCount: r.doc.edges.length, status: r.doc.status, by: "fromcode" } });
        // 回执先于广播(七期竞态修复):面板先收 doc 更新 boardTaskId,广播随后刷新同板
        safeSend(ws, { v: PROTOCOL_VERSION, type: "board.doc", sessionId: msg.sessionId, taskId, doc: r.doc, links: [], crossFileTargets: mods.crossFileTargets });
        bus.emit("board.changed", { sessionId: msg.sessionId, taskId });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.BoardFromcodeFailed, message: String(err).slice(0, 200) });
      }
      break;
    }
 // code-sense 分析产物 → 可编辑语义板:modulemap(全仓模块依赖聚合)/archmap(LLM 架构图)/
    // sequence(符号静态时序,需 query)/pageflow(页面流)。读路径纪律同 fromcode(loadIndex 只读不 kick)。
    case "board.fromsense": {
      const storeRoot = repoRoot();
      const workRoot = opts.projects?.resolveWorkdir(msg.projectId) ?? storeRoot;
      try {
        const bs = await import("./board-sense.js");
        const cs = await import("@lampgenie/code-sense");
        let built: { title: string; nodes: import("@lampgenie/protocol").BoardDoc["nodes"]; edges: import("@lampgenie/protocol").BoardDoc["edges"]; planned_files?: string[] } | null = null;
        let failMsg = "";
        /** decision 源的内容寻址 taskId(其它源走 sense-<sha1(source|query)> 旧口径)。 */
        let taskIdOverride: string | null = null;
        if (msg.source === "modulemap") {
          const index = cs.loadIndex(workRoot);
          if (!index) failMsg = "调用索引未就绪(首次构建需几分钟,稍后再试)";
          else {
            built = bs.moduleMapBoard(index);
            if (!built.nodes.length) { built = null; failMsg = "模块结构为空(无可索引文件)"; }
          }
        } else if (msg.source === "sequence") {
          if (!msg.query) failMsg = "时序板需要符号名(query)";
          else {
            // 轻链:索引 byName 定位符号文件 → 单文件 ts-morph 时序提取;不走 debug 剖面的全量懒图
 // (懒图 20s+/共享机超窗经验证——fromsense 是交互通道,重活必须最小化)。
            const index = cs.loadIndex(workRoot);
            if (!index) { failMsg = "调用索引未就绪(首次构建需几分钟,稍后再试)"; break; }
            const ids = index.byName[msg.query] ?? [];
            const file = (ids[0] ?? "").split("#")[0];
            if (!file) { failMsg = `符号「${msg.query}」不在索引里`; break; }
            const sq = await import("@lampgenie/code-sense/sequence/index");
            const seq = await sq.sequenceOfSymbol(workRoot, [file], msg.query.split(".").pop() ?? msg.query);
            if (!seq || !seq.steps.length) failMsg = `符号「${msg.query}」函数体内无调用语句可提时序`;
            else built = bs.sequenceBoard(msg.query, file, seq);
          }
        } else if (msg.source === "pageflow") {
          const r = await cs.codeSense(workRoot, msg.query ?? "", { mode: "ui" });
          if (!r.pageflow || !r.pageflow.pages.length) failMsg = "页面流为空(未检出路由/页面结构)";
          else built = bs.pageFlowBoard(r.pageflow);
        } else if (msg.source === "decision") {
 // 控制流板:点一个符号 → 它在什么条件下走哪条路(真分支树,不信口描述)。
          // 落盘=**内容寻址**:taskId 取自「相对文件路径 + 函数名 + 分支点指纹」——同内容重复请求
          // 落同一块板(rev 递增、评论保留),符号/代码一改指纹即变→自然生成新板(过期图自动失效,
          // 不手工清理旧板)。fail-soft:扫描异常/无分支点仍出「无分支点」单节点板,不打挂整个 fromsense。
          const dec = await import("@lampgenie/code-sense/sensing/decision");
          const { createHash } = await import("node:crypto");
          const symArg = (msg.symbol ?? "").trim();
          const fnArg = (msg.fn ?? "").trim();
          const qArg = (msg.query ?? "").trim();
          const fileArg = (msg.file ?? "").trim();
          const isFileish = (s: string) => /\.(py|ts|tsx|js|jsx|mjs|cjs|c|h|cc|cpp|hpp|java|go)$/i.test(s);
          const LOCATE_MSG = "控制流板需要定位参数:file=源文件相对路径(可配 symbol/fn 指定函数),或 symbol/query=符号名(按调用索引定位文件)";
          if (!symArg && !fnArg && !qArg && !fileArg) {
            failMsg = LOCATE_MSG;
          } else {
            const nameArg = symArg || qArg; // 符号名(含 query 形态)
            let rel = "";
            if (fileArg) rel = fileArg;
            else if (isFileish(qArg)) rel = qArg;
            else if (isFileish(symArg)) rel = symArg;
            else if (nameArg) {
              const index = cs.loadIndex(workRoot);
              const ids = index?.byName[nameArg] ?? index?.byName[nameArg.split(".").pop() ?? ""] ?? [];
              const f = (ids[0] ?? "").split("#")[0];
              if (!f) failMsg = `符号「${nameArg}」未定位到源文件(可加 file=相对路径直接指定)`;
              else rel = f;
            }
            if (!failMsg && !rel) {
              failMsg = LOCATE_MSG;
            }
            if (!failMsg) {
              // 规范化成仓内相对路径(./ 前缀、绝对路径前缀都剥掉;扫描与落盘 key 同一口径)
              rel = rel.replace(/\\/g, "/").replace(/^\.\//, "");
              const abs = workRoot.replace(/\\/g, "/").replace(/\/+$/, "");
              if (rel.startsWith(abs + "/")) rel = rel.slice(abs.length + 1);
              const fnName = fnArg || (nameArg && !isFileish(nameArg) ? (nameArg.split(".").pop() ?? "") : "");
              let points: import("@lampgenie/code-sense/sensing/decision").DecisionPoint[] = [];
              let note = "";
              try {
                const scan = await dec.scanDecisionFile(workRoot, rel);
                if (!scan) note = "源文件读不到或该类型不做分支扫描";
                else if (scan.points.length === 0) note = "该文件无 if/while/for/switch";
                else points = scan.points;
              } catch (e) {
                note = "分支扫描异常:" + String(e).slice(0, 60);
              }
              const scoped = fnName ? points.filter((p) => (p.fn ?? "") === fnName) : points;
              const usePts = scoped.length > 0 ? scoped : points; // fn 名对不上=按全部点建板(不出误导空板)
              if (fnName && points.length > 0 && scoped.length === 0) note = `函数「${fnName}」在该文件里没有分支点`;
              const head = (symArg || fnName || rel || "控制流").replace(/\\/g, "/");
              const spec = {
                ...(symArg || fnName ? { symbol: symArg || fnName } : {}),
                ...(fnName ? { fn: fnName } : {}),
                points: usePts,
                // 扫描降级/无点原因写进标题:人一眼看出「这板为什么是空的」,不静默出空板
                ...(note ? { title: `控制流板:${head} · ${note}` } : {}),
              };
              const board = bs.decisionsBoard(spec);
              built = { title: board.title, nodes: board.nodes, edges: board.edges, ...(rel ? { planned_files: [rel] } : {}) };
              // 分支点指纹:内容变(条件/行界/深度/调用/归属函数)→ 指纹变 → taskId 变 → 新板
              const fp = createHash("sha1").
                update(usePts.map((p) => [p.kind, p.lineStart, p.lineEnd, p.depth, p.condition ?? "", p.loopTarget ?? "", p.loopIterates ?? "", (p.calls ?? []).join(","), p.fn ?? ""].join("~")).join("\n")).
                digest("hex").slice(0, 12);
              taskIdOverride = "decision-" + createHash("sha1").update(rel + "|" + fnName + "|" + fp).digest("hex").slice(0, 16);
            }
          }
        } else {
          // archmap:LLM 架构图;无 archLlm 注入时 plan 剖面只有静态模块结构——显式降级不冒充
          const r = await cs.codeSense(workRoot, msg.query ?? "整体架构", { mode: "plan" });
          if (!r.architecture || !(r.architecture.nodes as unknown[]).length) {
            const deg = (r.degraded ?? []).find((d) => d.layer === "archmap" || d.layer === "arch");
            failMsg = "架构图未产出(LLM 未配置或生成失败" + (deg ? ":" + deg.reason : "") + ")——可改用 modulemap 模块依赖板";
          } else {
            built = bs.archGraphBoard({ nodes: r.architecture.nodes, edges: r.architecture.edges } as never, "");
          }
        }
        if (!built) {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.BoardFromsenseFailed, message: failMsg.slice(0, 200) });
          break;
        }
        const { saveBoardAsync, loadBoardAsync } = await import("./board-store.js");
        const { createHash } = await import("node:crypto");
        const taskId = taskIdOverride
          ?? "sense-" + createHash("sha1").update(workRoot + "|" + msg.source + "|" + (msg.query ?? "")).digest("hex").slice(0, 16);
        const existing = await loadBoardAsync(storeRoot, msg.sessionId, taskId);
        const commentOf = new Map((existing?.nodes ?? []).map((n) => [n.id, n.comments ?? []]));
        const isDecision = msg.source === "decision";
        const r = await saveBoardAsync(storeRoot, {
          version: 1, taskId, sessionId: msg.sessionId,
          title: built.title, status: "draft", rev: (existing?.rev ?? 0) + 1, root: workRoot,
          // 控制流板走 design(design 渲染链已通:节点 flow 渲染真分支树);页面结构板/工作流板各有 kind
          ...(isDecision ? { docKind: "design" as const } : {}),
          nodes: built.nodes.map((n) => ({ ...n, comments: commentOf.get(n.id) ?? n.comments ?? [] })),
          edges: built.edges,
          planned_files: built.planned_files ?? [],
          updatedAt: 0,
        });
        if (!r.ok) {
          safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.BoardInvalid, message: r.reason });
          break;
        }
        journal.append({ kind: "board.update", sessionId: msg.sessionId, payload: { taskId, rev: r.doc.rev, title: r.doc.title, nodeCount: r.doc.nodes.length, edgeCount: r.doc.edges.length, status: r.doc.status, by: "fromsense" } });
        // 回执先于广播(七期竞态修复)
        safeSend(ws, { v: PROTOCOL_VERSION, type: "board.doc", sessionId: msg.sessionId, taskId, doc: r.doc, links: [] });
        bus.emit("board.changed", { sessionId: msg.sessionId, taskId });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.BoardFromsenseFailed, message: String(err).slice(0, 200) });
      }
      break;
    }
    case "exp.list": {
      if (!opts.experience) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "经验库未启用" });
        break;
      }
      safeSend(ws, { v: PROTOCOL_VERSION, type: "exp.list.result", items: opts.experience.index(), disabled: opts.experience.disabled?.() ?? [] });
      break;
    }
    case "exp.view": {
      if (!opts.experience) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "经验库未启用" });
        break;
      }
      const body = opts.experience.view(msg.category, msg.name);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "exp.view.result", category: msg.category, name: msg.name, body });
      break;
    }
    case "exp.remove": {
      if (!opts.experience || !opts.experience.remove) { safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "经验库删除未启用" }); break; }
      // 走注入面(同 exp.list/view;不直构 repoRoot store——测试/多项目注入会绕过)
      try {
        const ok = opts.experience.remove(msg.category, msg.name);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "exp.remove.result", category: msg.category, name: msg.name, ok });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.ExpFailed, message: String(err).slice(0, 150) });
      }
      break;
    }
    case "sys.meta":
      safeSend(ws, { v: PROTOCOL_VERSION, type: "sys.meta.result", meta: opts.sysMeta ?? {} });
      break;
    case "cfg.get": {
      if (!opts.cfg) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "配置通道未启用(生产入口 main.ts 才有)" });
        break;
      }
      const v = opts.cfg.view();
      safeSend(ws, { v: PROTOCOL_VERSION, type: "cfg.get.result", ...v });
      break;
    }
    case "cfg.secret.status": {
      if (!opts.cfg) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "配置通道未启用(生产入口 main.ts 才有)" });
        break;
      }
      const names = Array.isArray(msg.names) ? (msg.names as unknown[]).map(String).slice(0, 20) : [];
      try {
        const keys = opts.cfg.secretKeys ? opts.cfg.secretKeys() : [];
        safeSend(ws, { v: PROTOCOL_VERSION, type: "cfg.secret.result", op: "status", rid: msg.rid, items: names.map((name) => ({ name, exists: keys.includes(name) })) });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "cfg.secret.result", op: "status", ok: false, rid: msg.rid, error: String(err).slice(0, 160) });
      }
      break;
    }
    case "cfg.secret.set": {
      if (!opts.cfg) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "配置通道未启用(生产入口 main.ts 才有)" });
        break;
      }
      const name = String(msg.name || "");
      const value = typeof msg.value === "string" ? msg.value : "";
      try {
        if (!opts.cfg.secretSet) throw new Error("密钥写入未启用(生产入口 main.ts 才提供)");
        const r = opts.cfg.secretSet(name, value);
        // 只回 name/existed;绝不回 value。
        safeSend(ws, { v: PROTOCOL_VERSION, type: "cfg.secret.result", op: "set", ok: true, rid: msg.rid, name, existed: r.existed });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "cfg.secret.result", op: "set", ok: false, rid: msg.rid, name, error: String(err).slice(0, 160) });
      }
      break;
    }
    case "cfg.set": {
      if (opts.cfg && opts.cfg.view().readOnly) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.CfgSetFailed, message: "配置只读:服务端以 GENIE_PANEL_READONLY/panelReadOnly 运行,禁止修改配置" });
        break;
      }
 // plan 互斥(ZCode applyRuntimeExecutionState 语义):切 plan 时存在 active goal→拒。
      {
        const patchMode = (msg.patch as { permissions?: { mode?: string } } | undefined)?.permissions?.mode;
        if (patchMode === "plan") {
          const { readGoal } = await import("@lampgenie/runtime/agent/goal");
          const sessions = new Set(journal.readAll().filter((e) => e.kind === "goal.set").map((e) => e.sessionId));
          for (const sid of sessions) {
            const g = readGoal(journal, sid);
            if (g && g.status === "active") {
              safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.PlanGoalMutex, message: `Plan and Goal cannot be active at the same time.(会话 ${sid} 有进行中的目标;/goal clear 后再切)` });
              break;
            }
          }
        }
      }
      if (!opts.cfg) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "配置通道未启用(生产入口 main.ts 才有)" });
        break;
      }
      try {
        const r = opts.cfg.set(msg.patch);
 // audio.tts 热更(音色选择):tts 客户端闭包捕获旧 voice/model——清缓存,
        // 下次 voice.tts 按新配置重建(音色/模型热生效,与重启等价)。
        if ((msg.patch as { audio?: { tts?: unknown } }).audio?.tts) ttsClientCache = null;
        safeSend(ws, { v: PROTOCOL_VERSION, type: "cfg.set.result", ...r });
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.CfgSetFailed, message: String(err).slice(0, 300) });
      }
      break;
    }
    case "models.list": {
      if (!opts.listModels) {
 // 错误码域化对齐——面板 models 错误分支按 /models/ 前缀匹配,通用 "not-implemented"
        // 会漏接(#models-status 滞留「拉取中…」)并落通用 toast 兜底双报;改 "models-not-implemented"
        // 与 "models-list-failed" 同族,panel 内联状态行 fail-visible 不滞留。
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.ModelsNotImplemented, message: "模型列表未启用(生产入口 main.ts 才有)" });
        break;
      }
      try {
        const ids = await opts.listModels(msg.providerId);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "models.list.result", ids, ...(msg.providerId ? { providerId: msg.providerId } : {}), ...(msg.probeOnly ? { probeOnly: true } : {}) });
      } catch (err) {
 // 失败面分类(无 Provider/端点未配置/缺凭证/上游失败),未分类异常仍回
        // models-list-failed(旧码兼容);message 是可操作提示(去哪个设置页做什么)。
        const mapped = modelsErrorOf(err);
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: mapped.code, message: mapped.message });
      }
      break;
    }
    case "session.model.set": {
      // per-session 主模型覆盖:set=先校验(Registry 预检)后落盘 + journal 记 model.switch;
      // 校验失败(routeError)或 CAS 不符 → 回 session.model.result ok:false 且不写盘。
      // 不热切全局 provider、不动全局 config(设置页 cfg.set 语义保持独立)。
      if (!opts.sessionModels) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "会话模型覆盖未启用(生产入口 main.ts 才有)" });
        break;
      }
      try {
        const r = await opts.sessionModels.set({
          sessionId: msg.sessionId,
          model: msg.model ?? null,
          ...(msg.providerId ? { providerId: msg.providerId } : {}),
          // m7:effort 透传(null=清除该字段回全局;缺省不传=旧客户端语义,保持现有覆盖不变)
          ...(msg.effort !== undefined ? { effort: msg.effort } : {}),
          ...(msg.expectedRevision !== undefined ? { expectedRevision: msg.expectedRevision } : {}),
        });
        // 广播:多标签/多客户端同会话 pill 同步(旧=只回发起 socket,另一标签看不到生效值)
        broadcastSessionModel({ ...r, sessionId: msg.sessionId }, ws, opts);
      } catch (err) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.SessionModelSetFailed, message: String(err).slice(0, 200) });
      }
      break;
    }
    case "session.model.get": {
      if (!opts.sessionModels) {
        safeSend(ws, { v: PROTOCOL_VERSION, type: "error", code: ErrorCode.NotImplemented, message: "会话模型覆盖未启用(生产入口 main.ts 才有)" });
        break;
      }
      const r = opts.sessionModels.get(msg.sessionId);
      // get 只回发起连接(拉取式查询);payload 与 set 回包同构(ok/revision 齐备)
      safeSend(ws, { v: PROTOCOL_VERSION, type: "session.model.result", sessionId: msg.sessionId, modelOverride: r.modelOverride, ok: true, revision: r.revision });
      break;
    }
    case "session.owner.get": {
      // 会话→owner 项目桥(归属漂移根治):已绑定事实 > 最早一条带 projectId 的任务;
      // 无任务/无归属=null。前端另一路已按 {sessionId, projectId} 字面契约实现。
      const owner = sessionOwnerOf(journal, tm, msg.sessionId);
      safeSend(ws, { v: PROTOCOL_VERSION, type: "session.owner.result", sessionId: msg.sessionId, projectId: owner ?? null });
      break;
    }
    case "ping":
      safeSend(ws, { v: PROTOCOL_VERSION, type: "pong", time: Date.now() });
      break;
    default: {
 // :allowlist 登记了但 switch 没有实现(对拍测试会先失败)——不静默逃生:
      // 回 permission-denied 并留 journal,与「表外 channel」同一出口。
      const ch = String((msg as { type?: unknown }).type ?? "unknown");
      denyChannel(ws, journal, clientModeByWs.get(ws) ?? DEFAULT_CLIENT_MODE, ch, msg as { sessionId?: unknown });
      break;
    }
  }
}

/** fixF4: 全扫让步分片:大 journal(生产环境 30MB/28k 行)上单次同步逐条加工会独占事件循环数百 ms,
 * ws 心跳 ping/pong 排队延迟→面板判死重连。分片间 setImmediate 让一拍(毫秒级),单拍同步段
 * 缩到 ~ms 量级。仅用于低频残余全扫路径(checkpoint.list/trace.stats 等;status 高频路径已由
 * F1 per-session 索引根治,不再走 readAll)。 */
async function scanChunked<In, Out>(items: readonly In[], make: (batch: readonly In[]) => Out[], chunkSize = 4_000): Promise<Out[]> {
  const out: Out[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const batch = items.slice(i, Math.min(items.length, i + chunkSize));
    out.push(...make(batch));
    if (i + chunkSize < items.length) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return out;
}

/** fixF1→ 异步化:文件尾部按字符取(避开整文件读),读末 maxChars×4 字节(utf-8 每码点≤4B),
 * 解码后首字符若是截断产生的替换符则丢掉,再取末 maxChars 字符——与旧「全量读+slice(-N)」口径一致。
 * 文件缺席/不可读=undefined(与旧 catch 口径一致,面板按无 tail 渲染)。
 * 卡顿修复:fs/promises 异步读(不阻塞事件循环)+ 1.5s TTL 缓存(session.status 3s 轮询 ×
 * 多会话同文件的重复 9p 读合并;缓存条目在 TTL 内直接复用,过期或缺失走一次异步读)。 */
const subTailCache = new Map<string, { at: number; text?: string }>();

/** session.status 投影 memo(晚间饥饿事故; 增量化改造):
 * 水位=**会话当前最大 seq**(不是 length:seq 全局递增、跨会话有洞,length≠maxSeq,禁止混比),
 * 加累积 projection + 跨批携带态(carry:todo 是否见过/未成对 compactStart/已见 wfId 集)+
 * 每 wfId 的 ask 水位(wfAsks,workflows[].asks 的唯一跨会话依赖)+ rows 窗口侧车 seq。
 * 客户端带 sinceSeq=watermark 时只归约新事件;容量 64 会话(超限淘汰最旧),对象只读复用
 * (safeSend 只序列化不改写;增量路径每次替换为新对象,不原地改 prev)。 */
const sessionStatusMemo = new Map<string, {
  watermark: number;
  /** 已见 wfId 集的排序快照(全量路径的 memo 命中判据,沿用改造前口径)。 */
  wfKey: string;
  projection: ReturnType<typeof import("@lampgenie/runtime/session/projection").projectSession>;
  carry: import("@lampgenie/runtime/session/projection").ProjectionCarry;
  wfAsks: Map<string, { count: number; seq: number }>;
}>();

/** 事件数组的当前最大 seq(空数组=0)。seq 全局递增:跨会话有洞,故水位一律用 max 而非 length。 */
function maxSeqOf(events: { seq: number }[]): number {
  let max = 0;
  for (const e of events) if (e.seq > max) max = e.seq;
  return max;
}

/** trace.stats 投影 memo(深度优化):同 session.status 的水位范式——水位=会话事件数。
 * 经验证依据:readAll.filter(sid) median 12.2ms(28 万条全库引用过滤,同步占事件循环);
 *  改 readSession(sid) 索引后 2.62ms;再上层级 memo,事件不变时面板 2s 轮询的稳态成本≈0。
 *  容量 64 会话(超限淘汰最旧);结果对象只读复用(safeSend 只序列化不改写)。 */
const traceStatsMemo = new Map<string, { watermark: number; stats: ReturnType<typeof import("@lampgenie/runtime/agent/trace-stats").deriveTraceStats> }>();
async function readTailCharsCached(file: string, maxChars: number, ttlMs = 1500): Promise<string | undefined> {
  const hit = subTailCache.get(file);
  if (hit && Date.now() - hit.at < ttlMs) return hit.text;
  const text = await readTailCharsAsync(file, maxChars);
  if (subTailCache.size > 200) subTailCache.clear(); // 有界:极端多子代理时整清(冷读一次,语义不变)
  subTailCache.set(file, { at: Date.now(), text });
  return text;
}
async function readTailCharsAsync(file: string, maxChars: number): Promise<string | undefined> {
  const fsp = await import("node:fs/promises");
  try {
    const st = await fsp.stat(file);
    if (st.size <= 0) return "";
    const readLen = Math.min(st.size, maxChars * 4);
    const fh = await fsp.open(file, "r");
    try {
      const buf = Buffer.alloc(readLen);
      const { bytesRead } = await fh.read(buf, 0, readLen, st.size - readLen);
      let text = buf.toString("utf-8", 0, bytesRead);
      if (text.charCodeAt(0) === 0xfffd) text = text.slice(1); // 半截多字节字符丢弃
      return text.slice(-maxChars);
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}

/** fixF3: 发送背压高水位(2MB)——超过即认定客户端消费不动(慢网/后台标签页定时器节流)。 */
const SEND_BUFFER_HIGH = 2 * 1024 * 1024;

/** fixF3: 丢行/告警策略(纯函数,单测直测)。drop=丢弃可丢类(stream llm-delta 打字机帧——终稿由
 * journal 承接,丢帧只损失打字机平滑);send=正常必发;send-warn=必发+告警(≥5s 一条,防日志风暴)。 */
export function wsSendPolicy(bufferedAmount: number, data: unknown, now: number, lastWarnAt: number): "send" | "drop" | "send-warn" {
  if (bufferedAmount <= SEND_BUFFER_HIGH) return "send";
  const msg = data as { type?: string; ev?: { type?: string } };
  if (msg?.type === "stream" && msg.ev?.type === "llm-delta") return "drop";
  return now - lastWarnAt >= 5_000 ? "send-warn" : "send";
}

/** fixF3: per-connection 最近一次背压告警时刻(限速告警用)。 */
const wsLastWarnAt = new WeakMap<WebSocket, number>();

/**
 * board.diagram 出图节流(2026-11):面板每次重渲都请求,同板重复算 SVG 无意义。
 * 同 sessionId+taskId(+theme)1500ms 内复用上次结果;内存 Map 最多 32 条,先进先出剔除。
 * 键用 \0 分隔(sid/taskId 是自由串,逗号等分隔符可能出现在其中)。
 */
const BOARD_DIAGRAM_CACHE_TTL_MS = 1_500;
const BOARD_DIAGRAM_CACHE_MAX = 32;
const boardDiagramCache = new Map<string, { at: number; theme: string; frame: Record<string, unknown> }>();

/** 出图过滤参数的规范化串(作缓存 key 尾段):writers 去重排序、foldMin 缺省归一;
 *  全缺省=不过滤 → 返回空串,caller 拼 key 时整段省略(既有 key 逐字不变)。 */
function boardDiagramFilterKey(filter: { writers?: string[]; foldGroups?: boolean; foldMin?: number } | undefined): string {
  if (!filter) return "";
  const writers = Array.isArray(filter.writers) ? [...new Set(filter.writers)].sort() : [];
  const parts: string[] = [];
  if (writers.length > 0) parts.push(`w=${writers.join(",")}`);
  if (filter.foldGroups === true) parts.push(`f=${typeof filter.foldMin === "number" ? filter.foldMin : 5}`);
  return parts.join(";");
}

function boardDiagramCacheGet(key: string, theme: string): Record<string, unknown> | null {
  const hit = boardDiagramCache.get(key);
  if (!hit) return null;
  if (hit.theme !== theme || Date.now() - hit.at > BOARD_DIAGRAM_CACHE_TTL_MS) {
    boardDiagramCache.delete(key);
    return null;
  }
  return hit.frame;
}

function boardDiagramCacheSet(key: string, theme: string, frame: Record<string, unknown>): void {
  if (boardDiagramCache.size >= BOARD_DIAGRAM_CACHE_MAX && !boardDiagramCache.has(key)) {
    // 先进先出:Map 保持插入序,删最早的键。
    const oldest = boardDiagramCache.keys().next().value;
    if (oldest !== undefined) boardDiagramCache.delete(oldest);
  }
  boardDiagramCache.set(key, { at: Date.now(), theme, frame });
}

/** g3(2026-11):WS 发送字节账本(进程级单点)——safeSend 是唯一 stringify 后 ws.send 处,
 *  也是唯一计数点;周期落账见 flushWsLedger(30s,零帧跳过)。 */
const wsByteLedger = new WsByteLedger();

function safeSend(ws: WebSocket, data: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const frameType = (data as { type?: string } | null | undefined)?.type;
  // fixF3: 旧实现不查 bufferedAmount——慢客户端上发送无限积压,内存与拥塞反噬所有连接
  // (「子任务一多面板卡+流式断」的放大器之一)。现超 2MB 时丢可丢类、必发类限速告警。
  const policy = wsSendPolicy(ws.bufferedAmount, data, Date.now(), wsLastWarnAt.get(ws) ?? 0);
  if (policy === "drop") {
    // g3:丢帧不实发(故不 stringify——大帧 stringify 正是 OOM 崩点,丢帧路径必须保持零分配),
    // 但仍计入账本的 dropped 口径,避免「账本看不见被丢掉的帧型」。
    wsByteLedger.record(frameType ?? "", 0, true);
    return;
  }
  if (policy === "send-warn") {
    wsLastWarnAt.set(ws, Date.now());
    console.error(`[gateway] ws 发送积压超 2MB(慢客户端),必发消息仍投递(type=${(data as { type?: string }).type ?? "?"})`);
  }
  // g3:只 stringify 一次——同一份 text 既用于字节计量(Buffer.byteLength = 实发 UTF-8 字节)
  // 又用于 ws.send,不做二次序列化。
  const text = JSON.stringify(data);
  wsByteLedger.record(frameType ?? "", Buffer.byteLength(text));
  ws.send(text);
}

/**
 * commands.list.result 载荷:内置(catalog)在前 + 自定义在后(去重:同名内置不再出现在自定义段)。
 * 自定义同名的剔除本该由 CommandStore 完成(它有保留名拦截),这里再做一次兜底,
 * 防测试装配注入的假 command store 不带保留名逻辑时把内置条目顶掉。
 */
function mergedCommandList(commands: GatewayServerOptions["commands"]): {
  commands: { name: string; body?: string; description?: string; inputHint?: string; source: "builtin" | "custom"; path?: string }[];
  diagnostics: { path: string; severity: "warning" | "error"; message: string; code?: string; commandName?: string }[];
} {
  const custom = commands
    ? (commands.listWithDiagnostics?.() ?? { commands: commands.list(), diagnostics: [] })
    : { commands: [], diagnostics: [] };
  const builtin = BUILTIN_COMMANDS.map((c) => ({
    name: c.name,
    description: c.description,
    ...(c.inputHint ? { inputHint: c.inputHint } : {}),
    source: "builtin" as const,
  }));
  const builtinNames = new Set(builtin.map((c) => c.name));
  const diagnostics = [...(custom.diagnostics ?? [])];
  const customItems = custom.commands
    .filter((c) => {
      if (!builtinNames.has(c.name.toLowerCase())) return true;
      diagnostics.push({
        path: c.path ?? "",
        severity: "warning" as const,
        code: ErrorCode.CustomCommandReservedName,
        commandName: c.name,
        message: `自定义命令与内置命令同名,已忽略:/${c.name}(内置优先)`,
      });
      return false;
    })
    .map((c) => ({
      name: c.name,
      // r4(ZCode custom-command-shell-expansion 语义):custom body 的 !`cmd` 片段在此展开
      // (bash -c / 3s 超时 / stdout 截 2000 / 失败标注 / 每 body ≤3 处)。
      // list 时展开,面板零改动,协议不变;内置段无 body 不受影响。upsert/remove 后的
      // 刷新回包同走本函数,面板缓存到的 customCommands 即已展开形态(零改动的前提)。
      ...(c.body !== undefined ? { body: expandShellSnippets(c.body, repoRoot()) } : {}),
      ...(c.description ? { description: c.description } : {}),
      ...(c.inputHint ? { inputHint: c.inputHint } : {}),
      source: "custom" as const,
      ...(c.path ? { path: c.path } : {}),
    }));
  return { commands: [...builtin, ...customItems], diagnostics };
}

function projectListMessage(projects: ProjectRegistry): { v: 1; type: "project.list.result"; projects: { id: string; path: string; label: string; availability: ProjectAvailability; purpose?: "project" | "conversation" }[]; activeProjectId: string } {
  return {
    v: PROTOCOL_VERSION as 1,
    type: "project.list.result",
 // 补 purpose(面板按它过滤 conversation 型;漏带=过滤失效,harness 内部项全显示)
    projects: projects.list().map((p) => ({ id: p.id, path: p.path, label: p.label, availability: p.availability, ...(p.purpose ? { purpose: p.purpose } : {}) })),
    activeProjectId: projects.activeId(),
  };
}
