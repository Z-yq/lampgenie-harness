import { describe, it, expect, vi } from "vitest";
import { TaskSupervisor } from "../../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import { createRouter } from "../../src/router/index.js";
import { DEFAULT_POLICY_CONFIG, type PolicyConfig } from "../../src/router/policy.js";

const configOf = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({ ...DEFAULT_POLICY_CONFIG, ...over });

describe(" P3 Eval 重试熔断(DSH evals deadline×2+unavailable 等价)", () => {
  it("assess 永挂 → 重排 3 次(deadline)后 unavailable:不派发、不 throw", async () => {
    const tm = new TaskSupervisor();
    const submitSpy = vi.spyOn(tm, "submit");
    const assess = vi.fn(() => new Promise(() => {})); // 永不 resolve
    const router = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: configOf({ mode: "auto", evalDeadlineMs: 30 }), assess });
    // im 来源未点名 → inferred 候选走 assess
    const r = await router.submit({ source: "im", sessionId: "s1", instruction: "顺手修下 bug", identity: "u1" });
    expect(assess.mock.calls.length).toBe(3); // 首发+重排2
    expect(submitSpy).toHaveBeenCalledTimes(0);
    expect(r.outcome?.kind).toBe("observed");
    expect(r.outcome.disposition.outcome).toBe("unavailable");
    expect(router.dispositions().some((d) => d.outcome === "unavailable" && d.reason === "assess-timeout-3")).toBe(true);
  }, 10000);

  it("首次挂、第二次成功 → 正常 accept 派发(带 intent_evidence)", async () => {
    const tm = new TaskSupervisor();
    let n = 0;
    const assess = vi.fn(async () => {
      n++;
      if (n === 1) return await new Promise(() => {}); // 首发永挂
      return { decision: "accept" as const, intent_evidence: "用户说修 bug,目标明确" };
    });
    const router = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: configOf({ mode: "auto", evalDeadlineMs: 30 }), assess });
    const r = await router.submit({ source: "im", sessionId: "s1", instruction: "修 bug", identity: "u1" });
    expect(assess.mock.calls.length).toBe(2);
    expect(r.outcome?.kind).toBe("dispatched");
    expect(router.dispositions().some((d) => d.outcome === "dispatched" && d.intent_evidence === "用户说修 bug,目标明确")).toBe(true);
  }, 10000);

  it("observe 模式 assess 恒不被调(P1 零 LLM 不回归)+ assess 抛错 fail-soft 记 unavailable", async () => {
    const tm = new TaskSupervisor();
    const assess = vi.fn(async () => { throw new Error("boom"); });
    const router = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: configOf({ mode: "observe", evalDeadlineMs: 30 }), assess });
    await router.submit({ source: "im", sessionId: "s1", instruction: "修 bug", identity: "u1" });
    expect(assess).not.toHaveBeenCalled();
    // auto + 抛错 → catch 记 timeout 路径 → unavailable(fail-soft 不 throw)
    const tm2 = new TaskSupervisor();
    const assess2 = vi.fn(async () => { throw new Error("boom"); });
    const r2 = createRouter({ taskManager: tm2, journal: new MemoryJournal(), config: configOf({ mode: "auto", evalDeadlineMs: 30 }), assess: assess2 });
    const out2 = await r2.submit({ source: "im", sessionId: "s1", instruction: "修 bug", identity: "u1" });
    expect(out2.outcome?.disposition.outcome).toBe("unavailable");
  }, 10000);
});
