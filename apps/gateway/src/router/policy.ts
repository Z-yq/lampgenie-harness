/**
 * policy gate + 版本哈希( P1,参照 dsh-superagent-prototype/src/policy.ts):
 * - gate():observe 模式下 explicit(面板/白名单)或命中运行中 Ticket 订阅 → 派发;inferred 候选恒 ignore,
 *   audit 记 would_accept:true(不派发);显式授权用户请求走既有 TaskSupervisor 路径行为不变。
 * - policyVersion():对 rules/mode/sources 三要素哈希——改任一项 → 版本变化。
 * P1 零 LLM:auto 模式仅预留接口位,P1 代码路径不调用任何模型。
 * 配置落盘 .genie/router/policy.json(结构:allowlist[]/mode/rules[]/sources[];含版本哈希)。
 */
import { createHash } from "node:crypto";
import { join as joinPath } from "node:path";
import { decideSubscription, type ThreadSubscription } from "@lampgenie/runtime/agent/thread-subscription";
import {
  evaluateAdmission,
  type AdmissionEvaluation,
  type AdmissionMode,
} from "@lampgenie/runtime/agent/admission-matrix";
import {
  canAdmitWithMandate,
  type MandateCode,
  type MandateLike,
} from "@lampgenie/runtime/agent/mandate-lifecycle";
import {
  routeAdmission as admitRouteIdentity,
  type RouteIdentity,
} from "@lampgenie/runtime/router/route-identity";

export type AcceptMode = "observe" | "auto";

export interface PolicyRule {
  id: string;
  enabled: boolean;
  /** P2 起 LLM 研判用规则说明;P1 仅参与版本哈希。 */
  instruction: string;
}

export interface PolicySource {
  /** 来源名(panel/im)。 */
  name: string;
  /** 是否监听该来源(scope 门;false=filtered)。 */
  listened: boolean;
}

export interface PolicyConfig {
  /** 显式授权白名单(来源内 identity,如面板用户/飞书 open_id)。 */
  allowlist: string[];
  mode: AcceptMode;
  rules: PolicyRule[];
  sources: PolicySource[];
 /** P3:auto 研判 deadline ms(缺省 120_000)。运维参数,不参与 policyVersion 哈希(非授权要素)。 */
  evalDeadlineMs?: number;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  allowlist: [],
  mode: "observe",
  rules: [{ id: "default", enabled: true, instruction: "P1 deterministic gate: explicit or subscribed triggers dispatch; inferred candidates observe only." }],
  sources: [{ name: "panel", listened: true }, { name: "im", listened: true }],
};

/** 判定强度(ref policy.ts Strength 语义收窄:inferred 在 observe 恒不派发)。 */
export type Strength = "explicit" | "inferred";

/**
 * 正式订阅表的结构别名(runtime 的 ThreadSubscription 原样复用):
 * gate 只读 mode/wakePolicy/until/superseded/generation,不关心订阅由谁持久化。
 */
export type ThreadSubscriptionLike = ThreadSubscription;

/** 订阅侧决策结论(由调用方落审计;本任务不落盘)。 */
export interface SubscriptionDecisionInfo {
  decision: "routed" | "context-only" | "denied";
 /** 命中的订阅 id:routed=可直投的 route 订阅;context-only=上下文订阅;denied=空。 */
  subscriptionIds: string[];
}

export interface GateOptions {
 /**
 * 正式订阅表。传了它就以新表为准(旧 liveSubscriptions 不再参与判定);
 * 不传=完全沿用旧 liveSubscriptions 行为,逐字不变。
 */
  subscriptions?: readonly ThreadSubscriptionLike[];
 /** 矩阵判定入口:传了才走 admission-matrix;不传=旧 allowed 链逐字不变。 */
  matrix?: {
    mode: AdmissionMode;
 /** 显式授权凭证(面板/幂等键);缺省 false,由 gate 按 trigger 补齐面板与幂等键两条来源。 */
    explicitGrant?: boolean;
  };
 /**
 * Mandate 生命周期凭证。不传=旧行为逐字不变;
 * 传了且复验不通过(吊销/过期/策略变更)→ 直接拒,reason=mandate:<code>。
 */
  mandate?: MandateLike;
 /**
 * 入站时冻结的路由身份。不传=旧行为逐字不变(主体身份仍从 trigger.identity 取);
 * 传了=先校验冻结身份,不可用直接拒(reason=route-identity:<code>),可用则只读快照里的主体,
 * 不再从 trigger.identity 重算——身份每跳重算,一次载荷漂移就能把同一事件判成另一个人。
 */
  routeIdentity?: RouteIdentity;
 /** :当前身份代际;与冻结值不等 → STALE_GENERATION(旧事件不得借用新代际身份)。 */
  currentGeneration?: number;
 /**
 * 判定时刻(epoch ms):订阅的 until/silent 判定都依赖它。
 * 纯函数不读系统时间,调用方应传真实时刻;缺省 0(=除显式 expired 外都视为未过期)。
 */
  now?: number;
}

/** gate 判定结果。 */
export interface GateResult {
  /** 是否派发(explicit 或订阅命中)。 */
  admissible: boolean;
  strength?: Strength;
  /** 不派发原因:not_listened / not_allowed / observed。 */
  reason?: string;
  /** observe 模式 inferred 候选的 would_accept 审计标记(ref assessmentOutcome 语义)。 */
  would_accept?: boolean;
 /** 该 thread 只有 context 订阅:只作上下文提示与审计,绝不改变投递资格。 */
  contextOnly?: boolean;
 /** 订阅侧决策(routed / context-only / denied + 命中订阅 id)。 */
  subscriptionDecision?: SubscriptionDecisionInfo;
 /** 矩阵判定全量痕迹(仅传了 opts.matrix 时存在;含逐规则 matched/decision 与口径版本)。 */
  matrixDecision?: AdmissionEvaluation;
}

export function loadPolicyConfig(root: string, io: {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: "utf8") => string;
} ): PolicyConfig {
  const path = joinPath(root, ".genie", "router", "policy.json");
  if (!io.existsSync(path)) return DEFAULT_POLICY_CONFIG;
  try {
    const raw = JSON.parse(io.readFileSync(path, "utf8")) as Partial<PolicyConfig>;
    return {
      allowlist: Array.isArray(raw.allowlist) ? raw.allowlist.filter((x): x is string => typeof x === "string") : [],
      mode: raw.mode === "auto" ? "auto" : "observe",
      rules: Array.isArray(raw.rules) && raw.rules.length ? raw.rules.filter((r) => r && typeof r.id === "string") : DEFAULT_POLICY_CONFIG.rules,
      sources: Array.isArray(raw.sources) && raw.sources.length
        ? raw.sources.filter((s) => s && typeof s.name === "string").map((s) => ({ name: s.name, listened: s.listened !== false }))
        : DEFAULT_POLICY_CONFIG.sources,
    };
  } catch {
    return DEFAULT_POLICY_CONFIG;
  }
}

/** 版本哈希:改 rules/mode/sources 任一项 → 输出变化(不承诺跨版本稳定值)。 */
export function policyVersion(config: PolicyConfig): string {
  return createHash("sha256")
    .update(JSON.stringify({ rules: config.rules, mode: config.mode, sources: config.sources }))
    .digest("hex")
    .slice(0, 16);
}

/**
 * P3 Mandate 授权凭证:accept 派发时产出的不可变凭证,挂 Ticket + 随行落 audit。
 * 只含授权溯源要素,不含任何密钥/令牌字段(audit assertNoCredential 全量守门)。
 */
export interface Mandate {
  /** 产出时的 policy 版本哈希(revalidate 与当前 config 版本相等即有效)。 */
  policyVersion: string;
  /** 授权范围(触发来源:panel/im)。 */
  scope: string;
  /** 判定强度(explicit/inferred)。 */
  strength: Strength;
  /** 命中的启用规则 id 集(空=非规则判定,如订阅直通)。 */
  ruleIds: string[];
  /** 触发者(identity;缺省回退来源名)。 */
  sender: string;
  /** 产出时刻(epoch ms)。 */
  at: number;
}

/** P3 复验:mandate.policyVersion 与当前 config 版本相等 → 有效(true);rules/mode/sources 任一变更 → 失效(false)。 */
export function revalidate(mandate: Mandate, currentPolicyConfig: PolicyConfig): boolean {
  return mandate.policyVersion === policyVersion(currentPolicyConfig);
}

/**
 * gate 侧 mandate 准入判定(委托 runtime 纯逻辑,本层零 IO 零新口径)。
 * 复验必须拿「当前」策略版本:签发版只说明签发时是哪一版,不能证明现在还是那一版。
 * 旧 revalidate(Mandate, PolicyConfig) 签名保留不动,新能力走这里,旧调用点不受影响。
 */
export function mandateAdmission(
  m: MandateLike | null | undefined,
  currentPolicyVersion: string,
  now: number): { ok: boolean; code: MandateCode } {
  return canAdmitWithMandate(m, currentPolicyVersion, now);
}

/**
 * gate 判定:
 * - source 未监听 → 不派发(not_listened);
 * - 传了正式订阅表:route 订阅(未过期、非 silent)→ 直通;只有 context 订阅 → 仍走普通授权链,
 * 结果标 contextOnly=true(只作上下文提示/审计,不放行);
 * - 未传订阅表:命中活 Ticket 订阅(threadKey)→ 直通(旧语义逐字保留);
 * - 显式授权(面板 trigger 或 im 白名单命中)→ admissible(explicit);
 * - 其余 im 推断候选 → observe 恒不派发(reason=observed,would_accept=true 只记审计)。
 * 旧 liveSubscriptions 参数保留:传了 opts.subscriptions 时以新表为准(它不再参与判定)。
 * P2 auto 模式回灌 gate 的 LLM 研判接口位(P1 不实现,P1 代码路径零 LLM 调用)。
 */
export function gate(
  trigger: { source: string; threadKey: string; idempotencyKey?: string; identity?: string; addressed?: boolean },
  config: PolicyConfig,
  /** 活 Ticket 订阅表:threadKey → 是否有运行中(open)Ticket。 */
  liveSubscriptions: ReadonlyMap<string, boolean>,
  opts?: GateOptions): GateResult {
  const subs = opts?.subscriptions;
  const now = typeof opts?.now === "number" && Number.isFinite(opts.now) ? opts.now : 0;
 // 订阅侧结论先算:它是审计事实——即使来源未监听,也要如实记下「这里有 context/route 订阅」。
  const subInfo: Pick<GateResult, "subscriptionDecision" | "contextOnly"> = subs === undefined
    ? {}
    : (() => {
      const d = decideSubscription(subs, trigger.threadKey ?? "", now);
      return {
        subscriptionDecision: { decision: d.decision, subscriptionIds: d.subscriptionIds },
 // context 订阅只提示上下文:不授予投递资格,判定仍走后面的普通授权链。
        ...(d.decision === "context-only" ? { contextOnly: true } : {}),
      };
    })();
 // 冻结路由身份是整条判定链的第一道门——先校验,不可用立刻 fail-closed。
 // 位置刻意在任何放宽门(订阅直通/矩阵/白名单)之前:身份都不成立,后面任何一条都不许把它捞回来。
 // 不传 opts.routeIdentity 时整段不进入,旧调用点行为逐字不变。
  let frozenIdentity: RouteIdentity | undefined;
  if (opts?.routeIdentity !== undefined) {
    const checked = admitRouteIdentity(opts.routeIdentity, (id) => {
      frozenIdentity = id;
      return { admissible: true };
    }, { currentGeneration: opts.currentGeneration });
    if (checked.admissible !== true) {
 // 身份不可用:strength 不写(= none 口径,与 mandate 分支同款);reason 带稳定码 route-identity:<code>。
      return { admissible: false, reason: checked.reason ?? "route-identity:INVALID", ...subInfo };
    }
  }
 // 冻结身份可用时,主体判定只读快照(subjectId 优先,缺主体回落 tenantId),不再从 trigger.identity 重算。
  const actorIdentity = frozenIdentity !== undefined
    ? (frozenIdentity.subjectId ?? frozenIdentity.tenantId)
    : (trigger.identity ?? "");
  const src = config.sources.find((s) => s.name === trigger.source);
 // 监听门先过:route 订阅也不能绕过 source 白名单。
  if (!src || !src.listened) return { admissible: false, reason: "not_listened", ...subInfo };
 // 吊销/过期/策略失效的 mandate 一律 fail-closed。位置刻意放在订阅直通之前——
 // 否则「已吊销」只对普通授权链生效,一张 route 订阅仍能把被停掉的任务投出去,吊销就成了纯审计记录。
 // 不传 opts.mandate 时不进入本段,旧调用点行为逐字不变。
  if (opts?.mandate !== undefined) {
    const verdict = mandateAdmission(opts.mandate, policyVersion(config), now);
    if (!verdict.ok) {
 // strength 缺省即 none(与矩阵分支同口径:拒绝时不编造强度)。
      return { admissible: false, reason: `mandate:${verdict.code}`, ...subInfo };
    }
  }
 // 正式订阅表的 route 一侧(未过期、非 silent)才直通;context 永远进不了 routeSubscriptions。
  if (subInfo.subscriptionDecision?.decision === "routed") {
    return { admissible: true, strength: "explicit", ...subInfo };
  }
  // 订阅直通开阀=threadKey 自动关联:活 Ticket 的 threadKey 后续 Trigger 直投 owner worker(steer 通道)。
 // 仅未传正式订阅表时生效,保证旧调用点(dispatch.ts)行为逐字不变。
  if (subs === undefined && trigger.threadKey && liveSubscriptions.get(trigger.threadKey) === true) {
    return { admissible: true, strength: "explicit", ...subInfo };
  }
 // 矩阵判定:只在传了 opts.matrix 时启用,位置在 source 监听门与订阅直通之后
 // (正式订阅不可被矩阵降级)。映射口径:
 // - listed = 命中 allowlist 身份(白名单);显式来源(panel)与幂等键归入 explicitGrant;
 // 注意 matrix 模式下 allowlist 身份不再无条件 explicit——白名单内未点名时按 mode 判,
 // 要保留旧「白名单=直接放行」语义的调用方传 matrix.explicitGrant=true。
 // - 不传 matrix 的调用点走下方旧 allowed 链,行为逐字不变。
  if (opts?.matrix !== undefined) {
    const evaluation = evaluateAdmission({
      listed: config.allowlist.includes(actorIdentity),
      addressed: trigger.addressed === true,
      mode: opts.matrix.mode,
      explicitGrant:
        opts.matrix.explicitGrant === true
        || trigger.source === "panel"
        || trigger.idempotencyKey !== undefined,
      source: trigger.source,
    });
    const d = evaluation.decision;
    return {
      admissible: d.admit,
      ...(d.strength === "none" ? {} : { strength: d.strength }),
      ...(d.admit ? {} : { reason: d.reason }),
      ...(d.wouldAccept === true ? { would_accept: true } : {}),
      matrixDecision: evaluation,
      ...subInfo,
    };
  }
  const allowed = trigger.source === "panel"
    || trigger.addressed === true // 人显式点名(dm/mention 命中 task 路由)= explicit
    || trigger.idempotencyKey !== undefined // 面板显式授权请求(带幂等键=用户主动提交)
    || config.allowlist.includes(actorIdentity);
  if (allowed) return { admissible: true, strength: "explicit", ...subInfo };
  // inferred 候选:observe 模式恒不派发,只记 would_accept;auto(P2)才可能派发。
  return { admissible: false, reason: "observed", would_accept: true, ...subInfo };
}
