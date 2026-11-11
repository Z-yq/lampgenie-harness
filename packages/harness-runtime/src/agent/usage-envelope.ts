/**
 * usage-envelope(2026-11,纯逻辑零 IO):请求「信封」指纹 + 用量双口径核算。
 * ## 为什么展示与决策要两套口径
 * 旧的展示口径(`TraceStats.tokens`)是**逐次调用求和**:每次 `message.agent` 的 API usage 原值
 * 直接累加。这是诚实的账单口径——用户问「这一轮烧了多少 token」,答案就是 API 报了多少加多少。
 * 但把它当**决策口径**会系统性高估:agent loop 是同一条会话反复重发**几乎相同的信封**
 * (同一 model + 同一 messages 前缀 + 同一 tools),真正新增的只有尾部几条。用「逐次求和」去喂
 * 预算/压缩/告警,等于把同一份上下文按调用次数重复计费——缓存命中价与首次价被糊在一起,
 * 压缩阈值会提前误触发。
 * 所以这里再给一套 `deduped` 口径:按信封指纹去重,**每个唯一请求只计一次**。两套数并存:
 * - `display` = API 原值逐次累加(给人看,不解释、不修正)
 * - `deduped` = 唯一请求口径(给决策用:预算、压缩、复用率)
 * 两者都**不修改**入参、都不 throw:任何非法输入走安全返回,确定性(同输入同输出),
 * 便于在测试里断言、在面板上对照。
 */

import { createHash } from "node:crypto";

/** 计价费率(每 100 万 token 的价格)。`cachedPer1M` 缺失 = 该 provider/套餐不单列缓存价。 */
export interface UsageRate {
  inputPer1M: number;
  outputPer1M: number;
  cachedPer1M?: number;
}

/** 单次调用的用量(与 provider usage 的映射名一致;total/cached 可缺)。 */
export interface EnvelopeUsage {
  input: number;
  output: number;
  total?: number;
  cached?: number;
}

/** 归一后的用量形状(四个字段都补齐)。 */
export interface FlatUsage {
  input: number;
  output: number;
  total: number;
  cached: number;
}

/** dedupeUsage 的入参条目:一次调用 = 一个指纹 + 一次 API 用量。 */
export interface UsageEnvelopeEntry {
  fingerprint: string;
  usage: EnvelopeUsage;
}

/** dedupeUsage 的输出:展示口径 + 决策口径 + 复用统计。 */
export interface DedupedUsageResult {
 /** API 原值逐次累加(展示口径)。 */
  display: FlatUsage;
 /** 每个指纹只计第一次(决策口径)。 */
  deduped: FlatUsage;
 /** 非首次出现的调用条数(即被去重掉的次数)。 */
  reusedCalls: number;
 /** 唯一指纹数。 */
  uniqueRequests: number;
}

/** splitPrice 的输出:原值展示 + 决策侧成本。 */
export interface SplitPriceResult {
 /** usage 原值逐字(展示口径,不打折、不换算)。 */
  display: EnvelopeUsage;
  decision: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
 /** 计算成本;费率缺失/非法 → null(不猜,不 throw)。 */
    cost: number | null;
  };
 /** 货币标记(只做标记,不做任何汇率换算)。 */
  currency: string;
}

/** 安全地把任意输入变成有限数字;非法(NaN/±Infinity/非数字)返回 undefined。 */
function finiteOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 非负有限数字;非法返回 undefined(费率校验用)。 */
function rateOrUndefined(v: unknown): number | undefined {
  const n = finiteOrUndefined(v);
  return n !== undefined && n >= 0 ? n : undefined;
}

/**
 * 确定性序列化:对象键排序、数组保序、循环引用记 "[circular]"。
 * 同内容的两个对象无论键序如何都得到同一字符串(指纹稳定的前提)。
 * 不 throw:任何异常形态(循环、BigInt、Proxy 抛错)都退化为 "[unserializable]"。
 */
export function stableStringify(value: unknown): string {
  const seen = new Set<unknown>();
  const walk = (v: unknown): string => {
    if (v === null) return "null";
    const t = typeof v;
    if (t === "undefined") return "undefined";
    if (t === "number") return Number.isFinite(v as number) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "bigint") return String(v);
    if (t === "string") return JSON.stringify(v);
    if (t === "function" || t === "symbol") return "undefined"; // JSON 同款:不可序列化即丢弃
    if (v instanceof Date) return JSON.stringify(Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString());
 // 到这里是 object / array
    if (seen.has(v)) return JSON.stringify("[circular]");
    seen.add(v);
    try {
      if (Array.isArray(v)) {
 // 数组保序(顺序是语义的一部分:消息顺序不同 = 不同请求)
        return `[${v.map(walk).join(",")}]`;
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).sort(); // 键排序:同内容任意键序 → 同指纹
      const parts: string[] = [];
      for (const k of keys) {
        const s = walk(obj[k]);
        if (s === "undefined") continue; // 与 JSON 一致:undefined 值的键省略
        parts.push(`${JSON.stringify(k)}:${s}`);
      }
      return `{${parts.join(",")}}`;
    } finally {
      seen.delete(v); // 只判环,不做全局去重(同一对象出现在两个分支是合法的)
    }
  };
  try {
    return walk(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * 请求信封指纹:sha256(stableStringify({model, messages, tools})) 前 16 位 hex。
 * 16 位(64 bit)足够区分同会话里的不同信封,又便于落 journal/日志。
 * 不 throw:任何异常输入都退化为随机的稳定兜底字符串(仍返回 string,调用方无需 try)。
 */
export function envelopeFingerprint(input: {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
}): string {
  try {
    const payload = {
      model: input?.model ?? "",
      messages: input?.messages ?? [],
      tools: input?.tools ?? [],
    };
    return createHash("sha256").update(stableStringify(payload), "utf8").digest("hex").slice(0, 16);
  } catch {
 // 理论上不可达(上面已 try 包住);留安全返回,保证「不 throw」契约。
    return "0".repeat(16);
  }
}

/**
 * 指纹台账:判断「这条请求是不是刚发过」。
 * `now` 可注入(测试/确定性);只用于记录首次/最近时间戳,不影响复用判定。
 */
export class UsageEnvelopeLedger {
  private readonly now: () => number;
  private readonly seen = new Map<string, { calls: number; firstAt: number; lastAt: number }>();

  constructor(opts: { now?: () => number } = {}) {
    this.now = typeof opts.now === "function" ? opts.now : () => Date.now();
  }

 /** 记一次调用:同指纹第二次起 `reused=true`。`calls` 是该指纹的累计次数。 */
  record(fingerprint: string): { reused: boolean; calls: number; uniqueRequests: number } {
    const key = typeof fingerprint === "string" && fingerprint ? fingerprint : "(empty)";
    const ts = safeNow(this.now);
    const hit = this.seen.get(key);
    if (!hit) {
      this.seen.set(key, { calls: 1, firstAt: ts, lastAt: ts });
      return { reused: false, calls: 1, uniqueRequests: this.seen.size };
    }
    hit.calls += 1;
    hit.lastAt = ts;
    return { reused: true, calls: hit.calls, uniqueRequests: this.seen.size };
  }

 /** 汇总:唯一请求数、总调用数、复用次数、复用率(分母 0 → 0)。 */
  stats(): { uniqueRequests: number; calls: number; reusedCalls: number; reuseRate: number } {
    let calls = 0;
    for (const v of this.seen.values()) calls += v.calls;
    const uniqueRequests = this.seen.size;
    const reusedCalls = Math.max(0, calls - uniqueRequests);
    return {
      uniqueRequests,
      calls,
      reusedCalls,
      reuseRate: uniqueRequests + reusedCalls > 0 ? round4(reusedCalls / (uniqueRequests + reusedCalls)) : 0,
    };
  }

  reset(): void {
    this.seen.clear();
  }
}

function safeNow(now: () => number): number {
  try {
    const v = now();
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** 四舍五入到 4 位(复用率/比例展示用)。 */
function round4(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : 0;
}

/** 四舍五入到 6 位(金额)。 */
function round6(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : 0;
}

/** 把单条 usage 归一成四字段(非法值按 0;total 缺省 = input+output)。 */
function flatOf(u: EnvelopeUsage | undefined): FlatUsage {
  const input = finiteOrUndefined(u?.input) ?? 0;
  const output = finiteOrUndefined(u?.output) ?? 0;
  const cached = finiteOrUndefined(u?.cached) ?? 0;
  const total = finiteOrUndefined(u?.total) ?? input + output;
  return { input, output, total, cached };
}

/**
 * 双口径用量核算。
 * - `display`:逐条累加 API 原值(展示口径,与 TraceStats.tokens 完全一致)
 * - `deduped`:每个 fingerprint 只算第一次(决策口径,拒绝把同一份上下文按调用次数重复计费)
 * 入参不修改(全部只读遍历),返回对象冻结。
 */
export function dedupeUsage(entries: readonly UsageEnvelopeEntry[]): DedupedUsageResult {
  const display: FlatUsage = { input: 0, output: 0, total: 0, cached: 0 };
  const deduped: FlatUsage = { input: 0, output: 0, total: 0, cached: 0 };
  const seen = new Set<string>();
  let reusedCalls = 0;
  if (Array.isArray(entries)) {
    for (const e of entries) {
      if (!e || typeof e !== "object") continue;
      const raw = e.fingerprint;
      const key = typeof raw === "string" && raw ? raw : "(empty)";
      const f = flatOf(e.usage);
      display.input += f.input;
      display.output += f.output;
      display.total += f.total;
      display.cached += f.cached;
      if (seen.has(key)) {
        reusedCalls += 1; // 第二次起:只进 display,不进 deduped
        continue;
      }
      seen.add(key);
      deduped.input += f.input;
      deduped.output += f.output;
      deduped.total += f.total;
      deduped.cached += f.cached;
    }
  }
  return Object.freeze({
    display: Object.freeze(display),
    deduped: Object.freeze(deduped),
    reusedCalls,
    uniqueRequests: seen.size,
  });
}

/**
 * 拆价:展示侧给 usage 原值、决策侧给 token 三段 + 成本。
 * 成本口径(`cost`) = input/1e6*inputPer1M + output/1e6*outputPer1M + cached/1e6*cachedPer1M
 * - `cachedPer1M` **缺失**时,cached 段无法单独定价 → 该段**不计入成本**(计 0),
 * 绝不拿 input 费率冒充缓存价(那是猜)。
 * - 费率非法(NaN/负数/非数字)或缺失 → `cost = null`:宁可不给数,也不给错数,更不 throw。
 * - 金额四舍五入到 6 位小数(够到 0.000001 个货币单位,避免浮点尾巴)。
 * `currency` 只做标记,**不做任何汇率换算**(换算需要外部行情,本模块零 IO)。
 */
export function splitPrice(
  input: { usage?: EnvelopeUsage; rate?: UsageRate },
  opts: { currency?: string } = {},
): SplitPriceResult {
  const rawUsage: EnvelopeUsage = input?.usage ?? { input: 0, output: 0 };
  const display: EnvelopeUsage = { ...rawUsage }; // 逐字复制原值,不做任何归一
  const inputTokens = finiteOrUndefined(rawUsage.input) ?? 0;
  const outputTokens = finiteOrUndefined(rawUsage.output) ?? 0;
  const cachedTokens = finiteOrUndefined(rawUsage.cached) ?? 0;

  const rate = input?.rate;
  const inRate = rateOrUndefined(rate?.inputPer1M);
  const outRate = rateOrUndefined(rate?.outputPer1M);
  const cachedRate = rateOrUndefined(rate?.cachedPer1M);

  let cost: number | null = null;
  if (inRate !== undefined && outRate !== undefined) {
    const base = (inputTokens / 1e6) * inRate + (outputTokens / 1e6) * outRate;
    if (Number.isFinite(base)) {
 // cached 段:只有明确给出缓存费率才单列;缺失即计 0(见上方口径注释)。
      const cachedPart = cachedRate !== undefined ? (cachedTokens / 1e6) * cachedRate : 0;
      const sum = base + (Number.isFinite(cachedPart) ? cachedPart : 0);
      cost = round6(sum);
    }
  }

  const currency = typeof opts?.currency === "string" && opts.currency ? opts.currency : "USD";
  return Object.freeze({
    display: Object.freeze(display),
    decision: Object.freeze({ inputTokens, outputTokens, cachedTokens, cost }),
    currency,
  });
}
