/**
 * 漏点预防路由(Gap Taxonomy):把 #210 缺陷血缘给出的 missedLink 七类漏点,
 * 路由到「防复发预防件」(context / gate / tool 三形态),并指明应在哪一个交付节点之前注入。
 * 为什么要单独一层:
 * - 缺陷只回答「漏了哪道防线」,不回答「下次怎么不错」。缺了中转层,修复动作会退化成
 *   「记一条 note」,同一类漏点在下一个任务里原样复发。
 * - 预防件有成本差(context 最便宜、gate 次之、tool 最贵),必须先按成本排序再按置信度取舍,
 *   否则默认推荐最贵的一档,没人执行 = 等于没有预防件。
 * - 注入点(pre-requirement/pre-plan/pre-write/pre-verify/pre-close)必须显式落到交付节点之前,
 *   事后补的检查只能算发现,不能算预防。
 * 纯逻辑:零 IO(不读文件 / 网络 / 环境 / 真实时钟),不依赖 defect-lineage 的实现,
 * 只沿用它的 MissedLink 字面量口径(此处以 GapCategory 表达,不含 "none")。
 * 所有导出函数同步且不抛异常:非法输入返回安全空值并带稳定码(GAP_CODES)。
 */

/** 分类法 schema 版本:字段语义变化时递增,读取方据此迁移。 */
export const GAP_TAXONOMY_VERSION = 1;

/**
 * 漏点七类(与 defect-lineage 的 MissedLink 一一对应,去掉 "none"):
 * requirement=需求理解,plan-coverage=计划覆盖,verification-coverage=验证覆盖,
 * knowledge-gap=知识缺失,tool-gap=工具缺失,wrong-assumption=错误假设,impact-analysis=影响面缺失。
 */
export const GAP_CATEGORIES = [
  "requirement",
  "plan-coverage",
  "verification-coverage",
  "knowledge-gap",
  "tool-gap",
  "wrong-assumption",
  "impact-analysis",
] as const;

export type GapCategory = (typeof GAP_CATEGORIES)[number];

/** 预防件形态,成本递增:context(注入信息) < gate(阻断门) < tool(固化成工具)。 */
export const PREVENTION_FORMS = ["context", "gate", "tool"] as const;

export type PreventionForm = (typeof PREVENTION_FORMS)[number];

/** 注入点:预防件必须在这些交付节点「之前」生效。 */
export const INJECTION_POINTS = ["pre-requirement", "pre-plan", "pre-write", "pre-verify", "pre-close"] as const;

export type InjectionPoint = (typeof INJECTION_POINTS)[number];

/** 稳定码:调用方按码分支,不解析文案。 */
export const GAP_CODES = {
  ROUTED: "GAP_ROUTED",
  NO_MATCH: "GAP_NO_MATCH",
  CATEGORY_NONE: "GAP_CATEGORY_NONE",
} as const;

export type GapCode = (typeof GAP_CODES)[keyof typeof GAP_CODES];

/** 形态成本:排序与「为什么推荐便宜档」的唯一依据。 */
export const FORM_COST: Record<PreventionForm, number> = { context: 0, gate: 1, tool: 2 };

/** 一条预防件:谁(id)、治哪类漏点(gapCategory)、什么形态(form)、载体与话术、何时注入、何时失效。 */
export interface PreventionEntry {
  id: string;
  gapCategory: GapCategory;
  form: PreventionForm;
  carrier: string;
  injectionPoint: InjectionPoint;
  guidance: string;
  trigger: {
    module?: string;
    boardType?: string;
    taskClass?: string;
    decisionNode?: string;
    textPattern?: string;
  };
  confidence: number;
  overfitRisk: "low" | "medium" | "high";
  sourceDefectIds: string[];
  createdAt: number;
  expiresAt?: number;
}

/** 路由输入:一次交付的上下文片段(缺字段即视为该字段不参与命中)。 */
export interface RouteInput {
  missedLink: string;
  module?: string;
  boardType?: string;
  taskClass?: string;
  decisionNode?: string;
  text?: string;
  defectId?: string;
}

/** 一次历史取舍记录:推荐过哪一档、是否被采纳、是否又被回滚。 */
export interface DecisionRecord {
  form: PreventionForm;
  adopted?: boolean;
  reverted?: boolean;
}

/** 路由结果:命中的预防件 + 稳定码 + 人读的命中理由 + 推荐形态。 */
export interface RouteResult {
  routed: PreventionEntry[];
  codes: GapCode[];
  matchReasons: string[];
  recommendedForm: PreventionForm;
}

/** 默认条目统一创建时间(固定常量,不读真实时钟)。 */
const DEFAULT_CREATED_AT = 1_700_000_000_000;

/** 触发字段(严格相等比较的四项)。 */
const TRIGGER_FIELDS = ["module", "boardType", "taskClass", "decisionNode"] as const;

type TriggerField = (typeof TRIGGER_FIELDS)[number];

/** overfitRisk 排序:high > medium > low。 */
const OVERFIT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

/** 置信度上限:再多的佐证缺陷也不把一条经验教训推到 100%。 */
const CONFIDENCE_CEILING = 0.9;

/** 置信度缺省基准(历史数据里没写 confidence 时按「传闻级」处理)。 */
const CONFIDENCE_BASE_FALLBACK = 0.5;

/** statement 截断长度上限(graph 节点 statement 的硬上限)。 */
const STATEMENT_LIMIT = 120;

/** 默认分类法:七类各两条(context + gate/tool),每类至少一条 trigger 全空(通配)条目。 */
export const DEFAULT_TAXONOMY: PreventionEntry[] = [
  {
    id: "req-context-questions",
    gapCategory: "requirement",
    form: "context",
    carrier: "开工画像",
    injectionPoint: "pre-requirement",
    guidance: "开工画像补问:目标/非目标/潜在需求三问",
    trigger: {},
    confidence: 0.6,
    overfitRisk: "low",
    sourceDefectIds: [],
    createdAt: DEFAULT_CREATED_AT,
  },
  {
    id: "req-gate-brief",
    gapCategory: "requirement",
    form: "gate",
    carrier: "需求 brief",
    injectionPoint: "pre-requirement",
    guidance: "需求 brief 必写目标模块与非目标",
    trigger: {},
    confidence: 0.65,
    overfitRisk: "medium",
    sourceDefectIds: [],
    createdAt: DEFAULT_CREATED_AT,
  },
  {
    id: "plan-context-history",
    gapCategory: "plan-coverage",
    form: "context",
    carrier: "历史板 accept",
    injectionPoint: "pre-plan",
    guidance: "检索同板型历史 P0 accept",
    trigger: { boardType: "code" },
    confidence: 0.6,
    overfitRisk: "low",
    sourceDefectIds: [],
    createdAt: DEFAULT_CREATED_AT,
  },
  {
    id: "plan-gate-accept-template",
    gapCategory: "plan-coverage",
    form: "gate",
    carrier: "板型 P0 accept 模板",
    injectionPoint: "pre-plan",
    guidance: "板型 P0 accept 模板必须含目标模块场景",
    trigger: {},
    confidence: 0.65,
    overfitRisk: "medium",
    sourceDefectIds: [],
    createdAt: DEFAULT_CREATED_AT,
  },
  {
    id: "verify-context-musttest",
    gapCategory: "verification-coverage",
    form: "context",
    carrier: "同模块必测清单",
    injectionPoint: "pre-verify",
    guidance: "注入同模块必测清单",
    trigger: { taskClass: "coding" },
    confidence: 0.6,
    overfitRisk: "low",
    sourceDefectIds: [],
    createdAt: DEFAULT_CREATED_AT,
  },
  {
    id: "verify-gate-affected-tests",
    gapCategory: "verification-coverage",
    form: "gate",
    carrier: "verify recipe",
    injectionPoint: "pre-verify",
    guidance: "verify 必须跑受影响测试文件清单",
    trigger: {},
    confidence: 0.65,
    overfitRisk: "medium",
    sourceDefectIds: [],
    createdAt: DEFAULT_CREATED_AT,
  },
  {
    id: "knowledge-context-reading-pack",
    gapCategory: "knowledge-gap",
    form: "context",
    carrier: "模块阅读包",
    injectionPoint: "pre-requirement",
    guidance: "注入模块阅读包/方向总览/图谱事实",
    trigger: {},
    confidence: 0.6,
    overfitRisk: "low",
    sourceDefectIds: [],
    createdAt: DEFAULT_CREATED_AT,
  },
  {
    id: "knowledge-gate-read-first",
    gapCategory: "knowledge-gap",
    form: "gate",
    carrier: "模块阅读包",
    injectionPoint: "pre-write",
    guidance: "先读模块阅读包再实施",
    trigger: {},
    confidence: 0.6,
    overfitRisk: "medium",
    sourceDefectIds: [],
    createdAt: DEFAULT_CREATED_AT,
  },
  {
    id: "tool-context-foundry",
    gapCategory: "tool-gap",
    form: "context",
    carrier: "Tool Foundry 候选",
    injectionPoint: "pre-close",
    guidance: "Tool Foundry 候选登记:把重复手工检查记为候选",
    trigger: {},
    confidence: 0.55,
    overfitRisk: "low",
    sourceDefectIds: [],
    createdAt: DEFAULT_CREATED_AT,
  },
  {
    id: "tool-tool-checker",
    gapCategory: "tool-gap",
    form: "tool",
    carrier: "校验器",
    injectionPoint: "pre-verify",
    guidance: "把检查固化为校验器(repo 脚本/CI)",
    trigger: {},
    confidence: 0.7,
    overfitRisk: "low",
    sourceDefectIds: [],
    createdAt: DEFAULT_CREATED_AT,
  },
  {
    id: "assumption-context-tips",
    gapCategory: "wrong-assumption",
    form: "context",
    carrier: "Tips 模板",
    injectionPoint: "pre-plan",
    guidance: "Tips 假设验证检查点模板",
    trigger: {},
    confidence: 0.6,
    overfitRisk: "low",
    sourceDefectIds: [],
    createdAt: DEFAULT_CREATED_AT,
  },
  {
    id: "assumption-gate-dryrun",
    gapCategory: "wrong-assumption",
    form: "gate",
    carrier: "dry-run 证据",
    injectionPoint: "pre-write",
    guidance: "假设变更需 dry-run 证据",
    trigger: {},
    confidence: 0.6,
    overfitRisk: "medium",
    sourceDefectIds: [],
    createdAt: DEFAULT_CREATED_AT,
  },
  {
    id: "impact-context-change-surface",
    gapCategory: "impact-analysis",
    form: "context",
    carrier: "全链路变更门清单",
    injectionPoint: "pre-plan",
    guidance: "全链路变更门清单检索",
    trigger: {},
    confidence: 0.6,
    overfitRisk: "low",
    sourceDefectIds: [],
    createdAt: DEFAULT_CREATED_AT,
  },
  {
    id: "impact-gate-callers",
    gapCategory: "impact-analysis",
    form: "gate",
    carrier: "code-sense impact",
    injectionPoint: "pre-write",
    guidance: "改签名前列出全部 caller(code-sense impact)",
    trigger: {},
    confidence: 0.7,
    overfitRisk: "medium",
    sourceDefectIds: [],
    createdAt: DEFAULT_CREATED_AT,
  },
];

/** 垃圾入参兜底:需要返回 PreventionEntry 但又没有可用入参时用。 */
const FALLBACK_ENTRY: PreventionEntry = {
  id: "unknown",
  gapCategory: "requirement",
  form: "context",
  carrier: "",
  injectionPoint: "pre-requirement",
  guidance: "",
  trigger: {},
  confidence: CONFIDENCE_BASE_FALLBACK,
  overfitRisk: "low",
  sourceDefectIds: [],
  createdAt: 0,
};

// ------------------------------------------------------------------ 内部工具

export function isGapCategory(v: unknown): v is GapCategory {
  return typeof v === "string" && (GAP_CATEGORIES as readonly string[]).includes(v);
}

function findForm(v: unknown): PreventionForm | undefined {
  return typeof v === "string" && (PREVENTION_FORMS as readonly string[]).includes(v)
    ? (v as PreventionForm)
    : undefined;
}

function findInjectionPoint(v: unknown): InjectionPoint | undefined {
  return typeof v === "string" && (INJECTION_POINTS as readonly string[]).includes(v)
    ? (v as InjectionPoint)
    : undefined;
}

function formCost(v: unknown): number {
  const form = findForm(v);
  return form === undefined ? PREVENTION_FORMS.length : FORM_COST[form];
}

/** 置信度归一:非有限数一律按 0.5(「传闻级」)处理。 */
function normalizeConfidence(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : CONFIDENCE_BASE_FALLBACK;
}

/** 只接受有字符串 id 的对象,避免脏数据把排序/合并搞崩。 */
function isEntryShape(v: unknown): v is PreventionEntry {
  return typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string";
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function riskRank(v: unknown): number {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(OVERFIT_RANK, v)
    ? (OVERFIT_RANK[v] as number)
    : -1;
}

function normalizeRisk(v: unknown): PreventionEntry["overfitRisk"] {
  return riskRank(v) >= 0 ? (v as PreventionEntry["overfitRisk"]) : "low";
}

function higherRisk(a: unknown, b: unknown): PreventionEntry["overfitRisk"] {
  return riskRank(b) > riskRank(a) ? normalizeRisk(b) : normalizeRisk(a);
}

function earliestExpiry(a: unknown, b: unknown): number | undefined {
  const values: number[] = [];
  for (const v of [a, b]) {
    if (typeof v === "number" && Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) return undefined;
  return Math.min(...values);
}

function uniqueStrings(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** 排序口径:形态成本升序 → 同形态 confidence 降序 → id 升序(稳定、可复现)。 */
function compareEntries(a: PreventionEntry, b: PreventionEntry): number {
  const byCost = formCost(a.form) - formCost(b.form);
  if (byCost !== 0) return byCost;
  const byConfidence = normalizeConfidence(b.confidence) - normalizeConfidence(a.confidence);
  if (byConfidence !== 0) return byConfidence;
  const left = asString(a.id);
  const right = asString(b.id);
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedByCost(list: PreventionEntry[]): PreventionEntry[] {
  return list.slice().sort(compareEntries);
}

/** 浅拷贝:任何对外返回的条目都不与调用方共享可变引用。 */
function cloneEntry(entry: PreventionEntry): PreventionEntry {
  const clone: PreventionEntry = {
    ...entry,
    trigger: { ...(entry.trigger ?? {}) },
    sourceDefectIds: Array.isArray(entry.sourceDefectIds) ? uniqueStrings(entry.sourceDefectIds) : [],
  };
  return clone;
}

function isWildcardEntry(entry: PreventionEntry): boolean {
  const trigger = entry.trigger;
  if (typeof trigger !== "object" || trigger === null) return true;
  for (const field of TRIGGER_FIELDS) {
    if (trigger[field] !== undefined) return false;
  }
  return trigger.textPattern === undefined;
}

/** 正则优先、非法正则降级字面 includes:宁可靠子串匹配保留一点召回,也不要抛。 */
function testTextPattern(pattern: unknown, text: string): boolean {
  if (typeof pattern !== "string") return false;
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return text.includes(pattern);
  }
}

interface TriggerMatch {
  field: TriggerField | "textPattern" | "wildcard";
  value: string;
}

/** 触发判定:trigger 里出现的字段必须与 input 严格相等(缺字段即不命中);trigger 全空=通配。 */
function matchTrigger(entry: PreventionEntry, input: RouteInput): TriggerMatch | undefined {
  const trigger = entry.trigger;
  if (trigger !== undefined && trigger !== null && typeof trigger !== "object") return undefined;
  const spec = (trigger ?? {}) as PreventionEntry["trigger"];
  let matched: TriggerMatch | undefined;
  for (const field of TRIGGER_FIELDS) {
    const expected = spec[field];
    if (expected === undefined) continue;
    const actual = input[field];
    if (actual === undefined || actual !== expected) return undefined;
    if (matched === undefined) matched = { field, value: asString(expected) };
  }
  if (spec.textPattern !== undefined) {
    if (typeof input.text !== "string") return undefined;
    if (!testTextPattern(spec.textPattern, input.text)) return undefined;
    if (matched === undefined) matched = { field: "textPattern", value: asString(spec.textPattern) };
  }
  return matched ?? { field: "wildcard", value: "*" };
}

function noneResult(why: string): RouteResult {
  return {
    routed: [],
    codes: [GAP_CODES.CATEGORY_NONE],
    matchReasons: [`category-none:${why}`],
    recommendedForm: "context",
  };
}

/** 截断到 STATEMENT_LIMIT 个码点(避免把代理对截半)。 */
function truncate(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit).join("");
}

function roundConfidence(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// ------------------------------------------------------------------ 选择

/**
 * 按形态成本与置信度挑选某个漏点的预防件。
 * - 排序:form 成本升序 → 同 form confidence 降序 → id 升序;
 * - prefer:指定形态整体提到最前(其余相对顺序不变);
 * - maxEntries:截断;非法 category 或无条目 → []。
 */
export function selectPrevention(
  category: GapCategory | string,
  opts?: { prefer?: PreventionForm; maxEntries?: number; entries?: PreventionEntry[] },
): PreventionEntry[] {
  try {
    if (!isGapCategory(category)) return [];
    const source = Array.isArray(opts?.entries) ? (opts?.entries as PreventionEntry[]) : DEFAULT_TAXONOMY;
    const pool = source.filter((entry) => isEntryShape(entry) && entry.gapCategory === category);
    const ordered = sortedByCost(pool);
    const preferForm = findForm(opts?.prefer);
    const arranged =
      preferForm === undefined
        ? ordered
        : [
            ...ordered.filter((entry) => findForm(entry.form) === preferForm),
            ...ordered.filter((entry) => findForm(entry.form) !== preferForm),
          ];
    const max = opts?.maxEntries;
    if (typeof max === "number" && Number.isFinite(max) && max >= 0) {
      return arranged.slice(0, Math.floor(max));
    }
    return arranged;
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ 路由

/**
 * 把一条 missedLink 路由到预防件。
 * 命中口径:trigger 字段严格相等 + textPattern(正则/降级字面);trigger 全空的条目是通配条目,
 * 只在该类没有「受约束命中」时兜底使用(理由记为 generic:<id>)。
 * 可选第三参 entries 仅供自定义分类法/测试替换默认表,缺省用 DEFAULT_TAXONOMY。
 */
export function routeGap(
  input: RouteInput,
  decisions?: DecisionRecord[],
  entries?: PreventionEntry[],
): RouteResult {
  try {
    return routeGapInternal(input, decisions, entries);
  } catch {
    return noneResult("error");
  }
}

function routeGapInternal(
  input: RouteInput,
  decisions?: DecisionRecord[],
  entries?: PreventionEntry[],
): RouteResult {
  const raw = (input ?? {}) as RouteInput;
  const missed = (raw as { missedLink?: unknown }).missedLink;
  if (typeof missed !== "string") return noneResult("missing");
  if (missed === "none") return noneResult("none");
  if (!isGapCategory(missed)) return noneResult(`invalid:${missed}`);

  const category: GapCategory = missed;
  const history = Array.isArray(decisions) ? decisions : undefined;
  const recommendedForm: PreventionForm =
    history === undefined ? "context" : recommendForm(category, { history });

  const source = Array.isArray(entries) ? entries.filter(isEntryShape) : DEFAULT_TAXONOMY;
  const pool = source.filter((entry) => entry.gapCategory === category);
  if (pool.length === 0) {
    return {
      routed: [],
      codes: [GAP_CODES.NO_MATCH],
      matchReasons: [`no-entry:${category}`],
      recommendedForm,
    };
  }

  const constrained: { entry: PreventionEntry; match: TriggerMatch }[] = [];
  const wildcards: PreventionEntry[] = [];
  for (const entry of pool) {
    const match = matchTrigger(entry, raw);
    if (match === undefined) continue;
    if (match.field === "wildcard") wildcards.push(entry);
    else constrained.push({ entry, match });
  }

  const reasonById = new Map<string, string>();
  for (const hit of constrained) {
    reasonById.set(hit.entry.id, `trigger-hit:${hit.entry.id}:${hit.match.field}=${hit.match.value}`);
  }
  for (const entry of wildcards) {
    if (!reasonById.has(entry.id)) reasonById.set(entry.id, `generic:${entry.id}`);
  }

  if (constrained.length > 0) {
    const routed = sortedByCost([...constrained.map((hit) => hit.entry), ...wildcards]);
    return {
      routed,
      codes: [GAP_CODES.ROUTED],
      matchReasons: routed.map((entry) => reasonById.get(entry.id) ?? `trigger-hit:${entry.id}:wildcard=*`),
      recommendedForm,
    };
  }

  if (wildcards.length > 0) {
    const routed = sortedByCost(wildcards);
    return {
      routed,
      codes: [GAP_CODES.ROUTED],
      matchReasons: routed.map((entry) => `generic:${entry.id}`),
      recommendedForm,
    };
  }

  const fallback = selectPrevention(category, { entries: pool });
  return {
    routed: fallback,
    codes: [GAP_CODES.ROUTED],
    matchReasons: fallback.map((entry) => `generic:${entry.id}`),
    recommendedForm,
  };
}

// ------------------------------------------------------------------ 合并 / 调权

function mergePair(first: PreventionEntry, next: PreventionEntry): PreventionEntry {
  const merged: PreventionEntry = {
    ...first,
    trigger: { ...(first.trigger ?? {}) },
    confidence: Math.max(normalizeConfidence(first.confidence), normalizeConfidence(next.confidence)),
    overfitRisk: higherRisk(first.overfitRisk, next.overfitRisk),
    sourceDefectIds: uniqueStrings([
      ...(Array.isArray(first.sourceDefectIds) ? first.sourceDefectIds : []),
      ...(Array.isArray(next.sourceDefectIds) ? next.sourceDefectIds : []),
    ]),
  };
  const expiry = earliestExpiry(first.expiresAt, next.expiresAt);
  if (expiry !== undefined) merged.expiresAt = expiry;
  else delete merged.expiresAt;
  return merged;
}

/**
 * 合并同一 gapCategory+form+carrier 的条目:
 * 保留首条的 id/injectionPoint/trigger/createdAt(以及话术),confidence 取 max,
 * sourceDefectIds 取并集,overfitRisk 取更高,expiresAt 取更早。
 */
export function mergeRouting(entries: PreventionEntry[]): PreventionEntry[] {
  try {
    if (!Array.isArray(entries)) return [];
    const out: PreventionEntry[] = [];
    const index = new Map<string, number>();
    for (const entry of entries) {
      if (!isEntryShape(entry)) continue;
      const key = `${asString(entry.gapCategory)}|${asString(entry.form)}|${asString(entry.carrier)}`;
      const at = index.get(key);
      if (at === undefined) {
        index.set(key, out.length);
        out.push(cloneEntry(entry));
        continue;
      }
      const current = out[at];
      if (current === undefined) continue;
      out[at] = mergePair(current, entry);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 佐证调权:confidence = min(0.9, base + 0.1*defects),base 缺省 0.5。
 * 返回新对象(不改入参),非法入参也返回安全条目而不是抛。
 */
export function bumpConfidence(entry: PreventionEntry, corroboratingDefects: number): PreventionEntry {
  try {
    const rawEntry = entry as unknown as { confidence?: unknown } | null | undefined;
    const base = normalizeConfidence(rawEntry?.confidence);
    const defects =
      typeof corroboratingDefects === "number" && Number.isFinite(corroboratingDefects)
        ? Math.max(0, corroboratingDefects)
        : 0;
    const confidence = roundConfidence(Math.min(CONFIDENCE_CEILING, base + 0.1 * defects));
    if (!isEntryShape(entry)) {
      return { ...FALLBACK_ENTRY, trigger: {}, sourceDefectIds: [], confidence };
    }
    const bumped = cloneEntry(entry);
    bumped.confidence = confidence;
    return bumped;
  } catch {
    return { ...FALLBACK_ENTRY, trigger: {}, sourceDefectIds: [] };
  }
}

/**
 * 推荐形态(缺省 context,因为最贵的一档没人执行就等于没有预防件):
 * - gate 历史回滚占比 >50%(样本 ≥2)→ 降级 context;
 * - 历史里出现过 tool 且 adopted,且 tool 回滚占比 ≤50% → 升到 tool;
 * - 其余一律 context。
 */
export function recommendForm(
  category: GapCategory,
  opts?: { history?: DecisionRecord[] },
): PreventionForm {
  try {
    if (!isGapCategory(category)) return "context";
    const raw = opts?.history;
    const history: DecisionRecord[] = Array.isArray(raw) ? raw.filter(isDecisionRecord) : [];

    const gates = history.filter((record) => record.form === "gate");
    if (gates.length >= 2) {
      const reverted = gates.filter((record) => record.reverted === true).length;
      if (reverted / gates.length > 0.5) return "context";
    }

    const tools = history.filter((record) => record.form === "tool");
    if (tools.length > 0) {
      const adopted = tools.some((record) => record.adopted === true);
      const revertedRatio = tools.filter((record) => record.reverted === true).length / tools.length;
      if (adopted && revertedRatio <= 0.5) return "tool";
    }

    return "context";
  } catch {
    return "context";
  }
}

function isDecisionRecord(v: unknown): v is DecisionRecord {
  return typeof v === "object" && v !== null && findForm((v as { form?: unknown }).form) !== undefined;
}

// ------------------------------------------------------------------ 落地

/**
 * 按注入点落地:只取该注入点的条目,按 form 分组成可注入的三类文本;
 * guidance 同组内去重且保持入参顺序。
 */
export function applyAt(
  entries: PreventionEntry[],
  injectionPoint: InjectionPoint): { contextBlocks: string[]; gates: string[]; toolChecks: string[] } {
  const empty = { contextBlocks: [] as string[], gates: [] as string[], toolChecks: [] as string[] };
  try {
    if (!Array.isArray(entries)) return empty;
    const target = findInjectionPoint(injectionPoint);
    if (target === undefined) return empty;
    const buckets: Record<PreventionForm, string[]> = { context: [], gate: [], tool: [] };
    for (const entry of entries) {
      if (!isEntryShape(entry)) continue;
      if (findInjectionPoint(entry.injectionPoint) !== target) continue;
      const form = findForm(entry.form);
      if (form === undefined) continue;
      const guidance = asString(entry.guidance);
      if (guidance.length === 0) continue;
      if (!buckets[form].includes(guidance)) buckets[form].push(guidance);
    }
    return { contextBlocks: buckets.context, gates: buckets.gate, toolChecks: buckets.tool };
  } catch {
    return empty;
  }
}

/** 过期切分:expiresAt 有限且 <= now 视为过期;无 expiresAt 的条目恒 active。 */
export function expireEntries(
  entries: PreventionEntry[],
  now: number): { active: PreventionEntry[]; expired: PreventionEntry[] } {
  const active: PreventionEntry[] = [];
  const expired: PreventionEntry[] = [];
  try {
    if (!Array.isArray(entries)) return { active, expired };
    const nowMs = typeof now === "number" && Number.isFinite(now) ? now : Number.NaN;
    for (const entry of entries) {
      if (!isEntryShape(entry)) continue;
      const expiresAt = (entry as { expiresAt?: unknown }).expiresAt;
      if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= nowMs) expired.push(entry);
      else active.push(entry);
    }
  } catch {
    return { active: [], expired: [] };
  }
  return { active, expired };
}

/**
 * 投影为方向型图谱节点(供证据图谱消费):statement = carrier:guidance(≤120 字符),
 * associations 来自 trigger.module / trigger.decisionNode,source.note 保留条目 id;
 * 输出顺序与 selectPrevention 一致(形态成本 → confidence)。
 */
export function toGraphNodes(entries: PreventionEntry[]): {
  kind: "direction";
  statement: string;
  associations: { type: "module" | "decision"; ref: string }[];
  confidence: number;
  source: { note: string };
}[] {
  try {
    if (!Array.isArray(entries)) return [];
    return sortedByCost(entries.filter(isEntryShape)).map((entry) => {
      const trigger = (entry.trigger ?? {}) as PreventionEntry["trigger"];
      const associations: { type: "module" | "decision"; ref: string }[] = [];
      if (typeof trigger.module === "string" && trigger.module.length > 0) {
        associations.push({ type: "module", ref: trigger.module });
      }
      if (typeof trigger.decisionNode === "string" && trigger.decisionNode.length > 0) {
        associations.push({ type: "decision", ref: trigger.decisionNode });
      }
      return {
        kind: "direction" as const,
        statement: truncate(`${asString(entry.carrier)}:${asString(entry.guidance)}`, STATEMENT_LIMIT),
        associations,
        confidence: normalizeConfidence(entry.confidence),
        source: { note: `gap-prevention:${asString(entry.id)}` },
      };
    });
  } catch {
    return [];
  }
}
