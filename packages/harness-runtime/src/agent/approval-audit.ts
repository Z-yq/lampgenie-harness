/**
 * 审批审计对:`permission.gate` 事件流的离线对账 + 「never」永久拒绝规则短路。
 * 为什么需要单独一层:
 * - 审批是「问了必须有人答」的契约;journal 里 asked 与 decided 只是两条独立事件,
 * decided 一丢(询问后子进程崩溃 / 网关重启 / 分支早退)人工看事件流极难发现,
 * 审计函数把「这次询问到底有没有结算」变成可判定的稳定码。
 * - 配对键只能是 requestId:同一次审批在 journal 里没有别的稳定身份;缺 requestId 的历史
 * 事件无法回溯配对,只能显式判 MISSING_BINDING(不猜)。
 * - 「never」是确定性永久拒绝:命中即结算,不留给面板(也就不会在审批中心等人),
 * 否则无人值守时规则形同虚设。
 * 纯逻辑:零 IO(不读文件 / 网络 / 环境 / 真实时钟),不 throw,输出不可变(深 freeze)。
 * 事件形态只要求 `{ seq?, kind, payload?, time?, sessionId? }`——journal 行可直接传入,
 * 非 `permission.gate` 行静默跳过(调用方可以整段 readAll 丢进来)。
 */

/** 稳定码:审计结论与 issue 的唯一判定口径(下游按码分支,不按文案)。 */
export const APPROVAL_AUDIT_CODES = Object.freeze({
 /** 全部成对且无结构问题。 */
  OK: "OK",
 /** asked 之后没有任何 decided(任务仍在跑时可由调用方豁免)。 */
  DANGLING_ASKED: "DANGLING_ASKED",
 /** decided 找不到对应 asked。 */
  ORPHAN_DECIDED: "ORPHAN_DECIDED",
 /** 同 requestId 出现多条 decided(后到的被忽略,只保留首条)。 */
  DUPLICATE_DECIDED: "DUPLICATE_DECIDED",
 /** asked/decided 缺 requestId(或为空串),无法配对。 */
  MISSING_BINDING: "MISSING_BINDING",
 /** 事件结构非法:payload 非对象、effect 缺失/未知、同 requestId 重复 asked。 */
  INVALID: "INVALID",
} as const);

export type ApprovalAuditCode = (typeof APPROVAL_AUDIT_CODES)[keyof typeof APPROVAL_AUDIT_CODES];

/** 已结算的三种 result 侧 effect(object-changed 是中间标记,不是结算)。 */
export type ApprovalDecisionEffect = "allowed" | "denied" | "rejected";

const DECIDED_EFFECTS: readonly string[] = ["allowed", "denied", "rejected"] as const;
const ASKED_EFFECT = "asked";
/** 放行前复核失败的中间标记;紧随其后的 denied 才是这次询问的结算。 */
const OBJECT_CHANGED_EFFECT = "object-changed";

/** 事件行(journal 行是超集,这里只声明审计真正读到的字段)。 */
export interface ApprovalAuditEvent {
  readonly seq?: number;
  readonly kind?: string;
  readonly time?: number;
  readonly sessionId?: string;
  readonly payload?: unknown;
}

export interface ApprovalAuditOptions {
 /** 允许尚在挂起的 requestId(任务仍在跑时由调用方传入),这些 asked 不算悬空。 */
  readonly allowPendingRequestIds?: readonly string[];
}

/** 一条成对的审计记录:asked ↔ 唯一的 decided。 */
export interface ApprovalPair {
  readonly requestId: string;
  readonly askedSeq: number;
  readonly decidedSeq: number;
  readonly decision: ApprovalDecisionEffect;
  readonly by: string;
  readonly objectHash?: string;
  readonly turn?: number;
  readonly toolCallId?: string;
 /** 缺失的辅助绑定(只记录,不单独判失败):'turn' / 'toolCallId'。 */
  readonly missingBindings?: readonly string[];
}

export interface ApprovalAuditIssue {
  readonly code: ApprovalAuditCode;
  readonly requestId?: string;
  readonly seq?: number;
  readonly detail: string;
}

export interface ApprovalAuditCounts {
 /** 扫到的 permission.gate 事件数(非 gate 事件不计)。 */
  readonly events: number;
 /** effect=asked 的条数(含缺 requestId 的)。 */
  readonly asked: number;
 /** effect ∈ allowed/denied/rejected 的条数(含缺 requestId / 重复的)。 */
  readonly decided: number;
 /** 既非 asked 也非 decided 的 gate 事件(object-changed 等)。 */
  readonly ignored: number;
  readonly pairs: number;
  readonly issues: number;
}

export interface ApprovalAuditResult {
  readonly ok: boolean;
 /** 已成对记录,按 asked 出现顺序。 */
  readonly pairs: readonly ApprovalPair[];
  readonly issues: readonly ApprovalAuditIssue[];
  readonly counts: ApprovalAuditCounts;
}

interface AskRecord {
  readonly seq: number;
  readonly by: string;
  readonly objectHash?: string;
  readonly turn?: number;
  readonly toolCallId?: string;
}

interface DecisionRecord extends AskRecord {
  readonly effect: ApprovalDecisionEffect;
}

function strField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function numField(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asPayload(raw: unknown): Record<string, unknown> | undefined {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function issue(code: ApprovalAuditCode, detail: string, requestId?: string, seq?: number): ApprovalAuditIssue {
  return Object.freeze({
    code,
    detail,
    ...(requestId === undefined ? {} : { requestId }),
    ...(seq === undefined ? {} : { seq }),
  });
}

function countsOf(over: Partial<ApprovalAuditCounts>): ApprovalAuditCounts {
  return Object.freeze({ events: 0, asked: 0, decided: 0, ignored: 0, pairs: 0, issues: 0, ...over });
}

function invalidResult(detail: string): ApprovalAuditResult {
  const issues = Object.freeze([issue(APPROVAL_AUDIT_CODES.INVALID, detail)]);
  return Object.freeze({
    ok: false,
    pairs: Object.freeze([]) as readonly ApprovalPair[],
    issues,
    counts: countsOf({ issues: issues.length }),
  });
}

/**
 * 审计一批事件:每个 asked 恰好一条 decided 且 requestId 对齐才算 ok。
 * 事件列表非数组 → INVALID 结果;单条坏事件 → INVALID issue(不影响其余事件对账)。
 */
export function auditApprovals(
  events: readonly ApprovalAuditEvent[] | unknown,
  opts: ApprovalAuditOptions = {},
): ApprovalAuditResult {
  try {
    if (!Array.isArray(events)) return invalidResult("events 不是数组");

    const allowPending = new Set<string>();
    const rawAllow = opts && typeof opts === "object" ? opts.allowPendingRequestIds : undefined;
    if (Array.isArray(rawAllow)) {
      for (const id of rawAllow) {
        const key = strField(id);
        if (key) allowPending.add(key);
      }
    }

    const issues: ApprovalAuditIssue[] = [];
    const asks = new Map<string, AskRecord>();
    const decisions = new Map<string, DecisionRecord>();
    const askedOrder: string[] = [];
    let gateCount = 0;
    let askedCount = 0;
    let decidedCount = 0;

    for (let idx = 0; idx < events.length; idx++) {
      const ev = events[idx] as ApprovalAuditEvent | null | undefined;
      if (!ev || typeof ev !== "object") continue;
      if (ev.kind !== "permission.gate") continue;
      gateCount++;
 // 缺 seq 时退化为下标(合成事件流/夹具常有;真实 journal 行一定有 seq)。
      const seq = numField(ev.seq) ?? idx;
      const payload = asPayload(ev.payload);
      if (!payload) {
        issues.push(issue(APPROVAL_AUDIT_CODES.INVALID, "payload 非对象", undefined, seq));
        continue;
      }
      const effect = strField(payload.effect);
      if (!effect) {
        issues.push(issue(APPROVAL_AUDIT_CODES.INVALID, "effect 缺失", undefined, seq));
        continue;
      }

      if (effect === ASKED_EFFECT) {
        askedCount++;
        const requestId = strField(payload.requestId);
        if (!requestId) {
          issues.push(issue(APPROVAL_AUDIT_CODES.MISSING_BINDING, "asked 缺 requestId", undefined, seq));
          continue;
        }
        if (asks.has(requestId)) {
          issues.push(issue(APPROVAL_AUDIT_CODES.INVALID, `同 requestId 重复 asked(seq=${seq})`, requestId, seq));
          continue;
        }
        asks.set(
          requestId,
          Object.freeze({
            seq,
            by: strField(payload.by) ?? "",
            objectHash: strField(payload.objectHash),
            turn: numField(payload.turn),
            toolCallId: strField(payload.toolCallId),
          }),
        );
        askedOrder.push(requestId);
        continue;
      }

      if (DECIDED_EFFECTS.includes(effect)) {
        decidedCount++;
        const requestId = strField(payload.requestId);
        if (!requestId) {
          issues.push(issue(APPROVAL_AUDIT_CODES.MISSING_BINDING, `decided(${effect})缺 requestId`, undefined, seq));
          continue;
        }
        if (!asks.has(requestId)) {
          issues.push(issue(APPROVAL_AUDIT_CODES.ORPHAN_DECIDED, `decided(${effect})无 asked`, requestId, seq));
          continue;
        }
        if (decisions.has(requestId)) {
          const first = decisions.get(requestId);
          issues.push(
            issue(
              APPROVAL_AUDIT_CODES.DUPLICATE_DECIDED,
              `重复 decided(${effect}),首条 seq=${first ? first.seq : "?"}`,
              requestId,
              seq),
          );
          continue;
        }
        decisions.set(
          requestId,
          Object.freeze({
            seq,
            effect: effect as ApprovalDecisionEffect,
            by: strField(payload.by) ?? "",
            objectHash: strField(payload.objectHash),
            turn: numField(payload.turn),
            toolCallId: strField(payload.toolCallId),
          }),
        );
        continue;
      }

 // object-changed 是中间标记(不计 decided,也不算非法);其余 todo effect 一律非法。
      if (effect !== OBJECT_CHANGED_EFFECT) {
        issues.push(issue(APPROVAL_AUDIT_CODES.INVALID, `未知 effect:${effect}`, undefined, seq));
      }
    }

    const pairs: ApprovalPair[] = [];
    for (const requestId of askedOrder) {
      const ask = asks.get(requestId);
      if (!ask) continue;
      const dec = decisions.get(requestId);
      if (!dec) {
        if (allowPending.has(requestId)) continue;
        issues.push(issue(APPROVAL_AUDIT_CODES.DANGLING_ASKED, "asked 无 decided", requestId, ask.seq));
        continue;
      }
 // 辅助绑定取两侧先到者(asked/decided 任一可得即透传);都缺只记 missingBindings。
      const turn = dec.turn ?? ask.turn;
      const toolCallId = dec.toolCallId ?? ask.toolCallId;
      const objectHash = dec.objectHash ?? ask.objectHash;
      const missing: string[] = [];
      if (turn === undefined) missing.push("turn");
      if (toolCallId === undefined) missing.push("toolCallId");
      pairs.push(
        Object.freeze({
          requestId,
          askedSeq: ask.seq,
          decidedSeq: dec.seq,
          decision: dec.effect,
          by: dec.by || ask.by,
          ...(objectHash === undefined ? {} : { objectHash }),
          ...(turn === undefined ? {} : { turn }),
          ...(toolCallId === undefined ? {} : { toolCallId }),
          ...(missing.length === 0 ? {} : { missingBindings: Object.freeze(missing) }),
        }),
      );
    }

    return Object.freeze({
      ok: issues.length === 0,
      pairs: Object.freeze(pairs),
      issues: Object.freeze(issues),
      counts: countsOf({
        events: gateCount,
        asked: askedCount,
        decided: decidedCount,
        ignored: gateCount - askedCount - decidedCount,
        pairs: pairs.length,
        issues: issues.length,
      }),
    });
  } catch {
    return invalidResult("审计过程异常(已降级为 INVALID)");
  }
}

/** 规则短路动作名:永远不会被面板放行的永久拒绝。 */
export const NEVER_ACTION = "never";
/** never 规则的 by 标记(事件与审计按它识别「规则拒绝」)。 */
export const RULE_NEVER_BY = "rule-never";

/** 规则窄口:只取匹配需要的三字段(action 放宽为 string,以便承载 "never")。 */
export interface ApprovalRuleLike {
  readonly permission?: string | null;
  readonly pattern?: string | null;
  readonly action?: string | null;
}

export interface NeverDecision {
  readonly decision: "reject";
  readonly by: typeof RULE_NEVER_BY;
}

/**
 * 「never」规则短路:命中即 reject/rule-never,未命中返回 null。
 * 匹配语义与 core 的 matchPermissionRule 对齐(permission 相等或 "*";pattern 取首个 "*" 之前的前缀),
 * 保证同一份规则在「规则咨询」与「never 短路」两条路径上判定一致,不会一条命中另一条不命中。
 * 非法输入(非数组/坏行)不抛,视作未命中。
 */
export function decideNever(
  tool: string,
  summary: string,
  rules: readonly ApprovalRuleLike[] | null | undefined): NeverDecision | null {
  try {
    if (!Array.isArray(rules)) return null;
    const toolName = typeof tool === "string" ? tool.trim() : "";
    const text = typeof summary === "string" ? summary : "";
    for (const rule of rules) {
      if (!rule || typeof rule !== "object") continue;
      const action = typeof rule.action === "string" ? rule.action.trim().toLowerCase() : "";
      if (action !== NEVER_ACTION) continue;
      const permission = typeof rule.permission === "string" ? rule.permission : "*";
      if (permission !== toolName && permission !== "*") continue;
      const pattern = typeof rule.pattern === "string" ? rule.pattern : "*";
      const literal = pattern.includes("*") ? pattern.slice(0, pattern.indexOf("*")) : pattern;
      if (literal === "" || text.startsWith(literal)) {
        return Object.freeze({ decision: "reject" as const, by: RULE_NEVER_BY });
      }
    }
    return null;
  } catch {
    return null;
  }
}
