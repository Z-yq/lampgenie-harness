import { describe, it, expect } from "vitest";
import {
  createDegradationQueue, observationExpired, downgradeConfirmGate, type DegradationCandidate,
} from "../src/agent/degradation-queue";

/**
 * 切拍板公式(§4.1.1):settle 按 N×W > (W′+tail)×r 裁决。
 * enqueue 同 id 去重;orderByTailProximity 按 tool 消息下标离尾最近优先。
 */

function cand(id: string, w: number, wPrime: number, tail: number, n = 10): DegradationCandidate {
  return { id, tool: "read_file", where: `src/${id}.ts`, savedTokensW: w, productTokensWPrime: wPrime, tailTokens: tail, remainingStepsN: n, queuedAtStep: 1 };
}

describe("degradation-queue(拍板公式)", () => {
  it("jev-150m 确认裁决:高置信 keep→protect、drop→eligible、低置信→fallback", () => {
    expect(downgradeConfirmGate({ keepResult: true, confidence: 0.95 })).toBe("protect");
    expect(downgradeConfirmGate({ keepResult: false, confidence: 0.95 })).toBe("eligible");
    expect(downgradeConfirmGate({ keepResult: true, confidence: 0.6 })).toBe("fallback");
    expect(downgradeConfirmGate({ keepResult: undefined, confidence: 0.9 })).toBe("fallback");
    expect(downgradeConfirmGate(undefined)).toBe("fallback");
  });

  it("观察期到期判定:步数维度,未到期不取得可裁资格", () => {
    expect(observationExpired(0, 0)).toBe(false); // 闭合当步
    expect(observationExpired(0, 1)).toBe(true); // 至少 1 步
    expect(observationExpired(3, 4, 2)).toBe(false);
    expect(observationExpired(3, 5, 2)).toBe(true);
    expect(observationExpired(5, 4, 1)).toBe(false); // 时钟回退不猜
  });
  it("enqueue 同 id 去重:第二次入队返回 false,pending 仍只有一条", () => {
    const q = createDegradationQueue();
    expect(q.enqueue(cand("c1", 1000, 40, 0))).toBe(true);
    expect(q.enqueue(cand("c1", 2000, 40, 0))).toBe(false);
    expect(q.pending()).toHaveLength(1);
    expect(q.pending()[0]!.savedTokensW).toBe(1000); // 保留首份,不被覆盖
  });

  it("settle 边界:N×W > (W′+tail)×r 才 economic;否则 deferred 且留在 pending", () => {
    const q = createDegradationQueue();
 // N=10, W=1000, W′=40, tail=0, r=10:10×1000=10000 > 400 → economic。
    q.enqueue(cand("e1", 1000, 40, 0, 10));
    const v1 = q.settle(q.pending()[0]!, 10);
    expect(v1?.prune).toBe(true);
    expect(v1?.reason).toBe("economic");
    expect(q.pending()).toHaveLength(0); // economic 出队

 // N=2, W=100, W′=40, tail=1000, r=10:200 < 10400 → deferred。
    q.enqueue(cand("d1", 100, 40, 1000, 2));
    const v2 = q.settle(q.pending()[0]!, 10);
    expect(v2?.prune).toBe(false);
    expect(v2?.reason).toBe("deferred");
    expect(q.pending()).toHaveLength(1); // deferred 留队

 // 精确边界:N·W == (W′+tail)·r(不大于)→ deferred(判据是严格大于)。
    q.enqueue(cand("b1", 100, 40, 60, 10)); // 10×100=1000 == 10×100=1000
    const v3 = q.settle(q.pending().find((c) => c.id === "b1")!, 10);
    expect(v3?.prune).toBe(false);
    expect(v3?.reason).toBe("deferred");

 // W=0 永不划算 → deferred。
    q.enqueue(cand("z0", 0, 40, 0, 10));
    const v4 = q.settle(q.pending().find((c) => c.id === "z0")!, 10);
    expect(v4?.reason).toBe("deferred");

 // 拍板速算(r=10、N=1 最保守):W/W′ > 10 才 economic——大条目(4000 tok vs 产物 40)通过。
    q.enqueue(cand("s1", 4000, 40, 0, 1));
    const v5 = q.settle(q.pending().find((c) => c.id === "s1")!, 10);
    expect(v5?.prune).toBe(true);
 // 产物与 W 同量级(W/W′=1.25 < 10)→ deferred:「≥10 倍压缩产物才值得压」。
    q.enqueue(cand("s2", 500, 400, 0, 1));
    const v6 = q.settle(q.pending().find((c) => c.id === "s2")!, 10);
    expect(v6?.prune).toBe(false);
  });

  it("拍板口径:B 不再是代价项——800k 前缀在改写点之前不算代价(tail 才算)", () => {
    const q = createDegradationQueue();
 // 旧 B 口径:B=200000、r=10、N=1 → 200000×10 巨大 → 永远 deferred;
 // 拍板口径:W=5000、W′=40、tail=0 → 1×5000 > 400 → economic(前缀在改写点之前=仍命中,不算重付)。
    q.enqueue(cand("bigPrefix", 5000, 40, 0, 1));
    const v = q.settle(q.pending()[0]!, 10);
    expect(v?.prune).toBe(true);
  });

  it("settle tail 覆盖:turn 首步把新 user 段锚计入代价,不按入队时的 tail=0 误批", () => {
    const q = createDegradationQueue();
 // W=1000、W′=40、r=10、N=1:tail=0 时 1000 > 400 → economic。
    q.enqueue(cand("t0", 1000, 40, 0, 1));
    expect(q.settle(q.pending()[0]!, 10, 1, 0)?.prune).toBe(true);
 // 同一候选若改写点之后还有 200 tok 的新 user 段锚:(40+200)×10=2400 > 1000 → deferred。
    q.enqueue(cand("t1", 1000, 40, 0, 1));
    expect(q.settle(q.pending()[0]!, 10, 1, 200)?.prune).toBe(false);
  });

  it("settle 可用更新的 N 覆盖入队留档(候选越往后 N 越小 → 更不划算)", () => {
    const q = createDegradationQueue();
    q.enqueue(cand("n1", 1000, 40, 0, 10)); // 入队时 N=10:economic
    const late = q.settle(q.pending()[0]!, 10, 1); // 裁决时只剩 1 步:1×1000 > 400 → 仍 economic(拍板速算档)
    expect(late?.prune).toBe(true);
 // 极端:产物大(W′=400)+ N=1:1×500 < 4000 → deferred。
    q.enqueue(cand("n2", 500, 400, 0, 10));
    const late2 = q.settle(q.pending()[0]!, 10, 1);
    expect(late2?.prune).toBe(false);
  });

  it("settleBatch:整批公式用共享 tail,不逐条放行;exclude 留队", () => {
    const q = createDegradationQueue();
    q.enqueue(cand("a", 1000, 40, 0, 1));
    q.enqueue(cand("b", 2000, 40, 0, 1));
 // ΣW=3000、ΣW′=80、tail=0、N=1、r=10:3000 > 800 → 整批批准
    const ok = q.settleBatch(10, { remainingStepsN: 1, tailTokens: 0 });
    expect(ok.economic).toBe(true);
    expect(ok.approved.map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect(q.pending()).toHaveLength(0);

 // 同批加 300 tok 共享 tail:N=1 时 3000 < (80+300)×10=3800 → 整批不放
    q.enqueue(cand("a", 1000, 40, 0, 1));
    q.enqueue(cand("b", 2000, 40, 0, 1));
    const no = q.settleBatch(10, { remainingStepsN: 1, tailTokens: 300 });
    expect(no.economic).toBe(false);
    expect(no.approved).toHaveLength(0);
    expect(q.pending()).toHaveLength(2);

 // N=4:仅 a 参与(2000×? a W=1000,N=4 → 4000 > (40+300)×10=3400)→ 批准;exclude=b 时 b 留队
    const partial = q.settleBatch(10, { remainingStepsN: 4, tailTokens: 300, exclude: new Set(["b"]) });
    expect(partial.economic).toBe(true);
    expect(partial.approved.map((c) => c.id)).toEqual(["a"]);
    expect(q.pending().map((c) => c.id)).toEqual(["b"]);
  });

  it("settle 未入队/已裁决的条目返回 undefined", () => {
    const q = createDegradationQueue();
    expect(q.settle(cand("ghost", 1000, 1, 0), 10)).toBeUndefined();
  });

  it("orderByTailProximity:消息下标大的(离尾近)排前,无消息映射的排最后", () => {
    const q = createDegradationQueue();
    q.enqueue(cand("t1", 10, 1, 0)); // 下标 1
    q.enqueue(cand("t2", 10, 1, 0)); // 下标 3
    q.enqueue(cand("nomatch", 10, 1, 0)); // 无对应消息
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
    q.enqueue(cand("p1", 10, 1, 0));
    q.pending()[0]!.savedTokensW = 999;
    expect(q.pending()[0]!.savedTokensW).toBe(10);
  });
});
