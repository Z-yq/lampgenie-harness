/**
 * 工具参数/结果脱敏(轨迹追踪 P1-B。
 * 背景:journal 的 `tool.call.arguments` 与 `tool.result.content` 是**原样字符串**,LLM 把用户
 * 口令、API key、Bearer token 当工具入参传下去是常态(如 `curl -H "Authorization: Bearer sk-…"`)。
 * 轨迹落盘(journal / llm-trace / 会话导出)三条链都带同一份明文,任何一条被分享/上传即泄漏。
 * 设计纪律:
 * - **幂等**:占位符 `<redacted:kind>` 自身不命中任何规则(规则都要求 ≥16 位密文主体,assign 规则
 *   的值字符集还排除了 `<`),因此对已脱敏文本再跑一次输出不变——重放/重复导出不会层层打标。
 * - **string-only**:`arguments` 脱敏后仍是 string(harness-runtime `trace-query.ts` 的
 *   `TRUNCATABLE_KEYS` 只做 string 截断,改成对象会打断面板轨迹渲染与既有测试)。
 * - **不碰 `idempotencyKey`**:它是 journal 重放去重依据,改动即破坏幂等语义。
 * - 开关 `GENIE_JOURNAL_REDACT=0` 全关(缺省开)。
 */

export type RedactKind = "github" | "aws" | "jwt" | "sk" | "bearer" | "assign";

interface Rule {
  kind: RedactKind;
  re: RegExp;
  /** 密文主体所在分组(1-based)。给了就保留匹配前缀(如 `api_key=`/`Bearer `),只替换密文段;
   *  密文段恒定在匹配尾部,故前缀 = 整段减去尾部密文。不给=整段替换。 */
  secretGroup?: number;
}

/**
 * 规则表(顺序=匹配优先级)。每条都要求足够长的密文主体:
 * 占位符 `<redacted:xxx>` 里没有 16+ 位连续 `[A-Za-z0-9_-]`,故二次运行必不命中 → 幂等。
 */
const RULES: Rule[] = [
  // sk- 系(OpenAI/Anthropic 风格):sk- + 16 位以上
  { kind: "sk", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  // ghp_ 系(GitHub PAT);github_pat_ 一并覆盖
  { kind: "github", re: /\bghp_[A-Za-z0-9]{20,}/g },
  { kind: "github", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  // AWS Access Key ID
  { kind: "aws", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // JWT(header.payload.signature;三段 base64url,首段固定 eyJ 开头)
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // Bearer <token>(保留 "Bearer " 前缀,可读性好且便于人眼判断「这里原本有 token」)
  { kind: "bearer", re: /\bBearer\s+([A-Za-z0-9._-]{16,})/gi, secretGroup: 1 },
  // key=value / key: value 形态(保留键名与前缀,只替换值);值字符集排除 `<` 保证幂等
  {
    kind: "assign",
    re: /((?:api[_-]?key|access[_-]?key|token|password|passwd|secret|authorization)["']?\s*[=:]\s*["']?)([^\s"'`,;<>{}[\]]{8,})/gi,
    secretGroup: 2,
  },
];

const PLACEHOLDER_OF: Record<RedactKind, string> = {
  github: "<redacted:github>",
  aws: "<redacted:aws>",
  jwt: "<redacted:jwt>",
  sk: "<redacted:sk>",
  bearer: "<redacted:bearer>",
  assign: "<redacted:assign>",
};

/** 开关:`GENIE_JOURNAL_REDACT=0` 全关;其余(含未设置)开启。 */
export function redactEnabled(): boolean {
  const v = typeof process !== "undefined" ? process.env?.GENIE_JOURNAL_REDACT : undefined;
  return v !== "0" && v !== "false";
}

/**
 * 文本脱敏:命中已知凭证形态 → 替换为 `<redacted:kind>`。**幂等**(二次运行输出不变)。
 */
export function redactText(s: string): string {
  if (typeof s !== "string" || s.length === 0) return s;
  if (!redactEnabled()) return s;
  let out = s;
  for (const rule of RULES) {
    // 每条规则用新实例(带 g 的正则在跨调用间 lastIndex 是脏的)
    const re = new RegExp(rule.re.source, rule.re.flags);
    const placeholder = PLACEHOLDER_OF[rule.kind];
    out = out.replace(re, (...args: unknown[]) => {
      const whole = String(args[0]);
      if (rule.secretGroup === undefined) return placeholder;
      // 密文段=第 secretGroup 个捕获组;恒定在匹配尾部 → 前缀 = 整段减去尾部密文
      const secret = args[rule.secretGroup] as string | undefined;
      if (!secret) return placeholder;
      const at = whole.lastIndexOf(secret);
      if (at < 0) return placeholder;
      return whole.slice(0, at) + placeholder + whole.slice(at + secret.length);
    });
  }
  return out;
}

export interface RedactPayloadResult {
  payload: unknown;
  redacted: boolean;
}

/** 只在字符串命中规则时才写回,返回是否发生替换。 */
function redactField(v: unknown): { value: unknown; hit: boolean } {
  if (typeof v !== "string" || v.length === 0) return { value: v, hit: false };
  const next = redactText(v);
  return { value: next, hit: next !== v };
}

/**
 * 事件 payload 脱敏(浅层 + 数组一层,与 harness-runtime `projectPayload` 的覆盖口径一致)。
 * 处理键:
 * - `arguments`(tool.call 的工具入参,string)→ 命中置 `argumentsRedacted: true`,**类型仍是 string**
 * - `content`(tool.result 的工具结果正文,string)→ 命中置 `contentRedacted: true`
 * - `text`(message 文本)/ `error`(`string` 或 `{message}`)——同可能夹带口令,一并处理,
 *   但这两类不额外打标(不是「工具参数」语义,打标会污染面板展示)。
 * **绝不处理 `idempotencyKey`**:重放去重依据,改了即破坏幂等。
 */
export function redactEventPayload(payload: unknown): RedactPayloadResult {
  if (!redactEnabled()) return { payload, redacted: false };
  if (payload === null || typeof payload !== "object") return { payload, redacted: false };
  if (Array.isArray(payload)) {
    let touched = false;
    const out = payload.map((item) => {
      const r = redactEventPayload(item);
      if (r.redacted) touched = true;
      return r.payload;
    });
    return touched ? { payload: out, redacted: true } : { payload, redacted: false };
  }
  const src = payload as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  let touched = false;
  const put = (key: string, value: unknown) => {
    if (!out) out = { ...src };
    out[key] = value;
  };

  const args = redactField(src.arguments);
  if (args.hit) {
    put("arguments", args.value); // string 类型不变(trace-query 契约 + 面板渲染)
    put("argumentsRedacted", true);
    touched = true;
  }
  const content = redactField(src.content);
  if (content.hit) {
    put("content", content.value);
    put("contentRedacted", true);
    touched = true;
  }
  const text = redactField(src.text);
  if (text.hit) {
    put("text", text.value);
    touched = true;
  }
  if (typeof src.error === "string") {
    const e = redactField(src.error);
    if (e.hit) { put("error", e.value); touched = true; }
  } else if (src.error && typeof src.error === "object" && !Array.isArray(src.error)) {
    const errObj = src.error as Record<string, unknown>;
    const msg = redactField(errObj.message);
    if (msg.hit) { put("error", { ...errObj, message: msg.value }); touched = true; }
  }
  return touched && out ? { payload: out, redacted: true } : { payload, redacted: false };
}
