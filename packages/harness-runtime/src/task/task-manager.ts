// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有;strict 类型化列入 backlog。
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { TaskTimer } from './task-scheduler'
import { TaskChangeEvent } from './task-events'
import { TaskNoticeQueue } from './task-notification-queue'
import { TaskStore } from './task-repository'
import {
  artifactsOfOutcome,
  unionArtifacts,
  tidyArtifacts,
} from './task-artifact'
import {
  tidyAuthorization,
  resolveWorkAuth,
} from '../core/work-authorization'
import {
  tidyInputRequest,
  resolveInputAsk,
} from '../core/work-input-request'
import {
  isLiveTask,
  isStoppableTask,
  isFinishedTask,
  isUserOwnedTask,
  tidyNoticePolicy,
  tidyTaskOrigin,
  storedTask as storedTaskBase,
  taskView as taskViewBase,
  shouldAnnounceTaskDone as shouldAnnounceTaskDoneBase,
  TaskNoticePolicy,
  TaskOrigin,
  TaskRunState,
  advanceTask,
} from './task-state'
import {
  recoveredNoticeStatus,
  TaskResumeAction,
  taskResumeAction,
} from './task-recovery'
import { BackendSignalType } from '../core/backend-events'
import { tidyRecurrence, tidyTimeZone } from './recurrence'
import { OccurrenceLedger, occurrenceKey, isManualTrigger } from './occurrence'
import {
  composeScheduledObjective,
  validateScheduleContent,
} from './scheduled-content-gate'
import { normalizeTaskKind, taskKindCapabilities } from './task-kind'

// 定时任务的 occurrence 身份:job 级稳定(系列任务用 seriesId,单次任务用任务 id),
// instant 取计划瞬间——与派发时间戳解耦,重启后仍能认出「这次发生做没做过」。
function occurrenceOfTask(task) {
  const schedule = task?.schedule
  if (!schedule || !schedule.occurrenceKey) return null
  const instant = Number(schedule.scheduledInstant ?? schedule.at)
  if (!Number.isFinite(instant)) return null
  return { jobId: String(task.seriesId || task.id), instant }
}

// 内容门字段:只在该任务显式设置过时透传(旧任务/旧调用零变化)。
// taskView 在 task-state(本轮不改),故在管理器内做一层薄包装。
function scheduledContentFields(task) {
  const fields = {}
  if (task?.mode) fields.mode = task.mode
  if (task?.preRun) fields.preRun = { ...task.preRun }
  if (task?.contextFrom) fields.contextFrom = { ...task.contextFrom }
  if (task?.continuity) fields.continuity = { ...task.continuity }
  return fields
}

function taskViewWithContent(task) {
  return { ...taskView(task), ...scheduledContentFields(task) }
}

// kind 能力位随视图/持久化快照透传(可选键;旧消费方忽略未知键)。
// 字段清单在 task-state(本轮不改该文件),故在管理器内做同名薄包装。
function withKindCapabilities(view, task) {
  if (task?.kindCapabilities) view.kindCapabilities = { ...task.kindCapabilities }
 // 回落发生时的原值也随视图透传:审计/面板能看到「它原本报的是什么 kind」。
  if (task?.kindOriginal) view.kindOriginal = String(task.kindOriginal)
  return view
}

function taskView(task, options) {
  return withKindCapabilities(taskViewBase(task, options), task)
}

function storedTask(task) {
  return withKindCapabilities(storedTaskBase(task), task)
}

// canAnnounce=false(subagent/workflow)不公告终态——它们的完成由父任务消费,
// 再公告一次等于重复打扰;其余 kind 逐字沿用既有判定(scope + noticePolicy)。
function shouldAnnounceTaskDone(task) {
  const caps = task?.kindCapabilities ?? taskKindCapabilities(task?.kind).capabilities
  if (caps.canAnnounce === false) return false
  return shouldAnnounceTaskDoneBase(task)
}


// —— start() 期间的后端事件消化器(按次序尝试;返回 true=已消化)——

function digestAuthorizationRequested(task, event, host) {
  if (event?.type !== BackendSignalType.AUTHORIZATION_REQUESTED || !event.permission) return false
  const authorization = tidyAuthorization(event.permission, { taskId: task.id })
  if (!authorization) return true // 形状不合法:吞掉,不进模型上下文
  task.authorization = authorization
  host.emit(TaskChangeEvent.PERMISSION_REQUESTED, task, { permission: authorization })
  return true
}

function digestAuthorizationResolved(task, event, host) {
  if (event?.type !== BackendSignalType.AUTHORIZATION_RESOLVED || !event.permission) return false
  const previous = task.authorization
  const permission = resolveWorkAuth(
    previous?.id === event.permission.id ? previous : event.permission,
    event.permission.status,
    { taskId: task.id },
  )
  if (!permission) return true
  if (previous?.id === permission.id) task.authorization = null
  host.emit(TaskChangeEvent.PERMISSION_RESOLVED, task, { permission })
  return true
}

function digestInputRequested(task, event, host) {
  if (event?.type !== BackendSignalType.INPUT_REQUESTED || !event.input) return false
  const inputRequest = tidyInputRequest(event.input, { taskId: task.id })
  if (!inputRequest) return true
  task.inputRequest = inputRequest
  host.emit(TaskChangeEvent.INPUT_REQUESTED, task, { input: inputRequest })
  return true
}

function digestInputResolved(task, event, host) {
  if (event?.type !== BackendSignalType.INPUT_RESOLVED || !event.input) return false
  const previous = task.inputRequest
  const input = resolveInputAsk(
    previous?.id === event.input.id ? previous : event.input,
    event.input.status,
    { taskId: task.id },
  )
  if (!input) return true
  if (previous?.id === input.id) task.inputRequest = null
  host.emit(TaskChangeEvent.INPUT_RESOLVED, task, { input })
  return true
}

function digestDelegated(task, event, host) {
  if (event?.type !== BackendSignalType.DELEGATED || !event.delegation) return false
  if (['cancelling', 'cancelled'].includes(task.status)) return true // 终态/取消中不再委派
  advanceTask(task, TaskRunState.DELEGATED)
  const { presentation: _dropped, ...delegation } = event.delegation
  task.delegation = delegation
  host.releaseScheduler(task)
  host.emit(TaskChangeEvent.DELEGATED, task)
  host.drain()
  return true
}

function digestDelegationCompleted(task, event, host) {
  if (event?.type !== BackendSignalType.DELEGATION_COMPLETED || !event.delegation) return false
  advanceTask(task, TaskRunState.FINALIZING)
  task.delegation = { ...event.delegation, status: 'completed' }
  host.emit(TaskChangeEvent.FINALIZING, task)
  return true
}

function digestMessage(task, event, host) {
  if (event?.type !== BackendSignalType.MESSAGE || !event.message) return false
  const message = String(event.message).trim().slice(0, 4_000)
  if (!message || message === task.message) return true
  task.message = message
  host.markProgressChanged(task, { message: true })
  host.persistDeferred()
  return true
}

function digestArtifact(task, event, host) {
  if (event?.type !== BackendSignalType.ARTIFACT || !event.artifact) return false
  const conformed = tidyArtifacts([event.artifact])
  if (!conformed.length) return true
  const merged = unionArtifacts(task.artifacts, [conformed[0]])
  if (isDeepStrictEqual(merged, task.artifacts)) return true
  task.artifacts = merged
  host.emit(TaskChangeEvent.UPDATED, task, { persist: false })
  host.persistDeferred()
  return true
}

function digestActivity(task, event, host) {
  if (event?.type !== BackendSignalType.ACTIVITY || !event.activity) return false
  const incoming = event.activity
  const atIndex = incoming.id
    ? task.activity.findIndex(item => item.id === incoming.id)
    : -1
  const isDuplicateTail = atIndex === task.activity.length - 1
    && isDeepStrictEqual(task.activity[atIndex], incoming)
  if (isDuplicateTail) return true
  if (atIndex >= 0) task.activity.splice(atIndex, 1)
  task.activity.push(incoming)
  task.activity = task.activity.slice(-20) // 活动轨迹只留最近 20 条
  host.markProgressChanged(task)
  host.persistDeferred()
  return true
}

const TASK_EVENT_DIGESTS = [
  digestAuthorizationRequested,
  digestAuthorizationResolved,
  digestInputRequested,
  digestInputResolved,
  digestDelegated,
  digestDelegationCompleted,
  digestMessage,
  digestArtifact,
  digestActivity,
]

export function taskRunContext(task, { onEvent, signal }) {
  return Object.freeze({
    taskId: String(task.id),
    ownerId: String(task.ownerId || ''),
    sessionId: String(task.sessionId || 'main'),
    turnId: task.turnId || null,
    kind: String(task.kind || 'work'),
    schedule: task.schedule ? Object.freeze({ ...task.schedule }) : null,
    onEvent,
    signal,
  })
}

export class TaskSupervisor {
  constructor({
    runner = null,
    store = null,
    maxConcurrent = 4,
    maxConcurrentPerOwner = 2,
    systemMaxConcurrent = 2,
    // 终态任务保留 3 天而非 24 小时：语音场景里「周五派的活周一问」很常见，
    // 24 小时会让隔天的查询就拿不到状态，用户只能重新派一次。
    // 数量上限（maxTerminalTasksPerOwner）保持不变：prune() 按 createdAt 降序
    // 保留最新的那一批，所以放宽时间窗不会让内存无界增长 —— 上限仍然是硬顶。
    terminalTtlMs = 259_200_000,
    pendingNotificationTtlMs = 604_800_000,
    notificationClaimTtlMs = 60_000,
    maxTerminalTasksPerOwner = 100,
    // Coalesce real backend updates without turning Task progress into a
    // transport heartbeat. Client connections own their own liveness signals.
    progressEventIntervalMs = 1_000,
    scheduledTaskTimeoutMs = 1_800_000,
    logger: taskLogger = null,
    sessionJournal = null,
  } = {}) {
    this.runner = runner
    this.repository = new TaskStore({
      store,
      serialize: task => {
 // 内容门字段不经过 task-state.storedTask(本轮不改该文件),在此补进持久化快照,
 // 重启恢复后 recurring 仍能沿用 mode/preRun/contextFrom/continuity。
        const saved = storedTask(task)
        return { ...saved, ...scheduledContentFields(task) }
      },
    })
    // Compatibility view for ReminderScheduler and existing integrations.
    // New persistence behavior belongs to repository, not this Map-like view.
    this.tasks = this.repository
    this.scheduler = new TaskTimer({
      maxConcurrent,
      maxConcurrentPerOwner,
    })
    this.systemScheduler = new TaskTimer({
      maxConcurrent: systemMaxConcurrent,
      maxConcurrentPerOwner: systemMaxConcurrent,
    })
    this.terminalTtlMs = terminalTtlMs
    this.pendingNotificationTtlMs = pendingNotificationTtlMs
    this.notificationClaimTtlMs = notificationClaimTtlMs
    this.maxTerminalTasksPerOwner = maxTerminalTasksPerOwner
    this.progressEventIntervalMs = Math.max(
      50,
      Number(progressEventIntervalMs) || 1_000)
    this.logger = taskLogger
    this.sessionJournal = sessionJournal
    this.scheduledTaskTimeoutMs = scheduledTaskTimeoutMs
    this.listeners = new Set()
    this.notifications = new TaskNoticeQueue({
      tasks: this.tasks,
      snapshot: taskView,
      claimTtlMs: () => this.notificationClaimTtlMs,
      onChanged: () => this.persist(),
      onDelivered: task => this.emit(
        TaskChangeEvent.NOTIFICATION_DELIVERED,
        task,
        { persist: false },
      ),
    })
    this.recoveryCandidates = []
    this.scheduledTaskRunner = null
 // 可选注入:pre_run 门 + 上下文摘要提供者;缺省=旧行为(不检查、不拼摘要)。
    this.scheduledPreRunCheck = null
    this.scheduledContextProvider = null
 // occurrence 账本:身份 = job@计划瞬间,跨重启稳定。ownerId 标识本进程,
 // 重启后上一任 owner 的 claimed 残留由 recoverOwner 回收一次(owner 死亡恢复)。
    this.occurrenceLedger = new OccurrenceLedger()
    this.occurrenceOwnerId = `occurrence_owner_${randomUUID()}`
    this.recoveredOccurrenceOwners = new Set()
    this.restore()
    if (this.sessionJournal) this.restoreFromJournal(this.sessionJournal)
  }

  get nextTaskNumber() {
    return this.repository.nextTaskNumber
  }

  set nextTaskNumber(value) {
    this.repository.nextTaskNumber = value
  }

  configureRetention(options = {}) {
    Object.assign(this, options)
    this.prune()
  }

  configureScheduledTaskRunner(runner) {
    this.scheduledTaskRunner = runner
  }

 // 内容门可选注入:pre_run 门(preRunCheck)与摘要提供者(contextProvider)。
 // 两者缺省为 null = 旧行为(start 不检查、不拼摘要,objective 逐字不变)。
  setScheduledHooks({
    preRunCheck = null,
    contextProvider = null,
  }: { preRunCheck?: unknown; contextProvider?: unknown } = {}) {
    this.scheduledPreRunCheck = typeof preRunCheck === 'function' ? preRunCheck : null
    this.scheduledContextProvider = typeof contextProvider === 'function'
      ? contextProvider
      : null
  }

  schedulerFor(task) {
    return isUserOwnedTask(task) ? this.scheduler : this.systemScheduler
  }

 // —— occurrence 账本接线(发生身份与派发时间戳解耦)——

 // 把账本里该 job 的快照写回任务的 schedule(既有持久化透传路径,不改 task-state)。
  #syncOccurrenceSnapshot(tasks = null) {
    const targets = tasks || [...this.tasks.values()]
    let touched = false
    for (const task of targets) {
      const occurrence = occurrenceOfTask(task)
      if (!occurrence || !task.schedule) continue
      task.schedule = {
        ...task.schedule,
        occurrenceLedger: this.occurrenceLedger.snapshotForJob(occurrence.jobId),
      }
      touched = true
    }
    if (touched) this.persistDeferred()
    return touched
  }

 // 起跑前的认领:claim 先于推进 next_run,进程在派发前死掉时该发生仍可补跑。
  #claimOccurrence(task) {
    const occurrence = occurrenceOfTask(task)
    if (!occurrence) return null
    const claim = this.occurrenceLedger.claim(occurrence.jobId, occurrence.instant, {
      ownerId: this.occurrenceOwnerId,
      at: Date.now(),
    })
    this.#syncOccurrenceSnapshot([task])
    return claim
  }

 // 终态落账:completed(非 manual)才 stamp;failed 允许重试;cancelled 释放认领。
  #settleOccurrence(task) {
    const occurrence = occurrenceOfTask(task)
    if (!occurrence) return
    const at = Date.now()
    if (task.status === TaskRunState.COMPLETED) {
 // manual/force 触发不 stamp:手动跑过一次不能把定时槽标记为已完成。
      this.occurrenceLedger.complete(occurrence.jobId, occurrence.instant, {
        status: 'completed',
        at,
        manual: task.manualTrigger === true,
      })
    } else if (task.status === TaskRunState.FAILED) {
      this.occurrenceLedger.complete(occurrence.jobId, occurrence.instant, {
        status: 'failed',
        at,
      })
    } else if (task.status === TaskRunState.CANCELLED) {
      this.occurrenceLedger.release(occurrence.jobId, occurrence.instant)
    } else {
      return
    }
    this.#syncOccurrenceSnapshot([task])
  }

 // 恢复时合并各任务的账本快照,并回收「上一任 owner」的 claimed 残留(只回收一次)。
  #recoverOccurrenceOwners(records = []) {
    for (const saved of records) {
      const snapshot = saved?.schedule?.occurrenceLedger
      if (!snapshot) continue
 // 已回收过的死 owner 认领不得随再次 restore 复活(owner 死亡只恢复一次)。
      const entries = Array.isArray(snapshot.entries)
        ? snapshot.entries.filter(entry => !(
          entry?.status === 'claimed'
          && this.recoveredOccurrenceOwners.has(entry.ownerId)
        ))
        : snapshot.entries
      this.occurrenceLedger.merge({ ...snapshot, entries })
    }
    for (const ownerId of this.occurrenceLedger.claimedOwners()) {
      if (ownerId === this.occurrenceOwnerId) continue
      if (this.recoveredOccurrenceOwners.has(ownerId)) continue
      this.recoveredOccurrenceOwners.add(ownerId)
      this.occurrenceLedger.recoverOwner(ownerId, { at: Date.now() })
    }
  }

  releaseScheduler(task) {
    if (!task.schedulerHeld) return
    this.schedulerFor(task).release(task)
    task.schedulerHeld = false
  }

  restore(savedTasks = null) {
    const records = savedTasks || this.repository.load()
    let mutated = false
    const noteMutation = () => { mutated = true }
    for (const saved of records) {
      this.#migratePersistedFields(saved, noteMutation)
      const recovery = taskResumeAction(saved)
      if (recovery !== TaskResumeAction.RESTORE) noteMutation()
      if (saved.notificationStatus === 'delivering') noteMutation()
      // Scheduled work survives intact. A reminder that was already firing
      // is safe to catch up because its runner only speaks persisted text.
      if (recovery === TaskResumeAction.RESCHEDULE) {
        const task = {
          ...saved,
          status: 'scheduled',
          runner: saved.kind === 'reminder'
            ? async obj => ({ content: obj })
            : null, // scheduled_task runner set from scheduledTaskRunner in start
          resolve: null,
          promise: null,
          activity: Array.isArray(saved.activity) ? saved.activity : [],
          abortController: null,
          schedulerHeld: false,
          notificationStatus: 'none',
          notificationClaimantId: null,
          notificationClaimedAt: null,
          timeoutTimer: null,
        }
        task.promise = new Promise(resolve => {
          task.resolve = resolve
        })
        this.tasks.set(task.id, task)
        continue
      }
      const reattach = recovery === TaskResumeAction.REATTACH
      const fail = recovery === TaskResumeAction.FAIL
      const cancel = recovery === TaskResumeAction.CANCEL
      const task = {
        ...saved,
        status: reattach
          ? 'queued'
          : cancel ? 'cancelled'
            : fail ? 'failed' : saved.status,
        error: fail
          ? '网关重启时这项工作尚未完成，请重新提交。'
          : cancel ? null : saved.error || null,
        completedAt: fail || cancel
          ? Date.now()
          : saved.completedAt,
        activity: Array.isArray(saved.activity) ? saved.activity : [],
        delegation: reattach || !isLiveTask(saved.status)
          ? saved.delegation || null
          : null,
        authorization: recovery !== TaskResumeAction.RESTORE
          || isFinishedTask(saved.status)
          ? null
          : saved.authorization,
        inputRequest: recovery !== TaskResumeAction.RESTORE
          || isFinishedTask(saved.status)
          ? null
          : saved.inputRequest,
        notificationStatus: recoveredNoticeStatus(saved, recovery),
        notificationClaimantId: null,
        notificationClaimedAt: null,
        resolve: null,
        promise: null,
        runner: null,
        timeoutTimer: null,
        // Until the adapter accepts recovery, persistence must retain the
        // recoverable backend phase rather than checkpoint the temporary
        // in-memory `queued` phase.
        recoveryPersistedStatus: reattach ? saved.status : null,
      }
      if (reattach) {
        task.promise = new Promise(resolve => {
          task.resolve = resolve
        })
        this.recoveryCandidates.push(task)
      } else {
        task.promise = Promise.resolve(taskView(task))
      }
      this.tasks.set(task.id, task)
    }
 // occurrence 账本随任务快照恢复:上一任进程的 claimed 残留只回收一次,
 // 已 completed 的发生不会再补跑(start 的 claim 会判 ALREADY_COMPLETED)。
    this.#recoverOccurrenceOwners(records)
    this.prune()
    if (mutated) this.persist()
  }

  // 旧字段迁移:job_ 短 id 改 task_、parentWorkId 归一、循环任务补 seriesId、
  // 产物/授权/输入请求过一遍收敛器。
  #migratePersistedFields(saved, noteMutation) {
    saved.scope = tidyTaskOrigin(saved.scope)
    saved.notificationPolicy = tidyNoticePolicy(saved.notificationPolicy)
    const legacyId = /^job_(\d+)$/u.exec(String(saved.jobId || ''))
    const needsShortId = isUserOwnedTask(saved)
      && !/^task_\d+$/u.test(String(saved.id || ''))
    if (needsShortId) {
      const candidate = legacyId ? `task_${legacyId[1]}` : ''
      saved.id = candidate && !this.tasks.get(candidate)
        ? candidate
        : this.allocateTaskId()
      noteMutation()
    }
    delete saved.jobId
    if (!saved.parentTaskId && saved.parentWorkId) saved.parentTaskId = saved.parentWorkId
    delete saved.parentWorkId
    const recurring = tidyRecurrence(saved.schedule?.recurrence) !== 'once'
    if (recurring && !String(saved.seriesId || '').trim()) {
      saved.seriesId = String(saved.id)
      noteMutation()
    }
    delete saved.presentation
    delete saved.resultMetadata
    saved.artifacts = tidyArtifacts(saved.artifacts)
    saved.authorization = tidyAuthorization(saved.authorization, { taskId: saved.id })
    saved.inputRequest = tidyInputRequest(saved.inputRequest, { taskId: saved.id })
  }

  // 定时任务复活:提醒类自带只读 runner,定时类等 start() 接线。
  #reviveScheduled(saved) {
    const task = {
      ...saved,
      status: 'scheduled',
      runner: saved.kind === 'reminder'
        ? async obj => ({ content: obj })
        : null, // scheduled_task 的 runner 由 start 从 scheduledTaskRunner 接线
      resolve: null,
      promise: null,
      activity: Array.isArray(saved.activity) ? saved.activity : [],
      abortController: null,
      schedulerHeld: false,
      notificationStatus: 'none',
      notificationClaimantId: null,
      notificationClaimedAt: null,
      timeoutTimer: null,
    }
    task.promise = new Promise(resolve => { task.resolve = resolve })
    return task
  }

  // 在飞任务按恢复动作收敛到终态或重新排队。
  #reviveInFlight(saved, recovery, { reattach, failed, cancelled }) {
    const wasOpen = isLiveTask(saved.status)
    return {
      ...saved,
      status: reattach ? 'queued' : cancelled ? 'cancelled' : failed ? 'failed' : saved.status,
      error: failed ? '网关重启时这项工作尚未完成，请重新提交。' : cancelled ? null : saved.error || null,
      completedAt: failed || cancelled ? Date.now() : saved.completedAt,
      activity: Array.isArray(saved.activity) ? saved.activity : [],
      delegation: reattach || !wasOpen ? saved.delegation || null : null,
      authorization: recovery !== TaskResumeAction.RESTORE || isFinishedTask(saved.status)
        ? null : saved.authorization,
      inputRequest: recovery !== TaskResumeAction.RESTORE || isFinishedTask(saved.status)
        ? null : saved.inputRequest,
      notificationStatus: recoveredNoticeStatus(saved, recovery),
      notificationClaimantId: null,
      notificationClaimedAt: null,
      resolve: null,
      promise: null,
      runner: null,
      timeoutTimer: null,
      // 适配器接手恢复前,持久化必须保留可恢复的后端阶段,而不是先记内存里的 queued。
      recoveryPersistedStatus: reattach ? saved.status : null,
    }
  }

  // 用最新 journal 快照对账内存任务(短 id 可复用:更老的生命周期不当修订)。
  restoreFromJournalSnapshots(snapshots = []) {
    const candidates = snapshots.filter(snapshot => snapshot?.id)
    if (!candidates.length) return 0
    let restored = 0
    for (const snapshot of candidates) {
      const id = String(snapshot.id)
      const existing = this.tasks.get(id)
      if (this.#isStaleAgainstJournal(existing, snapshot)) continue
      // journal 事件才是持久修订:回放前先摘除压缩快照投影,终态 journal 才能
      // 修复崩溃后过期的 tasks.json。
      if (existing) {
        this.recoveryCandidates = this.recoveryCandidates.filter(
          candidate => candidate !== existing)
        this.tasks.delete(id)
      }
      this.restore([this.#withSeriesAnchor(snapshot, existing?.recurrenceStartAt)])
      restored += 1
    }
    return restored
  }

  // 短 id 可被回收复用:更老的生命周期不是当前任务的修订,
  // 哪怕它在 journal 里有更大的本地序号。
  #isStaleAgainstJournal(existing, snapshot) {
    return Number(existing?.createdAt) > Number(snapshot.createdAt)
  }

  // 系列锚点择优:journal 侧有效用 journal 的,否则沿用内存侧现值。
  #withSeriesAnchor(snapshot, fallbackAnchor) {
    const usable = value => (
      value !== null && value !== undefined && value !== ''
      && Number.isFinite(Number(value))
    )
    const patch = usable(snapshot.recurrenceStartAt)
      ? { recurrenceStartAt: Number(snapshot.recurrenceStartAt) }
      : usable(fallbackAnchor)
        ? { recurrenceStartAt: Number(fallbackAnchor) }
        : {}
    return { ...snapshot, ...patch }
  }

  // 从 journal 对象直接取投影对账。
  restoreFromJournal(journal) {
    return this.restoreFromJournalSnapshots(journal?.taskSnapshotsSync?.() || [])
  }

  // 委派型任务的恢复登记:适配器接受前保持可恢复阶段可见。
  recoverDelegated({
    canRecover,
    runner,
    canceler,
  } = {}) {
    const candidates = this.recoveryCandidates.splice(0)
    for (const task of candidates) {
      const snapshot = {
        ...taskView(task),
        delegation: task.delegation ? { ...task.delegation } : null,
      }
      if (!canRecover?.(snapshot)) {
        task.recoveryPersistedStatus = null
        advanceTask(task, TaskRunState.FAILED)
        task.error = 'qwen-audio-agent 重启时这项项目任务失去连接，请重新提交。'
        task.completedAt = Date.now()
        task.notificationStatus = shouldAnnounceTaskDone(task) ? 'pending' : 'none'
        task.promise = Promise.resolve(taskView(task))
        task.resolve = null
        this.emit(TaskChangeEvent.FAILED, task)
        if (shouldAnnounceTaskDone(task)) {
          this.emit(TaskChangeEvent.NOTIFICATION_PENDING, task)
        }
        continue
      }
      task.runner = (_objective, context) => runner(snapshot, context)
      task.canceler = typeof canceler === 'function'
        ? context => canceler(snapshot, context)
        : null
      this.start(task)
    }
  }

  persist() {
    this.repository.save()
  }

  persistDeferred() {
    this.repository.saveDeferred()
  }

  allocateTaskId() {
    return this.repository.allocateTaskId()
  }

  subscribe(listener, { scope = TaskOrigin.USER } = {}) {
    const subscription = { listener, scope }
    this.listeners.add(subscription)
    return () => this.listeners.delete(subscription)
  }

  // 事件出口:先落事件账(幂等键=type+task+seq),再通知订阅者;持久化可按事件关。
  emit(type, task, { persist = true, ...details } = {}) {
    const snapshot = taskView(task)
    const event = { type, ownerId: task.ownerId, task: snapshot, ...details }
    this.#logEvent(type, task)
    this.#fanOut(event, task)
    if (persist) this.persist()
  }

  // 里程碑级事件走 info 级日志(建/调度/跑/委派/审批/终态),其余 debug。
  #logEvent(type, task) {
    const MILESTONE = new Set([
      TaskChangeEvent.SCHEDULED,
      'task.created',
      TaskChangeEvent.RUNNING,
      TaskChangeEvent.DELEGATED,
      TaskChangeEvent.PERMISSION_REQUESTED,
      TaskChangeEvent.PERMISSION_RESOLVED,
      TaskChangeEvent.COMPLETED,
      TaskChangeEvent.FAILED,
      TaskChangeEvent.CANCELLED,
    ])
    const write = MILESTONE.has(type) ? this.logger?.info : this.logger?.debug
    write?.(type, {
      taskId: task.id,
      ownerId: task.ownerId,
      sessionId: task.sessionId,
      turnId: task.turnId,
      kind: task.kind || 'work',
      status: task.status,
      elapsedMs: task.elapsedMs,
      hasError: Boolean(task.error),
    })
  }

  #fanOut(event, task) {
    for (const subscription of this.listeners) {
      const scoped = subscription.scope !== 'all'
        && tidyTaskOrigin(task.scope) !== subscription.scope
      if (scoped) continue
      try {
        subscription.listener(event)
      } catch {
        // 单个观察者抛错不许打断工作队列。
      }
    }
  }

  markProgressChanged(task, { message = false } = {}) {
    task.progressChanged = true
    if (message) task.messageChanged = true
  }

  flushProgress(task) {
    if (!task.progressChanged) return false
    const messageChanged = task.messageChanged === true
    task.progressChanged = false
    task.messageChanged = false
    this.emit(
      messageChanged ? TaskChangeEvent.UPDATED : TaskChangeEvent.PROGRESS,
      task,
      {
        persist: false,
        ...(messageChanged ? { message: task.message } : {}),
      },
    )
    return true
  }

  create(options = {}) {
 // kind 归一到封闭枚举(未知/空 → user;normalized=false 时保留原值供审计);
 // 能力位以只读快照挂在任务上,taskView/storedTask 透传给面板与审计消费方。
    const normalizedKind = normalizeTaskKind(options.kind ?? 'user')
    return this.#create({
      ...options,
      scope: TaskOrigin.USER,
      kind: normalizedKind.kind,
      kindCapabilities: taskKindCapabilities(normalizedKind.kind).capabilities,
      kindOriginal: !normalizedKind.normalized && normalizedKind.original
        ? normalizedKind.original
        : null,
    })
  }

  createSystemJob(options = {}) {
    return this.#create({
      ...options,
      scope: TaskOrigin.SYSTEM,
      kind: options.kind || 'system_job',
      ownerId: options.ownerId || 'system',
      sessionId: options.sessionId || 'system',
    })
  }

  // 新任务的公共字段壳:两条创建路径(user/scheduled)共用,避免字段清单双份漂移。
  #taskShell(overrides) {
    return {
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      elapsedMs: 0,
      result: null,
      error: null,
      message: null,
      artifacts: [],
      activity: [],
      delegation: null,
      cancellation: null,
      authorization: null,
      inputRequest: null,
      notificationPolicy: TaskNoticePolicy.ANNOUNCE,
      notificationStatus: 'none',
      notificationClaimantId: null,
      notificationClaimedAt: null,
      cancelPromise: null,
      terminalHandled: false,
      abortController: null,
      schedulerHeld: false,
      timeoutTimer: null,
      resolve: null,
      promise: null,
      runner: null,
      canceler: null,
      ...overrides,
    }
  }

  #create({
    objective,
    ownerId,
    sessionId,
    turnId,
    submissionKey,
    laneKey,
    laneLimit = 1,
    kind,
    kindCapabilities = null,
    kindOriginal = null,
    scope,
    parentTaskId = null,
    priority = 0,
    notificationPolicy = TaskNoticePolicy.ANNOUNCE,
    runner,
    canceler,
  }) {
    const normalizedScope = tidyTaskOrigin(scope)
    const normalizedOwnerId = String(ownerId || '')
    const normalizedSubmissionKey = String(submissionKey || '').trim()
    if (normalizedSubmissionKey) {
      const existing = [...this.tasks.values()].find(item => (
        item.ownerId === normalizedOwnerId
        && tidyTaskOrigin(item.scope) === normalizedScope
        && item.submissionKey === normalizedSubmissionKey
      ))
      if (existing) return { ...taskView(existing), reused: true }
    }
    const task = this.#taskShell({
      id: normalizedScope === TaskOrigin.USER
        ? this.allocateTaskId()
        : `system_${randomUUID()}`,
      scope: normalizedScope,
      kind: String(kind),
      ...(kindCapabilities ? { kindCapabilities: Object.freeze({ ...kindCapabilities }) } : {}),
      ...(kindOriginal ? { kindOriginal: String(kindOriginal) } : {}),
      parentTaskId: parentTaskId ? String(parentTaskId) : null,
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
      objective: String(objective || '').trim(),
      ownerId: normalizedOwnerId,
      sessionId: String(sessionId || 'main'),
      turnId: turnId || null,
      submissionKey: normalizedSubmissionKey || null,
      laneKey: laneKey || null,
      laneLimit,
      notificationPolicy: tidyNoticePolicy(notificationPolicy),
      runner: runner || this.runner,
      canceler: typeof canceler === 'function' ? canceler : null,
    })
    this.tasks.set(task.id, task)
    this.emit(TaskChangeEvent.ACCEPTED, task)
    queueMicrotask(() => this.drain())
    return { ...taskView(task), reused: false }
  }

  createScheduled({
    objective,
    ownerId,
    sessionId,
    turnId,
    schedule: { at, recurrence = 'once', timeZone = null } = {},
    type = 'reminder',
    timeoutMs = null,
    runner = null,
    recurrenceStartAt = null,
    seriesId = null,
 // 计划瞬间:发生身份的一半。缺省沿用 at,与派发时间戳(dispatch stamp)彻底分离。
    scheduledInstant = null,
 // manual/force 触发不得把定时槽标记为已完成(见 #settleOccurrence)。
    trigger = null,
 // 内容门(全部可选:缺省=旧行为,不做内容校验/不存内容字段)。
    mode = undefined,
    preRun = undefined,
    contextFrom = undefined,
    continuity = undefined,
    projectId = null,
  }) {
 // 内容门:只有显式给了内容字段才校验(旧调用零变化);失败不建任务。
    const hasContentSpec = mode !== undefined
      || preRun !== undefined
      || contextFrom !== undefined
      || continuity !== undefined
    const content = hasContentSpec
      ? validateScheduleContent({ instruction: objective, mode, preRun, contextFrom, continuity })
      : null
    if (content && !content.ok) {
      return { error: content.code, issues: [...content.issues] }
    }
    const normalizedContent = content ? content.normalized : null
 // 只允许 reminder/scheduled_task 两条定时路径;归一校验后能力位随任务挂载。
    const kind = type === 'task' ? 'scheduled_task' : 'reminder'
    const normalizedKind = normalizeTaskKind(kind)
    const normalizedRecurrence = tidyRecurrence(recurrence)
    const scheduledAt = Number(at)
    const occurrenceInstant = scheduledInstant == null || scheduledInstant === ''
      ? scheduledAt
      : Number.isFinite(Number(scheduledInstant))
        ? Number(scheduledInstant)
        : scheduledAt
    const recurrenceAnchor = recurrenceStartAt == null
      || recurrenceStartAt === ''
      ? NaN
      : Number(recurrenceStartAt)
    const taskId = this.allocateTaskId()
    const normalizedSeriesId = normalizedRecurrence === 'once'
      ? null
      : String(seriesId || taskId).trim().slice(0, 128) || taskId
    const occurrenceJobId = normalizedSeriesId || taskId
    const task = this.#taskShell({
      id: taskId,
      status: 'scheduled',
      scope: TaskOrigin.USER,
      kind: normalizedKind.kind,
      kindCapabilities: taskKindCapabilities(normalizedKind.kind).capabilities,
      seriesId: normalizedSeriesId,
      objective: normalizedContent
        ? normalizedContent.instruction
        : String(objective || '').trim(),
      ...(normalizedContent ? {
        mode: normalizedContent.mode,
        preRun: normalizedContent.preRun,
        contextFrom: normalizedContent.contextFrom,
        continuity: normalizedContent.continuity,
      } : {}),
      ...(projectId ? { projectId: String(projectId) } : {}),
      ownerId: String(ownerId || ''),
      sessionId: String(sessionId || 'main'),
      turnId: turnId || null,
      // 原始瞬间留在公共投影之外:DST 缺口可能把本次发生前移,若拿前移后的
      // 瞬间当系列锚点,后面的所有发生都会被永久推移。
      recurrenceStartAt: normalizedRecurrence === 'once'
        ? null
        : Number.isFinite(recurrenceAnchor)
          ? recurrenceAnchor
          : scheduledAt,
      priority: 0,
      parentTaskId: null,
      schedule: {
        type: 'at',
        at: scheduledAt,
        scheduledInstant: occurrenceInstant,
        occurrenceKey: occurrenceKey(occurrenceJobId, occurrenceInstant),
        recurrence: normalizedRecurrence,
        ...(normalizedRecurrence === 'once'
          ? {}
          : { timeZone: tidyTimeZone(timeZone) }),
      },
      timeoutMs: type === 'task'
        ? Number(timeoutMs) || this.scheduledTaskTimeoutMs
        : null,
      runner: runner || (type === 'task' && typeof this.scheduledTaskRunner === 'function'
        ? this.scheduledTaskRunner
        : async obj => ({ content: obj })),
      manualTrigger: isManualTrigger(trigger),
    })
    this.tasks.set(task.id, task)
    this.emit(TaskChangeEvent.SCHEDULED, task)
    // Do not call drain() — scheduled tasks wait for their timer.
    return { ...taskViewWithContent(task), reused: false }
  }


  drain() {
    const byTurn = [...this.tasks.values()]
      .filter(task => task.status === 'queued')
      .sort((left, right) => (
        Number(right.priority || 0) - Number(left.priority || 0)
        || left.createdAt - right.createdAt
      ))
    for (const task of byTurn) {
      const gateOpen = this.schedulerFor(task).canStart(task)
      if (!gateOpen) continue
      this.start(task)
    }
  }

  start(taskOrId) {
 // 接受任务 id 或任务对象(生产调度器从 list 拿到的视图只有 id),
 // 且允许从 scheduled 直接起跑(内部先补 scheduled→queued 合法迁移)。
    const task = typeof taskOrId === 'string'
      ? this.tasks.get(String(taskOrId))
      : taskOrId
    if (!task) return null
 // occurrence 身份闸:先 claim 再起跑(tick 必须先 claim 再推进 next_run)。
 // claim 失败 = 这次发生已完成/已被认领:不启动,用既有 SCHEDULED 事件承载跳过原因,
 // 不新增对外协议。
    const occurrence = this.#claimOccurrence(task)
    if (occurrence && !occurrence.ok) {
      task.occurrenceSkip = {
        code: occurrence.code,
        key: occurrence.key,
        at: Date.now(),
      }
      this.emit(TaskChangeEvent.SCHEDULED, task, { occurrenceSkip: { ...task.occurrenceSkip } })
      return taskView(task)
    }
    if (task.status === TaskRunState.SCHEDULED) advanceTask(task, TaskRunState.QUEUED)
    task.recoveryPersistedStatus = null
    advanceTask(task, TaskRunState.RUNNING)
    task.startedAt = Date.now()
    task.abortController = new AbortController()
    this.schedulerFor(task).acquire(task)
    task.schedulerHeld = true
    this.emit(TaskChangeEvent.RUNNING, task)
    task.progressTimer = setInterval(() => {
      if (isLiveTask(task.status)) {
        this.flushProgress(task)
      }
    }, this.progressEventIntervalMs)
    task.progressTimer.unref?.()
    // 后端事件按「先问询类(授权/输入)→ 再生命周期(委派)→ 再进度类(消息/产物/活动)」
    // 的固定次序分派;每个处理器返回 true 表示已消化,否则落到下一类。
    const onEvent = event => {
      for (const digest of TASK_EVENT_DIGESTS) {
        if (digest(task, event, this)) return
      }
    }
    // Fallback runner for restored scheduled tasks whose runner was lost
    // during serialisation.
    if (typeof task.runner !== 'function'
      && task.kind === 'scheduled_task'
      && typeof this.scheduledTaskRunner === 'function'
    ) {
      task.runner = this.scheduledTaskRunner
    }
    // 定时任务硬超时看门狗(每轮墙钟预算的机制思路参考 OpenClaw 项目,致谢):
    // 先 abort 运行器,留 5 秒清理窗,再强制置败。
    const needsWatchdog = task.kind === 'scheduled_task' && task.timeoutMs
    if (needsWatchdog) {
      task.timeoutTimer = setTimeout(() => {
        if (!isLiveTask(task.status)) return
        task.abortController?.abort(
          new Error('定时任务执行超时，正在终止'),
        )
        const cleanup = setTimeout(() => {
          if (!isLiveTask(task.status)) return
          task.terminalHandled = true
          advanceTask(task, TaskRunState.FAILED)
          task.error = `定时任务执行超时（${Math.round(task.timeoutMs / 60000)} 分钟）`
          task.completedAt = Date.now()
          task.elapsedMs = task.startedAt
            ? task.completedAt - task.startedAt : 0
          this.#settleOccurrence(task)
          task.notificationStatus = shouldAnnounceTaskDone(task) ? 'pending' : 'none'
          clearInterval(task.progressTimer)
          task.progressTimer = null
          this.releaseScheduler(task)
          this.emit(TaskChangeEvent.FAILED, task)
          if (shouldAnnounceTaskDone(task)) {
            this.emit(TaskChangeEvent.NOTIFICATION_PENDING, task)
          }
          this.persistDeferred()
          this.drain()
        }, 5000)
        cleanup.unref?.()
      }, task.timeoutMs)
      task.timeoutTimer.unref?.()
    }
    Promise.resolve()
      .then(async () => {
        const preRunOk = await this.#preRunAllowed(task)
        if (!preRunOk) {
          const failure = new Error('PRE_RUN_FAILED')
          failure.code = 'PRE_RUN_FAILED'
          throw failure
        }
 // no_agent:到点只落提醒,不跑模型(不调 runner,直接走完成路径)。
        if (task.mode === 'no_agent') return { content: task.objective }
        const objective = await this.#scheduledObjective(task)
        if (typeof task.runner !== 'function') {
          throw new Error('未配置后台 Agent 执行器')
        }
        return task.runner(objective, taskRunContext(task, {
          onEvent,
          signal: task.abortController.signal,
        }))
      })
      .then(outcome => {
        if (
          task.terminalHandled
          || ['cancelling', 'cancelled'].includes(task.status)
        ) return
        this.flushProgress(task)
        advanceTask(task, TaskRunState.COMPLETED)
        task.result = String(outcome?.content ?? outcome ?? '').trim()
        task.artifacts = unionArtifacts(
          task.artifacts,
          artifactsOfOutcome(outcome),
        )
      })
      .catch(error => {
        if (
          task.terminalHandled
          || ['cancelling', 'cancelled'].includes(task.status)
        ) return
        this.flushProgress(task)
        advanceTask(task, TaskRunState.FAILED)
 // 前置条件不满足是「可判定的跳过」,错误码按内容门口径落账,不携带 runner 噪音文案。
        task.error = error?.code === 'PRE_RUN_FAILED'
          ? 'PRE_RUN_FAILED'
          : (error?.message || String(error))
      })
      .finally(() => {
        if (task.terminalHandled) return
        clearInterval(task.progressTimer)
        task.progressTimer = null
        if (task.timeoutTimer) { clearTimeout(task.timeoutTimer); task.timeoutTimer = null }
        task.abortController = null
        task.authorization = null
        task.inputRequest = null
        if (task.status === 'cancelling') return
        if (task.status === 'cancelled') {
          this.#settleOccurrence(task)
          this.releaseScheduler(task)
          this.drain()
          return
        }
        task.completedAt = Date.now()
        task.elapsedMs = task.startedAt
          ? task.completedAt - task.startedAt
          : 0
        task.notificationStatus = shouldAnnounceTaskDone(task) ? 'pending' : 'none'
        task.terminalHandled = true
        this.#settleOccurrence(task)
        this.releaseScheduler(task)
        this.emit(
          task.status === 'completed'
            ? TaskChangeEvent.COMPLETED
            : TaskChangeEvent.FAILED,
          task)
        if (shouldAnnounceTaskDone(task)) {
          this.emit(TaskChangeEvent.NOTIFICATION_PENDING, task)
        }
        task.resolve?.(taskView(task))
        this.prune()
        this.drain()
      })
  }

 // —— 定时任务内容门/摘要注入 ——

 // 前置命令门:未配置 preRun 或未注入 preRunCheck = 旧行为(放行)。
 // 支持返回 boolean / {ok} / {exitCode} / 退出码数字;抛错按失败处理(fail-closed)。
  async #preRunAllowed(task) {
    if (!task?.preRun || typeof this.scheduledPreRunCheck !== 'function') return true
    try {
      const verdict = await this.scheduledPreRunCheck({
        task: taskView(task),
        command: task.preRun.command,
      })
      if (typeof verdict === 'number') return verdict === 0
      if (verdict && typeof verdict === 'object') {
        if ('ok' in verdict) return verdict.ok === true
        if ('exitCode' in verdict) return Number(verdict.exitCode) === 0
      }
      return verdict === true
    } catch {
      return false
    }
  }

 // 摘要在跑模型前拼进 objective:context_from(指定任务/会话)+ continuity(同系列上次)。
 // 未配置 provider 或没给摘要 = 原 objective 逐字不变。
  async #scheduledObjective(task) {
    const needsContext = task?.contextFrom || task?.continuity
    if (!needsContext || typeof this.scheduledContextProvider !== 'function') {
      return task.objective
    }
    let provided = null
    try {
      provided = await this.scheduledContextProvider({
        task: taskView(task),
        contextFrom: task.contextFrom || null,
        continuity: task.continuity || null,
      })
    } catch {
      provided = null
    }
    if (!provided) return task.objective
    const contextSummary = typeof provided === 'string'
      ? provided
      : provided.contextSummary
    const continuitySummary = typeof provided === 'string'
      ? undefined
      : provided.continuitySummary
    return composeScheduledObjective({
      instruction: task.objective,
      contextSummary,
      continuitySummary,
    }) || task.objective
  }

  async cancel(id, { ownerId, scope = TaskOrigin.USER } = {}) {
    const task = this.tasks.get(String(id))
    if (
      !task
      || tidyTaskOrigin(task.scope) !== scope
      || (ownerId !== undefined && task.ownerId !== String(ownerId))
      || (!isStoppableTask(task.status) && task.status !== 'cancelling')
    ) {
      return null
    }
    if (task.cancelPromise) return task.cancelPromise
    const previousStatus = task.status
    if (previousStatus === 'queued' || previousStatus === 'scheduled') {
      return this.finishCancellation(task)
    }
    advanceTask(task, TaskRunState.CANCELLING)
    task.authorization = null
    task.inputRequest = null
    this.emit(TaskChangeEvent.CANCELLING, task)
    task.cancelPromise = Promise.resolve()
      .then(async () => {
        if (task.canceler) {
          const cancellation = await task.canceler({
            task: taskView(task),
            previousStatus,
            abort: reason => task.abortController?.abort(
              reason || new Error('用户已取消这项工作'),
            ),
          })
          if (cancellation && typeof cancellation === 'object') {
            task.cancellation = { ...cancellation }
          }
        } else {
          task.abortController?.abort(new Error('用户已取消这项工作'))
        }
        return this.finishCancellation(task)
      })
      .catch(error => {
        task.abortController?.abort(
          error instanceof Error ? error : new Error(String(error)),
        )
        clearInterval(task.progressTimer)
        task.progressTimer = null
        if (task.timeoutTimer) { clearTimeout(task.timeoutTimer); task.timeoutTimer = null }
        task.abortController = null
        task.authorization = null
        task.inputRequest = null
        advanceTask(task, TaskRunState.FAILED)
        task.error = `取消失败：${error?.message || String(error)}`
        task.completedAt = Date.now()
        task.elapsedMs = task.startedAt
          ? task.completedAt - task.startedAt
          : 0
        task.notificationStatus = shouldAnnounceTaskDone(task) ? 'pending' : 'none'
        task.terminalHandled = true
        this.#settleOccurrence(task)
        this.releaseScheduler(task)
        this.emit(TaskChangeEvent.FAILED, task)
        if (shouldAnnounceTaskDone(task)) {
          this.emit(TaskChangeEvent.NOTIFICATION_PENDING, task)
        }
        task.resolve?.(taskView(task))
        this.prune()
        this.drain()
        return taskView(task)
      })
    return task.cancelPromise
  }

  async cancelSeries(seriesId, { ownerId } = {}) {
    const normalizedSeriesId = String(seriesId || '').trim()
    if (!normalizedSeriesId) return []
    const targets = [...this.tasks.values()]
      .filter(task => (
        task.seriesId === normalizedSeriesId
        && (ownerId === undefined || task.ownerId === String(ownerId))
        && isStoppableTask(task.status)
      ))
      .sort((left, right) => left.createdAt - right.createdAt)
    const cancelled = []
    for (const task of targets) {
      const result = await this.cancel(task.id, { ownerId })
      if (result) cancelled.push(result)
    }
    return cancelled
  }

  finishCancellation(task) {
    advanceTask(task, TaskRunState.CANCELLED)
    task.authorization = null
    task.inputRequest = null
    task.completedAt = Date.now()
    task.elapsedMs = task.startedAt
      ? task.completedAt - task.startedAt
      : 0
    task.error = null
    task.notificationStatus = 'none'
    task.terminalHandled = true
    this.#settleOccurrence(task)
    clearInterval(task.progressTimer)
    task.progressTimer = null
    if (task.timeoutTimer) { clearTimeout(task.timeoutTimer); task.timeoutTimer = null }
    task.abortController = null
    this.releaseScheduler(task)
    this.emit(TaskChangeEvent.CANCELLED, task)
    task.resolve?.(taskView(task))
    this.prune()
    this.drain()
    return taskView(task)
  }

  get(id, { ownerId, scope = TaskOrigin.USER } = {}) {
    const task = this.tasks.get(String(id))
    if (
      !task
      || tidyTaskOrigin(task.scope) !== scope
      || (ownerId !== undefined && task.ownerId !== String(ownerId))
    ) {
      return null
    }
    return taskViewWithContent(task)
  }

  getByTaskId(taskId, { ownerId } = {}) {
    return this.get(taskId, { ownerId, scope: TaskOrigin.USER })
  }

  list({
    ownerId,
    sessionId,
    active = false,
    scope = TaskOrigin.USER,
  }: {
    ownerId?: string
    sessionId?: string
    active?: boolean
    scope?: string
  } = {}) {
    this.prune()
    return [...this.tasks.values()]
      .filter(task => (
        (scope === 'all' || tidyTaskOrigin(task.scope) === scope)
        && (ownerId === undefined || task.ownerId === String(ownerId))
        && (sessionId === undefined || task.sessionId === String(sessionId))
        && (!active || isLiveTask(task.status))
      ))
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(taskViewWithContent)
  }

  wait(id) {
    const task = this.tasks.get(String(id))
    return task?.promise || Promise.resolve(null)
  }

  claimNotifications({
    ownerId,
    sessionId,
    includeOtherSessions = false,
    claimantId,
    taskIds,
  }) {
    return this.notifications.claim({
      ownerId,
      sessionId,
      includeOtherSessions,
      claimantId,
      taskIds,
    })
  }

  markNotificationsDelivered(taskIds, { claimantId } = {}) {
    return this.notifications.markDelivered(taskIds, { claimantId })
  }

  renewNotificationClaims(taskIds, { claimantId } = {}) {
    return this.notifications.renew(taskIds, { claimantId })
  }

  releaseNotificationClaims(taskIds, { claimantId } = {}) {
    return this.notifications.release(taskIds, { claimantId })
  }

  reclaimExpiredNotificationClaims(now = Date.now(), { persist = true } = {}) {
    return this.notifications.reclaimExpired(now, { persist })
  }

  prune() {
    const now = Date.now()
    let changed = this.reclaimExpiredNotificationClaims(now, { persist: false }) > 0
    const terminalByOwner = new Map()
    for (const task of this.tasks.values()) {
      if (!isFinishedTask(task.status)) continue
      const age = now - (task.completedAt || task.createdAt)
      const awaitingDelivery = ['pending', 'delivering'].includes(
        task.notificationStatus)
      const ttl = awaitingDelivery
        ? this.pendingNotificationTtlMs
        : this.terminalTtlMs
      if (age > ttl) {
        this.tasks.delete(task.id)
        changed = true
        continue
      }
      if (awaitingDelivery) continue
      const items = terminalByOwner.get(task.ownerId) || []
      items.push(task)
      terminalByOwner.set(task.ownerId, items)
    }
    changed = this.#evictSurplusTerminals(terminalByOwner) || changed
    if (changed) this.persist()
  }

  // 每 owner 的终态任务超额时,按创建时间新→旧保留 maxTerminalTasksPerOwner 条。
  #evictSurplusTerminals(terminalByOwner) {
    let evicted = false
    for (const tasks of terminalByOwner.values()) {
      tasks
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(this.maxTerminalTasksPerOwner)
        .forEach(task => {
          this.tasks.delete(task.id)
          evicted = true
        })
    }
    return evicted
  }
}
