// 定时自动化的「投递 receipt」():一次计划发生的提交结果账本。
// 与 occurrence 账本的分工:
// - occurrence 记的是「这次发生有没有被认领/完成」(防重复触发);
// - receipt 记的是「投递本身结果如何」(成功 DELIVERED / 退避中 PENDING / 永久失败 FAILED),
// transient 失败按指数退避(30s 起、15min 封顶),permanent 直接 failed 不空转。
// 本模块为零 IO 纯逻辑:不抛异常、不读时钟(时间一律由调用方注入)、不改入参、确定性。

export const RECEIPT_CODES = [
  "OK",
  "PENDING",
  "DELIVERED",
  "FAILED",
  "CONFLICT",
  "DUPLICATE",
  "INVALID",
] as const;

export type ReceiptCode = (typeof RECEIPT_CODES)[number];

export interface Receipt {
 /** receiptKeyFor(automationId, occurrenceKey) 派生;空串=身份不可用。 */
  readonly key: string;
  readonly status: ReceiptCode;
 /** 已发生的 transient 失败次数(成功不累加)。 */
  readonly attempts: number;
 /** 仅 PENDING 有:早于该时刻不重试。 */
  readonly nextAttemptAt?: number;
 /** 最近一次失败原因(≤200 字符)。 */
  readonly error?: string;
 /** 本条 receipt 的写入时刻(调用方注入)。 */
  readonly at: number;
}

export interface DeliveryOutcome {
  readonly ok: boolean;
 /** 失败时的原始错误(任意类型,不 throw)。 */
  readonly error?: unknown;
}

/** 每条自动化保留的 receipt 条数上限(只留最近 N 条 key)。 */
export const RECEIPT_KEEP = 20;

/** 退避基数与上限。 */
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 900_000;

const REASON_MAX = 200;

/** receipt 账本键:`<automationId>#<occurrenceKey>`(以 # 分隔,不与 occurrence 的 @ 串味)。 */
export function receiptKeyFor(automationId: string, occurrenceKey: string): string {
  const id = String(automationId ?? "").trim();
  const occ = String(occurrenceKey ?? "").trim();
  if (!id || !occ) return "";
  return `${id}#${occ}`;
}

const TRANSIENT_RE = /timeout|econn|etimedout|429|\b5\d\d\b|network|temporarily/i;
const PERMANENT_RE = /\b(401|403|404|400)\b|invalid|permission/i;

function reasonOf(err: unknown): string {
  let raw = "";
  if (err instanceof Error) raw = err.message || err.name;
  else if (typeof err === "string") raw = err;
  else {
    try {
      const json = JSON.stringify(err);
 // undefined/函数/Symbol 序列化为 undefined:交给下面的 "unknown" 兜底。
      raw = json === undefined ? "" : json;
    } catch {
      raw = String(err);
    }
  }
  const text = String(raw ?? "").trim() || "unknown";
  return text.length > REASON_MAX ? text.slice(0, REASON_MAX) : text;
}

/**
 * 错误分类(不 throw,确定性):
 * timeout/ECONN/ETIMEDOUT/429/5xx/network/temporarily → transient;
 * 401/403/404/400/invalid/permission → permanent;未知 → transient(保守重试一次)。
 */
export function classifyDeliveryError(err: unknown): { kind: "transient" | "permanent"; reason: string } {
  const reason = reasonOf(err);
  if (TRANSIENT_RE.test(reason)) return { kind: "transient", reason };
  if (PERMANENT_RE.test(reason)) return { kind: "permanent", reason };
  return { kind: "transient", reason };
}

/** 指数退避:30s * 2^(attempts-1),封顶 900s;attempts<=0 → 0。 */
export function backoffMs(attempts: number): number {
  const n = Math.floor(Number(attempts));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const exp = Math.min(n - 1, 20);
  const raw = BACKOFF_BASE_MS * 2 ** exp;
  return Math.min(BACKOFF_MAX_MS, raw);
}

/**
 * 下一次 receipt(不可变:不改 prev,不 throw):
 * 成功 → DELIVERED;transient → PENDING(attempts+1,nextAttemptAt=at+backoff);
 * permanent → FAILED(无 nextAttemptAt);prev 已 DELIVERED → DUPLICATE。
 */
export function nextReceipt(
  prev: Receipt | null | undefined,
  outcome: DeliveryOutcome,
  opts: { at: number; key?: string },
): Receipt {
  const atNum = Number(opts?.at);
  const at = Number.isFinite(atNum) ? atNum : 0;
  const key = String(prev?.key ?? opts?.key ?? "");
  if (prev?.status === "DELIVERED") {
    return { key, status: "DUPLICATE", attempts: prev.attempts, at };
  }
  if (outcome?.ok) {
    return { key, status: "DELIVERED", attempts: prev?.attempts ?? 0, at };
  }
  const cls = classifyDeliveryError(outcome?.error);
  if (cls.kind === "permanent") {
    return { key, status: "FAILED", attempts: prev?.attempts ?? 0, error: cls.reason, at };
  }
  const attempts = (prev?.attempts ?? 0) + 1;
  return {
    key,
    status: "PENDING",
    attempts,
    nextAttemptAt: at + backoffMs(attempts),
    error: cls.reason,
    at,
  };
}

/**
 * 是否可投递:无 receipt → true;PENDING 且 now>=nextAttemptAt(缺 nextAttemptAt 视为到期)→ true;
 * 其余(DELIVERED/FAILED/OK/CONFLICT/DUPLICATE/INVALID)→ false(FAILED 不重试,DELIVERED 不重投)。
 */
export function isReady(receipt: Receipt | null | undefined, now: number): boolean {
  if (!receipt) return true;
  if (receipt.status !== "PENDING") return false;
  const due = Number(receipt.nextAttemptAt);
  if (!Number.isFinite(due)) return true;
  const t = Number(now);
  return Number.isFinite(t) ? t >= due : false;
}

/** 容量裁剪(纯函数,不改入参):按 at 升序淘汰最旧,同时刻按键名序;返回保留后的新对象。 */
export function pruneReceipts<T extends { at: number }>(
  records: Record<string, T> | null | undefined,
  limit: number = RECEIPT_KEEP): Record<string, T> {
  const src = records && typeof records === "object" ? records : {};
  const keys = Object.keys(src);
  const max = Math.floor(Number(limit));
  if (!Number.isFinite(max) || max < 0 || keys.length <= max) {
    const copy: Record<string, T> = {};
    for (const key of keys) copy[key] = src[key]!;
    return copy;
  }
  const ordered = keys.slice().sort((left, right) => {
    const dl = Number(src[left]?.at);
    const dr = Number(src[right]?.at);
    const al = Number.isFinite(dl) ? dl : 0;
    const ar = Number.isFinite(dr) ? dr : 0;
    return al === ar ? left.localeCompare(right) : al - ar;
  });
  const keep = new Set(ordered.slice(ordered.length - max));
  const out: Record<string, T> = {};
  for (const key of keys) if (keep.has(key)) out[key] = src[key]!;
  return out;
}
