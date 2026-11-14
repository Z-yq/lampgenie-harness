/**
 * agent-wiring 兼容壳(拆分):实现按域搬到 ./agent-wiring/* 七模块
 * (permission / wiring-core / loop-support / tools / workflow-task / deadline-wire / run-with-agent)。
 * 本文件保留原路径具名转发——消费方零改动;类型用 export type 转发(verbatimModuleSyntax)。
 */
export { BOARD_AUDIT_DIR, buildSubagentExtraTools, buildSubagentToolPolicy, clearSessionAlways, codeSenseTool, decidePermission, journalGate, loadPermissionRules, makeSubagentPermissionAsker, noAlwaysAllowEnabled, permissionAlwaysKey, rememberSessionAlways, resolveSubagentCapability, riskOfTool, sessionAlwaysStore, sessionAlwaysStoreForTests, setPermissionGuards } from "./agent-wiring/permission.js";
export type { PermissionAskPort, SubagentCapabilityPlan, SubagentToolPolicy } from "./agent-wiring/permission.js";
export { SUBAGENT_BRIEF_CAP, SUBAGENT_SKILL_INDEX_MAX_CHARS, SUBAGENT_WATCHDOG_GRACE_MS, TOOL_HINTS, bgAgents, bindOwnerRegistry, buildMainLoopPermission, cancelOwnedUnit, collectSkillIndexEntries, deliverFinalNoticeWithAttention, disposeSessionJobs, ensureSubagentWatchdog, getExperienceStore, getJobRegistry, getTerminalService, governToolIdentity, imageOffloadOf, maybeWakeIdleSession, memoryTool, namedSystemBlocks, ownTerminalUnits, plannerScopeOf, postTerminalInflight, registerOwnedUnit, renderSubagentSkillIndex, runSubagentWatchdog, scanBgAgentsForWatchdog, settleOwnedUnit, subagentBriefs, subagentRegistry, trackPostTerminal, visionBridgeFor, withAnswerAttentionGuard, writeBarrierOf } from "./agent-wiring/wiring-core.js";
export type { NamedSystemBlock, SubagentWatchdogAction } from "./agent-wiring/wiring-core.js";
export { DISPATCH_TIP, PARALLEL_TIP, PARALLEL_TIP_COOLDOWN_STEPS, PARALLEL_TIP_MAX_PER_EPISODE, SYSTEM, SYSTEM_LITE, appendTaskArchive, applyTrajectoryProgress, buildLoopTips, progressNoteFromTrajectory, readTaskArchive, reapOrphanSubagents, renderTaskArchiveBlock, runtimeEnvBlock, setRuntimePromptProvider, subagentModelNameOf, systemForTaskClass } from "./agent-wiring/loop-support.js";
export type { RuntimePromptProvider, TaskArchiveEntry, TrajectoryProgressEvent } from "./agent-wiring/loop-support.js";
export { FOLD_CATEGORY_WHITELIST, SKILL_VIEW_MAX_BYTES, WORKFLOW_ACTIONS, WORKFLOW_ASSET_LIST_MAX, askUserTool, boardReadTool, boardUpsertTool, computeSkeletonAdoption, expandSkillDirVars, experienceFoldTool, findWorkflowAsset, planQualityOf, renderTeamaiBlock, runningWorkflows, skillViewTool, todoTool, truncateSkillBytes, workflowAmendPatch, workflowAssetDirs, workflowCapsFromArgs, wrapSkillContent } from "./agent-wiring/tools.js";
export type { WorkflowAction } from "./agent-wiring/tools.js";
export { CODING_DISCIPLINE_REFILL, VISION_IMAGE_MIMES, VISION_MAX_BYTES, VISION_MAX_IMAGES, archLlmFromProvider, buildAttachmentInjection, classifyAttachment, classifyTaskClass, codeReviewTool, firstSymbolLike, isBinaryLikeMime, normalizeAttachmentMime, planFileBlockFor, planModePrompt, projectMainlineBlockOf, runWorkflowTool, soulDisciplinesFor, symbolContextFor } from "./agent-wiring/workflow-task.js";
export type { AttachmentInjection, AttachmentLike, ReviewLlmPolicy, TaskClass } from "./agent-wiring/workflow-task.js";
export { collectSnapshotPaths, countActiveSubagents, currentSubgoal, mainRequestMaxTokens, maybeContinueGoal, resolveSubagentDeadlineMin, taskKindToolsLogged, verifyTaskEnvelopeAtStart, wireAgentLoop } from "./agent-wiring/deadline-wire.js";
export type { EnvelopeStartJournal } from "./agent-wiring/deadline-wire.js";
export { runWithAgent } from "./agent-wiring/run-with-agent.js";
