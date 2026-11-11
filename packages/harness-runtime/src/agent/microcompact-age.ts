/**
 * 按龄微压缩:零模型、纯逻辑、零 IO 的确定性裁剪。
 * 为什么必须**零模型**:这条路径挂在「每次 provider 请求之前」,一个 turn 里每个 step 都走一遍。
 * 任何模型调用都会变成一次额外往返(成本 + 延迟 + 新的失败面),而它要做的判断只依赖两样东西——
 * 时间戳(会话闲置多久、组多老)与消息结构(user+assistant+tool 链是否完整),都不需要语义理解。
 * 需要语义的压缩由 auto-compact(阈值触发、调模型)负责;这里只做「老了就整组丢掉」的确定性动作。
 * 为什么收益 < 256 token 就**整体回滚**:丢老组必然改请求前缀 → prompt cache 从断点起全失效
 * (历史经验证:每步重写历史中段 → uncached 单价是命中态的 50 倍)。为几十 token 打碎一次前缀
 * 是净亏,256 是「省下的量 > 一次前缀重建的期望代价」的经验下界,与既有 microcompact 止损同源。
 * 约束(验收契约):不拆 tool 链、system 永不丢、最后一条 user 永不丢、不可变、确定性、不 throw。
 */
import { estimateMessagesTokens } from "./token-estimate";
import type { Message } from "./loop";

/** 收益下限(token):低于此值整体回滚,不改请求(见文件头注释)。 */
export const AGE_MIN_SAVINGS_TOKENS = 256;

/** 判定码:上层只按 code 决定是否替换本次请求、是否留痕。 */
export const AGE_CODES = {
 /** 真的压缩了:返回的 messages 只用于**本次**请求。 */
  OK: "OK",
 /** 会话没有闲置够久:原样。 */
  SKIPPED_NOT_IDLE: "SKIPPED_NOT_IDLE",
 /** 闲置够久但没有超龄组:原样。 */
  SKIPPED_NOT_OLD: "SKIPPED_NOT_OLD",
 /** 有过裁剪但收益不足下限:原样(消息引用不变)。 */
  ROLLED_BACK: "ROLLED_BACK",
 /** 参数非法/内部异常:原样(不 throw)。 */
  INVALID: "INVALID",
} as const;

export type AgeCode = (typeof AGE_CODES)[keyof typeof AGE_CODES];

/** 缺省值:闲置 30 分钟起判、组龄 60 分钟起算超龄、保留最近 3 组。 */
export const AGE_DEFAULTS = {
  idleMs: 30 * 60_000,
  maxAgeMs: 60 * 60_000,
  keepRecentGroups: 3,
} as const;

export interface AgeMicrocompactOptions {
 /** 当前时间(epoch ms)。缺省/非法 → INVALID(不猜时间)。 */
  now?: number;
 /** 会话最后一条事件时间(epoch ms)。缺省/非法/未来 → 不判闲置。 */
  lastEventAt?: number;
 /** 闲置阈值(ms):now - lastEventAt >= idleMs 才算闲置。 */
  idleMs?: number;
 /** 组龄阈值(ms):age >= maxAgeMs 才算「超龄」,可裁。 */
  maxAgeMs?: number;
 /** 保留最近 N 组(N>=1,0 按 1 处理:最后一条 user 永不丢)。 */
  keepRecentGroups?: number;
 /** 收益下限(token),缺省 AGE_MIN_SAVINGS_TOKENS。 */
  minSavingsTokens?: number;
 /** 组龄口径:lastMessageTime=组内最后一条消息的时间戳(缺省);组内无时间则回落 lastEventAt。 */
  groupAgeBy?: "lastMessageTime";
}

export interface MessageGroup {
 /** 组内消息(原顺序;user + 其后的 assistant/tool 链完整,绝不跨组拆)。 */
  messages: Message[];
 /** 组起点/终点在输入数组中的下标(诊断用,不参与判定)。 */
  startIndex: number;
  endIndex: number;
 /** 永不裁剪:头部之外的 system 契约、无 user 起头的孤儿段。 */
  pinned: boolean;
}

export interface GroupedMessages {
 /** 头部 system 消息(首个 user 之前),永不参与裁剪。 */
  system: Message[];
 /** 对话组顺序 = 原顺序(含 pinned 组);重建 = [...system, ...groups.flatMap(messages)]。 */
  groups: MessageGroup[];
}

export interface AgeMicrocompactResult {
  code: AgeCode;
 /** OK=裁剪后的新数组;其余情况=输入原数组(同一引用,逐字不变)。 */
  messages: Message[];
  prunedGroups: number;
  prunedMessages: number;
 /** 估算节省 token;ROLLED_BACK 时也给出(便于观测「差点就省了」的量)。 */
  savingsTokens: number;
  beforeTokens?: number;
  afterTokens?: number;
 /** 诊断注记(不参与判定、不影响结果)。 */
  notes: string[];
}

/** 读消息上的可选时间戳(journal 派生消息可能带 time 旁注;Message 类型本身无此字段)。 */
function messageTime(m: unknown): number | undefined {
  if (!m || typeof m !== "object") return undefined;
  const t = (m as { time?: unknown }).time;
  return typeof t === "number" && Number.isFinite(t) ? t : undefined;
}

/** 组内最后一条消息的时间(取组内最大有限时间戳);无时间 → undefined。 */
function groupLastTime(g: MessageGroup): number | undefined {
  let last: number | undefined;
  for (const m of g.messages) {
    const t = messageTime(m);
    if (t === undefined) continue;
    last = last === undefined ? t : Math.max(last, t);
  }
  return last;
}

/** 组内「有 toolCalls 但还没有对应 tool 结果」的调用 id(判组边界时用来避免拆链)。 */
function openToolCallIds(g: MessageGroup): string[] {
  const answered = new Set<string>();
  for (const m of g.messages) {
    if (m.role === "tool") answered.add(m.toolCallId);
  }
  const open: string[] = [];
  for (const m of g.messages) {
    if (m.role !== "assistant" || !m.toolCalls) continue;
    for (const c of m.toolCalls) if (!answered.has(c.id)) open.push(c.id);
  }
  return open;
}

/**
 * 闲置判定:lastEventAt 非法/未来 → false(不猜);now - lastEventAt >= idleMs → true。
 * 单列出来便于 loop 在不做压缩时也复用同一口径。
 */
export function shouldIdleCompact(opts: {
  lastEventAt?: number;
  now?: number;
  idleMs?: number;
}): boolean {
  const now = opts?.now;
  const last = opts?.lastEventAt;
  const idleMs = opts?.idleMs ?? AGE_DEFAULTS.idleMs;
  if (!Number.isFinite(now) || !Number.isFinite(last) || !Number.isFinite(idleMs)) return false;
  if ((idleMs as number) <= 0) return false;
 // 未来时间戳 = 时钟异常:宁可不动(压缩是可选优化,不该被时钟问题触发)。
  if ((last as number) > (now as number)) return false;
  return (now as number) - (last as number) >= (idleMs as number);
}

/**
 * 按 user 消息分组:一个 user 起头,直到下一个 user(或一个「可安全切分的 system」)之前。
 * - assistant.toolCalls 与其 tool 结果天然同组(切分点只在 user / system 处);
 * - 中段 system 变成 pinned 组(保序、永不裁);只有当它落在一个「还有未回填 toolCalls 的组」里时,
 * 才并入该组而不是切分,避免把 tool 链劈成两半;
 * - 首个 user 之前的 system 进 head;首个 user 之前的其它消息(孤儿 assistant/tool)进 pinned 组。
 */
export function groupMessages(messages: readonly Message[]): GroupedMessages {
  const list: readonly unknown[] = Array.isArray(messages) ? messages : [];
  const system: Message[] = [];
  const groups: MessageGroup[] = [];
  let cur: MessageGroup | null = null;

  const openGroup = (m: Message, index: number, pinned: boolean): MessageGroup => {
    const g: MessageGroup = { messages: [m], startIndex: index, endIndex: index, pinned };
    groups.push(g);
    return g;
  };

  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (!raw || typeof raw !== "object") continue; // 脏元素跳过,不 throw
    const m = raw as Message;
    const role = (m as { role?: unknown }).role;

    if (role === "system") {
      if (groups.length === 0 && !cur) {
        system.push(m);
        continue;
      }
 // 还没回填完 toolCalls 的组:把 system 并进去(不拆链),否则单开 pinned 组。
      if (cur && openToolCallIds(cur).length > 0) {
        cur.messages.push(m);
        cur.endIndex = i;
        continue;
      }
      cur = openGroup(m, i, true);
      continue;
    }

    if (role === "user") {
      cur = openGroup(m, i, false);
      continue;
    }

 // assistant / tool / 未知 role:并入当前组;没有当前组 → pinned 孤儿组。
    if (!cur) {
      cur = openGroup(m, i, true);
    } else {
      cur.messages.push(m);
      cur.endIndex = i;
    }
  }
  return { system, groups };
}

/** 找到含最后一条 user 的组下标(该组永不丢)。 */
function lastUserGroupIndex(groups: readonly MessageGroup[]): number {
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    if (g.messages.some((m) => m?.role === "user")) return i;
  }
  return -1;
}

/**
 * 按龄裁剪一次(纯函数:不改入参、同入参同输出、任何情况下不 throw)。
 * 顺序:参数校验(INVALID) → 闲置判定(SKIPPED_NOT_IDLE) → 超龄候选(SKIPPED_NOT_OLD)
 * → 估算收益(< minSavingsTokens 则 ROLLED_BACK) → OK。
 */
export function ageMicrocompact(
  messages: readonly Message[],
  opts: AgeMicrocompactOptions = {},
): AgeMicrocompactResult {
  const input = Array.isArray(messages) ? messages : [];
  const notes: string[] = [];
  const unchanged = (code: AgeCode, extra?: Partial<AgeMicrocompactResult>): AgeMicrocompactResult => ({
    code,
    messages: input as Message[],
    prunedGroups: 0,
    prunedMessages: 0,
    savingsTokens: 0,
    notes,
    ...extra,
  });

  try {
    if (!Array.isArray(messages)) {
      notes.push("messages-not-array");
      return unchanged(AGE_CODES.INVALID);
    }
    const now = opts.now;
    const lastEventAt = opts.lastEventAt;
    const idleMs = opts.idleMs ?? AGE_DEFAULTS.idleMs;
    const maxAgeMs = opts.maxAgeMs ?? AGE_DEFAULTS.maxAgeMs;
    const keepRecentGroups = opts.keepRecentGroups ?? AGE_DEFAULTS.keepRecentGroups;
    const minSavingsTokens = opts.minSavingsTokens ?? AGE_MIN_SAVINGS_TOKENS;

    if (!Number.isFinite(now) || !Number.isFinite(lastEventAt)) {
      notes.push("time-invalid");
      return unchanged(AGE_CODES.INVALID);
    }
    if (!Number.isFinite(idleMs) || idleMs <= 0) {
      notes.push("idle-ms-invalid");
      return unchanged(AGE_CODES.INVALID);
    }
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      notes.push("max-age-invalid");
      return unchanged(AGE_CODES.INVALID);
    }
    if (!Number.isFinite(keepRecentGroups) || keepRecentGroups < 0) {
      notes.push("keep-recent-invalid");
      return unchanged(AGE_CODES.INVALID);
    }
    if (!Number.isFinite(minSavingsTokens) || minSavingsTokens < 0) {
      notes.push("min-savings-invalid");
      return unchanged(AGE_CODES.INVALID);
    }

    if (!shouldIdleCompact({ lastEventAt, now, idleMs })) {
      notes.push("not-idle");
      return unchanged(AGE_CODES.SKIPPED_NOT_IDLE);
    }

    const grouped = groupMessages(input);
 // 最近 keepRecent 组 + 含最后一条 user 的组永不丢(keepRecentGroups=0 也至少保留一组)。
    const keepRecent = Math.max(1, Math.floor(keepRecentGroups as number));
    const lastUser = lastUserGroupIndex(grouped.groups);
    const protectedFrom = grouped.groups.length - keepRecent;

 // 组龄:优先用组内最后一条消息时间(更准);组内无时间 → 用 lastEventAt。
 // 既有消息必然写在「最后事件」之前,故 now - lastEventAt 是所有老消息组龄的**下界**——
 // 用它判超龄是保守的(只会漏裁,不会错裁)。
    const ageOf = (g: MessageGroup): number => {
      const t = groupLastTime(g);
      const at = t !== undefined && t <= (now as number) ? t : (lastEventAt as number);
      return (now as number) - at;
    };

    const prunable: number[] = [];
    for (let i = 0; i < grouped.groups.length; i++) {
      const g = grouped.groups[i]!;
      if (g.pinned) continue;
      if (i === lastUser) continue;
      if (i >= protectedFrom) continue;
      if (ageOf(g) < (maxAgeMs as number)) continue;
      prunable.push(i);
    }
    if (prunable.length === 0) {
      notes.push("no-old-group");
      return unchanged(AGE_CODES.SKIPPED_NOT_OLD);
    }

    const drop = new Set(prunable);
    const kept = grouped.groups.filter((_, i) => !drop.has(i));
    const next: Message[] = [...grouped.system];
    for (const g of kept) next.push(...g.messages);

    const prunedMessages = prunable.reduce((sum, i) => sum + grouped.groups[i]!.messages.length, 0);
    const beforeTokens = estimateMessagesTokens(input);
    const afterTokens = estimateMessagesTokens(next);
    const savingsTokens = Math.max(0, beforeTokens - afterTokens);

    if (savingsTokens < (minSavingsTokens as number)) {
 // 收益不足:整体回滚(连「等价新数组」都不给——上层零行为变化)。
      return unchanged(AGE_CODES.ROLLED_BACK, { savingsTokens, beforeTokens, afterTokens });
    }

    return {
      code: AGE_CODES.OK,
      messages: next,
      prunedGroups: prunable.length,
      prunedMessages,
      savingsTokens,
      beforeTokens,
      afterTokens,
      notes,
    };
  } catch {
 // 压缩是可选优化:任何意外都退化成「不动」,绝不因为优化本身打断 turn。
    notes.push("unexpected-error");
    return unchanged(AGE_CODES.INVALID);
  }
}
