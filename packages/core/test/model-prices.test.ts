/**
 * 模型单价表 + 成本核算单测。
 * 守护三件事:①内置表每条都带官方来源与抓取日期(数据同源红线);
 * ②最长前缀匹配;③单价缺失不按 0 元算(total/missing 语义)。
 */
import { describe, it, expect } from "vitest";
import { MODEL_PRICES, resolveModelPrice, USD_CNY } from "../src/config/model-prices.js";
import { computeCost, billingForModel, formatYuan } from "../src/config/model-cost.js";
import type { Config } from "../src/config/schema.js";

const cfgWith = (models: unknown[]): Config => ({ providers: [{ id: "p", name: "p", baseUrl: "https://x", models }] }) as unknown as Config;

describe("内置价目表", () => {
  it("每条都有官方来源 URL 与抓取日期(禁止无真源价格)", () => {
    expect(MODEL_PRICES.length).toBeGreaterThanOrEqual(10);
    for (const row of MODEL_PRICES) {
      expect(row.source, row.prefix).toMatch(/^https:\/\//);
      expect(row.fetchedAt, row.prefix).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.currency).toBe("CNY");
      expect(row.inputMiss).toBeGreaterThanOrEqual(0);
      expect(row.output).toBeGreaterThanOrEqual(0);
    }
  });

  it("覆盖三家以上厂商(DeepSeek/Anthropic/智谱/Kimi/百炼)", () => {
    const hosts = new Set(MODEL_PRICES.map((r) => new URL(r.source).host));
    expect(hosts.size).toBeGreaterThanOrEqual(4);
  });

  it("汇率常量标注为折算用", () => {
    expect(USD_CNY).toBeGreaterThan(1);
  });

  it("最长前缀优先:glm-5.3-flashx 不落到 glm-5.3", () => {
    const p = resolveModelPrice(undefined, "glm-5.3-flashx");
    expect(p?.prefix).toBe("glm-5.3-flashx");
    expect(p?.inputMiss).toBe(2);
  });

  it("未收录模型返回 null(不猜价格)", () => {
    expect(resolveModelPrice(undefined, "some-unknown-model")).toBeNull();
    expect(resolveModelPrice(undefined, "")).toBeNull();
  });

  it("配置 price 覆盖内置价,未填段回落内置", () => {
    const cfg = cfgWith([{ name: "glm-5.3-flash", price: { output: 99 } }]);
    const p = resolveModelPrice(cfg, "glm-5.3-flash");
    expect(p?.output).toBe(99);
    expect(p?.inputMiss).toBe(0.8); // 内置值
    expect(p?.cacheRead).toBe(0.23);
  });

  it("配置只填了部分且内置也没有 → 未命中/输出缺失时返回 null", () => {
    const cfg = cfgWith([{ name: "brand-new-model", price: { cacheRead: 1 } }]);
    expect(resolveModelPrice(cfg, "brand-new-model")).toBeNull();
  });
});

describe("计费门(2026-10-28 只有 API 调用显示元,token 套餐不显示)", () => {
  const cfgOf = (authMode?: "api" | "token-plan"): Config =>
    ({ providers: [{ id: "p", name: "p", baseUrl: "https://x", ...(authMode ? { authMode } : {}), models: ["glm-5.3-flash"] }] }) as unknown as Config;
  const usage = { input: 1_000_000, cached: 0, cacheWrite: 0, output: 0 };

  it("token-plan 端点:不出金额(billed=false,price/cost 都 null)", () => {
    const b = billingForModel(cfgOf("token-plan"), "glm-5.3-flash", usage);
    expect(b.authMode).toBe("token-plan");
    expect(b.billed).toBe(false);
    expect(b.price).toBeNull();
    expect(b.cost).toBeNull();
  });

  it("authMode 缺省=按量计费:出金额", () => {
    const b = billingForModel(cfgOf(undefined), "glm-5.3-flash", usage);
    expect(b.authMode).toBe("api");
    expect(b.billed).toBe(true);
    expect(b.cost?.inputMiss.amount).toBeCloseTo(0.8, 6); // 0.8 元/百万 tok × 1M
  });

  it("api 但模型无单价:price/cost null(前端显示未配单价,不写 0 元)", () => {
    const b = billingForModel(
      { providers: [{ id: "p", name: "p", baseUrl: "https://x", models: ["no-price-model"] }] } as unknown as Config,
      "no-price-model", usage);
    expect(b.billed).toBe(true);
    expect(b.price).toBeNull();
    expect(b.cost).toBeNull();
  });
});

describe("成本核算", () => {
  const price = { prefix: "t", currency: "CNY", cacheRead: 1, cacheWrite: 2, inputMiss: 3, output: 4, source: "https://x", fetchedAt: "2026-10-28" } as const;

  it("四段互斥:未命中=输入-命中-写入", () => {
    const c = computeCost({ input: 1_000_000, cached: 400_000, cacheWrite: 100_000, output: 200_000 }, price);
    expect(c).not.toBeNull();
    expect(c!.missTokens).toBe(500_000);
    expect(c!.cacheRead.amount).toBeCloseTo(0.4, 6);
    expect(c!.cacheWrite.amount).toBeCloseTo(0.2, 6);
    expect(c!.inputMiss.amount).toBeCloseTo(1.5, 6);
    expect(c!.output.amount).toBeCloseTo(0.8, 6);
    expect(c!.total).toBeCloseTo(2.9, 6);
    expect(c!.missing).toEqual([]);
  });

  it("脏数据:命中大于输入时未命中断 0,不出现负数金额", () => {
    const c = computeCost({ input: 100, cached: 900, cacheWrite: 0, output: 10 }, price);
    expect(c!.missTokens).toBe(0);
    expect(c!.inputMiss.amount).toBe(0);
    expect(c!.total).toBeGreaterThanOrEqual(0);
  });

  it("某段官方未单列(price=null)且该段有量 → 该段 null,total null,missing 点名", () => {
    const p2 = { ...price, cacheWrite: null } as never;
    const c = computeCost({ input: 1_000_000, cached: 0, cacheWrite: 100_000, output: 0 }, p2);
    expect(c!.cacheWrite.amount).toBeNull();
    expect(c!.missing).toContain("cacheWrite");
    expect(c!.total).toBeNull(); // 不给出真假混算的总数
  });

  it("未单列的段量为 0 时不算缺失(total 照常可算)", () => {
    const p2 = { ...price, cacheWrite: null } as never;
    const c = computeCost({ input: 1_000_000, cached: 500_000, cacheWrite: 0, output: 0 }, p2);
    expect(c!.missing).toEqual([]);
    expect(c!.total).not.toBeNull();
  });

  it("price=null 时返回 null(调用方显示「未配单价」而不是 0 元)", () => {
    expect(computeCost({ input: 1, cached: 0, cacheWrite: 0, output: 1 }, null)).toBeNull();
  });

  it("金额展示:小额不显示成 0.00", () => {
    expect(formatYuan(null)).toBe("—");
    expect(formatYuan(12.3456)).toBe("12.35");
    expect(formatYuan(0.1234)).toBe("0.123");
    expect(formatYuan(0.00012)).toBe("0.0001");
  });
});
