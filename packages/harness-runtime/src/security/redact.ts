/**
 * 出站文本密钥擦除(best-effort)。
 *
 * 用途:通知/webhook 等内容离开本机前的最后一道闸。设计是**纵深防御而非保证**——
 * 常见密钥形态 + 本机环境变量值两层,兜不住的形态依旧可能漏;调用方对高敏通道仍应
 * 做显式 opt-in。
 *
 * 两遍擦除(顺序固定):
 *   1. **已知值**:调用方给进的环境变量密钥值(如 ANTHROPIC_API_KEY 的值)按字面量
 *      整段替换——对已经过环境的东西是 100% 精确的;长值先替换,避免短值先命中把长值
 *      拆碎。
 *   2. **形态兜底**:常见凭证形状的正则——PEM 私钥块、各家 token 前缀、JWT、
 *      `key=value` 对、`Authorization: Bearer`、连接串密码段。覆盖粘贴进对话、
 *      从未经过环境变量的密钥。
 *
 * 设计参考 teamai-cli 的出站脱敏器思路(致谢,MIT);本文件为独立实现,
 * 规则表、分层结构与命名均为本仓自有。
 */

const token = (label: string): string => `<REDACTED:${label}>`;

/** HTTP(S) Git 远端里内嵌的用户信息(`https://user:token@host`)抹成 `***@`。 */
export function stripGitUserinfo(text: string): string {
  return text.replace(/(https?:\/\/)[^/@\s]+@/gi, "$1***@");
}

/** 环境变量名里出现这些片段时,其值按疑似凭证处理。 */
const CREDENTIAL_NAME_HINTS = ["TOKEN", "SECRET", "KEY", "PASSWORD", "PASSWD", "_PAT", "CREDENTIAL"];

/** 值短于该长度的环境变量不视为凭证(避免把 `KEY=1` 之类误伤)。 */
const MIN_CREDENTIAL_VALUE_LEN = 8;

/**
 * 形态规则表。顺序有讲究:更特异的前缀在前(如 `sk-ant-` 先于 `sk-`),
 * 宽规则放后,防止宽规则先把特异 token 吃掉。
 */
const SHAPE_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ["pem", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
  ["anthropic", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ["gh_pat", /\bgithub_pat_[A-Za-z0-9_]{22,}/g],
  ["gh_tok", /\bgh[pousr]_[A-Za-z0-9]{20,}/g],
  ["aws", /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g],
  ["slack", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ["slackhook", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g],
  ["google", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["gcp_oauth", /\bya29\.[0-9A-Za-z_-]{20,}/g],
  ["stripe", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["sendgrid", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g],
  ["provider", /\b(?:xai-|gsk_|pplx-|sk-or-v1-|hf_|dop_v1_|glpat-|npm_|shpat_|tfp_|nvapi-|r8_)[A-Za-z0-9_-]{16,}/g],
];

/** `key=value` / `key: value`:只抹值,保留键名可读。 */
const KEYVALUE_RULE =
  /(secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|password|passwd|auth[_-]?token|private[_-]?key)(["']?\s*[:=]\s*["']?)([A-Za-z0-9._\-/+=]{16,})/gi;

/** `Authorization: Bearer <token>`:保留 scheme,抹 token。 */
const BEARER_RULE = /\b(bearer\s+)([A-Za-z0-9._-]{16,})/gi;

/** `proto://user:PASSWORD@host`:只抹密码段。 */
const URL_PASSWORD_RULE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+:)([^\s/@]{6,})(@)/g;

export interface SecretScrubOptions {
  /**
   * 已知密钥字面量,键为占位符里显示的标签(通常是环境变量名)。
   * 用 {@link collectCredentialEnv} 从 `process.env` 构建。
   */
  knownSecrets?: Record<string, string>;
  /** 是否启用形态兜底规则。缺省 true。 */
  shapes?: boolean;
}

/**
 * 从环境变量表里挑出疑似凭证值。独立成纯函数:擦除主入口保持「只依赖入参」,
 * 环境扫描可以单测(喂假 env)。
 */
export function collectCredentialEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < MIN_CREDENTIAL_VALUE_LEN) continue;
    const upper = name.toUpperCase();
    if (CREDENTIAL_NAME_HINTS.some((hint) => upper.includes(hint))) {
      found[name] = value;
    }
  }
  return found;
}

/** 对文本做密钥擦除;无命中时原样返回。 */
export function scrubSecrets(text: string, options: SecretScrubOptions = {}): string {
  if (!text) return text;
  let out = text;

  // 第一遍:已知值字面量替换(长值优先,理由见头部注释)。
  const known = Object.entries(options.knownSecrets ?? {}).sort((a, b) => b[1].length - a[1].length);
  for (const [label, value] of known) {
    if (value && out.includes(value)) {
      out = out.split(value).join(token(label));
    }
  }

  // 第二遍:形态兜底。
  if (options.shapes !== false) {
    for (const [label, rule] of SHAPE_RULES) {
      out = out.replace(rule, () => token(label));
    }
    out = out.replace(KEYVALUE_RULE, (_m, key: string, sep: string) => key + sep + token("kv"));
    out = out.replace(BEARER_RULE, (_m, scheme: string) => scheme + token("authz"));
    out = out.replace(
      URL_PASSWORD_RULE,
      (_m, prefix: string, _pw: string, at: string) => prefix + token("conn") + at,
    );
  }

  return out;
}

/** 便捷入口:形态规则 + 当前环境发现的凭证一起擦。 */
export function scrubWithEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return scrubSecrets(text, { knownSecrets: collectCredentialEnv(env) });
}
