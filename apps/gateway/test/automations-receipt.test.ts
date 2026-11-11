/**
 * :定时投递协议 —— 探针 A-F。
 * 真 AutomationStore(临时目录落盘)+ 真 AutomationScheduler,onSubmit 用假实现;
 * 覆盖:成功 delivered/transient 退避/permanent 不空转/CAS/single-flight/receipt 容量/旧文件兼容。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationStore, AutomationScheduler, type Automation, type AutomationEvent } from "../src/automations.js";
import { occurrenceKey } from "@lampgenie/runtime/task/occurrence";
import { backoffMs, nextReceipt, receiptKeyFor, type Receipt } from "@lampgenie/runtime/task/delivery-receipt";

function mkStore() {
  const d = mkdtempSync(join(tmpdir(), "auto-receipt-"));
  const file = join(d, "automations.json");
  return { d, file, store: new AutomationStore(file) };
}

function mkSched(
  store: AutomationStore,
  onSubmit: (a: Automation) => void,
  events?: AutomationEvent[],
) {
  return new AutomationScheduler(
    store,
    (a) => {
      onSubmit(a);
      return "sid";
    },
    (e) => {
      events?.push(e);
    },
  );
}

function receiptOf(store: AutomationStore, id: string, instant: number): Receipt | undefined {
  const rk = receiptKeyFor(id, occurrenceKey(id, instant));
  return store.receiptsOf(id)[rk];
}

/** 构造一个必定到期的自动化,返回到期 instant(即 nextRunAt)。 */
function mkDue(store: AutomationStore): Automation {
  const a = store.create({ name: "n", instruction: "i", everyMinutes: 1 }) as Automation;
  return a;
}

describe("探针 A:成功 → delivered + nextRunAt 推进", () => {
  it("首次提交成功:receipt DELIVERED、nextRunAt 推进、事件带 receipt status/attempts", () => {
    const { d, store } = mkStore();
    const a = mkDue(store);
    const instant = a.nextRunAt;
    const submitted: Automation[] = [];
    const events: AutomationEvent[] = [];
    const sched = mkSched(store, (x) => submitted.push(x), events);

    expect(sched.tick(instant + 1)).toBe(1);
    expect(submitted).toHaveLength(1);
    const rc = receiptOf(store, a.id, instant);
    expect(rc?.status).toBe("DELIVERED");
    expect(rc?.attempts).toBe(0);
    expect(store.get(a.id)!.nextRunAt).toBe(instant + 1 + 60_000);
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("claimed");
    expect(events[0]!.receiptStatus).toBe("DELIVERED");
    expect(events[0]!.receiptAttempts).toBe(0);

 // 同一 occurrence 再 tick:single-flight(DELIVERED/ALREADY_COMPLETED)不重复提交
    store.get(a.id)!.nextRunAt = instant;
    expect(sched.tick(instant + 2)).toBe(0);
    expect(submitted).toHaveLength(1);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("探针 B:transient 失败 → pending + 退避", () => {
  it("首次 transient:receipt PENDING/attempts=1/nextAttemptAt=+30s,nextRunAt 不推进", () => {
    const { d, store } = mkStore();
    const a = mkDue(store);
    const instant = a.nextRunAt;
    const events: AutomationEvent[] = [];
    const sched = mkSched(store, () => { throw new Error("request timeout"); }, events);

    expect(sched.tick(instant + 1)).toBe(0);
    const rc = receiptOf(store, a.id, instant);
    expect(rc?.status).toBe("PENDING");
    expect(rc?.attempts).toBe(1);
    expect(rc?.nextAttemptAt).toBe(instant + 1 + 30_000);
    expect(store.get(a.id)!.nextRunAt).toBe(instant);
    expect(store.get(a.id)!.runCount).toBe(0);
    expect(events[0]!.status).toBe("failed");
    expect(events[0]!.receiptStatus).toBe("PENDING");
    expect(events[0]!.receiptAttempts).toBe(1);
    rmSync(d, { recursive: true, force: true });
  });

  it("探针 A(协议严格):首次 transient 后 now+1ms tick 不提交", () => {
    const { d, store } = mkStore();
    const a = mkDue(store);
    const instant = a.nextRunAt;
    let attempts = 0;
    const events: AutomationEvent[] = [];
    const sched = mkSched(store, () => {
      attempts++;
      throw new Error("ECONNRESET");
    }, events);

    expect(sched.tick(instant + 1)).toBe(0); // 第 1 次失败 → nextAttemptAt=instant+1+30s
    expect(attempts).toBe(1);

 // 距失败仅 1ms:receipt 门关,不提交
    expect(sched.tick(instant + 2)).toBe(0);
    expect(attempts).toBe(1);
    expect(events.at(-1)!.status).toBe("skipped");
    expect(events.at(-1)!.receiptStatus).toBe("PENDING");
    expect(events.at(-1)!.receiptAttempts).toBe(1);
    rmSync(d, { recursive: true, force: true });
  });

  it("探针 B(协议严格):退避到点(now+30s)后同一 occurrence 重试成功", () => {
    const { d, store } = mkStore();
    const a = mkDue(store);
    const instant = a.nextRunAt;
    let attempts = 0;
    const sched = mkSched(store, () => {
      attempts++;
      if (attempts === 1) throw new Error("ECONNRESET");
    });

    expect(sched.tick(instant + 1)).toBe(0); // 第 1 次失败 → 30s 退避
    expect(attempts).toBe(1);

    expect(sched.tick(instant + 1 + backoffMs(1))).toBe(1); // 恰好到 nextAttemptAt → 提交成功
    expect(attempts).toBe(2);
    const rc = receiptOf(store, a.id, instant);
    expect(rc?.status).toBe("DELIVERED");
    expect(rc?.attempts).toBe(1); // 成功不累加,保留历史失败次数
    expect(store.get(a.id)!.nextRunAt).toBeGreaterThan(instant);
    rmSync(d, { recursive: true, force: true });
  });

  it("探针 C(协议严格):第二次 transient 后 60s 退避,窗口内 skip 分支推进 nextRunAt", () => {
    const { d, store } = mkStore();
    const a = mkDue(store);
    const instant = a.nextRunAt;
    let attempts = 0;
    const events: AutomationEvent[] = [];
    const sched = mkSched(store, () => {
      attempts++;
      throw new Error("HTTP 503 Service Unavailable");
    }, events);

    expect(sched.tick(instant + 1)).toBe(0); // 第 1 次失败 → 30s 退避
    const r1 = receiptOf(store, a.id, instant);
    expect(r1?.attempts).toBe(1);
    expect(r1?.nextAttemptAt).toBe(instant + 1 + 30_000);

    const t2 = instant + 1 + 30_000; // 到点后重试
    expect(sched.tick(t2)).toBe(0); // 第 2 次失败 → 60s 退避
    const rc = receiptOf(store, a.id, instant);
    expect(rc?.attempts).toBe(2);
    expect(rc?.nextAttemptAt).toBe(t2 + backoffMs(2));
    expect(rc?.nextAttemptAt).toBe(t2 + 60_000);
    expect(store.get(a.id)!.nextRunAt).toBe(instant); // transient 不推进

 // 退避窗口内再 tick:claim 成功但 receipt 门关 → 不提交,tick 不计数,markRun 推进
    expect(sched.tick(t2 + 1)).toBe(0);
    expect(attempts).toBe(2);
    expect(store.get(a.id)!.nextRunAt).toBe(t2 + 1 + 60_000);
    expect(events.at(-1)!.status).toBe("skipped");
    expect(events.at(-1)!.receiptStatus).toBe("PENDING");
    rmSync(d, { recursive: true, force: true });
  });

  it("退避窗口内不投递;新发生重新计 attempts;attempts=3 时退避 120s", () => {
    const { d, store } = mkStore();
    const a = mkDue(store);
    const instant = a.nextRunAt;
    const sched = mkSched(store, () => {
      throw new Error("temporarily unavailable");
    });

    const t2 = instant + 1 + 30_000;
    expect(sched.tick(instant + 1)).toBe(0); // 第 1 次失败 → 30s 退避
    expect(sched.tick(t2)).toBe(0); // 到点重试 → 第 2 次失败 → 60s 退避
    const rc = receiptOf(store, a.id, instant);
    expect(rc?.attempts).toBe(2);
    expect(rc?.nextAttemptAt).toBe(t2 + 60_000);

 // 退避窗口内 tick:不提交(attempts 不再增长),skip 分支推进 nextRunAt → 该发生被放弃
    expect(sched.tick(t2 + 1)).toBe(0);
    expect(receiptOf(store, a.id, instant)?.attempts).toBe(2);
    const next = store.get(a.id)!.nextRunAt;
    expect(next).toBe(t2 + 1 + 60_000);

 // 下一次计划发生是新的 occurrence:attempts 重新从 1 起
    expect(sched.tick(next + 1)).toBe(0);
    const fresh = receiptOf(store, a.id, next);
    expect(fresh?.attempts).toBe(1);
    expect(fresh?.nextAttemptAt).toBe(next + 1 + 30_000);

 // 纯函数链:第 3 次失败 → 120s(调度器层同一 occurrence 最多到 2 次)
    const third = nextReceipt({ key: "k", status: "PENDING", attempts: 2, at: 0 }, { ok: false, error: "timeout" }, { at: 0 });
    expect(third.attempts).toBe(3);
    expect(third.nextAttemptAt).toBe(120_000);
    expect(backoffMs(3)).toBe(120_000);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("探针 C:退避封顶 15min", () => {
  it("attempts 增大后 nextAttemptAt 差值封顶 900_000", () => {
    expect(backoffMs(6)).toBe(900_000);
    expect(backoffMs(10)).toBe(900_000);
    const base: Receipt = { key: "k", status: "PENDING", attempts: 20, nextAttemptAt: 0, at: 0 };
    const r = nextReceipt(base, { ok: false, error: "timeout" }, { at: 1_000 });
    expect(r.nextAttemptAt).toBe(1_000 + 900_000);
  });
});

describe("探针 D:permanent 失败 → failed 且不空转", () => {
  it("401 一次即 FAILED(无 nextAttemptAt),nextRunAt 仍推进", () => {
    const { d, store } = mkStore();
    const a = mkDue(store);
    const instant = a.nextRunAt;
    let attempts = 0;
    const events: AutomationEvent[] = [];
    const sched = mkSched(store, () => {
      attempts++;
      throw new Error("HTTP 401 Unauthorized");
    }, events);

    expect(sched.tick(instant + 1)).toBe(0);
    const rc = receiptOf(store, a.id, instant);
    expect(rc?.status).toBe("FAILED");
    expect(rc?.nextAttemptAt).toBeUndefined();
    expect(store.get(a.id)!.runCount).toBe(1); // permanent 仍 markRun
    expect(store.get(a.id)!.nextRunAt).toBe(instant + 1 + 60_000);
    expect(events[0]!.status).toBe("failed");
    expect(events[0]!.receiptStatus).toBe("FAILED");

 // 同一 occurrence 再 tick(把 nextRunAt 退回):不重试,不空转
    store.get(a.id)!.nextRunAt = instant;
    expect(sched.tick(instant + 2)).toBe(0);
    expect(attempts).toBe(1);
    expect(store.get(a.id)!.runCount).toBe(2); // skip 分支 markRun 推进,不算投递
    rmSync(d, { recursive: true, force: true });
  });
});

describe("探针 E:CAS 冲突不覆盖、revision 不变", () => {
  it("expectedRevision 不符 → {error:conflict,revision},字段与文件都不动", () => {
    const { d, file, store } = mkStore();
    const a = store.create({ name: "n", instruction: "i", everyMinutes: 5 }) as Automation;
    expect(a.revision).toBe(1);

    const ok = store.update(a.id, { name: "renamed" }, { expectedRevision: 1 }) as Automation;
    expect("error" in ok).toBe(false);
    expect(ok.revision).toBe(2);
    const before = readFileSync(file, "utf-8");

    const clash = store.update(a.id, { name: "hijack" }, { expectedRevision: 1 }) as { error: string; revision?: number };
    expect(clash.error).toBe("conflict");
    expect(clash.revision).toBe(2);
    expect(store.get(a.id)!.name).toBe("renamed");
    expect(store.get(a.id)!.revision).toBe(2);
    expect(readFileSync(file, "utf-8")).toBe(before); // 冲突不写盘

 // 不带 expectedRevision 的旧调用形态:正常改并 +1
    const legacy = store.update(a.id, { enabled: false }) as Automation;
    expect(legacy.revision).toBe(3);
 // expectedRevision 也可放在 patch 里(server 透传形态)
    const viaPatch = store.update(a.id, { enabled: true, expectedRevision: 3 }) as Automation;
    expect(viaPatch.revision).toBe(4);
    rmSync(d, { recursive: true, force: true });
  });

  it("不存在 → error 且不带 conflict", () => {
    const { d, store } = mkStore();
    const r = store.update("missing", { name: "x" }, { expectedRevision: 1 }) as { error: string; revision?: number };
    expect(r.error).toBe("不存在");
    expect(r.revision).toBeUndefined();
    rmSync(d, { recursive: true, force: true });
  });
});

describe("探针 F:single-flight 与 manual", () => {
  it("同 occurrence 已 claim(残留)→ 不重复提交,只推进 nextRunAt", () => {
    const { d, store } = mkStore();
    const a = mkDue(store);
    const instant = a.nextRunAt;
    store.get(a.id)!.occurrences = { [occurrenceKey(a.id, instant)]: { status: "claimed", at: instant } };
    const submitted: Automation[] = [];
    const events: AutomationEvent[] = [];
    const sched = mkSched(store, (x) => submitted.push(x), events);
    expect(sched.tick(instant + 1)).toBe(0);
    expect(submitted).toHaveLength(0);
    expect(events[0]!.status).toBe("skipped");
    expect(store.get(a.id)!.nextRunAt).toBe(instant + 1 + 60_000);
    rmSync(d, { recursive: true, force: true });
  });

  it("manual 不 claim、不写 receipt,可重复触发", () => {
    const { d, store } = mkStore();
    const a = mkDue(store);
    const nextBefore = a.nextRunAt;
    const submitted: Automation[] = [];
    const events: AutomationEvent[] = [];
    const sched = mkSched(store, (x) => submitted.push(x), events);
    expect(sched.runNow(a.id)).toBeTruthy();
    expect(sched.runNow(a.id)).toBeTruthy();
    expect(submitted).toHaveLength(2);
    expect(store.get(a.id)!.nextRunAt).toBe(nextBefore);
    expect(store.get(a.id)!.occurrences ?? {}).toEqual({});
    expect(store.get(a.id)!.receipt ?? {}).toEqual({});
    expect(events.every((e) => e.trigger === "manual" && e.receiptStatus === undefined)).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("receipt 账本容量 20 与旧文件兼容", () => {
  it("25 条 receipt 只留最近 20,落盘一致", () => {
    const { d, file, store } = mkStore();
    const a = store.create({ name: "n", instruction: "i", everyMinutes: 1 }) as Automation;
    for (let i = 0; i < 25; i++) {
      store.writeReceipt(a.id, receiptKeyFor(a.id, occurrenceKey(a.id, 1_000 + i)), {
        key: receiptKeyFor(a.id, occurrenceKey(a.id, 1_000 + i)),
        status: "DELIVERED",
        attempts: 0,
        at: 5_000 + i,
      });
    }
    const ledger = store.receiptsOf(a.id);
    expect(Object.keys(ledger)).toHaveLength(20);
    expect(ledger[receiptKeyFor(a.id, occurrenceKey(a.id, 1_000))]).toBeUndefined();
    expect(ledger[receiptKeyFor(a.id, occurrenceKey(a.id, 1_004))]).toBeUndefined();
    expect(ledger[receiptKeyFor(a.id, occurrenceKey(a.id, 1_005))]?.status).toBe("DELIVERED");

    const reloaded = new AutomationStore(file);
    expect(Object.keys(reloaded.receiptsOf(a.id))).toHaveLength(20);
    rmSync(d, { recursive: true, force: true });
  });

  it("旧文件无 revision/receipt → 载入后 revision=1、receipt 空,照常调度", () => {
    const d = mkdtempSync(join(tmpdir(), "auto-legacy-"));
    const file = join(d, "automations.json");
    const legacy = {
      id: "legacy-1",
      name: "旧规则",
      instruction: "跑",
      everyMinutes: 1,
      enabled: true,
      createdAt: 1,
      lastRunAt: null,
      nextRunAt: 1_000,
      lastTaskSessionId: null,
      runCount: 0,
    };
    writeFileSync(file, JSON.stringify([legacy], null, 2) + "\n");
    const store = new AutomationStore(file);
    expect(store.get("legacy-1")!.revision).toBe(1);
    expect(store.receiptsOf("legacy-1")).toEqual({});
    const submitted: Automation[] = [];
    const sched = mkSched(store, (x) => submitted.push(x));
    expect(sched.tick(1_001)).toBe(1);
    expect(submitted).toHaveLength(1);
    expect(store.get("legacy-1")!.revision).toBe(1); // 调度不 bump 用户版本
    rmSync(d, { recursive: true, force: true });
  });
});
