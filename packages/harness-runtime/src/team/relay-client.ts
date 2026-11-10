/**
 * TeamRelayClient:gateway/桌面端连 relay 的客户端。
 * 红线(designs/05 工况 I4):relay 不可达=静默降级,本地与 Git 功能零影响——
 * 构造与 connect 均不抛错,断线退避重连, revoked/永久拒绝才停止。
 */
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { fingerprintOf } from "../identity/identity.js";
import { signChallenge } from "./relay-auth.js";
import type { PresenceFacts, RelayServerMessage } from "@lampgenie/protocol";

export interface RelayClientOptions {
  url: string;
  /** 身份目录(含 identity.pem/identity.pub,loadOrCreateIdentity 产物)。 */
  identityDir: string;
  /** 重连退避基数(默认 1s,×2 封顶 30s)。 */
  backoffBaseMs?: number;
  /** 状态回调(面板顶栏●用;不给就静默)。取值:connecting/authenticating/ready/disconnected/rejected。 */
  onState?: (state: string) => void;
  onMessage?: (msg: RelayServerMessage) => void;
}

export class TeamRelayClient {
  private ws: WebSocket | null = null;
  private backoff: number;
  private stopped = false;
  private state = "disconnected";
  ready = false;

  constructor(private readonly opts: RelayClientOptions) {
    // 退避基数从首轮重连就生效(此前只在 auth.ok 后重置,首轮固定 1000ms,选项名不副实)。
    this.backoff = opts.backoffBaseMs ?? 1000;
  }

  connect(): void {
    if (this.stopped) return;
    this.setState("connecting");
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.on("error", () => {
      // 连接失败进 close 回调统一退避;这里只吞(error 无监听会 unhandled)。
    });
    ws.on("open", () => {
      this.setState("authenticating");
      // 挑战在服务端连接即发;这里预载身份等 challenge 到达时签名。
      try {
        const pub = readFileSync(`${this.opts.identityDir}/identity.pub`, "utf-8");
        const priv = readFileSync(`${this.opts.identityDir}/identity.pem`, "utf-8");
        this.pendingAuth = { fingerprint: fingerprintOf(pub), publicKeyPem: pub, privateKeyPem: priv };
      } catch {
        this.setState("disconnected"); // 身份缺失=配置问题,退避重试不掩盖
      }
    });
    ws.on("message", (raw: Buffer) => {
      let msg: RelayServerMessage | null = null;
      try {
        msg = JSON.parse(raw.toString()) as RelayServerMessage;
      } catch {
        return;
      }
      if (!msg) return;
      if (msg.type === "relay.challenge" && this.pendingAuth) {
        ws.send(JSON.stringify({
          v: 1,
          type: "relay.auth",
          fingerprint: this.pendingAuth.fingerprint,
          publicKeyPem: this.pendingAuth.publicKeyPem,
          nonce: msg.nonce,
          sig: signChallenge(this.pendingAuth.privateKeyPem, msg.nonce),
        }));
        return;
      }
      if (msg.type === "relay.auth.ok") {
        this.ready = true;
        this.backoff = this.opts.backoffBaseMs ?? 1000;
        this.setState("ready");
      }

      if (msg.type === "relay.auth.reject") {
        this.ready = false;
        // not-on-roster=尚未入册(MR 可能稍后合并)→退避重试等合并;
        // 吊销/密钥不匹配/签名失败=永久拒绝;旧 relay 无 code 字段→保守按永久处理。
        this.stopped = (msg as { code?: string }).code !== "not-on-roster";
        this.setState("rejected");
        this.opts.onMessage?.(msg);
        ws.close();
        return;
      }
      this.opts.onMessage?.(msg);
    });
    ws.on("close", () => {
      this.ready = false;
      if (this.stopped) {
        this.setState("rejected");
        return;
      }
      this.setState("disconnected");
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, 30_000);
      const t = setTimeout(() => this.connect(), delay);
      t.unref?.();
    });
  }

  private pendingAuth: { fingerprint: string; publicKeyPem: string; privateKeyPem: string } | null = null;

  /** presence 事实上行(25s 节律由调用方驱动)。 */
  sendPresence(facts: PresenceFacts): void {
    this.wsSend({ v: 1, type: "relay.presence", facts });
  }

  /** 通用上行(团队视图面:invite.create 等;未就绪=静默丢,与红线一致)。 */
  wsSend(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.ready) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private setState(s: string): void {
    this.state = s;
    (this.opts.onState as ((s: string) => void) | undefined)?.(s);
  }

  currentState(): string {
    return this.state;
  }
}
