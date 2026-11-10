// @ts-nocheck — 任务域事件词汇(本仓自有;「事件即事实」的持久化立场与同类领域
// 事件流的组织参考 qwen-audio-agent,Apache-2.0,致谢)。
// 值是跨进程 wire 契约,名字是仓内可读别名。

const TASK_EVENT_PAIRS = [
  ['ACCEPTED', 'task.accepted'],
  ['SCHEDULED', 'task.scheduled'],
  ['SCHEDULED_FIRED', 'task.scheduled.fired'],
  ['RUNNING', 'task.running'],
  ['DELEGATED', 'task.delegated'],
  ['FINALIZING', 'task.finalizing'],
  ['CANCELLING', 'task.cancelling'],
  ['UPDATED', 'task.updated'],
  ['PROGRESS', 'task.progress'],
  ['COMPLETED', 'task.completed'],
  ['FAILED', 'task.failed'],
  ['CANCELLED', 'task.cancelled'],
  ['PERMISSION_REQUESTED', 'task.permission.requested'],
  ['PERMISSION_RESOLVED', 'task.permission.resolved'],
  ['INPUT_REQUESTED', 'task.input.requested'],
  ['INPUT_RESOLVED', 'task.input.resolved'],
  ['NOTIFICATION_PENDING', 'task.notification.pending'],
  ['NOTIFICATION_DELIVERED', 'task.notification.delivered'],
]

export const TaskChangeEvent = Object.freeze(Object.fromEntries(TASK_EVENT_PAIRS))

export const TASK_CHANGE_EVENT_TYPES = new Set(Object.values(TaskChangeEvent))
