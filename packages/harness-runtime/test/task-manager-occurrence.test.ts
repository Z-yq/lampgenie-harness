/**
 * TaskSupervisor 的 occurrence 接线行为测试:不 mock 被测对象,直接实例化
 * TaskSupervisor 走 createScheduled/start/终态/restore 真路径。
 * 覆盖:同 occurrence 二次不启动、认领冲突跳过、完成后不补跑、manual 不 stamp、
 * 失败可重试、取消释放认领、restore 合并快照 + owner 回收一次、旧任务零字段行为不变。
 */
import { describe, it, expect } from 'vitest'
import { TaskSupervisor } from '../src/task/task-manager'
import { advanceTask } from '../src/task/task-state'
import { occurrenceKey } from '../src/task/occurrence'

const T0 = 1_700_000_000_000

// start 的终态走 Promise 链 + microtask,给一个短宏任务窗等待落定。
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

// 生产路径:scheduled 任务先经队列(scheduled→queued)再被 start 取走。
function startTask(tm, id) {
  const task = tm.tasks.get(id)
  if (task.status === 'scheduled') advanceTask(task, 'queued')
  return tm.start(task)
}

function memoryStore() {
  let records: any[] = []
  return {
    store: {
      load: () => records,
      save: tasks => { records = tasks },
      saveDeferred: tasks => { records = tasks },
    },
    read: () => records,
  }
}

function scheduledTask(tm, overrides = {}) {
  return tm.createScheduled({
    objective: '定时任务',
    ownerId: 'u1',
    sessionId: 's1',
    schedule: { at: T0, recurrence: 'daily' },
    seriesId: 'series-occ',
    scheduledInstant: T0,
    type: 'task',
    runner: async () => ({ content: 'ok' }),
    ...overrides,
  })
}

describe('createScheduled:occurrence 身份与派发时间戳分离', () => {
  it('schedule 写入 scheduledInstant 与稳定 occurrenceKey', () => {
    const tm = new TaskSupervisor({ maxConcurrent: 10 })
    const created = scheduledTask(tm, { scheduledInstant: T0 + 5 })
    const task = tm.tasks.get(created.id)
    expect(task.schedule.at).toBe(T0)
    expect(task.schedule.scheduledInstant).toBe(T0 + 5)
    expect(task.schedule.occurrenceKey).toBe(occurrenceKey('series-occ', T0 + 5))
  })

  it('未传 scheduledInstant 时身份沿用计划 at(旧调用零改动)', () => {
    const tm = new TaskSupervisor({ maxConcurrent: 10 })
    const created = tm.createScheduled({
      objective: '旧式定时',
      ownerId: 'u1',
      sessionId: 's1',
      schedule: { at: T0, recurrence: 'once' },
    })
    const task = tm.tasks.get(created.id)
    expect(task.schedule.scheduledInstant).toBe(T0)
 // 单次任务 job = 任务 id,身份仍稳定
    expect(task.schedule.occurrenceKey).toBe(occurrenceKey(created.id, T0))
  })
})

describe('start:先 claim 再起跑', () => {
  it('同 occurrence 第二次不启动(ALREADY_COMPLETED)', async () => {
    const tm = new TaskSupervisor({ maxConcurrent: 10 })
    let launches = 0
    const runner = async () => { launches += 1; return { content: 'done' } }
    const first = scheduledTask(tm, { runner })
    startTask(tm, first.id)
    await settle()
    expect(launches).toBe(1)
    expect(tm.get(first.id).status).toBe('completed')
    expect(tm.occurrenceLedger.isCompleted('series-occ', T0)).toBe(true)

    const second = scheduledTask(tm, { runner })
    startTask(tm, second.id)
    await settle()
    expect(launches).toBe(1) // 第二次没有起跑
    expect(tm.get(second.id).status).toBe('queued')
    expect(tm.tasks.get(second.id).occurrenceSkip.code).toBe('ALREADY_COMPLETED')
  })

  it('认领冲突(ALREADY_CLAIMED)不启动,launch 计数不变', async () => {
    const tm = new TaskSupervisor({ maxConcurrent: 10 })
    let launches = 0
    let releaseRunner
    const blocking = () => { launches += 1; return new Promise(resolve => { releaseRunner = resolve }) }
    const first = scheduledTask(tm, { runner: blocking })
    startTask(tm, first.id)
    await settle()
    const second = scheduledTask(tm, { runner: async () => ({ content: 'x' }) })
    startTask(tm, second.id)
    await settle()
    expect(launches).toBe(1)
    expect(tm.tasks.get(second.id).occurrenceSkip.code).toBe('ALREADY_CLAIMED')
    expect(tm.get(second.id).status).toBe('queued')
    releaseRunner?.({ content: 'done' })
    await settle()
  })

  it('skip 事件走既有 SCHEDULED 类型并携带 occurrenceSkip', async () => {
    const tm = new TaskSupervisor({ maxConcurrent: 10 })
    const events: any[] = []
    tm.subscribe(event => events.push(event))
    const first = scheduledTask(tm)
    startTask(tm, first.id)
    await settle()
    const second = scheduledTask(tm)
    startTask(tm, second.id)
    const skip = events.find(event => event.occurrenceSkip)
    expect(skip?.type).toBe('task.scheduled')
    expect(skip.occurrenceSkip.code).toBe('ALREADY_COMPLETED')
    expect(skip.task.id).toBe(second.id)
  })
})

describe('终态结算', () => {
  it('completed 落账并写进任务快照(可持久化)', async () => {
    const tm = new TaskSupervisor({ maxConcurrent: 10 })
    const created = scheduledTask(tm)
    startTask(tm, created.id)
    await settle()
    const snapshot = tm.tasks.get(created.id).schedule.occurrenceLedger
    expect(snapshot.entries.some(entry =>
      entry.key === occurrenceKey('series-occ', T0) && entry.status === 'completed',
    )).toBe(true)
  })

  it('failed 记录但可重试:同 occurrence 再跑一次', async () => {
    const tm = new TaskSupervisor({ maxConcurrent: 10 })
    let attempts = 0
    const flaky = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('boom')
      return { content: 'ok' }
    }
    const first = scheduledTask(tm, { runner: flaky })
    startTask(tm, first.id)
    await settle()
    expect(tm.get(first.id).status).toBe('failed')
    expect(tm.occurrenceLedger.statusOf('series-occ', T0)).toBe('failed')

    const second = scheduledTask(tm, { runner: flaky })
    startTask(tm, second.id)
    await settle()
    expect(attempts).toBe(2)
    expect(tm.get(second.id).status).toBe('completed')
    expect(tm.occurrenceLedger.isCompleted('series-occ', T0)).toBe(true)
  })

  it('manual 触发完成不 stamp,不吞掉定时槽', async () => {
    const tm = new TaskSupervisor({ maxConcurrent: 10 })
    let launches = 0
    const runner = async () => { launches += 1; return { content: 'ok' } }
    const manual = scheduledTask(tm, { runner, trigger: 'manual' })
    startTask(tm, manual.id)
    await settle()
    expect(tm.get(manual.id).status).toBe('completed')
    expect(tm.occurrenceLedger.isCompleted('series-occ', T0)).toBe(false)
    expect(tm.occurrenceLedger.statusOf('series-occ', T0)).toBe(null)

 // 计划触发的下一次仍可认领并运行
    const planned = scheduledTask(tm, { runner })
    startTask(tm, planned.id)
    await settle()
    expect(launches).toBe(2)
    expect(tm.occurrenceLedger.isCompleted('series-occ', T0)).toBe(true)
  })

  it('取消释放认领:同 occurrence 可再次运行', async () => {
    const tm = new TaskSupervisor({ maxConcurrent: 10 })
    let launches = 0
    let releaseRunner
    const blocking = () => { launches += 1; return new Promise(resolve => { releaseRunner = resolve }) }
    const first = scheduledTask(tm, { runner: blocking })
    startTask(tm, first.id)
    await settle()
    expect(tm.occurrenceLedger.statusOf('series-occ', T0)).toBe('claimed')
    await tm.cancel(first.id, { ownerId: 'u1' })
    releaseRunner?.({ content: 'late' })
    await settle()
    expect(tm.occurrenceLedger.statusOf('series-occ', T0)).toBe(null)

    const second = scheduledTask(tm, { runner: async () => { launches += 1; return { content: 'ok' } } })
    startTask(tm, second.id)
    await settle()
    expect(launches).toBe(2)
    expect(tm.occurrenceLedger.isCompleted('series-occ', T0)).toBe(true)
  })
})

describe('restore:快照恢复与 owner 回收', () => {
  it('上一任 owner 的 claimed 残留恢复时只回收一次', async () => {
    const { store, read } = memoryStore()
    const tm1 = new TaskSupervisor({ maxConcurrent: 10, store })
    const created = scheduledTask(tm1, { runner: () => new Promise(() => {}) })
    startTask(tm1, created.id)
    await settle()
    const deadOwner = tm1.occurrenceOwnerId
    expect(read().some(task => task?.schedule?.occurrenceLedger)).toBe(true)

    const tm2 = new TaskSupervisor({ maxConcurrent: 10, store })
 // claimed 残留被回收(可重跑),且只记录回收过一次
    expect(tm2.occurrenceLedger.statusOf('series-occ', T0)).toBe(null)
    expect(tm2.recoveredOccurrenceOwners.has(deadOwner)).toBe(true)
    expect(tm2.recoveredOccurrenceOwners.size).toBe(1)
 // 再 restore 一次不会重复回收
    tm2.restore(read())
    expect(tm2.recoveredOccurrenceOwners.size).toBe(1)
    expect(tm2.occurrenceLedger.statusOf('series-occ', T0)).toBe(null)
  })

  it('已完成 occurrence 恢复后不补跑', async () => {
    const { store, read } = memoryStore()
    const tm1 = new TaskSupervisor({ maxConcurrent: 10, store })
    const created = scheduledTask(tm1)
    startTask(tm1, created.id)
    await settle()
    expect(tm1.occurrenceLedger.isCompleted('series-occ', T0)).toBe(true)

    const tm2 = new TaskSupervisor({ maxConcurrent: 10, store })
    let launches = 0
    const revived = tm2.tasks.get(created.id)
    expect(revived).toBeTruthy()
    if (revived) revived.runner = async () => { launches += 1; return { content: 'should-not-run' } }
    if (revived && revived.status === 'scheduled') advanceTask(revived, 'queued')
    tm2.start(revived)
    await settle()
    expect(launches).toBe(0)
    expect(revived?.occurrenceSkip?.code).toBe('ALREADY_COMPLETED')
    expect(read().length).toBeGreaterThan(0)
  })
})

describe('旧任务零 occurrence 字段', () => {
  it('普通 create/start 不产生账本条目,行为逐字不变', async () => {
    const tm = new TaskSupervisor({ maxConcurrent: 10 })
    let launches = 0
    const task = tm.create({
      objective: '普通任务',
      ownerId: 'u1',
      sessionId: 's1',
      runner: async () => { launches += 1; return { content: 'ok' } },
    })
    await settle()
    expect(launches).toBe(1)
    expect(tm.get(task.id).status).toBe('completed')
    expect(tm.occurrenceLedger.size).toBe(0)
  })
})
