/**
 * agent-wiring 分片:loop-support(自 agent-wiring.ts 7910 行按域拆分,逐字搬移)。
 * 原路径 agent-wiring.ts 保留具名转发 barrel;消费方零改动。
 */
import type { TaskClass } from "./workflow-task.js";
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
export interface TaskArchiveEntry {
  at: number; sessionId: string; taskId: string; state: string;
  instruction: string; phases: { phase: string; note: string; skip?: boolean }[];
  result: string; board?: { title: string; nodeTitles: string[]; p0Total?: number; p0Passed?: number };
}
function taskArchivePath(root: string): string {
  return join(root, ".genie", "task-archive.jsonl");
}
export function appendTaskArchive(root: string, entry: TaskArchiveEntry): void {
  try {
    const { mkdirSync: mk2, appendFileSync: ap2 } = { mkdirSync: _mdSync, appendFileSync };
    mk2(join(root, ".genie"), { recursive: true });
    ap2(taskArchivePath(root), JSON.stringify(entry) + "\n", "utf-8");
  } catch { /* 档案写失败不影响任务收尾 */ }
}
export function readTaskArchive(root: string, opts?: { sessionId?: string; limit?: number }): TaskArchiveEntry[] {
  const limit = opts?.limit ?? 12;
  try {
    const lines = readFileSync(taskArchivePath(root), "utf-8").split("\n").filter(Boolean).slice(-200);
    const all = lines.map((l) => { try { return JSON.parse(l) as TaskArchiveEntry; } catch { return null; } }).filter(Boolean) as TaskArchiveEntry[];
    const mine = opts?.sessionId ? all.filter((e) => e.sessionId === opts.sessionId) : [];
    const rest = all.filter((e) => !mine.includes(e));
    return [...mine.slice(-limit), ...rest].slice(0, limit + 4);
  } catch { return []; }
}
/** 历史档案→注入块(compact 恢复通道:每任务注入,压缩后上下文仍在) */
export function renderTaskArchiveBlock(entries: TaskArchiveEntry[]): string {
  if (!entries.length) return "";
  const lines = entries.map((e) => {
    const ph = e.phases?.length ? " 阶段:" + e.phases.map((x) => x.phase + (x.skip ? "(跳)" : "")).join("→") : "";
    const bd = e.board ? ` 板「${e.board.title.slice(0, 24)}」${e.board.nodeTitles?.length ?? 0}节点${e.board.p0Total ? ` P0 ${e.board.p0Passed ?? 0}/${e.board.p0Total}` : ""}` : "";
    return `- [${e.state}] ${e.instruction.slice(0, 60)}${ph}${bd} → ${(e.result || "").slice(0, 80)}`;
  });
  return "\n\n## 历史任务档案(compact 后恢复锚;做相关任务先对齐历史结论,别推翻已验证的成果)\n" + lines.join("\n");
}

/** 派发 tip(自纪律卡移出:首次 spawn_subagent 时注入,不占 kickoff 纪律卡篇幅)。 */
export const DISPATCH_TIP = [
  "## 派发 tips(首次派子代理时注入)",
  "- 派发分档:小步文件修改自己上手更快;新模块/大型/多模块开发拆子任务派 spawn_subagent;选择等待用 wait:true 或 task_output(waitFor:\"result\")(挂起零 LLM);不要重复在跑子代理任务书里的内容",
  "- 任务书要写清楚动词、目标与验收标准(子代理只认任务书,模糊指令=模糊产出;2026-10-21 自 kickoff 纪律卡移入,契约规则同句锚定)",
  "- 上下文卫生:大输出勘察/实施派子代理,你只收结论+关键证据(文件:行号);要求子代理返回摘要,不贴大段原始输出",
].join("\n");

/**
 * 并行 tip( T-D 轨迹经验证落地)。
 * 经验证:近 3 天 25 会话 6,590 步,85.4% 的步只发 1 个调用(并行率 11.4%)——主轨仍是严格
 * 「一步一动作」串行形态,而每多一轮就多付一次全量 input(34% 的步 >400k input,吃掉 59% 成本)。
 * 根因三选一已核实:①提示词强度非零(SYSTEM_A/SYSTEM_LITE 各一条并行纪律),但它是**常量**,
 * 不随步态触发,长会话里注意力衰减后形同不存在;②工具面 `isConcurrencySafe` 只在 loop 分批发
 * 那侧生效,**不进 schema/description**,模型看不见「这个工具可以配着发」;③模型默认习惯是逐条发。
 * → 落地点选「确定性触发」:上一步只发了 1 个**可配对的只读探测工具**时,下一步注入一次提醒,
 * 把静态纪律变成「恰好在最该并行的时刻出现」的短提示。
 * 成本约束:tip 是 ephemeral(每步重算、只活本步),但仍要防刷屏——冷却 8 步 + 每个压缩
 * episode 至多 3 次;GENIE_TIPS=off 全关。
 */
export const PARALLEL_TIP = [
  "## 并行 tips(上一步只发了 1 个调用)",
  "- 若手上还有与上一步结果**无依赖**的动作,把它们放进**同一条消息**一起发:每多一轮就多付一次全量上下文重发的 input(实测长会话单轮 input 30 万+ token)。",
  "- 贴近场景:同批探测(code_sense/read_file/grep/glob/list_dir 可一起发)、互不相关文件的多处 edit_file、互不相关的验证命令。",
  "- 有依赖时照常串行(要先用上一步结果才能决定下一步),不要为并行而并行。",
].join("\n");

/** 可配对的只读探测类工具(投影自各工具 isConcurrencySafe:true 且只读;写/派发/浏览器类不在内)。 */
const PARALLEL_ELIGIBLE_TOOLS: ReadonlySet<string> = new Set([
  "code_sense", "read_file", "grep", "glob", "list_dir", "board_read", "tool_view", "session_search", "view_image",
]);
/** 提醒冷却步数(连续单调用步只提醒一次,避免每步刷同一句)。J1 起仅旧路径(gate 缺席)使用。 */
export const PARALLEL_TIP_COOLDOWN_STEPS = 8;
/** 每个压缩 episode 至多注入次数(compact 后重新计数)。J1 起仅旧路径(gate 缺席)使用。 */
export const PARALLEL_TIP_MAX_PER_EPISODE = 3;

/** 验证类工具(J1 动态卡信号:这些工具跑过=一次「验证轮次」)。 */
const VERIFY_TOOL_NAMES: ReadonlySet<string> = new Set(["run_cmd", "terminal", "run_workflow"]);

/**
 * tips 即时增强引擎( 「每条 user message 跟一条匹配式 tips」多余且常
 * 错配——模型上下文已含会话语境,code_sense 内容必须是拉取式(call 工具才返回,不推送);经验/
 * devlog/历史档案同理不再按指令匹配推送(compact 后的恢复锚仍保留在压缩路径,那是补丢失的
 * 上下文,不是重复推送)。 版的 code-orient/history-align 两类匹配式注入已删。
 * 只留功能性 tip,各一次为限,由 loop 每 step 调用(ctx=上一步实际执行的工具名):
 * - board-comments:白板新评论取走即消费(用户评论必须到达 agent——这是投递,不是增强);
 * - dispatch:首次 spawn_subagent → 派发分档+上下文卫生(行为纪律,非匹配内容)。
 * GENIE_TIPS=off 全关。
 */
export function buildLoopTips(deps: {
  sessionId: string;
 /** SOP 阶段信号(2026-11 tips SOP 化):不传=无阶段信号,旧调用方零行为变化。 */
  getPhase?: () => string | undefined;
 /** 全链路变更信号:plan/close 阶段卡换成盘点/残留审计卡。不传=零行为变化。 */
  changeScope?: () => string | undefined;
}): (ctx: {
  step: number; lastStepTools: string[];
 /** (token 轮):上一步工具调用涉及的文件夹具参数;旧 ctx 形态缺省=[]。 */
  lastStepFiles?: string[];
 /** :本 turn 累计工具错误数;旧 ctx 形态缺省=0。 */
  totalErrors?: number;
 /** :本 turn 累计 usage tokens(与 gate 对齐节奏用);旧 ctx 形态缺省=0。 */
  tokensSpent?: number;
 /** :注入闸(见 runtime inject-gate);旧 ctx 形态缺省=undefined(不过闸,行为同旧版)。 */
  gate?: InjectGate;
 /** :最近一条轨迹卡摘要行(loop 的 task.trajectory 旁路产物)。 */
  trajectory?: string;
  compacts?: number; phase?: string; lastStepError?: boolean;
}) => { text: string; keys: string[]; metrics: TipMetricSpec[] } | null {
  const fired = new Set<string>();
 // compact 后 tip 失忆自愈:tips 是 ephemeral(不落 journal),autoCompact 之后
 // 模型看不见已注入的 tip。loop 每 step 带 compact.done 计数(ctx.compacts);计数增长=fired
 // 清空,各类 tip 允许重注入一次(严格「每次 compact 后至多一次」,不是无限重放)。
  let lastCompacts = 0;
 // 并行 tip 的**旧**节流状态:仅在 ctx 未带 gate 的旧调用方路径使用
 // (J1 token 轮起正式路径由 InjectGate 单一机制限流,见下方注)。
  let lastParallelStep = -Infinity;
  let parallelInjects = 0;
 // ── (2026-11 token 轮)任务内步态状态:动态卡(dyn:*)的判定信号源。
 // fileEditStreak=每个文件「连续被改动」的步数(某步没编辑该文件即归零);verifyRounds=本任务
 // 已发生的验证轮次(跑 run_cmd/terminal/run_workflow 这类验证工具的步数);boardTouched=首次
 // 在 ctx.lastStepTools 里见到 board_upsert 即置 true(此后不再回退,语义=本任务落过板)。
  let fileEditStreak: Record<string, number> = {};
  let verifyRounds = 0;
  let lastStep = -1; // 同一步被重复调用时信号不重复累计
  let boardTouched = false;
 /** 最近一次「验证工具步」的 step(run_cmd/terminal/run_workflow 命中时刷新);从未验证过=undefined。
 * dyn:verify-cadence 的判定信号(step-lastVerifyStep≥10)——「工作十步没验一次」。
 * compact **不清**:它描述任务进度事实,不是注入额度(fired 才是额度)。 */
  let lastVerifyStep: number | undefined;
 /** 本任务已 spawn 过子代理(见过 spawn_subagent 即置 true,此后不回退)。dyn:delegate 的信号
 * (spawnedSubagent===false 才提示「上下文重了该派活」);同样不随 compact 清空。 */
  let spawnedSubagent = false;
 /** 上一次注入的轨迹摘要行(内容未变=不重复注入,即使 compact 清过 fired)。 */
  let lastTrajBackfillKey = "";
  return (ctx) => {
    if (process.env.GENIE_TIPS === "off") return null;
    if (ctx.compacts !== undefined && ctx.compacts > lastCompacts) {
      fired.clear();
      lastCompacts = ctx.compacts;
      parallelInjects = 0; // 压缩后重开额度(与其余 tip 的清空语义一致)
    }
 // 去重层(J1 改造):fired=「一次为限」硬去重;gate=同一 key 至少间隔 10k token 的节流。
 // 两者串联(先 fired 后 gate),任一拒绝即不注入;**所有 key 都过 gate**(fired 命中本就拒,
 // 不再进 gate 免得白抬水位)。gate 缺省(旧 ctx)= 不过闸,行为与旧版一致。
 // tokensSpent 缺省 0 → 闸的「无记录/水位回退即放行」语义保证首步该有的提醒不丢。
    const gate = ctx.gate;
    const tokensSpent = ctx.tokensSpent ?? 0;
 // 动态卡信号累积(只在新的一步上累计:loop 每 step 调一次,重入不重复计数)
    const lastStepFiles = ctx.lastStepFiles ?? [];
    const totalErrors = ctx.totalErrors ?? 0;
    if (ctx.step !== lastStep) {
      lastStep = ctx.step;
 // 「连续改动」只认编辑类工具步(读文件不算改动——否则连读 3 步也刷假设卡)
      const edited = ctx.lastStepTools.some((t) => t.indexOf("edit") >= 0 || t.indexOf("write") >= 0 || t.indexOf("patch") >= 0);
      const next: Record<string, number> = {};
      if (edited) for (const f of lastStepFiles) next[f] = (fileEditStreak[f] ?? 0) + 1;
      fileEditStreak = next; // 本步没编辑的文件自然归零(连续链断)
      if (ctx.lastStepTools.some((t) => VERIFY_TOOL_NAMES.has(t))) {
        verifyRounds += 1;
        lastVerifyStep = ctx.step; // 验证节奏卡信号:最近一次真跑过验证工具的步
      }
    }
    if (!boardTouched && ctx.lastStepTools.includes("board_upsert")) boardTouched = true;
    if (!spawnedSubagent && ctx.lastStepTools.includes("spawn_subagent")) spawnedSubagent = true;
    const once = (key: string, block: string): string | null => {
      if (!block || fired.has(key)) return null;
      if (gate && !gate.check(key, tokensSpent)) return null;
      fired.add(key);
      return block;
    };
    const parts: string[] = [];
    const keys: string[] = [];
    const pushKey = (k: string) => { if (!keys.includes(k)) keys.push(k); };
 // 白板新评论:取走即消费——用户评论了就要有人接,不等 agent 自己想起 board_read。
    const pendBlock = renderPendingCommentsBlock(takePendingComments(deps.sessionId));
    if (pendBlock) { parts.push(pendBlock); pushKey("board-comments"); }
 // SOP 行式卡(2026-11 tips SOP 化,恰时一次为限;放 board-comments 之后、dispatch 之前):
 // phase 首见即注入对应阶段卡(SOP_TIPS 无 verify 卡——验收四步已由 task_phase 回执送达,
 // 重复=违 N3 教训);无新 phase 卡但上一步工具带错 → 排障卡兜底。key 形如 sop:understand
 // 直接进 fired,compact 后清空自动允许重注入一次(与 dispatch 同语义,不另造机制)。
 // ctx.phase 优先(loop 的 tipsPhase 通道);ctx 未带 phase 时兜底读 deps.getPhase
 // (装配方可只接 deps 不接 loop tipsPhase,两条通道等价)。未带 phase 字段且无 getPhase
 // 的旧 ctx 形态零注入——不是回到消息匹配式做法。
    const rawPhase = ctx.phase ?? deps.getPhase?.();
    const ph = rawPhase && SOP_TIPS[rawPhase] ? rawPhase : null;
    if (ph) {
 // 全链路变更类:plan/close 两阶段换覆盖卡(盘点 SOP / 残留审计),其余阶段原卡不变。
 // 判定取 deps.changeScope(装配方接 surfaceGateVerdict),缺省 undefined=普通任务。
      const surface = deps.changeScope?.() === "surface";
      const b = once(`sop:${ph}`, sopTipText(ph, surface));
      if (b) { parts.push(b); pushKey(`sop:${ph}`); }
    } else if (ctx.lastStepError && !fired.has("sop:debug")) {
      const b = once("sop:debug", sopTipText("debug"));
      if (b) { parts.push(b); pushKey("sop:debug"); }
    }
    if (ctx.lastStepTools.includes("spawn_subagent")) {
      const b = once("dispatch", DISPATCH_TIP);
      if (b) { parts.push(b); pushKey("dispatch"); }
    }
 // 并行提醒(J1 2026-11 token 轮改造):上一步恰好 1 个调用且该调用是可配对的
 // 只读探测工具 → 提醒同发。只认「1 个」是刻意的:0 个=纯文本步(可能已收尾),≥2 个=已经
 // 在并行,都不需要提醒。
 // **J1 改动**:旧实现用「冷却 8 步 + 每 episode ≤3 次」双节流(步数口径);J1 起并行提醒改为
 // **repeatable key**(`parallel` 不进 fired,每步都尝试),节奏交给 gate 的 ≥10k token 间隔——
 // 删掉步数冷却/episode 计数是为了「单一机制」:步数与会话膨胀速度不对齐(短步刷十步只值 2k
 // token,长步一步就 30k),按 token 计才能让「提醒频率」与真实上下文消耗对齐;两套节流并存
 // 则同一提醒被两个独立计时器同时压,谁都说不清为什么没注。旧节流仅在 gate 缺席的旧调用方
 // 路径保留(行为零变化,存量测试与旧装配方不受影响)。
    const parallelHit = ctx.lastStepTools.length === 1 && PARALLEL_ELIGIBLE_TOOLS.has(ctx.lastStepTools[0]!);
    if (parallelHit) {
      if (gate) {
        if (gate.check("parallel", tokensSpent)) { parts.push(PARALLEL_TIP); pushKey("parallel"); }
      } else if (
        parallelInjects < PARALLEL_TIP_MAX_PER_EPISODE
        && ctx.step - lastParallelStep >= PARALLEL_TIP_COOLDOWN_STEPS
      ) {
        parts.push(PARALLEL_TIP);
        pushKey("parallel");
        parallelInjects += 1;
        lastParallelStep = ctx.step;
      }
    }
 // 任务内动态卡(J1,2026-11):步态信号(连续改同一文件/反复验证仍带错/步数很多却没落板)→
 // 判定在 agent-wiring-dynamic-tips.dynTipKeys(纯函数,单测直测);注入侧仍是 once(key,...):
 // fired 一次为限 + gate 10k token 间隔。compact 清 fired 后可重注入一次(与 dispatch 同语义)。
    const dynSig: DynSignals = {
      lastStepFiles, fileEditStreak, verifyRounds, totalErrors, step: ctx.step, boardTouched,
 // J1 接线闭环(2026-11):两张新卡的信号——最近验证步 / 是否已 spawn / 累计 token。
 // 三者都是「任务进度事实」,compact 清 fired 时不动它们(否则压缩后把已验过的当没验过)。
      lastVerifyStep, spawnedSubagent, tokensSpent,
    };
    for (const k of dynTipKeys(dynSig)) {
      const b = once(k, dynTipText(k));
      if (b) { parts.push(b); pushKey(k); }
    }
 // 轨迹回看注入(J1):loop 已按 N 步旁路落 task.trajectory 并给一行摘要(ctx.trajectory)。
 // 非空即提醒「回看自己走到哪」——长会话里模型最常丢的不是纪律而是「已经做了什么」。
 // **不走 once/fired**(那是「一次为限」语义):轨迹是滚动水位,每落一条新轨迹就该让 agent 看一次;
 // 节奏交给 gate 的 ≥10k token 间隔。同一行内容不重复注(lastTrajBackfillKey)。
    const trajLine = String(ctx.trajectory ?? "").trim();
    if (trajLine && trajLine !== lastTrajBackfillKey && (!gate || gate.check("task:trajectory", tokensSpent))) {
 // 改走提醒来源登记表渲染(trajectory 源),不再就地拼 <system-reminder>。
 // inline 形态与旧拼接逐字节一致(轨迹块本身无嵌套标签);渲染失败(理论不可达)回退旧拼接,
 // 提醒层故障不得打断主链。
      const trajBody = "任务内轨迹(回看自己走到哪)\n" + trajLine
        + "\n需要更完整轨迹就 board_read/看面板轨迹条;方向偏了就回阶段锚。";
      const trajRendered = renderSystemReminder("trajectory", trajBody, { inline: true });
      parts.push(trajRendered.ok ? trajRendered.text : "<system-reminder>" + trajBody + "</system-reminder>");
      pushKey("task:trajectory");
      lastTrajBackfillKey = trajLine;
    }
    if (!parts.length) return null;
 // keys 供 `tip.injected` 留痕事件分类展示(面板显示「tips · dispatch」等)。
    const metricOf = (keys: string[]): TipMetricSpec[] => keys.map((k) => tipMetricOf(k));
    return {
      text: "<system-reminder>tips(做这类事之前的信息增强,直接利用,不要复述此段)\n" + parts.join("\n\n") + "</system-reminder>",
      keys,
 //  指导可度量:每条已注入 tip 带上「触发条件/预期行为/指标口径」——
 // 面板与 tip.injected 留痕可直接回答「这条指导为什么出现、用哪条指标验效果」。
      metrics: metricOf(keys),
    };
  };
}

/**
 * ── J1 接线闭环(2026-11 token 轮):轨迹 → 任务进度 ────────────────────────────
 * loop 的 emitTrajectory 每 5 步/phase 切换 due 一次并回调 onTrajectory;这里把该事件折算成
 * TaskSupervisor.touch 的进度补丁(phase/step/note)。抽成纯函数是为了可单测:装配路径(runWithAgent)
 * 太重,不便在单测里真跑,而「note 怎么截断、phase 缺省带不带键」正是容易写错的部分。
 */
/** loop onTrajectory 的事件形态(与 AgentLoopOptions.onTrajectory 同构;此处独立声明避免跨包类型耦合)。 */
export type TrajectoryProgressEvent = {
  taskId?: string; step: number; turn: number; phase?: string; subgoal: string;
  tokensSpent: number; errors: number; steps: number; tools: Record<string, number>;
};

/** 轨迹事件 → 一句 ≤60 字进度摘要(touch 的 note)。纯函数:同输入同输出,零 io。 */
export function progressNoteFromTrajectory(
  ev: Pick<TrajectoryProgressEvent, "step" | "tools" | "errors">,
): string {
  const line = `第${ev.step}步 · 工具${Object.keys(ev.tools ?? {}).length}类 · 错误${ev.errors ?? 0}`;
  return line.length > 60 ? line.slice(0, 59) + "…" : line;
}

/**
 * 把轨迹事件写进任务进度。语义边界:
 * - **只合并非 undefined**:phase 缺省时不带该键(TaskSupervisor.touch 只合并非 undefined → 旧 phase 不被抹掉);
 * - 不动 state/updatedAt(touch 自己只管 progress;状态迁移是 task-manager 的事);
 * - tm 拿不到 / taskId 缺失 / touch 抛错 → 静默跳过(进度是旁路,绝不打断 agent 主链)。
 */
export function applyTrajectoryProgress(
  tm: { touch(taskId: string, patch: { phase?: string; step?: number; note?: string; at?: number }): unknown } | undefined,
  taskId: string | undefined,
  ev: TrajectoryProgressEvent): void {
  if (!tm || !taskId) return;
  try {
    tm.touch(taskId, {
      ...(ev.phase !== undefined && ev.phase !== "" ? { phase: ev.phase } : {}),
      step: ev.step,
      note: progressNoteFromTrajectory(ev),
      at: Date.now(),
    });
  } catch { /* 进度旁路:失败不打断主链 */ }
}

/**
 * 网关启动僵尸清算(「僵尸 worker」根治,机制4):上一进程遗留的 spawn-无-result
 * 子代理统一补一条终态标记。journal append-only——补 subagent.result 事件,不改历史;
 * 面板目录/状态卡与投影 running 计数从此落「失败(网关重启,子代理随进程终止)」,
 * 不再永远「后台运行中 · 已工作 N 小时」。
 * 幂等:有 result 事件的 agentId 即非孤儿,二次启动不重复补;idempotencyKey 双保险
 * (同一 journal 的并发双实例也不会双写)。
 * 不误伤:time >= bootAt 的 spawn(本次进程所派)一律不碰。
 * 返回本次补终态的 agentId 清单(观测/测试面)。
 */
export function reapOrphanSubagents(journal: Journal, opts?: { bootAt?: number }): string[] {
  const bootAt = opts?.bootAt ?? Date.now();
  const spawned = new Map<string, { sessionId: string; taskId?: string; time: number }>();
  const orphanNoId: { sessionId: string; taskId?: string; time: number; seq: number }[] = [];
  const hasResult = new Set<string>();
  let noIdResultCount = 0; // 无 agentId 的旧 result:按 journal 顺序 FIFO 配对最早的未匹配 spawn(同代旧事件形态)
  for (const ev of journal.readAll()) {
    if (ev.kind === "subagent.spawn") {
      const p = (ev.payload ?? {}) as { agentId?: string; taskId?: string };
      const aid = String(p.agentId ?? "");
      if (aid) spawned.set(aid, { sessionId: ev.sessionId, taskId: p.taskId, time: ev.time });
      else orphanNoId.push({ sessionId: ev.sessionId, taskId: p.taskId, time: ev.time, seq: ev.seq });
    } else if (ev.kind === "subagent.result") {
      const aid = String(((ev.payload ?? {}) as { agentId?: string }).agentId ?? "");
      if (aid) hasResult.add(aid);
      else noIdResultCount++;
    }
  }
  const reap = (arg: { sessionId: string; taskId?: string; agentId?: string; idem?: string }) => {
    journal.append({
      kind: "subagent.result",
      sessionId: arg.sessionId,
      payload: {
        ...(arg.taskId ? { taskId: arg.taskId } : {}),
        ...(arg.agentId ? { agentId: arg.agentId } : {}),
        event: { type: "result", ok: false, note: "网关重启,子代理随进程终止" },
        reap: { reason: "gateway-restart", at: Date.now() },
      },
      ...(arg.idem ? { idempotencyKey: arg.idem } : {}),
    });
  };
  const reaped: string[] = [];
  for (const [aid, meta] of spawned) {
    if (hasResult.has(aid)) continue;
    if (meta.time >= bootAt) continue; // 本次进程新派的不误伤
    reap({ sessionId: meta.sessionId, taskId: meta.taskId, agentId: aid, idem: "subagent.reap." + aid });
    reaped.push(aid);
  }
  for (let i = noIdResultCount; i < orphanNoId.length; i++) {
    const o = orphanNoId[i]!;
    if (o.time >= bootAt) continue;
 // 无 agentId 的旧 spawn:前 noIdResultCount 条已被既有 result 配对(有终态,非孤儿,补了会双计);
 // 其余为真孤儿——补事件只为投影 running 计数归位(面板对无 agentId 事件本就按「已结束」渲染)。
    reap({ sessionId: o.sessionId, taskId: o.taskId, idem: "subagent.reap.s" + o.seq });
  }
  return reaped;
}

/** 子代理模型名读数:provider 带 modelName(openai-compat/realtime 均暴露,getter 跟热更)
 * 则取之;自造 provider(测试/脚本)无该字段回落「主模型」——诚实降级,不猜名字。 */
export function subagentModelNameOf(p: LlmProvider): string {
  const m = (p as { modelName?: unknown }).modelName ?? (p as { model?: unknown }).model;
  return typeof m === "string" && m !== "" ? m : "主模型";
}

// fixG(先骨架后丰羽翼+开发类型分治):设计白板纪律段补流程骨架优先两阶段(≤9 节点/flow 内步骤/小任务豁免);
// 规划必成板段按三分法重写(UI=界面骨架先行/mixed=UI 骨架总纲+逻辑锚点/headless=流程骨架)+两阶段节奏。
const SYSTEM_A = `你是 lampgenie-harness 的 vibe coding 主 agent(编码轨,唯一身份声明;行为纪律继承自管家 soul)。职责:理解用户任务,拆解并调度子 agent 执行;简单问题直接回答。
- **许愿式需求深挖**(开工第一步,先于任何工具调用):用户举的例子通常是所属类别的**一个样本**——先内心三问(①同类扩展:该类别还有哪些成员 ②关联传导:改动牵动哪些上下游 ③边界条件:异常/空态/规模上限如何表现)。高把握→按扩展范围直接做,开工一句话明示;有取舍或范围可能显著膨胀→先 ask_user 给 2~4 个选项再动;用户明确「只做这个」→严格按字面。不做深挖就闷头做最小实现,也不许范围膨胀到无法交付。
- **上下文卫生纪律**(主上下文只进结论不进过程):你的上下文是最贵的工作记忆。繁重 coding(多文件改动/多步实施/大量读码跑测试)按板拆成子任务派 spawn_subagent(上下文与主轨隔离,你只收结论+关键证据,要求它返回摘要、不要贴大段原始输出);新模块功能开发、大型系统开发、多模块开发优先派子 agent,小步文件修改(单文件更正、小修小补)自己上手更快——派与不派由你自己斟酌。理解代码脉络(符号定义/调用链/影响面/分支骨架/引用面)一律先 code_sense(结构面毫秒级,语义画像面秒级;能力全集见 tool_view)——grep 只用于字面文本场景;read_file 只做画像后的局部确认(offset/limit),不整读;同一文件读第二遍=把关键结论写进 todo/板节点,不靠重读。自己本轮写的代码就在上下文里,不要再查。`;
const SYSTEM_PLAN = `
- **五硬阶段流程**(理解任务→规划→开始实施→开始验收→完成):开工第一步调 task_phase(phase="understand");每进入一个阶段声明一次(plan/implement/verify/close),不涉及的阶段也要显式声明不涉及(task_phase skip:true)。**阶段声明不额外占步**:task_phase 与其他工具同一步发出即可(它与真实工作工具并行执行),不要为它单独走一步。只做当前阶段该做的事;阶段外支线记到板 P1/P2,不带偏主线;系统每 10 步注入阶段提醒。**路由**:理解阶段判定——明确具体的小改(单文件/局部)用 task_phase(phase="implement", route="direct") 直达实施(免规划/白板);功能新增/删除/修改等长链路才走完整流程。
- **规划委托纪律(plan-gate 硬闸)**:本任务白板没有设计节点前,派写角色子代理与直写文件都会被工具层拦截。规划/设计类任务先派 planner(agentType="planner",任务书四要素:目标/期望产出/边界/板型——按任务类型指定 design 控制流程图或 page 页面结构板,口径见 tool_view(name="board_upsert") 的「控制流程图 + 仓库落点」段);planner 超时/失败/板为空→自己内联落轻量板并在汇报里显式标注「planner 降级:内联规划」;小修/纯执行类自己内联落一块轻量板(1~3 节点)再动手。planner 返回后先 board_read 读回它落的板,按板实施(不凭报告文本假装看到了板)。白板节点是**验收契约**:P0 节点必须带 accept,跑完验收 action=evidence 回填,收尾 action=audit 核对;P0 覆盖率<100% 禁止宣称完成。白板完整画法/页面板结构/成板节奏:调 tool_view(name="board_upsert") 看完整说明。
- **减步纪律**：①开工前先写实施序列（文件+动作），同一文件一次 read 到够用为止，不重读已读文件。②\`board_read\` 同板 rev 未变不重读；读完在下一步直接使用，不追加一次确认读。③同一校验命令最多重跑一次，且重跑前该轮必须已有代码或配置改动。④被闸门/权限拒绝时先读返回的 reason 再换路径，禁止原样重试同一命令。⑤工具调用步内不写进度叙述，进度只在轮末总结或轮首声明。
- **白板一次写全**:一次 board_upsert 提交全部节点与边(勿分轮补);证据用 evidenceByNode{节点id:[...]} 一次批量回填所有节点,不逐节点刷。
- **并行工具(重要,直接省上下文)**:多个**互不依赖**的动作要在**同一个回合里一起发**,不要一个一个等。适用:同一批探测(list_dir+read_file+code_sense)、独立文件的多处小改(多个 edit_file)、互不相关的验证命令。terminal 的写文件/覆盖类操作不要并行(顺序敏感)。每多发一个并行调用,就少一轮把全量上下文重发一次的代价(实测长会话每轮 input 30 万+ token)。`;
const SYSTEM_DISPATCH = `
- **fixG2 派发与等待纪律**:多个独立子任务在**同一条消息里并行派** spawn_subagent;等待用 spawn(wait:true) 或 task_output(waitFor:"result")(挂起期间零 LLM 消耗),不要短轮询 task_output 打发等待;不要动手做在跑子代理任务书里的内容(双倍成本)。任务书面向单个执行者:动词+精确目标+可验证验收+收敛判据(如「断言全绿即返回;连续 2 轮失败带最小复现返回」)。
- **复杂工具首用**:首次使用复杂工具(board_upsert/spawn_subagent/browser 等)前先 tool_view(name=...) 看完整说明再调用。`;
const SYSTEM_VERIFY = `
- **影响面纪律**:改既有函数(修改/删除/签名变更)前必先用 code_sense 拿改动影响面(双向调用闭包+受影响文件+关联测试),按清单同步调用方与测试;新增不受此约束。
- **完工验收四步**(coding 类,汇报完成前必走):①用 code_sense 复核影响面;②code_review 审的是**本任务变更集**(以开工 checkpoint 为基线;blocker/high 必修,修完 fast:true 复跑;深审超 2 轮不收敛就带残留收尾;findings 指向变更集外=环境噪声纪律:登记不修;深审超时=可收工——时间盒就是终止条件,不要补跑深审);③相关测试单文件定向跑,报告必须带三要素(条件/通过标准/实际结果,只写「xx/yy 全绿」无效);④board_upsert action=audit 核对 P0 覆盖率。**fixG3 验证轮次自省**:同一验证命令连续 3 轮失败→立即停止「改一下再跑」(实测 terminal 修跑循环×58 的教训),带最小复现换策略或如实收尾。某步不适用要说明原因,不许静默跳过或谎报做过。
- **自测收敛**:写完代码把断言集中到一个脚本一次跑完,不分轮写/跑;同一逻辑最多验 2 轮,第 3 轮失败即停并如实报告;node 跑 .ts 直接用运行环境段给的路径,不另行探测。`;
const SYSTEM_TAIL = `
- **输出风格:简明扼要**(不要长篇大论):结论先行,证据(文件:行号/输出摘录)跟后;不复述大段原文与过程细节。多步任务先 todo_write 建计划并随进度更新。子代理失败如实说失败,不编造成功。
- **图卡通道**:分层架构卡/战略矩阵/设计稿级示意图(mermaid 表达不了布局/排版/标注)用自包含 \`\`\`html(内联 CSS、无脚本无外链,首行可 \`\`\`html height=720)或 \`\`\`svg 围栏交付,面板会渲染成图卡;简单流程/依赖仍用 mermaid。
- **git 纪律**:不经用户明示,绝不 git commit/push;改动留在工作区由用户审。`;
const SYSTEM_SENSE = `
- **code_sense 用法**(代码认知统一入口;结构面毫秒级、语义画像面秒级):**按问题选能力,别套固定几个命令**——想知道「有哪些能力、这轮该怎么传参」,先 tool_view(name="code_sense") 看全量说明再动手;下面只是索引不是白名单。常见场景:符号定义/调用方/被调方、文件符号表、改动波及面与关联测试、字面量引用面(删改字符串标识时符号面会全空)、分支与循环条件、整仓主干与分层、协议表面(WS 消息↔收发点)、变量类型清单;语义面用于调用链时序、模块导读、关键词聚合、接口/状态机/算法/页面流画像。**唯一硬约束**:符号类查询的目标必须是真实代码符号名(传目录路径/自然语言必然全空,不是工具没能力)。`;

/**
 * 运行环境段(减步轮):16 题评测 215 次调用里 128 次是探索,其中 31 步(14%)纯在找
 * node 解释器、53 步在试「怎么用 node 跑 .ts」——这些启动时就确定,不该每题重探。
 * 探测一次即缓存(模块级),只读不写:候选 = process.execPath + ~/.nvm/versions/node 下所有 bin/node,
 * 各自 `-v` 问版本,取满足 ≥22.6(--experimental-strip-types 可用的最低线)的最高版本;全不满足则回落 execPath。
 */
let runtimeEnvCache: string | null = null;
export function runtimeEnvBlock(): string {
  if (runtimeEnvCache !== null) return runtimeEnvCache;
  const cands: string[] = [process.execPath];
  try {
    const home = process.env.HOME ?? "";
    const root = _join(home, ".nvm", "versions", "node");
    for (const v of readdirSync(root)) cands.push(_join(root, v, "bin", "node"));
  } catch { /* 无 nvm 目录:只用 execPath */ }
  const verOf = (p: string): [number, number, number] | null => {
    try {
      const out = _execFileSync(p, ["-v"], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim();
      const m = /^v(\d+)\.(\d+)\.(\d+)/.exec(out);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    } catch { return null; }
  };
  const seen = new Set<string>();
  let bestPath = "";
  let bestVer: [number, number, number] | null = null;
  const newer = (a: [number, number, number], b: [number, number, number] | null): boolean =>
    b === null || a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
  for (const p of cands) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    const v = verOf(p);
    if (!v || !newer(v, bestVer)) continue;
    bestPath = p;
    bestVer = v;
  }
  const ok = bestVer !== null && (bestVer[0] > 22 || (bestVer[0] === 22 && bestVer[1] >= 6));
 // 版本已体现在路径里(/versions/node/v24.22.2/bin/node),不再单独标版本以压进 200 字符预算。
 // 兜底(无 ≥22.6):必须显式告警,否则 agent 会拿一个不支持 strip-types 的 node 去跑 .ts 并反复失败重试。
  const line = ok
    ? bestPath
    : `${process.execPath}(⚠ 本机无 ≥22.6 的 node:strip-types 不可用,跑 .ts 前先确认或改用纯 JS)`;
  runtimeEnvCache = `
## 运行环境(勿跑 which node/node -v/ls ~/.nvm)
- node: \`${line}\`
- TS: \`node --experimental-strip-types <f.ts>\`(别-e)
- 禁 enum/namespace/构造参数属性/装饰器;import 必带 .ts`;
  return runtimeEnvCache;
}

/** 兼容导出:编码类全文(既有引用/测试不动)。运行环境段纯收益,完整档与精简档都加。 */
export const SYSTEM = SYSTEM_A + SYSTEM_PLAN + SYSTEM_DISPATCH + SYSTEM_VERIFY + SYSTEM_TAIL + SYSTEM_SENSE + runtimeEnvBlock();

/**
 * 精简档( token 轮 P2):只保留安全与输出必需项,省掉流程仪式主体。
 * 口径依据:ours system prompt 4,853 字符其中中文 53%,中文 token 密度是英文 2.66×;
 * 简单任务(短任务书)不值得每步背五阶段/plan-gate/验收四步全文——精简档 ~1.1k 字符,
 * 每步省 ~2,000 tok。触发口径见 systemForTaskClass 的 opts.lite + 调用点(指令 <1450 字符)。
 * 硬约束:git 纪律与破坏性操作防护**不削**;task_phase/board_upsert 工具仍可用(只是不强制)。
 */
export const SYSTEM_LITE = `你是 lampgenie-harness 的 vibe coding 主 agent(编码轨,唯一身份声明)。
- **输出风格**:简明扼要,结论先行,证据(文件:行号/输出摘录)跟后;不复述原文与过程细节。
- **上下文卫生**:不整读大文件(read_file 只做局部 offset/limit 确认);查代码先 code_sense 而不是 grep,grep 只用于字面文本。
- **code_sense 场景**:改既有函数前先 \`action=impact target=<符号名>\` 一次拿调用方/被调方/关联测试,别用 grep/read_file 逐个找;陌生文件用 \`action=file\` 一次拿符号表。
- **节奏**:小改(单文件/局部)直接做;发现范围超出单文件或波及多模块,再用 board_upsert 落板并回归完整流程(task_phase/board_upsert 工具始终可用,本档不强制声明阶段)。
- **白板一次写全**:一次 board_upsert 交全部节点与边;证据用 evidenceByNode 一次批量回填。
- **并行工具**:多个互不依赖的动作(探测/独立小改/验证)在**同一回合一起发**,别一个个等;每少一轮就少一次全量上下文重发。
- **收尾**:改既有函数前先 code_sense 看影响面,相关测试单文件定向跑并报三要素(条件/通过标准/实际结果);断言集中一个脚本一次跑完,同一逻辑最多验 2 轮,第 3 轮失败即停并带最小复现如实报告。
- **安全红线**:不经用户明示绝不 git commit/push;破坏性操作(删文件/覆盖用户改动/强推/改生产配置)先 ask_user 确认;改动留在工作区由用户审。
- 子代理/命令失败如实说失败,不编造成功。` + runtimeEnvBlock();

/**
 * 提示词版本运行时 provider( #209 运行面):装配方注入「按 key 取显式覆盖」的同步函数。
 * 缺省未注入=永远用内置常量(旧行为逐字不变);provider 抛错也回退常量。
 */
export type RuntimePromptProvider = (
  key: "system.coding" | "system.coding.lite",
  sessionId?: string) => string | undefined;

let runtimePromptProvider: RuntimePromptProvider | undefined;

/** 装配方(app.ts)注入运行时提示词 provider;传 undefined 可恢复缺省(测试隔离用)。 */
export function setRuntimePromptProvider(provider: RuntimePromptProvider | undefined): void {
  runtimePromptProvider = provider;
}

/**
 * 按任务类别组系统纪律段(理解阶段定类,提示词按类出;类别可被
 * task_phase(taskClass=...) 更正,更正后下一轮次起按新类)。
 * coding=全文;qa=免阶段/白板/验收仪式,保留派发+code_sense 用法(调研查代码高频);
 * office=只留通用段。两条类别注记都带更正路径——初判错类时模型自己能纠正。
 * 装配方注入 provider 时,coding 两档先尝试提示词版本覆盖(revision>1 才生效)。
 */
export function systemForTaskClass(
  cls: TaskClass,
  opts: { lite?: boolean; sessionId?: string } = {},
): string {
  if (cls === "coding" && runtimePromptProvider !== undefined) {
    const key = opts.lite ? "system.coding.lite" : "system.coding";
    try {
      const overridden = runtimePromptProvider(key, opts.sessionId);
      if (typeof overridden === "string" && overridden.trim() !== "") return overridden;
    } catch {
 // provider 故障:回退内置常量,不碰任务主链
    }
  }
 // 精简档( token 轮 P2):coding 短任务书走 SYSTEM_LITE;qa/office 分支行为不变。
  if (cls === "coding" && opts.lite) return SYSTEM_LITE;
  if (cls === "qa") {
    return SYSTEM_A + SYSTEM_DISPATCH + SYSTEM_TAIL + SYSTEM_SENSE
      + "\n- **任务类别(qa 问答/调研)**:本任务免五阶段/白板/plan-gate 仪式——直接调查并输出结论(结论先行,出处带 file:line/链接;只读,不改代码不落板);若理解后发现需要改代码,task_phase(taskClass=\"coding\") 更正,全套编码纪律(阶段/板/影响面/验收)即刻生效。";
  }
  if (cls === "office") {
    return SYSTEM_A + SYSTEM_DISPATCH + SYSTEM_TAIL
      + "\n- **任务类别(office 办公/产出)**:本任务免五阶段;但动笔前要先落**作业思路板**(board_upsert boardType=\"composition\":主题/受众/表达结构/几章/每章主题/章间关系与顺序)或传 exemptReason 留痕豁免(确无表达结构时)——plan-gate 按此硬闸放行;先明确产出要求(格式/篇幅/受众,不清楚先问),直接制作;交付前自查内容完整/格式正确/无占位残留;若过程涉及改代码,task_phase(taskClass=\"coding\") 更正后按编码纪律执行。"
      + "\n- **研究/调研类引用账本(必做)**:每个检索来源先 web_fetch 抓到正文,再 cite_source(url+逐字出现在抓取正文里的 quote) 换编号;正文编号只用它返回的 [n](不许自己排序/改号);无检索证据的推断标 [unverified];收尾会按登记表校验,未登记/越界编号会被点名。"
      + "\n- **产出方法论(动笔前必读)**:按产物先 skill_view 对应技能——任何产出都先读 builtin/office-writing(内核:开工四问、论点四段、禁提纲交付、去 agent 腔句式清单、能画图就别写表格);PPT 加读 builtin/office-pptx 与 builtin/ppt-master(生产环境:判型/四步门/版式容量表/能力边界),Word 加读 builtin/office-docx,Excel 加读 builtin/office-xlsx,周报/复盘/方案/调研报告加读 builtin/office-report。**要真正落一份 .pptx 时派子代理**:spawn_subagent(agentType=\"ppt-master\")(它带 board_export_pptx 质量门,交付前逐条过门);自己写文档/表格不必派。四条硬线:①**开工四问先答完**——面向谁报告(谁看/要拿它做什么决定)、汇报主题是什么(一句疑问句)、要突出的重点是哪 1~2 条且这次不讲哪 2~3 条、每个论点的论据与分析从哪来;答不上先问人或去查,不许边写边想;②**每个论点四段齐全**——主张 + 可溯源论据(数字/来源/口径)+ 分析(因果或排除推理,不许复述论据)+ 结论/所以呢,并主动写反证(什么条件下这条不成立);③正文按人话写,禁开场报幕、收尾谢幕、过程自述与空心副词;④流程/结构/时序/趋势一律画图(Markdown 用 mermaid 代码块,PPT 用原生形状与图表),表格只装结构化数据。";
  }
  return SYSTEM;
}

/** ask_user 工具(许愿式编程):需求有取舍时向用户发问并阻塞等待。
 * 有界:router 侧 10 分钟超时;离线/超时→返回「未答复」文本,agent 按最合理推断继续(不卡死)。
 * 会话上下文:只允许主 agent 使用(子代理无面板入口,不注册)。 */