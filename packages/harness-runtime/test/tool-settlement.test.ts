/**
 * tool-settlement 测试:fork 调度 / 并发上限 / run-once / 观察标记 / drain 诊断 / 不产生 unhandledRejection
 * / raceSettle / withTimeout / settleBatch / abort 传播与 cancelAll。
 *
 * 口径:确定性优先——真实定时器 + 5~20ms 小延迟(不用 fake timers),时间戳走注入 env.now;
 * 并发峰值用任务体内的在飞计数器测量(与实现的槽位计数无关,是外部观测)。
 */
import { describe, expect, it } from "vitest";
import {
  SETTLE_CODES,
  SettleError,
  abortHandle,
  awaitHandle,
  cancelAll,
  drain,
  eagerFork,
  raceSettle,
  settleBatch,
  withTimeout,
} from "../src/agent/tool-settlement.js";
import type { SettleHandle, SettleTask } from "../src/agent/tool-settlement.js";

const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

interface Tracker {
  inflight: number;
  peak: number;
  over: number;
  order: string[];
}

const tracker = (limit = 8): Tracker => ({ inflight: 0, peak: 0, over: 0, order: [] });

/** 记录在飞数的任务:用来外部观测调度器是否守住并发上限。 */
const tracked = (id: string, t: Tracker, limit = 8, ms = 10): SettleTask<string> => ({
  id,
  async run() {
    t.inflight += 1;
    t.order.push(id);
    if (t.inflight > t.peak) t.peak = t.inflight;
    if (t.inflight > limit) t.over += 1;
    await wait(ms);
    t.inflight -= 1;
    return id;
  },
});

/** 一直跑到 signal.aborted 才收尾的任务(用于中断/竞速/超时)。 */
const untilAborted = (
  id: string,
  hook?: { cleaned?: string[]; started?: string[] },
): SettleTask<string> => ({
  id,
  async run(ctx) {
    hook?.started?.push(id);
    try {
      while (!ctx.signal.aborted) await wait(2);
      return `${id}:stopped`;
    } finally {
      hook?.cleaned?.push(id);
    }
  },
});

const expectInvalidSync = (fn: () => unknown): SettleError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SettleError);
    return error as SettleError;
  }
  throw new Error("期望同步抛 SettleError,但没有抛");
};

describe("eagerFork:句柄生成与并发上限", () => {
  it("立刻为每个 task 生成句柄,id 取 task.id 否则 h1/h2/h3", async () => {
    const { handles, drain: settle } = eagerFork<string>([
      { run: async () => "a" },
      { run: async () => "b" },
      { id: "named", run: async () => "c" },
    ]);
    expect(handles.map((h) => h.id)).toEqual(["h1", "h2", "named"]);
    expect(handles).toHaveLength(3);
    await settle();
  });

  it("默认并发上限 8:12 个任务峰值恰为 8 且从未超过 8", async () => {
    const t = tracker(8);
    const tasks = Array.from({ length: 12 }, (_, i) => tracked(`t${i}`, t, 8, 10));
    const { handles, drain: settle } = eagerFork(tasks);
    expect(handles).toHaveLength(12);
    const log = await settle();
    expect(log.handles).toHaveLength(12);
    expect(t.over).toBe(0);
    expect(t.peak).toBe(8);
    expect(handles.every((h) => h.state === "fulfilled")).toBe(true);
  });

  it("显式 maxConcurrency=2:峰值 2,全部完成", async () => {
    const t = tracker(2);
    const tasks = Array.from({ length: 5 }, (_, i) => tracked(`t${i}`, t, 2, 5));
    const { handles, drain: settle } = eagerFork(tasks, { env: { maxConcurrency: 2 } });
    await settle();
    expect(t.over).toBe(0);
    expect(t.peak).toBe(2);
    expect(handles.filter((h) => h.state === "fulfilled")).toHaveLength(5);
  });

  it("在飞任务结算后按 FIFO 放行下一个", async () => {
    const t = tracker(1);
    const tasks = Array.from({ length: 4 }, (_, i) => tracked(`t${i}`, t, 1, 5));
    const { drain: settle } = eagerFork(tasks, { env: { maxConcurrency: 1 } });
    await settle();
    expect(t.order).toEqual(["t0", "t1", "t2", "t3"]);
    expect(t.peak).toBe(1);
  });

  it("onStart 回调收到句柄与下标", async () => {
    const seen: Array<[string, number]> = [];
    const { drain: settle } = eagerFork<number>(
      [{ run: () => 1 }, { id: "two", run: () => 2 }],
      { onStart: (h, index) => seen.push([h.id, index]) },
    );
    await settle();
    expect(seen).toEqual([
      ["h1", 0],
      ["two", 1],
    ]);
  });

  it("任务同步返回值也能结算", async () => {
    const { handles } = eagerFork<number>([{ id: "s", run: () => 42 }]);
    expect(await awaitHandle(handles[0]!)).toBe(42);
    expect(handles[0]!.state).toBe("fulfilled");
    expect(handles[0]!.result).toBe(42);
  });

  it("任务同步抛错 → state rejected 且 error 为原对象", async () => {
    const boom = new Error("sync-boom");
    const { handles, drain: settle } = eagerFork<string>([
      {
        id: "s",
        run: () => {
          throw boom;
        },
      },
    ]);
    const log = await settle();
    expect(handles[0]!.state).toBe("rejected");
    expect(handles[0]!.error).toBe(boom);
    expect(log.diagnostics[0]!.error).toBe(boom);
  });

  it("任务异步 reject → 缓存原 error 对象", async () => {
    const boom = new Error("async-boom");
    const { handles, drain: settle } = eagerFork<string>([
      {
        id: "a",
        run: async () => {
          await wait(3);
          throw boom;
        },
      },
    ]);
    await settle();
    expect(handles[0]!.state).toBe("rejected");
    expect(handles[0]!.error).toBe(boom);
  });

  it("eagerFork([]) → 空句柄数组且 drain 立即返回空日志(不 hang)", async () => {
    const { handles, drain: settle } = eagerFork<number>([]);
    expect(handles).toEqual([]);
    expect(await settle()).toEqual({ handles: [], diagnostics: [] });
  });
});

describe("非法 env", () => {
  it("maxConcurrency=0 → 同步抛 SETTLE_INVALID", () => {
    expect(expectInvalidSync(() => eagerFork<number>([], { env: { maxConcurrency: 0 } })).code).toBe(
      SETTLE_CODES.INVALID,
    );
  });

  it("maxConcurrency=-1 → 同步抛 SETTLE_INVALID", () => {
    expect(expectInvalidSync(() => eagerFork<number>([], { env: { maxConcurrency: -1 } })).code).toBe(
      SETTLE_CODES.INVALID,
    );
  });

  it("maxConcurrency=1.5 → 同步抛 SETTLE_INVALID", () => {
    expect(expectInvalidSync(() => eagerFork<number>([], { env: { maxConcurrency: 1.5 } })).code).toBe(
      SETTLE_CODES.INVALID,
    );
  });

  it("maxConcurrency=NaN → 同步抛 SETTLE_INVALID(不是死锁)", () => {
    expect(expectInvalidSync(() => eagerFork<number>([], { env: { maxConcurrency: Number.NaN } })).code).toBe(
      SETTLE_CODES.INVALID,
    );
  });

  it("maxConcurrency=1 合法,正常调度", async () => {
    const t = tracker(1);
    const { drain: settle } = eagerFork([tracked("only", t, 1, 3)], { env: { maxConcurrency: 1 } });
    const log = await settle();
    expect(log.handles).toHaveLength(1);
    expect(t.order).toEqual(["only"]);
  });
});

describe("run-once 与重复 await", () => {
  it("句柄 codes 初始含 FORKED", () => {
    const { handles } = eagerFork<number>([{ id: "a", run: () => 1 }]);
    expect(handles[0]!.codes).toEqual([SETTLE_CODES.FORKED]);
    expect(handles[0]!.state).toBe("pending");
    expect(handles[0]!.observed).toBe(false);
    expect(handles[0]!.awaitCount).toBe(0);
  });

  it("run 函数体最多执行一次(多次 await 也只跑一次)", async () => {
    let runs = 0;
    const { handles } = eagerFork<number>([
      {
        id: "a",
        run: async () => {
          runs += 1;
          await wait(5);
          return runs;
        },
      },
    ]);
    const h = handles[0]!;
    expect(await awaitHandle(h)).toBe(1);
    expect(await awaitHandle(h)).toBe(1);
    expect(runs).toBe(1);
  });

  it("并行 await 两次:结果相同、执行计数 1、awaitCount=2、DOUBLE_AWAIT 只一条", async () => {
    let runs = 0;
    const { handles } = eagerFork<number>([
      {
        id: "a",
        run: async () => {
          runs += 1;
          await wait(5);
          return 7;
        },
      },
    ]);
    const h = handles[0]!;
    const [x, y] = await Promise.all([awaitHandle(h), awaitHandle(h)]);
    expect(x).toBe(7);
    expect(y).toBe(7);
    expect(runs).toBe(1);
    expect(h.awaitCount).toBe(2);
    expect(h.codes.filter((c) => c === SETTLE_CODES.DOUBLE_AWAIT_IDEMPOTENT)).toHaveLength(1);
  });

  it("串行 await 两次:结果相同、执行计数 1", async () => {
    let runs = 0;
    const { handles } = eagerFork<number>([
      {
        id: "a",
        run: async () => {
          runs += 1;
          await wait(3);
          return 9;
        },
      },
    ]);
    const h = handles[0]!;
    expect(await awaitHandle(h)).toBe(9);
    expect(await awaitHandle(h)).toBe(9);
    expect(runs).toBe(1);
    expect(h.awaitCount).toBe(2);
    expect(h.observed).toBe(true);
  });

  it("awaitHandle 置 observed=true 并追加 AWAITED", async () => {
    const { handles } = eagerFork<number>([{ id: "a", run: () => 3 }]);
    const h = handles[0]!;
    expect(h.observed).toBe(false);
    await awaitHandle(h);
    expect(h.observed).toBe(true);
    expect(h.codes).toContain(SETTLE_CODES.AWAITED);
  });

  it("首次 await 不带 DOUBLE_AWAIT_IDEMPOTENT,第二次才追加", async () => {
    const { handles } = eagerFork<number>([{ id: "a", run: () => 1 }]);
    const h = handles[0]!;
    await awaitHandle(h);
    expect(h.codes).not.toContain(SETTLE_CODES.DOUBLE_AWAIT_IDEMPOTENT);
    await awaitHandle(h);
    expect(h.codes).toContain(SETTLE_CODES.DOUBLE_AWAIT_IDEMPOTENT);
    await awaitHandle(h);
    expect(h.codes.filter((c) => c === SETTLE_CODES.DOUBLE_AWAIT_IDEMPOTENT)).toHaveLength(1);
    expect(h.awaitCount).toBe(3);
  });

  it("直接 await handle.promise 可拿到值但不置 observed(因此 fulfilled 无诊断)", async () => {
    const { handles, drain: settle } = eagerFork<number>([{ id: "a", run: () => 11 }]);
    const h = handles[0]!;
    expect(await h.promise).toBe(11);
    expect(h.observed).toBe(false);
    expect(h.codes).not.toContain(SETTLE_CODES.AWAITED);
    const log = await settle();
    expect(log.diagnostics).toEqual([]);
  });

  it("直接 await handle.promise 的拒绝仍算未观察 → drain 照样诊断(核心因果)", async () => {
    const boom = new Error("direct");
    const { handles, drain: settle } = eagerFork<string>([
      {
        id: "a",
        run: async () => {
          throw boom;
        },
      },
    ]);
    const h = handles[0]!;
    await expect(h.promise).rejects.toThrow("direct");
    expect(h.observed).toBe(false);
    const log = await settle();
    expect(log.diagnostics).toHaveLength(1);
    expect(log.diagnostics[0]!.handleId).toBe("a");
    expect(log.diagnostics[0]!.error).toBe(boom);
  });
});

describe("observed 与缓存错误", () => {
  it("rejected:awaitHandle 抛缓存同一 error 对象,observed=true", async () => {
    const boom = new Error("cached");
    const { handles } = eagerFork<string>([
      {
        id: "r",
        run: async () => {
          await wait(3);
          throw boom;
        },
      },
    ]);
    const h = handles[0]!;
    let first: unknown;
    let second: unknown;
    try {
      await awaitHandle(h);
    } catch (error) {
      first = error;
    }
    try {
      await awaitHandle(h);
    } catch (error) {
      second = error;
    }
    expect(first).toBe(boom);
    expect(second).toBe(boom);
    expect(first).toBe(second);
    expect(h.observed).toBe(true);
    expect(h.error).toBe(boom);
  });

  it("aborted:awaitHandle 抛同一 SettleError,code 对应中断原因", async () => {
    const { handles } = eagerFork<string>([untilAborted("a")]);
    const h = handles[0]!;
    await wait(5);
    abortHandle(h, SETTLE_CODES.CANCELLED);
    expect(h.state).toBe("aborted");
    expect(h.codes).toContain(SETTLE_CODES.CANCELLED);
    let first: unknown;
    let second: unknown;
    try {
      await awaitHandle(h);
    } catch (error) {
      first = error;
    }
    try {
      await h.promise;
    } catch (error) {
      second = error;
    }
    expect(first).toBeInstanceOf(SettleError);
    expect((first as SettleError).code).toBe(SETTLE_CODES.CANCELLED);
    expect(second).toBe(first);
    await wait(10);
  });

  it("成功时返回缓存 result 且 handle.result 已记录", async () => {
    const { handles } = eagerFork<number>([{ id: "a", run: async () => 5 }]);
    const h = handles[0]!;
    expect(await awaitHandle(h)).toBe(5);
    expect(h.result).toBe(5);
    expect(h.error).toBeUndefined();
    expect(h.state).toBe("fulfilled");
  });
});

describe("drain", () => {
  it("等全部 settle 不抛;未观察 rejected 各一条诊断,at 用注入 now", async () => {
    const { handles, drain: settle } = eagerFork<string>(
      [
        {
          id: "bad",
          run: async () => {
            await wait(5);
            throw new Error("late");
          },
        },
        { id: "good", run: async () => "ok" },
      ],
      { env: { now: () => 777 } },
    );
    const log = await settle();
    expect(log.handles).toEqual(handles);
    expect(log.diagnostics).toHaveLength(1);
    expect(log.diagnostics[0]).toEqual({
      kind: "unobserved-rejection",
      handleId: "bad",
      error: handles[0]!.error,
      at: 777,
    });
  });

  it("未观察但 fulfilled 的句柄不产生诊断", async () => {
    const { drain: settle } = eagerFork<string>([{ id: "ok", run: async () => "fine" }]);
    const log = await settle();
    expect(log.diagnostics).toEqual([]);
  });

  it("已观察的 rejected 句柄不产生诊断", async () => {
    const { handles, drain: settle } = eagerFork<string>([
      {
        id: "watched",
        run: async () => {
          throw new Error("seen");
        },
      },
    ]);
    await expect(awaitHandle(handles[0]!)).rejects.toThrow("seen");
    const log = await settle();
    expect(log.diagnostics).toEqual([]);
  });

  it("drain 不改 handle.codes 与 observed", async () => {
    const { handles, drain: settle } = eagerFork<string>([
      {
        id: "bad",
        run: async () => {
          throw new Error("x");
        },
      },
      { id: "ok", run: async () => "y" },
    ]);
    await wait(10);
    const codesBefore = handles.map((h) => [...h.codes]);
    const observedBefore = handles.map((h) => h.observed);
    const log = await settle();
    expect(handles.map((h) => [...h.codes])).toEqual(codesBefore);
    expect(handles.map((h) => h.observed)).toEqual(observedBefore);
    expect(log.diagnostics).toHaveLength(1);
  });

  it("drain([]) 立即返回空日志", async () => {
    expect(await drain([])).toEqual({ handles: [], diagnostics: [] });
  });
});

describe("不产生 unhandledRejection", () => {
  it("rejected 句柄在 drain 后被内部吞掉,进程无 unhandledRejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { drain: settle } = eagerFork<string>([
        {
          id: "r1",
          run: async () => {
            await wait(5);
            throw new Error("boom-1");
          },
        },
        {
          id: "r2",
          run: async () => {
            throw new Error("boom-2");
          },
        },
      ]);
      const log = await settle();
      expect(log.diagnostics.map((d) => d.handleId).sort()).toEqual(["r1", "r2"]);
      await new Promise((res) => setTimeout(res, 30));
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("raceSettle", () => {
  it("首个结算者胜(RACE_WON + observed),其余被中断且已真正停下", async () => {
    const hook: { cleaned?: string[] } = { cleaned: [] };
    const { handles } = eagerFork<string>([
      {
        id: "fast",
        run: async () => {
          await wait(5);
          return "fast";
        },
      },
      untilAborted("slow1", hook),
      untilAborted("slow2", hook),
    ]);
    const res = await raceSettle(handles);
    expect(res.winner.id).toBe("fast");
    expect(res.winner.state).toBe("fulfilled");
    expect(res.winner.observed).toBe(true);
    expect(res.winner.codes).toContain(SETTLE_CODES.RACE_WON);
    expect(res.aborted.sort()).toEqual(["slow1", "slow2"]);
    for (const id of ["slow1", "slow2"]) {
      const h = handles.find((x) => x.id === id)!;
      expect(h.state).toBe("aborted");
      expect(h.controller.signal.aborted).toBe(true);
      expect(h.error).toBeInstanceOf(SettleError);
      expect((h.error as SettleError).code).toBe(SETTLE_CODES.RACE_ABORTED);
      expect(h.codes).toContain(SETTLE_CODES.RACE_ABORTED);
    }
    // 返回时 loser 的 run 已跑完 finally 清理
    expect(hook.cleaned?.slice().sort()).toEqual(["slow1", "slow2"]);
    expect(res.log.handles).toHaveLength(3);
  });

  it("已 fulfilled 的败者保持 fulfilled 且不进 aborted 列表", async () => {
    const { handles } = eagerFork<string>([
      { id: "a", run: async () => "a" },
      { id: "b", run: async () => "b" },
    ]);
    const res = await raceSettle(handles);
    expect(res.winner.id).toBe("a");
    expect(res.aborted).toEqual([]);
    const loser = handles[1]!;
    expect(loser.state).toBe("fulfilled");
    expect(loser.result).toBe("b");
    expect(loser.codes).not.toContain(SETTLE_CODES.RACE_ABORTED);
  });

  it("空数组 → 抛 SETTLE_INVALID", () => {
    expect(expectInvalidSync(() => raceSettle([])).code).toBe(SETTLE_CODES.INVALID);
  });
});

describe("withTimeout", () => {
  it("ms 内全部结算 → completed + log", async () => {
    const { handles } = eagerFork<string>([
      { id: "a", run: async () => "a" },
      { id: "b", run: async () => "b" },
    ]);
    const res = await withTimeout(handles, 300);
    expect(res.status).toBe("completed");
    if (res.status === "completed") {
      expect(res.log.handles).toHaveLength(2);
      expect(res.log.diagnostics).toEqual([]);
    }
  });

  it("超时 → abort 全部未结算句柄、已 fulfilled 保持 fulfilled", async () => {
    const hook: { cleaned?: string[] } = { cleaned: [] };
    const { handles } = eagerFork<string>([
      {
        id: "fast",
        run: async () => {
          await wait(5);
          return "fast";
        },
      },
      untilAborted("slow", hook),
    ]);
    const res = await withTimeout(handles, 25);
    expect(res.status).toBe("timeout");
    if (res.status !== "timeout") throw new Error("unreachable");
    expect(res.code).toBe("SETTLE_TIMEOUT_ABORTED");
    expect(res.aborted).toEqual(["slow"]);
    const slow = handles[1]!;
    expect(slow.state).toBe("aborted");
    expect(slow.codes).toContain(SETTLE_CODES.TIMEOUT_ABORTED);
    expect(slow.controller.signal.aborted).toBe(true);
    expect((slow.error as SettleError).code).toBe(SETTLE_CODES.TIMEOUT_ABORTED);
    expect(hook.cleaned).toEqual(["slow"]);
    expect(handles[0]!.state).toBe("fulfilled");
    expect(handles[0]!.result).toBe("fast");
  });

  it("ms=0 → 抛 SETTLE_INVALID", () => {
    expect(expectInvalidSync(() => withTimeout([], 0)).code).toBe(SETTLE_CODES.INVALID);
  });

  it("ms=-5 → 抛 SETTLE_INVALID", () => {
    expect(expectInvalidSync(() => withTimeout([], -5)).code).toBe(SETTLE_CODES.INVALID);
  });
});

describe("settleBatch", () => {
  it("默认 abort-rest:首个失败后 abort 其余,排队未启动的任务永不执行", async () => {
    let ran = 0;
    const { handles } = eagerFork<number>(
      [
        {
          id: "bad",
          run: async () => {
            await wait(5);
            throw new Error("bad-first");
          },
        },
        {
          id: "q1",
          run: async () => {
            ran += 1;
            await wait(20);
            return 1;
          },
        },
        {
          id: "q2",
          run: async () => {
            ran += 1;
            await wait(20);
            return 2;
          },
        },
      ],
      { env: { maxConcurrency: 1 } },
    );
    const res = await settleBatch(handles);
    expect(ran).toBe(0);
    expect((res.firstError as Error).message).toBe("bad-first");
    expect(handles.map((h) => h.state)).toEqual(["rejected", "aborted", "aborted"]);
    expect(handles[0]!.codes).toContain(SETTLE_CODES.FORKED);
    expect(res.log.handles).toHaveLength(3);
  });

  it("abort-rest 也会中断已在飞的其他任务", async () => {
    const hook: { cleaned?: string[] } = { cleaned: [] };
    const { handles } = eagerFork<string>(
      [
        {
          id: "bad",
          run: async () => {
            await wait(5);
            throw new Error("fail-fast");
          },
        },
        untilAborted("live", hook),
      ],
      { env: { maxConcurrency: 2 } },
    );
    const res = await settleBatch(handles);
    expect((res.firstError as Error).message).toBe("fail-fast");
    expect(handles[1]!.state).toBe("aborted");
    expect(handles[1]!.codes).toContain(SETTLE_CODES.CANCELLED);
    await wait(15);
    expect(hook.cleaned).toEqual(["live"]);
  });

  it("wait-all:跑完全部并返回 firstError", async () => {
    let ran = 0;
    const { handles } = eagerFork<number>(
      [
        {
          id: "a",
          run: async () => {
            ran += 1;
            await wait(5);
            throw new Error("a-fail");
          },
        },
        {
          id: "b",
          run: async () => {
            ran += 1;
            await wait(10);
            return 2;
          },
        },
      ],
      { env: { maxConcurrency: 1 } },
    );
    const res = await settleBatch(handles, { policy: "wait-all" });
    expect(ran).toBe(2);
    expect((res.firstError as Error).message).toBe("a-fail");
    expect(handles[1]!.state).toBe("fulfilled");
    expect(handles[1]!.result).toBe(2);
  });

  it("全部成功时 firstError 为 undefined", async () => {
    const { handles } = eagerFork<number>([
      { id: "a", run: async () => 1 },
      { id: "b", run: async () => 2 },
    ]);
    const res = await settleBatch(handles);
    expect(res.firstError).toBeUndefined();
    expect(res.log.diagnostics).toEqual([]);
  });
});

describe("abort 传播与 cancelAll", () => {
  it("abort 后 ctx.signal.aborted=true,任务自行停止", async () => {
    let observedAborted = false;
    let cleaned = false;
    const { handles } = eagerFork<string>([
      {
        id: "a",
        run: async (ctx) => {
          try {
            while (!ctx.signal.aborted) await wait(2);
            observedAborted = true;
            return "stopped";
          } finally {
            cleaned = true;
          }
        },
      },
    ]);
    const h = handles[0]!;
    await wait(5);
    expect(h.state).toBe("pending");
    abortHandle(h);
    expect(h.controller.signal.aborted).toBe(true);
    expect(h.state).toBe("aborted");
    expect(h.error).toBeInstanceOf(SettleError);
    await wait(15);
    expect(observedAborted).toBe(true);
    expect(cleaned).toBe(true);
  });

  it("对已 settled 句柄 abort 是 no-op(状态不变、不抛)", async () => {
    const { handles } = eagerFork<number>([{ id: "a", run: () => 1 }]);
    const h = handles[0]!;
    expect(await awaitHandle(h)).toBe(1);
    const codesBefore = [...h.codes];
    expect(() => abortHandle(h)).not.toThrow();
    expect(h.state).toBe("fulfilled");
    expect(h.error).toBeUndefined();
    expect(h.codes).toEqual(codesBefore);
    expect(h.controller.signal.aborted).toBe(false);
  });

  it("cancelAll 默认 CANCELLED,返回后全部 aborted", async () => {
    const { handles } = eagerFork<string>(
      [untilAborted("a"), untilAborted("b"), untilAborted("c")],
      { env: { maxConcurrency: 2 } },
    );
    await wait(5);
    cancelAll(handles);
    for (const h of handles) {
      expect(h.state).toBe("aborted");
      expect((h.error as SettleError).code).toBe(SETTLE_CODES.CANCELLED);
      expect(h.controller.signal.aborted).toBe(true);
    }
    expect(handles[2]!.codes).toContain(SETTLE_CODES.CANCELLED);
    await wait(15);
  });

  it("cancelAll 支持自定义 code,排队中的任务永不执行", async () => {
    let ran = 0;
    const { handles } = eagerFork<string>(
      [
        {
          id: "first",
          run: async (ctx) => {
            ran += 1;
            while (!ctx.signal.aborted) await wait(2);
            return "x";
          },
        },
        {
          id: "queued",
          run: async () => {
            ran += 1;
            return "y";
          },
        },
      ],
      { env: { maxConcurrency: 1 } },
    );
    await wait(5);
    cancelAll(handles, SETTLE_CODES.RACE_ABORTED);
    expect(ran).toBe(1);
    expect(handles[1]!.state).toBe("aborted");
    expect((handles[1]!.error as SettleError).code).toBe(SETTLE_CODES.RACE_ABORTED);
    await wait(15);
    expect(ran).toBe(1);
    const typed: SettleHandle<string> = handles[0]!;
    expect(typed.state).toBe("aborted");
  });
});
