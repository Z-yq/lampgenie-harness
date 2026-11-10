// @ts-nocheck — 任务起跑闸门(本仓自有实现)。全局并发、单 owner 并发、可选 lane 配额
// 三层限制;同类「per-owner 串行 + 配额」的调度思路参考 qwen-audio-agent,致谢。

function positiveOr(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export class TaskTimer {
  constructor({ maxConcurrent = 4, maxConcurrentPerOwner = 2 } = {}) {
    this.maxConcurrent = positiveOr(maxConcurrent, 4)
    this.maxConcurrentPerOwner = positiveOr(maxConcurrentPerOwner, 2)
    this.active = new Map()
    // 增量计数:避免 canStart 每次全表扫描。
    this.byOwner = new Map()
    this.byLane = new Map()
  }

  count(predicate) {
    let total = 0
    for (const task of this.active.values()) {
      if (predicate(task)) total += 1
    }
    return total
  }

  #bump(map, key, delta) {
    const next = (map.get(key) ?? 0) + delta
    if (next <= 0) map.delete(key)
    else map.set(key, next)
  }

  canStart(task) {
    if (this.active.size >= this.maxConcurrent) return false
    if ((this.byOwner.get(task.ownerId) ?? 0) >= this.maxConcurrentPerOwner) return false
    if (!task.laneKey) return true
    return (this.byLane.get(task.laneKey) ?? 0) < positiveOr(task.laneLimit, 1)
  }

  acquire(task) {
    this.active.set(task.id, task)
    this.#bump(this.byOwner, task.ownerId, +1)
    if (task.laneKey) this.#bump(this.byLane, task.laneKey, +1)
  }

  release(task) {
    if (!this.active.delete(task.id)) return
    this.#bump(this.byOwner, task.ownerId, -1)
    if (task.laneKey) this.#bump(this.byLane, task.laneKey, -1)
  }
}
