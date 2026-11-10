import { describe, it, expect, vi } from "vitest";
import { TaskSupervisor } from "../../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import { createRouter } from "../../src/router/index.js";
import { DEFAULT_POLICY_CONFIG, type PolicyConfig } from "../../src/router/policy.js";

const configOf = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({ ...DEFAULT_POLICY_CONFIG, ...over });

describe("router e2e:explicit 派发回执兼容 + 订阅直通 steer( sr6)", () => {
  it("explicit trigger→tm.submit 恰 1 次(idempotencyKey=user.<key>),task 字段与直提同构", async () => {
    const tm = new TaskSupervisor();
    const submitSpy = vi.spyOn(tm, "submit");
    const router = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: configOf() });
    const r = await router.submit({ source: "panel", sessionId: "s1", instruction: "写个 README", idempotencyKey: "k1" });
    expect(r.intake).toBe("stored");
    expect(r.outcome?.kind).toBe("dispatched");
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const call = submitSpy.mock.calls[0];
    expect(call?.[0]).toBe("user");
    expect(call?.[1]).toBe("s1");
    expect(call?.[2]).toBe("写个 README");
    expect(call?.[3]).toMatchObject({ idempotencyKey: "user.k1" });
    // task.submitted 回执字段与现状一致(state/idempotencyKey/sessionId/instruction/title 派生)
    const task = r.outcome.kind === "dispatched" ? r.outcome.task : undefined;
    expect(task).toMatchObject({ sessionId: "s1", instruction: "写个 README", state: expect.any(String), idempotencyKey: "user.k1" });
    expect(typeof task?.id).toBe("string");
    // Ticket 落账:phase=open,taskId 承接
    const ticket = router.tickets().at(-1);
    expect(ticket).toMatchObject({ phase: "open", taskId: task?.id, threadKey: "session:s1" });
  });

  it("同 idempotencyKey 二次面板提交(订阅直通)→不新开任务,回执为已有任务", async () => {
    const tm = new TaskSupervisor();
    const submitSpy = vi.spyOn(tm, "submit");
    const router = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: configOf() });
    const r1 = await router.submit({ source: "panel", sessionId: "s1", instruction: "x", idempotencyKey: "same" });
    // 同 key 重发(新 trigger.id,threadKey 命中活 Ticket 订阅)→ steer 直通注入既有任务,
    // 不新开 session/task(DoD「重复提交不新开任务」);tm 幂等兜底由 idempotencyKey 保证。
    const r2 = await router.submit({ source: "panel", sessionId: "s1", instruction: "x", idempotencyKey: "same" });
    const t1 = r1.outcome?.kind === "dispatched" ? r1.outcome.task.id : "";
    const t2 = (r2.outcome?.kind === "dispatched" || r2.outcome?.kind === "steered") ? r2.outcome.task?.id ?? "" : "";
    expect(t2).toBe(t1); // 回执=已有任务(steered 分支带 tm.get 的承接任务)
    expect(submitSpy).toHaveBeenCalledTimes(1); // 只首次派发
    expect(tm.list()).toHaveLength(1); // 不新开任务
  });

  it("订阅命中且 running→steer 被调,不新开任务", async () => {
    const tm = new TaskSupervisor({ maxConcurrent: 1, maxConcurrentPerOwner: 1 });
    const submitSpy = vi.spyOn(tm, "submit");
    const steer = vi.fn();
    const router = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: configOf(), steer });
    const r1 = await router.submit({ source: "panel", sessionId: "s1", instruction: "跑个构建" });
    expect(r1.outcome?.kind).toBe("dispatched");
    const task1 = r1.outcome?.kind === "dispatched" ? r1.outcome.task : undefined;
    expect(task1?.state).toBe("running");
    const ticket1 = router.tickets().at(-1);
    // 同 threadKey 后续 trigger(未 addressed 的 im 追问)→ 订阅直通
    const r2 = await router.submit({ source: "im", sessionId: "s1", instruction: "构建结果如何?" });
    expect(r2.outcome?.kind).toBe("steered");
    expect(steer).toHaveBeenCalledTimes(1);
    const steeredTicket = r2.outcome?.kind === "steered" ? r2.outcome.ticket : undefined;
    expect(steeredTicket?.ticketId).toBe(ticket1?.ticketId);
    expect(submitSpy).toHaveBeenCalledTimes(1); // 不新开任务
    expect(tm.list()).toHaveLength(1);
    const d = router.dispositions().at(-1);
    expect(d?.outcome).toBe("steered");
    expect(d?.steeredTicketId).toBe(ticket1?.ticketId);
  });

  it("订阅命中但任务已终态(非 running)→ 不 steer,走 explicit/addressed 派发或 observe", async () => {
    const tm = new TaskSupervisor();
    const steer = vi.fn();
    const router = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: configOf(), steer });
    const r1 = await router.submit({ source: "panel", sessionId: "s1", instruction: "快任务" });
    const task1 = r1.outcome?.kind === "dispatched" ? r1.outcome.task : undefined;
    expect(task1).toBeDefined();
    // 直接把任务置终态(模拟 echo 形执行器同步完成竞态:issue-service.ts:539 先例)
    tm.setState(tm.get(task1!.id)!, "done");
    const r2 = await router.submit({ source: "im", sessionId: "s1", instruction: "追问", addressed: true });
    expect(steer).toHaveBeenCalledTimes(0);
    expect(r2.outcome?.kind).toBe("dispatched");
    expect(tm.list()).toHaveLength(2);
  });

  it("ticket.updated 广播 payload 含 phase 字段", async () => {
    const tm = new TaskSupervisor();
    const updates: Record<string, unknown>[] = [];
    const router = createRouter({
      taskManager: tm,
      journal: new MemoryJournal(),
      config: configOf(),
      onTicketUpdated: (p) => updates.push({ ...p }),
    });
    router.submit({ source: "panel", sessionId: "s1", instruction: "x" });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ phase: "open" });
    expect(typeof updates[0]?.ticketId).toBe("string");
    expect(typeof updates[0]?.threadKey).toBe("string");
    expect(typeof updates[0]?.triggerId).toBe("string");
  });
});
