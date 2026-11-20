/**
 * Bot Channel 服务门面:面板 WS 面 + 飞书/Lark webhook + 微信扫码接入。
 * 职责边界:
 * - 配置/凭证: BotStore(bots.json + secrets.json);
 * - 收消息: Telegram/微信长轮询(BotRuntime.start),飞书/Lark webhook(本文件);
 * - 发消息/任务回推: BotRuntime + 适配器;
 * - 面板: list/upsert/remove/test/weixin.begin/poll/channels。
 */
import type { BotPublic, BotChannelStatus } from "@lampgenie/protocol";
import { feishuDecrypt, parseFeishuCallback, type ParsedFeishuEnvelope } from "@lampgenie/runtime/notify/inbound";
import type { Journal } from "@lampgenie/core";
import type { ProjectRegistry } from "../projects.js";
import type { TaskSupervisor } from "../task-manager.js";
import { networkIfaces, renderQrSvg, resolvePublicHost } from "../remote-control.js";
import { createFeishuAdapter, clearFeishuTokenCache } from "./adapters/feishu.js";
import { createTelegramAdapter } from "./adapters/telegram.js";
import { beginWeixinRegistration, createWeixinAdapter, pollWeixinRegistration } from "./adapters/weixin.js";
import { BotRuntime } from "./runtime.js";
import { BotStore, type BotUpsertInput } from "./store.js";
import type { BotAdapter, BotConfig, BotInboundMessage } from "./types.js";
import { startBotWebhookServer } from "./webhook.js";

export interface BotServiceDeps {
  root: string;
  journal: Journal;
  taskManager: TaskSupervisor;
  projects: ProjectRegistry;
  log?: (line: string) => void;
 /** 测试注入(默认真实适配器)。 */
  adapters?: Partial<Record<"weixin" | "feishu" | "lark" | "telegram", BotAdapter>>;
}

export interface WeixinBeginResult {
  ok: boolean;
  qrCode?: string;
  qrSvg?: string;
  qrImageUrl?: string;
  expiresAt?: number;
  interval?: number;
  error?: string;
}

export type WeixinPollResult =
  | { status: "pending" | "scanned" | "expired"; interval?: number }
  | { status: "success"; bot: BotPublic }
  | { status: "error"; error: string };

function webhookPortOf(): number {
  const raw = Number(process.env.GENIE_BOT_WEBHOOK_PORT ?? 7802);
  return Number.isFinite(raw) && raw >= 1 && raw <= 65535 ? Math.floor(raw) : 7802;
}

export class BotService {
  readonly store: BotStore;
  private readonly runtime: BotRuntime;
  private readonly adapters: Record<"weixin" | "feishu" | "lark" | "telegram", BotAdapter>;
  private readonly log: (line: string) => void;
  private readonly webhookPort: number;
  private webhook: ReturnType<typeof startBotWebhookServer> | undefined;
  private readonly root: string;

  constructor(private readonly deps: BotServiceDeps) {
    this.root = deps.root;
    this.log = deps.log ?? ((line) => console.error(line));
    this.webhookPort = webhookPortOf();
    this.store = new BotStore(deps.root);
    this.adapters = {
      weixin: deps.adapters?.weixin ?? createWeixinAdapter(),
      telegram: deps.adapters?.telegram ?? createTelegramAdapter(),
      feishu: deps.adapters?.feishu ?? createFeishuAdapter(),
      lark: deps.adapters?.lark ?? createFeishuAdapter(),
    };
    this.runtime = new BotRuntime({
      store: this.store,
      taskManager: deps.taskManager,
      projects: deps.projects,
      journal: deps.journal,
      adapters: this.adapters,
      root: deps.root,
      log: this.log,
    });
  }

  start(): void {
    this.runtime.start();
    this.ensureWebhook();
  }

  stop(): void {
    this.runtime.stop();
    if (this.webhook) {
      void this.webhook.close();
      this.webhook = undefined;
    }
  }

  list(): BotPublic[] {
    return this.store.list().map((b) => this.publicOf(b));
  }

  channels(): BotChannelStatus[] {
    return this.store.channels();
  }

  get(id: string): BotConfig | undefined {
    return this.store.get(id);
  }

  secretsOf(bot: BotConfig) {
    return this.store.secretsOf(bot);
  }

  upsert(input: BotUpsertInput): BotPublic {
    const bot = this.store.upsert(input);
    clearFeishuTokenCache(bot.id);
    this.runtime.start();
    this.ensureWebhook();
    return this.publicOf(bot);
  }

  remove(id: string): boolean {
    const ok = this.store.remove(id);
    if (ok) {
      clearFeishuTokenCache(id);
      this.runtime.start();
      this.ensureWebhook();
    }
    return ok;
  }

  async test(id: string): Promise<{ ok: boolean; message: string; username?: string }> {
    const bot = this.store.get(id);
    if (!bot) return { ok: false, message: "机器人不存在" };
    const adapter = this.adapters[bot.provider];
    if (!adapter) return { ok: false, message: "渠道适配器未装配" };
    clearFeishuTokenCache(bot.id);
    const r = await adapter.test(bot, this.store.secretsOf(bot));
    try {
      this.store.patchRuntime(bot.id, {
        ...(r.username ? { username: r.username } : {}),
        ...(r.providerUserId ? { providerUserId: r.providerUserId } : {}),
        ...(r.ok ? { lastError: null } : { lastError: r.message.slice(0, 300) }),
      });
    } catch { /* 回填失败不影响测试结论 */ }
    return { ok: r.ok, message: r.message, ...(r.username ? { username: r.username } : {}) };
  }

  async weixinBegin(): Promise<WeixinBeginResult> {
    try {
      const begin = await beginWeixinRegistration();
      const isImage = /^data:image\//i.test(begin.qrUrl) || /^https?:\/\//i.test(begin.qrUrl);
      return {
        ok: true,
        qrCode: begin.qrCode,
        interval: begin.interval,
        expiresAt: begin.expiresAt,
        ...(isImage ? { qrImageUrl: begin.qrUrl } : { qrSvg: renderQrSvg(begin.qrUrl) }),
      };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err).slice(0, 300) };
    }
  }

  async weixinPoll(qrCode: string): Promise<WeixinPollResult> {
    try {
      const r = await pollWeixinRegistration(qrCode);
      if (r.status === "success") {
        const name = this.uniqueName("微信机器人");
        const bot = this.store.upsert({
          provider: "weixin",
          name,
          enabled: true,
          token: r.botToken,
          ...(r.botId ? { providerUserId: r.botId } : {}),
        });
        this.runtime.start();
        return { status: "success", bot: this.publicOf(bot) };
      }
      if (r.status === "error") return { status: "error", error: r.message || "微信扫码失败" };
      return { status: r.status, ...("interval" in r && r.interval ? { interval: r.interval } : {}) };
    } catch (err) {
      return { status: "error", error: String((err as Error)?.message || err).slice(0, 300) };
    }
  }

 /** 飞书/Lark 事件回调入口(webhook.ts 调用)。 */
  async handleWebhook(provider: string, botId: string, rawBody: string): Promise<{ status: number; body?: unknown }> {
    if (provider !== "feishu" && provider !== "lark") return { status: 404, body: { ok: false, error: "unsupported provider" } };
    const bot = this.store.get(botId);
    if (!bot || bot.provider !== provider) return { status: 404, body: { ok: false, error: "bot not found" } };
    if (!bot.enabled) return { status: 403, body: { ok: false, error: "bot disabled" } };
    const secrets = this.store.secretsOf(bot);
    let parsed;
    try {
      parsed = parseFeishuCallback(rawBody, {
        ...(secrets.verification ? { verificationToken: secrets.verification } : {}),
        ...(secrets.encrypt ? { encryptKey: secrets.encrypt } : {}),
      });
    } catch (err) {
      this.log(`[bots] webhook 拒收 ${provider}/${botId}: ${String((err as Error)?.message || err).slice(0, 200)}`);
      return { status: 403, body: { ok: false, error: "invalid callback" } };
    }
    if (parsed.kind === "challenge") return { status: 200, body: { challenge: parsed.challenge } };
    if (parsed.kind === "ignored") return { status: 200, body: { ok: true, ignored: parsed.reason } };
    const text = parsed.text.trim();
    if (!text) return { status: 200, body: { ok: true } };
    if (parsed.chatType === "group") {
      const isTodo = /^(TODO|TODO[:：]|跟进[:：])/.test(text);
      if (!parsed.mentionsBot && !isTodo) return { status: 200, body: { ok: true, ignored: "group-not-mentioned" } };
    }
    const message = await this.inboundOf(bot, rawBody, parsed);
    await this.runtime.handleInbound(bot.id, message);
    return { status: 200, body: { ok: true } };
  }

  private async inboundOf(
    bot: BotConfig,
    rawBody: string,
    parsed: Extract<ReturnType<typeof parseFeishuCallback>, { kind: "message" }>,
  ): Promise<BotInboundMessage> {
 // event_id 去重(飞书事件重投);加密报文先解密再读 header。
    let eventId: string | undefined;
    try {
      let body = JSON.parse(rawBody) as ParsedFeishuEnvelope & { header?: { event_id?: string } };
      const secrets = this.store.secretsOf(bot);
      if ((body as { encrypt?: string }).encrypt && secrets.encrypt) {
        body = JSON.parse(feishuDecrypt((body as { encrypt: string }).encrypt, secrets.encrypt)) as typeof body;
      }
      if (typeof body.header?.event_id === "string" && body.header.event_id) eventId = body.header.event_id;
    } catch { /* 去重失败不阻塞投递 */ }
    const text = parsed.chatType === "group"
      ? parsed.text.replace(/^(TODO|TODO[:：]|跟进[:：])\s*/, "").trim()
      : parsed.text;
    return {
      text,
      userId: parsed.senderId || "unknown",
      chatType: parsed.chatType === "p2p" ? "private" : "group",
      ...(parsed.chatId ? { chatId: parsed.chatId } : {}),
      ...(eventId ? { messageId: `feishu:${eventId}` } : {}),
    };
  }

  private publicOf(bot: BotConfig): BotPublic {
    const webhookUrl = this.webhookUrl(bot);
    return {
      id: bot.id,
      provider: bot.provider,
      name: bot.name,
      enabled: bot.enabled,
      ...(bot.projectId ? { projectId: bot.projectId } : {}),
      ...(bot.allowUserIds ? { allowUserIds: bot.allowUserIds } : {}),
      ...(bot.appId ? { appId: bot.appId } : {}),
      ...(bot.botOpenId ? { botOpenId: bot.botOpenId } : {}),
      ...(bot.apiBase ? { apiBase: bot.apiBase } : {}),
      ...(bot.lastError ? { lastError: bot.lastError } : {}),
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt,
      secrets: this.store.secretStateOf(bot),
      ...(webhookUrl ? { webhookUrl } : {}),
    };
  }

  private webhookUrl(bot: BotConfig): string | undefined {
    if (bot.provider !== "feishu" && bot.provider !== "lark") return undefined;
 // 反代/隧道场景:公开地址与 gateway 端口/协议可能完全不同,允许整段覆盖。
    const explicit = String(process.env.GENIE_BOT_WEBHOOK_PUBLIC_URL ?? "").trim();
    if (explicit) return `${explicit.replace(/\/+$/, "")}/webhook/${bot.provider}/${bot.id}`;
    const base = resolvePublicHost(process.env.GENIE_PUBLIC_HOST, networkIfaces(), this.webhookPort);
    const portPart = base.port && base.port !== (base.scheme === "https" ? 443 : 80) ? `:${base.port}` : "";
    const host = base.host.includes(":") ? `[${base.host}]` : base.host;
    return `${base.scheme}://${host}${portPart}/webhook/${bot.provider}/${bot.id}`;
  }

  private uniqueName(base: string): string {
    const names = new Set(this.store.list().map((b) => b.name));
    if (!names.has(base)) return base;
    for (let i = 2; i < 100; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
    return `${base} ${Date.now()}`;
  }

  private ensureWebhook(): void {
    const need = this.store.list().some((b) => b.enabled && (b.provider === "feishu" || b.provider === "lark"));
    if (need && !this.webhook) {
      try {
        this.webhook = startBotWebhookServer({
          port: this.webhookPort,
          handle: (provider, botId, raw) => this.handleWebhook(provider, botId, raw),
          log: this.log,
        });
        this.log(`[bots] webhook 服务已启动 :${this.webhookPort}`);
      } catch (err) {
        this.log(`[bots] webhook 启动失败:${String((err as Error)?.message || err).slice(0, 200)}`);
      }
    } else if (!need && this.webhook) {
      void this.webhook.close();
      this.webhook = undefined;
      this.log("[bots] webhook 服务已停止(无启用的飞书/Lark 机器人)");
    }
  }
}

