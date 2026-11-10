/**
 * 负面知识库持久层(生产侧,RSI #215):把 negative-knowledge 的纯逻辑落到 append-only jsonl。
 * 为什么 append-only:死路账本是审计事实——「先记了这条路不通、后来翻案、再后来过期」是判断史,
 * 不能被覆盖写抹掉;翻案必须留谁/何时/为什么,否则账本会固化成迷信。单行追加 + 写后行数校验
 * 让「写成功了吗」成为可复核断言,而不是信任 appendFileSync 没抛异常。
 * 数据面:`<root>/.genie/rsi/negkb.jsonl`,每行:
 * - record  {v:1,type:"record",at,record}                        记录完整 DeadEndRecord
 * - revive  {v:1,type:"revive",at,id,by,reason,newEvidence?}       一次翻案(纠正记录)
 * - expire  {v:1,type:"expire",at,id}                             一次过期扫描的结论
 * 投影语义(loadDeadEnds):按行序归并,later wins on 同 id —— record 建底,revive 走 runtime 的
 * reviveDeadEnd 追加纠正并置 revived,expire 直接把 status 钉在 expired(所以「过期后翻案」与
 * 「翻案后过期」在行序上可区分)。坏行(JSON 坏 / v 不是 1 / type 未知 / 缺 id 或 record)只计入
 * parseErrors 并跳过:一行坏不整文件失效、不 throw。无对应 record 的孤儿事件行不算坏行,跳过。
 * 依赖纪律:node:fs / node:path + runtime 的纯逻辑模块;不引 agent loop、不引 gateway 业务模块。
 * runtime 模块按 defect-lineage-store 的既有套路惰性解析(两跳):
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 除参数错误(root/input 形状不对)外不 throw:IO/投影/写校验失败一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AbandonSession,
  DeadEndHit,
  DeadEndRecord,
  RecordDeadEndInput,
  RecordDeadEndResult,
  RetrieveQuery,
  RetrieveResult,
  ReviveInput,
} from "@lampgenie/runtime/agent/negative-knowledge";

/** store 层自产的稳定码(账本码沿用 runtime 的 NEGKB_*)。 */
export const NEGKB_STORE_CODES = ["NEGKB_NOT_FOUND", "NEGKB_LEDGER_WRITE_VERIFY_FAILED", "NEGKB_STORE_ERROR"] as const;

export type NegKbStoreCode = (typeof NEGKB_STORE_CODES)[number];

/** 落盘行类型(只增不改)。 */
export const NEGKB_LINE_TYPES = ["record", "revive", "expire"] as const;

export type NegKbLineType = (typeof NEGKB_LINE_TYPES)[number];

/** 一条落盘行。 */
export type NegKbLine =
  | { v: 1; type: "record"; at: number; record: DeadEndRecord }
  | { v: 1; type: "revive"; at: number; id: string; by: string; reason: string; newEvidence?: string }
  | { v: 1; type: "expire"; at: number; id: string };

/** 投影结果:按首次出现顺序的记录 + 坏行/总行计数。 */
export interface NegKbProjection {
  records: Map<string, DeadEndRecord>;
  parseErrors: number;
  totalLines: number;
}

/** 报表:计数口径见 reportNegative。 */
export interface NegativeKbReport {
  total: number;
  active: number;
  revived: number;
  expired: number;
  /** 当前可被检索注入的条数(= live:active/revived 且未过期 且 confidence >= DEFAULT_MIN_CONFIDENCE)。 */
  hits: number;
  parseErrors: number;
  totalLines: number;
  withAlternative: number;
}

/** runtime 面(只用投影/判重/翻案/过期/推断/suggest 这些纯函数 + 几个常量)。 */
interface NegKbRuntime {
  NEGKB_REVIVED: string;
  NEGKB_ALREADY_REVIVED: string;
  NEGKB_RECORDED: string;
  NEGKB_DUPLICATE: string;
  NEGKB_NO_MATCH: string;
  DEFAULT_MIN_CONFIDENCE: number;
  recordDeadEnd(input: RecordDeadEndInput, opts?: { now?: number; existing?: DeadEndRecord[] }): RecordDeadEndResult;
  retrieveDeadEnds(
    records: DeadEndRecord[],
    query: RetrieveQuery,
    opts?: { now?: number; minConfidence?: number; limit?: number },
  ): RetrieveResult;
  injectAtPlanning(
    records: DeadEndRecord[],
    query: RetrieveQuery,
    opts?: { maxChars?: number; minConfidence?: number; now?: number },
  ): { blocks: string[]; hits: DeadEndHit[] };
  reviveDeadEnd(record: DeadEndRecord, input: ReviveInput): { record: DeadEndRecord; codes: string[] };
  expireDeadEnds(records: DeadEndRecord[], now: number): { expired: string[]; records: DeadEndRecord[] };
  suggestFromAbandons(
    input: { sessions: AbandonSession[] },
    opts?: { minSessions?: number },
  ): { candidates: DeadEndRecord[] };
}

let negkbRuntime: NegKbRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadNegKbRuntime(): Promise<NegKbRuntime> {
  if (negkbRuntime) return negkbRuntime;
  const spec = "@lampgenie/runtime/agent/negative-knowledge";
  try {
    negkbRuntime = (await import(spec)) as NegKbRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/negative-knowledge.ts", import.meta.url).href;
    negkbRuntime = (await import(srcUrl)) as NegKbRuntime;
  }
  return negkbRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadNegKbRuntime();

/** 账本路径(测试/CLI 定位用)。 */
export function negativeKbPath(root: string): string {
  return join(root, ".genie", "rsi", "negkb.jsonl");
}

function assertRoot(root: string): void {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError("root 必须是非空目录路径");
}

/** 统计非空行数(文件不存在 → 0)。 */
function countLines(path: string): number {
  let text = "";
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
 * 校验失败返回 false(调用方折叠成 NEGKB_LEDGER_WRITE_VERIFY_FAILED);不回滚、不 throw。
 */
function appendNegKbLine(root: string, line: NegKbLine): boolean {
  const path = negativeKbPath(root);
  const before = countLines(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    return false;
  }
  return countLines(path) === before + 1;
}

function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 读账本并投影成「当前记录集」。
 * 坏行只计 parseErrors 并跳过;孤儿事件(revive/expire 找不到 id)不算坏行,跳过。
 */
export function loadDeadEnds(root: string): NegKbProjection {
  assertRoot(root);
  const records = new Map<string, DeadEndRecord>();
  let parseErrors = 0;
  let totalLines = 0;

  let text = "";
  try {
    text = readFileSync(negativeKbPath(root), "utf8");
  } catch {
    return { records, parseErrors, totalLines };
  }

  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    totalLines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parseErrors += 1;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      parseErrors += 1;
      continue;
    }
    const row = parsed as Record<string, unknown>;
    if (row.v !== 1) {
      parseErrors += 1;
      continue;
    }
    const at = finiteOr(row.at, 0);

    if (row.type === "record") {
      const record = row.record;
      if (typeof record !== "object" || record === null || !isFilled((record as DeadEndRecord).id)) {
        parseErrors += 1;
        continue;
      }
      const rec = record as DeadEndRecord;
      records.set(rec.id, rec);
      continue;
    }

    if (row.type !== "revive" && row.type !== "expire") {
      parseErrors += 1;
      continue;
    }

    const id = row.id;
    if (!isFilled(id)) {
      parseErrors += 1;
      continue;
    }
    const current = records.get(id);
    if (!current) continue; // 孤儿事件:没有对应 record 行,跳过

    if (row.type === "revive") {
      const revived = rt.reviveDeadEnd(current, {
        by: isFilled(row.by) ? row.by : "",
        reason: isFilled(row.reason) ? row.reason : "",
        newEvidence: isFilled(row.newEvidence) ? row.newEvidence : undefined,
        at,
      });
      records.set(id, revived.record);
      continue;
    }

    records.set(id, { ...current, status: "expired" });
  }

  return { records, parseErrors, totalLines };
}

/** 记一条死路:先投影判重(runtime 的 recordDeadEnd + existing),DUPLICATE 不写盘。 */
export function recordDeadEnd(
  root: string,
  input: RecordDeadEndInput): { ok: boolean; record?: DeadEndRecord; codes: string[] } {
  assertRoot(root);
  if (typeof input !== "object" || input === null) throw new TypeError("recordDeadEnd 需要 input 对象");
  let projection: NegKbProjection;
  try {
    projection = loadDeadEnds(root);
  } catch {
    return { ok: false, codes: ["NEGKB_STORE_ERROR"] };
  }
  const result = rt.recordDeadEnd(input, { existing: [...projection.records.values()] });
  if (!result.ok || !result.record) return { ok: false, record: result.record, codes: result.codes };

  const line: NegKbLine = { v: 1, type: "record", at: Date.now(), record: result.record };
  if (!appendNegKbLine(root, line)) {
    return { ok: false, record: result.record, codes: [...result.codes, "NEGKB_LEDGER_WRITE_VERIFY_FAILED"] };
  }
  return { ok: true, record: result.record, codes: result.codes };
}

/** 召回死路(投影 → runtime retrieveDeadEnds)。 */
export function retrieve(
  root: string,
  query: RetrieveQuery,
  opts: { now?: number; minConfidence?: number; limit?: number } = {},
): RetrieveResult {
  assertRoot(root);
  let projection: NegKbProjection;
  try {
    projection = loadDeadEnds(root);
  } catch {
    return { hits: [], codes: ["NEGKB_STORE_ERROR"] };
  }
  return rt.retrieveDeadEnds([...projection.records.values()], query, opts);
}

/** 规划期注入文本(投影 → runtime injectAtPlanning)。 */
export function inject(
  root: string,
  query: RetrieveQuery,
  opts: { maxChars?: number; minConfidence?: number; now?: number } = {},
): { blocks: string[]; hits: DeadEndHit[] } {
  assertRoot(root);
  let projection: NegKbProjection;
  try {
    projection = loadDeadEnds(root);
  } catch {
    return { blocks: [], hits: [] };
  }
  return rt.injectAtPlanning([...projection.records.values()], query, opts);
}

/** 翻案:找不到 id → NEGKB_NOT_FOUND;已 revived → ALREADY_REVIVED 且不写盘;否则 append revive 行。 */
export function revive(
  root: string,
  id: string,
  opts: { by: string; reason: string; newEvidence?: string; at?: number },
): { ok: boolean; record?: DeadEndRecord; codes: string[] } {
  assertRoot(root);
  if (!isFilled(id)) throw new TypeError("revive 需要死路 id");
  if (typeof opts !== "object" || opts === null || !isFilled(opts.by) || !isFilled(opts.reason)) {
    return { ok: false, codes: ["NEGKB_INVALID"] };
  }

  let projection: NegKbProjection;
  try {
    projection = loadDeadEnds(root);
  } catch {
    return { ok: false, codes: ["NEGKB_STORE_ERROR"] };
  }

  const current = projection.records.get(id);
  if (!current) return { ok: false, codes: ["NEGKB_NOT_FOUND"] };
  if (current.status === "revived") return { ok: false, record: current, codes: [rt.NEGKB_ALREADY_REVIVED] };

  const at = finiteOr(opts.at, Date.now());
  const outcome = rt.reviveDeadEnd(current, { by: opts.by, reason: opts.reason, newEvidence: opts.newEvidence, at });
  if (!outcome.codes.includes(rt.NEGKB_REVIVED)) return { ok: false, record: outcome.record, codes: outcome.codes };

  const line: NegKbLine = {
    v: 1,
    type: "revive",
    at,
    id,
    by: opts.by,
    reason: opts.reason,
    ...(isFilled(opts.newEvidence) ? { newEvidence: opts.newEvidence } : {}),
  };
  if (!appendNegKbLine(root, line)) {
    return { ok: false, record: outcome.record, codes: [...outcome.codes, "NEGKB_LEDGER_WRITE_VERIFY_FAILED"] };
  }
  return { ok: true, record: outcome.record, codes: outcome.codes };
}

/** 过期扫描:对每条新过期 append expire 行,返回真正落盘的 id(写校验失败的 id 不列)。 */
export function expire(root: string, now?: number): { expired: string[]; parseErrors: number } {
  assertRoot(root);
  const at = finiteOr(now, Date.now());
  let projection: NegKbProjection;
  try {
    projection = loadDeadEnds(root);
  } catch {
    return { expired: [], parseErrors: 0 };
  }
  const { expired } = rt.expireDeadEnds([...projection.records.values()], at);
  const written: string[] = [];
  for (const id of expired) {
    const line: NegKbLine = { v: 1, type: "expire", at, id };
    if (appendNegKbLine(root, line)) written.push(id);
  }
  return { expired: written, parseErrors: projection.parseErrors };
}

/** 列记录(createdAt 升序,可按 status 过滤)。 */
export function listDeadEnds(root: string, opts: { status?: "active" | "revived" | "expired" } = {}): DeadEndRecord[] {
  assertRoot(root);
  const status = opts?.status;
  const list = [...loadDeadEnds(root).records.values()].filter((record) => !status || record.status === status);
  list.sort((a, b) => (a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return list;
}

/**
 * 从放弃会话推断候选死路并落盘(id 已存在 → 跳过,幂等)。
 * 返回值只含本次实际新增的候选。
 */
export function suggest(
  root: string,
  sessions: AbandonSession[],
  opts: { minSessions?: number } = {},
): { candidates: DeadEndRecord[]; codes: string[] } {
  assertRoot(root);
  const list = Array.isArray(sessions) ? sessions : [];
  let projection: NegKbProjection;
  try {
    projection = loadDeadEnds(root);
  } catch {
    return { candidates: [], codes: ["NEGKB_STORE_ERROR"] };
  }

  const { candidates } = rt.suggestFromAbandons({ sessions: list }, opts);
  const added: DeadEndRecord[] = [];
  for (const candidate of candidates) {
    if (projection.records.has(candidate.id)) continue;
    const line: NegKbLine = { v: 1, type: "record", at: Date.now(), record: candidate };
    if (appendNegKbLine(root, line)) {
      projection.records.set(candidate.id, candidate);
      added.push(candidate);
    }
  }

  if (candidates.length === 0) return { candidates: [], codes: [rt.NEGKB_NO_MATCH] };
  return { candidates: added, codes: added.length > 0 ? [rt.NEGKB_RECORDED] : [rt.NEGKB_DUPLICATE] };
}

/** 汇总:total/active/revived/expired/hits(当前可注入)/坏行/总行/有替代条数。 */
export function reportNegative(root: string): NegativeKbReport {
  assertRoot(root);
  const projection = loadDeadEnds(root);
  const now = Date.now();
  const all = [...projection.records.values()];
  const live = (record: DeadEndRecord): boolean =>
    (record.status === "active" || record.status === "revived") &&
    !(typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) && record.expiresAt <= now) &&
    typeof record.confidence === "number" &&
    record.confidence >= rt.DEFAULT_MIN_CONFIDENCE;

  return {
    total: all.length,
    active: all.filter((record) => record.status === "active").length,
    revived: all.filter((record) => record.status === "revived").length,
    expired: all.filter((record) => record.status === "expired").length,
    hits: all.filter(live).length,
    parseErrors: projection.parseErrors,
    totalLines: projection.totalLines,
    withAlternative: all.filter((record) => isFilled(record.alternative)).length,
  };
}
