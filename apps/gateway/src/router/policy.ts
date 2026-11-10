/**
 * policy gate + 版本哈希(step-0143 P1,参照 dsh-superagent-prototype/src/policy.ts):
 * - gate():observe 模式下 explicit(面板/白名单)或命中运行中 Ticket 订阅 → 派发;inferred 候选恒 ignore,
 *   audit 记 would_accept:true(不派发);显式授权用户请求走既有 TaskSupervisor 路径行为不变。
 * - policyVersion():对 rules/mode/sources 三要素哈希——改任一项 → 版本变化。
 * P1 零 LLM:auto 模式仅预留接口位,P1 代码路径不调用任何模型。
 * 配置落盘 .genie/router/policy.json(结构:allowlist[]/mode/rules[]/sources[];含版本哈希)。
 */
import { createHash } from "node:crypto";
import { join as joinPath } from "node:path";

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
  /** step-0145 P3:auto 研判 deadline ms(缺省 120_000)。运维参数,不参与 policyVersion 哈希(非授权要素)。 */
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

/** gate 判定结果。 */
export interface GateResult {
  /** 是否派发(explicit 或订阅命中)。 */
  admissible: boolean;
  strength?: Strength;
  /** 不派发原因:not_listened / not_allowed / observed。 */
  reason?: string;
  /** observe 模式 inferred 候选的 would_accept 审计标记(ref assessmentOutcome 语义)。 */
  would_accept?: boolean;
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
 * step-0145 P3 Mandate 授权凭证:accept 派发时产出的不可变凭证,挂 Ticket + 随行落 audit。
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
 * gate 判定:
 * - source 未监听 → 不派发(not_listened);
 * - 显式授权(面板 trigger 或 im 白名单命中)→ admissible(explicit);
 * - 命中运行中 Ticket 订阅(threadKey)→ admissible(explicit 订阅直通);
 * - 其余 im 推断候选 → observe 恒不派发(reason=observed,would_accept=true 只记审计);
 * P2 auto 模式回灌 gate 的 LLM 研判接口位(P1 不实现,P1 代码路径零 LLM 调用)。
 */
export function gate(
  trigger: { source: string; threadKey: string; idempotencyKey?: string; identity?: string; addressed?: boolean },
  config: PolicyConfig,
  /** 活 Ticket 订阅表:threadKey → 是否有运行中(open)Ticket。 */
  liveSubscriptions: ReadonlyMap<string, boolean>,
): GateResult {
  const src = config.sources.find((s) => s.name === trigger.source);
  if (!src || !src.listened) return { admissible: false, reason: "not_listened" };
  // 订阅直通开阀=threadKey 自动关联:活 Ticket 的 threadKey 后续 Trigger 直投 owner worker(steer 通道)。
  if (trigger.threadKey && liveSubscriptions.get(trigger.threadKey) === true) {
    return { admissible: true, strength: "explicit" };
  }
  const allowed = trigger.source === "panel"
    || trigger.addressed === true // 人显式点名(dm/mention 命中 task 路由)= explicit
    || trigger.idempotencyKey !== undefined // 面板显式授权请求(带幂等键=用户主动提交)
    || config.allowlist.includes(trigger.identity ?? "");
  if (allowed) return { admissible: true, strength: "explicit" };
  // inferred 候选:observe 模式恒不派发,只记 would_accept;auto(P2)才可能派发。
  return { admissible: false, reason: "observed", would_accept: true };
}
