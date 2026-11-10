/**
 * RSI 周报 IO 层(聚合六源 + 纠错落地 + 事件/提醒)。
 *
 * 为什么需要它:周报的纯逻辑(build/render/planCorrection/shouldRemindPending)零 IO,
 * 六个真源(实验账本、成本台账、断路器、自我修改审批、注入审批、证据图冲突)各自是一个 store。
 * 本模块只干「把真源读成 WeeklyInput、把纠错动作写回真源、把事件落到 weekly.jsonl」,
 * 不重复任何统计口径(全部委托 runtime 的纯函数)。
 *
 * 数据面:`<root>/.genie/rsi/weekly.jsonl`(逐行 JSON,只增不改;坏行读取时跳过)。
 *
 * 依赖纪律:
 * - 只 import gateway 既有 store + runtime 纯逻辑;不改任何既有模块。
 * - 聚合侧每个源独立 try/catch:失败 = 该源缺失(传 undefined/[]),绝不把异常抛给调用方;
 *   参数非法(root 空)是唯一允许 throw 的情形。
 * - 成本台账没有时间戳(rsi-cost-store 的 cycle 无 at),带 from/to 时统计仍是全量,
 *   因此在 warnings 里追加 `cost-window-unsupported`(去重),而不是假装按窗口过滤。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  buildWeeklyReport,
  renderWeeklyReportText,
  shouldRemindPending,
  type BreakerSummary,
  type ConflictSummary,
  type CostSummary,
  type DecisionKind,
  type ExperimentSummary,
  type MetricSummary,
  type PendingApproval,
  type WeeklyInput,
  type WeeklyReport,
} from "@lampgenie/runtime/agent/rsi-weekly-report";
import { conflicts as evidenceConflicts, correctEvidence, history as evidenceHistory } from "./evidence-graph-store";
import { decideExperiment, listExperiments } from "./experiment-store";
import { getState as getBreakerState } from "./rsi-breaker-store";
import { readInjectionLedger, reportInjections } from "./rsi-injection-store";
import { listModifications } from "./self-modification-store";
import { reportCost } from "./rsi-cost-store";

/** 周报事件账本(相对 root)。 */
export const WEEKLY_LEDGER_REL = ".genie/rsi/weekly.jsonl";

/** 周报缺省窗口长度:7 天。 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** 注入待批明细最多展开几条(超出折叠成一条汇总)。 */
const INJECTION_DETAIL_MAX = 5;

/** 周报事件(生成 / 提醒 / 纠错)。 */
export interface WeeklyEvent {
  kind: "generated" | "reminded" | "corrected";
  at: string;
  [k: string]: unknown;
}

/** 纠错动作入参(与 CLI 逐字对齐)。 */
export interface CorrectFromReportInput {
  kind: "rewrite" | "disable" | "rollback";
  target: string;
  by: string;
  reason: string;
  newStatement?: string;
}

// ---------------------------------------------------------------------------
// 小工具(类型宽松:真源字段缺失/类型不对一律当缺失)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

function isoOf(value: unknown): string | undefined {
  const ms = toMs(value);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

function latestIso(values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const ms = toMs(value);
    if (ms === undefined || ms < bestMs) continue;
    bestMs = ms;
    best = value;
  }
  return best;
}

/** 样本统计量的代表值(mean/value,sample 不算代表值)。 */
function statValue(value: unknown): number | undefined {
  const direct = num(value);
  if (direct !== undefined) return direct;
  const rec = asRecord(value);
  return num(rec["value"]) ?? num(rec["mean"]);
}

// ---------------------------------------------------------------------------
// 六源 → WeeklyInput
// ---------------------------------------------------------------------------

const DECISION_KINDS = new Set(["adopt", "reject", "iterate", "rollback", "pending"]);

function metricSummaryOf(raw: unknown): MetricSummary | undefined {
  const rec = asRecord(raw);
  const name = str(rec["name"]);
  const baseline = statValue(rec["baseline"]);
  if (name === undefined || baseline === undefined) return undefined;
  const direction = rec["direction"] === "decrease" ? "decrease" : "increase";
  const out: MetricSummary = { name, direction, baseline };
  const result = statValue(rec["result"]);
  if (result !== undefined) out.result = result;
  const threshold = num(asRecord(rec["thresholds"])["minEffectPct"]);
  if (threshold !== undefined) out.threshold = threshold;
  const unit = str(rec["unit"]);
  if (unit !== undefined) out.unit = unit;
  return out;
}

function experimentSummaryOf(raw: unknown): ExperimentSummary | undefined {
  const rec = asRecord(raw);
  const id = str(rec["id"]);
  const claim = str(asRecord(rec["hypothesis"])["claim"]);
  if (id === undefined || claim === undefined) return undefined;
  const intervention = asRecord(rec["intervention"]);
  const decision = asRecord(rec["decision"]);
  const kindRaw = str(decision["kind"]);
  const decisionKind: DecisionKind =
    kindRaw !== undefined && DECISION_KINDS.has(kindRaw) ? (kindRaw as DecisionKind) : "pending";

  const metrics: MetricSummary[] = [];
  const rawMetrics = rec["metrics"];
  if (Array.isArray(rawMetrics)) {
    for (const entry of rawMetrics) {
      const metric = metricSummaryOf(entry);
      if (metric !== undefined) metrics.push(metric);
    }
  }

  const evidenceRefs = Array.isArray(rec["evidence"])
    ? (rec["evidence"] as unknown[]).map((ref) => str(ref)).filter((ref): ref is string => ref !== undefined)
    : [];

  const out: ExperimentSummary = {
    id,
    claim,
    surface: str(intervention["surface"]) ?? "",
    ref: str(intervention["ref"]) ?? "",
    variant: str(intervention["variant"]) ?? "",
    decision: decisionKind,
    metrics,
    evidenceRefs,
  };
  const decidedAt = decision["at"];
  if (typeof decidedAt === "number" || typeof decidedAt === "string") out.decidedAt = decidedAt;
  const rollbackPoint = str(asRecord(rec["rollbackPoint"])["ref"]);
  if (rollbackPoint !== undefined) out.rollbackPoint = rollbackPoint;
  return out;
}

function experimentsOf(root: string, window: { from?: string; to?: string }): ExperimentSummary[] | undefined {
  try {
    const filter = window.from !== undefined && window.to !== undefined ? { window: { from: window.from, to: window.to } } : undefined;
    const rows = listExperiments(root, filter);
    if (!Array.isArray(rows)) return undefined;
    const out: ExperimentSummary[] = [];
    for (const row of rows) {
      const summary = experimentSummaryOf(row);
      if (summary !== undefined) out.push(summary);
    }
    return out;
  } catch {
    return undefined;
  }
}

function allocationMap(rows: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const rec = asRecord(row);
    const key = str(rec["key"]);
    const net = num(rec["netTokens"]);
    if (key === undefined || net === undefined) continue;
    out[key] = net;
  }
  return out;
}

function costOf(root: string): CostSummary | undefined {
  const zero: CostSummary = {
    costTokens: 0,
    savingTokens: 0,
    netTokens: 0,
    roi: null,
    byMechanism: {},
    byProject: {},
  };
  try {
    const report = asRecord(reportCost(root));
    const cycles = Array.isArray(report["cycles"]) ? report["cycles"] : [];
    if (report["ok"] !== true || cycles.length === 0) return zero;
    const totals = asRecord(report["totals"]);
    return {
      costTokens: num(totals["costTokens"]) ?? 0,
      savingTokens: num(totals["savingTokens"]) ?? 0,
      netTokens: num(totals["netTokens"]) ?? 0,
      roi: num(totals["roi"]) ?? null,
      byMechanism: allocationMap(report["byMechanism"]),
      byProject: allocationMap(report["byProject"]),
    };
  } catch {
    return undefined;
  }
}

async function breakerOf(root: string): Promise<BreakerSummary | undefined> {
  try {
    const state = asRecord(await getBreakerState(root));
    if (state["paused"] !== true) return undefined;
    const out: BreakerSummary = { paused: true };
    const scope = str(state["scope"]);
    if (scope !== undefined) out.scope = scope;
    const trigger = str(state["trigger"]);
    if (trigger !== undefined) out.trigger = trigger;
    const reason = str(state["reason"]);
    if (reason !== undefined) out.reason = reason;
    const pausedAt = isoOf(state["pausedAt"]);
    if (pausedAt !== undefined) out.pausedAt = pausedAt;
    return out;
  } catch {
    return undefined;
  }
}

function selfModPendingOf(root: string): PendingApproval[] {
  const out: PendingApproval[] = [];
  try {
    const rows = listModifications(root, { decision: "need-approval" });
    for (const row of rows) {
      const rec = asRecord(row);
      const id = str(rec["id"]);
      if (id === undefined) continue;
      const item: PendingApproval = {
        kind: "self-modification",
        id,
        summary: str(rec["summary"]) ?? `自我修改 ${id}`,
      };
      const since = isoOf(rec["createdAt"]);
      if (since !== undefined) item.since = since;
      out.push(item);
    }
  } catch {
    return [];
  }
  return out;
}

function injectionPendingOf(root: string): PendingApproval[] {
  try {
    const report = asRecord(reportInjections(root));
    const pending = num(report["pendingApproval"]) ?? 0;
    if (pending <= 0) return [];
    let lines: Array<Record<string, unknown>> = [];
    try {
      const ledger = readInjectionLedger(root);
      const all = Array.isArray(ledger.lines) ? ledger.lines : [];
      const approved = new Set<string>();
      for (const line of all) {
        const rec = asRecord(line);
        if (rec["type"] === "approve") {
          const id = str(rec["id"]);
          if (id !== undefined) approved.add(id);
        }
      }
      lines = all
        .map((line) => asRecord(line))
        .filter((rec) => {
          if (rec["type"] !== "evaluate") return false;
          const id = str(rec["id"]);
          if (id === undefined || approved.has(id)) return false;
          const codes = Array.isArray(rec["codes"]) ? rec["codes"] : [];
          return codes.length > 0;
        });
    } catch {
      lines = [];
    }
    if (lines.length === 0) {
      return [
        {
          kind: "injection",
          id: "injection:pending",
          summary: `${pending} 条注入评估待审批`,
          since: isoOf(Date.now()),
        },
      ];
    }
    const picked = lines.slice(0, Math.min(pending, INJECTION_DETAIL_MAX));
    return picked.map((rec, index) => {
      const codes = Array.isArray(rec["codes"])
        ? (rec["codes"] as unknown[]).map((code) => str(code)).filter((code): code is string => code !== undefined)
        : [];
      const sourceId = str(rec["sourceId"]) ?? "unknown";
      const item: PendingApproval = {
        kind: "injection",
        id: str(rec["id"]) ?? `injection:${index}`,
        summary: `注入评估待审批:${sourceId}(${codes.join(",") || "无码"})`,
      };
      const since = latestIso([isoOf(rec["at"]), isoOf(Date.now())]);
      if (since !== undefined) item.since = since;
      return item;
    });
  } catch {
    return [];
  }
}

function pendingApprovalsOf(root: string): PendingApproval[] {
  return [...selfModPendingOf(root), ...injectionPendingOf(root)];
}

function conflictsOf(graphRoot: string): ConflictSummary[] | undefined {
  try {
    const rows = evidenceConflicts(graphRoot);
    if (!Array.isArray(rows)) return [];
    const out: ConflictSummary[] = [];
    for (const row of rows) {
      const rec = asRecord(row);
      const associationKey = str(rec["associationKey"]);
      if (associationKey === undefined) continue;
      const nodes = Array.isArray(rec["nodes"]) ? rec["nodes"] : [];
      const statements = nodes
        .map((node) => str(asRecord(node)["statement"]))
        .filter((statement): statement is string => statement !== undefined);
      const item: ConflictSummary = {
        associationKey,
        kind: str(rec["kind"]) ?? "unknown",
        statements,
      };
      const latestId = str(rec["latestId"]);
      if (latestId !== undefined) item.latestId = latestId;
      const authoritativeId = str(rec["authoritativeId"]);
      if (authoritativeId !== undefined) item.authoritativeId = authoritativeId;
      out.push(item);
    }
    return out;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

/**
 * 聚合六源成一份周报。
 * - from/to 缺省 = [now-7d, now];window 也用于实验过滤(实验有时间戳)。
 * - 成本台账无时间戳:带 from/to 时统计仍为全量,追加 `cost-window-unsupported`。
 * - 每源独立容错:任何 store 抛错 → 该源缺失,调用方看到的仍是完整报告结构。
 */
export async function aggregateWeekly(
  root: string,
  opts: { from?: string; to?: string; attentionOnly?: boolean; now?: number | string; graphRoot?: string } = {},
): Promise<WeeklyReport> {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError("aggregateWeekly: root 必须是非空字符串");
  const nowMs = toMs(opts.now) ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const fromIso = str(opts.from) ?? new Date(nowMs - WEEK_MS).toISOString();
  const toIso = str(opts.to) ?? nowIso;
  const graphRoot = str(opts.graphRoot) ?? root;

  const experiments = experimentsOf(root, { from: opts.from === undefined ? undefined : fromIso, to: opts.to === undefined ? undefined : toIso });
  const cost = costOf(root);
  const breaker = await breakerOf(root);
  const pendingApprovals = pendingApprovalsOf(root);
  const conflicts = conflictsOf(graphRoot);

  const input: WeeklyInput = {};
  if (experiments !== undefined) input.experiments = experiments;
  if (cost !== undefined) input.cost = cost;
  if (breaker !== undefined) input.breaker = breaker;
  if (pendingApprovals.length > 0) input.pendingApprovals = pendingApprovals;
  if (conflicts !== undefined) input.conflicts = conflicts;

  const report = buildWeeklyReport(input, {
    window: { from: fromIso, to: toIso },
    now: opts.now ?? nowMs,
    attentionOnly: opts.attentionOnly === true,
  });

  if ((str(opts.from) !== undefined || str(opts.to) !== undefined) && !report.warnings.includes("cost-window-unsupported")) {
    report.warnings.push("cost-window-unsupported");
  }
  return report;
}

// ---------------------------------------------------------------------------
// 纠错落地
// ---------------------------------------------------------------------------

/**
 * 把一次纠错动作写回真源,并记一条 corrected 事件。
 * - rewrite / disable → 证据图 correctEvidence(disable 无 newStatement 时把 `[disabled] reason` 当新说法,
 *   并追加 `disable-as-statement` 码,提示调用方这是降级表达)。
 * - rollback → target 以 "ev-" 开头走证据图,否则走实验账本 decideExperiment(rollback)。
 * - 任何 store 抛错 → {ok:false, codes:["store-error"]}(不 throw)。
 */
export async function correctFromReport(
  root: string,
  input: CorrectFromReportInput,
  opts: { graphRoot?: string; now?: number | string } = {},
): Promise<{ ok: boolean; graphNodeId?: string; historyLength?: number; codes: string[] }> {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError("correctFromReport: root 必须是非空字符串");
  const graphRoot = str(opts.graphRoot) ?? root;
  const codes: string[] = [];
  try {
    const viaEvidence = input.kind !== "rollback" || input.target.startsWith("ev-");
    let ok = false;
    let graphNodeId: string | undefined;

    if (viaEvidence) {
      const statement =
        input.newStatement ?? (input.kind === "disable" ? `[disabled] ${input.reason}` : undefined);
      if (input.kind === "disable" && input.newStatement === undefined) codes.push("disable-as-statement");
      const at = toMs(opts.now);
      const res = correctEvidence(graphRoot, input.target, {
        statement,
        by: input.by,
        reason: input.reason,
        ...(at === undefined ? {} : { at }),
      });
      ok = res.ok === true;
      if (res.id !== undefined) graphNodeId = res.id;
      if (typeof res.code === "string") codes.push(res.code);
    } else {
      const res = decideExperiment(root, input.target, "rollback", { by: input.by, reason: input.reason });
      ok = res.ok === true;
      if (typeof res.code === "string") codes.push(res.code);
      if (Array.isArray(res.codes)) codes.push(...res.codes);
    }

    if (!ok) return { ok: false, codes };

    let historyLength: number | undefined;
    try {
      historyLength = evidenceHistory(graphRoot, input.target).length;
    } catch {
      historyLength = undefined;
    }

    appendWeeklyEvent(root, {
      kind: "corrected",
      target: input.target,
      correctionKind: input.kind,
      by: input.by,
      reason: input.reason,
      graphNodeId,
    });

    const out: { ok: boolean; graphNodeId?: string; historyLength?: number; codes: string[] } = { ok: true, codes };
    if (graphNodeId !== undefined) out.graphNodeId = graphNodeId;
    if (historyLength !== undefined) out.historyLength = historyLength;
    return out;
  } catch {
    return { ok: false, codes: ["store-error"] };
  }
}

// ---------------------------------------------------------------------------
// 报告落文件
// ---------------------------------------------------------------------------

/** 把周报渲染成 markdown 写到 path(相对 path 按 root 解析),返回实际绝对路径。 */
export function writeReportFile(root: string, report: WeeklyReport, path: string): string {
  const abs = isAbsolute(path) ? path : resolve(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, renderWeeklyReportText(report), "utf8");
  return abs;
}

// ---------------------------------------------------------------------------
// 事件账本 / 提醒
// ---------------------------------------------------------------------------

function weeklyLedgerPath(root: string): string {
  return join(root, WEEKLY_LEDGER_REL);
}

/** 追加一条周报事件(自动建目录;at 缺省=现在,统一归一成 ISO)。 */
export function appendWeeklyEvent(
  root: string,
  event: { kind: WeeklyEvent["kind"]; at?: number | string; [k: string]: unknown },
): { ok: boolean; path: string } {
  const path = weeklyLedgerPath(root);
  try {
    const at = isoOf(event.at) ?? new Date().toISOString();
    const line = JSON.stringify({ ...event, kind: event.kind, at });
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`, "utf8");
    return { ok: true, path };
  } catch {
    return { ok: false, path };
  }
}

/** 读全部周报事件(坏行跳过;文件不存在 → [])。 */
export function readWeeklyEvents(root: string): WeeklyEvent[] {
  let raw: string;
  try {
    raw = readFileSync(weeklyLedgerPath(root), "utf8");
  } catch {
    return [];
  }
  const out: WeeklyEvent[] = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const kind = str(parsed["kind"]);
    if (kind !== "generated" && kind !== "reminded" && kind !== "corrected") continue;
    const at = str(parsed["at"]);
    if (at === undefined) continue;
    out.push({ ...parsed, kind, at } as WeeklyEvent);
  }
  return out;
}

/** 最近一次提醒时间(毫秒;从未提醒 → undefined)。 */
export function lastRemindedAt(root: string): number | undefined {
  let best: number | undefined;
  for (const event of readWeeklyEvents(root)) {
    if (event.kind !== "reminded") continue;
    const ms = toMs(event.at);
    if (ms === undefined) continue;
    if (best === undefined || ms > best) best = ms;
  }
  return best;
}

/**
 * 该不该发提醒:lastRemindedAt + runtime 的 TTL 判断。
 * 只返回结论,**不**自动写 reminded 事件(由调用方在真正发出后自己写)。
 */
export function shouldRemind(
  root: string,
  report: WeeklyReport,
  opts: { now?: number | string; ttlMs?: number } = {},
): { remind: boolean; reason: string; dueAt?: number } {
  const last = lastRemindedAt(root);
  const nowMs = toMs(opts.now) ?? Date.now();
  const ttl = typeof opts.ttlMs === "number" && Number.isFinite(opts.ttlMs) ? opts.ttlMs : undefined;
  // runtime 只认 ttlMs > 0(非正数会被当成缺失而回落 24h)。本层把 ttlMs<=0 解释成「立即到期」:
  // 传最小正 TTL + 把 now 推到最后一次提醒之后 1ms,结论等价于 ttl 归零。
  const immediate = ttl !== undefined && ttl <= 0;
  const decision = shouldRemindPending(report, {
    lastRemindedAt: last,
    now: immediate ? (last ?? nowMs) + 1 : nowMs,
    ...(immediate ? { ttlMs: 1 } : ttl !== undefined ? { ttlMs: ttl } : {}),
  });
  const out: { remind: boolean; reason: string; dueAt?: number } = {
    remind: decision.remind === true,
    reason: String(decision.reason),
  };
  if (typeof decision.dueAt === "number") out.dueAt = decision.dueAt;
  return out;
}
