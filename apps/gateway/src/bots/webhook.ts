/**
 * Bot 事件回调小服务。
 * 飞书/Lark 的事件订阅需要公网可达的 HTTP 回调;gateway 主端口面向面板,这里按
 * `GENIE_BOT_WEBHOOK_PORT`(默认 7802)单独起一个小服务,路由:
 * POST /webhook/<provider>/<botId>
 * 与既有 `im-inbound.ts` 的 env 单机器人形态并存(那是历史通道);新 Bot 配置走这里。
 * 安全:请求体 1MB 上限;token/加密校验在 service.handleWebhook 内按 bot 配置执行。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const MAX_BODY_BYTES = 1 << 20;
const ROUTE_RE = /^\/webhook\/(weixin|feishu|lark|telegram)\/([A-Za-z0-9_-]{1,80})$/;

export interface BotWebhookResponse {
  status: number;
  body?: unknown;
}

export interface BotWebhookDeps {
  port: number;
  handle(provider: string, botId: string, rawBody: string): Promise<BotWebhookResponse>;
  log?: (line: string) => void;
}

function readBody(req: IncomingMessage): Promise<{ ok: true; body: string } | { ok: false; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        resolve({ ok: false, tooLarge: true });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true, body: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", () => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, tooLarge: false });
    });
  });
}

function reply(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

export function startBotWebhookServer(deps: BotWebhookDeps): { server: Server; close(): Promise<void> } {
  const log = deps.log ?? ((line) => console.error(line));
  const server = createServer((req, res) => {
    const m = ROUTE_RE.exec((req.url ?? "").split("?")[0] ?? "");
    if (!m) {
      reply(res, 404, { ok: false, error: "not found" });
      return;
    }
    if (req.method !== "POST") {
      reply(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    const provider = m[1]!;
    const botId = m[2]!;
    void (async () => {
      const raw = await readBody(req);
      if (!raw.ok) {
        reply(res, raw.tooLarge ? 413 : 400, { ok: false, error: raw.tooLarge ? "payload too large" : "bad request" });
        return;
      }
      try {
        const r = await deps.handle(provider, botId, raw.body);
        reply(res, r.status, r.body);
      } catch (err) {
        log(`[bots/webhook] 处理失败 ${provider}/${botId}: ${String((err as Error)?.message || err).slice(0, 300)}`);
        reply(res, 500, { ok: false });
      }
    })();
  });
  server.on("error", (err) => log(`[bots/webhook] 服务错误:${String((err as Error)?.message || err).slice(0, 300)}`));
  server.listen(deps.port);
  return {
    server,
    close: () => new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    }),
  };
}