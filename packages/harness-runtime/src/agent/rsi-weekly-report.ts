/**
 * RSI 周报(纯逻辑零 IO,RSI 复盘 2026-11)。
 *
 * 为什么需要它:自我改进循环(RSI)一周里会改一堆东西(采纳/拒绝/迭代/回滚/待定)、花与省一堆 token,
 * 还会积累「等人拍板」的事项(待批、冲突、断路器停摆、负净值)。这些信息散在实验账本、成本台账、
 * 断路器、注入/修改审批、证据图里,每周要人从五个地方拼一次,拼法还每次不一样。
 * 本模块把拼法固化成三段「周报」:
 * - 本周改了什么(changed 按 decision 分组,组内按 decidedAt 降序,每条指标带 settled/deltaPct/improved)
 * - 净省了多少(savings 净值 + 按机制/项目分摊)
 * - 需要你决定什么(needsDecision 固定顺序:pending-approval → conflict → breaker-paused → negative-roi)
 *
 * 三个纯函数:
 * - buildWeeklyReport:输入侧宽进(缺字段/类型不对 → 默认值 + warnings 码,永不 throw),输出侧结构稳定
 *   (byDecision 五键常在、changed 五组常在、warnings 去重且有序)。
 * - renderWeeklyReportText:把报告渲染成人读文本。healthy 两行;非 healthy 三段(标题逐字固定)。
 *   attentionOnly 时按注意力预算压制:第一段只剩一行说明,第二段只剩净值。
 * - planCorrection / shouldRemindPending:周报的两个动作出口——纠错计划(rewrite/disable/rollback)
 *   与「待批提醒是否该发」的 TTL 判断。
 *
 * 依赖纪律:零 import(不读文件/环境/网络/时钟),所有函数不 throw。
 * 时间字段(decidedAt / since / now / lastRemindedAt)既收毫秒数也收 ISO 字符串,非法值一律当缺失。
 * 百分比与 ROI 统一 round2;round2 后的 -0 归一成 0(避免 Object.is(-0, 0) 之类的坑)。
 */

/** 周报 schema 版本:字段语义变化时递增。 */
export const RSI_WEEKLY_VERSION = 1;

/** 待批提醒缺省 TTL:24 小时(不重复打扰同一批待决事项)。 */
export const WEEKLY_ATTENTION_DEFAULT_TTL_MS = 86400000;

/** 实验结论:采纳 / 拒绝 / 继续迭代 / 回滚 / 未决。 */
export type DecisionKind = "adopt" | "reject" | "iterate" | "rollback" | "pending";

/** 指标方向偏好:越大越好(increase)/ 越小越好(decrease)。 */
export type MetricDirection = "increase" | "decrease";

/** 单个指标的基线/结果快照。 */
export interface MetricSummary {
  name: string;
  direction: "increase" | "decrease";
  baseline: number;
  result?: number;
  threshold?: number;
  significant?: boolean;
  unit?: string;
}

/** 一条实验(周报的「改了什么」主体)。 */
export interface ExperimentSummary {
  id: string;
  claim: string;
  surface: string;
  ref: string;
  variant: string;
  decision: DecisionKind;
  decidedAt?: number | string;
  metrics?: MetricSummary[];
  evidenceRefs?: string[];
  rollbackPoint?: string;
}

/** 成本/节省汇总(netTokens 允许为负;roi = saving / cost)。 */
export interface CostSummary {
  costTokens: number;
  savingTokens: number;
  netTokens: number;
  roi: number | null;
  byMechanism?: Record<string, number>;
  byProject?: Record<string, number>;
}

/** 断路器快照(paused=true 时周报要人处理)。 */
export interface BreakerSummary {
  paused: boolean;
  scope?: string;
  trigger?: string;
  reason?: string;
  pausedAt?: string;
}

/** 待人工批准的条目(自我修改 / 注入 / 实验)。 */
export interface PendingApproval {
  kind: "self-modification" | "injection" | "experiment";
  id: string;
  summary: string;
  since?: number | string;
}

/** 证据图冲突(同一关联键下多份互相矛盾的说法)。 */
export interface ConflictSummary {
  associationKey: string;
  kind: string;
  statements: string[];
  latestId?: string;
  authoritativeId?: string;
}

/** buildWeeklyReport 的输入(全部可缺,缺失给默认值 + warning)。 */
export interface WeeklyInput {
  experiments?: ExperimentSummary[];
  cost?: CostSummary;
  breaker?: BreakerSummary;
  pendingApprovals?: PendingApproval[];
  conflicts?: ConflictSummary[];
}

/** 报告里的单条指标(结算后)。 */
export interface ChangedMetric {
  name: string;
  direction: "increase" | "decrease";
  baseline: number;
  result?: number;
  deltaPct: number | null;
  directionNote: string;
  settled: boolean;
  improved?: boolean;
}

/** 报告里的一条改动(decidedAt 归一成字符串;无效则缺省)。 */
export interface ChangedItem {
  id: string;
  claim: string;
  surface: string;
  ref: string;
  variant: string;
  decision: DecisionKind;
  decidedAt?: string;
  metrics: ChangedMetric[];
  evidenceRefs: string[];
  rollbackPoint?: string;
}

/** 「需要你决定什么」的一条(四类,顺序固定)。 */
export interface DecisionItem {
  kind: "pending-approval" | "conflict" | "breaker-paused" | "negative-roi";
  ref: string;
  summary: string;
  actionHint: string;
}

/** 周报正文。 */
export interface WeeklyReport {
  version: number;
  window: { from: string; to: string };
  generatedAt: string;
  changed: {
    adopted: ChangedItem[];
    rejected: ChangedItem[];
    iterated: ChangedItem[];
    rolledBack: ChangedItem[];
    pending: ChangedItem[];
  };
  savings: CostSummary;
  needsDecision: DecisionItem[];
  healthy: boolean;
  attentionCount: number;
  counts: {
    byDecision: Record<DecisionKind, number>;
    metricsSettled: number;
    metricsUnsettled: number;
    pendingApprovals: number;
    conflicts: number;
  };
  suppressedSections?: string[];
  attentionOnly: boolean;
  warnings: string[];
}

/** buildWeeklyReport 的选项(window 必填;now 收毫秒或 ISO;attentionOnly 压账本细节)。 */
export interface WeeklyReportOptions {
  window: { from: string; to: string };
  now?: number | string;
  attentionOnly?: boolean;
}

/** 纠错动作:改说法 / 停用说法 / 回滚实验。 */
export type CorrectionKind = "rewrite" | "disable" | "rollback";

/** planCorrection 的输入。 */
export interface CorrectionInput {
  kind: CorrectionKind;
  target: string;
  by: string;
  reason: string;
  newStatement?: string;
}

/** 纠错计划:三路动作最多命中一路(可选)。 */
export interface CorrectionPlan {
  ok: boolean;
  graphCorrection?: {
    id: string;
    statement?: string;
    by: string;
    reason: string;
    disable?: boolean;
  };
  breakerAction?: { scope: string; reason: string };
  experimentAction?: { id: string; kind: "rollback" };
  codes: string[];
}

/** 提醒判断结果(四分支;dueAt = last + ttl,仅在拿到 last 时给)。 */
export interface RemindDecision {
  remind: boolean;
  reason: "no-pending" | "ttl-suppressed" | "due" | "never-reminded";
  dueAt?: number;
}

/** shouldRemindPending 的选项。 */
export interface RemindOptions {
  lastRemindedAt?: number | string | null;
  now?: number | string;
  ttlMs?: number;
}

/** 全部合法结论(固定顺序;byDecision 以此为键序)。 */
export const DECISION_KINDS = ["adopt", "reject", "iterate", "rollback", "pending"] as const;

/** 全部合法待批类别。 */
export const PENDING_APPROVAL_KINDS = ["self-modification", "injection", "experiment"] as const;

/** 全部 warning 码前缀(便于自动化按码断言;完整码带 :id 后缀)。 */
export const WEEKLY_WARNING_CODES = [
  "missing-experiments",
  "missing-cost",
  "missing-breaker",
  "missing-pending",
  "missing-conflicts",
  "missing-metrics",
  "missing-result",
  "metric-baseline-zero",
  "invalid-window",
] as const;

/** 待决事项 actionHint(逐字固定,前端可直接渲染)。 */
export const ACTION_HINT_APPROVAL = "批准 / 拒绝(写回实验/修改/注入账本)";
export const ACTION_HINT_CONFLICT = "指定权威版(correctEvidence 写入 authoritativeId)";
export const ACTION_HINT_BREAKER = "人工恢复或回滚相关改动";
export const ACTION_HINT_NEGATIVE_ROI = "降频 / 停摆或回滚高成本机制";

/** 冲突说法合并后的最大字数。 */
const CONFLICT_SUMMARY_MAX = 120;

/** 改动分组名 → DecisionKind 的固定顺序(渲染与计数共用)。 */
const GROUP_ORDER: ReadonlyArray<readonly [DecisionKind, keyof WeeklyReport["changed"]]> = [
  ["adopt", "adopted"],
  ["reject", "rejected"],
  ["iterate", "iterated"],
  ["rollback", "rolledBack"],
  ["pending", "pending"],
];

// ---------------------------------------------------------------------------
// 内部工具(全部纯函数,不 throw)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** 有限数才收,否则 undefined(注意 NaN/Infinity 一律当缺失)。 */
function toNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 非空字符串才收。 */
function toStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** round2:两位小数;非有限数 → 0;-0 归一成 0。 */
function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/**
 * 时间解析:毫秒数(有限)直接用,字符串走 Date.parse。
 * 非法/缺失一律 undefined —— 调用方按「缺失」处理,绝不 throw。
 */
function toMs(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** 毫秒数 → ISO 字符串(非法 → undefined)。 */
function msToIso(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/** 去重且保序(首个出现位置决定次序)。 */
function pushWarning(warnings: string[], code: string): void {
  if (!warnings.includes(code)) warnings.push(code);
}

/** 时间字段归一成字符串:数字 → ISO,可解析字符串原样回显,其余 undefined。 */
function normalizeTimeText(value: unknown): string | undefined {
  if (typeof value === "string") return toMs(value) === undefined ? undefined : value;
  const ms = toMs(value);
  return msToIso(ms);
}

function normalizeDecision(value: unknown): DecisionKind {
  return typeof value === "string" && (DECISION_KINDS as readonly string[]).includes(value)
    ? (value as DecisionKind)
    : "pending";
}

function normalizeDirection(value: unknown): MetricDirection {
  return value === "decrease" ? "decrease" : "increase";
}

function normalizeApprovalKind(value: unknown): PendingApproval["kind"] {
  return value === "self-modification" || value === "injection" ? value : "experiment";
}

function directionWord(direction: MetricDirection): string {
  return direction === "increase" ? "上升" : "下降";
}

function formatPct(value: number): string {
  return String(round2(Math.abs(value)));
}

/** 指标的方向说明:未结算 / 基线为 0 / 持平 / 上升 x% / 下降 x%。 */
function buildDirectionNote(
  direction: MetricDirection,
  deltaPct: number | null,
  settled: boolean,
): string {
  if (!settled) return "未结算";
  const word = directionWord(direction);
  const suffix = `(方向偏好${word})`;
  if (deltaPct === null) return `${direction}: 基线为 0,涨跌不可比${suffix}`;
  if (deltaPct === 0) return `${direction}: 持平${suffix}`;
  if (deltaPct > 0) return `${direction}: 上升 ${formatPct(deltaPct)}%${suffix}`;
  return `${direction}: 下降 ${formatPct(deltaPct)}%${suffix}`;
}

interface MetricsResult {
  metrics: ChangedMetric[];
  settled: number;
  unsettled: number;
}

/** 单条实验的指标归一 + 计数 + warning。 */
function normalizeMetrics(expId: string, raw: unknown, warnings: string[]): MetricsResult {
  const out: ChangedMetric[] = [];
  let settled = 0;
  let unsettled = 0;
  // metrics 缺失或类型不对 → 空数组 + 码(missing-metrics:<id>)
  if (!Array.isArray(raw)) {
    pushWarning(warnings, `missing-metrics:${expId}`);
    return { metrics: out, settled, unsettled };
  }
  for (const entry of raw) {
    const metric = asRecord(entry);
    const name = toStr(metric.name) ?? "(unnamed)";
    const direction = normalizeDirection(metric.direction);
    const baseline = toNum(metric.baseline) ?? 0;
    const result = toNum(metric.result);
    if (result === undefined) {
      unsettled += 1;
      pushWarning(warnings, `missing-result:${expId}:${name}`);
      out.push({
        name,
        direction,
        baseline,
        deltaPct: null,
        directionNote: "未结算",
        settled: false,
      });
      continue;
    }
    settled += 1;
    if (baseline === 0) {
      pushWarning(warnings, `metric-baseline-zero:${expId}:${name}`);
      out.push({
        name,
        direction,
        baseline,
        result,
        deltaPct: null,
        directionNote: buildDirectionNote(direction, null, true),
        settled: true,
      });
      continue;
    }
    const deltaPct = round2(((result - baseline) / Math.abs(baseline)) * 100);
    out.push({
      name,
      direction,
      baseline,
      result,
      deltaPct,
      directionNote: buildDirectionNote(direction, deltaPct, true),
      settled: true,
      improved: direction === "increase" ? deltaPct > 0 : deltaPct < 0,
    });
  }
  return { metrics: out, settled, unsettled };
}

interface NormalizedChanged {
  item: ChangedItem;
  /** decidedAt 的毫秒值(排序用);缺失 → undefined(排尾)。 */
  ms?: number;
  settled: number;
  unsettled: number;
}

/** 单条实验归一(非法条目返回 undefined,静默跳过)。 */
function normalizeExperiment(raw: unknown, warnings: string[]): NormalizedChanged | undefined {
  if (!isRecord(raw)) return undefined;
  const id = toStr(raw.id);
  if (id === undefined) return undefined;
  const decision = normalizeDecision(raw.decision);
  const decidedAtText = normalizeTimeText(raw.decidedAt);
  const evidenceRefs: string[] = [];
  if (Array.isArray(raw.evidenceRefs)) {
    for (const ref of raw.evidenceRefs) {
      const text = toStr(ref);
      if (text !== undefined) evidenceRefs.push(text);
    }
  }
  const { metrics, settled, unsettled } = normalizeMetrics(
    id,
    raw.metrics === undefined ? undefined : raw.metrics,
    warnings,
  );
  return {
    item: {
      id,
      claim: toStr(raw.claim) ?? "",
      surface: toStr(raw.surface) ?? "",
      ref: toStr(raw.ref) ?? "",
      variant: toStr(raw.variant) ?? "",
      decision,
      decidedAt: decidedAtText,
      metrics,
      evidenceRefs,
      rollbackPoint: toStr(raw.rollbackPoint),
    },
    ms: decidedAtText === undefined ? undefined : toMs(decidedAtText),
    settled,
    unsettled,
  };
}

/** 组内排序:decidedAt 降序(缺 decidedAt 排尾),稳定(按原输入位置兜底)。 */
function sortGroup(entries: ReadonlyArray<{ item: ChangedItem; ms?: number; index: number }>): ChangedItem[] {
  return [...entries]
    .sort((a, b) => {
      if (a.ms !== undefined && b.ms !== undefined) {
        if (b.ms !== a.ms) return b.ms - a.ms;
      } else if (a.ms !== undefined) {
        return -1;
      } else if (b.ms !== undefined) {
        return 1;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

/** 成本归一:缺字段 → 0;netTokens 可由 saving-cost 推出;roi = saving / cost。 */
function normalizeCost(raw: unknown, warnings: string[]): CostSummary {
  if (!isRecord(raw)) {
    pushWarning(warnings, "missing-cost");
    return { costTokens: 0, savingTokens: 0, netTokens: 0, roi: null };
  }
  const costTokens = toNum(raw.costTokens) ?? 0;
  const savingTokens = toNum(raw.savingTokens) ?? 0;
  const netTokens = toNum(raw.netTokens) ?? savingTokens - costTokens;
  const givenRoi = toNum(raw.roi);
  const roi = givenRoi !== undefined ? round2(givenRoi) : costTokens > 0 ? round2(savingTokens / costTokens) : null;
  const summary: CostSummary = { costTokens, savingTokens, netTokens, roi };
  const byMechanism = normalizeBags(raw.byMechanism);
  if (byMechanism !== undefined) summary.byMechanism = byMechanism;
  const byProject = normalizeBags(raw.byProject);
  if (byProject !== undefined) summary.byProject = byProject;
  return summary;
}

/** Record<string, number> 归一(只留有限数,值 round2;非对象 → undefined)。 */
function normalizeBags(raw: unknown): Record<string, number> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const num = toNum(value);
    if (num !== undefined) out[key] = round2(num);
  }
  return out;
}

/** 断路器归一(paused 只认 boolean true;其余字段原样保留字符串)。 */
function normalizeBreaker(raw: unknown, warnings: string[]): BreakerSummary {
  if (!isRecord(raw)) {
    pushWarning(warnings, "missing-breaker");
    return { paused: false };
  }
  const breaker: BreakerSummary = { paused: raw.paused === true };
  const scope = toStr(raw.scope);
  if (scope !== undefined) breaker.scope = scope;
  const trigger = toStr(raw.trigger);
  if (trigger !== undefined) breaker.trigger = trigger;
  const reason = toStr(raw.reason);
  if (reason !== undefined) breaker.reason = reason;
  const pausedAt = normalizeTimeText(raw.pausedAt);
  if (pausedAt !== undefined) breaker.pausedAt = pausedAt;
  return breaker;
}

/** 待批归一(非法条目跳过)。 */
function normalizePending(raw: unknown, warnings: string[]): PendingApproval[] {
  if (!Array.isArray(raw)) {
    pushWarning(warnings, "missing-pending");
    return [];
  }
  const out: PendingApproval[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = toStr(entry.id);
    if (id === undefined) continue;
    const item: PendingApproval = {
      kind: normalizeApprovalKind(entry.kind),
      id,
      summary: toStr(entry.summary) ?? "",
    };
    const sinceText = normalizeTimeText(entry.since);
    if (sinceText !== undefined) item.since = sinceText;
    out.push(item);
  }
  return out;
}

/** 冲突归一(非法条目跳过;statements 只留非空字符串)。 */
function normalizeConflicts(raw: unknown, warnings: string[]): ConflictSummary[] {
  if (!Array.isArray(raw)) {
    pushWarning(warnings, "missing-conflicts");
    return [];
  }
  const out: ConflictSummary[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const associationKey = toStr(entry.associationKey);
    if (associationKey === undefined) continue;
    const statements: string[] = [];
    if (Array.isArray(entry.statements)) {
      for (const statement of entry.statements) {
        const text = toStr(statement);
        if (text !== undefined) statements.push(text);
      }
    }
    const conflict: ConflictSummary = {
      associationKey,
      kind: toStr(entry.kind) ?? "conflict",
      statements,
    };
    const latestId = toStr(entry.latestId);
    if (latestId !== undefined) conflict.latestId = latestId;
    const authoritativeId = toStr(entry.authoritativeId);
    if (authoritativeId !== undefined) conflict.authoritativeId = authoritativeId;
    out.push(conflict);
  }
  return out;
}

/** 截断到 max 字(截断时末位补 …)。 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}

/** 冲突摘要:kind + 各说法(" | " 连接,总长 ≤ 120 字)。 */
function conflictSummaryText(conflict: ConflictSummary): string {
  const body = conflict.statements.join(" | ");
  const head = conflict.kind.length > 0 ? `${conflict.kind}: ` : "";
  return truncate(`${head}${body}`, CONFLICT_SUMMARY_MAX);
}

/** 断路器摘要:必须含 trigger / reason(缺失写「未给出」)。 */
function breakerSummaryText(breaker: BreakerSummary): string {
  const scope = breaker.scope ?? "all";
  const trigger = breaker.trigger ?? "未给出";
  const reason = breaker.reason ?? "未给出";
  const pausedAt = breaker.pausedAt ?? "未给出";
  return `断路器暂停(scope=${scope}),trigger=${trigger},reason=${reason},pausedAt=${pausedAt}`;
}

/** 待批摘要:必须含 kind 与 since。 */
function approvalSummaryText(approval: PendingApproval): string {
  const since = approval.since === undefined ? "未知时间" : String(approval.since);
  return `待批 ${approval.kind}:${approval.summary}(since ${since})`;
}

/** 净值摘要:必须含 netTokens 与 roi。 */
function negativeRoiSummaryText(cost: CostSummary): string {
  const roi = cost.roi === null ? "n/a" : String(cost.roi);
  return `净值为负:netTokens=${cost.netTokens},roi=${roi},costTokens=${cost.costTokens},savingTokens=${cost.savingTokens}`;
}

/**
 * 构造周报。输入宽进(缺字段/类型不对 → 默认值 + warnings),输出结构稳定,永不 throw。
 *
 * 细节:
 * - changed 按 decision 分五组,组内按 decidedAt 降序(缺 decidedAt 排尾,稳定排序)。
 * - 指标:result 缺失 → settled=false / deltaPct=null / directionNote="未结算";
 *   baseline===0 → deltaPct=null 并推 metric-baseline-zero 码;其余 round2((result-baseline)/|baseline|*100)。
 * - needsDecision 顺序固定:pending-approval → conflict → breaker-paused → negative-roi。
 * - attentionOnly=true:changed 全空、suppressedSections=["changed","savings-breakdown"],
 *   savings 保留数字但去掉 byMechanism/byProject,needsDecision 原样保留。
 */
export function buildWeeklyReport(input: WeeklyInput, opts: WeeklyReportOptions): WeeklyReport {
  // warning 分三段收集,最后按「容器级 → 指标级 → 窗口」固定顺序合并且去重:
  // 这样码序始终可预期(missing-experiments|missing-cost|... → missing-metrics|missing-result|... → invalid-window)。
  const warnings: string[] = [];
  const metricWarnings: string[] = [];
  const rec = asRecord(input);
  const optRec = asRecord(opts);

  // --- window / now -------------------------------------------------------
  const rawWindow = asRecord(optRec.window);
  const fromText = toStr(rawWindow.from);
  const toText = toStr(rawWindow.to);
  const windowValid =
    fromText !== undefined && toText !== undefined && toMs(fromText) !== undefined && toMs(toText) !== undefined;
  const window = { from: fromText ?? "", to: toText ?? "" };
  const nowMs = optRec.now === undefined ? Date.now() : (toMs(optRec.now) ?? Date.now());
  const generatedAt = msToIso(nowMs) ?? new Date(0).toISOString();
  const attentionOnly = optRec.attentionOnly === true;

  // --- experiments -------------------------------------------------------
  const rawExperiments = rec.experiments;
  if (!Array.isArray(rawExperiments)) pushWarning(warnings, "missing-experiments");
  const normalized: NormalizedChanged[] = [];
  if (Array.isArray(rawExperiments)) {
    for (const raw of rawExperiments) {
      const entry = normalizeExperiment(raw, metricWarnings);
      if (entry !== undefined) normalized.push(entry);
    }
  }

  const buckets: Record<keyof WeeklyReport["changed"], Array<{ item: ChangedItem; ms?: number; index: number }>> = {
    adopted: [],
    rejected: [],
    iterated: [],
    rolledBack: [],
    pending: [],
  };
  const groupOf: Record<DecisionKind, keyof WeeklyReport["changed"]> = {
    adopt: "adopted",
    reject: "rejected",
    iterate: "iterated",
    rollback: "rolledBack",
    pending: "pending",
  };
  const byDecision: Record<DecisionKind, number> = { adopt: 0, reject: 0, iterate: 0, rollback: 0, pending: 0 };
  let metricsSettled = 0;
  let metricsUnsettled = 0;
  normalized.forEach((entry, index) => {
    byDecision[entry.item.decision] += 1;
    metricsSettled += entry.settled;
    metricsUnsettled += entry.unsettled;
    buckets[groupOf[entry.item.decision]].push({ item: entry.item, ms: entry.ms, index });
  });

  // --- cost / breaker / approvals / conflicts ----------------------------
  const savings = normalizeCost(rec.cost, warnings);
  const breaker = normalizeBreaker(rec.breaker, warnings);
  const pendingApprovals = normalizePending(rec.pendingApprovals, warnings);
  const conflicts = normalizeConflicts(rec.conflicts, warnings);

  // --- needsDecision(四类,顺序固定) ------------------------------------
  const needsDecision: DecisionItem[] = [];
  for (const approval of pendingApprovals) {
    needsDecision.push({
      kind: "pending-approval",
      ref: approval.id,
      summary: approvalSummaryText(approval),
      actionHint: ACTION_HINT_APPROVAL,
    });
  }
  for (const conflict of conflicts) {
    needsDecision.push({
      kind: "conflict",
      ref: conflict.associationKey,
      summary: conflictSummaryText(conflict),
      actionHint: ACTION_HINT_CONFLICT,
    });
  }
  if (breaker.paused) {
    needsDecision.push({
      kind: "breaker-paused",
      ref: breaker.scope ?? "all",
      summary: breakerSummaryText(breaker),
      actionHint: ACTION_HINT_BREAKER,
    });
  }
  if (savings.netTokens < 0) {
    needsDecision.push({
      kind: "negative-roi",
      ref: "cost",
      summary: negativeRoiSummaryText(savings),
      actionHint: ACTION_HINT_NEGATIVE_ROI,
    });
  }

  const attentionCount = needsDecision.length;
  const healthy = attentionCount === 0;

  // --- 组装 changed(attentionOnly 时全空) -------------------------------
  const changed: WeeklyReport["changed"] = attentionOnly
    ? { adopted: [], rejected: [], iterated: [], rolledBack: [], pending: [] }
    : {
        adopted: sortGroup(buckets.adopted),
        rejected: sortGroup(buckets.rejected),
        iterated: sortGroup(buckets.iterated),
        rolledBack: sortGroup(buckets.rolledBack),
        pending: sortGroup(buckets.pending),
      };

  // --- savings:attentionOnly 只留数字 ----------------------------------
  const savingsOut: CostSummary = attentionOnly
    ? {
        costTokens: savings.costTokens,
        savingTokens: savings.savingTokens,
        netTokens: savings.netTokens,
        roi: savings.roi,
      }
    : savings;

  // --- warnings:容器级 → 指标级 → invalid-window(去重保序) --------------
  const mergedWarnings: string[] = [];
  for (const code of warnings) pushWarning(mergedWarnings, code);
  for (const code of metricWarnings) pushWarning(mergedWarnings, code);
  if (!windowValid) pushWarning(mergedWarnings, "invalid-window");

  const report: WeeklyReport = {
    version: RSI_WEEKLY_VERSION,
    window,
    generatedAt,
    changed,
    savings: savingsOut,
    needsDecision,
    healthy,
    attentionCount,
    counts: {
      byDecision,
      metricsSettled,
      metricsUnsettled,
      pendingApprovals: pendingApprovals.length,
      conflicts: conflicts.length,
    },
    attentionOnly,
    warnings: mergedWarnings,
  };
  if (attentionOnly) report.suppressedSections = ["changed", "savings-breakdown"];
  return report;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function roiText(roi: number | null | undefined): string {
  return typeof roi === "number" && Number.isFinite(roi) ? String(round2(roi)) : "n/a";
}

/** healthy / attentionOnly 第二段共用的净值行。 */
function netLine(savings: CostSummary): string {
  return `净省 ${round2(savings.netTokens)} tokens(ROI ${roiText(savings.roi)})`;
}

function metricLine(item: ChangedItem, metric: ChangedMetric): string {
  const result = metric.settled && metric.result !== undefined ? String(round2(metric.result)) : "未结算";
  const delta = metric.deltaPct === null ? "n/a" : String(round2(metric.deltaPct));
  return `${item.id} · ${item.claim} · ${metric.name} ${round2(metric.baseline)}→${result}(${delta}%)`;
}

/** 一条改动渲染成 1..n 行(每指标一行;无指标则一行)。 */
function changedItemLines(item: ChangedItem): string[] {
  const head = `${item.id} · ${item.claim}`;
  const metrics = Array.isArray(item.metrics) ? item.metrics : [];
  if (metrics.length === 0) return [head];
  return metrics.map((metric) => metricLine(item, metric));
}

/** 第二段(非 attentionOnly):净值 + 分摊前 3。 */
function savingsLine(savings: CostSummary): string {
  const parts = [
    `net=${round2(savings.netTokens)} tokens`,
    `saving=${round2(savings.savingTokens)}`,
    `cost=${round2(savings.costTokens)}`,
    `ROI=${roiText(savings.roi)}`,
  ];
  const bags = savings.byMechanism;
  if (bags !== undefined) {
    const top = Object.entries(bags)
      .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, 3);
    if (top.length > 0) parts.push(`byMechanism: ${top.map(([key, value]) => `${key}=${round2(value)}`).join(", ")}`);
  }
  return parts.join(" | ");
}

/**
 * 渲染周报文本。
 * healthy:两行(无事项 + 净值)。
 * 非 healthy:三段,标题逐字 "## 本周改了什么" / "## 净省了多少" / "## 需要你决定什么"。
 * attentionOnly:第一段只一行 "(已按注意力预算压制)",第二段只一行净值。
 */
export function renderWeeklyReportText(report: WeeklyReport): string {
  const rec = asRecord(report);
  const savings = asRecord(rec.savings) as unknown as CostSummary;
  const decisionsRaw = Array.isArray(rec.needsDecision) ? rec.needsDecision : [];
  const decisions: DecisionItem[] = decisionsRaw.filter(isRecord).map((entry) => ({
    kind: (entry as unknown as DecisionItem).kind,
    ref: String((entry as unknown as DecisionItem).ref ?? ""),
    summary: String((entry as unknown as DecisionItem).summary ?? ""),
    actionHint: String((entry as unknown as DecisionItem).actionHint ?? ""),
  }));
  const changedRec = asRecord(rec.changed);
  const attentionOnly = rec.attentionOnly === true;

  if (decisions.length === 0) {
    return ["本周无需要你处理的事项", netLine(savings)].join("\n");
  }

  const lines: string[] = [];
  lines.push("## 本周改了什么");
  if (attentionOnly) {
    lines.push("(已按注意力预算压制)");
  } else {
    for (const [kind, bucket] of GROUP_ORDER) {
      const listRaw = changedRec[bucket];
      const list: ChangedItem[] = Array.isArray(listRaw) ? (listRaw as ChangedItem[]) : [];
      lines.push(`${kind}: ${list.length} 条`);
      for (const item of list.slice(0, 5)) {
        if (!isRecord(item)) continue;
        lines.push(...changedItemLines(item as unknown as ChangedItem));
      }
    }
  }

  lines.push("## 净省了多少");
  lines.push(attentionOnly ? netLine(savings) : savingsLine(savings));

  lines.push("## 需要你决定什么");
  for (const decision of decisions) {
    lines.push(`- [${decision.kind}] ${decision.ref} — ${decision.summary} → ${decision.actionHint}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 纠错计划
// ---------------------------------------------------------------------------

/**
 * 把一次人工纠错请求翻译成可执行动作(只做规划,不落地):
 * - rewrite  → graphCorrection{statement}(缺 newStatement → missing-new-statement)
 * - disable  → graphCorrection{disable:true}
 * - rollback → "ev-" 前缀 → graphCorrection;否则 experimentAction{kind:"rollback"};空 target → missing-target
 * 非法 kind → invalid-kind;by/reason 空 → missing-by / missing-reason。码按上述固定顺序累积,不 throw。
 */
export function planCorrection(input: CorrectionInput): CorrectionPlan {
  const codes: string[] = [];
  if (!isRecord(input)) return { ok: false, codes: ["invalid-input"] };
  const rec = input as unknown as Record<string, unknown>;
  const kind = rec.kind;
  const target = toStr(rec.target) ?? "";
  const by = toStr(rec.by) ?? "";
  const reason = toStr(rec.reason) ?? "";
  const newStatement = typeof rec.newStatement === "string" ? rec.newStatement : undefined;

  if (kind !== "rewrite" && kind !== "disable" && kind !== "rollback") {
    return { ok: false, codes: ["invalid-kind"] };
  }
  if (kind === "rollback" && target.length === 0) codes.push("missing-target");
  if (kind === "rewrite" && (newStatement === undefined || newStatement.length === 0)) {
    codes.push("missing-new-statement");
  }
  if (by.length === 0) codes.push("missing-by");
  if (reason.length === 0) codes.push("missing-reason");
  if (codes.length > 0) return { ok: false, codes };

  if (kind === "rewrite") {
    return {
      ok: true,
      graphCorrection: { id: target, statement: newStatement, by, reason },
      codes: [],
    };
  }
  if (kind === "disable") {
    return { ok: true, graphCorrection: { id: target, by, reason, disable: true }, codes: [] };
  }
  if (target.startsWith("ev-")) {
    return { ok: true, graphCorrection: { id: target, by, reason }, codes: [] };
  }
  return { ok: true, experimentAction: { id: target, kind: "rollback" }, codes: [] };
}

// ---------------------------------------------------------------------------
// 待批提醒
// ---------------------------------------------------------------------------

/**
 * 待批提醒是否该发:
 * - 待批数(changed.pending + needsDecision 里的 pending-approval)为 0 → no-pending
 * - lastRemindedAt 缺失/null → never-reminded(立刻提醒,dueAt 不给)
 * - now - last >= ttl(缺省 24h)→ due;否则 ttl-suppressed;两种情况都给 dueAt = last + ttl
 * 非法 now / lastRemindedAt / ttlMs 走缺省值,不 throw。
 */
export function shouldRemindPending(report: WeeklyReport, opts: RemindOptions): RemindDecision {
  const rec = asRecord(report);
  const optRec = asRecord(opts);
  const changedRec = asRecord(rec.changed);
  const pendingList = Array.isArray(changedRec.pending) ? changedRec.pending.length : 0;
  const decisions = Array.isArray(rec.needsDecision) ? rec.needsDecision : [];
  let awaiting = pendingList;
  for (const decision of decisions) {
    if (isRecord(decision) && decision.kind === "pending-approval") awaiting += 1;
  }
  if (awaiting === 0) return { remind: false, reason: "no-pending" };

  const nowMs = toMs(optRec.now) ?? Date.now();
  const ttlCandidate = toNum(optRec.ttlMs);
  const ttl = ttlCandidate !== undefined && ttlCandidate > 0 ? ttlCandidate : WEEKLY_ATTENTION_DEFAULT_TTL_MS;

  const lastRaw = optRec.lastRemindedAt;
  const lastMs = lastRaw === undefined || lastRaw === null ? undefined : toMs(lastRaw);
  if (lastMs === undefined) return { remind: true, reason: "never-reminded" };

  const dueAt = lastMs + ttl;
  if (nowMs - lastMs >= ttl) return { remind: true, reason: "due", dueAt };
  return { remind: false, reason: "ttl-suppressed", dueAt };
}
