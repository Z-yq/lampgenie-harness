/** 上下文温度三区派生(数据链,白板节点 n1)。
 * 口径与 docs/design/02-context-economy/03-concepts.md §3 对齐:
 * - 冷区 = 冻结区 = 派生消息前缀 [0, frozenCount):append-only 逐字不可改。
 * frozenCount 取 journal 会话事件里**最后一条** kind==="context.prune" 且 payload.frozenCount
 * 为数字的事件值(loop.ts seedPruneState 同款尾扫语义);无则 0 且 frozenFrom:"none"。
 * - 温区 = 冻结区之后的中段:可精简、语义保留。
 * - 热区 = 最近保护窗:派生消息**末 N 条**逐字保护;N = PROTECTION_WINDOWS.scoringHotTailMessages
 * (import 失败或字段非数字 → 回退 6,hotTailSource:"default")。
 * 三区是派生出来的**逻辑视图**(对 trace.stats 只读投影),N 只是机制保护窗,不改请求前缀。
 * 估算口径:chars = String(content).length;estTokens = Math.round(chars / 4)(粗估,非计费数)。
 * 边界裁定:冷区优先——frozenCount + N > total 时热区让渡为剩余末段,温区居中可为空
 * (冻结区「逐字不可改」的语义不让渡给保护窗)。
 * 派生失败(loop 模块不可导入 / 缺 deriveMessages 导出 / 空会话 total===0)→ 返回 null,不造数。
 */

/** 单区统计:messages=条数,chars=字符数,estTokens=chars/4 四舍五入估算。 */
export interface ZoneStat {
  messages: number;
  chars: number;
  estTokens: number;
}

/** 纯切分(导出供单测):给定 total、frozenCount(journal 原值)、hotTail N,算三区区间。
 * 规则(03-concepts §3):冷区=[0, min(frozenCount,total));热区=[max(coldEnd,total-N), total)
 * (冷区优先,重叠时热区让渡);温区=中段。返回 [coldEnd, hotStart] 两个切点。 */
export function partitionZones(total: number, frozenCount: number, hotTail: number): { coldEnd: number; hotStart: number } {
  const coldEnd = Math.min(Math.max(0, frozenCount), Math.max(0, total));
  const hotStart = Math.max(coldEnd, total - Math.max(0, hotTail));
  return { coldEnd, hotStart };
}

/** 纯统计(导出供单测):三区区间已切好,按消息 content 聚 chars/estTokens。
 * chars=String(content ?? "").length;estTokens=Math.round(chars/4)(粗估,非计费数)。 */
export function zoneStatsOf(
  messages: Array<{ content?: unknown }>,
  cut: { coldEnd: number; hotStart: number },
): { cold: ZoneStat; warm: ZoneStat; hot: ZoneStat } {
  const stat = (arr: Array<{ content?: unknown }>): ZoneStat => {
    let chars = 0;
    for (const m of arr) chars += String(m?.content ?? "").length;
    return { messages: arr.length, chars, estTokens: Math.round(chars / 4) };
  };
  return {
    cold: stat(messages.slice(0, cut.coldEnd)),
    warm: stat(messages.slice(cut.coldEnd, cut.hotStart)),
    hot: stat(messages.slice(cut.hotStart)),
  };
}

/** 三区派生结果(trace.stats 回包 stats.contextZones 的载荷形态)。 */
export interface ContextZones {
  zones: { cold: ZoneStat; warm: ZoneStat; hot: ZoneStat };
  totalMessages: number;
 /** 热区窗长来源:protection-windows=读机制配置;default=回退 6 / opts.hotTail 注入。 */
  hotTailSource: "protection-windows" | "default";
 /** journal 尾扫到的原值(≥0,不做 total 钳制;冷区实际切分用 min(frozenCount, total))。 */
  frozenCount: number;
  frozenFrom: "context.prune" | "none";
}

/** journal 最小结构依赖:frozenCount 尾扫用 readSession(会话索引切片);
 * deriveMessages 运行时还会经它调 journal.readAll(透传给真实实现,测试可两者都给)。 */
export interface ContextZonesJournal {
  readSession(sessionId: string): Array<{ kind?: unknown; payload?: unknown }>;
  readAll?(): Array<{ kind?: unknown; payload?: unknown }>;
}

export interface ContextZonesOptions {
 /** 热区窗长注入(测试用):优先于 protection-windows;命中时 hotTailSource 记 "default"。 */
  hotTail?: number;
}

/** 保护窗 import 失败时的兜底窗长(与 PROTECTION_WINDOWS.scoringHotTailMessages 缺省一致)。 */
const DEFAULT_HOT_TAIL = 6;

/** 派生消息最小形态:只消费 content(chars 口径 String(content ?? ""))。 */
type DerivedMessage = { content?: unknown };

/** 从会话事件**尾往前**找最后一条 context.prune 且 payload.frozenCount 为有限数字的值。
 * 导出供单测(loop.ts seedPruneState 同款尾扫语义)。 */
export function frozenCountOf(events: Array<{ kind?: unknown; payload?: unknown }>): {
  frozenCount: number;
  frozenFrom: "context.prune" | "none";
} {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if ((e as { kind?: unknown }).kind !== "context.prune") continue;
    const p = (e as { payload?: unknown }).payload as { frozenCount?: unknown } | undefined;
    if (p && typeof p.frozenCount === "number" && Number.isFinite(p.frozenCount)) {
      return { frozenCount: Math.max(0, Math.floor(p.frozenCount)), frozenFrom: "context.prune" };
    }
  }
  return { frozenCount: 0, frozenFrom: "none" };
}

/** 派生上下文温度三区(冷/温/热)。只读 journal,不写任何事件、不改请求前缀。
 * @returns 空会话或派生链路不可用(loop/protection-windows 之外的因素)时返回 null,不造数。 */
export async function deriveContextZones(
  journal: ContextZonesJournal | undefined | null,
  sessionId: string,
  opts?: ContextZonesOptions,
): Promise<ContextZones | null> {
  if (!journal || typeof journal.readSession !== "function") return null;

 // 热区窗长 N:opts.hotTail(测试注入)> protection-windows 机制配置 > 6 兜底。
  let hotTail = DEFAULT_HOT_TAIL;
  let hotTailSource: ContextZones["hotTailSource"] = "default";
  if (typeof opts?.hotTail === "number" && Number.isFinite(opts.hotTail) && opts.hotTail >= 0) {
    hotTail = Math.floor(opts.hotTail);
  } else {
    try {
      const pw = (await import("@lampgenie/runtime/agent/protection-windows")) as unknown as {
        PROTECTION_WINDOWS?: { scoringHotTailMessages?: unknown };
      };
      const n = pw.PROTECTION_WINDOWS?.scoringHotTailMessages;
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) {
        hotTail = Math.floor(n);
        hotTailSource = "protection-windows";
      }
    } catch { /* 模块不可用=回退 6,source 保持 "default" */ }
  }

 // 派生消息:loop 不可导入或缺 deriveMessages 导出 → null(不造数、不退化为旧消息重放)。
  let messages: DerivedMessage[];
  try {
    const loop = (await import("@lampgenie/runtime/agent/loop")) as unknown as {
      deriveMessages?: (journal: unknown, sessionId: string) => unknown;
    };
    const derive = loop.deriveMessages;
    if (typeof derive !== "function") return null;
    const derived = derive(journal, sessionId);
    if (!Array.isArray(derived)) return null;
    messages = derived as DerivedMessage[];
  } catch {
    return null;
  }
  const total = messages.length;
  if (total === 0) return null; // 空会话:三区无从谈起

 // frozenCount:readSession 会话切片尾扫(readSession 抛错=无 prune 记录,回退 none/0)。
  let frozen: { frozenCount: number; frozenFrom: "context.prune" | "none" } = {
    frozenCount: 0,
    frozenFrom: "none",
  };
  try {
    frozen = frozenCountOf(journal.readSession(sessionId));
  } catch { /* 读流异常=当无冻结记录 */ }

 // 切分:冷区 [0, min(frozenCount,total));热区 [max(coldEnd, total-N), total)(冷区优先);
 // 温区 = 两者之间的中段(可为空)。
  const { coldEnd, hotStart } = partitionZones(total, frozen.frozenCount, hotTail);
  return {
    zones: zoneStatsOf(messages, { coldEnd, hotStart }),
    totalMessages: total,
    hotTailSource,
    frozenCount: frozen.frozenCount,
    frozenFrom: frozen.frozenFrom,
  };
}
