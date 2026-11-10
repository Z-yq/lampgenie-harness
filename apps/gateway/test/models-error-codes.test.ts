/**
 * models.list 错误分类:未装配/无 Provider/端点未配置/缺凭证/上游失败
 * 各自有可编程错误码 + 可操作 message;成功路径与未分类异常(旧 models-list-failed)不变。
 */
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { ErrorCode, ErrorCodeSchema } from "@lampgenie/protocol";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import {
  ModelsListError,
  modelsCredentialMissing,
  modelsEndpointMissing,
  modelsErrorOf,
  modelsUnknownProvider,
  modelsUpstreamFailure,
} from "../src/models-errors.js";

describe("models.list 错误分类(纯函数)", () => {
  it("各失败面 → 独立错误码 + 可操作提示", () => {
    const cases: Array<[ModelsListError, ErrorCode, RegExp]> = [
      [modelsUnknownProvider("p1"), ErrorCode.ModelsNoProvider, /未知 provider.*添加供应商/i],
      [modelsEndpointMissing({ providerCount: 0 }), ErrorCode.ModelsNoProvider, /添加供应商/],
      [modelsEndpointMissing({ providerCount: 2 }), ErrorCode.ModelsNotConfigured, /baseUrl/],
      [modelsCredentialMissing("MY_KEY"), ErrorCode.ModelsNoCredential, /MY_KEY.*secrets\.json/],
      [modelsUpstreamFailure({ baseUrl: "http://127.0.0.1:1", detail: "返回 HTTP 401(凭证无效?)" }), ErrorCode.ModelsUpstreamFailed, /HTTP 401/],
    ];
    for (const [err, code, re] of cases) {
      const mapped = modelsErrorOf(err);
      expect(mapped.code).toBe(code);
      expect(mapped.message).toMatch(re);
    }
    // 缺 apiKeyEnv 时给默认凭证名,避免「」空提示
    expect(modelsCredentialMissing().message).toContain("GENIE_LLM_API_KEY");
  });

  it("未分类异常保持 models-list-failed(旧码兼容),message 不丢", () => {
    expect(modelsErrorOf(new Error("boom"))).toEqual({ code: ErrorCode.ModelsListFailed, message: "Error: boom" });
    expect(modelsErrorOf("plain")).toEqual({ code: ErrorCode.ModelsListFailed, message: "plain" });
  });

  it("新错误码登记进协议枚举(ErrorCodeSchema 放行)", () => {
    for (const code of [
      ErrorCode.ModelsNoProvider,
      ErrorCode.ModelsNotConfigured,
      ErrorCode.ModelsNoCredential,
      ErrorCode.ModelsUpstreamFailed,
    ]) {
      expect(ErrorCodeSchema.safeParse(code).success, code).toBe(true);
      // 值以 models- 开头 = 面板现有 /models/ 前缀分支能接住(不落通用 toast)
      expect(String(code).startsWith("models-")).toBe(true);
    }
  });
});

let app: GatewayApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox: Record<string, unknown>[] = [];
    (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox = inbox;
    ws.on("message", (raw: Buffer) => inbox.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  const inbox = (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox;
  const hit = inbox.findIndex((m) => m.type === type);
  if (hit >= 0) return Promise.resolve(inbox.splice(hit, 1)[0]!);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), 3000);
    const poll = setInterval(() => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(inbox.splice(i, 1)[0]!);
      }
    }, 20);
  });
}

describe("models.list WS 回包(错误码映射)", () => {
  it("成功路径不变;typed 失败按码下发;未知异常回落 models-list-failed", async () => {
    app = createGatewayApp({
      port: 7811,
      listModels: async (providerId?: string) => {
        if (providerId === "unknown") throw modelsUnknownProvider("unknown");
        if (providerId === "nokey") throw modelsCredentialMissing("NOPE_KEY");
        if (providerId === "noprovider") throw modelsEndpointMissing({ providerCount: 0 });
        if (providerId === "boom") throw new Error("boom");
        return ["model-a", "model-b"];
      },
    });
    const ws = await connect(7811);
    await nextMessage(ws, "hello");

    ws.send(JSON.stringify({ v: 1, type: "models.list" }));
    const ok = await nextMessage(ws, "models.list.result");
    expect(ok.ids).toEqual(["model-a", "model-b"]);

    ws.send(JSON.stringify({ v: 1, type: "models.list", providerId: "unknown" }));
    const noProvider = await nextMessage(ws, "error");
    expect(noProvider.code).toBe(ErrorCode.ModelsNoProvider);
    expect(String(noProvider.message)).toContain("添加供应商");

    ws.send(JSON.stringify({ v: 1, type: "models.list", providerId: "nokey" }));
    const noCred = await nextMessage(ws, "error");
    expect(noCred.code).toBe(ErrorCode.ModelsNoCredential);
    expect(String(noCred.message)).toContain("NOPE_KEY");

    ws.send(JSON.stringify({ v: 1, type: "models.list", providerId: "noprovider" }));
    const none = await nextMessage(ws, "error");
    expect(none.code).toBe(ErrorCode.ModelsNoProvider);

    ws.send(JSON.stringify({ v: 1, type: "models.list", providerId: "boom" }));
    const fallback = await nextMessage(ws, "error");
    expect(fallback.code).toBe(ErrorCode.ModelsListFailed);
    expect(String(fallback.message)).toContain("boom");

    ws.close();
  });
});
