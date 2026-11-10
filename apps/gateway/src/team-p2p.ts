/**
 * 团队 P2P 直连通道(fixD3):成员目录(.genie/team/members.json,仓内 git 共享,只含
 * username/host/port/公钥指纹/role——凭证红线);私钥走 .genie/secrets.json(按用户名分键)。
 * 本机端点复用 gateway HTTP:/team/p2p/{ping,presence,message,inbox};请求签名头
 * (私钥签 ts,对端用目录指纹绑定的公钥验)。可达性 ping 探测(3s);不可达→消息走
 * 既有 relay 中转标 via=relay;relay 也不在=离线队列(下次在线补发;不做登记)。
 * 与 TeamRelayClient 共存:P2P 是新增通道不是替换。
 */
import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bus } from "@lampgenie/core";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface TeamMember {
  username: string;
  host: string;
  port: number;
  /** 公钥指纹(目录只存指纹不存公钥本体;公钥随请求头带,指纹绑定验真)。 */
  pubkeyFingerprint: string;
  role: string;
}

export interface P2pMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  at: number;
  via: "p2p" | "relay" | "queued";
  /** 重复投递标记(对端重发同一 id;入站侧置 true 并保留首条)。 */
  duplicate?: boolean;
}

export interface TeamP2POptions {
  repoRoot: string;
  /** 本机 gateway HTTP 端口(自报目录项)。 */
  port: number;
  username?: string;
  role?: string;
  host?: string;
  /** relay 中转兜底(生产=TeamView 首个 ready org 的 activity 通道;缺省=无 relay 可用)。 */
  relaySend?: (to: string, text: string) => boolean;
  /** fetch 注入(单测);缺省 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const SIG_WINDOW_MS = 300_000;
/** 入站去重窗(消息 id 保留条数;重发/重放超出窗口即视为新消息,防无界增长)。 */
const SEEN_CAP = 1000;

function fingerprintOfPem(pubPem: string): string {
  return createHash("sha256").update(pubPem.trim()).digest("hex").slice(0, 40);
}

function keyNames(username: string): { priv: string; pub: string } {
  return { priv: `p2pKey.${username}`, pub: `p2pKey.${username}.pub` };
}

export class TeamP2P {
  private inbox = new Map<string, P2pMessage[]>();
  /** 入站去重键集合(发送方 id 优先;保持插入序做容量淘汰)。 */
  private seen = new Set<string>();
  private offlineQueue: P2pMessage[] = [];
  private reachability = new Map<string, { state: "online" | "offline" | "unknown"; at: number; err?: string }>();
  readonly username: string;

  constructor(private readonly opts: TeamP2POptions) {
    this.username = opts.username ?? process.env.GENIE_P2P_USER ?? "owner";
    this.ensureIdentity();
  }

  // ---- 身份与目录 ----

  private identity: { publicKeyPem: string; privateKeyPem: string; fingerprint: string } | null = null;

  private secretsFile(): string {
    return join(this.opts.repoRoot, ".genie", "secrets.json");
  }

  private readSecrets(): Record<string, unknown> {
    try {
      if (!existsSync(this.secretsFile())) return {};
      return JSON.parse(readFileSync(this.secretsFile(), "utf-8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private writeSecrets(secrets: Record<string, unknown>): void {
    mkdirSync(join(this.opts.repoRoot, ".genie"), { recursive: true });
    writeFileSync(this.secretsFile(), JSON.stringify(secrets, null, 2), { mode: 0o600 });
  }

  /** 首次生成密钥对(secrets.json 内,按用户名分键);再次启动复用。 */
  private ensureIdentity(): void {
    const names = keyNames(this.username);
    const secrets = this.readSecrets();
    const priv = secrets[names.priv];
    const pub = secrets[names.pub];
    if (typeof priv === "string" && typeof pub === "string" && priv && pub) {
      this.identity = { privateKeyPem: priv, publicKeyPem: pub, fingerprint: fingerprintOfPem(pub) };
    } else {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      secrets[names.priv] = privPem;
      secrets[names.pub] = pubPem;
      this.writeSecrets(secrets);
      this.identity = { privateKeyPem: privPem, publicKeyPem: pubPem, fingerprint: fingerprintOfPem(pubPem) };
    }
    this.upsertSelf();
  }

  /** 端口后置更新(attachWs 时从真实监听地址回填;面板自启/测试形态不传 opts.port)。 */
  updatePort(port: number): void {
    if (!Number.isFinite(port) || port <= 0 || port === this.opts.port) return;
    this.opts.port = port;
    this.upsertSelf();
  }

  private membersFile(): string {
    return join(this.opts.repoRoot, ".genie", "team", "members.json");
  }

  members(): TeamMember[] {
    try {
      if (!existsSync(this.membersFile())) return [];
      const arr = JSON.parse(readFileSync(this.membersFile(), "utf-8")) as TeamMember[];
      return Array.isArray(arr) ? arr.filter((m) => m && typeof m.username === "string") : [];
    } catch {
      return [];
    }
  }

  private upsertSelf(): void {
    if (!this.identity) return;
    const self: TeamMember = {
      username: this.username,
      host: this.opts.host ?? process.env.GENIE_P2P_HOST ?? "127.0.0.1",
      port: this.opts.port,
      pubkeyFingerprint: this.identity.fingerprint,
      role: this.opts.role ?? "member",
    };
    const members = this.members().filter((m) => m.username !== self.username);
    members.push(self);
    mkdirSync(join(this.opts.repoRoot, ".genie", "team"), { recursive: true });
    writeFileSync(this.membersFile(), JSON.stringify(members, null, 2));
  }

  // ---- 签名/验签 ----

  private bodyHash(body: string): string {
    return createHash("sha256").update(body).digest("hex");
  }

  signHeaders(body: string): Record<string, string> {
    const id = this.identity!;
    const ts = String((this.opts.now ?? Date.now)());
    const material = `${ts}:${this.username}:${this.bodyHash(body)}`;
    const sig = cryptoSign(null, Buffer.from(material, "utf-8"), id.privateKeyPem).toString("base64");
    return {
      "x-genie-user": this.username,
      "x-genie-ts": ts,
      "x-genie-key": Buffer.from(id.publicKeyPem, "utf-8").toString("base64"),
      "x-genie-sig": sig,
    };
  }

  /** 验签:用户名在目录 + 公钥指纹=目录指纹 + ts 窗口 + 签名有效。 */
  verifyRequest(headers: Record<string, string | string[] | undefined>, body: string): { ok: boolean; user?: string; reason?: string } {
    const h = (k: string): string => (Array.isArray(headers[k]) ? String(headers[k]![0]) : (headers[k] ? String(headers[k]) : ""));
    const user = h("x-genie-user");
    const ts = h("x-genie-ts");
    const keyB64 = h("x-genie-key");
    const sig = h("x-genie-sig");
    if (!user || !ts || !keyB64 || !sig) return { ok: false, reason: "签名头缺失" };
    const member = this.members().find((m) => m.username === user);
    if (!member) return { ok: false, reason: `成员不在目录:${user}` };
    let pubPem: string;
    try {
      pubPem = Buffer.from(keyB64, "base64").toString("utf-8");
    } catch {
      return { ok: false, reason: "公钥解码失败" };
    }
    if (fingerprintOfPem(pubPem) !== member.pubkeyFingerprint) return { ok: false, reason: "公钥指纹与目录不符" };
    const now = (this.opts.now ?? Date.now)();
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > SIG_WINDOW_MS) return { ok: false, reason: "时间戳超窗(±300s)" };
    const material = `${ts}:${user}:${this.bodyHash(body)}`;
    let valid = false;
    try {
      valid = cryptoVerify(null, Buffer.from(material, "utf-8"), pubPem, Buffer.from(sig, "base64"));
    } catch {
      valid = false;
    }
    return valid ? { ok: true, user } : { ok: false, reason: "签名验证失败" };
  }

  // ---- 出站 ----

  private baseUrl(m: TeamMember): string {
    return `http://${m.host}:${m.port}`;
  }

  /** ping 探测(3s 超时)。由离线/未知转在线时顺带补发离线队列(修 flushQueue 无调用方的死代码)。 */
  async ping(username: string): Promise<boolean> {
    const m = this.members().find((x) => x.username === username);
    if (!m || m.username === this.username) return false;
    const doFetch = this.opts.fetchImpl ?? fetch;
    const wasOnline = this.reachability.get(username)?.state === "online";
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3000);
      const headers = this.signHeaders("{}");
      const res = await doFetch(`${this.baseUrl(m)}/team/p2p/ping`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}", signal: ctl.signal });
      clearTimeout(t);
      if (res.ok) {
        this.reachability.set(username, { state: "online", at: Date.now() });
        // 转在线即补发积压(否则面板承诺的「在线自动补发」永不发生)。
        if (!wasOnline && this.offlineQueue.some((q) => q.to === username)) {
          void this.flushQueue().catch(() => { /* 补发失败留给下次探测 */ });
        }
        return true;
      }
      // 403=验签/目录问题:读回原因(observability;ping 失败只标记不抛)。
      let reason = `HTTP ${res.status}`;
      try { reason += " " + String(((await res.json()) as { reason?: string }).reason ?? ""); } catch { /* body 忽略 */ }
      this.reachability.set(username, { state: "offline", at: Date.now(), err: reason.slice(0, 120) });
      return false;
    } catch (err) {
      this.reachability.set(username, { state: "offline", at: Date.now(), err: String(err).slice(0, 120) });
      return false;
    }
  }

  /** 消息发送:P2P 优先 → relay 中转兜底(via=relay)→ 离线队列(via=queued)。 */
  async send(to: string, text: string): Promise<P2pMessage> {
    const msg: P2pMessage = { id: `p2p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, from: this.username, to, text, at: Date.now(), via: "p2p" };
    const m = this.members().find((x) => x.username === to);
    if (!m) {
      msg.via = "queued";
      this.offlineQueue.push({ ...msg, via: "queued" });
      return msg;
    }
    const doFetch = this.opts.fetchImpl ?? fetch;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3000);
      const body = JSON.stringify({ id: msg.id, to, text });
      const res = await doFetch(`${this.baseUrl(m)}/team/p2p/message`, { method: "POST", headers: { "content-type": "application/json", ...this.signHeaders(body) }, body, signal: ctl.signal });
      clearTimeout(t);
      if (res.ok) {
        this.reachability.set(to, { state: "online", at: Date.now() });
        return msg;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // 失败的降级原因要可观测(分辨率:面板 status 的 err 字段 + journal 侧 bus 事件)。
      const reason = String(err).slice(0, 120);
      this.reachability.set(to, { state: "offline", at: Date.now(), err: reason });
      // relay 兜底:既有 activity 通道复用;不在=离线队列(不做登记)。
      if (this.opts.relaySend && this.opts.relaySend(to, text)) {
        msg.via = "relay";
        bus.emit("team.p2p.send.fallback", { id: msg.id, from: this.username, to, via: "relay", reason });
        return msg;
      }
      msg.via = "queued";
      this.offlineQueue.push(msg);
      bus.emit("team.p2p.send.fallback", { id: msg.id, from: this.username, to, via: "queued", reason });
      return msg;
    }
  }

  /** 离线队列补发(下次探测在线时调用)。 */
  async flushQueue(): Promise<number> {
    let sent = 0;
    const pending = [...this.offlineQueue];
    this.offlineQueue = [];
    for (const m of pending) {
      const r = await this.send(m.to, m.text);
      if (r.via !== "queued") sent++;
      else this.offlineQueue.push(r);
    }
    return sent;
  }

  // ---- 入站(HTTP 路由处理;由 panel servePanel 顶部委托) ----

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url: string = (req.url ?? "").split("?")[0] ?? "";
    if (!url.startsWith("/team/p2p/")) return false;
    const body = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (d: Buffer) => chunks.push(d));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", () => resolve(""));
    });
    const reply = (code: number, data: unknown) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    const v = this.verifyRequest(req.headers, body || "");
    if (!v.ok) {
      // 拒绝要可观测:回包 reason(调用方)+ bus 事件(journal 侧落账,面板 status err 亦读)。
      const reason = v.reason ?? "验签失败";
      bus.emit("team.p2p.rejected", { route: url, user: String((req.headers["x-genie-user"] as string) ?? ""), reason, at: Date.now() });
      reply(403, { ok: false, reason });
      return true;
    }
    if (url === "/team/p2p/ping") {
      reply(200, { ok: true, username: this.username, fingerprint: this.identity?.fingerprint ?? "", at: Date.now() });
      return true;
    }
    if (url === "/team/p2p/presence") {
      reply(200, { ok: true, username: this.username, members: this.status().members });
      return true;
    }
    if (url === "/team/p2p/message") {
      let payload: { id?: string; to?: string; text?: string } = {};
      try {
        payload = JSON.parse(body || "{}") as { id?: string; to?: string; text?: string };
      } catch {
        reply(400, { ok: false, reason: "body 非法 JSON" });
        return true;
      }
      if (!payload.to || !payload.text) {
        reply(400, { ok: false, reason: "缺 to/text" });
        return true;
      }
      // 去重:发送方 id 优先(重发/重放识别);对端未带 id 时按 from+摘要+文本兜底成稳定键。
      const key = payload.id ? String(payload.id) : `${v.user!}:${createHash("sha256").update(payload.text).digest("hex").slice(0, 16)}`;
      const dup = this.seen.has(key);
      if (!dup) {
        this.seen.add(key);
        // 保序淘汰最旧(Set 插入序),防无界增长。
        if (this.seen.size > SEEN_CAP) {
          const oldest = this.seen.values().next().value;
          if (oldest !== undefined) this.seen.delete(oldest);
        }
      }
      const msg: P2pMessage = {
        id: dup ? key : (payload.id ? String(payload.id) : `in-${Date.now().toString(36)}`),
        from: v.user!,
        to: payload.to,
        text: payload.text.slice(0, 4000),
        at: Date.now(),
        via: "p2p",
        ...(dup ? { duplicate: true } : {}),
      };
      if (!dup) {
        this.inbox.set(msg.to, [...(this.inbox.get(msg.to) ?? []), msg].slice(-100));
      }
      // 重复也发事件(observability:面板/journal 能看到「对端重发被吸收」),但 inbox 只留首条。
      bus.emit("team.p2p.message", msg);
      reply(200, { ok: true, id: msg.id, ...(dup ? { duplicate: true } : {}) });
      return true;
    }
    if (url === "/team/p2p/inbox") {
      const mine = this.inbox.get(v.user!) ?? [];
      this.inbox.set(v.user!, []);
      reply(200, { ok: true, messages: mine });
      return true;
    }
    reply(404, { ok: false, reason: "未知路由" });
    return true;
  }

  /** 状态应答前探测:未知成员必探;离线成员按冷却窗重探(转在线才能触发离线队列补发)。
 * 坑(经验证):原实现只探「未知」——成员一旦 offline 就永远不再 ping,离线队列永不补发,
   * 面板承诺的「对端在线自动补发」实际不可能发生。冷却 10s 防 status 反复 3s 等待。 */
  async probeUnknown(): Promise<void> {
    const now = (this.opts.now ?? Date.now)();
    const unknown = this.members().filter((m) => m.username !== this.username && !this.reachability.has(m.username));
    const staleOffline = this.members().filter((m) => {
      if (m.username === this.username) return false;
      const r = this.reachability.get(m.username);
      if (!r || r.state === "online") return false;
      // 有积压消息时更快重探(5s),否则 10s 冷却。
      const cooldown = this.offlineQueue.some((q) => q.to === m.username) ? 5_000 : 10_000;
      return now - r.at >= cooldown;
    });
    await Promise.all([...unknown, ...staleOffline].map((m) => this.ping(m.username)));
  }

  /** 全景:成员+可达性+队列水位(协议 team.p2p.status.result 数据源)。
   * fixD6:补 offlineQueueItems(降级后可取证「积压了哪些、发给谁」)与 lastInbound(最近一条
   * 入站消息摘要)——此前队列只有条数、入站只有总数,降级面无法自证。 */
  status(): {
    self: TeamMember | null;
    members: { username: string; host: string; port: number; role: string; state: string; via: string; err?: string }[];
    offlineQueue: number;
    offlineQueueItems: { id: string; to: string; text: string; at: number }[];
    inbox: number;
    lastInbound: { id: string; from: string; to: string; text: string; at: number; duplicate?: boolean } | null;
  } {
    const members = this.members().map((m) => {
      const r = this.reachability.get(m.username);
      const isSelf = m.username === this.username;
      return {
        username: m.username,
        host: m.host,
        port: m.port,
        role: m.role,
        state: isSelf ? "self" : r ? r.state : "unknown",
        via: isSelf ? "-" : r?.state === "online" ? "p2p" : this.opts.relaySend ? "relay" : "queued",
        ...(r?.err ? { err: r.err } : {}),
      };
    });
    const self = this.members().find((m) => m.username === this.username) ?? null;
    const allIn = [...this.inbox.values()].flat();
    const last = allIn.length ? allIn[allIn.length - 1]! : null;
    return {
      self,
      members,
      offlineQueue: this.offlineQueue.length,
      offlineQueueItems: this.offlineQueue.slice(-20).map((q) => ({ id: q.id, to: q.to, text: q.text.slice(0, 80), at: q.at })),
      inbox: allIn.length,
      lastInbound: last ? { id: last.id, from: last.from, to: last.to, text: last.text.slice(0, 80), at: last.at, ...(last.duplicate ? { duplicate: true } : {}) } : null,
    };
  }
}
