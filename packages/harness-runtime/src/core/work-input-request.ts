// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有;strict 类型化列入 backlog。
export const InputAskStatus = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  CANCELLED: 'cancelled',
})

const KNOWN_STATUSES = new Set(Object.values(InputAskStatus))
const KNOWN_MODES = new Set(['text', 'form', 'url'])
const KNOWN_KINDS = new Set(['input', 'authorization'])

function clip(value, max = 1_000) {
  return String(value || '').replaceAll('\u0000', '').trim().slice(0, max)
}

// schema 等对象字段:限 64KB(序列化口径),超限或不可序列化返回 null。
function boundedObject(value, maxBytes = 64 * 1024) {
  if (!value || typeof value !== 'object') return null
  try {
    const json = JSON.stringify(value)
    return Buffer.byteLength(json, 'utf8') <= maxBytes ? JSON.parse(json) : null
  } catch {
    return null
  }
}

// 用户可见的跳转地址:仅 http(s)、不带内嵌凭证;不合法返回空串。
function publicUrl(value) {
  try {
    const url = new URL(clip(value, 2_048))
    const safe = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    return safe ? url.toString() : ''
  } catch {
    return ''
  }
}

export function tidyInputRequest(value, {
  taskId = '',
  defaultStatus = InputAskStatus.PENDING,
  now = Date.now(),
} = {}) {
  if (!value || typeof value !== 'object') return null
  const id = clip(value.id, 160)
  const prompt = clip(value.prompt || value.message, 4_000)
  if (!id || !prompt) return null
  const status = KNOWN_STATUSES.has(value.status)
    ? value.status
    : defaultStatus
  const mode = KNOWN_MODES.has(value.mode) ? value.mode : 'text'
  const kind = KNOWN_KINDS.has(value.kind) ? value.kind : 'input'
  const schema = boundedObject(value.schema)
  // url 形态才解析 url;非法/非 https(s) 直接丢弃该字段。
  const url = mode === 'url' ? publicUrl(value.url) : ''
  const resolved = status === InputAskStatus.PENDING
  return {
    id,
    taskId: clip(taskId || value.taskId, 160) || null,
    status,
    kind,
    mode,
    prompt,
    ...(schema ? { schema } : {}),
    ...(url ? { url } : {}),
    createdAt: Number(value.createdAt) || now,
    resolvedAt: resolved ? null : Number(value.resolvedAt) || now,
  }
}

// 终态化:status 必须是终态且请求本体合法,否则返回 null。
export function resolveInputAsk(value, status, { taskId = '', now = Date.now() } = {}) {
  const isTerminal = KNOWN_STATUSES.has(status) && status !== InputAskStatus.PENDING
  if (!isTerminal) return null
  const request = tidyInputRequest(value, { taskId, now })
  return request ? { ...request, status, resolvedAt: now } : null
}

export function inputRequestView(value, { taskId = '' } = {}) {
  const request = tidyInputRequest(value, {
    taskId,
    now: Number(value?.createdAt) || Date.now(),
  })
  return request ? { ...request } : null
}
