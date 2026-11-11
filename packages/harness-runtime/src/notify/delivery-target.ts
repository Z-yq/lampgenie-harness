/**
 * 投递目标归属与能力协商(纯逻辑零 IO)。
 * 为什么需要「归属证明」:投递是把内容送到某个目标(home / directory / session / thread)。
 * 只有从**已证实来源**得到的目标(本机 home、成员目录条目、会话来源、以及单独确认过的
 * thread)才是真目标;名字看着对但没证据的目标一旦被写进离线队列,就会在补发时把内容送往
 * 不该去的地方,且事后无法分辨是哪次投递造成的。所以未证实目标必须在发送前拒收,并且
 * **不落离线队列**(落队列等于把未证实结论持久化)。
 * 为什么 thread 要单独 attestation:thread 的 id 只在某个父目标(会话/房间)内唯一,
 * 不同父目标下可能撞同一个 threadId。仅凭「父目标可证实」推不出「这个 thread 属于它」,
 * 所以 thread 需要两条证据同时成立:①父目标本身可证实;②该 threadId 有一条绑定了本目标
 * id 的单独 attestation(attestedId)。缺任一条都不得投递。
 * 为什么 decline 不能降级成 queued 成功:decline 是**对端明确给出的终态答复**(不接收/
 * 已拉黑/整聊已退出)。把它洗成 queued 会让调用方以为「稍后会送到」,于是重试与记账都基于
 * 假前提,还会把内容长期滞留在队列里反复重放。终态就是终态:标死、不可重试、不入队。
 * 契约:纯函数 + 不可变(返回值冻结)+ 确定性(不读时钟/随机数)+ 不 throw(内部兜底)。
 */

/** 投递结果码封闭集合(唯一权威;新增码必须同时补判定分支与测试)。 */
export const DELIVERY_CODES = [
  "OK",
  "NOT_ATTESTED",
  "THREAD_NOT_ATTESTED",
  "DEAD_TARGET",
  "DECLINED",
  "LEGACY",
  "UNSUPPORTED_OP",
] as const;

export type DeliveryCode = (typeof DELIVERY_CODES)[number];

/** legacy 对端的 supported_ops 全集(缺 supported_ops 时按它协商)。 */
export const LEGACY_OPS = ["ping", "presence", "message", "inbox", "relay", "queue"] as const;

/** 死目标表容量上限(超出按 LRU 淘汰;死表是加速缓存,不是持久账本)。 */
export const DEAD_TARGET_CAPACITY = 500;

/** 只有整聊级死亡才可标死;单条消息失败/超时是暂时态,不能永久拒收目标。 */
export const WHOLE_CHAT_DEATH_MARKERS = ["whole-chat", "kicked", "deleted"] as const;

// ---------------------------------------------------------------------------
// 一、目标归属证实
// ---------------------------------------------------------------------------

export type DeliveryTargetKind = "home" | "directory" | "session" | "thread";

export interface DeliveryTarget {
  kind: DeliveryTargetKind;
  id: string;
 /** thread 目标必填:线程 id(只在父目标内唯一,需单独 attestation)。 */
  threadId?: string;
}

export interface ThreadAttestation {
 /** 这条 thread attestation 绑定的目标 id(即 thread 的父目标)。 */
  attestedId: string;
}

/** 已证实来源集合(Set 或数组都可;undefined=该来源没有证据)。 */
export type IdCollection = ReadonlySet<string> | readonly string[];

export interface AttestContext {
  homeIds?: IdCollection;
  directoryIds?: IdCollection;
  sessionOriginIds?: IdCollection;
  threadAttestations?: ReadonlyMap<string, ThreadAttestation>;
}

export interface AttestResult {
  ok: boolean;
  code: DeliveryCode;
}

const ATTEST_OK: AttestResult = Object.freeze({ ok: true, code: "OK" as DeliveryCode });
const NOT_ATTESTED: AttestResult = Object.freeze({ ok: false, code: "NOT_ATTESTED" as DeliveryCode });
const THREAD_NOT_ATTESTED: AttestResult = Object.freeze({ ok: false, code: "THREAD_NOT_ATTESTED" as DeliveryCode });

function hasId(coll: IdCollection | undefined, id: string): boolean {
  if (!coll) return false;
 // Set 与数组两种形态都要支持(调用方可能只有数组);Array.isArray 对 Set 为 false。
  if (Array.isArray(coll)) return (coll as readonly string[]).includes(id);
  return (coll as ReadonlySet<string>).has(id);
}

/**
 * 判定投递目标是否「已证实来源」。
 * - home / directory / session:必须命中各自集合;
 * - thread:父目标(kind 基础集合命中)已证实 + threadId 有绑定本目标 id 的单独 attestation;
 * - 任何结构不完整/未知 kind → NOT_ATTESTED(fail-closed,不 throw)。
 */
export function attestDeliveryTarget(target: DeliveryTarget | null | undefined, ctx: AttestContext = {}): AttestResult {
  if (!target || typeof target !== "object") return NOT_ATTESTED;
  const rawId = (target as { id?: unknown }).id;
  if (typeof rawId !== "string" || rawId.length === 0) return NOT_ATTESTED;
  const id = rawId;
  const kind = (target as { kind?: unknown }).kind;

  switch (kind) {
    case "home":
      return hasId(ctx.homeIds, id) ? ATTEST_OK : NOT_ATTESTED;
    case "directory":
      return hasId(ctx.directoryIds, id) ? ATTEST_OK : NOT_ATTESTED;
    case "session":
      return hasId(ctx.sessionOriginIds, id) ? ATTEST_OK : NOT_ATTESTED;
    case "thread": {
 // ① 父目标必须已证实(线程不能凭空存在)。
      const parentAttested =
        hasId(ctx.homeIds, id) || hasId(ctx.directoryIds, id) || hasId(ctx.sessionOriginIds, id);
      if (!parentAttested) return THREAD_NOT_ATTESTED;
 // ② threadId 必须有单独 attestation,且该 attestation 绑定的是本目标 id。
      const threadId = (target as { threadId?: unknown }).threadId;
      if (typeof threadId !== "string" || threadId.length === 0) return THREAD_NOT_ATTESTED;
      const att = ctx.threadAttestations?.get(threadId);
      if (!att || att.attestedId !== id) return THREAD_NOT_ATTESTED;
      return ATTEST_OK;
    }
    default:
      return NOT_ATTESTED;
  }
}

// ---------------------------------------------------------------------------
// 二、死目标表(整聊级死亡缓存)
// ---------------------------------------------------------------------------

export interface DeadTargetInfo {
 /** 死亡原因(必须含 whole-chat/kicked/deleted 之一才可标死)。 */
  reason: string;
 /** 标死时刻(调用方给的时钟值;本模块不读时钟)。 */
  at: number;
}

export interface DeadTargetStats {
  size: number;
  capacity: number;
  entries: readonly { targetId: string; reason: string; at: number }[];
}

/**
 * 死目标表:只记「整聊已死」的目标,任何一次成功投递都必须 clear。
 * 为什么有 reason 门:超时/单条拒收/网络抖动都是暂时态,把它们标死会让目标被永久短路,
 * 再也没有恢复机会。因此只接受整聊级死亡证据(whole-chat/kicked/deleted)。
 * 容量上限 + LRU:死表是加速缓存,淘汰最久未用条目即可(误判死的代价由「成功即 clear」兜回)。
 */
export class DeadTargetTable {
  private readonly entries = new Map<string, Readonly<DeadTargetInfo>>();
  private readonly capacity: number;

  constructor(capacity: number = DEAD_TARGET_CAPACITY) {
    this.capacity = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : DEAD_TARGET_CAPACITY;
  }

 /** 标死;reason 不含整聊死亡标记时返回 false 且不写入(暂时态不标死)。 */
  markDead(targetId: string, info: DeadTargetInfo): boolean {
    if (typeof targetId !== "string" || targetId.length === 0) return false;
    if (!info || typeof info !== "object") return false;
    const reason = typeof info.reason === "string" ? info.reason : "";
    const lower = reason.toLowerCase();
    if (!WHOLE_CHAT_DEATH_MARKERS.some((m) => lower.includes(m))) return false;

 // 重标:先删再插,保证 Map 插入序即 LRU 序。
    if (this.entries.has(targetId)) this.entries.delete(targetId);
    else if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest === "string") this.entries.delete(oldest);
    }
    const at = typeof info.at === "number" && Number.isFinite(info.at) ? info.at : 0;
    this.entries.set(targetId, Object.freeze({ reason, at }));
    return true;
  }

 /** 是否已死(命中即 touch,维持 LRU 序)。 */
  isDead(targetId: string): boolean {
    const hit = this.entries.get(targetId);
    if (!hit) return false;
    this.entries.delete(targetId);
    this.entries.set(targetId, hit);
    return true;
  }

 /** 任何成功投递都应清除(成功证明目标未死,缓存必须让位给事实)。 */
  clear(targetId: string): boolean {
    return this.entries.delete(targetId);
  }

  get size(): number {
    return this.entries.size;
  }

  stats(): DeadTargetStats {
    const entries = [...this.entries.entries()].map(([targetId, v]) => Object.freeze({ targetId, reason: v.reason, at: v.at }));
    return Object.freeze({ size: entries.length, capacity: this.capacity, entries: Object.freeze(entries) });
  }
}

// ---------------------------------------------------------------------------
// 三、descriptor 能力协商
// ---------------------------------------------------------------------------

/** 当前实现的协商契约版本(对端版本只用于按交集收窄,不是硬拒绝条件)。 */
export const CONTRACT_VERSION = 1;

const KNOWN_DESCRIPTOR_KEYS = ["contract_version", "supported_ops", "decline"] as const;

export interface NegotiateOptions {
 /** 本次投递必需的操作;缺省=不设门槛。 */
  requiredOps?: readonly string[];
}

export interface NegotiateResult {
  ok: boolean;
  code: DeliveryCode;
  ops: readonly string[];
 /** 被丢弃的未知键(含非法 contract_version);排序无关紧要,按输入键序稳定产出。 */
  droppedKeys: readonly string[];
 /** 对端声明的契约版本(只接受数字;缺省=未声明)。 */
  version?: number;
}

/**
 * 协商对端 descriptor。
 * - decline=true 是明确拒收:直接 DECLINED,ok=false(优先于一切能力判断);
 * - supported_ops 缺失 = 老对端:按 LEGACY 全集放行(requiredOps 全部视为支持),code=LEGACY;
 * - contract_version 只接受数字:非数字不接受(计入 droppedKeys);
 * 低版本 → 仍可用;未知高版本 → 不猜新语义,只按 known ops 与 requiredOps 求交集判定;
 * - 未知键丢弃并计入 droppedKeys(不做透传,避免把对端私有字段带进协议)。
 */
export function negotiateDescriptor(descriptor: unknown, opts: NegotiateOptions = {}): NegotiateResult {
  const requiredOps = Array.isArray(opts.requiredOps) ? opts.requiredOps.filter((o): o is string => typeof o === "string") : [];
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    return Object.freeze({ ok: false, code: "UNSUPPORTED_OP" as DeliveryCode, ops: Object.freeze([] as string[]), droppedKeys: Object.freeze([] as string[]) });
  }
  const raw = descriptor as Record<string, unknown>;

 // 未知键盘点(同时把非法 contract_version 记为丢弃)。
  const droppedKeys: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!(KNOWN_DESCRIPTOR_KEYS as readonly string[]).includes(key)) droppedKeys.push(key);
  }
  let version: number | null = null;
  if ("contract_version" in raw) {
    const v = raw.contract_version;
    if (typeof v === "number" && Number.isFinite(v)) version = v;
    else droppedKeys.push("contract_version");
  }

  if (raw.decline === true) {
    return Object.freeze({ ok: false, code: "DECLINED" as DeliveryCode, ops: Object.freeze([] as string[]), droppedKeys: Object.freeze(droppedKeys) });
  }

  const supportedRaw = raw.supported_ops;
  if (!Array.isArray(supportedRaw)) {
 // 老对端:legacy 全集;requiredOps 全部视为支持(除非要求了 legacy 之外的操作)。
    const ops = Object.freeze([...LEGACY_OPS] as string[]);
    const covered = requiredOps.every((op) => (LEGACY_OPS as readonly string[]).includes(op));
    return Object.freeze({
      ok: covered,
      code: (covered ? "LEGACY" : "UNSUPPORTED_OP") as DeliveryCode,
      ops,
      droppedKeys: Object.freeze(droppedKeys),
    });
  }

  const ops: string[] = [];
  for (const op of supportedRaw) {
    if (typeof op === "string" && op.length > 0 && !ops.includes(op)) ops.push(op);
  }
 // 未知高版本不新增语义,只按交集判定:requiredOps 是否都被对端覆盖(低版本同样等价可用)。
  const covered = requiredOps.every((op) => ops.includes(op));
  return Object.freeze({
    ok: covered,
    code: (covered ? "OK" : "UNSUPPORTED_OP") as DeliveryCode,
    ops: Object.freeze(ops),
    droppedKeys: Object.freeze(droppedKeys),
    ...(version === null ? {} : { version }),
  });
}

// ---------------------------------------------------------------------------
// 四、发送帧与结果分类
// ---------------------------------------------------------------------------

export interface SendFrameInput {
  targetId: string;
  text: string;
 /** 中间态帧(流式中的片段);与 final 互斥。 */
  interim?: boolean;
 /** 终态帧;自带 finish 标记。 */
  final?: boolean;
}

export interface DeliveryFrame {
  target: { id: string };
  text: string;
 /** 终态帧才有(对端据此收尾,不必再等)。 */
  finish?: boolean;
}

export type SendFrameResult =
  | { frame: DeliveryFrame; code: "OK"; markers: { interim: boolean; final: boolean } }
  | { frame: null; code: "INVALID"; markers: { interim: boolean; final: boolean } };

/**
 * 构造发送帧。interim 与 final 同时为 true 是自相矛盾的标记(既「还没完」又「完了」),
 * 对端无法判定该不该收尾,因此直接判 INVALID 且不产出帧(不 throw,调用方按 code 处理)。
 */
export function sendFrame(input: SendFrameInput | null | undefined): SendFrameResult {
  const interim = input?.interim === true;
  const final = input?.final === true;
  const markers = Object.freeze({ interim, final });
  const targetId = input?.targetId;
  const text = input?.text;
  const invalid = (): SendFrameResult => Object.freeze({ frame: null, code: "INVALID" as const, markers });
  if (interim && final) return invalid();
  if (typeof targetId !== "string" || targetId.length === 0) return invalid();
  if (typeof text !== "string") return invalid();
  const frame: DeliveryFrame = Object.freeze({ target: Object.freeze({ id: targetId }), text, ...(final ? { finish: true } : {}) });
  return Object.freeze({ frame, code: "OK" as const, markers });
}

export interface SendResultInput {
  ok: boolean;
 /** 对端明确拒收(终态)。 */
  declined?: boolean;
 /** 整聊已死(对端不存在/已退出)。 */
  deadChat?: boolean;
}

export interface SendClassification {
  retryable: boolean;
  markDead: boolean;
 /** 成功即清除死目标(成功是「未死」的最新事实,缓存必须让位)。 */
  clearDead: boolean;
  code: DeliveryCode | "TRANSIENT";
}

/**
 * 分类一次投递结果。
 * - ok:不重试、不标死、清除死表;
 * - declined / deadChat:终态 —— 不可重试且标死(decline 绝不能被洗成「稍后重发」);
 * - 其余(超时/网络):可重试、不标死(暂时态不能永久拒收目标)。
 */
export function classifySendResult(result: SendResultInput | null | undefined): SendClassification {
  const ok = result?.ok === true;
  if (ok) return Object.freeze({ retryable: false, markDead: false, clearDead: true, code: "OK" as DeliveryCode });
  if (result?.declined === true) {
    return Object.freeze({ retryable: false, markDead: true, clearDead: false, code: "DECLINED" as DeliveryCode });
  }
  if (result?.deadChat === true) {
    return Object.freeze({ retryable: false, markDead: true, clearDead: false, code: "DEAD_TARGET" as DeliveryCode });
  }
  return Object.freeze({ retryable: true, markDead: false, clearDead: false, code: "TRANSIENT" as const });
}
