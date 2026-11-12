/**
 * 管理/杂项面消息:节点/wiki/评审/语音/经验/配置/团队/伙伴/追踪/权限/自动化/插件/档案/浏览器视图/表面能力。
 * 自 index.ts(2941 行)按域拆分,逐字搬移。
 */
import { z } from "zod";
import { Envelope } from "./core.js";
// [CROSS-IMPORTS]
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
 /** 项目级 code-sense(能力挂在项目级)——缺省回落 harness 根。 */
  projectId: z.string().min(1).optional(),
});
// repo wiki:持久 .genie/wiki/<repo>/ 页结构;projectId 缺省回退 harness 根。
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
// 评审遗留(行级回写店消费:sticky/resolved 跨轮视图。
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
/** 评审评论一键回注聊天窗:单条/多条/整批评论编成修复指令,作为新任务注入目标会话。
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
/** 语音输入( qwen-audio-realtime 即语音模型,主 agent 语音通道)。
 * 浏览器采集 PCM16(base64)→服务端转 dashscope realtime→回复文本;凭证不出服务端。
 * @deprecated voice.speak(音频直入大脑链路)已删除——server 不再受理,已从 ClientMessage
 * 联合移除;保留 export 只为旧引用编译不破。语音入口改走 voice.transcribe(ASR→文本→super.turn)。 */
export const VoiceSpeak = Envelope.extend({
  type: z.literal("voice.speak"),
 /** 16kHz PCM16 单声道,base64 编码。 */
  audioB64: z.string().min(1),
});
/** 语音输入:浏览器 PCM16(base64)→服务端 ASR→文本;不产生人格设定与语音回播。 */
export const VoiceTranscribe = Envelope.extend({
  type: z.literal("voice.transcribe"),
  audioB64: z.string().min(1),
  format: z.enum(["pcm16"]).optional(),
  sampleRate: z.number().int().positive().optional(),
});
// F3 自定义分组:任务拖入用户自定义桶(本地偏好,不进状态机)。
export const ExpDistill = Envelope.extend({ type: z.literal("exp.distill"), sessionId: z.string().min(1), projectId: z.string().optional() });
// 多快照浏览(/):快照清单+任意恢复。
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
// teamai 兼容面:pull=手动触发团队仓重拉;push=经验/技能以 teamai skill 形态推团队仓。
export const TeamaiPull = Envelope.extend({ type: z.literal("teamai.pull") });
export const TeamaiPush = Envelope.extend({ type: z.literal("teamai.push"), orgUrl: z.string().optional(), ns: z.string().optional(), name: z.string().min(1), description: z.string().optional(), body: z.string().min(1), contributors: z.array(z.string()).optional(), /** 资源类( §2.2);缺省=skill(旧客户端不带 kind 仍有效)。 */ kind: z.enum(["skill", "rule", "doc"]).optional() });
// 门面三件套(panel 侧):inspect=资产清单+本地/团队仓 diff+团队仓体检;contribute=会话经验入 learnings;
// remove=删团队仓 main 上的一份资源。三者都只是转发/读面,权威数据仍在团队仓。
export const TeamaiInspect = Envelope.extend({ type: z.literal("teamai.inspect") });
export const TeamaiContribute = Envelope.extend({ type: z.literal("teamai.contribute"), orgUrl: z.string().optional(), title: z.string().min(1), body: z.string().min(1), tags: z.array(z.string()).optional(), project: z.string().optional() });
export const TeamaiRemove = Envelope.extend({ type: z.literal("teamai.remove"), orgUrl: z.string().optional(), kind: z.enum(["skill", "rule", "doc"]), ns: z.string().optional(), name: z.string().min(1) });
export const PermissionPending = Envelope.extend({ type: z.literal("permission.pending") });
/** 关卡 Gate 历史面:拉最近决议(broker 内存 ring;重启即失,持久化登记后续)。 */
export const PermissionHistory = Envelope.extend({ type: z.literal("permission.history"), limit: z.number().int().positive().max(100).optional() });
// TTS 播报(二期:文本→服务端 qwen-tts→音频 base64 回放;
// 凭证不出服务端;brief 级经播报改写器口语化限长。
export const VoiceTts = Envelope.extend({
  type: z.literal("voice.tts"),
  text: z.string().min(1),
  level: z.enum(["full", "brief"]).default("full"),
 /** 音色试听:单次覆盖 config audio.tts.voice,不落配置;服务端回包 voice.tts.result.voice 回显。 */
  voice: z.string().min(1).max(80).optional(),
});
/** 音色清单:按当前 audio.tts.model 返回内置官方音色表;未知模型=空表(前端走自定义 voice id 兜底)。 */
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
/** 经验删除:物理删技能目录,ledger 记 delete 可审计。 */
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
/** 预设一键接入:密钥名是否已存在(只查名字,不返回值)。 */
export const CfgSecretStatus = Envelope.extend({
  type: z.literal("cfg.secret.status"),
  rid: z.string().max(40).optional(),
  names: z.array(z.string().min(1)).max(20),
});
/** 写入本机密钥文件(值只在 WS 帧内传输,服务端落 0600 文件)。 */
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
 /** 只读探测——回包仅报连通与可见模型数,面板不合并目录(拉取合并走缺省形态)。 */
  probeOnly: z.boolean().optional(),
});
export const ProfileFile = Envelope.extend({
  type: z.literal("profile.file"),
  projectId: z.string().optional(),
 /** 缺省=拉文件清单;给 file=拉该文件函数与调用边。 */
  file: z.string().optional(),
});
/** @deprecated legacy:companion.turn 入站仍受理(老客户端),新前端只发 super.turn。 */
export const CompanionTurn = Envelope.extend({
  type: z.literal("companion.turn"),
  text: z.string().min(1),
});
/** super agent 指挥台:唯一新写入站(命令框/侧聊带入)。
 * 可选 sessionId(固定持久会话;缺省="super",与 superSessionId 同源;旧客户端不传=旧值兼容)。 */
export const SuperTurn = Envelope.extend({
  type: z.literal("super.turn"),
  text: z.string().min(1),
  sessionId: z.string().min(1).max(64).optional(),
});
/** 指挥台历史浮层:sinceSeq 增量拉取。 */
export const SuperHistory = Envelope.extend({
  type: z.literal("super.history"),
  sinceSeq: z.number().int().nonnegative().optional(),
});
/** 指挥台待处理清单:ask/permission/interrupted/blocked/failed 聚合。 */
export const SuperInbox = Envelope.extend({
  type: z.literal("super.inbox"),
  limit: z.number().int().positive().max(200).optional(),
});
/** @deprecated legacy:companion.history 入站仍受理,回包统一 super.history.result。 */
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
export const Ping = Envelope.extend({ type: z.literal("ping") });

export const ModelsProbe = Envelope.extend({ type: z.literal("models.probe"), model: z.string().min(1), providerId: z.string().optional() });

// ---- 管理面(子智能体/技能/命令/钩子/MCP/记忆)+ 终端 ----
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

// ---- 插件市场 / 节点 / 附件 ----
export const PluginsList = Envelope.extend({ type: z.literal("plugins.list") });
export const PluginsInstall = Envelope.extend({ type: z.literal("plugins.install"), id: z.string().min(1) });
export const PluginsUninstall = Envelope.extend({ type: z.literal("plugins.uninstall"), id: z.string().min(1) });
export const PluginsToggle = Envelope.extend({ type: z.literal("plugins.toggle"), id: z.string().min(1), enabled: z.boolean() });
export const NodesList = Envelope.extend({ type: z.literal("nodes.list") });
// ---- 看板三件套(子代理目录/任务追踪/用量,各自独立看板) ----
export const SubagentsList = Envelope.extend({ type: z.literal("subagents.list"), sessionId: z.string().optional() });
/** 会话 worker 清单(F5-3 可观测):活跃 worker 进程的 pid/会话/时刻。 */
export const WorkersList = Envelope.extend({ type: z.literal("workers.list") });
export const TrackView = Envelope.extend({ type: z.literal("track.view"), sessionId: z.string().optional() });
export const UsageView = Envelope.extend({ type: z.literal("usage.view") });
// ---- 项目档案(架构图管线) ----
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
/** 「总路线」并入代码档案:读/生成项目宗旨画像(.genie/sense-index/profile.json)。
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
 /** 作用域:"global" 缺省;否则=项目 id。 */
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
// ---- 权限审批( B2,ZCode PermissionDialog 移植) ----
export const PermissionRespond = Envelope.extend({
  type: z.literal("permission.respond"),
  requestId: z.string().min(1),
  decision: z.enum(["allow-once", "reject", "allow-always"]),
 /** allow-always 附带要写入的规则(permission+pattern;缺省 pattern=*)。 */
  rule: z.object({ permission: z.string(), pattern: z.string() }).optional(),
});

/** node-agent 执行结果回流( tunnel 委派)。 */
export const NodeTaskResult = Envelope.extend({
  type: z.literal("node.task.result"),
  nodeId: z.string().min(1),
  taskId: z.string().min(1),
  ok: z.boolean(),
  output: z.string().optional(),
  error: z.string().optional(),
});

// ---- 内置浏览器视图(移植 ZCode browser-use:统一视图双态+截图流) ----
// 形态来源: ZCode/packages/shared/src/browser-use/commands.ts(命令面)+
// ZCode/packages/ui/src/browser-use/UnifiedBrowserView.tsx(视图态)。
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

// ---- 表面/通道能力包----
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

/**  能力暴露 allowlist:连接级 clientMode 声明(未声明=panel,legacy 消费者零变化)。
 * mode 用 string 接收而非 z.enum:非法值由网关回 client.mode.result{ok:false} 并保持连接原 mode,
 * 客户端能拿到「你写的值不合法」的定向提示;走枚举只会落到 InvalidMessage 通用文案。 */
export const ClientModeDeclare = Envelope.extend({
  type: z.literal("client.mode"),
  mode: z.string().min(1).max(32),
});

/** 客户端显式声明能力集(连接级;缺声明=legacy,服务端全量放行)。
 * 字段值故意收 unknown:坏字段由网关能力协商回执的 droppedKeys 逐项说明,而不是在协议解析层
 * 落通用 invalid-message(那样客户端只知道「消息非法」,不知道哪个字段被丢)。 */
export const ClientCapabilitiesDeclare = Envelope.extend({
  type: z.literal("client.capabilities"),
  supportedOps: z.unknown().optional(),
  contractVersion: z.unknown().optional(),
  requiredOps: z.unknown().optional(),
});
