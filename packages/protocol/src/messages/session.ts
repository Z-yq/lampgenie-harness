/**
 * 会话/项目域消息:session.*(history/status/search/fork/compact/model/owner)+ dashboard + 项目管理。
 * 自 index.ts(2941 行)按域拆分,逐字搬移。
 */
import { z } from "zod";
import { Envelope } from "./core.js";
// [CROSS-IMPORTS]
export const SessionExport = Envelope.extend({
  type: z.literal("session.export"),
  sessionId: z.string().min(1),
});
// 后台子代理进度/结果查询(ZCode TaskOutput 语义)
export const SessionCompact = Envelope.extend({
  type: z.literal("session.compact"),
  sessionId: z.string().min(1),
 /** 可选摘要指示(ZCode /compact [instructions] 透传)。 */
  instructions: z.string().optional(),
});
// F3 任务行操作(ZCode TaskListItemContextMenu 移植)
export const SessionHistory = Envelope.extend({
  type: z.literal("session.history"),
  sessionId: z.string().min(1),
 /** 增量追平路径(旧):返回 seq>=sinceSeq 的事件。未给 sinceSeq 且未给 beforeSeq = 现有全量回放。 */
  sinceSeq: z.number().int().nonnegative().optional(),
 /** 向后翻页(新):只返回 seq<beforeSeq 的事件。与 sinceSeq 互斥,判定优先级在服务端(beforeSeq 优先)。
 * 面板长会话首开只取尾页,再按 nextBeforeSeq 逐页回溯(参考 ZCode rowsRange 游标分页纪律)。 */
  beforeSeq: z.number().int().min(0).optional(),
 /** 单页条数上限(beforeSeq 路径生效;缺省 500,钳到 [1,2000])。 */
  limit: z.number().int().min(1).max(2000).optional(),
 /** 增量追平:上次回包的会话水位;与 atLogEpoch 一起构成 delta 游标。
 * ring 可覆盖且 epoch 相等 → 只回 seq>atRevision 的增量;否则回整页(游标失效时带 reset)。
 * 缺省=旧行为逐字不变。 */
  atRevision: z.number().int().min(0).optional(),
 /** 上次回包的网关进程 epoch(启动时刻)。用于识别网关重启/journal 重载:epoch 不等一律回整页。 */
  atLogEpoch: z.number().int().min(0).optional(),
});
export const SessionStatus = Envelope.extend({
  type: z.literal("session.status"),
  sessionId: z.string().min(1),
 /** 增量化:已收到的末条事件 seq(= 上次回包 status.seq)。缺省=全量投影(老客户端/首拉,
 * 与改造前逐字一致);带值=服务端只归约 seq 更大的新事件并合并进累积态。
 * 注意服务端读事件时传 sinceSeq+1(journal.readSession 比较用 e.seq >= sinceSeq),否则水位那条重复归约。 */
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
// ---- 项目管理(ZCode workspace 项目移植) ----
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

export const SessionSearch = Envelope.extend({
  type: z.literal("session.search"),
  query: z.string().default(""),
  limit: z.number().int().positive().max(50).optional(),
});

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
/** 子代理终止(子代理目录「终止」按钮;最小消息):服务端查后台注册表条目的
 * cancel 句柄调用;句柄未挂(并行线字段未上线/已收尾)=ok:false + reason,面板 toast 如实提示。 */
export const SubagentCancel = Envelope.extend({
  type: z.literal("subagent.cancel"),
  agentId: z.string().min(1),
});

// fixI1: 会话消息排队(fixI)——session 忙碌时 task.submit 入队,任务终态 FIFO 自动续发。
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
// 会话→owner 项目桥(归属漂移根治,前端半边已按此字面契约实现):
// 该会话**最早**一条带 projectId 的任务的 projectId=会话既有 owner;无任务/无归属=null。
export const SessionOwnerGet = Envelope.extend({
  type: z.literal("session.owner.get"),
  sessionId: z.string().min(1),
});
