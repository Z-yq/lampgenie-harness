// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有;strict 类型化列入 backlog。
import { SessionEventType } from '../../shared/session-events'

// 保留策略只看已落账的事件事实,不认识活的 TaskSupervisor/ACP 对象。
export const DEFAULT_LOG_RETENTION = Object.freeze({
  maxEvents: 2000,
  maxBytes: 8 * 1024 * 1024,
  maxMessages: 200,
  maxTerminalTasks: 100,
})

export function logRetention(options = {}) {
  const policy = { ...DEFAULT_LOG_RETENTION, ...options }
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid journal retention ${key}`)
  }
  return policy
}

export const recordSize = event => Buffer.byteLength(JSON.stringify(event)) + 1

const isTaskEvent = event =>
  event.type === SessionEventType.TASK_EVENT || event.type === 'qwaudio/task/event'

export function latestLogTasks(events) {
  const latest = new Map()
  for (const event of events) {
    const task = isTaskEvent(event) && event.payload?.task
    if (task?.id) latest.set(task.id, event)
  }
  return [...latest.values()]
}

export function needsLogRecovery(event) {
  const task = event.payload?.task
  return task && (
    !['completed', 'failed', 'cancelled'].includes(task.status)
    || ['pending', 'delivering'].includes(task.notificationStatus)
  )
}

/** Compact snapshots, retaining recovery facts before optional history. */
export function compactLogEvents(events, policy, headerBytes = 0) {
  const selected = new Set()
  let bytes = headerBytes
  const add = (event, required = false) => {
    if (!event || selected.has(event)) return
    const size = recordSize(event)
    if (selected.size >= policy.maxEvents || bytes + size > policy.maxBytes) {
      if (required) throw Object.assign(new Error('Session journal recovery state exceeds its retention budget'), {
        code: 'SESSION_JOURNAL_CAPACITY',
      })
      return
    }
    selected.add(event)
    bytes += size
  }
  const tasks = latestLogTasks(events)
  const isChatMessage = event => event.type === SessionEventType.USER_MESSAGE
    || event.type === SessionEventType.ASSISTANT_MESSAGE
  // 一号位:恢复底线——最新进度、活跃/排期中的任务、未送达的结果,永不裁。
  add(events.at(-1), true)
  for (const event of tasks.filter(needsLogRecovery)) add(event, true)
  // 二号位:最近对话(每条 messageId 只留最新),按 maxMessages 截断。
  const latestMessages = new Map()
  for (const event of events) {
    if (isChatMessage(event)) {
      const key = event.payload?.messageId || event.seq
      latestMessages.delete(key)
      latestMessages.set(key, event)
    }
  }
  for (const event of [...latestMessages.values()].reverse().slice(0, policy.maxMessages)) add(event)
  // 三号位:已终态任务按新→旧保留 maxTerminalTasks 条。
  const settledTasks = tasks.filter(event => !needsLogRecovery(event))
    .reverse()
    .slice(0, policy.maxTerminalTasks)
  for (const event of settledTasks) add(event)
  // 回填余量:留 25% 头寸,长会话不至于每来一条事件就整文件重写。
  const targetEvents = Math.floor(policy.maxEvents * 0.75)
  const targetBytes = Math.floor(policy.maxBytes * 0.75)
  for (let i = events.length - 1; i >= 0 && selected.size < targetEvents && bytes < targetBytes; i--) {
    const event = events[i]
    // 旧版本的任务/消息快照对重建状态无用,跳过。
    if (isTaskEvent(event) && event.payload?.task?.id) continue
    if (isChatMessage(event)) continue
    add(event)
  }
  return [...selected].sort((a, b) => a.seq - b.seq)
}

export function retainedLogHeader(header, removed) {
  if (!removed) return header
  return {
    ...header,
    retention: {
      policy: 'bounded',
      discardedEvents: (header.retention?.discardedEvents || 0) + removed,
    },
  }
}
