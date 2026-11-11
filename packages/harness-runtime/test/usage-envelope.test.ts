import { describe, it, expect } from "vitest";
import { deriveTraceStats } from "../src/agent/trace-stats";
import {
  stableStringify,
  envelopeFingerprint,
  UsageEnvelopeLedger,
  dedupeUsage,
  splitPrice,
} from "../src/agent/usage-envelope.ts";

describe("stableStringify(确定性序列化)", () => {
  it("对象键序无关:同内容不同键序 → 同一字符串", () => {
    const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
    const b = { c: { x: 2, y: 1 }, a: 2, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("数组保序:[1,2] 与 [2,1] 不同", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
    expect(stableStringify([1, 2])).toBe("[1,2]");
  });

  it("循环引用 → [circular],不抛错", () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    const s = stableStringify(o);
    expect(s).toContain("[circular]");
  });

  it("嵌套对象同样排序;undefined 值的键省略(同 JSON)", () => {
    expect(stableStringify({ z: { b: 1, a: 2 }, a: undefined })).toBe('{"z":{"a":2,"b":1}}');
  });

  it("原始值:字符串带引号、null/布尔原样、NaN → null", () => {
    expect(stableStringify("x")).toBe('"x"');
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(true)).toBe("true");
    expect(stableStringify(Number.NaN)).toBe("null");
  });

  it("非序列化输入(function/symbol)不抛错", () => {
    expect(() => stableStringify({ f: () => 1, s: Symbol("x") })).not.toThrow();
    expect(stableStringify({ f: () => 1 })).toBe("{}");
  });

  it("同一数组里重复出现同一对象不是循环(合法)", () => {
    const shared = { a: 1 };
    expect(stableStringify([shared, shared])).toBe('[{"a":1},{"a":1}]');
  });
});

describe("envelopeFingerprint(信封指纹)", () => {
  const base = { model: "m1", messages: [{ role: "user", content: "hi" }], tools: [{ name: "t" }] };

  it("同输入同值,且是 16 位 hex", () => {
    const a = envelopeFingerprint(base);
    expect(a).toBe(envelopeFingerprint({ ...base }));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("messages 键序无关 → 指纹相同", () => {
    const a = envelopeFingerprint({ model: "m1", messages: [{ role: "user", content: "hi" }], tools: [] });
    const b = envelopeFingerprint({ model: "m1", messages: [{ content: "hi", role: "user" }], tools: [] });
    expect(a).toBe(b);
  });

  it("改 model → 指纹变", () => {
    expect(envelopeFingerprint({ ...base, model: "m2" })).not.toBe(envelopeFingerprint(base));
  });

  it("改 messages 内容或顺序 → 指纹变", () => {
    const changed = envelopeFingerprint({ ...base, messages: [{ role: "user", content: "hi!" }] });
    expect(changed).not.toBe(envelopeFingerprint(base));
    const two = [{ role: "user", content: "a" }, { role: "user", content: "b" }];
    const rev = [two[1], two[0]];
    expect(envelopeFingerprint({ model: "m1", messages: two, tools: [] }))
      .not.toBe(envelopeFingerprint({ model: "m1", messages: rev, tools: [] }));
  });

  it("非法/缺字段输入不抛错,仍返回 16 位 hex", () => {
    const cyc: Record<string, unknown> = { model: "m" };
    cyc.messages = cyc;
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = envelopeFingerprint(cyc as any);
    expect(f).toMatch(/^[0-9a-f]{16}$/);
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(envelopeFingerprint(undefined as any)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("UsageEnvelopeLedger(复用判定)", () => {
  it("探针 A:同请求两次 → 第二次 reused=true", () => {
    const led = new UsageEnvelopeLedger({ now: () => 1000 });
    expect(led.record("fp1")).toEqual({ reused: false, calls: 1, uniqueRequests: 1 });
    expect(led.record("fp1")).toEqual({ reused: true, calls: 2, uniqueRequests: 1 });
  });

  it("不同指纹各自首见 false,calls/uniqueRequests 计数正确", () => {
    const led = new UsageEnvelopeLedger();
    expect(led.record("a").reused).toBe(false);
    expect(led.record("b").reused).toBe(false);
    expect(led.record("a").reused).toBe(true);
    const s = led.stats();
    expect(s.uniqueRequests).toBe(2);
    expect(s.calls).toBe(3);
    expect(s.reusedCalls).toBe(1);
    expect(s.reuseRate).toBe(0.3333); // 1/3 四舍五入 4 位
  });

  it("reset 后重新判首见", () => {
    const led = new UsageEnvelopeLedger();
    led.record("x");
    led.record("x");
    led.reset();
    expect(led.stats()).toEqual({ uniqueRequests: 0, calls: 0, reusedCalls: 0, reuseRate: 0 });
    expect(led.record("x").reused).toBe(false);
  });

  it("空台账 stats 分母为 0 → reuseRate 0,不抛错", () => {
    const led = new UsageEnvelopeLedger();
    expect(led.stats().reuseRate).toBe(0);
    expect(() => led.record("" as unknown as string)).not.toThrow();
  });
});

describe("dedupeUsage(双口径)", () => {
  it("探针 B:display=两次之和、deduped=一次", () => {
    const r = dedupeUsage([
      { fingerprint: "f", usage: { input: 100, output: 10 } },
      { fingerprint: "f", usage: { input: 100, output: 10 } },
    ]);
    expect(r.display).toEqual({ input: 200, output: 20, total: 220, cached: 0 });
    expect(r.deduped).toEqual({ input: 100, output: 10, total: 110, cached: 0 });
    expect(r.reusedCalls).toBe(1);
    expect(r.uniqueRequests).toBe(1);
  });

  it("total 缺省 = input+output;显式 total 逐字保留", () => {
    const r = dedupeUsage([{ fingerprint: "a", usage: { input: 3, output: 4, total: 99 } }]);
    expect(r.display.total).toBe(99);
    const r2 = dedupeUsage([{ fingerprint: "a", usage: { input: 3, output: 4 } }]);
    expect(r2.display.total).toBe(7);
  });

  it("cached 累加并计入总量", () => {
    const r = dedupeUsage([
      { fingerprint: "a", usage: { input: 10, output: 1, cached: 6 } },
      { fingerprint: "b", usage: { input: 5, output: 2, cached: 3 } },
    ]);
    expect(r.display.cached).toBe(9);
    expect(r.deduped.cached).toBe(9);
  });

  it("空数组 → 全 0,不抛错", () => {
    expect(dedupeUsage([])).toEqual({
      display: { input: 0, output: 0, total: 0, cached: 0 },
      deduped: { input: 0, output: 0, total: 0, cached: 0 },
      reusedCalls: 0,
      uniqueRequests: 0,
    });
  });

  it("跨指纹累加:不同指纹都进 deduped", () => {
    const r = dedupeUsage([
      { fingerprint: "a", usage: { input: 1, output: 1 } },
      { fingerprint: "b", usage: { input: 2, output: 2 } },
      { fingerprint: "a", usage: { input: 1, output: 1 } },
    ]);
    expect(r.deduped).toEqual({ input: 3, output: 3, total: 6, cached: 0 });
    expect(r.display.input).toBe(4);
    expect(r.uniqueRequests).toBe(2);
    expect(r.reusedCalls).toBe(1);
  });

  it("入参不被修改(entries 与 usage 逐字保留)", () => {
    const entries = [
      { fingerprint: "a", usage: { input: 1, output: 2 } },
      { fingerprint: "a", usage: { input: 3, output: 4, cached: 5 } },
    ];
    const snapshot = JSON.parse(JSON.stringify(entries));
    dedupeUsage(entries);
    expect(entries).toEqual(snapshot);
  });

  it("返回对象不可变", () => {
    const r = dedupeUsage([{ fingerprint: "a", usage: { input: 1, output: 1 } }]);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.display)).toBe(true);
    expect(Object.isFrozen(r.deduped)).toBe(true);
  });

  it("确定性:两次调用 deepEqual", () => {
    const mk = () => [{ fingerprint: "k", usage: { input: 9, output: 8, cached: 2 } }];
    expect(dedupeUsage(mk())).toEqual(dedupeUsage(mk()));
  });
});

describe("trace-stats 消费端(探针 E/正例)", () => {
  const msgAgent = (input: number, output: number) => ({
    kind: "message.agent",
    payload: { usage: { inputTokens: input, outputTokens: output, totalTokens: input + output }, llmMs: 5 },
  });
  const traceWithEnv = (env: string, input: number, output: number, error?: string) => ({
    kind: "llm.trace",
    payload: {
      envelope: env,
      usage: { inputTokens: input, outputTokens: output, totalTokens: input + output },
      ...(error ? { error } : {}),
    },
  });

  it("探针 E:旧事件(无 envelope)→ 不出现 usageEnvelope/tokensDeduped,tokens 原值不变", () => {
    const r = deriveTraceStats([msgAgent(100, 10), msgAgent(50, 5)]);
    expect(r.usageEnvelope).toBeUndefined();
    expect(r.tokensDeduped).toBeUndefined();
    expect(r.tokens).toEqual({ input: 150, output: 15, total: 165, cached: 0 });
 // 也不能因为「没 envelope」凭空造键(Object.keys 里没有)
    expect(Object.keys(r)).not.toContain("usageEnvelope");
    expect(Object.keys(r)).not.toContain("tokensDeduped");
  });

  it("正例:同信封两次 → usageEnvelope 复用统计 + tokensDeduped 只算一次;tokens 展示口径不变", () => {
    const r = deriveTraceStats([
      msgAgent(100, 10),
      traceWithEnv("e1", 100, 10),
      msgAgent(100, 10),
      traceWithEnv("e1", 100, 10),
    ]);
    expect(r.usageEnvelope).toEqual({ uniqueRequests: 1, reusedCalls: 1, reuseRate: 0.5 });
    expect(r.tokensDeduped).toEqual({ input: 100, output: 10, total: 110, cached: 0 });
    expect(r.tokens).toEqual({ input: 200, output: 20, total: 220, cached: 0 }); // 展示口径逐次累加,不动
  });

  it("失败调用(llm.trace 带 error)的信封也采集(失败 break 之前)", () => {
    const r = deriveTraceStats([traceWithEnv("e1", 10, 0), traceWithEnv("e2", 20, 0, "boom")]);
    expect(r.llmFailures).toBe(1);
    expect(r.usageEnvelope).toEqual({ uniqueRequests: 2, reusedCalls: 0, reuseRate: 0 });
    expect(r.tokensDeduped).toEqual({ input: 30, output: 0, total: 30, cached: 0 });
  });

  it("无 usage 的 envelope 事件不进去重表", () => {
    const r = deriveTraceStats([
      { kind: "llm.trace", payload: { envelope: "only-env", error: "x" } },
      traceWithEnv("only-env", 5, 1),
    ]);
    expect(r.usageEnvelope).toEqual({ uniqueRequests: 1, reusedCalls: 0, reuseRate: 0 });
    expect(r.tokensDeduped?.input).toBe(5);
  });
});

describe("splitPrice(拆价)", () => {
  it("探针 C:有费率 cost 精确到 6 位", () => {
    const r = splitPrice(
      { usage: { input: 1000, output: 500 }, rate: { inputPer1M: 3, outputPer1M: 15 } },
      { currency: "USD" },
    );
 // 1000/1e6*3 = 0.003; 500/1e6*15 = 0.0075 → 0.0105
    expect(r.decision.cost).toBe(0.0105);
    expect(r.currency).toBe("USD");
  });

  it("cachedPer1M 缺失 → cached token 不计入成本(不拿 input 费率冒充缓存价)", () => {
    const withCached = splitPrice({ usage: { input: 1000, output: 0, cached: 900 }, rate: { inputPer1M: 3, outputPer1M: 15 } });
    const withoutCached = splitPrice({ usage: { input: 1000, output: 0, cached: 0 }, rate: { inputPer1M: 3, outputPer1M: 15 } });
    expect(withCached.decision.cost).toBe(withoutCached.decision.cost);
    expect(withCached.decision.cachedTokens).toBe(900); // 但 token 数如实给出
  });

  it("cachedPer1M 存在 → cached 段按缓存费率单列", () => {
    const r = splitPrice({
      usage: { input: 1000, output: 0, cached: 1000 },
      rate: { inputPer1M: 3, outputPer1M: 15, cachedPer1M: 0.3 },
    });
 // 0.003 + 0.0003 = 0.0033
    expect(r.decision.cost).toBe(0.0033);
  });

  it("无费率 → cost=null,不猜不抛", () => {
    const r = splitPrice({ usage: { input: 10, output: 10 } });
    expect(r.decision.cost).toBeNull();
  });

  it("非法费率(NaN/负数/非数字)→ cost=null", () => {
    expect(splitPrice({ usage: { input: 1, output: 1 }, rate: { inputPer1M: Number.NaN, outputPer1M: 1 } }).decision.cost).toBeNull();
    expect(splitPrice({ usage: { input: 1, output: 1 }, rate: { inputPer1M: -1, outputPer1M: 1 } }).decision.cost).toBeNull();
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(splitPrice({ usage: { input: 1, output: 1 }, rate: { inputPer1M: "3" as any, outputPer1M: 1 } }).decision.cost).toBeNull();
    expect(splitPrice({ usage: { input: 1, output: 1 }, rate: { inputPer1M: 3 } as unknown as { inputPer1M: number; outputPer1M: number } }).decision.cost).toBeNull();
  });

  it("display tokens 逐字来自 usage(不归一、不补 0)", () => {
    const usage = { input: 123, output: 45, total: 999, cached: 7 };
    const r = splitPrice({ usage, rate: { inputPer1M: 1, outputPer1M: 1 } });
    expect(r.display).toEqual({ input: 123, output: 45, total: 999, cached: 7 });
    expect(r.display).not.toBe(usage); // 复制,非同一引用
    expect(usage).toEqual({ input: 123, output: 45, total: 999, cached: 7 });
  });

  it("返回不可变(结果/display/decision 均冻结)", () => {
    const r = splitPrice({ usage: { input: 1, output: 1 }, rate: { inputPer1M: 1, outputPer1M: 1 } });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.display)).toBe(true);
    expect(Object.isFrozen(r.decision)).toBe(true);
  });

  it("currency 缺省 USD,且明确只做标记不换算", () => {
    expect(splitPrice({ usage: { input: 1, output: 1 } }).currency).toBe("USD");
    expect(splitPrice({ usage: { input: 1, output: 1 } }, { currency: "CNY" }).currency).toBe("CNY");
    const usd = splitPrice({ usage: { input: 1000, output: 0 }, rate: { inputPer1M: 3, outputPer1M: 15 } }, { currency: "USD" });
    const cny = splitPrice({ usage: { input: 1000, output: 0 }, rate: { inputPer1M: 3, outputPer1M: 15 } }, { currency: "CNY" });
    expect(cny.decision.cost).toBe(usd.decision.cost); // 同一费率下只换标记
  });

  it("确定性:两次调用 deepEqual", () => {
    const args = () => ({ usage: { input: 7, output: 9, cached: 3 }, rate: { inputPer1M: 2, outputPer1M: 8, cachedPer1M: 0.5 } });
    expect(splitPrice(args())).toEqual(splitPrice(args()));
    expect(splitPrice(args()).decision.cost).toBe(0.000088); // 7*2+9*8+3*0.5 = 87.5 /1e6 = 0.0000875 → 6 位
  });
});
