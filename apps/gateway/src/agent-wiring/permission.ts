/**
 * agent-wiring 分片:permission(自 agent-wiring.ts 7910 行按域拆分,逐字搬移)。
 * 原路径 agent-wiring.ts 保留具名转发 barrel;消费方零改动。
 */
import { ownTerminalUnits, getTerminalService } from "./wiring-core.js";
import { skillViewTool, boardReadTool, boardUpsertTool } from "./tools.js";
import { getJobRegistry } from "./wiring-core.js";
import { rootScanVerdict } from "../sense-root-gate.js"; // 本文件 warmIndex 闸消费(2997)

// 开工 orient 注入链已整体删除:orientWithSense/symbolsInText/orient-cache 系列
// (scanFingerprint/orientCacheKey/readOrientCache/warmOrientCache)。每条 user message
// 跟一条「全局代码+历史匹配」tips 多余且常错配——code_sense 内容必须是拉取式(call 工具才返回);
/**
 * 主 agent 接线:任务由 AgentLoop 驱动;loop 的工具之一是 spawn_subagent
 * (派 executor 干重活),完成即任务 done。
 */
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
// 工具注册身份治理:装配后统一登记身份,冲突/保留名命中从工具面剔除。
import { ToolIdentityRegistry } from "@lampgenie/runtime/agent/tool-identity";
import { meetingImportTool } from "../meeting-tools.js";
import {
  computeP0Coverage, markDoneFromEvidence, renderP0Status, smokeTemplateNode, staleSummaryOf,
  PACKAGING_PREFLIGHT, type P0NodeStatus, type BoardNodeT,
} from "../board-accept.js";
import { loadBoard as loadBoardSync, boardPath as boardFilePath, loadBoardAsync, listBoardsExAsync, LABEL_MAX_CHARS } from "../board-store.js";
/** audit 结果落盘目录名(相对 storeRoot, N1 修复:audit 现算不落盘,事后取不到)。 */
export const BOARD_AUDIT_DIR = ".genie/boards-audit";
import { boardSkillBody, parseBoardSkillName } from "../board-skills.js";
import { boardExportPptxTool } from "../board-export-pptx-tool.js";
import { deriveBoardEdges } from "../board-derive.js";
import { isContentNode } from "../board-content-predicate.js";
import { makeCalleesResolver } from "../board-derive-resolver.js";
import { composeSystemPrompt, discoverAgentsMd, renderSubagentDispatchSection, renderSkillIndex, SKILL_INDEX_MAX_CHARS, type SkillIndexEntry, type ToolHint } from "@lampgenie/runtime/agent/system-composer";
import { ParentAskBroker, driveParentDecision, renderPendingQuestionsBlock, buildSubagentAnswerTool } from "@lampgenie/runtime/agent/parent-ask-broker";
import { SubagentRegistry } from "@lampgenie/runtime/agent/subagent-registry";
// / 子代理控制面纯逻辑:steer 越权裁决 / 冷启动续跑计划 / fork 摘要 / 隔离与回收契约。
import { MAX_SUBAGENT_DEPTH, depthOf, forkContextBlock, isolationVerdict, resumePlan, scratchContract, steerVerdict } from "@lampgenie/runtime/agent/subagent-control";
// 深度从 registry 父子链推导(不信参数)+ 子代理 deny 并集收敛 + 续跑会话键(纯逻辑模块)。
import { PRIMARY_ONLY_TOOLS, convergeDeny, resumeSessionKey, spawnDepthVerdict } from "@lampgenie/runtime/agent/subagent-depth";
// 注意力预算:外发消息(提问/路由 note/终端交付)的用途/长度/结构化/去重门。
import { guardAskUserPayload, guardRouteNote, guardTerminalNotice } from "@lampgenie/runtime/agent/attention-budget";
//  后台子代理 idle wake:父会话空闲时把终态通知合并成一次 model-only turn(判定纯逻辑在 runtime)。
import { generationOfEvent, wakeVerdict, type PendingNotification, type WakeCode } from "@lampgenie/runtime/task/idle-wake";
import { loadSoul, DEFAULT_SOUL_MD, MemoryStore } from "@lampgenie/runtime/agent/soul-memory";
import { loadAgentProfiles, formatAgentProfiles, composeSubagentInstructions, expandToolTokens, resolveProfileTools, toolGrantMatched } from "@lampgenie/runtime/agent/agent-profiles";
import { sessionSearchTool } from "../session-search.js";
import { SUBAGENT_READ_TOOLS, SUBAGENT_WRITE_TOOLS } from "../llm-loop-backend.js";
import type { SessionModelFace } from "../session-model.js";
// 任务档案:类型面走 runtime src(types 条件);值面由 task-profile-store 惰性加载(不在启动期 TLA)。
import type { TaskProfile } from "@lampgenie/runtime/agent/task-profile";
import { makeCompactHook } from "../compact-hook.js";
import { autoCompactGate } from "../compact-gate.js";
import { attachToolView } from "../tool-view.js";
// 终态正文投递:message.system 直接带 output.txt 正文,免去「摘要+指针→主 agent 再发一次
// 请求取正文」的额外 LLM 往返。纯函数与投递器见 subagent-result-digest.ts。
import { deliverFinalNotice, extractDeliverableText } from "../subagent-result-digest.js";
import { takePendingComments, renderPendingCommentsBlock } from "../board-comments.js";
import { planTaskSurface, degradeFinalFor, GUI_ONLY_TOOLS } from "../surface-capabilities.js"; // 表面/通道能力包
import { SOP_TIPS, sopTipText, renderStartProfileTip } from "../agent-wiring-sop-tips.js";
import { probeWorkStart, renderWorkStartBrief, verifyCommandsFor } from "../work-start-profile.js";
// 开工前置门(:基线新鲜度 + 规则旧措辞,纯函数在 startup-freshness.ts。
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
// 视觉尺寸守卫:附件注入与 view_image 共用同一解析器/限额,避免两条注入口各判一套。
import { checkImageSize, readImageSize } from "../image-size.js";
import { guardGitCommand, auditGitCommand, subagentGitBlockReason } from "../git-guard.js";
import { JobRegistry, TerminalSessionService, createJobTool, createTerminalTool } from "@lampgenie/terminal";
import { defaultWorktreeService, WorktreeError } from "../worktree-service.js";
import { readFileSync, existsSync, statSync, appendFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
// 板质量遥测( bq1):audit 快照指纹(节点/边序列化后 sha1 前 12 位,排序稳定)。
import { createHash } from "node:crypto";
// 附件链路:文档附件(docx/pptx/xlsx/pdf/zip…)先解析为纯文本再进上下文,
// 解析器单独一层(doc-text.ts,含 64MB 上限/永不抛错),本文件只负责分类与接线。
import { parseDocFile, isDocExt } from "../doc-text.js";
import { createAcpBackend, type SubagentBackend } from "@lampgenie/executors";
import type { TaskSupervisor } from "../task-manager.js";
import { appendUserStoppedMarker } from "../user-stop-marker.js";
import type { Task } from "@lampgenie/core";
import { normalizeTaskKind, taskKindCapabilities, filterToolNamesByKindCapabilities, type TaskKindCapabilities } from "@lampgenie/runtime/task/task-kind";
import { setPlanDeps } from "@lampgenie/code-sense";
// 合并:代码认知唯一入口 code_sense(action 结构面 + mode 语义面)承载于 sense-tool.ts;
// 本文件只做装配与提示词接线(旧 code_index 已删除)。
import { codeSenseTool } from "../sense-tool.js";
export { codeSenseTool };
// 全链路闭环变更:概念足迹工具的装配面 + 判据纯函数(plan-gate/收尾回执共用)。
import {
  closeAuditVerdict,
  makeChangeSurfaceTool,
  readChangeAudit,
  readChangeSurfaceManifest,
  readChangeExempt,
  surfaceGateVerdict,
  type ChangeSurfaceJournal,
} from "../change-surface-tool.js";
// :分类可更正——gate 判据前读本会话最近一条更正(按水位缓存,不每步全扫)。
import { readChangeScopeCorrection, type ChangeScopeCorrection } from "../change-scope-correction.js";
// :收尾残留重扫——surface 任务在收尾前重扫概念词,残留事实进 changeFacts.residual。
import { scanSurface } from "@lampgenie/code-sense/surface";
import type { ResidualFact } from "../closeout-residual.js";
// 任务级验证账本 / 交付物声明账本:纯函数与工具各一模块,收尾钩子在本文件。
import { computeVerifyLedger, renderVerifyLedgerWarning, renderVerifyRetryPrompt } from "../verification-ledger.js";
//  轮末变更账本:纯函数采集在独立模块,终态出口(finally)在这里接线。
import { captureBaseline, computeChangeLedger } from "../turn-change-ledger.js";
//  指导可度量:tip 元数据表 + 收尾指标汇总(纯函数;收尾钩子在本文件 finally)。
import { computeGuidanceMetrics, tipMetricOf, type TipMetricSpec } from "../guidance-metrics.js";
import {
  makeDeliverableTool,
  readDeliverables,
  verifyDeliverables,
  renderDeliverables,
  renderDeliverableWarning,
  type DeliverableJournal,
} from "../deliverables.js";
// 研究引用账本:cite_source 工具 + 收尾引用审计(编号只由工具给,正文 [n] 必须已登记)。
import {
  makeCiteSourceTool,
  readCitations,
  auditCitations,
  shouldAuditCitations,
  renderCitationWarning,
  renderCitationRetryPrompt,
  type CitationJournal,
} from "../citation-ledger.js";
//  完成审计(2026-11):把上面各段收尾机制的事实聚合成一张可判定记分卡(纯函数;采集/判定接线在本文件收尾段)。
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

/**
 * 权限规则装载:env GENIE_PERMISSION_RULES(JSON 数组,fromConfig 形态对象亦可)
 * > 项目 .genie/permissions.json(fromConfig 形态);无源=不设闸(行为与旧版一致)。
 * 坏 JSON 显式抛错(配置错误不该静默变成全放行)。
 */
export function loadPermissionRules(repoRootDir: string): PermissionRule[] | undefined {
  const envRaw = process.env.GENIE_PERMISSION_RULES;
  if (envRaw !== undefined && envRaw !== "") {
    const parsed = JSON.parse(envRaw) as Parameters<typeof permissionRulesFromConfig>[0] | PermissionRule[];
    return Array.isArray(parsed) ? parsed : permissionRulesFromConfig(parsed);
  }
  const file = join(repoRootDir, ".genie", "permissions.json");
  if (existsSync(file)) {
    return permissionRulesFromConfig(JSON.parse(readFileSync(file, "utf-8")) as Parameters<typeof permissionRulesFromConfig>[0]);
  }
  return undefined;
}

/** 面板/broker 审批出口的最小面(测试可注入替身)。 */
export interface PermissionAskPort {
  ask(input: { requestId: string; sessionId: string; tool: string; summary: string; risk?: string }): Promise<{ decision: "allow-once" | "reject"; by: string }>;
}

/** 决策落 journal(effect=allowed/denied,by=来源明细;与外部后端 ask 链同形)。 */
export function journalGate(journal: Journal, sessionId: string, tool: string, effect: "allowed" | "denied", by: string, extra?: { objectHash?: string; applied?: string[] }): void {
  journal.append({
    kind: "permission.gate",
    sessionId,
    payload: { tool, effect, by, ...(extra?.objectHash ? { objectHash: extra.objectHash } : {}), ...(extra?.applied ? { applied: extra.applied } : {}) },
  });
}

/* ── 权限策略链(单调收窄)+ session-always 内存作用域 ──────────────────────────
 * guard 只能 deny/abstain(见 runtime/agent/permission-guard.ts 头注:允许 allow 等于
 * 给插件式策略发无约束放行票)。这里只做接线:缺省空链 + 空存储 = 与旧行为逐字一致,
 * 接入后最多把「将放行」变成「已拒绝」。
 */

/** 进程级 session-always 存储:内存作用域,TTL + 单会话上限 + 会话隔离,重启即失效
 * (会话级授权不是策略,刻意不落盘)。 */
export const sessionAlwaysStore = new SessionAlwaysStore();

/** 装配口(缺省空链)。预留 API:生产装配方在角色/策略层注入 guard 时调用。 */
let permissionGuards: Guard[] = [];
export function setPermissionGuards(guards: Guard[] | undefined): void {
  permissionGuards = Array.isArray(guards) ? [...guards] : [];
}
/** 测试可观口:读进程级 store(断言 TTL/上限/隔离/不写不命中)。 */
export function sessionAlwaysStoreForTests(): SessionAlwaysStore { return sessionAlwaysStore; }

/** 「本会话总是允许」的键:工具 + 摘要——一次放行只对同一调用形态生效,不扩散到同工具全部调用。 */
export function permissionAlwaysKey(tool: string, summary: string): string {
  return tool + "|" + summary;
}

/** 会话内 always 的授予/撤销口(面板「总是允许(本会话)」等入口共用)。
 * no-always-allow 在场时 remember 直接拒写,命中侧由 evaluatePermission 短路。 */
export function rememberSessionAlways(sessionId: string, tool: string, summary: string, revision?: string): boolean {
  if (noAlwaysAllowEnabled()) return false;
  return sessionAlwaysStore.remember(sessionId, permissionAlwaysKey(tool, summary), {
    at: Date.now(),
    ...(revision ? { revision } : {}),
  });
}
/** 会话结束/取消的清场口;会话关闭点在 server 侧(本任务不改越界文件),此处只备接入。 */
export function clearSessionAlways(sessionId?: string): void {
  sessionAlwaysStore.clear(sessionId);
}

/** no-always-allow:env GENIE_NO_ALWAYS_ALLOW=1 > 项目 genie.config.json 的 permission.noAlwaysAllow。
 * 直读项目文件(不走 loadConfig 全量合并):语义=「项目级设置页写的值」。 */
export function noAlwaysAllowEnabled(root: string = repoRoot()): boolean {
  if (process.env.GENIE_NO_ALWAYS_ALLOW === "1") return true;
  try {
    const j = JSON.parse(readFileSync(join(root, "genie.config.json"), "utf8")) as { permission?: { noAlwaysAllow?: unknown } };
    return j?.permission?.noAlwaysAllow === true;
  } catch {
    return false;
  }
}

/** 两处 ask 决策前的统一判定:guard deny(最高优先)> session-always 命中 > 交回既有路径。
 * deny/allow 都就地落 permission.guard 审计;ask 原样返回,调用方继续走规则/面板。
 * 事件用 kind=custom + payload.type(EventKind 是 core 的封闭联合,本任务不越界改它)。 */
export function decidePermission(args: {
  tool: string;
  summary: string;
  sessionId: string;
  journal: Journal;
  now?: number;
}): PermissionEvaluation {
  const ev = evaluatePermissionGuard({
    mode: permissionMode(),
    tool: args.tool,
    sessionId: args.sessionId,
    guardCtx: { tool: args.tool, summary: args.summary, sessionId: args.sessionId },
    guards: permissionGuards,
    alwaysStore: sessionAlwaysStore,
    alwaysKey: permissionAlwaysKey(args.tool, args.summary),
    noAlwaysAllow: noAlwaysAllowEnabled(),
    now: args.now ?? Date.now(),
  });
  if (ev.effect !== "ask") {
    const guardIds = (ev.guardHits ?? []).filter((h) => h.verdict === "deny").map((h) => h.guardId);
    try {
      args.journal.append({
        kind: "custom",
        sessionId: args.sessionId,
        payload: {
          type: "permission.guard",
          tool: args.tool,
          effect: ev.effect,
          source: ev.source,
          guardId: guardIds.join(","),
          reasons: ev.denyReasons ?? [],
          ...(ev.reason ? { reason: ev.reason.slice(0, 200) } : {}),
        },
      });
    } catch { /* 审计失败不改变决策 */ }
  }
  return ev;
}

/** 关卡 Gate 风险启发式(旧主链路两处硬编码 "medium" 无信号):
 * 写/执行族=high,只读族=low,其余=medium。只影响展示与播报排序,**不改审批行为**。 */
export function riskOfTool(tool: string): "low" | "medium" | "high" {
  const t = String(tool ?? "").toLowerCase();
  if (/(write|edit|apply|patch|create|remove|delete|rename|mkdir|terminal|shell|exec|command|run|install|annotate|board_save|checkpoint)/.test(t)) return "high";
  if (/(read|grep|search|list|ls|view|get|show|sense|profile|wiki|track|usage|history|status|export)/.test(t)) return "low";
  return "medium";
}

/** 子代理工具 ask 审批链(权限传递):进程内 LLM 子代理的工具 ask 与外部后端 ask 同语义——
 * env GENIE_SUBAGENT_ASK=allow-once > mode auto/readonly > 规则(matchPermissionRule "subagent")
 * > 面板 broker > fail-closed。返回 true=放行。规则咨询用原始 summary(与外部链同域,
 * 旧前缀规则仍按前缀命中);面板卡片摘要带子工具名(「总是允许」写 subagent[*] 工具级规则,C9 归一)。 */
export function makeSubagentPermissionAsker(deps: {
  sessionId: string;
  journal: Journal;
  broker?: PermissionAskPort;
 /** 规则文件根(缺省 repoRoot;测试注入临时根隔离生产环境规则)。 */
  rulesRoot?: string;
}): (tool: string, summary: string) => Promise<boolean> {
  return async (tool: string, summary: string) => {
 // 单调收窄:后台子代理 ask 与前台同一判定(空链 = 行为不变);deny 不放行、
 // always 命中直接放行,abstain 继续走下面的 env/mode/规则/面板链。
    const guardEv = decidePermission({ tool: "subagent", summary, sessionId: deps.sessionId, journal: deps.journal });
    if (guardEv.effect === "deny") {
      journalGate(deps.journal, deps.sessionId, "subagent", "denied", "guard-denied");
      return false;
    }
    if (guardEv.effect === "allow") {
      journalGate(deps.journal, deps.sessionId, "subagent", "allowed", "session-always");
      return true;
    }
    if (process.env.GENIE_SUBAGENT_ASK === "allow-once") {
      journalGate(deps.journal, deps.sessionId, "subagent", "allowed", "env-allow-once");
      return true;
    }
    if (permissionMode() === "auto") {
      journalGate(deps.journal, deps.sessionId, "subagent", "allowed", "mode-auto(完全访问)");
      return true;
    }
    if (permissionMode() === "readonly") {
      journalGate(deps.journal, deps.sessionId, "subagent", "denied", "mode-readonly");
      return false;
    }
 // 子代理免审:仅**已钉扎**会话的 delegated child 恒 approval=never,sandbox 继承父 pin。
 // 无 pin 的会话走原规则/broker 链——否则所有子代理都跳过规则与面板审批(权限面被静默放宽)。
    const sessionPerm = resolveSessionPermission(deps.journal, deps.sessionId, currentPresetName());
    const child = sessionPerm.pinned ? childPermission(sessionPerm) : undefined;
    if (child?.approval === "never") {
      journalGate(deps.journal, deps.sessionId, "subagent", "allowed", "delegated-child(approval=never,sandbox=" + child.sandbox + ")");
      return true;
    }
    const rule = matchPermissionRule(loadRulesHot(deps.rulesRoot ?? repoRoot()), "subagent", summary);
    if (rule && rule.action === "allow") {
      journalGate(deps.journal, deps.sessionId, "subagent", "allowed", "rule-allowed:" + rule.permission + "[" + (rule.pattern ?? "*") + "]");
      return true;
    }
    if (rule && rule.action === "deny") {
      journalGate(deps.journal, deps.sessionId, "subagent", "denied", "rule-denied");
      return false;
    }
    if (deps.broker) {
      const display = tool === "subagent" ? summary : `[子代理 ${tool}] ${summary}`;
      const request = {
        requestId: "sub-perm-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        sessionId: deps.sessionId,
        tool: "subagent",
        summary: display.slice(0, 160),
        risk: riskOfTool(tool),
      };
 // 审批对象=执行对象:ask 前冻结请求对象,面板放行后按同一对象复核(fail-closed)。
      const snap = snapshotApprovalObject(request);
      const o = await deps.broker.ask(request);
      const by = o.by === "panel" ? (o.decision === "allow-once" ? "panel-approved" : "panel-denied") : "panel-" + o.by;
      const objectHash = snap.ok ? snap.hash : undefined;
      if (o.decision === "allow-once") {
        const verdict = snap.ok
          ? verifyApprovalObject(snap.frozen, request)
          : { ok: false as const, code: "PERMISSION_OBJECT_CHANGED" as const, beforeHash: "<no-snapshot>", afterHash: "<no-snapshot>" };
        if (!verdict.ok) {
          deps.journal.append({ kind: "permission.gate", sessionId: deps.sessionId, payload: { tool: "subagent", effect: "object-changed", code: verdict.code, beforeHash: verdict.beforeHash, afterHash: verdict.afterHash, by: "approval-object" } });
          journalGate(deps.journal, deps.sessionId, "subagent", "denied", "object-changed", { objectHash });
          return false;
        }
      }
      journalGate(deps.journal, deps.sessionId, "subagent", o.decision === "allow-once" ? "allowed" : "denied", by, { objectHash });
      return o.decision === "allow-once";
    }
    journalGate(deps.journal, deps.sessionId, "subagent", "denied", "auto-fail-closed");
    return false;
  };
}

/** 子代理能力计划(「一处声明、执行面真实生效」):按 agentType 查 profile,
 * profile.tools=执行白名单下发 LlmLoopBackend(缺席/空=角色二分兜底);permission=deny-only
 * 时权限规则只下传父 deny(deriveChildRules,与外部后端同语义)。纯函数,对拍测试锚定。
 * 收敛:declared/fallback 判定单一真源=resolveProfileTools(本函数薄委托,
 * 行为零变化;toolWhitelist 保持原样声明 tokens,组别名由后端 expandToolTokens 展开)。 */
export interface SubagentCapabilityPlan {
  profile?: import("@lampgenie/runtime/agent/agent-profiles").AgentProfile;
 /** 执行白名单 tokens(原样声明;组别名由后端 expandToolTokens 展开)。 */
  toolWhitelist?: string[];
 /** 写盘围栏 glob(来自 profile.writeGlobs;到场=后端 write/edit 只允许命中这些路径)。 */
  writeGlobs?: string[];
  source: "declared" | "fallback";
  denyOnly: boolean;
}

export function resolveSubagentCapability(
  profiles: import("@lampgenie/runtime/agent/agent-profiles").AgentProfile[],
  agentType: string | undefined): SubagentCapabilityPlan {
  const profile = profiles.find((p) => p.name === (agentType ?? "worker"));
  if (!profile) return { source: "fallback", denyOnly: false }; // 未知类型:role 原样下传走兜底
  const resolved = resolveProfileTools(profile.tools, []);
  const toolWhitelist = resolved.source === "declared" ? (profile.tools as string[]) : undefined;
  return {
    profile,
    ...(toolWhitelist ? { toolWhitelist } : {}),
 // 写盘围栏随能力计划下传(planner 只允许写规划稿路径)
    ...(profile.writeGlobs?.length ? { writeGlobs: profile.writeGlobs } : {}),
    source: resolved.source,
    denyOnly: profile.permission === "deny-only",
  };
}

/** spawn journal 的 toolPolicy 快照(观测面; 抽出为导出纯函数=直测锚):
 * source=declared(白名单生效)/fallback(角色二分兜底);whitelist=原样声明 tokens;
 * permission 仅 deny-only 在场;warnings=声明了但与工具池零命中的池外 tokens(不改行为只补观测,
 * 池外声明白名单过滤后自然不生效——此前静默,现可从 journal 直接发现)。 */
export interface SubagentToolPolicy {
  source: "declared" | "fallback";
  role: string;
  whitelist?: string[];
  permission?: "deny-only";
  warnings?: string[];
}

export function buildSubagentToolPolicy(
  cap: SubagentCapabilityPlan,
  role: string,
  poolNames: readonly string[],
): SubagentToolPolicy {
  const policy: SubagentToolPolicy = {
    source: cap.source,
    role,
    ...(cap.toolWhitelist ? { whitelist: cap.toolWhitelist } : {}),
    ...(cap.denyOnly ? { permission: "deny-only" as const } : {}),
  };
  if (cap.toolWhitelist) {
 // 池外判定:展开后的 token 对工具池任一名字都授不中(grant 语义与后端过滤同源 toolGrantMatched)
    const external = expandToolTokens(cap.toolWhitelist)
      .filter((t) => t !== "*" && !poolNames.some((p) => toolGrantMatched(p, [t])));
    if (external.length) {
      policy.warnings = external.map((t) => `声明工具「${t}」不在子代理工具池,白名单过滤后不生效(池:${poolNames.join("/")})`);
    }
  }
  return policy;
}

/** 子代理注入工具池:code_sense(仓库认知唯一入口,只读)+ skill_view(读技能/经验全文)+
 * MCP 桥(按白名单过滤;默认不下发)。全部交给 LlmLoopBackend 按 toolGrantMatched 统一过滤——
 * "*" 不含 MCP,须显式 "mcp"/"mcp__<server>"。 */
export function buildSubagentExtraTools(
  taskRoot: string,
  mcpTools: Tool[],
  store: ExperienceStore,
 /** 「worker 应该和 coding agent 差不多的编程/执行能力,只是不能派子代理」。
 * 传入执行面上文(journal/父会话/子代理 owner/browser 门禁/web 工具)时,额外挂载:
 * terminal(持久终端,长任务/交互式)、web_fetch/web_search(资料检索)、browser(UI 经验证)、
 * board_read(读回父会话设计板)、session_search(历史会话检索)。
 * 派发类(spawn/answer/task_output/steer/run_workflow)与用户交互类(ask_user)结构性不给。
 * planning=true(planner 角色)=规划面——只挂白板两件(board_upsert 写板 + board_read
 * 读回),**不挂** terminal/web/browser/session_search(规划者不跑构建、不经验证界面)。
 * boardWrite 给 board_upsert 落板所需上下文(父会话 sessionId + 本任务 taskId + 仓根)。 */
  execCtx?: {
    journal: Journal;
    sessionId: string;
    owner: string;
    browserConfig?: { enabled: () => boolean; allowDomains: () => string[]; idleMinutes?: () => number; profile?: () => "persistent" | "ephemeral"; profileDir?: () => string; headless?: () => boolean };
    webTools?: Tool[];
 /** 规划面(planner):白板可写 + 只读认知,无终端/浏览器/历史检索。 */
    planning?: boolean;
 /** board_upsert 落板上下文(planning 时必填):taskId=父任务 id(板文件 id),taskRoot=仓根。
 * storeRoot 可选=板存储根(缺省 repoRoot/.genie/boards;测试注入临时目录用)。
 * scope 可选=写者作用域短前缀(q1):并行 planner 各带自己的前缀(如 p1x9),落板时节点 id
 * 自动加 `${scope}-`,边同步改写——同一块板上不同写者的节点分区存放、互不覆盖。 */
    boardWrite?: { taskId: string; taskRoot: string; storeRoot?: string; scope?: string };
 /** 远程项目(SSH/WSL):code_sense 走工作区服务在远端执行。 */
    remote?: RemoteProject;
 /** 产出面(ppt-master 角色:挂 board_export_pptx——它的质量门是 deck 的唯一交付通道。
 * planner 明确不挂(分工:planner 只出结构,文件由产出角色生成,见下方 planning 分支注释)。 */
    deckExport?: { taskId: string; taskRoot: string };
  },
): Tool[] {
  const base = [codeSenseTool(taskRoot, execCtx?.remote), skillViewTool(store, () => disabledBuiltins(repoRoot())), ...mcpTools];
  if (!execCtx) return base;
  if (execCtx.planning) {
 // 规划面:白板读写是 planner 的核心产出通道。
 // q4:带 scope 的 planner 落**独立板** `<taskId>-<scope>.json`——此前它并进父任务板,
 // 主 agent 的 audit 把自己的 P0 和别的任务的规划契约一起算,永远过不了。
 // 无 scope(=拿不到写者身份)时退化为旧的「同板写」行为,不虚构分区。
    const scope = (execCtx.boardWrite?.scope ?? "").trim().replace(/[^a-zA-Z0-9-]/g, "").replace(/^-+|-+$/g, "");
    const boardId = execCtx.boardWrite && scope !== "" ? `${execCtx.boardWrite.taskId}-${scope}` : execCtx.boardWrite?.taskId;
    const plan: Tool[] = [boardReadTool(execCtx.journal, execCtx.sessionId, execCtx.boardWrite?.storeRoot, boardId ? { boardId } : {})];
    if (execCtx.boardWrite) {
      plan.push(boardUpsertTool(execCtx.journal, execCtx.sessionId, execCtx.boardWrite.taskId, execCtx.boardWrite.taskRoot, execCtx.boardWrite.storeRoot, execCtx.boardWrite.scope, { partition: true }));
 // 分工修正:PPT 文件由 coding agent 产出,planner 只出结构——导出工具不给 planner。
    }
    return [...base, ...plan];
  }
  const exec: Tool[] = [
 // workspace=工作区内档:命令围栏(与 file-tools.fencePath 同口径,围栏根=taskRoot);其余档不注入=零回归
    ownTerminalUnits(createTerminalTool({
      service: getTerminalService(execCtx.journal),
      owner: execCtx.owner,
      root: taskRoot,
 // 命令闸(子代理面, g1):git 写/破坏命令**任何档位**一律拒(11-05 有子代理 git stash
 // 收走全仓 142 个未提交文件);workspace 档再叠加既有路径围栏(其余档路径围栏不注入=零回归)。
      fenceCommand: (c: string) => {
        const gv = guardGitCommand(c);
        if (gv && (gv.destructive || gv.write)) return subagentGitBlockReason(gv);
        return permissionMode() === "workspace" ? fenceCommand(c, taskRoot) : null;
      },
    }), { journal: execCtx.journal, owner: execCtx.owner, sessionId: execCtx.sessionId, service: getTerminalService(execCtx.journal) }),
 // :后台命令 job(与 terminal 同 owner;通知路由回父会话)。
    createJobTool({
      registry: getJobRegistry(execCtx.journal),
      owner: execCtx.owner,
      sessionId: execCtx.sessionId,
      root: taskRoot,
      fenceCommand: (c: string) => {
        const gv = guardGitCommand(c);
        if (gv && (gv.destructive || gv.write)) return subagentGitBlockReason(gv);
        return permissionMode() === "workspace" ? fenceCommand(c, taskRoot) : null;
      },
    }),
    ...(execCtx.webTools ?? []),
 /* owner(2026-11 browser-ux-redo):子代理用 execCtx.owner(subagentId 派生)做 tab 归属,
 与人类视图(human)及其他 agent 隔离,tabs 行显示 owner。 */
    ...(execCtx.browserConfig ? [createBrowserTool(repoRoot(), execCtx.browserConfig, execCtx.owner || "agent")] : []),
    boardReadTool(execCtx.journal, execCtx.sessionId),
    ...(execCtx.deckExport ? [boardExportPptxTool(execCtx.sessionId, execCtx.deckExport.taskId, execCtx.deckExport.taskRoot)] : []),
    sessionSearchTool(execCtx.journal, execCtx.sessionId),
  ];
  return [...base, ...exec];
}

/** 子代理技能索引文本(granted 含 skill_view 时进子代理系统提示):与主 agent 索引同源
 * (内置+用户经验,停用项过滤),行格式同主 agent(n6:`- <cat>/<name>: <desc≤250 (当: …) (file: <abs>)`),
 * 预算放宽到 8000 字符,超预算降级为 name + file 一行(renderSkillIndex 内实现)。 */