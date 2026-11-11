/**
 * 事件级冻结路由身份(纯逻辑,零 IO,不 throw,确定性)。
 * 为什么身份必须在入站时冻结、不能每跳重算:
 * 一条入站事件要穿过 source 监听门 → 订阅直通 → mandate 复验 → 准入矩阵 → 白名单等多次判定。
 * 如果每一跳都重新从事件里推导「这条消息属于哪个租户、哪个来源、谁发的」,
 * 那么只要中间某一跳的载荷被补字段/改来源/换代际,同一事件在不同跳就会得到不同身份——
 * 授权在 A 跳按「租户 t1 的用户 u1」放行,到 B 跳却按「租户 t2 的用户 u9」执行,
 * 这就是身份穿帮,审计也无法复算当时到底按谁判的。
 * 冻结一次、后续只校验不重算,换来三件事:
 * ① 同一事件在整条链上的身份唯一(key 由冻结快照派生);
 * ② 审计可按冻结快照复算,而不是按「当时怎么推的」;
 * ③ 旧事件不会被新代际的身份借用(generation 不等 → STALE_GENERATION)。
 */
import { createHash } from "node:crypto";

/** 稳定拒绝码:调用方与审计按码判档,不得依赖 reason 文案。 */
export const ROUTE_IDENTITY_CODES = [
  "OK",
  "NO_IDENTITY",
  "UNKNOWN_SOURCE",
  "TENANT_DENIED",
  "IDENTITY_MISMATCH",
  "STALE_GENERATION",
  "INVALID",
] as const;
export type RouteIdentityCode = (typeof ROUTE_IDENTITY_CODES)[number];

/** 允许的来源类别。枚举外的来源一律 UNKNOWN_SOURCE(未知来源不可路由)。 */
export const ROUTE_SOURCE_KINDS = ["dm", "group", "thread", "cron", "webhook", "system"] as const;
export type RouteSourceKind = (typeof ROUTE_SOURCE_KINDS)[number];

/** 必须有主体标识的来源:不知道是谁发来的消息不允许进入判定。webhook/system 允许匿名主体。 */
const SUBJECT_REQUIRED: readonly string[] = ["dm", "group", "thread", "cron"];

/** 冻结后的路由身份快照(值对象,创建后不可变)。 */
export interface RouteIdentity {
 /** sha256(`${tenantId}|${sourceKind}|${subjectId}|${threadId ?? ""}`) 前 24 位。 */
  readonly key: string;
  readonly tenantId: string;
  readonly sourceKind: RouteSourceKind;
 /** 主体(发送者/被调度的任务);webhook/system 可缺省。 */
  readonly subjectId?: string;
 /** 会话/线程标识(参与 key 派生)。 */
  readonly threadId?: string;
 /** 身份代际:同一主体重新授权/迁移后旧事件不得沿用新代际。 */
  readonly generation: number;
 /** 冻结时刻(epoch ms);纯函数不读时钟,由调用方传入以保证确定性。 */
  readonly frozenAt: number;
}

/** 冻结身份所需的策略侧上下文(allowedTenants/generation 只从这里读,不从事件里自报)。 */
export interface FreezeContext {
  tenantId: string;
 /** 期望六类之一;其余值判 UNKNOWN_SOURCE。 */
  sourceKind: string;
  subjectId?: string;
  threadId?: string;
 /** 租户白名单;提供时不在名单内 → TENANT_DENIED。 */
  allowedTenants?: readonly string[];
  generation?: number;
 /** 冻结时刻;缺省 0(不读系统时间,保证同一输入同一输出)。 */
  frozenAt?: number;
}

export type FreezeRouteIdentityResult =
  | { ok: true; identity: RouteIdentity }
  | { ok: false; code: RouteIdentityCode };

/** 校验时可选的外部事实:入站事件、当前代际、策略版本(版本仅留接口位)。 */
export interface VerifyIdentityOptions {
  event?: unknown;
 /**
 * 策略版本:刻意不参与判定——策略换版说明的是「规则变了」,不是「身份变了」;
 * 把两者混为一谈会让一次无害的规则编辑把在途事件全部判死。
 */
  policyVersion?: string;
 /** 当前代际:与冻结值不等 → STALE_GENERATION。 */
  currentGeneration?: number;
}

export interface VerifyIdentityResult {
  ok: boolean;
  code: RouteIdentityCode;
 /** 诊断原因(稳定前缀);OK 时为空数组。 */
  reasons: string[];
}

/** 路由准入的最小判定结果形状(与 gateway 的 GateResult 结构兼容)。 */
export interface RouteGateResult {
  admissible: boolean;
  strength?: string;
  reason?: string;
}

type AnyRecord = Record<string, unknown>;

function asRecord(v: unknown): AnyRecord | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as AnyRecord) : undefined;
}

function nonEmpty(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** 依次在多个记录里取第一个非空字符串字段(记录优先级 > 字段别名顺序)。 */
function pick(recs: Array<AnyRecord | undefined>, names: readonly string[]): string | undefined {
  for (const rec of recs) {
    if (!rec) continue;
    for (const name of names) {
      const v = nonEmpty(rec[name]);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

function isKind(v: unknown): v is RouteSourceKind {
  return typeof v === "string" && (ROUTE_SOURCE_KINDS as readonly string[]).includes(v);
}

/** key 派生:只由冻结快照的四个要素决定,不含时刻,故同一身份 key 恒稳定。 */
function identityKeyOf(parts: {
  tenantId: string;
  sourceKind: string;
  subjectId?: string;
  threadId?: string;
}): string {
  const raw = `${parts.tenantId}|${parts.sourceKind}|${parts.subjectId ?? ""}|${parts.threadId ?? ""}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

/**
 * 从入站事件 + 策略上下文派生并冻结身份。
 * 判定顺序刻意固定(tenant → source → subject),保证同一坏输入恒得同一码。
 */
export function freezeRouteIdentity(event: unknown, ctx: FreezeContext): FreezeRouteIdentityResult {
  try {
    const c = asRecord(ctx);
    if (!c) return { ok: false, code: "INVALID" };
    const ev = asRecord(event);
 // ctx 是策略口径(更高权),事件字段只做补齐:同一字段以 ctx 为准。
    const tenantId = pick([c, ev], ["tenantId"]);
    const sourceKindRaw = pick([c, ev], ["sourceKind", "kind"]);
    const subjectId = pick([c, ev], ["subjectId", "senderId", "from"]);
    const threadId = pick([c, ev], ["threadId", "threadKey"]);

    if (tenantId === undefined) return { ok: false, code: "TENANT_DENIED" };
    const allowed = Array.isArray(c.allowedTenants)
      ? (c.allowedTenants as unknown[]).filter((x): x is string => typeof x === "string")
      : undefined;
    if (allowed !== undefined && !allowed.includes(tenantId)) {
      return { ok: false, code: "TENANT_DENIED" };
    }

    if (!isKind(sourceKindRaw)) return { ok: false, code: "UNKNOWN_SOURCE" };
    if (SUBJECT_REQUIRED.includes(sourceKindRaw) && subjectId === undefined) {
      return { ok: false, code: "NO_IDENTITY" };
    }

    const genRaw = c.generation;
    const generation = typeof genRaw === "number" && Number.isFinite(genRaw) && genRaw >= 0
      ? Math.floor(genRaw)
      : 0;
    const atRaw = c.frozenAt;
    const frozenAt = typeof atRaw === "number" && Number.isFinite(atRaw) ? atRaw : 0;

    const key = identityKeyOf({ tenantId, sourceKind: sourceKindRaw, subjectId, threadId });
    const identity: RouteIdentity = Object.freeze({
      key,
      tenantId,
      sourceKind: sourceKindRaw,
      ...(subjectId !== undefined ? { subjectId } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      generation,
      frozenAt,
    });
    return { ok: true, identity };
  } catch {
    return { ok: false, code: "INVALID" };
  }
}

/** 结构体检:返回问题描述;undefined = 结构可用。 */
function identityProblem(v: unknown): string | undefined {
  const rec = asRecord(v);
  if (!rec) return "identity-not-object";
  if (typeof rec.key !== "string" || !/^[0-9a-f]{24}$/.test(rec.key)) return "key-invalid";
  if (nonEmpty(rec.tenantId) === undefined) return "tenantId-missing";
  if (!isKind(rec.sourceKind)) return "sourceKind-unknown";
  if (rec.subjectId !== undefined && typeof rec.subjectId !== "string") return "subjectId-invalid";
  if (rec.threadId !== undefined && typeof rec.threadId !== "string") return "threadId-invalid";
  if (typeof rec.generation !== "number" || !Number.isFinite(rec.generation)) return "generation-invalid";
  if (typeof rec.frozenAt !== "number" || !Number.isFinite(rec.frozenAt)) return "frozenAt-invalid";
  if (SUBJECT_REQUIRED.includes(rec.sourceKind) && nonEmpty(rec.subjectId) === undefined) {
    return "subjectId-missing";
  }
  return undefined;
}

/**
 * 校验冻结身份:只校验、绝不重算 key(重算=把「现在怎么推的」又塞回判定,
 * 正是本模块要消除的漂移来源)。
 */
export function verifyRouteIdentity(
  identity: unknown,
  opts: VerifyIdentityOptions = {},
): VerifyIdentityResult {
  try {
    const bad = identityProblem(identity);
    if (bad !== undefined) return { ok: false, code: "INVALID", reasons: [bad] };
    const id = identity as RouteIdentity;

    if (opts.currentGeneration !== undefined) {
      if (!Number.isFinite(opts.currentGeneration) || opts.currentGeneration !== id.generation) {
        return {
          ok: false,
          code: "STALE_GENERATION",
          reasons: [`generation:${String(opts.currentGeneration)}!=${id.generation}`],
        };
      }
    }

    const reasons: string[] = [];
    const ev = asRecord(opts.event);
    if (ev !== undefined) {
 // 只认六类来源值;旧通道名(panel/im 等)不是来源类别,忽略而非误判不一致。
      const evKind = pick([ev], ["sourceKind", "kind"]);
      if (evKind !== undefined && isKind(evKind) && evKind !== id.sourceKind) {
        reasons.push(`sourceKind:${evKind}!=${id.sourceKind}`);
      }
      const evSubject = pick([ev], ["subjectId", "senderId", "from"]);
      if (evSubject !== undefined && evSubject !== id.subjectId) {
        reasons.push(`subjectId:${evSubject}!=${id.subjectId ?? ""}`);
      }
      const evThread = pick([ev], ["threadId", "threadKey"]);
      if (evThread !== undefined && evThread !== (id.threadId ?? "")) {
        reasons.push(`threadId:${evThread}!=${id.threadId ?? ""}`);
      }
      const evTenant = pick([ev], ["tenantId"]);
      if (evTenant !== undefined && evTenant !== id.tenantId) {
        reasons.push(`tenantId:${evTenant}!=${id.tenantId}`);
      }
    }

    if (reasons.length > 0) return { ok: false, code: "IDENTITY_MISMATCH", reasons };
    return { ok: true, code: "OK", reasons: [] };
  } catch {
    return { ok: false, code: "INVALID", reasons: ["verify-threw"] };
  }
}

/**
 * 路由准入:身份不可用 → 直接拒(strength=none,reason=route-identity:<code>);
 * 可用 → gate 判定结果原样返回(不包装、不降级)。
 * gate 自身抛错按 INVALID 拒:判不出结论时不允许放行。
 */
export function routeAdmission<T extends RouteGateResult>(
  identity: unknown,
  gate: (identity: RouteIdentity) => T,
  checks: VerifyIdentityOptions = {},
): T | (RouteGateResult & { admissible: false; strength: "none"; reason: string }) {
  const verdict = verifyRouteIdentity(identity, checks);
  if (!verdict.ok) {
    return { admissible: false, strength: "none", reason: `route-identity:${verdict.code}` };
  }
  try {
    return gate(identity as RouteIdentity);
  } catch {
    return { admissible: false, strength: "none", reason: "route-identity:INVALID" };
  }
}

/** 身份语义相等:比较 key/tenant/source/subject/thread/generation;frozenAt 是采集时刻,不参与。 */
export function identityEquals(a: unknown, b: unknown): boolean {
  try {
    const pa = identityProblem(a);
    const pb = identityProblem(b);
    if (pa !== undefined || pb !== undefined) return pa === pb && pa !== undefined && a === b;
    const ia = a as RouteIdentity;
    const ib = b as RouteIdentity;
    return ia.key === ib.key
      && ia.tenantId === ib.tenantId
      && ia.sourceKind === ib.sourceKind
      && (ia.subjectId ?? "") === (ib.subjectId ?? "")
      && (ia.threadId ?? "") === (ib.threadId ?? "")
      && ia.generation === ib.generation;
  } catch {
    return false;
  }
}

/** 一行摘要(≤200 字),给日志/审计用;非法身份返回稳定字样。 */
export function describeRouteIdentity(identity: unknown): string {
  try {
    if (identityProblem(identity) !== undefined) return "route-identity:INVALID";
    const id = identity as RouteIdentity;
    const text = `${id.sourceKind} tenant=${id.tenantId} subject=${id.subjectId ?? "-"} `
      + `thread=${id.threadId ?? "-"} gen=${id.generation} key=${id.key}`;
    return text.length <= 200 ? text : `${text.slice(0, 197)}...`;
  } catch {
    return "route-identity:INVALID";
  }
}
