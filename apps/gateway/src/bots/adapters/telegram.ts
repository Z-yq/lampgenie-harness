/**
 * Telegram Bot API 适配器(长轮询,无 webhook 依赖)。
 * 协议:https://core.telegram.org/bots/api
 * - test: getMe
 * - 收: getUpdates(offset/timeout=25s),只收 message 更新
 * - 发: sendMessage(4096 上限,按 3900 字符分片)
 * `bot.apiBase` / GENIE_TELEGRAM_API_BASE 可覆盖官方地址(私有代理/测试 mock)。
 */
import type { BotAdapter, BotConfig, BotInboundMessage, BotReplyTarget, BotSecrets, BotTestResult } from "../types.js";

const DEFAULT_BASE = "https://api.telegram.org";
const POLL_TIMEOUT_SEC = 25;
const SEND_LIMIT = 3900;

interface TgResponse<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

function apiBase(bot: BotConfig): string {
  return (bot.apiBase || process.env.GENIE_TELEGRAM_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");
}

function tokenOf(secrets: BotSecrets): string {
  const t = String(secrets.token ?? "").trim();
  if (!t) throw new Error("Telegram Bot Token 未配置");
  return t;
}

async function call<T>(bot: BotConfig, secrets: BotSecrets, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${apiBase(bot)}/bot${tokenOf(secrets)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  let payload: TgResponse<T> = {};
  try {
    payload = (await res.json()) as TgResponse<T>;
  } catch {
    throw new Error(`Telegram ${method}: HTTP ${res.status}(响应非 JSON)`);
  }
  if (!res.ok || payload.ok === false) {
    throw new Error(`Telegram ${method}: ${payload.description || `HTTP ${res.status}`}`);
  }
  return payload.result as T;
}

function chatTypeOf(v: unknown): "private" | "group" {
  return v === "group" || v === "supergroup" ? "group" : "private";
}

interface TgUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number | string; type?: string; title?: string; username?: string; first_name?: string };
    from?: { id?: number | string; username?: string; first_name?: string };
  };
}

function splitText(text: string): string[] {
  const t = String(text ?? "").replace(/\r\n/g, "\n");
  const out: string[] = [];
  let rest = t;
  while (rest.length > SEND_LIMIT) {
    let cut = rest.lastIndexOf("\n", SEND_LIMIT);
    if (cut < SEND_LIMIT * 0.6) cut = SEND_LIMIT;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out.length > 0 ? out : [""];
}

export function createTelegramAdapter(): BotAdapter {
  return {
    async test(bot, secrets): Promise<BotTestResult> {
      try {
        const me = await call<{ username?: string; id?: number | string; first_name?: string }>(bot, secrets, "getMe");
        const username = me?.username ? `@${me.username}` : (me?.first_name || "");
        return { ok: true, message: "Telegram Bot API 可达", ...(username ? { username } : {}), ...(me?.id !== undefined ? { providerUserId: String(me.id) } : {}) };
      } catch (err) {
        return { ok: false, message: String((err as Error)?.message || err).slice(0, 300) };
      }
    },

    start(bot, secrets, onMessage, signal): void {
      let offset = 0;
      void (async () => {
        while (!signal.aborted) {
          try {
            const timeoutSignal = AbortSignal.any([signal, AbortSignal.timeout((POLL_TIMEOUT_SEC + 10) * 1000)]);
            const updates = await call<TgUpdate[]>(bot, secrets, "getUpdates", {
              offset,
              timeout: POLL_TIMEOUT_SEC,
              allowed_updates: ["message"],
            }, timeoutSignal);
            for (const u of Array.isArray(updates) ? updates : []) {
              if (typeof u.update_id === "number") offset = Math.max(offset, u.update_id + 1);
              const m = u.message;
              if (!m || typeof m.text !== "string" || !m.text.trim()) continue;
              const chatId = m.chat?.id !== undefined ? String(m.chat.id) : undefined;
              const userId = m.from?.id !== undefined ? String(m.from.id) : chatId;
              if (!userId) continue;
              const type = chatTypeOf(m.chat?.type);
              const msg: BotInboundMessage = {
                text: m.text,
                userId,
                ...(m.from?.username ? { userName: `@${m.from.username}` } : m.from?.first_name ? { userName: m.from.first_name } : {}),
                ...(chatId ? { chatId } : {}),
                chatType: type,
                ...(m.message_id !== undefined ? { messageId: String(m.message_id) } : {}),
              };
              try {
                onMessage(msg);
              } catch (err) {
                console.error("[bots/telegram] 入站处理失败:", String((err as Error)?.message || err).slice(0, 200));
              }
            }
          } catch (err) {
            if (signal.aborted) break;
            console.error("[bots/telegram] 轮询失败,3s 后重试:", String((err as Error)?.message || err).slice(0, 200));
            await sleep(3000, signal);
          }
        }
      })();
    },

    async send(bot, secrets, target: BotReplyTarget, text: string): Promise<void> {
      const chatId = target.chatId || target.userId;
      for (const chunk of splitText(text)) {
        await call(bot, secrets, "sendMessage", {
          chat_id: chatId,
          text: chunk,
          disable_web_page_preview: true,
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