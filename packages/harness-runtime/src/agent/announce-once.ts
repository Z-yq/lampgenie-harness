import { createHash } from "node:crypto";

/**  动态上下文公告「只公告一次」的纯逻辑(零 IO、不 throw、不可变、确定性)。
 * 问题:动态上下文公告(系统节增量、工具激活、模型切换、配置变更)是 **ephemeral 注入**——
 * 只拼进本次请求、不落历史,于是每轮都得重算/重投;同一份内容在几十步里反复出现,
 * 既烧 uncached token,也让模型看到重复噪声。判定「是否需要再公告」不能靠易失内存
 * (gateway 每任务新建 AgentLoop,字段会被重置),必须以 **canonical history 的最后一条公告** 为判据。
 * **为什么压缩边界是公告生命的重置点**:真压缩(compact.done 且带 summary)会重建 canonical
 * history——边界之前的消息被摘要取代、原公告已不在模型看得到的上下文里。若仍按「已公告过」
 * 跳过,模型就再也看不到这条公告(静默失忆,比多花 token 严重得多)。所以只有 **seq 大于最后
 * 一次真压缩边界** 的公告才算「现在还看得见」;边界之后没有公告 = 允许再公告一次。
 * 无摘要的旧 compact.done(microcompact 占位)不重建历史,不构成重置点。
 */

/** 允许的公告种类;未知 kind 一律判 INVALID(不抛错,让调用方安全跳过)。 */
export const ANNOUNCE_KINDS = [
  "system-section-update",
  "tool-activation",
  "model-switch",
  "config-change",
] as const;

export type AnnounceKind = (typeof ANNOUNCE_KINDS)[number];

/** 非法输入(key 派生失败)统一返回的哨兵值。 */
export const INVALID = "INVALID";

/** journal 侧公告的 payload.type 标记(与 loop 的 custom 事件约定一致)。 */
export const ANNOUNCE_TYPE = "runtime.announce";

/** 公告事件只需要的最小结构(journal 事件的结构子集,便于纯函数测试)。 */
export interface AnnounceEventLike {
  seq: number;
  kind: string;
  sessionId?: string;
  payload?: unknown;
}

/** canonical history 里最后一条仍可见的公告。 */
export interface LastAnnounce {
  at: number;
  seq: number;
  key: string;
}

export type AnnounceReason = "first" | "after-compact" | "already-announced" | "forced";

export interface ShouldAnnounceInput {
  events: readonly AnnounceEventLike[];
  sessionId: string;
  kind: string;
 /** 公告内容的指纹(调用方自行计算,通常是 delta 文本的 sha256)。 */
  payloadHash: string;
 /** 强制公告(如人工触发/一次性唤醒);仍返回 key 供落账。 */
  force?: boolean;
}

export interface ShouldAnnounceResult {
  ok: boolean;
  announce: boolean;
  key: string;
  reason: AnnounceReason | "invalid-kind" | "invalid-payload";
}

export interface AnnouncementInput {
  kind: string;
  key: string;
  at: number;
  summary?: string;
}

/** 稳定 custom 事件结构(字段顺序固定,便于审计与 diff)。 */
export interface AnnounceCustomEvent {
  kind: "custom";
  payload: {
    type: typeof ANNOUNCE_TYPE;
    announceKind: string;
    key: string;
    at: number;
    summary?: string;
  };
}

function isAnnounceKind(kind: unknown): kind is AnnounceKind {
  return typeof kind === "string" && (ANNOUNCE_KINDS as readonly string[]).includes(kind);
}

/** 内容指纹(sha256 hex)。导出给调用方算 payloadHash,避免各模块各写一份 crypto 逻辑。 */
export function stableHash(text: string): string {
  return createHash("sha256").update(typeof text === "string" ? text : String(text)).digest("hex");
}

/** `${kind}:${sha256(payloadHash).slice(0,16)}`;未知 kind 或空 payloadHash → INVALID(不抛)。 */
export function announceKeyOf(kind: string, payloadHash: string): string {
  if (!isAnnounceKind(kind)) return INVALID;
  if (typeof payloadHash !== "string" || payloadHash.length === 0) return INVALID;
  return `${kind}:${stableHash(payloadHash).slice(0, 16)}`;
}

/** 最后一次**真压缩**边界的 seq(只认带非空 summary 的 compact.done;无=0)。
 * 判据与 loop 的 readSystemDeltaState/deriveMessages 逐字一致。 */
export function hardCompactSeqOf(events: readonly AnnounceEventLike[], sessionId: string): number {
  let boundary = 0;
  for (const e of events) {
    if (e?.kind !== "compact.done") continue;
    if (typeof e.sessionId === "string" && e.sessionId !== sessionId) continue;
    const summary = (e.payload as { summary?: unknown } | undefined)?.summary;
    if (typeof summary === "string" && summary.trim().length > 0) {
      if (Number.isFinite(e.seq) && e.seq > boundary) boundary = e.seq;
    }
  }
  return boundary;
}

/** canonical history 中该 key 的最后一条公告(仅认 seq > 最后一次真压缩边界);无 → null。 */
export function lastAnnounceOf(
  events: readonly AnnounceEventLike[],
  sessionId: string,
  key: string): LastAnnounce | null {
  if (typeof key !== "string" || key.length === 0 || key === INVALID) return null;
  const boundary = hardCompactSeqOf(events, sessionId);
  let found: LastAnnounce | null = null;
  for (const e of events) {
    if (!Number.isFinite(e?.seq) || e.seq <= boundary) continue;
    if (e.kind !== "custom") continue;
    if (typeof e.sessionId === "string" && e.sessionId !== sessionId) continue;
    const p = e.payload as { type?: unknown; key?: unknown; at?: unknown } | undefined;
    if (p?.type !== ANNOUNCE_TYPE || p.key !== key) continue;
    found = { at: typeof p.at === "number" && Number.isFinite(p.at) ? p.at : 0, seq: e.seq, key };
  }
  return found;
}

/** 该 key 是否曾在**任何位置**公告过(含已被压缩边界抹掉的历史公告)。
 * 用于区分 first / after-compact:lastAnnounceOf 只认边界之后,故它返回 null 时
 * 「历史上从没公告过」与「公告过但已被压缩抹掉」需要靠它分开。 */
function anyAnnounceOf(events: readonly AnnounceEventLike[], sessionId: string, key: string): boolean {
  for (const e of events) {
    if (e?.kind !== "custom") continue;
    if (typeof e.sessionId === "string" && e.sessionId !== sessionId) continue;
    const p = e.payload as { type?: unknown; key?: unknown } | undefined;
    if (p?.type === ANNOUNCE_TYPE && p.key === key) return true;
  }
  return false;
}

/** 是否应当公告。判定顺序:非法 → INVALID;force → forced;边界后无公告但历史公告过
 * → after-compact;从未公告 → first;边界后已有公告 → already-announced(本轮零追加)。 */
export function shouldAnnounce(input: ShouldAnnounceInput): ShouldAnnounceResult {
  const { events, sessionId, kind, payloadHash, force } = input ?? ({} as ShouldAnnounceInput);
  const key = announceKeyOf(kind, payloadHash);
  if (key === INVALID) {
    return {
      ok: false,
      announce: false,
      key,
      reason: isAnnounceKind(kind) ? "invalid-payload" : "invalid-kind",
    };
  }
  if (force === true) return { ok: true, announce: true, key, reason: "forced" };
  const list = Array.isArray(events) ? events : [];
  const last = lastAnnounceOf(list, sessionId, key);
  if (last === null) {
 // 历史公告只可能被真压缩边界排除(见 lastAnnounceOf),故「有历史公告 + 当前不可见」
 // 必是压缩重置生命后的第一次,reason 用 after-compact 便于审计区分「首见 vs 压缩后重发」。
    return { ok: true, announce: true, key, reason: anyAnnounceOf(list, sessionId, key) ? "after-compact" : "first" };
  }
 // lastAnnounceOf 已保证 seq > 最后真压缩边界 → 公告仍在 canonical history 里,本轮零追加。
  return { ok: true, announce: false, key, reason: "already-announced" };
}

/** 构造稳定 custom 公告事件(不写盘;summary 截断到 200 字)。 */
export function announceEvent(input: AnnouncementInput): AnnounceCustomEvent {
  const raw = input ?? ({} as AnnouncementInput);
  const key = typeof raw.key === "string" && raw.key.length > 0 ? raw.key : INVALID;
  const summary = typeof raw.summary === "string" && raw.summary.length > 0 ? raw.summary.slice(0, 200) : undefined;
  return {
    kind: "custom",
    payload: {
      type: ANNOUNCE_TYPE,
      announceKind: typeof raw.kind === "string" ? raw.kind : INVALID,
      key,
      at: typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : 0,
      ...(summary !== undefined ? { summary } : {}),
    },
  };
}

/** 计算要追加的公告事件(**只返回、不写**);边界之后已有同 key 公告 → 返回空数组(同一步幂等)。 */
export function markAnnounced(
  events: readonly AnnounceEventLike[],
  sessionId: string,
  announcement: AnnouncementInput): AnnounceEventLike[] {
  const list = Array.isArray(events) ? events : [];
  const key = typeof announcement?.key === "string" ? announcement.key : "";
  if (key.length === 0 || key === INVALID) return [];
  if (lastAnnounceOf(list, sessionId, key) !== null) return [];
  let maxSeq = 0;
  for (const e of list) {
    if (Number.isFinite(e?.seq) && e.seq > maxSeq) maxSeq = e.seq;
  }
  return [
    {
      kind: "custom",
      sessionId,
      seq: maxSeq + 1,
      payload: announceEvent({ kind: announcement.kind, key, at: announcement.at, summary: announcement.summary }).payload,
    },
  ];
}
