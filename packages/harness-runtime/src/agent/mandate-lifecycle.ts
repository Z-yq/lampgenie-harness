/**
 * Mandate 生命周期与策略复验(纯逻辑:零 IO / 零依赖 / 不 throw / 不可变 / 确定性)。
 * 为什么 mandate 不能只做「不可变凭证」:
 * 一张签发时合法的凭证,在两个执行间隙之间会因为与签发动作无关的事实失效——被人显式吊销(stop)、
 * 到期、以及授权依据本身变了(策略的 rules/mode/sources 被改)。若 resume 只按签发时的快照放行,
 * 用户在 T0 授权的任务就会以「当时合法」为由在 T1 继续跑,而 T1 的策略可能早已不允许它。
 * 三种失效一律 fail-closed:判定不出「现在仍然有效」,就不放行。
 * 为什么 resume 必须按「当前」策略复验,而不是信任 mandate 里记的 policyVersion:
 * policyVersion 是签发时刻的指纹,它只能证明「签发时策略是哪一版」,不能证明「现在还是那一版」。
 * 复验的唯一意义就是把签发版本与当前版本对比:不等 → POLICY_CHANGED(要求重新审批),
 * 既不悄悄放行(旧凭证在旧规则下越权),也不悄悄作废(用户只看到凭证莫名失效,却不知道是策略变了)。
 * 所以复验的输入必须是「当前策略版本」,而不是读 mandate 自己记的那一版。
 * 不可变约定:所有操作返回新对象,绝不就地改写入参——凭证要能被反复比对与审计回放,
 * 一次就地改状态就会让「签发时是什么」永久丢失。
 */

/** 判定码:OK=可用;REVOKED/EXPIRED/POLICY_CHANGED=不可用(需重新审批);NOT_FOUND=凭证缺失;INVALID=形态非法。 */
export const MANDATE_CODES = {
  OK: "OK",
  REVOKED: "REVOKED",
  EXPIRED: "EXPIRED",
  POLICY_CHANGED: "POLICY_CHANGED",
  NOT_FOUND: "NOT_FOUND",
  INVALID: "INVALID",
} as const;

export type MandateCode = (typeof MANDATE_CODES)[keyof typeof MANDATE_CODES];

/** 凭证状态:active=可用 / revoked=已吊销(不可逆) / expired=已过期(不可逆)。 */
export const MANDATE_STATUSES = ["active", "revoked", "expired"] as const;
export type MandateStatus = (typeof MANDATE_STATUSES)[number];

/** 凭证形态(只含授权溯源要素,不含任何密钥/令牌字段)。 */
export interface MandateLike {
 /** 凭证 id(全局唯一,审计与去重键)。 */
  id: string;
 /** 签发时刻的策略版本哈希。 */
  policyVersion: string;
 /** 生命周期状态。 */
  status: MandateStatus;
 /** 签发时刻(epoch ms)。 */
  issuedAt: number;
 /** 过期时刻(epoch ms,含边界;缺省=不过期)。 */
  expiresAt?: number;
 /** 该凭证覆盖的 Ticket id 集。 */
  ticketIds: string[];
 /** 吊销时刻(仅 status=revoked 时存在)。 */
  revokedAt?: number;
 /** 吊销者(身份标识)。 */
  revokedBy?: string;
 /** 吊销理由(审计用,不落任何凭证)。 */
  revokeReason?: string;
}

/** 吊销输入:by/reason 必填——吊销是安全动作,「谁按的」与「为什么」缺一不可回放。 */
export interface MandateRevokeInput {
  by?: string;
  reason?: string;
 /** 吊销时刻(epoch ms);缺省 0(调用方应传真实时刻)。 */
  at?: number;
}

/** 状态变更结果:mandate 是「变更后的新对象」,code 说明本次变更的判定。 */
export interface MandateChange {
  mandate: MandateLike | null;
  code: MandateCode;
}

/** 复验结论:ok 与 code 同源(reason 供审计/面板展示)。 */
export interface MandateVerdict {
  ok: boolean;
  code: MandateCode;
  reason: string;
}

/** 受影响 Ticket 点名结果(按 mandate 聚合,供「策略变更只点名受影响单」)。 */
export interface AffectedTickets {
  mandateId: string;
  policyVersion: string;
  ticketIds: string[];
}

/** 形态校验:字段缺失/类型不对一律视为 INVALID(不 throw,不猜)。 */
function isMandateLike(m: unknown): m is MandateLike {
  if (!m || typeof m !== "object") return false;
  const x = m as Record<string, unknown>;
  return typeof x.id === "string"
    && x.id.length > 0
    && typeof x.policyVersion === "string"
    && MANDATE_STATUSES.includes(x.status as MandateStatus)
    && typeof x.issuedAt === "number"
    && Number.isFinite(x.issuedAt)
    && Array.isArray(x.ticketIds)
    && x.ticketIds.every((t) => typeof t === "string");
}

/** 归一化时刻输入:非有限数一律按 0 处理(纯函数不读系统时间)。 */
function atOrZero(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/**
 * 过期判定:expiresAt 是含边界上界——expiresAt <= now 即过期。
 * 边界归「过期」是刻意的 fail-closed:恰好在 expiresAt 那一毫秒,凭证不再被信任。
 */
export function isMandateExpired(m: MandateLike, now: number): boolean {
  return typeof m.expiresAt === "number" && Number.isFinite(m.expiresAt) && m.expiresAt <= atOrZero(now);
}

/**
 * 吊销:active → revoked(不可逆)。返回新对象,入参不变。
 * - 已 revoked:幂等返回**原对象引用** + REVOKED(重复按 stop 不是错误);
 * - 已 expired:不可逆,保持 expired,返回 EXPIRED(不能让过期凭证借吊销「洗白」成另一状态);
 * - by/reason 缺失或空串:INVALID(吊销必须可追溯);
 * - 凭证缺失:NOT_FOUND;形态非法:INVALID。
 */
export function revokeMandate(
  m: MandateLike | null | undefined,
  input?: MandateRevokeInput): MandateChange {
  if (m == null) return { mandate: null, code: MANDATE_CODES.NOT_FOUND };
  if (!isMandateLike(m)) return { mandate: null, code: MANDATE_CODES.INVALID };
  const by = input?.by;
  const reason = input?.reason;
  if (typeof by !== "string" || by.trim() === "" || typeof reason !== "string" || reason.trim() === "") {
    return { mandate: m, code: MANDATE_CODES.INVALID };
  }
  if (m.status === "revoked") return { mandate: m, code: MANDATE_CODES.REVOKED };
  if (m.status === "expired") return { mandate: m, code: MANDATE_CODES.EXPIRED };
  return {
    mandate: {
      ...m,
      status: "revoked",
      revokedAt: atOrZero(input?.at),
      revokedBy: by,
      revokeReason: reason,
    },
    code: MANDATE_CODES.OK,
  };
}

/**
 * 过期:active 且 expiresAt<=now → expired(不可逆)。返回新对象,入参不变。
 * - 尚未到期 / 无 expiresAt:原对象不变 + OK(调用方据 status 判断是否发生过期);
 * - 已 expired:原对象 + EXPIRED(幂等);
 * - 已 revoked:原对象 + REVOKED(吊销优先,不再改成过期——吊销是更强的安全事实)。
 */
export function expireMandate(
  m: MandateLike | null | undefined,
  now: number): MandateChange {
  if (m == null) return { mandate: null, code: MANDATE_CODES.NOT_FOUND };
  if (!isMandateLike(m)) return { mandate: null, code: MANDATE_CODES.INVALID };
  if (m.status === "expired") return { mandate: m, code: MANDATE_CODES.EXPIRED };
  if (m.status === "revoked") return { mandate: m, code: MANDATE_CODES.REVOKED };
  if (!isMandateExpired(m, now)) return { mandate: m, code: MANDATE_CODES.OK };
  return { mandate: { ...m, status: "expired" }, code: MANDATE_CODES.OK };
}

/**
 * resume 前复验:凭当前策略版本与当前时刻判定这张凭证是否还能继续用。
 * 判定顺序 = 安全强度顺序:吊销 > 过期 > 策略变更 > OK。
 * 先判吊销与过期,是因为它们比「策略变了」更是硬事实:即使当前策略恰好与签发版一致,
 * 一张被吊销或已过期的凭证也不能复活——策略复验只能收紧,不能放宽生命周期。
 * 返回值不 throw:任何缺失/非法输入都落成明确的 code,fail-closed。
 */
export function revalidateForResume(
  m: MandateLike | null | undefined,
  currentPolicyVersion: string,
  now?: number): MandateVerdict {
  if (m == null) return { ok: false, code: MANDATE_CODES.NOT_FOUND, reason: "mandate not found" };
  if (!isMandateLike(m)) return { ok: false, code: MANDATE_CODES.INVALID, reason: "invalid mandate" };
  if (typeof currentPolicyVersion !== "string" || currentPolicyVersion === "") {
 // 当前版本缺失就无法证明「还是那一版」——判不出即拒,不许默认放行。
    return { ok: false, code: MANDATE_CODES.INVALID, reason: "invalid current policy version" };
  }
  if (m.status === "revoked") return { ok: false, code: MANDATE_CODES.REVOKED, reason: "mandate revoked" };
  if (m.status === "expired") return { ok: false, code: MANDATE_CODES.EXPIRED, reason: "mandate expired" };
  if (isMandateExpired(m, atOrZero(now))) {
    return { ok: false, code: MANDATE_CODES.EXPIRED, reason: "mandate expired" };
  }
  if (m.policyVersion !== currentPolicyVersion) {
 // 旧凭证在新策略下没有授权效力:必须重新审批,而不是自动续期。
    return { ok: false, code: MANDATE_CODES.POLICY_CHANGED, reason: "policy version changed: re-approval required" };
  }
  return { ok: true, code: MANDATE_CODES.OK, reason: "ok" };
}

/**
 * gate 用布尔判定(与 revalidateForResume 同源,不另立口径)。
 * 返回 ok+code:gate 只关心「能不能投」,审计关心 code 说的是哪一种失效。
 */
export function canAdmitWithMandate(
  m: MandateLike | null | undefined,
  currentPolicyVersion: string,
  now?: number): { ok: boolean; code: MandateCode } {
  const v = revalidateForResume(m, currentPolicyVersion, now);
  return { ok: v.ok, code: v.code };
}

/** 码点序比较:确定性排序不用 localeCompare(它依赖运行环境 locale)。 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 策略变更的影响面:只点名「active 且签发版本≠新版本」的 mandate 及其 ticket。
 * - revoked/expired 的 ticket 已按 fail-closed 停掉,再通知一次只会制造重复工单;
 * - 版本相同的不受影响——把它们一起点名等于「一改规则就全量重审」,影响半径会放大到不可用;
 * - ticketIds 去重并按码点排序,mandate 按 id 排序:同输入必得同输出(可断言、可回放);
 * - 同一 id 多次出现(例如分片加载)合并 ticket 集,不重复通知。
 */
export function affectedTickets(
  mandates: readonly (MandateLike | null | undefined)[],
  newPolicyVersion: string): AffectedTickets[] {
  if (!Array.isArray(mandates)) return [];
  if (typeof newPolicyVersion !== "string" || newPolicyVersion === "") return [];
  const merged = new Map<string, { policyVersion: string; ticketIds: string[] }>();
  for (const m of mandates) {
    if (!isMandateLike(m)) continue;
    if (m.status !== "active") continue;
    if (m.policyVersion === newPolicyVersion) continue;
    const prev = merged.get(m.id);
    const ids = prev ? prev.ticketIds : [];
    for (const t of m.ticketIds) if (typeof t === "string") ids.push(t);
    merged.set(m.id, { policyVersion: m.policyVersion, ticketIds: ids });
  }
  return [...merged.entries()]
    .map(([mandateId, v]) => ({
      mandateId,
      policyVersion: v.policyVersion,
      ticketIds: [...new Set(v.ticketIds)].sort(byCodeUnit),
    }))
    .sort((a, b) => byCodeUnit(a.mandateId, b.mandateId));
}
