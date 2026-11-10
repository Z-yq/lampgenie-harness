// @ts-nocheck — 托管子代理的操作系统环境投影(本仓自有实现;同类「白名单投影 + 插件声明
// 补充」的信任边界设计参考 qwen-audio-agent,致谢)。子代理只拿到启动所需的系统上下文,
// 加上其后台插件显式声明的凭证与产品选项;网关/语音/记忆等密钥刻意不跨这条边界。

import { backendDefinition } from './catalog'

// 子代理间通用的内部标记(本仓品牌前缀;仅网关与被托管子进程读写)。
const INTERNAL_MARK = 'GENIE_BACKEND_'
const INTERNAL_NAMES = new Set([
  'GENIE_BACKEND_AGENT',
  'GENIE_BACKEND_MODEL',
  'GENIE_BACKEND_OWNERSHIP',
  'GENIE_BACKEND_PERMISSION_MODE',
  'GENIE_BACKEND_ENV_LOADED',
  'GENIE_BACKEND_NODE',
  'GENIE_BACKEND_ROOT',
  'GENIE_BACKEND_RUNTIME_ROOT',
  'GENIE_BACKEND_SOURCE_ROOT',
  'GENIE_DESKTOP',
  'GENIE_DESKTOP_INSTALLED_ONLY',
])

// 允许投影进子代理的系统环境变量。
const SYSTEM_NAMES = new Set([
  'APPDATA', 'COLORTERM', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'LANG', 'LOCALAPPDATA', 'LOGNAME',
  'NODE_EXTRA_CA_CERTS', 'NO_BROWSER', 'NO_PROXY', 'PATH', 'PATHEXT',
  'PWD', 'SHELL', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'SYSTEMDRIVE',
  'SYSTEMROOT', 'TEMP', 'TERM', 'TMP', 'TMPDIR', 'USER', 'USERDOMAIN',
  'USERNAME', 'USERPROFILE', 'WINDIR',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME',
  'http_proxy', 'https_proxy', 'no_proxy',
])

const SYSTEM_PREFIXES = ['LC_', 'npm_config_', 'NPM_CONFIG_']

const tidy = value => String(value || '').trim()

function explicitAllowlist(policy, env) {
  const listEnv = tidy(policy?.explicitListEnvironment)
  if (!listEnv) return []
  return tidy(env[listEnv]).split(',').map(item => item.trim()).filter(Boolean)
}

function projectable(name, policy, explicit) {
  if (SYSTEM_NAMES.has(name) || INTERNAL_NAMES.has(name)) return true
  if (name.startsWith(INTERNAL_MARK)) return true
  if (SYSTEM_PREFIXES.some(prefix => name.startsWith(prefix))) return true
  if (policy.names?.includes(name)) return true
  if (policy.prefixes?.some(prefix => name.startsWith(prefix))) return true
  return explicit.has(name)
}

export function backendEnvironment(protocol, { env = process.env, additions = {} } = {}) {
  const definition = backendDefinition(protocol)
  if (!definition) throw new Error(`不支持的后台 Agent：${protocol}`)
  const policy = definition.environment || {}
  const explicit = new Set(explicitAllowlist(policy, env))
  const projected = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (projectable(name, policy, explicit)) projected[name] = value
  }
  return {
    ...projected,
    GENIE_BACKEND_ENV_LOADED: '1',
    GENIE_BACKEND_NODE: process.execPath,
    ...additions,
  }
}
