/**
 * Bot 任务路由/终态回推:
 * 入站→提交→done 回推;命令 /status /stop /new;白名单;忙时提示;
 * 飞书 webhook challenge/token 校验与群消息过滤。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journal } from "@lampgenie/core";
import { BotStore } from "../src/bots/store.js";
import { BotRuntime } from "../src/bots/runtime.js";
import { BotService } from "../src/bots/service.js";
import type { BotAdapter, BotInboundMessage } from "../src/bots/types.js";
import { ProjectRegistry } from "../src/projects.js";
import { TaskSupervisor } from "../src/task-manager.js";

function fakeAdapters(sent: string[]): Record<"weixin" | "feishu" | "lark" | "telegram", BotAdapter> {
  const adapter: BotAdapter = {
    test: async () => ({ ok: true, message: "mock ok" }),
    start: () => { /* 测试直接调 handleInbound */ },
    send: async (_bot, _secrets, _target, text) => { sent.push(text); },
  };
  return { weixin: adapter, feishu: adapter, lark: adapter, telegram: adapter };
}

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("BotRuntime", () => {
  let root = "";
  let store: BotStore;
  let tm: TaskSupervisor;
  let projects: ProjectRegistry;
  let sent: string[];
  let runtime: BotRuntime;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bots-runtime-"));
    store = new BotStore(root);
    tm = new TaskSupervisor({ maxConcurrent: 4, maxConcurrentPerOwner: 4 });
    projects = new ProjectRegistry(root, null);
    sent = [];
    runtime = new BotRuntime({
      store,
      taskManager: tm,
      projects,
      journal: {} as Journal,
      adapters: fakeAdapters(sent),
      root,
      log: () => { /* 静默 */ },
    });
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });

  it("入站→提交任务→ack;终态回推【完成】+结果", async () => {
    const bot = store.upsert({ provider: "telegram", name: "TG", token: "t" });
    await runtime.handleInbound(bot.id, { text: "帮我读一下 README", userId: "u1", chatType: "private" });
    const tasks = tm.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.instruction).toBe("帮我读一下 README");
    expect(tasks[0]!.sessionId).toMatch(/^bot-/);
    expect(sent.some((s) => s.includes("已收到") && s.includes("执行"))).toBe(true);

    tm.setState(tasks[0]!, "done", "README 内容是 demo");
    await wait();
    expect(sent.some((s) => s.includes("【完成】") && s.includes("README 内容是 demo"))).toBe(true);
  });

  it("命令 /status /stop /new;忙时提示;白名单拒收", async () => {
    const bot = store.upsert({ provider: "telegram", name: "TG", token: "t", allowUserIds: ["u1"] });
    await runtime.handleInbound(bot.id, { text: "任务一", userId: "u1", chatType: "private" });
    const first = tm.list()[0]!;

    await runtime.handleInbound(bot.id, { text: "任务二", userId: "u1", chatType: "private" });
    expect(tm.list()).toHaveLength(1); // 忙时不再提交
    expect(sent.some((s) => s.includes("上一条任务还在执行"))).toBe(true);

    await runtime.handleInbound(bot.id, { text: "/status", userId: "u1", chatType: "private" });
    expect(sent.some((s) => s.includes(first.id.slice(0, 8)) && s.includes("running"))).toBe(true);

    await runtime.handleInbound(bot.id, { text: "/stop", userId: "u1", chatType: "private" });
    expect(tm.get(first.id)?.state).toBe("cancelled");
    await wait();
    expect(sent.some((s) => s.includes("【已停止】"))).toBe(true);

    await runtime.handleInbound(bot.id, { text: "/new", userId: "u1", chatType: "private" });
    expect(sent.some((s) => s.includes("已开启新会话"))).toBe(true);

    const before = sent.length;
    await runtime.handleInbound(bot.id, { text: "陌生人任务", userId: "evil", chatType: "private" });
    expect(sent.length).toBe(before); // 白名单外静默忽略
    expect(tm.list()).toHaveLength(1);
  });

  it("飞书 webhook:challenge 回显 / token 不匹配 403 / 私聊入站提交 / 群未@忽略", async () => {
    const service = new BotService({
      root,
      journal: {} as Journal,
      taskManager: tm,
      projects,
      adapters: fakeAdapters(sent),
      log: () => { /* 静默 */ },
    });
    const bot = service.store.upsert({
      provider: "feishu",
      name: "飞书",
      enabled: true,
      appId: "cli_1",
      appSecret: "sec",
      verificationToken: "verify-1",
    });

    const challenge = await service.handleWebhook("feishu", bot.id, JSON.stringify({ challenge: "abc", token: "verify-1" }));
    expect(challenge).toEqual({ status: 200, body: { challenge: "abc" } });

    const denied = await service.handleWebhook("feishu", bot.id, JSON.stringify({ challenge: "abc", token: "wrong" }));
    expect(denied.status).toBe(403);

    const messagePayload = (text: string, chatType: string, eventId: string, mentions?: unknown[]) => JSON.stringify({
      header: { token: "verify-1", event_type: "im.message.receive_v1", event_id: eventId },
      event: {
        message: { chat_type: chatType, chat_id: "c1", content: JSON.stringify({ text }), ...(mentions ? { mentions } : {}) },
        sender: { sender_id: { open_id: "u1" } },
      },
    });
    const ok = await service.handleWebhook("feishu", bot.id, messagePayload("飞书任务", "p2p", "e1"));
    expect(ok.status).toBe(200);
    expect(tm.list()).toHaveLength(1);
    expect(sent.some((s) => s.includes("已收到"))).toBe(true);

    const ignored = await service.handleWebhook("feishu", bot.id, messagePayload("群里闲聊", "group", "e2"));
    expect(ignored.status).toBe(200);
    expect(JSON.stringify(ignored.body)).toContain("group-not-mentioned");
    expect(tm.list()).toHaveLength(1);

    const mentioned = await service.handleWebhook("feishu", bot.id, messagePayload("@_user_1 群里任务", "group", "e3", [{ id: { open_id: "bot" } }]));
    expect(mentioned.status).toBe(200);
    expect(tm.list()).toHaveLength(2);
  });
});