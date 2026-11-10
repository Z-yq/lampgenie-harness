// @ts-nocheck — 记忆写入侧的敏感内容硬闸(本仓自研;「prompt 之外再设单一来源硬闸」
// 的防线思路参考 qwen-audio-agent,Apache-2.0,致谢)。
//
// 三条写入链路(抽取器/画像观察器/会话摘要)的 prompt 都写了「绝不提取密码/密钥」,
// 但 prompt 是软约束,这里是它们背后的共同硬闸。规则必须单一来源:分散多份副本后
// 补一处漏一处,就是静默泄漏口。取向刻意保守——
//   · 误判:丢一条记忆,用户再说一次就好
//   · 漏判:秘密被持久化,且很难发现

const SECRET_HINT_PATTERNS = [
  /(?:api[_-]?key|access[_-]?key|secret|token|password|passwd)/i,
  /(?:密码|密钥|口令|验证码|令牌|证件号|身份证)/,
  /\bsk-[A-Za-z0-9]{8,}/,
  // 长数字串:银行卡/证件号/手机号拼接
  /\b\d{11,19}\b/,
  // base64 风格长串:多半是贴进来的凭据
  /[A-Za-z0-9+/]{40,}={0,2}/,
]

export function hasSensitiveText(value) {
  const text = String(value || '')
  return SECRET_HINT_PATTERNS.some(pattern => pattern.test(text))
}

export { SECRET_HINT_PATTERNS as SENSITIVE_PATTERNS }
