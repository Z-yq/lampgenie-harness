// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有;strict 类型化列入 backlog。
import { tidyArtifacts } from './task-artifact'
import { authorizationView } from '../core/work-authorization'
import { inputRequestView } from '../core/work-input-request'

export const TaskRunState = Object.freeze({
  SCHEDULED: 'scheduled',
  QUEUED: 'queued',
  RUNNING: 'running',
  DELEGATED: 'delegated',
  FINALIZING: 'finalizing',
  CANCELLING: 'cancelling',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

export const TaskOrigin = Object.freeze({
  USER: 'user',
  SYSTEM: 'system',
})

// Completion presentation is independent from execution scope. User work is
// normally announced by the voice frontend, while UI-owned operations may
// expose their state through cards/polling and remain silent.
export const TaskNoticePolicy = Object.freeze({
  ANNOUNCE: 'announce',
  SILENT: 'silent',
})

const ACTIVE = new Set([
  TaskRunState.QUEUED,
  TaskRunState.RUNNING,
  TaskRunState.DELEGATED,
  TaskRunState.FINALIZING,
  TaskRunState.CANCELLING,
])
const CANCELLABLE = new Set([
  TaskRunState.SCHEDULED,
  TaskRunState.QUEUED,
  TaskRunState.RUNNING,
  TaskRunState.DELEGATED,
  TaskRunState.FINALIZING,
])
const TERMINAL = new Set([
  TaskRunState.COMPLETED,
  TaskRunState.FAILED,
  TaskRunState.CANCELLED,
])
const KNOWN = new Set(Object.values(TaskRunState))
const TRANSITIONS = new Map([
  [TaskRunState.SCHEDULED, new Set([
    TaskRunState.QUEUED,
    TaskRunState.FAILED,
    TaskRunState.CANCELLED,
  ])],
  [TaskRunState.QUEUED, new Set([
    TaskRunState.RUNNING,
    TaskRunState.FAILED,
    TaskRunState.CANCELLED,
  ])],
  [TaskRunState.RUNNING, new Set([
    TaskRunState.DELEGATED,
    TaskRunState.FINALIZING,
    TaskRunState.CANCELLING,
    TaskRunState.COMPLETED,
    TaskRunState.FAILED,
  ])],
  [TaskRunState.DELEGATED, new Set([
    TaskRunState.FINALIZING,
    TaskRunState.CANCELLING,
    TaskRunState.COMPLETED,
    TaskRunState.FAILED,
  ])],
  [TaskRunState.FINALIZING, new Set([
    TaskRunState.CANCELLING,
    TaskRunState.COMPLETED,
    TaskRunState.FAILED,
  ])],
  [TaskRunState.CANCELLING, new Set([
    TaskRunState.CANCELLED,
    TaskRunState.FAILED,
  ])],
])

export function isLiveTask(status) {
  return ACTIVE.has(status)
}

export function isStoppableTask(status) {
  return CANCELLABLE.has(status)
}

export function isFinishedTask(status) {
  return TERMINAL.has(status)
}

export function tidyTaskOrigin(scope) {
  return scope === TaskOrigin.SYSTEM ? TaskOrigin.SYSTEM : TaskOrigin.USER
}

export function isUserOwnedTask(task) {
  return tidyTaskOrigin(task?.scope) === TaskOrigin.USER
}

export function tidyNoticePolicy(policy) {
  return policy === TaskNoticePolicy.SILENT
    ? TaskNoticePolicy.SILENT
    : TaskNoticePolicy.ANNOUNCE
}

export function shouldAnnounceTaskDone(task) {
  return isUserOwnedTask(task)
    && tidyNoticePolicy(task?.notificationPolicy)
      === TaskNoticePolicy.ANNOUNCE
}

export function workStateView(task) {
  if (task?.authorization?.status === 'pending') return 'auth_required'
  if (task?.inputRequest?.status === 'pending') {
    return task.inputRequest.kind === 'authorization'
      ? 'auth_required'
      : 'input_required'
  }
  if ([TaskRunState.SCHEDULED, TaskRunState.QUEUED].includes(task?.status)) {
    return 'submitted'
  }
  if (isLiveTask(task?.status)) return 'working'
  return isFinishedTask(task?.status) ? task.status : 'submitted'
}

export function advanceTask(task, nextStatus) {
  const currentStatus = task?.status
  if (!KNOWN.has(currentStatus) || !KNOWN.has(nextStatus)) {
    throw new Error(`Unknown task transition: ${currentStatus} -> ${nextStatus}`)
  }
  if (currentStatus === nextStatus) return task
  if (!TRANSITIONS.get(currentStatus)?.has(nextStatus)) {
    throw new Error(`Invalid task transition: ${currentStatus} -> ${nextStatus}`)
  }
  task.status = nextStatus
  return task
}

export function taskView(task, { now = Date.now() } = {}) {
  return {
    id: task.id,
    workState: workStateView(task),
    status: task.status,
    scope: tidyTaskOrigin(task.scope),
    kind: task.kind || 'work',
    ...(task.seriesId ? { seriesId: task.seriesId } : {}),
    parentTaskId: task.parentTaskId || null,
    objective: task.objective,
    ownerId: task.ownerId,
    sessionId: task.sessionId,
    turnId: task.turnId,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    elapsedMs: task.startedAt && isLiveTask(task.status)
      ? now - task.startedAt
      : task.elapsedMs,
    result: task.result,
    error: task.error,
    message: task.message || null,
    artifacts: tidyArtifacts(task.artifacts),
    activity: [...(task.activity || [])],
    delegation: task.delegation
      ? {
          status: task.delegation.status || 'running',
          title: String(task.delegation.title || '').slice(0, 160),
        }
      : null,
    authorization: authorizationView(task.authorization, { taskId: task.id }),
    inputRequest: inputRequestView(task.inputRequest, { taskId: task.id }),
    notificationPolicy: tidyNoticePolicy(task.notificationPolicy),
    notificationStatus: task.notificationStatus,
    notificationDeliveredAt: task.notificationDeliveredAt,
    schedule: task.schedule || null,
    timeoutMs: task.timeoutMs || null,
  }
}

export function storedTask(task) {
  const saved = taskView(task)
  delete saved.workState
  if (
    task.recurrenceStartAt !== null
    && task.recurrenceStartAt !== undefined
    && task.recurrenceStartAt !== ''
    && Number.isFinite(Number(task.recurrenceStartAt))
  ) {
    saved.recurrenceStartAt = Number(task.recurrenceStartAt)
  }
  if (task.recoveryPersistedStatus) {
    saved.status = task.recoveryPersistedStatus
  }
  saved.submissionKey = task.submissionKey || null
  saved.delegation = task.delegation
    ? { ...task.delegation }
    : null
  return saved
}
