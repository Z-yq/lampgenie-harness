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
import { buildAnalysisPlan, markAnalyzed, type RsiAnalysisPlan } from "./rsi-sessions.js";
import {
  finalAgentText,
  parseAnalyzedSessions,
  taskWindowOf,
  usageOfWindow,
  type RsiRunUsage,
} from "./rsi-run-metrics.js";
import {
  collectMechanismItems,
  finishRun,
  getRun,
  listRuns,
  loadMechanisms,
  newRunId,
  resultFilePath,
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
 // 会话候选池(近 3 日 · 所有项目 · 未分析过):只在给了 journalDir 时才组,旧调用行为不变。
  const plan = await planFor(deps);
  const instruction = `${buildAgentBrief({
    id,
    root: deps.root,
    resultPath,
    ...(plan === undefined ? {} : { analysis: plan }),
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
      run = collected.run;
 // 运行中任务已到终态:就地收尾(失败原因只写运行记录,不改结果条目)。
      if (run !== undefined && run.status === "running" && run.taskId !== undefined && opts.taskState !== undefined) {
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
    } catch (err) {
      extraWarnings.push(`机制治理面读取失败:${err instanceof Error ? err.message : String(err)}`);
    }
 // 收尾补账( RSI-SESSION-COST):终态 run、还没算过成本 → 按 taskId 切窗口算钱与认账会话。
 // 只补一次(cost 已在=不重算),重复轮询不会把账本越写越长。
    if (
      run !== undefined &&
      run.status !== "running" &&
      run.cost === undefined &&
      run.taskId !== undefined &&
      run.sessionId !== undefined &&
      opts.readSession !== undefined
    ) {
 // 收窄后的快照:闭包(map 回调)里不能再依赖 let run 的控制流收窄(TS18048)。
      const settled = run;
      try {
        const events = opts.readSession(run.sessionId);
        const window = taskWindowOf(events, run.taskId);
        const cost = costRecordOf(usageOfWindow(window), opts.config);
        const analysis: RsiRunAnalysisRecord | undefined = run.analysis === undefined
          ? undefined
          : { ...run.analysis, analyzed: recognizedSessions(parseAnalyzedSessions(finalAgentText(window)), run.analysis.candidates) };
        await finishRun(root, section.id, run.runId, run.status, run.error, {
          cost,
          ...(analysis === undefined ? {} : { analysis }),
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
        run = (await getRun(root, section.id, run.runId)) ?? run;
      } catch (err) {
        extraWarnings.push(`运行成本核算失败:${err instanceof Error ? err.message : String(err)}`);
      }
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
            },
          }),
    });
  }
  return { sections: out, finalized };
}
