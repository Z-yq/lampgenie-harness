// @ts-nocheck — 记忆双文档的范围词表(本仓自研;「双文档 + kind 语义分型」的模型
// 参考 qwen-audio-agent,Apache-2.0,致谢;strict 类型化列入 backlog)。
// scope 字段保留历史拼写;kind 是语义分型——directive=用户亲授的长期指令,以
// 权威姿态注入;data=被动素材,模型当数据读。两者不得混写。

const SCOPE_DEFINITIONS = [
  ['user', { kind: 'directive', label: '用户偏好', maxEntries: 32, maxChars: 500 }],
  ['memory', { kind: 'data', label: '长期记忆', maxEntries: 32, maxChars: 500 }],
]

export const MEMORY_SCOPE_SET = Object.freeze(
  Object.fromEntries(SCOPE_DEFINITIONS.map(([name, meta]) => [name, Object.freeze(meta)])),
)

// 旧拼写只读兼容(升级不丢已有记忆);profile/rules 曾与 user 重叠,现收敛到同一份。
const SCOPE_ALIASES = new Map([
  ['profile', 'user'],
  ['rules', 'user'],
  ['facts', 'memory'],
  ['long_term', 'memory'],
])

export function scopeKey(value) {
  const scope = String(value || '').trim().toLowerCase()
  return SCOPE_ALIASES.get(scope) || scope
}

// 「不过滤范围」的内部哨兵;工具 schema 用「省略 scope 参数」表达 all,词表不含它。
export const SCOPE_ALL = 'all'
export const MEMORY_DOC_KINDS = Object.keys(MEMORY_SCOPE_SET)

function scopeMeta(scope) {
  return MEMORY_SCOPE_SET[scopeKey(scope)] || null
}

export function isMemoryDocFile(scope) {
  return MEMORY_DOC_KINDS.includes(scopeKey(scope))
}

export function isPolicyScope(scope) {
  return scopeMeta(scope)?.kind === 'directive'
}
