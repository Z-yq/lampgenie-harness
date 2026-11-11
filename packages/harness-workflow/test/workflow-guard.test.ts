import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { deriveWorkflowConcurrencyCeiling } from "@lampgenie/runtime/concurrency/ceiling";
import { WorkflowEngine } from "../src/engine";

const ROOT = "/mnt/e/workship/genie/lampgenie-harness";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const guardEvents = (j: MemoryJournal) =>
  j.readAll().filter((ev) => (ev.payload as { type?: string } | undefined)?.type === "workflow.guard");

describe("A 并发上限(caps.maxConcurrency)", () => {
  it("maxConcurrency=2 时 5 个 ask 峰值 inFlight=2", async () => {
    const j = new MemoryJournal();
    let cur = 0;
    let peak = 0;
    let calls = 0;
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-cap", executor: null as never,
      caps: { maxConcurrency: 2 },
      dispatch: async (instr) => {
        calls++;
        cur++;
        peak = Math.max(peak, cur);
        await sleep(10);
        cur--;
        return `结果:${instr}`;
      },
    });
    const r = await e.run(`
      const rs = await Promise.all([
        agent("a").ask("t1"), agent("a").ask("t2"), agent("a").ask("t3"),
        agent("a").ask("t4"), agent("a").ask("t5"),
      ]);
      report({ rs });
    `);
    expect(r.ok).toBe(true);
    expect(calls).toBe(5);
    expect(peak).toBe(2);
    expect((r.items[0] as { rs: string[] }).rs).toHaveLength(5);
  });

  it("maxConcurrency=1 时并发 ask 串行(peak=1)", async () => {
    const j = new MemoryJournal();
    let cur = 0;
    let peak = 0;
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-cap1", executor: null as never,
      caps: { maxConcurrency: 1 },
      dispatch: async () => {
        cur++;
        peak = Math.max(peak, cur);
        await sleep(5);
        cur--;
        return "ok";
      },
    });
    const r = await e.run(`
      await Promise.all([agent("a").ask("x1"), agent("a").ask("x2"), agent("a").ask("x3")]);
      report({ done: true });
    `);
    expect(r.ok).toBe(true);
    expect(peak).toBe(1);
  });

  it("无 caps 时缺省并发上限为 8(10 个并发 ask 峰值=8)", async () => {
    const j = new MemoryJournal();
    let cur = 0;
    let peak = 0;
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-defcap", executor: null as never,
      dispatch: async () => {
        cur++;
        peak = Math.max(peak, cur);
        await sleep(5);
        cur--;
        return "ok";
      },
    });
    const r = await e.run(`
      await Promise.all([
        agent("a").ask("d1"), agent("a").ask("d2"), agent("a").ask("d3"),
        agent("a").ask("d4"), agent("a").ask("d5"), agent("a").ask("d6"),
        agent("a").ask("d7"), agent("a").ask("d8"), agent("a").ask("d9"),
        agent("a").ask("d10"),
      ]);
      report({ done: true });
    `);
    expect(r.ok).toBe(true);
    expect(peak).toBe(8);
  });
});

describe("B 总派发上限 maxTotal", () => {
  it("maxTotal=3 时第 4 个 ask → TOTAL_EXCEEDED fatal,dispatch 只跑 3 次", async () => {
    const j = new MemoryJournal();
    let calls = 0;
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-total", executor: null as never,
      maxTotal: 3,
      caps: { maxConcurrency: 4 },
      dispatch: async () => { calls++; return "ok"; },
    });
    const r = await e.run(`
      for (const s of ["a", "b", "c", "d"]) { await agent("w").ask("任务" + s); }
      report({ done: true });
    `);
    expect(r.ok).toBe(false);
    expect(r.partial).toBe(true);
    expect(calls).toBe(3);
    expect(String(r.error)).toMatch(/^GUARD:TOTAL_EXCEEDED:/);
    expect(r.items).toHaveLength(0); // report 永远走不到
    const evs = guardEvents(j);
    expect(evs.length).toBeGreaterThanOrEqual(1);
    const last = evs[evs.length - 1]!.payload as { type: string; code: string; inFlight: number; total: number };
    expect(last.type).toBe("workflow.guard");
    expect(last.code).toBe("TOTAL_EXCEEDED");
    expect(last.total).toBe(3);
    expect(typeof last.inFlight).toBe("number");
  });

  it("未显式配置 maxTotal 时缺省 200(少量派发不受影响)", async () => {
    const j = new MemoryJournal();
    let calls = 0;
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-total-def", executor: null as never,
      dispatch: async () => { calls++; return "ok"; },
    });
    const r = await e.run(`
      await agent("a").ask("一");
      await agent("a").ask("二");
      report({ ok: true });
    `);
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect(guardEvents(j)).toHaveLength(0); // 未触发护栏就不写观测事件
  });
});

describe("C fatal 语义", () => {
  it("fatal 抛错时排队者 ABORTED,且从未真正派发", async () => {
    const j = new MemoryJournal();
    let calls = 0;
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-fatal", executor: null as never,
      caps: { maxConcurrency: 1 },
      maxTotal: 2,
      dispatch: async (instr) => {
        calls++;
        if (instr === "慢任务") { await sleep(40); return "慢结果"; }
        return "不该发生";
      },
    });
    const r = await e.run(`
      const p1 = agent("a").ask("慢任务");
      const p2 = agent("a").ask("排队任务").catch((e) => { log("guard-caught:" + ((e && e.code) || String(e))); });
      await agent("a").ask("超预算任务");
      await p1;
      report({ done: true });
    `);
    await sleep(10);
    expect(calls).toBe(1); // 排队者 p2 从未真正派发
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/^GUARD:TOTAL_EXCEEDED:/);
    expect(r.logs.some((l) => l.includes("guard-caught:ABORTED"))).toBe(true);
 // 在飞 p1 已收敛(settleOrder 等过它):结果事件已落盘
    const settled = j.readAll().filter((ev) => (ev.payload as { result?: unknown } | undefined)?.result !== undefined);
    expect(settled.length).toBe(1);
  });

  it("dispatch 抛 fatal:true 的错误 → GUARD:FATAL,run 返回 ok:false", async () => {
    const j = new MemoryJournal();
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-f2", executor: null as never,
      dispatch: async () => { throw Object.assign(new Error("链路崩了"), { fatal: true }); },
    });
    const r = await e.run(`await agent("w").ask("x");`);
    expect(r.ok).toBe(false);
    expect(r.partial).toBe(true);
    expect(String(r.error)).toMatch(/^GUARD:FATAL:/);
  });

  it("非 fatal 失败保持既有行为(错误原文,不带 GUARD 前缀)", async () => {
    const j = new MemoryJournal();
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-nf", executor: null as never,
      dispatch: async () => { throw new Error("普通派发失败"); },
    });
    const r = await e.run(`await agent("w").ask("x");`);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("普通派发失败");
    expect(String(r.error)).not.toMatch(/^GUARD:/);
  });
});

describe("D 结算顺序(run 返回前等在飞落定)", () => {
  it("脚本未 await 的派发:run 返回时已落定,之后无迟到 journal 写入", async () => {
    const j = new MemoryJournal();
    let done = false;
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-settle", executor: null as never,
      dispatch: async () => { await sleep(30); done = true; return "ok"; },
    });
    const r = await e.run(`agent("w").ask("游离派发"); report({ fired: true });`);
    expect(r.ok).toBe(true);
    expect(done).toBe(true); // run 收尾 settleOrder 已等到它
    const askCount = j.readAll().filter((ev) => ev.kind === "workflow.ask").length;
    const resultCount = j.readAll().filter((ev) => (ev.payload as { result?: unknown } | undefined)?.result !== undefined).length;
    expect(resultCount).toBe(1); // 结果事件在 run 返回前已写盘
    await sleep(40);
    expect(j.readAll().filter((ev) => ev.kind === "workflow.ask").length).toBe(askCount);
    expect(j.readAll().filter((ev) => (ev.payload as { result?: unknown } | undefined)?.result !== undefined).length).toBe(1);
  });
});

describe("F 双界:run 界 = min(caps.maxConcurrency, CPU 天花板)", () => {
  it("caps=32 但天花板更小 → 护栏实际并发取天花板(峰值=天花板,且 ≤16)", async () => {
    const ceiling = deriveWorkflowConcurrencyCeiling();
    const j = new MemoryJournal();
    let cur = 0;
    let peak = 0;
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-double-bound", executor: null as never,
      caps: { maxConcurrency: 32 },
      dispatch: async () => {
        cur++;
        peak = Math.max(peak, cur);
        await sleep(5);
        cur--;
        return "ok";
      },
    });
 // 构造时的护栏已按双界钳制(不靠行为推断装配事实)
    const guardMax = (e as unknown as { guard: { stats(): { maxConcurrent: number } } }).guard.stats().maxConcurrent;
    expect(guardMax).toBe(ceiling);
    const asks = Array.from({ length: 20 }, (_, i) => `agent("a").ask("c${i}")`).join(", ");
    const r = await e.run(`await Promise.all([${asks}]); report({ done: true });`);
    expect(r.ok).toBe(true);
    expect(peak).toBe(ceiling);
    expect(peak).toBeLessThanOrEqual(16); // 硬顶
    expect(peak).toBeLessThan(32); // 请求值没有被直接采用
  });
});

describe("E 无护栏配置零回归", () => {
  it("既有行为不变:r.caps 不出现,同一引擎可再次 run(护栏按 run 重置)", async () => {
    const j = new MemoryJournal();
    let calls = 0;
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-zero", executor: null as never,
      dispatch: async () => { calls++; return "ok"; },
    });
    const r1 = await e.run(`const a = await agent("a").ask("一"); report({ a });`);
    expect(r1.ok).toBe(true);
    expect(r1.caps).toBeUndefined();
    const r2 = await e.run(`const b = await agent("b").ask("二"); report({ b });`);
    expect(r2.ok).toBe(true);
    expect(calls).toBe(2);
 // items 是引擎级累积(既有行为:同一引擎多次 run 不清空),只看本次新增的最后一条
    expect(r2.items.at(-1)).toEqual({ b: "ok" });
  });
});
