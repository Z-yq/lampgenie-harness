/**
 * M23 指导可度量(2026-11-07),纯函数层。
 *
 * 问题:机制/提示词改完只凭感觉说「变好了」,回答不了「哪条 tips 真的改变了行为、值不值这份 token」。
 * 口径:每条 tips 在注册表里带三件事——触发条件(trigger)、预期行为(expected)、度量指标(metric);
 * 任务收尾按本任务 journal 窗口算计数器与比率,供与历次会话汇总做前后对比。
 *
 * 数据源只有本任务事件(调用方用 `journal.readSession(sessionId, taskStartSeq)` 切片,不 readAll):
 *  step.start / step.end         → steps、并行步(step 区间内 tool.call ≥2)
 *  tool.call(name,arguments)     → toolCalls / read_file 路径 / board_upsert / terminal 验证命令
 *  tool.result(content)          → reworkCalls(错误/超时)
 *  tip.injected(payload.keys)    → 各 tip 注入次数
 *  llm.trace(payload.usage)      → tokens(totalTokens 求和;缺失忽略,不估算)
 *
 * 纪律:指标全部确定性(零 LLM、零启发式打分);没有真源就留 0,不写「看起来合理」的假数。
 */
import { isVerificationCommand } from "./verification-ledger.js";

/** 六条验证指标口径(趋势分析维度)+ unknown(未登记 tip 的诚实兜底)。 */
export type GuidanceMetricKind =
  | "verification"
  | "parallel"
  | "read-dedup"
  | "board"
  | "steps-tokens"
  | "rework"
  | "unknown";

/** 一条 tip 的可度量规格(注入时与收尾汇总都带上,别处不必再猜)。 */
export interface TipMetricSpec {
  /** tip key(与 buildLoopTips 的 keys 逐字一致)。 */
  key: string;
  /** 触发条件:什么步态/事件下会注入。 */
  trigger: string;
  /** 预期行为:注入后希望模型改做什么。 */
  expected: string;
  /** 该 tip 用哪条指标验效果。 */
  metric: GuidanceMetricKind;
}

/** 注册表条目不重复写 key(键即 key)。 */
type TipMetricEntry = Omit<TipMetricSpec, "key" | "metric"> & { metric: Exclude<GuidanceMetricKind, "unknown"> };

/**
 * tip key → 触发条件 / 预期行为 / 度量指标。
 * key 全取自 buildLoopTips 实际 pushKey 的名字(SOP 阶段卡 / dispatch / 并行 / 动态卡 / 轨迹回看 / 评论投递),
 * 未登记的 key 由 tipMetricOf 记为 metric="unknown"(保留不丢,便于发现新 key 漏口径)。
 */
export const TIP_METRICS: Readonly<Record<string, TipMetricEntry>> = {
  dispatch: {
    trigger: "首次出现 spawn_subagent 工具调用(同任务一次为限,compact 后允许再注一次)",
    expected: "任务书带动词/目标/验收,大勘察派给子代理,主轨只收结论",
    metric: "steps-tokens",
  },
  "board-comments": {
    trigger: "takePendingComments(sessionId) 非空(用户在白板留了评论)",
    expected: "评论被消费:按评论改板或改代码,不留未处理评论",
    metric: "board",
  },
  parallel: {
    trigger: "上一步只发了 1 个可配对的只读探测工具(code_sense/read_file/grep/glob/list_dir/board_read/tool_view/session_search/view_image)",
    expected: "无依赖动作合并到同一条消息一起发",
    metric: "parallel",
  },
  "task:trajectory": {
    trigger: "loop 落了一条新轨迹摘要且与上次注入内容不同",
    expected: "回看走到哪,方向偏了回阶段锚",
    metric: "steps-tokens",
  },
  "sop:understand": {
    trigger: "phase 首见 understand",
    expected: "需求反述 + 三问 + 类别/直达路由判定",
    metric: "steps-tokens",
  },
  "sop:plan": {
    trigger: "phase 首见 plan(全链路变更类任务换成盘点卡)",
    expected: "先查影响面、方案 ≥2,再落板(变更类先 change_surface scan)",
    metric: "board",
  },
  "sop:implement": {
    trigger: "phase 首见 implement",
    expected: "小步改、每改必验;变更集外既有失败登记不修",
    metric: "verification",
  },
  "sop:debug": {
    trigger: "phase 首见 debug,或上一步工具带错且 debug 卡未注入",
    expected: "先假设再验证,同一逻辑最多 2 轮,修完写根因",
    metric: "rework",
  },
  "sop:close": {
    trigger: "phase 首见 close(全链路变更类任务换成残留审计卡)",
    expected: "三段汇报 + P0 证据全绿才宣称完成(变更类先 audit)",
    metric: "verification",
  },
  "dyn:hypothesis": {
    trigger: "同一文件连续被改动 ≥3 步",
    expected: "先读后写:锚定假设再动手,别盲改",
    metric: "read-dedup",
  },
  "dyn:verify-stop": {
    trigger: "验证轮次 ≥2 且累计工具错误 ≥2",
    expected: "停下改那一处,不接着改下一处",
    metric: "rework",
  },
  "dyn:phase-align": {
    trigger: "步数 >40 且本任务从未落板",
    expected: "落板对齐目标与验收",
    metric: "board",
  },
  "dyn:verify-cadence": {
    trigger: "步数 ≥12 且距上次验证 ≥10 步",
    expected: "插入一次验证再继续改",
    metric: "verification",
  },
  "dyn:delegate": {
    trigger: "步数 ≥25 且从未 spawn_subagent 且本任务累计 tokens ≥120k",
    expected: "把独立调研派给子代理,隔离上下文",
    metric: "steps-tokens",
  },
};

/** 单个 key 的完整规格;未登记 key → metric="unknown" 但保留。 */
export function tipMetricOf(key: string): TipMetricSpec {
  const m = TIP_METRICS[key];
  if (m) return { key, trigger: m.trigger, expected: m.expected, metric: m.metric };
  return { key, trigger: "(未登记口径)", expected: "(未登记口径)", metric: "unknown" };
}

/** journal 事件最小面(测试可直接喂普通对象)。 */
export interface GuidanceMetricsEvent {
  seq: number;
  kind: string;
  time?: number;
  payload?: unknown;
}

export interface GuidanceCounters {
  steps: number;
  toolCalls: number;
  /** 同一步内 tool.call ≥2 的步数(按 step.start/step.end 区间归组;区间外按 turn/step 键归组)。 */
  parallelSteps: number;
  /** read_file 同一 path 在本任务窗口内出现 >1 的额外次数(第 2 次起各计 1)。 */
  repeatReads: number;
  boardWrites: number;
  verificationCommands: number;
  /** tool.result content 以「错误」开头或含「工具执行超时」的条数。 */
  reworkCalls: number;
  /** llm.trace payload.usage.totalTokens 求和(缺失忽略)。 */
  tokens: number;
}

export interface GuidanceRates {
  /** parallelSteps / 有工具调用的 step 数。 */
  parallelRate: number;
  /** repeatReads / read_file 调用数。 */
  repeatReadRate: number;
  /** 本任务是否落过板:0 / 1。 */
  boardRate: number;
  /** reworkCalls / toolCalls。 */
  reworkRate: number;
}

export interface GuidanceMetrics {
  /** 本任务注入过的 tip(按次数降序;未登记 key 也在,metric="unknown")。 */
  tips: (TipMetricSpec & { count: number })[];
  counters: GuidanceCounters;
  rates: GuidanceRates;
}

function payloadOf(e: GuidanceMetricsEvent): Record<string, unknown> {
  return (e.payload && typeof e.payload === "object" ? e.payload : {}) as Record<string, unknown>;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function finiteOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 本任务窗口的指导可度量汇总(纯函数:同输入同输出,零 io)。 */
export function computeGuidanceMetrics(events: readonly GuidanceMetricsEvent[]): GuidanceMetrics {
  const evs = [...events].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  const counters: GuidanceCounters = {
    steps: 0, toolCalls: 0, parallelSteps: 0, repeatReads: 0,
    boardWrites: 0, verificationCommands: 0, reworkCalls: 0, tokens: 0,
  };
  const tipCounts = new Map<string, number>();
  const readCounts = new Map<string, number>();
  // 并行归组:正常路径 step.start 开桶、step.end 关桶;区间之外的 tool.call(单测直喂 /
  // 直调 execOne 的 0/0 占位)按 turn:step 落隐式桶——两条路径都不丢调用。
  const buckets: string[][] = [];
  const implicit = new Map<string, string[]>();
  let open: string[] | null = null;

  for (const e of evs) {
    if (e.kind === "step.start") {
      counters.steps += 1;
      open = [];
      buckets.push(open);
      continue;
    }
    if (e.kind === "step.end") {
      open = null;
      continue;
    }
    if (e.kind === "tip.injected") {
      const keys = payloadOf(e).keys;
      if (Array.isArray(keys)) for (const k of keys) if (typeof k === "string" && k) tipCounts.set(k, (tipCounts.get(k) ?? 0) + 1);
      continue;
    }
    if (e.kind === "llm.trace") {
      const usage = payloadOf(e).usage;
      if (usage && typeof usage === "object") counters.tokens += finiteOf((usage as Record<string, unknown>).totalTokens);
      continue;
    }
    if (e.kind === "tool.result") {
      const p = payloadOf(e);
      const text = typeof p.content === "string" ? p.content.trim() : "";
      if (text.startsWith("错误") || text.includes("工具执行超时")) counters.reworkCalls += 1;
      continue;
    }
    if (e.kind !== "tool.call") continue;
    const p = payloadOf(e);
    const name = String(p.name ?? "");
    counters.toolCalls += 1;
    if (open) open.push(name);
    else {
      const k = `${String(p.turn ?? "")}:${String(p.step ?? "")}`;
      let arr = implicit.get(k);
      if (!arr) { arr = []; implicit.set(k, arr); }
      arr.push(name);
    }
    if (name === "board_upsert") counters.boardWrites += 1;
    if (name === "read_file") {
      const a = parseArgs(p.arguments);
      const path = typeof a.path === "string" && a.path.trim() ? a.path.trim()
        : typeof a.file_path === "string" ? a.file_path.trim() : "";
      if (path) readCounts.set(path, (readCounts.get(path) ?? 0) + 1);
    }
    if (name === "terminal") {
      const a = parseArgs(p.arguments);
      const command = typeof a.command === "string" ? a.command.trim() : "";
      if (command && isVerificationCommand(command)) counters.verificationCommands += 1;
    }
  }

  const callBuckets = [...buckets.filter((b) => b.length > 0), ...implicit.values()];
  counters.parallelSteps = callBuckets.filter((b) => b.length >= 2).length;
  let readCalls = 0;
  for (const n of readCounts.values()) {
    readCalls += n;
    if (n > 1) counters.repeatReads += n - 1;
  }

  const rates: GuidanceRates = {
    parallelRate: callBuckets.length ? counters.parallelSteps / callBuckets.length : 0,
    repeatReadRate: readCalls ? counters.repeatReads / readCalls : 0,
    boardRate: counters.boardWrites > 0 ? 1 : 0,
    reworkRate: counters.toolCalls ? counters.reworkCalls / counters.toolCalls : 0,
  };

  const tips = [...tipCounts.entries()]
    .map(([key, count]) => ({ ...tipMetricOf(key), count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return { tips, counters, rates };
}

const METRIC_LABEL: Readonly<Record<GuidanceMetricKind, string>> = {
  verification: "验证节奏",
  parallel: "并行率",
  "read-dedup": "重复读",
  board: "落板率",
  "steps-tokens": "步数/token",
  rework: "返工率",
  unknown: "未登记",
};

/** 一行摘要 + tips 清单(日志/面板用;≤800 字,超长截断)。 */
export function renderGuidanceSummary(m: GuidanceMetrics): string {
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  const head = `[指导度量] 步骤 ${m.counters.steps} · 工具 ${m.counters.toolCalls} · 并行 ${pct(m.rates.parallelRate)}`
    + ` · 重复读 ${pct(m.rates.repeatReadRate)} · 落板 ${m.rates.boardRate}/1`
    + ` · 验证命令 ${m.counters.verificationCommands} · 返工 ${pct(m.rates.reworkRate)}`
    + ` · tokens ${m.counters.tokens}`;
  const tipLines = m.tips.slice(0, 8).map((t) => `- ${t.key}×${t.count}(${METRIC_LABEL[t.metric]})`);
  const text = [head, ...(tipLines.length ? ["tips:", ...tipLines] : [])].join("\n");
  return text.length > 800 ? text.slice(0, 799) + "…" : text;
}
