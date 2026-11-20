/**
 * 需求二「super 通道请求消息体化」——单测。
 * 锁三件事:
 * ①runSuperAgentTurn 带 event:journal 落 message.system(0 条 message.user,payload.event.kind 在场);
 * ②不带 event 的旧路径仍落 message.user(兼容,行为逐字不变);
 * ③requestPermissionDecision:requestId 契约 + broadcast 新旧帧并存(super.event kind=permission-ask
 * 且 requestId 在场;旧 super.notice 帧照发)。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { MemoryStore } from "@lampgenie/runtime/agent/soul-memory";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSuperAgentTurn, superSessionId, SuperAgentActivity, SuperAgentChannel, type SuperAgentDeps } from "../src/super-agent.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { ProjectRegistry } from "../src/projects.js";

const soul = () => new MemoryStore(mkdtempSync(join(tmpdir(), "super-channel-soul-")));
const depsOf = (journal: MemoryJournal): SuperAgentDeps => ({
  journal,
  taskManager: new TaskSupervisor(),
  projects: new ProjectRegistry(null),
  llm: { async chat() { return { content: "收到,已处理。" }; } } as never,
});

describe("super 通道消息体化(runSuperAgentTurn event 口)", () => {
  it("带 event:0 条 message.user,≥1 条 message.system 且 payload.event.kind 在场;返回文本正常", async () => {
    const journal = new MemoryJournal();
    const sid = superSessionId();
    const out = await runSuperAgentTurn(depsOf(journal), "任务 t-123 申请 terminal(npm run build,风险 high),请自决。", soul(), {
      event: { kind: "permission-ask", requestId: "req-1", tool: "terminal", risk: "high" },
    });
    expect(out.text).toContain("已处理");
    const evs = journal.readAll().filter((e) => e.sessionId === sid);
    expect(evs.filter((e) => e.kind === "message.user")).toHaveLength(0);
    const sys = evs.filter((e) => e.kind === "message.system");
    expect(sys.length).toBeGreaterThanOrEqual(1);
    const ev = (sys[0]!.payload as { text?: string; event?: { kind?: string; requestId?: string } }).event;
    expect(ev?.kind).toBe("permission-ask");
    expect(ev?.requestId).toBe("req-1");
    expect(String((sys[0]!.payload as { text?: string }).text ?? "")).toContain("npm run build");
  }, 60_000);

  it("不带 event:旧路径仍落 message.user(兼容回退)", async () => {
    const journal = new MemoryJournal();
    const sid = superSessionId();
    const out = await runSuperAgentTurn(depsOf(journal), "现在有哪些活跃任务?", soul());
    expect(out.text).toContain("已处理");
    const evs = journal.readAll().filter((e) => e.sessionId === sid);
    expect(evs.some((e) => e.kind === "message.user")).toBe(true);
    expect(evs.filter((e) => e.kind === "message.system" && (e.payload as { event?: unknown }).event)).toHaveLength(0);
  }, 60_000);
});

describe("requestPermissionDecision 消息体化广播", () => {
  it("broadcast 收到 super.event(kind=permission-ask,requestId 在场)且旧 super.notice 帧仍在;journal 落 message.system 不落 message.user", async () => {
    const journal = new MemoryJournal();
    const sid = superSessionId();
    const frames: { type: string; kind?: string; requestId?: string; state?: string }[] = [];
    const channel = new SuperAgentChannel(depsOf(journal), soul(), {
      activity: new SuperAgentActivity(),
      broadcast: (m) => frames.push(m as never),
    });
    await channel.requestPermissionDecision(
      { requestId: "req-pd", sessionId: "ws-1", tool: "terminal", summary: "npm run build", risk: "high" },
      () => true,
    );
 // 新帧:结构化事件(permission-ask)
    const ev = frames.find((f) => f.type === "super.event");
    expect(ev, "必须广播 super.event 帧").toBeTruthy();
    expect(ev!.kind).toBe("permission-ask");
    expect(ev!.requestId).toBe("req-pd");
 // 旧帧:super.notice(state=permission)照发=兼容回退
    const notice = frames.find((f) => f.type === "super.notice" && f.state === "permission");
    expect(notice, "旧 super.notice 帧必须仍在").toBeTruthy();
 // journal:消息体化(message.system 非 message.user)
    const evs = journal.readAll().filter((e) => e.sessionId === sid);
    expect(evs.filter((e) => e.kind === "message.user")).toHaveLength(0);
    const sys = evs.filter((e) => e.kind === "message.system" && (e.payload as { event?: { kind?: string } }).event);
    expect(sys.length).toBeGreaterThanOrEqual(1);
    expect((sys[0]!.payload as { event?: { kind?: string } }).event?.kind).toBe("permission-ask");
  }, 60_000);

  it("onDelivered=false:跳过(不广播 super.event、不跑轮次)——过期申请语义保持", async () => {
    const journal = new MemoryJournal();
    const frames: { type: string; kind?: string }[] = [];
    const channel = new SuperAgentChannel(depsOf(journal), soul(), {
      activity: new SuperAgentActivity(),
      broadcast: (m) => frames.push(m as never),
    });
    await channel.requestPermissionDecision(
      { requestId: "req-stale", sessionId: "ws-1", tool: "edit_file", summary: "x" },
      () => false,
    );
    expect(frames.some((f) => f.type === "super.event")).toBe(false);
    expect(journal.readAll().some((e) => e.kind === "message.system" || e.kind === "message.user")).toBe(false);
  });
});
