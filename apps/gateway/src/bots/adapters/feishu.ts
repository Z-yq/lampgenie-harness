/**
 * 飞书 / Lark 机器人适配器(真实平台协议。
 * 入站走事件订阅 webhook(由 bots/webhook.ts + runtime 解析,复用
 * `@lampgenie/runtime/notify/inbound` 的 parseFeishuCallback);本文件只负责:
 * - test: tenant_access_token + bot info
 * - send: POST /open-apis/im/v1/messages(text 消息,按 chat_id/open_id 投递)
 * 飞书国际版 Lark 仅 base URL 不同(open.larksuite.com),事件格式一致。
 * `bot.apiBase` / GENIE_FEISHU_API_BASE 可覆盖官方地址(测试 mock)。
 */
import type { BotAdapter, BotConfig, BotReplyTarget, BotSecrets, BotTestResult } from "../types.js";

const FEISHU_BASE = "https://open.feishu.cn";
const LARK_BASE = "https://open.larksuite.com";
const SEND_LIMIT = 6000;

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();

function baseOf(bot: BotConfig): string {
  const override = bot.apiBase || process.env.GENIE_FEISHU_API_BASE;
  if (override) return override.replace(/\/+$/, "");
  return (bot.provider === "lark" ? LARK_BASE : FEISHU_BASE).replace(/\/+$/, "");
}

function requireAppCreds(bot: BotConfig, secrets: BotSecrets): { appId: string; appSecret: string } {
  const appId = String(bot.appId ?? "").trim();
  const appSecret = String(secrets.appSecret ?? "").trim();
  if (!appId) throw new Error("飞书/Lark App ID 未配置");
  if (!appSecret) throw new Error("飞书/Lark App Secret 未配置");
  return { appId, appSecret };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const v = await res.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function tenantToken(bot: BotConfig, secrets: BotSecrets, signal?: AbortSignal): Promise<string> {
  const key = `${bot.id}|${baseOf(bot)}|${bot.appId ?? ""}`;
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.token;
  const { appId, appSecret } = requireAppCreds(bot, secrets);
  const res = await fetch(`${baseOf(bot)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  const payload = await readJson(res);
  const token = typeof payload.tenant_access_token === "string" ? payload.tenant_access_token : "";
  if (!res.ok || !token) {
    throw new Error(`飞书/Lark tenant_access_token 失败: ${String(payload.msg ?? `HTTP ${res.status}`)}`);
  }
  const expire = typeof payload.expire === "number" && payload.expire > 60 ? payload.expire - 60 : 1800;
  tokenCache.set(key, { token, expiresAt: Date.now() + expire * 1000 });
  return token;
}

function splitText(text: string): string[] {
  const t = String(text ?? "");
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

export function createFeishuAdapter(): BotAdapter {
  return {
    async test(bot, secrets): Promise<BotTestResult> {
      try {
        const token = await tenantToken(bot, secrets);
        let username: string | undefined;
        try {
          const res = await fetch(`${baseOf(bot)}/open-apis/bot/v3/info`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          });
          const payload = await readJson(res);
          const data = payload.data && typeof payload.data === "object" ? (payload.data as Record<string, unknown>) : payload;
          const botInfo = data.bot && typeof data.bot === "object" ? (data.bot as Record<string, unknown>) : data;
          const name = botInfo.app_name ?? botInfo.name;
          if (typeof name === "string" && name.trim()) username = name.trim();
        } catch {
 // bot info 失败不影响「凭证可用」结论
        }
        return { ok: true, message: "飞书/Lark 凭证可用", ...(username ? { username } : {}) };
      } catch (err) {
        return { ok: false, message: String((err as Error)?.message || err).slice(0, 300) };
      }
    },

    async send(bot, secrets, target: BotReplyTarget, text: string): Promise<void> {
      const token = await tenantToken(bot, secrets);
      const receiveId = target.chatId || target.userId;
      if (!receiveId) throw new Error("飞书/Lark 缺少接收方 chat_id/open_id");
      const receiveIdType = target.chatId ? "chat_id" : "open_id";
      for (const chunk of splitText(text)) {
        const res = await fetch(`${baseOf(bot)}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            receive_id: receiveId,
            msg_type: "text",
            content: JSON.stringify({ text: chunk }),
          }),
          signal: AbortSignal.timeout(20_000),
        });
        const payload = await readJson(res);
        const code = typeof payload.code === "number" ? payload.code : 0;
        if (!res.ok || code !== 0) {
          throw new Error(`飞书/Lark 发消息失败: ${String(payload.msg ?? `HTTP ${res.status}`)}`);
        }
      }
    },
  };
}

/** 测试/配置变更后清 token 缓存(避免旧 appSecret 的 token 继续用)。 */
export function clearFeishuTokenCache(botId?: string): void {
  if (!botId) {
    tokenCache.clear();
    return;
  }
  for (const k of [...tokenCache.keys()]) if (k.startsWith(`${botId}|`)) tokenCache.delete(k);
}