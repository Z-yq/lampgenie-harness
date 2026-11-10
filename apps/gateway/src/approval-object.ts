/**
 * M151 审批对象=执行对象(审批前冻结入参,执行前按同一对象复核):
 * 批准的是 A、执行的是 B(路径替换/工作流设置)是典型 TOCTOU——面板确认窗内入参可被改动,
 * 同一次调用在两处上下文得出两种判定。
 *
 * 口径:
 * - snapshotApprovalObject(input):JSON 安全深拷贝(循环引用/不可序列化→错误码)+ deepFreeze,
 *   返回 {frozen, hash, json};hash=canonical JSON 的 sha256 前 16 位。
 * - approvalObjectHash(value):canonical JSON(键排序递归、数组保序、undefined/函数/符号忽略)。
 * - verifyApprovalObject(frozen, actual):hash 相同=ok;不同=PERMISSION_OBJECT_CHANGED(带双 hash);
 *   frozen 被外部改过(伪冻结/标记丢失)→ PERMISSION_OBJECT_TAMPERED。
 * - applyInputAdjustments:受控改参(只允许 allowlist 字段);changed=true 时调用方必须用同一
 *   broker/policy 上下文重判(rejudgeRequired=true)。
 */
import { createHash } from "node:crypto";

const HASH_MARK = Symbol.for("genie.approvalObjectHash");

export type ApprovalObjectErrorCode = "APPROVAL_OBJECT_CYCLE" | "APPROVAL_OBJECT_NOT_SERIALIZABLE";

export class ApprovalObjectError extends Error {
  readonly code: ApprovalObjectErrorCode;
  constructor(code: ApprovalObjectErrorCode, message: string) {
    super(message);
    this.name = "ApprovalObjectError";
    this.code = code;
  }
}

/** canonical JSON:键排序递归、数组保序、undefined/函数/符号忽略(数组内降级 null,同 JSON)。 */
function canonicalValue(value: unknown, stack: Set<object>): string | undefined {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "undefined" || t === "function" || t === "symbol") return undefined;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    const n = value as number;
    return Number.isFinite(n) ? (JSON.stringify(n) as string) : "null";
  }
  if (t === "bigint") throw new ApprovalObjectError("APPROVAL_OBJECT_NOT_SERIALIZABLE", "bigint 不可 JSON 化");
  if (t === "string") return JSON.stringify(value) as string;
  const obj = value as object;
  if (stack.has(obj)) throw new ApprovalObjectError("APPROVAL_OBJECT_CYCLE", "审批对象存在循环引用");
  stack.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (const item of obj) parts.push(canonicalValue(item, stack) ?? "null");
      return `[${parts.join(",")}]`;
    }
    const toJson = (obj as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") {
      return canonicalValue((toJson as () => unknown).call(obj), stack) ?? "null";
    }
    const rec = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(rec).sort()) {
      const v = canonicalValue(rec[key], stack);
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${v}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    stack.delete(obj);
  }
}

/** canonical JSON 文本(根值不可 JSON 化→错误码)。 */
export function canonicalApprovalJson(value: unknown): string {
  const out = canonicalValue(value, new Set());
  if (out === undefined) {
    throw new ApprovalObjectError("APPROVAL_OBJECT_NOT_SERIALIZABLE", "审批对象根值不可 JSON 化");
  }
  return out;
}

function sha16(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** 审批对象哈希:canonical JSON 的 sha256 前 16 位(键序无关、数组序相关)。 */
export function approvalObjectHash(value: unknown): string {
  return sha16(canonicalApprovalJson(value));
}

/** 深度冻结(纯对象/数组;已冻结/循环引用安全)。 */
export function deepFreeze<T>(value: T): T {
  const walk = (v: unknown, seen: Set<object>): void => {
    if (v === null || typeof v !== "object") return;
    const obj = v as object;
    if (seen.has(obj)) return;
    seen.add(obj);
    if (!Object.isFrozen(obj)) {
      for (const key of Object.keys(obj)) walk((obj as Record<string, unknown>)[key], seen);
      Object.freeze(obj);
    }
  };
  walk(value, new Set());
  return value;
}

function isDeepFrozen(value: unknown): boolean {
  const walk = (v: unknown, seen: Set<object>): boolean => {
    if (v === null || typeof v !== "object") return true;
    const obj = v as object;
    if (seen.has(obj)) return true;
    seen.add(obj);
    if (!Object.isFrozen(obj)) return false;
    for (const key of Object.keys(obj)) if (!walk((obj as Record<string, unknown>)[key], seen)) return false;
    return true;
  };
  return walk(value, new Set());
}

export interface ApprovalSnapshot {
  frozen: unknown;
  hash: string;
  json: string;
}

export type SnapshotApprovalObjectResult =
  | ({ ok: true } & ApprovalSnapshot)
  | { ok: false; code: ApprovalObjectErrorCode; message: string };

/** 审批前冻结入参:深拷贝(JSON 安全)+ deepFreeze + hash。 */
export function snapshotApprovalObject(input: unknown): SnapshotApprovalObjectResult {
  let json: string;
  try {
    json = canonicalApprovalJson(input);
  } catch (err) {
    if (err instanceof ApprovalObjectError) return { ok: false, code: err.code, message: err.message };
    throw err;
  }
  const frozen = JSON.parse(json) as unknown;
  const hash = sha16(json);
  // 冻结后打非枚举标记(hash 真源):verify 据此识别「伪冻结/外部改过」。
  if (frozen !== null && typeof frozen === "object") {
    Object.defineProperty(frozen as object, HASH_MARK, { value: hash, enumerable: false, writable: false, configurable: false });
    deepFreeze(frozen);
  }
  return { ok: true, frozen, hash, json };
}

export interface ApprovalVerifyOk {
  ok: true;
}

export interface ApprovalVerifyFail {
  ok: false;
  code: "PERMISSION_OBJECT_CHANGED" | "PERMISSION_OBJECT_TAMPERED";
  beforeHash: string;
  afterHash: string;
}

export type ApprovalVerifyResult = ApprovalVerifyOk | ApprovalVerifyFail;

function safeHash(value: unknown): string {
  try {
    return approvalObjectHash(value);
  } catch {
    return "<unserializable>";
  }
}

/** 执行前复核:frozen 与 actual(现场重新读取的可执行面)hash 相同才放行。 */
export function verifyApprovalObject(frozen: unknown, actual: unknown): ApprovalVerifyResult {
  const afterHash = safeHash(actual);
  if (frozen === null || typeof frozen !== "object") {
    // 原始值不可被外部改;hash 不同即 changed。
    const beforeHash = safeHash(frozen);
    return beforeHash === afterHash
      ? { ok: true }
      : { ok: false, code: "PERMISSION_OBJECT_CHANGED", beforeHash, afterHash };
  }
  const mark = (frozen as Record<symbol, unknown>)[HASH_MARK];
  let currentHash: string;
  try {
    currentHash = approvalObjectHash(frozen);
  } catch {
    return { ok: false, code: "PERMISSION_OBJECT_TAMPERED", beforeHash: "<unserializable>", afterHash };
  }
  if (typeof mark !== "string") {
    // 无冻结标记(被 JSON/spread 克隆丢了标记或根本没冻结过)→ 视为篡改。
    return { ok: false, code: "PERMISSION_OBJECT_TAMPERED", beforeHash: currentHash, afterHash: currentHash };
  }
  if (mark !== currentHash || !isDeepFrozen(frozen)) {
    return { ok: false, code: "PERMISSION_OBJECT_TAMPERED", beforeHash: mark, afterHash: currentHash };
  }
  if (currentHash === afterHash) return { ok: true };
  return { ok: false, code: "PERMISSION_OBJECT_CHANGED", beforeHash: mark, afterHash };
}

export type ApplyAdjustmentsResult =
  | {
      ok: true;
      /** 改参后的副本(原 input 不被改)。 */
      value: Record<string, unknown>;
      /** 实际写入的字段(按 adjustments 键序,跳过 undefined)。 */
      applied: string[];
      changed: boolean;
      /** changed=true 时调用方必须用同一 broker/policy 上下文重判。 */
      rejudgeRequired: boolean;
    }
  | { ok: false; error: "ADJUSTMENT_NOT_ALLOWED"; field: string };

/** 受控改参:只允许 allowlist 字段;越权→错误码,不允许静默丢弃。 */
export function applyInputAdjustments(
  input: Record<string, unknown>,
  adjustments: Record<string, unknown>,
  allowlist: readonly string[],
): ApplyAdjustmentsResult {
  const allowed = new Set(allowlist);
  for (const key of Object.keys(adjustments)) {
    if (!allowed.has(key)) return { ok: false, error: "ADJUSTMENT_NOT_ALLOWED", field: key };
  }
  const value = JSON.parse(canonicalApprovalJson(input)) as Record<string, unknown>;
  const applied: string[] = [];
  for (const key of Object.keys(adjustments)) {
    const v = adjustments[key];
    if (v === undefined) continue; // 同 canonical 口径:undefined=忽略
    value[key] = v;
    applied.push(key);
  }
  const changed = canonicalApprovalJson(value) !== canonicalApprovalJson(input);
  return { ok: true, value, applied, changed, rejudgeRequired: changed };
}
