/**
 * 公网读写工具(参照 deepseek-harness tool-web / web-fetch-http / web-search-*)。
 * 两个只读工具,与 browser 工具分工:
 * - web_fetch:静态抓取一个公网 HTTP(S) 页面 → markdown/纯文本(SSRF 防护/超时/大小/域名/类型约束);
 * - web_search:检索 API → [{title,url,snippet}](provider 由 env 配置,key 只从 env 读取)。
 * 需要登录/点击/JS 动态渲染的交互操作仍走 browser 工具。
 * 安全边界(照搬 dsh 的 public HTTP 策略,按零依赖裁剪):
 * - 仅 http/https,拒 URL 内嵌凭证与 localhost;
 * - DNS 全量答案必须是公网地址(回环/私网/链路本地/组播/文档段/ULA 等一律拒),
 *   连接用自定义 lookup 钉住已校验地址(防 DNS rebinding);
 * - 重定向最多 maxRedirects 跳,每跳重新校验并重新解析;
 * - Content-Length 超限明确报错;流式超限截断并标记;content-type 白名单;charset 解码。
 * 说明:allowPrivate 只作为单测注入的传输旁路(生产工具不暴露、不读取 env)。
 */
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { TextDecoder } from "node:util";
import type { Tool } from "@lampgenie/runtime/agent/loop";

/** 默认值(env 均可覆盖;工具入参不暴露部署策略)。 */
export const WEB_FETCH_DEFAULT_TIMEOUT_MS = 15_000;
export const WEB_FETCH_DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_FETCH_DEFAULT_MAX_CHARS = 20_000;
export const WEB_FETCH_DEFAULT_MAX_REDIRECTS = 5;
export const WEB_SEARCH_DEFAULT_TIMEOUT_MS = 15_000;
export const WEB_SEARCH_DEFAULT_MAX_RESULTS = 8;
export const WEB_SEARCH_MAX_RESULTS = 10;

/** 抓取失败的错误分类(fail-visible 文本里保留可判读前缀)。 */
export type WebToolErrorCode =
  | "invalid_url"
  | "blocked_url"
  | "too_large"
  | "timeout"
  | "aborted"
  | "unsupported_content_type"
  | "network"
  | "http_error"
  | "bad_response"
  | "unconfigured";

export class WebToolError extends Error {
  constructor(message: string, readonly code: WebToolErrorCode, readonly phase?: "connect") {
    super(message);
    this.name = "WebToolError";
  }
}

/** 工具配置(测试注入;生产缺省读 env + browser 域名白名单)。 */
export interface WebToolConfig {
  /** 域名白名单读取器(空=所有公网)。生产接 browser 的 allowDomains。 */
  allowDomains?: () => string[];
  /** 环境变量源(缺省 process.env;测试注入隔离)。 */
  env?: NodeJS.ProcessEnv;
  fetchTimeoutMs?: number;
  maxResponseBytes?: number;
  maxContentChars?: number;
  searchTimeoutMs?: number;
  maxResults?: number;
 /** 搜索 provider 的配置层读取器:返回 genie.config.json 的 web.search 运行时
   * 形态(provider/apiKey/endpoint/model);配置在场时优先于 env 探测,缺席=null 走 env/降级链。 */
  searchRuntime?: () => { provider: string; apiKey?: string; endpoint?: string; model?: string } | null;
 /** browser 渲染兜底(web_fetch:静态抓取正文疑似 JS 渲染(近空)或抓取失败时,
   * 用 browser 工具真实渲染取正文。生产接 agent-wiring 的 browserTool(action=text);缺席=不兜底。 */
  browserFetch?: (url: string) => Promise<{ ok: true; title: string; text: string } | { ok: false; error: string }>;
}

/** 一次成功抓取的结构化结果(JSON 返回,面板 卡片可直接美化渲染)。 */
export interface WebFetchOutput {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  title: string;
  contentType: string;
  bytes: number;
  length: number;
  truncated: boolean;
  truncatedBy?: "bytes" | "chars";
  content: string;
}

/** 抓取选项(部署策略;signal 由 loop 取消透传)。 */
export interface WebFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxChars?: number;
  maxRedirects?: number;
  allowDomains?: string[];
  signal?: AbortSignal;
  /** 单测旁路:允许私网/localhost。生产工具调用不设置。 */
  allowPrivate?: boolean;
  /**
   * 单测旁路:跳过 DNS,直接注入「已校验的地址集」(与 allowPrivate 同性质,仅测试用)。
   * 用途:确定性复现「hostname + 不可达地址」的连接层缺陷(字面量 IP 不会走 lookup,
   * 无法覆盖自定义 lookup 路径)。生产工具调用不设置。
   */
  resolvedAddresses?: LookupAddress[];
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  truncatedByBytes: boolean;
}

const MAX_URL_LENGTH = 2048;
/** 单地址连接阶段预算(失败后换下一个已校验地址;总预算仍由 timeoutMs/全局 timer 控制)。 */
const ADDRESS_CONNECT_TIMEOUT_MS = 5_000;

function envText(env: NodeJS.ProcessEnv, key: string): string {
  return String(env[key] ?? "").trim();
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = Number(envText(env, key));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function envCsv(env: NodeJS.ProcessEnv, key: string): string[] {
  return envText(env, key)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 域名白名单:空=全允许;命中=精确或子域。 */
export function hostAllowed(hostname: string, allow: string[]): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (allow.length === 0) return true;
  return allow.some((entry) => {
    const domain = entry.trim().toLowerCase().replace(/^\[|\]$/g, "");
    return domain.length > 0 && (host === domain || host.endsWith("." + domain));
  });
}

// ---------------------------------------------------------------------------
// SSRF 防护:公网 IP 判定 + 全量 DNS 校验 + 地址钉住
// ---------------------------------------------------------------------------

function parseIpv4(input: string): number[] | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function isPublicIpv4(input: string): boolean {
  const octets = parseIpv4(input);
  if (!octets) return false;
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false; // 0/8, 10/8, 127/8
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return false; // 169.254/16 link-local(含云元数据)
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12
  if (a === 192 && b === 168) return false; // 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // 192.0.0/24, 192.0.2/24
  if (a === 192 && b === 88 && c === 99) return false; // 192.88.99/24 (6to4 relay)
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // 203.0.113/24 TEST-NET-3
  if (a >= 224) return false; // 224/4 multicast + 240/4 reserved + broadcast
  return true;
}

/** 把 16 位组转回 IPv4 文本并复用 v4 判定。 */
function publicFromGroups(hi: number, lo: number): boolean {
  return isPublicIpv4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
}

/** 解析 IPv6 为 8 个 16 位组(支持 :: 压缩与嵌入 IPv4);非法返回 null。 */
export function parseIpv6(input: string): number[] | null {
  let s = input.trim().toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!s.includes(":")) return null;
  if (s.includes(".")) {
    const lastColon = s.lastIndexOf(":");
    if (lastColon < 0) return null;
    const v4 = parseIpv4(s.slice(lastColon + 1));
    if (!v4) return null;
    const [a, b, c, d] = v4 as [number, number, number, number];
    s = s.slice(0, lastColon + 1)
      + (((a << 8) | b).toString(16)) + ":" + (((c << 8) | d).toString(16));
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 && missing < 1) return null;
  if (halves.length === 1 && missing !== 0) return null;
  const groups = [...left, ...Array.from({ length: Math.max(missing, 0) }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  const nums: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    nums.push(parseInt(group, 16));
  }
  return nums;
}

function isPublicIpv6(input: string): boolean {
  const groups = parseIpv6(input);
  if (!groups) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  if (groups.every((g) => g === 0)) return false; // :: unspecified
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return false; // ::1
  // IPv4-mapped ::ffff:0:0/96 与 IPv4-compatible ::/96(按内嵌 v4 判定)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0xffff) return publicFromGroups(g6, g7);
    if (g5 === 0) return publicFromGroups(g6, g7);
  }
  // NAT64 64:ff9b::/96
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return publicFromGroups(g6, g7);
  }
  // 6to4 2002::/16(内嵌 v4)
  if (g0 === 0x2002) return publicFromGroups(g1, g2);
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local
  if ((g0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // 2001:db8::/32 docs
  if (g0 === 0x2001 && g1 === 0x0000) return false; // 2001::/32 Teredo(过渡地址,不钉)
  if (g0 === 0x2001 && g1 === 0x0002) return false; // 2001:2::/48 benchmarking
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return false; // 3fff::/20 docs
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false; // 100::/64 discard-only
  return true;
}

/** 文本 IP 是否公网单播。 */
export function isPublicIp(input: string): boolean {
  const ip = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  const family = isIP(ip);
  if (family === 4) return isPublicIpv4(ip);
  if (family === 6) return isPublicIpv6(ip);
  return false;
}

function isLocalhostName(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost");
}

/** 失败原因文本:Node 的 happy-eyeballs 聚合错误 message 可能为空,需展开 inner errors。 */
function describeError(error: unknown): string {
  const err = error as { message?: string; code?: string; errors?: unknown[] } | undefined;
  const message = typeof err?.message === "string" ? err.message.trim() : "";
  const inner = Array.isArray(err?.errors)
    ? err.errors
      .map((entry) => {
        const item = entry as { code?: string; message?: string } | undefined;
        return item?.code ?? item?.message ?? String(entry);
      })
      .filter((s) => s.length > 0)
      .join(", ")
    : "";
  if (message) return inner ? `${message} (${inner})` : message;
  if (err?.code) return inner ? `${err.code} (${inner})` : err.code;
  if (inner) return inner;
  return String(error);
}

/** 校验 URL 的传输卫生(协议/凭证/localhost/长度/域名白名单),返回解析后的 URL。 */
export function assertFetchableUrl(input: string, allowDomains: string[] = []): URL {
  const raw = input.trim();
  if (!raw) throw new WebToolError("url 不能为空", "invalid_url");
  if (raw.length > MAX_URL_LENGTH) {
    throw new WebToolError(`URL 超过最大长度 ${MAX_URL_LENGTH}`, "invalid_url");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebToolError(`非法 URL: ${raw}`, "invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebToolError(`不支持的协议 ${url.protocol}(仅允许 http/https)`, "invalid_url");
  }
  if (url.username || url.password) {
    throw new WebToolError("URL 不允许内嵌凭证", "blocked_url");
  }
  if (isLocalhostName(url.hostname)) {
    throw new WebToolError(`SSRF 防护:拒绝 localhost 地址 ${url.hostname}`, "blocked_url");
  }
  if (!hostAllowed(url.hostname, allowDomains)) {
    throw new WebToolError(`域名不在白名单: ${url.hostname}`, "blocked_url");
  }
  return url;
}

/** 在失败时也保留可判读的取消原因。 */
function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error("aborted");
}

/** 让不可取消的 DNS 查询可被 deadline 打断。 */
async function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal.reason);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/**
 * 解析 hostname 的全部地址并做公网校验;任一答案非公网即整组拒绝(dsh 策略)。
 * 返回 IPv4 优先的地址集(本机 WSL/容器 v6 连通性常常缺失)。
 */
export async function resolvePublicAddresses(
  hostname: string,
  signal: AbortSignal,
  allowPrivate = false): Promise<LookupAddress[]> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(bare);
  let addresses: LookupAddress[];
  if (literalFamily !== 0) {
    addresses = [{ address: bare, family: literalFamily }];
  } else {
    try {
      addresses = await withSignal(dnsLookup(bare, { all: true, verbatim: true }), signal);
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      throw new WebToolError(`DNS 解析失败 ${bare}: ${describeError(error)}`, "network");
    }
  }
  if (addresses.length === 0) {
    throw new WebToolError(`hostname ${hostname} 无解析结果`, "network");
  }
  if (!allowPrivate) {
    for (const entry of addresses) {
      if (!isPublicIp(entry.address)) {
        throw new WebToolError(
          `SSRF 防护: ${hostname} 解析到非公网地址 ${entry.address}`,
          "blocked_url",
        );
      }
    }
  }
  return [...addresses].sort((a, b) => a.family - b.family);
}

/**
 * 自定义 lookup:连接只使用已经校验过的地址,避免二次解析被 DNS rebinding 换掉。
 * 回调必须**异步**(process.nextTick):`agent: false` 下同步回调会让 https.Agent 在
 * TLSSocket 尚未装配好时同步进 tls.connect,`_handle` 仍是 null → `setServername` 抛
 * TypeError;请求已提前失败返回,而那条半建成的 socket 继续连下去,失败时其 'error'
 * 无人监听 → 进程级 uncaughtException(经验证:web_search 的 DDG 兜底解析到
 * 不可达 IPv6,ENETUNREACH 打死整个 session-worker,同 worker 下的主 agent 与所有子代理
 * 一起收尸)。Node 自带 dns.lookup 本身即异步,这里对齐同一契约。
 * 回归用例:test/web-tool-connect.test.ts。
 */
function pinnedLookup(addresses: LookupAddress[]): (
  hostname: string,
  options: { all?: boolean },
  callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void) => void {
  const primary = addresses.find((a) => a.family === 4) ?? addresses[0];
  return (_hostname, options, callback) => {
    process.nextTick(() => {
      if (!primary) {
        callback(Object.assign(new Error("没有可用地址"), { code: "ENOTFOUND" }), options.all ? [] : "", 4);
        return;
      }
      if (options.all) callback(null, addresses.map((a) => ({ ...a })));
      else callback(null, primary.address, primary.family);
    });
  };
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** 单跳 GET(单地址):字节上限、Content-Length 提前拒绝、流式超限截断、连接阶段预算。 */
async function requestOnce(
  url: URL,
  addresses: LookupAddress[],
  maxBytes: number,
  signal: AbortSignal,
  timeoutMs: number,
  connectTimeoutMs: number): Promise<RawResponse> {
  const lib = url.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    let truncated = false;
    let connected = false;
    let connectTimer: NodeJS.Timeout | undefined;
    let total = 0;
    const chunks: Buffer[] = [];
    const clearConnectTimer = (): void => {
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearConnectTimer();
      if (error === undefined) {
        resolve({
          status,
          headers,
          body: Buffer.concat(chunks, total),
          truncatedByBytes: truncated,
        });
        return;
      }
      // 连接阶段失败标记 phase=connect,供地址回退判断;读阶段失败原样抛。
      if (connected || (error instanceof WebToolError && error.phase === "connect")) reject(error);
      else {
        reject(new WebToolError(
          describeError(error),
          error instanceof WebToolError ? error.code : "network",
          "connect",
        ));
      }
    };
    let status = 0;
    let headers: IncomingHttpHeaders = {};

    // autoSelectFamily 是 Node 20 运行时选项;@types/node 的 RequestOptions 尚未收录,
    // 故整体断言(运行时字段保留)。
    const requestOptions = {
      method: "GET",
      // 单地址连接(IPv4 优先):Node 20 的 autoSelectFamily 在多地址自定义 lookup 下会同时
 // 发起 v4/v6 尝试,本机 v6 不可达时整组 ETIMEDOUT(经验证 iana.org)。地址回退由
      // requestWithAddressFallback 串行完成,仍是「全量答案先校验、连接地址不再解析」。
      autoSelectFamily: false,
      agent: false,
      headers: {
        "user-agent": "lampgenie-harness-web/0.1 (+)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1",
        "accept-encoding": "identity",
      },
      lookup: pinnedLookup(addresses),
      signal,
    } as RequestOptions;
    const req = lib(url, requestOptions, (res) => {
      status = res.statusCode ?? 0;
      headers = res.headers;
      const declared = Number(headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.resume();
        finish(new WebToolError(`响应超过大小上限(${maxBytes} 字节,声明 ${declared} 字节)`, "too_large"));
        return;
      }
      res.on("data", (raw: Buffer | string) => {
        if (settled) return;
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const remaining = maxBytes - total;
        if (chunk.length > remaining) {
          if (remaining > 0) {
            chunks.push(chunk.subarray(0, remaining));
            total = maxBytes;
          }
          truncated = true;
          res.destroy();
          return;
        }
        chunks.push(chunk);
        total += chunk.length;
      });
      res.on("end", () => finish());
      res.on("close", () => {
        if (truncated) finish();
        else finish(new WebToolError("响应在读取完成前中断", "network"));
      });
      res.on("error", (error: Error) => {
        if (truncated) finish();
        else finish(error);
      });
    });
    req.on("socket", (socket) => {
      const markConnected = (): void => {
        connected = true;
        clearConnectTimer();
      };
      const readyEvent = url.protocol === "https:" ? "secureConnect" : "connect";
      if ((socket as { connecting?: boolean }).connecting === false) markConnected();
      else socket.once(readyEvent, markConnected);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new WebToolError(`抓取超时(>${timeoutMs}ms)`, "timeout"));
    });
    req.on("error", (error: Error) => {
      if (truncated) finish();
      else finish(error);
    });
    connectTimer = setTimeout(() => {
      if (connected || settled) return;
      req.destroy(new WebToolError(`连接超时(>${connectTimeoutMs}ms)`, "timeout", "connect"));
    }, connectTimeoutMs);
    connectTimer.unref?.();
    req.end();
  });
}

/**
 * 单地址失败(连接超时/网络不可达)后串行换下一个已校验地址。
 * 只对连接阶段失败回退;已连接后的读错误不重试(避免重复下载)。
 */
async function requestWithAddressFallback(
  url: URL,
  addresses: LookupAddress[],
  maxBytes: number,
  signal: AbortSignal,
  timeoutMs: number,
  deadlineAt: number): Promise<RawResponse> {
  let lastError: unknown;
  const limit = Math.min(addresses.length, 4);
  for (let index = 0; index < limit; index++) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) break;
    const address = addresses[index];
    if (!address) continue;
    try {
      return await requestOnce(
        url,
        [address],
        maxBytes,
        signal,
        timeoutMs,
        Math.min(ADDRESS_CONNECT_TIMEOUT_MS, remaining),
      );
    } catch (error: unknown) {
      lastError = error;
      if (signal.aborted) throw error;
      if (!(error instanceof WebToolError) || error.phase !== "connect") throw error;
    }
  }
  if (lastError !== undefined) throw lastError;
  throw new WebToolError(`抓取超时(>${timeoutMs}ms)`, "timeout");
}

function classifyContentType(contentType: string | undefined): "html" | "text" | undefined {
  const mime = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime.startsWith("text/")) return "text";
  if (
    mime === "application/json" ||
    mime === "application/xml" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  ) return "text";
  return undefined;
}

function parseCharset(contentType: string | undefined): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? "");
  return match?.[1]?.trim().toLowerCase();
}

function decoderFor(charset: string | undefined): TextDecoder {
  try {
    return new TextDecoder(charset ?? "utf-8");
  } catch {
    throw new WebToolError(`不支持的字符集 ${charset}`, "unsupported_content_type");
  }
}

/**
 * 抓取一个公网页面并转换。失败抛 {@link WebToolError};
 * 非 2xx 仍返回正文(与 dsh 一致,状态码由调用方判读)。
 */
export async function fetchPublicPage(input: string, options: WebFetchOptions = {}): Promise<WebFetchOutput> {
  const timeoutMs = options.timeoutMs ?? WEB_FETCH_DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? WEB_FETCH_DEFAULT_MAX_BYTES;
  const maxChars = options.maxChars ?? WEB_FETCH_DEFAULT_MAX_CHARS;
  const maxRedirects = options.maxRedirects ?? WEB_FETCH_DEFAULT_MAX_REDIRECTS;
  const allowDomains = options.allowDomains ?? [];

  const controller = new AbortController();
  let timedOut = false;
  const deadlineAt = Date.now() + timeoutMs;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new WebToolError(`抓取超时(>${timeoutMs}ms)`, "timeout"));
  }, timeoutMs);
  timer.unref?.();
  const external = options.signal;
  const onExternalAbort = (): void => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  const mapError = (error: unknown): Error => {
    // 全局 deadline 先判:abort 可能把连接阶段的错误改写成普通 AbortError,不能误报 network。
    if (timedOut) return new WebToolError(`抓取超时(>${timeoutMs}ms)`, "timeout");
    if (error instanceof WebToolError) return error;
    if (controller.signal.aborted) return new WebToolError("抓取已取消", "aborted");
    return new WebToolError(`网络请求失败: ${describeError(error)}`, "network");
  };

  try {
    let current = assertFetchableUrl(input, allowDomains);
    for (let hop = 0; ; hop++) {
      let addresses: LookupAddress[];
      let response: RawResponse;
      try {
        addresses = options.resolvedAddresses && options.resolvedAddresses.length > 0
          ? options.resolvedAddresses
          : await resolvePublicAddresses(current.hostname, controller.signal, options.allowPrivate);
        response = await requestWithAddressFallback(
          current,
          addresses,
          maxBytes,
          controller.signal,
          timeoutMs,
          deadlineAt);
      } catch (error: unknown) {
        throw mapError(error);
      }

      if (isRedirectStatus(response.status)) {
        const location = response.headers.location;
        if (!location) {
          throw new WebToolError(`重定向响应(HTTP ${response.status})缺少 Location`, "network");
        }
        if (hop >= maxRedirects) {
          throw new WebToolError(`超过最大重定向次数 ${maxRedirects}`, "blocked_url");
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new WebToolError(`非法重定向地址: ${location}`, "invalid_url");
        }
        current = assertFetchableUrl(next.toString(), allowDomains);
        continue;
      }

      const contentType = response.headers["content-type"];
      const kind = classifyContentType(contentType);
      if (!kind) {
        throw new WebToolError(
          `不支持的内容类型 ${contentType ?? "(缺失)"}(仅支持 text/*、html、json、xml)`,
          "unsupported_content_type",
        );
      }
      const charset = parseCharset(contentType);
      let text: string;
      try {
        text = decoderFor(charset).decode(response.body);
      } catch (error: unknown) {
        throw mapError(error);
      }
      const title = kind === "html" ? extractHtmlTitle(text) : "";
      let content = kind === "html" ? htmlToMarkdown(text, current.toString()) : text;
      const truncatedByChars = content.length > maxChars;
      if (truncatedByChars) {
        content = content.slice(0, maxChars)
          + `\n\n...(内容已截断:原文 ${content.length} 字符,已保留前 ${maxChars} 字符。可抓取更具体的 URL/锚点获取剩余内容)`;
      }
      const result: WebFetchOutput = {
        url: input,
        finalUrl: current.toString(),
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        title,
        contentType: String(contentType ?? ""),
        bytes: response.body.length,
        length: content.length,
        truncated: response.truncatedByBytes || truncatedByChars,
        content,
      };
      if (response.truncatedByBytes && truncatedByChars) result.truncatedBy = "bytes";
      else if (response.truncatedByBytes) result.truncatedBy = "bytes";
      else if (truncatedByChars) result.truncatedBy = "chars";
      return result;
    }
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}

// ---------------------------------------------------------------------------
// HTML → markdown(零依赖;保留标题层级/链接/列表/代码块/表格行)
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™",
  laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  times: "×", divide: "÷", middot: "·", bull: "•", deg: "°", plusmn: "±",
  euro: "€", pound: "£", yen: "¥", sect: "§", para: "¶", dagger: "†",
};

function codePointToString(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** 实体解码(命名基础集 + 十进制/十六进制数字实体)。 */
export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => codePointToString(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => codePointToString(parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

function collapseInline(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, " ");
}

/** 解析链接目标(相对路径按页面 URL 补全;javascript/data 等丢弃)。 */
function resolveLink(href: string, baseUrl: string): string | null {
  const decoded = decodeHtmlEntities(href).trim();
  if (!decoded || /^(javascript|data|vbscript):/i.test(decoded)) return null;
  try {
    const url = new URL(decoded, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** 提取 <title> 文本(解码 + 空白归一 + 300 字符上限)。 */
export function extractHtmlTitle(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!match) return "";
  return collapseInline(decodeHtmlEntities(stripTags(match[1] ?? ""))).slice(0, 300);
}

/**
 * HTML → markdown。策略:先移除不可见内容,pre 块先占位,再按块级/语义标签改写,
 * 最后统一剥标签、解实体、归一空白并还原代码块。
 */
export function htmlToMarkdown(html: string, baseUrl = "https://example.invalid/"): string {
  const preBlocks: string[] = [];
  let s = html.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, " ");
  s = s.replace(
    /<(script|style|noscript|template|svg|canvas|iframe|object|embed|video|audio|select|textarea|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    " ",
  );
  s = s.replace(
    /<\/?(script|style|noscript|template|svg|canvas|iframe|object|embed|video|audio|select|textarea|button)\b[^>]*>/gi,
    " ",
  );

  // 代码块先占位,避免空白归一破坏缩进/换行
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_match, inner: string) => {
    const code = decodeHtmlEntities(
      inner.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""),
    ).replace(/^\n+|\n+$/g, "");
    preBlocks.push("```\n" + code + "\n```");
    return `\n\n@@WEB_PRE_${preBlocks.length - 1}@@\n\n`;
  });

  // 链接(文字保留,目标解析为绝对地址)
  s = s.replace(
    /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_match, dq: string | undefined, sq: string | undefined, bare: string | undefined, text: string) => {
      const label = collapseInline(stripTags(text));
      const href = resolveLink(String(dq ?? sq ?? bare ?? ""), baseUrl);
      if (!label) return href ?? "";
      return href ? `[${label}](${href})` : label;
    },
  );
  // 图片:仅保留 alt 文本,避免长 URL 噪音
  s = s.replace(
    /<img\b[^>]*alt\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi,
    (_match, dq: string | undefined, sq: string | undefined) => ` ${dq ?? sq ?? ""} `,
  );
  s = s.replace(/<img\b[^>]*>/gi, " ");

  // 标题层级
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_match, level: string, text: string) => {
    const body = collapseInline(stripTags(text));
    return body ? `\n\n${"#".repeat(Number(level))} ${body}\n\n` : "\n\n";
  });

  // 行内代码/加粗
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_match, text: string) => {
    const body = collapseInline(decodeHtmlEntities(stripTags(text)));
    return body ? "`" + body.replace(/`/g, "'") + "`" : "";
  });
  s = s.replace(/<\/?(strong|b)\b[^>]*>/gi, "**");

  // 列表/表格
  s = s.replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/li\s*>/gi, "\n");
  s = s.replace(/<\/(td|th)\s*>/gi, " | ").replace(/<tr\b[^>]*>/gi, "\n").replace(/<\/tr\s*>/gi, "\n");
  s = s.replace(/<br\b[^>]*>/gi, "\n");
  s = s.replace(/<hr\b[^>]*>/gi, "\n\n---\n\n");

  // 块边界
  s = s.replace(
    /<\/?(p|div|section|article|header|footer|main|nav|aside|blockquote|figure|figcaption|dl|dt|dd|ul|ol|table|thead|tbody|tfoot|fieldset)\b[^>]*>/gi,
    "\n\n",
  );
  // 其余标签剥离
  s = s.replace(/<[^>]*>/g, " ");
  s = decodeHtmlEntities(s);
  const lines = s.split(/\r?\n/).map((line) => line.replace(/[ \t\f\v]+/g, " ").trim());
  s = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  s = s.replace(/@@WEB_PRE_(\d+)@@/g, (_match, index: string) => preBlocks[Number(index)] ?? "");
  return s.trim();
}

// ---------------------------------------------------------------------------
// web_search:provider 抽象(exa / perplexity / deepseek / custom)
// ---------------------------------------------------------------------------

export type SearchProviderId = "exa" | "perplexity" | "deepseek" | "custom";

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProviderConfig {
  id: SearchProviderId;
  key: string;
  endpoint: string;
  model?: string;
}

export type SearchProviderResolution =
  | { ok: true; config: SearchProviderConfig }
  | { ok: false; error: string };

const SEARCH_ENV_HELP =
  "设置 GENIE_WEB_SEARCH_PROVIDER=exa|perplexity|deepseek|custom 并提供对应 key"
  + "(EXA_API_KEY / PERPLEXITY_API_KEY / DEEPSEEK_API_KEY,或通用 GENIE_WEB_SEARCH_KEY);"
  + "custom 还需 GENIE_WEB_SEARCH_ENDPOINT(返回 JSON 结果列表)。";

function joinEndpoint(base: string, operation: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith(operation) ? trimmed : trimmed + operation;
}

/** 从 env 解析搜索 provider(显式配置优先;否则按 key/endpoint 自动探测)。 */
export function resolveSearchProvider(env: NodeJS.ProcessEnv = process.env): SearchProviderResolution {
  const genericKey = envText(env, "GENIE_WEB_SEARCH_KEY");
  const keyFor = (specific: string): string => envText(env, specific) || genericKey;
  const endpointOverride = envText(env, "GENIE_WEB_SEARCH_ENDPOINT");
  const model = envText(env, "GENIE_WEB_SEARCH_MODEL") || undefined;
  const explicit = envText(env, "GENIE_WEB_SEARCH_PROVIDER").toLowerCase();
  const exaKey = keyFor("EXA_API_KEY");
  const perplexityKey = keyFor("PERPLEXITY_API_KEY");
  const deepseekKey = keyFor("DEEPSEEK_API_KEY");
  const customEndpoint = endpointOverride;

  const build = (id: SearchProviderId): SearchProviderResolution => {
    if (id === "exa") {
      if (!exaKey) return { ok: false, error: `provider=exa 缺少 key:设置 EXA_API_KEY 或 GENIE_WEB_SEARCH_KEY。` };
      return { ok: true, config: { id, key: exaKey, endpoint: joinEndpoint(endpointOverride || "https://api.exa.ai", "/search"), ...(model ? { model } : {}) } };
    }
    if (id === "perplexity") {
      if (!perplexityKey) return { ok: false, error: `provider=perplexity 缺少 key:设置 PERPLEXITY_API_KEY 或 GENIE_WEB_SEARCH_KEY。` };
      return { ok: true, config: { id, key: perplexityKey, endpoint: joinEndpoint(endpointOverride || "https://api.perplexity.ai", "/chat/completions"), ...(model ? { model } : {}) } };
    }
    if (id === "deepseek") {
      if (!deepseekKey) return { ok: false, error: `provider=deepseek 缺少 key:设置 DEEPSEEK_API_KEY 或 GENIE_WEB_SEARCH_KEY。` };
      return { ok: true, config: { id, key: deepseekKey, endpoint: joinEndpoint(endpointOverride || "https://api.deepseek.com/anthropic/v1", "/messages"), ...(model ? { model } : {}) } };
    }
    if (!customEndpoint) {
      return { ok: false, error: "provider=custom 需要 GENIE_WEB_SEARCH_ENDPOINT。" };
    }
    return {
      ok: true,
      config: {
        id: "custom",
        key: genericKey,
        endpoint: customEndpoint,
        ...(model ? { model } : {}),
      },
    };
  };

  if (explicit) {
    if (explicit !== "exa" && explicit !== "perplexity" && explicit !== "deepseek" && explicit !== "custom") {
      return { ok: false, error: `未知的 search provider "${explicit}"(只支持 exa|perplexity|deepseek|custom)。` };
    }
    return build(explicit);
  }
  if (exaKey) return build("exa");
  if (perplexityKey) return build("perplexity");
  if (deepseekKey) return build("deepseek");
  if (customEndpoint) return build("custom");
  return { ok: false, error: `web_search 未配置搜索 provider。${SEARCH_ENV_HELP}` };
}

/** web.search 配置块的面(工具提供商默认 DeepSeek)。 */
export interface WebSearchConfigLike {
  provider?: string;
  apiKeyEnv?: string;
  endpoint?: string;
  model?: string;
  disabled?: boolean;
}

export const DEFAULT_SEARCH_PROVIDER: SearchProviderId = "deepseek";
export const DEFAULT_SEARCH_KEY_ENV = "DEEPSEEK_API_KEY";

/** 把「设置页 web.search + providers[] + 密钥读取器」翻译成运行时 provider 参数
 * (默认 deepseek;没填则用 curl/browser 替代)。
 * 提取成纯函数的原因:默认态语义要单测,而它不是 env 解析也不是 HTTP 调用。
 * - disabled=true → null(强制走内置静态检索/browser,即便有密钥)
 * - provider 缺省 → 按 deepseek;密钥引用名取 providers[] 里 id=deepseek 的 apiKeyEnv,
 *   再退 apiKeyEnv 设置、再退 DEEPSEEK_API_KEY。
 * - 取不到密钥 → null(落到 DDG 静态检索 + browser 指路,不静默换 provider)。 */
export function resolveSearchRuntimeFromConfig(
  web: WebSearchConfigLike | null,
  providers: { id: string; apiKeyEnv?: string }[],
  readSecret: (name: string) => string | undefined): { provider: string; apiKey?: string; endpoint?: string; model?: string } | null {
  if (web && web.disabled === true) return null;
  const explicit = String(web?.provider ?? "").trim().toLowerCase();
  const provider = explicit || DEFAULT_SEARCH_PROVIDER;
  const isDefault = !explicit;
  const providerKeyEnv = providers.find((p) => p.id.toLowerCase() === provider)?.apiKeyEnv;
  const keyName = isDefault
    ? providerKeyEnv || web?.apiKeyEnv || DEFAULT_SEARCH_KEY_ENV
    : web?.apiKeyEnv || providerKeyEnv || "GENIE_WEB_SEARCH_KEY";
  const apiKey = readSecret(keyName) ?? readSecret("GENIE_WEB_SEARCH_KEY");
  if (!apiKey) return null;
  return {
    provider,
    apiKey,
    ...(web?.endpoint ? { endpoint: web.endpoint } : {}),
    ...(web?.model ? { model: web.model } : {}),
  };
}

/** 配置层优先的 provider 解析:genie.config.json 的 web.search 在场时
 * 直接构造(「有提供搜索工具时直接用搜索工具」),env 只作回退。key 由调用方从 secrets/env
 * 解析好传入(本模块不读密钥文件)。 */
export function resolveSearchProviderWithRuntime(
  env: NodeJS.ProcessEnv,
  runtime: { provider: string; apiKey?: string; endpoint?: string; model?: string } | null): SearchProviderResolution {
  if (runtime && runtime.provider && runtime.apiKey) {
    const id = runtime.provider.toLowerCase() as SearchProviderId;
    if (id === "exa" || id === "perplexity" || id === "deepseek" || id === "custom") {
      const endpoint = runtime.endpoint
        || (id === "exa" ? "https://api.exa.ai"
          : id === "perplexity" ? "https://api.perplexity.ai"
          : id === "deepseek" ? "https://api.deepseek.com/anthropic/v1"
          : "");
      if (id === "custom" && !endpoint) return { ok: false, error: "provider=custom 需要 endpoint(设置页或配置 web.search.endpoint)。" };
      return {
        ok: true,
        config: {
          id,
          key: runtime.apiKey,
          endpoint: joinEndpoint(endpoint, id === "exa" ? "/search" : id === "perplexity" ? "/chat/completions" : id === "deepseek" ? "/messages" : ""),
          ...(runtime.model ? { model: runtime.model } : {}),
        },
      };
    }
    return { ok: false, error: `web.search.provider「${runtime.provider}」不识别(可选 exa|perplexity|deepseek|custom)。` };
  }
  return resolveSearchProvider(env);
}

/** 内置静态检索兜底:无 provider 时用自身 HTTP 能力查 DuckDuckGo HTML 版
 * (无 JS、结构稳定)并解析结果。「没有提供搜索工具时使用自身的 curl/browser 能力」的 curl 侧;
 * browser 侧由 agent 直接调 browser 工具(工具面在场,web_search 失败文案里显式指路)。 */
export async function searchViaDdgHtml(
  query: string,
  opts: { timeoutMs?: number; allowDomains?: string[]; signal?: AbortSignal } = {},
): Promise<{ results: SearchResultItem[]; truncated: boolean }> {
  const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  const page = await fetchPublicPage(url, {
    timeoutMs: opts.timeoutMs ?? WEB_SEARCH_DEFAULT_TIMEOUT_MS,
    maxBytes: WEB_FETCH_DEFAULT_MAX_BYTES,
    maxChars: 60_000,
    maxRedirects: 3,
    allowDomains: opts.allowDomains,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const results: SearchResultItem[] = [];
  // DDG html 版结构:<a class="result__a" href="…">标题</a> … <a class="result__snippet" …>摘要</a>
  // href 可能是 /l/?uddg=<编码目标>(跳转包装),解出真实 URL;解析失败的原样保留。
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  for (let m = snippetRe.exec(page.content); m && snippets.length < 30; m = snippetRe.exec(page.content)) {
    snippets.push(stripTags(m[1] ?? ""));
  }
  let idx = 0;
  for (let m = re.exec(page.content); m && results.length < WEB_SEARCH_MAX_RESULTS; m = re.exec(page.content)) {
    let href = decodeHtmlEntities(m[1] ?? "");
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) { try { href = decodeURIComponent(uddg[1]!); } catch { /* 原样 */ } }
    if (!/^https?:\/\//i.test(href)) continue;
    results.push({
      title: collapseInline(decodeHtmlEntities(stripTags(m[2] ?? ""))).slice(0, 200),
      url: href,
      snippet: collapseInline(decodeHtmlEntities(stripTags(snippets[idx] ?? ""))).slice(0, 400),
    });
    idx++;
  }
  return { results, truncated: page.truncated };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function httpUrl(value: unknown): string {
  const url = asString(value);
  return /^https?:\/\//i.test(url) ? url : "";
}

function dedupeResults(items: SearchResultItem[]): SearchResultItem[] {
  const seen = new Set<string>();
  const out: SearchResultItem[] = [];
  for (const item of items) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    // 单条有界:custom provider 可能返回整页正文,防止工具结果失控。
    out.push({
      title: item.title.slice(0, 300),
      url: item.url.slice(0, MAX_URL_LENGTH),
      snippet: item.snippet.slice(0, 1000),
    });
  }
  return out;
}

/** Exa:results[].highlights[] 取首个非空作为 snippet。 */
export function mapExaPayload(payload: unknown): { results: SearchResultItem[]; answer?: string } {
  const root = asRecord(payload);
  const rows = Array.isArray(root?.results) ? root.results : [];
  const results: SearchResultItem[] = [];
  for (const row of rows) {
    const item = asRecord(row);
    if (!item) continue;
    const url = httpUrl(item.url);
    if (!url) continue;
    const highlights = Array.isArray(item.highlights) ? item.highlights : [];
    const snippet = highlights.map(asString).find((s) => s.length > 0) ?? "";
    results.push({ title: asString(item.title), url, snippet });
  }
  return { results: dedupeResults(results) };
}

/** Perplexity:search_results[] 优先,citations[] 兜底;answer=choices[0].message.content。 */
export function mapPerplexityPayload(payload: unknown): { results: SearchResultItem[]; answer?: string } {
  const root = asRecord(payload);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  const answer = asString(message?.content);
  const results: SearchResultItem[] = [];
  if (Array.isArray(root?.search_results)) {
    for (const row of root.search_results) {
      const item = asRecord(row);
      if (!item) continue;
      const url = httpUrl(item.url);
      if (!url) continue;
      results.push({
        title: asString(item.title),
        url,
        snippet: asString(item.snippet) || asString(item.description),
      });
    }
  } else if (Array.isArray(root?.citations)) {
    for (const row of root.citations) {
      const url = httpUrl(row);
      if (!url) continue;
      results.push({ title: "", url, snippet: "" });
    }
  }
  return {
    results: dedupeResults(results),
    ...(answer ? { answer } : {}),
  };
}

/** DeepSeek(Anthropic 兼容 web_search 服务端工具):结果块 + text 块 citations 拼 snippet。 */
export function mapDeepseekPayload(payload: unknown): { results: SearchResultItem[]; answer?: string } {
  const root = asRecord(payload);
  const blocks = Array.isArray(root?.content) ? root.content : [];
  const snippets = new Map<string, string>();
  const answerParts: string[] = [];
  for (const raw of blocks) {
    const block = asRecord(raw);
    if (!block) continue;
    if (block.type === "text") {
      const text = asString(block.text);
      if (text) answerParts.push(text);
      const citations = Array.isArray(block.citations) ? block.citations : [];
      for (const rawCitation of citations) {
        const citation = asRecord(rawCitation);
        if (!citation) continue;
        const url = httpUrl(citation.url);
        const cited = asString(citation.cited_text);
        if (url && cited && !snippets.has(url)) snippets.set(url, cited);
      }
    }
  }
  const results: SearchResultItem[] = [];
  for (const raw of blocks) {
    const block = asRecord(raw);
    if (!block || block.type !== "web_search_tool_result") continue;
    const items = Array.isArray(block.content) ? block.content : [];
    for (const rawItem of items) {
      const item = asRecord(rawItem);
      if (!item || item.type !== "web_search_result") continue;
      const url = httpUrl(item.url);
      if (!url) continue;
      results.push({
        title: asString(item.title),
        url,
        snippet: snippets.get(url) ?? "",
      });
    }
  }
  const answer = answerParts.join("\n").slice(0, 4000);
  return {
    results: dedupeResults(results),
    ...(answer ? { answer } : {}),
  };
}

/** 自定义 endpoint:兼容 results/data/items/sources 数组与根数组。 */
export function mapCustomPayload(payload: unknown): { results: SearchResultItem[]; answer?: string } {
  const root = asRecord(payload);
  let rows: unknown[] = Array.isArray(payload) ? payload : [];
  if (rows.length === 0 && root) {
    for (const key of ["results", "data", "items", "sources", "web_results"]) {
      if (Array.isArray(root[key])) {
        rows = root[key];
        break;
      }
    }
  }
  const results: SearchResultItem[] = [];
  for (const row of rows) {
    const item = asRecord(row);
    if (!item) continue;
    const url = httpUrl(item.url ?? item.link ?? item.href);
    if (!url) continue;
    results.push({
      title: asString(item.title ?? item.name ?? item.label),
      url,
      snippet: asString(item.snippet ?? item.description ?? item.content ?? item.text ?? item.summary),
    });
  }
  const answer = asString(root?.answer ?? root?.summary);
  return {
    results: dedupeResults(results),
    ...(answer ? { answer } : {}),
  };
}

interface SearchHttpOptions {
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** 搜索 API 的 POST JSON:超时/取消/HTTP 错误 fail-visible,错误体截断且不含 key。 */
async function postJson(options: SearchHttpOptions): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  timer.unref?.();
  const onAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    let response: Response;
    try {
      response = await fetch(options.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "user-agent": "lampgenie-harness-web/0.1 (+)",
          ...options.headers,
        },
        body: JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (timedOut) throw new WebToolError(`搜索超时(>${options.timeoutMs}ms)`, "timeout");
      if (controller.signal.aborted) throw new WebToolError("搜索已取消", "aborted");
      throw new WebToolError(`搜索请求失败: ${describeError(error)}`, "network");
    }
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 500);
      try {
        const parsed = asRecord(JSON.parse(text));
        const nested = asRecord(parsed?.error);
        detail = asString(nested?.message) || asString(parsed?.error) || asString(parsed?.message) || detail;
      } catch {
        // 非 JSON 错误体:保留截断原文
      }
      throw new WebToolError(`搜索 API HTTP ${response.status}: ${detail.slice(0, 500)}`, "http_error");
    }
    if (text.length > 2 * 1024 * 1024) {
      throw new WebToolError("搜索响应超过 2MB 上限", "too_large");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new WebToolError("搜索 API 返回体不是 JSON", "bad_response");
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** 执行一次搜索(provider 分发 + 结果截断)。 */
export async function runWebSearch(
  query: string,
  options: {
    provider: SearchProviderConfig;
    maxResults: number;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<{ results: SearchResultItem[]; answer?: string; truncated: boolean }> {
  const { provider, maxResults, timeoutMs, signal } = options;
  const auth: Record<string, string> = provider.key ? { authorization: `Bearer ${provider.key}` } : {};
  let mapped: { results: SearchResultItem[]; answer?: string };
  if (provider.id === "exa") {
    const payload = await postJson({
      endpoint: provider.endpoint,
      headers: auth,
      body: {
        query,
        type: "auto",
        numResults: maxResults,
        contents: { highlights: { highlightsPerUrl: 1 } },
      },
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    mapped = mapExaPayload(payload);
  } else if (provider.id === "perplexity") {
    const payload = await postJson({
      endpoint: provider.endpoint,
      headers: auth,
      body: {
        model: provider.model ?? "sonar",
        max_tokens: 1024,
        messages: [{ role: "user", content: query }],
      },
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    mapped = mapPerplexityPayload(payload);
  } else if (provider.id === "deepseek") {
    const payload = await postJson({
      endpoint: provider.endpoint,
      headers: {
        ...auth,
        "x-api-key": provider.key,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: provider.model ?? "deepseek-v4-flash",
        max_tokens: 4096,
        messages: [{ role: "user", content: [{ type: "text", text: `Perform a web search for the query: ${query}` }] }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      },
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    mapped = mapDeepseekPayload(payload);
  } else {
    const payload = await postJson({
      endpoint: provider.endpoint,
      headers: auth,
      body: { query, max_results: maxResults },
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    mapped = mapCustomPayload(payload);
  }
  const truncated = mapped.results.length > maxResults;
  return {
    results: mapped.results.slice(0, maxResults),
    ...(mapped.answer ? { answer: mapped.answer } : {}),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/** web_fetch 工具(静态抓取;只读)。 */
export function createWebFetchTool(config: WebToolConfig = {}): Tool {
  const env = (): NodeJS.ProcessEnv => config.env ?? process.env;
  // 域名策略单一来源:优先 browser 的 allowDomains(面板可热改);为空(全允许)时再看 env CSV。
  const allowDomains = (): string[] => {
    const fromConfig = config.allowDomains?.() ?? [];
    return fromConfig.length > 0 ? fromConfig : envCsv(env(), "GENIE_WEB_ALLOW_DOMAINS");
  };
  return {
    name: "web_fetch",
    description:
      "抓取一个公网 HTTP(S) 页面并返回结构化结果(url/finalUrl/status/title/length/truncated/content)。"
      + "content 为 HTML 转换的 markdown(保留标题层级/链接/列表/代码块)或纯文本。只读、静态抓取:"
      + "适合文档/README/文章/API 说明;需要登录、点击、JS 动态渲染或截图时改用 browser 工具。"
      + "拒绝内网/本地地址(SSRF 防护),有大小/超时/重定向/内容类型/域名白名单约束。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "要抓取的公网 http/https URL" },
      },
      required: ["url"],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(args: unknown, signal?: AbortSignal) {
      const a = (args ?? {}) as { url?: unknown };
      const url = String(a.url ?? "").trim();
      if (!url) return "错误: web_fetch 需要 url";
      try {
        const output = await fetchPublicPage(url, {
          timeoutMs: config.fetchTimeoutMs ?? envInt(env(), "GENIE_WEB_FETCH_TIMEOUT_MS", WEB_FETCH_DEFAULT_TIMEOUT_MS),
          maxBytes: config.maxResponseBytes ?? envInt(env(), "GENIE_WEB_FETCH_MAX_BYTES", WEB_FETCH_DEFAULT_MAX_BYTES),
          maxChars: config.maxContentChars ?? envInt(env(), "GENIE_WEB_FETCH_MAX_CHARS", WEB_FETCH_DEFAULT_MAX_CHARS),
          maxRedirects: envInt(env(), "GENIE_WEB_FETCH_MAX_REDIRECTS", WEB_FETCH_DEFAULT_MAX_REDIRECTS),
          allowDomains: allowDomains(),
          ...(signal ? { signal } : {}),
        });
 // browser 渲染兜底:静态抓取成功但正文近空(典型=SPA/JS 渲染页,HTML 里
        // 只剩脚本壳)时,若接了 browser 工具则真实渲染取正文——「没有提供时用自身 browser 能力」。
        if (config.browserFetch && String(output.content ?? "").trim().length < 200) {
          try {
            const rendered = await config.browserFetch(url);
            if (rendered.ok && rendered.text.trim().length > Math.max(200, String(output.content ?? "").trim().length)) {
              return JSON.stringify({
                ...output,
                content: rendered.text.slice(0, WEB_FETCH_DEFAULT_MAX_CHARS),
                length: rendered.text.length,
                title: rendered.title || output.title,
                via: "browser-render",
                note: "静态抓取正文近空(JS 渲染页),已用 browser 工具真实渲染取正文",
              });
            }
          } catch { /* 渲染兜底失败:回退到静态结果,静态内容对 agent 仍可判读 */ }
        }
        return JSON.stringify(output);
      } catch (error: unknown) {
        // 抓取失败(超时/域名/类型等)时,browser 兜底是最后一条自身能力;失败原因如实带回。
        if (config.browserFetch) {
          try {
            const rendered = await config.browserFetch(url);
            if (rendered.ok) {
              return JSON.stringify({
                url,
                finalUrl: url,
                status: 0,
                title: rendered.title,
                length: rendered.text.length,
                truncated: rendered.text.length > WEB_FETCH_DEFAULT_MAX_CHARS,
                content: rendered.text.slice(0, WEB_FETCH_DEFAULT_MAX_CHARS),
                via: "browser-render",
                note: `静态抓取失败(${error instanceof Error ? error.message : String(error)}),已用 browser 工具渲染兜底`,
              });
            }
          } catch { /* 双路皆败:落到原始错误 */ }
        }
        return `错误: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

/** web_search 工具(检索;只读。三层降级:配置的搜索 API → env provider → 内置静态检索)。 */
export function createWebSearchTool(config: WebToolConfig = {}): Tool {
  const env = (): NodeJS.ProcessEnv => config.env ?? process.env;
  const allowDomains = (): string[] => {
    const fromConfig = config.allowDomains?.() ?? [];
    return fromConfig.length > 0 ? fromConfig : envCsv(env(), "GENIE_WEB_ALLOW_DOMAINS");
  };
  return {
    name: "web_search",
    description:
      "检索公网信息,返回 [{title,url,snippet}] 列表(可带 provider 生成的 answer)。"
      + "默认用 DeepSeek 搜索(设置-模型设置-工具提供商里可换 exa/perplexity/自定义或关闭);"
      + "取不到密钥或调用失败时自动降级为内置静态检索(curl 等价:DuckDuckGo HTML,结果质量有限且可能被限流,"
      + "provider 字段如实标注 fallback),再失败指路 browser 工具。"
      + "命中结果需要打开页面时用 web_fetch(静态正文/JS 页自动 browser 渲染),"
      + "需要登录/点击等交互时用 browser。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索查询(一句话/关键词)" },
        max_results: { type: "number", description: `返回结果数(1-${WEB_SEARCH_MAX_RESULTS},缺省 ${WEB_SEARCH_DEFAULT_MAX_RESULTS})` },
      },
      required: ["query"],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(args: unknown, signal?: AbortSignal) {
      const a = (args ?? {}) as { query?: unknown; max_results?: unknown };
      const query = String(a.query ?? "").trim();
      if (!query) return "错误: web_search 需要 query";
      // 配置层优先(设置页写入的 web.search),env 回退,两者皆无=静态检索兜底。
      const runtime = config.searchRuntime ? config.searchRuntime() : null;
      const resolution = resolveSearchProviderWithRuntime(env(), runtime);
      const configuredMax = config.maxResults ?? envInt(env(), "GENIE_WEB_SEARCH_MAX_RESULTS", WEB_SEARCH_DEFAULT_MAX_RESULTS);
      const requested = Number(a.max_results ?? configuredMax);
      const maxResults = Math.min(
        Math.max(Number.isFinite(requested) ? Math.floor(requested) : configuredMax, 1),
        WEB_SEARCH_MAX_RESULTS);
      if (!resolution.ok) {
        // 无任何 provider:自身能力兜底——先静态检索(等价 curl),失败指路 browser 工具。
        try {
          const fallback = await searchViaDdgHtml(query, {
            timeoutMs: config.searchTimeoutMs ?? envInt(env(), "GENIE_WEB_SEARCH_TIMEOUT_MS", WEB_SEARCH_DEFAULT_TIMEOUT_MS),
            allowDomains: allowDomains(),
            ...(signal ? { signal } : {}),
          });
          if (fallback.results.length > 0) {
            return JSON.stringify({
              provider: "fallback:duckduckgo-html",
              query,
              count: fallback.results.length,
              truncated: fallback.truncated,
              results: fallback.results.slice(0, maxResults),
              note: "未配置搜索密钥或已关闭搜索 API,已用内置静态检索(DuckDuckGo HTML / curl 等价)兜底;"
                + "在「设置-模型设置-工具提供商」里选 DeepSeek 并填 Key 可获得更稳定结果——" + SEARCH_ENV_HELP,
            });
          }
          return `错误: 内置静态检索无结果(可能被限流)。${resolution.error}。也可用 browser 工具直接打开搜索引擎页交互检索`;
        } catch (error: unknown) {
          return `错误: 内置静态检索失败(${error instanceof Error ? error.message : String(error)})。${resolution.error}。可用 browser 工具直接打开搜索引擎页`;
        }
      }
      try {
        const output = await runWebSearch(query, {
          provider: resolution.config,
          maxResults,
          timeoutMs: config.searchTimeoutMs ?? envInt(env(), "GENIE_WEB_SEARCH_TIMEOUT_MS", WEB_SEARCH_DEFAULT_TIMEOUT_MS),
          ...(signal ? { signal } : {}),
        });
        return JSON.stringify({
          provider: resolution.config.id,
          query,
          count: output.results.length,
          truncated: output.truncated,
          ...(output.answer ? { answer: output.answer } : {}),
          results: output.results,
        });
      } catch (error: unknown) {
        // provider 存在但调用失败(欠费/端点不支持/网络):不直接死路,退到 curl 等价静态检索,
        // 把原始错误如实写进 note(不静默吞掉,agent 能看到 provider 侧为何失败)。
        const reason = error instanceof Error ? error.message : String(error);
        try {
          const fallback = await searchViaDdgHtml(query, {
            timeoutMs: config.searchTimeoutMs ?? envInt(env(), "GENIE_WEB_SEARCH_TIMEOUT_MS", WEB_SEARCH_DEFAULT_TIMEOUT_MS),
            allowDomains: allowDomains(),
            ...(signal ? { signal } : {}),
          });
          if (fallback.results.length > 0) {
            return JSON.stringify({
              provider: "fallback:duckduckgo-html",
              query,
              count: fallback.results.length,
              truncated: fallback.truncated,
              results: fallback.results.slice(0, maxResults),
              note: `${resolution.config.id} 搜索调用失败(${reason.slice(0, 200)}),已改用内置静态检索(curl 等价)兜底;`
                + "需要登录/JS 页面时用 browser 工具。",
            });
          }
        } catch { /* 双路皆败:下面如用户反馈 provider 原始错误 */ }
        return `错误: ${reason}`
          + `(可用「设置-模型设置-工具提供商」检查 ${resolution.config.id} 的 Key/端点,或改用 terminal 执行 curl、browser 工具直接检索)`;
      }
    },
  };
}

/** 两工具一起创建(agent-wiring 单点挂载)。 */
export function createWebTools(config: WebToolConfig = {}): Tool[] {
  return [createWebFetchTool(config), createWebSearchTool(config)];
}
