/**
 * occurrence 账本接入生产调度器 —— 探针 A-E。
 * 真 AutomationStore + 真 AutomationScheduler,onSubmit 用假实现;
 * 覆盖崩溃窗口/重启恢复/失败重试/manual/容量上限。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationStore, AutomationScheduler, type Automation, type AutomationEvent } from "../src/automations.js";
import { occurrenceKey } from "@lampgenie/runtime/task/occurrence";

function mkStore() {
  const d = mkdtempSync(join(tmpdir(), "auto-occ-"));
  const file = join(d, "automations.json");
  return { d, file, store: new AutomationStore(file) };
}

function mkSched(store: AutomationStore, onFire: (a: Automation) => void, events?: AutomationEvent[]) {
  return new AutomationScheduler(
    store,
    (a, _trigger) => {
      onFire(a);
      return "sid";
    },
    (e) => {
      events?.push(e);
    },
  );
}

function dueInstant(store: AutomationStore, id: string): number {
  return store.get(id)!.nextRunAt;
}

/** 直接改持久化文件:模拟「重启时该规则仍然到期」或注入账本残留。 */
function rewind(file: string, id: string, nextRunAt: number, patch?: (a: Automation) => void): void {
  const raw = JSON.parse(readFileSync(file, "utf-8")) as Automation[];
  for (const a of raw) {
    if (a.id !== id) continue;
    a.nextRunAt = nextRunAt;
    patch?.(a);
  }
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
}

describe("探针 A:同一 nextRunAt 只提交一次", () => {
  it("重复 tick 同一 instant 不重复提交(崩溃窗口 completed 已落盘)", () => {
    const { d, store } = mkStore();
    const a = store.create({ name: "n", instruction: "i", everyMinutes: 1 }) as Automation;
    const instant = dueInstant(store, a.id);
    const submitted: Automation[] = [];
    const events: AutomationEvent[] = [];
    const sched = mkSched(store, (x) => submitted.push(x), events);

    expect(sched.tick(instant + 1)).toBe(1);
    expect(submitted).toHaveLength(1);
    const key = occurrenceKey(a.id, instant);
    expect(store.get(a.id)!.occurrences?.[key]?.status).toBe("completed");

 // 模拟「complete 已落盘、markRun 未落盘就崩溃」:把 nextRunAt 退回同一 instant
    store.get(a.id)!.nextRunAt = instant;
    expect(sched.tick(instant + 2)).toBe(0); // ALREADY_COMPLETED:不提交,tick 不计数
    expect(submitted).toHaveLength(1);
    expect(store.get(a.id)!.nextRunAt).toBeGreaterThan(instant); // 仍 markRun 推进,避免每 tick 重复尝试
    expect(store.get(a.id)!.runCount).toBe(2);

    expect(events[0]!.occurrenceKey).toBe(key);
    expect(events[0]!.status).toBe("claimed");
    expect(events[1]!.occurrenceKey).toBe(key);
    expect(events[1]!.status).toBe("skipped");

 // claimed 残留(内存内):同样不提交,只推进 nextRunAt
    const b = store.create({ name: "b", instruction: "i", everyMinutes: 1 }) as Automation;
    const instantB = dueInstant(store, b.id);
    store.get(b.id)!.occurrences = { [occurrenceKey(b.id, instantB)]: { status: "claimed", at: instantB } };
    expect(sched.tick(instantB + 1)).toBe(0);
    expect(submitted).toHaveLength(1);
    expect(store.get(b.id)!.nextRunAt).toBeGreaterThan(instantB);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("探针 B:completed 跨重启不再触发 / claimed 重启可重试", () => {
  it("新 store 读同一文件:completed 永不再提交", () => {
    const { d, file, store } = mkStore();
    const a = store.create({ name: "n", instruction: "i", everyMinutes: 1 }) as Automation;
    const instant = dueInstant(store, a.id);
    const submitted: Automation[] = [];
    const sched = mkSched(store, (x) => submitted.push(x));
    expect(sched.tick(instant + 1)).toBe(1);
    const key = occurrenceKey(a.id, instant);

 // 回写 nextRunAt 模拟重启后仍然到期,验证拦重复的是账本而不是 nextRunAt
    rewind(file, a.id, instant);
    const store2 = new AutomationStore(file);
    expect(store2.get(a.id)!.occurrences?.[key]?.status).toBe("completed");
    const submitted2: Automation[] = [];
    const sched2 = mkSched(store2, (x) => submitted2.push(x));
    expect(sched2.tick(instant + 2)).toBe(0);
    expect(submitted2).toHaveLength(0);
 // 跳过分支仍走 markRun(推进 nextRunAt 的代价是 runCount+1),但不提交新任务
    expect(store2.get(a.id)!.runCount).toBe(2);
    rmSync(d, { recursive: true, force: true });
  });

  it("claimed 残留(进程死在 submit 前)构造时重置为 failed,一次 tick 后重试成功", () => {
    const { d, file, store } = mkStore();
    const a = store.create({ name: "n", instruction: "i", everyMinutes: 1 }) as Automation;
    const instant = dueInstant(store, a.id);
    const key = occurrenceKey(a.id, instant);
    rewind(file, a.id, instant, (x) => {
      x.occurrences = { [key]: { status: "claimed", at: instant } };
    });

    const store2 = new AutomationStore(file);
    expect(store2.get(a.id)!.occurrences?.[key]?.status).toBe("failed");
    const submitted: Automation[] = [];
    const sched2 = mkSched(store2, (x) => submitted.push(x));
    expect(sched2.tick(instant + 2)).toBe(1);
    expect(submitted).toHaveLength(1);
    expect(store2.get(a.id)!.occurrences?.[key]?.status).toBe("completed");

 // 恢复只发生一次:再构造一次,completed 不被改写
    const store3 = new AutomationStore(file);
    expect(store3.get(a.id)!.occurrences?.[key]?.status).toBe("completed");
    rmSync(d, { recursive: true, force: true });
  });
});

describe("探针 C:submit 抛错 → release,下一 tick 重试", () => {
  it("首次抛错不推进 nextRunAt,释放后可重试成功", () => {
    const { d, store } = mkStore();
    const a = store.create({ name: "n", instruction: "i", everyMinutes: 1 }) as Automation;
    const instant = dueInstant(store, a.id);
    const key = occurrenceKey(a.id, instant);
    const submitted: Automation[] = [];
    let attempts = 0;
    const sched = new AutomationScheduler(
      store,
      (x) => {
        attempts++;
        if (attempts === 1) throw new Error("boom");
        submitted.push(x);
        return "sid";
      },
      () => {},
    );

    expect(sched.tick(instant + 1)).toBe(0); // 失败不计数
    expect(attempts).toBe(1);
    expect(store.get(a.id)!.occurrences?.[key]?.status).toBe("failed");
    expect(store.get(a.id)!.nextRunAt).toBe(instant); // 未 markRun → 下 tick 仍到期
    expect(store.get(a.id)!.runCount).toBe(0);

 // 首次 transient 也从 30s 退避起:过了 nextAttemptAt 再 tick 才重试
    expect(sched.tick(instant + 1 + 30_000)).toBe(1);
    expect(submitted).toHaveLength(1);
    expect(store.get(a.id)!.occurrences?.[key]?.status).toBe("completed");
    expect(store.get(a.id)!.runCount).toBe(1);
    rmSync(d, { recursive: true, force: true });
  });

  it("单个规则抛错不影响同 tick 其它规则", () => {
    const { d, store } = mkStore();
    const bad = store.create({ name: "bad", instruction: "i", everyMinutes: 1 }) as Automation;
    const good = store.create({ name: "good", instruction: "i", everyMinutes: 1 }) as Automation;
    const now = Math.max(dueInstant(store, bad.id), dueInstant(store, good.id)) + 1;
    const fired: string[] = [];
    const sched = new AutomationScheduler(
      store,
      (x) => {
        if (x.id === bad.id) throw new Error("boom");
        fired.push(x.id);
        return "sid";
      },
      () => {},
    );
    expect(sched.tick(now)).toBe(1);
    expect(fired).toEqual([good.id]);
    expect(store.get(bad.id)!.occurrences?.[occurrenceKey(bad.id, dueInstant(store, bad.id))]?.status).toBe("failed");
    rmSync(d, { recursive: true, force: true });
  });
});

describe("探针 D:manual 不占发生,可重复触发", () => {
  it("runNow 两次都提交,且不写 completed", () => {
    const { d, store } = mkStore();
    const a = store.create({ name: "n", instruction: "i", everyMinutes: 30 }) as Automation;
    const nextBefore = dueInstant(store, a.id);
    const submitted: Automation[] = [];
    const events: AutomationEvent[] = [];
    const sched = mkSched(store, (x) => submitted.push(x), events);

    expect(sched.runNow(a.id)).toBeTruthy();
    expect(sched.runNow(a.id)).toBeTruthy();
    expect(submitted).toHaveLength(2);
    expect(store.get(a.id)!.nextRunAt).toBe(nextBefore); // 手动不重排
    expect(store.get(a.id)!.runCount).toBe(2);
    expect(store.get(a.id)!.occurrences ?? {}).toEqual({});
    expect(events.map((e) => e.trigger)).toEqual(["manual", "manual"]);
    expect(events[0]!.occurrenceKey).toBeUndefined();
    expect(events[0]!.status).toBeUndefined();
    rmSync(d, { recursive: true, force: true });
  });
});

describe("探针 E:账本容量 50 淘汰最旧", () => {
  it("55 次 claim 后只留最近 50,最旧 5 个被淘汰且落盘一致", () => {
    const { d, file, store } = mkStore();
    const a = store.create({ name: "n", instruction: "i", everyMinutes: 1 }) as Automation;
    for (let i = 0; i < 55; i++) {
      expect(store.claimOccurrence(a.id, 1_000 + i, 2_000 + i)).toBe("CLAIMED");
    }
    const occ = store.get(a.id)!.occurrences!;
    expect(Object.keys(occ)).toHaveLength(50);
    expect(occ[occurrenceKey(a.id, 1_000)]).toBeUndefined();
    expect(occ[occurrenceKey(a.id, 1_004)]).toBeUndefined();
    expect(occ[occurrenceKey(a.id, 1_005)]?.status).toBe("claimed");
    expect(occ[occurrenceKey(a.id, 1_054)]?.status).toBe("claimed");

    const reloaded = new AutomationStore(file);
    expect(Object.keys(reloaded.get(a.id)!.occurrences!)).toHaveLength(50);
    rmSync(d, { recursive: true, force: true });
  });
});
