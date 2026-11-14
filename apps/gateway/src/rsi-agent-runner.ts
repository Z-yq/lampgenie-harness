/**
 * RSI 机制 agent 运行器( RSI-MECH)。
 * 职责:把「机制」从纯代码判定升级为 agent 任务——
 * - startMechanismRun:按机制目录 brief 生成任务书,经注入的 submit 派一条 system 任务;
 * 结果 JSON 由 agent 写进 `.genie/rsi/agent-runs/<mech>/<runId>.result.json`。
 * - annotateRsiSections:把机制开关 / 驱动 / 结果条目 / 最近运行态注入 rsi.status 的 12 区,
 * 并在运行中任务已到终态时就地收尾(finishRun),避免面板永久转圈。
 * 依赖纪律:submit 由调用方(server.ts)注入,本模块不 import TaskSupervisor,便于单测;
 * 不写原生台账、不改源码——删除/修改只作用在 results.jsonl 覆盖层(墓碑语义)。
 */
import {
  buildAgentBrief,
  mechanismSpec,
  resolveMechanismConfig,
} from "@lampgenie/runtime/agent/rsi-mechanisms";
import { computeCost } from "@lampgenie/core/config/model-cost";
import { resolveModelPrice } from "@lampgenie/core/config/model-prices";
import type { Config } from "@lampgenie/core";
import type { RsiStatusSection } from "./rsi-status.js";
import { assessResultQuality } from "./rsi-quality.js"; // 质量契约 v2(纯逻辑,零 LLM)
import { buildAnalysisPlan, markAnalyzed, type RsiAnalysisPlan } from "./rsi-sessions.js";
import {
  finalAgentText,
  parseAnalyzedSessions,
  taskWindowOf,
  usageOfWindow,
  type RsiRunUsage,
} from "./rsi-run-metrics.js";
import {
  appendResultEvent,
  collectMechanismItems,
  finishRun,
  getRun,
  listRuns,
  loadMechanisms,
  newRunId,
  readRunResults,
  resultFilePath,
  salvageResultFile,
  startRun,
  type RsiResultItem,
  type RsiRunAnalysisRecord,
  type RsiRunCostRecord,
  type RsiRunRecord,
} from "./rsi-mechanism-store.js";

/** 任务提交函数(结构化等价 server.ts 的 tm.submit,便于测试注入)。 */
export type RsiSubmitTask = (
  kind: "user" | "system",
  sessionId: string,
  instruction: string,
  extra?: { title?: string; projectId?: string },
) => { id: string };

export type RsiRunReason =
  | "UNKNOWN_MECHANISM"
  | "MECHANISM_DISABLED"
  | "CODE_DRIVER_CLI_ONLY"
  | "SUBMIT_FAILED"
  | "STORE_FAILED"
  | "RUNNING_ALREADY";

export interface StartRunDeps {
  root: string;
  submit: RsiSubmitTask;
 /** 运行态探测(可选):给定 taskId 返回任务终态;缺省=不自动收尾,面板靠下次 annotate 兜底。 */
  taskState?: (taskId: string) => string | undefined;
 /** journal 目录( RSI-SESSION-COST):给了才组「近 3 日未分析会话」候选池。 */
  journalDir?: string;
 /** 会话→项目归属(server.ts 注入 sessionOwnerProjectId ?? sessionBindProjectId;缺省不填 projectId)。 */
  projectOf?: (sessionId: string) => string | undefined;
 /** 读会话事件(收尾时按 taskId 切窗口算成本);缺省=不算成本。 */
  readSession?: (sessionId: string) => unknown[];
 /** 生效配置(单价表覆盖来源);缺省=只用内置单价表。 */
  config?: Config;
 /** 做梦卡:运行事件注入 super 会话(message.system;开始卡/完成卡由调用方定文案)。
 * 缺省=不注入(runner 零新依赖,单测不破)。 */
  note?: (payload: { phase: "start" | "done" | "failed"; mechanismId: string; runId: string; taskId?: string; title: string; cost?: RsiRunCostRecord; summary?: string }) => void;
 /** 单次运行 token 软预算( RSI-SELF-DRIVE;缺省=不设预算,旧行为不变)。
 * 写进任务书是软约束;收尾按经验证 usage 判 budgetExceeded 并追加一条 warn 结果。 */
  budgetTokens?: number;
 /** 实验配额因子(ROI downshift 的 experimentQuotaFactor 消费面)。
 * 0<f<1 时进 experiments 机制任务书(限转入条数)+ run 记录;缺省=不设限,旧行为不变。 */
  experimentQuotaFactor?: number;
 /** 自动调度周期 id / 重试来源(缺省=手动运行,旧行为不变)。 */
  cycleId?: string;
  retryOf?: string;
}

export interface StartRunResult {
  ok: boolean;
  id: string;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  reason?: string;
}

const TERMINAL_FAILED = new Set(["failed", "cancelled", "blocked", "interrupted"]);

/** 固定 RSI 会话 id:所有机制运行都追加到这一个会话窗。 */
export const RSI_SESSION_ID = "rsi";

/** 成本核算里「整模型无单价」时列的缺价段(与 core CostBreakdown.missing 同名,面板文案一致)。 */
const COST_SEGMENTS = ["cacheRead", "cacheWrite", "inputMiss", "output"] as const;

/**
 * 把窗口用量换成一条成本记录( RSI-SESSION-COST)。
 * 单价缺失 → amountCny=null + missing 列段名;**绝不按 0 元冒充真账**。
 */
function costRecordOf(usage: RsiRunUsage, config: Config | undefined): RsiRunCostRecord {
  const price = resolveModelPrice(config, usage.model);
  const breakdown = computeCost(
    {
      input: usage.inputTokens,
      cached: usage.cachedTokens,
      cacheWrite: usage.cacheCreationTokens,
      output: usage.outputTokens,
    },
    price);
  const record: RsiRunCostRecord = {
    inputTokens: usage.inputTokens,
    cachedTokens: usage.cachedTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    amountCny: breakdown?.total ?? null,
    missing: breakdown === null ? [...COST_SEGMENTS] : [...breakdown.missing],
  };
  if (usage.model !== undefined) record.model = usage.model;
  return record;
}

/**
 * 「看起来有成本记录、其实没测到用量」的空账( fresh run 经验证):
 * costRecordOf 对空窗口也会产出一条 0 token / null 金额 / 全缺价段的记录。若把它当真账,
 * run 就再也不会重算(needsCost=false),费用永久丢失。此函数用于把这类记录判成「待重算」。
 */
export function costUnmeasured(cost: RsiRunCostRecord | undefined): boolean {
  return cost !== undefined && cost.totalTokens === 0 && cost.amountCny === null && cost.missing.length > 0;
}

/** agent 认账的 sessionId ∩ 本次候选名单(不在候选里的 id 不算数:写错/幻觉不污染账本)。 */
function recognizedSessions(
  claimed: readonly string[],
  candidates: readonly { sessionId: string; projectId?: string }[],
): { sessionId: string; projectId?: string }[] {
  const byId = new Map<string, { sessionId: string; projectId?: string }>();
  for (const candidate of candidates) byId.set(candidate.sessionId, candidate);
  const out: { sessionId: string; projectId?: string }[] = [];
  const seen = new Set<string>();
  for (const sessionId of claimed) {
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    const candidate = byId.get(sessionId);
    if (candidate === undefined) continue;
    out.push(candidate.projectId === undefined ? { sessionId } : { sessionId, projectId: candidate.projectId });
  }
  return out;
}

/** 组「近 3 日未分析会话」计划(失败降级成空候选:宁可这轮不分析会话,也不挡住机制运行)。 */
async function planFor(deps: StartRunDeps): Promise<RsiAnalysisPlan | undefined> {
  if (deps.journalDir === undefined) return undefined;
  try {
    return await buildAnalysisPlan({
      journalDir: deps.journalDir,
      root: deps.root,
      nowMs: Date.now(),
      ...(deps.projectOf === undefined ? {} : { projectOf: deps.projectOf }),
    });
  } catch {
    return { windowDays: 3, scanned: 0, alreadyAnalyzed: 0, candidates: [] };
  }
}

/** 全局单跑:同一 RSI 会话里同时只跑一个机制,避免 journal 事件交错、任务卡顺序失真。 */
async function hasRunning(root: string, taskState?: (id: string) => string | undefined): Promise<RsiRunRecord | undefined> {
  try {
    const runs = await listRuns(root);
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      const run = runs[i]!;
      if (run.status !== "running") continue;
 // taskId 在且已终态:不算在跑(交给 annotate 收尾)。
      if (run.taskId !== undefined && taskState !== undefined) {
        const state = taskState(run.taskId);
        if (state !== undefined && (state === "done" || state === "failed" || state === "cancelled")) continue;
      }
      return run;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 派一次机制运行。失败一律折叠成 `{ok:false, reason}`,不 throw:
 * 未知机制 / 机制已关闭 / code 驱动(CLI 专属)/ 已有运行中任务 / submit 抛错。
 */
export async function startMechanismRun(
  deps: StartRunDeps,
  mechanismId: string,
  override?: { enabled?: boolean; driver?: "agent" | "code" },
): Promise<StartRunResult> {
  const id = typeof mechanismId === "string" ? mechanismId : "";
  const spec = mechanismSpec(id);
  if (spec === undefined) return { ok: false, id, reason: "UNKNOWN_MECHANISM" };

  let cfg: { enabled: boolean; driver: "agent" | "code" };
  try {
    const states = await loadMechanisms(deps.root);
    const resolved = resolveMechanismConfig(id, {
      enabled: override?.enabled ?? states[id]?.enabled,
      driver: override?.driver ?? states[id]?.driver,
    });
    cfg = resolved === undefined
      ? { enabled: spec.defaultEnabled, driver: spec.defaultDriver }
      : { enabled: resolved.enabled, driver: resolved.driver };
  } catch {
    cfg = { enabled: spec.defaultEnabled, driver: spec.defaultDriver };
  }
  if (cfg.enabled === false) return { ok: false, id, reason: "MECHANISM_DISABLED" };
  if (cfg.driver !== "agent") return { ok: false, id, reason: "CODE_DRIVER_CLI_ONLY" };

  const running = await hasRunning(deps.root, deps.taskState);
  if (running !== undefined) return { ok: false, id, runId: running.runId, taskId: running.taskId, reason: "RUNNING_ALREADY" };

  const runId = newRunId();
  const resultPath = resultFilePath(deps.root, id, runId);
 // 固定会话:所有机制运行都追加到同一个 RSI 会话窗(kind=user,会话列表可见、走正常渲染与并发配额)。
  const sessionId = RSI_SESSION_ID;
  const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
 // 会话候选池(近 3 日 · 所有项目 · 未分析过):只有轨迹类机制才需要(按职责投放;
 // 台账类机制不再被塞 12 个候选——既省 token,也让「分析 0 会话」不再是所有机制的假红)。
  const plan = spec.analyzesSessions ? await planFor(deps) : undefined;
  const instruction = `${buildAgentBrief({
    id,
    root: deps.root,
    resultPath,
    ...(plan === undefined ? {} : { analysis: plan }),
    ...(deps.budgetTokens === undefined ? {} : { budgetTokens: deps.budgetTokens }),
    ...(deps.experimentQuotaFactor === undefined ? {} : { experimentQuotaFactor: deps.experimentQuotaFactor }),
  })}\n\n完成后把结果 JSON 写到上面的 resultPath,并在最终回复里按 brief 要求列出全部结果条目(只改这一个结果文件,不动仓库其它文件)。`;

  try {
 // kind=system:走独立系统池(maxConcurrentSystem),不会被用户会话的 maxConcurrent 挤成永久排队
 // (经验证:user 池 3/3 占满时 RSI 任务永远 queued)。会话归属仍是固定的 rsi,事件流不变。
    const task = deps.submit("system", sessionId, instruction, { title: `[RSI] ${spec.title} · ${stamp}` });
    const record = await startRun(deps.root, {
      mechanismId: id,
      runId,
      taskId: task.id,
      sessionId,
      ...(plan === undefined
        ? {}
        : { analysis: { windowDays: plan.windowDays, candidates: plan.candidates, analyzed: [] } }),
      ...(deps.cycleId === undefined ? {} : { cycleId: deps.cycleId }),
      ...(deps.retryOf === undefined ? {} : { retryOf: deps.retryOf }),
      ...(deps.budgetTokens === undefined ? {} : { budgetTokens: deps.budgetTokens }),
      ...(deps.experimentQuotaFactor === undefined ? {} : { experimentQuotaFactor: deps.experimentQuotaFactor }),
    });
 // 做梦开始卡:注入 super 会话(机制标题+runId;面板聊天流渲染,点卡跳做梦视图)。
    try {
      deps.note?.({ phase: "start", mechanismId: id, runId: record.runId, taskId: task.id, title: spec.title });
    } catch { /* 注卡失败不碰任务链 */ }
    return { ok: true, id, runId: record.runId, taskId: task.id, sessionId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
 // 派发失败也留一条 failed 运行记录:面板要能看见「为什么没跑起来」。
    try {
      const rec = await startRun(deps.root, {
        mechanismId: id,
        runId,
        sessionId,
        ...(plan === undefined
          ? {}
          : { analysis: { windowDays: plan.windowDays, candidates: plan.candidates, analyzed: [] } }),
        ...(deps.cycleId === undefined ? {} : { cycleId: deps.cycleId }),
        ...(deps.retryOf === undefined ? {} : { retryOf: deps.retryOf }),
        ...(deps.budgetTokens === undefined ? {} : { budgetTokens: deps.budgetTokens }),
      ...(deps.experimentQuotaFactor === undefined ? {} : { experimentQuotaFactor: deps.experimentQuotaFactor }),
      });
      await finishRun(deps.root, id, rec.runId, "failed", message.slice(0, 300));
      return { ok: false, id, runId: rec.runId, reason: "SUBMIT_FAILED" };
    } catch {
      return { ok: false, id, reason: "SUBMIT_FAILED" };
    }
  }
}

export interface AnnotateResult {
  sections: RsiStatusSection[];
 /** 本次自动收尾的运行数(诊断用)。 */
  finalized: number;
}

/** 单次运行收尾所需的外部依赖(annotate 与调度器共用;缺 readSession=不算成本)。 */
export interface SettleRunOptions {
  root: string;
  taskState?: (taskId: string) => string | undefined;
  readSession?: (sessionId: string) => unknown[];
  config?: Config;
  note?: StartRunDeps["note"];
}

/**
 * 把一个运行记录推进到「可结账」状态(自 annotate 抽出,调度器同一跑法):
 * 1) running + 任务已到终态 → finishRun(done/failed) + 完成/失败卡;
 * 2) 终态 run 按 taskId 切窗口算成本、认账已分析会话、判定预算超限/分析缺失;
 * 3) 预算超限 → 追加一条 code 来源 warn 条目(ROI 门:超预算必须可见)。
 * 幂等:已结过账且两条判定都落盘的 run 不重算。单步失败折叠进 warnings(不 throw 给调用方)。
 */
export async function settleRunRecord(
  opts: SettleRunOptions,
  section: { id: string; title: string },
  runIn: RsiRunRecord): Promise<{ run: RsiRunRecord; finalized: number; taskStateText?: string; warnings: string[] }> {
  const { root } = opts;
  let run = runIn;
  let finalized = 0;
  let taskStateText: string | undefined;
  const warnings: string[] = [];
 // ① 运行中任务已到终态:就地收尾(失败原因只写运行记录,不改结果条目)。
  if (run.status === "running" && run.taskId !== undefined && opts.taskState !== undefined) {
    const stateText = opts.taskState(run.taskId);
    taskStateText = stateText;
    if (stateText !== undefined && (stateText === "done" || TERMINAL_FAILED.has(stateText))) {
      const failed = TERMINAL_FAILED.has(stateText);
      await finishRun(root, section.id, run.runId, failed ? "failed" : "done", failed ? `task ${stateText}` : undefined);
      run = (await getRun(root, section.id, run.runId)) ?? run;
      finalized += 1;
 // 做梦完成卡:就地收尾时注入 super 会话(成本 run.cost + 摘要;失败带原因)。
      try {
        opts.note?.({
          phase: failed ? "failed" : "done",
          mechanismId: section.id,
          runId: run.runId,
          ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
          title: section.title,
          ...(run.cost === undefined ? {} : { cost: run.cost }),
          ...(run.error !== undefined ? { summary: run.error } : {}),
        });
      } catch { /* 注卡失败不影响收尾 */ }
    }
  }
 // ② 终态补账( RSI-SESSION-COST + RSI-SELF-DRIVE)。
  if (run.status !== "running" && run.taskId !== undefined && run.sessionId !== undefined && opts.readSession !== undefined) {
 // fresh run 经验证:任务结束瞬间 journal 写后读可能还看不到窗口,
 // costRecordOf(空窗口) 会写 0 token 空账 → 之后永不重算。这里把空账判成「待重算」,
 // 并且只有真拿到 llm.trace(usage.calls>0)才落成本/预算判定;分析门也只在窗口非空时才判。
    const emptyCost = costUnmeasured(run.cost);
    const needsCost = run.cost === undefined || emptyCost;
    const needsBudget = run.budgetTokens !== undefined && run.budgetTokens > 0
      && (run.budgetExceeded === undefined || emptyCost);
    const needsAnalysis = run.analysis !== undefined && (run.analysisMissing === undefined || emptyCost);
    if (needsCost || needsBudget || needsAnalysis) {
      const settled = run;
      try {
        const events = opts.readSession(run.sessionId);
        const window = taskWindowOf(events, run.taskId);
        const usage = usageOfWindow(window);
        const measured = usage.calls > 0;
        const cost = needsCost && measured ? costRecordOf(usage, opts.config) : run.cost;
        let analysis: RsiRunAnalysisRecord | undefined = run.analysis;
        if (analysis !== undefined) {
          const analyzed = analysis.analyzed.length > 0
            ? analysis.analyzed
            : recognizedSessions(parseAnalyzedSessions(finalAgentText(window)), analysis.candidates);
          analysis = { ...analysis, analyzed };
        }
        const budgetExceeded = needsBudget && measured ? usage.totalTokens > (run.budgetTokens ?? 0) : run.budgetExceeded;
 // 只有真测到 llm.trace 才判分析门:空窗口多半是写后读延迟,过早判 missing 会把重试机会钉死。
        const analysisMissing = needsAnalysis && measured
          ? analysis !== undefined && analysis.candidates.length > 0 && analysis.analyzed.length === 0
          : run.analysisMissing;
        await finishRun(root, section.id, run.runId, run.status, run.error, {
          ...(cost === undefined ? {} : { cost }),
          ...(analysis === undefined ? {} : { analysis }),
          ...(budgetExceeded === undefined ? {} : { budgetExceeded }),
          ...(analysisMissing === undefined ? {} : { analysisMissing }),
          ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
        });
        if (analysis !== undefined && analysis.analyzed.length > 0) {
          await markAnalyzed(
            root,
            analysis.analyzed.map((entry) => ({
              sessionId: entry.sessionId,
              ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }),
              mechanismId: section.id,
              runId: settled.runId,
              at: Date.now(),
            })),
          );
        }
 // 预算超限:追加一条 code 来源的 warn 结果条目(ROI 门的一部分:超预算必须可见,不能静默)。
        if (budgetExceeded === true && run.budgetExceeded !== true) {
          const limit = run.budgetTokens ?? 0;
          try {
            await appendResultEvent(root, {
              type: "upsert",
              mechanismId: section.id,
              itemId: `budget:${run.runId}`,
              item: {
                id: `budget:${run.runId}`,
                mechanismId: section.id,
                title: "本次运行超出 token 预算",
                summary: `实测 ${usage.totalTokens} tokens,超过预算 ${limit};调度器已暂停本周期余下机制,下一周期恢复。`,
                status: "warn",
                source: "code",
                runId: run.runId,
                at: Date.now(),
              },
            });
          } catch { /* 预算提示落盘失败不碰收尾 */ }
        }
        run = (await getRun(root, section.id, run.runId)) ?? run;
      } catch (err) {
        warnings.push(`运行成本核算失败:${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
 // ③ 质量评估(质量契约 v2):终态且有结果文件 → 四件套/浅层/重复/上限打分,
 // 随 run 落盘(只算一次)。失败且零条目不做质量判定(避免「失败=高质量」的假象)。
  if (run.status !== "running" && run.quality === undefined) {
    try {
 // 先自愈文件名(agent 抄错 runId 一位时,结果会落在相邻文件名;同目录唯一候选才纠正)。
      const salvage = await salvageResultFile(root, section.id, run.runId, run.startedAt);
      const items = await readRunResults(root, section.id, run.runId);
      if (!(run.status === "failed" && items.length === 0)) {
        let quality = assessResultQuality(items);
        if (!salvage.found && run.status === "done") {
 // 完成但完全没有结果文件:不是「诚实空产出」,而是交付缺失 → 0 分并点名。
          quality = {
            items: 0, evidenced: 0, impacted: 0, actionable: 0, shallow: 0, duplicates: 0, overLimit: false,
            score: 0,
            issues: [{ code: "RESULT_MISSING", note: "未找到结果文件(agent 可能没写或 runId 抄错);本轮视为零交付" }],
          };
        } else if (salvage.movedFrom !== undefined) {
          quality = {
            ...quality,
            score: Math.max(0, quality.score - 5),
            issues: [...quality.issues, { code: "PATH_REPAIRED", note: `结果文件名写错(${salvage.movedFrom}),已自动纠正` }],
          };
        }
        await finishRun(root, section.id, run.runId, run.status, run.error, {
          quality,
          ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
        });
        run = (await getRun(root, section.id, run.runId)) ?? run;
      }
    } catch (err) {
      warnings.push(`结果质量评估失败:${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { run, finalized, ...(taskStateText === undefined ? {} : { taskStateText }), warnings };
}

/**
 * 把机制治理面注入 12 区。单区失败不影响其它区,也不 throw(fail-open):
 * 该区保留原 section,只追加一条 warning。
 */
export async function annotateRsiSections(
  opts: {
    root: string;
    sections: RsiStatusSection[];
    taskState?: (taskId: string) => string | undefined;
 /** 读会话事件( RSI-SESSION-COST:收尾时按 taskId 切窗口算成本);缺省=不算成本。 */
    readSession?: (sessionId: string) => unknown[];
 /** 生效配置(单价表覆盖来源);缺省=只用内置单价表。 */
    config?: Config;
 /** 做梦卡:就地收尾时注入 super 会话(完成卡,带 run.cost);缺省=不注入。 */
    note?: StartRunDeps["note"];
  },
): Promise<AnnotateResult> {
  const { root } = opts;
  let states: Record<string, { enabled: boolean; driver: "agent" | "code" }>;
  try {
    states = await loadMechanisms(root);
  } catch {
    states = {};
  }
  let finalized = 0;
  const out: RsiStatusSection[] = [];
  for (const section of opts.sections) {
    const spec = mechanismSpec(section.id);
    if (spec === undefined) {
      out.push(section);
      continue;
    }
    const state = states[section.id];
    const enabled = state?.enabled ?? spec.defaultEnabled;
    const driver = state?.driver ?? spec.defaultDriver;
    let items: RsiResultItem[] = [];
    let run: RsiRunRecord | undefined;
    let taskStateText: string | undefined;
    const extraWarnings: string[] = [];
    try {
      const collected = await collectMechanismItems(root, section.id);
      items = collected.items;
      if (collected.run !== undefined) {
 // 收尾/补账/质量门统一走 settleRunRecord(与调度器同一跑法,避免两套逻辑漂移)。
        const settled = await settleRunRecord(opts, { id: section.id, title: section.title }, collected.run);
        run = settled.run;
        taskStateText = settled.taskStateText;
        finalized += settled.finalized;
        extraWarnings.push(...settled.warnings);
      }
    } catch (err) {
      extraWarnings.push(`机制治理面读取失败:${err instanceof Error ? err.message : String(err)}`);
    }
    const metrics = Array.isArray(section.metrics) ? section.metrics : [];
    const warnings = Array.isArray(section.warnings) ? section.warnings : [];
    out.push({
      ...section,
      metrics,
      warnings: [...warnings, ...extraWarnings],
      enabled,
      driver,
      items,
      ...(run === undefined
        ? {}
        : {
            run: {
              runId: run.runId,
              ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
              status: run.status,
              ...(run.status === "running" && taskStateText !== undefined ? { taskState: taskStateText } : {}),
              startedAt: run.startedAt,
              ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
              ...(run.error === undefined ? {} : { error: run.error }),
              ...(run.cost === undefined ? {} : { cost: run.cost }),
              ...(run.analysis === undefined ? {} : { analysis: run.analysis }),
 // RSI-SELF-DRIVE:周期/重试/预算/两条质量门(面板要显示「超预算/未认账」)。
              ...(run.cycleId === undefined ? {} : { cycleId: run.cycleId }),
              ...(run.retryOf === undefined ? {} : { retryOf: run.retryOf }),
              ...(run.retryCount === undefined ? {} : { retryCount: run.retryCount }),
              ...(run.budgetTokens === undefined ? {} : { budgetTokens: run.budgetTokens }),
              ...(run.budgetExceeded === undefined ? {} : { budgetExceeded: run.budgetExceeded }),
              ...(run.analysisMissing === undefined ? {} : { analysisMissing: run.analysisMissing }),
              ...(run.quality === undefined ? {} : { quality: run.quality }),
            },
          }),
    });
  }
  return { sections: out, finalized };
}
