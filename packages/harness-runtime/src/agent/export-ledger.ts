/**
 * 遥测导出账本(OTLP flush 前的 fail-closed 闸门;纯逻辑、零 IO、确定性、不 throw)。
 * 定位:把「一条记录能不能出站」收敛成一次可判定的决定,与 span 生成逻辑解耦。
 * 出口码只有五种:OK / DUPLICATE / TOO_LARGE / REDACTION_FAILED / INVALID。
 * 为什么超限只能拒绝、不能截断:
 * - 截断会把 attributes / status 削成「合法 JSON 但语义失真」的半截内容,下游无法区分
 * 「本来就是短值」与「被我们切了」;拒绝是可观测的事实(TOO_LARGE 计数 + 该条不出现),
 * 运维能据此收紧 span 生成或调大 maxRecordBytes。
 * - 截断还破坏「导出副本 == 记录」的可核对性;拒绝保证出站内容要么完整、要么不存在。
 * 为什么 redaction 失败必须丢该条:
 * - 脱敏器抛错 / 返回非对象时,我们无法证明该条不含凭证。fail-closed 的唯一安全选择是
 * 不外送——宁可丢一条遥测,不可泄漏一次密钥。失败之外**绝不回退到原记录**,那等于把
 * 未脱敏内容直接送上公网;因此失败分支根本不携带 record 字段。
 * 导出副本纪律:copyForExport 用 JSON round-trip 深拷贝,调用方只允许改写副本;
 * 事实源(journal 事件 / span 本体)永远不被导出链触碰。
 */
import { redactText } from "@lampgenie/core";

/** 导出闸门的五种出口码(顺序即文档顺序)。 */
export const EXPORT_CODES = ["OK", "DUPLICATE", "TOO_LARGE", "REDACTION_FAILED", "INVALID"] as const;
export type ExportCode = (typeof EXPORT_CODES)[number];

/**
 * 去重键:(format, session, seq/spanId) 三元组。
 * 逐字拼接而非 JSON 编码,保证同一三元组在任何进程/任何时刻得到同一字符串(可跨进程比对)。
 */
export function dedupeKeyOf(sessionId: string, format: string, seqOrSpanId: string | number): string {
  return `${format}:${sessionId}:${String(seqOrSpanId)}`;
}

export interface AdmitResult {
  ok: boolean;
  code: ExportCode;
 /** 记录序列化后的 UTF-8 字节数(INVALID 时为 0)。 */
  bytes: number;
}

export interface ExportLedgerStats {
  admitted: number;
  duplicates: number;
  tooLarge: number;
  redactionFailed: number;
 /** 当前账本内仍保留的去重键数量。 */
  keys: number;
}

export interface ExportLedgerOptions {
 /** 去重键上限(超出按 LRU 淘汰最旧;缺省 20000)。 */
  maxKeys?: number;
 /** 单条记录字节上限(超出判 TOO_LARGE,不截断;缺省 256 KiB)。 */
  maxRecordBytes?: number;
 /** 时钟注入(测试用;记录最近使用时间戳,不参与淘汰判定)。 */
  now?: () => number;
}

interface SerializedSize {
  ok: boolean;
  bytes: number;
}

/** JSON 序列化并算 UTF-8 字节数;不可序列化(circular / BigInt / undefined)返回 ok:false。 */
function serializedSize(record: unknown): SerializedSize {
  try {
    const text = JSON.stringify(record);
    if (typeof text !== "string") return { ok: false, bytes: 0 };
    return { ok: true, bytes: Buffer.byteLength(text, "utf8") };
  } catch {
    return { ok: false, bytes: 0 };
  }
}

/**
 * 导出账本:登记 + 去重 + 体积拒绝 + LRU 淘汰。
 * 所有方法均不抛错;同一输入序列的判定与计数完全确定。
 */
export class ExportLedger {
  private readonly maxKeys: number;
  private readonly maxRecordBytes: number;
  private readonly now: () => number;
 /** key → 最近使用时间戳;Map 迭代顺序即 LRU 顺序(命中时 delete+set 刷新)。 */
  private readonly entries = new Map<string, number>();
  private admitted = 0;
  private duplicates = 0;
  private tooLarge = 0;
  private redactionFailed = 0;

  constructor(opts: ExportLedgerOptions = {}) {
    const maxKeys = Number.isFinite(opts.maxKeys) ? Math.floor(opts.maxKeys as number) : 20_000;
    const maxRecordBytes = Number.isFinite(opts.maxRecordBytes) ? Math.floor(opts.maxRecordBytes as number) : 262_144;
    this.maxKeys = Math.max(1, maxKeys);
    this.maxRecordBytes = Math.max(0, maxRecordBytes);
    this.now = opts.now ?? Date.now;
  }

 /**
 * 判定一条记录能否出站,OK 时登记去重键。
 * 判定顺序固定:空 key / 不可序列化 → INVALID;超限 → TOO_LARGE;已存在 → DUPLICATE;否则 OK。
 */
  admit(key: string, record: unknown): AdmitResult {
    if (typeof key !== "string" || key.length === 0) {
      return { ok: false, code: "INVALID", bytes: 0 };
    }
    const size = serializedSize(record);
    if (!size.ok) return { ok: false, code: "INVALID", bytes: 0 };
    if (size.bytes > this.maxRecordBytes) {
      this.tooLarge += 1;
      return { ok: false, code: "TOO_LARGE", bytes: size.bytes };
    }
    const at = this.now();
    if (this.entries.has(key)) {
 // 命中即刷新 LRU 位置(重复条目仍算「最近被需要」,不应因重放被优先淘汰)。
      this.entries.delete(key);
      this.entries.set(key, at);
      this.duplicates += 1;
      return { ok: false, code: "DUPLICATE", bytes: size.bytes };
    }
    this.entries.set(key, at);
    this.admitted += 1;
 // LRU 淘汰最旧;while 而非 if,防止 maxKeys 被构造后非法变更导致的越界。
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return { ok: true, code: "OK", bytes: size.bytes };
  }

 /**
 * 登记一次 redaction 失败。
 * redactForExport 是纯函数、拿不到账本,故失败计数由调用方显式回报(避免把账本注入脱敏器)。
 */
  markRedactionFailed(): void {
    this.redactionFailed += 1;
  }

 /** 去重键是否仍在账本内(观测/测试用;不刷新 LRU)。 */
  has(key: string): boolean {
    return this.entries.has(key);
  }

 /** 键的最近使用时间戳(未登记返回 undefined;观测用)。 */
  lastTouchedAt(key: string): number | undefined {
    return this.entries.get(key);
  }

  stats(): ExportLedgerStats {
    return {
      admitted: this.admitted,
      duplicates: this.duplicates,
      tooLarge: this.tooLarge,
      redactionFailed: this.redactionFailed,
      keys: this.entries.size,
    };
  }
}

/** 自定义脱敏器契约:输入记录,返回脱敏后的**新**对象;抛错或返回非对象即判失败。 */
export type ExportRedactor = (record: unknown) => unknown;

/**
 * 默认脱敏器:递归遍历对象/数组,对每个字符串跑 core 的 redactText(幂等)。
 * 不用 redactEventPayload 的原因:它只覆盖 payload 的固定键(arguments/content/text/error),
 * 而 OTel span 的凭证藏在 attributes[].value.stringValue 与 name 里,必须按位置递归才能覆盖。
 */
function deepRedactStrings(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(deepRedactStrings);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepRedactStrings(v);
    }
    return out;
  }
  return value;
}

export const defaultExportRedactor: ExportRedactor = (record) => deepRedactStrings(record);

export type RedactForExportResult =
  | { ok: true; record: unknown }
  | { ok: false; code: "REDACTION_FAILED" | "INVALID"; error: string };

/**
 * 对**导出副本**做脱敏。fail-closed 边界:
 * - 输入不是对象(含数组/null) → INVALID(不是可导出的记录形状);
 * - 脱敏器抛错 / 返回非对象 / 返回原引用(未真正脱敏) → REDACTION_FAILED;
 * - 失败分支不携带 record —— 绝不把原记录当降级结果外送。
 */
export function redactForExport(
  record: unknown,
  redactor: ExportRedactor = defaultExportRedactor): RedactForExportResult {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, code: "INVALID", error: "record-not-object" };
  }
  try {
    const out = redactor(record);
    if (out === null || typeof out !== "object" || Array.isArray(out)) {
      return { ok: false, code: "REDACTION_FAILED", error: "redactor-returned-non-object" };
    }
    if (out === record) {
 // 返回原引用=调用方可能原地改写了事实源,且无法证明脱敏发生过 → 视为失败(保守)。
      return { ok: false, code: "REDACTION_FAILED", error: "redactor-returned-original" };
    }
    return { ok: true, record: out };
  } catch (err) {
    return { ok: false, code: "REDACTION_FAILED", error: err instanceof Error ? err.message : String(err) };
  }
}

export type CopyForExportResult =
  | { ok: true; record: unknown }
  | { ok: false; code: "INVALID"; error: string };

/**
 * 导出副本:JSON round-trip 深拷贝。不可序列化 → INVALID(不降级为浅拷贝,
 * 浅拷贝会让嵌套对象与事实源共享引用,脱敏时就地改写会污染源)。
 */
export function copyForExport(record: unknown): CopyForExportResult {
  try {
    const text = JSON.stringify(record);
    if (typeof text !== "string") return { ok: false, code: "INVALID", error: "not-serializable" };
    return { ok: true, record: JSON.parse(text) };
  } catch (err) {
    return { ok: false, code: "INVALID", error: err instanceof Error ? err.message : String(err) };
  }
}
