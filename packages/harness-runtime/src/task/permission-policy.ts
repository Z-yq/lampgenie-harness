// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有。
import { PERMISSION_DECISIONS } from '../core/work-authorization'
import { BackendSignalType } from '../core/backend-events'
import { isLiveTask } from './task-state'

// 会话粒度的复合键(owner\0session);\0 防拼接歧义。
function pairKey(ownerId, sessionId) {
  return `${String(ownerId || '')}\u0000${String(sessionId || 'main')}`
}

export class TaskPermissionGuard {
  constructor({
    maxSessions = 500,
    ttlMs = 6 * 60 * 60 * 1000,
    now = () => Date.now(),
    taskManager = null,
  } = {}) {
    this.maxSessions = maxSessions
    this.ttlMs = ttlMs
    this.now = now
    this.sessions = new Map()
    this.tasks = new Map()
    this.pending = new Map()
    this.approving = new Map()
    this.taskManager = taskManager
    // 任务终态(含取消中)时同步清它的授权台账与待批项。
    this.unsubscribe = taskManager?.subscribe(event => {
      const task = event.task
      const settled = task && (!isLiveTask(task.status) || task.status === 'cancelling')
      if (!settled) return
      this.tasks.delete(this.taskKey(task))
      for (const [id, entry] of this.pending) {
        if (entry.taskId === task.id && entry.ownerId === task.ownerId) this.pending.delete(id)
      }
    })
  }

  // 过期清理 + 超容驱逐;读路径每次都会顺带跑一次(开销与会话数线性,量小)。
  prune() {
    const now = this.now()
    for (const [id, state] of this.sessions) {
      if (now - state.updatedAt >= this.ttlMs) this.sessions.delete(id)
    }
    while (this.sessions.size > this.maxSessions) {
      // 超容时驱逐最久未动的一条。
      let eldest = null
      for (const [id, state] of this.sessions) {
        if (!eldest || state.updatedAt < eldest[1].updatedAt) eldest = [id, state]
      }
      if (!eldest) break
      this.sessions.delete(eldest[0])
    }
  }

  // 会话当前的权限模式(缺省 ask);读取顺带做一次过期清理。
  mode(ownerId, sessionId) {
    this.prune()
    return this.sessions.get(pairKey(ownerId, sessionId))?.mode || 'ask'
  }

  // 会话模式只有两档;词表外的值一律收敛到 ask(fail-safe)。
  setMode(ownerId, sessionId, mode) {
    const normalized = mode === 'auto_allow' ? 'auto_allow' : 'ask'
    this.sessions.set(pairKey(ownerId, sessionId), { mode: normalized, updatedAt: this.now() })
    this.prune()
    return normalized
  }

  taskKey({ ownerId, sessionId, taskId, id }) {
    return `${pairKey(ownerId, sessionId)}\u0000${String(taskId || id || '')}`
  }

  // 落一笔权限决定。task 决定只影响该任务,永不扩张/收回会话级授权;
  // 返回的闭包回滚「仅这一笔」,不碰之后的新决定。
  applyDecision(ownerId, sessionId, decision, taskId) {
    const valid = PERMISSION_DECISIONS.includes(decision) && (decision !== 'task' || taskId)
    if (!valid) {
      throw new TypeError('Invalid permission decision or missing task ID')
    }
    const sessionKey = pairKey(ownerId, sessionId)
    const taskKey = this.taskKey({ ownerId, sessionId, taskId })
    const previousSession = this.sessions.get(sessionKey)
    const previousTask = this.tasks.get(taskKey)
    if (decision !== 'task') this.setMode(ownerId, sessionId, decision === 'always' ? 'auto_allow' : 'ask')
    const taskGrant = { allowed: decision !== 'reject' }
    if (taskId) this.tasks.set(taskKey, taskGrant)
    const sessionGrant = this.sessions.get(sessionKey)
    // 回滚只撤销本次决定,不碰更新的决定或终态清理。
    const rollback = () => {
      if (decision !== 'task' && this.sessions.get(sessionKey) === sessionGrant) {
        if (previousSession) this.sessions.set(sessionKey, previousSession)
        else this.sessions.delete(sessionKey)
      }
      if (taskId && this.tasks.get(taskKey) === taskGrant) {
        if (previousTask) this.tasks.set(taskKey, previousTask)
        else this.tasks.delete(taskKey)
      }
    }
    return rollback
  }

  // 任务是否仍在正常跑(关守:已关闭的守卫、无 taskManager、终态/取消中都算不在跑)。
  active(context) {
    if (this.closed) return false
    if (!this.taskManager) return true
    const task = this.taskManager.get(context.taskId, { ownerId: context.ownerId })
    return Boolean(
      task
      && task.sessionId === context.sessionId
      && isLiveTask(task.status)
      && task.status !== 'cancelling',
    )
  }

  // 自动放行判定:会话级 auto_allow,或该任务拿到过 once 授予(任务须仍在跑)。
  shouldAutoAllow(ownerId, sessionId, taskId) {
    const context = { ownerId, sessionId, taskId }
    const taskLive = !taskId || this.active(context)
    if (!taskLive) return false
    const sessionAllows = this.mode(ownerId, sessionId) === 'auto_allow'
    const taskAllowed = Boolean(taskId && this.tasks.get(this.taskKey(context))?.allowed)
    return sessionAllows || taskAllowed
  }

  // 语音创建/客户端创建/定时任务共用这一个拦截器:
  // 请求事件登记待批(达标则自动放行),决议事件清理台账后放行。
  forwardBackendEvent(context, event, onEvent, respondAuthorization) {
    const requestId = event?.permission?.id
    const isResolved = event?.type === BackendSignalType.AUTHORIZATION_RESOLVED
    const isRequested = event?.type === BackendSignalType.AUTHORIZATION_REQUESTED

    if (isResolved && requestId) {
      this.pending.delete(requestId)
      const autoEntry = this.approving.get(requestId)
      this.approving.delete(requestId)
      // 自动放行且尚未对外发布过:决议事件直接吞掉,不污染事件流。
      if (autoEntry && !autoEntry.published) return
    }
    if (!isRequested || !requestId) {
      onEvent(event)
      return
    }
    if (!this.active(context)) return
    const entry = { ...context, event, onEvent, respondAuthorization, published: false }
    this.pending.set(requestId, entry)
    const autoGrant = respondAuthorization
      && this.shouldAutoAllow(context.ownerId, context.sessionId, context.taskId)
    if (autoGrant) {
      this.approve(requestId, entry)
      return
    }
    // 没资格自批:公布给上层走人工审批链。
    entry.published = true
    onEvent(event)
  }

  // 自动放行:微任务里回写决议;回写失败则把请求公布出去走人工链。
  approve(id, entry) {
    if (this.approving.has(id) || !this.active(entry)) return
    this.approving.set(id, entry)
    Promise.resolve().then(() => {
      if (!this.active(entry)) return
      return entry.respondAuthorization(entry.taskId, id, 'once', { ownerId: entry.ownerId })
    }).then(() => {
      this.pending.delete(id)
      this.approving.delete(id)
    }).catch(() => {
      this.approving.delete(id)
      if (!this.active(entry)) return
      entry.published = true
      entry.onEvent(entry.event)
    })
  }

  // 会话恢复后补放行:把该会话下可自批的待批项全部走一遍。
  flushPending(ownerId, sessionId) {
    for (const [id, entry] of this.pending) {
      const sameSession = entry.ownerId === ownerId && entry.sessionId === sessionId
      const autoable = entry.respondAuthorization
        && this.shouldAutoAllow(ownerId, sessionId, entry.taskId)
      if (sameSession && autoable) this.approve(id, entry)
    }
  }

  close() {
    this.unsubscribe?.()
    this.closed = true
    this.tasks.clear()
    this.sessions.clear()
    this.pending.clear()
    this.approving.clear()
  }

  // 外部已自行处理该请求时移除台账(不改会话模式)。
  settle(id) {
    this.pending.delete(id)
  }
}
