/**
 * 会话查询游标的纯逻辑(零 IO):游标绑定「语料 generation + 查询指纹」。
 *
 * 为什么需要 generation:翻页游标记的是「在第 N 版语料里翻到哪」,而索引重刷 / 语料增删 / reconcile
 * 之后同一偏移指向的已是不同的行集合。若继续按旧偏移翻页,会把「语料已经变了」这件事静默表现成
 * 「后面几页是空的」——损坏的会话被当成空结果,是最难排查的一类错。所以游标里嵌 generation,
 * 语料一变旧游标必须显式判 STALE(否定结论),而不是给出错页数据。
 *
 * 判定顺序固定为 generation → 查询指纹(见 validateCursor):语料重建与查询条件同时变化时,
 * 根因是语料,若先比指纹就会把「该重建语料」误报成「你改了查询」,调用方再怎么重签发也拿不到正确页。
 *
 * 签名:sha256(规范化 payload JSON) 前 16 位。规范化规则见 canonicalJson:对象键排序、数组保序、
 * undefined 与缺键等价,因此同一查询条件不管对象字面量怎么写都得到同一指纹;而签名让手改 payload
 * (比如偷偷把 generation 改大)必然落到 CURSOR_INVALID,不会被当成有效游标放行。
 *
 * cursorStats 口径(与测试一致):issued = 参与统计的条目总数;invalid = parse 失败(含坏签名)的条数,
 * 这类条目单独计数、**不计入 mismatch**;stale / mismatch 只在 parse 通过后按 generation → 指纹顺序归类,
 * 因此恒有 invalid + stale + mismatch + ok === issued。
 *
 * 纪律:除 Node 内建 crypto 外无依赖;脏输入一律返回稳定码,不 throw。
 */
import { createHash } from "node:crypto";

/** 游标稳定码:runtime 面与 store 面的公共词汇表。 */
export const CURSOR_CODES = [
  "CURSOR_INVALID",
  "CURSOR_OK",
  "CURSOR_STALE",
  "CURSOR_QUERY_MISMATCH",
  "CURSOR_ISSUED",
  "CURSOR_GENERATION_BUMPED",
  "CURSOR_STALE_REJECTED",
] as const;

export type CursorCode = (typeof CURSOR_CODES)[number];

/** generation 推进原因:四类都会让旧偏移失去意义,没有「不推进」的分支。 */
export const GENERATION_CAUSES = ["index-rebuild", "corpus-change", "reconcile", "restart"] as const;

export type GenerationCause = (typeof GENERATION_CAUSES)[number];

/** 游标载荷:翻页位置 + 签发时的语料版本与查询指纹。 */
export interface CursorPayload {
  generation: number;
  queryFingerprint: string;
  nextBeforeSeq?: number;
  nextAfterSeq?: number;
  issuedAt: number;
}

/** 游标信封:载荷 + 其签名(签名覆盖 payload 的全部字段)。 */
export interface CursorEnvelope {
  payload: CursorPayload;
  signature: string;
}

export interface IssueCursorOptions {
  generation: unknown;
  query: unknown;
  position?: { beforeSeq?: unknown; afterSeq?: unknown } | undefined;
  at?: unknown;
}

export interface ParsedCursor {
  payload?: CursorPayload;
  code?: CursorCode;
}

export interface ValidateCursorOptions {
  currentGeneration: unknown;
  query: unknown;
}

/** 校验结论:ok 为 false 时 code 一定是否定码,调用方不得继续翻页。 */
export interface CursorVerdict {
  ok: boolean;
  code: CursorCode;
  detail: string;
}

/** 统计条目:envelope 是待判定的游标,currentGeneration/query 是「本次查询」的口径。 */
export interface CursorStatEntry {
  envelope: unknown;
  currentGeneration?: unknown;
  query?: unknown;
}

export interface CursorStats {
  issued: number;
  stale: number;
  mismatch: number;
  invalid: number;
}

const SIGNATURE_LENGTH = 16;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 非数字 / 小于 1 的 generation 一律回落到 1:空态与脏输入的共同起点。 */
function normalizeGeneration(current: unknown): number {
  if (!isFiniteNumber(current)) return 1;
  const truncated = Math.trunc(current);
  return truncated >= 1 ? truncated : 1;
}

function seqOf(value: unknown): number | undefined {
  return isFiniteNumber(value) ? Math.trunc(value) : undefined;
}

function atOf(value: unknown): number {
  return isFiniteNumber(value) ? Math.trunc(value) : Date.now();
}

function causeOf(value: unknown): GenerationCause | undefined {
  const raw = typeof value === "string" ? value : isRecord(value) ? value["cause"] : undefined;
  if (typeof raw !== "string") return undefined;
  return (GENERATION_CAUSES as readonly string[]).includes(raw) ? (raw as GenerationCause) : undefined;
}

/**
 * 规范化 JSON:对象键排序、数组保序、undefined/函数/symbol 记为 null。
 *
 * 为什么要自己写而不是 JSON.stringify:JSON.stringify 保留插入顺序,`{a:1,b:2}` 与 `{b:2,a:1}`
 * 会得到不同字符串,查询指纹就会因为调用方换个字面量写法而失效。环引用用 seen 路径集兜住,
 * 保证脏输入也不会抛栈。
 */
function canonicalJson(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return isFiniteNumber(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return JSON.stringify(`${String(value)}n`);
    case "undefined":
    case "function":
    case "symbol":
      return "null";
    default:
      break;
  }
  if (value instanceof Date) {
    const iso = Number.isNaN(value.getTime()) ? "invalid" : value.toISOString();
    return JSON.stringify(`date:${iso}`);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return JSON.stringify("[circular]");
    seen.add(value);
    const items = value.map((item) => canonicalJson(item, seen));
    seen.delete(value);
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as UnknownRecord;
    if (seen.has(record)) return JSON.stringify("[circular]");
    seen.add(record);
    // undefined 与缺键等价:显式写成 undefined 的键不算「查询条件变了」。
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`);
    seen.delete(record);
    return `{${parts.join(",")}}`;
  }
  return "null";
}

function hash16(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, SIGNATURE_LENGTH);
}

/** 查询指纹:稳定哈希查询条件(键序无关、数组保序、undefined 等价缺键),sha256 前 16 位。 */
export function queryFingerprint(query: unknown): string {
  return hash16(canonicalJson(query, new Set<object>()));
}

/** payload 签名:同一条 payload 恒得同一签名,改任一字段必然换签名。 */
export function signPayload(payload: CursorPayload): string {
  return hash16(canonicalJson(payload, new Set<object>()));
}

/** 签发游标:把当前语料 generation、查询指纹与翻页位置封进信封。 */
export function issueCursor(options: IssueCursorOptions): CursorEnvelope {
  const generation = normalizeGeneration(options.generation);
  const payload: CursorPayload = {
    generation,
    queryFingerprint: queryFingerprint(options.query),
    issuedAt: atOf(options.at),
  };
  const position = isRecord(options.position) ? options.position : undefined;
  const beforeSeq = seqOf(position?.["beforeSeq"]);
  const afterSeq = seqOf(position?.["afterSeq"]);
  if (beforeSeq !== undefined) payload.nextBeforeSeq = beforeSeq;
  if (afterSeq !== undefined) payload.nextAfterSeq = afterSeq;
  return { payload, signature: signPayload(payload) };
}

/**
 * 解析游标:字段缺失、类型错、签名重算不符都折叠成 CURSOR_INVALID。
 *
 * 为什么解析阶段就验签:伪造或手改过的游标必须在「能不能用它翻页」这个问题上直接否掉;
 * 若只依赖 issued 表登记,未登记的合法结构就会被当成可疑,而改过 generation 的伪造游标反而
 * 能靠「结构看着对」通过。
 */
export function parseCursor(envelope: unknown): ParsedCursor {
  if (!isRecord(envelope)) return { code: "CURSOR_INVALID" };
  const signature = envelope["signature"];
  if (typeof signature !== "string" || signature.trim() === "") return { code: "CURSOR_INVALID" };
  const raw = envelope["payload"];
  if (!isRecord(raw)) return { code: "CURSOR_INVALID" };
  const generation = raw["generation"];
  const fingerprint = raw["queryFingerprint"];
  const issuedAt = raw["issuedAt"];
  if (!isFiniteNumber(generation) || !isFiniteNumber(issuedAt)) return { code: "CURSOR_INVALID" };
  if (typeof fingerprint !== "string" || fingerprint === "") return { code: "CURSOR_INVALID" };
  const payload: CursorPayload = {
    generation: Math.trunc(generation),
    queryFingerprint: fingerprint,
    issuedAt: Math.trunc(issuedAt),
  };
  const rawBefore = raw["nextBeforeSeq"];
  if (rawBefore !== undefined) {
    const beforeSeq = seqOf(rawBefore);
    if (beforeSeq === undefined) return { code: "CURSOR_INVALID" };
    payload.nextBeforeSeq = beforeSeq;
  }
  const rawAfter = raw["nextAfterSeq"];
  if (rawAfter !== undefined) {
    const afterSeq = seqOf(rawAfter);
    if (afterSeq === undefined) return { code: "CURSOR_INVALID" };
    payload.nextAfterSeq = afterSeq;
  }
  if (signPayload(payload) !== signature) return { code: "CURSOR_INVALID" };
  return { payload, code: "CURSOR_OK" };
}

/** 校验游标是否还能用于本次查询:INVALID → STALE → QUERY_MISMATCH → OK(顺序固定,勿调换)。 */
export function validateCursor(envelope: unknown, options: ValidateCursorOptions): CursorVerdict {
  const parsed = parseCursor(envelope);
  if (parsed.payload === undefined) {
    return {
      ok: false,
      code: "CURSOR_INVALID",
      detail: "游标结构不合法或签名不匹配(字段缺失 / 类型错 / 已篡改)",
    };
  }
  const currentGeneration = normalizeGeneration(options.currentGeneration);
  if (parsed.payload.generation !== currentGeneration) {
    return {
      ok: false,
      code: "CURSOR_STALE",
      detail: `语料 generation 已从 ${parsed.payload.generation} 变为 ${currentGeneration},旧游标不得继续翻页,请从头查询`,
    };
  }
  const fingerprint = queryFingerprint(options.query);
  if (parsed.payload.queryFingerprint !== fingerprint) {
    return {
      ok: false,
      code: "CURSOR_QUERY_MISMATCH",
      detail: "游标签发时的查询条件与本次查询不一致,请按新条件重新查询",
    };
  }
  return { ok: true, code: "CURSOR_OK", detail: `generation=${currentGeneration} 且查询条件一致` };
}

/** 是否「语料已变」这一类否定结论(调用方据此重新从头查询,而不是继续翻页)。 */
export function isStaleError(code: unknown): boolean {
  return code === "CURSOR_STALE";
}

/** 推进 generation:任何一类语料变更都 +1;非数字 current 按 1 起算。 */
export function nextGeneration(current: unknown, cause: GenerationCause): number {
  const base = normalizeGeneration(current);
  switch (cause) {
    case "index-rebuild":
    case "corpus-change":
    case "reconcile":
    case "restart":
      return base + 1;
    default:
      // 未知 cause 也不许「原地不动」:调用方说语料变了,就必须让旧游标失效。
      return base + 1;
  }
}

/**
 * 批量应用语料变更事件(单事务语义):同一 cause 只推进一次,applied 去重且保持首次出现顺序,
 * generation = cursorGen + applied.length。
 *
 * 为什么去重:一次 reconcile 常常对「同一原因」上报多条事件(每张表一条),不去重会让 generation
 * 跳好几格,把纯粹内部的实现细节泄漏成对外可观测的版本号抖动。
 */
export function reconcile(
  events: readonly unknown[],
  options: { cursorGen: unknown },
): { generation: number; applied: string[] } {
  const base = normalizeGeneration(options.cursorGen);
  const applied: string[] = [];
  const list: readonly unknown[] = Array.isArray(events) ? events : [];
  for (const event of list) {
    const cause = causeOf(event);
    if (cause === undefined) continue;
    if (applied.includes(cause)) continue;
    applied.push(cause);
  }
  return { generation: base + applied.length, applied };
}

/** 游标台账计数:invalid 单列(含坏签名),不计入 mismatch;详见文件头口径。 */
export function cursorStats(cursors: readonly unknown[]): CursorStats {
  const stats: CursorStats = { issued: 0, stale: 0, mismatch: 0, invalid: 0 };
  const list: readonly unknown[] = Array.isArray(cursors) ? cursors : [];
  for (const item of list) {
    stats.issued += 1;
    const entry = isRecord(item) ? item : {};
    const verdict = validateCursor(entry["envelope"], {
      currentGeneration: entry["currentGeneration"],
      query: entry["query"],
    });
    if (verdict.code === "CURSOR_STALE") stats.stale += 1;
    else if (verdict.code === "CURSOR_QUERY_MISMATCH") stats.mismatch += 1;
    else if (verdict.code === "CURSOR_INVALID") stats.invalid += 1;
  }
  return stats;
}
