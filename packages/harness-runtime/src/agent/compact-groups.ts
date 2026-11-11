/**
 *  压缩保留段(tail)组对齐 —— 纯逻辑,零 IO,不 throw,不可变。
 * 背景:auto-compact 旧实现 `messages.slice(-keepRecentMessages)` 从任意下标切。切点若落在
 * assistant(tool_use) 与它的 tool_result 之间,tail 首条就是一条「无来源的 tool 消息」,
 * provider 会 400(tool_call_id 无对应 tool_call);或者 head 侧只留一次没有回执的 tool_use,
 * 摘要模型看到「调了工具却永远没结果」的断链,摘要质量与后续重放都不可信。
 * 为什么以 assistant 消息为组边界:一条 assistant 的 tool_use 与它后面紧跟的 tool_result 在
 * 协议上是**同一个交换的两半**,任何只保留一半的上下文都是非法形态。所以压缩只能整组保留
 * (进 tail)整组摘要(进 head),不能从组中间切。user/system 各自独立成组;找不到归属
 * assistant 的 tool 消息是 orphan 组,只能保守地连同前面的消息一起保留。
 */

import { createHash } from "node:crypto";

/** 组对齐需要的最小消息形状(Message 结构上兼容;签名保持宽松,便于纯逻辑单测)。 */
export interface GroupableMessage {
  role?: string;
  content?: unknown;
  toolCalls?: readonly { id?: string; name?: string; arguments?: string }[];
  toolCallId?: string;
}

/** 一条消息的确定性稳定 id:`m<index>:<role>:<sha256(content+toolCalls)[0..8]>`。 */
export function messageStableId(msg: GroupableMessage | undefined, index: number): string {
  const role = typeof msg?.role === "string" ? msg.role : "unknown";
  const digest = createHash("sha256").update(stablePayload(msg), "utf8").digest("hex").slice(0, 8);
  return `m${index}:${role}:${digest}`;
}

/** 组类型:assistant 组(含其 tool 回执)/ user / system / 孤立 tool / 结构异常。 */
type GroupKind = "assistant" | "user" | "system" | "orphan-tool" | "corrupt";

interface GroupSpan {
 /** 组起点下标(含)。 */
  start: number;
 /** 组终点下标(不含)。 */
  end: number;
  kind: GroupKind;
}

/** tail 对齐结果。 */
export interface TailAlignment<M extends GroupableMessage> {
 /** tail 起点在**原数组**里的下标(整组边界,不会落在组中间)。 */
  tailStartIndex: number;
 /** 保留段(浅拷贝;元素仍是原对象,不修改它们)。 */
  tail: M[];
 /** tail 里被完整保留的组数。 */
  groupCount: number;
 /** tail 首条消息的稳定 id;tail 为空时为 null。 */
  tailStartId: string | null;
 /** 观测告警(确定性排序、去重):orphan-tool / group-corrupt。 */
  warnings: string[];
}

/** tail 边界自检结果。 */
export interface TailValidation {
  ok: boolean;
  issues: string[];
}

/** content + toolCalls 的确定性字符串(只取固定字段,不依赖对象 key 顺序)。 */
function stablePayload(msg: GroupableMessage | undefined): string {
  const content = toText(msg?.content);
  const calls = Array.isArray(msg?.toolCalls) ? msg.toolCalls : [];
  const callText = calls
    .map((c) => `${typeof c?.id === "string" ? c.id : ""}\u0001${typeof c?.name === "string" ? c.name : ""}\u0001${toText(c?.arguments)}`)
    .join("\u0002");
  return `${content}\u0003${callText}`;
}

/** 任意 content 的安全字符串化(不 throw)。 */
function toText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** 把消息数组切成组。O(n),纯函数。 */
function buildGroups(messages: readonly GroupableMessage[]): GroupSpan[] {
  const groups: GroupSpan[] = [];
  const n = messages.length;
  let i = 0;
  while (i < n) {
    const role = messages[i]?.role;
    if (role === "assistant") {
      const start = i;
      const toolCallIds = new Set<string>();
      for (const c of messages[start]?.toolCalls ?? []) {
        if (typeof c?.id === "string") toolCallIds.add(c.id);
      }
      i += 1;
 // toolCallId 匹配优先:只把「确实是这条 assistant 的回执」的连续 tool 消息并进来。
 // 匹配不上(或中间的 tool 指向别处)就断开,让那条 tool 自己成 orphan 组——
 // 不能为了凑组把不属于它的回执吞进来(吞进来等于替模型伪造配对关系)。
      while (i < n && messages[i]?.role === "tool") {
        const tid = messages[i]?.toolCallId;
        if (typeof tid === "string" && toolCallIds.has(tid)) i += 1;
        else break;
      }
      groups.push({ start, end: i, kind: "assistant" });
      continue;
    }
    if (role === "tool") {
 // 孤立 tool:前无(可匹配的)assistant——单独成组,对齐时再保守并入前一组。
      groups.push({ start: i, end: i + 1, kind: "orphan-tool" });
      i += 1;
      continue;
    }
    if (role === "user" || role === "system") {
      groups.push({ start: i, end: i + 1, kind: role });
      i += 1;
      continue;
    }
 // 缺 role / role 不在协议词汇表:结构异常,无法判定组边界。
    groups.push({ start: i, end: i + 1, kind: "corrupt" });
    i += 1;
  }
  return groups;
}

/**
 * 从尾部向前按**组**累计消息数,达到 keepRecentMessages 即停;切点天然落在组起点。
 * 额外保守处理:
 * - tail 首条仍是 tool(orphan)→ 继续向前并入一组,直到首条不再是 tool 或到达数组头;
 * - tail 内含结构异常消息 → 再向前扩一组(比「多保留一条」更保守,且不会切开组)。
 */
export function alignTailGroups<M extends GroupableMessage>(
  messages: readonly M[],
  keepRecentMessages: number): TailAlignment<M> {
  const list: readonly M[] = Array.isArray(messages) ? messages : [];
  const n = list.length;
  if (n === 0) {
    return { tailStartIndex: 0, tail: [], groupCount: 0, tailStartId: null, warnings: [] };
  }

  const keep = Number.isFinite(keepRecentMessages) ? Math.max(0, Math.floor(keepRecentMessages)) : 0;
  const groups = buildGroups(list);
  const warnings = new Set<string>();

 // firstGroup = groups.length 表示 tail 为空(keep<=0 时不取任何组)。
  let firstGroup = groups.length;
  let kept = 0;
  for (let gi = groups.length - 1; gi >= 0; gi -= 1) {
    if (kept >= keep) break;
    const g = groups[gi]!;
    kept += g.end - g.start;
    firstGroup = gi;
  }

 // orphan 打头:tail 首条是 tool 说明它的 assistant 被切进了 head——必须继续向前并入一组。
  let orphanSeen = false;
  while (firstGroup < groups.length && groups[firstGroup]!.kind === "orphan-tool") {
    orphanSeen = true;
    if (firstGroup === 0) break; // 已到数组头,无处可并 → 保留 orphan 并告警
    firstGroup -= 1;
  }
  if (orphanSeen) warnings.add("orphan-tool");

 // 结构异常:无法判定边界 → 保守多保留(整组前进,不切组)。
  if (firstGroup < groups.length && groups.slice(firstGroup).some((g) => g.kind === "corrupt")) {
    warnings.add("group-corrupt");
    if (firstGroup > 0) firstGroup -= 1;
  }

  const tailStartIndex = firstGroup < groups.length ? groups[firstGroup]!.start : n;
  const tail = list.slice(tailStartIndex) as M[];
  const groupCount = firstGroup < groups.length ? groups.length - firstGroup : 0;
  const tailStartId = tail.length > 0 ? messageStableId(tail[0], tailStartIndex) : null;

  return {
    tailStartIndex,
    tail,
    groupCount,
    tailStartId,
    warnings: [...warnings].sort(),
  };
}

/**
 * tail 边界自检。调用方在写 compact.done 之前用它复核:
 * - tail 首条 role 不得是 "tool"(否则就是切在组中间);
 * - tail 内 assistant 声明的 toolCallId 必须能在它后面紧跟的 tool 段里找到
 * (找不到 = 同一 assistant 组跨了 tail 边界);
 * - tool 消息必须带 toolCallId。
 * issues 确定性排序;空 tail 视为合法(没有可切的边界)。
 */
export function validateTailGrouping(tail: readonly GroupableMessage[]): TailValidation {
  const list: readonly GroupableMessage[] = Array.isArray(tail) ? tail : [];
  const issues: string[] = [];
  if (list.length === 0) return { ok: true, issues: [] };

  if (list[0]?.role === "tool") issues.push("first-message-is-tool");

  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    if (m?.role === "assistant") {
      const want = (m.toolCalls ?? [])
        .map((c) => (typeof c?.id === "string" ? c.id : ""))
        .filter((id) => id !== "");
      if (want.length > 0) {
        const got = new Set<string>();
        let j = i + 1;
        while (j < list.length && list[j]?.role === "tool") {
          const tid = list[j]?.toolCallId;
          if (typeof tid === "string") got.add(tid);
          j += 1;
        }
        const missing = want.filter((id) => !got.has(id)).sort();
        if (missing.length > 0) issues.push(`assistant-tool-split@${i}:${missing.join(",")}`);
      }
    }
    if (m?.role === "tool" && typeof m.toolCallId !== "string") {
      issues.push(`tool-without-toolCallId@${i}`);
    }
  }

  issues.sort();
  return { ok: issues.length === 0, issues };
}
