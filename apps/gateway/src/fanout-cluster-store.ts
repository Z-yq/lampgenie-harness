/**
 * 扇出簇持久层(生产侧,扇出返工簇 2026-11):把 fanout-cluster 的纯逻辑落到 append-only jsonl。
 * 为什么 append-only:一个簇「当时是怎么判的」是审计事实——变更、修复、簇结论、门的结论
 * 都是判断的历史,不能被后来的写入覆盖;而且逐条追加让「新修复到达 → 重估簇」可重放。
 * 单行追加 + 写后重读行数校验让「写成功了吗」成为可复核断言。
 * 数据面:`<root>/.genie/rsi/fanout.jsonl`,每行 `{v:1,type,at,...}`
 * - change   {change}                          变更节点(实体/原型/时间/可选辐射面清单)
 * - fix      {fix}                             修复事件(实体/时间/踩到的依赖边)
 * - cluster  {cluster}                         detectClusters 产出的簇(同 id 不重复落行 → 幂等)
 * - gate     {archetype,ok,codes,missing}      辐射面门的判定留痕
 * 投影语义(loadFanout):按行序归并,同 id 后写覆盖(change/fix/cluster);
 * gate 直接按序累积。坏行(JSON 坏 / v 不是 1 / type 未知 / 缺载荷)只计入 parseErrors 并跳过:
 * 一行坏不整文件失效、不 throw。
 * 依赖纪律:node:fs / node:path + 同目录 evidence-graph-store(投影写入)+ runtime 的纯逻辑模块;
 * 不引 agent loop、不引 gateway 其余业务模块。runtime 模块按 defect-lineage-store 的既有套路惰性解析(两跳):
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 除参数错误外不 throw:IO/投影/闸门失败一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ChangeNode,
  ClassifyResult,
  ClusterToGraphResult,
  ContractType,
  FanoutArchetype,
  FanoutCluster,
  FanoutVerdict,
  FixEvent,
  RadiationChecklist,
  RadiationGateInput,
  RadiationGateResult,
  RequiredChecklistResult,
} from "@lampgenie/runtime/agent/fanout-cluster";
import type { AddEvidenceInput } from "@lampgenie/runtime/agent/evidence-graph";
import type { EvidenceProjection } from "./evidence-graph-store";

/** store 稳定码:store 层自产的失败码(簇/门码沿用 runtime 的 FANOUT_CODES)。 */
export const FANOUT_STORE_CODES = [
  "FANOUT_DUPLICATE",
  "FANOUT_NOT_FOUND",
  "FANOUT_INVALID_INPUT",
  "FANOUT_LEDGER_WRITE_VERIFY_FAILED",
  "FANOUT_STORE_ERROR",
  "FANOUT_GRAPH_PROJECTED",
  "FANOUT_GRAPH_FAILED",
] as const;

export type FanoutStoreCode = (typeof FANOUT_STORE_CODES)[number];

/** 落盘行类型(只增不改)。 */
export const FANOUT_LINE_TYPES = ["change", "fix", "cluster", "gate"] as const;

export type FanoutLineType = (typeof FANOUT_LINE_TYPES)[number];

/** gate 留痕记录(投影后可直接报表)。 */
export interface FanoutGateRecord {
  at: number;
  archetype: string;
  ok: boolean;
  codes: string[];
  missing?: string[];
}

export interface FanoutChangeLine {
  v: 1;
  type: "change";
  at: number;
  change: ChangeNode;
}

export interface FanoutFixLine {
  v: 1;
  type: "fix";
  at: number;
  fix: FixEvent;
}

export interface FanoutClusterLine {
  v: 1;
  type: "cluster";
  at: number;
  cluster: FanoutCluster;
}

export interface FanoutGateLine {
  v: 1;
  type: "gate";
  at: number;
  archetype: string;
  ok: boolean;
  codes: string[];
  missing?: string[];
}

export type FanoutLine = FanoutChangeLine | FanoutFixLine | FanoutClusterLine | FanoutGateLine;

/** 投影结果:三张实体表 + 门留痕 + 坏行计数。 */
export interface FanoutProjection {
  changes: Map<string, ChangeNode>;
  fixes: Map<string, FixEvent>;
  clusters: Map<string, FanoutCluster>;
  gates: FanoutGateRecord[];
  parseErrors: number;
  totalLines: number;
  /** 坏行的 1-based 行号(便于人去文件里定位)。 */
  badLines: number[];
}

export interface FanoutRecordResult {
  ok: boolean;
  code?: string;
  id?: string;
}

export interface FanoutDetectResult {
  ok: boolean;
  code?: string;
  ids: string[];
  clusters: FanoutCluster[];
  codes: string[];
}

export interface FanoutListResult {
  ok: boolean;
  code?: string;
  clusters: FanoutCluster[];
  parseErrors: number;
  totalLines: number;
}

export interface FanoutClassifyStoreResult extends ClassifyResult {
  ok: boolean;
  code?: string;
  clusterId?: string;
}

export interface FanoutGateStoreResult extends RadiationGateResult {
  written: boolean;
}

export interface FanoutProjectToGraphResult {
  ok: boolean;
  code?: string;
  ids: string[];
  nodes: number;
  codes: string[];
}

export interface FanoutReport {
  ok: true;
  totalLines: number;
  parseErrors: number;
  badLines: number[];
  changes: number;
  fixes: number;
  clusters: number;
  gates: number;
  byVerdict: Record<string, number>;
  byEdgeType: Record<string, number>;
  gateRejected: number;
}

/** runtime fanout-cluster 在本文件用到的模块面。 */
interface FanoutRuntime {
  readonly FANOUT_VERSION: number;
  readonly FANOUT_CODES: Record<string, string>;
  detectClusters(
    input: { changes: ChangeNode[]; fixes: FixEvent[] },
    opts?: { windowDays?: number; minFixes?: number },
  ): { clusters: FanoutCluster[]; codes: string[] };
  classifyCluster(cluster: FanoutCluster, opts?: { now?: number }): ClassifyResult;
  requiredChecklist(archetype: string): RequiredChecklistResult;
  evaluateRadiationGate(input: RadiationGateInput): RadiationGateResult;
  clusterToGraphNodes(cluster: FanoutCluster): ClusterToGraphResult;
}

let fanoutRuntime: FanoutRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadFanoutRuntime(): Promise<FanoutRuntime> {
  if (fanoutRuntime) return fanoutRuntime;
  const spec = "@lampgenie/runtime/agent/fanout-cluster";
  try {
    fanoutRuntime = (await import(spec)) as FanoutRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/fanout-cluster.ts", import.meta.url).href;
    fanoutRuntime = (await import(srcUrl)) as FanoutRuntime;
  }
  return fanoutRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadFanoutRuntime();

/** 同目录证据图持久层面(裸 node strip-types 下相对导入必须带 .ts,故用动态字面量解出两个函数)。 */
interface EvidenceStoreRuntime {
  addEvidence(root: string, input: AddEvidenceInput): { ok: boolean; code?: string; id?: string };
  loadEvidenceGraph(root: string): EvidenceProjection;
}

const evidenceStoreSpec = "./evidence-graph-store.ts";
const evidenceStore = (await import(evidenceStoreSpec)) as EvidenceStoreRuntime;
const addEvidence = evidenceStore.addEvidence;
const loadEvidenceGraph = evidenceStore.loadEvidenceGraph;

const ARCHETYPES: ReadonlySet<string> = new Set<string>([
  "integration-replace",
  "public-contract-change",
  "delete-or-semantic-change",
  "other",
]);
const LINE_TYPES: ReadonlySet<string> = new Set<string>(FANOUT_LINE_TYPES);
const VERDICTS: ReadonlySet<string> = new Set<string>(["impact-not-closed", "batched-delivery", "insufficient-evidence"]);

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

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value.slice() as string[];
}

/** 扇出台账文件绝对路径:`<root>/.genie/rsi/fanout.jsonl`。 */
export function fanoutClusterPath(root: string): string {
  return join(root, ".genie", "rsi", "fanout.jsonl");
}

/** 统计文件非空行数;文件不存在/读失败按 0。 */
function countLines(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") n += 1;
  return n;
}

/** 追加一行并做写后行数校验;失败折叠成 FANOUT_LEDGER_WRITE_VERIFY_FAILED,不回滚、不 throw。 */
function appendFanoutLine(root: string, line: FanoutLine): boolean {
  const path = fanoutClusterPath(root);
  const before = countLines(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    return false;
  }
  return countLines(path) === before + 1;
}

function normalizeChecklist(value: unknown): RadiationChecklist | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined;
  const items: RadiationChecklist["items"] = [];
  for (const raw of value.items) {
    if (!isRecord(raw) || !isFilled(raw.key)) continue;
    const item: RadiationChecklist["items"][number] = { key: raw.key as RadiationChecklist["items"][number]["key"] };
    if (isFilled(raw.evidence)) item.evidence = raw.evidence.trim();
    items.push(item);
  }
  const checklist: RadiationChecklist = { items };
  if (isFiniteNumber(value.producedAt)) checklist.producedAt = value.producedAt;
  return checklist;
}

/** 宽松读一条变更:必填 id/taskId/at/files 且 entity 或 module 至少一个;archetype 非法按 other。 */
function normalizeChange(value: unknown): ChangeNode | undefined {
  if (!isRecord(value)) return undefined;
  if (!isFilled(value.id) || !isFilled(value.taskId)) return undefined;
  if (!isFiniteNumber(value.at)) return undefined;
  const files = stringArray(value.files);
  if (!files) return undefined;
  if (!isFilled(value.entity) && !isFilled(value.module)) return undefined;
  const archetype: FanoutArchetype =
    isFilled(value.archetype) && ARCHETYPES.has(value.archetype) ? (value.archetype as FanoutArchetype) : "other";
  const change: ChangeNode = {
    id: value.id.trim(),
    entity: isFilled(value.entity) ? value.entity.trim() : "",
    files,
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

/** 宽松读一条修复:必填 id/taskId/at/files/edges;坏边直接丢弃(由 runtime 复核并标 INVALID)。 */
function normalizeFix(value: unknown): FixEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (!isFilled(value.id) || !isFilled(value.taskId)) return undefined;
  if (!isFiniteNumber(value.at)) return undefined;
  const files = stringArray(value.files);
  if (!files || !Array.isArray(value.edges)) return undefined;
  const fix: FixEvent = {
    id: value.id.trim(),
    taskId: value.taskId.trim(),
    at: value.at,
    files,
    edges: [],
    description: isFilled(value.description) ? value.description.trim() : "",
  };
  for (const raw of value.edges) {
    if (!isRecord(raw) || !isFilled(raw.from) || !isFilled(raw.to) || !isFilled(raw.contractType)) continue;
    fix.edges.push({ from: raw.from.trim(), to: raw.to.trim(), contractType: raw.contractType as ContractType });
  }
  if (isFilled(value.entity)) fix.entity = value.entity.trim();
  if (isFilled(value.module)) fix.module = value.module.trim();
  if (value.expectedInPlan === true) fix.expectedInPlan = true;
  return fix;
}

function normalizeCluster(value: unknown): FanoutCluster | undefined {
  if (!isRecord(value)) return undefined;
  if (!isFilled(value.id)) return undefined;
  if (!isFilled(value.entity)) return undefined;
  const change = normalizeChange(value.change);
  if (!change) return undefined;
  if (!Array.isArray(value.fixes)) return undefined;
  const fixes: FixEvent[] = [];
  for (const raw of value.fixes) {
    const fix = normalizeFix(raw);
    if (fix) fixes.push(fix);
  }
  const edgeTypes = Array.isArray(value.edgeTypes)
    ? (value.edgeTypes.filter((type) => typeof type === "string") as ContractType[])
    : [];
  const edgeKeys = stringArray(value.edgeKeys) ?? [];
  const verdict: FanoutVerdict =
    isFilled(value.verdict) && VERDICTS.has(value.verdict) ? (value.verdict as FanoutVerdict) : "insufficient-evidence";
  const codes = (stringArray(value.codes) ?? []) as FanoutCluster["codes"];
  const window = isRecord(value.window) && isFiniteNumber(value.window.from) && isFiniteNumber(value.window.to)
    ? { from: value.window.from, to: value.window.to }
    : { from: change.at, to: change.at };
  const size = isFiniteNumber(value.size) ? value.size : fixes.length;
  return { id: value.id.trim(), entity: value.entity.trim(), window, change, fixes, edgeTypes, edgeKeys, size, verdict, codes };
}

/** 投影:按行序归并(latest wins),坏行计 parseErrors 跳过。 */
export function loadFanout(root: string): FanoutProjection {
  const path = fanoutClusterPath(root);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { changes: new Map(), fixes: new Map(), clusters: new Map(), gates: [], parseErrors: 0, totalLines: 0, badLines: [] };
  }
  const rawLines = text.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();

  const changes = new Map<string, ChangeNode>();
  const fixes = new Map<string, FixEvent>();
  const clusters = new Map<string, FanoutCluster>();
  const gates: FanoutGateRecord[] = [];
  const badLines: number[] = [];
  let parseErrors = 0;
  let totalLines = 0;

  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index]!;
    if (raw.trim() === "") continue;
    totalLines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parseErrors += 1;
      badLines.push(index + 1);
      continue;
    }
    if (!isRecord(parsed) || parsed.v !== 1 || !isFilled(parsed.type) || !LINE_TYPES.has(parsed.type)) {
      parseErrors += 1;
      badLines.push(index + 1);
      continue;
    }
    const type = parsed.type as FanoutLineType;
    if (type === "change") {
      const change = normalizeChange(parsed.change);
      if (!change) {
        parseErrors += 1;
        badLines.push(index + 1);
        continue;
      }
      changes.set(change.id, change);
      continue;
    }
    if (type === "fix") {
      const fix = normalizeFix(parsed.fix);
      if (!fix) {
        parseErrors += 1;
        badLines.push(index + 1);
        continue;
      }
      fixes.set(fix.id, fix);
      continue;
    }
    if (type === "cluster") {
      const cluster = normalizeCluster(parsed.cluster);
      if (!cluster) {
        parseErrors += 1;
        badLines.push(index + 1);
        continue;
      }
      clusters.set(cluster.id, cluster);
      continue;
    }
    if (type === "gate") {
      if (!isFilled(parsed.archetype)) {
        parseErrors += 1;
        badLines.push(index + 1);
        continue;
      }
      const gate: FanoutGateRecord = {
        at: isFiniteNumber(parsed.at) ? parsed.at : 0,
        archetype: parsed.archetype.trim(),
        ok: parsed.ok === true,
        codes: stringArray(parsed.codes) ?? [],
      };
      const missing = stringArray(parsed.missing);
      if (missing) gate.missing = missing;
      gates.push(gate);
    }
  }

  return { changes, fixes, clusters, gates, parseErrors, totalLines, badLines };
}

/** 登记变更:同 id 已存在 → FANOUT_DUPLICATE(不覆盖,append-only 保留历史)。 */
export function recordChange(root: string, change: unknown, opts: { now?: number } = {}): FanoutRecordResult {
  if (!isFilled(root)) return { ok: false, code: "FANOUT_INVALID_INPUT" };
  const normalized = normalizeChange(change);
  if (!normalized) return { ok: false, code: "FANOUT_INVALID_INPUT" };
  const projection = loadFanout(root);
  if (projection.changes.has(normalized.id)) return { ok: false, code: "FANOUT_DUPLICATE", id: normalized.id };
  const at = opts.now ?? Date.now();
  if (!appendFanoutLine(root, { v: 1, type: "change", at, change: normalized })) {
    return { ok: false, code: "FANOUT_LEDGER_WRITE_VERIFY_FAILED" };
  }
  return { ok: true, id: normalized.id };
}

/** 登记修复:同 id 已存在 → FANOUT_DUPLICATE。 */
export function recordFix(root: string, fix: unknown, opts: { now?: number } = {}): FanoutRecordResult {
  if (!isFilled(root)) return { ok: false, code: "FANOUT_INVALID_INPUT" };
  const normalized = normalizeFix(fix);
  if (!normalized) return { ok: false, code: "FANOUT_INVALID_INPUT" };
  const projection = loadFanout(root);
  if (projection.fixes.has(normalized.id)) return { ok: false, code: "FANOUT_DUPLICATE", id: normalized.id };
  const at = opts.now ?? Date.now();
  if (!appendFanoutLine(root, { v: 1, type: "fix", at, fix: normalized })) {
    return { ok: false, code: "FANOUT_LEDGER_WRITE_VERIFY_FAILED" };
  }
  return { ok: true, id: normalized.id };
}

/**
 * 跑聚簇并把「新簇」落行:同 id 已存在则跳过(幂等)。
 * 每次调用都从投影重跑 detectClusters,保证「新修复到达 → 重估」不依赖内存状态。
 */
export function detectAndSave(
  root: string,
  opts: { windowDays?: number; minFixes?: number; now?: number } = {},
): FanoutDetectResult {
  if (!isFilled(root)) return { ok: false, code: "FANOUT_INVALID_INPUT", ids: [], clusters: [], codes: [] };
  const projection = loadFanout(root);
  const result = rt.detectClusters(
    { changes: [...projection.changes.values()], fixes: [...projection.fixes.values()] },
    { windowDays: opts.windowDays, minFixes: opts.minFixes },
  );
  const at = opts.now ?? Date.now();
  const ids: string[] = [];
  const saved: FanoutCluster[] = [];
  const codes = [...result.codes];
  for (const cluster of result.clusters) {
    if (projection.clusters.has(cluster.id)) continue;
    if (!appendFanoutLine(root, { v: 1, type: "cluster", at, cluster })) {
      return { ok: false, code: "FANOUT_LEDGER_WRITE_VERIFY_FAILED", ids, clusters: saved, codes };
    }
    ids.push(cluster.id);
    saved.push(cluster);
  }
  return { ok: true, ids, clusters: saved, codes };
}

/** 列簇(可按 verdict 过滤),按窗口起点升序。 */
export function listClusters(root: string, filter: { verdict?: string } = {}): FanoutListResult {
  if (!isFilled(root)) return { ok: false, code: "FANOUT_INVALID_INPUT", clusters: [], parseErrors: 0, totalLines: 0 };
  const projection = loadFanout(root);
  let clusters = [...projection.clusters.values()];
  if (isFilled(filter.verdict)) clusters = clusters.filter((cluster) => cluster.verdict === filter.verdict);
  clusters.sort((a, b) => a.window.from - b.window.from || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ok: true, clusters, parseErrors: projection.parseErrors, totalLines: projection.totalLines };
}

/** 重判某个已落盘的簇(runtime 分类逻辑的唯一入口,避免两处口径漂移)。 */
export function classifyStoredCluster(root: string, id: string, opts: { now?: number } = {}): FanoutClassifyStoreResult {
  if (!isFilled(root) || !isFilled(id)) {
    return { ok: false, code: "FANOUT_INVALID_INPUT", verdict: "insufficient-evidence", codes: [], rationale: "参数非法" };
  }
  const projection = loadFanout(root);
  const cluster = projection.clusters.get(id.trim());
  if (!cluster) {
    return { ok: false, code: "FANOUT_NOT_FOUND", verdict: "insufficient-evidence", codes: [], rationale: `未找到簇 ${id}` };
  }
  const result = rt.classifyCluster(cluster, { now: opts.now });
  return { ...result, ok: true, clusterId: cluster.id };
}

/** 辐射面门:判定 + 留痕(gate 行);参数非法也如实返回,不 throw。 */
export function radiationGate(root: string, input: RadiationGateInput, opts: { now?: number } = {}): FanoutGateStoreResult {
  const result = rt.evaluateRadiationGate(input);
  if (!isFilled(root)) return { ...result, written: false };
  const archetype = isFilled(input?.archetype) ? input.archetype.trim() : "";
  if (archetype === "" || result.codes.includes("FANOUT_INVALID")) return { ...result, written: false };
  const at = opts.now ?? Date.now();
  const line: FanoutGateLine = { v: 1, type: "gate", at, archetype, ok: result.ok, codes: [...result.codes] };
  if (result.missing !== undefined) line.missing = [...result.missing];
  const written = appendFanoutLine(root, line);
  return { ...result, written };
}

/** 找出同 kind + 同 statement + 同 associations 的既有证据节点(DUPLICATE 时复用 id)。 */
function findExistingNodeId(graphRoot: string, input: { kind: string; statement: string; associations: { type: string; ref: string; label?: string }[] }): string | undefined {
  const projection = loadEvidenceGraph(graphRoot);
  const wanted = input.associations
    .map((assoc) => `${assoc.type}:${assoc.ref}:${assoc.label ?? ""}`)
    .sort()
    .join("|");
  for (const node of Object.values(projection.graph.nodes)) {
    if (node.kind !== input.kind || node.statement !== input.statement) continue;
    const actual = (node.associations ?? [])
      .map((assoc) => `${assoc.type}:${assoc.ref}:${assoc.label ?? ""}`)
      .sort()
      .join("|");
    if (actual === wanted) return node.id;
  }
  return undefined;
}

/** 把簇投影成证据图节点(anti-pattern + direction);重复节点复用既有 id。 */
export function projectToGraph(
  root: string,
  clusterId: string,
  opts: { graphRoot: string; now?: number },
): FanoutProjectToGraphResult {
  if (!isFilled(root) || !isFilled(clusterId) || !isRecord(opts) || !isFilled(opts.graphRoot)) {
    return { ok: false, code: "FANOUT_INVALID_INPUT", ids: [], nodes: 0, codes: ["FANOUT_GRAPH_FAILED"] };
  }
  const projection = loadFanout(root);
  const cluster = projection.clusters.get(clusterId.trim());
  if (!cluster) return { ok: false, code: "FANOUT_NOT_FOUND", ids: [], nodes: 0, codes: ["FANOUT_GRAPH_FAILED"] };
  const converted = rt.clusterToGraphNodes(cluster);
  if (!converted.ok || converted.nodes.length === 0) {
    return { ok: false, code: "FANOUT_GRAPH_FAILED", ids: [], nodes: 0, codes: converted.codes };
  }
  const at = opts.now ?? Date.now();
  const ids: string[] = [];
  const codes: string[] = [...converted.codes];
  for (const node of converted.nodes) {
    const result = addEvidence(opts.graphRoot, {
      kind: node.kind,
      statement: node.statement,
      associations: node.associations,
      confidence: node.confidence,
      source: { note: `fanout-cluster:${cluster.id}` },
      at,
    });
    if (result.ok && result.id !== undefined) {
      ids.push(result.id);
      continue;
    }
    if (result.code === "EVIDENCE_DUPLICATE") {
      const existingId = findExistingNodeId(opts.graphRoot, node);
      if (existingId === undefined) {
        return { ok: false, code: "FANOUT_GRAPH_FAILED", ids, nodes: ids.length, codes: ["FANOUT_GRAPH_FAILED"] };
      }
      ids.push(existingId);
      if (!codes.includes("EVIDENCE_DUPLICATE")) codes.push("EVIDENCE_DUPLICATE");
      continue;
    }
    return { ok: false, code: "FANOUT_GRAPH_FAILED", ids, nodes: ids.length, codes: ["FANOUT_GRAPH_FAILED"] };
  }
  return { ok: true, code: "FANOUT_GRAPH_PROJECTED", ids, nodes: ids.length, codes };
}

/** 原型的必备清单子集 + 机械化命令提示(runtime 唯一口径的透出)。 */
export function requiredChecklistFor(archetype: string): RequiredChecklistResult {
  return rt.requiredChecklist(archetype);
}

/** 报表:簇按 verdict / 边类型聚合,门被拒次数与坏行原样给出。 */
export function reportFanout(root: string): FanoutReport {
  if (!isFilled(root)) {
    return {
      ok: true,
      totalLines: 0,
      parseErrors: 0,
      badLines: [],
      changes: 0,
      fixes: 0,
      clusters: 0,
      gates: 0,
      byVerdict: {},
      byEdgeType: {},
      gateRejected: 0,
    };
  }
  const projection = loadFanout(root);
  const byVerdict: Record<string, number> = {};
  const byEdgeType: Record<string, number> = {};
  for (const cluster of projection.clusters.values()) {
    byVerdict[cluster.verdict] = (byVerdict[cluster.verdict] ?? 0) + 1;
    for (const type of cluster.edgeTypes) byEdgeType[type] = (byEdgeType[type] ?? 0) + 1;
  }
  return {
    ok: true,
    totalLines: projection.totalLines,
    parseErrors: projection.parseErrors,
    badLines: projection.badLines,
    changes: projection.changes.size,
    fixes: projection.fixes.size,
    clusters: projection.clusters.size,
    gates: projection.gates.length,
    byVerdict,
    byEdgeType,
    gateRejected: projection.gates.filter((gate) => !gate.ok).length,
  };
}
