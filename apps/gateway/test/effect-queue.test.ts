/**
 * M189 持久效果队列测试。
 *
 * 口径:假 journal 记录「写账顺序 + flushStrict」;假时钟 + 立即返回的 sleep 让退避/延后
 * 完全确定性(不用真等待);handler 用受控 promise 验并发上限。
 */
import { describe, expect, it } from "vitest";
import {
  createEffectQueue,
  foldEffectQueue,
  relayActivityHandler,
  type EffectQueueOptions,
} from "../src/effect-queue.js";

class FakeJournal {
  events: any[] = [];
  /** 调用序(含 "flush" 标记),用于断言「先落账、后 flush、再执行」。 */
  log: string[] = [];
  append(ev: any): any {
    this.log.push(ev.kind);
    const full = { ...ev, seq: this.events.length, time: 0 };
    this.events.push(full);
    return full;
  }
  readAll(): any[] {
    return [...this.events];
  }
  async flushStrict(): Promise<void> {
    this.log.push("flush");
  }
}

const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
const ticks = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i += 1) await tick();
};

function harness(extra: Partial<EffectQueueOptions> = {}) {
  let clock = 1000;
  const journal = new FakeJournal();
  const persisted: string[] = [];
  const queue = createEffectQueue({
    journal,
    now: () => clock,
    // 立即返回但推进假时钟:退避/deferred 的等待由测试推进,不产生真实延迟。
    sleep: async (ms) => { clock += ms; },
    baseDelayMs: 1000,
    maxDelayMs: 60_000,
    maxAttempts: 3,
    persist: (event) => { persisted.push(event.kind); },
    ...extra,
  });
  return { queue, journal, persisted, now: () => clock };
}

describe("effect-queue", () => {
  it("落账:enqueue 先 append effect.enqueued 再 flushStrict,handler 之后才跑", async () => {
    const { queue, journal, persisted } = harness();
    let ran = 0;
    queue.register("k", () => {
      ran += 1;
      // handler 执行时账已落、flush 已完成。
      expect(journal.log[0]).toBe("effect.enqueued");
      expect(journal.log[1]).toBe("flush");
      expect(journal.events.some((e) => e.kind === "effect.enqueued")).toBe(true);
    });
    queue.start();
    const res = await queue.enqueue({ kind: "k", key: "a", payload: { v: 1 } });
    expect(res).toEqual({ id: "ef-1", deduped: false });
    expect(persisted[0]).toBe("effect.enqueued");
    await ticks(3);
    expect(ran).toBe(1);
    expect(journal.events.filter((e) => e.kind === "effect.done")).toHaveLength(1);
  });

  it("替换:同 kind+key 等待中改 payload,id 与队列顺序不变、nextAt=now", async () => {
    const { queue, journal, now } = harness();
    const a = await queue.enqueue({ kind: "k", key: "t1", payload: { v: 1 } });
    const b = await queue.enqueue({ kind: "k", key: "t2", payload: { v: 2 } });
    const a2 = await queue.enqueue({ kind: "k", key: "t1", payload: { v: 9 } });
    expect(a2).toEqual({ id: a.id, deduped: true });
    expect(journal.events.filter((e) => e.kind === "effect.enqueued").map((e) => e.payload.id)).toEqual([a.id, b.id]);
    const replaced = journal.events.filter((e) => e.kind === "effect.replaced");
    expect(replaced).toHaveLength(1);
    expect(replaced[0].payload).toEqual({ id: a.id, payload: { v: 9 }, at: now() });
    // 顺序仍是 t1 → t2,只是 t1 的 payload 变成最新值。
    const order: unknown[] = [];
    queue.register("k", (payload) => { order.push((payload as { v: number }).v); });
    queue.start();
    await ticks(4);
    expect(order).toEqual([9, 2]);
  });

  it("并发:oldest-first 派发,同 kind 在飞不超过 concurrency", async () => {
    const { queue } = harness();
    const started: number[] = [];
    const release: Array<() => void> = [];
    let running = 0;
    let peak = 0;
    queue.register("k", (payload) => new Promise<void>((resolve) => {
      started.push((payload as { n: number }).n);
      running += 1;
      peak = Math.max(peak, running);
      release.push(() => { running -= 1; resolve(); });
    }), { concurrency: 2 });
    queue.start();
    for (let n = 1; n <= 4; n += 1) await queue.enqueue({ kind: "k", key: `k${n}`, payload: { n } });
    await ticks(2);
    expect(started).toEqual([1, 2]);
    release[0](); await ticks(2);
    expect(started).toEqual([1, 2, 3]);
    release[1](); await ticks(2);
    expect(started).toEqual([1, 2, 3, 4]);
    release[2](); release[3](); await ticks(2);
    expect(peak).toBe(2);
  });

  it("保序:deferred 行占位,同 kind 后续必须等它到期", async () => {
    // 这个用例需要「deferred 到期前」的中间态:用可控 sleep(测试显式放行)。
    let clock = 1000;
    let wake: (() => void) | null = null;
    const journal = new FakeJournal();
    const queue = createEffectQueue({
      journal,
      now: () => clock,
      sleep: (ms) => new Promise<void>((resolve) => {
        wake = () => { clock += ms; resolve(); };
      }),
      baseDelayMs: 1000,
      maxAttempts: 3,
    });
    const started: number[] = [];
    let deferredOnce = false;
    queue.register("k", (payload, ctx) => {
      const n = (payload as { n: number }).n;
      started.push(n);
      if (n === 1 && !deferredOnce) {
        deferredOnce = true;
        ctx.later(500);
      }
    });
    queue.start();
    await queue.enqueue({ kind: "k", key: "a", payload: { n: 1 } });
    await queue.enqueue({ kind: "k", key: "b", payload: { n: 2 } });
    await ticks(3);
    // deferred 未到期:后一条不得启动。
    expect(started).toEqual([1]);
    const deferred = journal.events.find((e) => e.kind === "effect.deferred");
    expect(deferred?.payload.nextAt).toBe(1500);
    expect(wake).not.toBeNull();
    wake!();
    await ticks(4);
    expect(started).toEqual([1, 1, 2]);
  });

  it("退避:attempt1=base、attempt2=2base、第三次进 health degraded", async () => {
    const { queue, journal } = harness();
    queue.register("k", () => { throw new Error("boom"); });
    queue.start();
    await queue.enqueue({ kind: "k", key: "a", payload: {} });
    await ticks(12);
    const failed = journal.events.filter((e) => e.kind === "effect.failed").map((e) => e.payload);
    expect(failed.map((f) => f.attempts)).toEqual([1, 2, 3]);
    expect(failed.map((f) => f.nextAt)).toEqual([2000, 4000, 8000]);
    expect(queue.health()).toEqual([{ kind: "k", status: "degraded", consecutiveFailures: 3 }]);
    // 用尽重试仍保留账(不再调度,但 pending 可见,便于人工介入/重启后审计)。
    expect(queue.pending()).toHaveLength(1);
    await ticks(4);
    expect(journal.events.filter((e) => e.kind === "effect.failed")).toHaveLength(3);
  });

  it("成功清零:失败一次后成功,health 回 ok", async () => {
    const { queue, journal } = harness();
    let calls = 0;
    queue.register("k", () => {
      calls += 1;
      if (calls === 1) throw new Error("first");
    });
    queue.start();
    await queue.enqueue({ kind: "k", key: "a", payload: {} });
    await ticks(8);
    expect(calls).toBe(2);
    expect(queue.health()).toEqual([{ kind: "k", status: "ok", consecutiveFailures: 0 }]);
    expect(journal.events.filter((e) => e.kind === "effect.health").map((e) => e.payload)).toEqual([
      { kind: "k", status: "ok", consecutiveFailures: 0 },
    ]);
  });

  it("later 不记失败:attempts 保持 0,只写 effect.deferred", async () => {
    const { queue, journal } = harness();
    let first = true;
    queue.register("k", (_payload, ctx) => {
      if (first) {
        first = false;
        ctx.later(300);
      }
    });
    queue.start();
    await queue.enqueue({ kind: "k", key: "a", payload: { v: 1 } });
    await ticks(6);
    expect(journal.events.some((e) => e.kind === "effect.failed")).toBe(false);
    expect(journal.events.filter((e) => e.kind === "effect.deferred")).toHaveLength(1);
    expect(journal.events.filter((e) => e.kind === "effect.done")).toHaveLength(1);
    expect(queue.pending()).toHaveLength(0);
    expect(queue.health()).toEqual([{ kind: "k", status: "ok", consecutiveFailures: 0 }]);
  });

  it("drain:停取新、await 在飞、pending 保留;新 enqueue 不调度", async () => {
    const { queue } = harness();
    let starts = 0;
    let release!: () => void;
    queue.register("k", () => {
      starts += 1;
      return new Promise<void>((resolve) => { release = resolve; });
    });
    queue.start();
    for (let n = 1; n <= 3; n += 1) await queue.enqueue({ kind: "k", key: `k${n}`, payload: { n } });
    await ticks(2);
    expect(starts).toBe(1);
    const drained = queue.drain();
    release();
    await drained;
    expect(queue.pending()).toHaveLength(2);
    expect(queue.idle()).toBe(true);
    await queue.enqueue({ kind: "k", key: "k4", payload: { n: 4 } });
    await ticks(4);
    expect(starts).toBe(1); // drain 后不再调度
    expect(queue.pending()).toHaveLength(3); // 但账照落(pending 可见)
  });

  it("fold 冷恢复:done 丢弃、replaced/failed/deferred 覆盖,顺序保持", () => {
    const rows = foldEffectQueue([
      { kind: "effect.enqueued", payload: { id: "ef-1", kind: "k", key: "a", payload: { v: 1 }, at: 100, attempts: 0, nextAt: 100 } },
      { kind: "effect.enqueued", payload: { id: "ef-2", kind: "k", key: "b", payload: { v: 2 }, at: 100, attempts: 0, nextAt: 100 } },
      { kind: "effect.replaced", payload: { id: "ef-1", payload: { v: 9 }, at: 150 } },
      { kind: "effect.failed", payload: { id: "ef-2", attempts: 1, nextAt: 1100, error: "boom" } },
      { kind: "effect.deferred", payload: { id: "ef-1", nextAt: 300 } },
      { kind: "effect.enqueued", payload: { id: "ef-3", kind: "k", key: "c", payload: { v: 3 }, at: 160, attempts: 0, nextAt: 160 } },
      { kind: "effect.done", payload: { id: "ef-3" } },
      { kind: "effect.health", payload: { kind: "k", status: "degraded", consecutiveFailures: 3 } },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["ef-1", "ef-2"]);
    expect(rows[0]).toMatchObject({ key: "a", payload: { v: 9 }, nextAt: 300, attempts: 0 });
    expect(rows[1]).toMatchObject({ key: "b", payload: { v: 2 }, attempts: 1, nextAt: 1100 });
  });

  it("fold 冷恢复后 enqueue 继续用新 id(不与恢复行撞车)", async () => {
    const queue = createEffectQueue({
      journal: new FakeJournal(),
      seed: [{ id: "ef-7", kind: "k", key: "a", payload: {}, at: 1, attempts: 0, nextAt: 1 }],
      sleep: async () => {},
    });
    const res = await queue.enqueue({ kind: "k", key: "b", payload: {} });
    expect(res.id).toBe("ef-8");
  });

  it("接线:relay.activity 经队列执行调 sink;无 sink 零调用且不记失败", async () => {
    const { queue, journal } = harness();
    const calls: unknown[][] = [];
    const sink = { notifyActivity: (...args: unknown[]) => { calls.push(args); } };
    queue.register("relay.activity", relayActivityHandler(() => sink));
    queue.start();
    await queue.enqueue({
      kind: "relay.activity",
      key: "task-1",
      payload: { projectId: "", category: "task", type: "running", summary: "开始:x" },
    });
    await ticks(3);
    expect(calls).toEqual([["", "task", "running", "开始:x"]]);
    expect(journal.events.filter((e) => e.kind === "effect.done")).toHaveLength(1);
    expect(journal.events.some((e) => e.kind === "effect.failed")).toBe(false);

    // team 关闭(__teamView 不存在):零外部调用,handler 直接成功,不拖 health。
    const off = harness();
    off.queue.register("relay.activity", relayActivityHandler(() => undefined));
    off.queue.start();
    await off.queue.enqueue({ kind: "relay.activity", key: "task-2", payload: {} });
    await ticks(3);
    expect(off.journal.events.filter((e) => e.kind === "effect.done")).toHaveLength(1);
    expect(off.journal.events.some((e) => e.kind === "effect.failed")).toBe(false);
    expect(off.queue.health()).toEqual([{ kind: "relay.activity", status: "ok", consecutiveFailures: 0 }]);
  });
});
