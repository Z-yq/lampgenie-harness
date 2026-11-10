/**
 * 飞书 IM 入站(step-013 二期收口):URL 校验 challenge/token 门/加密解密/归属规则/HTTP 面。
 */
import { describe, it, expect, afterEach } from "vitest";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { parseFeishuCallback, routeInboundMessage, feishuDecrypt, type ParsedFeishuEnvelope } from "@lampgenie/runtime/notify/inbound";
import { startInboundServer, parseGroupBinds } from "../src/im-inbound.js";

const TOKEN = "test-vtoken";

/** 构造飞书加密形态(逆向解密规格:AES-256-CBC,key=sha256(key),iv=前16字节)。 */
function feishuEncrypt(payload: unknown, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);
  return Buffer.concat([iv, data]).toString("base64");
}

function msgEvent(over: Partial<NonNullable<ParsedFeishuEnvelope["event"]>> = {}): ParsedFeishuEnvelope {
  return {
    header: { event_type: "im.message.receive_v1", token: TOKEN },
    event: {
      message: { chat_type: "p2p", chat_id: "oc_dm", content: JSON.stringify({ text: "帮我查天气" }), mentions: [] },
      sender: { sender_id: { open_id: "ou_u1" } },
      ...over,
    },
  };
}

afterEach(() => { delete process.env.GENIE_FEISHU_GROUP_BINDS; });

describe("parseFeishuCallback", () => {
  it("url_check:challenge 回显;token 不匹配拒收", () => {
    const r = parseFeishuCallback(JSON.stringify({ type: "url_check", challenge: "chk-1", token: TOKEN }), { verificationToken: TOKEN });
    expect(r).toEqual({ kind: "challenge", challenge: "chk-1" });
    expect(() => parseFeishuCallback(JSON.stringify({ type: "url_check", challenge: "c", token: "wrong" }), { verificationToken: TOKEN })).toThrow(/token 不匹配/);
  });

  it("消息事件归一:文本剥 @占位+mentionsBot 判定", () => {
    const r = parseFeishuCallback(JSON.stringify(msgEvent({
      message: { chat_type: "group", chat_id: "oc_g1", content: JSON.stringify({ text: "@_user_1 部署一下" }), mentions: [{ id: { open_id: "ou_bot" } }] },
    })), { verificationToken: TOKEN });
    expect(r).toMatchObject({ kind: "message", chatType: "group", text: "部署一下", mentionsBot: true });
  });

  it("加密事件:AES 解包后正常解析", () => {
    const key = "my-encrypt-key";
    const enc = feishuEncrypt(msgEvent(), key);
    const r = parseFeishuCallback(JSON.stringify({ encrypt: enc }), { verificationToken: TOKEN, encryptKey: key });
    expect(r).toMatchObject({ kind: "message", senderId: "ou_u1", text: "帮我查天气" });
    // 往返一致性:解密函数直接跑
    expect(JSON.parse(feishuDecrypt(enc, key))).toEqual(msgEvent());
  });

  it("加密事件但未配 key=拒收;非消息事件忽略", () => {
    expect(() => parseFeishuCallback(JSON.stringify({ encrypt: "aaa" }), {})).toThrow(/encryptKey/);
    const r = parseFeishuCallback(JSON.stringify({ header: { event_type: "im.chat.updated", token: TOKEN }, event: {} }), { verificationToken: TOKEN });
    expect(r).toEqual({ kind: "ignored", reason: "非消息事件 im.chat.updated" });
  });
});

describe("routeInboundMessage(归属规则,designs/08 §2.2)", () => {
  const dm = { kind: "message" as const, chatType: "p2p", senderId: "ou_u1", text: "查天气", mentionsBot: false, chatId: "oc_dm" };
  it("私聊→成员会话任务(im-<open_id>)", () => {
    expect(routeInboundMessage(dm, { groupBindings: {} })).toEqual({ target: "task", scope: "dm", sessionId: "im-ou_u1", title: "[IM] 查天气" });
  });
  it("群@+已绑定→项目会话;未绑定→收件箱", () => {
    const g = { ...dm, chatType: "group", mentionsBot: true, chatId: "oc_g1" };
    expect(routeInboundMessage(g, { groupBindings: { oc_g1: "sess-p1" } })).toMatchObject({ target: "task", scope: "mention", sessionId: "sess-p1" });
    expect(routeInboundMessage(g, { groupBindings: {} })).toEqual({ target: "inbox", sessionId: "im-group-oc_g1", reason: "unbound-group" });
  });
  it("群未@:TODO/跟进 前缀入任务,否则忽略", () => {
    const todo = { ...dm, chatType: "group", mentionsBot: false, chatId: "oc_g1", text: "TODO: 修登录页" };
    expect(routeInboundMessage(todo, { groupBindings: {} })).toMatchObject({ target: "task", scope: "todo" });
    const genxin = { ...todo, text: "跟进:发周报" };
    expect(routeInboundMessage(genxin, { groupBindings: {} })).toMatchObject({ target: "task", scope: "todo" });
    const plain = { ...todo, text: "今天天气不错" };
    expect(routeInboundMessage(plain, { groupBindings: {} })).toMatchObject({ target: "ignore" });
  });
});

describe("startInboundServer(HTTP 面)", () => {
  it("challenge 请求回显;消息创建任务;错误 token 400;群绑定 env 解析", async () => {
    const tasks: { sessionId: string; instruction: string; title: string }[] = [];
    const inbox: { reason: string }[] = [];
    const svc = startInboundServer({
      port: 0,
      verificationToken: TOKEN,
      groupBindings: parseGroupBinds("oc_g9=sess-x"),
      submitTask: (t) => tasks.push(t),
      noteInbox: (n) => inbox.push(n),
      log: () => {},
    });
    await new Promise<void>((r) => svc.server.once("listening", r));
    const addr = svc.server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

    const ch = await fetch(`${base}/webhook/feishu`, { method: "POST", body: JSON.stringify({ type: "url_check", challenge: "cc", token: TOKEN }) });
    expect(await ch.json()).toEqual({ challenge: "cc" });

    const mk = await fetch(`${base}/webhook/feishu`, { method: "POST", body: JSON.stringify(msgEvent()) });
    expect(mk.status).toBe(200);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.sessionId).toBe("im-ou_u1");

    // M133:认证在解析前完成(V1 token 不匹配)→ 403 forbidden,不再是 400
    const bad = await fetch(`${base}/webhook/feishu`, { method: "POST", body: JSON.stringify({ type: "url_check", challenge: "x", token: "nope" }) });
    expect(bad.status).toBe(403);
    expect(await bad.text()).toBe("forbidden");

    const g = await fetch(`${base}/webhook/feishu`, { method: "POST", body: JSON.stringify(msgEvent({
      message: { chat_type: "group", chat_id: "oc_g9", content: JSON.stringify({ text: "@_user_1 上线" }), mentions: [{ id: { open_id: "b" } }] },
    })) });
    expect(g.status).toBe(200);
    expect(tasks[1]!.sessionId).toBe("sess-x");

    // 非 webhook 路由 404
    const nf = await fetch(`${base}/other`, { method: "POST", body: "{}" });
    expect(nf.status).toBe(404);

    await svc.close();
    void inbox;
  });
});
