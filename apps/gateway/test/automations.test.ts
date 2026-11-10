/**
 * 定时自动化:store CRUD/持久化/调度纯函数/手动运行。
 */
import { describe, it, expect } from "vitest";
import { AutomationStore, dueAutomations, AutomationScheduler, type Automation } from "../src/automations.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mkStore() {
  const d = mkdtempSync(join(tmpdir(), "auto-"));
  return { d, store: new AutomationStore(join(d, "automations.json")) };
}

describe("AutomationStore", () => {
  it("create 校验+list 排序+持久化重载", () => {
    const { d, store } = mkStore();
    expect(store.create({ name: " ", instruction: "x", everyMinutes: 5 })).toHaveProperty("error");
    expect(store.create({ name: "a", instruction: "", everyMinutes: 5 })).toHaveProperty("error");
    expect(store.create({ name: "a", instruction: "跑测试", everyMinutes: 0 })).toHaveProperty("error");
    const a = store.create({ name: "每日构建", instruction: "跑构建", everyMinutes: 1440 });
    expect(a).not.toHaveProperty("error");
    store.create({ name: "巡检", instruction: "巡检磁盘", everyMinutes: 30 });
    const re = new AutomationStore(join(d, "automations.json"));
    expect(re.list().map((x) => x.name)).toEqual(["每日构建", "巡检"]);
    expect(re.list()[0]!.enabled).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });

  it("update 启停/改间隔重排 nextRun;remove 持久化", () => {
    const { d, store } = mkStore();
    const a = store.create({ name: "n", instruction: "i", everyMinutes: 10 }) as Automation;
    store.update(a.id, { enabled: false });
    expect(store.get(a.id)!.enabled).toBe(false);
    const t0 = Date.now();
    store.update(a.id, { everyMinutes: 60 });
    expect(store.get(a.id)!.nextRunAt).toBeGreaterThanOrEqual(t0 + 59 * 60_000);
    store.remove(a.id);
    expect(new AutomationStore(join(d, "automations.json")).list()).toHaveLength(0);
    rmSync(d, { recursive: true, force: true });
  });

  it("dueAutomations 纯函数:只挑启用的到期项", () => {
    const { d, store } = mkStore();
    const on = store.create({ name: "on", instruction: "i", everyMinutes: 5 }) as Automation;
    const off = store.update((store.create({ name: "off", instruction: "i", everyMinutes: 5 }) as Automation).id, { enabled: false }) as Automation;
    const now = Date.now();
    const due = dueAutomations(store.list(), now + 6 * 60_000);
    expect(due.map((x) => x.id)).toEqual([on.id]);
    expect(due.some((x) => x.id === off.id)).toBe(false);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("AutomationScheduler", () => {
  it("tick 到期触发:onSubmit+journal 事件+重排下次;未到期不触发", async () => {
    const { d, store } = mkStore();
    const fired: { id: string; trigger: string }[] = [];
    const events: unknown[] = [];
    const sched = new AutomationScheduler(
      store,
      (a, trigger) => { fired.push({ id: a.id, trigger }); return "sid"; },
      (e) => events.push(e),
    );
    const a = store.create({ name: "n", instruction: "干活", everyMinutes: 1 }) as Automation;
    const t0 = a.createdAt;
    expect(sched.tick(t0 + 10_000)).toBe(0); // 未到期
    expect(fired).toHaveLength(0);
    expect(sched.tick(t0 + 61_000)).toBe(1); // 到期
    expect(fired[0]!.trigger).toBe("schedule");
    expect(events).toHaveLength(1);
    expect(store.get(a.id)!.runCount).toBe(1);
    expect(store.get(a.id)!.nextRunAt).toBeGreaterThanOrEqual(t0 + 61_000 + 59_000);
    expect(sched.tick(t0 + 61_000 + 5_000)).toBe(0); // 已重排,不再触发
    rmSync(d, { recursive: true, force: true });
  });

  it("runNow 手动触发不重排 nextRun;app 接线形态(onSubmit 走 TaskSupervisor)", async () => {
    const { d, store } = mkStore();
    const { TaskSupervisor } = await import("../src/task-manager.js");
    const tm = new TaskSupervisor();
    const seen: string[] = [];
    tm.onChange((t) => { if (t.state === "queued") seen.push(t.instruction); });
    const sched = new AutomationScheduler(store, (a) => tm.submit("system", `auto-${a.id.slice(0, 8)}`, a.instruction, { title: "[自动] " + a.name }).sessionId, () => {});
    const a = store.create({ name: "巡检", instruction: "巡检指令", everyMinutes: 30 }) as Automation;
    const nextBefore = a.nextRunAt;
    const sid = sched.runNow(a.id);
    expect(sid).toBeTruthy();
    expect(store.get(a.id)!.runCount).toBe(1);
    expect(store.get(a.id)!.nextRunAt).toBe(nextBefore); // 手动不重排
    expect(seen).toContain("巡检指令");
    rmSync(d, { recursive: true, force: true });
  });
});
