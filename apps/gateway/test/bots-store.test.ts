/**
 * Bot 配置/凭证存储:CRUD、secret 只进 secrets.json、渠道摘要、会话 id 稳定。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore, botSecretName, botSessionIdFor } from "../src/bots/store.js";

describe("BotStore", () => {
  let root = "";
  let store: BotStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bots-store-"));
    store = new BotStore(root);
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });

  it("Telegram:建/改/删;token 只进 secrets.json,配置与 public 面不回显", () => {
    const bot = store.upsert({ provider: "telegram", name: "我的 TG", token: "123456:ABC-secret" });
    expect(bot.id).toMatch(/^b[0-9a-f]{10}$/);
    expect(bot.enabled).toBe(true);
    expect(store.secretStateOf(bot).token).toBe(true);
    expect(store.secretsOf(bot).token).toBe("123456:ABC-secret");
    const cfgRaw = readFileSync(join(root, ".genie", "bots.json"), "utf-8");
    expect(cfgRaw).not.toContain("ABC-secret");
    expect(cfgRaw).toContain("我的 TG");
    const secretRaw = readFileSync(join(root, ".genie", "secrets.json"), "utf-8");
    expect(secretRaw).toContain("ABC-secret");
    expect(botSecretName(bot.id, "token")).toMatch(/^GENIE_BOT_B[0-9A-F]{10}_TOKEN$/);

 // 改名不传 token → 保留原凭证
    const renamed = store.upsert({ id: bot.id, provider: "telegram", name: "改名后", enabled: true });
    expect(renamed.name).toBe("改名后");
    expect(store.secretsOf(renamed).token).toBe("123456:ABC-secret");

    expect(store.channels().find((c) => c.id === "telegram")).toMatchObject({ bots: 1, enabled: 1, configured: true });
    expect(store.remove(bot.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("缺少必需凭证时启用即拒;飞书/Lark 需要 App ID + App Secret + Verification Token", () => {
    expect(() => store.upsert({ provider: "telegram", name: "无 token", enabled: true })).toThrow(/Bot Token/);
    expect(() => store.upsert({ provider: "weixin", name: "未扫码", enabled: true })).toThrow(/扫码/);
    expect(() => store.upsert({ provider: "feishu", name: "缺密钥", enabled: true })).toThrow(/App ID/);
    const bot = store.upsert({
      provider: "lark",
      name: "Lark 机器人",
      enabled: true,
      appId: "cli_x",
      appSecret: "sec",
      verificationToken: "verify",
    });
    expect(store.secretStateOf(bot)).toMatchObject({ appSecret: true, verification: true });
    expect(store.channels().find((c) => c.id === "lark")?.configured).toBe(true);
  });

  it("allowUserIds/项目/API base 归一;非法 apiBase 拒绝", () => {
    const bot = store.upsert({
      provider: "telegram",
      name: "白名单",
      token: "t",
      allowUserIds: [" u1 ", "u1", "", "u2"],
      apiBase: "https://example.com/api/",
      projectId: "p1",
    });
    expect(bot.allowUserIds).toEqual(["u1", "u2"]);
    expect(bot.apiBase).toBe("https://example.com/api");
    expect(bot.projectId).toBe("p1");
    expect(() => store.upsert({ provider: "telegram", name: "bad", token: "t", apiBase: "ftp://x" })).toThrow(/apiBase/);
  });

  it("会话 id 稳定且 /new 换 epoch 后变化", () => {
    const a = botSessionIdFor("bot:u:u1", 0);
    expect(a).toBe(botSessionIdFor("bot:u:u1", 0));
    expect(a).toMatch(/^bot-[0-9a-f]{16}$/);
    expect(a).not.toBe(botSessionIdFor("bot:u:u1", 1));
    expect(a).not.toBe(botSessionIdFor("bot:u:u2", 0));
  });
});