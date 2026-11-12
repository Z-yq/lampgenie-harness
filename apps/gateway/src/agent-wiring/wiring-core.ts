/**
 * agent-wiring 分片:wiring-core(自 agent-wiring.ts 7910 行按域拆分,逐字搬移)。
 * 原路径 agent-wiring.ts 保留具名转发 barrel;消费方零改动。
 */
import { journalGate } from "./permission.js";
import { runningWorkflows } from "./tools.js";
import { decidePermission, riskOfTool } from "./permission.js";
import type { PermissionAskPort } from "./permission.js";
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
  agentConfig?: { agent?: { writeBarrier?: "off" | "hard" } } | undefined): "off" | "hard" | undefined {
  const v = agentConfig?.agent?.writeBarrier;
  return v === "off" || v === "hard" ? v : undefined;
}

/**
 *  图片 offload 装配口径(纯函数,可单测):provider 报「图片预算/尺寸」类错误时,
 * data URL 落盘到 `<root>/.genie/image-offload/<sessionId>/` 后用占位行立即重试一次。
 * **根取 repoRoot**(与 spill/tool-dumps/llm-trace 等 .genie 落盘根一致),不取 taskRoot:
 * taskRoot 在多项目任务下可能指向别的项目仓,落盘位置会随项目漂移;offload 产物属于运行时
 * 证据(.genie 下),统一在 harness 仓根。**默认开启**:不提供配置开关,需要关闭的调用方不传
 * `imageOffload` 即可(loop 层整条分支不生效,行为逐字不变)。
 */
export function imageOffloadOf(root: string = repoRoot()): { root: string } {
  return { root };
}

/** 参与「裸块 → 节」映射的一个块(修 f1:此前手写两份清单,漏了 plan/workspace)。 */
export interface NamedSystemBlock { name: string; content: string }

/**
 * 裸块 → 具名节(纯函数,可单测)(修 f1)。
 * **病根**:system 全文用字符串 `+` 拼(`memBlock + goalBlock + planBlock + workspaceBlock + planFileBlock`),
 * 而给 loop 做节 diff 用的 `systemSections` 另手写一份,两份清单不同步 → 漏了 plan/workspace。
 * 后果不是「少发一点」而是**静默丢规则**:plan 模式与「工作区内」权限模式的约束文本在全文里,
 * 但节 diff 永远看不到它们变化 → `[系统提示更新]` 零追加 → 模型收不到「现在是 plan 模式,
 * 不许改代码」。省 token 绝不能换行为退化。
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

/** 主 loop 权限闸门选项(权限传递):规则在场才设闸。
 * ask 处置:env GENIE_PERM_ASK_MODE=allow 或 mode=auto → allow(快路径,不变);
 * mode=ask 且 broker 在配 → onAsk 走面板审批(审批卡;超时/离线=拒绝,fail-closed 不变)——
 * 此前主 loop 的 ask 被静默 deny 且无任何审批入口(生产环境 journal 注意 97 次
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
 // 单调收窄:guard 链 deny → 直拒(不咨询规则/面板);session-always 命中 → 直放;
 // abstain 继续走下面的面板审批(空链 + 空存储时与旧行为逐字一致)。
        const guardEv = decidePermission({ tool: call.name, summary: preview, sessionId: ctx.sessionId, journal: ctx.journal });
        if (guardEv.effect === "deny") {
          journalGate(ctx.journal, ctx.sessionId, call.name, "denied", "guard-denied");
          return false;
        }
        if (guardEv.effect === "allow") {
          journalGate(ctx.journal, ctx.sessionId, call.name, "allowed", "session-always");
          return true;
        }
 // 审批对象=执行对象:冻结真正要执行的调用(name+arguments);面板放行后复核,变了按拒绝。
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
export function getExperienceStore(): ExperienceStore {
  return new ExperienceStore(join(repoRoot(), ".genie", "experiences"));
}

/** 持久终端服务:按 journal 实例缓存——同进程多 app(测试)互不串会话;
 * owner 隔离由 tool 绑定的 task.sessionId 承担。审计落 journal custom 事件(core EventKind 既有通用口)。 */
const terminalServices = new WeakMap<object, TerminalSessionService>();
export function getTerminalService(journal: Journal): TerminalSessionService {
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

/* ===== 会话工作所有权(owner/generation)接线 =====
 * 注册表由装配方(app.ts)注入,按 journal 实例缓存——与 terminalServices/jobRegistries 同纪律
 * (同进程多 app(测试)互不串会话)。未注入=整套逻辑 no-op,旧行为逐字不变。
 * 关闸/级联顺序/代际判定全部由 OwnerRegistry 负责,这里只做「登记 + 终态 settle + 取消」三件事。 */
const ownerRegistries = new WeakMap<object, OwnerRegistry>();

/** 取本 journal 对应的注册表;未注入=undefined(调用方据此跳过失落)。 */
function ownerRegistryOf(journal: Journal): OwnerRegistry | undefined {
  try {
    return ownerRegistries.get(journal as unknown as object);
  } catch {
    return undefined;
  }
}

/** 装配期绑定(journal → registry);重复装配覆盖为最新一份(测试内多 app 各自一份)。 */
export function bindOwnerRegistry(journal: Journal, registry: OwnerRegistry | undefined): void {
  if (!registry) return;
  try {
    ownerRegistries.set(journal as unknown as object, registry);
  } catch { /* 绑定失败=降级 no-op */ }
}

/** 代际来源说明:这些登记点(parentId/工具工厂层)拿不到 loop 的 turn 序号或任务 generation,
 * 故用**进程内单调递增计数器**作代际——每次登记取一个新代际,迟到回调凭旧代际被 settle 拒收
 * (STALE_GENERATION),与 OwnerRegistry 的「换代递减」语义一致。 */
let ownerGenerationSeq = 0;
function nextOwnerGeneration(): number {
  ownerGenerationSeq += 1;
  return ownerGenerationSeq;
}

/** terminal 单元索引(unitId=终端会话 id → 所属服务与 tool 侧 owner):取消时据此调 service.close。 */
const terminalUnitOwners = new Map<string, { owner: string; service: TerminalSessionService; generation: number }>();

/** 登记一个工作单元;返回本次代际(未注入注册表/登记被拒=undefined,调用方按 no-op 处理)。 */
export function registerOwnedUnit(journal: Journal, input: { unitId: string; kind: OwnerUnit["kind"]; ownerSessionId: string }): number | undefined {
  const registry = ownerRegistryOf(journal);
  if (!registry) return undefined;
  const generation = nextOwnerGeneration();
  const r = registry.register({ unitId: input.unitId, kind: input.kind, ownerSessionId: input.ownerSessionId, generation });
  if (r.code !== "OK") {
 // CLOSING=owner 已关闸(会话正在关门),新单元不该再冒出来;只告警,不改变既有执行路径。
    console.warn(`[ownership] 单元登记被拒(${input.kind}:${input.unitId}):${r.code}`);
    return undefined;
  }
  return generation;
}

/** 终态 settle:旧代际迟到(会话关闸/重开换代后旧实例才回来)→ 丢弃,不更新状态,只告警。 */
export function settleOwnedUnit(journal: Journal, unitId: string, generation: number | undefined): void {
  if (generation === undefined) return;
  const registry = ownerRegistryOf(journal);
  if (!registry) return;
  const r = registry.settle(unitId, { generation });
  if (r.code === "STALE_GENERATION") {
    console.warn(`[ownership] 丢弃旧代际终态:${unitId}@${generation}(代际已换代,结果不写回新实例)`);
    return;
  }
  if (r.code !== "OK") console.warn(`[ownership] settle 失败:${unitId}(${r.code})`);
}

/** 关会话时的取消 hook(由 app.ts 注入 server)。
 * kind=terminal → 对应 terminal 服务的 close(owner-close);kind=subagent → 既有 cancel 句柄;
 * kind=workflow → 引擎 run 内部 AbortController(WorkflowEngine 未暴露公开 abort 方法,运行时可达;缺失则只 warn)。
 * 本函数可抛错:调用方(server)负责兜底 settle;单元状态不记 error,只 console.warn。 */
export async function cancelOwnedUnit(unit: OwnerUnit): Promise<void> {
  try {
    if (unit.kind === "terminal") {
      const entry = terminalUnitOwners.get(unit.unitId);
      if (!entry) { console.warn(`[ownership] 终端单元无服务索引,跳过:${unit.unitId}`); return; }
      await entry.service.close(entry.owner, unit.unitId, "owner-close");
      terminalUnitOwners.delete(unit.unitId);
      return;
    }
    if (unit.kind === "subagent") {
      const cancel = bgAgents.get(unit.unitId)?.cancel;
      if (!cancel) { console.warn(`[ownership] 子代理无 cancel 句柄(可能已收尾):${unit.unitId}`); return; }
      await cancel();
      return;
    }
    const engine = runningWorkflows.get(unit.unitId) as unknown as { abort?: { abort?: (reason?: string) => void } } | undefined;
    const controller = engine?.abort;
    if (typeof controller?.abort === "function") { controller.abort("owner-close"); return; }
    console.warn(`[ownership] workflow 引擎未暴露 abort,靠 run 时间盒自然收敛:${unit.unitId}`);
  } catch (err) {
    console.warn(`[ownership] 取消失败(${unit.kind}:${unit.unitId}):`, err instanceof Error ? err.message : String(err));
  }
}

/** terminal open 成功后登记 ownership(unitId=终端会话 id)。未注入注册表=原样返回,零行为变化。 */
export function ownTerminalUnits(tool: Tool, deps: { journal: Journal; owner: string; sessionId: string; service: TerminalSessionService }): Tool {
  const orig = tool.execute.bind(tool) as (a: unknown, s?: AbortSignal, c?: { callId: string }) => Promise<string>;
  return {
    ...tool,
    async execute(args: unknown, signal?: AbortSignal, ctx?: { callId: string }): Promise<string> {
      const result = await orig(args, signal, ctx);
      try {
        const action = String((args as { action?: unknown } | null)?.action ?? "");
 // 会话工作所有权:显式 close = 该终端单元终态 → settle。
 // 不 settle 的话单元永远停在 running,会话关闸时 pending 恒非空且会对已死会话再发一次 cancel。
        if (action === "close") {
          const closingId = String((args as { sessionId?: unknown } | null)?.sessionId ?? "");
          const entry = closingId ? terminalUnitOwners.get(closingId) : undefined;
          if (entry) {
            settleOwnedUnit(deps.journal, closingId, entry.generation);
            terminalUnitOwners.delete(closingId);
          }
          return result;
        }
        if (action !== "open") return result;
        const parsed = JSON.parse(String(result)) as { sessionId?: unknown; id?: unknown } | null;
        const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId : typeof parsed?.id === "string" ? parsed.id : "";
        if (!sessionId) return result;
        const generation = registerOwnedUnit(deps.journal, { unitId: sessionId, kind: "terminal", ownerSessionId: deps.sessionId });
        if (generation !== undefined) terminalUnitOwners.set(sessionId, { owner: deps.owner, service: deps.service, generation });
      } catch { /* 登记失败不影响终端工具结果 */ }
      return result;
    },
  };
}

/** 父代答/路由 note 门:answer_subagent 的 reason 按 route-note(30 词)截断。
 * 截断不拦应答——批准/拒绝语义必须照常落到 broker;只把超长理由收短。 */
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

/** 终端交付门:终态通知摘要标记 purpose=result,按 chat 预算校验;超长截断但**不拦任务**,
 * 失败/截断只 journal custom attention.blocked {code,kind,words}。正文注入(output.txt 片段)
 * 属机器内容,不受注意力预算约束,预算只覆盖人读的通知摘要。 */
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

/** 工具注册身份治理:装配完成后把整张工具面登记一遍身份,冲突/保留名命中从工具面剔除,
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

/**  后台命令 job 注册表:按 journal 实例缓存(与 terminal 服务同纪律)。
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

/**  任务终态回收:本会话 owner + 绑定到该会话的子代理 owner 的 running job 全部结算(killed)。
 * 错误吞掉:回收失败不影响任务终态。 */
export async function disposeSessionJobs(journal: Journal, sessionId: string): Promise<number> {
  try {
    return await getJobRegistry(journal).disposeSession(sessionId);
  } catch {
    return 0;
  }
}

/** 主 agent 在场工具面(单一出处:系统提示组装与设置页共用,防两处漂移)。
 * 逐环审计修复:本表必须与 runWithAgent 实际挂载的 tools 数组一一对应——
 * 此前「memory」在表但从未挂载(模型被告知有该工具,调用必得「未知工具」)、
 * todo_write/import_meeting/steer_task/task_output 挂载了却不在表(标题「只列实际挂载的」双向失真)。 */
/**
 * 视觉桥装配:coding.llm.vision(缺省 true)+ coding.vlm 兜底 provider。
 * vlm 端点懒建缓存(多数部署主模型多模态,永不会触达);凭证不可解析时如实抛错 fail-visible。
 */
const vlmProviderCache = new Map<string, LlmProvider>();
export function visionBridgeFor(config: { coding?: { llm?: { vision?: boolean }; vlm?: { model?: string; baseUrl?: string; providerId?: string; apiKeyEnv?: string } } }): {
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
  { name: "list_agents", hint: "列出本任务的子代理(含全部后代):agentId/状态/模型/耗时/截止/标题/结果摘要;includeDone=false 只看运行中" },
  { name: "stop_agent", hint: "中断指定子代理:只能停自己的子代理,只影响该 agentId(兄弟/父任务不动);跨任务/不存在拒绝" },
  { name: "steer_agent", hint: "向运行中的子代理追加指令(hint/directive,下个 step 生效):只能操作自己的后代;非运行态拒绝(已终态改用 resume_agent)" },
  { name: "resume_agent", hint: "冷启动续跑已终态子代理:原任务书+上次结果摘要+本次指令,派新 agentId(原记录不动);只能续跑自己的后代" },
  { name: "ask_user", hint: "向用户发问并等待答复(许愿式编程:需求有取舍/范围可能膨胀时先问再动;给 2~4 个选项+你的推断依据;问题会同时进 Super Agent 指挥台「待处理」,先答先用;离线/超时返回未答复,按最合理推断继续)" },
  { name: "read_file", hint: "读项目内文本文件(带行号,支持 offset/limit 分窗)" },
 // 远程项目任务的 read_file/write_file/edit_file/glob/grep/list_dir/run_cmd 即远端同名七件
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
 // fixG(先骨架后丰羽翼+开发类型分治):工具索引提示补骨架先行与分治起手线
 // fixG :豁免口径绑定板规模(≤3 模块且骨架 ≤9 节点装得下)——防「任务书恰提 3 个功能模块」被读成小任务绕过分阶段
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


// code_index 工具已删除(合并):结构动作并入 code_sense(action=...),
// 工具定义见 sense-tool.ts(唯一入口;graph/filegraph/api 三动作同步删除)。

// 后台子代理注册表(ZCode async agent):agentId→输出文件与状态(spawnTool 写/task_output 读)。
// model(子代理目录):本子代理实际使用的模型名(目录条目「当前模型」数据源)。
// lastEventAt(机制3):最近一次子代理事件时刻——task_output 据此算 stale 标记(主 agent 止损依据)。
// cancel( subagent.cancel 通路最后一步):面板目录「终止」按钮→server 查条目 cancel 句柄调用;
// 仅运行中条目持有(终态即摘除=「已收尾」时 server 诚实回 ok:false),各路径闭包读各自的 handle 变量。
// spawnedAt/deadlineAt/staleWarnMs/staleNotified(防死机制):watchdog 巡检输入——
// spawnedAt=派发时刻;deadlineAt=时间盒到点时刻(应收割却仍 running=后端内部收割失灵);staleNotified=预警只发一次。
export const bgAgents = new Map<string, { outputFile: string; status: string; sessionId: string; title?: string; model?: string; lastEventAt?: number; cancel?: () => unknown; steer?: (text: string, mode: "hint" | "directive") => Promise<boolean>; spawnedAt?: number; deadlineAt?: number; staleWarnMs?: number; staleNotified?: boolean }>();
// 供 server task_output 读取(注册表本体归 agent-wiring 所有)
(globalThis as { __bgAgents?: typeof bgAgents }).__bgAgents = bgAgents;

//  后台子代理 idle wake:后台单元完成后,若父会话已空闲(同 session 无 running/queued 任务、
// 上一 turn 已结束且过了保护窗),起一次 model-only system 任务消费通知;父会话仍在跑/刚收尾
// 一律不打扰——它下一 turn 自己会看到通知,硬插 turn 会让同一 session 两个模型 turn 并发。
// 判定与 prompt 拼装在 runtime/task/idle-wake(纯逻辑);这里只做数据装配与提交。
const idleWakeNotified = new Set<string>();
const IDLE_WAKE_NOTIFIED_MAX = 500;

export function maybeWakeIdleSession(
  journal: Journal,
  sessionId: string,
  tm: Pick<import("../task-manager.js").TaskSupervisor, "list" | "submit">,
  opts: { now?: number; minIdleMs?: number; maxBatch?: number } = {},
): { code: WakeCode; submitted: boolean; ids: string[] } {
  const now = opts.now ?? Date.now();
  try {
 // 父会话在跑的任务数(running/queued 都算忙:排队中的用户任务随时会起 turn)。
    let activeTaskCount = 0;
    try {
      activeTaskCount = tm
        .list({ sessionId })
        .filter((task) => task.state === "running" || task.state === "queued").length;
    } catch { /* 任务列表不可用按 0 处理:后面还有「turn 已结束」与 generation 两道门 */ }

 // 上一 turn 结束时刻 + 当前代次:journal 最近一条 turn.end;generation 缺省用 turn 号,再缺省 0。
    let lastTurnEndAt: number | undefined;
    let currentGeneration = 0;
    try {
      for (const ev of journal.readSession(sessionId)) {
        if (ev.kind !== "turn.end") continue;
        if (typeof ev.time === "number") lastTurnEndAt = ev.time;
        const turn = (ev.payload as { turn?: unknown } | undefined)?.turn;
        currentGeneration =
          generationOfEvent(ev as unknown as { payload?: { generation?: unknown } }) ||
          (typeof turn === "number" ? turn : 0);
      }
    } catch { /* 读 journal 失败 = 结束时刻未知:走保守口径(不唤醒),不猜 */ }

 // 待投递 = registry 里本会话终态且尚未被唤醒消费过的条目(ack 标记在 idleWakeNotified)。
    const pending: PendingNotification[] = [];
    for (const [agentId, entry] of bgAgents) {
      if (entry.sessionId !== sessionId) continue;
      if (entry.status !== "completed" && entry.status !== "failed") continue;
      if (idleWakeNotified.has(agentId)) continue;
      const explicitGeneration = (entry as { generation?: unknown }).generation;
      pending.push({
        id: agentId,
        at: entry.lastEventAt ?? entry.spawnedAt ?? 0,
 // 未显式带 generation 的条目视为当前代:生产上 registry 不记代次,若按 0 比对会恒判 stale
 // (当前代通常是非 0 的 turn 号),唤醒永不触发。显式带代次时才做旧代过滤。
        generation: typeof explicitGeneration === "number" ? explicitGeneration : currentGeneration,
        kind: entry.status === "completed" ? "子代理完成" : "子代理失败",
        summary: entry.title ?? agentId,
      });
    }

    const verdict = wakeVerdict({
      sessionId,
      now,
      ...(lastTurnEndAt !== undefined ? { lastTurnEndAt } : {}),
      activeTaskCount,
      pendingNotifications: pending,
      currentGeneration,
      ...(opts.minIdleMs !== undefined ? { minIdleMs: opts.minIdleMs } : {}),
      ...(opts.maxBatch !== undefined ? { maxBatch: opts.maxBatch } : {}),
    });
    if (!verdict.wake || !verdict.prompt) {
      return { code: verdict.code, submitted: false, ids: verdict.ids };
    }

 // 同一批 ids 的幂等键:重复回调(deadline 收割后又来迟到 result 等)不会起第二个唤醒 turn。
    const idempotencyKey = `idle-wake:${sessionId}:${verdict.ids.join(",")}`;
    tm.submit("system", sessionId, verdict.prompt, { title: "[唤醒] 后台单元完成", idempotencyKey });
    for (const id of verdict.ids) {
      idleWakeNotified.add(id);
      if (idleWakeNotified.size > IDLE_WAKE_NOTIFIED_MAX) {
        const oldest = idleWakeNotified.values().next().value;
        if (typeof oldest === "string") idleWakeNotified.delete(oldest);
      }
    }
    try {
      journal.append({ kind: "custom", sessionId, payload: { type: "idle.wake", ids: verdict.ids, code: verdict.code } });
    } catch { /* 留痕失败不影响「唤醒已提交」的事实 */ }
    return { code: "WAKE", submitted: true, ids: verdict.ids };
  } catch (err) {
 // 通知链的失败不许影响子代理收尾:只告警。
    console.warn("[gateway] idle wake 失败(不影响子代理收尾):", err instanceof Error ? err.message : String(err));
    return { code: "INVALID", submitted: false, ids: [] };
  }
}

// :子代理生命周期注册表(进程级单例;不取代 __bgAgents 镜像,只在其上补「状态机 + 后代关系」)。
// 同一 gateway 进程内每个 task 都会 wire 一次,这里用 globalThis 复用同一实例;首次创建时从
// __bgAgents 镜像 restore(终态保留、已存在记录不覆盖)。registry 是纯逻辑零 IO 模块,可被单测直驱。
export const subagentRegistry: SubagentRegistry = (() => {
  const g = globalThis as { __subagentRegistry?: SubagentRegistry };
  if (g.__subagentRegistry) return g.__subagentRegistry;
  const reg = new SubagentRegistry();
  const mirror = (globalThis as {
    __bgAgents?: Map<string, { status: string; sessionId: string; title?: string; model?: string; lastEventAt?: number; spawnedAt?: number; deadlineAt?: number }>;
  }).__bgAgents;
  if (mirror && mirror.size > 0) {
    try {
      const restoreState = (status: string): "running" | "done" | "failed" | "cancelled" | "interrupted" =>
        status === "completed" ? "done" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "running";
      reg.restore([...mirror.entries()].map(([agentId, en]) => ({
        agentId,
        taskId: "",
        sessionId: en.sessionId,
        ...(en.title ? { title: en.title } : {}),
        ...(en.model ? { model: en.model } : {}),
        state: restoreState(en.status),
        spawnedAt: en.spawnedAt ?? Date.now(),
        ...(en.lastEventAt !== undefined ? { lastEventAt: en.lastEventAt } : {}),
        ...(en.deadlineAt !== undefined ? { deadlineAt: en.deadlineAt } : {}),
      })));
    } catch { /* 镜像恢复失败不影响后续新注册 */ }
  }
  g.__subagentRegistry = reg;
  return reg;
})();

// 冷启动续跑需要原任务书与角色(registry 只存状态/摘要,不存任务书正文;改 registry 形状超出本任务文件边界)。
// 进程内映射;进程重启后缺席 → resume_agent 如实 NOT_FOUND/INVALID,不编造「原任务」。
export const SUBAGENT_BRIEF_CAP = 200;
export const subagentBriefs = new Map<string, { instructions: string; agentType?: string; title?: string }>();

/** watchdog 硬收割缓冲:deadline 到点后给后端内部收割路径(deadline 定时器/backend 自身)留的宽限,
 * 超过它仍 running 才认定「收割失灵=子代理已死」(进程内 loop 崩溃/外部后端进程僵死均属此类)。 */
export const SUBAGENT_WATCHDOG_GRACE_MS = 60_000;
// 无时间盒条目不再有兜底硬上限——
// 未设 deadlineMin 的子代理只受 stale 预警(可见性),永不被 watchdog 判死。

export interface SubagentWatchdogAction {
  agentId: string;
  kind: "stale-warn" | "reap-dead";
  idleMs: number;
 /** reap-dead:从派发/到点起算已超时的毫秒数。 */
  overMs?: number;
}

/** watchdog 扫描纯函数(防死机制,直测锚):对注册表里 running 条目判两类死态——
 * ①idle>staleWarnMs 且未预警过→stale-warn(只发一次,主 agent 知情后可止损重派);
 * ②设了时间盒且超过 deadline+宽限仍 running→reap-dead(收割失灵=子代理已死,必须强制终态,
 * 否则条目永远 running、父会话永远等不到通知)。未设时间盒(deadlineAt 缺席)=不限时,只①不②
 *。终态条目不产生任何动作。 */
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
 // :watchdog 收割也是终态来源之一——registry 同步落 failed,否则 list_agents 永远显示 running。
    subagentRegistry.update(act.agentId, { state: "failed", resultSummary: "[watchdog 收割] 超过时间盒+宽限仍无终态,已判死并强制收尾" });
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
 * 会话 worker 模式下由 app.ts 直接调用(gateway 不走 wireAgentLoop,巡检对象=镜像注册表)。 */
export function ensureSubagentWatchdog(journal: Journal): void {
  if (subagentWatchdogTimer) return;
  subagentWatchdogTimer = setInterval(() => {
    try { runSubagentWatchdog(journal); } catch { /* 巡检异常不致命:下一轮再试 */ }
  }, 60_000);
  subagentWatchdogTimer.unref?.();
}

// ── 终态后异步收尾追踪(会话 worker:退出前等 distill/memory/goal 收尾落定)──
const postTerminalPending = new Map<string, number>();
export function trackPostTerminal(sessionId: string, p: Promise<unknown>): void {
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

// ── 任务终态档案(记录所有已实施任务/规划,compact 后可再注入快速恢复;
// planner 基于历史规划做新规划)──append-only .genie/task-archive.jsonl,每条:任务摘要+五阶段轨迹+板摘要。