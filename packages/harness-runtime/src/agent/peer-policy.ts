/**
 * #179 Peer 级访问快照(纯逻辑面)。
 *
 * 问题:一次会话里并发着 owner / member / viewer / relay / group 五种主体,每条 RPC 的
 * 准入都靠「临时查一遍策略」。临时查有两个缺口:①判定要在参数 schema 解析之前发生,
 * 否则非法参数会先被 schema 层拒掉,准入结论就永远看不到;②客户端重连后服务端没有
 * 「上次允许了什么」的快照,只能重新全量算,期间出现允许集空窗(或者更糟:按老策略放行)。
 *
 * 本模块只做三件事,全部是纯函数:
 *   ① 定死一次**单一主体 × 单一方法**的准入判定(decide),输出 10 个稳定码之一;
 *   ② 批量判定(listAllows / eventAllows)——一项坏不影响其它项(事件粒度需要知道「哪些项被拒」);
 *   ③ 快照的生成与演进(snapshotFor / applyFollow / invalidate / reloadSnapshot / mergeReconnect)。
 *
 * 三条硬边界:
 *   ① **owner 恒 allow**:owner 是自身的会话所有者,策略文件缺失、坏、写错都不该把它锁在门外;
 *   ② **失败一律 fail-closed**:condition / binding 抛错 → PEER_POLICY_FAILED(不是 allow,
 *      也不是 deny-policy——「算不出来」和「算出来不许」是两件事,快照里也必须区别对待:
 *      前者该授权从 baseline 中消失,后者明确写 false);
 *   ③ **不 throw、不改写入参**:任何输入(undefined / null / 畸形对象)都折叠成码;
 *      args 引用原样递给条件函数,不解析不改写、不深拷贝。
 *
 * 纪律:零 IO、零依赖(不 import node:*、不 import 其它 runtime 模块)、绝不 throw。
 * 本模块在参数 schema 解析**之前**被调用:只收 raw args,不解析、不改写、不校验其形状。
 */

/** 判定面版本(策略文件里的 `v` 与快照落盘的 `v` 与之一致)。 */
export const PEER_POLICY_VERSION = 1;

/** 10 个稳定码(声明顺序即审阅者阅读顺序:allow → 各种 deny → 快照生命周期)。 */
export const PEER_CODES = [
  "PEER_ALLOW",
  "PEER_DENY_NO_POLICY",
  "PEER_DENY_POLICY",
  "PEER_POLICY_FAILED",
  "PEER_SNAPSHOT",
  "PEER_FOLLOW_APPLIED",
  "PEER_INVALIDATED",
  "PEER_RELOADED",
  "PEER_EVENT_DENIED",
  "PEER_EVENT_ALLOWED",
] as const;

export type PeerCode = (typeof PEER_CODES)[number];

/** 五种主体形态。owner 特殊(恒放行),其余四种必须命中策略才放行。 */
export type PrincipalKind = "owner" | "member" | "viewer" | "relay" | "group";

export const PRINCIPAL_KINDS = ["owner", "member", "viewer", "relay", "group"] as const;

export interface Principal {
  id: string;
  kind: PrincipalKind;
}

/**
 * 判定上下文。`args` 是**原始入参**(schema 解析前),只做只读查看;
 * `role` 由调用方从会话上下文里取(未登录可为 undefined)。
 */
export interface PolicyContext {
  principal: Principal;
  method: string;
  args: unknown;
  role?: string;
}

/**
 * 一条策略(strategies 数组的一个元素)。
 * - `binding` 字符串 → 与 principal.id 精确相等才谈得上「适用」;函数 → 返回 truthy 才算适用
 *   (函数抛错视为判定失败,直接 fail-closed)。
 * - `condition` 是真正的准入条件;缺失即「适用即放行」。
 */
export interface PrincipalPolicy {
  kind: PrincipalKind;
  role?: string;
  binding?: string | ((ctx: PolicyContext) => boolean);
  condition?: (ctx: PolicyContext) => boolean;
}

/** 一份策略集合:`methods` 是快照要覆盖的方法全量,`policies` 是候选规则。 */
export interface PolicySet {
  policies: PrincipalPolicy[];
  methods: string[];
}

export interface PeerDecision {
  principalId: string;
  method: string;
  allow: boolean;
  code: PeerCode;
}

/** 快照里的一次后续动作(follow-up):某方法后来被允许/禁止的记录。 */
export interface PeerFollow {
  at: string;
  method: string;
  allow: boolean;
}

/**
 * 主体级快照。`baseline` 是生成时刻的允许集(缺 key = 该授权算不出来,不写 false);
 * `follow` 是之后 applyFollow 追加的动作流(不回写历史,只追加)。
 */
export interface PeerSnapshot {
  principalId: string;
  baseline: Record<string, boolean>;
  follow: PeerFollow[];
}

export interface PeerListEntry {
  index: number;
  item: unknown;
  method: string;
  allow: boolean;
  code: PeerCode;
}

export interface PeerListResult {
  principalId: string;
  entries: PeerListEntry[];
  allowed: number;
  denied: number;
  event: { allow: boolean; code: PeerCode };
}

/** JSON 可序列化形态的策略(spec 文件里的样子):condition 可以是名字或函数。 */
export interface PeerPolicySpec {
  kind: PrincipalKind;
  role?: string;
  binding?: string | ((ctx: PolicyContext) => boolean);
  condition?: string | ((ctx: PolicyContext) => boolean);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 条件工厂表:名字 → (arg) => condition。全部同步、纯逻辑。 */
export const PEER_CONDITIONS: Record<string, (arg: string) => (ctx: PolicyContext) => boolean> = {
  /** 恒真(fail-open 的显式写法,审阅时一眼可见)。 */
  always: () => () => true,
  /** 恒假:命中即 PEER_DENY_POLICY(策略明确拒绝,不是「没有策略」)。 */
  never: () => () => false,
  /** 执行即抛错:用来验证 fail-closed 路径(编译不到的坏条件等价于它)。 */
  throw: () => () => {
    throw new Error("PEER_CONDITION_THROW");
  },
  /** arg 为逗号分隔方法名列表;ctx.method 在列表内才放行。 */
  "method-in": (arg: string) => {
    const names = String(arg ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    return (ctx) => names.includes(str(ctx.method));
  },
  /** arg 形如 `key=value`;String(ctx.args[key]) 与 value 字符串相等才放行。 */
  "arg-eq": (arg: string) => {
    const raw = String(arg ?? "");
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(0, eq) : raw;
    const expected = eq >= 0 ? raw.slice(eq + 1) : "";
    return (ctx) => {
      if (!key) return false;
      if (!isPlainObject(ctx.args)) return false;
      const actual = (ctx.args as Record<string, unknown>)[key];
      if (actual === undefined || actual === null) return false;
      return String(actual) === expected;
    };
  },
  /** arg 为 key;ctx.args[key] 为 truthy 才放行。 */
  "args-truthy": (arg: string) => {
    const key = String(arg ?? "");
    return (ctx) => {
      if (!key) return false;
      if (!isPlainObject(ctx.args)) return false;
      return Boolean((ctx.args as Record<string, unknown>)[key]);
    };
  },
};

/**
 * 把 spec(JSON 形态)解析成可执行策略。
 * - condition 是函数 → 原样保留(单测/调用方直接给逻辑用);
 * - 是字符串 → 按 `base[:arg]` 拆,取 PEER_CONDITIONS[base](arg);
 * - base 不认识 → 编译成「执行即抛错」的 condition:**fail-closed**,
 *   而不是悄悄降级成 always(否则一个拼错的策略名就等于全放行)。
 */
export function resolvePeerPolicies(specs: PeerPolicySpec[]): PrincipalPolicy[] {
  const list = Array.isArray(specs) ? specs : [];
  const out: PrincipalPolicy[] = [];
  for (const spec of list) {
    if (!isPlainObject(spec)) continue;
    const kind = (spec as { kind?: unknown }).kind;
    if (typeof kind !== "string") continue;
    if (!(PRINCIPAL_KINDS as readonly string[]).includes(kind)) continue;
    const policy: PrincipalPolicy = { kind: kind as PrincipalKind };
    const role = (spec as { role?: unknown }).role;
    if (typeof role === "string" && role.trim()) policy.role = role;
    const binding = (spec as { binding?: unknown }).binding;
    if (typeof binding === "string" || typeof binding === "function") {
      policy.binding = binding as string | ((ctx: PolicyContext) => boolean);
    }
    const condition = (spec as { condition?: unknown }).condition;
    if (typeof condition === "function") {
      policy.condition = condition as (ctx: PolicyContext) => boolean;
    } else if (typeof condition === "string" && condition.length > 0) {
      const colon = condition.indexOf(":");
      const base = colon >= 0 ? condition.slice(0, colon) : condition;
      const arg = colon >= 0 ? condition.slice(colon + 1) : "";
      const factory = PEER_CONDITIONS[base];
      policy.condition = factory
        ? factory(arg)
        : () => {
            throw new Error(`PEER_CONDITION_UNKNOWN:${base}`);
          };
    }
    out.push(policy);
  }
  return out;
}

function denyNoPolicy(principalId: string, method: string): PeerDecision {
  return { principalId, method, allow: false, code: "PEER_DENY_NO_POLICY" };
}

function failed(principalId: string, method: string): PeerDecision {
  return { principalId, method, allow: false, code: "PEER_POLICY_FAILED" };
}

function allowed(principalId: string, method: string): PeerDecision {
  return { principalId, method, allow: true, code: "PEER_ALLOW" };
}

/**
 * 单主体 × 单方法的准入判定。
 *
 * **调用时机**:参数 schema 解析之前。本函数只收 raw args,不解析不改写;
 * 条件函数拿到的是同一个 args 引用(由它自己决定怎么看)。
 * 任何输入都不 throw:畸形 policySet / principal 都折叠成稳定码。
 *
 * 判定顺序:
 *   1) kind === "owner" → allow(无 policy 也放行);
 *   2) 候选 = kind 相同 且(策略未声明 role 或 role 与 ctx.role 相等);无候选 → DENY_NO_POLICY;
 *   3) 逐候选判「是否适用」:binding 字符串要求 principal.id 相等,不等就跳过;
 *      binding 函数抛错 → 立即 POLICY_FAILED;返回 falsy 也视为不适用;全部不适用 → DENY_NO_POLICY;
 *   4) 适用的候选按顺序判 condition:抛错 → POLICY_FAILED;falsy → DENY_POLICY;truthy → PEER_ALLOW
 *      (**首个可判定的候选即回**,不继续找「更宽松」的后继候选);
 *   5) 适用且无 condition → PEER_ALLOW。
 */
export function decide(
  policySet: PolicySet | undefined,
  input: { principal: Principal; method: string; args?: unknown; role?: string },
): PeerDecision {
  const principal = isPlainObject(input) ? (input as { principal?: Principal }).principal : undefined;
  const principalId = isPlainObject(principal) ? str((principal as Principal).id) : "";
  const method = isPlainObject(input) ? str((input as { method?: unknown }).method) : "";
  const kind = isPlainObject(principal) ? str((principal as Principal).kind) : "";
  const role = isPlainObject(input) ? (input as { role?: unknown }).role : undefined;
  const ctx: PolicyContext = {
    principal: { id: principalId, kind: kind as PrincipalKind },
    method,
    args: isPlainObject(input) ? (input as { args?: unknown }).args : undefined,
    ...(typeof role === "string" ? { role } : {}),
  };

  // ① owner 恒 allow:策略文件缺失/坏/写错都不该把会话所有者锁在门外。
  if (kind === "owner") return allowed(principalId, method);

  const policies = isPlainObject(policySet) && Array.isArray((policySet as PolicySet).policies)
    ? (policySet as PolicySet).policies
    : [];

  // ② 候选筛选:kind 必须相等;策略声明了 role 就要求 ctx.role 严格相等。
  const candidates: PrincipalPolicy[] = [];
  for (const policy of policies) {
    if (!isPlainObject(policy)) continue;
    if (str((policy as PrincipalPolicy).kind) !== kind) continue;
    const policyRole = (policy as PrincipalPolicy).role;
    if (typeof policyRole === "string" && policyRole !== (typeof role === "string" ? role : undefined)) {
      continue;
    }
    candidates.push(policy as PrincipalPolicy);
  }
  if (candidates.length === 0) return denyNoPolicy(principalId, method);

  // ③④⑤ 逐候选:先判适用性,再判条件;首个可判定结果即回。
  let applicable = 0;
  for (const candidate of candidates) {
    const binding = candidate.binding;
    if (typeof binding === "string") {
      if (binding !== principalId) continue;
    } else if (typeof binding === "function") {
      let ok: unknown;
      try {
        ok = binding(ctx);
      } catch {
        return failed(principalId, method);
      }
      if (!ok) continue;
    }
    applicable++;
    const condition = candidate.condition;
    if (typeof condition !== "function") return allowed(principalId, method);
    let verdict: unknown;
    try {
      verdict = condition(ctx);
    } catch {
      return failed(principalId, method);
    }
    if (!verdict) return { principalId, method, allow: false, code: "PEER_DENY_POLICY" };
    return allowed(principalId, method);
  }
  void applicable;
  return denyNoPolicy(principalId, method);
}

export interface PeerListInput<T = unknown> {
  principal: Principal;
  items: readonly T[];
  methodOf: (item: T, index: number) => string;
  args?: unknown;
  role?: string;
}

/**
 * 逐项独立判定:一项 POLICY_FAILED / DENY 不改变其它项的结论。
 * 为什么不能短路:调用方(事件分发)需要知道「这一批里哪几项被拒」,而不是只有第一个。
 */
export function listAllows<T = unknown>(
  policySet: PolicySet | undefined,
  input: PeerListInput<T>,
): PeerListResult {
  const principal = isPlainObject(input) ? (input as PeerListInput<T>).principal : undefined;
  const principalId = isPlainObject(principal) ? str((principal as Principal).id) : "";
  const items = isPlainObject(input) && Array.isArray((input as PeerListInput<T>).items)
    ? (input as PeerListInput<T>).items
    : [];
  const methodOf = isPlainObject(input) ? (input as PeerListInput<T>).methodOf : undefined;
  const args = isPlainObject(input) ? (input as PeerListInput<T>).args : undefined;
  const role = isPlainObject(input) ? (input as PeerListInput<T>).role : undefined;

  const entries: PeerListEntry[] = [];
  let allowedCount = 0;
  let deniedCount = 0;
  items.forEach((item, index) => {
    let method = "";
    try {
      method = typeof methodOf === "function" ? str(methodOf(item, index)) : "";
    } catch {
      method = "";
    }
    // 单次 decide 自身不 throw;这里再兜一层,防止 methodOf 之外的意外把整批打散。
    let decision: PeerDecision;
    try {
      decision = decide(policySet, {
        principal: { id: principalId, kind: (isPlainObject(principal) ? (principal as Principal).kind : "") as PrincipalKind },
        method,
        args,
        role,
      });
    } catch {
      decision = { principalId, method, allow: false, code: "PEER_POLICY_FAILED" };
    }
    if (decision.allow) allowedCount++;
    else deniedCount++;
    entries.push({ index, item, method, allow: decision.allow, code: decision.code });
  });

  const event = allowedCount === items.length
    ? { allow: true, code: "PEER_EVENT_ALLOWED" as PeerCode }
    : { allow: false, code: "PEER_EVENT_DENIED" as PeerCode };

  return { principalId, entries, allowed: allowedCount, denied: deniedCount, event };
}

/** 事件粒度判定:全部 item allow 才算事件放行;同时带回 entries(便于逐项定位被拒项)。 */
export function eventAllows<T = unknown>(
  policySet: PolicySet | undefined,
  input: PeerListInput<T>,
): PeerListResult {
  return listAllows(policySet, input);
}

/** 对 policySet.methods 全量生成 baseline(args 固定为 {})。 */
function buildBaseline(
  policySet: PolicySet | undefined,
  principal: Principal,
  role?: string,
): Record<string, boolean> {
  const baseline: Record<string, boolean> = {};
  const methods = isPlainObject(policySet) && Array.isArray((policySet as PolicySet).methods)
    ? (policySet as PolicySet).methods
    : [];
  for (const method of methods) {
    const name = str(method);
    if (!name) continue;
    const decision = decide(policySet, { principal, method: name, args: {}, role });
    if (decision.allow) {
      baseline[name] = true;
    } else if (decision.code === "PEER_DENY_POLICY" || decision.code === "PEER_DENY_NO_POLICY") {
      baseline[name] = false;
    }
    // POLICY_FAILED:算不出来的授权**从快照中消失**(不写 key),
    // 而不是写成 false —— 否则重连后会把「没算出来」当成「明确禁止」并一路固化。
  }
  return baseline;
}

function cloneSnapshot(snapshot: PeerSnapshot): PeerSnapshot {
  return {
    principalId: str(snapshot?.principalId),
    baseline: { ...(isPlainObject(snapshot?.baseline) ? snapshot.baseline : {}) },
    follow: Array.isArray(snapshot?.follow) ? snapshot.follow.map((f) => ({ ...f })) : [],
  };
}

export interface PeerSnapshotResult {
  snapshot: PeerSnapshot;
  code: PeerCode;
}

/** 生成快照:全量 methods 判定,args={},follow 从空开始。 */
export function snapshotFor(
  policySet: PolicySet | undefined,
  principal: Principal,
  at?: string,
  role?: string,
): PeerSnapshotResult {
  void at; // 快照本体不记时间(时间属于 follow 项);保留参数以便调用方统一签名。
  const safePrincipal: Principal = {
    id: isPlainObject(principal) ? str((principal as Principal).id) : "",
    kind: (isPlainObject(principal) ? str((principal as Principal).kind) : "") as PrincipalKind,
  };
  return {
    snapshot: { principalId: safePrincipal.id, baseline: buildBaseline(policySet, safePrincipal, role), follow: [] },
    code: "PEER_SNAPSHOT",
  };
}

/** 追加一次 follow-up 并同步 baseline:不修改入参快照(返回副本)。 */
export function applyFollow(
  snapshot: PeerSnapshot,
  input: { method: string; allow: boolean; at?: string },
): PeerSnapshotResult {
  const next = cloneSnapshot(snapshot);
  const method = isPlainObject(input) ? str((input as { method?: unknown }).method) : "";
  const allow = isPlainObject(input) ? Boolean((input as { allow?: unknown }).allow) : false;
  const at = isPlainObject(input) ? (input as { at?: unknown }).at : undefined;
  next.follow.push({
    at: typeof at === "string" ? at : new Date().toISOString(),
    method,
    allow,
  });
  next.baseline[method] = allow;
  return { snapshot: next, code: "PEER_FOLLOW_APPLIED" };
}

/**
 * 从 policySet 反推 principal.kind(快照本身只记 id,不记 kind)。
 *
 * 反推顺序:① 有 binding 精确等于 principalId 的策略 → 用它的 kind;
 *          ② 全部策略 kind 唯一 → 用该 kind;③ 都推不出来 → 空 kind(等价「无策略」→ DENY_NO_POLICY)。
 * 调用方若已知 kind(store 层有),直接传第四参覆盖反推,避免猜。
 */
function inferPrincipal(
  policySet: PolicySet | undefined,
  principalId: string,
  principal?: Principal,
): Principal {
  if (isPlainObject(principal) && str((principal as Principal).kind)) {
    return { id: str((principal as Principal).id) || principalId, kind: (principal as Principal).kind };
  }
  const policies = isPlainObject(policySet) && Array.isArray((policySet as PolicySet).policies)
    ? (policySet as PolicySet).policies
    : [];
  const bound = policies.find((p) => isPlainObject(p) && (p as PrincipalPolicy).binding === principalId);
  if (isPlainObject(bound)) return { id: principalId, kind: (bound as PrincipalPolicy).kind };
  const kinds = new Set<string>();
  for (const policy of policies) {
    if (isPlainObject(policy)) kinds.add(str((policy as PrincipalPolicy).kind));
  }
  if (kinds.size === 1) {
    const [only] = Array.from(kinds);
    return { id: principalId, kind: (only ?? "") as PrincipalKind };
  }
  return { id: principalId, kind: "" as PrincipalKind };
}

/**
 * 策略失效重算:按**当前** policySet 重算 baseline,并清空 follow。
 * follow 里的历史动作属于旧策略,留着会让「失效」变成「半失效」。
 *
 * 快照只记 principalId(不记 kind),所以重算需要 kind:优先用第四参 principal 给的 kind,
 * 否则按 policySet 反推(见 inferPrincipal)。
 */
export function invalidate(
  snapshot: PeerSnapshot,
  policySet: PolicySet | undefined,
  at?: string,
  principal?: Principal,
): PeerSnapshotResult {
  void at;
  const current = isPlainObject(snapshot) ? snapshot : ({ principalId: "", baseline: {}, follow: [] } as PeerSnapshot);
  const resolved = inferPrincipal(policySet, str(current.principalId), principal);
  return {
    snapshot: { principalId: resolved.id, baseline: buildBaseline(policySet, resolved), follow: [] },
    code: "PEER_INVALIDATED",
  };
}

/** 完全重载:全新的 baseline(旧 follow 一并清空)。 */
export function reloadSnapshot(
  policySet: PolicySet | undefined,
  principal: Principal,
  at?: string,
): PeerSnapshotResult {
  void at;
  const safePrincipal: Principal = {
    id: isPlainObject(principal) ? str((principal as Principal).id) : "",
    kind: (isPlainObject(principal) ? str((principal as Principal).kind) : "") as PrincipalKind,
  };
  return {
    snapshot: { principalId: safePrincipal.id, baseline: buildBaseline(policySet, safePrincipal), follow: [] },
    code: "PEER_RELOADED",
  };
}

/** 重连:保留最后一份快照(返回副本,follow 原样带过),不做重算。 */
export function mergeReconnect(snapshot: PeerSnapshot): PeerSnapshotResult {
  return { snapshot: cloneSnapshot(snapshot), code: "PEER_SNAPSHOT" };
}

/** 快照是否允许某方法(只认明确的 true;缺 key 一律 false)。 */
export function snapshotAllows(snapshot: PeerSnapshot, method: string): boolean {
  if (!isPlainObject(snapshot) || !isPlainObject(snapshot.baseline)) return false;
  return snapshot.baseline[str(method)] === true;
}
