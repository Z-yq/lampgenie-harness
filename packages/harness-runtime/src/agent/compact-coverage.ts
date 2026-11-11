/**
 * 压缩覆盖证明(纯逻辑,零 IO、无 throw、不可变、确定性)。
 * 解决的问题:压缩是对「某一时刻 head」的**删除式替代**——compact.done 一旦落账,边界之前
 * 的事实就被摘要取代、永不回放。所以提交边界前必须能回答两个问题:
 * ① 这份摘要到底覆盖了哪些事实?(覆盖证明)
 * ② 摘要期间有没有新的事实追加上来?(并发追加 → 本次作废)
 * 为什么证明必须绑定 **seq 与 digest 双条件**:
 * - 只绑 seq:seq 是「位置」不是「内容」。journal 存在双写去重、重启后 seq 重排、跨进程水位
 * 漂移(ProxyJournal 本地 append 用 replica.length,种子/推送事件用全局 seq)等情形,
 * 同一 seq 可能指向不同事实,只看 seq 无法证明中间没有换过/漏过事件。
 * - 只绑 digest:digest 能证明「这段内容的指纹」,但说不出边界在哪、哪些是新追加的——无法
 * 给「seq > watermark 即并发追加」提供右界。
 * - 两者一起:seq 给出「覆盖到哪」的右界(去重与追加判定的锚),digest 给出「覆盖了哪些内容」
 * 的指纹(事后可比对、可复现)。缺任一条,证明都能被合法地伪造出「覆盖完整」的假象。
 * 为什么并发追加必须让本次压缩作废:摘要里没有原文,边界提交后,watermark 之后新到的用户
 * 消息会被当作「已被摘要覆盖」而永不回放——丢的是用户原话,且不可恢复。宁可白压一次
 * (compact.abandoned,历史保持不变),也不能把新事实吃掉。
 */

import { createHash } from "node:crypto";

/** 覆盖判定的取值域(compact.done.coverageCode / compact.abandoned.code 共用)。 */
export const COMPACT_COVERAGE_CODES = ["OK", "COVERAGE_GAP", "CONCURRENT_APPEND", "STALE_GENERATION", "INVALID"] as const;

export type CompactCoverageCode = (typeof COMPACT_COVERAGE_CODES)[number];

/** 可压缩事实事件(改变会话内容、会被摘要遮蔽的那几类)。
 * 刻意不含 step.start / llm.trace / tool.call / compact.* 等观测与过程事件:它们不进上下文,
 * 把它们算进覆盖,会让「并发追加」在纯遥测写入时误判,压缩会被无意义地反复作废。 */
const FACT_KINDS = new Set<string>(["message.user", "message.agent", "message.system", "tool.result"]);

/** 覆盖计算只需要事件的最小投影面(不依赖 core 的 JournalEvent 全量类型)。 */
export interface CoverageEventLike {
  seq?: number;
  kind?: string;
  sessionId?: string;
  payload?: unknown;
}

export interface CoverageCounts {
 /** message.user + message.agent(对话正文)。 */
  messages: number;
 /** tool.result(工具结果)。 */
  toolResults: number;
 /** message.system(注入的系统消息)。 */
  system: number;
}

export interface CoverageWatermark {
  sessionId: string;
 /** 覆盖右界:被覆盖事实里的最大 seq;无被覆盖事实时等于 lastCompactSeq(缺省 0)。 */
  watermarkSeq: number;
 /** 被覆盖事实的事件 id,形态 `e:<seq>`,按 seq 升序。 */
  coveredIds: string[];
 /** sha256(coveredIds.join(",")).slice(0,16);空集 = sha256("") 的前 16 位。 */
  digest: string;
  counts: CoverageCounts;
}

export interface CoverageWatermarkOptions {
 /** 上一轮压缩的覆盖右界(通常取上一条 compact.done.coveredWatermark);缺省 0。 */
  lastCompactSeq?: number;
 /** 只取最新的 N 条事实(大 journal 上 watermark 体量有界);缺省不限。 */
  maxEvents?: number;
}

export interface CoverageVerification {
  code: CompactCoverageCode;
 /** 右界之后新落的权威事实 id(排序去重)。 */
  appendedIds: string[];
 /** watermark 声称覆盖、但当前事实面里读不到的 id(排序去重)。 */
  missingIds: string[];
}

export interface CommitDecision {
  commit: boolean;
  code: CompactCoverageCode;
}

/** compact.done 的覆盖证明(字段序固定,便于逐字比对与落账)。 */
export interface CoverageProof {
  coveredWatermark: number;
  coveredIds: string[];
  count: number;
  digest: string;
  code: CompactCoverageCode;
}

export interface CommitDecisionInput {
  generationAtStart?: number;
  generationNow?: number;
  coverage?: CoverageVerification;
}

/** 事件 id 的唯一定义处(单点派生,避免写入侧与读取侧各写一套格式)。 */
export function coverageEventId(seq: number): string {
  return `e:${seq}`;
}

/** 覆盖指纹:sha256(ids.join(",")) 前 16 位。空集也有确定指纹(sha256(""))。 */
export function coverageDigestOf(ids: readonly string[]): string {
  const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  return createHash("sha256").update(list.join(","), "utf8").digest("hex").slice(0, 16);
}

/** 安全取事件 seq(非有限数/缺失一律视为不可定位,不参与覆盖)。 */
function seqOf(event: CoverageEventLike | null | undefined): number | undefined {
  if (!event || typeof event !== "object") return undefined;
  const seq = event.seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : undefined;
}

/** 是否本会话的可压缩事实(两个条件缺一不可:跨会话事件带全局 seq,不能混进本会话 watermark)。 */
function isFactOf(event: CoverageEventLike | null | undefined, sessionId: string): boolean {
  if (!event || typeof event !== "object") return false;
  if (String(event.sessionId ?? "") !== sessionId) return false;
  return FACT_KINDS.has(String(event.kind ?? ""));
}

function sortUniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
 // 按 id 里的数值 seq 升序(字符串序会把 e:10 排到 e:9 前面,证明不可逐字复现)。
  return out.sort((a, b) => {
    const na = Number(a.slice(2));
    const nb = Number(b.slice(2));
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * 取覆盖 watermark:把「本次压缩能看到的事实面」压成 {右界 seq, 覆盖 id 集, 指纹}。
 * - 只收 seq > lastCompactSeq 且 sessionId 匹配的四类事实(上一轮压缩已覆盖的段落不重复入集,
 * 否则多轮压缩的证明会一轮比一轮大,digest 也失去「本轮新增覆盖」的语义);
 * - maxEvents 从**最新的 N 条**里取:覆盖证明关心的是「边界附近」的事实,截头保尾才能保证
 * 右界(watermarkSeq)始终落在真实的最大 seq 上;
 * - 空集不算错误:压缩前事实面可能已被上一轮覆盖完(例如只剩遥测事件),此时右界停在
 * lastCompactSeq,digest 是空集指纹——证明「这一轮没有新增可覆盖事实」也是合法结论。
 * - 缺省 floor=0 意味着真实 journal 的 seq 0 事件(第一条)视为「已覆盖基线」不入集;这是
 * 「上一轮边界」的语义缺省值,不构成覆盖缺口(右界仍以真实最大 seq 为准)。
 */
export function computeWatermark(
  events: readonly CoverageEventLike[] | undefined,
  sessionId: string,
  options: CoverageWatermarkOptions = {},
): CoverageWatermark {
  const rawFloor = options?.lastCompactSeq;
  const floor = typeof rawFloor === "number" && Number.isFinite(rawFloor) ? Math.max(0, Math.trunc(rawFloor)) : 0;
  const rawMax = options?.maxEvents;
  const limit = typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0 ? Math.trunc(rawMax) : 0;

  const rows: { seq: number; kind: string }[] = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!isFactOf(event, sessionId)) continue;
    const seq = seqOf(event);
    if (seq === undefined || seq <= floor) continue;
    rows.push({ seq, kind: String(event!.kind) });
  }
  rows.sort((a, b) => a.seq - b.seq);
 // 同 seq 双写(重启/双进程独立计数器)只算一次:证明必须按「事实」计数,不能按「行」计数。
  const unique: { seq: number; kind: string }[] = [];
  for (const row of rows) {
    if (unique.length > 0 && unique[unique.length - 1]!.seq === row.seq) continue;
    unique.push(row);
  }
  const kept = limit > 0 && unique.length > limit ? unique.slice(unique.length - limit) : unique;

  const coveredIds = kept.map((row) => coverageEventId(row.seq));
  const counts: CoverageCounts = { messages: 0, toolResults: 0, system: 0 };
  for (const row of kept) {
    if (row.kind === "tool.result") counts.toolResults += 1;
    else if (row.kind === "message.system") counts.system += 1;
    else counts.messages += 1;
  }
  const watermarkSeq = kept.length > 0 ? kept[kept.length - 1]!.seq : floor;
  return {
    sessionId: String(sessionId ?? ""),
    watermarkSeq,
    coveredIds,
    digest: coverageDigestOf(coveredIds),
    counts,
  };
}

/**
 * 提交前验证覆盖:右界之后是否出现新的权威事实 / watermark 声称覆盖的事实是否还在。
 * `eventsAfter` 传**当前全量事实面**(不是只过滤后的切片):新增判定由函数内按
 * `seq > watermarkSeq` 切(与 `journal.readAll.filter(seq > watermarkSeq)` 同口径),
 * 而 COVERAGE_GAP 需要覆盖段仍在场才能判——只传切片会把整段覆盖误判成缺口。
 * 判定优先级:INVALID(水位结构坏,连比较都不成立)> CONCURRENT_APPEND(有新事实,
 * 本次摘要必然过期)> COVERAGE_GAP(证明不可复核)> OK。
 */
export function verifyCoverage(
  watermark: CoverageWatermark | null | undefined,
  eventsAfter: readonly CoverageEventLike[] | undefined,
  sessionId: string): CoverageVerification {
  const invalid: CoverageVerification = { code: "INVALID", appendedIds: [], missingIds: [] };
  if (!watermark || typeof watermark !== "object") return invalid;
  const watermarkSeq = (watermark as { watermarkSeq?: unknown }).watermarkSeq;
  if (typeof watermarkSeq !== "number" || !Number.isFinite(watermarkSeq) || watermarkSeq < 0) return invalid;
  const claimed = (watermark as { coveredIds?: unknown }).coveredIds;
  if (!Array.isArray(claimed) || claimed.some((id) => typeof id !== "string")) return invalid;

  const presentIds = new Set<string>();
  const appended: string[] = [];
  for (const event of Array.isArray(eventsAfter) ? eventsAfter : []) {
    if (!isFactOf(event, sessionId)) continue;
    const seq = seqOf(event);
    if (seq === undefined) continue;
    const id = coverageEventId(seq);
    presentIds.add(id);
    if (seq > watermarkSeq) appended.push(id);
  }
  const appendedIds = sortUniqueIds(appended);
  const missingIds = sortUniqueIds((claimed as string[]).filter((id) => !presentIds.has(id)));
  if (appendedIds.length > 0) return { code: "CONCURRENT_APPEND", appendedIds, missingIds };
  if (missingIds.length > 0) return { code: "COVERAGE_GAP", appendedIds, missingIds };
  return { code: "OK", appendedIds: [], missingIds: [] };
}

/**
 * 提交判定的双条件:代际未变 **且** 覆盖证明通过。
 * 代际用「表面事实计数」而不是全量事件计数:纯遥测事件(llm.trace/step.start)在摘要期间
 * 新增并不改变会话内容,按全量计数会把正常压缩判成过期(压缩被无意义地放弃)。
 */
export function commitDecision(input: CommitDecisionInput | null | undefined): CommitDecision {
  const start = input?.generationAtStart;
  const now = input?.generationNow;
  if (typeof start !== "number" || !Number.isFinite(start) || typeof now !== "number" || !Number.isFinite(now)) {
    return { commit: false, code: "INVALID" };
  }
  if (start !== now) return { commit: false, code: "STALE_GENERATION" };
  const code = input?.coverage?.code;
  if (code === "OK") return { commit: true, code: "OK" };
 // 缺证明 = 没证明不准提交(保守 fail-closed;空 coverage 不能当 OK 用)。
  if (code === "CONCURRENT_APPEND" || code === "COVERAGE_GAP" || code === "INVALID" || code === "STALE_GENERATION") {
    return { commit: false, code };
  }
  return { commit: false, code: "COVERAGE_GAP" };
}

/** compact.done 的覆盖证明:字段序固定(写入侧与消费侧都按这个序读),id 集只拷贝不改入参。 */
export function coverageProof(
  watermark: CoverageWatermark | null | undefined,
  decision: CommitDecision | null | undefined): CoverageProof {
  const ids = Array.isArray(watermark?.coveredIds) ? sortUniqueIds(watermark!.coveredIds) : [];
  const rawSeq = watermark?.watermarkSeq;
  const coveredWatermark = typeof rawSeq === "number" && Number.isFinite(rawSeq) ? rawSeq : 0;
  const digest = typeof watermark?.digest === "string" && watermark.digest !== "" ? watermark.digest : coverageDigestOf(ids);
  const code = decision?.code;
  const safeCode: CompactCoverageCode =
    code === "OK" || code === "CONCURRENT_APPEND" || code === "COVERAGE_GAP" || code === "STALE_GENERATION" ? code : "INVALID";
  return { coveredWatermark, coveredIds: ids, count: ids.length, digest, code: safeCode };
}

/**
 * 多轮压缩的覆盖证明累计:只保留最近 3 轮,每轮 id 去重排序。
 * 为什么保留轮次快照而不是并集:每轮的 watermarkSeq 与 digest 是绑定关系,把多轮 id 并成
 * 一个集合会让 digest 与任何一个 watermarkSeq 都对不上(证明自相矛盾)。
 * 同一轮(同 coveredWatermark + 同 digest)重复提交按「更新」处理,不重复入列。
 */
export function mergeCoveredProofs(
  previous: readonly CoverageProof[] | undefined,
  next: CoverageProof | null | undefined,
  maxRounds = 3): CoverageProof[] {
  const cap = typeof maxRounds === "number" && Number.isFinite(maxRounds) && maxRounds > 0 ? Math.trunc(maxRounds) : 3;
  const normalize = (proof: CoverageProof): CoverageProof => {
    const ids = Array.isArray(proof?.coveredIds) ? sortUniqueIds(proof.coveredIds) : [];
    const rawSeq = proof?.coveredWatermark;
    const coveredWatermark = typeof rawSeq === "number" && Number.isFinite(rawSeq) ? rawSeq : 0;
    const digest = typeof proof?.digest === "string" && proof.digest !== "" ? proof.digest : coverageDigestOf(ids);
    const code = proof?.code;
    const safeCode: CompactCoverageCode =
      code === "OK" || code === "CONCURRENT_APPEND" || code === "COVERAGE_GAP" || code === "STALE_GENERATION" ? code : "INVALID";
    return { coveredWatermark, coveredIds: ids, count: ids.length, digest, code: safeCode };
  };

  const rounds: CoverageProof[] = [];
  for (const proof of Array.isArray(previous) ? previous : []) {
    if (!proof || typeof proof !== "object") continue;
    rounds.push(normalize(proof));
  }
  if (next && typeof next === "object") {
    const merged = normalize(next);
    const same = rounds.findIndex((p) => p.coveredWatermark === merged.coveredWatermark && p.digest === merged.digest);
    if (same >= 0) rounds[same] = merged;
    else rounds.push(merged);
  }
  return rounds.slice(Math.max(0, rounds.length - cap));
}
