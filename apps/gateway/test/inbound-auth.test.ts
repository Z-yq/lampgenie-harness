/**
 * 入站认证(M133):V2 声明不降级/V1 兜底/INSECURE_NO_AUTH 仅 loopback/幂等/真实 HTTP 集成。
 */
import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyInboundRequest,
  resetInboundAuthState,
  INBOUND_FORBIDDEN_TEXT,
  type InboundAuthResult,
} from "../src/inbound-auth.js";
import { startInboundServer } from "../src/im-inbound.js";

const SECRET = "test-hmac-secret";
const TOKEN = "test-vtoken";
const NOW = 1_700_000_000_000;
const MAX_BODY = 1 << 20;

function sign(ts: string, body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

function v2Headers(body: string, over: { ts?: string; secret?: string; deliveryId?: string; omitTimestamp?: boolean; omitSignature?: boolean; badSignature?: string } = {}): Record<string, string> {
  const ts = over.ts ?? String(NOW);
  const headers: Record<string, string> = {};
  if (!over.omitTimestamp) headers["x-genie-timestamp"] = ts;
  if (!over.omitSignature) headers["x-genie-signature-v2"] = over.badSignature ?? sign(ts, body, over.secret ?? SECRET);
  if (over.deliveryId) headers["x-genie-delivery-id"] = over.deliveryId;
  return headers;
}

function call(body: string, headers: Record<string, string>, opts: Record<string, unknown> = {}, remoteAddress?: string): InboundAuthResult {
  return verifyInboundRequest({
    headers,
    rawBody: body,
    remoteAddress: remoteAddress ?? "10.0.0.9",
    route: "/webhook/feishu",
    opts: { hmacSecret: SECRET, verificationToken: TOKEN, now: () => NOW, ...opts },
  });
}

afterEach(() => {
  delete process.env.GENIE_INBOUND_INSECURE_NO_AUTH;
  resetInboundAuthState();
});

describe("V2 强声明", () => {
  it("合法签名 → ok,deliveryId 取自 x-genie-delivery-id", () => {
    const body = JSON.stringify({ header: { event_type: "im.message.receive_v1" } });
    const r = call(body, v2Headers(body, { deliveryId: "d-1" }));
    expect(r).toEqual({ ok: true, deliveryId: "d-1" });
  });

  it("V2 头出现但缺 timestamp → 403(不回落 V1,即便 body token 正确)", () => {
    const body = JSON.stringify({ token: TOKEN });
    const r = call(body, v2Headers(body, { omitTimestamp: true }));
    expect(r).toMatchObject({ ok: false, status: 403, reason: "v2-missing-timestamp" });
  });

  it("只有 timestamp 没 signature → 403", () => {
    const body = "{}";
    const r = call(body, v2Headers(body, { omitSignature: true }));
    expect(r).toMatchObject({ ok: false, status: 403, reason: "v2-missing-signature" });
  });

  it("签名错 → 403", () => {
    const body = JSON.stringify({ token: TOKEN });
    const r = call(body, v2Headers(body, { badSignature: "0".repeat(64) }));
    expect(r).toMatchObject({ ok: false, status: 403, reason: "v2-bad-signature" });
  });

  it("时间戳超出 ±300s 窗口 → 403(过期与未来都拒)", () => {
    const body = "{}";
    const stale = String(NOW - 300_001);
    expect(call(body, v2Headers(body, { ts: stale }))).toMatchObject({ ok: false, status: 403, reason: "v2-timestamp-out-of-window" });
    const future = String(NOW + 300_001);
    expect(call(body, v2Headers(body, { ts: future }))).toMatchObject({ ok: false, status: 403, reason: "v2-timestamp-out-of-window" });
    const edge = String(NOW - 300_000);
    expect(call(body, v2Headers(body, { ts: edge }))).toMatchObject({ ok: true });
  });

  it("时间戳非数字 → 403", () => {
    const body = "{}";
    const headers = v2Headers(body);
    headers["x-genie-timestamp"] = "not-a-number";
    expect(call(body, headers)).toMatchObject({ ok: false, status: 403, reason: "v2-bad-timestamp" });
  });

  it("带 V2 头但未配置 hmacSecret → 403", () => {
    const body = "{}";
    const r = call(body, v2Headers(body), { hmacSecret: undefined });
    expect(r).toMatchObject({ ok: false, status: 403, reason: "v2-secret-not-configured" });
  });

  it("请求体超上限 → 403(默认上限 1MB)", () => {
    expect(call("y".repeat(2048), {}, { maxBodyBytes: 1024 })).toMatchObject({ ok: false, status: 403, reason: "body-too-large" });
    const body = "y".repeat(MAX_BODY + 1);
    expect(call(body, v2Headers(body))).toMatchObject({ ok: false, status: 403, reason: "body-too-large" });
  });
});

describe("V1 兜底(body token)", () => {
  it("无任何 V2 头 + token 正确 → ok;token 错/缺失 → 403", () => {
    expect(call(JSON.stringify({ token: TOKEN }), {})).toMatchObject({ ok: true });
    expect(call(JSON.stringify({ header: { token: TOKEN } }), {})).toMatchObject({ ok: true });
    expect(call(JSON.stringify({ token: "wrong" }), {})).toMatchObject({ ok: false, status: 403, reason: "v1-token-mismatch" });
    expect(call(JSON.stringify({}), {})).toMatchObject({ ok: false, status: 403, reason: "v1-token-mismatch" });
    expect(call("not-json", {})).toMatchObject({ ok: false, status: 403, reason: "v1-token-mismatch" });
  });

  it("未配置任何方案(无 secret 无 token)→ 403", () => {
    expect(call("{}", {}, { hmacSecret: undefined, verificationToken: undefined })).toMatchObject({ ok: false, status: 403, reason: "no-auth-scheme" });
  });
});

describe("INSECURE_NO_AUTH 仅 loopback", () => {
  const noScheme = { hmacSecret: undefined, verificationToken: undefined };

  it("env=1 + 非 loopback → 403", () => {
    process.env.GENIE_INBOUND_INSECURE_NO_AUTH = "1";
    expect(call("{}", {}, noScheme, "10.0.0.9")).toMatchObject({ ok: false, status: 403, reason: "no-auth-scheme" });
    expect(call("{}", {}, noScheme, "192.168.1.7")).toMatchObject({ ok: false, status: 403 });
  });

  it("env=1 + loopback(127.0.0.1/::1/::ffff:127.0.0.1)→ ok", () => {
    process.env.GENIE_INBOUND_INSECURE_NO_AUTH = "1";
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(call("{}", {}, noScheme, addr)).toMatchObject({ ok: true });
    }
  });

  it("env 未设或显式关闭 → loopback 也 403", () => {
    expect(call("{}", {}, noScheme, "127.0.0.1")).toMatchObject({ ok: false, status: 403 });
    process.env.GENIE_INBOUND_INSECURE_NO_AUTH = "1";
    expect(call("{}", {}, { ...noScheme, allowInsecureLoopback: false }, "127.0.0.1")).toMatchObject({ ok: false, status: 403 });
  });
});

describe("幂等(profile|route|delivery_id,24h)", () => {
  it("同 delivery id 第二次 → duplicate;不同 route/profile 各自独立", () => {
    const body = JSON.stringify({ header: { event_id: "evt-1" } });
    const first = call(body, v2Headers(body));
    expect(first).toEqual({ ok: true, deliveryId: "evt-1" });
    expect(call(body, v2Headers(body))).toEqual({ ok: true, deliveryId: "evt-1", duplicate: true });
    // header 优先于 body.header.event_id
    const byHeader = call(body, v2Headers(body, { deliveryId: "evt-2" }));
    expect(byHeader).toEqual({ ok: true, deliveryId: "evt-2" });
    // 另一 route 不复用
    const otherRoute = verifyInboundRequest({
      headers: v2Headers(body), rawBody: body, remoteAddress: "10.0.0.9", route: "/webhook/other",
      opts: { hmacSecret: SECRET, now: () => NOW },
    });
    expect(otherRoute).toEqual({ ok: true, deliveryId: "evt-1" });
  });

  it("超过 24h TTL 后可再次投递", () => {
    const body = JSON.stringify({ header: { event_id: "evt-ttl" } });
    let clock = NOW;
    const opts = { hmacSecret: SECRET, now: () => clock };
    const run = () => verifyInboundRequest({
      headers: v2Headers(body, { ts: String(clock) }),
      rawBody: body,
      remoteAddress: "10.0.0.9",
      route: "/webhook/feishu",
      opts,
    });
    expect(run()).toEqual({ ok: true, deliveryId: "evt-ttl" });
    clock = NOW + 23 * 3600_000;
    expect(run()).toMatchObject({ duplicate: true });
    clock = NOW + 25 * 3600_000;
    expect(run()).toEqual({ ok: true, deliveryId: "evt-ttl" });
  });
});

describe("startInboundServer HTTP 集成(真实端口)", () => {
  it("合法 V2 → 200 且触发任务;签名错 → 403 forbidden;重复 delivery → 200 duplicate", async () => {
    const tasks: { sessionId: string; instruction: string; title: string }[] = [];
    const svc = startInboundServer({
      port: 0,
      verificationToken: TOKEN,
      hmacSecret: SECRET,
      submitTask: (t) => tasks.push(t),
      log: () => {},
    });
    await new Promise<void>((r) => svc.server.once("listening", r));
    const addr = svc.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const url = `http://127.0.0.1:${port}/webhook/feishu`;
    const body = JSON.stringify({
      header: { event_type: "im.message.receive_v1", token: TOKEN, event_id: "http-evt-1" },
      event: {
        message: { chat_type: "p2p", chat_id: "oc_dm", content: JSON.stringify({ text: "帮我查天气" }), mentions: [] },
        sender: { sender_id: { open_id: "ou_u1" } },
      },
    });
    const ts = String(Date.now());
    const headers = { "content-type": "application/json", "x-genie-timestamp": ts, "x-genie-signature-v2": sign(ts, body) };

    const ok = await fetch(url, { method: "POST", headers, body });
    expect(ok.status).toBe(200);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.sessionId).toBe("im-ou_u1");

    // 同 event_id 重复投递 → 200 duplicate,不重复建任务
    const dup = await fetch(url, { method: "POST", headers, body });
    expect(dup.status).toBe(200);
    expect(await dup.json()).toEqual({ duplicate: true });
    expect(tasks).toHaveLength(1);

    // 签名错 → 403,响应体固定 forbidden(不泄露细节)
    const bad = await fetch(url, { method: "POST", headers: { ...headers, "x-genie-signature-v2": "f".repeat(64) }, body });
    expect(bad.status).toBe(403);
    expect(await bad.text()).toBe(INBOUND_FORBIDDEN_TEXT);
    expect(tasks).toHaveLength(1);

    // V2 头残缺 + body token 正确 → 403(不降级到 V1)
    const downgrade = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-genie-signature-v2": "a".repeat(64) },
      body,
    });
    expect(downgrade.status).toBe(403);
    expect(tasks).toHaveLength(1);

    await svc.close();
  });
});
