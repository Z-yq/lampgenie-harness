/**
 * 同步权威协议(#113,纯逻辑零 IO)。
 * 为什么需要协议:会话切换归属(agent 迁移、实例接管)后,同一段历史会同时存在于新旧实例。
 * 只要没有「唯一权威序列」,就会稳定复现五类事故:
 * ① 旧实例迟到事件写回,把已迁移的历史改花;
 * ② 同一条事件被重复投递,append 出重复行;
 * ③ 两份历史静默分叉,谁也不知道哪份是真的;
 * ④ 先读历史再订阅,两者之间到达的事件永久丢失;
 * ⑤ 代理写完立刻读到旧副本(本地还没追上权威水位)。
 * 解法只有一条主干:(aggregateId, seq, ownerId) 三元组唯一,owner 不符一律丢弃;
 * 归属转移按「拉平 → claim → replay → steal」四段做;订阅先拿脏位再读历史;
 * 非 GET 响应附 seq 水位,代理等本地追平后再返回,超时 503,sync 断开直接拒代理。
 * 本模块只做纯逻辑:落盘在 gateway 的 sync-authority-store,命令行在 scripts/sync-authority.mts。
 * 设计取舍(每条都对应一个真实注意):
 * - **先判「这个 seq 写过没有」,再判 owner**:重复投递是常态(网络重试),迟到写回是事故。
 *   顺序反过来会让「旧 owner 重投一条早就存在的事件」被误判成迁移事故,噪音盖掉信号。
 * - **同 seq 同 payloadHash = NOOP,同 seq 异 hash = CONFLICT_DIE**:同 hash 是幂等重投,
 *   静默吞掉后才不会让重试放大成错误;异 hash 说明同一序号被写了两份不同内容,历史已经分叉,
 *   此时「挑一份留下」等于伪造历史,唯一诚实的动作是 die 并让上层人工对齐。
 * - **拒收/无效一律返回入参 state 本身,不返回「差不多的副本」**:调用方常用引用/深比较
 *   断言「拒收没有副作用」,返回部分写入的副本会让这类断言变成假绿。
 * - **owner 不符丢弃但不动水位**:迁移后旧实例的内存态可能比新 owner 还新,若拿它的 seq
 *   抬水位,新 owner 后续写入会被自己的水位挡住——水位只由当前 owner 的写入推动。
 * - **migrate 先在快照上跑完四段再整体替换**:四段任意一段失败都必须回到原状态。中途直接改
 *   state 的话,claim 成功而 replay 失败会留下「新 owner + 空历史」的半成品,比重做还难收拾。
 * - **claim 产生的 leaseToken 确定性可重放(不用时钟/随机)**:迁移会重试,租约 token 每次不同
 *   就无法判断两次 claim 是不是同一笔迁移;这里用 aggregateId/owner/水位拼出来即可。
 * - **replay 返回深拷贝**:迁移后的新实例会持有一份历史,它与权威状态必须没有共享引用,
 *   否则新实例一次本地 append 就会改写权威数组(这正是「两份历史静默分叉」的起点)。
 * - **订阅先给 dirtyFromSeq 再给 history**:老套路「先读历史再订阅」,两步之间到达的事件
 *   两边都不在,永久丢失。dirtyFromSeq 取 max(sinceSeq, watermark+1),含义是「从这里开始
 *   可能还有我没读到的」,订阅方拿它当脏位标记去重读,才补得上夹缝事件。
 * - **awaitCatchup 用调用方注入的 now/sleep**:追平是「等」的逻辑,测试里绝不能真等 5 秒;
 *   时钟与睡眠注入后,fake 时钟可以精确断言「超时那一刻返回 TIMEOUT 而不是 OK」。
 * - **超时返回 TIMEOUT 而不是「乐观 OK」**:代理「写完立刻读到旧副本」的根因就是乐观返回,
 *   宁可让调用方回 503,也不要让它拿着旧副本冒充权威结果。
 * - **sync 断开禁止代理**:没有 sync 连接就没有判据判断「我是不是最新」,此时放行代理等于
 *   用旧副本回答新问题;显式 SYNC_PROXY_REFUSED 让上层回 409/503 而不是静默错读。
 * 依赖纪律:零 import(不碰 fs/net/path/node:*),不读时钟(时间一律由调用方传数字时间戳,
 * 非法按 0);全部函数纯函数:不 throw、不改入参、返回深拷贝。
 */

/** 一条权威事件。seq 在同一个 aggregateId 内单调,ownerId 是写入方。 */
export type AuthorityEvent = {
  aggregateId: string;
  seq: number;
  ownerId: string;
  payloadHash: string;
  at: number;
};

/** 一个聚合的权威视图:当前 owner + 水位(最大已接受 seq)+ 按 seq 升序的事件。 */
export type Aggregate = {
  aggregateId: string;
  ownerId: string;
  watermark: number;
  events: AuthorityEvent[];
};

/** 全局同步状态。owners 只记「这个 owner 从何时开始存在」,用于审计与回收。 */
export type SyncState = {
  aggregates: Record<string, Aggregate>;
  owners: Record<string, { since: number }>;
};

/** 稳定码(调用方与 CLI 的公开契约,禁止改字面量)。 */
export type SyncCode =
  | "SYNC_INVALID"
  | "SYNC_ACCEPTED"
  | "SYNC_NOOP"
  | "SYNC_CONFLICT_DIE"
  | "SYNC_DROPPED_OWNER"
  | "SYNC_MIGRATED"
  | "SYNC_MIGRATE_FAILED"
  | "SYNC_SUBSCRIBED"
  | "SYNC_CATCHUP_OK"
  | "SYNC_CATCHUP_TIMEOUT"
  | "SYNC_PROXY_REFUSED";

/** 迁移四段(顺序固定,测试与 CLI 都按这个字面量序列断言)。 */
export const MIGRATE_PHASES = ["flatten", "claim", "replay", "steal"] as const;

export type MigratePhase = (typeof MIGRATE_PHASES)[number];

/** 空状态:每次 new 一份,避免调用方共享同一个可变字面量。 */
export function emptyState(): SyncState {
  return { aggregates: {}, owners: {} };
}

type Unknownish = unknown;

function isFiniteNumber(value: Unknownish): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInt(value: Unknownish): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value > 0;
}

function isNonEmptyText(value: Unknownish): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function cloneEvent(event: AuthorityEvent): AuthorityEvent {
  return {
    aggregateId: event.aggregateId,
    seq: event.seq,
    ownerId: event.ownerId,
    payloadHash: event.payloadHash,
    at: event.at,
  };
}

function cloneAggregate(aggregate: Aggregate): Aggregate {
  return {
    aggregateId: aggregate.aggregateId,
    ownerId: aggregate.ownerId,
    watermark: aggregate.watermark,
    events: aggregate.events.map(cloneEvent),
  };
}

/** 浅拷 aggregates/owners,聚合与事件按需深拷(纯函数:绝不把入参的引用交出去)。 */
function cloneState(state: SyncState): SyncState {
  const aggregates: Record<string, Aggregate> = {};
  for (const [id, aggregate] of Object.entries(state.aggregates ?? {})) {
    aggregates[id] = cloneAggregate(aggregate);
  }
  const owners: Record<string, { since: number }> = {};
  for (const [id, owner] of Object.entries(state.owners ?? {})) {
    owners[id] = { since: isFiniteNumber(owner?.since) ? owner.since : 0 };
  }
  return { aggregates, owners };
}

/** owners 登记:已有则保留更早的 since(owner 的「出生时间」不该被后写覆盖)。 */
function withOwner(state: SyncState, ownerId: string, at: number): Record<string, { since: number }> {
  const owners: Record<string, { since: number }> = {};
  for (const [id, owner] of Object.entries(state.owners ?? {})) {
    owners[id] = { since: isFiniteNumber(owner?.since) ? owner.since : 0 };
  }
  const prev = owners[ownerId];
  const since = isFiniteNumber(at) ? at : 0;
  owners[ownerId] = { since: prev && prev.since < since ? prev.since : since };
  return owners;
}

function isValidEvent(event: AuthorityEvent): boolean {
  if (event === null || typeof event !== "object") return false;
  return (
    isNonEmptyText(event.aggregateId) &&
    isPositiveInt(event.seq) &&
    isNonEmptyText(event.ownerId) &&
    isNonEmptyText(event.payloadHash) &&
    isFiniteNumber(event.at)
  );
}

/**
 * 接受一条事件。分流顺序:合法性 → 同 seq 已写过? → hash 全等? → owner 相符?。
 * 拒收路径一律返回入参 state 本身(「拒收 = 零副作用」是调用方可依赖的契约)。
 */
export function acceptEvent(
  state: SyncState,
  event: AuthorityEvent): { state: SyncState; code: SyncCode } {
  if (!isValidEvent(event)) return { state, code: "SYNC_INVALID" };

  const existing = state.aggregates?.[event.aggregateId];

  if (existing) {
    const duplicate = existing.events.find((item) => item.seq === event.seq);
    if (duplicate) {
      return {
        state,
        code: duplicate.payloadHash === event.payloadHash ? "SYNC_NOOP" : "SYNC_CONFLICT_DIE",
      };
    }
    if (existing.ownerId !== event.ownerId) return { state, code: "SYNC_DROPPED_OWNER" };
    const events = [...existing.events.map(cloneEvent), cloneEvent(event)].sort((a, b) => a.seq - b.seq);
    const aggregates: Record<string, Aggregate> = { ...cloneState(state).aggregates };
    aggregates[event.aggregateId] = {
      aggregateId: existing.aggregateId,
      ownerId: existing.ownerId,
      watermark: Math.max(existing.watermark, event.seq),
      events,
    };
    return { state: { aggregates, owners: withOwner(state, event.ownerId, event.at) }, code: "SYNC_ACCEPTED" };
  }

  // 新聚合:owner 由首个事件决定,水位就是它的 seq。
  const aggregates: Record<string, Aggregate> = { ...cloneState(state).aggregates };
  aggregates[event.aggregateId] = {
    aggregateId: event.aggregateId,
    ownerId: event.ownerId,
    watermark: event.seq,
    events: [cloneEvent(event)],
  };
  return { state: { aggregates, owners: withOwner(state, event.ownerId, event.at) }, code: "SYNC_ACCEPTED" };
}

export type MigrateOptions = {
  aggregateId: string;
  fromOwner: string;
  toOwner: string;
  at?: number;
};

export type MigrateOutcome = {
  state: SyncState;
  code: SyncCode;
  phases: MigratePhase[];
  replays: AuthorityEvent[];
  revokedOwner?: string;
  leaseToken?: string;
  reason?: string;
};

/**
 * 归属转移:flatten(校验并拉平水位)→ claim(写新 owner + 租约)→ replay(交出历史深拷贝)
 * → steal(旧 owner 撤销)。任一段前置不满足立刻失败,原 state 一字不改,可安全重试。
 */
export function migrate(state: SyncState, options: MigrateOptions): MigrateOutcome {
  const phases: MigratePhase[] = [];
  const fail = (reason: string): MigrateOutcome => ({
    state,
    code: "SYNC_MIGRATE_FAILED",
    phases,
    replays: [],
    reason,
  });

  const aggregateId = options?.aggregateId;
  const fromOwner = options?.fromOwner;
  const toOwner = options?.toOwner;
  const at = isFiniteNumber(options?.at) ? (options?.at as number) : 0;

  // ── flatten:确认聚合存在且当前 owner 就是 fromOwner,并取权威 max seq ──
  if (!isNonEmptyText(aggregateId)) return fail("flatten:no-aggregate");
  const aggregate = state.aggregates?.[aggregateId];
  if (!aggregate) return fail("flatten:no-aggregate");
  if (!isNonEmptyText(fromOwner) || aggregate.ownerId !== fromOwner) return fail("flatten:not-owner");
  const maxSeq = aggregate.events.reduce((max, item) => Math.max(max, item.seq), 0);
  const watermark = Math.max(aggregate.watermark, maxSeq);
  phases.push("flatten");

  // ── claim:写新 owner。同 owner 迁移是无意义重试;空 toOwner 会写出无主聚合 ──
  if (!isNonEmptyText(toOwner)) return fail("claim:empty-owner");
  if (toOwner === fromOwner) return fail("claim:same-owner");
  const leaseToken = `${aggregateId}@${toOwner}:${watermark}`;
  phases.push("claim");

  // ── replay:交出全部历史深拷贝(新实例与权威状态不共享任何引用) ──
  const replays = aggregate.events.map(cloneEvent).sort((a, b) => a.seq - b.seq);
  phases.push("replay");

  // ── steal:旧 owner 撤销(不可逆,故放在最后一段) ──
  const revokedOwner = fromOwner;
  phases.push("steal");

  const snapshot = cloneState(state);
  snapshot.aggregates[aggregateId] = {
    aggregateId,
    ownerId: toOwner,
    watermark,
    events: replays.map(cloneEvent),
  };
  const owners = withOwner({ aggregates: {}, owners: snapshot.owners }, toOwner, at);
  return {
    state: { aggregates: snapshot.aggregates, owners },
    code: "SYNC_MIGRATED",
    phases,
    replays,
    revokedOwner,
    leaseToken,
  };
}

export type SubscribeInput = { aggregateId: string; sinceSeq: number };

export type Subscription = { aggregateId: string; dirtyFromSeq: number };

export type SubscribeOutcome = {
  code: SyncCode;
  subscription: Subscription;
  history: AuthorityEvent[];
};

/**
 * 先订阅拿脏位,再读历史:两步之间到达的事件靠 dirtyFromSeq(= max(sinceSeq, watermark+1))
 * 标脏,订阅方据此知道自己「至少要从这里补读」,不会被夹缝事件漏掉。
 * 聚合不存在时 dirtyFromSeq 退回 sinceSeq(没有权威水位可用,只能信调用方给的位置)。
 */
export function subscribeThenRead(state: SyncState, input: SubscribeInput): SubscribeOutcome {
  const aggregateId = input?.aggregateId;
  const rawSince = input?.sinceSeq;
  const sinceSeq = isFiniteNumber(rawSince) ? Math.trunc(rawSince) : 0;
  if (!isNonEmptyText(aggregateId) || !isFiniteNumber(rawSince)) {
    return {
      code: "SYNC_INVALID",
      subscription: { aggregateId: "", dirtyFromSeq: 0 },
      history: [],
    };
  }
  const aggregate = state.aggregates?.[aggregateId];
  const dirtyFromSeq = aggregate ? Math.max(sinceSeq, aggregate.watermark + 1) : sinceSeq;
  const history = aggregate
    ? aggregate.events.filter((item) => item.seq >= sinceSeq).map(cloneEvent).sort((a, b) => a.seq - b.seq)
    : [];
  return { code: "SYNC_SUBSCRIBED", subscription: { aggregateId, dirtyFromSeq }, history };
}

/** 水位查询:聚合不存在按 0(「没写过」和「写到 0」在调用方看来等价)。 */
export function watermarkFor(state: SyncState, aggregateId: string): number {
  if (!isNonEmptyText(aggregateId)) return 0;
  const aggregate = state.aggregates?.[aggregateId];
  return aggregate && isFiniteNumber(aggregate.watermark) ? aggregate.watermark : 0;
}

export type AwaitCatchupOptions = {
  timeoutMs: number;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  readLocalSeq?: () => number;
  pollMs?: number;
};

export type AwaitCatchupResult = {
  code: "SYNC_CATCHUP_OK" | "SYNC_CATCHUP_TIMEOUT";
  caughtUp: boolean;
  elapsedMs: number;
  localSeq: number;
};

const DEFAULT_POLL_MS = 5;
/** 轮询硬上限:注入的 now 若是常量,超时永远不会命中,这里兜底防止死循环。 */
const MAX_POLL_ROUNDS = 100_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/**
 * 等本地副本追平权威水位。追平 → OK;超过 timeoutMs → TIMEOUT(调用方回 503);
 * 绝不「乐观 OK」——乐观返回正是「代理写完读到旧副本」的成因。
 */
export async function awaitCatchup(
  localSeq: number,
  watermark: number,
  options: AwaitCatchupOptions): Promise<AwaitCatchupResult> {
  const now = typeof options?.now === "function" ? options.now : () => 0;
  const sleep = typeof options?.sleep === "function" ? options.sleep : defaultSleep;
  const readLocalSeq = typeof options?.readLocalSeq === "function" ? (options.readLocalSeq as () => number) : undefined;
  const pollMs =
    isFiniteNumber(options?.pollMs) && (options?.pollMs as number) > 0 ? (options?.pollMs as number) : DEFAULT_POLL_MS;
  const timeoutMs = isFiniteNumber(options?.timeoutMs) && (options?.timeoutMs as number) >= 0 ? (options?.timeoutMs as number) : 0;
  const target = isFiniteNumber(watermark) ? watermark : 0;

  const readNow = (): number => {
    try {
      const value = now();
      return isFiniteNumber(value) ? value : 0;
    } catch {
      return 0;
    }
  };
  const readLocal = (fallback: number): number => {
    if (!readLocalSeq) return fallback;
    try {
      const value = readLocalSeq();
      return isFiniteNumber(value) ? value : fallback;
    } catch {
      return fallback;
    }
  };

  const start = readNow();
  let local = isFiniteNumber(localSeq) ? localSeq : 0;
  const elapsed = (): number => Math.max(0, readNow() - start);

  for (let round = 0; round < MAX_POLL_ROUNDS; round += 1) {
    local = readLocal(local);
    if (local >= target) {
      return { code: "SYNC_CATCHUP_OK", caughtUp: true, elapsedMs: elapsed(), localSeq: local };
    }
    if (elapsed() >= timeoutMs) {
      return { code: "SYNC_CATCHUP_TIMEOUT", caughtUp: false, elapsedMs: elapsed(), localSeq: local };
    }
    try {
      await sleep(pollMs);
    } catch {
      // sleep 实现坏掉不该把调用方带崩:当作「这一轮没等到」继续按超时判据走。
    }
  }
  return { code: "SYNC_CATCHUP_TIMEOUT", caughtUp: false, elapsedMs: elapsed(), localSeq: local };
}

/** 代理放行判据:sync 未连接时没有「我是不是最新」的判据,一律拒。 */
export function proxyAllowed(input: { syncConnected: boolean }): {
  allowed: boolean;
  code: "SYNC_PROXY_REFUSED" | null;
} {
  const allowed = input?.syncConnected === true;
  return { allowed, code: allowed ? null : "SYNC_PROXY_REFUSED" };
}

/** 非 GET 响应附水位头:代理/客户端据此决定要不要等追平再采信这份结果。 */
export function responseWatermark(
  state: SyncState,
  aggregateId: string): { watermark: number; headers: Record<string, string> } {
  const watermark = watermarkFor(state, aggregateId);
  return { watermark, headers: { "x-sync-watermark": String(watermark) } };
}
