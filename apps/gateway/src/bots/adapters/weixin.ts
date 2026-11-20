/**
 * 微信 iLink 机器人适配器(真实平台协议。
 * 与 ZCode `packages/services/src/bots/providers/weixinProvider.ts` /
 * `weixinRegistration.ts` 同协议:
 * - 扫码接入: GET /ilink/bot/get_bot_qrcode?bot_type=3 → GET /ilink/bot/get_qrcode_status
 * - 收消息: POST /ilink/bot/getupdates(get_updates_buf 长轮询,服务端 90s 挂起)
 * - 发消息: POST /ilink/bot/sendmessage(msg.item_list[0].text_item.text)
 * 凭证 = 扫码换回的 bot_token(存 secrets.json)。`bot.apiBase` / GENIE_WEIXIN_API_BASE
 * 可覆盖官方地址(私有代理/测试 mock)。
 */
import { randomInt, randomUUID } from "node:crypto";
import type { BotAdapter, BotConfig, BotInboundMessage, BotReplyTarget, BotSecrets, BotTestResult } from "../types.js";

export const DEFAULT_WEIXIN_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const API_PREFIX = "/ilink/bot";
const CHANNEL_VERSION = "2.0.0";
const GET_UPDATES_TIMEOUT_MS = 90_000;
const SEND_LIMIT = 1800;

interface WeixinRegistrationBegin {
  qrCode: string;
  qrUrl: string;
  interval: number;
  expiresAt: number;
}

type WeixinRegistrationPoll =
  | { status: "pending" | "scanned"; interval: number }
  | { status: "success"; botToken: string; botId?: string }
  | { status: "expired" | "error"; message?: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function readString(rec: Record<string, unknown> | null | undefined, key: string): string {
  const v = rec?.[key];
  return typeof v === "string" ? v : "";
}

function readNumber(rec: Record<string, unknown> | null | undefined, key: string): number | null {
  const v = rec?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readNumberOrString(rec: Record<string, unknown> | null | undefined, key: string): string {
  const v = rec?.[key];
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

function baseOf(bot?: BotConfig): string {
  return (bot?.apiBase || process.env.GENIE_WEIXIN_API_BASE || DEFAULT_WEIXIN_ILINK_BASE_URL).replace(/\/+$/, "");
}

function buildHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": Buffer.from(String(randomInt(0, 0x1_0000_0000)), "utf8").toString("base64"),
  };
}

function appendBaseInfo(body: unknown): unknown {
  if (!isRecord(body)) return body;
  return { base_info: { channel_version: CHANNEL_VERSION }, ...body };
}

async function requestJson(
  bot: BotConfig,
  secrets: BotSecrets,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const token = String(secrets.token ?? "").trim();
  if (!token) throw new Error("微信 bot token 未配置(请先扫码接入)");
  const res = await fetch(`${baseOf(bot)}${API_PREFIX}${path}`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(appendBaseInfo(body ?? {})),
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  });
  let payload: unknown = {};
  try {
    payload = await res.json();
  } catch {
    throw new Error(`微信 iLink ${path}: HTTP ${res.status}(响应非 JSON)`);
  }
  if (!res.ok) throw new Error(`微信 iLink ${path}: HTTP ${res.status}`);
  const data = isRecord(payload) ? payload : {};
  const ret = readNumber(data, "ret");
  const errcode = readNumber(data, "errcode");
  if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
    throw new Error(`微信 iLink ${path}: ${readString(data, "errmsg") || readString(data, "message") || `ret=${ret ?? ""} errcode=${errcode ?? ""}`}`);
  }
  return data;
}

function unwrapData(payload: Record<string, unknown>): Record<string, unknown> {
  return isRecord(payload.data) ? payload.data : payload;
}

function readMessages(payload: Record<string, unknown>): Record<string, unknown>[] {
  const data = unwrapData(payload);
  const raw = data.msgs ?? data.messages ?? data.updates ?? data.items ?? data.list;
  if (Array.isArray(raw)) return raw.filter(isRecord);
  if (isRecord(raw)) return [raw];
  return [];
}

function readTextItem(item: unknown): string {
  if (!isRecord(item)) return "";
  const textItem = isRecord(item.text_item) ? item.text_item : null;
  return readString(textItem, "text") || readString(item, "text") || readString(item, "content");
}

function readWeixinText(m: Record<string, unknown>): string {
  const direct = readString(m, "text") || readString(m, "content") || readString(m, "message");
  if (direct) return direct;
  const inner = isRecord(m.msg) ? m.msg : isRecord(m.message) ? m.message : null;
  const items = Array.isArray(m.item_list) ? m.item_list : Array.isArray(inner?.item_list) ? inner.item_list : [];
  return items.map(readTextItem).filter(Boolean).join("\n") || readString(inner, "text") || readString(inner, "content");
}

function readUserId(m: Record<string, unknown>): string {
  const from = isRecord(m.from) ? m.from : null;
  const sender = isRecord(m.sender) ? m.sender : null;
  return readString(m, "from_user_id") || readString(m, "from_user") || readString(m, "user_id") ||
    readString(from, "id") || readString(from, "wxid") || readString(sender, "id") || readString(sender, "wxid");
}

function readChatId(m: Record<string, unknown>): string | undefined {
  const id = readString(m, "room") || readString(m, "room_id") || readString(m, "chat_id") || readString(m, "chatId");
  return id || undefined;
}

function readMessageId(m: Record<string, unknown>): string | undefined {
  const inner = isRecord(m.msg) ? m.msg : isRecord(m.message) ? m.message : null;
  const id = readString(m, "id") || readString(m, "msgid") || readNumberOrString(m, "message_id") ||
    readString(inner, "id") || readString(inner, "msgid") || readNumberOrString(inner, "message_id");
  return id || undefined;
}

function readContextToken(m: Record<string, unknown>): string | undefined {
  const inner = isRecord(m.msg) ? m.msg : isRecord(m.message) ? m.message : null;
  const t = readString(m, "context_token") || readString(m, "contextToken") || readString(inner, "context_token");
  return t || undefined;
}

function readNextBuf(payload: Record<string, unknown>): string | undefined {
  const data = unwrapData(payload);
  const b = readString(data, "get_updates_buf") || readString(data, "buf") || readString(data, "next_buf");
  return b || undefined;
}

function toInbound(m: Record<string, unknown>): BotInboundMessage | null {
  if (readNumber(m, "message_type") === 2) return null; // 机器人自己发的
  const text = readWeixinText(m).trim();
  const userId = readUserId(m).trim();
  if (!text || !userId) return null;
  const chatId = readChatId(m);
  const contextToken = readContextToken(m);
  const messageId = readMessageId(m);
  return {
    text,
    userId,
    ...(chatId ? { chatId } : {}),
    chatType: chatId ? "group" : "private",
    ...(messageId ? { messageId } : {}),
    ...(contextToken ? { contextToken } : {}),
  };
}

function splitText(text: string): string[] {
  const t = String(text ?? "").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const out: string[] = [];
  let rest = t;
  while (rest.length > SEND_LIMIT) {
    let cut = rest.lastIndexOf("\r\n", SEND_LIMIT);
    if (cut < SEND_LIMIT * 0.6) cut = SEND_LIMIT;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^(\r\n)+/, "");
  }
  if (rest) out.push(rest);
  return out.length > 0 ? out : [""];
}

// ---- 扫码接入(无需已有 bot token) ----

async function registrationGet<T extends Record<string, unknown>>(path: string, timeoutMs = 30_000): Promise<T> {
  const base = (process.env.GENIE_WEIXIN_API_BASE || DEFAULT_WEIXIN_ILINK_BASE_URL).replace(/\/+$/, "");
  const res = await fetch(`${base}${API_PREFIX}${path}`, {
    method: "GET",
    headers: { "iLink-App-ClientVersion": "1" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`微信登录 ${path}: HTTP ${res.status}`);
  const payload = (await res.json()) as Record<string, unknown>;
  const data = unwrapData(payload);
  const ret = readNumber(data, "ret");
  const errcode = readNumber(data, "errcode");
  if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
    throw new Error(readString(data, "errmsg") || `微信登录失败(ret=${ret ?? ""} errcode=${errcode ?? ""})`);
  }
  return data as T;
}

function normalizeQrStatus(v: unknown): "pending" | "scanned" | "success" | "expired" | "error" {
  if (typeof v === "number") {
    if (v === 1) return "scanned";
    if (v === 2) return "success";
    if (v === 3 || v === 4) return "expired";
    return "pending";
  }
  const s = String(v ?? "").toLowerCase();
  if (["confirmed", "success", "ok", "authorized"].includes(s)) return "success";
  if (["scaned", "scanned", "scan", "confirmed_wait"].includes(s)) return "scanned";
  if (["expired", "timeout", "cancel", "cancelled", "canceled"].includes(s)) return "expired";
  if (["error", "failed", "fail"].includes(s)) return "error";
  return "pending";
}

/** 发起微信扫码接入:返回二维码内容/展示 URL 与有效期。 */
export async function beginWeixinRegistration(): Promise<WeixinRegistrationBegin> {
  const data = await registrationGet<Record<string, unknown>>("/get_bot_qrcode?bot_type=3");
  const qrCode = readString(data, "qrcode") || readString(data, "qr_code");
  const qrUrl = readString(data, "qrcode_img_content") || readString(data, "qrcode_url") || qrCode;
  if (!qrCode || !qrUrl) throw new Error("微信登录未返回二维码");
  const expiresIn = readNumber(data, "expires_in") ?? 120;
  return { qrCode, qrUrl, interval: 3, expiresAt: Date.now() + expiresIn * 1000 };
}

/** 轮询扫码状态;success 时返回 bot_token。 */
export async function pollWeixinRegistration(qrCode: string): Promise<WeixinRegistrationPoll> {
  let data: Record<string, unknown>;
  try {
    data = await registrationGet<Record<string, unknown>>(`/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`);
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") return { status: "pending", interval: 3 };
    throw err;
  }
  const status = normalizeQrStatus(data.status ?? data.qrcode_status ?? data.qr_status);
  if (status === "success") {
    const botToken = readString(data, "bot_token") || readString(data, "token");
    if (!botToken) return { status: "error", message: "微信登录成功但未返回 bot_token" };
    const botId = readString(data, "ilink_bot_id") || readString(data, "bot_id") || undefined;
    return { status: "success", botToken, ...(botId ? { botId } : {}) };
  }
  if (status === "expired") return { status: "expired" };
  if (status === "error") return { status: "error", message: readString(data, "errmsg") || "微信登录失败" };
  return { status, interval: 3 };
}

// ---- 适配器 ----

export function createWeixinAdapter(): BotAdapter {
  return {
    async test(bot, secrets): Promise<BotTestResult> {
      try {
        const data = await requestJson(bot, secrets, "/getconfig");
        const contact = isRecord(data.contact) ? data.contact : isRecord(data.self) ? data.self : null;
        const selfId = readString(contact, "id") || readString(contact, "wxid");
        return {
          ok: true,
          message: "微信 iLink API 可达",
          ...(selfId ? { providerUserId: selfId } : {}),
        };
      } catch (err) {
        return { ok: false, message: String((err as Error)?.message || err).slice(0, 300) };
      }
    },

    start(bot, secrets, onMessage, signal): void {
      let buf = "";
      void (async () => {
        while (!signal.aborted) {
          try {
            const combined = AbortSignal.any([signal, AbortSignal.timeout(GET_UPDATES_TIMEOUT_MS + 15_000)]);
            const payload = await requestJson(bot, secrets, "/getupdates", { get_updates_buf: buf }, combined, GET_UPDATES_TIMEOUT_MS + 10_000);
            const nextBuf = readNextBuf(payload);
            if (nextBuf) buf = nextBuf;
            for (const raw of readMessages(payload)) {
              const msg = toInbound(raw);
              if (!msg) continue;
              try {
                onMessage(msg);
              } catch (err) {
                console.error("[bots/weixin] 入站处理失败:", String((err as Error)?.message || err).slice(0, 200));
              }
            }
          } catch (err) {
            if (signal.aborted) break;
            if (err instanceof DOMException && err.name === "TimeoutError") continue; // 长轮询正常超时
            console.error("[bots/weixin] 轮询失败,3s 后重试:", String((err as Error)?.message || err).slice(0, 200));
            await sleep(3000, signal);
          }
        }
      })();
    },

    async send(bot, secrets, target: BotReplyTarget, text: string): Promise<void> {
      for (const chunk of splitText(text)) {
        await requestJson(bot, secrets, "/sendmessage", {
          msg: {
            from_user_id: bot.providerUserId ?? "",
            to_user_id: target.userId,
            client_id: `genie-weixin-${randomUUID()}`,
            message_type: 2,
            message_state: 2,
            ...(target.contextToken ? { context_token: target.contextToken } : {}),
            item_list: [{ type: 1, text_item: { text: chunk } }],
          },
        });
      }
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}