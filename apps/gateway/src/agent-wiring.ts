/**
 * 主 agent 接线:任务由 AgentLoop 驱动;loop 的工具之一是 spawn_subagent
 * (派 executor 干重活),完成即任务 done。
 */
import { repoRoot } from "./repo-root.js";
import { systemPromptSha, recordSystemPromptSnapshot } from "./system-prompt-snapshot.js";
import { buildVlmFromConfig } from "./factory.js";
import { remoteLs, remoteReadWindow, remoteWrite, remoteEdit, remoteGlob, remoteExec, shQuote, remoteRun, remoteGit } from "./ssh-ops.js";
import { tryChannelJson } from "./remote-channel.js";
import { parseRemoteProject, type RemoteProject } from "./remote-project.js";
import { snapshotApprovalObject, verifyApprovalObject } from "./approval-object.js";
import { makeLlmTraceSink } from "./llm-trace.js";
import { mkdirSync as _mdSync } from "node:fs";
import { execFileSync as _execFileSync } from "node:child_process";
import { join as _join, dirname as _dir } from "node:path";
import type { Journal } from "@lampgenie/core";
import { bus } from "@lampgenie/core";
import { readSecretValue } from "@lampgenie/core";
import { AgentLoop, deriveMessages, type AgentStreamEvent, type LlmProvider, type Tool } from "@lampgenie/runtime/agent/loop";
// M153 工具注册身份治理:装配后统一登记身份,冲突/保留名命中从工具面剔除。
import { ToolIdentityRegistry } from "@lampgenie/runtime/agent/tool-identity";
import { meetingImportTool } from "./meeting-tools.js";
import {
  computeP0Coverage, markDoneFromEvidence, renderP0Status, smokeTemplateNode, staleSummaryOf,
  PACKAGING_PREFLIGHT, type P0NodeStatus, type BoardNodeT,
} from "./board-accept.js";
import { loadBoard as loadBoardSync, boardPath as boardFilePath, loadBoardAsync, listBoardsExAsync, LABEL_MAX_CHARS } from "./board-store.js";
/** audit 结果落盘目录名(相对 storeRoot,2026-11-06 N1 修复:audit 现算不落盘,事后取不到)。 */
const BOARD_AUDIT_DIR = ".genie/boards-audit";
import { boardSkillBody, parseBoardSkillName } from "./board-skills.js";
import { boardExportPptxTool } from "./board-export-pptx-tool.js";
import { deriveBoardEdges } from "./board-derive.js";
import { isContentNode } from "./board-content-predicate.js";
import { makeCalleesResolver } from "./board-derive-resolver.js";
import { composeSystemPrompt, discoverAgentsMd, renderSubagentDispatchSection, renderSkillIndex, SKILL_INDEX_MAX_CHARS, type SkillIndexEntry, type ToolHint } from "@lampgenie/runtime/agent/system-composer";
import { ParentAskBroker, driveParentDecision, renderPendingQuestionsBlock, buildSubagentAnswerTool } from "@lampgenie/runtime/agent/parent-ask-broker";
// M183 注意力预算:外发消息(提问/路由 note/终端交付)的用途/长度/结构化/去重门。
import { guardAskUserPayload, guardRouteNote, guardTerminalNotice } from "@lampgenie/runtime/agent/attention-budget";
import { loadSoul, DEFAULT_SOUL_MD, MemoryStore } from "@lampgenie/runtime/agent/soul-memory";
import { loadAgentProfiles, formatAgentProfiles, composeSubagentInstructions, expandToolTokens, resolveProfileTools, toolGrantMatched } from "@lampgenie/runtime/agent/agent-profiles";
import { sessionSearchTool } from "./session-search.js";
import { SUBAGENT_READ_TOOLS, SUBAGENT_WRITE_TOOLS } from "./llm-loop-backend.js";
import type { SessionModelFace } from "./session-model.js";
import { makeCompactHook } from "./compact-hook.js";
import { autoCompactGate } from "./compact-gate.js";
import { attachToolView } from "./tool-view.js";
// 终态正文投递(2026-10-30):message.system 直接带 output.txt 正文,免去「摘要+指针→主 agent 再发一次
// 请求取正文」的额外 LLM 往返。纯函数与投递器见 subagent-result-digest.ts。
import { deliverFinalNotice, extractDeliverableText } from "./subagent-result-digest.js";
import { takePendingComments, renderPendingCommentsBlock } from "./board-comments.js";
import { planTaskSurface, degradeFinalFor, GUI_ONLY_TOOLS } from "./surface-capabilities.js"; // M167 表面/通道能力包(2026-11-08)
import { SOP_TIPS, sopTipText } from "./agent-wiring-sop-tips.js";
// 开工前置门(M9,2026-11-08):基线新鲜度 + 规则旧措辞,纯函数在 startup-freshness.ts。
import { readBaselineStatus, planFreshnessSkip, planFreshnessAction, renderFreshnessLine, loadWordingTable, scanRuleWording, renderWordingLines } from "./startup-freshness.js";
import type { FreshnessConfig } from "./startup-freshness.js";
import { buildDefaultMicrocompactThreshold, DEFAULT_GROWTH_SPURT_TOKENS } from "@lampgenie/runtime/agent/microcompact";
import { bigResultEnabledFromEnv } from "@lampgenie/runtime/agent/big-intake";
import { readFilesOf, renderParentReadBlock } from "@lampgenie/runtime/agent/read-file-state";
import type { InjectGate } from "@lampgenie/runtime/agent/inject-gate";
import { dynTipKeys, dynTipText, type DynSignals } from "./agent-wiring-dynamic-tips.js";
import { broadcastTraceStatsOf } from "./compact-hook.js";
import type { NodeRegistry, NodeDispatch } from "./nodes.js";
import { dispatchGuard } from "./nodes.js";
import { permissionRulesFromConfig, deriveChildRules, matchPermissionRule, evaluatePermission, type PermissionRule } from "@lampgenie/core";
import { loadRulesHot } from "./permission-store.js";
import { permissionMode } from "./permission-mode.js";
import { BUILTIN_COMMANDS } from "./command-catalog.js";
import {
  findIssuedEnvelope,
  recordCapabilitySurface,
  verifyEnvelope,
  type CapabilitySnapshot,
  type EnvelopeCurrent,
  type EnvelopeDeps,
  type EnvelopePolicy,
  type IssuedEnvelopeLookup,
} from "./task-envelope.js";
import { childPermission, currentPresetName, pinSession, resolveSessionPermission } from "./permission-presets.js";
import { createBrowserTool } from "./browser-tool.js";
import { createWebTools, resolveSearchRuntimeFromConfig } from "./web-tool.js";
import { createFileTools, fenceCommand } from "./file-tools.js";
import { createWaitUntilTool } from "./wait-until-tool.js";
import { teamTaskTool } from "./team-task-tool.js";
import { createCodeModeTool, type CodeModeJournal } from "./code-mode-tool.js";
// 视觉尺寸守卫(2026-11-05):附件注入与 view_image 共用同一解析器/限额,避免两条注入口各判一套。
import { checkImageSize, readImageSize } from "./image-size.js";
import { guardGitCommand, auditGitCommand, subagentGitBlockReason } from "./git-guard.js";
import { JobRegistry, TerminalSessionService, createJobTool, createTerminalTool } from "@lampgenie/terminal";
import { defaultWorktreeService, WorktreeError } from "./worktree-service.js";
import { readFileSync, existsSync, statSync, appendFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
// 板质量遥测(2026-11-05 bq1):audit 快照指纹(节点/边序列化后 sha1 前 12 位,排序稳定)。
import { createHash } from "node:crypto";
// 2026-10-29 附件链路:文档附件(docx/pptx/xlsx/pdf/zip…)先解析为纯文本再进上下文,
// 解析器单独一层(doc-text.ts,含 64MB 上限/永不抛错),本文件只负责分类与接线。
import { parseDocFile, isDocExt } from "./doc-text.js";
import { createAcpBackend, type SubagentBackend } from "@lampgenie/executors";
import type { TaskSupervisor } from "./task-manager.js";
import { appendUserStoppedMarker } from "./user-stop-marker.js";
import type { Task } from "@lampgenie/core";
import { setPlanDeps } from "@lampgenie/code-sense";
// 2026-10-21 合并:代码认知唯一入口 code_sense(action 结构面 + mode 语义面)承载于 sense-tool.ts;
// 本文件只做装配与提示词接线(旧 code_index 已删除)。
import { codeSenseTool } from "./sense-tool.js";
export { codeSenseTool };
// 全链路闭环变更(2026-11-06):概念足迹工具的装配面 + 判据纯函数(plan-gate/收尾回执共用)。
import {
  closeAuditVerdict,
  makeChangeSurfaceTool,
  readChangeAudit,
  readChangeSurfaceManifest,
  readChangeExempt,
  surfaceGateVerdict,
  type ChangeSurfaceJournal,
} from "./change-surface-tool.js";
// M107 任务级验证账本 / M170 交付物声明账本(2026-11-07):纯函数与工具各一模块,收尾钩子在本文件。
import { computeVerifyLedger, renderVerifyLedgerWarning, renderVerifyRetryPrompt } from "./verification-ledger.js";
// M16 轮末变更账本(2026-11-07):纯函数采集在独立模块,终态出口(finally)在这里接线。
import { captureBaseline, computeChangeLedger } from "./turn-change-ledger.js";
// M23 指导可度量(2026-11-07):tip 元数据表 + 收尾指标汇总(纯函数;收尾钩子在本文件 finally)。
import { computeGuidanceMetrics, tipMetricOf, type TipMetricSpec } from "./guidance-metrics.js";
import {
  makeDeliverableTool,
  readDeliverables,
  verifyDeliverables,
  renderDeliverables,
  renderDeliverableWarning,
  type DeliverableJournal,
} from "./deliverables.js";
// M169 研究引用账本(2026-11-07):cite_source 工具 + 收尾引用审计(编号只由工具给,正文 [n] 必须已登记)。
import {
  makeCiteSourceTool,
  readCitations,
  auditCitations,
  shouldAuditCitations,
  renderCitationWarning,
  renderCitationRetryPrompt,
  type CitationJournal,
} from "./citation-ledger.js";
// M5 完成审计(2026-11):把上面各段收尾机制的事实聚合成一张可判定记分卡(纯函数;采集/判定接线在本文件收尾段)。
import { buildCompletionAudit, type CompletionFacts } from "./completion-audit.js";
import { runTaskCloseout, type CloseoutState } from "./task-closeout.js";
import { projectMainlineBlock } from "@lampgenie/code-sense/project-profile";
import { codeReview } from "@lampgenie/code-sense/review";
import { ExperienceStore, distillFromTask, mergeSkillIndex, mergeSkillIndexWith, builtinSkillBody } from "@lampgenie/experience";
import { disabledBuiltins } from "./skills-admin.js";
import { WorkflowEngine } from "@lampgenie/workflow";
import { renderTemplate } from "@lampgenie/workflow/templates";
import { join } from "node:path";

/**
 * 权限规则装载(step-033):env GENIE_PERMISSION_RULES(JSON 数组,fromConfig 形态对象亦可)
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
function journalGate(journal: Journal, sessionId: string, tool: string, effect: "allowed" | "denied", by: string, extra?: { objectHash?: string; applied?: string[] }): void {
  journal.append({
    kind: "permission.gate",
    sessionId,
    payload: { tool, effect, by, ...(extra?.objectHash ? { objectHash: extra.objectHash } : {}), ...(extra?.applied ? { applied: extra.applied } : {}) },
  });
}

/** step-1042 关卡 Gate 风险启发式(旧主链路两处硬编码 "medium" 无信号):
 * 写/执行族=high,只读族=low,其余=medium。只影响展示与播报排序,**不改审批行为**。 */
export function riskOfTool(tool: string): "low" | "medium" | "high" {
  const t = String(tool ?? "").toLowerCase();
  if (/(write|edit|apply|patch|create|remove|delete|rename|mkdir|terminal|shell|exec|command|run|install|annotate|board_save|checkpoint)/.test(t)) return "high";
  if (/(read|grep|search|list|ls|view|get|show|sense|profile|wiki|track|usage|history|status|export)/.test(t)) return "low";
  return "medium";
}

/** 子代理工具 ask 审批链(权限传递收口):进程内 LLM 子代理的工具 ask 与外部后端 ask 同语义——
 * env GENIE_SUBAGENT_ASK=allow-once > mode auto/readonly > 规则(matchPermissionRule "subagent")
 * > 面板 broker > fail-closed。返回 true=放行。规则咨询用原始 summary(与外部链同域,
 * 旧前缀规则仍按前缀命中);面板卡片摘要带子工具名(「总是允许」写 subagent[*] 工具级规则,C9 归一)。 */
export function makeSubagentPermissionAsker(deps: {
  sessionId: string;
  journal: Journal;
  broker?: PermissionAskPort;
  /** 规则文件根(缺省 repoRoot;测试注入临时根隔离产线规则)。 */
  rulesRoot?: string;
}): (tool: string, summary: string) => Promise<boolean> {
  return async (tool: string, summary: string) => {
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
    // M180 子代理免审:仅**已钉扎**会话的 delegated child 恒 approval=never,sandbox 继承父 pin。
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
      // M151 审批对象=执行对象:ask 前冻结请求对象,面板放行后按同一对象复核(fail-closed)。
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

/** 子代理能力计划(step-061「一处声明、执行面真实生效」):按 agentType 查 profile,
 * profile.tools=执行白名单下发 LlmLoopBackend(缺席/空=角色二分兜底);permission=deny-only
 * 时权限规则只下传父 deny(deriveChildRules,与外部后端同语义)。纯函数,对拍测试锚定。
 * step-069 收敛:declared/fallback 判定单一真源=resolveProfileTools(本函数薄委托,
 * 行为零变化;toolWhitelist 保持原样声明 tokens,组别名由后端 expandToolTokens 展开)。 */
export interface SubagentCapabilityPlan {
  profile?: import("@lampgenie/runtime/agent/agent-profiles").AgentProfile;
  /** 执行白名单 tokens(原样声明;组别名由后端 expandToolTokens 展开)。 */
  toolWhitelist?: string[];
  /** 写盘围栏 glob(step-138,来自 profile.writeGlobs;到场=后端 write/edit 只允许命中这些路径)。 */
  writeGlobs?: string[];
  source: "declared" | "fallback";
  denyOnly: boolean;
}

export function resolveSubagentCapability(
  profiles: import("@lampgenie/runtime/agent/agent-profiles").AgentProfile[],
  agentType: string | undefined,
): SubagentCapabilityPlan {
  const profile = profiles.find((p) => p.name === (agentType ?? "worker"));
  if (!profile) return { source: "fallback", denyOnly: false }; // 未知类型:role 原样下传走兜底
  const resolved = resolveProfileTools(profile.tools, []);
  const toolWhitelist = resolved.source === "declared" ? (profile.tools as string[]) : undefined;
  return {
    profile,
    ...(toolWhitelist ? { toolWhitelist } : {}),
    // step-138:写盘围栏随能力计划下传(planner 只允许写规划稿路径)
    ...(profile.writeGlobs?.length ? { writeGlobs: profile.writeGlobs } : {}),
    source: resolved.source,
    denyOnly: profile.permission === "deny-only",
  };
}

/** spawn journal 的 toolPolicy 快照(step-061 观测面;step-069 抽出为导出纯函数=直测锚):
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
  /** 2026-10-19 用户口径:「worker 应该和 coding agent 差不多的编程/执行能力,只是不能派子代理」。
   *  传入执行面上文(journal/父会话/子代理 owner/browser 门禁/web 工具)时,额外挂载:
   *  terminal(持久终端,长任务/交互式)、web_fetch/web_search(资料检索)、browser(UI 实测)、
   *  board_read(读回父会话设计板)、session_search(历史会话检索)。
   *  派发类(spawn/answer/task_output/steer/run_workflow)与用户交互类(ask_user)结构性不给。
   *  step-138:planning=true(planner 角色)=规划面——只挂白板两件(board_upsert 写板 + board_read
   *  读回),**不挂** terminal/web/browser/session_search(规划者不跑构建、不实测界面)。
   *  boardWrite 给 board_upsert 落板所需上下文(父会话 sessionId + 本任务 taskId + 仓根)。 */
  execCtx?: {
    journal: Journal;
    sessionId: string;
    owner: string;
    browserConfig?: { enabled: () => boolean; allowDomains: () => string[]; idleMinutes?: () => number; profile?: () => "persistent" | "ephemeral"; profileDir?: () => string; headless?: () => boolean };
    webTools?: Tool[];
    /** 规划面(planner):白板可写 + 只读认知,无终端/浏览器/历史检索。 */
    planning?: boolean;
    /** board_upsert 落板上下文(planning 时必填):taskId=父任务 id(板文件 id),taskRoot=仓根。
     *  storeRoot 可选=板存储根(缺省 repoRoot()/.genie/boards;测试注入临时目录用)。
     *  scope 可选=写者作用域短前缀(q1):并行 planner 各带自己的前缀(如 p1x9),落板时节点 id
     *  自动加 `${scope}-`,边同步改写——同一块板上不同写者的节点分区存放、互不覆盖。 */
    boardWrite?: { taskId: string; taskRoot: string; storeRoot?: string; scope?: string };
    /** 远程项目(SSH/WSL):code_sense 走工作区服务在远端执行(2026-10-27)。 */
    remote?: RemoteProject;
    /** 产出面(ppt-master 角色,2026-11-05):挂 board_export_pptx——它的质量门是 deck 的唯一交付通道。
     *  planner 明确不挂(分工:planner 只出结构,文件由产出角色生成,见下方 planning 分支注释)。 */
    deckExport?: { taskId: string; taskRoot: string };
  },
): Tool[] {
  const base = [codeSenseTool(taskRoot, execCtx?.remote), skillViewTool(store, () => disabledBuiltins(repoRoot())), ...mcpTools];
  if (!execCtx) return base;
  if (execCtx.planning) {
    // 规划面(step-138):白板读写是 planner 的核心产出通道。
    // q4(2026-10-25):带 scope 的 planner 落**独立板** `<taskId>-<scope>.json`——此前它并进父任务板,
    // 主 agent 的 audit 把自己的 P0 和别的任务的规划契约一起算,收口永远过不了。
    // 无 scope(=拿不到写者身份)时退化为旧的「同板写」行为,不虚构分区。
    const scope = (execCtx.boardWrite?.scope ?? "").trim().replace(/[^a-zA-Z0-9-]/g, "").replace(/^-+|-+$/g, "");
    const boardId = execCtx.boardWrite && scope !== "" ? `${execCtx.boardWrite.taskId}-${scope}` : execCtx.boardWrite?.taskId;
    const plan: Tool[] = [boardReadTool(execCtx.journal, execCtx.sessionId, execCtx.boardWrite?.storeRoot, boardId ? { boardId } : {})];
    if (execCtx.boardWrite) {
      plan.push(boardUpsertTool(execCtx.journal, execCtx.sessionId, execCtx.boardWrite.taskId, execCtx.boardWrite.taskRoot, execCtx.boardWrite.storeRoot, execCtx.boardWrite.scope, { partition: true }));
      // 2026-10-27 分工修正(用户口径):PPT 文件由 coding agent 产出,planner 只出结构——导出工具不给 planner。
    }
    return [...base, ...plan];
  }
  const exec: Tool[] = [
    // workspace=工作区内档:命令围栏(与 file-tools.fencePath 同口径,围栏根=taskRoot);其余档不注入=零回归
    createTerminalTool({
      service: getTerminalService(execCtx.journal),
      owner: execCtx.owner,
      root: taskRoot,
      // 命令闸(子代理面,2026-11-05 g1):git 写/破坏命令**任何档位**一律拒(11-05 有子代理 git stash
      // 收走全仓 142 个未提交文件);workspace 档再叠加既有路径围栏(其余档路径围栏不注入=零回归)。
      fenceCommand: (c: string) => {
        const gv = guardGitCommand(c);
        if (gv && (gv.destructive || gv.write)) return subagentGitBlockReason(gv);
        return permissionMode() === "workspace" ? fenceCommand(c, taskRoot) : null;
      },
    }),
    // M27:后台命令 job(与 terminal 同 owner;通知路由回父会话)。
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
export function renderSubagentSkillIndex(store: ExperienceStore, budget = SUBAGENT_SKILL_INDEX_MAX_CHARS): string {
  return renderSkillIndex(collectSkillIndexEntries(store), budget);
}

/** 子代理技能索引预算(n6:1600 → 8000,与主 agent 同格式后行更长,1600 会切出半条技能)。 */
export const SUBAGENT_SKILL_INDEX_MAX_CHARS = 8_000;

/**
 * q1 写者作用域前缀派生(并行 planner 白板分区用):从本子代理身份里取一段**稳定**短前缀。
 * 规则:优先取 bgAgentId(形如 `agent_<ts36><rand4>`)末尾 4 个 [a-zA-Z0-9] 字符;
 * 清洗后不足 4 位时退 subTaskId(形如 `<taskid8>-<agentid8>`)的确定性哈希末 4 位——
 * 全程无随机数:同一次派发永远得到同一前缀(重复提交幂等,日志/回执里可复现对账),
 * 不同派发天然不同(bgAgentId 含时间戳+随机尾)。
 * 返回空串=拿不到任何身份(不该发生),调用方按「无 scope」处理,退化为单写者旧行为。
 */
export function plannerScopeOf(bgAgentId: string, subTaskId?: string): string {
  const clean = (s: string): string => String(s ?? "").replace(/[^a-zA-Z0-9]/g, "");
  const tail = clean(bgAgentId).slice(-4);
  if (tail.length >= 4) return `p${tail}`;
  // 兜底:确定性哈希(FNV-1a 32 位)取末 4 位 36 进制,保证同派发同值、不引入随机数
  const src = `${bgAgentId}|${subTaskId ?? ""}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `p${h.toString(36).slice(-4)}`;
}

/**
 * 写前持久化屏障开关(config.agent.writeBarrier → AgentLoop)装配层取值。
 * 语义:只认 "off" / "hard" 两个字面值;其它值(拼错/旧版本字段/非字符串)与缺席一律 undefined,
 * 把缺省留给 loop 内部(hard = 现状行为)。不读 env:GENIE_WRITE_BARRIER 由 loop 内部优先解析,
 * 装配层再读一次会让「env 覆盖 config」出现两处口径。
 */
export function writeBarrierOf(
  agentConfig?: { agent?: { writeBarrier?: "off" | "hard" } } | undefined,
): "off" | "hard" | undefined {
  const v = agentConfig?.agent?.writeBarrier;
  return v === "off" || v === "hard" ? v : undefined;
}

/**
 * M58 图片 offload 装配口径(纯函数,可单测):provider 报「图片预算/尺寸」类错误时,
 * data URL 落盘到 `<root>/.genie/image-offload/<sessionId>/` 后用占位行立即重试一次。
 *
 * **根取 repoRoot()**(与 spill/tool-dumps/llm-trace 等 .genie 落盘根一致),不取 taskRoot:
 * taskRoot 在多项目任务下可能指向别的项目仓,落盘位置会随项目漂移;offload 产物属于运行时
 * 证据(.genie 下),统一在 harness 仓根。**默认开启**:不提供配置开关,需要关闭的调用方不传
 * `imageOffload` 即可(loop 层整条分支不生效,行为逐字不变)。
 */
export function imageOffloadOf(root: string = repoRoot()): { root: string } {
  return { root };
}

/** 参与「裸块 → 节」映射的一个块(2026-10-30 修 f1:此前手写两份清单,漏了 plan/workspace)。 */
export interface NamedSystemBlock { name: string; content: string }

/**
 * 裸块 → 具名节(纯函数,可单测)(2026-10-30 修 f1)。
 *
 * **病根**:system 全文用字符串 `+` 拼(`memBlock + goalBlock + planBlock + workspaceBlock + planFileBlock`),
 * 而给 loop 做节 diff 用的 `systemSections` 另手写一份,两份清单不同步 → 漏了 plan/workspace。
 * 后果不是「少发一点」而是**静默丢规则**:plan 模式与「工作区内」权限模式的约束文本在全文里,
 * 但节 diff 永远看不到它们变化 → `[系统提示更新]` 零追加 → 模型收不到「现在是 plan 模式,
 * 不许改代码」。省 token 绝不能换行为退化。
 *
 * **改法**:一个数组同时产出两份(全文由它 join、sections 直接展开),结构上不可能再漏。
 * 顺序 = 入参顺序,逐字节等价于旧字符串拼接(空块被过滤,与旧行为一致)。
 */
export function namedSystemBlocks(blocks: {
  memory?: string; goal?: string; plan?: string; workspace?: string; planFile?: string;
}): NamedSystemBlock[] {
  return ([
    ["memory", blocks.memory ?? ""],
    ["goal", blocks.goal ?? ""],
    ["plan", blocks.plan ?? ""],
    ["workspace", blocks.workspace ?? ""],
    ["plan-file", blocks.planFile ?? ""],
  ] as const)
    .filter(([, content]) => content.length > 0)
    .map(([name, content]) => ({ name, content }));
}

/** 合并内置技能 + 用户/项目经验条目(停用项过滤)成统一索引条目形态。
 * 内置技能无 SKILL.md 文件,`path` 缺席 → 行内不出 `(file: …)`(不值得为常量化技能编假路径)。 */
export function collectSkillIndexEntries(store: ExperienceStore): SkillIndexEntry[] {
  const userIndex = store.index().map((e) => ({
    category: e.category,
    name: e.name,
    description: e.description,
    ...(e.whenToUse ? { whenToUse: e.whenToUse } : {}),
    path: e.path,
  }));
  const merged = mergeSkillIndexWith(store.index(), disabledBuiltins(repoRoot()));
  const userKeys = new Set(userIndex.map((e) => `${e.category}/${e.name}`));
  const out: SkillIndexEntry[] = [...userIndex];
  for (const e of merged) {
    if (userKeys.has(`${e.category}/${e.name}`)) continue;
    out.push({ category: e.category, name: e.name, description: e.description });
  }
  return out;
}

/** 主 loop 权限闸门选项(权限传递收口):规则在场才设闸。
 * ask 处置:env GENIE_PERM_ASK_MODE=allow 或 mode=auto → allow(快路径,不变);
 * mode=ask 且 broker 在配 → onAsk 走面板审批(审批卡;超时/离线=拒绝,fail-closed 不变)——
 * 此前主 loop 的 ask 被静默 deny 且无任何审批入口(产线 journal 实锤 97 次
 * 「被权限规则拒绝」,spawn_subagent/code_sense/skill_view 全中),与 permission-mode
 * 头注「ask=规则未命中→面板审批」的文档语义相悖;readonly/plan 仍直接 deny 不咨询。 */
export function buildMainLoopPermission(
  permRules: PermissionRule[],
  broker: PermissionAskPort | undefined,
  ctx: { sessionId: string; journal: Journal },
): NonNullable<import("@lampgenie/runtime/agent/loop").AgentLoopOptions["permission"]> {
  const askMode = (process.env.GENIE_PERM_ASK_MODE === "allow" || permissionMode() === "auto") ? "allow" as const : "deny" as const;
  const brokerRef = broker;
  const panelAsk = (permissionMode() === "ask" || permissionMode() === "workspace") && process.env.GENIE_PERM_ASK_MODE !== "allow" && brokerRef
    ? async (call: { name: string; arguments: string }) => {
        const preview = String(call.arguments ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
        // M151 审批对象=执行对象:冻结真正要执行的调用(name+arguments);面板放行后复核,变了按拒绝。
        const approvalObject = () => ({ name: call.name, arguments: call.arguments });
        const snap = snapshotApprovalObject(approvalObject());
        const o = await brokerRef.ask({
          requestId: "tool-perm-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          sessionId: ctx.sessionId,
          tool: call.name,
          summary: preview ? `${call.name} ${preview}` : call.name,
          risk: riskOfTool(call.name),
        });
        const by = o.by === "panel" ? (o.decision === "allow-once" ? "panel-approved" : "panel-denied") : "panel-" + o.by;
        const objectHash = snap.ok ? snap.hash : undefined;
        if (o.decision === "allow-once") {
          const verdict = snap.ok
            ? verifyApprovalObject(snap.frozen, approvalObject())
            : { ok: false as const, code: "PERMISSION_OBJECT_CHANGED" as const, beforeHash: "<no-snapshot>", afterHash: "<no-snapshot>" };
          if (!verdict.ok) {
            ctx.journal.append({ kind: "permission.gate", sessionId: ctx.sessionId, payload: { tool: call.name, effect: "object-changed", code: verdict.code, beforeHash: verdict.beforeHash, afterHash: verdict.afterHash, by: "approval-object" } });
            journalGate(ctx.journal, ctx.sessionId, call.name, "denied", "object-changed", { objectHash });
            return false;
          }
        }
        journalGate(ctx.journal, ctx.sessionId, call.name, o.decision === "allow-once" ? "allowed" : "denied", by, { objectHash });
        return o.decision === "allow-once";
      }
    : undefined;
  return { rules: permRules, askMode, ...(panelAsk ? { onAsk: panelAsk } : {}) };
}

/** 经验库单例(项目根 .genie/experiences,Hermes 形态)。 */
function getExperienceStore(): ExperienceStore {
  return new ExperienceStore(join(repoRoot(), ".genie", "experiences"));
}
export { getExperienceStore };

/** 持久终端服务(step-122):按 journal 实例缓存——同进程多 app(测试)互不串会话;
 * owner 隔离由 tool 绑定的 task.sessionId 承担。审计落 journal custom 事件(core EventKind 既有通用口)。 */
const terminalServices = new WeakMap<object, TerminalSessionService>();
function getTerminalService(journal: Journal): TerminalSessionService {
  const key = journal as unknown as object;
  let service = terminalServices.get(key);
  if (!service) {
    service = new TerminalSessionService({
      audit: (event) => {
        try {
          journal.append({ kind: "custom", sessionId: event.owner, payload: event });
        } catch {
          /* 审计失败不影响终端操作 */
        }
      },
    });
    terminalServices.set(key, service);
  }
  return service;
}

/** M183 父代答/路由 note 门:answer_subagent 的 reason 按 route-note(30 词)截断。
 *  截断不拦应答——批准/拒绝语义必须照常落到 broker;只把超长理由收短。 */
export function withAnswerAttentionGuard(tool: Tool): Tool {
  const orig = tool.execute.bind(tool) as (a: unknown, s?: AbortSignal, c?: { callId: string }) => Promise<string>;
  return {
    ...tool,
    async execute(args: unknown, signal?: AbortSignal, ctx?: { callId: string }) {
      const a = (args ?? {}) as Record<string, unknown>;
      if (typeof a.reason === "string" && a.reason.trim()) {
        a.reason = guardRouteNote(a.reason).text;
      }
      return orig(a, signal, ctx);
    },
  };
}

/** M183 终端交付门:终态通知摘要标记 purpose=result,按 chat 预算校验;超长截断但**不拦任务**,
 *  失败/截断只 journal custom attention.blocked {code,kind,words}。正文注入(output.txt 片段)
 *  属机器内容,不受注意力预算约束,预算只覆盖人读的通知摘要。 */
export function deliverFinalNoticeWithAttention(
  journal: Journal,
  sessionId: string,
  item: Parameters<typeof deliverFinalNotice>[2],
  opts?: Parameters<typeof deliverFinalNotice>[3],
): boolean {
  const g = guardTerminalNotice(item.summary);
  if (g.blocked) {
    try {
      journal.append({ kind: "custom", sessionId, payload: { type: "attention.blocked", code: g.blocked.code, kind: g.blocked.kind, words: g.blocked.words } });
    } catch { /* 留痕失败不影响交付 */ }
  }
  const next = g.text === item.summary ? item : { ...item, summary: g.text };
  return deliverFinalNotice(journal, sessionId, next, opts);
}

/** M153 工具注册身份治理:装配完成后把整张工具面登记一遍身份,冲突/保留名命中从工具面剔除,
 * 并把剔除证据落 journal(custom payload.type="tool.identity"),供回放/看板解释「为什么这个工具不见了」。
 * 只做剔除,不改工具行为;顺序保持原装配顺序(MCP 工具排到最后登记,保证 builtin 先占名)。 */
export function governToolIdentity(tools: Tool[], journal: Journal, sessionId: string): Tool[] {
  const registry = new ToolIdentityRegistry();
  const removed = new Set<string>(); const duplicates = new Set<string>(); const aliases = new Set<string>();
  const kept = new Set<Tool>();
  const ordered = [...tools.filter((t) => !t.name.startsWith("mcp__")), ...tools.filter((t) => t.name.startsWith("mcp__"))];
  for (const t of ordered) {
    const isMcp = t.name.startsWith("mcp__");
    const r = registry.register(isMcp ? { name: t.name, source: "mcp", ownerId: "mcp" } : { name: t.name, source: "builtin" });
    if (r.ok) kept.add(t);
    else {
      removed.add(t.name);
      if (r.code === "DUPLICATE_NAME" || r.code === "RESERVED_NAME_REJECTED") duplicates.add(t.name); else aliases.add(t.name);
    }
  }
  if (removed.size > 0) journal.append({ kind: "custom", sessionId, payload: { type: "tool.identity", removed: [...removed], duplicates: [...duplicates], aliases: [...aliases], at: Date.now() } });
  return tools.filter((t) => kept.has(t)); // 保持原顺序
}

/** M27 后台命令 job 注册表:按 journal 实例缓存(与 terminal 服务同纪律)。
 * spillDir=<repoRoot>/.genie/jobs。结算通知只投递一次:custom job.done(审计真源)+
 * message.system(唤醒);wake=false(结算被 wait 当场消费)时只落审计、不再唤醒模型。 */
const jobRegistries = new WeakMap<object, JobRegistry>();
export function getJobRegistry(journal: Journal): JobRegistry {
  const key = journal as unknown as object;
  let registry = jobRegistries.get(key);
  if (!registry) {
    const created = new JobRegistry({
      root: repoRoot(),
      spillDir: join(repoRoot(), ".genie", "jobs"),
      onSettle: (event, meta) => {
        try {
          const sessionId = created.sessionForOwner(event.owner);
          journal.append({ kind: "custom", sessionId, payload: { type: "job.done", ...event } });
          if (meta.wake) {
            const detail = [
              event.title ? `${event.title} ` : "",
              event.jobId,
              event.code !== null ? `code ${event.code}` : "",
              event.signal ? `signal ${event.signal}` : "",
              `共 ${event.bytes} 字节`,
              event.spillPath ? `spill: ${event.spillPath}` : "",
            ].filter(Boolean).join(" · ");
            journal.append({
              kind: "message.system",
              sessionId,
              payload: { text: `[后台 job ${event.status}] ${detail};用 job(action=read, jobId=${event.jobId}) 取输出` },
            });
          }
        } catch {
          /* 通知失败不影响结算 */
        }
      },
    });
    registry = created;
    jobRegistries.set(key, registry);
  }
  return registry;
}

/** M27 任务终态回收:本会话 owner + 绑定到该会话的子代理 owner 的 running job 全部结算(killed)。
 * 错误吞掉:回收失败不影响任务终态。 */
export async function disposeSessionJobs(journal: Journal, sessionId: string): Promise<number> {
  try {
    return await getJobRegistry(journal).disposeSession(sessionId);
  } catch {
    return 0;
  }
}

/** 主 agent 在场工具面(单一出处:系统提示组装与设置页共用,防两处漂移)。
 * step-060 逐环审计修复:本表必须与 runWithAgent 实际挂载的 tools 数组一一对应——
 * 此前「memory」在表但从未挂载(模型被告知有该工具,调用必得「未知工具」)、
 * todo_write/import_meeting/steer_task/task_output 挂载了却不在表(标题「只列实际挂载的」双向失真)。 */
/**
 * 视觉桥装配(2026-10-25):coding.llm.vision(缺省 true)+ coding.vlm 兜底 provider。
 * vlm 端点懒建缓存(多数部署主模型多模态,永不会触达);凭证不可解析时如实抛错 fail-visible。
 */
const vlmProviderCache = new Map<string, LlmProvider>();
function visionBridgeFor(config: { coding?: { llm?: { vision?: boolean }; vlm?: { model?: string; baseUrl?: string; providerId?: string; apiKeyEnv?: string } } }): {
  mainHasVision: boolean;
  vlm?: { chat: (messages: { role: string; content: string; images?: string[] }[]) => Promise<{ content: string }> };
} {
  const mainHasVision = (config.coding?.llm as { vision?: boolean } | undefined)?.vision !== false;
  if (mainHasVision) return { mainHasVision: true };
  const key = JSON.stringify(config.coding?.vlm ?? {});
  let prov = vlmProviderCache.get(key);
  if (!prov && config.coding?.vlm) {
    prov = buildVlmFromConfig(config as import("@lampgenie/core").Config, repoRoot()) as LlmProvider;
    if (prov) vlmProviderCache.set(key, prov);
  }
  return {
    mainHasVision: false,
    ...(prov ? { vlm: { chat: (m) => (prov as unknown as { chat: (m2: unknown[], tools: unknown[], signal: undefined) => Promise<{ content: string }> }).chat(m, [], undefined) } } : {}),
  };
}

export const TOOL_HINTS: ToolHint[] = [
  { name: "spawn_subagent", hint: "把子任务派给子 agent 执行,返回最终文本;任务书涉及 build 等重操作时写明预期命令(重操作需父代理审批)" },
  { name: "answer_subagent", hint: "应答子代理的重操作执行申请(批准/拒绝+一句理由;不应答=超时自动拒绝)" },
  { name: "ask_user", hint: "向用户发问并等待答复(许愿式编程:需求有取舍/范围可能膨胀时先问再动;给 2~4 个选项+你的推断依据;问题会同时进 Super Agent 指挥台「待处理」,先答先用;离线/超时返回未答复,按最合理推断继续)" },
  { name: "read_file", hint: "读项目内文本文件(带行号,支持 offset/limit 分窗)" },
  // 2026-10-26:远程项目任务的 read_file/write_file/edit_file/glob/grep/list_dir/run_cmd 即远端同名七件
  // (工具名与本地一致,效应落远端仓库)——无需单独 remote_* 提示。
  { name: "view_image", hint: "查看项目内图片(png/jpg/jpeg/gif/webp,单张≤2MB,一次≤4张,paths 数组),注入视觉通道下一轮直接看图;看截图/UI 对照/图表必须用它,禁止用代码打印像素占位" },
  { name: "write_file", hint: "写项目内文件(新建/整体重写;覆写前先 read_file)" },
  { name: "edit_file", hint: "精确字面替换编辑(旧串唯一匹配,replace_all 可选);回执自带改后上下文(<edited>±5行带行号)——不要为验证改完再 read_file 同一文件" },
  { name: "deliverable", hint: "登记交付物(产出报告/PPT/图片/导出件等真实文件后用它登记路径);收尾自动核对存在性,声明后缺失会被点名" },
  { name: "glob", hint: "按模式匹配项目内文件(** 跨目录,按改动时间排序)" },
  { name: "grep", hint: "正则文本检索(配置/日志串/文案/模糊词);查代码结构与调用关系改用 code_sense" },
  { name: "list_dir", hint: "列目录直接子项" },
  { name: "terminal", hint: "持久终端会话(open/send/read/close/list):需要保活、交互式输入、跨命令保持 cwd/环境变量/后台进程时用;一次性命令用 run_cmd;**多条独立命令用 send 的 commands 数组一次往返**(逐条 send=每条烧一轮全量上下文)" },
  { name: "job", hint: "后台命令 job(start/list/read/wait/kill):长任务/构建/测试的独立句柄,有 jobId 与绝对字节 offset 增量读,wait 等结算(缺省 60s,超时不杀),kill 终止;结算只通知一次" },
  { name: "wait_until", hint: "条件等待(挂起零 LLM):等外部进程产出(file:路径+contains/minLines/stableMs)或终端输出静默(terminalIdle)——用它替代「sleep N; tail/grep」轮询(每轮 sleep 猜测=一次全量上下文往返);等子代理用 task_output(waitFor:\"result\"),等自己的后台命令用 job(wait)" },
  { name: "web_fetch", hint: "抓取公网页面转 markdown/纯文本(只读;SSRF/大小/超时/域名约束)。JS 渲染页会自动 browser 渲染兜底;需登录/点击仍用 browser" },
  { name: "web_search", hint: "检索网页返回 [{title,url,snippet}](配置了搜索 provider 直接走 API;未配置自动内置静态检索兜底,provider 字段标注 fallback;打开页面用 web_fetch,交互用 browser)" },
  { name: "cite_source", hint: "研究/调研写作:每个检索来源先 cite_source 登记(url+逐字出现在 web_fetch 抓取正文里的 quote),正文编号只用它返回的 [n];无检索证据的推断标 [unverified]" },
  { name: "code_sense", hint: "代码认知唯一入口:结构面 action=impact(改动影响面,改函数前必查)/symbol/file/entrypoints/project/wire/vars/refs(字面量引用面)/branches(分支/循环骨架,条件关系)/flow(整仓代码流:入口/分层/主干/枢纽,level=auto)(毫秒级);语义画像面 mode=debug 调用链+签名+时序/plan 架构/explore grep 聚合/api 接口表面/state 状态机/algo 算法画像" },
  { name: "session_search", hint: "会话全文检索/回忆:discover 用关键词找历史会话(自动化降权),scroll 看会话内命中上下文,read 读会话原文;问「上次/之前怎么做的」先调它" },
  { name: "code_review", hint: "审查代码变更返回 findings(缺省=本任务变更集:开工 checkpoint 基线;修完复跑传 fast:true 秒级确认);coding 任务汇报前**必走**的完工验收三步之一(blocker/high 必修;非 coding 任务不调)" },
  { name: "run_workflow", hint: "标准化任务的确定性编排(测试/评审/评测)" },
  { name: "skill_view", hint: "读一条经验全文" },
  { name: "experience_fold", hint: "沉淀/合并经验(fold-in 优先)" },
  // fixG(2026-10-18 先骨架后丰羽翼+开发类型分治):工具索引提示补骨架先行与分治起手线
  // fixG 收口:豁免口径绑定板规模(≤3 模块且骨架 ≤9 节点装得下)——防「任务书恰提 3 个功能模块」被读成小任务绕过分阶段
  { name: "board_upsert", hint: "设计白板=**面向人看的代码/内容逻辑图**:先画清**现状怎么走**(现有代码里真实存在的入口→分支→循环→出口,flow 写真实函数动作),本次要改的地方用 change+before 标在对应逻辑节点上(keep=纯读)。**计划留 step.md 不上板**(进度/第 N 步归 task_phase、todo_write;待办动作不画成节点);节点 symbolRef/targets 先经 code_sense 查真实符号;先骨架后丰满:第一版 ≤9 节点骨架,中大型任务第二版再展开细节" },
  { name: "board_read", hint: "读回本会话白板(只读):后续轮次参考此前规划的页面/模块结构与用户评论" },
  { name: "todo_write", hint: "写入/更新当前任务的工作计划(多步任务开工先建,面板进度实时展示)" },
  { name: "import_meeting", hint: "导入会议纪要文件(.md/.txt,参数 path=绝对路径),抽取议题/决议/待办落 .genie/meetings/" },
  { name: "steer_task", hint: "向正在运行的任务中途追加指令(转向)" },
  { name: "task_output", hint: "补查后台子代理(终态结果已自动注入,通常无需调用):只在需要 8000 字以上全文/运行中进度快照/stale 止损时用;要等到底用 waitFor:\"result\"(零 LLM,终态自动恢复);waitSec 只用于短等" },
];

/** memory 工具(hermes memory_tool 移植):双库 target=memory(环境笔记)/user(用户画像);
 * add/replace/remove/list,old_text=定位条目的唯一短子串,replace 的 content=整条新条目。
 * 只收「适用于每个会话的事实」;条目必须陈述句(写入侧强制改写祈使句)。 */
export function memoryTool(store: MemoryStore): Tool {
  const describe = (t: "memory" | "user") => {
    const u = store.usage(t);
    return `${t}: ${u.used}/${u.limit} chars`;
  };
  return {
    name: "memory",
    description:
      "跨会话持久记忆(硬字符预算)。target=user=用户是谁(姓名/角色/偏好/沟通风格);" +
      "target=memory=环境笔记(工具怪癖/项目约定/路径端点)。一条事实只进一个库。写入规范:只记适用于每个会话的持久事实;" +
      "陈述句事实(『用户偏好简短回答』正确,『总是简短回答』会被自动改写);琐碎/可重新发现/任务进度不记。" +
      "超预算时先用 remove/replace 腾位再 add。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["memory", "user"], description: "memory=环境笔记;user=用户画像" },
        action: { type: "string", enum: ["add", "replace", "remove", "list"], description: "list=查看当前条目" },
        content: { type: "string", description: "add 的新条目 / replace 的整条新条目(陈述句)" },
        old_text: { type: "string", description: "replace/remove 定位条目的唯一短子串" },
      },
      required: ["target", "action"],
    },
    isConcurrencySafe: () => false,
    async execute(args: unknown) {
      const a = args as { target?: string; action?: string; content?: string; old_text?: string };
      const t = a.target === "memory" ? "memory" : a.target === "user" ? "user" : undefined;
      if (!t) return "target 必须是 memory 或 user";
      if (a.action === "list") return `[${describe(t)}]` + "\n" + store.listing(t);
      if (a.action === "add") {
        if (!a.content) return "add 需要 content";
        const r = store.add(t, a.content);
        return r.ok ? `已写入(${describe(t)})` : `${r.reason}\n当前条目:\n${store.listing(t)}`;
      }
      if (a.action === "replace") {
        if (!a.old_text || !a.content) return "replace 需要 old_text + content(整条新条目)";
        const r = store.replace(t, a.old_text, a.content);
        return r.ok ? `已替换(${describe(t)})` : r.reason ?? "失败";
      }
      if (a.action === "remove") {
        if (!a.old_text) return "remove 需要 old_text";
        const r = store.remove(t, a.old_text);
        return r.ok ? `已删除(${describe(t)})` : r.reason ?? "失败";
      }
      return "action 必须是 add/replace/remove/list";
    },
  };
}


// code_index 工具已删除(2026-10-21 合并):结构动作并入 code_sense(action=...),
// 工具定义见 sense-tool.ts(唯一入口;graph/filegraph/api 三动作同步删除)。

// 后台子代理注册表(step-054,ZCode async agent):agentId→输出文件与状态(spawnTool 写/task_output 读)。
// model(step-060 子代理目录):本子代理实际使用的模型名(目录条目「当前模型」数据源)。
// lastEventAt(2026-10-15 机制3):最近一次子代理事件时刻——task_output 据此算 stale 标记(主 agent 止损依据)。
// cancel(2026-10-16 subagent.cancel 通路最后一步):面板目录「终止」按钮→server 查条目 cancel 句柄调用;
// 仅运行中条目持有(终态即摘除=「已收尾」时 server 诚实回 ok:false),各路径闭包读各自的 handle 变量。
// spawnedAt/deadlineAt/staleWarnMs/staleNotified(2026-10-20 防死机制):watchdog 巡检输入——
// spawnedAt=派发时刻;deadlineAt=时间盒到点时刻(应收割却仍 running=后端内部收割失灵);staleNotified=预警只发一次。
const bgAgents = new Map<string, { outputFile: string; status: string; sessionId: string; title?: string; model?: string; lastEventAt?: number; cancel?: () => unknown; spawnedAt?: number; deadlineAt?: number; staleWarnMs?: number; staleNotified?: boolean }>();
// 供 server task_output 读取(注册表本体归 agent-wiring 所有)
(globalThis as { __bgAgents?: typeof bgAgents }).__bgAgents = bgAgents;

/** watchdog 硬收割缓冲:deadline 到点后给后端内部收割路径(deadline 定时器/backend 自身)留的宽限,
 * 超过它仍 running 才认定「收割失灵=子代理已死」(进程内 loop 崩溃/外部后端进程僵死均属此类)。 */
const SUBAGENT_WATCHDOG_GRACE_MS = 60_000;
// 2026-10-21 用户口径「子agent运行时间不要设置最大时间」:无时间盒条目不再有兜底硬上限——
// 未设 deadlineMin 的子代理只受 stale 预警(可见性),永不被 watchdog 判死。

export interface SubagentWatchdogAction {
  agentId: string;
  kind: "stale-warn" | "reap-dead";
  idleMs: number;
  /** reap-dead:从派发/到点起算已超时的毫秒数。 */
  overMs?: number;
}

/** watchdog 扫描纯函数(2026-10-20 防死机制,直测锚):对注册表里 running 条目判两类死态——
 * ①idle>staleWarnMs 且未预警过→stale-warn(只发一次,主 agent 知情后可止损重派);
 * ②设了时间盒且超过 deadline+宽限仍 running→reap-dead(收割失灵=子代理已死,必须强制终态,
 *   否则条目永远 running、父会话永远等不到通知)。未设时间盒(deadlineAt 缺席)=不限时,只①不②
 *   (2026-10-21 用户口径)。终态条目不产生任何动作。 */
export function scanBgAgentsForWatchdog(now = Date.now()): SubagentWatchdogAction[] {
  const actions: SubagentWatchdogAction[] = [];
  for (const [agentId, en] of bgAgents) {
    if (en.status !== "running") continue;
    const idleMs = now - (en.lastEventAt ?? en.spawnedAt ?? now);
    const warnMs = en.staleWarnMs ?? 20 * 60_000;
    if (idleMs > warnMs && !en.staleNotified) actions.push({ agentId, kind: "stale-warn", idleMs });
    if (en.deadlineAt == null) continue; // 不限时条目:无时间盒即无「到点未终态」死态
    const hardAt = en.deadlineAt + SUBAGENT_WATCHDOG_GRACE_MS;
    if (now > hardAt) actions.push({ agentId, kind: "reap-dead", idleMs, overMs: now - hardAt });
  }
  return actions;
}

/** 执行一次 watchdog 扫描(生产入口=60s interval;测试注入假 journal/时钟经 scanBgAgentsForWatchdog 直测判定,
 * 本函数导出仅为单测驱动生产同一路径)。reap-dead 与 deadline 收割路径同语义但独立落账:cancel 尽力
 * (句柄可能已摘)、output.txt 补终态行、journal 落 subagent.result(reap=watchdog)+message.system 通知——
 * 主 agent 下一 step 即知死讯。 */
export function runSubagentWatchdog(journal: Journal): void {
  for (const act of scanBgAgentsForWatchdog()) {
    const en = bgAgents.get(act.agentId);
    if (!en || en.status !== "running") continue; // 扫描与执行间的竞态:终态跳过
    if (act.kind === "stale-warn") {
      en.staleNotified = true;
      const idleMin = Math.round(act.idleMs / 60_000);
      try {
        journal.append({ kind: "custom", sessionId: en.sessionId, payload: { type: "subagent.watchdog", watch: "stale-warn", agentId: act.agentId, idleMin } });
        journal.append({ kind: "message.system", sessionId: en.sessionId, payload: { text: `[子代理活性预警] ${act.agentId}${en.title ? `(${en.title})` : ""} 已 ${idleMin} 分钟无任何事件(疑似卡死)。它会继续跑${en.deadlineAt == null ? "(未设时间盒,不限时)" : "(deadline 到点仍会自动收割)"};你可 task_output(agentId="${act.agentId}")查看轨迹,确认无望可止损:放弃等待,用更明确的任务书重派${en.deadlineAt == null ? "(需要硬止损时可带 deadlineMin)" : ""}` } });
      } catch { /* journal 失败不影响条目标记(预警只发一次的语义保住) */ }
      continue;
    }
    // reap-dead:强制终态(收割失灵兜底)。cancel 尽力(外部后端进程可能还僵着,通知它退出;
    // 句柄缺席/抛错都不阻塞收割——注册表与 journal 才是死讯的权威落点)。
    try { en.cancel?.(); } catch { /* 取消失败不影响判死 */ }
    en.status = "failed";
    en.lastEventAt = Date.now();
    delete en.cancel;
    let trail = "";
    try {
      trail = readFileSync(en.outputFile, "utf-8").split("\n").filter((l) => l.startsWith("[progress]") || l.startsWith("[心跳]")).slice(-12).join("\n").trim();
    } catch { /* 轨迹读失败(文件未建/被清)不挡死讯落盘 */ }
    try {
      appendFileSync(en.outputFile, `[result ok=false] [watchdog 收割] 超过时间盒+${Math.round(SUBAGENT_WATCHDOG_GRACE_MS / 1000)}s 宽限仍无终态(子代理已死:内部收割失灵)。遗留轨迹:\n${trail || "(无进度输出)"}\n`, "utf-8");
    } catch { /* 输出文件写失败不影响收割 */ }
    try {
      journal.append({ kind: "custom", sessionId: en.sessionId, payload: { type: "subagent.watchdog", watch: "reap-dead", agentId: act.agentId, overMs: act.overMs } });
      journal.append({ kind: "subagent.result", sessionId: en.sessionId, payload: { agentId: act.agentId, event: { type: "result", ok: false, finalText: "[watchdog 收割] 子代理超过时间盒仍未返回终态,已判死并强制收尾" }, reap: { reason: "watchdog" } } });
      // 死讯无正文可投:pointerOnly=摘要+指针(与完成/失败同一条投递链,去重/合并口径统一)。
      deliverFinalNoticeWithAttention(journal, en.sessionId, {
        agentId: act.agentId,
        label: "死讯",
        summary: `超过时间盒仍未返回(deadline 收割失灵,watchdog 判死强制收尾)。该子代理不会再有结果——需要它的工作请用更明确的任务书重派(可缩 deadlineMin)`,
        pointerOnly: true,
      });
    } catch { /* journal 失败不影响终态(条目已翻 failed) */ }
  }
}

let subagentWatchdogTimer: ReturnType<typeof setInterval> | undefined;
/** 启动注册表巡检(幂等,60s 节律,unref 不挡进程退出)。wireAgentLoop 首次装配时调用;
 * journal 单例(app.ts 建)——进程内所有任务的子代理共用同一巡检。
 * 2026-10-21 会话 worker 模式下由 app.ts 直接调用(gateway 不走 wireAgentLoop,巡检对象=镜像注册表)。 */
export function ensureSubagentWatchdog(journal: Journal): void {
  if (subagentWatchdogTimer) return;
  subagentWatchdogTimer = setInterval(() => {
    try { runSubagentWatchdog(journal); } catch { /* 巡检异常不致命:下一轮再试 */ }
  }, 60_000);
  subagentWatchdogTimer.unref?.();
}

// ── 终态后异步收尾追踪(2026-10-21 会话 worker:退出前等 distill/memory/goal 收尾落定)──
const postTerminalPending = new Map<string, number>();
function trackPostTerminal(sessionId: string, p: Promise<unknown>): void {
  postTerminalPending.set(sessionId, (postTerminalPending.get(sessionId) ?? 0) + 1);
  void p.catch(() => {}).finally(() => {
    const n = (postTerminalPending.get(sessionId) ?? 1) - 1;
    if (n <= 0) postTerminalPending.delete(sessionId);
    else postTerminalPending.set(sessionId, n);
  });
}
/** 会话的终态后收尾(distill/记忆学习/goal 续跑判定)仍在飞的数量;0=可安全退出。 */
export function postTerminalInflight(sessionId: string): number {
  return postTerminalPending.get(sessionId) ?? 0;
}

// ── 任务终态档案(2026-10-20 用户口径:记录所有已实施任务/规划,compact 后可再注入快速恢复;
// planner 基于历史规划做新规划)──append-only .genie/task-archive.jsonl,每条:任务摘要+五阶段轨迹+板摘要。
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

/** 派发 tip(2026-10-21 自纪律卡移出:首次 spawn_subagent 时注入,不占 kickoff 纪律卡篇幅)。 */
export const DISPATCH_TIP = [
  "## 派发 tips(首次派子代理时注入)",
  "- 派发分档:小步文件修改自己上手更快;新模块/大型/多模块开发拆子任务派 spawn_subagent;选择等待用 wait:true 或 task_output(waitFor:\"result\")(挂起零 LLM);不要重复在跑子代理任务书里的内容",
  "- 任务书要写清楚动词、目标与验收标准(子代理只认任务书,模糊指令=模糊产出;2026-10-21 自 kickoff 纪律卡移入,契约规则同句锚定)",
  "- 上下文卫生:大输出勘察/实施派子代理,你只收结论+关键证据(文件:行号);要求子代理返回摘要,不贴大段原始输出",
].join("\n");

/**
 * 并行 tip(2026-11-04 T-D 轨迹实测落地)。
 *
 * 实测:近 3 天 25 会话 6,590 步,85.4% 的步只发 1 个调用(并行率 11.4%)——主轨仍是严格
 * 「一步一动作」串行形态,而每多一轮就多付一次全量 input(34% 的步 >400k input,吃掉 59% 成本)。
 * 根因三选一已核实:①提示词强度非零(SYSTEM_A/SYSTEM_LITE 各一条并行纪律),但它是**常量**,
 * 不随步态触发,长会话里注意力衰减后形同不存在;②工具面 `isConcurrencySafe` 只在 loop 分批发
 * 那侧生效,**不进 schema/description**,模型看不见「这个工具可以配着发」;③模型默认习惯是逐条发。
 * → 落地点选「确定性触发」:上一步只发了 1 个**可配对的只读探测工具**时,下一步注入一次提醒,
 *   把静态纪律变成「恰好在最该并行的时刻出现」的短提示。
 *
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
 * tips 即时增强引擎(2026-10-23 用户口径收敛:「每条 user message 跟一条匹配式 tips」多余且常
 * 错配——模型上下文已含会话语境,code_sense 内容必须是拉取式(call 工具才返回,不推送);经验/
 * devlog/历史档案同理不再按指令匹配推送(compact 后的恢复锚仍保留在压缩路径,那是补丢失的
 * 上下文,不是重复推送)。2026-10-21 版的 code-orient/history-align 两类匹配式注入已删。
 * 只留功能性 tip,各一次为限,由 loop 每 step 调用(ctx=上一步实际执行的工具名):
 *  - board-comments:白板新评论取走即消费(用户评论必须到达 agent——这是投递,不是增强);
 *  - dispatch:首次 spawn_subagent → 派发分档+上下文卫生(行为纪律,非匹配内容)。
 * GENIE_TIPS=off 全关。
 */
export function buildLoopTips(deps: {
  sessionId: string;
  /** SOP 阶段信号(2026-11 tips SOP 化):不传=无阶段信号,旧调用方零行为变化。 */
  getPhase?: () => string | undefined;
  /** 全链路变更信号(2026-11-06):plan/close 阶段卡换成盘点/残留审计卡。不传=零行为变化。 */
  changeScope?: () => string | undefined;
}): (ctx: {
  step: number; lastStepTools: string[];
  /** J1(token 轮):上一步工具调用涉及的文件夹具参数;旧 ctx 形态缺省=[]。 */
  lastStepFiles?: string[];
  /** J1:本 turn 累计工具错误数;旧 ctx 形态缺省=0。 */
  totalErrors?: number;
  /** J1:本 turn 累计 usage tokens(与 gate 对齐节奏用);旧 ctx 形态缺省=0。 */
  tokensSpent?: number;
  /** J1:注入闸(见 runtime inject-gate);旧 ctx 形态缺省=undefined(不过闸,行为同旧版)。 */
  gate?: InjectGate;
  /** J1:最近一条轨迹卡摘要行(loop 的 task.trajectory 旁路产物)。 */
  trajectory?: string;
  compacts?: number; phase?: string; lastStepError?: boolean;
}) => { text: string; keys: string[]; metrics: TipMetricSpec[] } | null {
  const fired = new Set<string>();
  // compact 后 tip 失忆自愈(2026-10-21):tips 是 ephemeral(不落 journal),autoCompact 之后
  // 模型看不见已注入的 tip。loop 每 step 带 compact.done 计数(ctx.compacts);计数增长=fired
  // 清空,各类 tip 允许重注入一次(严格「每次 compact 后至多一次」,不是无限重放)。
  let lastCompacts = 0;
  // 并行 tip 的**旧**节流状态(2026-11-04):仅在 ctx 未带 gate 的旧调用方路径使用
  // (J1 token 轮起正式路径由 InjectGate 单一机制限流,见下方注)。
  let lastParallelStep = -Infinity;
  let parallelInjects = 0;
  // ── J1(2026-11 token 轮)任务内步态状态:动态卡(dyn:*)的判定信号源。
  // fileEditStreak=每个文件「连续被改动」的步数(某步没编辑该文件即归零);verifyRounds=本任务
  // 已发生的验证轮次(跑 run_cmd/terminal/run_workflow 这类验证工具的步数);boardTouched=首次
  // 在 ctx.lastStepTools 里见到 board_upsert 即置 true(此后不再回退,语义=本任务落过板)。
  let fileEditStreak: Record<string, number> = {};
  let verifyRounds = 0;
  let lastStep = -1; // 同一步被重复调用时信号不重复累计
  let boardTouched = false;
  /** 最近一次「验证工具步」的 step(run_cmd/terminal/run_workflow 命中时刷新);从未验证过=undefined。
   *  dyn:verify-cadence 的判定信号(step-lastVerifyStep≥10)——「工作十步没验一次」。
   *  compact **不清**:它描述任务进度事实,不是注入额度(fired 才是额度)。 */
  let lastVerifyStep: number | undefined;
  /** 本任务已 spawn 过子代理(见过 spawn_subagent 即置 true,此后不回退)。dyn:delegate 的信号
   *  (spawnedSubagent===false 才提示「上下文重了该派活」);同样不随 compact 清空。 */
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
    // 白板新评论(2026-10-22):取走即消费——用户评论了就要有人接,不等 agent 自己想起 board_read。
    const pendBlock = renderPendingCommentsBlock(takePendingComments(deps.sessionId));
    if (pendBlock) { parts.push(pendBlock); pushKey("board-comments"); }
    // SOP 行式卡(2026-11 tips SOP 化,恰时一次为限;放 board-comments 之后、dispatch 之前):
    // phase 首见即注入对应阶段卡(SOP_TIPS 无 verify 卡——验收四步已由 task_phase 回执送达,
    // 重复=违 N3 教训);无新 phase 卡但上一步工具带错 → 排障卡兜底。key 形如 sop:understand
    // 直接进 fired,compact 后清空自动允许重注入一次(与 dispatch 同语义,不另造机制)。
    // ctx.phase 优先(loop 的 tipsPhase 通道);ctx 未带 phase 时兜底读 deps.getPhase
    // (装配方可只接 deps 不接 loop tipsPhase,两条通道等价)。未带 phase 字段且无 getPhase
    // 的旧 ctx 形态零注入——不是回到消息匹配式老路。
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
    // 并行提醒(2026-11-04,J1 2026-11 token 轮改造):上一步恰好 1 个调用且该调用是可配对的
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
      parts.push("<system-reminder>任务内轨迹(回看自己走到哪)\n" + trajLine
        + "\n需要更完整轨迹就 board_read/看面板轨迹条;方向偏了就回阶段锚。</system-reminder>");
      pushKey("task:trajectory");
      lastTrajBackfillKey = trajLine;
    }
    if (!parts.length) return null;
    // keys 供 `tip.injected` 留痕事件分类展示(面板显示「tips · dispatch」等)。
    const metricOf = (keys: string[]): TipMetricSpec[] => keys.map((k) => tipMetricOf(k));
    return {
      text: "<system-reminder>tips(做这类事之前的信息增强,直接利用,不要复述此段)\n" + parts.join("\n\n") + "</system-reminder>",
      keys,
      // M23 指导可度量(2026-11-07):每条已注入 tip 带上「触发条件/预期行为/指标口径」——
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
  ev: TrajectoryProgressEvent,
): void {
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
 * 网关启动僵尸清算(2026-10-15「僵尸 worker」根治,机制4):上一进程遗留的 spawn-无-result
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

/** 子代理模型名读数(step-060):provider 带 modelName(openai-compat/realtime 均暴露,getter 跟热更)
 * 则取之;自造 provider(测试/脚本)无该字段回落「主模型」——诚实降级,不猜名字。 */
function subagentModelNameOf(p: LlmProvider): string {
  const m = (p as { modelName?: unknown }).modelName ?? (p as { model?: unknown }).model;
  return typeof m === "string" && m !== "" ? m : "主模型";
}

// fixG(2026-10-18 先骨架后丰羽翼+开发类型分治):设计白板纪律段补流程骨架优先两阶段(≤9 节点/flow 内步骤/小任务豁免);
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
 * 运行环境段(2026-11-02 减步轮):16 题评测 215 次调用里 128 次是探索,其中 31 步(14%)纯在找
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
 * 精简档(2026-10-29 token 轮 P2):只保留安全与输出必需项,省掉流程仪式主体。
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
 * 按任务类别组系统纪律段(2026-10-23 用户口径:理解阶段定类,提示词按类出;类别可被
 * task_phase(taskClass=...) 更正,更正后下一轮次起按新类)。
 * coding=全文;qa=免阶段/白板/验收仪式,保留派发+code_sense 用法(调研查代码高频);
 * office=只留通用段。两条类别注记都带更正路径——初判错类时模型自己能纠正。
 */
export function systemForTaskClass(cls: TaskClass, opts: { lite?: boolean } = {}): string {
  // 精简档(2026-10-29 token 轮 P2):coding 短任务书走 SYSTEM_LITE;qa/office 分支行为不变。
  if (cls === "coding" && opts.lite) return SYSTEM_LITE;
  if (cls === "qa") {
    return SYSTEM_A + SYSTEM_DISPATCH + SYSTEM_TAIL + SYSTEM_SENSE
      + "\n- **任务类别(qa 问答/调研)**:本任务免五阶段/白板/plan-gate 仪式——直接调查并输出结论(结论先行,出处带 file:line/链接;只读,不改代码不落板);若理解后发现需要改代码,task_phase(taskClass=\"coding\") 更正,全套编码纪律(阶段/板/影响面/验收)即刻生效。";
  }
  if (cls === "office") {
    return SYSTEM_A + SYSTEM_DISPATCH + SYSTEM_TAIL
      + "\n- **任务类别(office 办公/产出)**:本任务免五阶段;但动笔前要先落**作业思路板**(board_upsert boardType=\"composition\":主题/受众/表达结构/几章/每章主题/章间关系与顺序)或传 exemptReason 留痕豁免(确无表达结构时)——plan-gate 按此硬闸放行;先明确产出要求(格式/篇幅/受众,不清楚先问),直接制作;交付前自查内容完整/格式正确/无占位残留;若过程涉及改代码,task_phase(taskClass=\"coding\") 更正后按编码纪律执行。"
      + "\n- **研究/调研类引用账本(必做)**:每个检索来源先 web_fetch 抓到正文,再 cite_source(url+逐字出现在抓取正文里的 quote) 换编号;正文编号只用它返回的 [n](不许自己排序/改号);无检索证据的推断标 [unverified];收尾会按登记表校验,未登记/越界编号会被点名。"
      + "\n- **产出方法论(动笔前必读)**:按产物先 skill_view 对应技能——任何产出都先读 builtin/office-writing(内核:开工四问、论点四段、禁提纲交付、去 agent 腔句式清单、能画图就别写表格);PPT 加读 builtin/office-pptx 与 builtin/ppt-master(产线:判型/四步门/版式容量表/能力边界),Word 加读 builtin/office-docx,Excel 加读 builtin/office-xlsx,周报/复盘/方案/调研报告加读 builtin/office-report。**要真正落一份 .pptx 时派子代理**:spawn_subagent(agentType=\"ppt-master\")(它带 board_export_pptx 质量门,交付前逐条过门);自己写文档/表格不必派。四条硬线:①**开工四问先答完**——面向谁报告(谁看/要拿它做什么决定)、汇报主题是什么(一句疑问句)、要突出的重点是哪 1~2 条且这次不讲哪 2~3 条、每个论点的论据与分析从哪来;答不上先问人或去查,不许边写边想;②**每个论点四段齐全**——主张 + 可溯源论据(数字/来源/口径)+ 分析(因果或排除推理,不许复述论据)+ 结论/所以呢,并主动写反证(什么条件下这条不成立);③正文按人话写,禁开场报幕、收尾谢幕、过程自述与空心副词;④流程/结构/时序/趋势一律画图(Markdown 用 mermaid 代码块,PPT 用原生形状与图表),表格只装结构化数据。";
  }
  return SYSTEM;
}

/** ask_user 工具(2026-10-19 许愿式编程):需求有取舍时向用户发问并阻塞等待。
 * 有界:router 侧 10 分钟超时;离线/超时→返回「未答复」文本,agent 按最合理推断继续(不卡死)。
 * 会话上下文:只允许主 agent 使用(子代理无面板入口,不注册)。 */
export function askUserTool(sessionId: string, askUser: { ask: (sid: string, p: { question: string; options?: string[]; context?: string }) => Promise<string | null> }): Tool {
  return {
    name: "ask_user",
    description:
      "向用户发问并等待答复(许愿式编程:需求有取舍、范围可能膨胀、或你推断的扩展超出字面举例时,先问再做)。" +
      "question=一句话问题;options=2~4 个互斥选项(每个都能直接执行);context=你的推断依据与影响范围(用户据此判断)。" +
      "问题除面板问答条外,会同时进 Super Agent 指挥台「待处理」(任一通道先答即生效)。" +
      "返回:用户选择的原文;若用户离线/超时未答,返回「(用户未答复)」——此时按你推断的最合理范围继续,并在汇报开头说明你按哪个选项执行。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "一句话问题(要能一眼看懂在问什么)" },
        options: { type: "array", description: "2~4 个互斥选项,每个都是可直接执行的方案(如「按完整推断范围做」「只做字面举例」「先做核心再评估」)", items: { type: "string" } },
        context: { type: "string", description: "为什么问:你的推断依据/潜在需求清单/影响范围(≤1200 字)" },
      },
      required: ["question"],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    async execute(args: unknown) {
      const a = (args || {}) as { question?: string; options?: string[]; context?: string };
      if (!a.question) return "ask_user 需要 question";
      // M183 注意力预算:一次只问一个具体问题(结构化),外发消息必须有用途(decision);
      // 不通过即回工具错误(稳定码+可操作提示),绝不落到面板消耗用户注意力。
      const gate = guardAskUserPayload({ question: a.question, options: a.options, context: a.context });
      if (!gate.ok) return gate.message;
      try {
        const answer = await askUser.ask(sessionId, { question: gate.question, options: gate.options, context: gate.context });
        if (answer === null) return "(用户未答复——按你推断的最合理范围继续,并在汇报开头说明按哪个选项执行)";
        return "用户答复:" + answer;
      } catch (err) {
        return "ask_user 失败(" + String(err).slice(0, 120) + ")——按你推断的最合理范围继续,汇报时说明。";
      }
    },
  };
}

/** M43 todo 严格整表纪律:条目状态枚举 + 内容上限。 */
const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
type TodoStatus = (typeof TODO_STATUSES)[number];
const TODO_CONTENT_MAX = 120;
const TODO_ERROR_MAX = 600;

/** todo_write 工具(step-030,ZCode TodoWrite 对应物):多步任务的工作计划落 journal,
 * session.status 投影据此驱动面板进度小窗(todo n/m)。
 * M43 严格校验:空 items/未知键/空或超长 content/未知 status/重复 content 全部显式失败且不落
 * journal(不再静默过滤/归 pending);多个 in_progress 默认拒绝(allowParallelInProgress 放行)。 */
export function todoTool(journal: Journal, sessionId: string, opts?: { allowParallelInProgress?: boolean }): Tool {
  const fail = (msg: string): string => `[todo_write] ${msg}`.slice(0, TODO_ERROR_MAX);
  return {
    name: "todo_write",
    description: "写入/更新当前任务的工作计划。多步任务开工先建计划,每完成一步立刻更新该步状态",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "计划条目(全量覆盖)",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "这一步要做什么(短句)" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "pending 未开始/in_progress 进行中/completed 已完成" },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["items"],
    },
    isConcurrencySafe: () => true,
    async execute(args: unknown) {
      const raw = (args as { items?: unknown } | null | undefined)?.items;
      if (!Array.isArray(raw) || raw.length === 0) {
        return fail("items 不能为空:须为非空数组(整表替换语义),本次未更新计划");
      }
      const clean: { content: string; status: TodoStatus }[] = [];
      const seen = new Map<string, number>();
      for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          return fail(`items[${i}] 必须是 object(content/status)`);
        }
        const rec = item as Record<string, unknown>;
        const unknownKey = Object.keys(rec).find((k) => k !== "content" && k !== "status");
        if (unknownKey) {
          return fail(`items[${i}] 含未知键 "${unknownKey}":只允许 content/status`);
        }
        const content = rec.content;
        if (typeof content !== "string") {
          return fail(`items[${i}].content 必须是字符串(收到 ${typeof content})`);
        }
        const text = content.trim();
        if (text.length === 0) return fail(`items[${i}].content 不能为空`);
        if (text.length > TODO_CONTENT_MAX) {
          return fail(`items[${i}].content 超长(${text.length} 字 > ${TODO_CONTENT_MAX}):"${text.slice(0, 30)}…"`);
        }
        const status = rec.status;
        if (typeof status !== "string" || !(TODO_STATUSES as readonly string[]).includes(status)) {
          return fail(`items[${i}].status 非法("${String(status)}"):只允许 pending|in_progress|completed`);
        }
        const prev = seen.get(text);
        if (prev !== undefined) {
          return fail(`content 重复:items[${prev}] 与 items[${i}] 同为 "${text}"`);
        }
        seen.set(text, i);
        clean.push({ content: text, status: status as TodoStatus });
      }
      const ing = clean.filter((i) => i.status === "in_progress").length;
      if (ing > 1 && opts?.allowParallelInProgress !== true) {
        return fail(`有 ${ing} 项 in_progress:多个进行中会让进度失真;串行推进或配置 agent.todoAllowParallelInProgress=true`);
      }
      journal.append({ kind: "todo.updated", sessionId, payload: { items: clean } });
      const done = clean.filter((i) => i.status === "completed").length;
      return `已记录计划 ${clean.length} 项(${done} 完成/${ing} 进行中)`;
    },
  };
}

/** board_upsert 工具(designs/22,step-057;step-137 代码级落目标):语义流程白板——代码改动类任务「先画后改」。
 * agent 落 BoardDoc(模块节点+干什么+改动类型+函数内语义流程,节点可挂 code_sense 查到的符号);
 * 全量覆盖语义(同 todo_write),rev 自增;落盘 .genie/boards/<sid>/<taskId>.json +
 * journal board.update + bus 广播。**fail-soft:任何失败只回话术,绝不阻塞任务**。
 * 窄 schema 是刻意的:summary/flow 强制非空,防白板写成任务复述。
 *
 * step-137 三动作(同一工具、同一板文件,免多工具漂移):
 * - action=upsert(缺省):落整板。P0 节点必须带 accept(否则拒收录板,见 P0 落板门);
 *   status=done 还要求 P0 全部有 ok=true 证据(收口门)。
 * - action=evidence:按 nodeId 追加 evidence(at 服务端补),回执带最新覆盖率;该节点验收全绿时顺带 done=true。
 * - action=audit:只读收口核对——返回 P0 清单+逐条证据状态+覆盖率(不写盘)。all=true 扫本会话全部板。
 *
 * q4 子写者独立板(2026-10-25 架构修复):`opts.partition=true`(planner 子代理来源)+ 有 scope 时,
 * 本写者的板 id 变成 `<taskId>-<scope>`,即落**独立板文件** `.genie/boards/<sid>/<taskId>-<scope>.json`,
 * 不再并进调用方(主 agent)的任务板。缺陷现场:主 agent 板本只有 4 个 P0 节点,两个 planner 以
 * scope=bp/kb 并入后 `action=audit` 报 4/24(17%)——收口审计跨任务计分,主 agent 永远无法宣称完成。
 * 主 agent(构造时不带 partition/scope)路径逐字不变,仍是 `<taskId>.json`。 */
/** 规划质量结构化字段(B2 P2 遗留,2026-11-06):面板任务结算直接读,不用重放板。
 * 口径:contentNodes=非 ph- 前缀且过 isContentNode 的节点(与 plan-gate 放行判据同源);
 * anchorDensity=带 targets 或 symbolRef 的内容节点占比(0~1,四舍五入 3 位);p0Rate=P0 accept 证据通过率。 */
export function planQualityOf(doc: { boardType?: string | null; nodes: readonly unknown[] }): {
  boardType: string | null; nodes: number; contentNodes: number; p0: { passed: number; total: number; rate: number }; anchorDensity: number;
} {
  const design = doc.nodes.filter((n) => !String((n as { id?: unknown }).id ?? "").startsWith("ph-"));
  const content = design.filter((n) => isContentNode(n as never));
  const anchored = content.filter((n) => {
    const x = n as { targets?: unknown; symbolRef?: unknown };
    return (Array.isArray(x.targets) && x.targets.length > 0) || (x.symbolRef && typeof x.symbolRef === "object");
  });
  const cov = computeP0Coverage({ nodes: doc.nodes } as never);
  return {
    boardType: doc.boardType ?? null,
    nodes: design.length,
    contentNodes: content.length,
    p0: { passed: cov.passed, total: cov.total, rate: cov.total > 0 ? Math.round((cov.passed / cov.total) * 1000) / 1000 : 1 },
    anchorDensity: content.length > 0 ? Math.round((anchored.length / content.length) * 1000) / 1000 : 0,
  };
}

/** 三位小数舍入(板质量遥测 2026-11-05):率字段统一口径,避免 0.3333333 漂进 journal。 */
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** bq3(2026-11-05 遥测闭环):骨架采纳率纯函数——board.skeleton 事件的 landed 并集(分母)
 * vs 终板 sk- 前缀节点存活数(分子)。分母 0(本会话没落过骨架)返回 null=整段不落。 */
export function computeSkeletonAdoption(
  finNodes: readonly unknown[],
  // 2026-11-05:journal 事件是 JournalEvent<unknown>(payload 宽类型),收 unknown 再结构断言,防逆变报错。
  skEvents: readonly unknown[],
): { generated: number; survived: number; adoptionRate: number } | null {
  const landedIds = new Set<string>();
  for (const ev of skEvents) {
    const e = ev as { payload?: { landed?: unknown } };
    const l = e.payload?.landed;
    if (Array.isArray(l)) for (const id of l) landedIds.add(String(id));
  }
  if (landedIds.size === 0) return null;
  const finSk = finNodes.filter((n) => String((n as { id?: unknown }).id ?? "").startsWith("sk-"));
  const survived = finSk.filter((n) => landedIds.has(String((n as { id?: unknown }).id ?? ""))).length;
  return { generated: landedIds.size, survived, adoptionRate: round3(survived / landedIds.size) };
}

export function boardUpsertTool(
  journal: Journal, sessionId: string, taskId: string, taskRoot: string, storeRoot?: string, scope?: string,
  /** q4:本工具属于 planner 子代理来源(其 scope 写入落独立板)。缺省 false=单写者旧行为。 */
  opts: {
    partition?: boolean;
    /** 豁免留痕回调(2026-11-05):agent 传 exemptReason 声明「本任务确实没有开发内容/表达结构」时
     *  调用(由调用方把 boardExemptThisTask 置真 → plan-gate 放行)。只留痕,不写板。 */
    onExempt?: (reason: string, taskClass: string) => void;
    /** 当前任务类别(只进 board.exempt 留痕,供遥测归因)。 */
    taskClass?: () => string;
  } = {},
): Tool {
  return {
    name: "board_upsert",
    description: [
      "设计白板:画**现状逻辑**——节点=现有代码里真实存在的流程步骤(start/步骤/decision/loop/end),边=控制流,步骤标 targets+change(要改的标 modify+before,纯读标 keep);计划留 step.md,待办动作不画成节点。",
      "action=upsert 整板|evidence 回填|audit 查 P0 覆盖|prune 清残留。",
      "P0 节点必须带非空 accept(cmd),否则整板拒收;P0 全绿前 status 不得 done。",
      "细则/硬规则先 tool_view(\"board_upsert\");画法 skill_view(category=\"board\", name=\"<type>/draw\"),如 ui/draw。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["upsert", "evidence", "audit", "prune", "skeleton"], description: "缺省 upsert=落整板;evidence=回填证据;audit=只读核对;prune=清零残留节点;skeleton=从 code-sense 索引快照自动生成现状层 keep 节点" },
        format: { type: "string", enum: ["text", "json"] },
        nodeId: { type: "string", description: "evidence 的目标节点 id" },
        evidenceByNode: {
          type: "object",
          description: "evidence 批量回填:键=节点 id,值=证据数组",
          additionalProperties: {
            type: "array",
            items: {
              type: "object",
              properties: { cmd: { type: "string" }, ok: { type: "boolean" }, output: { type: "string" }, note: { type: "string" } },
              required: ["cmd", "ok"],
            },
          },
        },
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              cmd: { type: "string" },
              ok: { type: "boolean" },
              output: { type: "string" },
              note: { type: "string" },
            },
            required: ["cmd", "ok"],
          },
        },
        all: { type: "boolean" },
        nodeIds: { type: "array", items: { type: "string" } },
        dryRun: { type: "boolean" },
        confirm: { type: "boolean" },
        targetTaskId: { type: "string" },
        scope: { type: "string" },
        template: { type: "string", enum: ["smoke", "preflight"] },
        title: { type: "string" },
        status: { type: "string", enum: ["draft", "implementing", "done"] },
        nodes: {
          type: "array",
          description: "一次提交整块板的全部节点(preferred over 分多轮 upsert 补节点——upsert 无局部 patch 语义,分轮补会让先前节点与本次意图漂移并存;同 id 重提交即更新,换 id 会留残留)",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "节点 id(短,如 n1/n2,edges 引用它)" },
              kind: { type: "string", enum: ["module", "function", "decision", "note", "llm", "tool", "io", "start", "end", "http", "template", "aggregate", "loop", "retrieval", "classifier", "agent", "page", "section", "component", "nav"], description: "**只能取本枚举值之一,枚举外的值整板拒收**" },
              label: { type: "string", description: `节点主标题:**≤${LABEL_MAX_CHARS} 字**(超长整板拒收)` },
              summary: { type: "string" },
              group: { type: "string" },
              before: { type: "string" },
              change: { type: "string", enum: ["add", "modify", "delete", "keep"] },
              done: { type: "boolean" },
              phase: { type: "string", enum: ["P0", "P1", "P2"] },
              targets: { type: "array", items: { type: "string" } },
              accept: {
                type: "array",
                description: "可执行验收契约(P0 必填):每条 cmd 怎么跑、期望什么",
                items: {
                  type: "object",
                  properties: {
                    cmd: { type: "string" },
                    expect: { type: "string" },
                    type: { type: "string", enum: ["command", "browser", "manual", "negative"] },
                    note: { type: "string" },
                  },
                  required: ["cmd"],
                },
              },
              evidence: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    cmd: { type: "string" }, ok: { type: "boolean" },
                    at: { type: "number" }, output: { type: "string" }, note: { type: "string" },
                  },
                  required: ["cmd", "ok"],
                },
              },
              symbolRef: {
                type: "object",
                properties: {
                  name: { type: "string" }, file: { type: "string" },
                  line: { type: "number" }, anchor: { type: "string" },
                },
              },
              flow: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["step", "branch", "loop"] },
                    text: { type: "string" }, cond: { type: "string" }, over: { type: "string" },
                    then: { type: "array", items: { type: "object" } }, else: { type: "array", items: { type: "object" } },
                    body: { type: "array", items: { type: "object" } },
                  },
                  required: ["type"],
                },
              },
            },
            required: ["id", "label", "summary"],
          },
        },
        edges: {
          type: "array",
          description: "与 nodes 同一次提交(忘写边=图不成立;分轮补边易留悬空)",
          items: {
            type: "object",
            properties: {
              from: { type: "string" }, to: { type: "string" },
              kind: { type: "string", enum: ["call", "data", "verify", "nav", "contains"] },
              label: { type: "string" },
            },
            required: ["from", "to"],
          },
        },
        planned_files: { type: "array", items: { type: "string" } },
        /** 紧凑 DSL 主路径(2026-11-03):一行一语句,比逐节点全字段 JSON 省 60%+ 输出。 */
        dsl: {
          type: "string",
          description: "紧凑白板 DSL(与 nodes 同给:dsl 为准,JSON 只补 flow/evidence):\n"
            + "%% board v1 / title: X / type: code / scale: M / kind: design\n"
            + "lane <泳道名> : <id> <id>\n"
            + "node <id> <kind> <change> [P0|P1|P2] \"<label>\" | <summary> [| <before>]\n"
            + "  accept: [command|browser|manual|negative] <cmd> => <expect> [| <note>]\n"
            + "  flow: step <t> | branch <c>?<a>:<b> | loop over <x>|body <t>\n"
            + "  targets: <file1>, <file2>\n"
            + "  sym: <name>@<file>:<line>\n"
            + "edge <from> -> <to> : <label>   (->call ->>data ~>verify =>nav =>>contains)",
        },
        /** 豁免留痕(2026-11-05,可选;不新增工具、只复用本工具入参):声明「本任务确实没有开发
         *  内容/表达结构」时不写板,只落 journal board.exempt → plan-gate 放行。不与 nodes/dsl 同给。 */
        exemptReason: { type: "string", description: "确无开发内容/表达结构时的豁免理由(20~200 字):为什么本任务没有可画的内容。只传它=不写板,仅 journal 留痕豁免 plan-gate" },
        docKind: { type: "string", enum: ["design", "page"] },
        boardType: { type: "string", enum: ["code", "test", "docs", "ui", "ui-func", "fault", "refactor", "perf", "data", "contract", "deploy", "research", "orchestration", "matrix", "composition"] },
        scale: { type: "string", enum: ["S", "M", "L"] },
        docGenre: { type: "string" },
        symbols: { type: "array", items: { type: "string" }, description: "action=skeleton 用:符号名清单(≤20,来自 code_sense 查询),自动生成现状层 keep 节点" },
        files: { type: "array", items: { type: "string" }, description: "action=skeleton 用(可选):并入这些文件的符号(byFile 命中,与 symbols 候选并集)" },
        maxNodes: { type: "number", description: "action=skeleton 用(可选):节点上限,缺省 40、钳 ≤40(板节点上限 60,给变更层留位)" },
      },
      // required 留空:evidence/audit 动作不需要 title/nodes;upsert 的必填由 execute 前置校验兜住(回执话术点名缺项)。
      required: [],
    },
    // 六期纪律口径(工具描述内联):edges 要来自 code_sense 查到的真实调用关系——节点间连线先查符号的
    // callers/callees,按实际调用方向写 from(调用方)->to(被调方);纯新增模块与既有代码的连接也写真实方向。
    isConcurrencySafe: () => false,
    async execute(args: unknown) {
      try {
        const a = args as {
          action?: "upsert" | "evidence" | "audit" | "prune" | "skeleton";
          format?: "text" | "json";
          nodeId?: string;
          nodeIds?: unknown[];
          dryRun?: boolean;
          confirm?: boolean;
          targetTaskId?: string;
          evidence?: unknown[];
          evidenceByNode?: Record<string, unknown>;
          all?: boolean;
          scope?: string;
          template?: "smoke" | "preflight";
          title?: string; status?: "draft" | "implementing" | "done";
          nodes?: unknown[]; edges?: unknown[]; planned_files?: string[];
          /** 紧凑白板 DSL(与 nodes/edges 二选一;见 board-dsl.ts)。 */
          dsl?: string;
          exemptReason?: string;
          docKind?: "design" | "page";
          boardType?: "code" | "test" | "docs" | "ui" | "ui-func" | "fault" | "refactor" | "perf" | "data" | "contract" | "deploy" | "research" | "orchestration" | "matrix";
          scale?: "S" | "M" | "L";
          docGenre?: string;
          /** action=skeleton 用:符号名清单(≤20,来自 code_sense 查询)。 */
          symbols?: string[];
          /** action=skeleton 用:并入这些文件的符号(byFile 命中)。 */
          files?: string[];
          /** action=skeleton 用:节点上限(缺省 40,钳 ≤40)。 */
          maxNodes?: number;
        };
        const { loadBoardAsync: loadBoardA, saveBoardAsync, listBoardsExAsync, mergeBoardNodes, withBoardLock } = await import("./board-store.js");
        const { computeP0Coverage, markDoneFromEvidence, renderP0Status, validateChangeContract, validateCallEdges, validateBoardTypeConformance } = await import("./board-accept.js");
        const root = storeRoot ?? repoRoot();
        const action = a.action ?? "upsert";
        // 豁免留痕(2026-11-05 用户拍板「office 走硬闸 + 豁免留痕」):action 未指定或 upsert 且**只**带
        // exemptReason(无 nodes/dsl)= 不写板,只落 journal board.exempt 并回执 exempted。plan-gate 据此放行。
        // 校验:trim 后 <20 字拒(空话不算理由);>200 字截断(留痕够用,不撑爆 journal)。
        if ((a.action === undefined || a.action === "upsert")
          && typeof a.exemptReason === "string" && a.exemptReason.trim() !== ""
          && !Array.isArray(a.nodes) && !(typeof a.dsl === "string" && a.dsl.trim() !== "")) {
          const reasonTrim = a.exemptReason.trim();
          if (reasonTrim.length < 20) {
            return JSON.stringify({ status: "rejected", reason: "豁免理由过短(<20 字),请写明『为什么本任务没有开发内容/表达结构』" });
          }
          const reason = reasonTrim.slice(0, 200);
          const tc = opts.taskClass?.() ?? "unknown";
          try {
            journal.append({
              kind: "custom", sessionId,
              payload: { type: "board.exempt", taskId, taskClass: tc, reason, tool: "board_upsert", truncated: reasonTrim.length > 200 },
            });
          } catch { /* 留痕失败不影响豁免(闸门侧仍按未豁免处理) */ }
          try { opts.onExempt?.(reason, tc); } catch { /* 回调失败不影响回执 */ }
          return JSON.stringify({ status: "exempted", reason });
        }
        // q1 写者作用域:构造期绑定的 scope(并行 planner 各带唯一前缀)与入参 scope 取其一;
        // 入参优先(主 agent 想临时分区也可显式给),两者都没有=主 agent 常规单写者行为(完全不变)。
        // 前缀消毒:只留 [a-zA-Z0-9-],塌掉多余连字符——它会进节点 id(id 参与边引用与合并键)。
        const scopeRaw = (typeof a.scope === "string" && a.scope.trim() !== "" ? a.scope : scope) ?? "";
        const scopeId = scopeRaw.trim().replace(/[^a-zA-Z0-9-]/g, "").replace(/^-+|-+$/g, "");
        // q4 子写者独立板:planner 子代理来源(partition)+ 有 scope → 本写者的板 id = `<taskId>-<scope>`,
        // 即落独立板文件 `<taskId>-<scope>.json`。缺陷现场(2026-10-25):主 agent 板本只有 4 个 P0 节点,
        // 两个 planner 以 scope=bp/kb 并进同一块板后 audit 报 4/24(17%)——收口审计跨任务计分。
        // 主 agent(工具构造时不带 partition、也无 scope)boardId 恒等于 taskId,行为逐字不变。
        const boardId = opts.partition && scopeId !== "" ? `${taskId}-${scopeId}` : taskId;
        // q4 配套(2026-10-25):planner 落独立板后,实施者(主 agent)必须能把验收证据回到**planner 的板**
        // 上,否则「planner 画板 + 主 agent 补 evidence」只能靠把板复制一份,planner 的原始契约被架空。
        // targetTaskId 只允许本任务板/本任务分区板;planner 只允许自己的板(不能反写别人的分区)。
        const explicitTargetTid = typeof a.targetTaskId === "string" ? a.targetTaskId.trim() : "";
        const targetBoardId = explicitTargetTid || boardId;
        // 主 agent 可显式指向**本会话已存在的板**(含上一任务的 planner 独立板——新一轮任务继续验收时
        // 新 taskId 与旧板前缀不同,不能只按 `<本任务>-*` 判);planner 只允许自己的板,防反写别人契约。
        const targetExists = explicitTargetTid !== ""
          && (await listBoardsExAsync(root, sessionId)).items.some((i) => i.taskId === explicitTargetTid);
        const targetCrossAllowed = explicitTargetTid === ""
          || (opts.partition
            ? explicitTargetTid === boardId
            : explicitTargetTid === boardId || explicitTargetTid.startsWith(`${taskId}-`) || targetExists);
        const targetError = explicitTargetTid !== "" && !targetCrossAllowed
          ? `targetTaskId「${explicitTargetTid}」越界:只允许本会话已存在的板或本任务板(planner 只允许自己的板 ${boardId})`
          : "";


        // ---- action=skeleton:现状层骨架自动预填(2026-10-29)----
        // 从 code-sense 索引快照生成 keep 节点+真实 call 边;锚经三态核验(broken 剔除、moved 刷行号
        // 后复验、targets missing/outside 剔项);planner 之后在底版上补变更层(add/modify 带 before)。
        if (action === "skeleton") {
          if (targetError) return targetError;
          const { buildSkeleton, normalizeSkeletonRequest } = await import("./board-skeleton.js");
          const { resolveBoardLinksAsync, resolveTargetPathsAsync } = await import("./board-store.js");
          const normReq = normalizeSkeletonRequest({
            symbols: (Array.isArray(a.symbols) ? a.symbols : []).filter((s): s is string => typeof s === "string"),
            files: (Array.isArray(a.files) ? a.files : []).filter((f): f is string => typeof f === "string"),
            maxNodes: a.maxNodes,
          });
          if (!normReq.ok) return `action=skeleton 被拒:${normReq.reason}`;
          const { loadIndex } = await import("@lampgenie/code-sense");
          const index = loadIndex(taskRoot);
          if (!index) {
            return "索引缺失:先建索引(项目根 code_sense / 等预热),本次未落板。";
          }
          const sk = buildSkeleton(index, { symbols: normReq.symbols, files: normReq.files, maxNodes: normReq.maxNodes });
          const indexHas = (name: string): boolean | null => (index.byName[name]?.length ?? 0) > 0;
          type SkNode = typeof sk.nodes[number] & { symbolRef?: { name: string; file?: string; line?: number } };
          // 锚三态核验(两轮):broken→剔除;moved→刷行号后复验,仍非 linked→剔除。
          const dropped = { broken: [] as string[], movedUnresolved: [] as string[], targetMissing: [] as string[], targetOutside: [] as string[] };
          let nodesCur: SkNode[] = sk.nodes;
          for (let round = 0; round < 2; round++) {
            if (nodesCur.length === 0) break;
            const docProbe = { nodes: nodesCur as never, edges: [], root: taskRoot } as never;
            const links = await resolveBoardLinksAsync(taskRoot, docProbe, indexHas);
            const lineById = new Map(links.map((l) => [l.nodeId, l.line]));
            const stateById = new Map(links.map((l) => [l.nodeId, l.state]));
            let hadMoved = false;
            nodesCur = nodesCur.filter((n) => {
              const st = stateById.get(n.id);
              if (st === "broken") { dropped.broken.push(n.id); return false; }
              if (st === "moved") {
                hadMoved = true;
                const fresh = lineById.get(n.id);
                if (round === 1 || fresh === undefined) { dropped.movedUnresolved.push(n.id); return false; }
                n.symbolRef = { ...n.symbolRef!, line: fresh }; // 刷新行号,下一轮复验
                return true;
              }
              return true;
            });
            if (!hadMoved) break; // 全 linked/broken:收敛,不做第二轮
          }
          // targets 核验:missing/outside 剔除该 target;剔完全空=剔节点
          if (nodesCur.length > 0) {
            const docProbe = { nodes: nodesCur as never, edges: [], root: taskRoot } as never;
            const byId = new Map(nodesCur.map((n) => [n.id, n]));
            for (const t of await resolveTargetPathsAsync(taskRoot, docProbe)) {
              const n = byId.get(t.nodeId);
              if (!n) continue;
              if (t.state === "outside") dropped.targetOutside.push(`${t.nodeId}:${t.target}`);
              else dropped.targetMissing.push(`${t.nodeId}:${t.target}`);
              n.targets = (n.targets ?? []).filter((x) => x !== t.target);
            }
            nodesCur = nodesCur.filter((n) => (n.targets?.length ?? 0) > 0);
          }
          if (nodesCur.length === 0) {
            // bq2(2026-11-05 遥测闭环):rejected 也落账——骨架生成了多少/为何全剔,基线表要有这一行。
            try {
              journal.append({
                kind: "board.skeleton", sessionId,
                payload: {
                  taskId, boardId, status: "rejected",
                  generated: sk.nodes.length, landed: [], landedCount: 0,
                  dropped: {
                    broken: dropped.broken.length, movedUnresolved: dropped.movedUnresolved.length,
                    targetMissing: dropped.targetMissing.length, targetOutside: dropped.targetOutside.length,
                    nodesDropped: sk.nodes.length,
                  },
                  truncated: sk.truncated.length, unresolved: sk.unresolved.length, elidedRate: 1,
                },
              });
            } catch { /* 遥测失败不影响回执 */ }
            return JSON.stringify({
              status: "rejected", boardId, nodes: 0, edges: 0,
              dropped, truncated: sk.truncated, unresolved: sk.unresolved,
              reason: "核验后有效节点为 0(锚全断/全漂移/targets 全无效),本次未落板",
            });
          }
          const keptIds = new Set(nodesCur.map((n) => n.id));
          const edgesFinal = sk.edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to));
          const sr = await withBoardLock(root, sessionId, boardId, async () => {
            const existing = await loadBoardA(root, sessionId, boardId);
            const merged = mergeBoardNodes(existing?.nodes, nodesCur, { maxNodes: 60 });
            // 边:既有边+骨架边同向去重合并;被剔节点牵连的边由 nodeIds 完整性过滤
            const seen = new Set<string>();
            const edgesAll = [
              ...(existing?.edges ?? []).map((e) => ({ from: e.from, to: e.to, kind: e.kind ?? "call", ...(e.label ? { label: e.label } : {}) })),
              ...edgesFinal,
            ].filter((e) => {
              const k = `${e.from}->${e.to}`;
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            });
            const nodeIds = new Set(merged.nodes.map((n) => (n as { id?: unknown }).id));
            const edgesKept = edgesAll.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
            const saved = await saveBoardAsync(root, {
              version: 1, taskId: boardId, sessionId,
              title: a.title ?? existing?.title ?? `现状骨架 ${taskId}`,
              status: existing?.status ?? "draft",
              docKind: existing?.docKind,
              ...(existing?.boardType ? { boardType: existing.boardType } : {}),
              ...(existing?.scale ? { scale: existing.scale } : {}),
              rev: (existing?.rev ?? 0) + 1,
              root: taskRoot,
              nodes: merged.nodes, edges: edgesKept,
              planned_files: existing?.planned_files ?? [],
              ...(existing?.actual_files ? { actual_files: existing.actual_files } : {}),
              ...(existing?.humanEdits ? { humanEdits: existing.humanEdits } : {}),
              updatedAt: 0,
            }, { gateExemptNodeIds: merged.keptIds, agentWrite: true, labelExemptNodeIds: merged.nodes.map((n) => (n as { id?: unknown }).id as string) });
            if (!saved.ok) return saved.reason + "(骨架未落盘;既有板未受影响)";
            return { saved };
          });
          if (typeof sr === "string") return sr;
          journal.append({
            kind: "board.update", sessionId,
            payload: { taskId: boardId, path: sr.saved.path, rev: sr.saved.doc.rev, title: sr.saved.doc.title, nodeCount: sr.saved.doc.nodes.length, edgeCount: sr.saved.doc.edges.length, status: sr.saved.doc.status, docKind: sr.saved.doc.docKind ?? "design", skeleton: nodesCur.length },
          });
          // bq2(2026-11-05 遥测闭环):骨架 ok 也落账——landed/剔除四桶/采纳基线(结算面
          // task.quality 的 skeleton 维度按 landed 对账 finBoard 的 sk- 节点存活率)。
          try {
            journal.append({
              kind: "board.skeleton", sessionId,
              payload: {
                taskId, boardId, status: "ok",
                generated: sk.nodes.length, landed: nodesCur.map((n) => n.id), landedCount: nodesCur.length,
                dropped: {
                  broken: dropped.broken.length, movedUnresolved: dropped.movedUnresolved.length,
                  targetMissing: dropped.targetMissing.length, targetOutside: dropped.targetOutside.length,
                  nodesDropped: sk.nodes.length - nodesCur.length,
                },
                truncated: sk.truncated.length, unresolved: sk.unresolved.length,
                elidedRate: sk.nodes.length > 0 ? round3((sk.nodes.length - nodesCur.length) / sk.nodes.length) : 1,
                snapshot: { builtAt: new Date(index.builtAt).toISOString(), gitHead: index.headSha ?? index.gitHead },
              },
            });
          } catch { /* 遥测失败不影响落板 */ }
          bus.emit("board.changed", { sessionId, taskId: boardId });
          return JSON.stringify({
            status: "ok", boardId,
            nodes: sr.saved.doc.nodes.length, edges: sr.saved.doc.edges.length,
            skeletonNodes: nodesCur.length, skeletonEdges: edgesFinal.length,
            dropped, truncated: sk.truncated, unresolved: sk.unresolved,
            snapshot: {
              builtAt: new Date(index.builtAt).toISOString(),
              gitHead: index.headSha ?? index.gitHead,
              extractorVersion: index.extractorVersion ?? "未记录",
            },
            note: "骨架来自索引快照(行号/时间为快照时点);在此底版上补变更层:add/modify 节点带 targets/before",
          });
        }

        // ---- action=audit:只读收口核对(P0 清单+证据+覆盖率),不写盘 ----
        if (action === "audit") {
          /** 2026-10-25:format=json 的结构化出口(execute 仍 string;JSON 是字符串内容)。 */
          const jsonFormat = a.format === "json";
          const boardsOut: Array<Record<string, unknown>> = [];
          const targets: string[] = [];
          // q4 缺省只核对**本写者自己的板**(boardId);跨看必须显式 all:true
          // (缺陷现场:子写者并入主板后,主 agent 的 audit 把自己的 4 个 P0 和别人的 20 个一起算成 17%)。
          // 2026-10-25:targetTaskId 显式指定本任务的分区板=审计 planner 的原始契约。
          if (targetError) {
            if (jsonFormat) return JSON.stringify({ ok: false, grand: { total: 0, passed: 0, rate: 1, covered: 0 }, writers: {}, boards: [], contractIssues: [], typeIssues: [], symbolIssues: [], targetIssues: [], reason: "target-not-allowed", message: targetError });
            return targetError;
          }
          if (explicitTargetTid !== "") targets.push(targetBoardId);
          else if (a.all) targets.push(...(await listBoardsExAsync(root, sessionId)).items.map((i) => i.taskId));
          else targets.push(boardId);
          if (!targets.length) {
            if (jsonFormat) return JSON.stringify({ ok: false, grand: { total: 0, passed: 0, rate: 1, covered: 0 }, writers: {}, boards: [], contractIssues: [], typeIssues: [], symbolIssues: [], targetIssues: [], reason: "no-boards" });
            return "本会话还没有白板(先 board_upsert 画板并给 P0 节点挂 accept)。";
          }
          // q3 按写者分区核对:scope 给了=只看本写者的节点(id 以 `${scope}-` 开头);
          // all=true=按 id 首个 `-` 前的前缀分组(每次写者一段),合计行明确标注「跨写者,仅参考」。
          const scopePrefix = scopeId ? `${scopeId}-` : "";
          const pickNodes = (doc: { nodes: readonly unknown[] }) =>
            scopePrefix === "" ? doc.nodes : doc.nodes.filter((n) => String((n as { id?: unknown }).id ?? "").startsWith(scopePrefix));
          const blocks: string[] = [];
          /** 变更契约自检(2026-10-25):跨板收集,收口回执统一点名(只提示不拒收)。 */
          const contractLines: string[] = [];
          /** 板型一致性门(2026-10-25):与通用契约自检分开,JSON 单列 typeIssues。 */
          const typeLines: string[] = [];
          /** 分组累积器:id 前缀 → P0 通过/总数;`""`=无前缀(裸 n1 这类)归「(无前缀)」组。 */
          const groupAcc = new Map<string, { passed: number; total: number }>();
          const symbolByBoard = new Map<string, string[]>();
          let grandTotal = 0;
          let grandPassed = 0;
          let grandCovered = 0;
          // 规划质量主视角板(2026-11-06):第一块成功载入的目标板;all=true 时语义见 jsonFormat 出口注释。
          let pqMainDoc: { boardType?: string | null; nodes: readonly unknown[] } | null = null;
          for (const tid of targets) {
            const doc = await loadBoardA(root, sessionId, tid);
            if (!doc) continue;
            if (!pqMainDoc) pqMainDoc = doc as never;
            const visible = pickNodes(doc) as typeof doc.nodes;
            if (scopePrefix !== "" && visible.length === 0) continue; // 本写者在这块板上没节点=不占回执
            const visibleIds = new Set(visible.map((n) => String(n.id)));
            const visibleEdges = doc.edges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));
            const contract = validateChangeContract(visible, doc.docKind, visibleEdges, { boardType: doc.boardType, scale: doc.scale });
            const callIssues = validateCallEdges(visible, visibleEdges, makeCalleesResolver(taskRoot));
            const typeIssues = validateBoardTypeConformance(visible, visibleEdges, doc.boardType, doc.docKind, { scale: doc.scale, docGenre: doc.docGenre });
            const boardContractLines = [...contract.issues, ...callIssues].map((it) => `${it.nodeId}「${it.label}」${it.problems.join("、")}`);
            const boardTypeLines = typeIssues.map((it) => `${it.nodeId}「${it.label}」${it.problems.join("、")}`);
            contractLines.push(...boardContractLines);
            typeLines.push(...boardTypeLines);
            const cov = computeP0Coverage({ nodes: visible });
            grandTotal += cov.total;
            grandPassed += cov.passed;
            grandCovered += cov.covered;
            boardsOut.push({
              taskId: tid, title: doc.title, status: doc.status, docKind: doc.docKind ?? "design",
              ...(doc.boardType ? { boardType: doc.boardType } : {}), ...(doc.scale ? { scale: doc.scale } : {}),
              coverage: cov, contractIssues: boardContractLines, typeIssues: boardTypeLines, symbolIssues: [],
            });
            if (a.all && !scopePrefix) {
              for (const s of cov.nodes) {
                const dash = s.id.indexOf("-");
                const g = dash > 0 ? s.id.slice(0, dash) : "";
                const acc = groupAcc.get(g) ?? { passed: 0, total: 0 };
                acc.total += 1;
                if (s.passed) acc.passed += 1;
                groupAcc.set(g, acc);
              }
            }
            // q4:all=true 会把多块板(主板 + 各写者独立板)的结果拼在一起,每块点名板 id——
            // 否则「跨看」的回执分不清哪段属于哪块板,又回到跨任务混读。
            blocks.push((a.all ? `**板 ${tid}:**\n` : "") + renderP0Status({ ...doc, nodes: visible }));
          }
          if (!blocks.length) {
            if (jsonFormat) return JSON.stringify({ ok: false, grand: { total: 0, passed: 0, rate: 1, covered: 0 }, writers: {}, boards: [], contractIssues: [], typeIssues: [], symbolIssues: [], targetIssues: [], reason: scopePrefix !== "" ? "no-writer-nodes" : "no-matching-board" });
            return scopePrefix !== ""
              ? `白板 ${targets.join(",")} 上本写者(前缀 ${scopePrefix})还没有节点——先 board_upsert 提交节点(提交即自动加前缀)。`
              : `白板 ${targets.join(",")} 不存在或已损坏(用 board_upsert 可重建)。`;
          }
          const head: string[] = [];
          if (scopePrefix !== "") head.push(`**收口核对(本写者 ${scopePrefix} 分区):**`);
          if (contractLines.length > 0) {
            head.push("**变更契约自检(只提示,不拒收):**\n"
              + contractLines.slice(0, 15).map((l) => "- " + l).join("\n")
              + (contractLines.length > 15 ? `\n(共 ${contractLines.length} 条,只列 15;按点名补 before/targets/symbolRef、flow 的 cond/then·else/over/body、accept 的 expect/type;页面板补状态/nav、不可逆改动补风险/回滚、显式边补 label)` : ""));
          }
          if (typeLines.length > 0) {
            head.push("**板型一致性门(按 boardType 规范;空数组=通过):**\n"
              + typeLines.slice(0, 15).map((l) => "- " + l).join("\n")
              + (typeLines.length > 15 ? `\n(共 ${typeLines.length} 条,只列 15;按板型规范补 test 数据/decision/断言、docs 禁代码、ui 纯 UI、ui-func 连通、fault 根因、refactor 双泳道、perf 数字、data dry-run/幂等、contract 消费者、deploy smoke 接线、research 矩阵、orchestration 拓扑)` : ""));
          }
          if (groupAcc.size > 0) {
            // q3 分组输出:每组一段,便于并行写者各自认领自己的 P0
            const lines = [...groupAcc.entries()]
              .sort((x, y) => (x[0] === "" ? 1 : y[0] === "" ? -1 : x[0].localeCompare(y[0])))
              .map(([g, v]) => `${g === "" ? "(无前缀)" : g + "-"} P0 ${v.passed}/${v.total}`);
            head.push("按写者分组:" + lines.join(" / "));
          }
          const summary = grandTotal === 0
            ? (scopePrefix !== ""
              ? `本写者(${scopePrefix})分区内无 P0 落目标(纯探索/问答任务可无;产品/打包类任务要挂 P0 冒烟节点)。`
              : "本会话无 P0 落目标(纯探索/问答任务可无;产品/打包类任务要挂 P0 冒烟节点)。")
            : `**收口核对:P0 覆盖率合计 ${grandPassed}/${grandTotal}(${Math.round((grandPassed / grandTotal) * 100)}%)**`
              + (groupAcc.size > 0 ? "(合计跨写者,仅参考)" : "")
              + (grandPassed < grandTotal ? "——未达 100%,禁止宣称任务完成,报告须显式列出未覆盖节点。" : "——全部通过。");
          // 收尾自检(2026-10-25 板规范 §七):symbolRef 幻影引用核对——实施后符号挪位/改名,
          // 板上的引用会断链(broken=幻影)或漂移(moved);只读盘上索引(缺席退化为文件锚判定)。
          const phantom: string[] = [];
          // targets 真实性核对(2026-11-04):板上 targets 常是幻影路径(写错/不存在/绝对路径)。
          // 只报不判——targetIssues 不进 ok 计算;scope 分区口径与下面 symbolRef 核对一致。
          const targetIssues: string[] = [];
          try {
            const { resolveBoardLinksAsync, resolveTargetPathsAsync } = await import("./board-store.js");
            const { loadIndex } = await import("@lampgenie/code-sense");
            for (const tid of targets) {
              const doc2 = await loadBoardA(root, sessionId, tid);
              if (!doc2) continue;
              const picked = pickNodes(doc2) as typeof doc2.nodes;
              const withTargets = picked.filter((n) => Array.isArray((n as { targets?: unknown }).targets) && ((n as { targets?: unknown[] }).targets ?? []).length > 0);
              if (withTargets.length) {
                const tLabel = new Map(withTargets.map((n) => [String(n.id), String(n.label ?? n.id)]));
                for (const t of await resolveTargetPathsAsync(taskRoot, { ...doc2, nodes: withTargets } as typeof doc2)) {
                  const who = `${t.nodeId}「${tLabel.get(t.nodeId) ?? t.nodeId}」`;
                  targetIssues.push(t.state === "outside"
                    ? `${who} targets 越界(绝对路径/..):${t.target}(写成仓库相对路径)`
                    : `${who} targets 不存在:${t.target}(回 code_sense 查真实路径,或删该项)`);
                }
              }
              const withRef = picked.filter((n) => (n as { symbolRef?: unknown }).symbolRef);
              if (!withRef.length) continue;
              const index = loadIndex(taskRoot);
              const indexHas = (name: string): boolean | null => (index ? (index.byName[name]?.length ?? 0) > 0 : null);
              const idLabel = new Map(withRef.map((n) => [String(n.id), String(n.label ?? n.id)]));
              for (const st of await resolveBoardLinksAsync(taskRoot, { ...doc2, nodes: withRef } as typeof doc2, indexHas)) {
                const who = `${st.nodeId}「${idLabel.get(st.nodeId) ?? st.nodeId}」`;
                const line = st.state === "broken"
                  ? `${who} 断链=幻影引用(符号已不存在:回 code_sense 查新名更新 symbolRef,或删该节点)`
                  : st.state === "moved" ? `${who} 漂移至 ${st.file ?? "?"}:${st.line ?? "?"}(符号还在但行号变了:刷新 symbolRef)` : "";
                if (!line) continue;
                phantom.push(line);
                const arr = symbolByBoard.get(tid) ?? [];
                arr.push(line);
                symbolByBoard.set(tid, arr);
              }
            }
            if (phantom.length) head.push("**symbolRef 核对(收尾自检):**\n" + phantom.slice(0, 15).map((l) => "- " + l).join("\n") + (phantom.length > 15 ? `\n(共 ${phantom.length} 条,只列 15)` : ""));
            if (targetIssues.length) head.push("**targets 核对(收尾自检):**\n" + targetIssues.slice(0, 15).map((l) => "- " + l).join("\n") + (targetIssues.length > 15 ? `\n(共 ${targetIssues.length} 条,只列 15)` : ""));
          } catch { /* 链接核对失败不影响审计主面 */ }
          if (jsonFormat) {
            for (const b of boardsOut) {
              const tid = String(b.taskId ?? "");
              b.symbolIssues = symbolByBoard.get(tid) ?? [];
            }
            const writers: Record<string, { passed: number; total: number }> = {};
            for (const [g, v] of groupAcc) writers[g === "" ? "(无前缀)" : g] = v;
            // 规划质量字段(2026-11-06,B2 P2):以**本任务主视角**输出——audit 目标板里第一块成功
            // 载入的就是主视角板(all=true 跨板时 grand 本就只作参考;字段语义=「本任务规划质量」)。
            const pq = planQualityOf(pqMainDoc ?? { nodes: [] });
            // audit 落盘(2026-11-06,N1 实锤「9 条清单事后取不到」):JSON 结果写
            // <storeRoot>/.genie/boards-audit/<taskId>-<ts>.json,telemetry/回归直接对账;journal 事件不变。
            let auditPath = "";
            try {
              const dir = join(storeRoot ?? root, BOARD_AUDIT_DIR);
              mkdirSync(dir, { recursive: true });
              auditPath = join(dir, `${taskId}-${Date.now()}.json`);
              writeFileSync(auditPath, JSON.stringify({
                at: Date.now(), sessionId, taskId, planQuality: pq,
                ok: (grandTotal > 0 ? grandPassed === grandTotal : true) && typeLines.length === 0,
                grand: { total: grandTotal, passed: grandPassed, covered: grandCovered, rate: grandTotal === 0 ? 1 : grandPassed / grandTotal },
                writers, boards: boardsOut, contractIssues: contractLines, typeIssues: typeLines, symbolIssues: phantom, targetIssues,
              }, null, 1));
            } catch { /* 落盘失败不影响回执(audit 本体在 journal/回执里) */ }
            // bq1(2026-11-05 遥测闭环):audit 结果旁路落 board.audit——跨会话消费(基线表/看板)
            // 直接读事件,不必重放 boards-audit 快照文件。独立 try:遥测失败不影响回执。
            try {
              // 主视角板指纹:节点按 id 排序、边按 from,to 排序,序列化后 sha1 前 12 位(内容变=指纹变)。
              const pqMain = pqMainDoc as { nodes?: Array<{ id?: unknown; label?: unknown; targets?: unknown }>; edges?: Array<{ from?: unknown; to?: unknown }> } | null;
              const nodeStrs = ((pqMain?.nodes ?? []) as Array<{ id?: unknown; label?: unknown; targets?: unknown }>)
                .map((n) => `${n.id}|${n.label}|${(Array.isArray(n.targets) ? n.targets : []).join(",")}`)
                .sort();
              const edgeStrs = ((pqMain?.edges ?? []) as Array<{ from?: unknown; to?: unknown }>)
                .map((e) => `${e.from}->${e.to}`)
                .sort();
              const snapshotFp = createHash("sha1").update(`${nodeStrs.join("\n")}\n${edgeStrs.join("\n")}`).digest("hex").slice(0, 12);
              const skeletonPrefilled = pqMain?.nodes
                ? pqMain.nodes.filter((n) => String(n.id ?? "").startsWith("sk-")).length
                : 0;
              journal.append({
                kind: "board.audit", sessionId,
                payload: {
                  taskId, boardType: pq.boardType,
                  ok: (grandTotal > 0 ? grandPassed === grandTotal : true) && typeLines.length === 0,
                  grand: { total: grandTotal, passed: grandPassed, covered: grandCovered, rate: grandTotal === 0 ? 1 : grandPassed / grandTotal },
                  planQuality: pq,
                  issueCounts: { contract: contractLines.length, type: typeLines.length, symbol: phantom.length, target: targetIssues.length },
                  skeletonPrefilled, snapshotFp, auditPath,
                  boards: boardsOut.map((b) => ({
                    taskId: b.taskId, title: b.title,
                    ...(b.boardType ? { boardType: b.boardType } : {}),
                    coverage: { passed: (b.coverage as { passed?: number } | undefined)?.passed ?? 0, total: (b.coverage as { total?: number } | undefined)?.total ?? 0 },
                  })),
                },
              });
            } catch { /* 遥测失败不影响回执 */ }
            return JSON.stringify({
              ok: (grandTotal > 0 ? grandPassed === grandTotal : true) && typeLines.length === 0,
              ...(auditPath ? { auditPath } : {}),
              planQuality: pq,
              grand: { total: grandTotal, passed: grandPassed, covered: grandCovered, rate: grandTotal === 0 ? 1 : grandPassed / grandTotal },
              writers, boards: boardsOut, contractIssues: contractLines, typeIssues: typeLines, symbolIssues: phantom, targetIssues,
            });
          }
          return [...head, summary, ...blocks].join("\n\n");
        }

        // ---- action=evidence:按节点回填验收证据 ----
        if (action === "evidence") {
          if (targetError) return targetError;
          // 2026-10-31 批量回填:一次调用可回填多节点(旧 nodeId 单节点路径逐字不变)。
          // 实测一个 3 节点板原来要 3 次 evidence 调用(每步 ~18k input token)→ 现在 1 次。
          const normEvidence = (raw: unknown) => (Array.isArray(raw) ? raw : [])
            .map((e: { cmd?: unknown; ok?: unknown; output?: unknown; note?: unknown; at?: unknown }) => ({
              cmd: typeof e?.cmd === "string" ? e.cmd : "",
              ok: e?.ok === true,
              at: 0, // 服务端补时间(客户端 at 不可信),写盘前统一填
              ...(typeof e?.output === "string" && e.output ? { output: e.output.slice(0, 2000) } : {}),
              ...(typeof e?.note === "string" && e.note ? { note: e.note.slice(0, 300) } : {}),
            }))
            .filter((e) => e.cmd.trim() !== "");
          const nodeId = String(a.nodeId ?? "");
          const batchRaw = (a.evidenceByNode && typeof a.evidenceByNode === "object" && !Array.isArray(a.evidenceByNode))
            ? a.evidenceByNode as Record<string, unknown> : undefined;
          // 待回填清单:[节点 id, 规范化证据];nodeId 与 evidenceByNode 同时给 → 两者都做(同一节点后者覆盖前者)。
          const plan = new Map<string, ReturnType<typeof normEvidence>>();
          const single = normEvidence(a.evidence);
          if (nodeId && single.length) plan.set(nodeId, single);
          for (const [k, v] of Object.entries(batchRaw ?? {})) {
            const evs = normEvidence(v);
            if (!evs.length) continue; // 空数组/全无效 → 跳过该键(不报错)
            plan.set(k, evs);
          }
          if (!plan.size) {
            if (!nodeId && !batchRaw) return "action=evidence 需要 nodeId(白板未改动,任务不受影响)";
            if (!single.length && nodeId) return "action=evidence 需要非空 evidence 数组(白板未改动,任务不受影响)";
            return "action=evidence 需要非空 evidence 数组或 evidenceByNode(白板未改动,任务不受影响)";
          }
          const batchMode = plan.size > 1 || (!plan.has(nodeId));
          // load→改→save 整段进板锁(f1):并行写同一块板时不互相覆盖。
          const r = await withBoardLock(root, sessionId, targetBoardId, async () => {
            const doc = await loadBoardA(root, sessionId, targetBoardId);
            if (!doc) return `白板 ${targetBoardId} 不存在或已损坏(先 board_upsert 画板;本次证据未落盘,任务不受影响)。`;
            const missing: string[] = [];
            const applied: { id: string; count: number; passed: number }[] = [];
            const now = Date.now();
            for (const [id, incoming] of plan) {
              const node = doc.nodes.find((n) => n.id === id);
              if (!node) { missing.push(id); continue; } // 不中断:其它节点的合法回填照做
              const stamped = incoming.map((e) => ({ ...e, at: now }));
              // 同 cmd 覆盖旧证据(重跑以最新为准),不同 cmd 追加;上限 24 条
              const kept = (node.evidence ?? []).filter((e) => !stamped.some((i) => i.cmd === e.cmd));
              node.evidence = [...kept, ...stamped].slice(-24);
              if (markDoneFromEvidence(node)) node.done = true;
              applied.push({ id, count: stamped.length, passed: stamped.filter((e) => e.ok).length });
            }
            // 单节点旧路径:点名错误原样返回(文案逐字不变,先于写盘)。
            const onlyId = applied.length === 0 && plan.size === 1 ? [...plan.keys()][0]! : "";
            if (plan.size === 1 && onlyId && missing.length) {
              return `板上没有节点 ${onlyId}(现有:${doc.nodes.map((n) => n.id).join(", ")};证据未落盘,任务不受影响)。`;
            }
            if (applied.length === 0) {
              // 多节点里全部不存在:点名全部,同样不写盘
              return `板上没有节点 ${missing.join("、")}(现有:${doc.nodes.map((n) => n.id).join(", ")};证据未落盘,任务不受影响)。`;
            }
            // 2026-10-25:evidence 可顺带定板状态;done 仍走收口门(P0 证据全绿)校验,避免无证据收口。
            let statusNote = "";
            if (a.status !== undefined) {
              if (a.status === "done") {
                const cov = computeP0Coverage(doc);
                if (cov.passed < cov.total) statusNote = `P0 未全绿(${cov.passed}/${cov.total}),status 未置 done`;
                else doc.status = "done";
              } else {
                doc.status = a.status;
              }
            }
            const saved = await saveBoardAsync(root, { ...doc, rev: (doc.rev ?? 0) + 1, updatedAt: 0 }, { skipGates: true });
            if (!saved.ok) return saved.reason + "(证据未落盘,任务不受影响)";
            return {
              saved, applied, missing, statusNote,
              count: applied.reduce((s, x) => s + x.count, 0),
              passed: applied.reduce((s, x) => s + x.passed, 0),
            };
          });
          if (typeof r === "string") return r;
          const { saved } = r;
          journal.append({
            kind: "board.update", sessionId,
            payload: { taskId: targetBoardId, path: saved.path, rev: saved.doc.rev, title: saved.doc.title, nodeCount: saved.doc.nodes.length, edgeCount: saved.doc.edges.length, status: saved.doc.status, docKind: saved.doc.docKind ?? "design", evidence: batchMode ? r.applied.map((x) => x.id) : nodeId },
          });
          bus.emit("board.changed", { sessionId, taskId: targetBoardId });
          const missingNote = r.missing.length ? `\n⚠ 板上没有节点 ${r.missing.join("、")}(现有:${saved.doc.nodes.map((n) => n.id).join(", ")};其余节点证据已落盘)` : "";
          if (!batchMode) {
            // 单节点旧路径:回执文案逐字不变
            return `已回填 ${nodeId} 的 ${r.count} 条证据(${r.passed} 通过)。` +
              (targetBoardId !== boardId ? `\n目标板:${targetBoardId}` : "") +
              (r.statusNote ? `\n⚠ ${r.statusNote}` : "") +
              missingNote +
              `\n` + renderP0Status(saved.doc);
          }
          return `已回填 ${r.applied.length} 个节点共 ${r.count} 条证据(${r.passed} 通过)。` +
            `\n明细:${r.applied.map((x) => `${x.id}=${x.count} 条/${x.passed} 通过`).join("、")}` +
            (targetBoardId !== boardId ? `\n目标板:${targetBoardId}` : "") +
            (r.statusNote ? `\n⚠ ${r.statusNote}` : "") +
            missingNote +
            `\n` + renderP0Status(saved.doc);
        }

        // ---- action=prune:清理零痕迹残留节点(白板历史污染清理) ----
        // 背景:upsert 无删除语义(刻意,怕误删人的工作)→ planner 换 id 重画后旧节点永久残留
        // (实测某板 42 节点里 16 个是同写者自造双份,全部 done:false/evidence:[]/comments:[] 零人的痕迹)。
        // 安全门:①候选必须同时给 nodeIds 或 scope;②**每个**候选都要「零痕迹」(!done && 无 evidence && 无 comments),
        // 有痕迹一律拒删并点名 protectedIds;③缺省 dryRun(只报不删),必须显式 dryRun:false + confirm:true 才写盘;
        // ④真删时同步剔除 from/to 命中被删 id 的边(否则 saveBoard 的边引用完整性校验会拒收);
        // ⑤saveBoard 带 skipGates(删掉 P0 节点后落板门/收口门会误判)。
        if (action === "prune") {
          // 历史板清理(h):targetTaskId 缺省=当前任务板。boardPath 本身在 session 目录下,
          // 天然按会话隔离(不必再校验「板是否属于本会话」);loadBoard 返回 null 时不写盘。
          // q4:缺省清**本写者自己的板**(boardId,子写者=独立板);targetTaskId 显式指定照旧可跨板。
          const pruneTid = (typeof a.targetTaskId === "string" && a.targetTaskId.trim() !== "" ? a.targetTaskId.trim() : boardId);
          const explicitIds = (Array.isArray(a.nodeIds) ? a.nodeIds : [])
            .filter((x): x is string => typeof x === "string" && x.trim() !== "")
            .map((x) => x.trim());
          // scope 前缀与 upsert 的分区同口径(已消毒),两者都没给=无从判断删哪些,直接回话术且不写盘。
          const prunePrefix = scopeId !== "" ? `${scopeId}-` : "";
          if (explicitIds.length === 0 && prunePrefix === "") {
            return "action=prune 需要 nodeIds 或 scope 才能确定删哪些(白板未改动)。";
          }
          const zeroTrace = (n: { done?: unknown; evidence?: unknown; comments?: unknown }): boolean =>
            n.done !== true
            && (!Array.isArray(n.evidence) || n.evidence.length === 0)
            && (!Array.isArray(n.comments) || n.comments.length === 0);
          const pr = await withBoardLock(root, sessionId, pruneTid, async () => {
            const doc = await loadBoardA(root, sessionId, pruneTid);
            if (!doc) {
              return pruneTid === taskId
                ? `白板 ${taskId} 不存在或已损坏(先 board_upsert 画板;本次未删任何节点,任务不受影响)。`
                : `目标板 ${pruneTid} 不存在或损坏(本会话内没有这块板;白板未改动,任务不受影响)。`;
            }
            const wantIds = new Set(explicitIds);
            // 候选:显式 nodeIds 优先——同时接受盘上带 scope 前缀的 id 与调用方未带前缀的 id;
            // **给了 nodeIds 就不再按 scope 前缀整片命中**(旧实现 wantIds ∪ prefix 会把同 scope
            // 的其它节点一起删,planner 实测显式清 9 个旧节点却报「删完剩 0」)。
            // 只有没给 nodeIds 时才用 scope 前缀清整片残留。
            const candidates = doc.nodes.filter((n) => {
              if (wantIds.size) {
                return wantIds.has(n.id)
                  || (prunePrefix !== "" && n.id.startsWith(prunePrefix) && wantIds.has(n.id.slice(prunePrefix.length)));
              }
              return prunePrefix !== "" && n.id.startsWith(prunePrefix);
            });
            if (candidates.length === 0) {
              return `板上没有匹配的节点(nodeIds ${explicitIds.length} 个 / scope 前缀「${prunePrefix || "(未给)"}」;白板未改动)。`;
            }
            const deletable: string[] = [];
            const protectedIds: string[] = [];
            /** 逐个人话点名:label + 为何拒删(有痕迹=人的工作,不是残留)。 */
            const protectedDetail: string[] = [];
            for (const n of candidates) {
              if (zeroTrace(n)) { deletable.push(n.id); continue; }
              protectedIds.push(n.id);
              const why = [
                n.done === true ? "done=true(已落实)" : "",
                Array.isArray(n.evidence) && n.evidence.length > 0 ? `evidence ${n.evidence.length} 条` : "",
                Array.isArray(n.comments) && n.comments.length > 0 ? `comments ${n.comments.length} 条` : "",
              ].filter(Boolean).join("+");
              protectedDetail.push(`${n.id}「${n.label}」${why}`);
            }
            const listOf = (ids: string[]): string => ids.slice(0, 10).join(", ") + (ids.length > 10 ? "…" : "");
            const plan = `将删除 ${deletable.length} 个(全是零痕迹):${deletable.length ? listOf(deletable) : "(无)"}`;
            const keep = protectedDetail.length
              ? `保留 ${protectedDetail.length} 个有人的痕迹:${listOf(protectedDetail)}——这些是人的工作,prune 不动。`
              : "";
            // 安全门:缺省 dryRun(=a.dryRun !== false 即只报);confirm 必须显式为 true 才真删。
            if (a.dryRun !== false || a.confirm !== true) {
              return [plan, keep, "确认后请带 dryRun:false + confirm:true 重试(白板未改动)。"].filter(Boolean).join(" ");
            }
            if (deletable.length === 0) return `没有可删的零痕迹节点(白板未改动)。${keep}`.trim();
            const delSet = new Set(deletable);
            const nodesNext = doc.nodes.filter((n) => !delSet.has(n.id));
            // 协议要求 nodes 至少 1 个:删完归零=先把板删空,不是「清理残留」,直接拒并让人精确指定。
            if (nodesNext.length === 0) {
              return `候选覆盖了板上全部节点(删完剩 0 节点,板要求至少 1 个节点)——请用 nodeIds 精确指定要删的残留;白板未改动。`;
            }
            // 边同步剔除:from/to 命中被删 id 的一律剔除,否则 saveBoard 的边引用完整性校验会拒收。
            const edgesNext = doc.edges.filter((e) => !delSet.has(e.from) && !delSet.has(e.to));
            const saved = await saveBoardAsync(root, { ...doc, nodes: nodesNext, edges: edgesNext, rev: (doc.rev ?? 0) + 1, updatedAt: 0 }, { skipGates: true, agentWrite: true });
            if (!saved.ok) return saved.reason + "(白板未改动,任务不受影响)";
            return { saved, deleted: deletable.length, protectedIds, protectedDetail, removedEdges: doc.edges.length - edgesNext.length };
          });
          if (typeof pr === "string") return pr;
          journal.append({
            kind: "board.update", sessionId,
            payload: { taskId: pruneTid, path: pr.saved.path, rev: pr.saved.doc.rev, title: pr.saved.doc.title, nodeCount: pr.saved.doc.nodes.length, edgeCount: pr.saved.doc.edges.length, status: pr.saved.doc.status, docKind: pr.saved.doc.docKind ?? "design", prune: pr.deleted },
          });
          bus.emit("board.changed", { sessionId, taskId: pruneTid });
          const warn = pr.protectedDetail.length
            ? ` ⚠ 拒删 ${pr.protectedDetail.length} 个有人的痕迹:${pr.protectedDetail.slice(0, 10).join("; ")}${pr.protectedDetail.length > 10 ? "…" : ""}`
            : "";
          return `已清理 ${pr.deleted} 个零痕迹节点(rev → ${pr.saved.doc.rev},剩 ${pr.saved.doc.nodes.length} 节点/${pr.saved.doc.edges.length} 边;同步剔除 ${pr.removedEdges} 条边)。${warn}`;
        }

        // ---- action=upsert(缺省):落整板 ----
        // dsl 主路径(2026-11-03):LLM 写紧凑 DSL,这里解析成 nodes/edges 再走既有落板管线。
        // dsl 与 nodes 同给时按节点 id 合并:dsl 为准(基底+顺序),JSON 只补 dsl 写不了的字段(白名单见 board-dsl.ts),
        // JSON 独有 id 不并入;edges 仍由 dsl 硬覆盖。
        let dslNodes: unknown[] | undefined;
        let dslEdges: unknown[] | undefined;
        let dslMeta: { title?: string; boardType?: string; scale?: string; docKind?: string } | undefined;
        let dslDiagNote = "";
        if (typeof a.dsl === "string" && a.dsl.trim() !== "") {
          const { parseBoardDsl } = await import("./board-dsl.js");
          const parsed = parseBoardDsl(a.dsl);
          dslMeta = parsed.meta;
          dslNodes = parsed.nodes;
          dslEdges = parsed.edges;
          // 解析错误原样回给 LLM(带行号),让它自己改——不落半成品板。
          const errs = parsed.diags.filter((d) => d.severity === "error");
          if (errs.length > 0 || !parsed.ok) {
            const shown = errs.slice(0, 8).map((d) => `第 ${d.line} 行 ${d.code} ${d.message}`).join("\n");
            return `dsl 解析失败(${errs.length} 处错误),白板未保存:\n${shown}`
              + (errs.length > 8 ? `\n…还有 ${errs.length - 8} 处` : "");
          }
          const warns = parsed.diags.filter((d) => d.severity === "warn");
          if (warns.length > 0) {
            dslDiagNote = ` ⚠ dsl ${warns.length} 条警告(前 3:${warns.slice(0, 3).map((d) => `第 ${d.line} 行 ${d.code}`).join(";")})`;
          }
        }
        // dsl 与 nodes 同给时**按节点 id 合并**(2026-11-05):dsl 为基底与顺序,JSON 只补 dsl 写不了的字段
        // (flow/evidence/comments/wf/fileRef/done/pos);JSON 独有 id 不并入(防两版并板);edges 仍 dsl 硬覆盖。
        let dslMergedNote = "";
        let effNodes = a.nodes;
        if (dslNodes !== undefined) {
          const { mergeDslWithNodes } = await import("./board-dsl.js");
          const merged = mergeDslWithNodes(dslNodes as never[], a.nodes);
          effNodes = merged.nodes as unknown[];
          if (merged.filled > 0) dslMergedNote = ` dsl+nodes 合并:补全 ${merged.filled} 个节点的 flow/evidence 等字段`;
        }
        const effEdges = dslEdges ?? a.edges;
        const effTitle = a.title ?? dslMeta?.title;
        const effBoardType = a.boardType ?? (dslMeta?.boardType as typeof a.boardType | undefined);
        const effScale = a.scale ?? (dslMeta?.scale as typeof a.scale | undefined);
        const effDocKind = a.docKind ?? (dslMeta?.docKind as typeof a.docKind | undefined);
        if (!effTitle || !Array.isArray(effNodes) || effNodes.length === 0) {
          return "board_upsert 需要 title 与非空 nodes,或给 dsl 文本(白板未保存,任务不受影响)";
        }
        // load→模板并入→撞车自检→merge→save 整段进板锁(f1):并行子代理同写一块板时不互相覆盖。
        // 回调返回字符串=拒收话术(原样透出);返回对象=已落盘,由锁外统一回执。
        // q4:子写者(boardId≠taskId)读写的都是**自己的独立板**,与主 agent 的板互不可见。
        const ur = await withBoardLock(root, sessionId, boardId, async () => {
          const existing = await loadBoardA(root, sessionId, boardId);
          // P0-4 模板接线(step-137):参数 template=smoke|preflight 直接把模板节点并进本板(板上已有同 id 则保留人工版本)。
          // 产品/桌面/安装类任务用 smoke;打包类另加 preflight。模板本身即合格契约(P0 smoke 自带 4 条 accept)。
          let nodesIn = effNodes as unknown[];
          if (a.template === "smoke" || a.template === "preflight") {
            const tplNode: BoardNodeT = a.template === "smoke"
              ? smokeTemplateNode()
              : ({ ...PACKAGING_PREFLIGHT } as unknown as BoardNodeT);
            const ids = new Set((effNodes as { id?: unknown }[]).map((n) => String(n?.id ?? "")));
            if (!ids.has(tplNode.id)) nodesIn = [...nodesIn, tplNode];
          }
          let edgesInRaw = Array.isArray(effEdges) ? (effEdges as { from: string; to: string; kind?: string; label?: string }[]) : [];
          // q1 写者作用域:并行写者(planner)落同一块板时,把本写者提交的节点 id 统一加 `${scope}-`
          // 前缀,边用**同一套重写规则**改写 from/to(否则边还指向旧 id → 悬空 → 被下面的
          // 「悬空边自动剔除」静默丢掉,回执却照报「显式 N 条」)。
          // 效果:同板上不同写者的节点分区存放、互不覆盖;主 agent(scope 缺省)完全不走这段,行为不变。
          // 幂等口径(缺陷修复):scope 只加一次 —— 节点 id 已带本写者前缀(planner 自己就写成 bp-space)
          // 时不再加,引用它的边端点也不加;裸 id 节点加前缀,引用它的边端点同样加前缀。
          // 边端点解析按「本次提交节点重写后的真实 id」裁决,查不到才退回加前缀写法 ⇒ 端点永远对得上;
          // 引用盘上**别的写者**已有节点(kb-ingest)的边不会被加成本写者前缀而变悬空。
          if (scopeId) {
            const pre = `${scopeId}-`;
            nodesIn = nodesIn.map((n) => {
              const nn = n as { id?: unknown };
              if (!nn || typeof nn.id !== "string" || nn.id === "") return n;
              if (nn.id.startsWith(pre)) return n; // 已带本写者前缀=幂等(重复提交不会套娃)
              return { ...(n as Record<string, unknown>), id: pre + nn.id };
            });
            const submittedIds = new Set(
              (nodesIn as { id?: unknown }[]).map((n) => String(n?.id ?? "")).filter((id) => id !== ""),
            );
            const resolveEnd = (id: string): string => {
              if (submittedIds.has(id) || id === "") return id; // 已是本次提交的重写后 id
              const prefixed = pre + id;
              return submittedIds.has(prefixed) ? prefixed : id; // 裸 id 指向本写者节点 → 加前缀
            };
            if (edgesInRaw.length > 0) {
              edgesInRaw = edgesInRaw.map((e) => ({ ...e, from: resolveEnd(e.from), to: resolveEnd(e.to) }));
            }
          }
          // f2 跨写者 id 撞车硬拒(2026-10-24):并行子代理各自从 n1 顺排、共用同一块板时,
          // mergeBoardNodes 按 id 合并会把别人的整块节点换成自己的一版(先落的静默消失)。
          // 只要「同 id 但 label 不同」= 两个写者争同一个 id,直接拒收并点名,不落盘。
          const prevById = new Map<string, string>();
          for (const n of (Array.isArray(existing?.nodes) ? existing.nodes : []) as { id?: unknown; label?: unknown }[]) {
            if (!n || typeof n.id !== "string" || prevById.has(n.id)) continue;
            prevById.set(n.id, String(n.label ?? "").trim());
          }
          const clashes: string[] = [];
          for (const n of nodesIn as { id?: unknown; label?: unknown }[]) {
            if (!n || typeof n.id !== "string") continue;
            const oldLabel = prevById.get(n.id);
            if (oldLabel === undefined) continue;
            const newLabel = String(n.label ?? "").trim();
            if (oldLabel === newLabel) continue; // 同 id 同 label=正常更新
            const item = `id ${n.id} 现「${oldLabel}」/提交「${newLabel}」`;
            if (!clashes.includes(item)) clashes.push(item);
          }
          if (clashes.length > 0) {
            return `落板被拒:节点 id 撞车(${clashes.length} 处,前 5:${clashes.slice(0, 5).join(";")})。`
              + "upsert 无删除语义;并行子代理请用各自唯一前缀(如 a1-/b1-)避免撞车;确为改名请改用新 id 并在 before 里写明原节点。"
              + "(白板未保存,任务不受影响)";
          }
          const edgesIn = edgesInRaw;
          // 节点级保真合并(人改板不被 agent 全量覆盖):以本次提交为主体与顺序,但把板上已有的人的痕迹
          // 合回来——node.comments / done(未显式表态时)/ pos(拖拽位置)/ evidence(按 cmd 去重),以及
          // 人新增而 agent 没提交的节点(追加到尾部)。删除语义刻意不做:删节点只能人经 board.save。
          const mergedNodes = mergeBoardNodes(existing?.nodes, nodesIn);
          const nodesFinal = mergedNodes.nodes as unknown[];
          // t3 同 scope 旧节点残留提示:本写者以前落过、这次没提交的节点。upsert 无删除语义(删除只能人经
          // board.save),所以「换 id 重画」会让旧的那套永久留在板上——实测曾出现同一 planner 两套 16 节点,
          // 旧实现只在回执里报「保留人工改动」,对自造双份一声不吭。这里点名列出并给补救路径。
          const prevMineIds = scopeId === ""
            ? []
            : ((Array.isArray(existing?.nodes) ? existing.nodes : []) as { id?: unknown }[])
                .map((n) => String(n?.id ?? ""))
                .filter((id) => id !== "" && id.startsWith(`${scopeId}-`));
          const submittedIdSet = new Set((nodesIn as { id?: unknown }[]).map((n) => String(n?.id ?? "")));
          const staleMine = prevMineIds.filter((id) => !submittedIdSet.has(id));
          // t2 系统派生前缀提示:scope 是 plannerScopeOf 的 `p`+4 位形态,且这是本板首次落本 scope 节点
          // (=prevMineIds 为空)时提醒一次——planner 自报 scope(a/b/c)后画布上才看得出谁是谁。
          const sysScopeFirstTime = scopeId !== "" && /^p[0-9a-z]{4}$/.test(scopeId) && prevMineIds.length === 0;
          // 板类型(step-083):显式参数优先;未传时保留板上已有值(改板不丢类型),再退 design。
          const docKindIn = (effDocKind ?? existing?.docKind ?? "design") as string;
          // 文档体裁(2026-10-27 docs 通用机制):显式优先,未传保留已有值(改板不丢)。
          const docGenreIn = (typeof a.docGenre === "string" && a.docGenre.trim() !== ""
            ? a.docGenre.trim()
            : (existing as { docGenre?: string } | null | undefined)?.docGenre ?? undefined) as string | undefined;
          // 关系自动推导(2026-10-22 用户口径「看不出有什么关系」):显式边优先,再按
          // 符号调用/验收/同组次序补 virtual 边。索引不可用时不造 call 边(如实降级,不猜)。
          // workflow 板与读/存两路同款跳过:它自带 board.fromcode 的真实调用边,推导补的
          // nav 边会撞「普通节点只允许 1 条出边」的编译校验(结构对称防御)。
          // q1 分区推理:推导只跑**本写者分区的节点**,否则会给跨写者的节点对造出「同组次序/调用」
          // 虚边;别人的边原样保留在后面拼回去。
          const myPartition = (id: string): boolean => scopeId !== "" && id.startsWith(`${scopeId}-`);
          const deriveInput = scopeId !== ""
            ? (nodesFinal as { id?: unknown }[]).filter((n) => myPartition(String(n?.id ?? "")))
            : (nodesFinal as { id?: unknown }[]);
          const derivedMine = docKindIn === "workflow"
            ? edgesIn
            : deriveBoardEdges(deriveInput as never, edgesIn, { calleesOf: makeCalleesResolver(taskRoot) });
          // q1 互不影响:别人的边(两端都不在我分区内)原样保留,再拼上本次提交/推导的边。
          // 不带 scope 时 othersEdges 恒空 → edges 与旧实现逐字等价(主 agent 行为不变)。
          const othersEdges = scopeId !== "" && Array.isArray(existing?.edges)
            ? (existing.edges as { from: string; to: string }[]).filter((e) => !myPartition(e.from) && !myPartition(e.to))
            : [];
          const derived = [...othersEdges, ...derivedMine];
          // 悬空边自动剔除(核心修复):mergeBoardNodes 在 maxNodes(60) 上限处**只截 prev-only 尾部**,
          // 被截掉的节点如果还挂在边上(othersEdges 是别人的边原样拼回来的),saveBoard 的边引用完整性校验
          // 就会整板拒收 → 该板之后任何写者都永久失败(upsert 无删边语义=死锁)。实测 3 个并行 planner
          // 里 2 个因此连续落板失败。这里对最终边集再滤一遍:两端都必须真实存在于 nodesFinal。
          const finalIds = new Set((nodesFinal as { id?: unknown }[]).map((n) => String(n?.id ?? "")));
          const edgesKept: typeof derived = [];
          const edgesDropped: { from: string; to: string }[] = [];
          for (const e of derived) {
            if (finalIds.has(String(e.from)) && finalIds.has(String(e.to))) edgesKept.push(e);
            else edgesDropped.push({ from: String(e.from), to: String(e.to) });
          }
          // q5 显式边契约回执:显式边=本次提交里未被推导标记的边;推导边=系统补的 virtual 边
          // (验收/同组次序/符号调用)。数字在锁内算好带出锁外拼回执。
          const explicitN = edgesIn.filter((e) => !(e as { virtual?: boolean }).virtual).length;
          const derivedN = derivedMine.filter((e) => (e as { virtual?: boolean }).virtual).length;
          // q2 板名不被子写者覆写:板上已有 title(人/主 agent 定过的)时,子写者(scope 存在)
          // 不许改名——否则并行 planner 各自提交自己的板名,谁最后落谁说了算,板名来回跳。
          // 主 agent(无 scope)照旧:"String(a.title)" 生效,行为完全不变。
          const existingTitle = typeof existing?.title === "string" ? existing.title.trim() : "";
          const titleKept = !!scopeId && existingTitle !== "";
          const titleIn = titleKept ? existingTitle : String(effTitle).slice(0, 200);
          // q7 label 限长门的豁免口径:本次提交里 label 与盘上逐字相同的节点(= 没改它)放行,
          // 存量超长 label 不该让 agent 的每次整板提交都被拒;人保留节点(keptIds)已由 gateExempt 兜住。
          const prevLabelById = new Map<string, string>();
          for (const n of (Array.isArray(existing?.nodes) ? existing.nodes : []) as { id?: unknown; label?: unknown }[]) {
            if (!n || typeof n.id !== "string") continue;
            prevLabelById.set(n.id, String(n.label ?? "").trim());
          }
          const labelExemptNodeIds = (nodesIn as { id?: unknown; label?: unknown }[])
            .filter((n) => typeof n?.id === "string" && prevLabelById.get(n.id as string) === String(n.label ?? "").trim())
            .map((n) => n.id as string);
          const r = await saveBoardAsync(root, {
            version: 1, taskId: boardId, sessionId,
            title: titleIn,
            status: a.status ?? existing?.status ?? "draft",
            docKind: docKindIn,
            ...(effBoardType ?? existing?.boardType ? { boardType: effBoardType ?? existing?.boardType } : {}),
            ...(effScale ?? existing?.scale ? { scale: effScale ?? existing?.scale } : {}),
            ...(docGenreIn ? { docGenre: docGenreIn } : {}),
            rev: (existing?.rev ?? 0) + 1,
            root: taskRoot,
            nodes: nodesFinal,
            edges: edgesKept,
            planned_files: Array.isArray(a.planned_files) ? a.planned_files : (existing?.planned_files ?? []),
            ...(existing?.actual_files ? { actual_files: existing.actual_files } : {}),
            // 人改板变更集要跨 agent 落板存活:否则 agent 一 upsert,人刚改的节点清单被抹掉,
            // 紧接着「按板续作」就只能回退整板派发(变更集白记)。
            ...(existing?.humanEdits ? { humanEdits: existing.humanEdits } : {}),
            updatedAt: 0,
          }, { gateExemptNodeIds: mergedNodes.keptIds, agentWrite: true, labelExemptNodeIds });
          if (!r.ok) {
            // step-137:落板门/收口门的拒收必须说清「哪不满足」,并给出补救路径(否则 agent 只会重试同样输入)
            return r.reason + "(白板未保存;给 P0 节点补 accept 或用 action=evidence 回填证据后重试,任务不受影响)";
          }
          const prevIdSet = new Set(
            (Array.isArray(existing?.nodes) ? (existing.nodes as { id?: unknown }[]) : [])
              .map((n) => String(n?.id ?? "")).filter((id) => id !== ""),
          );
          return { r, mergedNodes, explicitN, derivedN, titleKept, existingTitle, staleMine, sysScopeFirstTime, scopeId, edgesDropped,
            corrections: r.corrections ?? [],
            addedN: (nodesFinal as { id?: unknown }[]).filter((n) => !prevIdSet.has(String(n?.id ?? ""))).length };
        });
        if (typeof ur === "string") return ur;
        const { r, mergedNodes, explicitN, derivedN, titleKept, existingTitle, staleMine, sysScopeFirstTime, scopeId: usedScopeId, edgesDropped, addedN, corrections } = ur;
        journal.append({
          kind: "board.update", sessionId,
          payload: { taskId: boardId, path: r.path, rev: r.doc.rev, title: r.doc.title, nodeCount: r.doc.nodes.length, edgeCount: r.doc.edges.length, status: r.doc.status, docKind: r.doc.docKind ?? "design" },
        });
        bus.emit("board.changed", { sessionId, taskId: boardId });
        const cov = computeP0Coverage(r.doc);
        const p0 = cov.total ? ` · P0 落目标 ${cov.passed}/${cov.total} 已通过验收` : "";
        // P1-1 写板回执内联状态(2026-10-30 token 优化,替代模型板后 board_read 确认):
        // 实测 web-1793279074382 里 62 次 board_read、53 次拿到 49 字符「未变更」存根却每条付满上下文
        // (合计 4.0M input=该会话 2.7%);web-1793329725963 里 board_read 占会话 input 40.8%。
        // 模型回读只为确认「板真落盘了吗/新增了几个/P0 还缺什么」——这三样都在落盘回调里现成,
        // 直接内联进回执即可消掉这次回读。控制长度:只给结论与点名,不回放节点文本(那是换一种烧 token)。
        const p0WithAccept = cov.nodes.filter((s) => s.acceptCount > 0).length;
        const p0Missing = cov.nodes.filter((s) => s.acceptCount === 0).map((s) => s.id);
        // 内联状态块(独立一行:面板 trBoard 的 chip 解析只读首行,不能被新数字打乱)。
        const p0MissingNote = p0Missing.length > 0
          ? ` ⚠ 缺 accept:${p0Missing.slice(0, 5).join(",")}${p0Missing.length > 5 ? `…共 ${p0Missing.length} 个` : ""}`
          : "";
        const churn = `本次新增 ${ur.addedN} 个${mergedNodes.keptIds.length > 0 ? `/保留 ${mergedNodes.keptIds.length} 个` : ""}`;
        const inlineState = `[板状态]rev ${r.doc.rev} · 共 ${r.doc.nodes.length} 节点(${churn}) · ${cov.total > 0 ? `P0 ${cov.total} 个/带 accept ${p0WithAccept} 个${p0MissingNote}` : "无 P0 节点"} · 板上状态已在此回执内,无需 board_read 确认;需要看全量节点文本才读`;
        // 变更契约自检(2026-10-25):软提示,不拒收——存量板/人工节点缺字段不能让落板失败。
        const contract = validateChangeContract(r.doc.nodes, r.doc.docKind, r.doc.edges, { boardType: r.doc.boardType, scale: r.doc.scale });
        const callIssues = validateCallEdges(r.doc.nodes, r.doc.edges, makeCalleesResolver(taskRoot));
        const typeIssues = validateBoardTypeConformance(r.doc.nodes, r.doc.edges, r.doc.boardType, r.doc.docKind, { scale: r.doc.scale, docGenre: r.doc.docGenre });
        const contractIssues = [...contract.issues, ...callIssues, ...typeIssues];
        const contractNote = contractIssues.length > 0
          ? ` ⚠ 变更契约自检:${contractIssues.slice(0, 3).map((i) => `${i.nodeId}「${i.label}」${i.problems.join("、")}`).join("; ")}${contractIssues.length > 3 ? `…(共 ${contractIssues.length} 个节点)` : ""}——按点名补 before/targets/symbolRef、flow 的 cond/then·else/over/body、accept 的 expect/type;页面板补状态/nav、不可逆改动补风险/回滚、显式边补 label;补齐后重提交(本次已落盘)。`
          : "";
        // 保真合并回执(人改板不被全量覆盖):只报非零项,全零时不写该句(不制造噪音)。
        const ms = mergedNodes.stats;
        const keepBits = [
          ms.comments > 0 ? `评论 ${ms.comments} 条` : "",
          ms.done > 0 ? `已落实 ${ms.done} 个` : "",
          mergedNodes.keptIds.length > 0 ? `人工新增节点 ${mergedNodes.keptIds.length} 个` : "",
        ].filter(Boolean);
        const keepNote = keepBits.length ? ` 保留人工改动:${keepBits.join("/")}。` : "";
        // q2 保留板名的显式告知(子写者会以为自己的 title 生效了,不说清就会反复重试改名)
        const titleNote = titleKept ? `(板名保持「${existingTitle}」,改板名请由主 agent 提交)` : "";
        // q5 显式边契约回执:一条真实边都没画时点名警告——全靠系统推导的验收/同组次序边
        // 会让板看起来有关系、实际没有作者的判断,这是这次「看不出有什么关系」投诉的根因。
        const edgeNote = `边:显式 ${explicitN} 条 / 推导 ${derivedN} 条`;
        const edgeWarn = explicitN === 0 && derivedN > 0
          ? " ⚠ 你一条真实关系边都没画(全靠系统推导的验收/同组次序边)——请用 code_sense 查真实调用关系后补 edges(from=调用方,to=被调方)"
          : "";
        // t2 系统派生前缀提示:一次就够(本板首次落本 scope 节点时),提醒 planner 下次显式自报 scope。
        const scopeHint = sysScopeFirstTime
          ? ` ⓘ 当前作用域前缀「${usedScopeId}」是系统派生的${/[0-9a-z]/.test(usedScopeId.slice(1)) ? "随机短码" : "短码"};下次落板可显式传 scope=a/b/c 让画布上更好认。`
          : "";
        // t3 同 scope 旧节点残留提示:本次没提交的本写者旧节点 = upsert 无删除语义下的永久残留
        // (实测同一 planner 换 id 重画后板上出现两套 16 节点,旧实现只报「保留人工改动」没点破)。
        const staleNote = staleMine.length > 0
          ? ` ⚠ 本作用域还有 ${staleMine.length} 个你以前的节点没在本次提交里(${staleMine.slice(0, 5).join(", ")}${staleMine.length > 5 ? "…" : ""});upsert 无删除语义——若是换 id 重画,旧节点会永久留在板上(实测曾出现同一 planner 两套 16 节点);确认要清就由人经 board.save 删。`
          : "";
        // 悬空边剔除回执(核心修复):K=0 不显示——只在真有节点被 maxNodes 截断时才提示,
        // 否则每条回执都带废话。前 3 条点名,便于看清是哪些节点没了。
        const dropNote = edgesDropped.length > 0
          ? ` (已剔除 ${edgesDropped.length} 条指向不存在节点的边:${edgesDropped.slice(0, 3).map((e) => `${e.from}->${e.to}`).join(", ")}${edgesDropped.length > 3 ? "…" : ""})`
          : "";
        // q4 独立板告知:子写者的节点落在自己的板文件上(不并进调用方/主 agent 的任务板),
        // 不说清的话 planner 会以为自己的规划已进主板、主 agent 会以为别人的 P0 归自己。
        const boardNote = boardId !== taskId
          ? ` ⓘ 本次落在**独立板**「${boardId}」(${r.path}),未并进任务板「${taskId}」;跨看用 board_read/action=audit 显式指定 taskId 或 all:true。`
          : "";
        // 自愈更正回执(2026-10-31):kind 校正/label 截断不是静默改板——必须让模型看见改了什么,
        // 否则它会以为自己写的是原值,后续按错值推理。放最前,避免被后面长串提示淹没。
        const fixNote = corrections.length > 0
          ? `⚠ 写板已自动纠正 ${corrections.length} 处(已落盘,无需重试):${corrections.slice(0, 3).join("; ")}${corrections.length > 3 ? `…共 ${corrections.length} 处` : ""}。\n`
          : "";
        return `${fixNote}设计白板已更新:「${r.doc.title}」${r.doc.nodes.length} 节点/${r.doc.edges.length} 边(rev ${r.doc.rev},状态 ${r.doc.status})${p0}。面板白板视图可见;继续实施,节点落实后可再次调用本工具更新状态。\n${inlineState}${boardNote}${keepNote}${titleNote ? ` ${titleNote}` : ""} ${edgeNote}${edgeWarn}${scopeHint}${staleNote}${dropNote}${dslMergedNote}${contractNote}`;
      } catch (err) {
        return "白板工具异常(任务不受影响): " + String(err).slice(0, 120);
      }
    },
  };
}

/** board_read 工具(step-083 页面结构板配套):只读读回本会话白板——「后续轮 agent 不断参考」的
 * 最小方案(按需读取不占每轮 token)。返回最新板的紧凑文本(节点 id/kind/label/summary/位置/用户评论+边)。
 * 只读(plan 模式可用);无板=明确说无板,不编造。
 *
 * q4:opts.boardId=本写者自己的板 id(planner 子代理=`<taskId>-<scope>`,主 agent=`<taskId>`)。
 * 给了 boardId 时缺省**只读这块板**——没有就如实说「还不存在」(不偷偷读别人的板,那正是本次
 * 缺陷的形态:子写者的节点混进调用方的读面/审计)。要跨看请显式传 taskId(all 口径见 action=audit)。
 * 不传 opts(旧调用/单测)时保持旧语义=本会话最新一块板。 */
export function boardReadTool(
  journal: Journal,
  sessionId: string,
  storeRoot?: string,
  opts: { boardId?: string; fallbackToSessionBoard?: boolean } = {},
): Tool {
  // 03 同参去重(2026-10-28 token 优化):实测 93 个 session 里同目标重读 1,437 轮、其中 1,418 次
  // 逐字节相同(最狠一块 2,160 字符的板被读 155 次),且 microcompact 的 NEVER_COMPACT_TOOLS 把
  // board_read 排除在裁剪外——重复读=纯 token 浪费。判据只用 rev(BoardDoc.rev,三处写路径
  // upsert/evidence/prune 均自增),同 key 同 rev 才走短提示。
  // key 必须含板 id 与 all 语义:只按 sessionId 缓存会让「换 taskId 读另一块板」命中旧内容(错的静默丢数据)。
  const lastRead = new Map<string, string>(); // key → 上次返回时的板指纹(rev;all 口径=板数+逐板 rev)
  const lastStep = new Map<string, number>(); // key → 上次全量返回发生在第几步(短提示里点名用)
  // 连发逃逸计数(2026-10-29 无限循环事故:模型陷入 20+ 步同参重读,每步只拿到 49 字符存根——
  // 死胡同无出口)。⚠必须挂实例作用域:放 execute() 里每次调用重建 Map,计数永远到不了 3,
  // 逃生阀=死代码(2026-10-30 实锤:38 步 board_read 死循环里存根一次全文都没回)。
  const stubStreak = new Map<string, number>(); // key → 连续命中存根次数(全量返回即清零)
  // 压缩失效判据(2026-11 修静默丢板内容):auto-compact 会把旧的 board_read 结果整段挤出上下文,
  // 而这张 dedup 缓存不感知压缩 → 压缩后模型再读同一块板只拿到「board 未变更…勿重读」,但正文
  // 已不在上下文 = 模型再也拿不到板内容(静默错误,板是验收契约,比多花 token 严重得多)。
  // 修法:记录上次全量返回时 journal 的最后 seq,命中缓存前扫 seq 之后是否有带非空 summary 的
  // compact.done(真压缩边界口径,与 loop/compact-gate 一致);有=缓存失效,强制返回全文。
  const lastAtSeq = new Map<string, number>(); // key → 上次全量返回时 journal 的最后 seq
  /** 一次遍历同时取:最近 step.start 的 step(短提示点名用)+ sinceSeq 之后是否发生过真压缩
   *  + 当前会话最后 seq(供下次做基线)。把原 stepNow 的全量扫描合并进来,命中/未命中都只扫一遍。 */
  const scanJournal = (sinceSeq: number): { step: number; compacted: boolean; lastSeq: number } => {
    const evs = journal.readSession(sessionId);
    let step = 0;
    let lastSeq = -1; // -1=本会话还没有任何事件(MemoryJournal 首条 seq=0,用 0 当基线会漏掉第一条压缩事件)
    let compacted = false;
    for (const e of evs) {
      lastSeq = e.seq;
      if (e.kind === "step.start") {
        const s = (e.payload as { step?: unknown } | undefined)?.step;
        if (typeof s === "number") step = s;
      } else if (e.kind === "compact.done" && e.seq > sinceSeq) {
        // 只认带摘要的真压缩(autoCompact 恒写 summary;旧 microcompact 的无摘要占位事件不截历史)
        const s = (e.payload as { summary?: unknown } | undefined)?.summary;
        if (typeof s === "string" && s.trim().length > 0) compacted = true;
      }
    }
    return { step, compacted, lastSeq };
  };
  return {
    name: "board_read",
    description: "读取本会话的设计白板/页面结构板(只读)。用途:后续轮次继续参考此前规划的结构(页面/区块/组件/导航、模块设计与用户评论)再动手;回答「之前规划的 X 是什么」类问题也用它。返回紧凑文本,无板时如实说明。",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "要读的板 id(缺省=本写者自己的板:子写者读自己的独立板,主 agent 读自己的任务板)" },
        all: { type: "boolean", description: "true=本会话全部板逐块读(每块点名板 id);缺省只看自己的板" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(args: unknown) {
      try {
        const a = (args ?? {}) as { taskId?: string; all?: boolean };
        const { listBoardsExAsync: listBoardsExA, loadBoardAsync: loadBoardB } = await import("./board-store.js");
        const root = storeRoot ?? repoRoot();
        /** 同参同 rev → 一行短提示(<200 字符)代替全文;rev 变了、首次调用、或上次全量返回之后
         *  发生过真压缩(正文已被挤出上下文)才返回全量。连发逃逸:同一 key 连续第 3 次命中存根
         *  =模型明确需要内容而拿不到,直接给全文+换路指路,不再坚持去重。 */
        const dedup = (key: string, rev: string, full: () => string): string => {
          const scan = scanJournal(lastAtSeq.get(key) ?? -1);
          if (lastRead.get(key) === rev && !scan.compacted) {
            const n = (stubStreak.get(key) ?? 0) + 1;
            if (n >= 3) {
              stubStreak.set(key, 0);
              lastStep.set(key, scan.step);
              lastAtSeq.set(key, scan.lastSeq);
              return `board 未变更,但你已连续 ${n} 次重读同一块板——以下是全文(最后一次重复给出)。若这不是你要的:旧任务的板只能读;要把规划/证据带到当前任务,请 board_upsert 在当前任务 id 下落板(board_upsert 已顺手激活,下一步直接调用即可),然后停止 board_read。\n[[activate-tool:board_upsert]]\n\n` + full();
            }
            stubStreak.set(key, n);
            // 第 2 次连续存根附激活标记:实测死锁里模型的意图是「写板」而非「读板」——读缓存
            // 存根反复说「变更后自动返回全文」,而写路径工具不在清单里,写意图被约束采样掰成
            // board_read 无限循环。此处顺手点亮 board_upsert,给写意图一个合法出口。
            return n >= 2
              ? `board 未变更(上次返回于 step ${lastStep.get(key) ?? 0});内容同前,勿重读。需要变更后内容时会自动返回全文。若你要写板:board_upsert 已加入工具清单,直接调用。\n[[activate-tool:board_upsert]]`
              : `board 未变更(上次返回于 step ${lastStep.get(key) ?? 0});内容同前,勿重读。需要变更后内容时会自动返回全文。`;
          }
          stubStreak.set(key, 0);
          const text = full();
          lastRead.set(key, rev);
          lastStep.set(key, scan.step);
          lastAtSeq.set(key, scan.lastSeq);
          return text;
        };
        let tid = a.taskId ?? "";
        if (!tid && !a.all && opts.boardId) {
          // q4 缺省只读本写者自己的板——没有就如实说「还不存在」并把本会话有哪些板点名。
          // 主 agent 加 fallbackToSessionBoard:新任务 id 变了、当前任务板还没落时,先把
          // 本会话最近一块旧板作为「参考」返回,并明确要求直接 board_upsert,避免反复读板。
          // 子写者(planner scope 板)不开 fallback,防止偷读别人的板。
          if (!(await loadBoardB(root, sessionId, opts.boardId))) {
            const items = (await listBoardsExA(root, sessionId)).items;
            if (opts.fallbackToSessionBoard) {
              const latest = items.find((i) => i.taskId !== opts.boardId);
              const doc = latest ? await loadBoardB(root, sessionId, latest.taskId) : null;
              if (latest && doc) {
                return dedup(latest.taskId + "|false", String(doc.rev), () =>
                  `当前任务板 ${opts.boardId} 还不存在。以下为本会话最近板 ${latest.taskId} 的内容(来自旧任务,仅供继续参考,不计入当前任务 plan-gate):\n`
                  + renderBoardText(doc)
                  + "\n[停止重复读板] 需要沿用/重建时,直接调用 board_upsert 把同一块板落到当前任务 id(已顺手激活,下一步直接调用);不要再连续 board_read 同一块旧板。\n[[activate-tool:board_upsert]]",
                );
              }
            }
            const ids = items.map((i) => i.taskId);
            return `白板 ${opts.boardId} 还不存在(先 board_upsert 画板,已顺手激活)。\n[[activate-tool:board_upsert]]`
              + (ids.length ? `本会话现有板:${ids.join(", ")}(要看别的板请显式传 taskId,或 all:true 一起看)。` : "");
          }
          tid = opts.boardId;
        }
        if (!tid) {
          const items = (await listBoardsExA(root, sessionId)).items;
          if (!items.length) return "本会话还没有白板(设计板/页面结构板都会在这里;规划类任务应先用 board_upsert 画板)。";
          if (a.all) {
            // 显式跨看:本会话全部板逐块拼(每块点名板 id,免得混读)。
            const loaded = (await Promise.all(items
              .map(async (i) => ({ i, doc: await loadBoardB(root, sessionId, i.taskId) }))))
              .filter((x) => !!x.doc);
            // all 口径的指纹=板数 + 逐板 taskId:rev:板数参与避开「求和相等」的假命中
            // (删一块 rev 1、新增一块 rev 1 时求和同为 1),taskId 参与避开换板。
            const fp = loaded.length + ":" + loaded.map((x) => `${x.i.taskId}:${x.doc!.rev ?? 0}`).join(",");
            return dedup("|true", fp, () => loaded.map((x) => `**板 ${x.i.taskId}:**\n` + renderBoardText(x.doc!)).join("\n\n"));
          }
          tid = items[0]!.taskId; // listBoards 按 updatedAt 倒序,首项=最新
        }
        const doc = await loadBoardB(root, sessionId, tid);
        if (!doc) return `白板 ${tid} 不存在或已损坏(用 board_upsert 可重建,已顺手激活;缺省不传 taskId 读自己的板)。\n[[activate-tool:board_upsert]]`;
        return dedup(tid + "|" + (a.all === true), String(doc.rev), () => renderBoardText(doc));
      } catch (err) {
        return "白板读取失败(不影响任务): " + String(err).slice(0, 120);
      }
    },
  };
}

/** 一块板的紧凑文本(节点 id/kind/label/summary/位置/用户评论+边;board_read 单板与 all 逐块共用)。 */
function renderBoardText(doc: NonNullable<ReturnType<typeof loadBoardSync>>): string {
  const L: string[] = [];
  L.push(`白板「${doc.title}」(${doc.docKind === "page" ? "页面结构板" : "设计板"} · 状态 ${doc.status} · rev ${doc.rev} · ${doc.nodes.length} 节点/${doc.edges.length} 边)`);
  const cov = computeP0Coverage(doc);
  const covOf = new Map(cov.nodes.map((s) => [s.id, s] as const));
  if (cov.total) L.push(`P0 落目标 ${cov.passed}/${cov.total} 已通过验收(有证据 ${cov.covered}/${cov.total})`);
  // M107:过期证据提示与 audit 同源(staleSummaryOf),无 stale 时逐字不变。
  if (cov.stale.length > 0) L.push(staleSummaryOf(cov));
  for (const n of doc.nodes) {
    const pos = n.pos && isFinite(n.pos.x) ? ` @(${Math.round(n.pos.x)},${Math.round(n.pos.y)})` : "";
    const cmts = n.comments?.length ? ` [用户评论×${n.comments.length}: ${n.comments.slice(0, 3).join(" / ")}]` : "";
    const p0: P0NodeStatus | undefined = covOf.get(n.id);
    const ph = n.phase ? ` · ${n.phase}${p0 ? `(${p0.passed ? "验收通过" : p0.covered ? "有证据未通过" : "无证据"})` : ""}` : "";
    L.push(`- [${n.kind}] ${n.label}(${n.change}${n.done ? ",已落实" : ""})${ph}${pos}: ${String(n.summary).slice(0, 160)}${cmts}`);
    if (n.accept?.length) L.push(`    验收 ${n.accept.length} 条: ${n.accept.slice(0, 4).map((a) => a.cmd + (a.expect ? ` @expect「${a.expect}」` : "")).join(" | ")}`);
  }
  for (const e of doc.edges) {
    const f = doc.nodes.find((n) => n.id === e.from)?.label ?? e.from;
    const t = doc.nodes.find((n) => n.id === e.to)?.label ?? e.to;
    const kd = e.kind === "nav" ? " →跳转" : e.kind === "contains" ? " ⊃包含" : e.kind === "data" ? " →数据" : e.kind === "verify" ? " →验证" : " →调用";
    L.push(`- ${f}${kd} ${t}${e.label ? `(${e.label})` : ""}${e.virtual ? "[待核实]" : ""}`);
  }
  return L.join("\n");
}

/** teamai 团队资产 → 系统提示块(designs/24):enforced 规则全文+文化底色+规则/技能索引(渐进披露)。 */
export function renderTeamaiBlock(digest: Record<string, unknown> | null): string {
  if (!digest) return "";
  const NL = "\n";
  const parts: string[] = [];
  const meta = digest.meta as { team?: string } | undefined;
  const culture = typeof digest.culture === "string" ? digest.culture : "";
  const rules = (digest.rules ?? []) as { name: string; enforced: boolean; body: string }[];
  const skills = (digest.skills ?? []) as { ns: string; name: string; description: string }[];
  const enforced = rules.filter((r) => r.enforced);
  const loose = rules.filter((r) => !r.enforced);
  if (enforced.length === 0 && loose.length === 0 && skills.length === 0 && !culture) return "";
  parts.push("# 团队资产(teamai" + (meta?.team ? " · " + meta.team : "") + ")");
  if (culture) parts.push("## 团队文化(行事底色)" + NL + culture.slice(0, 1_200));
  if (enforced.length) {
    parts.push("## 团队强制规则(必须遵守)" + NL + enforced.map((r) => "--- " + r.name + NL + r.body.slice(0, 3_000)).join(NL));
  }
  if (loose.length) {
    parts.push("## 团队规则(索引;需要全文用 skill_view(category=\"teamai\", name=规则名))" + NL + loose.map((r) => "- rules/" + r.name).join(NL));
  }
  if (skills.length) {
    parts.push("## 团队技能(索引;需要全文用 skill_view(category=\"teamai\", name=技能名))" + NL + skills.map((sk) => "- " + sk.name + ": " + (sk.description || "").slice(0, 80)).join(NL));
  }
  return parts.join(NL).slice(0, 12_000);
}

/** skill_view 全文读取上限(字节;ZCode MAX_SKILL_BYTES=100_000)。 */
export const SKILL_VIEW_MAX_BYTES = 100_000;

/**
 * 按 UTF-8 字节截断(n7 纪律):直接用 string.slice 会按字符计数(与字节上限不符),
 * 而 Buffer.subarray(0,n).toString() 可能在多字节字符中间切断——末尾会落一个 U+FFFD 替换符。
 * 故截断后剥掉尾部所有 U+FFFD,保证模型看不到乱码。
 */
export function truncateSkillBytes(text: string, maxBytes = SKILL_VIEW_MAX_BYTES): { text: string; total: number; truncated: boolean } {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= maxBytes) return { text, total, truncated: false };
  const cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
  return { text: cut + `\n…(截断:全文 ${total} 字节,已读 ${maxBytes})`, total, truncated: true };
}

/** `${GENIE_SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` → 技能目录绝对路径(ZCode skill.ts:62-72)。
 *  无目录(内置/团队资产不在磁盘上)时原样保留,不编造路径。 */
export function expandSkillDirVars(body: string, skillDir: string | null): string {
  if (!skillDir) return body;
  return body.replace(/\$\{(GENIE_SKILL_DIR|CLAUDE_SKILL_DIR)\}/gu, skillDir);
}

/** 全文包裹形态(n7,照 ZCode handlers/skill.ts):`<skill_content name="cat/name">` + 正文 + 收尾。 */
export function wrapSkillContent(name: string, body: string, skillDir: string | null): string {
  const lines = [
    `<skill_content name="${name}">`,
    expandSkillDirVars(body, skillDir),
  ];
  if (skillDir) {
    lines.push(`Base directory for this skill: ${skillDir}`, "Relative paths in this skill are relative to this base directory.");
  }
  lines.push("</skill_content>");
  return lines.join("\n");
}

/** skill_view 工具(designs/18 §3):读经验全文,view 计数进遥测。
 *  停用门(2026-10-14 审计 C3):索引已过滤停用项,但全文读取无门——停用的内置技能
 *  仍可被 skill_view 绕过索引读全文,禁用面形同虚设。
 *  n7:三个分支(builtin/teamai/用户经验)统一走 `<skill_content name=…>` 包裹 + 变量展开 +
 *  100000 字节截断(此前 8000 字符裸 slice,长技能被腰斩且断在多字节中间)。 */
export function skillViewTool(store: ExperienceStore, disabledBuiltinsLookup?: () => string[]): Tool {
  return {
    name: "skill_view",
    description: "读一条经验/技能/板型技能的全文(索引入系统提示)。传 category 与 name;板型技能用 category=\"board\"、name=\"<type>/<stage>\"(stage=collect|draw|audit)",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "经验类目(索引里斜杠前的部分;板型技能固定 board)" },
        name: { type: "string", description: "经验名(索引里斜杠后的部分;板型技能为 code/collect 形态)" },
      },
      required: ["category", "name"],
    },
    isConcurrencySafe: () => true,
    async execute(args: unknown) {
      const a = args as { category: string; name: string };
      if (a.category === "board") {
        const parsed = parseBoardSkillName(a.name);
        if (!parsed) return `未找到板型技能 ${a.name}(用法: category="board", name="<type>/<stage>", stage=collect|draw|audit)`;
        const body = boardSkillBody(parsed.type, parsed.stage);
        if (body) return wrapSkillContent(`board/${parsed.type}/${parsed.stage}`, truncateSkillBytes(body).text, null);
        return `未找到板型技能 ${parsed.type}/${parsed.stage}`;
      }
      if (a.category === "builtin") {
        if (disabledBuiltinsLookup?.().includes(a.name)) return `内置技能 ${a.name} 已被用户停用(设置→技能可重新启用),不参与注入也不可读取`;
        const body = builtinSkillBody(a.name);
        if (body) return wrapSkillContent(`builtin/${a.name}`, truncateSkillBytes(body).text, null);
      }
      if (a.category === "teamai") {
        const digest = (globalThis as { __teamView?: { teamaiDigest(): Record<string, unknown> | null } }).__teamView?.teamaiDigest() ?? null;
        if (!digest) return "团队资产不可用(relay 未连接)";
        const name = String(a.name || "").replace(/\.md$/, "");
        const rules = (digest.rules ?? []) as { name: string; body: string }[];
        const skills = (digest.skills ?? []) as { ns: string; name: string; body: string }[];
        const rule = rules.find((r) => r.name === name);
        if (rule) return wrapSkillContent(`teamai/rules/${rule.name}`, truncateSkillBytes(rule.body).text, null);
        const skill = skills.find((sk) => sk.name === name || sk.ns + "/" + sk.name === name);
        if (skill) return wrapSkillContent(`teamai/skills/${skill.name}`, truncateSkillBytes(skill.body).text, null);
        return `未找到团队资产 ${name}(用系统提示「团队资产」节里的精确名字)`;
      }
      const fm = store.read(a.category, a.name);
      if (!fm) return `未找到经验 ${a.category}/${a.name}(请用系统提示索引里的精确名字)`;
      if (fm.status === "disabled") return `经验 ${a.category}/${a.name} 已停用(设置→技能可重新启用),不参与注入也不可读取`;
      try { store.bumpUse(a.category, a.name, "view"); } catch { /* sidecar 缺失不阻塞 */ }
      const dir = store.skillDir(a.category, a.name) ?? store.skillDir(a.category, fm.name);
      let body = store.readBody(a.category, a.name);
      // frontmatter 元信息(版本/状态/沉淀者)不进 `<skill_content>` 正文:那是给模型的操作说明,
      // 元信息放包裹尾部一行,保持正文可直接照做。
      const meta = `<!-- 元信息:v${fm.version} status=${fm.status} by=${fm.created_by === "agent" ? "agent" : "user"} -->`;
      return wrapSkillContent(`${a.category}/${fm.name}`, truncateSkillBytes(body).text + "\n" + meta, dir);
    },
  };
}

/** experience_fold 可写类目白名单(designs/18 §3「白名单内写」;distill 的 incidents 兜底同在表内)。 */
export const FOLD_CATEGORY_WHITELIST = ["coding", "ops", "tooling", "workflow", "incidents"];

/** experience_fold 工具(designs/18 §3):白名单内写,fold-in=同名覆盖更新(version+1)。 */
export function experienceFoldTool(store: ExperienceStore): Tool {
  return {
    name: "experience_fold",
    description: "沉淀/合并经验(fold-in:同 category+name 即覆盖更新)。description ≤60 字;优先合并进已有经验",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: `类目(白名单:${FOLD_CATEGORY_WHITELIST.join("/")})` },
        name: { type: "string", description: "经验名(小写连字符)" },
        description: { type: "string", description: "一句话用途 ≤60 字" },
        body: { type: "string", description: "经验全文:什么场景/怎么做/什么坑" },
      },
      required: ["category", "name", "description", "body"],
    },
    isConcurrencySafe: () => false,
    async execute(args: unknown) {
      const a = args as { category: string; name: string; description: string; body: string };
      if (!FOLD_CATEGORY_WHITELIST.includes(a.category)) {
        return `类目 ${a.category} 不在白名单 ${FOLD_CATEGORY_WHITELIST.join("/")} 内`;
      }
      if (!a.name || !a.description || !a.body) return "category/name/description/body 均必填";
      try {
        const fm = await store.write(
          { category: a.category, name: a.name, description: a.description, created_by: "agent" },
          a.body,
        );
        return `已沉淀 ${a.category}/${a.name} v${fm.version}(fold-in)`;
      } catch (err) {
        return `experience_fold 错误: ${String(err).slice(0, 200)}`;
      }
    },
  };
}

/** run_workflow 工具(designs/19):标准化任务的确定性编排(skill 不稳的替代)。 */
function runWorkflowTool(journal: import("@lampgenie/core").Journal, executor: import("@lampgenie/executors").SubagentBackend, journalSessionId: string, workflowAskRouter?: import("./workflow-ask-router.js").WorkflowAskRouter): Tool {
  return {
    name: "run_workflow",
    description: "运行标准化 workflow(测试/评审/评测等):传 template=unit-tests|functional-test|algo-eval 加 args,或直接传 script 源码(TS,facade:agent/world/report/log;world.run 白名单)",
    parameters: {
      type: "object",
      properties: {
        template: { type: "string", description: "模板名(与 script 二选一)" },
        args: { type: "string", description: "模板参数 JSON" },
        script: { type: "string", description: "workflow 脚本源码(TS)" },
      },
    },
    isConcurrencySafe: () => false,
    async execute(args: unknown) {
      const a = args as { template?: string; args?: string; script?: string };
      try {
        const source = a.script ?? renderTemplate(a.template!, a.args ? JSON.parse(a.args) : {});
        const wfId = `wf-${Date.now()}`;
        journal.append({ kind: "workflow.run.start", sessionId: journalSessionId, payload: { wfId, template: a.template ?? null } });
        const engine = new WorkflowEngine({ root: repoRoot(), journal, workflowId: wfId, executor: { ...executor, spawn: executor.spawn.bind(executor) } as never, dispatch: async (instr) => {
          // F6:面板在线先问面板(直答);超时/离线回退 executor dispatch。
          const hash = (await import("node:crypto")).createHash("sha256").update(instr).digest("hex").slice(0, 12);
          const direct = workflowAskRouter ? await workflowAskRouter.ask(wfId, "panel:" + hash, instr) : null;
          if (direct !== null) return direct;
          return new Promise<string>((resolve, reject) => {
            void executor.spawn({ taskId: wfId, instructions: instr, workdir: repoRoot(), permissions: "sandbox" }, (e) => {
              if (e.type === "result") e.result.ok ? resolve(e.result.finalText ?? "") : reject(new Error(e.result.error?.detail ?? "agent 失败"));
            }).catch(reject);
          });
        } });
        const r = await engine.run(source, 600_000);
        journal.append({ kind: "workflow.run.done", sessionId: journalSessionId, payload: { wfId, ok: r.ok } });
        return JSON.stringify({ ok: r.ok, partial: r.partial, items: r.items.slice(0, 20), logs: r.logs.slice(-10), error: r.error }).slice(0, 12_000);
      } catch (err) {
        return `run_workflow 错误: ${String(err).slice(0, 200)}`;
      }
    },
  };
}

/** code_review 工具(designs/17):确定性层必跑,LLM 深审走 models.review(未配置=确定性层 only)。
 * root=任务的项目根(项目级能力,2026-10-12):审的是该项目的工作区变更,不是 harness 仓。
 * fixG1:baseSha=本任务开工 checkpoint(既有 checkpoint.create 链)——在场且 agent 未显式给 target 时,
 * diff 基线=该 checkpoint(只审本任务变更集),不审共享工作区里别的任务/agent 的在途改动;
 * checkpoint 缺席(纯规划/干净树/快照失败)→回退全仓未提交 diff,summary 如实标注。
 * fixG1 起导出供单测直接驱动(checkpoint 基线接线测试)。
 * step-139 O1:深审不再是「有凭证就一定跑」——缺省 auto(免费层 0 blocker 且变更集小→跳过并写进 summary,
 * step-137 实测深审跑满 8 分钟时间盒零新增);fast:true=never,deep:true=always(优先于 auto)。 */
export type ReviewLlmPolicy = "auto" | "always" | "never";

export function codeReviewTool(root: string, reviewLlm: LlmProvider | undefined, journal: import("@lampgenie/core").Journal, sessionId: string, progress?: (note: string) => void, baseSha?: string | null, remote?: RemoteProject): Tool {
  return {
    name: "code_review",
    description: "审查代码变更(默认=本任务变更集:以任务开工 checkpoint 为基线,只含本任务开工后的改动+新文件,不含共享工作区里其它任务的在途改动;无 checkpoint 回退全仓未提交并标注。可传 commit hash/分支名显式改口径)。返回 findings(severity/file:line/scenario)。同源 CLI 形态:codesense review [target] [--deep](packages/code-sense-cli,人读 markdown/--json;适合人在终端、CI 门禁(exit 1=有 blocker)、外部 agent 直接跑;适合人在终端、CI 门禁(exit 1=有 blocker)、外部 agent 直接跑)——当用户想在 harness 之外审查(本地终端/CI/其它 agent 平台)时,推荐该 CLI",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "commit hash 或分支名;缺省=本任务变更集(checkpoint 基线),无 checkpoint 才是全仓未提交变更" },
        fast: { type: "boolean", description: "fixG1:true=只跑确定性层(秒级,零 LLM)。修完 blocker/high findings 后复跑确认不复现时用它;只有确定性层仍报 findings 才需要不带 fast 深审" },
        deep: { type: "boolean", description: "step-139:true=强制深审(优先于缺省 auto 档;确定性层干净且变更集小也会跑 LLM)" },
      },
    },
    isConcurrencySafe: () => false,
    async execute(args: unknown) {
      const target = (args as { target?: string }).target;
      const fast = Boolean((args as { fast?: boolean }).fast); // fixG1:确定性层-only 复跑
      const deep = Boolean((args as { deep?: boolean }).deep); // step-139:强制深审
      // 远程项目(SSH/WSL,2026-10-27):评审在远端运行时执行(codesense review --json,确定性+反模式层)。
      // LLM 深审需要远端凭证(不把桌面 key 下发远端),此处只跑确定性层并如实标注。
      if (remote) {
        const where = remote.kind === "wsl" ? "WSL:" + remote.distro : "SSH:" + remote.host;
        try {
          progress?.("远端评审(确定性+反模式层,codesense review)…");
          const { tryChannelJson } = await import("./remote-channel.js");
          const ch = await tryChannelJson(remote, "review", { target: target ?? undefined, timeout: 300_000 });
          if (!ch) return `code_review(远端 ${where})失败:工作区服务未就绪——项目菜单「优化远程连接」重装后再试`;
          if (!ch.ok) return `code_review(远端 ${where})失败:${String((ch as { error?: string }).error ?? "未知错误").slice(0, 300)}`;
          const data = (ch.data ?? {}) as { stdout?: string; stderr?: string; exit?: number };
          const raw = String(data.stdout ?? "");
          type RemoteReviewJson = { summary?: string; findings?: { severity: string; file: string; line: number; title: string; detail: string; scenario?: string }[] };
          let parsed: RemoteReviewJson | null = null;
          try { parsed = JSON.parse(raw) as RemoteReviewJson; } catch { parsed = null; }
          const note = "\n(远端评审=确定性+反模式层;LLM 深审需远端凭证,未运行)" +
            (!target && baseSha ? "\n⚠ 任务 checkpoint 基线不适用于远端评审:本次为远端未提交变更口径。" : "");
          if (parsed && Array.isArray(parsed.findings)) {
            const fs = parsed.findings;
            journal.append({
              kind: "review.findings", sessionId,
              payload: { target: target ?? null, remote: true, llmPolicy: "never", summary: parsed.summary ?? "", findings: fs.slice(0, 50) },
            });
            const head = fs.slice(0, 20).map((f) => `[${f.severity}] ${f.file}:${f.line} ${f.title} — ${f.detail}${f.scenario ? "(触发:" + f.scenario + ")" : ""}`).join("\n");
            return `[远端 ${where}] ${parsed.summary ?? ""}\n${head}${fs.length > 20 ? `\n(共 ${fs.length} 条)` : ""}${note}`;
          }
          const err = String(data.stderr ?? "").trim();
          return `[远端 ${where}] ` + (raw.trim() || err || "(无输出)") + note;
        } catch (err) {
          return `code_review(远端 ${where})错误: ${String(err).slice(0, 200)}`;
        }
      }
      // step-139 O1:三档合流——fast=never > deep=always > 缺省 auto(小且干净则跳过)。
      const policy: ReviewLlmPolicy = fast ? "never" : deep ? "always" : "auto";
      const base = target ? undefined : (baseSha ?? undefined); // 显式 target 优先,不叠加基线
      try {
        let llmCallN = 0;
        const reviewAdapter = (policy !== "never" && reviewLlm)
          ? { chat: (prompt: string) => { llmCallN++; const n = llmCallN; progress?.("深审第 " + n + " 次 LLM 调用(累计定位/确认,每轮最长数分钟)…"); return reviewLlm.chat([{ role: "user", content: prompt }], []).then((r) => ({ content: r.content })); } }
          : undefined;
        progress?.((policy === "never" ? "确定性层扫描(fast,秒级,零 LLM)"
          : reviewLlm ? (policy === "always" ? "确定性层扫描(diff/规则/反模式,秒级)→ 随后强制 LLM 深审(最多 8 分钟时间盒)" : "确定性层扫描(diff/规则/反模式,秒级)→ 干净且变更集小则跳过深审(auto,省成本)")
            : "确定性层扫描(diff/规则/反模式,秒级)")
          + (base ? `(基线=本任务 checkpoint ${base.slice(0, 10)})` : ""));
        // 2026-10-18 用户实报卡死修复:深审=多轮 LLM(rounds+grace+逐 finding 定位,可达十几次调用),
        // 每次调用空闲窗 10min——无整体上限时工具可挂 30min+(T3/T4 双任务同点卡死实锤)。
        // 时间盒 8 分钟(确定性层秒级必出;深审正常 18s~4min):超时返回确定性层 findings+如实标注。
        // step-139:auto 档的跳过判定在引擎内(免费层跑完才判),策略原样下发。
        const REVIEW_TIMEBOX_MS = 8 * 60_000;
        const run = (): Promise<Awaited<ReturnType<typeof codeReview>>> => codeReview(root, { target, llmPolicy: policy, ...(base ? { baseSha: base } : {}), ...(reviewAdapter ? { llm: reviewAdapter } : {}) });
        const r = reviewAdapter
          ? await Promise.race([
            run(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("深审时间盒 8 分钟超时(确定性层结果照常返回)")), REVIEW_TIMEBOX_MS)),
          ]).catch(async (err) => {
            if (!String(err).includes("时间盒")) throw err;
            const det = await codeReview(root, { target, ...(base ? { baseSha: base } : {}) }); // 无 llm=确定性层 only,秒级
            return { ...det, summary: det.summary + " · [深审超时未完成,以上为确定性层结果——如实标注;确定性层 0 条=验收通过状态,时间盒即终止条件,不要补跑深审]" };
          })
          : await run(); // never/无深审凭证:确定性层 only(引擎内 auto 判定,可能落跳过说明)
        // fixG1 追加(环境噪声甄别):checkpoint 缺席回退全仓时明确告知 diff 混有并行会话在途改动,
        // findings 需甄别归属——不属本任务的登记环境噪声,不修(实测修别人 findings 浪费 20 分钟)。
        const noBaseNote = (!target && !base)
          ? "\n⚠ 无 checkpoint 基线(回退全仓未提交):diff 含并行会话在途改动,findings 需甄别归属——不属本任务变更集的文件登记为「环境噪声(别会话在途改动)」,不要修。"
          : "";
        // 结构化评论卡(ZCode AssistantCodeCommentCards 移植):findings 入 journal,面板渲染行级卡。
        journal.append({
          kind: "review.findings", sessionId,
          payload: { target: target ?? null, ...(base ? { baseSha: base } : {}), ...(fast ? { fast: true } : {}), llmPolicy: policy, summary: r.summary, findings: r.findings.slice(0, 50) },
        });
        const head = r.findings.slice(0, 20).map((f: { severity: string; file: string; line: number; title: string; detail: string; scenario?: string }) => `[${f.severity}] ${f.file}:${f.line} ${f.title} — ${f.detail}${f.scenario ? "(触发:" + f.scenario + ")" : ""}`).join("\n");
        return `${r.summary}\n${head}${r.findings.length > 20 ? `\n(共 ${r.findings.length} 条)` : ""}${noBaseNote}`;
      } catch (err) {
        return `code_review 错误: ${String(err).slice(0, 200)}`;
      }
    },
  };
}

/** soul 行为纪律剥离(step-048 审计修复②):去掉首段「你是…」身份行,只留行为纪律——
 * vibe coding 轨身份以 SYSTEM 为唯一声明(refs:身份唯一),soul 的纪律仍有益故继承。 */
export function soulDisciplinesFor(soulText: string): string {
  const t = soulText.replace(/\r\n/g, "\n").trim();
  const idx = t.indexOf("\n\n");
  const head = idx === -1 ? t : t.slice(0, idx);
  if (/^你是/.test(head)) return (idx === -1 ? "" : t.slice(idx + 2)).trim();
  return t;
}

/** 任务书符号提取(step-034 F3):驼峰/下划线/Pascal 形态≥4 字符,排除中文与停用词。 */
export function firstSymbolLike(text: string): string | null {
  const STOP = new Set(["true", "false", "null", "undefined", "this", "self", "test", "spec", "index", "main", "utils", "types", "node", "json", "http", "readme"]);
  const m = text.match(/\b[a-zA-Z][a-zA-Z0-9]*(?:[A-Z_][a-zA-Z0-9]*){1,}\b/g) ?? [];
  const cand = m.filter((w) => w.length >= 4 && !STOP.has(w.toLowerCase()));
  return cand[0] ?? null;
}

// ---- 任务类别(2026-10-23 用户口径:理解阶段定类,tips/plan-gate 全消费同一结果)----
export type TaskClass = "coding" | "office" | "qa";

/**
 * 任务类别初判(纯启发式,开工即出;agent 在 understand 阶段用 task_phase(taskClass=...) 更正,
 * 更正即刻生效:纪律卡/系统提示已注入的不可变,但 plan-gate/每10步锚/后续轮次按新类走)。
 * 保守缺省 coding——主形态,错判代价不对称:QA/办公任务多看几条编码纪律只是 token 负担,
 * 编码任务丢了 plan-gate/验收纪律才是真损失。写代码信号优先级最高(复合指令「修 bug 顺便
 * 出个表格」必须落 coding)。
 */
export function classifyTaskClass(instruction: string): TaskClass {
  const t = instruction.toLowerCase();
  // 交付物锚(2026-11-04 上线观测实锚):「调研…写一篇《事故复盘》技术文章,讲清修复设计与
  // 排障过程」被判 coding——文章交付词「写一篇」不在 office 词表,内容词「修复/排障」把 coding
  // 判定抢先触发。「篇」量词锚定的交付物无歧义(代码功能绝不用「篇」计),故置于 coding 判定
  // **之前**:「写代码信号优先」原则针对「修 bug 顺手出文档」(交付物是代码),不针对「文章本体
  // 是交付物、代码只是题材」(复盘/调研/技术文章)。误判双向都有逃生:类更正机制
  // task_phase(taskClass=…) 对 office→coding / coding→office 都即时生效。
  if (/(写|出|整理|润色|排版)一篇|一篇.{0,8}(文章|复盘|报告|笔记|总结)/.test(t)) return "office";
  // 写代码信号(含代码符号/测试/debug/重构/接口等)→ coding;缺省也走这里
  if (/(修改|修复|实现|新增|重构|删除|添加|接入|适配|升级|编写|写代码|写测试|加测试|修一下|改一下|改掉|重构掉|fix|refactor|implement|debug|调试|排障|报错|bug|异常|crash|编译|部署|函数|变量|组件|单元测试)/.test(t)
    || firstSymbolLike(instruction)) return "coding";
  // 办公/产出物信号(PPT/表格/文档/翻译等非代码交付)→ office
  // 2026-10-24 实测补词:整理一份/列一份/建一份/出一份/速查/清单(此前「整理一份」≠词表
  // 「写一份」,办公任务落缺省 coding 交满仪式税)。「写个/做个」曾试加即误吞「做个小功能」
  // (编码任务)——过泛已移除,泛动词不进词表。
  if (/(ppt|幻灯|slides?|演示文稿|xlsx|excel|表格|word|docx|简历|海报|翻译|排版|思维导图|写一份|做一份|生成一份|整理一份|列一份|建一份|出一份|速查|清单|整理成文档|汇报材料|周报|月报|总结报告|邮件)/.test(t)) return "office";
  // 问答/调研信号(问句/调查动词且无写代码意图;含英文问句词)。2026-10-24 实测修正:问号出现
  // 即算(不再锚句尾——「。」结尾的问句让 $ 锚全部失配);补词 哪个/哪几/多少/几步/是不是。
  if (/(是什么|为什么|怎么回事|怎么理解|干什么|干啥|如何|哪些|哪个|哪几|哪里|多少|几步|有没有|能不能|是不是|区别|看看|查一下|调研|梳理|分析一下|解释|介绍|告诉我|找找|检查一下|评估|确认一下)|\b(what|why|how|where|which|explain)\b|[??]/.test(t)) return "qa";
  return "coding";
}

/**
 * 类别更正为 coding 时的纪律补发(2026-10-23 P1-1):qa/office 任务的系统提示/纪律卡不含编码
 * 纪律,更正只武装 plan-gate 会造成「被拦却没见过规则」——规则与执法必须同时到场,全文随
 * task_phase 回执一次性送达(短句形态,与 kickoff 纪律卡同源)。
 */
const CODING_DISCIPLINE_REFILL = [
  "- 五阶段流程:理解任务→规划→开始实施→开始验收→完成——每进入一阶段用 task_phase 声明(不涉及的用 skip:true);**阶段声明与其他工具同一步发出即可(task_phase 可与真实工作并行),不要为它单独走一步**;只做当前阶段该做的事",
  "- plan-gate 硬闸:白板上没有设计节点前,派写角色子代理/直写文件都会被拒——先规划落板(planner 或内联轻量板)",
  "- 影响面纪律:改既有函数前必先用 code_sense 拿影响面,按清单同步调用方与测试",
  "- 完工验收四步(汇报完成前必走):①用 code_sense 复核影响面;②code_review 审本任务变更集(blocker/high 必修);③相关测试定向跑,报告带条件/通过标准/实际结果三要素;④board_upsert action=audit 核对 P0 覆盖率",
  "- 输出简明:结论先行、证据跟后;收尾前 P0 验收证据全绿才可宣称完成",
].join("\n");

// ---- 扫描根预算闸(2026-10-21 立;2026-10-30 独立成 sense-root-gate.ts 并接全自动路径:超预算根
// 一律不扫不建,工作区根给子仓收窄出路。re-export 保既有 import 面(sense-tool/测试)。 ----
export { rootScanVerdict, detectWorkspaceRepos, refineRootForTarget, renderWorkspaceRepos, workspaceRefusalText, type RootScanVerdict, type WorkspaceRepo } from "./sense-root-gate.js";
import { rootScanVerdict } from "./sense-root-gate.js"; // 本文件 warmIndex 闸消费(2997)

// (2026-10-23)开工 orient 注入链已整体删除:orientWithSense/symbolsInText/orient-cache 系列
// (scanFingerprint/orientCacheKey/readOrientCache/warmOrientCache)。用户口径:每条 user message
// 跟一条「全局代码+历史匹配」tips 多余且常错配——code_sense 内容必须是拉取式(call 工具才返回);
// 索引预热由任务开工的 warmIndex(火忘后台)独立承担,首次工具调用不吃冷启动。
// 遗留磁盘缓存 .genie/orient-cache-*.json 成为死文件,可手删(不再有读写方)。

/** step-089 P3:「项目主线」注入块(项目底座认知,防开发偏离主线)。
 * 委托 projectMainlineBlock(读 .genie/sense-index/profile.json;缺席=空串零注入零开销;
 * 生产者=codesense project --write;预算 ≤300 字符内部截断)。失败静默(增强件不阻塞任务)。 */
function projectMainlineBlockOf(taskRoot: string): string {
  try {
    return projectMainlineBlock(taskRoot);
  } catch {
    return "";
  }
}

/** 子代理任务书的涉事符号上下文(step-034 F3;2026-10-12 三改收敛:读静态索引,毫秒级)。
 * 无符号/查询失败返回空串。**硬预算不阻塞派发**(2026-10-20 实锤:索引缺失时旧实现会等
 * 冷构建 7+ 分钟,10 路子代理一起堵住再同时放行 → 建连洪峰 + 8 路 fetch failed)。
 * GENIE_SYMBOL_CONTEXT_BUDGET_MS 可调,缺省 2000ms;超预算按「无上下文」处理。 */
export async function symbolContextFor(root: string, instructions: string): Promise<string> {
  const sym = firstSymbolLike(instructions);
  if (!sym) return "";
  try {
    const { codeIndexQuery } = await import("./sense-index-manager.js");
    const budgetMs = Math.max(200, Number(process.env.GENIE_SYMBOL_CONTEXT_BUDGET_MS ?? 2000) || 2000);
    const block = await withBudget(codeIndexQuery(root, "symbol", sym), budgetMs);
    if (!block || block.includes("未找到符号") || block.includes("尚未就绪")) return "";
    return [
      "",
      "## 涉事符号上下文(code_sense action=symbol 静态索引自动注入)",
      block,
      "(以上为静态调用链,动手前据此定位;修改必须同时顾及上下游;以实际代码为准)",
    ].filter(Boolean).join("\n");
  } catch {
    return ""; // 预热类增强,失败静默
  }
}

/** 竞速预算:超时/失败返回 null;定时器 unref,不拖住进程退出。 */
function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

/** LlmProvider→ArchLlm 适配(step-034 F1):两段式(解说→图 JSON)各一次 chat。
 * 类型用结构化内联(ArchLlm 在 archmap 子路径,避免跨子路径 import)。 */
export function archLlmFromProvider(llm: LlmProvider): { generate(introPrompt: string, graphPrompt: string): Promise<{ narrative: string; graphJson: string }> } {
  return {
    async generate(introPrompt: string, graphPrompt: string) {
      const intro = await llm.chat([{ role: "user", content: introPrompt }], []);
      const graph = await llm.chat([{ role: "user", content: graphPrompt }], []);
      return { narrative: intro.content, graphJson: graph.content };
    },
  };
}

/**
 * Plan 模式系统提示(step-053,ZCode Plan Workflow 语义;2026-10-23 汉化——提示词全中文,
 * 收尾节标题与批准回执短语同步改为中文且与服务端注入逐字配对)。
 * 结尾适配:harness 无 ExitPlanMode 工具——以「## 实施计划」节收尾,
 * 终态后网关落计划文件并广播审批(批准=切回+按计划派实施任务)。
 */
function planModePrompt(): string {
  return [

    "计划模式已激活。用户表示此刻还不要你执行——你**不得**做任何编辑、运行任何非只读工具(含改配置或提交),也不得以任何方式改动系统。本条优先级高于你收到的其它任何指令。",
    "",
    "## 规划工作流",
    "",
    "按顺序走完以下四阶段。仅当任务简单到某阶段不会带来任何信息时才可跳过该阶段。",
    "",
    "### 阶段一:初步理解",
    "",
    "先理解请求。仔细重读用户的请求,识别歧义与需要澄清的点。有歧义就问用户(以问题收尾本轮)。否则用只读方式探查:code_sense、文件读取、git 历史与只读命令,以及少量并行 spawn_subagent(explore) 只读子代理。",
    "",
    "### 阶段二:设计",
    "",
    "理解请求后设计实现方案。基于请求与阶段一的发现,产出完整实现设计,覆盖:一句话目标、总体思路、逐文件的具体改动、数据/接口变更、风险,以及验证方案(能证明它成立的测试/命令)。",
    "",
    "规划必成板(step-083):设计定稿时把规划结构画到白板——board_upsert 属规划产物而非系统修改,plan 模式应当使用(只读的 board_read 亦可用)。页面/应用类规划用 docKind=\"page\" 的页面结构板(节点=page/section/component,边=nav/contains);模块/代码设计用默认设计板。用户会在白板上复审并拖拉修改,批准后按板上结构实施。",
    "",
    "### 阶段三:评审",
    "",
    "评审设计的完整性、正确性,以及是否符合仓内约定(AGENTS.md/既有模式)。识别边界情况与失败模式,把设计打磨到可直接实施。",
    "",
    "### 阶段四:呈现计划",
    "",
    "以一节标题为「## 实施计划」的章节收尾本轮,包含完整计划(目标/逐文件改动/风险/验证)。网关会把它写入计划文件并请用户审批;批准后用户会以「用户已批准你的计划」回归,届时再实施。计划模式里**不要**开始实施。",
  ].join("\n");
}

/** 计划文件注入(step-053,ZCode plan_file_reference 附件语义):存在即随系统提示带回。 */
/** 计划文件注入(step-053;导出=审计/测试可探针)。 */
export async function planFileBlockFor(sessionId: string): Promise<string> {
  try {
    // ESM 安全(C19① 修复:裸 require 在 tsx-ESM 下 undefined→曾整段静默死代码);
    // createRequire 以本文件为基准解析相对引用(./repo-root.js)。
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const { readFileSync } = req("node:fs");
    const { join } = req("node:path");
    const { repoRoot: rr } = req("./repo-root.js");
    const file = join(rr(), ".genie", "plans", `plan-${sessionId}.md`);
    const content = readFileSync(file, "utf-8");
    return `\n\n计划模式留有一份计划文件:${file}\n计划内容:\n\n${content}\n\n若该计划与当前工作相关且尚未完成,继续推进它。`;
  } catch {
    return "";
  }
}

// =============================================================================
// 附件注入(step-048;附件通道 2026:图片/视频贴进聊天窗 → 任务书如实标注)
// =============================================================================
/** 视觉通道限额:单张 2MB、单轮 4 张。三处消费端硬编码 slice(0,4)(openai-provider.ts:100、
 * provider-apitypes.ts:393/…)、单张体积直通请求体——放宽会让请求体爆炸,不放松。 */
export const VISION_MAX_BYTES = 2 * 1024 * 1024;
export const VISION_MAX_IMAGES = 4;
/** 视觉通道 mime 白名单:运行时是 data URL 原样透传(anthropic 走 media_type=image/*、
 * openai 走 image_url.data:image/*),协议侧真正能被吃的就是这四种(png/jpeg/gif/webp)。
 * svg 明确排除(SVG 可带脚本,进视觉通道不安全);bmp/tiff/heic 等不在白名单=按普通附件走路径。
 * 注:不列 image/jpg——normalizeAttachmentMime 已把它归一为 image/jpeg,列了也永不命中(review nit)。 */
export const VISION_IMAGE_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** 扩展名兜底(浏览器拖拽/剪贴板偶尔给空 File.type,不给兜底会静默退化成「文本附件」)。 */
const IMAGE_EXT_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const VIDEO_EXT = new Set(["mp4", "m4v", "mov", "webm", "mkv", "avi", "mpg", "mpeg", "wmv"]);
/** 视为「mime 缺失」的通用值(此时按扩展名兜底)。 */
const GENERIC_MIMES = new Set(["", "application/octet-stream", "binary/octet-stream"]);
/** 纯文本类扩展名(2026-10-29 附件链路):doc-text 的 DOC_PARSE_EXT 也包含它们,但在**附件分类**语境
 * 里它们是文本类(other,走原「read_attachment 可读」文案),不能升级成 doc——否则模型会被引导去
 * 「解析」一个本来就是纯文本的文件(注:read_attachment 走 doc 分支时二者都能读,差别只在提示语义)。 */
const TEXT_LIKE_EXT: ReadonlySet<string> = new Set([
  "md", "markdown", "txt", "log", "json", "jsonc", "csv", "tsv", "html", "htm", "xml",
  "yaml", "yml", "ini", "toml", "conf", "sh", "sql", "css", "js", "ts", "py", "go", "rs", "java",
]);
/** 可传进会话但 doc-text 暂无解码器的文档后缀(老式 OLE / ODF / 电子书 / 压缩包):**仍归 doc**,
 * 由 read_attachment 走解析器如实报「不支持解析的类型:xxx」。若落 other,会被标成「read_attachment 可读」,
 * 随后 isBinaryLikeMime(通用 mime)=false → readFileSync 后 utf8 硬解 = 100KB 乱码(2026-10-30 review 修)。
 * 与 panel 的 ATT_DOC_EXT / DOC_EXT 同源(那边放行到 64MB,这边判型必须同步)。 */
const DOC_EXT_NO_DECODER: ReadonlySet<string> = new Set([
  "doc", "xls", "ppt", "odt", "ods", "odp", "epub",
  "tar", "gz", "tgz", "7z", "rar", "pages", "numbers", "key",
]);
/** 文档类 mime 白名单(2026-10-29 附件链路):命中=可选可解析文档,走 read_attachment 解析为纯文本。
 * 含 pdf/压缩包/电子书 + 三个 OOXML(docx/pptx/xlsx) + 三个老式 OLE(doc/xls/ppt);rtf 是文本但按文档类列。
 * 注意:.md/.txt/.html/.csv 等**不在此列**——它们是纯文本,继续走「read_attachment 可读」原路径。 */
const DOC_MIMES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/epub+zip",
  "application/rtf",
  "text/rtf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/** mime 归一:小写、去参数(image/png;charset=utf-8 → image/png)、image/jpg→image/jpeg(Anthropic
 * 只认 image/jpeg,原样透传会 400)。 */
function normalizeAttachmentMime(mime?: string): string {
  const m = String(mime ?? "").trim().toLowerCase().split(";")[0]!.trim();
  return m === "image/jpg" ? "image/jpeg" : m;
}

function attachmentExt(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(String(name ?? "").trim());
  return m ? m[1]!.toLowerCase() : "";
}

/** 附件类别(纯函数,可测):image(进视觉通道候选)/ video(显式告知模型看不到)/
 * doc(文档类:read_attachment 解析为纯文本)/ other(路径+read_attachment 按 utf8 读)。
 * 判定顺序:mime 为准(image/* 白名单,video/* 直判)→ mime 缺失/通用值(octet-stream)时按扩展名兜底
 * (放宽带:旧行为下空 mime 的 .png 会被当文本附件,模型看不到图;浏览器给 .docx 的 type 也常空/octet-stream,
 * 故 doc 判定必须同时吃扩展名)→ 文档 mime 白名单 → other。svg/未知 image 子类型→other。
 * 注:isDocExt 同时认得 .md/.txt 等文本扩展名,但这些要先排除(它们走文本类,不能变 doc)。 */
export function classifyAttachment(name: string, mime?: string): "image" | "video" | "doc" | "other" {
  const m = normalizeAttachmentMime(mime);
  if (m.startsWith("image/")) return VISION_IMAGE_MIMES.has(m) ? "image" : "other";
  if (m.startsWith("video/")) return "video";
  const ext = attachmentExt(name);
  if (m.startsWith("text/") && m !== "text/rtf") return "other"; // 纯文本类(含 .md/.txt/.html/.csv)不升级为 doc
  if (ext && isDocExt(ext) && !TEXT_LIKE_EXT.has(ext)) {
    // 扩展名命中文档解析器:通用/空 mime 时是唯一线索;mime 指向别处时仍按扩展名判 doc
    // (解析器最终以扩展名选解码器,故扩展名才是真相)。
    return "doc";
  }
  if (DOC_MIMES.has(m)) return "doc";
  if (ext && DOC_EXT_NO_DECODER.has(ext) && GENERIC_MIMES.has(m)) return "doc"; // 无解码器的不透明容器:交解析器如实报「不支持」
  if (!GENERIC_MIMES.has(m)) return "other"; // 非空且非 image/video/doc:以 mime 为准,不猜扩展名
  if (IMAGE_EXT_MIME[ext]) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return "other";
}

/** 进视觉通道时 data URL 用的 mime(白名单命中=mime 本身;扩展名兜底=扩展名对应 mime)。 */
function effectiveImageMime(name: string, mime?: string): string {
  const m = normalizeAttachmentMime(mime);
  if (VISION_IMAGE_MIMES.has(m)) return m;
  // classifyAttachment 判 image 时必有一条命中(白名单或扩展名兜底),此处的 image/png 兜底
  // 只为类型完整性(idx 可能 undefined),正常路径不可达(review nit 已标注)。
  return IMAGE_EXT_MIME[attachmentExt(name)] ?? "image/png";
}

/** 二进制 mime 门槛(read_attachment 只服务文本类):audio/video/image(除 svg 文本外)/字体/pdf/压缩包
 * 等一律拒解码——utf-8 硬转只会吐乱码。mime 缺失时不拦(沿用旧行为:按文本尽力读)。 */
export function isBinaryLikeMime(mime?: string): boolean {
  const m = normalizeAttachmentMime(mime);
  if (!m) return false;
  if (m === "image/svg+xml" || m === "image/svg") return false; // SVG 是文本(源码可读),不算二进制
  if (m.startsWith("image/") || m.startsWith("audio/") || m.startsWith("video/") || m.startsWith("font/")) return true;
  return [
    "application/pdf",
    "application/zip",
    "application/gzip",
    "application/wasm",
    "application/x-tar",
    "application/x-7z-compressed",
    "application/x-rar-compressed",
    "application/x-bzip2",
    "application/vnd.ms-fontobject",
  ].includes(m);
}

function fmtMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export interface AttachmentLike { name: string; path: string; mime?: string; size?: number }
export interface AttachmentInjection {
  /** 注入任务书的「## 附件」块(无附件=空串)。 */
  block: string;
  /** 视觉通道 data URL(仅 png/jpeg/gif/webp 且 ≤2MB 且 ≤4 张)。 */
  visionImages: string[];
}

/** 附件 → 任务书「## 附件」块 + 视觉通道 data URL(纯函数:readFile 注入,便于单测)。
 * 如实标注三种「没进通道」的原因,且互不混淆:
 * ① 单张超 2MB;② 视觉通道已达 4 张上限;③ 视频(模型不接收视频内容)。 */
export function buildAttachmentInjection(
  attachments: AttachmentLike[] | undefined,
  readFile: (path: string) => Uint8Array,
  opts: {
    maxBytes?: number;
    maxImages?: number;
    maxListed?: number;
    /** 体积探测(生产传 statSync().size,不必把大文件读进内存;缺省=读长度,便于单测注入)。 */
    sizeOf?: (path: string) => number;
  } = {},
): AttachmentInjection {
  const maxBytes = opts.maxBytes ?? VISION_MAX_BYTES;
  const maxImages = opts.maxImages ?? VISION_MAX_IMAGES;
  const maxListed = opts.maxListed ?? 8;
  const sizeOf = opts.sizeOf ?? ((p: string) => readFile(p).length);
  const lines: string[] = [];
  const visionImages: string[] = [];
  const allAtts = attachments ?? [];
  const listed = allAtts.slice(0, maxListed);
  for (const att of listed) {
    const kind = classifyAttachment(att.name, att.mime);
    if (kind === "image") {
      let size: number;
      try {
        size = sizeOf(att.path);
      } catch {
        lines.push("- [图片附件读取失败] " + att.name);
        continue;
      }
      if (size > maxBytes) {
        lines.push("- [图片附件] " + att.name + "(" + fmtMB(size) + "MB 超单张上限 " + fmtMB(maxBytes) + "MB,未进视觉通道;路径 " + att.path + ")");
        continue;
      }
      if (visionImages.length >= maxImages) {
        lines.push("- [图片附件] " + att.name + "(已达视觉通道上限 " + maxImages + " 张,本张未进;需要看时用 view_image " + att.path + ")");
        continue;
      }
      let buf: Uint8Array;
      try {
        buf = readFile(att.path);
      } catch {
        lines.push("- [图片附件读取失败] " + att.name);
        continue;
      }
      // 尺寸守卫(2026-11-05):与 view_image 同源判定——超限图不进视觉通道(否则整轮请求永久 400)。
      // 解析失败(null)=放行,不因解析器盲区拦正常图。
      const dims = readImageSize(buf.subarray(0, Math.min(buf.length, 48 * 1024)));
      const verdict = checkImageSize(dims, att.name);
      if (!verdict.ok) {
        lines.push("- [图片附件] " + verdict.reason.replace(/^\[图片超限\] /, "") + "(未进视觉通道;路径 " + att.path + ")");
        continue;
      }
      visionImages.push("data:" + effectiveImageMime(att.name, att.mime) + ";base64," + Buffer.from(buf).toString("base64"));
      // 告知 view_image 是回看正道,避免模型后续「想再看但找不到图」又退化成代码占位。
      lines.push("- [图片附件] " + att.name + "(已进视觉通道;后续需要再看用 view_image " + att.path + ")");
      continue;
    }
    if (kind === "video") {
      // 视频不进通道,体积只作提示:优先任务书 size,其次 stat(不读内容)
      let bytes = typeof att.size === "number" && att.size > 0 ? att.size : 0;
      if (!bytes) {
        try {
          bytes = sizeOf(att.path);
        } catch {
          bytes = 0; // 读不到=「大小未知」(不影响归属文案)
        }
      }
      lines.push("- [视频附件] " + att.name + "(" + (bytes ? fmtMB(bytes) + "MB" : "大小未知") + ",路径 " + att.path + ")——本地已预览;模型不接收视频内容,如需分析请先转帧/截图或提供关键帧图片");
      continue;
    }
    if (kind === "doc") {
      // 2026-10-29 附件链路:文档类只给「去解析」的指路,**注入阶段不解析**——注入每轮都跑,
      // 解析一个 64MB 文档会把主链路拖死;真正解析发生在 read_attachment 被调用时(doc-text.ts)。
      // 体积优先用任务书 size,其次 stat(不读内容),读不到=「大小未知」(与视频分支同口径)。
      let bytes = typeof att.size === "number" && att.size > 0 ? att.size : 0;
      if (!bytes) {
        try {
          bytes = sizeOf(att.path);
        } catch {
          bytes = 0; // 读不到=「大小未知」,不影响归属文案
        }
      }
      const meta = att.mime ? att.mime : (bytes ? fmtMB(bytes) + "MB" : "大小未知");
      lines.push("- [文档附件] " + att.name + "(" + meta + ")→ " + att.path + "——用 read_attachment 读取解析后的正文;解析失败会返回原因");
      continue;
    }
    // 长粘贴临时文件(pasted-text-*.txt):只给路径不内联——正文本来就从输入框转存出来的,
    // 再塞回上下文等于把刚剥离的长文本原样打回,还会挤爆窗口;需要时让模型自己 read_attachment 取。
    if (/^pasted-text-/i.test(att.name || "")) {
      lines.push("- [粘贴长文本] " + att.name + " → " + att.path + "(正文未内联,需要时用 read_attachment " + att.path + " 读取)");
      continue;
    }
    // step-134(review):二进制类(pdf/zip/字体/音视频/未知 image 子类型)也走 other——
    // 别统一标「read_attachment 可读」:read_attachment 有 isBinaryLikeMime 门槛会拒解码,
    // 提示与工具语义必须一致,否则模型白调一轮工具才失败。
    // 2026-10-25:白名单图片(png/jpeg/gif/webp)有了主动查看通道 view_image——
    // 旧文案曾指向一个并不存在的「对应工具」,模型只能用代码打印像素占位(2026-10-29 已彻底删除该措辞)。
    const m = normalizeAttachmentMime(att.mime);
    const visionHint = m.startsWith("image/") && VISION_IMAGE_MIMES.has(m)
      ? "(白名单图片,可用 view_image 查看内容)"
      : "(二进制,read_attachment 只能按文本读;" + (m.startsWith("image/") ? "非白名单图片格式,view_image 亦不支持" : "二进制内容需先转换") + ")";
    lines.push(
      isBinaryLikeMime(att.mime)
        ? "- " + att.name + " → " + att.path + (att.mime ? "(" + att.mime + ")" : "") + visionHint
        : "- " + att.name + " → " + att.path + (att.mime ? "(" + att.mime + ")" : "") + "(read_attachment 可读)",
    );
  }
  // review nit:超出 maxListed 的附件此前被静默丢弃——与本函数「如实标注」口径不符,补一行显式提示。
  if (allAtts.length > listed.length) {
    lines.push("- [另有 " + (allAtts.length - listed.length) + " 个附件未列入本节(单轮最多列 " + maxListed + " 个);如需处理请单独说明]");
  }
  return { block: lines.length ? "\n\n## 附件\n" + lines.join("\n") : "", visionImages };
}

/** 请求实际 max_tokens 读数(step-139 O4):provider.describe().maxTokens;无该面=undefined
 * (压缩钩子按 ZCode 口径回退 32000)。 */
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
  // 2026-11-06 按 14 天复盘调数(docs/analysis/planner-reaper-review.md):正常完成组 p50=5.0/p90=9.2 分钟,
  // 19.2%(19/99)超 8 分钟——缺省 8 对约 1/5 正常任务偏紧,抬到 10 覆盖 p90;时间锚纪律同批进 PLANNER_PROMPT。
  if (plannerN === undefined) return 10;
  const n = Number(plannerN);
  return Number.isFinite(n) ? Math.max(0, n) : 10;
}

/** 轨迹卡子目标(J1 轨迹卡,2026-11 token 轮):给 `task.trajectory` 的 subgoal 取一行短文本。
 *  取数口径(优先级从高到低):
 *  ① journal 该 session 最近一条 `todo.updated` 里第一个未完成项(in_progress/pending)的 content;
 *  ② 没有计划(或最近一条计划已全完成)→ 退化为任务书首句:instruction 压平换行取前 40 字;
 *  ③ 都没有 → ""。
 *  这是**旁路元数据**:任何读取/解析异常一律兜底成 ""——轨迹元数据故障绝不打断主链。 */
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

/** M162 开工信封闸用到的 journal 最小面(真 Journal 也满足;测试可传假 journal)。 */
export interface EnvelopeStartJournal {
  append(e: { kind: "custom"; sessionId: string; payload: Record<string, unknown> }): unknown;
  readSession(sessionId: string): readonly { kind?: string; payload?: unknown }[];
}

function failTaskForEnvelope(
  deps: { taskManager: Pick<TaskSupervisor, "get" | "setState">; task: Task },
  reason: string,
): void {
  const cur = deps.taskManager.get(deps.task.id) ?? deps.task;
  // 只有 queued/running 能迁到 failed(blocked 的合法出口不含 failed;状态机不允许就跳过,靠 journal 留证)
  if (cur.state !== "queued" && cur.state !== "running") return;
  try { deps.taskManager.setState(cur, "failed", reason); } catch { /* 状态已被别处改走=不覆盖 */ }
}

/**
 * M162 开工前信封校验:取该 task 最近一条 task.envelope.issued → verify(当前能力目录/策略)。
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
  projects?: import("./projects.js").ProjectRegistry,
  permissionBroker?: import("./permission-broker.js").PermissionBroker,
  workflowAskRouter?: import("./workflow-ask-router.js").WorkflowAskRouter,
  /** ask_user 面板问答路由(2026-10-19 许愿式编程;缺省=不注册该工具)。 */
  askUser?: import("./ask-user-router.js").AskUserRouter,
  /** MCP 管理器(step-047):启用服务器的工具并入主 agent 工具面。 */
  mcp?: { allToolsForAgent(): Promise<{ serverId: string; serverName: string; name: string; description: string }[]>; callTool(serverId: string, tool: string, args: unknown): Promise<string> },
  browserConfig?: { enabled: () => boolean; allowDomains: () => string[]; idleMinutes?: () => number; profile?: () => "persistent" | "ephemeral"; profileDir?: () => string; headless?: () => boolean },
  /** 流式出口(step-050,ZCode 流式消息展示):loop onStream 旁路→relay→WS stream 广播;不落 journal。 */
  streamSink?: (sessionId: string, ev: AgentStreamEvent) => void,
  /** 记忆接线(step-029 收口):系统提示注入记忆上下文块+会话终态学习。 */
  memory?: { contextBlock(ownerId: string): string; onSessionClose(input: { ownerId: string; sessionId: string; transcript: { role: "user" | "assistant"; content: string }[] }): Promise<void> },
  /** 辅助链专用轨(step-052 F2):archLlm 架构导读/压缩等辅助调用不走 realtime 主轨(会话贵且易卡),
   * 缺省回退主轨(行为与旧版一致)。 */
  auxLlm?: LlmProvider,
  /** 任务配置对象(设置页 agent.maxSteps 热读:每任务取当前值,cfg.set 下个任务生效;
   * agent.compactThresholdTokens=未声明窗口时的显式压缩阈值,step-058;
   * agent.subagentDeadlineMin=子代理缺省时间盒(分钟)+agent.subagentStaleWarnMin=无产出预警阈值(2026-10-15 机制1/3);
   * agent.writeBarrier=写前持久化屏障("off"|"hard";缺席=loop 内部 hard 现状;经 writeBarrierOf 取值,不读 env);
   * coding.lsp=编辑后 LSP 诊断+保存格式化(step-114;运行时对象经 zod 解析,缺省 on))。 */
  agentConfig?: { agent?: { maxSteps?: number; compactThresholdTokens?: number; subagentDeadlineMin?: number; plannerDeadlineMin?: number; subagentStaleWarnMin?: number; todoAllowParallelInProgress?: boolean; verifyOnStop?: string; writeBarrier?: "off" | "hard" }; coding?: { lsp?: import("@lampgenie/lsp").LspSettings; llm?: { vision?: boolean }; vlm?: { baseUrl?: string; providerId?: string; model?: string; apiKeyEnv?: string; timeoutMs?: number; maxTokens?: number } } },
  /** 主模型上下文窗口 tokens(step-048:容量看板分母+到阈自动 /compact)。 */
  contextWindow?: number,
  /** per-session 主模型覆盖面(缺省=无覆盖,共享 llm 现状零变化)。 */
  sessionModels?: SessionModelFace,
  /** M162 执行信封:装配方注入当前能力目录/策略(缺省=本任务实际工具面名+内置命令名 / permissionMode+agent.maxSteps)。 */
  envelopeDeps?: EnvelopeDeps,
): void {
  // archLlm 生产注入(step-034 F1):plan 剖面在产线出真架构图(此前零注入恒静态降级)。
  // 装配期一次,全进程生效;step-052 起优先走 aux 轨(每任务两次 LLM 调用,realtime 轨下纯属占会话)。
  setPlanDeps({ archLlm: archLlmFromProvider(auxLlm ?? llm) });
  // 取消信号注册表(step-008 收口,designs/14 §1.4):task.cancel 落 state=cancelled 时
  // abort 对应 AgentLoop 的 LLM 请求与工具执行(此前 loop.cancel() 零调用方=取消只改状态不中断执行)。
  const activeLoops = new Map<string, AgentLoop>();
  /** 正在起 loop 的任务(在 activeLoops.set 之前有一段异步窗口)。touch 进度会 emit task 事件 →
   *  下面的监听器会再看到 state=running,若不挡就会给同一任务起第二个 loop(双跑互相截断 turn)。 */
  const startingLoops = new Set<string>();
  taskManager.onChange((task: Task) => {
    if (task.state === "cancelled") {
      // M34(2026-11-07):先落「用户已停止」标记再 abort——取消是用户意图,标记落账失败只告警,
      // 绝不让它改变取消结果(appendUserStoppedMarker 内部 try/catch + warn)。
      // 只在**真有活跃 loop 被中断**时落标记:resumeInterrupted 把原任务收口成 cancelled
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
    // M180 会话权限钉扎:任务开工把**当时的全局预设**落成本会话快照(pinSession 幂等,已有 pin 不重写)。
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
 * goal 续跑循环单步(step-053):任务终态后调用。
 * ZCode 语义:校验器裁决 goal 是否达成——passed→状态 complete(终);未通过→nextAction 成
 * 下一轮续跑任务标题与指引;校验器失败/坏 JSON=fail-open(passed,防无限循环);预算
 * (token/时间)超限→budget_limited(终);续跑次数硬上限(GENIE_GOAL_MAX_CONTINUES,防失控)。
 * 非 goal 驱动的任务也会触发校验(会话里目标在场即裁决——与 ZCode「会话上下文即证据源」一致)。
 */

/** M26:本会话仍在跑的子代理数(bgAgents 注册表;running/spawned 视为活跃)。
 *  maybeContinueGoal 发轮前用它做 SUBAGENTS_ACTIVE 判据——子代理没收敛就开下一轮
 *  会在同一工作区里叠写,主 agent 拿不到前一轮结论。 */
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
    /** M26:发起本轮时预期的目标修订号(缺省=不校验 stale;网关生产调用读的是即时目标)。 */
    expectedRevision?: number;
    /** M26:活跃子代理数覆盖(测试注入;缺省=按 bgAgents 注册表统计)。 */
    activeSubagents?: number;
    /** M26:续跑上限覆盖(缺省 GENIE_GOAL_MAX_CONTINUES,25)。 */
    maxContinues?: number;
  },
): Promise<void> {
  // 会话 worker 子进程内不本地续跑(2026-10-21):本地 submit=网关 TaskSupervisor 不可见(无
  // task.* 事件,面板/队列失明)+worker 终态退出会截杀验证中的续跑链。网关侧 host 的
  // onTaskTerminal 统一发起(走正常队列→新 worker fork)。
  if (process.env.GENIE_SESSION_WORKER_CHILD === "1") return;
  const { readGoalFromJournal, formatGoalContinuationPrompt, formatGoalCompletionVerificationPrompt, parseGoalCompletionVerificationText, goalContinueVerdict, goalRoundClaimState, GOAL_CONTINUE_EVENT, GOAL_BLOCKED_EVENT, GOAL_TICK_EVENT, GOAL_VERIFIER_EVENT, GOAL_VERIFIER_UNAVAILABLE_CODE, GOAL_ROUND_CLAIM_EVENT, GOAL_ROUND_RELEASE_EVENT, consecutiveVerifierFailures, goalVerifierFallbackNextAction } = await import("@lampgenie/runtime/agent/goal");
  // 事件先取:goal 的 revision/round 与 token 记账共用同一份会话事件(不读两遍 journal)。
  const events = journal.readAll().filter((e) => e.sessionId === sessionId);
  const goal = readGoalFromJournal(events, sessionId);
  // 无目标=静默返回(每个任务终态都会走到这里;无目标还落 goal.blocked 只会把 journal 刷满噪声)。
  if (!goal) return;
  // 会话有在跑任务→不派(ZCode active-turn 守卫)。M26(2026-11-08):「忙」不再一律静默返回——
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
  // 2026-10-23 汉化同步:续跑提示词开头改中文,前缀检测双认(中文新串+英文旧串)。
  const continues = events.filter((e) => e.kind === "task.progress").filter((e) => String((e.payload as { goalContinue?: string }).goalContinue ?? "").length > 0).length;
  const isGoalContinueText = (t: string) => t.startsWith("继续推进当前会话目标。") || t.startsWith("Continue working toward the active session goal.");
  const submits = events.filter((e) => e.kind === "message.user" && isGoalContinueText(String((e.payload as { text?: string }).text ?? ""))).length;
  const round = Math.max(goal.round, continues, submits);
  // 入口留痕(2026-11-07 修静默停摆):只有「有 goal 且非 busy」才走到这里,goal.tick 是 goal 心跳,
  // 用来区分「没跑 goal」与「跑了但没续上」;无 goal/busy 早已 return,不落噪声。
  const tickId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  journal.append({
    kind: "custom",
    sessionId,
    payload: { type: GOAL_TICK_EVENT, sessionId, tickId, round, revision: goal.revision, status: goal.status, activeSubagents, at: Date.now() },
  });
  // M26(2026-11-08)重复轮判据 + 崩溃重试:本次要发的轮次 = round+1;
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
  // M26 判据(纯函数):active / 轮次 / 子代理 / 预算 / 修订号 / 重复轮 —— 拒绝时不 submit,只留痕。
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
    // 预算/轮次上限保留既有终态语义(用户可见提示 + 目标状态收口),其余拒因只留痕。
    if (verdict.code === "GOAL_BUDGET") {
      journal.append({ kind: "goal.set", sessionId, payload: { goal: goal.objective, state: "budget_limited", at: Date.now() } });
      journal.append({ kind: "message.system", sessionId, payload: { text: "会话目标已达 token 预算,状态置为 budget_limited。除非用户提高预算或设定新目标,不要继续推进该目标。" } });
    } else if (verdict.code === "GOAL_ROUND_LIMIT") {
      journal.append({ kind: "goal.set", sessionId, payload: { goal: goal.objective, state: "paused", at: Date.now() } });
      journal.append({ kind: "message.system", sessionId, payload: { text: `[goal] 续跑次数达上限 ${maxContinues},目标已暂停(用 /goal resume 或 /goal <新目标> 继续)` } });
    }
    return;
  }
  // M26(2026-11-08)round claim:放行后、跑 verifier 之前立账——claim 无 release 且无 goal.continue
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
    // 完成校验器(2026-11-07 修静默停摆):调用失败/超时/输出非 JSON 一律视为「校验器不可用」,
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
    // M26 身份行:revision + round 进任务书(放正文之后——首行前缀是存量续跑计数/识别的锚,不能挡);
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

async function runWithAgent(
  tm: TaskSupervisor,
  journal: Journal,
  llm: LlmProvider,
  executor: SubagentBackend,
  task: Task,
  nodes?: NodeRegistry,
  models?: { compact?: LlmProvider; review?: LlmProvider; subagent?: LlmProvider; digest?: LlmProvider },
  nodeDispatch?: NodeDispatch,
  projects?: import("./projects.js").ProjectRegistry,
  permissionBroker?: import("./permission-broker.js").PermissionBroker,
  workflowAskRouter?: import("./workflow-ask-router.js").WorkflowAskRouter,
  askUser?: import("./ask-user-router.js").AskUserRouter,
  mcp?: { allToolsForAgent(): Promise<{ serverId: string; serverName: string; name: string; description: string }[]>; callTool(serverId: string, tool: string, args: unknown): Promise<string> },
  browserConfig?: { enabled: () => boolean; allowDomains: () => string[]; idleMinutes?: () => number; profile?: () => "persistent" | "ephemeral"; profileDir?: () => string; headless?: () => boolean },
  streamSink?: (sessionId: string, ev: AgentStreamEvent) => void,
  /** 取消信号注册表(step-008 收口):wireAgentLoop 持有;runWithAgent 登记/注销本任务的 loop。 */
  activeLoops?: Map<string, AgentLoop>,
  /** 记忆接线(step-029 收口)。 */
  memory?: { contextBlock(ownerId: string): string; onSessionClose(input: { ownerId: string; sessionId: string; transcript: { role: "user" | "assistant"; content: string }[] }): Promise<void> },
  /** 辅助链专用轨(step-052 F2;压缩/导读不占 realtime 会话)。 */
  auxLlm?: LlmProvider,
  /** 任务配置对象(agent.maxSteps 热读;agent.compactThresholdTokens=无窗口时的显式压缩阈值,step-058;
   * agent.subagentDeadlineMin/subagentStaleWarnMin=子代理时间盒与无产出预警,2026-10-15 机制1/3;
   * agent.writeBarrier=写前持久化屏障("off"|"hard";缺席=loop 内部 hard 现状;经 writeBarrierOf 取值,不读 env);
   * coding.lsp=编辑后 LSP 诊断+保存格式化,step-114)。 */
  agentConfig?: { agent?: { maxSteps?: number; compactThresholdTokens?: number; subagentDeadlineMin?: number; plannerDeadlineMin?: number; subagentStaleWarnMin?: number; todoAllowParallelInProgress?: boolean; verifyOnStop?: string; writeBarrier?: "off" | "hard" }; coding?: { lsp?: import("@lampgenie/lsp").LspSettings; llm?: { vision?: boolean }; vlm?: { baseUrl?: string; providerId?: string; model?: string; apiKeyEnv?: string; timeoutMs?: number; maxTokens?: number } } },
  /** 主模型上下文窗口 tokens(step-048)。 */
  contextWindow?: number,
  /** per-session 主模型覆盖面(缺省=无覆盖,共享 llm 现状零变化)。 */
  sessionModels?: SessionModelFace,
  /** M162 执行信封注入点(见 wireAgentLoop 同名字段)。 */
  envelopeDeps?: EnvelopeDeps,
): Promise<void> {
  // per-session 主模型覆盖(白板「per-session 主模型」):该会话有覆盖→派生独立 provider 实例
  // 供本任务全程使用(运行中任务持启动时引用);无覆盖→共享 llm 现状零变化。
  // 派生失败 fail-soft warn 回退共享 llm(模型选择失败不挂任务)。
  // m1:不仅主 llm,子代理/压缩/评审三个角色轨也跟随会话覆盖(deriveRoleModels 按
  //   「显式优先 > 会话覆盖 > 全局」合成 coding.models.<role>;显式配置的角色保留)。
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
  // checkpoint 快照(designs/21):执行前留工作区快照;GENIE_CHECKPOINT=off 跳过(测试提速)。
  // fixG1:sha 提升到本函数作用域——codeReviewTool 以它为 diff 基线(review 只审本任务变更集);
  // null(纯规划/干净树 stash-create 返回空/失败)→review 回退全仓未提交并在 summary 标注。
  let checkpointSha: string | null = null;
  if (process.env.GENIE_CHECKPOINT !== "off") {
    // 2026-10-26 远端化:远程项目任务的快照走远端 git(通道;远端仓库才是被改的工作区)
    const cpProj = projects?.list().find((x) => x.id === task.projectId);
    const cpRemote = cpProj ? parseRemoteProject(cpProj.path) : null;
    if (cpRemote) {
      try {
        const rg = await remoteGit(cpRemote, ["stash", "create"]);
        if (!("error" in rg)) checkpointSha = rg.stdout.trim() || null;
      } catch { checkpointSha = null; }
      journal.append({ kind: "checkpoint.create", sessionId: task.sessionId, payload: { taskId: task.id, sha: checkpointSha, root: cpRemote.workspacePath, remote: true } });
    } else {
      const { checkpointCreate } = await import("./git-service.js");
      const root = projects?.resolveWorkdir(task.projectId) ?? repoRoot();
      try { checkpointSha = await checkpointCreate(root); } catch { checkpointSha = null; }
      journal.append({ kind: "checkpoint.create", sessionId: task.sessionId, payload: { taskId: task.id, sha: checkpointSha, root } });
    }
  }
  // 聊天史语义(step-037):用户消息入 journal——**单写归 loop.runTurn**(step-052 双份修复:
  // 此处原来的无条件追加叠加 loop 内部追加,同一轮 journal 两条 message.user,面板渲染两行且模型收到双份上下文)。
  // 仅「进不了 loop」的早退分支在此补记(否则失败史缺用户消息)。
  const recordUser = () => journal.append({ kind: "message.user", sessionId: task.sessionId, payload: { text: task.instruction, ...(task.attachments?.length ? { attachments: task.attachments } : {}) } });
  // 可达性分派守卫(R5-C11):与 executor 路径同语义。
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
    // tunnel 委派(step-033):远端命中→任务书下发节点自己的执行器(不在本地跑 LLM 编排)。
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
  /** web.search 配置层热读(2026-10-21):直读项目 genie.config.json 的 web.search 块,
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
  // 项目级根(2026-10-12 用户口径:code-sense/review 是 vibe coding 轨的项目级能力,每个项目不同):
  // 任务带 projectId→项目根;无项目/项目不可用回退 harness 根。此前 code_sense/orient/review
  // 全钉在 harness 根(step-035 登记边界「workflow/code_sense 根仍 harness」的收口)。
  const taskRoot = projects?.resolveWorkdir(task.projectId) ?? repoRoot();
  // 远程项目工具三件(2026-10-26,ZCode remote workspace 业务切片):任务归属 remote:ssh 项目时
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
    // 2026-10-26:远程项目任务的工具套件 = **本地同名七件**(read_file/write_file/edit_file/glob/
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
        // git 破坏命令硬拦(g1,2026-11-05):子代理远程 run_cmd 同样不许 git 写/破坏(git stash 实锤事故)。
        // 远程路径不本地解析,但命令文本是同一份→解析后子命令判定与本地同口径。
        // 作用域说明:本 execTool 是 remoteProjectTool 的一部分,只并入主 agent 的 mainTools(:5052),
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
  // 板存储根(2026-10-21 板根错位根治):repoRoot() 是**唯一**板存储根——board_upsert/board_read
  // 的写盘根(storeRoot 缺省=repoRoot())、面板 board.load(boardRoot) 都在这;taskRoot 只用于
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
  /** q4 子写者独立板「在场」探测(2026-10-25,只给 plan-gate 用,不进 P0 计分):
   *  planner 以 scope 落板后,规划契约在 `.genie/boards/<sid>/<taskId>-<scope>.json`,
   *  主任务板可能根本不存在——plan-gate 的判据是「本任务有规划契约在场」,它必须能看见
   *  planner 的独立板,否则闸门永远拒(死循环)。只探测本 taskId 的分区板(`<taskId>-*`),
   *  不跨任务;且**不**参与 P0 覆盖率/收尾校验(那些只认同一个写者的板=本任务的板)。 */
  const hasPartitionBoard = async (): Promise<boolean> => {
    for (const root of [boardStoreRoot, taskRoot]) {
      try {
        const items = (await listBoardsExAsync(root, task.sessionId)).items;
        if (items.some((i) => i.taskId.startsWith(`${task.id}-`))) return true;
      } catch { /* 探测失败按无分区板处理 */ }
    }
    return false;
  };
  // 静态调用索引预热(2026-10-12 三改:提前生成,不点哪个查哪个;fire-and-forget,首次 1-2 分钟后台)。
  // 预算闸(2026-10-21):超预算根(如工作区根)冷构建实测 7 分钟后 SIGABRT 且反复重 fork——
  // 闸拒绝后不预热(fork worker 侧另有失败冷却,这里是入口侧省掉注定失败的构建)。
  void (async () => {
    try {
      const verdict = await rootScanVerdict(taskRoot);
      if (!verdict.ok) return;
      const m = await import("./sense-index-manager.js"); m.warmIndex(taskRoot);
    } catch { /* 预热失败容忍 */ }
  })();

  // 机制3(2026-10-15):无产出预警阈值——task_output stale 标记的判定窗(进程内后端的 [warn] 行同源配置)。
  const staleWarnMs = Math.max(Number(agentConfig?.agent?.subagentStaleWarnMin ?? 20) * 60_000, 250);

  // 上下文治理(2026-10-20 子代理与 coding agent 同源):同一 compactHook / microcompact 实例
  // 既喂主 loop 也喂 spawn 出的子 loop。此前子 loop 永不压缩——长子代理随着工具结果累积
  // 无界增长上下文,与主 agent(有阈值压缩)完全是两套工作模式。
  // effort 档位(2026-10-22 四档联动):从 provider describe() 读(热更新后读新值),
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
  // (实测 uncached 单价 = 命中的 50 倍)。主 loop 与 spawn 出的子 loop 同源注入(spill 目录同根,
  // 按各自 sessionId 分子目录),否则长子代理照旧打碎缓存。
  const taskSpill: import("@lampgenie/runtime/agent/loop").AgentLoopOptions["spill"] = {
    dir: join(repoRoot(), ".genie", "spill"),
  };
  // 上下文模型评分(Phase 1/2):默认来自 config.context.modelScoring(本地 150M Jev)。
  // 未配置 agentConfig(测试/旧装配)=undefined,loop 不发起评分请求。
  const taskModelScoring = (agentConfig as {
    context?: { modelScoring?: import("@lampgenie/runtime/agent/loop").AgentLoopOptions["modelScoring"] };
  } | undefined)?.context?.modelScoring;
  // 大结果「智能入上下文」闸门(step-1029,2026-11-06):入口侧控增量。命中闸的工具结果不再走 spill
  // ——先切块让本地 8105 判相关性(±小模型四段摘要),全文落 .genie/tool-dumps,上下文只放摘要+指针。
  // 与 spill 同源装配:主 loop 与 spawn 子 loop 共用,否则长子代理照旧把大结果整段灌进去。
  const taskBigIntakeDumpDir = join(repoRoot(), ".genie", "tool-dumps");
  const bigIntakeDigestLlm = models?.digest ?? models?.compact ?? auxLlm;
  // 提炼模型优先(digest→compact→aux),**不**回落主模型。
  const taskBigIntake: import("@lampgenie/runtime/agent/loop").AgentLoopOptions["bigIntake"] = {
    enabled: bigResultEnabledFromEnv(),
    dumpDir: taskBigIntakeDumpDir,
    // 提炼外层超时(2026-11-08):qwen3.7-flash 对 12k 字符 diff 实测 53.4s,旧 20s 默认值在真实
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
  // M48 压缩后正文补回配置(agent.compactRehydrate):每次压缩执行时经 getter 读,配置热改即时生效。
  const taskCompactRehydrate = (agentConfig as { agent?: { compactRehydrate?: import("./compact-rehydrate.js").CompactRehydrateConfig } } | undefined)?.agent?.compactRehydrate;
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
  });

  // step-071 父子 ask-answer:任务级 broker——子代理重操作(build/install/全量测试/递归批处理)申请
  // 路由给父 agent 决策(旧链路的子代理 ask 只到面板或静默拒绝,父 agent 从不参与)。
  // 两条通道共用一个 broker:①注入——结构化问题块(message.user)进父 journal,父 loop 下一 step 可见;
  // ②决策泵——driveParentDecision 直驱父 LLM 做 mini-turn 裁决(父 loop 阻塞在 spawn 工具内时唯一
  // 可达通道;父 loop 若先经 answer_subagent 应答,泵的应答幂等落空)。问答全程落父 journal
  // (custom subagent.heavy-ask/-answer),审批结果以 message.system 回灌会话(面板/模型都可见)。
  const parentAskBroker = new ParentAskBroker({ journal, sessionId: task.sessionId });
  parentAskBroker.onPending = () => {
    // 2026-11-03 token 治理(step-1031 实锤 2.7M token/日=注入总量 39.6%):不再把审批块以
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

  // plan-gate(2026-10-20 用户口径「规划流程要代码级机制强制,光靠上下文靠不住」):
  // 实锤——活跃 session 均未走 planner(planner 委托/先骨架后丰满/防目标丢失全在提示词层,
  // flash 档模型不遵守),而板的落板门/收口门因「从未落板」根本没被触发。本闸门把入口代码化:
  // **写角色子代理派发与主 agent 写文件,均需本任务白板(规划契约)在场**——板由 planner 落
  // (board_upsert),带 P0 验收(落板门已拦缺验收);此后骨架→丰满的推进与收口由
  // boardReminder(每 10 步 P0 再锚定)+收口门(done 必须证据全绿)+下方收尾校验三段追踪。
  // 模式:hard(缺省,硬拦)/soft(只 journal 提醒不拦)/off。全程 journal 留痕可回放审计。
  // 优先级 env > config > hard(2026-10-21):GENIE_PLAN_GATE=off/soft/hard——基础设施类测试
  // (reaper/worktree/会话纪律等,不涉及规划流程)与应急场景显式豁免,不必逐个硬造板+阶段声明。
  const planGateMode = String(process.env.GENIE_PLAN_GATE ?? (agentConfig?.agent as { planGate?: string } | undefined)?.planGate ?? "hard");
  // 任务类别(2026-10-23 用户口径:理解阶段定类,后续 tips/plan-gate 全消费同一结果):
  // 初判=启发式(classifyTaskClass,开工即出);agent 在 understand 用 task_phase(taskClass=...)
  // 更正,更正即刻生效(plan-gate 恢复/收紧、每10步锚与后续轮次按新类走)。
  const taskClassState: { value: TaskClass } = { value: classifyTaskClass(task.instruction) };
  // 直达实施路由(2026-10-24):理解阶段判定「明确具体的小改」→ implement(route=direct) →
  // plan-gate 尺度豁免;落板(board_upsert)即自然回归全流程(闸门在有板时本就放行)。
  const taskRouteState: { direct: boolean } = { direct: false };
  try {
    journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "task.class", taskId: task.id, taskClass: taskClassState.value, source: "heuristic" } });
  } catch { /* 留痕失败不影响执行 */ }
  // 板根对齐(2026-10-21 修正):此前注释说「board_upsert 写盘用 taskRoot」与代码不符——board_upsert
  // 实际写盘根 = storeRoot ?? repoRoot()(mainTools 只传 4 参 → storeRoot=undefined → repoRoot()),
  // 面板 board.load 也是 repoRoot()。故 repoRoot() 才是唯一板存储根;按 taskRoot 读板在
  // 「任务 projectId 指向非 harness 项目」(taskRoot≠repoRoot)时永远读不到 → plan-gate 死循环。
  // readTaskBoard:主根 boardStoreRoot 优先,taskRoot 回退(多根容忍)。
  const planBoard = () => readTaskBoard();
  let planGateAnnounced = false; // 放行事件只落一次(无→有翻转变动留痕)
  let planGateDirectAnnounced = false; // 直达路由豁免留痕一次(2026-10-24)
  let phaseAutoAdvancedAnnounced = false; // 阶段门自动推进只落一次(2026-11-05)
  // 逃生阀计数(2026-10-21):只统计「无板」这一类拒绝(阶段门不计数)。实锤:板根错位时闸门
  // 永远读不到板,模型收到同一句模板话术 5 次、反复重试仍无法脱困 → 同因第 3 次降级放行。
  let planGateDenies = 0;
  const PLAN_GATE_DENY_LIMIT = 3;
  // 全链路变更门的独立计数(2026-11-06):与「无板」同档逃生阀,但独立计数——两类拒绝同因不同,
  // 混计会让「缺盘点」把「缺板」的额度吃掉,症状变成闸门突然静默放行。
  let surfaceGateDenies = 0;
  /** 本任务的全链路变更判据(阶段回执/收尾摘要共用;hasManifest/exempt/hasChain 恒真=只取 scope,不产生拒绝)。 */
  const surfaceScopeThisTask = () =>
    surfaceGateVerdict({ taskClass: taskClassState.value, instruction: String(task.instruction ?? ""), hasManifest: true, exempt: true, hasChain: true });
  // 规划委托判据(2026-10-25 用户口径「白板应该是 planner 自己画,不能主 agent 手工改」):
  // 本任务是否派过 planner(含被权限拦下的尝试——尝试过即允许降级内联,以免 planner 不可用时死锁)。
  // 旧实现只靠提示词,flash 档主 agent 会把 6 节点设计板内联画成流程图并直接实施;这里把
  // 「大板必须由 planner 落」变成写操作硬闸(≤3 节点轻量板仍允许主 agent 内联)。
  let plannerSpawnedThisTask = false;
  let plannerGateDenies = 0;
  const PLANNER_GATE_DENY_LIMIT = 2;
  // 豁免留痕判据(2026-11-05 用户拍板「office 走硬闸 + 豁免留痕」,不是软提醒):本任务是否经
  // board_upsert 传 exemptReason 显式声明过「确实没有开发内容/表达结构」。与 plannerSpawnedThisTask
  // 同级=只在本任务进程内有效;board 不落盘,只落 journal board.exempt(禁止静默豁免)。
  let boardExemptThisTask = false;
  const planGateBlock = async (tool: string, actor: string): Promise<string | null> => {
    if (planGateMode === "off") return null;
    // 任务类别分流(2026-10-23 起;2026-11-05 收紧 office):qa=问答/调研免板直放;office=办公/产出类
    // 走硬闸(必须有作业思路板 composition 或显式豁免);coding=内容板判据。agent 用
    // task_phase(taskClass=...) 更正类别时本闸即刻按新类裁决。
    if (taskClassState.value === "qa") return null;
    // 全链路变更硬门(2026-11-06 用户口径「用户只描述意图,harness 自动找出该意图涉及的所有链路
    // 节点…一次性全部改到一致,并证明没有残留」):指令含替换/迁移/改名词(coding 类)时,写操作
    // 前必须有本任务 change.surface 盘点清单(journal 事实,不是提示词自述)——否则「只改 UI 就交差」
    // 仍能过闸。exempt 通道:board_upsert exemptReason 或 change_surface action=exempt(理由必填)。
    // 清单只回读一次(2026-11-06 链路图轮):hasManifest 与 hasChain 同源,避免两次读 journal 后口径分叉。
    const surfaceManifest = readChangeSurfaceManifest(journal, task.sessionId, task.id);
    const surfaceVerdict = surfaceGateVerdict({
      taskClass: taskClassState.value,
      instruction: String(task.instruction ?? ""),
      hasManifest: surfaceManifest !== null,
      hasChain: surfaceManifest ? surfaceManifest.chain !== undefined : undefined,
      exempt: boardExemptThisTask || readChangeExempt(journal, task.sessionId, task.id) !== null,
      directRoute: taskRouteState.direct,
    });
    if (surfaceVerdict.deny) {
      surfaceGateDenies += 1;
      const attempt = surfaceGateDenies;
      // 逃生阀同「无板」档:同因第 3 次降级放行(闸门自身异常不该把任务钉死),留痕说明降级。
      const escalated = attempt >= PLAN_GATE_DENY_LIMIT;
      // rule 按原因区分(2026-11-06 链路图轮):缺链路图是独立判据,留痕要能和缺盘点分开统计。
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
    // 放行判据(2026-10-20 五阶段轮收紧):板上须有**非阶段节点**(ph- 前缀是 task_phase 的流程泳道,
    // 纯阶段板没有规划内容)——防「只调 task_phase 建空板绕过 planner」。
    const designNodes = board ? board.nodes.filter((n) => !String(n.id).startsWith("ph-")) : [];
    // 内容节点判据(2026-11-04 用户口径「板偏计划步骤而非实际开发内容逻辑」):长尾实锤——
    // 2-3 节点板全是「s1 梳理→s2 归因→s3 修复」式 TODO 序列,零 targets/symbolRef/accept/数据,
    // 过了旧判据(designNodes>0)。闸门升级:只认**内容节点**(指向实际对象或带可验验收);
    // 纯步骤板不开门——板是「变更在系统里的内容契约」,不是执行清单。
    const contentNodes = designNodes.filter((n) => isContentNode(n as never));
    // office 判据(2026-11-05 用户口径「调研/写 PPT/汇报/写文章也可以在白板上画一下作业思路
    // (主题/受众/结构/章节/章间关系/顺序)」+「office 走硬闸」):办公/产出类必须有**作业思路板**。
    // 宽松实现:只看 boardType==="composition" 且有效节点 ≥3(主题/受众/≥2 章节),更细的结构校验
    // (章节主题/章间关系词)由类型门 board-contract 负责——此处刻意不 import 新函数,避免跨代理编译竞态。
    const compositionNodes = board && board.boardType === "composition" ? designNodes : [];
    const hasCompositionBoard = compositionNodes.length >= 3;
    const isOffice = taskClassState.value === "office";
    // 豁免通道(2026-11-05,用户拍板「office 走硬闸 + 豁免留痕」):本任务已用 board_upsert
    // exemptReason 显式声明过「确实没有开发内容/表达结构」→ 放行,且回放可见(不留静默豁免)。
    if (boardExemptThisTask) {
      try {
        journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "plan.gate", effect: "exempted", tool, actor, taskClass: taskClassState.value } });
      } catch { /* 留痕失败不影响放行 */ }
      return null;
    }
    // office 硬闸(2026-11-05 用户口径「白板一定是开发内容逻辑;办公任务也可以在板上画作业思路
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
    // 尺度豁免(2026-10-24):直达实施路由——理解阶段判定的「明确具体小改」免板直写;
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
    // 阶段门 → 自动推进(2026-11-05):7 天 telemetry(n=108 次 phase 拒绝/33 会话)显示 100% 的
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
      // 规划委托硬闸(2026-10-25):大板(>3 设计节点)必须由 planner 落盘;主 agent 只允许
      // 内联 1~3 节点轻量板。旧实现纯提示词,实测主 agent 把 6 节点 UI 任务画成流程图后直接实施,
      // 白板失去「planner 先规划」的约束。planner 尝试过(即便失败)即放行,保留降级路径。
      if (planGateMode === "hard" && !plannerSpawnedThisTask && designNodes.length > 3) {
        plannerGateDenies += 1;
        const attempt = plannerGateDenies;
        const escalated = attempt > PLANNER_GATE_DENY_LIMIT;
        // 记账收敛(2026-11-05):非 escalated(前 LIMIT 次)每条都落(诊断需要);escalated 只在
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
          // 差分回执(2026-11-06 token 收敛,B2 P2 遗留):旧版整段规则说明+出路 ~230 字/次,
          // escalated 会话里同文本每步重发(baseline §4.3:话术失败率 29%,重复回执纯 token 浪费)。
          // 只报「缺什么+下一步一句话」;journal 事件已含结构化字段,规则全文不进回执。
          return JSON.stringify({
            status: "rejected",
            reason: `plan-gate(规划委托):板已有 ${designNodes.length} 个设计节点(>3 阈值,内联额度 3 已尽),没有派过 planner——缺:planner 派发 0 次、内容节点 ${contentNodes.length}/${designNodes.length}。下一步一句话:spawn_subagent(agentType="planner", instructions=目标/期望产出/边界/板型)。`,
          });
        }
      }
      // 阶段门自动推进(2026-11-05):板含内容节点=规划事实已发生,不再要求先声明 task_phase。
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
    // 诊断面(2026-10-21 可诊断):把「实际读的板路径 / 两个根 / sessionId+taskId / 回退是否命中」
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
      // 记账收敛(2026-11-05):只在第 LIMIT 次(首次降级)与之后每 +10 次落一条,其余次数直接放行不留痕。
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
          // 结构化字段(2026-11-05):遥测/看板按 reason+rule+decisionBy 归因,话术本文字逐字不动。
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
    description: "Dispatch one subtask to a subagent and return its final text. Pass wait:true to block until it reaches a terminal state (zero LLM cost while waiting). **plan-gate: with no board in this task yet, write roles (worker/general) are rejected and pointed at planner; planner/explore/judge are exempt.** agentType picks the role (types listed in system prompt, default worker; read-only investigation → explore). title = one-line (<=30 chars) card label; required when several subagents run in parallel. deadlineMin = time box in minutes: on expiry the harness reaps the subagent and delivers its output as a partial result (explicitly marked, not a failure). Default = unbounded, run to completion — set it only to cap runaway jobs. A subagent is a child process agent inside THIS session (not a new session; it cannot create sessions). For independent subtasks, emit several spawn_subagent calls in one message so they run in parallel. step-071: when the task involves build/install/full test suite, state the expected commands and tell the subagent that heavy operations are gated and routed to the parent for approval — wait for the decision, never split commands to bypass it. Such approval requests surface in this session as questions; answer via answer_subagent with a reason for both approve and reject. step-117: backend:\"acp\" dispatches to an external ACP agent (Claude Code/Codex/Kimi/Hermes etc., adapter = claude-code/codex/kimi/hermes/qwen/opencode/dsh/minimax or a command). ACP permission requests use the same approval chain; ACP has no mid-run steer. step-123: worktree:true runs the subagent in a dedicated git worktree off current HEAD (<repo>/.genie/worktrees/<agentId>, branch genie/<agentId>) so parallel subagents do not collide and your workspace stays clean; the worktree and branch are kept for manual merge and the result carries worktreePath/branch. Non-git repos are rejected explicitly (no silent fallback; drop the flag to run in the main workspace).",
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
      },
      required: ["instructions"],
    },
    // ZCode agentToolEntry concurrentSafe:true 同款(step-056):同批多条 spawn 经 loop Promise.all 并行;
    // 每次调用独立 LlmLoopBackend 实例+独立闭包状态,进程内子代理并发安全。
    isConcurrencySafe: () => true,
    async execute(args: unknown, signal?: AbortSignal) {
      const rawArgs = args as {
        instructions: string; title?: string; agentType?: string; run_in_background?: boolean; deadlineMin?: number;
        backend?: string; adapter?: string; adapterArgs?: string[]; adapterEnv?: Record<string, string>;
        worktree?: boolean; isolation?: string; wait?: boolean;
      };
      // ACP 后端(step-117):显式 backend 只认 "acp"(其它值 fail-visible,不静默当默认后端)。
      const backendArg = rawArgs.backend ? String(rawArgs.backend).toLowerCase() : undefined;
      if (backendArg && backendArg !== "acp") {
        return JSON.stringify({ status: "rejected", reason: `未知 backend "${String(rawArgs.backend)}":可选 acp(缺省=服务配置 executor)` });
      }
      const acpRequested = backendArg === "acp";
      // worktree 隔离(step-123):worktree:true 或 isolation:"worktree";未知 isolation=fail-visible。
      const isolationArg = rawArgs.isolation === undefined ? undefined : String(rawArgs.isolation).toLowerCase();
      if (isolationArg && isolationArg !== "none" && isolationArg !== "worktree") {
        return JSON.stringify({ status: "rejected", reason: `未知 isolation "${String(rawArgs.isolation)}":可选 none/worktree(或直接用 worktree:true)` });
      }
      const worktreeRequested = rawArgs.worktree === true || isolationArg === "worktree";
      // plan-gate 写角色前置闸(2026-10-20):worker/general 等写角色派发需规划板在场(worktree
      // 创建之前拦——拒绝不产生孤儿工作树)。planner/explore/judge/test-analyst 不受限。
      // 2026-11-05:ppt-master 同样是写角色(产 deck.md / 调导出工具),纳入同一道闸。
      const gateRole = String(rawArgs.agentType ?? "worker").toLowerCase();
      // 规划委托硬闸:派过 planner(含后续失败/被权限拒的尝试)即视为已履行委托,允许降级内联。
      // 必须在写角色闸之前置位:同一批工具调用(先 worker 后 planner)也按到达顺序正确裁决。
      if (gateRole === "planner") plannerSpawnedThisTask = true;
      const gateIsWriteRole = gateRole === "worker" || gateRole === "general" || gateRole === "general-purpose" || gateRole === "ppt-master";
      if (gateIsWriteRole && !acpRequested) {
        const blocked = await planGateBlock("spawn_subagent", `派发写角色子代理(${gateRole})`);
        if (blocked) return blocked;
      }
      const subTitle = String(rawArgs.title || "").trim().slice(0, 40); // 过程卡标题(2026-10-15:多子agent并列时首行前言雷同→卡片无法区分)
      // 机制1(2026-10-15):时间盒解析——显式参数 > 全局 agent.subagentDeadlineMin > planner 专属缺省
      // (2026-10-25 大并发修复:planner 未配置时 8 分钟,防慢 planner 长期占并发槽;其他角色仍不限时)。
      const deadlineMin = resolveSubagentDeadlineMin(rawArgs.agentType, rawArgs.deadlineMin, agentConfig?.agent);
      const deadlineMs = deadlineMin > 0 ? Math.round(deadlineMin * 60_000) : 0;
      // 可分离的子中止(designs/25 ZCode detachParent 语义):父取消→转发给子;一旦自动转后台→解除转发(子代理独立存活)。
      const subAbort = new AbortController();
      const forwardAbort = () => subAbort.abort();
      signal?.addEventListener("abort", forwardAbort, { once: true });
      const instructions = composeSubagentInstructions(agentProfiles, rawArgs.agentType, String(rawArgs.instructions))
        // planner 历史复用(2026-10-20 用户口径:新规划基于已有历史规划):任务书尾部自动带历史档案
        //(本会话优先+近期,≤8 条)——延续已验证的结构,别推翻已交付的成果;确需重构时在板里注明理由。
        + (String(rawArgs.agentType ?? "").toLowerCase() === "planner"
          ? renderTaskArchiveBlock(readTaskArchive(taskRoot, { sessionId: task.sessionId, limit: 8 })).replace("## 历史任务档案(compact 后恢复锚;做相关任务先对齐历史结论,别推翻已验证的成果)", "## 历史任务/规划档案(规划参考:结构可延续、成果别推翻;重构需注明理由)")
          : "")
        // 读传递(2026-11-05 D3 治理:跨 agent 读重叠 17.5%):父会话已读文件+行段随任务书注入,
        // 子代理「勿再整读父已读片段」。≤8 文件≤700 字符(≈175 tok)防反向膨胀;GENIE_READ_HANDOFF=off 关。
        // 门控=后端类型在下方判定(isInProcessBackend);ACP/echo 外部后端不注入(它们有自己的读面)。
        + (() => {
          const backendKind = String((executor as { kind?: string }).kind ?? "");
          if (process.env.GENIE_READ_HANDOFF === "off" || acpRequested || backendKind !== "echo-child") return "";
          const block = renderParentReadBlock(readFilesOf(task.sessionId));
          return block ? "\n\n" + block : "";
        })();
      const events: string[] = [];
      // 终态守卫(机制1 竞态面):deadline 收割与后端迟到 result 只落一次注册表/journal 终态。
      let settled = false;
      let deadlineFired = false;
      // 同步落结果的 backend(ACP 的 spawn-failed 在 spawn 返回前就发 result)在注册表登记前已终态——
      // 用最近一次 result.ok 校正登记状态,避免「failed 却显示 running」。
      let lastResultOk: boolean | undefined;
      const spawnStartAt = Date.now();
      // 后台子代理注册表(step-054,ZCode async agent 机制):agentId→输出文件路径与状态。
      const bgAgentId = "agent_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      // 2026-10-19 修复:子代理 taskId 每次派发唯一。旧实现同父所有子代理共用 `${task.id}-sub`
      // (后台共用 `${task.id}-bg`)→ 子 loop sessionId、轨迹目录 `subagent-<taskId>-sub`、
      // subagent.event.taskId 三者全撞在一起(实测两个并行 explore 的 159 次调用混在同一目录,
      // 无法按子代理排障)。前缀保留父任务 id 便于追溯;agentId 仍是全局唯一键。
      const subTaskId = task.id.slice(0, 8) + "-" + bgAgentId.slice(6, 14);
      // worktree 隔离(step-123):在构造后端前创建,使 roots/workdir/子进程 cwd 全部指向派生工作树。
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
          return JSON.stringify({ status: "rejected", reason: `worktree 隔离不可用(${code}):${message}`, worktree: { requested: true, ok: false, code } });
        }
      }
      // 子代理工作根(step-123):worktree 模式下所有子代理面(工具围栏/命令 cwd/code_sense 根)
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
      // 子代理实际模型名(step-060 目录;2026-10-20 用户口径「子代理与主 agent 同模型」):
      // models.subagent 显式配置才存在(factory 未配=undefined),回退主 llm=同实例同模型同 effort,
      // 主模型热切换后新 spawn 天然用新模型(与 effectiveBackend 同判定源)。
      const subModelName = subagentModelNameOf(models?.subagent ?? llm);
      // review 抓:sessionId 来自客户端,入路径段前消毒(与 board-store seg 同纪律)
      const bgOutputDir = join(repoRoot(), ".genie", "agent-outputs", String(task.sessionId).replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_"), bgAgentId);
      // echo 占位后端 → 进程内 LLM 子代理(2026-10-13 收口:ZCode Agent 工具的本质=独立上下文
      // +只读工具的真 loop,不再回显任务书)。真实后端(dsh/zcode/opencode)不受影响。
      // step-117:backend=acp 显式覆盖(外部 ACP agent),不走进程内子代理分支。
      const isInProcessBackend = !acpRequested && String((executor as { kind?: string }).kind ?? "") === "echo-child";
      // 能力计划(step-061):profile.tools=执行白名单;deny-only=权限只下传父 deny。
      const cap = resolveSubagentCapability(agentProfiles, rawArgs.agentType);
      // 写角色(worker/general)挂执行面:terminal/web/browser/board_read/session_search——
      // 与主 coding agent 能力对齐(除派发子代理外);只读角色(explore/judge/test-analyst)保持窄面。
      const subRoleEarly = String(rawArgs.agentType ?? "worker").toLowerCase();
      const writeRoleEarly = subRoleEarly === "worker" || subRoleEarly === "general" || subRoleEarly === "general-purpose";
      // 产出面(2026-11-05):ppt-master = 写角色能力面(bash/写盘)+ board_export_pptx 导出通道。
      // 与 planner 的分工一致:结构由规划出,文件由产出角色生成——但这里导出工具必须给它,
      // 否则「质量门是唯一交付通道」这条契约无法执行。
      const deckRoleEarly = subRoleEarly === "ppt-master";
      // step-138:规划角色(planner)挂「规划面」——白板可写(board_upsert)+ 只读认知,
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
      // 子代理工具池名字集(step-069 池外观测用):内置读/写+注入面(code_sense 系/skill_view/MCP)。
      const subPoolNames: string[] = capExtraTools
        ? [...SUBAGENT_READ_TOOLS, ...SUBAGENT_WRITE_TOOLS, ...capExtraTools.map((t) => t.name)]
        : [];
      const capSkillIndex = cap.toolWhitelist
        && expandToolTokens(cap.toolWhitelist).includes("skill_view")
        ? renderSubagentSkillIndex(getExperienceStore())
        : undefined;
      // ACP 外部后端(step-117):backend=acp 时按参数构造;adapter 未配置由 AcpBackend 在 spawn 时
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
      // 读传递(2026-11-05 D3)接线+留痕:同条件双触达——①parentReadSession 传进程内后端
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
        ? new (await import("./llm-loop-backend.js")).LlmLoopBackend({
            // 步数跟随主 agent 配置(2026-10-13 用户口径:取消强制结束;原硬编码 16 会腰斩真实任务)
            // designs/25(ZCode subagent_model 语义):子代理走独立模型端点,与主链路隔离——
            // 共享端点的服务端会话串扰不再父子互染。未配置=回退主 llm。
            // step-123:worktree 模式下 roots 只含派生工作树(主仓不可写);否则沿用项目根+harness 根。
            llm: models?.subagent ?? llm, maxSteps: agentConfig?.agent?.maxSteps ?? 80, roots: worktree ? [subRoot] : [taskRoot, repoRoot()],
            // 写前持久化屏障与主 agent 同源同值(config.agent.writeBarrier;undefined=不写键,后端/loop 缺省 hard)。
            ...(writeBarrierOf(agentConfig) ? { writeBarrier: writeBarrierOf(agentConfig) } : {}),
            role: rawArgs.agentType ?? "worker",
            workdir: subRoot,
            // M58 图片 offload:子代理与主 loop 同根(repoRoot),不随项目 workdir 漂移。
            imageOffload: imageOffloadOf(repoRoot()),
            // 编辑后 LSP 诊断/保存格式化(step-114):子代理 write/edit 与主 agent 同语义。
            // LSP(2026-10-26):远程项目跳过(本地 tsserver 无远端代码;远端 LSP 独立工程登记)——
      // 省一次必然失败的 server 拉起
      ...(!remoteProjectTool && agentConfig?.coding?.lsp ? { lsp: agentConfig.coding.lsp } : {}),
            // 机制1/3(2026-10-15):deadline 到点强制收割(部分结果交付)+无产出预警,由后端内部执行。
            ...(deadlineMs > 0 ? { deadlineMs } : {}),
            staleWarnMs,
            // 能力白名单(step-061):profile.tools 声明→真实工具面;缺席=角色二分兜底(行为同旧版)。
            ...(cap.toolWhitelist ? { toolWhitelist: cap.toolWhitelist, extraTools: capExtraTools } : {}),
            // 写盘围栏(step-138):profile.writeGlobs→后端 write_file/edit_file 路径白名单(planner 只写规划稿)。
            ...(cap.writeGlobs ? { writeGlobs: cap.writeGlobs } : {}),
            ...(capSkillIndex ? { skillIndexText: capSkillIndex } : {}),
            // 权限传递收口:进程内子代理默认继承父会话有效规则(已允许的传递下去;profile.permission=
            // deny-only 时只下传父 deny,与外部后端同语义);ask 走与外部后端同语义的审批链
            // (未允许的仍走审批;无规则=不设闸同旧版)。
            ...(permRules ? { permissionRules: cap.denyOnly ? deriveChildRules(permRules) : permRules } : {}),
            ...(permRules ? { onPermissionAsk: makeSubagentPermissionAsker({ sessionId: task.sessionId, journal, broker: permissionBroker }) } : {}),
            // step-071 父子 ask-answer:重操作申请路由给父 agent(broker 注入+泵;超时=拒绝 fail-closed)。
            ...(parentAskBroker
              ? { parentAsk: (input: { taskId: string; role: string; tool: string; command: string; match: import("@lampgenie/core").HeavyOpMatch }) => parentAskBroker.ask(input) }
              : {}),
            // 读传递(2026-11-05 D3):父会话键传子后端——子 read_file 命中父/兄弟已读行段时尾注,
            // 登记双写父键(兄弟子代理经父键即刻共享已读事实)。
            ...(readHandoff ? { parentReadSession: task.sessionId } : {}),
            // 子代理工作区入账(2026-10-16 用户口径:点开子代理要能看到它的全部动作/消息流):
            // 子 loop 事件以 subagent.event 落主 journal(payload={agentId,kind,…裁剪后原字段})。
            // 面板主会话渲染过滤该 kind(不双渲染),子代理工作区 tab 专用回放;外部后端不产生
            // loop 事件,工作区对它们降级为 output.txt 进度行时间线(如实标注,不造假消息)。
            onLoopEvent: (e) => {
              try {
                journal.append({ kind: "subagent.event", sessionId: task.sessionId, payload: { agentId: bgAgentId, taskId: subTaskId, parentTaskId: task.id, kind: e.kind, ...e.payload } });
              } catch { /* journal 入账失败不影响子代理执行 */ }
            },
            // 2026-10-20 子代理与 coding agent 同构(ZCode Agent 子 runtime 继承父
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
      // 子代理权限收敛(step-033):外部后端协议语义=父 deny 下传、allow/ask 不放大(ask 由父侧
      // 审批链代答);进程内 LLM 子代理走整体规则继承(上方构造参数),不走 deny-only 派生。
      const childRules = permRules ? deriveChildRules(permRules) : undefined;
      journal.append({
        kind: "subagent.spawn",
        sessionId: task.sessionId,
        payload: {
          // instructions 全文入 journal(2026-10-15 用户反馈:300 字截断让过程卡任务书齐腰断;执行层本来就是全文,截的只是展示)
          taskId: subTaskId, parentTaskId: task.id, backend: acpRequested ? "acp" : executor.kind, instructions: instructions.slice(0, 8000),
          // step-117:ACP 后端记录 adapter 标识(实际命令解析在 AcpBackend.spawn;env 兜底也算)
          ...(acpRequested ? { acpAdapter: rawArgs.adapter ?? process.env.GENIE_ACP_ADAPTER ?? "(未配置)" } : {}),
          // agentId(B 2026-10-14 面板过程卡):面板据此把 spawn 事件与后台注册表/output.txt tail 关联
          agentId: bgAgentId,
          // 会话结束后 bgAgents 运行期状态丢失,派遣时生效的模型必须落 journal 才能回溯
          // (此前模型只在 bgAgents.set 的 model 字段里,靠 session.status 推送,进程重启/会话结束即不可查)。
          ...(subModelName ? { model: subModelName } : {}),
          // step-123:worktree 隔离的路径/分支/base 落 journal(人工合并与清理的定位依据)
          ...(worktree ? { worktree } : {}),
          ...(subTitle ? { title: subTitle } : {}),
          ...(permRules ? { derivedPermissionRules: isInProcessBackend ? (cap.denyOnly ? deriveChildRules(permRules).length : permRules.length) : childRules!.length } : {}),
          // 能力声明快照(step-061;step-069 抽出 buildSubagentToolPolicy=直测锚+池外 warnings 观测):
          // source=declared(白名单生效)/fallback(角色二分兜底);warnings=池外声明(不改行为只补观测)。
          ...(isInProcessBackend ? { toolPolicy: buildSubagentToolPolicy(cap, rawArgs.agentType ?? "worker", subPoolNames) } : {}),
          // 读传递留痕(2026-11-05 D3):注入数/体积可复测(metrics.py A 段数据源)。
          ...(readHandoff ? { readHandoff } : {}),
        },
      });
      if (permRules && isInProcessBackend) {
        journal.append({ kind: "permission.gate", sessionId: task.sessionId, payload: { tool: "spawn_subagent", effect: "derived", by: cap.denyOnly ? "derive-child-rules(profile deny-only)" : "inherit-parent-rules", ruleCount: cap.denyOnly ? deriveChildRules(permRules).length : permRules.length } });
      } else if (childRules && childRules.length > 0) {
        journal.append({ kind: "permission.gate", sessionId: task.sessionId, payload: { tool: "spawn_subagent", effect: "derived", by: "derive-child-rules", ruleCount: childRules.length } });
      }
      // 涉事符号上下文注入(step-034 F3,调用时机②):子 agent 动手前带调用链摘要。
      const symbolCtx = await symbolContextFor(subRoot, instructions);

      if (symbolCtx) {
        journal.append({ kind: "sense.preheat", sessionId: task.sessionId, payload: { kind: "spawn-context", symbol: firstSymbolLike(instructions) } });
      }
      // 后台模式(2026-10-13,ZCode async_launched 移植):onEvent 追加写 output.txt,
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
        // 后台外部后端的 permission-ask 不再悬空(权限传递收口):此前 bg onEvent 只认 progress/result,
        // 外部后端(bg)的 ask 永无应答=子进程挂死——与前台同链审批后回灌 handle。
        let bgHandleRef: import("@lampgenie/executors").SubagentHandle | undefined;
        const bgAsk = makeSubagentPermissionAsker({ sessionId: task.sessionId, journal, broker: permissionBroker });
        // 机制1(外部后端形态):deadline 到点由 wiring 收割——取消子进程,output.txt 已有轨迹打包为
        // 部分结果交付(ok=true 显式标注)。进程内后端不走此径(其收割在后端内部,部分结果含步数/最后输出)。
        const harvestExternalDeadline = () => {
          if (settled || deadlineFired) return;
          deadlineFired = true;
          settled = true;
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
          finalText = partial;
          events.push("result"); // 前台竞态路径(若仍在等)立即收割
        };
        if (!isInProcessBackend && deadlineMs > 0) {
          const t = setTimeout(harvestExternalDeadline, deadlineMs);
          t.unref?.();
        }
        const bgHandle = await effectiveBackend.spawn(
          {
            taskId: `${subTaskId}-bg`,
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
                  const entryBg = bgAgents.get(bgAgentId);
                  // 终态摘除 cancel 句柄:此后「终止」按钮经 server 诚实回 ok:false(已收尾)。
                  if (entryBg) { entryBg.status = e.result.ok ? "completed" : "failed"; delete entryBg.cancel; }
                  // B(2026-10-14):后台子代理也落 subagent.result 终态事件——此前只有 message.system,
                  // 投影 running 计数只增不减、面板历史卡重启后无终态可查。纯事件补齐,不改权限语义。
                  try {
                    journal.append({ kind: "subagent.result", sessionId: task.sessionId, payload: { taskId: subTaskId, parentTaskId: task.id, agentId: bgAgentId, event: { type: "result", ok: e.result.ok, finalText: String(e.result.finalText ?? e.result.error?.detail ?? "").slice(0, 300) } } });
                  } catch { /* 终态事件失败不影响子代理收尾 */ }
                  // 完成通知注入(ZCode background-tasks notification 语义 → 2026-10-30 免独立往返):
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
        // step-117:ACP 会话 id 落 journal(子代理工作区专用事件;主会话渲染过滤 subagent.event)
        if (bgHandle.acpSessionId) {
          try {
            journal.append({ kind: "subagent.event", sessionId: task.sessionId, payload: { agentId: bgAgentId, taskId: subTaskId, parentTaskId: task.id, kind: "acp.session", sessionId: bgHandle.acpSessionId, adapter: bgHandle.acpAdapter ?? rawArgs.adapter ?? "acp" } });
          } catch { /* 入账失败不影响执行 */ }
        }
        // subagent.cancel 句柄(G3 通路收尾):后台路径闭包读 bgHandleRef(spawn 未决时按下终止=诚实等待句柄就位后再取消);
        // 已收尾(settled)不挂——server 侧按「句柄缺席」回 ok:false。
        bgAgents.set(bgAgentId, { outputFile, status: settled ? (lastResultOk === false ? "failed" : "completed") : "running", sessionId: task.sessionId, model: subModelName, lastEventAt, spawnedAt: spawnStartAt, ...(deadlineMs > 0 ? { deadlineAt: spawnStartAt + deadlineMs } : {}), staleWarnMs, ...(settled ? {} : { cancel: () => bgHandleRef?.cancel("graceful") }), ...(subTitle ? { title: subTitle } : {}) });
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
      // 输出双模(designs/25):前台也会写输出文件——自动转后台后 task_output 才有完整轨迹可读。
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
          taskId: `${subTaskId}-sub`,
          instructions: instructions + symbolCtx,
          // workdir 按项目解析(step-035);worktree 模式=派生工作树(step-123)。
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
              }
            }
          } catch { /* 输出文件写失败不影响子代理 */ }
          if (e.type === "permission-ask") {
            journal.append({ kind: "permission.gate", sessionId: task.sessionId, payload: { tool: "subagent", effect: "asked", by: e.summary.slice(0, 120), risk: e.risk } });
            // 三级决策(step-037 B2):env > 面板审批 > auto-fail-closed。
            const applyDecision = (decision: "allow-once" | "reject", by: string) => {
              journal.append({ kind: "permission.gate", sessionId: task.sessionId, payload: { tool: "subagent", effect: decision === "allow-once" ? "allowed" : "denied", by } });
              if (subHandle) void subHandle.respondPermission(e.requestId, decision).catch(() => {});
              else pendingAsks.push({ requestId: e.requestId, decision });
            };
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
        // step-117:ACP 会话 id 落 journal(子代理工作区专用事件)
        if (h.acpSessionId) {
          try {
            journal.append({ kind: "subagent.event", sessionId: task.sessionId, payload: { agentId: bgAgentId, taskId: subTaskId, parentTaskId: task.id, kind: "acp.session", sessionId: h.acpSessionId, adapter: h.acpAdapter ?? rawArgs.adapter ?? "acp" } });
          } catch { /* 入账失败不影响执行 */ }
        }
        return h;
      });
      // B(2026-10-14):前台子代理运行期也入注册表——面板过程卡的实时状态源(session.status subagentList)。
      // 此前仅 auto-bg 后才入表,前台运行期(最长 180s)面板无从知道「有没有在工作」;
      // result 分支既有代码本就尝试更新该条目,此处补齐登记即可闭环。终态由 result 分支改写。
      // subagent.cancel 句柄(G3 通路收尾):前台路径闭包读 subHandle;已收尾不挂。
      bgAgents.set(bgAgentId, { outputFile, status: settled ? (lastResultOk === false ? "failed" : "completed") : "running", sessionId: task.sessionId, model: subModelName, lastEventAt, spawnedAt: spawnStartAt, ...(deadlineMs > 0 ? { deadlineAt: spawnStartAt + deadlineMs } : {}), staleWarnMs, ...(settled ? {} : { cancel: () => subHandle?.cancel("graceful") }), ...(subTitle ? { title: subTitle } : {}) });
      ensureSubagentWatchdog(journal);
      // ZCode 赛跑语义(designs/25):结果 vs 自动转后台计时器——超时→父拿 agentId 立即返回,子代理 detach 继续。
      // wait:true(2026-10-20 用户口径「选择等待=loop 挂起,结果回来机制唤起,等待期零 LLM」):
      // 显式选择等待时不参加 auto-bg 赛跑——挂在本工具 promise 上直到终态(deadline 收割保证终态必达,
      // 绝对上限=max(600s, deadline+90s) 防僵尸);loop 停在工具执行上不产生任何 LLM 调用。
      const autoBgMs = (agentConfig?.agent as { subagentAutoBackgroundMs?: number } | undefined)?.subagentAutoBackgroundMs ?? 180_000;
      const waitChosen = rawArgs.wait === true;
      const hardCapMs = Math.max(600_000, deadlineMs > 0 ? deadlineMs + 90_000 : 0);
      // 2026-10-20 生产实挂修复:旧实现靠裸 setTimeout(autoBgMs/hardCap) 触发转后台——代码正确但
      // 生产实测 180s 定时器未 fire(前台阻塞 19 分钟,靠子代理自然完成解卡;本地不复现,疑似 WSL
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
        bgAgents.set(bgAgentId, { outputFile, status: settled ? (lastResultOk === false ? "failed" : "completed") : "running", sessionId: task.sessionId, model: subModelName, lastEventAt, spawnedAt: spawnStartAt, ...(deadlineMs > 0 ? { deadlineAt: spawnStartAt + deadlineMs } : {}), staleWarnMs, ...(settled ? {} : { cancel: () => subHandle?.cancel("graceful") }), ...(subTitle ? { title: subTitle } : {}) });
      ensureSubagentWatchdog(journal);
        journal.append({ kind: "subagent.backgrounded", sessionId: task.sessionId, payload: { taskId: subTaskId, parentTaskId: task.id, agentId: bgAgentId, outputFile } });
        return JSON.stringify({
          status: "backgrounded",
          agentId: bgAgentId,
          outputFile,
          ...(worktree ? { worktreePath: worktree.path, worktreeBranch: worktree.branch } : {}),
          ...(worktreeResult ? { worktree: worktreeResult } : {}),
          ...(deadlineMs > 0 ? { deadline: `时间盒 ${deadlineMin} 分钟仍有效:到点自动收割部分结果` } : {}),
          // 2026-10-20 用户口径:等待还是继续由主 agent 自行判断,harness 只给事实与选项,不再指令「继续做其它工作」
          //(此前指令式 note 实测诱导主 agent 在等待期重复子代理任务书的勘察=双倍成本)。
          note: `前台等待 ${Math.round(autoBgMs / 1000)}s 超时,子代理已转后台继续运行(agentId="${bgAgentId}")。接下来由你判断:①它的结果是后续工作的硬依赖→用 task_output(agentId="${bgAgentId}",waitFor="result")挂起等到底(等待期零 LLM 消耗);②不是硬依赖→继续推进与它任务书不重叠的其它工作(不要重复它在做的事)。完成/超时/卡死时会有系统消息通知;卡死可止损重派。下次「派了就等」可直接 spawn(wait:true) 免去这一跳。`,
        });
      }
      signal?.removeEventListener("abort", forwardAbort);
      // 机制1 竞态面:deadline 收割(外部后端)已落过终态事件,不重复写。
      if (!deadlineFired) {
        journal.append({ kind: "subagent.result", sessionId: task.sessionId, payload: { taskId: subTaskId, parentTaskId: task.id, agentId: bgAgentId, event: { type: "result", finalText: finalText.slice(0, 300) }, ...(worktree ? { worktree } : {}) } });
      }
      return (finalText || "(子 agent 未返回结果)") + worktreeNote;
    },
  };

  // 2026-10-23 用户口径:开工不再做 orient/经验/devlog/历史档案的匹配式注入(此前每条 user
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

  // MCP 工具桥 + 浏览器工具先建(step-048 审计修复④:工具清单只提在场工具,含 MCP/浏览器)
  // MCP 工具桥(step-047):启用服务器的工具以 mcp__<server>__<tool> 并入工具面(fail-soft:探测失败=空集)。
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
  // 浏览器控制工具(step-048):门禁实时读 config(停用立即失效)。
  /* owner(2026-11 browser-ux-redo):主 agent 用 sessionId 做稳定归属(同一会话多任务同 owner 才不互抢);
   * 拿不到 sessionId 时回落 task.id,再回落 "agent"。 */
  const browserTool = browserConfig
    ? createBrowserTool(repoRoot(), browserConfig, task.sessionId || task.id || "agent")
    : null;
  // 公网静态读写工具(step-119):web_fetch/web_search 只读;交互操作仍归 browser。
  // 域名策略沿用 browser 的 allowDomains(面板热改),为空时回落 GENIE_WEB_ALLOW_DOMAINS。
  // 2026-10-21 三层能力:①web.search 配置层(设置页写入;provider/key 从配置/secrets 现读,
  // 面板保存即热生效——每次查询时解析,不缓存);②env provider 回退;③都无→内置静态检索
  // (DDG HTML)兜底。web_fetch 静态正文近空(JS 页)或失败时,browser 工具在场则真实渲染兜底。
  const searchRuntime = (): { provider: string; apiKey?: string; endpoint?: string; model?: string } | null => {
    try {
      const root = repoRoot();
      const web = readWebSearchConfigHot(root);
      // 2026-10-28 用户口径:provider 缺省=默认 DeepSeek(密钥引用名取自 providers[] 里
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
  // 系统提示组装(step-028;step-048 审计修复①②):
  // ①身份唯一化——SYSTEM 是唯一身份声明,soul 只贡献行为纪律(「语音管家」身份行剥离,refs:身份唯一);
  // ②AGENTS.md 随任务项目根(taskRoot,opencode findUp 就近语义)——此前钉死 harness 根=项目约定永不进提示词。
  // soul+memory(hermes 移植):SOUL.md 行为纪律为继承块;记忆块归 companion 轨(designs/20 P4)。
  // 子智能体注册表(内置+ .genie/agents/*.md 覆盖,ZCode profile 模式)
  const agentProfiles = loadAgentProfiles(repoRoot());
  const soulText = loadSoul(join(repoRoot(), ".genie", "soul")).content || DEFAULT_SOUL_MD;
  // system 瘦身(2026-10-22):toolHints/经验索引不再进 system(工具说明归 tools 参数+tool_view;
  // 经验归 loopTips 按动作注入)——这里不再组装 toolHints。
  // 子代理派发策略按后端形态定(用户实测:echo 占位下模型反复派 echo 子代理烧尽 maxSteps——
  // step-089 P3:项目底座认知注入——「项目主线」块(≤300 字符,防开发偏离主线)。
  // 读 taskRoot/.genie/sense-index/profile.json(同步,缺席=零注入零开销,不在此处触 LLM);
  // 生产者是 codesense project --write。GENIE_SENSE_PROJECT_INJECT=off 可关。
  const projectMainline = process.env.GENIE_SENSE_PROJECT_INJECT === "off"
    ? ""
    : projectMainlineBlockOf(taskRoot);
  // system 瘦身(2026-10-22 用户口径「只保留核心提示词,细节由 tips 动态注入」;2026-10-23 起
  // 经验也不再推送——按需 skill_view 查看;工具清单由 tools 参数+tool_view 按需承载)。
  // 提示词档位(2026-10-29 token 轮 P2):短任务书走精简档(SYSTEM_LITE),长任务书走全量。
  // 阈值 1450 字符 = 任务书原文长度,已在 16 题上验证 r=0.818;GENIE_SYSTEM_LITE=on/off 可强制开/关做 A/B。
  const instrChars = String(task.instruction ?? "").length;
  const liteMode = process.env.GENIE_SYSTEM_LITE === "off" ? false
    : process.env.GENIE_SYSTEM_LITE === "on" ? true
    : instrChars < 1450;
  const composed = composeSystemPrompt({
    base: systemForTaskClass(taskClassState.value, { lite: liteMode }) + "\n\n## 行为纪律(soul 继承,身份以上文为准)\n" + soulDisciplinesFor(soulText) + "\n\n" + formatAgentProfiles(agentProfiles) + projectMainline,
    agentsMd: discoverAgentsMd(taskRoot),
    // step-071 父子 ask-answer:「子代理资源调度」节(spawn 告知义务+审批决策指引)。
    subagentDispatch: renderSubagentDispatchSection({ answerToolMounted: true }),
    // n6 技能索引(主 agent 也注入,ZCode context/sections/skills.ts):与子代理同源同格式,
    // 预算 20000 字符,超预算降级为 name+file 一行。空索引=不渲染该节(renderSkillIndex 返回 "")。
    skillIndex: renderSkillIndex(collectSkillIndexEntries(store), SKILL_INDEX_MAX_CHARS),
  });
  // 保留节边界(2026-10-29 token 轮 04):旧写法 `const { text: system } = ...` 把 sections 丢掉,
  // 导致 loop 只能整篇 26~28K 字符重发 system 变更(实测 855 次调用 / 8.3M uncached / 占未命中 39.5%)。
  const system = composed.text;

  // 附件注入(step-048;2026 附件通道):文本类=路径进任务书 + read_attachment 工具可读;图片类=转 data URL 进 vision 通道。
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
            // 2026-10-29 附件链路:文档类走解析器(doc-text.ts,永不抛错),返回解析后的纯文本。
            const r = await parseDocFile(p, { name: att.name, mime: att.mime });
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
  // 权限闸门(step-033):规则在场才设;ask 处置 env 可调(缺省 fail-closed)。
  // 记忆上下文注入(step-029 收口):USER.md/MEMORY.md 渲染块进系统提示(空=不加节)。
  const memBlock = memory?.contextBlock("local") ?? "";
  // 会话目标注入(step-052 /goal):journal 最近一条 active goal → 系统提示(目标驱动跨轮任务)。
  const goalEv = [...journal.readAll()].reverse().find((e) => e.sessionId === task.sessionId && e.kind === "goal.set");
  const goalPayload = (goalEv?.payload ?? {}) as { goal?: string | null; state?: string };
  const goalBlock = goalPayload.goal && goalPayload.state !== "paused"
    ? "\n\n## 会话目标(用户当前的首要目标,决策时优先对齐)\n" + goalPayload.goal
    : "";
  // plan 模式(step-053,ZCode runtime_mode FULL 提醒逐字移植;ExitPlanMode→PLAN_COMPLETE 标记适配)。
  const planBlock = permissionMode() === "plan"
    ? planModePrompt()
    : "";
  // workspace 模式(权限模式第 5 档)提示:文件围栏只放行项目目录内,项目外路径被拒;命令/终端同口径
  // (terminal 注入 fenceCommand,命令文本里的项目外绝对路径/越界 .. 段下发前拒绝)。
  const workspaceBlock = permissionMode() === "workspace"
    ? "\n\n## 当前权限模式=工作区内\n只能读写当前项目目录内的文件,项目外路径(绝对路径 / .. 越界)一律被拒绝。命令/终端执行同样限在项目目录内(项目外路径会被拒绝;脚本内部的相对跳转与拼接触发器不在文本校验范围)。"
    : "";
  const planFileBlock = await planFileBlockFor(task.sessionId);
  // teamai 团队资产(designs/24):enforced 规则/文化/技能索引进系统提示(relay 不可达=空块,零影响)。
  const teamaiBlock = renderTeamaiBlock((globalThis as { __teamView?: { teamaiDigest(): Record<string, unknown> | null } }).__teamView?.teamaiDigest() ?? null);
  // 当前日期上下文(designs/25 ZCode current-date section 语义):模型默认不知今天几号,涉及
  // 日志检索/git 考古/「最近」类任务时必备。
  const now = new Date();
  const weekday = "日一二三四五六"[now.getDay()] ?? "";
  const dateBlock = "\n\n## 当前日期\n" + now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0") + "(周" + weekday + ")";
  // 系统提示的**节清单**(2026-10-29 token 轮 04):与 systemWithMemory 同内容,只是保留节边界。
  //
  // 作用:loop 侧的 `[系统提示更新]` 从「整篇 26~28K 字符重发」改成「只发变更的节」。实测旧口径
  // 855 次调用付了 8.3M uncached = 全部未命中 token 的 39.5%;而真实变更通常只涉及一两节
  // (AGENTS.md 摘要 / memory revision / 技能索引新增),其余节逐字节相同——重发是纯浪费。
  //
  // **单一真源(2026-10-30 修复)**:此前 blocksAll 用字符串 `+` 拼、systemSections 又手写一份,
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
  // steer_task(step-045 二期收口):向在跑任务的中途 turn 注入追加指令——loop 每 step 从
  // journal 重导出消息,注入的 message.user 会出现在下一次 LLM 调用里(真转向,不是假排队)。
  // task_output(2026-10-13,ZCode TaskOutput 语义):查后台子代理的进度与结果。
  // waitFor:"result"(2026-10-20 用户口径「选择等待=loop 挂起,结果回来机制唤起」):挂起直到终态——
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
    // 2026-10-30 降级(终态正文已自动注入,本工具从「收割主力」退成「补查」):读注册表 + 读输出文件
    // + 睡眠轮询,无副作用、无 journal 写入——与真实工作工具在**同一步**并行执行是安全的(step 成本
    // 不再多占一次往返)。停止等待由 signal 中止,不阻塞同级工具的收尾。
    isConcurrencySafe: () => true,
    async execute(args: unknown, signal?: AbortSignal) {
      const a = (args ?? {}) as { agentId?: string; waitSec?: number; waitFor?: string };
      const id = String(a.agentId ?? "");
      const entry = bgAgents.get(id);
      if (!entry) return `错误:未找到后台代理 ${id}(可能已过期或非后台派发)`;
      const waitForTerminal = a.waitFor === "result";
      // 挂起上限(watchdog 同源):设了时间盒=deadline+宽限;未设(2026-10-21 不限时口径)=无限等
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
      // 机制3(2026-10-15):无产出预警——运行中且超过 staleWarnMin 无任何事件→stale 标记。
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
  // ── 五硬阶段追踪(2026-10-20 用户口径:理解任务→规划→开始实施→开始验收→完成,
  // 每阶段写出来展示到看板,不涉及的也要声明;代码级管理追踪防越做越偏)──
  // 2026-10-21 用户口径修正:五阶段不再落白板(白板定位=设计草图)——阶段归宿与 todo_write 同形态:
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
    // P1-3 账本阶段零步(2026-10-30):task_phase 今日 97 次调用、每次独占一个完整 step(实测全仓
    // 1.0 工具/步),成本占 input 4.1~4.4%、单会话 8.4M。置 true 后它能与真实工作工具在**同一步**
    // 并行执行(loop 的 safe 批 Promise.all),阶段声明不再额外占一步。安全性:只写 phaseState(纯内存)
    // + journal.append(append-only,无读改写竞争);plan-gate 判定源仍是 journal 阶段事件,口径不弱化。
    isConcurrencySafe: () => true,
    async execute(args: unknown) {
      const a = (args ?? {}) as { phase?: string; note?: string; skip?: boolean; taskClass?: string; route?: string };
      // 直达实施路由(2026-10-24 用户口径:明确具体的需求直接实施,长链路才走完整流程):
      // 理解阶段判定→implement+route=direct→plan-gate 尺度豁免(免板直写);落板即回归全流程。
      if (a.route === "direct" && taskClassState.value === "coding" && !taskRouteState.direct) {
        taskRouteState.direct = true;
        try { journal.append({ kind: "custom", sessionId: task.sessionId, payload: { type: "task.route", taskId: task.id, route: "direct", source: "agent" } }); } catch { /* 留痕失败不影响 */ }
      }
      // 任务类别更正(2026-10-23):agent 在理解阶段确认/更正初判——后续 tips/plan-gate 全消费。
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
      // 阶段产出清单(2026-10-24 用户口径:阶段转换时刻恰时送达该阶段要点——不新增注入,随
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
  // run_parallel 已删除(step-056,用户口径「session 无权创建新 session」):它经 tm.submit 造新任务=新会话,
  // 违反「只有音频 agent/用户入口能建会话」。并行=ZCode Agent 机制:同一条消息里发多个 spawn_subagent
  // 调用(loop 对并发安全工具 Promise.all 同跑,loop.ts:242),全部是本会话内的子代理,由本会话自己管理。
  const permRules = loadPermissionRules(repoRoot());
  // 工具面非空门禁(step-064):空 tools 时 provider 的 toOpenAi() 不带 tools 字段=纯文本对话
  // (「工具未配置」观测的机制形态)——装配 bug 必须在首个 LLM 请求发出前 fail-visible,不静默降级。
  // 工具清单同步入 journal(task.progress.tools):此后任何「工具是否下发」质疑可直接以 journal 为证。
  // tool_view 按需注入(2026-10-22 用户口径:像 MCP 一样用时再看):长描述工具摘要为首句+指路,
  // 完整说明经 tool_view(name) 查看;tools 参数从 39k chars 级降到 schema+短描述。
  const changeSurfaceTool = makeChangeSurfaceTool({ journal: journal as unknown as ChangeSurfaceJournal, sessionId: task.sessionId, taskId: task.id, root: taskRoot });
  const mainTools: Tool[] = attachToolView([spawnTool, withAnswerAttentionGuard(buildSubagentAnswerTool(parentAskBroker)), codeSenseTool(taskRoot, taskRemoteProject ?? undefined), changeSurfaceTool, sessionSearchTool(journal, task.sessionId), codeReviewTool(taskRoot, models?.review, journal, task.sessionId, streamSink ? (note) => streamSink(task.sessionId, { type: "tool-progress", callId: "code_review", name: "code_review", note }) : undefined, checkpointSha, taskRemoteProject ?? undefined), runWorkflowTool(journal, executor, task.sessionId, workflowAskRouter), skillViewTool(store, () => disabledBuiltins(repoRoot())), experienceFoldTool(store), todoTool(journal, task.sessionId, { allowParallelInProgress: agentConfig?.agent?.todoAllowParallelInProgress === true }), ...(askUser ? [askUserTool(task.sessionId, askUser)] : []), teamTaskTool(journal, task.sessionId), boardUpsertTool(journal, task.sessionId, task.id, taskRoot, undefined, undefined, { onExempt: () => { boardExemptThisTask = true; }, taskClass: () => taskClassState.value }), boardExportPptxTool(task.sessionId, task.id, taskRoot), taskPhaseTool, boardReadTool(journal, task.sessionId, undefined, { boardId: task.id, fallbackToSessionBoard: true }), meetingImportTool(llm), steerTool, taskOutputTool, (() => {
        // 主 agent 终端(2026-10-20 卫生提醒 + 2026-10-21 绕写检测):命令含写文件形态且
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
          // git 审计(g1,2026-11-05):主 agent 不受限(放行),但命中 git 写/破坏命令时留痕
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
    // M27:后台命令 job(start/list/read/wait/kill)——长任务/构建/测试的独立句柄,结算只通知一次。
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
    // wait_until(2026-11-08 session 实证):条件等待原语——等外部进程产出(文件出现/含串/稳定)
    // 或终端输出静默,替代「sleep N; tail」式轮询(实测 582 次/13.4h sleep,每轮烧一次全量往返)。
    // 挂起期间 loop 停在本工具 promise 上(task_output waitFor 同机制),零 LLM 消耗。
    // 远程项目任务不注册(v1 文件条件走本地围栏;远端等待待远端 exec 语义再开)。
    ...(!taskRemoteProject ? [createWaitUntilTool({ owner: task.sessionId, root: taskRoot, terminalService: getTerminalService(journal) })] : []),
    ...createFileTools({
      root: taskRoot, journal, sessionId: task.sessionId,
      toolDumpDir: join(repoRoot(), ".genie", "tool-dumps"),
      ...(agentConfig?.coding?.lsp ? { lsp: agentConfig.coding.lsp } : {}),
      planGate: (tool) => planGateBlock(tool, `主 agent 直写(${tool})`),
      // 视觉能力(2026-10-25):vision=false 走 coding.vlm 兜底;vlm 每任务懒建缓存(provider 带重试/准入)
      ...(agentConfig?.coding ? { vision: visionBridgeFor(agentConfig) } : {}),
    }), ...(remoteProjectTool ?? []),
    // M170(2026-11-07):交付物登记排在 file tools 之后(产出文件→登记路径→收尾核对)。
    makeDeliverableTool({ journal: journal as unknown as DeliverableJournal, sessionId: task.sessionId, taskId: task.id, root: taskRoot }),
    ...mcpTools,
    ...(browserTool ? [browserTool] : []), ...webTools,
    // M169(2026-11-07):引用账本排在 web 工具之后(先抓再引),收尾按登记表校验正文 [n]。
    makeCiteSourceTool({ journal: journal as unknown as CitationJournal, sessionId: task.sessionId, taskId: task.id }),
    ...(readAttachmentTool ? [readAttachmentTool] : [])]);
  // M147 工具面即 SDK(PTC/代码模式):coding 任务追加 run_code——沙箱内一次调用跑多步工具链,
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
  // M153 工具注册身份治理:装配后统一登记身份,冲突/保留名命中从工具面剔除并留 journal 证据。
  const governedTools = governToolIdentity(mainTools, journal, task.sessionId);
  if (governedTools.length !== mainTools.length) mainTools.splice(0, mainTools.length, ...governedTools);
  if (mainTools.length === 0) {
    recordUser();
    const curGate = tm.get(task.id);
    if (curGate && (curGate.state === "running" || curGate.state === "blocked")) tm.setState(curGate, "failed", "主 agent 工具装配为空(tools=[])——拒绝以纯文本形态启动 loop(装配 bug fail-visible)");
    return;
  }
  // M167 表面/通道能力包(2026-11-08):本 session 最后一条 client.surface 声明的能力位决定
  // ①输出契约(注入 instruction)②GUI 工具过滤 ③收尾降级。无声明=LEGACY:契约空串/工具原样/不降级。
  const surfacePlan = planTaskSurface(journal, task.sessionId, task.id, mainTools);
  journal.append({ kind: "task.progress", sessionId: task.sessionId, payload: { taskId: task.id, tools: surfacePlan.tools.map((t) => t.name), toolCount: surfacePlan.tools.length } });
  // 写前持久化屏障装配(config.agent.writeBarrier 透传;缺席/非法=undefined,loop 内部缺省 hard)。
  const writeBarrier = writeBarrierOf(agentConfig);
  const loop = new AgentLoop({
    journal,
    sessionId: task.sessionId,
    system: systemWithMemory,
    // system 的节视图(2026-10-29 token 轮 04):让 loop 的 `[系统提示更新]` 只发变更节。
    // 不传=旧行为(整篇全文重发),故这一行本身就是「其它构造点零影响」的分界。
    systemSections,
    llm,
    // 执行 deadline 帽(2026-10-29 冻结治理):自管工具(spawn/ask_user/terminal 等)豁免,
    // 其余 600s——防单工具挂死拖住整个 agent;详见 llm-loop-backend withToolDeadlineDefaults。
    tools: surfacePlan.tools,
    // step-132:每次 chat 的全量 messages+响应落 .genie/llm-trace/<sessionId>/,journal 挂 llm.trace 指针。
    llmTrace: makeLlmTraceSink(journal),
    ...(streamSink ? { onStream: (ev: AgentStreamEvent) => streamSink(task.sessionId, ev) } : {}),
    // 权限传递收口:ask 处置收进 buildMainLoopPermission(mode=ask+面板在场→审批卡,不再静默 deny)。
    ...(permRules ? { permission: buildMainLoopPermission(permRules, permissionBroker, { sessionId: task.sessionId, journal }) } : {}),
    maxSteps: agentConfig?.agent?.maxSteps ?? 3000, // 设置页可配+热读(2026-10-22 用户口径上限 3000)
    // 写前持久化屏障(config.agent.writeBarrier):只显式传"off"|"hard";undefined 不写键(留给 loop 缺省 hard)。
    ...(writeBarrier ? { writeBarrier } : {}),
    // M58 图片 offload:装配方必须传,否则 loop 层整条分支不生效(生产默认关闭=改前行为)。
    imageOffload: imageOffloadOf(repoRoot()),
    todoReminderSteps: 6, // designs/25 ZCode todo reminder:每 6 步提醒一次未完成计划(ephemeral)
    // step-137 上下文再锚定:每 10 步注入一次 P0 落目标清单+证据覆盖率(ephemeral 不落 journal)。
    // 实锤教训:长任务跑几十步后板上写的 P0 验收彻底脱离注意力,完工时无人核对(桌面 exe「首启引导」事故)。
    boardReminderSteps: 10,
    // J1 轨迹卡接线(2026-11 token 轮):runtime 已实现 emitTrajectory,装配处不传 opts 则永不落卡
    // (面板轨迹条恒空 + tips 的 ctx.trajectory 恒 undefined = P0 断线)。每 5 步或 phase 切换落一条
    // `task.trajectory`(payload 只有计数/比率/子目标,不含对话正文,零上下文影响)。
    trajectorySteps: 5, // J1:每 5 步(或 phase 切换)旁路落一条 task.trajectory 轨迹卡
    trajectoryTaskId: () => task.id,
    trajectoryMeta: () => ({ phase: phaseState.current, subgoal: currentSubgoal(journal, task.sessionId, task.instruction) }),
    // 轨迹 → 任务进度(J1 接线闭环,2026-11):emitTrajectory 真正 due 的那次(每 5 步/phase 切换)
    // 把 phase/step/note touch 进 TaskSupervisor,面板进度条与 task 卡据此更新。旁路:applyTrajectoryProgress
    // 内部吞异常且 tm 缺失即跳过——进度写失败绝不影响 turn 主链;不碰状态迁移(setState 调用点不改)。
    onTrajectory: (ev) => applyTrajectoryProgress(tm, task.id, ev),
    // 待决审批 ephemeral 注入(2026-11-03 token 治理):见 parentAskBroker.onPending 注释——
    // 旧口径 message.user 永久落 journal,已了结的审批块滞留历史每次请求重放(2.7M token/日)。
    // 现改为每步现算:待决期间可见,应答/超时后 pending 清空 → 注入自然消失,历史零滞留。
    pendingQuestions: () => renderPendingQuestionsBlock(parentAskBroker.pending().slice(0, 8)) || null,
    boardReminder: async () => {
      try {
        // 任务类别锚(2026-10-23):非编码类不推五阶段/白板——每 10 步只锚类别约定与更正路径;
        // 更正回 coding 后自动恢复完整阶段锚+P0 清单。
        if (taskClassState.value === "qa") {
          return "<system-reminder>本任务为问答/调研类:直接调查输出结论(结论先行+出处),不改代码不落板;需要改代码时 task_phase(taskClass=\"coding\") 更正。</system-reminder>";
        }
        if (taskClassState.value === "office") {
          // 作业思路板锚(2026-11-05 用户口径「办公任务也可以在白板上画作业思路(主题/受众/结构/
          // 章节/章间关系/顺序)」):office 已从软提醒改为硬闸,每 10 步锚一次出路(落板 / exemptReason)。
          // 既有断言文案(office-writing/开工四问/论点四段/人话写作/交付前自查)一字不动。
          return "<system-reminder>本任务为办公/产出类:动笔前先落**作业思路板**——board_upsert 传 boardType=\"composition\",画清:主题是什么/受众是谁/表达结构/要几章/每章主题/章与章之间什么关系、顺序如何(章间关系用 data 边 label 写关系词);确无表达结构才用 exemptReason 豁免(不许拿豁免代替思路板)。然后 skill_view 对应技能(office-writing + 对应格式);开工四问先答完(面向谁报告/主题一句话/重点 1~2 条与这次不讲什么/论据与分析来源);每个论点主张+论据+分析+结论四段齐全,写反证;人话写作;流程/结构/趋势画图;交付前自查;涉及改代码时 task_phase(taskClass=\"coding\") 更正。</system-reminder>";
        }
        if (taskRouteState.direct) {
          return "<system-reminder>本任务为直达实施路由(明确小改):聚焦改动本身,改前 impact 查影响面;发现范围超出单文件/局部 → 先落板(board_upsert)回归全流程;完成后照常 verify。</system-reminder>";
        }
        // 五阶段锚(2026-10-20 防偏):reminder 开头带当前流程阶段——上下文再长,阶段锚每 10 步可见,
        // 模型偏离当前阶段该做的事时由此自我校正。阶段未声明过=提醒补声明(硬流程入口)。
        const curIdx = phaseState.current ? PHASES.findIndex((p) => p.key === phaseState.current) : -1;
        const phaseLine = curIdx >= 0
          ? `当前流程阶段:「${PHASES[curIdx]!.label}」(${curIdx + 1}/5)——只做本阶段该做的事;进入下一阶段用 task_phase 声明。`
          : `本任务尚未声明流程阶段——开工即调 task_phase(phase="understand") 进入五阶段流程(理解任务→规划→开始实施→开始验收→完成),不涉及的阶段用 skip:true 声明。`;
        // 板根对齐(2026-10-21 修正):reminder 与 board_upsert/面板同根(boardStoreRoot=repoRoot()),
        // 主根读不到再回退 taskRoot。旧 repoRoot()/taskRoot 单根读在任务不在 harness 根时读不到板。
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
    // tips 即时信息增强(2026-10-21):代码意识/历史对齐/派发三类,做对应类别的事之前注入(一次为限)。
    // SOP 阶段信号接线(2026-11 tips SOP 化):loop 每 step 组装 tips ctx 时调 tipsPhase 取
    // phaseState.current,phase 首见 → SOP 行式卡恰时注入(见 buildLoopTips)。
    tipsPhase: () => phaseState.current,
    tips: loopTips,
    // 压缩钩子(R5-C9):与 spawn 子代理共用同一实例(2026-10-20 同源;构造见上方 taskCompactHook)。
    compactHook: taskCompactHook,
    // step-140 microcompact 阈值接线:与 spawn 子代理共用同一阈值(构造见上方 taskMicrocompact)。
    microcompact: taskMicrocompact,
    // 写时定形 spill(2026-11 token 轮 02):与 spawn 子代理同源(构造见上方 taskSpill)。
    spill: taskSpill,
    // 大结果入口闸门(step-1029):与子代理同源(构造见上方 taskBigIntake)。
    bigIntake: taskBigIntake,
    // Phase 0 增长突增:与子代理同源;0=关闭。
    growthSpurtTokens: taskGrowthSpurtTokens,
    // Phase 1/2 模型评分:与子代理同源;默认本地 150M Jev。
    ...(taskModelScoring ? { modelScoring: taskModelScoring } : {}),
  });

  // 取消注册表登记(step-008 收口):task.cancel → onChange → loop.cancel() 贯通。
  activeLoops?.set(task.id, loop);
  // M16 轮末变更账本(2026-11-07):基线在 try 外声明——终态出口在 finally,需跨块可见。
  let changeBaseline: Awaited<ReturnType<typeof captureBaseline>> | null = null;
  let changeLedgerStartSeq = -1;
  // M5 完成审计(2026-11):变更账本结果缓存——完成审计要在终态出口之前出一行「变更账本」，
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
  // M23 指导可度量:任务窗口起点(与验证账本/变更账本同口径,开工水位);finally 里算指标用。
  let guidanceStartSeq = -1;
  try {
    // 核心纪律卡(2026-10-20 起;2026-10-21 瘦身:只留系统纪律;2026-10-23 按任务类别出三版——
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
        "- 动笔前先 skill_view:任何产出读 builtin/office-writing;PPT→office-pptx + ppt-master(产线/版式/能力边界),Word→office-docx,Excel→office-xlsx,周报/复盘/方案/调研→office-report",
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
    // 2026-10-21 用户口径:user message 只留用户需求+系统纪律。orient/经验/devlog/历史档案
    // 四块改由 loopTips 按动作类别即时注入(understand/plan 阶段或首触对应工具),不再开工全塞。
    let instruction = task.instruction + "\n\n" + disciplineCard;
    // M167:能力位输出契约(legacy="" 不注入,零变化);task.surface 开工一次落账
    // (taskId/sessionId/caps/source/filteredTools/contractApplied,读侧取最新一条)。
    if (surfacePlan.contract) instruction += "\n\n" + surfacePlan.contract;
    try { journal.append({ kind: "custom", sessionId: task.sessionId, payload: surfacePlan.journalPayload }); } catch { /* 留痕失败不影响开工 */ }
    // ── M162 执行信封:开工前比对签发时的能力目录/策略 ──────────────────────────
    // 有信封且漂移/篡改 → 任务 failed(403 文案)+ journal task.envelope {ok:false,code},不起 loop;
    // 无信封(内部 user 任务)→ verifyTaskEnvelopeAtStart 返回 undefined,逐字零变化。
    try {
      const capCurrent: CapabilitySnapshot = envelopeDeps?.capabilitySnapshot?.() ?? {
        toolsets: surfacePlan.tools.map((t) => t.name),
        commands: BUILTIN_COMMANDS.map((c) => c.name),
      };
      const policyCurrent: EnvelopePolicy = envelopeDeps?.policy?.() ?? {
        approval: permissionMode(),
        maxIterations: agentConfig?.agent?.maxSteps ?? 3000,
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
    // ── 开工前置门(M9,2026-11-08)────────────────────────────────────────────
    // 两段都在任务窗口起点(taskStartSeq)之前落账,任务窗口包含前置门事件;两段各自 try/catch 兜底:
    // 前置门自身异常绝不影响开工(最多少一条注入,不会拦任务)。
    // a. 基线新鲜度:非 coding/GENIE_FRESHNESS=off/配置关闭 → skipped;behind 且 blockOnBehind
    //    (缺省 true,env GENIE_FRESHNESS_BLOCK=off 或配置可降级)→ 拦在首轮 runTurn 之前。
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
    // M107 验证账本水位(2026-11-07):任务窗口起点=开工时全局水位;收尾用 readSession(sid, startSeq)
    // 只取本任务事件(不全量 readAll,免 30MB 会话重扫,也不会把上一任务的验证算进来)。
    const taskStartSeq = journal.length;
    // M26(2026-11-08)续跑身份护栏:开工时快照会话目标的修订号(与 taskStartSeq 同段)。终态调
    // maybeContinueGoal 时仅在非 null 才作为 expectedRevision 传入——任务运行期间 goal 被 clear/replace
    // (每条 goal.set 使 revision+1)→ 续跑被 GOAL_REVISION_STALE 拒,不会把旧任务的进展接到新目标上。
    // 无目标 / 读失败 = null(不阻塞开工)。用 readSession(会话索引切片),不为此全量 readAll。
    let taskStartGoalRevision: number | null = null;
    try {
      const { readGoalFromJournal: readGoalAtStart } = await import("@lampgenie/runtime/agent/goal");
      taskStartGoalRevision = readGoalAtStart(journal.readSession(task.sessionId), task.sessionId)?.revision ?? null;
    } catch { taskStartGoalRevision = null; }
    // M23 指导可度量:同一水位(本任务窗口起点)供收尾 guidance.metrics 切片。
    guidanceStartSeq = taskStartSeq;
    // M16 轮末变更账本:开工建 git 基线(异步 execFile,不阻塞事件循环);失败=null 不阻塞任务。
    changeLedgerStartSeq = taskStartSeq;
    try { changeBaseline = await captureBaseline(taskRoot); } catch { changeBaseline = null; }
    // 任务开工审计锚(2026-10-24):类别/纪律卡版本/系统提示指纹/纪律段在场标志一次性落账——
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
          // 2026-11-04 观测修复:coding+短任务书走 SYSTEM_LITE(五阶段/plan-gate/验收段落被有意
          // 裁掉)时,下方 flags 全 false 是**精简档的正常形态**——不记 lite 字段时审计者无法区分
          // 「精简档(正常)」与「提示词组装 bug(段落丢了)」。lite=true 即可一票定案。
          lite: taskClassState.value === "coding" && liteMode,
          // 全链路变更判据(2026-11-06):changeScope=surface 表示本任务是替换/迁移类,
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
      // step-052:面板显示原始输入(注入块只喂模型,不再污染用户消息展示)。
      displayText: task.instruction,
      ...(task.attachments?.length ? { attachments: task.attachments } : {}),
    });
    const cur = tm.get(task.id);
    if (cur && (cur.state === "running" || cur.state === "blocked")) {
      // step-052 同族双写收口:loop 已为每个 step 落 message.agent——仅当本轮没有任何 agent 消息
      // (如 pre-step 拦截直接返回空)才补终稿;否则面板把回复渲染两遍("收到/收到")。
      const events = journal.readAll();
      const lastTurn = [...events].reverse().find((e) => e.kind === "turn.start" && e.sessionId === task.sessionId);
      const hasAgent = lastTurn
        ? events.some((e) => e.kind === "message.agent" && e.sessionId === task.sessionId && (e.seq ?? 0) > (lastTurn.seq ?? 0))
        : false;
      if (!hasAgent) journal.append({ kind: "message.agent", sessionId: task.sessionId, payload: { text: String(out ?? "") } });
      // plan-gate 收尾校验(2026-10-20 防目标丢失最后一道,代码级):板在场但 P0 未全绿——
      // 任务虽可完成,outcome 必须显式标注(fail-visible;不硬 block 防死锁,但目标状态不可谎报)。
      const finBoard = await planBoard();
      let finalOut = out;
      if (finBoard) {
        // 规划质量结构化留痕(2026-11-06,B2 P2):任务结算即带 boardType/内容节点数/P0 覆盖率/锚密度,
        // 面板/telemetry 直接读这一条,不用重放板。与 audit 出口的 planQuality 同源(planQualityOf)。
        // bq3(2026-11-05 遥测闭环):骨架采纳维度并入 planQuality,同一 pqObj 落 task.quality
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
      // 全链路收尾审计(2026-11-06 用户口径「证明没有残留、没有孤儿、没有只改一半」):
      // surface 任务在最终 answer 前应有 passed 的 change.audit;没有/未通过 → 回执警告 +
      // 验收摘要标记「未通过全链路审计」(不硬杀任务,但状态可审计,不许静默宣称完成)。
      // 第二批(2026-11-06):agent.changeAudit = hard|warn|off(env GENIE_CHANGE_AUDIT 优先),
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
      // ── M107/M169/M170/M5 公共收尾聚合(2026-11-07:抽公共函数,三条链同源)──────────
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
        ...(changeFacts ? { changeFacts } : {}),
        ...(ledgerFacts ? { ledgerFacts } : {}),
        mode: "main",
        modes: { verify: verifyMode, citation: citationMode, completion: completionMode },
        retryTurn: (prompt: string) => loop.runTurn(prompt),
      });
      finalOut = closeout.finalText;
      if (closeout.hardFail) {
        // hard 模式补跑后仍不满足:代码/引用不回滚,任务终态如实 failed(与旧行为一致)。
        tm.setState(cur, "failed", closeout.hardFail.reason);
        return;
      }
      // task.context 快照刷新(2026-11-06):开工那条记的是启动时事实(盘点还没发生=0),
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
      // 任务终态档案(2026-10-20):instruction+五阶段轨迹+板摘要+结果——compact 恢复与 planner 复用的数据源。
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
      // M167 收尾降级(显式,不静默):最终输出超表面 maxChars → 截断+追加标记,
      // 并 journal surface.degraded {originalChars,maxChars,degradedChars}。
      // 交付/投递用同一文本;legacy(无任何声明)不降级=改动前行为逐字不变。
      finalOut = degradeFinalFor(journal, task.sessionId, task.id, surfacePlan.caps, finalOut).text;
      tm.setState(cur, "done", finalOut);
    }
    // 终态提炼(异步不阻塞:done 后台沉淀经验;前台优先=下个任务到来不等待)
    trackPostTerminal(task.sessionId, distillFromTask(getExperienceStore(), journal, { ...task, state: "done", result: out }));
    // 记忆学习(step-029 收口):会话终态→extractor+observer(内部门控:少 user 轮不跑)。
    if (memory) {
      const transcript = journal.readAll()
        .filter((e) => e.sessionId === task.sessionId && (e.kind === "message.user" || e.kind === "message.agent"))
        .map((e): { role: "user" | "assistant"; content: string } => ({ role: e.kind === "message.user" ? "user" : "assistant", content: String((e.payload as { text?: string }).text ?? "") }));
      trackPostTerminal(task.sessionId, memory.onSessionClose({ ownerId: "local", sessionId: task.sessionId, transcript }));
    }
    // goal 续跑循环(step-053,ZCode target-continuation-loop 移植):任务终态→完成校验器
    //(LLM JSON 裁决,fail-open)→未通过且预算未尽→自动派下一轮续跑任务。
    // M26(2026-11-08):带任务开工时快照的目标修订号(无目标=不传),目标被 clear/replace → 拒续跑。
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
    // ── M16/M23 收尾聚合(2026-11-07:抽公共函数,与终态路径同一实现)──────────────
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
    // ── M27 后台 job 回收(2026-11-07)──────────────────────────────────────────
    // 任务终态(done/failed/取消)回收本会话 owner 与绑定到该会话的子代理 owner 的 running job
    //(标 killed 并只通知一次);disposeSessionJobs 内部吞异常,回收失败不影响终态。
    await disposeSessionJobs(journal, task.sessionId);
  }
}
