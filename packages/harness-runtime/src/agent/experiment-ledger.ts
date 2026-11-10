/**
 * 实验台账(Experiment Ledger):把「假设 → 干预 → 灰度 → 指标 → 决策」写成可审计记录。
 * 为什么需要台账而不是口头结论:一个 tip/prompt/工具面改动(A/B 变体)做完后,最常见的坏状态
 * 是「看起来变好了」——样本不够、只有均值没有方差、方向对了但幅度小到噪声里、或者两个实验
 * 同时改了同一处互相污染。本模块把这些判定做成纯函数:
 * - experimentIdOf:同一假设+干预+分层必须得到同一个 id(claim 规范化 + 稳定键序 JSON),
 *   否则台账里同一条实验会被记成多条,重复采纳无法识别。
 * - evaluateAdoptGate:一组稳定码(样本量/显著性/效应/方向/警戒线/冲突)把「能采纳」变成
 *   可复算的判定,而不是评审口味。
 * - decideExperiment:决策产出新版本(深拷贝),入参实验不回写;adopt 必须先过闸。
 * - planCanary:灰度批次按 sha256(expId:key) 升序取前 N,确定性可复现、无随机。
 * - filterByStratum:按项目/任务类/模型/时间窗取实验,缺省字段即通配。
 * 纯逻辑:零 IO,不读文件/网络/环境。只用 node:crypto 的 sha256(稳定 id 与批次排序)。
 */
import { createHash } from "node:crypto";

/** 台账 schema 版本:字段语义变化时递增,读取方据此迁移。 */
export const EXPERIMENT_SCHEMA_VERSION = 1;

/** 实验分层:只在这一层内比较指标,避免跨项目/跨任务类混样本。 */
export interface ExperimentStratum {
  window?: { from: string; to: string };
  projectId?: string;
  taskClass?: string;
  model?: string;
}

/** 单侧样本统计量(均值/样本数/标准差)。标准差缺省时只能走比例口径或判证据不足。 */
export interface SampleStat {
  value: number;
  sample: number;
  stddev?: number;
}

/** 一条验收指标及其阈值。direction 是「变大好还是变小好」,不写就无从判方向。 */
export interface ExperimentMetric {
  name: string;
  unit?: string;
  kind?: "rate" | "mean";
  /** 角色:success(缺省,采纳指标)或 guardrail(只受「不超阈回退」约束,不要求改善/显著)。 */
  role?: "success" | "guardrail";
  direction: "decrease" | "increase";
  baseline: SampleStat;
  result?: SampleStat;
  thresholds: { minSample: number; minEffectPct: number; minZ?: number };
}

/** 假设:claim 是结论,mechanism 是为什么成立,expectedEffect 是预期的量级。 */
export interface ExperimentHypothesis {
  claim: string;
  mechanism?: string;
  expectedEffect: string;
}

/** 干预:改了哪个面(surface)、改的哪个对象(ref)、哪个变体(variant)。 */
export interface ExperimentIntervention {
  surface: "tool" | "tip" | "prompt" | "code" | "config";
  ref: string;
  variant: string;
}

/** 警戒线:某指标相对基线最多允许多少回退(%),超过即不可采纳。 */
export interface ExperimentGuardrail {
  metric: string;
  maxRegressionPct: number;
}

/** 灰度:按 session/project/百分比投放,status=done 才算跑完(评测闸只认跑完的)。 */
export interface ExperimentCanary {
  scope: "session" | "project" | "percent";
  percent?: number;
  sessions?: number;
  projects?: number;
  status: "pending" | "running" | "done";
}

/** 回滚点:采纳后出问题的第一跳(commit/flag/config/snapshot)。 */
export interface ExperimentRollbackPoint {
  kind: "commit" | "flag" | "config" | "snapshot";
  ref: string;
}

export type ExperimentDecisionKind = "pending" | "adopt" | "reject" | "iterate" | "rollback";

/** 决策:kind + 时间 + 人 + 理由(reason 对非 adopt 是必填)。 */
export interface ExperimentDecision {
  kind: ExperimentDecisionKind;
  at?: number;
  by?: string;
  reason?: string;
}

/** 一条实验记录(台账行)。 */
export interface Experiment {
  id: string;
  schemaVersion: number;
  hypothesis: ExperimentHypothesis;
  intervention: ExperimentIntervention;
  guardrails: ExperimentGuardrail[];
  canary: ExperimentCanary;
  strata: ExperimentStratum[];
  metrics: ExperimentMetric[];
  traceBatchKeys?: string[];
  rollbackPoint: ExperimentRollbackPoint;
  decision: ExperimentDecision;
  evidence?: string[];
  createdAt: number;
  updatedAt: number;
}

/** 采纳闸的稳定码:顺序固定、去重,便于评审/自动化按码断言。 */
export const EXPERIMENT_GATE_CODES = [
  "EXP_HYPOTHESIS_EMPTY",
  "EXP_INTERVENTION_MISSING",
  "EXP_ROLLBACK_MISSING",
  "EXP_CANARY_INCOMPLETE",
  "EXP_BASELINE_SAMPLE_LOW",
  "EXP_RESULT_SAMPLE_LOW",
  "EXP_NOT_SIGNIFICANT",
  "EXP_EFFECT_BELOW_MIN",
  "EXP_DIRECTION_UNMET",
  "EXP_GUARDRAIL_BREACH",
  "EXP_CONFLICTING_ADOPTED",
] as const;

export type ExperimentGateCode = (typeof EXPERIMENT_GATE_CODES)[number];

/** 缺省显著性阈值(双侧 95%)。 */
const DEFAULT_MIN_Z = 1.96;

/** 比例单位白名单。 */
const RATIO_UNITS = new Set(["ratio", "pct", "%", "percent"]);

/** 名称里出现这些词视为比例口径。 */
const RATIO_NAME = /rate|ratio|pct|ctr/i;

/** claim 规范化:trim → 内部连续空白折叠为单空格 → 英文小写化。 */
export function normalizeClaim(claim: string): string {
  return claim.trim().replace(/\s+/g, " ").toLowerCase();
}

/** 稳定键序 JSON:对象键升序、数组保序、undefined 键省略(等价于 JSON.stringify 的语义)。 */
export function canonicalJSON(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJSON(v)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(",")}}`;
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  return "null";
}

/** sha256 hex。 */
export function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** stratum 的稳定排序键:window.from/window.to/projectId/taskClass/model,缺省为空串。 */
function stratumSortKey(s: ExperimentStratum): string {
  return [s.window?.from ?? "", s.window?.to ?? "", s.projectId ?? "", s.taskClass ?? "", s.model ?? ""].join("\u0000");
}

/** 两个时间窗是否重叠(ISO 字符串比较;任一方缺失视为重叠)。 */
function windowsOverlap(
  a: { from: string; to: string } | undefined,
  b: { from: string; to: string } | undefined): boolean {
  if (!a || !b) return true;
  return a.from <= b.to && b.from <= a.to;
}

/**
 * 实验 id:同一 hypothesis/intervention/strata(与顺序无关)必得同一 id。
 * = "exp-" + sha256(canonicalJSON({claim, surface, ref, strata: 排序后})) hex 前 16。
 */
export function experimentIdOf(exp: Pick<Experiment, "hypothesis" | "intervention" | "strata">): string {
  const strata = exp.strata
    .map((s) => ({
      window: s.window ? { from: s.window.from, to: s.window.to } : undefined,
      projectId: s.projectId,
      taskClass: s.taskClass,
      model: s.model,
      __key: stratumSortKey(s),
    }))
    .sort((a, b) => (a.__key < b.__key ? -1 : a.__key > b.__key ? 1 : 0))
    .map(({ __key, ...rest }) => rest);
  const payload = canonicalJSON({
    claim: normalizeClaim(exp.hypothesis.claim),
    surface: exp.intervention.surface,
    ref: exp.intervention.ref.trim(),
    strata,
  });
  return `exp-${sha256hex(payload).slice(0, 16)}`;
}

/** 该指标是否可按比例(二项)口径算标准误。 */
export function isProportionLike(metric: ExperimentMetric): boolean {
  if (metric.kind === "rate") return true;
  if (metric.unit !== undefined && RATIO_UNITS.has(metric.unit.trim())) return true;
  if (RATIO_NAME.test(metric.name)) return true;
  // 兜底:两侧取值都落在 [0,1] 且样本数为整数,才按比例口径解释。
  const r = metric.result;
  if (!r) return false;
  const inUnit = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;
  return inUnit(metric.baseline.value) && inUnit(r.value);
}

/** 两样本差值的标准误。返回 null 表示「都不可算」。 */
function standardErrorOfDifference(
  metric: ExperimentMetric): { se: number; kind: "stddev" | "binomial" } | null {
  const b = metric.baseline;
  const r = metric.result;
  if (!r) return null;
  const sdB = b.stddev;
  const sdR = r.stddev;
  if (typeof sdB === "number" && typeof sdR === "number" && sdB > 0 && sdR > 0 && b.sample > 0 && r.sample > 0) {
    return { se: Math.sqrt((sdB * sdB) / b.sample + (sdR * sdR) / r.sample), kind: "stddev" };
  }
  if (isProportionLike(metric) && b.sample > 0 && r.sample > 0) {
    const xb = b.value * b.sample;
    const xr = r.value * r.sample;
    const pBar = (xb + xr) / (b.sample + r.sample);
    const se = Math.sqrt(pBar * (1 - pBar) * (1 / b.sample + 1 / r.sample));
    return Number.isFinite(se) ? { se, kind: "binomial" } : null;
  }
  return null;
}

function fmt(v: number): string {
  return Number.isFinite(v) ? String(Math.round(v * 1e4) / 1e4) : String(v);
}

/**
 * 采纳闸:返回 {ok, codes, details}。codes 去重且顺序稳定(details 按同一评估顺序追加)。
 */
export function evaluateAdoptGate(
  exp: Experiment,
  policy?: { minZ?: number; conflicts?: Array<{ id: string }> },
): { ok: boolean; codes: string[]; details: string[] } {
  const codes: string[] = [];
  const details: string[] = [];
  const flag = (code: ExperimentGateCode, detail: string): void => {
    if (!codes.includes(code)) codes.push(code);
    details.push(`${code}: ${detail}`);
  };

  // ① 三要素齐全:假设、干预、回滚点。
  if (exp.hypothesis.claim.trim() === "") flag("EXP_HYPOTHESIS_EMPTY", "hypothesis.claim 为空,无可验收的结论");
  if (exp.intervention.ref.trim() === "" || exp.intervention.variant.trim() === "") {
    flag("EXP_INTERVENTION_MISSING", "intervention.ref/variant 为空,不知道改了什么");
  }
  if (exp.rollbackPoint.ref.trim() === "") flag("EXP_ROLLBACK_MISSING", "rollbackPoint.ref 为空,出问题无法回滚");

  // ② 灰度必须跑完且规模合法。
  const c = exp.canary;
  if (c.status !== "done") flag("EXP_CANARY_INCOMPLETE", `canary.status=${c.status},灰度未跑完`);
  if (c.scope === "percent") {
    const pct = c.percent ?? 0;
    if (!(pct > 0 && pct <= 100)) flag("EXP_CANARY_INCOMPLETE", `canary.percent=${pct} 越界(需在 (0,100])`);
  } else if (c.scope === "session") {
    if ((c.sessions ?? 0) < 1) flag("EXP_CANARY_INCOMPLETE", `canary.sessions=${c.sessions ?? 0} < 1`);
  } else if ((c.projects ?? 0) < 1) {
    flag("EXP_CANARY_INCOMPLETE", `canary.projects=${c.projects ?? 0} < 1`);
  }

  // ③ 指标:样本量、显著性、效应与方向。
  if (exp.metrics.length === 0) flag("EXP_RESULT_SAMPLE_LOW", "无指标可验收");
  for (const metric of exp.metrics) {
    const label = metric.name.trim() === "" ? "(未命名指标)" : metric.name;
    const t = metric.thresholds;
    const b = metric.baseline;
    const r = metric.result;
    // 警戒线角色:只要求「有结果 + 样本达标」,回退约束在 ④ 按 guardrails 阈值判,
    // 不要求显著性、方向与 minEffectPct(否则 +5% 在允许 10% 内的健康回退会被判不可采纳)。
    if (metric.role === "guardrail") {
      if (!r) {
        flag("EXP_GUARDRAIL_BREACH", `guardrail 指标 ${label} result 缺失,无法证明无回归`);
      } else if (r.sample < t.minSample) {
        flag("EXP_RESULT_SAMPLE_LOW", `指标 ${label} result 样本不足(${r.sample} < ${t.minSample})`);
      }
      continue;
    }
    if (!r || r.sample < t.minSample) {
      flag("EXP_RESULT_SAMPLE_LOW", `指标 ${label} result 缺失或样本不足(${r?.sample ?? 0} < ${t.minSample})`);
    }
    if (b.sample < t.minSample) {
      flag("EXP_BASELINE_SAMPLE_LOW", `指标 ${label} baseline 样本不足(${b.sample} < ${t.minSample})`);
    }
    if (!r) continue;

    // 显著性:两样本 z。
    const meanDiff = Math.abs(r.value - b.value);
    const cal = standardErrorOfDifference(metric);
    if (!cal || !(cal.se > 0)) {
      flag(
        "EXP_NOT_SIGNIFICANT",
        `指标 ${label} 证据不足:stddev 缺失且非比例口径,标准误不可算(se=${cal ? fmt(cal.se) : "N/A"})`,
      );
    } else {
      details.push(`标准误[${label}]: ${cal.kind === "stddev" ? "stddev 标准误" : "二项标准误"} se=${fmt(cal.se)}`);
      const z = meanDiff / cal.se;
      const minZ = metric.thresholds.minZ ?? policy?.minZ ?? DEFAULT_MIN_Z;
      if (!(z >= minZ)) {
        flag("EXP_NOT_SIGNIFICANT", `指标 ${label} z=${fmt(z)} < minZ ${fmt(minZ)}`);
      }
    }

    // 效应与方向。
    const absDiff = r.value - b.value;
    const zeroBase = b.value === 0;
    const relPct = zeroBase ? absDiff : (absDiff / Math.abs(b.value)) * 100;
    const caliber = zeroBase ? "(baseline.value 为 0,采用绝对差口径)" : "(相对基线百分比)";
    const minEffect = t.minEffectPct;
    const signOk = metric.direction === "increase" ? relPct >= 0 : relPct <= 0;
    if (!signOk) {
      flag(
        "EXP_DIRECTION_UNMET",
        `指标 ${label} 方向不符:要求 ${metric.direction},实际 rel=${fmt(relPct)}% ${caliber}`,
      );
    } else if (Math.abs(relPct) < minEffect) {
      flag(
        "EXP_EFFECT_BELOW_MIN",
        `指标 ${label} 幅度不足:${fmt(Math.abs(relPct))}% < minEffectPct ${fmt(minEffect)}${caliber}`,
      );
    }
  }

  // ④ 警戒线:同名指标的最大回退百分比。
  for (const g of exp.guardrails) {
    const m = exp.metrics.find((x) => x.name === g.metric);
    if (!m) {
      flag("EXP_GUARDRAIL_BREACH", `guardrail 指标缺失,无法证明无回归(${g.metric})`);
      continue;
    }
    if (!m.result) {
      // 无 result 时 adopt 已被 EXP_RESULT_SAMPLE_LOW 拦截,这里不额外判回归(等同 baseline 视为无回归)。
      details.push(`guardrail ${g.metric} 无 result,按无回归处理(样本门另行拦截)`);
      continue;
    }
    const base = m.baseline.value;
    const delta = m.result.value - base;
    // 回归 = 朝「更差」方向的相对变化:increase 指标的下降、decrease 指标的上升才算回退。
    // 改善方向(如 verify_pass_rate 上升)不得计入回归。
    const worse = m.direction === "increase" ? -delta : delta;
    const regressionPct = base === 0 ? Math.max(0, worse) : Math.max(0, (worse / Math.abs(base)) * 100);
    if (regressionPct > g.maxRegressionPct) {
      flag(
        "EXP_GUARDRAIL_BREACH",
        `guardrail ${g.metric} 回退 ${fmt(regressionPct)}% > 允许 ${fmt(g.maxRegressionPct)}%`,
      );
    }
  }

  // ⑤ 冲突:同面同 ref 已有被采纳的实验(自身 id 不计)。
  const conflicts = (policy?.conflicts ?? []).filter((x) => x.id !== exp.id);
  if (conflicts.length > 0) {
    flag(
      "EXP_CONFLICTING_ADOPTED",
      `同面同 ref 已有被采纳实验:${conflicts.map((x) => x.id).join(",")}`,
    );
  }

  return { ok: codes.length === 0, codes, details };
}

/** 找出与 candidate 冲突的既有实验:同 surface+ref、已 adopt、时间窗重叠、id 不同。 */
export function findConflicts(candidate: Experiment, existing: Experiment[]): Experiment[] {
  return existing.filter((other) => {
    if (other.id === candidate.id) return false;
    if (other.decision.kind !== "adopt") return false;
    if (other.intervention.surface !== candidate.intervention.surface) return false;
    if (other.intervention.ref !== candidate.intervention.ref) return false;
    return candidate.strata.some((a) => other.strata.some((b) => windowsOverlap(a.window, b.window)));
  });
}

/** 纯递归深拷贝(不依赖 structuredClone,保留 undefined 字段)。 */
function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => deepClone(v)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepClone(v);
    return out as T;
  }
  return value;
}

/**
 * --result 覆盖 metrics 时按指标名回填原记录 role:结果文件通常只带数值不带 role,
 * 不回填会把 guardrail 指标降级成 success,带警戒线的实验就不可 adopt 了。
 */
export function inheritMetricRoles(incoming: ExperimentMetric[], current: ExperimentMetric[]): ExperimentMetric[] {
  const roleByName = new Map<string, NonNullable<ExperimentMetric["role"]>>();
  for (const m of current) if (m.role) roleByName.set(m.name, m.role);
  if (roleByName.size === 0) return incoming;
  return incoming.map((m) => (m.role ? m : roleByName.has(m.name) ? { ...m, role: roleByName.get(m.name) } : m));
}

/**
 * 决策:返回新版本实验(深拷贝),入参不被修改。adopt 必须先过 evaluateAdoptGate;
 * reject/iterate/rollback 必须带理由。
 */
export function decideExperiment(
  exp: Experiment,
  kind: Exclude<ExperimentDecisionKind, "pending">,
  opts: {
    by?: string;
    reason?: string;
    at?: number;
    resultMetrics?: ExperimentMetric[];
    conflicts?: Array<{ id: string }>;
  } = {},
): { ok: boolean; codes: string[]; experiment?: Experiment } {
  const candidate = deepClone(exp);
  if (opts.resultMetrics) {
    candidate.metrics = deepClone(inheritMetricRoles(opts.resultMetrics, exp.metrics));
  }

  if (kind === "adopt") {
    const gate = evaluateAdoptGate(candidate, { conflicts: opts.conflicts });
    if (!gate.ok) return { ok: false, codes: gate.codes };
    const at = opts.at ?? Date.now();
    candidate.decision = { kind: "adopt", at, by: opts.by, reason: opts.reason };
    candidate.updatedAt = at;
    return { ok: true, codes: [], experiment: candidate };
  }

  if ((opts.reason ?? "").trim() === "") {
    return { ok: false, codes: ["EXP_REASON_REQUIRED"] };
  }
  const at = opts.at ?? Date.now();
  candidate.decision = { kind, at, by: opts.by, reason: opts.reason };
  candidate.updatedAt = at;
  return { ok: true, codes: [], experiment: candidate };
}

/**
 * 灰度批次规划:候选按 sha256(expId:key) hex 升序取前 N(确定性,无随机)。
 */
export function planCanary(exp: Experiment, total?: number): { size: number; rule: string; picks: string[] } {
  const candidates = exp.traceBatchKeys ?? [];
  const c = exp.canary;
  let desired = 0;
  let outOfRange = false;
  if (c.scope === "session") {
    desired = c.sessions ?? 0;
  } else if (c.scope === "project") {
    desired = c.projects ?? 0;
  } else {
    const pct = c.percent ?? 0;
    if (!(pct > 0 && pct <= 100)) {
      outOfRange = true;
      desired = 0;
    } else {
      const basis = total ?? candidates.length;
      desired = Math.max(1, Math.ceil((basis * pct) / 100));
    }
  }
  const want = Number.isFinite(desired) ? Math.max(0, Math.floor(desired)) : 0;
  const size = Math.min(want, candidates.length);
  const ranked = candidates
    .map((key) => ({ key, rank: sha256hex(`${exp.id}:${key}`) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((x) => x.key);
  const rule = outOfRange
    ? `canary.percent=${c.percent ?? 0} 越界(需在 (0,100]),本批取 0 条;sha256(expId:key) 升序取前 N;确定性无随机`
    : "sha256(expId:key) 升序取前 N;确定性无随机";
  return { size, rule, picks: ranked.slice(0, size) };
}

/** 单个 stratum 是否命中过滤条件(缺省字段即通配;window 重叠即匹配)。 */
function stratumMatches(s: ExperimentStratum, f: ExperimentStratum): boolean {
  if (f.projectId !== undefined && s.projectId !== undefined && s.projectId !== f.projectId) return false;
  if (f.taskClass !== undefined && s.taskClass !== undefined && s.taskClass !== f.taskClass) return false;
  if (f.model !== undefined && s.model !== undefined && s.model !== f.model) return false;
  if (f.window !== undefined && s.window !== undefined && !windowsOverlap(s.window, f.window)) return false;
  return true;
}

/** 按分层取实验:无过滤键原样返回;任一 stratum 命中即保留。 */
export function filterByStratum(
  experiments: Experiment[],
  f: { projectId?: string; taskClass?: string; model?: string; window?: { from: string; to: string } },
): Experiment[] {
  const hasFilter = f.projectId !== undefined || f.taskClass !== undefined || f.model !== undefined || f.window !== undefined;
  if (!hasFilter) return experiments;
  return experiments.filter((exp) => exp.strata.some((s) => stratumMatches(s, f)));
}
