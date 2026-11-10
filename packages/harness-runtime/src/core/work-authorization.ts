// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有;strict 类型化列入 backlog。
export { PERMISSION_DECISIONS } from '../shared/permission-decisions'

export const WorkAuthStatus = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
  CANCELLED: 'cancelled',
})

const KNOWN_STATUSES = new Set(Object.values(WorkAuthStatus))
const KNOWN_APPROVAL_SCOPES = new Set(['once', 'session', 'persistent'])

// 清洗任意模型输出:去 NUL、压空白、限长。
function clip(value, max = 300) {
  return String(value || '').replaceAll('\u0000', '').replace(/\s+/g, ' ')
    .trim().slice(0, max)
}

// 操作描述字段 → [键, 限长];逐项收敛,全空则整条无效。
const OPERATION_FIELDS = [
  ['title', 160],
  ['kind', 80],
  ['description', 600],
  ['command', 1200],
  ['path', 600],
]

export function tidyAuthOperation(value) {
  if (!value || typeof value !== 'object') return null
  const fields = {}
  for (const [key, max] of OPERATION_FIELDS) fields[key] = clip(value[key], max)
  const { title, kind, description, command, path } = fields
  const locations = (Array.isArray(value.locations) ? value.locations : [])
    .map(location => {
      const locationPath = clip(location?.path, 600)
      if (!locationPath) return null
      const line = Number.isInteger(location?.line) && location.line > 0
        ? location.line
        : null
      return {
        path: locationPath,
        ...(line ? { line } : {}),
      }
    })
    .filter(Boolean)
    .slice(0, 16)
  const empty = OPERATION_FIELDS.every(([, key]) => !fields[key]) && !locations.length
  if (empty) return null
  return {
    title: title || '后台操作',
    kind: kind || 'unknown',
    ...(description ? { description } : {}),
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
    ...(locations.length ? { locations } : {}),
  }
}

export function tidyAuthorization(value, {
  taskId = '',
  defaultStatus = WorkAuthStatus.PENDING,
  now = Date.now(),
} = {}) {
  if (!value || typeof value !== 'object') return null
  const id = clip(value.id, 160)
  const summary = clip(value.summary, 600)
  if (!id || !summary) return null
  const status = KNOWN_STATUSES.has(value.status)
    ? value.status
    : defaultStatus
  const createdAt = Number(value.createdAt) || now
  const resolvedAt = status === WorkAuthStatus.PENDING
    ? null
    : Number(value.resolvedAt) || now
  const approvalScope = KNOWN_APPROVAL_SCOPES.has(value.approvalScope)
    ? value.approvalScope
    : 'session'
  return {
    id,
    taskId: clip(taskId || value.taskId, 160) || null,
    status,
    category: clip(value.category, 80) || 'unknown',
    summary,
    patterns: (Array.isArray(value.patterns) ? value.patterns : [])
      .map(pattern => clip(pattern, 300))
      .filter(Boolean)
      .slice(0, 32),
    approvalScope,
    operation: tidyAuthOperation(value.operation),
    createdAt,
    resolvedAt,
  }
}

export function resolveWorkAuth(value, status, {
  taskId = '',
  now = Date.now(),
} = {}) {
  if (!KNOWN_STATUSES.has(status) || status === WorkAuthStatus.PENDING) {
    return null
  }
  const authorization = tidyAuthorization(value, { taskId, now })
  if (!authorization) return null
  return {
    ...authorization,
    status,
    resolvedAt: now,
  }
}

export function authorizationView(value, { taskId = '' } = {}) {
  const authorization = tidyAuthorization(value, {
    taskId,
    now: Number(value?.createdAt) || Date.now(),
  })
  return authorization ? { ...authorization } : null
}
