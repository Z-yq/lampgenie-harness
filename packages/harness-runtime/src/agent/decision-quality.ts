/**
 * 决策质量(Decision Quality):把 agent 的「一次决策」记录成可聚类样本,
 * 再把样本压成 anti-pattern / efficient-pattern 两类结论,供知识库与迁移验证消费。
 * 为什么要单独一层,而不是直接从日志里数失败次数:
 * - 失败次数多不代表可沉淀规律:failure 里混着环境抖动(environment-noise)与需求变更
 *   (requirement-change),这两类再怎么复现也推不出「下次别这么选」。所以先做归因过滤,
 *   只有 decision-error 才允许升格成 anti-pattern,其余只留成 observation 供人看。
 * - 「同一个选择」必须可比:直接比 choice 原文会把 `Edit(src/a.ts)` 与
 *   `edit src/a.ts` 当成两条,所以统一走 choiceSignature(type + token 集 + 是否失败类)做聚类键。
 * - 「值不值得写成库」不是看单次,而是看跨实体(项目 ∪ 模型)复现 + 回放验证 + 迁移验证,
 *   三级门槛各管一件事,promote 每次只升一级,避免一次跳级把噪声写进库。
 * 纯逻辑:零 IO(不读文件 / 网络 / 环境 / 真实时钟)。时间一律 epoch ms 数字,
 * 任何需要"现在"的地方都可注入 opts.now / opts.at(仅 aggregate 缺省回落到 Date.now())。
 * 所有导出函数不抛异常:非法输入返回安全空值并带稳定码(DECISION_QUALITY_CODES),调用方据此降级。
 */

/** 决策质量 schema 版本:字段语义变化时递增,读取方据此迁移。 */
export const DECISION_QUALITY_VERSION = 1;

/** 决策类别:一步 agent 动作对应哪个层面的判断(选工具 / 排计划 / 改代码 / 验收 / 委派 / 压缩 / 取上下文)。 */
export type DecisionType = "tool-choice" | "plan" | "edit" | "verify" | "delegate" | "compact" | "context";

/** 决策类别全集:校验与遍历共用一份,避免两处口径漂移。 */
export const DECISION_TYPES: readonly DecisionType[] = [
  "tool-choice",
  "plan",
  "edit",
  "verify",
  "delegate",
  "compact",
  "context",
];

/** 单次决策结果:success=达成;failure=失败;retry=重来;waste=白做(有产出但被丢弃);timeout=超时。 */
export type DecisionOutcome = "success" | "failure" | "retry" | "waste" | "timeout";

const DECISION_OUTCOMES: readonly DecisionOutcome[] = ["success", "failure", "retry", "waste", "timeout"];

/** 失败类 outcome:除 success 外的四类,证据必填,且签名里带 "!"。 */
const FAILURE_OUTCOMES: readonly DecisionOutcome[] = ["failure", "retry", "waste", "timeout"];

/** 可避免性:decision-error=当时就能做对;environment-noise=外部抖动;requirement-change=需求变了;unknown=判不了。 */
export type Avoidability = "decision-error" | "environment-noise" | "requirement-change" | "unknown";

const AVOIDABILITIES: readonly Avoidability[] = [
  "decision-error",
  "environment-noise",
  "requirement-change",
  "unknown",
];

/** 样本来源:session=会话内自采;defect-lineage=由缺陷血缘回连出来;human-correction=人工纠正。 */
export type DecisionSource = "session" | "defect-lineage" | "human-correction";

const DECISION_SOURCES: readonly DecisionSource[] = ["session", "defect-lineage", "human-correction"];

/** 决策发生时的上下文:taskClass 必填,其余用于跨实体统计。 */
export interface DecisionContext {
  taskClass: string;
  model?: string;
  phase?: string;
  projectId?: string;
}

/** 决策代价:三档口径按 tokens → wallMs → toolCalls 依次比较(见 compareCost)。 */
export interface DecisionCost {
  tokens: number;
  wallMs: number;
  toolCalls: number;
}

/** 一条决策记录:事后可复盘的最小单元。 */
export interface DecisionRecord {
  id: string;
  sessionId: string;
  type: DecisionType;
  at: number;
  context: DecisionContext;
  choice: string;
  evidenceRefs: string[];
  outcome: DecisionOutcome;
  cost: DecisionCost;
  avoidability: Avoidability;
  source: DecisionSource;
  note?: string;
}

/** 模式级别:L0=候选簇;L1=跨实体复现;L2=回放验证过;L3=迁移验证过(可作结论)。 */
export type PatternLevel = "L0" | "L1" | "L2" | "L3";

const PATTERN_LEVELS: readonly PatternLevel[] = ["L0", "L1", "L2", "L3"];

/** 模式种类:anti-pattern=该避免的选择;efficient-pattern=更便宜的选择。 */
export type PatternKind = "anti-pattern" | "efficient-pattern";

/** 模式状态:observation=只登记不给结论;candidate=候选;library=已入知识库。 */
export type PatternStatus = "candidate" | "library" | "observation";

/** 模式实例:指向具体决策,并冗余上下文以便现场核对。 */
export interface PatternInstance {
  decisionId: string;
  projectId?: string;
  model?: string;
  taskClass?: string;
}

/** 分布:跨项目 / 跨模型 / 跨任务类的去重清单(undefined 跳过)。 */
export interface PatternDistribution {
  projects: string[];
  models: string[];
  taskClasses: string[];
}

/** 升阶证据:跨实体数、回放验证、迁移验证。 */
export interface PatternPromotion {
  crossEntityCount: number;
  replayValidated: boolean;
  transferTested: boolean;
}

/** 模式:聚类产物,也是知识库与证据图的唯一输入形态。 */
export interface Pattern {
  id: string;
  kind: PatternKind;
  level: PatternLevel;
  name: string;
  description: string;
  decisionType: DecisionType;
  choiceSignature: string;
  instances: PatternInstance[];
  frequency: number;
  distribution: PatternDistribution;
  confidence: number;
  status: PatternStatus;
  alternative?: string;
  promotion: PatternPromotion;
  updatedAt: number;
}

/** 稳定码:调用方按码分支,不解析文案。 */
export const DECISION_QUALITY_CODES = {
  INVALID: "DQ_INVALID",
  RECORDED: "DQ_RECORDED",
  EVIDENCE_REQUIRED: "DQ_EVIDENCE_REQUIRED",
  ENVIRONMENT_NOISE: "DQ_ENVIRONMENT_NOISE",
  PATTERN_CANDIDATE: "DQ_PATTERN_CANDIDATE",
  PATTERN_PROMOTED: "DQ_PATTERN_PROMOTED",
  LIBRARY_ADDED: "DQ_LIBRARY_ADDED",
  NOT_PROMOTABLE: "DQ_NOT_PROMOTABLE",
  NO_COUNTERFACTUAL: "DQ_NO_COUNTERFACTUAL",
  COUNTERFACTUAL_FOUND: "DQ_COUNTERFACTUAL_FOUND",
  HUMAN_CORRECTION: "DQ_HUMAN_CORRECTION",
} as const;

export type DecisionQualityCode = (typeof DECISION_QUALITY_CODES)[keyof typeof DECISION_QUALITY_CODES];

/** 稳定码全量清单:便于上游做「未知码」兜底与文档生成。 */
export const DECISION_QUALITY_CODE_LIST: readonly DecisionQualityCode[] = [
  DECISION_QUALITY_CODES.INVALID,
  DECISION_QUALITY_CODES.RECORDED,
  DECISION_QUALITY_CODES.EVIDENCE_REQUIRED,
  DECISION_QUALITY_CODES.ENVIRONMENT_NOISE,
  DECISION_QUALITY_CODES.PATTERN_CANDIDATE,
  DECISION_QUALITY_CODES.PATTERN_PROMOTED,
  DECISION_QUALITY_CODES.LIBRARY_ADDED,
  DECISION_QUALITY_CODES.NOT_PROMOTABLE,
  DECISION_QUALITY_CODES.NO_COUNTERFACTUAL,
  DECISION_QUALITY_CODES.COUNTERFACTUAL_FOUND,
  DECISION_QUALITY_CODES.HUMAN_CORRECTION,
];

// ------------------------------------------------------------------ 内部工具

/** 置信度上限:纯统计都不该自称"确定",封顶 0.9。 */
const CONFIDENCE_CAP = 0.9;
/** 置信度基数与每单位频率的增量。 */
const CONFIDENCE_BASE = 0.3;
const CONFIDENCE_STEP = 0.1;
/** 入知识库的最低置信度。 */
const LIBRARY_MIN_CONFIDENCE = 0.6;
/** 默认跨实体门槛:3 个独立实体(项目 ∪ 模型)才算可迁移。 */
const DEFAULT_MIN_CROSS_ENTITY = 3;
/** 签名 token 上限:超过 6 个的差别多半是参数噪声,不参与聚类键。 */
const MAX_SIGNATURE_TOKENS = 6;
/** 切分口径:非字母数字、非 CJK 一律当分隔符。 */
const TOKEN_SPLIT_RE = /[^0-9a-zA-Z\u4e00-\u9fff]+/;

/** 观察码:不属于「稳定码表」的旁路说明(记录被跳过 / 需求变更不升格)。 */
export type ObservationCode = DecisionQualityCode | "DQ_REQUIREMENT_CHANGE" | "DQ_SKIPPED_RECORD";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDecisionType(value: unknown): value is DecisionType {
  return typeof value === "string" && (DECISION_TYPES as readonly string[]).includes(value);
}

function isOutcome(value: unknown): value is DecisionOutcome {
  return typeof value === "string" && (DECISION_OUTCOMES as readonly string[]).includes(value);
}

function isFailureOutcome(outcome: DecisionOutcome): boolean {
  return FAILURE_OUTCOMES.includes(outcome);
}

function isAvoidability(value: unknown): value is Avoidability {
  return typeof value === "string" && (AVOIDABILITIES as readonly string[]).includes(value);
}

function isSource(value: unknown): value is DecisionSource {
  return typeof value === "string" && (DECISION_SOURCES as readonly string[]).includes(value);
}

function isPatternLevel(value: unknown): value is PatternLevel {
  return typeof value === "string" && (PATTERN_LEVELS as readonly string[]).includes(value);
}

/** FNV-1a 32 位:确定性短哈希,替代随机 id / Date.now。 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function readCost(value: unknown): DecisionCost | undefined {
  if (!isPlainObject(value)) return undefined;
  const tokens = value["tokens"];
  const wallMs = value["wallMs"];
  const toolCalls = value["toolCalls"];
  if (!isFiniteNumber(tokens) || !isFiniteNumber(wallMs) || !isFiniteNumber(toolCalls)) return undefined;
  return { tokens, wallMs, toolCalls };
}

function readEvidenceRefs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    refs.push(item);
  }
  return refs;
}

function readContext(value: unknown): DecisionContext | undefined {
  if (!isPlainObject(value)) return undefined;
  const taskClass = value["taskClass"];
  if (!isNonEmptyString(taskClass)) return undefined;
  const context: DecisionContext = { taskClass };
  if (isNonEmptyString(value["model"])) context.model = value["model"];
  if (isNonEmptyString(value["phase"])) context.phase = value["phase"];
  if (isNonEmptyString(value["projectId"])) context.projectId = value["projectId"];
  return context;
}

function readOptionalNote(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 只读校验一条决策记录:核心字段必须合法,否则整条跳过(不猜)。 */
function readRecord(value: unknown): DecisionRecord | undefined {
  if (!isPlainObject(value)) return undefined;
  const id = value["id"];
  const sessionId = value["sessionId"];
  const type = value["type"];
  const choice = value["choice"];
  const outcome = value["outcome"];
  const evidenceRefs = readEvidenceRefs(value["evidenceRefs"]);
  const cost = readCost(value["cost"]);
  const context = readContext(value["context"]);
  if (!isNonEmptyString(id) || !isNonEmptyString(sessionId)) return undefined;
  if (!isDecisionType(type) || !isNonEmptyString(choice) || !isOutcome(outcome)) return undefined;
  if (evidenceRefs === undefined || cost === undefined || context === undefined) return undefined;
  const avoidability = value["avoidability"];
  const source = value["source"];
  const at = value["at"];
  const record: DecisionRecord = {
    id,
    sessionId,
    type,
    at: isFiniteNumber(at) ? at : 0,
    context,
    choice,
    evidenceRefs,
    outcome,
    cost,
    avoidability: isAvoidability(avoidability) ? avoidability : "unknown",
    source: isSource(source) ? source : "session",
  };
  const note = readOptionalNote(value["note"]);
  if (note !== undefined) record.note = note;
  return record;
}

function cloneRecord(record: DecisionRecord): DecisionRecord {
  const clone: DecisionRecord = {
    ...record,
    context: { ...record.context },
    cost: { ...record.cost },
    evidenceRefs: [...record.evidenceRefs],
  };
  return clone;
}

// ------------------------------------------------------------------ 记录

export interface RecordDecisionOptions {
  at?: number;
}

export interface RecordDecisionResult {
  record?: DecisionRecord;
  codes: DecisionQualityCode[];
}

/**
 * 记一条决策。
 * - 结构非法(缺 sessionId/type/choice/outcome、evidenceRefs 非数组、cost 非数)→ DQ_INVALID,无 record。
 * - 失败类 outcome 且证据为空 → DQ_EVIDENCE_REQUIRED,无 record(没有证据的失败不许进样本池)。
 * - avoidability=environment-noise → record 保留,额外带 DQ_ENVIRONMENT_NOISE(它只用于观察,不升格)。
 * - id 缺省用确定性派生(dq-<sessionId>-<at>-<type>-<hash(choice)>),不用随机数也不用 Date.now。
 */
export function recordDecision(input: unknown, opts: RecordDecisionOptions = {}): RecordDecisionResult {
  if (!isPlainObject(input)) return { codes: [DECISION_QUALITY_CODES.INVALID] };

  const sessionId = input["sessionId"];
  const type = input["type"];
  const choice = input["choice"];
  const outcome = input["outcome"];
  const evidenceRefs = readEvidenceRefs(input["evidenceRefs"]);
  const cost = readCost(input["cost"]);
  const context = readContext(input["context"]);

  if (!isNonEmptyString(sessionId) || !isDecisionType(type) || !isNonEmptyString(choice) || !isOutcome(outcome)) {
    return { codes: [DECISION_QUALITY_CODES.INVALID] };
  }
  if (evidenceRefs === undefined || cost === undefined || context === undefined) {
    return { codes: [DECISION_QUALITY_CODES.INVALID] };
  }

  const rawAvoidability = input["avoidability"];
  if (rawAvoidability !== undefined && !isAvoidability(rawAvoidability)) {
    return { codes: [DECISION_QUALITY_CODES.INVALID] };
  }
  const rawSource = input["source"];
  if (rawSource !== undefined && !isSource(rawSource)) {
    return { codes: [DECISION_QUALITY_CODES.INVALID] };
  }

  if (isFailureOutcome(outcome) && evidenceRefs.length === 0) {
    return { codes: [DECISION_QUALITY_CODES.EVIDENCE_REQUIRED] };
  }

  const optsAt = isFiniteNumber(opts.at) ? opts.at : undefined;
  const rawAt = input["at"];
  const at = optsAt ?? (isFiniteNumber(rawAt) ? rawAt : 0);
  const rawId = input["id"];
  const id = isNonEmptyString(rawId) ? rawId : `dq-${sessionId}-${at}-${type}-${fnv1a(choice)}`;

  const record: DecisionRecord = {
    id,
    sessionId,
    type,
    at,
    context,
    choice,
    evidenceRefs,
    outcome,
    cost,
    avoidability: isAvoidability(rawAvoidability) ? rawAvoidability : "unknown",
    source: isSource(rawSource) ? rawSource : "session",
  };
  const note = readOptionalNote(input["note"]);
  if (note !== undefined) record.note = note;

  const codes: DecisionQualityCode[] = [DECISION_QUALITY_CODES.RECORDED];
  if (record.avoidability === "environment-noise") codes.push(DECISION_QUALITY_CODES.ENVIRONMENT_NOISE);
  return { record, codes };
}

// ------------------------------------------------------------------ 聚类键与权重

/**
 * 选择签名 = 聚类键。
 * 口径:choice 按「非字母数字且非 CJK」切分 → 小写 → 去重排序 → 取前 6 个用 "|" 连接,
 * 前缀 type,失败类 outcome 末尾加 "!"(同一选择的失败与成功必须是两个簇,不能混合统计)。
 */
export function choiceSignature(record: DecisionRecord): string {
  const tokens = new Set<string>();
  for (const raw of record.choice.split(TOKEN_SPLIT_RE)) {
    const token = raw.trim().toLowerCase();
    if (token.length > 0) tokens.add(token);
  }
  const key = [...tokens].sort().slice(0, MAX_SIGNATURE_TOKENS).join("|");
  const suffix = isFailureOutcome(record.outcome) ? "!" : "";
  return `${record.type}|${key}${suffix}`;
}

/** 样本权重:缺陷血缘 3 > 人工纠正 2 > 会话自采 1 > 未知来源 0(未知不参与频率,只留形迹)。 */
export function weightOf(source: DecisionSource | string | undefined): number {
  if (source === "defect-lineage") return 3;
  if (source === "human-correction") return 2;
  if (source === "session") return 1;
  return 0;
}

// ------------------------------------------------------------------ 代价口径

export type CostTuple = [number, number, number];

/** 代价元组固定顺序:tokens → wallMs → toolCalls。 */
export function costTuple(cost: DecisionCost): CostTuple {
  return [cost.tokens, cost.wallMs, cost.toolCalls];
}

/** 代价比较:依次比较 tokens → wallMs → toolCalls(前一项相同才看后一项),严格字典序。 */
export function compareCost(left: CostTuple, right: CostTuple): number {
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

// ------------------------------------------------------------------ 聚合

export interface AggregateOptions {
  now?: number;
}

export interface DecisionObservation {
  decisionId: string;
  code: ObservationCode;
  reason: string;
}

export interface AggregateResult {
  patterns: Pattern[];
  observations: DecisionObservation[];
  codes: DecisionQualityCode[];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    if (isNonEmptyString(value)) set.add(value);
  }
  return [...set].sort();
}

function crossEntityCountOf(instances: PatternInstance[]): number {
  const set = new Set<string>();
  for (const instance of instances) {
    if (isNonEmptyString(instance.projectId)) set.add(instance.projectId);
    if (isNonEmptyString(instance.model)) set.add(instance.model);
  }
  return set.size;
}

/** 同 type 下成功记录的中位代价(按 tokens → wallMs → toolCalls 字典序排序后取低位中位数)。 */
function medianCostByType(records: DecisionRecord[]): Map<DecisionType, CostTuple> {
  const grouped = new Map<DecisionType, CostTuple[]>();
  for (const record of records) {
    if (record.outcome !== "success") continue;
    const list = grouped.get(record.type) ?? [];
    list.push(costTuple(record.cost));
    grouped.set(record.type, list);
  }
  const medians = new Map<DecisionType, CostTuple>();
  for (const [type, list] of grouped) {
    const sorted = [...list].sort(compareCost);
    const median = sorted[Math.floor((sorted.length - 1) / 2)];
    if (median !== undefined) medians.set(type, median);
  }
  return medians;
}

function buildPattern(
  kind: PatternKind,
  signature: string,
  type: DecisionType,
  members: DecisionRecord[],
  now: number): Pattern {
  const instances: PatternInstance[] = members.map((record) => {
    const instance: PatternInstance = { decisionId: record.id };
    if (record.context.projectId !== undefined) instance.projectId = record.context.projectId;
    if (record.context.model !== undefined) instance.model = record.context.model;
    if (record.context.taskClass !== undefined) instance.taskClass = record.context.taskClass;
    return instance;
  });
  const frequency = members.reduce((sum, record) => sum + weightOf(record.source), 0);
  const distribution: PatternDistribution = {
    projects: uniqueStrings(members.map((record) => record.context.projectId)),
    models: uniqueStrings(members.map((record) => record.context.model)),
    taskClasses: uniqueStrings(members.map((record) => record.context.taskClass)),
  };
  // 置信度只看「加权频率」,封顶 0.9:全部是会话自采的单条样本(frequency=1)只有 0.4,天然低置信。
  const confidence = round2(Math.min(CONFIDENCE_CAP, CONFIDENCE_BASE + CONFIDENCE_STEP * frequency));
  const name = kind === "anti-pattern" ? `反复失败的选择 ${signature}` : `更省的选择 ${signature}`;
  const description =
    kind === "anti-pattern"
      ? `${type} 决策在签名 ${signature} 上多次落入 failure/retry/waste/timeout,且归因为 decision-error;样本 ${members.length} 条。`
      : `${type} 决策在签名 ${signature} 上的成功代价低于同 type 成功中位数;样本 ${members.length} 条。`;
  const pattern: Pattern = {
    id: `p-${fnv1a(`${signature}#${kind}`)}`,
    kind,
    level: "L0",
    name,
    description,
    decisionType: type,
    choiceSignature: signature,
    instances,
    frequency,
    distribution,
    confidence,
    status: "candidate",
    promotion: {
      crossEntityCount: crossEntityCountOf(instances),
      replayValidated: false,
      transferTested: false,
    },
    updatedAt: now,
  };
  return pattern;
}

/**
 * 聚合样本 → 候选模式 + 旁路观察。
 * - 聚类键 = choiceSignature。
 * - anti-pattern 只收 avoidability=decision-error 的失败类记录;environment-noise / requirement-change
 *   只写 observation(它们不改决策,升格只会污染库)。
 * - efficient-pattern 收 outcome=success 且代价严格低于同 type 成功中位数(口径 tokens → wallMs → toolCalls)。
 * - 全是会话自采且 frequency<2 的簇仍然产出候选(不丢样本),但 confidence 落在 0.4 以下。
 */
export function aggregate(records: unknown, opts: AggregateOptions = {}): AggregateResult {
  if (!Array.isArray(records)) {
    return { patterns: [], observations: [], codes: [DECISION_QUALITY_CODES.INVALID] };
  }
  const now = isFiniteNumber(opts.now) ? opts.now : Date.now();
  const valid: DecisionRecord[] = [];
  const observations: DecisionObservation[] = [];
  const codes = new Set<DecisionQualityCode>([DECISION_QUALITY_CODES.PATTERN_CANDIDATE]);

  for (const raw of records) {
    const record = readRecord(raw);
    if (record === undefined) {
      const id = isPlainObject(raw) && isNonEmptyString(raw["id"]) ? raw["id"] : "(unknown)";
      observations.push({
        decisionId: id,
        code: "DQ_SKIPPED_RECORD",
        reason: "记录结构非法,已跳过(缺必填字段 / evidenceRefs 非数组 / cost 非数)",
      });
      codes.add(DECISION_QUALITY_CODES.INVALID);
      continue;
    }
    if (record.avoidability === "environment-noise") {
      observations.push({
        decisionId: record.id,
        code: DECISION_QUALITY_CODES.ENVIRONMENT_NOISE,
        reason: "环境噪声:不进 anti-pattern,也不计入候选频率",
      });
    } else if (record.avoidability === "requirement-change") {
      observations.push({
        decisionId: record.id,
        code: "DQ_REQUIREMENT_CHANGE",
        reason: "需求变更:当时的正确选择已变,不进 anti-pattern",
      });
    }
    valid.push(record);
  }

  const medians = medianCostByType(valid);
  const clusters = new Map<string, { type: DecisionType; members: DecisionRecord[] }>();
  for (const record of valid) {
    const signature = choiceSignature(record);
    const cluster = clusters.get(signature) ?? { type: record.type, members: [] };
    cluster.members.push(record);
    clusters.set(signature, cluster);
  }

  const patterns: Pattern[] = [];
  for (const [signature, cluster] of clusters) {
    const antiMembers = cluster.members.filter(
      (record) => record.avoidability === "decision-error" && isFailureOutcome(record.outcome),
    );
    if (antiMembers.length > 0) {
      patterns.push(buildPattern("anti-pattern", signature, cluster.type, antiMembers, now));
    }
    const median = medians.get(cluster.type);
    const efficientMembers = cluster.members.filter((record) => {
      if (record.outcome !== "success" || median === undefined) return false;
      return compareCost(costTuple(record.cost), median) < 0;
    });
    if (efficientMembers.length > 0) {
      patterns.push(buildPattern("efficient-pattern", signature, cluster.type, efficientMembers, now));
    }
  }
  patterns.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  observations.sort((a, b) => (a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0));

  return { patterns, observations, codes: [...codes] };
}

// ------------------------------------------------------------------ 升阶与入库

export interface PromoteOptions {
  minCrossEntity?: number;
  replayValidated?: boolean;
  transferTested?: boolean;
}

export interface PromoteResult {
  pattern: Pattern;
  codes: DecisionQualityCode[];
  reason?: string;
}

function clonePattern(pattern: Pattern): Pattern {
  return {
    ...pattern,
    instances: pattern.instances.map((instance) => ({ ...instance })),
    distribution: {
      projects: [...pattern.distribution.projects],
      models: [...pattern.distribution.models],
      taskClasses: [...pattern.distribution.taskClasses],
    },
    promotion: { ...pattern.promotion },
  };
}

/**
 * 升一级,每次只升一级:
 * L0→L1 跨实体数(instances 的 project ∪ model 去重)≥ minCrossEntity(默认 3);
 * L1→L2 需 replayValidated===true;L2→L3 需 transferTested===true;L3 再调直接 NOT_PROMOTABLE。
 * 缺条件 → 原级别 + DQ_NOT_PROMOTABLE + reason;满足 → level+1 + DQ_PATTERN_PROMOTED 且 promotion 三字段同步。
 * 入参不被修改(返回克隆)。
 */
export function promote(pattern: unknown, opts: PromoteOptions = {}): PromoteResult {
  const source = isPlainObject(pattern) ? (pattern as unknown as Pattern) : undefined;
  if (source === undefined || !isPatternLevel(source.level) || !Array.isArray(source.instances)) {
    return {
      pattern: pattern as Pattern,
      codes: [DECISION_QUALITY_CODES.INVALID],
      reason: "pattern 非法:缺 level 或 instances",
    };
  }
  const current = clonePattern(source);
  if (current.level === "L3") {
    return {
      pattern: current,
      codes: [DECISION_QUALITY_CODES.NOT_PROMOTABLE],
      reason: "L3 封顶:已是最高级别",
    };
  }

  const minCrossEntity = isFiniteNumber(opts.minCrossEntity) ? opts.minCrossEntity : DEFAULT_MIN_CROSS_ENTITY;
  const crossEntityCount = crossEntityCountOf(current.instances);
  const replayValidated = opts.replayValidated === true || current.promotion.replayValidated;
  const transferTested = opts.transferTested === true || current.promotion.transferTested;

  if (current.level === "L0") {
    if (crossEntityCount < minCrossEntity) {
      return {
        pattern: current,
        codes: [DECISION_QUALITY_CODES.NOT_PROMOTABLE],
        reason: `跨实体不足:${crossEntityCount} < ${minCrossEntity}`,
      };
    }
  } else if (current.level === "L1") {
    if (opts.replayValidated !== true) {
      return {
        pattern: current,
        codes: [DECISION_QUALITY_CODES.NOT_PROMOTABLE],
        reason: "L1→L2 需要 replayValidated===true",
      };
    }
  } else if (opts.transferTested !== true) {
    return {
      pattern: current,
      codes: [DECISION_QUALITY_CODES.NOT_PROMOTABLE],
      reason: "L2→L3 需要 transferTested===true",
    };
  }

  const nextLevel = PATTERN_LEVELS[PATTERN_LEVELS.indexOf(current.level) + 1];
  if (nextLevel === undefined) {
    return { pattern: current, codes: [DECISION_QUALITY_CODES.NOT_PROMOTABLE], reason: "level 越界" };
  }
  current.level = nextLevel;
  current.promotion = { crossEntityCount, replayValidated, transferTested };
  return { pattern: current, codes: [DECISION_QUALITY_CODES.PATTERN_PROMOTED] };
}

export interface LibraryResult {
  pattern: Pattern;
  codes: DecisionQualityCode[];
  reason?: string;
}

/**
 * 入知识库:必须同时满足 level≠L0(至少跨实体复现)、confidence≥0.6、status≠observation。
 * 任一不满足 → 原样返回 + DQ_NOT_PROMOTABLE(不降级、不改状态)。
 */
export function addToLibrary(pattern: unknown): LibraryResult {
  const source = isPlainObject(pattern) ? (pattern as unknown as Pattern) : undefined;
  if (
    source === undefined ||
    !isPatternLevel(source.level) ||
    typeof source.confidence !== "number" ||
    typeof source.status !== "string"
  ) {
    return { pattern: pattern as Pattern, codes: [DECISION_QUALITY_CODES.NOT_PROMOTABLE], reason: "pattern 非法" };
  }
  const current = clonePattern(source);
  if (current.level === "L0") {
    return {
      pattern: current,
      codes: [DECISION_QUALITY_CODES.NOT_PROMOTABLE],
      reason: "level=L0:未跨实体复现,不入库",
    };
  }
  if (!(current.confidence >= LIBRARY_MIN_CONFIDENCE)) {
    return {
      pattern: current,
      codes: [DECISION_QUALITY_CODES.NOT_PROMOTABLE],
      reason: `confidence=${current.confidence} < ${LIBRARY_MIN_CONFIDENCE}`,
    };
  }
  if (current.status === "observation") {
    return {
      pattern: current,
      codes: [DECISION_QUALITY_CODES.NOT_PROMOTABLE],
      reason: "status=observation:观察项不入库",
    };
  }
  current.status = "library";
  return { pattern: current, codes: [DECISION_QUALITY_CODES.LIBRARY_ADDED] };
}

// ------------------------------------------------------------------ 反事实

export interface CounterfactualMatch {
  decisionId: string;
  choice: string;
  choiceSignature: string;
  outcome: DecisionOutcome;
  cost: DecisionCost;
  note?: string;
}

export interface CounterfactualResult {
  match?: CounterfactualMatch;
  codes: DecisionQualityCode[];
}

function isBetter(left: DecisionRecord, right: DecisionRecord): boolean {
  if (left.outcome === "success" && right.outcome !== "success") return true;
  if (left.outcome !== "success" && right.outcome === "success") return false;
  if (left.outcome === "success" && right.outcome === "success") {
    return compareCost(costTuple(left.cost), costTuple(right.cost)) < 0;
  }
  return false; // 两个都没成功:没有可比较的优序,不算反事实
}

/**
 * 找反事实:同 type、context 的 taskClass/model/phase 全同、签名不同、结果更优的记录。
 * 优劣序:success 优于非 success;同为 success 时 tokens → wallMs → toolCalls 更小者优。
 * 多条命中取最优(同优按 id 升序,保证确定性)。
 */
export function counterfactual(records: unknown, decisionId: unknown): CounterfactualResult {
  if (!Array.isArray(records) || !isNonEmptyString(decisionId)) {
    return { codes: [DECISION_QUALITY_CODES.NO_COUNTERFACTUAL] };
  }
  const valid: DecisionRecord[] = [];
  for (const raw of records) {
    const record = readRecord(raw);
    if (record !== undefined) valid.push(record);
  }
  const target = valid.find((record) => record.id === decisionId);
  if (target === undefined) return { codes: [DECISION_QUALITY_CODES.NO_COUNTERFACTUAL] };

  const targetSignature = choiceSignature(target);
  const candidates = valid.filter((record) => {
    if (record.id === target.id) return false;
    if (record.type !== target.type) return false;
    if (record.context.taskClass !== target.context.taskClass) return false;
    if (record.context.model !== target.context.model) return false;
    if (record.context.phase !== target.context.phase) return false;
    if (choiceSignature(record) === targetSignature) return false;
    return isBetter(record, target);
  });
  candidates.sort((a, b) => {
    if (!isBetter(a, b) && !isBetter(b, a)) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return isBetter(a, b) ? -1 : 1;
  });
  const best = candidates[0];
  if (best === undefined) return { codes: [DECISION_QUALITY_CODES.NO_COUNTERFACTUAL] };

  const match: CounterfactualMatch = {
    decisionId: best.id,
    choice: best.choice,
    choiceSignature: choiceSignature(best),
    outcome: best.outcome,
    cost: { ...best.cost },
  };
  if (best.note !== undefined) match.note = best.note;
  return { match, codes: [DECISION_QUALITY_CODES.COUNTERFACTUAL_FOUND] };
}

// ------------------------------------------------------------------ 人工纠正

export interface HumanCorrectOptions {
  by: string;
  note: string;
  at?: number;
  avoidability?: Avoidability;
}

export interface HumanCorrectResult {
  record: DecisionRecord;
  codes: DecisionQualityCode[];
}

/**
 * 人工纠正:只改 avoidability(给了才改)并把「谁在何时改的、依据是什么」追加进 note。
 * 不改 source、不改 outcome(原始事实不可篡改),也不修改入参(返回克隆)。
 */
export function humanCorrect(record: unknown, opts: HumanCorrectOptions | undefined): HumanCorrectResult {
  const source = readRecord(record);
  if (source === undefined) return { record: record as DecisionRecord, codes: [DECISION_QUALITY_CODES.INVALID] };
  if (!isPlainObject(opts) || !isNonEmptyString(opts.by) || !isNonEmptyString(opts.note)) {
    return { record: cloneRecord(source), codes: [DECISION_QUALITY_CODES.INVALID] };
  }
  if (opts.avoidability !== undefined && !isAvoidability(opts.avoidability)) {
    return { record: cloneRecord(source), codes: [DECISION_QUALITY_CODES.INVALID] };
  }

  const corrected = cloneRecord(source);
  if (opts.avoidability !== undefined) corrected.avoidability = opts.avoidability;
  const at = isFiniteNumber(opts.at) ? opts.at : corrected.at;
  const stamp = `[human-correction by ${opts.by} @ ${at}] ${opts.note.trim()}`;
  corrected.note = corrected.note === undefined ? stamp : `${corrected.note} | ${stamp}`;
  return { record: corrected, codes: [DECISION_QUALITY_CODES.HUMAN_CORRECTION] };
}

// ------------------------------------------------------------------ 证据图投影

export interface GraphNodeAssociations {
  decisionType: DecisionType;
  choiceSignature: string;
  distribution: PatternDistribution;
}

export interface DecisionGraphNode {
  kind: "anti-pattern" | "direction";
  statement: string;
  associations: GraphNodeAssociations;
  confidence: number;
}

/**
 * 投影成证据图节点:只投影 status=library 的模式(候选不进图,免得噪声污染检索)。
 * anti-pattern → "anti-pattern" 节点;efficient-pattern → "direction" 节点(方向性建议)。
 */
export function toGraphNode(pattern: unknown): DecisionGraphNode | undefined {
  const source = isPlainObject(pattern) ? (pattern as unknown as Pattern) : undefined;
  if (source === undefined) return undefined;
  if (source.status !== "library") return undefined;
  if (source.kind !== "anti-pattern" && source.kind !== "efficient-pattern") return undefined;
  if (!isDecisionType(source.decisionType) || !isNonEmptyString(source.choiceSignature)) return undefined;
  if (typeof source.confidence !== "number") return undefined;
  const distribution = source.distribution ?? { projects: [], models: [], taskClasses: [] };
  const kind = source.kind === "anti-pattern" ? "anti-pattern" : "direction";
  return {
    kind,
    statement: `${source.name}:${source.description}`,
    associations: {
      decisionType: source.decisionType,
      choiceSignature: source.choiceSignature,
      distribution: {
        projects: [...(distribution.projects ?? [])],
        models: [...(distribution.models ?? [])],
        taskClasses: [...(distribution.taskClasses ?? [])],
      },
    },
    confidence: source.confidence,
  };
}
