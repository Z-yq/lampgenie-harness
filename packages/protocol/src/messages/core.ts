/**
 * 协议核心:信封(Envelope)与错误码单一出处。
 * 自 index.ts(2941 行)按域拆分,逐字搬移。
 */
// [CROSS-IMPORTS]
/**
 * Gateway Client Protocol(定稿)的 zod schema。
 * 模式参照 qwen-audio-agent shared/protocol(Apache-2.0,能力协商/信封纪律),
 * 内容自研——该仓协议以 voice 事件为主体,不适用 coding harness。
 */
import { z } from "zod";

import { PROTOCOL_VERSION } from "../version.js";

export const Envelope = z.object({ v: z.literal(PROTOCOL_VERSION) });

// ---- 错误码(单一出处)----
/**
 * gateway 错误帧 `error.code` 的统一枚举(2026 错误语义统一第一批)。
 * 口径对齐 ZCode/packages/shared/src/errors.ts:14-89(normalizeUnknownError:
 * 「结构化 code 优先、message 兜底」)——即 code 是可编程的稳定标识,人话文案由展示层
 * (面板 ERR_TEXT:apps/gateway/src/error-text.ts)按 code 本地化,服务端 message 只做兜底。
 * Q1 过渡方案(本批已拍板):`as const` 对象 + 同名类型 = 收窄但不封闭。
 * error 帧 schema 用 `z.union([z.enum(ERROR_CODE_VALUES), z.string])`:
 * 新站点写错 code 有 IDE/tsc 提示,历史字符串仍可通过校验(不炸旧调用点/旧客户端)。
 * 后续批次再把 union 收成 z.enum 完成封闭。
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
 /** 能力门:调用了本连接未声明 supportedOps 的通道(值不变,登记进枚举供严格客户端校验)。 */
  UnsupportedOp: "unsupported-op",
 /** 分发门:网关不认识的 type(分发门在 switch 之前拒收;面板与网关版本可能错位)。 */
  UnknownMethod: "unknown-method",
 // ---- 任务/队列/提问 ----
  UnknownTask: "unknown-task",
  UnknownQuestion: "unknown-question",
  UnknownAsk: "unknown-ask",
  UnknownAutomation: "unknown-automation",
  QueueItemMissing: "queue-item-missing",
 /** 持久队列:同一幂等键但载荷指纹不同(不写入,调用方须换键或核对内容)。 */
  QueueConflict: "queue-conflict",
 // ---- 会议/团队/语音 ----
  MeetingImportFailed: "meeting-import-failed",
 /** super agent 指挥台链(新链只发这两个)。 */
  SuperFailed: "super-failed",
  SuperAnnounceFailed: "super-announce-failed",
 /** @deprecated legacy:companion 链旧错误码,保留值不删,新链不再发出。 */
  CompanionFailed: "companion-failed",
 /** @deprecated legacy:见上。 */
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
