/**
 * RSI #194 方向总览(Direction Atlas,纯逻辑零 IO,2026-11)。
 * 为什么需要它:RSI 各机制各自落盘(缺陷谱系 defects.jsonl、证据图、决策质量…),但没有一份
 * 跨机制的「这个项目现在到底朝哪走」视图 —— 于是目标漂移(做久了却早偏离原目标)、
 * 未裁决的需求冲突、以及反复复发的缺陷类别都没人汇总。本模块把五个来源
 * (goals / changes / conflicts / decisions / defectGenes)折成一份 DirectionAtlas:
 * - 目标按 since 排好,给出 active/achieved/abandoned 三计数;
 * - 转向时间线(timeline)按 at 升序,记录 pivot/refocus/abandon/scope-cut/add;
 * - 冲突带上裁决状态,并把裁决结果反射回目标(superseded);
 * - 缺陷基因按 defectClass 聚合出 top5,让「同一个类反复犯错」可见;
 * - driftFlags 三条规则直接点出漂移信号,交给上层决定告警还是降频。
 * 依赖纪律(为什么零 import):本文件必须可被任意宿主(store / CLI / 未来的 web 面板)复用,
 * 且测试必须是确定性的 —— 因此
 * 1) 不 import 任何模块(尤其 node:fs / node:path / node:os / child_process),不读写文件与环境;
 * 2) 不取真实时钟:`now` 由参数注入,缺省用固定常量 ATLAS_DEFAULT_NOW(1970-01-01T00:00:00.000Z),
 *    绝不用 `Date.now()` —— 否则同一输入在不同机器/时刻会给出不同的 driftFlags,快照与断言不可复现;
 * 3) 全部函数不 throw:非法条目跳过并记 ATLAS_INVALID,其余照常构建(上游是 append-only 日志,
 *    坏行是常态,不能让一条坏行炸掉整份总览)。
 * 码表顺序固定(便于自动化按码断言):INVALID 在最前,BUILT 紧随其后,动作码在后。
 */

/** 方向总览 schema 版本:字段语义变化时递增。 */
export const DIRECTION_ATLAS_VERSION = 1;

/** 缺省「现在」:固定常量(理由见文件头第 2 条 —— 纯函数不得取真实时钟)。 */
export const ATLAS_DEFAULT_NOW = "1970-01-01T00:00:00.000Z";

/** 缺省漂移窗口(天):一个 active 目标超过 30 天没有证据引用,就认为断供了。 */
export const ATLAS_DEFAULT_DRIFT_WINDOW_DAYS = 30;

/** 缺陷基因摘要的缺省截断长度。 */
export const ATLAS_TOP_DEFECT_LIMIT = 5;

/** 一天多少毫秒(漂移窗口按天数换算成毫秒差比较)。 */
export const ATLAS_MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 稳定码:构建/裁决/漂移的判断结论(字符串常量,便于落盘与断言)。 */
export const ATLAS_INVALID = "ATLAS_INVALID" as const;
export const ATLAS_BUILT = "ATLAS_BUILT" as const;
export const ATLAS_CONFLICT_OPEN = "ATLAS_CONFLICT_OPEN" as const;
export const ATLAS_CONFLICT_RESOLVED = "ATLAS_CONFLICT_RESOLVED" as const;
export const ATLAS_DRIFT_DETECTED = "ATLAS_DRIFT_DETECTED" as const;
export const ATLAS_NO_DRIFT = "ATLAS_NO_DRIFT" as const;
export const ATLAS_GOAL_NOT_FOUND = "ATLAS_GOAL_NOT_FOUND" as const;
export const ATLAS_STALE_EVIDENCE = "ATLAS_STALE_EVIDENCE" as const;
export const ATLAS_RENDERED = "ATLAS_RENDERED" as const;

/** 全部稳定码(固定顺序;输出码按此序排列,故 codes 数组天然可比对)。 */
export const ATLAS_CODES = [
  ATLAS_INVALID,
  ATLAS_BUILT,
  ATLAS_CONFLICT_OPEN,
  ATLAS_CONFLICT_RESOLVED,
  ATLAS_DRIFT_DETECTED,
  ATLAS_NO_DRIFT,
  ATLAS_GOAL_NOT_FOUND,
  ATLAS_STALE_EVIDENCE,
  ATLAS_RENDERED,
] as const;

export type AtlasCode = (typeof ATLAS_CODES)[number];

/** 目标状态:active 在推进;achieved 达成;abandoned 主动放弃;superseded 被另一目标取代。 */
export type GoalStatus = "active" | "achieved" | "abandoned" | "superseded";

/** 一条方向目标(项目的「我在朝哪走」的最小单位)。 */
export interface Goal {
  id: string;
  title: string;
  detail?: string;
  status: GoalStatus;
  since: string;
  until?: string;
  evidenceRefs: string[];
  supersededBy?: string;
}

/** 转向种类:pivot 换向 / refocus 重聚焦 / abandon 放弃 / scope-cut 砍范围 / add 加目标。 */
export type ChangeKind = "pivot" | "refocus" | "abandon" | "scope-cut" | "add";

/** 一次方向变更(from/to 尽量写 goal id;写不出 id 时保留原文本,不报错)。 */
export interface DirectionChange {
  id: string;
  at: string;
  kind: ChangeKind;
  from?: string;
  to?: string;
  reason: string;
  evidenceRefs: string[];
}

/** 冲突裁决结果(chosenGoalId 胜出,另一侧转 superseded)。 */
export interface ConflictResolution {
  chosenGoalId: string;
  reason: string;
  by: string;
  at: string;
}

/** 两个目标之间的需求冲突(open 未决 / resolved 已裁决)。 */
export interface Conflict {
  id: string;
  goals: [string, string];
  description: string;
  status: "open" | "resolved";
  resolution?: ConflictResolution;
}

/** 关键决策的冲击面(high 才计入 summary.highImpactDecisions)。 */
export type DecisionImpact = "low" | "medium" | "high";

/** 一条关键决策(为什么这么定,比「定了什么」更难回溯,所以必须带 rationale)。 */
export interface KeyDecision {
  id: string;
  at: string;
  decision: string;
  rationale: string;
  impact: DecisionImpact;
  evidenceRefs: string[];
}

/** 缺陷基因:同一缺陷类别在同一模块反复出现的次数(RSI 用来定位「惯犯」)。 */
export interface DefectGene {
  id: string;
  defectClass: string;
  module: string;
  count: number;
  lastAt: string;
  severity?: string;
}

/** 汇总计数(topDefectClasses 已按 count 降序、同 count 按 class 字典序截断)。 */
export interface AtlasSummary {
  activeGoals: number;
  achieved: number;
  abandoned: number;
  openConflicts: number;
  topDefectClasses: { class: string; count: number }[];
  highImpactDecisions: number;
}

/** 方向总览:一次构建的不可变快照(落盘即 `atlasPath(projectId)` 的 JSON)。 */
export interface DirectionAtlas {
  projectId: string;
  generatedAt: string;
  goals: Goal[];
  timeline: DirectionChange[];
  conflicts: Conflict[];
  keyDecisions: KeyDecision[];
  defectGenes: DefectGene[];
  summary: AtlasSummary;
  driftFlags: string[];
}

/** 构建入参(五个来源都是 append-only 日志的读视图,可能含坏行)。 */
export interface AtlasInput {
  projectId: string;
  goals: Goal[];
  changes: DirectionChange[];
  conflicts: Conflict[];
  decisions: KeyDecision[];
  defectGenes: DefectGene[];
}

/** 构建选项:now 缺省用 ATLAS_DEFAULT_NOW;driftWindowDays 缺省 30。 */
export interface AtlasBuildOptions {
  now?: string;
  driftWindowDays?: number;
}

/** 构建/裁决结论(码按 ATLAS_CODES 顺序排好)。 */
export interface AtlasResult {
  atlas: DirectionAtlas;
  codes: AtlasCode[];
}

type UnknownRecord = Record<string, unknown>;

const GOAL_STATUSES: readonly string[] = ["active", "achieved", "abandoned", "superseded"];
const CHANGE_KINDS: readonly string[] = ["pivot", "refocus", "abandon", "scope-cut", "add"];
const DECISION_IMPACTS: readonly string[] = ["low", "medium", "high"];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** at/since/until 这类时间字段:必须能被 Date.parse 解析,否则视为非法(不抛)。 */
function timeOf(value: unknown): number | undefined {
  const text = nonEmptyText(value);
  if (text === undefined) return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
}

/** 证据引用:只保留字符串项(非字符串丢弃,不留半截对象)。 */
function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

/** 「有没有真的挂证据引用」:空数组、或全是空串,都算没挂。 */
function hasEvidence(refs: readonly string[]): boolean {
  for (const ref of refs) {
    if (ref.trim() !== "") return true;
  }
  return false;
}

/** 通用条目读取:非数组整段记 notArray;单条读不出来记 invalid(计数,不抛)。 */
function readList<T>(
  raw: unknown,
  read: (item: unknown) => T | undefined): { items: T[]; invalid: number; notArray: boolean } {
  if (!Array.isArray(raw)) return { items: [], invalid: 0, notArray: true };
  const items: T[] = [];
  let invalid = 0;
  for (const item of raw) {
    const parsed = read(item);
    if (parsed === undefined) {
      invalid += 1;
      continue;
    }
    items.push(parsed);
  }
  return { items, invalid, notArray: false };
}

/** 读一个 goal:id 非空 + since 可解析是硬门槛,其余字段缺省兜底。 */
function readGoal(raw: unknown): Goal | undefined {
  if (!isRecord(raw)) return undefined;
  const id = nonEmptyText(raw["id"]);
  if (id === undefined) return undefined;
  if (timeOf(raw["since"]) === undefined) return undefined;
  const statusText = nonEmptyText(raw["status"]);
  const status: GoalStatus =
    statusText !== undefined && GOAL_STATUSES.includes(statusText) ? (statusText as GoalStatus) : "active";
  const goal: Goal = {
    id,
    title: textOf(raw["title"]),
    status,
    since: textOf(raw["since"]),
    evidenceRefs: textList(raw["evidenceRefs"]),
  };
  const detail = nonEmptyText(raw["detail"]);
  if (detail !== undefined) goal.detail = detail;
  const until = nonEmptyText(raw["until"]);
  if (until !== undefined) goal.until = until;
  const supersededBy = nonEmptyText(raw["supersededBy"]);
  if (supersededBy !== undefined) goal.supersededBy = supersededBy;
  return goal;
}

/** 读一次转向变更:id 非空 + at 可解析 + kind 在枚举内才算合法。 */
function readChange(raw: unknown): DirectionChange | undefined {
  if (!isRecord(raw)) return undefined;
  const id = nonEmptyText(raw["id"]);
  if (id === undefined) return undefined;
  if (timeOf(raw["at"]) === undefined) return undefined;
  const kindText = nonEmptyText(raw["kind"]);
  if (kindText === undefined || !CHANGE_KINDS.includes(kindText)) return undefined;
  const change: DirectionChange = {
    id,
    at: textOf(raw["at"]),
    kind: kindText as ChangeKind,
    reason: textOf(raw["reason"]),
    evidenceRefs: textList(raw["evidenceRefs"]),
  };
  // from/to 不做 id 校验:写不出 goal id 时保留原文本即可(时间线是历史记录,不该因解析失败丢条目)。
  const from = nonEmptyText(raw["from"]);
  if (from !== undefined) change.from = from;
  const to = nonEmptyText(raw["to"]);
  if (to !== undefined) change.to = to;
  return change;
}

function readResolution(raw: unknown): ConflictResolution | undefined {
  if (!isRecord(raw)) return undefined;
  const chosenGoalId = nonEmptyText(raw["chosenGoalId"]);
  if (chosenGoalId === undefined) return undefined;
  return {
    chosenGoalId,
    reason: textOf(raw["reason"]),
    by: textOf(raw["by"]),
    at: textOf(raw["at"]),
  };
}

/** 读一个冲突:id 非空 + goals 恰为两个非空字符串;resolution 只读出来,不做一致性校验。 */
function readConflict(raw: unknown): Conflict | undefined {
  if (!isRecord(raw)) return undefined;
  const id = nonEmptyText(raw["id"]);
  if (id === undefined) return undefined;
  const goals = raw["goals"];
  if (!Array.isArray(goals) || goals.length !== 2) return undefined;
  const left = nonEmptyText(goals[0]);
  const right = nonEmptyText(goals[1]);
  if (left === undefined || right === undefined) return undefined;
  const statusText = nonEmptyText(raw["status"]);
  const conflict: Conflict = {
    id,
    goals: [left, right],
    description: textOf(raw["description"]),
    status: statusText === "resolved" ? "resolved" : "open",
  };
  const resolution = readResolution(raw["resolution"]);
  if (resolution !== undefined) conflict.resolution = resolution;
  return conflict;
}

/** 读一条关键决策:id 非空 + at 可解析;impact 缺省 low。 */
function readDecision(raw: unknown): KeyDecision | undefined {
  if (!isRecord(raw)) return undefined;
  const id = nonEmptyText(raw["id"]);
  if (id === undefined) return undefined;
  if (timeOf(raw["at"]) === undefined) return undefined;
  const impactText = nonEmptyText(raw["impact"]);
  const impact: DecisionImpact =
    impactText !== undefined && DECISION_IMPACTS.includes(impactText) ? (impactText as DecisionImpact) : "low";
  return {
    id,
    at: textOf(raw["at"]),
    decision: textOf(raw["decision"]),
    rationale: textOf(raw["rationale"]),
    impact,
    evidenceRefs: textList(raw["evidenceRefs"]),
  };
}

/** 读一条缺陷基因:defectClass 非空 + count 有限非负是硬门槛(id 缺省用 class 兜底)。 */
function readDefectGene(raw: unknown): DefectGene | undefined {
  if (!isRecord(raw)) return undefined;
  const defectClass = nonEmptyText(raw["defectClass"]);
  if (defectClass === undefined) return undefined;
  const count = raw["count"];
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return undefined;
  const gene: DefectGene = {
    id: nonEmptyText(raw["id"]) ?? defectClass,
    defectClass,
    module: textOf(raw["module"]),
    count,
    lastAt: textOf(raw["lastAt"]),
  };
  const severity = nonEmptyText(raw["severity"]);
  if (severity !== undefined) gene.severity = severity;
  return gene;
}

/** 按 ATLAS_CODES 的固定顺序输出码(去重顺带完成,便于上游按码断言)。 */
function orderCodes(seen: Set<AtlasCode>): AtlasCode[] {
  return ATLAS_CODES.filter((code) => seen.has(code));
}

function emptySummary(): AtlasSummary {
  return {
    activeGoals: 0,
    achieved: 0,
    abandoned: 0,
    openConflicts: 0,
    topDefectClasses: [],
    highImpactDecisions: 0,
  };
}

/** 缺陷基因聚合:按 defectClass 求和 → count 降序 → 同 count 按 class 字典序 → 截断。 */
function aggregateDefectClasses(genes: readonly DefectGene[], limit: number): { class: string; count: number }[] {
  const totals = new Map<string, number>();
  for (const gene of genes) {
    totals.set(gene.defectClass, (totals.get(gene.defectClass) ?? 0) + gene.count);
  }
  const rows: { class: string; count: number }[] = [];
  for (const [cls, count] of totals) rows.push({ class: cls, count });
  rows.sort((a, b) => (b.count - a.count !== 0 ? b.count - a.count : a.class < b.class ? -1 : a.class > b.class ? 1 : 0));
  return limit >= 0 ? rows.slice(0, limit) : [];
}

function cloneGoal(goal: Goal): Goal {
  const out: Goal = {
    id: goal.id,
    title: goal.title,
    status: goal.status,
    since: goal.since,
    evidenceRefs: [...goal.evidenceRefs],
  };
  if (goal.detail !== undefined) out.detail = goal.detail;
  if (goal.until !== undefined) out.until = goal.until;
  if (goal.supersededBy !== undefined) out.supersededBy = goal.supersededBy;
  return out;
}

function cloneChange(change: DirectionChange): DirectionChange {
  const out: DirectionChange = {
    id: change.id,
    at: change.at,
    kind: change.kind,
    reason: change.reason,
    evidenceRefs: [...change.evidenceRefs],
  };
  if (change.from !== undefined) out.from = change.from;
  if (change.to !== undefined) out.to = change.to;
  return out;
}

function cloneConflict(conflict: Conflict): Conflict {
  const out: Conflict = {
    id: conflict.id,
    goals: [conflict.goals[0], conflict.goals[1]],
    description: conflict.description,
    status: conflict.status,
  };
  if (conflict.resolution !== undefined) {
    out.resolution = {
      chosenGoalId: conflict.resolution.chosenGoalId,
      reason: conflict.resolution.reason,
      by: conflict.resolution.by,
      at: conflict.resolution.at,
    };
  }
  return out;
}

function cloneDecision(decision: KeyDecision): KeyDecision {
  return {
    id: decision.id,
    at: decision.at,
    decision: decision.decision,
    rationale: decision.rationale,
    impact: decision.impact,
    evidenceRefs: [...decision.evidenceRefs],
  };
}

function cloneGene(gene: DefectGene): DefectGene {
  const out: DefectGene = {
    id: gene.id,
    defectClass: gene.defectClass,
    module: gene.module,
    count: gene.count,
    lastAt: gene.lastAt,
  };
  if (gene.severity !== undefined) out.severity = gene.severity;
  return out;
}

/** 深拷贝一份 atlas:对外函数一律返回副本,调用方(store)拿到的快照与自己持有的对象互不影响。 */
function cloneAtlas(atlas: DirectionAtlas): DirectionAtlas {
  return {
    projectId: atlas.projectId,
    generatedAt: atlas.generatedAt,
    goals: atlas.goals.map(cloneGoal),
    timeline: atlas.timeline.map(cloneChange),
    conflicts: atlas.conflicts.map(cloneConflict),
    keyDecisions: atlas.keyDecisions.map(cloneDecision),
    defectGenes: atlas.defectGenes.map(cloneGene),
    summary: {
      activeGoals: atlas.summary.activeGoals,
      achieved: atlas.summary.achieved,
      abandoned: atlas.summary.abandoned,
      openConflicts: atlas.summary.openConflicts,
      topDefectClasses: atlas.summary.topDefectClasses.map((row) => ({ class: row.class, count: row.count })),
      highImpactDecisions: atlas.summary.highImpactDecisions,
    },
    driftFlags: [...atlas.driftFlags],
  };
}

/**
 * 构建方向总览。
 * 口径(与用例一一对应):
 * - goals 按 since 升序(同 since 保持入参顺序,Array#sort 稳定),计数 active/achieved/abandoned;
 * - timeline = changes 按 at 升序;from/to 命中 goal id 就保留 id,不命中保留原文本(绝不因解析失败丢历史);
 * - 冲突:两个 goal id 必须存在于 goals,缺失记 ATLAS_GOAL_NOT_FOUND 但冲突原样保留;
 *   open 计入 summary.openConflicts 并记 ATLAS_CONFLICT_OPEN;resolved 记 ATLAS_CONFLICT_RESOLVED;
 * - defectGenes 按 defectClass 求和,count 降序(同 count 按 class 字典序)取前 5;
 * - highImpactDecisions = impact==="high" 的条数;
 * - driftFlags 三条规则见下(命中任一 → ATLAS_DRIFT_DETECTED,全不命中 → ATLAS_NO_DRIFT);
 * - 非法条目(goal 缺 id / since 不可解析 / 字段不是数组…)跳过并记 ATLAS_INVALID(去重),其余照常构建。
 */
export function buildAtlas(input: AtlasInput, opts?: AtlasBuildOptions): AtlasResult {
  const raw: UnknownRecord = isRecord(input) ? input : {};
  const opt: UnknownRecord = isRecord(opts) ? opts : {};

  const nowText = nonEmptyText(opt["now"]);
  const nowParsed = nowText === undefined ? undefined : timeOf(nowText);
  const nowMs = nowParsed ?? Date.parse(ATLAS_DEFAULT_NOW);
  const generatedAt = nowText !== undefined && nowParsed !== undefined ? nowText : ATLAS_DEFAULT_NOW;

  const daysRaw = opt["driftWindowDays"];
  const driftWindowDays =
    typeof daysRaw === "number" && Number.isFinite(daysRaw) ? daysRaw : ATLAS_DEFAULT_DRIFT_WINDOW_DAYS;

  const codes = new Set<AtlasCode>();
  codes.add(ATLAS_BUILT);

  const projectIdText = nonEmptyText(raw["projectId"]);
  if (projectIdText === undefined) codes.add(ATLAS_INVALID);
  const projectId = projectIdText ?? "";

  const goalList = readList(raw["goals"], readGoal);
  const changeList = readList(raw["changes"], readChange);
  const conflictList = readList(raw["conflicts"], readConflict);
  const decisionList = readList(raw["decisions"], readDecision);
  const geneList = readList(raw["defectGenes"], readDefectGene);

  for (const list of [goalList, changeList, conflictList, decisionList, geneList]) {
    if (list.notArray || list.invalid > 0) codes.add(ATLAS_INVALID);
  }

  // ── 目标:按 since 升序 ─────────────────────────────────────────────────────
  const goals = goalList.items
    .map((goal) => ({ goal, ms: timeOf(goal.since) ?? 0 }))
    .sort((a, b) => a.ms - b.ms)
    .map((row) => row.goal);

  const statusById = new Map<string, GoalStatus>();
  for (const goal of goals) statusById.set(goal.id, goal.status);
  const goalIds = new Set<string>();
  for (const goal of goals) goalIds.add(goal.id);

  let activeGoals = 0;
  let achieved = 0;
  let abandoned = 0;
  for (const goal of goals) {
    if (goal.status === "active") activeGoals += 1;
    else if (goal.status === "achieved") achieved += 1;
    else if (goal.status === "abandoned") abandoned += 1;
  }

  // ── 时间线:按 at 升序 ─────────────────────────────────────────────────────
  const timeline = changeList.items
    .map((change) => ({ change, ms: timeOf(change.at) ?? 0 }))
    .sort((a, b) => a.ms - b.ms)
    .map((row) => row.change);

  // ── 冲突:goal 缺失只记码,冲突原样保留 ────────────────────────────────────
  const conflicts = conflictList.items.slice();
  let openConflicts = 0;
  for (const conflict of conflicts) {
    if (!goalIds.has(conflict.goals[0]) || !goalIds.has(conflict.goals[1])) codes.add(ATLAS_GOAL_NOT_FOUND);
    if (conflict.status === "open") {
      openConflicts += 1;
      codes.add(ATLAS_CONFLICT_OPEN);
    } else {
      codes.add(ATLAS_CONFLICT_RESOLVED);
    }
  }

  // ── 缺陷基因:聚合 top5;决策:high 计数 ───────────────────────────────────
  const topDefectClasses = aggregateDefectClasses(geneList.items, ATLAS_TOP_DEFECT_LIMIT);
  let highImpactDecisions = 0;
  for (const decision of decisionList.items) {
    if (decision.impact === "high") highImpactDecisions += 1;
  }

  // ── 漂移三规则 ─────────────────────────────────────────────────────────────
  const driftFlags: string[] = [];
  const seenFlags = new Set<string>();
  const pushFlag = (flag: string): void => {
    if (seenFlags.has(flag)) return;
    seenFlags.add(flag);
    driftFlags.push(flag);
  };

  // ① 断供:只审计 active 目标 —— 没挂证据引用(空数组/全空串),且 since 已早于窗口起点。
  //    证据引用本身没有内嵌时间,所以「最近」退化为「有没有」+「目标够不够老」两步判断。
  const windowMs = driftWindowDays * ATLAS_MS_PER_DAY;
  for (const goal of goals) {
    if (goal.status !== "active") continue;
    if (hasEvidence(goal.evidenceRefs)) continue;
    const sinceMs = timeOf(goal.since);
    if (sinceMs === undefined) continue;
    if (sinceMs < nowMs - windowMs) pushFlag(`goal:${goal.id}:no-recent-evidence`);
  }

  // ② 未决冲突且双方都还在推进 —— 这种冲突会持续撕扯资源,必须显性化。
  for (const conflict of conflicts) {
    if (conflict.status !== "open") continue;
    const left = statusById.get(conflict.goals[0]);
    const right = statusById.get(conflict.goals[1]);
    if (left === "active" && right === "active") pushFlag(`conflict-open:${conflict.id}`);
  }

  // ③ 最后一次动作是放弃,且 to 没有指向任何 active 目标 —— 放弃了却没接上班。
  let lastChange: DirectionChange | undefined;
  for (const change of timeline) {
    if (lastChange === undefined) {
      lastChange = change;
      continue;
    }
    const currentMs = timeOf(change.at) ?? 0;
    const lastMs = timeOf(lastChange.at) ?? 0;
    if (currentMs >= lastMs) lastChange = change;
  }
  if (lastChange !== undefined && lastChange.kind === "abandon") {
    const target = lastChange.to === undefined ? undefined : statusById.get(lastChange.to);
    if (target !== "active") pushFlag(`abandon-without-successor:${lastChange.id}`);
  }

  if (driftFlags.length > 0) codes.add(ATLAS_DRIFT_DETECTED);
  else codes.add(ATLAS_NO_DRIFT);

  const atlas: DirectionAtlas = {
    projectId,
    generatedAt,
    goals: goals.map(cloneGoal),
    timeline: timeline.map(cloneChange),
    conflicts: conflicts.map(cloneConflict),
    keyDecisions: decisionList.items.map(cloneDecision),
    defectGenes: geneList.items.map(cloneGene),
    summary: {
      activeGoals,
      achieved,
      abandoned,
      openConflicts,
      topDefectClasses,
      highImpactDecisions,
    },
    driftFlags,
  };

  return { atlas, codes: orderCodes(codes) };
}

/**
 * 裁决一个需求冲突:chosenGoalId 胜出,另一侧目标转 superseded(until=opts.at,supersededBy=chosen)。
 * 幂等性(store 的 resolve 可能被重复调用):已 resolved 的冲突再裁决一次,返回**结构等价**的副本,
 * 不再改任何 goal 的 until/supersededBy —— 否则 at 会沿着重复调用漂移,R3 风险就是这么来的。
 * 入参 atlas 永不被修改(全程在深拷贝上操作)。
 */
export function resolveConflict(
  atlas: DirectionAtlas,
  conflictId: string,
  opts: ConflictResolution): AtlasResult {
  const next = cloneAtlas(atlas);
  const codes = new Set<AtlasCode>();
  const conflict = next.conflicts.find((item) => item.id === conflictId);

  if (conflict === undefined) {
    codes.add(ATLAS_INVALID);
    return { atlas: next, codes: orderCodes(codes) };
  }
  if (conflict.status === "resolved") {
    codes.add(ATLAS_CONFLICT_RESOLVED);
    return { atlas: next, codes: orderCodes(codes) };
  }

  const chosenGoalId = nonEmptyText(isRecord(opts) ? opts.chosenGoalId : undefined);
  const loserIds = conflict.goals.filter((goalId) => goalId !== chosenGoalId);
  if (chosenGoalId === undefined || !conflict.goals.includes(chosenGoalId)) {
    codes.add(ATLAS_GOAL_NOT_FOUND);
    return { atlas: next, codes: orderCodes(codes) };
  }

  conflict.status = "resolved";
  conflict.resolution = {
    chosenGoalId,
    reason: textOf(isRecord(opts) ? opts.reason : undefined),
    by: textOf(isRecord(opts) ? opts.by : undefined),
    at: textOf(isRecord(opts) ? opts.at : undefined),
  };
  for (const goal of next.goals) {
    if (!loserIds.includes(goal.id)) continue;
    goal.status = "superseded";
    goal.until = conflict.resolution.at;
    goal.supersededBy = chosenGoalId;
  }

  codes.add(ATLAS_CONFLICT_RESOLVED);
  return { atlas: next, codes: orderCodes(codes) };
}

/** 时间线切片:含端点;from/to 解析不了就当作该边界不存在(忽略,不报错)。 */
export function timelineSince(atlas: DirectionAtlas, opts?: { from?: string; to?: string }): DirectionChange[] {
  const timeline = Array.isArray(atlas?.timeline) ? atlas.timeline : [];
  const opt: UnknownRecord = isRecord(opts) ? opts : {};
  const fromMs = timeOf(opt["from"]);
  const toMs = timeOf(opt["to"]);
  const out: DirectionChange[] = [];
  for (const change of timeline) {
    const atMs = timeOf(change.at);
    if (atMs === undefined) continue;
    if (fromMs !== undefined && atMs < fromMs) continue;
    if (toMs !== undefined && atMs > toMs) continue;
    out.push(cloneChange(change));
  }
  out.sort((a, b) => (timeOf(a.at) ?? 0) - (timeOf(b.at) ?? 0));
  return out;
}

/** 缺陷类别排行:直接取 summary.topDefectClasses 截断(limit ≤ 0 → 空,limit 非有限数 → 缺省 5)。 */
export function topDefectClasses(
  atlas: DirectionAtlas,
  opts?: { limit?: number },
): { class: string; count: number }[] {
  const rows = Array.isArray(atlas?.summary?.topDefectClasses) ? atlas.summary.topDefectClasses : [];
  const rawLimit = isRecord(opts) ? opts["limit"] : undefined;
  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit)
      ? Math.floor(rawLimit)
      : ATLAS_TOP_DEFECT_LIMIT;
  if (limit <= 0) return [];
  return rows.slice(0, limit).map((row) => ({ class: row.class, count: row.count }));
}

/** 人类可读总览(Markdown):五节固定顺序 + 空节写「暂无」+ 末尾漂移告警。 */
export function renderAtlasMarkdown(atlas: DirectionAtlas): string {
  const summary = atlas.summary ?? emptySummary();
  const goals = Array.isArray(atlas.goals) ? atlas.goals : [];
  const timeline = Array.isArray(atlas.timeline) ? atlas.timeline : [];
  const conflicts = Array.isArray(atlas.conflicts) ? atlas.conflicts : [];
  const decisions = Array.isArray(atlas.keyDecisions) ? atlas.keyDecisions : [];
  const topDefects = Array.isArray(summary.topDefectClasses) ? summary.topDefectClasses : [];
  const driftFlags = Array.isArray(atlas.driftFlags) ? atlas.driftFlags : [];

  const lines: string[] = [];
  lines.push(`# 方向总览 — ${textOf(atlas.projectId)}`);
  lines.push("");

  lines.push(
    `## 当前目标（active ${summary.activeGoals} / achieved ${summary.achieved} / abandoned ${summary.abandoned}）`,
  );
  if (goals.length === 0) lines.push("暂无");
  for (const goal of goals) {
    const trail: string[] = [`since ${goal.since}`];
    if (goal.until !== undefined) trail.push(`until ${goal.until}`);
    if (goal.supersededBy !== undefined) trail.push(`supersededBy ${goal.supersededBy}`);
    lines.push(`- [${goal.status}] ${goal.id} ${goal.title}（${trail.join(" / ")}）`);
  }
  lines.push("");

  lines.push(`## 转向时间线（共 ${timeline.length} 条）`);
  if (timeline.length === 0) lines.push("暂无");
  for (const change of timeline) {
    lines.push(`- ${change.at} ${change.kind}: ${change.from ?? "-"} → ${change.to ?? "-"}（${change.reason}）`);
  }
  lines.push("");

  lines.push("## 需求冲突与裁决");
  if (conflicts.length === 0) lines.push("暂无");
  for (const conflict of conflicts) {
    lines.push(
      `- ${conflict.id} [${conflict.status}] ${conflict.goals[0]} × ${conflict.goals[1]}：${conflict.description}`,
    );
    if (conflict.resolution !== undefined) {
      lines.push(
        `  - 裁决：${conflict.resolution.chosenGoalId}（by ${conflict.resolution.by} at ${conflict.resolution.at}）${conflict.resolution.reason}`,
      );
    }
  }
  lines.push("");

  lines.push("## 关键决策");
  if (decisions.length === 0) lines.push("暂无");
  for (const decision of decisions) {
    lines.push(`- ${decision.at} [${decision.impact}] ${decision.id} ${decision.decision}（${decision.rationale}）`);
  }
  lines.push("");

  lines.push("## 缺陷基因摘要");
  if (topDefects.length === 0) lines.push("暂无");
  for (const row of topDefects) lines.push(`- ${row.class} × ${row.count}`);
  lines.push("");

  lines.push("## 漂移告警");
  if (driftFlags.length === 0) lines.push("无漂移告警");
  for (const flag of driftFlags) lines.push(`- ${flag}`);

  return `${lines.join("\n")}\n`;
}

/** 机器可读总览(JSON):显式重建对象以保证 key 顺序稳定(快照可 diff),末尾带换行。 */
export function renderAtlasJson(atlas: DirectionAtlas): string {
  const summary = atlas.summary ?? emptySummary();
  const goals = (Array.isArray(atlas.goals) ? atlas.goals : []).map((goal) => {
    const row: Record<string, unknown> = { id: goal.id, title: goal.title };
    if (goal.detail !== undefined) row["detail"] = goal.detail;
    row["status"] = goal.status;
    row["since"] = goal.since;
    if (goal.until !== undefined) row["until"] = goal.until;
    row["evidenceRefs"] = [...goal.evidenceRefs];
    if (goal.supersededBy !== undefined) row["supersededBy"] = goal.supersededBy;
    return row;
  });
  const timeline = (Array.isArray(atlas.timeline) ? atlas.timeline : []).map((change) => {
    const row: Record<string, unknown> = { id: change.id, at: change.at, kind: change.kind };
    if (change.from !== undefined) row["from"] = change.from;
    if (change.to !== undefined) row["to"] = change.to;
    row["reason"] = change.reason;
    row["evidenceRefs"] = [...change.evidenceRefs];
    return row;
  });
  const conflicts = (Array.isArray(atlas.conflicts) ? atlas.conflicts : []).map((conflict) => {
    const row: Record<string, unknown> = {
      id: conflict.id,
      goals: [conflict.goals[0], conflict.goals[1]],
      description: conflict.description,
      status: conflict.status,
    };
    if (conflict.resolution !== undefined) {
      row["resolution"] = {
        chosenGoalId: conflict.resolution.chosenGoalId,
        reason: conflict.resolution.reason,
        by: conflict.resolution.by,
        at: conflict.resolution.at,
      };
    }
    return row;
  });
  const keyDecisions = (Array.isArray(atlas.keyDecisions) ? atlas.keyDecisions : []).map((decision) => ({
    id: decision.id,
    at: decision.at,
    decision: decision.decision,
    rationale: decision.rationale,
    impact: decision.impact,
    evidenceRefs: [...decision.evidenceRefs],
  }));
  const defectGenes = (Array.isArray(atlas.defectGenes) ? atlas.defectGenes : []).map((gene) => {
    const row: Record<string, unknown> = {
      id: gene.id,
      defectClass: gene.defectClass,
      module: gene.module,
      count: gene.count,
      lastAt: gene.lastAt,
    };
    if (gene.severity !== undefined) row["severity"] = gene.severity;
    return row;
  });
  const topDefectRows = (Array.isArray(summary.topDefectClasses) ? summary.topDefectClasses : []).map((row) => ({
    class: row.class,
    count: row.count,
  }));
  const out = {
    projectId: textOf(atlas.projectId),
    generatedAt: textOf(atlas.generatedAt),
    goals,
    timeline,
    conflicts,
    keyDecisions,
    defectGenes,
    summary: {
      activeGoals: summary.activeGoals,
      achieved: summary.achieved,
      abandoned: summary.abandoned,
      openConflicts: summary.openConflicts,
      topDefectClasses: topDefectRows,
      highImpactDecisions: summary.highImpactDecisions,
    },
    driftFlags: Array.isArray(atlas.driftFlags) ? [...atlas.driftFlags] : [],
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** 空总览(store 首次 build 前的兜底;generatedAt 同样缺省用固定常量,不取真实时钟)。 */
export function emptyAtlas(projectId: string, now?: string): DirectionAtlas {
  const nowText = nonEmptyText(now);
  return {
    projectId: textOf(projectId),
    generatedAt: nowText !== undefined && timeOf(nowText) !== undefined ? nowText : ATLAS_DEFAULT_NOW,
    goals: [],
    timeline: [],
    conflicts: [],
    keyDecisions: [],
    defectGenes: [],
    summary: emptySummary(),
    driftFlags: [],
  };
}
