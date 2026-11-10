// @ts-nocheck — 内部 Work 记录的持久仓(本仓自研;同类「记录集 + 持久投影 + 原子/延迟写 +
// 短 id 游标」的边界设计参考 qwen-audio-agent,Apache-2.0,致谢)。
// 恢复策略归 TaskSupervisor;本边界只管记录集合、持久化投影与短 id 游标。

const TASK_NUMBER_ROOF = 99_999

// 游标净化:非正整数一律回落 1。
function saneNumber(value) {
  const parsed = Number(value)
  const usable = Number.isInteger(parsed) && parsed >= 1 && parsed <= TASK_NUMBER_ROOF
  return usable ? parsed : 1
}

export class TaskStore {
  constructor({ store = null, serialize = task => task } = {}) {
    this.store = store           // 持久化后端(load/save/saveDeferred;可缺省=纯内存)
    this.serialize = serialize   // 记录 → 持久形状的投影函数
    this.ledger = new Map()      // id → Work 记录
    this.taskNumberWheel = 1     // 短 id 环形游标
  }

  load() {
    const restored = this.store?.load() || []
    // `nextJobNumber` 是旧版持久化字段名,读取兼容。
    this.taskNumberWheel = saneNumber(this.store?.nextTaskNumber ?? this.store?.nextJobNumber)
    return restored
  }

  get(id) { return this.ledger.get(String(id)) }

  set(id, task) {
    this.ledger.set(String(id), task)
    return this
  }

  delete(id) { return this.ledger.delete(String(id)) }

  values() { return this.ledger.values() }

  // 环形发号:跳过仍占用的号;绕整整一圈都没有空号才算耗尽。
  allocateTaskId() {
    const startAt = saneNumber(this.taskNumberWheel)
    let cursor = startAt
    do {
      this.taskNumberWheel = cursor >= TASK_NUMBER_ROOF ? 1 : cursor + 1
      const candidate = `task_${cursor}`
      if (!this.ledger.has(candidate)) return candidate
      cursor = this.taskNumberWheel
    } while (cursor !== startAt)
    throw new Error('No available task IDs')
  }

  save() {
    this.store?.save(this.#projection(), { nextTaskNumber: this.taskNumberWheel })
  }

  // 支持延迟落盘的后端走 saveDeferred,否则退化为同步 save。
  saveDeferred() {
    const tasks = this.#projection()
    const state = { nextTaskNumber: this.taskNumberWheel }
    if (this.store?.saveDeferred) this.store.saveDeferred(tasks, state)
    else this.store?.save(tasks, state)
  }

  #projection() {
    return [...this.ledger.values()].map(this.serialize)
  }
}
