/**
 * Bot 配置与凭证存储。
 * 落盘:
 * - `.genie/bots.json`(0600,原子写):机器人配置(provider/名称/项目/白名单等);
 * - `.genie/secrets.json`(0600,复用 core 的 setSecretValue):平台凭证,键名
 * `GENIE_BOT_<ID>_TOKEN|APPSECRET|VERIFICATION|ENCRYPT`。
 * 红线:任何回包/日志都不含凭证值;publicOf 只给布尔在场状态。
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setSecretValue } from "@lampgenie/core";
import { BotProviderZ, type BotChannelStatus, type BotProviderId } from "@lampgenie/protocol";
import { BOT_PROVIDER_META, type BotConfig, type BotSecretKind, type BotSecretState, type BotSecrets } from "./types.js";

export interface BotUpsertInput {
  id?: string;
  provider: BotProviderId;
  name: string;
  enabled?: boolean;
  projectId?: string;
  allowUserIds?: string[];
  appId?: string;
  botOpenId?: string;
  apiBase?: string;
  token?: string;
  appSecret?: string;
  verificationToken?: string;
  encryptKey?: string;
}

const SECRET_SUFFIX: Record<BotSecretKind, string> = {
  token: "TOKEN",
  appSecret: "APPSECRET",
  verification: "VERIFICATION",
  encrypt: "ENCRYPT",
};

/** 稳定、可审计的 secrets 键名(只允许大写字母/数字/下划线)。 */
export function botSecretName(botId: string, kind: BotSecretKind): string {
  const safe = botId.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
  return `GENIE_BOT_${safe}_${SECRET_SUFFIX[kind]}`;
}

/** secrets.json 读缓存(mtime+size;env 优先)。 */
class SecretReader {
  private cache: { stamp: string; value: Record<string, unknown> } | undefined;
  constructor(private readonly file: string) {}

  read(name: string): string | undefined {
    const env = process.env[name];
    if (typeof env === "string" && env.trim()) return env;
    let st: { mtimeMs: number; size: number };
    try {
      st = statSync(this.file);
    } catch {
      return undefined;
    }
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (!this.cache || this.cache.stamp !== stamp) {
      try {
        const j = JSON.parse(readFileSync(this.file, "utf-8")) as Record<string, unknown>;
        this.cache = { stamp, value: j && typeof j === "object" && !Array.isArray(j) ? j : {} };
      } catch {
        this.cache = { stamp, value: {} };
      }
    }
    const v = this.cache.value[name];
    return typeof v === "string" && v ? v : undefined;
  }
}

function atomicWriteJson(file: string, value: unknown): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp-" + Date.now() + "-" + randomBytes(3).toString("hex");
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* 非 POSIX 环境降级 */ }
}

function cleanList(v: string[] | undefined): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean))];
  return out.length > 0 ? out : undefined;
}

function cleanApiBase(v: string | undefined): string | undefined {
  const s = String(v ?? "").trim();
  if (!s) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("apiBase 不是合法 URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("apiBase 必须是 http(s) 地址");
  return s.replace(/\/+$/, "");
}

export class BotStore {
  private file: string;
  private secretFile: string;
  private secrets: SecretReader;
  private bots: BotConfig[] | undefined;

  constructor(private readonly root: string) {
    const dir = join(root, ".genie");
    this.file = join(dir, "bots.json");
    this.secretFile = join(dir, "secrets.json");
    this.secrets = new SecretReader(this.secretFile);
  }

  list(): BotConfig[] {
    return [...this.load()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): BotConfig | undefined {
    return this.load().find((b) => b.id === id);
  }

 /** 新建/更新。enabled 缺省=新建 true/更新保持;secret 字段空串=不改已有值。 */
  upsert(input: BotUpsertInput): BotConfig {
    const provider = BotProviderZ.safeParse(input.provider);
    if (!provider.success) throw new Error("未知 Bot 渠道");
    const name = String(input.name ?? "").trim();
    if (!name) throw new Error("机器人名称不能为空");
    if (name.length > 60) throw new Error("机器人名称过长(≤60)");
    const all = this.load();
    const existing = input.id ? all.find((b) => b.id === input.id) : undefined;
    if (input.id && !existing) throw new Error("机器人不存在(可能已删除)");
    if (existing && existing.provider !== input.provider) throw new Error("不允许修改渠道类型,请新建机器人");
    const id = existing?.id ?? "b" + randomBytes(5).toString("hex");
    const now = Date.now();
    const next: BotConfig = {
      id,
      provider: input.provider,
      name,
      enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(input.projectId !== undefined ? { projectId: String(input.projectId || "").trim() || undefined } : existing?.projectId !== undefined ? { projectId: existing.projectId } : {}),
      ...(input.allowUserIds !== undefined ? { allowUserIds: cleanList(input.allowUserIds) } : existing?.allowUserIds ? { allowUserIds: existing.allowUserIds } : {}),
      ...(input.appId !== undefined ? { appId: String(input.appId || "").trim() || undefined } : existing?.appId ? { appId: existing.appId } : {}),
      ...(input.botOpenId !== undefined ? { botOpenId: String(input.botOpenId || "").trim() || undefined } : existing?.botOpenId ? { botOpenId: existing.botOpenId } : {}),
      ...(input.apiBase !== undefined ? { apiBase: cleanApiBase(input.apiBase) } : existing?.apiBase ? { apiBase: existing.apiBase } : {}),
      ...(existing?.providerUserId ? { providerUserId: existing.providerUserId } : {}),
      ...(existing?.username ? { username: existing.username } : {}),
    };
 // 凭证:有值=覆盖,空串/缺省=保留。写 secrets 必须在保存配置前完成(失败不留半配置)。
    this.writeSecretIf(id, "token", input.token);
    this.writeSecretIf(id, "appSecret", input.appSecret);
    this.writeSecretIf(id, "verification", input.verificationToken);
    this.writeSecretIf(id, "encrypt", input.encryptKey);
    const secrets = this.secretsOf(next);
    if (next.enabled) this.assertReady(next, secrets);
    const merged = all.filter((b) => b.id !== id).concat(next);
    this.persist(merged);
    return next;
  }

 /** 更新运行态字段(测试回填 username/providerUserId/lastError;lastError=null 表示清除)。 */
  patchRuntime(
    id: string,
    patch: { username?: string; providerUserId?: string; lastError?: string | null },
  ): BotConfig | undefined {
    const all = this.load();
    const i = all.findIndex((b) => b.id === id);
    if (i < 0) return undefined;
    const next: BotConfig = { ...all[i]!, updatedAt: Date.now() };
    if (patch.username !== undefined) next.username = patch.username;
    if (patch.providerUserId !== undefined) next.providerUserId = patch.providerUserId;
    if (patch.lastError === null) delete next.lastError;
    else if (patch.lastError !== undefined) next.lastError = patch.lastError;
    all[i] = next;
    this.persist(all);
    return next;
  }

  remove(id: string): boolean {
    const all = this.load();
    const next = all.filter((b) => b.id !== id);
    if (next.length === all.length) return false;
    this.persist(next);
 // 凭证键保留(平台侧可能仍启用);如需彻底清理由用户手工删 secrets.json 对应键。
    return true;
  }

  secretsOf(bot: BotConfig): BotSecrets {
    return {
      token: this.secrets.read(botSecretName(bot.id, "token")),
      appSecret: this.secrets.read(botSecretName(bot.id, "appSecret")),
      verification: this.secrets.read(botSecretName(bot.id, "verification")),
      encrypt: this.secrets.read(botSecretName(bot.id, "encrypt")),
    };
  }

  secretStateOf(bot: BotConfig): BotSecretState {
    const s = this.secretsOf(bot);
    return { token: !!s.token, appSecret: !!s.appSecret, verification: !!s.verification, encrypt: !!s.encrypt };
  }

 /** 给外部(service)用的凭证读取。 */
  secretByName(name: string): string | undefined {
    return this.secrets.read(name);
  }

  writeSecret(id: string, kind: BotSecretKind, value: string): void {
    setSecretValue(this.root, botSecretName(id, kind), value.trim());
  }

 /** 渠道摘要:远程控制右栏四张卡 + 机器人管理弹窗共用。 */
  channels(): BotChannelStatus[] {
    const all = this.load();
    return (Object.keys(BOT_PROVIDER_META) as BotProviderId[]).map((provider) => {
      const meta = BOT_PROVIDER_META[provider];
      const bots = all.filter((b) => b.provider === provider);
      const enabledBots = bots.filter((b) => b.enabled);
      const readyBots = enabledBots.filter((b) => this.isReady(b, this.secretsOf(b)));
      const detail = bots.length === 0
        ? "未接入"
        : enabledBots.length === 0
          ? "已停用"
          : readyBots.length > 0
            ? `${readyBots.length} 个机器人运行中`
            : this.missingDetail(provider);
      return {
        id: provider,
        title: meta.title,
        ...(meta.region ? { region: meta.region } : {}),
        bots: bots.length,
        enabled: enabledBots.length,
        configured: readyBots.length > 0,
        detail,
      };
    });
  }

  private isReady(bot: BotConfig, s: BotSecrets): boolean {
    if (bot.provider === "telegram" || bot.provider === "weixin") return !!s.token;
    return !!bot.appId && !!s.appSecret && !!s.verification;
  }

  private missingDetail(provider: BotProviderId): string {
    if (provider === "telegram") return "缺 Bot Token";
    if (provider === "weixin") return "未扫码接入";
    return "缺 App ID / App Secret / Verification Token";
  }

  private assertReady(bot: BotConfig, s: BotSecrets): void {
    if (bot.provider === "telegram" && !s.token) throw new Error("Telegram 需要 Bot Token");
    if (bot.provider === "weixin" && !s.token) throw new Error("微信需要先扫码接入(或填写 bot token)");
    if ((bot.provider === "feishu" || bot.provider === "lark")) {
      if (!bot.appId) throw new Error("飞书/Lark 需要 App ID");
      if (!s.appSecret) throw new Error("飞书/Lark 需要 App Secret");
      if (!s.verification) throw new Error("飞书/Lark 需要 Verification Token(事件订阅校验)");
    }
  }

  private writeSecretIf(id: string, kind: BotSecretKind, value: string | undefined): void {
    if (value === undefined) return;
    const v = value.trim();
    if (!v) return; // 留空=不修改
    this.writeSecret(id, kind, v);
  }

  private load(): BotConfig[] {
    if (this.bots) return this.bots;
    if (!existsSync(this.file)) return (this.bots = []);
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as unknown;
      const arr = Array.isArray(parsed) ? parsed : (parsed as { bots?: unknown })?.bots;
      const out: BotConfig[] = [];
      for (const raw of Array.isArray(arr) ? arr : []) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        const p = BotProviderZ.safeParse(r.provider);
        if (!p.success) continue;
        if (typeof r.id !== "string" || !r.id || typeof r.name !== "string" || !r.name) continue;
        out.push({
          id: r.id,
          provider: p.data,
          name: r.name,
          enabled: r.enabled !== false,
          createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
          updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : Date.now(),
          ...(typeof r.projectId === "string" && r.projectId ? { projectId: r.projectId } : {}),
          ...(Array.isArray(r.allowUserIds) ? { allowUserIds: r.allowUserIds.filter((x): x is string => typeof x === "string" && !!x) } : {}),
          ...(typeof r.appId === "string" && r.appId ? { appId: r.appId } : {}),
          ...(typeof r.botOpenId === "string" && r.botOpenId ? { botOpenId: r.botOpenId } : {}),
          ...(typeof r.providerUserId === "string" && r.providerUserId ? { providerUserId: r.providerUserId } : {}),
          ...(typeof r.username === "string" && r.username ? { username: r.username } : {}),
          ...(typeof r.apiBase === "string" && r.apiBase ? { apiBase: r.apiBase } : {}),
          ...(typeof r.lastError === "string" && r.lastError ? { lastError: r.lastError } : {}),
        });
      }
      return (this.bots = out);
    } catch {
      return (this.bots = []);
    }
  }

  private persist(bots: BotConfig[]): void {
    atomicWriteJson(this.file, bots);
    this.bots = bots;
  }
}

/** 会话状态键(稳定 sessionId 的哈希;用于诊断,不含敏感信息)。 */
export function botSessionIdFor(conversationKey: string, epoch = 0): string {
  const h = createHash("sha1").update(conversationKey + "#" + epoch).digest("hex").slice(0, 16);
  return `bot-${h}`;
}