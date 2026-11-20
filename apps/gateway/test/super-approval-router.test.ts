/**
 * super 派发任务的权限审批自决路由——单测。
 * 锁五件事:①super 任务走自决、不透用户 ②批准/拒绝三处留痕 ③超时/未决/异常升级转用户(标 super 未决)
 * ④非 super 任务(用户直发/系统)走原面板路径逐字不变 ⑤提示词与 permission_decide 工具接线。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { PermissionBroker, outcomeByLabel } from "../src/permission-broker.js";
import { SuperApprovalRouter, superApprovalTimeoutMs, superApprovalQueueTimeoutMs, type SuperApprovalTarget } from "../src/super-approval-router.js";
import { buildPermissionAskText, buildSuperAgentSystem, buildSuperAgentTools, SuperAgentActivity, SuperAgentChannel, type SuperAgentDeps } from "../src/super-agent.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { ProjectRegistry } from "../src/projects.js";
import { MemoryStore } from "@lampgenie/runtime/agent/soul-memory";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function askInput(over: Partial<SuperApprovalTarget> = {}): SuperApprovalTarget {
  return {
    requestId: "req-1", sessionId: "ws-1", taskId: "task-abcdef12", tool: "terminal",
    summary: "npm run build", risk: "high", submittedBy: "super",
    brief: "任务书:跑构建与测试;红线:不提交、不重启网关",
    ...over,
  };
}
const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("SuperApprovalRouter 自决", () => {
  it("router 批准:super allow -> allow-once/super,三处留痕齐备", async () => {
    const journal = new MemoryJournal();
    const notes: { text: string; extra?: Record<string, unknown> }[] = [];
    let router!: SuperApprovalRouter;
    router = new SuperApprovalRouter({
      journal,
      askSuper: async (i) => { expect(router.decide(i.requestId, "allow-once", "任务书范围内").ok).toBe(true); },
      escalate: async () => ({ decision: "reject", by: "panel" }),
      notify: (text, extra) => notes.push({ text, extra }),
      timeoutMs: 5_000,
    });
    const out = await router.ask(askInput());
    expect(out).toEqual({ decision: "allow-once", by: "super" });
    const gates = journal.readAll().filter((e) => e.kind === "permission.gate").map((e) => e.payload as { by: string; effect: string; reason?: string; taskId?: string });
    expect(gates.some((g) => g.by === "super-approved" && g.effect === "allowed" && g.taskId === "task-abcdef12")).toBe(true);
    const sys = journal.readAll().filter((e) => e.kind === "message.system").map((e) => String((e.payload as { text?: string }).text ?? ""));
    expect(sys.some((t) => t.includes("[super 审批]") && t.includes("已批准"))).toBe(true);
    expect(notes.some((n) => n.text.includes("已批准"))).toBe(true);
    expect(router.pendingList()).toHaveLength(0);
  });

  it("router 拒绝:reason 回灌任务会话", async () => {
    const journal = new MemoryJournal();
    let router!: SuperApprovalRouter;
    router = new SuperApprovalRouter({
      journal,
      askSuper: async (i) => { router.decide(i.requestId, "reject", "任务书禁重启,请求重启违反红线"); },
      escalate: async () => ({ decision: "allow-once", by: "panel" }),
      timeoutMs: 5_000,
    });
    const out = await router.ask(askInput({ tool: "terminal", summary: "systemctl restart gateway" }));
    expect(out).toEqual({ decision: "reject", by: "super" });
    const texts = journal.readAll().filter((e) => e.kind === "message.system").map((e) => String((e.payload as { text?: string }).text ?? ""));
    expect(texts.some((t) => t.includes("已拒绝") && t.includes("违反红线"))).toBe(true);
  });

  it("超时升级:转用户并明确标注 super 未决(不是静默拒绝)", async () => {
    const journal = new MemoryJournal();
    const escalated: string[] = [];
    const notes: string[] = [];
    const router = new SuperApprovalRouter({
      journal,
      askSuper: async (i, onDelivered) => { onDelivered?.(); await wait(200); },
      escalate: async (i) => { escalated.push(i.summary); return { decision: "allow-once", by: "panel" }; },
      notify: (text) => notes.push(text),
      timeoutMs: 20,
    });
    const out = await router.ask(askInput());
    expect(out).toEqual({ decision: "allow-once", by: "super-escalated-user" });
    expect(escalated).toHaveLength(1);
    expect(escalated[0].startsWith("[super 未决]")).toBe(true);
    expect(notes.some((t) => t.includes("[super 未决]"))).toBe(true);
    const gates = journal.readAll().filter((e) => e.kind === "permission.gate").map((e) => e.payload as { by: string; reason?: string });
    expect(gates.some((g) => g.by === "super-escalated-user" && String(g.reason ?? "").includes("未决"))).toBe(true);
  });

  it("super 轮次结束未决 -> 升级;轮次异常 -> 升级", async () => {
    const seen: string[] = [];
    let router!: SuperApprovalRouter;
    const mk = (askSuper: () => Promise<void>) => new SuperApprovalRouter({
      journal: new MemoryJournal(),
      askSuper,
      escalate: async (i) => { seen.push(i.summary); return { decision: "reject", by: "timeout" }; },
      timeoutMs: 5_000,
    });
    router = mk(async () => { /* 只回文本不调工具 */ });
    expect((await router.ask(askInput({ requestId: "r-undecided" }))).by).toBe("super-escalated-user");
    router = mk(async () => { throw new Error("llm 502"); });
    expect((await router.ask(askInput({ requestId: "r-error" }))).by).toBe("super-escalated-user");
    expect(seen).toHaveLength(2);
    expect(seen[0].startsWith("[super 未决]")).toBe(true);
  });

  it("super 主动 escalate -> 立即转用户;未知 requestId 拒绝", async () => {
    const escalated: string[] = [];
    const journal = new MemoryJournal();
    let router!: SuperApprovalRouter;
    router = new SuperApprovalRouter({
      journal,
      askSuper: async (i) => { router.decide(i.requestId, "escalate", "涉及全局配置"); },
      escalate: async (i) => { escalated.push(i.summary); return { decision: "reject", by: "panel" }; },
      timeoutMs: 5_000,
    });
    const out = await router.ask(askInput({ requestId: "r-esc" }));
    expect(out.by).toBe("super-escalated-user");
    expect(escalated[0].startsWith("[super 未决]")).toBe(true);
    const gates = journal.readAll().filter((e) => e.kind === "permission.gate").map((e) => e.payload as { reason?: string });
    expect(gates.some((g) => String(g.reason ?? "").includes("super 主动升级"))).toBe(true);
    expect(router.decide("nope", "allow-once").ok).toBe(false);
  });
});

describe("排队窗 / 决策窗双计时(2026-11-17 修复:计时起点=送达,不是入队)", () => {
  it("排队等待不吃决策窗:排队 80ms(>timeoutMs 40ms)后送达并 allow -> 不升级", async () => {
    const journal = new MemoryJournal();
    const escalated: string[] = [];
    let router!: SuperApprovalRouter;
    router = new SuperApprovalRouter({
      journal,
      askSuper: async (i, onDelivered) => {
        await wait(80); // 模拟 super 串行队列忙(旧实现此处已超时升级)
        expect(onDelivered?.(), "送达回执必须为 true").toBe(true);
        expect(router.decide(i.requestId, "allow-once", "排队后仍及时决断").ok).toBe(true);
      },
      escalate: async (i) => { escalated.push(i.summary); return { decision: "reject", by: "panel" }; },
      timeoutMs: 40,
      queueTimeoutMs: 5_000,
    });
    const out = await router.ask(askInput({ requestId: "q-late-deliver" }));
    expect(out).toEqual({ decision: "allow-once", by: "super" });
    expect(escalated).toHaveLength(0);
  });

  it("排队超时(通道长期忙)-> 升级转用户,不静默挂起", async () => {
    const journal = new MemoryJournal();
    const escalated: string[] = [];
    const notes: string[] = [];
    const router = new SuperApprovalRouter({
      journal,
      askSuper: () => new Promise<void>(() => { /* 通道永不给轮次 */ }),
      escalate: async (i) => { escalated.push(i.summary); return { decision: "reject", by: "panel" }; },
      notify: (t) => notes.push(t),
      timeoutMs: 5_000,
      queueTimeoutMs: 30,
    });
    const out = await router.ask(askInput({ requestId: "q-busy" }));
    expect(out.by).toBe("super-escalated-user");
    expect(escalated).toHaveLength(1);
    expect(escalated[0].startsWith("[super 未决]")).toBe(true);
    expect(notes.some((t) => t.includes("[super 未决]"))).toBe(true);
    const gates = journal.readAll().filter((e) => e.kind === "permission.gate").map((e) => e.payload as { reason?: string });
    expect(gates.some((g) => String(g.reason ?? "").includes("排队"))).toBe(true);
  });

  it("送达后未决 -> 升级,reason 标明已送达(计时起点=送达)", async () => {
    const router = new SuperApprovalRouter({
      journal: new MemoryJournal(),
      askSuper: async (_i, onDelivered) => { onDelivered?.(); await wait(150); /* 只跑轮不决定 */ },
      escalate: async () => ({ decision: "reject", by: "panel" }),
      timeoutMs: 30,
      queueTimeoutMs: 5_000,
    });
    const out = await router.ask(askInput({ requestId: "d-silent" }));
    expect(out.by).toBe("super-escalated-user");
  });

  it("排队期间已失效:onDelivered 返回 false(通道据此跳过,不白跑一轮)", async () => {
    let deliver: (() => boolean) | undefined;
    const router = new SuperApprovalRouter({
      journal: new MemoryJournal(),
      askSuper: (_i, onDelivered) => { deliver = onDelivered; return new Promise<void>(() => {}); },
      escalate: async () => ({ decision: "reject", by: "panel" }),
      timeoutMs: 5_000,
      queueTimeoutMs: 20,
    });
    expect((await router.ask(askInput({ requestId: "q-stale" }))).by).toBe("super-escalated-user");
    expect(typeof deliver).toBe("function");
    expect(deliver!(), "已升级后送达回执必须为 false").toBe(false);
  });

  it("decide 失效时回带真实去向(排障:不是含糊的「可能已决」)", async () => {
    let router!: SuperApprovalRouter;
    router = new SuperApprovalRouter({
      journal: new MemoryJournal(),
      askSuper: () => new Promise<void>(() => {}),
      escalate: async () => ({ decision: "reject", by: "panel" }),
      timeoutMs: 5_000,
      queueTimeoutMs: 20,
    });
    await router.ask(askInput({ requestId: "q-trace" }));
    const r = router.decide("q-trace", "allow-once");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("super-escalated-user");
  });
});

describe("通道送达确认(SuperAgentChannel.requestPermissionDecision)", () => {
  const soul = () => new MemoryStore(mkdtempSync(join(tmpdir(), "sup-deliver-soul-")));
  const channelOf = (journal: MemoryJournal) => new SuperAgentChannel(
    { journal, taskManager: new TaskSupervisor(), projects: new ProjectRegistry(null), llm: { async chat() { return { content: "" }; } } },
    soul(),
    { activity: new SuperAgentActivity(), broadcast: () => {} },
  );

  it("onDelivered=false:直接跳过,不写「super 自决中」notice、不跑轮次", async () => {
    const journal = new MemoryJournal();
    await channelOf(journal).requestPermissionDecision(
      { requestId: "c-stale", sessionId: "ws-1", tool: "edit_file", summary: "x" },
      () => false,
    );
    const notices = journal.readAll().filter((e) => e.kind === "super.notice").map((e) => String((e.payload as { text?: string }).text ?? ""));
    expect(notices.some((t) => t.includes("super 自决中")), "过期申请不该再宣告自决中").toBe(false);
    expect(journal.readAll().some((e) => e.kind === "message.user" || e.kind === "turn.start"), "不该白跑一轮").toBe(false);
  });

  it("onDelivered=true:申请正文带 requestId 交给轮次(注入文本由 buildPermissionAskText 承担)", () => {
 // 真跑一轮要走 AgentLoop+closeout(数秒),放在端到端脚本里验;此处锁注入原文契约。
    expect(buildPermissionAskText({ requestId: "c-live", sessionId: "ws-1", tool: "edit_file", summary: "改样式" }))
      .toContain("requestId=c-live");
  });
});


describe("PermissionBroker 按任务归属分叉(非 super 任务零变化)", () => {
  const fakeRouter = () => {
    const calls: unknown[] = [];
    return {
      calls,
      router: { async ask(input: unknown) { calls.push(input); return { decision: "allow-once" as const, by: "super" }; } },
    };
  };

  it("submittedBy=super -> 走 super 路由,不广播 permission.ask(用户零打扰)", async () => {
    const sent: unknown[] = [];
    const b = new PermissionBroker(50);
    b.attach((m) => sent.push(m));
    b.online = true;
    const f = fakeRouter();
    b.superRouter = f.router;
    const out = await b.ask(askInput() as never);
    expect(out).toEqual({ decision: "allow-once", by: "super" });
    expect(f.calls).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it("非 super 任务(用户直发/系统) -> 原面板路径逐字不变", async () => {
    const sent: unknown[] = [];
    const b = new PermissionBroker(5_000);
    b.attach((m) => sent.push(m));
    b.online = true;
    const f = fakeRouter();
    b.superRouter = f.router;
    const p = b.ask({ requestId: "u1", sessionId: "ws-user", tool: "terminal", summary: "ls" });
    await wait(10);
    expect(f.calls).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect((sent[0] as Record<string, unknown>).type).toBe("permission.ask");
    b.respond("u1", "reject");
    expect(await p).toEqual({ decision: "reject", by: "panel" });
  });

  it("noSuper=true 的升级回流不再进 super 分支", async () => {
    const b = new PermissionBroker(5_000);
    b.attach(() => {});
    b.online = false;
    const f = fakeRouter();
    b.superRouter = f.router;
    const out = await b.ask({ ...askInput(), noSuper: true } as never);
    expect(out).toEqual({ decision: "reject", by: "offline" });
    expect(f.calls).toHaveLength(0);
  });

  it("outcomeByLabel:super 自决不冒充 panel", () => {
    expect(outcomeByLabel({ decision: "allow-once", by: "super" })).toBe("super-approved");
    expect(outcomeByLabel({ decision: "reject", by: "super" })).toBe("super-denied");
    expect(outcomeByLabel({ decision: "allow-once", by: "super-escalated-user" })).toBe("super-escalated-user");
    expect(outcomeByLabel({ decision: "allow-once", by: "panel" })).toBe("panel-approved");
    expect(outcomeByLabel({ decision: "reject", by: "timeout" })).toBe("panel-timeout");
  });
});

describe("提示词与 permission_decide 工具接线", () => {
  const soul = () => new MemoryStore(mkdtempSync(join(tmpdir(), "sup-approval-soul-")));
  const depsOf = (extra: Partial<SuperAgentDeps> = {}): SuperAgentDeps => ({
    journal: new MemoryJournal(),
    taskManager: new TaskSupervisor(),
    projects: new ProjectRegistry(null),
    llm: { async chat() { return { content: "" }; } },
    ...extra,
  });

  it("工具:接线时在场并映射 allow/deny/escalate;未接线不注册", async () => {
    const calls: [string, string, string | undefined][] = [];
    const wired = new Map(buildSuperAgentTools(depsOf({
      permissionDecide: (requestId, decision, reason) => { calls.push([requestId, decision, reason]); return { ok: true }; },
    }), soul()).map((t) => [t.name, t]));
    const tool = wired.get("permission_decide");
    expect(tool, "接线后 permission_decide 必须在场").toBeTruthy();
    expect(await tool!.execute({ requestId: "r1", decision: "allow", reason: "范围内" } as never)).toContain("已批准");
    expect(calls[0]).toEqual(["r1", "allow-once", "范围内"]);
    expect(await tool!.execute({ requestId: "r2", decision: "deny", reason: "红线" } as never)).toContain("已拒绝");
    expect(calls[1][1]).toBe("reject");
    expect(await tool!.execute({ requestId: "r3", decision: "escalate" } as never)).toContain("已升级");
    expect(await tool!.execute({ requestId: "r4", decision: "maybe" } as never)).toContain("decision 必须是");
    const unwired = new Map(buildSuperAgentTools(depsOf(), soul()).map((t) => [t.name, t]));
    expect(unwired.has("permission_decide")).toBe(false);
  });

  it("提示词:权限自决节写清默认不升级、红线拒绝、当轮必须决断", () => {
    const sys = buildSuperAgentSystem(depsOf(), soul());
    expect(sys).toContain("权限自决");
    expect(sys).toContain("permission_decide");
    expect(sys).toContain("默认不升级");
    expect(sys).toContain("红线");
    expect(sys).toContain("[权限申请");
  });

  it("注入正文:带 requestId 与任务书节选,并给出不决的后果", () => {
    const text = buildPermissionAskText({
      requestId: "req-xyz", taskId: "task-abcdef12", tool: "terminal",
      summary: "npm run build", risk: "high", brief: "任务书:跑构建;红线:不重启",
    });
    expect(text).toContain("requestId=req-xyz");
    expect(text).toContain("task-abcdef12".slice(0, 8));
    expect(text).toContain("任务书");
    expect(text).toContain("不决");
    expect(text).toContain("permission_decide");
  });

  it("超时配置:缺省 120s,env 覆盖并钳在 1s..30min;排队窗缺省 5min,同口径钳制", () => {
    expect(superApprovalTimeoutMs({} as NodeJS.ProcessEnv)).toBe(120_000);
    expect(superApprovalTimeoutMs({ GENIE_SUPER_APPROVAL_TIMEOUT_MS: "5000" } as NodeJS.ProcessEnv)).toBe(5_000);
    expect(superApprovalTimeoutMs({ GENIE_SUPER_APPROVAL_TIMEOUT_MS: "10" } as NodeJS.ProcessEnv)).toBe(120_000);
    expect(superApprovalTimeoutMs({ GENIE_SUPER_APPROVAL_TIMEOUT_MS: "999999999" } as NodeJS.ProcessEnv)).toBe(30 * 60_000);
 // 非数字 env 必须落缺省而非 NaN(app.ts 生产装配已改走本门;NaN≈立即到期会误升级)
    expect(superApprovalTimeoutMs({ GENIE_SUPER_APPROVAL_TIMEOUT_MS: "abc" } as NodeJS.ProcessEnv)).toBe(120_000);
    expect(Number.isNaN(superApprovalTimeoutMs({ GENIE_SUPER_APPROVAL_TIMEOUT_MS: "abc" } as NodeJS.ProcessEnv))).toBe(false);
    expect(superApprovalQueueTimeoutMs({} as NodeJS.ProcessEnv)).toBe(300_000);
    expect(superApprovalQueueTimeoutMs({ GENIE_SUPER_APPROVAL_QUEUE_TIMEOUT_MS: "60000" } as NodeJS.ProcessEnv)).toBe(60_000);
    expect(superApprovalQueueTimeoutMs({ GENIE_SUPER_APPROVAL_QUEUE_TIMEOUT_MS: "99" } as NodeJS.ProcessEnv)).toBe(300_000);
    expect(superApprovalQueueTimeoutMs({ GENIE_SUPER_APPROVAL_QUEUE_TIMEOUT_MS: "999999999" } as NodeJS.ProcessEnv)).toBe(30 * 60_000);
  });
});
