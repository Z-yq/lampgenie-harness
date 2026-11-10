/**
 * 缺陷血缘持久层(生产侧,缺陷血缘 2026-11):把 defect-lineage 的纯逻辑落到 append-only jsonl。
 * 为什么 append-only:「这条缺陷算在谁头上」是审计事实——登记、归属、人工澄清都是判断的历史,
 * 不能被后来的写入覆盖或抹掉(错的溯源比没有更贵,所以要能回看当初为什么这么判)。
 * 单行追加 + 写后重读行数校验让「写成功了吗」成为可复核断言,而不是信任 appendFileSync 没抛异常。
 * 数据面:`<root>/.genie/rsi/defects.jsonl`,每行 `{v:1,type,at,defect,lineage?}`
 * - register   {defect}                     缺陷登记(fixTaskId / files / fixedAt 是归属与漏点推断的输入)
 * - attribute  {defect,lineage}             一次自动归属的结论(buildLineage 结果,含 votes/codes/chain)
 * - clarify    {defect,lineage,by,note,sourceTaskId,missedLink} 人工判定(置信沿用原值,codes 用 MEDIUM 表示人工入链)
 * 投影语义(loadDefects):
 * - 按行序归并(latest wins on 同 id):register 建底,attribute 覆盖 lineage,clarify 把状态钉在 clarified。
 * - 每条状态优先级:最近一次 clarify > attribute(unattributed ? "unattributed" : "attributed") > register。
 * - 坏行(JSON 坏 / v 不是 1 / type 未知 / 缺 defect)只计入 parseErrors 并跳过:一行坏不整文件失效、不 throw。
 * 依赖纪律:node:fs / node:path + 同目录 evidence-graph-store(投影写入)+ runtime 的纯逻辑模块;
 * 不引 agent loop、不引 gateway 业务模块。runtime 模块按 experiment-store 的既有套路惰性解析(两跳):
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 除参数错误外不 throw:IO/投影/闸门失败一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  DefectCategory,
  DefectConfidence,
  DefectRecord,
  LineageChainEntry,
  MissedLink,
  SourceTaskEvidence,
} from "@lampgenie/runtime/agent/defect-lineage";
import type { AddEvidenceInput } from "@lampgenie/runtime/agent/evidence-graph";
import type { EvidenceProjection } from "./evidence-graph-store";

/** store 稳定码:store 层自产的失败码(血缘码沿用 runtime 的 DEFECT_CODES)。 */
export const DEFECT_STORE_CODES = [
  "DEFECT_DUPLICATE",
  "DEFECT_NOT_FOUND",
  "DEFECT_INVALID_INPUT",
  "DEFECT_LEDGER_WRITE_VERIFY_FAILED",
  "DEFECT_STORE_ERROR",
  "DEFECT_UNATTRIBUTED",
] as const;

export type DefectStoreCode = (typeof DEFECT_STORE_CODES)[number];

/** 落盘行类型(只增不改)。 */
export const DEFECT_LINE_TYPES = ["register", "attribute", "clarify"] as const;

export type DefectLineType = (typeof DEFECT_LINE_TYPES)[number];

/** 条目最终状态:register 只登记、attribute 自动入链/未入链、clarify 人工入链。 */
export type DefectStatus = "registered" | "attributed" | "unattributed" | "clarified";

/** 血缘结论(与 runtime buildLineage 同形;clarify 手工组装时额外带 attribution/note/by)。 */
export interface DefectLineageLike {
  ok: boolean;
  defect?: DefectRecord;
  chain: LineageChainEntry[];
  unattributed: boolean;
  votes: unknown[];
  codes: string[];
  /** 便捷顶层置信度(= defect.confidence;下游 CLI/队列不必深挖 defect)。 */
  confidence?: DefectConfidence;
  attribution?: string;
  note?: string;
  by?: string;
}

/** 一条落盘行。 */
export interface DefectLine {
  v: 1;
  type: DefectLineType;
  at: number;
  defect: DefectRecord;
  lineage?: DefectLineageLike;
  by?: string;
  note?: string;
  sourceTaskId?: string;
  missedLink?: MissedLink;
}

/** 投影出的一条缺陷(状态 + 最新血缘)。 */
export interface DefectEntry {
  defect: DefectRecord;
  lineage?: DefectLineageLike;
  status: DefectStatus;
  lastAt: number;
  lastType: DefectLineType;
}

/** 投影结果:按首次出现顺序的条目 + 坏行/总行计数。 */
export interface DefectProjection {
  entries: Map<string, DefectEntry>;
  parseErrors: number;
  totalLines: number;
}

/** 单次写入结果。 */
export interface RegisterResult {
  ok: boolean;
  code?: string;
  id?: string;
}

/** 归属结果:unattributed=true 表示「没归属」(ok 仍为 true,行已落,便于队列查询)。 */
export interface AttributeResult {
  ok: boolean;
  code?: string;
  unattributed?: boolean;
  lineage?: DefectLineageLike;
}

/** 澄清结果。 */
export interface ClarifyResult {
  ok: boolean;
  code?: string;
  lineage?: DefectLineageLike;
}

/** 列表条目。 */
export interface DefectListItem {
  defect: DefectRecord;
  lineage?: DefectLineageLike;
  status: DefectStatus;
}

/** 列表结果。 */
export interface DefectListResult {
  ok: true;
  items: DefectListItem[];
  parseErrors: number;
  totalLines: number;
}

/** 未归属队列条目(给「人工补链」用)。 */
export interface UnattributedItem {
  id: string;
  fixTaskId: string;
  module?: string;
  category: string;
  confidence: string;
  reason: string;
}

/** 投影到证据图的结果。 */
export interface ProjectToGraphResult {
  ok: boolean;
  code?: string;
  ids: string[];
  nodes: number;
  codes: string[];
}

/** 报表。 */
export interface DefectReport {
  ok: true;
  total: number;
  byCategory: Record<string, number>;
  byConfidence: Record<string, number>;
  byMissedLink: Record<string, number>;
  unattributed: number;
  pendingClarify: number;
  parseErrors: number;
  totalLines: number;
}

/** runtime 面(只声明本文件用到的部分)。 */
interface DefectRuntime {
  buildLineage(
    defect: DefectRecord,
    source: SourceTaskEvidence,
    opts?: { now?: number; priorDefects?: DefectRecord[] },
  ): DefectLineageLike;
  toEvidenceGraphInputs(lineage: DefectLineageLike): {
    ok: boolean;
    codes: string[];
    nodes: {
      kind: "anti-pattern" | "direction";
      statement: string;
      associations: { type: "task" | "module" | "decision"; ref: string; label?: string }[];
      confidence: number;
      source: { note?: string };
    }[];
    edges: { from: string; to: string; kind: string }[];
  };
}

let defectRuntime: DefectRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadDefectRuntime(): Promise<DefectRuntime> {
  if (defectRuntime) return defectRuntime;
  const spec = "@lampgenie/runtime/agent/defect-lineage";
  try {
    defectRuntime = (await import(spec)) as DefectRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/defect-lineage.ts", import.meta.url).href;
    defectRuntime = (await import(srcUrl)) as DefectRuntime;
  }
  return defectRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadDefectRuntime();

/** 同目录证据图持久层面(裸 node strip-types 下相对导入必须带 .ts,故用动态字面量解出两个函数)。 */
interface EvidenceStoreRuntime {
  addEvidence(root: string, input: AddEvidenceInput): { ok: boolean; code?: string; id?: string };
  loadEvidenceGraph(root: string): EvidenceProjection;
}

const evidenceStoreSpec = "./evidence-graph-store.ts";
const evidenceStore = (await import(evidenceStoreSpec)) as EvidenceStoreRuntime;
const addEvidence = evidenceStore.addEvidence;
const loadEvidenceGraph = evidenceStore.loadEvidenceGraph;

const CATEGORIES: ReadonlySet<string> = new Set<string>(["rework", "drift", "refactor", "unrelated", "unknown"]);
const CONFIDENCES: ReadonlySet<string> = new Set<string>(["high", "medium", "low"]);
const MISSED_LINKS: ReadonlySet<string> = new Set<string>([
  "requirement",
  "plan-coverage",
  "verification-coverage",
  "knowledge-gap",
  "tool-gap",
  "wrong-assumption",
  "impact-analysis",
  "none",
]);
const LINE_TYPES: ReadonlySet<string> = new Set<string>(DEFECT_LINE_TYPES);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 缺陷台账文件绝对路径:`<root>/.genie/rsi/defects.jsonl`。 */
export function defectLineagePath(root: string): string {
  return join(root, ".genie", "rsi", "defects.jsonl");
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
 * 校验失败返回 false(调用方折叠成 DEFECT_LEDGER_WRITE_VERIFY_FAILED);不回滚、不 throw。
 */
function appendDefectLine(root: string, line: DefectLine): boolean {
  const path = defectLineagePath(root);
  const before = countLines(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    return false;
  }
  return countLines(path) === before + 1;
}

/** 宽松读一条缺陷记录:缺 category/confidence 按 unknown/low 补齐(buildLineage 会重算)。 */
function normalizeDefect(value: unknown): DefectRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (!isFilled(value.id) || !isFilled(value.fixTaskId) || !isFilled(value.description)) return undefined;
  if (!Array.isArray(value.files)) return undefined;
  if (typeof value.fixedAt !== "number" || !Number.isFinite(value.fixedAt)) return undefined;
  const files = value.files.filter((file): file is string => typeof file === "string");
  if (files.length !== value.files.length) return undefined;
  const category: DefectCategory =
    typeof value.category === "string" && CATEGORIES.has(value.category) ? (value.category as DefectCategory) : "unknown";
  const confidence: DefectConfidence =
    typeof value.confidence === "string" && CONFIDENCES.has(value.confidence)
      ? (value.confidence as DefectConfidence)
      : "low";
  const missedLink: MissedLink =
    typeof value.missedLink === "string" && MISSED_LINKS.has(value.missedLink) ? (value.missedLink as MissedLink) : "none";
  const defect: DefectRecord = {
    id: value.id.trim(),
    fixTaskId: value.fixTaskId.trim(),
    description: value.description,
    files,
    fixedAt: value.fixedAt,
    category,
    confidence,
    missedLink,
  };
  if (typeof value.module === "string") defect.module = value.module;
  if (Array.isArray(value.blame)) defect.blame = value.blame as DefectRecord["blame"];
  if (Array.isArray(value.evidenceRefs)) {
    defect.evidenceRefs = value.evidenceRefs.filter((ref): ref is string => typeof ref === "string");
  }
  return defect;
}

/** 血缘载荷宽松读取:只要求链与 codes 形状够用,其余原样带过。 */
function normalizeLineage(value: unknown): DefectLineageLike | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.ok !== "boolean" || typeof value.unattributed !== "boolean") return undefined;
  const chain = Array.isArray(value.chain) ? (value.chain.filter(isRecord) as unknown as LineageChainEntry[]) : [];
  const codes = Array.isArray(value.codes) ? value.codes.filter(isFilled) : [];
  const votes = Array.isArray(value.votes) ? value.votes : [];
  const lineage: DefectLineageLike = { ok: value.ok, chain, unattributed: value.unattributed, votes, codes };
  const defect = normalizeDefect(value.defect);
  if (defect) lineage.defect = defect;
  const confidence =
    typeof value.confidence === "string" && CONFIDENCES.has(value.confidence)
      ? (value.confidence as DefectConfidence)
      : defect?.confidence;
  if (confidence !== undefined) lineage.confidence = confidence;
  for (const key of ["attribution", "note", "by"] as const) {
    if (typeof value[key] === "string") lineage[key] = value[key] as string;
  }
  return lineage;
}

/** 解析一行;坏行返回 undefined(调用方计 parseErrors)。 */
function parseLine(raw: string): DefectLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.v !== 1) return undefined;
  if (typeof parsed.type !== "string" || !LINE_TYPES.has(parsed.type)) return undefined;
  const defect = normalizeDefect(parsed.defect);
  if (!defect) return undefined;
  const at = typeof parsed.at === "number" && Number.isFinite(parsed.at) ? parsed.at : 0;
  const line: DefectLine = { v: 1, type: parsed.type as DefectLineType, at, defect };
  const lineage = normalizeLineage(parsed.lineage);
  if (lineage) line.lineage = lineage;
  for (const key of ["by", "note", "sourceTaskId"] as const) {
    if (typeof parsed[key] === "string") line[key] = parsed[key] as string;
  }
  if (typeof parsed.missedLink === "string" && MISSED_LINKS.has(parsed.missedLink)) {
    line.missedLink = parsed.missedLink as MissedLink;
  }
  return line;
}

/** 状态:最近一次 clarify > attribute(unattributed? "unattributed" : "attributed") > register。 */
function statusOf(line: DefectLine): DefectStatus {
  if (line.type === "clarify") return "clarified";
  if (line.type === "attribute") return line.lineage?.unattributed === true ? "unattributed" : "attributed";
  return "registered";
}

/** 把一条行套到投影上(latest wins on 同 id,clarify 后不再回退)。 */
function applyLine(entries: Map<string, DefectEntry>, line: DefectLine): void {
  const status = statusOf(line);
  const previous = entries.get(line.defect.id);
  const entry: DefectEntry = {
    defect: line.defect,
    status,
    lastAt: line.at,
    lastType: line.type,
  };
  const lineage = line.lineage ?? previous?.lineage;
  if (lineage) entry.lineage = lineage;
  if (previous && previous.status === "clarified" && status !== "clarified") {
    // 已人工入链的条目不被更早语义的后续行降级(append-only 下便于乱序/重放)。
    entries.set(line.defect.id, { ...previous, lastAt: line.at, lastType: line.type });
    return;
  }
  entries.set(line.defect.id, entry);
}

/** 投影:按行序归并(latest wins on 同 id),坏行计 parseErrors 跳过。 */
export function loadDefects(root: string): DefectProjection {
  const path = defectLineagePath(root);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { entries: new Map(), parseErrors: 0, totalLines: 0 };
  }
  const entries = new Map<string, DefectEntry>();
  let parseErrors = 0;
  let totalLines = 0;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    totalLines += 1;
    const line = parseLine(raw);
    if (!line) {
      parseErrors += 1;
      continue;
    }
    applyLine(entries, line);
  }
  return { entries, parseErrors, totalLines };
}

/** 登记一条缺陷:同 id 已登记不追加;成功才落 register 行并做写后校验。 */
export function registerDefect(
  root: string,
  defect: DefectRecord,
  opts: { now?: number } = {},
): RegisterResult {
  const normalized = normalizeDefect(defect);
  if (!normalized) return { ok: false, code: "DEFECT_INVALID_INPUT" };
  const projection = loadDefects(root);
  if (projection.entries.has(normalized.id)) return { ok: false, code: "DEFECT_DUPLICATE" };
  const at = opts.now ?? Date.now();
  const line: DefectLine = { v: 1, type: "register", at, defect: normalized };
  if (!appendDefectLine(root, line)) return { ok: false, code: "DEFECT_LEDGER_WRITE_VERIFY_FAILED" };
  return { ok: true, id: normalized.id };
}

/**
 * 自动归属:取该缺陷 + 候选交付证据 → buildLineage → 落 attribute 行。
 * unattributed 也算成功(ok:true + code DEFECT_UNATTRIBUTED,行仍落),由队列负责后续人工澄清。
 */
export function attributeDefect(
  root: string,
  defectId: string,
  source: SourceTaskEvidence,
  opts: { now?: number } = {},
): AttributeResult {
  if (!isFilled(defectId)) return { ok: false, code: "DEFECT_INVALID_INPUT" };
  const projection = loadDefects(root);
  const entry = projection.entries.get(defectId.trim());
  if (!entry) return { ok: false, code: "DEFECT_NOT_FOUND" };
  const priorDefects: DefectRecord[] = [];
  for (const [id, other] of projection.entries) {
    if (id === defectId.trim()) continue;
    priorDefects.push(other.defect);
  }
  const at = opts.now ?? Date.now();
  const result = rt.buildLineage(entry.defect, source, { now: at, priorDefects });
  if (!result.ok) return { ok: false, code: "DEFECT_INVALID_INPUT" };
  const lineage: DefectLineageLike = result;
  if (lineage.confidence === undefined && lineage.defect !== undefined) lineage.confidence = lineage.defect.confidence;
  const line: DefectLine = { v: 1, type: "attribute", at, defect: lineage.defect ?? entry.defect, lineage };
  if (!appendDefectLine(root, line)) return { ok: false, code: "DEFECT_LEDGER_WRITE_VERIFY_FAILED" };
  if (lineage.unattributed) {
    return { ok: true, unattributed: true, code: "DEFECT_UNATTRIBUTED", lineage };
  }
  return { ok: true, unattributed: false, lineage };
}

/**
 * 人工澄清:by/note 必填;不入 buildLineage,按人给的事实手工组装血缘。
 * 置信沿用原值,codes 固定 DEFECT_LINK_MEDIUM 表示「人工入链」(不冒充自动强证据)。
 */
export function clarifyDefect(
  root: string,
  defectId: string,
  input: { by: string; note: string; sourceTaskId?: string; missedLink?: MissedLink; now?: number },
): ClarifyResult {
  if (!isFilled(defectId)) return { ok: false, code: "DEFECT_INVALID_INPUT" };
  if (!isRecord(input) || !isFilled(input.by) || !isFilled(input.note)) {
    return { ok: false, code: "DEFECT_INVALID_INPUT" };
  }
  if (input.missedLink !== undefined && !MISSED_LINKS.has(input.missedLink)) {
    return { ok: false, code: "DEFECT_INVALID_INPUT" };
  }
  const projection = loadDefects(root);
  const entry = projection.entries.get(defectId.trim());
  if (!entry) return { ok: false, code: "DEFECT_NOT_FOUND" };

  const base = entry.defect;
  const sourceTaskId = isFilled(input.sourceTaskId) ? input.sourceTaskId.trim() : base.fixTaskId;
  const missedLink: MissedLink = input.missedLink ?? base.missedLink ?? "none";
  const category: DefectCategory = base.category === "unknown" ? "rework" : base.category;
  const confidence: DefectConfidence = base.confidence;
  const moduleRef = isFilled(base.module) ? base.module : base.files[0];

  const chain: LineageChainEntry[] = [
    { type: "task", ref: sourceTaskId, label: `交付任务 ${sourceTaskId}` },
  ];
  if (moduleRef !== undefined) chain.push({ type: "module", ref: moduleRef, label: `模块 ${moduleRef}` });
  chain.push({ type: "defect", ref: base.id, label: `缺陷 ${base.id}` });
  chain.push({
    type: "decision",
    ref: sourceTaskId,
    label: `${category} / ${confidence} / ${missedLink}`,
  });
  if (missedLink !== "none") {
    chain.push({ type: "missing-safeguard", ref: missedLink, label: `缺失防线 ${missedLink}` });
  }

  const defect: DefectRecord = { ...base, category, confidence, missedLink };
  const lineage: DefectLineageLike = {
    ok: true,
    defect,
    chain,
    unattributed: false,
    votes: [],
    codes: ["DEFECT_LINK_MEDIUM"],
    confidence,
    attribution: "manual",
    note: input.note,
    by: input.by,
  };
  const at = input.now ?? Date.now();
  const line: DefectLine = {
    v: 1,
    type: "clarify",
    at,
    defect,
    lineage,
    by: input.by,
    note: input.note,
    sourceTaskId,
    missedLink,
  };
  if (!appendDefectLine(root, line)) return { ok: false, code: "DEFECT_LEDGER_WRITE_VERIFY_FAILED" };
  return { ok: true, lineage };
}

/** 列缺陷:按 category / 是否未入链过滤;status 为最终状态。 */
export function listDefects(
  root: string,
  filter: { category?: string; unattributed?: boolean; json?: boolean } = {},
): DefectListResult {
  const projection = loadDefects(root);
  const items: DefectListItem[] = [];
  for (const entry of projection.entries.values()) {
    if (isFilled(filter.category) && entry.defect.category !== filter.category) continue;
    if (filter.unattributed === true && entry.status !== "unattributed") continue;
    if (filter.unattributed === false && entry.status === "unattributed") continue;
    const item: DefectListItem = { defect: entry.defect, status: entry.status };
    if (entry.lineage) item.lineage = entry.lineage;
    items.push(item);
  }
  return { ok: true, items, parseErrors: projection.parseErrors, totalLines: projection.totalLines };
}

/** 未归属队列:只要最终状态为 unattributed 的条目(reason 说明为什么没入链)。 */
export function unattributedQueue(root: string): { ok: true; items: UnattributedItem[] } {
  const projection = loadDefects(root);
  const items: UnattributedItem[] = [];
  for (const entry of projection.entries.values()) {
    if (entry.status !== "unattributed") continue;
    const defect = entry.defect;
    const item: UnattributedItem = {
      id: defect.id,
      fixTaskId: defect.fixTaskId,
      category: defect.category,
      confidence: defect.confidence,
      reason: unattributedReason(entry),
    };
    if (defect.module !== undefined) item.module = defect.module;
    items.push(item);
  }
  return { ok: true, items };
}

/** 未入链原因:置信不足 / 类别无关 / 无证据(给队列读,不参与判定)。 */
function unattributedReason(entry: DefectEntry): string {
  if (entry.defect.confidence === "low") return "confidence-low";
  if (entry.defect.category === "unrelated") return "category-unrelated";
  return "no-evidence";
}

/** 规范化 statement(与 evidence-graph 同口径):用于幂等时定位既有节点。 */
function normalizeStatement(statement: string): string {
  return statement.trim().replace(/\s+/g, " ").toLowerCase();
}

/** 在已落盘图谱里按 (kind, 规范化 statement) 找回既有节点 id(EVIDENCE_DUPLICATE 幂等用)。 */
function findExistingNodeId(
  graphRoot: string,
  node: { kind: "anti-pattern" | "direction"; statement: string },
): string | undefined {
  const { graph } = loadEvidenceGraph(graphRoot);
  const target = normalizeStatement(node.statement);
  const candidates = Object.values(graph.nodes) as { id?: unknown; kind?: unknown; statement?: unknown }[];
  for (const candidate of candidates) {
    if (candidate.kind !== node.kind) continue;
    if (typeof candidate.statement !== "string") continue;
    if (normalizeStatement(candidate.statement) !== target) continue;
    if (typeof candidate.id === "string") return candidate.id;
  }
  return undefined;
}

/**
 * 把该缺陷最新血缘投影进证据图(每个节点逐个 addEvidence;EVIDENCE_DUPLICATE 视为成功幂等)。
 * 无血缘 / 未入链 / 转换失败一律 DEFECT_GRAPH_FAILED:不给图里塞没把握的节点。
 */
export function projectToGraph(
  root: string,
  defectId: string,
  opts: { graphRoot: string; now?: number },
): ProjectToGraphResult {
  if (!isFilled(defectId) || !isRecord(opts) || !isFilled(opts.graphRoot)) {
    return { ok: false, code: "DEFECT_INVALID_INPUT", ids: [], nodes: 0, codes: ["DEFECT_GRAPH_FAILED"] };
  }
  const projection = loadDefects(root);
  const entry = projection.entries.get(defectId.trim());
  if (!entry) return { ok: false, code: "DEFECT_NOT_FOUND", ids: [], nodes: 0, codes: ["DEFECT_GRAPH_FAILED"] };
  const lineage = entry.lineage;
  if (!lineage || lineage.ok !== true || lineage.unattributed !== false) {
    return { ok: false, code: "DEFECT_UNATTRIBUTED", ids: [], nodes: 0, codes: ["DEFECT_GRAPH_FAILED"] };
  }
  const inputs = rt.toEvidenceGraphInputs(lineage);
  if (!inputs.ok) {
    return { ok: false, code: "DEFECT_GRAPH_FAILED", ids: [], nodes: 0, codes: inputs.codes };
  }
  const at = opts.now ?? Date.now();
  const ids: string[] = [];
  const codes = [...inputs.codes];
  for (const node of inputs.nodes) {
    const result = addEvidence(opts.graphRoot, {
      kind: node.kind,
      statement: node.statement,
      associations: node.associations,
      confidence: node.confidence,
      source: node.source,
      at,
    });
    if (result.ok && result.id !== undefined) {
      ids.push(result.id);
      continue;
    }
    if (result.code === "EVIDENCE_DUPLICATE") {
      const existingId = findExistingNodeId(opts.graphRoot, node);
      if (existingId === undefined) {
        return { ok: false, code: "DEFECT_GRAPH_FAILED", ids, nodes: ids.length, codes: ["DEFECT_GRAPH_FAILED"] };
      }
      ids.push(existingId);
      if (!codes.includes("EVIDENCE_DUPLICATE")) codes.push("EVIDENCE_DUPLICATE");
      continue;
    }
    return { ok: false, code: "DEFECT_GRAPH_FAILED", ids, nodes: ids.length, codes: ["DEFECT_GRAPH_FAILED"] };
  }
  return { ok: true, code: "DEFECT_GRAPH_PROJECTED", ids, nodes: ids.length, codes };
}

/** 报表:按最终状态各条目算计数;unattributed 与 pendingClarify 同口径(都数未入链条目)。 */
export function reportDefects(root: string): DefectReport {
  const projection = loadDefects(root);
  const byCategory: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  const byMissedLink: Record<string, number> = {};
  let unattributed = 0;
  let pendingClarify = 0;
  for (const entry of projection.entries.values()) {
    const defect = entry.defect;
    byCategory[defect.category] = (byCategory[defect.category] ?? 0) + 1;
    byConfidence[defect.confidence] = (byConfidence[defect.confidence] ?? 0) + 1;
    const missedLink = defect.missedLink ?? "none";
    byMissedLink[missedLink] = (byMissedLink[missedLink] ?? 0) + 1;
    if (entry.status === "unattributed") {
      unattributed += 1;
      pendingClarify += 1;
    }
  }
  return {
    ok: true,
    total: projection.entries.size,
    byCategory,
    byConfidence,
    byMissedLink,
    unattributed,
    pendingClarify,
    parseErrors: projection.parseErrors,
    totalLines: projection.totalLines,
  };
}
