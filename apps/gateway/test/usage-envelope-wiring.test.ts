/**
 * usage-envelope 接线锚(2026-11):纯路径测试 —— 不启服务、不连网。
 * 口径:
 * a. 源码静态断言:loop 的失败/成功两条 llmTrace 路径与失败 durable journal 都带 envelope,
 * 且指纹计算被 try/catch 包裹(算不出来不阻塞轨迹)。
 * b. trace-stats 真的消费了 dedupeUsage 并给出 usageEnvelope/tokensDeduped。
 * c. 行为面轻量断言(直接 import 模块本身):指纹复用、双口径、无费率 cost=null。
 * 已知边界:(2026-11)已让 `apps/gateway/src/llm-trace.ts` 在构建 journal `llm.trace`
 * payload 时原样透传调用方的 envelope(16 hex),缺失不写键——本文件 d 组同时断言该透传。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageEnvelopeLedger, dedupeUsage, envelopeFingerprint, splitPrice } from "@lampgenie/runtime/agent/usage-envelope";
import { makeLlmTraceSink } from "../src/llm-trace.js";
import type { Journal } from "@lampgenie/core";

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

const loopSrc = (): string => src("../../../packages/harness-runtime/src/agent/loop.ts");
const statsSrc = (): string => src("../../../packages/harness-runtime/src/agent/trace-stats.ts");
const envSrc = (): string => src("../../../packages/harness-runtime/src/agent/usage-envelope.ts");

describe("loop.ts 接线(静态)", () => {
  it("① import envelopeFingerprint", () => {
    expect(loopSrc()).toContain('import { envelopeFingerprint } from "./usage-envelope"');
  });

  it("② 失败路径:llmTrace 回调与 durable journal payload 都带 ...envKey", () => {
    const s = loopSrc();
    expect(s).toContain('envKey = { envelope: envelopeFingerprint({ model: modelAtStart ?? "", messages, tools: advertised }) };');
 // 失败 llmTrace payload
    expect(s).toMatch(/this\.opts\.llmTrace\?\.\(\{\s*sessionId, turn, step,\s*\.\.\.envKey,/);
 // 失败 durable journal payload(kind: "llm.trace")
    expect(s).toMatch(/kind: "llm\.trace",[\s\S]{0,400}?payload: \{\s*turn, step,\s*\.\.\.envKey,/);
  });

  it("② 成功路径:payload 也带 ...envKey(messages 用 traceMsgs)", () => {
    const s = loopSrc();
    expect(s).toContain('envKey = { envelope: envelopeFingerprint({ model: modelAtStart ?? "", messages: traceMsgs, tools: advertised }) };');
 // 成功 llmTrace 调用紧随 envKey 计算之后(try 块内)
    expect(s).toMatch(/const p = this\.opts\.llm[\s\S]{0,300}?this\.opts\.llmTrace\?\.\(\{\s*sessionId, turn, step,\s*\.\.\.envKey,/);
 // 两处计算 + 三处展开:成功/失败各一算,失败展开在回调与 journal 各一次
    expect(s.match(/\.\.\.envKey/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(s.match(/envelope: envelopeFingerprint\(/g)?.length).toBe(2);
  });

  it("③ 指纹计算被 try/catch 包裹(失败只省略键,不阻塞 trace)", () => {
    const s = loopSrc();
    expect(s.match(/let envKey: Record<string, string> = \{\};/g)?.length).toBe(2);
    expect(s.match(/\} catch \{ \/\* 计算失败省略该键,不阻塞 trace \*\/ \}/g)?.length).toBe(2);
  });
});

describe("trace-stats.ts 接线(静态)", () => {
  it("④ 用 dedupeUsage,并产出 usageEnvelope / tokensDeduped", () => {
    const s = statsSrc();
    expect(s).toContain('import { dedupeUsage } from "./usage-envelope"');
    expect(s).toContain("const dedup = dedupeUsage(envelopeEntries);");
    expect(s).toContain("out.usageEnvelope = {");
    expect(s).toContain("out.tokensDeduped = {");
 // 旧口径字段仍在(展示口径逐字不变的前提)
    expect(s).toContain("out.tokens.input += u.inputTokens ?? 0;");
  });
});

describe("usage-envelope.ts 实现锚(静态)", () => {
  it("⑤ 含 sha256 / slice(0,16) / 键排序", () => {
    const s = envSrc();
    expect(s).toContain('createHash("sha256")');
    expect(s).toMatch(/slice\(0, 16\)/);
    expect(s).toContain("Object.keys(obj).sort()");
  });
});

describe("行为轻量断言", () => {
  it("A. 同一信封两次 → 第二次 reused", () => {
    const fp = envelopeFingerprint({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] });
    const led = new UsageEnvelopeLedger();
    expect(led.record(fp).reused).toBe(false);
    expect(led.record(fp).reused).toBe(true);
  });

  it("B. dedupeUsage:display 累加、deduped 只算第一次", () => {
    const r = dedupeUsage([
      { fingerprint: "k", usage: { input: 10, output: 2 } },
      { fingerprint: "k", usage: { input: 10, output: 2 } },
    ]);
    expect(r.display).toEqual({ input: 20, output: 4, total: 24, cached: 0 });
    expect(r.deduped).toEqual({ input: 10, output: 2, total: 12, cached: 0 });
    expect(r.uniqueRequests).toBe(1);
    expect(r.reusedCalls).toBe(1);
  });

  it("C. splitPrice:有费率 cost 精确、无费率 null", () => {
    expect(splitPrice({ usage: { input: 1000, output: 0 }, rate: { inputPer1M: 3, outputPer1M: 15 } }).decision.cost).toBe(0.003);
    expect(splitPrice({ usage: { input: 1000, output: 0 } }).decision.cost).toBeNull();
  });

  it("A'. 同消息不同键序 → 同指纹(键序无关进到接线层)", () => {
    const a = envelopeFingerprint({ model: "m", messages: [{ role: "user", content: "x" }], tools: [{ name: "t", description: "d" }] });
    const b = envelopeFingerprint({ tools: [{ description: "d", name: "t" }], messages: [{ content: "x", role: "user" }], model: "m" });
    expect(a).toBe(b);
  });
});

/** 等异步落盘+指针事件(写盘是 fire-and-forget,append 在 writeFile 之后)。 */
const waitFor = async <T>(fn: () => T | undefined, ms = 3000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error("等待 llm.trace 指针事件超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("llm-trace.ts 白名单透传 envelope()", () => {
  it("⑥ 源码:payload 显式补 envelope 透传,且非 16 hex 不收", () => {
    const s = src("../src/llm-trace.ts");
    expect(s).toContain("function envelopeOf(info: LlmCallTrace): string | undefined");
    expect(s).toContain("/^[0-9a-f]{16}$/.test(v) ? v : undefined");
    expect(s).toContain("...(env ? { envelope: env } : {}),");
  });

  it("⑦ 行为:传入 envelope → journal llm.trace payload 原样带 envelope(写盘文件仍照旧)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "env-wiring-"));
    const events: Array<Record<string, unknown>> = [];
    const journal = { append: (e: Record<string, unknown>) => { events.push(e); } } as unknown as Journal;
    const sink = makeLlmTraceSink(journal, dir, join(dir, "drop.log"));
    const fp = "0123456789abcdef";
    sink({
      sessionId: "web-m56", turn: 1, step: 0, model: "m", durationMs: 10,
      messages: [{ role: "user", content: "hi" }],
      toolNames: [], tools: [],
      response: { content: "ok", usage: { inputTokens: 10, outputTokens: 2 } },
      envelope: fp,
    } as never);
    const ev = await waitFor(() => events.find((e) => e.kind === "llm.trace"));
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.envelope).toBe(fp);
    expect(typeof payload.file).toBe("string");
    expect(readdirSync(join(dir, "web-m56")).some((f) => /^call-0001-t1s0-\d+\.json$/.test(f))).toBe(true);
  });

  it("⑧ 行为:缺失 envelope → payload 无该键(旧 journal 形状不变);非法值同样不收", async () => {
    const dir = mkdtempSync(join(tmpdir(), "env-wiring-off-"));
    const events: Array<Record<string, unknown>> = [];
    const journal = { append: (e: Record<string, unknown>) => { events.push(e); } } as unknown as Journal;
    const sink = makeLlmTraceSink(journal, dir, join(dir, "drop.log"));
    const base = {
      sessionId: "web-m56b", turn: 1, step: 0, model: "m", durationMs: 10,
      messages: [{ role: "user", content: "hi" }],
      toolNames: [], tools: [],
      response: { content: "ok", usage: { inputTokens: 1, outputTokens: 1 } },
    };
    sink({ ...base } as never);
    sink({ ...base, step: 1, envelope: "not-a-fingerprint" } as never);
    await waitFor(() => (events.filter((e) => e.kind === "llm.trace").length >= 2 ? true : undefined));
    for (const e of events.filter((x) => x.kind === "llm.trace")) {
      expect("envelope" in (e.payload as Record<string, unknown>)).toBe(false);
    }
  });
});
