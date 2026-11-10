/**
 * Gateway 主进程:DI 组合根。参照 qwen-audio-agent 的 gateway-application,
 * 把所有服务在这里显式接线,便于测试替换。
 */
import type { Server } from "node:http";
import * as os from "node:os";
import { join } from "node:path";
import { MemoryJournal, FileJournal, bus, type Config, type Journal } from "@lampgenie/core";
import { TaskSupervisor } from "./task-manager.js";
import { SessionActivityIndex } from "./session-activity.js";
import { taskIndexList } from "./task-index.js";
import { startGatewayServer, repairSessionProjectDrift } from "./server.js";
import { repairTailBeforeResume } from "./journal-tail-repair.js";
import { journalArchiveDirOf } from "./journal-maintenance.js";
import { createEffectQueue, relayActivityHandler, type EffectQueue } from "./effect-queue.js";
// 终态投递义务:启动回放 seed + 启动 sweep 一次(不自动重投,等连接)。
import { createDeliveryObligationStore, type DeliveryObligation } from "./delivery-obligation.js";
import { hasUserStoppedSince, appendUserStoppedMarker, USER_STOPPED_EVENT, USER_STOPPED_RESUME_MESSAGE } from "./user-stop-marker.js";
import { NodeConnections, NodeDispatch } from "./nodes.js";
import { ProjectRegistry, cleanupProjectTaskRefs, HARNESS_PROJECT_ID } from "./projects.js";
import { runSuperAgentTurn, SuperAgentChannel, SuperAgentActivity, buildSuperInbox } from "./super-agent.js";
import { MemoryStore } from "@lampgenie/runtime/agent/soul-memory";
import { PermissionBroker } from "./permission-broker.js";
import { AskUserRouter } from "./ask-user-router.js";
import { WorkflowAskRouter } from "./workflow-ask-router.js";
import { AutomationStore, AutomationScheduler } from "./automations.js";
import { setPermissionMode } from "./permission-mode.js";
import { applyPreset, currentPresetName, presetKnobsOf, resolvePreset, setCurrentPresetName } from "./permission-presets.js";
import { CommandStore, type CommandRoot } from "./commands-store.js";
import { HookStore, runHookEvent, type HookEvent } from "./hooks.js";
import { McpServerStore, McpManager } from "./mcp.js";
import { disabledBuiltins, setBuiltinDisabled } from "./skills-admin.js";
import { PluginSystem } from "./plugins.js";
import { parseRemoteProject, probeRemoteProject } from "./remote-project.js";
import { remoteGit } from "./ssh-ops.js";
import { ProjectProfileIndex } from "./project-profile.js";
import { createStreamRelay } from "./stream-relay.js";
import { genBootstrapCommand, pickLanAddress } from "./remote-wizard.js";
import { mergeSkillIndexWith } from "@lampgenie/experience";
import { NodeRegistry } from "./nodes.js";
import { wireExecutor } from "./executor-wiring.js";
import { wireAgentLoop, getExperienceStore, TOOL_HINTS, ensureSubagentWatchdog, maybeContinueGoal, writeBarrierOf, imageOffloadOf } from "./agent-wiring.js";
import { readGoalFromJournal } from "@lampgenie/runtime/agent/goal";
import { createSessionWorkerHost, type SessionWorkerHost } from "./session-worker-host.js";
// fixD2/D3:团队 issue 双通道 + P2P 直连(app 装配根接线)。
import { IssueService } from "./issue-service.js";
import { TeamP2P } from "./team-p2p.js";
import { configureSessionSearch, closeSessionSearch, defaultSessionSearchCacheFile } from "./session-search.js";
import { otelExporterFromEnv } from "@lampgenie/runtime/agent/otel-exporter";
import { TaskPermissionGuard } from "@lampgenie/runtime/task/permission-policy";
import { createMemoryWiring, type MemoryWiring } from "@lampgenie/memory";
import { buildAudioChatFromConfig, buildModelProviders } from "./factory.js";
import { createRouter } from "./router/index.js";
import { createSessionModelApi, createSessionModelFace, type SessionModelStore } from "./session-model.js";
import type { EffectiveModel } from "./model-switch.js";
import { permissionMode } from "./permission-mode.js";
import { join as joinPath } from "node:path";
import { repoRoot } from "./repo-root.js";
import { sampleLoad } from "./load-sample.js"; // 节点 Fleet 真实负载(旧硬编码恒零)
import { PROTOCOL_VERSION } from "@lampgenie/protocol";
import { TEMPLATES } from "@lampgenie/workflow";
import type { SubagentBackend } from "@lampgenie/executors";
import type { LlmProvider } from "@lampgenie/runtime/agent/loop";

export interface GatewayApp {
  taskManager: TaskSupervisor;
  nodes: NodeRegistry;
 /** 项目注册表。 */
  projects: ProjectRegistry;
  /** workflow ask 面板应答路由(F6;观察/测试面)。 */
  workflowAskRouter: WorkflowAskRouter;
 /** ask_user 问答路由(指挥台待答卡数据源;观察/测试面)。 */
  askUser: AskUserRouter;
 /** 定时自动化(观察/测试面)。 */
  automations: AutomationStore;
  automationScheduler: AutomationScheduler;
  /** journal(观察/测试面;评论卡等事件注入用)。 */
  journal: Journal;
 /** 持久效果队列(外部副作用先落账后执行;observation/测试面)。 */
  effectQueue: EffectQueue;
 /** OTel 导出器(GENIE_OTEL_ENDPOINT 门控,未配置=undefined)。 */
  otel?: { stats(): { spans: number; failures: number; pending: number }; stop(): void };
 /** 记忆接线:上下文块+会话终态学习。 */
  memory: MemoryWiring;
  /** 外部 HTTP server 模式:把 WS 挂到给定 server(panel 同端口用)。 */
  attachWs(server: Server): void;
  /** 独立端口模式(面板关闭时):WS 自己监听。 */
  listenStandalone(): void;
  close: () => Promise<void>;
}

/** config → browser 门禁/配置同源取用(2026-11 browser-ux-redo):enabled 缺省 true,
 *  idleMinutes/profile/profileDir/headless 从配置现读(热生效)。 */
export function browserCfgFrom(config: unknown): {
  enabled: () => boolean; allowDomains: () => string[];
  idleMinutes?: () => number; profile?: () => "persistent" | "ephemeral"; profileDir?: () => string; headless?: () => boolean;
} {
  /* 必须在每次调用时**现读** config.browser,不能把子对象捕获进闭包:cfg.set 走
   * `Object.assign(config, next)`(main.ts),它会整体替换 config.browser 为新对象——
 * 捕获旧子对象会让面板「一键启用浏览器」写完配置仍读到 enabled=false(2026-11 注意)。 */
  const live = () => (config as { browser?: { enabled?: boolean; allowDomains?: string[]; idleMinutes?: number; profile?: "persistent" | "ephemeral"; profileDir?: string; headless?: boolean } } | undefined)?.browser;
  return {
    enabled: () => live()?.enabled !== false,
    allowDomains: () => live()?.allowDomains ?? [],
    idleMinutes: () => live()?.idleMinutes ?? 30,
    profile: () => live()?.profile ?? "persistent",
    profileDir: () => live()?.profileDir ?? ".genie/browser-profile",
    headless: () => live()?.headless ?? (process.platform !== "win32" && process.platform !== "darwin"),
  };
}

export interface GatewayAppOptions {
  port: number;
  /** 会话日志目录;缺省 = 内存(测试用)。 */
  journalDir?: string;
  /** 已构造的 journal(生产 main 先 await loadChunked 再注入,避免同步冷启动阻塞)。 */
  journal?: Journal;
  /** executor 后端;缺省 = 不执行(任务停在 running)。 */
  executor?: SubagentBackend;
  /** LLM(coding 轨);与 executor 同时提供时,任务走主 agent loop。
 * super agent 指挥台对话模型 = 本字段(删除 companionLlm 独立轨)。 */
  llm?: LlmProvider;
  /** true=外部 HTTP server 模式(panel 同端口);false/缺省=立即独立监听 WS(旧行为)。 */
  useExternalHttp?: boolean;
 /** 主模型上下文窗口 tokens(自动压缩阈值+容量看板;main.ts 按轨取 config)。 */
  contextWindow?: number;
  /** TaskSupervisor 并发参数(配置驱动,packages/core ConfigSchema)。 */
  concurrency?: Partial<{ maxConcurrent: number; maxConcurrentPerOwner: number; maxConcurrentSystem: number }>;
  /** 生效配置(面板设置页「运行配置」数据源);缺省=cfg.* 报 not-implemented。 */
  config?: Record<string, unknown>;
  configSources?: Record<string, string>;
  /** 语音任务书 fetch 注入(voice.draft 测试用);缺省=全局 fetch。 */
  voiceDraftFetch?: typeof fetch;
  configProjectPath?: string;
  /** cfg.set 落盘与合并钩子(生产由 main 提供);缺省=只热应用不落盘。
   * envOccupied=被进程 env 层压住的键(重启也不生效,面板徽标据此说实话;甄别见 cfg-env-occupancy.ts)。 */
  onConfigSet?: (patch: Record<string, unknown>) => {
    applied: string[];
    needsRestart: string[];
    envOccupied?: string[];
    hotLlm?: Record<string, unknown>;
    /** 实际生效选择(面板展示;无密钥值)。 */
    effective?: EffectiveModel;
    warning?: string;
    routeError?: string;
    /** 角色 provider 热切完整参数(含 apiKey,仅内部使用,不得随回包下发)。 */
    roleHot?: Record<string, Record<string, unknown>>;
  };
 /** 预设一键接入:把用户 Key 写入 .genie/secrets.json(0600);缺省=密钥写入未启用。 */
  onSecretSet?: (name: string, value: string) => { existed: boolean };
 /** 密钥名列表(只返回名字,绝不返回值);设置页「是否覆盖」提示用。 */
  listSecrets?: () => string[];
  /** 角色模型 provider(压缩/评审);cfg.set 热项按路径前缀分发到对应 provider。 */
  models?: {
    compact?: LlmProvider & { update: (p: Record<string, unknown>) => void };
    review?: LlmProvider & { update: (p: Record<string, unknown>) => void };
    subagent?: LlmProvider & { update: (p: Record<string, unknown>) => void };
    digest?: LlmProvider & { update: (p: Record<string, unknown>) => void };
  };
  /** 端点模型列表(设置页模型选择器数据源);providerId=按该 provider 端点拉。 */
  listModels?: (providerId?: string) => Promise<string[]>;
  /** per-session 主模型覆盖 store(白板「per-session 主模型」;main load-once 注入):
   *  set/get 处理器与 agent 接线派生面都从这里出;缺省=session.model.* 报 not-implemented。 */
  sessionModels?: SessionModelStore;
 /** 辅助链轨:archLlm 导读/压缩/记忆 llmCall 走这条(生产=coding 轨);
   * 未提供时回退主轨(行为与旧版一致)。原样落 realtime 主轨=每任务 3 个 realtime 会话
   * (2×archLlm+1×主)+压缩触发再开——端点会话压力的结构性来源。 */
  auxLlm?: LlmProvider;
 /** 单模型探活( F4):设置页模型列表逐项「测」;生产由 main 注入(带端点/凭证解析)。 */
  probeModel?: (model: string, providerId?: string) => Promise<{ ok: boolean; ms: number; error?: string }>;
 /** 浏览器控制配置读取器(生产由 main 注入 live config 面)。 */
  browserConfig?: { enabled: () => boolean; allowDomains: () => string[]; idleMinutes?: () => number; profile?: () => "persistent" | "ephemeral"; profileDir?: () => string; headless?: () => boolean };
 /** 记忆库只读视图(生产由 main 注入 MemoryStore 面)。 */
  memoryView?: () => { user: string; memory: string; root: string; usage: { user: { used: number; limit: number }; memory: { used: number; limit: number } } };
  /** 主 agent 当前所在轨(audio.chat / coding 回退 / off),sysMeta 透出可观测。 */
  llmTrack?: string;
}

/** env CSV 标签解析:"a,b, c"→["a","b","c"];空串→[]。 */
function parseCsv(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function createGatewayApp(opts: GatewayAppOptions): GatewayApp {
  const journal = opts.journal ?? (opts.journalDir
 // write-behind+sharded:异步批量落盘解 9p 同步写阻塞;设计参考 ZCode(致谢) session-store
    // 按会话分文件(跨会话小 kind→global.jsonl,会话肥 kind→sessions/<sid>.jsonl,旧 gateway.jsonl
    // 冻结只读),内存为权威源,退出钩子清尾批。
    ? new FileJournal(`${opts.journalDir}/gateway.jsonl`, {
        writeBehind: true,
        sharded: true,
 // 归档会话冷读兜底(与 main.ts boot 装配同源,兜底构造不能漏)。
        archiveDir: journalArchiveDirOf(opts.journalDir),
      })
    : new MemoryJournal());
 // 归档冷读开关:兜底构造的 journal 在构造器里已同步 load 完,此处立即开启,
  // 保持「显式读会话可回读归档副本」的既有语义(main.ts 传 journal 时由 main 在其装配后开启)。
  if (!opts.journal && journal instanceof FileJournal) journal.enableArchiveReads();
 // 会话全文检索:只登记缓存路径,索引首次查询才构建(不占启动时间);
  // 缓存随 journalDir 隔离——测试临时目录不会污染生产索引。
  configureSessionSearch(journal, { cacheFile: defaultSessionSearchCacheFile(opts.journalDir) });

 // 持久效果队列:外部副作用先落 effect 行(commit 后才执行),崩溃后可折叠恢复。
  // 本轮只接 team 活动推送这一处真实外部面;其它推送/通知保持原路径不变。
  const effectQueue = createEffectQueue({ journal });
  effectQueue.register("relay.activity", relayActivityHandler(
    () => (globalThis as { __teamView?: { notifyActivity(projectId: string, category: string, type: string, summary: string): void } }).__teamView));

  const taskManager = new TaskSupervisor(opts.concurrency ?? {});

 // OTel 远端上报:env 门控 opt-in,未配置零开销;失败 fail-soft 不碰主链。
  const otelExporter = otelExporterFromEnv();
  if (otelExporter) otelExporter.attach(journal);
 // 会话状态服务端推送:任务变化即广播 sessionId,面板即时刷新(轮询留作断线兜底)。
  taskManager.onChange((task) => {
    broadcastRaw({ v: 1, type: "session.status.changed", sessionId: task.sessionId });
 // Plan 审批流(ZCode ExitPlanMode 语义):plan 模式任务完成→落计划文件+广播审批。
    if (task.state === "done" && permissionMode() === "plan") {
      void (async () => {
        const { readFileSync: rf, mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
        const { join: j } = await import("node:path");
        const planDir = j(repoRoot(), ".genie", "plans");
        mk(planDir, { recursive: true });
        const planPath = j(planDir, `plan-${task.sessionId}.md`);
        // 计划正文=该会话最后一条 agent 消息(四阶段提示词要求以「## 实施计划」收尾)。
        const lastAgent = [...journal.readAll()].reverse().find((e) => e.sessionId === task.sessionId && e.kind === "message.agent");
        const plan = String((lastAgent?.payload as { text?: string }).text ?? "").slice(0, 60_000);
        if (!plan.trim()) return;
        wf(planPath, plan, "utf-8");
        journal.append({ kind: "plan.saved", sessionId: task.sessionId, payload: { taskId: task.id, path: planPath, chars: plan.length } });
        broadcastRaw({ v: 1, type: "plan.approval.request", sessionId: task.sessionId, taskId: task.id, planPath, planExcerpt: plan.slice(0, 600) });
      })().catch(() => { /* 审批面故障不碰任务链 */ });
    }
  });

  // 宕机恢复:从 journal 回放重建任务登记表(payload 即任务快照,按 id 取最后态)。
  // agentTurns(会话累计 assistant 轮数)= interrupted 回执「中断前进度」数据源,提升到本层
  // 供下方自动恢复窗共用(两处消费,同一遍回放,不为回执再读一遍 journal)。
  const agentTurns = new Map<string, number>();
 // :用户停止标记索引(sessionId → 最近一次停止时刻)。与下面启动回放同一遍 readAll 收集,
  // restore / autoResume 都按它判,不额外扫 journal(journal 已 35MB 级)。
  const userStoppedAt = new Map<string, number>();
 // 会话最近活动时间索引。与下面的回放同一遍 readAll 累加(不为回执再读一遍 journal;
  // 冷会话事件由 readAll 的冷回读补齐),timeline 事实源=journal 事件 time。
  const sessionActivity = new SessionActivityIndex();
 // 终态投递义务快照(与任务快照同一遍 readAll 收集;journal 已 35MB,不扫第二遍)。
  const deliverySeeds: DeliveryObligation[] = [];
  {
 // 「这些删不掉」根治:先扫墓碑(task.deleted)建已删 id 集——删除此前只落内存,
 // journal 里一条删除事件都没有,回放把删掉的任务全复活(经验证 235 条全回来)。
    // 单次遍历同时收集墓碑集与任务快照(code_review findings:两次 readAll 让启动回放解析翻倍;
    // journal 已 35MB/3.5 万行,没必要扫两遍)。墓碑判定在遍历结束后统一做——
    // 墓碑事件与任务事件混在同一条流里,顺序无关(删除是终态意图)。
    const dead = new Set<string>();
    const snapshots = new Map<string, import("@lampgenie/core").Task>();
    for (const ev of journal.readAll()) {
 // 同一遍顺带累计会话最近活动时间(白名单 kind;见 session-activity.ts)。
      sessionActivity.noteEvent(ev);
 // 终态投递义务(后写覆盖前写;payload 即义务快照)。
      if (ev.kind === "delivery.obligation") {
        const ob = ev.payload as DeliveryObligation | undefined;
        if (ob && typeof ob.obligationId === "string") deliverySeeds.push(ob);
        continue;
      }
 // :用户停止标记(restore/autoResume 的判据;与回放同一遍收集)。
      if (ev.kind === "custom") {
        const up = ev.payload as { type?: unknown; at?: unknown } | undefined;
        if (up && up.type === USER_STOPPED_EVENT) {
          const at = typeof up.at === "number" ? up.at : ev.time;
          userStoppedAt.set(ev.sessionId, Math.max(userStoppedAt.get(ev.sessionId) ?? 0, at));
        }
        continue;
      }
      if (ev.kind === "message.agent") {
        agentTurns.set(ev.sessionId, (agentTurns.get(ev.sessionId) ?? 0) + 1);
        continue;
      }
      if (ev.kind === "task.deleted") {
        const dp = ev.payload as { taskIds?: unknown } | undefined;
        if (dp && Array.isArray(dp.taskIds)) for (const id of dp.taskIds) if (typeof id === "string") dead.add(id);
        continue;
      }
      if (!ev.kind.startsWith("task.")) continue;
      const p = ev.payload as import("@lampgenie/core").Task | undefined;
      if (!p || typeof p.id !== "string" || typeof p.state !== "string") continue;
      snapshots.set(p.id, p);
    }
    taskManager.markDeleted(dead);
    const restored = new Map([...snapshots].filter(([id]) => !dead.has(id))); // 墓碑命中不回填
    if (restored.size > 0) {
 // 用户用户反馈修复:收编结果回写 journal(终态快照)——旧实现收编只在内存,
      // journal 里仍留 running,每次重启重复收编(历史会话侧栏时间反复变「刚刚」)。
      const collectedTasks = taskManager.restore([...restored.values()], {
 // 清算回执:原任务书 id + sessionId + 中断前进度(状态机恢复语义)。
        receipt: (t) =>
          `网关重启中断(原任务书 ${t.id} / 会话 ${t.sessionId} / 中断前约 ${agentTurns.get(t.sessionId) ?? 0} 轮;可续跑)`,
 // :任务创建后该会话有用户停止标记 → 收编 cancelled(不注为 interrupted、不自动续跑)。
        userStopped: (t) => (userStoppedAt.get(t.sessionId) ?? -1) >= t.createdAt,
      });
      for (const ct of collectedTasks) {
        journal.append({ kind: "task.progress", sessionId: ct.sessionId, payload: ct });
      }
    }
  }

 // 网关终态投递义务表:启动 sweep 一次——超租约 attempting 回 pending(进程崩在发送中)、
  // attempts≥3 或首投起超 24h → failed;delivered 保持。不自动重投(无连接时不得 claim,
  // 补投发生在 hello 或在线周期 sweep)。
  const deliveryObligations = createDeliveryObligationStore({ journal, seed: deliverySeeds });
  const deliveryDue = deliveryObligations.sweep();
  if (deliveryDue.length) {
    console.error(`[gateway] 启动 sweep:${deliveryDue.length} 条终态投递义务待补投(有连接后重发)`);
  }

  // 任务变更落 journal,可追溯。
  taskManager.onChange((task) => {
    journal.append({
      kind: `task.${task.state === "queued" ? "enqueue" : task.state === "running" ? "start" : task.state === "done" ? "done" : task.state === "failed" ? "fail" : "progress"}`,
      sessionId: task.sessionId,
      payload: task,
      idempotencyKey: `task.${task.id}.${task.state}`,
    });
    bus.emit("task.changed", task);
 // 团队活动流:任务开始/终态上行 relay——改走持久效果队列:
    // 先落 effect 行(commit 后才执行),崩溃可折叠恢复;同类(同 kind)按入队顺序执行,
    // 同一 taskId 的连续状态变化折叠为最新 payload(替换而不重复上行)。
    if (task.state === "running" || task.state === "done" || task.state === "failed" || task.state === "cancelled") {
      const summary = String(task.instruction ?? task.id).slice(0, 120);
      void effectQueue.enqueue({
        kind: "relay.activity",
        key: task.id,
        payload: {
          projectId: "",
          category: "task",
          type: task.state,
          summary: `${task.state === "running" ? "开始" : task.state === "done" ? "完成" : "失败"}:${summary}`,
        },
      }).catch(() => { /* 持久化失败=本地零影响(红线);外部面 fire-and-forget */ });
    }
  });

 // 节点注册表先建:本机注册为 local 节点(修复:dispatch 在单机形态真实可选)。
  // 标签从 env(CSV);缺省无标签=local 只接无 reachability 要求的任务,防「假装分派」。
  const nodes = new NodeRegistry();
  const LOCAL_NODE_ID = "local";
  nodes.register({
    nodeId: LOCAL_NODE_ID,
    capabilities: parseCsv(process.env.GENIE_LOCAL_CAPABILITIES),
    reachability: parseCsv(process.env.GENIE_LOCAL_REACHABILITY),
  });
  const localHeartbeat = setInterval(() => {
 // 真实负载(旧硬编码 {0,0,0});runningTasks=运行中任务数。
    nodes.heartbeat(LOCAL_NODE_ID, sampleLoad(taskManager.list().filter((t) => t.state === "running").length));
  }, 30_000);
  localHeartbeat.unref?.();
  // 启动即采一次(否则新 boot 要等 30s 才有非零负载/心跳时间)。
  nodes.heartbeat(LOCAL_NODE_ID, sampleLoad(taskManager.list().filter((t) => t.state === "running").length));

 // 委派通道:连接表+调度器;node.register 登记,断开除名(server.ts)。
  const nodeConnections = new NodeConnections();
  const nodeDispatch = new NodeDispatch(nodes, nodeConnections);
 // 项目注册表(ZCode workspace 移植):默认项目=harness 本体。
  // 持久化跟随 journal 隔离语义:journalDir 在=同目录落盘;不在=会话内态(防测试实例共享仓库树污染)。
  const projects = new ProjectRegistry(
    repoRoot(),
    opts.journalDir ? join(opts.journalDir, "projects.json") : null);
 // 远程项目启动重探测(验证修复):load 启动期把 remote 重置 unavailable-remote-unverified
  // (远程不本地 statSync 的语义),而旧实现只在 project.add 触发探测——网关每次重启后面板恒「不可用」。
  // 启动后异步重探一轮(全部 remote 项目;失败=unreachable,菜单「重新探测」可手动再试)。
  setTimeout(() => {
    for (const p of projects.list()) {
      const remote = parseRemoteProject(p.path);
      if (!remote) continue;
      void probeRemoteProject(remote).then((ok) => {
        const entry = projects.list().find((x) => x.id === p.id);
        if (!entry) return;
        const target = ok ? "available" : "unavailable-remote-unreachable";
        if (entry.availability !== target) { entry.availability = target; projects.flush(); }
      }).catch(() => { /* 探测失败保持 unverified */ });
    }
  }, 4_000).unref?.();
 // 「已移除项目」残留 scrub:历史任务可能挂着已移除项目的 projectId
  // (移除清理上线前的存量/外部改动),启动期一次性清引用——会话保留,侧栏落「任务」分区;
  // 纠偏以专用事件 task.project.clear 落 journal(重启幂等:清过的任务 projectId 已空不再命中)。
  const scrubPids = [
    ...new Set(
      taskManager.list().map((t) => t.projectId).filter((x): x is string => !!x && !projects.has(x)),
    ),
  ];
  if (scrubPids.length > 0) {
    cleanupProjectTaskRefs(journal, (p) => taskManager.clearProjectRef(p), scrubPids);
  }
 // 存量归属漂移归位:旧序 explicit > owner 期间被贴错项目的任务回到会话 owner。
  // 放在 scrub 之后:先清掉已移除项目引用,再按在册 owner 归位(owner 已移除=不迁移)。
  try {
    const repairedN = repairSessionProjectDrift(journal, taskManager, projects);
    if (repairedN > 0) console.log(`[gateway] 会话归属纠偏:${repairedN} 个历史任务归位到所属会话 owner 项目`);
  } catch { /* 纠偏失败不阻塞启动(下次重启重试) */ }
 // 权限审批中介( B2):60s 无应答自动拒;广播通道在 server 创建后 attach。
 // 记忆接线(补全):harness-memory 上下文注入+会话终态学习;
  // 无 LLM=学习链关闭(fail-soft no-op),上下文注入照常(读文档是本地操作)。
  const memoryWiring: MemoryWiring = createMemoryWiring({
    root: joinPath(repoRoot(), ".genie", "memory"),
    ...(opts.llm ? {
      llmCall: async ({ system, user }: { system: string; user: string }) => {
 // 记忆学习链走辅助轨(coding),不占 realtime 主会话。
        const res = await (opts.auxLlm ?? opts.llm!).chat([{ role: "system", content: system }, { role: "user", content: user }], []);
        return res.content;
      },
    } : {}),
  });
  const permissionBroker = new PermissionBroker();
 // super agent 指挥台对话模型 = coding 主模型(opts.llm);companionLlm/companionTrack 已删除。
  // config.companion.track 仍可解析但被忽略——打一条日志告知(旧配置文件不报错)。
  if ((opts.config as { companion?: { track?: string } } | undefined)?.companion?.track !== undefined) {
    console.warn("[super] companion.track 已废弃,统一走 coding 主模型(opts.llm);该配置项被忽略");
  }
 // 会话级代答层:qwen permission-policy 组件接入审批链——
  // 面板「总是允许」= F2 规则(模式级)+ policy 登记(会话级)双写;env GENIE_PERM_POLICY=off 显式关闭。
  if (process.env.GENIE_PERM_POLICY !== "off") {
    const policy = new TaskPermissionGuard({
      // qwen TaskSupervisor.subscribe 形状适配:我们 TaskSupervisor.onChange 推 Task,政策只读 status。
      taskManager: {
        subscribe: (fn: (e: { task: { id: string; status: string; ownerId: string; sessionId: string } }) => void) =>
          taskManager.onChange((t) => fn({ task: { id: t.id, status: t.state === "done" ? "completed" : t.state, ownerId: "local", sessionId: t.sessionId } })),
      },
    } as unknown as ConstructorParameters<typeof TaskPermissionGuard>[0]);
    permissionBroker.policy = {
      shouldAutoAllow: (ownerId, sessionId, taskId) => policy.shouldAutoAllow(ownerId, sessionId, taskId),
      applyDecision: (ownerId, sessionId, decision, taskId) => policy.applyDecision(ownerId, sessionId, decision, taskId),
    };
  }
 // 定时自动化:store 持久化 .genie/automations.json;调度到点提交 system 任务。
  const automations = new AutomationStore(join(repoRoot(), ".genie", "automations.json"));
  const automationScheduler = new AutomationScheduler(
    automations,
 // scope 消费:项目级自动化按该项目 workdir 跑(taskId 带 projectId)。
    (a) => taskManager.submit("system", `auto-${a.id.slice(0, 8)}`, a.instruction, { title: "[自动] " + a.name, ...(a.scope && a.scope !== "global" ? { projectId: a.scope } : {}) }).sessionId,
    (e) => journal.append({ kind: "automation.run", sessionId: e.sessionId, payload: e }),
  );
  automationScheduler.start();
 // 终态任务自动归档(ZCode 自动归档阈值):每天检查;阈值热读(改配置下轮生效)。
  const archiveSweep = () => {
    const days = (opts.config as { tasks?: { autoArchiveDays?: number } } | undefined)?.tasks?.autoArchiveDays ?? 0;
    if (!days) return 0;
    const cutoff = Date.now() - days * 86_400_000;
    let n = 0;
    for (const t of taskManager.list()) {
      if (!t.archived && (t.state === "done" || t.state === "failed" || t.state === "cancelled") && t.updatedAt < cutoff) {
        if (taskManager.setArchived(t.id, true)) n++;
      }
    }
    return n;
  };
  const archiveTimer = setInterval(() => void archiveSweep(), 3_600_000);
  archiveTimer.unref?.();
  setTimeout(() => void archiveSweep(), 5_000).unref?.();

 // ---- 管理面装配 ----
  // 多根(ZCode roots.ts 语义):user 根 ~/.genie/commands(priority 10)+ project 根
  // <repoRoot>/.genie/commands(priority 20;同名时 project 覆盖 user)。home 为空则跳过 user 根。
  const home = os.homedir();
  const commandRoots: CommandRoot[] = [];
  if (home) commandRoots.push({ dir: join(home, ".genie", "commands"), priority: 10, source: "user" });
  commandRoots.push({ dir: join(repoRoot(), ".genie", "commands"), priority: 20, source: "project" });
  const commands = CommandStore.fromRoots(commandRoots);
  const hooks = new HookStore(join(repoRoot(), ".genie", "hooks.json"));
  const mcpStore = new McpServerStore(join(repoRoot(), ".genie", "mcp.json"));
  const mcp = new McpManager(mcpStore);
 // 项目档案管线:项目添加即异步建图;进度广播;任务终态→模块演进+防抖重建。
  const profiles = new ProjectProfileIndex(
    join(repoRoot(), ".genie", "profiles"),
    (pid) => projects.list().find((x) => x.id === pid)?.path,
    // LLM 导读:复用主 provider(archLlm 同源);无 llm=纯静态描述。
    opts.llm
      ? {
          chat: (messages: { role: string; content: string }[]): Promise<{ content: string }> =>
            opts.llm!.chat(messages as never, [], undefined) as Promise<{ content: string }>,
        }
      : undefined);
  const plugins = new PluginSystem(
    repoRoot(),
    (i) => mcpStore.add(i),
    (id) => { mcp.closeAll(); return mcpStore.remove(id); },
  );
  const wizardGen = (input: { kind: "ssh" | "docker"; host: string; user: string; port: number; nodeId: string }) => {
 // gateway 对外地址取本机 LAN IP(旧 hardcode 127.0.0.1——远程机拿到的 curl 地址不可达);
    // env GENIE_PUBLIC_HOST 一票覆盖(公网/域名部署场景);note 由向导自带说明。
    const host = pickLanAddress(
      Object.entries(os.networkInterfaces()).flatMap(([name, addrs]) =>
        (addrs ?? []).map((a) => ({ name, address: a.address, internal: a.internal, family: String(a.family) })),
      ),
      process.env.GENIE_PUBLIC_HOST);
    return genBootstrapCommand({ ...input, gatewayUrl: "ws://" + host + ":" + opts.port });
  };
 // 档案演进钩子:终态任务→diffstat 文件映射模块→recentChanges+防抖重建。
  // (与钩子运行器同一订阅点,独立去重键;diffstat 失败/无快照=只记任务不记文件。)
  const profileSeen = new Set<string>();
  taskManager.onChange((t) => {
    if (t.state !== "done" && t.state !== "failed") return;
    if (!t.projectId) return;
    const pid = t.projectId; // 闭包内保住窄化
    const key = "p:" + t.id;
    if (profileSeen.has(key)) return;
    profileSeen.add(key);
    if (profileSeen.size > 2000) profileSeen.clear();
    const root = projects.resolveWorkdir(pid);
    void (async () => {
      let files: { path: string }[] = [];
      let add = 0, del = 0;
      try {
        const svc = await import("./git-service.js");
        const ev = journal.readAll().filter((e) => e.kind === "checkpoint.create" && (e.payload as { taskId?: string }).taskId === t.id).at(-1);
        const sha = ev ? ((ev.payload as { sha?: string | null }).sha ?? null) : null;
 // 远端化:远程项目的 checkpoint(远端 git stash)→ diffstat 走远端 git --numstat
        const cpRemote = sha && ev ? parseRemoteProject(String((ev.payload as { root?: string }).root ?? "")) : null;
        if (sha && cpRemote) {
          const rg = await remoteGit(cpRemote, ["diff", "--numstat", sha]);
          if (!("error" in rg)) {
            for (const line of rg.stdout.split("\n")) {
              const mm = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
              if (!mm) continue;
              const a = mm[1] === "-" ? 0 : Number(mm[1]);
              const d = mm[2] === "-" ? 0 : Number(mm[2]);
              files.push({ path: mm[3]! });
              add += a; del += d;
            }
          }
        } else if (sha) {
          const st = await svc.diffstat(root, sha);
          files = st.files;
          add = st.total.add;
          del = st.total.del;
        }
      } catch {
        // diffstat 失败:只记任务
      }
      profiles.recordChange(pid, { taskId: t.id, title: t.title || t.instruction.slice(0, 40), files, add, del });
    })().catch(() => {});
  });
 // 白板收官钩子:任务 done →
  // ① checkpoint diffstat 回填板 actual_files(计划 vs 实际对账)+置 status=done;
  // ② 涉事仓索引后台重建(agent 改完码,code-index 结果跟着改——过期判定见 c2f 双段)。
 // F 修复(撤销三期 B1 的 HEAD 兜底):sha=null=无可信任务前基线,
 // diff HEAD 会把仓里他人/其他任务的在途改动算成「计划外」(共享仓经验证污染纯规划板 50 文件)。
  // 判定在 finalizeBoardOnTaskDone 内:判据=sha 有无(不看板 kind),null=跳过对账不翻 done,sha≠null 零改动。
  // fail-soft:任一环节炸都不碰任务链;ensureIndex 自身有 in-flight 去重与 fresh 短路。
  const boardDoneSeen = new Set<string>();
  taskManager.onChange((t) => {
    if (t.state !== "done") return;
    const key = "b:" + t.id;
    if (boardDoneSeen.has(key)) return;
    boardDoneSeen.add(key);
    if (boardDoneSeen.size > 2000) boardDoneSeen.clear();
    const workdir = projects.resolveWorkdir(t.projectId);
    void (async () => {
      const ev = journal.readAll().filter((e) => e.kind === "checkpoint.create" && (e.payload as { taskId?: string }).taskId === t.id).at(-1);
      const sha = ev ? ((ev.payload as { sha?: string | null }).sha ?? null) : null;
      const bs = await import("./board-store.js");
      const r = await bs.finalizeBoardOnTaskDone({ storeRoot: repoRoot(), sessionId: t.sessionId, taskId: t.id, workdir, sha });
      if (r.backfilled) bus.emit("board.changed", { sessionId: t.sessionId, taskId: t.id });
 // 设计沉淀:收官回填后,done 板登记进项目级沉淀索引(代码档案「设计沉淀」区数据源)。
      // 幂等:archiveDoneBoard 按 sessionId/taskId upsert,钩子重复触发不产生重复条目。
      await bs.archiveDoneBoardAsync(repoRoot(), t.sessionId, t.id, t.projectId ?? HARNESS_PROJECT_ID);
    })().catch(() => {});
  });
  // 钩子运行器:任务状态变化 → task.start/task.done/fail/cancel(按 (taskId,state) 去重;命令跑在项目根)。
  const hookSeen = new Set<string>();
  taskManager.onChange((t) => {
    const ev: HookEvent | null = t.state === "running" ? "task.start" : t.state === "done" ? "task.done" : t.state === "failed" ? "task.fail" : t.state === "cancelled" ? "task.cancel" : null;
    if (!ev) return;
    const key = t.id + ":" + t.state;
    if (hookSeen.has(key)) return;
    hookSeen.add(key);
    if (hookSeen.size > 2000) hookSeen.clear();
    const cwd = projects.resolveWorkdir(t.projectId);
    void runHookEvent(hooks, journal, ev, t, cwd).catch(() => {});
 // 验收钩子已下线:评审不是所有任务的验收面——
    // 非 coding 任务(规划/问答)done 也会弹代码评论卡;触发权交还 coding agent
    // (SYSTEM 复查纪律:coding 任务完成前主动调 code_review,非 coding 任务不调)。
  });
  // F6:workflow ask 面板应答路由(广播通道与 broker 同源,server 创建后 attach)。
  const workflowAskRouter = new WorkflowAskRouter((msg) => broadcastRaw(msg));
 // ask_user 面板问答(许愿式编程):主 agent 需求取舍时发问,面板直答。
  const askUserRouter = new AskUserRouter((msg) => broadcastRaw(msg));
  let broadcastRaw: (msg: Record<string, unknown>) => void = () => {};
 // 流式中继(ZCode 流式消息展示):loop onStream→80ms 合批→stream 消息广播。
  const streamRelay = createStreamRelay((msg) => broadcastRaw(msg));
 // (super agent 指挥台):super 通道——ask_user 转接(coding agent 提问经指挥台转述,
  // 答复经 relay_answer→askUserRouter.answer 回交,先答先用)+ 任务状态播报
  // (done/failed/cancelled/interrupted/blocked 注入 super 会话并广播 super.notice;
  //  interrupted/blocked/failed 额外广播 super.inbox.changed 让面板重拉 inbox)。
  // 广播先经 broadcastRaw 占位(ensureServer 前为 no-op)——服务未起时只落 journal 不广播,零行为差异。
  const superActivity = new SuperAgentActivity();
  const superSoul = opts.llm ? new MemoryStore(join(repoRoot(), ".genie", "soul", "memories")) : undefined;
  const superDeps = opts.llm
    ? {
        journal, taskManager, projects,
        llm: opts.llm,
        // fixC5: relay_answer 工具的答复回交(AskUserRouter.answer;失效=面板已先答)。
        askAnswer: (requestId: string, answer: string) => askUserRouter.answer(requestId, answer),
 // task_resume 工具的续跑回调(与 WS task.resume 同源:幂等重提同 session 续跑)。
        resumeTask: (taskId: string) => {
 // :用户停止过的任务不恢复(与 WS task.resume 同源判定;super 是第三个续跑入口)。
          const stoppedTask = taskManager.get(taskId);
          if (stoppedTask && hasUserStoppedSince(journal, { taskId: stoppedTask.id, sessionId: stoppedTask.sessionId, since: stoppedTask.createdAt })) {
            return { ok: false, reason: USER_STOPPED_RESUME_MESSAGE };
          }
 //  崩溃尾部修复:续跑前把未闭合 turn/step/tool.call 补合成终态(否则模型盲目重试有副作用的工具)。
          const repairNote = repairTailBeforeResume(journal, taskManager.get(taskId)?.sessionId);
          const resumed = taskManager.resumeInterrupted(taskId, (t) =>
            "【续跑】此前任务(" + t.id + ")被网关重启打断。请基于该会话已有进展(session 历史/工作区现状)继续完成原任务书,不要重做已完成部分:" +
            repairNote + "\n" + t.instruction);
          return resumed ? { ok: true, newTaskId: resumed.id } : { ok: false, reason: "任务当前状态不可续跑(仅 interrupted / 重启中断的 cancelled)" };
        },
        // 写前持久化屏障:与 coding agent 同一 config.agent.writeBarrier 口径(非法/缺席=undefined→loop 缺省 hard)。
        writeBarrier: writeBarrierOf((opts.config as { agent?: { writeBarrier?: "off" | "hard" } } | undefined)),
 //  图片 offload:与 coding 轨同根(默认开启;管家轮次带图时 provider 报图片预算错误可自愈)。
        imageOffload: imageOffloadOf(repoRoot()),
 // list_nodes 工具数据源(与 WS nodes.list 同源注册表+60s 心跳在线判定)。
        listNodes: () => nodes.list().map((n) => ({
          nodeId: n.nodeId,
          online: Date.now() - n.lastHeartbeat <= 60_000,
          capabilities: [...n.capabilities],
          reachability: [...n.reachability],
          runningTasks: n.load.runningTasks,
        })),
      }
    : undefined;
  const superChannel = superDeps && superSoul
    ? new SuperAgentChannel(superDeps, superSoul, { activity: superActivity, broadcast: (m) => broadcastRaw(m) })
    : undefined;
  if (superChannel) taskManager.onChange((t) => superChannel.onTaskChanged(t));
  askUserRouter.onAsk = (p) => superChannel?.relayAsk(p);
 // ASR(语音输入转写):config.audio.chat 同一 provider 一次 chat 调用(消息带 audio),
  // 提示「把这段语音逐字转写成文本,只输出文本」;未配置 audio.chat=undefined(server 回 VoiceUnavailable)。
  // 不在 super 链上产生人格设定与语音回播——转写文本由前端另行 super.turn 提交。
  const asrChatCfg = (opts.config as { audio?: { chat?: { model?: string; baseUrl?: string; providerId?: string } } } | undefined)?.audio?.chat;
  const asr = (opts.config && asrChatCfg && (asrChatCfg.model || asrChatCfg.baseUrl || asrChatCfg.providerId))
    ? (() => {
        let provider: LlmProvider | undefined;
        let built = false;
        return async (audio: { data: string; format?: "pcm16" }): Promise<string> => {
          if (!built) {
            built = true;
            provider = buildAudioChatFromConfig(opts.config as unknown as Config, repoRoot(), opts.configSources);
          }
          if (!provider) throw new Error("audio.chat(ASR)未配置");
          const res = await provider.chat(
            [{ role: "user", content: "把这段语音逐字转写成文本,只输出文本", audio: { data: audio.data, format: audio.format ?? "pcm16" } }],
            [],
          );
          return String(res.content ?? "").trim();
        };
      })()
    : undefined;
 // 档案进度广播:tick 节流(≥4% 或终态)。
  {
    let lastPct = new Map<string, number>();
    profiles.onProgress((p) => {
      const prev = lastPct.get(p.projectId) ?? -100;
      if (p.state !== "running" || p.progress - prev >= 4 || p.progress === 100) {
        lastPct.set(p.projectId, p.progress);
        broadcastRaw({ v: 1, type: "profile.progress", projectId: p.projectId, progress: p.progress, stage: p.stage, state: p.state });
      }
    });
  }

 // 会话 worker 进程化(设计参考 ZCode(致谢):一会话一进程):生产缺省开;VITEST/显式 off 回进程内。
  // worker 模式下 gateway 不跑 agent loop——TaskSupervisor 权威/队列照旧,running 任务 fork session-worker;
  // 巡检(watchdog)对象=镜像注册表(host 维护),journal/权限/MCP/流式经 IPC 中继。
  const sessionWorkerOn =
    process.env.GENIE_SESSION_WORKER === "force"
      ? true
      : process.env.GENIE_SESSION_WORKER === "off"
        ? false
        : process.env.VITEST
          ? false
          : ((opts.config as { agent?: { sessionWorker?: boolean } } | undefined)?.agent?.sessionWorker ?? true);

  if (opts.executor && opts.llm && sessionWorkerOn) {
    const bgAgentsMirror = (globalThis as { __bgAgents?: Map<string, { outputFile: string; status: string; sessionId: string; title?: string; model?: string; lastEventAt?: number; cancel?: () => unknown; spawnedAt?: number; deadlineAt?: number; ownerTask?: string }> }).__bgAgents
      ?? new Map<string, { outputFile: string; status: string; sessionId: string; title?: string; model?: string; lastEventAt?: number; cancel?: () => unknown; spawnedAt?: number; deadlineAt?: number; ownerTask?: string }>();
    (globalThis as { __bgAgents?: unknown }).__bgAgents = bgAgentsMirror;
 // M26续跑身份护栏(worker 形态):worker 内已禁本地续跑,续跑由网关 onTaskDone 发起,
    // 故「任务开工时的目标修订号」快照必须在网关侧维护——running 入表、终态取用并清理。运行期 goal 被
    // clear/replace(每条 goal.set 使 revision+1)→ 续跑被 GOAL_REVISION_STALE 拒,不会把旧任务进展接到新目标上。
    const goalRevisionAtTaskStart = new Map<string, number | null>();
    const workerHost: SessionWorkerHost = createSessionWorkerHost({
      taskManager,
      journal,
      permissionBroker,
      mcp,
      workflowAskRouter,
      askUserRouter,
      streamSink: streamRelay.push as (sessionId: string, ev: unknown) => void,
      bgAgentsMirror,
      repoRoot: repoRoot(),
      browserConfig: opts.browserConfig ?? (opts.config
        ? browserCfgFrom(opts.config)
        : { enabled: () => true, allowDomains: () => [] }),
      contextWindow: opts.contextWindow,
      setState: (task, to, result) => taskManager.setState(task, to, result),
      projects, // P0:项目表快照注入(worker resolveWorkdir 与网关同源)
      // P0:goal 续跑网关统一发起(worker 内已禁本地 submit——网关不可见+退出截杀);
      // 与进程内同参(tm/journal/llm),提交后续跑任务走正常队列→新 worker fork。
 // :带上该任务开工时的目标修订号(无快照/无目标=不传,保持旧行为)。
      onTaskDone: (task) => {
        const rev = goalRevisionAtTaskStart.get(task.id) ?? null;
        goalRevisionAtTaskStart.delete(task.id);
        void maybeContinueGoal(taskManager, journal, opts.llm!, task.sessionId, rev !== null ? { expectedRevision: rev } : {}).catch(() => {});
      },
    });
    const ranTasks = new Set<string>();
    taskManager.onChange((task) => {
      if (task.state === "cancelled") {
 // (session-worker 形态):取消同样先落「用户已停止」标记再通知 worker 停
        // (进程内形态由 agent-wiring 的 onChange 落;两条形态都必落,恢复侧才读得到)。
 // 只对真正跑过的任务落标记:续跑替代(resumeInterrupted 把原任务 cancelled)不是用户停止。
        if (ranTasks.has(task.id)) {
          appendUserStoppedMarker(journal, { taskId: task.id, sessionId: task.sessionId, source: "cancel" });
          ranTasks.delete(task.id);
        }
        goalRevisionAtTaskStart.delete(task.id);
        workerHost.cancelTask(task.id);
      } else if (task.state === "running") {
        ranTasks.add(task.id);
 // :开工快照目标修订号(每任务一次;无目标/读失败=null=终态不校验)。readSession 走会话索引切片。
        if (!goalRevisionAtTaskStart.has(task.id)) {
          try {
            goalRevisionAtTaskStart.set(task.id, readGoalFromJournal(journal.readSession(task.sessionId), task.sessionId)?.revision ?? null);
          } catch { goalRevisionAtTaskStart.set(task.id, null); }
        }
        workerHost.dispatch(task);
      }
    });
    ensureSubagentWatchdog(journal);
    // cfg.set 模型热切:广播给活 worker(当前任务继续,新任务新 worker 自动用新配置)。
    (globalThis as { __sessionWorkerHost?: unknown }).__sessionWorkerHost = workerHost;
    console.error(`[gateway] 会话 worker 模式:开启(每任务一进程;agent.sessionWorker 可关)`);
  } else if (opts.executor && opts.llm) {
    wireAgentLoop(taskManager, journal, opts.llm, opts.executor, nodes, opts.models, nodeDispatch, projects, permissionBroker, workflowAskRouter, askUserRouter, mcp,
      opts.browserConfig ?? (opts.config ? browserCfgFrom(opts.config) : undefined),
      streamRelay.push, memoryWiring, opts.auxLlm, opts.config as { agent?: { maxSteps?: number; compactThresholdTokens?: number; verifyOnStop?: string }; coding?: { lsp?: import("@lampgenie/lsp").LspSettings; llm?: { vision?: boolean }; vlm?: { baseUrl?: string; providerId?: string; model?: string; apiKeyEnv?: string } } } | undefined, opts.contextWindow,
      // per-session 主模型覆盖面(白板「per-session 主模型」):有 store+config 才注入;缺省=undefined(共享 llm 现状零变化)。
      opts.sessionModels && opts.config ? createSessionModelFace(opts.config as unknown as Config, repoRoot(), opts.sessionModels) : undefined);
  } else if (opts.executor) {
    wireExecutor(taskManager, journal, opts.executor, nodes, nodeDispatch, projects, permissionBroker);
  }

  // 面板设置页「数据与统计」元信息(静态快照 + 启动时刻,uptime 由前端推算)。
  const sysMeta: Record<string, unknown> = {
    executor: opts.executor?.kind ?? "none",
    llm: opts.llm ? "on" : "off",
    llmTrack: opts.llmTrack ?? (opts.llm ? "(未标注)" : "off"),
    repoRoot: repoRoot(),
    journal: opts.journalDir ?? "(memory)",
    startedAt: Date.now(),
    protocol: PROTOCOL_VERSION,
    tools: TOOL_HINTS,
    workflowTemplates: Object.keys(TEMPLATES),
    journalEvents: journal.readAll().length,
    version: process.env.GENIE_VERSION ?? "dev",
    node: process.version,
    proxy: {
      https: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "",
      http: process.env.HTTP_PROXY ?? process.env.http_proxy ?? "",
      no: process.env.NO_PROXY ?? process.env.no_proxy ?? "",
    },
    experienceRoot: opts.config && typeof (opts.config as { experience?: { root?: string } }).experience?.root === "string"
      ? (opts.config as { experience: { root: string } }).experience.root
      : ".genie/experiences",
  };

  // cfg 通道:热/冷分界(ZCode provider_config 热加载语义的裁剪版)。
  // 热项(llm.model/llm.timeoutMs)经 provider.update 即时生效;冷项落盘后由调用方决定重启。
  // 未装配 config(测试缺省)→ undefined,server 侧 cfg.* 报 not-implemented。
  const cfg = opts.config
    ? (() => {
        const live = () => structuredClone(opts.config!) as Record<string, unknown>;
        const llmHot = (opts.llm as { update?: (p: Record<string, unknown>) => void } | undefined)?.update?.bind(opts.llm);
        return {
          view: () => {
            const cfg = live();
            const gw = (cfg.gateway ?? {}) as { panelReadOnly?: boolean };
            return { config: cfg, sources: opts.configSources ?? {}, projectPath: opts.configProjectPath ?? "(未指定)", readOnly: gw.panelReadOnly === true };
          },
          set: (patch: Record<string, unknown>) => {
 // 权限预设原子绑定:合法性**先校验、后落盘**——未知预设在此抛错,cfg.set 回 error,
            // 配置文件与本进程状态都不变(不留半写);custom 合法(保留现状三旋钮,只把 preset 置 custom)。
            const permPatch = patch.permissions as { preset?: unknown; mode?: unknown } | undefined;
            const presetPatchRaw = typeof permPatch?.preset === "string" ? permPatch.preset.trim() : "";
            if (presetPatchRaw) resolvePreset(presetPatchRaw);
            const presetBefore = currentPresetName();
            const base = opts.onConfigSet
              ? opts.onConfigSet(patch)
              : { applied: [] as string[], needsRestart: [] as string[], envOccupied: [] as string[] };
            // 双轨热分发:coding.llm.* 与 audio.chat.* 都指向主 agent provider(轨切换需重启,模型热切共享实例);
            // coding.models.* 指向角色 provider。缺位=诚实降级 needsRestart。
            const codingPatch = patch.coding as Record<string, Record<string, unknown>> | undefined;
            const audioPatch = patch.audio as Record<string, Record<string, unknown>> | undefined;
            const modelsPatch = codingPatch?.models;
            const hotDone: string[] = [];
            const isMainTrack = (p: string) => p.startsWith("coding.llm.") || p.startsWith("audio.chat.");
 // providerId/baseUrl/apiKeyEnv 是冷项——同补丁含路由切换时绝不把模型热切到旧端点/旧凭证
            // (provider.update 只认 model/baseUrl 等,providerId/apiKeyEnv 不认;混热会造出「模型新、路由旧」)。
            const routeCold = (prefix: string) => base.needsRestart.some((p) => p === prefix + ".providerId" || p === prefix + ".baseUrl" || p === prefix + ".apiKeyEnv");
            const mainRouteCold = routeCold("coding.llm") || routeCold("audio.chat");
 // 跨端点热切:main 层已把新端点/凭证/协议解析成 update 可吃的具体值(hotLlm)。
            // 在场时路由类键不再算冷——provider 实例内部换 baseUrl/apiKey/apiType,下个任务即生效。
            const hotLlmPatch = (base as { hotLlm?: Record<string, unknown> }).hotLlm;
            const mainTrackTouched = base.applied.some(isMainTrack) || base.needsRestart.some(isMainTrack);
            for (const p of base.applied) {
              if (isMainTrack(p) && llmHot && (hotLlmPatch || !mainRouteCold)) hotDone.push(p);
              else if (p.startsWith("coding.models.compact.") && opts.models?.compact && !routeCold("coding.models.compact")) hotDone.push(p);
              else if (p.startsWith("coding.models.review.") && opts.models?.review && !routeCold("coding.models.review")) hotDone.push(p);
              else if (p.startsWith("coding.models.subagent.") && opts.models?.subagent && !routeCold("coding.models.subagent")) hotDone.push(p);
              else if (p.startsWith("coding.models.digest.") && opts.models?.digest && !routeCold("coding.models.digest")) hotDone.push(p);
 // 语音任务书:无 provider 实例,server 每次 voice.draft 现读 live config——
              // 全键(含 route)恒热,不该被标成 needsRestart 骗用户重启。
              else if (p.startsWith("coding.models.voice.")) hotDone.push(p);
            }
            // voice 的 route 键(providerId/baseUrl/apiKeyEnv)不在 HOT_CONFIG_PATHS,会落进 base.needsRestart;
            // 但语音链路是现读 live config 的——同样摘回 hotDone(回包组装处有 !hotDone.includes 过滤,
            // needsRestart 自然剔除),徽标不说假话。
            for (const p of base.needsRestart) if (p.startsWith("coding.models.voice.") && !hotDone.includes(p)) hotDone.push(p);
            if (llmHot && mainTrackTouched && (hotLlmPatch || !mainRouteCold)) {
              const ref = (hotLlmPatch ?? audioPatch?.chat ?? codingPatch?.llm ?? {}) as Record<string, unknown>;
 // O2:角色 provider(review/subagent 恒建、模型继承主轨)跟随主轨模型热切;
              // 显式配了 model 的角色 modelName≠主轨旧值,天然不跟。effort 不动——实例内已按角色定档
              // (main=implementationEffort,roles=xhigh),模型热切不改变 effort 行为。
              const prevMainModel = (opts.llm as { modelName?: string } | undefined)?.modelName;
              if (ref) llmHot(ref);
 // 主轨路由/模型变化后,按 Registry 语义重建角色 provider(review/subagent/compact),
              // 让「role 只配 model」也能解析到拥有该模型的 Provider;旧实现只按 modelName 跟随,跨端点时
              // review 仍打旧端点(review 配 deepseek 却继承智谱 baseUrl → 404)。重建失败保留旧实例(fail-soft)。
              let rolesRebuilt = false;
              const codingTouched = base.applied.some((p) => p.startsWith("coding.llm.")) || base.needsRestart.some((p) => p.startsWith("coding.llm."));
              if (opts.models && codingTouched) {
                try {
                  const rebuilt = buildModelProviders(opts.config as unknown as Config, repoRoot(), opts.configSources);
                  if (rebuilt.compact) opts.models.compact = rebuilt.compact as NonNullable<typeof opts.models.compact>;
                  if (rebuilt.review) opts.models.review = rebuilt.review as NonNullable<typeof opts.models.review>;
 // subagent 未显式配置时 factory 返回 undefined——无条件赋值,清掉旧独立实例,
                  // 后续 spawn 经 `models?.subagent ?? llm` 回退**新**主 provider(同模型同档位跟随热切)。
                  opts.models.subagent = rebuilt.subagent as typeof opts.models.subagent;
                  // 提炼模型(2026-11):未配置时 factory 返回 undefined——无条件赋值清掉旧实例,
                  // 调用方经 `models?.digest ?? models?.compact ?? auxLlm` 回退压缩模型。
                  opts.models.digest = rebuilt.digest as typeof opts.models.digest;
                  rolesRebuilt = true;
                } catch (err) {
                  console.warn("[gateway] 角色模型重建失败(保留旧实例):", String(err).slice(0, 200));
                }
              }
              const nextModel = typeof ref?.model === "string" ? ref.model : undefined;
              if (!rolesRebuilt && nextModel && prevMainModel) {
                for (const rp of [opts.models?.review, opts.models?.subagent]) {
                  const r = rp as { modelName?: string; update: (p: Record<string, unknown>) => void } | undefined;
                  if (r && r.modelName === prevMainModel) r.update({ model: nextModel });
                }
              }
              // 路由键(providerId/baseUrl/apiKeyEnv)在 hotLlm 在场时也算热应用,不能留在 needsRestart 里。
              for (const p of base.needsRestart) if (isMainTrack(p) && !hotDone.includes(p)) hotDone.push(p);
            }
            // 角色热切优先用 main 层按 Registry 解析出的完整参数(含 baseUrl/apiKey/apiType);
            // 缺省回落补丁原样(同端点只改 model 的旧路径)。
            const rolePatchOf = (role: "compact" | "review" | "subagent" | "digest") =>
              (base.roleHot?.[role] ?? modelsPatch?.[role]) as Record<string, unknown> | undefined;
            if (opts.models?.compact && hotDone.some((p) => p.startsWith("coding.models.compact.")) && rolePatchOf("compact")) opts.models.compact.update(rolePatchOf("compact")!);
            if (opts.models?.review && hotDone.some((p) => p.startsWith("coding.models.review.")) && rolePatchOf("review")) opts.models.review.update(rolePatchOf("review")!);
            if (opts.models?.subagent && hotDone.some((p) => p.startsWith("coding.models.subagent.")) && rolePatchOf("subagent")) opts.models.subagent.update(rolePatchOf("subagent")!);
            if (opts.models?.digest && hotDone.some((p) => p.startsWith("coding.models.digest.")) && rolePatchOf("digest")) opts.models.digest.update(rolePatchOf("digest")!);
 // 权限模式热生效:ask/auto/readonly 立即改变两个 ask 点的处置。
            if (base.applied.includes("permissions.mode")) setPermissionMode((opts.config as { permissions?: { mode?: string } }).permissions?.mode);
 // 预设差量原子落地:三旋钮(sandbox/approval/mode)由 applyPreset 一次算出差异并同源应用,
            // 再落一条 permission.preset.applied journal(审计面);同 preset 幂等=applied 空且 preset 未变→不落账。
            if (presetPatchRaw) {
              const beforeKnobs = presetKnobsOf(presetBefore);
              const appliedPreset = applyPreset(
                { preset: presetBefore, sandbox: beforeKnobs.sandbox, approval: beforeKnobs.approval, mode: permissionMode() },
                presetPatchRaw);
              setPermissionMode(appliedPreset.mode);
              setCurrentPresetName(appliedPreset.preset);
              if (appliedPreset.applied.length > 0 || appliedPreset.preset !== presetBefore) {
                journal.append({
                  kind: "custom",
                  sessionId: "system",
                  payload: {
                    type: "permission.preset.applied",
                    from: presetBefore,
                    to: appliedPreset.preset,
                    applied: appliedPreset.applied,
                    mode: appliedPreset.mode,
                    at: Date.now(),
                  },
                });
              }
            }
            const isModelTrack = (p: string) => isMainTrack(p) || p.startsWith("coding.models.");
            const hotOther = base.applied.filter((p) => !hotDone.includes(p) && !isModelTrack(p));
            return {
              // 非模型轨的热键(web.search.*/quota/browser/permissions 等)是「每次使用现读」的语义,
              // 本来就已经生效——直接并入 applied,不再被谎报成「重启生效」。
              applied: [...hotDone, ...hotOther],
              // 已热应用的路由键从 needsRestart 里剔除(否则面板同时显示「已热应用」和「重启生效」)。
 // 修复:此前把 base.applied 里所有非 hotDone 键都挪进 needsRestart —— 模型轨以外的
              // 热键(web.search.* 等)因此一律被谎报「重启生效」,面板徽标与用户预期相反。
              needsRestart: [
                ...base.needsRestart.filter((p) => !hotDone.includes(p)),
                ...base.applied.filter((p) => !hotDone.includes(p) && isModelTrack(p)),
              ],
              // env 占用透传(main 层甄别;面板徽标据此升格「重启生效」为「env 占用,重启也不生效」)
              ...(base.envOccupied?.length ? { envOccupied: base.envOccupied } : {}),
              // 实际生效选择 + 非致命提示/硬错误(面板不再用「热生效」空话;routeError 必须 fail-visible)。
              ...(base.effective ? { effective: base.effective } : {}),
              ...(base.warning ? { warning: base.warning } : {}),
              ...(base.routeError ? { routeError: base.routeError } : {}),
            };
          },
 // 预设一键接入的密钥通道。只写密钥文件;值不进配置/日志/回包。
          secretSet: (name: string, value: string) => {
            if (!opts.onSecretSet) throw new Error("密钥写入未启用(生产入口 main.ts 才提供)");
            return opts.onSecretSet(name, value);
          },
          secretKeys: () => (opts.listSecrets ? opts.listSecrets() : []),
        };
      })()
    : undefined;

  // fixD2/D3(团队 issue 双通道 + P2P 直连):IssueService 通道判定按项目根 git remote;
  // TeamP2P 目录/密钥落 repoRoot/.genie(team/members.json 仓内共享,secrets.json 600)。
  // P2P 是新增通道,与既有 TeamRelayClient 共存;relaySend=不可达时中转兜底(复用 activity 通道)。
  const issueService = new IssueService({
    repoRoot: repoRoot(),
    resolveRoot: (pid) => projects.resolveWorkdir(pid),
    username: process.env.GENIE_P2P_USER ?? "owner",
  });
  const teamP2p = new TeamP2P({
    repoRoot: repoRoot(),
    port: opts.port,
    // relay 兜底(只读既有 TeamView 内部客户端,不改 team-view.ts):ready org 任一在=activity.push 中转。
    relaySend: (to, text) => {
      const tv = (globalThis as { __teamView?: unknown }).__teamView as
        | { snapshot(): { orgs: { state: string }[] }; orgs?: Map<string, { client?: { ready: boolean; wsSend: (m: unknown) => void } }> }
        | undefined;
      if (!tv?.orgs) return false;
      for (const e of tv.orgs.values()) {
        if (e.client?.ready) {
          e.client.wsSend({ v: 1, type: "relay.activity.push", event: { ts: Date.now(), userId: to, projectId: "", category: "member", type: "p2p.relay", summary: text.slice(0, 200) } });
          return true;
        }
      }
      return false;
    },
  });
  // fixD3:/team/p2p/* HTTP 端点注册(panel servePanel 顶部委托;独立 WS 模式无 HTTP=直连面不可用,如实降级)。
  (globalThis as { __teamP2p?: TeamP2P }).__teamP2p = teamP2p;
 // fixD4 分发桥:任务终态 → taskId 关联 issue → 结果摘要(≤300 字)回写评论 + status→done。
  // 竞态:echo 形执行器在 submit() 内同步完成,终态事件可能先于 linkTask——关联未命中时
  // 短延迟重试一次(dispatch handler 侧还有登记后即查兜底,双保险)。
  taskManager.onChange((t) => {
    if (t.state !== "done" && t.state !== "failed" && t.state !== "cancelled") return;
    void (async () => {
      try {
        if (await issueService.writebackTerminal(t)) return;
        await new Promise((r) => setTimeout(r, 150));
        await issueService.writebackTerminal(t);
      } catch { /* 回写 fail-soft:不碰任务链 */ }
    })();
  });
  // issue 变更 → 全客户端广播(面板看板即时刷新;同仓多实例靠 .genie/issues 文件共享+进入视图拉取)。
  // 同时落 journal(fixD6):issue 变更此前没有任何事实源,事后无法审计「谁在什么时候建的/改的」,
  // 也无法核对「终态回写到底写没写」。sessionId=team:issue 独立轨(不混进任务看板)。
  bus.on("issue.changed", (ev: { projectId: string; number: number; action: string }) => {
    broadcastRaw({ v: 1, type: "issue.changed", projectId: ev.projectId, number: ev.number, action: ev.action });
    try {
      journal.append({ kind: "custom", sessionId: "team:issue", payload: { ns: "team.issue", kind: ev.action, projectId: ev.projectId, number: ev.number } });
    } catch { /* 观测面 fail-soft */ }
  });
  // fixD6(P2P 可观测):team-p2p 的 bus 事件此前全仓零订阅者——消息与拒绝不进任何事实源,
  // 事后无法取证「谁给谁发了什么/为什么被拒」。这里落 journal(kind=custom, sessionId=team:p2p,
  // 独立 sessionId 不污染任务看板:面板按 wf-/companion/web-/smoke- 前缀分轨,本前缀归「任务」轨
  // 但无任务无消息,折算后不产生会话卡;仍建议不改 sessionId 以免污染既有面板分轨)。
  // 只记摘要(文本 ≤200 字),不落全量正文——journal 是事实源不是消息库。
  const teamJournal = (kind: string, ev: Record<string, unknown>): void => {
    try {
      journal.append({ kind: "custom", sessionId: "team:p2p", payload: { ns: "team.p2p", kind, ...ev } });
    } catch { /* 观测面 fail-soft:不碰消息链 */ }
  };
  bus.on("team.p2p.message", (m: { id: string; from: string; to: string; text: string; via: string; duplicate?: boolean }) => {
    teamJournal("message", { id: m.id, from: m.from, to: m.to, via: m.via, duplicate: m.duplicate === true, text: String(m.text ?? "").slice(0, 200) });
    // 实时推送本机全部客户端:入站消息此前只进内存 inbox 与 journal,面板不刷新就看不到
    // (对端消息在 UI 上是「静默到达」)。重复投递也推(带 duplicate 标),让面板能显示「已吸收」。
    broadcastRaw({
      v: 1,
      type: "team.p2p.message",
      message: { id: m.id, from: m.from, to: m.to, text: String(m.text ?? "").slice(0, 4000), at: Date.now(), via: m.via, ...(m.duplicate ? { duplicate: true } : {}) },
    });
  });
  bus.on("team.p2p.rejected", (r: { route: string; user: string; reason: string; at: number }) => {
    teamJournal("rejected", r);
  });
  bus.on("team.p2p.send.fallback", (r: { id: string; from: string; to: string; via: string; reason: string }) => {
    teamJournal("fallback", r);
  });

  type GatewayServer = ReturnType<typeof startGatewayServer>;
  let wss: GatewayServer | undefined;
  let externalServer: Server | undefined;

 // super-agent Router( P1):面板 task.submit 与飞书 im-inbound 两主径 Trigger 入 router。
  // observe 模式 inferred 候选恒不派发(只落 disposition);订阅直通=threadKey 自动关联,活 Ticket
  // 的后续 Trigger 经 journal steer 注入(owner worker 下一 step 生效,对齐 agent-wiring steer_task)。
  // 落账 .genie/router/audit.jsonl(append-only,无凭证字段);policy 读 .genie/router/policy.json。
  const routerApi = createRouter({
    taskManager,
    journal,
    root: repoRoot(),
    onTicketUpdated: (p) => broadcastRaw({ v: 1, type: "ticket.updated", ticketId: p.ticketId, phase: p.phase, ...(p.taskId !== undefined ? { taskId: p.taskId } : {}), triggerId: p.triggerId, threadKey: p.threadKey } as import("@lampgenie/protocol").ServerMessage),
    steer: (ticket, trigger) => {
      journal.append({ kind: "message.user", sessionId: ticket.sessionId, payload: { text: `[转向] ${trigger.instruction}` } });
      if (ticket.taskId !== undefined) journal.append({ kind: "task.progress", sessionId: ticket.sessionId, payload: { taskId: ticket.taskId, steer: trigger.instruction.slice(0, 120) } });
    },
 // P2 LLM 研判:仅 mode=auto 时 dispatch 会调用(auto 闸在 router/dispatch.ts);
    // 研判大脑=runSuperAgentTurn(与 super agent 同一模型/工具面),prompt 要求回 JSON
    // {decision,intent_evidence};解析失败/无 deps=fail-soft 回 undefined(等效缺证据→ignore,sr8 不放松)。
    assess: superDeps && superSoul
      ? async (trigger) => {
        try {
          const r = await runSuperAgentTurn(superDeps!, `[系统研判] 有新触发进入 router,请判定是否值得派发为后台任务。只回 JSON:{"decision":"accept"|"ignore","intent_evidence":"一句话证据(引用触发原文关键词)"}。
触发来源:${trigger.source}
触发内容:${trigger.instruction.slice(0, 800)}`, superSoul!);
          const m = /"decision"\s*:\s*"(accept|ignore)"/.exec(r.text);
          const ev = /"intent_evidence"\s*:\s*"([^"]{1,300})"/.exec(r.text);
          if (!m) return undefined;
          return { decision: m[1] as "accept" | "ignore", ...(ev ? { intent_evidence: ev[1] } : {}) };
        } catch { return undefined; }
      }
      : undefined,
  });

  const ensureServer = (server?: Server): GatewayServer => {
    if (!wss) {
      wss = startGatewayServer({ port: opts.port, taskManager, journal, nodes, nodeConnections, nodeDispatch, projects, permissionBroker, routerApi,
 // 会话最近活动时间索引(侧栏排序用;启动回放已 seed,运行期 subscribe 更新)。
        sessionActivity,
 // 终态投递义务表(启动已 sweep 一次;server 侧负责 claim/重发/回收租约)。
        deliveryObligations,
 // 工作流板:wf-agent 节点派发用(与主 loop 同一 executor)
        ...(opts.executor ? { executor: opts.executor } : {}),
        ...(opts.llm ? { superAgent: {
 // 指挥台后端装配——turn/history/inbox/asr/onActivity(契约 §5)。
          // 用户轮次走 channel 串行队列(与播报/转述轮互斥,防答复与转述并发互相看不见)。
          turn: (text: string) =>
            (superChannel ?? { turn: async (t: string) => (await runSuperAgentTurn(superDeps!, t, superSoul!)).text }).turn(text),
          // 历史过滤:super: 新链 + companion: 旧数据(不迁移、不重写,journal 连续可读)。
          history: (sinceSeq?: number) => journal.readAll(sinceSeq ?? 0)
            .filter((e) => e.sessionId.startsWith("super:") || e.sessionId.startsWith("companion:")) as unknown[],
          // inbox 聚合:ask_user 挂起 + 权限挂起 + 任务态(interrupted/blocked/近 24h failed)。
          inbox: (limit?: number) => buildSuperInbox({ taskManager }, {
            asks: askUserRouter.pending(),
            permissions: permissionBroker.pendingList(),
            tasks: taskManager.list(),
          }, limit),
          // ASR(语音输入转写):config.audio.chat 同一 provider 一次 chat 调用;未配置=undefined。
          ...(asr ? { asr } : {}),
          onActivity: () => superActivity.mark(),
        } } : {}), experience: (() => { const st = getExperienceStore(); return { index: () => st.index(), view: (c: string, n: string) => st.view(c, n), disabled: () => st.disabledEntries(), remove: (c: string, n: string) => st.remove(c, n) }; })(),
      commands,
      hooks,
      mcp,
      plugins,
      profiles,
      wizardGen,
      skillsAdmin: (() => { const st = getExperienceStore(); return { disabled: () => disabledBuiltins(repoRoot()), set: (n: string, d: boolean) => setBuiltinDisabled(repoRoot(), n, d), index: () => mergeSkillIndexWith(st.index(), []) }; })(),
      memoryView: opts.memoryView ?? (() => {
 // 记忆只读视图:与 companion 同一 MemoryStore 目录。
        const st = new MemoryStore(join(repoRoot(), ".genie", "soul", "memories"));
        return {
          user: st.entries("user").join(String.fromCharCode(10) + String.fromCharCode(10)),
          memory: st.entries("memory").join(String.fromCharCode(10) + String.fromCharCode(10)),
          root: st.dir,
          usage: { user: st.usage("user"), memory: st.usage("memory") },
        };
      }),
      sysMeta, cfg, listModels: opts.listModels, probeModel: opts.probeModel,
      // per-session 主模型覆盖(白板「per-session 主模型」):set=**先校验后落盘**(routeError 不写盘)
      // + journal 记 model.switch;get=该 sid override/null + revision。不热切全局 provider、
      // 不动全局 config(设置页 cfg.set 语义保持独立)。
      ...(opts.sessionModels ? { sessionModels: createSessionModelApi({
        store: opts.sessionModels,
        ...(opts.config ? { config: opts.config as unknown as Config } : {}),
        root: repoRoot(),
        journal,
      }) } : {}), ...(opts.llm ? { llm: opts.llm } : {}),
 // 压缩模型轨下传——手动 /compact 要与自动路径同源(models.compact ?? auxLlm ?? llm),
      // 否则配了 coding.models.compact 的用户点 /compact 仍在用主轨。
      ...(opts.models ? { models: opts.models } : {}),
      ...(opts.auxLlm ? { auxLlm: opts.auxLlm } : {}),
      workflowAskRouter, askUser: askUserRouter, automations, automationScheduler, server,
      // fixD4:issue 双通道 + P2P 通道装配(issue.*/team.p2p.* 面板消息数据源)。
      issueService, teamP2p,
      // config 下传(voice.speak/语音路径读 audio.chat 轨;缺传=opts.config 恒 undefined,语音面必报未配置)
      ...(opts.config ? { config: opts.config } : {}),
      // 语音任务书 fetch 注入(voice.draft 测试面;缺省=全局 fetch)
      ...(opts.voiceDraftFetch ? { voiceDraftFetch: opts.voiceDraftFetch } : {}) });
      permissionBroker.attach((msg) => (wss as { broadcast?: (m: import("@lampgenie/protocol").ServerMessage) => void }).broadcast?.(msg as import("@lampgenie/protocol").ServerMessage));
 // 关卡 Gate:决议广播——多端(Gate 视图/modal/指挥台 inbox/第二标签页)一致清理挂起行,
      // 漏掉 permission.ask 帧的客户端也能收敛;同时廉价触发指挥台 inbox 重拉(perm 项消失)。
      permissionBroker.onSettle = (item) => {
        broadcastRaw({ v: 1, type: "permission.resolved", requestId: item.requestId, decision: item.decision, by: item.by });
        broadcastRaw({ v: 1, type: "super.inbox.changed" });
      };
      broadcastRaw = (msg) => (wss as { broadcast?: (m: import("@lampgenie/protocol").ServerMessage) => void }).broadcast?.(msg as import("@lampgenie/protocol").ServerMessage);
    }
    return wss;
  };

 // IM 入站(二期):飞书事件回调小服务,env 门控;未配置=零行为变化。
  if (process.env.GENIE_FEISHU_VERIFICATION_TOKEN) {
    void (async () => {
      const { startInboundServer, parseGroupBinds } = await import("./im-inbound.js");
      startInboundServer({
        port: Number(process.env.GENIE_IM_WEBHOOK_PORT ?? 7801),
        verificationToken: process.env.GENIE_FEISHU_VERIFICATION_TOKEN,
        ...(process.env.GENIE_FEISHU_ENCRYPT_KEY ? { encryptKey: process.env.GENIE_FEISHU_ENCRYPT_KEY } : {}),
        ...(process.env.GENIE_FEISHU_BOT_OPEN_ID ? { botOpenId: process.env.GENIE_FEISHU_BOT_OPEN_ID } : {}),
        groupBindings: parseGroupBinds(process.env.GENIE_FEISHU_GROUP_BINDS),
        submitTask: async ({ sessionId, instruction, title }) => {
 // P1:飞书主径 Trigger 入 router。dm/mention 命中 task 路由=addressed
          // (显式点名→explicit 派发,行为与旧直提一致);observe 兜底不派发(零 LLM,只落账)。
          const r = await routerApi.submit({ source: "im", sessionId, instruction, addressed: true, ...(title ? { extra: { title } } : {}) });
          if (!(r.outcome && (r.outcome.kind === "dispatched" || r.outcome.kind === "steered"))) {
            // router 未派发(policy 关闭 im scope 或 observe):保底不静默——收件箱落账可追溯。
            journal.append({ kind: "message.user", sessionId, payload: { text: `[IM 未派发] ${instruction}`.slice(0, 400) } });
          }
          broadcastRaw({ v: 1, type: "task.list", tasks: taskIndexList(taskManager.list()) });
        },
        noteInbox: ({ sessionId, text, reason }) => {
          journal.append({ kind: "message.user", sessionId, payload: { text: `[IM 收件箱:${reason}] ${text}` } });
        },
      });
      console.log(`[gateway] im inbound: webhook/feishu on :${Number(process.env.GENIE_IM_WEBHOOK_PORT ?? 7801)}`);
    })().catch(() => { /* 入站面故障不影响主服务 */ });
  }

 // interrupted 自动恢复(env GENIE_AUTORESUME_MINUTES,缺省=关):重启后对「中断发生在
  // 窗内」的任务自动重提同 session 续跑(11-04 人工续跑口径产品化);陈年中断不自动碰,留面板一键。
  // 放在全部接线(workerHost.dispatch/journal onChange)之后:重提任务立即走正常派发链。
  {
    const arMinutes = Number(process.env.GENIE_AUTORESUME_MINUTES ?? 0);
    if (Number.isFinite(arMinutes) && arMinutes > 0) {
      const resumed = taskManager.autoResumeInterrupted({
        windowMs: arMinutes * 60_000,
 // :有用户停止标记的会话不再自动续跑(冷恢复已把它们收编为 cancelled;这里再兜一层,
        // 覆盖「上次重启已收编 interrupted、之后才出现停止标记」的历史任务)。
        blocked: (t) => (userStoppedAt.get(t.sessionId) ?? -1) >= t.createdAt,
 // :修复落在 buildInstruction 体内——resumeInterrupted 的幂等早返回路径不会执行它,
        // 重复续跑不会重复扫尾(applyTailRepair 本身也幂等,二次全 0)。
        buildInstruction: (t) => {
          const repairNote = repairTailBeforeResume(journal, t.sessionId);
          return (
            `【续跑】此前任务(${t.id})被网关重启打断,中断前会话约 ${agentTurns.get(t.sessionId) ?? 0} 轮对话。` +
            `请基于该会话已有进展(session 历史/工作区现状)继续完成原任务书,不要重做已完成部分:` +
            `${repairNote}\n${t.instruction}`
          );
        },
      });
      if (resumed.length > 0) console.log(`[gateway] 自动恢复:重提 ${resumed.length} 个中断任务(窗 ${arMinutes}min)`);
    }
  }

  if (opts.useExternalHttp !== true) {
    ensureServer(); // 旧行为:立即独立监听
  }

  return {
    taskManager,
    nodes,
    projects,
    workflowAskRouter,
    askUser: askUserRouter,
    automations,
    automationScheduler,
    journal,
    effectQueue,
    memory: memoryWiring,
    ...(otelExporter ? { otel: otelExporter } : {}),
    attachWs(server: Server) {
      externalServer = server;
      effectQueue.start();
      ensureServer(server);
      // fixD3:P2P 自报端口以真实监听地址为准——attachWs 发生在 listen 前(servePanel 形态),
      // address() 此刻为 null,必须等 listening 事件回填。
      const syncPort = () => {
        const addr = server.address();
        if (addr && typeof addr === "object" && typeof addr.port === "number") teamP2p.updatePort(addr.port);
      };
      if (server.listening) syncPort();
      else server.once("listening", syncPort);
    },
    listenStandalone() {
      effectQueue.start();
      ensureServer();
    },
async close() {
      clearInterval(localHeartbeat);
 // 停止取新 + await 在飞;pending(nextAt 未到也算)留在 journal 里,重启由 fold 恢复。
      try { await effectQueue.drain(); } catch { /* 关停 fail-soft */ }
      closeSessionSearch(journal); // 会话检索缓存 flush(只关已创建的索引)
 // write-behind journal 显式清队:否则关闭后立刻重启/新实例读盘会看不到
 // 最后一批事件(经验证:任务提交→立即关→重启丢任务)。MemoryJournal 无 flush=no-op。
      try { (journal as { flush?: () => void }).flush?.(); } catch { /* 清队失败不影响关停 */ }
      otelExporter?.stop();
      automationScheduler.stop();
      clearInterval(archiveTimer);
      await wss?.close();
      if (externalServer) {
        await new Promise<void>((resolve) => {
          externalServer!.close(() => resolve());
          externalServer!.closeAllConnections?.();
        });
      }
    },
  };
}
