/**
 * 成本核算(2026-10-28 用户口径「显示成本消耗多少元:缓存多少、未命中多少、输出多少」)。
 *
 * 口径来源(与 provider 层产出严格对齐,不自己发明分段):
 *   usage.inputTokens  = 输入总量(input + 缓存命中读取 + 缓存写入;Anthropic 原生口径三者求和,
 *                        OpenAI 兼容口径 prompt_tokens 本身已含 cached —— 见
 *                        packages/harness-runtime/src/agent/provider-apitypes.ts 的 anthropicUsageOut)
 *   usage.cachedTokens = 缓存命中读取量(cache_read_input_tokens / prompt_tokens_details.cached_tokens)
 *   usage.cacheCreationTokens = 缓存写入量(cache_creation_input_tokens;仅 Anthropic 原生下发)
 *   usage.outputTokens = 输出量
 * 于是三段互斥:未命中输入 = max(0, input - cached - cacheWrite)。
 *
 * 单价缺失(nulls)不按 0 算:该段金额返回 null 并列入 missing,由 UI 如实显示「该段未配单价」。
 */
import type { ModelPriceRow } from "./model-prices.js";
import { resolveModelPrice } from "./model-prices.js";
import { findModelProvider } from "./model-route.js";
import type { Config } from "./schema.js";

export interface UsageSplit {
  /** 输入总量(含缓存命中与写入)。 */
  input: number;
  /** 缓存命中读取量。 */
  cached: number;
  /** 缓存写入量(可能缺省=0)。 */
  cacheWrite: number;
  /** 输出量。 */
  output: number;
}

export interface CostSection {
  /** 该段 token 量。 */
  tokens: number;
  /** 该段单价(元 / 百万 token);null=官方未单列。 */
  pricePerMTok: number | null;
  /** 该段金额(元);单价缺失时 null。 */
  amount: number | null;
}

export interface CostBreakdown {
  currency: "CNY";
  /** 缓存命中(读缓存)。 */
  cacheRead: CostSection;
  /** 缓存写入。 */
  cacheWrite: CostSection;
  /** 缓存未命中的输入。 */
  inputMiss: CostSection;
  /** 输出。 */
  output: CostSection;
  /** 四段之和(元);任一段单价缺失时 null(不给出真假混算的总数)。 */
  total: number | null;
  /** 单价缺失的段名(UI 据此标注)。 */
  missing: ("cacheRead" | "cacheWrite" | "inputMiss" | "output")[];
  /** 未命中=输入-命中-写入(负数钳 0;命中量大于输入量的脏数据不反向计入)。 */
  missTokens: number;
}

function section(tokens: number, pricePerMTok: number | null): CostSection {
  if (pricePerMTok === null) return { tokens, pricePerMTok: null, amount: null };
  return { tokens, pricePerMTok, amount: (tokens / 1_000_000) * pricePerMTok };
}

/** 按单价把 usage 拆成四段成本。price=null 时返回 null(调用方显示「未配单价」)。 */
export function computeCost(usage: UsageSplit, price: ModelPriceRow | null): CostBreakdown | null {
  if (!price) return null;
  const input = Math.max(0, usage.input || 0);
  const cached = Math.max(0, usage.cached || 0);
  const cacheWrite = Math.max(0, usage.cacheWrite || 0);
  const output = Math.max(0, usage.output || 0);
  const missTokens = Math.max(0, input - cached - cacheWrite);
  const cacheRead = section(cached, price.cacheRead);
  const writeSec = section(cacheWrite, price.cacheWrite);
  const missSec = section(missTokens, price.inputMiss);
  const outSec = section(output, price.output);
  const missing: CostBreakdown["missing"] = [];
  if (cacheRead.amount === null && cached > 0) missing.push("cacheRead");
  if (writeSec.amount === null && cacheWrite > 0) missing.push("cacheWrite");
  // inputMiss/output 单价在 ModelPriceRow 里是必填 number,不会缺失;仍做防御性判断。
  if (missSec.amount === null && missTokens > 0) missing.push("inputMiss");
  if (outSec.amount === null && output > 0) missing.push("output");
  const amounts = [cacheRead.amount, writeSec.amount, missSec.amount, outSec.amount];
  const total = missing.length === 0 ? amounts.reduce<number>((a, b) => a + (b ?? 0), 0) : null;
  return {
    currency: "CNY",
    cacheRead,
    cacheWrite: writeSec,
    inputMiss: missSec,
    output: outSec,
    total,
    missing,
    missTokens,
  };
}

/**
 * 计费门 + 成本 的单点判定(2026-10-28 用户口径「只有 API 调用的才显示多少元,token plan 的不用显示」)。
 *
 * 计费门逻辑收敛在此处而不是散在 server.ts 里,保证「哪里出账」只有一份口径:
 *   providers[].authMode === "token-plan"(订阅套餐)→ billed=false,price/cost 都为 null,
 *   前端据此**不渲染任何金额**(套餐已包月,再算「花了多少钱」是假账);
 *   其余(含 undefined=api)→ billed=true,按 resolveModelPrice 找单价、computeCost 算四段;
 *   单价缺失 → price=null、cost=null,前端如实显示「未配单价」,绝不按 0 元冒充真账。
 */
export interface ModelBilling {
  model: string;
  /** 端点计费方式:api=按量计费(出金额)/ token-plan=订阅套餐(不出金额)。 */
  authMode: "api" | "token-plan";
  /** 是否参与金额核算(仅 api)。 */
  billed: boolean;
  price: ModelPriceRow | null;
  cost: CostBreakdown | null;
}

export function billingForModel(
  config: Config | undefined,
  model: string,
  usage: UsageSplit,
): ModelBilling {
  const owner = findModelProvider(config as never, model);
  const authMode = owner?.authMode === "token-plan" ? "token-plan" : "api";
  if (authMode !== "api") return { model, authMode, billed: false, price: null, cost: null };
  const price = resolveModelPrice(config, model);
  return { model, authMode, billed: true, price, cost: computeCost(usage, price) };
}

/** 金额展示:≥1 元两位小数,<1 元四位小数(小额不显示成 0.00);null → 「—」。 */
export function formatYuan(amount: number | null): string {
  if (amount === null) return "—";
  if (amount >= 1) return amount.toFixed(2);
  if (amount >= 0.01) return amount.toFixed(3);
  return amount.toFixed(4);
}
