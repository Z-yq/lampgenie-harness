/**
 * 飞书 IM 入站(二期, §2.2):事件回调接收+会话归属规则。
 * 形态=HTTP 事件回调(飞书官方通道;长连接 SDK 依赖重,登记为等价替代面)。
 * 红线:归属规则确定性(不靠模型);URL 校验 challenge 回显;加密事件 AES-256-CBC 解密;
 * verification token 不匹配=拒收。凭证全走 env(GENIE_FEISHU_*),不落配置文件。
 */
import { createHash, createDecipheriv } from "node:crypto";

export interface FeishuInboundOptions {
  /** 事件订阅 verification token(飞书开放平台-事件配置)。 */
  verificationToken?: string;
  /** 事件加密 key(可选;未配=收明文事件)。 */
  encryptKey?: string;
}

/** 飞书加密事件解密(AES-256-CBC,key=sha256(encryptKey),iv=密文前 16 字节)。 */
export function feishuDecrypt(encryptB64: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const data = Buffer.from(encryptB64, "base64");
  if (data.length <= 16) throw new Error("feishu 加密报文过短");
  const decipher = createDecipheriv("aes-256-cbc", key, data.subarray(0, 16));
  const out = Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]);
  return out.toString("utf8");
}

export type FeishuInboundResult =
  | { kind: "challenge"; challenge: string }
  | { kind: "ignored"; reason: string }
  | { kind: "message"; chatType: string; senderId: string; text: string; mentionsBot: boolean; chatId: string };

export interface ParsedFeishuEnvelope {
  header?: { event_type?: string; token?: string };
  event?: {
    message?: { chat_type?: string; chat_id?: string; content?: string; mentions?: { id?: { open_id?: string } }[] };
    sender?: { sender_id?: { open_id?: string } };
  };
  /** 旧版回调形态 */
  type?: string;
  challenge?: string;
  token?: string;
}

/** 解析回调报文:URL 校验(challenge 回显)/加密解包/消息事件归一。token 不匹配=typed error。 */
export function parseFeishuCallback(raw: string, opts: FeishuInboundOptions): FeishuInboundResult {
  let body: ParsedFeishuEnvelope;
  try {
    body = JSON.parse(raw) as ParsedFeishuEnvelope;
  } catch {
    throw new Error("feishu 回调非 JSON");
  }
  // 加密形态:{encrypt: "..."}(未配 key 而收到加密=拒收,不猜)
  if ((body as { encrypt?: string }).encrypt) {
    if (!opts.encryptKey) throw new Error("收到加密事件但未配置 encryptKey");
    body = JSON.parse(feishuDecrypt((body as { encrypt: string }).encrypt, opts.encryptKey)) as ParsedFeishuEnvelope;
  }
  // URL 校验(新版 v2 形态:{type:"url_check", challenge, token} 顶层,或 challenge 在 body)
  const token = body.token ?? body.header?.token;
  if (body.type === "url_check" || body.challenge !== undefined) {
    if (opts.verificationToken && token !== opts.verificationToken) throw new Error("feishu verification token 不匹配");
    return { kind: "challenge", challenge: String(body.challenge ?? "") };
  }
  if (opts.verificationToken) {
    if (!token || token !== opts.verificationToken) throw new Error("feishu verification token 不匹配");
  }
  const ev = body.event;
  const msgType = body.header?.event_type ?? "";
  if (!ev?.message || (msgType && msgType !== "im.message.receive_v1")) {
    return { kind: "ignored", reason: msgType ? `非消息事件 ${msgType}` : "无消息载荷" };
  }
  // 文本内容:content JSON {"text":"..."};@提及以 @_user_N 占位出现,剥占位后判 mentionsBot。
  let text = "";
  try {
    text = String((JSON.parse(ev.message.content ?? "{}") as { text?: string }).text ?? "");
  } catch {
    text = String(ev.message.content ?? "");
  }
  const mentionsBot = /@_user_\d/.test(text) || (ev.message.mentions?.length ?? 0) > 0;
  text = text.replace(/@_user_\d/g, "").trim();
  return {
    kind: "message",
    chatType: String(ev.message.chat_type ?? "unknown"),
    senderId: String(ev.sender?.sender_id?.open_id ?? ""),
    text,
    mentionsBot,
    chatId: String(ev.message.chat_id ?? ""),
  };
}

/** 会话归属( §2.2 表,确定性):
 * 私聊→成员收件箱(任务归属该成员);群@→项目绑定(无绑定=unbound);
 * 群未@→默认不入,例外=「TODO:/跟进:」前缀。 */
export type InboundRoute =
  | { target: "task"; scope: "dm" | "mention" | "todo"; sessionId: string; title: string }
  | { target: "inbox"; sessionId: string; reason: "unbound-group" }
  | { target: "ignore"; reason: string };

export function routeInboundMessage(msg: Extract<FeishuInboundResult, { kind: "message" }>, opts: { groupBindings: Record<string, string>; botOpenId?: string }): InboundRoute {
  const text = msg.text.trim();
  if (msg.chatType === "p2p") {
    return { target: "task", scope: "dm", sessionId: `im-${msg.senderId || "anon"}`, title: "[IM] " + text.slice(0, 40) };
  }
  if (msg.chatType === "group") {
    const isTodo = /^(TODO|TODO:|跟进[:：])/.test(text);
    const mentioned = msg.mentionsBot || (opts.botOpenId ? text.includes(opts.botOpenId) : false);
    if (isTodo) {
      return { target: "task", scope: "todo", sessionId: `im-group-${msg.chatId || "anon"}`, title: "[IM·TODO] " + text.replace(/^(TODO[:：]?|跟进[:：])\s*/, "").slice(0, 40) };
    }
    if (mentioned) {
      const bind = opts.groupBindings[msg.chatId];
      if (bind) return { target: "task", scope: "mention", sessionId: bind, title: "[IM@] " + text.slice(0, 40) };
      return { target: "inbox", sessionId: `im-group-${msg.chatId || "anon"}`, reason: "unbound-group" };
    }
    return { target: "ignore", reason: "群消息未@且无任务前缀" };
  }
  return { target: "ignore", reason: `未知 chat_type ${msg.chatType}` };
}
