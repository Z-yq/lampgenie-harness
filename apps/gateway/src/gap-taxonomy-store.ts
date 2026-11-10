/**
 * 漏点预防件持久层(生产侧,漏点预防路由 2026-11):把 gap-taxonomy 的纯逻辑落到 append-only jsonl。
 *
 * 为什么 append-only:预防件的「种下来 / 路由给它 / 调权 / 失效」都是判断历史,不能被后来的写入覆盖——
 * 一个 0.6 的条目被两条缺陷佐证抬到 0.8,回看的价值在于知道「它凭什么变可信」,而不是只看到 0.8。
 * 单行追加 + 写后重读行数校验,让「写成功了吗」成为可复核断言,而不是信任 appendFileSync 没抛异常。
 *
 * 数据面:`<root>/.genie/rsi/gaps.jsonl`,每行 `{v:1,type,at,entries?,entryIds?,defectId?,codes?,matchReasons?,module?,boardType?,taskClass?}`
 * - seed   {entries}                       分类法条目入库(幂等:同 id 不重复落行)
 * - route  {entries,entryIds,defectId,codes,matchReasons,module} 一次漏点路由的结论
 * - bump   {entries,entryIds,defectId}     佐证调权后的条目快照(confidence 已抬高)
 * - expire {entryIds}                      一次过期扫描命中(审计用;过期判定始终由 expiresAt 与 now 决定)
 *
 * 投影语义(loadGaps):按行序归并,同 id 条目 confidence 取 max、sourceDefectIds 取并集、
 * overfitRisk 取更高、expiresAt 取更早;坏行(JSON 坏 / v 不是 1 / type 未知 / 条目形状不合法)只计入
 * parseErrors 并跳过:一行坏不整文件失效,也不 throw。
 *
 * 依赖纪律(照抄 #210 store):node:fs / node:path + 同目录缺陷留存层(读 missedLink)+ runtime 纯逻辑模块;
 * 不引 agent loop、不静态 import runtime(未 build 的 dist 不存在),runtime 模块两跳惰性解析:
 * ① `--conditions=development` 的运行时(vitest / 带条件的 node)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 除参数错误外不 throw:IO/投影/图谱失败一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  GapCategory,
  InjectionPoint,
  PreventionEntry,
  PreventionForm,
  RouteInput,
  RouteResult,
} from "@lampgenie/runtime/agent/gap-taxonomy";
import type { AddEvidenceInput } from "@lampgenie/runtime/agent/evidence-graph";

/** store 稳定码:store 层自产的失败/提示码(路由码沿用 runtime 的 GAP_CODES)。 */
export const GAP_STORE_CODES = [
  "GAP_INVALID_INPUT",
  "GAP_SEED_DUPLICATE",
  "GAP_DEFECT_NOT_FOUND",
  "GAP_NO_MATCH",
  "GAP_CATEGORY_NONE",
  "GAP_LEDGER_WRITE_VERIFY_FAILED",
  "GAP_STORE_ERROR",
] as const;

export type GapStoreCode = (typeof GAP_STORE_CODES)[number];

/** 落盘行类型(只增不改)。 */
export const GAP_LINE_TYPES = ["seed", "route", "bump", "expire"] as const;

export type GapLineType = (typeof GAP_LINE_TYPES)[number];

type UnknownRecord = Record<string, unknown>;

/** 一条落盘行。 */
export interface GapLine {
  v: 1;
  type: GapLineType;
  at: number;
  entries?: PreventionEntry[];
  entryIds?: string[];
  defectId?: string;
  codes?: string[];
  matchReasons?: string[];
  module?: string;
  boardType?: string;
  taskClass?: string;
}

/** 投影结果(对外):条目列表 + byId + 坏行/总行计数。 */
export interface GapProjection {
  entries: PreventionEntry[];
  byId: Map<string, PreventionEntry>;
  parseErrors: number;
  totalLines: number;
}

/** 投影结果(对内):额外保留 route 行,用于 unrouted 计数。 */
interface GapProjectionInternal extends GapProjection {
  routeRows: GapLine[];
}

/** runtime gap-taxonomy 模块面(只列本文件用到的导出)。 */
interface GapRuntime {
  readonly GAP_CATEGORIES: readonly string[];
  readonly PREVENTION_FORMS: readonly string[];
  readonly INJECTION_POINTS: readonly string[];
  readonly GAP_CODES: { readonly ROUTED: string; readonly NO_MATCH: string; readonly CATEGORY_NONE: string };
  readonly DEFAULT_TAXONOMY: PreventionEntry[];
  routeGap(input: RouteInput, decisions?: unknown[], entries?: PreventionEntry[]): RouteResult;
  bumpConfidence(entry: PreventionEntry, corroboratingDefects: number): PreventionEntry;
  applyAt(
    entries: PreventionEntry[],
    injectionPoint: InjectionPoint,
  ): { contextBlocks: string[]; gates: string[]; toolChecks: string[] };
  expireEntries(entries: PreventionEntry[], now: number): { active: PreventionEntry[]; expired: PreventionEntry[] };
  toGraphNodes(entries: PreventionEntry[]): {
    kind: "direction";
    statement: string;
    associations: { type: "module" | "decision"; ref: string }[];
    confidence: number;
    source: { note: string };
  }[];
}

let gapRuntime: GapRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadGapRuntime(): Promise<GapRuntime> {
  if (gapRuntime) return gapRuntime;
  const spec = "@lampgenie/runtime/agent/gap-taxonomy";
  try {
    gapRuntime = (await import(spec)) as GapRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/gap-taxonomy.ts", import.meta.url).href;
    gapRuntime = (await import(srcUrl)) as GapRuntime;
  }
  return gapRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadGapRuntime();

/** 同目录证据图持久层面(裸 node strip-types 下相对导入必须带 .ts,故用动态字面量解出两个函数)。 */
interface EvidenceStoreRuntime {
  addEvidence(root: string, input: AddEvidenceInput): { ok: boolean; code?: string; id?: string };
  loadEvidenceGraph(root: string): { totalLines: number; parseErrors: number };
}

const evidenceStoreSpec = "./evidence-graph-store.ts";
const evidenceStore = (await import(evidenceStoreSpec)) as EvidenceStoreRuntime;
const addEvidence = evidenceStore.addEvidence;

/** 同目录缺陷留存层面(只读投影:取 missedLink / module / files)。 */
interface DefectStoreRuntime {
  loadDefects(root: string): {
    entries: Map<string, { defect: { id: string; files: string[]; module?: string; missedLink?: string } }>;
    parseErrors: number;
    totalLines: number;
  };
}

const defectStoreSpec = "./defect-lineage-store.ts";
const defectStore = (await import(defectStoreSpec)) as DefectStoreRuntime;
const loadDefects = defectStore.loadDefects;

const LINE_TYPES: ReadonlySet<string> = new Set<string>(GAP_LINE_TYPES);
const FORM_COST: Record<PreventionForm, number> = { context: 0, gate: 1, tool: 2 };
const FORM_ORDER: PreventionForm[] = ["context", "gate", "tool"];
const CONFIDENCE_FALLBACK = 0.5;

// ------------------------------------------------------------------ 基础工具

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function findForm(value: unknown): PreventionForm | undefined {
  return typeof value === "string" && (rt.PREVENTION_FORMS as readonly string[]).includes(value)
    ? (value as PreventionForm)
    : undefined;
}

function findInjectionPoint(value: unknown): InjectionPoint | undefined {
  return typeof value === "string" && (rt.INJECTION_POINTS as readonly string[]).includes(value)
    ? (value as InjectionPoint)
    : undefined;
}

function isCategory(value: unknown): value is GapCategory {
  return typeof value === "string" && (rt.GAP_CATEGORIES as readonly string[]).includes(value);
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) if (!out.includes(value)) out.push(value);
  return out;
}

/** 台账文件绝对路径:`<root>/.genie/rsi/gaps.jsonl`。 */
export function gapLedgerPath(root: string): string {
  return join(root, ".genie", "rsi", "gaps.jsonl");
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
 * 校验失败返回 false(调用方折叠成 GAP_LEDGER_WRITE_VERIFY_FAILED);不回滚、不 throw。
 */
function appendGapLine(root: string, line: GapLine): boolean {
  const path = gapLedgerPath(root);
  const before = countLines(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    return false;
  }
  return countLines(path) === before + 1;
}

// ------------------------------------------------------------------ 归一化

function normalizeTrigger(value: unknown): PreventionEntry["trigger"] {
  const trigger: PreventionEntry["trigger"] = {};
  if (!isRecord(value)) return trigger;
  for (const field of ["module", "boardType", "taskClass", "decisionNode", "textPattern"] as const) {
    const raw = value[field];
    if (typeof raw === "string") trigger[field] = raw;
  }
  return trigger;
}

/** 宽松读一条预防件:只要 id/gapCategory/form/injectionPoint 站得住就留下,其余字段给安全缺省。 */
function normalizeEntry(value: unknown): PreventionEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (!isFilled(value.id)) return undefined;
  if (!isCategory(value.gapCategory)) return undefined;
  const form = findForm(value.form);
  if (form === undefined) return undefined;
  const injectionPoint = findInjectionPoint(value.injectionPoint);
  if (injectionPoint === undefined) return undefined;
  const overfitRisk =
    value.overfitRisk === "low" || value.overfitRisk === "medium" || value.overfitRisk === "high"
      ? value.overfitRisk
      : "low";
  const entry: PreventionEntry = {
    id: value.id.trim(),
    gapCategory: value.gapCategory,
    form,
    carrier: typeof value.carrier === "string" ? value.carrier : "",
    injectionPoint,
    guidance: typeof value.guidance === "string" ? value.guidance : "",
    trigger: normalizeTrigger(value.trigger),
    confidence: isFiniteNumber(value.confidence) ? value.confidence : CONFIDENCE_FALLBACK,
    overfitRisk,
    sourceDefectIds: Array.isArray(value.sourceDefectIds)
      ? uniqueStrings(value.sourceDefectIds.filter((id): id is string => typeof id === "string"))
      : [],
    createdAt: isFiniteNumber(value.createdAt) ? value.createdAt : 0,
  };
  if (isFiniteNumber(value.expiresAt)) entry.expiresAt = value.expiresAt;
  return entry;
}

/** 读一行台账;形状不合法返回 undefined(调用方计 parseErrors)。 */
function parseLine(raw: string): GapLine | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;
  if (payload.v !== 1) return undefined;
  if (typeof payload.type !== "string" || !LINE_TYPES.has(payload.type)) return undefined;
  if (!isFiniteNumber(payload.at)) return undefined;
  const line: GapLine = { v: 1, type: payload.type as GapLineType, at: payload.at };
  if (payload.entries !== undefined) {
    if (!Array.isArray(payload.entries)) return undefined;
    const entries: PreventionEntry[] = [];
    for (const item of payload.entries) {
      const entry = normalizeEntry(item);
      if (entry === undefined) return undefined;
      entries.push(entry);
    }
    line.entries = entries;
  }
  if (payload.entryIds !== undefined) {
    if (!Array.isArray(payload.entryIds)) return undefined;
    line.entryIds = uniqueStrings(payload.entryIds.filter((id): id is string => typeof id === "string"));
  }
  if (payload.defectId !== undefined) {
    if (typeof payload.defectId !== "string") return undefined;
    line.defectId = payload.defectId;
  }
  if (payload.codes !== undefined) {
    if (!Array.isArray(payload.codes)) return undefined;
    line.codes = payload.codes.filter((code): code is string => typeof code === "string");
  }
  if (payload.matchReasons !== undefined) {
    if (!Array.isArray(payload.matchReasons)) return undefined;
    line.matchReasons = payload.matchReasons.filter((reason): reason is string => typeof reason === "string");
  }
  for (const field of ["module", "boardType", "taskClass"] as const) {
    const value = payload[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return undefined;
    line[field] = value;
  }
  if (line.type === "seed" || line.type === "route" || line.type === "bump") {
    if (line.entries === undefined) return undefined;
  }
  if (line.type === "expire" && line.entryIds === undefined) return undefined;
  return line;
}

// ------------------------------------------------------------------ 投影

function cloneEntry(entry: PreventionEntry): PreventionEntry {
  const clone: PreventionEntry = {
    ...entry,
    trigger: { ...(entry.trigger ?? {}) },
    sourceDefectIds: uniqueStrings(entry.sourceDefectIds ?? []),
  };
  if (entry.expiresAt !== undefined) clone.expiresAt = entry.expiresAt;
  return clone;
}

function riskRank(value: string): number {
  return value === "high" ? 2 : value === "medium" ? 1 : 0;
}

/** 同 id 归并:保留首条的 id/trigger/话术/注入点,confidence 取 max、sourceDefectIds 并集、expiresAt 取更早。 */
function mergeEntry(first: PreventionEntry, next: PreventionEntry): PreventionEntry {
  // trigger 后写覆盖(route 行会把 module 绑到条目上):投影丢 trigger 的话,
  // applyAt 的模块过滤和 list 的展示都会退化成「无上下文」。
  const trigger: PreventionEntry["trigger"] = { ...(first.trigger ?? {}) };
  const incoming = next.trigger ?? {};
  for (const key of ["module", "boardType", "taskClass", "decisionNode", "textPattern"] as const) {
    const value = incoming[key];
    if (typeof value === "string" && value.length > 0) trigger[key] = value;
  }
  const merged: PreventionEntry = {
    ...first,
    trigger,
    confidence: Math.max(first.confidence, next.confidence),
    overfitRisk:
      riskRank(next.overfitRisk) > riskRank(first.overfitRisk) ? next.overfitRisk : first.overfitRisk,
    sourceDefectIds: uniqueStrings([...(first.sourceDefectIds ?? []), ...(next.sourceDefectIds ?? [])]),
  };
  const expiries = [first.expiresAt, next.expiresAt].filter((at): at is number => isFiniteNumber(at));
  if (expiries.length > 0) merged.expiresAt = Math.min(...expiries);
  else delete merged.expiresAt;
  return merged;
}

function projectGaps(root: string): GapProjectionInternal {
  const path = gapLedgerPath(root);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { entries: [], byId: new Map(), parseErrors: 0, totalLines: 0, routeRows: [] };
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const byId = new Map<string, PreventionEntry>();
  const routeRows: GapLine[] = [];
  let parseErrors = 0;
  let totalLines = 0;
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    totalLines += 1;
    const line = parseLine(raw);
    if (line === undefined) {
      parseErrors += 1;
      continue;
    }
    if (line.type === "route") routeRows.push(line);
    for (const entry of line.entries ?? []) {
      const existing = byId.get(entry.id);
      byId.set(entry.id, existing === undefined ? cloneEntry(entry) : mergeEntry(existing, entry));
    }
  }
  return { entries: [...byId.values()], byId, parseErrors, totalLines, routeRows };
}

function compareEntries(a: PreventionEntry, b: PreventionEntry): number {
  const byCost = FORM_COST[a.form] - FORM_COST[b.form];
  if (byCost !== 0) return byCost;
  const byConfidence = b.confidence - a.confidence;
  if (byConfidence !== 0) return byConfidence;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sortedByCost(entries: PreventionEntry[]): PreventionEntry[] {
  return entries.slice().sort(compareEntries);
}

function bumpCounter(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

/** 读投影(对外导出;文件不存在/空台账按空投影处理)。 */
export function loadGaps(root: string): {
  entries: PreventionEntry[];
  byId: Map<string, PreventionEntry>;
  parseErrors: number;
  totalLines: number;
} {
  try {
    if (!isFilled(root)) return { entries: [], byId: new Map(), parseErrors: 0, totalLines: 0 };
    const projection = projectGaps(root);
    return {
      entries: projection.entries,
      byId: projection.byId,
      parseErrors: projection.parseErrors,
      totalLines: projection.totalLines,
    };
  } catch {
    return { entries: [], byId: new Map(), parseErrors: 0, totalLines: 0 };
  }
}

// ------------------------------------------------------------------ seed

/** 分类法条目的安全读取:非数组或全非法时返回空列表。 */
function readEntries(value: unknown): PreventionEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PreventionEntry[] = [];
  for (const item of value) {
    const entry = normalizeEntry(item);
    if (entry !== undefined) out.push(entry);
  }
  return out;
}

/**
 * 种入分类法条目(缺省用 runtime 的 DEFAULT_TAXONOMY)。
 * 幂等:同 id 已在台账里就不重复落行;本次 added===0 返回 code GAP_SEED_DUPLICATE(ok 仍 true)。
 */
export function seedTaxonomy(
  root: string,
  opts: { now?: number; entries?: PreventionEntry[] } = {},
): { ok: boolean; code?: string; added: number; total: number } {
  try {
    if (!isFilled(root)) return { ok: false, code: "GAP_INVALID_INPUT", added: 0, total: 0 };
    const projection = projectGaps(root);
    const source = opts.entries === undefined ? readEntries(rt.DEFAULT_TAXONOMY) : readEntries(opts.entries);
    if (source.length === 0) {
      return { ok: false, code: "GAP_INVALID_INPUT", added: 0, total: projection.byId.size };
    }
    const fresh: PreventionEntry[] = [];
    for (const entry of source) {
      if (projection.byId.has(entry.id)) continue;
      if (fresh.some((item) => item.id === entry.id)) continue;
      fresh.push(cloneEntry(entry));
    }
    if (fresh.length === 0) {
      return { ok: true, code: "GAP_SEED_DUPLICATE", added: 0, total: projection.byId.size };
    }
    const at = opts.now ?? Date.now();
    const line: GapLine = { v: 1, type: "seed", at, entries: fresh, entryIds: fresh.map((entry) => entry.id) };
    if (!appendGapLine(root, line)) {
      return { ok: false, code: "GAP_LEDGER_WRITE_VERIFY_FAILED", added: 0, total: projection.byId.size };
    }
    return { ok: true, added: fresh.length, total: projection.byId.size + fresh.length };
  } catch {
    return { ok: false, code: "GAP_STORE_ERROR", added: 0, total: 0 };
  }
}

// ------------------------------------------------------------------ route

/**
 * 补齐形态档:routeGap 只返回 trigger 命中/通配的条目,会漏掉「受约束的便宜档」;
 * 预防件必须按成本档完整登记,否则 applyAt 只剩最贵的一档(没人执行的预防件等于没有)。
 * 缺哪一档就补该类该档最便宜的一条(同档同成本时取 confidence 高者),理由记为 completed:<id>。
 */
function completeTiers(
  routed: PreventionEntry[],
  pool: PreventionEntry[],
  category: string,
  reasons: string[],
): PreventionEntry[] {
  const out = routed.map(cloneEntry);
  const have = new Set(out.map((entry) => entry.form));
  for (const form of FORM_ORDER) {
    if (have.has(form)) continue;
    const candidate = sortedByCost(pool.filter((entry) => entry.gapCategory === category && entry.form === form))[0];
    if (candidate === undefined) continue;
    const clone = cloneEntry(candidate);
    out.push(clone);
    have.add(form);
    reasons.push(`completed:${clone.id}`);
  }
  return sortedByCost(out);
}

/** 把 module 写进 trigger:下游 applyAt/bump 需要按模块过滤,而默认分类法的 trigger 不带 module。 */
function annotateModule(entries: PreventionEntry[], module: string | undefined): PreventionEntry[] {
  if (module === undefined || module.length === 0) return entries;
  const out: PreventionEntry[] = [];
  for (const entry of entries) {
    const clone = cloneEntry(entry);
    if (clone.trigger.module === undefined) clone.trigger.module = module;
    out.push(clone);
  }
  return out;
}

interface RouteGraphResult {
  ok: boolean;
  ids: string[];
  codes: string[];
}

/** 把 routed 条目投影进 #191 证据图(graphRoot 缺省不投影);失败折叠成 graph.ok=false,不抛。 */
function projectRoutedToGraph(graphRoot: string, routed: PreventionEntry[], defectId: string): RouteGraphResult {
  const ids: string[] = [];
  const codes: string[] = [];
  try {
    const nodes = rt.toGraphNodes(routed);
    if (nodes.length === 0) return { ok: false, ids, codes: ["GAP_NO_MATCH"] };
    let ok = true;
    for (const node of nodes) {
      const input = {
        kind: node.kind,
        statement: node.statement,
        associations: node.associations,
        confidence: node.confidence,
        source: { note: `${node.source.note} defect=${defectId}` },
      } as unknown as AddEvidenceInput;
      const result = addEvidence(graphRoot, input);
      if (result.ok) {
        if (result.id !== undefined) ids.push(result.id);
        continue;
      }
      ok = false;
      if (result.code !== undefined) codes.push(result.code);
    }
    return { ok, ids, codes: uniqueStrings(codes) };
  } catch {
    return { ok: false, ids, codes: uniqueStrings([...codes, "GAP_STORE_ERROR"]) };
  }
}

/**
 * 用 #210 台账里的一条缺陷做漏点路由:missedLink → 预防件,落 route 行。
 * - missedLink 为 none/缺失 → codes 含 GAP_CATEGORY_NONE、routed []、不落行(ok 仍 true);
 * - 缺陷不存在 → ok:false code GAP_DEFECT_NOT_FOUND;
 * - opts.graphRoot 给出时把 routed 投影进证据图(失败折叠成 graph.ok=false)。
 */
export function routeFromDefect(
  root: string,
  defectId: string,
  opts: { graphRoot?: string; now?: number } = {},
): {
  ok: boolean;
  code?: string;
  defectId?: string;
  category?: string;
  routed: PreventionEntry[];
  codes: string[];
  matchReasons: string[];
  graph?: RouteGraphResult;
} {
  try {
    if (!isFilled(root) || !isFilled(defectId)) {
      return { ok: false, code: "GAP_INVALID_INPUT", routed: [], codes: [], matchReasons: [] };
    }
    const id = defectId.trim();
    const projection = projectGaps(root);
    const defects = loadDefects(root);
    const found = defects.entries.get(id);
    if (found === undefined) {
      return { ok: false, code: "GAP_DEFECT_NOT_FOUND", defectId: id, routed: [], codes: [], matchReasons: [] };
    }
    const defect = found.defect;
    const missedLink = typeof defect.missedLink === "string" && defect.missedLink.length > 0 ? defect.missedLink : "none";
    const module = isFilled(defect.module) ? defect.module : defect.files[0];

    if (missedLink === "none") {
      const codes = [rt.GAP_CODES.CATEGORY_NONE];
      const matchReasons = ["category-none:none"];
      const result = {
        ok: true,
        code: "GAP_CATEGORY_NONE",
        defectId: id,
        category: "none",
        routed: [] as PreventionEntry[],
        codes,
        matchReasons,
      };
      if (opts.graphRoot !== undefined) {
        return { ...result, graph: { ok: false, ids: [], codes: ["GAP_CATEGORY_NONE"] } };
      }
      return result;
    }

    const now = opts.now ?? Date.now();
    const candidates = projection.entries.length > 0 ? projection.entries : readEntries(rt.DEFAULT_TAXONOMY);
    // 失效条目既不进 routed 也不落 route 行:候选池先按 now 切出 active(无 expiresAt 的条目恒有效)。
    const pool = rt.expireEntries(candidates, now).active;
    const routeInput: RouteInput = { missedLink, defectId: id };
    if (module !== undefined) routeInput.module = module;
    const routeResult = rt.routeGap(routeInput, undefined, pool);
    const matchReasons = [...routeResult.matchReasons];
    const routed = annotateModule(
      completeTiers(routeResult.routed, pool, missedLink, matchReasons),
      module,
    );
    // module 是路由上下文的一部分(applyAt/bump 都按它过滤),命中理由里必须留下这条依据,
    // 否则回看时看不出「这条经验教训凭什么接到这个模块」。
    if (module !== undefined && module.length > 0) {
      for (const entry of routed) {
        const reason = `module-scope:${entry.id}:${module}`;
        if (!matchReasons.includes(reason)) matchReasons.push(reason);
      }
    }
    const codes = [...routeResult.codes];

    if (routed.length === 0) {
      return { ok: true, code: "GAP_NO_MATCH", defectId: id, category: missedLink, routed, codes, matchReasons };
    }

    const at = now;
    const line: GapLine = {
      v: 1,
      type: "route",
      at,
      entries: routed,
      entryIds: routed.map((entry) => entry.id),
      defectId: id,
      codes,
      matchReasons,
    };
    if (module !== undefined) line.module = module;
    if (!appendGapLine(root, line)) {
      return {
        ok: false,
        code: "GAP_LEDGER_WRITE_VERIFY_FAILED",
        defectId: id,
        category: missedLink,
        routed: [],
        codes,
        matchReasons,
      };
    }

    const result: {
      ok: boolean;
      code?: string;
      defectId?: string;
      category?: string;
      routed: PreventionEntry[];
      codes: string[];
      matchReasons: string[];
      graph?: RouteGraphResult;
    } = { ok: true, defectId: id, category: missedLink, routed, codes, matchReasons };
    if (opts.graphRoot !== undefined) result.graph = projectRoutedToGraph(opts.graphRoot, routed, id);
    return result;
  } catch {
    return { ok: false, code: "GAP_STORE_ERROR", routed: [], codes: [], matchReasons: [] };
  }
}

// ------------------------------------------------------------------ list

/**
 * 列预防件:按 category/form/injectionPoint 过滤;过期条目缺省不列(includeExpired 时列出)。
 * 排序口径:形态成本升序 → confidence 降序 → id 升序(与纯逻辑一致)。
 */
export function listPreventions(
  root: string,
  filter: { category?: string; form?: string; injectionPoint?: string; includeExpired?: boolean; now?: number } = {},
): { ok: boolean; items: PreventionEntry[]; total: number; byCategory: Record<string, number> } {
  const empty = { ok: false, items: [] as PreventionEntry[], total: 0, byCategory: {} as Record<string, number> };
  try {
    if (!isFilled(root)) return empty;
    const category = filter.category;
    if (category !== undefined && !isCategory(category)) return empty;
    const form = filter.form;
    if (form !== undefined && findForm(form) === undefined) return empty;
    const injectionPoint = filter.injectionPoint;
    if (injectionPoint !== undefined && findInjectionPoint(injectionPoint) === undefined) return empty;

    const projection = projectGaps(root);
    const now = filter.now ?? Date.now();
    const { active, expired } = rt.expireEntries(projection.entries, now);
    const scope = filter.includeExpired === true ? [...active, ...expired] : active;
    const items = sortedByCost(
      scope.filter((entry) => {
        if (category !== undefined && entry.gapCategory !== category) return false;
        if (form !== undefined && entry.form !== form) return false;
        if (injectionPoint !== undefined && entry.injectionPoint !== injectionPoint) return false;
        return true;
      }),
    ).map(cloneEntry);
    const byCategory: Record<string, number> = {};
    for (const entry of items) bumpCounter(byCategory, entry.gapCategory);
    return { ok: true, items, total: items.length, byCategory };
  } catch {
    return empty;
  }
}

// ------------------------------------------------------------------ bump

/**
 * 佐证调权:找投影里 sourceDefectIds 含该缺陷的条目(或 route 行里关联该缺陷的 entryIds),
 * 按「该缺陷在 sourceDefectIds 中出现的次数(至少 1)」调权并落 bump 行。
 */
export function bumpForDefect(
  root: string,
  defectId: string,
): { ok: boolean; code?: string; updated: { id: string; from: number; to: number }[] } {
  try {
    if (!isFilled(root) || !isFilled(defectId)) {
      return { ok: false, code: "GAP_INVALID_INPUT", updated: [] };
    }
    const id = defectId.trim();
    const projection = projectGaps(root);
    const related = new Map<string, number>();
    for (const entry of projection.entries) {
      const occurrences = (entry.sourceDefectIds ?? []).filter((value) => value === id).length;
      if (occurrences > 0) related.set(entry.id, occurrences);
    }
    for (const row of projection.routeRows) {
      if (row.defectId !== id) continue;
      for (const entryId of row.entryIds ?? []) {
        if (!related.has(entryId) && projection.byId.has(entryId)) related.set(entryId, 1);
      }
    }
    if (related.size === 0) return { ok: false, code: "GAP_NO_MATCH", updated: [] };

    const at = Date.now();
    const bumped: PreventionEntry[] = [];
    const updated: { id: string; from: number; to: number }[] = [];
    for (const [entryId, occurrences] of related) {
      const entry = projection.byId.get(entryId);
      if (entry === undefined) continue;
      const next = rt.bumpConfidence(entry, Math.max(1, occurrences));
      bumped.push(next);
      updated.push({ id: entry.id, from: entry.confidence, to: next.confidence });
    }
    if (bumped.length === 0) return { ok: false, code: "GAP_NO_MATCH", updated: [] };
    const line: GapLine = {
      v: 1,
      type: "bump",
      at,
      entries: bumped,
      entryIds: bumped.map((entry) => entry.id),
      defectId: id,
    };
    if (!appendGapLine(root, line)) return { ok: false, code: "GAP_LEDGER_WRITE_VERIFY_FAILED", updated: [] };
    return { ok: true, updated };
  } catch {
    return { ok: false, code: "GAP_STORE_ERROR", updated: [] };
  }
}

// ------------------------------------------------------------------ apply

/**
 * 在某个注入点落地:读投影 → 切掉过期条目 → 按 ctx 过滤 trigger → 纯函数 applyAt 分组成三类文本。
 * ctx 过滤口径:条目 trigger 的字段有值、ctx 也给了值、两者不等 → 不命中;ctx 缺该字段即该字段不参与过滤。
 */
export function applyAt(
  root: string,
  injectionPoint: string,
  ctx: { module?: string; boardType?: string; taskClass?: string; now?: number } = {},
): {
  ok: boolean;
  code?: string;
  contextBlocks: string[];
  gates: string[];
  toolChecks: string[];
  counts: { context: number; gate: number; tool: number };
} {
  const empty = {
    ok: false,
    contextBlocks: [] as string[],
    gates: [] as string[],
    toolChecks: [] as string[],
    counts: { context: 0, gate: 0, tool: 0 },
  };
  try {
    if (!isFilled(root)) return { ...empty, code: "GAP_INVALID_INPUT" };
    const target = findInjectionPoint(injectionPoint);
    if (target === undefined) return { ...empty, code: "GAP_INVALID_INPUT" };
    const projection = projectGaps(root);
    const now = ctx.now ?? Date.now();
    const { active } = rt.expireEntries(projection.entries, now);
    const scoped = active.filter((entry) => matchesContext(entry, ctx));
    const grouped = rt.applyAt(scoped, target);
    return {
      ok: true,
      contextBlocks: grouped.contextBlocks,
      gates: grouped.gates,
      toolChecks: grouped.toolChecks,
      counts: {
        context: grouped.contextBlocks.length,
        gate: grouped.gates.length,
        tool: grouped.toolChecks.length,
      },
    };
  } catch {
    return { ...empty, code: "GAP_STORE_ERROR" };
  }
}

function matchesContext(
  entry: PreventionEntry,
  ctx: { module?: string; boardType?: string; taskClass?: string },
): boolean {
  for (const field of ["module", "boardType", "taskClass"] as const) {
    const expected = entry.trigger?.[field];
    const actual = ctx[field];
    if (expected === undefined || actual === undefined) continue;
    if (expected !== actual) return false;
  }
  return true;
}

// ------------------------------------------------------------------ expire

/** 过期扫描:expiresAt <= now 的条目命中;命中时落一条 expire 行(审计),无命中不算失败。 */
export function expire(root: string, now?: number): { ok: boolean; expired: string[] } {
  try {
    if (!isFilled(root)) return { ok: false, expired: [] };
    const projection = projectGaps(root);
    const at = isFiniteNumber(now) ? now : Date.now();
    const { expired } = rt.expireEntries(projection.entries, at);
    const ids = expired.map((entry) => entry.id);
    if (ids.length === 0) return { ok: true, expired: [] };
    const line: GapLine = { v: 1, type: "expire", at, entryIds: ids };
    if (!appendGapLine(root, line)) return { ok: false, expired: [] };
    return { ok: true, expired: ids };
  } catch {
    return { ok: false, expired: [] };
  }
}

// ------------------------------------------------------------------ report

/** 汇总报表:总量 / 有效与过期 / 三个维度分布 / 未路由次数 / 坏行。 */
export function reportGaps(root: string): {
  ok: true;
  total: number;
  active: number;
  expired: number;
  byCategory: Record<string, number>;
  byForm: Record<string, number>;
  byInjection: Record<string, number>;
  unrouted: number;
  parseErrors: number;
  totalLines: number;
} {
  const empty = {
    ok: true as const,
    total: 0,
    active: 0,
    expired: 0,
    byCategory: {} as Record<string, number>,
    byForm: {} as Record<string, number>,
    byInjection: {} as Record<string, number>,
    unrouted: 0,
    parseErrors: 0,
    totalLines: 0,
  };
  try {
    if (!isFilled(root)) return empty;
    const projection = projectGaps(root);
    const { active, expired } = rt.expireEntries(projection.entries, Date.now());
    const byCategory: Record<string, number> = {};
    const byForm: Record<string, number> = {};
    const byInjection: Record<string, number> = {};
    for (const entry of projection.entries) {
      bumpCounter(byCategory, entry.gapCategory);
      bumpCounter(byForm, entry.form);
      bumpCounter(byInjection, entry.injectionPoint);
    }
    let unrouted = 0;
    for (const row of projection.routeRows) {
      const emptyRoute = (row.entries?.length ?? 0) === 0;
      const noMatch = (row.codes ?? []).some(
        (code) => code === rt.GAP_CODES.NO_MATCH || code === rt.GAP_CODES.CATEGORY_NONE,
      );
      if (emptyRoute || noMatch) unrouted += 1;
    }
    return {
      ok: true,
      total: projection.byId.size,
      active: active.length,
      expired: expired.length,
      byCategory,
      byForm,
      byInjection,
      unrouted,
      parseErrors: projection.parseErrors,
      totalLines: projection.totalLines,
    };
  } catch {
    return empty;
  }
}
