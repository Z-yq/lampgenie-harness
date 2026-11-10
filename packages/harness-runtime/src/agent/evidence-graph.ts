/**
 * 证据图(Evidence Graph):把「观察到的事实 / 洞察 / 反模式 / 方向」写成可追溯、可版本化的节点,
 * 而不是散落在对话里的口头结论。
 *
 * 为什么需要图而不是一个数组:
 * - 同一条结论会在不同会话里被反复「发现」,重复插入必须能被识别(稳定 id),
 *   否则「这条已经验过了」无从判断。
 * - 结论会被修正(new evidence 推翻旧认知)。修正不能覆盖旧版本,否则丢掉了「当时为什么那样判断」;
 *   所以 supersede/correct 都产生新版本并双向指针,旧版保留可查。
 * - 同一 association(比如某个 module 的某个 tip)上出现互相矛盾的结论时,系统不该擅自删一条,
 *   而应显式并存并把冲突暴露出来(conflictsOf),由 markAuthoritative 显式选择权威版。
 * - 证据会随年龄衰减(decayScore/applyDecay):半衰期外的旧结论不该继续以满置信度参与判断,
 *   但也不能物理删除(archived 只改 status,节点保留)。
 *
 * 纯逻辑:零 IO,不读文件/网络/环境。只用 node:crypto 的 sha256(稳定 id)。
 * 与 experiment-ledger 零耦合:canonicalJSON/归一化/sha256 在本文件自包含实现。
 *
 * 时间一律 epoch ms 数字;每个会写时间的函数都可注入 at(缺省 Date.now());
 * 所有函数不抛异常——非法输入返回 { ok: false, code } 或安全空值。
 */
import { createHash } from "node:crypto";

/** 证据图 schema 版本:字段语义变化时递增,读取方据此迁移。 */
export const EVIDENCE_SCHEMA_VERSION = 1;

/** 节点种类:fact=可复现的观察,insight=解释,anti-pattern=不该这么做,direction=下一步方向。 */
export type EvidenceNodeKind = "fact" | "insight" | "anti-pattern" | "direction";

/** 节点状态:active=在用,stale=过期待复核,archived=归档(仅状态,物理节点保留)。 */
export type EvidenceStatus = "active" | "stale" | "archived";

/** 权威性:latest=默认(最新版),authoritative=人工/规则指定为权威版。 */
export type Authoritativeness = "latest" | "authoritative";

/** 来源:指向产生这条证据的会话/span/决策/实验,用于回溯。 */
export interface EvidenceSource {
  sessionId?: string;
  spanId?: string;
  decisionSeq?: number;
  traceBatchKey?: string;
  experimentId?: string;
  note?: string;
}

/** 关联:这条证据挂在哪(任务/模块/特性/决策/工具/tip)。 */
export interface EvidenceAssociation {
  type: "task" | "module" | "feature" | "decision" | "tool" | "tip";
  ref: string;
  label?: string;
}

/** 修正记录:谁在什么时候因为什么改了说法,以及改之前的说法。 */
export interface EvidenceCorrection {
  at: number;
  by: string;
  reason: string;
  fromStatement?: string;
}

/** 一条证据节点。有效期是 [validFrom, validTo) 半开区间。 */
export interface EvidenceNode {
  id: string;
  kind: EvidenceNodeKind;
  statement: string;
  observedAt: number;
  validFrom: number;
  validTo?: number;
  confidence: number;
  source: EvidenceSource;
  associations: EvidenceAssociation[];
  status: EvidenceStatus;
  modelVersion?: string;
  projectId?: string;
  supersedes?: string;
  supersededBy?: string;
  corrections: EvidenceCorrection[];
  authoritativeness: Authoritativeness;
  createdAt: number;
  updatedAt: number;
  staleAt?: number;
  staleReason?: string;
  archivedAt?: number;
  archivedReason?: string;
}

/** 证据图:节点按 id 索引(schemaVersion 见 EVIDENCE_SCHEMA_VERSION)。 */
export interface EvidenceGraph {
  schemaVersion: number;
  nodes: Record<string, EvidenceNode>;
}

/** 稳定码:调用方按码断言,不解析文案。 */
export const EVIDENCE_CODES = {
  INVALID_INPUT: "EVIDENCE_INVALID_INPUT",
  DUPLICATE: "EVIDENCE_DUPLICATE",
  NOT_FOUND: "EVIDENCE_NOT_FOUND",
} as const;

export type EvidenceCode = (typeof EVIDENCE_CODES)[keyof typeof EVIDENCE_CODES];

/** 缺省置信度:新证据既不该一上来就满信,也不该低到没意义。 */
const DEFAULT_CONFIDENCE = 0.7;

/** 一天多少毫秒(衰减计算用)。 */
const DAY_MS = 86_400_000;

const KINDS: readonly EvidenceNodeKind[] = ["fact", "insight", "anti-pattern", "direction"];

const ASSOCIATION_TYPES: readonly EvidenceAssociation["type"][] = ["task", "module", "feature", "decision", "tool", "tip"];

/** 空图。 */
export function createEvidenceGraph(): EvidenceGraph {
  return { schemaVersion: EVIDENCE_SCHEMA_VERSION, nodes: {} };
}

/** 语句规范化:trim → 内部连续空白折叠为单空格 → 英文小写。 */
export function normalizeStatement(statement: string): string {
  if (typeof statement !== "string") return "";
  return statement.trim().replace(/\s+/g, " ").toLowerCase();
}

/** 稳定键序 JSON:对象键升序、数组保序、undefined 键省略。 */
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

/** association 的稳定排序键(type/ref/label,缺省 label 为空串)。 */
function associationSortKey(a: EvidenceAssociation): string {
  return [a.type, a.ref, a.label ?? ""].join("\u0000");
}

/** association 的冲突分组键(不含 kind 与 label:同一 ref 上的矛盾要能碰面)。 */
function associationGroupKey(a: EvidenceAssociation): string {
  return `${a.type}:${a.ref}`;
}

/**
 * 证据 id:同一 (kind, 规范化 statement, association 集合) 必得同一 id,与 association 顺序无关。
 * = "ev-" + sha256(canonicalJSON({kind, statement, associations: 按(type,ref,label)排序且只取已定义字段}))前 16 hex。
 */
export function evidenceIdOf(
  node: Pick<EvidenceNode, "kind" | "statement" | "associations"> | { kind: EvidenceNodeKind; statement: string; associations?: EvidenceAssociation[] },
): string {
  const associations = sortAssociations(node.associations ?? []).map((a) => ({
    type: a.type,
    ref: a.ref,
    label: a.label,
  }));
  const payload = canonicalJSON({
    kind: node.kind,
    statement: normalizeStatement(node.statement),
    associations,
  });
  return `ev-${sha256hex(payload).slice(0, 16)}`;
}

/** 版本 id:规范化后与已有节点撞车时(例如仅改置信度)用时间戳打散。 */
function versionIdOf(baseId: string, at: number, statement: string): string {
  return `ev-${sha256hex(`${baseId}:${at}:${statement}`).slice(0, 16)}`;
}

// ---------------------------------------------------------------- 内部工具

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGraph(value: unknown): value is EvidenceGraph {
  return isObject(value) && isObject((value as { nodes?: unknown }).nodes);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isKind(value: unknown): value is EvidenceNodeKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

function isAssociationType(value: unknown): value is EvidenceAssociation["type"] {
  return typeof value === "string" && (ASSOCIATION_TYPES as readonly string[]).includes(value);
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function clampConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : DEFAULT_CONFIDENCE;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 纯递归深拷贝(保留 undefined 字段,不依赖 structuredClone)。 */
function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => deepClone(v)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepClone(v);
    return out as T;
  }
  return value;
}

/** association 排序(不影响语义,只影响 id 稳定性)。 */
function sortAssociations(list: readonly EvidenceAssociation[]): EvidenceAssociation[] {
  return list.slice().sort((a, b) => cmpStr(associationSortKey(a), associationSortKey(b)));
}

/** 清洗 associations:丢掉非法项(未知 type / 空 ref),按 type/ref/label 去重。 */
function normalizeAssociations(raw: unknown): EvidenceAssociation[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: EvidenceAssociation[] = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    if (!isAssociationType(item.type) || !isNonEmptyString(item.ref)) continue;
    const assoc: EvidenceAssociation = { type: item.type, ref: item.ref };
    if (isNonEmptyString(item.label)) assoc.label = item.label;
    const key = associationSortKey(assoc);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(assoc);
  }
  return sortAssociations(out);
}

/** 清洗 source:只保留已知字段且类型正确的项。 */
function normalizeSource(raw: unknown): EvidenceSource {
  if (!isObject(raw)) return {};
  const source: EvidenceSource = {};
  for (const key of ["sessionId", "spanId", "traceBatchKey", "experimentId", "note"] as const) {
    if (isNonEmptyString(raw[key])) source[key] = raw[key] as string;
  }
  if (typeof raw.decisionSeq === "number" && Number.isFinite(raw.decisionSeq)) source.decisionSeq = raw.decisionSeq;
  return source;
}

/** 节点在 at 时是否有效:[validFrom, validTo) 半开区间。 */
function isValidAt(node: EvidenceNode, at: number): boolean {
  if (!(numOr(node.validFrom, 0) <= at)) return false;
  if (node.validTo !== undefined && !(at < node.validTo)) return false;
  return true;
}

/** 冲突/latest 排序:validFrom desc → updatedAt desc → id asc。 */
function cmpRecencyNewestFirst(a: EvidenceNode, b: EvidenceNode): number {
  const byFrom = numOr(b.validFrom, 0) - numOr(a.validFrom, 0);
  if (byFrom !== 0) return byFrom;
  const byUpdated = numOr(b.updatedAt, 0) - numOr(a.updatedAt, 0);
  if (byUpdated !== 0) return byUpdated;
  return cmpStr(a.id, b.id);
}

/** 给新节点做「从 supersede/correct 输入构造」的公共部分。 */
function buildFreshNode(input: Record<string, unknown>, id: string, at: number): EvidenceNode {
  const observedAt = numOr(input.observedAt, at);
  const validFrom = numOr(input.validFrom, at);
  const node: EvidenceNode = {
    id,
    kind: input.kind as EvidenceNodeKind,
    statement: (input.statement as string).trim(),
    observedAt,
    validFrom,
    confidence: clampConfidence(input.confidence),
    source: normalizeSource(input.source),
    associations: normalizeAssociations(input.associations),
    status: "active",
    corrections: [],
    authoritativeness: "latest",
    createdAt: at,
    updatedAt: at,
  };
  if (isNonEmptyString(input.modelVersion)) node.modelVersion = input.modelVersion;
  if (isNonEmptyString(input.projectId)) node.projectId = input.projectId;
  return node;
}

// ---------------------------------------------------------------- addEvidence

/** addEvidence 的输入。 */
export interface AddEvidenceInput {
  kind: EvidenceNodeKind;
  statement: string;
  associations?: EvidenceAssociation[];
  source?: EvidenceSource;
  observedAt?: number;
  validFrom?: number;
  confidence?: number;
  modelVersion?: string;
  projectId?: string;
  at?: number;
}

/** addEvidence 结果:失败时 graph 原样返回(未被修改)。 */
export interface AddEvidenceResult {
  ok: boolean;
  graph: EvidenceGraph;
  node?: EvidenceNode;
  code?: EvidenceCode;
}

/**
 * 追加一条证据。同 id 已存在(任意状态)→ DUPLICATE 并回既有 node(不覆盖、不改 graph);
 * 语句相同但 association 不同 → 不同 id,即两个独立节点。
 */
export function addEvidence(graph: EvidenceGraph, input: AddEvidenceInput, opts: { at?: number } = {}): AddEvidenceResult {
  if (!isGraph(graph) || !isObject(input)) return { ok: false, graph, code: EVIDENCE_CODES.INVALID_INPUT };
  if (!isKind(input.kind) || !isNonEmptyString(input.statement)) {
    return { ok: false, graph, code: EVIDENCE_CODES.INVALID_INPUT };
  }
  const at = numOr(opts.at, numOr(input.at, Date.now()));
  const id = evidenceIdOf({ kind: input.kind, statement: input.statement, associations: normalizeAssociations(input.associations) });
  const existing = graph.nodes[id];
  if (existing) return { ok: false, graph, node: existing, code: EVIDENCE_CODES.DUPLICATE };

  const node = buildFreshNode(input, id, at);
  const next = deepClone(graph);
  next.nodes[id] = node;
  return { ok: true, graph: next, node };
}

// ---------------------------------------------------------------- supersedeEvidence

export interface EvidenceVersionResult {
  ok: boolean;
  graph: EvidenceGraph;
  node?: EvidenceNode;
  code?: EvidenceCode;
}

/**
 * 用新证据取代旧版:新节点 supersedes=oldId、validFrom=at、authoritativeness="latest";
 * 旧节点 validTo=at + supersededBy=新 id(双向指针),status 保持原状(旧版保留可查)。
 */
export function supersedeEvidence(
  graph: EvidenceGraph,
  oldId: string,
  input: AddEvidenceInput,
  opts: { by?: string; reason?: string; at?: number } = {},
): EvidenceVersionResult {
  if (!isGraph(graph) || !isNonEmptyString(oldId)) return { ok: false, graph, code: EVIDENCE_CODES.INVALID_INPUT };
  if (!isObject(input) || !isKind(input.kind) || !isNonEmptyString(input.statement)) {
    return { ok: false, graph, code: EVIDENCE_CODES.INVALID_INPUT };
  }
  if (!isNonEmptyString(opts.by) || !isNonEmptyString(opts.reason)) {
    return { ok: false, graph, code: EVIDENCE_CODES.INVALID_INPUT };
  }
  const old = graph.nodes[oldId];
  if (!old) return { ok: false, graph, code: EVIDENCE_CODES.NOT_FOUND };

  const at = numOr(opts.at, Date.now());
  const baseId = evidenceIdOf({ kind: input.kind, statement: input.statement, associations: normalizeAssociations(input.associations) });
  // 新说法与原说法规范化后相同 → id 撞车,用版本 id 打散两条记录都能留下来。
  const id = graph.nodes[baseId] ? versionIdOf(oldId, at, (input.statement as string).trim()) : baseId;

  const node = buildFreshNode(input, id, at);
  node.validFrom = at;
  node.authoritativeness = "latest";
  node.supersedes = oldId;

  const next = deepClone(graph);
  next.nodes[id] = node;
  const target = next.nodes[oldId]!;
  target.validTo = at;
  target.supersededBy = id;
  target.updatedAt = at;
  return { ok: true, graph: next, node };
}

// ---------------------------------------------------------------- correctEvidence

export interface CorrectEvidenceInput {
  statement?: string;
  confidence?: number;
  by?: string;
  reason?: string;
  at?: number;
}

/**
 * 修正一条证据:生成新版本(旧版 validTo=at + supersededBy,历史保留)。
 * 新节点复制 kind/associations/source/modelVersion/projectId;observedAt=validFrom=at;
 * corrections 追加 {at, by, reason, fromStatement: 旧说法}。
 * 仅改置信度会让规范化 id 撞车,此时用版本 id = "ev-"+sha256(oldId:at:newStatement).slice(0,16)。
 */
export function correctEvidence(graph: EvidenceGraph, id: string, input: CorrectEvidenceInput): EvidenceVersionResult {
  if (!isGraph(graph) || !isNonEmptyString(id)) return { ok: false, graph, code: EVIDENCE_CODES.INVALID_INPUT };
  if (!isObject(input)) return { ok: false, graph, code: EVIDENCE_CODES.INVALID_INPUT };
  if (!isNonEmptyString(input.by) || !isNonEmptyString(input.reason)) {
    return { ok: false, graph, code: EVIDENCE_CODES.INVALID_INPUT };
  }
  const old = graph.nodes[id];
  if (!old) return { ok: false, graph, code: EVIDENCE_CODES.NOT_FOUND };

  const statement = input.statement === undefined ? old.statement : input.statement;
  if (!isNonEmptyString(statement)) return { ok: false, graph, code: EVIDENCE_CODES.INVALID_INPUT };

  const at = numOr(input.at, Date.now());
  const newStatement = statement.trim();
  const baseId = evidenceIdOf({ kind: old.kind, statement: newStatement, associations: old.associations });
  const nextId = graph.nodes[baseId] || baseId === id ? versionIdOf(id, at, newStatement) : baseId;

  const corrections = deepClone(old.corrections ?? []);
  corrections.push({ at, by: (input.by as string).trim(), reason: (input.reason as string).trim(), fromStatement: old.statement });

  const node: EvidenceNode = {
    id: nextId,
    kind: old.kind,
    statement: newStatement,
    observedAt: at,
    validFrom: at,
    confidence: input.confidence === undefined ? old.confidence : clampConfidence(input.confidence),
    source: deepClone(old.source ?? {}),
    associations: deepClone(old.associations ?? []),
    status: "active",
    corrections,
    authoritativeness: "latest",
    createdAt: at,
    updatedAt: at,
    supersedes: id,
  };
  if (old.modelVersion !== undefined) node.modelVersion = old.modelVersion;
  if (old.projectId !== undefined) node.projectId = old.projectId;

  const next = deepClone(graph);
  next.nodes[nextId] = node;
  const target = next.nodes[id]!;
  target.validTo = at;
  target.supersededBy = nextId;
  target.updatedAt = at;
  return { ok: true, graph: next, node };
}

// ---------------------------------------------------------------- markAuthoritative

export interface MarkAuthoritativeResult {
  ok: boolean;
  graph: EvidenceGraph;
  demoted: string[];
  code?: EvidenceCode;
}

/**
 * 指定权威版:目标置 authoritativeness="authoritative";
 * 冲突组(同 kind + 共享至少一个 association(type+ref) + active + 规范化 statement 不同)里
 * 其它原本 authoritative 的节点降回 "latest"。节点一个都不删。
 */
export function markAuthoritative(graph: EvidenceGraph, id: string): MarkAuthoritativeResult {
  if (!isGraph(graph) || !isNonEmptyString(id)) return { ok: false, graph, demoted: [], code: EVIDENCE_CODES.INVALID_INPUT };
  const target = graph.nodes[id];
  if (!target) return { ok: false, graph, demoted: [], code: EVIDENCE_CODES.NOT_FOUND };

  const targetKey = new Set((target.associations ?? []).map(associationGroupKey));
  const targetStatement = normalizeStatement(target.statement);
  const next = deepClone(graph);
  const chosen = next.nodes[id]!;
  chosen.authoritativeness = "authoritative";

  const demoted: string[] = [];
  for (const other of Object.values(next.nodes)) {
    if (other.id === id) continue;
    if (other.status !== "active") continue;
    if (other.kind !== chosen.kind) continue;
    if (normalizeStatement(other.statement) === targetStatement) continue;
    if (!(other.associations ?? []).some((a) => targetKey.has(associationGroupKey(a)))) continue;
    if (other.authoritativeness !== "authoritative") continue;
    other.authoritativeness = "latest";
    demoted.push(other.id);
  }
  demoted.sort(cmpStr);
  return { ok: true, graph: next, demoted };
}

// ---------------------------------------------------------------- queryEvidence

export interface EvidenceQuery {
  kind?: EvidenceNodeKind;
  projectId?: string;
  module?: string;
  tool?: string;
  tip?: string;
  at?: number;
  includeHistory?: boolean;
  authoritativeOnly?: boolean;
  status?: EvidenceStatus | EvidenceStatus[];
}

function statusSet(status: EvidenceQuery["status"]): Set<EvidenceStatus> | undefined {
  if (status === undefined) return undefined;
  const list = Array.isArray(status) ? status : [status];
  const valid = list.filter((s): s is EvidenceStatus => s === "active" || s === "stale" || s === "archived");
  return new Set(valid);
}

/**
 * 取证据。缺省只返回「at 时有效 + status==="active"」的节点;
 * includeHistory=true 时不做有效期/状态过滤(仍应用 kind/关联过滤);
 * 排序稳定:validFrom desc → observedAt desc → id asc。
 */
export function queryEvidence(graph: EvidenceGraph, filter: EvidenceQuery = {}): EvidenceNode[] {
  if (!isGraph(graph) || filter === null || typeof filter !== "object") return [];
  const at = numOr(filter.at, Date.now());
  const includeHistory = filter.includeHistory === true;
  const statuses = statusSet(filter.status);
  const refFilters: Array<[EvidenceAssociation["type"], string | undefined]> = [
    ["module", filter.module],
    ["tool", filter.tool],
    ["tip", filter.tip],
  ];

  const out: EvidenceNode[] = [];
  for (const node of Object.values(graph.nodes)) {
    if (statuses) {
      if (!statuses.has(node.status)) continue;
    } else if (!includeHistory && node.status !== "active") {
      continue;
    }
    if (!includeHistory && !isValidAt(node, at)) continue;
    if (filter.kind !== undefined && node.kind !== filter.kind) continue;
    if (filter.projectId !== undefined && node.projectId !== filter.projectId) continue;
    let associationOk = true;
    for (const [type, ref] of refFilters) {
      if (ref === undefined) continue;
      if (!(node.associations ?? []).some((a) => a.type === type && a.ref === ref)) {
        associationOk = false;
        break;
      }
    }
    if (!associationOk) continue;
    if (filter.authoritativeOnly === true && node.authoritativeness !== "authoritative") continue;
    out.push(node);
  }

  return out.sort((a, b) => {
    const byFrom = numOr(b.validFrom, 0) - numOr(a.validFrom, 0);
    if (byFrom !== 0) return byFrom;
    const byObserved = numOr(b.observedAt, 0) - numOr(a.observedAt, 0);
    if (byObserved !== 0) return byObserved;
    return cmpStr(a.id, b.id);
  });
}

// ---------------------------------------------------------------- conflictsOf

export interface EvidenceConflict {
  /** 关联键 "type:ref"。 */
  associationKey: string;
  /** 冲突按 association + kind 分组,kind 一并返回以便区分同 ref 上的不同类结论。 */
  kind: EvidenceNodeKind;
  nodes: EvidenceNode[];
  /** 组内最新版(validFrom 最大,并列取 updatedAt 大者,再并列取 id 小者)。 */
  latestId: string;
  authoritativeId?: string;
}

/**
 * 显式冲突:at 时有效的 active 节点按 association(type:ref)+kind 分组,
 * 组内规范化 statement 去重后 ≥2 才成组。只报告,不删不改——冲突并存是有信息量的状态。
 */
export function conflictsOf(graph: EvidenceGraph, at?: number): EvidenceConflict[] {
  if (!isGraph(graph)) return [];
  const ts = numOr(at, Date.now());
  const groups = new Map<string, { associationKey: string; kind: EvidenceNodeKind; nodes: Map<string, EvidenceNode> }>();

  for (const node of Object.values(graph.nodes)) {
    if (node.status !== "active") continue;
    if (!isValidAt(node, ts)) continue;
    const keys = new Set((node.associations ?? []).map(associationGroupKey));
    for (const key of keys) {
      const groupKey = `${node.kind}\u0000${key}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = { associationKey: key, kind: node.kind, nodes: new Map() };
        groups.set(groupKey, group);
      }
      group.nodes.set(node.id, node);
    }
  }

  const conflicts: EvidenceConflict[] = [];
  for (const group of groups.values()) {
    const nodes = Array.from(group.nodes.values());
    const statements = new Set(nodes.map((n) => normalizeStatement(n.statement)));
    if (statements.size < 2) continue;
    nodes.sort(cmpRecencyNewestFirst);
    const authoritative = nodes.find((n) => n.authoritativeness === "authoritative");
    const conflict: EvidenceConflict = { associationKey: group.associationKey, kind: group.kind, nodes, latestId: nodes[0]!.id };
    if (authoritative) conflict.authoritativeId = authoritative.id;
    conflicts.push(conflict);
  }

  return conflicts.sort((a, b) => cmpStr(a.associationKey, b.associationKey) || cmpStr(a.kind, b.kind));
}

// ---------------------------------------------------------------- historyOf

/**
 * 版本链:沿 supersedes 回溯到根,再沿 supersededBy 前进,返回 oldest→newest。
 * visited 防环(手改数据造出的环也只返回有限长度)。
 */
export function historyOf(graph: EvidenceGraph, id: string): EvidenceNode[] {
  if (!isGraph(graph) || !isNonEmptyString(id)) return [];
  const start = graph.nodes[id];
  if (!start) return [];

  const visited = new Set<string>([start.id]);
  let root = start;
  let cursor: EvidenceNode | undefined = start;
  while (cursor && cursor.supersedes && graph.nodes[cursor.supersedes] && !visited.has(cursor.supersedes)) {
    visited.add(cursor.supersedes);
    root = graph.nodes[cursor.supersedes]!;
    cursor = root;
  }

  const chain: EvidenceNode[] = [];
  let node: EvidenceNode | undefined = root;
  const seen = new Set<string>();
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    chain.push(node);
    node = node.supersededBy ? graph.nodes[node.supersededBy] : undefined;
  }
  return chain;
}

// ---------------------------------------------------------------- decay

/**
 * 衰减分:confidence * 0.5 ** (age/halfLifeDays),age 以 validFrom 起算、负数按 0 处理,
 * 结果 clamp 到 [0,1]。halfLifeDays<=0 表示不衰减,直接返回 confidence。
 */
export function decayScore(node: EvidenceNode, opts: { at?: number; halfLifeDays?: number } = {}): number {
  if (!isObject(node)) return 0;
  const confidence = clampConfidence(node.confidence);
  const halfLifeDays = numOr(opts.halfLifeDays, 0);
  if (!(halfLifeDays > 0)) return confidence;
  const at = numOr(opts.at, Date.now());
  const ageDays = Math.max(0, at - numOr(node.validFrom, 0)) / DAY_MS;
  return clamp01(confidence * 0.5 ** (ageDays / halfLifeDays));
}

export interface DecayPolicy {
  at?: number;
  halfLifeDays: number;
  staleBelow: number;
  archiveBelow?: number;
  maxNodes?: number;
}

export interface DecayReport {
  at: number;
  stale: number;
  archived: number;
  evicted: number;
  rescored: 0;
  staleIds: string[];
  archivedIds: string[];
  evictedIds: string[];
}

export interface DecayResult {
  ok: boolean;
  graph: EvidenceGraph;
  report: DecayReport;
  code?: EvidenceCode;
}

/**
 * 按衰减策略批量评估:score<archiveBelow → archived(archivedReason="decay",物理节点保留、validTo 不动);
 * 否则 score<staleBelow → stale;最后若给 maxNodes,在 active|stale 里按 score desc
 * (并列 validFrom desc、id asc)留前 maxNodes,其余 archived(archivedReason="capacity")。
 * archived/archivedIds 只统计衰减归档,容量逐出单独记在 evicted/evictedIds。
 */
export function applyDecay(graph: EvidenceGraph, policy: DecayPolicy): DecayResult {
  const emptyReport: DecayReport = { at: 0, stale: 0, archived: 0, evicted: 0, rescored: 0, staleIds: [], archivedIds: [], evictedIds: [] };
  if (!isGraph(graph) || !isObject(policy)) return { ok: false, graph, report: emptyReport, code: EVIDENCE_CODES.INVALID_INPUT };

  const halfLifeDays = policy.halfLifeDays;
  const staleBelow = policy.staleBelow;
  const archiveBelow = policy.archiveBelow;
  const maxNodes = policy.maxNodes;
  const policyOk =
    typeof halfLifeDays === "number" &&
    Number.isFinite(halfLifeDays) &&
    halfLifeDays > 0 &&
    typeof staleBelow === "number" &&
    Number.isFinite(staleBelow) &&
    (archiveBelow === undefined || (typeof archiveBelow === "number" && Number.isFinite(archiveBelow))) &&
    (maxNodes === undefined || (typeof maxNodes === "number" && Number.isFinite(maxNodes) && maxNodes >= 0));
  if (!policyOk) return { ok: false, graph, report: emptyReport, code: EVIDENCE_CODES.INVALID_INPUT };

  const at = numOr(policy.at, Date.now());
  const next = deepClone(graph);
  const scores = new Map<string, number>();
  const report: DecayReport = { at, stale: 0, archived: 0, evicted: 0, rescored: 0, staleIds: [], archivedIds: [], evictedIds: [] };

  for (const node of Object.values(next.nodes)) {
    const score = decayScore(node, { at, halfLifeDays });
    scores.set(node.id, score);
    if (node.status === "archived") continue;
    if (archiveBelow !== undefined && score < archiveBelow) {
      node.status = "archived";
      node.archivedReason = "decay";
      node.archivedAt = at;
      report.archivedIds.push(node.id);
      continue;
    }
    if (score < staleBelow) {
      node.status = "stale";
      node.staleAt = at;
      report.staleIds.push(node.id);
    }
  }

  if (maxNodes !== undefined) {
    const live = Object.values(next.nodes)
      .filter((n) => n.status === "active" || n.status === "stale")
      .sort((a, b) => {
        const byScore = (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0);
        if (byScore !== 0) return byScore;
        const byFrom = numOr(b.validFrom, 0) - numOr(a.validFrom, 0);
        if (byFrom !== 0) return byFrom;
        return cmpStr(a.id, b.id);
      });
    for (const node of live.slice(maxNodes)) {
      const stored = next.nodes[node.id]!;
      stored.status = "archived";
      stored.archivedReason = "capacity";
      stored.archivedAt = at;
      report.evictedIds.push(stored.id);
    }
  }

  report.stale = report.staleIds.length;
  report.archived = report.archivedIds.length;
  report.evicted = report.evictedIds.length;
  return { ok: true, graph: next, report };
}

// ---------------------------------------------------------------- model version

export interface RescoreResult {
  ok: boolean;
  graph: EvidenceGraph;
  rescored: string[];
  code?: EvidenceCode;
}

/**
 * 模型换代后,挂在旧模型版本上的 active 证据置 stale(staleReason="model-version"):
 * 换模型不等于旧结论错了,但必须复核——所以不归档、不删。
 */
export function rescoreForModelVersion(graph: EvidenceGraph, modelVersion: string, opts: { at?: number } = {}): RescoreResult {
  if (!isGraph(graph) || !isNonEmptyString(modelVersion)) {
    return { ok: false, graph, rescored: [], code: EVIDENCE_CODES.INVALID_INPUT };
  }
  const at = numOr(opts.at, Date.now());
  const next = deepClone(graph);
  const rescored: string[] = [];
  for (const node of Object.values(next.nodes)) {
    if (node.status !== "active") continue;
    if (node.modelVersion === undefined) continue;
    if (node.modelVersion === modelVersion) continue;
    node.status = "stale";
    node.staleReason = "model-version";
    node.staleAt = at;
    rescored.push(node.id);
  }
  rescored.sort(cmpStr);
  return { ok: true, graph: next, rescored };
}
