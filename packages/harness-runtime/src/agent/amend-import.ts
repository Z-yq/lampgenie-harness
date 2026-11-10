/**
 * 进程替换后的「导入前判断」纯逻辑(零 IO / 零 import,2026-11 #174)。
 *
 * 为什么需要它:主进程在处理一个提问(ask)的中途被打断(崩溃/替换/重启)后,
 * 新进程要靠盘上的 run 现场接着走。但「接着走」有两类完全不同的做法:
 * - 旧 ask 其实已经算完了(checkpoint 里有终态节点)→ 直接把它当作 imported 节点写进
 *   新会话历史,不重新调模型(省钱、也不会因为重放而写出两份答案);
 * - 旧 ask 还在跑 → 先停掉前驱,等它结算落盘,写入边界之后才允许新进程接手。
 * 这两条路选错任何一条都会产生「同一提问两个答案」或「历史被写乱」的脏现场,
 * 所以把「能不能导、导哪条、门什么时候关」收进一个可逐条断言的判定模块,
 * 由调用方只读结论、按码分支,判断本身不做任何 IO 与模型调用。
 *
 * 关键不变量:
 * 1. 只导「最长全 completed 前缀」:某 actor 的第一个 running/failed 之后即便又有
 *    completed 也不收——那条 completed 的因果前提已经断了(前缀语义单调)。
 * 2. hash 单调不回退:payloadHash 不一致 = HASH_DIVERGED,同一输入重复判定仍是 DIVERGED,
 *    绝不因为重试而退化成 MISS/HIT。
 * 3. 一旦门前写过世界(toolCalls>0),门永久关闭(幂等);关门后带副作用的条目不再导入,
 *    无副作用的条目(toolCalls 0)仍可命中——因为重放它们不改变世界。
 * 4. 目标会话只允许「种子」:种子 = target.seeds 里的 id,或 id 等于 target.id /
 *    以 `${target.id}:` 开头;历史里出现外来 id = TARGET_DIRTY(不是重建现场,是拼接现场)。
 * 5. stopPredecessor 在 awaitSettlement!==true 时零副作用(既不读也不改),返回
 *    SKIP_SETTLEMENT,让调用方自己决定是否重试。
 *
 * 依赖纪律:零 import(不读文件/环境/网络/时间),所有导出函数不 throw;
 * 非法入参折叠成 AMEND_INVALID,状态不满足折叠成 RUN_MISSING / BOUNDARY_MISSING /
 * TARGET_DIRTY / MISS / HASH_DIVERGED / DOOR_CLOSED。码表顺序固定(便于自动化按码断言)。
 */

/** 导入判定的 schema 版本:字段语义变化时递增。 */
export const AMEND_IMPORT_VERSION = 1;

/** 稳定码:导入判定的全部结论(字符串常量,便于落盘与断言)。 */
export const AMEND_INVALID = "AMEND_INVALID" as const;
export const AMEND_RUN_MISSING = "AMEND_RUN_MISSING" as const;
export const AMEND_BOUNDARY_MISSING = "AMEND_BOUNDARY_MISSING" as const;
export const AMEND_TARGET_DIRTY = "AMEND_TARGET_DIRTY" as const;
export const AMEND_PRECHECK_OK = "AMEND_PRECHECK_OK" as const;
export const AMEND_STOPPED = "AMEND_STOPPED" as const;
export const AMEND_SKIP_SETTLEMENT = "AMEND_SKIP_SETTLEMENT" as const;
export const AMEND_CACHE_BUILT = "AMEND_CACHE_BUILT" as const;
export const AMEND_HIT = "AMEND_HIT" as const;
export const AMEND_MISS = "AMEND_MISS" as const;
export const AMEND_HASH_DIVERGED = "AMEND_HASH_DIVERGED" as const;
export const AMEND_DOOR_CLOSED = "AMEND_DOOR_CLOSED" as const;
export const AMEND_SEED_ALLOWED = "AMEND_SEED_ALLOWED" as const;
export const AMEND_FALLBACK_LIVE = "AMEND_FALLBACK_LIVE" as const;

/** 全部稳定码(固定顺序,勿重排)。 */
export const AMEND_CODES = [
  AMEND_INVALID,
  AMEND_RUN_MISSING,
  AMEND_BOUNDARY_MISSING,
  AMEND_TARGET_DIRTY,
  AMEND_PRECHECK_OK,
  AMEND_STOPPED,
  AMEND_SKIP_SETTLEMENT,
  AMEND_CACHE_BUILT,
  AMEND_HIT,
  AMEND_MISS,
  AMEND_HASH_DIVERGED,
  AMEND_DOOR_CLOSED,
  AMEND_SEED_ALLOWED,
  AMEND_FALLBACK_LIVE,
] as const;

export type AmendCode = (typeof AMEND_CODES)[number];

/** ask 的落盘终态:completed 才有资格被导入;running 需要先停前驱;failed 不进前缀。 */
export type AskStatus = "completed" | "running" | "failed";

/** 盘上一条 ask 记录(回放的最小事实集)。 */
export interface AskRecord {
  /** ask id(actor 内唯一)。 */
  id: string;
  /** 发起方(同一 actor 的 asks 构成一条有序前缀)。 */
  actor: string;
  /** 终态。 */
  status: AskStatus;
  /** 消息边界:新会话历史只允许在边界之后追加(缺 = 无法定位,判 BOUNDARY_MISSING)。 */
  messageBoundary?: string;
  /** 该 ask 期间写世界的工具调用次数(>0 表示有副作用,门关后不可导入)。 */
  toolCalls?: number;
  /** 载荷指纹:同 id 不同 hash = 现场已变,禁止导入。 */
  payloadHash?: string;
}

/** world 队列里的一条待导入节点(仅 id + hash,导入时不再重算内容)。 */
export interface WorldEntry {
  id: string;
  payloadHash: string;
}

/** 一个 run 的现场(存在性 + asks 序列 + world 队列 + 目标会话)。 */
export interface RunState {
  runId: string;
  /** run 现场是否真的落在盘上(默认按「不存在」处理,不猜)。 */
  exists: boolean;
  asks: AskRecord[];
  worldQueue: WorldEntry[];
  target?: { sessionId?: string; seeds?: string[]; history?: string[] };
}

/** 导入缓存:actor → 可导入前缀(已按最长全 completed 前缀截断)。 */
export interface ImportCache {
  actorPrefix: Record<string, AskRecord[]>;
  worldQueue: WorldEntry[];
  /** 门是否已关(写过世界之后永久关)。 */
  closed: boolean;
}

/** 目标会话(新进程要接着写的那个会话)。 */
export interface TargetSession {
  id: string;
  seeds: string[];
  history: string[];
}

/** 所有导出一个统一返回形状:ok + 稳定码(+ 可选细节),调用方按码分支。 */
export interface AmendResult {
  ok: boolean;
  codes: AmendCode[];
  detail?: Record<string, unknown>;
}

/** 命中后要写入新会话历史的节点(命中即写,不调模型)。 */
export interface ImportedNode {
  id: string;
  kind: "imported";
  actor: string;
  messageBoundary?: string;
  payloadHash?: string;
  toolCalls: number;
}

/** 运行时入参可能来自反序列化(any/unknown),统一先过这层再取值。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 空缓存:无 actor 前缀、空队列、门未关。 */
export function emptyImportCache(): ImportCache {
  return { actorPrefix: {}, worldQueue: [], closed: false };
}

/** 空白(含纯空格)的 boundary 等同于缺失——写历史时用不了。 */
function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/** 种子判定:在 seeds 名单里,或与 target.id 同源(id 相等 / 以 `${id}:` 开头)。 */
function isSeedId(target: TargetSession, id: string): boolean {
  const seeds = Array.isArray(target.seeds) ? target.seeds : [];
  if (seeds.includes(id)) return true;
  const targetId = target.id;
  if (typeof targetId === "string" && targetId.length > 0) {
    if (id === targetId) return true;
    if (id.startsWith(`${targetId}:`)) return true;
  }
  return false;
}

/** 历史里所有「不是种子」的 id(TARGET_DIRTY 的证据)。 */
function foreignHistoryIds(target: TargetSession): string[] {
  const history = Array.isArray(target.history) ? target.history : [];
  return history.filter((id): id is string => typeof id === "string" && !isSeedId(target, id));
}

function invalidResult(): AmendResult {
  return { ok: false, codes: [AMEND_INVALID] };
}

/**
 * 导入前总闸:run 是否可用 / 边界是否齐 / 目标会话是否只含种子。
 * 短路顺序固定:INVALID → RUN_MISSING → BOUNDARY_MISSING → TARGET_DIRTY → PRECHECK_OK。
 */
export function precheck(run: RunState, opts?: { targetSession?: TargetSession }): AmendResult {
  if (!isRecord(run)) return invalidResult();
  if (!Array.isArray(run.asks)) return invalidResult();

  // run 现场不在盘上:后面全都没意义,短路返回(不报更细的错)。
  if (run.exists !== true) return { ok: false, codes: [AMEND_RUN_MISSING] };

  const missing: string[] = [];
  for (const ask of run.asks) {
    if (!isRecord(ask)) return invalidResult();
    if (ask.status !== "completed") continue;
    if (isBlank(ask.messageBoundary)) missing.push(String(ask.id));
  }
  if (missing.length > 0) {
    return { ok: false, codes: [AMEND_BOUNDARY_MISSING], detail: { missing } };
  }

  if (opts !== undefined) {
    if (!isRecord(opts)) return invalidResult();
    const targetSession = opts.targetSession;
    if (targetSession !== undefined && targetSession !== null) {
      if (!isRecord(targetSession)) return invalidResult();
      const foreign = foreignHistoryIds(targetSession as TargetSession);
      if (foreign.length > 0) {
        return { ok: false, codes: [AMEND_TARGET_DIRTY], detail: { foreign } };
      }
    }
  }

  return { ok: true, codes: [AMEND_PRECHECK_OK] };
}

/**
 * 目标会话是否只含种子(precheck 与独立调用共用同一判定)。
 * 缺失 / history 空 / 全为种子 → 允许;含外来 id → TARGET_DIRTY 且不允许。
 */
export function seedAllowed(target?: TargetSession | null): AmendResult & { allowed: boolean } {
  if (target === undefined || target === null) {
    return { ok: true, codes: [AMEND_SEED_ALLOWED], allowed: true };
  }
  if (!isRecord(target)) return { ok: false, codes: [AMEND_INVALID], allowed: false };
  const foreign = foreignHistoryIds(target as TargetSession);
  if (foreign.length > 0) {
    return { ok: false, codes: [AMEND_TARGET_DIRTY], allowed: false, detail: { foreign } };
  }
  return { ok: true, codes: [AMEND_SEED_ALLOWED], allowed: true };
}

/**
 * 停前驱:awaitSettlement!==true 直接 SKIP(零副作用,不读不写);
 * 否则 stopped=true,pending=调用时仍 running 的 ask id(按 asks 原顺序)。
 */
export function stopPredecessor(
  run: RunState,
  opts?: { awaitSettlement?: boolean },
): AmendResult & { stopped: boolean; pending: string[] } {
  if (!isRecord(run) || !Array.isArray(run.asks)) {
    return { ok: false, codes: [AMEND_INVALID], stopped: false, pending: [] };
  }
  if (run.exists !== true) {
    return { ok: false, codes: [AMEND_RUN_MISSING], stopped: false, pending: [] };
  }
  // 未要求等结算:不动现场,让调用方决定重试时机。
  if (!isRecord(opts) || opts.awaitSettlement !== true) {
    return { ok: false, codes: [AMEND_SKIP_SETTLEMENT], stopped: false, pending: [] };
  }

  const pending: string[] = [];
  for (const ask of run.asks) {
    if (isRecord(ask) && ask.status === "running" && typeof ask.id === "string") pending.push(ask.id);
  }
  return { ok: true, codes: [AMEND_STOPPED], stopped: true, pending };
}

/**
 * 构建导入缓存:每个 actor 取「最长全 completed 前缀」,遇第一个 running/failed 即止
 * (其后同 actor 的 completed 也不收);worldQueue 深拷贝;门初始未关。
 */
export function buildImportCache(run: RunState): AmendResult & { cache: ImportCache } {
  if (!isRecord(run) || !Array.isArray(run.asks)) {
    return { ok: false, codes: [AMEND_INVALID], cache: emptyImportCache() };
  }
  if (run.exists !== true) {
    return { ok: false, codes: [AMEND_RUN_MISSING], cache: emptyImportCache() };
  }

  const cache = emptyImportCache();
  const broken = new Set<string>();
  for (const ask of run.asks) {
    if (!isRecord(ask)) continue;
    const actor = typeof ask.actor === "string" ? ask.actor : "";
    if (actor.length === 0) continue;
    if (broken.has(actor)) continue;
    if (ask.status !== "completed") {
      broken.add(actor);
      continue;
    }
    const copy: AskRecord = { id: String(ask.id), actor, status: "completed" };
    if (ask.messageBoundary !== undefined) copy.messageBoundary = ask.messageBoundary;
    if (ask.toolCalls !== undefined) copy.toolCalls = ask.toolCalls;
    if (ask.payloadHash !== undefined) copy.payloadHash = ask.payloadHash;
    const bucket = cache.actorPrefix[actor];
    if (bucket === undefined) cache.actorPrefix[actor] = [copy];
    else bucket.push(copy);
  }

  const queue = Array.isArray(run.worldQueue) ? run.worldQueue : [];
  // 深拷贝:缓存与现场各自可改,谁都不许把对方的数组/元素改掉。
  cache.worldQueue = queue.map((entry) => ({ id: entry.id, payloadHash: entry.payloadHash }));

  return { ok: true, codes: [AMEND_CACHE_BUILT], cache };
}

/**
 * 命中判定(纯查表,不建模、不调模型):返回 hit 时 node 就是可直接写入历史的 imported 节点。
 * 顺序:INVALID → 条目缺失(MISS) → 门关且有副作用(DOOR_CLOSED) → hash 不一致(DIVERGED) → HIT。
 */
export function matchImport(
  cache: ImportCache,
  opts: { actor: string; askId: string; payloadHash?: string },
): AmendResult & { hit: boolean; node?: ImportedNode } {
  if (!isRecord(cache)) return { ok: false, codes: [AMEND_INVALID], hit: false };
  const prefix = (cache as { actorPrefix?: unknown }).actorPrefix;
  if (!isRecord(prefix)) return { ok: false, codes: [AMEND_INVALID], hit: false };
  if (!isRecord(opts)) return { ok: false, codes: [AMEND_INVALID], hit: false };
  if (typeof opts.actor !== "string" || typeof opts.askId !== "string") {
    return { ok: false, codes: [AMEND_INVALID], hit: false };
  }

  const bucketRaw = (prefix as Record<string, unknown>)[opts.actor];
  const bucket: unknown[] = Array.isArray(bucketRaw) ? bucketRaw : [];
  const entry = bucket.find(
    (candidate): candidate is AskRecord =>
      isRecord(candidate) && (candidate as { id?: unknown }).id === opts.askId,
  );

  // 门关判定需要条目自身的 toolCalls,所以条目缺失时先按 MISS 收口。
  if (entry === undefined) return { ok: false, codes: [AMEND_MISS], hit: false };

  const toolCalls =
    typeof entry.toolCalls === "number" && Number.isFinite(entry.toolCalls) ? entry.toolCalls : 0;
  const closed = (cache as { closed?: unknown }).closed === true;
  // 关门后,有副作用的条目即便 hash 相同也不导入(重放会二次写世界)。
  if (closed && toolCalls > 0) {
    return { ok: false, codes: [AMEND_DOOR_CLOSED], hit: false, detail: { askId: opts.askId, toolCalls } };
  }

  const entryHash = typeof entry.payloadHash === "string" ? entry.payloadHash : null;
  const wantHash = typeof opts.payloadHash === "string" ? opts.payloadHash : null;
  // 单调不回退:不一致就 DIVERGED,不降级成 MISS,重试仍 DIVERGED。
  if (entryHash !== wantHash) {
    return { ok: false, codes: [AMEND_HASH_DIVERGED], hit: false };
  }

  return {
    ok: true,
    codes: [AMEND_HIT],
    hit: true,
    node: {
      id: entry.id,
      kind: "imported",
      actor: entry.actor,
      messageBoundary: entry.messageBoundary,
      payloadHash: entry.payloadHash,
      toolCalls,
    },
  };
}

/**
 * 门前观察:一旦本次 ask 写过世界(worldToolCalls>0),就地关门且幂等;
 * 0(或负值)不动状态,返回原值与空码表;非有限数折叠 INVALID。
 */
export function closeOnWorldWrite(
  cache: ImportCache,
  opts: { worldToolCalls: number },
): AmendResult & { closed: boolean } {
  if (!isRecord(cache)) return { ok: false, codes: [AMEND_INVALID], closed: false };
  const wasClosed = (cache as { closed?: unknown }).closed === true;
  const raw = isRecord(opts) ? (opts as { worldToolCalls?: unknown }).worldToolCalls : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, codes: [AMEND_INVALID], closed: wasClosed };
  }
  if (raw > 0) {
    (cache as { closed: boolean }).closed = true;
    return { ok: true, codes: [AMEND_DOOR_CLOSED], closed: true };
  }
  return { ok: true, codes: [], closed: wasClosed };
}

/** 续跑模式:缓存可用 → 走 cache(不重算);否则回退 live(照着盘上现场重建)。 */
export function resumeRebuild(opts: { cacheOk: boolean }): AmendResult & { mode: "cache" | "live" } {
  if (!isRecord(opts)) return { ok: false, codes: [AMEND_INVALID], mode: "live" };
  if (opts.cacheOk === true) {
    return { ok: true, codes: [AMEND_CACHE_BUILT], mode: "cache" };
  }
  return { ok: false, codes: [AMEND_FALLBACK_LIVE], mode: "live" };
}
