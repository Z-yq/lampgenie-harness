/**
 * 任务域消息:task.* 与 meeting/goal/plan.approve/checkpoint/queue/ask.user + 服务端 Task/TaskIndex/TaskState/PlanQuality。
 * 自 index.ts(2941 行)按域拆分,逐字搬移。
 */
import { z } from "zod";
import { Envelope } from "./core.js";
// [CROSS-IMPORTS]
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
 /** 附件:已上传文件(.genie/uploads/<sid>/…);agent 侧注入任务书 + vision 通道。 */
  attachments: z.array(z.object({ name: z.string(), path: z.string(), mime: z.string().optional(), size: z.number().optional() })).optional(),
 // ---- 外部来源提交面(全部 optional:面板不带=内部 user 路径逐字零变化)----
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
// 定时任务:创建面(内容门在 runtime validateScheduleContent 里落地)。
// mode/preRun/contextFrom/continuity 全部 optional:旧客户端不带 = 旧行为。
export const TaskSchedule = Envelope.extend({
  type: z.literal("task.schedule"),
  sessionId: z.string().min(1),
  instruction: z.string().min(1),
 /** 计划瞬间(毫秒时间戳)。 */
  at: z.number(),
  recurrence: z.string().optional(),
  timeZone: z.string().optional(),
  mode: z.string().optional(),
  preRun: z.union([z.string(), z.object({ command: z.string() })]).optional(),
  contextFrom: z.object({
    taskId: z.string().optional(),
    sessionId: z.string().optional(),
    maxChars: z.number().optional(),
  }).optional(),
  continuity: z.union([z.boolean(), z.object({ maxChars: z.number().optional() })]).optional(),
  title: z.string().optional(),
  projectId: z.string().optional(),
});
export const TaskScheduleCancel = Envelope.extend({
  type: z.literal("task.schedule.cancel"),
  taskId: z.string().min(1),
});
// interrupted 一键续跑:面板任务卡对 interrupted(及 legacy「重启中断」cancelled)任务发;
// 服务端 resumeInterrupted 幂等重提(idempotencyKey=resume:<原id>,双击/重连不双跑)。
export const TaskResume = Envelope.extend({
  type: z.literal("task.resume"),
  taskId: z.string().min(1),
});
// 会议导入命令面(二期, §3):纪要抽取→确认→批量任务。
export const MeetingImport = Envelope.extend({
  type: z.literal("meeting.import"),
  path: z.string().min(1),
});
export const MeetingSchedule = Envelope.extend({
  type: z.literal("meeting.schedule"),
  todos: z.array(z.object({ content: z.string().min(1), owner: z.string().optional(), deadline: z.string().optional() })).min(1),
  sessionId: z.string().optional(),
});
// 会话导出(二期):journal → dsh session-format v4 文件。
export const TaskOutputQuery = Envelope.extend({
  type: z.literal("task_output"),
  agentId: z.string().min(1),
});
// Plan 审批流(ZCode ExitPlanMode 审批语义):plan 模式任务终态→广播审批;
// 批准=按计划派实施(ZCode「User has approved your plan」模型内容);反馈=steered 消息。
export const PlanApprove = Envelope.extend({
  type: z.literal("plan.approve"),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  decision: z.enum(["approve", "feedback"]),
  feedback: z.string().optional(),
});
// ZCode 内置命令:/goal /compact。
export const GoalSet = Envelope.extend({
  type: z.literal("goal.set"),
  sessionId: z.string().min(1),
 /** null=清除(clear);重设=覆盖(ZCode replace 语义)。 */
  goal: z.string().nullable(),
  state: z.enum(["active", "paused"]).default("active"),
});
export const GoalGet = Envelope.extend({ type: z.literal("goal.get"), sessionId: z.string().min(1) });
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
/** 会话级批量删除(用户用户反馈「这些删不掉」):侧栏一行=一个会话(聚合),
 * 删单条撑不住整行(该会话还有 N 条任务)→ 一次删该会话全部任务。 */
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
export const TaskGroup = Envelope.extend({ type: z.literal("task.group"), taskId: z.string().min(1), group: z.string().min(1).nullable() });
// F5 一键沉淀:当前会话轨迹→经验库(incidents/自动提炼)。
export const CheckpointList = Envelope.extend({ type: z.literal("checkpoint.list") });
export const CheckpointRestore = Envelope.extend({ type: z.literal("checkpoint.restore"), sha: z.string().min(7) });
// 团队视图:多 org 快照/邀请;审批中心挂起清单。
// ---- checkpoint 回滚 ----
export const CheckpointPreview = Envelope.extend({ type: z.literal("checkpoint.preview"), taskId: z.string().min(1) });
export const CheckpointRewind = Envelope.extend({ type: z.literal("checkpoint.rewind"), taskId: z.string().min(1) });

// ---- 内联变更条/使用统计(ZCode 变更条+UsageStatistics 对齐) ----
export const TaskDiffstat = Envelope.extend({ type: z.literal("task.diffstat"), taskId: z.string().min(1) });
export const StatsSummary = Envelope.extend({ type: z.literal("stats.summary") });
// 单文件补丁(变更条文件清单→右侧 diff 面板)与模型逐一探活(设置页模型列表)。
export const TaskFileDiff = Envelope.extend({ type: z.literal("task.filediff"), taskId: z.string().min(1), file: z.string().min(1) });
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
// ask_user(许愿式编程):主 agent 在需求有取舍时向用户发问,阻塞等待答复。
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
// model 允许 null=清除覆盖(回到跟随全局);expectedRevision=可选 CAS(不符则拒绝且不落盘)。
export const TaskState = z.enum(["queued", "running", "blocked", "interrupted", "done", "failed", "cancelled"]);
/** 板质量遥测( bq3):任务结算的规划质量结构化字段,与 audit 出口 planQualityOf 同源;
 * skeleton=骨架采纳维度(landed 并集 vs 终板 sk- 存活),无骨架任务缺省。 */
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
 /** 用户改名粘性标记(ref session-mgmt custom 粘性);rename 置位/清名复位,面板据此保用户标题。 */
  titleCustom: z.boolean().optional(),
 /** F3 自定义分组(用户桶;缺省无)。 */
  group: z.string().optional(),
 /** 派发卡:super agent 派出的任务打 "super";随 task.* 帧带出,面板据此过滤渲染派发卡。 */
  submittedBy: z.string().optional(),
 /** 本次运行起点(「已工作」计时);未跑过=缺省。 */
  startedAt: z.number().optional(),
  attachments: z.array(z.object({ name: z.string(), path: z.string(), mime: z.string().optional(), size: z.number().optional() })).optional(),
 /** 板质量遥测( bq3):结算时挂上,随 done 带出(task.detail.get 全量返回);
 * task.list/task.changed 走 TaskIndex 投影不带本字段。skeleton 维度=骨架采纳率,无骨架任务缺省。 */
  planQuality: PlanQualityZ.optional(),
 /** 任务进展(touch 写入,面板防御式读取:全部字段可选,缺失即不显示)。
 * 只随 task.detail.get 全量返回,**不进 TaskIndex**(列表帧不带)。 */
  progress: z.object({
    phase: z.string().optional(),
    step: z.number().optional(),
    note: z.string().optional(),
    at: z.number().optional(),
  }).optional(),
});
/** 与 zod 常量同名的类型导出:Task 从 interface 转 zod 后,全仓 `import type { Task }` 的
 * 调用方不断线——const(值)与 type(类型)同名合法,单点修复所有消费方。 */
export type Task = z.infer<typeof Task>;


/**
 * 任务索引(协议索引化):hello / task.list / task.changed 只发索引,正文
 * (instruction/result/error/attachments/resourceTags/idempotencyKey/credentialRef/targetNode)
 * 一律不进索引——面板按 id 发 task.detail.get 现取。历史: 网关 OOM 二连的根因是
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
 /** 派发卡:super agent spawn_task 派出的任务打 "super"(面板聊天流按它过滤派发卡);
 * 其余任务缺省不带。 */
  submittedBy: z.string().optional(),
});
export type TaskIndex = z.infer<typeof TaskIndex>;

// 内置浏览器视图·截图帧(订阅制推流;seq per-tab 单调递增,面板据此丢弃乱序/旧帧)。