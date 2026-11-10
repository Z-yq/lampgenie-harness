/**
 * 运行看板趋势(参考项目 session-trends 的 journal 原生重写,功能面 1:1 + C 阶段扩展):
 * 会话日快照 → 日桶 → 7 天 vs 前 7 天窗口摘要。
 *
 * 机制适配(诚实登记):
 *  - ref 的 reported-delta 机器(跨重启幂等上报)不移植:本地看板每次全量重算,无上报态;
 *  - ref 的请求成本体系(priceVersion/costMicros/cacheReadShare)不移植:journal 无价格数据,
 *    不造数(数据同源纪律);趋势指标以 token/耗时/成功/纠正承载。
 */
import type { JournalEvent } from "@lampgenie/core";
import { DASH_IDLE_TIMEOUT_MS, rebuildDashboardSessions } from "./dashboard-collector.js";

/** 单会话终态快照(ref DailySessionSnapshot 对应物)。 */
export interface DashSessionSnapshot {
  /** 终态事件的 UTC 日(YYYY-MM-DD);有终态才入样(ref 需 stop 事件同语义)。 */
  date: string;
  prompts: number;
  durationMs: number;
  succeeded: 0 | 1;
  corrected: 0 | 1;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  /** C 阶段:子代理用量入趋势。 */
  subagents: number;
  llmMs: number;
}

export interface DashDailyBucket {
  day: string;
  sessionsEnded: number;
  sessionsSucceeded: number;
  promptTurns: number;
  durationMs: number;
  sessionsCorrected: number;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  subagents: number;
  /** C 阶段:LLM 耗时入趋势(秒级柱状图用)。 */
  llmMs: number;
}

export interface DashTrendPeriod {
  sessionsEnded: number;
  successRate: number | null;
  avgPrompts: number | null;
  avgDurationMs: number | null;
  /** 每会话平均 token(输入+输出)。 */
  avgTokens: number | null;
  /** 每会话平均 LLM 耗时(ms)。 */
  avgLlmMs: number | null;
  correctionRate: number | null;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 判会话是否已终态:taskState 是 done/failed/cancelled(ref 需 stop 事件的本地对应物)。 */
export function isSessionEnded(state: string | null): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

/**
 * 折算已终态会话的日快照。会话聚合直接取 rebuildDashboardSessions 的超时前折算
 * (endless 会话不入样,与 ref「无 stop 不计」同语义);终态日取该会话终态事件日。
 */
export function aggregateDailySessions(events: JournalEvent[]): Map<string, DashSessionSnapshot> {
  // 终态事件定位:每会话最后一条 task.* 带 done/failed/cancelled。
  const terminalAt = new Map<string, number>();
  for (const ev of events) {
    if (!ev.kind.startsWith("task.")) continue;
    const state = (ev.payload as { state?: string } | null | undefined)?.state;
    if (state === "done" || state === "failed" || state === "cancelled") {
      const prev = terminalAt.get(ev.sessionId);
      if (prev === undefined || ev.time >= prev) terminalAt.set(ev.sessionId, ev.time);
    }
  }
  const tokensBySession = new Map<string, { in: number; out: number; tool: number; sub: number; llm: number }>();
  for (const ev of events) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    let t = tokensBySession.get(ev.sessionId);
    if (!t) {
      t = { in: 0, out: 0, tool: 0, sub: 0, llm: 0 };
      tokensBySession.set(ev.sessionId, t);
    }
    if (ev.kind === "message.agent") {
      const usage = p.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      t.in += Number(usage?.inputTokens) || 0;
      t.out += Number(usage?.outputTokens) || 0;
      t.llm += Number(p.llmMs) || 0;
    } else if (ev.kind === "tool.call") t.tool++;
    else if (ev.kind === "subagent.spawn") t.sub++;
  }

  const result = new Map<string, DashSessionSnapshot>();
  for (const s of rebuildDashboardSessions(events, Number.MAX_SAFE_INTEGER, { keepAll: true })) {
    const endedAt = terminalAt.get(s.sessionId);
    if (endedAt === undefined) continue; // 无终态不入样(ref:无 stop 不计)。
    result.set(s.sessionId, {
      date: utcDay(endedAt),
      prompts: s.promptCount,
      durationMs: s.durationMs,
      succeeded: !s.hadError && s.interventions.interrupt === 0 && s.interventions.correction === 0 ? 1 : 0,
      corrected: s.interventions.correction > 0 ? 1 : 0,
      tokensIn: tokensBySession.get(s.sessionId)?.in ?? 0,
      tokensOut: tokensBySession.get(s.sessionId)?.out ?? 0,
      toolCalls: tokensBySession.get(s.sessionId)?.tool ?? 0,
      subagents: tokensBySession.get(s.sessionId)?.sub ?? 0,
      llmMs: tokensBySession.get(s.sessionId)?.llm ?? 0,
    });
  }
  return result;
}

/** 快照折叠进日桶。 */
export function computeDailyBuckets(snapshots: Map<string, DashSessionSnapshot>): Record<string, DashDailyBucket> {
  const daily: Record<string, DashDailyBucket> = {};
  for (const snap of snapshots.values()) {
    const b = daily[snap.date] ?? {
      day: snap.date, sessionsEnded: 0, sessionsSucceeded: 0, promptTurns: 0, durationMs: 0,
      sessionsCorrected: 0, tokensIn: 0, tokensOut: 0, toolCalls: 0, subagents: 0, llmMs: 0,
    };
    b.sessionsEnded += 1;
    b.sessionsSucceeded += snap.succeeded;
    b.promptTurns += snap.prompts;
    b.durationMs += snap.durationMs;
    b.sessionsCorrected += snap.corrected;
    b.tokensIn += snap.tokensIn;
    b.tokensOut += snap.tokensOut;
    b.toolCalls += snap.toolCalls;
    b.subagents += snap.subagents;
    b.llmMs += snap.llmMs;
    daily[snap.date] = b;
  }
  return daily;
}

function summarizePeriod(buckets: DashDailyBucket[]): DashTrendPeriod {
  const totals = buckets.reduce((sum, v) => ({
    sessionsEnded: sum.sessionsEnded + v.sessionsEnded,
    sessionsSucceeded: sum.sessionsSucceeded + v.sessionsSucceeded,
    promptTurns: sum.promptTurns + v.promptTurns,
    durationMs: sum.durationMs + v.durationMs,
    sessionsCorrected: sum.sessionsCorrected + v.sessionsCorrected,
    tokensIn: sum.tokensIn + v.tokensIn,
    tokensOut: sum.tokensOut + v.tokensOut,
    subagents: sum.subagents + v.subagents,
    llmMs: sum.llmMs + v.llmMs,
  }), { sessionsEnded: 0, sessionsSucceeded: 0, promptTurns: 0, durationMs: 0, sessionsCorrected: 0, tokensIn: 0, tokensOut: 0, subagents: 0, llmMs: 0 });
  return {
    sessionsEnded: totals.sessionsEnded,
    successRate: totals.sessionsEnded ? totals.sessionsSucceeded / totals.sessionsEnded : null,
    avgPrompts: totals.sessionsEnded ? totals.promptTurns / totals.sessionsEnded : null,
    avgDurationMs: totals.sessionsEnded ? totals.durationMs / totals.sessionsEnded : null,
    avgTokens: totals.sessionsEnded ? (totals.tokensIn + totals.tokensOut) / totals.sessionsEnded : null,
    avgLlmMs: totals.sessionsEnded ? totals.llmMs / totals.sessionsEnded : null,
    correctionRate: totals.sessionsEnded ? totals.sessionsCorrected / totals.sessionsEnded : null,
  };
}

/** 7 天 vs 前 7 天(UTC 窗,ref summarizeTrendWindow 同口径)。 */
export function summarizeTrendWindow(
  daily: Record<string, DashDailyBucket>,
  now = new Date(),
): { current: DashTrendPeriod; previous: DashTrendPeriod } {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const currentStart = end - 6 * 86_400_000;
  const previousStart = currentStart - 7 * 86_400_000;
  const current: DashDailyBucket[] = [];
  const previous: DashDailyBucket[] = [];
  for (const bucket of Object.values(daily)) {
    const ts = Date.parse(`${bucket.day}T00:00:00Z`);
    if (ts >= currentStart && ts <= end) current.push(bucket);
    else if (ts >= previousStart && ts < currentStart) previous.push(bucket);
  }
  return { current: summarizePeriod(current), previous: summarizePeriod(previous) };
}

/**
 * 近 N 天日桶升序面板柱状图数据(C 阶段:token/耗时入趋势图;缺日补零)。
 */
export function dailyWindow(daily: Record<string, DashDailyBucket>, days = 14, now = new Date()): DashDailyBucket[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: DashDailyBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    out.push(daily[day] ?? {
      day, sessionsEnded: 0, sessionsSucceeded: 0, promptTurns: 0, durationMs: 0,
      sessionsCorrected: 0, tokensIn: 0, tokensOut: 0, toolCalls: 0, subagents: 0, llmMs: 0,
    });
  }
  return out;
}

/** 活跃时长口径复用(collector 常量再导出,趋势模块自洽)。 */
export { DASH_IDLE_TIMEOUT_MS };
