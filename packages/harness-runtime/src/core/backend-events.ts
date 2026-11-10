// @ts-nocheck — BackendPort 适配器的协议中立事件(本仓自研;「适配器内归一、协议载荷
// 不外泄」的边界纪律参考 qwen-audio-agent,Apache-2.0,致谢;strict 类型化列入 backlog)。
// ACP 会话更新/A2A 任务事件/自定义回调都在各自适配器里归一成这里的形状,再进 TaskSupervisor。

const BACKEND_SIGNAL_PAIRS = [
  ['ACTIVITY', 'backend.activity'],
  ['MESSAGE', 'backend.message'],
  ['ARTIFACT', 'backend.artifact'],
  ['AUTHORIZATION_REQUESTED', 'backend.permission.requested'],
  ['AUTHORIZATION_RESOLVED', 'backend.permission.resolved'],
  ['INPUT_REQUESTED', 'backend.input.requested'],
  ['INPUT_RESOLVED', 'backend.input.resolved'],
  ['DELEGATED', 'backend.delegated'],
  ['DELEGATION_COMPLETED', 'backend.delegation.completed'],
]

export const BackendSignalType = Object.freeze(Object.fromEntries(BACKEND_SIGNAL_PAIRS))

export const BACKEND_SIGNAL_TYPES = new Set(Object.values(BackendSignalType))

// 事件工厂:词表外类型直接抛(拼错的事件名不该静默进日志)。
export function backendSignal(type, details = {}) {
  if (!BACKEND_SIGNAL_TYPES.has(type)) {
    throw new TypeError(`Unknown BackendPort event: ${type}`)
  }
  return { type, ...details }
}
