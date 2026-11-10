/**
 * 扇出返工簇(Fanout Cluster):把「一次变更 A 之后接连出现的 B/C/D 三次救火」聚成一个簇,
 * 判定真实根因是「点替换而非面替换」(影响面未闭合),而不是三次互不相关的缺陷。
 * 为什么必须聚成簇:
 * - 逐条看,每次修复都会生成一条超具体的 tip(「X 函数的调用方都要改」),
 *   这类 tip 无法迁移到下一个任务;聚成簇才看得见共同实体与共同缺陷类。
 * - 簇级签名 = 1 个变更节点 + ≥2 条**不同依赖边**上的后续修复。
 *   「不同边」是防伪的关键:同一处反复修三次是「没修对」,不是扇出。
 * 三态判定(互斥):
 * - batched-delivery:变更时已声明分批计划(batchedPlanRef)或修复在计划内(expectedInPlan),
 *   属于需求漂移账本,不算缺陷。
 * - impact-not-closed:决策时辐射面清单缺失,或清单未覆盖修复边(按契约类型映射)。
 * - insufficient-evidence:清单覆盖全部边,但簇本身不能证明语义漂移——交人工。
 * 纯逻辑:零 IO(不读文件 / 网络 / 环境 / 真实时钟),时间一律为 epoch ms 数字,
 * 全部时间来自输入(at)或注入(opts),不调用 Date.now()。
 * 所有导出函数不抛异常:非法输入返回安全空值并带稳定码(FANOUT_CODES)。
 */

/** 扇出簇 schema 版本:字段语义变化时递增。 */
export const FANOUT_VERSION = 1;

/** 任务原型:命中原型的任务在计划阶段必须先产出辐射面清单。 */
export const FANOUT_ARCHETYPES = [
  "integration-replace",
  "public-contract-change",
  "delete-or-semantic-change",
  "other",
] as const;

export type FanoutArchetype = (typeof FANOUT_ARCHETYPES)[number];

/** 命中原型的三类(需要辐射面清单的那三类)。 */
export const RADIATION_ARCHETYPES = [
  "integration-replace",
  "public-contract-change",
  "delete-or-semantic-change",
] as const;

export type RadiationArchetype = (typeof RADIATION_ARCHETYPES)[number];

/** 契约类型 = 扇出边的缺陷类:签名 / 语义 / 精度 / 空值 / 时序 / 事件。 */
export const CONTRACT_TYPES = ["signature", "semantics", "precision", "nullability", "timing", "events"] as const;

export type ContractType = (typeof CONTRACT_TYPES)[number];

/** 辐射面清单的七项。 */
export const CHECKLIST_KEYS = [
  "upstream-callers",
  "downstream-deps",
  "data-contracts",
  "side-effects",
  "tests-mocks",
  "config-flags",
  "compat-migration",
] as const;

export type ChecklistKey = (typeof CHECKLIST_KEYS)[number];

/** 稳定码:调用方按码分支,不解析文案。 */
export const FANOUT_CODES = {
  INVALID: "FANOUT_INVALID",
  CLUSTER_FOUND: "FANOUT_CLUSTER_FOUND",
  NO_CLUSTER: "FANOUT_NO_CLUSTER",
  EDGE_DEDUPED: "FANOUT_EDGE_DEDUPED",
  IMPACT_NOT_CLOSED: "FANOUT_IMPACT_NOT_CLOSED",
  BATCHED_DELIVERY: "FANOUT_BATCHED_DELIVERY",
  INSUFFICIENT_EVIDENCE: "FANOUT_INSUFFICIENT_EVIDENCE",
  ARCHETYPE_MATCH: "FANOUT_ARCHETYPE_MATCH",
  ARCHETYPE_MISS: "FANOUT_ARCHETYPE_MISS",
  CHECKLIST_MISSING: "FANOUT_CHECKLIST_MISSING",
  CHECKLIST_INCOMPLETE: "FANOUT_CHECKLIST_INCOMPLETE",
  CHECKLIST_OK: "FANOUT_CHECKLIST_OK",
} as const;

export type FanoutCode = (typeof FANOUT_CODES)[keyof typeof FANOUT_CODES];

/** 判定结论三态。 */
export type FanoutVerdict = "impact-not-closed" | "batched-delivery" | "insufficient-evidence";

/** 判定 → 稳定码的唯一映射。 */
export const VERDICT_CODES: Record<FanoutVerdict, FanoutCode> = {
  "impact-not-closed": FANOUT_CODES.IMPACT_NOT_CLOSED,
  "batched-delivery": FANOUT_CODES.BATCHED_DELIVERY,
  "insufficient-evidence": FANOUT_CODES.INSUFFICIENT_EVIDENCE,
};

/** 一条依赖边的契约类型标注(from → to)。 */
export interface FixEdge {
  from: string;
  to: string;
  contractType: ContractType;
}

/** 辐射面清单的一项;evidence 是机械化检索的产出位(命令输出落点)。 */
export interface RadiationChecklistItem {
  key: ChecklistKey;
  evidence?: string;
}

/** 计划阶段产出的辐射面清单;producedAt = 产出时间。 */
export interface RadiationChecklist {
  items: RadiationChecklistItem[];
  producedAt?: number;
}

/** 变更节点:一次落地(集成替换 / 公共契约修改 / 删除或改语义)。 */
export interface ChangeNode {
  id: string;
  entity: string;
  module?: string;
  files: string[];
  at: number;
  taskId: string;
  archetype: FanoutArchetype;
  /** 变更时已声明的分批计划引用;非空即判 batched-delivery。 */
  batchedPlanRef?: string;
  /** 计划阶段的辐射面清单;缺失即判 impact-not-closed。 */
  radiationChecklist?: RadiationChecklist;
}

/** 修复事件:变更之后出现的返工,edges 标出它踩到的依赖边。 */
export interface FixEvent {
  id: string;
  taskId: string;
  at: number;
  entity?: string;
  module?: string;
  files: string[];
  edges: FixEdge[];
  description: string;
  /** 该修复是否已在原计划里(分批交付时填 true)。 */
  expectedInPlan?: boolean;
}

/** 时间窗(闭区间)。 */
export interface FanoutWindow {
  from: number;
  to: number;
}

/** 一个扇出簇。 */
export interface FanoutCluster {
  id: string;
  entity: string;
  window: FanoutWindow;
  change: ChangeNode;
  fixes: FixEvent[];
  edgeTypes: ContractType[];
  edgeKeys: string[];
  size: number;
  verdict: FanoutVerdict;
  codes: FanoutCode[];
}

/** detectClusters 输入。 */
export interface DetectInput {
  changes?: ChangeNode[];
  fixes?: FixEvent[];
}

/** detectClusters 选项。 */
export interface DetectOptions {
  /** 时间窗天数(缺省 14)。 */
  windowDays?: number;
  /** 成簇所需的最少去重修复数(缺省 2)。 */
  minFixes?: number;
}

export interface DetectResult {
  clusters: FanoutCluster[];
  codes: FanoutCode[];
}

export interface ClassifyResult {
  verdict: FanoutVerdict;
  codes: FanoutCode[];
  rationale: string;
  /** 判定为缺口时,建议补的清单项。 */
  missing?: ChecklistKey[];
  /** 未被清单覆盖的边(键形如 from->to:contractType)。 */
  uncoveredEdges?: string[];
}

/** 清单项的定义(标签 + 机械化命令提示)。 */
export interface RequiredChecklistItem {
  key: ChecklistKey;
  label: string;
  mechanism: string;
}

export interface RequiredChecklistResult {
  archetype: FanoutArchetype;
  applicable: boolean;
  required: RequiredChecklistItem[];
}

export interface RadiationGateInput {
  archetype?: string;
  checklist?: RadiationChecklist | null;
  /** 预留事实位(调用方补充的证据快照),当前不影响判定。 */
  facts?: Record<string, unknown>;
}

export interface RadiationGateResult {
  ok: boolean;
  codes: FanoutCode[];
  archetype?: FanoutArchetype;
  applicable?: boolean;
  missing?: ChecklistKey[];
  required?: RequiredChecklistItem[];
}

/** 证据图节点输入(与 evidence-graph 的 AddEvidenceInput 同形子集)。 */
export interface FanoutGraphNode {
  kind: "anti-pattern" | "direction";
  statement: string;
  associations: { type: "feature" | "module" | "task"; ref: string; label?: string }[];
  confidence: number;
}

export interface ClusterToGraphResult {
  ok: boolean;
  nodes: FanoutGraphNode[];
  codes: FanoutCode[];
}

const DAY_MS = 86_400_000;

const ARCHETYPE_SET: ReadonlySet<string> = new Set<string>(FANOUT_ARCHETYPES);
const CONTRACT_TYPE_SET: ReadonlySet<string> = new Set<string>(CONTRACT_TYPES);
const CHECKLIST_KEY_SET: ReadonlySet<string> = new Set<string>(CHECKLIST_KEYS);
const RADIATION_ARCHETYPE_SET: ReadonlySet<string> = new Set<string>(RADIATION_ARCHETYPES);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 实体键:有 entity 用 entity,缺省用 module 造一个命名空间键。 */
export function entityKeyOf(record: { entity?: string; module?: string }): string {
  if (isFilled(record.entity)) return record.entity.trim();
  if (isFilled(record.module)) return `module:${record.module.trim()}`;
  return "";
}

/** 边去重键:`${from}->${to}:${contractType}`(与 spec 逐字一致)。 */
export function edgeKeyOf(edge: { from: string; to: string; contractType: string }): string {
  return `${edge.from}->${edge.to}:${edge.contractType}`;
}

/** id 净化:只留 [A-Za-z0-9_-],其余折叠成 "-"。 */
function slug(value: string): string {
  const out = value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return out === "" ? "unknown" : out;
}

function normalizeEdge(value: unknown): FixEdge | undefined {
  if (!isRecord(value)) return undefined;
  if (!isFilled(value.from) || !isFilled(value.to)) return undefined;
  if (!isFilled(value.contractType) || !CONTRACT_TYPE_SET.has(value.contractType)) return undefined;
  return { from: value.from.trim(), to: value.to.trim(), contractType: value.contractType as ContractType };
}

function normalizeChecklist(value: unknown): RadiationChecklist | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined;
  const items: RadiationChecklistItem[] = [];
  for (const raw of value.items) {
    if (!isRecord(raw) || !isFilled(raw.key) || !CHECKLIST_KEY_SET.has(raw.key)) continue;
    const item: RadiationChecklistItem = { key: raw.key as ChecklistKey };
    if (isFilled(raw.evidence)) item.evidence = raw.evidence.trim();
    items.push(item);
  }
  const checklist: RadiationChecklist = { items };
  if (isFiniteNumber(value.producedAt)) checklist.producedAt = value.producedAt;
  return checklist;
}

function normalizeChange(value: unknown): ChangeNode | undefined {
  if (!isRecord(value)) return undefined;
  if (!isFilled(value.id) || !isFilled(value.taskId)) return undefined;
  if (!isFiniteNumber(value.at)) return undefined;
  if (!Array.isArray(value.files) || !value.files.every((file) => typeof file === "string")) return undefined;
  if (!isFilled(value.entity) && !isFilled(value.module)) return undefined;
  const archetype: FanoutArchetype =
    isFilled(value.archetype) && ARCHETYPE_SET.has(value.archetype) ? (value.archetype as FanoutArchetype) : "other";
  const change: ChangeNode = {
    id: value.id.trim(),
    entity: isFilled(value.entity) ? value.entity.trim() : "",
    files: (value.files as string[]).slice(),
    at: value.at,
    taskId: value.taskId.trim(),
    archetype,
  };
  if (isFilled(value.module)) change.module = value.module.trim();
  if (isFilled(value.batchedPlanRef)) change.batchedPlanRef = value.batchedPlanRef.trim();
  const checklist = normalizeChecklist(value.radiationChecklist);
  if (checklist) change.radiationChecklist = checklist;
  return change;
}

function normalizeFix(value: unknown): FixEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (!isFilled(value.id) || !isFilled(value.taskId)) return undefined;
  if (!isFiniteNumber(value.at)) return undefined;
  if (!Array.isArray(value.files) || !value.files.every((file) => typeof file === "string")) return undefined;
  if (!Array.isArray(value.edges)) return undefined;
  const edges: FixEdge[] = [];
  for (const raw of value.edges) {
    const edge = normalizeEdge(raw);
    if (edge) edges.push(edge);
  }
  const fix: FixEvent = {
    id: value.id.trim(),
    taskId: value.taskId.trim(),
    at: value.at,
    files: (value.files as string[]).slice(),
    edges,
    description: isFilled(value.description) ? value.description.trim() : "",
  };
  if (isFilled(value.entity)) fix.entity = value.entity.trim();
  if (isFilled(value.module)) fix.module = value.module.trim();
  if (value.expectedInPlan === true) fix.expectedInPlan = true;
  return fix;
}

/**
 * 边 → 能覆盖它的清单项(契约类型映射)。
 * 通用三项必须都在:`upstream-callers` 覆盖每条边的 from、`downstream-deps` 覆盖 to、
 * `data-contracts` 覆盖任意边;类型专属项给出更精确的补充覆盖。
 */
const EDGE_COVER_KEYS: Record<ContractType, ChecklistKey[]> = {
  signature: ["upstream-callers", "downstream-deps", "data-contracts", "compat-migration", "tests-mocks"],
  semantics: ["upstream-callers", "downstream-deps", "data-contracts", "tests-mocks"],
  precision: ["upstream-callers", "downstream-deps", "data-contracts", "tests-mocks"],
  nullability: ["upstream-callers", "downstream-deps", "data-contracts", "tests-mocks"],
  timing: ["upstream-callers", "downstream-deps", "data-contracts", "side-effects", "tests-mocks"],
  events: ["upstream-callers", "downstream-deps", "data-contracts", "config-flags", "tests-mocks"],
};

/** 七项的标签与机械化命令提示(计划阶段照抄执行)。 */
export const CHECKLIST_DEFINITIONS: Record<ChecklistKey, RequiredChecklistItem> = {
  "upstream-callers": {
    key: "upstream-callers",
    label: "上游调用方",
    mechanism: "codesense impact <symbol>(callers):列全部调用点并逐个改名/改签名",
  },
  "downstream-deps": {
    key: "downstream-deps",
    label: "下游依赖",
    mechanism: "codesense impact <symbol>(callees/downstream):列内部实现与依赖落点",
  },
  "data-contracts": {
    key: "data-contracts",
    label: "数据契约",
    mechanism: "codesense refs <field>:字段/负载/序列化消费点全表",
  },
  "side-effects": {
    key: "side-effects",
    label: "副作用",
    mechanism: "rg '<symbol>' <module>:日志/缓存/事件/重试等副作用消费点",
  },
  "tests-mocks": {
    key: "tests-mocks",
    label: "测试与 mock",
    mechanism: "vitest related <changed-file>:受影响测试文件与 mock 清单",
  },
  "config-flags": {
    key: "config-flags",
    label: "配置开关",
    mechanism: "rg '<flagName>':配置键/开关/默认值消费点",
  },
  "compat-migration": {
    key: "compat-migration",
    label: "兼容迁移",
    mechanism: "版本/弃用窗:兼容矩阵 + 旧调用下线时间点",
  },
};

/** 三类原型各自的必备子集(7 项的子集)。 */
export const ARCHETYPE_REQUIRED: Record<RadiationArchetype, ChecklistKey[]> = {
  "integration-replace": ["upstream-callers", "downstream-deps", "data-contracts", "tests-mocks", "compat-migration"],
  "public-contract-change": [
    "upstream-callers",
    "downstream-deps",
    "data-contracts",
    "side-effects",
    "tests-mocks",
    "compat-migration",
  ],
  "delete-or-semantic-change": [
    "upstream-callers",
    "downstream-deps",
    "data-contracts",
    "tests-mocks",
    "config-flags",
    "compat-migration",
  ],
};

/** 集合化后的契约类型(按 CONTRACT_TYPES 定义顺序输出,保证稳定)。 */
function orderedContractTypes(keys: Iterable<string>): ContractType[] {
  const present = new Set<string>();
  for (const key of keys) {
    const idx = key.lastIndexOf(":");
    if (idx > 0) present.add(key.slice(idx + 1));
  }
  return CONTRACT_TYPES.filter((type) => present.has(type));
}

/**
 * 聚簇:对每个变更节点,在 [change.at, change.at + windowDays] 内取同实体的修复,
 * 边按 `${from}->${to}:${contractType}` 去重后要求 ≥2 条不同边,才算一个扇出簇。
 * 一个修复只归「最近窗口内」的变更节点(幂等:同一输入重复调用结果逐字一致)。
 */
export function detectClusters(input: DetectInput, opts: DetectOptions = {}): DetectResult {
  const invalid: DetectResult = { clusters: [], codes: [FANOUT_CODES.INVALID] };
  if (!isRecord(input) || !Array.isArray(input.changes) || !Array.isArray(input.fixes)) return invalid;
  const windowDays = numOr(opts?.windowDays, 14);
  const minFixes = Math.floor(numOr(opts?.minFixes, 2));
  if (!(windowDays > 0) || !(minFixes >= 1)) return invalid;

  const codes = new Set<FanoutCode>();
  const changes: ChangeNode[] = [];
  const seenChangeIds = new Set<string>();
  for (const raw of input.changes) {
    const change = normalizeChange(raw);
    if (!change) {
      codes.add(FANOUT_CODES.INVALID);
      continue;
    }
    if (seenChangeIds.has(change.id)) continue;
    seenChangeIds.add(change.id);
    changes.push(change);
  }

  const fixesById = new Map<string, FixEvent>();
  for (const raw of input.fixes) {
    const fix = normalizeFix(raw);
    if (!fix) {
      codes.add(FANOUT_CODES.INVALID);
      continue;
    }
    // 边字段里混入非法项:边被丢弃但修复本身可用,仍如实标 INVALID。
    if (isRecord(raw) && Array.isArray(raw.edges) && raw.edges.length !== fix.edges.length) {
      codes.add(FANOUT_CODES.INVALID);
    }
    if (!fixesById.has(fix.id)) fixesById.set(fix.id, fix);
  }
  const fixes = [...fixesById.values()];

  // 最近优先:同一个修复只能归一个变更节点,按 at 降序认领。
  const ordered = changes.slice().sort((a, b) => b.at - a.at || cmpStr(a.id, b.id));
  const claimed = new Set<string>();
  const clusters: FanoutCluster[] = [];

  for (const change of ordered) {
    const key = entityKeyOf(change);
    if (key === "") {
      codes.add(FANOUT_CODES.INVALID);
      continue;
    }
    const from = change.at;
    const to = change.at + windowDays * DAY_MS;
    const candidates = fixes
      .filter((fix) => !claimed.has(fix.id) && fix.at >= from && fix.at <= to && entityKeyOf(fix) === key)
      .sort((a, b) => a.at - b.at || cmpStr(a.id, b.id));
    if (candidates.length < minFixes) continue;

    const edgeMap = new Map<string, FixEdge>();
    let deduped = false;
    for (const fix of candidates) {
      for (const edge of fix.edges) {
        const edgeKey = edgeKeyOf(edge);
        if (edgeMap.has(edgeKey)) {
          deduped = true;
          continue;
        }
        edgeMap.set(edgeKey, edge);
      }
    }
    if (deduped) codes.add(FANOUT_CODES.EDGE_DEDUPED);
    if (edgeMap.size < 2) continue;

    const edgeKeys = [...edgeMap.keys()].sort(cmpStr);
    const seed: FanoutCluster = {
      id: `fanout-${slug(change.id)}`,
      entity: change.entity !== "" ? change.entity : (change.module ?? key),
      window: { from, to },
      change,
      fixes: candidates,
      edgeTypes: orderedContractTypes(edgeKeys),
      edgeKeys,
      size: candidates.length,
      verdict: "insufficient-evidence",
      codes: [],
    };
    const classified = classifyCluster(seed);
    seed.verdict = classified.verdict;
    seed.codes = deduped ? [classified.codes[0]!, FANOUT_CODES.EDGE_DEDUPED] : [...classified.codes];
    for (const fix of candidates) claimed.add(fix.id);
    clusters.push(seed);
  }

  clusters.sort((a, b) => a.window.from - b.window.from || cmpStr(a.id, b.id));
  codes.add(clusters.length > 0 ? FANOUT_CODES.CLUSTER_FOUND : FANOUT_CODES.NO_CLUSTER);
  if (clusters.some((cluster) => cluster.codes.includes(FANOUT_CODES.EDGE_DEDUPED))) {
    codes.add(FANOUT_CODES.EDGE_DEDUPED);
  }
  return { clusters, codes: [...codes] };
}

function invalidClassification(rationale: string): ClassifyResult {
  return { verdict: "insufficient-evidence", codes: [FANOUT_CODES.INVALID], rationale };
}

/**
 * 分类:簇 → 三态之一。
 * 1) 任一修复 expectedInPlan,或变更声明 batchedPlanRef → batched-delivery(需求漂移,不算缺陷)
 * 2) 辐射面清单缺失/为空 → impact-not-closed(决策时信息不可得)
 * 3) 清单存在但未覆盖某条边(按契约类型映射)→ impact-not-closed(不完整)
 * 4) 清单覆盖全部边 → insufficient-evidence(可能语义漂移,交人工)
 */
export function classifyCluster(cluster: Pick<FanoutCluster, "change" | "fixes"> | undefined, _opts: { now?: number } = {}): ClassifyResult {
  if (!isRecord(cluster) || !isRecord(cluster.change) || !Array.isArray(cluster.fixes)) {
    return invalidClassification("簇输入非法,无法判定");
  }
  const change = normalizeChange(cluster.change);
  if (!change) return invalidClassification("变更节点非法(id/taskId/at/files 缺失)");

  const fixes: FixEvent[] = [];
  for (const raw of cluster.fixes) {
    const fix = normalizeFix(raw);
    if (fix) fixes.push(fix);
  }

  const planned = fixes.some((fix) => fix.expectedInPlan === true) || isFilled(change.batchedPlanRef);
  if (planned) {
    return {
      verdict: "batched-delivery",
      codes: [FANOUT_CODES.BATCHED_DELIVERY],
      rationale: "簇内修复已在计划内(分批交付),计入需求漂移账本而非缺陷",
    };
  }

  const required = requiredChecklist(change.archetype);
  const checklist = change.radiationChecklist;
  if (!checklist || checklist.items.length === 0) {
    return {
      verdict: "impact-not-closed",
      codes: [FANOUT_CODES.IMPACT_NOT_CLOSED],
      rationale: "决策时辐射面清单缺失:变更落地时无法证明影响面已闭合",
      missing: required.applicable ? required.required.map((item) => item.key) : [],
    };
  }

  const have = new Set<ChecklistKey>(checklist.items.map((item) => item.key));
  const edgeMap = new Map<string, FixEdge>();
  for (const fix of fixes) {
    for (const edge of fix.edges) {
      const edgeKey = edgeKeyOf(edge);
      if (!edgeMap.has(edgeKey)) edgeMap.set(edgeKey, edge);
    }
  }
  const uncovered: string[] = [];
  const suggested = new Set<ChecklistKey>();
  for (const [edgeKey, edge] of edgeMap) {
    const coverKeys = EDGE_COVER_KEYS[edge.contractType] ?? [];
    if (coverKeys.some((key) => have.has(key))) continue;
    uncovered.push(edgeKey);
    for (const key of coverKeys) suggested.add(key);
  }
  if (uncovered.length > 0) {
    return {
      verdict: "impact-not-closed",
      codes: [FANOUT_CODES.IMPACT_NOT_CLOSED],
      rationale: `辐射面清单未覆盖 ${uncovered.length} 条修复边:${uncovered.slice(0, 3).join(", ")}`,
      missing: [...suggested].sort(cmpStr),
      uncoveredEdges: uncovered.sort(cmpStr),
    };
  }

  return {
    verdict: "insufficient-evidence",
    codes: [FANOUT_CODES.INSUFFICIENT_EVIDENCE],
    rationale: "清单已覆盖全部修复边:仍不能排除语义漂移,交人工判定",
  };
}

/** 原型 → 必备清单子集 + 机械化命令提示;非三类原型 applicable=false。 */
export function requiredChecklist(archetype: string): RequiredChecklistResult {
  if (!isFilled(archetype) || !RADIATION_ARCHETYPE_SET.has(archetype)) {
    const safe: FanoutArchetype = isFilled(archetype) && ARCHETYPE_SET.has(archetype) ? (archetype as FanoutArchetype) : "other";
    return { archetype: safe, applicable: false, required: [] };
  }
  const keys = ARCHETYPE_REQUIRED[archetype as RadiationArchetype];
  return {
    archetype: archetype as FanoutArchetype,
    applicable: true,
    required: keys.map((key) => ({ ...CHECKLIST_DEFINITIONS[key] })),
  };
}

/**
 * 辐射面门:命中三类原型的任务在进实现前必须先交齐必备清单项。
 * - 非三类原型 → ok + ARCHETYPE_MISS(不阻断)
 * - 清单缺失 → 不通过 + CHECKLIST_MISSING
 * - 缺必备项 → 不通过 + CHECKLIST_INCOMPLETE(列出缺项)
 * - 全齐 → 通过 + CHECKLIST_OK
 */
export function evaluateRadiationGate(input: RadiationGateInput): RadiationGateResult {
  if (!isRecord(input)) return { ok: false, codes: [FANOUT_CODES.INVALID] };
  const archetype = isFilled(input.archetype) ? input.archetype.trim() : "";
  if (archetype === "" || !ARCHETYPE_SET.has(archetype)) {
    return { ok: false, codes: [FANOUT_CODES.INVALID] };
  }
  if (!RADIATION_ARCHETYPE_SET.has(archetype)) {
    return { ok: true, codes: [FANOUT_CODES.ARCHETYPE_MISS], archetype: archetype as FanoutArchetype, applicable: false, required: [] };
  }
  const required = requiredChecklist(archetype);
  const base = { archetype: archetype as FanoutArchetype, applicable: true, required: required.required };
  const checklist = normalizeChecklist(input.checklist);
  if (!checklist || checklist.items.length === 0) {
    return {
      ok: false,
      codes: [FANOUT_CODES.ARCHETYPE_MATCH, FANOUT_CODES.CHECKLIST_MISSING],
      ...base,
      missing: required.required.map((item) => item.key),
    };
  }
  const have = new Set<ChecklistKey>(checklist.items.map((item) => item.key));
  const missing = required.required.map((item) => item.key).filter((key) => !have.has(key));
  if (missing.length > 0) {
    return {
      ok: false,
      codes: [FANOUT_CODES.ARCHETYPE_MATCH, FANOUT_CODES.CHECKLIST_INCOMPLETE],
      ...base,
      missing,
    };
  }
  return { ok: true, codes: [FANOUT_CODES.ARCHETYPE_MATCH, FANOUT_CODES.CHECKLIST_OK], ...base, missing: [] };
}

/**
 * 簇 → 证据图节点:一条 anti-pattern(扇出未闭合的事实)+ 一条 direction(下次必须产清单)。
 * association 用证据图支持的三种类型表达 entity/module/task(entity 以 feature 承载并加 label)。
 */
export function clusterToGraphNodes(cluster: Pick<FanoutCluster, "entity" | "change" | "fixes" | "size" | "edgeTypes"> | undefined): ClusterToGraphResult {
  if (!isRecord(cluster) || !isRecord(cluster.change)) {
    return { ok: false, nodes: [], codes: [FANOUT_CODES.INVALID] };
  }
  const change = normalizeChange(cluster.change);
  if (!change) return { ok: false, nodes: [], codes: [FANOUT_CODES.INVALID] };
  const fixes = Array.isArray(cluster.fixes) ? cluster.fixes : [];
  const entity = isFilled(cluster.entity) ? cluster.entity.trim() : change.entity !== "" ? change.entity : (change.module ?? change.id);
  const size = isFiniteNumber(cluster.size) ? cluster.size : fixes.length;
  const edgeTypes = Array.isArray(cluster.edgeTypes) && cluster.edgeTypes.length > 0 ? cluster.edgeTypes.join("/") : "无标注";

  const associations: FanoutGraphNode["associations"] = [{ type: "feature", ref: entity, label: "entity" }];
  if (change.module !== undefined) associations.push({ type: "module", ref: change.module });
  if (change.taskId !== "") associations.push({ type: "task", ref: change.taskId });

  const nodes: FanoutGraphNode[] = [
    {
      kind: "anti-pattern",
      statement: `扇出未闭合:${entity} 引发 ${size} 条后续修复(边类型:${edgeTypes})`,
      associations,
      confidence: 0.65,
    },
    {
      kind: "direction",
      statement: "扇出原型必须产出辐射面清单(7 项:upstream-callers/downstream-deps/data-contracts/side-effects/tests-mocks/config-flags/compat-migration)",
      associations,
      confidence: 0.6,
    },
  ];
  return { ok: true, nodes, codes: [FANOUT_CODES.CLUSTER_FOUND] };
}
