/**
 * 证据图谱持久层(生产侧,证据图谱 2026-11):把 evidence-graph 的纯逻辑落到 append-only jsonl。
 * 为什么 append-only:证据/结论的历史版本本身就是审计事实——修正、取代、权威指定、衰减归档
 * 都不能靠读改写整文件把旧状态抹掉。单行追加 + 写后重读行数校验让「写成功了吗」成为可复核断言。
 * 数据面:`<root>/.genie/evidence/graph.jsonl`,每行 {v:1,type,at,...}
 * - add          {node}                             新证据(含双时态字段与关联)
 * - supersede    {oldId,by,reason,node}             新版本取代旧版(旧版 validTo/supersededBy 由投影补)
 * - correct      {id,by,reason,patch:{validTo,supersededBy},node} 用户纠正生成新版本
 * - authoritative{id,demoted:[{id,authoritativeness}]} 权威版指定 + 组内降级
 * - decay        {policy,updates:[{id,status?,...}],report} 衰减/容量逐出(状态而非物理删)
 * 投影语义(loadEvidenceGraph):
 * - node 载荷按 node.id upsert(latest wins);supersede/correct 的 patch 套到被指向的 id;
 *   authoritative 的 demoted 逐条赋值;decay 的 updates 逐条赋值。
 * - 坏行(JSON 坏 / 未知 v / 缺必需字段)只计入 parseErrors 并跳过:一行坏不整文件失效、不 throw。
 * 依赖纪律:node:fs / node:path + runtime 的纯逻辑模块;不引 agent loop、不引 gateway 业务模块。
 * runtime 模块按 experiment-store 的既有套路惰性解析(两跳):
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 除参数错误外不 throw:IO/投影/闸门失败一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AddEvidenceInput,
  CorrectEvidenceInput,
  DecayPolicy,
  DecayReport,
  EvidenceConflict,
  EvidenceGraph,
  EvidenceNode,
  EvidenceQuery,
} from "@lampgenie/runtime/agent/evidence-graph";

/** store 稳定码:store 层自产的失败码(闸门码沿用 runtime 的 EVIDENCE_CODES)。 */
export const EVIDENCE_STORE_CODES = [
  "EVIDENCE_DUPLICATE",
  "EVIDENCE_NOT_FOUND",
  "EVIDENCE_INVALID_INPUT",
  "EVIDENCE_LEDGER_WRITE_VERIFY_FAILED",
  "EVIDENCE_STORE_ERROR",
] as const;

export type EvidenceStoreCode = (typeof EVIDENCE_STORE_CODES)[number];

/** 投影结果:可用图谱 + 坏行/总行计数。 */
export interface EvidenceProjection {
  graph: EvidenceGraph;
  parseErrors: number;
  totalLines: number;
}

/** 单次写入结果。 */
export interface EvidenceStoreResult {
  ok: boolean;
  code?: string;
  id?: string;
}

/** 衰减写入结果。 */
export interface EvidenceStoreDecayResult {
  ok: boolean;
  code?: string;
  report?: DecayReport;
}

/** 模型版本重估结果:rescored 为受影响 id;preview=true 表示未写盘。 */
export interface EvidenceStoreRescoreResult {
  ok: boolean;
  code?: string;
  rescored: string[];
  ids?: string[];
  statuses?: Record<string, string>;
  preview?: boolean;
}

/** 汇总报告。 */
export interface EvidenceReport {
  ok: true;
  totalLines: number;
  parseErrors: number;
  nodes: number;
  active: number;
  stale: number;
  archived: number;
  conflicts: number;
  byKind: Record<string, number>;
}

/** runtime evidence-graph 在本文件用到的模块面。 */
interface EvidenceRuntime {
  readonly EVIDENCE_SCHEMA_VERSION: number;
  createEvidenceGraph(): EvidenceGraph;
  addEvidence(
    graph: EvidenceGraph,
    input: AddEvidenceInput,
    opts?: { at?: number },
  ): { ok: boolean; graph: EvidenceGraph; node?: EvidenceNode; code?: string };
  supersedeEvidence(
    graph: EvidenceGraph,
    oldId: string,
    input: AddEvidenceInput,
    opts?: { by?: string; reason?: string; at?: number },
  ): { ok: boolean; graph: EvidenceGraph; node?: EvidenceNode; code?: string };
  correctEvidence(
    graph: EvidenceGraph,
    id: string,
    input: CorrectEvidenceInput): { ok: boolean; graph: EvidenceGraph; node?: EvidenceNode; code?: string };
  markAuthoritative(
    graph: EvidenceGraph,
    id: string): { ok: boolean; graph: EvidenceGraph; demoted: string[]; code?: string };
  queryEvidence(graph: EvidenceGraph, filter?: EvidenceQuery): EvidenceNode[];
  conflictsOf(graph: EvidenceGraph, at?: number): EvidenceConflict[];
  historyOf(graph: EvidenceGraph, id: string): EvidenceNode[];
  applyDecay(
    graph: EvidenceGraph,
    policy: DecayPolicy): { ok: boolean; graph: EvidenceGraph; report: DecayReport; code?: string };
  rescoreForModelVersion(
    graph: EvidenceGraph,
    modelVersion: string,
    opts?: { at?: number },
  ): { ok: boolean; graph: EvidenceGraph; rescored: string[]; code?: string };
}

/**
 * runtime 面:静态导入。
 * 旧实现是「两跳动态 import + 顶层 await」,在 dist/gateway.mjs 里退化成运行时解析:
 * 解析到的 @lampgenie/runtime/agent/evidence-graph 自身 dist 带无扩展名相对导入 → 解析失败
 * → 回落 import 一个 .ts URL → 再失败 → 该顶层 await 的 promise 永不 settle,整包模块图挂住,
 * 网关启动即静默 exit 13(依据)。bundle 本就把 runtime 内联,静态导入零成本。
 */
import * as rt from "@lampgenie/runtime/agent/evidence-graph";

/** 图谱文件绝对路径:`<root>/.genie/evidence/graph.jsonl`。 */
export function evidenceGraphPath(root: string): string {
  return join(root, ".genie", "evidence", "graph.jsonl");
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NODE_STATUSES: ReadonlySet<string> = new Set<string>(["active", "stale", "archived"]);

const LINE_TYPES: ReadonlySet<string> = new Set<string>([
  "add",
  "supersede",
  "correct",
  "authoritative",
  "decay",
  "rescore",
]);

/** 节点必需字段校验:缺字段/类型不符 → false(由调用方计 parseErrors 并跳过)。 */
function isNode(value: unknown): value is EvidenceNode {
  if (!isRecord(value)) return false;
  if (typeof value["id"] !== "string" || value["id"].trim() === "") return false;
  if (typeof value["kind"] !== "string") return false;
  if (typeof value["statement"] !== "string") return false;
  if (typeof value["observedAt"] !== "number" || typeof value["validFrom"] !== "number") return false;
  if (typeof value["confidence"] !== "number") return false;
  if (typeof value["status"] !== "string" || !NODE_STATUSES.has(value["status"])) return false;
  if (!Array.isArray(value["associations"])) return false;
  if (!Array.isArray(value["corrections"])) return false;
  if (typeof value["authoritativeness"] !== "string") return false;
  if (typeof value["createdAt"] !== "number" || typeof value["updatedAt"] !== "number") return false;
  return true;
}

/** 一条 decay 行的单节点状态补丁。 */
interface DecayUpdate {
  id: string;
  status?: EvidenceNode["status"];
  archivedReason?: string;
  archivedAt?: number;
  staleAt?: number;
  staleReason?: string;
}

type EvidenceLine =
  | { v: 1; type: "add"; at: number; node: EvidenceNode }
  | { v: 1; type: "supersede"; at: number; oldId: string; by?: string; reason?: string; node: EvidenceNode }
  | {
      v: 1;
      type: "correct";
      at: number;
      id: string;
      by?: string;
      reason?: string;
      patch: { validTo: number; supersededBy: string };
      node: EvidenceNode;
    }
  | { v: 1; type: "authoritative"; at: number; id: string; demoted: Array<{ id: string; authoritativeness: "latest" }> }
  | { v: 1; type: "decay"; at: number; policy: DecayPolicy; updates: DecayUpdate[]; report: DecayReport }
  | { v: 1; type: "rescore"; at: number; modelVersion: string; ids: string[]; statuses: Record<string, string> };

/** 解析一行;坏行返回 undefined(不 throw)。 */
function parseLine(raw: string): EvidenceLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value["v"] !== 1) return undefined;
  const type = value["type"];
  if (typeof type !== "string" || !LINE_TYPES.has(type)) return undefined;
  if (typeof value["at"] !== "number") return undefined;

  switch (type) {
    case "add":
      return isNode(value["node"]) ? (value as unknown as EvidenceLine) : undefined;
    case "supersede":
      if (typeof value["oldId"] !== "string" || !isNode(value["node"])) return undefined;
      return value as unknown as EvidenceLine;
    case "correct": {
      if (typeof value["id"] !== "string" || !isNode(value["node"])) return undefined;
      const patch = value["patch"];
      if (!isRecord(patch) || typeof patch["validTo"] !== "number" || typeof patch["supersededBy"] !== "string") {
        return undefined;
      }
      return value as unknown as EvidenceLine;
    }
    case "authoritative":
      if (typeof value["id"] !== "string" || !Array.isArray(value["demoted"])) return undefined;
      return value as unknown as EvidenceLine;
    case "decay":
      if (!Array.isArray(value["updates"])) return undefined;
      return value as unknown as EvidenceLine;
    case "rescore":
      if (typeof value["modelVersion"] !== "string" || !Array.isArray(value["ids"])) return undefined;
      if (!isRecord(value["statuses"])) return undefined;
      return value as unknown as EvidenceLine;
    default:
      return undefined;
  }
}

/** 把一行套进图(latest wins);坏行已在 parseLine 拦截。 */
function applyLine(graph: EvidenceGraph, line: EvidenceLine): void {
  switch (line.type) {
    case "add": {
      graph.nodes[line.node.id] = line.node;
      return;
    }
    case "supersede": {
      graph.nodes[line.node.id] = line.node;
      const old = graph.nodes[line.oldId];
      if (old) {
        old.validTo = line.at;
        old.supersededBy = line.node.id;
        old.updatedAt = line.at;
      }
      return;
    }
    case "correct": {
      graph.nodes[line.node.id] = line.node;
      const old = graph.nodes[line.id];
      if (old) {
        old.validTo = line.patch.validTo;
        old.supersededBy = line.patch.supersededBy;
        old.updatedAt = line.at;
      }
      return;
    }
    case "authoritative": {
      const chosen = graph.nodes[line.id];
      if (chosen) chosen.authoritativeness = "authoritative";
      for (const item of line.demoted) {
        const node = graph.nodes[item.id];
        if (node) node.authoritativeness = item.authoritativeness;
      }
      return;
    }
    case "decay": {
      for (const update of line.updates) {
        const node = graph.nodes[update.id];
        if (!node) continue;
        if (update.status !== undefined) node.status = update.status;
        if (update.archivedReason !== undefined) node.archivedReason = update.archivedReason;
        if (update.archivedAt !== undefined) node.archivedAt = update.archivedAt;
        if (update.staleAt !== undefined) node.staleAt = update.staleAt;
        if (update.staleReason !== undefined) node.staleReason = update.staleReason;
      }
      return;
    }
    case "rescore": {
      for (const id of line.ids) {
        const node = graph.nodes[id];
        if (!node) continue;
        const status = line.statuses[id];
        if (status !== undefined && NODE_STATUSES.has(status)) node.status = status as EvidenceNode["status"];
        if (node.status === "stale") {
          node.staleReason = "model-version";
          node.staleAt = line.at;
        }
        node.updatedAt = line.at;
      }
      return;
    }
  }
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

/**
 * 追加一行并做写后行数校验:重读文件统计非空行数,必须等于「写前行数 + 1」。
 * 校验失败返回 false(调用方折叠成 EVIDENCE_LEDGER_WRITE_VERIFY_FAILED);不回滚、不 throw。
 */
function appendEvidenceLine(root: string, line: EvidenceLine): boolean {
  const path = evidenceGraphPath(root);
  const before = countLines(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    return false;
  }
  return countLines(path) === before + 1;
}

/** 投影:按行序归并(latest wins),坏行计 parseErrors 跳过。 */
export function loadEvidenceGraph(root: string): EvidenceProjection {
  const path = evidenceGraphPath(root);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { graph: rt.createEvidenceGraph(), parseErrors: 0, totalLines: 0 };
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const graph = rt.createEvidenceGraph();
  let parseErrors = 0;
  let totalLines = 0;
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    totalLines += 1;
    const line = parseLine(raw);
    if (!line) {
      parseErrors += 1;
      continue;
    }
    applyLine(graph, line);
  }
  return { graph, parseErrors, totalLines };
}

/** 追加一条证据:纯逻辑判定 + 成功才落行。 */
export function addEvidence(root: string, input: AddEvidenceInput): EvidenceStoreResult {
  const { graph } = loadEvidenceGraph(root);
  const result = rt.addEvidence(graph, input);
  if (!result.ok || !result.node) return { ok: false, code: result.code ?? "EVIDENCE_STORE_ERROR" };
  const at = result.node.createdAt;
  if (!appendEvidenceLine(root, { v: 1, type: "add", at, node: result.node })) {
    return { ok: false, code: "EVIDENCE_LEDGER_WRITE_VERIFY_FAILED" };
  }
  return { ok: true, id: result.node.id };
}

/** 新证据取代旧版(旧版保留在投影里,validTo/supersededBy 由投影补)。 */
export function supersedeEvidence(
  root: string,
  oldId: string,
  input: AddEvidenceInput,
  opts: { by?: string; reason?: string; at?: number } = {},
): EvidenceStoreResult {
  const { graph } = loadEvidenceGraph(root);
  const result = rt.supersedeEvidence(graph, oldId, input, opts);
  if (!result.ok || !result.node) return { ok: false, code: result.code ?? "EVIDENCE_STORE_ERROR" };
  const at = result.graph.nodes[oldId]?.updatedAt ?? opts.at ?? Date.now();
  const line: EvidenceLine = { v: 1, type: "supersede", at, oldId, by: opts.by, reason: opts.reason, node: result.node };
  if (!appendEvidenceLine(root, line)) return { ok: false, code: "EVIDENCE_LEDGER_WRITE_VERIFY_FAILED" };
  return { ok: true, id: result.node.id };
}

/** 用户纠正:生成新版本,旧版 validTo + supersededBy 由投影补。 */
export function correctEvidence(
  root: string,
  id: string,
  input: CorrectEvidenceInput): EvidenceStoreResult {
  const { graph } = loadEvidenceGraph(root);
  const result = rt.correctEvidence(graph, id, input);
  if (!result.ok || !result.node) return { ok: false, code: result.code ?? "EVIDENCE_STORE_ERROR" };
  const old = result.graph.nodes[id];
  if (!old || old.validTo === undefined || old.supersededBy === undefined) {
    return { ok: false, code: "EVIDENCE_STORE_ERROR" };
  }
  const line: EvidenceLine = {
    v: 1,
    type: "correct",
    at: old.updatedAt,
    id,
    by: input.by,
    reason: input.reason,
    patch: { validTo: old.validTo, supersededBy: old.supersededBy },
    node: result.node,
  };
  if (!appendEvidenceLine(root, line)) return { ok: false, code: "EVIDENCE_LEDGER_WRITE_VERIFY_FAILED" };
  return { ok: true, id: result.node.id };
}

/** 指定权威版(同冲突组其它 authoritative 降为 latest)。 */
export function markAuthoritative(root: string, id: string): EvidenceStoreResult {
  const { graph } = loadEvidenceGraph(root);
  const result = rt.markAuthoritative(graph, id);
  if (!result.ok) return { ok: false, code: result.code ?? "EVIDENCE_STORE_ERROR" };
  const demoted = result.demoted.map((nodeId) => ({ id: nodeId, authoritativeness: "latest" as const }));
  const line: EvidenceLine = { v: 1, type: "authoritative", at: Date.now(), id, demoted };
  if (!appendEvidenceLine(root, line)) return { ok: false, code: "EVIDENCE_LEDGER_WRITE_VERIFY_FAILED" };
  return { ok: true, id };
}

/** 查询投影(默认 at 时有效且 active;includeHistory 放开)。 */
export function queryEvidence(root: string, filter: EvidenceQuery = {}): EvidenceNode[] {
  const { graph } = loadEvidenceGraph(root);
  return rt.queryEvidence(graph, filter);
}

/** 冲突组:同 association + 同 kind 的多条并存 active 结论。 */
export function conflicts(root: string, at?: number): EvidenceConflict[] {
  const { graph } = loadEvidenceGraph(root);
  return rt.conflictsOf(graph, at);
}

/** 版本链(oldest→newest)。 */
export function history(root: string, id: string): EvidenceNode[] {
  const { graph } = loadEvidenceGraph(root);
  return rt.historyOf(graph, id);
}

/** before/after 图谱逐节点 diff,得到 decay 行的状态补丁。 */
function decayUpdates(before: EvidenceGraph, after: EvidenceGraph): DecayUpdate[] {
  const updates: DecayUpdate[] = [];
  for (const node of Object.values(after.nodes)) {
    const old = before.nodes[node.id];
    const update: DecayUpdate = { id: node.id };
    let changed = false;
    if (node.status !== old?.status) {
      update.status = node.status;
      changed = true;
    }
    if (node.archivedReason !== old?.archivedReason) {
      update.archivedReason = node.archivedReason;
      changed = true;
    }
    if (node.archivedAt !== old?.archivedAt) {
      update.archivedAt = node.archivedAt;
      changed = true;
    }
    if (node.staleAt !== old?.staleAt) {
      update.staleAt = node.staleAt;
      changed = true;
    }
    if (node.staleReason !== old?.staleReason) {
      update.staleReason = node.staleReason;
      changed = true;
    }
    if (changed) updates.push(update);
  }
  return updates;
}

/** 衰减/容量逐出:纯逻辑算新图,落一行状态补丁(不物理删节点)。 */
export function applyDecay(root: string, policy: DecayPolicy): EvidenceStoreDecayResult {
  const { graph } = loadEvidenceGraph(root);
  const result = rt.applyDecay(graph, policy);
  if (!result.ok) return { ok: false, code: result.code ?? "EVIDENCE_STORE_ERROR" };
  const updates = decayUpdates(graph, result.graph);
  if (updates.length > 0) {
    const line: EvidenceLine = { v: 1, type: "decay", at: result.report.at, policy, updates, report: result.report };
    if (!appendEvidenceLine(root, line)) return { ok: false, code: "EVIDENCE_LEDGER_WRITE_VERIFY_FAILED" };
  }
  return { ok: true, report: result.report };
}

/** 模型版本重估:apply=false 只预览不写盘(同 decay 预览语义);apply=true 落一行 rescore(不删旧行)。 */
export function rescoreForModelVersion(
  root: string,
  modelVersion: string,
  opts: { apply?: boolean; at?: number } = {},
): EvidenceStoreRescoreResult {
  const at = opts.at ?? Date.now();
  const { graph } = loadEvidenceGraph(root);
  const result = rt.rescoreForModelVersion(graph, modelVersion, { at });
  if (!result.ok) return { ok: false, code: result.code ?? "EVIDENCE_STORE_ERROR", rescored: [] };
  const ids = result.rescored;
  const statuses: Record<string, string> = {};
  for (const id of ids) statuses[id] = "stale";
  if (!opts.apply) return { ok: true, rescored: ids, ids, statuses, preview: true };
  if (ids.length === 0) return { ok: true, rescored: ids, ids, statuses, preview: false };
  const line: EvidenceLine = { v: 1, type: "rescore", at, modelVersion, ids, statuses };
  if (!appendEvidenceLine(root, line)) {
    return { ok: false, code: "EVIDENCE_LEDGER_WRITE_VERIFY_FAILED", rescored: ids };
  }
  return { ok: true, rescored: ids, ids, statuses, preview: false };
}

/** 汇总报告:节点/状态/冲突/坏行计数。 */
export function reportEvidence(root: string): EvidenceReport {
  const { graph, parseErrors, totalLines } = loadEvidenceGraph(root);
  const nodes = Object.values(graph.nodes);
  const byKind: Record<string, number> = {};
  let active = 0;
  let stale = 0;
  let archived = 0;
  for (const node of nodes) {
    byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
    if (node.status === "active") active += 1;
    else if (node.status === "stale") stale += 1;
    else archived += 1;
  }
  return {
    ok: true,
    totalLines,
    parseErrors,
    nodes: nodes.length,
    active,
    stale,
    archived,
    conflicts: rt.conflictsOf(graph).length,
    byKind,
  };
}
