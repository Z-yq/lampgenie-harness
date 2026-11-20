/**
 * 降级候选队列(缺口#26 起, 切拍板公式;docs/design/02-context-economy §4.1.1/§4.1.2):
 * 温区精简的触发不是「上下文涨到阈值才扫一遍」,而是**段闭合事件入队 + 定价**(§4.1.2);
 * 是否真裁由 §4.1.1 拍板公式裁决:
 * N × (W − W′) × P_cached > (W′ + tail) × P_uncached ⟺ N × W > (W′ + tail) × r
 * W = 裁掉省下的 token(命中价口径的持续收益,每步都付);W′ = 压缩产物(新增冷区上下文,
 * 按未命中价一次性重付);tail = 改写点之后仍保留的热区尾部(turn 末攒批 ≈0);
 * N = 剩余步数估计;r = P_uncached/P_cached,逐模型现算(microcompact.priceRatioOf)。
 * 「作废 ≠ 重付」:被替换旧字节不再随请求发送,只是不再省钱——代价项是 W′+tail,不是作废前缀 B
 * (弃旧 N>r·B/W + B 口径,即缺口#37 的方向取反修复)。
 * 本模块纯函数、零副作用:队列是本地对象,不入队时机、不碰消息、不碰 journal;
 * loop 侧接线时在段闭合事件处 enqueue,在 turn 末整批 settle。
 */

/** jev-150m 降级确认的裁决(§4.1.3③ 表):
 * - keepResult=true + confidence≥0.9 → 回保护区(protect);
 * - keepResult=false + confidence≥0.9 → 可裁候选(eligible);
 * - 低置信/无结论/缺结果 → 回落结构信号(fallback)。 */
export function downgradeConfirmGate(
  result: { keepResult: boolean | undefined; confidence: number } | undefined,
): "protect" | "eligible" | "fallback" {
  if (!result || !Number.isFinite(result.confidence) || result.confidence < 0.9 || result.keepResult === undefined) {
    return "fallback";
  }
  return result.keepResult ? "protect" : "eligible";
}

/** 观察期步数(§4.1.3②:刚闭合段仍保护,至少经过 1 步才开始可裁判定)。 */
export const SEGMENT_OBSERVATION_STEPS = 1;

/** 观察期到期判定(时间/步数,不是 token 数):queuedAtStep 到 currentClock 的步数 ≥ 观察期。 */
export function observationExpired(
  queuedAtStep: number,
  currentClock: number,
  steps = SEGMENT_OBSERVATION_STEPS,
): boolean {
  const need = Math.max(0, Math.floor(Number.isFinite(steps) ? steps : SEGMENT_OBSERVATION_STEPS));
  return Number.isFinite(currentClock) && Number.isFinite(queuedAtStep)
    && currentClock - queuedAtStep >= need;
}

/** 一条降级候选(§4.1.3:段闭合入队时同步定价 W/W′/tail/N)。 */
export interface DegradationCandidate {
 /** 条目标识(= toolCallId;同 id 入队去重)。 */
  id: string;
 /** 工具名(非工具内容为空串)。 */
  tool: string;
 /** 寻址(path/command 等重读凭据)。 */
  where: string;
 /** 结果事件 seq(观察期「仍被引用」结构检查;缺省=不做检查)。 */
  resultSeq?: number;
 /** 产物形态(由 tracker 逐条选择;summary=小模型摘要,placeholder=确定性占位)。 */
  product?: "summary" | "placeholder";
 /** W:裁掉它能省的 token(命中价口径的持续收益,每步都付)。 */
  savedTokensW: number;
 /** W′:压缩产物 token(新增冷区上下文;未命中价口径的一次性代价主体)。 */
  productTokensWPrime: number;
 /** tail:改写点之后仍保留的热区尾部 token(turn 末攒批真裁时 ≈0;§4.1.1 拍板)。 */
  tailTokens: number;
 /** N:入队时的剩余步数估计(裁决时可用更新的 N 覆盖;此处留档供审计)。 */
  remainingStepsN: number;
 /** 入队步号。 */
  queuedAtStep: number;
}

/** settle 的裁决结果:prune=经济上划算可裁;deferred=先欠着,留在 pending。 */
export interface SettleVerdict {
 /** 裁决对象(原样回传,调用方免二次查找)。 */
  candidate: DegradationCandidate;
  prune: boolean;
  reason: "economic" | "deferred";
}

/** 整批裁决结果(设计 §4.1.1:温区整批压缩,tail 是批次共享代价,不是每条各自 tail)。 */
export interface SettleBatchResult {
 /** 经济上批准并已出队的条目。 */
  approved: DegradationCandidate[];
 /** 未批准、仍留在队列的条目数(不含 exclude)。 */
  deferred: number;
  economic: boolean;
  batchW: number;
  batchWPrime: number;
  tailTokens: number;
  remainingStepsN: number;
}

/** 队列句柄(createDegradationQueue 返回;方法均为纯操作,不改入参消息)。 */
export interface DegradationQueue {
 /** 入队(同 id 已存在则忽略,返回是否真的入队)。 */
  enqueue(item: DegradationCandidate): boolean;
 /** 按拍板公式 N×W > (W′+tail)×r 裁决:满足 → {prune:true, reason:"economic"} 并出队;否则留在 pending。
 * tailTokens 可覆盖入队时的估价:turn 末批次≈0;turn 首步应用上一 turn 计划时,
 * 改写点之后还有本轮新 user 段锚,应把它的 token 计入 tail(设计 §4.1.1「tail 随攒批位置变化」)。 */
  settle(item: DegradationCandidate, priceRatio: number, remainingStepsN?: number, tailTokens?: number): SettleVerdict | undefined;
 /** **整批**裁决(段批真裁的正确口径):ΣW/ΣW′ 与共享 tail 一起代入拍板公式。
 * - exclude:观察期仍被引用的 id(留在队列,不参与本批);
 * - tailTokens:最早被改写消息之后的所有字节(含 W′ 产物与未裁尾部);
 * - remainingStepsN:预计剩余步数(由调用方按历史 turn 步数估);
 * 经济 → 批次内全部出队;不经济 → 全部留队(设计:真裁按批,不逐条放行)。 */
  settleBatch(priceRatio: number, opts: {
    remainingStepsN: number;
    tailTokens: number;
    exclude?: ReadonlySet<string>;
  }): SettleBatchResult;
 /** 显式批准并出队(调用方已用 planSegmentBatch 的整批 W/W′/tail 做经济裁决)。 */
  approve(ids: ReadonlySet<string>): DegradationCandidate[];
 /** 从队列移除已清 id(冻结区重放/普通清理已经应用,不再参与后续 ΣW)。 */
  drop(ids: ReadonlySet<string>): number;
 /** 待裁决条目(入队顺序;返回浅拷贝,外部改动不影响内部)。 */
  pending(): DegradationCandidate[];
 /** 按「消息索引离尾最近优先」排序待裁决条目(§4.1.1 结论 1:真裁点越靠尾越便宜,tail 越小)。 */
  orderByTailProximity(messages: readonly { role: string; toolCallId?: string }[]): DegradationCandidate[];
}

export function createDegradationQueue(): DegradationQueue {
  const queue: DegradationCandidate[] = [];

  const indexOfId = (id: string): number => queue.findIndex((c) => c.id === id);

  return {
    enqueue(item: DegradationCandidate): boolean {
      if (indexOfId(item.id) >= 0) return false; // 同 id 去重:降级事件可能重复触发
      queue.push(item);
      return true;
    },

    settle(item: DegradationCandidate, priceRatio: number, remainingStepsN?: number, tailTokens?: number): SettleVerdict | undefined {
      const at = indexOfId(item.id);
      if (at < 0) return undefined; // 不在队列(未入队/已裁决):不猜,显式 undefined
      const candidate = queue[at]!;
      const n = remainingStepsN ?? candidate.remainingStepsN;
      const w = candidate.savedTokensW;
      const tail = tailTokens !== undefined && Number.isFinite(tailTokens) && tailTokens >= 0
        ? Math.floor(tailTokens)
        : candidate.tailTokens;
      const cost = candidate.productTokensWPrime + tail;
 // N×(W−W′)×P_cached > (W′+tail)×P_uncached ⟺ N×W > (W′+tail)×r(严格大于;
 // W′≪W 时 W−W′≈W)。W≤0 永不划算(deferred);代价项=W′+tail(拍板口径)。
      const economic = w > 0 && n * w > cost * priceRatio;
      if (!economic) {
        return { candidate, prune: false, reason: "deferred" };
      }
      queue.splice(at, 1);
      return { candidate, prune: true, reason: "economic" };
    },

    settleBatch(priceRatio: number, opts: {
      remainingStepsN: number;
      tailTokens: number;
      exclude?: ReadonlySet<string>;
    }): SettleBatchResult {
      const exclude = opts.exclude ?? new Set<string>();
      const eligible = queue.filter((c) => !exclude.has(c.id));
      const batchW = eligible.reduce((s, c) => s + Math.max(0, c.savedTokensW), 0);
      const batchWPrime = eligible.reduce((s, c) => s + Math.max(0, c.productTokensWPrime), 0);
      const n = Number.isFinite(opts.remainingStepsN) ? Math.max(1, Math.floor(opts.remainingStepsN)) : 1;
      const tail = Number.isFinite(opts.tailTokens) ? Math.max(0, Math.floor(opts.tailTokens)) : 0;
 // 设计 §4.1.1:整批压缩的代价项 = ΣW′ + tail(共享);N 为预计剩余步数。
      const economic = eligible.length > 0 && batchW > 0
        && n * batchW > (batchWPrime + tail) * priceRatio;
      if (!economic) {
        return { approved: [], deferred: eligible.length, economic: false, batchW, batchWPrime, tailTokens: tail, remainingStepsN: n };
      }
      const ids = new Set(eligible.map((c) => c.id));
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (ids.has(queue[i]!.id)) queue.splice(i, 1);
      }
      return { approved: eligible, deferred: 0, economic: true, batchW, batchWPrime, tailTokens: tail, remainingStepsN: n };
    },

    approve(ids: ReadonlySet<string>): DegradationCandidate[] {
      if (!ids || ids.size === 0) return [];
      const approved: DegradationCandidate[] = [];
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const c = queue[i]!;
        if (ids.has(c.id)) { approved.push(c); queue.splice(i, 1); }
      }
      return approved.reverse(); // 保持入队顺序
    },

    drop(ids: ReadonlySet<string>): number {
      if (!ids || ids.size === 0) return 0;
      let removed = 0;
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (ids.has(queue[i]!.id)) { queue.splice(i, 1); removed += 1; }
      }
      return removed;
    },

    pending(): DegradationCandidate[] {
 // 逐项浅拷贝:外部改动不影响内部队列的裁决依据
      return queue.map((c) => ({ ...c }));
    },

    orderByTailProximity(messages: readonly { role: string; toolCallId?: string }[]): DegradationCandidate[] {
 // 离尾最近 = tool 消息下标最大;无对应消息的条目(已折叠/重建)排最后,保持入队顺序。
      const pos = new Map<string, number>();
      messages.forEach((m, i) => {
        if (m.role === "tool" && m.toolCallId) pos.set(m.toolCallId, i);
      });
      const at = (c: DegradationCandidate): number => pos.get(c.id) ?? -1;
      return [...queue].sort((a, b) => at(b) - at(a));
    },
  };
}
