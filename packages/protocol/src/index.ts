/**
 * Gateway Client Protocol(designs/12 定稿)的 zod schema。
 * 模式参照 qwen-audio-agent shared/protocol(Apache-2.0,能力协商/信封纪律),
 * 内容自研——该仓协议以 voice 事件为主体,不适用 coding harness。
 */
import { z } from "zod";

export { PROTOCOL_VERSION } from "./version.js";
import { PROTOCOL_VERSION } from "./version.js";

const Envelope = z.object({ v: z.literal(PROTOCOL_VERSION) });

// ---- 错误码(单一出处)----
/**
 * gateway 错误帧 `error.code` 的统一枚举(2026 错误语义统一第一批)。
 * 口径对齐 ZCode/packages/shared/src/errors.ts:14-89(normalizeUnknownError:
 * 「结构化 code 优先、message 兜底」)——即 code 是可编程的稳定标识,人话文案由展示层
 * (面板 ERR_TEXT:apps/gateway/src/error-text.ts)按 code 本地化,服务端 message 只做兜底。
 *
 * Q1 过渡方案(本批已拍板):`as const` 对象 + 同名类型 = 收窄但不封闭。
 * error 帧 schema 用 `z.union([z.enum(ERROR_CODE_VALUES), z.string()])`:
 * 新站点写错 code 有 IDE/tsc 提示,历史字符串仍可通过校验(不炸旧调用点/旧客户端)。
 * 后续批次再把 union 收成 z.enum 完成封闭。
 *
 * 值约定:kebab-case(线上字符串与改造前逐字一致,前端判串/日志检索零漂移);
 * 例外 custom_command_reserved_name 沿用 commands-store 诊断口径(历史值不动)。
 */
export const ErrorCode = {
  // ---- 核心/通用 ----
  /** 入站消息 zod 判别失败(协议版本错位也会落这里)。 */
  InvalidMessage: "invalid-message",
  /** handler 抛异常(本地运行时保留原始 message,不脱敏)。 */
  HandlerCrash: "handler-crash",
  /** 能力未装配/功能未开启(队列、MCP、issue、团队 relay…)。 */
  NotImplemented: "not-implemented",
  /** 未分类错误(兜底)。 */
  Unknown: "unknown",
  /** 网关内部错误。 */
  Internal: "internal",
  /** 入参不合法(通用 400)。 */
  BadRequest: "bad-request",
  // ---- 任务/队列/提问 ----
  UnknownTask: "unknown-task",
  UnknownQuestion: "unknown-question",
  UnknownAsk: "unknown-ask",
  UnknownAutomation: "unknown-automation",
  QueueItemMissing: "queue-item-missing",
  // ---- 会议/团队/语音 ----
  MeetingImportFailed: "meeting-import-failed",
  /** step-1033:super agent 指挥台链(新链只发这两个)。 */
  SuperFailed: "super-failed",
  SuperAnnounceFailed: "super-announce-failed",
  /** @deprecated step-1033 legacy:companion 链旧错误码,保留值不删,新链不再发出。 */
  CompanionFailed: "companion-failed",
  /** @deprecated step-1033 legacy:见上。 */
  CompanionAnnounceFailed: "companion-announce-failed",
  VoiceUnavailable: "voice-unavailable",
  VoiceFailed: "voice-failed",
  // ---- 扩展面(插件/hook/MCP/命令/自动化) ----
  PluginInvalid: "plugin-invalid",
  HookInvalid: "hook-invalid",
  McpInvalid: "mcp-invalid",
  CommandInvalid: "command-invalid",
  CustomCommandReservedName: "custom_command_reserved_name",
  AutomationInvalid: "automation-invalid",
  RuleConflict: "rule-conflict",
  // ---- 计划/目标 ----
  PlanInvalid: "plan-invalid",
  PlanEmpty: "plan-empty",
  PlanGoalMutex: "plan-goal-mutex",
  GoalInvalid: "goal-invalid",
  GoalPlanMutex: "goal-plan-mutex",
  // ---- 白板 ----
  BoardInvalid: "board-invalid",
  BoardBadRequest: "board-bad-request",
  BoardNotFound: "board-not-found",
  BoardNodeNotFound: "board-node-not-found",
  BoardNoIndex: "board-no-index",
  BoardFromcodeFailed: "board-fromcode-failed",
  BoardFromsenseFailed: "board-fromsense-failed",
  BoardOverlayInvalid: "board-overlay-invalid",
  BoardFileNotIndexed: "board-file-not-indexed",
  BoardFileEmpty: "board-file-empty",
  // ---- issue/评论 ----
  IssueMissing: "issue-missing",
  CommentTextEmpty: "comment-text-empty",
  CommentIndexOutOfRange: "comment-index-out-of-range",
  // ---- 文件/终端/sense/经验 ----
  FileWriteDenied: "file-write-denied",
  TermFailed: "term-failed",
  TermBusy: "term-busy",
  SenseFailed: "sense-failed",
  MemoryFailed: "memory-failed",
  StatsFailed: "stats-failed",
  SkillsFailed: "skills-failed",
  AgentsFailed: "agents-failed",
  ExpFailed: "exp-failed",
  // ---- 项目/配置/模型/会话 ----
  ProjectAddFailed: "project-add-failed",
  RemoteOpFailed: "remote-op-failed",
  ProjectRemoveFailed: "project-remove-failed",
  ProjectRenameFailed: "project-rename-failed",
  ProjectActivateFailed: "project-activate-failed",
  ProfileSenseFailed: "profile-sense-failed",
  ProfileFileFailed: "profile-file-failed",
  CfgSetFailed: "cfg-set-failed",
  ModelsListFailed: "models-list-failed",
  ModelsNotImplemented: "models-not-implemented",
  /** models.list:providerId 未知 / 一个 Provider 都没配置。 */
  ModelsNoProvider: "models-no-provider",
  /** models.list:Provider 在但 coding 轨端点 baseUrl 为空。 */
  ModelsNotConfigured: "models-not-configured",
  /** models.list:端点/Key 引用解析不到凭证(env 与 secrets 都没有)。 */
  ModelsNoCredential: "models-no-credential",
  /** models.list:上游 HTTP 非 2xx / 网络错误 / 超时 / 响应非 JSON。 */
  ModelsUpstreamFailed: "models-upstream-failed",
  SessionModelSetFailed: "session-model-set-failed",
  SessionExportFailed: "session-export-failed",
  // ---- git/wiki/节点 ----
  GitFailed: "git-failed",
  GitNorepo: "git-norepo",
  WikiListFailed: "wiki-list-failed",
  WikiGetFailed: "wiki-get-failed",
  WikiRebuildFailed: "wiki-rebuild-failed",
  NodeOffline: "node-offline",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
/** 运行时全集(枚举表遍历/契约测试/文案表完备性断言用)。 */
export const ERROR_CODE_VALUES = Object.values(ErrorCode) as [ErrorCode, ...ErrorCode[]];
/** error 帧 code 校验:过渡期 union(收窄不封闭,Q1)。 */
export const ErrorCodeSchema = z.union([z.enum(ERROR_CODE_VALUES), z.string()]);

// ---- 客户端 → 服务端 ----
export const TaskSubmit = Envelope.extend({
  type: z.literal("task.submit"),
  sessionId: z.string().min(1),
  instruction: z.string().min(1),
  targetNode: z.string().optional(),
  resourceTags: z.array(z.string()).optional(),
  idempotencyKey: z.string().optional(),
  /** 凭证引用名(值不过网关,节点本地解析)。 */
  credentialRef: z.string().optional(),
  /** 项目 id(缺省=激活项目;面板提交时带)。 */
  projectId: z.string().optional(),
  /** 附件(step-048):已上传文件(.genie/uploads/<sid>/…);agent 侧注入任务书 + vision 通道。 */
  attachments: z.array(z.object({ name: z.string(), path: z.string(), mime: z.string().optional(), size: z.number().optional() })).optional(),
  // ---- M162 外部来源提交面(全部 optional:面板不带=内部 user 路径逐字零变化)----
  // 只做透传,不在此做结构/权限校验:信封 digest/generation 与自声明拒收都在 gateway task-envelope。
  /** 来源描述符:字符串简写(bot/remote/group/schedule)或对象 {kind,id}(未知键 passthrough)。 */
  source: z
    .union([
      z.enum(["bot", "remote", "group", "schedule"]),
      z.object({ kind: z.string(), id: z.string().optional() }).passthrough(),
    ])
    .optional(),
  /** 客户端自带信封(verify 在 gateway task-envelope;此处 z.any 保证不被 strip)。 */
  envelope: z.any().optional(),
  /** 投递键幂等(外部来源重投 → duplicate 回执)。 */
  deliveryKey: z.string().optional(),
  /** 外部来源不得自声明(服务端拒 SOURCE_SELF_DECLARED_WORKSPACE/PERMISSION)。 */
  workspace: z.string().optional(),
  projectOverride: z.string().optional(),
  permissions: z.any().optional(),
  policy: z.any().optional(),
});
export const TaskCancel = Envelope.extend({
  type: z.literal("task.cancel"),
  taskId: z.string().min(1),
});
// 2026-11-05 interrupted 一键续跑:面板任务卡对 interrupted(及 legacy「重启中断」cancelled)任务发;
// 服务端 resumeInterrupted 幂等重提(idempotencyKey=resume:<原id>,双击/重连不双跑)。
export const TaskResume = Envelope.extend({
  type: z.literal("task.resume"),
  taskId: z.string().min(1),
});
// 会议导入命令面(step-013 二期收口,designs/08 §3):纪要抽取→确认→批量任务。
export const MeetingImport = Envelope.extend({
  type: z.literal("meeting.import"),
  path: z.string().min(1),
});
export const MeetingSchedule = Envelope.extend({
  type: z.literal("meeting.schedule"),
  todos: z.array(z.object({ content: z.string().min(1), owner: z.string().optional(), deadline: z.string().optional() })).min(1),
  sessionId: z.string().optional(),
});
// 会话导出(step-004 二期收口):journal → dsh session-format v4 文件。
export const SessionExport = Envelope.extend({
  type: z.literal("session.export"),
  sessionId: z.string().min(1),
});
// 后台子代理进度/结果查询(step-054,ZCode TaskOutput 语义)
export const TaskOutputQuery = Envelope.extend({
  type: z.literal("task_output"),
  agentId: z.string().min(1),
});
// Plan 审批流(step-053,ZCode ExitPlanMode 审批语义):plan 模式任务终态→广播审批;
// 批准=按计划派实施(ZCode「User has approved your plan」模型内容);反馈=steered 消息。
export const PlanApprove = Envelope.extend({
  type: z.literal("plan.approve"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  decision: z.enum(["approve", "feedback"]),
  feedback: z.string().optional(),
});
// ZCode 内置命令(step-052):/goal /compact。
export const GoalSet = Envelope.extend({
  type: z.literal("goal.set"),
  sessionId: z.string().min(1),
  /** null=清除(clear);重设=覆盖(ZCode replace 语义)。 */
  goal: z.string().nullable(),
  state: z.enum(["active", "paused"]).default("active"),
});
export const GoalGet = Envelope.extend({ type: z.literal("goal.get"), sessionId: z.string().min(1) });
export const SessionCompact = Envelope.extend({
  type: z.literal("session.compact"),
  sessionId: z.string().min(1),
  /** 可选摘要指示(ZCode /compact [instructions] 透传)。 */
  instructions: z.string().optional(),
});
// F3 任务行操作(ZCode TaskListItemContextMenu 移植)
export const TaskRename = Envelope.extend({
  type: z.literal("task.rename"),
  taskId: z.string().min(1),
  /** 空串=恢复显示 instruction。 */
  title: z.string(),
});
export const TaskPin = Envelope.extend({
  type: z.literal("task.pin"),
  taskId: z.string().min(1),
  pinned: z.boolean(),
});
export const TaskDelete = Envelope.extend({ type: z.literal("task.delete"), taskId: z.string().min(1) });
/** 会话级批量删除(2026-10-19 用户实报「这些删不掉」):侧栏一行=一个会话(step-048 聚合),
 *  删单条撑不住整行(该会话还有 N 条任务)→ 一次删该会话全部任务。 */
export const TaskDeleteSession = Envelope.extend({ type: z.literal("task.deleteSession"), sessionId: z.string().min(1) });
export const ArchiveClear = Envelope.extend({ type: z.literal("archive.clear") });
export const TaskArchive = Envelope.extend({
  type: z.literal("task.archive"),
  taskId: z.string().min(1),
  archived: z.boolean(),
});
export const TaskList = Envelope.extend({ type: z.literal("task.list") });
/** 单任务详情按需拉取(索引化列表的配套):列表/变更帧只带 TaskIndex,正文由面板按 id 往返取。 */
export const TaskDetailGet = Envelope.extend({ type: z.literal("task.detail.get"), taskId: z.string().min(1) });
export const SessionHistory = Envelope.extend({
  type: z.literal("session.history"),
  sessionId: z.string().min(1),
  /** 增量追平路径(旧):返回 seq>=sinceSeq 的事件。未给 sinceSeq 且未给 beforeSeq = 现有全量回放。 */
  sinceSeq: z.number().int().nonnegative().optional(),
  /** 向后翻页(新):只返回 seq<beforeSeq 的事件。与 sinceSeq 互斥,判定优先级在服务端(beforeSeq 优先)。
   *  面板长会话首开只取尾页,再按 nextBeforeSeq 逐页回溯(参考 ZCode rowsRange 游标分页纪律)。 */
  beforeSeq: z.number().int().min(0).optional(),
  /** 单页条数上限(beforeSeq 路径生效;缺省 500,钳到 [1,2000])。 */
  limit: z.number().int().min(1).max(2000).optional(),
});
export const NodeRegister = Envelope.extend({
  type: z.literal("node.register"),
  nodeId: z.string().min(1),
  capabilities: z.array(z.string()),
  reachability: z.array(z.string()),
});
export const NodeHeartbeat = Envelope.extend({
  type: z.literal("node.heartbeat"),
  nodeId: z.string().min(1),
  load: z.object({ cpu: z.number(), mem: z.number(), runningTasks: z.number().int() }),
});
export const SenseQuery = Envelope.extend({
  type: z.literal("sense.query"),
  query: z.string().min(1),
  mode: z.enum(["auto", "debug", "plan", "explore", "ui"]).optional(),
  depth: z.number().int().positive().max(5).optional(),
  /** 项目级 code-sense(2026-10-12 用户口径:能力挂在项目级)——缺省回落 harness 根。 */
  projectId: z.string().min(1).optional(),
});
// repo wiki(step-118):持久 .genie/wiki/<repo>/ 页结构;projectId 缺省回退 harness 根。
export const WikiList = Envelope.extend({
  type: z.literal("wiki.list"),
  projectId: z.string().min(1).optional(),
});
export const WikiGet = Envelope.extend({
  type: z.literal("wiki.get"),
  page: z.string().min(1),
  projectId: z.string().min(1).optional(),
});
export const WikiRebuild = Envelope.extend({
  type: z.literal("wiki.rebuild"),
  projectId: z.string().min(1).optional(),
  /** 忽略 sha/指纹缓存,全页重建(LLM 页重新调用)。 */
  refresh: z.boolean().optional(),
  /** LLM 叙述页上限(成本护栏;缺省服务端 4)。 */
  maxLlmPages: z.number().int().min(0).max(20).optional(),
});
// 评审遗留(行级回写店消费,2026-10-13):sticky/resolved 跨轮视图。
export const StoredCommentZ = z.object({
  key: z.string(),
  path: z.string(),
  line: z.number().int(),
  rule: z.string().optional(),
  message: z.string(),
  severity: z.enum(["blocker", "warning", "nit"]),
  postedAt: z.number(),
  resolvedAt: z.number().optional(),
  repostCount: z.number().optional(),
});
export const ReviewStoreGet = Envelope.extend({
  type: z.literal("review.store.get"),
  projectId: z.string().min(1).optional(),
});
export const ReviewStoreResult = Envelope.extend({
  type: z.literal("review.store.result"),
  projectId: z.string().nullable(),
  root: z.string(),
  open: z.array(StoredCommentZ),
  resolved: z.array(StoredCommentZ),
});
/** 评审评论一键回注聊天窗(step-074):单条/多条/整批评论编成修复指令,作为新任务注入目标会话。
 * 通道语义对齐 board.continue(tm.submit 新任务);items 由面板从 review.findings 卡或回写店组装。 */
export const ReviewInjectItemZ = z.object({
  file: z.string().min(1).max(400),
  line: z.number().int().nonnegative(),
  severity: z.string().max(20).optional(),
  title: z.string().min(1).max(500),
  detail: z.string().max(2000).optional(),
  rule: z.string().max(100).optional(),
});
export const ReviewInject = Envelope.extend({
  type: z.literal("review.inject"),
  /** 注入目标会话(面板按用户选择给出:评论所属会话/当前会话/新会话)。 */
  sessionId: z.string().min(1),
  items: z.array(ReviewInjectItemZ).min(1).max(50),
  /** 用户附加说明(可选,拼进指令尾部)。 */
  note: z.string().max(2000).optional(),
  idempotencyKey: z.string().min(1),
  projectId: z.string().min(1).optional(),
  /** 来源面(chat-findings=会话内评论卡/review-store=回写店),journal 记账用。 */
  source: z.string().max(40).optional(),
});
/** 语音输入(2026-10-12 用户口径:qwen-audio-realtime 即语音模型,主 agent 语音通道)。
 * 浏览器采集 PCM16(base64)→服务端转 dashscope realtime→回复文本;凭证不出服务端。
 * @deprecated step-1033:voice.speak(音频直入大脑链路)已删除——server 不再受理,已从 ClientMessage
 * 联合移除;保留 export 只为旧引用编译不破。语音入口改走 voice.transcribe(ASR→文本→super.turn)。 */
export const VoiceSpeak = Envelope.extend({
  type: z.literal("voice.speak"),
  /** 16kHz PCM16 单声道,base64 编码。 */
  audioB64: z.string().min(1),
});
/** 语音输入(step-1033):浏览器 PCM16(base64)→服务端 ASR→文本;不产生人格设定与语音回播。 */
export const VoiceTranscribe = Envelope.extend({
  type: z.literal("voice.transcribe"),
  audioB64: z.string().min(1),
  format: z.enum(["pcm16"]).optional(),
  sampleRate: z.number().int().positive().optional(),
});
// F3 自定义分组(step-037 收口):任务拖入用户自定义桶(本地偏好,不进状态机)。
export const TaskGroup = Envelope.extend({ type: z.literal("task.group"), taskId: z.string().min(1), group: z.string().min(1).nullable() });
// F5 一键沉淀(step-037 收口):当前会话轨迹→经验库(incidents/自动提炼)。
export const ExpDistill = Envelope.extend({ type: z.literal("exp.distill"), sessionId: z.string().min(1), projectId: z.string().optional() });
// 多快照浏览(step-021/designs/21 收口):快照清单+任意恢复。
export const CheckpointList = Envelope.extend({ type: z.literal("checkpoint.list") });
export const CheckpointRestore = Envelope.extend({ type: z.literal("checkpoint.restore"), sha: z.string().min(7) });
// 团队视图(step-032 收口):多 org 快照/邀请;审批中心挂起清单(step-010 收口)。
export const TeamStatus = Envelope.extend({ type: z.literal("team.status") });
export const TeamInvite = Envelope.extend({ type: z.literal("team.invite"), orgUrl: z.string().min(1), displayName: z.string().optional(), projects: z.array(z.string()).optional() });
// fixD4(团队 issue 四件套):双通道 issue 面板消息 + P2P 通道面。
// issue.*:list/create/update(status/assignee)/comment/同步到 git;confirm.dispatch=面板确认后派任务。
export const IssueList = Envelope.extend({ type: z.literal("issue.list"), projectId: z.string().optional() });
export const IssueCreate = Envelope.extend({ type: z.literal("issue.create"), projectId: z.string().min(1), title: z.string().min(1), body: z.string().optional(), assignee: z.string().optional() });
export const IssueUpdate = Envelope.extend({ type: z.literal("issue.update"), projectId: z.string().min(1), number: z.number().int().min(1), status: z.enum(["todo", "doing", "done"]).optional(), assignee: z.string().optional() });
export const IssueComment = Envelope.extend({ type: z.literal("issue.comment"), projectId: z.string().min(1), number: z.number().int().min(1), body: z.string().min(1) });
export const IssueSync = Envelope.extend({ type: z.literal("issue.sync"), projectId: z.string().min(1) });
export const IssueConfirmDispatch = Envelope.extend({ type: z.literal("issue.confirm.dispatch"), projectId: z.string().min(1), number: z.number().int().min(1) });
// team.p2p.*:状态全景 + 消息发送(P2P 优先/relay 兜底/离线队列)。
export const TeamP2pStatus = Envelope.extend({ type: z.literal("team.p2p.status") });
export const TeamP2pSend = Envelope.extend({ type: z.literal("team.p2p.send"), to: z.string().min(1), text: z.string().min(1) });
// teamai 兼容面(designs/24):pull=手动触发团队仓重拉;push=经验/技能以 teamai skill 形态推团队仓。
export const TeamaiPull = Envelope.extend({ type: z.literal("teamai.pull") });
export const TeamaiPush = Envelope.extend({ type: z.literal("teamai.push"), orgUrl: z.string().optional(), ns: z.string().optional(), name: z.string().min(1), description: z.string().optional(), body: z.string().min(1), contributors: z.array(z.string()).optional(), /** 资源类(designs/30 §2.2);缺省=skill(旧客户端不带 kind 仍有效)。 */ kind: z.enum(["skill", "rule", "doc"]).optional() });
// designs/30 门面三件套(panel 侧):inspect=资产清单+本地/团队仓 diff+团队仓体检;contribute=会话经验入 learnings;
// remove=删团队仓 main 上的一份资源。三者都只是转发/读面,权威数据仍在团队仓。
export const TeamaiInspect = Envelope.extend({ type: z.literal("teamai.inspect") });
export const TeamaiContribute = Envelope.extend({ type: z.literal("teamai.contribute"), orgUrl: z.string().optional(), title: z.string().min(1), body: z.string().min(1), tags: z.array(z.string()).optional(), project: z.string().optional() });
export const TeamaiRemove = Envelope.extend({ type: z.literal("teamai.remove"), orgUrl: z.string().optional(), kind: z.enum(["skill", "rule", "doc"]), ns: z.string().optional(), name: z.string().min(1) });
export const PermissionPending = Envelope.extend({ type: z.literal("permission.pending") });
/** step-1042 关卡 Gate 历史面:拉最近决议(broker 内存 ring;重启即失,持久化登记后续)。 */
export const PermissionHistory = Envelope.extend({ type: z.literal("permission.history"), limit: z.number().int().positive().max(100).optional() });
// TTS 播报(step-014 二期收口,designs/07):文本→服务端 qwen-tts→音频 base64 回放;
// 凭证不出服务端;brief 级经播报改写器口语化限长。
export const VoiceTts = Envelope.extend({
  type: z.literal("voice.tts"),
  text: z.string().min(1),
  level: z.enum(["full", "brief"]).default("full"),
  /** 音色试听(2026-10-20):单次覆盖 config audio.tts.voice,不落配置;服务端回包 voice.tts.result.voice 回显。 */
  voice: z.string().min(1).max(80).optional(),
});
/** 音色清单(2026-10-20):按当前 audio.tts.model 返回内置官方音色表;未知模型=空表(前端走自定义 voice id 兜底)。 */
export const VoiceList = Envelope.extend({ type: z.literal("voice.list") });
export const ExpList = Envelope.extend({ type: z.literal("exp.list") });
export const ExpDisable = Envelope.extend({
  type: z.literal("exp.disable"),
  category: z.string().min(1),
  name: z.string().min(1),
  disabled: z.boolean(),
});

export const ExpView = Envelope.extend({
  type: z.literal("exp.view"),
  category: z.string().min(1),
  name: z.string().min(1),
});
/** 经验删除(2026-11-02 用户口径「经验库应当可以删除」):物理删技能目录,ledger 记 delete 可审计。 */
export const ExpRemove = Envelope.extend({
  type: z.literal("exp.remove"),
  category: z.string().min(1),
  name: z.string().min(1),
});
export const SysMeta = Envelope.extend({ type: z.literal("sys.meta") });
export const CfgGet = Envelope.extend({ type: z.literal("cfg.get") });
export const CfgSet = Envelope.extend({
  type: z.literal("cfg.set"),
  /** 点路径嵌套补丁,如 {llm:{model:"x"}}。 */
  patch: z.record(z.string(), z.unknown()),
});
/** step-125 预设一键接入:密钥名是否已存在(只查名字,不返回值)。 */
export const CfgSecretStatus = Envelope.extend({
  type: z.literal("cfg.secret.status"),
  rid: z.string().max(40).optional(),
  names: z.array(z.string().min(1)).max(20),
});
/** step-125 写入本机密钥文件(值只在 WS 帧内传输,服务端落 0600 文件)。 */
export const CfgSecretSet = Envelope.extend({
  type: z.literal("cfg.secret.set"),
  rid: z.string().max(40).optional(),
  name: z.string().min(1).max(64),
  value: z.string().min(1).max(4096),
});
export const ModelsList = Envelope.extend({
  type: z.literal("models.list"),
  /** 指定 providers[] 中的 id:按该 provider 的端点/凭证拉;缺省=主 llm。 */
  providerId: z.string().optional(),
  /** step-128:只读探测——回包仅报连通与可见模型数,面板不合并目录(拉取合并走缺省形态)。 */
  probeOnly: z.boolean().optional(),
});
export const ProfileFile = Envelope.extend({
  type: z.literal("profile.file"),
  projectId: z.string().optional(),
  /** 缺省=拉文件清单;给 file=拉该文件函数与调用边。 */
  file: z.string().optional(),
});
/** @deprecated step-1033 legacy:companion.turn 入站仍受理(老客户端),新前端只发 super.turn。 */
export const CompanionTurn = Envelope.extend({
  type: z.literal("companion.turn"),
  text: z.string().min(1),
});
/** super agent 指挥台(step-1033):唯一新写入站(命令框/侧聊带入)。 */
export const SuperTurn = Envelope.extend({
  type: z.literal("super.turn"),
  text: z.string().min(1),
});
/** 指挥台历史浮层(step-1033):sinceSeq 增量拉取。 */
export const SuperHistory = Envelope.extend({
  type: z.literal("super.history"),
  sinceSeq: z.number().int().nonnegative().optional(),
});
/** 指挥台待处理清单(step-1033):ask/permission/interrupted/blocked/failed 聚合。 */
export const SuperInbox = Envelope.extend({
  type: z.literal("super.inbox"),
  limit: z.number().int().positive().max(200).optional(),
});
/** @deprecated step-1033 legacy:companion.history 入站仍受理,回包统一 super.history.result。 */
export const CompanionHistory = Envelope.extend({
  type: z.literal("companion.history"),
  sinceSeq: z.number().int().nonnegative().optional(),
});
export const TraceStats = Envelope.extend({
  type: z.literal("trace.stats"),
  sessionId: z.string().min(1),
});
/** 轨迹查询过滤面(txa6/txa7/txa8):各键可省=不限;服务端还会二次归一(limit 非法按默认)。 */
export const TraceQueryFilterZ = z.object({
  /** 只要这些事件 kind(turn.start / tool.result / …)。 */
  kinds: z.array(z.string().min(1)).optional(),
  /** 只要这些工具名(只作用于 tool.call/tool.result)。 */
  tools: z.array(z.string().min(1)).optional(),
  /** 只要该轮次(payload.turn)。 */
  turn: z.number().int().nonnegative().optional(),
  /** 起点 seq(含)。 */
  sinceSeq: z.number().int().nonnegative().optional(),
  /** 只看错误事件。 */
  onlyErrors: z.boolean().optional(),
  /** 条数上限:正 int,≤2000(负/0 直接拒收)。 */
  limit: z.number().int().positive().max(2000).optional(),
});
export const TraceQuery = Envelope.extend({
  type: z.literal("trace.query"),
  sessionId: z.string().min(1),
  filter: TraceQueryFilterZ.optional(),
});
export const SessionStatus = Envelope.extend({
  type: z.literal("session.status"),
  sessionId: z.string().min(1),
  /** step-1036 增量化:已收到的末条事件 seq(= 上次回包 status.seq)。缺省=全量投影(老客户端/首拉,
   *  与改造前逐字一致);带值=服务端只归约 seq 更大的新事件并合并进累积态。
   *  注意服务端读事件时传 sinceSeq+1(journal.readSession 比较用 e.seq >= sinceSeq),否则水位那条重复归约。 */
  sinceSeq: z.number().int().nonnegative().optional(),
});
/** 模型请求重试的运行时临时态(batch1b,结构对齐 ZCode/packages/shared/src/zcode-api-retry-status.ts:
 * kind=api_retry、attempt 从 1 起、maxRetries ≥ attempt;不持久化,gateway 进程内按 sessionId 镜像)。
 * 消费方=面板重试条「重新连接中... {attempt}/{maxRetries}」+ 有 errorStatus 时追加「· HTTP xxx」;
 * attempt ≤ 2 由前端静默(前两次重试不打扰)。 */
export const ApiRetryStatusZ = z.object({
  kind: z.literal("api_retry"),
  /** 第几次重试(从 1 起;1=原始请求失败后准备第 1 次重试)。 */
  attempt: z.number().int().min(1),
  /** 本次请求允许的最大重试次数(≥ attempt)。 */
  maxRetries: z.number().int().min(0),
  /** 下一次尝试前的退避(ms)。 */
  retryDelayMs: z.number().int().min(0).default(0),
  /** 触发重试的 HTTP 状态(429/5xx);网络层错误(建连超时等)=null。 */
  errorStatus: z.number().int().nullable().default(null),
  /** 人读原因(HTTP 500 / rate_limited / connect_error…)。 */
  error: z.string().default("model retry scheduled"),
});
export type ApiRetryStatus = z.infer<typeof ApiRetryStatusZ>;
export const Ping = Envelope.extend({ type: z.literal("ping") });

// ---- 项目管理(step-035,ZCode workspace 项目移植) ----
export const ProjectAdd = Envelope.extend({
  type: z.literal("project.add"),
  /** 本地绝对路径(Web 面板无文件夹对话框,路径输入;校验在服务端)。 */
  path: z.string().min(1),
});
export const ProjectRemove = Envelope.extend({
  type: z.literal("project.remove"),
  projectId: z.string().min(1),
});
export const ProjectActivate = Envelope.extend({
  type: z.literal("project.activate"),
  projectId: z.string().min(1),
});
export const ProjectList = Envelope.extend({ type: z.literal("project.list") });
export const ProjectRename = Envelope.extend({
  type: z.literal("project.rename"),
  projectId: z.string().min(1),
  /** 显示名(≤80 字符;path/availability 不动)。 */
  label: z.string().min(1).max(80),
});

// ---- 服务端目录浏览(step-056,「选目录弹 Windows 对话框」根治 + 项目文件树) ----
export const FsList = Envelope.extend({
  type: z.literal("fs.list"),
  /** 绝对路径;"" = 返回锚点(home/root/cwd)。 */
  path: z.string(),
  showHidden: z.boolean().optional(),
});
export const SshKeyImport = Envelope.extend({
  type: z.literal("ssh.key.import"),
  /** 本机私钥文件路径(SSH config IdentityFile;读内容入 secrets,路径不入库)。 */
  path: z.string().min(1),
  host: z.string().min(1),
  user: z.string().min(1),
});
export const SshConfigList = Envelope.extend({
  type: z.literal("ssh.config.list"),
});
export const SshTest = Envelope.extend({
  type: z.literal("ssh.test"),
  /** 目标主机;凭证=已存 secrets(env 优先);不传密码字段(不在 WS 明文流密码)。 */
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().min(1),
  /** 连接向导:连通后顺手安装工作区服务并 ping 验证(设置台「测试连接」不传,保持轻量)。 */
  ensureServer: z.boolean().optional(),
});
// WSL 连接向导(2026-10-27,与 SSH 同构:先连接→连接中装工作区服务→经服务浏览目录→选目录添加项目)
export const WslList = Envelope.extend({
  type: z.literal("wsl.list"),
});
export const WslTest = Envelope.extend({
  type: z.literal("wsl.test"),
  /** WSL 发行版名(wsl.exe -l -q 输出;如 Ubuntu)。 */
  distro: z.string().min(1),
});
export const WslBrowse = Envelope.extend({
  type: z.literal("wsl.browse"),
  /** 发行版内绝对 POSIX 路径(经工作区服务列目录;供连接向导选项目目录)。 */
  distro: z.string().min(1),
  path: z.string().min(1),
});
export const SshBrowse = Envelope.extend({
  type: z.literal("ssh.browse"),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().min(1),
  /** 远端绝对 POSIX 路径(经工作区服务列目录)。 */
  path: z.string().min(1),
});
export const RemoteLs = Envelope.extend({
  type: z.literal("remote.ls"),
  /** 远程项目 id(项目表内 remote:ssh 条目;路径围栏=其 workspacePath)。 */
  projectId: z.string().min(1),
  /** 工作区内相对路径;""=根。 */
  path: z.string().optional(),
});
export const RemoteDeploy = Envelope.extend({
  type: z.literal("remote.deploy"),
  /** 部署远端工作区服务(shim)到项目的 SSH 主机。 */
  projectId: z.string().min(1),
});
export const RemoteRead = Envelope.extend({
  type: z.literal("remote.read"),
  projectId: z.string().min(1),
  /** 工作区内相对路径。 */
  path: z.string().min(1),
});
export const FsOpen = Envelope.extend({
  type: z.literal("fs.open"),
  path: z.string().min(1),
  /** true=在文件管理器中定位(目录);false=系统默认应用打开。 */
  reveal: z.boolean().optional(),
});

// ---- @ 文件提及(step-039,ZCode fileMentionProvider 移植) ----
// ---- F6 workflow ask 面板应答 ----
export const WorkflowAnswer = Envelope.extend({
  type: z.literal("workflow.answer"),
  /** 问题身份(engine cacheKey)。 */
  cacheKey: z.string().min(1),
  value: z.string().min(1),
});

export const FileRead = Envelope.extend({
  type: z.literal("file.read"),
  /** 项目内相对路径(citation 点击来源)。 */
  path: z.string().min(1),
  /** 目标行(视图滚动定位);缺省=1。 */
  line: z.number().int().positive().optional(),
  /** step-141 IDE:回全文(startLine=1+全文 content);缺省行为不变(±20 行窗口)。 */
  full: z.literal(true).optional(),
  /** 2026-10-22:解析根的项目 id——IDE 树按桶打开时必带(否则 server 回退 activeId,
   *  活动项目≠树项目时读错根→missing→编辑区空白,实测复现)。缺省=旧语义(活动项目)。 */
  projectId: z.string().optional(),
});
// step-141 IDE 保存链:全文覆盖写(首版不带锁、不做多写者冲突检测;写权限=激活项目根内全可写)。
export const FileWrite = Envelope.extend({
  type: z.literal("file.write"),
  /** 项目内相对路径;越界/.git/超限在 server 侧沙箱拒绝。 */
  path: z.string().min(1),
  /** UTF-8 全文覆盖内容(>512KB 拒;允许新建文件,父目录须已存在)。 */
  content: z.string(),
  /** 2026-10-22:解析根的项目 id(IDE 树桶项目);缺省=旧语义(活动项目)。 */
  projectId: z.string().optional(),
});
/**
 * 2026-10-29 板「OOXML 文本回写」P2:Office 文档文本级编辑(服务端处理路径)。
 * 为什么不让前端自己拼 zip:浏览器得先拿 10MB 原始字节(/ide/asset 走 Range 分块)、
 * 再在页面里引 zip + XML 重打包,内存与坑都翻倍。改由服务端读原文件 → rewriteOfficeText → 写回,
 * 前端只发「哪一段要换成什么文本」。沙箱同 /ide/office(ideOfficeResolve)。
 */
export const IdeOfficeEdit = Envelope.extend({
  type: z.literal("ide.office.edit"),
  /** 文档在项目内的相对路径(必须 .pptx/.docx)。 */
  path: z.string().min(1),
  /** 解析根的项目 id(IDE 树桶项目);缺省=活动项目。 */
  pid: z.string().optional(),
  /** 文本编辑指令(下标语义与 parseOffice 输出一致;整段替换,不保留 run 级差异)。 */
  edits: z.array(z.object({
    /** pptx:第几页(1-based)。 */
    slideIndex: z.number().int().positive().optional(),
    /** pptx:该页 shapes 数组下标(与 parseOffice 输出一致)。 */
    shapeIndex: z.number().int().nonnegative().optional(),
    /** docx:blocks 数组下标。 */
    blockIndex: z.number().int().nonnegative().optional(),
    /** 新文本(整段替换)。 */
    text: z.string(),
  })).min(1).max(5000),
});

// ---- step-142 IDE 文件操作(P0 编辑体验):mkdir / remove / rename / grep ----
// 沙箱口径与 file.write 完全一致(realpath 前缀比对 + 拒 .git 段 + 拒绝对路径/越界);失败统一走
// fs.*.result { ok:false, error }(二选一即可,此处选回包式:前端能按 op 精确定位失败的那一条)。
export const FsMkdir = Envelope.extend({
  type: z.literal("fs.mkdir"),
  /** 项目内相对路径(单层:父目录须已存在,与 file.write 一致,不隐式建多层)。 */
  path: z.string().min(1),
  projectId: z.string().optional(),
});
export const FsRemove = Envelope.extend({
  type: z.literal("fs.remove"),
  /** 项目内相对路径(文件或目录)。 */
  path: z.string().min(1),
  /** 目录:必须显式 true 才递归删除(非空目录不带此标志=拒绝)。 */
  recursive: z.boolean().optional(),
  projectId: z.string().optional(),
});
export const FsRename = Envelope.extend({
  type: z.literal("fs.rename"),
  /** 源(项目内相对路径,必须存在)。 */
  from: z.string().min(1),
  /** 目标(项目内相对路径,父目录须已存在;已存在=覆盖)。 */
  to: z.string().min(1),
  projectId: z.string().optional(),
});
/** 全项目文件内容搜索(IDE Ctrl+Shift+F):跳过 .git/node_modules/dist/.genie、单文件 >1MB、二进制。 */
export const FsGrep = Envelope.extend({
  type: z.literal("fs.grep"),
  /** 起始子路径(项目内相对;缺省=项目根)。 */
  path: z.string().optional(),
  query: z.string().min(1),
  /** true=按正则匹配(query 非法则回 error 字段)。 */
  regex: z.boolean().optional(),
  /** 结果上限(缺省 200,硬顶 2000)。 */
  maxResults: z.number().int().positive().optional(),
  projectId: z.string().optional(),
});

// ---- 面板 IDE 第二批:问题面板诊断(lsp.diagnostics)与持久终端(term.session.*) ----
// 路由:panel → gateway;实现不新起检查器,harness-lsp checkEditedFile(TS 兜底)与
// harness-terminal TerminalSessionService 与 agent 侧同源(同进程单例,owner="panel:<连接标识>")。
/** 诊断请求:paths=项目内相对路径数组(.ts/.tsx/.js/.jsx/.mts/.cts 之外的扩展名静默跳过)。 */
export const LspDiagnostics = Envelope.extend({
  type: z.literal("lsp.diagnostics"),
  /** 请求 id(原样回传,面板按 requestId 对齐请求/响应)。 */
  requestId: z.string().min(1),
  projectId: z.string().optional(),
  paths: z.array(z.string().min(1)).min(1),
});
/** 持久终端:面板开一个交互式会话(shell 进程跨消息常驻,cwd/env 状态保持)。 */
export const TermSessionOpen = Envelope.extend({
  type: z.literal("term.session.open"),
  requestId: z.string().min(1),
  /** 工作目录(项目内相对路径;缺省=项目根;越界拒绝)。 */
  cwd: z.string().optional(),
  /** 终端尺寸(cols/rows);当前实现(PTY 面板推流)不支持动态 resize,忽略。 */
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  projectId: z.string().optional(),
});
export const TermSessionSend = Envelope.extend({
  type: z.literal("term.session.send"),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  /** 写入 shell 的原始输入(通常带换行)。 */
  data: z.string(),
});
export const TermSessionRead = Envelope.extend({
  type: z.literal("term.session.read"),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  /** 起始游标(缺省=上次已消费位置;单调递增)。 */
  cursor: z.number().int().nonnegative().optional(),
});
export const TermSessionClose = Envelope.extend({
  type: z.literal("term.session.close"),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
});
/** 单文件历史内容(git show ref:path;文件不在 ref / 超 2MB → error 帧)。 */
export const GitShow = Envelope.extend({
  type: z.literal("git.show"),
  requestId: z.string().min(1),
  projectId: z.string().optional(),
  /** 项目内相对路径。 */
  path: z.string().min(1),
  /** 提交/分支/tag;缺省 HEAD。 */
  ref: z.string().min(1).optional(),
});

export const FilesSearch = Envelope.extend({
  type: z.literal("files.search"),
  /** 查询串(路径/文件名子串;空=热门根文件)。 */
  query: z.string().default(""),
});

/** 会话全文检索(step-115):面板命令中心 `#` 域;空 query=最近会话浏览。 */
export const SessionSearch = Envelope.extend({
  type: z.literal("session.search"),
  query: z.string().default(""),
  limit: z.number().int().positive().max(50).optional(),
});

// ---- Git 面板(step-037 批C,ZCode GitPane/GitActionMenu 移植) ----
export const GitStatus = Envelope.extend({ type: z.literal("git.status") });
export const GitDiff = Envelope.extend({ type: z.literal("git.diff"), file: z.string().min(1) });
export const GitBranches = Envelope.extend({ type: z.literal("git.branches") });
export const GitLog = Envelope.extend({ type: z.literal("git.log"), limit: z.number().int().positive().max(200).optional() });

// ---- 定时自动化(step-043,ZCode Automations 移植) ----
export const GitCommitMsg = Envelope.extend({ type: z.literal("git.commitmsg") });

// ---- checkpoint 回滚(step-044,designs/21) ----
export const CheckpointPreview = Envelope.extend({ type: z.literal("checkpoint.preview"), taskId: z.string().min(1) });
export const CheckpointRewind = Envelope.extend({ type: z.literal("checkpoint.rewind"), taskId: z.string().min(1) });

// ---- 内联变更条/使用统计(step-046,ZCode 变更条+UsageStatistics 对齐) ----
export const TaskDiffstat = Envelope.extend({ type: z.literal("task.diffstat"), taskId: z.string().min(1) });
export const StatsSummary = Envelope.extend({ type: z.literal("stats.summary") });
// step-052:单文件补丁(变更条文件清单→右侧 diff 面板)与模型逐一探活(设置页模型列表)。
export const TaskFileDiff = Envelope.extend({ type: z.literal("task.filediff"), taskId: z.string().min(1), file: z.string().min(1) });
export const ModelsProbe = Envelope.extend({ type: z.literal("models.probe"), model: z.string().min(1), providerId: z.string().optional() });

// ---- step-047:管理面(子智能体/技能/命令/钩子/MCP/记忆)+ 终端 ----
export const AgentsList = Envelope.extend({ type: z.literal("agents.list") });
export const SkillsList = Envelope.extend({ type: z.literal("skills.list") });
export const SkillsDisableBuiltin = Envelope.extend({ type: z.literal("skills.disableBuiltin"), name: z.string().min(1), disabled: z.boolean() });
export const CommandsList = Envelope.extend({ type: z.literal("commands.list") });
export const CommandsUpsert = Envelope.extend({ type: z.literal("commands.upsert"), name: z.string().min(1), body: z.string().min(1) });
export const CommandsRemove = Envelope.extend({ type: z.literal("commands.remove"), name: z.string().min(1) });
/** 内置 + 自定义合并后的纯 catalog(2026-10;ZCode「内置命令目录=唯一权威」)。 */
export const CommandsCatalog = Envelope.extend({ type: z.literal("commands.catalog") });
export const HooksList = Envelope.extend({ type: z.literal("hooks.list") });
export const HooksUpsert = Envelope.extend({ type: z.literal("hooks.upsert"), name: z.string().min(1), event: z.string().min(1), command: z.string().min(1) });
export const HooksUpdate = Envelope.extend({ type: z.literal("hooks.update"), id: z.string().min(1), enabled: z.boolean() });
export const HooksRemove = Envelope.extend({ type: z.literal("hooks.remove"), id: z.string().min(1) });
export const McpList = Envelope.extend({ type: z.literal("mcp.list"), refresh: z.boolean().optional() });
export const McpUpsert = Envelope.extend({ type: z.literal("mcp.upsert"), name: z.string().min(1), command: z.string().min(1), args: z.array(z.string()).optional() });
export const McpUpdate = Envelope.extend({ type: z.literal("mcp.update"), id: z.string().min(1), enabled: z.boolean() });
export const McpRemove = Envelope.extend({ type: z.literal("mcp.remove"), id: z.string().min(1) });
export const McpTest = Envelope.extend({ type: z.literal("mcp.test"), id: z.string().min(1) });
export const MemoryView = Envelope.extend({ type: z.literal("memory.view") });
export const TermExec = Envelope.extend({ type: z.literal("term.exec"), command: z.string().min(1) });
export const TermCancel = Envelope.extend({ type: z.literal("term.cancel") });

// ---- step-048:插件市场 / 节点 / 附件 ----
export const PluginsList = Envelope.extend({ type: z.literal("plugins.list") });
export const PluginsInstall = Envelope.extend({ type: z.literal("plugins.install"), id: z.string().min(1) });
export const PluginsUninstall = Envelope.extend({ type: z.literal("plugins.uninstall"), id: z.string().min(1) });
export const PluginsToggle = Envelope.extend({ type: z.literal("plugins.toggle"), id: z.string().min(1), enabled: z.boolean() });
export const NodesList = Envelope.extend({ type: z.literal("nodes.list") });
// ---- 看板三件套(2026-10-20:子代理目录/任务追踪/用量,各自独立看板) ----
export const SubagentsList = Envelope.extend({ type: z.literal("subagents.list"), sessionId: z.string().optional() });
/** 会话 worker 清单(F5-3 可观测):活跃 worker 进程的 pid/会话/时刻。 */
export const WorkersList = Envelope.extend({ type: z.literal("workers.list") });
export const TrackView = Envelope.extend({ type: z.literal("track.view"), sessionId: z.string().optional() });
export const UsageView = Envelope.extend({ type: z.literal("usage.view") });
// ---- step-049:项目档案(架构图管线) ----
export const ProfileGet = Envelope.extend({ type: z.literal("profile.get"), projectId: z.string().min(1) });
export const ProfileRebuild = Envelope.extend({ type: z.literal("profile.rebuild"), projectId: z.string().min(1) });
const PlanItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["add-module", "remove-module", "add-dep"]),
  createdAt: z.number(),
  name: z.string().optional(),
  note: z.string().optional(),
  reason: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export const ProfilePlanUpsert = Envelope.extend({ type: z.literal("profile.plan.upsert"), projectId: z.string().min(1), item: PlanItemSchema });
export const ProfilePlanRemove = Envelope.extend({ type: z.literal("profile.plan.remove"), projectId: z.string().min(1), id: z.string().min(1) });
export const ProfilePlanApply = Envelope.extend({ type: z.literal("profile.plan.apply"), projectId: z.string().min(1) });
/** 「总路线」并入代码档案(step-131):读/生成项目宗旨画像(.genie/sense-index/profile.json)。
 * generate=true 显式跑确定性骨架 + LLM purpose 层并落盘(LLM 缺席=仅骨架,llmState=off 如实标注)。
 * projectId 缺省=harness 根(与 sense.query/wiki.* 同语义)。 */
export const ProfileSenseGet = Envelope.extend({
  type: z.literal("profile.sense.get"),
  projectId: z.string().min(1).optional(),
  generate: z.boolean().optional(),
  refresh: z.boolean().optional(),
});
/** 电脑控制:向指定节点派一条命令(task.submit 的 targetNode 形态,面板快捷入口)。 */
export const NodeExec = Envelope.extend({ type: z.literal("node.exec"), nodeId: z.string().min(1), command: z.string().min(1) });
/** 远程连接向导命令生成(纯函数,服务端按 gateway 实际地址渲染)。 */
export const WizardGen = Envelope.extend({
  type: z.literal("wizard.gen"),
  kind: z.enum(["ssh", "docker"]),
  host: z.string().default(""),
  user: z.string().default("root"),
  port: z.number().int().min(1).max(65535).default(22),
  nodeId: z.string().default(""),
});

export const AutomationList = Envelope.extend({ type: z.literal("automation.list") });
export const AutomationCreate = Envelope.extend({
  type: z.literal("automation.create"),
  name: z.string().min(1),
  instruction: z.string().min(1),
  everyMinutes: z.number().int().min(1).max(525600),
  /** 作用域(step-046):"global" 缺省;否则=项目 id。 */
  scope: z.string().optional(),
});
export const AutomationUpdate = Envelope.extend({
  type: z.literal("automation.update"),
  id: z.string().min(1),
  name: z.string().optional(),
  instruction: z.string().optional(),
  everyMinutes: z.number().int().min(1).max(525600).optional(),
  enabled: z.boolean().optional(),
});
export const AutomationDelete = Envelope.extend({ type: z.literal("automation.delete"), id: z.string().min(1) });
export const AutomationRun = Envelope.extend({ type: z.literal("automation.run"), id: z.string().min(1) });
export const GitCheckout = Envelope.extend({ type: z.literal("git.checkout"), branch: z.string().min(1) });
export const GitCommit = Envelope.extend({
  type: z.literal("git.commit"),
  message: z.string().min(1),
  /** 提交文件列表;缺省=全部变更(add -A)。 */
  files: z.array(z.string()).optional(),
});
// ---- push/pull(二期:面板 GitPane 同步操作;作用于激活项目工作目录,与 git.commit 同语义) ----
export const GitPush = Envelope.extend({
  type: z.literal("git.push"),
  /** 远端名;缺省 origin。 */
  remote: z.string().min(1).optional(),
  /** 分支;缺省=当前分支(-u 设 upstream)。 */
  branch: z.string().min(1).optional(),
});
export const GitPull = Envelope.extend({
  type: z.literal("git.pull"),
  /** 远端名;缺省=当前分支 upstream(git pull 原语义)。 */
  remote: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
});

// ---- 权限审批(step-037 B2,ZCode PermissionDialog 移植) ----
export const PermissionRespond = Envelope.extend({
  type: z.literal("permission.respond"),
  requestId: z.string().min(1),
  decision: z.enum(["allow-once", "reject", "allow-always"]),
  /** allow-always 附带要写入的规则(permission+pattern;缺省 pattern=*)。 */
  rule: z.object({ permission: z.string(), pattern: z.string() }).optional(),
});

/** node-agent 执行结果回流(step-033 tunnel 委派)。 */
export const NodeTaskResult = Envelope.extend({
  type: z.literal("node.task.result"),
  nodeId: z.string().min(1),
  taskId: z.string().min(1),
  ok: z.boolean(),
  output: z.string().optional(),
  error: z.string().optional(),
});

// ---- 语义流程白板(designs/22,step-057):agent 先画后改的设计白板;节点连接 code-index ----
/** 语义流程编码:函数框内的步骤(step 顺序/branch 分支/loop 循环),递归。 */
export type BoardFlowStep = {
  type: "step" | "branch" | "loop";
  text?: string;
  cond?: string;
  over?: string;
  then?: BoardFlowStep[];
  else?: BoardFlowStep[];
  body?: BoardFlowStep[];
};
export const BoardFlowStepZ: z.ZodType<BoardFlowStep> = z.lazy(() =>
  z.object({
    type: z.enum(["step", "branch", "loop"]),
    text: z.string().max(300).optional(),
    cond: z.string().max(200).optional(),
    over: z.string().max(120).optional(),
    then: z.array(BoardFlowStepZ).max(20).optional(),
    else: z.array(BoardFlowStepZ).max(20).optional(),
    body: z.array(BoardFlowStepZ).max(20).optional(),
  }),
);
/** 节点→code-index 符号连接:名字+签名行文本锚(行号会漂移,锚可重定位)。 */
export const BoardSymbolRefZ = z.object({
  repo: z.string().max(80).optional(),
  name: z.string().min(1).max(200),
  file: z.string().max(400).optional(),
  line: z.number().int().positive().optional(),
  anchor: z.string().max(300).optional(),
});
/** step-121 工作流板节点参数(wf-* 节点的类型化配置;全可选=旧节点零破坏,编译期按 kind 校验必填):
 * wf-script/wf-test 用 command+timeoutMs;wf-agent 用 actor+instructions;
 * wf-condition 用 cond(JS 表达式,变量域 R["<nodeId>"]);wf-notify 用 message。 */
export const BoardNodeWfZ = z.object({
  command: z.string().max(2000).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  actor: z.string().max(60).optional(),
  instructions: z.string().max(4000).optional(),
  cond: z.string().max(500).optional(),
  message: z.string().max(1000).optional(),
});
/** step-137 代码级落目标:节点上的可执行验收契约(accept=怎么写才算过;evidence=跑过的证据)。
 * 背景实锤:桌面 exe 任务板上「首启引导」节点有 DoD 文案但既没实现也没人核对,交付 llm=off/echo 被吐槽
 * 「根本不干活」——根因=节点无验收绑定、完工无证据门。
 * 全字段可选:旧板(step-057 起的所有板)无这些字段照常解析,旧客户端零影响。 */
export const BoardAcceptZ = z.object({
  /** 可执行验收:命令或明确的验证动作(如 `pnpm vitest run test/x.test.ts`、`启动 exe 截图确认无 API Key 引导`)。 */
  cmd: z.string().min(1).max(500),
  /** 期望输出/行为片段(命不中=不通过)。 */
  expect: z.string().max(300).optional(),
  /** 验收类型(2026-10-25 变更契约图四类):command=命令/browser=浏览器/manual=人工检查/negative=负面断言。
   * 可选以兼容旧板;agent 新落板时应显式标类型(板校验会软提示缺 type)。 */
  type: z.enum(["command", "browser", "manual", "negative"]).optional(),
  /** 为什么验收这一条(可选说明)。 */
  note: z.string().max(300).optional(),
});
export type BoardAccept = z.infer<typeof BoardAcceptZ>;
/** 证据落账时捕获的目标文件指纹(M107,2026-11-06):文件在证据之后被改动/消失 → 该证据视为过期,
 * 不再算覆盖、节点不算 passed。旧 evidence 无 files 字段 = 不做任何 stale 判定(向后兼容,逐字不变)。 */
export const BoardEvidenceFileZ = z.object({
  /** 捕获时解析出的绝对路径(读时直接 stat,不依赖调用方再传根)。 */
  path: z.string().min(1).max(400),
  mtimeMs: z.number(),
  size: z.number(),
  /** 代码文本且 ≤512KB 才有;内容变而 mtime/size 恰好未变时靠它识别。 */
  sha256: z.string().max(64).optional(),
});
export type BoardEvidenceFile = z.infer<typeof BoardEvidenceFileZ>;
/** 证据记录:agent 回填「这条 accept 跑过了,结果如何」;at 由服务端补(客户端传值被覆盖)。 */
export const BoardEvidenceZ = z.object({
  /** 对应 BoardAccept.cmd 原文(按 cmd 匹配验收项;不做模糊匹配)。 */
  cmd: z.string().min(1).max(500),
  ok: z.boolean(),
  at: z.number().default(0),
  note: z.string().max(300).optional(),
  /** 实测输出摘录(截断,防巨型日志撑爆板)。 */
  output: z.string().max(2000).optional(),
  /** 落账时目标文件指纹(≤12;由 board-store 写盘路径捕获,客户端传值不生效)。 */
  files: z.array(BoardEvidenceFileZ).max(12).optional(),
  /** 指纹捕获时刻(毫秒)。 */
  capturedAt: z.number().optional(),
});
export type BoardEvidence = z.infer<typeof BoardEvidenceZ>;
export const BoardNodeZ = z.object({
  id: z.string().min(1).max(60),
  /** 六期工作流语义:module/function=代码件;llm=模型调用;tool=工具/外部系统;io=输入/输出;decision=判断分支;note=备注。 */
  /** 七期工作流全类型集:io≈Start/Answer,decision≈IfElse,aggregate≈VariableAggregator,
   * retrieval≈KnowledgeRetrieval,classifier≈QuestionClassifier;module/function/note=代码世界原生件。 */
  /** step-083 页面结构板族:page=页面(线框)/section=区块/component=组件/nav=导航条。 */
  /** step-121 工作流板可执行节点族(docKind=workflow 专用,映射 harness-workflow 引擎能力):
   * wf-script=world.run 白名单命令/wf-test=world.run+断言 report/wf-agent=agent().ask 子代理/
   * wf-condition=条件分支(出边 label 真/假)/wf-parallel=并发 fan-out(Promise.all)/
   * wf-notify=report 成果登记。参数配置走 wf 字段(见 BoardNodeWfZ)。 */
  kind: z.enum([
    "module", "function", "decision", "note", "llm", "tool", "io",
    "start", "end", "http", "template", "aggregate", "loop", "retrieval", "classifier", "agent",
    "page", "section", "component", "nav",
    "wf-script", "wf-test", "wf-agent", "wf-condition", "wf-parallel", "wf-notify",
  ]).default("function"),
  label: z.string().min(1).max(160),
  /** 这个模块干什么用(用户核心诉求,强制非空)。 */
  summary: z.string().min(1).max(500),
  /** fixH3 领域阶段名(白板泳道分组,如「01 采集」「02 处理」「03 输出」):按业务阶段编号,
   * 不是技术分层;面板流动布局按它画虚线泳道框。缺省=按阶段前缀/kind 族回退分组。 */
  group: z.string().max(80).optional(),
  /** 改动前的形态(「原来是什么」;modify/delete 节点应填,add/keep 可空)。 */
  before: z.string().max(500).optional(),
  /** 原来是什么→改成什么:add 新增/modify 修改/delete 删除/keep 仅涉及不改。 */
  change: z.enum(["add", "modify", "delete", "keep"]).default("modify"),
  /** 模块完成标记(step-057 五期实时面板):agent 每落实一个模块即置 true,面板实时出进度。 */
  done: z.boolean().default(false),
  /** 用户评论(查看态追加,服务端 board.comment 合并;「按板续作」会带进指令)。 */
  comments: z.array(z.string().max(500)).max(20).default([]),
  symbolRef: BoardSymbolRefZ.optional(),
  /** step-073:纯文件链(模块/页面/架构节点的入口文件)——只驱动画布「文件链」与档案跳转,
   * 不参与 symbolRef 三态判定(这些节点没有符号语义)。 */
  fileRef: z.string().max(400).optional(),
  flow: z.array(BoardFlowStepZ).max(40).default([]),
  /** step-121:工作流板节点参数(wf-* 节点;design/page 板节点无此字段)。 */
  wf: BoardNodeWfZ.optional(),
  /** step-137 代码级落目标:优先级档。P0=必做(必须带 accept 才允许落板;完工须有证据);
   * P1/P2=余力项(不强制 accept)。缺省=undefined(旧板/未标档节点,不参与 P0 校验与覆盖率)。 */
  phase: z.enum(["P0", "P1", "P2"]).optional(),
  /** 这个节点要改的文件/符号清单(验收目标面;evidence/覆盖率核对据此说「改到哪了」)。 */
  targets: z.array(z.string().max(400)).max(30).optional(),
  /** 可执行验收契约(P0 节点非空强制):每条 cmd 怎么跑、期望什么。 */
  accept: z.array(BoardAcceptZ).max(12).optional(),
  /** 验收证据:agent 回填每条 accept 的执行结果(at 由服务端补)。 */
  evidence: z.array(BoardEvidenceZ).max(24).optional(),
  pos: z.object({ x: z.number(), y: z.number() }).optional(),
});
export const BoardDocZ = z.object({
  /** 板文档版本:1=旧板;2=2026-10-25 迁移脚本升级版(字段仍按可选读取,零新必填)。
   * 用 union 而非硬切 2:滚动窗口内新旧网关都能读;写入方(upsert)仍写 1,迁移脚本显式写 2。 */
  version: z.union([z.literal(1), z.literal(2)]),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string().min(1).max(200),
  status: z.enum(["draft", "implementing", "done"]).default("draft"),
  /** 板类型(step-083 页面结构板):design=模块/流程设计板(缺省,向后兼容旧板);
   * page=页面结构板——节点=页面/区块/组件(线框形态),边=导航/包含,规划类任务产物;
   * workflow=工作流板(step-121)——节点=wf-* 可执行步骤(参数走 wf 字段),边=执行顺序/
   * 分支(label 真/假),「编译执行」把画布编译成 harness-workflow 脚本运行。 */
  docKind: z.enum(["design", "page", "workflow"]).optional(),
  /** 任务板型(2026-10-25 变更契约图):板校验按板型切换规则——code/test/docs/ui/ui-func/
   * fault(故障链,不要求代码变更 before)/refactor(要求现状/目标泳道)/perf/data/
   * contract/deploy/research/orchestration。缺省=undefined(旧板按通用 design 规则软校验)。
   * composition(2026-10-29)=办公/产出类任务(写 PPT/汇报/文章/调研报告)的「作业思路板」:
   * 章节节点复用 kind:"section",章间关系用 data 边(->>)的 label 关系词(承接/递进/并列/对照/因果)
   * 表达,不引入新的 edge kind。 */
  boardType: z.enum([
    "code", "test", "docs", "ui", "ui-func", "fault", "refactor", "perf",
    "data", "contract", "deploy", "research", "orchestration",
    // 2026-10-25 更多板型:matrix=候选×维度决策矩阵(复用 research 矩阵规则与表格视图)。
    "matrix",
    // 2026-10-29 composition=作业思路板(主题/受众/结构/章节/章间关系;不画执行步骤)。
    "composition",
  ]).optional(),
  /** 规模分级(2026-10-25):S=1~3 节点一次到位/M=骨架≤9/L=多模块/迁移两版+风险回滚。
   * 可选以兼容旧板;planner 新落板应显式标注,板校验据此提示规模超标。 */
  scale: z.enum(["S", "M", "L"]).optional(),
  /** 文档体裁(2026-10-27,docs 板):board-skills DOC_GENRES 的 key(review-solution/
   * review-code/research/summary/guide/generic)。可选;类型门按体裁必答维度查覆盖。 */
  docGenre: z.string().min(2).max(40).optional(),
  /** 乐观锁:每次写入 +1,人/agent 并发改板防互相覆盖。 */
  rev: z.number().int().nonnegative().default(0),
  /** 符号解析根(任务项目 workdir;link 解析与索引查询用)。 */
  root: z.string().max(500).optional(),
  nodes: z.array(BoardNodeZ).min(1).max(60),
  edges: z.array(z.object({
    from: z.string(), to: z.string(),
    /** step-083 页面结构板:nav=页面间导航(箭头+触发器标签)/contains=包含(区块属于页面,无线头)。 */
    kind: z.enum(["call", "data", "verify", "nav", "contains"]).default("call"),
    label: z.string().max(120).optional(),
    /** step-073:用户虚拟边(画布拖拽/编辑态人工加的连线)——与 agent code_index 实证边显式区分,
     * 虚线渲染+导出标注+续作指令注明「待核实」。缺省 false=实证边。 */
    virtual: z.boolean().optional(),
  })).max(120).default([]),
  planned_files: z.array(z.string().max(400)).max(60).default([]),
  /** 任务完成时从 checkpoint diffstat 回填(计划 vs 实际对账)。 */
  actual_files: z.array(z.string().max(400)).max(60).optional(),
  /** 人改板变更集(2026-10):人经 board.save 改板时服务端比对前一版,
   * 记下「人这次动了哪些节点」;「按板续作」据此只派变更集(不再整板塞给 agent)。
   * ids 去重且保持入参顺序;rev=记录这次变更集时的板 rev(派发后清空为 ids:[], rev 更新为最新)。
   * 全字段可选/带 default:旧板(无此字段)照常解析,旧客户端零影响。 */
  humanEdits: z.object({
    ids: z.array(z.string().max(60)).max(60).default([]),
    rev: z.number().int().nonnegative().default(0),
    /** 每个变更节点的字段级改动摘要(如 {n1:["label","summary"]}),「按板续作」拼「改动:」行用;
     * 缺省=change 明细未记录(只按 ids 派发)。 */
    changes: z.record(z.array(z.string().max(40)).max(12)).optional(),
  }).optional(),
  updatedAt: z.number().default(0),
});
export type BoardDoc = z.infer<typeof BoardDocZ>;
/** 符号连接三态:linked=已连接/moved=行漂移(已按锚重定位)/broken=断链。 */
export const BoardLinkStateZ = z.object({
  nodeId: z.string(),
  state: z.enum(["linked", "moved", "broken"]),
  file: z.string().optional(),
  line: z.number().int().optional(),
  note: z.string().optional(),
});
export type BoardLinkState = z.infer<typeof BoardLinkStateZ>;
export const BoardGet = Envelope.extend({
  type: z.literal("board.get"),
  /** 会话必填(server 无 sid 即拒);taskId 缺省=会话最新板。 */
  sessionId: z.string().min(1),
  taskId: z.string().min(1).optional(),
});
export const BoardList = Envelope.extend({ type: z.literal("board.list"), sessionId: z.string().min(1) });
/** 白板出图请求:把一块板渲染成 SVG(taskId 缺省=会话最新板)。 */
export const BoardDiagramRequest = Envelope.extend({
  type: z.literal("board.diagram"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  theme: z.enum(["light", "dark"]).optional(),
  /** 出图前视图态过滤(大板看不清时的服务端裁剪;不改板数据):
   * writers=只留这些写者前缀的节点(空/缺省=不过滤),foldGroups=按 group 折叠大分组,
   * foldMin=折叠阈值(组内节点数 >= 该值才折叠,缺省 5)。见 apps/gateway/src/board-filter.ts。 */
  filter: z.object({
    writers: z.array(z.string()).max(40).optional(),
    foldGroups: z.boolean().optional(),
    foldMin: z.number().int().min(2).max(60).optional(),
  }).optional(),
});
export type BoardDiagramRequest = z.infer<typeof BoardDiagramRequest>;
/** 白板出图回包:svg 为 `<svg ...>` 全文,diagnostics 为 flowkit 编译/导出诊断。 */
export const BoardDiagramResult = Envelope.extend({
  type: z.literal("board.diagram.result"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  ok: z.boolean(),
  svg: z.string().default(""),
  diagnostics: z.array(z.object({
    line: z.number().default(0),
    code: z.string(),
    severity: z.string(),
    message: z.string(),
  })).default([]),
  elapsedMs: z.number().default(0),
  /** ok=false 时的失败码(board-not-found / 渲染失败原文)。 */
  error: z.string().optional(),
});
export type BoardDiagramResult = z.infer<typeof BoardDiagramResult>;
// P3 人参与编辑(step-057 二期):人改板=改设计不改码;rev 乐观锁,冲突回 board.conflict。
export const BoardSave = Envelope.extend({
  type: z.literal("board.save"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  doc: BoardDocZ,
  baseRev: z.number().int().nonnegative(),
});
/** 按板续作:把当前白板编成后续指令发回原会话(新任务)。 */
export const BoardContinue = Envelope.extend({
  type: z.literal("board.continue"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  note: z.string().max(2000).optional(),
  /** 人从界面选区派发时带的节点 id 集:优先于 doc.humanEdits.ids(选区派发只派这几个节点);
   * 缺省=按 doc.humanEdits.ids;两者都无=回退整板(旧板/无人工改动)。 */
  nodeIds: z.array(z.string().max(60)).max(60).optional(),
});
/** 手绘批注层(每任务一张 PNG,dataURL base64;上限防巨型涂鸦)。 */
export const BoardOverlaySave = Envelope.extend({
  type: z.literal("board.overlay.save"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  dataB64: z.string().max(5_600_000),
});
/** 手绘批注层拉取(2026-10-14 会话级落盘:无语义板时 taskId=__session__,笔迹跟会话走,换浏览器/刷新不丢)。 */
export const BoardOverlayGet = Envelope.extend({
  type: z.literal("board.overlay.get"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
});
/** 节点评论(五期):查看态追加,服务端合并(免 rev 冲突,agent 并发更新板也不丢评论)。
 *  c1(编辑/删除):op 缺省 append 保持旧语义;update/delete 按 index 定位**同节点已有评论**
 *  (node.comments 仍是纯字符串数组,持久化形状不变),index 由面板按当前渲染顺序给出。 */
export const BoardComment = Envelope.extend({
  type: z.literal("board.comment"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  nodeId: z.string().min(1),
  /** append/update 必带(非空,服务端再 trim+截断 500);delete 不需要正文。 */
  text: z.string().min(1).max(500).optional(),
  /** append=追加(缺省,向后兼容);update=按 index 改;delete=按 index 删。 */
  op: z.enum(["append", "update", "delete"]).optional(),
  /** update/delete 必填(0 基,指向该节点 comments 的下标)。 */
  index: z.number().int().min(0).optional(),
});
/** 从代码生成模块图(七期):code-sense 整理 file 的符号为工作流模块节点+真实调用边,落成一块新板。 */
export const BoardFromCode = Envelope.extend({
  type: z.literal("board.fromcode"),
  sessionId: z.string().min(1),
  file: z.string().min(1).max(400),
  projectId: z.string().min(1).optional(),
});
/** step-073:code-sense 分析产物直接生成可编辑语义板。
 * source=modulemap(全仓模块依赖)/archmap(LLM 架构图,无 LLM 显式降级)/sequence(符号静态时序,需 query)/pageflow(页面流)。 */
export const BoardFromSense = Envelope.extend({
  type: z.literal("board.fromsense"),
  sessionId: z.string().min(1),
  source: z.enum(["modulemap", "archmap", "sequence", "pageflow", "decision"]),
  /** sequence=符号名;pageflow/modulemap 可空(全仓);archmap=意图描述(可空走缺省)。
   *  decision=符号名(query)或文件相对路径(file)或函数名(fn),三者至少一个。 */
  query: z.string().max(300).optional(),
  /** decision:符号名/函数名(query 亦可);file=源文件相对路径(与 symbol 组合定位函数)。 */
  symbol: z.string().max(300).optional(),
  fn: z.string().max(300).optional(),
  file: z.string().max(400).optional(),
  projectId: z.string().min(1).optional(),
});
/** 设计沉淀查询(step-058):任务收官的 done 板项目级索引;代码档案「设计沉淀」区数据源。
 * 板全文不走此消息——点击条目由面板复用 board.get(sessionId,taskId) 拿 doc+links。 */
export const BoardArchiveList = Envelope.extend({
  type: z.literal("board.archive.list"),
  projectId: z.string().min(1).optional(),
});
/** step-121 工作流板编译(只编译不跑):画布 doc→harness-workflow 脚本;错误 fail-visible 列出。 */
export const BoardWorkflowCompile = Envelope.extend({
  type: z.literal("board.workflow.compile"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
});
/** step-121 工作流板编译执行:编译通过即异步运行(引擎真跑),进度走 board.workflow.progress 广播,
 * 终态 board.workflow.result 广播;编译失败直接回 run.result(errors)。 */
export const BoardWorkflowRun = Envelope.extend({
  type: z.literal("board.workflow.run"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
});

// 会话分叉(ZCode session-fork 语义移植,refs: ZCode):新会话完整继承原会话上下文事件。
export const SessionFork = Envelope.extend({
  type: z.literal("session.fork"),
  sessionId: z.string().min(1),
  /** 备注(面板透传;服务端仅落分叉标记行,不参与复制逻辑)。 */
  title: z.string().optional(),
});

// ---- 运行看板(参考项目 dashboard 功能融合;数据源=journal,推送=WS 总线) ----
// 语义:dashboard.sessions/trends 拉模型回包 + dashboard.changed 推模型触发
// (journal 新事件节流广播,面板收到后重拉——SSE 对应物走既有 WS 总线,不加端口)。
export const DashboardSessions = Envelope.extend({
  type: z.literal("dashboard.sessions"),
  /** 作用域:'all'/项目 id/'unassigned';缺省='all'。 */
  projectId: z.string().nullable().optional(),
});
export const DashboardTrends = Envelope.extend({
  type: z.literal("dashboard.trends"),
  projectId: z.string().nullable().optional(),
});
/** 子代理终止(2026-10-16 子代理目录「终止」按钮;最小消息):服务端查后台注册表条目的
 * cancel 句柄调用;句柄未挂(并行线字段未上线/已收尾)=ok:false + reason,面板 toast 如实提示。 */
export const SubagentCancel = Envelope.extend({
  type: z.literal("subagent.cancel"),
  agentId: z.string().min(1),
});

// fixI1: 会话消息排队(fixI)——session 忙碌时 task.submit 入队,任务终态 FIFO 自动续发。
export const QueueItem = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  instruction: z.string().min(1),
  createdAt: z.number(),
  projectId: z.string().optional(),
  attachments: z.array(z.object({ name: z.string(), path: z.string(), mime: z.string().optional(), size: z.number().optional() })).optional(),
});
export type QueueItem = z.infer<typeof QueueItem>;
// fixI2: 抢占(立即发送):取消当前任务+立即提交该排队消息(同 sessionId,上下文延续)。
export const QueueDispatchNow = Envelope.extend({
  type: z.literal("queue.dispatch.now"),
  sessionId: z.string().min(1),
  itemId: z.string().min(1),
});
// ask_user(2026-10-19 许愿式编程):主 agent 在需求有取舍时向用户发问,阻塞等待答复。
// Client 侧:面板回送用户选择/自由文本。
export const AskUserAnswer = Envelope.extend({
  type: z.literal("ask.user.answer"),
  requestId: z.string().min(1),
  answer: z.string(),
});
// fixI3: 队列项删除(编辑=面板本地回填 composer 后 remove,改完重发)。
export const QueueRemove = Envelope.extend({
  type: z.literal("queue.remove"),
  sessionId: z.string().min(1),
  itemId: z.string().min(1),
});
// per-session 主模型覆盖(白板「per-session 主模型」):每个 session 独立主模型;
// 未设置 session 沿用全局 coding.llm;运行中任务持启动时引用(不热切全局 provider)。
// 2026-10-22:model 允许 null=清除覆盖(回到跟随全局);expectedRevision=可选 CAS(不符则拒绝且不落盘)。
export const SessionModelSet = Envelope.extend({
  type: z.literal("session.model.set"),
  sessionId: z.string().min(1),
  /** null=清除该会话覆盖,回到跟随全局 coding.llm;非空字符串=设置覆盖。 */
  model: z.string().min(1).nullable(),
  providerId: z.string().optional(),
  /** 会话级思考档覆盖(m7):取值域 low/medium/high/xhigh(见 effort-policy EFFORT_LEVELS);
   * ""=显式关闭(请求不带 reasoning_effort);null/缺省=清除该字段、跟随全局
   * coding.llm.implementationEffort。合法性由服务端校验(非法值回 code=invalid-effort 不落盘),
   * 故协议层保留 string,不做枚举硬拦。旧客户端不带 → 行为不变。 */
  effort: z.string().nullable().optional(),
  /** 乐观并发:该会话当前 revision(见 session.model.result.revision);不符=拒绝写入。 */
  expectedRevision: z.number().int().nonnegative().optional(),
});
export const SessionModelGet = Envelope.extend({
  type: z.literal("session.model.get"),
  sessionId: z.string().min(1),
});
// 会话→owner 项目桥(2026-10-22 归属漂移根治,前端半边已按此字面契约实现):
// 该会话**最早**一条带 projectId 的任务的 projectId=会话既有 owner;无任务/无归属=null。
export const SessionOwnerGet = Envelope.extend({
  type: z.literal("session.owner.get"),
  sessionId: z.string().min(1),
});

// ---- 内置浏览器视图(2026-10-21 移植 ZCode browser-use:统一视图双态+截图流) ----
// 形态来源: ZCode/packages/shared/src/browser-use/commands.ts(命令面)+
//   ZCode/packages/ui/src/browser-use/UnifiedBrowserView.tsx(视图态)。
// 订阅制:面板打开 browser 视图发 view.open,服务端仅在订阅存续期间推 frame(≥800ms 节流、变更才推)。
export const BrowserViewOpen = Envelope.extend({
  type: z.literal("browser.view.open"),
  /** 缺省=订阅当前活动 tab。 */
  tabId: z.string().optional(),
});
export const BrowserViewClose = Envelope.extend({
  type: z.literal("browser.view.close"),
  tabId: z.string().optional(),
});
// 面板转发的工具命令(白名单由服务端 BrowserViewHub.runViewCommand 把关,面板不直连页面)。
export const BrowserViewCommand = Envelope.extend({
  type: z.literal("browser.view.command"),
  tabId: z.string().optional(),
  action: z.string().min(1),
  args: z.record(z.unknown()).optional(),
});

// ---- 截图标注(2026-10-26,面板自有能力) ----
// 链路:composer 按钮→getDisplayMedia 取屏→画框裁剪→面板标注编辑器(框/点/全局
// 三类编号批注)→ annotate.submit →服务端落盘 <项目>/.genie/feedback/ +构造
// feedback-minimal-4 兼容 JSON +组装 instruction → task.submit(忙则入队)。
// 几何/JSON 构造在服务端(apps/gateway/src/annotate.ts,可单测),面板只交原始批注。
export const AnnotateNoteZ = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("region"),
    /** 图像像素坐标(左上原点;服务端负责取整/夹边,x2≥x1+1)。 */
    source: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }),
    /** 布局意图(组件拆移):rect=搬动后的最终区域;服务端换算 movement{rect,dx,dy,scaleX?,scaleY?}。 */
    movement: z.object({ rect: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }) }).optional(),
    /** 随组件搬动的子批注(框选,坐标在最终画面;输出为 feedback children,编号全局连续)。 */
    children: z.array(z.object({
      source: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }),
      text: z.string().min(1).max(10000),
    })).max(1000).optional(),
    /** 有 movement 时允许空文本(纯布局意图,annotations 留空);无 movement 必填。 */
    text: z.string().max(10000),
  }),
  z.object({
    kind: z.literal("point"),
    point: z.object({ x: z.number(), y: z.number() }),
    text: z.string().min(1).max(10000),
  }),
  z.object({ kind: z.literal("global"), text: z.string().min(1).max(10000) }),
]);
export const AnnotateSubmit = Envelope.extend({
  type: z.literal("annotate.submit"),
  /** 目标会话(反馈作为该会话的追问/新任务投递;项目归属复用 task.submit 决议)。 */
  sessionId: z.string().min(1),
  /** 面板裁剪后的截图(image/png dataURL;尺寸/哈希由服务端从字节实测)。 */
  dataUrl: z.string().min(1),
  notes: z.array(AnnotateNoteZ).min(1).max(1000),
  /** 带编号标记的预览图(image/jpeg dataURL;服务端校验尺寸与原图一致后随反馈落盘)。 */
  previewDataUrl: z.string().min(1).optional(),
  /** 采集上下文(截图=screen,导入=file+fileName;capturedAt 为带时区 ISO)。 */
  capture: z.object({
    source: z.enum(["screen", "file"]),
    capturedAt: z.string().min(1),
    fileName: z.string().max(255).optional(),
  }).optional(),
  /** 页面说明(≤500 字符,显示在反馈 capture.page,帮 agent 定位截图所在页面)。 */
  pageContext: z.string().max(500).optional(),
  /** 录音批注(dataURL,`data:audio/webm;codecs=opus;base64,...`;服务端转写为文字并入任务书)。
   * 语义上限 8MB 由服务端校验(这里只做形态校验:必须是 audio/* 的 dataURL)。 */
  audioUrl: z.string().min(1).regex(/^data:audio\/[^;,]+(?:;codecs=[^;,]+)?;base64,/).optional(),
});
export const AnnotateResult = Envelope.extend({
  type: z.literal("annotate.result"),
  ok: z.boolean(),
  /** ok=true:投递目标任务(新任务或入队项所属会话)。 */
  taskId: z.string().optional(),
  queued: z.boolean().optional(),
  imagePath: z.string().optional(),
  feedbackPath: z.string().optional(),
  /** ok=true 且带预览时回带(全 global 批注无预览则缺省)。 */
  previewPath: z.string().optional(),
  /** 任务书是否经小模型整理(refine);缺省/false=回落模板任务书。 */
  refined: z.boolean().optional(),
  /** 录音已保留的音频文件路径(转写失败时音频仍在盘上,便于回听)。 */
  voicePath: z.string().optional(),
  /** 录音转写失败原因(fail-soft:不影响提交,任务书里会注明)。 */
  voiceError: z.string().optional(),
  message: z.string().optional(),
});

// ---- 聊天窗语音任务书(2026-11-08)----
// 链路:composer 🎤 按钮→MediaRecorder 录音(dataURL)→ voice.draft →服务端用 coding.models.voice
// 角色模型(qwen3.8-omni-flash 形态的 OpenAI 兼容端点)把口述整理成任务书 → voice.draft.result
// →面板把任务书文本回填聊天输入区(用户确认后自己发送)。撰写期间按 sessionId 加输入锁:
// 同会话禁止输入,切到别的会话不受影响(锁是纯客户端 per-session 状态)。
export const VoiceDraft = Envelope.extend({
  type: z.literal("voice.draft"),
  /** 锁定/回填目标会话(草稿态="";服务端不依赖它做状态,只透传回包)。 */
  sessionId: z.string(),
  /** 录音 dataURL(`data:audio/webm;codecs=opus;base64,...`;8MB/形态校验在服务端 annotate-voice 同源)。 */
  audioUrl: z.string().min(1).regex(/^data:audio\/[^;,]+(?:;codecs=[^;,]+)?;base64,/),
  /** 输入区已有文字草稿(口述与文字合并成同一份任务书,不丢用户写下的内容)。 */
  draftText: z.string().max(20000).optional(),
});
export const VoiceDraftResult = Envelope.extend({
  type: z.literal("voice.draft.result"),
  /** 原样回带请求的 sessionId(面板按它解锁+回填)。 */
  sessionId: z.string(),
  ok: z.boolean(),
  /** ok=true:任务书全文(回填输入区)。 */
  text: z.string().optional(),
  /** ok=false:可操作错误(含「未配置 coding.models.voice」指路)。 */
  message: z.string().optional(),
});

// ---- M167 表面/通道能力包(2026-11-08)----
/** 客户端能力位(已解析形态;source=legacy 表示无声明、按旧面板行为)。 */
export const SurfaceCapsZ = z.object({
  rendersMarkdown: z.boolean(),
  maxChars: z.number(),
  /** 允许的媒体类型白名单子集(image/file/audio/video/link)。 */
  mediaKinds: z.array(z.string()),
  hasUI: z.boolean(),
  source: z.enum(["client", "legacy"]),
});
export type SurfaceCapsWire = z.infer<typeof SurfaceCapsZ>;
/**
 * 客户端声明表面能力:字段全部可选(缺省逐项按 LEGACY 兜底);值类型故意放宽为 unknown,
 * 让 server 用 surface-capabilities 判「坏字段 → surface.result ok:false 且不落账」,
 * 而不是在协议解析层被通用 invalid-message 吞掉。
 * sessionId 必填(简化:声明绑定具体会话,同会话最新一条为准)。
 */
export const ClientSurface = Envelope.extend({
  type: z.literal("client.surface"),
  sessionId: z.string().min(1),
  rendersMarkdown: z.unknown().optional(),
  maxChars: z.unknown().optional(),
  mediaKinds: z.unknown().optional(),
  hasUI: z.unknown().optional(),
});

/** M72 能力暴露 allowlist:连接级 clientMode 声明(未声明=panel,legacy 消费者零变化)。
 * mode 用 string 接收而非 z.enum:非法值由网关回 client.mode.result{ok:false} 并保持连接原 mode,
 * 客户端能拿到「你写的值不合法」的定向提示;走枚举只会落到 InvalidMessage 通用文案。 */
export const ClientModeDeclare = Envelope.extend({
  type: z.literal("client.mode"),
  mode: z.string().min(1).max(32),
});

export const ClientMessage = z.discriminatedUnion("type", [
  ClientSurface,
  ClientModeDeclare,
  BrowserViewOpen, BrowserViewClose, BrowserViewCommand,
  TaskSubmit, TaskCancel, TaskResume, QueueDispatchNow, QueueRemove, AskUserAnswer, TaskRename, TaskPin, TaskArchive, TaskDelete, TaskDeleteSession, ArchiveClear, TaskDetailGet, FilesSearch, SessionSearch, FileRead, FileWrite, IdeOfficeEdit, WorkflowAnswer, GitLog, GitCommitMsg, ExpDisable, CheckpointPreview, CheckpointRewind, TaskDiffstat, StatsSummary, TaskFileDiff, ModelsProbe, AgentsList, SkillsList, SkillsDisableBuiltin, CommandsList, CommandsUpsert, CommandsRemove, CommandsCatalog, HooksList, HooksUpsert, HooksUpdate, HooksRemove, McpList, McpUpsert, McpUpdate, McpRemove, McpTest, MemoryView, TermExec, TermCancel, PluginsList, PluginsInstall, PluginsUninstall, PluginsToggle, NodesList, NodeExec, WizardGen, ProfileGet, ProfileRebuild, ProfilePlanUpsert, ProfilePlanRemove, ProfilePlanApply, ProfileSenseGet, AutomationList, AutomationCreate, AutomationUpdate, AutomationDelete, AutomationRun, TaskList, SessionHistory, NodeRegister, NodeHeartbeat, NodeTaskResult, PermissionRespond, ProjectAdd, ProjectRemove, ProjectActivate, ProjectList, ProjectRename, SshKeyImport, SshConfigList, SshTest, WslList, WslTest, WslBrowse, SshBrowse, RemoteLs, RemoteRead, RemoteDeploy, FsList, FsOpen, FsMkdir, FsRemove, FsRename, FsGrep, LspDiagnostics, TermSessionOpen, TermSessionSend, TermSessionRead, TermSessionClose, GitShow, GitStatus, GitDiff, GitBranches, GitCheckout, GitCommit, GitPush, GitPull, SenseQuery, WikiList, WikiGet, WikiRebuild, ReviewStoreGet, ExpList, ExpView, ExpRemove, SysMeta, CfgGet, CfgSet, CfgSecretStatus, CfgSecretSet, ModelsList, SessionStatus, TraceStats, CompanionTurn, SuperTurn, SuperHistory, SuperInbox, VoiceTranscribe, CompanionHistory, ProfileFile, Ping, MeetingImport, MeetingSchedule, SessionExport, VoiceTts, VoiceList, TeamStatus, TeamInvite, PermissionPending, TaskGroup, ExpDistill, CheckpointList, CheckpointRestore, GoalSet, GoalGet, SessionCompact, PlanApprove, TaskOutputQuery, BoardGet, BoardList, BoardDiagramRequest, BoardSave, BoardContinue, BoardOverlaySave, BoardOverlayGet, BoardComment, BoardFromCode, BoardFromSense, BoardArchiveList, BoardWorkflowCompile, BoardWorkflowRun, TeamaiPull, TeamaiPush, TeamaiInspect, TeamaiContribute, TeamaiRemove, SessionFork, DashboardSessions, DashboardTrends, SubagentCancel, ReviewInject, IssueList, IssueCreate, IssueUpdate, IssueComment, IssueSync, IssueConfirmDispatch, TeamP2pStatus, TeamP2pSend, SubagentsList, WorkersList, TrackView, UsageView, SessionModelSet, SessionModelGet, SessionOwnerGet, AnnotateSubmit, TraceQuery, VoiceDraft, PermissionHistory,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- 服务端 → 客户端 ----
export const TaskState = z.enum(["queued", "running", "blocked", "interrupted", "done", "failed", "cancelled"]);
/** 板质量遥测(2026-11-05 bq3):任务结算的规划质量结构化字段,与 audit 出口 planQualityOf 同源;
 *  skeleton=骨架采纳维度(landed 并集 vs 终板 sk- 存活),无骨架任务缺省。 */
export const PlanQualityZ = z.object({
  boardType: z.string().nullable(),
  nodes: z.number(),
  contentNodes: z.number(),
  p0: z.object({ passed: z.number(), total: z.number(), rate: z.number() }),
  anchorDensity: z.number(),
  skeleton: z.object({ generated: z.number(), survived: z.number(), adoptionRate: z.number() }).optional(),
});
export type PlanQuality = z.infer<typeof PlanQualityZ>;
export const Task = z.object({
  id: z.string(), sessionId: z.string(), instruction: z.string(),
  state: TaskState, targetNode: z.string().optional(),
  resourceTags: z.array(z.string()).optional(),
  createdAt: z.number(), updatedAt: z.number(),
  result: z.string().optional(), idempotencyKey: z.string().optional(),
  credentialRef: z.string().optional(),
  projectId: z.string().optional(),
  title: z.string().optional(), pinned: z.boolean().optional(), archived: z.boolean().optional(),
  /** step-165 gaps3.2:用户改名粘性标记(ref session-mgmt custom 粘性);rename 置位/清名复位,面板据此保用户标题。 */
  titleCustom: z.boolean().optional(),
  /** F3 自定义分组(用户桶;缺省无)。 */
  group: z.string().optional(),
  /** 本次运行起点(step-046,「已工作」计时);未跑过=缺省。 */
  startedAt: z.number().optional(),
  attachments: z.array(z.object({ name: z.string(), path: z.string(), mime: z.string().optional(), size: z.number().optional() })).optional(),
  /** 板质量遥测(2026-11-05 bq3):结算时挂上,随 done 带出(task.detail.get 全量返回);
   *  task.list/task.changed 走 TaskIndex 投影不带本字段。skeleton 维度=骨架采纳率,无骨架任务缺省。 */
  planQuality: PlanQualityZ.optional(),
  /** 任务进展(touch 写入,面板防御式读取:全部字段可选,缺失即不显示)。
   *  只随 task.detail.get 全量返回,**不进 TaskIndex**(列表帧不带)。 */
  progress: z.object({
    phase: z.string().optional(),
    step: z.number().optional(),
    note: z.string().optional(),
    at: z.number().optional(),
  }).optional(),
});
/** 与 zod 常量同名的类型导出(2026-11-05):Task 从 interface 转 zod 后,全仓 `import type { Task }` 的
 * 调用方不断线——const(值)与 type(类型)同名合法,单点修复所有消费方。 */
export type Task = z.infer<typeof Task>;


/**
 * 任务索引(2026-10-29 协议索引化):hello / task.list / task.changed 只发索引,正文
 * (instruction/result/error/attachments/resourceTags/idempotencyKey/credentialRef/targetNode)
 * 一律不进索引——面板按 id 发 task.detail.get 现取。历史:2026-11-04 网关 OOM 二连的根因是
 * 列表帧带全文(hello 峰值 960KB),当时用「最近 N 条全文+其余截断」的魔法数补丁压着;索引化后
 * 帧长只随任务条数线性增长(每条约百字节),不再随正文长度爆炸,截断口径与阈值一并不存在。
 */
export const TaskIndex = z.object({
  id: z.string(),
  sessionId: z.string(),
  state: TaskState,
  /** 必有:TaskSupervisor 派生标题优先,缺失时回落到 instruction 首行/任务 id 前缀(见 task-index.ts)。 */
  title: z.string(),
  updatedAt: z.number(),
  createdAt: z.number(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
  projectId: z.string().optional(),
  group: z.string().optional(),
  titleCustom: z.boolean().optional(),
  startedAt: z.number().optional(),
});
export type TaskIndex = z.infer<typeof TaskIndex>;

// 内置浏览器视图·截图帧(订阅制推流;seq per-tab 单调递增,面板据此丢弃乱序/旧帧)。
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

// ── super agent 指挥台 inbox(step-1033,契约 §2)──
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

/** M167 表面能力声明回执:ok=false 时带稳定 error(坏字段/缺 sessionId),且服务端未落账。 */
export const SurfaceResult = Envelope.extend({
  type: z.literal("surface.result"),
  ok: z.boolean(),
  caps: SurfaceCapsZ.optional(),
  error: z.string().optional(),
});

export const ServerMessage = z.discriminatedUnion("type", [
  SurfaceResult,
  BrowserViewFrame, BrowserViewEvent, BrowserViewSubscribed, BrowserViewCommandResult,
  // fixI4: hello 附全量会话排队快照(页面刷新后队列恢复);queue.update=队列任何变更广播(入队/出队/删除/抢占)。
  // 2026-10-22:build=面板产物戳——老窗口收到与自身 __PANEL_BUILD 不符时自愈重载(IDE 空白根治)。
  // J4(2026-11-05):sessionActivity = sid → 最近活动时间(ms)首帧快照(侧栏排序用;独立字段,不污染 TaskIndex)。
  Envelope.extend({ type: z.literal("hello"), build: z.string().optional(), tasks: z.array(TaskIndex), queue: z.array(QueueItem).optional(), sessionActivity: z.record(z.number()).optional() }),
  Envelope.extend({ type: z.literal("queue.update"), sessionId: z.string(), items: z.array(QueueItem) }),
  Envelope.extend({ type: z.literal("task.submitted"), task: Task }),
  Envelope.extend({ type: z.literal("task.changed"), task: TaskIndex }),
  Envelope.extend({ type: z.literal("task.list"), tasks: z.array(TaskIndex) }),
  /** 单任务详情回执(正文只在被点名时出现):task=null 表示 id 不存在/已删(面板须显示不可用,不得当正文渲染)。 */
  Envelope.extend({ type: z.literal("task.detail.result"), taskId: z.string(), task: Task.nullable() }),
  // super-agent Router(step-0143 P1):Ticket 阶段变化广播(observed/open/closed;P3 面板 Ticket 阶段表消费)。
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
    // 向后翻页(2026-10-22):旧字段一律保留(since/events/sessionId),以下两个只在 beforeSeq 路径给。
    hasMore: z.boolean().optional(),
    /** 下一页游标(本页最小 seq);仅 hasMore=true 时给——游标必须严格推进,否则前端 loop 会死转。 */
    nextBeforeSeq: z.number().int().optional(),
  }),
  // 会议导入(step-013 收口)/会话导出(step-004 收口)
  Envelope.extend({ type: z.literal("meeting.extraction"), extraction: z.record(z.unknown()), draftPath: z.string() }),
  Envelope.extend({ type: z.literal("meeting.scheduled"), tasks: z.array(z.object({ id: z.string(), content: z.string() })) }),
  Envelope.extend({ type: z.literal("session.export.result"), sessionId: z.string(), file: z.string(), events: z.number().int() }),
  Envelope.extend({ type: z.literal("voice.tts.result"), audioB64: z.string(), mime: z.string(), text: z.string(), voice: z.string().optional() }),
  // 音色清单(2026-10-20):model=过滤依据回显;voices 空=无内置清单(自定义 id 兜底)。
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
  // designs/30 门面回包:inspect(清单+diff+体检)/contribute(learnings 分支)/remove(main 上删除)。
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
  // step-1042 关卡 Gate:决议广播(broker onSettle→全端一致清理挂起行/modal;by=panel/timeout/offline/policy/…)。
  Envelope.extend({ type: z.literal("permission.resolved"), requestId: z.string(), decision: z.enum(["allow-once", "reject"]), by: z.string() }),
  // step-1042 关卡 Gate 历史面:broker 内存 ring 最近决议(旧在前;重启即失——持久化登记后续)。
  Envelope.extend({ type: z.literal("permission.history.result"), items: z.array(z.object({ requestId: z.string(), sessionId: z.string(), tool: z.string(), summary: z.string(), risk: z.string(), since: z.number(), settledAt: z.number(), decision: z.string(), by: z.string() })) }),
  Envelope.extend({ type: z.literal("checkpoint.list.result"), snapshots: z.array(z.object({ taskId: z.string(), sha: z.string().nullable(), sessionId: z.string(), at: z.number() })) }),
  Envelope.extend({ type: z.literal("checkpoint.restore.result"), ok: z.boolean(), sha: z.string().optional(), reason: z.string().optional() }),
  Envelope.extend({ type: z.literal("exp.distill.result"), ok: z.boolean(), detail: z.string().optional() }),
  // ZCode 内置命令回包(step-052)
  // sync=true=goal.get 轮询/查询回包(状态同步,前端静默刷新 chip);缺省=goal.set 动作确认(可 toast)。
  // 「目标已清除」toast 刷屏根因(2026-10-13 视频):15s 轮询复用动作确认回包语义。
  Envelope.extend({ type: z.literal("goal.result"), goal: z.string().nullable(), state: z.enum(["active", "paused", "cleared", "complete", "budget_limited"]), sync: z.boolean().optional() }),
  Envelope.extend({ type: z.literal("session.compact.result"), compacted: z.boolean(), reason: z.string().optional(), summaryChars: z.number().int().optional(), tokensBefore: z.number().optional(), tokensAfter: z.number().optional(), trigger: z.enum(["manual", "auto"]).optional() }),
  // 压缩状态帧(2026-11 边界元数据):手动 /compact 与自动钩子共用的过程广播(started/completed/
  // failed/skipped)。广播而非回包——多标签页/看板都要看见「这次谁触发、压了多少、为什么没压」。
  Envelope.extend({ type: z.literal("session.compact.status"), sessionId: z.string(), phase: z.enum(["started", "completed", "failed", "skipped"]), trigger: z.enum(["manual", "auto"]).optional(), reason: z.string().optional(), summaryChars: z.number().int().optional(), tokensBefore: z.number().optional(), tokensAfter: z.number().optional() }),
  Envelope.extend({ type: z.literal("plan.approval.request"), sessionId: z.string(), taskId: z.string(), planPath: z.string(), planExcerpt: z.string() }),
  Envelope.extend({ type: z.literal("task.output.result"), agentId: z.string(), status: z.string(), outputFile: z.string().optional(), output: z.string().optional() }),
  // 子代理终止回包(2026-10-16 目录「终止」按钮;cancel 句柄缺席=ok:false+reason,面板如实提示)
  Envelope.extend({ type: z.literal("subagent.cancel.result"), agentId: z.string(), ok: z.boolean(), reason: z.string().optional() }),
  // 档案文件钻取(step-048 追记八:文件清单/函数+调用边)
  Envelope.extend({
    type: z.literal("profile.file.result"),
    mode: z.enum(["files", "symbols"]),
    files: z.array(z.string()).optional(),
    file: z.string().optional(),
    symbols: z.array(z.object({ name: z.string(), kind: z.string(), line: z.number(), container: z.string().nullable(), id: z.string() })).optional(),
    edges: z.array(z.object({ from: z.string(), fromName: z.string(), to: z.string(), toName: z.string(), line: z.number(), crossFile: z.boolean() })).optional(),
    /** code2flow 分类(2026-10-12 三改):符号 id → trunk/leaf/regular + 出入度。 */
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
  // ── super agent 指挥台(step-1033,出站只发 super.*)──
  Envelope.extend({ type: z.literal("super.turn.user"), text: z.string() }),
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
  // ── legacy 只读(step-1033):以下 companion.* 服务端消息保留在联合里(旧回放/旧客户端解析不破),
  // 服务端不再发出(server 出站统一 super.*)。 ──
  // 语音入口广播(2026-10-13:头像气泡语音→companion,转写文本先播给全部客户端,回复随后 turn.done)
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
  // 追踪统计投影(step-031:dsh session-stats 诚实子集;ttft/decodeTps=流式链路收口,缺 0)
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
      // 子代理消耗(2026-10-22 用户口径:单独一窗;不并入 tokens)
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
  // 会话状态服务端推送(step-030 推送化收口):任务/待办/子代理状态变化时主动广播,
  // 面板收到即替代一次轮询(轮询保留作断线兜底)。
  // J4(2026-11-05 侧栏按会话活动时间排序):lastActivityAt=该会话最近一次「用户可见动作」的 journal 时间(ms)。
  // 复用本帧的 200ms per-session 合并,不新增 message type(历史故障教训:独立高频帧会放大广播风暴)。
  Envelope.extend({ type: z.literal("session.status.changed"), sessionId: z.string(), lastActivityAt: z.number().optional() }),
  // 语义流程白板(designs/22):board.get 回包/列表回包/agent 写板广播(面板在板视图时即刷新)
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
      /** 2026-10-22:板类型,面板据此按类型过滤(旧服务端缺省=design)。 */
      docKind: z.string().optional(),
      /** 2026-10-22:该板未处理的用户评论条数(agent 尚未消费);0/缺省=无待读。 */
      pendingComments: z.number().int().optional(),
    })),
    /** step-072:损坏/不可读板文件数(面板显式降级「板损坏」而非冒充「无板」;0 时服务端缺省不发)。 */
    skipped: z.number().int().optional(),
  }),
  // board.changed 走 bus 广播通道(server.ts onBusEvent),线形={type, payload} 包装。
  Envelope.extend({ type: z.literal("board.changed"), payload: z.object({ sessionId: z.string(), taskId: z.string() }) }),
  // 设计沉淀回包(step-058):done 板项目级索引条目(files=节点 symbolRef.file 去重,反查匹配键)
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
  // ---- step-121 工作流板:编译回包 / 运行进度广播 / 运行终态广播 ----
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
  // 会话进度投影(step-030:ZCode ConversationStatusPanel 的拉模型版;轮询由面板发起)
  Envelope.extend({
    type: z.literal("session.status.result"),
    /** 回显请求的会话 id(step-1036):面板按它登记水位表(缺它则所有会话的水位都落到
     *  undefined 键 → 后续请求永远发不出 sinceSeq,增量路径形同虚设 —— 浏览器实测抓到)。
     *  可选:旧网关不回显时面板退回「当前会话」口径(Tolerant Reader)。 */
    sessionId: z.string().min(1).optional(),
    status: z.object({
      /** step-1036 增量化:水位=该会话当前最大 seq(空会话=0)。面板据此下次带 sinceSeq 走增量。
       *  与 status.task 索引化同批(2026-11 治网关 OOM):task 只带 TaskIndex,instruction/result
       *  全文一律不进状态帧(面板按 id 走 task.detail.get)。 */
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
      // 子代理实时清单(B 2026-10-14 面板过程卡):后台注册表按会话过滤+output.txt tail;缺省=注册表缺席(降级)
      // model(step-060 子代理目录):子代理实际模型名(注册表缺席/旧进程=缺省,目录回落「主模型」文案)
      // deadline/heartbeatAt/stale/stopReason(2026-10-16 目录深化,并行线字段):有则透传无则缺省——面板防御式渲染。
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
  // repo wiki(step-118):manifest 为结构化页面索引(panel 直接消费;z.record 保持协议松耦合)
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
    /** 已禁用条目(step-044 恢复入口数据源)。 */
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
    /** env 占用键(2026-10-19 模型切换失效根治配套):这些键被进程 env 层(GENIE_LLM_*)压住,
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
  // ---- tunnel 委派(step-033,designs/09 §4):任务书下发远端节点;凭证只带引用名,值由节点本地解析 ----
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
  // 权限审批请求(step-037):广播给已连接客户端;超时无应答=自动拒绝(fail-closed)。
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
  // 会话全文检索回包(step-115):result=DiscoverResult(browse 时空 query 也走此型)。
  Envelope.extend({ type: z.literal("session.search.result"), query: z.string(), result: z.unknown() }),
  // ask_user(2026-10-19 许愿式编程):主 agent 需求取舍发问,面板问答条答复(ask.user.answer)。
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
    /** step-141 IDE(full=true):二进制文件(首 8KB 含 NUL)不回 content,只回标记。 */
    binary: z.boolean().optional(),
    /** step-141 IDE(full=true):>2MB 不回全文,只回标记(响应体防放大)。 */
    tooLarge: z.boolean().optional(),
    /** 2026-10-26:显式 projectId 的项目目录不可用(只读保护;面板提示恢复目录而非「不存在」)。 */
    unavailable: z.boolean().optional(),
  }),
  // step-141 IDE 保存链:ok=落盘成功;失败回 error(code=file-write-denied,message 带 reason)。
  Envelope.extend({
    type: z.literal("file.write.result"),
    path: z.string(),
    ok: z.boolean(),
    bytes: z.number().int().optional(),
  }),
  // 2026-10-29 板「OOXML 文本回写」P2:Office 文本级编辑回执(服务端读原文件→重写→落盘)。
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
  // 内联变更条(step-046):无快照/无差异=空 files,面板隐藏条。
  Envelope.extend({
    type: z.literal("task.diffstat.result"),
    taskId: z.string(),
    sha: z.string().nullable(),
    files: z.array(z.object({ path: z.string(), add: z.number(), del: z.number() })),
    total: z.object({ files: z.number(), add: z.number(), del: z.number() }),
    error: z.string().optional(),
  }),
  // 单文件补丁结果(step-052):变更条文件清单→右侧 diff 面板。
  Envelope.extend({
    type: z.literal("task.filediff.result"),
    taskId: z.string(),
    file: z.string(),
    diff: z.string().optional(),
    truncated: z.boolean().optional(),
    error: z.string().optional(),
  }),
  // 模型探活结果(step-052):设置页模型列表逐项「测」→最小 chat 调用往返。
  Envelope.extend({
    type: z.literal("models.probe.result"),
    model: z.string(),
    ok: z.boolean(),
    ms: z.number(),
    error: z.string().optional(),
  }),
  // 使用统计(step-046):journal 离线归约(journal 全量事件+任务登记表)。
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
  // 管理面结果(step-047)
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
  // 插件市场(step-048)
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
  // 项目档案(step-049)
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
  // 总路线(step-131):项目开发宗旨/主线能力/偏离提示 + 确定性骨架事实;exists=false=manifest 缺席
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
  // step-1042 节点 Fleet:注册/掉线/心跳在线态翻转的廉价广播(面板收即重拉 nodes.list;负载细节仍在回包)。
  Envelope.extend({ type: z.literal("nodes.changed") }),
  // step-1042 节点 Fleet「电脑控制」真路由回执:remote=NodeDispatch.delegate 结果;local 照旧走 task 链无此帧。
  Envelope.extend({ type: z.literal("node.exec.result"), nodeId: z.string(), ok: z.boolean(), output: z.string().optional(), error: z.string().optional(), durationMs: z.number().optional() }),
  Envelope.extend({
    type: z.literal("wizard.gen.result"),
    kind: z.enum(["ssh", "docker"]),
    command: z.string(),
    note: z.string(),
  }),
  Envelope.extend({ type: z.literal("term.output"), chunk: z.string(), err: z.boolean().optional() }),
  // 流式消息(step-050,ZCode 流式消息展示):loop onStream 旁路广播;不落 journal,终态由 task.changed/session.history 承接。
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
  // 评审遗留(行级回写店,2026-10-13):sticky 跨轮视图(open=未解决,resolved=已标记不再复现)。
  Envelope.extend({
    type: z.literal("review.store.result"),
    projectId: z.string().nullable(),
    root: z.string(),
    open: z.array(StoredCommentZ),
    resolved: z.array(StoredCommentZ),
  }),
  // 评审评论回注回执(step-074):注入目标会话+新任务 id+条数,面板据此 toast/跳转。
  Envelope.extend({
    type: z.literal("review.inject.result"),
    sessionId: z.string(),
    taskId: z.string(),
    count: z.number().int(),
  }),
  // 项目清单(step-035):连接即推+变更广播;availability=启动期一次性校验(ZCode 同语义)。
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
  // 服务端目录浏览(step-056):path="" 为锚点应答;error 时 entries 缺省。
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
  // step-142 IDE 文件操作回包(mkdir/remove/rename 三通道同构):ok=false 时 error 带拒因
  // (越界/.git/目标不存在/目录非空未传 recursive…),面板据此 toast 并不刷新树。
  Envelope.extend({ type: z.literal("fs.mkdir.result"), path: z.string(), ok: z.boolean(), error: z.string().optional() }),
  Envelope.extend({ type: z.literal("fs.remove.result"), path: z.string(), ok: z.boolean(), error: z.string().optional() }),
  Envelope.extend({ type: z.literal("fs.rename.result"), from: z.string(), to: z.string(), ok: z.boolean(), error: z.string().optional() }),
  // step-142 全项目内容搜索:matches[{ path(项目内相对), line(1-based), text(整行,已截断 400 字符) }]。
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
  // modelOverride(2026-10-22):父会话若有 per-session 主模型覆盖,fork 后继承认该覆盖(同 zcode
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
  // 2026-10-22:改为**广播**(多标签/多客户端同步),payload 带 ok/effective/routeError/warning/revision;
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
  // 聊天窗语音任务书回执(voice.draft 的应答;ok=false 带「未配置」指路)。
  VoiceDraftResult,
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

// Team Relay 协议(designs/05 §8 子集):独立消息族,与 gateway 命令族互不掺入。
export * from "./relay.js";
