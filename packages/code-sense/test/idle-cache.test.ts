import { describe, it, expect, vi } from "vitest";
import { LayerCache, createIdleMaintainer } from "../src/cache";

describe("闲时缓存维护(IdleCacheMaintainer)", () => {
  it("空闲超 TTL 的键被驱逐;最近在用的保留", async () => {
    let t = 1_000;
    const clock = () => t;
    const cache = new LayerCache<string>(async (k) => `v:${k}`, 10_000, clock);
    await cache.get("a");
    await cache.get("b");
    t = 5_000;
    await cache.get("a"); // a 触碰,b 空闲至此 4s
    t = 20_000; // 距 a 最近访问 15s,距 b 19s
    const m = createIdleMaintainer(cache, { idleTtlMs: 16_000 });
    const r = await m.maintenance(t);
    expect(r.evicted).toEqual(["b"]);
    expect(cache.peek("a")?.value).toBe("v:a");
    expect(cache.peek("b")).toBeUndefined();
  });

  it("陈旧但最近在用 → 注入 reloader 抢先重建;build 未被再调", async () => {
    let t = 1_000;
    const clock = () => t;
    let builds = 0;
    const cache = new LayerCache<string>(async () => {
      builds++;
      return "v1";
    }, 10_000, clock);
    await cache.get("a");
    expect(builds).toBe(1);
    t = 8_000; // 未过 TTL(10s)但已 7s 陈旧
    let reloads = 0;
    const m = createIdleMaintainer(cache, {
      idleTtlMs: 60_000,
      refreshStaleMs: 5_000,
      reloader: async () => {
        reloads++;
        return "v2";
      },
    });
    const r = await m.maintenance(t);
    expect(r.refreshed).toEqual(["a"]);
    expect(reloads).toBe(1);
    expect(cache.peek("a")?.value).toBe("v2"); // 直写生效
    expect(cache.peek("a")!.builtAt).toBe(8_000);
    expect(builds).toBe(1); // cache 自身 build 未再触发
  });

  it("reloader 失败 → 旧值原地不动(诚实续供),计入 refreshFailed", async () => {
    let t = 1_000;
    const clock = () => t;
    const cache = new LayerCache<string>(async () => "v1", 10_000, clock);
    await cache.get("a");
    t = 8_000;
    const m = createIdleMaintainer(cache, {
      idleTtlMs: 60_000,
      refreshStaleMs: 5_000,
      reloader: async () => {
        throw new Error("boom");
      },
    });
    const r = await m.maintenance(t);
    expect(r.refreshFailed).toEqual(["a"]);
    expect(r.refreshed).toHaveLength(0);
    expect(cache.peek("a")?.value).toBe("v1");
    expect(cache.peek("a")!.builtAt).toBe(1_000); // builtAt 未被刷新(不冒充新鲜)
  });

  it("维护并发不双飞:两个 maintenance 同抢一个陈旧键,reloader 只跑一次", async () => {
    let t = 1_000;
    const clock = () => t;
    const cache = new LayerCache<string>(async () => "v1", 10_000, clock);
    await cache.get("a");
    t = 8_000;
    let reloads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const m = createIdleMaintainer(cache, {
      idleTtlMs: 60_000,
      refreshStaleMs: 5_000,
      reloader: async () => {
        reloads++;
        await gate;
        return "v2";
      },
    });
    const p1 = m.maintenance(t);
    const p2 = m.maintenance(t);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(reloads).toBe(1); // single-flight:第二个 maintenance 看到 in-flight 直接让过
    expect(r1.refreshed.length + r1.refreshFailed.length + r2.refreshed.length + r2.refreshFailed.length).toBeLessThanOrEqual(2);
    expect(cache.peek("a")?.value).toBe("v2");
  });

  it("缺省 reloader 走 cache 自身 build(single-flight 计数=1);maxRefreshPerCycle 限量", async () => {
    let t = 1_000;
    const clock = () => t;
    let builds = 0;
    const cache = new LayerCache<string>(async (k) => {
      builds++;
      return `v:${k}`;
    }, 10_000, clock);
    await cache.get("a");
    await cache.get("b");
    await cache.get("c");
    t = 9_000; // 全部陈旧>5s 且未过 TTL
    const m = createIdleMaintainer(cache, { idleTtlMs: 60_000, refreshStaleMs: 5_000, maxRefreshPerCycle: 2 });
    const r = await m.maintenance(t);
    expect(r.refreshed).toHaveLength(2); // 预算截断
    expect(r.refreshFailed).toHaveLength(0);
    expect(builds).toBe(5); // 首轮 3 + 维护重建 2
    expect(cache.buildCount).toBe(5);
  });

  it("驱逐后 reloader 迟到返回:不复活已驱逐键", async () => {
    let t = 1_000;
    const clock = () => t;
    const cache = new LayerCache<string>(async () => "v1", 10_000, clock);
    await cache.get("a");
    let t2 = 8_000;
    const m = createIdleMaintainer(cache, {
      idleTtlMs: 20_000,
      refreshStaleMs: 5_000,
      reloader: async () => {
        // 重建期间维护时钟推进到 TTL 外 → 维护主循环在 await 之间不会重入,
        // 这里模拟 reloader 返回前键被外部驱逐
        t2 = 30_000;
        cache.evict("a");
        return "v2";
      },
    });
    void t2;
    t = 8_000;
    const r = await m.maintenance(t);
    expect(r.refreshed).toEqual(["a"]);
    expect(cache.peek("a")).toBeUndefined(); // 未复活
  });

  it("start/stop 定时驱动可用且 unref(不阻止进程退出)", async () => {
    let t = 1_000;
    const clock = () => t;
    const cache = new LayerCache<string>(async () => "v1", 10, clock);
    await cache.get("a");
    const m = createIdleMaintainer(cache, { idleTtlMs: 50 });
    const spy = vi.fn();
    const orig = m.maintenance.bind(m);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m as any).maintenance = (...args: unknown[]) => {
      spy();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (orig as any)(...args);
    };
    m.start(5);
    await vi.waitFor(() => {
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      expect(cache.keys()).toHaveLength(0); // 定时维护把 50ms 前的键驱逐了
    }, { timeout: 2_000 });
    m.stop();
    const calls = spy.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(spy.mock.calls.length).toBe(calls); // stop 后不再触发
  });
});
