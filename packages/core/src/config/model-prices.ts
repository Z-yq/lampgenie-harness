/**
 * 模型单价表(2026-10-28 用户口径「追踪面板要显示花了多少元:缓存命中/未命中/输出分别是多少」)。
 *
 * 数据同源红线:每个数字都来自官方定价页(见每条的 source + fetchedAt),不做「看起来合理」的猜测。
 * - 官方页直接给人民币的直取(DeepSeek/智谱/Kimi/百炼);
 * - 只给美元的按 USD_CNY 折算,并在 note 写明原始美元价与「折算用,非官方汇率」;
 * - 官方页未单列的段(如智谱缓存存储「限时免费」、百炼只给缓存折扣比例)一律 null,不写 0 —— 
 *   「未知」与「免费」是两件事,写 0 会把未知伪装成事实。
 *
 * 单位统一为「元 / 百万 token」(与各家报价习惯一致);resolveModelPrice 返回该口径的价目。
 * 覆盖优先级:模型条目显式 price(设置台可填)> 内置表最长前缀匹配 > null(UI 显示「未配单价」)。
 */
import type { Config } from "./schema.js";

/** 一段单价(元 / 百万 token);null=官方未单列该段。 */
export interface ModelPriceRow {
  /** 模型名前缀(最长前缀优先命中)。 */
  prefix: string;
  currency: "CNY";
  /** 缓存命中读取的输入单价。 */
  cacheRead: number | null;
  /** 缓存写入单价(Anthropic cache_creation / Kimi 缓存写入;null=官方未单列)。 */
  cacheWrite: number | null;
  /** 缓存未命中的输入单价。 */
  inputMiss: number;
  /** 输出单价。 */
  output: number;
  /** 真源:官方定价页 URL。 */
  source: string;
  /** 抓取日期(YYYY-MM-DD)。 */
  fetchedAt: string;
  note?: string;
}

/** 美元→人民币折算比(仅用于把官方美元价换成元展示;非官方汇率)。 */
export const USD_CNY = 7.1;

export const MODEL_PRICES: ModelPriceRow[] = [
  // ── DeepSeek(官方页直接给人民币;取高峰时段价,空闲时段为其一半) ──
  {
    prefix: "deepseek-flash", currency: "CNY", cacheRead: 0.04, cacheWrite: null, inputMiss: 2, output: 8,
    source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing", fetchedAt: "2026-10-28",
    note: "高峰时段价;空闲时段 0.02/1/4 元。官方未单列缓存写入价",
  },
  {
    prefix: "deepseek-v4-pro", currency: "CNY", cacheRead: 0.3, cacheWrite: null, inputMiss: 9, output: 27,
    source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing", fetchedAt: "2026-10-28",
    note: "高峰时段价;空闲时段 0.15/4.5/13.5 元。官方未单列缓存写入价",
  },
  // ── Anthropic(官方页 USD/MTok ×7.1 折算;原始美元见 note) ──
  {
    prefix: "claude-fable-5-1", currency: "CNY", cacheRead: 1.775, cacheWrite: 88.75, inputMiss: 71, output: 355,
    source: "https://claude.com/pricing", fetchedAt: "2026-10-28",
    note: "官方 $0.25/$12.50/$10/$50 ×7.1(折算用,非官方汇率)",
  },
  {
    prefix: "claude-fable-5", currency: "CNY", cacheRead: 7.1, cacheWrite: 88.75, inputMiss: 71, output: 355,
    source: "https://claude.com/pricing", fetchedAt: "2026-10-28",
    note: "官方 $1/$12.50/$10/$50 ×7.1(Legacy 段)",
  },
  {
    prefix: "claude-opus-5-5", currency: "CNY", cacheRead: 1.42, cacheWrite: 35.5, inputMiss: 28.4, output: 142,
    source: "https://claude.com/pricing", fetchedAt: "2026-10-28",
    note: "官方 $0.20/$5/$4/$20 ×7.1",
  },
  {
    prefix: "claude-opus-5", currency: "CNY", cacheRead: 3.55, cacheWrite: 44.375, inputMiss: 35.5, output: 177.5,
    source: "https://claude.com/pricing", fetchedAt: "2026-10-28",
    note: "官方 $0.50/$6.25/$5/$25 ×7.1(Legacy 段)",
  },
  {
    prefix: "claude-sonnet-5-5", currency: "CNY", cacheRead: 0.71, cacheWrite: 17.75, inputMiss: 14.2, output: 71,
    source: "https://claude.com/pricing", fetchedAt: "2026-10-28",
    note: "官方 $0.10/$2.50/$2/$10 ×7.1",
  },
  {
    prefix: "claude-sonnet-5", currency: "CNY", cacheRead: 1.42, cacheWrite: 17.75, inputMiss: 14.2, output: 71,
    source: "https://claude.com/pricing", fetchedAt: "2026-10-28",
    note: "官方 $0.20/$2.50/$2/$10 ×7.1(Legacy 段)",
  },
  {
    prefix: "claude-haiku-4-5", currency: "CNY", cacheRead: 0.71, cacheWrite: 8.875, inputMiss: 7.1, output: 35.5,
    source: "https://claude.com/pricing", fetchedAt: "2026-10-28",
    note: "官方 $0.10/$1.25/$1/$5 ×7.1(Legacy 段)",
  },
  // ── 智谱 GLM(官方页给人民币;缓存存储「限时免费」不是 0 元定价,故 cacheWrite=null) ──
  {
    prefix: "glm-5.3-flashx", currency: "CNY", cacheRead: 0.57, cacheWrite: null, inputMiss: 2, output: 7,
    source: "https://open.bigmodel.cn/pricing", fetchedAt: "2026-10-28",
    note: "缓存存储限时免费,官方未给单价",
  },
  {
    prefix: "glm-5.3-flash", currency: "CNY", cacheRead: 0.23, cacheWrite: null, inputMiss: 0.8, output: 2.8,
    source: "https://open.bigmodel.cn/pricing", fetchedAt: "2026-10-28",
    note: "缓存存储限时免费,官方未给单价",
  },
  {
    prefix: "glm-5.3", currency: "CNY", cacheRead: 2, cacheWrite: null, inputMiss: 8, output: 28,
    source: "https://open.bigmodel.cn/pricing", fetchedAt: "2026-10-28",
    note: "缓存存储限时免费,官方未给单价",
  },
  // ── 月之暗面 Kimi(官方页给人民币;cacheWrite 取 5min TTL 档) ──
  {
    prefix: "kimi-k3.1-pro-highspeed", currency: "CNY", cacheRead: 1.3, cacheWrite: 26, inputMiss: 26, output: 136,
    source: "https://platform.moonshot.cn/docs/pricing/chat", fetchedAt: "2026-10-28",
    note: "缓存写入取 5min TTL;1h TTL 为 26 元输入/52 元写入",
  },
  {
    prefix: "kimi-k3.1-pro", currency: "CNY", cacheRead: 1.3, cacheWrite: 13, inputMiss: 13, output: 68,
    source: "https://platform.moonshot.cn/docs/pricing/chat", fetchedAt: "2026-10-28",
    note: "缓存写入取 5min TTL;1h TTL 为 26 元写入",
  },
  {
    prefix: "kimi-k3", currency: "CNY", cacheRead: 2, cacheWrite: 20, inputMiss: 20, output: 100,
    source: "https://platform.moonshot.cn/docs/pricing/chat", fetchedAt: "2026-10-28",
    note: "缓存写入取 5min TTL;1h TTL 为 40 元写入",
  },
  {
    prefix: "kimi-k2.7-code", currency: "CNY", cacheRead: 1.3, cacheWrite: null, inputMiss: 6.5, output: 27,
    source: "https://platform.moonshot.cn/docs/pricing/chat", fetchedAt: "2026-10-28",
    note: "K2 系列表未单列缓存写入价(自动缓存)",
  },
  {
    prefix: "kimi-k2.6", currency: "CNY", cacheRead: 1.1, cacheWrite: null, inputMiss: 6.5, output: 27,
    source: "https://platform.moonshot.cn/docs/pricing/chat", fetchedAt: "2026-10-28",
    note: "K2 系列表未单列缓存写入价(自动缓存)",
  },
  // ── 阿里云百炼 通义千问(官方页只给缓存折扣比例,未列单价 → cacheRead/cacheWrite=null) ──
  {
    prefix: "qwen3.8-max", currency: "CNY", cacheRead: null, cacheWrite: null, inputMiss: 12, output: 36,
    source: "https://help.aliyun.com/zh/model-studio/model-pricing", fetchedAt: "2026-10-28",
    note: "缓存仅给规则(显式创建 125%、命中 10%),未列单价",
  },
  {
    prefix: "qwen3.8-flash", currency: "CNY", cacheRead: null, cacheWrite: null, inputMiss: 0.8, output: 2.7,
    source: "https://help.aliyun.com/zh/model-studio/model-pricing", fetchedAt: "2026-10-28",
    note: "缓存单价官方页未列(该模型比例为例外)",
  },
  {
    prefix: "qwen3.7-plus", currency: "CNY", cacheRead: null, cacheWrite: null, inputMiss: 2, output: 8,
    source: "https://help.aliyun.com/zh/model-studio/model-pricing", fetchedAt: "2026-10-28",
    note: "≤256K 档;缓存单价官方页未列",
  },
  {
    prefix: "qwen3.7-flash", currency: "CNY", cacheRead: null, cacheWrite: null, inputMiss: 0.2, output: 0.8,
    source: "https://help.aliyun.com/zh/model-studio/model-pricing", fetchedAt: "2026-10-28",
    note: "≤32K 档(32K-256K 为 0.6/2.4);缓存单价官方页未列",
  },
];

/** 模型条目上用户可填的单价覆盖(设置台「模型设置」;单位同内置表)。 */
export type ModelPriceOverride = {
  cacheRead?: number | null;
  cacheWrite?: number | null;
  inputMiss?: number;
  output?: number;
};

function entryOf(config: Config | undefined, model: string): ModelPriceOverride | undefined {
  if (!config) return undefined;
  for (const p of config.providers ?? []) {
    for (const m of p.models ?? []) {
      if (typeof m === "string" || m.name !== model) continue;
      const price = (m as { price?: ModelPriceOverride }).price;
      if (price) return price;
    }
  }
  return undefined;
}

/**
 * 解析一个模型的单价:配置覆盖 > 内置表最长前缀 > null(未配单价,UI 必须如实显示而不是 0 元)。
 * override 只为填的段生效,未填段回落到内置表同名字段;内置也缺则 null。
 */
export function resolveModelPrice(config: Config | undefined, model: string | undefined): ModelPriceRow | null {
  const name = (model ?? "").trim();
  if (!name) return null;
  const override = entryOf(config, name);
  const lower = name.toLowerCase();
  let best: ModelPriceRow | undefined;
  for (const row of MODEL_PRICES) {
    if (!lower.startsWith(row.prefix.toLowerCase())) continue;
    if (!best || row.prefix.length > best.prefix.length) best = row;
  }
  if (override) {
    const inputMiss = override.inputMiss ?? best?.inputMiss;
    const output = override.output ?? best?.output;
    if (inputMiss === undefined || output === undefined) return null;
    return {
      prefix: best?.prefix ?? name,
      currency: "CNY",
      cacheRead: override.cacheRead !== undefined ? override.cacheRead : best?.cacheRead ?? null,
      cacheWrite: override.cacheWrite !== undefined ? override.cacheWrite : best?.cacheWrite ?? null,
      inputMiss,
      output,
      source: best?.source ?? "设置台模型单价",
      fetchedAt: best?.fetchedAt ?? "",
      note: "单价来自设置台覆盖" + (best?.note ? ";" + best.note : ""),
    };
  }
  return best ?? null;
}
