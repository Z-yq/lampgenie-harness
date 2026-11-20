// sense.query 20s 超时兜底(本地评分/索引繁忙时面板不再永久「分析中…」)
// 用永不 resolve 的 codeSense 替身,断言 WS 在 ~20s 内回 sense-failed + 可操作文案。
import { describe, it, expect, vi, afterEach } from "vitest";
import WebSocket from "ws";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";

vi.mock("@lampgenie/code-sense", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, codeSense: () => new Promise(() => { /* 永不回包:模拟评分服务被占满 */ }) };
});

let app: GatewayApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

describe("sense.query 超时兜底", () => {
  it("codeSense 无回包 → 20s 后回 sense-failed 且文案可操作", async () => {
    app = createGatewayApp({ port: 7799, executor: new EchoChildBackend() });
    const ws = new WebSocket("ws://127.0.0.1:7799");
    const inbox: Record<string, unknown>[] = [];
    ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.on("open", r));

    const t0 = Date.now();
    ws.send(JSON.stringify({ v: 1, type: "sense.query", query: "neverResolvesProbe", mode: "auto" }));
    const hit = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("20s 兜底未触发(等待 32s)")), 32000);
      const poll = setInterval(() => {
        const h = inbox.find((m) => (m.type === "error" && String(m.code || "").includes("sense")) || m.type === "sense.result");
        if (h) { clearTimeout(t); clearInterval(poll); resolve(h); }
      }, 100);
    });
    const ms = Date.now() - t0;
    expect(hit.type).toBe("error");
    expect(String(hit.code || "")).toMatch(/sense/i);
    expect(String(hit.message || "")).toContain("超时");
    expect(String(hit.message || "")).toContain("mode=symbol");
 // 兜底必须真的等到 ~20s(不是立刻失败);上限放宽到 26s 吸收 CI 抖动
    expect(ms).toBeGreaterThanOrEqual(19_000);
    expect(ms).toBeLessThan(26_000);
    ws.close();
  }, 40000);
});