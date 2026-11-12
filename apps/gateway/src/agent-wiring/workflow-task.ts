/**
 * agent-wiring 分片:workflow-task(自 agent-wiring.ts 7910 行按域拆分,逐字搬移)。
 * 原路径 agent-wiring.ts 保留具名转发 barrel;消费方零改动。
 */
import { WORKFLOW_ACTIONS, WORKFLOW_ASSET_LIST_MAX, runningWorkflows } from "./tools.js";
import type { WorkflowAction } from "./tools.js";
import { registerOwnedUnit, settleOwnedUnit } from "./wiring-core.js";
import { workflowAssetDirs, workflowAmendPatch, workflowCapsFromArgs, findWorkflowAsset } from "./tools.js";
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
export function runWorkflowTool(
  journal: import("@lampgenie/core").Journal,
  executor: import("@lampgenie/executors").SubagentBackend,
  journalSessionId: string,
  workflowAskRouter?: import("../workflow-ask-router.js").WorkflowAskRouter,
 /** 测试注入用:资产目录(缺省=workflowAssetDirs)。 */
  dirsOverride?: { project?: string; global?: string },
): Tool {
  const dirs = workflowAssetDirs();
  const projectStore = new WorkflowAssetStore({ dir: dirsOverride?.project ?? dirs.project });
  const globalStore = new WorkflowAssetStore({ dir: dirsOverride?.global ?? dirs.global });
  return {
    name: "run_workflow",
    description: "运行标准化 workflow(测试/评审/评测等):传 template=unit-tests|functional-test|algo-eval 加 args,或直接传 script 源码(TS,facade:agent/world/report/log;world.run 白名单)。:action=save/list/amend 管理可复用资产(script+paramsSchema),asset=按名加载;maxConcurrency/subagentModel 作为运行期 caps,amend 可热调整运行中的 run(需给 wfId)",
    parameters: {
      type: "object",
      properties: {
        template: { type: "string", description: "模板名(与 script 二选一)" },
        args: { type: "string", description: "模板参数 JSON" },
        script: { type: "string", description: "workflow 脚本源码(TS)" },
        action: { type: "string", enum: ["run", "list", "save", "amend"], description: "缺省 run:run=执行;list=列资产;save=保存当前 script 为资产(saveAs+scope);amend=热调整运行中 run 的 caps(wfId)" },
        asset: { type: "string", description: "资产名:按名加载 script/paramsSchema 后运行(project 优先、global 兜底)" },
        saveAs: { type: "string", description: "action=save 的资产名(文件名白名单 ^[A-Za-z0-9._-]{1,64}$)" },
        scope: { type: "string", enum: ["project", "global"], description: "action=save 的作用域:project=<repoRoot>/.genie/workflows(缺省),global=~/.genie/workflows" },
        paramsSchema: { type: "string", description: "action=save 的参数 JSON Schema(JSON 文本;缺省 {})" },
        description: { type: "string", description: "action=save 的一句话用途" },
        maxConcurrency: { type: "number", minimum: 1, maximum: 32, description: "运行期 caps:并发上限(1..32),作 WorkflowEngine 构造参数或 amend 目标" },
        subagentModel: { type: "string", description: "运行期 caps:子代理模型名(非空 ≤128),同上" },
        wfId: { type: "string", description: "workflow id:amend/list 用;run 时给则用它作为本次 id(便于运行中 amend)" },
      },
    },
    isConcurrencySafe: () => false,
    async execute(args: unknown) {
      const a = (args ?? {}) as {
        template?: string;
        args?: string;
        script?: string;
        action?: WorkflowAction;
        asset?: string;
        saveAs?: string;
        scope?: WorkflowAssetScope;
        paramsSchema?: string;
        description?: string;
        maxConcurrency?: number;
        subagentModel?: string;
        wfId?: string;
      };
      const action = (a.action ?? "run") as WorkflowAction;
      try {
        if (!WORKFLOW_ACTIONS.includes(action)) {
          return `run_workflow 错误: 未知 action "${String(action)}"(可用: ${WORKFLOW_ACTIONS.join("/")})`;
        }

 // ---- save:把当前 script 落成可复用资产(script 非空;saveAs/schema 非法=INVALID)----
        if (action === "save") {
          if (typeof a.script !== "string" || a.script.trim().length === 0) {
            return "save 错误: INVALID — script 不得为空(action=save 保存的是当前 workflow 脚本)";
          }
          const name = typeof a.saveAs === "string" ? a.saveAs.trim() : "";
          if (!name) return "save 错误: INVALID — saveAs 必填(资产名)";
          const scope = a.scope ?? "project";
          if (scope !== "project" && scope !== "global") return `save 错误: INVALID — scope 只能是 project|global,实际: ${String(scope)}`;
          const paramsSchema = a.paramsSchema ?? "{}";
          let schemaObj: unknown;
          try {
            schemaObj = JSON.parse(paramsSchema);
          } catch {
            return "save 错误: INVALID — paramsSchema 不是合法 JSON";
          }
          if (!schemaObj || typeof schemaObj !== "object" || Array.isArray(schemaObj)) {
            return "save 错误: INVALID — paramsSchema 必须是 JSON 对象(schema)";
          }
          if (a.description !== undefined && typeof a.description !== "string") {
            return "save 错误: INVALID — description 必须是字符串";
          }
          const store = scope === "global" ? globalStore : projectStore;
          const saved = await store.save({
            name,
            script: a.script,
            paramsSchema,
            scope,
            createdAt: 0, // save 内部按「已有则沿用,否则 now」重建,这里只占位
            updatedAt: 0,
            ...(a.description !== undefined ? { description: a.description } : {}),
          });
          if (!saved.ok || !saved.asset) return `save 错误: ${saved.code} — ${saved.error ?? "未知错误"}`;
          return JSON.stringify({ ok: true, name: saved.asset.name, scope: saved.asset.scope, path: join(store.dir, `${saved.asset.name}.json`) });
        }

 // ---- list:两目录合并(project 在前),按 updatedAt 倒序,≤50 ----
        if (action === "list") {
          const [p, g] = await Promise.all([projectStore.list(), globalStore.list()]);
          if (!p.ok && !g.ok) return `list 错误: ${p.error ?? g.error ?? "读取资产目录失败"}`;
          const assets = [...p.assets, ...g.assets]
            .sort((x, y) => y.updatedAt - x.updatedAt)
            .slice(0, WORKFLOW_ASSET_LIST_MAX)
            .map((x) => ({
              name: x.name,
              scope: x.scope,
              updatedAt: x.updatedAt,
              ...(x.description !== undefined ? { description: x.description } : {}),
            }));
          return JSON.stringify({ ok: true, count: assets.length, assets, warnings: [...p.warnings, ...g.warnings].slice(0, 10) });
        }

 // ---- amend:只命中本进程内仍在跑的 run;白名单/越界由 engine 判定 ----
        if (action === "amend") {
          const wfId = typeof a.wfId === "string" ? a.wfId.trim() : "";
          if (!wfId) return "amend 错误: wfId 必填(要 amend 的运行中 workflow id;run 时可用 wfId 指定)";
          const engine = runningWorkflows.get(wfId);
          if (!engine) return `无运行中的 workflow: ${wfId}(amend 只对 action=run 且尚未结束的运行生效)`;
          const r = engine.amend(workflowAmendPatch(a as unknown as Record<string, unknown>));
          return JSON.stringify({ ok: r.ok, code: r.code, applied: r.applied, rejectedKeys: r.rejectedKeys, caps: r.caps });
        }

 // ---- run:资产/脚本/模板 → engine(caps 构造参数)→ runningWorkflows 注册 ----
        const capsParsed = workflowCapsFromArgs(a);
        if (capsParsed.error) return `run_workflow 错误: ${capsParsed.error}`;
        const caps = capsParsed.caps;
        let loadedAsset: WorkflowAsset | undefined;
        let source: string;
        if (typeof a.asset === "string" && a.asset.trim().length > 0) {
          const assetName = a.asset.trim();
          const [p, g] = await Promise.all([projectStore.list(), globalStore.list()]);
          loadedAsset = findWorkflowAsset(p.assets, g.assets, assetName);
          if (!loadedAsset) {
            return `run_workflow 错误: workflow 资产不存在: ${assetName}(先 action=save 保存,或 action=list 查看已有资产)`;
          }
          source = loadedAsset.script;
        } else if (typeof a.script === "string") {
          source = a.script;
        } else if (typeof a.template === "string" && a.template.length > 0) {
          source = renderTemplate(a.template, a.args ? JSON.parse(a.args) : {});
        } else {
          return "run_workflow 错误: 需要 template、script 或 asset 之一";
        }
        const wfId = typeof a.wfId === "string" && a.wfId.trim().length > 0 ? a.wfId.trim() : `wf-${Date.now()}`;
        journal.append({
          kind: "workflow.run.start",
          sessionId: journalSessionId,
          payload: { wfId, template: a.template ?? null, ...(loadedAsset ? { asset: loadedAsset.name } : {}) },
        });
        const engine = new WorkflowEngine({
          root: repoRoot(),
          journal,
          workflowId: wfId,
          executor: { ...executor, spawn: executor.spawn.bind(executor) } as never,
          ...(Object.keys(caps).length > 0 ? { caps } : {}),
          dispatch: async (instr) => {
 // F6:面板在线先问面板(直答);超时/离线回退 executor dispatch。
            const hash = (await import("node:crypto")).createHash("sha256").update(instr).digest("hex").slice(0, 12);
            const direct = workflowAskRouter ? await workflowAskRouter.ask(wfId, "panel:" + hash, instr) : null;
            if (direct !== null) return direct;
            return new Promise<string>((resolve, reject) => {
              void executor.spawn({ taskId: wfId, instructions: instr, workdir: repoRoot(), permissions: "sandbox" }, (e) => {
                if (e.type === "result") e.result.ok ? resolve(e.result.finalText ?? "") : reject(new Error(e.result.error?.detail ?? "agent 失败"));
              }).catch(reject);
            });
          },
        });
        runningWorkflows.set(wfId, engine); // amend 目标:run 期间可被外部热调整
 // 会话工作所有权:workflow 单元(owner=发起会话)。登记点在上面三处错误 return 之后,
 // 拒启路径不留条目(否则关会话时会去 abort 一个从未开始的 run)。
        const wfOwnership = registerOwnedUnit(journal, { unitId: wfId, kind: "workflow", ownerSessionId: journalSessionId });
        try {
          const r = await engine.run(source, 600_000);
          journal.append({
            kind: "workflow.run.done",
            sessionId: journalSessionId,
            payload: { wfId, ok: r.ok, ...(loadedAsset ? { asset: loadedAsset.name } : {}) },
          });
 // 旧字段原样保留;caps 只在非空时追加(构造时给或运行中 amend 给都算)
          const capsNow = engine.currentCaps();
          const capsField = Object.keys(capsNow).length > 0 ? { caps: capsNow } : {};
          return JSON.stringify({ ok: r.ok, partial: r.partial, items: r.items.slice(0, 20), logs: r.logs.slice(-10), error: r.error, ...capsField }).slice(0, 12_000);
        } finally {
          runningWorkflows.delete(wfId);
          settleOwnedUnit(journal, wfId, wfOwnership); // 终态 settle(旧代际迟到=丢弃,见 settleOwnedUnit)
        }
      } catch (err) {
        return `run_workflow 错误: ${String(err).slice(0, 200)}`;
      }
    },
  };
}

/** code_review 工具:确定性层必跑,LLM 深审走 models.review(未配置=确定性层 only)。
 * root=任务的项目根(项目级能力:审的是该项目的工作区变更,不是 harness 仓。
 * fixG1:baseSha=本任务开工 checkpoint(既有 checkpoint.create 链)——在场且 agent 未显式给 target 时,
 * diff 基线=该 checkpoint(只审本任务变更集),不审共享工作区里别的任务/agent 的在途改动;
 * checkpoint 缺席(纯规划/干净树/快照失败)→回退全仓未提交 diff,summary 如实标注。
 * fixG1 起导出供单测直接驱动(checkpoint 基线接线测试)。
 * O1:深审不再是「有凭证就一定跑」——缺省 auto(免费层 0 blocker 且变更集小→跳过并写进 summary,
 * 经验证深审跑满 8 分钟时间盒零新增);fast:true=never,deep:true=always(优先于 auto)。 */
export type ReviewLlmPolicy = "auto" | "always" | "never";

export function codeReviewTool(root: string, reviewLlm: LlmProvider | undefined, journal: import("@lampgenie/core").Journal, sessionId: string, progress?: (note: string) => void, baseSha?: string | null, remote?: RemoteProject): Tool {
  return {
    name: "code_review",
    description: "审查代码变更(默认=本任务变更集:以任务开工 checkpoint 为基线,只含本任务开工后的改动+新文件,不含共享工作区里其它任务的在途改动;无 checkpoint 回退全仓未提交并标注。可传 commit hash/分支名显式改口径)。返回 findings(severity/file:line/scenario)。同源 CLI 形态:codesense review [target] [--deep](packages/code-sense-cli,人读 markdown/--json;适合人在终端、CI 门禁(exit 1=有 blocker)、外部 agent 直接跑;触发路径全景见 docs/code-review-trigger-matrix.md)——当用户想在 harness 之外审查(本地终端/CI/其它 agent 平台)时,推荐该 CLI",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "commit hash 或分支名;缺省=本任务变更集(checkpoint 基线),无 checkpoint 才是全仓未提交变更" },
        fast: { type: "boolean", description: "fixG1:true=只跑确定性层(秒级,零 LLM)。修完 blocker/high findings 后复跑确认不复现时用它;只有确定性层仍报 findings 才需要不带 fast 深审" },
        deep: { type: "boolean", description: "true=强制深审(优先于缺省 auto 档;确定性层干净且变更集小也会跑 LLM)" },
      },
    },
    isConcurrencySafe: () => false,
    async execute(args: unknown) {
      const target = (args as { target?: string }).target;
      const fast = Boolean((args as { fast?: boolean }).fast); // fixG1:确定性层-only 复跑
      const deep = Boolean((args as { deep?: boolean }).deep); // 强制深审
 // 远程项目(SSH/WSL:评审在远端运行时执行(codesense review --json,确定性+反模式层)。
 // LLM 深审需要远端凭证(不把桌面 key 下发远端),此处只跑确定性层并如实标注。
      if (remote) {
        const where = remote.kind === "wsl" ? "WSL:" + remote.distro : "SSH:" + remote.host;
        try {
          progress?.("远端评审(确定性+反模式层,codesense review)…");
          const { tryChannelJson } = await import("../remote-channel.js");
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
 // O1:三档合流——fast=never > deep=always > 缺省 auto(小且干净则跳过)。
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
 // 用户用户反馈卡死修复:深审=多轮 LLM(rounds+grace+逐 finding 定位,可达十几次调用),
 // 每次调用空闲窗 10min——无整体上限时工具可挂 30min+(T3/T4 双任务同点卡死注意)。
 // 时间盒 8 分钟(确定性层秒级必出;深审正常 18s~4min):超时返回确定性层 findings+如实标注。
 // auto 档的跳过判定在引擎内(免费层跑完才判),策略原样下发。
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
 // findings 需甄别归属——不属本任务的登记环境噪声,不修(经验证修别人 findings 浪费 20 分钟)。
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

/** soul 行为纪律剥离(审计修复②):去掉首段「你是…」身份行,只留行为纪律——
 * vibe coding 轨身份以 SYSTEM 为唯一声明(refs:身份唯一),soul 的纪律仍有益故继承。 */
export function soulDisciplinesFor(soulText: string): string {
  const t = soulText.replace(/\r\n/g, "\n").trim();
  const idx = t.indexOf("\n\n");
  const head = idx === -1 ? t : t.slice(0, idx);
  if (/^你是/.test(head)) return (idx === -1 ? "" : t.slice(idx + 2)).trim();
  return t;
}

/** 任务书符号提取( F3):驼峰/下划线/Pascal 形态≥4 字符,排除中文与停用词。 */
export function firstSymbolLike(text: string): string | null {
  const STOP = new Set(["true", "false", "null", "undefined", "this", "self", "test", "spec", "index", "main", "utils", "types", "node", "json", "http", "readme"]);
  const m = text.match(/\b[a-zA-Z][a-zA-Z0-9]*(?:[A-Z_][a-zA-Z0-9]*){1,}\b/g) ?? [];
  const cand = m.filter((w) => w.length >= 4 && !STOP.has(w.toLowerCase()));
  return cand[0] ?? null;
}

// ---- 任务类别(理解阶段定类,tips/plan-gate 全消费同一结果)----
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
 // 交付物锚(上线观测依据):「调研…写一篇《事故复盘》技术文章,讲清修复设计与
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
 // 经验证补词:整理一份/列一份/建一份/出一份/速查/清单(此前「整理一份」≠词表
 // 「写一份」,办公任务落缺省 coding 交满仪式税)。「写个/做个」曾试加即误吞「做个小功能」
 // (编码任务)——过泛已移除,泛动词不进词表。
  if (/(ppt|幻灯|slides?|演示文稿|xlsx|excel|表格|word|docx|简历|海报|翻译|排版|思维导图|写一份|做一份|生成一份|整理一份|列一份|建一份|出一份|速查|清单|整理成文档|汇报材料|周报|月报|总结报告|邮件)/.test(t)) return "office";
 // 问答/调研信号(问句/调查动词且无写代码意图;含英文问句词)。 经验证修正:问号出现
 // 即算(不再锚句尾——「。」结尾的问句让 $ 锚全部失配);补词 哪个/哪几/多少/几步/是不是。
  if (/(是什么|为什么|怎么回事|怎么理解|干什么|干啥|如何|哪些|哪个|哪几|哪里|多少|几步|有没有|能不能|是不是|区别|看看|查一下|调研|梳理|分析一下|解释|介绍|告诉我|找找|检查一下|评估|确认一下)|\b(what|why|how|where|which|explain)\b|[??]/.test(t)) return "qa";
  return "coding";
}

/**
 * 类别更正为 coding 时的纪律补发( P1-1):qa/office 任务的系统提示/纪律卡不含编码
 * 纪律,更正只武装 plan-gate 会造成「被拦却没见过规则」——规则与执法必须同时到场,全文随
 * task_phase 回执一次性送达(短句形态,与 kickoff 纪律卡同源)。
 */
export const CODING_DISCIPLINE_REFILL = [
  "- 五阶段流程:理解任务→规划→开始实施→开始验收→完成——每进入一阶段用 task_phase 声明(不涉及的用 skip:true);**阶段声明与其他工具同一步发出即可(task_phase 可与真实工作并行),不要为它单独走一步**;只做当前阶段该做的事",
  "- plan-gate 硬闸:白板上没有设计节点前,派写角色子代理/直写文件都会被拒——先规划落板(planner 或内联轻量板)",
  "- 影响面纪律:改既有函数前必先用 code_sense 拿影响面,按清单同步调用方与测试",
  "- 完工验收四步(汇报完成前必走):①用 code_sense 复核影响面;②code_review 审本任务变更集(blocker/high 必修);③相关测试定向跑,报告带条件/通过标准/实际结果三要素;④board_upsert action=audit 核对 P0 覆盖率",
  "- 输出简明:结论先行、证据跟后;收尾前 P0 验收证据全绿才可宣称完成",
].join("\n");

// ---- 扫描根预算闸(立; 独立成 sense-root-gate.ts 并接全自动路径:超预算根
// 一律不扫不建,工作区根给子仓收窄出路。re-export 保既有 import 面(sense-tool/测试)。 ----
export { rootScanVerdict, detectWorkspaceRepos, refineRootForTarget, renderWorkspaceRepos, workspaceRefusalText, type RootScanVerdict, type WorkspaceRepo } from "../sense-root-gate.js";
import { rootScanVerdict } from "../sense-root-gate.js"; // 本文件 warmIndex 闸消费(2997)

// 开工 orient 注入链已整体删除:orientWithSense/symbolsInText/orient-cache 系列
// (scanFingerprint/orientCacheKey/readOrientCache/warmOrientCache)。每条 user message
// 跟一条「全局代码+历史匹配」tips 多余且常错配——code_sense 内容必须是拉取式(call 工具才返回);
// 索引预热由任务开工的 warmIndex(火忘后台)独立承担,首次工具调用不吃冷启动。
// 遗留磁盘缓存 .genie/orient-cache-*.json 成为死文件,可手删(不再有读写方)。

/** P3:「项目主线」注入块(项目底座认知,防开发偏离主线)。
 * 委托 projectMainlineBlock(读 .genie/sense-index/profile.json;缺席=空串零注入零开销;
 * 生产者=codesense project --write;预算 ≤300 字符内部截断)。失败静默(增强件不阻塞任务)。 */
export function projectMainlineBlockOf(taskRoot: string): string {
  try {
    return projectMainlineBlock(taskRoot);
  } catch {
    return "";
  }
}

/** 子代理任务书的涉事符号上下文( F3; 三改收敛:读静态索引,毫秒级)。
 * 无符号/查询失败返回空串。**硬预算不阻塞派发**(注意:索引缺失时旧实现会等
 * 冷构建 7+ 分钟,10 路子代理一起堵住再同时放行 → 建连洪峰 + 8 路 fetch failed)。
 * GENIE_SYMBOL_CONTEXT_BUDGET_MS 可调,缺省 2000ms;超预算按「无上下文」处理。 */
export async function symbolContextFor(root: string, instructions: string): Promise<string> {
  const sym = firstSymbolLike(instructions);
  if (!sym) return "";
  try {
    const { codeIndexQuery } = await import("../sense-index-manager.js");
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

/** LlmProvider→ArchLlm 适配( F1):两段式(解说→图 JSON)各一次 chat。
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
 * Plan 模式系统提示(ZCode Plan Workflow 语义; 汉化——提示词全中文,
 * 收尾节标题与批准回执短语同步改为中文且与服务端注入逐字配对)。
 * 结尾适配:harness 无 ExitPlanMode 工具——以「## 实施计划」节收尾,
 * 终态后网关落计划文件并广播审批(批准=切回+按计划派实施任务)。
 */
export function planModePrompt(): string {
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
    "规划必成板:设计定稿时把规划结构画到白板——board_upsert 属规划产物而非系统修改,plan 模式应当使用(只读的 board_read 亦可用)。页面/应用类规划用 docKind=\"page\" 的页面结构板(节点=page/section/component,边=nav/contains);模块/代码设计用默认设计板。用户会在白板上复审并拖拉修改,批准后按板上结构实施。",
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

/** 计划文件注入(ZCode plan_file_reference 附件语义):存在即随系统提示带回。 */
/** 计划文件注入(导出=审计/测试可探针)。 */
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
// 附件注入(附件通道 2026:图片/视频贴进聊天窗 → 任务书如实标注)
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
/** 纯文本类扩展名(附件链路):doc-text 的 DOC_PARSE_EXT 也包含它们,但在**附件分类**语境
 * 里它们是文本类(other,走原「read_attachment 可读」文案),不能升级成 doc——否则模型会被引导去
 * 「解析」一个本来就是纯文本的文件(注:read_attachment 走 doc 分支时二者都能读,差别只在提示语义)。 */
const TEXT_LIKE_EXT: ReadonlySet<string> = new Set([
  "md", "markdown", "txt", "log", "json", "jsonc", "csv", "tsv", "html", "htm", "xml",
  "yaml", "yml", "ini", "toml", "conf", "sh", "sql", "css", "js", "ts", "py", "go", "rs", "java",
]);
/** 可传进会话但 doc-text 暂无解码器的文档后缀(老式 OLE / ODF / 电子书 / 压缩包):**仍归 doc**,
 * 由 read_attachment 走解析器如用户反馈「不支持解析的类型:xxx」。若落 other,会被标成「read_attachment 可读」,
 * 随后 isBinaryLikeMime(通用 mime)=false → readFileSync 后 utf8 硬解 = 100KB 乱码( review 修)。
 * 与 panel 的 ATT_DOC_EXT / DOC_EXT 同源(那边放行到 64MB,这边判型必须同步)。 */
const DOC_EXT_NO_DECODER: ReadonlySet<string> = new Set([
  "doc", "xls", "ppt", "odt", "ods", "odp", "epub",
  "tar", "gz", "tgz", "7z", "rar", "pages", "numbers", "key",
]);
/** 文档类 mime 白名单(附件链路):命中=可选可解析文档,走 read_attachment 解析为纯文本。
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
export function normalizeAttachmentMime(mime?: string): string {
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
  if (ext && DOC_EXT_NO_DECODER.has(ext) && GENERIC_MIMES.has(m)) return "doc"; // 无解码器的不透明容器:交解析器如用户反馈「不支持」
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
 /** 体积探测(生产传 statSync.size,不必把大文件读进内存;缺省=读长度,便于单测注入)。 */
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
 // 尺寸守卫:与 view_image 同源判定——超限图不进视觉通道(否则整轮请求永久 400)。
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
 // 附件链路:文档类只给「去解析」的指路,**注入阶段不解析**——注入每轮都跑,
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
 // (review):二进制类(pdf/zip/字体/音视频/未知 image 子类型)也走 other——
 // 别统一标「read_attachment 可读」:read_attachment 有 isBinaryLikeMime 门槛会拒解码,
 // 提示与工具语义必须一致,否则模型白调一轮工具才失败。
 // 白名单图片(png/jpeg/gif/webp)有了主动查看通道 view_image——
 // 旧文案曾指向一个并不存在的「对应工具」,模型只能用代码打印像素占位(已彻底删除该措辞)。
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

/** 请求实际 max_tokens 读数( O4):provider.describe.maxTokens;无该面=undefined
 * (压缩钩子按 ZCode 口径回退 32000)。 */