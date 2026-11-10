import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { sendToEndpoint } from "../src/notify/webhook";
import { formatGenericJson } from "../src/notify/formatters";

function receiver(): Promise<{ port: number; bodies: string[]; sigs: (string | undefined)[]; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const bodies: string[] = [];
    const sigs: (string | undefined)[] = [];
    const srv = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => { bodies.push(data); sigs.push(req.headers["x-genie-signature"] as string | undefined); res.writeHead(200); res.end(); });
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      resolve({ port, bodies, sigs, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

describe("webhook(teamai 契约移植)", () => {
  it("HMAC 签名正确 + 出站脱敏", async () => {
    const { port, bodies, sigs, close } = await receiver();
    const secret = "test-secret";
    process.env.MY_TOKEN = "sk-supersecretvalue123456789";
    const ok = await sendToEndpoint(
      { type: "json", url: `http://127.0.0.1:${port}`, secret },
      { event: "task.done", detail: `token=${process.env.MY_TOKEN}` },
      formatGenericJson,
      { maxRetries: 1 },
    );
    expect(ok).toBe(true);
    expect(bodies).toHaveLength(1);
    // HMAC 校验
    const expectSig = "sha256=" + createHmac("sha256", secret).update(bodies[0]!).digest("hex");
    expect(sigs[0]).toBe(expectSig);
    // 脱敏:密钥不出站
    expect(bodies[0]).not.toContain("sk-supersecretvalue123456789");
    await close();
  });

  it("4xx 不重试", async () => {
    const srv = createServer((_, res) => { res.writeHead(400); res.end(); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    let hits = 0;
    srv.on("request", () => hits++);
    const ok = await sendToEndpoint({ type: "json", url: `http://127.0.0.1:${port}` }, { event: "x" }, formatGenericJson, { maxRetries: 3, logger: { warn: () => {} } });
    expect(ok).toBe(false);
    expect(hits).toBe(1); // 只打了一次
    await new Promise<void>((r) => srv.close(() => r()));
  }, 15000);
});
