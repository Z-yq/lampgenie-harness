/**
 * 错误码 → 人话文案(单一出处)+ 诊断摘要拼装。
 *
 * 口径对齐 ZCode/packages/shared/src/errors.ts:14-89 与 ZCode/packages/ui/src/ChatErrorBanner.tsx:43-105:
 * 「结构化 code 决定人说的人话,message 只作附加细节」——服务端 message 是跨进程兜底,
 * 不能直接充当最终 UI 语言来源(ZCode 注释原话);展示层按 code 本地化,未登记 code 走兜底。
 *
 * 为什么单独成模块:面板(panel.ts,手写 HTML/JS 字符串模板)与 gateway 侧测试要共用
 * 同一张表。panel.ts 通过 `PANEL_ERROR_TEXT_JS`(JSON + 函数源码)构建期字符串注入,
 * 浏览器侧与 Node 侧跑的是同一份文案,不存在第二份手抄表。
 * 注入源只允许纯函数 + 无外部引用的常量(模板字面量坑:字符串里不写反斜杠转义,换行用 String.fromCharCode(10))。
 */
import { ErrorCode } from "@lampgenie/protocol";

/**
 * 单张 code → 人话映射表。类型标成 Record<ErrorCode, string>:
 * protocol 新增一个码而这里漏写文案 = tsc 直接报错(不再靠人肉对齐)。
 */
export const ERR_TEXT: Record<ErrorCode, string> = {
  // ---- 核心/通用 ----
  [ErrorCode.InvalidMessage]: "网关不认识这条消息(面板与网关版本可能错位)",
  [ErrorCode.HandlerCrash]: "网关处理这条请求时崩了",
  [ErrorCode.NotImplemented]: "该能力在当前网关未启用",
  [ErrorCode.Unknown]: "未知错误",
  [ErrorCode.Internal]: "网关内部错误",
  [ErrorCode.BadRequest]: "请求参数不合法",
  // ---- 任务/队列/提问 ----
  [ErrorCode.UnknownTask]: "任务不存在(可能已被删除或属别的会话)",
  [ErrorCode.UnknownQuestion]: "要回答的问题已失效",
  [ErrorCode.UnknownAsk]: "这条提问已失效或已被回答",
  [ErrorCode.UnknownAutomation]: "自动化不存在",
  [ErrorCode.QueueItemMissing]: "队列项不存在(可能已发送或已删除)",
  // ---- 会议/团队/语音 ----
  [ErrorCode.MeetingImportFailed]: "会议纪要导入失败",
  [ErrorCode.SuperFailed]: "指挥台对话失败",
  [ErrorCode.SuperAnnounceFailed]: "指挥台播报失败",
  [ErrorCode.CompanionFailed]: "指挥台对话失败(legacy companion 错误码)",
  [ErrorCode.CompanionAnnounceFailed]: "指挥台播报失败(legacy companion 错误码)",
  [ErrorCode.VoiceUnavailable]: "语音播报未配置(先配 audio.tts)",
  [ErrorCode.VoiceFailed]: "语音处理失败",
  // ---- 扩展面 ----
  [ErrorCode.PluginInvalid]: "插件配置不合法",
  [ErrorCode.HookInvalid]: "hook 配置不合法",
  [ErrorCode.McpInvalid]: "MCP 服务配置不合法",
  [ErrorCode.CommandInvalid]: "自定义命令不合法",
  [ErrorCode.CustomCommandReservedName]: "自定义命令与内置命令同名,已忽略(内置优先)",
  [ErrorCode.AutomationInvalid]: "自动化配置不合法",
  [ErrorCode.RuleConflict]: "规则与既有约束冲突",
  // ---- 计划/目标 ----
  [ErrorCode.PlanInvalid]: "计划内容不合法",
  [ErrorCode.PlanEmpty]: "计划为空,至少要有一个节点",
  [ErrorCode.PlanGoalMutex]: "存在进行中的目标,与当前权限模式互斥",
  [ErrorCode.GoalInvalid]: "目标内容不合法",
  [ErrorCode.GoalPlanMutex]: "已有进行中的计划,与目标互斥",
  // ---- 白板 ----
  [ErrorCode.BoardInvalid]: "白板内容不合法",
  [ErrorCode.BoardBadRequest]: "白板请求参数不合法",
  [ErrorCode.BoardNotFound]: "白板不存在",
  [ErrorCode.BoardNodeNotFound]: "白板节点不存在",
  [ErrorCode.BoardNoIndex]: "白板缺少代码索引,无法推导",
  [ErrorCode.BoardFromcodeFailed]: "从代码生成白板失败",
  [ErrorCode.BoardFromsenseFailed]: "从结构画像生成白板失败",
  [ErrorCode.BoardOverlayInvalid]: "白板覆盖层不合法",
  [ErrorCode.BoardFileNotIndexed]: "该文件未被索引,无法上板",
  [ErrorCode.BoardFileEmpty]: "该文件为空,无法上板",
  // ---- issue/评论 ----
  [ErrorCode.IssueMissing]: "issue 不存在",
  [ErrorCode.CommentTextEmpty]: "评论内容为空",
  [ErrorCode.CommentIndexOutOfRange]: "评论位置越界(内容可能已变更)",
  // ---- 文件/终端/sense/经验 ----
  [ErrorCode.FileWriteDenied]: "写入被沙箱拒绝(路径不在允许范围)",
  [ErrorCode.TermFailed]: "终端命令执行失败",
  [ErrorCode.TermBusy]: "终端已有命令在跑",
  [ErrorCode.SenseFailed]: "结构查询失败",
  [ErrorCode.MemoryFailed]: "记忆面操作失败",
  [ErrorCode.StatsFailed]: "统计查询失败",
  [ErrorCode.SkillsFailed]: "技能查询失败",
  [ErrorCode.AgentsFailed]: "子代理查询失败",
  [ErrorCode.ExpFailed]: "经验库操作失败",
  // ---- 项目/配置/模型/会话 ----
  [ErrorCode.ProjectAddFailed]: "项目添加失败",
  [ErrorCode.RemoteOpFailed]: "远程操作失败(SSH 连接/认证/执行;详见消息)",
  [ErrorCode.ProjectRemoveFailed]: "项目移除失败",
  [ErrorCode.ProjectRenameFailed]: "项目重命名失败",
  [ErrorCode.ProjectActivateFailed]: "项目激活失败",
  [ErrorCode.ProfileSenseFailed]: "项目剖面生成失败",
  [ErrorCode.ProfileFileFailed]: "项目剖面文件操作失败",
  [ErrorCode.CfgSetFailed]: "配置写入失败",
  [ErrorCode.ModelsListFailed]: "模型列表拉取失败",
  [ErrorCode.ModelsNotImplemented]: "当前未装配模型目录服务",
  [ErrorCode.ModelsNoProvider]: "未配置模型 Provider",
  [ErrorCode.ModelsNotConfigured]: "模型端点未配置",
  [ErrorCode.ModelsNoCredential]: "模型凭证缺失",
  [ErrorCode.ModelsUpstreamFailed]: "模型端点请求失败",
  [ErrorCode.SessionModelSetFailed]: "会话模型切换失败",
  [ErrorCode.SessionExportFailed]: "会话导出失败",
  // ---- git/wiki/节点 ----
  [ErrorCode.GitFailed]: "Git 操作失败",
  [ErrorCode.GitNorepo]: "当前项目不是 Git 仓库",
  [ErrorCode.WikiListFailed]: "Wiki 列表读取失败",
  [ErrorCode.WikiGetFailed]: "Wiki 页面读取失败",
  [ErrorCode.WikiRebuildFailed]: "Wiki 重建失败",
  [ErrorCode.NodeOffline]: "执行节点离线",
};

/** 未登记 code 的兜底前缀(Q6:原文照出,不吞服务端细节)。 */
export const ERR_UNKNOWN_PREFIX = "未知错误(";

/**
 * code + message → 一句人话。
 * - 已登记 code:`ERR_TEXT[code]`(有 message 就以「 — 原文」追加细节,原文不丢)
 * - 未登记 code:`未知错误(<code>):<原文>`(兜底,绝不空白)
 * 纯函数、只依赖 ERR_TEXT / ERR_UNKNOWN_PREFIX 两个常量(会被 toString() 注入面板浏览器侧,
 * 故不得调用本模块的其它函数——只允许 `as` 这类编译期断言)。
 */
export function errorText(code: unknown, message?: unknown): string {
  const c = String(code === null || code === undefined ? "" : code);
  const detail = String(message === null || message === undefined ? "" : message).slice(0, 300);
  const table = ERR_TEXT as unknown as Record<string, string>;
  const label = Object.prototype.hasOwnProperty.call(table, c) ? table[c] : "";
  if (!label) return ERR_UNKNOWN_PREFIX + (c || "无 code") + "):" + (detail || "服务端未给出原文");
  return detail ? label + " — " + detail : label;
}

/**
 * 复制诊断摘要(Q6):code + message + sessionId + traceId(若存在)。
 * 换行走 String.fromCharCode(10) —— 本函数源码会被注入面板模板,避免模板层的反斜杠转义坑。
 */
export function errorDiagnostic(code: unknown, message: unknown, sessionId?: unknown, traceId?: unknown): string {
  const NL = String.fromCharCode(10);
  const lines = [
    "code: " + (code === null || code === undefined || code === "" ? "(none)" : String(code)),
    "message: " + String(message === null || message === undefined ? "" : message),
    "sessionId: " + (sessionId === null || sessionId === undefined || sessionId === "" ? "(none)" : String(sessionId)),
  ];
  if (traceId) lines.push("traceId: " + String(traceId));
  return lines.join(NL);
}
