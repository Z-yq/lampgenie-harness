/**
 * 协议出口:ClientMessage/ServerMessage 判别联合 + parse/explain 助手 + 服务端事件 schema。
 * 自 index.ts(2941 行)按域拆分,逐字搬移。
 */
import { z } from "zod";
import { Envelope } from "./core.js";
// [CROSS-IMPORTS]
import { AgentsList, AutomationCreate, AutomationDelete, AutomationList, AutomationRun, AutomationUpdate, BrowserViewClose, BrowserViewCommand, BrowserViewOpen, CfgGet, CfgSecretSet, CfgSecretStatus, CfgSet, ClientCapabilitiesDeclare, ClientModeDeclare, ClientSurface, CommandsCatalog, CommandsList, CommandsRemove, CommandsUpsert, CompanionHistory, CompanionTurn, ExpDisable, ExpDistill, ExpList, ExpRemove, ExpView, HooksList, HooksRemove, HooksUpdate, HooksUpsert, IssueComment, IssueConfirmDispatch, IssueCreate, IssueList, IssueSync, IssueUpdate, McpList, McpRemove, McpTest, McpUpdate, McpUpsert, MemoryView, ModelsList, ModelsProbe, NodeExec, NodeHeartbeat, NodeRegister, NodeTaskResult, NodesList, PermissionHistory, PermissionPending, PermissionRespond, Ping, PluginsInstall, PluginsList, PluginsToggle, PluginsUninstall, ProfileFile, ProfileGet, ProfilePlanApply, ProfilePlanRemove, ProfilePlanUpsert, ProfileRebuild, ProfileSenseGet, ReviewInject, ReviewStoreGet, SenseQuery, SkillsDisableBuiltin, SkillsList, StoredCommentZ, SubagentsList, SuperHistory, SuperInbox, SuperTurn, SurfaceCapsZ, SysMeta, TeamInvite, TeamP2pSend, TeamP2pStatus, TeamStatus, TeamaiContribute, TeamaiInspect, TeamaiPull, TeamaiPush, TeamaiRemove, TermCancel, TermExec, TraceQuery, TraceStats, TrackView, UsageView, VoiceList, VoiceTranscribe, VoiceTts, WikiGet, WikiList, WikiRebuild, WizardGen, WorkersList } from "./surface.js";
import { RsiItemDelete, RsiItemResult, RsiItemUpdate, RsiMechanismRun, RsiMechanismRunResult, RsiMechanismSet, RsiMechanismSetResult, RsiStatusQuery, RsiStatusResult } from "./rsi.js";
import { ArchiveClear, AskUserAnswer, CheckpointList, CheckpointPreview, CheckpointRestore, CheckpointRewind, GoalGet, GoalSet, MeetingImport, MeetingSchedule, PlanApprove, QueueDispatchNow, QueueItem, QueueRemove, StatsSummary, Task, TaskArchive, TaskCancel, TaskDelete, TaskDeleteSession, TaskDetailGet, TaskDiffstat, TaskFileDiff, TaskGroup, TaskIndex, TaskList, TaskOutputQuery, TaskPin, TaskRename, TaskResume, TaskSchedule, TaskScheduleCancel, TaskSubmit } from "./task.js";
import { FileRead, FileWrite, FilesSearch, FsGrep, FsList, FsMkdir, FsOpen, FsRemove, FsRename, GitBranches, GitCheckout, GitCommit, GitCommitMsg, GitDiff, GitLog, GitPull, GitPush, GitShow, GitStatus, IdeOfficeEdit, LspDiagnostics, RemoteDeploy, RemoteLs, RemoteRead, SshBrowse, SshConfigList, SshKeyImport, SshTest, TermSessionClose, TermSessionOpen, TermSessionRead, TermSessionSend, WorkflowAnswer, WslBrowse, WslList, WslTest } from "./ide-fs.js";
import { ApiRetryStatusZ, DashboardSessions, DashboardTrends, ProjectActivate, ProjectAdd, ProjectList, ProjectRemove, ProjectRename, SessionCompact, SessionExport, SessionFork, SessionHistory, SessionModelGet, SessionModelSet, SessionOwnerGet, SessionSearch, SessionStatus, SubagentCancel } from "./session.js";
import { BoardArchiveList, BoardComment, BoardContinue, BoardDiagramRequest, BoardDiagramResult, BoardDocZ, BoardFromCode, BoardFromSense, BoardGet, BoardLinkStateZ, BoardList, BoardOverlayGet, BoardOverlaySave, BoardSave, BoardWorkflowCompile, BoardWorkflowRun } from "./board.js";
import { AnnotateRecord, AnnotateRecordResult, AnnotateResult, AnnotateSubmit, VoiceDraft, VoiceDraftResult } from "./annotate.js";
import { ErrorCodeSchema } from "./core.js";
export const ClientMessage = z.discriminatedUnion("type", [
  ClientSurface,
  ClientModeDeclare,
  ClientCapabilitiesDeclare,
  RsiMechanismSet, RsiMechanismRun, RsiItemUpdate, RsiItemDelete,
  BrowserViewOpen, BrowserViewClose, BrowserViewCommand,
  TaskSubmit, TaskCancel, TaskSchedule, TaskScheduleCancel, TaskResume, QueueDispatchNow, QueueRemove, AskUserAnswer, TaskRename, TaskPin, TaskArchive, TaskDelete, TaskDeleteSession, ArchiveClear, TaskDetailGet, FilesSearch, SessionSearch, FileRead, FileWrite, IdeOfficeEdit, WorkflowAnswer, GitLog, GitCommitMsg, ExpDisable, CheckpointPreview, CheckpointRewind, TaskDiffstat, StatsSummary, TaskFileDiff, ModelsProbe, AgentsList, SkillsList, SkillsDisableBuiltin, CommandsList, CommandsUpsert, CommandsRemove, CommandsCatalog, HooksList, HooksUpsert, HooksUpdate, HooksRemove, McpList, McpUpsert, McpUpdate, McpRemove, McpTest, MemoryView, TermExec, TermCancel, PluginsList, PluginsInstall, PluginsUninstall, PluginsToggle, NodesList, NodeExec, WizardGen, ProfileGet, ProfileRebuild, ProfilePlanUpsert, ProfilePlanRemove, ProfilePlanApply, ProfileSenseGet, AutomationList, AutomationCreate, AutomationUpdate, AutomationDelete, AutomationRun, TaskList, SessionHistory, NodeRegister, NodeHeartbeat, NodeTaskResult, PermissionRespond, ProjectAdd, ProjectRemove, ProjectActivate, ProjectList, ProjectRename, SshKeyImport, SshConfigList, SshTest, WslList, WslTest, WslBrowse, SshBrowse, RemoteLs, RemoteRead, RemoteDeploy, FsList, FsOpen, FsMkdir, FsRemove, FsRename, FsGrep, LspDiagnostics, TermSessionOpen, TermSessionSend, TermSessionRead, TermSessionClose, GitShow, GitStatus, GitDiff, GitBranches, GitCheckout, GitCommit, GitPush, GitPull, SenseQuery, WikiList, WikiGet, WikiRebuild, ReviewStoreGet, ExpList, ExpView, ExpRemove, SysMeta, CfgGet, CfgSet, CfgSecretStatus, CfgSecretSet, ModelsList, SessionStatus, TraceStats, CompanionTurn, SuperTurn, SuperHistory, SuperInbox, VoiceTranscribe, CompanionHistory, ProfileFile, Ping, MeetingImport, MeetingSchedule, SessionExport, VoiceTts, VoiceList, TeamStatus, TeamInvite, PermissionPending, TaskGroup, ExpDistill, CheckpointList, CheckpointRestore, GoalSet, GoalGet, SessionCompact, PlanApprove, TaskOutputQuery, BoardGet, BoardList, BoardDiagramRequest, BoardSave, BoardContinue, BoardOverlaySave, BoardOverlayGet, BoardComment, BoardFromCode, BoardFromSense, BoardArchiveList, BoardWorkflowCompile, BoardWorkflowRun, TeamaiPull, TeamaiPush, TeamaiInspect, TeamaiContribute, TeamaiRemove, SessionFork, DashboardSessions, DashboardTrends, SubagentCancel, ReviewInject, IssueList, IssueCreate, IssueUpdate, IssueComment, IssueSync, IssueConfirmDispatch, TeamP2pStatus, TeamP2pSend, SubagentsList, WorkersList, TrackView, UsageView, SessionModelSet, SessionModelGet, SessionOwnerGet, AnnotateSubmit, AnnotateRecord, TraceQuery, VoiceDraft, PermissionHistory, RsiStatusQuery,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- 服务端 → 客户端 ----
export const BrowserViewFrame = Envelope.extend({
  type: z.literal("browser.view.frame"),
  tabId: z.string(),
  seq: z.number().int().nonnegative(),
 /** JPEG base64(无反 data: 前缀);服务端压到 ≤900KB。 */
  imageB64: z.string(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  viewport: z.object({ width: z.number().int(), height: z.number().int() }),
  url: z.string(),
  title: z.string(),
 /** 最近一次 snapshot 的 ref 命中区域(截图物理坐标系);面板按缩放比换算成 CSS 坐标画高亮框。 */
  hitRegions: z.array(z.object({
    ref: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number(),
  })).optional(),
  ts: z.number(),
});
// 视图事件:导航/载入/关闭/崩溃;面板据此刷新地址栏、tabs 与状态行。
export const BrowserViewEvent = Envelope.extend({
  type: z.literal("browser.view.event"),
  tabId: z.string(),
  kind: z.enum(["nav", "load", "close", "crash"]),
  url: z.string().optional(),
  title: z.string().optional(),
  message: z.string().optional(),
});
// 订阅回执(含当前 tab 清单,面板一次拿全不必再查)。
export const BrowserViewSubscribed = Envelope.extend({
  type: z.literal("browser.view.subscribed"),
  tabId: z.string().nullable(),
  ok: z.boolean(),
  tabs: z.array(z.object({
 /* owner(2026-11 browser-ux-redo):"human" / "agent"(或 agent:<taskId>),面板 chip 标归属。 */
    id: z.string(), url: z.string(), title: z.string(), active: z.boolean(), owner: z.string().optional(),
  })).optional(),
  message: z.string().optional(),
});
// 面板命令回执(错误以 text 承载,不抛)。
export const BrowserViewCommandResult = Envelope.extend({
  type: z.literal("browser.view.command.result"),
  tabId: z.string().nullable(),
  action: z.string(),
  ok: z.boolean(),
  text: z.string(),
 /** action=tabs 成功时附在场 tab 清单(面板切 tab 栏用,免再发一次命令)。 */
  tabs: z.array(z.object({
    id: z.string(), url: z.string(), title: z.string(), active: z.boolean(), owner: z.string().optional(),
  })).optional(),
});

// ── super agent 指挥台 inbox(契约 §2)──
/** 待处理项(聚合 ask/permission/interrupted/blocked/failed)。宽松结构:只锁契约字段,
 * 其余 passthrough(避免新增字段动协议)。 */
export const SuperInboxItemZ = z.object({
 /** 稳定 id:ask-<requestId> / perm-<requestId> / task-<taskId>。 */
  id: z.string(),
  kind: z.string(),
 /** ≤60 字:一句话说明要用户做什么。 */
  title: z.string(),
 /** ≤200 字:来源/上下文摘要。 */
  summary: z.string(),
 /** 毫秒。 */
  since: z.number(),
  sessionId: z.string().optional(),
  taskId: z.string().optional(),
  requestId: z.string().optional(),
 /** ask 类:可选项(指挥台据此直接出选项按钮)。 */
  options: z.array(z.string()).optional(),
  actions: z.array(z.string()),
}).passthrough();
export type SuperInboxItem = z.infer<typeof SuperInboxItemZ>;

/** 表面能力声明回执:ok=false 时带稳定 error(坏字段/缺 sessionId),且服务端未落账。 */
export const SurfaceResult = Envelope.extend({
  type: z.literal("surface.result"),
  ok: z.boolean(),
  caps: SurfaceCapsZ.optional(),
  error: z.string().optional(),
});

/** 能力协商回执(复用 result 型,不走 error 帧:协商本身成功,code 描述的是协商结论)。 */
export const CapabilitiesResult = Envelope.extend({
  type: z.literal("capabilities.result"),
  ok: z.boolean(),
  mode: z.enum(["legacy", "negotiated"]),
 /** LEGACY | OK | CONTRACT_TOO_OLD | NO_OPS(协商结论,不是错误码)。 */
  code: z.string(),
  acceptedOps: z.array(z.string()),
  rejectedOps: z.array(z.string()),
  droppedKeys: z.array(z.string()),
  summary: z.string().optional(),
});

export const ServerMessage = z.discriminatedUnion("type", [
  SurfaceResult,
  CapabilitiesResult,
  BrowserViewFrame, BrowserViewEvent, BrowserViewSubscribed, BrowserViewCommandResult,
 // fixI4: hello 附全量会话排队快照(页面刷新后队列恢复);queue.update=队列任何变更广播(入队/出队/删除/抢占)。
 // build=面板产物戳——老窗口收到与自身 __PANEL_BUILD 不符时自愈重载(IDE 空白根治)。
 // sessionActivity = sid → 最近活动时间(ms)首帧快照(侧栏排序用;独立字段,不污染 TaskIndex)。
 // 能力自报(可选):contractVersion=协商契约版本(只增),ops=服务端能力命名空间清单,
 // health=实装能力位(只列 true)。旧客户端忽略该字段,零影响。
  Envelope.extend({ type: z.literal("hello"), build: z.string().optional(), tasks: z.array(TaskIndex), queue: z.array(QueueItem).optional(), sessionActivity: z.record(z.number()).optional(), capabilities: z.object({ contractVersion: z.number(), ops: z.array(z.string()), health: z.array(z.string()) }).optional() }),
  Envelope.extend({ type: z.literal("queue.update"), sessionId: z.string(), items: z.array(QueueItem) }),
  Envelope.extend({ type: z.literal("task.submitted"), task: Task }),
  Envelope.extend({ type: z.literal("task.changed"), task: TaskIndex }),
  Envelope.extend({ type: z.literal("task.list"), tasks: z.array(TaskIndex) }),
 /** 单任务详情回执(正文只在被点名时出现):task=null 表示 id 不存在/已删(面板须显示不可用,不得当正文渲染)。 */
  Envelope.extend({ type: z.literal("task.detail.result"), taskId: z.string(), task: Task.nullable() }),
 // 定时任务:创建/取消回执(ok=false 时 error+issues 说明内容门拒收原因)。
  Envelope.extend({
    type: z.literal("task.schedule.result"),
    ok: z.boolean(),
    task: z.record(z.unknown()).optional(),
    error: z.string().optional(),
    issues: z.array(z.string()).optional(),
  }),
  Envelope.extend({
    type: z.literal("task.schedule.cancel.result"),
    ok: z.boolean(),
    taskId: z.string(),
  }),
 // super-agent Router( P1):Ticket 阶段变化广播(observed/open/closed;P3 面板 Ticket 阶段表消费)。
 // P1 保持 payload 字段稳定:ticketId/phase/taskId?/triggerId/threadKey。
  Envelope.extend({
    type: z.literal("ticket.updated"),
    ticketId: z.string(),
    phase: z.enum(["observed", "open", "closed"]),
    taskId: z.string().optional(),
    triggerId: z.string(),
    threadKey: z.string(),
  }),
  Envelope.extend({
    type: z.literal("session.history.result"),
    sessionId: z.string().optional(),
    since: z.number().int().optional(),
    events: z.array(z.unknown()),
 // 向后翻页:旧字段一律保留(since/events/sessionId),以下两个只在 beforeSeq 路径给。
    hasMore: z.boolean().optional(),
 /** 下一页游标(本页最小 seq);仅 hasMore=true 时给——游标必须严格推进,否则前端 loop 会死转。 */
    nextBeforeSeq: z.number().int().optional(),
 /** 增量回放:events 只含 seq>请求 atRevision 的行;atRevision/atLogEpoch 供下次游标。 */
    atRevision: z.number().int().min(0).optional(),
    atLogEpoch: z.number().int().min(0).optional(),
    delta: z.boolean().optional(),
 /** 客户端游标失效(epoch 不匹配/ring 未覆盖)且本次回的是整页 → true,面板应丢弃本地缓存重建。 */
    reset: z.boolean().optional(),
  }),
 // 会议导入/会话导出
  Envelope.extend({ type: z.literal("meeting.extraction"), extraction: z.record(z.unknown()), draftPath: z.string() }),
  Envelope.extend({ type: z.literal("meeting.scheduled"), tasks: z.array(z.object({ id: z.string(), content: z.string() })) }),
  Envelope.extend({ type: z.literal("session.export.result"), sessionId: z.string(), file: z.string(), events: z.number().int() }),
  Envelope.extend({ type: z.literal("voice.tts.result"), audioB64: z.string(), mime: z.string(), text: z.string(), voice: z.string().optional() }),
 // 音色清单:model=过滤依据回显;voices 空=无内置清单(自定义 id 兜底)。
  Envelope.extend({
    type: z.literal("voice.list.result"),
    model: z.string(),
    voices: z.array(z.object({
 /** voice 参数(请求体 input.voice 的值,区分大小写)。 */
      id: z.string(),
      name: z.string(),
      gender: z.string().optional(),
      traits: z.string().optional(),
 /** 分组名(如 3.1·精品中文)。 */
      group: z.string(),
    })),
  }),
  Envelope.extend({ type: z.literal("team.status.result"), orgs: z.array(z.record(z.unknown())), projectTeam: z.record(z.unknown()).nullable().optional(), projectTeams: z.array(z.record(z.unknown())).nullable().optional(), teamai: z.record(z.unknown()).nullable().optional() }),
  Envelope.extend({ type: z.literal("teamai.push.result"), ok: z.boolean(), branch: z.string().optional(), reason: z.string().optional() }),
 // 门面回包:inspect(清单+diff+体检)/contribute(learnings 分支)/remove(main 上删除)。
 // status/doctor 缺省=不入包(拿不到团队仓时 list 仍回,原因进 reason)。
  Envelope.extend({
    type: z.literal("teamai.inspect.result"),
    ok: z.boolean(),
    list: z.array(z.object({ kind: z.string(), name: z.string(), ns: z.string().optional() })).optional(),
    status: z.object({ added: z.array(z.string()), removed: z.array(z.string()), changed: z.array(z.string()) }).optional(),
    doctor: z.object({ ok: z.boolean(), findings: z.array(z.record(z.unknown())) }).optional(),
    reason: z.string().optional(),
  }),
  Envelope.extend({ type: z.literal("teamai.contribute.result"), ok: z.boolean(), branch: z.string().optional(), path: z.string().optional(), reason: z.string().optional() }),
  Envelope.extend({ type: z.literal("teamai.remove.result"), ok: z.boolean(), path: z.string().optional(), reason: z.string().optional() }),
  Envelope.extend({ type: z.literal("team.invite.result"), ok: z.boolean(), code: z.string().optional(), reason: z.string().optional() }),
 // fixD4:issue 双通道 + P2P 回包(字段宽松 record:通道差异由服务端归一)。
  Envelope.extend({ type: z.literal("issue.list.result"), projectId: z.string().optional(), issues: z.array(z.record(z.unknown())), channel: z.record(z.unknown()).nullable().optional() }),
  Envelope.extend({ type: z.literal("issue.changed"), projectId: z.string(), number: z.number().int(), action: z.string() }),
  Envelope.extend({ type: z.literal("issue.sync.result"), ok: z.boolean(), detail: z.string().optional(), reason: z.string().optional() }),
  Envelope.extend({ type: z.literal("issue.dispatch.result"), ok: z.boolean(), taskId: z.string().optional(), reason: z.string().optional() }),
  Envelope.extend({ type: z.literal("team.p2p.status.result"), status: z.record(z.unknown()) }),
  Envelope.extend({ type: z.literal("team.p2p.message.result"), ok: z.boolean(), via: z.string(), reason: z.string().optional() }),
 // 入站消息实时推送(推给本机全部客户端):此前入站只进内存 inbox + journal,面板要等
 // 用户手动刷新或轮询 status 才看得到,对端发来的消息在 UI 上是「静默到达」的。
 // 与 team.p2p.message.result(发送回执)正交:本帧只描述「收到了谁的消息」。
  Envelope.extend({
    type: z.literal("team.p2p.message"),
    message: z.object({
      id: z.string(), from: z.string(), to: z.string(), text: z.string(),
      at: z.number(), via: z.string(), duplicate: z.boolean().optional(),
    }),
  }),
  Envelope.extend({ type: z.literal("permission.pending.result"), asks: z.array(z.object({ requestId: z.string(), sessionId: z.string(), tool: z.string(), summary: z.string(), risk: z.string(), since: z.number() })) }),
 // 关卡 Gate:决议广播(broker onSettle→全端一致清理挂起行/modal;by=panel/timeout/offline/policy/…)。
  Envelope.extend({ type: z.literal("permission.resolved"), requestId: z.string(), decision: z.enum(["allow-once", "reject"]), by: z.string() }),
 // 关卡 Gate 历史面:broker 内存 ring 最近决议(旧在前;重启即失——持久化登记后续)。
  Envelope.extend({ type: z.literal("permission.history.result"), items: z.array(z.object({ requestId: z.string(), sessionId: z.string(), tool: z.string(), summary: z.string(), risk: z.string(), since: z.number(), settledAt: z.number(), decision: z.string(), by: z.string() })) }),
  Envelope.extend({ type: z.literal("checkpoint.list.result"), snapshots: z.array(z.object({ taskId: z.string(), sha: z.string().nullable(), sessionId: z.string(), at: z.number() })) }),
  Envelope.extend({ type: z.literal("checkpoint.restore.result"), ok: z.boolean(), sha: z.string().optional(), reason: z.string().optional() }),
  Envelope.extend({ type: z.literal("exp.distill.result"), ok: z.boolean(), detail: z.string().optional() }),
 // ZCode 内置命令回包
 // sync=true=goal.get 轮询/查询回包(状态同步,前端静默刷新 chip);缺省=goal.set 动作确认(可 toast)。
 // 「目标已清除」toast 刷屏根因(视频):15s 轮询复用动作确认回包语义。
  Envelope.extend({ type: z.literal("goal.result"), goal: z.string().nullable(), state: z.enum(["active", "paused", "cleared", "complete", "budget_limited"]), sync: z.boolean().optional() }),
  Envelope.extend({ type: z.literal("session.compact.result"), compacted: z.boolean(), reason: z.string().optional(), summaryChars: z.number().int().optional(), tokensBefore: z.number().optional(), tokensAfter: z.number().optional(), trigger: z.enum(["manual", "auto"]).optional() }),
 // 压缩状态帧(2026-11 边界元数据):手动 /compact 与自动钩子共用的过程广播(started/completed/
 // failed/skipped)。广播而非回包——多标签页/看板都要看见「这次谁触发、压了多少、为什么没压」。
  Envelope.extend({ type: z.literal("session.compact.status"), sessionId: z.string(), phase: z.enum(["started", "completed", "failed", "skipped"]), trigger: z.enum(["manual", "auto"]).optional(), reason: z.string().optional(), summaryChars: z.number().int().optional(), tokensBefore: z.number().optional(), tokensAfter: z.number().optional() }),
  Envelope.extend({ type: z.literal("plan.approval.request"), sessionId: z.string(), taskId: z.string(), planPath: z.string(), planExcerpt: z.string() }),
  Envelope.extend({ type: z.literal("task.output.result"), agentId: z.string(), status: z.string(), outputFile: z.string().optional(), output: z.string().optional() }),
 // 子代理终止回包(目录「终止」按钮;cancel 句柄缺席=ok:false+reason,面板如实提示)
  Envelope.extend({ type: z.literal("subagent.cancel.result"), agentId: z.string(), ok: z.boolean(), reason: z.string().optional() }),
 // 档案文件钻取(文件清单/函数+调用边)
  Envelope.extend({
    type: z.literal("profile.file.result"),
    mode: z.enum(["files", "symbols"]),
    files: z.array(z.string()).optional(),
    file: z.string().optional(),
    symbols: z.array(z.object({ name: z.string(), kind: z.string(), line: z.number(), container: z.string().nullable(), id: z.string() })).optional(),
    edges: z.array(z.object({ from: z.string(), fromName: z.string(), to: z.string(), toName: z.string(), line: z.number(), crossFile: z.boolean() })).optional(),
 /** code2flow 分类(三改):符号 id → trunk/leaf/regular + 出入度。 */
    kinds: z.record(z.string(), z.object({ kind: z.string(), inCount: z.number(), outCount: z.number() })).optional(),
 /** 八期:代码档案工作流化组织——fileToModules 模块分类(16 类类型+真实调用边+跨文件目标)。 */
    modules: z.object({
      file: z.string(),
      nodes: z.array(z.object({
        id: z.string(), kind: z.string(), label: z.string(), summary: z.string(),
        inCount: z.number(), outCount: z.number(),
        symbolRef: z.object({ name: z.string(), file: z.string(), line: z.number() }),
      })).optional(),
      edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string(), line: z.number(), crossFile: z.boolean() })).optional(),
      crossFileTargets: z.array(z.object({ name: z.string(), file: z.string(), line: z.number() })).optional(),
    }).optional(),
  }),
 // ── super agent 指挥台(出站只发 super.*)──
  Envelope.extend({ type: z.literal("super.turn.user"), text: z.string(), sessionId: z.string().optional() }),
  Envelope.extend({ type: z.literal("super.turn.done"), text: z.string(), sessionId: z.string() }),
  Envelope.extend({ type: z.literal("super.history.result"), events: z.array(z.unknown()) }),
 // ask_user 转接:coding agent 提问经指挥台转述;用户口头答复经 relay_answer 工具回交,
 // 先答先用(面板 askBar 与此通道任一先答另一侧失效)。
  Envelope.extend({
    type: z.literal("super.relay"),
    requestId: z.string(),
    sessionId: z.string(),
    question: z.string(),
    options: z.array(z.string()).optional(),
    context: z.string().optional(),
  }),
 // 任务状态播报(done/failed/cancelled/interrupted/blocked 等);state=任务状态机值。
  Envelope.extend({
    type: z.literal("super.notice"),
    text: z.string(),
    taskId: z.string().optional(),
    state: z.string().optional(),
  }),
 // 做梦卡:机制运行开始/完成注入 super 会话同帧广播(面板聊天流渲染做梦卡)。
 // phase=start(机制标题+runId)/done(成本+摘要)/failed;cost 结构=RsiRunCostRecord(缺价 amountCny=null)。
  Envelope.extend({
    type: z.literal("super.dream"),
    phase: z.enum(["start", "done", "failed"]),
    mechanismId: z.string(),
    runId: z.string(),
    taskId: z.string().optional(),
    title: z.string(),
    cost: z.object({
      inputTokens: z.number(), cachedTokens: z.number(),
      cacheCreationTokens: z.number().optional(),
      outputTokens: z.number(), totalTokens: z.number(),
      model: z.string().optional(),
      amountCny: z.number().nullable(),
      missing: z.array(z.string()),
    }).optional(),
    summary: z.string().optional(),
  }).passthrough(),
 // inbox 聚合结果(宽松结构:items 只锁 id/kind/title/summary/since/actions,其余 passthrough,
 // 免得新增字段要改协议;ts=聚合时刻毫秒)。
  Envelope.extend({
    type: z.literal("super.inbox.result"),
    items: z.array(z.object({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      summary: z.string(),
      since: z.number(),
      actions: z.array(z.string()),
    }).passthrough()),
    ts: z.number(),
  }),
 // 廉价触发:inbox 有变化(任务进 interrupted/blocked/failed 等),面板据此重拉 super.inbox。
  Envelope.extend({ type: z.literal("super.inbox.changed") }),
 // 语音输入转写结果(voice.transcribe → 文本;不含人格设定与语音回播)。
  Envelope.extend({ type: z.literal("voice.transcribe.result"), text: z.string() }),
 // ── legacy 只读:以下 companion.* 服务端消息保留在联合里(旧回放/旧客户端解析不破),
 // 服务端不再发出(server 出站统一 super.*)。 ──
 // 语音入口广播(头像气泡语音→companion,转写文本先播给全部客户端,回复随后 turn.done)
  Envelope.extend({ type: z.literal("companion.turn.user"), text: z.string() }),
  Envelope.extend({ type: z.literal("companion.turn.done"), text: z.string(), sessionId: z.string() }),
  Envelope.extend({ type: z.literal("companion.history.result"), events: z.array(z.unknown()) }),
 // fixC5(ask_user 双通道):coding agent 的提问同时转接给 super 指挥台窗——语音转述,
 // 用户口头答复经 relay_answer 工具回交 ask.user.answer 通道;先答先用,任一侧先答另一侧失效。
  Envelope.extend({
    type: z.literal("companion.relay"),
    requestId: z.string(),
    sessionId: z.string(),
    question: z.string(),
    options: z.array(z.string()).optional(),
    context: z.string().optional(),
  }),
 // fixC6(任务终态播报):done/failed/cancelled 注入 companion 会话并广播;管家窗活跃时
 // 服务端主动出一轮管家轮次,一句话播报经 companion.turn.done 推送(TTS 走既有 voice.tts 链)。
  Envelope.extend({
    type: z.literal("companion.notice"),
    text: z.string(),
    taskId: z.string().optional(),
    state: z.string().optional(),
  }),
 // 追踪统计投影(dsh session-stats 诚实子集;ttft/decodeTps=流式链路,缺 0)
  Envelope.extend({
    type: z.literal("trace.stats.result"),
    stats: z.object({
      turns: z.number().int(), steps: z.number().int(), llmCalls: z.number().int(),
      llmMs: z.number().int(), llmMsMax: z.number().int(),
 // 失败调用(txa5,2026-11 轨迹采集补齐):失败 LLM 调用不再从统计里消失。
 // 缺省 0 保旧服务端/旧断言兼容;llmCalls 口径不变(仍只计 message.agent)。
      llmFailures: z.number().int().default(0), failedLlmMs: z.number().int().default(0),
      toolCalls: z.number().int(), toolMs: z.number().int(),
      tokens: z.object({ input: z.number().int(), output: z.number().int(), total: z.number().int(), cached: z.number().int() }),
      contextTokens: z.number().int(),
      contextWindow: z.number().int().nullable(),
      ttftMs: z.number().int().default(0), ttftMsMax: z.number().int().default(0),
      decodeTps: z.number().int().default(0),
 // 子代理消耗(单独一窗;不并入 tokens)
      subagents: z.object({
        spawned: z.number().int(),
        agents: z.array(z.object({
          agentId: z.string(),
          taskId: z.string().optional(),
          title: z.string().optional(),
          calls: z.number().int(),
          input: z.number().int(), output: z.number().int(), total: z.number().int(), cached: z.number().int(),
          llmMs: z.number().int(),
        })),
        totals: z.object({ calls: z.number().int(), input: z.number().int(), output: z.number().int(), total: z.number().int(), cached: z.number().int(), llmMs: z.number().int() }),
      }).optional(),
 // 逐模型用量(2026-11「用了什么模型」):runtime deriveTraceStats 产出、面板成本区逐模型列出。
 // 服务端一直在发(server.ts trace.stats 分支既读 stats.byModel),此前 schema 未声明=漏写契约。
      byModel: z.array(z.object({
        model: z.string(), calls: z.number().int(),
        input: z.number().int(), output: z.number().int(), total: z.number().int(), cached: z.number().int(),
 // 缓存写入量(旧 runtime 无该字段 → 缺省 0,旧 payload 照旧可解析)
        cacheWrite: z.number().int().default(0),
      })).optional(),
 // 逐模型成本(server.ts 拼 billingForModel 的结果:model/billed/price/cost/tokens 等混合结构)
      costModels: z.array(z.record(z.any())).optional(),
    }),
  }),
 // 会话状态服务端推送(推送化):任务/待办/子代理状态变化时主动广播,
 // 面板收到即替代一次轮询(轮询保留作断线兜底)。
 // (侧栏按会话活动时间排序):lastActivityAt=该会话最近一次「用户可见动作」的 journal 时间(ms)。
 // 复用本帧的 200ms per-session 合并,不新增 message type(历史故障教训:独立高频帧会放大广播风暴)。
  Envelope.extend({ type: z.literal("session.status.changed"), sessionId: z.string(), lastActivityAt: z.number().optional() }),
 // 语义流程白板:board.get 回包/列表回包/agent 写板广播(面板在板视图时即刷新)
  Envelope.extend({ type: z.literal("board.doc"), sessionId: z.string(), taskId: z.string(), doc: BoardDocZ.nullable(), links: z.array(BoardLinkStateZ).default([]), overlayB64: z.string().optional(), crossFileTargets: z.array(z.object({ name: z.string(), file: z.string(), line: z.number().int() })).optional() }),
 /** 白板出图回包:svg 为 `<svg ...>` 全文,diagnostics 为 flowkit 编译/导出诊断。 */
  BoardDiagramResult,
 /** 手绘批注层拉取回包(会话级落盘;dataB64 缺省=无批注)。 */
  Envelope.extend({ type: z.literal("board.overlay.result"), sessionId: z.string(), taskId: z.string(), dataB64: z.string().optional() }),
  Envelope.extend({
    type: z.literal("board.list.result"),
    sessionId: z.string(),
    items: z.array(z.object({
      taskId: z.string(), title: z.string(), status: z.string(), updatedAt: z.number(), nodeCount: z.number().int(),
 /** :板类型,面板据此按类型过滤(旧服务端缺省=design)。 */
      docKind: z.string().optional(),
 /** :该板未处理的用户评论条数(agent 尚未消费);0/缺省=无待读。 */
      pendingComments: z.number().int().optional(),
    })),
 /** 损坏/不可读板文件数(面板显式降级「板损坏」而非冒充「无板」;0 时服务端缺省不发)。 */
    skipped: z.number().int().optional(),
  }),
 // board.changed 走 bus 广播通道(server.ts onBusEvent),线形={type, payload} 包装。
  Envelope.extend({ type: z.literal("board.changed"), payload: z.object({ sessionId: z.string(), taskId: z.string() }) }),
 // 设计沉淀回包:done 板项目级索引条目(files=节点 symbolRef.file 去重,反查匹配键)
  Envelope.extend({
    type: z.literal("board.archive.result"),
    projectId: z.string().nullable(),
    items: z.array(z.object({
      sessionId: z.string(), taskId: z.string(), title: z.string(), status: z.string(),
      updatedAt: z.number(), nodeCount: z.number().int(), files: z.array(z.string()),
    })),
  }),
 // P3:保存冲突(rev 乐观锁)+批注层随 board.doc 下发(overlayB64)
  Envelope.extend({ type: z.literal("board.conflict"), sessionId: z.string(), taskId: z.string(), currentRev: z.number().int() }),
 // ---- 工作流板:编译回包 / 运行进度广播 / 运行终态广播 ----
 /** 编译回包(只编译不跑):ok=false 时 errors 列全部编译错误(fail-visible);ok=true 附脚本全文。 */
  Envelope.extend({
    type: z.literal("board.workflow.compile.result"),
    sessionId: z.string(), taskId: z.string(),
    ok: z.boolean(),
    script: z.string().optional(),
    errors: z.array(z.string()).optional(),
    order: z.array(z.string()).optional(),
  }),
 /** 运行进度广播(journal workflow.node 事件驱动):states=nodeId→{state,ms,detail}。 */
  Envelope.extend({
    type: z.literal("board.workflow.progress"),
    sessionId: z.string(), taskId: z.string(), wfId: z.string(),
    states: z.record(z.string(), z.object({
      state: z.enum(["running", "done", "failed"]),
      ms: z.number().int().optional(),
      detail: z.string().optional(),
    })),
  }),
 /** 运行终态广播:编译失败(ok=false+errors)或引擎跑完(items/logs 截断有界)。 */
  Envelope.extend({
    type: z.literal("board.workflow.result"),
    sessionId: z.string(), taskId: z.string(), wfId: z.string(),
    ok: z.boolean(),
    errors: z.array(z.string()).optional(),
    partial: z.boolean().optional(),
    error: z.string().optional(),
    items: z.array(z.record(z.string(), z.unknown())).optional(),
    logs: z.array(z.string()).optional(),
    durationMs: z.number().int().optional(),
    states: z.record(z.string(), z.object({
      state: z.enum(["running", "done", "failed"]),
      ms: z.number().int().optional(),
      detail: z.string().optional(),
    })).optional(),
  }),
 // 会话进度投影(ZCode ConversationStatusPanel 的拉模型版;轮询由面板发起)
  Envelope.extend({
    type: z.literal("session.status.result"),
 /** 回显请求的会话 id:面板按它登记水位表(缺它则所有会话的水位都落到
 * undefined 键 → 后续请求永远发不出 sinceSeq,增量路径形同虚设 —— 浏览器经验证抓到)。
 * 可选:旧网关不回显时面板退回「当前会话」口径(Tolerant Reader)。 */
    sessionId: z.string().min(1).optional(),
    status: z.object({
 /** 增量化:水位=该会话当前最大 seq(空会话=0)。面板据此下次带 sinceSeq 走增量。
 * 与 status.task 索引化同批(2026-11 治网关 OOM):task 只带 TaskIndex,instruction/result
 * 全文一律不进状态帧(面板按 id 走 task.detail.get)。 */
      seq: z.number().int().nonnegative(),
      task: TaskIndex.nullable(),
      todo: z.object({
        items: z.array(z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })),
        completed: z.number().int(),
        total: z.number().int(),
      }).nullable(),
      subagents: z.object({ spawnCount: z.number().int(), resultCount: z.number().int(), running: z.number().int() }),
      workflows: z.array(z.object({ wfId: z.string(), asks: z.number().int(), done: z.boolean() })),
      compactions: z.array(z.object({ at: z.number(), tokens: z.number().optional(), summaryChars: z.number().optional() })).default([]),
 // 子代理实时清单(B 面板过程卡):后台注册表按会话过滤+output.txt tail;缺省=注册表缺席(降级)
 // model(子代理目录):子代理实际模型名(注册表缺席/旧进程=缺省,目录回落「主模型」文案)
 // deadline/heartbeatAt/stale/stopReason(目录深化,并行线字段):有则透传无则缺省——面板防御式渲染。
      subagentList: z.array(z.object({
        agentId: z.string(), status: z.string(), outputFile: z.string(),
        tail: z.string().optional(), title: z.string().optional(), model: z.string().optional(),
        deadline: z.number().optional(), heartbeatAt: z.number().optional(),
        stale: z.boolean().optional(), stopReason: z.string().optional(),
      })).optional(),
 // 重试态跨会话保活(batch1b):gateway 内存镜像回填;缺省/无重试=不带该字段(旧客户端零影响)。
 // attempt ≤ 2 由面板静默,前端 schema 不裁剪(是否需要展示由 UI 阈值决定)。
      apiRetry: ApiRetryStatusZ.optional(),
    }),
  }),
 // 运行看板(参考项目 dashboard 融合):会话卡/趋势回包 + journal 变更推模型触发。
  Envelope.extend({
    type: z.literal("dashboard.sessions.result"),
 /** 'all'/项目 id/'unassigned' 回显。 */
    scope: z.string(),
    sessions: z.array(z.object({
      sessionId: z.string(),
      status: z.enum(["running", "waiting_for_input", "error", "idle", "stopped"]),
      projectId: z.string().nullable(),
      taskState: z.string().nullable(),
      promptSummary: z.string(),
      lastActivity: z.number(),
      startedAt: z.number(),
      lastTool: z.string(),
      prompts: z.array(z.string()),
      promptCount: z.number().int(),
      turns: z.number().int(),
      toolCalls: z.number().int(),
      stoppedOutput: z.string(),
      stoppedAt: z.number(),
      interventions: z.object({ interrupt: z.number().int(), denied: z.number().int(), correction: z.number().int() }),
      interventionCount: z.number().int(),
      tokens: z.object({ input: z.number(), output: z.number(), total: z.number() }),
      llmMs: z.number(),
      durationMs: z.number(),
      hadError: z.boolean(),
      subagents: z.object({ spawned: z.number().int(), results: z.number().int(), failed: z.number().int(), backgrounded: z.number().int() }),
      boards: z.number().int(),
      denials: z.array(z.object({ time: z.number(), tool: z.string(), by: z.string() })),
 /** B2 阶段门自动推进次数(plan.gate effect=phase-auto-advanced;正常口径)。 */
      phaseAutoAdvanced: z.number().int(),
    })),
  }),
  Envelope.extend({
    type: z.literal("dashboard.trends.result"),
    scope: z.string(),
    current: z.object({
      sessionsEnded: z.number().int(),
      successRate: z.number().nullable(),
      avgPrompts: z.number().nullable(),
      avgDurationMs: z.number().nullable(),
      avgTokens: z.number().nullable(),
      avgLlmMs: z.number().nullable(),
      correctionRate: z.number().nullable(),
    }),
    previous: z.object({
      sessionsEnded: z.number().int(),
      successRate: z.number().nullable(),
      avgPrompts: z.number().nullable(),
      avgDurationMs: z.number().nullable(),
      avgTokens: z.number().nullable(),
      avgLlmMs: z.number().nullable(),
      correctionRate: z.number().nullable(),
    }),
 /** 近 14 天日桶(C 阶段:token/耗时入趋势图;升序,缺日补零)。 */
    daily: z.array(z.object({
      day: z.string(),
      sessionsEnded: z.number().int(),
      sessionsSucceeded: z.number().int(),
      promptTurns: z.number().int(),
      durationMs: z.number(),
      sessionsCorrected: z.number().int(),
      tokensIn: z.number(),
      tokensOut: z.number(),
      toolCalls: z.number().int(),
      subagents: z.number().int(),
      llmMs: z.number(),
    })).default([]),
  }),
 // journal 有新事件(节流尾沿广播);面板收到后按当前视图重拉 sessions/trends。
  Envelope.extend({ type: z.literal("dashboard.changed") }),
 // 错误帧:code 走 ErrorCode 过渡 union(登记码收窄提示 + 历史字符串仍放行,Q1)。
  Envelope.extend({ type: z.literal("error"), code: ErrorCodeSchema, message: z.string() }),
 // repo wiki:manifest 为结构化页面索引(panel 直接消费;z.record 保持协议松耦合)
  Envelope.extend({
    type: z.literal("wiki.list.result"),
    projectId: z.string().nullable(),
    root: z.string(),
    repo: z.string(),
    dir: z.string(),
    exists: z.boolean(),
    manifest: z.record(z.unknown()).nullable(),
  }),
  Envelope.extend({
    type: z.literal("wiki.page.result"),
    projectId: z.string().nullable(),
    root: z.string(),
    pageId: z.string(),
    page: z.record(z.unknown()).nullable(),
    markdown: z.string().nullable(),
  }),
  Envelope.extend({
    type: z.literal("wiki.rebuild.result"),
    projectId: z.string().nullable(),
    root: z.string(),
    hit: z.boolean(),
    reason: z.string(),
    rebuilt: z.array(z.string()),
    reused: z.array(z.string()),
    removed: z.array(z.string()),
    llmCalls: z.number().int(),
    durationMs: z.number().int(),
    manifest: z.record(z.unknown()),
  }),
  Envelope.extend({ type: z.literal("pong"), time: z.number() }),
  Envelope.extend({
    type: z.literal("exp.list.result"),
    items: z.array(z.object({ category: z.string(), name: z.string(), description: z.string() })),
 /** 已禁用条目(恢复入口数据源)。 */
    disabled: z.array(z.object({ category: z.string(), name: z.string() })).default([]),
  }),
  Envelope.extend({
    type: z.literal("exp.view.result"),
    category: z.string(), name: z.string(), body: z.string().nullable(),
  }),
  Envelope.extend({
    type: z.literal("exp.remove.result"),
    category: z.string(), name: z.string(), ok: z.boolean(),
  }),
  Envelope.extend({ type: z.literal("sys.meta.result"), meta: z.record(z.string(), z.unknown()) }),
  Envelope.extend({
    type: z.literal("cfg.get.result"),
    config: z.record(z.string(), z.unknown()),
    sources: z.record(z.string(), z.string()),
    projectPath: z.string(),
  }),
  Envelope.extend({
    type: z.literal("cfg.set.result"),
    applied: z.array(z.string()),
    needsRestart: z.array(z.string()),
 /** env 占用键(模型切换失效根治配套):这些键被进程 env 层(GENIE_LLM_*)压住,
 * 重启也不会生效——面板据此把「重启生效」徽标升格为「env 占用」警示。 */
    envOccupied: z.array(z.string()).optional(),
 /** 实际生效选择(2026-10-20 Provider Registry 语义):模型/端点/协议/凭证来源,绝不含密钥值。
 * 面板据此显示真话(不再是「热生效」的空头承诺)。 */
    effective: z.object({
      model: z.string(),
      providerId: z.string().optional(),
      baseUrl: z.string(),
      apiKeyEnv: z.string(),
      apiType: z.enum(["chat", "responses", "anthropic"]),
      credentialSource: z.enum(["env", "secrets", "legacy-env", "legacy-secrets", "none"]),
      unverified: z.boolean(),
    }).optional(),
 /** 非致命提示(未验证模型 / max_tokens 超默认)。 */
    warning: z.string().optional(),
 /** 凭据不可解析等硬错误:已写配置但未热切,面板必须 fail-visible。 */
    routeError: z.string().optional(),
  }),
  Envelope.extend({
    type: z.literal("cfg.secret.result"),
    op: z.enum(["status", "set"]),
    rid: z.string().optional(),
    ok: z.boolean().optional(),
    name: z.string().optional(),
    existed: z.boolean().optional(),
 /** 只含名字与是否已存在;绝不回显密钥值。 */
    items: z.array(z.object({ name: z.string(), exists: z.boolean() })).optional(),
    error: z.string().optional(),
  }),
  Envelope.extend({ type: z.literal("models.list.result"), ids: z.array(z.string()), providerId: z.string().optional(), probeOnly: z.boolean().optional() }),
 // ---- tunnel 委派(§4):任务书下发远端节点;凭证只带引用名,值由节点本地解析 ----
  Envelope.extend({
    type: z.literal("node.task.dispatch"),
    taskId: z.string().min(1),
    instruction: z.string().min(1),
 /** 凭证引用名(红线:值不过 gateway;节点从本地凭据库解析)。 */
    credentialRef: z.string().optional(),
 /** 委派深度(网关只发 1;节点侧不再委派=机制保证)。 */
    delegatedDepth: z.number().int().nonnegative().default(0),
  }),
  Envelope.extend({ type: z.literal("node.task.cancel"), taskId: z.string().min(1) }),
 // 权限审批请求:广播给已连接客户端;超时无应答=自动拒绝(fail-closed)。
  Envelope.extend({
    type: z.literal("permission.ask"),
    requestId: z.string().min(1),
    sessionId: z.string(),
    tool: z.string(),
    summary: z.string(),
    risk: z.string().default("medium"),
 /** 自动拒绝倒计时(ms);面板据此显示。 */
    timeoutMs: z.number().int().positive(),
  }),
  Envelope.extend({ type: z.literal("files.result"), query: z.string(), files: z.array(z.string()) }),
 // 会话全文检索回包:result=DiscoverResult(browse 时空 query 也走此型)。
  Envelope.extend({ type: z.literal("session.search.result"), query: z.string(), result: z.unknown() }),
 // ask_user(许愿式编程):主 agent 需求取舍发问,面板问答条答复(ask.user.answer)。
  Envelope.extend({
    type: z.literal("ask.user"),
    requestId: z.string(),
    sessionId: z.string(),
    question: z.string(),
    options: z.array(z.string()).optional(),
    context: z.string().optional(),
    timeoutMs: z.number().optional(),
  }),
 // F6:workflow 问题广播(面板可直答;超时由引擎回退 executor,不广播取消——面板自查超时隐藏)。
  Envelope.extend({
    type: z.literal("workflow.question"),
    wfId: z.string(),
    cacheKey: z.string(),
    instructions: z.string(),
    timeoutMs: z.number().int().positive(),
  }),
  Envelope.extend({
    type: z.literal("file.read.result"),
    path: z.string(),
    startLine: z.number().int(),
    totalLines: z.number().int(),
    content: z.string(),
    missing: z.boolean().optional(),
 /** IDE(full=true):二进制文件(首 8KB 含 NUL)不回 content,只回标记。 */
    binary: z.boolean().optional(),
 /** IDE(full=true):>2MB 不回全文,只回标记(响应体防放大)。 */
    tooLarge: z.boolean().optional(),
 /** :显式 projectId 的项目目录不可用(只读保护;面板提示恢复目录而非「不存在」)。 */
    unavailable: z.boolean().optional(),
  }),
 // IDE 保存链:ok=落盘成功;失败回 error(code=file-write-denied,message 带 reason)。
  Envelope.extend({
    type: z.literal("file.write.result"),
    path: z.string(),
    ok: z.boolean(),
    bytes: z.number().int().optional(),
  }),
 // 板「OOXML 文本回写」P2:Office 文本级编辑回执(服务端读原文件→重写→落盘)。
 // ok=false 时 error 带人话原因(下标越界/找不到文本节点/沙箱拒绝/远程项目不支持)。
  Envelope.extend({
    type: z.literal("ide.office.edit.result"),
    path: z.string(),
    ok: z.boolean(),
    bytes: z.number().int().optional(),
    error: z.string().optional(),
  }),
  Envelope.extend({
    type: z.literal("git.status.result"),
    branch: z.string(),
    changes: z.array(z.object({ file: z.string(), staged: z.boolean(), label: z.string() })),
    norepo: z.boolean().optional(),
  }),
  Envelope.extend({ type: z.literal("git.diff.result"), file: z.string(), patch: z.string() }),
  Envelope.extend({ type: z.literal("git.branches.result"), current: z.string(), branches: z.array(z.string()), norepo: z.boolean().optional() }),
  Envelope.extend({ type: z.literal("git.ok"), op: z.string(), detail: z.string().optional() }),
  Envelope.extend({
    type: z.literal("checkpoint.preview.result"),
    taskId: z.string(),
    sha: z.string().nullable(),
    files: z.array(z.string()),
  }),
 // 内联变更条:无快照/无差异=空 files,面板隐藏条。
  Envelope.extend({
    type: z.literal("task.diffstat.result"),
    taskId: z.string(),
    sha: z.string().nullable(),
    files: z.array(z.object({ path: z.string(), add: z.number(), del: z.number() })),
    total: z.object({ files: z.number(), add: z.number(), del: z.number() }),
    error: z.string().optional(),
  }),
 // 单文件补丁结果:变更条文件清单→右侧 diff 面板。
  Envelope.extend({
    type: z.literal("task.filediff.result"),
    taskId: z.string(),
    file: z.string(),
    diff: z.string().optional(),
    truncated: z.boolean().optional(),
    error: z.string().optional(),
  }),
 // 模型探活结果:设置页模型列表逐项「测」→最小 chat 调用往返。
  Envelope.extend({
    type: z.literal("models.probe.result"),
    model: z.string(),
    ok: z.boolean(),
    ms: z.number(),
    error: z.string().optional(),
  }),
 // 使用统计:journal 离线归约(journal 全量事件+任务登记表)。
  Envelope.extend({
    type: z.literal("stats.summary.result"),
    summary: z.object({
      totals: z.object({
        tasks: z.number(), tasksDone: z.number(), tasksFailed: z.number(), sessions: z.number(),
        turns: z.number(), llmCalls: z.number(), toolCalls: z.number(),
        tokens: z.object({ input: z.number(), output: z.number(), total: z.number() }),
        wallMs: z.number(), workMs: z.number(),
      }),
      perDay: z.array(z.object({ day: z.string(), turns: z.number(), tokens: z.number() })),
      heatmap: z.array(z.array(z.number())),
      sessions: z.array(z.object({
        sessionId: z.string(), turns: z.number(), tokens: z.number(),
        llmCalls: z.number(), toolCalls: z.number(), lastAt: z.number(), tasks: z.number(),
      })),
      byModel: z.array(z.object({ model: z.string(), calls: z.number(), tokens: z.number() })),
      byTool: z.array(z.object({ name: z.string(), calls: z.number() })).optional(),
      activity: z.object({ peakTokens: z.number(), currentStreak: z.number(), longestStreak: z.number() }).optional(),
      quota: z.object({ today: z.number(), week: z.number(), budget: z.number(), resetAt: z.number(), weekStartAt: z.number() }).optional(),
      health: z.object({ samples: z.array(z.object({ t: z.number(), tps: z.number() })), avgTps: z.number() }).optional(),
      generatedAt: z.number(),
    }),
  }),
 // 管理面结果
  Envelope.extend({
    type: z.literal("agents.list.result"),
    agents: z.array(z.object({ name: z.string(), description: z.string(), systemPrompt: z.string().optional(), tools: z.array(z.string()).optional(), builtin: z.boolean() })),
  }),
  Envelope.extend({
    type: z.literal("skills.list.result"),
    items: z.array(z.object({ category: z.string(), name: z.string(), description: z.string() })),
    disabled: z.array(z.object({ category: z.string(), name: z.string() })).optional(),
  }),
  Envelope.extend({
    type: z.literal("commands.list.result"),
 // 2026-10 ZCode 语义:内置(catalog)在前 + 自定义在后;除 name 全可选,保持旧客户端兼容。
    commands: z.array(z.object({
      name: z.string(),
      body: z.string().optional(),
      description: z.string().optional(),
      inputHint: z.string().optional(),
      source: z.enum(["builtin", "custom"]).optional(),
      path: z.string().optional(),
    })),
 /** 自定义命令发现期的诊断(warning:被覆盖/被保留名拦截/超限跳过等)。 */
    diagnostics: z.array(z.object({
      path: z.string(), severity: z.enum(["warning", "error"]), message: z.string(),
      code: z.string().optional(), commandName: z.string().optional(),
    })).optional(),
  }),
  Envelope.extend({
    type: z.literal("commands.catalog.result"),
 // 纯内置 catalog(不带 body;面板据此渲染命令中心,自定义另走 commands.list)。
    commands: z.array(z.object({
      name: z.string(),
      description: z.string(),
      inputHint: z.string().optional(),
      source: z.enum(["builtin", "custom"]).optional(),
      usage: z.string().optional(),
      details: z.array(z.string()).optional(),
    })),
  }),
  Envelope.extend({
    type: z.literal("hooks.list.result"),
    hooks: z.array(z.object({
      id: z.string(), name: z.string(), event: z.string(), command: z.string(), enabled: z.boolean(),
      createdAt: z.number(), lastRunAt: z.number().nullable(), lastOk: z.boolean().nullable(), lastOutput: z.string().optional(),
    })),
  }),
  Envelope.extend({
    type: z.literal("mcp.list.result"),
    servers: z.array(z.object({ id: z.string(), name: z.string(), command: z.string(), args: z.array(z.string()), enabled: z.boolean(), createdAt: z.number() })),
    status: z.record(z.string(), z.object({ ok: z.boolean().nullable(), tools: z.number(), error: z.string().optional() })),
  }),
  Envelope.extend({
    type: z.literal("mcp.test.result"),
    id: z.string(),
    ok: z.boolean().nullable(),
    tools: z.number(),
    error: z.string().optional(),
  }),
  Envelope.extend({
    type: z.literal("memory.view.result"),
    user: z.string(),
    memory: z.string(),
    root: z.string(),
    usage: z.object({ user: z.object({ used: z.number(), limit: z.number() }), memory: z.object({ used: z.number(), limit: z.number() }) }),
  }),
 // 插件市场
  Envelope.extend({
    type: z.literal("plugins.list.result"),
    catalog: z.array(z.object({
      id: z.string(), name: z.string(), description: z.string(), version: z.string(),
      author: z.string(), category: z.string(),
      provides: z.object({
        commands: z.array(z.object({ name: z.string(), body: z.string() })).optional(),
        agents: z.array(z.object({ name: z.string(), description: z.string(), systemPrompt: z.string(), tools: z.array(z.string()).optional() })).optional(),
        mcp: z.array(z.object({ name: z.string(), command: z.string(), args: z.array(z.string()).optional() })).optional(),
        skills: z.array(z.object({ name: z.string(), description: z.string(), body: z.string() })).optional(),
      }),
      installed: z.boolean().optional(), enabled: z.boolean().optional(),
    })),
  }),
 // 项目档案
  Envelope.extend({
    type: z.literal("profile.get.result"),
    profile: z.object({
      projectId: z.string(), root: z.string(),
      state: z.enum(["pending", "running", "done", "failed"]),
      progress: z.number(), stage: z.string(),
      startedAt: z.number(), finishedAt: z.number().nullable().optional(),
      modules: z.array(z.object({
        name: z.string(), path: z.string(), files: z.number(), lines: z.number(),
        deps: z.array(z.string()), keyFiles: z.array(z.string()), desc: z.string(), addedAt: z.number().optional(), descHasAi: z.boolean().optional(),
      })),
      edges: z.array(z.object({ from: z.string(), to: z.string() })),
      mermaid: z.string(),
      stats: z.object({ files: z.number(), lines: z.number(), languages: z.record(z.string(), z.number()), projectState: z.string() }),
      recentChanges: z.array(z.object({
        at: z.number(), taskId: z.string(), title: z.string(),
        modules: z.array(z.string()), files: z.number(), add: z.number(), del: z.number(),
      })),
      newModules: z.array(z.string()),
      plan: z.array(z.object({
        id: z.string(), kind: z.enum(["add-module", "remove-module", "add-dep"]), createdAt: z.number(),
        name: z.string().optional(), note: z.string().optional(), reason: z.string().optional(),
        from: z.string().optional(), to: z.string().optional(),
      })).optional(),
      gitHistory: z.array(z.object({
        module: z.string(), commits30d: z.number(),
        commits: z.array(z.object({ sha: z.string(), subject: z.string(), author: z.string(), at: z.number() })),
      })).optional(),
      error: z.string().optional(),
    }),
  }),
  Envelope.extend({ type: z.literal("profile.progress"), projectId: z.string(), progress: z.number(), stage: z.string(), state: z.string() }),
 // 总路线:项目开发宗旨/主线能力/偏离提示 + 确定性骨架事实;exists=false=manifest 缺席
  Envelope.extend({
    type: z.literal("profile.sense.result"),
    projectId: z.string().nullable().optional(),
    root: z.string(),
    exists: z.boolean(),
    stale: z.boolean().optional(),
    builtAt: z.number().optional(),
    maturity: z.string().optional(),
    purpose: z.string().optional(),
    purposeSource: z.enum(["llm", "readme", "manifest"]).optional(),
    capabilities: z.array(z.string()),
    driftWarnings: z.array(z.string()),
    llmState: z.object({ status: z.enum(["ok", "off", "failed"]), reason: z.string().optional() }),
    skeleton: z.object({
      purposeCandidates: z.array(z.object({ text: z.string(), source: z.string(), evidence: z.object({ file: z.string(), line: z.number() }) })),
      domain: z.string().optional(),
      techStack: z.array(z.object({ language: z.string(), files: z.number() })),
      frameworks: z.array(z.object({ name: z.string(), domain: z.string(), evidence: z.object({ file: z.string(), line: z.number() }) })),
      entrypoints: z.array(z.string()).optional(),
      topoNotes: z.array(z.string()),
      degraded: z.array(z.object({ layer: z.string(), reason: z.string() })),
    }).optional(),
    generated: z.boolean().optional(),
  }),
  Envelope.extend({
    type: z.literal("nodes.list.result"),
    nodes: z.array(z.object({
      nodeId: z.string(), capabilities: z.array(z.string()), reachability: z.array(z.string()),
      load: z.object({ cpu: z.number(), mem: z.number(), runningTasks: z.number() }),
      lastHeartbeat: z.number(), online: z.boolean(),
    })),
    identity: z.object({ fingerprint: z.string().optional(), mode: z.string() }).optional(),
  }),
 // 节点 Fleet:注册/掉线/心跳在线态翻转的廉价广播(面板收即重拉 nodes.list;负载细节仍在回包)。
  Envelope.extend({ type: z.literal("nodes.changed") }),
 // 节点 Fleet「电脑控制」真路由回执:remote=NodeDispatch.delegate 结果;local 照旧走 task 链无此帧。
  Envelope.extend({ type: z.literal("node.exec.result"), nodeId: z.string(), ok: z.boolean(), output: z.string().optional(), error: z.string().optional(), durationMs: z.number().optional() }),
  Envelope.extend({
    type: z.literal("wizard.gen.result"),
    kind: z.enum(["ssh", "docker"]),
    command: z.string(),
    note: z.string(),
  }),
  Envelope.extend({ type: z.literal("term.output"), chunk: z.string(), err: z.boolean().optional() }),
 // 流式消息(ZCode 流式消息展示):loop onStream 旁路广播;不落 journal,终态由 task.changed/session.history 承接。
  Envelope.extend({
    type: z.literal("stream"),
    sessionId: z.string(),
    ev: z.union([
      z.object({ type: z.literal("llm-begin") }),
      z.object({ type: z.literal("llm-delta"), text: z.string().optional(), reasoning: z.string().optional() }),
      z.object({ type: z.literal("llm-end"), text: z.string() }),
      z.object({ type: z.literal("tool-begin"), callId: z.string(), name: z.string() }),
      z.object({ type: z.literal("tool-end"), callId: z.string(), name: z.string(), durationMs: z.number() }),
      z.object({ type: z.literal("tool-progress"), callId: z.string(), name: z.string(), note: z.string() }), // fixC-D4:长工具(code_review 深审等)阶段进度,面板实时可见防「以为挂了」
    ]),
  }),
  Envelope.extend({ type: z.literal("term.exit"), code: z.number().nullable(), killed: z.boolean().optional() }),
  Envelope.extend({
    type: z.literal("automation.list.result"),
    automations: z.array(z.object({
      id: z.string(), name: z.string(), instruction: z.string(),
      everyMinutes: z.number().int(), enabled: z.boolean(),
      createdAt: z.number(), lastRunAt: z.number().nullable(), nextRunAt: z.number(),
      lastTaskSessionId: z.string().nullable(), runCount: z.number().int(),
      scope: z.string().optional(),
    })),
  }),
  Envelope.extend({
    type: z.literal("git.log.result"),
    commits: z.array(z.object({ hash: z.string(), subject: z.string(), author: z.string(), date: z.string() })),
  }),
 // 评审遗留(行级回写店:sticky 跨轮视图(open=未解决,resolved=已标记不再复现)。
  Envelope.extend({
    type: z.literal("review.store.result"),
    projectId: z.string().nullable(),
    root: z.string(),
    open: z.array(StoredCommentZ),
    resolved: z.array(StoredCommentZ),
  }),
 // 评审评论回注回执:注入目标会话+新任务 id+条数,面板据此 toast/跳转。
  Envelope.extend({
    type: z.literal("review.inject.result"),
    sessionId: z.string(),
    taskId: z.string(),
    count: z.number().int(),
  }),
 // 项目清单:连接即推+变更广播;availability=启动期一次性校验(ZCode 同语义)。
  Envelope.extend({
    type: z.literal("project.list.result"),
    projects: z.array(z.object({
      id: z.string(),
      path: z.string(),
      label: z.string(),
      availability: z.enum(["available", "unavailable-local-directory", "unavailable-remote-unverified", "unavailable-remote-unreachable"]),
    })),
    activeProjectId: z.string(),
  }),
 // 服务端目录浏览:path="" 为锚点应答;error 时 entries 缺省。
  Envelope.extend({
    type: z.literal("fs.list.result"),
    path: z.string(),
    parent: z.string().nullable().optional(),
    home: z.string().optional(),
    anchors: z.object({ home: z.string(), root: z.string(), cwd: z.string() }).optional(),
    entries: z.array(z.object({
      name: z.string(),
      kind: z.enum(["dir", "file"]),
      size: z.number(),
      mtime: z.number(),
    })).optional(),
    error: z.string().optional(),
  }),
  Envelope.extend({
    type: z.literal("fs.open.result"),
    path: z.string(),
    ok: z.boolean(),
    tool: z.string(),
    error: z.string().optional(),
  }),
 // IDE 文件操作回包(mkdir/remove/rename 三通道同构):ok=false 时 error 带拒因
 // (越界/.git/目标不存在/目录非空未传 recursive…),面板据此 toast 并不刷新树。
  Envelope.extend({ type: z.literal("fs.mkdir.result"), path: z.string(), ok: z.boolean(), error: z.string().optional() }),
  Envelope.extend({ type: z.literal("fs.remove.result"), path: z.string(), ok: z.boolean(), error: z.string().optional() }),
  Envelope.extend({ type: z.literal("fs.rename.result"), from: z.string(), to: z.string(), ok: z.boolean(), error: z.string().optional() }),
 // 全项目内容搜索:matches[{ path(项目内相对), line(1-based), text(整行,已截断 400 字符) }]。
  Envelope.extend({
    type: z.literal("fs.grep.result"),
    query: z.string(),
    matches: z.array(z.object({ path: z.string(), line: z.number().int(), text: z.string() })),
 /** 命中数被 maxResults 截断(面板提示「仅显示前 N 条」)。 */
    truncated: z.boolean().optional(),
    error: z.string().optional(),
  }),
 // ---- 面板 IDE 第二批回包:lsp.diagnostics(问题面板)/ term.session.*(持久终端)/ git.show(文件历史) ----
 // requestId 原样回传(面板按其对齐请求);失败走 error 帧(message 带 requestId 供归因)。
  Envelope.extend({
    type: z.literal("lsp.diagnostics.result"),
    requestId: z.string(),
 /** line/col 均 1-based;severity 只回 error/warning(信息级噪声不上问题面板)。 */
    diagnostics: z.array(z.object({
      path: z.string(),
      line: z.number().int(),
      col: z.number().int(),
      severity: z.enum(["error", "warning"]),
      message: z.string(),
      code: z.string().optional(),
    })),
  }),
  Envelope.extend({ type: z.literal("term.session.open.result"), requestId: z.string(), sessionId: z.string() }),
  Envelope.extend({ type: z.literal("term.session.send.result"), requestId: z.string() }),
  Envelope.extend({
    type: z.literal("term.session.read.result"),
    requestId: z.string(),
    data: z.string(),
 /** 缓冲游标(单调递增;下次 read 传回做增量)。 */
    cursor: z.number().int(),
  }),
  Envelope.extend({ type: z.literal("term.session.close.result"), requestId: z.string() }),
  Envelope.extend({ type: z.literal("git.show.result"), requestId: z.string(), content: z.string() }),
 // 会话分叉回包(ZCode session-fork 语义移植,refs: ZCode):ok=false 时 reason 必带。
 // modelOverride:父会话若有 per-session 主模型覆盖,fork 后继承认该覆盖(同 zcode
 // session-fork 的 modelSelection 继承);无覆盖=缺省,新会话跟随全局 coding.llm。
  Envelope.extend({
    type: z.literal("session.fork.result"),
    ok: z.boolean(),
    sessionId: z.string().optional(),
    copied: z.number().int().optional(),
    reason: z.string().optional(),
    modelOverride: z.object({ model: z.string(), providerId: z.string().optional(), effort: z.string().optional() }).nullable().optional(),
  }),
 // per-session 主模型回包:「实际生效选择」语义与 cfg.set.result.effective 同构(不含密钥值)。
 // 改为**广播**(多标签/多客户端同步),payload 带 ok/effective/routeError/warning/revision;
 // ok=false 时 routeError(选择不可用,未落盘)或 code=revision-mismatch(CAS 冲突)。
  Envelope.extend({
    type: z.literal("session.model.result"),
    sessionId: z.string(),
 /** 该会话的覆盖选择;null=未设置(沿用全局 coding.llm)。 */
    modelOverride: z.object({
      model: z.string(),
      providerId: z.string().optional(),
 /** 会话级 effort 覆盖;"缺省"=跟随全局 implementationEffort,""=显式关闭。 */
      effort: z.string().optional(),
    }).nullable(),
 /** 本次操作是否被接受(缺省 true=旧回包兼容);false 时不落盘,reason 见 routeError/code。 */
    ok: z.boolean().optional(),
 /** 拒绝原因码:route-error=选择不可用(端点/凭证),revision-mismatch=并发 CAS 冲突,
 * invalid-effort=effort 取值非法(m7)。 */
    code: z.enum(["route-error", "revision-mismatch", "invalid-effort"]).optional(),
 /** 该会话覆盖的写入版本(0=无覆盖);每次成功写入 +1,面板据此做 expectedRevision 乐观并发。 */
    revision: z.number().int().nonnegative().optional(),
    effective: z.object({
      model: z.string(),
      providerId: z.string().optional(),
      baseUrl: z.string(),
      apiKeyEnv: z.string(),
      apiType: z.enum(["chat", "responses", "anthropic"]),
      credentialSource: z.enum(["env", "secrets", "legacy-env", "legacy-secrets", "none"]),
      unverified: z.boolean(),
    }).optional(),
    warning: z.string().optional(),
    routeError: z.string().optional(),
  }),
 // 会话→owner 项目桥回包:projectId=该会话最早一条带 projectId 的任务的项目 id;无归属=null。
  Envelope.extend({ type: z.literal("session.owner.result"), sessionId: z.string(), projectId: z.string().nullable() }),
 // 轨迹查询回包(txa6/txa7/txa8):events=已投影裁剪的事件(content/text/arguments 截断、
 // images 换占位串);summary 宽松(聚合面由 runtime 的 queryTrace 定义,协议不做字段级约束,
 // 便于聚合面继续演进不破线)。会话不存在=空事件+零值 summary,不断连接。
  Envelope.extend({
    type: z.literal("trace.query.result"),
    sessionId: z.string(),
    events: z.array(z.any()),
    summary: z.record(z.any()),
  }),
 // 截图标注提交回执(annotate.submit 的应答;失败带可操作 message)。
  AnnotateResult,
 // 录屏批注回执(annotate.record 的应答;parseError 为 omni 解析失败原因,fail-soft)。
  AnnotateRecordResult,
 // 聊天窗语音任务书回执(voice.draft 的应答;ok=false 带「未配置」指路)。
  VoiceDraftResult,
 // RSI 状态只读快照应答(rsi.status 的应答;请求-响应,不主动推)。
  RsiStatusResult,
 // RSI 机制治理面应答(开关/运行/条目改删;同样请求-响应)。
  RsiMechanismSetResult,
  RsiMechanismRunResult,
  RsiItemResult,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** 解析客户端消息;非法返回 null(调用方决定断开还是报错)。 */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const r = ClientMessage.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * 非法客户端消息的「指路」文案(P3 修复):把 zod 校验的具体 issues(哪个字段、什么问题)
 * 与消息 type 一起拼进 error message,拼进去的 issues 截断 200 字符;合法消息返回 null(调用方用兜底文案)。
 * 动机:旧文案「非法消息(信封 v:1 必填/未知类型/字段缺失)」三类原因混在一起,调用方无从定位。
 * 注意:type 来自客户端 JSON(可任意长),也做截断——否则回显的 error 帧会被客户端文本撑大。
 */
export function explainClientMessageError(raw: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return "消息解析异常:" + String(err).slice(0, 120);
  }
  const r = ClientMessage.safeParse(json);
  if (r.success) return null;
  const t: unknown = (json as { type?: unknown } | null)?.type;
  const typeLabel = typeof t === "string" ? t.slice(0, 40) : "未知";
 // 增量累积到 200 即停:未知 type 时 zod 的 discriminator issue 会列出全部合法 type(数 KB),
 // join 完整串再 slice 会白构造一遍。
  const parts: string[] = [];
  let len = 0;
  for (const i of r.error.issues) {
    const seg = `${i.path.length > 0 ? i.path.join(".") : "(root)"}:${i.message}`;
    parts.push(seg);
    len += seg.length + (parts.length > 1 ? 2 : 0); // +2 = "; " 分隔符
    if (len >= 200) break;
  }
  return `非法消息(type=${typeLabel}):${parts.join("; ").slice(0, 200)}`;
}

// Team Relay 协议( §8 子集):独立消息族,与 gateway 命令族互不掺入。