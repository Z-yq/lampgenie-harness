/**
 * 移动端远程控制(原「节点 Fleet」改为图例里的远程控制)。
 * 形态:面板生成一次性配对 token + 二维码,手机打开 `<gateway>/m?pair=<token>` 进入
 * 独立移动端控制台;WS 升级请求带同一 token 才被标记为「手机已连接」。不引入 ZCode 的
 * 外部 Relay V2 云链路——gateway 自身就是可达端点,`GENIE_PUBLIC_HOST` 负责公网/域名场景。
 * 红线:
 * - token 只出现在连接链接/状态回包里,不落 journal、不打日志;
 * - verifyToken 用 timingSafeEqual,长度不同直接拒;
 * - 配对过期且无在线手机时回收;有手机在线时不断线(避免长任务中途断控)。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as os from "node:os";
import qrcode from "qrcode-generator";
import { pickLanAddress, type IfaceAddr } from "./remote-wizard.js";

export type RemoteControlState = "idle" | "waiting" | "connected";

export interface RemoteControlStatus {
  state: RemoteControlState;
 /** 手机打开的控制台地址(含一次性 token;只回可信面板)。 */
  connectUrl?: string;
 /** 二维码 SVG(白底由面板卡片提供)。 */
  qrSvg?: string;
  createdAt?: number;
  expiresAt?: number;
 /** 当前在线手机连接数。 */
  clients: number;
 /** 对外地址推导出的 host(面板可显示,便于排查)。 */
  host?: string;
 /** 不可用/降级提示(如仅 127.0.0.1,手机不可达)。 */
  warning?: string;
 /** 刚刚过期回收(面板显示「配对已过期」)。 */
  expired?: boolean;
}

export interface PublicHost {
  host: string;
  port: number;
  scheme: "http" | "https";
  warning?: string;
}

/** 本机网卡快照(app 层也用它做向导地址;测试可注入)。 */
export function networkIfaces(): IfaceAddr[] {
  return Object.entries(os.networkInterfaces()).flatMap(([name, addrs]) =>
    (addrs ?? []).map((a) => ({ name, address: a.address, internal: a.internal, family: String(a.family) })),
  );
}

/**
 * 对外地址推导。优先级:GENIE_PUBLIC_HOST(可带 scheme/端口) > 本机私网 IPv4 > 127.0.0.1。
 * 返回的 host 不带方括号;IPv6 在拼 URL 时补方括号。
 */
export function resolvePublicHost(envHost: string | undefined, ifaces: IfaceAddr[], port: number): PublicHost {
  const raw = String(envHost ?? "").trim();
  if (raw) {
    if (/^https?:\/\//i.test(raw)) {
      try {
        const u = new URL(raw);
        const scheme = u.protocol === "https:" ? "https" : "http";
        return {
          host: u.hostname.replace(/^\[|\]$/g, ""),
          port: u.port ? Number(u.port) : scheme === "https" ? 443 : 80,
          scheme,
        };
      } catch {
 // 非法 URL 回退 host 语义(不因环境变量写错把远程控制整个不可用)
      }
    }
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw);
    if (v6 && v6[1]) return { host: v6[1], port: v6[2] ? Number(v6[2]) : port, scheme: "http" };
    const m = /^([^:]+)(?::(\d+))?$/.exec(raw);
    if (m && m[1]) return { host: m[1], port: m[2] ? Number(m[2]) : port, scheme: "http" };
 // 带方括号但没匹配上:去掉括号当纯 host
    const bare = raw.replace(/^\[|\]$/g, "");
    if (bare) return { host: bare, port, scheme: "http" };
  }
  const host = pickLanAddress(ifaces);
  return {
    host,
    port,
    scheme: "http",
    ...(host === "127.0.0.1"
      ? { warning: "未检测到局域网地址:手机无法直接访问本机,请设置 GENIE_PUBLIC_HOST(公网域名/隧道地址)后重试" }
      : {}),
  };
}

/** host 拼 URL:IPv6 必须加方括号。 */
export function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** 控制台链接(默认端口省略:80/443;其它显式带端口)。 */
export function buildConnectUrl(base: PublicHost, token: string): string {
  const defaultPort = base.scheme === "https" ? 443 : 80;
  const portPart = base.port && base.port !== defaultPort ? `:${base.port}` : "";
  return `${base.scheme}://${hostForUrl(base.host)}${portPart}/m?pair=${encodeURIComponent(token)}`;
}

/** 二维码 SVG(qrcode-generator,MIT;固定 M 级纠错,margin=2)。 */
export function renderQrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export interface RemoteControlOptions {
 /** 实际监听端口(external server 可能延迟到 listen 后才有 address)。 */
  getPort: () => number | undefined;
 /** 配对有效期;缺省 30 分钟。 */
  ttlMs?: number;
  now?: () => number;
 /** GENIE_PUBLIC_HOST 读取面(测试可注入)。 */
  envHost?: () => string | undefined;
  ifaces?: () => IfaceAddr[];
}

const DEFAULT_TTL_MS = 30 * 60_000;

interface RemoteSession {
  token: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  clients: Set<object>;
}

/** 配对会话管理(纯内存,进程重启即失效;无持久化面,避免 token 落盘)。 */
export class RemoteControlManager {
  private current: RemoteSession | undefined;
 /** QR SVG 按链接缓存:面板 2s 轮询时避免每拍重算(11KB 字符串/次)。 */
  private qrCache: { url: string; svg: string } | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: RemoteControlOptions) {
    this.ttlMs = opts.ttlMs !== undefined && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

 /** 启动(幂等):已有未过期/有手机在线的会话原样返回;否则新建 token。 */
  start(): RemoteControlStatus {
    const now = this.now();
    if (this.current) {
      const expired = now > this.current.expiresAt;
      if (!expired || this.current.clients.size > 0) return this.status();
      this.current = undefined;
    }
    this.current = {
      token: randomBytes(32).toString("hex"),
      sessionId: randomBytes(8).toString("hex"),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      clients: new Set(),
    };
    return this.status();
  }

  stop(): void {
    this.current = undefined;
  }

 /** 当前状态。过期且无在线手机时自动回收,并带 expired=true。 */
  status(): RemoteControlStatus {
    const cur = this.current;
    if (!cur) {
      const base = this.base();
      return { state: "idle", clients: 0, ...(base.host ? { host: base.host } : {}), ...(base.warning ? { warning: base.warning } : {}) };
    }
    const now = this.now();
    if (now > cur.expiresAt && cur.clients.size === 0) {
      this.current = undefined;
      const base = this.base();
      return {
        state: "idle",
        clients: 0,
        expired: true,
        host: base.host,
        ...(base.warning ? { warning: base.warning } : {}),
      };
    }
    const base = this.base();
    const connectUrl = buildConnectUrl(base, cur.token);
    return {
      state: cur.clients.size > 0 ? "connected" : "waiting",
      connectUrl,
      qrSvg: this.qrFor(connectUrl),
      createdAt: cur.createdAt,
      expiresAt: cur.expiresAt,
      clients: cur.clients.size,
      host: base.host,
      ...(base.warning ? { warning: base.warning } : {}),
    };
  }

 /** token 校验(过期且无在线手机=拒绝新配对)。 */
  verifyToken(token: string | undefined): boolean {
    const cur = this.current;
    if (!cur || !token) return false;
    if (this.now() > cur.expiresAt && cur.clients.size === 0) return false;
    const a = Buffer.from(token, "utf8");
    const b = Buffer.from(cur.token, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

 /** 手机 WS 连上(调用方已 verifyToken)。 */
  attach(client: object): void {
    if (!this.current) return;
    this.current.clients.add(client);
  }

 /** 手机 WS 断开;会话保留(回到 waiting,直到过期/手动 stop)。 */
  detach(client: object): void {
    this.current?.clients.delete(client);
  }

  private qrFor(url: string): string {
    if (this.qrCache && this.qrCache.url === url) return this.qrCache.svg;
    const svg = renderQrSvg(url);
    this.qrCache = { url, svg };
    return svg;
  }

  private base(): PublicHost {
    let port = 0;
    try {
      port = this.opts.getPort() ?? 0;
    } catch {
      port = 0;
    }
    return resolvePublicHost(
      this.opts.envHost ? this.opts.envHost() : process.env.GENIE_PUBLIC_HOST,
      this.opts.ifaces ? this.opts.ifaces() : networkIfaces(),
      port,
    );
  }
}