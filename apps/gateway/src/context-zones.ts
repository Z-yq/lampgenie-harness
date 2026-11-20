/** 上下文温度三区派生(数据链; 热区口径纠正为「未闭合动作链」)。
 * 口径(用户拍板:展示层**全量划分**——冷+温+热 三数相加=pill 主值总量;
 * 03-concepts §3 原口径「三区=已发出字节、增量在区外增量侧」保留在机制层,差异见
 * docs/design/02-context-economy/07-design-decisions 增补节,不回改正文):
 * 归并规则(任何一条消息都有且只有一个归属,MECE):
 * - 冷区 = 冻结/append-only 部分:派生消息前缀 [0, frozenCount)(frozenCount 取 journal 会话事件里
 * **最后一条** kind==="context.prune" 且 payload.frozenCount 为数字的事件值,loop.ts seedPruneState
 * 同款尾扫语义;无则 0 且 frozenFrom:"none")。展示层归一时「系统提示/技能等不在消息三区的字节」
 * 也并入冷区(panel 浮窗 helper,机制上同属 append-only 前缀)。
 * - 温区 = 冻结区之后、热区起点之前的已闭合中段:可精简、语义保留。
 * - 热区 = 未闭合动作链 **+ 本步新增/未发出增量**:跨度起点 = min(openStart, afterTraceStart)。
 * · openStart = 未闭合链起点;闭合边界 = message.user(新指令/主题切换,自身开启新链属热区)/
 * message.agent 纯文本且无 toolCalls(动作完成,自身降级温区)/ turn.end /
 * custom(type=task.phase 或 context.path.abandoned)/ context.prune **真实裁中**
 * (compacted>0/policy=reset|growth-spurt;low-context-skip 是空操作不算闭合);
 * · afterTraceStart = 最后一条 llm.trace 之后首条增量消息下标——增量=当前活跃工作,归热区
 * (曾单列「区外增量」,本步按用户决策并入);
 * · 无 llm.trace → afterTraceStart=null,热区=未闭合链原跨度。
 * **热区没有条数/组数上限**——开放链多长就保护多长;「最近 6 条」只是 jev-150m 评分器
 * 保护窗(model-scoring.ts:287),hotTailNote 仅作浮窗小注展示,不参与切分(03-concepts :22)。
 * 三区=派生消息的**逻辑视图**(对 trace.stats 只读投影),不改请求前缀、不改压缩行为。
 * 增量归并(07-design-decisions 增补节):03-concepts §3 的「区外增量侧」口径保留在机制层;
 * 展示层(用户拍板)增量并入热区——afterTraceStartOf 取末条 llm.trace 之后首条增量
 * 消息下标,热区起点=min(openStart, afterTraceStart);无锚点 → 热区=未闭合链原跨度。
 * 估算口径:chars = String(payload.text ?? payload.content ?? payload.output ?? "").length;
 * estTokens = Math.round(chars / 4)(粗估,非计费数)。与 pill 主值(API 经验证 inputTokens)口径不同——
 * 浮窗展示层按主值归一成全量划分(冷+温+热=总量,严格相等),归一方法见 script-core.ts ctxZonesGroupHtml。
 * 边界裁定:冷区优先——coldEnd > openStart 时热区让渡为空,温区居中可为空(冻结区
 * 「逐字不可改」的语义不让渡给开放链)。
 * 近似性:闭合扫描按 raw 会话事件推派生消息下标,未复刻 deriveMessages 的 discarded/truncate
 * 过滤(少见路径条数可 ±1),zoneBasis 如实带 approx 标注。
 * 派生失败(loop 模块不可导入 / 缺 deriveMessages 导出 / 空会话 total===0)→ 返回 null,不造数。
 */

import { isSubagentTerminal } from "@lampgenie/runtime/agent/focus-tracker";
import { pathRootOf } from "@lampgenie/runtime/agent/segment-tracker";

/** 单区统计:messages=条数,chars=字符数,estTokens=chars/4 四舍五入估算。 */
export interface ZoneStat {
  messages: number;
  chars: number;
  estTokens: number;
}

/** 纯切分(导出供单测):给定 total、frozenCount(journal 原值)、热区长度 hotLen,算三区区间。
 * 规则(03-concepts §3):冷区=[0, min(frozenCount,total));热区=[max(coldEnd,total-hotLen), total)
 * (冷区优先,重叠时热区让渡);温区=中段。返回 [coldEnd, hotStart] 两个切点。
 * hotLen 的来源从「计数保护窗 N」改为「未闭合链长度 total-openStart」,语义不变。 */
export function partitionZones(total: number, frozenCount: number, hotLen: number): { coldEnd: number; hotStart: number } {
  const coldEnd = Math.min(Math.max(0, frozenCount), Math.max(0, total));
  const hotStart = Math.max(coldEnd, total - Math.max(0, hotLen));
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

/** 三区派生结果(trace.stats 回包 stats.contextZones 的载荷形态; 口径)。 */
export interface ContextZones {
  zones: { cold: ZoneStat; warm: ZoneStat; hot: ZoneStat };
  totalMessages: number;
 /** 热区切分依据:open-chains=未闭合动作链+末条 trace 后增量(raw 事件近似推导,含 approx 语义)。 */
  zoneBasis: "open-chains";
 /** 当前未闭合动作链的条数(热区内 user 链数;0=全部已闭合,热区为空)。 */
  openChains: number;
 /** jev-150m 评分器保护窗 N(仅浮窗小注展示,不是热区边界;import 失败回退 6)。 */
  hotTailNote: number;
 /** 热区增量锚点:最后一条 llm.trace 之后首条增量消息的事件下标;无 llm.trace=null(热区=未闭合链原跨度)。 */
  afterTraceStart: number | null;
 /** journal 尾扫到的原值(≥0,不做 total 钳制;冷区实际切分用 min(frozenCount, total))。 */
  frozenCount: number;
  frozenFrom: "context.prune" | "none";
}

/** journal 最小结构依赖:frozenCount 尾扫与闭合扫描用 readSession(会话索引切片);
 * deriveMessages 运行时还会经它调 journal.readAll(透传给真实实现,测试可两者都给)。 */
export interface ContextZonesJournal {
  readSession(sessionId: string): Array<{ kind?: unknown; payload?: unknown }>;
  readAll?(): Array<{ kind?: unknown; payload?: unknown }>;
}

export interface ContextZonesOptions {
 /** hotTailNote 注入(测试用):优先于 protection-windows 机制配置;仅影响小注,不影响切分。 */
  hotTailNote?: number;
}

/** jev-150m 评分器保护窗兜底值(与 PROTECTION_WINDOWS.scoringHotTailMessages 缺省一致)。 */
const DEFAULT_HOT_TAIL_NOTE = 6;

/** 派生消息最小形态:只消费 content(chars 口径 String(content ?? ""))。 */
type DerivedMessage = { content?: unknown };

/** 闭合边界扫描结果:openStart=未闭合链起点(派生消息下标);openChains=未闭合链数;
 * derivedTotal=按 raw 事件推得的派生消息总数(与 deriveMessages 实际条数的差≈近似误差)。 */
export interface OpenChainScan {
  openStart: number;
  openChains: number;
  derivedTotal: number;
}

/** 热区闭合边界扫描(纯函数,导出供单测;03-concepts :15/:48 口径的最小可用派生)。
 * 闭合/降级事件(与 segment-tracker 的四类段闭合信号对齐):
 * ① message.user=新指令/主题切换(自身开启新链,属热区;此前内容闭合降级)
 * ② message.agent 纯文本且 payload.toolCalls 空/缺失=动作完成(自身降级温区)
 * ③ turn.end / custom(type=task.phase 或 context.path.abandoned;兼容旧 what 写法)
 * =段闭合(此前内容全部降级;与 scanSegmentClosures 同一批判据)
 * ④ context.prune 只有**真实裁中**才算闭合(compacted>0 / policy=reset|growth-spurt);
 * low-context-skip / append-only 是空操作,不得推进热区边界(旧实现把它们当显式声明,
 * 导致面板每步都“热→温”,而机制层没有任何段闭合——判官口径不一致)。
 * 链推进(不闭合):message.agent 带 toolCalls、tool.result。
 * message.agent 带 toolCalls 但当前无开放链(少见:assistant 起手)→ 该 agent 起算新链。 */
export function openChainScanOf(events: Array<{ kind?: unknown; payload?: unknown }>): OpenChainScan {
  let count = 0; // 已推得派生消息数(user/agent/tool.result 各 +1)
  let openStart = 0;
  let openChains = 0;
 /** 当前段出现过的工具目标根(与 segment-tracker 同口径;漂移=主题切换)。 */
  const pathRoots: string[] = [];
  const close = (): void => { openStart = count; openChains = 0; pathRoots.length = 0; };
  for (const e of events) {
    const kind = (e as { kind?: unknown }).kind;
    const payload = (e as { payload?: unknown }).payload as Record<string, unknown> | undefined;
    if (kind === "message.user") {
      count += 1;
      openStart = count - 1; // user ∈ 热区(链锚)
      openChains = 1; // 旧链被新指令闭合
      pathRoots.length = 0;
    } else if (kind === "message.agent") {
      count += 1;
      const calls = payload?.toolCalls;
      if (Array.isArray(calls) && calls.length > 0) {
        if (openChains === 0) { openStart = count - 1; openChains = 1; pathRoots.length = 0; } // 防御:agent 起手链
      } else {
        close(); // 动作完成:链闭合,自身降级温区
      }
    } else if (kind === "tool.result") {
      count += 1;
    } else if (kind === "tool.call") {
 // ② 主题切换结构信号:同段 ≥2 个目标根后切到第三个不同目录 → 漂移(与 tracker 同口径)。
      const root = pathRootOf(payload?.arguments);
      if (root) {
        if (pathRoots.length >= 2 && !pathRoots.includes(root)) {
          close();
          openChains = 1; // 漂移工具调用开启新段
        }
        if (!pathRoots.includes(root)) pathRoots.push(root);
      }
    } else if (kind === "turn.end") {
      close(); // 段闭合:本 turn 全部降级温区
    } else if (kind === "subagent.event" || kind === "subagent.result") {
 // ① 动作完成:子代理终态(与 tracker 的 subagent-done 同口径)。
      if (kind === "subagent.result" || isSubagentTerminal(payload ?? {})) close();
    } else if (kind === "board.update") {
 // ② 主题切换:白板落成(status=done)。
      if (String(payload?.status ?? "") === "done") close();
    } else if (kind === "custom") {
      const eventType = String(payload?.type ?? "");
      const legacyWhat = String(payload?.what ?? "");
      const segmentClose = eventType === "task.phase" || legacyWhat === "task_phase"
        || eventType === "context.path.abandoned" || legacyWhat === "context.path.abandoned"
        || eventType === "goal_progress" || legacyWhat === "goal_progress";
      if (segmentClose) close(); // 段闭合:此前内容全部降级温区
    } else if (kind === "context.prune") {
      const compacted = Number(payload?.compacted ?? 0);
      const policy = String(payload?.policy ?? "");
 // 只有真实裁中才闭合;low-context-skip/append-only 是空操作(与 segment-tracker 判官对齐)。
      if (compacted > 0 || policy === "reset" || policy === "growth-spurt") close(); // 真实裁剪:此前全部闭合
    }
  }
  return { openStart, openChains, derivedTotal: count };
}

/** 增量锚点(纯函数,导出供单测; 全量划分):最后一条 llm.trace 之后的**首条增量消息**
 * (message.user/message.agent/tool.result)事件下标——其后内容=本步新增/未发出,归热区。
 * 无 llm.trace,或末条 trace 之后无增量消息 → null(热区=未闭合链原跨度,不造数)。 */
export function afterTraceStartOf(events: Array<{ kind?: unknown; payload?: unknown }>): number | null {
  let anchor = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if ((events[i] as { kind?: unknown }).kind === "llm.trace") { anchor = i; break; }
  }
  if (anchor < 0) return null;
  for (let i = anchor + 1; i < events.length; i += 1) {
    const k = (events[i] as { kind?: unknown }).kind;
    if (k === "message.user" || k === "message.agent" || k === "tool.result") return i;
  }
  return null;
}

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

/** 派生上下文温度三区(冷/温/热)。只读 journal,不写任何事件、不改请求前缀与压缩行为。
 * @returns 空会话或派生链路不可用时返回 null,不造数。 */
export async function deriveContextZones(
  journal: ContextZonesJournal | undefined | null,
  sessionId: string,
  opts?: ContextZonesOptions,
): Promise<ContextZones | null> {
  if (!journal || typeof journal.readSession !== "function") return null;

 // jev-150m 评分保护窗 N(仅小注):opts 注入 > protection-windows 机制配置 > 6 兜底。
  let hotTailNote = DEFAULT_HOT_TAIL_NOTE;
  if (typeof opts?.hotTailNote === "number" && Number.isFinite(opts.hotTailNote) && opts.hotTailNote >= 0) {
    hotTailNote = Math.floor(opts.hotTailNote);
  } else {
    try {
      const pw = (await import("@lampgenie/runtime/agent/protection-windows")) as unknown as {
        PROTECTION_WINDOWS?: { scoringHotTailMessages?: unknown };
      };
      const n = pw.PROTECTION_WINDOWS?.scoringHotTailMessages;
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) hotTailNote = Math.floor(n);
    } catch { /* 模块不可用=回退 6 小注 */ }
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

 // 会话事件切片:闭合边界扫描 + frozenCount 尾扫 + 增量锚点(读流异常按无记录处理)。
  let events: Array<{ kind?: unknown; payload?: unknown }> = [];
  try {
    const raw = journal.readSession(sessionId);
    if (Array.isArray(raw)) events = raw;
  } catch { /* 读流异常=无闭合/prune/增量记录 */ }
  const scan = openChainScanOf(events);
  let frozen: { frozenCount: number; frozenFrom: "context.prune" | "none" } = { frozenCount: 0, frozenFrom: "none" };
  try {
    frozen = frozenCountOf(events);
  } catch { /* 尾扫异常(理论上不可达:frozenCountOf 纯函数) */ }
  const afterTraceStart = afterTraceStartOf(events);

 // 切分(全量划分):冷区 [0, min(frozenCount,total));热区 = [max(coldEnd,
 // min(openStart, atsDerived)), total) —— 未闭合链与「末条 llm.trace 之后增量」取更早
 // 起点整段并入(冷区优先,重叠让渡);温区 = 两者之间的中段(可为空)。任何消息恰归一区。
 // atsDerived:afterTraceStart 是事件下标,按 openStart 同口径(数 message.user/agent/tool.result
 // 事件)换算成派生消息下标,避免两种下标混算把 trace 后首条消息错切进温区。
  let atsDerived: number | null = null;
  if (afterTraceStart !== null) {
    atsDerived = 0;
    for (let i = 0; i < afterTraceStart && i < events.length; i += 1) {
      const k = (events[i] as { kind?: unknown }).kind;
      if (k === "message.user" || k === "message.agent" || k === "tool.result") atsDerived += 1;
    }
  }
  const hotLen = total - Math.min(scan.openStart, atsDerived ?? scan.openStart);
  const { coldEnd, hotStart } = partitionZones(total, frozen.frozenCount, hotLen);
  return {
    zones: zoneStatsOf(messages, { coldEnd, hotStart }),
    totalMessages: total,
    zoneBasis: "open-chains",
    openChains: scan.openChains,
    hotTailNote,
    afterTraceStart,
    frozenCount: frozen.frozenCount,
    frozenFrom: frozen.frozenFrom,
  };
}
