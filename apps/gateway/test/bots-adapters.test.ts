/**
 * Bot 四渠道适配器协议级测试(本地 mock HTTP):
 * Telegram getMe/getUpdates/sendMessage;微信 getconfig/getupdates/sendmessage;
 * 飞书/Lark tenant_access_token + im/v1/messages。
 * 真实平台地址不变,只把 `bot.apiBase` 指向 mock(生产代码零分支)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BotConfig } from "../src/bots/types.js";
import { createTelegramAdapter } from "../src/bots/adapters/telegram.js";
import { beginWeixinRegistration, createWeixinAdapter, pollWeixinRegistration } from "../src/bots/adapters/weixin.js";
import { createFeishuAdapter, clearFeishuTokenCache } from "../src/bots/adapters/feishu.js";

interface Captured {
  path: string;
  body: Record<string, unknown>;
  auth?: string;
}

const captured: Captured[] = [];
let server: Server;
let base = "";
let tgUpdatesCalls = 0;

function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function send(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function botOf(provider: "telegram" | "weixin" | "feishu", extra: Partial<BotConfig> = {}): BotConfig {
  return { id: "b" + provider, provider, name: provider, enabled: true, createdAt: 1, updatedAt: 1, apiBase: base, ...extra };
}

describe("Bot 适配器(mock 平台)", () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      void (async () => {
        const path = (req.url ?? "").split("?")[0] ?? "";
        const body = await readBody(req);
        captured.push({ path, body, ...(req.headers.authorization ? { auth: String(req.headers.authorization) } : {}) });

        if (/\/getMe$/.test(path)) {
          send(res, 200, { ok: true, result: { id: 99, username: "testbot", first_name: "Test" } });
          return;
        }
        if (/\/getUpdates$/.test(path)) {
          tgUpdatesCalls++;
          if (tgUpdatesCalls === 1) {
            send(res, 200, { ok: true, result: [{ update_id: 7, message: { message_id: 11, text: "hi", chat: { id: 42, type: "private" }, from: { id: 43, username: "alice" } } }] });
          } else {
            send(res, 200, { ok: true, result: [] });
          }
          return;
        }
        if (/\/sendMessage$/.test(path)) {
          send(res, 200, { ok: true, result: { message_id: 1 } });
          return;
        }
        if (path === "/ilink/bot/get_bot_qrcode") {
          send(res, 200, { ret: 0, qrcode: "qc1", qrcode_img_content: "https://example.com/qr.png", expires_in: 120 });
          return;
        }
        if (path === "/ilink/bot/get_qrcode_status") {
          send(res, 200, { ret: 0, status: 2, bot_token: "wx-token", ilink_bot_id: "wx-bot-1" });
          return;
        }
        if (path === "/ilink/bot/getconfig") {
          send(res, 200, { ret: 0, contact: { id: "wx-bot-1" } });
          return;
        }
        if (path === "/ilink/bot/getupdates") {
          send(res, 200, { ret: 0, data: { msgs: [{ message_type: 1, from_user_id: "wx-u1", text: "微信 hello", id: "m1", context_token: "ctx" }], get_updates_buf: "buf2" } });
          return;
        }
        if (path === "/ilink/bot/sendmessage") {
          send(res, 200, { ret: 0 });
          return;
        }
        if (path === "/open-apis/auth/v3/tenant_access_token/internal") {
          send(res, 200, { code: 0, tenant_access_token: "tenant-token", expire: 7200 });
          return;
        }
        if (path === "/open-apis/bot/v3/info") {
          send(res, 200, { code: 0, data: { bot: { app_name: "FeishuTestBot" } } });
          return;
        }
        if (path === "/open-apis/im/v1/messages") {
          send(res, 200, { code: 0, data: { message_id: "om_1" } });
          return;
        }
        send(res, 404, { ok: false, path });
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    clearFeishuTokenCache();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("Telegram:getMe → 收发;长轮询入站归一", async () => {
    const adapter = createTelegramAdapter();
    const bot = botOf("telegram");
    const secrets = { token: "123:ABC" };
    const t = await adapter.test(bot, secrets);
    expect(t.ok).toBe(true);
    expect(t.username).toBe("@testbot");

    await adapter.send(bot, secrets, { userId: "42", chatId: "42", chatType: "private" }, "hello");
    const sentMsg = captured.filter((c) => c.path.endsWith("/sendMessage")).at(-1);
    expect(sentMsg?.body).toMatchObject({ chat_id: "42", text: "hello" });

    const ac = new AbortController();
    const got = new Promise<{ text: string; userId: string }>((resolve) => {
      adapter.start!(bot, secrets, (m) => resolve({ text: m.text, userId: m.userId }), ac.signal);
    });
    const msg = await Promise.race([
      got,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("telegram inbound timeout")), 3000)),
    ]);
    ac.abort();
    expect(msg).toEqual({ text: "hi", userId: "43" });
    expect(captured.some((c) => c.path.endsWith("/getUpdates"))).toBe(true);
  }, 15_000);

  it("微信 iLink:getconfig 回填自身 id;getupdates/sendmessage 协议形状", async () => {
    const adapter = createWeixinAdapter();
    const bot = botOf("weixin", { providerUserId: "wx-bot-1" });
    const secrets = { token: "wx-token" };
    const t = await adapter.test(bot, secrets);
    expect(t.ok).toBe(true);
    expect(t.providerUserId).toBe("wx-bot-1");

    await adapter.send(bot, secrets, { userId: "wx-u1", chatType: "private", contextToken: "ctx" }, "回复文本");
    const sent = captured.filter((c) => c.path === "/ilink/bot/sendmessage").at(-1);
    const msg = (sent?.body as { msg?: Record<string, unknown> }).msg ?? {};
    expect(msg).toMatchObject({ from_user_id: "wx-bot-1", to_user_id: "wx-u1", message_type: 2, message_state: 2 });
    expect(msg.context_token).toBe("ctx");
    expect((msg.item_list as { text_item?: { text?: string } }[])[0]?.text_item?.text).toBe("回复文本");

    const ac = new AbortController();
    const got = new Promise<{ text: string; userId: string; contextToken?: string }>((resolve) => {
      adapter.start!(bot, secrets, (m) => resolve({ text: m.text, userId: m.userId, ...(m.contextToken ? { contextToken: m.contextToken } : {}) }), ac.signal);
    });
    const inbound = await Promise.race([
      got,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("weixin inbound timeout")), 3000)),
    ]);
    ac.abort();
    expect(inbound).toEqual({ text: "微信 hello", userId: "wx-u1", contextToken: "ctx" });
  }, 15_000);

  it("微信扫码注册:get_bot_qrcode → get_qrcode_status success(真实 iLink 协议)", async () => {
    const old = process.env.GENIE_WEIXIN_API_BASE;
    process.env.GENIE_WEIXIN_API_BASE = base;
    try {
      const begin = await beginWeixinRegistration();
      expect(begin.qrCode).toBe("qc1");
      expect(begin.qrUrl).toBe("https://example.com/qr.png");
      expect(begin.expiresAt).toBeGreaterThan(Date.now());
      const poll = await pollWeixinRegistration("qc1");
      expect(poll).toEqual({ status: "success", botToken: "wx-token", botId: "wx-bot-1" });
    } finally {
      if (old === undefined) delete process.env.GENIE_WEIXIN_API_BASE;
      else process.env.GENIE_WEIXIN_API_BASE = old;
    }
  });

  it("飞书 / Lark:tenant token + im/v1/messages;Lark 用不同 base(同协议)", async () => {
    const adapter = createFeishuAdapter();
    const feishu = botOf("feishu", { appId: "cli_1" });
    const lark = botOf("lark", { appId: "cli_2" });
    const t = await adapter.test(feishu, { appSecret: "sec", verification: "v" });
    expect(t.ok).toBe(true);
    expect(t.username).toBe("FeishuTestBot");

    await adapter.send(feishu, { appSecret: "sec", verification: "v" }, { userId: "u1", chatId: "c1", chatType: "group" }, "飞书消息");
    const sent = captured.filter((c) => c.path === "/open-apis/im/v1/messages").at(-1);
    expect(sent?.body).toMatchObject({ receive_id: "c1", msg_type: "text" });
    expect(JSON.parse(String(sent?.body.content))).toEqual({ text: "飞书消息" });
    expect(sent?.auth).toBe("Bearer tenant-token");

 // Lark 同协议(apiBase 仍指向 mock;真实默认 base 由 provider=lark 决定)
    clearFeishuTokenCache(lark.id);
    const l = await adapter.test(lark, { appSecret: "sec2", verification: "v2" });
    expect(l.ok).toBe(true);
  }, 15_000);
});