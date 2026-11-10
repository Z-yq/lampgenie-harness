// @ts-nocheck — 设计参考 teamai-cli(MIT,致谢),本仓独立实现。
/**
 * 出站 webhook(契约移植自 teamai-cli src/webhook.ts,MIT)。
 * 裁契约:配置/日志/类型绑 teamai 的部分替换为 genie 窄接口;
 * 核心算法原样保留——HMAC-SHA256 签名、指数退避重试、4xx(非429)不重试、
 * AbortController 超时、逐 endpoint 隔离、出站前再过一道 redact。
 */
import { createHmac } from "node:crypto";
import { scrubWithEnv } from "../security/redact";

export interface WebhookEndpoint {
  type: "feishu" | "wecom" | "json";
  url: string;
  /** HMAC 签名密钥(可选)。 */
  secret?: string;
}

export interface WebhookPayload {
  event: string;
  [key: string]: unknown;
}

export interface NotifyLogger {
  warn(msg: string): void;
}

export interface SendOptions {
  timeoutMs?: number;
  maxRetries?: number;
  logger?: NotifyLogger;
  /** 用于脱敏的环境变量表(值将被掩码)。 */
  env?: NodeJS.ProcessEnv;
}

/** 发送单个 endpoint;永不 throw(fails-soft)。返回是否最终成功。 */
export async function sendToEndpoint(
  endpoint: WebhookEndpoint,
  payload: WebhookPayload,
  format: (p: WebhookPayload) => Record<string, unknown>,
  opts: SendOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxRetries = opts.maxRetries ?? 3;
  const log = opts.logger ?? console;
  const body = scrubWithEnv(JSON.stringify(format(payload)), opts.env ?? process.env);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (endpoint.secret) {
        headers["X-Genie-Signature"] =
          "sha256=" + createHmac("sha256", endpoint.secret).update(body).digest("hex");
      }
      const res = await fetch(endpoint.url, {
        method: "POST", headers, body, signal: controller.signal,
      });
      if (res.ok) return true;
      // 4xx(除 429)= 客户端错误,重试无意义
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        log.warn(`webhook ${endpoint.type} ${res.status},不重试`);
        return false;
      }
    } catch (err) {
      log.warn(`webhook ${endpoint.type} 第 ${attempt + 1} 次失败: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    // 指数退避:1s/2s/4s…
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  return false;
}

/** 多 endpoint 广播;全部隔离,互不影响。 */
export async function sendWebhook(
  endpoints: WebhookEndpoint[],
  payload: WebhookPayload,
  format: (p: WebhookPayload) => Record<string, unknown>,
  opts: SendOptions = {},
): Promise<void> {
  await Promise.allSettled(endpoints.map((e) => sendToEndpoint(e, payload, format, opts)));
}
