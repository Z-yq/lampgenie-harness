/**
 * step-0144 super agent 深化验收用例:
 * - WS 协议双写:super.turn 新名与 companion.turn 旧名均被受理(zod ClientMessage 联合);
 * - auto 研判闸:mode=observe 时 assess 恒不被调(零新增 LLM);mode=auto 时 inferred 候选
 *   走 assess,accept 且带 intent_evidence 才派发+落审计;
 * - sr8 闸:accept 缺 intent_evidence → 降级 ignore(不放松)。
 */
import { describe, it, expect, vi } from "vitest";
import { parseClientMessage, ServerMessage, PROTOCOL_VERSION } from "@lampgenie/protocol";
import { createRouter } from "../../src/router/index.js";
import { TaskSupervisor } from "../../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import { DEFAULT_POLICY_CONFIG, type PolicyConfig } from "../../src/router/policy.js";
import { recentSystemInjections } from "../../src/super-agent.js";

const configOf = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({ ...DEFAULT_POLICY_CONFIG, ...over });

describe("WS 协议 super 新链(step-1033)", () => {
  it("super.turn 新名被受理(进 ClientMessage 联合)", async () => {
    const m = parseClientMessage('{"v":1,"type":"super.turn","text":"现在有什么任务"}');
    expect(m?.type).toBe("super.turn");
  });
  it("companion.turn 旧名入站仍被受理(deprecated 入站兼容)", async () => {
    const m = parseClientMessage('{"v":1,"type":"companion.turn","text":"在干什么"}');
    expect(m?.type).toBe("companion.turn");
  });
  it("companion.history 入站仍受理,但新入口是 super.history/super.inbox/voice.transcribe", async () => {
    expect(parseClientMessage('{"v":1,"type":"companion.history"}')?.type).toBe("companion.history");
    expect(parseClientMessage('{"v":1,"type":"super.history"}')?.type).toBe("super.history");
    expect(parseClientMessage('{"v":1,"type":"super.inbox"}')?.type).toBe("super.inbox");
    expect(parseClientMessage('{"v":1,"type":"voice.transcribe","audioB64":"AAA="}')?.type).toBe("voice.transcribe");
    // voice.speak 已删除(不再受理)
    expect(parseClientMessage('{"v":1,"type":"voice.speak","audioB64":"AAA="}')).toBeNull();
  });
  it("出站是 super.turn.done(sessionId 用 super: 前缀)", async () => {
    const ok = ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "super.turn.done", text: "主仓有 1 条任务在跑", sessionId: "super:20261029" });
    expect(ok.success).toBe(true);
    const bad = ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "super.turn.done", text: "x" });
    expect(bad.success).toBe(false);
  });
  it("companion.* 服务端消息仍在联合里(legacy 只读,服务端不再发)", async () => {
    for (const msg of [
      { v: PROTOCOL_VERSION, type: "companion.turn.user", text: "在吗" },
      { v: PROTOCOL_VERSION, type: "companion.turn.done", text: "在", sessionId: "companion:20261029" },
      { v: PROTOCOL_VERSION, type: "companion.history.result", events: [] },
      { v: PROTOCOL_VERSION, type: "companion.relay", requestId: "ask-1", sessionId: "s", question: "q" },
      { v: PROTOCOL_VERSION, type: "companion.notice", text: "n" },
    ]) {
      expect(ServerMessage.safeParse(msg).success).toBe(true);
    }
    // 新链对应的 super.* 全在联合
    expect(ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "super.turn.user", text: "t" }).success).toBe(true);
    expect(ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "super.history.result", events: [] }).success).toBe(true);
    expect(ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "super.relay", requestId: "a", sessionId: "s", question: "q" }).success).toBe(true);
    expect(ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "super.notice", text: "n" }).success).toBe(true);
    expect(ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "super.inbox.result", items: [], ts: 1 }).success).toBe(true);
    expect(ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "super.inbox.changed" }).success).toBe(true);
    expect(ServerMessage.safeParse({ v: PROTOCOL_VERSION, type: "voice.transcribe.result", text: "t" }).success).toBe(true);
  });
  it("journal kind 双认:旧 companion.notice 与新 super.notice 均进近期系统注入", async () => {
    const journal = new MemoryJournal();
    journal.append({ kind: "companion.notice", sessionId: "super:20990101", payload: { text: "任务A完成" } });
    journal.append({ kind: "super.relay", sessionId: "super:20990101", payload: { text: "coding 助手提问" } });
    const s = recentSystemInjections(journal, new Date(2099, 0, 1));
    expect(s).toContain("[通知] 任务A完成");
    expect(s).toContain("[转接] coding 助手提问");
  });
});

describe("auto 研判闸(step-0144 sa7/sa8)", () => {
  it("mode=observe:assess 恒不被调(零新增 LLM,P1 行为不回归)", async () => {
    const tm = new TaskSupervisor();
    const assess = vi.fn();
    const router = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: configOf(), assess });
    const r = await router.submit({ source: "im", sessionId: "s-obs", instruction: "顺便帮我看下" });
    expect(r.outcome?.kind).toBe("observed");
    expect(assess).toHaveBeenCalledTimes(0);
  });

  it("mode=auto + assess 回 accept 带 intent_evidence → 派发 + 研判产物落审计", async () => {
    const tm = new TaskSupervisor();
    const submitSpy = vi.spyOn(tm, "submit");
    const router = createRouter({
      taskManager: tm,
      journal: new MemoryJournal(),
      config: configOf({ mode: "auto" }),
      assess: () => ({ decision: "accept", intent_evidence: "触发原文明确要求『跑全量测试』" }),
    });
    const r = await router.submit({ source: "im", sessionId: "s-auto", instruction: "顺便跑下全量测试" });
    expect(r.outcome?.kind).toBe("dispatched");
    expect(submitSpy).toHaveBeenCalledTimes(1);
    // 研判产物(含 evidence)落 disposition/审计:accept 派发=evidence 随 dispatched 行落账
    const ds = router.dispositions();
    const dispatched = ds.find((d) => d.outcome === "dispatched");
    expect(dispatched?.intent_evidence).toBe("触发原文明确要求『跑全量测试』");
  });

  it("mode=auto + accept 缺 intent_evidence → 仍 ignore(sr8 不放松)", async () => {
    const tm = new TaskSupervisor();
    const submitSpy = vi.spyOn(tm, "submit");
    const router = createRouter({
      taskManager: tm,
      journal: new MemoryJournal(),
      config: configOf({ mode: "auto" }),
      assess: () => ({ decision: "accept" }), // 缺证据
    });
    const r = await router.submit({ source: "im", sessionId: "s-auto2", instruction: "随便看看" });
    expect(r.outcome?.kind).toBe("observed");
    expect(submitSpy).toHaveBeenCalledTimes(0);
    const d = router.dispositions().at(-1);
    expect(d?.outcome).toBe("assessed-ignore");
    expect(String((d as { reason?: string }).reason)).toBe("missing-intent-evidence");
  });

  it("mode=auto + ignore → 不派发,落 assessed-ignore(decision-ignore)", async () => {
    const tm = new TaskSupervisor();
    const router = createRouter({
      taskManager: tm,
      journal: new MemoryJournal(),
      config: configOf({ mode: "auto" }),
      assess: () => ({ decision: "ignore", intent_evidence: "闲聊,无任务意图" }),
    });
    const r = await router.submit({ source: "im", sessionId: "s-auto3", instruction: "今天天气不错" });
    expect(r.outcome?.kind).toBe("observed");
    const d = router.dispositions().at(-1);
    expect(d?.outcome).toBe("assessed-ignore");
    expect(String((d as { reason?: string }).reason)).toBe("decision-ignore");
  });

  it("mode=auto 但 assess 回 undefined(fail-soft)→ 回退 observed 不派发", async () => {
    const tm = new TaskSupervisor();
    const router = createRouter({
      taskManager: tm,
      journal: new MemoryJournal(),
      config: configOf({ mode: "auto" }),
      assess: () => undefined,
    });
    const r = await router.submit({ source: "im", sessionId: "s-auto4", instruction: "解析失败形态" });
    expect(r.outcome?.kind).toBe("observed");
    expect(router.dispositions().at(-1)?.outcome).toBe("observed");
  });

  it("mode=auto:explicit trigger 不走 assess(研判只针对 inferred 候选)", async () => {
    const tm = new TaskSupervisor();
    const assess = vi.fn();
    const router = createRouter({ taskManager: tm, journal: new MemoryJournal(), config: configOf({ mode: "auto" }), assess });
    const r = await router.submit({ source: "panel", sessionId: "s-px", instruction: "显式面板提交" });
    expect(r.outcome?.kind).toBe("dispatched");
    expect(assess).toHaveBeenCalledTimes(0);
  });
});
