/**
 * 权限策略链「单调收窄」+ session-always 内存作用域。
 * ## 为什么 guard 只能收窄、不能放宽
 * 权限决策的可信来源本来就多元(规则文件 / 面板审批 / 环境开关 / preset pin),每加一层
 * 策略,都存在「这一层把别的层挡住了」的风险。若允许 guard 返回 allow,等于给每个插件式
 * 策略发一张无条件放行票:一条写错的 guard(比如 check 里 catch 后 return allow)就能把
 * readonly 会话打开,而规则/面板这条主线还以为自己全程在把关。
 * 所以契约里**根本没有 allow**:
 * - deny = 收窄(链上任一条 deny 即拒,且把全部 deny 原因留下供审计);
 * - abstain= 让位(交回既有规则/面板路径逐字不变)。
 * 这样「接入 guard」在集合意义上只会减少放行面:评审时可以逐条看某条 deny 是否合理,
 * 而不必担心它悄悄把谁放进来。运行时对越界返回值(allow / undefined / 非对象)一律降级为
 * abstain,guard 抛错按 deny 处理(fail-closed)——异常既不能变成放行,也不能静默消失。
 * ## session-always 为什么必须限定在内存作用域
 * 「本会话总是允许」是给重复确认降噪的,它不是策略,不该沉淀成持久规则(否则一次手滑
 * 就等于永久放行)。因此存储只有内存实现,并自带三条边界:TTL(缺省 30min)、单会话条目
 * 上限(缺省 50,超限淘汰最旧)、会话隔离(键含 sessionId,永不跨会话命中);另有
 * noAlwaysAllow 开关,让「记住」与「命中」同时失效(记住直接返回 false,查询恒 miss)。
 * ## 纪律
 * 纯逻辑:零 IO、不 throw、不读时钟(时间一律由调用方传入 now),便于直测与确定性重放。
 * 不可变:入参不修改,返回值冻结。
 */

/** guard 的裁决:没有 allow——见文件头注释。 */
export type GuardVerdict = "deny" | "abstain";

/** guard 看到的上下文(只读;调用方不得在 check 里改它)。 */
export interface GuardCtx {
  readonly tool: string;
  readonly summary: string;
  readonly sessionId: string;
  readonly taskClass?: string;
  readonly args?: unknown;
}

export interface GuardResult {
  readonly verdict: GuardVerdict;
  readonly reason?: string;
}

export interface Guard {
  readonly id: string;
 /** 只允许收窄:deny 拒,abstain 让位。 */
  check(ctx: GuardCtx): GuardResult;
}

export interface GuardHit {
  readonly guardId: string;
  readonly verdict: GuardVerdict;
  readonly reason?: string;
}

export interface GuardChainResult {
  readonly decision: "deny" | "abstain";
 /** 逐条评估的全量痕迹(含 abstain),审计用。 */
  readonly hits: readonly GuardHit[];
 /** 每个 deny 一条可读原因(「guardId: reason」),顺序=链序。 */
  readonly denyReasons: readonly string[];
}

/**
 * 逐条全评估(不短路):deny 之后仍继续跑后续 guard,把全部命中一次留全——
 * 审计要看的是「这条链整体怎么看」,而不是「第一个拒绝就收工」。
 * 空链/非数组=abstain;guard 抛错或形态非法=deny(fail-closed)。
 */
export function runGuardChain(guards: readonly Guard[] | undefined, ctx: GuardCtx): GuardChainResult {
  const hits: GuardHit[] = [];
  const denyReasons: string[] = [];
  const list = Array.isArray(guards) ? guards : [];
  for (const raw of list) {
    const g = raw as Guard | undefined;
    const id = typeof g?.id === "string" && g.id ? g.id : "<unnamed>";
    const check = g?.check;
    if (typeof check !== "function") {
 // 形态非法也是 fail-closed:装配错误不能静默变成弃权。
      const reason = "invalid-guard";
      hits.push(Object.freeze({ guardId: id, verdict: "deny" as const, reason }));
      denyReasons.push(`${id}: ${reason}`);
      continue;
    }
    let returned: unknown;
    try {
      returned = check.call(g, ctx);
    } catch (err) {
      const reason = "guard-error:" + (err instanceof Error ? err.message : String(err));
      hits.push(Object.freeze({ guardId: id, verdict: "deny" as const, reason }));
      denyReasons.push(`${id}: ${reason}`);
      continue;
    }
    const obj = (returned && typeof returned === "object" ? returned : {}) as { verdict?: unknown; reason?: unknown };
    const reason = typeof obj.reason === "string" && obj.reason ? obj.reason : undefined;
 // 越界返回值(allow / undefined / 非对象)一律降级为 abstain:链只能收窄。
    const verdict: GuardVerdict = obj.verdict === "deny" ? "deny" : "abstain";
    hits.push(Object.freeze({ guardId: id, verdict, ...(reason ? { reason } : {}) }));
    if (verdict === "deny") denyReasons.push(reason ? `${id}: ${reason}` : id);
  }
  return Object.freeze({
    decision: denyReasons.length > 0 ? ("deny" as const) : ("abstain" as const),
    hits: Object.freeze(hits),
    denyReasons: Object.freeze(denyReasons),
  });
}

/** session-always 缺省参数(真源只有这里一处;测试与接线都读它)。 */
export const DEFAULT_ALWAYS_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_ALWAYS_MAX_PER_SESSION = 50;

export interface SessionAlwaysOptions {
 /** 单条授权寿命(缺省 30min;非法值回落缺省)。 */
  readonly ttlMs?: number;
 /** 单会话条目上限(缺省 50;超限淘汰最旧)。 */
  readonly maxPerSession?: number;
 /** 关掉「本会话总是允许」:remember 直接 false、lookup 恒 miss。 */
  readonly noAlwaysAllow?: boolean;
}

export interface SessionAlwaysRememberInfo {
 /** 覆盖本次的 TTL。 */
  readonly ttlMs?: number;
 /** 授权对象版本(规则/审批对象的 revision),供调用方判定是否已过期语义。 */
  readonly revision?: string;
 /** 写入时刻(epoch ms),必填——本模块不读时钟。 */
  readonly at: number;
}

export interface SessionAlwaysLookup {
  readonly hit: boolean;
  readonly expiresAt?: number;
  readonly revision?: string;
}

export interface SessionAlwaysStats {
  readonly entries: number;
  readonly sessions: number;
  readonly perSession: Readonly<Record<string, number>>;
  readonly noAlwaysAllow: boolean;
  readonly ttlMs: number;
  readonly maxPerSession: number;
}

interface AlwaysEntry {
  readonly expiresAt: number;
  readonly at: number;
  readonly revision?: string;
}

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/**
 * 会话内 always 授权:纯内存、按 sessionId 隔离、TTL + 条目上限。
 * 一次手滑只影响内存里的这个会话,进程重启即消失——这是刻意的:会话级授权不是策略。
 */
export class SessionAlwaysStore {
  private readonly ttlMs: number;
  private readonly maxPerSession: number;
  private readonly noAlwaysAllow: boolean;
  private readonly bySession = new Map<string, Map<string, AlwaysEntry>>();

  constructor(opts: SessionAlwaysOptions = {}) {
    this.ttlMs = positiveInt(opts.ttlMs, DEFAULT_ALWAYS_TTL_MS);
    this.maxPerSession = positiveInt(opts.maxPerSession, DEFAULT_ALWAYS_MAX_PER_SESSION);
    this.noAlwaysAllow = opts.noAlwaysAllow === true;
  }

 /** 记住一条会话级放行;返回是否真的写入(noAlwaysAllow / 非法入参 → false,不写)。 */
  remember(sessionId: string, key: string, info: SessionAlwaysRememberInfo): boolean {
    if (this.noAlwaysAllow) return false;
    if (typeof sessionId !== "string" || !sessionId) return false;
    if (typeof key !== "string" || !key) return false;
    const at = info?.at;
    if (typeof at !== "number" || !Number.isFinite(at)) return false;
    const ttl = positiveInt(info?.ttlMs, this.ttlMs);
    let m = this.bySession.get(sessionId);
    if (!m) {
      m = new Map<string, AlwaysEntry>();
      this.bySession.set(sessionId, m);
    }
 // 覆盖同名键:刷新(等价于重新授权);淘汰按 at 算,与插入顺序解耦。
    m.set(key, Object.freeze({
      expiresAt: at + ttl,
      at,
      ...(typeof info?.revision === "string" ? { revision: info.revision } : {}),
    }));
 // 淘汰:最旧 = at 最小(at 相同取先插入的那条),保证确定性。
    while (m.size > this.maxPerSession) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [k, e] of m) {
        if (e.at < oldestAt) { oldestAt = e.at; oldestKey = k; }
      }
      if (oldestKey === undefined) break;
      m.delete(oldestKey);
    }
    return true;
  }

 /** 查询命中;过期即删(now >= expiresAt 视为过期)。 */
  lookup(sessionId: string, key: string, now: number): SessionAlwaysLookup {
    const miss: SessionAlwaysLookup = Object.freeze({ hit: false });
    if (this.noAlwaysAllow) return miss;
    if (typeof sessionId !== "string" || !sessionId) return miss;
    if (typeof key !== "string" || !key) return miss;
    const t = typeof now === "number" && Number.isFinite(now) ? now : Number.NaN;
    if (Number.isNaN(t)) return miss;
    const m = this.bySession.get(sessionId);
    if (!m) return miss;
    const e = m.get(key);
    if (!e) return miss;
    if (t >= e.expiresAt) {
      m.delete(key);
      if (m.size === 0) this.bySession.delete(sessionId);
      return miss;
    }
    return Object.freeze({ hit: true, expiresAt: e.expiresAt, ...(e.revision ? { revision: e.revision } : {}) });
  }

 /** 清空(给 sessionId=清该会话;不传=全清,进程收尾/测试用)。 */
  clear(sessionId?: string): void {
    if (typeof sessionId === "string") this.bySession.delete(sessionId);
    else this.bySession.clear();
  }

  stats(): SessionAlwaysStats {
    const perSession: Record<string, number> = {};
    let entries = 0;
    for (const [sid, m] of this.bySession) {
      perSession[sid] = m.size;
      entries += m.size;
    }
    return Object.freeze({
      entries,
      sessions: this.bySession.size,
      perSession: Object.freeze(perSession) as Readonly<Record<string, number>>,
      noAlwaysAllow: this.noAlwaysAllow,
      ttlMs: this.ttlMs,
      maxPerSession: this.maxPerSession,
    });
  }
}

export interface PermissionEvaluationInput {
 /** 权限模式(readonly/plan 的写类拒绝由既有路径处理,本模块不改)。 */
  readonly mode: string;
  readonly tool: string;
  readonly sessionId: string;
 /** 完整 guard 上下文(缺省由 tool/sessionId 拼,summary 为空串)。 */
  readonly guardCtx?: GuardCtx;
  readonly guards?: readonly Guard[];
  readonly alwaysStore?: SessionAlwaysStore;
 /** always 键(缺省=tool)。接线路用「tool|summary」避免一次放行扩散到同工具全部调用。 */
  readonly alwaysKey?: string;
 /** 关掉 always 查询(与 store 自身开关同语义,这里可临时覆盖)。 */
  readonly noAlwaysAllow?: boolean;
 /** 当前时刻;给了 alwaysStore 就必须给(本模块不读时钟,缺省按 0 处理)。 */
  readonly now?: number;
}

export interface PermissionEvaluation {
  readonly effect: "deny" | "allow" | "ask";
  readonly source: "guard" | "always" | "mode";
  readonly reason?: string;
  readonly guardHits?: readonly GuardHit[];
  readonly denyReasons?: readonly string[];
}

/**
 * 统一判定:guard deny(最高优先)> session-always 命中 > 交回既有路径(ask)。
 * 不 throw:内层异常一律收敛成 deny/guard(fail-closed)。
 */
export function evaluatePermission(input: PermissionEvaluationInput): PermissionEvaluation {
  try {
    const ctx: GuardCtx = input.guardCtx ?? {
      tool: input.tool,
      summary: "",
      sessionId: input.sessionId,
    };
    const chain = runGuardChain(input.guards, ctx);
    if (chain.decision === "deny") {
      return Object.freeze({
        effect: "deny" as const,
        source: "guard" as const,
        reason: chain.denyReasons.join("; "),
        guardHits: chain.hits,
        denyReasons: chain.denyReasons,
      });
    }
    if (input.noAlwaysAllow !== true && input.alwaysStore) {
      const key = input.alwaysKey ?? input.tool;
      const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : 0;
      const hit = input.alwaysStore.lookup(input.sessionId, key, now);
      if (hit.hit) {
        return Object.freeze({
          effect: "allow" as const,
          source: "always" as const,
          reason: hit.revision ? "session-always:" + hit.revision : "session-always",
          guardHits: chain.hits,
        });
      }
    }
 // 其余(含 abstain)交回既有规则/面板路径:本模块只收窄,不接管放行判定。
    return Object.freeze({ effect: "ask" as const, source: "mode" as const, guardHits: chain.hits });
  } catch (err) {
    const reason = "guard-chain-error:" + (err instanceof Error ? err.message : String(err));
    return Object.freeze({
      effect: "deny" as const,
      source: "guard" as const,
      reason,
      denyReasons: Object.freeze([reason]),
    });
  }
}
