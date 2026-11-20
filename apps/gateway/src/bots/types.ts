/**
 * Bot Channel 基础类型:微信 iLink / 飞书 / Lark / Telegram。
 * 设计口径:
 * - 配置(BotConfig)只存非敏感字段;token/appSecret/verification/encrypt 走 secrets.json;
 * - 适配器只做「平台协议收发」,任务路由/终态回推在 runtime.ts;
 * - 所有渠道的入站消息归一到 BotInboundMessage,出站统一 BotReplyTarget。
 */
import type { BotProviderId } from "@lampgenie/protocol";

export interface BotConfig {
  id: string;
  provider: BotProviderId;
  name: string;
  enabled: boolean;
 /** 默认项目 id;缺省=当前激活项目。 */
  projectId?: string;
 /** 允许对话的平台用户 id;空/缺省=不限制(面板会提示风险)。 */
  allowUserIds?: string[];
 /** 飞书/Lark 应用 App ID。 */
  appId?: string;
 /** 飞书/Lark 机器人 open_id(群 @ 判定辅助)。 */
  botOpenId?: string;
 /** 微信 iLink 机器人自身 id(发消息 from_user_id 用;测试/首条入站时补全)。 */
  providerUserId?: string;
 /** Telegram 机器人 @username(测试回填)。 */
  username?: string;
 /** 平台 API base 覆盖(私有化/测试 mock;缺省=官方地址)。 */
  apiBase?: string;
 /** 最近一次运行错误(只存人读摘要,不含凭证)。 */
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export type BotSecretKind = "token" | "appSecret" | "verification" | "encrypt";

export interface BotSecrets {
  token?: string;
  appSecret?: string;
  verification?: string;
  encrypt?: string;
}

export interface BotSecretState {
  token: boolean;
  appSecret: boolean;
  verification: boolean;
  encrypt: boolean;
}

export type BotChatType = "private" | "group";

/** 平台入站消息归一。 */
export interface BotInboundMessage {
  text: string;
 /** 平台用户 id(私聊=对方 id;群=发送者 id)。 */
  userId: string;
  userName?: string;
 /** 群/会话 id(私聊可缺省)。 */
  chatId?: string;
  chatType: BotChatType;
  messageId?: string;
 /** 微信 iLink 回复必须带(context_token)。 */
  contextToken?: string;
}

/** 出站目标(通常来自最近一条入站消息)。 */
export interface BotReplyTarget {
  userId: string;
  chatId?: string;
  chatType: BotChatType;
  contextToken?: string;
}

export interface BotTestResult {
  ok: boolean;
  message: string;
  username?: string;
  providerUserId?: string;
}

export interface BotAdapter {
 /** 测试凭证/连通性(真实调用平台 API)。 */
  test(bot: BotConfig, secrets: BotSecrets): Promise<BotTestResult>;
 /** 长轮询类渠道(Telegram/微信)启动收消息循环;webhook 类渠道不实现。 */
  start?(bot: BotConfig, secrets: BotSecrets, onMessage: (msg: BotInboundMessage) => void, signal: AbortSignal): void;
 /** 发送纯文本(超长由适配器自行分片)。 */
  send(bot: BotConfig, secrets: BotSecrets, target: BotReplyTarget, text: string): Promise<void>;
}

export const BOT_PROVIDER_META: Record<BotProviderId, { title: string; region?: string }> = {
  weixin: { title: "微信" },
  feishu: { title: "飞书", region: "中国" },
  lark: { title: "Lark", region: "全球" },
  telegram: { title: "Telegram" },
};

/** 会话稳定键:同一机器人+同一私聊/群 = 同一会话(重启后 sessionId 不变)。 */
export function botConversationKey(botId: string, msg: Pick<BotInboundMessage, "userId" | "chatId" | "chatType">): string {
  return `${botId}:${msg.chatType === "group" ? "g" : "u"}:${msg.chatId || msg.userId}`;
}