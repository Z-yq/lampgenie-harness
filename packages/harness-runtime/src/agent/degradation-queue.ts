/**
 * 降级候选队列(缺口#26,docs/design/02-context-economy/04-mechanisms §4.1.2):
 * 温区精简的触发不应是「上下文涨到阈值才扫一遍」,而应是**热区条目降级进温区的那一刻**——
 * 降级事件负责「入队 + 定价」,是否真裁由 §4.1.1 的盈亏平衡判据裁决:
 * N × W × P_cached > B × P_uncached ⟺ N > r · B / W
 * N = 剩余步数估计,W = 被裁掉的温区 token,B = 失效的已缓存前缀 token,
 * r = P_uncached / P_cached ≈ 50(源码口径「uncached 单价是命中的 50 倍」)。
 * 本模块纯函数、零副作用:队列是本地对象,不入队时机、不碰消息、不碰 journal;
 * loop 侧接线时在降级事件处 enqueue,在经济门裁决处 settle。
 */

/** 一条降级候选(§4.1.3 ①:降级事件入队时同步定价)。 */
export interface DegradationCandidate {
 /** 条目标识(工具结果 = toolCallId;同 id 入队去重)。 */
  id: string;
 /** 工具名(非工具内容为空串)。 */
  tool: string;
 /** 寻址(path/command 等重读凭据)。 */
  where: string;
 /** W:裁掉它能省的 token(命中价口径的持续收益,每步都付)。 */
  savedTokensW: number;
 /** B:改写导致失效的已缓存前缀 token(未命中价口径的一次性代价)。 */
  breakCostTokensB: number;
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

/** 队列句柄(createDegradationQueue 返回;方法均为纯操作,不改入参消息)。 */
export interface DegradationQueue {
 /** 入队(同 id 已存在则忽略,返回是否真的入队)。 */
  enqueue(item: DegradationCandidate): boolean;
 /** 按 N > r·B/W 裁决:满足 → {prune:true, reason:"economic"} 并出队;否则留在 pending。 */
  settle(item: DegradationCandidate, priceRatio: number, remainingStepsN?: number): SettleVerdict | undefined;
 /** 待裁决条目(入队顺序;返回浅拷贝,外部改动不影响内部)。 */
  pending(): DegradationCandidate[];
 /** 按「消息索引离尾最近优先」排序待裁决条目(§4.1.1 结论:削减位置越靠尾越便宜,B 越小)。 */
  orderByTailProximity(messages: readonly { role: string; toolCallId?: string }[]): DegradationCandidate[];
}

/** 缺省价差比 r=P_uncached/P_cached(与 microcompact 的 GENIE_PRICE_RATIO 同源;此处显式传参)。 */
export function createDegradationQueue(): DegradationQueue {
  const queue: DegradationCandidate[] = [];

  const indexOfId = (id: string): number => queue.findIndex((c) => c.id === id);

  return {
    enqueue(item: DegradationCandidate): boolean {
      if (indexOfId(item.id) >= 0) return false; // 同 id 去重:降级事件可能重复触发
      queue.push(item);
      return true;
    },

    settle(item: DegradationCandidate, priceRatio: number, remainingStepsN?: number): SettleVerdict | undefined {
      const at = indexOfId(item.id);
      if (at < 0) return undefined; // 不在队列(未入队/已裁决):不猜,显式 undefined
      const candidate = queue[at]!;
      const n = remainingStepsN ?? candidate.remainingStepsN;
      const w = candidate.savedTokensW;
      const b = candidate.breakCostTokensB;
 // N×W×P_cached > B×P_uncached ⟺ N×W > B×r ⟺ N > r·B/W(W<=0 时永不划算,判 deferred)
      const economic = w > 0 && n * w > b * priceRatio;
      if (!economic) {
        return { candidate, prune: false, reason: "deferred" };
      }
      queue.splice(at, 1);
      return { candidate, prune: true, reason: "economic" };
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
