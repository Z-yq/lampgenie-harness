import { describe, it, expect } from "vitest";
import { createDegradationQueue, type DegradationCandidate } from "../src/agent/degradation-queue";

/**
 * 缺口#26:降级事件入队(纯函数、零副作用)。
 * enqueue 同 id 去重;settle 按 N > r·B/W 裁决(economic 裁/deferred 欠);
 * orderByTailProximity 按 tool 消息下标离尾最近优先。
 */

function cand(id: string, w: number, b: number, n = 10): DegradationCandidate {
  return { id, tool: "read_file", where: `src/${id}.ts`, savedTokensW: w, breakCostTokensB: b, remainingStepsN: n, queuedAtStep: 1 };
}

describe("degradation-queue(缺口#26)", () => {
  it("enqueue 同 id 去重:第二次入队返回 false,pending 仍只有一条", () => {
    const q = createDegradationQueue();
    expect(q.enqueue(cand("c1", 1000, 100))).toBe(true);
    expect(q.enqueue(cand("c1", 2000, 200))).toBe(false);
    expect(q.pending()).toHaveLength(1);
    expect(q.pending()[0]!.savedTokensW).toBe(1000); // 保留首份,不被覆盖
  });

  it("settle 边界:N > r·B/W 才 economic;否则 deferred 且留在 pending", () => {
    const q = createDegradationQueue();
 // N=10, W=1000, B=100, r=50:10×1000=10000 < 50×100=5000? 否,10000 > 5000 → economic。
    q.enqueue(cand("e1", 1000, 100, 10));
    const v1 = q.settle(q.pending()[0]!, 50);
    expect(v1?.prune).toBe(true);
    expect(v1?.reason).toBe("economic");
    expect(q.pending()).toHaveLength(0); // economic 出队

 // N=2, W=100, B=1000, r=50:2×100=200 < 50000 → deferred。
    q.enqueue(cand("d1", 100, 1000, 2));
    const v2 = q.settle(q.pending()[0]!, 50);
    expect(v2?.prune).toBe(false);
    expect(v2?.reason).toBe("deferred");
    expect(q.pending()).toHaveLength(1); // deferred 留队

 // 精确边界:N·W == B·r(不大于)→ deferred(判据是严格大于)。
    q.enqueue(cand("b1", 100, 20, 10)); // 10×100=1000 == 50×20=1000
    const v3 = q.settle(q.pending().find((c) => c.id === "b1")!, 50);
    expect(v3?.prune).toBe(false);
    expect(v3?.reason).toBe("deferred");

 // W=0 永不划算 → deferred。
    q.enqueue(cand("z0", 0, 100, 10));
    const v4 = q.settle(q.pending().find((c) => c.id === "z0")!, 50);
    expect(v4?.reason).toBe("deferred");
  });

  it("settle 可用更新的 N 覆盖入队留档(候选越往后 N 越小 → 更不划算)", () => {
    const q = createDegradationQueue();
    q.enqueue(cand("n1", 1000, 100, 10)); // 入队时 N=10:economic
    const late = q.settle(q.pending()[0]!, 50, 1); // 裁决时只剩 1 步:1×1000 < 50×100
    expect(late?.prune).toBe(false);
    expect(late?.reason).toBe("deferred");
  });

  it("settle 未入队/已裁决的条目返回 undefined", () => {
    const q = createDegradationQueue();
    expect(q.settle(cand("ghost", 1000, 1), 50)).toBeUndefined();
  });

  it("orderByTailProximity:消息下标大的(离尾近)排前,无消息映射的排最后", () => {
    const q = createDegradationQueue();
    q.enqueue(cand("t1", 10, 1)); // 下标 1
    q.enqueue(cand("t2", 10, 1)); // 下标 3
    q.enqueue(cand("nomatch", 10, 1)); // 无对应消息
    const messages = [
      { role: "user" },
      { role: "tool", toolCallId: "t1" },
      { role: "assistant" },
      { role: "tool", toolCallId: "t2" },
    ];
    const ordered = q.orderByTailProximity(messages);
    expect(ordered.map((c) => c.id)).toEqual(["t2", "t1", "nomatch"]);
  });

  it("纯函数:pending 返回浅拷贝,外部改动不影响内部队列", () => {
    const q = createDegradationQueue();
    q.enqueue(cand("p1", 10, 1));
    q.pending()[0]!.savedTokensW = 999;
    expect(q.pending()[0]!.savedTokensW).toBe(10);
  });
});
