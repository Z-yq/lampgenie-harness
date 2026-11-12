/**
 * agent-wiring 分片:run-with-agent(自 agent-wiring.ts 7910 行按域拆分,逐字搬移)。
 * 原路径 agent-wiring.ts 保留具名转发 barrel;消费方零改动。
 */
import { getExperienceStore, subagentRegistry, registerOwnedUnit, settleOwnedUnit, subagentBriefs, SUBAGENT_BRIEF_CAP, SUBAGENT_WATCHDOG_GRACE_MS, getTerminalService, visionBridgeFor, trackPostTerminal } from "./wiring-core.js";
import { subagentModelNameOf } from "./loop-support.js";
import { projectMainlineBlockOf, normalizeAttachmentMime, planModePrompt, CODING_DISCIPLINE_REFILL } from "./workflow-task.js";
import { taskKindToolsLogged } from "./deadline-wire.js";
import { mainRequestMaxTokens, resolveSubagentDeadlineMin, currentSubgoal, collectSnapshotPaths, verifyTaskEnvelopeAtStart, maybeContinueGoal } from "./deadline-wire.js";
import type { EnvelopeStartJournal } from "./deadline-wire.js";
import { classifyTaskClass, symbolContextFor, firstSymbolLike, soulDisciplinesFor, buildAttachmentInjection, classifyAttachment, isBinaryLikeMime, planFileBlockFor, codeReviewTool, runWorkflowTool } from "./workflow-task.js";
import type { TaskClass } from "./workflow-task.js";
import { renderTaskArchiveBlock, readTaskArchive, buildLoopTips, systemForTaskClass, applyTrajectoryProgress, appendTaskArchive } from "./loop-support.js";
import { bgAgents, plannerScopeOf, renderSubagentSkillIndex, writeBarrierOf, imageOffloadOf, deliverFinalNoticeWithAttention, maybeWakeIdleSession, ensureSubagentWatchdog, collectSkillIndexEntries, namedSystemBlocks, withAnswerAttentionGuard, getJobRegistry, governToolIdentity, buildMainLoopPermission, disposeSessionJobs } from "./wiring-core.js";
import type { NamedSystemBlock } from "./wiring-core.js";
import { resolveSubagentCapability, buildSubagentExtraTools, makeSubagentPermissionAsker, buildSubagentToolPolicy, decidePermission, loadPermissionRules } from "./permission.js";
import { renderTeamaiBlock, skillViewTool, experienceFoldTool, todoTool, askUserTool, boardUpsertTool, boardReadTool, planQualityOf, computeSkeletonAdoption } from "./tools.js";
import { repoRoot } from "../repo-root.js";
import { systemPromptSha, recordSystemPromptSnapshot } from "../system-prompt-snapshot.js";
import { buildVlmFromConfig } from "../factory.js";
import { remoteLs, remoteReadWindow, remoteWrite, remoteEdit, remoteGlob, remoteExec, shQuote, remoteRun, remoteGit } from "../ssh-ops.js";
import { tryChannelJson } from "../remote-channel.js";
import { parseRemoteProject, type RemoteProject } from "../remote-project.js";
import { snapshotApprovalObject, verifyApprovalObject } from "../approval-object.js";
import { TimeTravelStore } from "../time-travel-store.js";
import { makeLlmTraceSink } from "../llm-trace.js";
import { mkdirSync as _mdSync } from "node:fs";
import { execFileSync as _execFileSync } from "node:child_process";
import { join as _join, dirname as _dir } from "node:path";
import type { Journal } from "@lampgenie/core";
import { bus } from "@lampgenie/core";
import { readSecretValue } from "@lampgenie/core";
import { AgentLoop, deriveMessages, type AgentStreamEvent, type LlmProvider, type Tool } from "@lampgenie/runtime/agent/loop";
import { ToolIdentityRegistry } from "@lampgenie/runtime/agent/tool-identity";
import { meetingImportTool } from "../meeting-tools.js";
import {
  computeP0Coverage, markDoneFromEvidence, renderP0Status, smokeTemplateNode, staleSummaryOf,
  PACKAGING_PREFLIGHT, type P0NodeStatus, type BoardNodeT,
} from "../board-accept.js";
import { loadBoard as loadBoardSync, boardPath as boardFilePath, loadBoardAsync, listBoardsExAsync, LABEL_MAX_CHARS } from "../board-store.js";
import { boardSkillBody, parseBoardSkillName } from "../board-skills.js";
import { boardExportPptxTool } from "../board-export-pptx-tool.js";
import { deriveBoardEdges } from "../board-derive.js";
import { isContentNode } from "../board-content-predicate.js";
import { makeCalleesResolver } from "../board-derive-resolver.js";
import { composeSystemPrompt, discoverAgentsMd, renderSubagentDispatchSection, renderSkillIndex, SKILL_INDEX_MAX_CHARS, type SkillIndexEntry, type ToolHint } from "@lampgenie/runtime/agent/system-composer";
import { ParentAskBroker, driveParentDecision, renderPendingQuestionsBlock, buildSubagentAnswerTool } from "@lampgenie/runtime/agent/parent-ask-broker";
import { SubagentRegistry } from "@lampgenie/runtime/agent/subagent-registry";
import { MAX_SUBAGENT_DEPTH, depthOf, forkContextBlock, isolationVerdict, resumePlan, scratchContract, steerVerdict } from "@lampgenie/runtime/agent/subagent-control";
import { PRIMARY_ONLY_TOOLS, convergeDeny, resumeSessionKey, spawnDepthVerdict } from "@lampgenie/runtime/agent/subagent-depth";
import { guardAskUserPayload, guardRouteNote, guardTerminalNotice } from "@lampgenie/runtime/agent/attention-budget";
import { generationOfEvent, wakeVerdict, type PendingNotification, type WakeCode } from "@lampgenie/runtime/task/idle-wake";
import { loadSoul, DEFAULT_SOUL_MD, MemoryStore } from "@lampgenie/runtime/agent/soul-memory";
import { loadAgentProfiles, formatAgentProfiles, composeSubagentInstructions, expandToolTokens, resolveProfileTools, toolGrantMatched } from "@lampgenie/runtime/agent/agent-profiles";
import { sessionSearchTool } from "../session-search.js";
import { SUBAGENT_READ_TOOLS, SUBAGENT_WRITE_TOOLS } from "../llm-loop-backend.js";
import type { SessionModelFace } from "../session-model.js";
import type { TaskProfile } from "@lampgenie/runtime/agent/task-profile";
import { makeCompactHook } from "../compact-hook.js";
import { autoCompactGate } from "../compact-gate.js";
import { attachToolView } from "../tool-view.js";
import { deliverFinalNotice, extractDeliverableText } from "../subagent-result-digest.js";
import { takePendingComments, renderPendingCommentsBlock } from "../board-comments.js";
import { planTaskSurface, degradeFinalFor, GUI_ONLY_TOOLS } from "../surface-capabilities.js"; // 表面/通道能力包
import { SOP_TIPS, sopTipText, renderStartProfileTip } from "../agent-wiring-sop-tips.js";
import { probeWorkStart, renderWorkStartBrief, verifyCommandsFor } from "../work-start-profile.js";
import { readBaselineStatus, planFreshnessSkip, planFreshnessAction, renderFreshnessLine, loadWordingTable, scanRuleWording, renderWordingLines } from "../startup-freshness.js";
import type { FreshnessConfig } from "../startup-freshness.js";
import { buildDefaultMicrocompactThreshold, DEFAULT_GROWTH_SPURT_TOKENS } from "@lampgenie/runtime/agent/microcompact";
import { bigResultEnabledFromEnv } from "@lampgenie/runtime/agent/big-intake";
import { readFilesOf, renderParentReadBlock } from "@lampgenie/runtime/agent/read-file-state";
import { renderSystemReminder } from "@lampgenie/runtime/agent/reminder-source";
import type { InjectGate } from "@lampgenie/runtime/agent/inject-gate";
import { shouldRecallMemory } from "@lampgenie/memory";
import { dynTipKeys, dynTipText, type DynSignals } from "../agent-wiring-dynamic-tips.js";
import { broadcastTraceStatsOf } from "../compact-hook.js";
import type { NodeRegistry, NodeDispatch } from "../nodes.js";
import { dispatchGuard } from "../nodes.js";
import { permissionRulesFromConfig, deriveChildRules, matchPermissionRule, evaluatePermission, type PermissionRule } from "@lampgenie/core";
import { loadRulesHot } from "../permission-store.js";
import {
  SessionAlwaysStore,
  evaluatePermission as evaluatePermissionGuard,
  type Guard,
  type PermissionEvaluation,
} from "@lampgenie/runtime/agent/permission-guard";
import { permissionMode } from "../permission-mode.js";
import { BUILTIN_COMMANDS } from "../command-catalog.js";
import {
  findIssuedEnvelope,
  recordCapabilitySurface,
  verifyEnvelope,
  type CapabilitySnapshot,
  type EnvelopeCurrent,
  type EnvelopeDeps,
  type EnvelopePolicy,
  type IssuedEnvelopeLookup,
} from "../task-envelope.js";
import { childPermission, currentPresetName, pinSession, resolveSessionPermission } from "../permission-presets.js";
import { createBrowserTool } from "../browser-tool.js";
import { createWebTools, resolveSearchRuntimeFromConfig } from "../web-tool.js";
import { createFileTools, fenceCommand } from "../file-tools.js";
import { createWaitUntilTool } from "../wait-until-tool.js";
import { teamTaskTool } from "../team-task-tool.js";
import { createCodeModeTool, type CodeModeJournal } from "../code-mode-tool.js";
import { checkImageSize, readImageSize } from "../image-size.js";
import { guardGitCommand, auditGitCommand, subagentGitBlockReason } from "../git-guard.js";
import { JobRegistry, TerminalSessionService, createJobTool, createTerminalTool } from "@lampgenie/terminal";
import { defaultWorktreeService, WorktreeError } from "../worktree-service.js";
import { readFileSync, existsSync, statSync, appendFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseDocFile, isDocExt } from "../doc-text.js";
import { createAcpBackend, type SubagentBackend } from "@lampgenie/executors";
import type { TaskSupervisor } from "../task-manager.js";
import { appendUserStoppedMarker } from "../user-stop-marker.js";
import type { Task } from "@lampgenie/core";
import { normalizeTaskKind, taskKindCapabilities, filterToolNamesByKindCapabilities, type TaskKindCapabilities } from "@lampgenie/runtime/task/task-kind";
import { setPlanDeps } from "@lampgenie/code-sense";
import { codeSenseTool } from "../sense-tool.js";
import {
  closeAuditVerdict,
  makeChangeSurfaceTool,
  readChangeAudit,
  readChangeSurfaceManifest,
  readChangeExempt,
  surfaceGateVerdict,
  type ChangeSurfaceJournal,
} from "../change-surface-tool.js";
import { readChangeScopeCorrection, type ChangeScopeCorrection } from "../change-scope-correction.js";
import { scanSurface } from "@lampgenie/code-sense/surface";
import type { ResidualFact } from "../closeout-residual.js";
import { computeVerifyLedger, renderVerifyLedgerWarning, renderVerifyRetryPrompt } from "../verification-ledger.js";
import { captureBaseline, computeChangeLedger } from "../turn-change-ledger.js";
import { computeGuidanceMetrics, tipMetricOf, type TipMetricSpec } from "../guidance-metrics.js";
import {
  makeDeliverableTool,
  readDeliverables,
  verifyDeliverables,
  renderDeliverables,
  renderDeliverableWarning,
  type DeliverableJournal,
} from "../deliverables.js";
import {
  makeCiteSourceTool,
  readCitations,
  auditCitations,
  shouldAuditCitations,
  renderCitationWarning,
  renderCitationRetryPrompt,
  type CitationJournal,
} from "../citation-ledger.js";
import { buildCompletionAudit, type CompletionFacts } from "../completion-audit.js";
import { runTaskCloseout, type CloseoutState } from "../task-closeout.js";
import { projectMainlineBlock } from "@lampgenie/code-sense/project-profile";
import { codeReview } from "@lampgenie/code-sense/review";
import { ExperienceStore, distillFromTask, mergeSkillIndex, mergeSkillIndexWith, builtinSkillBody } from "@lampgenie/experience";
import { disabledBuiltins } from "../skills-admin.js";
import { WorkflowEngine, type WorkflowCaps, type CapsPatch } from "@lampgenie/workflow";
import { OwnerRegistry, type OwnerUnit } from "@lampgenie/runtime/task/ownership";
import { WorkflowAssetStore, type WorkflowAsset, type WorkflowAssetScope } from "@lampgenie/workflow/asset-store";
import { renderTemplate } from "@lampgenie/workflow/templates";
import { join } from "node:path";
import { homedir } from "node:os";
import { rootScanVerdict } from "../sense-root-gate.js"; // 本文件 warmIndex 闸消费(2997)


// 开工 orient 注入链已整体删除:orientWithSense/symbolsInText/orient-cache 系列
// (scanFingerprint/orientCacheKey/readOrientCache/warmOrientCache)。每条 user message
// 跟一条「全局代码+历史匹配」tips 多余且常错配——code_sense 内容必须是拉取式(call 工具才返回);
export async function runWithAgent(
  tm: TaskSupervisor,
  journal: Journal,
  llm: LlmProvider,
  executor: SubagentBackend,
  task: Task,
  nodes?: NodeRegistry,
  models?: {
 compact?: LlmProvider; review?: LlmProvider; subagent?: LlmProvider; digest?: LlmProvider },
  nodeDispatch?: NodeDispatch,
  projects?: import("../projects.js").ProjectRegistry,
  permissionBroker?: import("../permission-broker.js").PermissionBroker,
  workflowAskRouter?: import("../workflow-ask-router.js").WorkflowAskRouter,
  askUser?: import("../ask-user-router.js").AskUserRouter,
  mcp?: { allToolsForAgent(): Promise<{ serverId: string; serverName: string; name: string; description: string }[]>; callTool(serverId: string, tool: string, args: unknown): Promise<string> },
  browserConfig?: { enabled: () => boolean; allowDomains: () => string[]; idleMinutes?: () => number; profile?: () => "persistent" | "ephemeral"; profileDir?: () => string; headless?: () => boolean },
  streamSink?: (sessionId: string, ev: AgentStreamEvent) => void,
 /** 取消信号注册表:wireAgentLoop 持有;runWithAgent 登记/注销本任务的 loop。 */
  activeLoops?: Map<string, AgentLoop>,
 /** 记忆接线。 */
  memory?: { contextBlock(ownerId: string): string; contextBlockFrozen?(ownerId: string): { block: string; hash: string; reused: boolean; revision?: string }; onSessionClose(input: { ownerId: string; sessionId: string; transcript: { role: "user" | "assistant"; content: string }[] }): Promise<void> },
 /** 辅助链专用轨( F2;压缩/导读不占 realtime 会话)。 */
  auxLlm?: LlmProvider,
 /** 任务配置对象(agent.maxSteps 热读;agent.compactThresholdTokens=无窗口时的显式压缩阈值,;
 * agent.subagentDeadlineMin/subagentStaleWarnMin=子代理时间盒与无产出预警, 机制1/3;
 * agent.writeBarrier=写前持久化屏障("off"|"hard";缺席=loop 内部 hard 现状;经 writeBarrierOf 取值,不读 env);
 * coding.lsp=编辑后 LSP 诊断+保存格式化。 */
  agentConfig?: { agent?: { maxSteps?: number; compactThresholdTokens?: number; subagentDeadlineMin?: number; plannerDeadlineMin?: number; subagentStaleWarnMin?: number; todoAllowParallelInProgress?: boolean; verifyOnStop?: string; writeBarrier?: "off" | "hard" }; coding?: { lsp?: import("@lampgenie/lsp").LspSettings; llm?: { vision?: boolean }; vlm?: { baseUrl?: string; providerId?: string; model?: string; apiKeyEnv?: string; timeoutMs?: number; maxTokens?: number } } },
 /** 主模型上下文窗口 tokens。 */
  contextWindow?: number,
 /** per-session 主模型覆盖面(缺省=无覆盖,共享 llm 现状零变化)。 */
  sessionModels?: SessionModelFace,
 /** 执行信封注入点(见 wireAgentLoop 同名字段)。 */
  envelopeDeps?: EnvelopeDeps): Promise<void> {
 // per-session 主模型覆盖(白板「per-session 主模型」):该会话有覆盖→派生独立 provider 实例
 // 供本任务全程使用(运行中任务持启动时引用);无覆盖→共享 llm 现状零变化。
 // 派生失败 fail-soft warn 回退共享 llm(模型选择失败不挂任务)。
 // m1:不仅主 llm,子代理/压缩/评审三个角色轨也跟随会话覆盖(deriveRoleModels 按
 // 「显式优先 > 会话覆盖 > 全局」合成 coding.models.<role>;显式配置的角色保留)。
 // m3:contextWindow 按会话模型元数据重算(找不到 meta 回退启动时注入的定值)。
  const sessionOverride = sessionModels?.resolve(task.sessionId);
  if (sessionModels && sessionOverride) {
    try {
      const derived = sessionModels.derive(task.sessionId, sessionOverride);
      if (derived) llm = derived;
      else console.warn(`[session-model] 会话 ${task.sessionId} 覆盖 ${sessionOverride.model} 派生失败,本任务回退共享 llm`);
      const roleModels = sessionModels.deriveRoleModels(task.sessionId, sessionOverride);
      if (roleModels) {
        models = {
          ...models,
          ...(roleModels.compact ? { compact: roleModels.compact } : {}),
          ...(roleModels.review ? { review: roleModels.review } : {}),
          ...(roleModels.subagent ? { subagent: roleModels.subagent } : {}),
          ...(roleModels.digest ? { digest: roleModels.digest } : {}),
        };
      }
      const ovWindow = sessionModels.contextWindowFor(sessionOverride);
      if (ovWindow !== undefined) contextWindow = ovWindow;
    } catch (err) {
      console.warn(`[session-model] 会话 ${task.sessionId} 覆盖派生异常(回退共享 llm):`, String(err).slice(0, 160));
    }
  }
 // 任务 kind 能力位。task 由旧构造点传入(核心 Task 无 kind 字段),故做防御式取用;
 // 未知/缺失 kind → 归一回落 user(全能力,normalized=false 可审计),默认路径逐字不变。
  const taskKindCarrier = task as unknown as { kind?: string; kindCapabilities?: TaskKindCapabilities };
  const taskKindInfo = normalizeTaskKind(taskKindCarrier.kind ?? "user");
  const taskKindCaps: TaskKindCapabilities = taskKindCarrier.kindCapabilities
    ?? taskKindCapabilities(taskKindInfo.kind).capabilities;
 // checkpoint 快照:执行前留工作区快照;GENIE_CHECKPOINT=off 跳过(测试提速)。
 // fixG1:sha 提升到本函数作用域——codeReviewTool 以它为 diff 基线(review 只审本任务变更集);
 // null(纯规划/干净树 stash-create 返回空/失败)→review 回退全仓未提交并在 summary 标注。
  let checkpointSha: string | null = null;
  if (process.env.GENIE_CHECKPOINT !== "off") {
 // 远端化:远程项目任务的快照走远端 git(通道;远端仓库才是被改的工作区)
    const cpProj = projects?.list().find((x) => x.id === task.projectId);
    const cpRemote = cpProj ? parseRemoteProject(cpProj.path) : null;
    if (cpRemote) {
      try {
        const rg = await remoteGit(cpRemote, ["stash", "create"]);
        if (!("error" in rg)) checkpointSha = rg.stdout.trim() || null;
      } catch { checkpointSha = null; }
      journal.append({ kind: "checkpoint.create", sessionId: task.sessionId, payload: { taskId: task.id, sha: checkpointSha, root: cpRemote.workspacePath, remote: true } });
    } else {
      const { checkpointCreate } = await import("../git-service.js");
      const root = projects?.resolveWorkdir(task.projectId) ?? repoRoot();
      try { checkpointSha = await checkpointCreate(root); } catch { checkpointSha = null; }
      journal.append({ kind: "checkpoint.create", sessionId: task.sessionId, payload: { taskId: task.id, sha: checkpointSha, root } });
    }
  }
 // 聊天史语义:用户消息入 journal——**单写归 loop.runTurn**(双份修复:
 // 此处原来的无条件追加叠加 loop 内部追加,同一轮 journal 两条 message.user,面板渲染两行且模型收到双份上下文)。
 // 仅「进不了 loop」的早退分支在此补记(否则失败史缺用户消息)。
  const recordUser = () => journal.append({ kind: "message.user", sessionId: task.sessionId, payload: { text: task.instruction, ...(task.attachments?.length ? { attachments: task.attachments } : {}) } });
 // 可达性分派守卫:与 executor 路径同语义。
  if (nodes) {
    const guard = dispatchGuard(nodes, { reachability: task.resourceTags });
    if (!guard.ok) {
      recordUser();
      const cur = tm.get(task.id);
      if (cur && (cur.state === "running" || cur.state === "blocked")) tm.setState(cur, "failed", guard.reason);
      return;
    }
    if (guard.note) {
      journal.append({ kind: "task.progress", sessionId: task.sessionId, payload: { taskId: task.id, dispatch: guard.note } });
    }
 // tunnel 委派:远端命中→任务书下发节点自己的执行器(不在本地跑 LLM 编排)。
    if (guard.node && guard.node.nodeId !== "local") {
      recordUser();
      const cur0 = tm.get(task.id);
      if (!nodeDispatch) {
        if (cur0 && (cur0.state === "running" || cur0.state === "blocked")) {
          tm.setState(cur0, "failed", `命中远端节点 ${guard.node.nodeId} 但委派通道未启用(不假装已派)`);
        }
        return;
      }
      const result = await nodeDispatch.delegate(
        { taskId: task.id, instruction: task.instruction, ...(task.credentialRef ? { credentialRef: task.credentialRef } : {}) },
        task.sessionId,
        { reachability: task.resourceTags },
      );
      if (!result.ok && result.error === "cancelled") return;
      const cur = tm.get(task.id);
      if (!cur || cur.state !== "running") return;
      if (result.ok) tm.setState(cur, "done", result.output ?? "");
      else tm.setState(cur, "failed", result.error ?? "委派失败");
      return;
    }
  }
 // 公网工具引用(装配顺序:spawn 工具先建、webTools 后建;子代理派发在 execute 期求值)。
  const webToolsRef: { value: Tool[] } = { value: [] };
 /** web.search 配置层热读:直读项目 genie.config.json 的 web.search 块,
 * 按 mtime 缓存——设置页保存即对下一次 web_search 生效,不需要重启/重建工具。
 * 不走 loadConfig 全量合并(那会连 user 层/env 一起算,这里语义=「项目级设置页写的值」)。 */
  type WebSearchCfg = { provider?: string; apiKeyEnv?: string; endpoint?: string; model?: string; disabled?: boolean };
  const webSearchCfgCache: { mtime: number; value: WebSearchCfg | null; providers: { id: string; apiKeyEnv?: string }[]; projectRoot: string } = { mtime: 0, value: null, providers: [], projectRoot: "" };
  const readWebSearchConfigHot = (root: string): WebSearchCfg | null => {
    const p = join(root, "genie.config.json");
    try {
      const st = statSync(p);
      if (root !== webSearchCfgCache.projectRoot || st.mtimeMs !== webSearchCfgCache.mtime) {
        const j = JSON.parse(readFileSync(p, "utf8")) as {
          web?: { search?: Record<string, unknown> };
          providers?: { id?: unknown; apiKeyEnv?: unknown }[];
        };
        const s = j?.web?.search;
        webSearchCfgCache.value = s && typeof s === "object" ? s as never : null;
 // 同一份 JSON 顺带取 providers[](只取 id/apiKeyEnv 引用名,不含 key 值):默认 DeepSeek
 // 需要知道 DeepSeek 端点用的是哪个密钥引用名,避免硬编码与用户在设置页改过的名字脱节。
        webSearchCfgCache.providers = (Array.isArray(j?.providers) ? j.providers : [])
          .filter((x) => x && typeof x.id === "string")
          .map((x) => ({ id: String(x.id), ...(typeof x.apiKeyEnv === "string" ? { apiKeyEnv: x.apiKeyEnv } : {}) }));
        webSearchCfgCache.mtime = st.mtimeMs;
        webSearchCfgCache.projectRoot = root;
      }
      return webSearchCfgCache.value;
    } catch {
      webSearchCfgCache.value = null;
      webSearchCfgCache.providers = [];
      webSearchCfgCache.projectRoot = root;
      return null;
    }
  };
 // 项目级根( code-sense/review 是 vibe coding 轨的项目级能力,每个项目不同):
 // 任务带 projectId→项目根;无项目/项目不可用回退 harness 根。此前 code_sense/orient/review
 // 全钉在 harness 根(登记边界「workflow/code_sense 根仍 harness」的)。
  const taskRoot = projects?.resolveWorkdir(task.projectId) ?? repoRoot();
 // 远程项目工具三件(ZCode remote workspace 业务切片):任务归属 remote:ssh 项目时
 // 注入 remote_ls/remote_read/remote_exec——本地文件工具围栏在 harness 回退根,远程目录经
 // SSH 层操作(路径围栏=项目 workspacePath;exec 权限类别 remote.exec 走审批闸)。
 // 本任务的远程项目(SSH/WSL;后续 code_sense/code_review 也据此路由到远端运行时)
  const taskRemoteProject = (() => {
    const proj = projects?.list().find((x) => x.id === task.projectId);
    return proj ? parseRemoteProject(proj.path) : null;
  })();
  const remoteProjectTool = (() => {
    const remote = taskRemoteProject;
    if (!remote) return null;
    const wsq = shQuote(remote.workspacePath);
 // 远程项目任务的工具套件 = **本地同名七件**(read_file/write_file/edit_file/glob/
 // grep/list_dir + run_cmd 语义的 exec),效应真实落在远端仓库——模型零学习成本(工具名/参数
 // 与本地一致),上下游闭环(改的就是用户看到的远端文件)。
    const lsTool: Tool = {
      name: "list_dir",
      description: "列出一个目录的直接子项([d] 目录/[f] 文件)。路径必须是项目相对路径。",
      parameters: { type: "object", properties: { path: { type: "string", description: "目录路径(项目相对;缺省项目根)" } } },
      isConcurrencySafe: () => true, isReadOnly: () => true,
      async execute(args: unknown) {
        const a = (args ?? {}) as { path?: string };
        const r = await remoteLs(remote, String(a.path ?? ""));
        if ("error" in r) return "错误:" + r.error;
        return r.entries.map((e) => (e.kind === "dir" ? "[d] " : "[f] ") + e.name).join("\n") + (r.truncated ? "\n(条目超 500 截断)" : "") || "(空目录)";
      },
    };
    const readTool: Tool = {
      name: "read_file",
      description:
        "读取项目内一个文本文件,返回带行号的内容(行号用于后续 edit_file 定位)。" +
        "路径必须是项目相对路径。大文件用 offset(1-based 起始行)分窗读;二进制文件拒绝读取。" +
        "同时要看多个文件(或多个区间)就在同一步并发发多条 read_file(本工具无状态),别一步只读一个文件。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径(项目相对路径;一次一个文件,多文件请同一步并发多条调用)" },
          offset: { type: "number", description: "起始行号(1-based)。只在文件过大需要分窗读时提供" },
          limit: { type: "number", description: "读取行数" },
        },
        required: ["path"],
      },
      isConcurrencySafe: () => true, isReadOnly: () => true,
      async execute(args: unknown) {
        const a = (args ?? {}) as { path?: string; offset?: number; limit?: number };
        const r = await remoteReadWindow(remote, String(a.path ?? ""), a.offset ? Number(a.offset) : undefined, a.limit ? Number(a.limit) : undefined);
        if ("error" in r) return "错误:" + r.error;
        return r.content + `\n(第 ${r.startLine}-${Math.min(r.totalLines, r.startLine + 40) - 1} 行/共 ${r.totalLines} 行;继续读用 offset=${Math.min(r.totalLines, r.startLine + 40)})`;
      },
    };
    const writeTool: Tool = {
      name: "write_file",
      description: "整文件写入(自动建父目录;≤1MB)。覆写已存在文件前先 read_file 确认现状。",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      isConcurrencySafe: () => false, isReadOnly: () => false,
      async execute(args: unknown) {
        const a = (args ?? {}) as { path?: string; content?: string };
        const r = await remoteWrite(remote, String(a.path ?? ""), String(a.content ?? ""));
        if ("error" in r) return "错误:" + r.error;
        return "已保存 " + a.path;
      },
    };
    const editTool: Tool = {
      name: "edit_file",
      description: "精确字面替换编辑(old_string 与文件内容逐字匹配;缺省要求唯一,不唯一报命中数;replace_all 全替;old===new 拒绝)。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean", description: "全部替换(缺省仅唯一匹配)" },
        },
        required: ["path", "old_string", "new_string"],
      },
      isConcurrencySafe: () => false, isReadOnly: () => false,
      async execute(args: unknown) {
        const a = (args ?? {}) as { path?: string; old_string?: string; new_string?: string; replace_all?: boolean };
        if (!a.old_string || a.old_string === a.new_string) return "错误:old_string 为空或与 new_string 相同";
        const r = await remoteEdit(remote, String(a.path ?? ""), a.old_string!, a.new_string!, a.replace_all === true);
        if ("error" in r) return "错误:" + r.error;
        return "已编辑 " + a.path + "(替换 " + r.replaced + " 处)";
      },
    };
    const globTool: Tool = {
      name: "glob",
      description: "按模式匹配项目内文件(* 同层,** 跨目录;按修改时间新→旧排序)。",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string", description: "如 src/**/*.ts 或 *.md" } },
        required: ["pattern"],
      },
      isConcurrencySafe: () => true, isReadOnly: () => true,
      async execute(args: unknown) {
        const a = (args ?? {}) as { pattern?: string };
        const r = await remoteGlob(remote, String(a.pattern ?? "*"));
        if ("error" in r) return "错误:" + r.error;
        return r.files.join("\n") || "(无匹配)";
      },
    };
    const grepTool: Tool = {
      name: "grep",
      description: "内容检索(content 模式带 相对路径:行号;正则)。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "正则或字面串" },
          path: { type: "string", description: "目录(项目相对;缺省项目根)" },
        },
        required: ["pattern"],
      },
      isConcurrencySafe: () => true, isReadOnly: () => true,
      async execute(args: unknown) {
        const a = (args ?? {}) as { pattern?: string; path?: string };
        const ch = await tryChannelJson(remote, "fs.grep", { dir: a.path ?? ".", pattern: String(a.pattern ?? "") });
        if (ch && ch.ok) {
          const data = ch.data as { matches: string[]; truncated?: boolean };
          return (data.matches || []).join("\n") + (data.truncated ? "\n(截断)" : "") || "(无匹配)";
        }
        const r = await remoteRun(remote, `grep -rn -I ${shQuote(String(a.pattern ?? ""))} ${wsq} 2>/dev/null | sed "s|^${remote.workspacePath}/||" | head -n 200`, {});
        if (!r.ok) return "错误:" + (r.error ?? "grep 失败");
        return r.stdout || "(无匹配)";
      },
    };
    const execTool: Tool = {
      name: "run_cmd",
      description: "在项目工作区执行一条 shell 命令(cwd=项目根;输出≤512KB;长驻进程用 nohup)。远程项目任务的重操作走这里。",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "要执行的命令" } },
        required: ["command"],
      },
      isConcurrencySafe: () => false, isReadOnly: () => false,
      async execute(args: unknown) {
        const a = (args ?? {}) as { command?: string };
        const cmd = String(a.command ?? "").trim();
        if (!cmd) return "错误:command 为空";
 // workspace(工作区内)命令围栏下沉到远程:与本地 run_cmd 同口径,围栏根=远端 workspacePath。
 // 注意:路径判定用纯字符串前缀比较(远端路径不在本地解析);Windows 远端盘符路径可能因大小写/分隔符
 // 差异误判——如实登记的能力边界,不影响 Linux/WSL 远端。非 workspace 档 fenceCommand 内部即早退。
        const fenced = fenceCommand(cmd, remote.workspacePath);
        if (fenced) return "错误:" + fenced + "(workspace 模式只允许操作项目目录内的文件;需要越界请在完全访问模式执行)";
 // git 破坏命令硬拦(g1:子代理远程 run_cmd 同样不许 git 写/破坏(git stash 注意事故)。
 // 远程路径不本地解析,但命令文本是同一份→解析后子命令判定与本地同口径。
 // 作用域说明:本 execTool 是 remoteProjectTool 的一部分,只并入主 agent 的 mainTools(5052),
 // 子代理不经此路径执行 shell(子代理 run_cmd = llm-loop-backend workerWriteTools,已在源头硬拦)
 // ——故此处按「主 agent 不受限但审计」处理(11-05 事故复盘要求谁动了工作树可对账)。
        auditGitCommand(journal, task.sessionId, cmd);
        const r = await remoteExec(remote, cmd);
        if ("error" in r) return "错误:" + r.error;
        return (r.stdout || "(无输出)") + (r.truncated ? "\n…(截断)" : "");
      },
    };
    return [lsTool, readTool, writeTool, editTool, globTool, grepTool, execTool];
  })();
 // 板存储根(板根错位根治):repoRoot 是**唯一**板存储根——board_upsert/board_read
 // 的写盘根(storeRoot 缺省=repoRoot)、面板 board.load(boardRoot) 都在这;taskRoot 只用于
 // 代码类工具(code_sense/review/文件围栏)。任务 projectId 指向非 harness 项目时
 // taskRoot≠repoRoot,闸门若按 taskRoot 读板将永远读不到自己刚写的板 → 同一 reason 反复拒绝死循环。
  const boardStoreRoot = repoRoot();
 /** 读本任务板:主根(boardStoreRoot=写盘根)优先,读不到再回退 taskRoot(多根容忍,兼容历史
 * 落在项目根的板);两者都无才算「无板」。 */
 /** 最近一次读板的命中根(诊断用:区分「主根命中」「回退命中」「都没命中」)。 */
  let lastBoardReadRoot: "store" | "task" | "none" = "none";
  const readTaskBoard = async (): Promise<ReturnType<typeof loadBoardSync>> => {
    lastBoardReadRoot = "none";
    try {
      const primary = await loadBoardAsync(boardStoreRoot, task.sessionId, task.id);
      if (primary) { lastBoardReadRoot = "store"; return primary; }
    } catch { /* 主根读异常走回退 */ }
    if (taskRoot === boardStoreRoot) return null;
    try {
      const fallback = await loadBoardAsync(taskRoot, task.sessionId, task.id);
      if (fallback) { lastBoardReadRoot = "task"; return fallback; }
      return null;
    } catch { return null; }
  };
 /** q4 子写者独立板「在场」探测(只给 plan-gate 用,不进 P0 计分):
 * planner 以 scope 落板后,规划契约在 `.genie/boards/<sid>/<taskId>-<scope>.json`,
 * 主任务板可能根本不存在——plan-gate 的判据是「本任务有规划契约在场」,它必须能看见
 * planner 的独立板,否则闸门永远拒(死循环)。只探测本 taskId 的分区板(`<taskId>-*`),
 * 不跨任务;且**不**参与 P0 覆盖率/收尾校验(那些只认同一个写者的板=本任务的板)。 */
  const hasPartitionBoard = async (): Promise<boolean> => {
    for (const root of [boardStoreRoot, taskRoot]) {
      try {
        const items = (await listBoardsExAsync(root, task.sessionId)).items;
        if (items.some((i) => i.taskId.startsWith(`${task.id}-`))) return true;
      } catch { /* 探测失败按无分区板处理 */ }
    }
    return false;
  };
 // 静态调用索引预热(三改:提前生成,不点哪个查哪个;fire-and-forget,首次 1-2 分钟后台)。
 // 预算闸:超预算根(如工作区根)冷构建经验证 7 分钟后 SIGABRT 且反复重 fork——
 // 闸拒绝后不预热(fork worker 侧另有失败冷却,这里是入口侧省掉注定失败的构建)。
  void (async () => {
    try {
      const verdict = await rootScanVerdict(taskRoot);
      if (!verdict.ok) return;
      const m = await import("../sense-index-manager.js"); m.warmIndex(taskRoot);
    } catch { /* 预热失败容忍 */ }
  })();

 // 机制3:无产出预警阈值——task_output stale 标记的判定窗(进程内后端的 [warn] 行同源配置)。
  const staleWarnMs = Math.max(Number(agentConfig?.agent?.subagentStaleWarnMin ?? 20) * 60_000, 250);

 // 上下文治理(子代理与 coding agent 同源):同一 compactHook / microcompact 实例
 // 既喂主 loop 也喂 spawn 出的子 loop。此前子 loop 永不压缩——长子代理随着工具结果累积
 // 无界增长上下文,与主 agent(有阈值压缩)完全是两套工作模式。
 // effort 档位(四档联动):从 provider describe 读(热更新后读新值),
 // xhigh=窗口口径;low/medium/high 阈值×0.35/0.55/0.75 提前压缩。
  const mainEffort = (() => { try { const d = (llm as { describe?: () => { reasoningEffort?: string } }).describe; return typeof d === "function" ? d.call(llm)?.reasoningEffort : undefined; } catch { return undefined; } })();
  const taskMicrocompact = {
    thresholdTokens: buildDefaultMicrocompactThreshold(autoCompactGate([], "",
      contextWindow,
      Number((agentConfig as { agent?: { compactThresholdTokens?: number } } | undefined)?.agent?.compactThresholdTokens ?? 0) || 0,
      mainRequestMaxTokens(llm), mainEffort).threshold),
  };
 // 增长突增阈值(Phase 0):单步新增 ≥ 此值 → 本步激进组清理。缺省 12k;agent.growthSpurtTokens=0 关闭。
  const taskGrowthSpurtTokens = Math.max(0,
    Number((agentConfig as { agent?: { growthSpurtTokens?: number } } | undefined)?.agent?.growthSpurtTokens ?? DEFAULT_GROWTH_SPURT_TOKENS) || 0);
 // 写时定形 spill(2026-11 token 轮 02):超阈工具结果在**进历史之前**落盘定形(头+标记+尾+路径),
 // 之后永不改写——旧口径是读时每步改写历史中段,提示前缀逐字变化 → prompt cache 全量失效
 // (经验证 uncached 单价 = 命中的 50 倍)。主 loop 与 spawn 出的子 loop 同源注入(spill 目录同根,
 // 按各自 sessionId 分子目录),否则长子代理照旧打碎缓存。
  const taskSpill: import("@lampgenie/runtime/agent/loop").AgentLoopOptions["spill"] = {
    dir: join(repoRoot(), ".genie", "spill"),
  };
 // 上下文模型评分(Phase 1/2):默认来自 config.context.modelScoring(本地 150M Jev)。
 // 未配置 agentConfig(测试/旧装配)=undefined,loop 不发起评分请求。
  const taskModelScoring = (agentConfig as {
    context?: { modelScoring?: import("@lampgenie/runtime/agent/loop").AgentLoopOptions["modelScoring"] };
  } | undefined)?.context?.modelScoring;
 // 大结果「智能入上下文」闸门:入口侧控增量。命中闸的工具结果不再走 spill
 // ——先切块让本地 8105 判相关性(±小模型四段摘要),全文落 .genie/tool-dumps,上下文只放摘要+指针。
 // 与 spill 同源装配:主 loop 与 spawn 子 loop 共用,否则长子代理照旧把大结果整段灌进去。
  const taskBigIntakeDumpDir = join(repoRoot(), ".genie", "tool-dumps");
  const bigIntakeDigestLlm = models?.digest ?? models?.compact ?? auxLlm;
 // 提炼模型优先(digest→compact→aux),**不**回落主模型。
  const taskBigIntake: import("@lampgenie/runtime/agent/loop").AgentLoopOptions["bigIntake"] = {
    enabled: bigResultEnabledFromEnv(),
    dumpDir: taskBigIntakeDumpDir,
 // 提炼外层超时:qwen3.7-flash 对 12k 字符 diff 经验证 53.4s,旧 20s 默认值在真实
 // 模型上必杀(生产 journal:digestChars=0 + policy=fallback)。给 120s(≈2x 余量);
 // 外层 abort 只兜「挂死」,provider 自身超时照旧生效。
    digestTimeoutMs: 120_000,
 // 复用 model-scoring 的 client/批量面(同一 8105 /decide);未配置=确定性兜底(头尾+命中行)。
    ...(taskModelScoring ? { scorer: taskModelScoring } : {}),
 // 小模型轨:只认 compact/aux(**不**回落到主模型——摘要不该花主模型的钱);未配置=不硬造摘要。
    ...(bigIntakeDigestLlm
      ? {
          digest: async (prompt: string, opts: { timeoutMs: number }) => {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
            try {
              const r = await bigIntakeDigestLlm.chat([{ role: "user", content: prompt }], [], ac.signal);
              return String(r?.content ?? "");
            } finally { clearTimeout(timer); }
          },
        }
      : {}),
  };
 //  压缩后正文补回配置(agent.compactRehydrate):每次压缩执行时经 getter 读,配置热改即时生效。
  const taskCompactRehydrate = (agentConfig as { agent?: { compactRehydrate?: import("../compact-rehydrate.js").CompactRehydrateConfig } } | undefined)?.agent?.compactRehydrate;
  const taskCompactHook = makeCompactHook({
    contextWindow,
    maxOutputTokens: mainRequestMaxTokens(llm),
    explicitThreshold: Number((agentConfig as { agent?: { compactThresholdTokens?: number } } | undefined)?.agent?.compactThresholdTokens ?? 0) || 0,
    ...(mainEffort ? { reasoningEffort: mainEffort } : {}),
    ...(taskCompactRehydrate ? { compactRehydrate: taskCompactRehydrate } : {}),
    microcompact: taskMicrocompact,
    compactLlm: models?.compact ?? auxLlm ?? llm,
    expLlm: models?.compact ?? auxLlm ?? llm,
    devlogDir: join(repoRoot(), "devlog"),
    taskId: task.id,
    fallbackInstruction: task.instruction,
    store: getExperienceStore(),
 // 看板刷新桥(2026-11):自动压缩成功→推一帧 trace.stats(主 loop 与 spawn 子 loop 共用本实例)。
    onCompacted: (r) => { void broadcastTraceStatsOf()?.(r.sessionId); },
 // 摘要前缀复用:摘要请求复用主会话的 system 与 wire 广告工具面,命中 provider prompt cache。
 // systemWithMemory/surfacePlan 在本函数后半段才定义(loop 装配顺序所迫),故用 getter 在压缩
 // 执行时读——压缩只可能发生在 loop 启动之后,那时两者已初始化(TDZ 不会触发);装配期异常
 // 也只会让 getter 抛错 → autoCompact 退回旧路径,压缩不失败。
    prefix: () => ({ system: systemWithMemory, tools: surfacePlan.tools }),
  });

 // 父子 ask-answer:任务级 broker——子代理重操作(build/install/全量测试/递归批处理)申请
 // 路由给父 agent 决策(旧链路的子代理 ask 只到面板或静默拒绝,父 agent 从不参与)。
 // 两条通道共用一个 broker:①注入——结构化问题块(message.user)进父 journal,父 loop 下一 step 可见;
 // ②决策泵——driveParentDecision 直驱父 LLM 做 mini-turn 裁决(父 loop 阻塞在 spawn 工具内时唯一
 // 可达通道;父 loop 若先经 answer_subagent 应答,泵的应答幂等落空)。问答全程落父 journal
 // (custom subagent.heavy-ask/-answer),审批结果以 message.system 回灌会话(面板/模型都可见)。
  const parentAskBroker = new ParentAskBroker({ journal, sessionId: task.sessionId });
  parentAskBroker.onPending = () => {
 // token 治理(注意 2.7M token/日=注入总量 39.6%):不再把审批块以
 // message.user 永久落 journal——已了结的请求块会被 deriveMessages 无限重放,还诱导模型
 // 应答已结束的请求(「无此待决请求」空转白烧往返)。改为 AgentLoop.pendingQuestions
 // ephemeral 注入(下方):待决期间逐步可见,了结即消失;审计链(custom heavy-ask/-answer
 // + message.system 回灌)不变,面板可见性不受影响。
    void driveParentDecision(parentAskBroker, llm).catch(() => { /* 泵失败=超时 fail-closed 兜底 */ });
  };
  parentAskBroker.onSettled = (a, q) => {
    try {
      journal.append({ kind: "message.system", sessionId: task.sessionId, payload: { text: `[重操作审批] 子代理 ${q.taskId} 申请 [${q.match.category}] \`${q.command.slice(0, 80)}\` ${a.approved ? "已批准" : "被拒绝"}(${a.by}${a.reason ? ";" + a.reason : ""})` } });
    } catch { /* 通知失败不影响应答 */ }
  };

 // plan-gate:
 // 注意——活跃 session 均未走 planner(planner 委托/先骨架后丰满/防目标丢失全在提示词层,
 // flash 档模型不遵守),而板的落板门/门因「从未落板」根本没被触发。本闸门把入口代码化:
 // **写角色子代理派发与主 agent 写文件,均需本任务白板(规划契约)在场**——板由 planner 落
 // (board_upsert),带 P0 验收(落板门已拦缺验收);此后骨架→丰满的推进与由
 // boardReminder(每 10 步 P0 再锚定)+门(done 必须证据全绿)+下方收尾校验三段追踪。
 // 模式:hard(缺省,硬拦)/soft(只 journal 提醒不拦)/off。全程 journal 留痕可回放审计。
 // 优先级 env > config > hard:GENIE_PLAN_GATE=off/soft/hard——基础设施类测试
 // (reaper/worktree/会话纪律等,不涉及规划流程)与应急场景显式豁免,不必逐个硬造板+阶段声明。
  const planGateMode = String(process.env.GENIE_PLAN_GATE ?? (agentConfig?.agent as { planGate?: string } | undefined)?.planGate ?? "hard");
 // 任务类别(理解阶段定类,后续 tips/plan-gate 全消费同一结果):
 // 初判=启发式(classifyTaskClass,开工即出);agent 在 understand 用 task_phase(taskClass=...)
 // 更正,更正即刻生效(plan-gate 恢复/收紧、每10步锚与后续轮次按新类走)。
  const taskClassState: { value: TaskClass } = { value: classifyTaskClass(task.instruction) };
 // 直达实施路由:理解阶段判定「明确具体的小改」→ implement(route=direct) →
 // plan-gate 尺度豁免;落板(board_upsert)即自然回归全流程(闸门在有板时本就放行)。
  const taskRouteState: { direct: boolean } = { direct: false };
  try {
    journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "task.class", taskId: task.id, taskClass: taskClassState.value, source: "heuristic" } });
  } catch { /* 留痕失败不影响执行 */ }
 // ── 任务档案(profile):按类别解析装配策略 ───────────────────────────────
 // 显式档案来自任务 idempotencyKey 前缀 `profile:<id>:`(有则优先;否则按 taskClass 解析,再退 "*")。
 // 档案文件缺失/坏 JSON/无匹配 = 零行为变化;显式 id 不存在/档案非法 = fail-closed 回退默认(不挂任务)。
 // 消费面:工具 allow/deny(装配后过滤)、effectiveMaxSteps(loop 与执行信封同源)、skills allow(技能索引过滤)、
 // model(复用会话模型派生面;派生失败 warn 回退共享 llm)、presetRevision(只记录)。
  const explicitProfileId = (() => {
    const key = task.idempotencyKey;
    const m = typeof key === "string" ? /^profile:([a-z0-9][a-z0-9._-]{0,63}):/.exec(key) : null;
    return m?.[1];
  })();
  let taskProfile: TaskProfile | undefined;
  const baseMaxSteps = agentConfig?.agent?.maxSteps ?? 3000; // 设置页热读口径不变(档案覆盖才改)
  let effectiveMaxSteps = baseMaxSteps;
  try {
    const profileStore = await import("../task-profile-store.js");
    const loaded = await profileStore.loadTaskProfiles(repoRoot());
    if (!loaded.ok) {
 // 坏 JSON/IO:整份档案面不可用 → 回退默认,只留痕(不阻断任务)。
      try {
        journal.append({ kind: "custom", sessionId: task.sessionId, payload: { what: "task.profile", type: "task.profile", taskId: task.id, ok: false, code: loaded.code, profileId: explicitProfileId ?? null, taskClass: taskClassState.value, note: loaded.error ?? "档案文件不可用,回退默认" } });
      } catch { /* 留痕失败不影响执行 */ }
    } else if (loaded.profiles.length > 0 || explicitProfileId) {
      const resolved = await profileStore.resolveTaskProfileAt(repoRoot(), {
        taskClass: taskClassState.value,
        ...(explicitProfileId ? { profileId: explicitProfileId } : {}),
      });
 // journal 形状按任务书口径(what/applied):null=档案未设该项,[]=未声明,不臆造生效。
      const applied: Record<string, unknown> = resolved.profile
        ? {
            maxSteps: typeof resolved.profile.maxSteps === "number" ? resolved.profile.maxSteps : null,
            toolsAllow: resolved.profile.tools?.allow ?? [],
            toolsDeny: resolved.profile.tools?.deny ?? [],
            skillsAllow: resolved.profile.skills?.allow ?? [],
            model: resolved.profile.model ?? null,
            presetRevision: resolved.profile.presetRevision ?? null,
          }
        : {};
      if (resolved.ok && resolved.profile) {
        const profile = resolved.profile;
        taskProfile = profile;
        if (typeof profile.maxSteps === "number") effectiveMaxSteps = profile.maxSteps;
 // 模型面:profile.model 存在 → 合成 SessionModelOverride 走会话模型派生面(档案优先于会话覆盖)。
        let modelApplied = false;
        if (profile.model) {
          if (sessionModels) {
            try {
              const override = {
                model: profile.model.model,
                ...(profile.model.providerId !== undefined ? { providerId: profile.model.providerId } : {}),
                ...(profile.model.effort !== undefined ? { effort: profile.model.effort } : {}),
              };
              const derived = sessionModels.derive(task.sessionId, override);
              if (derived) {
                llm = derived;
                modelApplied = true;
              } else {
                console.warn(`[task-profile] 档案 ${profile.id} 模型 ${profile.model.model} 派生失败,回退共享 llm`);
              }
              const roleModels = sessionModels.deriveRoleModels(task.sessionId, override);
              if (roleModels) {
                models = {
                  ...models,
                  ...(roleModels.compact ? { compact: roleModels.compact } : {}),
                  ...(roleModels.review ? { review: roleModels.review } : {}),
                  ...(roleModels.subagent ? { subagent: roleModels.subagent } : {}),
                  ...(roleModels.digest ? { digest: roleModels.digest } : {}),
                };
              }
              const ovWindow = sessionModels.contextWindowFor(override);
              if (ovWindow !== undefined) contextWindow = ovWindow;
            } catch (err) {
              console.warn(`[task-profile] 档案 ${profile.id} 模型派生异常(回退共享 llm):`, String(err).slice(0, 160));
            }
          }
        }
        try {
          journal.append({
            kind: "custom",
            sessionId: task.sessionId,
            payload: {
              what: "task.profile",
              type: "task.profile",
              taskId: task.id,
              ok: true,
              code: resolved.code,
              profileId: profile.id,
              taskClass: taskClassState.value,
              ...(resolved.reason ? { reason: resolved.reason } : {}),
              applied,
              modelApplied,
              effectiveMaxSteps,
            },
          });
        } catch { /* 留痕失败不影响执行 */ }
      } else {
 // NOT_FOUND / NO_MATCH / INVALID:fail-closed 回退默认,留痕供审计。
        try {
          journal.append({
            kind: "custom",
            sessionId: task.sessionId,
            payload: {
              what: "task.profile",
              type: "task.profile",
              taskId: task.id,
              ok: false,
              code: resolved.code,
              profileId: explicitProfileId ?? resolved.profile?.id ?? null,
              taskClass: taskClassState.value,
              ...(resolved.reason ? { reason: resolved.reason } : {}),
              ...(resolved.issues ? { issues: resolved.issues.slice(0, 8) } : {}),
              applied: {},
            },
          });
        } catch { /* 留痕失败不影响执行 */ }
      }
    }
  } catch (err) {
 // 档案装配自身异常(模块解析/IO):warn 后回退默认,不挂任务。
    console.warn(`[task-profile] 档案装配失败(回退默认):`, String(err).slice(0, 160));
  }
 // 板根对齐(修正):此前注释说「board_upsert 写盘用 taskRoot」与代码不符——board_upsert
 // 实际写盘根 = storeRoot ?? repoRoot(mainTools 只传 4 参 → storeRoot=undefined → repoRoot),
 // 面板 board.load 也是 repoRoot。故 repoRoot 才是唯一板存储根;按 taskRoot 读板在
 // 「任务 projectId 指向非 harness 项目」(taskRoot≠repoRoot)时永远读不到 → plan-gate 死循环。
 // readTaskBoard:主根 boardStoreRoot 优先,taskRoot 回退(多根容忍)。
  const planBoard = () => readTaskBoard();
  let planGateAnnounced = false; // 放行事件只落一次(无→有翻转变动留痕)
  let planGateDirectAnnounced = false; // 直达路由豁免留痕一次
  let phaseAutoAdvancedAnnounced = false; // 阶段门自动推进只落一次
 // 逃生阀计数:只统计「无板」这一类拒绝(阶段门不计数)。注意:板根错位时闸门
 // 永远读不到板,模型收到同一句模板话术 5 次、反复重试仍无法脱困 → 同因第 3 次降级放行。
  let planGateDenies = 0;
  const PLAN_GATE_DENY_LIMIT = 3;
 // 全链路变更门的独立计数:与「无板」同档逃生阀,但独立计数——两类拒绝同因不同,
 // 混计会让「缺盘点」把「缺板」的额度吃掉,症状变成闸门突然静默放行。
  let surfaceGateDenies = 0;
 // :本会话最新一条分类更正(`change.surface action=classify` 落 journal)。
 // 按 journal 水位缓存:水位没变就不重读会话事件(避免每次写操作前全扫);读到结构坏的事件由
 // readChangeScopeCorrection 自己跳过 → null,gate 回落到旧启发式(未更正=旧行为逐字不变)。
  let scopeCorrectionCache: { watermark: number; value: ChangeScopeCorrection | null } | null = null;
  const currentScopeCorrection = (): ChangeScopeCorrection | null => {
    const watermark = journal.length;
    if (scopeCorrectionCache && scopeCorrectionCache.watermark === watermark) return scopeCorrectionCache.value;
    let value: ChangeScopeCorrection | null = null;
    try {
      value = readChangeScopeCorrection(journal.readSession(task.sessionId), task.sessionId);
    } catch { value = null; }
    scopeCorrectionCache = { watermark, value };
    return value;
  };
 /** 本任务的全链路变更判据(阶段回执/收尾摘要共用;hasManifest/exempt/hasChain 恒真=只取 scope,不产生拒绝)。 */
  const surfaceScopeThisTask = () =>
    surfaceGateVerdict({ taskClass: taskClassState.value, instruction: String(task.instruction ?? ""), hasManifest: true, exempt: true, hasChain: true, correction: currentScopeCorrection() ?? undefined });
 // 规划委托判据:
 // 本任务是否派过 planner(含被权限拦下的尝试——尝试过即允许降级内联,以免 planner 不可用时死锁)。
 // 旧实现只靠提示词,flash 档主 agent 会把 6 节点设计板内联画成流程图并直接实施;这里把
 // 「大板必须由 planner 落」变成写操作硬闸(≤3 节点轻量板仍允许主 agent 内联)。
  let plannerSpawnedThisTask = false;
  let plannerGateDenies = 0;
  const PLANNER_GATE_DENY_LIMIT = 2;
 // 豁免留痕判据(用户拍板「office 走硬闸 + 豁免留痕」,不是软提醒):本任务是否经
 // board_upsert 传 exemptReason 显式声明过「确实没有开发内容/表达结构」。与 plannerSpawnedThisTask
 // 同级=只在本任务进程内有效;board 不落盘,只落 journal board.exempt(禁止静默豁免)。
  let boardExemptThisTask = false;
  const planGateBlock = async (tool: string, actor: string): Promise<string | null> => {
    if (planGateMode === "off") return null;
 // 任务类别分流(起; 收紧 office):qa=问答/调研免板直放;office=办公/产出类
 // 走硬闸(必须有作业思路板 composition 或显式豁免);coding=内容板判据。agent 用
 // task_phase(taskClass=...) 更正类别时本闸即刻按新类裁决。
    if (taskClassState.value === "qa") return null;
 // 全链路变更硬门( 「用户只描述意图,harness 自动找出该意图涉及的所有链路
 // 节点…一次性全部改到一致,并证明没有残留」):指令含替换/迁移/改名词(coding 类)时,写操作
 // 前必须有本任务 change.surface 盘点清单(journal 事实,不是提示词自述)——否则「只改 UI 就交差」
 // 仍能过闸。exempt 通道:board_upsert exemptReason 或 change_surface action=exempt(理由必填)。
 // 清单只回读一次(链路图轮):hasManifest 与 hasChain 同源,避免两次读 journal 后口径分叉。
    const surfaceManifest = readChangeSurfaceManifest(journal, task.sessionId, task.id);
    const surfaceVerdict = surfaceGateVerdict({
      taskClass: taskClassState.value,
      instruction: String(task.instruction ?? ""),
      hasManifest: surfaceManifest !== null,
      hasChain: surfaceManifest ? surfaceManifest.chain !== undefined : undefined,
      exempt: boardExemptThisTask || readChangeExempt(journal, task.sessionId, task.id) !== null,
      directRoute: taskRouteState.direct,
 // :显式更正优先于启发式(合法才覆盖;null=旧行为逐字不变)。
      correction: currentScopeCorrection() ?? undefined,
    });
    if (surfaceVerdict.deny) {
      surfaceGateDenies += 1;
      const attempt = surfaceGateDenies;
 // 逃生阀同「无板」档:同因第 3 次降级放行(闸门自身异常不该把任务钉死),留痕说明降级。
      const escalated = attempt >= PLAN_GATE_DENY_LIMIT;
 // rule 按原因区分(链路图轮):缺链路图是独立判据,留痕要能和缺盘点分开统计。
      const gateRule = surfaceVerdict.reason === "no-chain-map" ? "plan-gate/change-chain" : "plan-gate/change-surface";
      if (!escalated || attempt === PLAN_GATE_DENY_LIMIT) {
        try {
          journal.append({
            kind: "permission.gate", sessionId: task.sessionId,
            payload: {
              tool, effect: escalated ? "escalated" : "denied", by: "plan-gate",
              hint: surfaceVerdict.hint, reason: surfaceVerdict.reason, rule: gateRule,
              decisionBy: "plan-gate", taskId: task.id, matched: surfaceVerdict.matched, attempt,
            },
          });
        } catch { /* 留痕失败不影响拦截 */ }
      }
      if (!escalated) {
        return JSON.stringify({
          status: "rejected",
 // 两种原因都保留 `plan-gate(全链路变更)` 前缀(既有断言与话术一致性都靠它)。
          reason: surfaceVerdict.reason === "no-chain-map"
            ? `plan-gate(全链路变更):${actor}被拦——本任务已有变更面盘点,但缺链路图(旧清单/手造清单)。`
            : `plan-gate(全链路变更):${actor}被拦——指令含替换/迁移动词(${surfaceVerdict.matched.join("/")}),但本任务还没有变更面盘点。`,
          denialHint: surfaceVerdict.hint,
        });
      }
    }
    const board = await planBoard();
 // 放行判据(五阶段轮收紧):板上须有**非阶段节点**(ph- 前缀是 task_phase 的流程泳道,
 // 纯阶段板没有规划内容)——防「只调 task_phase 建空板绕过 planner」。
    const designNodes = board ? board.nodes.filter((n) => !String(n.id).startsWith("ph-")) : [];
 // 内容节点判据:长尾注意——
 // 2-3 节点板全是「s1 梳理→s2 归因→s3 修复」式 TODO 序列,零 targets/symbolRef/accept/数据,
 // 过了旧判据(designNodes>0)。闸门升级:只认**内容节点**(指向实际对象或带可验验收);
 // 纯步骤板不开门——板是「变更在系统里的内容契约」,不是执行清单。
    const contentNodes = designNodes.filter((n) => isContentNode(n as never));
 // office 判据( 「调研/写 PPT/汇报/写文章也可以在白板上画一下作业思路
 // (主题/受众/结构/章节/章间关系/顺序)」+「office 走硬闸」):办公/产出类必须有**作业思路板**。
 // 宽松实现:只看 boardType==="composition" 且有效节点 ≥3(主题/受众/≥2 章节),更细的结构校验
 // (章节主题/章间关系词)由类型门 board-contract 负责——此处刻意不 import 新函数,避免跨代理编译竞态。
    const compositionNodes = board && board.boardType === "composition" ? designNodes : [];
    const hasCompositionBoard = compositionNodes.length >= 3;
    const isOffice = taskClassState.value === "office";
 // 豁免通道(用户拍板「office 走硬闸 + 豁免留痕」):本任务已用 board_upsert
 // exemptReason 显式声明过「确实没有开发内容/表达结构」→ 放行,且回放可见(不留静默豁免)。
    if (boardExemptThisTask) {
      try {
        journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "plan.gate", effect: "exempted", tool, actor, taskClass: taskClassState.value } });
      } catch { /* 留痕失败不影响放行 */ }
      return null;
    }
 // office 硬闸( 「白板一定是开发内容逻辑;办公任务也可以在板上画作业思路
 // (主题/受众/结构/章节/章间关系/顺序)」):办公/产出类必须有结构完整的作业思路板(boardType=
 // composition),否则拒绝并给两条出路(落 composition 板 / 确无表达结构用 exemptReason 留痕)。
    if (isOffice) {
      if (hasCompositionBoard) {
        if (!planGateAnnounced) {
          planGateAnnounced = true;
          try {
            journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "plan.gate", effect: "board-present-composition", tool, nodeCount: compositionNodes.length } });
          } catch { /* 留痕失败不影响放行 */ }
        }
        return null;
      }
      if (planGateMode !== "hard") {
        try { journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "plan.gate", effect: "soft-warn", tool, actor, taskClass: "office" } }); } catch { /* 留痕失败不影响 */ }
        return null;
      }
      const primaryPathOffice = boardFilePath(boardStoreRoot, task.sessionId, task.id);
      try {
        journal.append({
          kind: "permission.gate", sessionId: task.sessionId,
          payload: {
            tool, effect: "denied", by: "plan-gate",
            hint: "办公/产出类无作业思路板——先 board_upsert boardType=composition(或传 exemptReason 留痕豁免)",
            reason: "no-composition-board", rule: "plan-gate/composition-board", decisionBy: "plan-gate",
            boardPath: primaryPathOffice, boardStoreRoot, taskRoot, taskId: task.id,
            hasBoard: !!board, boardType: board?.boardType ?? null, nodeCount: compositionNodes.length,
          },
        });
      } catch { /* 留痕失败不影响拦截 */ }
      return JSON.stringify({
        status: "rejected",
        reason: `plan-gate:${actor}被拦——办公/产出类任务先落**作业思路板**:调 board_upsert 传 boardType="composition",画出作业思路——主题是什么/受众是谁/表达结构/要几章(≥2 章节节点,合计 ≥3 节点)/每章主题/章与章之间什么关系、顺序如何(章间关系用 data 边的 label 关系词:承接/递进/并列/对照/因果)。${board ? `注意:当前板 boardType=${board.boardType ?? "未标"}(节点 ${board.nodes.length} 个),不是工作业思路板。` : "当前还没有板。"}确无表达结构(纯环境探查/纯格式转换/纯问答)时才用豁免:board_upsert 传 exemptReason="<为什么没有表达结构>" 留痕豁免。不许用豁免掩盖本该画的思路板。`,
        denialHint: "出路二选一:①board_upsert boardType=\"composition\"(主题/受众/≥2 章节/章间关系词);②确无表达结构→board_upsert 传 exemptReason=\"<为什么没有表达结构>\"(≥20 字)留痕豁免。",
      });
    }
 // 尺度豁免:直达实施路由——理解阶段判定的「明确具体小改」免板直写;
 // 中途落板即回归全流程语义:一旦内联了 >3 节点的板,直达豁免失效,按大板规则要求 planner
 // (旧实现先 return null,板再大也豁免,是「direct 路由 + 内联大板」的绕过口)。
    if (taskRouteState.direct && !(board && designNodes.length > 3)) {
      if (!planGateDirectAnnounced) {
        planGateDirectAnnounced = true;
        try { journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "plan.gate", effect: "direct-route", tool } }); } catch { /* 留痕失败不影响放行 */ }
      }
      return null;
    }
 // q4:主任务板还没有、但 planner 已在自己的独立板上落了规划契约 → 规划已发生,闸门放行
 // (判据语义是「本任务有规划契约」,planner 的独立板同样是本任务的契约;别的任务的分区板不算)。
    if (!(board && contentNodes.length > 0) && (await hasPartitionBoard())) {
      if (!planGateAnnounced) {
        planGateAnnounced = true;
        try {
          journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "plan.gate", effect: "board-present-partition", tool } });
        } catch { /* 留痕失败不影响放行 */ }
      }
      return null;
    }
 // 阶段门 → 自动推进:7 天 telemetry(n=108 次 phase 拒绝/33 会话)显示 100% 的
 // by=plan-gate/phase 拒绝都发生在「该会话此前无任何 task_phase 声明」时,69.4% 是同会话重复被拒。
 // 规划事实由板承载:板在场且含内容节点=规划已发生,不该再用「阶段声明」这一形式拦写操作。
 // 故阶段门改为自动推进到「规划」并首次留痕,任务追踪看板(消费 task.phase)与 phaseState 保持一致。
 // 只在首次落两条事件(phaseAutoAdvancedAnnounced),此后静默。
    const autoAdvancePhase = (toolName: string, act: string) => {
      const cur = phaseState.current ? PHASES.findIndex((p) => p.key === phaseState.current) : -1;
      if (cur >= 1 || phaseAutoAdvancedAnnounced) return;
      const from = phaseState.current ?? null;
      phaseState.current = "plan";
      if (from) phaseState.done.add(from);
      phaseAutoAdvancedAnnounced = true;
      try {
        journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "task.phase", taskId: task.id, phase: "plan", auto: true, from, note: "板已在场(含内容节点),阶段门自动推进到规划" } });
      } catch { /* 留痕失败不影响执行 */ }
      try {
        journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "plan.gate", effect: "phase-auto-advanced", tool: toolName, actor: act, from, to: "plan", nodeCount: contentNodes.length } });
      } catch { /* 留痕失败不影响执行 */ }
    };

    if (board && contentNodes.length > 0) {
 // 规划委托硬闸:大板(>3 设计节点)必须由 planner 落盘;主 agent 只允许
 // 内联 1~3 节点轻量板。旧实现纯提示词,经验证主 agent 把 6 节点 UI 任务画成流程图后直接实施,
 // 白板失去「planner 先规划」的约束。planner 尝试过(即便失败)即放行,保留降级路径。
      if (planGateMode === "hard" && !plannerSpawnedThisTask && designNodes.length > 3) {
        plannerGateDenies += 1;
        const attempt = plannerGateDenies;
        const escalated = attempt > PLANNER_GATE_DENY_LIMIT;
 // 记账收敛:非 escalated(前 LIMIT 次)每条都落(诊断需要);escalated 只在
 // 首次(attempt=LIMIT+1)与之后每 +10 落一条,其余次数放行但不留痕——避免同因刷屏。
        const escalatedFirst = PLANNER_GATE_DENY_LIMIT + 1;
        if (!escalated || attempt === escalatedFirst || (attempt - escalatedFirst) % 10 === 0) {
          try {
            journal.append({
              kind: "custom", sessionId: task.sessionId,
              payload: {
                type: "plan.gate", effect: escalated ? "planner-required-escalated" : "planner-required",
                tool, actor, attempt, limit: PLANNER_GATE_DENY_LIMIT,
                escalatedAt: escalated ? Date.now() : undefined,
                reason: escalated ? "planner-not-spawned" : undefined,
                nodeCount: designNodes.length, count: attempt,
              },
            });
          } catch { /* 留痕失败不影响裁决 */ }
        }
        if (!escalated) {
 // 差分回执( token 收敛,B2 P2 遗留):旧版整段规则说明+出路 ~230 字/次,
 // escalated 会话里同文本每步重发(baseline §4.3:话术失败率 29%,重复回执纯 token 浪费)。
 // 只报「缺什么+下一步一句话」;journal 事件已含结构化字段,规则全文不进回执。
          return JSON.stringify({
            status: "rejected",
            reason: `plan-gate(规划委托):板已有 ${designNodes.length} 个设计节点(>3 阈值,内联额度 3 已尽),没有派过 planner——缺:planner 派发 0 次、内容节点 ${contentNodes.length}/${designNodes.length}。下一步一句话:spawn_subagent(agentType="planner", instructions=目标/期望产出/边界/板型)。`,
          });
        }
      }
 // 阶段门自动推进:板含内容节点=规划事实已发生,不再要求先声明 task_phase。
      autoAdvancePhase(tool, actor);
      if (!planGateAnnounced) {
        planGateAnnounced = true;
        const cov = computeP0Coverage(board);
        try {
          journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "plan.gate", effect: "board-present", tool, nodeCount: board.nodes.length, p0: cov.total } });
        } catch { /* 留痕失败不影响放行 */ }
      }
      return null;
    }
    if (planGateMode !== "hard") {
      try {
        journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "plan.gate", effect: "soft-warn", tool, actor } });
      } catch { /* 留痕失败不影响 */ }
      return null;
    }
 // 「无板」类拒绝:计数 + 逃生阀(同 task 内同因累计到第 3 次降级放行,防闸门死循环)。
    planGateDenies += 1;
 // 诊断面(可诊断):把「实际读的板路径 / 两个根 / sessionId+taskId / 回退是否命中」
 // 写进回执,模型/人能区分「真没落板」与「根错位」——旧版只给同一句模板话术,根错位时无从察觉。
    const primaryPath = boardFilePath(boardStoreRoot, task.sessionId, task.id);
    const fallbackPath = boardFilePath(taskRoot, task.sessionId, task.id);
    const diag = {
      boardPath: primaryPath,
      boardStoreRoot,
      taskRoot,
      rootsAligned: taskRoot === boardStoreRoot,
      sessionId: task.sessionId,
      taskId: task.id,
      fallbackBoardPath: taskRoot === boardStoreRoot ? "(与主根同路径)" : fallbackPath,
      fallbackHit: lastBoardReadRoot === "task",
      boardFileExists: existsSync(primaryPath),
      fallbackFileExists: taskRoot !== boardStoreRoot && existsSync(fallbackPath),
      denyCount: planGateDenies,
    };
    if (planGateDenies >= PLAN_GATE_DENY_LIMIT) {
 // 逃生阀:降级放行 + 留痕(闸门自身异常不该把任务钉死)。
 // 记账收敛:只在第 LIMIT 次(首次降级)与之后每 +10 次落一条,其余次数直接放行不留痕。
 // 放行语义不变(planGateDenies >= LIMIT 即 return null)。
      const attempt = planGateDenies;
      if (attempt === PLAN_GATE_DENY_LIMIT || (attempt - PLAN_GATE_DENY_LIMIT) % 10 === 0) {
        try {
          journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "plan.gate", effect: "escalated", tool, actor, attempt, escalatedAt: Date.now(), reason: "no-board", limit: PLAN_GATE_DENY_LIMIT, count: attempt, boardPath: primaryPath, boardStoreRoot, taskRoot } });
        } catch { /* 留痕失败不影响放行 */ }
      }
      return null;
    }
    try {
      journal.append({
        kind: "permission.gate",
        sessionId: task.sessionId,
        payload: {
          tool, effect: "denied", by: "plan-gate",
          hint: "本任务无规划板——先 spawn planner 落规划契约",
 // 结构化字段:遥测/看板按 reason+rule+decisionBy 归因,话术本文字逐字不动。
          reason: "no-board", rule: "plan-gate/content-board", decisionBy: "plan-gate",
          boardPath: primaryPath, boardStoreRoot, taskRoot, taskId: task.id, fallbackBoardPath: fallbackPath, denyCount: planGateDenies,
        },
      });
    } catch { /* 留痕失败不影响拦截 */ }
    return JSON.stringify({
      status: "rejected",
      reason: `plan-gate:${actor}被拦——本任务还没有**内容白板**。${board ? `注意:已落的板是纯计划步骤板(${designNodes.length} 个节点全是「先做A→再做B」式序列,零 targets/symbolRef/accept/数据),不算规划契约——板要回答「本次变更在系统里改什么」,不是执行清单。` : ""}按「先骨架后丰满」流程,先 spawn_subagent(agentType="planner", instructions=本任务的需求与约束) 让 planner 落骨架板;小修/纯执行类可自己内联落轻量板(board_upsert 已顺手激活)。**内容节点要求**:每个设计节点带 targets(改哪些文件/函数)、或 symbolRef、或命令级 accept;分析/性能类任务写指标数字与数据来源(基线值/口径),不写「拆解→砍→复跑」。板在场且含内容节点后本闸自动放行。只读调查(explore)与规划(planner)不受限。不要用 terminal 重定向绕行写文件。若本任务**确实没有开发内容**(纯环境探查/纯格式转换/纯问答),调 board_upsert 传 exemptReason="<为什么没有开发内容>" 留痕豁免——但不许用豁免掩盖本该画的内容板。[[activate-tool:board_upsert]]`,
      diagnostic: diag,
      denialHint: `诊断(第 ${planGateDenies}/${PLAN_GATE_DENY_LIMIT} 次因「无板」被拒,第 ${PLAN_GATE_DENY_LIMIT} 次将自动降级放行):实际读板路径 ${primaryPath}(文件${diag.boardFileExists ? "存在" : "不存在"});boardStoreRoot=${boardStoreRoot};taskRoot=${taskRoot};两根${diag.rootsAligned ? "一致" : "不同=板存储根与任务项目根错位"};回退板路径 ${diag.fallbackBoardPath}(文件${diag.fallbackFileExists ? "存在" : "不存在"});sessionId=${task.sessionId};taskId=${task.id}。判据:两文件都不存在=真没落板(去 board_upsert);文件存在却读不到=读根/解析问题,在返工说明里报根错位。确无开发内容(纯环境探查/纯格式转换/纯问答)时用 exemptReason 豁免:board_upsert 传 exemptReason="<为什么没有开发内容>"(≥20 字)留痕后本闸放行;不要用豁免掩盖本该画的内容板。`,
    });
  };

  const spawnTool: Tool = {
    name: "spawn_subagent",
    description: "Dispatch one subtask to a subagent and return its final text. Pass wait:true to block until it reaches a terminal state (zero LLM cost while waiting). **plan-gate: with no board in this task yet, write roles (worker/general) are rejected and pointed at planner; planner/explore/judge are exempt.** agentType picks the role (types listed in system prompt, default worker; read-only investigation → explore). title = one-line (<=30 chars) card label; required when several subagents run in parallel. deadlineMin = time box in minutes: on expiry the harness reaps the subagent and delivers its output as a partial result (explicitly marked, not a failure). Default = unbounded, run to completion — set it only to cap runaway jobs. A subagent is a child process agent inside THIS session (not a new session; it cannot create sessions). For independent subtasks, emit several spawn_subagent calls in one message so they run in parallel. when the task involves build/install/full test suite, state the expected commands and tell the subagent that heavy operations are gated and routed to the parent for approval — wait for the decision, never split commands to bypass it. Such approval requests surface in this session as questions; answer via answer_subagent with a reason for both approve and reject. backend:\"acp\" dispatches to an external ACP agent (Claude Code/Codex/Kimi/Hermes etc., adapter = claude-code/codex/kimi/hermes/qwen/opencode/dsh/minimax or a command). ACP permission requests use the same approval chain; ACP has no mid-run steer. worktree:true runs the subagent in a dedicated git worktree off current HEAD (<repo>/.genie/worktrees/<agentId>, branch genie/<agentId>) so parallel subagents do not collide and your workspace stays clean; the worktree and branch are kept for manual merge and the result carries worktreePath/branch. Non-git repos are rejected explicitly (no silent fallback; drop the flag to run in the main workspace).",
    parameters: {
      type: "object",
      properties: {
        instructions: { type: "string", description: "Full self-contained brief for the subagent (verb/goal/acceptance criteria)" },
        title: { type: "string", description: "One-line task summary (<=30 chars; card title; required when several subagents run in parallel)" },
        agentType: { type: "string", description: "Subagent role: worker/explore/judge/test-analyst/planner (full list in system prompt; default worker). planner for planning/design work (it writes the board + step.md + accept, no code); explore for read-only investigation" },
        run_in_background: { type: "boolean", description: "true = background: returns agentId and output file path immediately; you decide whether to wait (hard dependency → task_output with a long waitSec) or do unrelated work first. Completion/stall is announced by a system message" },
        wait: { type: "boolean", description: "true = block until the subagent reaches a terminal state (done/failed/reaped); the result is the tool return value and your loop spends zero LLM tokens meanwhile. Mutually exclusive with run_in_background (wait wins). Default false: foreground call goes background after 180s and you decide from the receipt" },
        deadlineMin: { type: "number", description: "Time box in minutes. On expiry the harness reaps the subagent and delivers existing output as a partial result (finalText explicitly marked, not a failure). Explicit value wins; planner defaults to 8 minutes when unset (agent.plannerDeadlineMin, 0 = unbounded), other roles unbounded; agent.subagentDeadlineMin>0 sets a global box" },
        backend: { type: "string", description: "Execution backend. Default = configured executor; \"acp\" = external agent over Agent Client Protocol (requires adapter)" },
        adapter: { type: "string", description: "ACP adapter (backend=acp): builtin claude-code/codex/kimi/hermes/qwen/opencode/dsh/minimax, or a command / JSON {\"cmd\":\"...\",\"args\":[...]}" },
        adapterArgs: { type: "array", items: { type: "string" }, description: "Extra ACP adapter args (optional)" },
        adapterEnv: { type: "object", description: "Env vars explicitly forwarded to the ACP adapter (opt-in; child env strips parent credentials by default)" },
        worktree: { type: "boolean", description: "true = run in a dedicated git worktree off current HEAD (<repo>/.genie/worktrees/<agentId>, branch genie/<agentId>). Parallel subagents do not collide and the main workspace is untouched; worktree and branch are kept for manual merge. Non-git repo = explicit rejection, no silent fallback." },
        isolation: { type: "string", enum: ["none", "worktree"], description: "Isolation alias: worktree equals worktree:true; none = default" },
        context: { type: "string", enum: ["fresh", "fork"], description: "Context seed: fresh (default) = only the brief; fork = prepend a bounded summary of recent parent-session user/assistant text ([父会话上下文摘要(不可信背景)]). fork costs tokens; use it when the subtask needs the conversation's background." },
      },
      required: ["instructions"],
    },
 // ZCode agentToolEntry concurrentSafe:true 同款:同批多条 spawn 经 loop Promise.all 并行;
 // 每次调用独立 LlmLoopBackend 实例+独立闭包状态,进程内子代理并发安全。
    isConcurrencySafe: () => true,
    async execute(args: unknown, signal?: AbortSignal) {
      const rawArgs = args as {
        instructions: string; title?: string; agentType?: string; run_in_background?: boolean; deadlineMin?: number;
        backend?: string; adapter?: string; adapterArgs?: string[]; adapterEnv?: Record<string, string>;
        worktree?: boolean; isolation?: string; context?: string; wait?: boolean;
 /** resume_agent 内部参数:`child:<原 taskId>` 会话键(同一 child 会话续跑,不新开会话)。 */
        resumeSessionKey?: string;
 /** 调用方自报深度:只进日志/错误文本做对照,不参与判定(判定只用 registry 链)。 */
        depth?: number;
      };
 // ACP 后端:显式 backend 只认 "acp"(其它值 fail-visible,不静默当默认后端)。
      const backendArg = rawArgs.backend ? String(rawArgs.backend).toLowerCase() : undefined;
      if (backendArg && backendArg !== "acp") {
        return JSON.stringify({ status: "rejected", reason: `未知 backend "${String(rawArgs.backend)}":可选 acp(缺省=服务配置 executor)` });
      }
      const acpRequested = backendArg === "acp";
 // worktree 隔离:worktree:true 或 isolation:"worktree";未知 isolation=fail-visible。
      const isolationArg = rawArgs.isolation === undefined ? undefined : String(rawArgs.isolation).toLowerCase();
      if (isolationArg && isolationArg !== "none" && isolationArg !== "worktree") {
        return JSON.stringify({ status: "rejected", reason: `未知 isolation "${String(rawArgs.isolation)}":可选 none/worktree(或直接用 worktree:true)` });
      }
      const worktreeRequested = rawArgs.worktree === true || isolationArg === "worktree";
 // 上下文种子:缺省 fresh=旧行为(instructions 逐字不变);未知值 fail-visible。
      const contextArg = rawArgs.context === undefined ? "fresh" : String(rawArgs.context).toLowerCase();
      if (contextArg !== "fresh" && contextArg !== "fork") {
        return JSON.stringify({ status: "rejected", code: "INVALID", reason: `未知 context "${String(rawArgs.context)}":可选 fresh/fork` });
      }
 // 深度校验(partial → implemented):只认  registry 已落盘的父子链(本次 spawn 的新记录
 // 还未登记),调用方自报深度不采信;CYCLE/INVALID 同样拒派(失败方向必须是「不派发」)。
      {
        const depthVerdict = spawnDepthVerdict({
          records: subagentRegistry.list({ includeDone: true, limit: 200 }),
          parentId: task.id,
          ...(typeof rawArgs.depth === "number" ? { requestedDepth: rawArgs.depth } : {}),
        });
        if (!depthVerdict.ok) {
          journal.append({
            kind: "custom",
            sessionId: task.sessionId,
            payload: { type: "subagent.depth.reject", parentId: task.id, code: depthVerdict.code, depth: depthVerdict.depth, reason: depthVerdict.reason },
          });
          return JSON.stringify({ status: "rejected", code: depthVerdict.code, reason: depthVerdict.reason });
        }
      }
 // 嵌套深度:父链 + 本次 > MAX_SUBAGENT_DEPTH 拒绝(外部/续跑路径兜底;子代理工具池不给 spawn)。
      const parentDepth = depthOf(subagentRegistry, task.id);
      if ((parentDepth.ok ? parentDepth.depth : 0) + 1 > MAX_SUBAGENT_DEPTH) {
        return JSON.stringify({ status: "rejected", code: "DEPTH_EXCEEDED", reason: `子代理嵌套深度超上限 ${MAX_SUBAGENT_DEPTH}(当前父深度 ${parentDepth.depth})` });
      }
 // plan-gate 写角色前置闸:worker/general 等写角色派发需规划板在场(worktree
 // 创建之前拦——拒绝不产生孤儿工作树)。planner/explore/judge/test-analyst 不受限。
 // ppt-master 同样是写角色(产 deck.md / 调导出工具),纳入同一道闸。
      const gateRole = String(rawArgs.agentType ?? "worker").toLowerCase();
 // 规划委托硬闸:派过 planner(含后续失败/被权限拒的尝试)即视为已履行委托,允许降级内联。
 // 必须在写角色闸之前置位:同一批工具调用(先 worker 后 planner)也按到达顺序正确裁决。
      if (gateRole === "planner") plannerSpawnedThisTask = true;
      const gateIsWriteRole = gateRole === "worker" || gateRole === "general" || gateRole === "general-purpose" || gateRole === "ppt-master";
      if (gateIsWriteRole && !acpRequested) {
        const blocked = await planGateBlock("spawn_subagent", `派发写角色子代理(${gateRole})`);
        if (blocked) return blocked;
      }
      const subTitle = String(rawArgs.title || "").trim().slice(0, 40); // 过程卡标题(:多子agent并列时首行前言雷同→卡片无法区分)
 // 机制1:时间盒解析——显式参数 > 全局 agent.subagentDeadlineMin > planner 专属缺省
 // (大并发修复:planner 未配置时 8 分钟,防慢 planner 长期占并发槽;其他角色仍不限时)。
      const deadlineMin = resolveSubagentDeadlineMin(rawArgs.agentType, rawArgs.deadlineMin, agentConfig?.agent);
      const deadlineMs = deadlineMin > 0 ? Math.round(deadlineMin * 60_000) : 0;
 // 可分离的子中止( ZCode detachParent 语义):父取消→转发给子;一旦自动转后台→解除转发(子代理独立存活)。
      const subAbort = new AbortController();
      const forwardAbort = () => subAbort.abort();
      signal?.addEventListener("abort", forwardAbort, { once: true });
      const baseInstructions = composeSubagentInstructions(agentProfiles, rawArgs.agentType, String(rawArgs.instructions))
 // planner 历史复用(新规划基于已有历史规划):任务书尾部自动带历史档案
 //(本会话优先+近期,≤8 条)——延续已验证的结构,别推翻已交付的成果;确需重构时在板里注明理由。
        + (String(rawArgs.agentType ?? "").toLowerCase() === "planner"
          ? renderTaskArchiveBlock(readTaskArchive(taskRoot, { sessionId: task.sessionId, limit: 8 })).replace("## 历史任务档案(compact 后恢复锚;做相关任务先对齐历史结论,别推翻已验证的成果)", "## 历史任务/规划档案(规划参考:结构可延续、成果别推翻;重构需注明理由)")
          : "")
 // 读传递( D3 治理:跨 agent 读重叠 17.5%):父会话已读文件+行段随任务书注入,
 // 子代理「勿再整读父已读片段」。≤8 文件≤700 字符(≈175 tok)防反向膨胀;GENIE_READ_HANDOFF=off 关。
 // 门控=后端类型在下方判定(isInProcessBackend);ACP/echo 外部后端不注入(它们有自己的读面)。
        + (() => {
          const backendKind = String((executor as { kind?: string }).kind ?? "");
          if (process.env.GENIE_READ_HANDOFF === "off" || acpRequested || backendKind !== "echo-child") return "";
          const block = renderParentReadBlock(readFilesOf(task.sessionId));
          return block ? "\n\n" + block : "";
        })();
 // context=fresh(缺省)时 instructions 逐字等于 baseInstructions(旧行为不变);
 // fork 时把父会话最近 user/assistant 文本摘要前插(带「不可信背景」header,预算 4000 字)。
      const forkBlock = contextArg === "fork" ? forkContextBlock(deriveMessages(journal, task.sessionId)) : "";
      const instructions = forkBlock ? forkBlock + "\n\n" + baseInstructions : baseInstructions;
      const events: string[] = [];
 // 终态守卫(机制1 竞态面):deadline 收割与后端迟到 result 只落一次注册表/journal 终态。
      let settled = false;
      let deadlineFired = false;
 // 会话工作所有权:后台子代理登记为 owner=task.sessionId 的 subagent 单元。
 // 归属只认注册时写入的 ownerSessionId;subagent.event 里的 parentTaskId 仅作追溯,**不当归属依据**。
      let ownedGeneration: number | undefined;
      const registerOwnedSubagent = (): void => {
        if (ownedGeneration !== undefined) return;
        ownedGeneration = registerOwnedUnit(journal, { unitId: bgAgentId, kind: "subagent", ownerSessionId: task.sessionId });
      };
      const settleOwnedSubagent = (): void => {
        if (ownedGeneration === undefined) return;
        const generation = ownedGeneration;
        ownedGeneration = undefined;
        settleOwnedUnit(journal, bgAgentId, generation);
      };
 // 同步落结果的 backend(ACP 的 spawn-failed 在 spawn 返回前就发 result)在注册表登记前已终态——
 // 用最近一次 result.ok 校正登记状态,避免「failed 却显示 running」。
      let lastResultOk: boolean | undefined;
      const spawnStartAt = Date.now();
 // 后台子代理注册表(ZCode async agent 机制):agentId→输出文件路径与状态。
      const bgAgentId = "agent_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
 // 修复:子代理 taskId 每次派发唯一。旧实现同父所有子代理共用 `${task.id}-sub`
 // (后台共用 `${task.id}-bg`)→ 子 loop sessionId、轨迹目录 `subagent-<taskId>-sub`、
 // subagent.event.taskId 三者全撞在一起(经验证两个并行 explore 的 159 次调用混在同一目录,
 // 无法按子代理排障)。前缀保留父任务 id 便于追溯;agentId 仍是全局唯一键。
 // resume_agent:显式带 resumeSessionKey 时沿用 `child:<原 taskId>`(同一 child 会话续跑),
 // 否则维持每次派发唯一 id(并行/重派不撞轨迹目录;agentId 仍是全局唯一键)。
      const resumeSessionKeyArg = typeof rawArgs.resumeSessionKey === "string" && rawArgs.resumeSessionKey.trim()
        ? rawArgs.resumeSessionKey.trim()
        : undefined;
      const subTaskId = resumeSessionKeyArg ?? (task.id.slice(0, 8) + "-" + bgAgentId.slice(6, 14));
 // TaskSpec.taskId 与 subTaskId 同源:续跑时逐字等于 child:<原 taskId>(不另开会话 id),否则维持旧后缀。
      const taskSpecId = (suffix: "-sub" | "-bg"): string => resumeSessionKeyArg ?? subTaskId + suffix;
 // worktree 隔离:在构造后端前创建,使 roots/workdir/子进程 cwd 全部指向派生工作树。
 // 后台名额预检前置:避免「worktree 已建、却因后台上限被拒」的孤儿工作树(正式检查在下方后台分支)。
      if (worktreeRequested && rawArgs.run_in_background === true) {
        const runningBg = [...bgAgents.values()].filter((b) => b.status === "running").length;
        if (runningBg >= 8) {
          return JSON.stringify({ status: "rejected", reason: `后台子代理已达上限 8(运行中 ${runningBg})——先用 task_output 收集结果,完成后再派新任务` });
        }
      }
      let worktree: { path: string; branch: string; baseCommit: string } | undefined;
      if (worktreeRequested) {
        try {
          const wt = await defaultWorktreeService().create({ cwd: taskRoot, id: bgAgentId });
          worktree = { path: wt.path, branch: wt.branch, baseCommit: wt.baseCommit };
          journal.append({
            kind: "custom",
            sessionId: task.sessionId,
            payload: { type: "worktree.create", ok: true, agentId: bgAgentId, ...worktree, repoRoot: wt.repoRoot },
          });
        } catch (err) {
          const code = err instanceof WorktreeError ? err.code : "CREATE_FAILED";
          const message = String((err as Error)?.message ?? err).slice(0, 600);
          journal.append({
            kind: "custom",
            sessionId: task.sessionId,
            payload: { type: "worktree.create", ok: false, agentId: bgAgentId, error: { code, message } },
          });
 // 明确拒绝,不静默回退主工作区(回退需调用方显式去掉 worktree 参数重派)。
          const iso = isolationVerdict({ requested: true, worktreeAvailable: false });
          return JSON.stringify({ status: "rejected", code: iso.code, reason: `worktree 隔离不可用(${code}):${message}`, worktree: { requested: true, ok: false, code } });
        }
      }
 // 子代理工作根:worktree 模式下所有子代理面(工具围栏/命令 cwd/code_sense 根)
 // 都切到派生工作树;主工作区只作为源仓被读取。
      const subRoot = worktree?.path ?? taskRoot;
      const worktreeCleanupHint = worktree
        ? `tsx apps/gateway/scripts/worktree-cleanup.ts remove --repo ${taskRoot} --id ${bgAgentId}`
        : undefined;
      const worktreeResult = worktree
        ? { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit, retained: true, cleanup: worktreeCleanupHint }
        : undefined;
      const worktreeNote = worktree
        ? `\n\n[worktree] 独立工作树:${worktree.path}(分支 ${worktree.branch},基于 ${worktree.baseCommit.slice(0, 8)})——分支与工作树已保留供人工合并;合并:git -C ${taskRoot} merge ${worktree.branch};清理:${worktreeCleanupHint}`
        : "";
      const worktreeLine = worktree
        ? `[worktree] path=${worktree.path} branch=${worktree.branch} base=${worktree.baseCommit}\n`
        : "";
 // 回收契约:worktree 模式下走既有 worktree-service.collect 取改动文件(git status,只读),
 // 交付文本固定 `worktree:<path> 改动文件:<...>`;none 模式为空(scratchContract 不伪造路径)。
      const scratchOf = async (): Promise<{ ok: boolean; text: string; paths: readonly string[]; diffHint: string }> => {
        if (!worktree) {
          const sc = scratchContract({ mode: "none" });
          return { ok: sc.ok, text: "", paths: sc.paths, diffHint: sc.diffHint };
        }
        let changedFiles: string[] = [];
        try {
          const c = await defaultWorktreeService().collect({ path: worktree.path });
          if (c.ok) changedFiles = c.changedFiles;
        } catch { /* 回收失败不阻塞交付 */ }
        const sc = scratchContract({ mode: "worktree", workdir: worktree.path, changedFiles });
        const text = `worktree:${worktree.path} 改动文件:${changedFiles.length ? changedFiles.slice(0, 20).join(",") : "(无)"}`;
        return { ok: sc.ok, text, paths: sc.paths, diffHint: sc.diffHint };
      };
 // 子代理实际模型名(目录:
 // models.subagent 显式配置才存在(factory 未配=undefined),回退主 llm=同实例同模型同 effort,
 // 主模型热切换后新 spawn 天然用新模型(与 effectiveBackend 同判定源)。
      const subModelName = subagentModelNameOf(models?.subagent ?? llm);
 // :子代理生命周期注册(进程级 registry;bgAgents 镜像继续承担输出文件/cancel 句柄)。
 // parentId=派发它的主 task id → list_agents/stop_agent 按后代递归天然隔离其它任务。
      const registerSubagentRecord = (): void => {
        subagentRegistry.register({
          agentId: bgAgentId,
          taskId: subTaskId,
          parentId: task.id,
          sessionId: task.sessionId,
          ...(subTitle ? { title: subTitle } : {}),
          model: subModelName,
          state: "running",
          spawnedAt: spawnStartAt,
          ...(deadlineMs > 0 ? { deadlineAt: spawnStartAt + deadlineMs } : {}),
        });
 // 原任务书/角色留进程内(resume_agent 冷启动续跑的依据;registry 不存任务书正文)。
        subagentBriefs.set(bgAgentId, {
          instructions,
          ...(rawArgs.agentType ? { agentType: String(rawArgs.agentType) } : {}),
          ...(subTitle ? { title: subTitle } : {}),
        });
        if (subagentBriefs.size > SUBAGENT_BRIEF_CAP) {
          for (const k of subagentBriefs.keys()) {
            if (subagentBriefs.size <= SUBAGENT_BRIEF_CAP) break;
            subagentBriefs.delete(k);
          }
        }
      };
 // 父任务取消 → 子代理随之 abort;registry 如实落 cancelled。后台 detach 路径会摘掉本监听
 // (子代理转后台后独立存活,不再受父取消影响——与既有 detachParent 语义一致)。
      const markSubagentCancelled = () => {
        subagentRegistry.update(bgAgentId, { state: "cancelled", resultSummary: "父任务取消,子代理随之中断" });
      };
      signal?.addEventListener("abort", markSubagentCancelled, { once: true });
 // review 抓:sessionId 来自客户端,入路径段前消毒(与 board-store seg 同纪律)
      const bgOutputDir = join(repoRoot(), ".genie", "agent-outputs", String(task.sessionId).replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_"), bgAgentId);
 // echo 占位后端 → 进程内 LLM 子代理(ZCode Agent 工具的本质=独立上下文
 // +只读工具的真 loop,不再回显任务书)。真实后端(dsh/zcode/opencode)不受影响。
 // backend=acp 显式覆盖(外部 ACP agent),不走进程内子代理分支。
      const isInProcessBackend = !acpRequested && String((executor as { kind?: string }).kind ?? "") === "echo-child";
 // 能力计划:profile.tools=执行白名单;deny-only=权限只下传父 deny。
      const cap = resolveSubagentCapability(agentProfiles, rawArgs.agentType);
 // 写角色(worker/general)挂执行面:terminal/web/browser/board_read/session_search——
 // 与主 coding agent 能力对齐(除派发子代理外);只读角色(explore/judge/test-analyst)保持窄面。
      const subRoleEarly = String(rawArgs.agentType ?? "worker").toLowerCase();
      const writeRoleEarly = subRoleEarly === "worker" || subRoleEarly === "general" || subRoleEarly === "general-purpose";
 // 产出面:ppt-master = 写角色能力面(bash/写盘)+ board_export_pptx 导出通道。
 // 与 planner 的分工一致:结构由规划出,文件由产出角色生成——但这里导出工具必须给它,
 // 否则「质量门是唯一交付通道」这条契约无法执行。
      const deckRoleEarly = subRoleEarly === "ppt-master";
 // 规划角色(planner)挂「规划面」——白板可写(board_upsert)+ 只读认知,
 // 无 terminal/web/browser/session_search;写盘由 cap.writeGlobs 限定在规划稿路径。
      const planRoleEarly = subRoleEarly === "planner";      // q1 写者作用域派生(并行 planner 各写各的分区):取本子代理 bgAgentId 的**尾部 4 个
 // [a-zA-Z0-9] 字符**做前缀(如 p1x9)。不用随机数:bgAgentId 在派发时生成并进 journal/回执,
 // 尾部 4 位由 toString(36) 时间戳+随机尾组成,同一次派发内稳定可复现,不同派发必不同;
 // 失败兜底(清洗后太短)= 用 subTaskId 的稳定哈希末 4 位,仍保证同派发同值。
      const ownerScope = plannerScopeOf(bgAgentId, subTaskId);
      const capExtraTools = cap.toolWhitelist
        ? buildSubagentExtraTools(subRoot, mcpTools, getExperienceStore(), planRoleEarly
          ? {
              journal, sessionId: task.sessionId, owner: "sub-" + subTaskId, planning: true,
              boardWrite: { taskId: task.id, taskRoot, scope: ownerScope },
              ...(worktree ? {} : { remote: taskRemoteProject ?? undefined }),
            }
          : deckRoleEarly
            ? {
                journal,
                sessionId: task.sessionId,
                owner: "sub-" + subTaskId,
                webTools: webToolsRef.value,
                deckExport: { taskId: task.id, taskRoot },
              }
            : writeRoleEarly
            ? {
                journal,
                sessionId: task.sessionId,
                owner: "sub-" + subTaskId,
 // 浏览器/公网工具在 wireAgentLoop 后半段装配;execute 运行时才求值(闭包延迟访问)。
                ...(browserConfig ? { browserConfig } : {}),
                webTools: webToolsRef.value,
              }
            : undefined)
        : undefined;
 // 工具面收敛(只收紧):父 deny ∪ profile deny(本仓 AgentProfile 无 deny 字段=空) ∪
 // 系统默认 deny(todowrite/task 主 agent 独占) ∪ primary-only 工具;命中的工具从子代理注入面摘掉,
 // 并在 journal 留痕(哪个工具因谁被收走可事后对账)。白名单本身不放宽。
      const parentDenyNames = (permRules ?? [])
        .filter((r) => r.action === "deny")
        .map((r) => String(r.permission ?? "").trim())
        .filter(Boolean);
      const convergedDeny = convergeDeny({
        parentDeny: parentDenyNames,
        childDeny: [],
        primaryOnly: PRIMARY_ONLY_TOOLS,
        kind: "subagent",
      }).deny;
      const allowedExtraTools = capExtraTools ? capExtraTools.filter((t) => !convergedDeny.includes(t.name)) : undefined;
      journal.append({
        kind: "custom",
        sessionId: task.sessionId,
        payload: {
          type: "subagent.tool.deny",
          agentId: bgAgentId,
          deny: convergedDeny,
          removed: capExtraTools ? capExtraTools.length - (allowedExtraTools?.length ?? 0) : 0,
        },
      });
 // 子代理工具池名字集(池外观测用):内置读/写+注入面(code_sense 系/skill_view/MCP)。
      const subPoolNames: string[] = allowedExtraTools
        ? [...SUBAGENT_READ_TOOLS, ...SUBAGENT_WRITE_TOOLS, ...allowedExtraTools.map((t) => t.name)]
        : [];
      const capSkillIndex = cap.toolWhitelist
        && expandToolTokens(cap.toolWhitelist).includes("skill_view")
        ? renderSubagentSkillIndex(getExperienceStore())
        : undefined;
 // ACP 外部后端:backend=acp 时按参数构造;adapter 未配置由 AcpBackend 在 spawn 时
 // 回 spawn-failed(带内置目录),不在这里静默回退默认 executor(fail-visible)。
      const acpBackend = acpRequested
        ? createAcpBackend({
            ...(rawArgs.adapter ? { adapter: String(rawArgs.adapter) } : {}),
            ...(Array.isArray(rawArgs.adapterArgs) ? { adapterArgs: rawArgs.adapterArgs.map(String) } : {}),
            ...(rawArgs.adapterEnv && typeof rawArgs.adapterEnv === "object"
              ? { adapterEnv: Object.fromEntries(Object.entries(rawArgs.adapterEnv).filter(([, v]) => typeof v === "string")) as Record<string, string> }
              : {}),
          })
        : undefined;
 // 读传递( D3)接线+留痕:同条件双触达——①parentReadSession 传进程内后端
 // (子读尾注+行段双写父键);②readHandoff 字段进 subagent.spawn payload,供
 // read-handoff-metrics.py 复测注入数/体积(验收要求「journal 留痕可复测」)。
 // env GENIE_READ_HANDOFF=off / ACP / echo 外部后端=零注入零接线(行为同旧版)。
      const readHandoff = isInProcessBackend && process.env.GENIE_READ_HANDOFF !== "off"
        ? (() => {
          const entries = readFilesOf(task.sessionId);
          const block = renderParentReadBlock(entries);
          return block ? { files: Math.min(entries.length, 8), chars: block.length } : undefined;
        })()
        : undefined;
      const effectiveBackend: SubagentBackend = acpBackend ?? (isInProcessBackend
        ? new (await import("../llm-loop-backend.js")).LlmLoopBackend({
 // 步数跟随主 agent 配置(取消强制结束;原硬编码 16 会腰斩真实任务)
 // (ZCode subagent_model 语义):子代理走独立模型端点,与主链路隔离——
 // 共享端点的服务端会话串扰不再父子互染。未配置=回退主 llm。
 // worktree 模式下 roots 只含派生工作树(主仓不可写);否则沿用项目根+harness 根。
            llm: models?.subagent ?? llm, maxSteps: agentConfig?.agent?.maxSteps ?? 80, roots: worktree ? [subRoot] : [taskRoot, repoRoot()],
 // 写前持久化屏障与主 agent 同源同值(config.agent.writeBarrier;undefined=不写键,后端/loop 缺省 hard)。
            ...(writeBarrierOf(agentConfig) ? { writeBarrier: writeBarrierOf(agentConfig) } : {}),
            role: rawArgs.agentType ?? "worker",
            workdir: subRoot,
 //  图片 offload:子代理与主 loop 同根(repoRoot),不随项目 workdir 漂移。
            imageOffload: imageOffloadOf(repoRoot()),
 // 编辑后 LSP 诊断/保存格式化:子代理 write/edit 与主 agent 同语义。
 // LSP:远程项目跳过(本地 tsserver 无远端代码;远端 LSP 独立工程登记)——
 // 省一次必然失败的 server 拉起
      ...(!remoteProjectTool && agentConfig?.coding?.lsp ? { lsp: agentConfig.coding.lsp } : {}),
 // 机制1/3:deadline 到点强制收割(部分结果交付)+无产出预警,由后端内部执行。
            ...(deadlineMs > 0 ? { deadlineMs } : {}),
            staleWarnMs,
 // 能力白名单:profile.tools 声明→真实工具面;缺席=角色二分兜底(行为同旧版)。
            ...(cap.toolWhitelist ? { toolWhitelist: cap.toolWhitelist, extraTools: allowedExtraTools } : {}),
 // 写盘围栏:profile.writeGlobs→后端 write_file/edit_file 路径白名单(planner 只写规划稿)。
            ...(cap.writeGlobs ? { writeGlobs: cap.writeGlobs } : {}),
            ...(capSkillIndex ? { skillIndexText: capSkillIndex } : {}),
 // 权限传递:进程内子代理默认继承父会话有效规则(已允许的传递下去;profile.permission=
 // deny-only 时只下传父 deny,与外部后端同语义);ask 走与外部后端同语义的审批链
 // (未允许的仍走审批;无规则=不设闸同旧版)。
            ...(permRules ? { permissionRules: cap.denyOnly ? deriveChildRules(permRules) : permRules } : {}),
            ...(permRules ? { onPermissionAsk: makeSubagentPermissionAsker({ sessionId: task.sessionId, journal, broker: permissionBroker }) } : {}),
 // 父子 ask-answer:重操作申请路由给父 agent(broker 注入+泵;超时=拒绝 fail-closed)。
            ...(parentAskBroker
              ? { parentAsk: (input: { taskId: string; role: string; tool: string; command: string; match: import("@lampgenie/core").HeavyOpMatch }) => parentAskBroker.ask(input) }
              : {}),
 // 读传递( D3):父会话键传子后端——子 read_file 命中父/兄弟已读行段时尾注,
 // 登记双写父键(兄弟子代理经父键即刻共享已读事实)。
            ...(readHandoff ? { parentReadSession: task.sessionId } : {}),
 // 子代理工作区入账(点开子代理要能看到它的全部动作/消息流):
 // 子 loop 事件以 subagent.event 落主 journal(payload={agentId,kind,…裁剪后原字段})。
 // 面板主会话渲染过滤该 kind(不双渲染),子代理工作区 tab 专用回放;外部后端不产生
 // loop 事件,工作区对它们降级为 output.txt 进度行时间线(如实标注,不造假消息)。
            onLoopEvent: (e) => {
              try {
                journal.append({ kind: "subagent.event", sessionId: task.sessionId, payload: { agentId: bgAgentId, taskId: subTaskId, parentTaskId: task.id, kind: e.kind, ...e.payload } });
              } catch { /* journal 入账失败不影响子代理执行 */ }
            },
 // 子代理与 coding agent 同构(ZCode Agent 子 runtime 继承父
 // modelStreaming/治理配置的语义):流式打字机走与主 agent 同一个 streamSink
 // (sessionId=subagent-<taskId>,面板工作区按 agent 实时渲染);上下文压缩与主
 // loop 共用同一 compactHook/microcompact 实例——长子代理不再无界增长上下文。
            ...(streamSink
              ? { onStream: (ev: import("@lampgenie/runtime/agent/loop").AgentStreamEvent) => { try { streamSink("subagent-" + subTaskId, ev); } catch { /* 旁路失败不影响执行 */ } } }
              : {}),
            compactHook: taskCompactHook,
            microcompact: taskMicrocompact,
 // 写时定形 spill(2026-11 token 轮 02):子代理与主 loop 同源——漏接会让长子代理
 // 照旧每步改写历史中段、打碎提示前缀缓存。dir 与主 loop 同一根(.genie/spill)。
            spill: taskSpill,
            bigIntake: taskBigIntake,
            growthSpurtTokens: taskGrowthSpurtTokens,
            ...(taskModelScoring ? { modelScoring: taskModelScoring } : {}),
          })
        : executor);
      let finalText = "";
      let subHandle: import("@lampgenie/executors").SubagentHandle | undefined;
      const pendingAsks: { requestId: string; decision: "allow-once" | "reject" }[] = [];
 // 子代理权限收敛:外部后端协议语义=父 deny 下传、allow/ask 不放大(ask 由父侧
 // 审批链代答);进程内 LLM 子代理走整体规则继承(上方构造参数),不走 deny-only 派生。
      const childRules = permRules ? deriveChildRules(permRules) : undefined;
      journal.append({
        kind: "subagent.spawn",
        sessionId: task.sessionId,
        payload: {
 // instructions 全文入 journal(用户反馈:300 字截断让过程卡任务书齐腰断;执行层本来就是全文,截的只是展示)
          taskId: subTaskId, parentTaskId: task.id, backend: acpRequested ? "acp" : executor.kind, instructions: instructions.slice(0, 8000),
 // ACP 后端记录 adapter 标识(实际命令解析在 AcpBackend.spawn;env 兜底也算)
          ...(acpRequested ? { acpAdapter: rawArgs.adapter ?? process.env.GENIE_ACP_ADAPTER ?? "(未配置)" } : {}),
 // agentId(B 面板过程卡):面板据此把 spawn 事件与后台注册表/output.txt tail 关联
          agentId: bgAgentId,
 // 会话结束后 bgAgents 运行期状态丢失,派遣时生效的模型必须落 journal 才能回溯
 // (此前模型只在 bgAgents.set 的 model 字段里,靠 session.status 推送,进程重启/会话结束即不可查)。
          ...(subModelName ? { model: subModelName } : {}),
 // worktree 隔离的路径/分支/base 落 journal(人工合并与清理的定位依据)
          ...(worktree ? { worktree } : {}),
          ...(subTitle ? { title: subTitle } : {}),
          ...(permRules ? { derivedPermissionRules: isInProcessBackend ? (cap.denyOnly ? deriveChildRules(permRules).length : permRules.length) : childRules!.length } : {}),
 // 能力声明快照(抽出 buildSubagentToolPolicy=直测锚+池外 warnings 观测):
 // source=declared(白名单生效)/fallback(角色二分兜底);warnings=池外声明(不改行为只补观测)。
          ...(isInProcessBackend ? { toolPolicy: buildSubagentToolPolicy(cap, rawArgs.agentType ?? "worker", subPoolNames) } : {}),
 // 读传递留痕( D3):注入数/体积可复测(metrics.py A 段数据源)。
          ...(readHandoff ? { readHandoff } : {}),
        },
      });
      if (permRules && isInProcessBackend) {
        journal.append({ kind: "permission.gate", sessionId: task.sessionId, payload: { tool: "spawn_subagent", effect: "derived", by: cap.denyOnly ? "derive-child-rules(profile deny-only)" : "inherit-parent-rules", ruleCount: cap.denyOnly ? deriveChildRules(permRules).length : permRules.length } });
      } else if (childRules && childRules.length > 0) {
        journal.append({ kind: "permission.gate", sessionId: task.sessionId, payload: { tool: "spawn_subagent", effect: "derived", by: "derive-child-rules", ruleCount: childRules.length } });
      }
 // 涉事符号上下文注入( F3,调用时机②):子 agent 动手前带调用链摘要。
      const symbolCtx = await symbolContextFor(subRoot, instructions);

      if (symbolCtx) {
        journal.append({ kind: "sense.preheat", sessionId: task.sessionId, payload: { kind: "spawn-context", symbol: firstSymbolLike(instructions) } });
      }
 // 后台模式(ZCode async_launched 移植):onEvent 追加写 output.txt,
 // 立即返回 agentId+输出文件;主 agent 稍后用 task_output 查进度/结果。
 // wait:true 时等待语义优先(互斥声明在参数描述里):不落后台,走下方前台挂起路径。
      if (rawArgs.run_in_background === true && rawArgs.wait !== true) {
 // 并发上限(审计 R1 ⚠️ 闭合):后台子代理 ≤8,防循环模型无限派发
        const runningBg = [...bgAgents.values()].filter((b) => b.status === "running").length;
        if (runningBg >= 8) {
          return JSON.stringify({ status: "rejected", reason: `后台子代理已达上限 8(运行中 ${runningBg})——先用 task_output 收集结果,完成后再派新任务` });
        }
        const { mkdirSync: mk, appendFileSync: ap, writeFileSync: wf } = await import("node:fs");
        mk(bgOutputDir, { recursive: true });
        const outputFile = join(bgOutputDir, "output.txt");
        wf(outputFile, `[started] ${new Date().toISOString()} 任务书:${instructions.slice(0, 200)}\n${worktreeLine}`, "utf-8");
 // 注册表活性时刻(机制3):任意子代理事件即刷新——task_output 据此算 stale 标记。
        let lastEventAt = Date.now();
        const touchEntry = () => {
          lastEventAt = Date.now();
          const en = bgAgents.get(bgAgentId);
          if (en) en.lastEventAt = lastEventAt;
        };
 // 后台外部后端的 permission-ask 不再悬空(权限传递):此前 bg onEvent 只认 progress/result,
 // 外部后端(bg)的 ask 永无应答=子进程挂死——与前台同链审批后回灌 handle。
        let bgHandleRef: import("@lampgenie/executors").SubagentHandle | undefined;
        const bgAsk = makeSubagentPermissionAsker({ sessionId: task.sessionId, journal, broker: permissionBroker });
 // 机制1(外部后端形态):deadline 到点由 wiring 收割——取消子进程,output.txt 已有轨迹打包为
 // 部分结果交付(ok=true 显式标注)。进程内后端不走此径(其收割在后端内部,部分结果含步数/最后输出)。
        const harvestExternalDeadline = () => {
          if (settled || deadlineFired) return;
          deadlineFired = true;
          settled = true;
          settleOwnedSubagent(); // 终态 settle(timebox 收割=终态)
          void (async () => { try { await bgHandleRef?.cancel("graceful"); } catch { /* 已退出 */ } })();
          let trail = "";
          try {
            trail = readFileSync(outputFile, "utf-8").split("\n").filter((l) => l.startsWith("[progress]") || l.startsWith("[心跳]")).slice(-12).join("\n").trim();
          } catch { /* 无输出 */ }
          const ranMin = Math.max(1, Math.round((Date.now() - spawnStartAt) / 60_000));
          const partial = `[deadline 收割] 时间盒(${deadlineMin} 分钟)已到(实际运行 ${ranMin} 分钟),以下为已完成的部分进展(输出轨迹,非最终结论):\n${trail || "(尚无进度输出)"}`;
          try { ap(outputFile, `[result ok=true] ${partial}\n`, "utf-8"); } catch { /* 输出文件写失败不阻塞收割 */ }
          const en = bgAgents.get(bgAgentId);
          if (en) { en.status = "completed"; en.lastEventAt = Date.now(); delete en.cancel; }
 // :deadline 收割=终态(部分交付),registry 落 done+摘要,避免 list_agents 显示 running。
          subagentRegistry.update(bgAgentId, { state: "done", resultSummary: partial.slice(0, 200) });
          try {
            journal.append({ kind: "subagent.result", sessionId: task.sessionId, payload: { taskId: subTaskId, parentTaskId: task.id, agentId: bgAgentId, event: { type: "result", ok: true, finalText: partial.slice(0, 300) }, reap: { reason: "deadline" } } });
          } catch { /* 终态事件失败不影响收割 */ }
 // deadline 收割 = 终态(部分交付),走同一条投递链拿统一去重/合并;但收割正文只有
 // [progress] 轨迹行(extractDeliverableText 会剥掉),故 pointerOnly=摘要+指针(内容口径不变)。
          try {
            deliverFinalNoticeWithAttention(journal, task.sessionId, {
              agentId: bgAgentId,
              label: "deadline 收割",
              summary: `时间盒(${deadlineMin} 分钟)到,已交付部分结果(实际运行 ${ranMin} 分钟;输出轨迹见 output.txt,非最终结论)`,
              pointerOnly: true,
            });
          } catch { /* 通知失败不影响收割 */ }
 // :后台单元终态 → 父会话空闲时合并通知起一次唤醒 turn(在跑则不打扰)。
          maybeWakeIdleSession(journal, task.sessionId, tm);
          finalText = partial;
          events.push("result"); // 前台竞态路径(若仍在等)立即收割
        };
        if (!isInProcessBackend && deadlineMs > 0) {
          const t = setTimeout(harvestExternalDeadline, deadlineMs);
          t.unref?.();
        }
        const bgHandle = await effectiveBackend.spawn(
          {
            taskId: taskSpecId("-bg"),
            instructions: instructions + symbolCtx,
            workdir: subRoot,
            permissions: "sandbox",
            ...(permRules ? { permissionRules: childRules } : {}),
          },
          (e: import("@lampgenie/executors").SubagentEvent) => {
            try {
              touchEntry();
              if (e.type === "progress") ap(outputFile, `[progress] ${e.note}\n`, "utf-8");
              if (e.type === "result") {
                lastResultOk = e.result.ok;
                ap(outputFile, `[result ok=${e.result.ok}] ${String(e.result.finalText ?? e.result.error?.detail ?? "")}\n`, "utf-8");
 // 终态守卫(机制1 竞态面):deadline 已收割时,后端迟到的 result 只落文件,不再翻注册表/journal/通知。
                if (!settled) {
                  settled = true;
                  settleOwnedSubagent(); // 终态 settle(后端 result 到达)
                  const entryBg = bgAgents.get(bgAgentId);
 // 终态摘除 cancel 句柄:此后「终止」按钮经 server 诚实回 ok:false(已收尾)。
                  if (entryBg) { entryBg.status = e.result.ok ? "completed" : "failed"; delete entryBg.cancel; }
 // :后台终态同步落 registry(list_agents 的状态源;后台路径在此返回,不走末尾统一更新)。
                  subagentRegistry.update(bgAgentId, { state: e.result.ok ? "done" : "failed", resultSummary: String(e.result.finalText ?? e.result.error?.detail ?? "").slice(0, 200) });
 // worktree 交付回收(路径+改动文件)——异步补齐,不阻塞终态事件与通知。
                  if (worktree) void scratchOf().then((s) => {
                    if (!s.text) return;
                    try { ap(outputFile, `[scratch] ${s.text}\n`, "utf-8"); } catch { /* 输出失败不影响交付 */ }
                    const cur = subagentRegistry.get(bgAgentId);
                    subagentRegistry.update(bgAgentId, { resultSummary: `${s.text} | ${String(cur?.resultSummary ?? "")}`.slice(0, 200) });
                  });
 // B:后台子代理也落 subagent.result 终态事件——此前只有 message.system,
 // 投影 running 计数只增不减、面板历史卡重启后无终态可查。纯事件补齐,不改权限语义。
                  try {
                    journal.append({ kind: "subagent.result", sessionId: task.sessionId, payload: { taskId: subTaskId, parentTaskId: task.id, agentId: bgAgentId, event: { type: "result", ok: e.result.ok, finalText: String(e.result.finalText ?? e.result.error?.detail ?? "").slice(0, 300) } } });
                  } catch { /* 终态事件失败不影响子代理收尾 */ }
 // 完成通知注入(ZCode background-tasks notification 语义 → 免独立往返):
 // 旧实现只发「300 字摘要 + 指针」,主模型必然再发一轮 task_output 取正文(每次子代理完成
 // 多吃一次完整 LLM 往返)。改走 deliverFinalNotice:直接注入 output.txt 里 [result …] 段
 // 之后的正文(超 GENIE_SUBAGENT_INJECT_MAX 才截断补指针),并按 session+agentId 去重、
 // 500ms 合并窗口投递——watchdog 的死讯走同一条投递链,不会出现「watchdog 投一次、result 又投一次」。
                  try {
                    let noticeOutput = "";
                    try { noticeOutput = readFileSync(outputFile, "utf-8"); } catch { /* 输出文件读不到:退化为摘要+指针 */ }
                    deliverFinalNoticeWithAttention(journal, task.sessionId, {
                      agentId: bgAgentId,
                      label: e.result.ok ? "完成" : "失败",
                      summary: String(e.result.finalText ?? e.result.error?.detail ?? ""),
                      outputText: noticeOutput,
                    });
                  } catch { /* 通知失败不影响子代理收尾 */ }
 // :后台单元终态 → 父会话空闲时合并通知起一次唤醒 turn(在跑则不打扰)。
                  maybeWakeIdleSession(journal, task.sessionId, tm);
                }
              }
              if (e.type === "permission-ask") {
                journal.append({ kind: "permission.gate", sessionId: task.sessionId, payload: { tool: "subagent", effect: "asked", by: e.summary.slice(0, 120), risk: e.risk } });
                void bgAsk("subagent", e.summary)
                  .then((allow) => bgHandleRef?.respondPermission(e.requestId, allow ? "allow-once" : "reject"))
                  .catch(() => { /* 应答失败不阻塞 */ });
                return;
              }
            } catch { /* 输出文件写失败不影响子代理 */ }
          },
        );
        bgHandleRef = bgHandle;
 // ACP 会话 id 落 journal(子代理工作区专用事件;主会话渲染过滤 subagent.event)
        if (bgHandle.acpSessionId) {
          try {
            journal.append({ kind: "subagent.event", sessionId: task.sessionId, payload: { agentId: bgAgentId, taskId: subTaskId, parentTaskId: task.id, kind: "acp.session", sessionId: bgHandle.acpSessionId, adapter: bgHandle.acpAdapter ?? rawArgs.adapter ?? "acp" } });
          } catch { /* 入账失败不影响执行 */ }
        }
 // subagent.cancel 句柄(G3 通路收尾):后台路径闭包读 bgHandleRef(spawn 未决时按下终止=诚实等待句柄就位后再取消);
 // 已收尾(settled)不挂——server 侧按「句柄缺席」回 ok:false。
        bgAgents.set(bgAgentId, { outputFile, status: settled ? (lastResultOk === false ? "failed" : "completed") : "running", sessionId: task.sessionId, model: subModelName, lastEventAt, spawnedAt: spawnStartAt, ...(deadlineMs > 0 ? { deadlineAt: spawnStartAt + deadlineMs } : {}), staleWarnMs, ...(settled ? {} : { cancel: () => { subagentRegistry.interrupt(bgAgentId); return bgHandleRef?.cancel("graceful"); }, steer: (t: string, m: "hint" | "directive") => bgHandle.steer(t, m) }), ...(subTitle ? { title: subTitle } : {}) });
 // :登记 registry(后台路径),并摘掉父取消监听——后台已 detach,父取消不再作用于它。
        registerSubagentRecord();
        registerOwnedSubagent(); // 所有权登记(cancel 句柄已就位,关会话时可真取消)
        signal?.removeEventListener("abort", markSubagentCancelled);
        ensureSubagentWatchdog(journal);
 // 终态注册表防无界增长(review 抓):>200 条时清最老的终态项(running 永不清)
        if (bgAgents.size > 200) {
          for (const [k, v] of bgAgents) { if (v.status !== "running") bgAgents.delete(k); if (bgAgents.size <= 200) break; }
        }
        return JSON.stringify({
          status: "async_launched",
          agentId: bgAgentId,
          outputFile,
          ...(worktree ? { worktreePath: worktree.path, worktreeBranch: worktree.branch } : {}),
          ...(worktreeResult ? { worktree: worktreeResult } : {}),
          ...(deadlineMs > 0
            ? { deadline: `时间盒 ${deadlineMin} 分钟:到点自动收割,已有产出作为部分结果交付` }
            : { deadlineNote: "本次未设时限;长任务建议传 deadlineMin(分钟),到点自动收割部分结果,防止长跑不返回" }),
          note: "已后台启动(异步)。由你判断:①结果是硬依赖→task_output(agentId,waitFor=\"result\")挂起等到底(等待期零 LLM 消耗);②不是硬依赖→继续推进与它任务书不重叠的其它工作(不要重复它在做的事)。完成/超时/卡死时会有系统消息通知。",
        });
      }
 // 输出双模:前台也会写输出文件——自动转后台后 task_output 才有完整轨迹可读。
      const { mkdirSync: mk, appendFileSync: ap, writeFileSync: wf } = await import("node:fs");
      mk(bgOutputDir, { recursive: true });
      const outputFile = join(bgOutputDir, "output.txt");
      wf(outputFile, `[started] ${new Date().toISOString()} 任务书:${instructions.slice(0, 200)}\n${worktreeLine}`, "utf-8");
 // 注册表活性时刻(机制3,前台路径):任意子代理事件即刷新。
      let lastEventAt = Date.now();
      const touchEntry = () => {
        lastEventAt = Date.now();
        const en = bgAgents.get(bgAgentId);
        if (en) en.lastEventAt = lastEventAt;
      };
 // 机制1(外部后端,前台路径):deadline 到点 wiring 收割(与后台路径同语义;部分结果经本工具返回值交付)。
      const harvestExternalDeadline = () => {
        if (settled || deadlineFired) return;
        deadlineFired = true;
        settled = true;
        settleOwnedSubagent(); // 终态 settle(timebox 收割=终态,前台路径)
        void (async () => { try { await subHandle?.cancel("graceful"); } catch { /* 已退出 */ } })();
        let trail = "";
        try {
          trail = readFileSync(outputFile, "utf-8").split("\n").filter((l) => l.startsWith("[progress]") || l.startsWith("[心跳]")).slice(-12).join("\n").trim();
        } catch { /* 无输出 */ }
        const ranMin = Math.max(1, Math.round((Date.now() - spawnStartAt) / 60_000));
        const partial = `[deadline 收割] 时间盒(${deadlineMin} 分钟)已到(实际运行 ${ranMin} 分钟),以下为已完成的部分进展(输出轨迹,非最终结论):\n${trail || "(尚无进度输出)"}`;
        try { ap(outputFile, `[result ok=true] ${partial}\n`, "utf-8"); } catch { /* 输出文件写失败不阻塞收割 */ }
        const en = bgAgents.get(bgAgentId);
        if (en) { en.status = "completed"; en.lastEventAt = Date.now(); delete en.cancel; }
 // :前台路径的 deadline 收割同落 registry(部分结果交付,非失败)。
        subagentRegistry.update(bgAgentId, { state: "done", resultSummary: partial.slice(0, 200) });
        try {
          journal.append({ kind: "subagent.result", sessionId: task.sessionId, payload: { taskId: task.id, agentId: bgAgentId, event: { type: "result", ok: true, finalText: partial.slice(0, 300) }, reap: { reason: "deadline" } } });
        } catch { /* 终态事件失败不影响收割 */ }
        finalText = partial;
        events.push("result"); // 前台 race 立即收割
      };
      if (!isInProcessBackend && deadlineMs > 0) {
        const t = setTimeout(harvestExternalDeadline, deadlineMs);
        t.unref?.();
      }
      subHandle = await effectiveBackend.spawn(
        {
          taskId: taskSpecId("-sub"),
          instructions: instructions + symbolCtx,
 // workdir 按项目解析;worktree 模式=派生工作树。
          workdir: subRoot,
          permissions: "sandbox",
          ...(permRules ? { permissionRules: childRules } : {}),
          ...(signal ? { parentSignal: subAbort.signal } : {}),
        },
        (e) => {
          events.push(e.type);
          touchEntry();
          try {
            if (e.type === "progress") ap(outputFile, `[progress] ${e.note}\n`, "utf-8");
            if (e.type === "result") {
              lastResultOk = e.result.ok;
              ap(outputFile, `[result ok=${e.result.ok}] ${String(e.result.finalText ?? e.result.error?.detail ?? "")}\n`, "utf-8");
 // 终态守卫:deadline 已收割(外部后端)时,迟到 result 只落文件,不翻注册表状态。
              if (!settled) {
                settled = true;
                const entryBg = bgAgents.get(bgAgentId);
 // 终态摘除 cancel 句柄:此后「终止」按钮经 server 诚实回 ok:false(已收尾)。
                if (entryBg) { entryBg.status = e.result.ok ? "completed" : "failed"; delete entryBg.cancel; }
 // :前台终态同步落 registry(与 bgAgents 镜像同一判定源)。
                subagentRegistry.update(bgAgentId, { state: e.result.ok ? "done" : "failed", resultSummary: String(e.result.finalText ?? e.result.error?.detail ?? "").slice(0, 200) });
 // worktree 交付回收(路径+改动文件)——异步补齐,不阻塞终态事件。
                if (worktree) void scratchOf().then((s) => {
                  if (!s.text) return;
                  try { ap(outputFile, `[scratch] ${s.text}\n`, "utf-8"); } catch { /* 输出失败不影响交付 */ }
                  const cur = subagentRegistry.get(bgAgentId);
                  subagentRegistry.update(bgAgentId, { resultSummary: `${s.text} | ${String(cur?.resultSummary ?? "")}`.slice(0, 200) });
                });
              }
            }
          } catch { /* 输出文件写失败不影响子代理 */ }
          if (e.type === "permission-ask") {
            journal.append({ kind: "permission.gate", sessionId: task.sessionId, payload: { tool: "subagent", effect: "asked", by: e.summary.slice(0, 120), risk: e.risk } });
 // 三级决策( B2):env > 面板审批 > auto-fail-closed。
            const applyDecision = (decision: "allow-once" | "reject", by: string) => {
              journal.append({ kind: "permission.gate", sessionId: task.sessionId, payload: { tool: "subagent", effect: decision === "allow-once" ? "allowed" : "denied", by } });
              if (subHandle) void subHandle.respondPermission(e.requestId, decision).catch(() => {});
              else pendingAsks.push({ requestId: e.requestId, decision });
            };
 // 单调收窄:决策前先跑 guard 链与 session-always(空链 + 空存储 = 行为不变)。
 // deny 直接拒(不咨询规则/面板),always 命中直接放行;abstain 落下面既有三级决策。
            const guardEv = decidePermission({ tool: "subagent", summary: e.summary, sessionId: task.sessionId, journal });
            if (guardEv.effect === "deny") { applyDecision("reject", "guard-denied"); return; }
            if (guardEv.effect === "allow") { applyDecision("allow-once", "session-always"); return; }
            if (process.env.GENIE_SUBAGENT_ASK === "allow-once") applyDecision("allow-once", "env-allow-once");
            else if (permissionMode() === "auto") applyDecision("allow-once", "mode-auto(完全访问)");
            else if (permissionMode() === "readonly") applyDecision("reject", "mode-readonly");
            else {
 // 规则咨询(F2 always-allow):确定性配置优先于交互(与 executor 路径同语义)。
              const rule = matchPermissionRule(loadRulesHot(repoRoot()), "subagent", e.summary);
              if (rule && rule.action === "allow") applyDecision("allow-once", "rule-allowed:" + rule.permission + "[" + (rule.pattern ?? "*") + "]");
              else if (rule && rule.action === "deny") applyDecision("reject", "rule-denied");
              else if (permissionBroker) {
                void permissionBroker.ask({ requestId: e.requestId, sessionId: task.sessionId, tool: "subagent", summary: e.summary, risk: e.risk })
                  .then((o) => applyDecision(o.decision, o.by === "panel" ? (o.decision === "allow-once" ? "panel-approved" : "panel-denied") : "panel-timeout"));
              }
              else applyDecision("reject", "auto-fail-closed");
            }
            return;
          }
          if (e.type === "result") finalText = e.result.finalText ?? e.result.error?.detail ?? "";
        },
      ).then((h): import("@lampgenie/executors").SubagentHandle => {
        subHandle = h;
        for (const a of pendingAsks.splice(0)) void h.respondPermission(a.requestId, a.decision).catch(() => {});
 // ACP 会话 id 落 journal(子代理工作区专用事件)
        if (h.acpSessionId) {
          try {
            journal.append({ kind: "subagent.event", sessionId: task.sessionId, payload: { agentId: bgAgentId, taskId: subTaskId, parentTaskId: task.id, kind: "acp.session", sessionId: h.acpSessionId, adapter: h.acpAdapter ?? rawArgs.adapter ?? "acp" } });
          } catch { /* 入账失败不影响执行 */ }
        }
        return h;
      });
 // B:前台子代理运行期也入注册表——面板过程卡的实时状态源(session.status subagentList)。
 // 此前仅 auto-bg 后才入表,前台运行期(最长 180s)面板无从知道「有没有在工作」;
 // result 分支既有代码本就尝试更新该条目,此处补齐登记即可闭环。终态由 result 分支改写。
 // subagent.cancel 句柄(G3 通路收尾):前台路径闭包读 subHandle;已收尾不挂。
      bgAgents.set(bgAgentId, { outputFile, status: settled ? (lastResultOk === false ? "failed" : "completed") : "running", sessionId: task.sessionId, model: subModelName, lastEventAt, spawnedAt: spawnStartAt, ...(deadlineMs > 0 ? { deadlineAt: spawnStartAt + deadlineMs } : {}), staleWarnMs, ...(settled ? {} : { cancel: () => { subagentRegistry.interrupt(bgAgentId); return subHandle?.cancel("graceful"); }, steer: (t: string, m: "hint" | "directive") => subHandle?.steer(t, m) ?? Promise.resolve(false) }), ...(subTitle ? { title: subTitle } : {}) });
 // :前台路径同样登记 registry(运行期即可被 list_agents 看到)。
      registerSubagentRecord();
      registerOwnedSubagent(); // 所有权登记(前台转后台/前台终态同一单元)
      ensureSubagentWatchdog(journal);
 // ZCode 赛跑语义:结果 vs 自动转后台计时器——超时→父拿 agentId 立即返回,子代理 detach 继续。
 // wait:true:
 // 显式选择等待时不参加 auto-bg 赛跑——挂在本工具 promise 上直到终态(deadline 收割保证终态必达,
 // 绝对上限=max(600s, deadline+90s) 防僵尸);loop 停在工具执行上不产生任何 LLM 调用。
      const autoBgMs = (agentConfig?.agent as { subagentAutoBackgroundMs?: number } | undefined)?.subagentAutoBackgroundMs ?? 180_000;
      const waitChosen = rawArgs.wait === true;
      const hardCapMs = Math.max(600_000, deadlineMs > 0 ? deadlineMs + 90_000 : 0);
 // 生产实挂修复:旧实现靠裸 setTimeout(autoBgMs/hardCap) 触发转后台——代码正确但
 // 生产经验证 180s 定时器未 fire(前台阻塞 19 分钟,靠子代理自然完成解卡;本地不复现,疑似 WSL
 // IO 瞬态)。改为统一轮询判定:200ms 心跳里查 result/转后台超时/硬上限——轮询通道与 result
 // 收割同源(生产已验证存活),不再依赖任何一次性长延时定时器。基准统一 spawnStartAt。
      const outcome = await new Promise<string>((resolve) => {
        const t = setInterval(() => {
          if (events.includes("result")) { clearInterval(t); resolve("done"); return; }
          if (!waitChosen && autoBgMs > 0 && Date.now() - spawnStartAt > autoBgMs) { clearInterval(t); resolve("auto-bg"); return; }
          if (Date.now() - spawnStartAt > hardCapMs) { clearInterval(t); resolve(waitChosen ? "wait-timeout" : "done"); return; }
        }, 200);
        t.unref?.();
      });
      if (outcome === "wait-timeout") {
 // 防僵尸兜底(理论不达:deadline 收割/watchdog 都会先落终态):如实返回,不装作完成。
        signal?.removeEventListener("abort", forwardAbort);
        return JSON.stringify({ status: "wait-timeout", agentId: bgAgentId, outputFile, note: `已挂起等待 ${Math.round(hardCapMs / 1000)}s 仍未终态${deadlineMs > 0 ? "(收割机制异常)" : "(前台等待上限,非子代理上限)"},子代理不受影响继续在后台。用 task_output(agentId="${bgAgentId}",waitFor="result") 继续等到底,或 task_output 查看轨迹` });
      }
      if (outcome === "auto-bg") {
        signal?.removeEventListener("abort", forwardAbort); // detach:父取消不再杀后台子代理
 // re-set 会整个替换条目对象:cancel 句柄随条目重挂(auto-bg 到达时必未收尾,防御式带 settled 守卫)。
        bgAgents.set(bgAgentId, { outputFile, status: settled ? (lastResultOk === false ? "failed" : "completed") : "running", sessionId: task.sessionId, model: subModelName, lastEventAt, spawnedAt: spawnStartAt, ...(deadlineMs > 0 ? { deadlineAt: spawnStartAt + deadlineMs } : {}), staleWarnMs, ...(settled ? {} : { cancel: () => { subagentRegistry.interrupt(bgAgentId); return subHandle?.cancel("graceful"); }, steer: (t: string, m: "hint" | "directive") => subHandle?.steer(t, m) ?? Promise.resolve(false) }), ...(subTitle ? { title: subTitle } : {}) });
 // :detach 后父取消不再作用,摘监听;registry 记录保持 running(转后台仍在跑)。
        signal?.removeEventListener("abort", markSubagentCancelled);
      ensureSubagentWatchdog(journal);
        journal.append({ kind: "subagent.backgrounded", sessionId: task.sessionId, payload: { taskId: subTaskId, parentTaskId: task.id, agentId: bgAgentId, outputFile } });
        return JSON.stringify({
          status: "backgrounded",
          agentId: bgAgentId,
          outputFile,
          ...(worktree ? { worktreePath: worktree.path, worktreeBranch: worktree.branch } : {}),
          ...(worktreeResult ? { worktree: worktreeResult } : {}),
          ...(deadlineMs > 0 ? { deadline: `时间盒 ${deadlineMin} 分钟仍有效:到点自动收割部分结果` } : {}),
 // 等待还是继续由主 agent 自行判断,harness 只给事实与选项,不再指令「继续做其它工作」
 //(此前指令式 note 经验证诱导主 agent 在等待期重复子代理任务书的勘察=双倍成本)。
          note: `前台等待 ${Math.round(autoBgMs / 1000)}s 超时,子代理已转后台继续运行(agentId="${bgAgentId}")。接下来由你判断:①它的结果是后续工作的硬依赖→用 task_output(agentId="${bgAgentId}",waitFor="result")挂起等到底(等待期零 LLM 消耗);②不是硬依赖→继续推进与它任务书不重叠的其它工作(不要重复它在做的事)。完成/超时/卡死时会有系统消息通知;卡死可止损重派。下次「派了就等」可直接 spawn(wait:true) 免去这一跳。`,
        });
      }
      signal?.removeEventListener("abort", forwardAbort);
      signal?.removeEventListener("abort", markSubagentCancelled);
 // 机制1 竞态面:deadline 收割(外部后端)已落过终态事件,不重复写。
      if (!deadlineFired) {
        journal.append({ kind: "subagent.result", sessionId: task.sessionId, payload: { taskId: subTaskId, parentTaskId: task.id, agentId: bgAgentId, event: { type: "result", finalText: finalText.slice(0, 300) }, ...(worktree ? { worktree } : {}) } });
      }
 // :前台终态兜底落 registry(已 cancelled/interrupted 的不回退;仅 running 才改)。
      settleOwnedSubagent(); // 终态 settle(前台路径走到终态返回:同单元只结算一次)
      const finalScratch = await scratchOf();
      if (subagentRegistry.get(bgAgentId)?.state === "running") {
        const summary = finalScratch.text ? `${finalScratch.text} | ${finalText || ""}` : (finalText || "");
        subagentRegistry.update(bgAgentId, { state: lastResultOk === false ? "failed" : "done", resultSummary: summary.slice(0, 200) });
      }
      const scratchNote = finalScratch.text ? `\n\n[scratch] ${finalScratch.text}(diff:${finalScratch.diffHint || "n/a"})` : "";
      return (finalText || "(子 agent 未返回结果)") + worktreeNote + scratchNote;
    },
  };

 // 开工不再做 orient/经验/devlog/历史档案的匹配式注入(此前每条 user
 // message 都跟一条 tips,内容与会话语境常错配且冗余)。code_sense 走拉取式(工具调用才返回,
 // 索引预热由下方机制2 warmIndex 独立承担);经验/历史经 skill_view 与 compact 恢复锚到达。
 // tips 引擎只剩功能性注入(白板评论投递/首派子代理纪律),见 buildLoopTips 注释。
  const store = getExperienceStore();
 // getPhase 闭包只在 loop 运行时被调(tips ctx 组装),届时 phaseState(下方声明)早已初始化,
 // 无 TDZ 问题;phase 变化(phaseState.current 重写)闭包实时读到最新值。
  const loopTips = buildLoopTips({
    sessionId: task.sessionId,
    getPhase: () => phaseState.current,
 // 全链路变更类任务的 plan/close 阶段卡换覆盖卡(盘点 SOP / 残留审计);判据与 plan-gate 同源。
    changeScope: () => surfaceScopeThisTask().scope,
  });

 // MCP 工具桥 + 浏览器工具先建(审计修复④:工具清单只提在场工具,含 MCP/浏览器)
 // MCP 工具桥:启用服务器的工具以 mcp__<server>__<tool> 并入工具面(fail-soft:探测失败=空集)。
  const mcpTools: Tool[] = [];
  if (mcp) {
    try {
      const found = await mcp.allToolsForAgent();
      const slug = (x: string) => String(x).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 24);
      for (const t of found) {
        const fname = "mcp__" + slug(t.serverName) + "__" + slug(t.name);
        mcpTools.push({
          name: fname,
          description: "[MCP " + t.serverName + "] " + (t.description || t.name),
          parameters: { type: "object", properties: { arguments: { type: "object", description: "工具参数(JSON 对象)" } } },
          async execute(args: unknown) {
            const a = (args as { arguments?: unknown }) || {};
            return mcp.callTool(t.serverId, t.name, (a as { arguments?: unknown }).arguments ?? a);
          },
        });
      }
      if (mcpTools.length) journal.append({ kind: "task.progress", sessionId: task.sessionId, payload: { taskId: task.id, mcp: mcpTools.length } });
    } catch {
 // 探测失败:主 agent 无 MCP 工具,任务照常
    }
  }
 // 浏览器控制工具:门禁实时读 config(停用立即失效)。
 /* owner(2026-11 browser-ux-redo):主 agent 用 sessionId 做稳定归属(同一会话多任务同 owner 才不互抢);
 * 拿不到 sessionId 时回落 task.id,再回落 "agent"。 */
  const browserTool = browserConfig
    ? createBrowserTool(repoRoot(), browserConfig, task.sessionId || task.id || "agent")
    : null;
 // 公网静态读写工具:web_fetch/web_search 只读;交互操作仍归 browser。
 // 域名策略沿用 browser 的 allowDomains(面板热改),为空时回落 GENIE_WEB_ALLOW_DOMAINS。
 // 三层能力:①web.search 配置层(设置页写入;provider/key 从配置/secrets 现读,
 // 面板保存即热生效——每次查询时解析,不缓存);②env provider 回退;③都无→内置静态检索
 // (DDG HTML)兜底。web_fetch 静态正文近空(JS 页)或失败时,browser 工具在场则真实渲染兜底。
  const searchRuntime = (): { provider: string; apiKey?: string; endpoint?: string; model?: string } | null => {
    try {
      const root = repoRoot();
      const web = readWebSearchConfigHot(root);
 // provider 缺省=默认 DeepSeek(密钥引用名取自 providers[] 里
 // id=deepseek 的 apiKeyEnv);disabled=true 或取不到密钥 → null,落内置静态检索
 // (curl 等价)+ browser 指路的降级链。语义单测在 resolveSearchRuntimeFromConfig。
      return resolveSearchRuntimeFromConfig(web, webSearchCfgCache.providers, (name) => readSecretValue(root, name));
    } catch { return null; }
  };
  const webTools = createWebTools(
    {
      ...(browserConfig ? { allowDomains: () => browserConfig.allowDomains() } : {}),
      searchRuntime,
      ...(browserTool
        ? {
          browserFetch: async (url: string) => {
            const out = String(await browserTool.execute({ action: "text", url }));
            if (out.startsWith("[browser]")) return { ok: false as const, error: out };
            const nl = out.indexOf("\n");
            const title = nl > 0 ? out.slice(0, nl).replace(/^标题:/, "").trim() : "";
            return { ok: true as const, title, text: nl > 0 ? out.slice(nl + 1) : out };
          },
        }
        : {}),
    },
  );
  webToolsRef.value = webTools; // 子代理执行面复用同一组只读检索工具(无状态)
 // 系统提示组装(审计修复①②):
 // ①身份唯一化——SYSTEM 是唯一身份声明,soul 只贡献行为纪律(「语音管家」身份行剥离,refs:身份唯一);
 // ②AGENTS.md 随任务项目根(taskRoot,opencode findUp 就近语义)——此前钉死 harness 根=项目约定永不进提示词。
 // soul+memory(hermes 移植):SOUL.md 行为纪律为继承块;记忆块归 companion 轨( P4)。
 // 子智能体注册表(内置+ .genie/agents/*.md 覆盖,ZCode profile 模式)
  const agentProfiles = loadAgentProfiles(repoRoot());
  const soulText = loadSoul(join(repoRoot(), ".genie", "soul")).content || DEFAULT_SOUL_MD;
 // system 瘦身:toolHints/经验索引不再进 system(工具说明归 tools 参数+tool_view;
 // 经验归 loopTips 按动作注入)——这里不再组装 toolHints。
 // 子代理派发策略按后端形态定(用户经验证:echo 占位下模型反复派 echo 子代理烧尽 maxSteps——
 // P3:项目底座认知注入——「项目主线」块(≤300 字符,防开发偏离主线)。
 // 读 taskRoot/.genie/sense-index/profile.json(同步,缺席=零注入零开销,不在此处触 LLM);
 // 生产者是 codesense project --write。GENIE_SENSE_PROJECT_INJECT=off 可关。
  const projectMainline = process.env.GENIE_SENSE_PROJECT_INJECT === "off"
    ? ""
    : projectMainlineBlockOf(taskRoot);
 // system 瘦身(起
 // 经验也不再推送——按需 skill_view 查看;工具清单由 tools 参数+tool_view 按需承载)。
 // 提示词档位( token 轮 P2):短任务书走精简档(SYSTEM_LITE),长任务书走全量。
 // 阈值 1450 字符 = 任务书原文长度,已在 16 题上验证 r=0.818;GENIE_SYSTEM_LITE=on/off 可强制开/关做 A/B。
  const instrChars = String(task.instruction ?? "").length;
  const liteMode = process.env.GENIE_SYSTEM_LITE === "off" ? false
    : process.env.GENIE_SYSTEM_LITE === "on" ? true
    : instrChars < 1450;
 // 开工画像(2026-11):coding 任务开工时探测 branch/脏文件/近期提交/worktree/包清单,
 // 把可执行 verify 命令与停止规则写进 system 稳定前缀。
 // 为什么 verify 命令要进稳定前缀:它是本仓真值(现读 manifests/锁文件),模型不必自猜命令
 // (猜错=白烧一轮验证);system 每步重发但逐字不变 → prompt cache 命中,增量成本≈0。
 // 为什么探测失败不能阻塞开工:开工信息是增益不是前置条件——探测逐项 fail-soft,
 // 整体异常只落 errors 审计(task 照常开工);非 coding 类完全不探测(零行为变化)。
  let workStartBrief = "";
  {
    const alreadyProfiled = journal.readAll().some((e) =>
      e.kind === "custom" && e.sessionId === task.sessionId
      && (e.payload as { type?: string } | undefined)?.type === "work.start.profile");
    if (taskClassState.value === "coding" && !alreadyProfiled) {
      try {
        const profile = await probeWorkStart({
          root: taskRoot,
          exec: (cmd, args, o) => {
            try {
              const out = _execFileSync(cmd, args, {
                cwd: o?.cwd ?? taskRoot,
                encoding: "utf8",
                timeout: o?.timeoutMs ?? 3000,
                stdio: ["ignore", "pipe", "ignore"],
              });
              return { ok: true, stdout: String(out), stderr: "" };
            } catch (err) {
              const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
              return { ok: false, stdout: String(e?.stdout ?? ""), stderr: String(e?.stderr ?? e?.message ?? err) };
            }
          },
        });
 // 稳定前缀:同输入同文本(渲染纯函数,无时间戳/随机数),同会话只注入一次。
        workStartBrief = renderStartProfileTip(renderWorkStartBrief(profile, { modelFamily: subagentModelNameOf(llm) }));
        journal.append({
          kind: "custom",
          sessionId: task.sessionId,
          payload: {
            type: "work.start.profile",
            taskId: task.id,
            root: taskRoot,
            branch: profile.branch,
            dirty: profile.dirtyFiles,
            commits: profile.commits,
            worktrees: profile.worktrees,
            manifests: profile.manifests,
            packageManager: profile.packageManager,
            verifyCommands: verifyCommandsFor(profile),
            errors: profile.errors,
          },
        });
      } catch (err) {
 // 整段异常:跳过注入,只落 errors 审计(fail-soft,不阻塞开工)。
        journal.append({
          kind: "custom",
          sessionId: task.sessionId,
          payload: {
            type: "work.start.profile",
            taskId: task.id,
            skipped: true,
            errors: [{ probe: "work-start", error: err instanceof Error ? err.message : String(err) }],
          },
        });
      }
    }
  }
  const composed = composeSystemPrompt({
    base: systemForTaskClass(taskClassState.value, { lite: liteMode }) + "\n\n## 行为纪律(soul 继承,身份以上文为准)\n" + soulDisciplinesFor(soulText) + "\n\n" + formatAgentProfiles(agentProfiles) + projectMainline
 // 开工画像块进稳定前缀(coding 类且本会话未注入过才有内容;空串=零变化)。
      + workStartBrief,
    agentsMd: discoverAgentsMd(taskRoot),
 // 父子 ask-answer:「子代理资源调度」节(spawn 告知义务+审批决策指引)。
    subagentDispatch: renderSubagentDispatchSection({ answerToolMounted: true }),
 // n6 技能索引(主 agent 也注入,ZCode context/sections/skills.ts):与子代理同源同格式,
 // 预算 20000 字符,超预算降级为 name+file 一行。空索引=不渲染该节(renderSkillIndex 返回 "")。
 // 档案 skills.allow:只过滤「可安全过滤」的索引行(name 或 category/name 命中),空=不过滤。
    skillIndex: renderSkillIndex(
      (() => {
        const all = collectSkillIndexEntries(store);
        const allow = taskProfile?.skills?.allow;
        if (!allow || allow.length === 0) return all;
        return all.filter((e) => allow.includes(e.name) || allow.includes(`${e.category}/${e.name}`));
      })(),
      SKILL_INDEX_MAX_CHARS),
  });
 // 保留节边界( token 轮 04):旧写法 `const { text: system } = ...` 把 sections 丢掉,
 // 导致 loop 只能整篇 26~28K 字符重发 system 变更(经验证 855 次调用 / 8.3M uncached / 占未命中 39.5%)。
  const system = composed.text;

 // 附件注入(2026 附件通道):文本类=路径进任务书 + read_attachment 工具可读;图片类=转 data URL 进 vision 通道。
 // 组装走纯函数 buildAttachmentInjection(可单测):类别判定=classifyAttachment,mime 缺失按扩展名兜底;
 // 图片进视觉通道要过「单张 ≤2MB」+「本轮 ≤4 张」双闸,每种未进原因各有专门文案(不静默、不混句)。
  const { block: attachmentBlock, visionImages } = buildAttachmentInjection(task.attachments, (p) => readFileSync(p), { sizeOf: (p) => statSync(p).size });
  const readAttachmentTool: Tool | null = task.attachments?.length
    ? {
        name: "read_attachment",
        description:
          "读任务附件正文。文档类(docx/pptx/xlsx/pdf/zip)由解析器抽出纯文本后返回(上限 100KB,超出截断);文本/代码类按文本读取(同样 100KB 截断);解析失败会返回失败原因。参数 path=任务书「附件」节给出的绝对路径。图片附件已进视觉通道(见「## 附件」节),视频附件只给路径(本工具只读文本,读不到视频内容)。",
        parameters: { type: "object", properties: { path: { type: "string", description: "附件绝对路径" } }, required: ["path"] },
        async execute(args: unknown) {
          const a = (args ?? {}) as { path?: string };
          const p = String(a.path ?? "");
          const att = task.attachments?.find((x) => x.path === p);
          if (!att) return "[附件不在本任务清单]";
 // 类型门槛(C4):二进制附件(视频/图片/其它二进制)不进 utf-8 解码——吐乱码不如给一句可读提示。
          const kind = classifyAttachment(att.name, att.mime);
          if (kind === "video") {
            return "[视频附件]" + att.name + " 不入文本读取:模型不接收视频内容,如需分析请先转帧/截图(或用 ffmpeg/浏览器工具取关键帧)后作为图片附件提供。路径:" + p;
          }
          if (kind === "image") {
            return "[图片附件]" + att.name + " 不入文本读取:图片已作为视觉输入进模型(若「## 附件」节标注未进视觉通道,则因超单张 2MB 或超 4 张上限)。路径:" + p;
          }
          if (kind === "doc") {
 // 附件链路:文档类走解析器(doc-text.ts,永不抛错),返回解析后的纯文本。
            const r = await parseDocFile(p, {
              name: att.name,
              mime: att.mime,
 // 路径围栏:附件路径必须落在 repoRoot/taskRoot 之内,越界解析器直接拒。
              roots: [...new Set([repoRoot(), taskRoot].filter((x): x is string => !!x))],
            });
            if (!r.ok) return "[文档附件解析失败] " + att.name + ":" + r.reason + "\n路径:" + p;
            const head = "[文档附件] " + att.name + "(已解析为纯文本)" + (r.note ? "(注:" + r.note + ")" : "");
            const body = r.text.length > 100 * 1024 ? r.text.slice(0, 100 * 1024) + "\n…(超 100KB 截断)" : r.text;
            return head + "\n\n" + body;
          }
          try {
            const buf = readFileSync(p);
 // 二进制字样兜底:非已知文档类型但 mime 指向二进制(未知扩展)= 不入 utf8 解码。
            if (isBinaryLikeMime(att.mime)) {
              const mm = normalizeAttachmentMime(att.mime);
              const tip = mm.startsWith("image/")
                ? "非白名单图片格式,请先转成 png/jpeg 再用 view_image"
                : "二进制内容需先转换为文本后再读";
              return "[二进制附件] " + att.name + "(" + att.mime + ")不入文本读取:" + tip + "。路径:" + p;
            }
            if (buf.length > 100 * 1024) return buf.toString("utf-8").slice(0, 100 * 1024) + "\n…(超 100KB 截断)";
            return buf.toString("utf-8");
          } catch (err) {
            return "[附件读取失败] " + String(err).slice(0, 120);
          }
        },
      }
    : null;
 // 权限闸门:规则在场才设;ask 处置 env 可调(缺省 fail-closed)。
 // 记忆上下文注入(冻结 + 召回门):USER.md/MEMORY.md 渲染块进系统提示(空=不加节)。
 // 召回门:「你好」「谢谢」「好的」「/compact」这类 trivial 输入不携带任务信息,记忆块对回答零增益——
 // 整块跳过注入,这一次调用直接省下数千 token;跳过判定与原因落 journal(memory.recall)可审计。
 // 冻结视图:同 owner 内容/revision 未变时复用同一份快照,中途写盘不再让整节系统提示前缀失效。
  const recallDecision = shouldRecallMemory(task.instruction);
  let memBlock = "";
 // memoryScope="none" 的 kind 不注入记忆块(召回门判定也一并省下)。
 // memoryScope="session":本仓 MemoryStore 只有 MEMORY.md/USER.md 双库、无 project/session 域过滤,
 // 故保持既有注入(等价于「无域过滤时只跳过 project 域」的现状),不做块内伪拆分。
  if (memory && taskKindCaps.memoryScope !== "none" && recallDecision.recall) {
    const frozen = memory.contextBlockFrozen?.("local");
    memBlock = frozen ? frozen.block : memory.contextBlock("local");
 // 无 memory 或空库不落 snapshot 事件(hash 只对真实注入块有意义)。
    if (frozen && memBlock) {
      try {
        journal.append({ kind: "custom", sessionId: task.sessionId, payload: { what: "memory.snapshot", hash: frozen.hash, reused: frozen.reused } });
      } catch { /* 留痕失败不影响注入 */ }
    }
  } else if (!recallDecision.recall) {
    try {
      journal.append({ kind: "custom", sessionId: task.sessionId, payload: { what: "memory.recall", recalled: false, reason: recallDecision.reason } });
    } catch { /* 留痕失败不影响主流程 */ }
  }
 // 会话目标注入( /goal):journal 最近一条 active goal → 系统提示(目标驱动跨轮任务)。
  const goalEv = [...journal.readAll()].reverse().find((e) => e.sessionId === task.sessionId && e.kind === "goal.set");
  const goalPayload = (goalEv?.payload ?? {}) as { goal?: string | null; state?: string };
  const goalBlock = goalPayload.goal && goalPayload.state !== "paused"
    ? "\n\n## 会话目标(用户当前的首要目标,决策时优先对齐)\n" + goalPayload.goal
    : "";
 // plan 模式(ZCode runtime_mode FULL 提醒逐字移植;ExitPlanMode→PLAN_COMPLETE 标记适配)。
  const planBlock = permissionMode() === "plan"
    ? planModePrompt()
    : "";
 // workspace 模式(权限模式第 5 档)提示:文件围栏只放行项目目录内,项目外路径被拒;命令/终端同口径
 // (terminal 注入 fenceCommand,命令文本里的项目外绝对路径/越界 .. 段下发前拒绝)。
  const workspaceBlock = permissionMode() === "workspace"
    ? "\n\n## 当前权限模式=工作区内\n只能读写当前项目目录内的文件,项目外路径(绝对路径 / .. 越界)一律被拒绝。命令/终端执行同样限在项目目录内(项目外路径会被拒绝;脚本内部的相对跳转与拼接触发器不在文本校验范围)。"
    : "";
  const planFileBlock = await planFileBlockFor(task.sessionId);
 // teamai 团队资产:enforced 规则/文化/技能索引进系统提示(relay 不可达=空块,零影响)。
  const teamaiBlock = renderTeamaiBlock((globalThis as { __teamView?: { teamaiDigest(): Record<string, unknown> | null } }).__teamView?.teamaiDigest() ?? null);
 // 当前日期上下文( ZCode current-date section 语义):模型默认不知今天几号,涉及
 // 日志检索/git 考古/「最近」类任务时必备。
  const now = new Date();
  const weekday = "日一二三四五六"[now.getDay()] ?? "";
  const dateBlock = "\n\n## 当前日期\n" + now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0") + "(周" + weekday + ")";
 // 系统提示的**节清单**( token 轮 04):与 systemWithMemory 同内容,只是保留节边界。
 // 作用:loop 侧的 `[系统提示更新]` 从「整篇 26~28K 字符重发」改成「只发变更的节」。经验证旧口径
 // 855 次调用付了 8.3M uncached = 全部未命中 token 的 39.5%;而真实变更通常只涉及一两节
 // (AGENTS.md 摘要 / memory revision / 技能索引新增),其余节逐字节相同——重发是纯浪费。
 // **单一真源(修复)**:此前 blocksAll 用字符串 `+` 拼、systemSections 又手写一份,
 // 两份清单不同步 → 漏了 planBlock/workspaceBlock。后果不是「少发一点」而是**静默丢规则**:
 // plan 模式与「工作区内」权限模式的约束文本在全文里,但节 diff 永远看不到它们变化 →
 // `[系统提示更新]` 零追加 → 模型收不到「现在是 plan 模式,不许改代码」。省 token 不能换行为退化。
 // 现改法:**一个数组同时产出两份**(blocksAll 由它 join 而来,systemSections 直接展开),
 // 结构上不可能再漏——将来加新裸块只需在这一个数组里加一项。
  const namedBlocks: NamedSystemBlock[] = namedSystemBlocks({
    memory: memBlock,
    goal: goalBlock,
    plan: planBlock,
    workspace: workspaceBlock,
    planFile: planFileBlock,
  });
 // blocksAll 必须与 namedBlocks 同源:拼接顺序 = 数组顺序,逐字节等价于旧的
 // `memBlock + goalBlock + planBlock + workspaceBlock + planFileBlock`(空串不参与,结果相同)。
  const blocks = namedBlocks.map((b) => b.content).join("");
  const blocksAll = blocks ? blocks + dateBlock : dateBlock.trim() ? dateBlock : "";
  const systemWithMemory = (blocksAll || teamaiBlock) ? system + "\n\n" + blocksAll + (blocksAll && teamaiBlock ? "\n\n" : "") + teamaiBlock : system;
  const systemSections = [
    ...composed.sections.map((s) => ({ name: s.name, content: s.content })),
    ...namedBlocks,
    ...(teamaiBlock ? [{ name: "teamai", content: teamaiBlock }] : []),
    { name: "date", content: dateBlock },
  ];
 // steer_task(二期):向在跑任务的中途 turn 注入追加指令——loop 每 step 从
 // journal 重导出消息,注入的 message.user 会出现在下一次 LLM 调用里(真转向,不是假排队)。
 // task_output(ZCode TaskOutput 语义):查后台子代理的进度与结果。
 // waitFor:"result":挂起直到终态——
 // 等待期间主循环零 LLM 消耗(loop 停在本工具 promise 上);上限不靠模型给秒数,动态对齐该子代理的
 // deadline+宽限(watchdog 同源),无时间盒用 60min 兜底——收割链保证终态必达,挂起必有尽头。
  const taskOutputTool: Tool = {
    name: "task_output",
    description: "补查后台运行的子代理输出(run_in_background 派发后用 agentId 查)。**子代理终态结果会自动注入下一轮(完成/失败/时间盒收割/死讯都会),通常无需调用本工具**——派完继续干别的,结果自己会到。只有三种情况才调:①**需要 8000 字以上全文**(自动注入的正文单条上限 4000 字、多条合计 8000 字,被截断时会带「已截断」标记,此时读全文);②**需要运行中的进度快照**(还没终态,想确认它做到哪了);③**需要对 stale 子代理止损**(返回 stale:true=长时间无事件疑似卡死→用更明确的任务书重派,不要无限等待)。两种用法:①**要等它完成→waitFor:\"result\"**:挂起直到终态(完成/失败/时间盒收割),期间零 LLM 消耗,结果回来即恢复——这是「选择等待」的标准姿势,一次调用等到底;②只看快照/短等→waitSec(0-600s 单次长阻塞,不是轮询间隔;给小值反复调=空转,实测 12 连空轮询的教训)。",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "后台代理 id(spawn 返回的 agentId)" },
        waitSec: { type: "number", description: "快照/短等模式:阻塞等待的最长秒数(0-600,缺省 0=立即返回当前快照)。要等到底请改用 waitFor" },
        waitFor: { type: "string", enum: ["result"], description: "挂起等待直到该子代理终态(完成/失败/时间盒收割)——等待期间零 LLM 消耗,结果回来机制自动恢复;上限自动对齐其时间盒,无需给秒数" },
      },
      required: ["agentId"],
    },
 // 降级(终态正文已自动注入,本工具从「收割主力」退成「补查」):读注册表 + 读输出文件
 // + 睡眠轮询,无副作用、无 journal 写入——与真实工作工具在**同一步**并行执行是安全的(step 成本
 // 不再多占一次往返)。停止等待由 signal 中止,不阻塞同级工具的收尾。
    isConcurrencySafe: () => true,
    async execute(args: unknown, signal?: AbortSignal) {
      const a = (args ?? {}) as { agentId?: string; waitSec?: number; waitFor?: string };
      const id = String(a.agentId ?? "");
      const entry = bgAgents.get(id);
      if (!entry) return `错误:未找到后台代理 ${id}(可能已过期或非后台派发)`;
      const waitForTerminal = a.waitFor === "result";
 // 挂起上限(watchdog 同源):设了时间盒=deadline+宽限;未设(不限时口径)=无限等
 // (子代理死活由 watchdog stale 预警兜可见性);waitSec 短等模式保持 600s 上限。
      const capMs = waitForTerminal
        ? (entry.deadlineAt != null
          ? Math.max(entry.deadlineAt + SUBAGENT_WATCHDOG_GRACE_MS - Date.now(), 5_000)
          : Number.POSITIVE_INFINITY)
        : 0;
      const waitSec = waitForTerminal ? 0 : Math.min(Math.max(Number(a.waitSec) || 0, 0), 600);
      const deadline = Date.now() + (waitForTerminal ? capMs : waitSec * 1000);
 // 等待循环:500ms 节律;父任务取消(signal)中途退出——挂起不挡取消。
      let aborted = false;
      const onAbort = () => { aborted = true; };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        while (entry.status === "running" && Date.now() < deadline && !aborted) {
          await new Promise((r) => setTimeout(r, 500));
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      let out = "";
      try { out = readFileSync(entry.outputFile, "utf-8"); } catch { /* 文件尚未写出 */ }
      const timedOut = entry.status === "running";
 // 机制3:无产出预警——运行中且超过 staleWarnMin 无任何事件→stale 标记。
 // 主 agent 由此可决策止损(steer 注入/重派/继续等),不再对着一个疑似卡死的子代理干等。
      const staleMs = timedOut ? Date.now() - (entry.lastEventAt ?? Date.now()) : 0;
      const isStale = timedOut && staleMs > staleWarnMs;
      return JSON.stringify({
        status: entry.status, outputFile: entry.outputFile, output: out.slice(0, 8000),
        ...(timedOut ? { lastEventAgoSec: Math.max(0, Math.round(staleMs / 1000)) } : {}),
        ...(aborted ? { note: "父任务已取消,等待中止" } : {}),
        ...(waitForTerminal && timedOut && !aborted
          ? { note: `挂起等待已达上限(${Math.round(capMs / 1000)}s,对齐时间盒+宽限)仍未终态——收割链异常。再次调用 waitFor:"result" 可续等,或查看轨迹止损重派` }
          : {}),
        ...(!waitForTerminal && waitSec > 0 && timedOut ? { note: `已等待 ${waitSec}s 仍在运行(最近事件 ${Math.round(staleMs / 1000)}s 前)。要等到底改用 waitFor:"result"(零 LLM 挂起到终态);只看进度可再调 waitSec` } : {}),
        ...(isStale ? {
          stale: true,
          staleMinutes: Math.round(staleMs / 60_000),
          staleNote: `子代理已 ${Math.round(staleMs / 60_000)} 分钟无任何事件(疑似卡死)。可放弃并用更明确的任务书+deadlineMin 重派,或继续等待(后台子代理不支持中途转向;steer_task 只作用于任务表里的任务,不作用于子代理)`,
        } : {}),
      });
    },
  };
 // ── 五硬阶段追踪(理解任务→规划→开始实施→开始验收→完成,
 // 每阶段写出来展示到看板,不涉及的也要声明;代码级管理追踪防越做越偏)──
 // 修正:五阶段不再落白板(白板定位=设计草图)——阶段归宿与 todo_write 同形态:
 // journal(task.phase 事件)+「任务追踪」看板实时展示。旧板的 ph-* 节点仅作兼容渲染。
  const PHASES = [
    { key: "understand", label: "理解任务" },
    { key: "plan", label: "规划" },
    { key: "implement", label: "开始实施" },
    { key: "verify", label: "开始验收" },
    { key: "close", label: "完成" },
  ] as const;
  type PhaseKey = (typeof PHASES)[number]["key"];
  const phaseState: { current?: PhaseKey; skipped: Set<PhaseKey>; done: Set<PhaseKey>; notes: Partial<Record<PhaseKey, string>> } = { skipped: new Set(), done: new Set(), notes: {} };
  const taskPhaseTool: Tool = {
    name: "task_phase",
    description: "五硬阶段声明与推进(理解任务→规划→开始实施→开始验收→完成):每进入一个阶段调一次(phase+一句话 note),阶段实时展示在「任务追踪」看板(独立流程板,与 todo 同形态;不写设计白板);不涉及的阶段用 skip:true 显式声明。代码级追踪:每次调用落 journal(task.phase),越阶/回退会有警告提醒——这是防「越做越偏」的锚,不是仪式。**路由(理解阶段产出)**:明确具体的小改(单文件/局部,需求无歧义)→ task_phase(phase=\"implement\", route=\"direct\") 直达实施(免规划/白板);功能新增/删除/修改等长链路任务 → 正常进 plan 落板。taskClass=任务类别更正(coding=改代码/测试/debug,office=文档/PPT/表格等非代码产出,qa=问答/调研只读)——非编码类免阶段声明/白板/plan-gate 仪式,更正为 coding 则全套恢复。",
    parameters: {
      type: "object",
      properties: {
        phase: { type: "string", enum: ["understand", "plan", "implement", "verify", "close"], description: "目标阶段:understand=理解任务/plan=规划/implement=开始实施/verify=开始验收/close=完成" },
        note: { type: "string", description: "一句话说明本阶段要点/产出(≤60字,会写进板节点)" },
        skip: { type: "boolean", description: "true=声明该阶段不涉及(如纯问答任务无实施/验收)" },
        taskClass: { type: "string", enum: ["coding", "office", "qa"], description: "任务类别更正(理解阶段确认初判;更正即刻生效:plan-gate/每10步锚/纪律随之切换)" },
        route: { type: "string", enum: ["direct"], description: "直达实施路由(理解阶段判定:需求明确具体的小改,单文件/局部范围)——implement 声明时携带:免规划/白板直写;发现范围扩大随时落板回归全流程" },
      },
      required: ["phase"],
    },
 // P1-3 账本阶段零步:task_phase 今日 97 次调用、每次独占一个完整 step(经验证全仓
 // 1.0 工具/步),成本占 input 4.1~4.4%、单会话 8.4M。置 true 后它能与真实工作工具在**同一步**
 // 并行执行(loop 的 safe 批 Promise.all),阶段声明不再额外占一步。安全性:只写 phaseState(纯内存)
 // + journal.append(append-only,无读改写竞争);plan-gate 判定源仍是 journal 阶段事件,口径不弱化。
    isConcurrencySafe: () => true,
    async execute(args: unknown) {
      const a = (args ?? {}) as { phase?: string; note?: string; skip?: boolean; taskClass?: string; route?: string };
 // 直达实施路由(明确具体的需求直接实施,长链路才走完整流程):
 // 理解阶段判定→implement+route=direct→plan-gate 尺度豁免(免板直写);落板即回归全流程。
      if (a.route === "direct" && taskClassState.value === "coding" && !taskRouteState.direct) {
        taskRouteState.direct = true;
        try { journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "task.route", taskId: task.id, route: "direct", source: "agent" } }); } catch { /* 留痕失败不影响 */ }
      }
 // 任务类别更正:agent 在理解阶段确认/更正初判——后续 tips/plan-gate 全消费。
 // 更正为 coding 时随回执补发编码纪律(P1-1:qa/office 版提示从未含编码纪律,闸门恢复
 // 与规则送达必须同时发生,否则模型被拦却没见过规则)。
      let classSwitchNote = "";
      if (a.taskClass === "coding" || a.taskClass === "office" || a.taskClass === "qa") {
        if (taskClassState.value !== a.taskClass) {
          const from = taskClassState.value;
          taskClassState.value = a.taskClass;
          try { journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "task.class", taskId: task.id, taskClass: a.taskClass, source: "agent" } }); } catch { /* 留痕失败不影响 */ }
          classSwitchNote = a.taskClass === "coding"
            ? `\n\n[任务类别更正 ${from}→coding,编码纪律即刻生效——此前未注入过,全文如下]\n${CODING_DISCIPLINE_REFILL}`
            : `\n\n[任务类别更正 ${from}→${a.taskClass}:${a.taskClass === "office" ? "办公/产出类——免阶段/白板/plan-gate 仪式;动笔前先 skill_view 对应产出物技能(office-writing + office-pptx/docx/xlsx/report);开工四问先答完(面向谁/主题/重点与不讲什么/论据与分析来源),每个论点主张+论据+分析+结论四段齐全并写反证,禁提纲交付与 agent 腔,流程/结构/趋势一律画图,交付前自查内容完整/格式/无占位残留" : "问答/调研类——免仪式,直接调查并输出结论(结论先行+出处),不改代码"}]`;
        }
      }
      const idx = PHASES.findIndex((p) => p.key === a.phase);
      if (idx < 0) return `错误:未知阶段 ${String(a.phase)};可选 ${PHASES.map((p) => p.key).join("/")}`;
      const key = PHASES[idx]!.key;
      const curIdx = phaseState.current ? PHASES.findIndex((p) => p.key === phaseState.current) : -1;
      const warnings: string[] = [];
      if (a.skip === true) {
        phaseState.skipped.add(key);
        if (phaseState.notes[key] === undefined && a.note) phaseState.notes[key] = a.note;
 // skip 同样查越阶:跳着声明「不涉及」=中间阶段被无声略过,提醒补声明(skip 或推进)。
        const skipWarn = curIdx >= 0 && idx > curIdx + 1
          ? `⚠ 越阶声明:「${PHASES[curIdx]!.label}」与「${PHASES[idx]!.label}」之间的阶段要么推进要么也声明不涉及,不要无声略过`
          : "";
        try { journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "task.phase", taskId: task.id, phase: key, skip: true, note: String(a.note ?? "").slice(0, 200), ...(skipWarn ? { warnings: [skipWarn] } : {}) } }); } catch { /* 留痕失败不影响 */ }
        return `已声明「${PHASES[idx]!.label}」不涉及(任务追踪看板实时可见)。${skipWarn ? "\n" + skipWarn : ""}${classSwitchNote}`;
      }
      if (curIdx >= 0) {
        if (phaseState.current && key === phaseState.current) warnings.push("重复声明当前阶段(无害)");
        else if (idx > curIdx + 1) warnings.push(`越阶:从「${PHASES[curIdx]!.label}」直接跳到「${PHASES[idx]!.label}」——跳过的阶段要么补做、要么显式 skip 声明不涉及,不要无声略过`);
        else if (idx <= curIdx) {
          warnings.push(`阶段回退(「${PHASES[curIdx]!.label}」→「${PHASES[idx]!.label}」):确认是返工还是误声明;返工要在 note 写清原因`);
          phaseState.done.delete(key);
        }
      }
      if (phaseState.current) phaseState.done.add(phaseState.current);
      phaseState.current = key;
      if (a.note) phaseState.notes[key] = String(a.note).slice(0, 200);
      try { journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "task.phase", taskId: task.id, phase: key, note: String(a.note ?? "").slice(0, 200), warnings: warnings.length ? warnings : undefined } }); } catch { /* 留痕失败不影响 */ }
 // 阶段产出清单(阶段转换时刻恰时送达该阶段要点——不新增注入,随
 // 工具回执走;理解阶段=挖掘需求三问+分类+路由判定,验收阶段=四步清单补注意力衰减)。
      const phaseGuide = key === "understand" ? [
        "【理解阶段自查】①潜在需求三问:同类扩展还有哪些成员?改动牵动哪些上下游?异常/空态/规模上限如何表现?②任务类别确认(初判 " + taskClassState.value + ",不符用 taskClass 更正);③路由判定:明确具体的小改(单文件/局部)→ task_phase(phase=\"implement\", route=\"direct\") 直达实施;功能新增/删除/修改等长链路 → 进 plan 落板;简单问答/调研 → 直接回答(taskClass 改 qa 免仪式)。",
      ].join("\n")
        : key === "plan" ? [
          "【规划阶段产出】设计板必须有设计节点(纯阶段板不放行写操作);小任务内联 1~3 节点轻量板即可,不必派 planner;P0 节点必带 accept 验收。",
          ...(surfaceScopeThisTask().scope === "surface"
            ? ["【全链路变更】先盘点再动手:change_surface(action=\"scan\", concept=\"<被替换的概念>\") 拿 11 类表面清单 + 链路图(分层/边/建议改动顺序),逐条给去向(改/删/保留旧+理由)再一次性改完;scan 同时生成链路图,plan-gate 要求清单与链路图都在场;汇报前 action=\"audit\" 验证 0 未处理。"]
            : []),
        ].join("\n")
        : key === "implement" ? [
          taskRouteState.direct
            ? "【直达实施纪律】改既有函数前必先用 code_sense 查影响面;发现超出单文件/局部范围 → 停下先落板(board_upsert)再继续;完成后照常进 verify。"
            : "【实施阶段要点】按板实施;改既有函数前必先用 code_sense 查影响面并同步调用方与测试。",
        ].join("\n")
        : key === "verify" ? [
          "【验收四步(汇报完成前必走)】①用 code_sense 复核影响面;②code_review 审本任务变更集(blocker/high 必修);③相关测试定向跑,报告带条件/通过标准/实际结果三要素;④board_upsert action=audit 核对 P0(有板时)。某步不适用要说明原因。",
        ].join("\n")
        : "";
      const next = PHASES[idx + 1];
      return `阶段已推进:「${PHASES[idx]!.label}」(${idx + 1}/5)${a.note ? "——" + String(a.note).slice(0, 60) : ""}(任务追踪看板实时可见)${warnings.length ? "\n⚠ " + warnings.join(";") : ""}${phaseGuide ? "\n" + phaseGuide : ""}${next ? `\n下一阶段:「${next.label}」——时机到了用 task_phase 声明` : "\n五阶段走完。收尾前 board_upsert action=audit 核对 P0 证据"}${classSwitchNote}`;
    },
  };

  const steerTool: Tool = {
    name: "steer_task",
    description: "向一个正在运行的任务中途追加指令(转向)。参数 taskId=目标任务 id,note=追加指令。任务须处于 running 状态。",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string", description: "目标任务 id" }, note: { type: "string", description: "追加指令" } },
      required: ["taskId", "note"],
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as { taskId?: string; note?: string };
      const target = tm.get(String(a.taskId ?? ""));
      if (!target) return "错误:任务不存在";
      if (target.state !== "running") return `错误:任务 ${target.id} 状态为 ${target.state},只有 running 任务可转向`;
      journal.append({ kind: "message.user", sessionId: target.sessionId, payload: { text: `[转向] ${String(a.note)}` } });
      journal.append({ kind: "task.progress", sessionId: target.sessionId, payload: { taskId: target.id, steer: String(a.note).slice(0, 120) } });
      return `已注入转向指令到任务 ${target.id}(下一个 step 生效)`;
    },
  };
 // run_parallel 已删除:它经 tm.submit 造新任务=新会话,
 // 违反「只有音频 agent/用户入口能建会话」。并行=ZCode Agent 机制:同一条消息里发多个 spawn_subagent
 // 调用(loop 对并发安全工具 Promise.all 同跑,loop.ts:242),全部是本会话内的子代理,由本会话自己管理。
  const permRules = loadPermissionRules(repoRoot());
 // 工具面非空门禁:空 tools 时 provider 的 toOpenAi 不带 tools 字段=纯文本对话
 // (「工具未配置」观测的机制形态)——装配 bug 必须在首个 LLM 请求发出前 fail-visible,不静默降级。
 // 工具清单同步入 journal(task.progress.tools):此后任何「工具是否下发」质疑可直接以 journal 为证。
 // tool_view 按需注入(像 MCP 一样用时再看):长描述工具摘要为首句+指路,
 // 完整说明经 tool_view(name) 查看;tools 参数从 39k chars 级降到 schema+短描述。
  const changeSurfaceTool = makeChangeSurfaceTool({ journal: journal as unknown as ChangeSurfaceJournal, sessionId: task.sessionId, taskId: task.id, root: taskRoot, instruction: String(task.instruction ?? "") });
 //  子代理控制面(仅主工具面;子代理工具池由 buildSubagentExtraTools/SUBAGENT_*_TOOLS 决定,
 // 结构性不含这两个名字——越权不是靠提示词约束,而是工具面缺失)。
  const listAgentsTool: Tool = {
    name: "list_agents",
    description: "列出本任务的子代理(含全部后代,递归):agentId/状态/模型/耗时/截止/标题/结果摘要。includeDone=false 只看运行中;limit 缺省 50。只能看自己的子代理。",
    parameters: {
      type: "object",
      properties: {
        includeDone: { type: "boolean", description: "false = 只列运行中(缺省 true=含终态)" },
        limit: { type: "number", description: "最多返回条数(缺省 50)" },
      },
    },
 // 只读注册表快照,无副作用:可与其它工具在同一步并行执行。
    isConcurrencySafe: () => true,
    async execute(args: unknown) {
      const a = (args ?? {}) as { includeDone?: boolean; limit?: number };
      const now = Date.now();
      const rows = subagentRegistry.list({
        parentId: task.id,
        includeDone: a.includeDone !== false,
        ...(typeof a.limit === "number" ? { limit: a.limit } : {}),
      }).map((r) => ({
        agentId: r.agentId,
        state: r.state,
        model: r.model,
        title: r.title,
        elapsedSec: Math.max(0, Math.round(((r.lastEventAt ?? now) - r.spawnedAt) / 1000)),
        ...(r.deadlineAt !== undefined
          ? { deadlineAt: new Date(r.deadlineAt).toISOString(), deadlineInSec: Math.round((r.deadlineAt - now) / 1000) }
          : {}),
        ...(r.resultSummary ? { resultSummary: r.resultSummary.slice(0, 200) } : {}),
      }));
      return JSON.stringify({ count: rows.length, agents: rows });
    },
  };
  const stopAgentTool: Tool = {
    name: "stop_agent",
    description: "中断指定子代理(**只能停自己的子代理**):只作用于该 agentId 一条记录,兄弟子代理与父任务不受影响。跨任务/非后代/不存在一律拒绝(fail-closed);已终态返回 ALREADY_TERMINAL。",
    parameters: {
      type: "object",
      properties: { agentId: { type: "string", description: "要中断的子代理 id(spawn_subagent 返回的 agentId)" } },
      required: ["agentId"],
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as { agentId?: string };
      const id = String(a.agentId ?? "");
      if (!id) return JSON.stringify({ ok: false, code: "INVALID", reason: "agentId 必填" });
      const rec = subagentRegistry.get(id);
 // fail-closed:只允许当前 task 的后代(registry 递归后代集);跨任务/不存在一律拒绝,
 // 且拒绝分支不触碰任何 cancel 句柄(避免误停别人的子代理)。
      const allowed = new Set(subagentRegistry.descendants(task.id));
      if (!rec || !allowed.has(id)) {
        return JSON.stringify({ ok: false, code: "FORBIDDEN", reason: `只能停止本任务的子代理(${id} 不属于当前任务)` });
      }
      if (rec.state !== "running") {
        return JSON.stringify({ ok: false, code: "ALREADY_TERMINAL", agentId: id, state: rec.state });
      }
      const cancel = bgAgents.get(id)?.cancel;
      if (!cancel) {
        return JSON.stringify({ ok: false, code: "NO_HANDLE", agentId: id, reason: "无取消句柄(前台派发可能尚未转后台,或已收尾)" });
      }
      try {
 // 既有 cancel 句柄(与面板「终止」按钮同一条通路);句柄内部已先落 registry.interrupt。
        cancel();
      } catch (err) {
        return JSON.stringify({ ok: false, code: "CANCEL_FAILED", agentId: id, reason: String((err as Error)?.message ?? err) });
      }
 // 兜底:句柄缺席 interrupt 的旧条目在此补落;终态返回 ALREADY_TERMINAL 也算成功。
      const r = subagentRegistry.interrupt(id);
      const finalRec = r.record ?? subagentRegistry.get(id);
      return JSON.stringify({ ok: finalRec?.state === "interrupted", agentId: id, state: finalRec?.state ?? rec.state });
    },
  };
 // steer:运行中注入指令(复用 registry 越权裁决 + 后端 handle.steer);子代理工具池结构性不给。
  const steerAgentTool: Tool = {
    name: "steer_agent",
    description: "向**运行中**的子代理中途追加指令(hint=提示/directive=强制),后端在下一个 step 生效。权限边界:只能操作自己的后代(跨任务/不存在→FORBIDDEN/NOT_FOUND),非运行态→NOT_RUNNING;ACP 后端单回合无运行中干预(如实 INVALID)。",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "目标子代理 id(spawn_subagent 返回的 agentId)" },
        text: { type: "string", description: "追加指令正文(≤2000 字)" },
        mode: { type: "string", enum: ["hint", "directive"], description: "hint=建议(directive=必须执行);缺省 hint" },
      },
      required: ["agentId", "text"],
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as { agentId?: string; text?: string; mode?: string };
      const id = String(a.agentId ?? "");
      if (!id) return JSON.stringify({ ok: false, code: "INVALID", reason: "agentId 必填" });
      const rec = subagentRegistry.get(id);
      const verdict = steerVerdict(rec ? { ...rec } : undefined, { byAgentId: task.id, registry: subagentRegistry, mode: a.mode });
      if (!verdict.ok) {
        const reason = verdict.code === "NOT_FOUND" ? `子代理不存在(${id})`
          : verdict.code === "NOT_RUNNING" ? `子代理非运行态(${rec?.state ?? "unknown"}),无法 steer——已终态请用 resume_agent`
            : `无权 steer ${id}(只能操作自己的后代)`;
        return JSON.stringify({ ok: false, code: verdict.code, agentId: id, ...(rec ? { state: rec.state } : {}), reason });
      }
      const text = String(a.text ?? "").trim();
      if (!text) return JSON.stringify({ ok: false, code: "INVALID", agentId: id, reason: "text 必填" });
      const steer = bgAgents.get(id)?.steer;
      if (!steer) {
        return JSON.stringify({ ok: false, code: "NOT_RUNNING", agentId: id, reason: "无运行中 steer 句柄(可能刚收尾,或该后端不暴露中途转向)" });
      }
      let delivered = false;
      try {
        delivered = await steer(text.slice(0, 2000), verdict.mode);
      } catch (err) {
        return JSON.stringify({ ok: false, code: "INVALID", agentId: id, reason: String((err as Error)?.message ?? err).slice(0, 300) });
      }
      try {
        journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "subagent.steer", agentId: id, mode: verdict.mode, ok: delivered, chars: text.length } });
      } catch { /* 留痕失败不影响 steer */ }
      return delivered
        ? JSON.stringify({ ok: true, code: "OK", agentId: id, mode: verdict.mode, note: "已注入,子代理下一个 step 生效" })
        : JSON.stringify({ ok: false, code: "INVALID", agentId: id, reason: "后端不支持运行中 steer(ACP 单回合)" });
    },
  };
 // cold resume:终态子代理带「原任务书 + 上次结果摘要 + 本次指令」续跑(新 agentId,原记录不动)。
 // 子代理工具池结构性不给(否则子代理可无限续跑绕过派发纪律)。
  const resumeAgentTool: Tool = {
    name: "resume_agent",
    description: "冷启动续跑:对**已终态**子代理派新子代理,instructions=原任务书(截1500)+上次结果摘要(截800)+本次指令;新 agentId 挂在当前任务下,原记录不改。权限边界:只能续跑自己的后代(跨任务 FORBIDDEN);原任务书只在父进程内保留(进程重启后如实 INVALID)。context=fork 时前插父会话最近文本摘要。",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "已终态的子代理 id" },
        instruction: { type: "string", description: "本次续跑指令(必填;会在原任务与上次结果之后追加)" },
        context: { type: "string", enum: ["fresh", "fork"], description: "fresh=只带原任务/结果/指令(缺省);fork=再加父会话上下文摘要" },
      },
      required: ["agentId", "instruction"],
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as { agentId?: string; instruction?: string; context?: string };
      const id = String(a.agentId ?? "");
      if (!id) return JSON.stringify({ ok: false, code: "INVALID", reason: "agentId 必填" });
      const rec = subagentRegistry.get(id);
 // fail-closed:先判后代(跨任务的 id 连「存在性/状态」都不该透露)。
      if (rec) {
        const allowed = new Set(subagentRegistry.descendants(task.id));
        if (!allowed.has(id)) return JSON.stringify({ ok: false, code: "FORBIDDEN", agentId: id, reason: `只能续跑本任务的子代理(${id} 不属于当前任务)` });
      }
      const brief = subagentBriefs.get(id);
      const plan = resumePlan(rec ? { ...rec, ...(brief ? { instructions: brief.instructions } : {}) } : undefined, { instruction: a.instruction, context: a.context });
      if (!plan.ok) {
        const reason = plan.code === "NOT_FOUND" ? `子代理不存在(${id})`
          : plan.code === "NOT_RUNNING" ? `子代理仍在运行(${rec?.state}),同目标续跑会双跑——先等终态或用 steer_agent`
            : plan.code === "INVALID" ? (String(a.instruction ?? "").trim() ? "原任务书不可得(进程重启后不留存),请直接 spawn_subagent" : "instruction 必填")
              : "续跑被拒";
        return JSON.stringify({ ok: false, code: plan.code, agentId: id, ...(rec ? { state: rec.state } : {}), reason });
      }
      let instructions = plan.instructions;
      if (plan.needsParentContext) {
        const block = forkContextBlock(deriveMessages(journal, task.sessionId));
 // 占位前缀由真实摘要替换;摘要为空时保留占位行(调用方可见「无上下文」的事实)。
        instructions = block ? block + "\n" + instructions.replace(/^\[父会话上下文摘要\]\n?/, "") : instructions;
      }
      const title = `[续跑] ${brief?.title ?? rec?.title ?? id}`.slice(0, 30);
 // 同一 child 会话续跑——task_id 固定为 `child:<原 taskId>`(已有 child: 前缀先剥掉,多次续跑不叠前缀),
 // 由 spawn 侧写进 registry.taskId 与 TaskSpec.taskId;不新建会话 id。
      const sessionKey = resumeSessionKey(String(rec?.taskId || id).replace(/^child:/, ""));
      const raw = await spawnTool.execute({
        instructions,
        title,
        ...(brief?.agentType ? { agentType: brief.agentType } : {}),
        run_in_background: true,
        resumeSessionKey: sessionKey,
      });
      let parsed: { agentId?: string; status?: string; reason?: string } | undefined;
      try { parsed = JSON.parse(raw) as { agentId?: string; status?: string; reason?: string }; } catch { parsed = undefined; }
      if (!parsed?.agentId) {
        return JSON.stringify({ ok: false, code: "INVALID", originalAgentId: id, reason: String(parsed?.reason ?? raw).slice(0, 400) });
      }
      return JSON.stringify({
        ok: true, code: "OK", originalAgentId: id, agentId: parsed.agentId, state: parsed.status,
        needsParentContext: plan.needsParentContext,
        note: "已按原任务书冷启动续跑(新 agentId,原记录不改);结果经系统消息/task_output 返回",
      });
    },
  };
  const mainTools: Tool[] = attachToolView([spawnTool, withAnswerAttentionGuard(buildSubagentAnswerTool(parentAskBroker)), codeSenseTool(taskRoot, taskRemoteProject ?? undefined), changeSurfaceTool, sessionSearchTool(journal, task.sessionId), codeReviewTool(taskRoot, models?.review, journal, task.sessionId, streamSink ? (note) => streamSink(task.sessionId, { type: "tool-progress", callId: "code_review", name: "code_review", note }) : undefined, checkpointSha, taskRemoteProject ?? undefined), runWorkflowTool(journal, executor, task.sessionId, workflowAskRouter), skillViewTool(store, () => disabledBuiltins(repoRoot())), experienceFoldTool(store), todoTool(journal, task.sessionId, { allowParallelInProgress: agentConfig?.agent?.todoAllowParallelInProgress === true }), ...(askUser ? [askUserTool(task.sessionId, askUser)] : []), teamTaskTool(journal, task.sessionId), boardUpsertTool(journal, task.sessionId, task.id, taskRoot, undefined, undefined, { onExempt: () => { boardExemptThisTask = true; }, taskClass: () => taskClassState.value }), boardExportPptxTool(task.sessionId, task.id, taskRoot), taskPhaseTool, boardReadTool(journal, task.sessionId, undefined, { boardId: task.id, fallbackToSessionBoard: true }), meetingImportTool(llm), steerTool, taskOutputTool, (() => {
 // 主 agent 终端(卫生提醒 + 绕写检测):命令含写文件形态且
 // 规划未落地时拦截——堵「文件工具被 plan-gate 拦、改用 echo > 绕行」的流程造假口子。
        const t = createTerminalTool({
          service: getTerminalService(journal),
          owner: task.sessionId,
          root: taskRoot,
          contextHygiene: {},
 // workspace=工作区内档:命令围栏同 file-tools.fencePath 口径(围栏根=taskRoot);其余档不注入
          ...(permissionMode() === "workspace" ? { fenceCommand: (c: string) => fenceCommand(c, taskRoot) } : {}),
        });
        const orig = t.execute.bind(t) as unknown as (a: unknown, s?: AbortSignal) => Promise<string>;
        t.execute = async (args: unknown, signal?: AbortSignal, ctx?: { callId: string }) => {
          const cmd = String((args as { command?: unknown } | null)?.command ?? "");
 // git 审计(g1:主 agent 不受限(放行),但命中 git 写/破坏命令时留痕
 // custom/git.audit——11-05 的事故复盘要求"谁在什么时候动了工作树"可事后对账。
 // 批量 commands 逐条判(一次往返多命令时不能只看 command)。
          auditGitCommand(journal, task.sessionId, cmd);
          for (const c of ((args as { commands?: unknown } | null)?.commands ?? []) as unknown[]) {
            if (typeof c === "string") auditGitCommand(journal, task.sessionId, c);
          }
          if (/>{1,2}\s*\S|sed\s+(-[^\s]*i|--in-place)|\btee\b\s|dd\s+[^;]*of=|\btruncate\b|\binstall\b\s+-m|\bpatch\b\s|\bcp\b\s+\S+\s+\S/.test(cmd)) {
            const blocked = await planGateBlock("terminal(写重定向)", `terminal 绕写(${cmd.slice(0, 60)})`);
            if (blocked) return blocked;
          }
          return orig(args, signal);
        };
        return t;
      })(), // 主 agent 直操作文件六件套(围栏根=taskRoot;写类 readonly/plan 拒 + file.write 类别闸)
 // :后台命令 job(start/list/read/wait/kill)——长任务/构建/测试的独立句柄,结算只通知一次。
    (() => {
      const t = createJobTool({
        registry: getJobRegistry(journal),
        owner: task.sessionId,
        sessionId: task.sessionId,
        root: taskRoot,
        ...(permissionMode() === "workspace" ? { fenceCommand: (c: string) => fenceCommand(c, taskRoot) } : {}),
      });
      const orig = t.execute.bind(t) as unknown as (a: unknown, s?: AbortSignal) => Promise<string>;
      t.execute = async (args: unknown, signal?: AbortSignal) => {
        const a = (args ?? {}) as { action?: string; command?: unknown };
        if (a.action === "start" && typeof a.command === "string") auditGitCommand(journal, task.sessionId, a.command);
        return orig(args, signal);
      };
      return t;
    })(),
 // wait_until( session 验证):条件等待原语——等外部进程产出(文件出现/含串/稳定)
 // 或终端输出静默,替代「sleep N; tail」式轮询(经验证 582 次/13.4h sleep,每轮烧一次全量往返)。
 // 挂起期间 loop 停在本工具 promise 上(task_output waitFor 同机制),零 LLM 消耗。
 // 远程项目任务不注册(v1 文件条件走本地围栏;远端等待待远端 exec 语义再开)。
    ...(!taskRemoteProject ? [createWaitUntilTool({ owner: task.sessionId, root: taskRoot, terminalService: getTerminalService(journal) })] : []),
    ...createFileTools({
      root: taskRoot, journal, sessionId: task.sessionId,
      toolDumpDir: join(repoRoot(), ".genie", "tool-dumps"),
      ...(agentConfig?.coding?.lsp ? { lsp: agentConfig.coding.lsp } : {}),
      planGate: (tool) => planGateBlock(tool, `主 agent 直写(${tool})`),
 // 视觉能力:vision=false 走 coding.vlm 兜底;vlm 每任务懒建缓存(provider 带重试/准入)
      ...(agentConfig?.coding ? { vision: visionBridgeFor(agentConfig) } : {}),
    }), ...(remoteProjectTool ?? []),
 // 交付物登记排在 file tools 之后(产出文件→登记路径→收尾核对)。
    makeDeliverableTool({ journal: journal as unknown as DeliverableJournal, sessionId: task.sessionId, taskId: task.id, root: taskRoot }),
    ...mcpTools,
    ...(browserTool ? [browserTool] : []), ...webTools,
 // 引用账本排在 web 工具之后(先抓再引),收尾按登记表校验正文 [n]。
    makeCiteSourceTool({ journal: journal as unknown as CitationJournal, sessionId: task.sessionId, taskId: task.id }),
    ...(readAttachmentTool ? [readAttachmentTool] : []),
    listAgentsTool, stopAgentTool, steerAgentTool, resumeAgentTool],
 // 工具契约按执行上下文投影:装配期把真实上下文交给 attachToolView——plan/readonly 下写类工具
 // 描述带只读前缀,qa/office 带类别提示,委派类只列本次真实可用的 agent 名。投影只作用于 wire 描述,
 // 注册表本体(Tool 对象)与 tool_view 全文说明都不变(见 tool-contract.ts 的「先快照再重写」注释)。
    {
      contract: {
        agentType: "main",
        permissionMode: permissionMode(),
        taskClass: taskClassState.value,
        availableTools: agentProfiles.map((p) => p.name),
      },
    });
 // 工具面即 SDK(PTC/代码模式):coding 任务追加 run_code——沙箱内一次调用跑多步工具链,
 // 只回最终返回值+子调用账本,省掉每步一次推理轮。追加在 attachToolView **之后**:run_code 的
 // 描述/参数里带完整签名清单(>240 字符),走摘要化会把 SDK 清单截掉(eager 暴露是机制前提)。
 // 子调用复用正常执行管线:目标工具的 execute 自带超时/plan-gate/审批;loop 级权限规则在此以
 // predicate 复核(与 loop 同口径:工具名/剥前缀别名双候选,deny 拒、ask 按现网 ask 口径)。
  if (taskClassState.value === "coding") {
 // 子调用面排除 run_code 自身(禁递归)与 GUI_ONLY_TOOLS(无面板表面看不到/不该被 SDK 广告)。
    const guiOnly = new Set<string>(GUI_ONLY_TOOLS);
    const subTools = mainTools.filter((t) => t.name !== "run_code" && !guiOnly.has(t.name));
    mainTools.push(createCodeModeTool({
      tools: subTools,
      journal: journal as unknown as CodeModeJournal,
      sessionId: task.sessionId,
      taskId: task.id,
      permission: (name) => {
        if (!permRules) return true;
        const stripped = name.replace(/^(spawn_|run_|meeting_)/, "");
        const candidates = [name, ...(stripped !== name ? [stripped] : [])];
        for (const c of candidates) {
          const rule = evaluatePermission(c, "*", [permRules]);
          if (rule.action === "deny") return { allow: false, reason: `权限规则拒绝(${rule.permission}=deny)` };
          if (rule.action === "allow") return true;
        }
 // ask:与主 loop 口径一致(env GENIE_PERM_ASK_MODE=allow 或 mode=auto 放行,fail-closed 缺省)。
        const askAllow = process.env.GENIE_PERM_ASK_MODE === "allow" || permissionMode() === "auto";
        return askAllow ? true : { allow: false, reason: "权限规则为 ask 且无审批通道,按拒绝处理" };
      },
      executeSub: async (name, args, { signal }) => {
        const target = subTools.find((t) => t.name === name);
        if (!target) throw new Error(`未知工具:${name}`);
        return String(await target.execute(args, signal));
      },
    }));
  }
 // 工具注册身份治理:装配后统一登记身份,冲突/保留名命中从工具面剔除并留 journal 证据。
  const governedTools = governToolIdentity(mainTools, journal, task.sessionId);
  if (governedTools.length !== mainTools.length) mainTools.splice(0, mainTools.length, ...governedTools);
 // 档案工具面(与 runtime applyProfile 同口径):deny 优先,allow 非空即白名单;不新增工具。
 // 过滤后为空 → 下方既有「工具面非空门禁」fail-visible(装配 bug 不静默降级)。
  if (taskProfile?.tools) {
    const allow = taskProfile.tools.allow ?? [];
    const deny = new Set(taskProfile.tools.deny ?? []);
    const allowSet = allow.length > 0 ? new Set(allow) : undefined;
    const beforeNames = mainTools.map((t) => t.name);
    const kept = mainTools.filter((t) => !deny.has(t.name) && (!allowSet || allowSet.has(t.name)));
    if (kept.length !== mainTools.length) {
      mainTools.splice(0, mainTools.length, ...kept);
      try {
        journal.append({
          kind: "custom",
          sessionId: task.sessionId,
          payload: {
            what: "task.profile.tools",
            type: "task.profile.tools",
            taskId: task.id,
            profileId: taskProfile.id,
            before: beforeNames.length,
            after: kept.length,
            removed: beforeNames.filter((n) => !kept.some((t) => t.name === n)),
          },
        });
      } catch { /* 留痕失败不影响执行 */ }
    }
  }
 // 按 kind 能力位收敛主工具面(reminder/scheduled_task=只读+minimal;meeting=只读;
 // subagent/workflow=能力全开但记忆域=session)。默认 kind=user 全能力 → removed 为空,
 // 工具面逐字不变(兼容既有全部调用点)。
  const kindFilter = filterToolNamesByKindCapabilities(mainTools.map((t) => t.name), taskKindCaps);
  if (kindFilter.removed.length > 0) {
    const keep = new Set(kindFilter.kept);
    mainTools.splice(0, mainTools.length, ...mainTools.filter((t) => keep.has(t.name)));
    if (!taskKindToolsLogged.has(task.id)) {
      taskKindToolsLogged.add(task.id);
      try {
        journal.append({
          kind: "custom",
          sessionId: task.sessionId,
          payload: { what: "task.kind.tools", type: "task.kind.tools", taskId: task.id, kind: taskKindInfo.kind, removed: kindFilter.removed },
        });
      } catch { /* 留痕失败不影响执行 */ }
    }
  }
  if (mainTools.length === 0) {
    recordUser();
    const curGate = tm.get(task.id);
    if (curGate && (curGate.state === "running" || curGate.state === "blocked")) tm.setState(curGate, "failed", "主 agent 工具装配为空(tools=[])——拒绝以纯文本形态启动 loop(装配 bug fail-visible)");
    return;
  }
 // 表面/通道能力包:本 session 最后一条 client.surface 声明的能力位决定
 // ①输出契约(注入 instruction)②GUI 工具过滤 ③收尾降级。无声明=LEGACY:契约空串/工具原样/不降级。
  const surfacePlan = planTaskSurface(journal, task.sessionId, task.id, mainTools);
  journal.append({ kind: "task.progress", sessionId: task.sessionId, payload: { taskId: task.id, tools: surfacePlan.tools.map((t) => t.name), toolCount: surfacePlan.tools.length } });
 // 写前持久化屏障装配(config.agent.writeBarrier 透传;缺席/非法=undefined,loop 内部缺省 hard)。
  const writeBarrier = writeBarrierOf(agentConfig);
  const loop = new AgentLoop({
    journal,
    sessionId: task.sessionId,
    system: systemWithMemory,
 // system 的节视图( token 轮 04):让 loop 的 `[系统提示更新]` 只发变更节。
 // 不传=旧行为(整篇全文重发),故这一行本身就是「其它构造点零影响」的分界。
    systemSections,
    llm,
 // 执行 deadline 帽(冻结治理):自管工具(spawn/ask_user/terminal 等)豁免,
 // 其余 600s——防单工具挂死拖住整个 agent;详见 llm-loop-backend withToolDeadlineDefaults。
    tools: surfacePlan.tools,
 // 每次 chat 的全量 messages+响应落 .genie/llm-trace/<sessionId>/,journal 挂 llm.trace 指针。
    llmTrace: makeLlmTraceSink(journal),
    ...(streamSink ? { onStream: (ev: AgentStreamEvent) => streamSink(task.sessionId, ev) } : {}),
 // 权限传递:ask 处置收进 buildMainLoopPermission(mode=ask+面板在场→审批卡,不再静默 deny)。
    ...(permRules ? { permission: buildMainLoopPermission(permRules, permissionBroker, { sessionId: task.sessionId, journal }) } : {}),
 // 档案 maxSteps 覆盖在此生效(loop 与下方执行信封共用同一个 effectiveMaxSteps);无档案=逐字不变。
    maxSteps: effectiveMaxSteps, // 设置页可配+热读(上限 3000)
 // 写前持久化屏障(config.agent.writeBarrier):只显式传"off"|"hard";undefined 不写键(留给 loop 缺省 hard)。
    ...(writeBarrier ? { writeBarrier } : {}),
 //  图片 offload:装配方必须传,否则 loop 层整条分支不生效(生产默认关闭=改前行为)。
    imageOffload: imageOffloadOf(repoRoot()),
    todoReminderSteps: 6, // ZCode todo reminder:每 6 步提醒一次未完成计划(ephemeral)
 // 上下文再锚定:每 10 步注入一次 P0 落目标清单+证据覆盖率(ephemeral 不落 journal)。
 // 注意教训:长任务跑几十步后板上写的 P0 验收彻底脱离注意力,完工时无人核对(桌面 exe「首启引导」事故)。
    boardReminderSteps: 10,
 // J1 轨迹卡接线(2026-11 token 轮):runtime 已实现 emitTrajectory,装配处不传 opts 则永不落卡
 // (面板轨迹条恒空 + tips 的 ctx.trajectory 恒 undefined = P0 断线)。每 5 步或 phase 切换落一条
 // `task.trajectory`(payload 只有计数/比率/子目标,不含对话正文,零上下文影响)。
    trajectorySteps: 5, // :每 5 步(或 phase 切换)旁路落一条 task.trajectory 轨迹卡
    trajectoryTaskId: () => task.id,
    trajectoryMeta: () => ({ phase: phaseState.current, subgoal: currentSubgoal(journal, task.sessionId, task.instruction) }),
 // 轨迹 → 任务进度(J1 接线闭环,2026-11):emitTrajectory 真正 due 的那次(每 5 步/phase 切换)
 // 把 phase/step/note touch 进 TaskSupervisor,面板进度条与 task 卡据此更新。旁路:applyTrajectoryProgress
 // 内部吞异常且 tm 缺失即跳过——进度写失败绝不影响 turn 主链;不碰状态迁移(setState 调用点不改)。
    onTrajectory: (ev) => applyTrajectoryProgress(tm, task.id, ev),
 // 时间旅行:每步工具执行前拍「本步将要触碰的文件」快照(tNsM 对齐 stepId,回滚按它取)。
 // loop 已 await 本回调,读盘完成才放行工具;这里失败只 warn(时间旅行是旁路,不挂任务)。
    onStepToolPlan: async (p) => {
      try {
        const paths = collectSnapshotPaths(p.calls);
        if (paths.length === 0) return;
        const tt = new TimeTravelStore({ root: repoRoot() });
        const r = await tt.capture(task.sessionId, `t${p.turn}s${p.step}`, taskRoot, paths);
        if (!r.ok) console.warn("[time-travel] 快照采集失败:", r.code ?? "unknown");
      } catch (err) {
        console.warn("[time-travel] 快照旁路异常:", String(err).slice(0, 160));
      }
    },
 // 待决审批 ephemeral 注入( token 治理):见 parentAskBroker.onPending 注释——
 // 旧口径 message.user 永久落 journal,已了结的审批块滞留历史每次请求重放(2.7M token/日)。
 // 现改为每步现算:待决期间可见,应答/超时后 pending 清空 → 注入自然消失,历史零滞留。
    pendingQuestions: () => renderPendingQuestionsBlock(parentAskBroker.pending().slice(0, 8)) || null,
    boardReminder: async () => {
      try {
 // 任务类别锚:非编码类不推五阶段/白板——每 10 步只锚类别约定与更正路径;
 // 更正回 coding 后自动恢复完整阶段锚+P0 清单。
        if (taskClassState.value === "qa") {
          return "<system-reminder>本任务为问答/调研类:直接调查输出结论(结论先行+出处),不改代码不落板;需要改代码时 task_phase(taskClass=\"coding\") 更正。</system-reminder>";
        }
        if (taskClassState.value === "office") {
 // 作业思路板锚( 「办公任务也可以在白板上画作业思路(主题/受众/结构/
 // 章节/章间关系/顺序)」):office 已从软提醒改为硬闸,每 10 步锚一次出路(落板 / exemptReason)。
 // 既有断言文案(office-writing/开工四问/论点四段/人话写作/交付前自查)一字不动。
          return "<system-reminder>本任务为办公/产出类:动笔前先落**作业思路板**——board_upsert 传 boardType=\"composition\",画清:主题是什么/受众是谁/表达结构/要几章/每章主题/章与章之间什么关系、顺序如何(章间关系用 data 边 label 写关系词);确无表达结构才用 exemptReason 豁免(不许拿豁免代替思路板)。然后 skill_view 对应技能(office-writing + 对应格式);开工四问先答完(面向谁报告/主题一句话/重点 1~2 条与这次不讲什么/论据与分析来源);每个论点主张+论据+分析+结论四段齐全,写反证;人话写作;流程/结构/趋势画图;交付前自查;涉及改代码时 task_phase(taskClass=\"coding\") 更正。</system-reminder>";
        }
        if (taskRouteState.direct) {
          return "<system-reminder>本任务为直达实施路由(明确小改):聚焦改动本身,改前 impact 查影响面;发现范围超出单文件/局部 → 先落板(board_upsert)回归全流程;完成后照常 verify。</system-reminder>";
        }
 // 五阶段锚(防偏):reminder 开头带当前流程阶段——上下文再长,阶段锚每 10 步可见,
 // 模型偏离当前阶段该做的事时由此自我校正。阶段未声明过=提醒补声明(硬流程入口)。
        const curIdx = phaseState.current ? PHASES.findIndex((p) => p.key === phaseState.current) : -1;
        const phaseLine = curIdx >= 0
          ? `当前流程阶段:「${PHASES[curIdx]!.label}」(${curIdx + 1}/5)——只做本阶段该做的事;进入下一阶段用 task_phase 声明。`
          : `本任务尚未声明流程阶段——开工即调 task_phase(phase="understand") 进入五阶段流程(理解任务→规划→开始实施→开始验收→完成),不涉及的阶段用 skip:true 声明。`;
 // 板根对齐(修正):reminder 与 board_upsert/面板同根(boardStoreRoot=repoRoot),
 // 主根读不到再回退 taskRoot。旧 repoRoot/taskRoot 单根读在任务不在 harness 根时读不到板。
        const doc = await readTaskBoard();
        if (!doc) return "<system-reminder>" + phaseLine + "</system-reminder>";
        const cov = computeP0Coverage(doc);
        if (cov.total === 0) return "<system-reminder>" + phaseLine + "</system-reminder>";
        if (cov.passed >= cov.total) return "<system-reminder>" + phaseLine + "</system-reminder>"; // 全绿=只剩阶段锚(收尾靠 audit)
        const open = cov.nodes.filter((s) => !s.passed).map((s) => `${s.id}「${s.label}」`).join("、");
        return "<system-reminder>" + phaseLine + "P0 落目标尚未全部通过验收(" + cov.passed + "/" + cov.total + "):"
          + open + "。跑完一条验收就用 board_upsert action=evidence 回填(nodeId+evidence);"
          + "覆盖率未满之前不要宣称任务完成。</system-reminder>";
      } catch {
        return null;
      }
    },
 // tips 即时信息增强:代码意识/历史对齐/派发三类,做对应类别的事之前注入(一次为限)。
 // SOP 阶段信号接线(2026-11 tips SOP 化):loop 每 step 组装 tips ctx 时调 tipsPhase 取
 // phaseState.current,phase 首见 → SOP 行式卡恰时注入(见 buildLoopTips)。
    tipsPhase: () => phaseState.current,
    tips: loopTips,
 // 压缩钩子:与 spawn 子代理共用同一实例(2026-10-20 同源;构造见上方 taskCompactHook)。
    compactHook: taskCompactHook,
 // microcompact 阈值接线:与 spawn 子代理共用同一阈值(构造见上方 taskMicrocompact)。
    microcompact: taskMicrocompact,
 // 写时定形 spill(2026-11 token 轮 02):与 spawn 子代理同源(构造见上方 taskSpill)。
    spill: taskSpill,
 // 大结果入口闸门:与子代理同源(构造见上方 taskBigIntake)。
    bigIntake: taskBigIntake,
 // Phase 0 增长突增:与子代理同源;0=关闭。
    growthSpurtTokens: taskGrowthSpurtTokens,
 // Phase 1/2 模型评分:与子代理同源;默认本地 150M Jev。
    ...(taskModelScoring ? { modelScoring: taskModelScoring } : {}),
  });

 // 取消注册表登记:task.cancel → onChange → loop.cancel 贯通。
  activeLoops?.set(task.id, loop);
 //  轮末变更账本:基线在 try 外声明——终态出口在 finally,需跨块可见。
  let changeBaseline: Awaited<ReturnType<typeof captureBaseline>> | null = null;
  let changeLedgerStartSeq = -1;
 //  完成审计(2026-11):变更账本结果缓存——完成审计要在终态出口之前出一行「变更账本」，
 // 与 finally 的 turn.change-ledger 是同一份计算；缓存后只算一次，finally 复用（等价于原条件）。
  let changeLedgerCache: Awaited<ReturnType<typeof computeChangeLedger>> | null = null;
  const ensureChangeLedger = async () => {
    if (changeLedgerCache) return changeLedgerCache;
    if (!changeBaseline || changeLedgerStartSeq < 0) return null;
    try {
      changeLedgerCache = await computeChangeLedger({ root: taskRoot, baseline: changeBaseline, endEvents: journal.readSession(task.sessionId, changeLedgerStartSeq) });
    } catch { return null; }
    return changeLedgerCache;
  };
 //  指导可度量:任务窗口起点(与验证账本/变更账本同口径,开工水位);finally 里算指标用。
  let guidanceStartSeq = -1;
  try {
 // 核心纪律卡(起; 瘦身:只留系统纪律; 按任务类别出三版——
 // QA/办公任务不再被推着走五阶段/白板/plan-gate 仪式,类别可在理解阶段更正):
 // 系统提示在长任务后期注意力衰减,纪律卡跟着消息走——每轮可见,压缩后也随消息保留。
 // 只放硬纪律的短句形态(系统提示里有完整版);displayText 保持原文,面板不渲染此卡。
    const disciplineCard = taskClassState.value === "coding" ? [
      "## 核心纪律卡(系统纪律;直接执行,不要复述此段)",
      "- 五阶段流程:理解任务→规划→开始实施→开始验收→完成——每进入一阶段用 task_phase 声明(不涉及的用 skip:true);**阶段声明与其他工具同一步发出即可(task_phase 可与真实工作并行),不要为它单独走一步**;只做当前阶段该做的事",
      "- plan-gate 硬闸:本任务白板上还没有设计节点前,派写角色子代理/直写文件都会被拒——先规划落板(planner 或内联轻量板)",
      "- 输出简明扼要:结论先行、证据跟后;不长篇大论、不复述过程细节",
      "- 收尾纪律:P0 验收证据全绿前不宣称完成(收尾前 board_upsert action=audit 核对)",
      "- 交付物:本轮产出报告/截图/导出件等真实文件后,用 deliverable 登记路径(收尾自动核对存在性;改了代码就要重跑验证,否则收尾会提示)",
      "- 类别可降级:理解后发现本任务实为问答/调研或办公/产出类,task_phase(taskClass=\"qa\"/\"office\") 更正即免阶段/白板/plan-gate 仪式(2026-10-24 实测:办公任务未更正白交 278K token 仪式税)",
    ].join("\n")
      : taskClassState.value === "office" ? [
        "## 核心纪律卡(办公/产出类任务;直接执行,不要复述此段)",
        "- 动笔前先 skill_view:任何产出读 builtin/office-writing;PPT→office-pptx + ppt-master(生产环境/版式/能力边界),Word→office-docx,Excel→office-xlsx,周报/复盘/方案/调研→office-report",
        "- 要真正产出 .pptx 时派子代理:spawn_subagent(agentType=\"ppt-master\")——它带 board_export_pptx 质量门;自己只写 md 文档/表格不必派",
        "- **开工四问先答完**:①面向谁报告(谁看、能给几分钟、要拿它做什么决定)②汇报主题是什么(写成一句疑问句)③要突出的重点是哪 1~2 条、这次不讲哪 2~3 条 ④每个论点的论据与分析从哪来。答不上先 ask_user 或去查,不许边写边想",
        "- **论点四段齐全**:主张 + 可溯源论据(数字/来源/口径)+ 分析(因果或排除推理,不是把论据换个说法)+ 结论/所以呢;每条结论主动写反证(什么条件下不成立)",
        "- 先落**作业思路板**再动笔:board_upsert boardType=\"composition\"(主题/受众/表达结构/章节/章间关系与顺序);确无表达结构用 exemptReason 豁免——本任务免五阶段",
        "- 内容深度:每节必须落到具体事实(数字/名称/机制)+ 所以呢;只写标题与要点罗列=没交付",
        "- 人话写作:禁开场报幕(以下是/我将为您)、收尾谢幕(希望有帮助/综上所述)、过程自述(已为您完成)、空心副词(赋能/闭环/全面提升)",
        "- 图优先:流程/结构/时序/趋势一律画图(Markdown 用 mermaid 代码块,PPT 用原生形状与图表);表格只装结构化数据",
        "- 输出简明扼要:结论先行、证据跟后",
        "- 交付前自查:四问答完/论点四段齐全/内容完整/格式正确/无占位残留/该画图的画了",
        "- 交付物:每份交付文件都用 deliverable 登记路径(收尾自动核对存在性,声明后缺失会被点名)",
        "- 若过程涉及改代码:task_phase(taskClass=\"coding\") 更正,全套编码纪律(阶段/板/验收)即刻生效",
      ].join("\n")
      : [
        "## 核心纪律卡(问答/调研类任务;直接执行,不要复述此段)",
        "- 直接调查并输出结论:结论先行,出处(file:行号/链接)跟后——本任务免五阶段/白板/plan-gate 仪式,不改代码",
        "- 输出简明扼要,不复述过程细节",
        "- 若实际需要修改代码:task_phase(taskClass=\"coding\") 更正,全套编码纪律即刻生效",
      ].join("\n");
 // user message 只留用户需求+系统纪律。orient/经验/devlog/历史档案
 // 四块改由 loopTips 按动作类别即时注入(understand/plan 阶段或首触对应工具),不再开工全塞。
    let instruction = task.instruction + "\n\n" + disciplineCard;
 // 能力位输出契约(legacy="" 不注入,零变化);task.surface 开工一次落账
 // (taskId/sessionId/caps/source/filteredTools/contractApplied,读侧取最新一条)。
    if (surfacePlan.contract) instruction += "\n\n" + surfacePlan.contract;
    try { journal.append({ kind: "custom", sessionId: task.sessionId, payload: surfacePlan.journalPayload }); } catch { /* 留痕失败不影响开工 */ }
 // ── 执行信封:开工前比对签发时的能力目录/策略 ──────────────────────────
 // 有信封且漂移/篡改 → 任务 failed(403 文案)+ journal task.envelope {ok:false,code},不起 loop;
 // 无信封(内部 user 任务)→ verifyTaskEnvelopeAtStart 返回 undefined,逐字零变化。
    try {
      const capCurrent: CapabilitySnapshot = envelopeDeps?.capabilitySnapshot?.() ?? {
        toolsets: surfacePlan.tools.map((t) => t.name),
        commands: BUILTIN_COMMANDS.map((c) => c.name),
      };
      const policyCurrent: EnvelopePolicy = envelopeDeps?.policy?.() ?? {
        approval: permissionMode(),
        maxIterations: effectiveMaxSteps,
      };
      const envelopeGate = verifyTaskEnvelopeAtStart({
        journal: journal as unknown as EnvelopeStartJournal,
        taskManager: tm,
        task,
        current: { capabilitySnapshot: capCurrent, policy: policyCurrent },
      });
      if (envelopeGate && !envelopeGate.ok) return;
 // 校验通过=本任务实际装配的目录成为「当前能力目录」,供后续签发/校验对齐。
      if (envelopeGate?.ok) recordCapabilitySurface(capCurrent.toolsets, capCurrent.commands);
    } catch (err) {
      try {
        journal.append({
          kind: "custom",
          sessionId: task.sessionId,
          payload: { type: "task.envelope", taskId: task.id, ok: false, code: "ENVELOPE_VERIFY_ERROR", note: String(err).slice(0, 200) },
        });
      } catch { /* 留痕失败不阻断开工 */ }
    }
 // ── 开工前置门(────────────────────────────────────────────
 // 两段都在任务窗口起点(taskStartSeq)之前落账,任务窗口包含前置门事件;两段各自 try/catch 兜底:
 // 前置门自身异常绝不影响开工(最多少一条注入,不会拦任务)。
 // a. 基线新鲜度:非 coding/GENIE_FRESHNESS=off/配置关闭 → skipped;behind 且 blockOnBehind
 // (缺省 true,env GENIE_FRESHNESS_BLOCK=off 或配置可降级)→ 拦在首轮 runTurn 之前。
    const freshCfg: FreshnessConfig = (agentConfig as { agent?: { startupFreshness?: FreshnessConfig } } | undefined)?.agent?.startupFreshness ?? {};
    try {
      const skip = planFreshnessSkip({ taskClass: taskClassState.value, cfg: freshCfg });
      if (skip.skip) {
        journal.append({
          kind: "custom",
          sessionId: task.sessionId,
          payload: {
            type: "task.freshness",
            taskId: task.id,
            state: "skipped",
            reason: skip.reason,
            ...(skip.reason === "taskClass" ? { taskClass: taskClassState.value } : {}),
          },
        });
      } else {
        const freshStatus = readBaselineStatus({
          repoRoot: taskRoot,
          ...(freshCfg.maxAheadCommits !== undefined ? { maxAhead: freshCfg.maxAheadCommits } : {}),
          ...(freshCfg.fetch !== undefined ? { fetch: freshCfg.fetch } : {}),
          ...(freshCfg.timeoutMs !== undefined ? { timeoutMs: freshCfg.timeoutMs } : {}),
        });
        const action = planFreshnessAction(freshStatus, freshCfg);
        const freshBase = {
          type: "task.freshness",
          taskId: task.id,
          state: freshStatus.state,
          behind: freshStatus.behind,
          ahead: freshStatus.ahead,
          baseRef: freshStatus.baseRef,
          upstreamRef: freshStatus.upstreamRef,
          fetched: freshStatus.fetched,
          ...(freshStatus.note !== undefined ? { note: freshStatus.note } : {}),
        };
        if (action.effect === "blocked") {
          journal.append({ kind: "custom", sessionId: task.sessionId, payload: { ...freshBase, effect: "blocked", ...(action.note ? { gateNote: action.note } : {}) } });
          const curFresh = tm.get(task.id);
          if (curFresh && (curFresh.state === "running" || curFresh.state === "blocked")) {
            tm.setState(curFresh, "failed", action.message ?? "[开工前置门] 本地基线落后上游,拒绝在旧基线上开工。");
          }
          return;
        }
        journal.append({
          kind: "custom",
          sessionId: task.sessionId,
          payload: { ...freshBase, ...(action.effect === "warn-block-override" ? { effect: action.effect } : {}), ...(action.note ? { gateNote: action.note } : {}) },
        });
        instruction += "\n\n" + renderFreshnessLine(freshStatus);
        if (action.effect === "warn-block-override" && action.message) instruction += "\n\n" + action.message;
      }
    } catch (err) {
      try {
        journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "task.freshness", taskId: task.id, state: "unknown", reason: `gate-error: ${String(err).slice(0, 200)}` } });
      } catch { /* 前置门留痕失败不影响开工 */ }
    }
 // b. 规则旧措辞:仓根或任务根有 .genie/rule-wording.json 才扫;坏表/命中都只留痕+注入提示,不拦开工。
    try {
      const wordingRoot = existsSync(_join(taskRoot, ".genie", "rule-wording.json")) ? taskRoot : repoRoot();
      const table = loadWordingTable(wordingRoot);
      if (!table.ok) {
        journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "rule.wording", taskId: task.id, hits: 0, error: table.error } });
      } else if (table.rules.length > 0) {
        const scan = scanRuleWording({ repoRoot: wordingRoot, rules: table.rules });
        if (!scan.ok) {
          journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "rule.wording", taskId: task.id, hits: 0, error: scan.error ?? "scan-failed" } });
        } else if (scan.hints.length > 0) {
          journal.append({
            kind: "custom",
            sessionId: task.sessionId,
            payload: { type: "rule.wording", taskId: task.id, hits: scan.hints.length, samples: scan.hints.slice(0, 10) },
          });
          instruction += "\n\n" + renderWordingLines(scan.hints);
        }
      }
    } catch { /* 旧措辞扫描失败不影响开工 */ }
 // 验证账本水位:任务窗口起点=开工时全局水位;收尾用 readSession(sid, startSeq)
 // 只取本任务事件(不全量 readAll,免 30MB 会话重扫,也不会把上一任务的验证算进来)。
    const taskStartSeq = journal.length;
 // M26续跑身份护栏:开工时快照会话目标的修订号(与 taskStartSeq 同段)。终态调
 // maybeContinueGoal 时仅在非 null 才作为 expectedRevision 传入——任务运行期间 goal 被 clear/replace
 // (每条 goal.set 使 revision+1)→ 续跑被 GOAL_REVISION_STALE 拒,不会把旧任务的进展接到新目标上。
 // 无目标 / 读失败 = null(不阻塞开工)。用 readSession(会话索引切片),不为此全量 readAll。
    let taskStartGoalRevision: number | null = null;
    try {
      const { readGoalFromJournal: readGoalAtStart } = await import("@lampgenie/runtime/agent/goal");
      taskStartGoalRevision = readGoalAtStart(journal.readSession(task.sessionId), task.sessionId)?.revision ?? null;
    } catch { taskStartGoalRevision = null; }
 //  指导可度量:同一水位(本任务窗口起点)供收尾 guidance.metrics 切片。
    guidanceStartSeq = taskStartSeq;
 //  轮末变更账本:开工建 git 基线(异步 execFile,不阻塞事件循环);失败=null 不阻塞任务。
    changeLedgerStartSeq = taskStartSeq;
    try { changeBaseline = await captureBaseline(taskRoot); } catch { changeBaseline = null; }
 // 任务开工审计锚:类别/纪律卡版本/系统提示指纹/纪律段在场标志一次性落账——
 // 其它 agent 审「提示词是否按类加载正确」读这一条即确定性答案,不必解包 llm.trace 全文。
    try {
      const sys = String(systemWithMemory ?? "");
      journal.append({
        kind: "task.context",
        sessionId: task.sessionId,
        payload: {
          taskId: task.id,
          taskClass: taskClassState.value,
          card: taskClassState.value === "coding" ? "coding 版" : taskClassState.value === "office" ? "office 版" : "qa 版",
 // 观测修复:coding+短任务书走 SYSTEM_LITE(五阶段/plan-gate/验收段落被有意
 // 裁掉)时,下方 flags 全 false 是**精简档的正常形态**——不记 lite 字段时审计者无法区分
 // 「精简档(正常)」与「提示词组装 bug(段落丢了)」。lite=true 即可一票定案。
          lite: taskClassState.value === "coding" && liteMode,
 // 全链路变更判据:changeScope=surface 表示本任务是替换/迁移类,
 // surfaceItems=启动时盘点清单的命中行数(0=还没盘点,plan-gate 会拦写操作)。
          changeScope: surfaceScopeThisTask().scope,
          surfaceItems: readChangeSurfaceManifest(journal, task.sessionId, task.id)?.hits ?? 0,
 // 与 system.prompt 快照同一算法(同一个纯函数产出 sha,不会再漂)。
          systemSha: systemPromptSha(sys),
          systemChars: sys.length,
          flags: {
            fivePhase: sys.includes("五硬阶段流程"),
            planGate: sys.includes("规划委托纪律"),
            verify4: sys.includes("完工验收四步"),
            senseUsage: sys.includes("code_sense 用法"),
          },
        },
      });
 // system 提示词快照(token 轮 P1,designs/token-opt-round3-p1 §3 01):当轮 system 全文落一条,
 // 同 session 同 sha 只落一条(loop 侧取首条非截断快照冻结 node0;后续变更转 in-history 追加)。
 // 与上面的审计锚同一 sys / 同一 sha 口径;失败不影响任务(缺快照=loop 退回 opts.system)。
      recordSystemPromptSnapshot(journal, task.sessionId, sys);
    } catch { /* 审计锚/快照失败不影响任务 */ }
    const out = await loop.runTurn(instruction + attachmentBlock, visionImages.length ? visionImages : undefined, {
 // 面板显示原始输入(注入块只喂模型,不再污染用户消息展示)。
      displayText: task.instruction,
      ...(task.attachments?.length ? { attachments: task.attachments } : {}),
    });
    const cur = tm.get(task.id);
    if (cur && (cur.state === "running" || cur.state === "blocked")) {
 // 同族双写:loop 已为每个 step 落 message.agent——仅当本轮没有任何 agent 消息
 // (如 pre-step 拦截直接返回空)才补终稿;否则面板把回复渲染两遍("收到/收到")。
      const events = journal.readAll();
      const lastTurn = [...events].reverse().find((e) => e.kind === "turn.start" && e.sessionId === task.sessionId);
      const hasAgent = lastTurn
        ? events.some((e) => e.kind === "message.agent" && e.sessionId === task.sessionId && (e.seq ?? 0) > (lastTurn.seq ?? 0))
        : false;
      if (!hasAgent) journal.append({ kind: "message.agent", sessionId: task.sessionId, payload: { text: String(out ?? "") } });
 // plan-gate 收尾校验(防目标丢失最后一道,代码级):板在场但 P0 未全绿——
 // 任务虽可完成,outcome 必须显式标注(fail-visible;不硬 block 防死锁,但目标状态不可谎报)。
      const finBoard = await planBoard();
      let finalOut = out;
      if (finBoard) {
 // 规划质量结构化留痕(B2 P2):任务结算即带 boardType/内容节点数/P0 覆盖率/锚密度,
 // 面板/telemetry 直接读这一条,不用重放板。与 audit 出口的 planQuality 同源(planQualityOf)。
 // bq3(遥测闭环):骨架采纳维度并入 planQuality,同一 pqObj 落 task.quality
 // 与任务对象 cur.planQuality(tm.get 活引用,setState 前挂上即随 done 带出到 task.detail.get)。
        try {
          const pqObj: { boardType: string | null; nodes: number; contentNodes: number; p0: { passed: number; total: number; rate: number }; anchorDensity: number; skeleton?: { generated: number; survived: number; adoptionRate: number } } = { ...planQualityOf(finBoard as never) };
          const skAdopt = computeSkeletonAdoption(
            (finBoard as { nodes?: readonly unknown[] }).nodes ?? [],
            journal.readAll().filter((e) => e.kind === "board.skeleton" && e.sessionId === task.sessionId),
          );
          if (skAdopt) pqObj.skeleton = skAdopt;
          journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "task.quality", taskId: task.id, planQuality: pqObj } });
          (cur as { planQuality?: unknown }).planQuality = pqObj;
        } catch { /* 留痕失败不影响收尾 */ }
        const cov = computeP0Coverage(finBoard);
        if (cov.total > 0 && cov.passed < cov.total) {
          const openList = cov.nodes.filter((n) => !n.passed).map((n) => `${n.id}「${n.label}」`).join("、");
          finalOut = `${out}\n\n[plan-gate 收尾警示] P0 落目标未全覆盖(${cov.passed}/${cov.total}):${openList}——收口门未过。需要继续时用后续任务推进并 board_upsert action=evidence 回填证据。`;
          try {
            journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "plan.gate", effect: "p0-open-at-done", passed: cov.passed, total: cov.total, planQuality: planQualityOf(finBoard as never) } });
          } catch { /* 留痕失败不影响收尾 */ }
        }
      }
 // 全链路收尾审计:
 // surface 任务在最终 answer 前应有 passed 的 change.audit;没有/未通过 → 回执警告 +
 // 验收摘要标记「未通过全链路审计」(不硬杀任务,但状态可审计,不许静默宣称完成)。
 // 第二批:agent.changeAudit = hard|warn|off(env GENIE_CHANGE_AUDIT 优先),
 // hard 时还需验收证据全通过 + 无 warning 级语义孤儿;不满足先补跑一轮审计,仍不满足 → failed。
      const changeAuditMode = String(
        process.env.GENIE_CHANGE_AUDIT
          ?? (agentConfig?.agent as { changeAudit?: string } | undefined)?.changeAudit
          ?? "warn",
      );
      const closeAuditOnce = (hard: boolean) => closeAuditVerdict({
        taskClass: taskClassState.value,
        instruction: String(task.instruction ?? ""),
        manifest: readChangeSurfaceManifest(journal, task.sessionId, task.id),
        audit: readChangeAudit(journal, task.sessionId, task.id),
        directRoute: taskRouteState.direct,
        hard,
      });
      const surfaceClose = changeAuditMode === "off" ? { warn: false, mark: "", text: "", hardFail: false } : closeAuditOnce(changeAuditMode === "hard");
      if (surfaceClose.hardFail) {
 // 先原地补跑一轮:把「缺什么」明确告诉模型(补跑前落 change.audit.retry)。
        const beforeMark = surfaceClose.mark;
        let retryErr = "";
        try {
          journal.append({
            kind: "custom", sessionId: task.sessionId,
            payload: { type: "change.audit.retry", taskId: task.id, mark: beforeMark, reason: surfaceClose.text.slice(0, 300) },
          });
        } catch { /* 留痕失败不影响补跑 */ }
        try {
          const retryOut = await loop.runTurn(
            `[全链路审计补跑] 收尾审计未通过:${surfaceClose.text.slice(0, 600)}\n先跑 change_surface(action="audit", verify={e2e:[{command,passed,output?}], negatives:[{assertion,passed,evidence?}]}) 并处理语义孤儿(findings 里 warning/blocker 必须接线或删除),再汇报。`,
          );
          if (retryOut) finalOut = retryOut;
        } catch (e: unknown) {
 // 二次 runTurn 不安全(消息历史/循环状态不允许):跳过补跑,直接判失败并写明原因。
          retryErr = String(e instanceof Error ? e.message : e).slice(0, 200);
        }
        const after = closeAuditOnce(true);
        if (after.hardFail) {
          const detail = after.mark.replace(/^未通过全链路审计\(?/, "").replace(/\)$/, "");
          const reason = `未通过全链路审计(${detail}${retryErr ? `;补跑审计失败:${retryErr}` : "补跑一轮后仍不满足"})`;
          try {
            journal.append({
              kind: "custom", sessionId: task.sessionId,
              payload: { type: "change.audit.hard-fail", taskId: task.id, mark: after.mark, reason: reason.slice(0, 400), retried: retryErr === "", retryError: retryErr || null },
            });
          } catch { /* 留痕失败不影响终态 */ }
 // 代码改动不回滚(人可继续用后续任务修);任务终态如实 failed,不许静默 done。
          tm.setState(cur, "failed", reason);
          return;
        }
        if (after.warn) finalOut = `${finalOut}\n\n${after.text}\n[验收摘要标记] ${after.mark}`;
      } else if (surfaceClose.warn) {
 // 标记同时进正文(不只是结构化字段):人读终稿就能看到「未通过全链路审计」,
 // journal 侧再落一条 change.audit.missing 供遥测聚合。
        finalOut = `${finalOut}\n\n${surfaceClose.text}\n[验收摘要标记] ${surfaceClose.mark}`;
        try {
          const m = readChangeSurfaceManifest(journal, task.sessionId, task.id);
          const au = readChangeAudit(journal, task.sessionId, task.id);
          journal.append({
            kind: "custom", sessionId: task.sessionId,
            payload: { type: "change.audit.missing", taskId: task.id, mark: surfaceClose.mark, manifestItems: m?.hits ?? 0, auditPassed: au?.passed ?? null },
          });
        } catch { /* 留痕失败不影响收尾 */ }
      }
 // ── /// 公共收尾聚合(抽公共函数,三条链同源)──────────
      const verifyMode = String(
        process.env.GENIE_VERIFY_ON_STOP
          ?? (agentConfig?.agent as { verifyOnStop?: string } | undefined)?.verifyOnStop
          ?? "warn",
      );
      const citationMode = String(
        process.env.GENIE_CITATION_AUDIT
          ?? (agentConfig?.agent as { citationAudit?: string } | undefined)?.citationAudit
          ?? "warn",
      );
      const completionMode = String(
        process.env.GENIE_COMPLETION_AUDIT
          ?? (agentConfig?.agent as { completionAudit?: string } | undefined)?.completionAudit
          ?? "warn",
      );
      const boardFacts = ((): CompletionFacts["board"] => {
        try {
          const cov = finBoard ? computeP0Coverage(finBoard) : null;
          const p0Nodes = finBoard
            ? finBoard.nodes.filter((n) => !String(n.id).startsWith("ph-") && n.phase === "P0")
            : [];
          return {
            hasBoard: !!finBoard,
            p0Total: cov?.total ?? 0,
            p0Passed: cov?.passed ?? 0,
            staleEvidence: cov?.stale.length ?? 0,
 // 负面断言=协议 BoardAccept.type==="negative"(「旧入口不可达」这类验收)。
            hasNegativeAccept: p0Nodes.some((n) => (n.accept ?? []).some((a) => a.type === "negative")),
          };
        } catch {
          return undefined;
        }
      })();
      const changeFacts = ((): CompletionFacts["change"] => {
        try {
          const scope = surfaceScopeThisTask().scope;
          const manifest = readChangeSurfaceManifest(journal, task.sessionId, task.id) !== null;
          const audit = readChangeAudit(journal, task.sessionId, task.id);
          return {
            scope: scope === "surface" ? "surface" : "normal",
            manifest,
            auditPassed: audit?.passed === true,
            verified: audit?.verified === true,
            negativeAssertions: audit?.verifyNegatives.n ?? 0,
          };
        } catch {
          return undefined;
        }
      })();
      const ledgerBefore = await ensureChangeLedger();
      const ledgerFacts = ledgerBefore
        ? { changed: ledgerBefore.changed.length, unknown: ledgerBefore.unknown.length, oversized: ledgerBefore.oversized.length }
        : undefined;
 // :surface 任务收尾前对变更概念重扫一次,残留事实进 changeFacts.residual。
 // 非 surface / 无清单 = 零额外 IO;扫描失败显式标记 SCAN_UNAVAILABLE,不阻塞收尾。
      const residualFact = await (async (): Promise<ResidualFact | undefined> => {
        try {
          if (changeAuditMode === "off") return undefined;
          if (surfaceScopeThisTask().scope !== "surface") return undefined;
          const m = readChangeSurfaceManifest(journal, task.sessionId, task.id);
          const concepts = (m?.concepts ?? []).filter((c) => typeof c === "string" && c.trim() !== "");
          if (!m || !concepts.length) return undefined;
 // 清单条目(change.surface 事件自带 manifest/entries 时才有;旧事件没有=只查命中)。
          let manifest: unknown[] = [];
          try {
            const evs = journal.readAll().filter(
              (e) => e.kind === "custom" && e.sessionId === task.sessionId
                && (e.payload as { type?: string } | undefined)?.type === "change.surface",
            );
            const p = evs.length
              ? (evs[evs.length - 1]!.payload as { taskId?: string; manifest?: unknown; entries?: unknown } | undefined)
              : undefined;
            if (p && p.taskId === task.id) {
              manifest = Array.isArray(p.manifest) ? p.manifest : Array.isArray(p.entries) ? p.entries : [];
            }
          } catch {
 /* 无条目=只查命中 */
          }
          try {
            const report = await scanSurface(taskRoot, concepts);
            return {
              concept: concepts.join(", "),
              manifest: manifest as ResidualFact["manifest"],
              hits: report.hits.map((h) => ({ file: h.file, line: h.line, text: h.text })),
              rescanAt: Date.now(),
            };
          } catch {
            return { code: "SCAN_UNAVAILABLE", concept: concepts.join(", "), manifest: [], hits: [], rescanAt: Date.now() };
          }
        } catch {
          return undefined;
        }
      })();
      const closeout = await runTaskCloseout({
        journal,
        sessionId: task.sessionId,
        taskId: task.id,
        root: taskRoot,
        taskStartSeq,
        state: "done",
        finalText: finalOut,
        taskClass: taskClassState.value,
        instruction: String(task.instruction ?? ""),
        ...(boardFacts ? { boardFacts } : {}),
        ...(changeFacts ? { changeFacts: { ...changeFacts, ...(residualFact ? { residual: residualFact } : {}) } } : {}),
        ...(ledgerFacts ? { ledgerFacts } : {}),
        mode: "main",
        modes: { verify: verifyMode, citation: citationMode, completion: completionMode, change: changeAuditMode },
        retryTurn: (prompt: string) => loop.runTurn(prompt),
      });
      finalOut = closeout.finalText;
      if (closeout.hardFail) {
 // hard 模式补跑后仍不满足:代码/引用不回滚,任务终态如实 failed(与旧行为一致)。
        tm.setState(cur, "failed", closeout.hardFail.reason);
        return;
      }
 // task.context 快照刷新:开工那条记的是启动时事实(盘点还没发生=0),
 // 收尾再落一条同 type 事件带上最终 surfaceItems/审计结论——读取方取最后一条即最新事实。
      try {
        const m = readChangeSurfaceManifest(journal, task.sessionId, task.id);
        const au = readChangeAudit(journal, task.sessionId, task.id);
        if (m) {
          journal.append({
            kind: "task.context", sessionId: task.sessionId,
            payload: {
              taskId: task.id, taskClass: taskClassState.value, phase: "close",
              changeScope: surfaceScopeThisTask().scope, surfaceItems: m.hits,
              surfaceAudit: au ? { passed: au.passed, unexplained: au.unexplained } : null,
            },
          });
        }
      } catch { /* 留痕失败不影响收尾 */ }
 // 任务终态档案:instruction+五阶段轨迹+板摘要+结果——compact 恢复与 planner 复用的数据源。
      try {
        const phases = journal.readAll().filter((e) => e.sessionId === task.sessionId && e.kind === "custom" && (e.payload as { type?: string } | undefined)?.type === "task.phase")
          .map((e) => { const pp = e.payload as { phase?: string; note?: string; skip?: boolean }; return { phase: String(pp.phase ?? ""), note: String(pp.note ?? "").slice(0, 80), ...(pp.skip === true ? { skip: true } : {}) }; });
        const bd = await planBoard();
        const cov = bd ? computeP0Coverage(bd) : null;
        appendTaskArchive(taskRoot, {
          at: Date.now(), sessionId: task.sessionId, taskId: task.id, state: "done",
          instruction: String(task.instruction ?? "").slice(0, 200), phases,
          result: String(finalOut ?? "").slice(0, 600),
          ...(bd ? { board: { title: bd.title.slice(0, 60), nodeTitles: bd.nodes.filter((n) => !String(n.id).startsWith("ph-")).map((n) => String(n.label).slice(0, 30)).slice(0, 15), ...(cov && cov.total > 0 ? { p0Total: cov.total, p0Passed: cov.passed } : {}) } } : {}),
        });
      } catch { /* 档案失败不影响收尾 */ }
 // 收尾降级(显式,不静默):最终输出超表面 maxChars → 截断+追加标记,
 // 并 journal surface.degraded {originalChars,maxChars,degradedChars}。
 // 交付/投递用同一文本;legacy(无任何声明)不降级=改动前行为逐字不变。
      finalOut = degradeFinalFor(journal, task.sessionId, task.id, surfacePlan.caps, finalOut).text;
      tm.setState(cur, "done", finalOut);
    }
 // 终态提炼(异步不阻塞:done 后台沉淀经验;前台优先=下个任务到来不等待)
    trackPostTerminal(task.sessionId, distillFromTask(getExperienceStore(), journal, { ...task, state: "done", result: out }));
 // 记忆学习:会话终态→extractor+observer(内部门控:少 user 轮不跑)。
    if (memory) {
      const transcript = journal.readAll()
        .filter((e) => e.sessionId === task.sessionId && (e.kind === "message.user" || e.kind === "message.agent"))
        .map((e): { role: "user" | "assistant"; content: string } => ({ role: e.kind === "message.user" ? "user" : "assistant", content: String((e.payload as { text?: string }).text ?? "") }));
      trackPostTerminal(task.sessionId, memory.onSessionClose({ ownerId: "local", sessionId: task.sessionId, transcript }));
    }
 // goal 续跑循环(ZCode target-continuation-loop 移植):任务终态→完成校验器
 //(LLM JSON 裁决,fail-open)→未通过且预算未尽→自动派下一轮续跑任务。
 // :带任务开工时快照的目标修订号(无目标=不传),目标被 clear/replace → 拒续跑。
    void maybeContinueGoal(tm, journal, llm, task.sessionId, taskStartGoalRevision !== null ? { expectedRevision: taskStartGoalRevision } : {}).catch(() => {});
  } catch (err) {
    const cur = tm.get(task.id);
    if (cur && (cur.state === "running" || cur.state === "blocked")) {
 // F5 失败轮沉淀(failed→incidents candidate;确定性兜底,LLM 缺席不阻塞)。
      void distillFromTask(getExperienceStore(), journal, { ...task, state: "failed", result: String(err).slice(0, 400) }).catch(() => {});
      try { appendTaskArchive(taskRoot, { at: Date.now(), sessionId: task.sessionId, taskId: task.id, state: "failed", instruction: String(task.instruction ?? "").slice(0, 200), phases: [], result: String(err).slice(0, 400) }); } catch { /* 档案失败不影响收尾 */ }
      tm.setState(cur, "failed", String(err));
    }
  } finally {
    activeLoops?.delete(task.id);
 // ── / 收尾聚合(抽公共函数,与终态路径同一实现)──────────────
    try {
      const st = tm.get(task.id)?.state;
      const closeoutState: CloseoutState = st === "failed" || st === "cancelled" ? st : "done";
      await runTaskCloseout({
        journal,
        sessionId: task.sessionId,
        taskId: task.id,
        root: taskRoot,
        taskStartSeq: changeLedgerStartSeq >= 0 ? changeLedgerStartSeq : 0,
        state: closeoutState,
        finalText: "",
        mode: "main",
        ...(changeBaseline ? { baseline: changeBaseline } : {}),
        steps: ["m16", "m23"],
      });
    } catch { /* 账本/指标失败不影响终态 */ }
 // ──  后台 job 回收──────────────────────────────────────────
 // 任务终态(done/failed/取消)回收本会话 owner 与绑定到该会话的子代理 owner 的 running job
 //(标 killed 并只通知一次);disposeSessionJobs 内部吞异常,回收失败不影响终态。
    await disposeSessionJobs(journal, task.sessionId);
  }
}
