/**
 * 入站 Webhook 认证(M133,防降级):
 * - auth-before-body:先按原始字节验签(1MB cap),通过后才解析 JSON;
 * - 多方案按最强声明选择:任一 V2 头(x-genie-signature-v2 / x-genie-timestamp)出现即 commit V2,
 *   缺 timestamp / 缺 signature / 签名错 / 时间窗外一律 403,**绝不回落 body-only(V1)**;
 * - V2 签名 = hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)),常量时间比较,窗口默认 300s;
 * - V1 兜底:仅在未出现任何 V2 头且配置了 verificationToken 时,按 body JSON 的 token(顶层或 header.token)校验;
 * - INSECURE_NO_AUTH:GENIE_INBOUND_INSECURE_NO_AUTH=1 且来源为 loopback 才放行,其余来源仍需真认证;
 * - 幂等:(profile|route|deliveryId) 进程内 24h TTL,重复返回 duplicate;
 * - 失败对外文案固定 forbidden(细节只留在本模块 reason 与调用方日志,不回给客户端)。
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const INBOUND_V2_SIGNATURE_HEADER = "x-genie-signature-v2";
export const INBOUND_V2_TIMESTAMP_HEADER = "x-genie-timestamp";
export const INBOUND_DELIVERY_ID_HEADER = "x-genie-delivery-id";
export const INBOUND_FORBIDDEN_TEXT = "forbidden";
export const DEFAULT_AUTH_WINDOW_MS = 300_000;
export const DEFAULT_MAX_BODY_BYTES = 1 << 20;
const DUPLICATE_TTL_MS = 24 * 60 * 60 * 1000;

export interface InboundAuthOptions {
  /** V2 HMAC 密钥;未配置而请求带 V2 头 = 403(不降级)。 */
  hmacSecret?: string;
  /** V1 兜底用的 verification token(与飞书回调 body token 同源)。 */
  verificationToken?: string;
  now?: () => number;
  /** 时间窗(毫秒),默认 300_000。 */
  windowMs?: number;
  /** 是否允许 INSECURE_NO_AUTH(仍需 env=1 且来源 loopback),默认允许。 */
  allowInsecureLoopback?: boolean;
  /** 请求体上限,默认 1MB。 */
  maxBodyBytes?: number;
  /** 幂等键的 profile 段(多入口隔离),默认 "default"。 */
  profile?: string;
}

export type InboundHeaders = Record<string, string | string[] | undefined>;

export interface InboundAuthInput {
  headers: InboundHeaders;
  rawBody: string | Buffer;
  /** req.socket.remoteAddress ;用于 loopback 判定。 */
  remoteAddress?: string;
  /** 路由标识(如 /webhook/feishu),参与幂等键。 */
  route: string;
  opts: InboundAuthOptions;
}

export type InboundAuthResult =
  | { ok: true; deliveryId?: string; duplicate?: boolean }
  | { ok: false; status: 403; reason: string };

/** 进程内幂等表:key → 首次见到的时间戳。 */
const seenDeliveries = new Map<string, number>();

/** 测试用:清空幂等表(不对外暴露语义)。 */
export function resetInboundAuthState(): void {
  seenDeliveries.clear();
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return LOOPBACK_ADDRESSES.has(address.trim());
}

function fail(reason: string): InboundAuthResult {
  return { ok: false, status: 403, reason };
}

function headerValue(headers: InboundHeaders, name: string): string | undefined {
  const direct = headers[name];
  const raw = direct !== undefined ? direct : headers[name.toLowerCase()];
  if (raw === undefined) return undefined;
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string") return undefined;
  const trimmed = first.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 常量时间字符串比较(先取摘要归一长度,避免长度差成为旁路)。 */
function safeEqualText(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** hex 签名常量时间比较。 */
function safeEqualHex(expectedHex: string, actual: string): boolean {
  const actualHex = actual.trim().toLowerCase();
  const a = Buffer.from(expectedHex, "utf8");
  const b = Buffer.from(actualHex, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function insecureAllowed(opts: InboundAuthOptions, remoteAddress: string | undefined): boolean {
  if ((opts.allowInsecureLoopback ?? true) === false) return false;
  if (process.env.GENIE_INBOUND_INSECURE_NO_AUTH !== "1") return false;
  return isLoopbackAddress(remoteAddress);
}

function bodyToken(rawText: string): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object") return undefined;
  const obj = body as { token?: unknown; header?: { token?: unknown } };
  const token = obj.token ?? obj.header?.token;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

function deliveryIdOf(headers: InboundHeaders, rawText: string): string | undefined {
  const fromHeader = headerValue(headers, INBOUND_DELIVERY_ID_HEADER);
  if (fromHeader) return fromHeader;
  try {
    const body = JSON.parse(rawText) as { header?: { event_id?: unknown } };
    const id = body?.header?.event_id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function accept(deliveryId: string | undefined, route: string, opts: InboundAuthOptions): InboundAuthResult {
  if (!deliveryId) return { ok: true };
  const now = (opts.now ?? Date.now)();
  for (const [key, at] of seenDeliveries) {
    if (now - at > DUPLICATE_TTL_MS) seenDeliveries.delete(key);
  }
  const key = `${opts.profile ?? "default"}|${route}|${deliveryId}`;
  if (seenDeliveries.has(key)) return { ok: true, deliveryId, duplicate: true };
  seenDeliveries.set(key, now);
  return { ok: true, deliveryId };
}

/**
 * 校验一次入站请求。**调用方必须先把 rawBody 读完(且有 1MB 上限)再调用**,
 * 通过后才允许把 rawBody 交给解析器(不得在认证前解析/信任 body 字段)。
 */
export function verifyInboundRequest(input: InboundAuthInput): InboundAuthResult {
  const opts = input.opts;
  const raw = typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : input.rawBody;
  const route = input.route;
  if (raw.length > (opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)) return fail("body-too-large");
  const rawText = raw.toString("utf8");

  const signature = headerValue(input.headers, INBOUND_V2_SIGNATURE_HEADER);
  const timestamp = headerValue(input.headers, INBOUND_V2_TIMESTAMP_HEADER);

  // 任一 V2 头出现 = 声明 V2:从这里起只有 V2 一条路,失败即 403。
  if (signature !== undefined || timestamp !== undefined) {
    if (timestamp === undefined) return fail("v2-missing-timestamp");
    if (signature === undefined) return fail("v2-missing-signature");
    if (!opts.hmacSecret) return fail("v2-secret-not-configured");
    if (!/^\d+$/.test(timestamp)) return fail("v2-bad-timestamp");
    const now = (opts.now ?? Date.now)();
    const windowMs = opts.windowMs ?? DEFAULT_AUTH_WINDOW_MS;
    if (Math.abs(now - Number(timestamp)) > windowMs) return fail("v2-timestamp-out-of-window");
    const expected = createHmac("sha256", opts.hmacSecret).update(`${timestamp}.${rawText}`, "utf8").digest("hex");
    if (!safeEqualHex(expected, signature)) return fail("v2-bad-signature");
    return accept(deliveryIdOf(input.headers, rawText), route, opts);
  }

  // 未出现 V2 头:开发放行(仅 env + loopback)→ 否则 V1 token 兜底 → 否则 403。
  if (insecureAllowed(opts, input.remoteAddress)) return accept(deliveryIdOf(input.headers, rawText), route, opts);
  if (opts.verificationToken) {
    const token = bodyToken(rawText);
    if (!token || !safeEqualText(token, opts.verificationToken)) return fail("v1-token-mismatch");
    return accept(deliveryIdOf(input.headers, rawText), route, opts);
  }
  return fail("no-auth-scheme");
}
