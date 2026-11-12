/**
 * agent-wiring 分片:deadline-wire(自 agent-wiring.ts 7910 行按域拆分,逐字搬移)。
 * 原路径 agent-wiring.ts 保留具名转发 barrel;消费方零改动。
 */
import { runWithAgent } from "./run-with-agent.js";
import { bindOwnerRegistry, bgAgents } from "./wiring-core.js";
import { archLlmFromProvider } from "./workflow-task.js";
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
export function mainRequestMaxTokens(llm: LlmProvider): number | undefined {
  const d = (llm as { describe?: () => Record<string, unknown> }).describe?.();
  const v = d?.maxTokens;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

/** 子代理时间盒解析(纯函数,单测锁契约):显式参数 > 全局 subagentDeadlineMin > planner 专属缺省。
 * planner 未配置时缺省 8 分钟(可经 agent.plannerDeadlineMin=0 关闭),防一个慢 planner 长期
 * 占住 TaskSupervisor 全局并发槽,导致大批任务排队看起来「挂住」;其他角色未配置=不限时(旧口径)。 */
export function resolveSubagentDeadlineMin(
  agentType: string | undefined,
  explicit: unknown,
  cfg?: { subagentDeadlineMin?: number; plannerDeadlineMin?: number },
): number {
  const explicitN = Number(explicit);
  if (Number.isFinite(explicitN) && explicitN > 0) return explicitN;
  const globalN = Number(cfg?.subagentDeadlineMin ?? 0);
  if (Number.isFinite(globalN) && globalN > 0) return globalN;
  if (String(agentType ?? "").toLowerCase() !== "planner") return 0;
  const plannerN = cfg?.plannerDeadlineMin;
 // 按 14 天复盘调数(docs/analysis/planner-reaper-review.md):正常完成组 p50=5.0/p90=9.2 分钟,
 // 19.2%(19/99)超 8 分钟——缺省 8 对约 1/5 正常任务偏紧,抬到 10 覆盖 p90;时间锚纪律同批进 PLANNER_PROMPT。
  if (plannerN === undefined) return 10;
  const n = Number(plannerN);
  return Number.isFinite(n) ? Math.max(0, n) : 10;
}

/** 轨迹卡子目标(J1 轨迹卡,2026-11 token 轮):给 `task.trajectory` 的 subgoal 取一行短文本。
 * 取数口径(优先级从高到低):
 * ① journal 该 session 最近一条 `todo.updated` 里第一个未完成项(in_progress/pending)的 content;
 * ② 没有计划(或最近一条计划已全完成)→ 退化为任务书首句:instruction 压平换行取前 40 字;
 * ③ 都没有 → ""。
 * 这是**旁路元数据**:任何读取/解析异常一律兜底成 ""——轨迹元数据故障绝不打断主链。 */
export function currentSubgoal(journal: Journal, sessionId: string, instruction: unknown): string {
  try {
    const events = journal.readSession(sessionId);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind !== "todo.updated") continue;
      const items = ((e.payload as { items?: { content?: unknown; status?: unknown }[] } | null)?.items ?? []);
      const open = items.find((it) => it?.status === "in_progress" || it?.status === "pending");
      const text = String(open?.content ?? "").trim();
      if (text) return text.slice(0, 60);
      break; // 最近一条计划已全完成:不再回溯更早的计划(已被新计划取代)
    }
    const firstLine = String(instruction ?? "").replace(/\s+/g, " ").trim();
    return firstLine.slice(0, 40);
  } catch {
    return ""; // 轨迹元数据故障绝不打断主链
  }
}

/** 开工信封闸用到的 journal 最小面(真 Journal 也满足;测试可传假 journal)。 */
export interface EnvelopeStartJournal {
  append(e: { kind: "custom"; sessionId: string; payload: Record<string, unknown> }): unknown;
  readSession(sessionId: string): readonly { kind?: string; payload?: unknown }[];
}

function failTaskForEnvelope(
  deps: { taskManager: Pick<TaskSupervisor, "get" | "setState">; task: Task },
  reason: string): void {
  const cur = deps.taskManager.get(deps.task.id) ?? deps.task;
 // 只有 queued/running 能迁到 failed(blocked 的合法出口不含 failed;状态机不允许就跳过,靠 journal 留证)
  if (cur.state !== "queued" && cur.state !== "running") return;
  try { deps.taskManager.setState(cur, "failed", reason); } catch { /* 状态已被别处改走=不覆盖 */ }
}

/**
 * 开工前信封校验:取该 task 最近一条 task.envelope.issued → verify(当前能力目录/策略)。
 * - 无信封:返回 undefined(内部任务零变化,不写 journal);
 * - 漂移/篡改/结构非法:journal task.envelope {ok:false,code} + 任务 failed(403 文案)+ 返回 ok:false;
 * - 全等:journal task.envelope {ok:true} + 返回 ok:true。
 */
export function verifyTaskEnvelopeAtStart(deps: {
  journal: EnvelopeStartJournal;
  taskManager: Pick<TaskSupervisor, "get" | "setState">;
  task: Task;
  current: EnvelopeCurrent;
}): { ok: boolean; code?: string } | undefined {
  let lookup: IssuedEnvelopeLookup;
  try {
    lookup = findIssuedEnvelope(deps.journal.readSession(deps.task.sessionId), deps.task.id);
  } catch {
    return undefined; // journal 不可读=不拦开工(信封闸自身异常不改变原路径)
  }
  if (lookup.kind === "none") return undefined;
  if (lookup.kind === "invalid") {
    const code = "ENVELOPE_INVALID";
    try {
      deps.journal.append({ kind: "custom", sessionId: deps.task.sessionId, payload: { type: "task.envelope", taskId: deps.task.id, ok: false, code } });
    } catch { /* 留痕失败不阻断失败判定 */ }
    failTaskForEnvelope(deps, `[执行信封] 403 信封结构非法,拒绝开工(${code});请重新投递。`);
    return { ok: false, code };
  }
  const envelope = lookup.envelope;
  const verdict = verifyEnvelope(envelope, deps.current);
  try {
    deps.journal.append({
      kind: "custom",
      sessionId: deps.task.sessionId,
      payload: verdict.ok
        ? { type: "task.envelope", taskId: deps.task.id, ok: true, source: envelope.source.kind, generation: envelope.generation }
        : {
            type: "task.envelope", taskId: deps.task.id, ok: false, code: verdict.code,
            source: envelope.source.kind, generation: envelope.generation,
            ...(verdict.expected ? { expected: verdict.expected } : {}),
            ...(verdict.actual ? { actual: verdict.actual } : {}),
          },
    });
  } catch { /* 留痕失败不阻断判定 */ }
  if (verdict.ok) return { ok: true };
  failTaskForEnvelope(deps, `[执行信封] 403 ${verdict.message}(${verdict.code});请重新授权后再投递。`);
  return { ok: false, code: verdict.code };
}

export function wireAgentLoop(
  taskManager: TaskSupervisor,
  journal: Journal,
  llm: LlmProvider,
  executor: SubagentBackend,
  nodes?: NodeRegistry,
  models?: { compact?: LlmProvider; review?: LlmProvider; subagent?: LlmProvider; digest?: LlmProvider },
  nodeDispatch?: NodeDispatch,
  projects?: import("../projects.js").ProjectRegistry,
  permissionBroker?: import("../permission-broker.js").PermissionBroker,
  workflowAskRouter?: import("../workflow-ask-router.js").WorkflowAskRouter,
 /** ask_user 面板问答路由(许愿式编程;缺省=不注册该工具)。 */
  askUser?: import("../ask-user-router.js").AskUserRouter,
 /** MCP 管理器:启用服务器的工具并入主 agent 工具面。 */
  mcp?: { allToolsForAgent(): Promise<{ serverId: string; serverName: string; name: string; description: string }[]>; callTool(serverId: string, tool: string, args: unknown): Promise<string> },
  browserConfig?: { enabled: () => boolean; allowDomains: () => string[]; idleMinutes?: () => number; profile?: () => "persistent" | "ephemeral"; profileDir?: () => string; headless?: () => boolean },
 /** 流式出口(ZCode 流式消息展示):loop onStream 旁路→relay→WS stream 广播;不落 journal。 */
  streamSink?: (sessionId: string, ev: AgentStreamEvent) => void,
 /** 记忆接线:系统提示注入记忆上下文块+会话终态学习。 */
  memory?: { contextBlock(ownerId: string): string; contextBlockFrozen?(ownerId: string): { block: string; hash: string; reused: boolean; revision?: string }; onSessionClose(input: { ownerId: string; sessionId: string; transcript: { role: "user" | "assistant"; content: string }[] }): Promise<void> },
 /** 辅助链专用轨( F2):archLlm 架构导读/压缩等辅助调用不走 realtime 主轨(会话贵且易卡),
 * 缺省回退主轨(行为与旧版一致)。 */
  auxLlm?: LlmProvider,
 /** 任务配置对象(设置页 agent.maxSteps 热读:每任务取当前值,cfg.set 下个任务生效;
 * agent.compactThresholdTokens=未声明窗口时的显式压缩阈值,;
 * agent.subagentDeadlineMin=子代理缺省时间盒(分钟)+agent.subagentStaleWarnMin=无产出预警阈值(机制1/3);
 * agent.writeBarrier=写前持久化屏障("off"|"hard";缺席=loop 内部 hard 现状;经 writeBarrierOf 取值,不读 env);
 * coding.lsp=编辑后 LSP 诊断+保存格式化(运行时对象经 zod 解析,缺省 on))。 */
  agentConfig?: { agent?: { maxSteps?: number; compactThresholdTokens?: number; subagentDeadlineMin?: number; plannerDeadlineMin?: number; subagentStaleWarnMin?: number; todoAllowParallelInProgress?: boolean; verifyOnStop?: string; writeBarrier?: "off" | "hard" }; coding?: { lsp?: import("@lampgenie/lsp").LspSettings; llm?: { vision?: boolean }; vlm?: { baseUrl?: string; providerId?: string; model?: string; apiKeyEnv?: string; timeoutMs?: number; maxTokens?: number } } },
 /** 主模型上下文窗口 tokens(容量看板分母+到阈自动 /compact)。 */
  contextWindow?: number,
 /** per-session 主模型覆盖面(缺省=无覆盖,共享 llm 现状零变化)。 */
  sessionModels?: SessionModelFace,
 /** 执行信封:装配方注入当前能力目录/策略(缺省=本任务实际工具面名+内置命令名 / permissionMode+agent.maxSteps)。 */
  envelopeDeps?: EnvelopeDeps,
 /** 会话工作所有权注册表(装配方注入;缺省=整套 ownership 逻辑降级 no-op)。 */
  ownerRegistry?: OwnerRegistry): void {
 // 注册表按 journal 缓存(同进程多 app 互不串会话);未传=不绑定=所有登记点 no-op。
  bindOwnerRegistry(journal, ownerRegistry);
 // archLlm 生产注入( F1):plan 剖面在生产环境出真架构图(此前零注入恒静态降级)。
 // 装配期一次,全进程生效; 起优先走 aux 轨(每任务两次 LLM 调用,realtime 轨下纯属占会话)。
  setPlanDeps({ archLlm: archLlmFromProvider(auxLlm ?? llm) });
 // 取消信号注册表(§1.4):task.cancel 落 state=cancelled 时
 // abort 对应 AgentLoop 的 LLM 请求与工具执行(此前 loop.cancel 零调用方=取消只改状态不中断执行)。
  const activeLoops = new Map<string, AgentLoop>();
 /** 正在起 loop 的任务(在 activeLoops.set 之前有一段异步窗口)。touch 进度会 emit task 事件 →
 * 下面的监听器会再看到 state=running,若不挡就会给同一任务起第二个 loop(双跑互相截断 turn)。 */
  const startingLoops = new Set<string>();
  taskManager.onChange((task: Task) => {
    if (task.state === "cancelled") {
 // :先落「用户已停止」标记再 abort——取消是用户意图,标记落账失败只告警,
 // 绝不让它改变取消结果(appendUserStoppedMarker 内部 try/catch + warn)。
 // 只在**真有活跃 loop 被中断**时落标记:resumeInterrupted 把原任务成 cancelled
 // (「已续跑→新任务」)不是用户停止,误标会连带堵死该会话里更早任务的续跑。
      const loop = activeLoops.get(task.id);
      if (loop) {
        appendUserStoppedMarker(journal, { taskId: task.id, sessionId: task.sessionId, source: "cancel" });
        loop.cancel("task.cancel");
      }
      activeLoops.delete(task.id);
      startingLoops.delete(task.id);
      return;
    }
    if (task.state !== "running") return;
 // 会话权限钉扎:任务开工把**当时的全局预设**落成本会话快照(pinSession 幂等,已有 pin 不重写)。
 // 此后全局预设漂移不影响已开工会话的审批口径;钉扎失败只告警,绝不阻断开工(权限回落=全局预设)。
    try {
      pinSession(journal, task.sessionId, currentPresetName());
    } catch (err) {
      console.warn("[gateway] 会话权限钉扎失败(按全局预设继续):", err instanceof Error ? err.message : String(err));
    }
 // 幂等守卫(2026-11 J1 接线闭环):同一任务已在跑 / 正在起 loop → 不重复起。
 // 触发源是新接的 onTrajectory→TaskSupervisor.touch:进度旁注也会 emit 一次 running 快照,
 // 旧口径下这会再起一个 runWithAgent(双 loop 抢同一 session:turn 被互切、轨迹卡丢)。
    if (activeLoops.has(task.id) || startingLoops.has(task.id)) return;
    startingLoops.add(task.id);
    void runWithAgent(taskManager, journal, llm, executor, task, nodes, models, nodeDispatch, projects, permissionBroker, workflowAskRouter, askUser, mcp, browserConfig, streamSink, activeLoops, memory, auxLlm, agentConfig, contextWindow, sessionModels, envelopeDeps)
      .finally(() => { startingLoops.delete(task.id); });
  });
}

/**
 * goal 续跑循环单步:任务终态后调用。
 * ZCode 语义:校验器裁决 goal 是否达成——passed→状态 complete(终);未通过→nextAction 成
 * 下一轮续跑任务标题与指引;校验器失败/坏 JSON=fail-open(passed,防无限循环);预算
 * (token/时间)超限→budget_limited(终);续跑次数硬上限(GENIE_GOAL_MAX_CONTINUES,防失控)。
 * 非 goal 驱动的任务也会触发校验(会话里目标在场即裁决——与 ZCode「会话上下文即证据源」一致)。
 */

/** :本会话仍在跑的子代理数(bgAgents 注册表;running/spawned 视为活跃)。
 * maybeContinueGoal 发轮前用它做 SUBAGENTS_ACTIVE 判据——子代理没收敛就开下一轮
 * 会在同一工作区里叠写,主 agent 拿不到前一轮结论。 */
export function countActiveSubagents(sessionId: string): number {
  let n = 0;
  for (const en of bgAgents.values()) {
    if (en.sessionId !== sessionId) continue;
    if (en.status === "running" || en.status === "spawned") n += 1;
  }
  return n;
}

export async function maybeContinueGoal(
  tm: TaskSupervisor,
  journal: Journal,
  llm: LlmProvider,
  sessionId: string,
  opts?: {
 /** :发起本轮时预期的目标修订号(缺省=不校验 stale;网关生产调用读的是即时目标)。 */
    expectedRevision?: number;
 /** :活跃子代理数覆盖(测试注入;缺省=按 bgAgents 注册表统计)。 */
    activeSubagents?: number;
 /** :续跑上限覆盖(缺省 GENIE_GOAL_MAX_CONTINUES,25)。 */
    maxContinues?: number;
  },
): Promise<void> {
 // 会话 worker 子进程内不本地续跑:本地 submit=网关 TaskSupervisor 不可见(无
 // task.* 事件,面板/队列失明)+worker 终态退出会截杀验证中的续跑链。网关侧 host 的
 // onTaskTerminal 统一发起(走正常队列→新 worker fork)。
  if (process.env.GENIE_SESSION_WORKER_CHILD === "1") return;
  const { readGoalFromJournal, formatGoalContinuationPrompt, formatGoalCompletionVerificationPrompt, parseGoalCompletionVerificationText, goalContinueVerdict, goalRoundClaimState, GOAL_CONTINUE_EVENT, GOAL_BLOCKED_EVENT, GOAL_TICK_EVENT, GOAL_VERIFIER_EVENT, GOAL_VERIFIER_UNAVAILABLE_CODE, GOAL_ROUND_CLAIM_EVENT, GOAL_ROUND_RELEASE_EVENT, consecutiveVerifierFailures, goalVerifierFallbackNextAction } = await import("@lampgenie/runtime/agent/goal");
 // 事件先取:goal 的 revision/round 与 token 记账共用同一份会话事件(不读两遍 journal)。
  const events = journal.readAll().filter((e) => e.sessionId === sessionId);
  const goal = readGoalFromJournal(events, sessionId);
 // 无目标=静默返回(每个任务终态都会走到这里;无目标还落 goal.blocked 只会把 journal 刷满噪声)。
  if (!goal) return;
 // 会话有在跑任务→不派(ZCode active-turn 守卫)。:「忙」不再一律静默返回——
 // 若是在跑/排队的 [goal] 续跑任务,交给 verdict 出 GOAL_DUPLICATE_ROUND 留痕(同轮重入可见);
 // 非 goal 任务仍静默返回(既有语义:普通任务在跑时不该有任何 goal 心跳噪声)。
  const sessionTasks = [...tm.list()].filter((t) => t.sessionId === sessionId && (t.state === "running" || t.state === "queued"));
  const hasTaskForRound = sessionTasks.some((t) => String(t.title ?? "").startsWith("[goal]"));
  if (sessionTasks.length > 0 && !hasTaskForRound) return;
  const activeSubagents = opts?.activeSubagents ?? countActiveSubagents(sessionId);
 // 记账:tokensUsed=会话全部 message.agent usage 累计;timeUsed=now-startedAt
  let tokensUsed = 0;
  for (const e of events) {
    if (e.kind !== "message.agent") continue;
    const u = (e.payload as { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }).usage;
    tokensUsed += u?.totalTokens ?? (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0);
  }
  goal.tokensUsed = tokensUsed;
  goal.timeUsedSeconds = Math.round((Date.now() - goal.startedAt) / 1000);
  const maxContinues = opts?.maxContinues ?? Number(process.env.GENIE_GOAL_MAX_CONTINUES ?? 25);
 // 轮次:新口径=goal.continue 事件数(goal.round);存量会话(有旧 journal、尚无 goal.continue 事件)
 // 沿用旧计数(task.progress.goalContinue / message.user 续跑前缀),否则升级后旧会话的轮次闸失效。
 // 汉化同步:续跑提示词开头改中文,前缀检测双认(中文新串+英文旧串)。
  const continues = events.filter((e) => e.kind === "task.progress").filter((e) => String((e.payload as { goalContinue?: string }).goalContinue ?? "").length > 0).length;
  const isGoalContinueText = (t: string) => t.startsWith("继续推进当前会话目标。") || t.startsWith("Continue working toward the active session goal.");
  const submits = events.filter((e) => e.kind === "message.user" && isGoalContinueText(String((e.payload as { text?: string }).text ?? ""))).length;
  const round = Math.max(goal.round, continues, submits);
 // 入口留痕(修静默停摆):只有「有 goal 且非 busy」才走到这里,goal.tick 是 goal 心跳,
 // 用来区分「没跑 goal」与「跑了但没续上」;无 goal/busy 早已 return,不落噪声。
  const tickId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  journal.append({
    kind: "custom",
    sessionId,
    payload: { type: GOAL_TICK_EVENT, sessionId, tickId, round, revision: goal.revision, status: goal.status, activeSubagents, at: Date.now() },
  });
 // M26重复轮判据 + 崩溃重试:本次要发的轮次 = round+1;
 // 已有 goal.continue 且轮次 >= 该轮 = 已经派过;该轮 claim 在、无 release、无 continue = 上次
 // 崩在派发前(未真正派出),verdict 按崩溃重试放行(其它条件照常校验)。
  const nextRound = round + 1;
  const hasContinueForRound = events.some((e) => {
    if (e.kind !== "custom") return false;
    const p = e.payload as { type?: unknown; round?: unknown } | undefined;
    if (!p) return false;
    return p.type === GOAL_CONTINUE_EVENT && Number(p.round) >= nextRound;
  });
  const claimState = goalRoundClaimState(events, sessionId, nextRound);
  const pendingClaimRound = claimState.claimed && !claimState.released && !claimState.continued ? nextRound : undefined;
 //  判据(纯函数):active / 轮次 / 子代理 / 预算 / 修订号 / 重复轮 —— 拒绝时不 submit,只留痕。
  const verdict = goalContinueVerdict({
    goal,
    round,
    maxContinues,
    activeSubagents,
    hasContinueForRound,
    hasTaskForRound,
    ...(pendingClaimRound !== undefined ? { claimedRound: pendingClaimRound } : {}),
    ...(opts?.expectedRevision !== undefined ? { expectedRevision: opts.expectedRevision } : {}),
    now: Date.now(),
  });
  if (!verdict.allow) {
    journal.append({ kind: "custom", sessionId, payload: { type: GOAL_BLOCKED_EVENT, sessionId, code: verdict.code, reason: verdict.reason, round, revision: goal.revision, at: Date.now() } });
 // 预算/轮次上限保留既有终态语义(用户可见提示 + 目标状态),其余拒因只留痕。
    if (verdict.code === "GOAL_BUDGET") {
      journal.append({ kind: "goal.set", sessionId, payload: { goal: goal.objective, state: "budget_limited", at: Date.now() } });
      journal.append({ kind: "message.system", sessionId, payload: { text: "会话目标已达 token 预算,状态置为 budget_limited。除非用户提高预算或设定新目标,不要继续推进该目标。" } });
    } else if (verdict.code === "GOAL_ROUND_LIMIT") {
      journal.append({ kind: "goal.set", sessionId, payload: { goal: goal.objective, state: "paused", at: Date.now() } });
      journal.append({ kind: "message.system", sessionId, payload: { text: `[goal] 续跑次数达上限 ${maxContinues},目标已暂停(用 /goal resume 或 /goal <新目标> 继续)` } });
    }
    return;
  }
 // M26round claim:放行后、跑 verifier 之前立账——claim 无 release 且无 goal.continue
 // = 上次崩溃在派发前断掉,下一轮按崩溃重试放行;verifier passed / 连续不可用暂停 / 异常 → 成对
 // release;正常派轮不 release(goal.continue 就是该轮的结账事件,再 release 会破坏成对语义)。
  journal.append({
    kind: "custom",
    sessionId,
    payload: { type: GOAL_ROUND_CLAIM_EVENT, sessionId, round: nextRound, revision: goal.revision, tickId, at: Date.now() },
  });
  let roundReleased = false;
  const releaseRound = (reason: string): void => {
    if (roundReleased) return;
    roundReleased = true;
    try {
      journal.append({ kind: "custom", sessionId, payload: { type: GOAL_ROUND_RELEASE_EVENT, sessionId, round: nextRound, tickId, reason: reason.slice(0, 160), at: Date.now() } });
    } catch { /* 释放留痕失败不影响主流程 */ }
  };
  try {
 // 完成校验器(修静默停摆):调用失败/超时/输出非 JSON 一律视为「校验器不可用」,
 // 不再与「目标已达成」同分支静默 return——先重试一次;仍不可用则兜底续跑,连续两轮才暂停。
    const runVerifierOnce = async (attempt: 1 | 2): Promise<{ passed: boolean; reason: string; nextAction: string } | null> => {
      const ctxLimit = attempt === 1 ? 24 : 16;
      const timeoutMs = attempt === 1 ? 60_000 : 45_000;
      const startedAt = Date.now();
      let verification: { passed: boolean; reason: string; nextAction: string } | null = null;
      let failReason = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const res = await Promise.race([
          llm.chat(
            [
              { role: "system", content: formatGoalCompletionVerificationPrompt(goal) },
              ...deriveMessages(journal, sessionId)
                .filter((m) => m.role !== "tool")
                .slice(-ctxLimit)
                .map((m) => ({ role: m.role === "system" ? ("user" as const) : m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: String(m.content).slice(0, 1500) })),
            ],
            [],
          ),
          new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`verifier timeout after ${timeoutMs}ms`)), timeoutMs); }),
        ]);
        verification = parseGoalCompletionVerificationText((res as { content?: string }).content ?? "");
        if (!verification) failReason = "校验器输出无法解析(非 JSON)";
      } catch (err) {
        verification = null;
        failReason = `校验器不可用:${String((err as { message?: unknown })?.message ?? err).slice(0, 160)}`;
      } finally {
        if (timer) clearTimeout(timer);
      }
      journal.append({
        kind: "custom",
        sessionId,
        payload: {
          type: GOAL_VERIFIER_EVENT,
          sessionId,
          tickId,
          attempt,
          result: verification ? (verification.passed ? "passed" : "not_passed") : "unavailable",
          reason: (failReason || verification?.reason || "").slice(0, 300),
          durationMs: Date.now() - startedAt,
          round,
          revision: goal.revision,
          at: Date.now(),
        },
      });
      return verification;
    };
    let verification = await runVerifierOnce(1);
    if (!verification) verification = await runVerifierOnce(2);
    if (verification?.passed) {
      releaseRound("verifier-passed");
      journal.append({ kind: "goal.set", sessionId, payload: { goal: goal.objective, state: "complete", at: Date.now() } });
      journal.append({ kind: "message.system", sessionId, payload: { text: `Session goal verified complete. Reason: ${verification.reason.slice(0, 300)}` } });
      return; // 已达成:不续跑
    }
    let verifierFallback = false;
    if (!verification) {
 // 连续失败轮数从 journal 推导(goal.verifier 按 tickId 分组):网关重启不丢;
 // 任一轮拿到有效 passed/not_passed → 计数自然清零。
      const consecutive = consecutiveVerifierFailures(journal.readAll(), sessionId);
      if (consecutive >= 2) {
        releaseRound("verifier-unavailable");
        journal.append({ kind: "custom", sessionId, payload: { type: GOAL_BLOCKED_EVENT, sessionId, code: GOAL_VERIFIER_UNAVAILABLE_CODE, reason: `完成校验器连续 ${consecutive} 轮不可用(本轮已重试一次)`, round, revision: goal.revision, consecutive, at: Date.now() } });
        journal.append({ kind: "goal.set", sessionId, payload: { goal: goal.objective, state: "paused", at: Date.now() } });
        journal.append({ kind: "message.system", sessionId, payload: { text: "完成校验器连续不可用,目标暂停;恢复后 /goal resume" } });
        return; // 连续不可用:不再盲续
      }
      verifierFallback = true;
      verification = { passed: false, reason: "完成校验器不可用(调用失败/超时/输出无法解析,已重试一次)", nextAction: goalVerifierFallbackNextAction(goal) };
    }
 // 未达成:派下一轮续跑(标题=nextAction,ZCode「下一轮迭代标题」语义)
 //  身份行:revision + round 进任务书(放正文之后——首行前缀是存量续跑计数/识别的锚,不能挡);
 // messageId 只有 submit 之后才有,回填进 journal goal.continue(身份三件套:revision/round/messageId)。
    const instruction = formatGoalContinuationPrompt(goal, verification) + `\n\n[goal] revision=${goal.revision} round=${nextRound}`;
    journal.append({ kind: "task.progress", sessionId, payload: { goalContinue: verification.nextAction.slice(0, 120) } });
    const continued = tm.submit("system", sessionId, instruction, { title: "[goal] " + (verification.nextAction || goal.objective).slice(0, 60) });
    journal.append({ kind: "custom", sessionId, payload: { type: GOAL_CONTINUE_EVENT, sessionId, revision: goal.revision, round: nextRound, messageId: continued.id, ...(verifierFallback ? { fallback: true } : {}), at: Date.now() } });
  } catch (err) {
 // 异常路径(格式化/submit/journal 写失败等):claim 必须成对释放,否则该轮会被判「悬挂 claim」。
    releaseRound(`error:${String((err as { message?: unknown })?.message ?? err)}`);
    throw err;
  }
}

/** 时间旅行:从本步工具调用里提取「将要触碰」的文件路径(只认文件类工具的 path 参数族),去重保序。 */
const SNAPSHOT_PATH_TOOLS: ReadonlySet<string> = new Set(["write_file", "edit_file", "apply_patch"]);

export function collectSnapshotPaths(calls: { name?: string; arguments?: string }[] | undefined): string[] {
  const out: string[] = [];
  for (const c of calls ?? []) {
    if (!c || !SNAPSHOT_PATH_TOOLS.has(String(c.name ?? ""))) continue;
    let args: Record<string, unknown>;
    try { args = JSON.parse(String(c.arguments ?? "{}")) as Record<string, unknown>; } catch { continue; }
    for (const key of ["path", "file_path", "target_path"] as const) {
      const v = args[key];
      if (typeof v !== "string") continue;
      const p = v.trim();
      if (p && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

/** : task.kind.tools 留痕一次/任务(同任务重进 runWithAgent 不重复写同一条账)。 */
export const taskKindToolsLogged = new Set<string>();
