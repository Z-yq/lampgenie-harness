/**
 * F6 WorkflowAskRouter:离线直通 null/在线广播+直答/超时回退 null。
 */
import { describe, it, expect } from "vitest";
import { WorkflowAskRouter } from "../src/workflow-ask-router.js";

describe("WorkflowAskRouter(F6)", () => {
  it("离线=立即 null(不广播,回退 executor)", async () => {
    const sent: unknown[] = [];
    const r = new WorkflowAskRouter((m) => sent.push(m), 50);
    r.online = false;
    expect(await r.ask("wf-1", "k1", "问点什么")).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("在线:广播问题;面板直答命中", async () => {
    const sent: unknown[] = [];
    const r = new WorkflowAskRouter((m) => sent.push(m), 3000);
    r.online = true;
    const p = r.ask("wf-2", "k2", "选哪个分支?");
    await new Promise((res) => setTimeout(res, 20));
    expect(sent).toHaveLength(1);
    expect((sent[0] as Record<string, unknown>).type).toBe("workflow.question");
    r.answer("k2", "main");
    expect(await p).toBe("main");
    expect(r.answer("k2", "again")).toBe(false); // 已结算
  });

  it("超时=null(引擎回退 executor);晚到的 answer 无效", async () => {
    const r = new WorkflowAskRouter(() => {}, 40);
    r.online = true;
    const t0 = Date.now();
    expect(await r.ask("wf-3", "k3", "x")).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(r.answer("k3", "late")).toBe(false);
  });
});
