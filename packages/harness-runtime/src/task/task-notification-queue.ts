// @ts-nocheck — 已完成工作的通知投递租约(本仓自有实现;同类「claim/TTL/renew/release
// 交付语义 + 先落账再广播」的崩溃一致性思路参考 qwen-audio-agent,致谢)。
// 任务执行与传输投递都在本类之外;它只改共享 Work 记录上的通知字段,并把持久化变更上报给持有方。

const CLEAR_CLAIM = { claimant: null, claimedAt: null }

export class TaskNoticeQueue {
  constructor({ tasks, snapshot, claimTtlMs, onChanged = () => {}, onDelivered = () => {}, now = () => Date.now() }) {
    this.tasks = tasks
    this.snapshot = snapshot
    this.claimTtlMs = claimTtlMs
    this.onChanged = onChanged
    this.onDelivered = onDelivered
    this.now = now
  }

  #sweepExpired() {
    this.reclaimExpired()
  }

  #matches(task, { ownerId, sessionId, includeOtherSessions, requested, branchGeneration }) {
    if (task.ownerId !== String(ownerId)) return false
    if (task.notificationStatus !== 'pending') return false
    if (sessionId !== undefined && !includeOtherSessions && task.sessionId !== String(sessionId)) return false
    if (requested && !requested.has(task.id)) return false
 // :带 branchGeneration 时只认领同代通知——换分支/重开后的迟到通知留在队列里由 dropStale 清理,
 // 不投递给新上下文。不传 branchGeneration 完全跳过此过滤(旧调用点行为逐字不变)。
    if (branchGeneration !== undefined) {
      const taskGeneration = Number(task.notificationGeneration ?? 0)
      if (taskGeneration !== Number(branchGeneration)) return false
    }
    return true
  }

  claim({ ownerId, sessionId, includeOtherSessions = false, claimantId, taskIds, branchGeneration }) {
    this.#sweepExpired()
    const requested = taskIds?.length ? new Set(taskIds.map(String)) : null
    const filter = { ownerId, sessionId, includeOtherSessions, requested, branchGeneration }
    const claimed = []
    for (const task of this.tasks.values()) {
      if (!this.#matches(task, filter)) continue
      task.notificationStatus = 'delivering'
      task.notificationClaimantId = claimantId
      task.notificationClaimedAt = this.now()
 // 认领时记下代次,便于审计「这条通知属于哪一代」;不传时不动该字段。
      if (branchGeneration !== undefined) task.notificationClaimedGeneration = Number(branchGeneration)
      claimed.push(this.snapshot(task))
    }
    if (claimed.length) this.onChanged()
    return claimed.sort((left, right) => left.createdAt - right.createdAt)
  }

  markDelivered(taskIds, { claimantId } = {}) {
    let delivered = 0
    const settled = []
    for (const id of taskIds || []) {
      const task = this.#ownedClaim(id, claimantId)
      if (!task) continue
      task.notificationStatus = 'delivered'
      task.notificationClaimantId = CLEAR_CLAIM.claimant
      task.notificationClaimedAt = CLEAR_CLAIM.claimedAt
      task.notificationDeliveredAt = this.now()
      delivered += 1
      settled.push(task)
    }
    if (delivered) this.onChanged()
    // 先把回执落账,再让观察者看到事件:崩溃后恢复为「已送达」而不是重放。
    settled.forEach(task => this.onDelivered(task))
    return delivered
  }

  renew(taskIds, { claimantId } = {}) {
    let renewed = 0
    const stamp = this.now()
    for (const id of taskIds || []) {
      const task = this.#ownedClaim(id, claimantId)
      if (!task) continue
      task.notificationClaimedAt = stamp
      renewed += 1
    }
    return renewed
  }

  release(taskIds, { claimantId } = {}) {
    let released = 0
    for (const id of taskIds || []) {
      const task = this.#ownedClaim(id, claimantId)
      if (!task) continue
      task.notificationStatus = 'pending'
      task.notificationClaimantId = CLEAR_CLAIM.claimant
      task.notificationClaimedAt = CLEAR_CLAIM.claimedAt
      released += 1
    }
    if (released) this.onChanged()
    return released
  }

 /**
 * :把 generation 与 currentGeneration 不等的 pending 通知标成 none(不投递)。
 * 只动 pending;delivering/delivered 由 claim/reclaim 自己的代次过滤负责,避免把在途通知打回队列循环。
 */
  dropStale(currentGeneration, { persist = true } = {}) {
    const current = Number(currentGeneration ?? 0)
    let dropped = 0
    for (const task of this.tasks.values()) {
      if (task.notificationStatus !== 'pending') continue
      if (Number(task.notificationGeneration ?? 0) === current) continue
      task.notificationStatus = 'none'
      task.notificationClaimantId = CLEAR_CLAIM.claimant
      task.notificationClaimedAt = CLEAR_CLAIM.claimedAt
      dropped += 1
    }
    if (dropped && persist) this.onChanged()
    return dropped
  }

  reclaimExpired(now = this.now(), { persist = true } = {}) {
    let reclaimed = 0
    const ttl = Number(this.claimTtlMs())
    for (const task of this.tasks.values()) {
      const held = task.notificationStatus === 'delivering' && task.notificationClaimedAt
      if (!held || now - task.notificationClaimedAt < ttl) continue
      task.notificationStatus = 'pending'
      task.notificationClaimantId = CLEAR_CLAIM.claimant
      task.notificationClaimedAt = CLEAR_CLAIM.claimedAt
      reclaimed += 1
    }
    if (reclaimed && persist) this.onChanged()
    return reclaimed
  }

  #ownedClaim(id, claimantId) {
    const task = this.tasks.get(String(id))
    if (!task || task.notificationStatus !== 'delivering') return null
    if (claimantId !== undefined && task.notificationClaimantId !== claimantId) return null
    return task
  }
}
