/**
 * 使用统计归约(step-046,ZCode UsageStatistics 对齐):journal 全量离线归约成面板可渲染的摘要。
 * 纯函数无外部依赖——同一份 journal 重复计算结果恒定(测试可锚定)。
 */
import type { Journal } from "@lampgenie/core";
import type { TaskSupervisor } from "./task-manager.js";

export interface StatsSummary {
  totals: {
    tasks: number;
    tasksDone: number;
    tasksFailed: number;
    sessions: number;
    turns: number;
    llmCalls: number;
    toolCalls: number;
    tokens: { input: number; output: number; total: number };
    wallMs: number; // 首末事件跨度
    workMs: number; // 任务运行时长合计(startedAt→终态)
  };
  /** 近 N 天每日轮次(YYYY-MM-DD → turns),面板画趋势柱状图。 */
  perDay: { day: string; turns: number; tokens: number }[];
  /** 7×24 活跃热力图(weekday 0=周日 → 24 小时 → turn 数)。 */
  heatmap: number[][];
  /** 会话表(top 20 by tokens):面板使用统计表格。 */
  sessions: { sessionId: string; turns: number; tokens: number; llmCalls: number; toolCalls: number; lastAt: number; tasks: number }[];
  /** 模型维度 token 消耗(message.agent 无模型名时归 unknown)。 */
  byModel: { model: string; calls: number; tokens: number }[];
  /** 工具维度调用次数(step-047)。 */
  byTool: { name: string; calls: number }[];
  /** 活跃度(step-047,ZCode 使用统计 活跃度卡):峰值 token/连续天数。 */
  activity: { peakTokens: number; currentStreak: number; longestStreak: number };
  /** 系统健康度(step-047):近次 LLM 调用的 decode 速度(outputTokens/耗时秒)。 */
  health: { samples: { t: number; tps: number }[]; avgTps: number };
  /** 本地额度(step-048,ZCode 额度卡对齐):今日/本周 token + 周预算与重置时刻。 */
  quota: { today: number; week: number; budget: number; resetAt: number; weekStartAt: number };
  generatedAt: number;
}

const DAY_MS = 86_400_000;

export function computeStatsSummary(journal: Journal, tm: TaskSupervisor, days = 30, weeklyBudget = 0): StatsSummary {
  const events = journal.readAll();
  const sessions = new Map<string, { turns: number; tokens: number; llmCalls: number; toolCalls: number; lastAt: number }>();
  const dayMap = new Map<string, { turns: number; tokens: number }>();
  const heat: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  const modelMap = new Map<string, { calls: number; tokens: number }>();
  const toolMap = new Map<string, number>();
  const health: { t: number; tps: number }[] = [];
  const t = { tasks: 0, tasksDone: 0, tasksFailed: 0, turns: 0, llmCalls: 0, toolCalls: 0, input: 0, output: 0 };
  let minTs = Infinity;
  let maxTs = 0;

  for (const e of events) {
    minTs = Math.min(minTs, e.time ?? Infinity);
    maxTs = Math.max(maxTs, e.time ?? 0);
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const s = sessions.get(e.sessionId) ?? { turns: 0, tokens: 0, llmCalls: 0, toolCalls: 0, lastAt: 0 };
    const ts = e.time ?? 0;
    if (ts > s.lastAt) s.lastAt = ts;

    if (e.kind === "turn.start") {
      t.turns++;
      s.turns++;
      const d = new Date(ts);
      const day = dayKey(ts);
      const drec = dayMap.get(day) ?? { turns: 0, tokens: 0 };
      drec.turns++;
      dayMap.set(day, drec);
      const row = heat[d.getDay()];
      if (row) row[d.getHours()] = (row[d.getHours()] ?? 0) + 1;
    } else if (e.kind === "message.agent") {
      t.llmCalls++;
      s.llmCalls++;
      const u = p.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
      if (u) {
        const inTok = u.inputTokens ?? 0;
        const outTok = u.outputTokens ?? 0;
        const tot = u.totalTokens ?? inTok + outTok;
        t.input += inTok; t.output += outTok;
        s.tokens += tot;
        const day = dayKey(ts);
        const drec = dayMap.get(day) ?? { turns: 0, tokens: 0 };
        drec.tokens += tot;
        dayMap.set(day, drec);
        const model = String(p.model ?? "unknown");
        const m = modelMap.get(model) ?? { calls: 0, tokens: 0 };
        m.calls++; m.tokens += tot;
        modelMap.set(model, m);
        // 健康度采样(decode 速度):outputTokens / llmMs 秒;无效样本跳过。
        const llmMs = Number(p.llmMs ?? 0);
        if (llmMs > 0 && outTok > 0) health.push({ t: ts, tps: Math.round((outTok / (llmMs / 1000)) * 10) / 10 });
      }
    } else if (e.kind === "tool.result") {
      t.toolCalls++;
      s.toolCalls++;
      const tname = String(p.name ?? "unknown");
      toolMap.set(tname, (toolMap.get(tname) ?? 0) + 1);
    }
    sessions.set(e.sessionId, s);
  }

  // 任务侧:TaskSupervisor 当前态 + workMs(startedAt→终态/now)。
  const allTasks = tm.list();
  const workMs = allTasks.reduce((sum, task) => (task.startedAt ? sum + (task.updatedAt - task.startedAt) : sum), 0);

  // 活跃度:峰值 token(单日)+ 连续天数(今天无活动则从昨天起算,宽限一天)。
  let peakTokens = 0;
  for (const [, rec] of dayMap) if (rec.tokens > peakTokens) peakTokens = rec.tokens;
  const hasDay = (d: string) => (dayMap.get(d)?.turns ?? 0) > 0;
  let currentStreak = 0;
  {
    let cursor = hasDay(dayKey(Date.now())) ? Date.now() : Date.now() - DAY_MS;
    while (hasDay(dayKey(cursor))) { currentStreak++; cursor -= DAY_MS; }
  }
  let longestStreak = 0;
  {
    const allDays = [...dayMap.keys()].sort();
    let run = 0, prev = 0;
    for (const d of allDays) {
      const tsd = Date.parse(d + "T00:00:00");
      run = (prev && tsd - prev === DAY_MS) ? run + 1 : 1;
      if (run > longestStreak) longestStreak = run;
      prev = tsd;
    }
  }

  // perDay 补齐空日(近 N 天连续,无洞)。
  const perDay: { day: string; turns: number; tokens: number }[] = [];
  const today = dayKey(Date.now());
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(Date.now() - i * DAY_MS);
    const rec = dayMap.get(day);
    perDay.push({ day, turns: rec?.turns ?? 0, tokens: rec?.tokens ?? 0 });
  }

  // 会话表:合并任务数,top 20 by tokens。
  const taskCount = new Map<string, number>();
  for (const task of allTasks) taskCount.set(task.sessionId, (taskCount.get(task.sessionId) ?? 0) + 1);
  const sessionRows = [...sessions.entries()]
    .map(([sessionId, v]) => ({ sessionId: sessionId.slice(0, 12), ...v, tasks: taskCount.get(sessionId) ?? 0 }))
    .sort((a, b) => b.tokens - a.tokens || b.turns - a.turns)
    .slice(0, 20);

  return {
    totals: {
      tasks: allTasks.length,
      tasksDone: allTasks.filter((x) => x.state === "done").length,
      tasksFailed: allTasks.filter((x) => x.state === "failed" || x.state === "cancelled").length,
      sessions: sessions.size,
      turns: t.turns, llmCalls: t.llmCalls, toolCalls: t.toolCalls,
      tokens: { input: t.input, output: t.output, total: t.input + t.output },
      wallMs: events.length ? maxTs - minTs : 0,
      workMs,
    },
    perDay,
    heatmap: heat,
    sessions: sessionRows,
    // 本地额度:今日(自然日)/本周(周一为界)token;预算热读 config.quota.weeklyTokens(调用方注入)。
    quota: (() => {
      const now = new Date();
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const dow = (now.getDay() + 6) % 7; // 周一=0
      const weekStart = dayStart - dow * DAY_MS;
      let today = 0, week = 0;
      for (const [day, rec] of dayMap) {
        const ts = Date.parse(day + "T00:00:00");
        if (ts >= dayStart) today += rec.tokens;
        if (ts >= weekStart) week += rec.tokens;
      }
      return { today, week, budget: weeklyBudget ?? 0, resetAt: dayStart + DAY_MS, weekStartAt: weekStart };
    })(),
    byModel: [...modelMap.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.tokens - a.tokens),
    byTool: [...toolMap.entries()].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls),
    activity: { peakTokens, currentStreak, longestStreak },
    health: (() => {
      const recent = health.slice(-30);
      const avg = recent.length ? Math.round((recent.reduce((a, b) => a + b.tps, 0) / recent.length) * 10) / 10 : 0;
      return { samples: recent, avgTps: avg };
    })(),
    generatedAt: Date.now(),
  };
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// ---- 用量仪表盘(step-049,refs: ZCode usage dashboard 语义移植):按天×按任务两级归约,纯函数零 IO ----

/** 单日用量聚合(面板条形图一行)。 */
export interface UsageDay {
  date: string;
  tasks: { started: number; done: number; failed: number };
  tokens: { input: number; output: number; cached: number; total: number };
  llmCalls: number;
  steps: number;
  toolCalls: number;
}

/** 任务维度用量(top 表一行)。 */
export interface UsageTaskRow {
  taskId: string;
  sessionId: string;
  title: string;
  /** instruction 摘要(截 80 字符,面板直显)。 */
  instruction: string;
  tokens: { input: number; output: number; total: number };
  steps: number;
  /** startedAt→终态快照 updatedAt;未开跑=0。 */
  durationMs: number;
  state: string;
}

export interface UsageDashboard {
  /** 近 N 天逐日聚合(空日补零,与 StatsSummary.perDay 同窗口口径)。 */
  days: UsageDay[];
  /** Top 任务(按 token 降序,前 10;token 同数按步骤数)。 */
  topTasks: UsageTaskRow[];
  generatedAt: number;
}

/** 任务快照登记(task.* 事件 payload 即 Task,按 id 收最后态)。 */
interface UsageTaskAgg {
  taskId: string;
  sessionId: string;
  title: string;
  instruction: string;
  state: string;
  createdAt: number;
  startedAt: number;
  updatedAt: number;
  input: number;
  output: number;
  steps: number;
}

/**
 * 用量仪表盘归约:只吃 journal 事件,重复计算结果恒定。
 * 任务归属:task.* payload 快照登记任务;message.agent/step.start/tool.result 不带 taskId,
 * 按「同会话内已开始的最近任务(否则已创建的最近任务,再否则首个任务)」时间窗归属;
 * 无任务的会话(如伴侣闲聊)只进天级,不进任务级。
 */
export function computeUsageDashboard(journal: Journal, days = 30): UsageDashboard {
  const events = journal.readAll();
  // 窗口:近 N 个自然日(含今天),与 computeStatsSummary.perDay 同口径。
  const windowDays = new Set<string>();
  for (let i = days - 1; i >= 0; i--) windowDays.add(dayKey(Date.now() - i * DAY_MS));

  const dayMap = new Map<string, UsageDay>();
  const blankDay = (date: string): UsageDay => ({
    date,
    tasks: { started: 0, done: 0, failed: 0 },
    tokens: { input: 0, output: 0, cached: 0, total: 0 },
    llmCalls: 0, steps: 0, toolCalls: 0,
  });
  const dayOf = (ts: number): UsageDay | undefined => {
    const date = dayKey(ts);
    if (!windowDays.has(date)) return undefined;
    let rec = dayMap.get(date);
    if (!rec) { rec = blankDay(date); dayMap.set(date, rec); }
    return rec;
  };

  const taskMap = new Map<string, UsageTaskAgg>();
  const sessionTasks = new Map<string, UsageTaskAgg[]>();
  const registerTask = (snap: Partial<UsageTaskAgg> & { id?: string }): void => {
    if (typeof snap.id !== "string" || !snap.id) return;
    let agg = taskMap.get(snap.id);
    if (!agg) {
      agg = {
        taskId: snap.id,
        sessionId: String(snap.sessionId ?? ""),
        title: String(snap.title ?? ""),
        instruction: String(snap.instruction ?? "").slice(0, 80),
        state: String(snap.state ?? "queued"),
        createdAt: Number(snap.createdAt ?? 0),
        startedAt: Number(snap.startedAt ?? 0),
        updatedAt: Number(snap.updatedAt ?? 0),
        input: 0, output: 0, steps: 0,
      };
      taskMap.set(snap.id, agg);
      const list = sessionTasks.get(agg.sessionId) ?? [];
      list.push(agg);
      sessionTasks.set(agg.sessionId, list);
    } else {
      // 后到快照覆盖(终态/重命名/startedAt 刷新),title 空白不覆盖已登记名。
      if (snap.title) agg.title = String(snap.title);
      if (snap.state) agg.state = String(snap.state);
      if (snap.startedAt) agg.startedAt = Number(snap.startedAt);
      if (snap.updatedAt) agg.updatedAt = Number(snap.updatedAt);
    }
  };
  // 时间窗归属:最近一次 startedAt≤t 的任务;没开跑过则最近 createdAt≤t;再无=该会话首个任务。
  const attribute = (sessionId: string, t: number): UsageTaskAgg | undefined => {
    const list = sessionTasks.get(sessionId);
    if (!list || list.length === 0) return undefined;
    let best: UsageTaskAgg | undefined;
    for (const tk of list) if (tk.startedAt > 0 && tk.startedAt <= t && (!best || tk.startedAt >= best.startedAt)) best = tk;
    if (best) return best;
    for (const tk of list) if (tk.createdAt > 0 && tk.createdAt <= t && (!best || tk.createdAt >= best.createdAt)) best = tk;
    return best ?? list[0];
  };

  for (const e of events) {
    const ts = e.time ?? 0;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.kind.startsWith("task.")) registerTask(p as Partial<UsageTaskAgg> & { id?: string });
    const rec = dayOf(ts);
    if (e.kind === "task.start") { if (rec) rec.tasks.started++; }
    else if (e.kind === "task.done") { if (rec) rec.tasks.done++; }
    else if (e.kind === "task.fail") { if (rec) rec.tasks.failed++; }
    else if (e.kind === "step.start") { if (rec) { rec.steps++; const tk = attribute(e.sessionId, ts); if (tk) tk.steps++; } }
    else if (e.kind === "tool.result") { if (rec) rec.toolCalls++; }
    else if (e.kind === "message.agent") {
      if (rec) rec.llmCalls++;
      const u = p.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedTokens?: number } | undefined;
      // 窗口外事件:天级不记,任务级同样不记(两级同窗,token 归属不漏窗不越窗)。
      if (u && rec) {
        const inTok = u.inputTokens ?? 0;
        const outTok = u.outputTokens ?? 0;
        const tot = u.totalTokens ?? inTok + outTok;
        const cached = u.cachedTokens ?? 0;
        rec.tokens.input += inTok; rec.tokens.output += outTok;
        rec.tokens.cached += cached; rec.tokens.total += tot;
        const tk = attribute(e.sessionId, ts);
        if (tk) { tk.input += inTok; tk.output += outTok; }
      }
    }
  }

  // 逐日输出:窗口内空日补零(连续无洞),旧事件不进窗口。
  const outDays: UsageDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = dayKey(Date.now() - i * DAY_MS);
    outDays.push(dayMap.get(date) ?? blankDay(date));
  }

  const topTasks: UsageTaskRow[] = [...taskMap.values()]
    .map((tk) => ({
      taskId: tk.taskId,
      sessionId: tk.sessionId,
      title: tk.title,
      instruction: tk.instruction,
      tokens: { input: tk.input, output: tk.output, total: tk.input + tk.output },
      steps: tk.steps,
      durationMs: tk.startedAt ? Math.max(0, tk.updatedAt - tk.startedAt) : 0,
      state: tk.state,
    }))
    .sort((a, b) => b.tokens.total - a.tokens.total || b.steps - a.steps)
    .slice(0, 10);

  return { days: outDays, topTasks, generatedAt: Date.now() };
}
