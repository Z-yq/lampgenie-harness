/**
 * 子代理派遣的 LLM 在飞限流(2026-10-20 实锤回归):
 * 10 路并发首调智谱端点 → 8 路 `TypeError: fetch failed`(ConnectTimeoutError 10s);
 * 同 Key 低并发全部 200。observer 只观测不排队,故在此按端点做信号量。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "@lampgenie/core";
import { inflightAdmissionFor, inflightStats, resolveInflightCap } from "../src/llm-inflight.js";
import { buildModelProviders } from "../src/factory.js";
import type { AdmissionTicket } from "@lampgenie/runtime/concurrency/admission";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

describe("resolveInflightCap", () => {
  it("缺省 2;off/0=不限;非法回缺省;上限 64", () => {
    expect(resolveInflightCap(undefined)).toBe(2);
    expect(resolveInflightCap("")).toBe(2);
    expect(resolveInflightCap("off")).toBe(0);
    expect(resolveInflightCap("0")).toBe(0);
    expect(resolveInflightCap("abc")).toBe(2);
    expect(resolveInflightCap("999")).toBe(64);
  });
});

describe("InflightSemaphore(经 composeInflightAdmission)", () => {
  it("10 路并发 + cap=3:同时在飞峰值恰为 3,全部最终放行", async () => {
    const adm = inflightAdmissionFor("https://inflight.test/a", undefined, 3)!;
    let active = 0, peak = 0, done = 0;
    await Promise.all(Array.from({ length: 10 }, async () => {
      const t = await adm.take({ model: { providerId: "p", modelId: "m" } });
      active++; peak = Math.max(peak, active);
      await tick();
      active--; done++;
      t.release();
    }));
    expect(done).toBe(10);
    expect(peak).toBe(3);
    const s = inflightStats("https://inflight.test/a")!;
    expect(s).toMatchObject({ active: 0, queued: 0, cap: 3 });
  });

  it("排队中被取消:出队并抛取消原因,不占槽", async () => {
    const adm = inflightAdmissionFor("https://inflight.test/b", undefined, 1)!;
    const held = await adm.take({ model: { providerId: "p", modelId: "m" } });
    const ac = new AbortController();
    const queued = adm.take({ model: { providerId: "p", modelId: "m" }, signal: ac.signal });
    await tick(5);
    ac.abort(new Error("cancelled-by-test"));
    await expect(queued).rejects.toThrow("cancelled-by-test");
    expect(inflightStats("https://inflight.test/b")).toMatchObject({ active: 1, queued: 0 });
    held.release();
    expect(inflightStats("https://inflight.test/b")).toMatchObject({ active: 0 });
  });

  it("release 幂等:重复归还不会多放行", async () => {
    const adm = inflightAdmissionFor("https://inflight.test/c", undefined, 1)!;
    const t = await adm.take({ model: { providerId: "p", modelId: "m" } });
    let granted = 0;
    const next = adm.take({ model: { providerId: "p", modelId: "m" } }).then((x) => { granted++; return x; });
    await tick(5);
    expect(granted).toBe(0);
    t.release();
    t.release();
    const t2 = await next;
    expect(granted).toBe(1);
    expect(inflightStats("https://inflight.test/c")).toMatchObject({ active: 1 });
    t2.release();
    expect(inflightStats("https://inflight.test/c")).toMatchObject({ active: 0 });
  });

  it("组合 observer:AIMD 状态事件仍透传,释放时两边一起归还", async () => {
    const seen: string[] = [];
    let innerReleased = 0;
    const observer = {
      async take(): Promise<AdmissionTicket> {
        return { emit: (e) => seen.push(e.type), release: () => { innerReleased++; } };
      },
    };
    const adm = inflightAdmissionFor("https://inflight.test/d", observer, 2)!;
    const t = await adm.take({ model: { providerId: "p", modelId: "m" } });
    await t.emit({ type: "model_request_started", at: Date.now() });
    expect(seen).toEqual(["model_request_started"]);
    t.release();
    expect(innerReleased).toBe(1);
    expect(inflightStats("https://inflight.test/d")).toMatchObject({ active: 0 });
  });
});
describe("装配接线:buildModelProviders 的请求真的过限流", () => {
  it("8 路并发 chat(子代理 provider)→ 端点在飞峰值 ≤ cap(缺省 2)", async () => {
    const root = mkdtempSync(join(tmpdir(), "gh-inflight-wire-"));
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(join(root, ".genie", "secrets.json"), JSON.stringify({ K: "test-key" }), "utf-8");
    const cfg = ConfigSchema.parse({
      providers: [{ id: "p", baseUrl: "https://inflight.wiring.test", apiKeyEnv: "K", models: ["m1"] }],
      coding: { llm: { providerId: "p", model: "m1" }, models: { subagent: { model: "m1" } } }, // 2026-10-20:子代理未配置不再恒建,显式配 model 才有独立 provider——测试本意(角色 provider 过限流)保持
    });
    const providers = buildModelProviders(cfg, root, {});
    expect(providers.subagent).toBeTruthy();

    let active = 0, peak = 0;
    globalThis.fetch = (async () => {
      active++; peak = Math.max(peak, active);
      await tick(30);
      active--;
      return new Response(JSON.stringify({ choices: [{ message: { content: "好" } }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const out = await Promise.all(Array.from({ length: 8 }, () =>
      providers.subagent!.chat([{ role: "user", content: "hi" }], []),
    ));
    expect(out.every((r) => r.content === "好")).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
    expect(inflightStats("https://inflight.wiring.test")).toMatchObject({ active: 0, queued: 0 });
  });
});
