/**
 * IM 入站 HTTP 面(step-013 二期收口):POST /webhook/feishu 独立小服务(env 门控)。
 * 未配 GENIE_FEISHU_VERIFICATION_TOKEN=不启动(零行为变化);挂了=本地功能不受影响。
 */
import { createServer, type Server } from "node:http";
import { parseFeishuCallback, routeInboundMessage, type FeishuInboundOptions } from "@lampgenie/runtime/notify/inbound";
import { verifyInboundRequest, INBOUND_FORBIDDEN_TEXT, type InboundAuthOptions } from "./inbound-auth.js";

export interface InboundServerOptions extends FeishuInboundOptions, Omit<InboundAuthOptions, "verificationToken"> {
  port: number;
  /** 群→会话(项目)绑定表;缺省读 env GENIE_FEISHU_GROUP_BINDS(形如 "oc_x=sess-a,oc_y=sess-b")。 */
  groupBindings?: Record<string, string>;
  botOpenId?: string;
  /** 收件任务创建(dm/mention/todo 命中)。 */
  submitTask(input: { sessionId: string; instruction: string; title: string }): void;
  /** 收件箱落(entry;unbound-group 等)。 */
  noteInbox?(input: { sessionId: string; text: string; reason: string }): void;
  log?: (line: string) => void;
}

export function parseGroupBinds(v: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (v ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

export function startInboundServer(opts: InboundServerOptions): { server: Server; close(): Promise<void> } {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !(req.url ?? "").startsWith("/webhook/feishu")) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1 << 20) { req.destroy(); return; } // 1MB 上限
      chunks.push(c);
    });
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const route = (req.url ?? "").split("?")[0] ?? "";
      // auth-before-body:先按原始字节认证,失败固定 403 forbidden(不泄露缺哪个头/签名错)
      const auth = verifyInboundRequest({
        headers: req.headers,
        rawBody,
        remoteAddress: req.socket.remoteAddress,
        route,
        opts: {
          hmacSecret: opts.hmacSecret,
          verificationToken: opts.verificationToken,
          now: opts.now,
          windowMs: opts.windowMs,
          allowInsecureLoopback: opts.allowInsecureLoopback,
          maxBodyBytes: opts.maxBodyBytes,
          profile: opts.profile,
        },
      });
      if (!auth.ok) {
        (opts.log ?? console.log)(`[im] 认证拒绝:${auth.reason}`);
        res.writeHead(403).end(INBOUND_FORBIDDEN_TEXT);
        return;
      }
      if (auth.duplicate) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ duplicate: true }));
        return;
      }
      try {
        const parsed = parseFeishuCallback(rawBody, opts);
        if (parsed.kind === "challenge") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ challenge: parsed.challenge }));
          return;
        }
        if (parsed.kind === "ignored") {
          (opts.log ?? console.log)(`[im] 忽略:${parsed.reason}`);
          res.writeHead(200).end();
          return;
        }
        const bindings = opts.groupBindings ?? parseGroupBinds(process.env.GENIE_FEISHU_GROUP_BINDS);
        const route = routeInboundMessage(parsed, { groupBindings: bindings, botOpenId: opts.botOpenId });
        if (route.target === "task") {
          opts.submitTask({ sessionId: route.sessionId, instruction: parsed.text, title: route.title });
        } else if (route.target === "inbox") {
          opts.noteInbox?.({ sessionId: route.sessionId, text: parsed.text, reason: route.reason });
        }
        res.writeHead(200).end();
      } catch (err) {
        (opts.log ?? console.log)(`[im] 拒收:${String(err).slice(0, 120)}`);
        res.writeHead(400).end();
      }
    });
  });
  server.listen(opts.port);
  return {
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
