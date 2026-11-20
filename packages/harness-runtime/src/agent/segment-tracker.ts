/**
 * 段闭合追踪(段化改造;docs/design/02-context-economy §4.1.3 + 05-pseudocode 段G):
 * 降级判定单位 = 段(segment)——段锚 = user message 原文(保留不压),段边界由闭合事件判定:
 * ① 动作完成:turn 结束(最硬边界)/ task_phase 推进;
 * ② 主题切换:焦点边界切换(focus-tracker 派生);
 * ③ 显式声明:context.path.abandoned(path-prune 已有)。
 * 闭合**只记账入队+定价**(W/W′/tail/N),不当场裁——每段一压=步步破前缀,反模式(§4.1.3);
 * 真裁攒批在 turn 末(degradationQueue.settle 整批裁决,microcompact 段批档执行)。
 * 开放段逐字不动;user message 段锚永不精简(唯一例外 auto-compact 档④,不在此模块)。
 * 本模块纯函数、零 IO:输入 journal 事件子集,输出「已闭合段的 tool 结果定价清单」。
 */

import { isConsumed, isSubagentTerminal } from "./focus-tracker";

/** 段闭合的判据来源(§4.1.3 三判据)。 */
export type SegmentCloseReason =
  | "turn-end" // ① 动作完成:turn 结束(最硬边界)
  | "phase-advance" // ① 动作完成:task_phase 推进(阶段边界=子目标完成)
  | "subagent-done" // ① 动作完成:子代理终态(设计 §4.1.3 的 subagent 完成信号)
  | "board-advance" // ② 主题切换:白板落成(status=done,子目标完成)
  | "goal-advance" // ② 主题切换:主线 goal_progress(有桥接事件时)
  | "focus-switch" // ② 主题切换:焦点段切换(deriveFocusSegments 边界)
  | "target-drift" // ② 主题切换:工具序列目标漂移(结构信号,零 LLM)
  | "path-abandoned"; // ③ 显式声明:context.path.abandoned

/** 一段已闭合区间内的 tool 结果定价条目(入队 degradation-queue 用)。 */
export interface SegmentPricedItem {
 /** = toolCallId(degradation-queue 同 id 去重)。 */
  id: string;
  tool: string;
  where: string;
 /** 结果事件 seq(观察期「仍被引用」结构检查用)。 */
  resultSeq: number;
 /** W:裁掉省下的 token(估算,approxTokensOfChars 口径)。 */
  savedTokensW: number;
 /** W′:压缩产物 token(占位预估;确定性占位≈CLEARED_PLACEHOLDER 长度级)。 */
  productTokensWPrime: number;
 /** 产物形态:summary=小模型摘要(第一手段);placeholder=确定性占位(兜底轨)。
 * tracker 按 N=1 经济速算逐条选择:摘要不划算的条目回落占位,不整批被摘要成本拖死。 */
  product: "summary" | "placeholder";
 /** 只入队观察、不真裁:path-abandoned 已由 path-prune 主裁(设计 §4.8),
 * 段批队列不再重复折叠同一批结果。 */
  observeOnly?: boolean;
 /** tail:闭合边界之后仍保留的消息字符(token)。 */
  tailTokens: number;
}

/** 派生输入的最小事件形状(kind-based,journal 事件的子集即可;与 focus-tracker 同构)。 */
export interface SegmentEvent {
  type: string;
  seq: number;
  payload?: unknown;
}

/** 一条已闭合段(边界+定价条目;供审计与入队)。 */
export interface ClosedSegment {
 /** 段标识:`<closeReason>:<seq 起点或事件标识>`。 */
  segmentId: string;
  closeReason: SegmentCloseReason;
 /** 闭合事件 seq。 */
  closeSeq: number;
  items: SegmentPricedItem[];
}

/** tool 事件的最小提取形状(从 tool.call/tool.result 对提取)。 */
interface ToolEntry {
  toolCallId: string;
  name: string;
  argsWhere: string;
  resultChars: number;
 /** 结果原文(仅用于「可清工具/错误保护」准入判定;不复制,引用 journal 字符串)。 */
  content: string;
 /** 结果事件 seq(段边界定位用)。 */
  resultSeq: number;
}

/** 占位产物的缺省字符规模(与 microcompact CLEARED_PLACEHOLDER_EST_CHARS 同量级;保守取 160)。 */
export const SEGMENT_PLACEHOLDER_EST_CHARS = 160;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 工具目标粗粒度归类(零 LLM 结构信号):只认 path 参数,取路径末两段目录作为目标根。
 * `apps/gateway/src/a.ts` → `gateway/src`;`packages/runtime/src/b.ts` → `runtime/src`;
 * 同目录不同文件不触发漂移;command/pattern 不参与(误报率高)。 */
export function pathRootOf(argumentsRaw: unknown): string | undefined {
  let args: unknown = argumentsRaw;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return undefined; }
  }
  if (!args || typeof args !== "object") return undefined;
  const p = (args as Record<string, unknown>).path;
  if (typeof p !== "string" || !p) return undefined;
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.length >= 3 ? parts.slice(-3, -1).join("/") : parts.slice(0, 2).join("/");
}

/**
 * 从事件序列提取 tool 条目(tool.call 的 name/arguments + tool.result 的 content 长度配对)。
 * 纯函数;缺结果/缺调用的脏事件跳过。arguments 里取 path/command 之一当寻址(where)。
 */
export function collectToolEntries(events: readonly SegmentEvent[]): ToolEntry[] {
  const out: ToolEntry[] = [];
  const calls = new Map<string, { name: string; where: string }>();
  const seqOf = (e: SegmentEvent, i: number): number =>
    typeof e?.seq === "number" && Number.isFinite(e.seq) ? e.seq : i;
  events.forEach((e, i) => {
    const type = str(e?.type);
    const p = asRecord(e?.payload);
    if (type === "tool.call") {
      const id = str(p.toolCallId);
      if (!id) return;
 // journal 的 tool.call.arguments 是 **JSON 字符串**(不是对象);不解析会导致 where 全空,
 // 既无法做「仍被引用」判断,也无法满足 microcompact 的可重读寻址要求。
      let args = asRecord(p.arguments);
      if (typeof p.arguments === "string") {
        try {
          const parsed = JSON.parse(p.arguments) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch { /* 非法 JSON:where 留空 */ }
      }
      const where = str(args.path) || str(args.command) || str(args.pattern) || str(args.url) || "";
      calls.set(id, { name: str(p.name), where });
      return;
    }
    if (type === "tool.result") {
      const id = str(p.toolCallId);
      const call = calls.get(id);
      if (!id || !call) return;
      const content = typeof p.content === "string" ? p.content : "";
      out.push({
        toolCallId: id,
        name: call.name,
        argsWhere: call.where,
        resultChars: content.length,
        content,
        resultSeq: seqOf(e, i),
      });
      calls.delete(id);
    }
  });
  return out;
}

/** 已应用段批台账回放:`context.segment.applied` 事件带 ids,新 loop 实例
 * 从 journal 重放后跳过这些 id,保证「每条内容只随其所属段闭合降级一次」。
 * 兼容生产 `payload.type` 与旧 `payload.what` 两种形状。 */
export function collectAppliedSegmentIds(events: readonly SegmentEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of Array.isArray(events) ? events : []) {
    if (str(e?.type) !== "custom") continue;
    const p = asRecord(e?.payload);
    const kind = str(p.type) || str(p.what);
    if (kind !== "context.segment.applied") continue;
    const ids = Array.isArray(p.ids) ? p.ids : [];
    for (const id of ids) if (typeof id === "string" && id) out.add(id);
  }
  return out;
}

/** 观察期结构检查(§4.1.3 三段式②):该结果之后是否还有工具调用命中同一 where 寻址。
 * 命中=仍被当前工作引用 → 继续保护(settle 延后);无命中才进入可裁候选。
 * 零 LLM;argsText 包含 where 子串即算命中(与 focus-tracker.isConsumed 同口径)。 */
export function isCandidateStillReferenced(
  candidate: { tool: string; where: string; resultSeq?: number },
  events: readonly SegmentEvent[],
): boolean {
  if (typeof candidate.resultSeq !== "number" || !Number.isFinite(candidate.resultSeq)) return false;
  const laterCalls: Array<{ tool: string; argsText: string }> = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (str(e?.type) !== "tool.call") continue;
    const seq = typeof e.seq === "number" && Number.isFinite(e.seq) ? e.seq : -1;
    if (seq <= candidate.resultSeq) continue;
    const p = asRecord(e?.payload);
    const args = p.arguments;
    laterCalls.push({
      tool: str(p.name),
      argsText: typeof args === "string" ? args : JSON.stringify(args ?? ""),
    });
  }
  return isConsumed({ tool: candidate.tool, where: candidate.where }, laterCalls);
}

/**
 * 段闭合扫描:识别新出现的闭合事件并产出「该边界之前的 tool 结果定价清单」。
 * 判定口径(每类闭合事件一个):
 * - turn-end:事件 type=turn.end → 其 seq 之前的全部 tool 结果属已闭合段;
 * - phase-advance:custom 事件 type=task.phase(生产形状)/ what=task_phase(旧 journal 兼容)
 * → 同上(阶段边界=子目标完成);
 * - focus-switch:焦点段边界切换(message.user 开新焦点段且 ≠ 当前焦点;主题切换);
 * - path-abandoned:custom 事件 type=context.path.abandoned(生产形状)/ what=同值(旧兼容)
 * → 声明点之前的 tool 结果视作闭合(失败路径由 path-prune 主裁;这里只入队观察,不重复折叠)。
 * 幂等:调用方持 seenCloses(segmentId 集合),已见过的闭合边界不重复产出。
 * 纯函数:不改入参、不 throw、不落账。
 */
export interface SegmentScanResult {
 /** 新闭合的段(可能多条;每条含定价条目;segmentId 幂等键)。 */
  closed: ClosedSegment[];
 /** 扫描后应记录的当前焦点段 id(focus-switch 时有值)。 */
  nextFocusId?: string;
}

export function scanSegmentClosures(
  events: readonly SegmentEvent[],
  seenCloses: ReadonlySet<string>,
  opts?: {
    currentFocusId?: string;
    focusIdsBySeq?: ReadonlyMap<number, string>;
 /** 摘要产物 W′ 的 token 估价(配置小模型摘要轨时传 `SEGMENT_SUMMARY_EST_TOKENS`）。
 * 缺省=不启用摘要,全部按确定性占位。 */
    summaryTokensWPrime?: number;
 /** 价差比 r(P_uncached/P_cached);用于逐条选择 summary/placeholder(N=1 速算)。
 * 缺省 10(拍板非 deepseek 统一口径)。 */
    priceRatio?: number;
 /** 可清工具准入(与 microcompact 实际 clear 同一集合):不可清/硬保护/错误结果不进定价,
 * 否则 gate 的 ΣW 会包含 executor 永远不会清的结果(回放 web 会话已注意)。 */
    isPricedTool?: (tool: string, content: string) => boolean;
  },
): SegmentScanResult {
  const list = Array.isArray(events) ? events : [];
  const tools = collectToolEntries(list);
  const placeholderTokensWPrime = Math.floor(SEGMENT_PLACEHOLDER_EST_CHARS / 4);
  const summaryTokensWPrime = opts?.summaryTokensWPrime !== undefined && Number.isFinite(opts.summaryTokensWPrime)
    ? Math.max(1, Math.floor(opts.summaryTokensWPrime))
    : undefined;
  const priceRatio = opts?.priceRatio !== undefined && Number.isFinite(opts.priceRatio) && opts.priceRatio > 0
    ? opts.priceRatio
    : 10;
  const closed: ClosedSegment[] = [];
  let nextFocusId: string | undefined;
 /** 当前段出现过的工具目标根(路径末两段);闭合时清空。 */
  const pathRoots: string[] = [];
 /** 上一个闭合边界 seq:每条结果只在其所属段闭合时定价一次(§4.1.3)。 */
  let lastCloseSeq = -1;
 /** 已见过的闭合边界:跳过产出但仍推进 lastCloseSeq/重置目标根(重扫时不能跨段累计)。 */
  const skipSeen = (key: string, seq: number): boolean => {
    if (!seenCloses.has(key)) return false;
    lastCloseSeq = Math.max(lastCloseSeq, seq);
    pathRoots.length = 0;
    return true;
  };

  const priceBefore = (boundarySeq: number, reason: SegmentCloseReason, segmentId: string): void => {
    const items: SegmentPricedItem[] = [];
    for (const t of tools) {
      if (t.resultSeq >= boundarySeq) continue;
      if (t.resultSeq <= lastCloseSeq) continue; // 已随上一段闭合定价过:每条内容只降级一次
      if (t.resultChars < 2000) continue; // 与组清理一致:小结果不入经济账(<2000 字符省不出占位空间)
      if (!t.argsWhere) continue; // 无可重读寻址:microcompact 不会清(不可回查)
      if (opts?.isPricedTool && !opts.isPricedTool(t.name, t.content)) continue; // 与 executor 同准入
      const savedTokensW = Math.floor(t.resultChars / 4); // chars→token 粗口径(与 loop 旧入队一致)
 // 逐条选产物:摘要按 N=1 速算不划算就回落占位(不整批被摘要成本拖死);
 // 经济门 settle 仍会用实际 W′ 再裁决一次(这里只决定「用哪种产物形态」)。
      const useSummary = summaryTokensWPrime !== undefined && savedTokensW > summaryTokensWPrime * priceRatio;
      items.push({
        id: t.toolCallId,
        tool: t.name,
        where: t.argsWhere,
        resultSeq: t.resultSeq,
        savedTokensW,
        productTokensWPrime: useSummary ? summaryTokensWPrime! : placeholderTokensWPrime,
        product: useSummary ? "summary" : "placeholder",
        ...(reason === "path-abandoned" ? { observeOnly: true } : {}),
        tailTokens: 0, // turn 末攒批真裁:闭合边界之后到 turn 末 ≈0(§4.1.1 拍板)
      });
    }
    closed.push({ segmentId, closeReason: reason, closeSeq: boundarySeq, items });
    lastCloseSeq = Math.max(lastCloseSeq, boundarySeq); // 下一段只定价其后的结果
    pathRoots.length = 0; // 新段重新累计目标根
  };

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const type = str(e?.type);
    const p = asRecord(e?.payload);
    const seq = typeof e?.seq === "number" && Number.isFinite(e.seq) ? e.seq : i;

    if (type === "tool.call") {
 // ② 主题切换的结构信号:同段已出现 ≥2 个目标根后,切到第三个不同目录 → 漂移闭合。
 // 误判闭合只增加温区候选(经济门再拦),误判开放只多保护一段(方向安全,§4.1.3)。
      const root = pathRootOf(p.arguments);
      if (root) {
        if (pathRoots.length >= 2 && !pathRoots.includes(root)) {
          const key = `target-drift:${seq}`;
          if (!seenCloses.has(key)) priceBefore(seq, "target-drift", key);
        }
        if (!pathRoots.includes(root)) pathRoots.push(root);
      }
      continue;
    }
    if (type === "turn.end") {
      const key = `turn-end:${seq}`;
      if (skipSeen(key, seq)) continue;
      priceBefore(seq, "turn-end", key);
      continue;
    }
    if (type === "subagent.result" || (type === "subagent.event" && isSubagentTerminal(p))) {
 // ① 动作完成:子代理终态(§4.1.3 判据①;父段此前的工具结果可进入观察期)。
      const key = `subagent-done:${seq}`;
      if (skipSeen(key, seq)) continue;
      priceBefore(seq, "subagent-done", key);
      continue;
    }
    if (type === "board.update" && str(p.status) === "done") {
 // ② 主题切换:白板落成(子目标完成;board.update status=done 是确定性信号)。
      const key = `board-done:${seq}`;
      if (skipSeen(key, seq)) continue;
      priceBefore(seq, "board-advance", key);
      continue;
    }
    if (type === "custom") {
 // 生产事件形状是 payload.type("task.phase" / "context.path.abandoned");
 // 旧 journal/单测曾用 payload.what("task_phase" / "context.path.abandoned")。
 // 两种都认,segmentId 归一,避免同一闭合边界因字段名不同重复入队。
      const eventType = str(p.type);
      const legacyWhat = str(p.what);
      const phaseClose = eventType === "task.phase" || legacyWhat === "task_phase";
      const pathClose = eventType === "context.path.abandoned" || legacyWhat === "context.path.abandoned";
      if (phaseClose || pathClose) {
        const canonical = phaseClose ? "task_phase" : "context.path.abandoned";
        const key = `${canonical}:${seq}`;
        if (skipSeen(key, seq)) continue;
        priceBefore(seq, phaseClose ? "phase-advance" : "path-abandoned", key);
        continue;
      }
 // ② 主题切换:主线推进(有 journal 桥接事件时;当前 world_model 写 atlas 仓,
 // 会话 journal 未必有该事件——保留识别,桥接见 world-model-tool 的 custom goal_progress)。
      const goalClose = eventType === "goal_progress" || legacyWhat === "goal_progress";
      if (goalClose) {
        const key = `goal-progress:${seq}`;
        if (skipSeen(key, seq)) continue;
        priceBefore(seq, "goal-advance", key);
        continue;
      }
    }
    if (type === "message.user" && opts?.focusIdsBySeq) {
      const fid = opts.focusIdsBySeq.get(seq);
      if (fid !== undefined && opts.currentFocusId !== undefined && fid !== opts.currentFocusId) {
 // 焦点切换:用户消息边界(=focus-tracker 段起点)作为主题切换闭合。
        const key = `focus-switch:${seq}`;
        if (skipSeen(key, seq)) continue;
        priceBefore(seq, "focus-switch", key);
        nextFocusId = fid;
      }
    }
  }
  return { closed, ...(nextFocusId !== undefined ? { nextFocusId } : {}) };
}

/**
 * 观察期候选挑选(确认器 shadow 调度用;§4.1.3③ 语义兜底):
 * 挑「入队 ≥1 步之后」(异步滞后一步)的最早一条 pending 候选(每步 ≤1 条)。
 * 纯函数;队列自身不持步进,由调用方传 currentStep。
 */
export function pickConfirmDue(
  pending: readonly { id: string; tool: string; where: string; queuedAtStep: number }[],
  currentStep: number,
): { id: string; tool: string; where: string } | undefined {
  for (const c of pending) {
    if (currentStep - c.queuedAtStep >= 1) return { id: c.id, tool: c.tool, where: c.where };
  }
  return undefined;
}
