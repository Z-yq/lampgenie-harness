import { describe, it, expect } from "vitest";
import { startMockLlmServer } from "./llm-mock-server/index";

describe("llm-mock-server(脚本化 mock LLM 服务)", () => {
  it("起服务并响应一次 chat 请求", async () => {
    const server = await startMockLlmServer({ port: 0, sequence: ['success'] });
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "hi" }], max_tokens: 16, stream: false }),
    });
    expect(res.status).toBe(200);
    await res.text();
    await server.close();
  });
});
