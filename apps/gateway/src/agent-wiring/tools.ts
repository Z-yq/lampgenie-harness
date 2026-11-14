/**
 * agent-wiring 分片:tools(自 agent-wiring.ts 7910 行按域拆分,逐字搬移)。
 * 原路径 agent-wiring.ts 保留具名转发 barrel;消费方零改动。
 */
import { BOARD_AUDIT_DIR } from "./permission.js";
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
/** :ask_user 答复归一化——路由正常回 string;若上游传对象(选项对象/结构化答复)取可读字段,绝不 [object Object]。 */
function askAnswerText(answer: unknown): string {
  if (typeof answer === "string") return answer;
  if (answer && typeof answer === "object") {
    const rec = answer as Record<string, unknown>;
    for (const field of ["text", "label", "answer", "key"] as const) {
      const v = rec[field];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    try { const json = JSON.stringify(rec); if (json !== "{}") return json; } catch { /* 循环对象退回空 */ }
  }
  return answer === null || answer === undefined ? "" : String(answer);
}

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
 // 注意力预算:一次只问一个具体问题(结构化),外发消息必须有用途(decision);
 // 不通过即回工具错误(稳定码+可操作提示),绝不落到面板消耗用户注意力。
      const gate = guardAskUserPayload({ question: a.question, options: a.options, context: a.context });
      if (!gate.ok) return gate.message;
      try {
        const answer = await askUser.ask(sessionId, { question: gate.question, options: gate.options, context: gate.context });
        if (answer === null) return "(用户未答复——按你推断的最合理范围继续,并在汇报开头说明按哪个选项执行)";
        return "用户答复:" + askAnswerText(answer);
      } catch (err) {
        return "ask_user 失败(" + String(err).slice(0, 120) + ")——按你推断的最合理范围继续,汇报时说明。";
      }
    },
  };
}

/**  todo 严格整表纪律:条目状态枚举 + 内容上限。 */
const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
type TodoStatus = (typeof TODO_STATUSES)[number];
const TODO_CONTENT_MAX = 120;
const TODO_ERROR_MAX = 600;

/** todo_write 工具(ZCode TodoWrite 对应物):多步任务的工作计划落 journal,
 * session.status 投影据此驱动面板进度小窗(todo n/m)。
 *  严格校验:空 items/未知键/空或超长 content/未知 status/重复 content 全部显式失败且不落
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

/** board_upsert 工具(代码级落目标):语义流程白板——代码改动类任务「先画后改」。
 * agent 落 BoardDoc(模块节点+干什么+改动类型+函数内语义流程,节点可挂 code_sense 查到的符号);
 * 全量覆盖语义(同 todo_write),rev 自增;落盘 .genie/boards/<sid>/<taskId>.json +
 * journal board.update + bus 广播。**fail-soft:任何失败只回话术,绝不阻塞任务**。
 * 窄 schema 是刻意的:summary/flow 强制非空,防白板写成任务复述。
 * 三动作(同一工具、同一板文件,免多工具漂移):
 * - action=upsert(缺省):落整板。P0 节点必须带 accept(否则拒收录板,见 P0 落板门);
 * status=done 还要求 P0 全部有 ok=true 证据(门)。
 * - action=evidence:按 nodeId 追加 evidence(at 服务端补),回执带最新覆盖率;该节点验收全绿时顺带 done=true。
 * - action=audit:只读核对——返回 P0 清单+逐条证据状态+覆盖率(不写盘)。all=true 扫本会话全部板。
 * q4 子写者独立板(架构修复):`opts.partition=true`(planner 子代理来源)+ 有 scope 时,
 * 本写者的板 id 变成 `<taskId>-<scope>`,即落**独立板文件** `.genie/boards/<sid>/<taskId>-<scope>.json`,
 * 不再并进调用方(主 agent)的任务板。缺陷现场:主 agent 板本只有 4 个 P0 节点,两个 planner 以
 * scope=bp/kb 并入后 `action=audit` 报 4/24(17%)——审计跨任务计分,主 agent 永远无法宣称完成。
 * 主 agent(构造时不带 partition/scope)路径逐字不变,仍是 `<taskId>.json`。 */
/** 规划质量结构化字段(B2 P2 遗留:面板任务结算直接读,不用重放板。
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

/** 三位小数舍入(板质量遥测):率字段统一口径,避免 0.3333333 漂进 journal。 */
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** bq3(遥测闭环):骨架采纳率纯函数——board.skeleton 事件的 landed 并集(分母)
 * vs 终板 sk- 前缀节点存活数(分子)。分母 0(本会话没落过骨架)返回 null=整段不落。 */
export function computeSkeletonAdoption(
  finNodes: readonly unknown[],
 // journal 事件是 JournalEvent<unknown>(payload 宽类型),收 unknown 再结构断言,防逆变报错。
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
 /** 豁免留痕回调:agent 传 exemptReason 声明「本任务确实没有开发内容/表达结构」时
 * 调用(由调用方把 boardExemptThisTask 置真 → plan-gate 放行)。只留痕,不写板。 */
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
 /** 紧凑 DSL 主路径:一行一语句,比逐节点全字段 JSON 省 60%+ 输出。 */
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
 /** 豁免留痕(可选;不新增工具、只复用本工具入参):声明「本任务确实没有开发
 * 内容/表达结构」时不写板,只落 journal board.exempt → plan-gate 放行。不与 nodes/dsl 同给。 */
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
        const { loadBoardAsync: loadBoardA, saveBoardAsync, listBoardsExAsync, mergeBoardNodes, withBoardLock } = await import("../board-store.js");
        const { computeP0Coverage, markDoneFromEvidence, renderP0Status, validateChangeContract, validateCallEdges, validateBoardTypeConformance } = await import("../board-accept.js");
        const root = storeRoot ?? repoRoot();
        const action = a.action ?? "upsert";
 // 豁免留痕(用户拍板「office 走硬闸 + 豁免留痕」):action 未指定或 upsert 且**只**带
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
 // 即落独立板文件 `<taskId>-<scope>.json`。缺陷现场:主 agent 板本只有 4 个 P0 节点,
 // 两个 planner 以 scope=bp/kb 并进同一块板后 audit 报 4/24(17%)——审计跨任务计分。
 // 主 agent(工具构造时不带 partition、也无 scope)boardId 恒等于 taskId,行为逐字不变。
        const boardId = opts.partition && scopeId !== "" ? `${taskId}-${scopeId}` : taskId;
 // q4 配套:planner 落独立板后,实施者(主 agent)必须能把验收证据回到**planner 的板**
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


 // ---- action=skeleton:现状层骨架自动预填----
 // 从 code-sense 索引快照生成 keep 节点+真实 call 边;锚经三态核验(broken 剔除、moved 刷行号
 // 后复验、targets missing/outside 剔项);planner 之后在底版上补变更层(add/modify 带 before)。
        if (action === "skeleton") {
          if (targetError) return targetError;
          const { buildSkeleton, normalizeSkeletonRequest } = await import("../board-skeleton.js");
          const { resolveBoardLinksAsync, resolveTargetPathsAsync } = await import("../board-store.js");
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
 // bq2(遥测闭环):rejected 也落账——骨架生成了多少/为何全剔,基线表要有这一行。
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
 // bq2(遥测闭环):骨架 ok 也落账——landed/剔除四桶/采纳基线(结算面
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

 // ---- action=audit:只读核对(P0 清单+证据+覆盖率),不写盘 ----
        if (action === "audit") {
 /** :format=json 的结构化出口(execute 仍 string;JSON 是字符串内容)。 */
          const jsonFormat = a.format === "json";
          const boardsOut: Array<Record<string, unknown>> = [];
          const targets: string[] = [];
 // q4 缺省只核对**本写者自己的板**(boardId);跨看必须显式 all:true
 // (缺陷现场:子写者并入主板后,主 agent 的 audit 把自己的 4 个 P0 和别人的 20 个一起算成 17%)。
 // targetTaskId 显式指定本任务的分区板=审计 planner 的原始契约。
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
 /** 变更契约自检:跨板收集,回执统一点名(只提示不拒收)。 */
          const contractLines: string[] = [];
 /** 板型一致性门:与通用契约自检分开,JSON 单列 typeIssues。 */
          const typeLines: string[] = [];
 /** 分组累积器:id 前缀 → P0 通过/总数;`""`=无前缀(裸 n1 这类)归「(无前缀)」组。 */
          const groupAcc = new Map<string, { passed: number; total: number }>();
          const symbolByBoard = new Map<string, string[]>();
          let grandTotal = 0;
          let grandPassed = 0;
          let grandCovered = 0;
 // 规划质量主视角板:第一块成功载入的目标板;all=true 时语义见 jsonFormat 出口注释。
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
 // 收尾自检(板规范 §七):symbolRef 幻影引用核对——实施后符号挪位/改名,
 // 板上的引用会断链(broken=幻影)或漂移(moved);只读盘上索引(缺席退化为文件锚判定)。
          const phantom: string[] = [];
 // targets 真实性核对:板上 targets 常是幻影路径(写错/不存在/绝对路径)。
 // 只报不判——targetIssues 不进 ok 计算;scope 分区口径与下面 symbolRef 核对一致。
          const targetIssues: string[] = [];
          try {
            const { resolveBoardLinksAsync, resolveTargetPathsAsync } = await import("../board-store.js");
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
 // 规划质量字段(B2 P2):以**本任务主视角**输出——audit 目标板里第一块成功
 // 载入的就是主视角板(all=true 跨板时 grand 本就只作参考;字段语义=「本任务规划质量」)。
            const pq = planQualityOf(pqMainDoc ?? { nodes: [] });
 // audit 落盘(N1 注意「9 条清单事后取不到」):JSON 结果写
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
 // bq1(遥测闭环):audit 结果旁路落 board.audit——跨会话消费(基线表/看板)
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
 // 批量回填:一次调用可回填多节点(旧 nodeId 单节点路径逐字不变)。
 // 经验证一个 3 节点板原来要 3 次 evidence 调用(每步 ~18k input token)→ 现在 1 次。
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
 // evidence 可顺带定板状态;done 仍走门(P0 证据全绿)校验,避免无证据。
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
 // (经验证某板 42 节点里 16 个是同写者自造双份,全部 done:false/evidence:[]/comments:[] 零人的痕迹)。
 // 安全门:①候选必须同时给 nodeIds 或 scope;②**每个**候选都要「零痕迹」(!done && 无 evidence && 无 comments),
 // 有痕迹一律拒删并点名 protectedIds;③缺省 dryRun(只报不删),必须显式 dryRun:false + confirm:true 才写盘;
 // ④真删时同步剔除 from/to 命中被删 id 的边(否则 saveBoard 的边引用完整性校验会拒收);
 // ⑤saveBoard 带 skipGates(删掉 P0 节点后落板门/门会误判)。
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
 // 的其它节点一起删,planner 经验证显式清 9 个旧节点却报「删完剩 0」)。
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
 // dsl 主路径:LLM 写紧凑 DSL,这里解析成 nodes/edges 再走既有落板管线。
 // dsl 与 nodes 同给时按节点 id 合并:dsl 为准(基底+顺序),JSON 只补 dsl 写不了的字段(白名单见 board-dsl.ts),
 // JSON 独有 id 不并入;edges 仍由 dsl 硬覆盖。
        let dslNodes: unknown[] | undefined;
        let dslEdges: unknown[] | undefined;
        let dslMeta: { title?: string; boardType?: string; scale?: string; docKind?: string } | undefined;
        let dslDiagNote = "";
        if (typeof a.dsl === "string" && a.dsl.trim() !== "") {
          const { parseBoardDsl } = await import("../board-dsl.js");
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
 // dsl 与 nodes 同给时**按节点 id 合并**:dsl 为基底与顺序,JSON 只补 dsl 写不了的字段
 // (flow/evidence/comments/wf/fileRef/done/pos);JSON 独有 id 不并入(防两版并板);edges 仍 dsl 硬覆盖。
        let dslMergedNote = "";
        let effNodes = a.nodes;
        if (dslNodes !== undefined) {
          const { mergeDslWithNodes } = await import("../board-dsl.js");
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
 // P0-4 模板接线:参数 template=smoke|preflight 直接把模板节点并进本板(板上已有同 id 则保留人工版本)。
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
 // f2 跨写者 id 撞车硬拒:并行子代理各自从 n1 顺排、共用同一块板时,
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
 // board.save),所以「换 id 重画」会让旧的那套永久留在板上——经验证曾出现同一 planner 两套 16 节点,
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
 // 板类型:显式参数优先;未传时保留板上已有值(改板不丢类型),再退 design。
          const docKindIn = (effDocKind ?? existing?.docKind ?? "design") as string;
 // 文档体裁( docs 通用机制):显式优先,未传保留已有值(改板不丢)。
          const docGenreIn = (typeof a.docGenre === "string" && a.docGenre.trim() !== ""
            ? a.docGenre.trim()
            : (existing as { docGenre?: string } | null | undefined)?.docGenre ?? undefined) as string | undefined;
 // 关系自动推导:显式边优先,再按
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
 // 就会整板拒收 → 该板之后任何写者都永久失败(upsert 无删边语义=死锁)。经验证 3 个并行 planner
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
 // 落板门/门的拒收必须说清「哪不满足」,并给出补救路径(否则 agent 只会重试同样输入)
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
 // P1-1 写板回执内联状态( token 优化,替代模型板后 board_read 确认):
 // 经验证 web-1793279074382 里 62 次 board_read、53 次拿到 49 字符「未变更」存根却每条付满上下文
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
 // 变更契约自检:软提示,不拒收——存量板/人工节点缺字段不能让落板失败。
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
 // (经验证同一 planner 换 id 重画后板上出现两套 16 节点,旧实现只报「保留人工改动」没点破)。
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
 // 自愈更正回执:kind 校正/label 截断不是静默改板——必须让模型看见改了什么,
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

/** board_read 工具(页面结构板配套):只读读回本会话白板——「后续轮 agent 不断参考」的
 * 最小方案(按需读取不占每轮 token)。返回最新板的紧凑文本(节点 id/kind/label/summary/位置/用户评论+边)。
 * 只读(plan 模式可用);无板=明确说无板,不编造。
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
 // 03 同参去重( token 优化):经验证 93 个 session 里同目标重读 1,437 轮、其中 1,418 次
 // 逐字节相同(最狠一块 2,160 字符的板被读 155 次),且 microcompact 的 NEVER_COMPACT_TOOLS 把
 // board_read 排除在裁剪外——重复读=纯 token 浪费。判据只用 rev(BoardDoc.rev,三处写路径
 // upsert/evidence/prune 均自增),同 key 同 rev 才走短提示。
 // key 必须含板 id 与 all 语义:只按 sessionId 缓存会让「换 taskId 读另一块板」命中旧内容(错的静默丢数据)。
  const lastRead = new Map<string, string>(); // key → 上次返回时的板指纹(rev;all 口径=板数+逐板 rev)
  const lastStep = new Map<string, number>(); // key → 上次全量返回发生在第几步(短提示里点名用)
 // 连发逃逸计数(无限循环事故:模型陷入 20+ 步同参重读,每步只拿到 49 字符存根——
 // 死胡同无出口)。⚠必须挂实例作用域:放 execute 里每次调用重建 Map,计数永远到不了 3,
 // 逃生阀=死代码(注意:38 步 board_read 死循环里存根一次全文都没回)。
  const stubStreak = new Map<string, number>(); // key → 连续命中存根次数(全量返回即清零)
 // 压缩失效判据(2026-11 修静默丢板内容):auto-compact 会把旧的 board_read 结果整段挤出上下文,
 // 而这张 dedup 缓存不感知压缩 → 压缩后模型再读同一块板只拿到「board 未变更…勿重读」,但正文
 // 已不在上下文 = 模型再也拿不到板内容(静默错误,板是验收契约,比多花 token 严重得多)。
 // 修法:记录上次全量返回时 journal 的最后 seq,命中缓存前扫 seq 之后是否有带非空 summary 的
 // compact.done(真压缩边界口径,与 loop/compact-gate 一致);有=缓存失效,强制返回全文。
  const lastAtSeq = new Map<string, number>(); // key → 上次全量返回时 journal 的最后 seq
 /** 一次遍历同时取:最近 step.start 的 step(短提示点名用)+ sinceSeq 之后是否发生过真压缩
 * + 当前会话最后 seq(供下次做基线)。把原 stepNow 的全量扫描合并进来,命中/未命中都只扫一遍。 */
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
        const { listBoardsExAsync: listBoardsExA, loadBoardAsync: loadBoardB } = await import("../board-store.js");
        const root = storeRoot ?? repoRoot();
 /** 同参同 rev → 一行短提示(<200 字符)代替全文;rev 变了、首次调用、或上次全量返回之后
 * 发生过真压缩(正文已被挤出上下文)才返回全量。连发逃逸:同一 key 连续第 3 次命中存根
 * =模型明确需要内容而拿不到,直接给全文+换路指路,不再坚持去重。 */
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
 // 第 2 次连续存根附激活标记:经验证死锁里模型的意图是「写板」而非「读板」——读缓存
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
 // 过期证据提示与 audit 同源(staleSummaryOf),无 stale 时逐字不变。
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

/** teamai 团队资产 → 系统提示块:enforced 规则全文+文化底色+规则/技能索引(渐进披露)。 */
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
 * 而 Buffer.subarray(0,n).toString 可能在多字节字符中间切断——末尾会落一个 U+FFFD 替换符。
 * 故截断后剥掉尾部所有 U+FFFD,保证模型看不到乱码。
 */
export function truncateSkillBytes(text: string, maxBytes = SKILL_VIEW_MAX_BYTES): { text: string; total: number; truncated: boolean } {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= maxBytes) return { text, total, truncated: false };
  const cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
  return { text: cut + `\n…(截断:全文 ${total} 字节,已读 ${maxBytes})`, total, truncated: true };
}

/** `${GENIE_SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` → 技能目录绝对路径(ZCode skill.ts:62-72)。
 * 无目录(内置/团队资产不在磁盘上)时原样保留,不编造路径。 */
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

/** skill_view 工具( §3):读经验全文,view 计数进遥测。
 * 停用门(审计 C3):索引已过滤停用项,但全文读取无门——停用的内置技能
 * 仍可被 skill_view 绕过索引读全文,禁用面形同虚设。
 * n7:三个分支(builtin/teamai/用户经验)统一走 `<skill_content name=…>` 包裹 + 变量展开 +
 * 100000 字节截断(此前 8000 字符裸 slice,长技能被腰斩且断在多字节中间)。 */
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

/** experience_fold 可写类目白名单( §3「白名单内写」;distill 的 incidents 兜底同在表内)。 */
export const FOLD_CATEGORY_WHITELIST = ["coding", "ops", "tooling", "workflow", "incidents"];

/** experience_fold 工具( §3):白名单内写,fold-in=同名覆盖更新(version+1)。 */
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
          a.body);
        return `已沉淀 ${a.category}/${a.name} v${fm.version}(fold-in)`;
      } catch (err) {
        return `experience_fold 错误: ${String(err).slice(0, 200)}`;
      }
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * workflow 资产 / 运行期 caps / 运行中 amend(工具面)。
 * - 资产目录:project=<repoRoot>/.genie/workflows,global=~/.genie/workflows;asset 先查 project 再查 global。
 * - caps 只影响「之后新开的派发」,amend 因此不重启当前 run(语义见 harness-workflow/engine.ts)。
 * - 新增参数全部可选:旧调用(只给 template/args/script)渲染与返回字段逐字不变。
 * ---------------------------------------------------------------------------------------------- */
/** 运行中的 workflow(run 前 set,finally delete):amend 只能命中本进程内仍在跑的引擎。 */
export const runningWorkflows = new Map<string, WorkflowEngine>();
/** action 白名单(未给=run)。 */
export const WORKFLOW_ACTIONS = ["run", "list", "save", "amend"] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];
/** list 输出上限:资产清单是给人看的,超出部分不挤爆工具返回。 */
export const WORKFLOW_ASSET_LIST_MAX = 50;

/** 资产目录(纯路径,可单测):project 随项目走,global 个人级。 */
export function workflowAssetDirs(root: string = repoRoot(), home: string = homedir()): { project: string; global: string } {
  return { project: join(root, ".genie", "workflows"), global: join(home, ".genie", "workflows") };
}

/** 按名查资产:project 优先、global 兜底(纯函数,便于单测)。 */
export function findWorkflowAsset(
  projectAssets: readonly WorkflowAsset[],
  globalAssets: readonly WorkflowAsset[],
  name: string): WorkflowAsset | undefined {
  const n = name.trim();
  return projectAssets.find((a) => a.name === n) ?? globalAssets.find((a) => a.name === n);
}

/** run 的 caps 提取:非法值显式报错(不静默丢弃,否则「配置看起来生效」但完全没生效)。 */
export function workflowCapsFromArgs(args: { maxConcurrency?: unknown; subagentModel?: unknown }): { caps: CapsPatch; error?: string } {
  const caps: CapsPatch = {};
  if (args.maxConcurrency !== undefined) {
    const v = args.maxConcurrency;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 32) {
      return { caps: {}, error: `maxConcurrency 需为 1..32 的整数,实际: ${String(v)}` };
    }
    caps.maxConcurrency = v;
  }
  if (args.subagentModel !== undefined) {
    const v = args.subagentModel;
    if (typeof v !== "string" || v.trim().length === 0 || v.length > 128) {
      return { caps: {}, error: "subagentModel 需为非空字符串(≤128 字)" };
    }
    caps.subagentModel = v.trim();
  }
  return { caps };
}

/** amend 的 patch:除 action/wfId 外原样透传(白名单/越界由 engine.amend 判定,
 * 工具不重复一套规则——未知字段必须能被 engine 点名,不能在这里被静默过滤成空 patch)。 */
export function workflowAmendPatch(args: Record<string, unknown>): Partial<WorkflowCaps> {
  const { action: _action, wfId: _wfId, ...rest } = args;
  return rest as Partial<WorkflowCaps>;
}

/** run_workflow 工具:标准化任务的确定性编排(skill 不稳的替代)。
 * 同时是 workflow 资产的入口:action=save/list/amend + asset 按名加载 + caps 热调整。 */