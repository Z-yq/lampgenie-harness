/**
 * 分层缓存 + single-flight(designs/16 §8)。
 * 键=层名+项目根;失效=显式 refresh 或指纹变化(一期:构建时刻戳)。
 * 二期追加:逐键最近访问跟踪 + 闲时维护(IdleCacheMaintainer,designs/16 §8 缓存治理)——
 * 消费方在空闲时机显式调 maintenance(now):空闲过期键驱逐、陈旧但最近在用的键
 * 抢先重建(single-flight;失败吞掉=诚实续供旧值,不装刷新成功)。
 */
export interface CacheEntry<T> {
  value: T;
  builtAt: number;
}

export class LayerCache<T> {
  private entries = new Map<string, CacheEntry<T>>();
  private inflight = new Map<string, Promise<T>>();
  /** 逐键最近访问时刻(闲时维护的驱逐依据;get 即触碰,含命中与重建)。 */
  private lastAccess = new Map<string, number>();
  /** 构建调用计数(测试断言 single-flight 用)。 */
  buildCount = 0;

  constructor(
    private readonly build: (key: string) => Promise<T>,
    private readonly ttlMs: number,
    /** 可注入时钟(闲时维护测试确定性;缺省真实时钟,既有行为不变)。 */
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string, opts: { refresh?: boolean } = {}): Promise<CacheEntry<T>> {
    const t = this.now();
    this.lastAccess.set(key, t);
    const cached = this.entries.get(key);
    const fresh = cached && t - cached.builtAt < this.ttlMs;
    if (fresh && !opts.refresh) return cached;

    // single-flight:同 key 并发只构建一次,共享同一 promise
    let p = this.inflight.get(key);
    if (!p) {
      this.buildCount++;
      p = this.build(key).then((value) => {
        const entry: CacheEntry<T> = { value, builtAt: this.now() };
        this.entries.set(key, entry);
        return value;
      }).finally(() => {
        this.inflight.delete(key);
      });
      this.inflight.set(key, p);
    }
    const value = await p;
    return this.entries.get(key) ?? { value, builtAt: this.now() };
  }

  // —— 闲时维护挂钩(只读视图 + 驱逐 + 直写;不触碰 single-flight 状态) ——

  keys(): string[] {
    return [...this.entries.keys()];
  }

  entryMeta(key: string): { builtAt: number; lastAccess: number } | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    return { builtAt: e.builtAt, lastAccess: this.lastAccess.get(key) ?? e.builtAt };
  }

  /** 不触碰 lastAccess 的读取(维护决策用)。 */
  peek(key: string): CacheEntry<T> | undefined {
    return this.entries.get(key);
  }

  evict(key: string): boolean {
    this.lastAccess.delete(key);
    return this.entries.delete(key);
  }

  /** 闲时重建成功后的直写(不触发 build)。 */
  put(key: string, value: T): void {
    const t = this.now();
    this.entries.set(key, { value, builtAt: t });
    this.lastAccess.set(key, t);
  }
}

export interface MaintenanceReport {
  evicted: string[];
  refreshed: string[];
  refreshFailed: string[];
}

export interface IdleMaintainerOpts<T> {
  /** 空闲(距最近访问)超过该时长的键被驱逐。 */
  idleTtlMs: number;
  /** 最近在用但构建已超过该时长的键,闲时抢先重建(缺省=不主动重建)。 */
  refreshStaleMs?: number;
  /** 注入式重建器(缺省走 cache 自身 build 的 single-flight refresh)。 */
  reloader?: (key: string) => Promise<T>;
  /** 单轮维护最多重建几个键(闲时也不许喧宾夺主)。 */
  maxRefreshPerCycle?: number;
}

export class IdleCacheMaintainer<T> {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 维护侧 single-flight(reloader 直写路径;缺省路径由 LayerCache inflight 承担)。 */
  private refreshing = new Set<string>();

  constructor(
    private readonly cache: LayerCache<T>,
    private readonly opts: IdleMaintainerOpts<T>,
  ) {}

  /** 一次维护:先驱逐空闲过期键,再限量重建陈旧在用键。now 由调用方传入(空闲时机自判)。 */
  async maintenance(now: number = Date.now()): Promise<MaintenanceReport> {
    const report: MaintenanceReport = { evicted: [], refreshed: [], refreshFailed: [] };
    const budget = this.opts.maxRefreshPerCycle ?? 4;
    for (const key of this.cache.keys()) {
      const meta = this.cache.entryMeta(key);
      if (!meta) continue; // 迭代中被并发驱逐:跳过
      if (now - meta.lastAccess > this.opts.idleTtlMs) {
        this.cache.evict(key);
        report.evicted.push(key);
        continue;
      }
      if (this.opts.refreshStaleMs !== undefined && now - meta.builtAt > this.opts.refreshStaleMs) {
        if (report.refreshed.length + report.refreshFailed.length >= budget) continue;
        await this.refreshOne(key, report);
      }
    }
    return report;
  }

  private async refreshOne(key: string, report: MaintenanceReport): Promise<void> {
    if (this.refreshing.has(key)) return; // 维护侧 single-flight(自定义 reloader 路径)
    this.refreshing.add(key);
    try {
      if (this.opts.reloader) {
        const value = await this.opts.reloader(key);
        // 重建成功但键已被并发驱逐:不复活(闲时维护不做惊喜写入)
        if (this.cache.entryMeta(key)) this.cache.put(key, value);
      } else {
        // 缺省路径:cache 自身 build 的 refresh(仍在 LayerCache single-flight 之下)
        await this.cache.get(key, { refresh: true });
      }
      report.refreshed.push(key);
    } catch {
      // 失败吞掉:旧值原地不动(诚实续供 stale-serve,不冒充已刷新)
      report.refreshFailed.push(key);
    } finally {
      this.refreshing.delete(key);
    }
  }

  /** 可选定时驱动(生产用;测试请直呼 maintenance 以保确定性)。unref:不阻止进程退出。 */
  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.maintenance();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** 闲时维护器工厂(消费方在空闲时机调 maintenance/start)。 */
export function createIdleMaintainer<T>(cache: LayerCache<T>, opts: IdleMaintainerOpts<T>): IdleCacheMaintainer<T> {
  return new IdleCacheMaintainer(cache, opts);
}
