// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有;strict 类型化列入 backlog。
import {
  isLiveTask,
  isUserOwnedTask,
  shouldAnnounceTaskDone,
  TaskRunState,
} from './task-state'

export const TaskResumeAction = Object.freeze({
  RESTORE: 'restore',
  RESCHEDULE: 'reschedule',
  REATTACH: 'reattach',
  CANCEL: 'cancel',
  FAIL: 'fail',
})

const REPLAYABLE_REMINDER = new Set([
  TaskRunState.QUEUED,
  TaskRunState.RUNNING,
])

export function taskResumeAction(task) {
  if (task?.status === TaskRunState.SCHEDULED) {
    return TaskResumeAction.RESCHEDULE
  }
  if (
    task?.kind === 'reminder'
    && REPLAYABLE_REMINDER.has(task?.status)
  ) {
    return TaskResumeAction.RESCHEDULE
  }
  if (task?.status === TaskRunState.CANCELLING) {
    return TaskResumeAction.CANCEL
  }
  if (
    isUserOwnedTask(task)
    && [TaskRunState.DELEGATED, TaskRunState.FINALIZING].includes(task?.status)
    && task?.delegation?.id
    && task?.delegation?.sessionId
  ) {
    return TaskResumeAction.REATTACH
  }
  if (isLiveTask(task?.status)) return TaskResumeAction.FAIL
  return TaskResumeAction.RESTORE
}

export function recoveredNoticeStatus(task, action) {
  if (!shouldAnnounceTaskDone(task)) return 'none'
  if (action === TaskResumeAction.FAIL) return 'pending'
  if ([
    TaskResumeAction.RESCHEDULE,
    TaskResumeAction.REATTACH,
    TaskResumeAction.CANCEL,
  ].includes(action)) return 'none'
  if (task?.notificationStatus === 'delivering') return 'pending'
  return task?.notificationStatus || 'none'
}
